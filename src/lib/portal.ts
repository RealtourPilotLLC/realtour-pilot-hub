import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/jwt";
import { verifyClientSession, CLIENT_COOKIE } from "@/lib/auth/clientSession";

// ---------------------------------------------------------------------------
// The client portal's data layer (interactive layer, Aug 28; identity layer,
// Sep 16). Three kinds of visitor reach it, and ONE function decides who is
// asking and what they may see:
//   TOKEN  the unguessable link (/portal/<token>) — the only door until Sep 16,
//          still open for every live link (transition Stage A);
//   CLIENT a person signed in by email link (rtp_client cookie) who holds a
//          ClientMembership on the enrollment — re-read on EVERY request, so a
//          revoked seat dies on the next click despite the stateless cookie;
//   STAFF  Jordan or Kyle, signed into the hub (rtp_session), opening the
//          client's link through the owner iframe — recorded as THEM, on the
//          client's behalf, never as the client.
// Every function below scopes every read and write to that one enrollment —
// and, since Sep 16, to that enrollment's CLIENT: a project that is attached
// to the wrong client's month is dropped and reported, never shown. No
// function may accept a bare id from the client without proving it belongs
// to the viewer's enrollment. And never money, anywhere.
// ---------------------------------------------------------------------------

// The one list of script statuses a client may ever see or act on — the page
// renders with it and the WRITE layer enforces it (review finding: the proofs
// checked ownership but not visibility, so a stale tab could act on a script
// that had dropped back to internal review).
export const CLIENT_VISIBLE_SCRIPT = ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"];

export type PortalEnrollment = {
  id: string;
  clientId: string;
  clientName: string;
  status: string; // ACTIVE | PAUSED | ENDED
  videosPerMonth: number;
  sessionsPerMonth: number;
};

export type PortalRole = "OWNER" | "COLLABORATOR" | "VIEWER";

export type PortalActor =
  | { kind: "TOKEN" }
  | { kind: "CLIENT"; clientUserId: string; email: string; name: string | null; membershipId: string; membershipRole: PortalRole }
  | { kind: "STAFF"; staffUserId: string; staffName: string | null; staffRole: string };

/** FULL = the program is running; READ_ONLY = paused/ended, released content
 *  stays visible but nothing new may be started; NONE = never rendered. */
export type PortalAccess = "FULL" | "READ_ONLY" | "NONE";

export type PortalViewer = {
  enrollment: PortalEnrollment;
  actor: PortalActor;
  access: PortalAccess;
  /** What PortalVisit records. */
  via: "TOKEN" | "LOGIN" | "STAFF";
};

export type PortalRefusal =
  | "no_session" // nothing identifying at all
  | "invalid_token" // no enrollment carries this token (rotated, or never existed)
  | "expired_token" // the link's portalTokenExpiresAt has passed
  | "revoked" // accessRevokedAt is set on the enrollment
  | "no_membership"; // a signed-in person with no live seat on any (or this) enrollment

export type PortalResolution = { ok: true; viewer: PortalViewer } | { ok: false; reason: PortalRefusal };

/** Where cookies come from. Pages and actions leave it out (next/headers);
 *  route handlers pass `req.cookies`; probes pass a plain object. */
export type CookieSource = { get(name: string): { value: string } | string | undefined };

const TOKEN_RE = /^[a-zA-Z0-9_-]{20,}$/;

async function cookieValue(src: CookieSource | undefined, name: string): Promise<string | undefined> {
  let source = src;
  if (!source) {
    try {
      const { cookies } = await import("next/headers");
      source = await cookies();
    } catch {
      return undefined; // outside a request (a script) — no cookies, and that is fine
    }
  }
  const v = source.get(name);
  return typeof v === "string" ? v : v?.value;
}

const ENROLLMENT_SELECT = {
  id: true, clientId: true, status: true, videosPerMonth: true, sessionsPerMonth: true,
  portalTokenExpiresAt: true, accessRevokedAt: true,
} as const;

const accessFor = (status: string): PortalAccess => (status === "ACTIVE" ? "FULL" : "READ_ONLY");

async function enrollmentWithName(e: { id: string; clientId: string; status: string; videosPerMonth: number; sessionsPerMonth: number }): Promise<PortalEnrollment> {
  const client = await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } });
  return { id: e.id, clientId: e.clientId, clientName: client?.name ?? "", status: e.status, videosPerMonth: e.videosPerMonth, sessionsPerMonth: e.sessionsPerMonth };
}

/** The hub roles that may stand in for a client. OWNER/ADMIN run the program
 *  (Jordan, Kyle); an editor or photographer holding a client's link is just
 *  someone with the link and is treated as the link — subject to its expiry
 *  and never able to act on the client's behalf (review, Sep 17). */
const STAFF_ON_BEHALF_ROLES = new Set(["OWNER", "ADMIN"]);

/** A hub session on this request, if any — the staff path. Reads the JWT and
 *  the AppUser row directly (getCurrentUser needs next/headers and a request
 *  scope; this must also run from a route handler and a probe). The JWT's
 *  `uid` is the REAL person even while an owner is "viewing as" someone, so
 *  the on-behalf write is attributed to the human at the keyboard. */
async function staffOnRequest(cookies: CookieSource | undefined): Promise<Extract<PortalActor, { kind: "STAFF" }> | null> {
  const s = await verifySession(await cookieValue(cookies, SESSION_COOKIE));
  if (!s) return null;
  const u = await prisma.appUser.findUnique({ where: { id: s.uid }, select: { id: true, name: true, role: true, status: true } });
  if (!u || u.status !== "ACTIVE" || !STAFF_ON_BEHALF_ROLES.has(u.role)) return null;
  return { kind: "STAFF", staffUserId: u.id, staffName: u.name, staffRole: u.role };
}

/**
 * WHO IS ASKING, AND WHAT MAY THEY SEE. The only entry point; every page,
 * action and route goes through it.
 *
 *   token  → the link's enrollment. Checks accessRevokedAt, then
 *            portalTokenExpiresAt. An OWNER/ADMIN hub session on the same
 *            request turns the visit into STAFF-on-behalf (the owner iframe)
 *            and is not subject to the link's expiry — staff are authenticated
 *            by their own login. Any other hub session is just the link.
 *   cookie → the ClientUser, then their LIVE memberships (revokedAt null),
 *            then the enrollment (`enrollmentId` picks one when they hold
 *            several; otherwise the first, ACTIVE programs first).
 *   status → ACTIVE = FULL; PAUSED / ENDED = READ_ONLY (released content only,
 *            no new activity) — on the link AND for a signed-in person.
 *            Jordan's ruling: a paused or ended client keeps what they were
 *            given unless a human explicitly revokes access (accessRevokedAt,
 *            or Expire on the card). The only way an ended program's link
 *            stops is that explicit act, never the status change itself.
 */
export async function resolvePortalViewer(input: {
  token?: string | null;
  cookies?: CookieSource;
  enrollmentId?: string | null;
}): Promise<PortalResolution> {
  const token = (input.token ?? "").trim();
  if (token) {
    if (!TOKEN_RE.test(token)) return { ok: false, reason: "invalid_token" };
    const e = await prisma.contentEnrollment.findUnique({ where: { portalToken: token }, select: ENROLLMENT_SELECT });
    if (!e) return { ok: false, reason: "invalid_token" };
    if (e.accessRevokedAt) return { ok: false, reason: "revoked" };
    const staff = await staffOnRequest(input.cookies);
    if (staff) {
      return { ok: true, viewer: { enrollment: await enrollmentWithName(e), actor: staff, access: accessFor(e.status), via: "STAFF" } };
    }
    if (e.portalTokenExpiresAt && e.portalTokenExpiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired_token" };
    // ENDED is deliberately NOT a refusal here. An ended program's link keeps
    // rendering the released library read-only (accessFor), exactly like a
    // paused one: Jordan's rule is that paused AND ended clients keep what
    // they were given until someone revokes it. A link that has been
    // forwarded too widely is closed by Expire/Rotate on the owner's card —
    // a human's decision, recorded — not by the status flipping.
    return { ok: true, viewer: { enrollment: await enrollmentWithName(e), actor: { kind: "TOKEN" }, access: accessFor(e.status), via: "TOKEN" } };
  }

  const session = await verifyClientSession(await cookieValue(input.cookies, CLIENT_COOKIE));
  if (!session) return { ok: false, reason: "no_session" };
  const person = await prisma.clientUser.findUnique({ where: { id: session.cu }, select: { id: true, email: true, name: true, status: true } });
  if (!person || person.status === "DISABLED") return { ok: false, reason: "no_session" };
  const seats = await liveMemberships(person.id);
  const seat = input.enrollmentId ? seats.find((s) => s.enrollmentId === input.enrollmentId) : seats[0];
  if (!seat) return { ok: false, reason: "no_membership" };
  const e = await prisma.contentEnrollment.findUnique({ where: { id: seat.enrollmentId }, select: ENROLLMENT_SELECT });
  if (!e) return { ok: false, reason: "no_membership" };
  // Belt and braces: the seat's denormalised clientId must agree with the
  // enrollment's — a membership row moved by hand to another program is not a
  // seat on it.
  if (e.clientId !== seat.clientId) return { ok: false, reason: "no_membership" };
  if (e.accessRevokedAt) return { ok: false, reason: "revoked" };
  return {
    ok: true,
    viewer: {
      enrollment: await enrollmentWithName(e),
      actor: { kind: "CLIENT", clientUserId: person.id, email: person.email, name: person.name, membershipId: seat.id, membershipRole: asRole(seat.role) },
      access: accessFor(e.status),
      via: "LOGIN",
    },
  };
}

const asRole = (r: string): PortalRole => (r === "OWNER" || r === "COLLABORATOR" || r === "VIEWER" ? r : "VIEWER");

/** A signed-in person's live seats, ACTIVE programs first — the picker on
 *  /portal/me and the resolver's default choice share this order. "Live"
 *  means: the seat is not revoked, the enrollment's access is not revoked,
 *  AND the seat's denormalised clientId agrees with the enrollment's — so
 *  every caller (the resolver, the cut stream, the sign-in flow) inherits the
 *  same ownership check and none can forget it (review, Sep 17). */
export async function liveMemberships(clientUserId: string) {
  const rows = await prisma.clientMembership.findMany({
    where: { clientUserId, revokedAt: null },
    orderBy: { invitedAt: "asc" },
    select: { id: true, enrollmentId: true, clientId: true, role: true },
  });
  if (rows.length === 0) return [];
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { id: { in: rows.map((r) => r.enrollmentId) }, accessRevokedAt: null },
    select: { id: true, status: true, clientId: true },
  });
  const clients = await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const byId = new Map(enrollments.map((e) => [e.id, e]));
  return rows
    .filter((r) => byId.get(r.enrollmentId)?.clientId === r.clientId)
    .map((r) => ({ ...r, status: byId.get(r.enrollmentId)!.status, clientName: nameOf.get(r.clientId) ?? "" }))
    .sort((a, b) => Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE"));
}

/** The person signed in on this request (for the picker / account menu), or null. */
export async function currentClientUser(cookies?: CookieSource) {
  const session = await verifyClientSession(await cookieValue(cookies, CLIENT_COOKIE));
  if (!session) return null;
  const person = await prisma.clientUser.findUnique({ where: { id: session.cu }, select: { id: true, email: true, name: true, status: true } });
  return person && person.status !== "DISABLED" ? person : null;
}

/** Does anyone hold a live seat on this enrollment? (The "set up your
 *  sign-in" banner on a token visit.) */
export async function enrollmentHasMembership(enrollmentId: string): Promise<boolean> {
  return (await prisma.clientMembership.count({ where: { enrollmentId, revokedAt: null } })) > 0;
}

/**
 * Thin legacy wrapper — the pre-Sep-16 signature. Resolves a token visit ONLY
 * (no cookies, no staff) and only when the program is running. Kept so nothing
 * that still imports it breaks; new code calls resolvePortalViewer.
 */
export async function portalEnrollment(token: string): Promise<Pick<PortalEnrollment, "id" | "clientId" | "videosPerMonth"> | null> {
  const r = await resolvePortalViewer({ token, cookies: { get: () => undefined } });
  if (!r.ok || r.viewer.access !== "FULL") return null;
  const { id, clientId, videosPerMonth } = r.viewer.enrollment;
  return { id, clientId, videosPerMonth };
}

/** One PortalVisit per render — the log that answers "has anyone opened it".
 *  Best-effort: a failed write must never break the page. */
export async function recordPortalVisit(viewer: PortalViewer, path: string): Promise<void> {
  const a = viewer.actor;
  await prisma.portalVisit
    .create({
      data: {
        enrollmentId: viewer.enrollment.id,
        clientUserId: a.kind === "CLIENT" ? a.clientUserId : null,
        staffUserId: a.kind === "STAFF" ? a.staffUserId : null,
        via: viewer.via,
        path: path.slice(0, 200),
      },
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// OWNERSHIP. A ContentMonth belongs to an enrollment; a Project is attached to
// a month by contentMonthId — but the Project ALSO carries its own clientId,
// and nothing used to check that the two agree. A project filed on the wrong
// client's month would have shown that client's video to this one. Every read
// below drops such a project and reports it once.
// ---------------------------------------------------------------------------

// Reported once per process per project: the bell dedupes on its own key, but
// re-ringing it on every render (cuts AND library both hit this) just fills
// the log with unique-violation noise.
const reported = new Map<string, number>();
const REPORT_TTL_MS = 60 * 60_000;

async function reportMisattached(enrollment: { id: string; clientId: string }, projects: { id: string; clientId: string; title?: string | null }[]): Promise<void> {
  for (const p of projects) {
    const last = reported.get(p.id);
    if (last && Date.now() - last < REPORT_TTL_MS) continue;
    reported.set(p.id, Date.now());
    console.warn(`[portal] project ${p.id} (client ${p.clientId}) is attached to a month of enrollment ${enrollment.id} (client ${enrollment.clientId}) — hidden from the portal`);
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "portal_misattached",
        title: "A job is attached to the wrong client's month",
        body: `${p.title ?? p.id} belongs to another client but sits on this program's month. It is hidden from the portal until it is moved.`,
        href: `/content/${enrollment.id}`,
        targets: [{ roles: ["OWNER", "ADMIN"] }],
        dedupeKey: `portal-misattached-${p.id}`,
      });
    } catch { /* the console line is the record of last resort */ }
  }
}

/**
 * Prove a submission belongs to the viewer's enrollment AND client, AND was
 * shown to the client (internally approved — or already bounced BY this
 * client, so their follow-up notes on the same cut still land).
 */
export async function submissionForEnrollment(enrollment: { id: string; clientId: string }, submissionId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(submissionId)) return null;
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, status: true, clientRequestedAt: true, clientReleasedAt: true, project: { select: { contentMonthId: true, title: true, clientId: true } } },
  });
  if (!sub?.project?.contentMonthId) return null;
  const month = await prisma.contentMonth.findUnique({
    where: { id: sub.project.contentMonthId },
    select: { enrollmentId: true },
  });
  if (month?.enrollmentId !== enrollment.id) return null;
  if (sub.project.clientId !== enrollment.clientId) {
    await reportMisattached(enrollment, [{ id: sub.projectId, clientId: sub.project.clientId, title: sub.project.title }]);
    return null;
  }
  if (sub.status !== "APPROVED" && !sub.clientReleasedAt) {
    // Never approved and never released = internal — unless this enrollment
    // already acted on it (their own revision flipped it to CHANGES_REQUESTED).
    if (sub.clientRequestedAt) return sub;
    const theirs = await prisma.portalComment.count({ where: { submissionId, enrollmentId: enrollment.id } });
    if (theirs === 0) return null;
  }
  return sub;
}

/** Prove a script belongs to the viewer's enrollment AND is client-visible. */
export async function scriptForEnrollment(enrollmentId: string, scriptId: string) {
  const script = await prisma.contentScript.findUnique({
    where: { id: scriptId },
    select: { id: true, enrollmentId: true, title: true, status: true, monthId: true },
  });
  if (!script || script.enrollmentId !== enrollmentId) return null;
  if (!CLIENT_VISIBLE_SCRIPT.includes(script.status)) return null;
  return script;
}

// The pre-§7 library path (portalCuts / portalLibrary / portalMonths, their
// row types, ownProjects and portalMonthKeys) was REMOVED on Sep 17 2026.
// Every one of them carried a ceiling the §7 work exists to remove — 200 rows,
// 12 months, 8 Aryeo lookups — and nothing called them any more, so a reader
// could easily have believed those caps were still the portal's behaviour.
// The library now lives in contentVideos.ts (logical videos, year navigation,
// pagination, no ceiling).

// ---------------------------------------------------------------------------
// LIVE SESSION SCHEDULING (Jordan, Aug 28 — rule confirmed: sessions start no
// earlier than 3 BUSINESS DAYS after the strategy call). Slots come straight
// from Aryeo's scheduling calendar; availability is company-wide, so one
// 10-minute cache serves every portal. Booking stays human-confirmed: the
// client picks a real slot + location, the desk gets the exact slot to book.
//
// Since Sep 17 the gate is the program month's DERIVED state (W1-B's
// deriveMonthState, read through recalcProgramMonth's dry run): the window
// opens 3 business days (ET) after the call was HELD — or, on the written
// path, after the answers were submitted — never "tomorrow because the call
// was skipped" (SYNTHESIS §19). A call that is merely BOOKED unlocks the
// picker for slots after call + window, exactly as before: the request is
// only ever "awaiting confirmation", so a slot chosen before the call is
// held costs nothing if the call moves. And the month is EXPLICIT: the
// client picks which program month the session is for (a request made in
// late September may be October's), so the gate, the capacity and the
// request all belong to that month.
// ---------------------------------------------------------------------------

export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

export type PortalSlotDay = { date: string; slots: string[] }; // ISO starts

const SLOTS_CACHE_KEY = "portal-aryeo-slots";
const SLOTS_TTL_MS = 10 * 60_000;

/** Company-wide Aryeo availability for the next three weeks (cached 10 min).
 *  Unfiltered: the scheduler filters per chosen month's earliest moment. */
export async function companySlotDays(): Promise<PortalSlotDay[]> {
  const cached = await prisma.appSetting.findUnique({ where: { key: SLOTS_CACHE_KEY } }).catch(() => null);
  if (cached) {
    try {
      const v = JSON.parse(cached.value) as { at: number; days: PortalSlotDay[] };
      if (Date.now() - v.at < SLOTS_TTL_MS) return v.days;
    } catch { /* recompute */ }
  }
  const { getSchedulingAvailability, Aryeo } = await import("@/lib/integrations/aryeo");
  const dates = (await getSchedulingAvailability({ days: 21, limit: 8 }).catch(() => null)) ?? [];
  const days: PortalSlotDay[] = [];
  for (let i = 0; i < dates.length; i += 4) {
    await Promise.all(
      dates.slice(i, i + 4).map(async (d) => {
        try {
          const r = (await Aryeo.availableTimeslots({ timezone: "America/New_York", interval: 60, date: d.date })) as {
            data?: { start_at?: string }[];
          };
          const slots = (r?.data ?? [])
            .map((s) => s.start_at)
            .filter((s): s is string => !!s)
            .slice(0, 10);
          if (slots.length) days.push({ date: d.date, slots });
        } catch { /* a missing day is fine */ }
      }),
    );
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  await prisma.appSetting
    .upsert({
      where: { key: SLOTS_CACHE_KEY },
      update: { value: JSON.stringify({ at: Date.now(), days }) },
      create: { key: SLOTS_CACHE_KEY, value: JSON.stringify({ at: Date.now(), days }) },
    })
    .catch(() => {});
  return days;
}

export type SessionGate = {
  locked: boolean;
  reason: string; // client-safe, why it is locked ("" when open)
  earliest: Date; // the first moment a session may start (when open)
  callStatus: string; // the DERIVED strategyCallStatus for the month
  callAt: Date | null;
  planningMode: string; // CALL | WRITTEN | UNDECIDED (derived)
};

// Client-safe sentences for a locked month. The written path never mentions
// a call; the call path never mentions answers.
const LOCK_BOOK_CALL = "Book your strategy call first — we plan the month on that call, then film it.";
const LOCK_ANSWERS = "Send us your planning answers first — we plan the month from them, then film it.";
const LOCK_PREPARING = "We're still preparing this month — session booking opens as soon as planning is done.";

/**
 * The gate + earliest bookable moment for ONE program month of this
 * enrollment. Refuses (locked) a month that is not this enrollment's or is
 * historical. Never persists anything: recalcProgramMonth runs as a dry run,
 * and the request itself (createSessionRequest) is what recalculates.
 */
export async function sessionGate(enrollmentId: string, monthId: string): Promise<SessionGate> {
  const closed = (reason: string, extra: Partial<SessionGate> = {}): SessionGate =>
    ({ locked: true, reason, earliest: new Date(), callStatus: "NOT_SCHEDULED", callAt: null, planningMode: "UNDECIDED", ...extra });
  if (!/^[a-z0-9]{10,40}$/i.test(monthId)) return closed("Pick one of your program months.");
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true, historical: true } });
  if (!month || month.enrollmentId !== enrollmentId) return closed("Pick one of your program months.");
  if (month.historical) return closed("That month is closed.");
  const { recalcProgramMonth, addBusinessDaysET } = await import("@/lib/programMonths");
  const r = await recalcProgramMonth(monthId, { dryRun: true });
  if (!r) return closed("Pick one of your program months.");
  const d = r.after;
  const base = { callStatus: d.strategyCallStatus, callAt: d.strategyCallAt, planningMode: d.planningMode };
  // Nothing today: a same-day slot is not a request the desk can honour.
  const floor = new Date(Date.now() + 24 * 3600_000);
  const open = (from: Date): SessionGate => ({ locked: false, reason: "", earliest: from > floor ? from : floor, ...base });
  if (d.earliestSessionAt) return open(d.earliestSessionAt);
  // Booked but not yet held: the same window, measured from the booked time.
  if (d.strategyCallStatus === "SCHEDULED" && d.strategyCallAt && d.strategyCallAt > new Date()) {
    return open(d.windowWaived ? d.strategyCallAt : addBusinessDaysET(d.strategyCallAt, d.windowDays));
  }
  if (d.planningMode === "WRITTEN") return closed(LOCK_ANSWERS, base);
  if (d.strategyCallStatus === "NOT_SCHEDULED") return closed(LOCK_BOOK_CALL, base);
  return closed(LOCK_PREPARING, base);
}

export type PortalSessionRequest = {
  id: string;
  status: string;
  label: string; // "Requested, awaiting confirmation" | "Booked" | …
  slotStartISO: string | null;
  slotEndISO: string | null;
  locationText: string | null;
  notes: string | null;
  createdAtISO: string;
};

export type PortalScheduleMonth = {
  monthId: string;
  monthKey: string;
  locked: boolean;
  reason: string;
  earliestISO: string | null;
  callStatus: string;
  callAtISO: string | null;
  planningMode: string;
  capacity: { allowed: number; used: number; remaining: number };
  requests: PortalSessionRequest[];
  /** A real shoot on the calendar for this month (Project.shootDate), if any. */
  bookedShootISO: string | null;
};

// The statuses a request still "is" — a cancelled or expired one is history
// the client may see, but never blocks a new request (createSessionRequest
// treats them the same way).
export const OPEN_REQUEST_STATUSES = ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"];

/**
 * The months a client may book a session FOR: this ET month and the open
 * months after it (at most three), each with its own gate, capacity and the
 * requests already made — so "Requested, awaiting confirmation" survives a
 * reload and a second click lands on the same row.
 */
export async function portalScheduleMonths(enrollment: { id: string; clientId: string }): Promise<PortalScheduleMonth[]> {
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId: enrollment.id, historical: false, monthKey: { gte: etMonthKey() } },
    orderBy: { monthKey: "asc" },
    take: 3,
    select: { id: true, monthKey: true },
  });
  if (months.length === 0) return [];
  const { sessionCapacity, listSessionRequests } = await import("@/lib/sessionRequests");
  const shoots = await prisma.project.findMany({
    where: { contentMonthId: { in: months.map((m) => m.id) }, clientId: enrollment.clientId, status: { not: "CANCELLED" }, shootDate: { not: null } },
    orderBy: { shootDate: "asc" },
    select: { contentMonthId: true, shootDate: true },
  });
  const out: PortalScheduleMonth[] = [];
  for (const m of months) {
    const [gate, capacity, rows] = await Promise.all([
      sessionGate(enrollment.id, m.id),
      sessionCapacity(enrollment.id, m.id),
      listSessionRequests(enrollment.id, m.id),
    ]);
    // The view W1-B exports carries no notes; the client's own "what works"
    // text lives there ("Preferred: …"), so read it for the rows shown.
    const shown = rows.slice(0, 6);
    const notes = shown.length
      ? new Map((await prisma.programSessionRequest.findMany({ where: { id: { in: shown.map((r) => r.id) } }, select: { id: true, notes: true } })).map((r) => [r.id, r.notes]))
      : new Map<string, string | null>();
    out.push({
      monthId: m.id,
      monthKey: m.monthKey,
      locked: gate.locked,
      reason: gate.reason,
      earliestISO: gate.locked ? null : gate.earliest.toISOString(),
      callStatus: gate.callStatus,
      callAtISO: gate.callAt ? gate.callAt.toISOString() : null,
      planningMode: gate.planningMode,
      capacity: { allowed: capacity.allowed, used: capacity.used, remaining: capacity.remaining },
      requests: shown.map((r) => ({
        id: r.id, status: r.status, label: r.label,
        slotStartISO: r.slotStart ? r.slotStart.toISOString() : null,
        slotEndISO: r.slotEnd ? r.slotEnd.toISOString() : null,
        locationText: r.locationText, notes: notes.get(r.id) ?? null, createdAtISO: r.createdAt.toISOString(),
      })),
      bookedShootISO: shoots.find((s) => s.contentMonthId === m.id)?.shootDate?.toISOString() ?? null,
    });
  }
  return out;
}

// ===========================================================================
// WAVE 2 (Sep 17 2026) — the program pages: Video Topics, My Strategy, the
// planning state Home and Schedule share. Every read below takes the viewer's
// enrollment and scopes by it; the W1-C data functions (contentTopics,
// contentStrategy, contentInterview) are called, never re-implemented.
// ===========================================================================

export type PortalTopicState = "SUGGESTED" | "SELECTED" | "PREPARING" | "FILMED";

export type PortalTopic = {
  id: string;
  title: string;
  concept: string | null;
  pillarId: string | null;
  pillarName: string;
  audienceNeed: string | null;
  businessGoal: string | null;
  intendedMessage: string | null;
  source: string;
  /** The client suggested it. */
  mine: boolean;
  state: PortalTopicState;
  selection: { monthId: string; monthKey: string; status: string; overflow: boolean; removable: boolean } | null;
  interview: { id: string; status: string; answered: number } | null;
  script: { versionLabel: string | null; strategyLabel: string | null; shared: boolean } | null;
  strategyLabel: string | null;
  lastEventAtISO: string | null;
  history: { kind: string; atISO: string; note: string | null; monthKey: string | null }[];
};

export type PortalTopicMonth = { id: string; monthKey: string; owed: number; selected: number; overflow: number; historical: boolean };

export type PortalTopicsData = {
  groups: { pillarId: string | null; pillarName: string; purpose: string | null; topics: PortalTopic[] }[];
  /** Months a topic may be selected FOR: this ET month and the open ones after it. */
  months: PortalTopicMonth[];
  archivedCount: number;
  total: number;
  strategyLabel: string | null;
};

const LIVE_SELECTION = ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"];
const PRODUCTION_STATES = ["SCRIPTED", "FILMED", "EDITING", "DELIVERED"];

/** The client's bank by their pillars (Arielle's presentation) with the month selections, interviews and scripts each topic carries. */
export async function portalTopics(enrollment: { id: string; clientId: string }): Promise<PortalTopicsData> {
  const { topicBankByPillar } = await import("@/lib/contentTopics");
  const { listPillars } = await import("@/lib/contentPillars");
  const [bank, pillars, monthsRaw] = await Promise.all([
    topicBankByPillar(enrollment.id),
    listPillars(enrollment.id),
    prisma.contentMonth.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { monthKey: "asc" }, select: { id: true, monthKey: true, videosOwed: true, historical: true } }),
  ]);
  const topicIds = bank.groups.flatMap((g) => g.topics.map((t) => t.id));
  const [selections, interviews, scripts, events, versionsOfStrategies] = await Promise.all([
    prisma.contentTopicSelection.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: topicIds }, status: { in: LIVE_SELECTION } }, orderBy: { createdAt: "desc" } }),
    prisma.contentInterview.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: topicIds } }, select: { id: true, topicId: true, monthId: true, status: true, answeredCount: true } }),
    prisma.contentScript.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: topicIds }, historical: false }, select: { id: true, topicId: true, sharedVersionId: true, approvedVersionId: true, currentVersionId: true, strategyVersionId: true } }),
    topicIds.length ? prisma.contentTopicEvent.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: topicIds }, kind: { in: ["SELECTED", "DESELECTED", "DISCUSSED", "SCRIPTED", "FILMED", "DELIVERED", "CARRIED", "CREATED", "SUGGESTED"] } }, orderBy: { createdAt: "desc" }, select: { topicId: true, kind: true, createdAt: true, note: true, monthId: true, actorKind: true } }) : Promise.resolve([]),
    prisma.contentStrategyVersion.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true, versionNo: true } }),
  ]);
  const monthKeyOf = new Map(monthsRaw.map((m) => [m.id, m.monthKey]));
  const strategyLabelOf = new Map(versionsOfStrategies.map((v) => [v.id, `v${v.versionNo}`]));
  const versionIds = scripts.map((s) => s.sharedVersionId ?? s.approvedVersionId ?? s.currentVersionId).filter((x): x is string => !!x);
  const versions = versionIds.length ? await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNo: true, strategyVersionId: true } }) : [];
  const topicRows = topicIds.length ? await prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, strategyVersionId: true, clientUserId: true } }) : [];
  const stratOfTopic = new Map(topicRows.map((t) => [t.id, t.strategyVersionId]));
  const mineOfTopic = new Map(topicRows.map((t) => [t.id, !!t.clientUserId]));
  const currentKey = etMonthKey();
  const purposeOf = new Map(pillars.map((p) => [p.id, p.purpose]));

  const toTopic = (t: (typeof bank.groups)[number]["topics"][number], pillarName: string): PortalTopic => {
    const sel = selections.find((s) => s.topicId === t.id) ?? null;
    const iv = interviews.find((i) => i.topicId === t.id && (!sel || i.monthId === sel.monthId)) ?? interviews.find((i) => i.topicId === t.id) ?? null;
    const sc = scripts.find((s) => s.topicId === t.id) ?? null;
    const scv = sc ? versions.find((v) => v.id === (sc.sharedVersionId ?? sc.approvedVersionId ?? sc.currentVersionId)) ?? null : null;
    const inProduction = PRODUCTION_STATES.includes(t.status);
    const state: PortalTopicState = ["FILMED", "EDITING", "DELIVERED"].includes(t.status) ? "FILMED" : t.status === "SCRIPTED" || !!sc || (iv && iv.status !== "NOT_STARTED") ? "PREPARING" : sel ? "SELECTED" : "SUGGESTED";
    return {
      id: t.id, title: t.title, concept: t.concept, pillarId: t.pillarId, pillarName, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, source: t.source,
      mine: t.source === "client" || !!mineOfTopic.get(t.id), state,
      selection: sel ? { monthId: sel.monthId, monthKey: monthKeyOf.get(sel.monthId) ?? "", status: sel.status, overflow: sel.overflow, removable: !inProduction && sel.status !== "RECONCILED" } : null,
      interview: iv ? { id: iv.id, status: iv.status, answered: iv.answeredCount } : null,
      script: sc ? { versionLabel: scv ? `v${scv.versionNo}` : null, strategyLabel: scv?.strategyVersionId ? strategyLabelOf.get(scv.strategyVersionId) ?? null : sc.strategyVersionId ? strategyLabelOf.get(sc.strategyVersionId) ?? null : null, shared: !!sc.sharedVersionId } : null,
      strategyLabel: stratOfTopic.get(t.id) ? strategyLabelOf.get(stratOfTopic.get(t.id)!) ?? null : null,
      lastEventAtISO: t.lastEventAt,
      history: events.filter((e) => e.topicId === t.id).slice(0, 8).map((e) => ({ kind: e.kind, atISO: e.createdAt.toISOString(), note: e.actorKind === "CLIENT" || e.actorKind === "STAFF" ? e.note : null, monthKey: e.monthId ? monthKeyOf.get(e.monthId) ?? null : null })),
    };
  };
  const groups = bank.groups.map((g) => ({ pillarId: g.pillarId, pillarName: g.pillarName, purpose: g.pillarId ? purposeOf.get(g.pillarId) ?? null : null, topics: g.topics.map((t) => toTopic(t, g.pillarName)) }));
  const open = monthsRaw.filter((m) => !m.historical && m.monthKey >= currentKey).slice(0, 3);
  const months: PortalTopicMonth[] = open.map((m) => {
    const sels = selections.filter((s) => s.monthId === m.id);
    // Derived from the two numbers, not from the row flag — the flag is frozen
    // at insert and a package change rewrites videosOwed underneath it, which
    // is how "4 of 2 videos chosen" reached a client's own page (review,
    // Sep 17). Same arithmetic as contentTopics.monthCapacity.
    const over = Math.max(0, sels.length - m.videosOwed);
    return { id: m.id, monthKey: m.monthKey, owed: m.videosOwed, selected: sels.length - over, overflow: over, historical: m.historical };
  });
  const approvedStrategy = versionsOfStrategies.length ? await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: enrollment.id, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { versionNo: true } }) : null;
  return { groups, months, archivedCount: bank.archived, total: bank.total, strategyLabel: approvedStrategy ? `v${approvedStrategy.versionNo}` : null };
}

/** Prove a topic is this enrollment's and in the bank (not rejected/archived). */
export async function topicForEnrollment(enrollmentId: string, topicId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(topicId)) return null;
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId } });
  if (!t || t.enrollmentId !== enrollmentId) return null;
  if (t.status === "REJECTED" || t.status === "ARCHIVED" || t.approvalState === "REJECTED" || t.approvalState === "ARCHIVED") return null;
  return t;
}

/** Prove a month is this enrollment's and open for selection. */
export async function openMonthForEnrollment(enrollmentId: string, monthId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(monthId)) return null;
  const m = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, monthKey: true, historical: true, videosOwed: true } });
  if (!m || m.enrollmentId !== enrollmentId || m.historical || m.monthKey < etMonthKey()) return null;
  return m;
}

export type PortalInterviewView = {
  interviewId: string;
  topicId: string;
  topicTitle: string;
  monthKey: string;
  status: string;
  next: { kind: "question" | "follow-up" | "done"; prompt: string | null; isFollowUp: boolean };
  nextKey: string | null;
  progress: { answered: number; substantiveAnswered: number; substantiveTotal: number };
  answers: { questionKey: string; questionText: string; answerText: string | null; answerKind: string; version: number }[];
  gaps: string[];
  ready: boolean;
  submittedAtISO: string | null;
  /** The latest draft built from THESE answers — client-facing lines only, never filming notes. */
  draft: { versionLabel: string; strategyLabel: string | null; body: string; gaps: string[]; changedSince: boolean; createdAtISO: string } | null;
  strategyLabel: string | null;
};

/** Where the guided interview stands for one of the viewer's topics (ownership proven by the caller). */
export async function portalInterview(enrollment: { id: string; clientId: string }, interviewId: string): Promise<PortalInterviewView | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(interviewId)) return null;
  const row = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { id: true, enrollmentId: true, topicId: true, monthId: true, submittedAt: true, strategyVersionId: true } });
  if (!row || row.enrollmentId !== enrollment.id) return null;
  const { interviewState, answersChangedSinceLastDraft } = await import("@/lib/contentInterview");
  const [st, topic, month, draftVersion, changed, strategy] = await Promise.all([
    interviewState(interviewId),
    prisma.contentTopic.findUnique({ where: { id: row.topicId }, select: { title: true } }),
    prisma.contentMonth.findUnique({ where: { id: row.monthId }, select: { monthKey: true } }),
    prisma.contentScriptVersion.findFirst({ where: { interviewId, enrollmentId: enrollment.id }, orderBy: { createdAt: "desc" }, select: { id: true, versionNo: true, title: true, hook: true, pointsJson: true, close: true, gapsJson: true, strategyVersionId: true, createdAt: true, clientId: true } }),
    answersChangedSinceLastDraft(interviewId),
    row.strategyVersionId ? prisma.contentStrategyVersion.findUnique({ where: { id: row.strategyVersionId }, select: { versionNo: true } }) : Promise.resolve(null),
  ]);
  let draft: PortalInterviewView["draft"] = null;
  if (draftVersion) {
    const { canonicalFromParts, pointsFromJson } = await import("@/lib/contentScripts");
    const { renderScript } = await import("@/lib/contentPolicy");
    const { stripMoneySentences } = await import("@/lib/text");
    const dv = draftVersion.strategyVersionId ? await prisma.contentStrategyVersion.findUnique({ where: { id: draftVersion.strategyVersionId }, select: { versionNo: true } }) : null;
    let gaps: string[] = [];
    try { gaps = draftVersion.gapsJson ? (JSON.parse(draftVersion.gapsJson) as { text?: string }[]).map((g) => g.text ?? "").filter(Boolean) : []; } catch { gaps = []; }
    draft = {
      versionLabel: `v${draftVersion.versionNo}`, strategyLabel: dv ? `v${dv.versionNo}` : null,
      body: stripMoneySentences(renderScript(canonicalFromParts({ title: draftVersion.title, hook: draftVersion.hook, points: pointsFromJson(draftVersion.pointsJson), close: draftVersion.close }, draftVersion.clientId))),
      gaps, changedSince: changed, createdAtISO: draftVersion.createdAt.toISOString(),
    };
  }
  return {
    interviewId, topicId: row.topicId, topicTitle: topic?.title ?? "Topic", monthKey: month?.monthKey ?? "", status: st.status,
    next: { kind: st.next.kind, prompt: st.next.kind === "done" ? null : st.next.prompt, isFollowUp: st.next.kind === "follow-up" }, nextKey: st.nextKey,
    progress: { answered: st.answeredCount, substantiveAnswered: st.sufficiency.substantiveAnswered, substantiveTotal: st.sufficiency.substantiveTotal },
    answers: st.answers.filter((a) => !a.questionKey.includes(":fu:") || a.answerText).map((a) => ({ questionKey: a.questionKey, questionText: a.questionText, answerText: a.answerText, answerKind: a.answerKind, version: a.version })),
    gaps: st.sufficiency.gaps.map((g) => g.text), ready: st.sufficiency.ready, submittedAtISO: row.submittedAt?.toISOString() ?? null, draft,
    strategyLabel: strategy ? `v${strategy.versionNo}` : null,
  };
}

// ---------------------------------------------------------------------------
// MY STRATEGY — the RELEASED version only. The gate is a column, never a text
// filter: a row without releasedAt does not exist to this page, whatever it
// says. Source structure (the document's own headings, in its order) is what
// renders; the policy's structured read supplies the summary.
// ---------------------------------------------------------------------------

export type PortalStrategyView = {
  versionNo: number;
  approvedAtISO: string | null;
  releasedAtISO: string;
  sourceKind: string;
  /** The source's own sections, verbatim order, money-scrubbed, internal mechanics left out. */
  sections: { id: string; heading: string; body: string }[];
  summary: { brandMessage: string | null; brandVoice: string | null; coreValues: string | null; audience: string[]; goals: string[]; pillars: { name: string; purpose: string | null; focusAreas: string | null }[] } | null;
  /** Newer versions exist internally but are not released — the client sees this one. */
  newerPending: boolean;
  proposalsOpen: number;
};

// Internal production mechanics never render on the client's page (Jordan,
// Aug 28) — the video-structure framework and caption-CTA lists are ours.
// This is PRESENTATION on a released row, not the visibility gate.
const INTERNAL_HEADING = /framework|caption|production|internal/i;

export async function portalStrategy(enrollment: { id: string; clientId: string }): Promise<PortalStrategyView | null> {
  const released = await prisma.contentStrategyVersion.findFirst({
    where: { enrollmentId: enrollment.id, clientId: enrollment.clientId, releasedAt: { not: null }, status: { in: ["APPROVED", "SUPERSEDED", "SHARED"] } },
    orderBy: { versionNo: "desc" },
  });
  if (!released?.releasedAt) return null;
  const { parseStoredSections } = await import("@/lib/contentStrategy");
  const { stripMoneySentences } = await import("@/lib/text");
  const stored = parseStoredSections(released.sectionsJson);
  const sections = (stored?.sections ?? [])
    .filter((s) => !INTERNAL_HEADING.test(s.heading))
    .map((s) => ({ id: s.id, heading: s.heading, body: stripMoneySentences(s.text) }))
    .filter((s) => s.body.trim().length > 0);
  let summary: PortalStrategyView["summary"] = null;
  try {
    const sj = released.summaryJson ? (JSON.parse(released.summaryJson) as Record<string, unknown>) : null;
    if (sj) {
      const aud = (sj.audience ?? {}) as Record<string, unknown>;
      summary = {
        brandMessage: typeof sj.brandMessage === "string" ? stripMoneySentences(sj.brandMessage) : null,
        brandVoice: typeof sj.brandVoice === "string" ? sj.brandVoice : null,
        coreValues: typeof sj.coreValues === "string" ? sj.coreValues : null,
        audience: [aud.clientTypes, aud.serviceAreas, aud.positioningGoal].filter((x): x is string => typeof x === "string" && !!x.trim()).map(stripMoneySentences),
        goals: Array.isArray(sj.goals) ? sj.goals.filter((x): x is string => typeof x === "string").map(stripMoneySentences) : [],
        pillars: Array.isArray(sj.pillars) ? (sj.pillars as { name?: string; purpose?: string | null; focusAreas?: string | null }[]).filter((p) => p?.name).map((p) => ({ name: p.name!, purpose: p.purpose ?? null, focusAreas: p.focusAreas ?? null })) : [],
      };
    }
  } catch { summary = null; }
  const [newer, proposalsOpen] = await Promise.all([
    prisma.contentStrategyVersion.count({ where: { enrollmentId: enrollment.id, versionNo: { gt: released.versionNo }, status: { in: ["APPROVED", "INTERNAL_REVIEW", "DRAFT"] } } }),
    prisma.contentStrategyProposal.count({ where: { enrollmentId: enrollment.id, status: "PROPOSED", sourceKind: "client" } }),
  ]);
  return {
    versionNo: released.versionNo, approvedAtISO: released.approvedAt?.toISOString() ?? null, releasedAtISO: released.releasedAt.toISOString(), sourceKind: released.sourceKind,
    sections, summary, newerPending: newer > 0, proposalsOpen,
  };
}

// ---------------------------------------------------------------------------
// PLANNING — the strategy-call appointment and the two-path choice (spec §4/
// §19) for one program month, derived (never stored by this read).
// ---------------------------------------------------------------------------

export type PortalPlanning = {
  monthId: string;
  monthKey: string;
  callMode: string; // REQUIRED | OPTIONAL_WRITTEN | NOT_INCLUDED
  callStatus: string; // NOT_REQUIRED | NOT_SCHEDULED | SCHEDULED | COMPLETED | SKIPPED
  callAtISO: string | null;
  callEndISO: string | null;
  timezone: string;
  meetLink: string | null;
  planningMode: string; // CALL | WRITTEN | UNDECIDED
  preparationStatus: string | null;
  earliestSessionISO: string | null;
  /** "Plan without a call" may be offered — the enrollment's call mode allows it and it is not switched off for this client. */
  noCallEligible: boolean;
  /** Written path: answers submitted for every selected topic. */
  answersSubmitted: boolean;
  interviewsOpen: number;
};

export async function portalPlanning(enrollment: { id: string; clientId: string }, monthId?: string | null): Promise<PortalPlanning | null> {
  const month = monthId
    ? await prisma.contentMonth.findFirst({ where: { id: monthId, enrollmentId: enrollment.id }, select: { id: true, monthKey: true, historical: true } })
    : await prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, historical: false, monthKey: { gte: etMonthKey() } }, orderBy: { monthKey: "asc" }, select: { id: true, monthKey: true, historical: true } });
  if (!month) return null;
  const { recalcProgramMonth, callModeOf } = await import("@/lib/programMonths");
  const [r, e, record, interviews] = await Promise.all([
    recalcProgramMonth(month.id, { dryRun: true }),
    prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { callMode: true, strategyCallRequired: true, noCallEligible: true, timezone: true } }),
    prisma.programCallRecord.findFirst({
      where: { monthId: month.id, enrollmentId: enrollment.id, callType: "MONTHLY_STRATEGY", status: { in: ["SCHEDULED", "COMPLETED"] }, matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF", "AMBIGUOUS_CLIENT"] } },
      orderBy: { scheduledStart: "desc" }, select: { scheduledStart: true, scheduledEnd: true, meetLink: true, timezone: true },
    }),
    prisma.contentInterview.findMany({ where: { enrollmentId: enrollment.id, monthId: month.id }, select: { status: true, submittedAt: true } }),
  ]);
  if (!r || !e) return null;
  const d = r.after;
  const mode = callModeOf(e);
  return {
    monthId: month.id, monthKey: month.monthKey, callMode: mode, callStatus: d.strategyCallStatus,
    callAtISO: (record?.scheduledStart ?? d.strategyCallAt)?.toISOString() ?? null, callEndISO: record?.scheduledEnd?.toISOString() ?? null,
    timezone: e.timezone ?? record?.timezone ?? "America/New_York", meetLink: record?.meetLink ?? null,
    planningMode: d.planningMode, preparationStatus: d.preparationStatus, earliestSessionISO: d.earliestSessionAt?.toISOString() ?? null,
    // REQUIRED wins over any per-client flag; NOT_INCLUDED already IS the written path, so the offer is moot there.
    noCallEligible: mode === "OPTIONAL_WRITTEN" && e.noCallEligible !== false,
    answersSubmitted: interviews.length > 0 && interviews.every((i) => i.status === "SUBMITTED" || !!i.submittedAt),
    interviewsOpen: interviews.filter((i) => i.status !== "SUBMITTED" && !i.submittedAt).length,
  };
}
