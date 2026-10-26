export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 26 2026, after the second refill): Bernadette Rabel's
// third skit trim, then ONE refill for Industry Truths only (skit concepts),
// the one pillar left under 10. Earlier note, still true: The refills kept the husband share and varied the kinds,
// but a few new ideas repeat an idea in another pillar (the same POV, the same
// before-and-after, the same job-description bit), a fourth farm morning
// report (the same video as her scripted Animals skit), a husband quiz that is
// her own Husband Overheard pick again, and two of the same set-up in Lehigh.
// Each is ARCHIVED with its reason (Restore brings one back); only SAVED topics.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-skit-trim3.ts           # dry run (read-only)
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-skit-trim3.ts --apply   # archives
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

const BY = "staff:oct26-skit-trim3";
const SAME = (other: string) => `The same skit as ${other}; one is kept.`;
// [id suffix, title start, reason]
const TRIM: [string, string, string][] = [
  // Personal Brand & Trust Builder
  ["93ar7pcs", "Morning Briefing: Animals vs. Listings", "A fifth farm morning skit: the same video as her scripted Animals skit (October)."],
  ["x9ymwr31", "SAY VS. MEAN: What Sellers Say at the Listing Appointment", SAME("What Sellers Say vs. What They Mean Before the Listing Goes Live (Seller Strategy)")],
  ["gzt6vs3r", "The Pre-Listing Checklist, Narrated", SAME("The Thing I Do Before Every Listing That Most Agents Skip Entirely (Personal Brand)")],
  // Industry Truths, Myth-Busting & Mildly Polarizing Takes
  ["p2l1utsv", "Split Screen: The Agent Who Told You the Truth", SAME("Split Screen: The Agent Who Agreed With Everything vs. The One Who Didn't (Personal Brand)")],
  ["0k6ozgof", "Reenactment: The Call Where a Seller Told Me the Zestimate", SAME("Reenactment: The Moment a Client Said 'But Zillow Says...' (Personal Brand)")],
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
  const enr = await prisma.contentEnrollment.findFirst({ where: { clientId: client.id, status: "ACTIVE" }, select: { id: true } });
  const { plans } = await ct.planPillarRefills(enr!.id, { ignoreCooldown: true });
  const plan = plans.find((p) => !p.skip && p.format === "SKIT" && /^Industry Truths/.test(p.pillarName ?? ""));
  if (!plan) { console.log("Industry Truths: no skit refill needed."); }
  else if (!APPLY) console.log(`would queue: ${plan.pillarName} (skit concepts), keep ${plan.need}`);
  else {
    const r = await ct.queueTopicRefresh({ enrollmentId: enr!.id, kind: "REFRESH", requestedBy: BY, pillarId: plan.pillarId, keep: plan.need, format: plan.format, reason: plan.reason });
    console.log(`queued run ${r.runId}${r.joined ? " (joined an open run)" : ""}: ${plan.pillarName}, keep ${plan.need}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
