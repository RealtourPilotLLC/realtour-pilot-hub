export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 25 2026 audit, area E), ONLY IF JORDAN SAYS SO: reopen the
// content-program escalations that were closed by hand on Oct 23 2026 at
// 8:28 PM ET while what they ask for is still missing.
//
// The reminder engine files ONE escalation per month and action
// (programReminders: "One escalation per (month, action)"), so once its task is
// closed nobody gets another one: after their last reminder, Marcee McMullen,
// Mike Ciunci, Mike Flatley and Ashley Brunner go quiet with no October session
// (or plan) and no task on anyone's list. Janice Pigga's, closed in the same
// minute, is left alone: she booked.
//
// The dry run re-checks each with the hourly closer's own question
// (programReminders.reminderAskStillOpen) and lists the ones whose condition
// still holds. --apply sets those back to OPEN with a plain note. It contacts
// nobody and changes nothing else.
//
//   NODE_OPTIONS=--conditions=react-server node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct25-content-reopen-escalations.ts           # dry run
//   NODE_OPTIONS=--conditions=react-server node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct25-content-reopen-escalations.ts --apply   # writes
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

/** Closed together on 2026-10-24 00:28:30-33 UTC with no hub note. */
const CLOSED_BY_HAND = new Date("2026-10-24T00:28:00Z");
const CLOSED_BY_HAND_END = new Date("2026-10-24T00:29:00Z");

async function main() {
  const prisma = await db();
  const tasks = await prisma.smartTask.findMany({
    where: { dedupeKey: { startsWith: "program-reminder-escalation:" }, status: "COMPLETED", completedAt: { gte: CLOSED_BY_HAND, lt: CLOSED_BY_HAND_END } },
    select: { id: true, title: true, description: true, completedAt: true },
  });
  console.log(`${tasks.length} escalation(s) closed by hand at 8:28 PM ET on Oct 23`);
  // The hourly closer reads open tasks only, so ask its question (the reminder
  // engine's reminderAskStillOpen) directly for each closed one.
  const { reminderAskStillOpen } = await import("../../src/lib/programReminders");
  const { parseEscalationKey } = await import("../../src/lib/programTaskCloser");
  const reopen: { id: string; title: string; evidence: string }[] = [];
  for (const t of tasks) {
    const row = await prisma.smartTask.findUnique({ where: { id: t.id }, select: { dedupeKey: true } });
    const k = parseEscalationKey(row?.dedupeKey ?? "");
    if (!k) { console.log(`  SKIP ${t.title}: key unreadable`); continue; }
    const v = await reminderAskStillOpen(k.monthId, k.action);
    console.log(`  ${v.holds ? "REOPEN" : "LEAVE "} ${t.title} :: ${v.evidence}`);
    if (v.holds) reopen.push({ id: t.id, title: t.title, evidence: v.evidence });
  }
  if (!APPLY) { console.log(`\nDry run: nothing written. --apply reopens ${reopen.length}.`); return; }
  let n = 0;
  for (const r of reopen) {
    const t = tasks.find((x) => x.id === r.id)!;
    const note = `Reopened Oct 25 2026 (audit): closed by hand on Oct 23 while ${r.evidence.replace(/\s*[—–]\s*/g, ", ")}.`;
    const u = await prisma.smartTask.updateMany({ where: { id: r.id, status: "COMPLETED" }, data: { status: "OPEN", completedAt: null, description: `${t.description ? `${t.description}\n\n` : ""}${note}`.slice(0, 20_000) } });
    n += u.count;
  }
  console.log(`\nReopened ${n}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
