import "server-only";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { zonedDateTime, zonedTime } from "@/lib/datetime";
import { OFFICE_LINE } from "@/lib/portalWords";
import { formatAddressLine } from "@/lib/sessionAddress";
import { filmingSessionEvent, googleCalendarLink } from "@/lib/calendarLink";
import { compactStart as compact, sessionConfirmationKey, sessionConfirmationStart } from "@/lib/sessionConfirmationKey";
import { isTestClientName, isVerifiedTestDestinationEmail } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// THE FILMING SESSION CONFIRMATION EMAIL (Oct 26 2026).
//
// Jordan: "Can we make sure clients get email confirmations and it tells them
// on screen a confirmation when they booked their monthly content shoot? Mike
// Ciunci booked one and said he didn't get any confirmation. Typically Aryeo
// sends confirmation but it didn't."
//
// WHY ARYEO SAID NOTHING. The hub books a session in Aryeo with the customer
// notification OFF by construction (integrations/aryeo storeAppointment
// notifyCustomer:false; reschedule and cancel send notify:false), so Aryeo's
// email never goes out for a session the hub booked or moved. Mike booked Thu
// Nov 12 at 10 AM on the portal at 9:10 AM Oct 26; the booking was confirmed
// in Aryeo within a second, and nothing reached him.
//
// WHAT THIS DOES. One branded email per filming session TIME, to every live
// portal seat on the program (owner and collaborators; the client's email on
// file when there is no seat), once the session is CONFIRMED:
//   · when, where, the videographer, an "Add to Google Calendar" link, the
//     portal link to see, move or cancel it, and Kyle's line for anything
//     inside 24 hours;
//   · a session moved to a new time gets its own email ("has moved").
// The portal sends it the moment the hub books (portalRequestSession /
// portalRescheduleSession), so the confirmation screen can say where it went.
// Every other way a session becomes confirmed (Kyle confirming a request by
// hand, the Aryeo reconcile matching his booking, a booking the 15-minute cron
// finished) is caught by sweepSessionConfirmations on the aryeo cron.
//
// WHAT HOLDS IT. An open conflict on the booking (bookingConflictHold: a
// double-booked videographer, an address clash, a call that moved): the client
// is not told the time is set while a person decides, and the next tick sends
// it once the task is closed. A move still in flight (pendingChangeJson). A
// session already started. A TEST client at a real address (the outbox floor
// would refuse it anyway; skipped here so the run says why).
//
// WHAT IT NEVER DOES. Email about a session confirmed before this shipped
// (CONFIRMATIONS_FROM): turning it on must not mail a backlog. Send twice: the
// outbox key is the request, the session's start and the seat, so a retry
// collides and only a real move earns a second email. Retry for ever: three
// failed sends to one address and it stops.
// ---------------------------------------------------------------------------

/** Only sessions confirmed (or moved) from this moment are emailed: 9:30 AM ET Oct 26 2026, as it
 *  was built. Mike's 9:10 AM booking and Janice Pigga's of Oct 24 are Jordan's to send (scripts/_live). */
export const CONFIRMATIONS_FROM = new Date("2026-10-26T13:30:00Z");
/** How far back a tick looks: a held confirmation still goes once its conflict closes. */
const LOOKBACK_MS = 7 * 86_400_000;
const MAX_FAILED = 3;
const DEFAULT_TZ = "America/New_York";
export const SESSION_CONFIRMATION_BY = "session-confirmation";

/** "Thursday, November 12, 10:00 AM to 12:00 PM EST". */
function whenLine(start: Date, end: Date | null, tz: string): string {
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(start).find((p) => p.type === "timeZoneName")?.value ?? "ET";
  const from = zonedDateTime(start, tz, { weekday: "long", month: "long", day: "numeric" });
  return end ? `${from} to ${zonedTime(end, tz)} ${zone}` : `${from} ${zone}`;
}

/** The email, in Jordan's voice: plain words, no dashes. Pure. */
export function composeSessionConfirmation(input: { name: string | null; start: Date; end: Date | null; tz: string; location: string | null; creativeName: string | null; moved: boolean }): string {
  const first = (input.name ?? "").trim().split(/\s+/)[0] || "there";
  const plain = (t: string) => t.replace(/\s*[—–]\s*/g, ", ");
  const calendar = googleCalendarLink(filmingSessionEvent({ start: input.start, end: input.end, location: input.location, creativeName: input.creativeName, office: OFFICE_LINE }));
  return [
    `Hi ${first},`,
    "",
    input.moved ? "Your content filming session has moved. Here is the new time:" : "Your content filming session is booked. Here are the details:",
    "",
    [
      `When: ${whenLine(input.start, input.end, input.tz)}`,
      input.location ? `Where: ${plain(input.location)}` : null,
      input.creativeName ? `Videographer: ${plain(input.creativeName)}` : null,
    ].filter(Boolean).join("\n"),
    "",
    `Add it to your calendar: ${calendar}`,
    "",
    `To see your session, change the time or cancel, open your portal: ${appBase()}/portal/login`,
    "",
    `Need to change something within 24 hours of your session? Call or text ${OFFICE_LINE.name} at ${OFFICE_LINE.display}.`,
    "",
    "The Realtour Pilot team",
  ].join("\n");
}

type Recipient = { id: string; email: string; name: string | null };

/** Every live portal seat on the program, else the client's email on file. */
async function recipientsFor(enrollmentId: string, client: { id: string; name: string; email: string | null }): Promise<Recipient[]> {
  const seats = await prisma.clientMembership.findMany({ where: { enrollmentId, revokedAt: null, role: { in: ["OWNER", "COLLABORATOR"] } }, select: { clientUserId: true, role: true }, orderBy: { createdAt: "asc" } });
  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const s of seats) {
    const u = await prisma.clientUser.findUnique({ where: { id: s.clientUserId }, select: { email: true, name: true, status: true } });
    const email = (u?.email ?? "").trim().toLowerCase();
    if (!u || u.status === "DISABLED" || !email || seen.has(email)) continue;
    seen.add(email);
    out.push({ id: s.clientUserId, email, name: u.name ?? client.name });
  }
  const onFile = (client.email ?? "").trim().toLowerCase();
  if (!out.length && onFile) out.push({ id: "client", email: onFile, name: client.name });
  return out;
}

export type ConfirmationResult = {
  requestId: string;
  /** The addresses it was sent to (accepted now, or already sent before). */
  emailedTo: string[];
  /** Queued but not yet accepted (the cron finishes it). */
  pendingTo: string[];
  skipped: string | null;
  notes: string[];
};

/**
 * Send (or confirm already sent) the confirmation for one session request.
 * Never throws. `dryRun` reads only and says what would go.
 */
export async function sendSessionConfirmation(requestId: string, opts: { now?: Date; dryRun?: boolean; since?: Date } = {}): Promise<ConfirmationResult> {
  const now = opts.now ?? new Date();
  const res: ConfirmationResult = { requestId, emailedTo: [], pendingTo: [], skipped: null, notes: [] };
  const skip = (why: string) => { res.skipped = why; return res; };
  try {
    const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId } });
    if (!r) return skip("no such request");
    if (r.status !== "CONFIRMED") return skip(`the session is ${r.status.toLowerCase()}, not confirmed`);
    if (!r.slotStart) return skip("the session has no time on it");
    if (r.pendingChangeJson) return skip("a move is still being made");
    if (r.slotStart.getTime() <= now.getTime()) return skip("the session has already started");
    const confirmedAt = [r.confirmedAt, r.providerConfirmedAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    if (!confirmedAt || confirmedAt < (opts.since ?? CONFIRMATIONS_FROM)) return skip("confirmed before the confirmation email existed");

    const { openConflictFor } = await import("@/lib/bookingConflictHold");
    const held = await openConflictFor({ requestId: r.id });
    if (held) return skip(`held while "${held.title}" is open`);

    const [client, enrollment] = await Promise.all([
      prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true, email: true } }),
      prisma.contentEnrollment.findUnique({ where: { id: r.enrollmentId }, select: { id: true, timezone: true } }),
    ]);
    if (!client || !enrollment) return skip("the client or program is gone");
    const recipients = await recipientsFor(enrollment.id, client);
    if (!recipients.length) return skip("no email address on the program");

    let location = (r.locationText ?? "").trim() || null;
    if (!location && r.planId) {
      const plan = await prisma.programSessionPlan.findUnique({ where: { id: r.planId }, select: { streetNumber: true, streetName: true, unitNumber: true, city: true, stateCode: true, postalCode: true } });
      if (plan) location = formatAddressLine({ ...plan, unit: plan.unitNumber }) || null;
    }

    // A move: the request replaces an earlier one, the hub moved this booking
    // after it was made, or an earlier time already had its confirmation.
    const earlier = await prisma.outboxMessage.findMany({ where: { requestedBy: `${SESSION_CONFIRMATION_BY}:${r.id}`, state: "accepted" }, select: { dedupeKey: true } });
    const startKey = compact(r.slotStart);
    const moved = !!r.supersedesId
      || (!!r.providerConfirmedAt && !!r.confirmedAt && r.providerConfirmedAt.getTime() - r.confirmedAt.getTime() > 5 * 60_000)
      || earlier.some((e) => !(e.dedupeKey ?? "").includes(`:${startKey}:`));

    const synthetic = isTestClientName(client.name);
    const { sendThroughOutbox } = await import("@/lib/outbox");
    for (const to of recipients) {
      if (synthetic && !isVerifiedTestDestinationEmail(to.email)) { res.notes.push(`${client.name}: a TEST client is emailed only at one of Jordan's verified test inboxes; not sent`); continue; }
      const key = sessionConfirmationKey(r.id, r.slotStart, to.id, moved);
      const prior = await prisma.outboxMessage.findUnique({ where: { dedupeKey: key }, select: { state: true } });
      if (prior?.state === "accepted") { res.emailedTo.push(to.email); continue; }
      if (prior) { res.pendingTo.push(to.email); continue; } // pending, attempting or unknown: never a second copy
      const failed = await prisma.outboxMessage.count({ where: { requestedBy: `${SESSION_CONFIRMATION_BY}:${r.id}`, toRef: to.email, state: "failed" } });
      if (failed >= MAX_FAILED) { res.notes.push(`${to.email}: ${failed} sends failed; not retrying`); continue; }
      if (opts.dryRun) { res.pendingTo.push(to.email); continue; }
      const body = composeSessionConfirmation({ name: to.name, start: r.slotStart, end: r.slotEnd, tz: enrollment.timezone || DEFAULT_TZ, location, creativeName: r.creativeName, moved });
      const sent = await sendThroughOutbox({ channel: "email", toRef: to.email, body, dedupeKey: key, clientId: client.id, projectId: r.projectId, requestedBy: `${SESSION_CONFIRMATION_BY}:${r.id}` });
      if (sent.outcome === "accepted") res.emailedTo.push(to.email);
      else if (sent.outcome === "failed") res.notes.push(`${to.email}: ${sent.error}`.slice(0, 300));
      else res.pendingTo.push(to.email);
    }
    return res;
  } catch (e) {
    res.notes.push((e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300));
    return skip("the confirmation could not be sent this time");
  }
}

/**
 * The cron's pass (aryeo cron, every 15 minutes): every session confirmed or
 * moved in the last week, from CONFIRMATIONS_FROM, that has not had its email.
 */
export async function sweepSessionConfirmations(opts: { now?: Date; dryRun?: boolean; max?: number } = {}): Promise<{ considered: number; sent: number; held: string[]; notes: string[] }> {
  const now = opts.now ?? new Date();
  const from = new Date(Math.max(CONFIRMATIONS_FROM.getTime(), now.getTime() - LOOKBACK_MS));
  const rows = await prisma.programSessionRequest.findMany({
    where: { status: "CONFIRMED", slotStart: { gt: now }, pendingChangeJson: null, OR: [{ confirmedAt: { gte: from } }, { providerConfirmedAt: { gte: from } }] },
    select: { id: true },
    orderBy: { slotStart: "asc" },
    take: opts.max ?? 40,
  });
  const out = { considered: rows.length, sent: 0, held: [] as string[], notes: [] as string[] };
  for (const { id } of rows) {
    const r = await sendSessionConfirmation(id, { now, dryRun: opts.dryRun });
    out.sent += opts.dryRun ? r.pendingTo.length : r.emailedTo.length;
    if (r.skipped) out.held.push(`${id}: ${r.skipped}`);
    out.notes.push(...r.notes.map((n) => `${id}: ${n}`));
  }
  return out;
}

/** The outbox drain's check for a recovered row: is the session still at that time? */
export async function sessionConfirmationStillTrue(row: { dedupeKey: string | null }): Promise<{ ok: boolean; why: string }> {
  const [, requestId] = (row.dedupeKey ?? "").split(":");
  const start = sessionConfirmationStart(row.dedupeKey);
  if (!requestId || !start) return { ok: false, why: "the confirmation names no session" };
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { status: true, slotStart: true } }).catch(() => null);
  if (!r || r.status !== "CONFIRMED") return { ok: false, why: "the session is no longer confirmed" };
  if (!r.slotStart || Math.floor(r.slotStart.getTime() / 60_000) !== Math.floor(start.getTime() / 60_000)) return { ok: false, why: "the session has moved since" };
  return { ok: true, why: "" };
}
