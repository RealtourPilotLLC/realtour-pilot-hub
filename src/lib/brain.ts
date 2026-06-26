import "server-only";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";
import { decideCommTask, decideSlackTask, type BrainContext, type BrainDecision, type SlackDecision, type SlackCandidate } from "@/lib/integrations/ai";
import { etDate, etDateTime, etDayStartUtc, etAddDays } from "@/lib/datetime";

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
// Task types an inbound comm may MERGE into. Excludes production tasks
// (media_qa/delivery/confirmation_text/delivery_text) so their content is safe.
const MERGEABLE_TYPES = ["client_reply", "comms_followup", "internal_instruction", "revision", "vendor_update", "lead"];

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
        // Only comms-type to-dos are valid MERGE targets — never a production task
        // (media_qa / delivery / confirmation_text), whose title/summary would get
        // clobbered if the brain picked it as "the same request".
        where: { clientId: input.clientId, status: { notIn: DONE }, taskType: { in: MERGEABLE_TYPES } },
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Clients whose FULL name (first + last) appears as a whole phrase in the text.
// Full-name only on purpose: a bare first name like "Daniel" false-matches too
// easily, so we never auto-link on it. These are just CANDIDATES — the brain
// then picks the right one from the thread, or none.
async function resolveClientCandidates(text: string): Promise<{ id: string; name: string }[]> {
  const hay = ` ${text.toLowerCase()} `;
  if (hay.trim().length < 5) return [];
  const clients = await prisma.client.findMany({
    where: { parentClientId: null },
    select: { id: true, name: true },
  });
  const hits: { id: string; name: string; len: number }[] = [];
  for (const c of clients) {
    const name = (c.name || "").toLowerCase().trim();
    if (name.length < 6 || !name.includes(" ")) continue; // require a full multi-word name
    if (new RegExp(`\\b${escapeRe(name)}\\b`).test(hay)) hits.push({ id: c.id, name: c.name, len: name.length });
  }
  return hits.sort((a, b) => b.len - a.len).slice(0, 3).map(({ id, name }) => ({ id, name }));
}

export async function routeSlackTask(opts: {
  message: string;
  ts: string;
  channel: string;
  senderName?: string | null;
}): Promise<SlackDecision | null> {
  const text = (opts.message ?? "").trim();
  if (!text) return null;
  const key = await getSecret("ai");
  if (!key) return null;

  try {
    // The recent thread for this Slack channel (so "she"/"the form" resolve).
    // MUST read the NEWEST messages — order desc, then flip back to chronological.
    // (Reading oldest-first on a huge DM thread made the brain reason about
    // months-old history and resurrect long-finished conversations as new tasks.)
    const threadRowsDesc = await prisma.commLog.findMany({
      where: { channel: "slack", externalId: { startsWith: `slack-${opts.channel}-` } },
      orderBy: { occurredAt: "desc" },
      take: 40,
      select: { contactName: true, body: true },
    });
    const recent = threadRowsDesc.reverse().slice(-22);
    const threadText = recent.map((r) => r.body ?? "").join("\n");

    // Candidate clients whose full name appears in the thread; the brain picks one.
    const candNames = await resolveClientCandidates(`${threadText}\n${text}`);
    const todayStart = etDayStartUtc(new Date());
    const candidates: SlackCandidate[] = await Promise.all(
      candNames.map(async (cn) => {
        const [orders, appts] = await Promise.all([
          prisma.project.findMany({
            where: { clientId: cn.id },
            orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
            take: 8,
            select: { id: true, title: true, status: true, deliveryDue: true, deliveredAt: true, revisionRequestedAt: true },
          }),
          prisma.appointment.findMany({
            where: { project: { clientId: cn.id }, startAt: { gte: etAddDays(todayStart, -1) }, status: { not: "CANCELED" } },
            orderBy: { startAt: "asc" },
            take: 5,
            select: { startAt: true, project: { select: { title: true } } },
          }),
        ]);
        return {
          id: cn.id,
          name: cn.name,
          orders: orders.map((o) => ({
            id: o.id,
            address: o.title,
            status: o.status,
            due: o.deliveryDue ? etDate(o.deliveryDue) : null,
            delivered: o.deliveredAt ? etDate(o.deliveredAt) : null,
            inRevision: !!o.revisionRequestedAt,
          })),
          shoots: appts.map((a) => `${a.project?.title ?? "shoot"} — ${a.startAt ? etDateTime(a.startAt) : "TBD"}`),
        };
      }),
    );

    // Open Slack to-dos this might be a continuation of (merge candidates).
    const openSlack = await prisma.smartTask.findMany({
      where: { source: "slack", taskType: "internal_instruction", status: { notIn: DONE } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { id: true, title: true },
    });

    return await decideSlackTask({
      message: text,
      senderName: opts.senderName || "a teammate",
      thread: recent.map((r) => ({ who: r.contactName || "teammate", text: (r.body ?? "").replace(/\s+/g, " ").slice(0, 240) })),
      candidates,
      openSlackTasks: openSlack.map((t) => ({ id: t.id, title: t.title })),
    }, key);
  } catch {
    return null;
  }
}
