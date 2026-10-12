// Oct 12 2026 (Jordan): "Automatic Booking should be allowed. We did it with a
// test account and it worked." Gives every ACTIVE real program client the
// "bookings" group only (hub_writes: book filming + address in Aryeo, and the
// strategy call in Calendly) — the same per-client write Settings → Client
// onboarding makes (programRolloutCore.setClientOpsChange through
// updateProgramRollout, audited). Nothing else (emails, invites, sign-in emails,
// auto portal changes) is allowed. Aryeo writes always go with customer
// notifications off.
import { prisma } from "../../../src/lib/prisma";
const BY = "info@realtourpilot.com";
(async () => {
  const { updateProgramRollout, loadProgramRollout } = await import("../../../src/lib/programRollout");
  const core = await import("../../../src/lib/programRolloutCore");
  const es = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { clientId: true } });
  const clients = await prisma.client.findMany({ where: { id: { in: es.map((e) => e.clientId) } }, select: { id: true, name: true } });
  for (const c of clients) {
    if (core.pilotCandidateProblem(c)) { console.log("skip", c.name, "-", core.pilotCandidateProblem(c)); continue; }
    const r = await updateProgramRollout((cur, now) => {
      const had = cur.pilot && cur.pilot.clientIds.includes(c.id) ? core.pilotOpsFor(cur.pilot, c.id) : [];
      const ops = [...new Set([...had, "hub_writes" as const])];
      return core.setClientOpsChange(cur, { client: c, ops, by: BY, now });
    }, BY, "program_rollout_client_ops");
    console.log(c.name, r.ok ? "→ bookings allowed" : "FAILED: " + r.message);
  }
  const { rollout } = await loadProgramRollout();
  console.log("mode:", rollout.mode, "| named:", rollout.pilot?.clientIds.length, "| ops per client:", JSON.stringify(Object.values(rollout.pilot?.clientOps ?? {}).map((o) => o.join("+"))));
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
