// ---------------------------------------------------------------------------
// MIKE CIUNCI'S OCTOBER BOOKING REMINDERS, SNOOZED (Oct 27 2026).
// His October content session happened: Oct 12, 141 E Marshall St, the
// "Video Starter - 2HR Session" + Premium Social Reel job. That job is not
// linked to his October content month, so the evaluator reads October as never
// booked and had already emailed him four times to book it (Oct 14, 15, 19,
// 22). Found while making booking reminders daily (Jordan: "I think we need
// to send daily reminders to clients to schedule their content session"),
// which would have chased him every weekday to month end. Snoozed to Nov 1
// with the office's own snooze (reversible: unsnoozeMonthReminders). Linking
// the job to the month is Jordan's call.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-mike-ciunci-october-snooze.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const MONTH = "cmup0bq3y00qfjg047fqwv7oy"; // Mike Ciunci, 2026-10

async function main() {
  const prisma = await db();
  const m = await prisma.contentMonth.findUniqueOrThrow({ where: { id: MONTH }, select: { monthKey: true, remindersSnoozedUntil: true, clientId: true } });
  const client = await prisma.client.findUniqueOrThrow({ where: { id: m.clientId }, select: { name: true } });
  if (m.monthKey !== "2026-10" || !/Ciunci/.test(client.name ?? "")) throw new Error(`not Mike Ciunci's October: ${client.name} ${m.monthKey}`);
  const { etAt } = await import("../../src/lib/datetime");
  const until = etAt("2026-11-01", 0);
  console.log(`${client.name} ${m.monthKey}: snoozed ${m.remindersSnoozedUntil?.toISOString() ?? "no"} -> until ${until.toISOString()}`);
  if (!APPLY) { console.log("dry run: nothing written. Re-run with --apply."); return; }
  const { snoozeMonthReminders } = await import("../../src/lib/programReminders");
  await snoozeMonthReminders(MONTH, until, "October session already filmed Oct 12 (141 E Marshall St, Video Starter 2HR) but that job isn't linked to this month", "Claude (for Jordan)");
  console.log("written.");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
