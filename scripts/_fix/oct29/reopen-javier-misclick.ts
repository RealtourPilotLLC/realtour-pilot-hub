// Oct 29 2026: put Javier Jimenez's emails (Gary Mercer Jr.) back on Kyle's
// list. Kyle pressed "Mark handled: no reply needed" by mistake at 5:02:54 PM
// ET while taking a screenshot of the card (his Slack to Jordan, ~5:15 PM:
// "I clicked on marked as handled on this task by mistake"). Jordan asked for
// it reopened.
//
// What the tick wrote, and what this puts back:
//   · comms-ack-thread:email:e%3Ajimenez%7Cjavier       → removed (the desk's thread tick)
//   · comms-ack-email-<Gary Mercer Jr.>:jimenez%7Cjavier → the cut the card had
//     before: the tick overwrote the earlier value, which closed the Oct 27
//     "Re: 913 Lakeview" message (the reply to-do was closed between Oct 27 and
//     Oct 29 and reopened by the 9:43 AM email, "2 messages waiting"). The cut
//     goes back to that Oct 27 message, so the card shows the same two Oct 29
//     emails (913 Lakeview follow-up, "204 Spring Ln - Add media").
//   · the reply to-do cmvjtupvz002gl308yfxpnco6 → OPEN, completedAt cleared
//   · its handled-by-hand stamp (Kyle Smith, 5:02:54 PM) → removed
// Each step runs only if the row still holds exactly what the tick wrote.
// Dry run by default; --apply writes. Actor "claude: for Jordan".
import { prisma } from "../../../src/lib/prisma";

const APPLY = process.argv.includes("--apply");
const ACTOR = "claude: for Jordan";
const CLIENT = "cmqiksaru005l9k9q25tc6ebd";
const TASK = "cmvjtupvz002gl308yfxpnco6";
const THREAD_KEY = "comms-ack-thread:email:e%3Ajimenez%7Cjavier";
const EMAIL_KEY = `comms-ack-email-${CLIENT}:jimenez%7Cjavier`;
const STAMP_KEY = `handled-by-hand:${TASK}`;
const TICK = { thread: "2026-10-29T21:02:54.533Z|no reply needed", email: "2026-10-29T21:02:54.540Z", taskDone: "2026-10-29T21:02:54.558Z" };
// The Oct 27 6:38 PM "Re: 913 Lakeview" email reached the hub at this instant (CommLog createdAt).
const EARLIER_CUT = "2026-10-27T18:40:49.442Z";

async function main() {
  const [thread, email, stamp, task] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: THREAD_KEY } }),
    prisma.appSetting.findUnique({ where: { key: EMAIL_KEY } }),
    prisma.appSetting.findUnique({ where: { key: STAMP_KEY } }),
    prisma.smartTask.findUnique({ where: { id: TASK }, select: { status: true, completedAt: true, title: true } }),
  ]);
  const plan: string[] = [];
  if (thread?.value === TICK.thread) plan.push(`remove ${THREAD_KEY}`);
  else plan.push(`skip ${THREAD_KEY}: holds ${thread?.value ?? "nothing"}`);
  if (email?.value === TICK.email) plan.push(`${EMAIL_KEY} → ${EARLIER_CUT}`);
  else plan.push(`skip ${EMAIL_KEY}: holds ${email?.value ?? "nothing"}`);
  if (task?.status === "COMPLETED" && task.completedAt?.toISOString() === TICK.taskDone) plan.push(`reopen task ${TASK} (${task.title})`);
  else plan.push(`skip task ${TASK}: ${task?.status} ${task?.completedAt?.toISOString() ?? ""}`);
  const stampAt = (() => { try { return (JSON.parse(stamp?.value ?? "{}") as { at?: string }).at ?? null; } catch { return null; } })();
  if (stampAt && stampAt.startsWith("2026-10-29T21:02:54")) plan.push(`remove ${STAMP_KEY}`);
  else plan.push(`skip ${STAMP_KEY}: ${stamp?.value ?? "nothing"}`);
  console.log(APPLY ? "APPLY" : "DRY RUN");
  for (const p of plan) console.log(" ·", p);
  if (!APPLY) return;

  await prisma.$transaction(async (tx) => {
    if (thread?.value === TICK.thread) await tx.appSetting.delete({ where: { key: THREAD_KEY } });
    if (email?.value === TICK.email) await tx.appSetting.update({ where: { key: EMAIL_KEY }, data: { value: EARLIER_CUT, updatedBy: ACTOR } });
    if (task?.status === "COMPLETED" && task.completedAt?.toISOString() === TICK.taskDone) await tx.smartTask.update({ where: { id: TASK }, data: { status: "OPEN", completedAt: null } });
    if (stampAt && stampAt.startsWith("2026-10-29T21:02:54")) await tx.appSetting.delete({ where: { key: STAMP_KEY } });
    await tx.auditLog.create({
      data: {
        actor: ACTOR,
        action: "comms_handled_undone",
        target: CLIENT,
        detail: JSON.stringify({
          why: "Kyle pressed Mark handled by mistake at 5:02:54 PM ET while taking a screenshot (Slack to Jordan, Oct 29). Jordan asked for it reopened.",
          group: "jimenez|javier", task: TASK, before: { thread: thread?.value ?? null, email: email?.value ?? null, stamp: stamp?.value ?? null }, emailCutRestoredTo: EARLIER_CUT,
        }),
      },
    });
  });
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
