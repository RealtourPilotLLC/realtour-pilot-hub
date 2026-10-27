// ---------------------------------------------------------------------------
// DRILL: program videos watched against milestones, the late-cause record,
// and "expected by" on the client's portal (Oct 15 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct15-program-watch.ts
//
// Marcee McMullen told Jordan quality and turnaround slipped and she had to
// keep asking for updates. The promise watch left every program video out and
// the at-risk list only woke up a day before a promise.
//
//   1. The milestones (pure): a 10 business day window lands on day 1, 3, 5,
//      8 and the promise; met by any later fact; statuses; the suggested
//      cause; the client's words (no dashes, no internal words).
//   2. The sweep, through the promise watch, on a real fortnight (Mon Oct 5
//      to Mon Oct 19 2026, EDT): a missed milestone tells Kyle ONCE (bell +
//      Slack) with a drafted client update naming only the promise; twin
//      sweeps send once; each new miss is told; past the promise is told.
//   3. Not pinged: a backlog miss older than 48h, a TEST client, a future
//      shoot, a job on hold; the switch, and the Delivery watch switch.
//   4. The tracker list, the at-risk list and the exceptions board.
//   5. The late cause: refused when not on the list, saved, shown, cleared.
//   6. The drafts close themselves once the videos reach the portal.
//   7. The portal: off by default; stage + "expected by"; a moved date with
//      its reason; behind with no date; "making your changes".
//   8. The fence held and no client was sent anything.
//
// ISOLATION: PGlite via the shared harness; Slack answered in-process.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7161);

// ---- the clock (pinned, moved by hand) --------------------------------------
const RealDate = Date;
const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
function et(y: number, mo: number, d: number, h: number, mi = 0): Date {
  for (const off of [4, 5]) {
    const t = new RealDate(RealDate.UTC(y, mo - 1, d, h + off, mi));
    const p = Object.fromEntries(ET_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
    if (+p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi) return t;
  }
  throw new Error(`no such ET wall time ${y}-${mo}-${d} ${h}:${mi}`);
}
let offset = et(2026, 10, 5, 8).getTime() - RealDate.now();
const setNow = (d: Date) => { offset = d.getTime() - RealDate.now(); return d; };
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
const OCT = (d: number, h: number, mi = 0) => et(2026, 10, d, h, mi);
const SEP = (d: number, h: number, mi = 0) => et(2026, 9, d, h, mi);

installNextStubs();

// ---- Slack, answered in-process -------------------------------------------
type SlackPost = { channel: string; text: string };
const slack: SlackPost[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") { slack.push({ channel: body.channel ?? "?", text: body.text ?? "" }); return json({ ok: true, ts: String(slack.length) }); }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  return json({ ok: false, error: `drill: ${method}` });
});
const KYLE_SLACK = "U0KYLE0001";
const DASH = /[–—]/;
const JARGON = /\b(QC|Aryeo|Dropbox|Topaz|Review Room|milestone|output|deliverable|slot)\b/i;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const core = await import("@/lib/programWatchCore");
  const pw = await import("@/lib/programWatch");
  const promiseWatch = await import("@/lib/promiseWatch");
  const at = await import("@/lib/atRiskUpdates");
  const op = await import("@/lib/integrations/openphone");
  const texts: string[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_f: string, to: string, body: string) => { texts.push(`${to}: ${body}`); return { data: { id: `op-${texts.length}` } }; };
  await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));
  const dms = (re?: RegExp) => slack.filter((s) => s.channel === KYLE_SLACK && (!re || re.test(s.text)));

  // =========================================================================
  c.head("1 · The milestones, pure");
  // =========================================================================
  const promise = OCT(19, 17);
  const ms = core.programMilestones(promise, { anchorAt: OCT(5, 14) });
  const by = (k: string) => ms.find((m) => m.key === k)!.by.getTime();
  c.ok("10 business days: footage Tue Oct 6, editing Thu Oct 8, first cut Mon Oct 12, final Thu Oct 15 (5 PM ET), delivered at the promise",
    by("FOOTAGE") === OCT(6, 17).getTime() && by("EDIT_START") === OCT(8, 17).getTime() && by("IN_REVIEW") === OCT(12, 17).getTime() && by("FINAL") === OCT(15, 17).getTime() && by("DELIVERED") === promise.getTime(),
    ms.map((m) => `${m.key}:${m.by.toISOString()}`).join(" "));
  const unanchored = core.programMilestones(promise);
  c.ok("no shoot on file: the program's 10 days are assumed", unanchored.find((m) => m.key === "IN_REVIEW")!.by.getTime() === OCT(12, 17).getTime());
  const short = core.programMilestones(OCT(9, 17), { anchorAt: OCT(5, 14) });
  c.ok("a 4-day window keeps the order and never falls before the shoot", short.every((m, i) => i === 0 || m.by >= short[i - 1].by) && short[0].by >= OCT(5, 14));
  const f0 = { footageAt: OCT(5, 20), editStartedAt: null, inReviewAt: OCT(9, 10), finalAt: null, deliveredAt: null };
  c.ok("a cut in review proves the footage and the edit start", !!core.metAt("EDIT_START", f0) && core.metAt("EDIT_START", f0)!.getTime() === OCT(9, 10).getTime());
  c.ok("…and the edit start was met LATE (Oct 9 after Oct 8): it is the slip", core.evaluateVideo(ms, f0, OCT(10, 9)).slipped?.key === "EDIT_START");
  c.ok("on track before anything is due", core.evaluateVideo(ms, { ...f0, inReviewAt: null }, OCT(7, 9)).status === "ON_TRACK");
  c.ok("at risk the moment a milestone passes unmet, days before the promise", core.evaluateVideo(ms, { ...f0, inReviewAt: null }, OCT(8, 17, 30)).status === "AT_RISK");
  c.ok("late once the promise passes undelivered", core.evaluateVideo(ms, f0, OCT(19, 17, 30)).status === "LATE");
  c.ok("done, and late, when delivered after the promise", (() => { const e = core.evaluateVideo(ms, { ...f0, finalAt: OCT(15, 9), deliveredAt: OCT(20, 9) }, OCT(21, 9)); return e.status === "DONE" && e.deliveredLate; })());
  const sugg = (o: Partial<Parameters<typeof core.suggestMissCause>[0]>) => core.suggestMissCause({ slipped: "EDIT_START", facts: f0, milestones: ms, briefReady: true, editorAssigned: true, internalRounds: 0, waitingOnVerdictHours: null, approvedUnreleasedHours: null, clientWaiting: false, ...o }).cause;
  c.ok("suggested causes follow the evidence",
    sugg({ facts: { ...f0, footageAt: OCT(8, 9) } }) === "MISSING_ASSETS" && sugg({ briefReady: false }) === "INCOMPLETE_BRIEF" && sugg({ editorAssigned: false }) === "SLOW_HANDOFF" &&
    sugg({}) === "EDIT_CAPACITY" && sugg({ slipped: "FINAL", internalRounds: 3 }) === "REVISION_CYCLES" && sugg({ slipped: "FINAL", waitingOnVerdictHours: 30 }) === "REVIEW_BOTTLENECK" &&
    sugg({ slipped: "DELIVERED", approvedUnreleasedHours: 40 }) === "REVIEW_BOTTLENECK" && sugg({ slipped: "FINAL", clientWaiting: true }) === "CLIENT_APPROVAL");
  const words = [
    core.clientExpected({ stage: "EDITING", promisedAt: promise, originalAt: null, cause: null, now: OCT(12, 9) }),
    core.clientExpected({ stage: "EDITING", promisedAt: OCT(21, 17), originalAt: promise, cause: "EDIT_CAPACITY", now: OCT(12, 9) }),
    core.clientExpected({ stage: "IN_REVIEW", promisedAt: promise, originalAt: null, cause: null, now: OCT(20, 9) }),
  ];
  c.ok("client words: \"Being edited\" / \"Expected by Mon, Oct 19\"", words[0]?.stage === "Being edited" && words[0]?.line === "Expected by Mon, Oct 19", JSON.stringify(words[0]));
  c.ok("…moved: the new date, the old one, and the cause in plain words", words[1]?.line === "Now expected by Wed, Oct 21" && words[1]?.movedFrom === "Mon, Oct 19" && words[1]?.reason === core.MISS_CAUSE_WORDS.EDIT_CAPACITY.client, JSON.stringify(words[1]));
  c.ok("…behind with no new date: promises nothing", !!words[2]?.late && /We'll confirm the new date with you/.test(words[2]!.line) && !/Oct|Mon|Tue/.test(words[2]!.line), JSON.stringify(words[2]));
  const allClient = [...Object.values(core.MISS_CAUSE_WORDS).map((w) => w.client), ...Object.values(core.STAGE_CLIENT_WORDS), core.GENERIC_MOVE_REASON, ...words.flatMap((w) => [w?.line ?? "", w?.reason ?? ""])].join(" | ");
  c.ok("…no em or en dashes and no internal words anywhere a client reads", !DASH.test(allClient) && !JARGON.test(allClient), allClient.match(JARGON)?.[0] ?? "");

  // =========================================================================
  c.head("2 · The sweep, through the promise watch");
  // =========================================================================
  type TeamRole = "ADMIN" | "MANAGER" | "PHOTOGRAPHER" | "EDITOR";
  const member = (name: string, email: string, role: TeamRole, slackId: string | null) => prisma.teamMember.create({ data: { name, email, role, slackId, active: true }, select: { id: true } });
  const jordan = await member("Jordan Spackman", "info@realtourpilot.com", "PHOTOGRAPHER", "U0JORDAN01");
  const kyle = await member("Kyle Smith", "hello@realtourpilot.com", "MANAGER", KYLE_SLACK);
  await prisma.appUser.create({ data: { email: "info@realtourpilot.com", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id } });
  const uKyle = await prisma.appUser.create({ data: { email: "hello@realtourpilot.com", role: "ADMIN", status: "ACTIVE", teamMemberId: kyle.id }, select: { id: true } });
  await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: uKyle.id, teamMemberId: kyle.id, label: "Kyle Smith", setBy: "drill" } });

  // A program client as production holds one: enrollment, month, the month's
  // job (contentMonthId) with its four owed videos.
  const programJob = async (name: string, monthKey: string, job: { shootDate: Date; promisedDueAt: Date; status?: "EDITING" | "ON_HOLD" | "DELIVERED" | "SCHEDULED"; qty?: number; uploadedAt?: Date | null }) => {
    const client = await prisma.client.create({ data: { name, phone: `(610) 555-${String(1000 + slack.length + Math.floor(Math.random() * 8000)).slice(0, 4)}`, socialClient: true }, select: { id: true } });
    const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: job.qty ?? 4, sessionsPerMonth: 1, sessionHours: 2, startedAt: SEP(1, 9) }, select: { id: true } });
    const month = await prisma.contentMonth.create({ data: { enrollmentId: enrollment.id, clientId: client.id, monthKey, videosOwed: job.qty ?? 4 }, select: { id: true } });
    const p = await prisma.project.create({
      data: {
        clientId: client.id, title: `${name} ${monthKey} content`, status: job.status ?? "EDITING", contentMonthId: month.id, packageName: "Video Accelerator",
        shootDate: job.shootDate, promisedDueAt: job.promisedDueAt, deliveryDue: job.promisedDueAt, uploadedAt: job.uploadedAt === undefined ? new RealDate(job.shootDate.getTime() + 6 * 3_600_000) : job.uploadedAt,
      },
      select: { id: true },
    });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", quantity: job.qty ?? 4 }, select: { id: true } });
    const outs: string[] = [];
    for (let i = 1; i <= (job.qty ?? 4); i++) {
      outs.push((await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: p.id, slot: i, category: "VIDEO", title: `Tip #${i}` }, select: { id: true } })).id);
    }
    return { clientId: client.id, enrollmentId: enrollment.id, monthId: month.id, projectId: p.id, deliverableId: d.id, outs };
  };
  const cut = (j: { projectId: string; deliverableId: string }, slot: number, o: { createdAt: Date; status?: string; decidedAt?: Date | null; clientReleasedAt?: Date | null; clientRequestedAt?: Date | null; round?: number }) =>
    prisma.reviewSubmission.create({ data: { projectId: j.projectId, deliverableId: j.deliverableId, slot, round: o.round ?? 1, kind: "video", status: o.status ?? "PENDING", fileName: `tip-${slot}.mp4`, createdAt: o.createdAt, decidedAt: o.decidedAt ?? null, clientReleasedAt: o.clientReleasedAt ?? null, clientRequestedAt: o.clientRequestedAt ?? null }, select: { id: true } });
  const started = (projectId: string, outputId: string, key: string, atT: Date) =>
    prisma.editorWorkItem.create({ data: { editorKey: key, projectId, outputId, state: "PAUSED", firstStartedAt: atT, lastEventAt: atT } });

  const dana = await programJob("Dana Rivers", "2026-10", { shootDate: OCT(5, 14), promisedDueAt: OCT(19, 17) });
  const [o1, o2, o3, o4] = dana.outs;
  await prisma.deliverableOutput.update({ where: { id: o1 }, data: { ownerKey: "kim", topicId: "topic-1" } });
  await prisma.deliverableOutput.update({ where: { id: o2 }, data: { ownerKey: "kim", topicId: "topic-2" } });
  await prisma.deliverableOutput.update({ where: { id: o3 }, data: { topicId: "topic-3" } }); // nobody has it
  await prisma.deliverableOutput.update({ where: { id: o4 }, data: { ownerKey: "john", topicId: "topic-4" } });
  await started(dana.projectId, o1, "john", OCT(6, 10)); // one work row per editor per job
  await started(dana.projectId, o2, "kim", OCT(7, 9));
  const r1 = await cut(dana, 1, { createdAt: OCT(8, 11) });
  const r4 = await cut(dana, 4, { createdAt: OCT(8, 15) });

  await promiseWatch.sweepPromiseWatch(setNow(OCT(8, 12)));
  c.ok("Thu Oct 8 noon: every video is on schedule, nothing is said", dms().length === 0);

  const t2 = await promiseWatch.sweepPromiseWatch(setNow(OCT(8, 17, 30)));
  await Promise.all([promiseWatch.sweepPromiseWatch(OCT(8, 17, 31)), promiseWatch.sweepPromiseWatch(OCT(8, 17, 31))]);
  const dm1 = dms(/Dana Rivers/);
  c.ok("Thu 5:30 PM: \"Tip #3\" missed \"editing started\", Kyle is told ONCE (twin sweeps included)", dm1.length === 1 && /Tip #3/.test(dm1[0].text) && !/Tip #2/.test(dm1[0].text), dm1.map((d) => d.text).join(" || "));
  console.log(`\n--- the DM ---\n${dm1[0]?.text}\n---`);
  c.ok("…saying what should have happened by when, where it is now, and the likely cause", /editing should have started by Thu, Oct 8, 5:00 PM ET/.test(dm1[0]?.text ?? "") && /footage in, editing not started/.test(dm1[0]?.text ?? "") && /Likely cause: Slow handoff to the editor/.test(dm1[0]?.text ?? ""));
  c.ok("…with the promise and the tracker link, and no dashes", /Promise Mon, Oct 19, 5:00 PM ET/.test(dm1[0]?.text ?? "") && /\/pipeline#program-watch/.test(dm1[0]?.text ?? "") && !DASH.test(dm1[0]?.text ?? ""));
  c.ok("the promise watch reports it", !!t2.program && "alerted" in t2.program && t2.program.alerted === 1, JSON.stringify(t2.program));
  const bell = await prisma.notification.findMany({ where: { kind: "promise_watch", userKey: `tm:${kyle.id}` } });
  c.ok("…and Kyle's bell has one row", bell.length === 1, String(bell.length));
  const drafts = () => prisma.smartTask.findMany({ where: { taskType: "at_risk_update", projectId: dana.projectId } });
  let d1 = await drafts();
  c.ok("a client update is DRAFTED on Kyle's list (not sent), about the month's videos", d1.length === 1 && d1[0].status === "OPEN" && d1[0].assignedKey === "kyle" && d1[0].reasonCreated === pw.PROGRAM_WATCH_REASON && /your October videos: your video "Tip #3" is running behind the time we promised \(Mon, Oct 19, 5:00 PM ET\)/.test(d1[0].description ?? ""), d1[0]?.description ?? "none");
  c.ok("…naming no date but the recorded promise", at.foreignDates(d1[0]?.description ?? "", [promise]) === null);

  // Tip #1 passes and goes to the portal; Tip #4 is approved but not released.
  await prisma.reviewSubmission.update({ where: { id: r1.id }, data: { status: "APPROVED", decidedAt: OCT(9, 10), clientReleasedAt: OCT(9, 12) } });
  await prisma.reviewSubmission.update({ where: { id: r4.id }, data: { status: "APPROVED", decidedAt: OCT(14, 9) } });

  await promiseWatch.sweepPromiseWatch(setNow(OCT(12, 17, 30)));
  const dm2 = dms(/Dana Rivers/);
  c.ok("Mon Oct 12 5:30 PM: \"Tip #2\" missed its first cut, told once; \"Tip #3\" is not told again", dm2.length === 2 && /Tip #2/.test(dm2[1].text) && !/Tip #3/.test(dm2[1].text), dm2[1]?.text);
  c.ok("…the first cut line and the editing-capacity guess", /the first cut should have been in review by Mon, Oct 12, 5:00 PM ET/.test(dm2[1]?.text ?? "") && /Likely cause: Editing capacity/.test(dm2[1]?.text ?? ""));
  d1 = await drafts();
  c.ok("…the month's draft is not written twice", d1.length === 1);

  // =========================================================================
  c.head("3 · What is listed but never pinged");
  // =========================================================================
  // A backlog: past its promise for a week when the watch first sees it.
  const rosa = await programJob("Rosa Lee", "2026-09", { shootDate: SEP(22, 10), promisedDueAt: OCT(6, 17), qty: 1 });
  // On hold, a future shoot, a TEST client.
  const held = await programJob("Hal Moss", "2026-10", { shootDate: OCT(1, 10), promisedDueAt: OCT(15, 17), status: "ON_HOLD", qty: 1 });
  const future = await programJob("Fay Holt", "2026-11", { shootDate: OCT(30, 10), promisedDueAt: et(2026, 11, 13, 17), status: "SCHEDULED", qty: 1, uploadedAt: null });
  const { buildContentMonth } = await import("./_fixtures/contentMonth");
  const tf = await buildContentMonth(prisma as never, { name: "Watch Fixture TEST", package: "Starter", monthKey: "2026-10", project: { shootDate: OCT(6, 10), status: "EDITING" } });
  await prisma.project.update({ where: { id: tf.projectId! }, data: { promisedDueAt: OCT(20, 17), deliveryDue: OCT(20, 17), uploadedAt: OCT(6, 16) } });
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  await ensureOutputsForProject(tf.projectId!);
  await promiseWatch.sweepPromiseWatch(setNow(OCT(12, 17, 45)));
  c.ok("a week-old miss on first sight: listed, not pinged", dms(/Rosa Lee/).length === 0);
  c.ok("a TEST client: never pinged", dms(/Watch Fixture/).length === 0);
  c.ok("on hold and not filmed yet: not pinged", dms(/Hal Moss|Fay Holt/).length === 0);

  // =========================================================================
  c.head("4 · The tracker, the at-risk list, the exceptions board");
  // =========================================================================
  setNow(OCT(12, 18));
  const board = await pw.programWatchBoard({ now: OCT(12, 18) });
  const ids = new Set(board.rows.map((r) => r.outputId));
  c.ok("the tracker lists Tip #2 and Tip #3 (behind), Rosa's late video, the TEST client's", ids.has(o2) && ids.has(o3) && ids.has(rosa.outs[0]) && board.rows.some((r) => r.clientId === tf.clientId), board.rows.map((r) => `${r.clientName}:${r.title}:${r.level}`).join(" | "));
  c.ok("…not Tip #1 (on the portal), Tip #4 (in review on time), the job on hold, or the one not filmed", !ids.has(o1) && !ids.has(o4) && !ids.has(held.outs[0]) && !ids.has(future.outs[0]));
  c.ok("…late first", board.rows[0]?.level === "late");
  const noTest = await pw.programWatchBoard({ now: OCT(12, 18), includeTest: false });
  c.ok("…and test records hide behind the tracker's own toggle", !noTest.rows.some((r) => r.clientId === tf.clientId));
  const risk = await at.atRiskOutputs(OCT(12, 18));
  const r2 = risk.find((r) => r.outputId === o2);
  c.ok("the at-risk list (Tasks, Comms) carries program videos days before the promise, with why", !!r2 && /first cut should have been in review/.test(r2.why ?? "") && r2.owed === `the video "Tip #2"`, JSON.stringify(r2 && { owed: r2.owed, why: r2.why }));
  c.ok("…matched to the watch's one draft for the month", r2?.taskId === d1[0]?.id);
  const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
  const ex = await opsExceptionsBoard({ now: OCT(12, 18) });
  const exRows = ex.rows.filter((r) => r.kind === "at-risk-promise");
  c.ok("the exceptions board names the undrafted program videos (Rosa's, the TEST client's), not Dana's drafted ones", ex.totals["at-risk-promise"].all >= 2 && !exRows.some((r) => /Tip #2|Tip #3/.test(r.why) && /Dana/.test(r.why)), exRows.map((r) => r.why).join(" || "));

  // =========================================================================
  c.head("5 · Why it was late: a person's call");
  // =========================================================================
  const bad = await pw.recordMissCause({ outputId: o2, cause: "THE_DOG_ATE_IT", by: "Kyle" });
  c.ok("a cause that is not on the list is refused", !bad.ok);
  const good = await pw.recordMissCause({ outputId: o2, cause: "EDIT_CAPACITY", note: "Kim had three months due the same week", by: "Kyle Smith" });
  const rec = (await pw.readMissCauses([o2])).map.get(o2);
  c.ok("a listed cause is saved with the note, who and when", good.ok && rec?.cause === "EDIT_CAPACITY" && /three months/.test(rec?.note ?? "") && rec?.by === "Kyle Smith" && !!rec?.at, JSON.stringify(rec));
  c.ok("…on the job's timeline too", (await prisma.activity.count({ where: { projectId: dana.projectId, body: { contains: "recorded why \"Tip #2\" was late: Editing capacity" } } })) === 1);
  const b2 = await pw.programWatchBoard({ now: OCT(12, 18) });
  c.ok("…and the tracker shows it next to the hub's suggestion", b2.rows.find((r) => r.outputId === o2)?.recorded?.cause === "EDIT_CAPACITY" && b2.rows.find((r) => r.outputId === o3)?.suggestion?.cause === "SLOW_HANDOFF");
  await pw.recordMissCause({ outputId: o3, cause: "SLOW_HANDOFF", by: "Kyle Smith" });
  await pw.recordMissCause({ outputId: o3, cause: null, by: "Kyle Smith" });
  c.ok("clearing a cause clears it", !(await pw.readMissCauses([o3])).map.has(o3));

  // =========================================================================
  c.head("6 · Past the promise, then on the portal");
  // =========================================================================
  await promiseWatch.sweepPromiseWatch(setNow(OCT(19, 17, 30)));
  const dm3 = dms(/Dana Rivers/);
  c.ok("Mon Oct 19 5:30 PM: one message, three videos past the promise", dm3.length === 3 && /past its promise/.test(dm3[2].text) && /Tip #2/.test(dm3[2].text) && /Tip #3/.test(dm3[2].text) && /Tip #4/.test(dm3[2].text), dm3[2]?.text);
  c.ok("…Tip #4, approved five days ago and not on the portal, reads as our review holding it", /Tip #4[^\n]*Likely cause: Waiting on our review/.test(dm3[2]?.text ?? ""));
  // Leo: delivered late a fortnight ago; never pinged.
  // Oct 27 2026 (Jordan's Loom: "if they've been delivered, I don't really want them in here anymore"): off the list too.
  const leo = await programJob("Leo Park", "2026-09", { shootDate: SEP(17, 10), promisedDueAt: OCT(1, 17), qty: 1 });
  await cut(leo, 1, { createdAt: SEP(30, 9), status: "APPROVED", decidedAt: OCT(2, 9), clientReleasedAt: OCT(3, 10) });
  const b3 = await pw.programWatchBoard({ now: OCT(19, 18) });
  c.ok("a video that reached the portal (late or not) leaves the list by itself", !b3.rows.some((r) => r.outputId === leo.outs[0]) && b3.rows.every((r) => r.level !== "delivered-late"));
  await promiseWatch.sweepPromiseWatch(setNow(OCT(19, 18)));
  c.ok("…and is never pinged", dms(/Leo Park/).length === 0);
  // They all reach the portal: the month's draft closes itself.
  await cut(dana, 2, { createdAt: OCT(20, 9), status: "APPROVED", decidedAt: OCT(20, 10), clientReleasedAt: OCT(20, 11) });
  await cut(dana, 3, { createdAt: OCT(20, 9), status: "APPROVED", decidedAt: OCT(20, 10), clientReleasedAt: OCT(20, 11) });
  await prisma.reviewSubmission.update({ where: { id: r4.id }, data: { clientReleasedAt: OCT(20, 11) } });
  const t6 = await promiseWatch.sweepPromiseWatch(setNow(OCT(20, 12)));
  d1 = await drafts();
  c.ok("every video it named is on the portal: the draft is closed, saying nothing was sent", d1[0]?.status === "CANCELLED" && /Nothing was sent/.test(d1[0]?.summary ?? ""), `${d1[0]?.status} ${JSON.stringify(t6.program)}`);

  // =========================================================================
  c.head("7 · The switches");
  // =========================================================================
  await programJob("Sam Ortiz", "2026-10", { shootDate: OCT(12, 10), promisedDueAt: OCT(26, 17), qty: 1, uploadedAt: null });
  await pw.saveProgramWatchRules({ alerts: false }, "drill");
  await promiseWatch.sweepPromiseWatch(setNow(OCT(13, 17, 30)));
  c.ok("program alerts off: a fresh miss is not pinged", dms(/Sam Ortiz/).length === 0);
  await pw.saveProgramWatchRules({ alerts: true }, "drill");
  await putSetting("internal_alerts", { promiseWatch: { enabled: false } });
  const off = await promiseWatch.sweepPromiseWatch(setNow(OCT(13, 18)));
  c.ok("the Delivery watch switch off: the program half does not run either", dms(/Sam Ortiz/).length === 0 && !off.program && !!off.skipped);
  await putSetting("internal_alerts", {});
  await promiseWatch.sweepPromiseWatch(setNow(OCT(13, 18, 30)));
  c.ok("both on: told (no footage confirmed: missing files)", dms(/Sam Ortiz/).length === 1 && /Likely cause: Missing footage or files/.test(dms(/Sam Ortiz/)[0]?.text ?? ""), dms(/Sam Ortiz/)[0]?.text);
  c.ok("defaults: alerts and chase escalation ON (staff only); the portal date and the library re-point OFF", JSON.stringify(pw.DEFAULT_PROGRAM_WATCH) === JSON.stringify({ alerts: true, chaseEscalation: true, portalExpectedBy: false, libraryRepoint: false }));

  // =========================================================================
  c.head("8 · The client's portal");
  // =========================================================================
  const kim = await programJob("Kim Ellis", "2026-10", { shootDate: OCT(12, 10), promisedDueAt: OCT(26, 17), qty: 3 });
  const [k1, k2, k3] = kim.outs;
  await started(kim.projectId, k1, "kim", OCT(13, 9));
  const vid = (outputId: string, title: string, status: string) =>
    prisma.contentVideo.create({ data: { enrollmentId: kim.enrollmentId, clientId: kim.clientId, monthId: kim.monthId, monthKey: "2026-10", kind: "PROGRAM", title, status, outputId, projectId: kim.projectId, deliverableId: kim.deliverableId }, select: { id: true } });
  const v1 = await vid(k1, "Tip #1", "EDITING");
  const v2 = await vid(k2, "Tip #2", "FILMED");
  const v3 = await vid(k3, "Tip #3", "CLIENT_REVIEW");
  const list = [{ id: v1.id, outputId: k1, state: "IN_PRODUCTION" }, { id: v2.id, outputId: k2, state: "IN_PRODUCTION" }, { id: v3.id, outputId: k3, state: "CHANGES_IN_PROGRESS" }];
  setNow(OCT(14, 9));
  c.ok("switch off (the default): the portal shows no dates", (await pw.portalExpectedFor(list, { now: OCT(14, 9) })).size === 0);
  await pw.saveProgramWatchRules({ portalExpectedBy: true }, "drill");
  let pe = await pw.portalExpectedFor(list, { now: OCT(14, 9) });
  c.ok("switch on: \"Being edited. Expected by Mon, Oct 26\"", pe.get(v1.id)?.stage === "Being edited" && pe.get(v1.id)?.line === "Expected by Mon, Oct 26", JSON.stringify(pe.get(v1.id)));
  c.ok("…a filmed video not started: \"Filmed, editing is next\"", pe.get(v2.id)?.stage === "Filmed, editing is next");
  // The client asked for changes on Tip #3: the round's own date.
  const r3 = await cut(kim, 3, { createdAt: OCT(13, 9), status: "CHANGES_REQUESTED", decidedAt: OCT(13, 10), clientReleasedAt: OCT(13, 10), clientRequestedAt: OCT(13, 15) });
  await prisma.revisionBrief.create({ data: { projectId: kim.projectId, outputId: k3, source: "portal", originalText: "Shorter intro please", dueAt: OCT(15, 17), createdAt: OCT(13, 15, 5) } });
  void r3;
  pe = await pw.portalExpectedFor(list, { now: OCT(14, 9) });
  c.ok("…changes asked for: \"Making your changes. Expected by Thu, Oct 15\"", pe.get(v3.id)?.stage === "Making your changes" && pe.get(v3.id)?.line === "Expected by Thu, Oct 15", JSON.stringify(pe.get(v3.id)));
  // The office moves the month's date and records why.
  await prisma.project.update({ where: { id: kim.projectId }, data: { dueOverrideAt: OCT(28, 17) } });
  await pw.recordMissCause({ outputId: k1, cause: "EDIT_CAPACITY", by: "Kyle Smith" });
  pe = await pw.portalExpectedFor(list, { now: OCT(14, 9) });
  c.ok("a moved date: the new one, the old one, and the plain reason", pe.get(v1.id)?.line === "Now expected by Wed, Oct 28" && pe.get(v1.id)?.movedFrom === "Mon, Oct 26" && pe.get(v1.id)?.reason === "Our editing team needed a little more time than we planned.", JSON.stringify(pe.get(v1.id)));
  c.ok("…a moved date with no cause recorded still gives a plain reason", pe.get(v2.id)?.reason === core.GENERIC_MOVE_REASON);
  pe = await pw.portalExpectedFor(list, { now: OCT(29, 9) });
  c.ok("past the moved date: behind, no date promised", !!pe.get(v1.id)?.late && /We'll confirm the new date with you/.test(pe.get(v1.id)?.line ?? ""));
  const everything = [...pe.values()].map((e) => `${e.stage} ${e.line} ${e.reason ?? ""} ${e.movedFrom ?? ""}`).join(" | ");
  c.ok("…no dashes and no internal words in anything the client reads", !DASH.test(everything) && !JARGON.test(everything), everything);
  // The library itself carries the line (contentVideos.portalVideoList).
  setNow(OCT(14, 9));
  const { portalVideoList } = await import("@/lib/contentVideos");
  const page = await portalVideoList({ id: kim.enrollmentId, clientId: kim.clientId }, { page: 1, perPage: 24 }).catch((e: unknown) => { console.log("portalVideoList", e); return null; });
  const row1 = page?.rows.find((r) => r.id === v1.id);
  c.ok("the client's library rows carry it (Home and Library read these)", !!row1?.expected && /expected by Wed, Oct 28/i.test(row1.expected.line), JSON.stringify(row1?.expected ?? page?.rows.map((r) => [r.title, r.state])));

  // =========================================================================
  c.head("9 · The chase task's promise line names each video");
  // =========================================================================
  const line = await promiseWatch.promiseLineFor(kim.projectId, OCT(14, 9));
  c.ok("a program job's line lists its videos, their promise and where each stands", /Promise on file: "Tip #1": due Wed, Oct 28, 5:00 PM ET/.test(line) && /"Tip #2"/.test(line) && !DASH.test(line), line);

  // =========================================================================
  c.head("10 · The fence");
  // =========================================================================
  c.ok("no client was sent anything (no text, no email)", texts.length === 0);
  c.ok("nothing left the machine but in-process Slack", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
