// ---------------------------------------------------------------------------
// DRILL oct23-send-when-ready: "Approve and send" and "Run it again, then
// upload and send" (Jordan, Oct 23 2026: "Can I have Run through topaz and
// upload and deliver button as well? So it automatically runs, uploads, and
// delivers?", then "Ok but I want that for regular too so an approve and send
// button or re-run and send button.").
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-send-when-ready.ts --logs <dir>
//
// Drives the SHIPPED code: app/review/sendWhenReadyActions (Approve and send,
// Don't send it automatically), app/ops/deliveryRecoveryActions (Run Topaz
// again, with and without "then send"), app/review/actions (approveCut and the
// reopen, unchanged), lib/sendWhenReady, lib/topazJobs (the lane, the held
// file's two answers, the re-run), lib/videoAryeoPush (requestVideoPush and its
// gates, REAL: wrapped only to count the calls), lib/readyToSend and
// lib/videoDelivery, against an isolated PGlite. Topaz and Dropbox are
// replaced at the module boundary and every outbound call is fenced: nothing
// is rendered, charged, uploaded to Aryeo or sent. No upload run is moved past
// PREPARING (the cron's driveVideoPushes is never called), so the proof is
// "the press Upload to Aryeo and send makes was made, once, by the presser".
//
//   §1 who may press: the creative manager, an editor and a preview refused
//      (Approve and send, Run it again then send, Don't send it automatically)
//   §2 Approve and send, verified render: exactly one requestVideoPush, by the
//      presser, the moment the file is checked; the timeline says so
//   §3 one press only: a double press, two settles and two sweeps at once
//   §4 the already-finished skip: waits for the original to land, then sends
//   §5 no Topaz lane: the send is made at once; its gate answers (not sent)
//   §6 failed: no send, a bell for the owner and the office, a timeline line
//   §7 held, then the Topaz file chosen: sends; held, then the original kept:
//      no send
//   §8 Run it again, then upload and send: written in the re-run's own
//      transaction; the same tail (verified sends, failed does not); a plain
//      re-run turns a waiting send off
//   §9 reopen drops it; a replaced version drops it
//   §10 the gates are honoured: an open client request (the push held, never
//      uploaded, the intent started: it goes once the request is checked);
//      a listing warning; Checked, approve and send; an earlier upload-only
//      run never turns Approve and send into an upload-only run (Oct 25)
//   §11 Don't send it automatically
//   §12 the plain buttons unchanged: Approve and plain Run Topaz again send
//      nothing
//   §13 the screens: the board's rows, the Review Room's code, the words
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import type { AvTiming } from "../../src/lib/mp4Probe";

const PORT = Number(process.env.DRILL_PORT ?? 6641);
const REPO = path.resolve(__dirname, "..", "..");
const src = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

// ---- the login, stubbed at the one seam every guard reads --------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
const NAMES: Record<string, string> = { OWNER: "Jordan Drill", ADMIN: "Kyle Drill", CREATIVE_MANAGER: "James Drill", EDITOR: "Kim Drill" };
const as = (role: string, impersonating = false): Viewer => ({ id: `u-${role}`, email: `${role.toLowerCase()}@drill.invalid`, name: NAMES[role] ?? role, role, permissions: null, status: "ACTIVE", teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating, realRole: role, realName: null });
let viewer: Viewer | null = as("OWNER");
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);
installNextStubs();

// ---- the cut store's bytes (a public store object: no token needed) ----------
const BYTES = new Uint8Array(1000).map((_, i) => i % 251);
const blobUrlFor = (name: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${name}`;
const fence = fenceFetch((url) => {
  if (!url.startsWith("https://drillstore.public.blob.vercel-storage.com/")) return null;
  return new Response(BYTES, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(BYTES.length) } });
});

const isMod = (r: string, tail: string) => r === `@/lib/${tail}` || r.endsWith(`/src/lib/${tail}`) || r.endsWith(`/src/lib/${tail}.ts`);
const wrapOnce = <T extends object>(make: (m: T) => T) => {
  const cache = new WeakMap<object, T>();
  return (loaded: unknown) => {
    const m = loaded as T;
    if (!cache.has(m)) cache.set(m, make(m));
    return cache.get(m);
  };
};

// ---- requestVideoPush: the REAL one, every call counted ------------------------
const pushCalls: { submissionId: string; by: string; result: { ok: boolean; started: boolean; message: string } }[] = [];
interceptModule(
  (r) => isMod(r, "videoAryeoPush"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      if (k !== "requestVideoPush") return t[k];
      const real = t[k] as (id: string, o: { by: string }) => Promise<{ ok: boolean; started: boolean; message: string }>;
      return async (id: string, o: { by: string }) => {
        const result = await real(id, o);
        pushCalls.push({ submissionId: id, by: o.by, result });
        return result;
      };
    },
  })),
);
const callsFor = (id: string) => pushCalls.filter((x) => x.submissionId === id);

// ---- Topaz, faked ----------------------------------------------------------------
type Meta = { width: number; height: number; frameRate: number; frameCount: number; durationSec: number; container: string; codec: string; sizeBytes: number; audio: { present: boolean; codec: string | null }; timing?: AvTiming | null };
const inStep = (sec: number): AvTiming => ({ fragmented: false, video: { startSec: 0, endSec: sec }, audio: { startSec: 0, endSec: sec, codec: "mp4a" } });
const SOURCE: Meta = { width: 3840, height: 2160, frameRate: 29.97, frameCount: 899, durationSec: 30, container: "mp4", codec: "avc1", sizeBytes: BYTES.length, audio: { present: true, codec: "mp4a" }, timing: inStep(30) };
/** Already 1080p H.264 with sound in step: the already-finished rule's file. */
const FINISHED: Meta = { ...SOURCE, width: 1920, height: 1080 };
const RENDER: Meta = { ...SOURCE, width: 1920, height: 1080, sizeBytes: 40_000_000 };
const PROBE = new Map<string, Meta>();
/** Sources Topaz refuses for good (a non-retryable error: the pass fails). */
const REFUSED = new Set<string>();
const topazOut = (id: string) => `https://topaz.invalid/out/${id}.mp4`;
const topaz = { create: 0 };
const STATUS = new Map<string, { status: string; downloadUrl: string | null }>();
interceptModule(
  (r) => isMod(r, "integrations/topaz"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      const E = t.TopazError as new (msg: string, status: number, retryable: boolean) => Error;
      switch (k) {
        case "topazConnected": return async () => true;
        case "topazBalance": return async () => ({ available_credits: 500, reserved_credits: 0, total_credits: 500 });
        case "probeVideoMetadata":
          return async (url: string) => {
            if (REFUSED.has(url)) throw new E("Topaz refused this file (422).", 422, false);
            const a = PROBE.get(url);
            if (!a) throw new E("Couldn't read the video file (503).", 503, true);
            return a;
          };
        case "createVideoRequest":
          return async () => { topaz.create++; const id = `req-swr-${topaz.create}`; return { requestId: id, credits: 9, seconds: 600, raw: { requestId: id } }; };
        case "acceptVideoRequest": return async (id: string) => [{ partNum: 1, url: `https://topaz-upload.invalid/${id}/1` }];
        case "putUploadPart": return async (target: { partNum: number }) => ({ partNum: target.partNum, eTag: `etag-${target.partNum}` });
        case "completeUpload": return async (id: string) => { STATUS.set(id, { status: "processing", downloadUrl: null }); };
        case "videoStatus":
          return async (id: string) => {
            const s = STATUS.get(id) ?? { status: "processing", downloadUrl: null };
            return { status: s.status, downloadUrl: s.downloadUrl, credits: s.status === "complete" ? 16 : null, progress: null, message: null, raw: {} };
          };
        case "cancelVideoRequest": case "cancelEstimate": case "deleteVideoFiles": return async () => true;
        default: return t[k];
      }
    },
  })),
);

// ---- Dropbox, faked: a little file system --------------------------------------
const FS = new Map<string, number>();
interceptModule(
  (r) => isMod(r, "integrations/dropbox"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      const DErr = t.DropboxError as new (msg: string, status?: number) => Error;
      if (k === "dropboxConfigured") return () => true;
      if (k !== "dbx") return t[k];
      return async (ep: string, arg: Record<string, unknown> = {}) => {
        const p = String(arg.path ?? arg.from_path ?? "");
        switch (ep) {
          case "files/create_folder_v2": return { metadata: { path_display: p } };
          case "files/save_url":
            if (FS.has(p)) throw new DErr("path/conflict/file/", 409);
            FS.set(p, 40_000_000);
            return { ".tag": "complete" };
          case "files/save_url/check_job_status": return { ".tag": "complete" };
          case "files/get_metadata":
            if (!FS.has(p)) throw new DErr("path/not_found/", 409);
            return { ".tag": "file", size: FS.get(p), path_display: p };
          case "files/get_temporary_link":
            if (!FS.has(p)) throw new DErr("path/not_found/", 409);
            return { link: `https://dbx.invalid/tmp${p}` };
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

const c = makeChecker();
const noDash = (s: string | null | undefined) => !!s && !s.includes("—") && !s.includes("–");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct23-send-when-ready-isolated" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const tj = await import("@/lib/topazJobs");
  const rr = await import("@/lib/topazRerun");
  const settings = await import("@/lib/settings");
  const swr = await import("@/lib/sendWhenReady");
  const V = await import("@/lib/videoAryeoPush");
  const { readyToSend } = await import("@/lib/readyToSend");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const sendActions = await import("@/app/review/sendWhenReadyActions");
  const recovery = await import("@/app/ops/deliveryRecoveryActions");
  const review = await import("@/app/review/actions");
  const { HELD_ATTESTATION } = await import("@/lib/topazHold");

  await settings.putSetting("topaz", { ...(await settings.topazSettings()), enabled: true, skipFinished1080p: false, maxCreditsPerVideo: 20 });
  // The hub's Aryeo login (Connections): requestVideoPush starts a run with it. Nothing is sent: no run is moved.
  await saveSecret("aryeo_web", ["drill", "hub", "password"].join("-"), { accountLabel: "hub@drill.invalid", metadata: { email: "hub@drill.invalid" } });
  const client = await prisma.client.create({ data: { name: "Send Ready Realty" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "ADMIN" } });

  const withViewer = async <T>(who: Viewer | null, fn: () => Promise<T>): Promise<T> => {
    process.env.AUTH_ENFORCE = "true";
    viewer = who;
    try {
      return await fn();
    } finally {
      process.env.AUTH_ENFORCE = "";
      viewer = as("OWNER");
    }
  };
  const jobOf = (submissionId: string) => prisma.topazJob.findUniqueOrThrow({ where: { submissionId } });
  const intentOf = async (id: string) => (await swr.readSendIntent(id)).intent;
  const runOf = (id: string) => V.videoPushRun(id);
  const bells = (id: string) => prisma.notification.findMany({ where: { kind: "video_not_sent", dedupeKey: { startsWith: `send-when-ready-${id}-` } } });
  const lines = async (projectId: string, re: RegExp) => (await prisma.activity.findMany({ where: { projectId }, select: { body: true } })).map((a) => a.body).filter((b) => re.test(b));
  const drive = async (submissionId: string, until: string[], max = 14) => {
    const j = await jobOf(submissionId);
    const seen: string[] = [];
    for (let i = 0; i < max; i++) {
      await prisma.topazJob.update({ where: { id: j.id }, data: { nextAttemptAt: null } });
      const s = await tj.advanceTopazJob(j.id);
      seen.push(s);
      if (until.includes(s)) break;
    }
    return seen;
  };
  /** Topaz is "working" on this cut's render now: the next pass reads it back finished (readable, or not). */
  const renderBack = async (submissionId: string, readable: boolean) => {
    const j = await jobOf(submissionId);
    const id = j.requestId ?? `req-direct-${submissionId}`;
    STATUS.set(id, { status: "complete", downloadUrl: topazOut(id) });
    if (readable) PROBE.set(topazOut(id), RENDER);
    // PGlite stamps times in local time; Neon runs in UTC (see oct23-topaz-rerun §4).
    await prisma.topazJob.update({ where: { id: j.id }, data: { nextAttemptAt: null, acceptedAt: new Date(), savingStartedAt: null } });
  };

  // ---- a listing video in review (PENDING), its Topaz pass not started -------------
  let n = 0;
  async function mkPending(street: string, opts: { source?: Meta } = {}) {
    n++;
    const folder = `/Listings/Drill/${street}`;
    const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId: client.id, status: "REVIEW", source: "ARYEO", aryeoListingId: `lst-swr-${n}`, dropboxFolder: folder }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
    const final = actualFolderPaths({ dropboxFolder: folder } as Parameters<typeof actualFolderPaths>[0]).finalVideo;
    const original = `${final}/Real Estate Video Tour - v1.mp4`;
    const blobUrl = blobUrlFor(`swr-${n}.mp4`);
    PROBE.set(blobUrl, opts.source ?? SOURCE);
    const sub = await prisma.reviewSubmission.create({
      data: { projectId: p.id, deliverableId: d.id, slot: 1, kind: "video", round: 1, status: "PENDING", source: "upload", fileName: "Real Estate Video Tour - v1.mp4", blobUrl, sizeBytes: BYTES.length, submittedByKey: "kim", submittedByName: "Kim Drill" },
      select: { id: true },
    });
    await ensureOutputsForProject(p.id).catch(() => null);
    return { projectId: p.id, subId: sub.id, final, original, blobUrl, street };
  }
  /** The Final-folder copy of the editor's original, landed (approveCut's background copy, which the fake does not run). */
  const landOriginal = async (L: { subId: string; original: string }) => {
    FS.set(L.original, 90_000_000);
    await prisma.reviewSubmission.update({ where: { id: L.subId }, data: { finalPath: L.original, completedAt: new Date() } });
  };
  /** Straight to "Topaz is rendering" (the price check and the upload are oct23-topaz-rerun's to prove). */
  const toProcessing = async (subId: string) => {
    const j = await jobOf(subId);
    const requestId = `req-direct-${subId}`;
    await prisma.topazJob.update({
      where: { id: j.id },
      data: {
        state: "processing", requestId, acceptedAt: new Date(), completeUploadAt: new Date(), startedAt: new Date(),
        sourceWidth: 3840, sourceHeight: 2160, sourceFrameRate: 29.97, sourceFrameCount: 899, sourceDurationSec: 30, sourceContainer: "mp4", sourceSizeBytes: BYTES.length,
        outputWidth: 1920, outputHeight: 1080, estimateCredits: 16, sourceHasAudio: true, sourceAudioCodec: "mp4a", nextAttemptAt: null,
      },
    });
    STATUS.set(requestId, { status: "processing", downloadUrl: null });
  };
  const approveAndSend = (who: Viewer | null, id: string, opts: Parameters<typeof sendActions.approveAndSendAction>[1] = {}) => withViewer(who, () => sendActions.approveAndSendAction(id, opts));
  const JORDAN = as("OWNER");
  const KYLE = as("ADMIN");

  // =========================================================================
  c.head("§1 · who may press: owner and office only, checked on the server");
  // =========================================================================
  const W = await mkPending("1 Who Way");
  {
    const james = await approveAndSend(as("CREATIVE_MANAGER"), W.subId);
    const kim = await approveAndSend(as("EDITOR"), W.subId);
    const preview = await approveAndSend(as("OWNER", true), W.subId);
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: W.subId } });
    c.ok("Approve and send: James (creative manager) is refused", !james.ok && /access/i.test(james.message), james.message);
    c.ok("…an editor is refused", !kim.ok && /access/i.test(kim.message), kim.message);
    c.ok("…a preview (\"view as\") is refused", !preview.ok && /preview/i.test(preview.message), preview.message);
    c.ok("…and none of them approved it or set a send", sub.status === "PENDING" && !(await intentOf(W.subId)) && !(await prisma.topazJob.findUnique({ where: { submissionId: W.subId } })));
    // James keeps plain Approve (it sends nothing).
    const plain = await withViewer(as("CREATIVE_MANAGER"), () => review.approveCut(W.subId));
    c.ok("James's plain Approve still works exactly as before, and sets no send", plain.ok && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: W.subId } })).status === "APPROVED" && !(await intentOf(W.subId)), plain.message);
    await toProcessing(W.subId);
    await prisma.topazJob.update({ where: { submissionId: W.subId }, data: { state: "held", heldPath: `${W.final}/unverified/x.mp4`, heldAt: new Date(), outputCheck: "unverified" } });
    const j = await jobOf(W.subId);
    const r1 = await withViewer(as("CREATIVE_MANAGER"), () => recovery.rerunTopazAction(j.id, { thenSend: true }));
    const r2 = await withViewer(as("EDITOR"), () => recovery.rerunTopazAction(j.id, { thenSend: true }));
    const r3 = await withViewer(as("OWNER", true), () => recovery.rerunTopazAction(j.id, { thenSend: true }));
    c.ok("Run it again, then upload and send: the creative manager, an editor and a preview are refused, nothing moved", !r1.ok && !r2.ok && !r3.ok && (await jobOf(W.subId)).state === "held" && !(await intentOf(W.subId)), [r1.message, r2.message, r3.message].join(" | "));
    const bad = await withViewer(KYLE, () => recovery.rerunTopazAction(j.id, { thenSend: "yes" as unknown as boolean }));
    c.ok("…a malformed choice is refused", !bad.ok && /not valid/.test(bad.message), bad.message);
    await swr.putSendIntent(prisma, { submissionId: W.subId, projectId: W.projectId, by: "Jordan Drill", at: new Date().toISOString(), source: "approve", topazJobId: j.id });
    const x1 = await withViewer(as("CREATIVE_MANAGER"), () => sendActions.cancelSendWhenReadyAction(W.subId));
    const x2 = await withViewer(as("EDITOR"), () => sendActions.cancelSendWhenReadyAction(W.subId));
    const x3 = await withViewer(as("OWNER", true), () => sendActions.cancelSendWhenReadyAction(W.subId));
    c.ok("Don't send it automatically: the creative manager, an editor and a preview are refused; it still waits", !x1.ok && !x2.ok && !x3.ok && (await intentOf(W.subId))?.state === "waiting");
    await prisma.appSetting.deleteMany({ where: { key: swr.sendIntentKey(W.subId) } });
  }

  // =========================================================================
  c.head("§2 · Approve and send, verified render: one send, by the presser");
  // =========================================================================
  const A = await mkPending("2 Approve Ave");
  {
    const offer = await swr.approveAndSendOffer(A.subId);
    c.ok("the workspace offers Approve and send on a listing video the lane will run (no open requests)", !!offer && offer.openAsks.length === 0 && !offer.asksUnknown, JSON.stringify(offer));
    const r = await approveAndSend(JORDAN, A.subId);
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: A.subId } });
    const i = await intentOf(A.subId);
    const job = await jobOf(A.subId);
    c.ok("the press approves it, exactly as Approve does (Topaz pass queued)", r.ok && sub.status === "APPROVED" && sub.decidedBy === "Jordan Drill" && job.state === "queued", `${r.message} · ${sub.status} · ${job.state}`);
    c.ok("…and writes ONE intent: waiting, by Jordan, from the approval, naming the pass", i?.state === "waiting" && i.by === "Jordan Drill" && i.source === "approve" && i.topazJobId === job.id && i.projectId === A.projectId, JSON.stringify(i));
    c.ok("…and answers in plain words what happens next (no em dash)", /Once the Topaz file is back and checked, the hub uploads it to Aryeo and sends it\./.test(r.message) && /it waits for you instead/.test(r.message) && noDash(r.message), r.message);
    c.ok("nothing is sent while the pass runs", callsFor(A.subId).length === 0 && !(await runOf(A.subId)));
    await toProcessing(A.subId);
    await drive(A.subId, ["processing"], 1);
    c.ok("…still nothing while Topaz renders (a sweep looks and waits)", (await swr.sweepSendWhenReady()).started === 0 && callsFor(A.subId).length === 0 && (await intentOf(A.subId))?.state === "waiting");
    await renderBack(A.subId, true);
    const seen = await drive(A.subId, ["done", "held", "failed"]);
    const j = await jobOf(A.subId);
    const run = await runOf(A.subId);
    c.ok("the render comes back checked and is filed (done, verified)", j.state === "done" && j.outputCheck === "verified" && !!j.finalPath, seen.join(" → "));
    c.ok("…and at that moment exactly ONE requestVideoPush, by the presser", callsFor(A.subId).length === 1 && callsFor(A.subId)[0].by === "Jordan Drill" && callsFor(A.subId)[0].result.started, JSON.stringify(callsFor(A.subId)));
    c.ok("…the same run Upload to Aryeo and send starts: deliver mode, in Jordan's name, the Topaz file", run?.state === "PREPARING" && run.mode === "deliver" && run.by === "Jordan Drill" && run.file.path === j.finalPath, JSON.stringify({ s: run?.state, m: run?.mode, by: run?.by, f: run?.file.path }));
    c.ok("the intent says started", (await intentOf(A.subId))?.state === "started");
    const said = await lines(A.projectId, /^Topaz pass finished: uploading to Aryeo and sending, as Jordan Drill asked when approving it\.$/);
    c.ok("the timeline says it, once: \"Topaz pass finished: uploading to Aryeo and sending, as Jordan Drill asked when approving it.\"", said.length === 1, said.join(" | "));
    await swr.sweepSendWhenReady();
    await swr.settleSendWhenReady(A.subId);
    c.ok("a later sweep or settle sends nothing more", callsFor(A.subId).length === 1);
  }

  // =========================================================================
  c.head("§3 · one press only: a double press, two settles and two sweeps at once");
  // =========================================================================
  const D = await mkPending("3 Double Dr");
  {
    const [a, b] = await Promise.all([approveAndSend(JORDAN, D.subId), approveAndSend(JORDAN, D.subId)]);
    const intents = await prisma.appSetting.count({ where: { key: swr.sendIntentKey(D.subId) } });
    c.ok("a double press: one approval, one intent; the other press is told, never a second set-up", (a.ok || b.ok) && intents === 1 && (await prisma.topazJob.count({ where: { submissionId: D.subId } })) === 1 && (await intentOf(D.subId))?.state === "waiting", `${a.message} | ${b.message}`);
    await toProcessing(D.subId);
    await renderBack(D.subId, true);
    // The file lands WITHOUT the inline trigger (a function that died after filing it): put the intent back to waiting after.
    await drive(D.subId, ["done"]);
    const first = callsFor(D.subId).length;
    c.ok("the pass's own finish sent it once", first === 1, String(first));
    // Now the race itself: a fresh waiting intent on a ready file, everybody at once.
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: `video_aryeo_push:${D.subId}` } } });
    await swr.putSendIntent(prisma, { submissionId: D.subId, projectId: D.projectId, by: "Jordan Drill", at: new Date().toISOString(), source: "approve", topazJobId: (await jobOf(D.subId)).id });
    const before = callsFor(D.subId).length;
    const outs = await Promise.all([swr.settleSendWhenReady(D.subId), swr.settleSendWhenReady(D.subId), swr.sweepSendWhenReady(), swr.sweepSendWhenReady()]);
    c.ok("two settles and two cron sweeps at the same moment: exactly one requestVideoPush (the compare-and-set)", callsFor(D.subId).length - before === 1, JSON.stringify(outs));
    c.ok("…and one run, started once", (await runOf(D.subId))?.state === "PREPARING" && (await intentOf(D.subId))?.state === "started");
    // A claim that died with its function is taken again, and requestVideoPush starts nothing twice.
    const { raw } = await swr.readSendIntent(D.subId);
    const i = JSON.parse(raw!) as import("../../src/lib/sendWhenReady").SendIntent;
    await prisma.appSetting.update({ where: { key: swr.sendIntentKey(D.subId) }, data: { value: JSON.stringify({ ...i, state: "starting", claimedAt: new Date(Date.now() - 10 * 60_000).toISOString() }) } });
    const runBefore = await runOf(D.subId);
    await swr.sweepSendWhenReady();
    const runAfter = await runOf(D.subId);
    c.ok("a claim older than five minutes is looked at again: requestVideoPush answers \"already sending\", the same run stays (never two)", runAfter?.id === runBefore?.id && (await intentOf(D.subId))?.state === "started" && /Already sending/.test(callsFor(D.subId).at(-1)?.result.message ?? ""), callsFor(D.subId).at(-1)?.result.message);
  }

  // =========================================================================
  c.head("§4 · the already-finished skip: the editor's original is the file, and it goes");
  // =========================================================================
  {
    await settings.putSetting("topaz", { ...(await settings.topazSettings()), skipFinished1080p: true });
    const F = await mkPending("4 Finished Fwy", { source: FINISHED });
    const r = await approveAndSend(KYLE, F.subId);
    c.ok("Kyle presses Approve and send on an already-1080p file", r.ok && (await intentOf(F.subId))?.by === "Kyle Drill", r.message);
    const s = await tj.advanceTopazJob((await jobOf(F.subId)).id);
    const j = await jobOf(F.subId);
    c.ok("the pass is skipped: the editor's original is the finished file (original-final)", s === "skipped" && j.resolution === "already-finished" && j.outputCheck === "original-final", `${s} ${j.resolution} ${j.outputCheck}`);
    c.ok("…but its Final-folder copy hasn't landed yet: the push's own gate says \"not yet\", so it WAITS (no refusal recorded)", callsFor(F.subId).length === 0 && (await intentOf(F.subId))?.state === "waiting" && !(await runOf(F.subId)));
    await landOriginal(F);
    const o = await swr.sweepSendWhenReady();
    const run = await runOf(F.subId);
    c.ok("once it lands, the next sweep sends it: one requestVideoPush, by Kyle, the editor's original", o.started >= 1 && callsFor(F.subId).length === 1 && callsFor(F.subId)[0].by === "Kyle Drill" && run?.state === "PREPARING" && run.file.path === F.original, JSON.stringify({ o, path: run?.file.path }));
    c.ok("…and the timeline says the pass wasn't needed", (await lines(F.projectId, /^Topaz pass not needed: uploading to Aryeo and sending, as Kyle Drill asked when approving it\.$/)).length === 1);
    await settings.putSetting("topaz", { ...(await settings.topazSettings()), skipFinished1080p: false });
  }

  // =========================================================================
  c.head("§5 · no Topaz lane: the send is made at once, and its own gate answers");
  // =========================================================================
  {
    await settings.putSetting("topaz", { ...(await settings.topazSettings()), enabled: false });
    const N = await mkPending("5 No Lane Ln");
    c.ok("the workspace does NOT draw Approve and send when no Topaz pass will run (the push's gate refuses those)", (await swr.approveAndSendOffer(N.subId)) === null);
    const r = await approveAndSend(JORDAN, N.subId);
    const i = await intentOf(N.subId);
    c.ok("pressed anyway (the server, called directly): approved, no pass queued, and requestVideoPush is called AT ONCE by the presser", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: N.subId } })).status === "APPROVED" && !(await prisma.topazJob.findUnique({ where: { submissionId: N.subId } })) && callsFor(N.subId).length === 1 && callsFor(N.subId)[0].by === "Jordan Drill", r.message);
    c.ok("…its gate is honoured, never bypassed: \"No Topaz pass ran for this video, so the hub does not send it on its own\" → not sent, the reason on the intent", i?.state === "not-sent" && /No Topaz pass ran for this video/.test(i.note ?? "") && (await runOf(N.subId))?.state === "FAILED", `${i?.state} ${i?.note}`);
    c.ok("…the press says so (approved, not sent, why)", /^Approved, but not sent: No Topaz pass ran/.test(r.message) && noDash(r.message), r.message);
    c.ok("…a bell for the owner and the office, and a timeline line", (await bells(N.subId)).length === 1 && JSON.parse((await bells(N.subId))[0].audience).includes("OWNER") && (await lines(N.projectId, /^Not sent to Aryeo automatically \(Jordan Drill asked for it when approving it\): No Topaz pass ran/)).length === 1);
    await settings.putSetting("topaz", { ...(await settings.topazSettings()), enabled: true });
  }

  // =========================================================================
  c.head("§6 · the pass failed: no send, a bell and a timeline line");
  // =========================================================================
  {
    const X = await mkPending("6 Failed Fl");
    await approveAndSend(JORDAN, X.subId);
    REFUSED.add(X.blobUrl);
    const s = await tj.advanceTopazJob((await jobOf(X.subId)).id);
    const i = await intentOf(X.subId);
    c.ok("Topaz refuses the file for good: the pass fails", s === "failed" && (await jobOf(X.subId)).state === "failed", s);
    c.ok("…no send (requestVideoPush never called, no run)", callsFor(X.subId).length === 0 && !(await runOf(X.subId)));
    c.ok("…the intent is not sent, with a plain reason (no em dash)", i?.state === "not-sent" && /^The Topaz pass couldn't finish \(Topaz refused this file \(422\)\), so it was not sent\.$/.test(i.note ?? "") && noDash(i.note), i?.note ?? "");
    const b = await bells(X.subId);
    c.ok("…the owner and the office get a bell", b.length === 1 && /Not sent automatically: 6 Failed Fl/.test(b[0].title) && /OWNER/.test(b[0].audience) && /ADMIN/.test(b[0].audience), JSON.stringify(b.map((x) => [x.title, x.audience])));
    c.ok("…and the job's timeline says why", (await lines(X.projectId, /^Not sent to Aryeo automatically \(Jordan Drill asked for it when approving it\): The Topaz pass couldn't finish/)).length === 1);
    await swr.sweepSendWhenReady();
    c.ok("…said once: a sweep rings nothing more", (await bells(X.subId)).length === 1);
    // Stopped by hand is the same.
    const S = await mkPending("6b Stopped St");
    await approveAndSend(JORDAN, S.subId);
    await tj.cancelTopazJob((await jobOf(S.subId)).id, "Jordan Drill");
    c.ok("a pass stopped by hand: not sent, says it was stopped", (await intentOf(S.subId))?.state === "not-sent" && /^The Topaz pass was stopped \(Stopped by Jordan Drill\), so it was not sent\.$/.test((await intentOf(S.subId))?.note ?? "") && callsFor(S.subId).length === 0, (await intentOf(S.subId))?.note ?? "");
  }

  // =========================================================================
  c.head("§7 · held: chosen after a listen sends; kept as the original does not");
  // =========================================================================
  {
    const H = await mkPending("7 Held Hl");
    await approveAndSend(JORDAN, H.subId);
    await landOriginal(H);
    await toProcessing(H.subId);
    await renderBack(H.subId, false); // nobody can read the render: held
    const seen = await drive(H.subId, ["held", "done", "failed"]);
    let j = await jobOf(H.subId);
    c.ok("a render nobody could read is HELD", j.state === "held" && !!j.heldPath, seen.join(" → "));
    await swr.sweepSendWhenReady();
    c.ok("…the send keeps waiting (no push, no refusal)", callsFor(H.subId).length === 0 && (await intentOf(H.subId))?.state === "waiting");
    const res = await tj.resolveHeldTopazJob(j.id, "accept-processed", "Kyle Drill", { attest: HELD_ATTESTATION });
    j = await jobOf(H.subId);
    c.ok("Kyle listens and uses the Topaz file: done, resolved-processed", res.ok && j.state === "done" && j.outputCheck === "resolved-processed", res.message);
    c.ok("…and it sends: one requestVideoPush, by Jordan (who pressed Approve and send)", callsFor(H.subId).length === 1 && callsFor(H.subId)[0].by === "Jordan Drill" && (await runOf(H.subId))?.state === "PREPARING" && (await intentOf(H.subId))?.state === "started");
    c.ok("…the timeline says the Topaz file was chosen after a listen", (await lines(H.projectId, /^Topaz file chosen after a listen: uploading to Aryeo and sending, as Jordan Drill asked when approving it\.$/)).length === 1);

    const K = await mkPending("7b Kept Ct");
    await approveAndSend(JORDAN, K.subId);
    await landOriginal(K);
    await toProcessing(K.subId);
    await renderBack(K.subId, false);
    await drive(K.subId, ["held", "done", "failed"]);
    const kj = await jobOf(K.subId);
    const kept = await tj.resolveHeldTopazJob(kj.id, "use-original", "Kyle Drill");
    const ki = await intentOf(K.subId);
    c.ok("held, then Kyle keeps the editor's original: NO send", kept.ok && (await jobOf(K.subId)).outputCheck === "resolved-original" && callsFor(K.subId).length === 0 && !(await runOf(K.subId)), kept.message);
    c.ok("…and it says so: not sent, who kept the original, a bell", ki?.state === "not-sent" && /^Kyle Drill kept the editor's original instead of the Topaz file, so it was not sent\. The original goes up by hand\.$/.test(ki.note ?? "") && (await bells(K.subId)).length === 1, ki?.note ?? "");
  }

  // =========================================================================
  c.head("§8 · Run it again, then upload and send");
  // =========================================================================
  {
    // A finished, checked render on Ready to send, never pressed.
    const R = await mkPending("8 Rerun Rd");
    await withViewer(JORDAN, () => review.approveCut(R.subId));
    await landOriginal(R);
    await toProcessing(R.subId);
    await renderBack(R.subId, true);
    await drive(R.subId, ["done"]);
    c.ok("a plain approval set no send; the checked render is on Ready to send", !(await intentOf(R.subId)) && callsFor(R.subId).length === 0 && (await jobOf(R.subId)).state === "done");
    const jobId = (await jobOf(R.subId)).id;
    const r = await withViewer(KYLE, () => recovery.rerunTopazAction(jobId, { thenSend: true }));
    const i = await intentOf(R.subId);
    const j = await jobOf(R.subId);
    c.ok("Kyle presses \"Run it again, then upload and send\": back to queued, and the intent waits, by Kyle, from the re-run", r.ok && j.state === "queued" && i?.state === "waiting" && i.source === "rerun" && i.by === "Kyle Drill" && i.topazJobId === jobId, `${r.message} · ${JSON.stringify(i)}`);
    c.ok("…its answer says the new file is uploaded and sent once checked, and that it waits for you otherwise", /Once the new file is back and checked, the hub uploads it to Aryeo and sends it\./.test(r.message) && /it waits for you instead/.test(r.message), r.message);
    const rec = await prisma.appSetting.findFirst({ where: { key: { startsWith: `topaz-rerun:${jobId}:` } } });
    const iRow = await prisma.appSetting.findUnique({ where: { key: swr.sendIntentKey(R.subId) } });
    c.ok("written in the re-run's own transaction: the run-again record and the intent carry the same moment", !!rec && !!iRow && rec.key.endsWith(`:${Date.parse(i!.at)}`), `${rec?.key} vs ${i?.at}`);
    c.ok("the re-run's source says so (putSendIntent on the transaction client)", /if \(opts\.thenSend\) \{\s*await putSendIntent\(tx,/.test(src("src/lib/topazJobs.ts")));
    c.ok("nothing is sent while it runs again", callsFor(R.subId).length === 0);
    await toProcessing(R.subId);
    await renderBack(R.subId, true);
    await drive(R.subId, ["done", "held", "failed"]);
    c.ok("the new render is checked and filed: exactly one requestVideoPush, by Kyle", callsFor(R.subId).length === 1 && callsFor(R.subId)[0].by === "Kyle Drill" && (await runOf(R.subId))?.state === "PREPARING");
    c.ok("…the timeline: \"…as Kyle Drill asked when running it through Topaz again.\"", (await lines(R.projectId, /^Topaz pass finished: uploading to Aryeo and sending, as Kyle Drill asked when running it through Topaz again\.$/)).length === 1);

    // A refused re-run writes no intent (it is in the same transaction).
    const again = await withViewer(KYLE, () => recovery.rerunTopazAction(jobId, { thenSend: true }));
    c.ok("a re-run refused (it is on its way to Aryeo now) writes no new intent", !again.ok && again.message === rr.RERUN_SAYS.goingUp && (await intentOf(R.subId))?.state === "started", again.message);

    // The same tail on a failure.
    const RF = await mkPending("8b Rerun Fail");
    await withViewer(JORDAN, () => review.approveCut(RF.subId));
    await landOriginal(RF);
    await toProcessing(RF.subId);
    await renderBack(RF.subId, true);
    await drive(RF.subId, ["done"]);
    const rfJob = (await jobOf(RF.subId)).id;
    await withViewer(KYLE, () => recovery.rerunTopazAction(rfJob, { thenSend: true }));
    // The new render dies at Topaz.
    await toProcessing(RF.subId);
    STATUS.set(`req-direct-${RF.subId}`, { status: "failed", downloadUrl: null });
    await drive(RF.subId, ["failed", "done", "held"]);
    const rfi = await intentOf(RF.subId);
    c.ok("run again and send, and the new pass fails: no send, not sent with the reason, a bell", (await jobOf(RF.subId)).state === "failed" && callsFor(RF.subId).length === 0 && rfi?.state === "not-sent" && rfi.source === "rerun" && /couldn't finish/.test(rfi.note ?? "") && (await bells(RF.subId)).length === 1, `${(await jobOf(RF.subId)).state} ${JSON.stringify(rfi)} bells=${(await bells(RF.subId)).length}`);

    // A plain re-run turns a waiting send off.
    const RP = await mkPending("8c Plain Pl");
    await approveAndSend(JORDAN, RP.subId);
    await landOriginal(RP);
    await toProcessing(RP.subId);
    await renderBack(RP.subId, false);
    await drive(RP.subId, ["held"]);
    c.ok("(a held file with Jordan's Approve and send waiting)", (await jobOf(RP.subId)).state === "held" && (await intentOf(RP.subId))?.state === "waiting");
    const plain = await withViewer(KYLE, async () => recovery.rerunTopazAction((await jobOf(RP.subId)).id));
    const pi = await intentOf(RP.subId);
    c.ok("a PLAIN Run Topaz again cancels it: \"Run again without sending.\"", plain.ok && pi?.state === "cancelled" && pi.note === swr.SEND_WHEN_READY_SAYS.plainRerun, `${plain.message} · ${JSON.stringify(pi)}`);
    await toProcessing(RP.subId);
    await renderBack(RP.subId, true);
    await drive(RP.subId, ["done"]);
    c.ok("…so the new checked render is NOT sent", (await jobOf(RP.subId)).state === "done" && callsFor(RP.subId).length === 0 && !(await runOf(RP.subId)));

    // Held → run again and send → the new render is held, then chosen.
    const RH = await mkPending("8d Rerun Held");
    await withViewer(JORDAN, () => review.approveCut(RH.subId));
    await landOriginal(RH);
    await toProcessing(RH.subId);
    await renderBack(RH.subId, false);
    await drive(RH.subId, ["held"]);
    await withViewer(KYLE, async () => recovery.rerunTopazAction((await jobOf(RH.subId)).id, { thenSend: true }));
    await toProcessing(RH.subId);
    await renderBack(RH.subId, false);
    await drive(RH.subId, ["held"]);
    c.ok("run again and send from a held file; the new render is held too: it waits", (await jobOf(RH.subId)).state === "held" && callsFor(RH.subId).length === 0 && (await intentOf(RH.subId))?.state === "waiting");
    await tj.resolveHeldTopazJob((await jobOf(RH.subId)).id, "accept-processed", "Jordan Drill", { attest: HELD_ATTESTATION });
    c.ok("…chosen after a listen: it sends, once, by Kyle", callsFor(RH.subId).length === 1 && callsFor(RH.subId)[0].by === "Kyle Drill");

    // A portal video is not an Aryeo video: refused before anything moves.
    const month = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Starter", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2 } });
    const cm = await prisma.contentMonth.create({ data: { enrollmentId: month.id, clientId: client.id, monthKey: "2026-10", videosOwed: 4 } });
    const PV = await mkPending("8e Portal Pl");
    await prisma.project.update({ where: { id: PV.projectId }, data: { contentMonthId: cm.id } });
    c.ok("a monthly portal video gets no Approve and send", (await swr.approveAndSendOffer(PV.subId)) === null);
    const pv = await approveAndSend(JORDAN, PV.subId);
    c.ok("…and the server refuses it before approving anything", !pv.ok && /portal by itself/.test(pv.message) && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: PV.subId } })).status === "PENDING", pv.message);
  }

  // =========================================================================
  c.head("§9 · a reopened or replaced version drops the send");
  // =========================================================================
  {
    const O = await mkPending("9 Reopen Rw");
    await approveAndSend(JORDAN, O.subId);
    await landOriginal(O);
    await toProcessing(O.subId);
    const note = await withViewer(JORDAN, () => review.addCutNote({ projectId: O.projectId, submissionId: O.subId, body: "Swap the opening shot", lane: "EDITOR", kind: "fix", timeSec: 3 }));
    const re = await withViewer(JORDAN, () => review.requestCutChanges(O.subId, { reopen: true }));
    const oi = await intentOf(O.subId);
    c.ok("Reopen for revisions while the pass runs: the intent is dropped at once (not sent, the reason)", note.ok && re.ok && oi?.state === "not-sent" && oi.note === swr.SEND_WHEN_READY_SAYS.reopened, `${re.message} · ${JSON.stringify(oi)}`);
    c.ok("…with a bell and a timeline line", (await bells(O.subId)).length === 1 && (await lines(O.projectId, /^Not sent to Aryeo automatically .*reopened for revisions/)).length === 1);
    await renderBack(O.subId, true);
    await drive(O.subId, ["done", "failed", "held"]);
    c.ok("…and when the (already paid) render lands, nothing is sent", callsFor(O.subId).length === 0 && !(await runOf(O.subId)));

    // A newer version replaces the approved one: the old version's send never goes.
    const P = await mkPending("9b Replaced Rd");
    await approveAndSend(JORDAN, P.subId);
    await landOriginal(P);
    await toProcessing(P.subId);
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: P.subId } });
    await prisma.reviewSubmission.create({ data: { projectId: P.projectId, deliverableId: sub.deliverableId, slot: 1, kind: "video", round: 2, status: "PENDING", source: "upload", fileName: "Real Estate Video Tour - v2.mp4", blobUrl: blobUrlFor("swr-v2.mp4"), sizeBytes: BYTES.length } });
    await renderBack(P.subId, true);
    await drive(P.subId, ["done", "failed", "held"]);
    const pi = await intentOf(P.subId);
    c.ok("a newer version came in while the old one rendered: the old file is NOT sent (\"A newer version replaced this one\")", callsFor(P.subId).length === 0 && pi?.state === "not-sent" && pi.note === swr.SEND_WHEN_READY_SAYS.replaced, JSON.stringify(pi));
  }

  // =========================================================================
  c.head("§10 · the gates are honoured: a client request, a listing warning");
  // =========================================================================
  {
    const G = await mkPending("10 Gate Gl");
    await approveAndSend(JORDAN, G.subId);
    await landOriginal(G);
    await toProcessing(G.subId);
    // The client asks for something while Topaz renders.
    await prisma.clientAsk.create({ data: { clientId: client.id, projectId: G.projectId, kind: "SPECIAL_REQUEST", medium: "video", text: "Please add our logo at the end", summary: "Add the logo at the end", source: "text", askedBy: "The agent", askedAt: new Date(), holdsDelivery: true } });
    await renderBack(G.subId, true);
    await drive(G.subId, ["done"]);
    const gi = await intentOf(G.subId);
    const run = await runOf(G.subId);
    c.ok("an open client request at that moment: requestVideoPush is asked (once) and holds it; nothing is uploaded", callsFor(G.subId).length === 1 && run?.state === "HELD" && run.hold?.gate === "asks" && !run.addSentAt && !run.upload.method, JSON.stringify({ s: run?.state, g: run?.hold?.gate }));
    // Audit Oct 25 2026: the held run goes by itself once the request is
    // checked (a person pressed), so the intent says started, not "not sent".
    c.ok("…the press took effect: the intent is started, with requestVideoPush's own words (the gate honoured, not bypassed)", gi?.state === "started" && /^Waiting for 1 open client request to be checked \("Add the logo at the end"\)\. It goes by itself once that clears\.$/.test(gi.note ?? "") && noDash(gi.note), gi?.note ?? "");
    c.ok("…no \"not sent\" bell; the timeline says it waits to upload and send", (await bells(G.subId)).length === 0 && (await lines(G.projectId, /^Topaz pass finished: waiting to upload to Aryeo and send, as Jordan Drill asked when approving it\. Waiting for 1 open client request/)).length === 1 && (await lines(G.projectId, /^Not sent to Aryeo automatically/)).length === 0, (await lines(G.projectId, /./)).slice(-3).join(" | "));

    // An earlier "Upload to Aryeo only" that stopped, then Approve and send:
    // the new run is a SEND (audit Oct 25 2026: it used to inherit "upload").
    const UO = await mkPending("10d Upload Only");
    const early = await V.requestVideoPush(UO.subId, { by: "Kyle Drill", uploadOnly: true });
    const earlyRun = await runOf(UO.subId);
    c.ok("(setup) an upload-only press on a version not approved yet stops as a FAILED upload-only run", !early.started && earlyRun?.state === "FAILED" && earlyRun.mode === "upload", JSON.stringify({ s: earlyRun?.state, m: earlyRun?.mode }));
    await approveAndSend(JORDAN, UO.subId);
    await landOriginal(UO);
    await toProcessing(UO.subId);
    await renderBack(UO.subId, true);
    await drive(UO.subId, ["done"]);
    const uoRun = await runOf(UO.subId);
    c.ok("Approve and send after it: the run started is a send (mode deliver), never upload-only", uoRun?.mode === "deliver" && uoRun.state !== "FAILED" && (await intentOf(UO.subId))?.state === "started", JSON.stringify({ s: uoRun?.state, m: uoRun?.mode }));

    // A listing warning: the browser's "Upload anyway" step, made here too.
    const LW = await mkPending("10b Listing Ln");
    await approveAndSend(JORDAN, LW.subId);
    await landOriginal(LW);
    await toProcessing(LW.subId);
    const at = new Date().toISOString();
    await prisma.project.update({ where: { id: LW.projectId }, data: { statusEvidence: JSON.stringify({ checkedAt: at, aryeo: { videos: 1, at } }) } });
    await renderBack(LW.subId, true);
    await drive(LW.subId, ["done"]);
    const li = await intentOf(LW.subId);
    c.ok("the Aryeo listing already shows a video that could be this one: NOT sent, it waits for a person (no push call)", callsFor(LW.subId).length === 0 && !(await runOf(LW.subId)) && li?.state === "not-sent" && /^The Aryeo listing needs a look first, so it waits for you\. Aryeo already shows 1 video on this listing/.test(li.note ?? "") && noDash(li.note), li?.note ?? "");

    // Checked, approve and send: the requests are marked checked by the press, then it sends when ready.
    const CK = await mkPending("10c Checked Ct");
    await prisma.clientAsk.create({ data: { clientId: client.id, projectId: CK.projectId, kind: "SPECIAL_REQUEST", medium: "video", text: "Use the twilight shot first", summary: "Twilight shot first", source: "text", askedBy: "The agent", askedAt: new Date(), holdsDelivery: true } });
    const offer = await swr.approveAndSendOffer(CK.subId);
    c.ok("the offer carries the job's open request, for the confirm the press shows first", offer?.openAsks.length === 1 && offer.openAsks[0].summary === "Twilight shot first", JSON.stringify(offer));
    const r = await approveAndSend(JORDAN, CK.subId, { checkedRequests: true });
    const ask = await prisma.clientAsk.findFirstOrThrow({ where: { projectId: CK.projectId } });
    c.ok("\"Checked, approve and send\": approved, the request recorded checked by Jordan (the job box's Checked), the send waiting", r.ok && ask.state === "CONFIRMED" && /Jordan Drill/.test(ask.confirmedBy ?? "") && (await intentOf(CK.subId))?.state === "waiting", `${r.message} · ${ask.state} ${ask.confirmedBy}`);
    await landOriginal(CK);
    await toProcessing(CK.subId);
    await renderBack(CK.subId, true);
    await drive(CK.subId, ["done"]);
    c.ok("…and once the file is checked it goes (one requestVideoPush, started)", callsFor(CK.subId).length === 1 && callsFor(CK.subId)[0].result.started);
  }

  // =========================================================================
  c.head("§11 · Don't send it automatically");
  // =========================================================================
  {
    const Z = await mkPending("11 Cancel Ct");
    await approveAndSend(JORDAN, Z.subId);
    await landOriginal(Z);
    await toProcessing(Z.subId);
    const x = await withViewer(KYLE, () => sendActions.cancelSendWhenReadyAction(Z.subId));
    const zi = await intentOf(Z.subId);
    c.ok("Kyle turns it off: cancelled, by him, and the answer says it waits for a press", x.ok && zi?.state === "cancelled" && zi.note === "Turned off by Kyle Drill." && /won't be sent automatically/.test(x.message), x.message);
    c.ok("…the timeline says who turned it off", (await lines(Z.projectId, /^Kyle Drill turned off the automatic send asked for when approving\. It waits for a person to press Upload to Aryeo and send\.$/)).length === 1);
    await renderBack(Z.subId, true);
    await drive(Z.subId, ["done"]);
    await swr.sweepSendWhenReady();
    c.ok("…so the checked file is not sent, and no bell rings", callsFor(Z.subId).length === 0 && !(await runOf(Z.subId)) && (await bells(Z.subId)).length === 0);
    const twice = await withViewer(KYLE, () => sendActions.cancelSendWhenReadyAction(Z.subId));
    c.ok("a second press says there is nothing set", twice.ok && /wasn't set to send automatically/.test(twice.message), twice.message);
  }

  // =========================================================================
  c.head("§12 · the plain buttons, unchanged");
  // =========================================================================
  {
    const P = await mkPending("12 Plain Pk");
    const a = await withViewer(JORDAN, () => review.approveCut(P.subId));
    await landOriginal(P);
    await toProcessing(P.subId);
    await renderBack(P.subId, true);
    await drive(P.subId, ["done"]);
    await swr.sweepSendWhenReady();
    const row = (await readyToSend({ projectId: P.projectId })).ready.find((x) => x.submissionId === P.subId);
    c.ok("plain Approve: approved, the pass runs, and nothing is sent by itself (button only, as since Oct 19)", a.ok && !(await intentOf(P.subId)) && callsFor(P.subId).length === 0 && !(await runOf(P.subId)) && row?.push?.canStart === true && row.push.state === null, a.message);
    const pressed = await withViewer(KYLE, () => import("@/app/review/videoSendActions").then((m) => m.sendVideoToAryeoAction(P.subId)));
    c.ok("Upload to Aryeo and send still starts it on the press (and writes no intent)", pressed.ok && pressed.started === true && !(await intentOf(P.subId)), pressed.message);
  }

  // =========================================================================
  c.head("§13 · the screens and the words");
  // =========================================================================
  {
    const T = await mkPending("13 Topaz Tr");
    await approveAndSend(JORDAN, T.subId);
    await toProcessing(T.subId);
    const { videoDeliveryBoard } = await import("@/lib/videoDelivery");
    const b = await videoDeliveryBoard({ fresh: true });
    const fin = b.lanes.finishing.find((r) => r.submissionId === T.subId);
    c.ok("the With Topaz row carries \"Then: upload to Aryeo and send\": by Jordan, when, from the approval", fin?.sendWhenReady?.state === "waiting" && fin.sendWhenReady.by === "Jordan Drill" && fin.sendWhenReady.source === "approve", JSON.stringify(fin?.sendWhenReady));
    const failedRow = [...b.lanes.sending, ...b.lanes.held].find((r) => r.submissionId && r.sendWhenReady?.state === "not-sent" && /Topaz pass couldn't finish/.test(r.sendWhenReady.note ?? ""));
    c.ok("a not-sent one shows on its row with the reason (the failed pass)", !!failedRow || [...b.lanes.sending, ...b.lanes.held].some((r) => r.sendWhenReady?.state === "not-sent"), JSON.stringify([...b.lanes.sending, ...b.lanes.held].map((r) => [r.street, r.sendWhenReady?.state])));
    const heldRow = [...b.lanes.sending, ...b.lanes.held].find((r) => r.street.startsWith("10 Gate Gl"));
    c.ok("the client-request one shows its held push line, not a \"not sent\" line (audit Oct 25 2026)", !!heldRow && heldRow.sendWhenReady?.state !== "not-sent", JSON.stringify(heldRow ? { push: heldRow.push, swr: heldRow.sendWhenReady } : null));
    const page = src("src/app/review/page.tsx");
    c.ok("the Review Room: RerunTopaz gets canSendAfter from the SAME one-press test as Send all", /const sendAllIds = ready\.filter\(oneShot\)/.test(page) && /canSendAfter=\{oneShot\(r\)\}/.test(page) && /!r\.send\.openAsks\.length && !r\.send\.asksUnknown && !r\.send\.listingWarning && !!r\.push\?\.canStart && !r\.push\.state/.test(page));
    c.ok("…the With Topaz row draws the line and \"Don't send it automatically\" for the office only (sendDesk)", /<WithTopazRow key=\{r\.key\} r=\{r\} sendDesk=\{deliveryDesk\} \/>/.test(page) && /canCancel=\{sendDesk\}/.test(page) && /Don&rsquo;t send it automatically/.test(src("src/components/videoDelivery/SendWhenReadyLine.tsx")));
    const panel = src("src/components/review/CutReviewPanel.tsx");
    c.ok("the workspace: Approve and send beside Approve, only with an offer; its requests confirm first (\"Checked, approve and send\")", /\{sendOffer && \(\s*<button[\s\S]{0,200}requestApproveAndSend\(false\)/.test(panel) && /Checked, approve and send/.test(panel) && /sendOffer\.openAsks\.length && !checkedRequests/.test(panel));
    c.ok("…drawn for the owner and the office only (the Room's delivery desk)", /const officeDesk = !me \|\| isOffice\(me\.role\);/.test(src("src/app/review/[id]/page.tsx")));
    c.ok("the re-run confirm's second choice: \"Run it again, then upload and send\"", rr.RERUN_SEND === "Run it again, then upload and send" && /\{canSendAfter && \(/.test(src("src/components/ops/RerunTopaz.tsx")));
    const line = rr.rerunCostLine({ credits: 16, limit: 20 }, { canSendAfter: true });
    c.ok("…the cost line gains ONE sentence about it, and is unchanged without it", line === `${rr.rerunCostLine({ credits: 16, limit: 20 })} ${rr.RERUN_SEND_LINE}` && /once the new file is back and checked, the hub uploads it to Aryeo and sends it\. If anything would stop that \(a client request to check, a listing warning\), it waits for you instead\./.test(line), line);
    const words = [...Object.values(swr.SEND_WHEN_READY_SAYS), rr.RERUN_SEND, rr.RERUN_SEND_LINE, line];
    const notes = (await prisma.appSetting.findMany({ where: { key: { startsWith: swr.SEND_WHEN_READY_PREFIX } }, select: { value: true } })).map((x) => (JSON.parse(x.value) as { note: string | null }).note).filter((x): x is string => !!x);
    c.ok("no em dash in any new word or any recorded reason", [...words, ...notes].every((w) => noDash(w)), [...words, ...notes].filter((w) => !noDash(w)).join(" | "));
    const money = [...notes].some((x) => /\$\s?\d/.test(x));
    c.ok("no dollar amount in any reason (Kyle reads them)", !money);
    c.ok("the cron sweeps before it moves the uploads", /sweepSendWhenReady[\s\S]{0,300}driveVideoPushes/.test(src("src/app/api/cron/topaz/route.ts")));
    c.ok("the left menu is untouched", !/sendWhenReady|Approve and send/i.test(src("src/lib/sidebarNavigation.ts")));
  }

  c.head("Z · isolation");
  c.ok("nothing left the process (only the fake store answered)", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
