import "server-only";
import { prisma } from "@/lib/prisma";
import { countDistinctSessions, replacesPendingMove, sessionShortfall, type BookedSessionCount, type CountedSession, type ProgramDb } from "@/lib/programMonths";
import { ownersForMany, pairKey, UNASSIGNED_OWNERS, type OwnerMap } from "@/lib/programOwners";
import { cutReleasedAt, isDeliveredProgramVideo } from "@/lib/contentVideos";
import { DELIVERED_STAMP, NOT_A_CUT } from "@/lib/reviewCuts";
import { fmtDay, journeySteps, type JourneyInput, type JourneyStep } from "@/lib/contentStatus";
import type { Entitlement } from "@/lib/cutEntitlement";
import type { MonthPlanning } from "@/lib/planningState";

// ---------------------------------------------------------------------------
// ONE MONTHLY-PROGRESS READER (completion audit CP-10, Sep 24 2026).
//
// "Jordan can see an apparently advanced monthly timeline even though the
// newer workflow has not established those steps." Four screens answered
// "where is this month?" with their own proxies:
//   · the client file counted non-cancelled PROJECTS as booked sessions and a
//     project whose shootDate had passed as filmed — a job shell booked a
//     session, and a date nobody confirmed filmed it;
//   · the card roster did the same, and multiplied a DELIVERED project's reel
//     quantity into "videos delivered";
//   · the default overview called any project CONFIRMED and one past date
//     COMPLETED, and never compared either with sessionsPerMonth;
//   · portal Home showed the first shoot date as "Booked", flipped it to
//     "Filmed" the day after, and hid "Book your filming session" on a Pro
//     month with one of its two sessions on the calendar.
// Pro is wrong in both directions under those proxies: its two sessions are
// two appointments on ONE project (sessionRequests), so a fully booked Pro
// month read "1/2", and two projects — one past, one future — read "filmed".
//
// Every one of those surfaces now reads THIS, and it composes the engines that
// already own each fact rather than restating them:
//   · sessions — programMonths.countDistinctSessions, unchanged (the same
//     count the portal's capacity and the reminder chaser use), then each
//     session classified: BOOKED, HELD_UNCONFIRMED, FILMED_CONFIRMED or
//     UNVERIFIED (a dated job with no appointment — Jordan: never invent a
//     date). "Filmed" needs evidence: the photographer's field "complete", an
//     APPLIED CP-09 filming report on that leg, the upload page submitted on a
//     one-session job, confirmed topics dated to that leg, or an editor's cut
//     from a one-session job. A passed date is not evidence.
//   · scripts — the client's verdict by scriptDecisions.currentScriptDecision,
//     the same rule scriptDecisionsFor applies, read for every month at once.
//   · production — per VIDEO, from the library: produced, internally
//     approved, released for review, client approved, DOWNLOADABLE (CP-01's
//     entitlementsForVideos, called, never restated) and delivered
//     (contentVideos.isDeliveredProgramVideo).
// Anything the facts cannot answer is an UNKNOWN with an owner and an action —
// never a confident zero.
//
// Batched: a fixed set of queries for any number of (enrollment, month) pairs,
// so the roster never goes N+1.
// ---------------------------------------------------------------------------

export type MonthPair = { enrollmentId: string; monthId: string | null; monthKey: string };

/** The key every progress map is indexed by. monthKey is part of it because a
 *  pair with no workspace (monthId null) still names the month it is about. */
export const progressKey = (enrollmentId: string, monthId: string | null, monthKey: string) => `${enrollmentId}:${monthId ?? ""}:${monthKey}`;

export type SessionFactState = "BOOKED" | "HELD_UNCONFIRMED" | "FILMED_CONFIRMED" | "UNVERIFIED";

export type SessionFact = {
  key: string;
  source: CountedSession["source"];
  state: SessionFactState;
  projectId: string | null;
  projectTitle: string | null;
  appointmentId: string | null;
  startsAtISO: string | null;
  /** the appointment's END where there is one (§9's clock anchor) */
  atISO: string | null;
  /** its date has passed (the counter's six-hour grace) — NOT a claim it was filmed */
  past: boolean;
  /** staff-only: who was on the camera, when anybody is recorded */
  photographer: string | null;
  /** what proves it was filmed, for FILMED_CONFIRMED */
  evidence: string | null;
};

export type MonthUnknown = {
  field: "session" | "filming" | "delivered" | "downloadable";
  /** a short handle for a card line ("Oct 15 filming not confirmed") */
  short: string;
  why: string;
  ownerDuty: "SCHEDULING" | "DELIVERY" | "PHOTOGRAPHER" | "SYSTEM";
  owner: string;
  action: string;
  href: string;
};

export type VideoStage =
  | "PLANNED" | "FILMED" | "PRODUCED" | "INTERNALLY_APPROVED" | "RELEASED" | "CHANGES_REQUESTED" | "CLIENT_APPROVED" | "DOWNLOADABLE" | "DELIVERED";

export type ProgressVideo = {
  videoId: string;
  title: string;
  topicId: string | null;
  kind: string;
  countsTowardAllowance: boolean;
  stage: VideoStage;
  produced: boolean;
  internallyApproved: boolean;
  released: boolean;
  releasedInferred: boolean;
  changesRequested: boolean;
  clientApproved: boolean;
  /** null = the release rule could not be read for it */
  downloadable: boolean | null;
  delivered: boolean;
  /** released to the client and waiting on THEIR approval (CP-01's AWAITING_DECISION) */
  awaitingClient: boolean;
};

export type MonthNextAction = { text: string; owner: string; ownerDuty: string; href: string; cta: string; blocked: "us" | "client" | "nobody" };

export type MonthProgress = {
  enrollmentId: string;
  clientId: string;
  pkg: string;
  enrollmentStatus: string;
  /** Someone on the client's side can approve in the portal: a live OWNER seat
   *  on this ACTIVE, un-revoked program. Without one, a released cut reaches
   *  the client only when the office sends it (readyToSend's same test). */
  portalApprover: boolean;
  monthId: string | null;
  monthKey: string;
  monthStatus: string;
  historical: boolean;
  /** historical / skipped / imported: record-keeping, never warnings */
  muted: boolean;
  videosOwed: number;
  owners: OwnerMap;
  /** `required`/`mode`: the month's EFFECTIVE call mode (programMonths.effectiveCallMode via the planning reader) — the first call is required, later ones optional (§3). */
  call: { status: string; atISO: string | null; required: boolean; mode: string | null };
  /** selected = the month's allowance that is chosen, overflow = the extras beyond it (R01: the planning reader's allowance, one count). */
  topics: { selected: number; overflow: number; needed: number; clientSupplies: boolean };
  /** R01: the month through the one planning reader — route, call, each topic's step, the headline. Null when there is no month row or it could not be read. */
  planning: MonthPlanning | null;
  scripts: {
    total: number; drafting: number; needsJordan: number; ready: number;
    releasedAwaitingClient: number; clientApproved: number; changesRequested: number; openSuggestions: number;
  };
  sessions: {
    required: number;
    /** APPOINTMENT and CONFIRMED_REQUEST sessions, plus any session somebody confirmed was filmed */
    confirmed: number;
    /** dated jobs with no appointment behind them */
    unverified: number;
    /** client asks the office has not answered that do not already resolve to a counted session */
    pendingRequests: number;
    /** sessions whose date has passed (the counter's reading) */
    held: number;
    heldUnconfirmed: number;
    filmedConfirmed: number;
    booked: number;
    /** sessionShortfall over the SAME count the capacity check and the reminder chaser use */
    missing: number;
    fullyScheduled: boolean;
    cancelledOnly: boolean;
    nextAtISO: string | null;
    count: BookedSessionCount;
    list: SessionFact[];
  };
  filming: { topicsConfirmed: number; extras: number; reportsPending: number; reportsFailed: number };
  production: {
    /** false when the pipeline delivered more than the library knows — the delivered number is then understated, and says so */
    known: boolean;
    libraryRows: number;
    counted: number;
    produced: number;
    internallyApproved: number;
    released: number;
    /** the legacy portal rule: an internally approved cut read as released at its QC time. Kept apart and labelled. */
    releasedInferred: number;
    changesRequested: number;
    clientApproved: number;
    /** released and waiting on the client's own approval — the pipeline may call these delivered, the library rightly does not */
    awaitingClient: number;
    downloadable: number;
    downloadableKnown: boolean;
    delivered: number;
    pipelineDelivered: number;
    libraryAhead: boolean;
    /** evidence-based: a confirmation, a cut, or a delivery — never a derived filmedAt */
    filmed: number;
    editing: number;
    clientReview: number;
    carriedIn: number;
    /** cuts waiting in the Review Room (staff's queue) */
    awaitingInternalReview: number;
    videos: ProgressVideo[];
  };
  unknowns: MonthUnknown[];
  nextAction: MonthNextAction | null;
};

// ---------------------------------------------------------------------------
// SESSIONS
// ---------------------------------------------------------------------------

type SessionProjectRow = {
  id: string; clientId: string; contentMonthId: string | null; title: string; status: string; shootDate: Date | null; addressLine: string | null;
  debriefSubmittedAt: Date | null; deliveredAt: Date | null; photographer: { name: string } | null;
  deliverables: { type: string; quantity: number | null }[];
};
type SessionApptRow = { aryeoId: string; projectId: string; startAt: Date | null; endAt: Date | null; status: string | null; completedAt: Date | null; assignedTo: { name: string } | null };
type SessionRequestRow = { id: string; monthId: string; status: string; projectId: string | null; aryeoAppointmentId: string | null; slotStart: Date | null; supersedesId: string | null };

type SessionRows = { projects: SessionProjectRow[]; appointments: SessionApptRow[]; requests: SessionRequestRow[] };

/** The rows the session counter reads, for many months, scoped to each month's OWN client (monthSessionCount's rule). */
async function loadSessionRows(db: ProgramDb, months: { id: string; clientId: string }[]): Promise<SessionRows> {
  if (months.length === 0) return { projects: [], appointments: [], requests: [] };
  const clientOf = new Map(months.map((m) => [m.id, m.clientId]));
  const [projectsRaw, requests] = await Promise.all([
    db.project.findMany({
      where: { contentMonthId: { in: months.map((m) => m.id) }, status: { not: "CANCELLED" } },
      select: {
        id: true, clientId: true, contentMonthId: true, title: true, status: true, shootDate: true, addressLine: true, debriefSubmittedAt: true, deliveredAt: true,
        photographer: { select: { name: true } },
        deliverables: { where: { removedFromOrderAt: null }, select: { type: true, quantity: true } },
      },
    }),
    db.programSessionRequest.findMany({
      where: { monthId: { in: months.map((m) => m.id) } },
      select: { id: true, monthId: true, status: true, projectId: true, aryeoAppointmentId: true, slotStart: true, supersedesId: true },
    }),
  ]);
  // A job mis-attached to another client's month is hidden by the portal and
  // must not fill this client's allowance (monthSessionCount, sessionCapacity).
  const projects = projectsRaw.filter((p) => p.contentMonthId && clientOf.get(p.contentMonthId) === p.clientId);
  const appointments = projects.length
    ? await db.appointment.findMany({
        where: { projectId: { in: projects.map((p) => p.id) } },
        select: { aryeoId: true, projectId: true, startAt: true, endAt: true, status: true, completedAt: true, assignedTo: { select: { name: true } } },
      })
    : [];
  return { projects, appointments, requests };
}

/** countDistinctSessions with EXACTLY monthSessionCount's inputs — the capacity check and this reader must never count differently. */
function countFor(monthId: string, rows: SessionRows, now: Date): BookedSessionCount {
  const projects = rows.projects.filter((p) => p.contentMonthId === monthId);
  const ids = new Set(projects.map((p) => p.id));
  return countDistinctSessions({
    now,
    appointments: rows.appointments.filter((a) => ids.has(a.projectId)).map((a) => ({ appointmentId: a.aryeoId, projectId: a.projectId, startAt: a.startAt, endAt: a.endAt, cancelled: a.status === "CANCELED" })),
    projects: projects.map((p) => ({ projectId: p.id, shootDate: p.shootDate, addressLine: p.addressLine })),
    confirmedRequests: rows.requests.filter((r) => r.monthId === monthId && r.status === "CONFIRMED").map((r) => ({ requestId: r.id, projectId: r.projectId, appointmentId: r.aryeoAppointmentId, slotStart: r.slotStart })),
  });
}

/**
 * The month's BookedSessionCount through this reader — what the reminder
 * evaluator counts sessions with, so the chaser and every screen share one
 * count. Takes a transaction client like monthSessionCount does.
 */
export async function monthBookedSessions(monthId: string, clientId: string, now: Date, db: ProgramDb = prisma): Promise<BookedSessionCount> {
  return countFor(monthId, await loadSessionRows(db, [{ id: monthId, clientId }]), now);
}

type EvidenceRows = {
  reports: { projectId: string; appointmentId: string | null; state: string; createdAt: Date }[];
  cuts: { projectId: string; createdAt: Date }[];
  confirmedVideos: { projectId: string | null; filmedAt: Date | null }[];
};

/** Classify each counted session. Pure over the rows handed to it. */
function classifySessions(count: BookedSessionCount, rows: SessionRows, ev: EvidenceRows): SessionFact[] {
  const perProject = new Map<string, number>();
  for (const s of count.sessions) if (s.projectId) perProject.set(s.projectId, (perProject.get(s.projectId) ?? 0) + 1);
  const apptOf = new Map(rows.appointments.map((a) => [a.aryeoId, a]));
  const projectOf = new Map(rows.projects.map((p) => [p.id, p]));
  return count.sessions.map((s): SessionFact => {
    const appt = s.appointmentId ? apptOf.get(s.appointmentId) ?? null : null;
    const project = s.projectId ? projectOf.get(s.projectId) ?? null : null;
    const single = !!s.projectId && perProject.get(s.projectId) === 1;
    const at = s.at?.getTime() ?? null;
    const evidence =
      appt?.completedAt ? "the photographer marked the shoot complete"
      : s.appointmentId && ev.reports.some((r) => r.state === "APPLIED" && r.appointmentId === s.appointmentId) ? "the photographer's filming report"
      : single && ev.reports.some((r) => r.state === "APPLIED" && r.projectId === s.projectId && !r.appointmentId) ? "the photographer's filming report"
      : single && project?.debriefSubmittedAt ? "the upload page was submitted"
      : !!s.projectId && ev.confirmedVideos.some((v) => v.projectId === s.projectId && (single || (at !== null && v.filmedAt?.getTime() === at))) ? "filmed topics were confirmed"
      // An edit cut from this job's footage is proof the footage exists; on a
      // two-session job it cannot say WHICH session, so it proves neither.
      : single && s.startsAt && ev.cuts.some((c) => c.projectId === s.projectId && c.createdAt >= s.startsAt!) ? "an edit was cut from this session's footage"
      : null;
    const state: SessionFactState = evidence ? "FILMED_CONFIRMED" : s.source === "PROJECT_SHOOT_DATE" ? "UNVERIFIED" : s.filmed ? "HELD_UNCONFIRMED" : "BOOKED";
    return {
      key: s.key, source: s.source, state,
      projectId: s.projectId, projectTitle: project?.title ?? null, appointmentId: s.appointmentId,
      startsAtISO: s.startsAt?.toISOString() ?? null, atISO: s.at?.toISOString() ?? null, past: s.filmed,
      photographer: appt?.assignedTo?.name ?? project?.photographer?.name ?? null,
      evidence,
    };
  });
}

// ---------------------------------------------------------------------------
// THE READER
// ---------------------------------------------------------------------------

const TOPIC_ON_MONTH = ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"];
const READY_SCRIPT_STATUS = new Set(["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM"]);

const videoUnits = (p: { deliverables: { type: string; quantity: number | null }[] }) =>
  p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);

/**
 * Progress for many (enrollment, month) pairs in a fixed set of queries.
 * `owners: false` skips the duty-owner read (the portal needs no names).
 */
export async function monthProgressMany(pairsIn: MonthPair[], opts: { now?: Date; owners?: boolean } = {}): Promise<Map<string, MonthProgress>> {
  const now = opts.now ?? new Date();
  const out = new Map<string, MonthProgress>();
  const seen = new Set<string>();
  const pairs = pairsIn.filter((p) => {
    const k = progressKey(p.enrollmentId, p.monthId, p.monthKey);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (pairs.length === 0) return out;

  const enrollmentIds = [...new Set(pairs.map((p) => p.enrollmentId))];
  const monthIds = [...new Set(pairs.map((p) => p.monthId).filter((x): x is string => !!x))];
  const monthKeys = [...new Set(pairs.map((p) => p.monthKey))];
  const [enrollments, monthRows, ownerSeats] = await Promise.all([
    prisma.contentEnrollment.findMany({
      where: { id: { in: enrollmentIds } },
      select: { id: true, clientId: true, package: true, status: true, accessRevokedAt: true, videosPerMonth: true, sessionsPerMonth: true, strategyCallRequired: true, clientSuppliesTopics: true },
    }),
    monthIds.length
      ? prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true, videosOwed: true, strategyCallStatus: true, strategyCallAt: true, historical: true, status: true } })
      : Promise.resolve([]),
    prisma.clientMembership.findMany({ where: { enrollmentId: { in: enrollmentIds }, role: "OWNER", revokedAt: null }, select: { enrollmentId: true } }),
  ]);
  const hasOwnerSeat = new Set(ownerSeats.map((m) => m.enrollmentId));
  const enrollmentOf = new Map(enrollments.map((e) => [e.id, e]));
  // A month is read only for the enrollment it belongs to, and scoped to that
  // enrollment's client — never another program's workspace behind a stale id.
  const monthOf = new Map(monthRows.filter((m) => enrollmentOf.get(m.enrollmentId)?.clientId === m.clientId).map((m) => [m.id, m]));
  const liveMonths = [...monthOf.values()];

  const [sessionRows, videos, selections, monthTopics, scripts, ownerMaps] = await Promise.all([
    loadSessionRows(prisma, liveMonths.map((m) => ({ id: m.id, clientId: m.clientId }))),
    // The LIBRARY, keyed exactly as programCountsByMonth and the overview key
    // it (enrollment × obligation month, ARCHIVED excluded), so the portal's
    // meter and Jordan's rows count the same rows.
    prisma.contentVideo.findMany({
      where: { enrollmentId: { in: enrollmentIds }, monthKey: { in: monthKeys }, status: { not: "ARCHIVED" } },
      select: {
        id: true, enrollmentId: true, clientId: true, monthId: true, monthKey: true, title: true, topicId: true, kind: true, countsTowardAllowance: true, status: true,
        projectId: true, filmedAt: true, filmedConfirmedAt: true, deliveredAt: true, currentSubmissionId: true, approvedSubmissionId: true, finalSubmissionId: true,
      },
    }),
    monthIds.length ? prisma.contentTopicSelection.findMany({ where: { monthId: { in: monthIds }, status: { in: ["SELECTED", "CARRIED", "RECONCILED"] } }, select: { monthId: true, topicId: true, overflow: true } }) : Promise.resolve([]),
    // ContentTopic.status still holds most selections (the overview's note):
    // counted as a UNION with the selection rows, keyed by topic id.
    monthIds.length ? prisma.contentTopic.findMany({ where: { monthId: { in: monthIds }, status: { in: TOPIC_ON_MONTH } }, select: { id: true, monthId: true } }) : Promise.resolve([]),
    monthIds.length
      ? prisma.contentScript.findMany({ where: { monthId: { in: monthIds } }, select: { id: true, monthId: true, enrollmentId: true, status: true, historical: true, currentVersionId: true, approvedVersionId: true, sharedVersionId: true, releaseState: true } })
      : Promise.resolve([]),
    opts.owners === false ? Promise.resolve(new Map<string, OwnerMap>()) : ownersForMany(pairs.map((p) => ({ enrollmentId: p.enrollmentId, monthId: p.monthId }))),
  ]);
  // R01: the allowance and each topic's step, through the ONE planning reader
  // (a fixed set of queries for every month at once). Unreadable → the
  // union below, with the extras no longer counted twice.
  const plannedMonths = monthIds.length
    ? await import("@/lib/planningFacts").then((m) => m.planningFactsForMonths(monthIds, { now })).catch(() => null)
    : null;

  const projectIds = sessionRows.projects.map((p) => p.id);
  const pointerIds = [...new Set(videos.map((v) => v.currentSubmissionId).filter((x): x is string => !!x))];
  const scriptIds = scripts.map((s) => s.id);
  const versionIds = [...new Set(scripts.map((s) => s.currentVersionId).filter((x): x is string => !!x))];
  const sharedIds = [...new Set(scripts.filter((s) => s.releaseState === "released").map((s) => s.sharedVersionId).filter((x): x is string => !!x))];
  const { currentScriptDecision } = await import("@/lib/scriptDecisions");
  const { entitlementsForVideos } = await import("@/lib/cutEntitlement");

  const [reports, subs, versions, ledger, suggestions, entitlements] = await Promise.all([
    projectIds.length
      ? prisma.contentFilmingReport.findMany({ where: { projectId: { in: projectIds } }, orderBy: { createdAt: "asc" }, select: { projectId: true, appointmentId: true, state: true, createdAt: true } })
      : Promise.resolve([]),
    projectIds.length || pointerIds.length
      ? prisma.reviewSubmission.findMany({
          where: { status: { notIn: [...NOT_A_CUT] }, OR: [...(projectIds.length ? [{ projectId: { in: projectIds } }] : []), ...(pointerIds.length ? [{ id: { in: pointerIds } }] : [])] },
          select: { id: true, projectId: true, status: true, createdAt: true, decidedBy: true, decidedAt: true, clientReleasedAt: true, clientRequestedAt: true },
        })
      : Promise.resolve([]),
    versionIds.length ? prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, status: true } }) : Promise.resolve([]),
    sharedIds.length
      ? prisma.contentScriptRelease.findMany({
          where: { scriptId: { in: scriptIds }, scriptVersionId: { in: sharedIds }, action: { in: ["CLIENT_APPROVED", "CLIENT_CHANGES"] } },
          select: { id: true, scriptId: true, action: true, createdAt: true, scriptVersionId: true, actorEmail: true },
        })
      : Promise.resolve([]),
    scriptIds.length ? prisma.scriptSuggestion.groupBy({ by: ["scriptId"], where: { status: "OPEN", scriptId: { in: scriptIds } }, _count: true }) : Promise.resolve([]),
    // CP-01's release rule, batched — DOWNLOADABLE is its answer, not ours.
    // A failure here is an UNKNOWN on the month, not a zero.
    entitlementsForVideos(videos).then((m) => m as Map<string, Entitlement>, () => null),
  ]);
  const subOf = new Map(subs.map((s) => [s.id, s]));
  const versionOf = new Map(versions.map((v) => [v.id, v]));
  const suggestionsOf = new Map(suggestions.map((s) => [s.scriptId, s._count]));

  for (const pair of pairs) {
    const e = enrollmentOf.get(pair.enrollmentId);
    if (!e) continue;
    const m = pair.monthId ? monthOf.get(pair.monthId) ?? null : null;
    if (pair.monthId && (!m || m.enrollmentId !== e.id)) continue;
    const mid = m?.id ?? null;
    // NEVER another row's owners: a wrong name beside a client reads as a fact.
    const owners = ownerMaps.get(pairKey(e.id, mid)) ?? UNASSIGNED_OWNERS;
    const muted = !!m && (m.historical || m.status === "SKIPPED" || m.status === "IMPORTED");
    // A month that does not exist because the client is paused/ended owes
    // nothing (the overview's rule, kept so the two cannot disagree).
    const videosOwed = m?.videosOwed ?? (e.status === "ACTIVE" ? e.videosPerMonth : 0);

    // ---- topics ------------------------------------------------------------
    // The planning reader's allowance: chosen = IN, overflow = EXTRA. The old
    // reading took the frozen row flag for overflow and then unioned every
    // topic pointing at the month back into "selected" — contentTopics sets
    // that pointer on an extra too — so each extra was counted twice.
    const planning = mid ? plannedMonths?.get(mid)?.planning ?? null : null;
    const selected = new Set<string>();
    let overflow = 0;
    if (planning) {
      for (const t of planning.topics) if (t.inAllowance) selected.add(t.topicId);
      overflow = planning.extras;
    } else {
      const extras = new Set<string>();
      for (const s of selections) if (s.monthId === mid) { if (s.overflow) { overflow++; extras.add(s.topicId); } else selected.add(s.topicId); }
      for (const t of monthTopics) if (t.monthId === mid && !extras.has(t.id)) selected.add(t.id);
    }

    // ---- scripts -----------------------------------------------------------
    const sc = { total: 0, drafting: 0, needsJordan: 0, ready: 0, releasedAwaitingClient: 0, clientApproved: 0, changesRequested: 0, openSuggestions: 0 };
    for (const s of scripts) {
      if (s.monthId !== mid || !mid) continue;
      sc.openSuggestions += suggestionsOf.get(s.id) ?? 0;
      if (s.historical) continue;
      sc.total++;
      // The CURRENT version's status: the row's own `status` is the legacy
      // mirror and goes stale the moment an editor saves a new draft.
      const st = (s.currentVersionId ? versionOf.get(s.currentVersionId)?.status : null) ?? s.status;
      const awaiting = st === "DRAFT" || st === "INTERNAL_REVIEW";
      if (st === "DRAFT") sc.drafting++;
      else if (st === "INTERNAL_REVIEW") sc.needsJordan++;
      if (!awaiting && (!!s.approvedVersionId || READY_SCRIPT_STATUS.has(s.status) || st === "APPROVED" || st === "SHARED")) sc.ready++;
      // The client's standing, by the ONE rule (scriptDecisions R1): newest
      // ledger row about the version that is shared right now; a script pulled
      // back off the portal has no current client decision.
      if (s.releaseState === "released" && s.sharedVersionId) {
        const d = currentScriptDecision(s.sharedVersionId, ledger.filter((r) => r.scriptId === s.id));
        if (d.decision === "APPROVED") sc.clientApproved++;
        else if (d.decision === "CHANGES_REQUESTED") sc.changesRequested++;
        else sc.releasedAwaitingClient++;
      }
    }

    // ---- sessions ----------------------------------------------------------
    const required = Math.max(1, e.sessionsPerMonth || 1);
    const count: BookedSessionCount = mid ? countFor(mid, sessionRows, now) : { sessions: [], booked: 0, filmed: 0, accountedFor: 0, duplicatesFolded: 0 };
    const myProjects = sessionRows.projects.filter((p) => mid && p.contentMonthId === mid);
    const myProjectIds = new Set(myProjects.map((p) => p.id));
    const myVideos = videos.filter((v) => v.enrollmentId === e.id && v.monthKey === pair.monthKey);
    const facts = classifySessions(count, sessionRows, {
      reports: reports.filter((r) => myProjectIds.has(r.projectId)),
      cuts: subs.filter((s) => myProjectIds.has(s.projectId)),
      confirmedVideos: myVideos.filter((v) => !!v.filmedConfirmedAt),
    });
    const shortfall = sessionShortfall(required, count);
    const countedKeys = new Set(count.sessions.map((x) => x.key));
    const myRequests = sessionRows.requests.filter((r) => r.monthId === mid);
    // The same "not already a counted session" filter sessionCapacity applies.
    const pendingRequests = myRequests.filter((r) =>
      (r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED") &&
      !replacesPendingMove(r, myRequests) &&
      !(r.aryeoAppointmentId && countedKeys.has(`appt:${r.aryeoAppointmentId}`)) &&
      !(r.projectId && countedKeys.has(`project:${r.projectId}`))).length;
    const confirmed = facts.filter((f) => f.source !== "PROJECT_SHOOT_DATE" || f.state === "FILMED_CONFIRMED").length;
    const filmedConfirmed = facts.filter((f) => f.state === "FILMED_CONFIRMED").length;
    const nextBooked = facts.filter((f) => !f.past && f.startsAtISO).sort((a, b) => a.startsAtISO!.localeCompare(b.startsAtISO!))[0] ?? null;
    const sessions: MonthProgress["sessions"] = {
      required, confirmed,
      unverified: facts.filter((f) => f.state === "UNVERIFIED").length,
      pendingRequests,
      held: count.filmed,
      heldUnconfirmed: facts.filter((f) => f.state === "HELD_UNCONFIRMED").length,
      filmedConfirmed,
      booked: facts.filter((f) => f.state === "BOOKED").length,
      missing: shortfall.missing,
      fullyScheduled: confirmed >= required,
      cancelledOnly: myRequests.length > 0 && count.accountedFor === 0 && myRequests.every((r) => ["CANCELLED", "DECLINED", "EXPIRED"].includes(r.status)),
      nextAtISO: nextBooked?.startsAtISO ?? null,
      count,
      list: facts,
    };

    // ---- filming (CP-09) ---------------------------------------------------
    const latestReport = new Map<string, string>();
    for (const r of reports) if (myProjectIds.has(r.projectId)) latestReport.set(r.projectId, r.state);
    const filming = {
      topicsConfirmed: myVideos.filter((v) => v.filmedConfirmedAt && v.countsTowardAllowance).length,
      extras: myVideos.filter((v) => v.filmedConfirmedAt && !v.countsTowardAllowance).length,
      reportsPending: [...latestReport.values()].filter((s) => s === "PENDING" || s === "APPLYING").length,
      reportsFailed: [...latestReport.values()].filter((s) => s === "FAILED" || s === "NEEDS_REVIEW").length,
    };

    // ---- production, per video ---------------------------------------------
    const pvideos: ProgressVideo[] = myVideos.map((v) => {
      const ent = entitlements ? entitlements.get(v.id) ?? null : null;
      const cut = v.currentSubmissionId ? subOf.get(v.currentSubmissionId) ?? null : null;
      const delivered = isDeliveredProgramVideo(v);
      const produced = !!(v.currentSubmissionId || v.approvedSubmissionId || v.finalSubmissionId) || delivered;
      const released = !!cut?.clientReleasedAt;
      const releasedInferred = !!cut && !cut.clientReleasedAt && !!cutReleasedAt(cut);
      const internallyApproved = !!cut && cut.status === "APPROVED" && cut.decidedBy !== DELIVERED_STAMP && !cut.clientReleasedAt;
      const clientApproved = ent?.current?.state === "APPROVED";
      const changesRequested = ent?.current?.state === "CHANGES_REQUESTED";
      const awaitingClient = !!ent && !ent.file && ent.blockedBy === "AWAITING_DECISION";
      const downloadable = entitlements ? !!ent?.file : null;
      const filmed = !!v.filmedConfirmedAt || produced;
      const stage: VideoStage =
        changesRequested ? "CHANGES_REQUESTED"
        : delivered ? "DELIVERED"
        : downloadable ? "DOWNLOADABLE"
        : clientApproved ? "CLIENT_APPROVED"
        : released ? "RELEASED"
        : internallyApproved ? "INTERNALLY_APPROVED"
        : produced ? "PRODUCED"
        : filmed ? "FILMED"
        : "PLANNED";
      return {
        videoId: v.id, title: v.title ?? "Video", topicId: v.topicId, kind: v.kind, countsTowardAllowance: v.countsTowardAllowance, stage,
        produced, internallyApproved, released, releasedInferred, changesRequested, clientApproved, downloadable, delivered, awaitingClient,
      };
    });
    const counted = pvideos.filter((v) => v.countsTowardAllowance);
    const countedRows = myVideos.filter((v) => v.countsTowardAllowance);
    const delivered = counted.filter((v) => v.delivered).length;
    // The PIPELINE reading, beside the library one: never added to it, only
    // there so a library that has not caught up reads "unknown", not "0".
    const pipelineDelivered = myProjects.filter((p) => p.status === "DELIVERED").reduce((n, p) => n + Math.max(1, videoUnits(p)), 0);
    // Since CP-01 a project can be DELIVERED (Aryeo, the status engine, a
    // hand move) while its released cuts wait on the client's approval — or
    // are back with the editor at their request. Those explain the gap; they
    // are not a library behind, and "Sync now" could never close it.
    const awaitingClient = counted.filter((v) => v.awaitingClient).length;
    const changesRequested = counted.filter((v) => v.changesRequested).length;
    const production: MonthProgress["production"] = {
      known: !(pipelineDelivered > delivered + awaitingClient + changesRequested),
      libraryRows: myVideos.length,
      counted: counted.length,
      produced: counted.filter((v) => v.produced).length,
      internallyApproved: counted.filter((v) => v.internallyApproved).length,
      released: counted.filter((v) => v.released).length,
      releasedInferred: counted.filter((v) => v.releasedInferred).length,
      changesRequested,
      clientApproved: counted.filter((v) => v.clientApproved).length,
      awaitingClient,
      downloadable: counted.filter((v) => v.downloadable).length,
      downloadableKnown: !!entitlements,
      delivered,
      pipelineDelivered,
      libraryAhead: pipelineDelivered > 0 && delivered > pipelineDelivered && delivered > videosOwed,
      filmed: counted.filter((v) => v.stage !== "PLANNED").length,
      editing: countedRows.filter((v) => v.status === "EDITING").length,
      clientReview: countedRows.filter((v) => v.status === "CLIENT_REVIEW").length,
      carriedIn: myVideos.filter((v) => v.kind === "CARRYOVER").length,
      awaitingInternalReview: subs.filter((s) => myProjectIds.has(s.projectId) && s.status === "PENDING").length,
      videos: pvideos,
    };

    // ---- unknowns: each with an owner and an action ------------------------
    const unknowns: MonthUnknown[] = [];
    if (!muted) {
      for (const f of facts) {
        const when = f.startsAtISO ? fmtDay(f.startsAtISO) : "undated";
        if (f.state === "UNVERIFIED") {
          unknowns.push({
            field: "session", short: `${when} session unverified`,
            why: `${f.projectTitle ? `"${f.projectTitle}"` : "a job"} is dated ${when} but has no Aryeo appointment behind it`,
            ownerDuty: "SCHEDULING", owner: owners.SCHEDULING.label, action: "confirm the appointment in Aryeo", href: f.projectId ? `/edit/${f.projectId}` : "#sessions",
          });
        }
        if ((f.state === "UNVERIFIED" && f.past) || f.state === "HELD_UNCONFIRMED") {
          unknowns.push({
            field: "filming", short: `${when} filming not confirmed`,
            why: `the ${when} session's date has passed and nobody has confirmed it was filmed`,
            ownerDuty: f.photographer ? "PHOTOGRAPHER" : "SCHEDULING", owner: f.photographer ?? owners.SCHEDULING.label,
            action: "submit the upload page", href: f.projectId ? `/upload/${f.projectId}` : "#sessions",
          });
        }
      }
      if (filming.reportsFailed > 0) {
        const pid = [...latestReport.entries()].find(([, s]) => s === "FAILED" || s === "NEEDS_REVIEW")?.[0] ?? null;
        unknowns.push({
          field: "filming", short: "filming report not applied",
          why: "the photographer's filmed-topics report has not landed on the month yet",
          ownerDuty: "SCHEDULING", owner: owners.SCHEDULING.label, action: "open the filming-report task", href: pid ? `/edit/${pid}` : "#sessions",
        });
      }
      if (!production.known) {
        unknowns.push({
          field: "delivered", short: "delivered count unknown",
          why: `the pipeline shows ${pipelineDelivered} delivered but the video library holds ${delivered}`,
          ownerDuty: "SYSTEM", owner: "the hub", action: "Sync now", href: "/content",
        });
      }
      if (!production.downloadableKnown && myVideos.length > 0) {
        unknowns.push({
          field: "downloadable", short: "download state unknown",
          why: "the release rule could not be read for this month's videos",
          ownerDuty: "SYSTEM", owner: "the hub", action: "reload; if it persists, check the monitoring page", href: "/content/monitoring",
        });
      }
    }

    const progress: MonthProgress = {
      enrollmentId: e.id, clientId: e.clientId, pkg: e.package, enrollmentStatus: e.status,
      portalApprover: e.status === "ACTIVE" && !e.accessRevokedAt && hasOwnerSeat.has(e.id),
      monthId: mid, monthKey: pair.monthKey, monthStatus: m?.status ?? "NONE", historical: !!m?.historical, muted, videosOwed,
      owners,
      call: {
        status: m?.strategyCallStatus ?? (e.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED"), atISO: m?.strategyCallAt?.toISOString() ?? null,
        required: mid && plannedMonths?.get(mid) ? plannedMonths.get(mid)!.callMode === "REQUIRED" : e.strategyCallRequired,
        mode: mid ? plannedMonths?.get(mid)?.callMode ?? null : null,
      },
      topics: { selected: selected.size, overflow, needed: Math.max(0, videosOwed - selected.size), clientSupplies: e.clientSuppliesTopics },
      planning,
      scripts: sc,
      sessions, filming, production, unknowns,
      nextAction: null,
    };
    progress.nextAction = nextActionFor(progress);
    out.set(progressKey(e.id, mid, pair.monthKey), progress);
  }
  return out;
}

/** One month. */
export async function monthProgress(enrollmentId: string, monthId: string, opts: { now?: Date } = {}): Promise<MonthProgress | null> {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true, monthKey: true } });
  if (!month || month.enrollmentId !== enrollmentId) return null;
  const map = await monthProgressMany([{ enrollmentId, monthId, monthKey: month.monthKey }], opts);
  return map.get(progressKey(enrollmentId, monthId, month.monthKey)) ?? null;
}

// ---------------------------------------------------------------------------
// THE NEXT STEP — the client file's ladder, moved here from its page so the
// words and the numbers come from one read. First unfinished stage speaks,
// with the duty owner who holds it.
// ---------------------------------------------------------------------------

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function nextActionFor(p: MonthProgress): MonthNextAction | null {
  const o = p.owners;
  const owedRaw = p.videosOwed;
  const owed = Math.max(owedRaw, 1);
  const deliveredDone = owedRaw > 0 && p.production.delivered >= owedRaw;
  if (p.muted || deliveredDone || !p.monthId) return null;
  const monthShort = new Date(Date.UTC(Number(p.monthKey.slice(0, 4)), Number(p.monthKey.slice(5, 7)) - 1, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const callDone = !p.call.required || ["COMPLETED", "SKIPPED", "NOT_REQUIRED"].includes(p.call.status);
  const topicsDone = p.topics.clientSupplies || p.topics.selected >= owed;
  const awaiting = p.scripts.drafting + p.scripts.needsJordan;
  const scriptsDone = p.scripts.ready >= owed && awaiting === 0;
  const s = p.sessions;
  const filmedDone = s.filmedConfirmed >= s.required;

  if (!callDone) {
    return p.call.status === "SCHEDULED"
      ? { text: `Strategy call is booked${p.call.atISO ? ` for ${fmtDay(p.call.atISO)}` : ""} — paste the transcript after`, cta: "Open the call", href: "#call", owner: o.STRATEGY.label, ownerDuty: "strategy", blocked: "nobody" }
      : { text: "The strategy call isn't booked yet", cta: "Handle the call", href: "#call", owner: o.SCHEDULING.label, ownerDuty: "scheduling", blocked: "client" };
  }
  // §6.4: a month that may be planned either way and has not been is the
  // CLIENT's next step (choose here or book a call), not ours.
  if (p.planning?.route === "UNDECIDED" && p.call.status === "NOT_SCHEDULED" && (p.planning.counts.CHOSEN > 0 || !topicsDone)) {
    return { text: `They haven't chosen how to plan ${monthShort} — topics in the portal, or a call`, cta: "See the month", href: "#call", owner: o.SCHEDULING.label, ownerDuty: "scheduling", blocked: "client" };
  }
  if (!topicsDone) return { text: `Pick ${monthShort}'s topics`, cta: "Pick topics", href: "#topics", owner: o.STRATEGY.label, ownerDuty: "strategy", blocked: "us" };
  // A call's proposals fill allowance slots (R01 counts them, last) but are not
  // the plan until a person keeps or drops them — that is the step, not "drafting".
  const proposed = p.planning?.counts.CONFIRMING ?? 0;
  if (proposed > 0) return { text: `${plural(proposed, "topic")} proposed on the call — keep or drop ${proposed === 1 ? "it" : "them"}`, cta: "Reconcile topics", href: "#topics", owner: o.STRATEGY.label, ownerDuty: "strategy", blocked: "us" };
  if (!scriptsDone) {
    return awaiting > 0
      ? { text: `${plural(awaiting, "script")} waiting on your OK`, cta: "Review the scripts", href: "#scripts", owner: o.SCRIPTS.label, ownerDuty: "script approval", blocked: "us" }
      : { text: `${p.scripts.ready} of ${owed} scripts ready — the rest are being drafted`, cta: "See the scripts", href: "#scripts", owner: o.SCRIPTS.label, ownerDuty: "scripts", blocked: "us" };
  }
  if (!filmedDone) {
    const unverified = s.list.find((f) => f.state === "UNVERIFIED");
    const held = s.list.find((f) => f.state === "HELD_UNCONFIRMED");
    if (s.count.accountedFor === 0) {
      return s.pendingRequests > 0
        ? { text: "They asked for a session — nothing confirmed", cta: "See the sessions", href: "#sessions", owner: o.SCHEDULING.label, ownerDuty: "scheduling", blocked: "us" }
        : { text: "No filming session on the calendar yet", cta: "See the sessions", href: "#sessions", owner: o.SCHEDULING.label, ownerDuty: "scheduling", blocked: "us" };
    }
    if (s.missing > 0) {
      return s.pendingRequests > 0
        ? { text: `${s.count.accountedFor} of ${plural(s.required, "session")} on the calendar — they asked for another, nothing confirmed`, cta: "See the sessions", href: "#sessions", owner: o.SCHEDULING.label, ownerDuty: "scheduling", blocked: "us" }
        : { text: `${s.count.accountedFor} of ${plural(s.required, "session")} on the calendar — ${s.missing} still to book`, cta: "See the sessions", href: "#sessions", owner: o.SCHEDULING.label, ownerDuty: "scheduling", blocked: "us" };
    }
    if (unverified) {
      return { text: `The ${unverified.startsAtISO ? fmtDay(unverified.startsAtISO) : "undated"} job has no Aryeo appointment — confirm it`, cta: "See the sessions", href: "#sessions", owner: o.SCHEDULING.label, ownerDuty: "scheduling", blocked: "us" };
    }
    if (nextFuture(s)) {
      const f = nextFuture(s)!;
      return { text: `Filming ${fmtDay(f.startsAtISO!)}${f.photographer ? ` with ${f.photographer}` : ""}`, cta: "See the session", href: "#sessions", owner: o.SCHEDULING.label, ownerDuty: "scheduling", blocked: "nobody" };
    }
    // Held, but nobody has said it was filmed. Once edits exist the footage
    // plainly does, so the ladder moves on to production and the unknown stays
    // listed for Kyle rather than blocking the month's next step.
    if (held && p.production.produced === 0) {
      return { text: `Filming on ${held.startsAtISO ? fmtDay(held.startsAtISO) : "the session"} is not confirmed — the upload page is outstanding`, cta: "See the sessions", href: "#sessions", owner: held.photographer ?? o.SCHEDULING.label, ownerDuty: held.photographer ? "photographer" : "scheduling", blocked: "us" };
    }
  }
  if (!p.production.known) {
    return { text: `Delivered count unknown — the pipeline shows ${p.production.pipelineDelivered}, the library ${p.production.delivered}`, cta: "Sync now", href: "/content", owner: "the hub", ownerDuty: "system", blocked: "us" };
  }
  if (p.production.awaitingInternalReview > 0) {
    return { text: `${plural(p.production.awaitingInternalReview, "video")} waiting in the Review Room`, cta: "Open the Review Room", href: "/review", owner: o.DELIVERY.label, ownerDuty: "delivery", blocked: "us" };
  }
  if (p.production.awaitingClient > 0 && !p.portalApprover) {
    // Nobody on their side can approve in the portal (it has not been issued to
    // them, or the program is paused/ended), so "waiting on the client" would
    // wait for ever. The cut stays on the Ready-to-send card until it is sent.
    return { text: `${plural(p.production.awaitingClient, "video")} approved and ready to send — this client has no portal access`, cta: "Open Ready to send", href: "/", owner: o.DELIVERY.label, ownerDuty: "delivery", blocked: "us" };
  }
  if (p.production.awaitingClient > 0) {
    return { text: `${plural(p.production.awaitingClient, "video")} released and awaiting the client's approval`, cta: "See the videos", href: `/content/${p.enrollmentId}?tab=content`, owner: o.DELIVERY.label, ownerDuty: "delivery", blocked: "client" };
  }
  return { text: `${p.production.delivered} of ${owedRaw} videos delivered — the rest are in editing`, cta: "See the sessions", href: "#sessions", owner: o.DELIVERY.label, ownerDuty: "delivery", blocked: "us" };
}

const nextFuture = (s: MonthProgress["sessions"]) => s.list.filter((f) => f.state === "BOOKED" && f.startsAtISO).sort((a, b) => a.startsAtISO!.localeCompare(b.startsAtISO!))[0] ?? null;

// ---------------------------------------------------------------------------
// VIEWS over one MonthProgress — pure, so the drill holds each screen to the
// same numbers the reader produced.
// ---------------------------------------------------------------------------

/** The Shoot / Delivered node's "unknown" sentence, when the facts cannot say. */
function journeyUnknown(p: MonthProgress): JourneyInput["unknown"] {
  const u: NonNullable<JourneyInput["unknown"]> = {};
  const shoot = p.unknowns.find((x) => x.field === "session" || x.field === "filming");
  if (shoot) u.shoot = `${shoot.why} — ${shoot.owner}: ${shoot.action}`;
  const del = p.unknowns.find((x) => x.field === "delivered");
  if (del) u.delivered = `${del.why} — ${del.owner}: ${del.action}`;
  return u;
}

export function journeyInputFrom(p: MonthProgress): JourneyInput {
  return {
    callStatus: p.call.status,
    topicsSelected: p.topics.selected,
    scriptsReady: p.scripts.ready,
    scriptsAwaiting: p.scripts.drafting + p.scripts.needsJordan,
    videosOwed: p.videosOwed,
    sessionsRequired: p.sessions.required,
    sessionsConfirmed: p.sessions.confirmed,
    sessionsFilmedConfirmed: p.sessions.filmedConfirmed,
    delivered: p.production.delivered,
    clientApproved: p.production.clientApproved,
    inReview: p.production.awaitingInternalReview,
    unknown: journeyUnknown(p),
    muted: p.muted,
  };
}

/** "Unknown: why — owner: action", the one way every staff screen says it. */
export const unknownLine = (u: MonthUnknown) => `Unknown: ${u.why} — ${u.owner}: ${u.action}`;

export const SESSION_STATE_WORDS: Record<SessionFactState, { label: string; tone: "success" | "brand" | "warning" | "muted" }> = {
  BOOKED: { label: "Booked", tone: "brand" },
  FILMED_CONFIRMED: { label: "Filmed ✓", tone: "success" },
  HELD_UNCONFIRMED: { label: "Held — filming not confirmed", tone: "warning" },
  UNVERIFIED: { label: "Unverified — no Aryeo appointment", tone: "warning" },
};

export type StaffMonthView = {
  journey: JourneyInput;
  steps: JourneyStep[];
  /** "confirmed/required" — the Filming sessions header */
  sessionsCount: string;
  confirmed: number;
  missing: number;
  filmedConfirmed: number;
  delivered: number;
  clientApproved: number;
  deliveredDone: boolean;
  /** Jordan's badge: scripts on his desk + the client's open notes */
  needsMe: number;
  unknownLines: string[];
  sessionRows: { key: string; projectId: string | null; title: string; when: string; state: SessionFactState; chip: string; tone: string; photographer: string | null; evidence: string | null }[];
  nextAction: MonthNextAction | null;
};

/** What the client file's Overview shows for a month — pure over the reader. */
export function staffMonthView(p: MonthProgress): StaffMonthView {
  const journey = journeyInputFrom(p);
  return {
    journey,
    steps: journeySteps(journey),
    sessionsCount: `${p.sessions.confirmed}/${p.sessions.required}`,
    confirmed: p.sessions.confirmed,
    missing: p.sessions.missing,
    filmedConfirmed: p.sessions.filmedConfirmed,
    delivered: p.production.delivered,
    clientApproved: p.production.clientApproved,
    deliveredDone: !p.muted && p.videosOwed > 0 && p.production.delivered >= p.videosOwed,
    needsMe: p.scripts.drafting + p.scripts.needsJordan + p.scripts.openSuggestions,
    unknownLines: p.unknowns.map(unknownLine),
    sessionRows: p.sessions.list.map((f) => ({
      key: f.key, projectId: f.projectId, title: f.projectTitle ?? "Confirmed request",
      when: f.startsAtISO ? fmtDay(f.startsAtISO) : "unscheduled",
      state: f.state, chip: SESSION_STATE_WORDS[f.state].label, tone: SESSION_STATE_WORDS[f.state].tone,
      photographer: f.photographer, evidence: f.evidence,
    })),
    nextAction: p.nextAction,
  };
}

// ---------------------------------------------------------------------------
// THE CLIENT'S VIEW — no owner names, no internal states, no job titles.
// ---------------------------------------------------------------------------

export type ClientSessionCard = { state: "BOOKED" | "HELD" | "FILMED" | "CONFIRMING"; startsAtISO: string | null; label: string; note: string | null };

export type ClientMonthProgress = {
  monthKey: string;
  videosOwed: number;
  sessions: { required: number; missing: number; cards: ClientSessionCard[] };
  production: { known: boolean; delivered: number; total: number; inProduction: number; approved: number; awaitingYou: number };
};

export function clientMonthProgress(p: MonthProgress): ClientMonthProgress {
  const cards = p.sessions.list.map((f): ClientSessionCard => {
    // "Filmed" only when somebody confirmed it; a passed date is a session
    // HELD, and a dated job we cannot tie to an appointment is being confirmed.
    if (f.state === "FILMED_CONFIRMED") return { state: "FILMED", startsAtISO: f.startsAtISO, label: "Filmed", note: null };
    if (f.state === "HELD_UNCONFIRMED") return { state: "HELD", startsAtISO: f.startsAtISO, label: "Session held", note: "We are preparing your videos." };
    if (f.state === "UNVERIFIED") return { state: "CONFIRMING", startsAtISO: f.startsAtISO, label: "Being confirmed", note: "We're confirming this session's details." };
    return { state: "BOOKED", startsAtISO: f.startsAtISO, label: "Booked", note: null };
  });
  return {
    monthKey: p.monthKey,
    videosOwed: p.videosOwed,
    sessions: { required: p.sessions.required, missing: p.sessions.missing, cards },
    production: {
      known: p.production.known,
      delivered: p.production.delivered,
      total: p.production.counted,
      inProduction: Math.max(0, p.production.counted - p.production.delivered),
      approved: p.production.clientApproved,
      awaitingYou: p.production.awaitingClient,
    },
  };
}
