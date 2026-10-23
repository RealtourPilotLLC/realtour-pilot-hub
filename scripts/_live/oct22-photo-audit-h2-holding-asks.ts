// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, photo audit H2).
//
// closeAsksOnDeliveredJobs (clientAsks.ts) marked asks that HOLD delivery as
// Done by itself once the job or its photos read as delivered: a delivery
// done in Aryeo past the hub's checklist, or Aryeo's sticky "delivered" read
// as a client's revision being sent again (615 Cliff Ln's lamp, 5:48 PM).
// The sweep now leaves those open for a person. This lists every holding ask
// the hub closed that way in the last 14 days, beside every holding ask closed
// in those 14 days, and proposes, one by one:
//   REOPEN              asked before the photos went out; nobody confirmed it
//                       was done on the delivered photos;
//   REOPEN (confirm)    a revision asked after delivery; the listing WAS
//                       delivered again after it (Aryeo's notice), so it may
//                       be done: Kyle confirms or answers it;
//   REOPEN + REVISION   a revision asked after delivery and nothing was
//                       delivered after it: the hub's sticky read closed it;
//                       the photo job goes back to Revision too;
//   LEAVE               a cancelled job (closed because the job was cancelled).
// --apply reopens what is proposed (clientAsks.reopenAsk, "photo audit H2") and
// moves the REOPEN + REVISION photo jobs back (DELIVERED → REVISION_REQUESTED).
// Nothing is sent to anyone.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-photo-audit-h2-holding-asks.ts
// Write it:
//   … scripts/_live/oct22-photo-audit-h2-holding-asks.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
// --skip=<askId>[,<askId>]: leave these closed (Oct 22: 615 Cliff Ln's order note is scope, not a request).
const SKIP = new Set((process.argv.find((a) => a.startsWith("--skip=")) ?? "").slice(7).split(",").filter(Boolean));
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const DAYS = 14;
const DELIVERY_REASONS = ["the job was delivered", "the photos were delivered"];
const one = (s: string | null | undefined, n = 90) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const et = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "-");

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { listingDeliveredHooks } = await import("@/lib/photoDelivery/delivery");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: holding asks closed in the last ${DAYS} days\n`);
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const closed = await prisma.clientAsk.findMany({
    where: { holdsDelivery: true, state: { in: ["DONE", "CONFIRMED", "NOT_NEEDED"] }, OR: [{ doneAt: { gte: since } }, { confirmedAt: { gte: since } }] },
    orderBy: { askedAt: "asc" },
    select: { id: true, projectId: true, state: true, doneBy: true, confirmedBy: true, doneAt: true, confirmedAt: true, confirmNote: true, summary: true, text: true, askedAt: true, medium: true, source: true, kind: true },
  });
  const byHub = closed.filter((a) => a.state === "DONE" && a.doneBy === "Hub" && DELIVERY_REASONS.includes(a.confirmNote ?? ""));
  const byHubCancel = closed.filter((a) => a.state === "DONE" && a.doneBy === "Hub" && a.confirmNote === "the job was cancelled");
  console.log(`holding asks closed in ${DAYS} days: ${closed.length}; closed by the hub on a delivery: ${byHub.length}; on a cancellation: ${byHubCancel.length}; by a person or a change of words: ${closed.length - byHub.length - byHubCancel.length}\n`);

  type Plan = { id: string; action: "REOPEN" | "REOPEN (confirm)" | "REOPEN + REVISION" | "LEAVE"; jobId: string | null; why: string };
  const plans: Plan[] = [];
  for (const a of [...byHub, ...byHubCancel]) {
    const p = a.projectId ? await prisma.project.findUnique({ where: { id: a.projectId }, select: { title: true, status: true, aryeoListingId: true } }) : null;
    const job = a.projectId ? await prisma.photoJob.findUnique({ where: { projectId: a.projectId }, select: { id: true, stage: true, deliveredAt: true } }) : null;
    // When the photos first went out: the job's first move to Delivering/Delivered (events), else its deliveredAt.
    const firstOut = job
      ? (await prisma.photoJobEvent.findFirst({ where: { jobId: job.id, OR: [{ action: { contains: "→ DELIVERING" } }, { action: { contains: "→ DELIVERED" } }] }, orderBy: { at: "asc" }, select: { at: true } }))?.at ?? job.deliveredAt
      : null;
    const hooksAfter = p?.aryeoListingId ? await listingDeliveredHooks(p.aryeoListingId, a.askedAt, a.doneAt ?? new Date()) : [];
    const revision = !!firstOut && a.askedAt > firstOut;
    let plan: Plan;
    if (SKIP.has(a.id)) plan = { id: a.id, action: "LEAVE", jobId: null, why: "left closed by hand (--skip)" };
    else if (a.confirmNote === "the job was cancelled" || p?.status === "CANCELLED") plan = { id: a.id, action: "LEAVE", jobId: null, why: "the job was cancelled" };
    else if (!revision) plan = { id: a.id, action: "REOPEN", jobId: null, why: `asked ${et(a.askedAt)}, before the photos went out (${et(firstOut)}); delivered past it, nobody confirmed it` };
    else if (hooksAfter.length) plan = { id: a.id, action: "REOPEN (confirm)", jobId: null, why: `a revision asked ${et(a.askedAt)}; the listing was delivered again after it (${hooksAfter.map((d) => et(d)).join(", ")}): maybe done, Kyle confirms or answers` };
    else plan = { id: a.id, action: "REOPEN + REVISION", jobId: job && job.stage === "DELIVERED" ? job.id : null, why: `a revision asked ${et(a.askedAt)}; nothing was delivered after it: the hub's sticky read closed it${job && job.stage === "DELIVERED" ? "; the photo job goes back to Revision" : ""}` };
    plans.push(plan);
    console.log(`${plan.action.padEnd(18)} ${a.id}  ${one(p?.title, 34).padEnd(34)}  [${a.source}/${a.medium}] "${one(a.summary || a.text, 70)}"`);
    console.log(`${"".padEnd(18)} closed ${et(a.doneAt)} ("${a.confirmNote}"); photo job ${job?.stage ?? "none"}; ${plan.why}`);
  }
  const reopen = plans.filter((p) => p.action !== "LEAVE");
  console.log(`\nProposed: reopen ${reopen.length} (${plans.filter((p) => p.action === "REOPEN").length} plain, ${plans.filter((p) => p.action === "REOPEN (confirm)").length} to confirm, ${plans.filter((p) => p.action === "REOPEN + REVISION").length} with the photo job back to Revision); leave ${plans.length - reopen.length}.`);
  if (!APPLY) return prisma.$disconnect();

  const { reopenAsk } = await import("@/lib/clientAsks");
  const { setStage } = await import("@/lib/photoDelivery/jobState");
  for (const p of reopen) {
    const r = await reopenAsk(p.id, "photo audit H2 (Oct 22 2026): closed by the hub, not a person");
    console.log(`reopened ${p.id}: ${r.message}`);
    if (p.jobId) {
      const moved = await setStage(p.jobId, ["DELIVERED"], "REVISION_REQUESTED", "photo audit H2", { why: "the client's revision was closed by Aryeo's old 'delivered', not sent again", extra: { nextCheckAt: new Date() } });
      console.log(`  photo job ${p.jobId} back to Revision: ${moved}`);
    }
  }
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
