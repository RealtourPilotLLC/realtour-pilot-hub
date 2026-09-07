"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";

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
