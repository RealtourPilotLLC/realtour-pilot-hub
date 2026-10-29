// ---------------------------------------------------------------------------
// DRILL: OCT 29 2026 — START AND STOP PER VIDEO, THE BRIEF BEHIND START, THE
// PRESS-START REMINDER AND THE EDITOR SPEED NUMBERS (Jordan, verbatim: "for
// tracking the video editors, I want to see the average number of videos they
// get done per day, and how long it takes them from start to finish. Also,
// when Kim doesn't press start on a video, can we auto-remind him to press
// start? Or maybe he can't see the project details until he presses start? I
// want everyone else to be able to see the details. Maybe for both Kim and
// John: they see a brief project summary, and to see all details and
// instructions, they press start. And maybe when they send a video for
// review, it automatically stops, but the project is still open at that
// point. It would have to work that way for each individual video so we can
// track how long it takes them.")
//
//   DRILL_PORT=6856 node scripts/_drill/run-all.cjs scripts/_drill/oct29-editor-start-tracking.ts
//
//   0  The pure rules: who is gated, when the brief is open, stretches and
//      which version they belong to, the speed math (Start to sent, on the
//      clock, left running, no Start, fixing, videos a day), the reminder's
//      reason and its hours.
//   1  Start, then the send: that video's clock stops (SUBMIT), the job stays
//      open (status, edit card).
//   2  Per video: a Start on video 2 keeps running when video 1 is sent;
//      another video on the same job is two events (stop, start).
//   3  The revision: Start again after the send-back, stopped by version 2.
//   4  The page: Kim before Start gets the summary and nothing else (no
//      instructions, notes, messages or links in what the server returns);
//      after Start the whole brief; Jordan always the whole brief.
//   5  The Editing Room's folder links and the assistant wait for Start too.
//   6  The reminder: John's late job, once a day, never at night, none once
//      he presses Start, none for a job just handed over.
//   7  The numbers from all of the above (editorSpeedReport).
//
// ISOLATION: PGlite via the shared harness; production is never opened; every
// outbound call is fenced; Slack is answered by a fake and counted; nothing
// reaches a client.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6856);
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---- the clock: moves forward only -------------------------------------------
const RealDate = Date;
/** Oct/Nov 2026 wall clock in EDT (UTC-4). */
const edt = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
let offset = edt(10, 26, 9).getTime() - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
let last = edt(10, 26, 9).getTime();
const setClock = (d: Date) => {
  if (d.getTime() < last) throw new Error(`drill clock may only move forward (${d.toISOString()})`);
  last = d.getTime();
  offset = d.getTime() - RealDate.now();
};

// The page's element tree is walked, not rendered.
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  function Link(p: unknown) { return p; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
    return realLoad.call(this, request, parent, isMain);
  };
}
installNextStubs();

// ---- Slack, faked at fetch and counted ----------------------------------------
type SlackPost = { channel: string; text: string };
const slack: SlackPost[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") {
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  if (method === "conversations.open") return json({ ok: false, error: "missing_scope" });
  return json({ ok: false, error: `drill: ${method}` });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type El = { $$typeof: symbol; type: any; key: string | null; props: Record<string, any> };
const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
const typeName = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
function walk(n: any, visit: (e: El) => void) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isEl(n)) return;
  visit(n);
  for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v, visit);
}
const find = (tree: any, pred: (e: El) => boolean) => { const out: El[] = []; walk(tree, (e) => { if (pred(e)) out.push(e); }); return out; };
const named = (tree: any, name: string) => find(tree, (e) => typeName(e.type) === name);
/** Everything the server put in the tree, props and data included, as one string. */
function dump(n: any): string {
  const seen = new Set<unknown>();
  return JSON.stringify(n, (_k, v) => {
    if (typeof v === "function") return undefined;
    if (typeof v === "symbol") return String(v);
    if (v && typeof v === "object") { if (seen.has(v)) return undefined; seen.add(v); }
    return v;
  }) ?? "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const S = { kyle: "U0KYLE0001", kim: "U0KIMMIG01", john: "U0JOHNMR01" };
const H = 3_600_000;
/** The drill clock keeps ticking in real time between steps: the same moment, give or take a second. */
const near = (a: Date | null | undefined, b: Date) => !!a && Math.abs(a.getTime() - b.getTime()) < 2_000;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "drill-secret-oct29-start-tracking-0123456789" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const warn = console.warn;
  try {
    const gate = await import("@/lib/editorBriefGate");
    const speed = await import("@/lib/editorSpeed");
    const rem = await import("@/lib/editStartReminders");

    // =====================================================================
    c.head("0 · The pure rules");
    // =====================================================================
    c.ok("gated: Kim and John Mark's editor logins; not the owner, the office, the creative manager, or an editor with no desk key",
      gate.briefGated({ role: "EDITOR", editorKey: "kim" }) && gate.briefGated({ role: "EDITOR", editorKey: "john" }) &&
      !gate.briefGated({ role: "OWNER", editorKey: null }) && !gate.briefGated({ role: "ADMIN", editorKey: null }) && !gate.briefGated({ role: "CREATIVE_MANAGER", editorKey: null }) &&
      !gate.briefGated({ role: "EDITOR", editorKey: null }) && !gate.briefGated({ role: "EDITOR", editorKey: "luma" }) && !gate.briefGated(null));
    c.ok("open while their work on the job is active or paused; closed when there is none, or it was closed by a send",
      gate.briefOpenForState("ACTIVE") && gate.briefOpenForState("PAUSED") && !gate.briefOpenForState("CLOSED") && !gate.briefOpenForState(null));
    c.ok("a video's state in the brief's own words", gate.videoStateWords(null) === "Not started" && gate.videoStateWords({ status: "PENDING", round: 1 }) === "Version 1 in review" && gate.videoStateWords({ status: "CHANGES_REQUESTED", round: 2 }) === "Changes requested on version 2" && gate.videoStateWords({ status: "APPROVED", round: 3 }) === "Approved");

    const t = (h: number) => new RealDate(edt(10, 20, 9).getTime() + h * H);
    const ev = (itemId: string, kind: string, h: number, outputId: string | null = null) => ({ itemId, editorKey: "kim", projectId: "p1", outputId, kind, at: t(h) });
    const st = speed.stretchesFromEvents([
      ev("i1", "START", 0, "vA"), ev("i1", "PAUSE", 2, "vA"), ev("i1", "RESUME", 3, "vA"), ev("i1", "SUBMIT", 4, "vA"),
      ev("i1", "START", 5, "vB"), ev("i1", "AUTO_PAUSE", 6, "vB"), ev("i1", "START", 6, "vA"),
    ]);
    c.ok("stretches: Start or Resume to the next Pause, switch or send on the same item; the last one still running", st.length === 4 && st.map((s) => `${s.outputId}:${(s.from.getTime() - t(0).getTime()) / H}-${s.to ? (s.to.getTime() - t(0).getTime()) / H : "open"}`).join(",") === "vA:0-2,vA:3-4,vB:5-6,vA:6-open", st.map((s) => `${s.outputId}:${s.from.toISOString()}-${s.to?.toISOString()}`).join(","));
    const sent = [
      { id: "a1", editorKey: "kim", projectId: "p1", outputId: "vA", at: t(4) },
      { id: "b1", editorKey: "kim", projectId: "p1", outputId: "vB", at: t(9) },
      { id: "a2", editorKey: "kim", projectId: "p1", outputId: "vA", at: t(8) },
    ];
    const att = speed.attributeStretches(st, sent, t(20));
    const hoursOf = (id: string) => (att.get(id) ?? []).map((x) => x.hours).join("+");
    c.ok("each stretch counts for its own video's next version: v1 of video A 2+1 h, video B 1 h, video A's v2 2 h (cut off at the send)", hoursOf("a1") === "2+1" && hoursOf("b1") === "1" && hoursOf("a2") === "2", JSON.stringify([hoursOf("a1"), hoursOf("b1"), hoursOf("a2")]));
    const jobLevel = speed.attributeStretches(speed.stretchesFromEvents([ev("j", "START", 0), ev("j", "SUBMIT", 3)]), [{ id: "x", editorKey: "kim", projectId: "p1", outputId: "vZ", at: t(3) }], t(20));
    c.ok("a Start that named no video counts for the next version sent on the job", (jobLevel.get("x") ?? []).map((x) => x.hours).join() === "3");
    const after = speed.attributeStretches(speed.stretchesFromEvents([ev("k", "START", 5, "vA")]), [{ id: "y", editorKey: "kim", projectId: "p1", outputId: "vA", at: t(4) }], t(20));
    c.ok("a Start pressed after the version was sent is not that version's (no invented start)", !after.has("y"));

    const now0 = edt(10, 23, 17);
    const v = (o: Partial<import("@/lib/editorSpeed").SpeedVideo>) => ({ editorKey: "kim", styleName: "Premium Social Media Reel", assignedAt: null, startedAt: null, firstCutAt: edt(10, 22, 12), approvedAt: null, dueAt: null, ...o });
    const cell = speed.speedCell([
      v({ startedAt: edt(10, 22, 9), firstCutAt: edt(10, 22, 12), workHours: 2.5 }),
      v({ startedAt: edt(10, 21, 9), firstCutAt: edt(10, 22, 10), workHours: 14, leftRunning: true, fixHours: [6, 3] }),
      v({ startedAt: null, firstCutAt: edt(10, 23, 11), workHours: null }),
    ], now0);
    c.ok("Start to sent averages the clock time (3 h and 25 h), leaving out the video with no Start", cell.startToFirstCut.hours === 14 && cell.startToFirstCut.n === 2, JSON.stringify(cell.startToFirstCut));
    c.ok("on the clock: 2.5 h over the one clean video; the left-running one is counted apart; one sent with no Start", cell.onClock.hours === 2.5 && cell.onClock.n === 1 && cell.leftRunning === 1 && cell.startUnknown === 1, JSON.stringify({ onClock: cell.onClock, leftRunning: cell.leftRunning, startUnknown: cell.startUnknown }));
    c.ok("fixing: send-back to the next version, averaged (6 h and 3 h)", cell.fixTime.hours === 4.5 && cell.fixTime.n === 2, JSON.stringify(cell.fixTime));
    // Fri Oct 23 2026: the last 7 Eastern dates are Sat 17 .. Fri 23, five of them weekdays.
    c.ok("weekdays in the window: 5 of the last 7 Eastern dates, 22 of 30", speed.weekdaysIn(7, now0) === 5 && speed.weekdaysIn(30, now0) === 22, `${speed.weekdaysIn(7, now0)} / ${speed.weekdaysIn(30, now0)}`);
    const pace = speed.paceOf([v({ firstCutAt: edt(10, 19, 10) }), v({ firstCutAt: edt(10, 19, 15) }), v({ firstCutAt: edt(10, 21, 10) })], 7, now0);
    c.ok("videos a day: 3 sent over 5 weekdays = 0.6, and 1.5 on the 2 days they sent one", pace.sent === 3 && pace.weekdays === 5 && pace.perWeekday === 0.6 && pace.activeDays === 2 && pace.perActiveDay === 1.5, JSON.stringify(pace));

    const job = (o: Partial<import("@/lib/editStartReminders").StartReminderJob> = {}) => ({ editorKey: "john", projectId: "p", street: "1 Main St", dueISO: null, late: false, readyISO: null, working: false, startable: true, ...o });
    const rn = edt(10, 27, 10);
    c.ok("reminder: late, due within 48 h, or ready 4 days; nothing while they are on it, or when it is not theirs to start",
      rem.startReminderReason(job({ late: true }), rn) === "late" &&
      rem.startReminderReason(job({ dueISO: new RealDate(rn.getTime() + 47 * H).toISOString() }), rn) === "due_soon" &&
      rem.startReminderReason(job({ dueISO: new RealDate(rn.getTime() + 50 * H).toISOString() }), rn) === null &&
      rem.startReminderReason(job({ readyISO: new RealDate(rn.getTime() - 97 * H).toISOString() }), rn) === "waiting" &&
      rem.startReminderReason(job({ readyISO: new RealDate(rn.getTime() - 30 * H).toISOString() }), rn) === null &&
      rem.startReminderReason(job({ late: true, working: true }), rn) === null &&
      rem.startReminderReason(job({ late: true, startable: false }), rn) === null);
    c.ok("its hours: weekdays 9 AM to 6 PM Eastern; not at night, not on Saturday",
      rem.inStartReminderWindow(edt(10, 27, 9)) && rem.inStartReminderWindow(edt(10, 27, 17, 59)) && !rem.inStartReminderWindow(edt(10, 27, 18)) &&
      !rem.inStartReminderWindow(edt(10, 27, 22)) && !rem.inStartReminderWindow(edt(10, 27, 3)) && !rem.inStartReminderWindow(edt(10, 31, 11)));
    const line = rem.startReminderLine({ street: "13 Lancaster Ave", dueISO: edt(10, 28, 17).toISOString(), late: true, readyISO: null }, "late", "Asia/Manila", rn);
    c.ok("its words: press Start, why, the brief opens on Start; no dashes", line === "Press Start on 13 Lancaster Ave when you begin. It is late (due Wed, Oct 28, 5 PM ET (Thu, Oct 29, 5 AM Manila)), and nobody has pressed Start on it. The brief opens when you press Start." && !/[—–]/.test(line), line);

    // =====================================================================
    // The cast and the jobs (Mon Oct 26 2026, 9 AM ET)
    // =====================================================================
    const { prisma } = await import("@/lib/prisma");
    const { establishSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const dout = await import("@/lib/deliverableOutputs");
    const work = await import("@/lib/editorWork");
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));
    const member = (name: string, email: string, role: "ADMIN" | "MANAGER" | "PHOTOGRAPHER" | "EDITOR" | "VA", slackId: string | null, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email, role, slackId, active: true, ...extra }, select: { id: true } });
    const jordanTm = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER", null);
    const kyleTm = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", S.kyle);
    const kimTm = await member("Kim Miguel", "kim@drill.invalid", "MANAGER", S.kim);
    const johnTm = await member("John Mark Reyes", "john@drill.invalid", "VA", S.john);
    const login = (email: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
    const jordanLogin = await login("jordan@drill.invalid", "OWNER", jordanTm.id);
    await login("kyle@drill.invalid", "ADMIN", kyleTm.id);
    const kimLogin = await login("kim@drill.invalid", "EDITOR", kimTm.id, { editorKey: "kim" });
    const johnLogin = await login("john@drill.invalid", "EDITOR", johnTm.id, { editorKey: "john" });

    const SECRET = { instructions: "VISION FOR THE EDIT\nOpen on the koi pond at dusk.", notes: "Gate code 4471, the dog is friendly.", message: "Use the drone shot from the second folder.", clientNote: "Never show the neighbor's boat." };
    const client = await prisma.client.create({ data: { name: "Dana Drill", editingPreferences: SECRET.clientNote }, select: { id: true } });
    const mkJob = async (street: string, o: { editor: "kim" | "john"; videos?: number; data?: Record<string, unknown>; cardStatus?: "OPEN" | "IN_PROGRESS" }) => {
      const p = await prisma.project.create({
        data: {
          clientId: client.id, title: `${street}, Malvern, PA 19355`, status: "SHOT", source: "MANUAL", shootDate: edt(10, 24, 10), handoffReadyAt: edt(10, 25, 9),
          videoInstructions: `STYLE: Fast-Paced\n\n${SECRET.instructions}`, notes: SECRET.notes,
          deliverables: { create: [{ type: "SOCIAL_REEL", label: "Premium Social Media Reel", quantity: o.videos ?? 1, videoStyle: "premium_social_reel" }] },
          ...o.data,
        },
        select: { id: true },
      });
      await dout.ensureOutputsForProject(p.id);
      await prisma.smartTask.create({ data: { taskType: "edit_video", status: o.cardStatus ?? "OPEN", title: `Edit video, ${street}`, projectId: p.id, dedupeKey: `edit-video-${p.id}`, source: "hub", assignedKey: o.editor } });
      const outs = await prisma.deliverableOutput.findMany({ where: { projectId: p.id }, orderBy: { slot: "asc" }, select: { id: true, deliverableId: true, slot: true } });
      return { id: p.id, street, outs };
    };
    const birch = await mkJob("12 Birch Ln", { editor: "kim", videos: 2 });
    await prisma.projectMessage.create({ data: { projectId: birch.id, authorName: "Kyle Smith", body: SECRET.message } });
    const [vA, vB] = birch.outs;
    const send = async (o: { id: string; deliverableId: string; slot: number }, round: number, at: Date, status = "PENDING") => {
      setClock(at);
      const s = await prisma.reviewSubmission.create({ data: { projectId: birch.id, deliverableId: o.deliverableId, outputId: o.id, slot: o.slot, round, status, kind: "video", source: "upload", fileName: `birch-${o.slot}-v${round}.mp4`, submittedByKey: "kim", submittedByName: "Kim", createdAt: at }, select: { id: true } });
      // The hand-in's own close (review/actions submitCutForReview): that video only.
      await work.closeActiveWork(birch.id, { editorKey: "kim", reason: "SUBMITTED", actor: { userId: kimLogin.id, name: "Kim", role: "EDITOR" }, detail: "cut submitted", forOutputId: o.id });
      return s.id;
    };
    const item = () => prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: "kim", projectId: birch.id } } });
    const events = () => prisma.editorWorkEvent.findMany({ where: { projectId: birch.id }, orderBy: [{ at: "asc" }, { id: "asc" }], select: { kind: true, outputId: true, at: true, reason: true } });
    const label = (o: string | null) => (o === vA.id ? "A" : o === vB.id ? "B" : o ? "?" : "-");

    // =====================================================================
    c.head("4a · The page, as Kim, BEFORE Start: the summary only");
    // =====================================================================
    const EditPage = (await import("@/app/edit/[id]/page")).default;
    const view = async (id: string, search: Record<string, string> = {}) => {
      console.warn = () => {};
      try { return await EditPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) } as never); }
      finally { console.warn = warn; }
    };
    await establishSession(kimLogin.id);
    const before = await view(birch.id);
    const gateEl = named(before, "EditorStartGate")[0];
    const sum = gateEl?.props.summary as import("@/lib/editorBriefGate").BriefSummary | undefined;
    c.ok("Kim gets the summary page (EditorStartGate), not the brief", !!gateEl && find(before, (e) => "data-brief-section" in (e.props ?? {})).length === 0);
    c.ok("…the client, the property, both videos with their kind and state, and Start for the first one",
      sum?.client === "Dana Drill" && sum?.street === "12 Birch Ln" && sum?.videos.length === 2 && sum.videos.every((x) => x.kind === "Premium Social Media Reel" && x.state === "Not started") &&
      gateEl?.props.selectedOutputId === vA.id && gateEl?.props.bar?.mode === "editor" && gateEl?.props.bar?.canStart === true, JSON.stringify({ sum, pick: gateEl?.props.selectedOutputId, bar: gateEl?.props.bar?.mode }));
    const leaked = Object.entries(SECRET).filter(([, s]) => dump(before).includes(s.split("\n").pop()!.slice(0, 20)));
    c.ok("nothing behind Start is in what the server returned: instructions, notes, team messages, client preferences", leaked.length === 0, leaked.map(([k]) => k).join(","));
    c.ok("…and no footage link", !/dropbox\.com|\/footage|data-brief-section/.test(dump(before)));
    const picked = await view(birch.id, { output: vB.id });
    c.ok("?output= picks which video Start names", named(picked, "EditorStartGate")[0]?.props.selectedOutputId === vB.id);
    await establishSession(jordanLogin.id);
    const owner = await view(birch.id);
    c.ok("Jordan sees the whole brief, Start or not", !named(owner, "EditorStartGate").length && find(owner, (e) => e.props?.["data-brief-section"] === "header").length === 1 && dump(owner).includes("koi pond"));

    // =====================================================================
    c.head("1 · Start, then the send: that video's clock stops, the job stays open");
    // =====================================================================
    await establishSession(kimLogin.id);
    setClock(edt(10, 26, 10));
    const s1 = await work.startEditing({ projectId: birch.id, outputId: vA.id, requestId: "drill-start-1" });
    const i1 = await item();
    const startedBells = () => prisma.notification.count({ where: { kind: "edit_started" } });
    const bellsAfterFirst = await startedBells();
    c.ok("Start on video 1: active, named, a START event", s1.ok && i1?.state === "ACTIVE" && i1.outputId === vA.id && (await events()).map((e) => `${e.kind}:${label(e.outputId)}`).join() === "START:A", s1.message);

    c.head("4b · The page, as Kim, AFTER Start: the whole brief");
    const started = await view(birch.id, { output: vA.id });
    c.ok("the brief opens: no summary page, the job bar and the instructions are there", !named(started, "EditorStartGate").length && find(started, (e) => e.props?.["data-brief-section"] === "header").length === 1 && dump(started).includes("koi pond"));

    const v1A = await send(vA, 1, edt(10, 26, 13));
    const i2 = await item();
    const p2 = await prisma.project.findUniqueOrThrow({ where: { id: birch.id }, select: { status: true } });
    const card2 = await prisma.smartTask.findFirstOrThrow({ where: { projectId: birch.id, taskType: "edit_video" }, select: { status: true } });
    c.ok("sending video 1 stops its clock: closed as SUBMITTED, a SUBMIT event at the send", i2?.state === "CLOSED" && i2.closeReason === "SUBMITTED" && (await events()).map((e) => `${e.kind}:${label(e.outputId)}`).join() === "START:A,SUBMIT:A", (await events()).map((e) => e.kind).join());
    c.ok("…and the job stays open: still in editing, the edit card still open", p2.status !== "DELIVERED" && p2.status !== "CANCELLED" && ["OPEN", "IN_PROGRESS"].includes(card2.status), `${p2.status} / ${card2.status}`);
    const back = await view(birch.id);
    c.ok("…so the brief closes again until the next Start (the summary, video 1 in review)", !!named(back, "EditorStartGate")[0] && (named(back, "EditorStartGate")[0].props.summary as { videos: { state: string }[] }).videos[0].state === "Version 1 in review" && named(back, "EditorStartGate")[0].props.selectedOutputId === vB.id);
    const reviewSrc = read("src/app/review/actions.ts");
    c.ok("the real hand-in passes that video to the close (submitCutForReview: forOutputId from the version sent)", /const sentVideo = await prisma\.reviewSubmission\.findUnique\(\{ where: \{ id: submission\.id \}[\s\S]{0,400}forOutputId: sentVideo\?\.outputId \?\? null/.test(reviewSrc));

    // =====================================================================
    c.head("2 · Per video");
    // =====================================================================
    setClock(edt(10, 26, 14));
    await work.startEditing({ projectId: birch.id, outputId: vB.id, requestId: "drill-start-2" });
    setClock(edt(10, 26, 15));
    // A late version of video 1 (an office re-send) while Kim works on video 2.
    await prisma.reviewSubmission.update({ where: { id: v1A }, data: { status: "CHANGES_REQUESTED", decidedAt: edt(10, 26, 14, 30), decidedBy: "Kyle Smith" } });
    const extra = await prisma.reviewSubmission.create({ data: { projectId: birch.id, deliverableId: vA.deliverableId, outputId: vA.id, slot: vA.slot, round: 2, status: "PENDING", kind: "video", source: "upload", fileName: "birch-1-v2-office.mp4", submittedByKey: "kyle", createdAt: edt(10, 26, 15) }, select: { id: true } });
    await work.closeActiveWork(birch.id, { editorKey: "kim", reason: "SUBMITTED", actor: { userId: null, name: "Kyle Smith", role: "ADMIN" }, detail: "cut sent to review by Kyle", forOutputId: vA.id });
    const i3 = await item();
    c.ok("video 1 sent while Kim is on video 2: video 2's clock keeps running", i3?.state === "ACTIVE" && i3.outputId === vB.id, `${i3?.state} ${label(i3?.outputId ?? null)}`);
    await prisma.reviewSubmission.delete({ where: { id: extra.id } });
    setClock(edt(10, 26, 16));
    const sw = await work.startEditing({ projectId: birch.id, outputId: vA.id, requestId: "drill-start-3" });
    const evs3 = (await events()).slice(-2);
    const i4 = await item();
    c.ok("another video on the same job: video 2's stretch stops (AUTO_PAUSE) and video 1's starts (START), same moment", sw.ok && evs3.map((e) => `${e.kind}:${label(e.outputId)}`).join() === "AUTO_PAUSE:B,START:A" && evs3[0].at.getTime() === evs3[1].at.getTime() && i4?.outputId === vA.id && near(i4.activeSince, edt(10, 26, 16)), evs3.map((e) => `${e.kind}:${label(e.outputId)}`).join());
    const eventsBefore = (await events()).length;
    const again = await work.startEditing({ projectId: birch.id, outputId: vA.id, requestId: "drill-start-4" });
    c.ok("…pressing it again on the same video records nothing", again.ok && (await events()).length === eventsBefore && /already on/.test(again.message), again.message);
    c.ok("…and the office heard \"started\" once for the job, not again per video", bellsAfterFirst > 0 && (await startedBells()) === bellsAfterFirst, `${bellsAfterFirst} then ${await startedBells()}`);

    // =====================================================================
    c.head("3 · The revision: Start again, stopped by version 2");
    // =====================================================================
    const v2A = await send(vA, 2, edt(10, 26, 18));
    const i5 = await item();
    c.ok("version 2 of video 1 stops the revision's clock", i5?.state === "CLOSED" && i5.closeReason === "SUBMITTED");
    setClock(edt(10, 27, 9));
    await work.startEditing({ projectId: birch.id, outputId: vB.id, requestId: "drill-start-5" });
    const v1B = await send(vB, 1, edt(10, 27, 11));
    const kinds = (await events()).map((e) => `${e.kind}:${label(e.outputId)}`).join();
    c.ok("the whole log, per video", kinds === "START:A,SUBMIT:A,START:B,AUTO_PAUSE:B,START:A,SUBMIT:A,START:B,SUBMIT:B", kinds);
    void v2A; void v1B;

    // =====================================================================
    c.head("5 · The Editing Room's folder links and the assistant wait for Start too");
    // =====================================================================
    const kimUser = { role: "EDITOR", editorKey: "kim" };
    const openNow = await gate.briefOpenJobs([birch.id], kimUser);
    c.ok("no open Start on the job: its folder links are off Kim's queue row", !openNow.has(birch.id));
    const roomSrc = read("src/app/editing/page.tsx");
    c.ok("…the Editing Room strips Raw and Final from an editor's rows without an open Start", /briefOpenJobs\(mineAll\.map/.test(roomSrc) && /\{ \.\.\.r, rawUrl: null, finalUrl: null \}/.test(roomSrc) && /const myNotDone = gated\(mine\(notDone\)\)/.test(roomSrc));
    c.ok("everyone else's rows are untouched", (await gate.briefOpenJobs([birch.id], { role: "OWNER", editorKey: null })).has(birch.id));
    const { execHubTool } = await import("@/lib/hubTools");
    const asKim = (await execHubTool("get_project_detail", { id: birch.id }, { role: "CREATIVE", office: false, appRole: "EDITOR", editorKey: "kim" })) as Record<string, unknown>;
    c.ok("the assistant, asked by Kim before Start: no messages or tasks, and it says Start opens them", Array.isArray(asKim.recent_messages) && (asKim.recent_messages as unknown[]).length === 0 && (asKim.open_tasks as unknown[]).length === 0 && /press Start/.test(String(asKim.details_behind_start)), JSON.stringify(asKim).slice(0, 200));
    const asOwner = (await execHubTool("get_project_detail", { id: birch.id }, { role: "OWNER", office: true, appRole: "OWNER" })) as Record<string, unknown>;
    c.ok("…asked by Jordan: the messages are there", (asOwner.recent_messages as { text: string }[]).some((m) => m.text.includes("drone shot")) && !asOwner.details_behind_start);
    c.ok("the brief PDF was never an editor's (requireShootAccess: owner, office, creative manager, the job's photographer)", /if \(u\.realRole === "OWNER" \|\| u\.realRole === "ADMIN" \|\| u\.realRole === "CREATIVE_MANAGER"\) return;/.test(read("src/lib/auth/guards.ts")) && /requireShootAccess\(id\)/.test(read("src/app/api/projects/[id]/editor-brief/route.ts")));

    // =====================================================================
    c.head("6 · The reminder");
    // =====================================================================
    // John's: handed over Oct 25, due Tue Oct 27 5 PM ET (the office's date).
    const lancaster = await mkJob("13 Lancaster Ave", { editor: "john", data: { dueOverrideAt: edt(10, 27, 17) } });
    // Kim's: handed over today, due next week: no reminder.
    const fresh = await mkJob("3 Four Winds Ln", { editor: "kim", data: { handoffReadyAt: edt(10, 27, 8), dueOverrideAt: edt(11, 4, 17) } });
    const startBells = () => prisma.notification.findMany({ where: { kind: "edit_start_reminder" }, select: { userKey: true, title: true, dedupeKey: true } });
    const dmsTo = (id: string) => slack.filter((m) => m.channel === id);
    setClock(edt(10, 27, 11));
    const jobs = await rem.startReminderJobs();
    const lj = jobs.find((j) => j.projectId === lancaster.id);
    const fj = jobs.find((j) => j.projectId === fresh.id);
    c.ok("John's job is on his desk, unstarted, due within 48 h; Kim's new one is on hers but not due", !!lj && !lj.working && lj.startable && rem.startReminderReason(lj, new Date()) === "due_soon" && !!fj && rem.startReminderReason(fj, new Date()) === null, JSON.stringify({ lj, fj }));
    const run1 = await rem.sweepStartReminders();
    const b1 = await startBells();
    const johns = async () => (await startBells()).filter((b) => (b.dedupeKey ?? "").includes(`:${lancaster.id}:`));
    const lj1 = await johns();
    c.ok("Tuesday 11 AM ET: ONE reminder to John about 13 Lancaster Ave (bell and Slack, with the link)", lj1.length === 1 && lj1[0].userKey === "editor:john" && /Press Start: 13 Lancaster Ave/.test(lj1[0].title) && dmsTo(S.john).length === 1 && /Press Start on 13 Lancaster Ave when you begin\./.test(dmsTo(S.john)[0].text) && /\/edit\//.test(dmsTo(S.john)[0].text), JSON.stringify({ run1, b1, dm: dmsTo(S.john)[0]?.text }));
    c.ok("…none for Kim's job handed over this morning, none to the office", !b1.some((b) => (b.dedupeKey ?? "").includes(`:${fresh.id}:`)) && b1.every((b) => (b.userKey ?? "").startsWith("editor:")), JSON.stringify(b1));
    setClock(edt(10, 27, 15));
    const run2 = await rem.sweepStartReminders();
    c.ok("the same day again: nothing new (once per job per day)", run2.sent === 0 && (await johns()).length === 1 && dmsTo(S.john).length === 1, JSON.stringify(run2));
    setClock(edt(10, 27, 22));
    const run3 = await rem.sweepStartReminders();
    c.ok("10 PM ET: outside the hours, nothing read or sent", !run3.window && run3.jobs === 0 && (await johns()).length === 1 && dmsTo(S.john).length === 1);
    setClock(edt(10, 28, 3));
    await rem.sweepStartReminders();
    c.ok("3 AM ET: nothing", (await johns()).length === 1 && dmsTo(S.john).length === 1);
    setClock(edt(10, 28, 9, 30));
    await rem.sweepStartReminders();
    c.ok("Wednesday 9:30 AM ET, still not started and now late: the second day's one reminder", (await johns()).length === 2 && dmsTo(S.john).length === 2 && /It is late/.test(dmsTo(S.john)[1].text), dmsTo(S.john)[1]?.text);
    await establishSession(johnLogin.id);
    setClock(edt(10, 28, 10));
    const js = await work.startEditing({ projectId: lancaster.id, outputId: lancaster.outs[0].id, requestId: "drill-john-1" });
    setClock(edt(10, 29, 10));
    const run5 = await rem.sweepStartReminders();
    c.ok("once John presses Start: no more reminders", js.ok && (await johns()).length === 2 && dmsTo(S.john).length === 2, JSON.stringify(run5));
    c.ok("the step runs hourly in the reconcile cron, first and capped", /step\("startReminders", async \(\) => \{\s*const \{ sweepStartReminders \} = await import\("@\/lib\/editStartReminders"\);\s*return sweepStartReminders\(\);\s*\}, \{ maxMs: 20_000 \}\);\s*await step\("ordersSlice"/.test(read("src/app/api/cron/reconcile/route.ts")));
    c.ok("it rides the editor's Job pings switch, like the revision reminder", /edit_start_reminder: "job_ping"/.test(read("src/lib/notifyPrefs.ts")) && /edit_start_reminder: "all"/.test(read("src/lib/notify.ts")));

    // =====================================================================
    c.head("7 · The numbers");
    // =====================================================================
    // A video Kim sent with no Start on it at all.
    const nostart = await mkJob("8 Quiet Ct", { editor: "kim" });
    setClock(edt(10, 29, 12));
    await prisma.reviewSubmission.create({ data: { projectId: nostart.id, deliverableId: nostart.outs[0].deliverableId, outputId: nostart.outs[0].id, slot: 1, round: 1, status: "PENDING", kind: "video", source: "upload", fileName: "quiet-v1.mp4", submittedByKey: "kim", createdAt: edt(10, 29, 12) } });
    const rep = await speed.editorSpeedReport({ days: 7, now: new Date() });
    const kim = rep.rows.find((r) => r.editorKey === "kim");
    const listed = (id: string) => kim?.list.find((x) => x.outputId === id);
    c.ok("Kim, last 7 days: 3 first versions (video 1, video 2, 8 Quiet Ct)", kim?.overall.videos === 3 && kim.list.length === 3, JSON.stringify(kim?.overall));
    c.ok("video 1: Start 10 AM to sent 1 PM, on the clock 3 h; fixing from Kyle's send-back at 2:30 PM to version 2 at 6 PM = 3.5 h", near(listed(vA.id)?.startedAt, edt(10, 26, 10)) && listed(vA.id)?.workHours === 3 && JSON.stringify(listed(vA.id)?.fixHours) === "[3.5]", JSON.stringify(listed(vA.id)));
    c.ok("video 2: first Start Mon 2 PM; on the clock 2 h Monday + 2 h Tuesday = 4 h; Start to sent 21 h", near(listed(vB.id)?.startedAt, edt(10, 26, 14)) && listed(vB.id)?.workHours === 4 && !listed(vB.id)?.leftRunning, JSON.stringify(listed(vB.id)));
    c.ok("8 Quiet Ct: sent with no Start, counted as such, never given a start", listed(nostart.outs[0].id)?.startedAt === null && listed(nostart.outs[0].id)?.workHours === null && kim?.overall.startUnknown === 1);
    c.ok("averages: Start to sent (3 + 21) / 2 = 12 h; on the clock (3 + 4) / 2 = 3.5 h; fixing 3.5 h", kim?.overall.startToFirstCut.hours === 12 && kim.overall.onClock.hours === 3.5 && kim.overall.onClock.n === 2 && kim.overall.fixTime.hours === 3.5, JSON.stringify(kim?.overall));
    // Thu Oct 29: the last 7 Eastern dates are Fri 23 .. Thu 29, five weekdays.
    c.ok("videos a day: 3 over 5 weekdays = 0.6; 1 on each of the 3 days she sent one", kim?.pace.weekdays === 5 && kim.pace.perWeekday === 0.6 && kim.pace.activeDays === 3 && kim.pace.perActiveDay === 1, JSON.stringify(kim?.pace));
    const panelSrc = read("src/components/editing/EditorSpeedPanel.tsx");
    c.ok("the panel: Videos a day, Start to sent, On the clock, Fixing, the gaps line, Each video", /Videos a day:/.test(panelSrc) && /Start to sent<\/th>/.test(panelSrc) && /On the clock<\/th>/.test(panelSrc) && /Fixing<\/th>/.test(panelSrc) && /data-speed-gaps/.test(panelSrc) && /Each video \(/.test(panelSrc));
    c.ok("…still the owner and the creative manager only", /const seesSpeed = !me \|\| me\.role === "OWNER" \|\| me\.role === "CREATIVE_MANAGER";/.test(roomSrc));
    const how = (await import("@/lib/editorDesk")).HOW_START_WORKS.join(" ");
    c.ok("the Start explainer no longer says \"not a timer\": the brief opens on Start, the send stops the clock, not used for pay", !/not a timer/.test(how) && /The full brief opens when you press it/.test(how) && /Sending a video for review stops its clock/.test(how) && /not used for pay/.test(how), how);

    c.ok("no text and no client message anywhere; nothing left the machine but faked Slack", fence.blocked.length === 0 && (await prisma.pendingSms.count().catch(() => 0)) === 0, `blocked ${fence.blocked.length}`);
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  c.summary();
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
