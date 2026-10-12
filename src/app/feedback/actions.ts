"use server";

import { requireAdmin, requireOwner, requireRole } from "@/lib/auth/guards";
import { appBase } from "@/lib/appUrl";

import { prisma } from "@/lib/prisma";
import { after } from "next/server";
import { notifyOwnerEmail } from "@/lib/integrations/google";
import { notifyInApp, opsAlert } from "@/lib/notify";

// ---------------------------------------------------------------------------
// ANSWER FIRST, NOTIFY AFTER (Oct 12 2026). Jordan pressed Approve on Kyle's
// two bug cards and both spun until he reloaded, though both rows had saved
// (decidedAt 18:43:07 / 18:43:13 UTC). The decision awaited a Slack post
// before answering, and revalidatePath("/feedback") made the browser drop its
// whole prefetch cache and re-render every sidebar page (~20 dynamic renders
// per click, in the logs) while the button's transition waited on the
// refresh. Now: the row is written, the answer goes back at once, and the
// Slack/email/bell work runs after the response. The board updates its own
// card from the answer (it is a force-dynamic page — every visit reads fresh),
// so no path is revalidated here.
// ---------------------------------------------------------------------------
async function later(fn: () => Promise<unknown>): Promise<void> {
  const safe = () => fn().then(() => undefined, () => undefined);
  try { after(safe); } catch { await safe(); }
}

// A platform user submits feedback / a feature request / a bug. We record it and
// best-effort email Jordan so he can approve it (in-app). Never throws on the
// notify step — the record is what matters.
export async function submitPlatformFeedback(input: {
  kind: string; // feature | bug | feedback
  title: string;
  body?: string;
  submittedBy?: string;
  page?: string;
  screenshot?: string; // data URL (image/jpeg|png)
}): Promise<{ ok: boolean; message: string }> {
  // Any signed-in staff member may file platform feedback (this was the one
  // staff-facing write with no login check). NOTE: the PUBLIC client feedback
  // form is a different action (/feedback/[id] → submitFeedback) and stays
  // unauthenticated. Returned as {ok:false} so the widget shows it inline.
  try {
    await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Please sign in to do that." };
  }
  const title = input.title.trim();
  if (!title) return { ok: false, message: "Add a short title." };
  const kind = ["feature", "bug", "feedback"].includes(input.kind) ? input.kind : "feature";

  // WHO filed it — everyone is logged in now, so stamp the SESSION identity
  // instead of trusting the widget's optional free-text name (which was left
  // blank; Jordan couldn't tell who asked for what). The typed name survives
  // as a fallback for local dev with enforcement off.
  let submittedBy = input.submittedBy?.trim()?.slice(0, 120) || null;
  try {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const u = await getCurrentUser();
    if (u) submittedBy = u.name ?? u.email;
  } catch { /* sessionless local dev — keep the typed name */ }

  // Only keep a reasonable image (cap ~3MB of data URL) so the row stays sane.
  const screenshot =
    input.screenshot && /^data:image\/(png|jpeg);base64,/.test(input.screenshot) && input.screenshot.length < 3_500_000
      ? input.screenshot
      : null;

  let fb;
  try {
    fb = await prisma.platformFeedback.create({
      data: {
        kind,
        title: title.slice(0, 200),
        body: input.body?.trim()?.slice(0, 4000) || null,
        submittedBy,
        page: input.page?.slice(0, 200) || null,
        screenshot,
      },
    });
  } catch {
    return { ok: false, message: "That didn't save. Try again in a moment." };
  }

  const base = appBase();
  const label = kind === "bug" ? "🐞 Bug report" : kind === "feedback" ? "💬 Feedback" : "✨ Feature request";
  const filedBy = fb.submittedBy;
  const fbId = fb.id;
  // After the answer: the submitter is never kept waiting on Gmail or Slack.
  await later(async () => {
    const emailed = await notifyOwnerEmail(
      `${label}: ${title}`,
      [
        `${label} submitted to the Realtour hub${submittedBy ? ` by ${submittedBy}` : ""}.`,
        "",
        `Title: ${title}`,
        input.body ? `\nDetails:\n${input.body}` : "",
        input.page ? `\nWhere: ${input.page}` : "",
        screenshot ? "\n📎 Screenshot attached — view it on the board." : "",
        "",
        `Review & approve here: ${base}/feedback`,
        "",
        "Approve it there and it goes into the build queue.",
      ].join("\n"),
    ).catch(() => false);

    // The email notify fails SILENTLY today (Gmail send scope isn't connected), so
    // a bug filed from a phone reached nobody — the board was a black hole (audit
    // crack #36). Slack is the reliable channel: always ping ops, and say so when
    // the email didn't go out. Best-effort, never blocks the submission.
    await opsAlert(
      `${label}: “${title}”${filedBy ? ` — from ${filedBy}` : ""}${emailed ? "" : " (owner email failed — Gmail send not connected)"} → ${base}/feedback`,
    );
    // Bell: put the submission in Jordan's in-app field of view too (the email
    // path is still broken separately — Gmail send scope isn't connected).
    await notifyInApp({
      kind: "system",
      title: `Platform feedback — ${title.slice(0, 60)}`,
      href: "/feedback",
      targets: [{ roles: ["OWNER"] }],
      dedupeKey: `pf-${fbId}`,
    });
  });

  return { ok: true, message: "Thanks! Sent to Jordan for review." };
}

// Jordan approves / declines / marks done — in-app. Approved items are the queue
// Claude implements from.
export type FeedbackDecision = "APPROVED" | "DECLINED" | "DONE" | "NEW";
const DECISIONS: readonly FeedbackDecision[] = ["APPROVED", "DECLINED", "DONE", "NEW"];

export async function decidePlatformFeedback(
  id: string,
  status: FeedbackDecision,
  adminNote?: string,
): Promise<{ ok: boolean; message: string; status?: FeedbackDecision }> {
  // Every failure comes back as words on the card (a thrown error in
  // production is redacted to a generic digest).
  try {
    await requireOwner();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Only Jordan can decide feedback." };
  }
  if (!DECISIONS.includes(status)) return { ok: false, message: "That isn't a decision the board knows." };
  let fb;
  try {
    fb = await prisma.platformFeedback.update({
      where: { id },
      data: {
        status,
        adminNote: adminNote?.trim()?.slice(0, 500) || undefined,
        decidedAt: status === "NEW" ? null : new Date(),
      },
      select: { kind: true, title: true, submittedBy: true },
    });
  } catch {
    return { ok: false, message: "That didn't save. The item may have been removed. Reload the board." };
  }
  // A decision used to go nowhere beyond the row flip (audit crack #36) — ping
  // ops so an APPROVED item actually enters someone's field of view. After the
  // answer, best-effort.
  if (status !== "NEW") {
    await later(async () => {
      const base = appBase();
      const verb = status === "APPROVED" ? "✅ approved — into the build queue" : status === "DONE" ? "🚀 marked shipped" : "🗄 declined";
      // Field flags moved to the quality desk — link people at the board the
      // row is actually ON, or the Slack link lands on a page without it.
      const where = fb.kind === "field_issue" ? "/quality?tab=photographers" : "/feedback";
      await opsAlert(`Feedback “${fb.title}” ${verb}${fb.submittedBy ? ` (filed by ${fb.submittedBy})` : ""} → ${base}${where}`);
    });
  }
  const said = status === "APPROVED" ? "Approved." : status === "DECLINED" ? "Declined." : status === "DONE" ? "Marked shipped." : "Back in review.";
  return { ok: true, message: said, status };
}

// ---------------------------------------------------------------------------
// "Look into this" — ping a teammate on Slack about a feedback item. The
// message is FROM the logged-in person (Jordan pings AS Jordan — he is not
// Kyle), TO any active team member; Slack id resolves from email on first
// use and is remembered. Falls back to the ops alert channel when a DM can't
// be opened, so the ping never silently vanishes.
// ---------------------------------------------------------------------------
export async function pingFeedbackOnSlack(
  feedbackId: string,
  teamMemberId: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const [row, member, me] = await Promise.all([
    prisma.platformFeedback.findUnique({ where: { id: feedbackId }, select: { title: true, body: true, kind: true, submittedBy: true, createdAt: true } }),
    prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { id: true, name: true, email: true, slackId: true } }),
    (await import("@/lib/auth/user")).getCurrentUser().catch(() => null),
  ]);
  if (!row || !member) return { ok: false, message: "Item or person not found." };
  const sender = me?.name?.split(/\s+/)[0] ?? "Jordan";
  const { etDateTime } = await import("@/lib/datetime");
  // Field flags live on the quality desk now, everything else on the board.
  const url = `${appBase()}${row.kind === "field_issue" ? "/quality?tab=photographers" : "/feedback"}`;
  const text =
    `👀 *${sender}* asked you to look into this ${row.kind === "bug" ? "bug" : row.kind === "field_issue" ? "field issue" : "request"}:\n` +
    `*${row.title}*\n` +
    (row.body ? `> ${row.body.slice(0, 280).replace(/\n/g, "\n> ")}\n` : "") +
    `_Received ${etDateTime(row.createdAt)}${row.submittedBy ? ` from ${row.submittedBy}` : ""}_\n` +
    (note?.trim() ? `\n${sender}: ${note.trim().slice(0, 500)}\n` : "") +
    `\n${url}`;

  const { slackUserByEmail, slackDmUser, slackNotify } = await import("@/lib/integrations/slack");
  let slackId = member.slackId;
  if (!slackId) {
    slackId = await slackUserByEmail(member.email);
    if (slackId) await prisma.teamMember.update({ where: { id: member.id }, data: { slackId } });
  }
  if (slackId && (await slackDmUser(slackId, text))) {
    return { ok: true, message: `Pinged ${member.name.split(/\s+/)[0]} on Slack.` };
  }
  // No DM possible → the ops channel, addressed by name, so it still lands.
  const { alertDestination } = await import("@/lib/notify");
  const sent = await slackNotify(await alertDestination(), `@${member.name} ` + text).catch(() => false);
  return sent
    ? { ok: true, message: `No Slack DM for ${member.name.split(/\s+/)[0]} — posted to the ops channel instead.` }
    : { ok: false, message: `Couldn't reach Slack — is it still connected?` };
}

// Active teammates for the ping picker.
export async function listPingTargets(): Promise<{ id: string; name: string }[]> {
  try { await requireAdmin(); } catch { return []; }
  const members = await prisma.teamMember.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return members;
}
