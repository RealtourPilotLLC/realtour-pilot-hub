// ---------------------------------------------------------------------------
// DRILL oct23-topaz-rerun: "Run Topaz again", and "the Topaz pass" everywhere a
// person reads it (Jordan, Oct 23 2026: "I want to be able to re run the
// videos through topaz if the topaz pass doesn't look good. And I want to stop
// calling it 1080p pass and call it topaz pass.")
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-topaz-rerun.ts --logs <dir>
//
// Drives the SHIPPED code: lib/topazJobs (the lane, rerunTopazJob, the
// ledger), lib/topazRerun (the rule the screens share), lib/readyToSend,
// lib/videoDelivery, lib/jobsBoard, lib/officeDesk and the server action
// (app/ops/deliveryRecoveryActions.rerunTopazAction), against an isolated
// PGlite. Topaz and Dropbox are replaced at the module boundary and every
// outbound call is fenced: nothing is rendered, charged, uploaded or sent.
//
//   §1 the words: no screen string says "1080p pass" (or 1080p file, render,
//      job, version, lane); the real 1080p facts are kept
//   §2 the offer on a finished, unsent video; who may press it (owner and
//      office yes; the creative manager, an editor, a preview no)
//   §3 the press: the same row back to queued, the old render moved to
//      superseded/ and on the record, the caps still counting it, Kyle's old
//      card closed, nothing offered while it runs
//   §4 the pass runs from the free price check, and the new render becomes the
//      file to send only once it is finished and checked
//   §5 the caps apply: a re-run over the per-video limit stops at the price
//      check, nothing accepted, nothing lost
//   §6 a held file: run again from held (the unchecked file kept), a new
//      unchecked render is held, never the file to send
//   §7 refused once sent (Aryeo), published (portal), on the listing or on
//      its way there; a parked upload run does not block it
//   §8 the screens: the Video Review Room, Kyle's desk and the job page
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import type { AvTiming } from "../../src/lib/mp4Probe";

const PORT = Number(process.env.DRILL_PORT ?? 6633);
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

// ---- Topaz, faked: every call recorded -----------------------------------------
type Meta = { width: number; height: number; frameRate: number; frameCount: number; durationSec: number; container: string; codec: string; sizeBytes: number; audio: { present: boolean; codec: string | null }; timing?: AvTiming | null };
const inStep = (sec: number): AvTiming => ({ fragmented: false, video: { startSec: 0, endSec: sec }, audio: { startSec: 0, endSec: sec, codec: "mp4a" } });
/** A 30-second 4K source: about 16 credits on the rate card, under the 20 limit. */
const SOURCE: Meta = { width: 3840, height: 2160, frameRate: 29.97, frameCount: 899, durationSec: 30, container: "mp4", codec: "avc1", sizeBytes: BYTES.length, audio: { present: true, codec: "mp4a" }, timing: inStep(30) };
/** What a good render reads as: the planned 1920×1080, the same 30 s, sound in step. */
const RENDER: Meta = { ...SOURCE, width: 1920, height: 1080, sizeBytes: 40_000_000 };
const PROBE = new Map<string, Meta>();
const topazOut = (id: string) => `https://topaz.invalid/out/${id}.mp4`;
const topaz = { create: 0, accept: [] as string[], put: 0, complete: [] as string[], cancel: [] as string[], del: [] as string[] };
const STATUS = new Map<string, { status: string; downloadUrl: string | null; progress?: number }>();
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
          return async () => {
            topaz.create++;
            const id = `req-new-${topaz.create}`;
            return { requestId: id, credits: 9, seconds: 600, raw: { requestId: id } };
          };
        case "acceptVideoRequest":
          return async (id: string) => { topaz.accept.push(id); return [{ partNum: 1, url: `https://topaz-upload.invalid/${id}/1` }]; };
        case "putUploadPart":
          return async (target: { partNum: number }) => { topaz.put++; return { partNum: target.partNum, eTag: `etag-${target.partNum}` }; };
        case "completeUpload":
          return async (id: string) => { topaz.complete.push(id); STATUS.set(id, { status: "processing", downloadUrl: null }); };
        case "videoStatus":
          return async (id: string) => {
            const s = STATUS.get(id) ?? { status: "processing", downloadUrl: null };
            return { status: s.status, downloadUrl: s.downloadUrl, credits: s.status === "complete" ? 16 : null, progress: s.progress ?? null, message: null, raw: {} };
          };
        case "cancelVideoRequest": case "cancelEstimate": return async (id: string) => { topaz.cancel.push(id); return true; };
        case "deleteVideoFiles": return async (id: string) => { topaz.del.push(id); return true; };
        default: return t[k];
      }
    },
  })),
);

// ---- Dropbox, faked: a little file system --------------------------------------
const FS = new Map<string, number>();
const dbxCalls: string[] = [];
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

/** Every source line a person could read (comments left out). */
function screenLines(): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        fs.readFileSync(p, "utf8").split("\n").forEach((text, i) => {
          if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(text)) return;
          out.push({ file: path.relative(REPO, p), line: i + 1, text });
        });
      }
    }
  };
  walk(path.join(REPO, "src"));
  return out;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct23-topaz-rerun-isolated" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const tj = await import("@/lib/topazJobs");
  const rr = await import("@/lib/topazRerun");
  const settings = await import("@/lib/settings");
  const { readyToSend } = await import("@/lib/readyToSend");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const actions = await import("@/app/ops/deliveryRecoveryActions");
  const { HELD_ATTESTATION } = await import("@/lib/topazHold");
  const orig = await import("@/lib/topazOriginal");

  // The lane on, the already-finished skip off (the live setting), the stored defaults otherwise.
  await settings.putSetting("topaz", { ...(await settings.topazSettings()), enabled: true, skipFinished1080p: false, maxCreditsPerVideo: 20 });
  const client = await prisma.client.create({ data: { name: "Drill Client TEST" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "ADMIN" } });

  const jobOf = (id: string) => prisma.topazJob.findUniqueOrThrow({ where: { id } });
  const press = async (jobId: string, who: Viewer | null) => {
    process.env.AUTH_ENFORCE = "true";
    viewer = who;
    try {
      return await actions.rerunTopazAction(jobId);
    } finally {
      process.env.AUTH_ENFORCE = "";
      viewer = as("OWNER");
    }
  };
  const drive = async (id: string, until: string[], max = 12) => {
    const seen: string[] = [];
    for (let i = 0; i < max; i++) {
      const s = await tj.advanceTopazJob(id);
      seen.push(s);
      if (until.includes(s)) break;
    }
    return seen;
  };
  const rowOf = async (projectId: string, subId: string) => {
    const b = await readyToSend({ projectId });
    return { ready: b.ready.find((r) => r.submissionId === subId) ?? null, rendering: b.rendering.find((r) => r.submissionId === subId) ?? null };
  };
  const ledger = async () => {
    const t = await tj.topazTestLedger();
    const monthStart = new Date(Date.now() - 40 * 86_400_000); // every job here was accepted in the last hour
    const jobs = await prisma.topazJob.findMany({ where: { acceptedAt: { gte: monthStart } }, select: { estimateCredits: true } });
    return { renders: jobs.length + t.month, credits: jobs.reduce((n, j) => n + (j.estimateCredits ?? 0), 0) + t.credits };
  };

  // ---- a listing video whose Topaz file is FINISHED and checked, not sent -------
  let n = 0;
  async function mkDone(street: string, clientId: string = client.id) {
    n++;
    const folder = `/Listings/Drill/${street}`;
    const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId, status: "REVIEW", source: "ARYEO", aryeoListingId: `lst-rr-${n}`, dropboxFolder: folder }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
    const final = actualFolderPaths({ dropboxFolder: folder } as Parameters<typeof actualFolderPaths>[0]).finalVideo;
    const original = `${final}/Real Estate Video Tour - v1.mp4`;
    FS.set(original, 90_000_000);
    const blobUrl = blobUrlFor(`rr-${n}.mp4`);
    PROBE.set(blobUrl, SOURCE);
    const sub = await prisma.reviewSubmission.create({
      data: { projectId: p.id, deliverableId: d.id, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "Real Estate Video Tour - v1.mp4", blobUrl, sizeBytes: BYTES.length, finalPath: original, completedAt: new Date(Date.now() - 3_600_000), decidedAt: new Date(Date.now() - 3_600_000), decidedBy: "James" },
      select: { id: true },
    });
    await ensureOutputsForProject(p.id).catch(() => null);
    const requestId = `req-first-${n}`;
    STATUS.set(requestId, { status: "complete", downloadUrl: topazOut(requestId) });
    PROBE.set(topazOut(requestId), RENDER);
    const job = await prisma.topazJob.create({
      data: {
        projectId: p.id, submissionId: sub.id, state: "processing", requestId,
        acceptedAt: new Date(Date.now() - 1_800_000), completeUploadAt: new Date(Date.now() - 1_500_000), startedAt: new Date(Date.now() - 1_900_000),
        sourceWidth: 3840, sourceHeight: 2160, sourceFrameRate: 29.97, sourceFrameCount: 899, sourceDurationSec: 30, sourceContainer: "mp4", sourceSizeBytes: BYTES.length,
        outputWidth: 1920, outputHeight: 1080, estimateCredits: 16, sourceHasAudio: true, sourceAudioCodec: "mp4a",
      },
      select: { id: true },
    });
    const seen = await drive(job.id, ["done", "held", "failed"]);
    const j = await jobOf(job.id);
    return { projectId: p.id, subId: sub.id, jobId: job.id, final, original, blobUrl, street, seen, firstPath: j.finalPath };
  }
  const FINAL_NAME = "Real Estate Video Tour - v1 - FINAL (Topaz).mp4";

  // =========================================================================
  c.head("§1 · the words: the Topaz pass, never the 1080p pass");
  // =========================================================================
  {
    const OLD = /1080p (?:\(Topaz\) )?(?:video )?(?:pass|file|render|job|version|lane|on hold)\b|\b(?:Run|Retry|Needs) 1080p\b|Topaz 1080p/i;
    const lines = screenLines();
    // "(before 1080p pass)" is a FILE-NAME marker an old run wrote on real
    // files in Dropbox (stageStem must still strip it): data, not words.
    const offenders = lines.filter((l) => OLD.test(l.text) && !/STAGE_MARKERS|before 1080p pass/.test(l.text));
    c.ok("no screen string says \"1080p pass\" (or 1080p file, render, job, version, lane, Run/Retry/Needs 1080p)", offenders.length === 0, offenders.slice(0, 5).map((o) => `${o.file}:${o.line}`).join(", "));
    const said = (re: RegExp) => lines.some((l) => re.test(l.text));
    c.ok("…it says the Topaz pass: Settings, the lane, the ready card, the bells and the task title", said(/title="Topaz pass"/) && said(/"The Topaz pass is queued — nothing to send yet\."/) && said(/Topaz file held, not sent/) && said(/Upload the Topaz video to Aryeo/) && said(/"Run Topaz" : step\.action === "retry-1080p" \? "Retry Topaz"/));
    c.ok("…the attestation a person ticks names the Topaz file", HELD_ATTESTATION === "I played the Topaz file through and the sound and picture are right");
    c.ok("1080p kept where it is a fact: the editor's file \"Already 1080p\", the output size, the export spec",
      orig.ALREADY_FINISHED_SAYS === "Already 1080p: the editor's file goes out as is." && /&ldquo;1080p&rdquo; here means the/.test(src("src/components/settings/TopazSettingsPanel.tsx")) && /headline: "Export at 1080p"/.test(src("src/lib/videoStyles.ts")));
    c.ok("code values stay as they were (topaz-1080p, run-1080p, skipFinished1080p)", said(/source: "topaz-1080p"/) && said(/action: "run-1080p"/) && "skipFinished1080p" in settings.DEFAULT_TOPAZ);
    c.ok("the button is \"Run Topaz again\"", rr.RERUN_LABEL === "Run Topaz again" && rr.RERUN_CONFIRM === "Yes, run it again");
    c.ok("no em dash in the new words people read", [...Object.values(rr.RERUN_SAYS), rr.rerunCostLine({ credits: 16, limit: 20 }), rr.rerunCostLine({ credits: 30, limit: 20 }), rr.rerunCostLine({ credits: null, limit: 20 })].every((w) => !w.includes("—")));
  }

  // =========================================================================
  c.head("§2 · the offer on a finished, unsent video; who may press it");
  // =========================================================================
  // A real-looking client (not "… TEST"): the Review Room board, the job page
  // and the desk leave test clients out, and §8 reads all three for this video.
  // It lives only in this drill's isolated database.
  const realClient = await prisma.client.create({ data: { name: "Rerun Realty Group" }, select: { id: true } });
  const L = await mkDone("10 Rerun Rd", realClient.id);
  {
    const j = await jobOf(L.jobId);
    c.ok("the first render: done, checked, filed as FINAL (Topaz), the original set aside", j.state === "done" && j.outputCheck === "verified" && j.finalPath === `${L.final}/${FINAL_NAME}` && FS.has(j.finalPath) && !FS.has(L.original), `${L.seen.join(" → ")} ${j.finalPath}`);
    c.ok("…and Kyle has his upload card for it", (await prisma.smartTask.count({ where: { dedupeKey: `topaz-deliver-${L.jobId}`, status: "OPEN" } })) === 1);
    const { ready } = await rowOf(L.projectId, L.subId);
    c.ok("Ready to send offers the Topaz file, and \"Run Topaz again\" beside it", ready?.file.source === "topaz-1080p" && ready.file.says === "The Topaz pass finished — this is the file to send." && ready.rerun?.jobId === L.jobId, JSON.stringify(ready?.rerun));
    c.ok("…with the credits it should cost on today's Settings (rate card for a 30 s 4K source: 16) and the limit (20)", ready?.rerun?.credits === 16 && ready.rerun.limit === 20, JSON.stringify(ready?.rerun));
    c.ok("…shown before anything is spent", /^About 16 credits with today's Settings\. It starts with the free price check, so every limit in Settings still applies\./.test(rr.rerunCostLine(ready!.rerun!)));

    const before = await jobOf(L.jobId);
    const james = await press(L.jobId, as("CREATIVE_MANAGER"));
    const kim = await press(L.jobId, as("EDITOR"));
    const preview = await press(L.jobId, as("OWNER", true));
    const after = await jobOf(L.jobId);
    c.ok("James (creative manager) is refused", !james.ok && /access/i.test(james.message), james.message);
    c.ok("an editor is refused", !kim.ok && /access/i.test(kim.message), kim.message);
    c.ok("a preview (\"view as\") is refused", !preview.ok, preview.message);
    c.ok("…and none of them moved anything", after.state === "done" && after.finalPath === before.finalPath && FS.has(before.finalPath!) && topaz.create === 0);
  }

  // =========================================================================
  c.head("§3 · the press: same row, old render kept, caps still count it");
  // =========================================================================
  const oldPath = `${L.final}/${FINAL_NAME}`;
  const keptPath = `${L.final}/superseded/${FINAL_NAME}`;
  {
    const before = await ledger();
    const old = await jobOf(L.jobId);
    const r = await press(L.jobId, as("ADMIN"));
    const j = await jobOf(L.jobId);
    c.ok("Kyle (the office) may press it, and the answer names the cost and the price check", r.ok && /about 16 credits/.test(r.message) && /free price check/.test(r.message) && /kept in superseded/.test(r.message), r.message);
    c.ok("…and says it goes from the editor's original file and shows under With Topaz (Jordan, Oct 23 2026)", /from the editor's original file/.test(r.message) && /With Topaz/.test(r.message), r.message);
    c.ok("the SAME row back to queued (one render per cut), forced past the already-finished rule", j.id === L.jobId && j.state === "queued" && j.resolution === "force-pass" && (await prisma.topazJob.count({ where: { submissionId: L.subId } })) === 1);
    c.ok("…a clean sheet: no request, no price, no file, no check, no card", !j.requestId && j.estimateCredits == null && !j.acceptedAt && !j.finalPath && !j.savedAt && !j.outputCheck && !j.taskId && !j.creditsCharged);
    c.ok("…and its clock starts again now (the stall checks never read the days-old createdAt)", !!j.startedAt && Date.now() - j.startedAt.getTime() < 60_000 && j.createdAt.getTime() <= j.startedAt.getTime());
    c.ok("the previous render is MOVED to superseded/, not deleted", !FS.has(oldPath) && FS.has(keptPath), [...FS.keys()].filter((k) => k.includes("10 Rerun Rd")).join(" | "));
    const hist = await tj.topazRerunHistory(L.jobId);
    c.ok("…and its path is on the job's history (from, kept at, who, what it cost)", hist.length === 1 && hist[0].from === oldPath && hist[0].keptAt === keptPath && hist[0].by === "Kyle Drill" && hist[0].estimateCredits === 16 && hist[0].acceptedAt === old.acceptedAt?.toISOString(), JSON.stringify(hist[0]));
    const after = await ledger();
    c.ok("the day's and month's caps still count the old render (renders and credits unchanged by the press)", after.renders === before.renders && after.credits === before.credits, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    const cards = await prisma.smartTask.findMany({ where: { OR: [{ dedupeKey: { startsWith: "topaz-deliver-" } }, { dedupeKey: { startsWith: "topaz-rerun-card:" } }], projectId: L.projectId }, select: { status: true, dedupeKey: true, summary: true } });
    c.ok("Kyle's card for the old file is closed with the reason, its key retired (no longer read as the job's live card)", cards.length === 1 && cards[0].status === "CANCELLED" && cards[0].dedupeKey?.startsWith(`topaz-rerun-card:${L.jobId}:`) === true && /going through the Topaz pass again/.test(cards[0].summary ?? ""), JSON.stringify(cards));
    const act = await prisma.activity.findFirst({ where: { projectId: L.projectId, body: { startsWith: "Topaz pass run again" } } });
    c.ok("the timeline says who ran it again and where the old file is", !!act && /by Kyle Drill/.test(act.body) && /superseded/.test(act.body), act?.body ?? "");
    const { ready, rendering } = await rowOf(L.projectId, L.subId);
    c.ok("nothing is offered while it runs: no ready row, \"The Topaz pass is queued — nothing to send yet.\"", !ready && rendering?.says === "The Topaz pass is queued — nothing to send yet." && !rendering.rerun, rendering?.says ?? "");
    c.ok("the row out of Ready to send says where it is and when it was run again, and by whom", rendering?.topaz?.jobId === L.jobId && rendering.topaz.state === "queued" && rendering.topaz.percent === null && rendering.topaz.rerun?.by === "Kyle Drill" && rendering.topaz.rerun.atISO === hist[0].at && rendering.topaz.startedAtISO === j.startedAt?.toISOString(), JSON.stringify(rendering?.topaz));
    const again = await press(L.jobId, as("ADMIN"));
    c.ok("a second press is refused: already running", !again.ok && again.message === rr.RERUN_SAYS.running, again.message);
  }

  // =========================================================================
  c.head("§4 · from the free price check; the file to send only once checked");
  // =========================================================================
  {
    const c0 = topaz.create, a0 = topaz.accept.length;
    const s1 = await tj.advanceTopazJob(L.jobId);
    let j = await jobOf(L.jobId);
    c.ok("first the FREE price check: one estimate asked for, nothing accepted", s1 === "estimated" && topaz.create === c0 + 1 && topaz.accept.length === a0, s1);
    c.ok("…priced on today's Settings: max(Topaz 9, rate card 16) = 16, under the per-video limit", j.estimateCredits === 16 && !!j.presetJson);
    const s2 = await tj.advanceTopazJob(L.jobId);
    j = await jobOf(L.jobId);
    c.ok("then the caps and the accept (a reserved slot counted from here)", s2 === "uploading" && topaz.accept.length === a0 + 1 && !!j.acceptedAt, s2);
    const s3 = await tj.advanceTopazJob(L.jobId);
    j = await jobOf(L.jobId);
    c.ok("the same cut uploaded and started", s3 === "processing" && topaz.complete.includes(j.requestId!), s3);
    let row = await rowOf(L.projectId, L.subId);
    c.ok("while Topaz works: still nothing to send", !row.ready && row.rendering?.says === "The Topaz pass is running — nothing to send yet.", row.rendering?.says ?? "");
    // Topaz's own percent, kept off its status poll for the With Topaz row.
    STATUS.set(j.requestId!, { status: "processing", downloadUrl: null, progress: 41.6 });
    // PGlite stamps acceptedAt with now() in this machine's local time (UTC-4 in
    // ET), which reads as four hours old to the stall check; Neon runs in UTC.
    await prisma.topazJob.update({ where: { id: L.jobId }, data: { nextAttemptAt: null, acceptedAt: new Date() } });
    const sp = await tj.advanceTopazJob(L.jobId);
    j = await jobOf(L.jobId);
    row = await rowOf(L.projectId, L.subId);
    c.ok("Topaz's own percent is kept while it renders, and the row shows it", sp === "processing" && j.renderProgress === 42 && row.rendering?.topaz?.state === "processing" && row.rendering.topaz.percent === 42, `${sp} ${j.renderProgress} ${JSON.stringify(row.rendering?.topaz)}`);
    const { videoDeliveryBoard: vdb } = await import("@/lib/videoDelivery");
    const fb = await vdb({ fresh: true }).catch((e: Error) => { console.log("  (board)", e.message); return null; });
    const frow = fb?.lanes.finishing.find((r) => r.submissionId === L.subId);
    c.ok("the Video Review Room lists it under With Topaz (the finishing lane) with its progress and re-run stamp, not in Ready to send", !!frow && frow.topaz?.percent === 42 && frow.topaz.rerun?.by === "Kyle Drill" && !fb!.lanes.sending.some((r) => r.submissionId === L.subId), JSON.stringify(frow?.topaz));
    await prisma.topazJob.update({ where: { id: L.jobId }, data: { nextAttemptAt: null } });
    STATUS.set(j.requestId!, { status: "complete", downloadUrl: topazOut(j.requestId!) });
    PROBE.set(topazOut(j.requestId!), RENDER);
    const s4 = await tj.advanceTopazJob(L.jobId);
    j = await jobOf(L.jobId);
    row = await rowOf(L.projectId, L.subId);
    c.ok("finished and checked, being filed: still not the file to send", s4 === "saving" && j.outputCheck === "verified" && !j.finalPath && !row.ready, `${s4} ${row.rendering?.says}`);
    const s5 = await tj.advanceTopazJob(L.jobId);
    j = await jobOf(L.jobId);
    c.ok("filed: done, checked, FINAL (Topaz) at the top of Final again", s5 === "done" && j.state === "done" && j.outputCheck === "verified" && j.finalPath === oldPath && FS.has(oldPath), `${s5} ${j.finalPath}`);
    c.ok("the old render is still kept in superseded/ (nothing lost)", FS.has(keptPath));
    row = await rowOf(L.projectId, L.subId);
    c.ok("NOW the new render is the file to send", row.ready?.file.source === "topaz-1080p" && row.ready.file.fileName === FINAL_NAME && row.ready.file.downloadHref === `/api/topaz/download/${L.jobId}` && row.ready.file.says === "The Topaz pass finished — this is the file to send.");
    c.ok("…and it can be run again too (still not sent)", row.ready?.rerun?.jobId === L.jobId);
    const open = await prisma.smartTask.count({ where: { dedupeKey: `topaz-deliver-${L.jobId}`, status: "OPEN" } });
    c.ok("Kyle has a fresh upload card for the new file (the old one stays closed)", open === 1 && (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: `topaz-rerun-card:${L.jobId}:` }, status: "CANCELLED" } })) === 1);
  }

  // =========================================================================
  c.head("§4b · always the editor's original: refused once the hub no longer holds it");
  // =========================================================================
  {
    const O = await mkDone("12 Original Ln");
    const sendsOriginal = src("src/lib/topazJobs.ts");
    c.ok("the pass reads the cut's own upload (the editor's original), never the Topaz file", /async function stepQueued[\s\S]{0,200}if \(!sub\?\.blobUrl\)/.test(sendsOriginal) && /const res = await fetch\(sub\.blobUrl/.test(sendsOriginal));
    await prisma.reviewSubmission.update({ where: { id: O.subId }, data: { blobUrl: null } });
    const before = await jobOf(O.jobId);
    const r = await press(O.jobId, as("ADMIN"));
    const after = await jobOf(O.jobId);
    c.ok("with the original released, the press is refused in words and nothing moves", !r.ok && r.message === rr.RERUN_SAYS.noOriginal && after.state === "done" && after.finalPath === before.finalPath && FS.has(before.finalPath!), r.message);
    c.ok("…and the button is not drawn for it", rr.rerunRefusal({ state: "done", finalPath: "/x/a.mp4", savedAt: new Date(), heldPath: null, deliveredAt: null, cutStatus: "APPROVED", sentToClientAt: null, monthly: false, onListing: false, push: null, originalHeld: false }) === rr.RERUN_SAYS.noOriginal);
  }

  // =========================================================================
  c.head("§5 · the caps apply: over the per-video limit stops at the price check");
  // =========================================================================
  {
    const M = await mkDone("20 Pricey Pl");
    await settings.putSetting("topaz", { ...(await settings.topazSettings()), maxCreditsPerVideo: 10 });
    const { ready } = await rowOf(M.projectId, M.subId);
    c.ok("the offer says up front it is over the limit and will stop", ready?.rerun?.credits === 16 && ready.rerun.limit === 10 && /over the 10-credit limit per video, so the free price check will stop it/.test(rr.rerunCostLine(ready.rerun)));
    const r = await press(M.jobId, as("OWNER"));
    const a0 = topaz.accept.length, c0 = topaz.create;
    const s = await tj.advanceTopazJob(M.jobId);
    const j = await jobOf(M.jobId);
    c.ok("the owner may press it; the price check then stops it: skipped, nothing accepted", r.ok && s === "skipped" && topaz.create === c0 + 1 && topaz.accept.length === a0 && /would cost about 16 credits and the limit per video is 10\. Nothing was charged\./.test(j.skipReason ?? ""), `${s} ${j.skipReason}`);
    c.ok("…the old render is still kept, and on the record", FS.has(`${M.final}/superseded/${FINAL_NAME}`) && (await tj.topazRerunHistory(M.jobId)).length === 1);
    const row = await rowOf(M.projectId, M.subId);
    c.ok("…and the card says so in the Topaz pass's words (the editor's own export, no re-run offered on a skip)", row.ready?.file.says === "The Topaz pass was skipped — send the editor's own export." && !row.ready.rerun, row.ready?.file.says ?? "");
    await settings.putSetting("topaz", { ...(await settings.topazSettings()), maxCreditsPerVideo: 20 });
  }

  // =========================================================================
  c.head("§6 · a held file: run again from held; a new unchecked render is held");
  // =========================================================================
  {
    // A first render nobody could read: held in unverified/.
    n++;
    const H = await (async () => {
      const street = "30 Held Hl";
      const folder = `/Listings/Drill/${street}`;
      const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId: client.id, status: "REVIEW", source: "ARYEO", aryeoListingId: `lst-rr-${n}`, dropboxFolder: folder }, select: { id: true } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
      const final = actualFolderPaths({ dropboxFolder: folder } as Parameters<typeof actualFolderPaths>[0]).finalVideo;
      const original = `${final}/Real Estate Video Tour - v1.mp4`;
      FS.set(original, 90_000_000);
      const blobUrl = blobUrlFor(`rr-held-${n}.mp4`);
      PROBE.set(blobUrl, SOURCE);
      const sub = await prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: d.id, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "Real Estate Video Tour - v1.mp4", blobUrl, sizeBytes: BYTES.length, finalPath: original, completedAt: new Date(Date.now() - 3_600_000), decidedAt: new Date(Date.now() - 3_600_000), decidedBy: "James" }, select: { id: true } });
      await ensureOutputsForProject(p.id).catch(() => null);
      const requestId = `req-held-${n}`;
      STATUS.set(requestId, { status: "complete", downloadUrl: topazOut(requestId) }); // its output is never readable
      const job = await prisma.topazJob.create({ data: { projectId: p.id, submissionId: sub.id, state: "processing", requestId, acceptedAt: new Date(Date.now() - 1_800_000), completeUploadAt: new Date(Date.now() - 1_500_000), sourceWidth: 3840, sourceHeight: 2160, sourceFrameRate: 29.97, sourceFrameCount: 899, sourceDurationSec: 30, sourceContainer: "mp4", sourceSizeBytes: BYTES.length, outputWidth: 1920, outputHeight: 1080, estimateCredits: 16, sourceHasAudio: true, sourceAudioCodec: "mp4a" }, select: { id: true } });
      return { projectId: p.id, subId: sub.id, jobId: job.id, final, original };
    })();
    const seen = await drive(H.jobId, ["held", "done", "failed"]);
    let j = await jobOf(H.jobId);
    const heldPath = j.heldPath;
    c.ok("a render nobody could read is HELD in unverified/ (not the file to send)", j.state === "held" && !!heldPath && heldPath.includes("/unverified/") && !j.finalPath && FS.has(heldPath), `${seen.join(" → ")} ${heldPath}`);
    let row = await rowOf(H.projectId, H.subId);
    c.ok("the held row offers \"Run Topaz again\" beside the listen-and-decide buttons", !row.ready && !!row.rendering?.held && row.rendering.rerun?.jobId === H.jobId);
    const r = await press(H.jobId, as("ADMIN"));
    j = await jobOf(H.jobId);
    const aside = `${H.final}/superseded/${heldPath!.split("/").pop()}`;
    c.ok("run again from held: queued, the unchecked file MOVED to superseded/ and on the record", r.ok && j.state === "queued" && !j.heldPath && !FS.has(heldPath!) && FS.has(aside) && (await tj.topazRerunHistory(H.jobId))[0]?.keptAt === aside && (await tj.topazRerunHistory(H.jobId))[0]?.was === "held", r.message);
    // The new render is unreadable too: it must be held, never offered.
    const up = await drive(H.jobId, ["processing", "failed", "skipped"], 6);
    const newReq = (await jobOf(H.jobId)).requestId!;
    STATUS.set(newReq, { status: "complete", downloadUrl: topazOut(newReq) }); // finished, and nobody can read it
    const s = [...up, ...(await drive(H.jobId, ["held", "done", "failed"], 14))];
    j = await jobOf(H.jobId);
    row = await rowOf(H.projectId, H.subId);
    c.ok("a new render nobody could check is held again, NOT the file to send", j.state === "held" && !j.finalPath && !row.ready && !!row.rendering?.held, s.join(" → "));
    // A person listens and uses it: only then is it the file to send.
    const used = await tj.resolveHeldTopazJob(H.jobId, "accept-processed", "Jordan Drill", { attest: HELD_ATTESTATION });
    j = await jobOf(H.jobId);
    row = await rowOf(H.projectId, H.subId);
    c.ok("…until a person listens and uses it: then it is checked and offered", used.ok && j.state === "done" && j.outputCheck === "resolved-processed" && row.ready?.file.source === "topaz-1080p", used.message);
  }

  // =========================================================================
  c.head("§7 · refused once sent, published, on the listing or on its way");
  // =========================================================================
  {
    const S = await mkDone("40 Sent St");
    await prisma.reviewSubmission.update({ where: { id: S.subId }, data: { sentToClientAt: new Date(), sentToClientBy: "Kyle Drill" } });
    await prisma.topazJob.update({ where: { id: S.jobId }, data: { deliveredAt: new Date(), deliveredBy: "Kyle Drill" } });
    const r = await press(S.jobId, as("OWNER"));
    const j = await jobOf(S.jobId);
    c.ok("sent through Aryeo: refused, nothing moved", !r.ok && r.message === rr.RERUN_SAYS.sent && j.state === "done" && FS.has(j.finalPath!), r.message);
    c.ok("…and not offered (the video is off Ready to send)", !(await rowOf(S.projectId, S.subId)).ready);

    // A monthly program video published to the client's portal.
    const M = await buildContentMonth(prisma, { name: "Pia Portal TEST", package: "Accelerator", owner: { email: "pia@realtourpilot.com", name: "Pia Owner" } });
    const blobUrl = blobUrlFor("rr-portal.mp4");
    const pf = `/drill/monthly/05-Final-Video/Personal Branding Reel - v1 - FINAL (Topaz).mp4`;
    FS.set(pf, 40_000_000);
    const pcut = await prisma.reviewSubmission.create({ data: { projectId: M.projectId!, deliverableId: M.deliverableId, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "Personal Branding Reel - v1.mp4", blobUrl, sizeBytes: BYTES.length, decidedAt: new Date(), decidedBy: "James", sentToClientAt: new Date(), sentToClientBy: "Automatic portal publication" }, select: { id: true } });
    const pj = (await prisma.topazJob.create({ data: { submissionId: pcut.id, projectId: M.projectId!, state: "done", finalPath: pf, savedAt: new Date(), outputCheck: "verified", acceptedAt: new Date(), estimateCredits: 8, deliveredAt: new Date() } })).id;
    const pr = await press(pj, as("OWNER"));
    c.ok("published to the portal: refused in the portal's words, nothing moved", !pr.ok && pr.message === rr.RERUN_SAYS.published && FS.has(pf) && (await jobOf(pj)).state === "done", pr.message);

    // On the Aryeo listing (an upload run that added it), and on its way there.
    const A = await mkDone("50 Listing Ln");
    const run = (state: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id: "r1", submissionId: A.subId, projectId: A.projectId, listingId: "lst", topazJobId: A.jobId, state, mode: "deliver", addSentAt: null, mediaId: null, hold: null, wait: null, by: "Kyle Drill", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra });
    const key = `video_aryeo_push:${A.subId}`;
    await prisma.appSetting.create({ data: { key, value: run("WAITING", { mediaId: "media-1", addSentAt: new Date().toISOString(), mode: "upload", wait: { gate: "kyle", why: "On Aryeo, not sent yet.", since: new Date().toISOString() } }) } });
    let ra = await press(A.jobId, as("ADMIN"));
    c.ok("on the Aryeo listing (uploaded, not sent): refused, the file is not swapped underneath", !ra.ok && ra.message === rr.RERUN_SAYS.onListing && FS.has((await jobOf(A.jobId)).finalPath!), ra.message);
    c.ok("…and the row does not offer it", !(await rowOf(A.projectId, A.subId)).ready?.rerun);
    await prisma.appSetting.update({ where: { key }, data: { value: run("SENDING") } });
    ra = await press(A.jobId, as("ADMIN"));
    c.ok("on its way to Aryeo: refused", !ra.ok && ra.message === rr.RERUN_SAYS.goingUp, ra.message);
    await prisma.appSetting.update({ where: { key }, data: { value: run("FAILED") } });
    c.ok("a run that failed before anything went up does not block it (the row offers it)", (await rowOf(A.projectId, A.subId)).ready?.rerun?.jobId === A.jobId && (await tj.rerunTopazJobRefusal(A.jobId)) === null);
    await prisma.appSetting.update({ where: { key }, data: { value: run("HELD", { hold: { gate: "asks", why: "Open request.", by: null, at: new Date().toISOString(), resume: "PREPARING" } }) } });
    c.ok("…nor one held at the gate before the upload", (await tj.rerunTopazJobRefusal(A.jobId)) === null);

    const T = await mkDone("60 Try Again Tr");
    await prisma.topazJob.update({ where: { id: T.jobId }, data: { state: "failed", finalPath: null, savedAt: null, error: "Topaz couldn't finish this one." } });
    c.ok("a pass that did not finish is Try again's, not this button's", (await tj.rerunTopazJobRefusal(T.jobId)) === rr.RERUN_SAYS.notFinished);
    const V = await mkDone("70 Old Version Way");
    await prisma.topazJob.update({ where: { id: V.jobId }, data: { finalPath: `${V.final}/superseded/${FINAL_NAME}` } });
    c.ok("an older version whose file a newer one replaced (moved to superseded/) is refused", (await tj.rerunTopazJobRefusal(V.jobId)) === rr.RERUN_SAYS.replaced);
  }

  // =========================================================================
  c.head("§8 · the screens: the Video Review Room, Kyle's desk, the job page");
  // =========================================================================
  {
    const room = src("src/app/review/page.tsx");
    c.ok("the Video Review Room: beside Watch it on Ready to send, and on a held row, the office's press only",
      /<WatchFile[^\n]*\/>\s*\n(?:\s*\{\/\*[\s\S]*?\*\/\}\s*\n)?\s*\{sendDesk && r\.rerun && <RerunTopaz /.test(room) && (room.match(/\{sendDesk && r\.rerun && <RerunTopaz /g) ?? []).length === 2);
    const card = src("src/components/ops/ReadyToSendCard.tsx");
    c.ok("the portal follow-up row and the held list carry it too", (card.match(/<RerunTopaz /g) ?? []).length === 2);
    const jobPage = src("src/components/jobs/JobDeliverables.tsx");
    c.ok("the job page: beside the video's send, and nulled for anyone not the office", /\{v\.rerun && <RerunTopaz /.test(jobPage) && /rerun: null/.test(jobPage));
    const desk = src("src/components/desk/OfficeDesk.tsx");
    const deskLib = await import("@/lib/officeDesk");
    c.ok("Kyle's desk: the side panel renders it, labelled \"Run Topaz again\"", /case "topaz-rerun":\s*\n\s*return <RerunTopaz /.test(desk) && deskLib.actionLabel({ kind: "topaz-rerun", jobId: "x", street: "y", video: "Listing video", credits: 1, limit: 2 }) === "Run Topaz again");
    c.ok("Kyle's desk: Review & Deliver's approved-video rows carry it too (never in a preview)", /i\.group !== "video" \? \[\] : i\.actions\.filter\(/.test(desk) && /readOnly \|\| i\.group !== "video"/.test(desk) && /data-row-rerun=\{i\.id\}/.test(desk) && /<RerunTopaz key=\{a\.jobId\}/.test(desk));
    c.ok("the Video Review Room: a With Topaz list in Ready to send (step, percent, run-again stamp), refreshing while one is in the pass", /With Topaz \(\{finishing\.length\}\)/.test(room) && /<WithTopazRow key=\{r\.key\} r=\{r\} \/>/.test(room) && /Run through Topaz again \{etDateTime/.test(room) && /\(moving \|\| finishing\.length > 0\) && <AutoRefresh/.test(room) && /with Topaz` : null/.test(room));
    const button = src("src/components/ops/RerunTopaz.tsx");
    c.ok("the button asks first and shows the cost before it spends; it calls the guarded action", /setAsking\(true\)/.test(button) && /rerunCostLine/.test(button) && /rerunTopazAction/.test(button) && !/from "@\/lib\/topazJobs"/.test(button));

    // The data each screen reads, built by the shipped readers.
    const { videoDeliveryBoard } = await import("@/lib/videoDelivery");
    const board = await videoDeliveryBoard({ fresh: true }).catch((e: Error) => { console.log("  (board)", e.message); return null; });
    const vrow = board ? Object.values(board.lanes).flat().find((r) => r.submissionId === L.subId) : null;
    c.ok("the Review Room's row (and so the job page and the desk) carries the offer", vrow?.lane === "sending" && vrow.rerun?.jobId === L.jobId && vrow.rerun.credits === 16, `${vrow?.lane} ${JSON.stringify(vrow?.rerun)}`);
    const { jobDeliverables } = await import("@/lib/jobsBoard");
    const jd = await jobDeliverables(L.projectId).catch((e: Error) => { console.log("  (job page)", e.message); return null; });
    const item = jd?.video.items.find((v) => v.key === L.subId);
    c.ok("the job page's video item carries it", item?.phase === "ready" && item.rerun?.jobId === L.jobId, `${item?.phase} ${JSON.stringify(item?.rerun)}`);
    const deskData = await deskLib.officeDeskFor(null, { includeTest: true }).catch((e: Error) => { console.log("  (desk)", e.message); return null; });
    const deliver = deskData?.sections.find((x) => x.key === "deliver");
    const jobItem = deliver ? [...deliver.now, ...deliver.waiting, ...deliver.ok].find((i) => i.id === `video:${L.projectId}`) : undefined;
    c.ok("Kyle's desk: the approved video's item in Review & Deliver offers \"Run Topaz again\" after its send", !!jobItem && jobItem.group === "video" && jobItem.actions.some((a) => a.kind === "topaz-rerun" && a.jobId === L.jobId && !!a.video) && jobItem.actions[0]?.kind !== "topaz-rerun", JSON.stringify(jobItem?.actions));
  }

  c.head("Z · isolation");
  c.ok("nothing left the process (only the fake store answered)", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
