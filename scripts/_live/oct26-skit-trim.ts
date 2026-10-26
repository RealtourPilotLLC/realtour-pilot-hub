export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 26 2026 eve): trim Bernadette Rabel's skit concepts before
// the guarded refill. Jordan: "Not all of bernadettes skit ideas should be
// with her husband" and "I need 10-15 different skit ideas per pillar".
//
// Her pillars held her husband in up to 9 of 12 skits, the same "farm morning
// report" three times (the same video as her scripted Animals skit), two Date
// Nights, about eight courtroom set-ups and a brunch ranking that repeats her
// own October pick. Each topic below is ARCHIVED with its reason on the
// topic's history (Restore brings one back). Only SAVED topics: a picked or
// scripted one is never touched. Afterwards oct26-skit-banks.ts --apply
// queues the guarded refills (contentGeneration: at most a third of a
// pillar's skits with a cast member, a third of a refill as parodies).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-skit-trim.ts           # dry run (read-only)
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-skit-trim.ts --apply   # archives
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

const BY = "staff:oct26-skit-trim";
const HUSBAND = "Husband share: at most a third of a pillar's skits use him; kept the stronger ones.";
const COURT = "Courtroom set-up: the bank had about eight; one kept.";
// [id suffix, title start, reason]
const TRIM: [string, string, string][] = [
  // Seller Strategy & Listing Positioning
  ["027bh0i2", "Nature Documentary: The Overpriced", "Rests on a David Attenborough impression (a real, named person); a nature documentary skit was archived once already."],
  ["tny3g838", "The Listing Prep Intervention", HUSBAND],
  ["pphhkqr5", "The Open House Debrief, Network News", "Parody share: a straight-faced news segment, the same set-up as The Hellertown Undercover Report."],
  ["3s6b517z", "The Twilight Event Planning", "Parody share: another straight-faced professional reading a checklist; the weakest of the set."],
  ["iqvarxmf", "The Net Profit Tribunal", `${COURT} Same point as The Price Is Wrong (net, not the sale price). ${HUSBAND}`],
  ["o6rzpgsv", "The Buyer Demographic Briefing", "Parody share: an intelligence briefing, the same set-up as two others in the bank."],
  ["tecvjn9t", "The Staging Consultation", "Parody share: a deadpan director's walk-through, the same shape as the Listing Photography Review that was kept."],
  ["aqo3ruip", "The Commission Math Breakdown", "Same point as The Commission Negotiation, Live From Both Sides of the Table (Industry Truths)."],
  ["veuweuhk", "The Smart Prep vs. the Expensive", `Parody share: a deadpan show-host pitch. ${HUSBAND}`],
  // Buyer Education & Protection
  ["7qiv3j7c", "The Buyer Deposition", `${COURT} ${HUSBAND}`],
  ["hyl4uiwf", "The Closing Cost Orientation", `An orientation set-up, repeated in two other pillars. ${HUSBAND}`],
  ["aat8qdel", "The Escalation Clause Hearing", `${COURT} ${HUSBAND}`],
  ["g2tsidkb", "The Title Insurance Briefing", `An intelligence briefing set-up, repeated in the bank. ${HUSBAND}`],
  ["aj646vjk", "The Appraisal Contingency Waiver", COURT],
  // Personal Brand & Trust Builder
  ["nzbxtcgs", "The Farm Morning Report, Live From the Field", "The same video as her scripted Animals skit (October), and a repeat of another farm morning report."],
  ["wnixwip4", "The Farm Morning Report, Live From Someone", "The same video as her scripted Animals skit (October): her husband, the animals, her calm listing prep."],
  // Lehigh Valley Lifestyle & Local Authority
  ["yj1nhhx8", "The Brunch Spot Ranking", "Repeats her own October pick, The Best Brunch Spots in the Lehigh Valley."],
  ["cifkg45v", "Date Night in Easton, Planned by One", "A second Date Night: the same skit as Date Night Itinerary, Narrated by the Person Who Planned It."],
  ["lx2swgfb", "The Farm Morning Report, Filed Remotely", "A third farm morning report, the same video as her scripted Animals skit, and not a Lehigh Valley idea."],
  ["5ykrn9id", "The Lehigh Valley Newcomer Field Test", HUSBAND],
  ["m3ba0wim", "The Relocation Orientation", `An orientation set-up, repeated in two other pillars; Moving From New Jersey covers the newcomer point. ${HUSBAND}`],
  ["ybi9hgk1", "Bethlehem: South Side vs. West Side", `${COURT} ${HUSBAND}`],
  ["41t5ozer", "The Lehigh Valley Weekend Itinerary, Delivered Under Oath", COURT],
  // Industry Truths, Myth-Busting & Mildly Polarizing Takes
  ["ff4s4lle", "The Zestimate Defense Counsel", `${COURT} The Zestimate point is in The Price Is Wrong and the Courtroom Drama. ${HUSBAND}`],
  ["bwova94p", "The Family Real Estate Advisor", `A briefing set-up, repeated in the bank. ${HUSBAND}`],
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
