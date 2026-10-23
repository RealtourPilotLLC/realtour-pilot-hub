// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, photo audit H3).
//
// PhotoJob.deliveredAt recorded when the hub NOTICED the delivery (the
// project's date, or "now" on a later check), and every re-check overwrote it:
//   · 859 N Lawrence St: out Oct 21 ~1:45 PM ET, recorded Oct 22 7:58 AM;
//   · 615 Cliff Ln: the new visit out ~11:38 AM ET Oct 22, recorded 5:48 PM
//     (the sync's false "delivered again" after the client's revision).
// The code now keeps the FIRST delivery and records re-deliveries as their
// own job events. This corrects the jobs whose first delivery can be PROVED:
// the hub's own push run (its deliveredAt) or Aryeo's LISTING_DELIVERED
// webhook (its occurred_at), the earliest since the job's current round
// began (delivery.roundStartOf) and no later than what is recorded. A job
// with no such proof is left as it is (listed). Only deliveredAt changes (and
// one job event saying from what to what). Nothing is sent.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-photo-audit-h3-delivered-at.ts
// Write it:
//   … scripts/_live/oct22-photo-audit-h3-delivered-at.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const et = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "-");
const TOLERANCE_MS = 5 * 60_000;

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PHOTO_DELIVERY_EPOCH } = await import("@/lib/photoDelivery/jobs");
  const { listingDeliveredHooks, roundStartOf } = await import("@/lib/photoDelivery/delivery");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: photo jobs' first delivery, proved from push runs and Aryeo's webhooks\n`);
  const jobs = await prisma.photoJob.findMany({
    where: { deliveredAt: { not: null }, createdAt: { gte: PHOTO_DELIVERY_EPOCH } },
    orderBy: { deliveredAt: "asc" },
    select: { id: true, projectId: true, stage: true, deliveredAt: true, createdAt: true, slaDueAt: true },
  });
  const projects = new Map((await prisma.project.findMany({ where: { id: { in: jobs.map((j) => j.projectId) } }, select: { id: true, title: true, aryeoListingId: true } })).map((p) => [p.id, p]));
  const runs = new Map((await prisma.appSetting.findMany({ where: { key: { in: jobs.map((j) => `photo_aryeo_push:${j.id}`) } }, select: { key: true, value: true } })).map((r) => [r.key.slice("photo_aryeo_push:".length), r.value]));
  const fixes: { jobId: string; from: Date; to: Date; source: string; title: string }[] = [];
  let unproved = 0;
  for (const j of jobs) {
    const p = projects.get(j.projectId);
    const title = (p?.title ?? "?").split(",")[0];
    const since = await roundStartOf(j.id, j.createdAt);
    const until = j.deliveredAt!;
    const proofs: { at: Date; source: string }[] = [];
    try {
      const d = runs.get(j.id) ? (JSON.parse(runs.get(j.id)!) as { deliveredAt?: string | null }).deliveredAt : null;
      const at = d ? Date.parse(d) : NaN;
      if (Number.isFinite(at) && at >= since.getTime() && at <= until.getTime() + TOLERANCE_MS) proofs.push({ at: new Date(at), source: "the hub's push run" });
    } catch { /* no run */ }
    if (p?.aryeoListingId) {
      const hooks = await listingDeliveredHooks(p.aryeoListingId, since, new Date(until.getTime() + TOLERANCE_MS));
      if (hooks[0]) proofs.push({ at: hooks[0], source: `Aryeo's LISTING_DELIVERED (${hooks.length} since the round began: ${hooks.map(et).join(", ")})` });
    }
    const first = proofs.sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    if (!first) {
      unproved++;
      console.log(`  ${title.padEnd(32)} ${j.stage.padEnd(18)} recorded ${et(j.deliveredAt)}: no push run or webhook proof, left as it is`);
      continue;
    }
    const off = Math.abs(first.at.getTime() - until.getTime());
    const onTime = (d: Date) => (j.slaDueAt ? (d <= j.slaDueAt ? "on time" : "late") : "no deadline");
    if (off <= TOLERANCE_MS) {
      console.log(`  ${title.padEnd(32)} ${j.stage.padEnd(18)} recorded ${et(j.deliveredAt)}: matches ${first.source.split(" (")[0]} (${et(first.at)}), nothing to do`);
      continue;
    }
    fixes.push({ jobId: j.id, from: until, to: first.at, source: first.source, title });
    console.log(`* ${title.padEnd(32)} ${j.stage.padEnd(18)} recorded ${et(j.deliveredAt)} (${onTime(until)}) -> ${et(first.at)} (${onTime(first.at)}), from ${first.source}; deadline ${et(j.slaDueAt)}`);
  }
  console.log(`\n${jobs.length} delivered photo jobs since the epoch: ${fixes.length} to correct, ${unproved} with no proof (left), the rest already right.`);
  if (!APPLY) return prisma.$disconnect();
  const { logJobEvent } = await import("@/lib/photoDelivery/jobState");
  for (const f of fixes) {
    const r = await prisma.photoJob.updateMany({ where: { id: f.jobId, deliveredAt: f.from }, data: { deliveredAt: f.to } });
    if (r.count) await logJobEvent(f.jobId, "photo audit H3", `delivery date corrected: ${f.from.toISOString()} (when the hub noticed) -> ${f.to.toISOString()} (${f.source.split(" (")[0]})`, { from: f.from.toISOString(), to: f.to.toISOString() });
    console.log(`${f.title}: ${r.count ? "corrected" : "changed meanwhile, left"}`);
  }
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
