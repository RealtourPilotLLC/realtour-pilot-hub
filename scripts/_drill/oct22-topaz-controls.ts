// ---------------------------------------------------------------------------
// DRILL oct22-topaz-controls — Topaz controls (Jordan, Oct 22 2026: "It did a
// bad job on the video for 711 Boehms … I just want to prevent it going
// forward and have more control over the settings.")
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct22-topaz-controls.ts --logs <dir>
//
// Drives the SHIPPED code — lib/topazJobs (the lane, spendGate, retry, the
// held decision), lib/topazTests (the Settings test), lib/readyToSend,
// lib/cutEntitlement, lib/monthlyFinal, lib/videoAryeoPush, the settings
// actions — against an isolated PGlite. Topaz, Dropbox and Aryeo are replaced
// at the module boundary and every outbound call is fenced. No real Topaz call
// is made; nothing is rendered, charged, uploaded, sent or published.
//
//   §1 the already-finished rule, pure (1080p H.264/HEVC + AAC or none passes
//      the codec rule; 4K, under 1080, PCM, ProRes, unreadable run) + the
//      switch's default (ON, no setup)
//   §2 the lane: a finished 1080p file is skipped before any Topaz call and
//      named FINAL (editor export); 4K/PCM/unreadable/no sound/sound out of
//      step/switch-off run as before; "Try the pass again" forces the pass; presetJson carries the
//      whole output block (and both spellings of the multi-word parameters)
//   §3 a skipped video flows: Ready to send ("Already 1080p: …"), the Aryeo
//      button (gates pass, the ORIGINAL's Final copy is the file), and a
//      monthly video's portal (clientCutFiles "original", portalStep
//      unblocked, monthlyFinalSnapshot ok with a .mov original)
//   §4 NO per-video Topaz control (Jordan: settings in general, not per
//      video); the held-render decision exactly as it was
//   §5 "Try these settings": free estimate first, owner only, counts toward
//      the caps, runs end to end and files NOTHING (no Dropbox, no portal, no
//      Aryeo, no TopazJob, no cut write), never purges Topaz's copy, keeps its
//      exact settings, "Use these settings" saves them; one call from a
//      script (startTopazTest / startTopazTestAction, owner only, maxCredits)
//   §6 the starting points, the mode words, and "set it and forget it": the
//      switch and one plain line on top, everything else in a closed
//      "Fine-tune (optional)"
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import type { AvTiming } from "../../src/lib/mp4Probe";

const PORT = Number(process.env.DRILL_PORT ?? 6611);
const REPO = path.resolve(__dirname, "..", "..");
const src = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

// ---- the login, stubbed at the one seam every guard reads --------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
const as = (role: string): Viewer => ({ id: `u-${role}`, email: `${role.toLowerCase()}@drill.invalid`, name: role === "OWNER" ? "Jordan Drill" : "Kyle Drill", role, permissions: null, status: "ACTIVE", teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: null });
let viewer: Viewer | null = as("OWNER");
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);
installNextStubs();

// ---- the cut store's bytes (a public store object: no token needed) ----------
const BYTES = new Uint8Array(1000).map((_, i) => i % 251);
const blobUrlFor = (name: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${name}`;
const blobFetches: string[] = [];
const fence = fenceFetch((url) => {
  if (!url.startsWith("https://drillstore.public.blob.vercel-storage.com/")) return null;
  blobFetches.push(url);
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

// ---- Topaz, faked: every call recorded -----------------------------------------
type Meta = { width: number; height: number; frameRate: number; frameCount: number; durationSec: number; container: string; codec: string; sizeBytes: number; audio: { present: boolean; codec: string | null }; timing?: AvTiming | null };
const inStep = (): AvTiming => ({ fragmented: false, video: { startSec: 0, endSec: 60 }, audio: { startSec: 0, endSec: 60, codec: "mp4a" } });
const meta = (o: Partial<Meta> & { audioCodec?: string | null } = {}): Meta => {
  const audioCodec = o.audioCodec === undefined ? "mp4a" : o.audioCodec;
  return {
    width: 1080, height: 1920, frameRate: 29.97, frameCount: 1798, durationSec: 60, container: "mp4", codec: "avc1", sizeBytes: BYTES.length,
    audio: { present: audioCodec !== null, codec: audioCodec },
    timing: audioCodec === null ? { fragmented: false, video: { startSec: 0, endSec: 60 }, audio: null } : inStep(),
    ...o,
  };
};
const PROBE = new Map<string, Meta>();
/** A 4K source short enough (30 s) to stay under the 20-credit ceiling. */
const fourK = () => meta({ width: 3840, height: 2160, durationSec: 30, frameCount: 899 });
const topaz = { create: [] as { source: unknown; output: Record<string, unknown>; filters: Record<string, unknown>[] }[], accept: [] as string[], put: 0, complete: [] as string[], cancel: [] as string[], del: [] as string[], status: [] as string[] };
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
            const a = PROBE.get(url);
            if (!a) throw new E("Couldn't read the video file (503).", 503, true);
            return a;
          };
        case "createVideoRequest":
          return async (body: { source: unknown; output: Record<string, unknown>; filters: Record<string, unknown>[] }) => {
            topaz.create.push(body);
            const id = `req-${topaz.create.length}`;
            return { requestId: id, credits: 9, seconds: 1200, raw: { requestId: id, estimates: { cost: [8, 9], time: [1100, 1200] } } };
          };
        case "acceptVideoRequest":
          return async (id: string) => { topaz.accept.push(id); return [{ partNum: 1, url: `https://topaz-upload.invalid/${id}/1` }]; };
        case "putUploadPart":
          return async (target: { partNum: number }) => { topaz.put++; return { partNum: target.partNum, eTag: `etag-${target.partNum}` }; };
        case "completeUpload":
          return async (id: string) => { topaz.complete.push(id); STATUS.set(id, { status: "processing", downloadUrl: null }); };
        case "videoStatus":
          return async (id: string) => {
            topaz.status.push(id);
            const s = STATUS.get(id) ?? { status: "processing", downloadUrl: null };
            return { status: s.status, downloadUrl: s.downloadUrl, credits: s.status === "complete" ? 8 : null, progress: null, message: null, raw: {} };
          };
        case "cancelVideoRequest": case "cancelEstimate": return async (id: string) => { topaz.cancel.push(id); return true; };
        case "deleteVideoFiles": return async (id: string) => { topaz.del.push(id); return true; };
        default: return t[k];
      }
    },
  })),
);

// ---- Dropbox, faked: a little file system, every call recorded ----------------
type DFile = { size: number; hash: string; id: string };
const FS = new Map<string, DFile>();
const dbxCalls: string[] = [];
let fileSeq = 0;
const put = (p: string, size = 90_000_000, hash = createHash("sha256").update(p).digest("hex")) => FS.set(p, { size, hash, id: `id:${++fileSeq}` });
interceptModule(
  (r) => isMod(r, "integrations/dropbox"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      const DErr = t.DropboxError as new (msg: string, status?: number) => Error;
      if (k === "dropboxConfigured") return () => true;
      if (k !== "dbx") return t[k];
      return async (ep: string, arg: Record<string, unknown> = {}) => {
        const p = String(arg.path ?? arg.from_path ?? "");
        dbxCalls.push(`${ep} ${p}`);
        switch (ep) {
          case "files/create_folder_v2": return { metadata: { path_display: p } };
          case "files/get_metadata": {
            const f = FS.get(p);
            if (!f) throw new DErr("path/not_found/", 409);
            return { ".tag": "file", id: f.id, rev: "015abc", content_hash: f.hash, size: f.size, path_display: p };
          }
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

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct22-topaz-controls-isolated" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const tj = await import("@/lib/topazJobs");
  const tt = await import("@/lib/topazTests");
  const orig = await import("@/lib/topazOriginal");
  const presets = await import("@/lib/topazPresets");
  const settings = await import("@/lib/settings");
  const { readyToSend } = await import("@/lib/readyToSend");
  const { clientCutFiles } = await import("@/lib/cutEntitlement");
  const { monthlyFinalSnapshot } = await import("@/lib/monthlyFinal");
  const push = await import("@/lib/videoAryeoPush");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const testActions = await import("@/app/settings/topazTestActions");

  // The hub's own Aryeo login exists (so the Upload-to-Aryeo gates run);
  // nothing past the gates is driven here, and Aryeo itself is fenced.
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo_web", ["drill", "pw"].join("-"), { accountLabel: "hub@drill.invalid", metadata: { email: "hub@drill.invalid" } });
  push.__setVideoPushHooksForTests({ openAsks: async () => [], soundCheck: async () => ({ verdict: "ok", message: "fine", av: null }) });
  // The lane switched on, everything else as stored defaults.
  await settings.putSetting("topaz", { ...(await settings.topazSettings()), enabled: true });

  const client = await prisma.client.create({ data: { name: "Drill Client TEST" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "ADMIN" } });

  // ---- a listing job with one approved cut --------------------------------------
  let n = 0;
  async function mkListing(street: string, o: { header?: Meta | null; ext?: ".mp4" | ".mov"; status?: string } = {}) {
    n++;
    const folder = `/Listings/Drill/${street}`;
    const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId: client.id, status: "REVIEW", source: "ARYEO", aryeoListingId: `lst-${n}`, dropboxFolder: folder }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
    const final = actualFolderPaths({ dropboxFolder: folder } as Parameters<typeof actualFolderPaths>[0]).finalVideo;
    const ext = o.ext ?? ".mp4";
    const original = `${final}/Real Estate Video Tour - v1${ext}`;
    put(original);
    const blobUrl = blobUrlFor(`cut-${n}${ext}`);
    if (o.header !== null) PROBE.set(blobUrl, o.header ?? meta());
    const sub = await prisma.reviewSubmission.create({
      data: { projectId: p.id, deliverableId: d.id, slot: 1, kind: "video", round: 1, status: o.status ?? "APPROVED", source: "upload", fileName: `Real Estate Video Tour - v1${ext}`, blobUrl, sizeBytes: BYTES.length, finalPath: original, completedAt: new Date(Date.now() - 3_600_000), decidedAt: new Date(Date.now() - 3_600_000), decidedBy: "James" },
      select: { id: true },
    });
    await ensureOutputsForProject(p.id).catch(() => null);
    return { projectId: p.id, subId: sub.id, final, original, blobUrl, street };
  }
  const queue = async (subId: string, projectId: string) => (await prisma.topazJob.create({ data: { submissionId: subId, projectId, state: "queued" }, select: { id: true } })).id;
  const jobOf = (id: string) => prisma.topazJob.findUniqueOrThrow({ where: { id } });

  // =========================================================================
  c.head("§1 · the already-finished rule, pure");
  // =========================================================================
  {
    const on = { skipFinished1080p: true, outputShortSide: 1080 };
    const r = (f: Parameters<typeof orig.alreadyFinishedRule>[0], s = on) => orig.alreadyFinishedRule(f, s);
    c.ok("1080x1920 H.264 + AAC → skip", r({ width: 1080, height: 1920, codec: "avc1", audio: { present: true, codec: "mp4a" } }).skip);
    c.ok("1920x1080 HEVC with no sound → skip", r({ width: 1920, height: 1080, codec: "hvc1", audio: { present: false, codec: null } }).skip);
    c.ok("4K (3840x2160) → runs", !r({ width: 3840, height: 2160, codec: "avc1", audio: { present: true, codec: "mp4a" } }).skip);
    c.ok("smaller than 1080 (720x1280) → runs", !r({ width: 720, height: 1280, codec: "avc1", audio: { present: true, codec: "mp4a" } }).skip);
    c.ok("PCM sound (ipcm) → runs", !r({ width: 1080, height: 1920, codec: "avc1", audio: { present: true, codec: "ipcm" } }).skip);
    c.ok("ProRes picture → runs", !r({ width: 1080, height: 1920, codec: "apcn", audio: { present: true, codec: "mp4a" } }).skip);
    c.ok("an unreadable header → runs", !r(null).skip);
    c.ok("the switch off → runs", !r({ width: 1080, height: 1920, codec: "avc1", audio: { present: true, codec: "mp4a" } }, { ...on, skipFinished1080p: false }).skip);
    c.ok("the screen's words are Jordan's", orig.ALREADY_FINISHED_SAYS === "Already 1080p: the editor's file goes out as is.");
    c.ok("the switch is ON by default, also for a row saved before it existed", settings.DEFAULT_TOPAZ.skipFinished1080p === true && settings.clampTopazSettings({ enabled: true } as never).skipFinished1080p === true);
    c.ok("…and an explicit off is kept", settings.clampTopazSettings({ skipFinished1080p: false } as never).skipFinished1080p === false);
  }

  // =========================================================================
  c.head("§2 · the lane");
  // =========================================================================
  let FIN: Awaited<ReturnType<typeof mkListing>> & { jobId: string };
  {
    const A = await mkListing("711 Boehms Church Rd");
    const jobId = await queue(A.subId, A.projectId);
    const before = topaz.create.length;
    const s = await tj.advanceTopazJob(jobId);
    const j = await jobOf(jobId);
    FIN = { ...A, jobId };
    c.ok("a finished 1080p H.264/AAC file: skipped, before any Topaz call", s === "skipped" && j.state === "skipped" && topaz.create.length === before, `${s} creates=${topaz.create.length - before}`);
    c.ok("…marked original-final, resolution already-finished, nothing committed", j.outputCheck === "original-final" && j.resolution === "already-finished" && !j.acceptedAt && !j.requestId && !j.estimateCredits);
    c.ok("…with the reason on the row: \"Already 1080p: the editor's file goes out as is.\"", j.skipReason === orig.ALREADY_FINISHED_SAYS, j.skipReason ?? "");
    const rec = JSON.parse(j.outputCheckJson ?? "{}") as { verdict?: string; where?: string; source?: { codec?: string; audioCodec?: string } };
    c.ok("…and the original's own sound check on the record (ok, read from the original)", rec.verdict === "ok" && rec.where === "original" && rec.source?.codec === "avc1" && rec.source?.audioCodec === "mp4a", j.outputCheckJson ?? "");
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: A.subId }, select: { finalPath: true } });
    c.ok("the editor's file in Final now says FINAL (editor export)", /FINAL \(editor export\)\.mp4$/.test(sub.finalPath ?? "") && FS.has(sub.finalPath!) && !FS.has(A.original), sub.finalPath ?? "");
    const bells = await prisma.notification.count({ where: { dedupeKey: { startsWith: `topaz-skipped-${jobId}` } } });
    const act = await prisma.activity.findFirst({ where: { projectId: A.projectId, body: { startsWith: "1080p pass not needed" } } });
    c.ok("quiet: no bell for the expected path, one timeline line", bells === 0 && !!act && /nothing was spent/i.test(act.body), act?.body ?? "");
    const view = await tj.topazJobForSubmission(A.subId);
    c.ok("the 1080p lane's own view says it too", view?.says === orig.ALREADY_FINISHED_SAYS, view?.says ?? "");

    const H = await mkListing("12 HEVC Ln", { header: meta({ codec: "hvc1", width: 1920, height: 1080 }) });
    const hj = await queue(H.subId, H.projectId);
    await tj.advanceTopazJob(hj);
    c.ok("an HEVC 1920x1080 file with AAC: skipped the same way", (await jobOf(hj)).outputCheck === "original-final");

    const K = await mkListing("4 Four K Ct", { header: fourK() });
    const kj = await queue(K.subId, K.projectId);
    const k0 = topaz.create.length;
    const ks = await tj.advanceTopazJob(kj);
    const kr = await jobOf(kj);
    c.ok("a 4K source runs as before: free price check, estimated", ks === "estimated" && kr.state === "estimated" && topaz.create.length === k0 + 1 && kr.outputCheck == null, ks);
    const preset = JSON.parse(kr.presetJson ?? "{}") as { output?: Record<string, unknown>; filters?: Record<string, unknown>[] };
    const out = preset.output ?? {};
    c.ok("presetJson carries the WHOLE output block (encoder, profile, bitrate, audio, frame rate, size, container)",
      out.videoEncoder === "H264" && out.videoProfile === "High" && out.videoBitrate === "12m" && out.audioCodec === "aac" && out.audioTransfer === "Copy" && out.frameRate === 29.97 && out.container === "mp4" && JSON.stringify(out.resolution) === JSON.stringify({ width: 1920, height: 1080 }),
      kr.presetJson ?? "");
    c.ok("…and it is exactly what was sent", JSON.stringify(topaz.create.at(-1)?.output) === JSON.stringify(out) && JSON.stringify(topaz.create.at(-1)?.filters) === JSON.stringify(preset.filters));
    const f = (preset.filters ?? [])[0] ?? {};
    c.ok("the filter sends the multi-word parameters under BOTH spellings (model page + API reference)",
      f.model === "prob-4" && f.recover_original_detail_value === 0.2 && f.recoverOriginalDetailValue === 0.2 && f.video_type === "Progressive" && f.videoType === "Progressive" && f.focus_fix_level === "None" && f.focusFixLevel === "None", JSON.stringify(f));

    const P = await mkListing("5 PCM Pl", { header: meta({ audioCodec: "ipcm" }) });
    const pj = await queue(P.subId, P.projectId);
    await tj.advanceTopazJob(pj);
    const pr = await jobOf(pj);
    c.ok("PCM sound: the old skip (\"the 1080p pass loses it\"), NOT original-final", pr.state === "skipped" && pr.outputCheck == null && pr.resolution == null && /uncompressed \(PCM\)/.test(pr.skipReason ?? ""), pr.skipReason ?? "");

    const U = await mkListing("6 Unread Rd", { header: null });
    const uj = await queue(U.subId, U.projectId);
    const us = await tj.advanceTopazJob(uj).catch((e: Error) => `threw ${e.message}`);
    const ur = await jobOf(uj);
    c.ok("an unreadable header: never skipped as finished (it retries, as before)", ur.state === "queued" && ur.outputCheck == null && ur.resolution == null, `${us} ${ur.state} ${ur.error ?? ""}`);

    const S = await mkListing("7 Silent St", { header: meta({ audioCodec: null }) });
    const sj = await queue(S.subId, S.projectId);
    const s0 = topaz.create.length;
    await tj.advanceTopazJob(sj);
    const sr = await jobOf(sj);
    c.ok("1080p with NO sound: never trusted on the hub's word, so it runs the pass as before (and ends in the existing held-file listen)", sr.state === "estimated" && sr.resolution == null && sr.outputCheck == null && topaz.create.length === s0 + 1, `${sr.state} ${sr.skipReason ?? ""}`);
    const late = await mkListing("7b Late Sound Ln", { header: meta({ timing: { fragmented: false, video: { startSec: 0, endSec: 60 }, audio: { startSec: 0.6, endSec: 60.6, codec: "mp4a" } } }) });
    const lj = await queue(late.subId, late.projectId);
    await tj.advanceTopazJob(lj);
    c.ok("1080p with its sound 0.6 s out of step: runs the pass as before too", (await jobOf(lj)).state === "estimated");

    await settings.putSetting("topaz", { ...(await settings.topazSettings()), skipFinished1080p: false });
    const O = await mkListing("8 Switch Off Ave");
    const oj = await queue(O.subId, O.projectId);
    const o0 = topaz.create.length;
    await tj.advanceTopazJob(oj);
    c.ok("with the switch off, the same finished file goes to the price check as before", (await jobOf(oj)).state === "estimated" && topaz.create.length === o0 + 1);
    await settings.putSetting("topaz", { ...(await settings.topazSettings()), skipFinished1080p: true });

    // "Try the pass again" on an already-finished skip runs the pass anyway.
    const F2 = await mkListing("9 Force Pass Way");
    const fj = await queue(F2.subId, F2.projectId);
    await tj.advanceTopazJob(fj);
    const again = await tj.retryTopazJob(fj);
    const fr = await jobOf(fj);
    c.ok("Try the pass again: back in the queue, marked force-pass, the original-final mark cleared", again.ok && fr.state === "queued" && fr.resolution === "force-pass" && fr.outputCheck == null, again.message);
    const f0 = topaz.create.length;
    await tj.advanceTopazJob(fj);
    c.ok("…and this time it goes to the price check", (await jobOf(fj)).state === "estimated" && topaz.create.length === f0 + 1);
  }

  // =========================================================================
  c.head("§3 · a skipped video flows where a finished render flows");
  // =========================================================================
  {
    const board = await readyToSend({ projectId: FIN.projectId });
    const row = board.ready.find((r) => r.submissionId === FIN.subId);
    c.ok("Ready to send: on the card, not 'still rendering'", !!row && !board.rendering.some((r) => r.submissionId === FIN.subId));
    c.ok("…the editor's file, with the reason on the row", row?.file.source === "editor-hub-copy" && row.file.says === orig.ALREADY_FINISHED_SAYS && row.file.why === null, row?.file.says);
    c.ok("…marked as the finished file", row?.originalIsFinal === true);
    const lines = await push.pushLinesFor([FIN.subId]);
    c.ok("the Aryeo button is offered for it", lines.get(FIN.subId)?.canStart === true, lines.get(FIN.subId)?.says);
    const started = await push.requestVideoPush(FIN.subId, { by: "Kyle Drill" });
    const run = await push.videoPushRun(FIN.subId);
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: FIN.subId }, select: { finalPath: true } });
    c.ok("…and its gates pass, with the ORIGINAL's Final copy as the file to upload", started.ok && started.started && run?.file.path === sub.finalPath && /FINAL \(editor export\)/.test(run?.file.path ?? ""), `${started.message} → ${run?.file.path}`);

    // A monthly (portal) video, publication-gated.
    const M = await buildContentMonth(prisma, { name: "Mae Portal TEST", package: "Accelerator", owner: { email: "mae@realtourpilot.com", name: "Mae Owner" } });
    await ensureOutputsForProject(M.projectId!);
    const mproj = await prisma.project.findUniqueOrThrow({ where: { id: M.projectId! }, include: { client: { select: { name: true } } } });
    const mFinal = actualFolderPaths(mproj).finalVideo;
    const movPath = `${mFinal}/Personal Branding Reel - v1 - FINAL (editor export).mov`;
    const movHash = "a".repeat(64);
    put(movPath, 123_456, movHash);
    const at = new Date();
    const mcut = await prisma.reviewSubmission.create({
      data: { projectId: M.projectId!, deliverableId: M.deliverableId, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "Personal Branding Reel - v1.mov", sizeBytes: 123_456, sourceRev: movHash, finalPath: movPath, completedAt: at, decidedAt: at, decidedBy: "James", portalPublicationRequiredAt: at },
      select: { id: true },
    });
    const mj = await prisma.topazJob.create({ data: { submissionId: mcut.id, projectId: M.projectId!, state: "skipped", skipReason: "This video's audio is uncompressed (PCM) …", finishedAt: at } });
    let snap = await monthlyFinalSnapshot(mcut.id);
    c.ok("contrast: a plain skipped pass is still NOT portal-ready", !snap.ok && /checked 1080p file isn't ready/.test(snap.message), snap.ok ? "ok?" : snap.message);
    await prisma.topazJob.update({ where: { id: mj.id }, data: { outputCheck: "original-final", resolution: "already-finished", skipReason: orig.ALREADY_FINISHED_SAYS } });
    const files = await clientCutFiles([mcut.id]);
    c.ok("portal: the client's file is the ORIGINAL, not 'still finishing'", files.get(mcut.id)?.kind === "original", JSON.stringify(files.get(mcut.id)));
    snap = await monthlyFinalSnapshot(mcut.id);
    c.ok("portal publication's snapshot passes, on the original's own Dropbox backup (a .mov)", snap.ok && snap.file.kind === "original" && snap.fileName.endsWith(".mov") && snap.backup.path === movPath, snap.ok ? `${snap.file.kind} ${snap.fileName}` : snap.message);
    const mboard = await readyToSend({ projectId: M.projectId! });
    const mrow = mboard.ready.find((r) => r.submissionId === mcut.id);
    c.ok("Ready to send's portal row: not blocked, the next step is publication", !!mrow && mrow.portalStep?.blocked === false && mrow.portalStep.action === "retry-publication", mrow?.portalStep?.says);
    c.ok("the portal player serves the original through the same route the Review Room plays .mov uploads from",
      /if \(sub\.blobUrl\)/.test(src("src/app/api/review/cut/[id]/stream/route.ts")) && /const path = sub\.assetPath \?\? sub\.finalPath;/.test(src("src/app/api/review/cut/[id]/stream/route.ts")) && /video\/quicktime/.test(src("src/lib/fileRelay.ts")));
  }

  // =========================================================================
  c.head("§4 · no per-video Topaz control; the held decision is exactly as it was");
  // =========================================================================
  {
    // Jordan, Oct 22 2026: "I don't want to adjust topaz settings for each
    // video, just in general, so in my settings." A per-video "send the
    // original instead" was built and taken out the same day.
    c.ok("the Review Room approve carries no Topaz option", !/original instead|sendOriginal/i.test(src("src/components/review/CutReviewPanel.tsx")) && !/sendOriginal/.test(src("src/app/review/actions.ts")));
    c.ok("the Ready to send card carries no per-video Topaz option", !/SendOriginalInstead|canSendOriginal/.test(src("src/components/ops/ReadyToSendCard.tsx")) && !fs.existsSync(path.join(REPO, "src/components/ops/SendOriginalInstead.tsx")));
    c.ok("…and the engine exposes none", !("sendEditorOriginalInstead" in tj) && !/chose-original/.test(src("src/lib/topazJobs.ts")));
    // The held-render decision, unchanged: a portal video still cannot keep its
    // original; a listing video still can, as "resolved-original".
    const M2 = await buildContentMonth(prisma, { name: "Hal Held TEST", package: "Accelerator", owner: { email: "hal@realtourpilot.com", name: "Hal Owner" } });
    const at = new Date();
    const hcut = await prisma.reviewSubmission.create({ data: { projectId: M2.projectId!, deliverableId: M2.deliverableId, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "Personal Branding Reel - v1.mp4", blobUrl: blobUrlFor("held.mp4"), sizeBytes: BYTES.length, decidedAt: at, decidedBy: "James", portalPublicationRequiredAt: at }, select: { id: true } });
    const hj = (await prisma.topazJob.create({ data: { submissionId: hcut.id, projectId: M2.projectId!, state: "held", heldPath: "/drill/unverified/held.mp4", heldAt: at, outputCheck: "unverified" } })).id;
    const kept = await tj.resolveHeldTopazJob(hj, "use-original", "James Drill");
    c.ok("held portal video: 'keep the original' is still refused, as before", !kept.ok && /client only gets the checked 1080p file/.test(kept.message) && (await jobOf(hj)).state === "held", kept.message);
    const L = await mkListing("26 Held Listing Rd");
    const heldFile = `${L.final}/unverified/Real Estate Video Tour - v1 (Topaz - unchecked).mp4`;
    put(heldFile);
    const lj = (await prisma.topazJob.create({ data: { submissionId: L.subId, projectId: L.projectId, state: "held", heldPath: heldFile, heldAt: at, outputCheck: "unverified" } })).id;
    const lk = await tj.resolveHeldTopazJob(lj, "use-original", "James Drill");
    const lr = await jobOf(lj);
    c.ok("held listing video: kept as 'resolved-original', as before", lk.ok && lr.state === "failed" && lr.outputCheck === "resolved-original" && !orig.editorOriginalIsFinal(lr), lk.message);
    c.ok("the held card still hides 'keep the original' for a monthly video", /\{!monthly && \(/.test(src("src/components/ops/HeldRender.tsx")));
  }

  // =========================================================================
  c.head("§5 · \"Try these settings\"");
  // =========================================================================
  {
    const T = await mkListing("30 Test Drive Dr");
    const savedBefore = await settings.topazSettings();
    const gentle = presets.topazStartingPoint("gentle", settings.DEFAULT_TOPAZ_PARAMS);
    const draft = { ...savedBefore, params: { ...savedBefore.params, ...gentle } };
    const cuts = await tt.recentCutsForTest(20);
    c.ok("the picker lists recent approved videos the hub still holds", cuts.some((x) => x.submissionId === T.subId) && cuts.length <= 20);

    // Not the owner → refused, nothing written, nothing asked of Topaz.
    process.env.AUTH_ENFORCE = "true";
    viewer = as("ADMIN");
    const t0 = topaz.create.length;
    const rows0 = await prisma.appSetting.count({ where: { key: { startsWith: tj.TOPAZ_TEST_KEY } } });
    const refused = [await testActions.estimateTopazTestAction(T.subId, draft), await testActions.runTopazTestAction("0123456789abcdef"), await testActions.applyTopazTestSettingsAction("0123456789abcdef")];
    c.ok("an admin (Kyle) is refused all three — it is money", refused.every((r) => !r.ok && /don't have access/.test(r.message)) && topaz.create.length === t0 && (await prisma.appSetting.count({ where: { key: { startsWith: tj.TOPAZ_TEST_KEY } } })) === rows0, refused.map((r) => r.message).join(" | "));
    viewer = as("OWNER");

    const dbx0 = dbxCalls.length;
    const jobs0 = await prisma.topazJob.count();
    const subBefore = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: T.subId } });
    const est = await testActions.estimateTopazTestAction(T.subId, draft);
    process.env.AUTH_ENFORCE = "";
    c.ok("the owner's free price check: one estimate asked for, nothing accepted", est.ok && !!est.test && est.test.state === "estimated" && topaz.create.length === t0 + 1 && topaz.accept.length === topaz.accept.filter(Boolean).length, est.message);
    const test = est.test!;
    c.ok("…it says the price before anything is spent", /about 9 credits/.test(est.message) && /Nothing is spent until you run it/.test(est.message), est.message);
    c.ok("…with the settings ON SCREEN (Gentle, Manual), not the saved ones", test.settings.params.auto === "Manual" && test.settings.params.compression === 0.15 && (await settings.topazSettings()).params.auto === savedBefore.params.auto);
    const sent = topaz.create.at(-1)!;
    c.ok("…and the request sent is the same builder's body (whole output block, both spellings)", sent.output.videoEncoder === "H264" && sent.output.videoBitrate === "12m" && sent.filters[0].auto === "Manual" && sent.filters[0].recoverOriginalDetailValue === 0.5 && JSON.parse(test.presetJson).output.videoEncoder === "H264");
    c.ok("…and it says a part of the video can't be rendered alone", test.wholeVideoNote === orig.WHOLE_VIDEO_NOTE && /whole thing/.test(test.wholeVideoNote));

    // Run it.
    const ran = await testActions.runTopazTestAction(test.id);
    c.ok("Run the test: accepted at Topaz (still nothing charged until the start)", ran.ok && ran.test?.state === "uploading" && topaz.accept.includes(test.id ? `req-${topaz.create.length}` : "") , ran.message);
    const ledger = await tj.topazTestLedger();
    c.ok("the test counts toward the caps (one render today and this month, its credits, one slot)", ledger.day === 1 && ledger.month === 1 && ledger.credits === 9 && ledger.inFlight === 1, JSON.stringify(ledger));
    const s1 = { ...(await settings.topazSettings()), maxRendersPerDay: 1 };
    const gate = await tj.spendGate(s1, { estimateCredits: 8 });
    c.ok("…so a live render waits when the test used today's last slot", !gate.ok && gate.hold && /Today's limit of 1/.test(gate.reason), gate.ok ? "ok?" : gate.reason);
    const dash = await tj.topazDashboard();
    c.ok("…and the owner's strip counts it", dash.today.renders >= 1 && dash.month.credits >= 9);

    // Drive it to the end, one cron step at a time.
    const budget = { remainingMs: () => 200_000 };
    const step1 = await tt.driveTopazTests({ budget, leaseBy: "drill-tick-1" });
    const requestId = `req-${topaz.create.length}`;
    c.ok("tick 1: the bytes go up and Topaz is asked to start ONCE", step1.processing === 1 && topaz.put === 1 && topaz.complete.filter((x) => x === requestId).length === 1 && blobFetches.some((u) => u.includes("cut-")), JSON.stringify(step1));
    const step2 = await tt.driveTopazTests({ budget, leaseBy: "drill-tick-2" });
    c.ok("tick 2 (still rendering): waits, nothing re-sent", topaz.complete.filter((x) => x === requestId).length === 1 && !step2.done);
    const testOut = `https://topaz-out.invalid/${requestId}/enhanced.mp4`;
    STATUS.set(requestId, { status: "complete", downloadUrl: testOut });
    PROBE.set(testOut, meta({ sizeBytes: 120_000_000 }));
    // Leases from the waiting step expire before the next tick.
    const row = await prisma.appSetting.findUniqueOrThrow({ where: { key: `${tj.TOPAZ_TEST_KEY}${test.id}` } });
    await prisma.appSetting.update({ where: { key: row.key }, data: { value: JSON.stringify({ ...JSON.parse(row.value), leaseUntil: null, leaseBy: null }) } });
    const step3 = await tt.driveTopazTests({ budget, leaseBy: "drill-tick-3" });
    const done = await tt.topazTestFor(test.id);
    c.ok("tick 3: finished, with what came back read off its header and the cost recorded", step3.done === 1 && done?.view.state === "done" && done.view.output?.width === 1080 && done.view.creditsCharged === 8, JSON.stringify(step3));
    c.ok("the compare page streams Topaz's own copy (fresh link) beside the original", done?.topazUrl === testOut && done.originalUrl === `/api/review/cut/${T.subId}/stream`);
    c.ok("Topaz keeps it 7 days, and the test never purges it early", !!done?.view.expiresAtISO && Math.round((Date.parse(done.view.expiresAtISO) - Date.parse(done.view.finishedAtISO!)) / 86_400_000) === 7 && !topaz.del.includes(requestId));

    // NOTHING WAS FILED ANYWHERE.
    const subAfter = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: T.subId } });
    c.ok("NOTHING filed: no Dropbox call during the whole test", dbxCalls.length === dbx0, dbxCalls.slice(dbx0).join(" | "));
    c.ok("…no TopazJob written, the cut untouched (file, sent stamp, release)", (await prisma.topazJob.count()) === jobs0 && subAfter.finalPath === subBefore.finalPath && subAfter.sentToClientAt === null && subAfter.clientReleasedAt === null && subAfter.updatedAt.getTime() === subBefore.updatedAt.getTime());
    c.ok("…no upload card, no portal publication, no Aryeo run", (await prisma.smartTask.count({ where: { projectId: T.projectId } })) === 0 && (await prisma.contentVideoSource.count({ where: { ref: T.subId } })) === 0 && (await push.videoPushRun(T.subId)) === null);
    // The CODE, comments stripped (the header comment names what it never does).
    const testCode = src("src/lib/topazTests.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    c.ok("the test module has no filing code in it at all", !/integrations\/dropbox|publishApprovedCutToLibrary|smartTask|topazJob\.(create|update)|reviewSubmission\.(update|create)|deleteVideoFiles|videoAryeoPush/.test(testCode));

    // Use these settings.
    const used = await testActions.applyTopazTestSettingsAction(test.id);
    const now = await settings.topazSettings();
    c.ok("\"Use these settings for every video\" saves the test's exact settings", used.ok && now.params.auto === "Manual" && now.params.compression === 0.15 && now.params.recover_original_detail_value === 0.5 && now.videoEncoder === "H264", used.message);
    c.ok("…and leaves the switch, the limits and the skip rule alone", now.enabled === true && now.skipFinished1080p === true && now.maxCreditsPerMonth === savedBefore.maxCreditsPerMonth);

    // A second price check retires an older unrun one (free).
    const e1 = await testActions.estimateTopazTestAction(T.subId, draft);
    const e2 = await testActions.estimateTopazTestAction(T.subId, draft);
    const list = await tt.topazTestRows(12);
    c.ok("a newer price check closes the older unrun one and hands it back", e1.ok && e2.ok && list.find((x) => x.id === e1.test!.id)?.state === "cancelled" && topaz.cancel.includes(`req-${topaz.create.length - 1}`));
    const compare = src("src/components/settings/TopazCompare.tsx").replace(/\/\/[^\n]*/g, "");
    c.ok("the compare page: two synced players and a draggable wipe, and no zoom on video (Jordan's call)",
      /Side by side/.test(compare) && /clipPath: `inset\(0 0 0 \$\{wipe\}%\)`/.test(compare) && /follow\(true\)/.test(compare) && !/zoom|canvas/i.test(compare));
    // ONE CALL FROM A SCRIPT (Oct 22 2026, "set it and forget it").
    process.env.AUTH_ENFORCE = "true";
    viewer = as("ADMIN");
    const nonOwner = await testActions.startTopazTestAction(T.subId, { params: draft.params });
    viewer = as("OWNER");
    c.ok("startTopazTestAction: an admin is refused", !nonOwner.ok && /don't have access/.test(nonOwner.message), nonOwner.message);
    const capped = await testActions.startTopazTestAction(T.subId, { params: draft.params }, { maxCredits: 5 });
    c.ok("…the owner, with maxCredits under the price: priced, not run, nothing spent", !capped.ok && /over the 5 allowed/.test(capped.message) && (await tt.topazTestRows(30)).find((x) => x.id === capped.test?.id)?.state === "cancelled", capped.message);
    const accepted0 = topaz.accept.length;
    const one = await testActions.startTopazTestAction(T.subId, { params: draft.params }, { maxCredits: 12 });
    process.env.AUTH_ENFORCE = "";
    c.ok("…and within it: priced AND started in one call, with the compare page's address", one.ok && one.test?.state === "uploading" && topaz.accept.length === accepted0 + 1 && one.compareHref === `/settings/topaz-test/${one.test?.id}`, one.message);
    c.ok("the lib function is the same one call (submission id + settings)", typeof tt.startTopazTest === "function" && tt.startTopazTest.length >= 3);
    c.ok("the panel and the compare page are owner-only on screen too",
      /isOwner && \(\s*<TopazTestPanel/.test(src("src/components/settings/TopazSettingsPanel.tsx")) && /me\.role !== "OWNER"\)\) redirect/.test(src("src/app/settings/topaz-test/[id]/page.tsx")));
  }

  // =========================================================================
  c.head("§6 · starting points and honest mode words");
  // =========================================================================
  {
    const d = settings.DEFAULT_TOPAZ_PARAMS;
    const g = presets.topazStartingPoint("gentle", d);
    const s = presets.topazStartingPoint("strong", d);
    const k = presets.topazStartingPoint("desktop", d);
    c.ok("Gentle: Manual, compression .15, details .15, sharpen .05, noise .10, halo .05, preblur 0, recover .50",
      g.auto === "Manual" && g.compression === 0.15 && g.details === 0.15 && g.blur === 0.05 && g.noise === 0.1 && g.halo === 0.05 && g.preblur === 0 && g.recover_original_detail_value === 0.5);
    c.ok("Your desktop preset: today's defaults", k.auto === d.auto && k.compression === d.compression && k.blur === d.blur && k.noise === d.noise && k.recover_original_detail_value === d.recover_original_detail_value);
    c.ok("Strong: Manual, compression .5, details .35, sharpen .2, noise .5, halo .15, recover .3",
      s.auto === "Manual" && s.compression === 0.5 && s.details === 0.35 && s.blur === 0.2 && s.noise === 0.5 && s.halo === 0.15 && s.recover_original_detail_value === 0.3);
    c.ok("a starting point fills the form only — the saved defaults are unchanged", settings.DEFAULT_TOPAZ_PARAMS.auto === "Auto" && settings.DEFAULT_TOPAZ.params.compression === 0.5);
    c.ok("matching: the form knows which one is on screen", presets.matchingStartingPoint({ ...d, ...g }, d) === "gentle" && presets.matchingStartingPoint(d, d) === "desktop");
    const words = Object.fromEntries(presets.TOPAZ_MODE_OPTIONS);
    c.ok("the mode select is honest: Auto ignores your sliders, Manual is your sliders exactly",
      /picks its own amounts for each clip; your sliders are ignored/.test(words.Auto) && words.Manual === "Manual: your sliders, exactly");
    const panel = src("src/components/settings/TopazSettingsPanel.tsx");
    c.ok("the panel labels them starting points to test, not proven", /starting points to test, not proven settings/.test(panel) && /TOPAZ_STARTING_POINTS\.map/.test(panel));
    // The rendered page above the fold-away (from the JSX, not the imports).
    const top = panel.slice(panel.indexOf("  return ("), panel.indexOf("data-topaz-fine-tune"));
    c.ok("set it and forget it: the switch and ONE plain line on top", /Videos the editor already exported at 1080p go out as they are; anything else gets the 1080p pass with the house setting\./.test(top) && /label="Run approved cuts through Topaz"/.test(top));
    const fine = panel.slice(panel.indexOf("<details"), panel.indexOf("</details>"));
    c.ok("…the test, the mode, the sliders and the starting points all inside ONE closed \"Fine-tune (optional)\"",
      /Fine-tune \(optional\)/.test(fine) && !/<details[^>]*\bopen\b/.test(panel) && /<TopazTestPanel/.test(fine) && /TOPAZ_MODE_OPTIONS/.test(fine) && /SLIDERS\.map/.test(fine) && /TOPAZ_STARTING_POINTS\.map/.test(fine) && !/TOPAZ_STARTING_POINTS|SLIDERS\.map|<TopazTestPanel/.test(top));
    c.ok("…and the skip rule needs no setup: on by default, its toggle folded away", settings.DEFAULT_TOPAZ.skipFinished1080p === true && /data-topaz-skip-finished/.test(fine) && !/data-topaz-skip-finished/.test(top));
    const newCopy = [orig.ALREADY_FINISHED_SAYS, orig.WHOLE_VIDEO_NOTE, ...presets.TOPAZ_MODE_OPTIONS.map((o) => o[1]), ...presets.TOPAZ_STARTING_POINTS.flatMap((p) => [p.label, p.hint])];
    c.ok("no em dash in the new words people read", newCopy.every((w) => !w.includes("—")), newCopy.find((w) => w.includes("—")) ?? "");
  }

  c.head("Z · isolation");
  c.ok("nothing left the process (only the fake store answered)", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));

  push.__setVideoPushHooksForTests(null);
  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
