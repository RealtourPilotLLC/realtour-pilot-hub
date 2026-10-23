// ---------------------------------------------------------------------------
// DRILL: THE HUB SENDS UPLOADS TO AUTOHDR + THE FREE PHOTO CHECK (Oct 14 2026).
//
// Jordan: "any jobs uploaded to Dropbox and completed uploading I want sent to
// autoHDR using our current settings and then run through QC all
// automatically, and I want it to detect file uploads to Dropbox later and
// then send those for editing too." And: "As long as QC is free."
//
//   1. switched off: nothing is read or sent
//   2. a finished upload waits for the folder to settle, then is sent ONCE:
//      Dropbox temporary links, the folder's name, no model ids (account
//      defaults), JPEG over its DNG twin, a duplicate copy sent once; commit
//      retried on files_not_landed; Jordan and Kyle are told
//   3. AutoHDR finishes: the photos become the job's gallery (AUTOHDR rows
//      with their AutoHDR ids), EDITING → EDITED
//   4. the free check: describe asked per photo, findings filed under real
//      rule ids, junk and unknown ids dropped, a bad answer retried, the job
//      verdict and stage set; no credits, no Claude, no download
//   5. files added later: a second shoot with only the new files
//   6. a shoot someone already made in AutoHDR: LINKED, nothing sent
//   7. a lost create reply: looked up, never repeated blindly
//   8. paid QC no longer starts by itself (Oct 23 2026: it is off for good, PAID_QC_OFF)
//   9. Kyle pushes the edits to Aryeo: rows carried over in place, findings
//      kept; a half-finished push keeps the AutoHDR gallery
//  10. shoots before the start date, delivered or video-only: untouched
// ISOLATION: PGlite; AutoHDR, Dropbox, Aryeo and Slack are fakes; any other
// outbound call is refused and counted.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

installNextStubs();

const MIN = 60_000;
type DbxFile = { name: string; path: string; id: string; size: number; hash: string; at?: string };
const dbx = new Map<string, DbxFile[]>(); // raw folder (lower case) → files
const dirs = new Map<string, string[]>(); // job folder (lower case) → its top-level folder names (Oct 23 2026)
const listed: string[] = []; // every files/list_folder path asked for (lower case)
const linkCalls: string[] = [];
const saved: { path: string; url: string }[] = []; // files/save_url into 06-Ready-for-Aryeo
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Aryeo listings by id.
const listings = new Map<string, { id: string; filename: string; original_url: string; index: number }[]>();

const fake = createFakeAutohdr({ transforms: [], models: [{ id: 1, name: "Classic", type: "predefined", variant: "indoor", style_credit_cost: 1 }], balance: 300, clientId: "cid", clientSecret: "drill-secret-1234567890", imageBytes: () => { const b = new Uint8Array(2048); b[0] = 0xff; b[1] = 0xd8; return b; } });
const fence = fenceFetch(async (url, init) => {
  const viaFake = await fake.handle(url, init);
  if (viaFake) return viaFake;
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx", expires_in: 14_400 });
  // Oct 14 2026: the Aryeo folder is filled by uploads the hub makes itself.
  if (url === "https://content.dropboxapi.com/2/files/upload") {
    const a = JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg") ?? "{}") as { path: string };
    const size = (init?.body as Uint8Array)?.byteLength ?? 0;
    saved.push({ path: a.path, url: `upload:${size}` });
    return json({ path_display: a.path, size });
  }
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const ep = url.slice("https://api.dropboxapi.com/2/".length);
    const arg = typeof init?.body === "string" ? (JSON.parse(init.body) as { path?: string }) : {};
    if (ep === "files/save_url") { const a = arg as { path?: string; url?: string }; saved.push({ path: a.path ?? "", url: a.url ?? "" }); return json({ ".tag": "async_job_id", async_job_id: `job-${saved.length}` }); }
    // Oct 14 2026: the copies are confirmed (check_job_status) and the folder is built aside, then moved in.
    if (ep === "files/save_url/check_job_status") return json({ ".tag": "complete" });
    if (ep === "files/move_v2") {
      const a = arg as { from_path?: string; to_path?: string };
      const from = (a.from_path ?? "").toLowerCase();
      for (const f of saved) if (f.path.toLowerCase().startsWith(from + "/")) f.path = (a.to_path ?? "") + f.path.slice(from.length);
      return json({ metadata: { path_display: a.to_path } });
    }
    if (ep === "files/delete_v2") { const pre = (arg.path ?? "").toLowerCase(); for (let i = saved.length - 1; i >= 0; i--) if (saved[i].path.toLowerCase().startsWith(pre + "/")) saved.splice(i, 1); return json({ metadata: {} }); }
    if (ep === "files/create_folder_v2") return json({ metadata: { name: "x", path_display: arg.path, id: "id:f" } });
    if (ep === "files/list_folder" && /06-ready-for-aryeo( - preparing [0-9a-f]+)?$/i.test(arg.path ?? "")) {
      return json({ entries: saved.filter((f) => f.path.toLowerCase().startsWith((arg.path ?? "").toLowerCase() + "/")).map((f) => ({ ".tag": "file", name: f.path.split("/").pop(), path_display: f.path, id: `id:${f.path}`, size: Number(f.url.split(":")[1]) || 4 })), has_more: false });
    }
    if (ep === "files/list_folder") {
      listed.push((arg.path ?? "").toLowerCase());
      const sub = dirs.get((arg.path ?? "").toLowerCase());
      if (sub) return json({ entries: sub.map((n) => ({ ".tag": "folder", name: n, path_display: `${arg.path}/${n}`, id: `id:${arg.path}/${n}` })), has_more: false });
      const files = dbx.get((arg.path ?? "").toLowerCase());
      if (!files) return json({ error_summary: "path/not_found/.." }, 409);
      return json({ entries: files.map((f) => ({ ".tag": "file", name: f.name, path_display: f.path, id: f.id, size: f.size, content_hash: f.hash, server_modified: f.at ?? "2026-10-14T01:00:00Z" })), has_more: false });
    }
    if (ep === "files/get_temporary_link") {
      linkCalls.push(arg.path ?? "");
      return json({ link: `https://uc.dl.dropboxusercontent.com/cd/0/get/${encodeURIComponent(arg.path ?? "")}` });
    }
    return json({ error_summary: `unstubbed ${ep}` }, 400);
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  const m = /^https:\/\/api\.aryeo\.com\/v1\/listings\/([^/?]+)/.exec(url);
  if (m) {
    const imgs = listings.get(m[1]) ?? [];
    return json({ data: { id: m[1], delivery_status: "NOT_DELIVERED", images: imgs.map((i) => ({ id: i.id, filename: i.filename, original_url: i.original_url, large_url: i.original_url, index: i.index, display_in_gallery: true })) } });
  }
  return null;
});

const file = (folder: string, name: string, n: number, hash?: string): DbxFile => ({ name, path: `${folder}/${name}`, id: `id:${folder}/${name}`, size: 9_000_000 + n, hash: hash ?? `h-${folder}-${name}` });

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6993), env: { DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const intake = await import("@/lib/photoDelivery/intake");
    const jobs = await import("@/lib/photoDelivery/jobs");
    const check = await import("@/lib/photoDelivery/autohdrCheck");
    const qc = await import("@/lib/photoDelivery/qc");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
    await saveSecret("aryeo", "drill-aryeo-key", { accountLabel: "drill" });
    const owner = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "owner-intake@example.test" } });
    await prisma.appUser.create({ data: { email: "owner-intake@example.test", role: "OWNER", status: "ACTIVE", teamMemberId: owner.id } });

    const NOW = new Date("2026-10-14T02:00:00Z");
    const client = await prisma.client.create({ data: { name: "Nehemiah Drill" } });
    const mkProject = async (street: string, over: Record<string, unknown> = {}, types: string[] = ["PHOTOS"]) => {
      const p = await prisma.project.create({ data: { title: `${street}, Reading, PA 19601`, addressLine: street, clientId: client.id, shootDate: new Date(NOW.getTime() - 3 * 60 * MIN), status: "SHOT", debriefSubmittedAt: new Date(NOW.getTime() - 60 * MIN), uploadedAt: new Date(NOW.getTime() - 60 * MIN), aryeoListingId: `lst-${street.split(" ")[0]}`, ...over } });
      for (const t of types) await prisma.deliverable.create({ data: { projectId: p.id, type: t as never } });
      return p;
    };
    const rawOf = (street: string) => `/AutoHDR/2026/Q4/October/${street} (Nehemiah Drill)/01-RAW-Photos`;

    // The upload: 3 bracket sets (15 JPGs), 2 drone JPGs + their DNG twins, and a duplicate copy.
    const W = "116 W Windsor St";
    const wRaw = rawOf(W);
    const wFiles = [
      ...Array.from({ length: 15 }, (_, i) => file(wRaw, `DSC0${7000 + i}.JPG`, i)),
      file(wRaw, "DJI_0001.JPG", 100), file(wRaw, "DJI_0001.DNG", 101), file(wRaw, "DJI_0002.JPG", 102), file(wRaw, "DJI_0002.DNG", 103),
      file(wRaw, "DSC07000 (1).JPG", 104, `h-${wRaw}-DSC07000.JPG`),
    ];
    dbx.set(wRaw.toLowerCase(), wFiles);
    const pW = await mkProject(W);
    await jobs.openNewJobs(NOW);
    const jobW = await prisma.photoJob.findUniqueOrThrow({ where: { projectId: pW.id } });

    // ======================================================================
    c.head("1 · switched off: nothing happens");
    const off = await intake.driveIntake({ budgetMs: 60_000, now: NOW });
    c.ok("autoSubmit off by default: skipped, nothing read", !!off.skipped && (await prisma.photoIntakeBatch.count()) === 0, off.skipped);
    await savePhotoDeliverySettings({ autoSubmit: true, freeCheck: true, paidQcAuto: false, qcEnabled: true, qcShadow: true, showAutohdrPhotos: true, autoSubmitFrom: "2026-10-13T04:00:00.000Z" }, "drill");

    // ======================================================================
    c.head("2 · a finished upload settles, then goes to AutoHDR once");
    const t0 = await intake.driveIntake({ budgetMs: 60_000, now: NOW });
    const b0 = await prisma.photoIntakeBatch.findFirstOrThrow({ where: { projectId: pW.id } });
    c.ok("first sight: a WAITING batch, nothing sent", b0.state === "WAITING" && fake.posts("/v1/photoshoots/from-urls").length === 0 && t0.waiting >= 1);
    c.ok("17 files: 15 brackets + 2 drone JPGs (DNG twins and the duplicate copy dropped)", b0.fileCount === 17, String(b0.fileCount));
    c.ok("expected photos: 3 sets + 2 drone = 5", b0.expectedPhotos === 5);
    const early = await intake.driveIntake({ budgetMs: 60_000, now: new Date(NOW.getTime() + 5 * MIN) });
    c.ok("5 minutes later (submitted, settle is 10): still waiting", early.sent.length === 0 && fake.posts("/v1/photoshoots/from-urls").length === 0);
    fake.state.intake.landAfter = 1;
    const sendAt = new Date(NOW.getTime() + 11 * MIN);
    const t1 = await intake.driveIntake({ budgetMs: 120_000, now: sendAt });
    const posts = fake.posts("/v1/photoshoots/from-urls");
    c.ok("sent once", t1.sent.length === 1 && posts.length === 1, JSON.stringify(t1));
    const body = posts[0].body as { address: string; files: { download_url: string; filename: string; kind: string }[]; indoor_model_id?: number };
    c.ok("named after the Dropbox folder", body.address === `${W} (Nehemiah Drill)`, body.address);
    c.ok("17 Dropbox temporary links, kind raw, no model ids (account defaults)", body.files.length === 17 && body.files.every((f) => f.download_url.startsWith("https://uc.dl.dropboxusercontent.com/") && f.kind === "raw") && !("indoor_model_id" in body) && !("enhancements" in body));
    c.ok("no DNG sent", !body.files.some((f) => /\.dng$/i.test(f.filename)));
    c.ok("commit retried past files_not_landed, then started", fake.posts("/v1/photoshoots/").filter((p) => p.path.endsWith("/commit")).length === 2);
    const b1 = await prisma.photoIntakeBatch.findFirstOrThrow({ where: { projectId: pW.id, batchNo: 1 } });
    c.ok("batch PROCESSING with the shoot id and ingest job id", b1.state === "PROCESSING" && !!b1.photoshootId && !!b1.ingestJobId && b1.balanceAtSend === 300);
    c.ok("the job points at the new shoot", (await prisma.photoJob.findUniqueOrThrow({ where: { id: jobW.id } })).autohdrPhotoshootId === b1.photoshootId);
    c.ok("Jordan and Kyle are told (bell)", (await prisma.notification.count({ where: { kind: "photo_autohdr_sent" } })) >= 1);
    const again = await intake.driveIntake({ budgetMs: 60_000, now: new Date(sendAt.getTime() + 40 * MIN) });
    c.ok("never sent twice", fake.posts("/v1/photoshoots/from-urls").length === 1 && again.sent.length === 0);
    c.ok("no credits spent sending", fake.state.balance === 300);

    // ======================================================================
    c.head("3 · AutoHDR finishes: the edits become the gallery");
    // Polls: `again` above was poll 1 (in progress); the next is success.
    const t2 = await intake.driveIntake({ budgetMs: 60_000, now: new Date(sendAt.getTime() + 46 * MIN) });
    const b2 = await prisma.photoIntakeBatch.findFirstOrThrow({ where: { projectId: pW.id, batchNo: 1 } });
    c.ok("DONE with 5 photos", b2.state === "DONE" && b2.imageCount === 5, JSON.stringify(t2));
    const syncAt = new Date(sendAt.getTime() + 47 * MIN);
    await jobs.syncJobFinals(jobW.id, syncAt);
    const rows = await prisma.photoAsset.findMany({ where: { jobId: jobW.id }, orderBy: { sequence: "asc" } });
    c.ok("5 AUTOHDR photo rows with AutoHDR ids", rows.length === 5 && rows.every((r) => r.sourceKind === "AUTOHDR" && !!r.autohdrImageUuid && r.sourceRef?.startsWith(`${b2.photoshootId}/`)));
    await jobs.syncJobFinals(jobW.id, new Date(syncAt.getTime() + 7 * MIN));
    c.ok("EDITING → EDITED once settled", (await prisma.photoJob.findUniqueOrThrow({ where: { id: jobW.id } })).stage === "EDITED");

    c.head("3b · the photos show in the hub (bought once: the delivery credit)");
    const dls = fake.posts("/v1/photoshoots/").filter((x) => x.path.endsWith("/photos/download"));
    c.ok("one download of the 5 finished photos, right when AutoHDR finished", dls.length === 1 && ((dls[0].body as { images: unknown[] }).images.length === 5));
    c.ok("5 credits (the photos' first download), in the ledger with why", fake.state.balance === 295 && !!(await prisma.autohdrCreditEntry.findFirst({ where: { kind: "DOWNLOAD", credits: -5, note: { contains: "to show in the hub" } } })));
    const shown = await prisma.photoAsset.findMany({ where: { jobId: jobW.id } });
    c.ok("every gallery row has its link", shown.every((r) => r.sourceUrl?.startsWith("https://autohdr-fake.s3.amazonaws.com/")));
    const S = await import("@/lib/photoDelivery/qc/source");
    const bytes = await S.loadPhotoBytes(shown[0]);
    c.ok("the image loader reads it", bytes.length > 0 && bytes[0] === 0xff);
    await prisma.photoAsset.update({ where: { id: shown[0].id }, data: { sourceUrl: null } });
    const before3b = fake.state.balance;
    const again3b = await S.loadPhotoBytes((await prisma.photoAsset.findUniqueOrThrow({ where: { id: shown[0].id } })));
    c.ok("a missing or expired link is refreshed free (already bought)", again3b.length > 0 && fake.state.balance === before3b && !!(await prisma.photoAsset.findUniqueOrThrow({ where: { id: shown[0].id } })).sourceUrl);
    const display = await import("@/lib/photoDelivery/display");
    const re = await display.downloadForDisplay({});
    c.ok("never bought twice", re.photos === 0 && fake.state.balance === before3b, JSON.stringify(re));

    c.head("3c · ready for Aryeo: the finished photos, numbered, in one folder");
    const handoff = await import("@/lib/photoDelivery/handoff");
    const st = await handoff.stageForAryeo(jobW.id);
    c.ok("5 photos copied into 06-Ready-for-Aryeo", st.ok && st.staged === 5 && saved.length === 5 && saved.every((f) => /\/116 W Windsor St \(Nehemiah Drill\)\/06-Ready-for-Aryeo\//.test(f.path)), JSON.stringify(st));
    const inOrder = [...saved].sort((a, b) => a.path.localeCompare(b.path));
    c.ok("numbered in delivery order, the photo's bytes uploaded (re-download free)", inOrder.every((f, i) => new RegExp(`/0${i + 1}-`).test(f.path) && f.url === "upload:2048") && fake.state.balance === before3b, inOrder.map((f) => `${f.path.split("/").pop()} ${f.url}`).join(", "));
    c.ok("the job points at the folder", (await prisma.photoJob.findUniqueOrThrow({ where: { id: jobW.id } })).deliveryPath?.endsWith("06-Ready-for-Aryeo") === true);
    const st2 = await handoff.stageForAryeo(jobW.id);
    c.ok("nothing changed: not copied again", st2.staged === 0 && saved.length === 5, st2.message);
    const rs = await handoff.readyFolderState(jobW.id, 5);
    c.ok("the panel sees 5 of 5: ready", rs?.ready === true && rs.files === 5);
    const D = await import("@/lib/photoDelivery/delivery");
    const steps = await D.deliverySteps(jobW.id);
    c.ok("the deliver steps carry the Download all link (Dropbox, internal)", steps.ready?.ready === true && /^https:\/\/www\.dropbox\.com\/home\//.test(steps.ready.folderUrl));

    // ======================================================================
    c.head("4 · the free photo check");
    const names = rows.map((r) => r.name);
    let junkOnce = true;
    fake.state.describe = (name, prompt) => {
      if (!/EXT_TRASH_CANS_PRIMARY/.test(prompt)) return "no checklist";
      if (name === names[0]) return '```json\n{"room":"exterior","issues":[{"id":"EXT_TRASH_CANS_PRIMARY","where":"curb, left","confidence":0.9},{"id":"MADE_UP_RULE","where":"x","confidence":1},{"id":"EXT_GARDEN_HOSES","where":"by the porch"}]}\n```';
      if (name === names[1] && junkOnce) { junkOnce = false; return "I think it looks fine!"; }
      if (name === names[1]) return '{"room":"bathroom","issues":[{"id":"BATH_TOILET_SEAT_OPEN","where":"center","confidence":0.85}]}';
      return '{"room":"kitchen","issues":[]}';
    };
    const anthropicBefore = fence.blocked.filter((u) => /anthropic/i.test(u)).length;
    const downloadsBefore = fake.posts("/v1/photoshoots/").filter((p) => p.path.endsWith("/download")).length;
    const ch1 = await check.driveAutohdrChecks({ budgetMs: 60_000 });
    const ch2 = await check.driveAutohdrChecks({ budgetMs: 60_000 });
    const run = await prisma.photoQcRun.findFirstOrThrow({ where: { jobId: jobW.id, trigger: "AUTOHDR_CHECK" } });
    const findings = await prisma.photoQcFinding.findMany({ where: { qcRunId: run.id } });
    c.ok("the run finishes (a junk answer retried on the next pass)", run.status === "DONE" && ch1.jobs[0]?.finished === false && ch2.jobs[0]?.finished === true, JSON.stringify([ch1, ch2]));
    c.ok("3 findings filed under real rule ids (unknown id dropped)", findings.length === 3 && findings.every((f) => ["EXT_TRASH_CANS_PRIMARY", "EXT_GARDEN_HOSES", "BATH_TOILET_SEAT_OPEN"].includes(f.ruleId)), findings.map((f) => f.ruleId).join(","));
    c.ok("registry severity and wording, source AHDR, no cost", findings.every((f) => f.severity === "MAJOR" && f.source === "AHDR" && f.model === "autohdr-describe") && run.costUsd === 0 && /curb, left/.test(findings.find((f) => f.ruleId === "EXT_TRASH_CANS_PRIMARY")!.specificIssue));
    c.ok("a missing confidence reads as 0.6", findings.find((f) => f.ruleId === "EXT_GARDEN_HOSES")!.confidence === 0.6);
    const jW = await prisma.photoJob.findUniqueOrThrow({ where: { id: jobW.id } });
    c.ok("shadow mode: EDITED → QC_REVIEW with the verdict", jW.stage === "QC_REVIEW" && jW.qcVerdict === "NEEDS_DECISION" && jW.lastQcRunId === run.id, `${jW.stage} ${jW.qcVerdict}`);
    c.ok("free: no credit spent, no new download, no Claude call", fake.state.balance === before3b && fake.posts("/v1/photoshoots/").filter((p) => p.path.endsWith("/download")).length === downloadsBefore && fence.blocked.filter((u) => /anthropic/i.test(u)).length === anthropicBefore);
    c.ok("one bell for the check", (await prisma.notification.count({ where: { kind: "photo_free_check" } })) >= 1);
    const labeled = await prisma.photoAsset.findMany({ where: { jobId: jobW.id }, orderBy: { sequence: "asc" }, select: { name: true, roomType: true, sequenceGroup: true } });
    c.ok("the photos get room labels from the free check (no more 'Unlabeled')", labeled[0].roomType === "EXTERIOR_FRONT" && labeled[0].sequenceGroup === "FRONT_EXTERIOR" && labeled[1].roomType === "BATHROOM" && labeled.slice(2).every((r) => r.roomType === "KITCHEN"), JSON.stringify(labeled.map((r) => r.roomType)));
    c.ok("room words map sensibly", check.roomTypeFrom("primary bathroom") === "PRIMARY_BATHROOM" && check.roomTypeFrom("back yard") === "EXTERIOR_REAR" && check.roomTypeFrom("front exterior", "twilight") === "TWILIGHT_EXTERIOR" && check.roomTypeFrom("living room") === "LIVING" && check.roomTypeFrom("") === null);
    c.ok("every describe call carried the checklist", fake.state.calls.filter((x) => x.path.endsWith("/describe")).every((x) => /BATH_TOILET_SEAT_OPEN: /.test(String((x.body as { prompt?: string }).prompt))));

    // ======================================================================
    c.head("5 · files added later: their own shoot");
    dbx.set(wRaw.toLowerCase(), [...wFiles, ...Array.from({ length: 5 }, (_, i) => file(wRaw, `DSC0${7100 + i}.JPG`, 200 + i))]);
    fake.state.intake.landAfter = 0;
    // Oct 15 2026: a finished shoot's raws are listed again hourly, not every pass.
    const soon = await intake.driveIntake({ budgetMs: 60_000, now: new Date(sendAt.getTime() + 60 * MIN) });
    const b1w = await prisma.photoIntakeBatch.findFirstOrThrow({ where: { projectId: pW.id, batchNo: 1 } });
    c.ok("14 minutes after AutoHDR finished: the folder is not listed again yet (hourly)", soon.watched === 0 && (await prisma.photoIntakeBatch.count({ where: { projectId: pW.id } })) === 1 && b1w.nextCheckAt?.getTime() === sendAt.getTime() + 106 * MIN, `${JSON.stringify(soon)} ${b1w.nextCheckAt?.toISOString()}`);
    const lateAt = new Date(sendAt.getTime() + 107 * MIN);
    await intake.driveIntake({ budgetMs: 60_000, now: lateAt });
    const b2w = await prisma.photoIntakeBatch.findFirstOrThrow({ where: { projectId: pW.id, batchNo: 2 } });
    c.ok("a second batch sees only the 5 new files", b2w.state === "WAITING" && b2w.fileCount === 5);
    await intake.driveIntake({ budgetMs: 60_000, now: new Date(lateAt.getTime() + 10 * MIN) });
    c.ok("10 minutes later: still settling (20 for later files)", fake.posts("/v1/photoshoots/from-urls").length === 1);
    await intake.driveIntake({ budgetMs: 120_000, now: new Date(lateAt.getTime() + 21 * MIN) });
    const p2 = fake.posts("/v1/photoshoots/from-urls")[1]?.body as { address: string; files: unknown[] } | undefined;
    c.ok("sent as \"(more photos 2)\" with only the new files", p2?.address === `${W} (Nehemiah Drill) (more photos 2)` && p2.files.length === 5, p2?.address);

    // ======================================================================
    c.head("6 · already in AutoHDR: linked, never sent");
    const K = "324 Spring Garden St";
    dbx.set(rawOf(K).toLowerCase(), Array.from({ length: 10 }, (_, i) => file(rawOf(K), `DSC0${8000 + i}.JPG`, i)));
    const pK = await mkProject(K);
    await jobs.openNewJobs(NOW);
    const manual = fake.seedShoot({ address: "324 Spring Garden Street, Reading", photos: [{ name: "a.jpg" }], createdAt: new Date(NOW.getTime() - 30 * MIN) });
    await intake.driveIntake({ budgetMs: 60_000, now: NOW });
    await intake.driveIntake({ budgetMs: 120_000, now: new Date(NOW.getTime() + 12 * MIN) });
    const bK = await prisma.photoIntakeBatch.findFirstOrThrow({ where: { projectId: pK.id } });
    c.ok("LINKED to Kyle's shoot, nothing created", bK.state === "LINKED" && bK.photoshootId === manual.photoshoot_id && !fake.posts("/v1/photoshoots/from-urls").some((x) => /324 Spring/.test(String((x.body as { address: string }).address))));
    c.ok("…and the job points at it", (await prisma.photoJob.findUniqueOrThrow({ where: { projectId: pK.id } })).autohdrPhotoshootId === manual.photoshoot_id);

    // ======================================================================
    c.head("7 · a lost reply is looked up, not repeated");
    const L = "326 Spring Garden St";
    dbx.set(rawOf(L).toLowerCase(), Array.from({ length: 5 }, (_, i) => file(rawOf(L), `DSC0${9000 + i}.JPG`, i)));
    const pL = await mkProject(L);
    await intake.driveIntake({ budgetMs: 60_000, now: NOW });
    fake.script("POST /v1/photoshoots/from-urls", "lose-response");
    const lostAt = new Date(NOW.getTime() + 12 * MIN);
    await intake.driveIntake({ budgetMs: 120_000, now: lostAt });
    const bL = await prisma.photoIntakeBatch.findFirstOrThrow({ where: { projectId: pL.id } });
    const lostCreates = () => fake.posts("/v1/photoshoots/from-urls").filter((x) => /326 Spring/.test(String((x.body as { address: string }).address))).length;
    c.ok("UNCERTAIN after the lost reply, one create", bL.state === "UNCERTAIN" && lostCreates() === 1);
    await intake.driveIntake({ budgetMs: 60_000, now: new Date(lostAt.getTime() + 3 * MIN) });
    const bL2 = await prisma.photoIntakeBatch.findFirstOrThrow({ where: { projectId: pL.id } });
    c.ok("found by name; never committed, so a person is asked (FAILED, not re-sent)", bL2.state === "FAILED" && !!bL2.photoshootId && lostCreates() === 1 && /reply was lost/.test(bL2.lastError ?? ""), bL2.lastError ?? "");
    c.ok("…with an alert", (await prisma.notification.count({ where: { kind: "photo_autohdr_failed" } })) >= 1);

    // ======================================================================
    c.head("8 · the paid QC never starts (off for good since Oct 23 2026)");
    const otherJob = await prisma.photoJob.create({ data: { projectId: (await mkProject("9 Paid Way")).id, stage: "EDITED" } });
    await prisma.photoAsset.create({ data: { jobId: otherJob.id, name: "x.jpg", sourceKind: "ARYEO", sourceUrl: "https://cdn.aryeo.com/x.jpg", contentHash: "h", status: "ACTIVE" } });
    const paid = await qc.driveQc({ budgetMs: 30_000, leaseBy: "drill" });
    c.ok("an EDITED gallery is not picked up by the paid QC (it is off: driveQc refuses)", /Paid photo QC is off/.test(paid.skipped ?? "") && !paid.jobs?.some((j) => (j as { jobId?: string }).jobId === otherJob.id) && (await prisma.photoQcRun.count({ where: { jobId: otherJob.id } })) === 0, JSON.stringify(paid).slice(0, 200));

    // ======================================================================
    c.head("9 · Kyle pushes the edits to Aryeo: same photos, same findings");
    const lid = `lst-116`;
    const aryeoName = (n: number) => `${W} (${n} of 5).jpg`;
    listings.set(lid, [1, 2].map((n) => ({ id: `img-${n}`, filename: aryeoName(n), original_url: `https://cdn.aryeo.com/listings/x/${n}.jpg`, index: n - 1 })));
    await jobs.syncJobFinals(jobW.id, new Date(syncAt.getTime() + 60 * MIN));
    const mid = await prisma.photoAsset.findMany({ where: { jobId: jobW.id } });
    c.ok("half pushed (2 of 5): still the AutoHDR gallery, nothing gone", mid.filter((r) => r.status === "ACTIVE" && r.sourceKind === "AUTOHDR").length === 5 && !mid.some((r) => r.sourceKind === "ARYEO"));
    listings.set(lid, [1, 2, 3, 4, 5].map((n) => ({ id: `img-${n}`, filename: aryeoName(n), original_url: `https://cdn.aryeo.com/listings/x/${n}.jpg`, index: n - 1 })));
    await jobs.syncJobFinals(jobW.id, new Date(syncAt.getTime() + 65 * MIN));
    const after = await prisma.photoAsset.findMany({ where: { jobId: jobW.id }, orderBy: { sequence: "asc" } });
    c.ok("all 5 carried over in place (ARYEO, Aryeo names, AutoHDR ids kept, none gone)", after.length === 5 && after.every((r) => r.sourceKind === "ARYEO" && r.status === "ACTIVE" && !!r.autohdrImageUuid) && after.map((r) => r.name).join("|") === [1, 2, 3, 4, 5].map(aryeoName).join("|"));
    c.ok("photo 1 of 5 is the photo that was checked first", after[0].id === rows[0].id);
    const kept = await prisma.photoQcFinding.findMany({ where: { jobId: jobW.id, status: "OPEN" } });
    c.ok("findings still open, on the same photos, hashes moved with them", kept.length === 3 && kept.every((f) => after.find((r) => r.id === f.photoId)?.contentHash === f.contentHash));
    c.ok("no re-QC requested", (await prisma.photoJob.findUniqueOrThrow({ where: { id: jobW.id } })).qcRequestedAt === null);

    // ======================================================================
    c.head("10 · what is never sent");
    const old = await mkProject("1 Old Rd", { shootDate: new Date("2026-10-10T15:00:00Z") });
    dbx.set(rawOf("1 Old Rd").toLowerCase(), [file(rawOf("1 Old Rd"), "A.JPG", 1)]);
    const delivered = await mkProject("2 Done Ln", { deliveredAt: new Date(NOW.getTime() - 10 * MIN) });
    dbx.set(rawOf("2 Done Ln").toLowerCase(), [file(rawOf("2 Done Ln"), "A.JPG", 1)]);
    const video = await mkProject("3 Film St", {}, ["VIDEO"]);
    dbx.set(rawOf("3 Film St").toLowerCase(), [file(rawOf("3 Film St"), "A.JPG", 1)]);
    await intake.driveIntake({ budgetMs: 60_000, now: NOW });
    await intake.driveIntake({ budgetMs: 60_000, now: new Date(NOW.getTime() + 60 * MIN) });
    c.ok("before the start date, delivered, video-only: no batch at all", (await prisma.photoIntakeBatch.count({ where: { projectId: { in: [old.id, delivered.id, video.id] } } })) === 0);
    // Delivered in Aryeo before the project row says so (Ridley Creek, Oct 14).
    const ariDone = await mkProject("4 Aryeo Ct");
    dbx.set(rawOf("4 Aryeo Ct").toLowerCase(), [file(rawOf("4 Aryeo Ct"), "A.JPG", 1)]);
    await intake.driveIntake({ budgetMs: 60_000, now: NOW });
    c.ok("…a waiting batch is made first", (await prisma.photoIntakeBatch.count({ where: { projectId: ariDone.id } })) === 1);
    await prisma.photoJob.create({ data: { projectId: ariDone.id, stage: "DELIVERED" } });
    await intake.driveIntake({ budgetMs: 60_000, now: new Date(NOW.getTime() + 60 * MIN) });
    c.ok("a job delivered in Aryeo: the waiting batch is dropped, nothing sent", (await prisma.photoIntakeBatch.count({ where: { projectId: ariDone.id } })) === 0 && !fake.posts("/v1/photoshoots/from-urls").some((x) => /4 Aryeo/.test(String((x.body as { address: string }).address))));

    // ======================================================================
    c.head("11 · checks Jordan switched off stay off");
    const house = await import("@/lib/photoDelivery/houseRules");
    const verdictMod = await import("@/lib/photoDelivery/qc/verdict");
    const hoseOpen = await prisma.photoQcFinding.count({ where: { ruleId: "EXT_GARDEN_HOSES", status: "OPEN" } });
    const stop = await house.stopRule("EXT_GARDEN_HOSES", "We don't need to know this", "Jordan Spackman");
    c.ok("switching a check off sets its open findings aside", stop.ok && stop.setAside === hoseOpen && hoseOpen > 0 && (await prisma.photoQcFinding.count({ where: { ruleId: "EXT_GARDEN_HOSES", status: "OPEN" } })) === 0, stop.message);
    const setAside = await prisma.photoQcFinding.findFirstOrThrow({ where: { ruleId: "EXT_GARDEN_HOSES" } });
    c.ok("…as IGNORED, with the reason and who", setAside.status === "IGNORED" && /Not checked any more: We don't need to know this/.test(setAside.statusReason ?? "") && setAside.decidedBy === "Jordan Spackman");
    const offRules = house.disabledIn(await house.houseOverrides());
    c.ok("the free check's question leaves it out", !/EXT_GARDEN_HOSES/.test(check.checkPrompt(offRules)) && /EXT_TRASH_CANS_PRIMARY/.test(check.checkPrompt(offRules)));
    c.ok("an answer naming it anyway is dropped", check.parseCheckAnswer('{"issues":[{"id":"EXT_GARDEN_HOSES","where":"x","confidence":0.9},{"id":"EXT_TRASH_CANS_PRIMARY","where":"y","confidence":0.9}]}', offRules)!.issues.map((i) => i.ruleId).join() === "EXT_TRASH_CANS_PRIMARY");
    const fake1 = { id: "f1", ruleId: "EXT_GARDEN_HOSES", groupKey: "g", photoId: "p", severity: "MAJOR", confidence: 0.9, status: "OPEN", arbitration: "NOT_REQUIRED", privacySensitive: false };
    c.ok("a finding of it never counts in a verdict", verdictMod.jobVerdict([fake1], { overrides: await house.houseOverrides() }).verdict === "PASS" && verdictMod.jobVerdict([fake1], {}).verdict === "NEEDS_DECISION");
    c.ok("a client's own entry still wins", house.mergeOverrides(await house.houseOverrides(), [{ ruleId: "EXT_GARDEN_HOSES", severity: "MINOR", reason: "client" }]).filter((o) => o.ruleId === "EXT_GARDEN_HOSES").length === 1);
    c.ok("the catch-all cannot be switched off", !(await house.stopRule("OTHER_DEFECT", "x", "Jordan")).ok);
    const back = await house.resumeRule("EXT_GARDEN_HOSES", "Jordan Spackman");
    c.ok("checked again: back in the question", back.ok && /EXT_GARDEN_HOSES/.test(check.checkPrompt(house.disabledIn(await house.houseOverrides()))));

    // ======================================================================
    c.head("12 · finding each job's AutoHDR shoot: fair to every job, backs off (Oct 15 2026)");
    const link = await import("@/lib/photoDelivery/autohdrLink");
    for (const s of ["21 Nomatch Rd", "22 Nomatch Rd", "23 Nomatch Rd"]) await prisma.photoJob.create({ data: { projectId: (await mkProject(s)).id, stage: "EDITED" } });
    const waitingJobs = await prisma.photoJob.count({ where: { autohdrPhotoshootId: null, stage: { in: ["EDITED", "QC_RUNNING", "QC_REVIEW", "READY", "ON_HOLD"] }, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } });
    let shootLists = 0;
    const listShoots = async () => { shootLists++; return []; };
    const triesOf = async () => Object.values(JSON.parse((await prisma.appSetting.findUnique({ where: { key: "photo_delivery:autohdr_link_tries" } }))?.value ?? "{}") as Record<string, { misses: number }>);
    const round = Math.ceil(waitingJobs / 2);
    for (let i = 0; i < round; i++) await link.linkOpenJobs(2, { listShoots });
    const once = await triesOf();
    c.ok("every waiting job is tried once before any is tried again", waitingJobs >= 4 && once.length === waitingJobs && once.every((t) => t.misses === 1), `${waitingJobs} ${JSON.stringify(once)}`);
    c.ok("one shoot list per pass (the cron shares it with the intake)", shootLists === round);
    for (let i = 0; i < 2 * round; i++) await link.linkOpenJobs(2, { listShoots });
    const thrice = await triesOf();
    const resting = await link.linkOpenJobs(2, { listShoots });
    c.ok("after 3 misses a job is tried about hourly, not every pass", thrice.every((t) => t.misses === 3) && resting.tried === 0, `${JSON.stringify(thrice)} ${JSON.stringify(resting)}`);

    // ======================================================================
    c.head("13 · only Aryeo says a photo job is delivered; a cancelled project is said once (Oct 15 2026)");
    const stageBefore = (await prisma.photoJob.findUniqueOrThrow({ where: { id: jobW.id } })).stage;
    await prisma.project.update({ where: { id: pW.id }, data: { deliveredAt: new Date() } });
    // (photo 5 replaced on the listing, so this pass reads a changed gallery and fetches no file)
    listings.set(lid, [1, 2, 3, 4, 5].map((n) => ({ id: `img-${n}`, filename: aryeoName(n), original_url: `https://cdn.aryeo.com/listings/x/${n}${n === 5 ? "-v2" : ""}.jpg`, index: n - 1 })));
    await jobs.syncJobFinals(jobW.id, new Date(syncAt.getTime() + 70 * MIN));
    c.ok("the hub's own delivered stamp on the project does not move the job (the listing says not delivered)", (await prisma.photoJob.findUniqueOrThrow({ where: { id: jobW.id } })).stage === stageBefore, stageBefore);
    await prisma.project.update({ where: { id: pW.id }, data: { status: "CANCELLED" } });
    const cancelAt = new Date(syncAt.getTime() + 75 * MIN);
    for (let i = 0; i < 3; i++) await jobs.syncJobFinals(jobW.id, new Date(cancelAt.getTime() + i * 5 * MIN));
    const jCancelled = await prisma.photoJob.findUniqueOrThrow({ where: { id: jobW.id } });
    c.ok("cancelled: said once in the log, looked at again a day later (not every 5 minutes)", (await prisma.photoJobEvent.count({ where: { jobId: jobW.id, action: "project cancelled: sync stopped" } })) === 1 && jCancelled.nextCheckAt?.getTime() === cancelAt.getTime() + 10 * MIN + 24 * 60 * MIN, jCancelled.nextCheckAt?.toISOString());

    // ======================================================================
    c.head("14 · a split job: the earlier visit's raws are never sent again (Oct 21 2026, 615 Cliff Ln)");
    {
      const at = (iso: string) => new Date(iso);
      const appts = [{ startAt: at("2026-10-08T17:30:00Z"), status: "SCHEDULED" }, { startAt: at("2026-10-14T00:15:00Z"), status: "SCHEDULED" }];
      c.ok("the floor is the ET day of the latest visit that has started", intake.uploadFloorFor(appts, null, NOW)?.toISOString() === "2026-10-13T04:00:00.000Z");
      c.ok("…a visit still to come, or a cancelled one, does not move it", intake.uploadFloorFor([...appts, { startAt: at("2026-10-20T15:00:00Z"), status: "SCHEDULED" }, { startAt: at("2026-10-13T23:00:00Z"), status: "CANCELED" }], null, NOW)?.toISOString() === "2026-10-13T04:00:00.000Z");
      c.ok("…no appointments: the shoot date; nothing started: no floor", intake.uploadFloorFor([], at("2026-10-08T17:30:00Z"), NOW)?.toISOString() === "2026-10-08T04:00:00.000Z" && intake.uploadFloorFor([], at("2026-10-20T15:00:00Z"), NOW) === null);
      const ff = (name: string, uploadedAt: string | null) => ({ id: name, name, path: `/x/${name}`, size: 1, hash: name, uploadedAt });
      const fs = intake.filesSince([ff("old.JPG", "2026-10-09T01:00:00Z"), ff("new.JPG", "2026-10-14T01:30:00Z"), ff("undated.JPG", null)], at("2026-10-13T04:00:00Z"));
      c.ok("files uploaded before the floor are left out and counted; an undated file is kept", fs.older === 1 && fs.kept.map((f) => f.name).join(",") === "new.JPG,undated.JPG");

      const C = "615 Cliff Ln";
      const cRaw = rawOf(C);
      // Visit 1 (exteriors): shot Oct 8, uploaded that evening, edited by hand, delivered.
      const exteriors = Array.from({ length: 10 }, (_, i) => ({ ...file(cRaw, `A750${7900 + i}.JPG`, i), at: "2026-10-09T01:00:00Z" }));
      dbx.set(cRaw.toLowerCase(), exteriors);
      const pC = await mkProject(C, { shootDate: at("2026-10-14T00:15:00Z"), debriefSubmittedAt: at("2026-10-09T01:05:00Z"), uploadedAt: at("2026-10-09T01:00:00Z") });
      for (const a of appts) await prisma.appointment.create({ data: { projectId: pC.id, aryeoId: `appt-cliff-${a.startAt.getTime()}`, startAt: a.startAt, status: a.status } });
      await prisma.photoJob.create({ data: { projectId: pC.id, stage: "DELIVERED" } });
      const sentBefore = fake.posts("/v1/photoshoots/from-urls").length;
      await intake.driveIntake({ budgetMs: 120_000, now: NOW });
      await intake.driveIntake({ budgetMs: 120_000, now: new Date(NOW.getTime() + 60 * MIN) });
      c.ok("visit 2 has started, only visit 1's raws in the folder: no batch, nothing sent", (await prisma.photoIntakeBatch.count({ where: { projectId: pC.id } })) === 0 && fake.posts("/v1/photoshoots/from-urls").length === sentBefore);
      // Visit 2 (interiors) uploads tonight.
      const interiors = Array.from({ length: 5 }, (_, i) => ({ ...file(cRaw, `A751${1000 + i}.JPG`, 50 + i), at: "2026-10-14T01:30:00Z" }));
      dbx.set(cRaw.toLowerCase(), [...exteriors, ...interiors]);
      const t0 = new Date(NOW.getTime() + 61 * MIN);
      await intake.driveIntake({ budgetMs: 120_000, now: t0 });
      const bC = await prisma.photoIntakeBatch.findFirst({ where: { projectId: pC.id } });
      const jobC = await prisma.photoJob.findUniqueOrThrow({ where: { projectId: pC.id } });
      const seenNote = await prisma.photoJobEvent.findFirst({ where: { jobId: jobC.id, action: { startsWith: "raws seen for AutoHDR batch 1" } }, select: { action: true } });
      c.ok("the interiors upload: a batch of the 5 new files only (the delivered visit 1 does not stop it)", bC?.state === "WAITING" && bC.fileCount === 5, JSON.stringify(bC && { state: bC.state, n: bC.fileCount }));
      c.ok("…the job's history says the 10 older files were left out, and why", /10 older files left out, uploaded before Tue, Oct 13, the day of this visit/.test(seenNote?.action ?? ""), seenNote?.action);
      await intake.driveIntake({ budgetMs: 120_000, now: new Date(t0.getTime() + 12 * MIN) });
      c.ok("visit 1's wrap-up does not count as this upload's: still settling at 12 minutes (30 for an unsubmitted upload)", fake.posts("/v1/photoshoots/from-urls").length === sentBefore);
      await intake.driveIntake({ budgetMs: 120_000, now: new Date(t0.getTime() + 31 * MIN) });
      const pC1 = fake.posts("/v1/photoshoots/from-urls")[sentBefore]?.body as { address: string; files: { filename: string }[] } | undefined;
      c.ok("sent at 31 minutes: the 5 interiors, none of the exteriors", fake.posts("/v1/photoshoots/from-urls").length === sentBefore + 1 && pC1?.files.length === 5 && pC1.files.every((f) => /^A7511/.test(f.filename)), JSON.stringify(pC1?.files.map((f) => f.filename)));
    }

    // ======================================================================
    c.head("15 · raws in a folder of the photographer's own; a submit is looked at right away (Oct 23 2026, 615 Cliff Ln)");
    {
      const at = (iso: string) => new Date(iso);
      const S = "9 Stray Ct";
      const base = `/AutoHDR/2026/Q4/October/${S} (Nehemiah Drill)`;
      const sRaw = `${base}/01-RAW-Photos`;
      const bath = `${base}/Bathroom Photos`;
      c.ok("hub folders are never read as raws; a folder of the photographer's own is",
        intake.strayFolderPaths(["01-RAW-Photos", "02-RAW-Video", "04-Final-Photos", "05-Final-Video", "06-Ready-for-Aryeo", "06-Ready-for-Aryeo - preparing ab12", "Client Assets", "Floor Plans", "Virtual Staging", "Bathroom Photos", "Twilight"].map((n) => ({ name: n, tag: "folder", path: `${base}/${n}` })), sRaw).map((x) => x.split("/").pop()).join(",") === "Bathroom Photos,Twilight");
      const oldRaws = Array.from({ length: 5 }, (_, i) => ({ ...file(sRaw, `OLD${i}.JPG`, 200 + i), at: "2026-10-09T01:00:00Z" }));
      dbx.set(sRaw.toLowerCase(), oldRaws);
      dirs.set(base.toLowerCase(), ["01-RAW-Photos", "04-Final-Photos", "06-Ready-for-Aryeo", "Client Assets", "Bathroom Photos"]);
      const newBath = Array.from({ length: 5 }, (_, i) => ({ ...file(bath, `BATH${i}.JPG`, 300 + i), at: "2026-10-14T01:30:00Z" }));
      // one of visit 1's files copied in again (same content), and an older stray photo: neither is ever sent
      dbx.set(bath.toLowerCase(), [...newBath, { ...file(bath, "OLD0 copy.JPG", 999, `h-${sRaw}-OLD0.JPG`), at: "2026-10-14T01:31:00Z" }, { ...file(bath, "agent.JPG", 998), at: "2026-10-09T02:00:00Z" }]);
      dbx.set(`${base}/04-Final-Photos`.toLowerCase(), [{ ...file(`${base}/04-Final-Photos`, "F1.JPG", 1), at: "2026-10-14T01:30:00Z" }]);
      const pS = await mkProject(S, { shootDate: at("2026-10-14T00:15:00Z"), dropboxFolder: base, debriefSubmittedAt: at("2026-10-09T01:05:00Z"), uploadedAt: at("2026-10-09T01:00:00Z") });
      for (const a of [at("2026-10-08T17:30:00Z"), at("2026-10-14T00:15:00Z")]) await prisma.appointment.create({ data: { projectId: pS.id, aryeoId: `appt-stray-${a.getTime()}`, startAt: a, status: "SCHEDULED" } });
      await prisma.photoJob.create({ data: { projectId: pS.id, stage: "DELIVERED" } });
      // visit 1's batch: sent and done long ago, next relist hours away
      await prisma.photoIntakeBatch.create({ data: { projectId: pS.id, batchNo: 1, rawPath: sRaw, filesJson: JSON.stringify(oldRaws.map((f) => ({ id: f.id, name: f.name, path: f.path, size: f.size, hash: f.hash }))), fileCount: 5, fingerprint: "old", seenAt: at("2026-10-09T01:30:00Z"), state: "DONE", doneAt: at("2026-10-09T03:00:00Z"), nextCheckAt: at("2026-10-14T08:00:00Z"), updatedAt: at("2026-10-13T20:00:00Z") } });
      const sentBefore = fake.posts("/v1/photoshoots/from-urls").length;
      const t0 = at("2026-10-14T01:50:00Z");
      await intake.driveIntake({ budgetMs: 120_000, now: t0 });
      c.ok("a settled job with no new submit waits for its relist (no listing at all)", (await prisma.photoIntakeBatch.count({ where: { projectId: pS.id } })) === 1 && !listed.includes(base.toLowerCase()));
      // the photographer submits the upload page for this visit
      await prisma.project.update({ where: { id: pS.id }, data: { debriefSubmittedAt: at("2026-10-14T01:45:00Z") } });
      await intake.driveIntake({ budgetMs: 120_000, now: new Date(t0.getTime() + 5 * MIN) });
      const b2 = await prisma.photoIntakeBatch.findFirst({ where: { projectId: pS.id, batchNo: 2 } });
      const sent2 = JSON.parse(b2?.filesJson ?? "[]") as { name: string }[];
      c.ok("submitted after the last batch: watched on the next pass, not at the 6-hour relist", !!b2 && b2.state === "WAITING", JSON.stringify(b2 && { s: b2.state, n: b2.fileCount }));
      c.ok("…the 5 new raws in 'Bathroom Photos' only: no copy of a sent file, nothing from before this visit", b2?.fileCount === 5 && sent2.every((f) => /^BATH/.test(f.name)), sent2.map((f) => f.name).join(","));
      c.ok("…hub folders were never listed (04-Final-Photos, 06-Ready-for-Aryeo, Client Assets)", !listed.some((x) => /04-final-photos|06-ready-for-aryeo|client assets/.test(x) && x.startsWith(base.toLowerCase())), listed.filter((x) => x.startsWith(base.toLowerCase())).join(" | "));
      const jobS = await prisma.photoJob.findUniqueOrThrow({ where: { projectId: pS.id } });
      c.ok("…the job's history names the folder", (await prisma.photoJobEvent.count({ where: { jobId: jobS.id, action: { startsWith: "raws found in 'Bathroom Photos' outside 01-RAW-Photos (5 files), sent with this visit" } } })) === 1);
      c.ok("…and the office is told once", (await prisma.notification.count({ where: { dedupeKey: { startsWith: `pd-intake-stray-${pS.id}` } } })) >= 1);
      await intake.driveIntake({ budgetMs: 120_000, now: new Date(t0.getTime() + 16 * MIN) });
      c.ok("…still settling at 11 minutes (a later batch waits 20)", fake.posts("/v1/photoshoots/from-urls").length === sentBefore);
      await intake.driveIntake({ budgetMs: 120_000, now: new Date(t0.getTime() + 26 * MIN) });
      const pS2 = fake.posts("/v1/photoshoots/from-urls")[sentBefore]?.body as { files: { filename: string }[] } | undefined;
      const b2b = await prisma.photoIntakeBatch.findFirst({ where: { projectId: pS.id, batchNo: 2 }, select: { state: true, lastError: true, seenAt: true } });
      c.ok("sent once it settles: the 5 bathroom raws", fake.posts("/v1/photoshoots/from-urls").length === sentBefore + 1 && pS2?.files.length === 5 && pS2.files.every((f) => /^BATH/.test(f.filename)), `${JSON.stringify(pS2?.files.map((f) => f.filename))} ${JSON.stringify(b2b)} posts ${fake.posts("/v1/photoshoots/from-urls").length - sentBefore}`);
      c.ok("…said once only (no second history line on later passes)", (await prisma.photoJobEvent.count({ where: { jobId: jobS.id, action: { startsWith: "raws found in 'Bathroom Photos'" } } })) === 1);
    }

    c.head("isolation");
    c.ok("no outbound call escaped the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
