// ---------------------------------------------------------------------------
// DRILL: WHO AN ASSISTANT WORKS FOR, SET BY HAND (Oct 23 2026). The Aryeo
// customer-team fold puts every order-less teammate under the member with the
// most orders. On a team with several agents (the Gary Mercer Team) that put
// Olivia Vecere, Sharra Mercer's assistant, under Mike Flatley, so her emails
// filed there. The setting client_team_overrides {assistant: agent} wins.
//   · without the setting: the assistant folds under the busiest agent;
//   · with it: under the agent named, and the next sync keeps it there;
//   · a malformed setting is ignored, never a crash.
// Aryeo is faked at the fence (one GET of /customer-users).
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const team = { id: "team-gmt", name: "Gary Mercer Team" };
const member = (email: string) => ({ email, customer_team_memberships: { data: [{ customer_team: { data: team } }] } });

async function main(): Promise<void> {
  installNextStubs();
  const fence = fenceFetch(async (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return null;
    if (/^https:\/\/api\.aryeo\.com\/v1\/customer-users(?:[?#].*)?$/.test(url)) {
      return json({ data: [member("mike@drill.invalid"), member("sharra@drill.invalid"), member("olivia@drill.invalid")], meta: { current_page: 1, last_page: 1 } });
    }
    return null;
  });
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7131) });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("aryeo", "drill-key-not-a-real-one");
    const aryeo = await import("@/lib/integrations/aryeo");

    const mk = (name: string, email: string) => prisma.client.create({ data: { name, email }, select: { id: true } });
    const mike = await mk("Mike Agent", "mike@drill.invalid");
    const sharra = await mk("Sharra Agent", "sharra@drill.invalid");
    const olivia = await mk("Olivia Assistant", "olivia@drill.invalid");
    for (let i = 0; i < 3; i++) await prisma.project.create({ data: { title: `${i} Mike Rd`, clientId: mike.id } });
    await prisma.project.create({ data: { title: "1 Sharra Ln", clientId: sharra.id } });
    const parentOf = async (id: string) => (await prisma.client.findUniqueOrThrow({ where: { id }, select: { parentClientId: true } })).parentClientId;

    c.head("1 · without the setting: the busiest agent");
    await aryeo.syncAryeoCustomerTeams();
    c.ok("the assistant folds under the member with the most orders", (await parentOf(olivia.id)) === mike.id);

    c.head("2 · the hand-set agent wins, and keeps winning");
    await prisma.appSetting.upsert({ where: { key: aryeo.CLIENT_TEAM_OVERRIDES_KEY }, create: { key: aryeo.CLIENT_TEAM_OVERRIDES_KEY, value: JSON.stringify({ [olivia.id]: sharra.id }) }, update: { value: JSON.stringify({ [olivia.id]: sharra.id }) } });
    await aryeo.syncAryeoCustomerTeams();
    c.ok("with the setting: the assistant is under the agent named", (await parentOf(olivia.id)) === sharra.id);
    await aryeo.syncAryeoCustomerTeams();
    c.ok("a second sync leaves it there", (await parentOf(olivia.id)) === sharra.id);
    c.ok("the agents themselves stay standalone", (await parentOf(mike.id)) === null && (await parentOf(sharra.id)) === null);

    c.head("3 · a malformed setting is ignored");
    await prisma.appSetting.update({ where: { key: aryeo.CLIENT_TEAM_OVERRIDES_KEY }, data: { value: "[not json" } });
    await aryeo.syncAryeoCustomerTeams();
    c.ok("no crash, and the fold falls back to the busiest agent", (await parentOf(olivia.id)) === mike.id);

    c.head("isolation");
    c.ok("only the faked Aryeo was called", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
