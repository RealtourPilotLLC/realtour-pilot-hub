import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE CONVERSATION AROUND A DECISION (Oct 14 2026).
//
// Jordan: "Texts should be analyzed, as well as previous message context any
// time a decision is being made or response is being drafted. Context is
// important across all fronts." One reader for every place that decides or
// drafts: the client's recent texts, emails and call notes in both directions
// (ours marked as ours), and, when asked, the job's internal team chat. Times
// to the minute, Eastern, so "Kyle answered at 3:35, she asked again at 3:41"
// reads in the right order.
// ---------------------------------------------------------------------------

export type ConvoLine = { role: "client" | "us"; who: string; text: string; at: Date; channel: string };

export const etStamp = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The client's recent conversation, oldest first. */
export async function recentConversation(
  clientId: string | null | undefined,
  opts: { before?: Date | null; since?: Date | null; limit?: number; teamChatProjectIds?: string[]; clientName?: string | null } = {},
): Promise<ConvoLine[]> {
  if (!clientId) return [];
  const when = { ...(opts.before ? { lte: opts.before } : {}), ...(opts.since ? { gte: opts.since } : {}) };
  const rows = await prisma.commLog.findMany({
    where: { clientId, channel: { in: ["text", "email", "call"] }, ...(opts.before || opts.since ? { occurredAt: when } : {}) },
    orderBy: { occurredAt: "desc" },
    take: opts.limit ?? 12,
    select: { direction: true, body: true, occurredAt: true, contactName: true, channel: true, source: true },
  }).catch(() => []);
  const lines: ConvoLine[] = rows
    .filter((r) => (r.body ?? "").trim() && !/^auto-/.test(r.source ?? ""))
    .map((r) => ({
      role: r.direction === "out" ? "us" : "client",
      who: r.direction === "out" ? (r.contactName && !/^(us|realtour pilot)$/i.test(r.contactName.trim()) ? (/\(us\)$/.test(r.contactName) ? r.contactName : `${r.contactName} (us)`) : "Us") : r.contactName || opts.clientName || "Client",
      text: r.body.replace(/\s+/g, " ").trim().slice(0, 600),
      at: r.occurredAt,
      channel: r.channel,
    }));
  if (opts.teamChatProjectIds?.length) {
    const chat = await prisma.projectMessage.findMany({
      where: { projectId: { in: opts.teamChatProjectIds }, ...(opts.before || opts.since ? { createdAt: when } : {}) },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { authorName: true, body: true, createdAt: true },
    }).catch(() => []);
    for (const m of chat) lines.push({ role: "us", who: `${m.authorName ?? "Team"} (team chat, internal)`, text: m.body.replace(/\s+/g, " ").trim().slice(0, 600), at: m.createdAt, channel: "team" });
  }
  return lines.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The lines as a prompt block: "Wed, Oct 14, 3:31 PM · Georgiana (text): …". */
export function convoBlock(lines: ConvoLine[]): string {
  return lines.length ? lines.map((l) => `${etStamp(l.at)} · ${l.who}${l.channel === "team" ? "" : ` (${l.channel})`}: ${l.text}`).join("\n") : "(no recent messages on record)";
}
