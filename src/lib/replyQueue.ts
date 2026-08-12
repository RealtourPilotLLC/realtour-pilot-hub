import "server-only";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";
import { phoneKey } from "@/lib/integrations/openphone";

// ---------------------------------------------------------------------------
// THE REPLY QUEUE — every inbound text still waiting on an answer.
//
// Jordan: "a generate response engine for Kyle so he can have responses
// generated to all inbound text messages, and then give him the ability to
// explain what he wants to say to be able to tailor the message."
//
// Built on CommLog rather than on open reply TASKS, deliberately. A task only
// exists when the sender matched a client; the 30-day comms review found a
// large share of inbound texts come from people we haven't matched (a new
// lead, an assistant on someone's team, a number that never got saved). Those
// are exactly the ones that go unanswered, so a queue that can't see them
// misses the problem it exists to solve.
//
// A conversation is "waiting" when its newest text is INBOUND. That single
// rule is self-clearing: the moment we send, the outbound row lands and the
// card leaves the queue. Nothing to tick off, nothing to go stale.
// ---------------------------------------------------------------------------

const WINDOW_DAYS = 21; // older than this and a reply isn't a reply any more
const SCAN_CAP = 1200; // rows pulled; ~3 weeks of texts sits well under this
const THREAD_TURNS = 24; // how much history each card carries for the AI

// Same tiering as every other CommLog reader — a viewer sees their tier and below.
const ROLE_RANK: Record<string, number> = { CREATIVE: 1, ADMIN: 2, OWNER: 3 };

export type ReplyTurn = { role: "client" | "us"; text: string; at: string };

// A conversation whose last inbound is a pure courtesy closer — "Thank you!",
// "Love that", "Copy that, we're good to go" — is technically unanswered and
// genuinely finished. Left in the main queue they're most of the list, and a
// queue that's mostly noise is one Kyle stops trusting: he drafts ten, five come
// back "nothing to answer", and the screen has taught him to ignore it.
//
// Deliberately conservative. Anything with a question mark, a number (a time, an
// address, a price), or more than a handful of words falls through to the real
// queue — a false "needs an answer" costs a click, a false "handled" costs a
// client.
const ACK_ONLY =
  /^(ok(ay)?|k|kk|got it|gotcha|copy( that)?|sounds good|sounds great|perfect|great|awesome|amazing|beautiful|love (it|that|them|these)|nice|excellent|wonderful|yes+|yep|yup|sure|will do|no problem|np|you too|same|thanks?( (you|so much|a lot|again))?|thank you( so much| very much| again)?|ty|tysm|appreciate (it|you|that)|cheers|👍|🙏|❤️|🔥|😊|:\)|lol|haha)\b/i;

function looksHandled(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.length > 90) return false; // a real message, whatever it opens with
  if (/[?]/.test(t)) return false; // they asked something
  if (/\d/.test(t)) return false; // a time, a date, an address, a price
  if (/\b(can|could|would|will|when|what|where|why|how|need|want|send|call|text|check|fix|change|add|reschedul|cancel|confirm|still|waiting|問)\b/i.test(t)) return false;
  // Strip the courtesy opener; if what's left is only more courtesy, it's done.
  const rest = t.replace(ACK_ONLY, "").replace(/[!.,\s👍🙏❤️🔥😊]+/g, " ").trim();
  return ACK_ONLY.test(t) && (rest.length === 0 || ACK_ONLY.test(rest));
}

export type ReplyCard = {
  key: string; // stable id for this conversation (clientId or phone key)
  clientId: string | null;
  clientName: string | null;
  displayName: string; // who Kyle sees: client, contact, or a formatted number
  phone: string | null; // 10-digit key we'd send to; null = can't send from here
  isClient: boolean;
  isTeam: boolean; // a photographer/editor, not a customer
  segment: string | null;
  socialPlan: string | null;
  propertyAddress: string | null;
  projectId: string | null;
  lastInbound: string; // the message actually awaiting an answer
  waitingSince: string; // ISO
  hoursWaiting: number;
  turns: ReplyTurn[]; // oldest first, capped
  openTaskId: string | null; // the reply to-do this clears, when there is one
  likelyHandled: boolean; // last word was a thank-you — shown, but out of the way
};

export type ReplyQueue = {
  cards: ReplyCard[]; // needs a real answer
  handled: ReplyCard[]; // courtesy closers, collapsed under the queue
  clientCount: number;
  teamCount: number;
  oldestHours: number;
};

const fmtPhone = (k: string) =>
  k.length === 10 ? `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}` : k;

export async function replyQueue(): Promise<ReplyQueue> {
  // Sessionless local dev renders the owner view, same as the dashboard.
  const me = await getCurrentUser().catch(() => null);
  const tier = contentTier(me?.role ?? "OWNER");
  const allowed = Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= ROLE_RANK[tier]);

  const rows = await prisma.commLog.findMany({
    where: {
      channel: "text",
      occurredAt: { gte: new Date(Date.now() - WINDOW_DAYS * 86_400_000) },
      minRole: { in: allowed },
    },
    orderBy: { occurredAt: "desc" },
    take: SCAN_CAP,
    select: {
      direction: true, clientId: true, clientName: true, contactName: true,
      fromPhone: true, projectId: true, body: true, occurredAt: true,
    },
  });
  if (rows.length === 0) return { cards: [], handled: [], clientCount: 0, teamCount: 0, oldestHours: 0 };

  // Group into conversations. Prefer the client id (so a client texting from a
  // second number is ONE conversation); fall back to the number, then the name.
  type Bucket = { rows: typeof rows; clientId: string | null; phone: string | null; name: string | null };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const phone = r.fromPhone && r.fromPhone.length === 10 ? r.fromPhone : null;
    const key = r.clientId ? `c:${r.clientId}` : phone ? `p:${phone}` : r.contactName ? `n:${r.contactName}` : null;
    if (!key) continue; // an untraceable row can't be replied to — don't fake a card
    const b = buckets.get(key) ?? { rows: [], clientId: r.clientId, phone, name: null };
    b.rows.push(r);
    // Rows are newest-first, so the first non-null of each wins — the most
    // recent number and the most recent human name for this conversation.
    if (!b.phone && phone) b.phone = phone;
    if (!b.name && r.direction === "in" && r.contactName && r.contactName !== "Us") b.name = r.contactName;
    buckets.set(key, b);
  }

  // Waiting = newest row is inbound. (Rows within a bucket keep the newest-first
  // order they arrived in, so [0] is the latest.)
  const waiting = [...buckets.entries()].filter(([, b]) => b.rows[0]?.direction === "in");
  if (waiting.length === 0) return { cards: [], handled: [], clientCount: 0, teamCount: 0, oldestHours: 0 };

  // Enrich in three batched lookups rather than per-card queries.
  const clientIds = [...new Set(waiting.map(([, b]) => b.clientId).filter((x): x is string => !!x))];
  const [clients, teamMembers, openTasks] = await Promise.all([
    clientIds.length
      ? prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, name: true, phone: true, segment: true, socialClient: true, socialPlan: true },
        })
      : Promise.resolve([]),
    // No phone filter — the name set has to cover teammates whose number we
    // don't hold, or they read as strangers in the queue.
    prisma.teamMember.findMany({ select: { name: true, phone: true } }),
    clientIds.length
      ? prisma.smartTask.findMany({
          where: { clientId: { in: clientIds }, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
          select: { id: true, clientId: true, propertyAddress: true, projectId: true },
        })
      : Promise.resolve([]),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const teamByPhone = new Map<string, string>();
  const teamByName = new Set<string>();
  for (const t of teamMembers) {
    const k = phoneKey(t.phone);
    if (k.length === 10) teamByPhone.set(k, t.name);
    teamByName.add(t.name.toLowerCase());
  }
  const taskByClient = new Map(openTasks.map((t) => [t.clientId!, t]));

  const now = Date.now();
  const cards: ReplyCard[] = waiting.map(([key, b]) => {
    const latest = b.rows[0];
    const client = b.clientId ? clientById.get(b.clientId) : undefined;
    const task = b.clientId ? taskByClient.get(b.clientId) : undefined;
    // Fall back to the number on file for rows logged before fromPhone existed.
    const phone = b.phone ?? (client?.phone ? phoneKey(client.phone) || null : null);
    // Match our own people by number, and by name when the row predates
    // fromPhone — otherwise a photographer shows up as an unknown stranger.
    const teamName =
      (phone ? teamByPhone.get(phone) : undefined) ??
      (b.name && teamByName.has(b.name.toLowerCase()) ? b.name : undefined);

    const turns: ReplyTurn[] = b.rows
      .slice(0, THREAD_TURNS)
      .reverse() // the AI reads oldest-first
      .map((r) => ({
        role: r.direction === "in" ? ("client" as const) : ("us" as const),
        text: r.body,
        at: r.occurredAt.toISOString(),
      }));

    return {
      key,
      clientId: b.clientId,
      clientName: client?.name ?? latest.clientName ?? null,
      displayName: client?.name ?? b.name ?? teamName ?? (phone ? fmtPhone(phone) : "Unknown number"),
      phone: phone && phone.length === 10 ? phone : null,
      isClient: !!b.clientId,
      isTeam: !b.clientId && !!teamName,
      segment: client?.segment ?? null,
      socialPlan: client?.socialClient ? client?.socialPlan ?? "yes" : null,
      propertyAddress: task?.propertyAddress ?? null,
      projectId: task?.projectId ?? latest.projectId ?? null,
      lastInbound: latest.body,
      waitingSince: latest.occurredAt.toISOString(),
      hoursWaiting: Math.max(0, Math.round((now - latest.occurredAt.getTime()) / 3_600_000)),
      turns,
      openTaskId: task?.id ?? null,
      likelyHandled: looksHandled(latest.body),
    };
  });

  // Longest wait first. The message that's been sitting two days is the one
  // that costs us a client, not the one that came in ten minutes ago.
  cards.sort((a, b) => new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime());

  const real = cards.filter((c) => !c.likelyHandled);
  const handled = cards.filter((c) => c.likelyHandled);

  return {
    cards: real,
    handled,
    clientCount: real.filter((c) => c.isClient).length,
    teamCount: real.filter((c) => c.isTeam).length,
    oldestHours: real[0]?.hoursWaiting ?? 0,
  };
}

// How many texts are owed an answer, and how long the oldest has been sitting.
// Same grouping rule as the full queue, but it pulls only the fields that rule
// needs and skips every enrichment lookup — the dashboard, the Tasks header and
// the other comms tabs all read this, and none of them should pay for the full
// build. `oldestHours` is the number that actually makes someone act: seven
// unanswered is a queue, one of them sitting three days is a problem.
export async function replyWaitingSummary(): Promise<{ count: number; oldestHours: number }> {
  const me = await getCurrentUser().catch(() => null);
  const tier = contentTier(me?.role ?? "OWNER");
  const allowed = Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= ROLE_RANK[tier]);

  const rows = await prisma.commLog.findMany({
    where: {
      channel: "text",
      occurredAt: { gte: new Date(Date.now() - WINDOW_DAYS * 86_400_000) },
      minRole: { in: allowed },
    },
    orderBy: { occurredAt: "desc" },
    take: SCAN_CAP,
    select: { direction: true, clientId: true, fromPhone: true, contactName: true, body: true, occurredAt: true },
  });

  // First row seen per conversation is its newest (rows are newest-first).
  const seen = new Set<string>();
  let count = 0;
  let oldest: Date | null = null;
  for (const r of rows) {
    const phone = r.fromPhone && r.fromPhone.length === 10 ? r.fromPhone : null;
    const key = r.clientId ? `c:${r.clientId}` : phone ? `p:${phone}` : r.contactName ? `n:${r.contactName}` : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Matches the queue's own split — a badge must never claim work the tab
    // then files under "probably done".
    if (r.direction === "in" && !looksHandled(r.body)) {
      count++;
      if (!oldest || r.occurredAt < oldest) oldest = r.occurredAt;
    }
  }
  return {
    count,
    oldestHours: oldest ? Math.max(0, Math.round((Date.now() - oldest.getTime()) / 3_600_000)) : 0,
  };
}

// Rebuild ONE card after something changes (a send, a regenerate) without
// re-running the whole scan. Used by the send action to confirm the card is
// genuinely cleared rather than trusting the UI's optimism.
export async function replyCardFor(key: string): Promise<ReplyCard | null> {
  const q = await replyQueue();
  // Searches BOTH lists — Kyle can still choose to answer a thank-you, and the
  // send action must find that card rather than reporting it already handled.
  return [...q.cards, ...q.handled].find((c) => c.key === key) ?? null;
}
