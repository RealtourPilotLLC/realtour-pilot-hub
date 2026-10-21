import "server-only";
import { prisma } from "@/lib/prisma";
import { clip } from "@/lib/text";
import { appBase } from "@/lib/appUrl";
import { isTestClientName, isVerifiedTestDestinationEmail } from "@/lib/testClients";
import { endOfBusinessDaysET } from "@/lib/datetime";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { can, actorLabel, refusalMessage } from "@/lib/portalAccess";
import { ownersFor, type DutyOwner } from "@/lib/contentProgram";
import { URGENT_CONTACT } from "@/lib/reviewWindows";
// Type only: the component module itself imports next/link and lucide, which a
// server module (a cron, a drill under react-server) must not load.
import type { PortalContact } from "@/components/portal/ContactTeam";
import { OFFICE_LINE } from "@/lib/portalWords";
import type { PortalViewer } from "@/lib/portal";
import type { NotifyTarget } from "@/lib/notify";
import type { ReachRefusalCode, ReachTier } from "@/lib/programRolloutCore";

// ---------------------------------------------------------------------------
// THE PROGRAM CONVERSATION (CP-13, completion audit, Sep 24 2026).
//
// What the audit found: the portal had three conversations, each nailed to one
// object — a topic's discussion, a script suggestion, a note on a cut — and no
// place to say anything else. Every other portal signal was ownerBell(), an
// hour-bucketed OWNER+ADMIN broadcast with no assignee, no unread state, no
// reply and no task. So a client with a general question had a footer that
// said "Text us any time" and nothing to text.
//
// One conversation per enrollment, and three rules it keeps:
//
//   1. IT HAS AN OWNER. Every client message is assigned to whoever holds the
//      MESSAGES duty for that enrollment (ProgramOwnerAssignment, Kyle by
//      default) at the moment it arrives. For a real client that is also ONE
//      SmartTask per account, refreshed by each new message and closed by the
//      reply — never taskType client_reply, which the reply queue auto-closes
//      the moment ANY text goes out to the client (tasks.ts).
//   2. A VIDEO CHANGE REOPENS THE VIDEO (Oct 14 2026; it used to be stored
//      as a message only). Jordan: a change asked "in the content program
//      portal" reopens the video for revisions "just as the normal review
//      process is". A message that reads like a video change ("the music at
//      0:12") AND names the video, or comes from a client with exactly one
//      approved video in the last 45 days, reopens that video and goes to its
//      editor as a revision (lib/cutReopen, raiseRevisionDetailed pinned to
//      the cut). It stays a message too, so the office still answers it.
//      Unclear which video: stored as a message with the chip, and moving it
//      is a person's decision, as before.
//   3. NOTHING HERE MESSAGES A CLIENT UNLESS A SWITCH SAYS SO. The staff side is
//      internal and live: a bell row for the owner, the desk task, and since
//      Oct 20 2026 a post to the ops Slack channel plus a text to the owner and
//      Jordan with the reply link (alertOffice; Jordan asked for both).
//      `program_message` is still NOT mapped in notifyPrefs.KIND_TO_EVENT: the
//      bell row itself pages nobody, alertOffice does it once. The email telling a
//      client "Kyle replied" is `program_message_notice`, which is OFF, and
//      when it is on it rides the outbox with its TEST-client floor and the
//      Mon–Fri-before-4:30 client window.
//
// READ STATE is a watermark per reader (ProgramMessageRead): `cu:<clientUserId>`
// for a signed-in person, `tok` for the shared link (one marker for everyone
// who holds it — the link carries no person), `au:<appUserId>` for staff. Staff
// viewing through the owner iframe mark THEIR key, never the client's.
// ---------------------------------------------------------------------------

export const MESSAGE_BODY_MAX = 4000;
/** Client-authored messages per account per 24 hours — a conversation, not a firehose. */
export const MESSAGE_DAILY_CAP = 20;
export const PROGRAM_MESSAGE_TASK_PREFIX = "program-message:";
/** The switch for the client-facing "you have a reply" email. Missing row = off. */
export const NOTICE_KEY = "program_message_notice" as const;
/** How far back a newly enabled notice switch reaches. */
const NOTICE_LOOKBACK_MS = 3 * 86_400_000;
/** A seat whose notice keeps failing (Gmail disconnected) stops being retried after this many. */
const NOTICE_MAX_TRIES = 3;
const NOTICE_BY = "program-message-notice";
const TASK_DONE = ["COMPLETED", "CANCELLED", "DONE", "CLOSED"];

/**
 * Shown under the composer, always, and repeated after a send that reads like
 * a video change. Names no page (Sep 24): v1 calls the list "My Videos", v2
 * "Content Library", and this line is written once for both.
 */
export const VIDEO_CHANGES_HINT =
  "Changes to a video go on the video itself: open the video, pause where you want the change and leave a note. That sends it straight to your editor.";

export type ProgramMessageRef = { kind: "TOPIC" | "SCRIPT" | "VIDEO"; id: string };
type Result = { ok: boolean; message: string; id?: string };
const fail = (message: string): Result => ({ ok: false, message });

/**
 * What a missing `portal-contact` row means: Kyle, the office line (Jordan,
 * Sep 24). The same values as components/portal/ContactTeam's
 * DEFAULT_PORTAL_CONTACT, which the client components use for their own error
 * sentences; the cp13 drill asserts the two copies agree.
 */
export const DEFAULT_OFFICE_CONTACT: PortalContact = { name: OFFICE_LINE.name, display: URGENT_CONTACT, e164: OFFICE_LINE.e164 };
const contactLine = (c: PortalContact) => `call or text ${c.name} at ${c.display}`;

/** The owner-editable office contact (AppSetting `portal-contact`), or Kyle. */
export async function portalContact(): Promise<PortalContact> {
  const row = await prisma.appSetting.findUnique({ where: { key: "portal-contact" } }).catch(() => null);
  if (!row?.value) return DEFAULT_OFFICE_CONTACT;
  try {
    const v = JSON.parse(row.value) as { name?: unknown; phoneE164?: unknown; display?: unknown };
    const name = typeof v.name === "string" ? v.name.trim() : "";
    const e164 = typeof v.phoneE164 === "string" ? v.phoneE164.trim() : "";
    // A malformed row must never print a broken number to a client: anything
    // that is not a +1 ten-digit line falls back to the default whole.
    if (!name || !/^\+1\d{10}$/.test(e164)) return DEFAULT_OFFICE_CONTACT;
    const display = typeof v.display === "string" && v.display.trim() ? v.display.trim() : `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
    return { name: name.split(/\s+/)[0], display, e164 };
  } catch {
    return DEFAULT_OFFICE_CONTACT;
  }
}

/** Whose "seen up to" this viewer moves. */
export function readerKeyFor(viewer: PortalViewer): string {
  const a = viewer.actor;
  if (a.kind === "CLIENT") return `cu:${a.clientUserId}`;
  if (a.kind === "STAFF") return `au:${a.staffUserId}`;
  return "tok";
}

async function watermark(enrollmentId: string, readerKey: string): Promise<Date | null> {
  const r = await prisma.programMessageRead.findUnique({ where: { enrollmentId_readerKey: { enrollmentId, readerKey } }, select: { seenAt: true } });
  return r?.seenAt ?? null;
}

/**
 * Move a reader's watermark forward (never back). createMany/skipDuplicates
 * then a guarded updateMany rather than upsert: Postgres runs both as plain
 * statements, two tabs racing on first read both succeed, and nothing depends
 * on how Prisma chooses to compile an upsert.
 */
export async function markThreadRead(enrollmentId: string, readerKey: string, at: Date = new Date()): Promise<void> {
  await prisma.programMessageRead.createMany({ data: [{ enrollmentId, readerKey, seenAt: at }], skipDuplicates: true });
  await prisma.programMessageRead.updateMany({ where: { enrollmentId, readerKey, seenAt: { lt: at } }, data: { seenAt: at } });
}

/** STAFF messages this reader has not seen — the client's unread count. */
export async function unreadForReader(enrollmentId: string, readerKey: string): Promise<number> {
  const seen = await watermark(enrollmentId, readerKey);
  return prisma.programMessage.count({ where: { enrollmentId, authorKind: "STAFF", ...(seen ? { createdAt: { gt: seen } } : {}) } });
}

/** CLIENT messages nobody has answered or set aside — the staff badge. */
export async function unansweredCount(enrollmentId: string): Promise<number> {
  return prisma.programMessage.count({ where: { enrollmentId, authorKind: "CLIENT", handledAt: null } });
}

/** Threads with an unanswered client message assigned to this person — "Kyle's unread". */
export async function unreadThreadsForStaff(appUserId: string): Promise<{ enrollmentId: string; unanswered: number; oldestAt: Date }[]> {
  const rows = await prisma.programMessage.groupBy({
    by: ["enrollmentId"],
    where: { assignedAppUserId: appUserId, authorKind: "CLIENT", handledAt: null },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  return rows
    .map((r) => ({ enrollmentId: r.enrollmentId, unanswered: r._count._all, oldestAt: r._min.createdAt ?? new Date(0) }))
    .sort((a, b) => a.oldestAt.getTime() - b.oldestAt.getTime());
}

/** Prove a reference is this enrollment's — the same doors the portal's own actions use. */
async function verifyRef(enrollment: { id: string; clientId: string }, ref: ProgramMessageRef): Promise<ProgramMessageRef | null> {
  if (ref.kind === "TOPIC") {
    const { topicForEnrollment } = await import("@/lib/portal");
    return (await topicForEnrollment(enrollment.id, ref.id)) ? ref : null;
  }
  if (ref.kind === "SCRIPT") {
    const { scriptForEnrollment } = await import("@/lib/portal");
    return (await scriptForEnrollment(enrollment.id, ref.id)) ? ref : null;
  }
  if (ref.kind === "VIDEO") {
    const { videoForEnrollment } = await import("@/lib/contentVideos");
    return (await videoForEnrollment(enrollment, ref.id)) ? ref : null;
  }
  return null;
}

/** The TeamMember behind an AppUser — the key a person-addressed bell row needs. */
async function teamMemberFor(appUserId: string): Promise<{ id: string; role: string } | null> {
  const u = await prisma.appUser.findUnique({ where: { id: appUserId }, select: { teamMemberId: true, email: true, role: true } });
  if (!u) return null;
  const tm = u.teamMemberId
    ? await prisma.teamMember.findUnique({ where: { id: u.teamMemberId }, select: { id: true } })
    : await prisma.teamMember.findFirst({ where: { email: { equals: u.email, mode: "insensitive" } }, select: { id: true } });
  return tm ? { id: tm.id, role: u.role } : null;
}

/**
 * The owner's bell, once per unanswered run. The dedupeKey is the FIRST
 * unanswered message of the run, so two messages racing into an empty thread
 * collide on the same row instead of ringing twice.
 */
async function announce(e: { id: string; clientName: string }, owner: DutyOwner, firstUnansweredId: string, excerpt: string): Promise<void> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const targets: NotifyTarget[] = [];
    const tm = owner.appUserId ? await teamMemberFor(owner.appUserId) : null;
    if (tm) {
      const role = tm.role === "OWNER" ? "OWNER" : "ADMIN";
      targets.push({ roles: [role], userKey: `tm:${tm.id}` });
      // Jordan hears about every client message; when he IS the owner, his
      // own row already does that and a broadcast would ring him twice.
      if (role !== "OWNER") targets.push({ roles: ["OWNER"] });
    } else {
      // No roster row to address: the office as a whole, so it is not lost.
      targets.push({ roles: ["OWNER", "ADMIN"] });
    }
    await notifyInApp({
      kind: "program_message",
      title: `Message from ${e.clientName || "a program client"}`,
      body: excerpt,
      href: `/content/${e.id}?tab=messages`,
      targets,
      dedupeKey: `program-msg-${e.id}-${firstUnansweredId}`,
    });
  } catch { /* the bell is best-effort; the task is the record */ }
}

/**
 * A TEXT AND A SLACK POST FOR A CLIENT'S MESSAGE (Oct 20 2026). Jordan: "when
 * a client messages us on the portal we need a text and slack message with a
 * link to respond to the message." The bell alone (above) was the only signal,
 * by design until now. Each new message posts to the ops Slack channel and
 * texts the account's MESSAGES owner and Jordan, every line carrying the link
 * to the reply box. A burst is one conversation: a thread alerts at most once
 * per ALERT_EVERY_MS. Kyle's roster phone IS the office line, which cannot be
 * texted, so he hears it on Slack. A person inside their own quiet time gets
 * the text when it ends. Never for a TEST client.
 */
const ALERT_EVERY_MS = 10 * 60_000;
async function alertOffice(e: { id: string; clientName: string }, owner: DutyOwner, body: string, now: Date): Promise<void> {
  if (isTestClientName(e.clientName)) return;
  const key = `program-msg-alert:${e.id}`;
  const prev = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } }).catch(() => null);
  if (prev && now.getTime() - Date.parse(prev.value) < ALERT_EVERY_MS) return;
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: now.toISOString() }, update: { value: now.toISOString() } });

  const link = `${appBase()}/content/${e.id}?tab=messages`;
  const line = `New portal message from ${e.clientName || "a program client"}: “${clip(body.replace(/\s+/g, " "), 160)}” Reply here: ${link}`;
  const { opsAlert, queueStaffSms, logDelivery } = await import("@/lib/notify");
  await opsAlert(`💬 ${line}`).catch(() => false);

  // The texts: the MESSAGES owner and Jordan (once when he is the owner).
  const ids = new Set<string>();
  const ownerTm = owner.appUserId ? await teamMemberFor(owner.appUserId).catch(() => null) : null;
  if (ownerTm) ids.add(ownerTm.id);
  const jordan = await prisma.teamMember.findFirst({ where: { name: { startsWith: "Jordan" }, active: true }, select: { id: true } }).catch(() => null);
  if (jordan) ids.add(jordan.id);
  if (!ids.size) return;
  const [members, op, sched, sms] = await Promise.all([
    prisma.teamMember.findMany({ where: { id: { in: [...ids] }, active: true }, select: { id: true, name: true, phone: true } }),
    import("@/lib/integrations/openphone"),
    import("@/lib/notifySchedule"),
    import("@/lib/hubSms"),
  ]);
  const ours = await op.ourOpenPhoneNumberKeys().catch(() => new Set<string>());
  const from = await op.defaultOpenPhoneNumber().catch(() => null);
  for (const m of members) {
    const num = sms.staffTextNumber(m.phone);
    if (!num || ours.has(num.key)) continue; // no number, or the office line itself (Kyle): Slack carries it
    const until = await sched.holdFor(m.id, now).catch(() => null);
    if (until) { await queueStaffSms(m.id, line, { kind: "program_message_text" }, until).catch(() => false); continue; }
    try {
      if (!from) throw new Error("no OpenPhone number");
      await op.OpenPhone.sendMessage(from, num.to, `${sms.HUB_SMS_PREFIX}: ${line}`);
      await logDelivery({ teamMemberId: m.id, kind: "program_message_text", channel: "sms", status: "sent" });
    } catch (err) {
      await logDelivery({ teamMemberId: m.id, kind: "program_message_text", channel: "sms", status: "failed", detail: err instanceof Error ? err.message : "send failed" }).catch(() => {});
    }
  }
}

/**
 * ONE desk task per account, refreshed by every message while the thread is
 * unanswered and reopened by a new one after it closed. Never for a TEST
 * client (the same rule as openProgramDeskTask). The assignee is the MESSAGES
 * owner's first name — the hub's assignedKey convention — unless a person
 * reassigned the task by hand (assignedManually), which no engine overrides.
 */
async function raiseThreadTask(e: { id: string; clientId: string; clientName: string }, owner: DutyOwner, now: Date): Promise<void> {
  if (isTestClientName(e.clientName)) return;
  const open = await prisma.programMessage.findMany({
    where: { enrollmentId: e.id, authorKind: "CLIENT", handledAt: null },
    orderBy: { createdAt: "asc" },
    select: { authorLabel: true, body: true, createdAt: true },
    take: 6,
  });
  if (!open.length) return;
  const dedupeKey = `${PROGRAM_MESSAGE_TASK_PREFIX}${e.id}`;
  const title = `Reply to ${e.clientName || "a program client"}'s message`.slice(0, 140);
  const description = [
    `${open.length === 1 ? "A message is" : `${open.length} messages are`} waiting on the program conversation.`,
    "",
    ...open.map((m) => `• ${m.authorLabel}: ${clip(m.body.replace(/\s+/g, " "), 220)}`),
    "",
    "Reply on Content Program → Messages. This closes itself when you reply there, or when you mark the thread “No reply needed”.",
  ].join("\n");
  // No owner on file ("unassigned") falls to Kyle, the desk's default — never
  // a task assigned to the word "unassigned".
  const assignedKey = (owner.appUserId ? (owner.label ?? "").trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") : "") || "kyle";
  const dueAt = endOfBusinessDaysET(now, 1); // the end of the next business day
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, status: true, assignedManually: true } });
  if (existing) {
    const reopening = TASK_DONE.includes(existing.status);
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: {
        title, description, summary: title,
        ...(reopening ? { status: "OPEN", completedAt: null, dueAt } : {}),
        ...(existing.assignedManually ? {} : { assignedKey }),
      },
    });
    return;
  }
  try {
    await prisma.smartTask.create({
      data: {
        title, description, summary: title,
        taskType: "program_message", status: "OPEN", source: "content_program", priority: "HIGH",
        clientId: e.clientId, dedupeKey, assignedKey, dueAt,
        reasonCreated: "A client wrote on the program conversation",
      },
    });
  } catch (err) {
    // Two messages racing into an empty thread: the other one created it. Refresh it instead.
    if ((err as { code?: string } | null)?.code !== "P2002") throw err;
    await prisma.smartTask.updateMany({ where: { dedupeKey }, data: { title, description } });
  }
}

/** The reply (or "No reply needed") closes the run: messages handled, task done. */
async function closeRun(enrollmentId: string, by: string, at: Date): Promise<number> {
  const r = await prisma.programMessage.updateMany({ where: { enrollmentId, authorKind: "CLIENT", handledAt: null }, data: { handledAt: at, handledBy: by } });
  await prisma.smartTask.updateMany({
    where: { dedupeKey: `${PROGRAM_MESSAGE_TASK_PREFIX}${enrollmentId}`, status: { notIn: TASK_DONE } },
    data: { status: "COMPLETED", completedAt: at },
  });
  return r.count;
}

/**
 * A client (or the shared link) writes on their program conversation. Staff
 * acting through the owner iframe are the office speaking — their words are
 * stored as STAFF, never as the client's.
 */
export async function postClientMessage(
  viewer: PortalViewer,
  input: { body: string; replyToId?: string | null; ref?: ProgramMessageRef | null },
  opts: { now?: Date } = {},
): Promise<Result> {
  if (!can(viewer, "message")) return fail(refusalMessage(viewer, "message"));
  const a = viewer.actor;
  if (a.kind === "STAFF") {
    return postStaffMessage(viewer.enrollment.id, { id: a.staffUserId, name: a.staffName, email: null }, input.body, input.replyToId ?? null, opts);
  }
  const now = opts.now ?? new Date();
  const e = viewer.enrollment;
  const body = (input.body ?? "").trim();
  if (body.length < 2) return fail("Write your message first.");
  const contact = await portalContact();
  const recent = await prisma.programMessage.count({ where: { enrollmentId: e.id, authorKind: "CLIENT", createdAt: { gte: new Date(now.getTime() - 86_400_000) } } });
  if (recent >= MESSAGE_DAILY_CAP) return fail(`That's a lot of messages for one day, and we'll catch up with you on them. If something is urgent, ${contactLine(contact)}.`);
  const ref = input.ref ? await verifyRef(e, input.ref) : null;
  if (input.ref && !ref) return fail("That item isn't on your page.");
  const replyTo = input.replyToId && /^[a-z0-9]{10,40}$/i.test(input.replyToId)
    ? await prisma.programMessage.findFirst({ where: { id: input.replyToId, enrollmentId: e.id }, select: { id: true } })
    : null;

  const owner = (await ownersFor(e.id)).MESSAGES;
  const wasQuiet = (await unansweredCount(e.id)) === 0;
  const row = await prisma.programMessage.create({
    data: {
      enrollmentId: e.id, clientId: e.clientId, authorKind: "CLIENT",
      clientUserId: a.kind === "CLIENT" ? a.clientUserId : null,
      authorLabel: actorLabel(viewer).slice(0, 120),
      body: body.slice(0, MESSAGE_BODY_MAX),
      replyToId: replyTo?.id ?? null,
      refKind: ref?.kind ?? null, refId: ref?.id ?? null,
      assignedAppUserId: owner.appUserId,
      createdAt: now,
    },
    select: { id: true },
  });
  // Writing is reading: whoever sent this has seen the thread up to now.
  await markThreadRead(e.id, readerKeyFor(viewer), now).catch(() => {});
  await raiseThreadTask({ id: e.id, clientId: e.clientId, clientName: e.clientName }, owner, now).catch((err) => console.error("[programMessages] task", err));
  if (wasQuiet) {
    const first = await prisma.programMessage.findFirst({ where: { enrollmentId: e.id, authorKind: "CLIENT", handledAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
    await announce({ id: e.id, clientName: e.clientName }, owner, first?.id ?? row.id, clip(body.replace(/\s+/g, " "), 120));
  }
  await alertOffice({ id: e.id, clientName: e.clientName }, owner, body, now).catch((err) => console.error("[programMessages] text/Slack alert", err));
  const { classifyComm, askMedium } = await import("@/lib/comms");
  const looksLikeChange = classifyComm(body).isRevision;
  const who = owner.label && owner.label !== "unassigned" ? owner.label.split(/\s+/)[0] : "The team";
  // Rule 2: a change to an approved video reopens it for the editor.
  let sentToEditor: string | null = null;
  if (looksLikeChange && (ref?.kind === "VIDEO" || askMedium(body) === "video")) {
    try {
      const { approvedProgramVideoFor, reopenApprovedCut } = await import("@/lib/cutReopen");
      const target = await approvedProgramVideoFor(e.id, ref?.kind === "VIDEO" ? ref.id : null);
      if (target) {
        const by = actorLabel(viewer).slice(0, 120);
        const r = await reopenApprovedCut(target.submissionId, { by, why: `They asked in a portal message: “${clip(body, 300)}”`, source: "portal" });
        const { raiseRevisionDetailed } = await import("@/lib/comms");
        const raised = await raiseRevisionDetailed({
          projectId: target.projectId, clientId: e.clientId, clientName: e.clientName, note: body, source: "portal_message", threadRef: `program-message:${row.id}`,
          requestedBy: { name: by, kind: "CLIENT" }, reopened: r.reopened,
          pin: { submissionId: target.submissionId, outputId: target.outputId, cutKey: target.cutKey, decisionId: null, roundId: null, videoLabel: target.videoLabel },
        });
        if (raised.ok) sentToEditor = target.videoLabel;
      }
    } catch (err) {
      console.error("[programMessages] reopening the video failed; the message stands", row.id, err);
    }
  }
  return {
    ok: true,
    id: row.id,
    message: sentToEditor
      ? `Sent. We've passed this to your editor as a change to ${sentToEditor}, and ${who.toLowerCase() === "the team" ? "the team" : who} will reply here.`
      : `Sent. ${who} will reply here.${looksLikeChange ? ` ${VIDEO_CHANGES_HINT}` : ""}`,
  };
}

/**
 * The office replies. Answers the whole unanswered run (a reply is to the
 * conversation, not to one line of it), closes the desk task, and — only when
 * the notice switch is on — lets the client know by email.
 */
export async function postStaffMessage(
  enrollmentId: string,
  me: { id: string | null; name: string | null; email: string | null },
  bodyRaw: string,
  replyToId: string | null = null,
  /** Oct 20 2026: `ref` marks what the reply is about (a script the client asked to change).
   *  `closeRun: false` (audit D3): a reply about one item does not answer the client's other messages. */
  opts: { now?: Date; ref?: ProgramMessageRef | null; closeRun?: boolean } = {},
): Promise<Result> {
  const now = opts.now ?? new Date();
  const body = (bodyRaw ?? "").trim();
  if (body.length < 1) return fail("Write the reply first.");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { id: true, clientId: true } });
  if (!e) return fail("Program not found.");
  const replyTo = replyToId && /^[a-z0-9]{10,40}$/i.test(replyToId)
    ? await prisma.programMessage.findFirst({ where: { id: replyToId, enrollmentId }, select: { id: true } })
    : null;
  const staffUser = me.id ? await prisma.appUser.findUnique({ where: { id: me.id }, select: { name: true, email: true } }) : null;
  const label = (me.name || staffUser?.name || me.email || staffUser?.email || "Realtour Pilot").slice(0, 120);
  const row = await prisma.programMessage.create({
    data: {
      enrollmentId, clientId: e.clientId, authorKind: "STAFF",
      staffUserId: me.id, authorLabel: label,
      body: body.slice(0, MESSAGE_BODY_MAX),
      replyToId: replyTo?.id ?? null,
      refKind: opts.ref?.kind ?? null, refId: opts.ref?.id ?? null,
      createdAt: now,
    },
    select: { id: true },
  });
  const handled = opts.closeRun === false ? 0 : await closeRun(enrollmentId, me.email ?? me.id ?? "staff", now);
  if (me.id) await markThreadRead(enrollmentId, `au:${me.id}`, now).catch(() => {});
  // Best-effort and switch-gated inside: the hourly sweep is the floor.
  await sweepProgramMessageNotices({ now, enrollmentId }).catch((err) => console.error("[programMessages] notice", err));
  return { ok: true, id: row.id, message: handled ? `Replied — ${handled} message${handled === 1 ? "" : "s"} answered.` : "Sent." };
}

/** "No reply needed" — the run is closed by a person, with no message. */
export async function markThreadHandled(enrollmentId: string, by: { id: string | null; email: string }, at: Date = new Date()): Promise<{ handled: number }> {
  const handled = await closeRun(enrollmentId, by.email, at);
  if (by.id) await markThreadRead(enrollmentId, `au:${by.id}`, at).catch(() => {});
  return { handled };
}

// ---------------------------------------------------------------------------
// READING THE THREAD
// ---------------------------------------------------------------------------

export type ThreadMessage = {
  id: string;
  authorKind: "CLIENT" | "STAFF";
  /** Full label as stored. The client view shows a staff member's first name. */
  authorLabel: string;
  body: string;
  createdAtISO: string;
  replyToId: string | null;
  ref: { kind: string; id: string } | null;
  /** Staff view only: answered or set aside. */
  handled: boolean;
  /** Staff view only: classifyComm reads it as a video change — a chip, never a re-route. */
  looksLikeVideoChange: boolean;
};

export type ThreadView = {
  messages: ThreadMessage[];
  unread: number;
  owner: { label: string; appUserId: string | null };
};

/**
 * The conversation, oldest first, as one reader sees it. `audience` is WHO the
 * page is for, not who is looking: staff previewing the portal through the
 * owner iframe see the client's page (their own read marker, the client's
 * copy). Reading does not mark anything read — the page does that, after it
 * has rendered what it counted.
 */
export async function threadFor(enrollmentId: string, readerKey: string, opts: { audience: "client" | "staff"; limit?: number }): Promise<ThreadView> {
  const [rows, seen, owners] = await Promise.all([
    prisma.programMessage.findMany({ where: { enrollmentId }, orderBy: { createdAt: "desc" }, take: opts.limit ?? 200 }),
    watermark(enrollmentId, readerKey),
    ownersFor(enrollmentId),
  ]);
  const { classifyComm } = await import("@/lib/comms");
  const clientSide = opts.audience === "client";
  const messages: ThreadMessage[] = rows.reverse().map((m) => ({
    id: m.id,
    authorKind: m.authorKind === "STAFF" ? "STAFF" : "CLIENT",
    authorLabel: m.authorLabel,
    body: m.body,
    createdAtISO: m.createdAt.toISOString(),
    replyToId: m.replyToId,
    ref: m.refKind && m.refId ? { kind: m.refKind, id: m.refId } : null,
    // What was answered and how the office read a message are the office's
    // business; the client's copy carries neither.
    handled: clientSide ? false : !!m.handledAt,
    looksLikeVideoChange: clientSide ? false : m.authorKind === "CLIENT" && classifyComm(m.body).isRevision,
  }));
  const unread = rows.filter((m) => (clientSide ? m.authorKind === "STAFF" : m.authorKind === "CLIENT") && (!seen || m.createdAt > seen)).length;
  const o = owners.MESSAGES;
  return { messages, unread, owner: { label: o.label, appUserId: o.appUserId } };
}

/** Everything the staff Messages tab needs in one read. */
export async function staffMessagesTab(enrollmentId: string, me: { id: string | null }) {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) return null;
  const [thread, client, unanswered] = await Promise.all([
    threadFor(enrollmentId, me.id ? `au:${me.id}` : "au:anonymous", { audience: "staff" }),
    prisma.client.findUnique({ where: { id: e.clientId }, select: { id: true, name: true, phone: true, email: true, backupEmail: true } }),
    unansweredCount(enrollmentId),
  ]);
  return {
    enrollmentId,
    thread,
    unanswered,
    client: { id: e.clientId, name: client?.name ?? "", hasPhone: !!client?.phone, hasEmail: !!(client?.email || client?.backupEmail) },
    noticeOn: await isAutomationEnabled(NOTICE_KEY).catch(() => false),
  };
}
export type StaffMessagesTab = NonNullable<Awaited<ReturnType<typeof staffMessagesTab>>>;

// ---------------------------------------------------------------------------
// "YOU HAVE A REPLY" — the one client-facing message this module can send.
//
// Behind `program_message_notice` (OFF). One email per seat per unread run:
// a seat that already read the reply on the portal gets nothing, and a notice
// already queued since that seat last read the thread covers every later reply
// too. Sent only inside the client window (Mon–Fri, before 4:30pm ET — the
// rule every client email and text in the hub keeps); the hourly cron step
// catches a reply written after hours the next working morning. The outbox's
// TEST-client floor applies on the way out: a synthetic client can only be
// emailed at Jordan's verified inbox, and anything else is refused loudly.
// ---------------------------------------------------------------------------

export const programMessageNoticeKey = (messageId: string, clientUserId: string) => `program_message:${messageId}:${clientUserId}`;

export function composeReplyNotice(input: { name: string | null; staffName: string; body: string }): string {
  const first = (input.name ?? "").trim().split(/\s+/)[0] || "there";
  const staffFirst = input.staffName.trim().split(/\s+/)[0] || "The team";
  return [
    `Hi ${first},`,
    "",
    `${staffFirst} replied to your message in your Realtour Pilot content portal:`,
    "",
    `"${clip(input.body.replace(/\s*[—–]\s*/g, ", "), 600)}"`,
    "",
    `To read the whole conversation and reply, sign in at ${appBase()}/portal/login. We'll email you a one-time link, so there's no password to remember.`,
    "",
    "The Realtour Pilot team",
  ].join("\n");
}

export type MessageNoticePreview = {
  enrollmentId: string;
  clientId: string;
  clientName: string;
  /** Masked, filled BEFORE the scope check (R03). */
  to: string | null;
  decision: "send" | "skip";
  reason: string;
  audience: { tier: ReachTier | null; code: ReachRefusalCode | null };
};

/**
 * R03 (Sep 28 2026): the office-replied email reaches only clients the program
 * rollout admits (op program_message_notice), and only for replies written
 * since they entered it — joining the pilot never mails the 3-day backlog
 * (NOTICE_LOOKBACK_MS). The immediate path (postStaffMessage) runs this same
 * sweep for one enrollment, so it inherits both. `dryRun` writes nothing and
 * returns what each seat would get; the live run records the same rows.
 */
export async function sweepProgramMessageNotices(opts: { now?: Date; enrollmentId?: string; dryRun?: boolean } = {}): Promise<{ skipped?: string; considered: number; sent: number; refused: number; notes: string[]; preview: MessageNoticePreview[] }> {
  const now = opts.now ?? new Date();
  const dry = !!opts.dryRun;
  const out = { considered: 0, sent: 0, refused: 0, notes: [] as string[], preview: [] as MessageNoticePreview[] };
  if (!(await isAutomationEnabled(NOTICE_KEY)) && !dry) return { skipped: `${NOTICE_KEY} is off`, ...out };
  const { clientTextWindowOpen } = await import("@/lib/clientTextSweeps");
  const windowOpen = await clientTextWindowOpen(now);
  if (!windowOpen && !dry) return { skipped: "outside the client hours (Mon to Fri, before 4:30pm ET)", ...out };
  const recent = await prisma.programMessage.findMany({
    where: { authorKind: "STAFF", createdAt: { gte: new Date(now.getTime() - NOTICE_LOOKBACK_MS), lte: now }, ...(opts.enrollmentId ? { enrollmentId: opts.enrollmentId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const latest = new Map<string, (typeof recent)[number]>();
  for (const m of recent) if (!latest.has(m.enrollmentId)) latest.set(m.enrollmentId, m);
  const { sendThroughOutbox, maskToRef } = await import("@/lib/outbox");
  const { programReach } = await import("@/lib/programRollout");
  for (const m of latest.values()) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { status: true, clientId: true } });
    if (!e || e.status !== "ACTIVE") continue;
    const clientName = (await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }).catch(() => null))?.name ?? "?";
    // THE ROLLOUT (R03): re-read per enrollment, never cached.
    const d = await programReach("program_message_notice", e.clientId, { now });
    const audience = d.ok ? { tier: d.tier, code: null } : { tier: null, code: d.code };
    const seats = await prisma.clientMembership.findMany({ where: { enrollmentId: m.enrollmentId, revokedAt: null, role: { in: ["OWNER", "COLLABORATOR"] } }, select: { clientUserId: true } });
    for (const seat of seats) {
      const person = await prisma.clientUser.findUnique({ where: { id: seat.clientUserId }, select: { email: true, name: true, status: true } });
      if (!person || person.status === "DISABLED") continue;
      out.considered++;
      const row: MessageNoticePreview = { enrollmentId: m.enrollmentId, clientId: e.clientId, clientName, to: maskToRef("email", person.email), decision: "skip", reason: "", audience };
      const skip = (why: string) => { row.reason = why; out.preview.push(row); };
      if (!d.ok) { skip(`not in the rollout: ${d.reason}`); out.notes.push(`${m.enrollmentId}: not in the rollout (${d.code})`); continue; }
      // Only a reply written since this client entered the scope: a TEST
      // client's since is null (unchanged); a pilot client's is their join.
      if (d.since && m.createdAt < d.since) { skip("the reply was written before this client joined the rollout"); continue; }
      if (!(await isAutomationEnabled(NOTICE_KEY))) { skip(`${NOTICE_KEY} is off`); continue; }
      if (!windowOpen) { skip("outside the client hours (Mon to Fri, before 4:30pm ET)"); continue; }
      const seen = await watermark(m.enrollmentId, `cu:${seat.clientUserId}`);
      if (seen && seen >= m.createdAt) { skip("they read it on the portal already"); continue; }
      const priors = await prisma.outboxMessage.findMany({
        where: { clientId: e.clientId, toRef: person.email, requestedBy: NOTICE_BY, createdAt: { gt: seen ?? new Date(0) } },
        select: { state: true },
      });
      if (priors.some((p) => p.state !== "failed")) { skip("a notice is already queued or sent"); continue; } // never twice
      if (priors.length >= NOTICE_MAX_TRIES) { skip(`${priors.length} notices failed; not retrying`); out.notes.push(`${person.email}: ${priors.length} notices failed; not retrying`); continue; }
      // THE TEST FLOOR, here too (review fix, Sep 28 2026). A TEST client is
      // emailed only at one of Jordan's verified inboxes — the outbox refuses
      // anything else. This lane had no such check, so the dry run said
      // "send" for a TEST seat on a colleague's inbox (nick@…), the live run
      // then threw on the floor every hour, and "What would go out now?"
      // disagreed with what went out. Both now skip it, with the reason the
      // other lanes use.
      if (d.tier === "TEST" && !isVerifiedTestDestinationEmail(person.email)) {
        skip("test_client_real_address: a TEST client is emailed only at one of Jordan's verified test inboxes");
        // Still loud in the run's notes (masked): a TEST seat on a real inbox
        // is a set-up mistake someone should see, not a silent skip.
        out.notes.push(`${m.enrollmentId}: test_client_real_address — ${clientName}'s seat ${maskToRef("email", person.email)} is not one of Jordan's verified test inboxes; not sent`);
        continue;
      }
      if (dry) { row.decision = "send"; row.reason = "an unread reply from the office"; out.preview.push(row); continue; }
      try {
        const r = await sendThroughOutbox({
          channel: "email", toRef: person.email,
          body: composeReplyNotice({ name: person.name, staffName: m.authorLabel, body: m.body }),
          dedupeKey: programMessageNoticeKey(m.id, seat.clientUserId),
          clientId: e.clientId, requestedBy: NOTICE_BY,
        });
        if (r.outcome === "accepted") { out.sent++; row.decision = "send"; row.reason = "sent"; out.preview.push(row); }
        else if (r.outcome === "failed" && r.refused) { out.refused++; skip(`refused at send: ${r.error}`); out.notes.push(`${m.enrollmentId}: refused before send (${r.refused})`); }
        else { skip(`notice ${r.outcome}`); out.notes.push(`${m.enrollmentId}: notice ${r.outcome}`); }
      } catch (err) {
        // TestClientSendRefusedError lands here: loud in the notes, nothing queued.
        out.refused++;
        skip(`refused: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
        out.notes.push(`${m.enrollmentId}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
      }
    }
  }
  return out;
}
