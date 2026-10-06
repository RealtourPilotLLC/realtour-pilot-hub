// ---------------------------------------------------------------------------
// BATCH 4 · DELIVERY — the drill (unified handoff, Sep 25 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/b4-delivery.ts
//
// Isolated PGlite (scripts/_drill/_harness.ts), clock pinned to Fri Sep 25
// 2026 10:00 ET, every outbound call fenced. Dropbox and Topaz are scripted at
// their module boundary; the Dropbox temporary link and the review-cut store
// answer canned bytes at the fence. Nothing reaches a provider and nothing is
// sent to anybody.
//
// Where the OLD behaviour is observable it is shown first, from the modules as
// they stood at fa9a2c9 (git show, their `@/` imports aimed at this tree):
//
//   S1  9.6b  the portal hands a program client the verified 1080p render —
//             never the editor's export while the pass runs or is HELD
//   S2  9.6b  a program video's render makes no Aryeo-upload card and no DM;
//             the ready card owns it until its file exists; stale cards close
//   S3  9.2   Mark as sent records how the client was told; "not yet" keeps a
//             row on the card; the hub's accepted delivery text is evidence;
//             the evidence ladder never says delivered without evidence
//   S4  A42   approval publishes to the client's ACTUAL library; a failed
//             rebuild is recorded, surfaced, and repaired by the hourly step
//   S5  A43   no store URL reaches a client page or payload
//   S6  9.8   a moved file is never served off a stale cached link
//   S7  legacy identity: the probe's dispositions and the board's row
//   S8  9.3   the webhook-health probe reads what the hub recorded
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { MediaScope } from "@/lib/portalMedia";

const PORT = Number(process.env.DRILL_PORT ?? 5716);
const BASE = "fa9a2c9"; // the commit this batch starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ------------------------------------------------------------
const RealDate = Date;
let SIM = RealDate.parse("2026-09-25T10:00:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;
const advanceMinutes = (n: number) => { SIM += n * 60_000; };

installNextStubs();

// ---- the fence: canned bytes for the two stores, Slack recorded, rest blocked
const BLOB_HOST = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;
const DBX_TMP = "https://dbx.invalid/tmp";
/** A Dropbox temporary link as a redirect carries it (NextResponse encodes it). */
const tmpLink = (p: string) => new URL(`${DBX_TMP}${p}`).href;
const fetched: string[] = [];
const slackPosts: string[] = [];
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  // THE REAL dbx() for callers that import it dynamically (the stream route):
  // Node's ESM loader builds a dynamic import()'s namespace from the module's
  // own exports, so the module-boundary wrapper below never reaches them. The
  // same in-memory tree answers at Dropbox's own URLs instead.
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-access-not-real" });
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const ep = url.slice("https://api.dropboxapi.com/2/".length);
    const arg = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    dbxLog.push({ ep, arg });
    if (ep === "users/get_current_account") return json({ root_info: {} });
    if (ep === "files/get_temporary_link") {
      const p = String(arg.path ?? "");
      return FS.has(p) ? json({ link: `${DBX_TMP}${p}`, metadata: {} }) : json({ error_summary: "path/not_found/.." }, 409);
    }
    return json({ error_summary: `drill: unscripted ${ep}` }, 400);
  }
  if (BLOB_HOST.test(url)) { fetched.push(url); return new Response("EDITORBYTES", { status: 200, headers: { "content-type": "video/mp4", "content-length": "11" } }); }
  if (url.startsWith(DBX_TMP)) { fetched.push(url); return new Response("RENDERBYTES!", { status: 200, headers: { "content-type": "video/mp4", "content-length": "12" } }); }
  if (url.startsWith("https://slack.com/api/")) {
    slackPosts.push(typeof init?.body === "string" ? init.body : "");
    return new Response(JSON.stringify({ ok: true, ts: "1.1", channels: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return null;
});

// ---- the module boundary ---------------------------------------------------
const isMod = (r: string, tail: string) => r === `@/lib/${tail}` || r.endsWith(`/src/lib/${tail}`) || r.endsWith(`/src/lib/${tail}.ts`);
const wrapOnce = <T extends object>(make: (m: T) => T) => {
  const cache = new WeakMap<object, T>();
  return (loaded: unknown) => {
    const m = loaded as T;
    if (!cache.has(m)) cache.set(m, make(m));
    return cache.get(m);
  };
};

// A scripted Topaz: the render is always finished and reads as a good 1080p file.
type Meta = { width: number; height: number; frameRate: number; frameCount: number; durationSec: number; container: string; codec: string; sizeBytes: number; audio: { present: boolean; codec: string | null } };
const meta = (o: { w?: number; h?: number } = {}): Meta => ({ width: o.w ?? 1920, height: o.h ?? 1080, frameRate: 30, frameCount: 1800, durationSec: 60, container: "mp4", codec: "avc1", sizeBytes: 40_000_000, audio: { present: true, codec: "mp4a" } });
const topazOut = (requestId: string) => `https://topaz.invalid/out/${requestId}.mp4`;
const PROBE = new Map<string, Meta>();
const spend = { accept: 0, complete: 0 };
interceptModule(
  (r) => isMod(r, "integrations/topaz"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      const E = t.TopazError as new (msg: string, status: number, retryable: boolean) => Error;
      switch (k) {
        case "topazConnected": return async () => true;
        case "topazBalance": return async () => ({ available_credits: 400, reserved_credits: 0, total_credits: 400 });
        case "videoStatus": return async (id: string) => ({ status: "complete", downloadUrl: topazOut(id), credits: 27, progress: 100, message: null, raw: {} });
        case "probeVideoMetadata":
          return async (url: string) => {
            const a = PROBE.get(url);
            if (!a) throw new E("Couldn't read the video file (503).", 503, true);
            return a;
          };
        case "acceptVideoRequest": return async () => { spend.accept++; return []; };
        case "completeUpload": return async () => { spend.complete++; };
        case "deleteVideoFiles": return async () => true;
        default: return t[k];
      }
    },
  })),
);

// A scripted Dropbox: an in-memory tree with Dropbox's own answers.
const FS = new Map<string, number>();
const dbxLog: { ep: string; arg: Record<string, unknown> }[] = [];
interceptModule(
  (r) => isMod(r, "integrations/dropbox"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      const DErr = t.DropboxError as new (msg: string, status?: number) => Error;
      if (k === "dropboxConfigured") return () => true;
      if (k !== "dbx") return t[k];
      return async (ep: string, arg: Record<string, unknown> = {}) => {
        dbxLog.push({ ep, arg });
        const p = String(arg.path ?? "");
        switch (ep) {
          case "files/create_folder_v2": return { metadata: { path_display: p } };
          case "files/save_url":
            if (FS.has(p)) throw new DErr("path/conflict/file/", 409);
            FS.set(p, 40_000_000);
            return { ".tag": "complete" };
          case "files/save_url/check_job_status": return { ".tag": "complete" };
          case "files/get_metadata": {
            if (!FS.has(p)) throw new DErr("path/not_found/", 409);
            // Dropbox's own answer for a file (Oct 2: a portal publication
            // proves the exact Final-folder bytes off id/rev/content_hash).
            const hash = createHash("sha256").update(`${p}:${FS.get(p)}`).digest("hex");
            return { ".tag": "file", id: `id:${hash.slice(0, 16)}`, rev: hash.slice(0, 12), content_hash: hash, size: FS.get(p), path_display: p };
          }
          case "files/get_temporary_link":
            if (!FS.has(p)) throw new DErr("path/not_found/", 409);
            return { link: `${DBX_TMP}${p}` };
          case "files/move_v2": {
            const from = String(arg.from_path);
            let to = String(arg.to_path);
            if (!FS.has(from)) throw new DErr("from_lookup/not_found/", 409);
            if (FS.has(to)) {
              if (!arg.autorename) throw new DErr("to/conflict/file/", 409);
              to = to.replace(/(\.[^./]+)?$/, (ext) => ` (1)${ext ?? ""}`);
            }
            FS.set(to, FS.get(from)!);
            FS.delete(from);
            return { metadata: { path_display: to } };
          }
          default: throw new DErr(`drill: unscripted dropbox endpoint ${ep}`, 400);
        }
      };
    },
  })),
);

// The 1080p lane switched on (it defaults off); every other setting is the app's own.
interceptModule(
  (r) => isMod(r, "settings"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      if (k !== "topazSettings") return t[k];
      return async () => ({ ...(await (t.topazSettings as () => Promise<Record<string, unknown>>)()), enabled: true });
    },
  })),
);

/** Modules as they stood at BASE, byte for byte, `@/` imports aimed at this tree. */
function writeBaseCopies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b4-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const put = (name: string, f: string) => { const out = path.join(dir, name); fs.writeFileSync(out, point(show(f))); return out; };
  return {
    dir,
    stream: put("stream.base.ts", "src/app/api/review/cut/[id]/stream/route.ts"),
    ready: put("readyToSend.base.ts", "src/lib/readyToSend.ts"),
    videos: put("contentVideos.base.ts", "src/lib/contentVideos.ts"),
    topaz: put("topazJobs.base.ts", "src/lib/topazJobs.ts"),
  };
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { SLACK_ALERT_CHANNEL: "C-DRILL-OPS" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { buildContentMonth } = await import("./_fixtures/contentMonth");
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("slack", "xoxb-drill-not-a-real-token");
  // A stand-in refresh token so the real dbx() reaches the fenced Dropbox above.
  await saveSecret("dropbox", "drill-refresh-not-real");
  const ce = await import("@/lib/cutEntitlement");
  const cv = await import("@/lib/contentVideos");
  const pk = await import("@/lib/postingKit");
  const rts = await import("@/lib/readyToSend");
  const tj = await import("@/lib/topazJobs");
  const dout = await import("@/lib/deliverableOutputs");
  const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
  const { mediaToken } = await import("@/lib/portalMedia");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { NextRequest } = await import("next/server");
  const streamRoute = await import("@/app/api/review/cut/[id]/stream/route");
  const downloadRoute = await import("@/app/api/portal/download/[videoId]/route");
  const base = writeBaseCopies();
  const oldStream = (await import(base.stream)) as typeof streamRoute;
  const oldReady = (await import(base.ready)) as { markVideoSent: (id: string, by: string | null, opts?: unknown) => Promise<{ ok: boolean }>; readyToSend: typeof rts.readyToSend };
  const oldVideos = (await import(base.videos)) as { portalVideoList: typeof cv.portalVideoList };
  const oldTopaz = (await import(base.topaz)) as { advanceTopazJob: (id: string) => Promise<string> };

  c.head("0 · the harness");
  c.ok("the app is pointed at the isolated database", (process.env.DATABASE_URL ?? "").includes("127.0.0.1"));
  c.ok("the clock reads Fri Sep 25 10:00 ET", new Date().toISOString() === "2026-09-25T14:00:00.000Z", new Date().toISOString());

  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "ADMIN" }, select: { id: true } });
  const owner = await prisma.appUser.create({ data: { email: "jordan@drill.invalid", name: "Jordan", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
  const staff: MediaScope = { kind: "staff", id: owner.id };

  // ---- helpers -------------------------------------------------------------
  const BLOB = (id: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${id}.mp4`;
  async function mkCut(o: { projectId: string; deliverableId: string | null; slot?: number; round: number; fileName: string; status?: string; blob?: boolean; assetPath?: string | null; finalPath?: string | null; decidedAt?: Date }): Promise<string> {
    const row = await prisma.reviewSubmission.create({
      data: {
        projectId: o.projectId, deliverableId: o.deliverableId, slot: o.slot ?? 1, round: o.round, fileName: o.fileName, status: o.status ?? "APPROVED", source: "upload",
        decidedBy: "James", decidedAt: o.decidedAt ?? new Date(Date.now() - 3_600_000), completedAt: new Date(Date.now() - 3_600_000), sizeBytes: 11,
        assetPath: o.assetPath ?? null, finalPath: o.finalPath === undefined ? null : o.finalPath,
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), ...(o.blob === false ? {} : { blobUrl: BLOB(row.id), blobPathname: `review-cuts/${row.id}.mp4` }) } });
    // Every real video slot has its per-video row (sweepOutputUnits mints it),
    // and since Oct 2 a delivery claim checks this exact version against it.
    if (o.deliverableId) await ensureOutput(o.projectId, o.deliverableId, o.slot ?? 1);
    return row.id;
  }
  async function ensureOutput(projectId: string, deliverableId: string, slot: number) {
    await prisma.deliverableOutput.upsert({ where: { deliverableId_slot: { deliverableId, slot } }, update: {}, create: { projectId, deliverableId, slot, category: "VIDEO" } });
  }
  /** Kyle's two presses since Oct 2: Mark as Uploaded for this exact file, then Mark as sent. */
  async function kyleSends(id: string, by: string, opts?: Parameters<typeof rts.markVideoSent>[2]) {
    const { recordUploaded } = await import("@/lib/deliveryUploads");
    const { loadCut, sourceFingerprint } = await import("@/lib/finalRendition");
    const up = await recordUploaded(id, { id: null, name: by }, sourceFingerprint((await loadCut(id))!)!);
    if (!up.ok) throw new Error(`fixture upload refused: ${up.message}`);
    return rts.markVideoSent(id, by, opts);
  }
  const route = (r: typeof streamRoute, id: string, q: string) => r.GET(new NextRequest(`http://127.0.0.1${streamUrlFor(id)}?${q}`), { params: Promise.resolve({ id }) });
  const asClient = (id: string, scope: MediaScope, dl = false) => `m=${encodeURIComponent(mediaToken(id, scope))}${dl ? "&dl=1" : ""}`;
  const body = async (r: Response) => (r.status === 200 || r.status === 206 ? await r.text() : ((await r.clone().json().catch(() => ({}))) as { error?: string }).error ?? "");
  const door = (videoId: string, scope: MediaScope) =>
    downloadRoute.GET(new NextRequest(`http://127.0.0.1/api/portal/download/${videoId}?m=${encodeURIComponent(mediaToken(videoId, scope))}`), { params: Promise.resolve({ videoId }) });
  const mkJob = (projectId: string, submissionId: string, data: Record<string, unknown>) =>
    prisma.topazJob.create({ data: { projectId, submissionId, ...data }, select: { id: true } });

  // =========================================================================
  // S1 · 9.6b — WHICH BYTES A PROGRAM CLIENT GETS
  // =========================================================================
  const ada = await buildContentMonth(prisma as unknown as PrismaClient, {
    name: "Ada Vance TEST", package: "Accelerator", monthKey: "2026-09",
    project: { status: "SCHEDULED", shootDate: new Date("2026-09-10T14:00:00Z") },
    owner: { email: "ada@example.com", name: "Ada Vance" },
  });
  const adaEnrollment = { id: ada.enrollmentId, clientId: ada.clientId };
  const seat: MediaScope = { kind: "membership", id: ada.membershipId! };
  const link: MediaScope = { kind: "enrollment", id: ada.enrollmentId };
  const adaFolder = `/Content/Drill/Ada`;
  await prisma.project.update({ where: { id: ada.projectId! }, data: { dropboxFolder: adaFolder } });
  const adaFinal = actualFolderPaths({ dropboxFolder: adaFolder } as Parameters<typeof actualFolderPaths>[0]).finalVideo;

  /** Ada, signed in on her own seat — the portal's viewer. */
  const adaViewer = { enrollment: { id: ada.enrollmentId, clientId: ada.clientId, clientName: ada.clientName, status: "ACTIVE", videosPerMonth: ada.videosPerMonth, sessionsPerMonth: ada.sessionsPerMonth }, actor: { kind: "CLIENT", clientUserId: ada.clientUserId!, email: "ada@example.com", name: "Ada Vance", membershipId: ada.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as unknown as Parameters<typeof import("@/lib/clientDecisions").cutHistory>[0];

  c.head("S1a · approved, 1080p pass QUEUED — OLD played the editor's export; NEW: being finished");
  const a1 = await mkCut({ projectId: ada.projectId!, deliverableId: ada.deliverableId!, slot: 1, round: 1, fileName: "Ada first weekend v1.mov" });
  const a1Job = await mkJob(ada.projectId!, a1, { state: "queued" });
  await cv.syncEnrollmentVideos(adaEnrollment);
  const a1Video = await prisma.contentVideo.findFirstOrThrow({ where: { currentSubmissionId: a1 } });
  {
    const old = await route(oldStream, a1, asClient(a1, seat));
    c.ok("OLD: the client's player got the editor's export while the pass was queued", old.status === 200 && (await body(old)) === "EDITORBYTES", `${old.status}`);
    const oldList = (await oldVideos.portalVideoList(adaEnrollment, { perPage: 60 })).rows.find((r) => r.id === a1Video.id);
    c.ok("OLD: the library asked the client to review it", oldList?.state === "FOR_REVIEW", oldList?.state);

    const res = await route(streamRoute, a1, asClient(a1, seat));
    c.ok("NEW: the client's stream is refused (409) — nothing plays in its place", res.status === 409, `${res.status}`);
    c.ok("  …in plain words, no dash", (await body(res)) === ce.WHY.FINISHING && !/[—–]/.test(ce.WHY.FINISHING), ce.WHY.FINISHING);
    const dl = await route(streamRoute, a1, asClient(a1, link, true));
    c.ok("NEW: the share-link download is refused too", dl.status === 409, `${dl.status}`);
    const staffPlay = await route(streamRoute, a1, asClient(a1, staff));
    c.ok("staff (a staff media token) still play the approved original", staffPlay.status === 200 && (await body(staffPlay)) === "EDITORBYTES");
    const reviewRoom = await route(streamRoute, a1, "x=1");
    c.ok("the Review Room (hub session) still plays it", reviewRoom.status === 200 && (await body(reviewRoom)) === "EDITORBYTES");
    const row = (await cv.portalVideoList(adaEnrollment, { perPage: 60 })).rows.find((r) => r.id === a1Video.id);
    c.ok("NEW: the library reads it as still being made (IN_PRODUCTION), not waiting on the client", row?.state === "IN_PRODUCTION" && row.needsDecision === false, row?.state);
    const att = await cv.libraryAttention(adaEnrollment);
    c.ok("Home's 'waiting on you' does not count it", att.needReview === 0, JSON.stringify(att));
    c.ok("videoState agrees with the list", (await cv.videoState(ada.enrollmentId, a1Video)) === "IN_PRODUCTION");
  }

  c.head("S1b · the client approved while it was finishing — the download waits for the render");
  {
    const a1row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: a1 } });
    await prisma.clientDecision.create({
      data: { submissionId: a1, projectId: ada.projectId!, videoId: a1Video.id, enrollmentId: ada.enrollmentId, clientId: ada.clientId, round: 1, contentHash: ce.stableCutIdentity(a1row), decision: "APPROVE", actorLabel: "Ada Vance", clientUserId: ada.clientUserId, membershipRole: "OWNER", receiptState: "DONE" },
    });
    const e = await ce.videoEntitlement(a1Video);
    c.ok("entitlement: no file, blocked FINISHING, the plain-words reason", !e.file && e.blockedBy === "FINISHING" && e.why === ce.WHY.FINISHING, `${e.basis}/${e.blockedBy}`);
    const d = await door(a1Video.id, seat);
    c.ok("the download door answers 'no file yet' (404) with that reason", d.status === 404 && (await body(d)) === ce.WHY.FINISHING, `${d.status}`);
    await prisma.topazJob.update({ where: { id: a1Job.id }, data: { state: "held", heldPath: `${adaFinal}/unverified/x.mp4`, heldAt: new Date(), outputCheck: "unverified" } });
    const held = await route(streamRoute, a1, asClient(a1, seat));
    c.ok("HELD (sound unverified) is still 'being finished' for the client", held.status === 409);
    c.ok("  …and still no download", !(await ce.videoEntitlement(a1Video)).file);
    // (review, Sep 25) Opening the page of a video still being finished is not
    // SEEING it: the view stamp used to clear the review window's NEVER_SEEN
    // hold, so an automatic approval could stand on a video the client never
    // could play.
    const { cutHistory } = await import("@/lib/clientDecisions");
    await prisma.contentReviewWindow.create({
      data: { submissionId: a1, videoKey: `${ada.projectId}:drill-a1`, projectId: ada.projectId!, enrollmentId: ada.enrollmentId, clientId: ada.clientId, round: 1, openedAt: new Date(), deadlineAt: new Date(Date.now() + 4 * 86_400_000) },
    });
    await cutHistory(adaViewer, a1);
    c.ok("opening a video still being finished does not stamp firstViewedAt (the NEVER_SEEN hold stands)", !(await prisma.contentReviewWindow.findUniqueOrThrow({ where: { submissionId: a1 } })).firstViewedAt);
    // A reviewer releases the held PROGRAM render: the message says where it
    // goes. It used to say "Kyle has the upload card" — a card a program video
    // never gets.
    const { HELD_ATTESTATION } = await import("@/lib/topazHold");
    FS.set(`${adaFinal}/unverified/x.mp4`, 40_000_000);
    const released = await tj.resolveHeldTopazJob(a1Job.id, "accept-processed", "James", { attest: HELD_ATTESTATION });
    c.ok("releasing a held program render names the client's portal (or the Ready-to-send card), not an upload card",
      released.ok && /client's portal/.test(released.message) && /Ready-to-send card/.test(released.message) && !/upload card/.test(released.message), released.message);
    c.ok("  …and no upload card was made for it", (await prisma.smartTask.count({ where: { dedupeKey: `topaz-deliver-${a1Job.id}` } })) === 0);
  }

  c.head("S1c · the render is DONE and verified — the client plays and downloads IT");
  const renderPath = `${adaFinal}/Ada first weekend - v1 - FINAL (Topaz).mp4`;
  FS.set(renderPath, 40_000_000);
  await prisma.topazJob.update({ where: { id: a1Job.id }, data: { state: "done", heldPath: null, finalPath: renderPath, savedAt: new Date(), outputCheck: "verified" } });
  {
    const oldPlay = await route(oldStream, a1, asClient(a1, seat));
    c.ok("OLD: even with the render filed, the client still got the editor's export", oldPlay.status === 200 && (await body(oldPlay)) === "EDITORBYTES");
    const play = await route(streamRoute, a1, asClient(a1, seat));
    // Moved to the review's law (Sep 25): this used to be a 302 to the Dropbox
    // temporary link — a credential-free URL to the whole render for ~4 hours,
    // minted even before the client decided, that side-stepped the dl=1 check.
    c.ok("NEW playback: the RENDER's bytes, relayed through the hub — no Dropbox link handed to the browser",
      play.status === 200 && (await body(play)) === "RENDERBYTES!" && !play.headers.get("location") && fetched.some((u) => u === `${DBX_TMP}${renderPath}` || u === tmpLink(renderPath)),
      play.headers.get("location") ?? `${play.status}`);
    c.ok("  …inline (it plays), under the video's own name, private and no-store",
      (play.headers.get("content-disposition") ?? "").startsWith("inline") && (play.headers.get("content-disposition") ?? "").includes("Ada first weekend v1.mp4") && (play.headers.get("cache-control") ?? "").includes("no-store"),
      `${play.headers.get("content-disposition")} · ${play.headers.get("cache-control")}`);
    // Before the client decides: the same render plays (relayed), but saving it
    // still needs the release rule's yes — there is no Location to lift it from.
    const undecided = await mkCut({ projectId: ada.projectId!, deliverableId: ada.deliverableId!, slot: 4, round: 1, fileName: "Ada undecided v1.mov" });
    const undecidedPath = `${adaFinal}/Ada undecided - v1 - FINAL (Topaz).mp4`;
    FS.set(undecidedPath, 40_000_000);
    await mkJob(ada.projectId!, undecided, { state: "done", finalPath: undecidedPath, savedAt: new Date(), outputCheck: "verified" });
    await prisma.reviewSubmission.update({ where: { id: undecided }, data: { clientReleasedAt: new Date() } });
    const uPlay = await route(streamRoute, undecided, asClient(undecided, seat));
    const uSave = await route(streamRoute, undecided, asClient(undecided, seat, true));
    c.ok("an undecided render plays relayed, with no link to lift, and its dl=1 is still refused (403)",
      uPlay.status === 200 && !uPlay.headers.get("location") && uSave.status === 403, `${uPlay.status} ${uPlay.headers.get("location") ?? ""} / ${uSave.status}`);
    const e = await ce.videoEntitlement(a1Video);
    c.ok("entitlement: CLIENT_APPROVED, the file carries the render", e.basis === "CLIENT_APPROVED" && e.file?.processed?.path === renderPath, JSON.stringify(e.file?.processed ?? null));
    c.ok("  …under the video's own name, not 'FINAL (Topaz)'", e.file?.fileName === "Ada first weekend v1.mp4", e.file?.fileName ?? "");
    const d = await door(a1Video.id, seat);
    c.ok("the door still names the cut's own stream route with dl=1 (one door for the bytes)", d.status === 302 && (d.headers.get("location") ?? "").includes(`/api/review/cut/${a1}/stream?m=`) && (d.headers.get("location") ?? "").includes("dl=1"), d.headers.get("location") ?? "");
    const dl = await route(streamRoute, a1, asClient(a1, seat, true));
    c.ok("dl=1: the render's bytes, relayed through the hub", dl.status === 200 && (await dl.clone().text()) === "RENDERBYTES!", `${dl.status}`);
    c.ok("  …as an attachment named for the video", (dl.headers.get("content-disposition") ?? "") === 'attachment; filename="Ada first weekend v1.mp4"', dl.headers.get("content-disposition") ?? "");
    c.ok("  …and no store address leaves the building (private, no-store)", (dl.headers.get("cache-control") ?? "").includes("no-store"));
    const staffPlay = await route(streamRoute, a1, asClient(a1, staff));
    c.ok("staff still get the approved original they reviewed", staffPlay.status === 200 && (await body(staffPlay)) === "EDITORBYTES");
    const { cutHistory } = await import("@/lib/clientDecisions");
    await cutHistory(adaViewer, a1);
    c.ok("(review) once the render plays, opening it IS seeing it: firstViewedAt is stamped", !!(await prisma.contentReviewWindow.findUniqueOrThrow({ where: { submissionId: a1 } })).firstViewedAt);
    // S3d writes its own window for this cut and reads the evidence ladder
    // without one first; this section's window goes so the two never mix.
    await prisma.contentReviewWindow.delete({ where: { submissionId: a1 } });
    const kit = await pk.postingKitFor(adaViewer as Parameters<typeof pk.postingKitFor>[0], a1Video);
    c.ok("posting kit: a redirect-class download of the render, under its client name", kit.download?.mode === "redirect" && kit.download.fileName === "Ada first weekend v1.mp4" && kit.access.download, JSON.stringify(kit.download));
    c.ok("the approved original is intact (the cut row still names the editor's bytes)", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: a1 } })).blobUrl === BLOB(a1));
  }

  c.head("S1d · the files that stay the editor's: no check on record, a failed pass, keep-the-original");
  {
    await prisma.topazJob.update({ where: { id: a1Job.id }, data: { outputCheck: null } });
    const legacy = await route(streamRoute, a1, asClient(a1, seat));
    c.ok("a 'done' render from before the check was recorded: the editor's export, as before", legacy.status === 200 && (await body(legacy)) === "EDITORBYTES");
    await prisma.topazJob.update({ where: { id: a1Job.id }, data: { state: "failed", outputCheck: "resolved-original", finalPath: null, savedAt: null } });
    const kept = await route(streamRoute, a1, asClient(a1, seat, true));
    c.ok("a reviewer kept the original: the client downloads the editor's export", kept.status === 200 && (await body(kept)) === "EDITORBYTES", `${kept.status}`);
    const map = await ce.clientCutFiles([a1]);
    c.ok("clientCutFiles says 'original'", map.get(a1)?.kind === "original");
    // A cut the client already has by hand (Kyle marked it sent) keeps playing
    // while a later pass — a "Try again" — runs: the hold is for portal deliveries.
    const handed = await mkCut({ projectId: ada.projectId!, deliverableId: ada.deliverableId!, slot: 2, round: 1, fileName: "Ada handed over v1.mp4" });
    await prisma.reviewSubmission.update({ where: { id: handed }, data: { sentToClientAt: new Date(Date.now() - 86_400_000), sentToClientBy: "Kyle" } });
    await mkJob(ada.projectId!, handed, { state: "queued" });
    const replay = await route(streamRoute, handed, asClient(handed, seat));
    c.ok("a video already sent by hand still plays while a re-run pass is queued", replay.status === 200 && (await body(replay)) === "EDITORBYTES" && (await ce.clientCutFiles([handed])).get(handed)?.kind === "original", `${replay.status}`);
    // (review, Sep 25) …and so does one the PORTAL itself gave them: the pass
    // failed, the client was served the editor's export, approved it and had
    // it. A "Try again" used to take it back off their page ("being finished",
    // the door 404, the player 409) — for good if the re-run ended HELD.
    const { recordClientApproval } = await import("@/lib/clientDecisions");
    const portalHad = await mkCut({ projectId: ada.projectId!, deliverableId: ada.deliverableId!, slot: 3, round: 1, fileName: "Ada portal had v1.mov" });
    await prisma.reviewSubmission.update({ where: { id: portalHad }, data: { clientReleasedAt: new Date() } });
    const phJob = await mkJob(ada.projectId!, portalHad, { state: "failed", error: "drill: Topaz refused", finishedAt: new Date() });
    await cv.syncEnrollmentVideos(adaEnrollment);
    const phVideo = await prisma.contentVideo.findFirstOrThrow({ where: { currentSubmissionId: portalHad } });
    c.ok("(the failed pass: the client is served the editor's export)", (await ce.clientCutFiles([portalHad])).get(portalHad)?.kind === "original");
    const phRow = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: portalHad } });
    const appr = await recordClientApproval({
      enrollmentId: ada.enrollmentId, clientId: ada.clientId,
      cut: { id: portalHad, projectId: ada.projectId!, round: 1, videoId: phVideo.id, contentHash: phRow.contentHash, sizeBytes: phRow.sizeBytes, fileName: phRow.fileName },
      actor: { clientUserId: ada.clientUserId!, staffUserId: null, actorLabel: "Ada Vance", membershipRole: "OWNER", resolvedByKind: "CLIENT" },
      basis: "CLIENT",
    });
    const beforeRetry = await door(phVideo.id, seat);
    c.ok("(the client approves it in the portal and the door hands it over)", appr.ok && beforeRetry.status === 302, `${JSON.stringify(appr).slice(0, 80)} · ${beforeRetry.status}`);
    const retried = await tj.retryTopazJob(phJob.id);
    const afterRetry = await route(streamRoute, portalHad, asClient(portalHad, seat));
    const eRetry = await ce.videoEntitlement(await prisma.contentVideo.findUniqueOrThrow({ where: { id: phVideo.id } }));
    c.ok("'Try again' re-queues the pass — and the client KEEPS the video they approved: plays, downloads, entitled",
      retried.ok && afterRetry.status === 200 && (await body(afterRetry)) === "EDITORBYTES" && (await door(phVideo.id, seat)).status === 302 && eRetry.basis === "CLIENT_APPROVED" && !!eRetry.file,
      `${retried.message} · ${afterRetry.status} · ${eRetry.basis}/${eRetry.blockedBy}`);
    await prisma.topazJob.update({ where: { id: phJob.id }, data: { state: "held", heldPath: `${adaFinal}/unverified/ph.mp4`, heldAt: new Date(), outputCheck: "unverified" } });
    c.ok("…the re-run ends HELD: still theirs, not withdrawn while someone listens", (await route(streamRoute, portalHad, asClient(portalHad, seat))).status === 200 && (await ce.clientCutFiles([portalHad])).get(portalHad)?.kind === "original");
    const phPath = `${adaFinal}/Ada portal had - v1 - FINAL (Topaz).mp4`;
    FS.set(phPath, 40_000_000);
    await prisma.topazJob.update({ where: { id: phJob.id }, data: { state: "done", heldPath: null, finalPath: phPath, savedAt: new Date(), outputCheck: "resolved-processed" } });
    const phDone = await route(streamRoute, portalHad, asClient(portalHad, seat));
    c.ok("…and once the render is verified, THAT is what they get", phDone.status === 200 && (await body(phDone)) === "RENDERBYTES!" && (await ce.clientCutFiles([portalHad])).get(portalHad)?.kind === "processed", `${phDone.status}`);
    // back to verified for the sections below
    await prisma.topazJob.update({ where: { id: a1Job.id }, data: { state: "done", outputCheck: "verified", finalPath: renderPath, savedAt: new Date() } });
  }

  c.head("S1e · a replacement v2 still finishing — the approved v1 stays theirs");
  const a2 = await mkCut({ projectId: ada.projectId!, deliverableId: ada.deliverableId!, slot: 1, round: 2, fileName: "Ada first weekend v2.mov", decidedAt: new Date(Date.now() - 600_000) });
  await mkJob(ada.projectId!, a2, { state: "processing" });
  await cv.syncEnrollmentVideos(adaEnrollment);
  {
    const v = await prisma.contentVideo.findUniqueOrThrow({ where: { id: a1Video.id } });
    const e = await ce.videoEntitlement(v);
    c.ok("v2 is the current round; v1 (approved, rendered) is still the file", e.current?.submissionId === a2 && e.priorVersion === true && e.file?.submissionId === a1 && !!e.file.processed, `${e.current?.submissionId === a2} ${e.priorVersion} ${e.file?.submissionId === a1}`);
    const v2Play = await route(streamRoute, a2, asClient(a2, seat));
    c.ok("v2 itself does not play for the client yet", v2Play.status === 409);
    const row = (await cv.portalVideoList(adaEnrollment, { perPage: 60 })).rows.find((r) => r.id === a1Video.id);
    c.ok("the library reads the video as being made, not 'for review'", row?.state === "IN_PRODUCTION", row?.state);
  }

  c.head("S1f · listing work is untouched");
  const listingClient = await prisma.client.create({ data: { name: "Listing Agent TEST" }, select: { id: true } });
  const lp = await prisma.project.create({ data: { title: "12 Listing Ln, Media, PA", clientId: listingClient.id, status: "REVIEW", aryeoListingId: "lst-b4-1" }, select: { id: true } });
  const ld = await prisma.deliverable.create({ data: { projectId: lp.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
  const l1 = await mkCut({ projectId: lp.id, deliverableId: ld.id, round: 1, fileName: "12 Listing Ln tour.mp4" });
  await mkJob(lp.id, l1, { state: "queued" });
  c.ok("clientCutFiles leaves a listing cut out entirely", !(await ce.clientCutFiles([l1])).has(l1));
  const lPlay = await route(streamRoute, l1, "x=1");
  c.ok("the Review Room still plays a listing cut with a queued pass", lPlay.status === 200);

  // =========================================================================
  // S2 · 9.6b — THE OFFICE SIDE OF A PROGRAM RENDER
  // =========================================================================
  c.head("S2a · a program render finishing: OLD made an Aryeo-upload card; NEW makes none");
  let portalReel = "";
  let oldReel = "";
  const deliverTasks = (jobId: string) => prisma.smartTask.count({ where: { dedupeKey: `topaz-deliver-${jobId}` } });
  let renderN = 0;
  async function programRender(label: string): Promise<{ jobId: string; subId: string; original: string }> {
    renderN++;
    const original = `${adaFinal}/${label} - v1.mp4`;
    FS.set(original, 90_000_000);
    const blobUrl = BLOB(`src-${renderN}`);
    PROBE.set(blobUrl, meta({ w: 3840, h: 2160 }));
    const sub = await prisma.reviewSubmission.create({
      data: {
        projectId: ada.projectId!, deliverableId: ada.deliverableId!, slot: 2 + renderN, kind: "video", round: 1, status: "APPROVED", source: "upload",
        fileName: `${label} - v1.mp4`, blobUrl, sizeBytes: 90_000_000, finalPath: original, assetUrl: null,
        completedAt: new Date(Date.now() - 3_600_000), decidedAt: new Date(Date.now() - 3_600_000), decidedBy: "James",
      },
      select: { id: true },
    });
    await ensureOutput(ada.projectId!, ada.deliverableId!, 2 + renderN);
    const requestId = `req-b4-${renderN}`;
    PROBE.set(topazOut(requestId), meta());
    const job = await mkJob(ada.projectId!, sub.id, {
      state: "processing", requestId, acceptedAt: new Date(Date.now() - 1_800_000), completeUploadAt: new Date(Date.now() - 1_500_000), startedAt: new Date(Date.now() - 1_900_000),
      sourceWidth: 3840, sourceHeight: 2160, sourceFrameRate: 30, sourceFrameCount: 1800, sourceDurationSec: 60, sourceContainer: "mp4", sourceSizeBytes: 90_000_000,
      outputWidth: 1920, outputHeight: 1080, estimateCredits: 27, sourceHasAudio: true, sourceAudioCodec: "mp4a",
    });
    return { jobId: job.id, subId: sub.id, original };
  }
  {
    const O = await programRender("Old Card Reel");
    oldReel = O.subId;
    for (let i = 0; i < 3; i++) await oldTopaz.advanceTopazJob(O.jobId);
    const ro = await prisma.topazJob.findUniqueOrThrow({ where: { id: O.jobId } });
    c.ok("OLD: the program render went done and Kyle got 'Upload the 1080p video to Aryeo'", ro.state === "done" && (await deliverTasks(O.jobId)) === 1, `${ro.state}`);
    const slackBefore = slackPosts.length;
    const N = await programRender("New Portal Reel");
    portalReel = N.subId;
    for (let i = 0; i < 3; i++) await tj.advanceTopazJob(N.jobId);
    const rn = await prisma.topazJob.findUniqueOrThrow({ where: { id: N.jobId } });
    c.ok("NEW: done and verified", rn.state === "done" && rn.outputCheck === "verified" && !!rn.finalPath, `${rn.state}/${rn.outputCheck}`);
    c.ok("NEW: no upload card", (await deliverTasks(N.jobId)) === 0 && rn.taskId === null);
    c.ok("NEW: no topaz_ready ping and no Slack DM", (await prisma.notification.count({ where: { dedupeKey: { startsWith: `topaz-ready-${N.jobId}` } } })) === 0 && slackPosts.slice(slackBefore).every((b) => !b.includes("ready to upload")), `${slackPosts.length - slackBefore} posts`);
    // Since Oct 5 (6f84e51) the line points at the cut's chosen destination
    // (portal by default, or an explicit Aryeo branding override).
    c.ok("NEW: a line on the job says where the file goes", (await prisma.activity.count({ where: { projectId: ada.projectId!, body: { contains: "Follow this cut’s selected destination" } } })) >= 1);
    c.ok("the editor's original is kept (moved to superseded/, never deleted)", [...FS.keys()].some((k) => k.includes("superseded/") && k.includes("New Portal Reel")));

    c.head("S2b · the stale cards the old code left are closed with the reason — listing cards untouched");
    const listingCard = await prisma.smartTask.create({ data: { title: "Upload the 1080p video to Aryeo — 12 Listing Ln", status: "OPEN", projectId: lp.id, dedupeKey: "topaz-deliver-listingjob1", source: "system", taskType: "internal_instruction" }, select: { id: true } });
    const r1 = await tj.closeProgramUploadCards();
    const oldCard = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `topaz-deliver-${O.jobId}` } });
    c.ok("the program video's Aryeo card is CANCELLED with the reason", oldCard.status === "CANCELLED" && /delivered through the client's portal/.test(oldCard.summary ?? ""), `${oldCard.status}`);
    c.ok("the listing card is untouched", (await prisma.smartTask.findUniqueOrThrow({ where: { id: listingCard.id } })).status === "OPEN");
    const r2 = await tj.closeProgramUploadCards();
    c.ok("idempotent: the second run closes nothing", r1.closed === 1 && r2.closed === 0, `${r1.closed}/${r2.closed}`);
  }

  c.head("S2c · the ready card: finishing rows stay; a finished render leaves only for a client who can sign in");
  {
    // Ada holds an OWNER seat on an ACTIVE program — the portal can hand her the render.
    const now = await rts.readyToSend({ projectId: ada.projectId! });
    const oldBoard = await oldReady.readyToSend({ projectId: ada.projectId! });
    // OLD is the render the old lane finished: nothing published it, so it sat
    // on the card. NEW publishes the checked render the moment it is filed
    // (Oct 2: the portal handoff is a recorded publication of the exact
    // Final-folder bytes), so it leaves on its own.
    c.ok("OLD: a program render the old lane finished was never published — it stayed unsent for Kyle to 'send'", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: oldReel } })).sentToClientAt === null && oldBoard.ready.length > 0, oldBoard.ready.map((r) => r.cutLabel).join(", "));
    c.ok("NEW: the checked render is published to the portal by itself", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: portalReel } })).sentToClientBy === "Automatic portal publication");
    c.ok("NEW: it leaves — the portal delivers the render", !now.ready.some((r) => r.submissionId === portalReel) && !now.rendering.some((r) => r.submissionId === portalReel));
    c.ok("a v2 still in its pass stays, as a rendering row (the card owns it)", now.rendering.some((r) => r.submissionId === a2));
    // A program client with no way in: the render is Kyle's to send by hand.
    const bo = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Bo Seatless TEST", package: "Starter", monthKey: "2026-09", owner: false, project: { status: "SCHEDULED", shootDate: new Date("2026-09-12T14:00:00Z") } });
    const b1 = await mkCut({ projectId: bo.projectId!, deliverableId: bo.deliverableId!, round: 1, fileName: "Bo reel v1.mp4" });
    FS.set(`/x/Bo reel - FINAL (Topaz).mp4`, 1);
    await mkJob(bo.projectId!, b1, { state: "done", finalPath: `/x/Bo reel - FINAL (Topaz).mp4`, savedAt: new Date(), outputCheck: "verified" });
    const bb = await rts.readyToSend({ projectId: bo.projectId! });
    c.ok("a client who cannot sign in: the render is a ready row with the 1080p file", bb.ready.some((r) => r.submissionId === b1 && r.file.source === "topaz-1080p"));
    c.ok("monthly ready row names the linked month without inventing a topic", bb.ready.some((r) => r.submissionId === b1 && r.monthKey === "2026-09" && r.topicTitle === null));
    const topic = await prisma.contentTopic.create({ data: { enrollmentId: bo.enrollmentId, clientId: bo.clientId, monthId: bo.monthId, title: "Bo's market update" }, select: { id: true } });
    const output = await prisma.deliverableOutput.update({ where: { deliverableId_slot: { deliverableId: bo.deliverableId!, slot: 1 } }, data: { topicId: topic.id }, select: { id: true } });
    await prisma.reviewSubmission.update({ where: { id: b1 }, data: { outputId: output.id } });
    const linked = await rts.readyToSend({ projectId: bo.projectId! });
    c.ok("monthly ready row resolves the cut's own linked topic", linked.ready.some((r) => r.submissionId === b1 && r.monthKey === "2026-09" && r.topicTitle === "Bo's market update"));
  }

  // =========================================================================
  // S3 · 9.2 — SENT, AND HOW THE CLIENT WAS TOLD
  // =========================================================================
  c.head("S3a · Mark as sent carries the notice; OLD had nowhere to put it");
  const noticeCut = async (street: string, n: number) => {
    const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId: listingClient.id, status: "REVIEW", aryeoListingId: `lst-b4-n${n}` }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
    await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: p.id, slot: 1, category: "VIDEO" } });
    const id = await mkCut({ projectId: p.id, deliverableId: d.id, round: 1, fileName: `${street} tour.mp4` });
    return { id, projectId: p.id };
  };
  {
    const o = await noticeCut("1 Old Notice Rd", 1);
    await oldReady.markVideoSent(o.id, "Kyle", { notice: "aryeo-email" });
    const or = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: o.id } });
    c.ok("OLD: sent, and no record of how the client heard", !!or.sentToClientAt && or.clientNoticeAt === null && or.clientNoticeVia === null);

    const n = await noticeCut("2 New Notice Rd", 2);
    const bad = await rts.markVideoSent(n.id, "Kyle", { notice: "carrier pigeon" as never });
    c.ok("an unknown answer is refused before anything is written", !bad.ok && !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: n.id } })).sentToClientAt, bad.message);
    const r = await kyleSends(n.id, "Kyle", { notice: "aryeo-email" });
    const nr = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: n.id } });
    c.ok("NEW: sent AND told — Aryeo's email, by Kyle, stamped now", r.ok && !!nr.sentToClientAt && nr.clientNoticeVia === "aryeo-email" && nr.clientNoticeBy === "Kyle" && nr.clientNoticeAt?.getTime() === SIM, `${nr.clientNoticeVia}/${nr.clientNoticeBy}`);
    advanceMinutes(5);
    const again = await rts.markVideoSent(n.id, "Jordan", { notice: "phone" });
    const nr2 = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: n.id } });
    c.ok("a second press keeps the first notice and the first send", again.ok && again.already === true && nr2.clientNoticeVia === "aryeo-email" && nr2.clientNoticeBy === "Kyle" && nr2.sentToClientAt?.getTime() === nr.sentToClientAt?.getTime());
    const rows = await dout.outputsForProject(n.projectId);
    c.ok("the project's video row says how they were told", /Sent to the client.*told by Aryeo's delivery email/.test(rows[0]?.detail ?? ""), rows[0]?.detail);
    // The proof pass since Oct 5: Aryeo's signed delivery, no upload receipt.
    const proof = await noticeCut("3 Proof Pass Rd", 3);
    await prisma.auditLog.create({ data: { target: "lst-b4-n3", actor: "Aryeo authenticated webhook", action: "aryeo_listing_delivery_event", detail: JSON.stringify({ listingId: "lst-b4-n3", occurredAt: new Date().toISOString() }) } });
    await rts.markVideoSent(proof.id, "Aryeo (delivery confirmed) — “Tour”, 60s on the listing", { providerConfirmed: true });
    const pr = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: proof.id } });
    c.ok("the Aryeo proof pass records the send and leaves the notice open (it cannot see the email)", !!pr.sentToClientAt && pr.clientNoticeVia === null);
    const prow = (await dout.outputsForProject(proof.projectId))[0];
    c.ok("  …and its row claims no notice", !!prow && /Sent to the client/.test(prow.detail) && !/told/.test(prow.detail), prow?.detail);
  }

  c.head("S3b · 'not told yet' keeps a row on the card until it is recorded");
  {
    const n = await noticeCut("4 Not Yet Way", 4);
    await kyleSends(n.id, "Kyle", { notice: "not-yet" });
    const nr = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: n.id } });
    c.ok("sent, notice marked not-yet with no time", !!nr.sentToClientAt && nr.clientNoticeVia === "not-yet" && nr.clientNoticeAt === null);
    const board = await rts.readyToSend({ projectId: n.projectId });
    c.ok("the card lists it under 'client not told yet' (and not as ready)", (board.notTold ?? []).some((x) => x.submissionId === n.id && x.markedBy === "Kyle") && !board.ready.some((x) => x.submissionId === n.id));
    c.ok("its video row says so", /client not told yet/.test((await dout.outputsForProject(n.projectId))[0]?.detail ?? ""));
    const rec = await rts.recordClientNotice(n.id, "Kyle", "our-text");
    const after = await rts.readyToSend({ projectId: n.projectId });
    const nr2 = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: n.id } });
    c.ok("recording 'we texted them' clears it and stamps the notice", rec.ok && !(after.notTold ?? []).some((x) => x.submissionId === n.id) && nr2.clientNoticeVia === "our-text" && !!nr2.clientNoticeAt);
    const unsent = await noticeCut("5 Unsent Ct", 5);
    const refused = await rts.recordClientNotice(unsent.id, "Kyle", "phone");
    c.ok("a notice on a video that never went out is refused", !refused.ok, refused.message);
  }

  c.head("S3c · the hub's own delivery text is evidence — only when the provider accepted it");
  {
    const t = await noticeCut("6 Texted Terrace", 6);
    await kyleSends(t.id, "Kyle");
    const later = await noticeCut("7 Failed Text Rd", 7);
    await kyleSends(later.id, "Kyle");
    advanceMinutes(30);
    const ok = await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "5555550100", projectId: t.projectId, body: "wrapped up", state: "accepted", acceptedAt: new Date(), dedupeKey: `delivery:${t.projectId}` }, select: { id: true } });
    await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "5555550101", projectId: later.projectId, body: "wrapped up", state: "failed", dedupeKey: `delivery:${later.projectId}` } });
    // A cut on the texted job sent AFTER the text: the text says nothing about it.
    const late = await mkCut({ projectId: t.projectId, deliverableId: null, round: 2, fileName: "6 Texted Terrace extra.mp4", assetPath: "/x/6 Texted Terrace extra.mp4" });
    advanceMinutes(10);
    await kyleSends(late, "Kyle");
    c.ok("(the late cut really was sent after the text)", !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: late } })).sentToClientAt);
    const s1 = await rts.stampNoticesFromDeliveryTexts();
    const tr = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: t.id } });
    c.ok("an ACCEPTED delivery text stamps the cut sent before it: hub-text, ref = the outbox row", tr.clientNoticeVia === "hub-text" && tr.clientNoticeRef === ok.id && tr.clientNoticeBy === "Delivery text", `${tr.clientNoticeVia}/${tr.clientNoticeRef}`);
    c.ok("a FAILED text stamps nothing", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: later.id } })).clientNoticeAt === null);
    c.ok("a cut sent after the text is not covered by it", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: late } })).clientNoticeAt === null);
    const s2 = await rts.stampNoticesFromDeliveryTexts();
    c.ok("idempotent: the second pass stamps nothing", s1.stamped === 1 && s2.stamped === 0, `${s1.stamped}/${s2.stamped}`);
  }

  c.head("S3d · the evidence ladder never says delivered without evidence");
  {
    const lad = await rts.deliveryEvidenceFor([a1, a2]);
    const one = lad.get(a1)!;
    c.ok("v1: approved → processed done → validated as the VERIFIED render", !!one.approved && one.processed?.state === "done" && one.validated?.how === "verified-render");
    // Since Oct 2 the verified render is published to the portal by itself, and
    // that recorded handoff IS the "sent" rung (by the publication, never a person).
    c.ok("v1: sent = the portal publication's own record, not told; opened = the client's own download start at S1c's door", one.sent?.by === "Automatic portal publication" && one.told === null && one.opened?.how === "download-started", JSON.stringify({ sent: one.sent, told: one.told, opened: one.opened }));
    const two = lad.get(a2)!;
    c.ok("v2: processing → NOT validated (nothing trusted while the pass runs)", two.processed?.state === "processing" && two.validated === null);
    const w = await prisma.contentReviewWindow.create({ data: { submissionId: a1, videoKey: `x:${a1}`, projectId: ada.projectId!, enrollmentId: ada.enrollmentId, clientId: ada.clientId, round: 1, openedAt: new Date(), deadlineAt: new Date(Date.now() + 4 * 86_400_000), clientNotifiedAt: new Date(), firstViewedAt: new Date() } });
    const lad2 = (await rts.deliveryEvidenceFor([a1])).get(a1)!;
    c.ok("a program cut's notice is its window's reminder", lad2.told?.via === "portal", JSON.stringify({ told: lad2.told?.via, opened: lad2.opened?.how }));
    await prisma.portalVisit.create({ data: { enrollmentId: ada.enrollmentId, clientUserId: ada.clientUserId, via: "LOGIN", path: `/portal/download/${a1Video.id}?cut=${a1}&done=1` } });
    await prisma.portalVisit.create({ data: { enrollmentId: ada.enrollmentId, staffUserId: owner.id, via: "STAFF", path: `/portal/download/${a1Video.id}?cut=${a2}&done=1` } });
    const lad3 = (await rts.deliveryEvidenceFor([a1, a2]));
    c.ok("a finished download outranks a started one; a STAFF download is not the client opening it", lad3.get(a1)?.opened?.how === "download-finished" && lad3.get(a2)?.opened === null, JSON.stringify({ a1: lad3.get(a1)?.opened?.how, a2: lad3.get(a2)?.opened }));
    await prisma.contentReviewWindow.delete({ where: { id: w.id } });
    const listing = (await rts.deliveryEvidenceFor([l1])).get(l1)!;
    c.ok("a listing cut with its pass queued: approved, not validated, not sent", !!listing.approved && listing.validated === null && listing.sent === null);
  }

  // =========================================================================
  // S4 · A42 — APPROVAL REACHES THE CLIENT'S ACTUAL LIBRARY
  // =========================================================================
  c.head("S4a · OLD: approval wrote a PortalVideo row and nothing put it in ContentVideo");
  const cal = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Cal Library TEST", package: "Starter", monthKey: "2026-09", project: { status: "SCHEDULED", shootDate: new Date("2026-09-14T14:00:00Z") }, owner: { email: "cal@example.com", name: "Cal" } });
  const calSourceFor = (id: string) => prisma.contentVideoSource.findUnique({ where: { kind_ref: { kind: "REVIEW_CUT", ref: id } } });
  {
    const c1 = await mkCut({ projectId: cal.projectId!, deliverableId: cal.deliverableId!, round: 1, fileName: "Cal kitchen v1.mp4" });
    // Since Oct 2 publication proves the exact client file in the job's Final
    // folder: a checked 1080p render filed there, as every portal video has.
    await prisma.project.update({ where: { id: cal.projectId! }, data: { dropboxFolder: "/Content/Drill/Cal" } });
    const calFinal = actualFolderPaths({ dropboxFolder: "/Content/Drill/Cal" } as Parameters<typeof actualFolderPaths>[0]).finalVideo;
    FS.set(`${calFinal}/Cal kitchen - FINAL (Topaz).mp4`, 40_000_000);
    await mkJob(cal.projectId!, c1, { state: "done", finalPath: `${calFinal}/Cal kitchen - FINAL (Topaz).mp4`, savedAt: new Date(), finishedAt: new Date(), outputCheck: "verified" });
    const { addApprovedCutToLibrary } = await import("@/lib/portalLibrary");
    await addApprovedCutToLibrary(c1);
    c.ok("OLD path: the secondary sub: row exists, the client's library does not have the cut", !!(await prisma.portalVideo.findUnique({ where: { externalKey: `sub:${c1}` } })) && !(await calSourceFor(c1)));
    const pub = await cv.publishApprovedCutToLibrary(c1);
    const src = await calSourceFor(c1);
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: c1 } });
    c.ok("NEW: publishApprovedCutToLibrary puts it on a live video of THIS client", pub.published && !!src && sub.videoId === src.videoId, JSON.stringify(pub));
    const v = await prisma.contentVideo.findUniqueOrThrow({ where: { id: src!.videoId } });
    c.ok("  …where the release rule still waits for the client (not downloadable)", v.enrollmentId === cal.enrollmentId && (await ce.videoEntitlement(v)).blockedBy === "AWAITING_DECISION");
    c.ok("a listing job is not a program's library write", !(await cv.publishApprovedCutToLibrary(l1)).published);
  }

  c.head("S4b · a rebuild that fails is recorded, surfaced, and repaired within the hour");
  {
    const c2 = await mkCut({ projectId: cal.projectId!, deliverableId: cal.deliverableId!, slot: 2, round: 1, fileName: "Cal porch v1.mp4" });
    const boardBefore = await opsExceptionsBoard();
    c.ok("the board had no library row before", !boardBefore.rows.some((r) => r.kind === "library-missing"));
    // A fault only the rebuild meets: its library read (PortalVideo) fails.
    await prisma.$executeRawUnsafe(`ALTER TABLE "PortalVideo" RENAME TO "PortalVideo_off"`);
    const pub = await cv.publishApprovedCutToLibrary(c2).catch((e: unknown) => ({ published: false, why: String(e) }));
    await prisma.$executeRawUnsafe(`ALTER TABLE "PortalVideo_off" RENAME TO "PortalVideo"`);
    c.ok("the approval-time publish did not throw, and says it did not publish", pub.published === false, JSON.stringify(pub));
    const e1 = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: cal.enrollmentId } });
    c.ok("…the failure is written on the enrollment, with the error", !!e1.librarySyncFailedAt && /library rebuild failed/i.test(e1.librarySyncError ?? ""), e1.librarySyncError ?? "");
    c.ok("…and the cut is not on the library", !(await calSourceFor(c2)));
    const board = await opsExceptionsBoard();
    const row = board.rows.find((r) => r.id === `library:${cal.enrollmentId}`);
    c.ok("exceptions board: a 'library-missing' row named for the client, owned by Kyle, with the next action", !!row && row.title === "Cal Library TEST" && row.owner === "Kyle" && /retries every hour/.test(row.nextAction) && row.href.includes(cal.enrollmentId), row ? `${row.title} · ${row.owner} · ${row.nextAction}` : "none");
    c.ok("  …counted in the totals", board.totals["library-missing"].all === 1);
    const tick1 = await cv.verifyApprovedCutsInLibrary();
    const e2 = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: cal.enrollmentId } });
    c.ok("the hourly repair rebuilds it: the cut is on the library, the failure cleared", !!(await calSourceFor(c2)) && e2.librarySyncFailedAt === null && tick1.repaired >= 1, JSON.stringify(tick1));
    c.ok("…and the board row is gone", !(await opsExceptionsBoard()).rows.some((r) => r.kind === "library-missing"));
    const videosBefore = await prisma.contentVideo.count({ where: { enrollmentId: cal.enrollmentId } });
    const tick2 = await cv.verifyApprovedCutsInLibrary();
    c.ok("a second tick over a healthy library rebuilds nothing and creates nothing", tick2.missing === 0 && tick2.enrollments === 0 && (await prisma.contentVideo.count({ where: { enrollmentId: cal.enrollmentId } })) === videosBefore, JSON.stringify(tick2));
    // The rotation's failures are recorded too, and cleared by its next good run.
    await prisma.$executeRawUnsafe(`ALTER TABLE "PortalVideo" RENAME TO "PortalVideo_off"`);
    const sweep = await cv.sweepContentVideoLibraries(50);
    await prisma.$executeRawUnsafe(`ALTER TABLE "PortalVideo_off" RENAME TO "PortalVideo"`);
    c.ok("the hourly rotation: a failed client is written down, not just counted", sweep.failed >= 1 && !!(await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: cal.enrollmentId } })).librarySyncFailedAt, JSON.stringify(sweep));
    await cv.sweepContentVideoLibraries(50);
    c.ok("…and its next good run clears it", (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: cal.enrollmentId } })).librarySyncFailedAt === null);
  }

  // =========================================================================
  // S5 · A43 — NO STORE URL REACHES A CLIENT
  // =========================================================================
  c.head("S5 · the private store stays behind the hub's own routes");
  {
    const list = await cv.portalVideoList(adaEnrollment, { perPage: 60 });
    const kit = await pk.postingKitFor({ enrollment: { id: ada.enrollmentId, clientId: ada.clientId, clientName: ada.clientName, status: "ACTIVE", videosPerMonth: ada.videosPerMonth, sessionsPerMonth: ada.sessionsPerMonth }, actor: { kind: "CLIENT", clientUserId: ada.clientUserId!, email: "ada@example.com", name: "Ada Vance", membershipId: ada.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as Parameters<typeof pk.postingKitFor>[0], a1Video);
    const board = await rts.readyToSend();
    const payload = JSON.stringify({ list, kit, board });
    c.ok("no blob-store host in the library, the posting kit or the ready card", !/blob\.vercel-storage\.com/.test(payload));
    c.ok("every cut the kit names is a hub stream route", !kit.final || kit.final.url.startsWith("/api/review/cut/"), kit.final?.url ?? "(none)");
    const b = await route(streamRoute, l1, "x=1");
    c.ok("a hub-held cut is PROXIED (200), never redirected to the store", b.status === 200 && !b.headers.get("location"));
  }

  // =========================================================================
  // S6 · 9.8 — A MOVED FILE IS NEVER SERVED OFF A STALE LINK
  // =========================================================================
  c.head("S6 · the link cache is keyed by path as well as by cut");
  {
    const pathA = "/Final/Moved-Cut-v1.mp4";
    const pathB = "/Final/superseded/Moved-Cut-v1-before-Topaz.mp4";
    FS.set(pathA, 1);
    FS.set(pathB, 1);
    const m1 = await mkCut({ projectId: lp.id, deliverableId: null, round: 3, fileName: "Moved Cut - v1.mp4", blob: false, assetPath: pathA });
    const first = await route(oldStream, m1, "x=1");
    await prisma.reviewSubmission.update({ where: { id: m1 }, data: { assetPath: pathB } });
    const stale = await route(oldStream, m1, "x=1");
    c.ok("OLD: after the file moved, the cached link for the OLD path was served", first.headers.get("location") === tmpLink(pathA) && stale.headers.get("location") === tmpLink(pathA), stale.headers.get("location") ?? "");
    const m2 = await mkCut({ projectId: lp.id, deliverableId: null, round: 4, fileName: "Moved Cut 2 - v1.mp4", blob: false, assetPath: pathA });
    const n1 = await route(streamRoute, m2, "x=1");
    await prisma.reviewSubmission.update({ where: { id: m2 }, data: { assetPath: pathB } });
    const n2 = await route(streamRoute, m2, "x=1");
    c.ok("NEW: the moved file gets a link for its NEW path", n1.headers.get("location") === tmpLink(pathA) && n2.headers.get("location") === tmpLink(pathB), n2.headers.get("location") ?? "");
  }

  // =========================================================================
  // S7 · LEGACY LIBRARY IDENTITY
  // =========================================================================
  c.head("S7 · positional rows: evidence and a disposition each; the board names the client");
  {
    const { legacyIdentityRows } = await import("../_probe/legacy-library-identity");
    const dee = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Dee Legacy TEST", package: "Starter", monthKey: "2026-08", project: { status: "DELIVERED", shootDate: new Date("2026-08-12T14:00:00Z") }, owner: false });
    const mkVideo = (title: string) => prisma.contentVideo.create({ data: { enrollmentId: dee.enrollmentId, clientId: dee.clientId, monthId: dee.monthId, monthKey: "2026-08", projectId: dee.projectId, kind: "PROGRAM", title, status: "DELIVERED", source: "aryeo" }, select: { id: true } });
    const kitchen = await mkVideo("Kitchen walkthrough");
    const porch = await mkVideo("Porch story");
    const lonely = await mkVideo("Unmatched");
    const cutK = await mkCut({ projectId: dee.projectId!, deliverableId: null, round: 1, fileName: "Kitchen walkthrough final.mp4" });
    const cutP = await mkCut({ projectId: dee.projectId!, deliverableId: null, round: 1, fileName: "Porch story for sellers.mp4" });
    await prisma.reviewSubmission.update({ where: { id: cutK }, data: { videoId: kitchen.id } });
    await prisma.reviewSubmission.update({ where: { id: cutP }, data: { videoId: porch.id } });
    const pv = async (n: number, title: string, videoId: string, basis: string | null, confirmed = false) => {
      const key = `aryeo:lst-dee:${n}`;
      const row = await prisma.portalVideo.create({ data: { enrollmentId: dee.enrollmentId, projectId: dee.projectId, title, download: `https://cdn.aryeo.invalid/${n}.mp4`, source: "aryeo", externalKey: key, deliveredAt: new Date("2026-08-20T14:00:00Z"), videoId }, select: { id: true } });
      await prisma.contentVideoSource.create({ data: { videoId, kind: "PORTAL_VIDEO", ref: key, portalVideoId: row.id, isFinal: true, matchBasis: basis, ...(confirmed ? { confirmedAt: new Date(), confirmedBy: "Kyle" } : {}) } });
      return key;
    };
    await pv(0, "Kitchen Walkthrough", kitchen.id, "name");          // names its own video
    await pv(1, "Porch Story", kitchen.id, "index");                 // names the OTHER video
    await pv(2, "Mystery clip", lonely.id, "own");                   // its own row, no chain
    await pv(3, "Kitchen Walkthrough", porch.id, "index", true);     // a person confirmed it
    await prisma.portalVideo.create({ data: { enrollmentId: dee.enrollmentId, projectId: dee.projectId, title: "Rekeyed", source: "aryeo", externalKey: "aryeo:lst-dee:vid-abc", deliveredAt: new Date() } });
    const rows = await legacyIdentityRows(prisma as unknown as PrismaClient);
    const by = (k: string) => rows.find((r) => r.externalKey === k);
    c.ok("only the positional keys are listed (a video-id key is not)", rows.length === 4 && !rows.some((r) => r.externalKey.endsWith("vid-abc")), `${rows.length}`);
    c.ok("names its own video → confirm pairing", by("aryeo:lst-dee:0")?.disposition === "confirm pairing", by("aryeo:lst-dee:0")?.why);
    c.ok("names another video on the job → relink, then confirm", by("aryeo:lst-dee:1")?.disposition === "relink, then confirm" && by("aryeo:lst-dee:1")?.titleMatches[0]?.id === porch.id, by("aryeo:lst-dee:1")?.why);
    c.ok("no chain claims it → own video", by("aryeo:lst-dee:2")?.disposition === "own video", by("aryeo:lst-dee:2")?.why);
    c.ok("a person confirmed it → settled", by("aryeo:lst-dee:3")?.disposition === "settled", by("aryeo:lst-dee:3")?.why);
    c.ok("each row carries the evidence: client, job, listing, host", by("aryeo:lst-dee:1")?.clientName === "Dee Legacy TEST" && by("aryeo:lst-dee:1")?.listingId === "lst-dee" && by("aryeo:lst-dee:1")?.fileHost === "cdn.aryeo.invalid");
    const board = await opsExceptionsBoard();
    const row = board.rows.find((r) => r.id === `legacy:${dee.enrollmentId}`);
    c.ok("the board: one row for the client, the three unconfirmed files, Kyle, the next action", !!row && row.title === "Dee Legacy TEST" && /^3 older delivered files/.test(row.why) && row.owner === "Kyle" && /confirm or relink/.test(row.nextAction), row ? `${row.title} · ${row.why}` : "none");
  }

  // =========================================================================
  // S8 · 9.3 — THE WEBHOOK-HEALTH PROBE READS THE HUB'S OWN RECORD
  // =========================================================================
  c.head("S8 · webhook health, from WebhookEvent / the arm record / the hourly runs");
  {
    const { webhookHealth } = await import("../_probe/aryeo-webhook-health");
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
    await prisma.webhookEvent.createMany({
      data: [
        { provider: "aryeo", eventType: "LISTING_DELIVERED", payload: "{}", status: "PROCESSED", processedAt: ago(5), createdAt: ago(5) },
        { provider: "aryeo", eventType: "ORDER_CREATED", payload: "{}", status: "PROCESSED", processedAt: ago(2), createdAt: ago(2), error: "UNSIGNED: accepted while waiting for Aryeo to start signing — a secret is saved here but no post has proved Aryeo has it yet" },
        { provider: "aryeo", eventType: "LISTING_DELIVERED", payload: "{}", status: "REJECTED", createdAt: ago(3) },
        { provider: "aryeo", eventType: "LISTING_DELIVERED", payload: "{}", status: "PROCESSED", createdAt: ago(1), error: "SELF-TEST: a replay from the office — it does not count as a delivery on the webhook health panel (body: LISTING_DELIVERED)." },
        { provider: "aryeo", eventType: "APPOINTMENT_SCHEDULED", payload: "{}", status: "PROCESSED", createdAt: ago(24 * 20) },
      ],
    });
    await prisma.appSetting.create({ data: { key: "webhook-arm:aryeo", value: JSON.stringify({ v: 1, mode: "watching", fingerprint: "fp", watchingSince: "2026-09-16T12:00:00Z" }) } });
    await prisma.cronRun.create({ data: { job: "sync", startedAt: ago(1), finishedAt: ago(1), ok: true, summary: JSON.stringify({ readyToSendAryeo: { checked: 3, stamped: 1 }, webhookSilence: { quiet: [] } }) } });
    const h = await webhookHealth(prisma as unknown as PrismaClient, { days: 14 });
    const ld = h.events.find((e) => e.eventType === "LISTING_DELIVERED")!;
    c.ok("LISTING_DELIVERED: one real post, one refusal, one self-test counted apart", ld.received === 1 && ld.rejected === 1 && ld.selfTests === 1 && ld.handledByDelivery, JSON.stringify(ld));
    c.ok("the last REAL post is the unsigned order two hours ago (the self-test does not count)", h.lastRealEventAt?.getTime() === ago(2).getTime());
    c.ok("unsigned and refused are totalled", h.totals.unsigned === 1 && h.totals.rejected === 1);
    c.ok("an event older than the window is not counted", !h.events.some((e) => e.eventType === "APPOINTMENT_SCHEDULED"));
    c.ok("handled delivery events that never arrived are named", h.silentHandledEvents.includes("LISTING_CONTENT_DOWNLOADED") && h.silentHandledEvents.includes("MEDIA_REQUEST_DELIVERED"));
    c.ok("the arm state is read (watching)", h.arm?.mode === "watching");
    c.ok("the hourly recovery pass's own result is reported", h.recovery.some((r) => r.step === "readyToSendAryeo" && /stamped/.test(r.result)));
    c.ok("the verdict names the refusals and the unsigned acceptance", h.verdict.some((v) => /REFUSED/.test(v)) && h.verdict.some((v) => /UNSIGNED/.test(v)));
  }

  c.head("Z · isolation and spend");
  c.ok("no Topaz spend in any scenario (accept / complete-upload never called)", spend.accept === 0 && spend.complete === 0, JSON.stringify(spend));
  c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  c.ok("no Slack DM about a program upload", slackPosts.every((b) => !/New Portal Reel/.test(b)));

  quiet.restore();
  fs.rmSync(base.dir, { recursive: true, force: true });
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
