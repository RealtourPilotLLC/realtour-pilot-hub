import "server-only";
import { prisma } from "@/lib/prisma";
import { segmentFromOrders } from "@/lib/segments";

// Recompute + persist every client's segment from their orders. Idempotent:
// only writes the clients whose segment / spend / txn count actually changed.
// Runs on the cron and can be called after a status/order sync.
export async function syncClientSegments(): Promise<{ scanned: number; updated: number }> {
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      segment: true,
      lifetimeSpendCents: true,
      transactionCount: true,
      projects: { select: { status: true, price: true } },
    },
  });

  let updated = 0;
  for (const c of clients) {
    const { key, spendCents, txns } = segmentFromOrders(c.projects);
    if (
      c.segment === key &&
      c.lifetimeSpendCents === spendCents &&
      c.transactionCount === txns
    ) {
      continue;
    }
    await prisma.client.update({
      where: { id: c.id },
      data: {
        segment: key,
        lifetimeSpendCents: spendCents,
        transactionCount: txns,
        segmentUpdatedAt: new Date(),
      },
    });
    updated++;
  }
  return { scanned: clients.length, updated };
}
