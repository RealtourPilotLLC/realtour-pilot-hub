import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// NO BOOKING CONFIRMATION WHILE A CONFLICT IS OPEN (Oct 22 2026, comms audit H6).
//
// Erica Walker, Oct 22: the hub booked her filming for Thursday Oct 29 at 8:30
// AM and Aryeo's post-check said James was already busy then, so the hub
// opened "Double-booked? James Livingston — Erica Walker" for Kyle at 5:20:05
// PM. Thirty-three seconds later (5:20:38 PM) a message went to her portal
// telling her the time was set. A person was still deciding whether that time
// stands.
//
// So every path that tells a client their filming time is set asks this file
// first, and holds while a conflict is open on that booking:
//   · the portal's own answer after booking or moving a session (and its
//     label on the scheduler): "we're confirming it with your videographer";
//   · the program conversation (programMessages.postStaffMessage): a staff
//     message that reads as a booking confirmation is refused, unless the
//     person says they settled it (overrideConflict);
//   · the confirmation text (clientTextSweeps.sweepConfirmationTexts, and the
//     Send / Send all buttons): held on its task, sent on a later tick once
//     the conflict task is closed;
//   · the staff text rails (Replies, the inbox thread, the client page): a
//     text that reads as a booking confirmation is refused the same way.
//
// WHAT COUNTS AS A CONFLICT: an OPEN task (not completed or cancelled) of
//   · content-session-doublebooked-<request>   the hub's booking post-check
//                                              (sessionBooking.raiseDoubleBooked);
//   · program-session-address:<session>:travel:v<n> / :aryeo-conflict:v<n>
//                                              the new address leaves no room
//                                              for the drive, or Aryeo reports a
//                                              clash (sessionAddress);
//   · program-reassess:<row> (or the row's own task)
//                                              the call behind a booked session
//                                              moved (sessionReassess).
// Closing the task is the person's answer, and the held sends go on their
// next tick. Nothing here changes a booking, a task or a message.
// ---------------------------------------------------------------------------

export const DOUBLE_BOOKED_TASK_PREFIX = "content-session-doublebooked-";
const ADDRESS_TASK_PREFIX = "program-session-address:";
const REASSESS_TASK_PREFIX = "program-reassess:";
const DONE = ["COMPLETED", "CANCELLED", "DONE", "CLOSED"];

export type ConflictKind = "double_booked" | "clash" | "reassess";
export type OpenConflict = { taskId: string; title: string; dedupeKey: string | null; kind: ConflictKind };

/** The kind of conflict a task key names, or null for any other task. Pure. */
export function conflictKindOfKey(dedupeKey: string | null | undefined): ConflictKind | null {
  const k = dedupeKey ?? "";
  if (k.startsWith(DOUBLE_BOOKED_TASK_PREFIX)) return "double_booked";
  if (k.startsWith(ADDRESS_TASK_PREFIX) && /:(?:travel|aryeo-conflict):v\d+$/.test(k)) return "clash";
  if (k.startsWith(REASSESS_TASK_PREFIX)) return "reassess";
  return null;
}

/** The session key an address conflict task is about ("appt:<id>", "request:<id>", "project:<id>"). Pure. */
export function addressTaskSessionKey(dedupeKey: string): string | null {
  if (!dedupeKey.startsWith(ADDRESS_TASK_PREFIX)) return null;
  const m = /^(.*):(?:travel|aryeo-conflict):v\d+$/.exec(dedupeKey.slice(ADDRESS_TASK_PREFIX.length));
  return m ? m[1] : null;
}

// ---- pure: does this message tell the client their time is set? ------------

/** Words that SAY a booking is made (not ones that ask for one: "can we schedule Thursday?" is not). */
const CONFIRM_WORDS = new RegExp(
  [
    String.raw`\b(?:scheduled|booked|confirmed|rescheduled|locked in|all set|on the calendar|on our calendar)\b`,
    String.raw`\bable to (?:schedule|book|fit|get) (?:you|your|it|the)\b`,
    String.raw`\b(?:we|we've|we have|i|i've|i have)\s+(?:have|got|put|moved)\s+(?:you|your (?:filming|session|shoot|appointment))\b`,
    String.raw`\bsee you (?:on|at|this|next|then|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b`,
  ].join("|"),
  "i",
);
/** A day or a time: the part that makes it a confirmation of WHEN. */
const DAY_OR_TIME = new RegExp(
  [
    String.raw`\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri)\b`,
    String.raw`\b(?:today|tomorrow|tonight|noon)\b`,
    String.raw`\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\b\.?|p\.?m\b\.?)`,
    String.raw`\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b`,
    String.raw`\b\d{1,2}\/\d{1,2}\b`,
  ].join("|"),
  "i",
);

/** Pure: does this message tell a client a filming time is set? Booking words AND a day or time. */
export function readsAsBookingConfirmation(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/\s+/g, " ");
  return CONFIRM_WORDS.test(t) && DAY_OR_TIME.test(t);
}

// ---- the reads ------------------------------------------------------------

type Scope = {
  /** One session request (the portal's answer, a hub booking). */
  requestId?: string | null;
  /** One job (a confirmation text is per job). */
  projectId?: string | null;
  /** Everything for this client (a staff message names no request). */
  clientId?: string | null;
};

/**
 * The first open conflict task on this booking, or null. Never throws: a read
 * that fails answers null, so a database blip cannot silence every
 * confirmation for good (the same reads run again on the next send).
 */
export async function openConflictFor(scope: Scope): Promise<OpenConflict | null> {
  try {
    return (await openConflicts(scope))[0] ?? null;
  } catch (e) {
    console.error("[booking-conflict] read failed", scope, e);
    return null;
  }
}

/** Every open conflict task on this booking (or client), oldest first. */
export async function openConflicts(scope: Scope): Promise<OpenConflict[]> {
  const ors: Record<string, unknown>[] = [];
  if (scope.clientId) {
    ors.push({
      clientId: scope.clientId,
      OR: [{ dedupeKey: { startsWith: DOUBLE_BOOKED_TASK_PREFIX } }, { dedupeKey: { startsWith: ADDRESS_TASK_PREFIX } }, { dedupeKey: { startsWith: REASSESS_TASK_PREFIX } }],
    });
  }
  if (scope.requestId || scope.projectId) {
    const { requestIds, sessionKeys } = await bookingIdentity(scope);
    if (requestIds.length) ors.push({ dedupeKey: { in: requestIds.map((id) => `${DOUBLE_BOOKED_TASK_PREFIX}${id}`) } });
    for (const sk of sessionKeys) ors.push({ dedupeKey: { startsWith: `${ADDRESS_TASK_PREFIX}${sk}:` } });
    if (sessionKeys.length) {
      const rows = await prisma.programSessionReassessment.findMany({
        where: { sessionKey: { in: sessionKeys }, state: "OPEN", kind: { not: "BASELINE" } },
        select: { id: true, taskId: true },
      });
      const ids = rows.map((r) => r.taskId).filter((x): x is string => !!x);
      if (ids.length) ors.push({ id: { in: ids } });
      if (rows.length) ors.push({ dedupeKey: { in: rows.map((r) => `${REASSESS_TASK_PREFIX}${r.id}`) } });
    }
  }
  if (!ors.length) return [];
  const tasks = await prisma.smartTask.findMany({
    where: { status: { notIn: DONE }, OR: ors },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, dedupeKey: true },
  });
  const out: OpenConflict[] = [];
  for (const t of tasks) {
    // A reassess row's own task may carry another key (a linked desk task); it is still the reassessment.
    const kind = conflictKindOfKey(t.dedupeKey) ?? (t.dedupeKey && !t.dedupeKey.startsWith(ADDRESS_TASK_PREFIX) ? "reassess" : null);
    if (kind) out.push({ taskId: t.id, title: t.title, dedupeKey: t.dedupeKey, kind });
  }
  return out;
}

/** The requests and session keys one request or one job stands for. */
async function bookingIdentity(scope: Scope): Promise<{ requestIds: string[]; sessionKeys: string[] }> {
  const requestIds = new Set<string>();
  const appointmentIds = new Set<string>();
  const projectIds = new Set<string>();
  if (scope.requestId) {
    requestIds.add(scope.requestId);
    const r = await prisma.programSessionRequest.findUnique({ where: { id: scope.requestId }, select: { aryeoAppointmentId: true, projectId: true } });
    if (r?.aryeoAppointmentId) appointmentIds.add(r.aryeoAppointmentId);
    if (r?.projectId) projectIds.add(r.projectId);
  }
  if (scope.projectId) {
    projectIds.add(scope.projectId);
    const p = await prisma.project.findUnique({ where: { id: scope.projectId }, select: { aryeoOrderId: true } });
    const reqs = await prisma.programSessionRequest.findMany({
      where: { OR: [{ projectId: scope.projectId }, ...(p?.aryeoOrderId ? [{ aryeoOrderId: p.aryeoOrderId }] : [])] },
      select: { id: true, aryeoAppointmentId: true },
    });
    for (const r of reqs) {
      requestIds.add(r.id);
      if (r.aryeoAppointmentId) appointmentIds.add(r.aryeoAppointmentId);
    }
    const appts = await prisma.appointment.findMany({ where: { projectId: scope.projectId }, select: { aryeoId: true } });
    for (const a of appts) if (a.aryeoId) appointmentIds.add(a.aryeoId);
  }
  const sessionKeys = [
    ...[...appointmentIds].map((id) => `appt:${id}`),
    ...[...requestIds].map((id) => `request:${id}`),
    ...[...projectIds].map((id) => `project:${id}`),
  ];
  return { requestIds: [...requestIds], sessionKeys };
}

/**
 * The session keys (appt:/request:/project:) of this client's sessions with an
 * open conflict, for the portal's "Kyle will confirm your filming time" line.
 * Never throws; an empty set on a failed read.
 */
export async function conflictSessionKeys(clientId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    for (const c of await openConflicts({ clientId })) {
      if (c.kind === "double_booked" && c.dedupeKey) {
        const requestId = c.dedupeKey.slice(DOUBLE_BOOKED_TASK_PREFIX.length);
        const { sessionKeys } = await bookingIdentity({ requestId });
        for (const k of sessionKeys) out.add(k);
      } else if (c.kind === "clash" && c.dedupeKey) {
        const k = addressTaskSessionKey(c.dedupeKey);
        if (k) out.add(k);
      }
      // A reassessment is already on the portal through its own row (portal.scheduleSessionsFor).
    }
  } catch (e) {
    console.error("[booking-conflict] session keys read failed", clientId, e);
  }
  return out;
}

/** The requests (by id) of this client with an open conflict, for the scheduler's request labels. */
export async function conflictRequestIds(clientId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const keys = await conflictSessionKeys(clientId);
    for (const k of keys) if (k.startsWith("request:")) out.add(k.slice("request:".length));
    const appts = [...keys].filter((k) => k.startsWith("appt:")).map((k) => k.slice("appt:".length));
    if (appts.length) {
      const rows = await prisma.programSessionRequest.findMany({ where: { clientId, aryeoAppointmentId: { in: appts } }, select: { id: true } });
      for (const r of rows) out.add(r.id);
    }
  } catch { /* nothing held on a failed read */ }
  return out;
}

// ---- the words ------------------------------------------------------------

/** What the client is told instead of "Booked" while a conflict is open. No booking claim. */
export const CONFIRMING_WITH_CREATIVE = "We have your time and we're confirming it with your videographer. We'll message you here once it's set.";
/** The scheduler's label for a request on hold. */
export const CONFIRMING_LABEL = "Confirming the time with your videographer";

/** The refusal a person sees when they try to confirm a time with a conflict open. */
export function conflictRefusal(c: OpenConflict): string {
  const what = c.kind === "double_booked" ? "A double-booked check" : c.kind === "clash" ? "A schedule clash check" : "A check on this filming session";
  return `${what} is open for this booking (task: ${c.title}). Settle it before confirming the time.`;
}

/** The summary written on a held confirmation-text task. */
export function conflictHoldSummary(c: OpenConflict, clientName: string): string {
  return `On hold: a booking conflict is open for ${clientName || "this client"} (task: ${c.title}), so the hub is not confirming the time yet. It sends once that task is closed.`;
}

/**
 * For the staff send rails: null when the message may go, else the refusal.
 * Only a message that reads as a booking confirmation is ever held.
 */
export async function staffConfirmationRefusal(input: { clientId: string | null | undefined; body: string; overrideConflict?: boolean }): Promise<string | null> {
  if (input.overrideConflict || !input.clientId || !readsAsBookingConfirmation(input.body)) return null;
  const c = await openConflictFor({ clientId: input.clientId });
  return c ? conflictRefusal(c) : null;
}
