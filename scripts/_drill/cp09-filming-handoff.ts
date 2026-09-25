// ---------------------------------------------------------------------------
// DRILL: CP-09 — the photographer's filmed topics survive, land once, and bind
// to the editor's owed-video slots (completion audit, Sep 24 2026; batch A),
// get one raw folder each, and reach the editor by name (batch C).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp09-filming-handoff.ts
//
// What it proves, OLD behaviour first wherever it can be observed:
//
//   1. OLD — the real finalizeUpload as of 9defa7a (loaded byte for byte from
//      git), with every ContentVideo insert refused: the submit succeeds, and
//      NOTHING anywhere holds the ticks. No row, no retry, no flag.
//   2. NEW — the same submit: it still succeeds, says `topicsPending`, and the
//      ticks, the note and the on-site extra are on file in ContentFilmingReport
//      (FAILED, attempt 1), with ONE flag on the job.
//   3. The block lifts; the hourly sweep (after the backoff, not before) applies
//      it: topics PROGRAM with the real session's date, the extra created once
//      as an overflow EXTRA, one capacity-review task, nothing sent anywhere.
//   4. Idempotent: a second sweep and an identical re-submit change nothing; a
//      different answer is a new report.
//   5. Binding: slots 1..3 carry t1, t2 and the extra with the photographer's
//      notes; the editor's labels are the topic titles and follow a rename;
//      routing still sends the monthly row to Kim; no Deliverable is made.
//   6. The library: the first cut on slot 1 attaches to t1's own video.
//   7. Races: two applies of one report claim it once; two reports on one job
//      make one video per topic; a dead lease is picked up, a live one is not.
//   8. OLD vs NEW — a Pro month with session 2 booked next week: dated session 2
//      (the future) before, session 1 now; an overflow tick counted toward the
//      allowance before, EXTRA now.
//   9. OLD vs NEW — a legacy month topic and a second session in the month.
//  10. Six failures stop the retries and put it in front of Kyle.
//  11. The real GET /api/cron/sync applies a due report, before contentLibrary.
//
// Batch C (the rest of CP-09):
//  12. OLD vs NEW — topic folders. The e26cacd folder engine makes 01..05 and
//      nothing per topic; the new one makes nothing either while topic_folders
//      has no row (not one Dropbox call), then, switched on, one folder per
//      topic "NN <title> [<id8>]" — once; a topic renamed in the hub keeps its
//      folder and clips; folders renamed by hand are adopted (by bracket, and by
//      Dropbox id when the bracket is gone); nothing is ever moved or deleted;
//      an extra filmed on site gets its folder when the report lands; the links
//      follow the job's folder when the engine moves it; Kim still has the edit.
//  13. OLD vs NEW — the printed brief said "3 videos were filmed"; now every
//      owed video carries its topic (live title), note, script and its
//      standing, in filmingBriefFor, the PDF, cutSlots and the project summary.
//  14. A session with no planned topics: the videos added on the page are the
//      answer, and the editor cuts one per added topic.
//  15. A report that has not landed is still in the editor's brief; one that
//      gave up is what the project summary says is in the way.
//
// ISOLATION. PGlite on 127.0.0.1:5518 (DRILL_PORT overrides) through the shared
// harness; production is never opened. Every non-loopback call is fenced, and
// Dropbox is a stateful fake AT the fence (so the real integration code runs);
// its secret is only saved from section 12 on, so sections 1–11 see Dropbox
// "not connected", exactly as before. Faults are a plpgsql RAISE (P0001), never
// a unique collision.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5518);
const REPO = path.resolve(__dirname, "../..");
/** The commit before CP-09: what the audit measured. */
const BASE = "9defa7a";
/** The commit before CP-09 batch C (topic folders, the editor's brief): batch A had landed, these had not. */
const PRE_C = "e26cacd";

installNextStubs();

// ---- Dropbox, faked AT the fence ------------------------------------------
// A stateful tree keyed by lower-cased path (Dropbox paths are
// case-insensitive), with permanent ids that survive a rename — the one fact
// the adoption rule leans on. Every call is logged so a section can say
// exactly what the hub asked Dropbox to do.
type DbxNode = { path: string; id: string; tag: "folder" | "file" };
const dbxTree = new Map<string, DbxNode>();
const dbxCalls: { ep: string; path: string }[] = [];
let dbxSeq = 0;
function dbxEnsureFolder(p: string): DbxNode {
  let cur = "";
  for (const part of p.split("/").filter(Boolean)) {
    cur += `/${part}`;
    if (!dbxTree.has(cur.toLowerCase())) dbxTree.set(cur.toLowerCase(), { path: cur, id: `id:drill${++dbxSeq}`, tag: "folder" });
  }
  return dbxTree.get(p.toLowerCase())!;
}
function dbxPutFile(p: string) {
  dbxEnsureFolder(p.slice(0, p.lastIndexOf("/")));
  dbxTree.set(p.toLowerCase(), { path: p, id: `id:drill${++dbxSeq}`, tag: "file" });
}
/** A PERSON renaming or moving a folder in Dropbox: everything under it goes too, ids unchanged. */
function dbxRename(from: string, to: string) {
  const f = from.toLowerCase();
  for (const [k, n] of [...dbxTree]) {
    if (k !== f && !k.startsWith(`${f}/`)) continue;
    dbxTree.delete(k);
    const np = to + n.path.slice(from.length);
    dbxTree.set(np.toLowerCase(), { ...n, path: np });
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx-token", expires_in: 14_400 });
  if (!url.startsWith("https://api.dropboxapi.com/2/")) return null;
  const ep = url.slice("https://api.dropboxapi.com/2/".length);
  const arg = typeof init?.body === "string" ? (JSON.parse(init.body) as { path?: string; recursive?: boolean; from_path?: string; to_path?: string }) : {};
  dbxCalls.push({ ep, path: arg.path ?? arg.from_path ?? "" });
  if (ep === "users/get_current_account") return json({});
  if (ep === "files/create_folder_v2") {
    if (dbxTree.has((arg.path ?? "").toLowerCase())) return json({ error_summary: "path/conflict/folder/..", error: { ".tag": "path" } }, 409);
    const n = dbxEnsureFolder(arg.path!);
    return json({ metadata: { name: n.path.split("/").pop(), path_display: n.path, id: n.id } });
  }
  if (ep === "files/list_folder") {
    const dir = (arg.path ?? "").toLowerCase();
    if (dbxTree.get(dir)?.tag !== "folder") return json({ error_summary: "path/not_found/..", error: { ".tag": "path" } }, 409);
    const entries = [...dbxTree.values()]
      .filter((n) => n.path.toLowerCase().startsWith(`${dir}/`) && (arg.recursive || !n.path.slice(dir.length + 1).includes("/")))
      .map((n) => ({ ".tag": n.tag, name: n.path.split("/").pop(), path_display: n.path, id: n.id }));
    return json({ entries, has_more: false });
  }
  if (ep === "files/move_v2") {
    if (dbxTree.has((arg.to_path ?? "").toLowerCase())) return json({ error_summary: "to/conflict/folder/..", error: { ".tag": "to" } }, 409);
    dbxRename(arg.from_path!, arg.to_path!);
    return json({ metadata: {} });
  }
  return json({ error_summary: `drill: unstubbed dropbox ${ep}` }, 400);
});

/**
 * The words on a pdf-lib page, in drawing order: every content stream
 * inflated, every hex (<…> Tj) and literal ((…) Tj) string decoded. The brief
 * is asserted on what it PRINTS, not on the data handed to it.
 */
function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const s = buf.toString("latin1");
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const body = buf.subarray(start, end);
    let raw = body;
    while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) raw = raw.subarray(0, raw.length - 1);
    // Only ONE end-of-line precedes "endstream"; a compressed stream whose own
    // last byte is 0x0A/0x0D lost it to the trim above and failed to inflate,
    // now and then (review, Sep 24 2026: an intermittent section-15 FAIL). So
    // when the trimmed bytes do not inflate, try the body minus one EOL.
    const inflate = (b: Buffer): string | null => { try { return zlib.inflateSync(b).toString("latin1"); } catch { return null; } };
    const text: string = inflate(raw)
      ?? inflate(body.subarray(0, Math.max(0, body.length - 1)))
      ?? inflate(body.subarray(0, Math.max(0, body.length - 2)))
      ?? inflate(body)
      ?? raw.toString("latin1");
    for (const t of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(t[1], "hex").toString("latin1"));
    for (const t of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1]);
    re.lastIndex = end + "endstream".length;
  }
  return norm(out.join(" "));
}
/** The PDF's own character folding (editor-pdf.ts clean()), so a title compares to what was printed. */
const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ");

/**
 * The OLD code, loaded for real: filmedTopics.ts and upload/actions.ts as they
 * were at BASE, written to a temp dir with their `@/` imports pointed at this
 * tree (so everything they call is the same module the new code calls — one
 * Prisma client, one database), and the old actions pointed at the OLD
 * filmedTopics. node_modules is symlinked in so bare imports resolve.
 */
function writeBaseCopies(): { dir: string; filmedTopics: string; actions: string; dropboxFolders: string; editorPdf: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp09-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string, special: Record<string, string>) =>
    src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${special[p] ?? path.join(REPO, "src", p)}${q}`);
  const filmedTopics = path.join(dir, "filmedTopics.base.ts");
  fs.writeFileSync(filmedTopics, point(show("src/lib/filmedTopics.ts"), {}));
  const actions = path.join(dir, "uploadActions.base.ts");
  fs.writeFileSync(actions, point(show("src/app/upload/actions.ts"), { "lib/filmedTopics": filmedTopics.replace(/\.ts$/, "") }));
  // Batch C's two "before" files, as batch A left them.
  const showC = (f: string) => execFileSync("git", ["show", `${PRE_C}:${f}`], { cwd: REPO, encoding: "utf8" });
  const dropboxFolders = path.join(dir, "dropboxFolders.preC.ts");
  fs.writeFileSync(dropboxFolders, point(showC("src/lib/dropboxFolders.ts"), {}));
  const editorPdf = path.join(dir, "editorPdf.preC.ts");
  fs.writeFileSync(editorPdf, point(showC("src/lib/editor-pdf.ts"), {}));
  return { dir, filmedTopics, actions, dropboxFolders, editorPdf };
}

/** The temp copies go when the drill does — the symlink first, so nothing can follow it. */
function removeBaseCopies(dir: string) {
  try {
    fs.unlinkSync(path.join(dir, "node_modules"));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* a leftover temp dir is harmless */ }
}

async function main() {
  // The Dropbox app key/secret are stand-ins so the integration counts as
  // configured; with no refresh token saved (until section 12) it still reads
  // as not connected, which is what sections 1–11 have always seen.
  const { server, stop } = await bootDrillDb({ port: PORT, env: { DROPBOX_APP_KEY: "drill-app-key", DROPBOX_APP_SECRET: "drill-app-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const base = writeBaseCopies();
  type BaseFT = {
    topicsForSession: (id: string) => Promise<{ topics: { topicId: string; filmedConfirmedAtISO: string | null }[] } | null>;
    confirmFilmedTopics: (projectId: string, ids: string[], by: string, opts?: { now?: Date }) => Promise<{ confirmed: number; filmedAtISO: string | null }>;
  };
  const oldFT = (await import(base.filmedTopics)) as BaseFT;
  const oldActions = (await import(base.actions)) as { finalizeUpload: (id: string, data: unknown) => Promise<Record<string, unknown>> };
  const ft = await import("@/lib/filmedTopics");
  const { finalizeUpload } = await import("@/app/upload/actions");
  const { outputsForProject } = await import("@/lib/deliverableOutputs");
  const { mintEditTask } = await import("@/lib/tasks");
  const { establishSession } = await import("@/lib/auth/session");
  const { syncEnrollmentVideos } = await import("@/lib/contentVideos");

  // ---- the world every section shares -----------------------------------
  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
  const kyle = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" }, select: { id: true } });
  const harrison = await prisma.appUser.create({ data: { email: "harrison-drill@example.com", name: "Harrison", role: "PHOTOGRAPHER", status: "ACTIVE" }, select: { id: true } });
  await establishSession(harrison.id); // the stubbed cookie jar now carries his session
  const HOUR = 3_600_000;
  const A1 = new Date(Math.floor((Date.now() - 26 * HOUR) / 60_000) * 60_000); // yesterday, 2h session
  const A1_END = new Date(A1.getTime() + 120 * 60_000);
  const NEXT_WEEK = new Date(A1.getTime() + 8 * 24 * HOUR);

  const month = (name: string, over: Partial<Parameters<typeof buildContentMonth>[1]> = {}) =>
    buildContentMonth(prisma, {
      name: `${name} TEST`,
      package: "Starter",
      videosPerMonth: 3,
      owner: false,
      appointments: [{ startAt: A1 }],
      topics: [
        { title: `${name}: pricing in week one`, selection: "SELECTED" },
        { title: `${name}: the inspection talk`, selection: "SELECTED" },
        { title: `${name}: staging on a budget`, selection: "SELECTED" },
      ],
      ...over,
    });
  const script = async (f: ContentMonthFixture, i: number, approved: boolean) => {
    const sc = await prisma.contentScript.create({
      data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: f.topicIds[i], title: `Script ${i + 1}`, body: "body", status: "APPROVED", releaseState: "released" },
      select: { id: true },
    });
    const v = await prisma.contentScriptVersion.create({
      data: { scriptId: sc.id, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: 1, title: `Script ${i + 1}`, hook: "h", pointsJson: "[]", close: "c", body: "b", source: "AI", status: "SHARED" },
      select: { id: true },
    });
    await prisma.contentScript.update({
      where: { id: sc.id },
      data: { sharedVersionId: v.id, sharedAt: new Date(), ...(approved ? { clientApprovedVersionId: v.id, clientApprovedAt: new Date() } : {}) },
    });
    if (approved) {
      await prisma.contentScriptRelease.create({
        data: { scriptId: sc.id, scriptVersionId: v.id, enrollmentId: f.enrollmentId, clientId: f.clientId, action: "CLIENT_APPROVED", actorEmail: "client@example.com" },
      });
    }
    return { scriptId: sc.id, versionId: v.id };
  };
  const block = async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION cp09_refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'drill: ContentVideo insert refused'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER cp09_refuse BEFORE INSERT ON "ContentVideo" FOR EACH ROW EXECUTE FUNCTION cp09_refuse()`);
  };
  const unblock = () => prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS cp09_refuse ON "ContentVideo"`);
  const EXTRA_TITLE = "Open-house mistakes";
  const submitFor = (f: ContentMonthFixture, notes: Record<string, string> = { [f.topicIds[0]]: "drone opener" }) => ({
    editorBrief: "x",
    force: true,
    cullingConfirmed: true,
    videoInstructions: "VISION FOR THE EDIT\nfast cuts",
    filmedTopicIds: [f.topicIds[0], f.topicIds[1]],
    topicNotes: notes,
    extraTopics: [{ key: "k1", title: EXTRA_TITLE, note: "kitchen" }],
  });
  const filmingFlags = (projectId: string) => prisma.activity.count({ where: { projectId, type: "FLAG", body: { startsWith: "Filmed topics" } } });
  const reportFor = (f: ContentMonthFixture, payload: { filmedTopicIds: string[]; topicNotes?: Record<string, string>; extraTopics?: unknown }) =>
    ft.prepareFilmingReport(f.projectId!, payload, { name: "Harrison", email: "harrison-drill@example.com" }).then(async (prep) => {
      await prisma.contentFilmingReport.createMany({ data: [prep!.row], skipDuplicates: true });
      return (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { projectId_payloadHash: { projectId: f.projectId!, payloadHash: prep!.payloadHash } } })).id;
    });

  // =========================================================================
  c.head("1 · OLD (9defa7a): a confirmation write fails after the footage submit");
  // =========================================================================
  const f0 = await month("Old Submit");
  await block();
  let oldRes: Record<string, unknown> | null = null;
  let oldThrew: unknown = null;
  try {
    oldRes = await oldActions.finalizeUpload(f0.projectId!, submitFor(f0));
  } catch (e) {
    oldThrew = e;
  }
  c.ok("the old submit resolves — the photographer is told it worked", !oldThrew && !!oldRes && !oldRes.blocked, String(oldThrew ?? JSON.stringify(oldRes)));
  c.ok("…and says nothing about the topics", !!oldRes && !("topicsPending" in oldRes));
  const p0 = await prisma.project.findUniqueOrThrow({ where: { id: f0.projectId! }, select: { debriefSubmittedAt: true } });
  c.ok("the debrief itself was written", !!p0.debriefSubmittedAt);
  c.ok("OLD: no video row holds the ticks", (await prisma.contentVideo.count({ where: { enrollmentId: f0.enrollmentId } })) === 0);
  c.ok("OLD: and no other row does either — nothing any sweep could retry from", (await prisma.contentFilmingReport.count({ where: { projectId: f0.projectId! } })) === 0);
  c.ok("OLD: no topic was marked filmed and nobody was told", (await prisma.contentTopicEvent.count({ where: { topicId: { in: f0.topicIds }, kind: "FILMED" } })) === 0 && (await prisma.activity.count({ where: { projectId: f0.projectId!, type: "FLAG" } })) === 0);

  // =========================================================================
  c.head("2 · NEW: the same failure — the submit succeeds and the answer is kept");
  // =========================================================================
  const f1 = await month("New Submit");
  const s1 = await script(f1, 0, true);
  const s2 = await script(f1, 1, false);
  const [t1, t2] = f1.topicIds;
  const outBefore = fence.blocked.length;
  const res1 = await finalizeUpload(f1.projectId!, submitFor(f1));
  c.ok("the submit resolves, not blocked", !res1.blocked && !res1.needsConfirm, JSON.stringify(res1).slice(0, 160));
  c.ok("…and says the topics are pending, in words", !!res1.topicsPending && res1.topicsPending.count === 3 && /retries on its own/.test(res1.topicsPending.message), JSON.stringify(res1.topicsPending));
  const p1 = await prisma.project.findUniqueOrThrow({ where: { id: f1.projectId! }, select: { debriefSubmittedAt: true, videosFilmed: true, status: true } });
  c.ok("the debrief was written and the job moved on", !!p1.debriefSubmittedAt && p1.status === "SHOT", p1.status);
  c.ok("videosFilmed is the server's count: 2 ticks + 1 extra", p1.videosFilmed === 3, String(p1.videosFilmed));
  const r1rows = await prisma.contentFilmingReport.findMany({ where: { projectId: f1.projectId! } });
  const r1 = r1rows[0];
  c.ok("exactly one ContentFilmingReport", r1rows.length === 1);
  c.ok("…FAILED after one attempt, with a retry time and the error", r1?.state === "FAILED" && r1.attempts === 1 && !!r1.nextAttemptAt && /refused/.test(r1.lastError ?? ""), `${r1?.state}/${r1?.attempts} ${r1?.lastError?.slice(0, 60)}`);
  c.ok("…holding exactly the ticks", JSON.stringify([...JSON.parse(r1.topicIdsJson)].sort()) === JSON.stringify([t1, t2].sort()));
  const extras1 = JSON.parse(r1.extrasJson ?? "[]") as { key: string; title: string; note: string }[];
  c.ok("…the on-site extra, with its note", extras1.length === 1 && extras1[0].title === EXTRA_TITLE && extras1[0].note === "kitchen", r1.extrasJson ?? "");
  c.ok("…and the note on t1", JSON.parse(r1.notesJson ?? "{}")[t1] === "drone opener");
  c.ok("…and who said it (the email, not just the name)", r1.submittedByEmail === "harrison-drill@example.com" && r1.submittedBy === "Harrison", `${r1.submittedBy} <${r1.submittedByEmail}>`);
  c.ok("…and which leg was filmed", r1.appointmentId === (await prisma.appointment.findUniqueOrThrow({ where: { id: f1.appointmentIds[0] } })).aryeoId);
  c.ok("no video row yet — the insert really was refused", (await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } })) === 0);
  c.ok("ONE flag on the job", (await filmingFlags(f1.projectId!)) === 1);

  // =========================================================================
  c.head("3 · the block lifts; the hourly sweep lands it — after the backoff");
  // =========================================================================
  await unblock();
  const early = await ft.sweepFilmingReports({ now: new Date(Date.now() + 10 * 60_000) });
  c.ok("ten minutes later the sweep leaves it alone (15-minute backoff)", early.due === 0, JSON.stringify(early));
  const t16 = new Date(Date.now() + 16 * 60_000);
  const swept = await ft.sweepFilmingReports({ now: t16 });
  c.ok("sixteen minutes later it applies it", swept.due === 1 && swept.applied === 1, JSON.stringify(swept));
  const r1b = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r1.id } });
  c.ok("the report is APPLIED, attempt 2, no lease left", r1b.state === "APPLIED" && r1b.attempts === 2 && !r1b.leaseUntil && !!r1b.appliedAt, `${r1b.state}/${r1b.attempts}`);
  const vids = await prisma.contentVideo.findMany({ where: { enrollmentId: f1.enrollmentId } });
  const vOf = (topicId: string) => vids.filter((v) => v.topicId === topicId);
  c.ok("t1 and t2: one PROGRAM video each, counted toward the allowance", [t1, t2].every((t) => vOf(t).length === 1 && vOf(t)[0].kind === "PROGRAM" && vOf(t)[0].countsTowardAllowance));
  c.ok("…confirmed, by his email", [t1, t2].every((t) => !!vOf(t)[0].filmedConfirmedAt && vOf(t)[0].filmedConfirmedBy === "harrison-drill@example.com"));
  c.ok("…dated by the session that was filmed (A1's end)", [t1, t2].every((t) => vOf(t)[0].filmedAt?.getTime() === A1_END.getTime()), vOf(t1)[0]?.filmedAt?.toISOString());
  c.ok("…with the selection they came from", vOf(t1)[0].selectionId === f1.selectionIds[0] && vOf(t2)[0].selectionId === f1.selectionIds[1]);
  c.ok("t1's approved script: the exact version the client approved is recorded", vOf(t1)[0].scriptId === s1.scriptId && vOf(t1)[0].scriptVersionId === s1.versionId);
  c.ok("t2's unapproved script: the script, but no approved version", vOf(t2)[0].scriptId === s2.scriptId && vOf(t2)[0].scriptVersionId === null);
  const extraTopics = await prisma.contentTopic.findMany({ where: { enrollmentId: f1.enrollmentId, title: EXTRA_TITLE } });
  c.ok("the extra became ONE topic, PROPOSED (the office never approved it)", extraTopics.length === 1 && extraTopics[0].approvalState === "PROPOSED" && extraTopics[0].status === "FILMED", `${extraTopics.length} ${extraTopics[0]?.approvalState}/${extraTopics[0]?.status}`);
  const extraId = extraTopics[0].id;
  const extraSel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: extraId, monthId: f1.monthId } } });
  c.ok("…selected for the month as OVERFLOW (the month was full)", extraSel?.status === "SELECTED" && extraSel.overflow === true);
  c.ok("…with one EXTRA video that does not count toward the allowance", vOf(extraId).length === 1 && vOf(extraId)[0].kind === "EXTRA" && !vOf(extraId)[0].countsTowardAllowance);
  c.ok("the ticked topics are FILMED", (await prisma.contentTopic.count({ where: { id: { in: [t1, t2] }, status: "FILMED" } })) === 2);
  const capTasks = await prisma.smartTask.findMany({ where: { projectId: f1.projectId!, taskType: "content_capacity_review" } });
  c.ok("exactly one capacity-review task, on Kyle's desk", capTasks.length === 1 && capTasks[0].assignedKey === "kyle" && capTasks[0].ownerId === kyle.id && capTasks[0].priority === "MEDIUM");
  c.ok("…naming the extra and why", /Open-house mistakes — filmed on site, beyond this month's allowance/.test(capTasks[0]?.description ?? ""), capTasks[0]?.description ?? "");
  c.ok("…and the three choices, nothing charged", /this month, next month, or is billed as an extra/.test(capTasks[0]?.summary ?? "") && JSON.parse(capTasks[0]?.checklist ?? "[]").length === 3);
  c.ok("the office got a bell for it", (await prisma.notification.count({ where: { kind: "content_capacity_review" } })) === 1);
  c.ok("still one flag on the job — the landing added none", (await filmingFlags(f1.projectId!)) === 1);
  c.ok("nothing tried to leave the machine", fence.blocked.length === outBefore, fence.blocked.slice(outBefore).join(", "));

  // =========================================================================
  c.head("4 · idempotent: sweep again, submit the same again, then a different answer");
  // =========================================================================
  const snapshot = async () => ({
    videos: await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } }),
    topics: await prisma.contentTopic.count({ where: { enrollmentId: f1.enrollmentId } }),
    tasks: await prisma.smartTask.count({ where: { projectId: f1.projectId! } }),
    reports: await prisma.contentFilmingReport.count({ where: { projectId: f1.projectId! } }),
    attempts: (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r1.id } })).attempts,
    flags: await filmingFlags(f1.projectId!),
    events: await prisma.contentTopicEvent.count({ where: { enrollmentId: f1.enrollmentId } }),
  });
  const before4 = await snapshot();
  const again = await ft.sweepFilmingReports({ now: new Date(Date.now() + 2 * HOUR) });
  c.ok("a second sweep finds nothing due", again.due === 0, JSON.stringify(again));
  const res4 = await finalizeUpload(f1.projectId!, submitFor(f1));
  c.ok("an identical re-submit succeeds with nothing pending", !res4.blocked && !res4.topicsPending, JSON.stringify(res4).slice(0, 120));
  const after4 = await snapshot();
  c.ok("…and changes nothing: reports, attempts, videos, topics, tasks, flags, history", JSON.stringify(after4) === JSON.stringify(before4), `${JSON.stringify(before4)} → ${JSON.stringify(after4)}`);
  c.ok("videosFilmed stays 3 (the landed extra is not counted twice)", (await prisma.project.findUniqueOrThrow({ where: { id: f1.projectId! } })).videosFilmed === 3);
  const res4b = await finalizeUpload(f1.projectId!, submitFor(f1, { [t1]: "drone opener", [t2]: "shoot it by the window" }));
  c.ok("a DIFFERENT answer (a note added) lands at once", !res4b.topicsPending, JSON.stringify(res4b).slice(0, 120));
  const reports4 = await prisma.contentFilmingReport.findMany({ where: { projectId: f1.projectId! }, orderBy: { createdAt: "asc" } });
  c.ok("…as a second report, APPLIED on its first attempt", reports4.length === 2 && reports4[1].state === "APPLIED" && reports4[1].attempts === 1);
  c.ok("…without a second video or a second task", (await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } })) === before4.videos && (await prisma.smartTask.count({ where: { projectId: f1.projectId!, taskType: "content_capacity_review" } })) === 1);
  const one = await prisma.$queryRawUnsafe<{ one: number }[]>("SELECT 1 AS one");
  c.ok("the database connection is still up after every collision", one[0]?.one === 1, `${server.patchStats.strippedReady} unique violations survived so far`);

  // =========================================================================
  c.head("5 · the editor's slots: topic, note, live title, and Kim still routed");
  // =========================================================================
  const outs = await prisma.deliverableOutput.findMany({ where: { projectId: f1.projectId! }, orderBy: { slot: "asc" } });
  c.ok("three slots, carrying t1, t2 and the extra in rank order", outs.length === 3 && outs[0].topicId === t1 && outs[1].topicId === t2 && outs[2].topicId === extraId, outs.map((o) => `${o.slot}:${o.topicId === t1 ? "t1" : o.topicId === t2 ? "t2" : o.topicId === extraId ? "extra" : o.topicId}`).join(" "));
  c.ok("slot 1 carries 'drone opener', slot 3 'kitchen'", outs[0].filmingNote === "drone opener" && outs[2].filmingNote === "kitchen");
  c.ok("slot 2 took the later report's note", outs[1].filmingNote === "shoot it by the window", String(outs[1].filmingNote));
  const cv = await prisma.contentVideo.findMany({ where: { enrollmentId: f1.enrollmentId }, select: { topicId: true, outputId: true, deliverableId: true, slot: true } });
  c.ok("each topic video points at its slot (deliverable, slot, output)", [t1, t2, extraId].every((t, i) => { const v = cv.find((x) => x.topicId === t); return v?.outputId === outs[i].id && v.deliverableId === f1.deliverableId && v.slot === i + 1; }));
  const titles = new Map((await prisma.contentTopic.findMany({ where: { id: { in: [t1, t2, extraId] } } })).map((t) => [t.id, t.title]));
  let rows = await outputsForProject(f1.projectId!);
  c.ok("the editor reads the topic titles, not 'Video 2 of 3'", rows.map((r) => r.label).join(" | ") === [t1, t2, extraId].map((t) => titles.get(t)).join(" | "), rows.map((r) => r.label).join(" | "));
  c.ok("…with the topic and note on each row", rows[0].topicId === t1 && rows[0].topicTitle === titles.get(t1) && rows[0].filmingNote === "drone opener");
  await prisma.contentTopic.update({ where: { id: t2 }, data: { title: "The inspection talk, renamed" } });
  rows = await outputsForProject(f1.projectId!);
  c.ok("a renamed topic renames its video at once", rows[1].label === "The inspection talk, renamed", rows[1].label);
  c.ok("no Deliverable was made for the extra", (await prisma.deliverable.count({ where: { projectId: f1.projectId! } })) === 1);
  await mintEditTask(f1.projectId!);
  const edit = await prisma.smartTask.findFirst({ where: { projectId: f1.projectId!, taskType: "edit_video" }, select: { assignedKey: true } });
  c.ok("the monthly row's edit still goes to Kim", edit?.assignedKey === "kim", String(edit?.assignedKey));

  // =========================================================================
  c.head("6 · the library: the first cut on slot 1 is t1's video, not a new one");
  // =========================================================================
  const videosBefore6 = await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } });
  const cut = await prisma.reviewSubmission.create({
    data: { projectId: f1.projectId!, deliverableId: f1.deliverableId, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "pricing-v1.mp4" },
    select: { id: true },
  });
  await syncEnrollmentVideos({ id: f1.enrollmentId, clientId: f1.clientId });
  const link = await prisma.contentVideoSource.findUnique({ where: { kind_ref: { kind: "REVIEW_CUT", ref: cut.id } } });
  c.ok("the cut's library source is t1's own video", !!link && link.videoId === vOf(t1)[0].id, `${link?.videoId} vs ${vOf(t1)[0].id}`);
  c.ok("…and no second video was minted for it", (await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } })) === videosBefore6);
  const archived6 = await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId, filmedConfirmedAt: { not: null }, status: "ARCHIVED" } });
  // Section 3 of the design (the archival exemption in contentVideos.ts) is the
  // CP-01 builder's, not this drill's to assert — reported, not scored.
  console.log(`    NOTE: after the library sweep ${archived6} confirmed video(s) are ARCHIVED${archived6 ? " — CP-01's survivor exemption is not in this tree yet" : " — the survivor exemption is in place"}.`);

  // =========================================================================
  c.head("7 · races: one claim, one video per topic, dead leases picked up");
  // =========================================================================
  const f2 = await month("Race One");
  const rr = await reportFor(f2, { filmedTopicIds: f2.topicIds });
  const [ra, rb] = await Promise.all([ft.applyFilmingReport(rr), ft.applyFilmingReport(rr)]);
  c.ok("two applies of one fresh report: exactly one claims it", [ra, rb].filter((r) => r.claimed).length === 1, `${ra.claimed}/${ra.state} ${rb.claimed}/${rb.state}`);
  c.ok("…it is APPLIED on one attempt", (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: rr } })).attempts === 1);
  const v2 = await prisma.contentVideo.findMany({ where: { enrollmentId: f2.enrollmentId }, select: { topicId: true } });
  c.ok("…one video per topic", v2.length === 3 && f2.topicIds.every((t) => v2.filter((v) => v.topicId === t).length === 1), String(v2.length));
  const f3 = await month("Race Two");
  const rA = await reportFor(f3, { filmedTopicIds: [f3.topicIds[0], f3.topicIds[1]] });
  const rB = await reportFor(f3, { filmedTopicIds: [f3.topicIds[0], f3.topicIds[1]], topicNotes: { [f3.topicIds[0]]: "wide first" } });
  const both = await Promise.all([ft.applyFilmingReport(rA), ft.applyFilmingReport(rB)]);
  c.ok("two different reports on one job, at once: both land", both.every((r) => r.state === "APPLIED"), both.map((r) => r.state).join("/"));
  const v3 = await prisma.contentVideo.findMany({ where: { enrollmentId: f3.enrollmentId }, select: { topicId: true, outputId: true } });
  c.ok("…and the lock gives one video per topic, each on its own slot", v3.length === 2 && new Set(v3.map((v) => v.topicId)).size === 2 && new Set(v3.map((v) => v.outputId)).size === 2 && v3.every((v) => !!v.outputId));
  const rDead = await reportFor(f3, { filmedTopicIds: [f3.topicIds[2]] });
  await prisma.contentFilmingReport.update({ where: { id: rDead }, data: { state: "APPLYING", attempts: 1, leaseUntil: new Date(Date.now() - 60_000) } });
  const rLive = await reportFor(f3, { filmedTopicIds: [f3.topicIds[0]], topicNotes: { [f3.topicIds[0]]: "still running" } });
  const liveLease = new Date(Date.now() + 4 * 60_000);
  await prisma.contentFilmingReport.update({ where: { id: rLive }, data: { state: "APPLYING", attempts: 1, leaseUntil: liveLease } });
  await ft.sweepFilmingReports();
  const dead = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: rDead } });
  const live = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: rLive } });
  c.ok("a runner that died holding the lease: the sweep takes it over and lands it", dead.state === "APPLIED" && dead.attempts === 2, `${dead.state}/${dead.attempts}`);
  c.ok("a runner still inside its lease is left alone", live.state === "APPLYING" && live.attempts === 1 && live.leaseUntil?.getTime() === liveLease.getTime(), `${live.state}/${live.attempts}`);
  await prisma.contentFilmingReport.update({ where: { id: rLive }, data: { state: "APPLIED", leaseUntil: null } }); // retire it for the later sweeps

  // =========================================================================
  c.head("8 · OLD vs NEW: a Pro month's future session, and an overflow tick");
  // =========================================================================
  const pro = (name: string) =>
    month(name, {
      package: "Pro",
      videosPerMonth: undefined,
      appointments: [{ startAt: A1 }, { startAt: NEXT_WEEK }],
    });
  const f4 = await pro("Pro Old");
  const f5 = await pro("Pro New");
  for (const f of [f4, f5]) await prisma.contentTopicSelection.update({ where: { id: f.selectionIds[2]! }, data: { overflow: true } });
  const nextWeekEnd = new Date(NEXT_WEEK.getTime() + 120 * 60_000);
  const old8 = await oldFT.confirmFilmedTopics(f4.projectId!, [f4.topicIds[0], f4.topicIds[2]], "Harrison");
  const oldV = await prisma.contentVideo.findMany({ where: { enrollmentId: f4.enrollmentId } });
  c.ok("OLD: filmed after session 1, dated by session 2 — next week", old8.filmedAtISO === nextWeekEnd.toISOString(), old8.filmedAtISO ?? "null");
  const oldOver = oldV.find((v) => v.topicId === f4.topicIds[2]);
  c.ok("OLD: the overflow tick is a PROGRAM video counted toward the allowance", oldOver?.kind === "PROGRAM" && oldOver.countsTowardAllowance === true);
  c.ok("OLD: filmedConfirmedBy is the display name", oldOver?.filmedConfirmedBy === "Harrison");
  // A leg Aryeo sent with no status is not a cancellation (the old filter skipped it).
  await prisma.appointment.update({ where: { id: f5.appointmentIds[0] }, data: { status: null } });
  const new8 = await ft.confirmFilmedTopics(f5.projectId!, [f5.topicIds[0], f5.topicIds[2]], "Harrison", { byEmail: "harrison-drill@example.com" });
  c.ok("NEW: dated by session 1, the one that was filmed (even with a null status)", new8.filmedAtISO === A1_END.toISOString(), new8.filmedAtISO ?? "null");
  const newV = await prisma.contentVideo.findMany({ where: { enrollmentId: f5.enrollmentId } });
  const newOver = newV.find((v) => v.topicId === f5.topicIds[2]);
  c.ok("NEW: the overflow tick is EXTRA and does not count toward the allowance", newOver?.kind === "EXTRA" && newOver.countsTowardAllowance === false && new8.overflow.length === 1);
  c.ok("NEW: the in-plan tick is still PROGRAM", newV.find((v) => v.topicId === f5.topicIds[0])?.kind === "PROGRAM");
  c.ok("NEW: filmedConfirmedBy is the email", newOver?.filmedConfirmedBy === "harrison-drill@example.com");

  // =========================================================================
  c.head("9 · OLD vs NEW: a legacy month topic, and the month's second session");
  // =========================================================================
  const f6 = await month("Two Sessions");
  const legacy = await prisma.contentTopic.create({
    data: { enrollmentId: f6.enrollmentId, clientId: f6.clientId, monthId: f6.monthId, title: "Two Sessions: a legacy scripted topic", status: "SCRIPTED" },
    select: { id: true },
  });
  const oldList = await oldFT.topicsForSession(f6.projectId!);
  c.ok("OLD: a topic held on the month only by its pointer is missing from the list", !!oldList && !oldList.topics.some((t) => t.topicId === legacy.id));
  const newList = await ft.topicsForSession(f6.projectId!);
  const legacyRow = newList?.topics.find((t) => t.topicId === legacy.id);
  c.ok("NEW: it is on the list, after the selected topics, with no selection", !!legacyRow && legacyRow.selectionId === null && newList!.topics[newList!.topics.length - 1].topicId === legacy.id);
  const p2 = await prisma.project.create({ data: { clientId: f6.clientId, title: "Two Sessions TEST — session 2", status: "SCHEDULED", contentMonthId: f6.monthId, packageName: "Video Starter" }, select: { id: true } });
  await ft.confirmFilmedTopics(f6.projectId!, [f6.topicIds[0]], "Harrison", { byEmail: "harrison-drill@example.com" });
  const oldP2 = await oldFT.topicsForSession(p2.id);
  const oldPreTicked = (oldP2?.topics ?? []).filter((t) => t.filmedConfirmedAtISO).map((t) => t.topicId);
  c.ok("OLD: session 2's page would pre-tick the topic session 1 filmed", oldPreTicked.includes(f6.topicIds[0]));
  const newP2 = await ft.topicsForSession(p2.id);
  const t1OnP2 = newP2?.topics.find((t) => t.topicId === f6.topicIds[0]);
  c.ok("NEW: session 2 sees it as session 1's (confirmedOnProjectId)", t1OnP2?.confirmedOnProjectId === f6.projectId);
  c.ok("NEW: …so the pre-tick rule (this project only) leaves it unticked", !(newP2?.topics ?? []).filter((t) => t.confirmedOnProjectId === p2.id).some((t) => t.topicId === f6.topicIds[0]));
  const prep9 = await ft.prepareFilmingReport(p2.id, { filmedTopicIds: [f6.topicIds[0], legacy.id] }, { name: "Harrison" });
  c.ok("NEW: …and a stale tick of it is not counted on session 2 (1 video, the legacy topic)", prep9?.videosFilmed === 1, String(prep9?.videosFilmed));

  // =========================================================================
  c.head("10 · six failures: stop retrying, put it in front of Kyle");
  // =========================================================================
  const f7 = await month("Gives Up");
  const r7 = await reportFor(f7, { filmedTopicIds: [f7.topicIds[0]] });
  await block();
  let t = Date.now();
  const gaps: number[] = [];
  let last: Awaited<ReturnType<typeof ft.applyFilmingReport>> | null = null;
  for (let i = 1; i <= 6; i++) {
    t += 3 * 24 * HOUR;
    last = await ft.applyFilmingReport(r7, { now: new Date(t) });
    const row = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r7 } });
    if (row.nextAttemptAt) gaps.push(Math.round((row.nextAttemptAt.getTime() - t) / 60_000));
  }
  c.ok("the backoff doubles from 15 minutes", JSON.stringify(gaps) === JSON.stringify([15, 30, 60, 120, 240]), JSON.stringify(gaps));
  const r7row = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r7 } });
  c.ok("the sixth failure is NEEDS_REVIEW, with no next attempt", last?.state === "NEEDS_REVIEW" && r7row.state === "NEEDS_REVIEW" && r7row.attempts === 6 && !r7row.nextAttemptAt);
  const fix = await prisma.smartTask.findMany({ where: { projectId: f7.projectId!, taskType: "content_filming_report" } });
  c.ok("one task on Kyle's desk, listing what was filmed", fix.length === 1 && fix[0].assignedKey === "kyle" && fix[0].ownerId === kyle.id && fix[0].description?.includes("Gives Up: pricing in week one") === true, fix[0]?.description?.slice(0, 80));
  c.ok("…and one bell for the office", (await prisma.notification.count({ where: { kind: "content_filming_report" } })) === 1);
  const seventh = await ft.applyFilmingReport(r7, { now: new Date(t + 24 * HOUR) });
  const sweep10 = await ft.sweepFilmingReports({ now: new Date(t + 48 * HOUR) });
  c.ok("nothing retries it after that — not a direct call, not the sweep", !seventh.claimed && sweep10.due === 0 && (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r7 } })).attempts === 6);
  await unblock();

  // =========================================================================
  c.head("11 · the real GET /api/cron/sync lands a due report, before the library");
  // =========================================================================
  const routeSrc = fs.readFileSync(path.join(REPO, "src/app/api/cron/sync/route.ts"), "utf8");
  c.ok("the filmingReports step runs before contentLibrary", routeSrc.indexOf('step("filmingReports"') > 0 && routeSrc.indexOf('step("filmingReports"') < routeSrc.indexOf('step("contentLibrary"'));
  const f8 = await month("Cron Lands");
  const r8 = await reportFor(f8, { filmedTopicIds: [f8.topicIds[0], f8.topicIds[1]] });
  await prisma.contentFilmingReport.update({ where: { id: r8 }, data: { state: "FAILED", attempts: 1, nextAttemptAt: new Date(Date.now() - 60_000), lastError: "drill: an earlier failure" } });
  const { GET } = await import("@/app/api/cron/sync/route");
  const { NextRequest } = await import("next/server");
  const res11 = await GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: { authorization: "Bearer drill-secret" } }));
  const body11 = (await res11.json()) as Record<string, unknown>;
  const step11 = body11.filmingReports as { applied?: number } | undefined;
  c.ok("the route answered 200 and ran the step without error", res11.status === 200 && !!step11 && !("filmingReportsError" in body11), String(body11.filmingReportsError ?? res11.status));
  c.ok("…and landed the report", (step11?.applied ?? 0) >= 1 && (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r8 } })).state === "APPLIED", JSON.stringify(step11));
  c.ok("…whose topics are bound to the job's slots", (await prisma.contentVideo.count({ where: { enrollmentId: f8.enrollmentId, outputId: { not: null } } })) === 2);

  // =========================================================================
  c.head("12 · OLD vs NEW: one raw folder per topic, behind topic_folders");
  // =========================================================================
  const { saveSecret } = await import("@/lib/integrations/connections");
  const df = await import("@/lib/dropboxFolders");
  const oldDF = (await import(base.dropboxFolders)) as { ensureFoldersForUpcomingShoots: () => Promise<{ created: number; topicFolders?: unknown }> };
  const { filmingBriefFor } = await import("@/lib/deliverableOutputs");
  const TOMORROW = new Date(Math.floor((Date.now() + 26 * HOUR) / 60_000) * 60_000);
  const f9 = await month("Folders", { appointments: [{ startAt: TOMORROW }] });
  const [g1, g2, g3] = f9.topicIds;
  const sectionStart = dbxCalls.length;
  const callsSince = (n: number) => dbxCalls.slice(n);
  const childrenOf = (dir: string) =>
    [...dbxTree.values()].filter((x) => x.path.toLowerCase().startsWith(`${dir.toLowerCase()}/`) && !x.path.slice(dir.length + 1).includes("/"));
  await saveSecret("dropbox", "drill-dropbox-refresh-token");

  const oldSweep = await oldDF.ensureFoldersForUpcomingShoots();
  const listing = (await prisma.project.findUniqueOrThrow({ where: { id: f9.projectId! }, select: { dropboxFolder: true } })).dropboxFolder ?? "";
  const rawVideo = `${listing}/02-RAW-Video`;
  c.ok("OLD (e26cacd): the engine makes the job's folder and its five numbered subfolders", oldSweep.created === 1 && childrenOf(listing).length === 5, `${oldSweep.created} · ${childrenOf(listing).map((x) => x.path.split("/").pop()).join(", ")}`);
  c.ok("OLD: …and nothing inside 02-RAW-Video — every topic's clips go in one pile", !!listing && childrenOf(rawVideo).length === 0);

  let mark = dbxCalls.length;
  const offSweep = await df.ensureFoldersForUpcomingShoots();
  c.ok("NEW, no topic_folders row: the sweep reports topic folders as not looked at", offSweep.topicFolders === null, JSON.stringify(offSweep.topicFolders));
  c.ok("…and never lists or writes inside 02-RAW-Video", !callsSince(mark).some((x) => x.path.toLowerCase().startsWith(rawVideo.toLowerCase())) && childrenOf(rawVideo).length === 0, callsSince(mark).map((x) => `${x.ep} ${x.path}`).join("; "));
  mark = dbxCalls.length;
  const offDirect = await df.ensureTopicFolders(f9.projectId!);
  c.ok("…and ensureTopicFolders says 'off' having made ZERO Dropbox calls", offDirect.state === "off" && dbxCalls.length === mark, JSON.stringify(offDirect));
  c.ok("no switch row was created by any of it (a missing row stays OFF)", (await prisma.programAutomation.count({ where: { key: "topic_folders" } })) === 0);

  await prisma.programAutomation.create({ data: { key: "topic_folders", enabled: true, enabledBy: "drill", enabledAt: new Date() } });
  const onSweep = await df.ensureFoldersForUpcomingShoots();
  const titles9 = new Map((await prisma.contentTopic.findMany({ where: { id: { in: f9.topicIds } }, select: { id: true, title: true } })).map((t) => [t.id, t.title]));
  const made9 = childrenOf(rawVideo).map((x) => x.path.split("/").pop()!).sort();
  const expected9 = f9.topicIds.map((id, i) => df.topicFolderName(i + 1, titles9.get(id)!, id)).sort();
  c.ok("switched on: the sweep makes one folder per topic, three", onSweep.topicFolders?.created === 3 && JSON.stringify(made9) === JSON.stringify(expected9), `${JSON.stringify(onSweep.topicFolders)} · ${made9.join(" | ")}`);
  c.ok("…named 'NN <title> [<id8>]', with the colon Dropbox refuses taken out", made9[0] === `01 Folders pricing in week one [${g1.slice(-8)}]`, made9[0]);
  const folderRow = (topicId: string) => prisma.contentTopicFolder.findUniqueOrThrow({ where: { projectId_topicId: { projectId: f9.projectId!, topicId } } });
  const rows9 = await prisma.contentTopicFolder.findMany({ where: { projectId: f9.projectId! } });
  c.ok("…each recorded once: CREATED, its path, and its Dropbox id", rows9.length === 3 && rows9.every((r) => r.state === "CREATED" && !!r.dropboxId && r.dropboxPath.startsWith(`${rawVideo}/`)));
  mark = dbxCalls.length;
  const again12 = await df.ensureFoldersForUpcomingShoots();
  c.ok("a second pass makes nothing: kept, not re-made", again12.topicFolders?.created === 0 && !callsSince(mark).some((x) => x.ep === "files/create_folder_v2"), JSON.stringify(again12.topicFolders));

  const g2Folder = (await folderRow(g2)).dropboxPath;
  dbxPutFile(`${g2Folder}/C0001.MP4`);
  await prisma.contentTopic.update({ where: { id: g2 }, data: { title: "Folders: the inspection talk, retitled" } });
  mark = dbxCalls.length;
  const r12a = await df.ensureTopicFolders(f9.projectId!);
  c.ok("a topic RENAMED in the hub: nothing made, renamed or moved", r12a.created === 0 && r12a.adopted === 0 && r12a.kept === 3 && callsSince(mark).every((x) => x.ep === "files/list_folder"), `${JSON.stringify(r12a)} · ${callsSince(mark).map((x) => x.ep).join(",")}`);
  c.ok("…its folder, and the clip in it, are exactly where they were", dbxTree.has(`${g2Folder}/C0001.MP4`.toLowerCase()) && (await folderRow(g2)).dropboxPath === g2Folder);
  const vids12 = await df.videoFilesUnder(listing);
  c.ok("raws-in still counts a clip inside a topic folder, as 02-RAW-Video footage", vids12?.count === 1 && vids12.where.includes("02-raw-video"), JSON.stringify(vids12));

  const g1Before = await folderRow(g1);
  const g3Before = await folderRow(g3);
  const g1Hand = `Pricing talk FINAL ${df.topicFolderTag(g1)}`;
  dbxRename(g1Before.dropboxPath, `${rawVideo}/${g1Hand}`); // bracket kept
  dbxRename(g3Before.dropboxPath, `${rawVideo}/Staging b-roll`); // bracket gone; the Dropbox id is not
  mark = dbxCalls.length;
  const r12b = await df.ensureTopicFolders(f9.projectId!);
  const [g1After, g3After] = [await folderRow(g1), await folderRow(g3)];
  c.ok("folders renamed BY HAND are adopted, never re-made", r12b.created === 0 && r12b.adopted === 2 && !callsSince(mark).some((x) => x.ep === "files/create_folder_v2"), JSON.stringify(r12b));
  c.ok("…one by its bracket, one by its Dropbox id when the bracket is gone", g1After.label === g1Hand && g3After.label === "Staging b-roll" && g3After.dropboxId === g3Before.dropboxId);
  c.ok("…and the record still says the hub made them", g1After.state === "CREATED" && g3After.state === "CREATED");

  const r9 = await reportFor(f9, { filmedTopicIds: [g1, g2], topicNotes: { [g1]: "wide first" }, extraTopics: [{ key: "e1", title: "Behind the scenes", note: "keep it loose" }] });
  mark = dbxCalls.length;
  const a9 = await ft.applyFilmingReport(r9);
  const extra9 = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: f9.enrollmentId, title: "Behind the scenes" }, select: { id: true } });
  const creates9 = callsSince(mark).filter((x) => x.ep === "files/create_folder_v2");
  c.ok("the report lands, and the extra filmed on site gets its own folder at once", a9.state === "APPLIED" && creates9.length === 1 && creates9[0].path === `${rawVideo}/04 Behind the scenes ${df.topicFolderTag(extra9.id)}`, `${a9.state} · ${creates9.map((x) => x.path.split("/").pop()).join(", ")}`);
  c.ok("in the whole section the hub never moved, renamed or deleted anything in Dropbox", !callsSince(sectionStart).some((x) => /move|delete|copy/.test(x.ep)), [...new Set(callsSince(sectionStart).map((x) => x.ep))].join(", "));

  const fb9 = await filmingBriefFor(f9.projectId!);
  const byTopic9 = new Map((fb9?.rows ?? []).map((r) => [r.topicId, r]));
  c.ok("the editor's rows carry each topic's folder, under the name it has NOW", byTopic9.get(g1)?.folder?.label === g1Hand && byTopic9.get(extra9.id)?.folder?.label.startsWith("04 Behind the scenes [") === true, (fb9?.rows ?? []).map((r) => r.folder?.label).join(" | "));
  const g2Row = byTopic9.get(g2);
  c.ok("a renamed topic keeps its clips: its new title, beside its original folder", g2Row?.topicTitle === "Folders: the inspection talk, retitled" && g2Row.folder?.label === g2Folder.split("/").pop(), `${g2Row?.topicTitle} → ${g2Row?.folder?.label}`);
  c.ok("…and the notes ride with them ('wide first', 'keep it loose')", byTopic9.get(g1)?.note === "wide first" && byTopic9.get(extra9.id)?.note === "keep it loose");

  const movedListing = `${listing} (moved)`;
  dbxRename(listing, movedListing);
  await prisma.project.update({ where: { id: f9.projectId! }, data: { dropboxFolder: movedListing } });
  const links9 = await df.topicFolderLinksFor(f9.projectId!);
  c.ok("the engine moves the job's folder (a reschedule): every topic link follows by name", links9.size === 4 && [...links9.values()].every((l) => l.path.startsWith(`${movedListing}/02-RAW-Video/`) && dbxTree.get(l.path.toLowerCase())?.tag === "folder"));
  mark = dbxCalls.length;
  const r12c = await df.ensureTopicFolders(f9.projectId!);
  c.ok("…and the next pass re-records the paths without making or moving a thing", r12c.created === 0 && r12c.kept === 4 && !callsSince(mark).some((x) => x.ep !== "files/list_folder") && (await folderRow(g1)).dropboxPath.startsWith(movedListing), JSON.stringify(r12c));
  await mintEditTask(f9.projectId!);
  const edit9 = await prisma.smartTask.findFirst({ where: { projectId: f9.projectId!, taskType: "edit_video" }, select: { assignedKey: true } });
  c.ok("Kim keeps personal branding: the monthly row's edit is hers, and no Deliverable was added for the extra", edit9?.assignedKey === "kim" && (await prisma.deliverable.count({ where: { projectId: f9.projectId! } })) === 1, String(edit9?.assignedKey));

  // =========================================================================
  c.head("13 · OLD vs NEW: the editor's brief says which topic each video is");
  // =========================================================================
  const { getProject } = await import("@/lib/queries");
  const { cutSlots } = await import("@/lib/reviewCuts");
  const { projectBrief } = await import("@/lib/projectBrief");
  const { buildEditorBriefPdf } = await import("@/lib/editor-pdf");
  const oldPdf = (await import(base.editorPdf)) as { buildEditorBriefPdf: (p: NonNullable<Awaited<ReturnType<typeof getProject>>>) => Promise<Uint8Array> };
  const full1 = (await getProject(f1.projectId!))!;
  const t1Title = titles.get(t1)!;
  const oldText = pdfText(await oldPdf.buildEditorBriefPdf(full1));
  c.ok("OLD: the printed brief says how many were filmed…", oldText.includes("3 videos were filmed on this session - cut this many."), oldText.slice(0, 80));
  c.ok("OLD: …and not one topic, note or script decision", ![t1Title, EXTRA_TITLE, "drone opener", "kitchen", "approved by the client"].some((x) => oldText.includes(norm(x))));
  const fb1 = await filmingBriefFor(f1.projectId!);
  const want1 = [t1Title, "The inspection talk, renamed", EXTRA_TITLE];
  c.ok("NEW filmingBriefFor: one row per owed video, in slot order, titled as the topics read NOW", JSON.stringify(fb1?.rows.map((r) => r.topicTitle)) === JSON.stringify(want1), JSON.stringify(fb1?.rows.map((r) => r.topicTitle)));
  c.ok("…the slot each one is", JSON.stringify(fb1?.rows.map((r) => r.slot)) === "[1,2,3]" && /Video 1 of 3$/.test(fb1?.rows[0].slotLabel ?? ""), fb1?.rows[0].slotLabel ?? "");
  c.ok("…with the photographer's note on each", JSON.stringify(fb1?.rows.map((r) => r.note)) === JSON.stringify(["drone opener", "shoot it by the window", "kitchen"]));
  const sc1 = fb1?.rows[0].script;
  c.ok("…t1: the exact version the client approved, with its words", !!sc1 && sc1.clientApproved && sc1.versionNo === 1 && sc1.text === "b" && /approved by the client before filming/.test(sc1.standing), JSON.stringify(sc1));
  const sc2 = fb1?.rows[1].script;
  c.ok("…t2: the script, plainly NOT approved by the client", !!sc2 && !sc2.clientApproved && /not approved by them yet/.test(sc2.standing), JSON.stringify(sc2));
  c.ok("…the extra says it was filmed on site, and has no script", fb1?.rows[2].extra === "added_on_site" && fb1.rows[2].script === null && fb1.rows[0].extra === null);
  c.ok("…no owed video without a topic, nothing pending", fb1?.slotsWithoutTopic === 0 && fb1.pending === null);
  const newText = pdfText(await buildEditorBriefPdf(full1));
  c.ok("NEW: the printed brief names every topic, as it reads now", want1.every((t) => newText.includes(norm(t))), newText.slice(newText.indexOf("one per topic") - 20, newText.indexOf("one per topic") + 200));
  c.ok("…with every note from the shoot", ["drone opener", "shoot it by the window", "kitchen"].every((n) => newText.includes(n)));
  c.ok("…and which words the client approved, and which they have not", newText.includes("approved by the client before filming") && newText.includes("not approved by them yet"));
  const slots1 = await cutSlots(f1.projectId!);
  c.ok("cutSlots carries each slot's live topic title…", JSON.stringify(slots1.map((s) => s.topicTitle)) === JSON.stringify(want1), JSON.stringify(slots1.map((s) => s.topicTitle)));
  c.ok("…and leaves the label, which names the approved file, alone", slots1.every((s, i) => s.label.endsWith(`Video ${i + 1} of 3`)), slots1.map((s) => s.label).join(" | "));
  const pb1 = await projectBrief(f1.projectId!);
  c.ok("the project summary carries the same rows", JSON.stringify(pb1?.filming?.rows.map((r) => r.topicTitle)) === JSON.stringify(want1));
  const listingBrief = await filmingBriefFor((await prisma.project.create({ data: { clientId: f1.clientId, title: "12 Plain Listing TEST", status: "SHOT" }, select: { id: true } })).id);
  c.ok("a listing shoot has no filming brief (the PDF keeps its plain count there)", listingBrief === null);

  // =========================================================================
  c.head("14 · a session with no planned topics: what was filmed is added on the page");
  // =========================================================================
  const f10 = await month("Unplanned", { topics: [] });
  const res14 = await finalizeUpload(f10.projectId!, {
    editorBrief: "x",
    force: true,
    cullingConfirmed: true,
    videoInstructions: "VISION FOR THE EDIT\nfast cuts",
    filmedTopicIds: [],
    extraTopics: [{ key: "u1", title: "Kitchen reveal", note: "the island shot" }, { key: "u2", title: "Neighborhood coffee" }],
  });
  c.ok("the submit lands with nothing pending", !res14.blocked && !res14.needsConfirm && !res14.topicsPending, JSON.stringify(res14).slice(0, 160));
  c.ok("the editor cuts two — the server's count from the added topics", (await prisma.project.findUniqueOrThrow({ where: { id: f10.projectId! } })).videosFilmed === 2);
  const tp10 = await prisma.contentTopic.findMany({ where: { enrollmentId: f10.enrollmentId }, select: { title: true, sourceRef: true, status: true } });
  c.ok("both became topics on the month, filmed, traceable to the report", tp10.length === 2 && tp10.every((t) => t.sourceRef?.startsWith("FilmingReport:") && t.status === "FILMED"), JSON.stringify(tp10));
  const fb10 = await filmingBriefFor(f10.projectId!);
  c.ok("…each on its own owed video, marked filmed on site, with its note", fb10?.rows.length === 2 && fb10.rows.every((r) => r.extra === "added_on_site" && r.slot != null) && fb10.rows.find((r) => r.topicTitle === "Kitchen reveal")?.note === "the island shot", JSON.stringify(fb10?.rows.map((r) => [r.topicTitle, r.slot, r.extra, r.note])));
  c.ok("…and the third owed video says it has no topic yet", fb10?.slotsWithoutTopic === 1);

  // =========================================================================
  c.head("15 · a report that has not landed is still in the editor's brief");
  // =========================================================================
  const f11 = await month("Still Saving");
  await block();
  const res15 = await finalizeUpload(f11.projectId!, submitFor(f11));
  c.ok("the insert is refused: the footage submit lands, the topics are pending", !res15.blocked && !!res15.topicsPending, JSON.stringify(res15).slice(0, 120));
  const fb11 = await filmingBriefFor(f11.projectId!);
  const pendingTitles = (fb11?.pending?.topics ?? []).map((t) => t.title);
  c.ok("no bound rows yet — but the brief lists what the photographer reported", fb11?.rows.length === 0 && fb11.pending?.state === "FAILED" && pendingTitles.includes(`Still Saving: pricing in week one`) && pendingTitles.includes(EXTRA_TITLE), JSON.stringify(fb11?.pending));
  c.ok("…with the note and the on-site extra marked", fb11?.pending?.topics.find((t) => t.title === `Still Saving: pricing in week one`)?.note === "drone opener" && fb11.pending.topics.find((t) => t.title === EXTRA_TITLE)?.extra === true);
  const text15 = pdfText(await buildEditorBriefPdf((await getProject(f11.projectId!))!));
  c.ok("…and so does the printed brief", text15.includes("Reported by the photographer, not recorded yet") && text15.includes("drone opener") && text15.includes(EXTRA_TITLE), text15.slice(text15.indexOf("Reported"), text15.indexOf("Reported") + 160));
  const r11 = await prisma.contentFilmingReport.findFirstOrThrow({ where: { projectId: f11.projectId! }, select: { id: true } });
  await prisma.contentFilmingReport.update({ where: { id: r11.id }, data: { attempts: ft.FILMING_REPORT_MAX_ATTEMPTS, nextAttemptAt: null } });
  const gaveUp = await ft.applyFilmingReport(r11.id);
  const pb11 = await projectBrief(f11.projectId!);
  c.ok("when it gives up, the project summary's filming rows say so…", gaveUp.state === "NEEDS_REVIEW" && pb11?.filming?.pending?.state === "NEEDS_REVIEW", `${gaveUp.state} / ${pb11?.filming?.pending?.state}`);
  // The job's debrief is complete, so nothing earlier claims the blocker line.
  c.ok("…and it is what the summary says is in the way", /^The filmed topics did not save — 3 to record by hand/.test(pb11?.blocker ?? ""), String(pb11?.blocker));
  const text15b = pdfText(await buildEditorBriefPdf((await getProject(f11.projectId!))!));
  c.ok("…and the printed brief stops saying the hub is still saving them", text15b.includes("not recorded yet (the office is recording these by hand)") && !text15b.includes("the hub is still saving these"));
  await unblock();

  console.log(`\n    fence: ${fence.blocked.length} outbound call(s) blocked in total${fence.blocked.length ? ` (${[...new Set(fence.blocked.map((u) => { try { return new URL(u).host; } catch { return u.slice(0, 40); } }))].join(", ")})` : ""}; ${quiet.count} Prisma error line(s) quietened; socket patch ${JSON.stringify(server.patchStats)}`);
  c.summary();
  quiet.restore();
  removeBaseCopies(base.dir);
  await stop();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    fence.restore();
    process.exit(process.exitCode ?? 0);
  });
