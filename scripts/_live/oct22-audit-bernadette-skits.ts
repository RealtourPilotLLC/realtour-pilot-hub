export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, content audit M3): queue a skit-only topic refresh
// for Bernadette Rabel (Mix, 2 skits a month), who has no unscripted skit
// ideas. Today's refreshes ran before her account was set to Mix and every
// pillar is at 15, so the per-pillar refill would not run for about a week.
//
// It QUEUES the run (contentTopics.queueSkitRefreshIfShort, the same call the
// sweep now makes); the 15-minute AI job then runs it behind `topic_refresh`
// and `ai_runs`, and that spends API. Jordan runs --apply himself.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-bernadette-skits.ts           # dry run (read-only)
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-bernadette-skits.ts --apply   # queues the refresh
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

async function main() {
  const prisma = await db();
  const client = await prisma.client.findFirst({ where: { name: { contains: "Bernadette" } }, select: { id: true, name: true } });
  if (!client) throw new Error("Bernadette Rabel not found");
  const e = await prisma.contentEnrollment.findFirst({ where: { clientId: client.id }, select: { id: true, status: true, overridesJson: true } });
  if (!e) throw new Error("No enrollment for Bernadette Rabel");
  const { skitShortfall, queueSkitRefreshIfShort, SKIT_REFILL_COOLDOWN_MS } = await import("../../src/lib/contentTopics");
  const { videoStyleFromOverrides } = await import("../../src/lib/contentPolicy/videoFormat");
  const s = await skitShortfall(e.id);
  console.log(`${client.name} · enrollment ${e.id} · ${e.status} · style ${videoStyleFromOverrides(e.overridesJson)}`);
  if (!s) { console.log("not a Mix account: nothing to queue"); process.exit(0); }
  console.log(`skits a month ${s.skitsPerMonth} · target ${s.target} unscripted skit ideas · on file ${s.unscripted} · short ${s.need}`);
  const runs = await prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId: e.id, inputsJson: { contains: '"skitsOnly":true' } }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true, createdAt: true } });
  console.log(`skit-only runs on file: ${runs.length ? runs.map((r) => `${r.id} ${r.status} ${r.createdAt.toISOString()}`).join("; ") : "none"}`);
  const busy = runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING" || Date.now() - r.createdAt.getTime() < SKIT_REFILL_COOLDOWN_MS);
  if (s.need <= 0) { console.log("no shortfall: nothing to queue"); process.exit(0); }
  console.log(busy ? "a skit refresh is queued, running or tried in the last day: --apply would join it, not queue another" : `--apply would queue one REFRESH run, skit concepts only, keep ${s.need}, requested by staff:oct22-audit-m3`);
  if (!APPLY) process.exit(0);
  const r = await queueSkitRefreshIfShort(e.id, { requestedBy: "staff:oct22-audit-m3" });
  console.log(JSON.stringify(r));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
