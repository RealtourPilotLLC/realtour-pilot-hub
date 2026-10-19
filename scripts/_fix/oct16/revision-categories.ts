// ---------------------------------------------------------------------------
// LIVE (Oct 16 2026): 62 of 80 revision issues sit in "Other", so a repeat
// ("the logo again", "the music again") can't be counted. New issues get a
// SUGGESTED category from their words as they are made (issueCauses.
// suggestIssueCategory, stored by revisionIssues.recordCategorySuggestion as a
// CATEGORY_SUGGESTED event). This gives the issues already in "Other" the same
// suggestion. It never touches `category` (a person's pick stays a person's),
// skips an issue that already has a suggestion, and writes nothing for words
// that don't point anywhere ("Everything else is perfect!").
//
//   set -a && source .env && set +a
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct16/revision-categories.ts           # dry run (read-only connection)
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct16/revision-categories.ts --apply   # write the suggestions
// ---------------------------------------------------------------------------
export {};
const APPLY = process.argv.includes("--apply");
// A dry run cannot write: the connection itself is read-only.
if (!APPLY && process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${process.env.DATABASE_URL.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { suggestIssueCategory } = await import("@/lib/issueCauses");
  const { CATEGORY_SUGGESTED, recordCategorySuggestion } = await import("@/lib/revisionIssues");
  const rows = await prisma.revisionIssue.findMany({
    where: { category: "Other" },
    orderBy: { createdAt: "asc" },
    select: { id: true, sourceKind: true, summary: true, originalText: true, state: true },
  });
  const had = new Set(
    (await prisma.revisionIssueEvent.findMany({ where: { kind: CATEGORY_SUGGESTED, issueId: { in: rows.map((r) => r.id) } }, select: { issueId: true } })).map((e) => e.issueId),
  );
  const words = (r: (typeof rows)[number]) => [r.summary, r.originalText].filter(Boolean).join("\n");
  const tally = new Map<string, number>();
  let none = 0;
  console.log(`${rows.length} issues in "Other"; ${had.size} already have a suggestion.${APPLY ? "" : " DRY RUN (nothing written)."}\n`);
  for (const r of rows) {
    const s = suggestIssueCategory(words(r));
    if (s) tally.set(s, (tally.get(s) ?? 0) + 1);
    else none++;
    console.log(`${(s ?? "(no suggestion)").padEnd(20)} ${had.has(r.id) ? "had " : "    "}${r.sourceKind.padEnd(11)} ${r.id}  ${JSON.stringify((r.summary || r.originalText).replace(/\s+/g, " ").slice(0, 90))}`);
  }
  console.log(`\nWould suggest: ${[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing"}; no suggestion: ${none}`);
  if (!APPLY) return;
  let written = 0;
  for (const r of rows) {
    if (had.has(r.id)) continue;
    if (await recordCategorySuggestion(r.id, words(r))) written++;
  }
  console.log(`Wrote ${written} suggestion${written === 1 ? "" : "s"}. Categories untouched.`);
}
main()
  .then(async () => { const { prisma } = await import("@/lib/prisma"); await prisma.$disconnect(); })
  .catch((e) => { console.error(e); process.exit(1); });
