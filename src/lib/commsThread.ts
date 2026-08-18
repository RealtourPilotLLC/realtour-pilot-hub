import "server-only";

import { prisma } from "@/lib/prisma";
import { conversationThread, phoneKey } from "@/lib/integrations/openphone";
import type { ChatItem } from "@/components/comms/ConversationView";

// The chat renders any direction starting with "out" as ours; the two sources
// spell it differently ("outgoing" live, "out" stored), so compare the boolean.
const isOutbound = (d?: string) => (d || "").toLowerCase().startsWith("out");

export type ThreadLoad = {
  items: ChatItem[]; // oldest → newest, ready for the chat panel
  note: string | null; // set when we're showing saved history instead of live
};

// Every text we've ever logged with these people, newest-first. CommLog.fromPhone
// is the OTHER party's 10-digit key in BOTH directions (inbound: who wrote in;
// outbound: who we texted), so one `in` filter covers the whole thread.
async function savedTexts(participants: string[]): Promise<ChatItem[]> {
  const keys = participants.map((p) => phoneKey(p)).filter((k) => k.length === 10);
  if (keys.length === 0) return [];
  const rows = await prisma.commLog.findMany({
    where: { channel: "text", fromPhone: { in: keys } },
    orderBy: { occurredAt: "desc" },
    take: 300,
    select: { id: true, externalId: true, direction: true, body: true, occurredAt: true, fromPhone: true },
  });
  return rows.map((r) => ({
    kind: "message" as const,
    id: r.externalId ?? r.id,
    at: r.occurredAt.toISOString(),
    // CommLog stores "in"/"out"; the chat's isOut() reads the "out" prefix.
    direction: r.direction,
    text: r.body,
    from: r.fromPhone ? `+1${r.fromPhone}` : undefined,
  }));
}

// The conversation for the chat panel: live from OpenPhone/Quo, backed by our own
// logged history so the thread is never blank when the API is unreachable.
//
// Calls come from the live pull only — we log a call's transcript but not its
// duration/status, and inventing those would put a wrong chip in the thread.
export async function loadConversation(
  phoneNumberId: string,
  participants: string[],
): Promise<ThreadLoad> {
  let live: ChatItem[] = [];
  let liveError: string | null = null;
  try {
    live = (await conversationThread(phoneNumberId, participants)).map((t) => ({
      kind: t.kind,
      id: t.id,
      at: t.at,
      direction: t.direction,
      text: t.kind === "message" ? t.text : undefined,
      from: t.kind === "message" ? t.from : undefined,
      duration: t.kind === "call" ? t.duration : undefined,
      status: t.kind === "call" ? t.status : undefined,
    }));
  } catch (e) {
    liveError = e instanceof Error ? e.message : "OpenPhone is unreachable.";
  }

  const saved = await savedTexts(participants).catch(() => [] as ChatItem[]);

  // Provider ids are the join — but we store them SOURCE-PREFIXED ("op-AC123…"
  // for the API's "AC123…"), so both sides get normalized or every message
  // renders twice. Second guard for rows saved without a provider id at all
  // (manual/backfill): same direction + same text within two minutes is the
  // same text, not a client sending the identical line twice.
  const providerKey = (id: string) => id.replace(/^[a-z]+-/, "");
  const contentKey = (i: ChatItem) =>
    `${isOutbound(i.direction)}|${(i.text ?? "").trim()}|${Math.round(new Date(i.at).getTime() / 120_000)}`;
  const seenIds = new Set(live.map((i) => providerKey(i.id)));
  const seenContent = new Set(live.filter((i) => i.kind === "message").map(contentKey));

  const merged = [
    ...live,
    ...saved.filter((s) => !seenIds.has(providerKey(s.id)) && !seenContent.has(contentKey(s))),
  ];
  merged.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const note = liveError
    ? saved.length
      ? `Showing saved history — couldn't reach OpenPhone (${liveError}). New messages may be missing.`
      : `Couldn't load this conversation: ${liveError}`
    : null;

  return { items: merged, note };
}
