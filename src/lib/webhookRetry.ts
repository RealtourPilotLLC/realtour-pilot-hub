import "server-only";
import { prisma } from "@/lib/prisma";

// Re-process webhook events that errored on first receipt. Each receiver returns
// HTTP 200 even on a processing failure (so the provider doesn't hammer retries),
// marking the row status:"ERROR" — but nothing re-ran them, so a transient blip
// (DB/API hiccup) silently dropped a real event (a delivered gallery, a paid
// invoice, an inbound text). This gives every errored event ONE retry on the
// hourly cron: success → PROCESSED, still failing → FAILED (terminal, stays
// visible for the admin error count until the 30-day purge). Bounded + recent so
// it's cheap and never storms.
export async function retryFailedWebhooks(limit = 25): Promise<{ retried: number; recovered: number; failed: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.webhookEvent.findMany({
    // Gmail rows are excluded: they can't be re-dispatched from the stored
    // payload (it's just a snippet) — the gmail cron re-scans the inbox and
    // retries any non-PROCESSED row itself, so marking them FAILED here would
    // only fight that loop.
    where: { status: "ERROR", provider: { not: "gmail" }, createdAt: { gt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, provider: true, eventType: true, payload: true },
  });

  let recovered = 0;
  let failed = 0;
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
    } catch {
      /* truncated / non-JSON payload — dispatch with what we have */
    }
    try {
      await dispatch(row.provider, row.eventType, payload);
      await prisma.webhookEvent.update({
        where: { id: row.id },
        data: { status: "PROCESSED", processedAt: new Date(), error: null },
      });
      recovered++;
    } catch (e) {
      await prisma.webhookEvent.update({
        where: { id: row.id },
        data: { status: "FAILED", error: (e instanceof Error ? e.message : String(e)).slice(0, 500) },
      });
      failed++;
    }
  }
  return { retried: rows.length, recovered, failed };
}

// Re-run the same processor the receiver used, reconstructing its args from the
// stored raw payload (mirrors each route's POST handler exactly).
async function dispatch(provider: string, eventType: string | null, payload: Record<string, unknown>) {
  if (provider === "openphone") {
    const { processOpenPhoneEvent } = await import("@/app/api/webhooks/openphone/route");
    await processOpenPhoneEvent((payload.type as string) || eventType || "unknown", payload);
  } else if (provider === "aryeo") {
    const { processAryeoEvent } = await import("@/app/api/webhooks/aryeo/route");
    await processAryeoEvent(eventType || "unknown", payload);
  } else if (provider === "slack") {
    const { processSlackEvent } = await import("@/app/api/webhooks/slack/route");
    await processSlackEvent((payload.event as Record<string, unknown>) || {});
  } else {
    throw new Error(`no retry handler for provider "${provider}"`);
  }
}

// Count of webhook events still needing attention (errored or gave up), last 7
// days — surfaced on the Connections page so failures are visible before the
// 30-day purge deletes them.
export async function webhookErrorCount(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return prisma.webhookEvent.count({
    where: { status: { in: ["ERROR", "FAILED"] }, createdAt: { gt: cutoff } },
  });
}
