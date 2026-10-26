export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 26 2026, after the guarded refills): Bernadette Rabel's
// second skit trim. The refills kept the husband share and varied the kinds,
// but a few new ideas repeat an idea in another pillar (the same POV, the same
// before-and-after, the same job-description bit), a fourth farm morning
// report (the same video as her scripted Animals skit), a husband quiz that is
// her own Husband Overheard pick again, and two of the same set-up in Lehigh.
// Each is ARCHIVED with its reason (Restore brings one back); only SAVED topics.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-skit-trim2.ts           # dry run (read-only)
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-skit-trim2.ts --apply   # archives
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

const BY = "staff:oct26-skit-trim2";
const SAME = (other: string) => `The same skit as ${other}; one is kept.`;
// [id suffix, title start, reason]
const TRIM: [string, string, string][] = [
  // Personal Brand & Trust Builder
  ["mdi53d4d", "The Farm Morning Debrief", "A fourth farm morning report: the same video as her scripted Animals skit (October)."],
  ["a80v95c6", "What My Husband Has Learned About Real Estate", "Her own Husband Overheard pick again (October): her husband reading back the real estate he has absorbed."],
  ["vst64fj7", "What Sellers Say vs. What I Hear", SAME("What Sellers Say vs. What They Mean Before the Listing Goes Live (Seller Strategy)")],
  ["emawobgr", "POV: First Week on Market With the Wrong Agent", SAME("POV: You Hired the Cheapest Agent and It's Week Six (Seller Strategy)")],
  ["d5px6rxx", "Reaction: Reading My Own Listing Description", SAME("Reaction: Reading a Listing Description Written by Someone Who Gave Up (Seller Strategy)")],
  ["i8hr09ic", "The Part of My Job Description Nobody Warned Me About", SAME("We're Not Door Openers: The Job Description, Corrected (Buyer Education)")],
  ["be79z5zw", "Before and After: The Client Who Listened", SAME("Before and After: The Prep That Paid Off vs. The Prep That Didn't (Seller Strategy)")],
  // Lehigh Valley Lifestyle & Local Authority
  ["h9oax84w", "The College Hill Dispatch", "The same set-up as The Hellertown Undercover Report (a straight-faced correspondent filing from one town); one is kept."],
  ["q7rfwm5c", "POV: You Just Moved to the Lehigh Valley and You Have No Idea Where to Eat", "Repeats her own October videos: Where to Eat and The Best Brunch Spots in the Lehigh Valley."],
];

async function main() {
  const prisma = await db();
  const ct = await import("../../src/lib/contentTopics");
  const client = await prisma.client.findFirst({ where: { name: { equals: "Bernadette Rabel", mode: "insensitive" } }, select: { id: true } });
  if (!client) throw new Error("Bernadette Rabel not found");
  let done = 0, skipped = 0;
  for (const [suffix, start, reason] of TRIM) {
    const rows = await prisma.contentTopic.findMany({ where: { clientId: client.id, id: { endsWith: suffix } }, select: { id: true, title: true, status: true } });
    const t = rows.length === 1 ? rows[0] : null;
    if (!t || !t.title.startsWith(start)) { console.log(`  SKIP ${suffix}: ${rows.length} match(es), title "${rows[0]?.title ?? ""}"`); skipped++; continue; }
    if (t.status !== "SAVED") { console.log(`  SKIP ${t.title}: ${t.status} (only a SAVED topic is archived)`); skipped++; continue; }
    console.log(`  ${APPLY ? "archive" : "would archive"}: ${t.title}\n      ${reason}`);
    if (!APPLY) continue;
    await ct.archiveTopic(t.id, BY, reason);
    done++;
  }
  console.log(`\n${APPLY ? `archived ${done}` : `dry run: ${TRIM.length - skipped} would be archived`}, skipped ${skipped}.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
