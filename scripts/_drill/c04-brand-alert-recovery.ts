// Isolated C04 replay: process loss after claim, after the task committed, and
// during catch-up. No provider or production connection is available.
import { bootDrillDb, installNextStubs, makeChecker, fenceFetch } from "./_harness";

installNextStubs();

async function main() {
  const drill = await bootDrillDb({ port: 5582 });
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { sweepBrandChangeAlerts } = await import("@/lib/brandProfile");
    const client = await prisma.client.create({ data: { name: "C04 Recovery Client" }, select: { id: true } });
    const at = new Date();
    const later = new Date(at.getTime() + 10 * 60_000);
    const change = (fieldKey: string, channel: string | null, claim: string, taskId?: string) =>
      prisma.clientBrandChange.create({ data: {
        clientId: client.id, fieldKey, label: fieldKey, kind: "SET", toText: fieldKey,
        source: "staff", alertedAt: at, alertClaim: claim, alertChannel: channel, taskId,
      } });

    const first = await change("first", "preparing", "c04-after-claim");
    await sweepBrandChangeAlerts({ now: later });
    const recovered = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: first.id } });
    c.ok("after claim: sweep creates the confirmation task and settles the row", !!recovered.taskId && recovered.alertChannel === "no_editor");
    const taskId = recovered.taskId!;
    const task = await prisma.smartTask.findUniqueOrThrow({ where: { id: taskId } });
    c.ok("task does not assert an unverified Slack delivery", !/messaged on Slack|also messaged/i.test(task.description ?? ""));

    const second = await change("second", "preparing", "c04-after-task", taskId);
    const before = await prisma.smartTask.findUniqueOrThrow({ where: { id: taskId } });
    await sweepBrandChangeAlerts({ now: later });
    const after = await prisma.smartTask.findUniqueOrThrow({ where: { id: taskId } });
    c.ok("after task: retry keeps one open task and does not append duplicate text",
      (await prisma.smartTask.count({ where: { clientId: client.id, status: "OPEN" } })) === 1 && after.description === before.description);
    c.ok("after task: same task link and settled result", (await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: second.id } })).taskId === taskId);

    await prisma.programAutomation.create({ data: { key: "brand_change_alerts", enabled: true, enabledBy: "drill", enabledAt: at } });
    const third = await change("third", "sending", "2026093012:c04-catchup", taskId);
    await sweepBrandChangeAlerts({ now: later });
    c.ok("during catch-up: expired sending lease recovers", (await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: third.id } })).alertChannel === "no_editor");

    const fourth = await change("fourth", null, "c04-legacy-claim");
    await sweepBrandChangeAlerts({ now: later });
    const legacy = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: fourth.id } });
    c.ok("old interrupted claim: task recovers and delivery remains explicitly unknown", legacy.taskId === taskId && legacy.alertChannel === "delivery_unknown");
    const settled = await sweepBrandChangeAlerts({ now: later });
    c.ok("repeat sweep: no additional work or message", settled.rows === 0 && settled.caughtUp === 0 && (await prisma.smartTask.count({ where: { clientId: client.id, status: "OPEN" } })) === 1);
    c.ok("all outbound providers fenced", fence.blocked.length === 0);
    c.summary();
  } finally {
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
