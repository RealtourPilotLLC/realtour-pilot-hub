// ---------------------------------------------------------------------------
// LIVE, Oct 30 2026: Joe Sutow's content session goes back to Kyle to book,
// with the slot.
//
// Kyle handed Jordan "Book content session — Joseph Sutow" with "I believe
// this is already done, right?". It was not: the request is still REQUESTED
// with no time picked, and the hub cannot book Joe itself (not in the bookings
// pilot, address not on the map). Jordan, Oct 30 2026: "We need to schedule
// for Joe for Tuesday the 10th at 10am. Please schedule that 4hr session",
// then chose "Kyle books it". He had already moved the task back to Kyle with
// no time on it, so it is assigned to Kyle again by Jordan, with the exact slot
// as its outcome. Kyle is told the usual way (bell, and
// his text with the task's link). Nothing reaches the client.
//
//   dry run:  npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct30-sutow-to-kyle.ts
//   apply:    … --apply
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";

const OUTCOME = "Book Joe's 4-hour content session in Aryeo: Tuesday, November 10, 10 AM to 2 PM ET.";
const NOTE = "Not booked yet: his request had no time picked. Jordan set the slot (Oct 30). Once it is in Aryeo the hub confirms the request within the hour.";

async function main() {
  const apply = process.argv.includes("--apply");
  const tasks = await prisma.smartTask.findMany({
    where: { title: { contains: "Sutow" }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, title: true, status: true, assignedKey: true, delegatedBy: true, dueAt: true, dedupeKey: true },
  });
  console.log(tasks);
  // Jordan had already moved it back to Kyle (5:59 PM) with no time on it.
  const t = tasks.find((x) => (x.assignedKey === "jordan" || x.assignedKey === "kyle") && /Book content session/i.test(x.title));
  if (!t) throw new Error("No open 'Book content session' task for Joe.");
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com", role: "OWNER", status: "ACTIVE" }, select: { email: true, name: true, role: true, teamMemberId: true } });
  if (!apply) { console.log(`\nDry run. --apply hands ${t.id} to Kyle as Jordan with:\n  outcome: ${OUTCOME}\n  note: ${NOTE}\n  due: Mon Nov 2, 5 PM ET`); return; }
  const { assignTask, delegationFor } = await import("@/lib/delegation");
  const r = await assignTask(
    { email: owner.email, name: owner.name ?? "Jordan Spackman", role: owner.role, keys: new Set(["jordan"]), teamMemberId: owner.teamMemberId },
    { title: t.title, assigneeKey: "kyle", sourceTaskId: t.id, outcome: OUTCOME, note: NOTE, dueAt: "2026-11-02" },
  );
  console.log(r);
  const v = (await delegationFor([t.id])).get(t.id);
  console.log({ assignee: v?.assigneeKey, state: v?.state, outcome: v?.outcome, due: v?.dueAt });
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
