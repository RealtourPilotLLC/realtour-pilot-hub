"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";

// Send the human-reviewed email reply behind a gmail-sourced task. The hub
// DRAFTS; a person reads, edits, and presses Send — this is that press. The
// reply goes out threaded (In-Reply-To/References) from the same mailbox the
// email arrived on, gets logged to comms memory, and closes the reply task.

export async function sendEmailReply(
  taskId: string,
  body: string,
  opts?: { expectedTo?: string; /** Revision acks: reply goes out but the edit work remains open. */ keepOpen?: boolean },
): Promise<{ ok: boolean; message: string; to?: string }> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "The reply is empty." };
  if (text.length > 20_000) return { ok: false, message: "That reply is too long." };

  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, source: true, sourceDetail: true, status: true, projectId: true, clientId: true, client: { select: { name: true } } },
  });
  if (!task) return { ok: false, message: "Task not found." };
  const sd = task.sourceDetail ?? "";
  if (task.source !== "gmail" || !sd.startsWith("gmail-thread:")) {
    return { ok: false, message: "This task didn't come from an email thread." };
  }
  const [, mailbox, threadId] = sd.split(":");
  if (!mailbox || !threadId) return { ok: false, message: "The email thread reference is incomplete." };
  // Oct 22 2026 (comms audit H6): no "your time is set" while a booking conflict is open for this client.
  {
    const { staffConfirmationRefusal } = await import("@/lib/bookingConflictHold");
    const refused = await staffConfirmationRefusal({ clientId: task.clientId, body: text });
    if (refused) return { ok: false, message: refused };
  }

  // Atomically CLAIM the task before sending — a stale second tab / double
  // press must never email the client twice. Reverted if the send fails.
  // keepOpen (revision acknowledgements — the edit work remains) skips the
  // claim; its double-press guard is the button's busy state.
  if (!opts?.keepOpen) {
    const claimed = await prisma.smartTask.updateMany({
      where: { id: task.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    if (claimed.count === 0) return { ok: false, message: "Already handled — this reply was sent (or the task was closed)." };
  } else if (task.status === "COMPLETED" || task.status === "CANCELLED") {
    return { ok: false, message: "Already handled." };
  }

  const { sendGmailReply } = await import("@/lib/integrations/google");
  // clientCopy (Oct 12 2026): Jordan gets a blind copy of every reply that goes
  // to a client from here — never of one to a team member (the plan skips our
  // own domain and anyone on the team).
  const sent = await sendGmailReply({ mailbox, threadId, body: text, expectedTo: opts?.expectedTo, clientCopy: true });
  if (!sent.ok) {
    if (!opts?.keepOpen) {
      await prisma.smartTask
        .updateMany({ where: { id: task.id }, data: { status: "OPEN", completedAt: null } })
        .catch(() => {});
    }
    if (sent.needsReconnect) {
      // Only Jordan can fix a missing send scope (/connections is owner-only):
      // ping him + mint the reconnect task, and don't tell an ADMIN to go do
      // something they can't open (audit finding #41). AWAITED — a floating
      // write gets killed by the serverless freeze right after this action
      // returns, which would silently lose the only ping this fix exists for.
      const { reportGmailSendBroken } = await import("@/lib/gmailHealth");
      await reportGmailSendBroken(`reply re: ${task.client?.name ?? "email task"}`, mailbox);
      const { getCurrentUser } = await import("@/lib/auth/user");
      const me = await getCurrentUser().catch(() => null);
      if (me && me.realRole !== "OWNER") {
        return { ok: false, message: "Gmail can't send yet — Jordan's been pinged to reconnect it. Reply from Gmail directly for now." };
      }
    }
    return { ok: false, message: sent.error };
  }
  // A send went through → this mailbox's scope is granted; retire its task.
  await (await import("@/lib/gmailHealth")).reportGmailSendWorking(mailbox);

  // Comms memory + project trail + close the to-do (same shape as a manual
  // reply the poller would have detected).
  const { logComm } = await import("@/lib/commLog");
  await logComm({
    channel: "email",
    direction: "out",
    clientId: task.clientId,
    clientName: task.client?.name ?? null,
    projectId: task.projectId,
    contactName: null,
    subject: sent.subject,
    body: text,
    source: "gmail",
    externalId: `hub-send-${taskId}-${Date.now()}`,
    // task.projectId's provenance is unknown (often a router guess at mint
    // time) — stamp it a guess so project-scoped surfaces don't over-trust it.
    projectGuess: true,
  }).catch(() => {});
  if (task.projectId) {
    await prisma.activity
      .create({ data: { projectId: task.projectId, type: "SYSTEM", body: `Email reply sent to ${sent.to}: ${text.slice(0, 160)}` } })
      .catch(() => {});
  }
  // A delegated email on this thread is done too (Oct 27 2026, see sendEmailThreadReply).
  if (!opts?.keepOpen) {
    const { closeDelegatedEmailTasks } = await import("@/lib/emailDelegation");
    await closeDelegatedEmailTasks({ clientId: task.clientId, subject: sent.subject, why: "sent" });
  }
  revalidatePath("/");
  revalidatePath("/tasks");
  if (task.projectId) revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: `Sent to ${sent.to} — task closed.`, to: sent.to };
}

// Resolve WHO a reply would go to — the UI shows this next to the Send button
// so the human confirms the recipient before anything leaves, and the send
// pins it (expectedTo) so a thread update between look and press can't reroute
// the reply to someone else.
export async function resolveEmailRecipient(taskId: string): Promise<{ ok: boolean; to?: string; message?: string }> {
  await requireAdmin();
  const task = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { source: true, sourceDetail: true } });
  const sd = task?.sourceDetail ?? "";
  if (!task || task.source !== "gmail" || !sd.startsWith("gmail-thread:")) {
    return { ok: false, message: "Not an email-thread task." };
  }
  const [, mailbox, threadId] = sd.split(":");
  if (!mailbox || !threadId) return { ok: false, message: "The email thread reference is incomplete." };
  const { resolveGmailReplyTarget } = await import("@/lib/integrations/google");
  const r = await resolveGmailReplyTarget(mailbox, threadId);
  return r.ok ? { ok: true, to: r.to } : { ok: false, message: r.error };
}

// ---------------------------------------------------------------------------
// REPLY TO AN EMAIL IN THE HUB (Jordan, Oct 27 2026: "I want to be able to
// respond to emails in the hub"). The reply box on a Messages · Email thread
// and on the client page's Email card. A person writes (or starts from the AI
// draft), sees who it goes to, and presses Send; that press is
// sendEmailThreadReply, and nothing else in the hub calls it. The reply goes
// out from the mailbox the email arrived in, inside the same Gmail thread
// (threadId, In-Reply-To, References, "Re:" subject, To = the other party),
// through the same sendGmailReply the task Send uses. Office only, exactly as
// every other send on Messages (requireAdmin: Jordan and Kyle, never a "view
// as" preview). Logged to the comms log (so Waiting on us clears) and on the
// client's job timeline.
// ---------------------------------------------------------------------------

/** What a reply answers. `log`: a Messages · Email thread, by the comms-log
 *  row of the email it answers. `gmail`: the client page, by the Gmail thread
 *  the client's latest email is in. */
export type EmailReplyTarget =
  | { kind: "log"; commLogId: string }
  | { kind: "gmail"; clientId: string; mailbox: string; threadId: string };

export type EmailReplyResult = { ok: boolean; message: string; to?: string; needsReconnect?: boolean };

/** The claim ledger for one press of Send (WebhookEvent provider). */
const REPLY_CLAIM = "hub-email-reply";

type ReplyThread = {
  mailbox: string;
  threadId: string;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  /** client page: the reply must go to one of these (the client's own email on file) */
  clientEmails: string[] | null;
};

async function officeOnly(): Promise<string | null> {
  try {
    await requireAdmin();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "You don't have access to do that.";
  }
}

async function viewerIsOwner(): Promise<boolean> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return !me || me.realRole === "OWNER";
}

/** Plain words for a mailbox that can read but not send. */
function cannotSendMessage(mailbox: string, owner: boolean): string {
  return owner
    ? `Gmail can read ${mailbox} but can't send from it yet. Reconnect Google in Connections and allow sending. Nothing was sent.`
    : `Gmail can read ${mailbox} but can't send from it yet. Jordan has been asked to reconnect Google. Nothing was sent; use Open in Gmail for now.`;
}

const NOT_HERE = "That email isn't in the hub any more. Refresh the page.";

async function replyThreadOf(target: EmailReplyTarget): Promise<{ ok: true; t: ReplyThread } | { ok: false; message: string; needsReconnect?: boolean }> {
  if (!target || typeof target !== "object") return { ok: false, message: NOT_HERE };
  if (target.kind === "log") {
    if (typeof target.commLogId !== "string" || !target.commLogId) return { ok: false, message: NOT_HERE };
    const row = await prisma.commLog.findUnique({
      where: { id: target.commLogId },
      select: { channel: true, direction: true, minRole: true, externalId: true, clientId: true, clientName: true, projectId: true, projectGuess: true },
    });
    if (!row || row.channel !== "email") return { ok: false, message: NOT_HERE };
    // The same tier rule as the Email view: a row this viewer can't read there
    // is not one they can answer here.
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    const { visibleEmailRoles, gmailMessageOfExternalId } = await import("@/components/comms/emailThreads");
    if (!visibleEmailRoles(me?.role ?? "OWNER").includes(row.minRole)) return { ok: false, message: NOT_HERE };
    const g = row.direction === "out" ? null : gmailMessageOfExternalId(row.externalId);
    if (!g) return { ok: false, message: "This email can only be answered in Gmail." };
    const { gmailThreadOfMessage } = await import("@/lib/integrations/google");
    const th = await gmailThreadOfMessage(g.mailbox, g.messageId);
    if (!th.ok) return { ok: false, message: th.error, needsReconnect: th.needsReconnect };
    return {
      ok: true,
      t: { mailbox: g.mailbox, threadId: th.threadId, clientId: row.clientId, clientName: row.clientName, projectId: row.projectGuess ? null : row.projectId, clientEmails: null },
    };
  }
  if (target.kind === "gmail") {
    const { clientId, mailbox, threadId } = target;
    if (typeof clientId !== "string" || !clientId || typeof mailbox !== "string" || !/^[^@\s]+@[^@\s]+$/.test(mailbox) || typeof threadId !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(threadId)) {
      return { ok: false, message: NOT_HERE };
    }
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true, email: true, backupEmail: true } });
    if (!client) return { ok: false, message: "That client isn't in the hub any more." };
    const emails = [client.email, client.backupEmail].map((e) => (e ?? "").trim().toLowerCase()).filter((e) => e.includes("@"));
    if (emails.length === 0) return { ok: false, message: "No email on file for this client." };
    return { ok: true, t: { mailbox: mailbox.toLowerCase(), threadId, clientId, clientName: client.name, projectId: null, clientEmails: emails } };
  }
  return { ok: false, message: NOT_HERE };
}

/** Who the reply goes to, read from the Gmail thread itself (the newest
 *  message that isn't ours; its Reply-To, else its From). On the client page
 *  that must be the client's own email on file. */
async function recipientOf(t: ReplyThread): Promise<{ ok: true; to: string; subject: string; from: string } | { ok: false; message: string; needsReconnect?: boolean }> {
  const { resolveGmailReplyTarget } = await import("@/lib/integrations/google");
  const r = await resolveGmailReplyTarget(t.mailbox, t.threadId);
  if (!r.ok) return { ok: false, message: r.error, needsReconnect: r.needsReconnect };
  if (t.clientEmails && !t.clientEmails.includes(r.to.toLowerCase())) {
    return { ok: false, message: `A reply in this thread would go to ${r.to}, which isn't ${t.clientName ?? "the client"}'s email on file. Answer it in Gmail.` };
  }
  return { ok: true, to: r.to, subject: r.subject, from: r.from };
}

/** The reply box's header: who it goes to, from which mailbox, under what
 *  subject, and whether that mailbox may send at all. Reads only. */
export async function prepareEmailReply(target: EmailReplyTarget): Promise<
  EmailReplyResult & { from?: string; subject?: string; canSend?: boolean | null }
> {
  const denied = await officeOnly();
  if (denied) return { ok: false, message: denied };
  const resolved = await replyThreadOf(target);
  if (!resolved.ok) return { ok: false, message: resolved.message, needsReconnect: resolved.needsReconnect };
  const rc = await recipientOf(resolved.t);
  if (!rc.ok) return { ok: false, message: rc.message, needsReconnect: rc.needsReconnect };
  const { gmailCanSend } = await import("@/lib/integrations/google");
  const canSend = await gmailCanSend(resolved.t.mailbox).catch(() => null);
  if (canSend === false) {
    return { ok: false, to: rc.to, from: rc.from, subject: rc.subject, canSend, needsReconnect: true, message: cannotSendMessage(rc.from, await viewerIsOwner()) };
  }
  return { ok: true, message: "ok", to: rc.to, from: rc.from, subject: rc.subject, canSend };
}

/** The AI draft for a Messages · Email thread: that thread as the hub logged
 *  it, through lib/emailReplyDraft (the client page's drafter). Draft only. */
export async function draftEmailThreadReply(target: EmailReplyTarget): Promise<{ ok: boolean; message: string; draft?: string }> {
  const denied = await officeOnly();
  if (denied) return { ok: false, message: denied };
  if (!target || target.kind !== "log" || typeof target.commLogId !== "string") {
    return { ok: false, message: "Use Draft reply on the client page for this one." };
  }
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to draft replies." };
  const row = await prisma.commLog.findUnique({
    where: { id: target.commLogId },
    select: { channel: true, minRole: true, subject: true, clientId: true, clientName: true, contactName: true },
  });
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const { visibleEmailRoles, emailThreadKey, EMAIL_WINDOW_DAYS } = await import("@/components/comms/emailThreads");
  const allowed = visibleEmailRoles(me?.role ?? "OWNER");
  if (!row || row.channel !== "email" || !allowed.includes(row.minRole)) return { ok: false, message: NOT_HERE };
  const key = emailThreadKey(row);
  const rows = await prisma.commLog.findMany({
    where: {
      channel: "email",
      minRole: { in: allowed },
      clientId: row.clientId ?? null,
      occurredAt: { gte: new Date(Date.now() - EMAIL_WINDOW_DAYS * 86_400_000) },
    },
    orderBy: { occurredAt: "desc" },
    take: 400,
    select: { direction: true, subject: true, body: true, occurredAt: true, clientId: true, clientName: true, contactName: true },
  });
  const thread = rows.filter((r) => emailThreadKey(r) === key).reverse();
  if (thread.length === 0) return { ok: false, message: "No email thread to reply to." };
  const transcript = thread.map((r) => ({
    role: r.direction === "out" ? ("us" as const) : ("client" as const),
    text: [r.subject, r.body].filter(Boolean).join("\n"),
    at: r.occurredAt.toISOString(),
    sender: r.direction === "out" ? null : r.contactName || r.clientName || null,
  }));
  const last = [...thread].reverse().find((r) => r.direction !== "out");
  const lastText = last ? `${last.subject ?? ""}\n${last.body}` : "";
  const { draftEmailFromTranscript } = await import("@/lib/emailReplyDraft");
  return draftEmailFromTranscript({ clientId: row.clientId, fallbackName: row.contactName ?? row.clientName, transcript, lastText });
}

/** THE SEND. Only the reply box's Send button calls this. */
export async function sendEmailThreadReply(
  target: EmailReplyTarget,
  body: string,
  intentId: string,
  expectedTo?: string | null,
): Promise<EmailReplyResult> {
  const denied = await officeOnly();
  if (denied) return { ok: false, message: denied };
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return { ok: false, message: "Write the reply first. Nothing was sent." };
  if (text.length > 20_000) return { ok: false, message: "That reply is too long." };
  if (typeof intentId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(intentId)) {
    return { ok: false, message: "Refresh the page and try again. We couldn't identify this send, and we won't guess in case it doubles up." };
  }

  const resolved = await replyThreadOf(target);
  if (!resolved.ok) return { ok: false, message: resolved.message, needsReconnect: resolved.needsReconnect };
  const t = resolved.t;
  // Oct 22 2026 (comms audit H6): no "your time is set" while a booking conflict is open for this client.
  {
    const { staffConfirmationRefusal } = await import("@/lib/bookingConflictHold");
    const refused = await staffConfirmationRefusal({ clientId: t.clientId, body: text });
    if (refused) return { ok: false, message: refused };
  }
  const rc = await recipientOf(t);
  if (!rc.ok) return { ok: false, message: rc.message, needsReconnect: rc.needsReconnect };
  if (expectedTo && expectedTo.trim().toLowerCase() !== rc.to.toLowerCase()) {
    return { ok: false, message: `The thread changed. The reply would now go to ${rc.to}, not ${expectedTo}. Close the reply and open it again.` };
  }
  // The test-client floor every other client send has (lib/outbox): a TEST
  // client is only ever written to at one of Jordan's own test inboxes.
  if (t.clientId) {
    const c = await prisma.client.findUnique({ where: { id: t.clientId }, select: { name: true } }).catch(() => null);
    const { isTestClientName, isVerifiedTestDestinationEmail } = await import("@/lib/testClients");
    if (c && isTestClientName(c.name) && !isVerifiedTestDestinationEmail(rc.to)) {
      return { ok: false, message: `Not sent: ${c.name} is a test client, and ${rc.to} isn't one of Jordan's test inboxes.` };
    }
  }

  // ONE PRESS, ONE EMAIL. The box mints this id on the first press and keeps
  // it until the words change, so a second press (a slow answer, a retry after
  // a dropped connection) finds the first one instead of emailing twice.
  const prior = await prisma.webhookEvent.findFirst({ where: { provider: REPLY_CLAIM, externalId: intentId }, select: { status: true } });
  if (prior?.status === "PROCESSED") return { ok: true, message: `Already sent to ${rc.to}. It didn't go twice.`, to: rc.to };
  if (prior) return { ok: false, message: "That reply is already going out. Give it a moment before pressing Send again." };
  const claim = await prisma.webhookEvent.create({
    data: { provider: REPLY_CLAIM, eventType: "email_reply", externalId: intentId, payload: JSON.stringify({ mailbox: t.mailbox, threadId: t.threadId }) },
  });

  const { sendGmailReply } = await import("@/lib/integrations/google");
  // clientCopy (Oct 12 2026): Jordan's blind copy of every reply to a client.
  const sent = await sendGmailReply({ mailbox: t.mailbox, threadId: t.threadId, body: text, expectedTo: rc.to, clientCopy: true });
  if (!sent.ok) {
    await prisma.webhookEvent.delete({ where: { id: claim.id } }).catch(() => {});
    if (sent.needsReconnect) {
      // Only Jordan can grant sending (/connections is owner-only). AWAITED, as
      // in sendEmailReply: a floating write dies with the serverless freeze.
      const { reportGmailSendBroken } = await import("@/lib/gmailHealth");
      await reportGmailSendBroken(`reply re: ${t.clientName ?? "an email thread"}`, t.mailbox).catch(() => {});
      return { ok: false, needsReconnect: true, message: cannotSendMessage(t.mailbox, await viewerIsOwner()) };
    }
    return { ok: false, message: `${sent.error} Nothing was sent.` };
  }
  await prisma.webhookEvent.update({ where: { id: claim.id }, data: { status: "PROCESSED", processedAt: new Date() } }).catch(() => {});
  await (await import("@/lib/gmailHealth")).reportGmailSendWorking(t.mailbox).catch(() => {});

  // The email has gone. Everything below is our own record; a failure there
  // is never reported as a failed send.
  const { getCurrentUser } = await import("@/lib/auth/user");
  const actor = await getCurrentUser().catch(() => null);
  const actorTeamMemberId = actor && !actor.impersonating ? actor.teamMemberId : null;
  const { GMAIL_SENT_SOURCE } = await import("@/lib/replyQueue");
  const { isPersonalMailbox } = await import("@/lib/integrations/google");
  const { logComm } = await import("@/lib/commLog");
  // Shaped exactly as the Gmail Sent-folder reader logs our replies (same
  // externalId, source and "Us" label), so the walk clears this thread on
  // Waiting on us now, and the next Gmail scan finds it already logged.
  await logComm({
    channel: "email",
    direction: "out",
    minRole: isPersonalMailbox(t.mailbox) && !t.clientId ? "OWNER" : undefined,
    clientId: t.clientId,
    clientName: t.clientName,
    projectId: t.projectId,
    contactName: "Us",
    subject: sent.subject,
    body: text,
    source: GMAIL_SENT_SOURCE,
    externalId: sent.id ? `gmail-sent-${t.threadId}-${sent.id}` : `hub-email-reply-${intentId}`,
    senderTeamMemberId: actorTeamMemberId,
  }).catch(() => {});
  // The client's activity: the job this thread is about, else their latest.
  const projectId = t.projectId ?? (t.clientId
    ? (await prisma.project.findFirst({
        where: { clientId: t.clientId },
        orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        select: { id: true },
      }).catch(() => null))?.id ?? null
    : null);
  if (projectId) {
    const who = actor && !actor.impersonating ? actor.name : null;
    await prisma.activity
      .create({ data: { projectId, type: "SYSTEM", authorId: actorTeamMemberId, body: `Email reply sent to ${sent.to}${who ? ` by ${who}` : ""}: ${text.slice(0, 160)}` } })
      .catch(() => {});
  }
  // The reply to-do the Gmail sync made for this thread is done (the sync's
  // own reply sweep would close it on its next pass; this is now). A work
  // order raised from the email (a revision, an edit) stays open, as there.
  await prisma.smartTask
    .updateMany({
      where: { source: "gmail", sourceDetail: `gmail-thread:${t.mailbox}:${t.threadId}`, status: { notIn: ["COMPLETED", "CANCELLED"] }, taskType: { notIn: ["revision", "edit_video"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    })
    .catch(() => {});
  // AN EMAIL HANDED ON IS DONE WHEN ITS REPLY GOES (Jordan's Loom, Oct 27 2026:
  // the email he delegated is Kyle's task, answered from Kyle's dashboard): the
  // delegated task keyed to this thread closes, with the send as its evidence.
  {
    const { closeDelegatedEmailTasks } = await import("@/lib/emailDelegation");
    await closeDelegatedEmailTasks({ clientId: t.clientId, subject: sent.subject ?? rc.subject, why: "sent", by: actor && !actor.impersonating ? actor.name : null });
  }
  revalidatePath("/communications");
  revalidatePath("/");
  if (t.clientId) revalidatePath(`/clients/${t.clientId}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: `Sent to ${sent.to}.`, to: sent.to };
}
