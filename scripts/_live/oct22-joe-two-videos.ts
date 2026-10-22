// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026): 538 Onward Ave owes TWO videos.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-joe-two-videos.ts           # dry run
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-joe-two-videos.ts --apply   # writes
//   optional: --stamp-standard-due   also date the standard reel on its own
//             standard turnaround (see THE DUE DATES below)
//
// Jordan: "Joe's appointment yesterday had two videos. A standard highlight
// reel, and a Premium reel. Fix that." and, corrected: "Joe's had the premium
// reel but didn't have the standard highlight reel."
//
// WHY: Aryeo order #1709 sells "Social Influencer" (the package whose reel is
// the PREMIUM reel) AND "Standard Video Highlight Reel" on its own line. Both
// map to SOCIAL_REEL, and the order mapping collapsed one row per type, so the
// standard reel was never set up. The mapping now keeps every main video
// product (aryeo.dedupeParsedDeliverables); this script runs THE APP'S OWN
// reconcile (reconcileDeliverablesToOrder) on this one job so the standard reel
// is set up now rather than at the next sync, then makes its per-video row
// (ensureOutputsForProject). The premium row keeps its id, its label, its
// instructions and anything already uploaded against it: matchRowsToWants
// pairs it with its own line by product title first.
//
// THE DUE DATES: the job carries the office's date (Oct 24, set by Jordan on
// Oct 21, before anyone knew of the second video), and the office's date wins
// for every video on a job. --stamp-standard-due dates the standard reel on its
// own standard turnaround instead (DeliverableOutput.promisedAt), which is
// Jordan's call to make: it puts a near deadline on a video the hub only now
// set up.
//
// Dry run by default: the connection is opened READ-ONLY unless --apply is
// given, so a dry run cannot write even by mistake. No Aryeo write anywhere;
// the order is read with one GET.
// ---------------------------------------------------------------------------
export {};

const PROJECT_ID = "cmv8imvz10007l40697tgc80c";
const ORDER_ID = "01a13b34-66e7-7116-af82-0ef4e7558ea1";
const APPLY = process.argv.includes("--apply");
const STAMP_DUE = process.argv.includes("--stamp-standard-due");

if (!APPLY) {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set: source the .env first.");
  if (!/default_transaction_read_only/.test(url)) {
    process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
  }
}

const et = (d: Date | null | undefined) =>
  d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "none";

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const aryeo = await import("@/lib/integrations/aryeo");
  const { cutSlots } = await import("@/lib/reviewCuts");
  const { getVideoSlaStatus, videoTier } = await import("@/lib/projectStatus");
  const { videoSetupGapFor } = await import("@/lib/videoSetup");
  const dout = await import("@/lib/deliverableOutputs");
  await aryeo.loadManualProductMap(true);

  console.log(`=== 538 Onward Ave (${PROJECT_ID}) · ${APPLY ? "APPLY" : "DRY RUN (read-only connection)"} ===\n`);
  const project = await prisma.project.findUnique({
    where: { id: PROJECT_ID },
    select: {
      title: true, status: true, shootDate: true, dueOverrideAt: true, overrideBy: true, overrideAt: true, videosOwedOverride: true, tierOverride: true,
      videoInstructions: true, aryeoOrderId: true, packageName: true,
      appointments: { select: { status: true, startAt: true } },
      deliverables: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, projectId: true, type: true, label: true, quantity: true, status: true, manual: true, removedFromOrderAt: true, uploadedAt: true, productTitle: true, videoStyle: true, createdAt: true, waivedAt: true },
      },
    },
  });
  if (!project) throw new Error("project not found");
  if (project.aryeoOrderId !== ORDER_ID) throw new Error(`order mismatch: ${project.aryeoOrderId}`);
  if (["DELIVERED", "CANCELLED"].includes(project.status)) throw new Error(`job is ${project.status}: not touched`);
  console.log(`status ${project.status} · shot ${et(project.shootDate)} · office due ${et(project.dueOverrideAt)} (set by ${project.overrideBy ?? "?"} ${et(project.overrideAt)}) · videosOwedOverride ${project.videosOwedOverride ?? "none"} · tierOverride ${project.tierOverride ?? "none"}`);

  // 1. The order, read live (GET only).
  const order = await aryeo.Aryeo.order(ORDER_ID);
  console.log(`\nAryeo order #${order.number}: ${(order.items ?? []).length} lines`);
  for (const it of order.items ?? []) {
    const rows = aryeo.itemToDeliverables(it).map((d) => `${d.type}${d.videoStyle ? `/${d.videoStyle}` : ""}`).join(", ");
    console.log(`  · ${it.title} ×${it.quantity ?? 1}${it.is_canceled ? " (canceled)" : ""} -> ${rows || "nothing"}`);
  }
  const parsed = aryeo.orderDeliverables(order.items);
  console.log(`order owes (new mapping): ${parsed.map((d) => `${d.type} "${d.label}"${d.quantity > 1 ? ` ×${d.quantity}` : ""}`).join(" · ")}`);
  console.log(`videos the order sells: ${aryeo.orderedVideoCount(parsed)}`);

  // 2. Rows today, and any cuts already on them.
  const cuts = await prisma.reviewSubmission.groupBy({ by: ["deliverableId"], where: { projectId: PROJECT_ID }, _count: { _all: true } });
  const cutsOf = new Map(cuts.map((c) => [c.deliverableId, c._count._all]));
  const outputs = await prisma.deliverableOutput.findMany({ where: { projectId: PROJECT_ID }, select: { id: true, deliverableId: true, slot: true, filmingNote: true, promisedAt: true, removedFromOrderAt: true } });
  console.log(`\nrows today:`);
  for (const d of project.deliverables) {
    console.log(`  · ${d.id} ${d.type} "${d.label}" ×${d.quantity} ${d.status}${d.removedFromOrderAt ? " RETIRED" : ""}${d.manual ? " manual" : ""} · cuts ${cutsOf.get(d.id) ?? 0} · video rows ${outputs.filter((o) => o.deliverableId === d.id).length}`);
  }
  const gapBefore = await videoSetupGapFor(PROJECT_ID);
  console.log(`guard today: ${gapBefore ? gapBefore.words : "no gap"}`);

  // 3. The plan: the reconcile's own pairing.
  const answerable = project.deliverables.filter((r) => !r.manual && !/added manually/i.test(r.label ?? ""));
  const plan = aryeo.matchRowsToWants(answerable, parsed);
  console.log(`\nplan (reconcileDeliverablesToOrder's pairing):`);
  for (const { row, want } of plan.pairs) {
    const change = (row.label ?? "") !== want.label || (row.productTitle ?? null) !== want.productTitle || (row.videoStyle ?? null) !== want.videoStyle;
    console.log(`  keep ${row.id} ${row.type} "${row.label}" <- "${want.productTitle}"${change ? ` (relabel to "${want.label}" ${want.videoStyle ?? ""})` : " (unchanged)"}${cutsOf.get(row.id) ? ` · its ${cutsOf.get(row.id)} cut(s) stay on it` : ""}`);
  }
  for (const w of plan.unmatchedWants) console.log(`  CREATE ${w.type} "${w.label}" ×${w.quantity} · product "${w.productTitle}" · style ${w.videoStyle}`);
  for (const r of plan.unmatchedRows) console.log(`  retire ${r.id} ${r.type} "${r.label}"${r.removedFromOrderAt ? " (already retired)" : ""}`);

  // 4. The videos the job will owe, and their dates.
  const premiumRow = project.deliverables.find((d) => d.type === "SOCIAL_REEL" && !d.removedFromOrderAt);
  const standardWant = plan.unmatchedWants.find((w) => w.type === "SOCIAL_REEL") ?? null;
  const jobSla = getVideoSlaStatus({ shootDate: project.shootDate, status: project.status, deliverables: project.deliverables, appointments: project.appointments, packageName: project.packageName });
  const stdSla = standardWant
    ? getVideoSlaStatus({ shootDate: project.shootDate, status: project.status, deliverables: [{ type: standardWant.type, label: standardWant.label }], appointments: project.appointments, packageName: null })
    : null;
  console.log(`\nvideos after:`);
  console.log(`  1. ${premiumRow?.label ?? "?"} · ${videoTier(premiumRow ? [premiumRow] : [])} · due ${et(project.dueOverrideAt ?? jobSla?.due)} (${project.dueOverrideAt ? "the office's date" : "premium turnaround"}) · instructions: the job's existing ones (${(project.videoInstructions ?? "").split("\n")[0]} …)`);
  if (standardWant) {
    console.log(`  2. ${standardWant.label} · ${videoTier([{ type: standardWant.type, label: standardWant.label }])} · due ${STAMP_DUE ? `${et(stdSla?.due)} (its own standard turnaround, stamped)` : `${et(project.dueOverrideAt)} (the office's date for the job; its own standard turnaround would be ${et(stdSla?.due)}, pass --stamp-standard-due to use it)`} · instructions: none yet; its own area shows on the upload page`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN: nothing written. Re-run with --apply to set up the standard reel.`);
    await prisma.$disconnect();
    return;
  }

  // 5. APPLY: the app's own reconcile, then the per-video rows.
  const res = await aryeo.reconcileDeliverablesToOrder(PROJECT_ID, order);
  console.log(`\nreconcile: ${JSON.stringify(res)}`);
  const ensured = await dout.ensureOutputsForProject(PROJECT_ID);
  console.log(`video rows: ${JSON.stringify({ created: ensured.created, retired: ensured.retired, slots: ensured.slotKeys })}`);
  if (STAMP_DUE && stdSla) {
    const rows = await dout.videoInstructionsFor(PROJECT_ID);
    const std = rows.find((r) => r.number > 1 && r.style === "standard_reel");
    if (std?.outputId) {
      await prisma.deliverableOutput.update({ where: { id: std.outputId }, data: { promisedAt: stdSla.due, promiseSource: "standard-turnaround", promiseAnchorAt: project.shootDate } });
      console.log(`stamped ${std.label} due ${et(stdSla.due)}`);
    }
  }
  await prisma.activity.create({
    data: {
      projectId: PROJECT_ID, type: "SYSTEM",
      body: "This job owes two videos: the premium reel (Social Influencer) and the Standard Video Highlight Reel, which the hub had not set up. The standard reel now has its own editor slot, due date and instructions area (Jordan, Oct 22 2026).",
    },
  });
  const slots = await cutSlots(PROJECT_ID);
  console.log(`cut slots now: ${slots.map((s) => `${s.label} [${s.deliverableId}:${s.slot}]`).join(" · ")}`);
  const gapAfter = await videoSetupGapFor(PROJECT_ID);
  console.log(`guard now: ${gapAfter ? gapAfter.words : "no gap"}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
