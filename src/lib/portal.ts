import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { DELIVERED_STAMP } from "@/lib/reviewCuts";
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

/** The projects on this enrollment's months that really are this client's. */
async function ownProjects<T extends { id: string; clientId: string; title?: string | null }>(enrollment: { id: string; clientId: string }, projects: T[]): Promise<T[]> {
  const wrong = projects.filter((p) => p.clientId !== enrollment.clientId);
  if (wrong.length) await reportMisattached(enrollment, wrong);
  return projects.filter((p) => p.clientId === enrollment.clientId);
}

// The month keys a portal shows: the current ET month plus the one before, so
// a cut approved on the 1st for last month's session doesn't vanish overnight.
export function portalMonthKeys(): string[] {
  const cur = etMonthKey();
  const [y, m] = cur.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return [cur, prev];
}

export type PortalCut = {
  submissionId: string;
  projectId: string;
  fileName: string | null;
  assetUrl: string; // streamable — cuts without a link are not shown
  approvedAtISO: string | null;
  monthKey: string;
  revisionOpen: boolean; // a re-cut is already in motion
  comments: { id: string; timeSec: number | null; body: string; status: string; createdAtISO: string }[];
};

/**
 * The cuts a client may watch: the latest INTERNALLY-APPROVED round per video
 * file, on THIS CLIENT'S projects attached to this enrollment's current/
 * previous month. A cut Jordan hasn't approved yet never reaches the client
 * (the human-approval gate the whole program runs on).
 */
export async function portalCuts(enrollment: { id: string; clientId: string }): Promise<PortalCut[]> {
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId: enrollment.id, monthKey: { in: portalMonthKeys() } },
    select: { id: true, monthKey: true },
  });
  if (months.length === 0) return [];
  const monthByProject = new Map<string, string>();
  const projects = await ownProjects(
    enrollment,
    await prisma.project.findMany({
      where: { contentMonthId: { in: months.map((m) => m.id) }, status: { not: "CANCELLED" } },
      select: { id: true, contentMonthId: true, clientId: true, title: true },
    }),
  );
  if (projects.length === 0) return [];
  const monthKeyById = new Map(months.map((m) => [m.id, m.monthKey]));
  for (const p of projects) monthByProject.set(p.id, monthKeyById.get(p.contentMonthId!) ?? "");

  const subs = await prisma.reviewSubmission.findMany({
    where: { projectId: { in: projects.map((p) => p.id) } },
    orderBy: { round: "asc" },
    select: { id: true, projectId: true, status: true, assetUrl: true, assetPath: true, fileName: true, decidedAt: true, decidedBy: true, deliverableId: true, slot: true, clientRequestedAt: true },
  });
  // Which submissions carry THIS client's notes — a cut they bounced (their
  // revision flips it to CHANGES_REQUESTED) stays on their page; an
  // internally-bounced cut they never saw does not.
  const allComments = await prisma.portalComment.findMany({
    where: { submissionId: { in: subs.map((s) => s.id) }, enrollmentId: enrollment.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, submissionId: true, timeSec: true, body: true, status: true, createdAt: true },
  });
  const commented = new Set(allComments.map((c) => c.submissionId));

  // Latest client-visible round per cut — deliberately NOT latest-round-then-
  // filter: while a redo is pending review, the client keeps watching the last
  // cut they were shown instead of the video vanishing mid-revision (the
  // "Updates in progress" chip tells them the new one is coming).
  const latestPerCut = new Map<string, (typeof subs)[number]>();
  for (const s of subs) {
    // A cut auto-stamped at DELIVERY is not an invitation to review — it is the
    // record that the job already went out. reviewCuts.ts marks those APPROVED
    // with decidedBy "Delivered to the client", and reading that as "show it for
    // review" put an August video Erica Walker already had back on her portal
    // under "For your review · Request changes", with her Home tab announcing
    // "1 video ready for your review". Delivered work belongs in the Library.
    if (s.decidedBy === DELIVERED_STAMP) continue;
    // Since Sep 16 the client's own request is stamped on clientRequestedAt
    // rather than on Jordan's QC fields — so a bounced cut is theirs to keep
    // seeing by EITHER mark.
    const theirs = commented.has(s.id) || !!s.clientRequestedAt;
    const visible = s.status === "APPROVED" || (s.status === "CHANGES_REQUESTED" && theirs);
    // A cut = (deliverable × slot) for uploaded rows, the file for legacy rows.
    if (visible && s.assetUrl) latestPerCut.set(`${s.projectId}:${s.deliverableId ? `${s.deliverableId}:${s.slot}` : (s.assetPath ?? s.id)}`, s);
  }
  const shown = [...latestPerCut.values()];
  if (shown.length === 0) return [];

  const comments = allComments.filter((c) => shown.some((s) => s.id === c.submissionId));
  const bySub = new Map<string, typeof comments>();
  for (const c of comments) {
    const arr = bySub.get(c.submissionId) ?? [];
    arr.push(c);
    bySub.set(c.submissionId, arr);
  }
  // An open video-lane revision on the project = the re-cut is in motion; the
  // portal says so instead of inviting a second identical request.
  const revisionTasks = await prisma.smartTask.findMany({
    where: { projectId: { in: shown.map((s) => s.projectId) }, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { projectId: true },
  });
  const revisionByProject = new Set(revisionTasks.map((t) => t.projectId).filter(Boolean) as string[]);

  return shown
    .map((s) => ({
      submissionId: s.id,
      projectId: s.projectId,
      fileName: s.fileName,
      assetUrl: s.assetUrl!,
      approvedAtISO: s.decidedAt ? s.decidedAt.toISOString() : null,
      monthKey: monthByProject.get(s.projectId) ?? "",
      revisionOpen: revisionByProject.has(s.projectId),
      comments: (bySub.get(s.id) ?? []).map((c) => ({
        id: c.id,
        timeSec: c.timeSec,
        body: c.body,
        status: c.status,
        createdAtISO: c.createdAt.toISOString(),
      })),
    }))
    .sort((a, b) => (b.approvedAtISO ?? "").localeCompare(a.approvedAtISO ?? ""));
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
    select: { id: true, projectId: true, status: true, clientRequestedAt: true, project: { select: { contentMonthId: true, title: true, clientId: true } } },
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
  if (sub.status !== "APPROVED") {
    // Never approved = internal — unless this enrollment already acted on it
    // (their own revision flipped it to CHANGES_REQUESTED).
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

export type PortalLibraryRow = {
  id: string;
  monthId: string | null;
  projectId: string | null;
  source: string;
  title: string | null;
  thumb: string | null;
  playback: string | null;
  download: string | null;
  deliveredAt: Date;
};

/**
 * The delivered library (PortalVideo rows) for this enrollment — minus any row
 * whose project belongs to another client, and minus the review-sourced
 * duplicates of a video that is already on Aryeo (delivered truth). URLs come
 * back RAW: the page swaps hub cut URLs for media-tokened ones.
 */
export async function portalLibrary(enrollment: { id: string; clientId: string }): Promise<PortalLibraryRow[]> {
  const rows = await prisma.portalVideo.findMany({
    where: { enrollmentId: enrollment.id },
    orderBy: { deliveredAt: "desc" },
    take: 200,
    select: { id: true, monthId: true, projectId: true, source: true, title: true, thumb: true, playback: true, download: true, deliveredAt: true },
  });
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
  const own = new Set(
    (
      await ownProjects(
        enrollment,
        projectIds.length ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, clientId: true, title: true } }) : [],
      )
    ).map((p) => p.id),
  );
  const kept = rows.filter((r) => !r.projectId || own.has(r.projectId));
  // One video, one card: once a project's videos are on Aryeo (delivered
  // truth), the review-sourced rows are the same cuts pre-delivery — drop
  // them (review finding: both writers materialized the same video twice).
  const aryeoProjects = new Set(kept.filter((v) => v.source === "aryeo" && v.projectId).map((v) => v.projectId));
  return kept.filter((v) => !(v.source === "review" && v.projectId && aryeoProjects.has(v.projectId)));
}

// ---------------------------------------------------------------------------
// THE CLIENT'S FULL HISTORY (Jordan, Aug 28: "are we able to see backfilled
// content too from Aryeo and their other content sessions and scripts?").
// Month-by-month: sessions, client-visible scripts, and the DELIVERED videos
// straight from Aryeo's CDN — watchable and downloadable, no proxy needed.
// ---------------------------------------------------------------------------

export type PortalMonthVideo = {
  title: string | null;
  thumb: string | null;
  playback: string | null;
  download: string | null;
};
export type PortalMonth = {
  monthKey: string;
  videosOwed: number;
  strategyCallStatus: string;
  strategyCallAtISO: string | null;
  sessions: { dateISO: string | null; delivered: boolean }[];
  scripts: { id: string; title: string; body: string }[];
  videos: PortalMonthVideo[]; // delivered, from Aryeo
};

// Aryeo lookups are the slow part — cap how many delivered listings one page
// load will fetch, newest shoots first.
const ARYEO_LOOKUP_CAP = 8;

export async function portalMonths(enrollmentId: string): Promise<PortalMonth[]> {
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId },
    orderBy: { monthKey: "desc" },
    take: 12,
    select: { id: true, monthKey: true, videosOwed: true, strategyCallStatus: true, strategyCallAt: true },
  });
  if (months.length === 0) return [];
  const monthIds = months.map((m) => m.id);

  const [scripts, projects] = await Promise.all([
    prisma.contentScript.findMany({
      where: { monthId: { in: monthIds }, status: { in: CLIENT_VISIBLE_SCRIPT } },
      orderBy: { createdAt: "asc" },
      select: { id: true, monthId: true, title: true, body: true },
    }),
    prisma.project.findMany({
      where: { contentMonthId: { in: monthIds }, status: { not: "CANCELLED" } },
      orderBy: { shootDate: "desc" },
      select: { id: true, contentMonthId: true, shootDate: true, status: true, aryeoListingId: true },
    }),
  ]);

  // Delivered videos from Aryeo — newest delivered sessions first, capped,
  // fetched 4 at a time. Best-effort: an Aryeo hiccup just means fewer videos
  // this load, never a broken page.
  const delivered = projects.filter((p) => p.status === "DELIVERED" && p.aryeoListingId).slice(0, ARYEO_LOOKUP_CAP);
  const videosByProject = new Map<string, PortalMonthVideo[]>();
  const { getListingMedia } = await import("@/lib/integrations/aryeo");
  for (let i = 0; i < delivered.length; i += 4) {
    await Promise.all(
      delivered.slice(i, i + 4).map(async (p) => {
        const media = await getListingMedia(p.aryeoListingId!).catch(() => null);
        if (!media?.videos?.length) return;
        videosByProject.set(
          p.id,
          media.videos
            .filter((v) => v.playback || v.download)
            .map((v) => ({ title: v.title, thumb: v.thumb, playback: v.playback, download: v.download })),
        );
      }),
    );
  }

  return months.map((m) => ({
    monthKey: m.monthKey,
    videosOwed: m.videosOwed,
    strategyCallStatus: m.strategyCallStatus,
    strategyCallAtISO: m.strategyCallAt ? m.strategyCallAt.toISOString() : null,
    sessions: projects
      .filter((p) => p.contentMonthId === m.id)
      .map((p) => ({ dateISO: p.shootDate ? p.shootDate.toISOString() : null, delivered: p.status === "DELIVERED" })),
    scripts: scripts.filter((s) => s.monthId === m.id).map((s) => ({ id: s.id, title: s.title, body: s.body })),
    videos: projects.filter((p) => p.contentMonthId === m.id).flatMap((p) => videosByProject.get(p.id) ?? []),
  }));
}

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
