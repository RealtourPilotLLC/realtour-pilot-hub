import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey, monthLabel } from "@/lib/contentProgram";
import { callModeOf, deriveMonthState, type CallMode, type PreparationStatus } from "@/lib/programMonths";
import { ownersForMany, pairKey, UNASSIGNED_OWNERS, type OwnerMap } from "@/lib/programOwners";
import { failedAutomationIndex, type FailedAutomation } from "@/lib/programMonitoring";
import { isDeliveredProgramVideo } from "@/lib/contentVideos";

// ---------------------------------------------------------------------------
// THE MONTHLY PORTFOLIO OVERVIEW (spec §16). One row per (client, program
// month) with EVERY stage of the loop and the one next action — so Jordan can
// see who needs intervention without opening a single client file.
//
// Four rules this module exists to keep, because each one was a way the old
// roster could lie:
//
//  1. PRODUCTION IS COUNTED FROM THE LIBRARY. Delivered/filmed/editing come
//     from ContentVideo rows (programCountsByMonth + per-status counts), never
//     from ordered quantities and never from topic selections. A selected
//     topic with nothing filmed contributes 0 to production — it contributes
//     to PREPARATION, which is a different column.
//  2. A COMPLETED CALL IS NOT COMPLETED PREPARATION. The call's appointment
//     status and its transcript/evidence state are separate readings; a call
//     that was held but whose transcript failed to import shows preparation as
//     incomplete and names the failure, because nobody can write scripts from
//     a transcript that is not there.
//  3. "WE OWE WORK" IS NOT "WAITING ON THE CLIENT". Every next action carries
//     a `blocked` side (us | client | nobody) and the duty owner who holds it.
//  4. COMMUNICATION IS READ, NOT INFERRED. The reminder columns come from
//     ProgramReminder rows only. Tonight there are none, and an empty column
//     says "no reminder has ever been sent", which is the honest answer.
// ---------------------------------------------------------------------------

export type OverviewFilterKey =
  | "needs_approval" | "missing_planning" | "missing_appointment" | "awaiting_client"
  | "ready_to_film" | "in_production" | "awaiting_review" | "failed_automation" | "overdue";

export const OVERVIEW_FILTERS: { key: OverviewFilterKey; label: string; hint: string }[] = [
  { key: "needs_approval", label: "Needs my approval", hint: "a strategy or script version sitting in review" },
  { key: "missing_planning", label: "Missing planning", hint: "no call booked and no written path chosen" },
  // The hint says exactly what the flag tests. It used to promise "preparation
  // is moving", which the flag never checked — Jordan clicked it expecting a
  // bookable list and got months whose planning had not started.
  { key: "missing_appointment", label: "Missing appointment", hint: "no filming session on the calendar" },
  { key: "awaiting_client", label: "Awaiting client", hint: "the ball is with them — answers, a choice, a review" },
  { key: "ready_to_film", label: "Ready to film", hint: "scripts approved, preparation complete" },
  { key: "in_production", label: "In production", hint: "filmed, being edited" },
  { key: "awaiting_review", label: "Awaiting review", hint: "a cut is with the client" },
  { key: "failed_automation", label: "Failed automation", hint: "something automatic errored on this client" },
  { key: "overdue", label: "Overdue", hint: "the month is short and the calendar has run out" },
];

export type SessionState = "NOT_SCHEDULED" | "REQUESTED" | "CONFIRMED" | "COMPLETED" | "CANCELLED";

export type OverviewRow = {
  enrollmentId: string;
  clientId: string;
  clientName: string;
  pkg: string;
  enrollmentStatus: string; // ACTIVE | PAUSED | ENDED
  trial: boolean;
  monthId: string | null;
  monthKey: string;
  monthName: string;
  monthStatus: string; // OPEN | COMPLETED | SKIPPED | IMPORTED
  historical: boolean;
  owners: OwnerMap;

  planning: {
    callMode: CallMode;
    /** "Call required" | "Call optional (written path allowed)" | "No call in this package" */
    requirementWord: string;
    planningMode: "CALL" | "WRITTEN" | "UNDECIDED";
    callStatus: string;
    callAtISO: string | null;
    preparationStatus: PreparationStatus | null;
    preparationWord: string;
    /** No-call path only: are the answers in? */
    answersOutstanding: number;
    complete: boolean;
  };

  strategyCall: {
    /** the booked/held monthly call for this month, when there is one */
    atISO: string | null;
    status: string | null; // SCHEDULED | COMPLETED | CANCELLED | NO_SHOW | RESCHEDULED
    /** the transcript/evidence state — the reason a "completed" call can still block preparation */
    transcriptState: string | null;
    evidence: string | null; // human sentence: what we actually hold
    processing: string | null; // transcript job state, when a job exists
    problem: string | null; // set when the call is done but the evidence is not
  };

  session: { state: SessionState; dateISO: string | null; detail: string | null; requestedCount: number };

  work: {
    topicsSelected: number;
    topicsNeeded: number;
    answersOutstanding: number;
    scriptsDrafting: number;
    scriptsReviewNeeded: number;
    scriptsApproved: number;
    strategyReviewNeeded: number;
  };

  production: {
    filmed: number; editing: number; clientReview: number; delivered: number; owed: number; carriedIn: number;
    /** how many ContentVideo rows exist for this month at all */
    libraryRows: number;
    /** what the PIPELINE (attached projects) says was delivered — shown only to expose a library that has not been built */
    pipelineDelivered: number;
    /** true when the pipeline delivered more than the library knows about: the number on screen is understated, and says so */
    libraryBehind: boolean;
  };

  nextAction: {
    text: string;
    owner: string; // the person's name
    ownerDuty: string;
    blocked: "us" | "client" | "nobody";
    deadlineISO: string | null;
    href: string;
    cta: string;
  };

  comms: {
    lastAt: Date | null;
    lastAction: string | null;
    lastState: string | null;
    nextEligibleAt: Date | null;
    suppressionReason: string | null;
    failure: string | null;
    everSent: boolean;
  };

  failures: FailedAutomation[];
  flags: OverviewFilterKey[];
  /** lower = more urgent; the default sort */
  priority: number;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * "This video is delivered." THE SAME FUNCTION contentVideos uses, imported
 * rather than copied: the overview reads the whole book in one query while
 * programCountsByMonth is per-enrollment, and a hand-copy of the rule drifted
 * once inside a single day — which would have shown Jordan a different
 * delivered count from the one the client sees in their portal.
 */
const deliveredVideo = isDeliveredProgramVideo;

const REQUIREMENT_WORD: Record<CallMode, string> = {
  REQUIRED: "Call required",
  OPTIONAL_WRITTEN: "Call optional — written path allowed",
  NOT_INCLUDED: "No call in this package",
};

const PREP_WORD: Record<PreparationStatus, string> = {
  CALL_PLANNED: "call is the plan",
  WRITTEN_SELECTED: "planning without a call",
  AWAITING_ANSWERS: "waiting on their answers",
  PREPARING_SCRIPTS: "scripts being written",
  AWAITING_SCRIPT_APPROVAL: "scripts waiting for approval",
  READY_FOR_FILMING: "ready to film",
};

/** ISO of the last day of an ET month — the obligation deadline every month carries. */
function monthEndISO(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  // day 0 of the next month = the last day of this one; 23:59 ET ≈ 03:59Z next day.
  return new Date(Date.UTC(y, m, 1, 3, 59)).toISOString();
}

export type OverviewOptions = {
  /** a month key, or "ALL_OPEN" for every month that still carries an obligation. */
  monthKey?: string;
  /** include ENDED enrollments (a filter Jordan turns on, never the default). */
  includeEnded?: boolean;
};

export const ALL_OPEN = "ALL_OPEN";

export type OverviewResult = {
  rows: OverviewRow[];
  monthKey: string;
  monthKeys: string[]; // every month with a workspace, newest first — the selector
  counts: Record<OverviewFilterKey, number>;
  /** rows whose enrollment is ENDED, present only when includeEnded */
  endedCount: number;
  globalFailures: FailedAutomation[];
};

export async function programOverview(opts: OverviewOptions = {}): Promise<OverviewResult> {
  const now = new Date();
  const thisMonth = etMonthKey(now);
  const allOpen = opts.monthKey === ALL_OPEN;
  const monthKey = allOpen ? ALL_OPEN : opts.monthKey && /^\d{4}-\d{2}$/.test(opts.monthKey) ? opts.monthKey : thisMonth;

  const statuses = opts.includeEnded ? ["ACTIVE", "PAUSED", "ENDED"] : ["ACTIVE", "PAUSED"];
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: { in: statuses } },
    select: {
      id: true, clientId: true, package: true, status: true, videosPerMonth: true, sessionsPerMonth: true,
      strategyCallRequired: true, callMode: true, noCallEligible: true, clientSuppliesTopics: true, billingType: true, notes: true,
    },
  });
  if (enrollments.length === 0) {
    return { rows: [], monthKey: allOpen ? ALL_OPEN : monthKey, monthKeys: [], counts: emptyCounts(), endedCount: 0, globalFailures: [] };
  }
  const enrollmentIds = enrollments.map((e) => e.id);

  // Every month workspace that exists, so the selector lists real months and
  // "all open months" can find obligations that outlived their calendar month.
  const allMonths = await prisma.contentMonth.findMany({
    where: { enrollmentId: { in: enrollmentIds } },
    orderBy: { monthKey: "desc" },
  });
  const monthKeys = [...new Set(allMonths.map((m) => m.monthKey))].sort().reverse();

  // The months in scope. ALL_OPEN = every non-historical, non-skipped month up
  // to and including this one that is not already COMPLETED — an August
  // obligation does not disappear because September started (Jordan's rule:
  // old obligations never vanish).
  const scoped = allOpen
    ? allMonths.filter((m) => !m.historical && m.status !== "SKIPPED" && m.status !== "IMPORTED" && m.monthKey <= thisMonth && m.status !== "COMPLETED")
    : allMonths.filter((m) => m.monthKey === monthKey);

  // An enrollment with NO month workspace for the selected month still gets a
  // row (that absence is itself the exception) — but only for a single month
  // view, where "this client has no workspace" is meaningful.
  const rowsSpec: { enrollment: (typeof enrollments)[number]; month: (typeof allMonths)[number] | null; key: string }[] = [];
  if (allOpen) {
    for (const m of scoped) {
      const e = enrollments.find((x) => x.id === m.enrollmentId);
      if (e) rowsSpec.push({ enrollment: e, month: m, key: m.monthKey });
    }
  } else {
    for (const e of enrollments) {
      const m = scoped.find((x) => x.enrollmentId === e.id) ?? null;
      // An ENDED client almost never has a workspace for the month on screen —
      // they stopped. They are still listed when the filter asks for them
      // (Jordan: ended clients stay visible, nothing is deleted), with their
      // LAST month as the context rather than an empty one.
      if (!m && e.status === "ENDED") {
        const last = allMonths.find((x) => x.enrollmentId === e.id);
        if (!last) continue; // never had a program month at all
        rowsSpec.push({ enrollment: e, month: last, key: last.monthKey });
        continue;
      }
      rowsSpec.push({ enrollment: e, month: m, key: monthKey });
    }
  }
  if (rowsSpec.length === 0) {
    return { rows: [], monthKey: allOpen ? ALL_OPEN : monthKey, monthKeys, counts: emptyCounts(), endedCount: 0, globalFailures: (await failedAutomationIndex()).global };
  }

  const monthIds = rowsSpec.map((r) => r.month?.id).filter((x): x is string => !!x);
  const clientIds = [...new Set(rowsSpec.map((r) => r.enrollment.clientId))];
  const keysInScope = [...new Set(rowsSpec.map((r) => r.key))];

  const [
    clients, owners, selections, monthTopics, interviews, scripts, strategyVersions,
    calls, sessionRequests, projects, videos, reminders, failures, jobs,
  ] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
    ownersForMany(rowsSpec.map((r) => ({ enrollmentId: r.enrollment.id, monthId: r.month?.id ?? null }))),
    monthIds.length ? prisma.contentTopicSelection.findMany({ where: { monthId: { in: monthIds }, status: { in: ["SELECTED", "CARRIED", "RECONCILED"] } }, select: { monthId: true, topicId: true, overflow: true } }) : [],
    // ContentTopic.status is still where most selections live (957 rows vs 12
    // selection rows on Sep 17) — counting only the new model would show every
    // client as "no topics picked". Counted as a UNION keyed by topic id.
    monthIds.length ? prisma.contentTopic.findMany({ where: { monthId: { in: monthIds }, status: { in: ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"] } }, select: { id: true, monthId: true } }) : [],
    monthIds.length ? prisma.contentInterview.findMany({ where: { monthId: { in: monthIds } }, select: { monthId: true, status: true, answeredCount: true, submittedAt: true } }) : [],
    monthIds.length ? prisma.contentScript.findMany({ where: { monthId: { in: monthIds } }, select: { id: true, monthId: true, status: true, historical: true, currentVersionId: true, approvedVersionId: true } }) : [],
    prisma.contentStrategyVersion.findMany({ where: { enrollmentId: { in: enrollmentIds }, status: { in: ["DRAFT", "INTERNAL_REVIEW"] } }, select: { enrollmentId: true, status: true } }),
    prisma.programCallRecord.findMany({
      where: { enrollmentId: { in: enrollmentIds }, callType: { in: ["MONTHLY_STRATEGY", "BRAND_DISCOVERY"] }, OR: [{ monthId: { in: monthIds.length ? monthIds : ["-"] } }, { targetMonthKey: { in: keysInScope } }] },
      select: { id: true, enrollmentId: true, monthId: true, targetMonthKey: true, callType: true, status: true, scheduledStart: true, transcriptState: true, matchState: true, lastError: true, analysisJson: true },
      orderBy: { scheduledStart: "desc" },
    }),
    monthIds.length ? prisma.programSessionRequest.findMany({ where: { monthId: { in: monthIds } }, select: { id: true, monthId: true, status: true, slotStart: true, bookingState: true, lastError: true } }) : [],
    monthIds.length ? prisma.project.findMany({ where: { contentMonthId: { in: monthIds } }, select: { id: true, contentMonthId: true, status: true, shootDate: true, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, quantity: true } } } }) : [],
    // The LIBRARY read (rule 1). One query for every row on screen; the
    // delivered predicate is PROGRAM_VIDEO_DELIVERED, the same one
    // programCountsByMonth uses, so this page and the portal cannot disagree.
    prisma.contentVideo.findMany({ where: { enrollmentId: { in: enrollmentIds }, monthKey: { in: keysInScope }, status: { not: "ARCHIVED" } }, select: { enrollmentId: true, monthKey: true, status: true, countsTowardAllowance: true, kind: true, filmedAt: true, deliveredAt: true, finalSubmissionId: true } }),
    prisma.programReminder.findMany({ where: { enrollmentId: { in: enrollmentIds } }, orderBy: { createdAt: "desc" }, take: 400, select: { enrollmentId: true, monthKey: true, action: true, state: true, createdAt: true, sentAt: true, nextEligibleAt: true, suppressionReason: true, lastError: true, outcome: true } }),
    failedAutomationIndex(),
    monthIds.length ? prisma.programTranscriptJob.findMany({ where: { enrollmentId: { in: enrollmentIds } }, select: { callRecordId: true, kind: true, state: true, reviewReason: true, lastError: true }, orderBy: { updatedAt: "desc" }, take: 300 }) : [],
  ]);

  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  // Only the versions the rows actually point at — a script's CURRENT version
  // is what its status must be read from (the row's own `status` is the legacy
  // mirror and goes stale the moment an editor saves a new draft).
  const wantedVersionIds = [...new Set(scripts.map((s) => s.currentVersionId).filter((x): x is string => !!x))];
  const scriptVersions = wantedVersionIds.length
    ? await prisma.contentScriptVersion.findMany({ where: { id: { in: wantedVersionIds } }, select: { id: true, status: true } })
    : [];
  const versionOf = new Map(scriptVersions.map((v) => [v.id, v]));

  const rows: OverviewRow[] = [];
  for (const spec of rowsSpec) {
    const e = spec.enrollment;
    const m = spec.month;
    const key = spec.key;
    const mid = m?.id ?? null;
    const callMode = callModeOf(e);

    // ---- planning + preparation -------------------------------------------------
    const selectedIds = new Set<string>();
    for (const s of selections) if (s.monthId === mid && !s.overflow) selectedIds.add(s.topicId);
    for (const t of monthTopics) if (t.monthId === mid) selectedIds.add(t.id);
    const topicsSelected = selectedIds.size;
    const myInterviews = interviews.filter((i) => i.monthId === mid);
    const answersOutstanding = myInterviews.filter((i) => i.status !== "SUFFICIENT" && i.status !== "SUPERSEDED" && !i.submittedAt).length;

    const myScriptsAll = scripts.filter((s) => s.monthId === mid);
    const myScripts = myScriptsAll.filter((s) => !s.historical);
    let drafting = 0, reviewNeeded = 0, approved = 0;
    for (const s of myScripts) {
      const v = s.currentVersionId ? versionOf.get(s.currentVersionId) : null;
      const st = v?.status ?? s.status;
      if (st === "INTERNAL_REVIEW") reviewNeeded++;
      else if (st === "DRAFT") drafting++;
      else if (st === "APPROVED" || st === "SHARED" || s.approvedVersionId) approved++;
    }
    const strategyReviewNeeded = strategyVersions.filter((v) => v.enrollmentId === e.id && v.status === "INTERNAL_REVIEW").length;

    // ---- the monthly call + what we actually hold from it ------------------------
    const myCalls = calls.filter((c) => c.enrollmentId === e.id && (mid ? c.monthId === mid : false) || (c.enrollmentId === e.id && c.targetMonthKey === key));
    const monthly = myCalls.filter((c) => c.callType === "MONTHLY_STRATEGY");
    // The one that speaks: a held call outranks a future booking.
    const heldCall = monthly.find((c) => c.status === "COMPLETED") ?? monthly.find((c) => c.scheduledStart && c.scheduledStart < now && c.status !== "CANCELLED") ?? null;
    const bookedCall = monthly.find((c) => c.status === "SCHEDULED" && c.scheduledStart && c.scheduledStart >= now) ?? null;
    const call = heldCall ?? bookedCall ?? monthly[0] ?? null;
    const callJobs = call ? jobs.filter((j) => j.callRecordId === call.id) : [];
    const jobWord = callJobs.length
      ? callJobs.some((j) => j.state === "FAILED") ? "transcript job failed"
        : callJobs.some((j) => j.state === "NEEDS_REVIEW") ? "transcript job needs a person"
        : callJobs.some((j) => j.state === "RUNNING") ? "transcript processing"
        : callJobs.some((j) => j.state === "QUEUED") ? "transcript queued"
        : "transcript processed"
      : null;
    const analysed = call?.transcriptState === "ANALYZED";
    const evidence = call
      ? analysed ? "transcript analysed"
        : call.transcriptState === "CONFIRMED" ? "transcript held, not analysed yet"
        : call.transcriptState === "CANDIDATES" ? "possible transcripts found — none confirmed"
        : call.transcriptState === "FAILED" ? "transcript import failed"
        : call.transcriptState === "NEEDS_REVIEW" ? "transcript needs a person"
        : call.transcriptState === "AWAITING" ? "waiting for the transcript"
        : m?.transcriptText ? "transcript pasted by hand" : "no transcript"
      : m?.transcriptText ? "transcript pasted by hand" : null;
    // RULE 2: a call that was held but whose evidence never landed is NOT
    // completed preparation — and the row must say why, not just go quiet.
    // HELD, not "dealt with": SKIPPED means a person decided this month runs
    // without a call, so there is no missing transcript to complain about.
    const callHeld = !!heldCall || m?.strategyCallStatus === "COMPLETED";
    const callSkipped = m?.strategyCallStatus === "SKIPPED";
    const evidenceMissing = callHeld && !analysed && !m?.transcriptProcessedAt && !m?.transcriptText;
    // A transcript that FAILED or was handed back for review is a hard block:
    // an automation stopped and a person has to act, whatever else is on the
    // month. "The call happened and nothing was recorded" is softer — if the
    // scripts got written anyway (Jordan's archive imports do exactly this),
    // it is a note, not the thing standing in the way.
    const hardCallProblem = evidenceMissing
      ? call?.transcriptState === "FAILED" ? `Call was held — the transcript import failed${call.lastError ? ` (${call.lastError.slice(0, 80)})` : ""}`
        : call?.transcriptState === "NEEDS_REVIEW" ? "Call was held — the transcript needs a person before it can be used"
        : call?.transcriptState === "CANDIDATES" ? "Call was held — a transcript was found but nobody confirmed it belongs to this call"
        : null
      : null;
    const callProblem = hardCallProblem ?? (evidenceMissing ? "Call was held — no transcript or notes came back from it" : null);

    // Preparation is DERIVED with programMonths.deriveMonthState, not read off
    // the column: the column is null on most live months (nothing has recalced
    // them yet) and a null column would report a client mid-flight as "not
    // started". Same function the month workspace uses → same answer.
    const derived = m
      ? deriveMonthState({
          now,
          month: {
            strategyCallStatus: m.strategyCallStatus, strategyCallAt: m.strategyCallAt, transcriptText: m.transcriptText,
            planningMode: m.planningMode, preparationStatus: m.preparationStatus, preparationCompletedAt: m.preparationCompletedAt,
            preparationWindowDays: m.preparationWindowDays, preparationExceptionAt: m.preparationExceptionAt,
            preparationExceptionReason: m.preparationExceptionReason, filmingReadyAt: m.filmingReadyAt, historical: m.historical,
          },
          enrollment: { callMode: e.callMode, strategyCallRequired: e.strategyCallRequired, noCallEligible: e.noCallEligible },
          records: monthly.map((c) => ({ callType: c.callType, status: c.status, matchState: c.matchState, scheduledStart: c.scheduledStart, scheduledEnd: null, transcriptState: c.transcriptState })),
          scripts: myScriptsAll.map((s) => ({ status: s.status, approvedVersionId: s.approvedVersionId, approvedAt: null, historical: s.historical })),
          interviews: myInterviews.map((i) => ({ status: i.status, submittedAt: i.submittedAt })),
        })
      : null;
    const preparationStatus = (derived?.preparationStatus ?? null) as PreparationStatus | null;
    const preparationComplete = !!derived?.filmingReadyAt || preparationStatus === "READY_FOR_FILMING";
    const planningMode = (derived?.planningMode ?? "UNDECIDED") as "CALL" | "WRITTEN" | "UNDECIDED";
    const blockingCallProblem = hardCallProblem ?? (callProblem && !preparationComplete && myScripts.length === 0 ? callProblem : null);
    const preparationWord = blockingCallProblem
      ? "incomplete — the call happened, the evidence did not land"
      : preparationStatus ? PREP_WORD[preparationStatus]
      : callMode === "NOT_INCLUDED" ? "no call — written preparation"
      : "not started";

    // ---- the content session (appointment) ----------------------------------------
    const myProjects = projects.filter((p) => p.contentMonthId === mid && p.status !== "CANCELLED");
    const myRequests = sessionRequests.filter((s) => s.monthId === mid);
    const liveRequest = myRequests.find((s) => s.status === "REQUESTED" || s.status === "RESCHEDULE_REQUESTED") ?? null;
    const confirmedProject = myProjects.sort((a, b) => (a.shootDate?.getTime() ?? 0) - (b.shootDate?.getTime() ?? 0))[0] ?? null;
    const shotProject = myProjects.find((p) => p.shootDate && p.shootDate < now) ?? null;
    const cancelledOnly = myRequests.length > 0 && myProjects.length === 0 && myRequests.every((s) => ["CANCELLED", "DECLINED", "EXPIRED"].includes(s.status));
    const sessionState: SessionState =
      shotProject ? "COMPLETED"
      : confirmedProject ? "CONFIRMED"
      : liveRequest ? "REQUESTED"
      : cancelledOnly ? "CANCELLED"
      : "NOT_SCHEDULED";
    const sessionDate = shotProject?.shootDate ?? confirmedProject?.shootDate ?? liveRequest?.slotStart ?? null;
    const sessionDetail =
      sessionState === "REQUESTED" ? "the client asked — Kyle has not confirmed a slot"
      : sessionState === "CANCELLED" ? "every request on this month was cancelled or declined"
      : sessionState === "NOT_SCHEDULED" ? "nothing on the calendar"
      : null;

    // ---- production, counted from the LIBRARY (rule 1) ------------------------------
    const myVideos = videos.filter((v) => v.enrollmentId === e.id && v.monthKey === key);
    const counted = myVideos.filter((v) => v.countsTowardAllowance);
    const delivered = counted.filter(deliveredVideo).length;
    // The PIPELINE reading, kept beside the library one. It is NOT added to the
    // library count — it exists so a client whose library has not been built
    // shows "0 (the library is behind)" instead of a confident, wrong 0.
    const videoUnits = (p: { deliverables: { type: string; quantity: number | null }[] }) =>
      p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
    const pipelineDelivered = myProjects.filter((p) => p.status === "DELIVERED").reduce((n, p) => n + Math.max(1, videoUnits(p)), 0);
    const production = {
      filmed: counted.filter((v) => !!v.filmedAt || ["FILMED", "EDITING", "CLIENT_REVIEW", "APPROVED", "DELIVERED"].includes(v.status)).length,
      editing: counted.filter((v) => v.status === "EDITING").length,
      clientReview: counted.filter((v) => v.status === "CLIENT_REVIEW").length,
      delivered,
      // A month that does not exist because the client is paused/ended owes
      // nothing — "0/4" on a paused client reads as the agency being behind.
      owed: m?.videosOwed ?? (e.status === "ACTIVE" ? e.videosPerMonth : 0),
      carriedIn: myVideos.filter((v) => v.kind === "CARRYOVER").length,
      libraryRows: myVideos.length,
      pipelineDelivered,
      libraryBehind: pipelineDelivered > delivered,
    };
    const topicsNeeded = Math.max(0, production.owed - topicsSelected);

    // ---- communication — read only, empty is honest --------------------------------
    const myReminders = reminders.filter((r) => r.enrollmentId === e.id && (r.monthKey ? r.monthKey === key : true));
    const lastSent = myReminders.find((r) => r.state === "SENT") ?? null;
    const lastAny = myReminders[0] ?? null;
    const nextEligible = myReminders.map((r) => r.nextEligibleAt).filter((d): d is Date => !!d && d > now).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const comms = {
      lastAt: lastSent?.sentAt ?? lastSent?.createdAt ?? null,
      lastAction: lastSent?.action ?? null,
      lastState: lastAny?.state ?? null,
      nextEligibleAt: nextEligible,
      suppressionReason: myReminders.find((r) => r.suppressionReason)?.suppressionReason ?? null,
      failure: myReminders.find((r) => r.state === "FAILED" || r.state === "BOUNCED")?.lastError ?? myReminders.find((r) => r.outcome === "bounced")?.outcome ?? null,
      everSent: !!lastSent,
    };

    const myFailures = failures.byEnrollment.get(e.id) ?? [];
    // NEVER fall back to another row's owner map: printing a stranger's name
    // beside a client is worse than printing "unassigned".
    const owner = owners.get(pairKey(e.id, mid)) ?? UNASSIGNED_OWNERS;
    const deadline = monthEndISO(key);
    const monthOver = key < thisMonth;

    // ---- THE NEXT ACTION: walk the loop; the first unfinished stage speaks. ---------
    const href = (tab?: string) => `/content/${e.id}?${new URLSearchParams({ ...(key !== thisMonth ? { month: key } : {}), ...(tab ? { tab } : {}) }).toString()}`.replace(/\?$/, "");
    let next: OverviewRow["nextAction"];
    if (!m && e.status !== "ACTIVE") {
      // A PAUSED (or ENDED) enrollment has no workspace BY DESIGN: the sweep's
      // ensureCurrentMonths only mints months for ACTIVE enrollments. Calling
      // that "we owe this" and offering a button that can never mint anything
      // put three deliberately-paused clients at the top of Jordan's morning
      // filter as false alarms. A dormant month is nobody's obligation.
      next = {
        text: `${e.status === "PAUSED" ? "Paused" : "Ended"} — no ${monthLabel(key)} workspace, and none is minted while the enrollment is ${e.status.toLowerCase()}`,
        owner: owner.DELIVERY.label, ownerDuty: "delivery", blocked: "nobody", deadlineISO: null, href: href(), cta: "Open the client file",
      };
    } else if (!m) {
      next = { text: `No ${monthLabel(key)} workspace yet — "Sync now" mints it`, owner: owner.SCHEDULING.label, ownerDuty: "scheduling", blocked: "us", deadlineISO: deadline, href: href(), cta: "Open the client file" };
    } else if (e.status === "ENDED") {
      next = { text: `Ended — ${monthLabel(key)} is the last month on file`, owner: owner.DELIVERY.label, ownerDuty: "delivery", blocked: "nobody", deadlineISO: null, href: href(), cta: "Open the history" };
    } else if (m.status === "SKIPPED") {
      next = { text: "Month skipped on purpose — nothing owed", owner: owner.DELIVERY.label, ownerDuty: "delivery", blocked: "nobody", deadlineISO: null, href: href(), cta: "Open" };
    } else if (m.historical) {
      next = { text: "Imported history — read only", owner: owner.DELIVERY.label, ownerDuty: "delivery", blocked: "nobody", deadlineISO: null, href: href(), cta: "Open" };
    } else if (blockingCallProblem) {
      next = { text: blockingCallProblem, owner: owner.STRATEGY.label, ownerDuty: "strategy", blocked: "us", deadlineISO: deadline, href: "/content/monitoring#calls", cta: "Fix the transcript" };
    } else if (callMode === "REQUIRED" && !callHeld && !callSkipped && !bookedCall && m.strategyCallStatus !== "SCHEDULED") {
      next = { text: "Strategy call is required and nothing is booked", owner: owner.SCHEDULING.label, ownerDuty: "scheduling", blocked: "client", deadlineISO: deadline, href: href(), cta: "Chase the booking" };
    } else if (callMode === "OPTIONAL_WRITTEN" && planningMode === "UNDECIDED" && !callHeld && !callSkipped && !bookedCall) {
      next = { text: "They have not chosen a call or the written path", owner: owner.SCHEDULING.label, ownerDuty: "scheduling", blocked: "client", deadlineISO: deadline, href: href(), cta: "Ask them to choose" };
    } else if (bookedCall?.scheduledStart && !callHeld) {
      next = { text: `Strategy call booked for ${bookedCall.scheduledStart.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" })}`, owner: owner.STRATEGY.label, ownerDuty: "strategy", blocked: "nobody", deadlineISO: iso(bookedCall.scheduledStart), href: href(), cta: "Open the month" };
    } else if (answersOutstanding > 0) {
      next = { text: `${answersOutstanding} topic${answersOutstanding === 1 ? "" : "s"} still waiting on their answers`, owner: owner.STRATEGY.label, ownerDuty: "strategy", blocked: "client", deadlineISO: deadline, href: href("ideas"), cta: "See the questions" };
    } else if (topicsNeeded > 0 && !e.clientSuppliesTopics) {
      next = { text: `${topicsNeeded} more topic${topicsNeeded === 1 ? "" : "s"} to pick for ${monthLabel(key)}`, owner: owner.STRATEGY.label, ownerDuty: "strategy", blocked: "us", deadlineISO: deadline, href: href("ideas"), cta: "Pick topics" };
    } else if (strategyReviewNeeded > 0) {
      next = { text: `A strategy version is waiting for ${owner.STRATEGY.label}`, owner: owner.STRATEGY.label, ownerDuty: "strategy approval", blocked: "us", deadlineISO: deadline, href: href("strategy"), cta: "Review the strategy" };
    } else if (reviewNeeded > 0) {
      next = { text: `${reviewNeeded} script${reviewNeeded === 1 ? "" : "s"} waiting for ${owner.SCRIPTS.label}`, owner: owner.SCRIPTS.label, ownerDuty: "script approval", blocked: "us", deadlineISO: deadline, href: href("scripts"), cta: "Review the scripts" };
    } else if (drafting > 0 || (approved < production.owed && myScripts.length < production.owed)) {
      const missing = Math.max(drafting, production.owed - myScripts.length);
      next = { text: `${missing} script${missing === 1 ? "" : "s"} still to be written`, owner: owner.SCRIPTS.label, ownerDuty: "scripts", blocked: "us", deadlineISO: deadline, href: href("scripts"), cta: "Open scripts" };
    } else if (sessionState === "REQUESTED") {
      next = { text: "They asked for a session — nothing confirmed", owner: owner.SCHEDULING.label, ownerDuty: "scheduling", blocked: "us", deadlineISO: deadline, href: href(), cta: "Confirm the slot" };
    } else if (sessionState === "NOT_SCHEDULED" || sessionState === "CANCELLED") {
      next = { text: "Scripts are ready — no filming session on the calendar", owner: owner.SCHEDULING.label, ownerDuty: "scheduling", blocked: "us", deadlineISO: deadline, href: href(), cta: "Book the session" };
    } else if (sessionState === "CONFIRMED") {
      next = { text: `Filming ${sessionDate ? sessionDate.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : "soon"}`, owner: owner.SCHEDULING.label, ownerDuty: "scheduling", blocked: "nobody", deadlineISO: iso(sessionDate), href: href(), cta: "Open the month" };
    } else if (production.clientReview > 0) {
      next = { text: `${production.clientReview} cut${production.clientReview === 1 ? "" : "s"} waiting on the client`, owner: owner.DELIVERY.label, ownerDuty: "delivery", blocked: "client", deadlineISO: deadline, href: "/review", cta: "Open the Review Room" };
    } else if (production.delivered < production.owed) {
      const left = production.owed - production.delivered;
      next = { text: `${left} of ${production.owed} video${production.owed === 1 ? "" : "s"} still in production`, owner: owner.DELIVERY.label, ownerDuty: "delivery", blocked: "us", deadlineISO: deadline, href: href("content"), cta: "See the videos" };
    } else {
      next = { text: `All ${production.owed} videos delivered`, owner: owner.DELIVERY.label, ownerDuty: "delivery", blocked: "nobody", deadlineISO: null, href: href("content"), cta: "Open" };
    }

    // ---- filters ------------------------------------------------------------------
    const flags: OverviewFilterKey[] = [];
    if (reviewNeeded > 0 || strategyReviewNeeded > 0) flags.push("needs_approval");
    // Both planning flags are obligations, so they only apply to a LIVE
    // enrollment: a paused or ended client has no planning to be missing and
    // no appointment to book, and listing them here made the first filter
    // Jordan reaches for on his morning page mostly false alarms.
    const live = e.status === "ACTIVE";
    if (live && (!m || (callMode !== "NOT_INCLUDED" && !callHeld && !callSkipped && !bookedCall && planningMode === "UNDECIDED") || !!blockingCallProblem)) flags.push("missing_planning");
    if (live && m && (sessionState === "NOT_SCHEDULED" || sessionState === "CANCELLED")) flags.push("missing_appointment");
    if (next.blocked === "client") flags.push("awaiting_client");
    // "Ready to film" must agree with the preparation reading: a month whose
    // scripts are approved but whose call evidence never landed is NOT ready,
    // and listing it here would send a photographer to a shoot nobody planned.
    if (live && preparationComplete && !blockingCallProblem && sessionState !== "COMPLETED") flags.push("ready_to_film");
    if (production.editing > 0 || (production.filmed > production.delivered)) flags.push("in_production");
    if (production.clientReview > 0) flags.push("awaiting_review");
    if (myFailures.length > 0) flags.push("failed_automation");
    // Overdue is the same kind of claim: an ENDED client's last month is in the
    // past by definition, and flagging all twelve of them "overdue" the moment
    // Jordan ticks "show ended clients" would be twelve accusations about work
    // nobody owes.
    if (live && production.delivered < production.owed && (monthOver || (key === thisMonth && sessionState === "NOT_SCHEDULED" && new Date(deadline).getTime() - now.getTime() < 7 * 864e5))) flags.push("overdue");

    // ---- priority: the worse it is, the smaller the number ------------------------
    let priority = 500;
    if (m?.status === "SKIPPED" || m?.historical) priority = 900;
    else if (flags.includes("overdue")) priority = 10;
    else if (blockingCallProblem) priority = 20;
    else if (flags.includes("failed_automation")) priority = 30;
    else if (flags.includes("needs_approval")) priority = 40;
    else if (flags.includes("missing_planning")) priority = 50;
    else if (flags.includes("missing_appointment")) priority = 60;
    else if (flags.includes("awaiting_client")) priority = 70;
    else if (flags.includes("awaiting_review")) priority = 80;
    else if (flags.includes("ready_to_film")) priority = 90;
    else if (flags.includes("in_production")) priority = 100;
    else if (production.delivered >= production.owed && production.owed > 0) priority = 800;
    if (e.status === "PAUSED") priority += 300;
    if (e.status === "ENDED") priority += 400;

    rows.push({
      enrollmentId: e.id, clientId: e.clientId, clientName: nameOf.get(e.clientId) ?? "Unknown client",
      pkg: e.package, enrollmentStatus: e.status, trial: e.billingType === "TRIAL",
      monthId: mid, monthKey: key, monthName: monthLabel(key), monthStatus: m?.status ?? "NONE", historical: !!m?.historical,
      owners: owner,
      planning: {
        callMode, requirementWord: REQUIREMENT_WORD[callMode], planningMode,
        callStatus: m?.strategyCallStatus ?? "NOT_SCHEDULED", callAtISO: iso(m?.strategyCallAt ?? bookedCall?.scheduledStart ?? null),
        preparationStatus, preparationWord, answersOutstanding, complete: preparationComplete && !blockingCallProblem,
      },
      strategyCall: {
        atISO: iso(call?.scheduledStart ?? m?.strategyCallAt ?? null), status: call?.status ?? null,
        transcriptState: call?.transcriptState ?? null, evidence, processing: jobWord, problem: callProblem,
      },
      session: { state: sessionState, dateISO: iso(sessionDate), detail: sessionDetail, requestedCount: myRequests.length },
      work: { topicsSelected, topicsNeeded, answersOutstanding, scriptsDrafting: drafting, scriptsReviewNeeded: reviewNeeded, scriptsApproved: approved, strategyReviewNeeded },
      production,
      nextAction: next,
      comms,
      failures: myFailures,
      flags,
      priority,
    });
  }

  rows.sort((a, b) => a.priority - b.priority || a.monthKey.localeCompare(b.monthKey) || a.clientName.localeCompare(b.clientName));
  const counts = emptyCounts();
  for (const r of rows) for (const f of r.flags) counts[f]++;
  return {
    rows, monthKey: allOpen ? ALL_OPEN : monthKey, monthKeys,
    counts, endedCount: rows.filter((r) => r.enrollmentStatus === "ENDED").length,
    globalFailures: failures.global,
  };
}

function emptyCounts(): Record<OverviewFilterKey, number> {
  return { needs_approval: 0, missing_planning: 0, missing_appointment: 0, awaiting_client: 0, ready_to_film: 0, in_production: 0, awaiting_review: 0, failed_automation: 0, overdue: 0 };
}
