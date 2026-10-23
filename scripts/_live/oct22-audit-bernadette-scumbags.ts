export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, content audit M4): Bernadette Rabel's topic
// "Real Estate Agents Are Scumbags" (cmt7nuj9p00o29kgnvxp73xve) still points at
// her AUGUST month, because it carries the August import "Salesperson vs.
// Advisor" (cmt7o061k00079k3zgtl41cir, historical). Its live selection
// (RECONCILED, Oct 21) and its current script are October's, so a reader that
// counts topics by their month pointer reads October as 3 topics where 4 are
// picked.
//
// The correction: the topic's month pointer moves to October, where its live
// selection and its script are. The August import stays exactly as it is
// (historical, on August, its own record); no selection, script, version or
// video is touched. The change is written on the topic's history.
//
// It also prints the evidence on a possible repeat: the August import is the
// same idea, and the August scripts were filmed at the Sep 14 shoot.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-bernadette-scumbags.ts           # dry run (read-only)
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-bernadette-scumbags.ts --apply   # writes
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

const TOPIC = "cmt7nuj9p00o29kgnvxp73xve";
const AUGUST_IMPORT = "cmt7o061k00079k3zgtl41cir";
const SEP14_SHOOT = "cmt00zb3p0006la04ks5kd0vv";

async function main() {
  const prisma = await db();
  const t = await prisma.contentTopic.findUniqueOrThrow({ where: { id: TOPIC }, select: { id: true, title: true, status: true, monthId: true, enrollmentId: true } });
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId: t.enrollmentId }, select: { id: true, monthKey: true } });
  const key = (id: string | null) => months.find((m) => m.id === id)?.monthKey ?? id ?? "none";
  const october = months.find((m) => m.monthKey === "2026-10");
  if (!october) throw new Error("No October month for this client");
  const sels = await prisma.contentTopicSelection.findMany({ where: { topicId: TOPIC }, select: { monthId: true, status: true } });
  const scripts = await prisma.contentScript.findMany({ where: { topicId: TOPIC }, select: { id: true, monthId: true, historical: true, status: true, title: true, sourceFile: true } });
  console.log(`topic "${t.title}" · ${t.status} · points at ${key(t.monthId)}`);
  console.log(`  selections: ${sels.map((s) => `${key(s.monthId)} ${s.status}`).join(", ")}`);
  for (const s of scripts) console.log(`  script ${s.id} · ${key(s.monthId)} · ${s.historical ? "historical import" : "live"} · ${s.status} · "${s.title}"${s.sourceFile ? ` (${s.sourceFile})` : ""}`);
  const pointing = await prisma.contentTopic.count({ where: { monthId: october.id } });
  const live = await prisma.contentTopicSelection.count({ where: { monthId: october.id, status: { in: ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"] } } });
  console.log(`October: ${live} picks, ${pointing} topics point at it`);

  // The possible repeat: the same idea in August, and what the Sep 14 shoot filmed.
  const imp = scripts.find((s) => s.id === AUGUST_IMPORT);
  const cuts = await prisma.reviewSubmission.findMany({ where: { projectId: SEP14_SHOOT }, select: { slot: true, fileName: true, status: true }, orderBy: [{ slot: "asc" }, { createdAt: "asc" }] });
  const slots = [...new Map(cuts.map((c) => [c.slot, c])).values()];
  console.log(`possible repeat: the August import "${imp?.title}" is the same idea (Google "real estate agents are...", some agents earned the reputation, cell-phone photos and a sign in the yard, salesperson vs advisor).`);
  const vids = await prisma.contentVideo.findMany({ where: { projectId: SEP14_SHOOT }, select: { title: true } });
  console.log(`  the Sep 14 shoot (1142 Hamilton St, filed as September) filmed from the August scripts: its videos are ${vids.map((v) => `"${(v.title ?? "").replace(/\s+/g, " ")}"`).join(", ")} (three carry August titles: Stop House Hunting / Searching Without a Plan, This or That, Why Easton).`);
  console.log(`  its cuts by slot: ${slots.map((c) => `${c.slot}: ${c.fileName}`).join(" | ")}`);
  console.log("  no cut has a transcript, and five slots carry no title, so whether \"Salesperson vs. Advisor\" was filmed there is not on file: watch slots 1, 2, 4, 5 and 6.");

  if (t.monthId === october.id) { console.log("already points at October: nothing to do"); process.exit(0); }
  console.log(`would set the topic's month ${key(t.monthId)} -> 2026-10 and record it on the topic's history; the August import is left as it is.`);
  if (!APPLY) process.exit(0);
  const { recordTopicEvent } = await import("../../src/lib/contentTopics");
  const r = await prisma.contentTopic.updateMany({ where: { id: TOPIC, monthId: t.monthId }, data: { monthId: october.id } });
  if (r.count !== 1) throw new Error("The topic changed since it was read: nothing written.");
  await recordTopicEvent(TOPIC, t.enrollmentId, "EDITED", { kind: "STAFF", staffUserId: "info@realtourpilot.com" }, {
    monthId: october.id, fromStatus: t.status, toStatus: t.status,
    note: "Month corrected to October, where its selection and script are (it pointed at August because of the August import \"Salesperson vs. Advisor\", which stays as history).",
  });
  console.log("written: the topic now points at October");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
