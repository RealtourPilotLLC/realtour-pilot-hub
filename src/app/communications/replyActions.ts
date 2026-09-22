"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { replyCardFor, type ReplyCard } from "@/lib/replyQueue";
import { OpenPhone, defaultOpenPhoneNumber } from "@/lib/integrations/openphone";
import { closeReplyForOutbound } from "@/lib/tasks";
import { logComm } from "@/lib/commLog";

export type DraftResult = { ok: boolean; message: string; draft?: string };

// Words the 30-day comms review found doing the damage — a promise with no time
// in it. The model is told not to use them; this catches the cases where it does
// anyway, so the rule holds even on a bad generation.
const VAGUE = /\b(should be|shortly|soon|asap|as soon as possible|in a bit|in a few|at some point|when it'?s ready)\b/i;

// Generate (or re-generate) the reply for one conversation.
//
// `instruction` is the whole point of the feature: Kyle types what he actually
// wants to say — "tell her Saturday morning works but I need the lockbox code" —
// and gets it back written properly, with the client's history, their open jobs,
// our real availability and our policies already folded in. Without it, the draft
// is the model's own best read of the thread.
//
// DRAFT ONLY. Nothing here sends anything.
export async function generateReply(key: string, instruction?: string | null): Promise<DraftResult> {
  await requireAdmin();
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to generate replies." };

  const card = await replyCardFor(key);
  if (!card) return { ok: false, message: "That conversation has already been answered." };
  return draftFor(card, instruction);
}

// The actual generation, taking a card that's already been loaded. Split out so
// the batch path can build the queue ONCE instead of re-scanning three weeks of
// comms for every message it drafts.
async function draftFor(card: ReplyCard, instruction?: string | null): Promise<DraftResult> {
  const ask = card.lastInbound + " " + (instruction ?? "");

  // Their recent jobs, so the draft can talk about the right listing.
  let projects: { title: string; status: string }[] = [];
  if (card.clientId) {
    projects = await prisma.project.findMany({
      where: { clientId: card.clientId },
      orderBy: { orderedAt: { sort: "desc", nulls: "last" } },
      take: 6,
      select: { title: true, status: true },
    });
  }

  // Real open shoot dates from Aryeo when they're asking about scheduling, so
  // the draft offers dates we can actually keep instead of inventing them.
  let availability: string | null = null;
  if (/\b(availab|when can|what (day|days|time|times)|schedul|book|come out|opening|calendar|times? work|soonest|reschedul)\b/i.test(ask)) {
    try {
      const { getSchedulingAvailability } = await import("@/lib/integrations/aryeo");
      const { etDate } = await import("@/lib/datetime");
      const slots = await getSchedulingAvailability({ limit: 6 });
      if (slots?.length) availability = slots.map((s) => etDate(new Date(`${s.date}T12:00:00Z`))).join(", ");
    } catch {
      /* draft without availability rather than failing the whole generation */
    }
  }

  try {
    const { relevantPolicies } = await import("@/lib/policies");
    const { draftReplyWithContext } = await import("@/lib/integrations/ai");
    const draft = await draftReplyWithContext({
      channel: "text",
      clientName: card.clientName ?? card.displayName,
      segment: card.segment,
      socialPlan: card.socialPlan,
      propertyAddress: card.propertyAddress ?? projects[0]?.title ?? null,
      projects,
      transcript: card.turns.map((t) => ({ role: t.role, text: t.text, at: t.at })),
      availability,
      policies: await relevantPolicies(ask),
      instruction: instruction?.trim() || null,
      // Who we're talking to matters for tone: a photographer asking about a
      // lockbox isn't a customer, and shouldn't be written to like one.
      note: card.isTeam ? "This is one of our own team members, not a customer. Reply like a colleague." : null,
    });

    if (/^\s*NO_REPLY_NEEDED\s*$/i.test(draft)) {
      return { ok: false, message: "This one looks handled — nothing to answer. Use \"Tell it what to say\" if you still want to write." };
    }

    const warn = VAGUE.test(draft)
      ? "Draft ready — but it still has a vague time in it. Put a real one in before sending."
      : "Draft ready. Read it before sending.";
    return { ok: true, message: warn, draft };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not generate a reply." };
  }
}

// Generate drafts for a whole batch of conversations in one go, so Kyle opens
// the page to a queue that is already written rather than one he has to prompt
// card by card. Runs them concurrently but in small waves — the AI provider
// rate-limits, and one 429 shouldn't take the other nine drafts down with it.
export async function generateAllReplies(
  keys: string[],
): Promise<{ ok: boolean; message: string; drafts: Record<string, string> }> {
  await requireAdmin();
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to generate replies.", drafts: {} };

  // ONE queue build for the whole batch.
  const { replyQueue } = await import("@/lib/replyQueue");
  const q = await replyQueue();
  const byKey = new Map([...q.cards, ...q.handled].map((c) => [c.key, c]));
  const cards = keys.map((k) => byKey.get(k)).filter((c): c is ReplyCard => !!c);

  const drafts: Record<string, string> = {};
  const WAVE = 4;
  let failed = 0;
  for (let i = 0; i < cards.length; i += WAVE) {
    const wave = cards.slice(i, i + WAVE);
    const results = await Promise.all(wave.map((c) => draftFor(c).catch(() => null)));
    results.forEach((r, j) => {
      if (r?.ok && r.draft) drafts[wave[j].key] = r.draft;
      else failed++;
    });
  }
  const made = Object.keys(drafts).length;
  return {
    ok: made > 0,
    message: made === 0 ? "Couldn't generate any drafts." : failed ? `Drafted ${made}. ${failed} need a look.` : `Drafted ${made}.`,
    drafts,
  };
}

// Send the reviewed text. A HUMAN clicks this — nothing in the reply queue
// ever sends on its own, which is the same rule every other client-facing
// message in the hub follows.
export async function sendReply(key: string, text: string, intentId?: string): Promise<{ ok: boolean; message: string; pending?: boolean }> {
  await requireAdmin();
  const body = text.trim();
  if (!body) return { ok: false, message: "Write something first." };

  // WHO IS TYPING (Sep 21 2026). Read before the send, because this is the only
  // moment the hub will ever know it. Everything after this goes out through the
  // OpenPhone API key, and that key belongs to Jordan — so the delivery echo
  // comes back carrying HIS OpenPhone user id whoever pressed Send (89 of 89
  // known hub sends carry it, 0 carry Kyle's). Until this line existed, a reply
  // Kyle wrote in the Replies tab was recorded as Jordan's and the task
  // full-view printed "Jordan Spackman" above Kyle's words. That is a worse
  // claim than the "Us" this row used to carry, because "Us" named nobody.
  // An owner in "view as" is NOT recorded: the preview is read-only, and
  // recording a send against the person being previewed would be a lie.
  const { getCurrentUser } = await import("@/lib/auth/user");
  const actor = await getCurrentUser().catch(() => null);
  const actorTeamMemberId = actor && !actor.impersonating ? actor.teamMemberId : null;

  const card = await replyCardFor(key);
  if (!card) return { ok: false, message: "That conversation has already been answered." };
  if (!card.phone) {
    return { ok: false, message: "No number on file for this conversation — reply from the Inbox tab instead." };
  }

  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  if (!intentId || !/^[A-Za-z0-9_-]{8,64}$/.test(intentId)) {
    return { ok: false, message: "Refresh the queue and try again — we couldn't identify this send, and we won't guess in case it doubles up." };
  }
  // R4 — THE SAME RAIL AS EVERY OTHER SEND. See the long note in
  // threadActions.sendThreadText: direct provider calls had no durable intent,
  // treated only a 408 as ambiguous, and sat outside the TEST-client floor.
  const { sendThroughOutbox, manualKey } = await import("@/lib/outbox");
  let sentId: string | null = null;
  try {
    const res = await sendThroughOutbox({
      channel: "sms",
      toRef: card.phone,
      body,
      dedupeKey: manualKey(intentId),
      clientId: card.clientId ?? null,
      projectId: card.projectId ?? null,
      requestedBy: actor?.email ?? actor?.name ?? null,
    });
    if (res.outcome === "accepted") {
      sentId = res.providerId ?? null;
    } else if (res.outcome === "failed") {
      return { ok: false, message: `OpenPhone refused it — ${res.error}` };
    } else if (res.outcome === "duplicate" || res.outcome === "busy") {
      return { ok: true, message: `That reply to ${card.displayName} is already going out — we didn't send it twice.` };
    } else {
      return {
        ok: false,
        pending: true,
        message: `OpenPhone didn't confirm this one, so we can't say yet whether it reached ${card.displayName}. It's saved and marked unconfirmed — give it a minute rather than sending again.`,
      };
    }
  } catch (e) {
    if ((e as Error)?.name === "TestClientSendRefusedError") return { ok: false, message: (e as Error).message };
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }

  // Log it ourselves rather than waiting on the delivery webhook. The queue's
  // "newest row is inbound" rule is what clears the card, so if the webhook is
  // slow or drops the event the message would sit there looking unanswered and
  // get sent twice.
  //
  // Stamped with the SAME externalId the webhook will use (`op-<message id>`),
  // so when message.delivered arrives a moment later logComm recognises it as
  // already-logged and swallows it. Without that id the two rows are different
  // records and comms memory ends up holding every sent reply twice.
  await logComm({
    channel: "text",
    direction: "out",
    clientId: card.clientId,
    clientName: card.clientName,
    projectId: card.projectId,
    contactName: "Us",
    fromPhone: card.phone,
    body,
    source: "openphone",
    externalId: sentId ? `op-${sentId}` : undefined,
    // The card's projectId is inherited from the task / latest inbound row —
    // often a router guess. Marking the reply a guess keeps it visible on
    // every shoot card the inbound was visible on (false-visible > hidden).
    projectGuess: true,
  }).catch(() => { /* the text is already sent; a log failure must not report failure */ });

  // …and mark the row so the delivery echo cannot put the API key owner's name
  // on it. It is marked as the HUB's words, not this person's, and that is a
  // correction to what this comment said when it was written (Sep 21 2026).
  //
  // It claimed "a draft they read, edited and approved". Nothing here knows
  // that. ReplyQueue pre-fills the textarea with the AI draft (ReplyQueue.tsx
  // sends s.draft) and Send works on it untouched, so a row stamped "the
  // person" can hold sentences the hub wrote. On its own that is a wrong byline;
  // downstream it is worse, because the comms coaching audit reads exactly this
  // shape and would coach Kyle on our draft's wording.
  //
  // The cost of refusing to claim it is one row: over 30 days 365 outbound texts
  // came from Kyle's own handset and exactly 1 went out through a hub rail. So
  // this gives up almost no signal and removes the last way a wrong name is
  // written. To earn the byline back, `sendReply` needs the draft it offered
  // alongside the text that was sent, and can then claim the person whenever the
  // two differ — a client change, deliberately not made in passing.
  if (sentId) {
    void actorTeamMemberId; // read before the send; kept for when the draft arrives
    await import("@/lib/commSenders")
      .then(({ stampCommActor }) => stampCommActor({ externalId: `op-${sentId}`, wrote: "the hub" }))
      .catch(() => { /* attribution is never a reason to report a sent text as failed */ });
  }

  // A03: already isolated, and now also REPORTED. A card that silently failed
  // to close is a card that keeps asking to be answered, and the person looking
  // at it has no way to tell that from a message that never went.
  const notLogged: string[] = [];
  if (card.clientId) {
    await closeReplyForOutbound(card.clientId, body).catch(() => { notLogged.push("this card may not have cleared"); });
    if (card.projectId) {
      await prisma.activity
        .create({ data: { projectId: card.projectId, type: "SYSTEM", body: `Text sent: ${body.slice(0, 200)}` } })
        .catch(() => { notLogged.push("it isn't on the job's timeline"); });
    }
  }

  revalidatePath("/communications");
  revalidatePath("/queue");
  if (notLogged.length) return { ok: true, message: `Sent to ${card.displayName} — but ${notLogged.join(" and ")}. The text went out; this is only our own record.` };
  return { ok: true, message: `Sent to ${card.displayName}.` };
}

// Refresh the queue after work happens elsewhere (someone replied in
// Communications, or on their phone) without a full page reload.
export async function refreshReplyQueue(): Promise<{ cards: ReplyCard[] }> {
  await requireAdmin();
  const { replyQueue } = await import("@/lib/replyQueue");
  const q = await replyQueue();
  return { cards: q.cards };
}
