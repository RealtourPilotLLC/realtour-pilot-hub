// C14: Home radar sources filter fixture clients before their caps and ranking.
// Disposable PGlite only; no provider calls or production writes.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { isSyntheticClientRow, NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5814) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { getProactiveFlags, getBillingRows } = await import("@/lib/queries");
    const { deliveryExceptionFlags } = await import("@/lib/deliveryExceptions");
    const now = Date.now();
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST" } });
    const scope = async () => ({ excludeClientIds: (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((row) => row.id) });
    const realJob = await prisma.project.create({ data: { clientId: real.id, title: "123 TEST Avenue", deliveryExceptionAt: new Date(now - 60_000), deliveryExceptionNote: "Owed: real video" } });
    const protectedJob = await prisma.project.create({ data: { clientId: protectedReal.id, title: "456 TEST Road", deliveryExceptionAt: new Date(now - 60_000), deliveryExceptionNote: "Owed: protected video" } });
    await prisma.project.createMany({ data: Array.from({ length: 45 }, (_, i) => ({ clientId: fixture.id, title: `Fixture ${i}`, deliveryExceptionAt: new Date(now), deliveryExceptionNote: "Owed: synthetic video" })) });
    const exceptions = await deliveryExceptionFlags(3, await scope());
    c.ok("delivery exceptions keep real TEST addresses and protected clients ahead of cap", exceptions.length === 2 && exceptions.some((f) => f.id.endsWith(realJob.id)) && exceptions.some((f) => f.id.endsWith(protectedJob.id)));
    c.ok("full exception reader retains fixture rows", (await deliveryExceptionFlags()).length === 3 && (await deliveryExceptionFlags()).every((f) => f.title.startsWith("Fixture")));
    const normalRadar = await getProactiveFlags(await scope());
    c.ok("Home radar uses the same scoped delivery source", normalRadar.flags.length === 2 && normalRadar.flags.every((f) => exceptions.some((e) => e.id === f.id)));

    await prisma.project.updateMany({ data: { deliveryExceptionAt: null } });
    await prisma.project.update({ where: { id: realJob.id }, data: { status: "DELIVERED", deliveredAt: new Date(now - 40 * 86_400_000), balanceAmount: 10_000 } });
    await prisma.project.update({ where: { id: protectedJob.id }, data: { status: "DELIVERED", deliveredAt: new Date(now - 40 * 86_400_000), balanceAmount: 20_000 } });
    const fixtureAr = await prisma.project.create({ data: { clientId: fixture.id, title: "Synthetic invoice", status: "DELIVERED", deliveredAt: new Date(now - 40 * 86_400_000), balanceAmount: 100_000 } });
    const billing = await getBillingRows(await scope());
    const ar = await getProactiveFlags(await scope());
    c.ok("normal AR total and radar exclude synthetic balances", billing.totalOutstanding === 300 && billing.rows.length === 2 && ar.topAr?.total === 200 && ar.topAr.name === protectedReal.name && ar.flags.length === 2);
    c.ok("full billing and radar preserve explicit fixture access", (await getBillingRows()).rows.some((r) => r.id === fixtureAr.id) && (await getProactiveFlags()).topAr?.total === 1000);

    await prisma.project.updateMany({ data: { balanceAmount: 0 } });
    await prisma.project.update({ where: { id: realJob.id }, data: { status: "REVISION", revisionRequestedAt: new Date(now - 4 * 86_400_000) } });
    await prisma.project.update({ where: { id: protectedJob.id }, data: { status: "REVISION", revisionRequestedAt: new Date(now - 4 * 86_400_000) } });
    await prisma.project.updateMany({ where: { clientId: fixture.id }, data: { status: "REVISION", revisionRequestedAt: new Date(now - 3 * 86_400_000) } });
    const revisions = await getProactiveFlags(await scope());
    c.ok("stale real revisions survive a newer synthetic pile beyond the cap", revisions.flags.length === 2 && revisions.flags.some((f) => f.id === `rev-${realJob.id}`) && revisions.flags.some((f) => f.id === `rev-${protectedJob.id}`));
    c.ok("full radar still includes synthetic revisions", (await getProactiveFlags()).flags.length === 3);

    await prisma.project.updateMany({ data: { status: "DELIVERED", revisionRequestedAt: null } });
    await prisma.client.createMany({ data: Array.from({ length: 65 }, (_, i) => ({ name: `VIP TEST ${i}`, segment: "vip" })) });
    const quietReal = await prisma.client.create({ data: { name: "Quiet real client", segment: "vip" } });
    await prisma.client.update({ where: { id: protectedReal.id }, data: { segment: "vip" } });
    const vip = await getProactiveFlags(await scope());
    c.ok("quiet real clients survive more synthetic VIPs than the source cap", vip.flags.length === 2 && vip.flags.some((f) => f.id === `vip-${quietReal.id}`) && vip.flags.some((f) => f.id === `vip-${protectedReal.id}`));
    c.ok("full radar retains synthetic VIP rows", (await getProactiveFlags()).flags.some((f) => f.title.startsWith("VIP TEST")));
    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
