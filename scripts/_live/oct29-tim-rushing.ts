// Oct 29 2026, claude: for Jordan. "for the issue for Tim, when I add it to the
// KPI tracker, it doesnt show anything about rushing. That's a common complaint
// for Harrison. Tim mentioned that. Why does it not show in the summary, and
// can we fix that?"
//
// Tim Bonner's complaint (265 Mill Rd) was drafted under the old rule: its
// summary and its words for the KPI tracker kept only the photo faults, and his
// point that Harrison rushes (three times on the call, "since the first time we
// worked with him") went only into the preferences. The rule is fixed
// (clientIssuePlan SUMMARY_RULE / SHOOT_RULE); this reads his complaint again
// for only those two texts. Steps, tasks, preferences, client notes, Aryeo and
// the KPI tracker itself are untouched (Jordan adds the KPI entry), and nothing
// is sent to anyone.
//
//   npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct29-tim-rushing.ts            (dry run: read-only, prints the new words)
//   npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct29-tim-rushing.ts --apply    (writes them)
import { APPLY, db } from "./_oct22-guard";

const ISSUE = "cmvtntfc100b4js08bj4k30ap";
const BY = "claude: for Jordan";
const RUSH = /\brush/i;

async function main() {
  const prisma = await db();
  const P = await import("../../src/lib/clientIssuePlan");
  const { readDraft } = await import("../../src/lib/clientIssuePlanCore");
  const issue = await prisma.clientIssue.findUnique({ where: { id: ISSUE }, select: { title: true, summary: true, planJson: true, prefsText: true, kpiJson: true } });
  if (!issue) throw new Error("Tim's complaint is not there.");
  const d = readDraft(issue.planJson);
  const stepsBefore = await prisma.clientIssueStep.count({ where: { issueId: ISSUE, removedAt: null } });
  console.log(`${issue.title} · draft ${d?.state} · ${stepsBefore} steps · KPI ${issue.kpiJson ?? "none yet"}`);
  console.log("\nNOW summary:", issue.summary);
  console.log("NOW shootFeedback:", d?.shootFeedback);

  if (!APPLY) {
    const f = await P.askFeedback(ISSUE, { current: issue.summary || d?.summary });
    console.log("\nWOULD BE summary:", f.summary);
    console.log("WOULD BE shootFeedback:", f.shootFeedback);
    console.log(`\nmentions rushing: summary ${RUSH.test(f.summary)}, KPI words ${RUSH.test(f.shootFeedback ?? "")}. Dry run: nothing written (--apply asks again and writes only if both mention it).`);
    return;
  }

  const r = await P.refreshFeedback(ISSUE, BY, { mustMention: RUSH });
  console.log(`\n${r.ok ? "WROTE" : "NOT WRITTEN"}: ${r.message}`);
  if (r.after) {
    console.log("NEW summary:", r.after.summary);
    console.log("NEW shootFeedback:", r.after.shootFeedback);
  }
  const after = await prisma.clientIssue.findUnique({ where: { id: ISSUE }, select: { prefsText: true, kpiJson: true } });
  const stepsAfter = await prisma.clientIssueStep.count({ where: { issueId: ISSUE, removedAt: null } });
  console.log(`\nunchanged: steps ${stepsBefore} -> ${stepsAfter}, prefsText ${after?.prefsText === issue.prefsText ? "same" : "CHANGED"}, KPI ${after?.kpiJson === issue.kpiJson ? "same" : "CHANGED"}`);
  const view = await P.loadPlan(ISSUE, { scrubMoney: false });
  console.log("\nthe KPI form's words now:", view?.kpi.note);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
