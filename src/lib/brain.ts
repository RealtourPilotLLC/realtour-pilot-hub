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

// ---------------------------------------------------------------------------
// WHAT KIND of task the brain's read is (Sep 8 audit). The brain answers a
// client message with one imperative to-do, and not every one is a reply:
// "Note builder relationship context and brief team for shoot", "Prep for
// Thursday 3:30 call", "Log Kristin's interest in brand content" are the
// team's own bookkeeping — nothing goes back to the client. createCommTask
// typed every one client_reply, so the Done tab called them replies and the
// text sweep (clientTextSweeps.ts) had to learn to see through them.
//
// `todo` is the engine's own type for "a person should do this" (taskSource.ts
// TASK_TYPE_META). A real reply — anything that answers, confirms, sends or
// calls the client back — stays client_reply; a missed call or voicemail is
// always a callback. When unsure, client_reply: a note mislabelled as a reply
// is a cosmetic fault, a reply mislabelled as a note is a client left waiting.
// ---------------------------------------------------------------------------
export type CommTaskType = "client_reply" | "todo";

// Opens the way the team's own notes open.
const BOOKKEEPING_RE = /^(?:note|log|record|prep|prepare|brief|remember|await|document|track|file|save|keep|monitor|flag|make a note)\b/i;
// Anything in the title that reaches the client keeps it a reply.
const REPLY_RE =
  /\b(?:reply|respond|answer|call(?:ing)?\s+(?:back|the client|them|her|him)|text(?:ing)?\s+(?:back|the client|them|her|him)|email(?:ing)?\s+(?:back|the client|them|her|him)|let\s+(?:them|her|him|the client)\s+know|get back to|confirm with|clarify|quote|send|ask|follow up with|check with|tell|update (?:the )?client)\b/i;

export function brainTaskType(decision: { title: string }, channel: "text" | "call" | "email" | "slack"): CommTaskType {
  if (channel === "call") return "client_reply";
  const title = (decision.title ?? "").trim();
  if (!title || !BOOKKEEPING_RE.test(title)) return "client_reply";
  return REPLY_RE.test(title) ? "client_reply" : "todo";
}

/** The brain's decision plus the task type it should be stored as. */
export type RoutedCommDecision = BrainDecision & { taskType: CommTaskType };

export async function routeCommTask(input: {
  channel: "text" | "call" | "email" | "slack";
  message: string;
  clientId: string;
  clientName?: string | null;
  senderName?: string | null; // who actually sent it (for non-client senders)
  senderIsClient?: boolean;
}): Promise<RoutedCommDecision | null> {
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
        // clobbered if the brain picked it as "the same request". The second
        // branch: since Sep 8 createCommTask stores the brain's taskType, so
        // its bookkeeping notes ("Prep for Thursday call") are todo rows with a
        // gmail/openphone source — comms-born, and fair game for a follow-up
        // message to land on. A watchdog's or a person's hand-made todo
        // (source system/manual/team) never matches here.
        where: {
          clientId: input.clientId,
          status: { notIn: DONE },
          OR: [
            { taskType: { in: MERGEABLE_TYPES } },
            { taskType: "todo", OR: [{ source: { startsWith: "gmail" } }, { source: { startsWith: "openphone" } }] },
          ],
        },
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

    const decision = await decideCommTask(ctx, key);
    if (!decision) return null;
    return { ...decision, taskType: brainTaskType(decision, input.channel) };
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
  /** Who the message is for (assignedKey), or null when nobody is named. When
   *  given, only open Slack cards with that same assignedKey are offered as
   *  merge targets — Kyle's "I'll do it" must not merge onto Jordan's card
   *  (Sep 8 review). Leave undefined to offer every open Slack card. */
  forKey?: string | null;
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

    // Open Slack to-dos this might be a continuation of (merge candidates) —
    // the same person's cards only, when the caller says who it is for.
    const openSlack = await prisma.smartTask.findMany({
      where: {
        source: "slack",
        taskType: "internal_instruction",
        status: { notIn: DONE },
        ...(opts.forKey !== undefined ? { assignedKey: opts.forKey } : {}),
      },
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
