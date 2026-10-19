// ---------------------------------------------------------------------------
// DRILL topaz-sound-hold — the finished file's SOUND, from its header, before
// it can reach a client (Oct 16 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/topaz-sound-hold.ts --logs <dir>
//
// Drives the SHIPPED 1080p lane (src/lib/topazJobs.ts advanceTopazJob,
// recheckHeldTopazJob, resolveHeldTopazJob, topazJobForSubmission) and the
// exported final-file check (src/lib/finalRendition.ts finalFileSoundCheck /
// judgeFinalSound) against an isolated PGlite. Topaz and Dropbox are replaced
// at the module boundary (as b1-readiness-topaz does): what each URL's header
// READS AS is set per file, including the new `timing` (lib/mp4Probe's
// AvTiming) that probeVideoMetadata now returns from the moov it already
// fetched. Nothing is rendered, charged, uploaded or sent.
//
//   §1 the rule, pure: judgeOutputSound (topazJobs) and judgeFinalSound
//   §2 sound out of step in the RENDER only → failed, nothing filed, the
//      editor's original is the one to send (the pass broke it)
//   §3 out of step in the editor's export too → HELD, with the reason in
//      plain words on the row, the card, the bell and the timeline
//   §4 no sound at all, nor in the export → HELD
//   §5 within 0.3 s, and a header with no timing → filed exactly as before
//   §6 the held file: a re-read keeps it held and says why; a person who
//      listened can still use it
//   §7 finalFileSoundCheck: the client-bound file (render or original) read
//      for sound; a person's choice stands; unfinished = unchecked
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import type { AvTiming } from "../../src/lib/mp4Probe";

const PORT = Number(process.env.DRILL_PORT ?? 5613);
installNextStubs();

const slackPosts: string[] = [];
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  slackPosts.push(body.text ?? "");
  return new Response(JSON.stringify({ ok: true, ts: "1.1", channels: [] }), { status: 200, headers: { "content-type": "application/json" } });
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

// ---- what each file's header reads as --------------------------------------------
type Meta = { width: number; height: number; frameRate: number; frameCount: number; durationSec: number; container: string; codec: string; sizeBytes: number; audio: { present: boolean; codec: string | null }; timing?: AvTiming | null };
const av = (o: { audioStart?: number; audioEnd?: number; video?: number; noAudio?: boolean } = {}): AvTiming => ({
  fragmented: false,
  video: { startSec: 0, endSec: o.video ?? 60 },
  audio: o.noAudio ? null : { startSec: o.audioStart ?? 0, endSec: o.audioEnd ?? 60, codec: "mp4a" },
});
const meta = (o: { audio?: boolean; timing?: AvTiming | null } = {}): Meta => {
  const audio = o.audio ?? true;
  return { width: 1920, height: 1080, frameRate: 30, frameCount: 1800, durationSec: 60, container: "mp4", codec: "avc1", sizeBytes: 40_000_000, audio: { present: audio, codec: audio ? "mp4a" : null }, ...(o.timing !== undefined ? { timing: o.timing } : {}) };
};
const PROBE = new Map<string, Meta>();
/** Every Dropbox copy of a job's file (the held one under unverified/, the
 *  filed one) reads as this — the second, independent read of the same file. */
const DROPBOX_READS_AS = new Map<string, Meta>();
const probeCalls: string[] = [];
const topazOut = (requestId: string) => `https://topaz.invalid/out/${requestId}.mp4`;
const dbxTmp = (p: string) => `https://dbx.invalid/tmp${p}`;
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
            probeCalls.push(url);
            const a = PROBE.get(url) ?? (url.startsWith("https://dbx.invalid/") ? [...DROPBOX_READS_AS].find(([street]) => url.includes(street))?.[1] : undefined);
            if (!a) throw new E("Couldn't read the video file (503).", 503, true);
            return a;
          };
        case "createVideoRequest": case "acceptVideoRequest": case "completeUpload":
          return async () => { throw new Error("drill: no spend-bearing Topaz call may happen here"); };
        case "deleteVideoFiles": case "cancelVideoRequest": case "cancelEstimate": return async () => true;
        default: return t[k];
      }
    },
  })),
);
const FS = new Map<string, number>();
interceptModule(
  (r) => isMod(r, "integrations/dropbox"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      const DErr = t.DropboxError as new (msg: string, status?: number) => Error;
      if (k === "dropboxConfigured") return () => true;
      if (k !== "dbx") return t[k];
      return async (ep: string, arg: Record<string, unknown> = {}) => {
        const p = String(arg.path ?? "");
        switch (ep) {
          case "files/create_folder_v2": return { metadata: { path_display: p } };
          case "files/save_url":
            if (FS.has(p)) throw new DErr("path/conflict/file/", 409);
            FS.set(p, 40_000_000);
            return { ".tag": "complete" };
          case "files/save_url/check_job_status": return { ".tag": "complete" };
          case "files/get_metadata":
            if (!FS.has(p)) throw new DErr("path/not_found/", 409);
            return { size: FS.get(p) };
          case "files/get_temporary_link":
            if (!FS.has(p)) throw new DErr("path/not_found/", 409);
            return { link: dbxTmp(p) };
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
interceptModule(
  (r) => isMod(r, "settings"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      if (k !== "topazSettings") return t[k];
      return async () => ({ ...(await (t.topazSettings as () => Promise<Record<string, unknown>>)()), enabled: true });
    },
  })),
);

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const tj = await import("@/lib/topazJobs");
  const fr = await import("@/lib/finalRendition");
  const { HELD_ATTESTATION } = await import("@/lib/topazHold");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { readyToSend } = await import("@/lib/readyToSend");

  const client = await prisma.client.create({ data: { name: "Drill Client TEST" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "ADMIN" } });

  // =========================================================================
  c.head("§1 · the rule, pure");
  // =========================================================================
  {
    const inStep = async () => ({ hasAudio: true, codec: "mp4a", startGapSec: 0, endGapSec: 0.02 });
    const alsoOff = async () => ({ hasAudio: true, codec: "mp4a", startGapSec: 0.5, endGapSec: 0.5 });
    const unknown = async () => null;
    const late = meta({ timing: av({ audioStart: 0.5, audioEnd: 60.5 }) });
    const a = await tj.judgeOutputSound(late, { present: true, codec: "mp4a" }, inStep);
    c.ok("render 0.5 s late, approved cut in step → mismatch (the pass broke it)", a?.verdict === "mismatch" && /the sound starts 0\.5 s after the picture; the approved cut's lines up/.test(a.reason), JSON.stringify(a));
    const b = await tj.judgeOutputSound(late, { present: true, codec: "mp4a" }, alsoOff);
    c.ok("…and the cut is just as late → sound (hold): \"…, in the editor's export too\"", b?.verdict === "sound" && b.reason === "the sound starts 0.5 s after the picture, in the editor's export too", JSON.stringify(b));
    const u = await tj.judgeOutputSound(late, { present: true, codec: "mp4a" }, unknown);
    c.ok("…the cut can't be re-read → sound (hold), with no claim about the export", u?.verdict === "sound" && u.reason === "the sound starts 0.5 s after the picture", JSON.stringify(u));
    let asked = 0;
    const fine = await tj.judgeOutputSound(meta({ timing: av({ audioEnd: 59.75 }) }), { present: true, codec: "mp4a" }, async () => { asked++; return null; });
    c.ok("0.25 s apart: nothing (and the source isn't even re-read)", fine === null && asked === 0);
    const edge = await tj.judgeOutputSound(meta({ timing: av({ audioEnd: 59.7 }) }), { present: true, codec: "mp4a" }, unknown);
    const over = await tj.judgeOutputSound(meta({ timing: av({ audioEnd: 59.69 }) }), { present: true, codec: "mp4a" }, unknown);
    c.ok("0.30 s exactly: nothing; 0.31 s: held", edge === null && over?.verdict === "sound", JSON.stringify(over));
    c.ok("no timing in the header (an older probe, a fragmented file): judged as before", (await tj.judgeOutputSound(meta(), { present: true, codec: "mp4a" }, unknown)) === null && (await tj.judgeOutputSound(meta({ timing: { ...av({ audioStart: 2 }), fragmented: true } }), { present: true, codec: "mp4a" }, unknown)) === null);
    const silent = await tj.judgeOutputSound(meta({ audio: false }), { present: false, codec: null }, unknown);
    c.ok("no sound in the render AND none in the export → sound (hold)", silent?.verdict === "sound" && silent.reason === "it has no sound at all, and neither has the editor's export");
    c.ok("no sound in the render, export HAD sound → left to the older rule (lost)", (await tj.judgeOutputSound(meta({ audio: false }), { present: true, codec: "mp4a" }, unknown)) === null);

    const j = fr.judgeFinalSound;
    c.ok("judgeFinalSound: in step → ok", j({ audio: { present: true, codec: "mp4a" }, timing: av() }).verdict === "ok");
    const h1 = j({ audio: { present: true, codec: "mp4a" }, timing: av({ audioEnd: 59.4 }) });
    c.ok("…0.6 s short → hold: \"Held: the audio ends 0.6 s before the picture. Ask the editor for a new export…\"", h1.verdict === "hold" && h1.message.startsWith("Held: the audio ends 0.6 s before the picture. Ask the editor for a new export"), h1.message);
    const h2 = j({ audio: { present: false, codec: null }, timing: av({ noAudio: true }) });
    c.ok("…no sound → hold: \"Held: this video has no sound.…\"", h2.verdict === "hold" && h2.message.startsWith("Held: this video has no sound."), h2.message);
    c.ok("…unreadable → unchecked (never a hold)", j(null).verdict === "unchecked");
    c.ok("…sound present but no timing → unchecked (never a hold)", j({ audio: { present: true, codec: "mp4a" } }).verdict === "unchecked" && j({ audio: { present: true, codec: "mp4a" }, timing: null }).verdict === "unchecked");
  }

  // ---- a finished render waiting on its check -----------------------------------
  let n = 0;
  async function mkRender(o: { street: string; out: Meta | null; source: Meta | null; sourceHasAudio?: boolean }) {
    n++;
    const folder = `/Listings/Drill/${o.street}`;
    const p = await prisma.project.create({ data: { title: `${o.street}, Media, PA`, clientId: client.id, status: "REVIEW", source: "ARYEO", aryeoListingId: `lst-snd-${n}`, dropboxFolder: folder }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
    const final = actualFolderPaths({ dropboxFolder: folder } as Parameters<typeof actualFolderPaths>[0]).finalVideo;
    const original = `${final}/Real Estate Video Tour - v1.mp4`;
    FS.set(original, 90_000_000);
    const blobUrl = `https://drill.invalid/cuts/snd-${n}.mp4`;
    if (o.source) PROBE.set(blobUrl, o.source);
    const sub = await prisma.reviewSubmission.create({
      data: { projectId: p.id, deliverableId: d.id, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "Real Estate Video Tour - v1.mp4", blobUrl, sizeBytes: 90_000_000, finalPath: original, completedAt: new Date(Date.now() - 3_600_000), decidedAt: new Date(Date.now() - 3_600_000), decidedBy: "James" },
      select: { id: true },
    });
    const requestId = `req-snd-${n}`;
    if (o.out) PROBE.set(topazOut(requestId), o.out);
    const job = await prisma.topazJob.create({
      data: {
        projectId: p.id, submissionId: sub.id, state: "processing", requestId,
        acceptedAt: new Date(Date.now() - 1_800_000), completeUploadAt: new Date(Date.now() - 1_500_000), startedAt: new Date(Date.now() - 1_900_000),
        sourceWidth: 3840, sourceHeight: 2160, sourceFrameRate: 30, sourceFrameCount: 1800, sourceDurationSec: 60, sourceContainer: "mp4", sourceSizeBytes: 90_000_000,
        outputWidth: 1920, outputHeight: 1080, estimateCredits: 27, sourceHasAudio: o.sourceHasAudio ?? true, sourceAudioCodec: (o.sourceHasAudio ?? true) ? "mp4a" : null,
      },
      select: { id: true },
    });
    return { jobId: job.id, subId: sub.id, projectId: p.id, original, final, requestId, street: o.street };
  }
  const jobRow = (id: string) => prisma.topazJob.findUniqueOrThrow({ where: { id } });
  const deliverTasks = (jobId: string) => prisma.smartTask.count({ where: { dedupeKey: `topaz-deliver-${jobId}` } });
  const drive = async (id: string, k: number) => { const seen: string[] = []; for (let i = 0; i < k; i++) seen.push(await tj.advanceTopazJob(id)); return seen; };

  // =========================================================================
  c.head("§2 · out of step in the render only → failed, the original is the one to send");
  // =========================================================================
  {
    const R = await mkRender({ street: "40 Drift Ln", out: meta({ timing: av({ audioStart: 0.5, audioEnd: 60.5 }) }), source: meta({ timing: av({ audioEnd: 60.02 }) }) });
    const s = await tj.advanceTopazJob(R.jobId);
    const r = await jobRow(R.jobId);
    c.ok("failed at once, never filed", s === "failed" && r.state === "failed" && !r.finalPath && ![...FS.keys()].some((k) => k.includes("40 Drift Ln") && /Topaz/.test(k)), `${s} ${r.error}`);
    c.ok("…in words: the pass came back with its sound out of step; the original is still good to send", /came back with its sound out of step with the picture \(the sound starts 0\.5 s after the picture; the approved cut's lines up\)/.test(r.error ?? "") && /original is still good to send/.test(r.error ?? ""), r.error ?? "");
    const rec = JSON.parse(r.outputCheckJson ?? "{}") as { verdict?: string; output?: { av?: { startGapSec: number } }; sourceAv?: { startGapSec: number } };
    c.ok("the record keeps both measurements (render +0.5 s, cut 0 s)", rec.verdict === "mismatch" && rec.output?.av?.startGapSec === 0.5 && rec.sourceAv?.startGapSec === 0, r.outputCheckJson ?? "");
    c.ok("Kyle was handed nothing", (await deliverTasks(R.jobId)) === 0);
  }

  // =========================================================================
  c.head("§3 · out of step in the editor's export too → HELD, with the reason");
  // =========================================================================
  let H: Awaited<ReturnType<typeof mkRender>>;
  {
    const late = meta({ timing: av({ audioStart: 0.5, audioEnd: 60.5 }) });
    H = await mkRender({ street: "41 Late Sound Ave", out: late, source: late });
    DROPBOX_READS_AS.set("41 Late Sound Ave", late);
    const seen = await drive(H.jobId, 3);
    const r = await jobRow(H.jobId);
    c.ok("no retries (it is a measurement): saving, then held", seen.slice(0, 2).join(",") === "saving,held", seen.join(" → "));
    c.ok("held: NOT finalPath, NOT savedAt, the file in Final/unverified/", r.state === "held" && !r.finalPath && !r.savedAt && !!r.heldPath && r.heldPath.includes("/unverified/"), r.heldPath ?? "");
    c.ok("the original was never moved; Kyle handed nothing", FS.has(H.original) && (await deliverTasks(H.jobId)) === 0);
    const rec = JSON.parse(r.outputCheckJson ?? "{}") as { verdict?: string; reason?: string; where?: string };
    c.ok("the record: verdict sound, read from the Dropbox copy, the reason in words", rec.verdict === "sound" && rec.where === "dropbox" && rec.reason === "the sound starts 0.5 s after the picture, in the editor's export too", r.outputCheckJson ?? "");
    const view = await tj.topazJobForSubmission(H.subId);
    c.ok("the lane says WHY: \"Finished, but its sound is wrong: the sound starts 0.5 s after the picture, in the editor's export too — held …\"", /^Finished, but its sound is wrong: the sound starts 0\.5 s after the picture, in the editor's export too — held until someone listens/.test(view?.says ?? ""), view?.says ?? "");
    const act = await prisma.activity.findMany({ where: { projectId: H.projectId, body: { startsWith: "1080p file HELD" } }, select: { body: true } });
    c.ok("the timeline: \"1080p file HELD — its sound is wrong: …\"", act.length === 1 && act[0].body.startsWith("1080p file HELD — its sound is wrong: the sound starts 0.5 s after the picture"), act.map((a) => a.body).join(" | "));
    const bells = await prisma.notification.findMany({ where: { kind: "topaz_problem", dedupeKey: { startsWith: `topaz-held-${H.jobId}` } }, select: { body: true, dedupeKey: true } });
    c.ok("Jordan's and James's bell: the reason and the way out, inside 140 characters", bells.some((b) => b.body === "The sound starts 0.5 s after the picture, in the editor's export too. Listen, then use it or ask for a new export."), bells.map((b) => b.body).join(" | "));
    const kyle = await prisma.notification.findMany({ where: { kind: "topaz_problem", dedupeKey: { startsWith: `topaz-held-kyle-${H.jobId}` } }, select: { body: true } });
    c.ok("Kyle's own notice names the reason too", kyle.length >= 1 && kyle.every((b) => /^Its sound is wrong: the sound starts 0\.5 s after the picture/.test(b.body ?? "")), kyle.map((b) => b.body).join(" | "));
    const board = await readyToSend({ projectId: H.projectId });
    c.ok("the ready card never offers it as the file to send", !board.ready.some((x) => x.submissionId === H.subId));
  }

  // =========================================================================
  c.head("§4 · no sound at all, nor in the export → HELD");
  // =========================================================================
  {
    const mute = meta({ audio: false, timing: av({ noAudio: true }) });
    const S = await mkRender({ street: "42 Mute Ct", out: mute, source: mute, sourceHasAudio: false });
    DROPBOX_READS_AS.set("42 Mute Ct", mute);
    await drive(S.jobId, 3);
    const r = await jobRow(S.jobId);
    c.ok("held, with \"it has no sound at all, and neither has the editor's export\"", r.state === "held" && /"reason":"it has no sound at all, and neither has the editor's export"/.test(r.outputCheckJson ?? ""), `${r.state} ${r.outputCheckJson}`);
  }

  // =========================================================================
  c.head("§5 · in step, or no timing to read → filed exactly as before");
  // =========================================================================
  {
    const ok = await mkRender({ street: "43 Steady St", out: meta({ timing: av({ audioEnd: 60.2 }) }), source: meta({ timing: av() }) });
    const seen = await drive(ok.jobId, 2);
    const r = await jobRow(ok.jobId);
    c.ok("0.2 s apart: verified → done, one upload card for Kyle", r.state === "done" && r.outputCheck === "verified" && !!r.finalPath && (await deliverTasks(ok.jobId)) === 1, seen.join(" → "));
    const old = await mkRender({ street: "44 Old Probe Rd", out: meta(), source: meta() });
    const before = probeCalls.length;
    await drive(old.jobId, 2);
    const ro = await jobRow(old.jobId);
    c.ok("a header with no timing: done as before, and the source is NOT re-read", ro.state === "done" && ro.outputCheck === "verified" && !probeCalls.slice(before).includes(`https://drill.invalid/cuts/snd-${n}.mp4`));
  }

  // =========================================================================
  c.head("§6 · the held file afterwards");
  // =========================================================================
  {
    const again = await tj.recheckHeldTopazJob(H.jobId, "Kyle Drill");
    const r = await jobRow(H.jobId);
    c.ok("a re-read: still held, and it says why — not \"keep the approved original\"", !again.ok && r.state === "held" && again.message.startsWith("It reads, and its sound is still wrong: the sound starts 0.5 s after the picture") && /new export/.test(again.message), again.message);
    const use = await tj.resolveHeldTopazJob(H.jobId, "accept-processed", "Kyle Drill", { attest: HELD_ATTESTATION });
    const r2 = await jobRow(H.jobId);
    c.ok("a person who listened can still use it (their call, on the record)", use.ok && r2.state === "done" && r2.outputCheck === "resolved-processed", use.message);
  }

  // =========================================================================
  c.head("§7 · finalFileSoundCheck — the file the client would get");
  // =========================================================================
  {
    // The render a person chose (§6): theirs, not re-judged.
    const chosen = await fr.finalFileSoundCheck(H.subId, { probe: async () => { throw new Error("drill: must not read"); } });
    c.ok("a 1080p file a person listened to and chose: ok, without reading it again", chosen.verdict === "ok" && /listened to this 1080p file and chose it/.test(chosen.message), chosen.message);

    // A verified render: its Dropbox copy is what is read.
    const V = await mkRender({ street: "45 Verified Way", out: meta({ timing: av() }), source: meta({ timing: av() }) });
    await drive(V.jobId, 2);
    const vr = await jobRow(V.jobId);
    const readUrls: string[] = [];
    const reads = (m: Meta | null) => async (url: string) => { readUrls.push(url); return m; };
    const okV = await fr.finalFileSoundCheck(V.subId, { probe: reads(meta({ timing: av() })) });
    c.ok("a filed render: its Dropbox copy is the one read → ok", okV.verdict === "ok" && readUrls.at(-1) === dbxTmp(vr.finalPath!), `${okV.verdict} ${readUrls.at(-1)}`);
    const heldV = await fr.finalFileSoundCheck(V.subId, { probe: reads(meta({ timing: av({ audioEnd: 59.4 }) })) });
    c.ok("…the same file reading 0.6 s short → hold, in plain words", heldV.verdict === "hold" && heldV.message === "Held: the audio ends 0.6 s before the picture. Ask the editor for a new export before it goes to the client.", heldV.message);

    // No render (lane off / skipped): the hub's copy of the editor's upload.
    const p = await prisma.project.create({ data: { title: "46 Original Rd, Media, PA", clientId: client.id, status: "REVIEW" }, select: { id: true } });
    const sub = await prisma.reviewSubmission.create({ data: { projectId: p.id, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "v1.mp4", blobUrl: "https://drill.invalid/cuts/original-46.mp4", assetPath: null }, select: { id: true } });
    const mute = await fr.finalFileSoundCheck(sub.id, { probe: reads(meta({ audio: false, timing: av({ noAudio: true }) })) });
    c.ok("no render: the editor's upload is read (its own URL) → no sound → hold", mute.verdict === "hold" && readUrls.at(-1) === "https://drill.invalid/cuts/original-46.mp4" && mute.message.startsWith("Held: this video has no sound."), `${mute.verdict} ${readUrls.at(-1)}`);
    const unread = await fr.finalFileSoundCheck(sub.id, { probe: reads(null) });
    c.ok("unreadable → unchecked, never a hold", unread.verdict === "unchecked", unread.message);
    const thrown = await fr.finalFileSoundCheck(sub.id, { probe: async () => { throw new Error("503"); } });
    c.ok("a reader that throws → unchecked, never a throw", thrown.verdict === "unchecked");

    // A render still running: there is no final file yet.
    const W = await mkRender({ street: "47 Waiting Way", out: null, source: meta() });
    const waiting = await fr.finalFileSoundCheck(W.subId, { probe: async () => { throw new Error("drill: must not read"); } });
    c.ok("the 1080p pass still running → unchecked (\"no final file to check yet\")", waiting.verdict === "unchecked" && /hasn't finished/.test(waiting.message), waiting.message);
    c.ok("a cut that doesn't exist → unchecked", (await fr.finalFileSoundCheck("nope-not-a-cut")).verdict === "unchecked");
  }

  c.head("Z · isolation");
  c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
