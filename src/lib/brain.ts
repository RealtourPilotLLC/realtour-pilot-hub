import "server-only";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";
import { decideCommTask, type BrainContext, type BrainDecision } from "@/lib/integrations/ai";
import { etDate } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// The Smart Brain task router. Every comms-driven task creation flows through
// here: it pulls the client's orders, the recent conversation, and the team's
// existing open to-dos, then asks the brain (ai.ts:decideCommTask) to route the
// message to the right order, write a specific title, set priority from real
// context, merge duplicates, and flag what matters. Returns null when the AI
// isn't connected or anything fails, so callers safely fall back to their old
// behavior.
// ---------------------------------------------------------------------------

export type { BrainDecision } from "@/lib/integrations/ai";

const DONE = ["COMPLETED", "CANCELLED"];

export async function routeCommTask(input: {
  channel: "text" | "call" | "email" | "slack";
  message: string;
  clientId: string;
  clientName?: string | null;
  senderName?: string | null; // who actually sent it (for non-client senders)
  senderIsClient?: boolean;
}): Promise<BrainDecision | null> {
  const text = (input.message ?? "").trim();
  if (!text || !input.clientId) return null;
  const key = await getSecret("ai");
  if (!key) return null;

  try {
    const [orders, openTasks, comms] = await Promise.all([
      prisma.project.findMany({
        where: { clientId: input.clientId },
        orderBy: [
          { orderedAt: { sort: "desc", nulls: "last" } },
          { shootDate: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        take: 14,
        select: { id: true, title: true, status: true, deliveryDue: true, deliveredAt: true, revisionRequestedAt: true },
      }),
      prisma.smartTask.findMany({
        where: { clientId: input.clientId, status: { notIn: DONE } },
        orderBy: { createdAt: "desc" },
        take: 14,
        select: { id: true, taskType: true, title: true, projectId: true },
      }),
      prisma.commLog.findMany({
        where: { clientId: input.clientId },
        orderBy: { occurredAt: "desc" },
        take: 12,
        select: { direction: true, body: true, occurredAt: true, contactName: true },
      }),
    ]);

    const titleById = new Map(orders.map((o) => [o.id, o.title.split(",")[0]]));

    const ctx: BrainContext = {
      channel: input.channel,
      message: text,
      senderName: input.senderName || input.clientName || "the client",
      senderIsClient: input.senderIsClient !== false,
      clientName: input.clientName ?? null,
      orders: orders.map((o) => ({
        id: o.id,
        address: o.title,
        status: o.status,
        due: o.deliveryDue ? etDate(o.deliveryDue) : null,
        delivered: o.deliveredAt ? etDate(o.deliveredAt) : null,
        inRevision: !!o.revisionRequestedAt,
      })),
      openTasks: openTasks.map((t) => ({
        id: t.id,
        type: t.taskType,
        about: t.projectId ? titleById.get(t.projectId) ?? null : null,
        title: t.title,
      })),
      thread: comms
        .slice()
        .reverse()
        .map((c) => ({
          who: c.direction === "out" ? "Us" : c.contactName || input.clientName || "Client",
          when: etDate(c.occurredAt),
          text: (c.body ?? "").replace(/\s+/g, " ").slice(0, 300),
        })),
    };

    return await decideCommTask(ctx, key);
  } catch {
    return null;
  }
}
