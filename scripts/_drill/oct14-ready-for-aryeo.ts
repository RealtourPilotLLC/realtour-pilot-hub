// ---------------------------------------------------------------------------
// DRILL: the photos copied into 06-Ready-for-Aryeo for certain, never twice,
// with an instant button and a progress bar; and "Skip all findings"
// (Oct 14 2026).
//
// Jordan: "the copying to dropbox is taking too long can we make sure its
// actually being copied and also that there are not duplicates in the final
// folder when getting them ready again? Also need instant response instead of
// a loading button when clicking get ready again. It should show a progress
// bar at the bottom of the page and confirmation that it's getting ready."
// And: "I want a button that can skip all QC findings for a shoot."
//
// The hub fetches each photo and uploads it (Dropbox's own fetch, save_url,
// failed live and AutoHDR's byte_size is not the file's size). A Dropbox fake
// where one upload fails, one is stored short, and a write from an EARLIER
// press lands late in its own folder.
//   1. A run uploads into its own folder, confirms each size, uploads the
//      failed and the short one again, then swaps the folder in: exactly the
//      expected names, nothing else.
//   2. Pressed again mid-copy: the earlier press's late write never reaches
//      the final folder; no duplicates. A photo that cannot be copied at all
//      leaves the folder Kyle has untouched.
//   3. Links: one free AutoHDR call per shoot, nothing charged.
//   4. The button answers at once (the copy runs after); the bar's poll moves
//      it on; the panel says preparing, then ready.
//   5. Skip all findings: open ones set aside, queued fixes called off,
//      add-ons kept, the job Ready.
//
// ISOLATION: PGlite via the shared harness; Dropbox and AutoHDR answered in-process.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

installNextStubs();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// A photo is a couple of kilobytes here (the hub refuses anything under 1 KB as not a photo).
const fake = createFakeAutohdr({ transforms: [{ name: "reedit", credit_cost: 1 }], balance: 100, clientId: "cid", clientSecret: "drill-secret-1234567890", imageBytes: () => { const b = new Uint8Array(2048); b[0] = 0xff; b[1] = 0xd8; return b; } });

// ---- a Dropbox that stores what the hub uploads --------------------------------------------------
type DFile = { path: string; size: number };
const files = new Map<string, DFile>(); // lower path → file
const folders = new Set<string>(); // lower paths
const uploads: string[] = [];
/** name → what its NEXT uploads do ("fail": an error, "short": stored a byte short). */
const script = new Map<string, ("fail" | "short")[]>();
const lower = (p: string) => p.toLowerCase();
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
function put(path: string, size: number) {
  folders.add(lower(parentOf(path))); // an upload makes the parent folder
  files.set(lower(path), { path, size });
}
const upload = (argHeader: string, body: unknown): Response => {
  const a = JSON.parse(argHeader) as { path: string; mode: string; autorename: boolean };
  uploads.push(a.path);
  const name = a.path.split("/").pop()!;
  const next = script.get(name)?.shift();
  if (next === "fail") return json({ error_summary: "too_many_write_operations/" }, 429 + 71); // a 500
  if (a.mode === "add" && files.has(lower(a.path))) return json({ error_summary: "path/conflict/file/" }, 409);
  const len = (body as Uint8Array).byteLength;
  const size = next === "short" ? len - 1 : len;
  put(a.path, size);
  return json({ name, path_display: a.path, size });
};
const dropbox = (ep: string, a: Record<string, unknown>): Response => {
  const path = String(a.path ?? "");
  if (ep === "files/create_folder_v2") { folders.add(lower(path)); return json({ metadata: { name: path.split("/").pop(), path_display: path, id: "id:f" } }); }
  if (ep === "files/delete_v2") {
    const pre = lower(path);
    let hit = folders.delete(pre) || files.delete(pre);
    for (const k of [...files.keys()]) if (k.startsWith(pre + "/")) { files.delete(k); hit = true; }
    for (const k of [...folders]) if (k.startsWith(pre + "/")) { folders.delete(k); hit = true; }
    return hit ? json({ metadata: {} }) : json({ error_summary: "path_lookup/not_found/" }, 409);
  }
  if (ep === "files/move_v2") {
    const from = lower(String(a.from_path)), to = String(a.to_path);
    if (folders.has(lower(to)) || files.has(lower(to))) return json({ error_summary: "to/conflict/folder/" }, 409);
    if (!folders.has(from)) return json({ error_summary: "from_lookup/not_found/" }, 409);
    folders.delete(from); folders.add(lower(to));
    for (const [k, f] of [...files]) if (k.startsWith(from + "/")) { files.delete(k); const np = to + f.path.slice(from.length); files.set(lower(np), { ...f, path: np }); }
    return json({ metadata: { path_display: to } });
  }
  if (ep === "files/list_folder") {
    const pre = lower(path);
    // A folder exists when it was made, or when anything is inside it (Dropbox makes parents).
    if (!folders.has(pre) && ![...folders, ...files.keys()].some((k) => k.startsWith(pre + "/"))) return json({ error_summary: "path/not_found/" }, 409);
    const entries = [
      ...[...files.values()].filter((f) => lower(parentOf(f.path)) === pre).map((f) => ({ ".tag": "file", name: f.path.split("/").pop(), path_display: f.path, id: `id:${f.path}`, size: f.size })),
      ...[...folders].filter((k) => parentOf(k) === pre).map((k) => ({ ".tag": "folder", name: k.split("/").pop(), path_display: k, id: `id:${k}` })),
    ];
    return json({ entries, has_more: false });
  }
  return json({ error_summary: `unstubbed ${ep}` }, 400);
};

const fence = fenceFetch(async (url, init) => {
  const viaFake = await fake.handle(url, init);
  if (viaFake) return viaFake;
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx", expires_in: 14_400 });
  if (url === "https://content.dropboxapi.com/2/files/upload") return upload(new Headers(init?.headers).get("Dropbox-API-Arg") ?? "{}", init?.body);
  if (url.startsWith("https://api.dropboxapi.com/2/")) return dropbox(url.slice("https://api.dropboxapi.com/2/".length), typeof init?.body === "string" ? JSON.parse(init.body) : {});
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1" });
  return null;
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6997), env: { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s", AUTH_ENFORCE: "true", APP_SECRET: "isolated-ready" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const { setSession } = await import("@/lib/auth/session");
    const handoff = await import("@/lib/photoDelivery/handoff");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await savePhotoDeliverySettings({ enabled: true, showAutohdrPhotos: true, autoFix: false }, "drill");
    const kyle = await prisma.appUser.create({ data: { email: "kyle@ready.test", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });

    // A finished hub shoot: 6 photos, bought once already (downloaded).
    const client = await prisma.client.create({ data: { name: "Nehemiah Drill" } });
    const project = await prisma.project.create({ data: { title: "116 W Windsor St, Reading, PA", addressLine: "116 W Windsor St", clientId: client.id, shootDate: new Date("2026-10-13T14:00:00Z") } });
    const shoot = fake.seedShoot({ address: "116 W Windsor St", photos: Array.from({ length: 6 }, (_, i) => ({ name: `DSC0${7000 + i}.jpg`, downloaded: true })) });
    await prisma.photoIntakeBatch.create({ data: { projectId: project.id, batchNo: 1, state: "DONE", rawPath: "/raw", filesJson: "[]", fileCount: 6, fingerprint: "f", photoshootId: shoot.photoshoot_id, photosJson: JSON.stringify(shoot.photos.map((p) => ({ image_uuid: p.image_uuid, image_version_uuid: p.head, name: p.name, downloaded: true, url: null }))) } as never });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "READY", autohdrPhotoshootId: shoot.photoshoot_id } });
    const rooms = [["EXTERIOR_FRONT", "FRONT_EXTERIOR"], ["EXTERIOR_FRONT", "FRONT_EXTERIOR"], ["LIVING", "MAIN_LIVING"], ["KITCHEN", "KITCHEN"], ["BEDROOM", "BEDROOMS"], ["BATHROOM", "BATHROOMS"]];
    const photos: { id: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const p = shoot.photos[i];
      photos.push(await prisma.photoAsset.create({ data: { jobId: job.id, name: p.name, sourceKind: "AUTOHDR", sourceRef: `${shoot.photoshoot_id}/${p.image_uuid}`, autohdrImageUuid: p.image_uuid, autohdrVersionUuid: p.head, contentHash: `h${i}`, sequence: i, status: "ACTIVE", roomType: rooms[i][0], sequenceGroup: rooms[i][1] } as never }));
    }
    const folder = (await handoff.readyFolderFor(job.id))!;
    const names = () => [...files.values()].filter((f) => lower(parentOf(f.path)) === lower(folder)).map((f) => f.path.split("/").pop()!).sort();
    const siblings = () => [...folders].filter((k) => parentOf(k) === lower(parentOf(folder)) && k.includes("preparing"));

    // ======================================================================
    c.head("1 · a run: its own folder, every upload confirmed, retried, checked, swapped in");
    script.set("03-Living.jpg", ["fail"]);
    script.set("05-Bedroom.jpg", ["short"]);
    const balance0 = fake.state.balance;
    const req = await handoff.requestReady(job.id, { by: "Kyle" });
    c.ok("it starts at once, nothing copied yet", req.ok && req.started && req.total === 6 && uploads.length === 0, JSON.stringify(req));
    const p1 = await handoff.advanceReady(job.id, { budgetMs: 1 });
    c.ok("first step: a fresh folder of its own, nothing in the final folder yet", p1?.active === true && siblings().length === 1 && names().length === 0, JSON.stringify(p1));
    const midState = await handoff.readyFolderState(job.id, 6);
    c.ok("while copying, the panel's state says preparing, not ready", midState?.preparing === true && midState.ready === false && midState.total === 6, JSON.stringify(midState));
    const p2 = await handoff.advanceReady(job.id, { budgetMs: 30_000 });
    c.ok("it finishes: 6 of 6, none failed", p2?.active === false && p2.done === 6 && p2.failed === 0, JSON.stringify(p2));
    c.ok("the final folder holds exactly the 6 names, in order", JSON.stringify(names()) === JSON.stringify(["01-Front-Exterior.jpg", "02-Front-Exterior.jpg", "03-Living.jpg", "04-Kitchen.jpg", "05-Bedroom.jpg", "06-Bathroom.jpg"]), names().join(", "));
    c.ok("the failed upload was done again", uploads.filter((p) => p.endsWith("/03-Living.jpg")).length === 2);
    c.ok("the short one was caught (Dropbox's stored size against the bytes fetched) and done again", uploads.filter((p) => p.endsWith("/05-Bedroom.jpg")).length === 2 && [...files.values()].filter((f) => lower(parentOf(f.path)) === lower(folder)).every((f) => f.size === 2048));
    c.ok("uploads overwrite into the run's own folder: never a '(1)' copy", uploads.every((p) => /preparing [0-9a-f]+\//.test(p)) && !names().some((n) => /\(\d+\)/.test(n)));
    c.ok("no 'preparing' folder left behind", siblings().length === 0, siblings().join(", "));
    c.ok("links from ONE AutoHDR call for the shoot, nothing charged (re-downloads)", fake.state.balance === balance0);
    const ev = await prisma.photoJobEvent.findFirst({ where: { jobId: job.id, actor: "ready-for-aryeo" }, orderBy: { at: "desc" } });
    c.ok("the job points at the folder; the log says each one was checked", (await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } })).deliveryPath === folder && /6 of 6 photos .*checked in the folder/.test(ev?.action ?? ""), ev?.action ?? "");
    const again = await handoff.requestReady(job.id);
    c.ok("nothing changed: not copied again", again.ok && !again.started && /up to date/.test(again.message));

    // ======================================================================
    c.head("2 · pressed again while copying: no duplicates, no leftovers; a short run never replaces the folder");
    await prisma.photoAsset.update({ where: { id: photos[2].id }, data: { status: "EXCLUDED" } as never }).catch(async () => prisma.photoAsset.update({ where: { id: photos[2].id }, data: { status: "GONE" } as never }));
    const r1 = await handoff.requestReady(job.id, { force: true, by: "Kyle" });
    await handoff.advanceReady(job.id, { budgetMs: 1 }); // the first press makes its folder
    const firstStaging = siblings()[0];
    const r2 = await handoff.requestReady(job.id, { force: true, by: "Kyle" }); // pressed again
    put(`${firstStaging}/03-Kitchen-STALE.jpg`, 2048); // the first press's last write lands late, in its own folder
    const p3 = await handoff.advanceReady(job.id, { budgetMs: 30_000 });
    c.ok("both presses accepted", r1.started && r2.started && !!firstStaging, String(firstStaging));
    c.ok("the second run finishes: 5 of 5", p3?.active === false && p3.done === 5 && p3.total === 5, JSON.stringify(p3));
    c.ok("the final folder holds exactly the 5 current names: no duplicates, no stale ones", JSON.stringify(names()) === JSON.stringify(["01-Front-Exterior.jpg", "02-Front-Exterior.jpg", "03-Kitchen.jpg", "04-Bedroom.jpg", "05-Bathroom.jpg"]), names().join(", "));
    c.ok("the first press's folder (and its late write) was swept away", siblings().length === 0, siblings().join(", "));
    const before = names().join(",");
    script.set("02-Front-Exterior.jpg", ["fail", "fail", "fail"]);
    const r3 = await handoff.requestReady(job.id, { force: true, by: "Kyle" });
    const p4 = await handoff.advanceReady(job.id, { budgetMs: 30_000 });
    c.ok("a photo that cannot be copied after three tries: the run stops and says which", r3.started && p4?.active === false && p4.failed === 1 && /02-Front-Exterior\.jpg/.test(p4.note ?? "") && /not replaced/.test(p4.note ?? ""), JSON.stringify(p4));
    c.ok("…and the folder Kyle has is untouched", names().join(",") === before && siblings().length === 0, names().join(","));
    const rs = await handoff.readyFolderState(job.id, 5);
    c.ok("the panel says it is not ready and why", rs?.ready === false && rs.failed === 1 && /not replaced/.test(rs.note ?? ""), JSON.stringify(rs));
    const cronAgain = await handoff.requestReady(job.id);
    c.ok("the cron does not retry it every five minutes: a person presses again", !cronAgain.started && /Press Get them ready again/.test(cronAgain.message), cronAgain.message);

    // ======================================================================
    c.head("3 · the button answers at once; the bar follows the copy");
    const actions = await import("@/app/ops/photo-delivery/actions");
    await setSession({ uid: kyle.id, email: kyle.email, role: "ADMIN" });
    const t0 = Date.now();
    const press = await actions.restageForAryeoAction(job.id);
    c.ok("the press answers at once, with the confirmation", press.ok && /Getting the 5 photos ready/.test(press.message) && /bar at the bottom/.test(press.message) && Date.now() - t0 < 5_000, `${press.message} (${Date.now() - t0} ms)`);
    const D = await import("@/lib/photoDelivery/delivery");
    const mid = await D.deliverySteps(job.id);
    c.ok("right after the press the panel shows the new run (preparing, or already done: uploads are quick)", mid.ready?.preparing === true || (mid.ready?.ready === true && mid.ready.files === 5), JSON.stringify(mid.ready));
    let last = null as Awaited<ReturnType<typeof actions.readyProgressAction>> | null;
    for (let i = 0; i < 60; i++) {
      last = await actions.readyProgressAction(job.id);
      if (last.progress && !last.progress.active) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    c.ok("the bar's poll moves it on to the end", last?.ok === true && last.progress?.active === false && last.progress.done === 5, JSON.stringify(last));
    const end = await D.deliverySteps(job.id);
    c.ok("then the panel says ready, 5 of 5", end.ready?.ready === true && end.ready.files === 5 && !end.ready.preparing, JSON.stringify(end.ready));
    const panel = fs.readFileSync("src/components/photoDelivery/DeliverPanel.tsx", "utf8");
    c.ok("the button no longer waits on the copy (no spinner on it), the bar sits in the sticky panel", /onClick=\{getReady\}/.test(panel) && /<ReadyProgressBar /.test(panel) && !/run\(\(\) => restageForAryeoAction/.test(panel));

    // ======================================================================
    c.head("4 · skip all findings");
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v" } });
    const mk = (ruleId: string, extra: Record<string, unknown> = {}) => prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, photoId: photos[0].id, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "AHDR", specificIssue: ruleId, explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "REEDIT_PROMPT", status: "OPEN", ...extra } as never });
    const fOpen = await mk("EXT_TRASH_CANS_PRIMARY");
    const fOpen2 = await mk("PERSP_CROOKED_VERTICALS", { severity: "CRITICAL" });
    const fQueued = await mk("EXT_VEHICLES_BLOCKING_HOME", { status: "APPROVED_FIX" });
    const fAddon = await mk("ADDON_VIRTUAL_TWILIGHT", { source: "ADDON", pass: "P4_ORDER", severity: "MINOR" });
    const batch = await prisma.photoFixBatch.create({ data: { jobId: job.id, mode: "SELECTED", approvedBy: "auto-fix", estimatedCredits: 1 } });
    const op = await prisma.photoFixOperation.create({ data: { batchId: batch.id, jobId: job.id, photoId: photos[0].id, findingIdsJson: JSON.stringify([fQueued.id]), seq: 1, strategy: "REEDIT_PROMPT", transformName: "reedit", estimatedCredits: 1, status: "QUEUED" } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "FIXING" } });
    const skip = await actions.skipAllFindingsAction(job.id);
    c.ok("skipped, with what happened", skip.ok && /3 findings skipped/.test(skip.message) && /1 fix that had not started called off \(nothing charged\)/.test(skip.message), skip.message);
    const st = async (id: string) => (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id } })).status;
    c.ok("open findings set aside, with the reason", (await st(fOpen.id)) === "IGNORED" && (await st(fOpen2.id)) === "IGNORED" && /Skipped all findings/.test((await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fOpen.id } })).statusReason ?? ""));
    c.ok("the queued fix was called off (never sent, nothing charged) and its finding set aside", (await prisma.photoFixOperation.findUniqueOrThrow({ where: { id: op.id } })).status === "CANCELLED" && (await st(fQueued.id)) === "IGNORED");
    c.ok("an ordered add-on is not a finding to skip", (await st(fAddon.id)) === "OPEN");
    c.ok("the job is Ready", (await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } })).stage === "READY");
    const twice = await actions.skipAllFindingsAction(job.id);
    c.ok("pressing it again: nothing left to skip", !twice.ok && /Nothing to skip/.test(twice.message));
    const issues = fs.readFileSync("src/components/photoDelivery/IssuesPanel.tsx", "utf8");
    c.ok("the issues list has the button, behind a confirm", /Skip all findings/.test(issues) && /skipAllFindingsAction\(jobId\)/.test(issues) && /await confirm\(/.test(issues));

    c.head("isolation");
    c.ok("only the fakes answered", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
