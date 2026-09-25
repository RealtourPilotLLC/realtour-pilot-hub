import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey, aryeoProductFor, RESUBSCRIBE_URL } from "@/lib/contentProgram";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/jwt";
import { verifyClientSession, CLIENT_COOKIE } from "@/lib/auth/clientSession";
import type { ClientMonthProgress, ClientSessionCard } from "@/lib/monthProgress";

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
// Pre-CPOS rows carry no releaseState, so they are judged by status alone.
// APPROVED IS NOT ON THIS LIST (Jordan, Sep 18: visibility comes after approval
// AND release). The statuses that remain all assert the script already went out
// and was used — a script cannot be FILMED without the client having had it.
// Verified Sep 18: 0 non-historical scripts reach a client through this list,
// so it is a closed door rather than a change to anything live.
export const CLIENT_VISIBLE_SCRIPT = ["CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"];

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

/**
 * Prove a script belongs to the viewer's enrollment AND is client-visible.
 *
 * This is an AUTHORIZATION gate on the portal's write layer (it is what stands
 * between a client and "suggest a change to this script"), and until Sep 18 it
 * ran its own status test while postingKit ran the real rule — two gates, one
 * of which had already been overtaken by `releaseState`. It now calls
 * postingKit.scriptVisibility, which is the only one.
 *
 * Measured before the swap, over all 164 ContentScript rows: 0 lose access, 141
 * gain it (135 historical imports + 6 released). The gain is the point — a
 * client who may READ their script history may say something about it — and the
 * loss is what matters, so it was checked first. Against the pre-Sep-18 list
 * (which still carried APPROVED) the swap would have closed 2 withheld scripts;
 * commit 1b24065 closed those already.
 *
 * The verdict rides along: a caller that needs to tell "this month's script"
 * from "an import we keep as history" must not re-derive it.
 */
export async function scriptForEnrollment(enrollmentId: string, scriptId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(scriptId)) return null;
  const script = await prisma.contentScript.findUnique({
    where: { id: scriptId },
    select: { id: true, enrollmentId: true, title: true, status: true, monthId: true, releaseState: true, historical: true },
  });
  if (!script || script.enrollmentId !== enrollmentId) return null;
  const { scriptVisibility } = await import("@/lib/postingKit");
  const verdict = scriptVisibility(script);
  if (!verdict) return null;
  return { ...script, verdict };
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

export type PortalSlotDay = {
  date: string;
  /** ISO starts, each one genuinely long enough for this session (see below). */
  slots: string[];
  /** the session length these starts were measured against, in minutes. */
  fitsMinutes?: number;
  /** who could actually film it — Aryeo's own per-product assignment. */
  creatives?: string[];
  /** CP-04: per start, the eligible creatives Aryeo says are free for it —
   *  assigned to THIS product and free at THIS start. The client picks one when
   *  there is more than one; the adapter books that person and nobody else. */
  slotCreatives?: Record<string, { teamMemberId: string; name: string }[]>;
};

// RETIRED Sep 21 2026. The old company-wide cache. The row is left in place
// rather than deleted (house rule), and nothing reads it any more: the slots it
// holds were computed with no duration and no creative, so serving one would
// re-offer exactly the starts this change removed.
const LEGACY_SLOTS_CACHE_KEY = "portal-aryeo-slots";
void LEGACY_SLOTS_CACHE_KEY;

// RETIRED Sep 21 2026, hours old. `…:v2:${minutes}` keyed the calendar on
// session length alone, and Accelerator and Pro are BOTH 240 minutes: whichever
// package asked first wrote the row the other one then read for ten minutes.
// The cached day carries a `creatives` list that came from
// productAvailability({ productId }) and that product's own assigned providers,
// so a shared row hands Pro the Accelerator's roster (and the starts that fit
// it) — throwing away the per-product scoping this batch was built to add. Left
// in place rather than deleted (house rule); nothing reads it.
const LEGACY_SLOTS_CACHE_KEY_V2 = "portal-aryeo-slots:v2";
void LEGACY_SLOTS_CACHE_KEY_V2;

const SLOTS_TTL_MS = 10 * 60_000;
/** Keyed by the whole question asked of Aryeo, because every part of it changes
 *  the answer: WHICH PRODUCT (its own assigned creatives), how long one session
 *  is, and how far ahead we looked. */
// v4 (CP-04, Sep 24 2026): a v3 row carries no per-slot creatives, so a v3 hit
// would offer slots the adapter cannot tie to a person. Left in place, unread.
const slotsCacheKey = (productId: string, minutes: number, days: number) =>
  `portal-aryeo-slots:v4:${productId}:${minutes}:${days}`;

// ---------------------------------------------------------------------------
// THE SLOTS A CLIENT IS OFFERED (Jordan, Sep 21 2026).
//
// What this used to do, and what it cost, MEASURED rather than reasoned about
// (Phase 0, six consecutive days against the live account). companySlotDays
// called getSchedulingAvailability with interval 60 and then availableTimeslots
// with interval 60 — no duration, no product, no creative, company-wide. Over
// those six days it offered 66 starts where 19 fit a four-hour Accelerator with
// James. On Thursday 2026-09-24 it offered 11 starts on a day James had zero.
// 11 of the 66 were on a Saturday, which this program does not film.
//
// Three separate faults, and all three are Aryeo telling the truth to a
// question nobody meant to ask:
//   · NO DURATION. Aryeo defaults to meta.duration 0, so it answers "is this
//     person free at 4pm", not "can they give us four hours from 4pm".
//   · NO CREATIVE. The default roster is every is_service_provider — five
//     people, including Harrison, who is NOT assigned to any of the three
//     program products, and Sarah Anne, whose Aryeo login is inactive.
//   · NO WEEKEND RULE. §8 says no weekend shoots in this program; Aryeo offered
//     14 four-hour slots on Saturday 2026-09-26. The provider will not enforce
//     it, so the hub does.
//
// integrations/aryeo.productAvailability fixes all three, and reads the
// eligible creatives from Aryeo on every call so an assignment Jordan changes
// in the Aryeo UI is reflected without a deploy.
// ---------------------------------------------------------------------------

/**
 * Real, bookable slot days for ONE program package.
 *
 * `sessionMinutes` is the length the client actually needs: 120 for Starter,
 * 240 for Accelerator, and 240 for EACH of Pro's two four-hour sessions (Jordan,
 * Sep 21: Pro is the existing four-hour product booked twice, not a new
 * eight-hour product — so Pro asks this for 240, once per session, and never
 * for 480).
 */
export async function programSlotDays(opts: {
  package?: string | null;
  /** overrides the package's own length — a Pro session asks for 240 */
  sessionMinutes?: number | null;
  days?: number;
}): Promise<PortalSlotDay[]> {
  const product = aryeoProductFor(opts.package);
  const minutes = opts.sessionMinutes ?? product?.durationMinutes ?? null;
  // No package, or a package we do not sell: offer nothing. An unknown package
  // used to fall through to the company-wide list, which is the over-offer.
  if (!product || !minutes) return [];

  const horizonDays = opts.days ?? 21;
  const key = slotsCacheKey(product.productId, minutes, horizonDays);
  const cached = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (cached) {
    try {
      const v = JSON.parse(cached.value) as { at: number; days: PortalSlotDay[] };
      if (Date.now() - v.at < SLOTS_TTL_MS) return v.days;
    } catch { /* recompute */ }
  }

  const { productAvailability } = await import("@/lib/integrations/aryeo");
  const got = await productAvailability({
    productId: product.productId,
    durationMin: minutes,
    days: horizonDays,
    interval: 30,
  }).catch(() => null);
  // COULD NOT ASK vs NOBODY IS FREE. A null is Aryeo being unreachable, and an
  // empty calendar is a real answer — so a null is NOT cached, or one bad
  // minute would show every client an empty scheduler for the next ten.
  if (!got) return [];

  const bookable = got.providers.filter((p) => p.bookable);
  const named = bookable.map((p) => p.name ?? p.teamMemberId);
  // Timeslots answer in USER ids; the product's assignment is TEAM-MEMBER ids.
  // A start whose users cannot be read (or lists nobody) was already filtered
  // to the product's bookable creatives, so it offers all of them and the
  // adapter's recheck decides.
  const { teamMemberIdByUserId } = await import("@/lib/integrations/aryeo");
  const tmByUser = await teamMemberIdByUserId().catch(() => new Map<string, string>());
  const days: PortalSlotDay[] = got.days.map((d) => {
    const slots = d.slots.slice(0, 10);
    const slotCreatives: Record<string, { teamMemberId: string; name: string }[]> = {};
    for (const s of slots) {
      const tms = new Set((d.slotUsers?.[s] ?? []).map((u) => tmByUser.get(u)).filter((x): x is string => !!x));
      const who = tms.size ? bookable.filter((p) => tms.has(p.teamMemberId)) : bookable;
      slotCreatives[s] = who.map((p) => ({ teamMemberId: p.teamMemberId, name: p.name ?? "Your videographer" }));
    }
    return { date: d.date, slots, fitsMinutes: minutes, creatives: named, slotCreatives };
  });
  await prisma.appSetting
    .upsert({
      where: { key },
      update: { value: JSON.stringify({ at: Date.now(), days }) },
      create: { key, value: JSON.stringify({ at: Date.now(), days }) },
    })
    .catch(() => {});
  return days;
}

/**
 * The portal's slot list.
 *
 * SIGNATURE KEPT, BEHAVIOUR CORRECTED. PortalPage.tsx calls this with no
 * arguments and is outside this batch, so the default has to be safe on its own.
 * It asks for 240 minutes — the longest program session — against the creatives
 * Aryeo has assigned to the Accelerator product, weekends excluded.
 *
 * WHAT THAT COSTS, SAID PLAINLY. A 2-hour Starter client is offered only the
 * starts where four hours fit, so they see FEWER real slots than they could
 * have. That is the deliberate direction: this change exists because the portal
 * offered slots nobody could film, and under-offering a Starter client is a
 * booking Kyle can still make by hand, while over-offering is a client picking a
 * time and being told no. Four ACTIVE Starter enrollments are affected today.
 *
 * CP-04 (Sep 24 2026): PortalPage now passes the viewer's package, so the
 * Starter client gets their own 120-minute calendar. The default stays as the
 * safe answer for any caller that cannot say.
 */
export async function companySlotDays(opts?: { package?: string | null; sessionMinutes?: number | null }): Promise<PortalSlotDay[]> {
  return programSlotDays({
    package: opts?.package ?? "Accelerator",
    sessionMinutes: opts?.sessionMinutes ?? null,
  });
}

/** Saturday or Sunday on the CLIENT'S calendar, not the server's. A 00:30 ET
 *  Saturday start is Saturday to them and Friday to a UTC box. */
export function isWeekendET(at: Date): boolean {
  const d = at.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
  return d === "Sat" || d === "Sun";
}

/**
 * THE SERVER-SIDE HALF OF "NO WEEKEND SHOOTS" (§8; A22).
 *
 * Hiding weekends from the picker is a UI fact, and §8 is a business rule — a
 * request posted straight at the server action carries whatever ISO string the
 * caller chose. The preparation window is already enforced for real on that
 * path (src/app/portal/actions.ts:254-266 calls sessionGate and refuses a slot
 * earlier than gate.earliest), which is why this gap is worth closing the same
 * way rather than trusting the calendar component.
 *
 * WIRED (CP-04, Sep 24 2026): portalRequestSession, portalRescheduleSession
 * and the booking adapter's own guards all refuse a weekend slot with this.
 *
 * Returns the client-safe refusal, or null when the slot is fine. Jordan's
 * voice: no em dashes, no emojis, and it says the way forward.
 */
export function sessionSlotRefusal(slotStart: Date): string | null {
  if (isWeekendET(slotStart)) {
    return "We film these sessions Monday through Friday. Pick a weekday and we will get you on the calendar.";
  }
  return null;
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
  const { recalcProgramMonth, addWeekdayHoursET } = await import("@/lib/programMonths");
  const r = await recalcProgramMonth(monthId, { dryRun: true });
  if (!r) return closed("Pick one of your program months.");
  const d = r.after;
  const base = { callStatus: d.strategyCallStatus, callAt: d.strategyCallAt, planningMode: d.planningMode };
  // Nothing today: a same-day slot is not a request the desk can honour.
  const floor = new Date(Date.now() + 24 * 3600_000);
  const open = (from: Date): SessionGate => ({ locked: false, reason: "", earliest: from > floor ? from : floor, ...base });
  if (d.earliestSessionAt) return open(d.earliestSessionAt);
  // Booked but not yet held: the SAME clock, measured from when that booking is
  // due to END — because that is the base deriveMonthState will use the moment
  // the call is held, so what the client is told today is what the gate will
  // say tomorrow. A booking with no end on record falls back to its start.
  //
  // Sep 21 2026, F04. This line used to read
  //   addBusinessDaysET(d.strategyCallAt, d.windowDays)
  // and it is a real gate, not a hint: portalRequestSession rejects any slot
  // before `earliest`. When §8's window became 48 weekday HOURS, the derived
  // `windowDays` fell from 3 to 2 without the name changing, so every client
  // with a booked call could suddenly request filming a full business day
  // earlier than the day before. Two separate readings of one rule — days
  // here, hours there — is what allowed that, so `windowDays` no longer
  // exists and this branch runs the hour clock itself.
  if (d.strategyCallStatus === "SCHEDULED" && d.strategyCallAt && d.strategyCallAt > new Date()) {
    const callEndsAt = d.strategyCallEndsAt ?? d.strategyCallAt;
    return open(d.windowWaived ? callEndsAt : addWeekdayHoursET(callEndsAt, d.windowHours));
  }
  if (d.planningMode === "WRITTEN") return closed(LOCK_ANSWERS, base);
  if (d.strategyCallStatus === "NOT_SCHEDULED") return closed(LOCK_BOOK_CALL, base);
  return closed(LOCK_PREPARING, base);
}

export type PortalSessionRequest = {
  id: string;
  status: string;
  /** CP-04: the provider booking's state, for the label and the buttons. */
  bookingState: string;
  creativeName: string | null;
  /** the client may still move or cancel it here (not inside 24 hours, not mid-booking) */
  canChange: boolean;
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
  /** A real shoot on the calendar for this month (Project.shootDate), if any.
   *  Kept for older readers; the card reads `sessions` (CP-04). */
  bookedShootISO: string | null;
  /** CP-04: one row per DISTINCT session, from the month-progress reader — so a
   *  Pro month with one of two booked reads "1 of 2", never "booked". */
  sessions: PortalScheduleSession[];
  sessionsRequired: number;
  sessionsMissing: number;
  /** CP-04: SELF = the hub books it in Aryeo itself; DESK = Kyle books it by hand. */
  bookingMode: "SELF" | "DESK";
};

export type PortalScheduleSession = {
  key: string;
  startISO: string | null;
  state: ClientSessionCard["state"];
  label: string;
  /** CP-05: the address on file, whether an exact one is still needed, and where its sync stands in the client's words. */
  area: string | null;
  addressNeeded: boolean;
  addressNote: string | null;
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
  const { within24hElapsed, IN_FLIGHT_STATES } = await import("@/lib/sessionBooking");
  const { monthProgressMany, progressKey, clientMonthProgress } = await import("@/lib/monthProgress");
  const { sessionAddressViews } = await import("@/lib/sessionAddress");
  const progress = await monthProgressMany(months.map((m) => ({ enrollmentId: enrollment.id, monthId: m.id, monthKey: m.monthKey })), { owners: false }).catch(() => null);
  const bookingMode = await portalBookingMode(enrollment.clientId);
  const now = new Date();
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
        id: r.id, status: r.status, label: r.label, bookingState: r.bookingState, creativeName: r.creativeName,
        canChange: (r.status === "REQUESTED" || r.status === "CONFIRMED") && !r.changePending &&
          !(r.status === "REQUESTED" && (IN_FLIGHT_STATES as readonly string[]).includes(r.bookingState)) &&
          !(r.slotStart && within24hElapsed(r.slotStart, now)),
        slotStartISO: r.slotStart ? r.slotStart.toISOString() : null,
        slotEndISO: r.slotEnd ? r.slotEnd.toISOString() : null,
        locationText: r.locationText, notes: notes.get(r.id) ?? null, createdAtISO: r.createdAt.toISOString(),
      })),
      bookedShootISO: shoots.find((s) => s.contentMonthId === m.id)?.shootDate?.toISOString() ?? null,
      ...(await scheduleSessionsFor(progress?.get(progressKey(enrollment.id, m.id, m.monthKey)) ?? null, enrollment, m.id, clientMonthProgress, sessionAddressViews)),
      bookingMode,
    });
  }
  return out;
}

/** SELF only when the adapter's own guard would write for this client — the same
 *  read-only question createSessionRequest asks. Everyone else is desk-assisted,
 *  and the card says so in those words. */
async function portalBookingMode(clientId: string): Promise<"SELF" | "DESK"> {
  try {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
    const { hubWritePermit } = await import("@/lib/integrations/aryeo");
    return (await hubWritePermit({ switchKey: "session_booking", client, operation: "orders.create" })).ok ? "SELF" : "DESK";
  } catch {
    return "DESK";
  }
}

/** The month's distinct sessions for the card, with each one's address state (CP-04/CP-05). */
async function scheduleSessionsFor(
  p: import("@/lib/monthProgress").MonthProgress | null,
  enrollment: { id: string; clientId: string },
  monthId: string,
  toClient: typeof import("@/lib/monthProgress").clientMonthProgress,
  addressViews: typeof import("@/lib/sessionAddress").sessionAddressViews,
): Promise<Pick<PortalScheduleMonth, "sessions" | "sessionsRequired" | "sessionsMissing">> {
  if (!p || p.clientId !== enrollment.clientId) return { sessions: [], sessionsRequired: 1, sessionsMissing: 0 };
  const cards = toClient(p).sessions.cards;
  const views = await addressViews(enrollment.id, monthId, p.sessions.list).catch(() => new Map());
  return {
    sessionsRequired: p.sessions.required,
    sessionsMissing: p.sessions.missing,
    sessions: p.sessions.list.map((f, i) => {
      const v = views.get(f.key) ?? null;
      return {
        key: f.key, startISO: f.startsAtISO, state: cards[i]?.state ?? "BOOKED", label: cards[i]?.label ?? "Booked",
        area: v?.area ?? null, addressNeeded: v?.needed ?? false, addressNote: v?.note ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// HOME'S MONTH PROGRESS (CP-10, Sep 24 2026). Home used to read the first
// project's shoot date: "Booked" before it, "Filmed" the day after — nobody
// had to confirm anything — and `!sessionBooked` hid "Book your filming
// session" on a Pro month with one of its two sessions on the calendar. It
// now reads the SAME month-progress reader Jordan's roster, the client file
// and the reminders read, reduced to what a client may see (no names, no
// internal states).
// ---------------------------------------------------------------------------

/** This enrollment's month through lib/monthProgress, client-safe. */
export async function portalMonthProgress(enrollment: { id: string; clientId: string }, monthKey: string, opts: { now?: Date } = {}): Promise<ClientMonthProgress> {
  const month = await prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, clientId: enrollment.clientId, monthKey }, select: { id: true } });
  const { monthProgressMany, progressKey, clientMonthProgress } = await import("@/lib/monthProgress");
  const map = await monthProgressMany([{ enrollmentId: enrollment.id, monthId: month?.id ?? null, monthKey }], { now: opts.now, owners: false });
  const p = map.get(progressKey(enrollment.id, month?.id ?? null, monthKey));
  if (!p || p.clientId !== enrollment.clientId) throw new Error("month progress unavailable");
  return clientMonthProgress(p);
}

export type HomeSessionView = {
  /** One card per DISTINCT session (a Pro order's two appointments are two cards). */
  cards: ClientSessionCard[];
  required: number;
  /** Sessions still to book — the capacity check's and the reminder chaser's number. */
  missing: number;
  /** Every owed session is on the calendar. */
  sessionBooked: boolean;
  /** They asked; the office has not confirmed. */
  requested: boolean;
  /** Home offers "Book your filming session". */
  offerBooking: boolean;
};

/**
 * What Home shows about sessions — pure, so the drill holds it to the same
 * numbers as every staff screen. With the progress unreadable nothing is
 * offered: an unknown is not a reason to ask the client to book again.
 */
export function homeSessionView(progress: ClientMonthProgress | null, schedule: PortalScheduleMonth | null, opts: { canBook: boolean; readOnly: boolean }): HomeSessionView {
  const required = progress?.sessions.required ?? 1;
  const missing = progress?.sessions.missing ?? 0;
  const sessionBooked = !!progress && missing === 0;
  // A request whose time was taken before the hub could book it (CP-04) is not
  // "requested" — the client has to pick again, so Home offers booking.
  const open = schedule?.requests.filter((r) => (r.status === "REQUESTED" && r.bookingState !== "CONFLICT") || r.status === "RESCHEDULE_REQUESTED") ?? [];
  const requested = !sessionBooked && open.length > 0;
  return {
    cards: progress?.sessions.cards ?? [],
    required, missing, sessionBooked, requested,
    offerBooking: !!progress && !opts.readOnly && opts.canBook && !!schedule && !schedule.locked && missing > 0 && !requested && schedule.capacity.remaining > 0,
  };
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
  script: {
    /** The ContentScript id — needed so the client can act on the script, not just read it. */
    id: string;
    /**
     * R1: the EXACT version this page is rendering. Sent back with the client's
     * decision so the server can refuse a stale tab rather than recording an
     * approval of words they never read. Null when nothing is shared.
     */
    sharedVersionId: string | null;
    versionLabel: string | null;
    strategyLabel: string | null;
    shared: boolean;
    /**
     * THEIR OWN VERDICT on the shared version (F09). Null when nothing is
     * shared, or when their last answer was about an earlier version — an
     * approval of v2 is not an approval of v3, and the buttons come back.
     */
    decision: "APPROVED" | "CHANGES_REQUESTED" | null;
    decidedAtISO: string | null;
    /** They approved an earlier version and the words have changed since. */
    staleApproval: boolean;
  } | null;
  /**
   * THE WORDS, when the client is allowed to read them. Null is the normal
   * case: a draft, an internal review, an approved-but-withheld script all
   * arrive here as null, and the page says the script is being prepared.
   * Filled only by `portalTopicScript`, which asks postingKit.scriptVisibility.
   */
  scriptText: PortalTopicScript | null;
  strategyLabel: string | null;
  lastEventAtISO: string | null;
  history: { kind: string; atISO: string; note: string | null; monthKey: string | null }[];
  /**
   * CP-07. `declined`: they said "not interested" (the bank hides it; the page
   * shows it in a "set aside" strip with undo). `carried`: an unfilmed script
   * carried into an open month, which they may swap. `scriptedNotFilmed`: a
   * script exists and nothing has been filmed — carried, or parked by a swap.
   * `swappable`: the carried selection's id, when a swap is allowed now.
   */
  declined: { atISO: string; reason: string | null } | null;
  carried: { selectionId: string; fromMonthKey: string | null } | null;
  scriptedNotFilmed: boolean;
  swappable: string | null;
};

export type PortalTopicScript = {
  title: string;
  /** Already money-scrubbed and client-facing; render it, do not re-process it. */
  body: string;
  versionLabel: string | null;
  strategyLabel: string | null;
  /** An import we hold as history, NOT the script for this topic's next video (Jordan's ruling). */
  historical: boolean;
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

// ---------------------------------------------------------------------------
// THE SCRIPT UNDER A TOPIC (Jordan, Sep 18)
//
// The portal promised a script it could not show. The interview page said "Your
// script is ready — it's under this topic" and the scripts_ready email said
// "Read it here"; the topic row printed a version NUMBER and nothing else, and
// the only place in the whole portal that rendered a script body needed a
// ContentVideo. Measured Sep 18: ContentVideo.topicId is set on 0 of 167 rows,
// so 5 of the 6 released scripts were reachable by zero videos. Two true
// sentences and no script.
//
// So this is where a script meets its topic, and the gate is
// postingKit.scriptVisibility — called, not restated. Everything else here is
// scoping and ranking:
//   · candidates are scoped to enrollmentId AND clientId, like every other read
//     on this page — a script filed under the wrong client is not a candidate
//     at all rather than something we notice later;
//   · a released script outranks a historical one, so an import can never
//     shadow this month's work;
//   · nothing else crosses the boundary. A DRAFT, an INTERNAL_REVIEW, an
//     APPROVED-but-withheld script all resolve to null and the page says the
//     script is being prepared, which is what is true.
//
// One batched resolve serves both callers (the whole bank, and one interview's
// topic) so the gate runs in exactly one place and a 52-topic bank is still
// three queries.
// ---------------------------------------------------------------------------

async function visibleTopicScripts(enrollment: { id: string; clientId: string }, topicIds: string[]): Promise<Map<string, PortalTopicScript>> {
  const out = new Map<string, PortalTopicScript>();
  const ids = topicIds.filter((id) => /^[a-z0-9]{10,40}$/i.test(id));
  if (!ids.length) return out;
  const [{ scriptVisibility }, { canonicalFromParts, pointsFromJson }, { renderScript }, { stripMoneySentences }] = await Promise.all([
    import("@/lib/postingKit"),
    import("@/lib/contentScripts"),
    import("@/lib/contentPolicy"),
    import("@/lib/text"),
  ]);
  const candidates = await prisma.contentScript.findMany({
    where: { enrollmentId: enrollment.id, clientId: enrollment.clientId, topicId: { in: ids } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, topicId: true, title: true, body: true, clientId: true, status: true, releaseState: true, historical: true, sharedVersionId: true, approvedVersionId: true, strategyVersionId: true },
  });
  // One winner per topic: released beats historical, then newest (the findMany
  // is already newest-first, so the first survivor of each rank wins).
  const winner = new Map<string, { s: (typeof candidates)[number]; historical: boolean }>();
  for (const s of candidates) {
    if (!s.topicId) continue;
    const verdict = scriptVisibility(s);
    if (!verdict) continue;
    const held = winner.get(s.topicId);
    if (held && !(held.historical && verdict === "released")) continue;
    winner.set(s.topicId, { s, historical: verdict === "historical" });
  }
  if (!winner.size) return out;

  const versionIds = [...winner.values()].map((w) => w.s.sharedVersionId ?? w.s.approvedVersionId).filter((x): x is string => !!x);
  const versions = versionIds.length
    ? await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds }, enrollmentId: enrollment.id, clientId: enrollment.clientId }, select: { id: true, versionNo: true, title: true, categoryLabel: true, pillarId: true, hook: true, pointsJson: true, close: true, captionCta: true, clientId: true, strategyVersionId: true } })
    : [];
  const stratIds = [...new Set([...versions.map((v) => v.strategyVersionId), ...[...winner.values()].map((w) => w.s.strategyVersionId)].filter((x): x is string => !!x))];
  const strategies = stratIds.length ? await prisma.contentStrategyVersion.findMany({ where: { id: { in: stratIds } }, select: { id: true, versionNo: true } }) : [];
  const stratLabel = new Map(strategies.map((s) => [s.id, `v${s.versionNo}`]));

  for (const [topicId, { s, historical }] of winner) {
    const v = versions.find((x) => x.id === (s.sharedVersionId ?? s.approvedVersionId));
    const strategyId = v?.strategyVersionId ?? s.strategyVersionId ?? null;
    const strategyLabel = strategyId ? stratLabel.get(strategyId) ?? null : null;
    if (v) {
      const canonical = canonicalFromParts({ title: v.title, categoryLabel: v.categoryLabel, pillarId: v.pillarId, hook: v.hook, points: pointsFromJson(v.pointsJson), close: v.close, captionCta: v.captionCta }, v.clientId);
      out.set(topicId, { title: v.title, body: stripMoneySentences(renderScript(canonical)), versionLabel: `v${v.versionNo}`, strategyLabel, historical });
      continue;
    }
    // No version row — an import, which is 140 of the 142 topic-linked visible
    // scripts today. postingKit hands these back RAW rather than re-rendering
    // them, and it is right to: running the 140 through
    // partsFromBody -> canonicalFromParts -> renderScript drops more than 5% of
    // the words on 45 of them, worst case 168 words down to 17 (measured Sep
    // 18). A client's own script is not worth normalising into a house format
    // at the price of losing two thirds of it.
    out.set(topicId, { title: s.title, body: stripMoneySentences(s.body), versionLabel: null, strategyLabel, historical });
  }
  return out;
}

/**
 * The script the client may read under ONE topic — or null, which is the answer
 * for a draft, an internal review and an approved-but-withheld script alike.
 * The verdict comes from postingKit.scriptVisibility; see visibleTopicScripts.
 */
export async function portalTopicScript(enrollment: { id: string; clientId: string }, topicId: string): Promise<PortalTopicScript | null> {
  return (await visibleTopicScripts(enrollment, [topicId])).get(topicId) ?? null;
}

/** The client's bank by their pillars (Arielle's presentation) with the month selections, interviews and scripts each topic carries. */
export async function portalTopics(enrollment: { id: string; clientId: string }): Promise<PortalTopicsData> {
  const { topicBankByPillar, clientCanSeeTopic } = await import("@/lib/contentTopics");
  const { listPillars } = await import("@/lib/contentPillars");
  const [bank, pillars, monthsRaw] = await Promise.all([
    topicBankByPillar(enrollment.id),
    listPillars(enrollment.id),
    prisma.contentMonth.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { monthKey: "asc" }, select: { id: true, monthKey: true, videosOwed: true, historical: true } }),
  ]);
  // CP-07: WHAT THE CLIENT MAY SEE is contentTopics.clientCanSeeTopic, asked
  // here — not a status filter restated. A call's discussed and "declined on
  // the call" ideas are unreviewed PROPOSED topics and stay off this page until
  // Jordan approves them; the call's own PROPOSED selection is the exception
  // (they chose it out loud). Topics the client said "not interested" to come
  // back in their own groups flagged `declined`, for the set-aside strip.
  const candidates = [...bank.groups.flatMap((g) => g.topics), ...bank.declined];
  const candidateIds = candidates.map((t) => t.id);
  const allSelections = candidateIds.length ? await prisma.contentTopicSelection.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: candidateIds }, status: { in: LIVE_SELECTION } }, orderBy: { createdAt: "desc" } }) : [];
  const liveTopic = new Set(allSelections.map((s) => s.topicId));
  const seen = (t: (typeof candidates)[number]) => clientCanSeeTopic({ ...t, clientDeclinedAt: null }, liveTopic.has(t.id));
  const visibleIds = new Set(candidates.filter(seen).map((t) => t.id));
  const topicIds = [...visibleIds];
  const selections = allSelections.filter((s) => visibleIds.has(s.topicId));
  const [interviews, scripts, events, versionsOfStrategies, topicScripts, footage] = await Promise.all([
    prisma.contentInterview.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: topicIds } }, select: { id: true, topicId: true, monthId: true, status: true, answeredCount: true } }),
    prisma.contentScript.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: topicIds }, historical: false }, select: { id: true, topicId: true, sharedVersionId: true, approvedVersionId: true, currentVersionId: true, strategyVersionId: true } }),
    topicIds.length ? prisma.contentTopicEvent.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: topicIds }, kind: { in: ["SELECTED", "DESELECTED", "DISCUSSED", "SCRIPTED", "FILMED", "DELIVERED", "CARRIED", "CREATED", "SUGGESTED", "DECLINED", "REINTRODUCED"] } }, orderBy: { createdAt: "desc" }, select: { topicId: true, kind: true, createdAt: true, note: true, monthId: true, actorKind: true } }) : Promise.resolve([]),
    prisma.contentStrategyVersion.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true, versionNo: true } }),
    // The words, for the topics whose script the client may actually read.
    // Batched: the biggest live bank is 52 topics carrying a script (Erica
    // Walker, Sep 18) and one resolve is three queries however many there are.
    visibleTopicScripts(enrollment, topicIds),
    // Footage settles "scripted, not filmed" — a confirmation or a video past
    // filming, never a status guess.
    topicIds.length ? prisma.contentVideo.findMany({ where: { enrollmentId: enrollment.id, topicId: { in: topicIds }, OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: ["FILMED", "EDITING", "CLIENT_REVIEW", "APPROVED", "DELIVERED"] } }] }, select: { topicId: true } }) : Promise.resolve([]),
  ]);
  // Their standing answer on each shared script (F09) — one batched read.
  const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
  const decisions = await scriptDecisionsFor(enrollment.id, scripts.map((s) => s.id)).catch(() => new Map());
  const monthKeyOf = new Map(monthsRaw.map((m) => [m.id, m.monthKey]));
  const openMonth = new Map(monthsRaw.map((m) => [m.id, !m.historical && m.monthKey >= etMonthKey()]));
  const filmed = new Set(footage.map((v) => v.topicId).filter((x): x is string => !!x));
  const strategyLabelOf = new Map(versionsOfStrategies.map((v) => [v.id, `v${v.versionNo}`]));
  const versionIds = scripts.map((s) => s.sharedVersionId ?? s.approvedVersionId ?? s.currentVersionId).filter((x): x is string => !!x);
  const versions = versionIds.length ? await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNo: true, strategyVersionId: true } }) : [];
  const topicRows = topicIds.length ? await prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, strategyVersionId: true, clientUserId: true } }) : [];
  const stratOfTopic = new Map(topicRows.map((t) => [t.id, t.strategyVersionId]));
  const mineOfTopic = new Map(topicRows.map((t) => [t.id, !!t.clientUserId]));
  const currentKey = etMonthKey();
  const purposeOf = new Map(pillars.map((p) => [p.id, p.purpose]));

  const toTopic = (t: (typeof candidates)[number], pillarName: string): PortalTopic => {
    // A selection in a month still open wins over one in a past month: after a
    // carry the topic's September row is history and its October row is the plan.
    const sel = selections.find((s) => s.topicId === t.id && openMonth.get(s.monthId)) ?? selections.find((s) => s.topicId === t.id) ?? null;
    const iv = interviews.find((i) => i.topicId === t.id && (!sel || i.monthId === sel.monthId)) ?? interviews.find((i) => i.topicId === t.id) ?? null;
    const sc = scripts.find((s) => s.topicId === t.id) ?? null;
    const scv = sc ? versions.find((v) => v.id === (sc.sharedVersionId ?? sc.approvedVersionId ?? sc.currentVersionId)) ?? null : null;
    const inProduction = PRODUCTION_STATES.includes(t.status);
    const state: PortalTopicState = ["FILMED", "EDITING", "DELIVERED"].includes(t.status) ? "FILMED" : t.status === "SCRIPTED" || !!sc || (iv && iv.status !== "NOT_STARTED") ? "PREPARING" : sel ? "SELECTED" : "SUGGESTED";
    const isFilmed = filmed.has(t.id) || ["FILMED", "EDITING", "DELIVERED"].includes(t.status);
    const carriedSel = sel?.status === "CARRIED" ? sel : null;
    return {
      id: t.id, title: t.title, concept: t.concept, pillarId: t.pillarId, pillarName, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, source: t.source,
      mine: t.source === "client" || !!mineOfTopic.get(t.id), state,
      // A call's PROPOSED row is its suggestion and always removable (CP-07).
      selection: sel ? { monthId: sel.monthId, monthKey: monthKeyOf.get(sel.monthId) ?? "", status: sel.status, overflow: sel.overflow, removable: sel.status === "PROPOSED" || (!inProduction && sel.status !== "RECONCILED" && sel.status !== "CARRIED") } : null,
      interview: iv ? { id: iv.id, status: iv.status, answered: iv.answeredCount } : null,
      script: sc
        ? {
            id: sc.id,
            sharedVersionId: sc.sharedVersionId,
            versionLabel: scv ? `v${scv.versionNo}` : null,
            strategyLabel: scv?.strategyVersionId ? strategyLabelOf.get(scv.strategyVersionId) ?? null : sc.strategyVersionId ? strategyLabelOf.get(sc.strategyVersionId) ?? null : null,
            shared: !!sc.sharedVersionId,
            decision: decisions.get(sc.id)?.decision ?? null,
            decidedAtISO: decisions.get(sc.id)?.decidedAt ?? null,
            staleApproval: decisions.get(sc.id)?.staleApproval ?? false,
          }
        : null,
      scriptText: topicScripts.get(t.id) ?? null,
      strategyLabel: stratOfTopic.get(t.id) ? strategyLabelOf.get(stratOfTopic.get(t.id)!) ?? null : null,
      lastEventAtISO: t.lastEventAt,
      history: events.filter((e) => e.topicId === t.id).slice(0, 8).map((e) => ({ kind: e.kind, atISO: e.createdAt.toISOString(), note: e.actorKind === "CLIENT" || e.actorKind === "STAFF" ? e.note : null, monthKey: e.monthId ? monthKeyOf.get(e.monthId) ?? null : null })),
      declined: t.clientDeclinedAt ? { atISO: t.clientDeclinedAt, reason: t.clientDeclineReason } : null,
      carried: carriedSel ? { selectionId: carriedSel.id, fromMonthKey: carriedSel.carriedFromMonthId ? monthKeyOf.get(carriedSel.carriedFromMonthId) ?? null : null } : null,
      // Carried, parked by a swap, or left on a month that has closed.
      scriptedNotFilmed: t.status === "SCRIPTED" && !!sc && !isFilmed && (!!carriedSel || !sel || !openMonth.get(sel.monthId)),
      swappable: carriedSel && !isFilmed && openMonth.get(carriedSel.monthId) ? carriedSel.id : null,
    };
  };
  const declinedIn = (pillarId: string | null) => bank.declined.filter((t) => visibleIds.has(t.id) && (pillarId ? t.pillarId === pillarId : !t.pillarId || !pillars.some((p) => p.id === t.pillarId)));
  const groups = bank.groups.map((g) => ({
    pillarId: g.pillarId, pillarName: g.pillarName, purpose: g.pillarId ? purposeOf.get(g.pillarId) ?? null : null,
    topics: [...g.topics.filter((t) => visibleIds.has(t.id)), ...declinedIn(g.pillarId)].map((t) => toTopic(t, g.pillarName)),
  }));
  // A declined topic with no pillar, on a bank whose every topic has one.
  if (!groups.some((g) => !g.pillarId)) {
    const orphans = declinedIn(null);
    if (orphans.length) groups.push({ pillarId: null, pillarName: "Not yet linked to a pillar", purpose: null, topics: orphans.map((t) => toTopic(t, "Not yet linked to a pillar")) });
  }
  const open = monthsRaw.filter((m) => !m.historical && m.monthKey >= currentKey).slice(0, 3);
  const months: PortalTopicMonth[] = open.map((m) => {
    const sels = selections.filter((s) => s.monthId === m.id);
    // Derived from the two numbers, not from the row flag — the flag is frozen
    // at insert and a package change rewrites videosOwed underneath it, which
    // is how "4 of 2 videos chosen" reached a client's own page (review,
    // Sep 17). Same arithmetic, and the same CARRIED-inclusive statuses, as
    // contentTopics.monthCapacity.
    const over = Math.max(0, sels.length - m.videosOwed);
    return { id: m.id, monthKey: m.monthKey, owed: m.videosOwed, selected: sels.length - over, overflow: over, historical: m.historical };
  });
  const approvedStrategy = versionsOfStrategies.length ? await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: enrollment.id, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { versionNo: true } }) : null;
  const total = groups.reduce((n, g) => n + g.topics.filter((t) => !t.declined).length, 0);
  return { groups, months, archivedCount: bank.archived, total, strategyLabel: approvedStrategy ? `v${approvedStrategy.versionNo}` : null };
}

// A topic leaves the client's bank on `status` alone: contentTopics.
// topicBankByPillar lists `status notIn ["REJECTED","ARCHIVED"]` and counts the
// rest as "set aside". That — not the stricter write gate in
// topicForEnrollment below, which also reads approvalState — is what decides
// whether a CARD exists for the client to be pointed at.
const OFF_BANK_TOPIC_STATUS = ["REJECTED", "ARCHIVED"];

/** Is this topic still on the client's bank, i.e. does a card for it render? */
export function topicOnBank(topic: { status: string } | null | undefined): boolean {
  return !!topic && !OFF_BANK_TOPIC_STATUS.includes(topic.status);
}

/**
 * Prove a topic is this enrollment's and in the bank (not rejected/archived).
 * CP-07: and one the CLIENT may see (contentTopics.clientCanSeeTopic) — an
 * unreviewed call or AI topic is not a thing a portal action can reach by id.
 * `allowDeclined` is for the undo of "not interested", the one action that
 * targets a topic the bank no longer shows.
 */
export async function topicForEnrollment(enrollmentId: string, topicId: string, opts: { allowDeclined?: boolean } = {}) {
  if (!/^[a-z0-9]{10,40}$/i.test(topicId)) return null;
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId } });
  if (!t || t.enrollmentId !== enrollmentId) return null;
  if (t.status === "REJECTED" || t.status === "ARCHIVED" || t.approvalState === "REJECTED" || t.approvalState === "ARCHIVED") return null;
  const { clientCanSeeTopic, ALLOWANCE_SELECTION_STATUSES } = await import("@/lib/contentTopics");
  const live = (await prisma.contentTopicSelection.count({ where: { topicId: t.id, status: { in: ALLOWANCE_SELECTION_STATUSES } } })) > 0;
  if (!clientCanSeeTopic({ ...t, clientDeclinedAt: opts.allowDeclined ? null : t.clientDeclinedAt }, live)) return null;
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
  /**
   * CP-08. `nextIsGap`: the question on screen is one of the (at most two)
   * targeted gap questions. `canSendWithGaps`: the questions are done, the
   * answers cannot carry a script yet, and the client may send what they have
   * (we follow up; nothing is drafted). `sentWithGapsAtISO`: they did.
   * `suggestions`: what they already said about this topic on a call —
   * client-spoken, confidential-scrubbed, optional and editable, with its
   * source shown.
   */
  nextIsGap: boolean;
  canSendWithGaps: boolean;
  sentWithGapsAtISO: string | null;
  suggestions: { id: string; text: string; source: string; callDateISO: string | null }[];
  /**
   * WHERE THE SCRIPT STANDS — never the script itself.
   *
   * This used to carry the rendered body of the newest version built from these
   * answers, behind the label "A draft for our creative review before it's
   * final". Jordan, Sep 18: a draft label is not a substitute for approval. The
   * workflow is answers -> generated draft -> INTERNAL REVIEW -> approval and
   * release -> client visibility, and an unreviewed AI draft sitting on a
   * client's screen skips the middle of it. Six such drafts were live across
   * four interviews when this was written.
   *
   * So no script TEXT crosses this boundary at all. A released script reaches
   * the client on its own surface, through postingKit.scriptVisibility, which
   * is the hub's one script-visibility rule. All this says is whether one is
   * being worked on:
   *   · "none"      — nothing built from these answers yet
   *   · "preparing" — a version exists and has not been released
   *   · "released"  — it is approved and shared; the client reads it on the topic
   *   · "set_aside" — the topic has left the bank, so there is no card to read
   *                   it on and this page claims nothing about it
   * `changedSince` still means "you have edited answers since the last draft",
   * which is true and useful without quoting anything.
   *
   * "set_aside" exists because both of the other two live stages point at a
   * card: "preparing" promises the script "appears under this topic", and
   * "released" says "it's under this topic". Staff archiving a topic that
   * carries a released script and an open interview left this page sending the
   * client to a card the bank no longer lists (review, Sep 18). Nothing is
   * hidden by it — the client's own answers stay on the page.
   */
  script: { stage: "none" | "preparing" | "released" | "set_aside"; changedSince: boolean };
  strategyLabel: string | null;
};

/**
 * The stage this page may CLAIM. Kept as its own function because the rule is
 * a rule, not an expression: both live stages point the client at the topic
 * card ("it appears under this topic", "it's under this topic"), so both are
 * false once the topic has left the bank — whatever the script rows say.
 */
export function interviewScriptStage(
  topic: { status: string } | null | undefined,
  opts: { released: boolean; versionsBuilt: number },
): PortalInterviewView["script"]["stage"] {
  if (!topicOnBank(topic)) return "set_aside";
  return opts.released ? "released" : opts.versionsBuilt > 0 ? "preparing" : "none";
}

/** Where the guided interview stands for one of the viewer's topics (ownership proven by the caller). */
export async function portalInterview(enrollment: { id: string; clientId: string }, interviewId: string): Promise<PortalInterviewView | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(interviewId)) return null;
  const row = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { id: true, enrollmentId: true, topicId: true, monthId: true, submittedAt: true, strategyVersionId: true, sentWithGapsAt: true } });
  if (!row || row.enrollmentId !== enrollment.id) return null;
  const { interviewState, answersChangedSinceLastDraft, suggestedAnswersFor } = await import("@/lib/contentInterview");
  const [st, topic, month, builtOne, changed, strategy, topicScript, suggestions] = await Promise.all([
    interviewState(interviewId),
    // `status` too: an archived topic has no card, and this page must not
    // send the client to one (see the stage doc above).
    prisma.contentTopic.findUnique({ where: { id: row.topicId }, select: { title: true, status: true } }),
    prisma.contentMonth.findUnique({ where: { id: row.monthId }, select: { monthKey: true } }),
    // COUNT, NOT CONTENT. We need to know whether a version exists; we must not
    // read its words, because nothing on this page may quote them.
    prisma.contentScriptVersion.count({ where: { interviewId, enrollmentId: enrollment.id } }),
    answersChangedSinceLastDraft(interviewId),
    row.strategyVersionId ? prisma.contentStrategyVersion.findUnique({ where: { id: row.strategyVersionId }, select: { versionNo: true } }) : Promise.resolve(null),
    // Has the finished script for this topic actually been released? Asked of
    // the ONE resolver, not of a releaseState test written out again here: this
    // panel now links the client to the script, and a panel that says "ready"
    // while the topic renders nothing is the bug this whole change exists to
    // kill. Its *verdict* is used; its text is thrown away on the next line.
    portalTopicScript(enrollment, row.topicId),
    suggestedAnswersFor(interviewId).catch(() => []),
  ]);
  const released = !!topicScript && !topicScript.historical;
  const script: PortalInterviewView["script"] = {
    stage: interviewScriptStage(topic, { released, versionsBuilt: builtOne }),
    changedSince: changed,
  };
  return {
    interviewId, topicId: row.topicId, topicTitle: topic?.title ?? "Topic", monthKey: month?.monthKey ?? "", status: st.status,
    next: { kind: st.next.kind, prompt: st.next.kind === "done" ? null : st.next.prompt, isFollowUp: st.next.kind === "follow-up" }, nextKey: st.nextKey,
    progress: { answered: st.answeredCount, substantiveAnswered: st.sufficiency.substantiveAnswered, substantiveTotal: st.sufficiency.substantiveTotal },
    answers: st.answers.filter((a) => !a.questionKey.includes(":fu:") || a.answerText).map((a) => ({ questionKey: a.questionKey, questionText: a.questionText, answerText: a.answerText, answerKind: a.answerKind, version: a.version })),
    gaps: st.sufficiency.gaps.map((g) => g.text), ready: st.sufficiency.ready, submittedAtISO: row.submittedAt?.toISOString() ?? null, script,
    strategyLabel: strategy ? `v${strategy.versionNo}` : null,
    nextIsGap: st.nextIsGap,
    // Already sent (either way) is not a second chance to send: a row sent
    // before CP-08 as SUBMITTED over a thin reading must not offer the button.
    canSendWithGaps: st.next.kind === "done" && !st.sufficiency.ready && st.status !== "SUBMITTED_WITH_GAPS" && st.status !== "SUBMITTED",
    sentWithGapsAtISO: row.sentWithGapsAt?.toISOString() ?? null,
    suggestions: suggestions.map((x) => ({ id: x.id, text: x.text, source: x.provenance.source, callDateISO: x.provenance.callDateISO })),
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

// ---------------------------------------------------------------------------
// CP-12 — THE READ-ONLY NOTICE. A paused or ended program keeps everything it
// was delivered (playback and downloads — accessFor gives READ_ONLY, never a
// refusal), and new generation and scheduling stay off through can(). What
// was missing was the way back: this is the one wording of that state, with
// the resubscribe link, so the banner and Home never say different things.
// ---------------------------------------------------------------------------
export type ReadOnlyNotice = { title: string; body: string; cta: { label: string; href: string } };

export function readOnlyNotice(status: string): ReadOnlyNotice {
  const paused = status === "PAUSED";
  return {
    title: paused ? "Your program is paused" : "Your program has ended",
    body: `Everything we\u2019ve delivered stays here for you to watch and download. New requests, notes, captions and bookings are off until it ${paused ? "resumes" : "restarts"} — text us any time.`,
    cta: { label: paused ? "Resume your program" : "Restart your program", href: RESUBSCRIBE_URL },
  };
}
