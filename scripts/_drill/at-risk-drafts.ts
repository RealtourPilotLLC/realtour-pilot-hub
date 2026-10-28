// ---------------------------------------------------------------------------
// DRILL: PROMISE-BACKED AT-RISK UPDATE DRAFTS (AU-24 / F5) and the exception
// digest (§9), unified handoff batch 5, Sep 26 2026.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/at-risk-drafts.ts
//
// Isolated PGlite; the model is a fake inside the fence that records exactly
// what it was asked; every other URL is refused. The clock is pinned (Tue Oct
// 6 2026, 10:00 AM EDT).
//
//   1. OLD (17df024): nothing in the tree drafted a delay update, and the
//      exceptions board had no such kind.
//   2. What is listed: ONLY the one already past its promise. Not the video
//      20h from its pinned promise, nor the photo-only job 10h from its frozen
//      promise (Jordan, Oct 27 2026 Loom, 40:34: "They should only be at risk
//      if they're late, not if you think they're going to be late"), not one
//      3 days out, not a delivered, waived or dropped one. A draft is refused
//      before the promise; the same video, once its promise has passed, is
//      listed and drafts (sections 4-6 ask at that later moment).
//   3. No typed time → refused, the model never called. Both → refused.
//   4. "We'll confirm by" → the model gets the promise and that time and NO
//      other date; one task on Kyle's list, due within the hour (the promise
//      has passed);
//      nothing sent (no outbox row, no outbound comms row, no request but the
//      model's).
//   5. A second click (a confirmed new time) updates the same task.
//   6. Changing the turnaround defaults does not move the quoted promise.
//   7. A draft that names a date nobody typed is flagged on the task.
//   8. The exceptions board carries the undrafted LATE ones (Kyle, a link,
//      the real total); the drafted one leaves it, and one still ahead of its
//      promise is not there at all. Kyle's digest lines carry the rows with
//      his name and the unanswered counts.
//   9. ONE JOB, ONE UPDATE (Jordan, Oct 28 2026, John Collins's four late
//      October videos: "it could all be in one late promise message update").
//      Three late videos of one job are one group, one board row, one draft
//      naming all three, on ONE task keyed on the job; every video then shows
//      that task. A job with one late video reads exactly as before.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5785);
const BASE = "17df024"; // pinned: never HEAD
const REPO = path.resolve(__dirname, "../..");
const HOUR = 3_600_000;

const RealDate = Date;
const NOW = RealDate.UTC(2026, 9, 6, 14, 0); // Tue Oct 6 2026, 10:00 AM EDT
const offset = NOW - RealDate.now();
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

// ---- the fake model ---------------------------------------------------------------
const asked: string[] = [];
let reply = "Hi Erica, a quick update on the video for 812 Linden Ave: it's running a little behind. We'll confirm the exact delivery time by Wed, Oct 7 at 3:00 PM. Sorry for the change.";
const fence = fenceFetch((url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
    asked.push(body.messages?.[0]?.content ?? "");
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return null;
});
installNextStubs();

const ET_DT = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const at = await import("@/lib/atRiskUpdates");
  const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
  const { exceptionDigestLines } = await import("@/lib/commsBoard");
  const c = makeChecker();

  // =========================================================================
  c.head("1 · OLD (17df024)");
  // =========================================================================
  const grepOld = (pat: string) => {
    try { return execFileSync("git", ["grep", "-l", pat, BASE, "--", "src"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { return ""; }
  };
  c.ok("OLD: no code drafted a client delay update (no at_risk_update task type anywhere)", grepOld("at_risk_update") === "");
  c.ok("OLD: the exceptions board had no at-risk-promise kind", !execFileSync("git", ["show", `${BASE}:src/lib/opsExceptions.ts`], { cwd: REPO, encoding: "utf8" }).includes("at-risk-promise"));

  // ---- the jobs ------------------------------------------------------------------
  await saveSecret("ai", ["sk", "ant", "drill", "not", "real"].join("-"));
  const kyle = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", active: true, payPercent: 0.35, payFloor: 100 }, select: { id: true } });
  const erica = await prisma.client.create({ data: { name: "Erica Walker", email: "erica@clients.invalid", phone: "(610) 555-0144" }, select: { id: true } });
  const mkJob = (title: string, extra: Record<string, unknown> = {}) =>
    prisma.project.create({ data: { title, clientId: erica.id, status: "EDITING", addressLine: title.split(",")[0], ...extra }, select: { id: true } });
  const video = async (projectId: string, slot: number, o: Record<string, unknown>) => {
    const d = await prisma.deliverable.upsert({
      where: { id: `${projectId}-video` }, update: { quantity: slot },
      create: { id: `${projectId}-video`, projectId, type: "VIDEO", quantity: slot },
    });
    return prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId, slot, category: "VIDEO", ...o }, select: { id: true } });
  };
  const PROMISE_20H = new RealDate(NOW + 20 * HOUR); // Wed Oct 7, 6:00 AM
  const linden = await mkJob("812 Linden Ave, West Chester, PA 19380");
  const out20 = await video(linden.id, 1, { promisedAt: PROMISE_20H, promiseSource: "video_48h" });
  const farJob = await mkJob("31 Harrow Ct, Malvern, PA 19355");
  await video(farJob.id, 1, { promisedAt: new RealDate(NOW + 72 * HOUR) });
  const doneJob = await mkJob("1904 Foxfield Rd, Exton, PA 19341");
  await video(doneJob.id, 1, { promisedAt: new RealDate(NOW + 5 * HOUR), deliveredAt: new RealDate(NOW - HOUR) });
  await video(doneJob.id, 2, { promisedAt: new RealDate(NOW + 5 * HOUR), waivedAt: new RealDate(NOW - HOUR) });
  await video(doneJob.id, 3, { promisedAt: new RealDate(NOW + 5 * HOUR), removedFromOrderAt: new RealDate(NOW - HOUR) });
  const PHOTO_10H = new RealDate(NOW + 10 * HOUR);
  const photos = await mkJob("5 Quarry Ln, Media, PA 19063", { promisedDueAt: PHOTO_10H, promisedPinnedAt: new RealDate(NOW - 48 * HOUR), shootDate: new RealDate(NOW - 30 * HOUR) });
  const lateJob = await mkJob("60 Cedar Ave, Paoli, PA 19301");
  const outLate = await video(lateJob.id, 1, { promisedAt: new RealDate(NOW - 6 * HOUR), title: "His and hers" });

  // =========================================================================
  c.head("2 · What is late (Oct 27 2026: late only, never predicted)");
  // =========================================================================
  const rows = await at.atRiskOutputs(new RealDate(NOW));
  const keys = rows.map((r) => r.key).sort();
  c.ok("exactly one: the one past its promise", rows.length === 1 && keys.includes(outLate.id), rows.map((r) => `${r.street}:${r.hoursLeft}h`).join(" | "));
  c.ok("NOT the video 20h out, nor the photo-only job 10h out (due later, not late)", !keys.includes(out20.id) && !keys.includes(photos.id));
  c.ok("not the video 3 days out, nor the delivered, waived or dropped ones", !rows.some((r) => r.projectId === farJob.id || r.projectId === doneJob.id));
  const late = rows.find((r) => r.key === outLate.id);
  c.ok("the past one is marked overdue and named by its title", !!late?.overdue && /His and hers/.test(late.owed), `${late?.owed} ${late?.overdue}`);
  const early = await at.draftAtRiskUpdate({ projectId: linden.id, outputId: out20.id, actor: "Kyle", confirmBy: new RealDate(NOW + 29 * HOUR) });
  c.ok("a draft for the video 20h out is refused: its promise has not passed", !early.ok && /not late/.test(early.ok ? "" : early.message), early.ok ? "drafted" : early.message);
  const watchEarly = await at.autoDraftAtRiskUpdate({ projectId: photos.id, promisedAt: PHOTO_10H, now: new RealDate(NOW) });
  c.ok("…and so is the delivery watch's own draft, 10h before the promise", !watchEarly.ok && (await prisma.smartTask.count({ where: { taskType: "at_risk_update" } })) === 0, watchEarly.ok ? "drafted" : watchEarly.message);
  c.ok("the model was never called for them", asked.length === 0, `${asked.length}`);
  // From here the video's promise has passed: 21h on, it is late.
  const LATER = new RealDate(NOW + 21 * HOUR);
  c.ok("21h on, the same video is listed as late", (await at.atRiskOutputs(LATER)).some((r) => r.key === out20.id && r.overdue));

  // =========================================================================
  c.head("3 · No typed time, no draft");
  // =========================================================================
  const none = await at.draftAtRiskUpdate({ projectId: linden.id, outputId: out20.id, actor: "Kyle" });
  c.ok("no time typed → refused", !none.ok && /one of the two/.test(none.ok ? "" : none.message), none.ok ? "" : none.message);
  const both = await at.draftAtRiskUpdate({ projectId: linden.id, outputId: out20.id, actor: "Kyle", newTime: new RealDate(NOW + 30 * HOUR), confirmBy: new RealDate(NOW + 5 * HOUR) });
  c.ok("both typed → refused", !both.ok);
  const past = await at.draftAtRiskUpdate({ projectId: linden.id, outputId: out20.id, actor: "Kyle", confirmBy: new RealDate(NOW - HOUR) });
  c.ok("a time already past → refused", !past.ok);
  c.ok("the model was never called", asked.length === 0, `${asked.length}`);

  // =========================================================================
  c.head("4 · 'We'll confirm by' — the only dates are the promise and that time");
  // =========================================================================
  const CONFIRM = new RealDate(NOW + 29 * HOUR); // Wed Oct 7, 3:00 PM
  const d1 = await at.draftAtRiskUpdate({ projectId: linden.id, outputId: out20.id, actor: "Kyle", confirmBy: CONFIRM, now: LATER });
  c.ok("drafted", d1.ok, d1.ok ? d1.draft.slice(0, 60) : d1.message);
  c.ok("the model was asked once", asked.length === 1);
  const prompt = asked[0] ?? "";
  const instr = /WHAT WE WANT TO SAY[^"]*"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1] ?? "";
  c.ok("the instruction quotes the pinned promise", instr.includes(ET_DT(PROMISE_20H)), ET_DT(PROMISE_20H));
  c.ok("…and the confirm-by time", instr.includes(ET_DT(CONFIRM)), ET_DT(CONFIRM));
  const datesInPrompt = new Set([...prompt.matchAll(MONTH_DAY)].map((m) => `${m[1].slice(0, 3).toLowerCase()} ${Number(m[2])}`));
  c.ok("NO other date anywhere in what the model was given", [...datesInPrompt].every((d) => d === "oct 7") && datesInPrompt.size === 1, [...datesInPrompt].join(", "));
  c.ok("…and no thread was handed over (the thread is where stray dates live)", /Conversation so far \(oldest first\):\n"""\n\n"""/.test(prompt));
  const task = await prisma.smartTask.findUnique({ where: { dedupeKey: `at-risk:${out20.id}:${PROMISE_20H.toISOString()}` } });
  c.ok("ONE task, keyed on the output and its promise", !!task && task.taskType === "at_risk_update" && task.status === "OPEN", task?.dedupeKey ?? "none");
  c.ok("…on Kyle's list", task?.assignedKey === "kyle" && task?.ownerId === kyle.id);
  c.ok("…due within the hour (the promise has passed)", task?.dueAt?.getTime() === LATER.getTime() + HOUR, task?.dueAt?.toISOString());
  c.ok("…carrying the draft and saying it was not sent", !!task?.description?.includes(d1.ok ? d1.draft : "∅") && /Nothing has been sent/.test(task?.description ?? ""));
  c.ok("…linked to the video it is about", task?.outputId === out20.id && task?.projectId === linden.id);
  c.ok("nothing sent: no outbox row", (await prisma.outboxMessage.count()) === 0);
  c.ok("nothing sent: no outbound comms row", (await prisma.commLog.count({ where: { direction: "out" } })) === 0);
  c.ok("the only request that left was to the model", fence.faked.every((u) => u.startsWith("https://api.anthropic.com/")) && fence.blocked.length === 0, fence.blocked.join(" "));

  // =========================================================================
  c.head("5 · A second click updates the same task");
  // =========================================================================
  const NEWTIME = new RealDate(NOW + 52 * HOUR); // Thu Oct 8, 2:00 PM
  reply = "Hi Erica, the video for 812 Linden Ave will now be delivered by Thu, Oct 8 at 2:00 PM. Apologies for the change.";
  const d2 = await at.draftAtRiskUpdate({ projectId: linden.id, outputId: out20.id, actor: "Kyle", newTime: NEWTIME, now: LATER });
  c.ok("drafted again", d2.ok && !d2.created, d2.ok ? `created=${d2.created}` : d2.message);
  c.ok("still ONE task for this promise", (await prisma.smartTask.count({ where: { taskType: "at_risk_update", outputId: out20.id } })) === 1);
  c.ok("the instruction now carries the confirmed new time", (asked[1] ?? "").includes(ET_DT(NEWTIME)));
  c.ok("a clean draft carries no warning", d2.ok && d2.dateWarning === null, d2.ok ? String(d2.dateWarning) : "");

  // =========================================================================
  c.head("6 · The quoted promise is the recorded one");
  // =========================================================================
  await putSetting("turnarounds", { standardVideoHours: 1, premiumVideoHours: 1, photos: 1 });
  const again = await at.atRiskOutputs(LATER);
  c.ok("changing turnaround defaults moves no quoted promise", again.find((r) => r.key === out20.id)?.promisedAt.getTime() === PROMISE_20H.getTime() && again.find((r) => r.key === photos.id)?.promisedAt.getTime() === PHOTO_10H.getTime());

  // =========================================================================
  c.head("7 · A draft that names a date nobody typed is flagged");
  // =========================================================================
  reply = "Hi Erica, 60 Cedar Ave is running behind. We'll confirm by Wed, Oct 7 at 3:00 PM, and it should be with you by Friday, October 9.";
  const d3 = await at.draftAtRiskUpdate({ projectId: lateJob.id, outputId: outLate.id, actor: "Kyle", confirmBy: CONFIRM });
  c.ok("the stray Friday / October 9 is named", d3.ok && !!d3.dateWarning && /friday/.test(d3.dateWarning) && /october 9/.test(d3.dateWarning), d3.ok ? String(d3.dateWarning) : d3.message);
  const lateTask = await prisma.smartTask.findFirst({ where: { outputId: outLate.id, taskType: "at_risk_update" } });
  c.ok("…at the top of the task, before the draft", /^⚠/.test(lateTask?.description ?? ""), (lateTask?.description ?? "").slice(0, 80));
  c.ok("…and the overdue promise's task is URGENT", lateTask?.priority === "URGENT");
  c.ok("the pure check agrees with itself on a clean line", at.foreignDates("We'll confirm by Wed, Oct 7 at 3 PM.", [PROMISE_20H, CONFIRM]) === null);

  // =========================================================================
  c.head("8 · The exceptions board and Kyle's digest");
  // =========================================================================
  // 11h on: the photo-only job (10h) is late and undrafted; the video (20h) is
  // not late yet; the past one has its draft.
  const AFTER_PHOTOS = new RealDate(NOW + 11 * HOUR);
  const board = await opsExceptionsBoard({ now: AFTER_PHOTOS });
  const risk = board.rows.filter((r) => r.kind === "at-risk-promise");
  c.ok("the board carries the one late and undrafted (the photo-only job), not the drafted one or the one still ahead", risk.length === 1 && risk[0].title === "5 Quarry Ln" && board.totals["at-risk-promise"].all === 1, risk.map((r) => r.title).join(" | "));
  c.ok("…owned by Kyle, one next action, a link to where the button is", risk[0]?.owner === "Kyle" && /Draft an update/.test(risk[0]?.nextAction ?? "") && risk[0]?.href === "/tasks?tab=comms#at-risk");
  await prisma.commLog.create({ data: { channel: "text", direction: "in", clientId: erica.id, clientName: "Erica Walker", contactName: "Erica Walker", fromPhone: "6105550144", body: "Any update on the Linden Ave video?", occurredAt: new RealDate(NOW - 2 * HOUR), source: "openphone" } });
  const lines = await exceptionDigestLines("https://hub.invalid", { now: AFTER_PHOTOS });
  c.ok("Kyle's digest names the at-risk row with its link", lines.some((l) => /5 Quarry Ln/.test(l) && l.includes("https://hub.invalid/tasks?tab=comms#at-risk")), lines.join(" ⏎ "));
  c.ok("…heads the section with his count", lines.some((l) => /^\*Exceptions\* \(\d+ for you/.test(l)), lines[0] ?? "");
  c.ok("…and the unanswered counts from the same walk the Comms tab reads", lines.some((l) => /Unanswered: 1 text, 0 emails → https:\/\/hub\.invalid\/tasks\?tab=comms/.test(l)), lines.join(" ⏎ "));

  // =========================================================================
  c.head("9 · One job's late videos: one row, one update (Oct 28 2026)");
  // =========================================================================
  const john = await prisma.client.create({ data: { name: "John Collins", email: "john@clients.invalid" }, select: { id: true } });
  const month = await prisma.project.create({ data: { title: "October 2026 videos, Malvern, PA", clientId: john.id, status: "EDITING", addressLine: "October 2026 videos" }, select: { id: true } });
  const DUE_A = new RealDate(NOW - 30 * HOUR);
  const DUE_B = new RealDate(NOW - 8 * HOUR);
  const v1 = await video(month.id, 1, { promisedAt: DUE_A, title: "Market update" });
  const v2 = await video(month.id, 2, { promisedAt: DUE_A, title: "Neighborhood tour" });
  const v3 = await video(month.id, 3, { promisedAt: DUE_B, title: "First-time buyers" });
  const nowRows = await at.atRiskOutputs(new RealDate(NOW));
  const groups = at.groupAtRiskRows(nowRows);
  const g = groups.find((x) => x.projectId === month.id);
  c.ok("three late videos of one job are ONE group", !!g && g.rows.length === 3 && groups.filter((x) => x.projectId === month.id).length === 1, `${g?.rows.length}`);
  c.ok("…named together by their titles", g?.owed === 'the 3 videos "Market update", "Neighborhood tour" and "First-time buyers"', g?.owed);
  c.ok("…carrying the earliest promise", g?.promisedAt.getTime() === DUE_A.getTime());
  c.ok("a job with one late video is still its own single row", groups.some((x) => x.projectId === lateJob.id && x.rows.length === 1 && x.key === outLate.id));
  const board9 = await opsExceptionsBoard({ now: new RealDate(NOW) });
  c.ok("the exceptions board carries the job ONCE", board9.rows.filter((r) => r.kind === "at-risk-promise" && r.title === "October 2026 videos").length === 1, board9.rows.filter((r) => r.kind === "at-risk-promise").map((r) => r.title).join(" | "));
  reply = "Hi John, a quick update on your October videos: they are running behind. We'll confirm the exact delivery time by Wed, Oct 7 at 3:00 PM. Sorry for the change.";
  const before9 = asked.length;
  const d9 = await at.draftAtRiskUpdate({ projectId: month.id, outputIds: [v1.id, v2.id, v3.id], actor: "Kyle", confirmBy: CONFIRM });
  c.ok("one draft for the three", d9.ok && asked.length === before9 + 1, d9.ok ? d9.draft.slice(0, 50) : d9.message);
  const instr9 = /WHAT WE WANT TO SAY[^"]*"""\n([\s\S]*?)\n"""/.exec(asked[asked.length - 1] ?? "")?.[1] ?? "";
  c.ok("the model is told about all three videos", /Market update/.test(instr9) && /Neighborhood tour/.test(instr9) && /First-time buyers/.test(instr9), instr9.slice(0, 160));
  c.ok("a clean draft that names only the confirm-by date carries no warning", d9.ok && d9.dateWarning === null, d9.ok ? String(d9.dateWarning) : "");
  const jobTask9 = await prisma.smartTask.findUnique({ where: { dedupeKey: `at-risk:${month.id}:${DUE_A.toISOString()}` } });
  c.ok("ONE task, keyed on the job and its earliest promise", !!jobTask9 && (await prisma.smartTask.count({ where: { taskType: "at_risk_update", projectId: month.id } })) === 1, jobTask9?.dedupeKey ?? "none");
  const after9 = (await at.atRiskOutputs(new RealDate(NOW))).filter((r) => r.projectId === month.id);
  c.ok("every one of the three now shows that task (the later-due one too)", after9.length === 3 && after9.every((r) => r.taskId === jobTask9?.id), after9.map((r) => r.taskId).join(","));
  const board9b = await opsExceptionsBoard({ now: new RealDate(NOW) });
  c.ok("…and the job leaves the exceptions board", !board9b.rows.some((r) => r.kind === "at-risk-promise" && r.title === "October 2026 videos"));
  const again9 = await at.draftAtRiskUpdate({ projectId: month.id, outputIds: [v1.id, v2.id, v3.id], actor: "Kyle", newTime: NEWTIME });
  c.ok("drafting again updates the same task", again9.ok && !again9.created && (await prisma.smartTask.count({ where: { taskType: "at_risk_update", projectId: month.id } })) === 1);
  c.ok("nothing sent: still no outbox row", (await prisma.outboxMessage.count()) === 0);

  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
