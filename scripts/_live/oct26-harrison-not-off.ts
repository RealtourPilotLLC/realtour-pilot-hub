// ---------------------------------------------------------------------------
// Oct 26 2026, Jordan: "it says Harrison is off - he's not."
//
// On Oct 22 Jordan said Harrison would be off the week of Oct 26, and Claude
// entered Mon Oct 26 to Fri Oct 30 (vacation) on his PTO tracker. The Oct 25
// audit taught every home to read that tracker, so his five shoots this week
// read "Harrison is off that day" and count as blocked. He is working, so the
// entry comes off, through lib/pto's own compare-and-set, with a log line that
// says why. His 10-day bank gets the 5 days back.
// Dry run by default (read-only, proven); `--apply` writes.
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const HARRISON = "cmqiiczur00059k2mzj3vtn5k";
const YEAR = "2026-09-25";
const ENTRY = "ff00b5cd-3d70-46de-9c35-4a402ce66d03";
const BY = "info@realtourpilot.com (removed by Claude: Jordan, Oct 26 2026, \"he's not\" off)";

type Entry = { id: string; startKey: string; endKey: string; type: string; note: string };
type Doc = { v: 1; entries: Entry[]; log: { at: string; by: string; what: string }[] };

// lib/pto drags in client code under tsx, so this is its updatePto by hand:
// the same key, the same JSON, the same compare-and-set on the old value.
async function main() {
  const prisma = await db();
  const key = `pto:${HARRISON}:${YEAR}`;
  const row = await prisma.appSetting.findUniqueOrThrow({ where: { key }, select: { value: true } });
  const doc = JSON.parse(row.value) as Doc;
  console.log("entries now:", JSON.stringify(doc.entries.map((e) => `${e.startKey}..${e.endKey} ${e.type} (${e.note})`)));
  const hit = doc.entries.find((e) => e.id === ENTRY);
  if (!hit) { console.log("that entry is already gone"); return; }
  const next: Doc = {
    v: 1,
    entries: doc.entries.filter((e) => e.id !== ENTRY),
    log: [...doc.log, { at: new Date().toISOString(), by: BY, what: "Removed Mon Oct 26 to Fri Oct 30 (Jordan, Oct 26: he is working this week)" }].slice(-200),
  };
  console.log(`would remove: ${hit.startKey} to ${hit.endKey} (${hit.note}); ${next.entries.length} entr${next.entries.length === 1 ? "y" : "ies"} left`);
  if (!APPLY) return;
  const r = await prisma.appSetting.updateMany({ where: { key, value: row.value }, data: { value: JSON.stringify(next), updatedBy: BY.slice(0, 120) } });
  console.log(r.count === 1 ? "removed" : "NOT removed: the record changed underneath; re-run");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => (await db()).$disconnect().catch(() => {}));
