"use server";

import { requireAdmin, requireOwner, requireRole } from "@/lib/auth/guards";
import { appBase } from "@/lib/appUrl";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { notifyOwnerEmail } from "@/lib/integrations/google";

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

  const fb = await prisma.platformFeedback.create({
    data: {
      kind,
      title: title.slice(0, 200),
      body: input.body?.trim()?.slice(0, 4000) || null,
      submittedBy,
      page: input.page?.slice(0, 200) || null,
      screenshot,
    },
  });

  const base = appBase();
  const label = kind === "bug" ? "🐞 Bug report" : kind === "feedback" ? "💬 Feedback" : "✨ Feature request";
  const emailed = await notifyOwnerEmail(
    `${label}: ${title}`,
    [
      `${label} submitted to the RealTour hub${submittedBy ? ` by ${submittedBy}` : ""}.`,
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
  );

  // The email notify fails SILENTLY today (Gmail send scope isn't connected), so
  // a bug filed from a phone reached nobody — the board was a black hole (audit
  // crack #36). Slack is the reliable channel: always ping ops, and say so when
  // the email didn't go out. Best-effort, never blocks the submission.
  try {
    const { opsAlert, notifyInApp } = await import("@/lib/notify");
    await opsAlert(
      `${label}: “${title}”${fb.submittedBy ? ` — from ${fb.submittedBy}` : ""}${emailed ? "" : " (owner email failed — Gmail send not connected)"} → ${base}/feedback`,
    );
    // Bell: put the submission in Jordan's in-app field of view too (the email
    // path is still broken separately — Gmail send scope isn't connected).
    await notifyInApp({
      kind: "system",
      title: `Platform feedback — ${title.slice(0, 60)}`,
      href: "/feedback",
      targets: [{ roles: ["OWNER"] }],
      dedupeKey: `pf-${fb.id}`,
    });
  } catch { /* non-fatal */ }

  revalidatePath("/feedback");
  return { ok: true, message: "Thanks! Sent to Jordan for review." };
}

// Jordan approves / declines / marks done — in-app. Approved items are the queue
// Claude implements from.
export async function decidePlatformFeedback(
  id: string,
  status: "APPROVED" | "DECLINED" | "DONE" | "NEW",
  adminNote?: string,
): Promise<void> {
  await requireOwner();
  const fb = await prisma.platformFeedback.update({
    where: { id },
    data: {
      status,
      adminNote: adminNote?.trim()?.slice(0, 500) || undefined,
      decidedAt: status === "NEW" ? null : new Date(),
    },
  });
  // A decision used to go nowhere beyond the row flip (audit crack #36) — ping
  // ops so an APPROVED item actually enters someone's field of view. The board
  // itself already shows the new status (grouped sections). Best-effort.
  if (status !== "NEW") {
    try {
      const { opsAlert } = await import("@/lib/notify");
      const base = appBase();
      const verb = status === "APPROVED" ? "✅ approved — into the build queue" : status === "DONE" ? "🚀 marked shipped" : "🗄 declined";
      await opsAlert(`Feedback “${fb.title}” ${verb}${fb.submittedBy ? ` (filed by ${fb.submittedBy})` : ""} → ${base}/feedback`);
    } catch { /* non-fatal */ }
  }
  revalidatePath("/feedback");
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
  const url = `${appBase()}/feedback`;
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
