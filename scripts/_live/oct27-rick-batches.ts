// ---------------------------------------------------------------------------
// RICK SCHULTZ'S 48 VIDEOS, IN BATCHES OF 8 (Oct 27 2026). Jordan: "We should
// have 8 videos done every 7 - 10 business days." He picked "Batches of 8,
// Kim only" and "Nobody yet" (set it up in the hub; no message to Rick or Kim).
//   1  stamps every video of the plan with its batch date (lib/bulkBatches)
//   2  clears session 1's office date (Nov 4, set by Jordan this morning, before
//      the batch decision) so the job reads its batch, with a timeline note
// Dry run unless --apply. Sends nothing.
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const MONTH = "cmup0bq3r00qejg049llw9vti";
const S1 = "cmv88mh2500h0if067baesczl";
const S1_OFFICE_DUE = "2026-11-04T14:27:00.000Z";

const et = (d: Date | null | undefined) =>
  d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "none";

async function main() {
  const prisma = await db();
  const { stampBulkBatches } = await import("../../src/lib/bulkBatches");
  const { videoDuesFor } = await import("../../src/lib/editorDue");
  const shoots = await prisma.project.findMany({ where: { contentMonthId: MONTH }, select: { id: true, title: true, dueOverrideAt: true, overrideBy: true, overrideNote: true } });

  const before = await videoDuesFor(shoots.map((s) => s.id));
  console.log("BEFORE");
  for (const s of shoots) console.log(`  ${s.title.slice(0, 40)}: due ${et(before.get(s.id)?.at)} (${before.get(s.id)?.source ?? "none"})`);

  const preview = await stampBulkBatches({ monthId: MONTH, dryRun: true });
  console.log(`\nBATCH STAMPS: ${preview.videos} videos, ${preview.changed} to date, ${preview.keptOtherRule} kept (dated by another rule)`);
  const byBatch = new Map<number, typeof preview.changes>();
  for (const ch of preview.changes) byBatch.set(ch.batchNo, [...(byBatch.get(ch.batchNo) ?? []), ch]);
  for (const [no, rows] of [...byBatch].sort((a, b) => a[0] - b[0])) {
    const idx = rows.map((r) => r.index);
    console.log(`  batch ${no}: videos ${Math.min(...idx)}-${Math.max(...idx)} (${rows.length}), aim ${et(rows[0].to.targetAt)}, due ${et(rows[0].to.promisedAt)}`);
  }

  const s1 = shoots.find((s) => s.id === S1);
  const clear = s1?.dueOverrideAt?.toISOString() === S1_OFFICE_DUE;
  console.log(`\nSESSION 1 OFFICE DATE: ${et(s1?.dueOverrideAt)} by ${s1?.overrideBy ?? "?"} -> ${clear ? "clear it (the batch date takes over)" : "NOT the expected Nov 4 date: left alone"}`);

  if (!APPLY) return console.log("\nDry run: nothing written. Add --apply.");

  const done = await stampBulkBatches({ monthId: MONTH });
  console.log(`\nstamped ${done.changed} videos`);
  if (clear) {
    const note = "Batches of 8 (Jordan, Oct 27): this job is due by batch, 8 videos every 7 to 10 business days. Each video's date is on the brief.";
    await prisma.project.update({ where: { id: S1 }, data: { dueOverrideAt: null, overrideBy: "Claude (for Jordan)", overrideAt: new Date(), overrideNote: note } });
    await prisma.activity.create({ data: { projectId: S1, type: "SYSTEM", body: `Office due date (Nov 4) cleared. ${note}` } });
    console.log("cleared session 1's Nov 4 office date, timeline note written");
  }
  const after = await videoDuesFor(shoots.map((s) => s.id));
  console.log("\nAFTER");
  for (const s of shoots) console.log(`  ${s.title.slice(0, 40)}: due ${et(after.get(s.id)?.at)} (${after.get(s.id)?.source ?? "none"}), aim ${et(after.get(s.id)?.aimAt)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
