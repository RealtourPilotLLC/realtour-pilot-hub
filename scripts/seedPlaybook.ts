import { prisma } from "@/lib/prisma";

// Authoritative, hand-curated core knowledge from Jordan's operating playbook
// (the distilled crown-jewel facts). Pinned so they always rank high. Role-tagged
// so finances/pay/strategy stay OWNER-only. source="playbook" so a re-run replaces
// just these without touching the chatgpt-export extraction.

type Seed = { category: string; title: string; body: string; minRole: string };

const ITEMS: Seed[] = [
  // ---- OWNER: finances, pay, strategy, personnel, targets ----
  { category: "financial", minRole: "OWNER", title: "Revenue and growth target", body: "2025 revenue was about $317k (roughly $26k/month) across ~164 clients. The 2026 goal is $750k." },
  { category: "goal", minRole: "OWNER", title: "Jordan wants out of the field", body: "Jordan's core goal is to step out of day-to-day field/operations work and personally handle only VIP clients and exceptions, with the platform and Kyle running the rest." },
  { category: "team", minRole: "OWNER", title: "Contractor pay rates", body: "Harrison Wells (full-time photographer) is 35% of eligible invoice with a $100 minimum. James Livingston (newer, video) is 30% with a $75 minimum. Contractor mileage is $0.65 to $0.67 per mile beyond a 35-mile radius, per leg." },
  { category: "financial", minRole: "OWNER", title: "Editing vendor cost", body: "Editing is largely offshore (Vietnamese-speaking team). The premium reel vendor Luma Visuals costs roughly $2,632/month." },
  { category: "team", minRole: "OWNER", title: "Harrison Wells is a retention risk", body: "Harrison Wells is the main full-time photographer but is a flight risk and has been building a competing company. Treat assignments and the relationship with that in mind." },
  { category: "pricing", minRole: "OWNER", title: "Premium reel pricing and margin logic", body: "Premium social media reels anchor at about $1,000 each; bulk packages around $850/reel. Baseline cost is roughly $500 to $550 per reel ($300 editing plus $200 to $250 prep/shoot/PM), so protect margin and avoid heavy discount structures like buy-2-get-1-free." },
  { category: "client_insight", minRole: "OWNER", title: "Top clients by revenue (concentration)", body: "Top ~8 clients are 40%+ of revenue. Jamie Achberger ($45k, 72 orders) is top revenue; Stephen Kennedy ($32k, 111 orders, priced ~$225/shoot) is top volume; then Nehemiah Lindo, Gina Spaziano, Barbara Matyszczak, Tabitha Heit, Erica Walker, Mady Reinert." },

  // ---- ADMIN: client handling, fees, problem resolution, ops ----
  { category: "fee", minRole: "ADMIN", title: "Fee schedule", body: "Reshoot or 2nd trip $150; same-day cancellation $125; reschedule under 24h $150; weekend premium +$200 (and generally no Saturday shoots); travel over 100mi round trip $1.50/mi; one free video revision then $75 each; real twilight as a separate shoot $200 to $250; weather reschedules carry no fee; non-solicit breach is $5,000 liquidated damages." },
  { category: "issue", minRole: "ADMIN", title: "Problem-handling decision rules", body: "Refund on delivered work is a hard no, redirect to revisions. Unstaged-property complaint is the client's responsibility, offer a paid reshoot and educate (we capture as it appears on arrival). For late delivery, prefer an add-on over a discount. Photographer no-show: own it with the client without blaming the contractor, secure a backup, and offer a $100 credit. For a VIP used to Jordan, check with Jordan before assigning another photographer." },
  { category: "sop", minRole: "ADMIN", title: "Issue resolution SLA", body: "Acknowledge any issue within 2 hours and log it. Severity tiers: Urgent same-day, High 24h, Medium 48h, Low 3 days." },
  { category: "sop", minRole: "ADMIN", title: "Goodwill credit tracking", body: "Track goodwill credits given per client and warn when goodwill is exhausted. Jordan has covered a client's reshoot fee several times before enforcing; the platform should make that visible." },
  { category: "sop", minRole: "ADMIN", title: "Confirmation call the day before a shoot", body: "Call the day before each shoot to verify date, time, services, and access (lockbox/seller/agent), confirm features to highlight and turnaround, and offer upgrades (twilight, drone, staging, 3D)." },
  { category: "sop", minRole: "ADMIN", title: "Post-delivery is a text, not a care call", body: "Care calls were dropped because no one answers. On delivery, the hub drafts a status-aware client text (what is delivered vs still in production) with a feedback-form link, queued for a human to send. Referral program is $100 credit each." },
  { category: "sop", minRole: "ADMIN", title: "Do-not-automate guardrails", body: "These always require human approval: client-facing replies, rescheduling Aryeo from a text, discounts/credits/refunds, pricing changes, cancellations, marking deliverables approved without QC, telling a client delivered just because a vendor said ready, and photographer assignment when capability or travel is uncertain. The hub listens, drafts, and creates tasks; humans send." },

  // ---- CREATIVE: craft, prep, delivery, tone ----
  { category: "sop", minRole: "CREATIVE", title: "Turnaround SLAs", body: "Photos, 2D floor plans, virtual staging, 3D/Matterport, and property websites are next business day. Standard video/reel is 48 hours. Premium cinematic/reel is 72 hours (3 to 4 business days). Monthly social content is 3 to 5 business days. Edit requests: photos same-day by 8pm, video next-day." },
  { category: "sop", minRole: "CREATIVE", title: "Property prep checklist (non-negotiable)", body: "All lights on; remove clutter, keys, and remotes; hide trash cans; grills uncovered; beds smooth; driveways clear; frame to minimize neighboring houses. Do a final walkthrough: lights back as found, doors locked and tested, lockbox scrambled, then confirm in Slack." },
  { category: "sop", minRole: "CREATIVE", title: "Editor delivery sequence", body: "Edit, then push the final to Dropbox, run it through Topaz Video AI, upload to Aryeo, and share the link in Slack. Mark the job done only when both the Dropbox final and the Aryeo upload are complete." },
  { category: "comms", minRole: "CREATIVE", title: "Comms style rules", body: "No em dashes (Jordan's top pet peeve), no double dashes, no bold in texts, no emojis to clients. Banned phrases: hidden gem, gem, move the needle, break the mold, deal breaker. Use the language of luxury: investment not price, fully committed not booked, thank you for your patience not sorry. Voice: warm, confident, accountable, solution-first. Acknowledge once, take ownership, give the clear next step, then stop. Use we not I. Offer two scheduling options with exact times." },
  { category: "script", minRole: "CREATIVE", title: "Signature script structure", body: "Hook (under 3s, bold and declarative, not a question), then a Re-Hook/Context beat (~14s) to beat dropoff, a short Middle (story/lifestyle, not MLS specs), and a unique Close (emotional or comment-bait, never click-the-link/schedule-a-tour). Keep lines short and reciteable; agents forget long lines." },
];

async function main() {
  // Replace just the playbook tier (idempotent re-seed).
  await prisma.knowledgeItem.deleteMany({ where: { source: "playbook" } });
  for (const it of ITEMS) {
    await prisma.knowledgeItem.create({
      data: { ...it, source: "playbook", pinned: true, confidence: 5, sourceRef: "operating playbook" },
    });
  }
  const byRole = await prisma.knowledgeItem.groupBy({ by: ["minRole"], _count: { _all: true }, where: { source: "playbook" } });
  console.log(`Seeded ${ITEMS.length} pinned playbook items.`, byRole.map((r) => `${r.minRole}:${r._count._all}`).join("  "));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
