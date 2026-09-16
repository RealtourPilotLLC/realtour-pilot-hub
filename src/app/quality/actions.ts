"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";
import { feedbackTaskKey } from "@/lib/feedback";

// Mark one piece of client feedback handled (or put it back). `Feedback.resolved`
// has existed since the model was written and nothing has ever set it — an
// unhappy client stayed "open" forever with no way to close the loop, so the
// Unhandled count on /quality could only ever go up. Owner/admin only, same as
// the page. The NEGATIVE ones also raise an URGENT SmartTask (see
// recordFeedback); this flag is the record on the feedback row itself.
export async function setFeedbackHandled(id: string, handled: boolean): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to do that." };
  }
  // The WRITE has to be inside a try too. With only requireAdmin() guarded, a
  // failed update (row deleted under them, a Neon blip, a pool timeout) threw
  // past the return, the transition settled, and the optimistic button sat
  // there reading "Handled" on a row that never saved — the exact "looks like
  // it saved" lie the guard above was added to stop.
  try {
    await prisma.feedback.update({ where: { id }, data: { resolved: handled } });
  } catch (e) {
    console.error("[quality] setFeedbackHandled failed", { id, handled, error: e });
    const gone = e instanceof Error && "code" in e && (e as { code?: string }).code === "P2025";
    return {
      ok: false,
      message: gone ? "That feedback is no longer there — refresh the page." : "That didn't save. Try again.",
    };
  }
  revalidatePath("/quality");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// REPLYING TO THE AGENT (Jordan, Sep 7 2026): "add the ability to write an email
// response to the agent, thanking them for their feedback and addressing their
// feedback for 'Would like done differently'."
//
// Feedback arrives through the public form, so there is no email thread to
// reply into — this composes a new one to the address on their client record.
// The draft is written here rather than by a model call so it is instant and
// predictable; the owner edits it before it goes anywhere, and nothing sends
// without them pressing Send.
// ---------------------------------------------------------------------------

/** A first draft that thanks them and answers what they actually raised. */
export async function draftFeedbackReply(feedbackId: string): Promise<{ ok: boolean; to?: string; subject?: string; body?: string; message?: string }> {
  await requireAdmin();
  const fb = await prisma.feedback.findUnique({
    where: { id: feedbackId },
    select: {
      improveNote: true, photographerNote: true, contentNote: true, body: true,
      photographerRating: true, contentRating: true, rating: true, attribution: true,
      authorName: true,
      project: { select: { title: true, client: { select: { name: true, email: true } } } },
    },
  });
  if (!fb) return { ok: false, message: "That feedback is gone." };
  const to = fb.project?.client?.email ?? null;
  if (!to) return { ok: false, message: "No email address on this client's record — add one on their client page first." };

  const street = (fb.project?.title ?? "your listing").split(",")[0];
  const first = (fb.authorName || fb.project?.client?.name || "there").split(" ")[0];
  const ask = (fb.improveNote ?? "").trim();
  const praise = (fb.photographerNote ?? "").trim();

  // What we say about the ask depends on WHOSE it is — a turnaround or spelling
  // complaint gets an operations answer, not "I'll pass it to your photographer".
  const answer =
    !ask ? null
    : fb.attribution === "OPERATIONS"
      ? `You mentioned: “${ask}”\n\nThat one is on us in post-production, not on the crew who shot the property, and it is the right thing to raise. I have taken it to our editing side directly — we are tightening the turnaround on reels and adding a second read on every title card and caption before anything goes out.`
    : fb.attribution === "ONSITE"
      ? `You mentioned: “${ask}”\n\nI have taken that straight to the photographer who shot ${street}, and it is going into how we brief the next one for you.`
      : `You mentioned: “${ask}”\n\nI have taken that back to the team, and it is going into how we run the next one for you.`;

  const body = [
    `Hi ${first},`,
    "",
    `Thank you for taking the time to send that back to us on ${street} — the notes are genuinely useful, and I read every one of them myself.`,
    ...(praise ? ["", `I passed on what you said about the shoot itself — that gets to the person who earned it.`] : []),
    ...(answer ? ["", answer] : []),
    "",
    "If anything else comes up on this one, reply straight to this email and it comes to me.",
    "",
    "Thanks again,",
    "Jordan",
    "RealTour Pilot",
  ].join("\n");

  return { ok: true, to, subject: `Thank you for your feedback — ${street}`, body };
}

/** Send it, and record that we did. */
export async function sendFeedbackReply(
  feedbackId: string,
  body: string,
  to: string,
  subject: string,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const me = await getCurrentUser().catch(() => null);
  const text = body.trim();
  if (text.length < 20) return { ok: false, message: "Write a bit more before sending." };
  const { sendGmailNew } = await import("@/lib/integrations/google");
  const res = await sendGmailNew({ mailbox: "info@realtourpilot.com", to, subject, body: text });
  if (!res.ok) return { ok: false, message: res.error };
  const who = (me as { name?: string | null; email?: string } | null)?.name ?? (me as { email?: string } | null)?.email ?? "the office";
  await prisma.feedback.update({
    where: { id: feedbackId },
    data: { repliedAt: new Date(), replyBody: text.slice(0, 4000), replyBy: who },
  });
  const fb = await prisma.feedback.findUnique({ where: { id: feedbackId }, select: { projectId: true } });
  if (fb?.projectId) {
    await prisma.activity.create({
      data: { projectId: fb.projectId, type: "NOTE", body: `Replied to the client's feedback by email (${to}).` },
    }).catch(() => {});
  }
  revalidatePath("/quality");
  return { ok: true, message: `Sent to ${res.to}.` };
}

// ---------------------------------------------------------------------------
// CORRECTING WHAT THE HUB READ (Sep 16, Kyle call, item 10). Jamie's "still
// waiting on 2844 Edgemont Dr" text sat on /quality as "Unhappy" for eleven
// weeks because the only levers were Mark handled (clears the tile, keeps the
// badge and the count) and deleting the row. Two corrections, both keeping the
// original: re-read the sentiment (Unhappy / Neutral / Happy) with who/when/
// why, or dismiss the row as "not feedback" with a reason and an undo.
//
// `sentiment` stays the one column every count reads, so a human's value is
// honoured everywhere the moment it is written; `sentimentAuto` keeps what the
// classifier said. Once sentimentBy is set no classifier pass may re-decide
// it — the same rule attributionBy already has.
// ---------------------------------------------------------------------------

export type SentimentValue = "POSITIVE" | "NEUTRAL" | "NEGATIVE";
const SENTIMENTS = new Set<SentimentValue>(["POSITIVE", "NEUTRAL", "NEGATIVE"]);

async function whoAmI(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  return (me as { name?: string | null; email?: string } | null)?.name ?? (me as { email?: string } | null)?.email ?? "the office";
}

// Correcting a row has to clear the URGENT card it minted. recordFeedback puts
// a "Resolve client feedback" SmartTask on Kyle's queue for every NEGATIVE row;
// re-read that row as Neutral/Happy, or dismiss it as not feedback, and the
// card used to stand there with nothing behind it (Sep 16 review). Best-effort
// — the correction on the feedback row is what matters.
async function closeFeedbackTask(feedbackId: string): Promise<void> {
  try {
    await prisma.smartTask.updateMany({
      where: { dedupeKey: feedbackTaskKey(feedbackId), status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  } catch (e) {
    console.error("[quality] closeFeedbackTask failed", { feedbackId, error: e });
  }
}

function saveFailure(e: unknown, what: string): { ok: false; message: string } {
  console.error(`[quality] ${what} failed`, e);
  const gone = e instanceof Error && "code" in e && (e as { code?: string }).code === "P2025";
  return { ok: false, message: gone ? "That feedback is no longer there — refresh the page." : "That didn't save. Try again." };
}

/** Owner/admin re-reads a row's sentiment. The hub's own read is kept in sentimentAuto. */
export async function setFeedbackSentiment(
  feedbackId: string,
  sentiment: SentimentValue,
  note?: string | null,
): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to do that." };
  }
  if (!SENTIMENTS.has(sentiment)) return { ok: false, message: "That isn't a sentiment." };
  const who = await whoAmI();
  const why = (note ?? "").trim().slice(0, 300) || null;
  try {
    // Read-then-write so the FIRST override backfills sentimentAuto from the
    // value the classifier left — rows written before Sep 16 carry no auto
    // column, and the provenance line needs "read as Unhappy by the hub".
    const cur = await prisma.feedback.findUnique({ where: { id: feedbackId }, select: { sentiment: true, sentimentAuto: true } });
    if (!cur) return { ok: false, message: "That feedback is no longer there — refresh the page." };
    await prisma.feedback.update({
      where: { id: feedbackId },
      data: {
        sentiment,
        sentimentAuto: cur.sentimentAuto ?? cur.sentiment ?? null,
        sentimentBy: who,
        sentimentAt: new Date(),
        sentimentNote: why,
      },
    });
  } catch (e) {
    return saveFailure(e, "setFeedbackSentiment");
  }
  // No longer unhappy → Kyle's URGENT "resolve this" card has nothing to resolve.
  if (sentiment !== "NEGATIVE") {
    await closeFeedbackTask(feedbackId);
  }
  revalidatePath("/quality");
  revalidatePath("/tasks");
  return { ok: true };
}

/** "Not feedback" — hidden from every count, row kept, undo below. */
export async function dismissFeedback(feedbackId: string, reason: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to do that." };
  }
  const why = (reason ?? "").trim().slice(0, 300);
  if (!why) return { ok: false, message: "Say why it isn't feedback." };
  const who = await whoAmI();
  try {
    await prisma.feedback.update({
      where: { id: feedbackId },
      data: { dismissedAt: new Date(), dismissedBy: who, dismissReason: why },
    });
  } catch (e) {
    return saveFailure(e, "dismissFeedback");
  }
  await closeFeedbackTask(feedbackId);
  revalidatePath("/quality");
  revalidatePath("/tasks");
  return { ok: true };
}

export async function undismissFeedback(feedbackId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to do that." };
  }
  try {
    await prisma.feedback.update({
      where: { id: feedbackId },
      data: { dismissedAt: null, dismissedBy: null, dismissReason: null },
    });
  } catch (e) {
    return saveFailure(e, "undismissFeedback");
  }
  revalidatePath("/quality");
  return { ok: true };
}

/** Owner/admin overrules the on-site vs operations call. */
export async function setFeedbackAttribution(
  feedbackId: string,
  attribution: "ONSITE" | "OPERATIONS" | "MIXED",
): Promise<{ ok: boolean; message?: string }> {
  await requireAdmin();
  const me = await getCurrentUser().catch(() => null);
  const who = (me as { name?: string | null; email?: string } | null)?.name ?? (me as { email?: string } | null)?.email ?? "the office";
  await prisma.feedback.update({
    where: { id: feedbackId },
    data: {
      attribution,
      attributionBy: who,
      attributionWhy:
        attribution === "OPERATIONS" ? "set by hand — after the shoot, not the photographer"
        : attribution === "ONSITE" ? "set by hand — at the property"
        : "set by hand — both on site and after",
    },
  });
  revalidatePath("/quality");
  return { ok: true };
}
