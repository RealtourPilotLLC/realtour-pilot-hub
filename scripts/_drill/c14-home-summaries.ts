// C14: Home summary scope, including capped flags and historical hand-close markers.
// Isolated database only; all financial fixtures and providers stay local.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { isSyntheticClientRow, NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5820) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { getOwnerStats, getOwnerPulse, getOwnerDials, getFlaggedForMe } = await import("@/lib/queries");
    const { ownerPulse } = await import("@/lib/ownerPulse");
    const { handledByPeopleToday, stampHandledByHand } = await import("@/lib/opsDay");
    const { etDayKey } = await import("@/lib/datetime");
    const now = new Date();
    const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Protected TEST" } });
    const scope = { excludeClientIds: (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((x) => x.id) };
    const make = async (clientId: string, title: string, price: number) => {
      const delivered = await prisma.project.create({ data: { clientId, title, status: "DELIVERED", deliveredAt: now, shootDate: ago(24), deliveryDue: new Date(now.getTime() + 3_600_000), price, balanceAmount: price * 100 } });
      const active = await prisma.project.create({ data: { clientId, title: `${title} active`, status: "EDITING", shootDate: ago(24 * 20), price, deliverables: { create: { type: "VIDEO", label: "Property video" } } } });
      await prisma.appointment.create({ data: { aryeoId: `isolated-${clientId}`, projectId: delivered.id, startAt: now } });
      await prisma.editorWorkItem.create({ data: { projectId: active.id, editorKey: "kim", state: "ACTIVE", lastEventAt: now } });
      await prisma.qcRecord.create({ data: { projectId: delivered.id, completedAt: now, itemsChecked: JSON.stringify([{ label: "Verticals & horizontals straight", done: true }, { label: "People / camera in mirrors gone", done: false }]) } });
      const completed = await prisma.smartTask.create({ data: { projectId: delivered.id, taskType: "todo", title: `Handled ${title}`, source: "manual", status: "COMPLETED", completedAt: now } });
      await stampHandledByHand(completed.id, "kyle");
      await prisma.smartTask.create({ data: { projectId: active.id, taskType: "revision", title: `Revision ${title}`, dueAt: ago(48), assignedKey: "kyle", flaggedAt: ago(1), flaggedBy: "James" } });
      await prisma.commLog.createMany({ data: [
        { clientId, channel: "text", direction: "in", body: "Isolated question", occurredAt: ago(2), source: "manual" },
        { clientId, channel: "text", direction: "out", body: "Isolated response", occurredAt: ago(1.5), source: "manual" },
      ] });
      return { delivered, active };
    };
    const realJobs = await make(real.id, "123 TEST Avenue", 100);
    const fixtureJobs = await make(fixture.id, "Fixture job", 900);
    await make(protectedReal.id, "Protected job", 200);
    // A synthetic slow delivery/unanswered text must not distort normal dials.
    await prisma.project.update({ where: { id: fixtureJobs.delivered.id }, data: { shootDate: ago(100), deliveryDue: ago(1) } });
    await prisma.commLog.deleteMany({ where: { clientId: fixture.id, direction: "out" } });
    await prisma.commLog.create({ data: { clientId: real.id, projectId: fixtureJobs.active.id, channel: "text", direction: "in", body: "Synthetic job with real client reference", occurredAt: ago(1), source: "manual" } });
    await prisma.smartTask.createMany({ data: Array.from({ length: 8 }, (_, i) => ({ clientId: fixture.id, taskType: "todo", title: `New fixture flag ${i}`, assignedKey: "kyle", flaggedAt: now, flaggedBy: "James" })) });
    const orphan = await prisma.smartTask.create({ data: { title: "Unlinked office flag", taskType: "revision", assignedKey: "kyle", flaggedAt: ago(1), flaggedBy: "James", dueAt: ago(48) } });
    await prisma.smartTask.create({ data: { title: "Other person's flag", taskType: "todo", assignedKey: "james", flaggedAt: now, flaggedBy: "Kyle" } });
    const directDone = await prisma.smartTask.create({ data: { clientId: fixture.id, title: "Direct fixture completion", taskType: "todo", source: "manual", status: "COMPLETED", completedAt: now } });
    await stampHandledByHand(directDone.id, "kyle");
    await stampHandledByHand("historical-removed-task", "kyle");
    await stampHandledByHand(orphan.id, "kyle");

    const stats = await getOwnerStats(scope);
    c.ok("normal project summaries retain protected identity and real TEST address", stats.deliveredThisMonth === 2 && stats.activeCount === 2 && stats.revenueThisMonth === 300 && stats.pipelineRevenue === 300, JSON.stringify(stats));
    const allStats = await getOwnerStats();
    c.ok("full project summaries still expose fixtures", allStats.deliveredThisMonth === 3 && allStats.activeCount === 3 && allStats.revenueThisMonth === 1200);
    const pulse = await getOwnerPulse(scope);
    c.ok("normal delivery and reply dials exclude both synthetic client and job links", pulse.onTimePct === 100 && pulse.turnaroundH === 24 && pulse.replyPct === 100 && pulse.openRevisions === 3, JSON.stringify(pulse));
    const allPulse = await getOwnerPulse();
    c.ok("full pulse retains synthetic delivery, communication and revision evidence", allPulse.onTimePct === 67 && allPulse.replyPct === 50 && allPulse.openRevisions === 4, JSON.stringify(allPulse));
    const dials = await getOwnerDials(scope);
    c.ok("normal SLA, active editing and QC counts share the project scope", dials.video.inEditing === 2 && dials.video.pastSla === 2 && dials.video.editingNow === 2 && dials.qc.totalPasses === 2 && dials.qc.qcPasses === 2, JSON.stringify(dials));
    const fullDials = await getOwnerDials();
    c.ok("full dials retain test work without starting or pausing it", fullDials.video.editingNow === 3 && fullDials.qc.totalPasses === 3 && await prisma.editorWorkEvent.count() === 0);
    const flags = await getFlaggedForMe({ ...scope, role: "ADMIN", assignedKey: "kyle" });
    c.ok("real personal flags survive synthetic pile before six-row cap", flags.length === 3 && flags.some((f) => f.taskId === orphan.id) && flags.some((f) => f.projectTitle === "123 TEST Avenue active"), JSON.stringify(flags));
    c.ok("full flagged reader retains fixtures and capped result", (await getFlaggedForMe({ role: "ADMIN", assignedKey: "kyle" })).length === 6);
    c.ok("scope never grants an unlinked viewer somebody else's flags", (await getFlaggedForMe({ ...scope, role: "ADMIN" })).length === 0);
    c.ok("handled count deduplicates markers, excludes both fixture links and retains orphan/history", await handledByPeopleToday(scope) === 4 && await handledByPeopleToday() === 6);

    // Dummy local accounting rows prove workload scoping does not change Finance.
    await prisma.stripeTransaction.create({ data: { id: "isolated-charge", type: "charge", gross: 123, fee: 3, net: 120, createdAt: new Date(`${etDayKey(now)}T12:00:00Z`), projectId: fixtureJobs.delivered.id } });
    const item = await prisma.plaidItem.create({ data: { itemId: "isolated-bank", accessTokenEncrypted: "not-a-provider-token" } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "isolated-account", name: "Isolated checking", type: "depository", isBusiness: true, currentBalance: 456 } });
    const money = await ownerPulse(scope);
    const fullMoney = await ownerPulse();
    c.ok("normal operational pulse excludes fixture appointments, deliveries and open tasks", money.shootsThisWeek === 2 && money.deliveredThisMonth === 2 && money.openTasks === 4 && money.overdueTasks === 3, JSON.stringify(money));
    c.ok("full operational pulse retains all fixture work", fullMoney.shootsThisWeek === 3 && fullMoney.deliveredThisMonth === 3 && fullMoney.openTasks === 13);
    c.ok("bank, revenue and AR keep Finance's existing definitions", money.revenueMonth === 123 && money.bankBalance === 456 && money.owedToYou === 1200 && money.owedCount === 3 && money.profitMonth === fullMoney.profitMonth && money.revenueYtd === fullMoney.revenueYtd && money.owedToYou === fullMoney.owedToYou, JSON.stringify(money));

    // Scope delivery candidates, never the neighboring activity used to identify
    // a board-clearing pass; otherwise the two test moves would hide its origin.
    for (const projectId of [realJobs.delivered.id, fixtureJobs.active.id, fixtureJobs.delivered.id]) {
      await prisma.activity.create({ data: { projectId, type: "STATUS_CHANGE", body: "Moved from Review to Delivered.", createdAt: now } });
    }
    const catchup = await getOwnerPulse(scope);
    c.ok("normal delivery dial preserves catch-up context across excluded jobs", catchup.backfillExcluded === 1 && catchup.onTimeBasis.startsWith("1 of 1"), JSON.stringify(catchup));
    c.ok("provider fence stayed closed and no communication was queued", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
