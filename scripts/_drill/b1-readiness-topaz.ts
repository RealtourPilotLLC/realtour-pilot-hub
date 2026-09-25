// ---------------------------------------------------------------------------
// DRILL: B1 — RECEIPT IS NOT READINESS (O01/A32), and A 1080p FILE NOBODY COULD
// CHECK IS HELD, NEVER TRUSTED (O02/A39). Unified handoff, Sep 25 2026.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/b1-readiness-topaz.ts
//
// PART A — the raws notices (tasks.ts notifyRawsLanded / notifyReadyToEdit /
// ensureEditorHandoff). The old code said "Raws in — ready for editing" the
// moment any file appeared, pinged the routed editor, and in the same pass
// minted a card saying the job was waiting on a brief; when the brief landed,
// nothing said so. Each journey below runs the SHIPPED handoff the way the
// hourly sweep does, and counts timeline markers, bell rows (Notification's
// @unique dedupeKey) and ops-Slack lines.
//
// PART B — the 1080p pass (topazJobs.ts). A render whose file could not be
// read after the retries used to be FILED: the editor's approved export moved
// to superseded/, Kyle told to deliver the new file, the ready card calling it
// "the file to send". Now it is saved under Final/unverified/, read again from
// Dropbox, and HELD for a person when it still cannot be read. Every provider
// call is mocked and counted; nothing is rendered and nothing is charged.
//
// OLD BEHAVIOUR FIRST. Both parts load the two modules as they stood at
// 75d56f1 (git show, imports aimed at this tree) and run them on identical
// rows, so the defect is observed before the fix is asserted.
//
// ISOLATION. _harness.ts: PGlite on 127.0.0.1:5604, every .env secret blanked,
// fetch AND raw sockets fenced (the Topaz and Dropbox modules are replaced at
// the module boundary, so nothing needs to leave). No client or team message
// can be sent: ops Slack is recorded at opsAlert/notifyUrgent, never posted.
//
// THE CLOCK is pinned to Wednesday Sep 23 2026, 10:00 ET and moved by hand —
// the handoff's chase dates and the notify bridge's quiet hours both read it.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.DRILL_PORT ?? 5604);
const BASE = "75d56f1"; // the commit this batch starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ------------------------------------------------------------
const RealDate = Date;
let SIM = RealDate.parse("2026-09-23T10:00:00-04:00");
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
const advanceHours = (n: number) => { SIM += n * 3_600_000; };
/** Engine-side createdAt comes off the REAL clock; a pause keeps two rows'
 *  order unambiguous when one is compared against the other. */
const tick = () => new Promise((r) => setTimeout(r, 8));

installNextStubs();

// SLACK IS HELD AT FETCH — the honest seam (notify.ts reaches Slack through a
// dynamic import, which a module wrapper cannot reach). Every chat.postMessage
// is recorded with its channel and answered ok; ops lines are the ones posted
// to the pinned ops channel, DMs are everything else. Nothing is sent.
const OPS = "C-DRILL-OPS";
const slackPosts: { channel: string; text: string }[] = [];
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { channel?: string; text?: string }) : {};
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (method === "chat.postMessage") {
    slackPosts.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true, ts: "1.1" });
  }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  return json({ ok: false, error: "missing_scope" });
});
/** The ops-Slack lines, in order. */
const opsLines = () => slackPosts.filter((p) => p.channel === OPS).map((p) => p.text);

// ---- the module boundary ---------------------------------------------------
// Matched in both spellings: "@/lib/x" from the tree, and the absolute path the
// 75d56f1 copies import by.
const isMod = (r: string, tail: string) => r === `@/lib/${tail}` || r.endsWith(`/src/lib/${tail}`) || r.endsWith(`/src/lib/${tail}.ts`);
const wrapOnce = <T extends object>(make: (m: T) => T) => {
  const cache = new WeakMap<object, T>();
  return (loaded: unknown) => {
    const m = loaded as T;
    if (!cache.has(m)) cache.set(m, make(m));
    return cache.get(m);
  };
};

// A scripted Topaz: the render is always finished; what its file READS as is
// set per URL. Every call counted — the spend-bearing ones must stay at zero.
type Meta = { width: number; height: number; frameRate: number; frameCount: number; durationSec: number; container: string; codec: string; sizeBytes: number; audio: { present: boolean; codec: string | null } };
const meta = (o: { audio?: boolean; dur?: number; w?: number; h?: number } = {}): Meta => {
  const dur = o.dur ?? 60;
  const audio = o.audio ?? true;
  return { width: o.w ?? 1920, height: o.h ?? 1080, frameRate: 30, frameCount: dur * 30, durationSec: dur, container: "mp4", codec: "avc1", sizeBytes: 40_000_000, audio: { present: audio, codec: audio ? "mp4a" : null } };
};
const calls = { createVideoRequest: 0, acceptVideoRequest: 0, completeUpload: 0, videoStatus: 0, deleteVideoFiles: 0, cancel: 0 };
/** URL → what probeVideoMetadata answers. Absent = it throws (unreadable). */
const PROBE = new Map<string, Meta>();
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
        case "videoStatus":
          return async (id: string) => { calls.videoStatus++; return { status: "complete", downloadUrl: topazOut(id), credits: 27, progress: 100, message: null, raw: {} }; };
        case "probeVideoMetadata":
          return async (url: string) => {
            const a = PROBE.get(url);
            if (!a) throw new E("Couldn't read the video file (503).", 503, true);
            return a;
          };
        case "createVideoRequest": return async () => { calls.createVideoRequest++; return { requestId: `req-est-${calls.createVideoRequest}`, credits: 8, seconds: 60, raw: {} }; };
        case "acceptVideoRequest": return async () => { calls.acceptVideoRequest++; return []; };
        case "completeUpload": return async () => { calls.completeUpload++; };
        case "deleteVideoFiles": return async () => { calls.deleteVideoFiles++; return true; };
        case "cancelVideoRequest":
        case "cancelEstimate": return async () => { calls.cancel++; return true; };
        default: return t[k];
      }
    },
  })),
);

// A scripted Dropbox: an in-memory folder tree with Dropbox's own answers.
const FS = new Map<string, number>();
const dbxLog: { ep: string; arg: Record<string, unknown> }[] = [];
const SAVE_BYTES = 40_000_000;
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
            FS.set(p, SAVE_BYTES);
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

// The lane is switched on (it defaults off); every other setting is the app's own.
interceptModule(
  (r) => isMod(r, "settings"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      if (k !== "topazSettings") return t[k];
      return async () => ({ ...(await (t.topazSettings as () => Promise<Record<string, unknown>>)()), enabled: true });
    },
  })),
);

/** The two modules as they stood at BASE, byte for byte, their `@/` imports
 *  aimed at this tree — the old behaviour, observed rather than described. */
function writeBaseCopies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b1-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const tasks = path.join(dir, "tasks.base.ts");
  fs.writeFileSync(tasks, point(show("src/lib/tasks.ts")));
  const topaz = path.join(dir, "topazJobs.base.ts");
  fs.writeFileSync(topaz, point(show("src/lib/topazJobs.ts")));
  return { dir, tasks, topaz };
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { SLACK_ALERT_CHANNEL: OPS } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("slack", "xoxb-drill-not-a-real-token");
  const tasks = await import("@/lib/tasks");
  const tj = await import("@/lib/topazJobs");
  const { readyToSend, markVideoSent, cutsOnTheCardFor } = await import("@/lib/readyToSend");
  const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
  const { HELD_ATTESTATION } = await import("@/lib/topazHold");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const base = writeBaseCopies();
  const oldTasks = (await import(base.tasks)) as { ensureEditorHandoff: (id: string) => Promise<void> };
  const oldTopaz = (await import(base.topaz)) as { advanceTopazJob: (id: string) => Promise<string> };

  c.head("0 · the harness");
  c.ok("the app is pointed at the isolated database", (process.env.DATABASE_URL ?? "").includes("127.0.0.1"));
  c.ok("the clock reads Wed Sep 23 10:00 ET", new Date().toISOString() === "2026-09-23T14:00:00.000Z", new Date().toISOString());

  const client = await prisma.client.create({ data: { name: "Drill Client TEST" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({
    data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 },
    select: { id: true },
  });
  // pingKyle finds him by name — the upload card needs somebody to land on.
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "ADMIN" }, select: { id: true } });

  // =========================================================================
  // PART A — THE RAWS NOTICES
  // =========================================================================
  const RAWS = (photos: number, video: number, stale = false) =>
    JSON.stringify({ present: [], dropbox: { rawPhotos: photos, rawVideo: video, finalVideo: 0, stale } });
  let jobN = 0;
  async function mkJob(o: {
    street: string;
    kind: "tour" | "reel" | "photos";
    evidence: string | null;
    briefed?: boolean;
  }): Promise<string> {
    jobN++;
    const p = await prisma.project.create({
      data: {
        title: `${o.street}, West Chester, PA`,
        addressLine: o.street,
        clientId: client.id,
        status: "SHOT",
        source: "ARYEO",
        aryeoOrderId: `ord-b1-${jobN}`,
        shootDate: new Date(Date.now() - 20 * 3_600_000),
        deliveryDue: new Date(Date.now() + 3 * 86_400_000),
        photographerId: harrison.id,
        statusEvidence: o.evidence,
        ...(o.briefed
          ? { debriefSubmittedAt: new Date(), videoInstructions: "VISION FOR THE EDIT\nOpen on the porch at golden hour, then the kitchen island and the view from the deck." }
          : {}),
      },
      select: { id: true },
    });
    if (o.kind === "tour") {
      await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 } });
      await prisma.orderItem.create({ data: { projectId: p.id, title: "Real Estate Video Tour", amount: 45000 } });
    } else if (o.kind === "reel") {
      await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Social Media Reel", productTitle: "Standard Social Media Reel", quantity: 1 } });
      await prisma.orderItem.create({ data: { projectId: p.id, title: "Standard Social Media Reel", amount: 25000 } });
    } else {
      await prisma.deliverable.create({ data: { projectId: p.id, type: "PHOTOS", label: "HDR Photography", productTitle: "HDR Photography", quantity: 25 } });
    }
    return p.id;
  }
  const markers = (projectId: string) =>
    prisma.activity.findMany({
      where: { projectId, type: "SYSTEM", OR: [{ body: { startsWith: "Raws in for" } }, { body: { startsWith: "Ready for editing:" } }] },
      orderBy: { createdAt: "asc" },
      select: { body: true, createdAt: true },
    });
  const slackFor = (street: string) => opsLines().filter((s) => s.includes(street));
  const editorRows = (projectId: string) =>
    prisma.notification.count({ where: { userKey: { startsWith: "editor:" }, dedupeKey: { contains: projectId } } });
  const rowsFor = (projectId: string) => prisma.notification.count({ where: { kind: "raws_landed", dedupeKey: { contains: projectId } } });
  const card = (projectId: string) =>
    prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${projectId}` }, select: { blockedReason: true, status: true } });
  const sweep = (projectId: string) => tasks.ensureEditorHandoff(projectId);

  // -------------------------------------------------------------------------
  c.head("A0 · OLD (75d56f1): a job the card calls blocked is announced 'ready for editing'");
  {
    const street = "1 Old Way";
    const id = await mkJob({ street, kind: "tour", evidence: RAWS(140, 12) });
    await oldTasks.ensureEditorHandoff(id);
    const cd = await card(id);
    c.ok("old: the card says the job is waiting on a brief", !!cd?.blockedReason, cd?.blockedReason ?? "");
    c.ok("old: in the same pass ops Slack was told 'ready for editing'", slackFor(street).some((s) => /ready for editing/i.test(s)), slackFor(street).join(" | "));
    c.ok("old: the routed editor got a person-addressed bell row (the Manila DM)", (await editorRows(id)) === 1);
  }

  // -------------------------------------------------------------------------
  c.head("A1 · NEW: raws found by the sweep before the wrap-up — a truthful receipt, no editor ping");
  const street1 = "2645 N 8th St";
  const J1 = await mkJob({ street: street1, kind: "tour", evidence: RAWS(143, 11) });
  await sweep(J1);
  {
    const m = await markers(J1);
    const cd = await card(J1);
    c.ok("exactly one receipt marker", m.length === 1, m.map((x) => x.body).join(" | "));
    c.ok("…in the new format, saying it is waiting", /— received: waiting/.test(m[0]?.body ?? ""), m[0]?.body ?? "");
    c.ok("ops Slack: one line, and it does NOT say ready", slackFor(street1).length === 1 && !/ready/i.test(slackFor(street1)[0]), slackFor(street1).join(" | "));
    c.ok("…it names what is missing and who owes it — the card's own sentence", !!cd?.blockedReason && slackFor(street1)[0].includes(cd.blockedReason.replace(/^Waiting/, "waiting").replace(/\.$/, "")), `card: ${cd?.blockedReason}`);
    c.ok("no bell row is addressed to an editor (no DM to Manila)", (await editorRows(J1)) === 0);
    c.ok("no bell row for this job says ready", (await prisma.notification.count({ where: { dedupeKey: { contains: J1 }, title: { contains: "ready", mode: "insensitive" } } })) === 0);
    c.ok("the card is minted and blocked", !!cd && !!cd.blockedReason);
  }

  c.head("A2 · 24 hourly sweeps while still blocked — nothing more");
  {
    const before = { m: (await markers(J1)).length, s: slackFor(street1).length, n: await rowsFor(J1), all: slackPosts.length };
    for (let h = 0; h < 24; h++) { advanceHours(1); await sweep(J1); }
    c.ok("no new marker", (await markers(J1)).length === before.m);
    c.ok("no new Slack line (ops or DM)", slackFor(street1).length === before.s && slackPosts.length === before.all, `${slackPosts.length - before.all} new posts`);
    c.ok("no new bell row", (await rowsFor(J1)) === before.n);
  }

  c.head("A3 · the photographer hands in the wrap-up — ONE ready notice, to the routed editor");
  {
    await prisma.project.update({
      where: { id: J1 },
      data: { debriefSubmittedAt: new Date(), videoInstructions: "VISION FOR THE EDIT\nWalk-through from the front door, slow push on the fireplace, end on the backyard." },
    });
    await tick();
    await sweep(J1);
    const m = await markers(J1);
    const ready = m.filter((x) => x.body.startsWith("Ready for editing:"));
    const cd = await card(J1);
    const proj = await prisma.project.findUniqueOrThrow({ where: { id: J1 }, select: { handoffReadyAt: true, handoffBlockedReason: true } });
    c.ok("exactly one ready marker", ready.length === 1, ready.map((x) => x.body).join(" | "));
    c.ok("ops Slack: one ready line", slackFor(street1).filter((s) => /Ready for editing/.test(s)).length === 1, slackFor(street1).join(" | "));
    c.ok("one person-addressed row for the routed editor (editor:john)", (await prisma.notification.count({ where: { userKey: "editor:john", dedupeKey: { contains: J1 } } })) === 1);
    c.ok("the card and the project row are clear", !cd?.blockedReason && !proj.handoffBlockedReason && !!proj.handoffReadyAt);
    const before = { m: m.length, s: slackFor(street1).length, n: await prisma.notification.count({ where: { dedupeKey: { contains: J1 } } }) };
    for (let h = 0; h < 24; h++) { advanceHours(1); await sweep(J1); }
    c.ok("24 more sweeps: no marker, no Slack, no bell", (await markers(J1)).length === before.m && slackFor(street1).length === before.s && (await prisma.notification.count({ where: { dedupeKey: { contains: J1 } } })) === before.n);
  }

  c.head("A4 · a plain social reel, ready the moment the files land — ONE notice, never a second");
  const street4 = "88 Reel Rd";
  const J4 = await mkJob({ street: street4, kind: "reel", evidence: RAWS(60, 8) });
  {
    await sweep(J4);
    const m = await markers(J4);
    c.ok("receipt + ready markers, written together", m.length === 2 && /— received: ready for editing/.test(m[0].body) && /— announced with the raws/.test(m[1].body), m.map((x) => x.body).join(" | "));
    c.ok("ONE Slack line, and it says ready", slackFor(street4).length === 1 && /ready for editing/.test(slackFor(street4)[0]), slackFor(street4).join(" | "));
    c.ok("ONE editor row", (await editorRows(J4)) === 1);
    for (let h = 0; h < 6; h++) { advanceHours(1); await sweep(J4); }
    c.ok("six sweeps later: still one of each", (await markers(J4)).length === 2 && slackFor(street4).length === 1 && (await editorRows(J4)) === 1);
  }

  c.head("A5 · photo-only: no editor bench · photo-first video job: 'video not found yet', then one ready");
  {
    const street = "5 Photo Pl";
    const id = await mkJob({ street, kind: "photos", evidence: RAWS(80, 0) });
    await sweep(id);
    const m = await markers(id);
    c.ok("photo-only: one receipt, 'photos only'", m.length === 1 && /photos only/.test(m[0].body), m[0]?.body ?? "");
    c.ok("…Slack says 'Photos in', never ready", slackFor(street).length === 1 && /Photos in/.test(slackFor(street)[0]) && !/ready/i.test(slackFor(street)[0]), slackFor(street).join(" | "));
    c.ok("…and no bell row reaches an editor", (await editorRows(id)) === 0 && (await prisma.notification.count({ where: { dedupeKey: { contains: id }, audience: { contains: "EDITOR" } } })) === 0);

    const s2 = "6 Photofirst Ct";
    const pf = await mkJob({ street: s2, kind: "reel", evidence: RAWS(80, 0) });
    await sweep(pf);
    const m2 = await markers(pf);
    const find = await prisma.smartTask.findUnique({ where: { dedupeKey: `raw-video-missing-${pf}` }, select: { title: true, status: true } });
    c.ok("photo-first: the receipt says the video isn't found yet", m2.length === 1 && /video not found yet/.test(m2[0].body), m2[0]?.body ?? "");
    c.ok("…the 'Find the raw video' task is there", !!find && find.status === "OPEN", find?.title ?? "none");
    c.ok("…and nothing says ready", !slackFor(s2).some((s) => /ready/i.test(s)) && (await editorRows(pf)) === 0, slackFor(s2).join(" | "));
    await prisma.project.update({ where: { id: pf }, data: { statusEvidence: RAWS(80, 6) } });
    advanceHours(1);
    await sweep(pf);
    const m3 = await markers(pf);
    c.ok("the video lands: exactly one ready notice follows", m3.filter((x) => x.body.startsWith("Ready for editing:")).length === 1 && slackFor(s2).filter((s) => /Ready for editing/.test(s)).length === 1, slackFor(s2).join(" | "));
    c.ok("…with one editor row", (await editorRows(pf)) === 1);
  }

  c.head("A6 · a Waiting hold, then its release — one fresh receipt and one fresh ready, hold-keyed");
  {
    await prisma.activity.create({ data: { projectId: J4, type: "SYSTEM", body: "Put back to Waiting by Kyle Drill — the hub holds it there until the photographer submits the upload page or the office moves it on." } });
    // (Nothing calls the handoff while a hold stands — the status sweep only
    // runs it for SHOT/EDITING/REVIEW and a held job sits on SCHEDULED.)
    await tick();
    const release = await prisma.activity.create({ data: { projectId: J4, type: "SYSTEM", body: "Waiting hold released — the photographer submitted the upload page." }, select: { createdAt: true } });
    await tick();
    await sweep(J4);
    const after = (await markers(J4)).filter((x) => x.createdAt > release.createdAt);
    c.ok("after the release: one receipt and one ready marker", after.length === 2, after.map((x) => x.body).join(" | "));
    c.ok("two Slack lines in all (one per hold)", slackFor(street4).length === 2, slackFor(street4).join(" | "));
    const keyed = await prisma.notification.count({ where: { userKey: "editor:john", dedupeKey: { startsWith: `ready-${J4}-h${release.createdAt.getTime()}` } } });
    c.ok("the fresh editor row carries the hold's time in its dedupe key", keyed === 1);
    advanceHours(1);
    await sweep(J4);
    c.ok("a later sweep adds nothing", slackFor(street4).length === 2 && (await editorRows(J4)) === 2);
  }

  c.head("A7 · legacy markers (written by the old code) — nothing is posted on deploy");
  {
    const s1 = "7 Legacy Ln";
    const L1 = await mkJob({ street: s1, kind: "reel", evidence: RAWS(50, 5) });
    await prisma.activity.create({ data: { projectId: L1, type: "SYSTEM", body: `Raws in for ${s1} — announced to the editor bench.` } });
    await prisma.project.update({ where: { id: L1 }, data: { handoffReadyAt: new Date(Date.now() - 86_400_000) } });
    await tick();
    await sweep(L1);
    c.ok("ready and announced before: nothing new", slackFor(s1).length === 0 && (await markers(L1)).length === 1 && (await editorRows(L1)) === 0);

    const s2 = "8 Legacy Blocked Dr";
    const L2 = await mkJob({ street: s2, kind: "tour", evidence: RAWS(50, 5) });
    await prisma.activity.create({ data: { projectId: L2, type: "SYSTEM", body: `Raws in for ${s2} — John Mark pinged by Slack DM.` } });
    await tick();
    await sweep(L2);
    c.ok("blocked, announced 'ready' by the old code: no second receipt", slackFor(s2).length === 0 && (await markers(L2)).length === 1);
    await prisma.project.update({ where: { id: L2 }, data: { debriefSubmittedAt: new Date(), videoInstructions: "VISION FOR THE EDIT\nKeep it bright; the agent wants the pool last." } });
    await sweep(L2);
    c.ok("…and when it becomes ready, no late duplicate 'ready' either", slackFor(s2).length === 0 && (await editorRows(L2)) === 0, slackFor(s2).join(" | "));
  }

  c.head("A8 · nothing readable in Dropbox — nothing announced");
  {
    const s = "9 Outage Ave";
    const id = await mkJob({ street: s, kind: "reel", evidence: null });
    await sweep(id);
    c.ok("no evidence: no marker, no Slack, no bell", (await markers(id)).length === 0 && slackFor(s).length === 0 && (await rowsFor(id)) === 0);
  }

  c.head("A9 · a caller that did not ask about readiness (upload fallback / Dropbox sweep) — 'files received', then the ready");
  {
    const s = "10 Fallback St";
    const id = await mkJob({ street: s, kind: "reel", evidence: RAWS(40, 4) });
    await tasks.notifyRawsLanded(id);
    const m = await markers(id);
    c.ok("the receipt says files received, not ready", m.length === 1 && /files received/.test(m[0].body) && slackFor(s).length === 1 && !/ready/i.test(slackFor(s)[0]), `${m[0]?.body} | ${slackFor(s).join(" | ")}`);
    c.ok("no editor row yet", (await editorRows(id)) === 0);
    await tick();
    await sweep(id);
    c.ok("the next handoff pass sends exactly one ready", slackFor(s).filter((x) => /Ready for editing/.test(x)).length === 1 && (await editorRows(id)) === 1, slackFor(s).join(" | "));
  }

  c.head("A10 · two passes at the same moment — one receipt, one ready, one Slack line");
  {
    const s = "11 Race Rd";
    const id = await mkJob({ street: s, kind: "reel", evidence: RAWS(40, 4) });
    await Promise.allSettled([sweep(id), sweep(id)]);
    const m = await markers(id);
    c.ok("one receipt marker and one ready marker", m.filter((x) => x.body.startsWith("Raws in for")).length === 1 && m.filter((x) => x.body.startsWith("Ready for editing:")).length === 1, m.map((x) => x.body).join(" | "));
    c.ok("one Slack line, one editor row", slackFor(s).length === 1 && (await editorRows(id)) === 1, slackFor(s).join(" | "));
  }

  // =========================================================================
  // PART B — THE 1080p PASS
  // =========================================================================
  let cutN = 0;
  type Job = { jobId: string; subId: string; projectId: string; original: string; final: string; requestId: string };
  /** One approved cut on its own job, its original in Final, and a 1080p job
   *  that Topaz has finished (state processing, credits spent). */
  async function mkRender(o: { street: string; sourceFacts?: boolean; state?: string; outputCheck?: string | null; downloadUrl?: boolean }): Promise<Job> {
    cutN++;
    const folder = `/Listings/Drill/${o.street}`;
    const p = await prisma.project.create({
      data: { title: `${o.street}, Media, PA`, clientId: client.id, status: "REVIEW", source: "ARYEO", aryeoListingId: `lst-b1-${cutN}`, dropboxFolder: folder },
      select: { id: true },
    });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
    const final = actualFolderPaths({ dropboxFolder: folder } as Parameters<typeof actualFolderPaths>[0]).finalVideo;
    const original = `${final}/Real Estate Video Tour - v1.mp4`;
    FS.set(original, 90_000_000);
    const blobUrl = `https://drill.invalid/cuts/cut-${cutN}.mp4`;
    PROBE.set(blobUrl, meta({ w: 3840, h: 2160 }));
    const sub = await prisma.reviewSubmission.create({
      data: {
        projectId: p.id, deliverableId: d.id, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload",
        fileName: "Real Estate Video Tour - v1.mp4", blobUrl, sizeBytes: 90_000_000, finalPath: original,
        completedAt: new Date(Date.now() - 3_600_000), decidedAt: new Date(Date.now() - 3_600_000), decidedBy: "James",
      },
      select: { id: true },
    });
    const requestId = `req-b1-${cutN}`;
    const job = await prisma.topazJob.create({
      data: {
        projectId: p.id, submissionId: sub.id, state: o.state ?? "processing", requestId,
        acceptedAt: new Date(Date.now() - 1_800_000), completeUploadAt: new Date(Date.now() - 1_500_000), startedAt: new Date(Date.now() - 1_900_000),
        sourceWidth: 3840, sourceHeight: 2160, sourceFrameRate: 30, sourceFrameCount: 1800, sourceDurationSec: 60, sourceContainer: "mp4", sourceSizeBytes: 90_000_000,
        outputWidth: 1920, outputHeight: 1080, estimateCredits: 27,
        ...(o.sourceFacts === false ? {} : { sourceHasAudio: true, sourceAudioCodec: "mp4a" }),
        ...(o.outputCheck !== undefined ? { outputCheck: o.outputCheck } : {}),
        ...(o.downloadUrl ? { downloadUrl: topazOut(requestId), savingStartedAt: new Date(Date.now() - 60_000) } : {}),
      },
      select: { id: true },
    });
    return { jobId: job.id, subId: sub.id, projectId: p.id, original, final, requestId };
  }
  const jobRow = (id: string) => prisma.topazJob.findUniqueOrThrow({ where: { id } });
  const deliverTasks = (jobId: string) => prisma.smartTask.count({ where: { dedupeKey: `topaz-deliver-${jobId}` } });
  const movesFrom = (p: string) => dbxLog.filter((x) => x.ep === "files/move_v2" && x.arg.from_path === p).length;
  const drive = async (fn: (id: string) => Promise<string>, id: string, n: number) => {
    const seen: string[] = [];
    for (let i = 0; i < n; i++) seen.push(await fn(id));
    return seen;
  };
  const spendBefore = { accept: calls.acceptVideoRequest, complete: calls.completeUpload };

  c.head("B0 · OLD (75d56f1): a render nobody could read is FILED as the deliverable");
  {
    const j = await mkRender({ street: "20 Old Render Rd", sourceFacts: false });
    const seen = await drive(oldTopaz.advanceTopazJob, j.jobId, 5);
    const r = await jobRow(j.jobId);
    c.ok("old: after three unreadable checks it went on to be filed — state done", r.state === "done", seen.join(" → "));
    c.ok("old: finalPath/savedAt say the 1080p file exists", !!r.finalPath && !!r.savedAt, r.finalPath ?? "");
    c.ok("old: the editor's approved original was moved out of Final", !FS.has(j.original) && movesFrom(j.original) === 1);
    c.ok("old: Kyle was handed the unchecked file to deliver", (await deliverTasks(j.jobId)) === 1);
  }

  c.head("B1 · (a) unreadable from Topaz AND from Dropbox → HELD, nothing trusted");
  const A = await mkRender({ street: "21 Held Ln" });
  {
    const seen = await drive(tj.advanceTopazJob, A.jobId, 5);
    const r = await jobRow(A.jobId);
    c.ok("four checks against Topaz, then saving, then held", seen.join(",") === "processing,processing,processing,saving,held", seen.join(" → "));
    c.ok("state held, outputCheck unverified, heldAt stamped", r.state === "held" && r.outputCheck === "unverified" && !!r.heldAt);
    c.ok("NOT finalPath, NOT savedAt", r.finalPath === null && r.savedAt === null);
    c.ok("the file waits in Final/unverified/ under an unmistakable name", !!r.heldPath && r.heldPath.startsWith(`${A.final}/unverified/`) && /\(Topaz - unchecked\)\.mp4$/.test(r.heldPath) && FS.has(r.heldPath), r.heldPath ?? "");
    c.ok("the approved original was never moved", FS.has(A.original) && movesFrom(A.original) === 0);
    c.ok("Kyle was not handed anything", (await deliverTasks(A.jobId)) === 0 && (await prisma.notification.count({ where: { kind: "topaz_ready", dedupeKey: { startsWith: `topaz-ready-${A.jobId}` } } })) === 0);
    c.ok("the check is on the record, with which copy was read", /"where":"dropbox"/.test(r.outputCheckJson ?? "") && /"verdict":"unreadable"/.test(r.outputCheckJson ?? ""));
    c.ok("one hold notice (topaz_problem, OWNER/ADMIN)", (await prisma.notification.count({ where: { kind: "topaz_problem", dedupeKey: { startsWith: `topaz-held-${A.jobId}` } } })) >= 1);
    c.ok("Topaz's copy was tidied away once the bytes were safe in Dropbox", calls.deleteVideoFiles >= 1);

    const board = await readyToSend({ projectId: A.projectId });
    const row = board.rendering.find((x) => x.submissionId === A.subId);
    c.ok("ready card: listed under rendering, never under ready", !!row && !board.ready.some((x) => x.submissionId === A.subId));
    c.ok("…saying a reviewer has to listen", !!row && /couldn't be verified/.test(row.says), row?.says ?? "");
    c.ok("…with the held file named and linked for listening", !!row?.held && row.held.jobId === A.jobId && /unchecked/.test(row.held.fileName) && !!row.held.dropboxUrl);
    c.ok("cutsOnTheCardFor excludes it (the Aryeo webhook cannot stamp it)", !(await cutsOnTheCardFor(A.projectId)).has(A.subId));
    const sent = await markVideoSent(A.subId, "Kyle");
    c.ok("markVideoSent refuses it", !sent.ok, sent.message);
    const ex = await opsExceptionsBoard();
    const exRow = ex.rows.find((x) => x.id === `held:${A.jobId}`);
    c.ok("exceptions board: an 'unverified-render' row with an owner and the next action", !!exRow && exRow.kind === "unverified-render" && !!exRow.owner && /Listen to the 1080p file or keep the original/.test(exRow.nextAction), exRow ? `${exRow.owner} — ${exRow.nextAction}` : "none");
    c.ok("…and it is counted in the totals", ex.totals["unverified-render"].all >= 1);
    const retry = await tj.retryTopazJob(A.jobId);
    c.ok("'Try again' refuses a held file (no blind re-render)", !retry.ok, retry.message);

    const statusBefore = calls.videoStatus;
    const replay = await tj.advanceTopazJob(A.jobId);
    const drove = await tj.driveTopazJobs({ max: 10, leaseBy: "drill" });
    c.ok("a replayed tick is a no-op, and the driver never claims it", replay === "held" && (await jobRow(A.jobId)).state === "held" && calls.videoStatus === statusBefore, `replay=${replay} claimed=${drove.claimed}`);
  }

  c.head("B2 · (b) Topaz's link unreadable, the Dropbox copy reads fine → promoted, filed once");
  const B = await mkRender({ street: "22 Second Look St" });
  {
    // Whatever name the held copy gets, its temporary link reads as a good file.
    const heldGuess = `${B.final}/unverified/Real Estate Video Tour - v1 (Topaz - unchecked).mp4`;
    PROBE.set(dbxTmp(heldGuess), meta());
    const seen = await drive(tj.advanceTopazJob, B.jobId, 5);
    const r = await jobRow(B.jobId);
    c.ok("done, and verified from the Dropbox copy", r.state === "done" && r.outputCheck === "verified" && /"where":"dropbox"/.test(r.outputCheckJson ?? ""), seen.join(" → "));
    c.ok("promoted to FINAL (Topaz) at the top of Final; nothing left in unverified/", r.finalPath === `${B.final}/Real Estate Video Tour - v1 - FINAL (Topaz).mp4` && FS.has(r.finalPath!) && !FS.has(heldGuess) && r.heldPath === null, r.finalPath ?? "");
    c.ok("the original moved to superseded/ exactly once", !FS.has(B.original) && movesFrom(B.original) === 1);
    c.ok("exactly one upload card for Kyle", (await deliverTasks(B.jobId)) === 1);
    await tj.advanceTopazJob(B.jobId);
    c.ok("a replayed tick changes nothing", (await deliverTasks(B.jobId)) === 1 && movesFrom(B.original) === 1 && (await jobRow(B.jobId)).state === "done");
    const board = await readyToSend({ projectId: B.projectId });
    c.ok("the ready card offers the 1080p file", board.ready.some((x) => x.submissionId === B.subId && x.file.source === "topaz-1080p"));
  }

  c.head("B3 · (c) a reviewer keeps the approved original");
  {
    const r0 = await jobRow(A.jobId);
    const res = await tj.resolveHeldTopazJob(A.jobId, "use-original", "James Reviewer", { why: "couldn't open it on my phone" });
    const r = await jobRow(A.jobId);
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: A.subId }, select: { finalPath: true } });
    c.ok("resolved: state failed, outputCheck resolved-original", res.ok && r.state === "failed" && r.outputCheck === "resolved-original", res.message);
    c.ok("who, when and why are on the row", r.resolvedBy === "James Reviewer" && !!r.resolvedAt && r.resolution === "use-original" && /phone/.test(r.resolutionNote ?? ""));
    c.ok("the unchecked file went to superseded/ — moved, not deleted", !!r.heldPath && r.heldPath.includes("/superseded/") && FS.has(r.heldPath) && !FS.has(r0.heldPath!), r.heldPath ?? "");
    c.ok("the original is now marked FINAL (editor export)", !!sub.finalPath && /FINAL \(editor export\)/.test(sub.finalPath) && FS.has(sub.finalPath), sub.finalPath ?? "");
    const board = await readyToSend({ projectId: A.projectId });
    const row = board.ready.find((x) => x.submissionId === A.subId);
    c.ok("the ready card now offers the editor's own file", !!row && row.file.source === "editor-hub-copy", row?.file.source ?? "none");
    const again = await tj.resolveHeldTopazJob(A.jobId, "accept-processed", "Kyle", { attest: HELD_ATTESTATION });
    c.ok("a second decision is refused", !again.ok, again.message);
    const retry = await tj.retryTopazJob(A.jobId);
    c.ok("'Try again' will not undo the recorded decision", !retry.ok, retry.message);
  }

  c.head("B4 · (d) accepting the processed file needs the listen attestation; a double press lands once");
  const C = await mkRender({ street: "23 Listen Ln" });
  {
    await drive(tj.advanceTopazJob, C.jobId, 5);
    c.ok("held", (await jobRow(C.jobId)).state === "held");
    const none = await tj.resolveHeldTopazJob(C.jobId, "accept-processed", "Kyle Drill");
    const wrong = await tj.resolveHeldTopazJob(C.jobId, "accept-processed", "Kyle Drill", { attest: "looks fine" });
    c.ok("refused without the attestation, and with the wrong words", !none.ok && !wrong.ok && (await jobRow(C.jobId)).state === "held", none.message);
    const [x, y] = await Promise.all([
      tj.resolveHeldTopazJob(C.jobId, "accept-processed", "Kyle Drill", { attest: HELD_ATTESTATION }),
      tj.resolveHeldTopazJob(C.jobId, "accept-processed", "Jordan", { attest: HELD_ATTESTATION }),
    ]);
    const r = await jobRow(C.jobId);
    c.ok("exactly one of two simultaneous presses wins", [x.ok, y.ok].filter(Boolean).length === 1, `${x.message} | ${y.message}`);
    c.ok("done, resolved-processed, FINAL (Topaz) in place", r.state === "done" && r.outputCheck === "resolved-processed" && !!r.finalPath && /FINAL \(Topaz\)/.test(r.finalPath) && FS.has(r.finalPath), r.finalPath ?? "");
    c.ok("the attestation is the recorded reason", r.resolution === "accept-processed" && r.resolutionNote === HELD_ATTESTATION && !!r.resolvedBy);
    c.ok("exactly one upload card for Kyle", (await deliverTasks(C.jobId)) === 1);
  }

  c.head("B4b · 'Check again' re-reads Dropbox only, and releases a file that now reads");
  {
    const D = await mkRender({ street: "24 Recheck Row" });
    await drive(tj.advanceTopazJob, D.jobId, 5);
    const held = await jobRow(D.jobId);
    const statusBefore = calls.videoStatus;
    const still = await tj.recheckHeldTopazJob(D.jobId, "Kyle Drill");
    c.ok("still unreadable: stays held, says so", !still.ok && (await jobRow(D.jobId)).state === "held", still.message);
    PROBE.set(dbxTmp(held.heldPath!), meta());
    const now = await tj.recheckHeldTopazJob(D.jobId, "Kyle Drill");
    const r = await jobRow(D.jobId);
    c.ok("readable now: released, verified, one upload card", now.ok && r.state === "done" && r.outputCheck === "verified" && (await deliverTasks(D.jobId)) === 1, now.message);
    c.ok("…without a single call to Topaz", calls.videoStatus === statusBefore);
  }

  c.head("B4c · a decision that died after the move is finished by the next press, not refused");
  {
    const H = await mkRender({ street: "33 Half Done Dr" });
    await drive(tj.advanceTopazJob, H.jobId, 5);
    const held = await jobRow(H.jobId);
    // What a crash between the Dropbox move and the job's last write leaves:
    // the file promoted, the row still held, a stale claim on it.
    const promoted = `${H.final}/Real Estate Video Tour - v1 - FINAL (Topaz).mp4`;
    FS.set(promoted, FS.get(held.heldPath!)!);
    FS.delete(held.heldPath!);
    await prisma.topazJob.update({
      where: { id: H.jobId },
      data: { heldPath: null, finalPath: promoted, savedAt: new Date(), resolvedAt: new Date(Date.now() - 10 * 60_000), resolvedBy: "Kyle Drill", resolution: "accept-processed" },
    });
    const res = await tj.resolveHeldTopazJob(H.jobId, "accept-processed", "Kyle Drill", { attest: HELD_ATTESTATION });
    const r = await jobRow(H.jobId);
    c.ok("finished: done, the file where it was, one upload card", res.ok && r.state === "done" && r.finalPath === promoted && FS.has(promoted) && (await deliverTasks(H.jobId)) === 1, res.message);
  }

  c.head("B5 · (e) no spend in any branch");
  c.ok("zero accept / complete-upload calls across every scenario above", calls.acceptVideoRequest === spendBefore.accept && calls.completeUpload === spendBefore.complete, JSON.stringify(calls));

  c.head("B6 · (f) readable and WRONG still fails at once, original untouched");
  {
    const L = await mkRender({ street: "25 Silent St" });
    PROBE.set(topazOut(L.requestId), meta({ audio: false }));
    const s1 = await tj.advanceTopazJob(L.jobId);
    const r = await jobRow(L.jobId);
    c.ok("silent output: failed, nothing saved to Dropbox", s1 === "failed" && r.state === "failed" && /no sound/.test(r.error ?? "") && !dbxLog.some((x) => x.ep === "files/save_url" && String(x.arg.path).includes("25 Silent St")), r.error ?? "");
    c.ok("…the original stays (renamed FINAL (editor export), as for any failed pass)", movesFrom(L.original) <= 1 && [...FS.keys()].some((k) => k.includes("25 Silent St") && /FINAL \(editor export\)/.test(k)));

    const M = await mkRender({ street: "26 Short Cut Ct" });
    PROBE.set(topazOut(M.requestId), meta({ dur: 45 }));
    await tj.advanceTopazJob(M.jobId);
    const rm = await jobRow(M.jobId);
    c.ok("a 45s file for a 60s cut: failed as a different video", rm.state === "failed" && /45s long where the approved cut runs 60s/.test(rm.error ?? ""), rm.error ?? "");

    const W = await mkRender({ street: "27 Wrong Size Way" });
    PROBE.set(topazOut(W.requestId), meta({ w: 3840, h: 2160 }));
    await tj.advanceTopazJob(W.jobId);
    const rw = await jobRow(W.jobId);
    c.ok("a 4K file where 1080p was asked for: failed", rw.state === "failed" && /3840×2160 where 1920×1080/.test(rw.error ?? ""), rw.error ?? "");

    const OK = await mkRender({ street: "28 Good File Blvd" });
    PROBE.set(topazOut(OK.requestId), meta({ dur: 60.4 }));
    const seen = await drive(tj.advanceTopazJob, OK.jobId, 2);
    const ro = await jobRow(OK.jobId);
    c.ok("a good file (within tolerance) is filed as before: verified → done", ro.state === "done" && ro.outputCheck === "verified" && (await deliverTasks(OK.jobId)) === 1, seen.join(" → "));
  }

  c.head("B7 · (g) source can't be re-read, output silent: OLD waved it through, NEW calls it lost");
  {
    const O = await mkRender({ street: "29 Unreadable Source Rd", sourceFacts: false });
    PROBE.delete(`https://drill.invalid/cuts/cut-${cutN}.mp4`); // the source cannot be re-read now
    PROBE.set(topazOut(O.requestId), meta({ audio: false }));
    const seen = await drive(oldTopaz.advanceTopazJob, O.jobId, 5);
    const ro = await jobRow(O.jobId);
    c.ok("old: a silent file became the deliverable", ro.state === "done" && !!ro.finalPath, seen.join(" → "));

    const N = await mkRender({ street: "30 Remembered Source Rd" }); // facts kept on the row at queue time
    PROBE.delete(`https://drill.invalid/cuts/cut-${cutN}.mp4`);
    PROBE.set(topazOut(N.requestId), meta({ audio: false }));
    const s = await tj.advanceTopazJob(N.jobId);
    const rn = await jobRow(N.jobId);
    c.ok("new: judged against the persisted source facts → lost, failed at once", s === "failed" && /no sound/.test(rn.error ?? ""), rn.error ?? "");
  }

  c.head("B8 · stepQueued keeps what the source sounded like");
  {
    const Q = await mkRender({ street: "31 Queued Quay", state: "queued", sourceFacts: false });
    await prisma.topazJob.update({ where: { id: Q.jobId }, data: { requestId: null, acceptedAt: null, completeUploadAt: null, sourceFrameCount: null } });
    await tj.advanceTopazJob(Q.jobId);
    const r = await jobRow(Q.jobId);
    c.ok("sourceHasAudio / sourceAudioCodec written from the header", r.sourceHasAudio === true && r.sourceAudioCodec === "mp4a", `${r.sourceHasAudio} ${r.sourceAudioCodec} (state ${r.state}${r.skipReason ? `: ${r.skipReason}` : ""})`);
  }

  c.head("B9 · legacy: a row already saving with no check recorded behaves as it always did");
  {
    const G = await mkRender({ street: "32 Legacy Save St", state: "saving", outputCheck: null, downloadUrl: true });
    const s = await tj.advanceTopazJob(G.jobId);
    const r = await jobRow(G.jobId);
    c.ok("filed straight to FINAL (Topaz), done, one card", s === "done" && !!r.finalPath && /FINAL \(Topaz\)/.test(r.finalPath) && r.heldPath === null && (await deliverTasks(G.jobId)) === 1, `${s} ${r.finalPath}`);
    c.ok("…and the outputCheck column is left as it was (null)", r.outputCheck === null);
  }

  c.head("Z · isolation");
  c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));

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
