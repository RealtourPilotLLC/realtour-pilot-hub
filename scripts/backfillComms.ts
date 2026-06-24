import { prisma } from "@/lib/prisma";
import { logComm } from "@/lib/commLog";

// Seed comms memory with the history we already logged as Activity rows
// (OpenPhone texts/calls + named-sender texts). Bodies are the truncated
// timeline snippets; full bodies flow in going forward via the webhooks.
// Idempotent on externalId=act-<id>.
async function main() {
  const acts = await prisma.activity.findMany({
    where: {
      OR: [
        { body: { startsWith: "OpenPhone" } },
        { body: { startsWith: "Call transcript" } },
        { body: { contains: "(text):" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: { id: true, body: true, createdAt: true, project: { select: { id: true, clientId: true, client: { select: { name: true } } } } },
  });

  let n = 0;
  for (const a of acts) {
    const body = a.body || "";
    let channel = "text", direction = "in", text = body;
    let contactName: string | null = a.project?.client?.name ?? null;
    if (/^Call transcript/i.test(body)) {
      channel = "call"; direction = "in"; text = body.replace(/^Call transcript:\s*/i, "");
    } else if (/^OpenPhone\s+out/i.test(body)) {
      direction = "out"; text = body.replace(/^OpenPhone[^:]*:\s*/i, "");
    } else if (/^OpenPhone/i.test(body)) {
      direction = "in"; text = body.replace(/^OpenPhone[^:]*:\s*/i, "");
    } else {
      const m = body.match(/^(.+?)\s+\(text\):\s*([\s\S]*)$/);
      if (m) { contactName = m[1]; text = m[2]; }
    }
    await logComm({
      channel, direction,
      clientId: a.project?.clientId ?? null,
      clientName: a.project?.client?.name ?? null,
      projectId: a.project?.id ?? null,
      contactName,
      body: text,
      occurredAt: a.createdAt,
      source: "backfill",
      externalId: `act-${a.id}`,
    });
    n++;
  }
  const total = await prisma.commLog.count();
  console.log(`Backfilled ${n} comm activities. CommLog total: ${total}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
