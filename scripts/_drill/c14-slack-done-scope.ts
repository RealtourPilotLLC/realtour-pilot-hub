// C14: normal Slack/Done lists, badges and recap inputs use the same scope.
// Disposable database; the recap model is replaced at its boundary.
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { isSyntheticClientRow, NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
let recap = "";

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5817), env: { AUTH_ENFORCE: "true", APP_SECRET: "c14-history-isolated-secret" } });
  const fence = fenceFetch(async (url, init) => {
    if (url !== "https://api.anthropic.com/v1/messages" || init?.method !== "POST") return null;
    const request = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    recap = request.messages[0].content;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Isolated recap" }] }), { status: 200 });
  });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { slackBoard, slackOpenCount } = await import("@/lib/commsBoard");
    const { doneTodayCount, closedWithoutDoing } = await import("@/lib/taskHistory");
    const { getTaskHistory, getShootHistory, getDeliveryHistory } = await import("@/lib/queries");
    const { summarizeDay } = await import("@/app/history/actions");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("ai", "isolated-fake-recap-key");
    const { etDayKey } = await import("@/lib/datetime");
    const now = new Date();
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Protected TEST" } });
    const project = async (clientId: string, title: string) => prisma.project.create({ data: { clientId, title, status: "DELIVERED", deliveredAt: now } });
    const realJob = await project(real.id, "123 TEST Avenue");
    const fixtureJob = await project(fixture.id, "Fixture job");
    const protectedJob = await project(protectedReal.id, "Protected job");
    const scope = { excludeClientIds: (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((x) => x.id) };
    await prisma.smartTask.createMany({ data: Array.from({ length: 65 }, (_, i) => ({ projectId: fixtureJob.id, title: `Fixture Slack ${i}`, source: "slack", taskType: "todo", createdAt: new Date(now.getTime() - 86_400_000) })) });
    for (const p of [realJob, protectedJob]) await prisma.smartTask.create({ data: { projectId: p.id, title: `Slack ${p.title}`, source: "slack", taskType: "todo" } });
    const orphan = await prisma.smartTask.create({ data: { title: "Unlinked office ask", source: "slack", taskType: "todo" } });
    const focused = await prisma.smartTask.create({ data: { clientId: fixture.id, title: "Linked fixture ask", source: "slack", taskType: "todo" } });
    const board = await slackBoard(now, scope);
    c.ok("normal Slack retains real TEST addresses, protected identity and unlinked work before cap", board.total === 3 && board.rows.length === 3 && board.rows.some((r) => r.taskId === orphan.id) && await slackOpenCount(scope) === board.total);
    const full = await slackBoard(now);
    c.ok("explicit full Slack reader retains all fixture work and truthful cap", full.total === 69 && full.rows.length === 60 && full.capped);
    const linked = await slackBoard(now, { ...scope, focusTaskId: focused.id });
    c.ok("explicit Slack link remains reachable without changing normal badge scope", linked.rows.some((r) => r.taskId === focused.id) && linked.total === 4 && await slackOpenCount(scope) === 3);
    const cappedLink = await slackBoard(now, { focusTaskId: focused.id });
    c.ok("a newer linked ask remains visible beyond the oldest page cap", cappedLink.rows.some((r) => r.taskId === focused.id) && cappedLink.rows.length === 61 && cappedLink.total === 69, JSON.stringify({ total: cappedLink.total, rows: cappedLink.rows.length }));
    await prisma.smartTask.update({ where: { id: focused.id }, data: { status: "CANCELLED" } });
    c.ok("a link cannot reopen cancelled Slack work", !(await slackBoard(now, { ...scope, focusTaskId: focused.id })).rows.some((r) => r.taskId === focused.id));

    for (const p of [realJob, fixtureJob, protectedJob]) {
      await prisma.smartTask.create({ data: { projectId: p.id, title: `Completed ${p.title}`, taskType: "todo", status: "COMPLETED", completedAt: now } });
      await prisma.appointment.create({ data: { aryeoId: `fixture-${p.id}`, projectId: p.id, startAt: now, status: "SCHEDULED" } });
    }
    await prisma.smartTask.create({ data: { title: "Completed unlinked office work", taskType: "todo", status: "COMPLETED", completedAt: now } });
    const closed = await prisma.smartTask.create({ data: { projectId: realJob.id, title: "Not needed real task", taskType: "todo", status: "CANCELLED", summary: "Dismissed by Kyle — not needed", updatedAt: new Date(now.getTime() - 60_000) } });
    await prisma.smartTask.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ clientId: fixture.id, title: `Closed fixture ${i}`, taskType: "todo", status: "CANCELLED", updatedAt: now })) });
    const done = await getTaskHistory(45, scope);
    c.ok("Done badge and completed history match, preserving orphan and protected work", done.length === 3 && await doneTodayCount(scope) === done.length && !done.some((r) => r.title.includes("Fixture job")));
    const closures = await closedWithoutDoing(45, scope);
    c.ok("cancelled real task survives fixture cap and remains separate from completed output", closures.length === 1 && closures[0].id === closed.id && closures[0].byHand && !done.some((r) => r.id === closed.id));
    c.ok("normal delivery and shoot history exclude fixture identities", (await getDeliveryHistory(45, scope)).length === 2 && (await getShootHistory(45, scope)).length === 2);
    c.ok("default history readers retain full records", (await getTaskHistory()).length === 4 && await doneTodayCount() === 4 && (await getDeliveryHistory()).length === 3 && (await getShootHistory()).length === 3 && (await closedWithoutDoing(45)).length === 200);
    const kyle = await prisma.appUser.create({ data: { name: "Kyle", email: "c14-recap@example.test", role: "ADMIN", status: "ACTIVE" } });
    await setSession({ uid: kyle.id, email: kyle.email, role: kyle.role });
    const summary = await summarizeDay(etDayKey(now));
    const normalInput = recap;
    c.ok("signed normal recap receives the same real completed rows", summary.ok && normalInput.includes("Completed tasks (3):") && normalInput.includes("Delivered (2):") && normalInput.includes("Shoots (2):") && !normalInput.includes("Fixture job"), JSON.stringify({ summary, normalInput }));
    const testSummary = await summarizeDay(etDayKey(now), { includeTest: true });
    const testInput = recap;
    c.ok("explicit test recap retains fixtures without classifying cancellations as output", testInput.includes("Completed tasks (4):") && testInput.includes("Delivered (3):") && testInput.includes("Shoots (3):") && testInput.includes("Fixture job") && !testInput.includes("Not needed"), JSON.stringify({ testSummary, testInput }));
    c.ok("no real provider or client communication occurred", fence.blocked.length === 0 && fence.faked.length === 2 && await prisma.outboxMessage.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
