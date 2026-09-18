// READ-ONLY. Run Kyle's actual board end to end against production and print
// what it says, so the promise changes are checked through the real query and
// not only through the pure helpers.
import { deliveryBoard } from "../../../src/lib/deliveryBoard";
import { etDateTime } from "../../../src/lib/datetime";

async function main() {
  const b = await deliveryBoard();
  console.log(`unavailable: ${!!b.unavailable} · overdue ${b.overdueCount} · today ${b.today.length} · tomorrow ${b.tomorrow.length} · upcoming ${b.upcoming.length} · delivered ${b.delivered.length}`);
  for (const j of [...b.today, ...b.tomorrow].slice(0, 10)) {
    console.log(`  ${j.title.slice(0, 38).padEnd(40)} ${j.blockerLabel.padEnd(20)} due ${j.dueAt ? etDateTime(j.dueAt) : "—"}  (${j.dueTierLabel ?? "—"}) for ${j.dueFor ?? "—"}`);
  }
  process.exit(0);
}
main();
