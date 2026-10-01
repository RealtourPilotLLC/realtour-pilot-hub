import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assigneeName, listAssignees, type Assignee } from "@/lib/assignees";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { editorRouting } from "@/lib/settings";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { resolveEditorAssignment } from "@/lib/editorAssignment";
import { isSyntheticClientRow } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// THE EXCEPTIONS BOARD (R08, review Sep 18).
//
// Five things that go wrong quietly, each with a NAME on it and one sentence
// saying what to do. The board already had a Radar — three strategic risks,
// deliberately capped — and it was never meant to carry this: a job nobody has
// assigned, a cut nobody has ruled on, a chase date that has passed, a render
// stuck at the provider, a corrected video sitting approved and unsent. None of
// those is a strategic risk. Each is a specific thing somebody has to do.
//
// TWO RULES this file keeps:
//   · EVERY ROW HAS AN OWNER AND A NEXT ACTION. An exception nobody owns is a
//     worry, not a task, and worries accumulate until people stop reading the
//     card. Where the owner is genuinely unknown the row says "nobody yet",
//     which IS the exception in the unassigned case.
//   · IT ONLY EVER REPORTS. Nothing here writes a status, sends a message,
//     re-delivers a file or contacts a client — the same rule the delivery
//     reconciliation keeps, and for the same reason.
//
// A THIRD RULE, added Sep 20 after a pass over what the card was actually
// saying: IT NEVER CLAIMS TO BE COMPLETE WHEN IT IS NOT. Each kind is capped,
// on purpose, so one bad kind cannot crowd the rest out — which makes the rows
// a PAGE. The card counted that page and printed it as the tally ("6 things
// with a name on them" while nine qualified), so every kind now carries its
// real total and the card says "4 of 7" where the cap bit.
// ---------------------------------------------------------------------------

export type ExceptionKind =
  | "unassigned"
  | "aging-review"
  | "overdue-followup"
  | "stalled-render"
  | "unsent-replacement"
  | "unverified-render"
  | "library-missing"
  | "legacy-identity"
  | "reopened-work"
  | "unmapped-scope"
  | "other-output"
  | "missing-prerequisite"
  | "photo-batch"
  | "at-risk-promise";

export type OpsException = {
  id: string;
  kind: ExceptionKind;
  severity: "high" | "medium";
  /** the thing, named — an address or a person, never a row id */
  title: string;
  /** why it is on this list, in one clause */
  why: string;
  /** who has to move it. "Nobody yet" is a real answer and its own exception. */
  owner: string;
  /** the single next action, in the imperative */
  nextAction: string;
  href: string;
  /** how long it has been like this */
  ageDays: number;
};

/**
 * How big a pile really is: everything the predicate matches, and how much of
 * it is the severity the card calls "worth doing today". BOTH numbers are
 * needed, because the card prints both in one sentence — a real total beside a
 * high count taken off the visible page would be the same lie in a quieter
 * place (Sep 20).
 */
export type ExceptionTotal = { all: number; high: number };

/**
 * The board: the rows that fit, and how many there really are of each kind.
 * `rows` is capped per kind (EXCEPTION_RULES.perKind), so anything counting it
 * is counting a page. `totals` is what the same predicates return uncapped, and
 * it is what the header and the "4 of 7" line are built from.
 */
export type OpsExceptionBoard = {
  rows: OpsException[];
  totals: Record<ExceptionKind, ExceptionTotal>;
  /** A failed pool read is unknown, never an empty checked board. */
  unavailable?: boolean;
};

/** A healthy empty board. Failed readers must also mark it unavailable. */
export function emptyExceptionBoard(): OpsExceptionBoard {
  const none: ExceptionTotal = { all: 0, high: 0 };
  return {
    rows: [],
    totals: {
      unassigned: { ...none },
      "aging-review": { ...none },
      "overdue-followup": { ...none },
      "stalled-render": { ...none },
      "unsent-replacement": { ...none },
      "unverified-render": { ...none },
      "library-missing": { ...none },
      "legacy-identity": { ...none },
      "reopened-work": { ...none },
      "unmapped-scope": { ...none },
      "other-output": { ...none },
      "missing-prerequisite": { ...none },
      "photo-batch": { ...none },
      "at-risk-promise": { ...none },
    },
  };
}

export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  unassigned: "Editing assignment to confirm",
  "aging-review": "Waiting on a verdict",
  "overdue-followup": "Follow-up date passed",
  "stalled-render": "Render stuck at the provider",
  "unsent-replacement": "Approved replacement, not sent",
  "unverified-render": "1080p file held — sound not verified",
  "library-missing": "Approved video not in the client's library",
  "legacy-identity": "Old library file needs its video confirmed",
  "reopened-work": "Reopened work",
  "unmapped-scope": "Product nobody has mapped",
  "other-output": "Order line with no known output",
  "missing-prerequisite": "Missing what the product needs first",
  "photo-batch": "AutoHDR batch short or doubled",
  "at-risk-promise": "Promise at risk — client not updated",
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
/**
 * A ceiling, not a cap. Two of the five reads have to come back WHOLE — their
 * rows are filtered in memory afterwards, so truncating them would hide rows
 * rather than page them. That is fine while the pools are what they are today
 * (11 unsent candidates, 0 live renders), but a query that runs on every home
 * screen should not be the one thing between the dashboard and an unbounded
 * table read. 200 is roughly twenty times the largest of those pools, so the
 * filters below still run over everything in practice; if either pool ever
 * approaches it, the answer is a narrower predicate, not a bigger number.
 */
const SAFETY_CEILING = 200;
const ageOf = (d: Date | null | undefined, now: number) => (d ? Math.max(0, Math.floor((now - d.getTime()) / DAY)) : 0);
const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "A job";
/** A stored assignment slug made fit to print: "luma" → Luma, "external_agency"
 *  → External Agency. Only ever used where the roster could not name the key. */
const prettyKey = (key: string) =>
  key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || key;

/** Thresholds, in one place so a person can argue with them. Deliberately
 *  generous: a board that fires on everything is a board nobody reads. */
export const EXCEPTION_RULES = {
  /**
   * A cut with no verdict after this many COVERED days (Mon–Fri 9–6 ET by the
   * rota). Was 3 calendar days until Sep 25: the unified handoff's default —
   * pending Jordan's answer on coverage (§13) — is that he is reached HERE
   * after two covered days, not by a page. Covered, so a Friday-5pm cut is not
   * "three days late" on Monday morning; high at twice this.
   */
  reviewAgingCoveredDays: 2,
  /**
   * A provider job with no movement for this many hours.
   *
   * SIX, not four, since Sep 20. The render driver runs its OWN stall clock at
   * four hours (STALL_MS in topazJobs.ts) and FAILS the job at that horizon, so
   * a board firing at the same number was either duplicating a failure that was
   * about to happen or shouting about the driver's last few minutes of patience.
   * Sitting above it means this row reports only what the driver did NOT catch:
   * a queued, estimated or uploading job (none of those steps has a stall check)
   * that nothing is moving. If the driver's number changes, this one moves with
   * it — they are two halves of one rule.
   */
  renderStalledHours: 6,
  /** a corrected video approved and unsent for this many days */
  unsentDays: 1,
  /** how many rows of each kind, so one bad kind cannot crowd the rest out */
  perKind: 4,
};

export type CreativeApprover = {
  id: string;
  name: string;
  /** where the name came from — a designation, or a flag set for something else */
  from: "designated" | "creative-manager-flag";
  /** whether their login can actually press Approve (approveCut needs ADMIN) */
  canApprove: boolean;
};

/**
 * WHOSE VERDICT IT IS. Three answers, and the difference is reported rather
 * than smoothed over:
 *
 *   designated            Settings → Review Room names them. The real answer.
 *   creative-manager-flag TeamMember.creativeManager, which exists for the
 *                         shoot-bonus basis and may never have been set with
 *                         approvals in mind — so the caller is told.
 *   null                  nobody, and the board says "the office".
 *
 * `canApprove` is the on-call picker's `reachable` idea applied here: naming
 * somebody whose login cannot press the button is a rota that pages nobody.
 */
export async function creativeApprover(): Promise<CreativeApprover | null> {
  const { reviewRoomRules } = await import("@/lib/settings");
  const rules = await reviewRoomRules().catch(() => null);
  const picked = rules?.creativeApproverTeamMemberId
    ? await prisma.teamMember
        .findFirst({ where: { id: rules.creativeApproverTeamMemberId, active: true }, select: { id: true, name: true } })
        .catch(() => null)
    : null;
  const row =
    picked ??
    (await prisma.teamMember
      .findFirst({ where: { creativeManager: true, active: true }, select: { id: true, name: true } })
      .catch(() => null));
  if (!row) return null;
  // A DESIGNATED reviewer can rule with any active login since Sep 25 (§8.1,
  // lib/reviewerAssignment.canRuleOnCuts); somebody named only by the flag
  // still needs owner/admin, because the flag grants nothing.
  const login = await prisma.appUser
    .findFirst({
      where: { teamMemberId: row.id, status: "ACTIVE", ...(picked ? {} : { role: { in: ["OWNER", "ADMIN"] } }) },
      select: { id: true },
    })
    .catch(() => null);
  return { id: row.id, name: row.name, from: picked ? "designated" : "creative-manager-flag", canApprove: !!login };
}

export async function opsExceptionsBoard(opts: { now?: Date; includeTest?: boolean } = {}): Promise<OpsExceptionBoard> {
  const now = (opts.now ?? new Date()).getTime();
  const cap = EXCEPTION_RULES.perKind;
  const excludedClientIds = opts.includeTest === false
    ? (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id)
    : [];
  const clientScope = excludedClientIds.length ? { clientId: { notIn: excludedClientIds } } : {};
  // The roster is read WITH the approver rather than after it: resolving the
  // key an engine wrote on a task ("john", "kim", "cubicasa") to a person costs
  // one read of the team table for the whole card.
  const [approver, roster, coverage, routing] = await Promise.all([
    creativeApprover(),
    listAssignees().catch((): Assignee[] => []),
    // The rota the review clock is measured on (§8.1). Read with the rest; a
    // failed read falls back to the shipped Mon–Fri 9–6.
    import("@/lib/coverage").then((m) => m.coverageRules()).catch(() => ({ weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null })),
    editorRouting(),
  ]);
  const { coveredHoursBetween } = await import("@/lib/coverage");
  const agingCoveredHours = EXCEPTION_RULES.reviewAgingCoveredDays * (coverage.toHour - coverage.fromHour);
  // SAY WHERE THE NAME CAME FROM. A name lifted off a flag that exists for the
  // shoot bonus is a guess wearing a person's face; naming somebody whose login
  // cannot press Approve is worse than naming nobody. Both are said out loud
  // rather than presented as an assignment.
  const verdictOwner = !approver
    ? "The office — nobody is named as creative approver"
    : !approver.canApprove
      ? `${approver.name} — but their login can't approve yet`
      : approver.from === "designated"
        ? approver.name
        : `${approver.name} (from the creative-manager flag — name one in Settings)`;

  // The predicates are hoisted out of the reads so the SAME `where` can be
  // counted. A count only runs for a kind that actually overflowed its cap, so
  // a quiet day costs exactly the five reads it always did. Each capped kind
  // also carries the narrower HIGH predicate beside it — the same rule the row
  // builders below apply in memory, written once in SQL so the header's "worth
  // doing today" can be about the pile rather than about the page.

  // 1. NO SAVED ASSIGNMENT. Read the eligible pool, then apply the same
  // task → project/vendor → routing distinction as the Editing Room. A rule
  // prediction is visible context for Kyle, never proof somebody accepted.
  const unassignedWhere: Prisma.ProjectWhereInput = {
    ...clientScope,
    status: { in: ["SHOT", "EDITING", "REVISION"] },
    // OWED, not merely ordered. This carried half the shared rule — waivedAt
    // and not removedFromOrderAt — so a job whose video line had been PULLED
    // off the Aryeo order could still be listed as "ready for editing with no
    // editor on it". That is the 632 Greenridge Rd shape the removedFromOrderAt
    // flag was invented for: a video chased for a week after the item was taken
    // off the order (Sep 20).
    deliverables: { some: { ...OWED_DELIVERABLE_WHERE, type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
  };

  // 2. WAITING ON A VERDICT. Uploaded, nobody has ruled, and the clock has
  // been running. The editor is finished; this one is the office's.
  const agingReviewWhere: Prisma.ReviewSubmissionWhereInput = {
    status: "PENDING",
    // A FLOOR, not the rule: covered time can never exceed elapsed time, so
    // nothing younger than the covered-hours line can qualify. The rule itself
    // — covered hours since the cut entered review — is applied in memory.
    createdAt: { lt: new Date(now - agingCoveredHours * HOUR) },
    // Waiting on the EDITOR's check is not waiting on a verdict (§8.2): only a
    // checked cut, or one from before the gate, is the reviewer's to answer
    // for. Same test as selfCheck.awaitingReviewWhere, on the columns.
    AND: [{ OR: [{ selfCheckedAt: { not: null } }, { selfCheckId: null }] }],
    // A DELIVERED job's still-PENDING cut is not a work list — the client
    // already has the video (131 Woodcutter sat in the queue for days after
    // delivery). The Review Room decided that twice, in reviewRoom.ts and in
    // videoReviewBoard, and this query had never been told: on Sep 20 all seven
    // rows it found were cuts on jobs that had already shipped, so the card
    // chased verdicts the Review Room itself refuses to show.
    //
    // ONE CASE IS PARKED FOR JORDAN, not solved here: a MONTHLY batch is one
    // project carrying many videos, and if such a job is marked DELIVERED while
    // videos 2..N are still owed, a genuinely pending cut on it stops raising an
    // exception. Five of the seven rows this filter dropped are cuts of one
    // monthly job (August 2026 Social Content, delivered Sep 3). It is left as
    // it stands because all three surfaces now agree and the work is still on
    // the editor's card and in the Editing Room — and because the carve-out
    // would mean a second copy of MONTHLY_PLAN_RE written in SQL, which is the
    // same drift that put half of OWED_DELIVERABLE_WHERE in the query above.
    project: { status: { notIn: ["DELIVERED", "CANCELLED", "ON_HOLD"] }, ...clientScope },
  };

  // 3. A CHASE DATE THAT PASSED. SmartTask.followUpAt is the date somebody
  // set for coming back to it; a date in the past with the task still open is
  // a promise to oneself that was not kept.
  const followUpWhere: Prisma.SmartTaskWhereInput = {
    followUpAt: { lt: new Date(now) },
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    // A PARKED JOB IS NOT A BROKEN PROMISE (journey drill, Sep 20). The office
    // puts a job on hold precisely so nobody chases it, and a cancelled one is
    // over — escalating either to "high, 5 days, clear the blocker or move the
    // date" asks for work the hub itself has decided not to do, on a card whose
    // whole worth is that everything on it is genuinely wrong. Same idiom as
    // the aging-verdict rule above, and the same list minus DELIVERED: an
    // unanswered promise on a shipped job is still an unanswered promise.
    // A task with no job at all (a personal to-do) is nobody's hold, so it
    // stays — a bare relation filter would silently drop every one of them.
    OR: [{ projectId: null }, { project: { is: { status: { notIn: ["ON_HOLD", "CANCELLED"] } } } }],
    ...(excludedClientIds.length ? { AND: [
      { OR: [{ clientId: null }, { clientId: { notIn: excludedClientIds } }] },
      { OR: [{ projectId: null }, { project: { is: clientScope } }] },
    ] } : {}),
  };
  // High = three days past the date somebody set, as the row builder has it.
  const followUpHighWhere: Prisma.SmartTaskWhereInput = {
    ...followUpWhere,
    followUpAt: { lt: new Date(now - 3 * DAY) },
  };

  // 5. AN APPROVED REPLACEMENT NOBODY SENT. Approved, not sent, and an EARLIER
  // round on the same cut did go out — so the client is holding a version we
  // have already replaced. This is the R03 shape, on a card rather than
  // waiting to be noticed.
  const unsentWhere: Prisma.ReviewSubmissionWhereInput = {
    ...(excludedClientIds.length ? { project: clientScope } : {}),
    status: "APPROVED",
    sentToClientAt: null,
    decidedAt: { lt: new Date(now - EXCEPTION_RULES.unsentDays * DAY) },
  };

  const [assignmentCandidates, agingRows, followUpRows, liveRenders, unsentRows] = await Promise.all([
    prisma.project.findMany({
      where: unassignedWhere,
      select: {
        id: true, title: true, status: true, shootDate: true, deliveryDue: true, updatedAt: true,
        editorManual: true, editorId: true, editorVendorKey: true, editor: { select: { name: true } },
        deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
        smartTasks: { where: { taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { taskType: true, assignedKey: true, assignedManually: true }, orderBy: { updatedAt: "desc" } },
      },
      orderBy: { deliveryDue: "asc" },
    }),
    prisma.reviewSubmission.findMany({
      where: agingReviewWhere,
      select: {
        id: true, projectId: true, round: true, createdAt: true, fileName: true, project: { select: { title: true } },
        reviewerTeamMemberId: true, selfCheckedAt: true,
      },
      orderBy: { createdAt: "asc" },
      // The WHOLE pool under the ceiling, like the unsent read below: the
      // covered-hours rule runs in memory, so a capped read would hide rows
      // rather than page them. PENDING cuts on live jobs are a small pool.
      take: SAFETY_CEILING,
    }),
    prisma.smartTask.findMany({
      where: followUpWhere,
      // assignedKey comes back too: it is rule ONE of how this hub says who
      // owns a task (opsDay.ts), and reading only ownerId is how four edit
      // cards the system had handed to John and Kim were about to be announced
      // as nobody's (Sep 20).
      select: {
        id: true, title: true, followUpAt: true, blockedReason: true, projectId: true,
        assignedKey: true, owner: { select: { name: true } },
      },
      orderBy: { followUpAt: "asc" },
      take: cap + 1,
    }),
    // 4. STUCK AT THE PROVIDER. A render holding a commitment with no movement.
    // `saving` is included: that is our own Dropbox copy, and a stuck one still
    // means a finished video nobody can send. The live rows are read and the age
    // measured below, because the age cannot be expressed in the query — the
    // live queue is bounded by the render caps (15 a day, 90 a month) and there
    // are none at all today, so the ceiling below is a seatbelt, not a page.
    prisma.topazJob.findMany({
      where: {
        ...(excludedClientIds.length ? { project: clientScope } : {}),
        state: { in: ["queued", "estimated", "uploading", "processing", "saving"] },
        // A job parked ON PURPOSE is not a job stuck at the provider. hold()
        // pushes nextAttemptAt up to six hours out when the daily or monthly
        // render cap or the credit ceiling refuses one, and claimTopazJobs
        // deliberately skips it until then — so the row goes quiet by design and
        // the old test read that silence as a failure, with "try the pass again"
        // as the advice, which would only hit the same cap (Sep 20). Same gate
        // the driver claims by.
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lt: new Date(now) } }],
        // A coarse floor only: nothing created inside the window can be stale by
        // any clock. The real age is computed from the driver's own fields.
        createdAt: { lt: new Date(now - EXCEPTION_RULES.renderStalledHours * HOUR) },
      },
      select: {
        id: true, projectId: true, state: true, error: true,
        createdAt: true, acceptedAt: true, startedAt: true, savingStartedAt: true,
        project: { select: { title: true } },
      },
      orderBy: { createdAt: "asc" },
      take: SAFETY_CEILING, // oldest first, so an overflow would keep the stalest
    }),
    prisma.reviewSubmission.findMany({
      where: unsentWhere,
      select: {
        id: true, projectId: true, round: true, decidedAt: true, deliverableId: true, slot: true,
        project: { select: { title: true } },
      },
      orderBy: { decidedAt: "asc" },
      // NOT the cap of four, deliberately. This used to preselect twelve rows
      // and run the earlier-send test INSIDE the sample, which is a different
      // and worse failure than a visible cap: the category could render ZERO
      // while a real unsent replacement sat outside the window. And with
      // decidedAt ascending the row that fell out was the NEWEST one — the
      // version the client is most likely still waiting on (Sep 20). So the
      // whole pool is read and filtered, under the blunt safety ceiling only.
      // It is a monotonic pool — nothing ever retires a never-sent approval —
      // and it stands at 11 today against a ceiling of 200.
      take: SAFETY_CEILING,
    }),
  ]);

  // THE DRIVER'S OWN CLOCK, not @updatedAt. updatedAt moves on every lease,
  // release and backoff — and again when the merge feature rewrites a job's
  // projectId — so it answers "when did anything touch this row", never "how
  // long has this render been going". stepProcessing and stepSaving measure
  // from these fields (topazJobs.ts), and this board measures from the same
  // ones so the two can never tell different stories about one render.
  const renderClock = (j: { savingStartedAt: Date | null; acceptedAt: Date | null; startedAt: Date | null; createdAt: Date }) =>
    j.savingStartedAt ?? j.acceptedAt ?? j.startedAt ?? j.createdAt;
  const stalledAll = liveRenders
    .filter((j) => now - renderClock(j).getTime() >= EXCEPTION_RULES.renderStalledHours * HOUR)
    .sort((a, b) => renderClock(a).getTime() - renderClock(b).getTime());

  // The earlier-send test, in one query rather than one per row — and over
  // EVERY candidate, not a sample of them.
  const candidates = unsentRows.filter((s) => s.deliverableId != null);
  const cutKey = (s: { projectId: string; deliverableId: string | null; slot: number | null }) =>
    `${s.projectId}|${s.deliverableId ?? "-"}|${s.slot ?? 0}`;
  const qualifying: { s: (typeof candidates)[number]; priorRound: number }[] = [];
  if (candidates.length) {
    const sentBefore = await prisma.reviewSubmission.findMany({
      where: {
        projectId: { in: [...new Set(candidates.map((s) => s.projectId))] },
        sentToClientAt: { not: null },
      },
      select: { projectId: true, deliverableId: true, slot: true, round: true },
    });
    for (const s of candidates) {
      const key = cutKey(s);
      // The NEWEST round the client actually has. Taking the first earlier round
      // the database happened to return could tell them they are sitting on
      // version 1 when version 3 is the one we sent (Sep 20).
      const priorRound = sentBefore
        .filter((p) => cutKey(p) === key && (p.round ?? 0) < s.round)
        .reduce((hi, p) => Math.max(hi, p.round ?? 0), -1);
      if (priorRound < 0) continue; // nothing earlier went out → not a replacement
      qualifying.push({ s, priorRound });
    }
  }

  // The follow-up pool is capped in SQL, so count it only when over-fetch
  // proves overflow. Assignment gaps are filtered from the eligible pool
  // below and counted from those exact rows.
  const overflowed = {
    followUp: followUpRows.length > cap,
  };
  // WAITING ON A VERDICT, by covered hours (§8.1, Sep 25). The clock starts
  // when the cut ENTERED review — the editor's self-check where there is one,
  // the upload otherwise — and counts only time somebody was on shift. The
  // whole pool was read, so these ARE the pile, not a page of it.
  const reviewClock = (r: { createdAt: Date; selfCheckedAt: Date | null }) => r.selfCheckedAt ?? r.createdAt;
  const coveredWait = (r: { createdAt: Date; selfCheckedAt: Date | null }) => coveredHoursBetween(reviewClock(r), new Date(now), coverage);
  const agingQualified = agingRows
    .map((r) => ({ r, hours: coveredWait(r) }))
    .filter((x) => x.hours >= agingCoveredHours)
    .sort((a, b) => b.hours - a.hours);
  const agingIsHigh = (hours: number) => hours >= agingCoveredHours * 2;
  const reviewerName = new Map(
    (
      await prisma.teamMember
        .findMany({
          where: { id: { in: [...new Set(agingQualified.map((x) => x.r.reviewerTeamMemberId).filter((x): x is string => !!x))] } },
          select: { id: true, name: true },
        })
        .catch(() => [] as { id: string; name: string }[])
    ).map((t) => [t.id, t.name]),
  );
  const assignmentGaps = assignmentCandidates.map((p) => {
    const task = p.smartTasks.find((t) => t.taskType === "edit_video" && t.assignedKey)
      ?? p.smartTasks.find((t) => t.taskType === "revision" && t.assignedKey)
      ?? null;
    const manuallyUnassigned = p.smartTasks.some((t) => t.assignedManually && !t.assignedKey);
    const video = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    return { project: p, assignment: resolveEditorAssignment({
      taskKey: task?.assignedKey, taskUnassignedManually: manuallyUnassigned,
      projectEditorName: p.editor?.name, projectVendorKey: p.editorVendorKey,
      projectManual: p.editorManual && !p.editorId,
      deliverableType: video?.type, deliverableLabel: video?.label,
      monthly: isMonthlyContentJob(p.deliverables), rules: routing,
    }) };
  }).filter((x) => x.assignment.state !== "assigned");
  const unassignedRows = assignmentGaps.slice(0, cap + 1);
  const [agingAll, agingHigh, followUpAll, followUpHigh] = await Promise.all([
    agingQualified.length,
    agingQualified.filter((x) => agingIsHigh(x.hours)).length,
    overflowed.followUp ? prisma.smartTask.count({ where: followUpWhere }) : followUpRows.length,
    overflowed.followUp
      ? prisma.smartTask.count({ where: followUpHighWhere })
      : followUpRows.filter((t) => ageOf(t.followUpAt, now) >= 3).length,
  ]);

  const out: OpsException[] = [];

  for (const { project: p, assignment } of unassignedRows.slice(0, cap)) {
    out.push({
      id: `unassigned:${p.id}`,
      kind: "unassigned",
      severity: p.deliveryDue && p.deliveryDue.getTime() < now ? "high" : "medium",
      title: streetOf(p.title),
      why: assignment.state === "predicted"
        ? `Routing suggests ${assignment.name}, but no assignment was saved${p.deliveryDue && p.deliveryDue.getTime() < now ? " and the due date passed" : ""}`
        : p.deliveryDue && p.deliveryDue.getTime() < now
          ? "Ready for editing, past its date, and no editor on it"
          : "Ready for editing with no editor on it",
      owner: "Kyle",
      nextAction: assignment.state === "predicted" ? "Confirm or change the suggested editor in the Editing Room" : "Pick an editor in the Editing Room",
      href: `/edit/${p.id}`,
      ageDays: ageOf(p.shootDate ?? p.updatedAt, now),
    });
  }

  for (const { r, hours } of agingQualified.slice(0, cap)) {
    // THE ROW'S OWN REVIEWER (§8.1): the one person the cut is waiting on.
    // The board-wide approver label is only for a cut nobody holds — one that
    // entered review before the chain existed, or while all three were away.
    const holder = r.reviewerTeamMemberId ? reviewerName.get(r.reviewerTeamMemberId) ?? null : null;
    const coveredDays = Math.floor(hours / Math.max(1, coverage.toHour - coverage.fromHour));
    out.push({
      id: `review:${r.id}`,
      kind: "aging-review",
      severity: agingIsHigh(hours) ? "high" : "medium",
      title: streetOf(r.project?.title),
      why: `Version ${r.round} has waited ${coveredDays} covered day${coveredDays === 1 ? "" : "s"} (${Math.floor(hours)} covered hours) for a verdict`,
      owner: holder ?? verdictOwner,
      nextAction: holder
        ? `${holder.split(/\s+/)[0]} to rule on it in the Review Room — or take it over on the job's edit page`
        : "Watch it and approve or send it back in the Review Room",
      href: `/edit/${r.projectId}`,
      ageDays: ageOf(reviewClock(r), now),
    });
  }

  // WHO IT IS ON, by the rule the rest of the hub uses (opsDay.ts): the
  // assignedKey a human or an engine wrote first, the ownerId the routers file
  // work to second, "nobody yet" only when there is genuinely neither. On this
  // board "nobody yet" is the sentence that starts somebody chasing, so printing
  // it over a named editor is not a cosmetic slip.
  //
  // The key is resolved against the roster, and a key the roster does not know
  // is TIDIED rather than printed raw: assigneeName hands back the stored slug
  // for anyone who has left, and retired keys live on historical tasks for good
  // (luma 34, remar 12, external_agency 5). A row reading "luma — Clear the
  // blocker" looks like the card is broken. The same tidy covers the case where
  // the roster read itself failed and every key would otherwise degrade at once.
  const ownerOfTask = (t: { assignedKey: string | null; owner: { name: string } | null }) => {
    if (!t.assignedKey) return t.owner?.name ?? "Nobody yet";
    const name = assigneeName(t.assignedKey, roster);
    return name === t.assignedKey ? prettyKey(t.assignedKey) : name;
  };

  for (const t of followUpRows.slice(0, cap)) {
    out.push({
      id: `followup:${t.id}`,
      kind: "overdue-followup",
      severity: ageOf(t.followUpAt, now) >= 3 ? "high" : "medium",
      title: t.title.slice(0, 90),
      why: t.blockedReason
        ? `Follow-up was due ${ageOf(t.followUpAt, now)} days ago — blocked: ${t.blockedReason}`
        : `Follow-up was due ${ageOf(t.followUpAt, now)} days ago`,
      owner: ownerOfTask(t),
      nextAction: t.blockedReason ? "Clear the blocker or move the date" : "Do it, or set a new date",
      href: t.projectId ? `/projects/${t.projectId}` : "/tasks",
      ageDays: ageOf(t.followUpAt, now),
    });
  }

  for (const j of stalledAll.slice(0, cap)) {
    const hours = Math.floor((now - renderClock(j).getTime()) / HOUR);
    out.push({
      id: `render:${j.id}`,
      kind: "stalled-render",
      severity: hours >= 24 ? "high" : "medium",
      title: streetOf(j.project?.title),
      why: j.error
        ? `The 1080p pass has not moved in ${hours}h — ${j.error.slice(0, 90)}`
        : `The 1080p pass has been "${j.state}" for ${hours}h`,
      owner: "Kyle",
      nextAction: "Try the pass again on the Ready-to-send row, or send the editor's export",
      href: `/edit/${j.projectId}`,
      ageDays: Math.floor(hours / 24),
    });
  }

  for (const { s, priorRound } of qualifying.slice(0, cap)) {
    out.push({
      id: `unsent:${s.id}`,
      kind: "unsent-replacement",
      severity: "high",
      title: streetOf(s.project?.title),
      why: `Version ${s.round} was approved ${ageOf(s.decidedAt, now)} days ago and the client still has version ${priorRound}`,
      owner: "Kyle",
      nextAction: "Send it and press Mark as sent",
      href: `/edit/${s.projectId}`,
      ageDays: ageOf(s.decidedAt, now),
    });
  }

  // 6. A 1080p FILE HELD FOR A LISTEN (O02, Sep 25 2026). The pass finished
  // and its file could not be checked, so it was NOT filed as the deliverable
  // and nobody was told to send it — it waits in Dropbox for a person. Nothing
  // retries it (the driver never claims a held job), so without this row a
  // held video would wait silently: the ready card lists it, but only while
  // somebody is looking at that card. Its own read, kept out of the batch above
  // so this kind stays one self-contained block; the pool is tiny (a hold needs
  // three failed reads of Topaz AND a failed read of Dropbox).
  const heldRenders = await prisma.topazJob
    .findMany({
      where: { state: "held", ...(excludedClientIds.length ? { project: clientScope } : {}) },
      select: {
        id: true, projectId: true, heldAt: true, createdAt: true,
        project: { select: { title: true } },
        submission: { select: { round: true, reviewerTeamMemberId: true } },
      },
      orderBy: { heldAt: "asc" },
      take: SAFETY_CEILING,
    })
    .catch(() => []);
  const heldReviewer = new Map(
    (
      await prisma.teamMember
        .findMany({
          where: { id: { in: [...new Set(heldRenders.map((j) => j.submission?.reviewerTeamMemberId).filter((x): x is string => !!x))] } },
          select: { id: true, name: true },
        })
        .catch(() => [] as { id: string; name: string }[])
    ).map((t) => [t.id, t.name]),
  );
  const heldHours = (j: { heldAt: Date | null; createdAt: Date }) => Math.max(0, Math.floor((now - (j.heldAt ?? j.createdAt).getTime()) / HOUR));
  for (const j of heldRenders.slice(0, cap)) {
    const hours = heldHours(j);
    const reviewer = j.submission?.reviewerTeamMemberId ? heldReviewer.get(j.submission.reviewerTeamMemberId) ?? null : null;
    out.push({
      id: `held:${j.id}`,
      kind: "unverified-render",
      // An approved video the client is owed and nobody can send: a day of
      // that is worth doing today.
      severity: hours >= 24 ? "high" : "medium",
      title: streetOf(j.project?.title),
      why: `Version ${j.submission?.round ?? "?"} came back from the 1080p pass but its sound couldn't be verified, so it hasn't gone to Kyle`,
      // The creative reviewer's call — whoever reviewed this cut, else the
      // board's approver line (which says out loud when nobody is named).
      owner: reviewer ?? verdictOwner,
      nextAction: "Listen to the 1080p file or keep the original",
      href: "/#video-review",
      ageDays: Math.floor(hours / 24),
    });
  }

  // 7. A CLIENT'S LIBRARY THAT WILL NOT REBUILD (A42, Sep 25 2026). The hourly
  // repair (contentVideos.verifyApprovedCutsInLibrary) rebuilds a client whose
  // approved program cut is not on their library, and writes the failure on
  // the enrollment when the rebuild throws or still leaves it out. It retries
  // every hour and clears itself when it works — so a row here has already
  // survived at least one retry. One row per client; its own small read.
  const libraryFailures = await prisma.contentEnrollment
    .findMany({
      where: { librarySyncFailedAt: { not: null }, ...clientScope },
      select: { id: true, clientId: true, librarySyncFailedAt: true, librarySyncError: true },
      orderBy: { librarySyncFailedAt: "asc" },
      take: SAFETY_CEILING,
    })
    .catch(() => []);
  const libraryHours = (e: { librarySyncFailedAt: Date | null }) => Math.max(0, Math.floor((now - (e.librarySyncFailedAt?.getTime() ?? now)) / HOUR));
  // Client names for the two program kinds below. ContentEnrollment.clientId is
  // a plain reference (no relation), so the names are one small read per kind.
  const programClientName = new Map<string, string>();
  const nameClients = async (ids: string[]) => {
    const want = ids.filter((id) => id && !programClientName.has(id));
    if (!want.length) return;
    for (const c of await prisma.client.findMany({ where: { id: { in: want } }, select: { id: true, name: true } }).catch(() => [] as { id: string; name: string }[])) programClientName.set(c.id, c.name);
  };
  await nameClients(libraryFailures.map((e) => e.clientId));
  for (const e of libraryFailures.slice(0, cap)) {
    const hours = libraryHours(e);
    out.push({
      id: `library:${e.id}`,
      kind: "library-missing",
      // An approved video the client cannot see: a day of that is today's work.
      severity: hours >= 24 ? "high" : "medium",
      title: programClientName.get(e.clientId) ?? "A program client",
      why: (e.librarySyncError ?? "The client's video library couldn't be rebuilt").slice(0, 160),
      owner: "Kyle",
      nextAction: "Check the client's video list; the hub retries every hour — if it's still here tomorrow, tell Jordan",
      href: `/content/${e.id}?tab=production&view=videos`,
      ageDays: Math.floor(hours / 24),
    });
  }

  // 8. OLD LIBRARY FILES NOBODY HAS VOUCHED FOR (legacy identity, Sep 25 2026).
  // A delivered file still on a positional Aryeo key (aryeo:<listing>:<n>) whose
  // pairing no person has confirmed — the rows the Library tab flags "unverified
  // legacy row" (workspaceData, same test). They cannot drift any more
  // (portalLibrary keys by video id now), but which video each one IS was
  // never proved; the identity tool on that tab settles it. One row per client.
  // The positional shape is tested on the PortalVideo's CURRENT key, as the
  // Library tab does: a row re-keyed by URL (portalLibrary.rekeyIndexedLibraryRows)
  // is settled even while its old source row lingers.
  const LEGACY_KEY = /^aryeo:[^:]+:\d+$/;
  const excludedEnrollmentIds = excludedClientIds.length
    ? (await prisma.contentEnrollment.findMany({ where: { clientId: { in: excludedClientIds } }, select: { id: true } })).map((e) => e.id)
    : [];
  const positional = (
    await prisma.portalVideo
      .findMany({ where: { source: "aryeo", externalKey: { startsWith: "aryeo:" }, ...(excludedEnrollmentIds.length ? { enrollmentId: { notIn: excludedEnrollmentIds } } : {}) }, select: { id: true, externalKey: true }, take: 5_000 })
      .catch(() => [] as { id: string; externalKey: string }[])
  ).filter((r) => LEGACY_KEY.test(r.externalKey));
  const legacySources = positional.length
    ? (await prisma.contentVideoSource
        .findMany({ where: { kind: "PORTAL_VIDEO", confirmedAt: null, portalVideoId: { in: positional.map((r) => r.id) } }, select: { videoId: true, ref: true, portalVideoId: true, matchBasis: true, createdAt: true } })
        .catch(() => [])).filter((x) => x.matchBasis !== "staff" && positional.some((r) => r.id === x.portalVideoId && r.externalKey === x.ref))
    : [];
  const legacyVideos = legacySources.length
    ? new Map(
        (await prisma.contentVideo
          .findMany({ where: { id: { in: [...new Set(legacySources.map((x) => x.videoId))] }, status: { not: "ARCHIVED" }, ...clientScope }, select: { id: true, enrollmentId: true } })
          .catch(() => [] as { id: string; enrollmentId: string }[])).map((v) => [v.id, v.enrollmentId]),
      )
    : new Map<string, string>();
  const legacyByEnrollment = new Map<string, { count: number; since: Date }>();
  for (const x of legacySources) {
    const enrollmentId = legacyVideos.get(x.videoId);
    if (!enrollmentId) continue;
    const g = legacyByEnrollment.get(enrollmentId) ?? { count: 0, since: x.createdAt };
    g.count++;
    if (x.createdAt < g.since) g.since = x.createdAt;
    legacyByEnrollment.set(enrollmentId, g);
  }
  const legacyEnrollments = legacyByEnrollment.size
    ? await prisma.contentEnrollment.findMany({ where: { id: { in: [...legacyByEnrollment.keys()] } }, select: { id: true, clientId: true } }).catch(() => [] as { id: string; clientId: string }[])
    : [];
  await nameClients(legacyEnrollments.map((e) => e.clientId));
  const legacyRows = [...legacyByEnrollment.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [enrollmentId, g] of legacyRows.slice(0, cap)) {
    out.push({
      id: `legacy:${enrollmentId}`,
      kind: "legacy-identity",
      // History, not a live fault: the client already has these files.
      severity: "medium",
      title: programClientName.get(legacyEnrollments.find((e) => e.id === enrollmentId)?.clientId ?? "") ?? "A program client",
      why: `${g.count} older delivered file${g.count === 1 ? " is" : "s are"} tied to a video by list position only, and nobody has confirmed which`,
      owner: "Kyle",
      nextAction: "Open the client's video list and confirm or relink each flagged file",
      href: `/content/${enrollmentId}?tab=production&view=videos`,
      ageDays: ageOf(g.since, now),
    });
  }

  // 9. REOPENED WORK (A52, Sep 25 2026). A job that went out and came back is
  // either dated — a client round's 48 business hours, the same business day
  // for anything else reopened, or a date a person set — and then past it is
  // late; or nothing dates it (reopened before the clock existed, or by a path
  // with no timestamp), and then somebody owns dating it. Both are here.
  // Overdue first: that is work owed now. Read whole under the ceiling — the
  // pool is jobs currently reopened, a handful.
  const reopened = await import("@/lib/deliveryBoard")
    .then((m) => m.reopenedWork({ now: new Date(now), excludeClientIds: excludedClientIds }))
    .then((rows) => rows.filter((r) => r.overdue || r.due.undated))
    .catch(() => [] as import("@/lib/deliveryBoard").ReopenedWorkRow[]);
  {
    const { etDateTime } = await import("@/lib/datetime");
    const holderName = (key: string | null) => {
      if (!key) return "Kyle";
      const name = assigneeName(key, roster);
      return name === key ? prettyKey(key) : name;
    };
    const ordered = [...reopened].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due.at?.getTime() ?? 0) - (b.due.at?.getTime() ?? 0));
    for (const r of ordered.slice(0, cap)) {
      if (r.overdue && r.due.at) {
        out.push({
          id: `reopened:${r.projectId}`,
          kind: "reopened-work",
          severity: "high",
          title: streetOf(r.title),
          why: `Reopened work was due ${etDateTime(r.due.at)} (${r.due.words ?? "its own date"})`,
          owner: holderName(r.holderKey),
          nextAction: "Finish it and send it back, or move the due date on the job's edit page",
          href: `/edit/${r.projectId}`,
          ageDays: ageOf(r.due.at, now),
        });
      } else {
        out.push({
          id: `reopened:${r.projectId}`,
          kind: "reopened-work",
          severity: "medium",
          title: streetOf(r.title),
          why: r.reopenedAt
            ? `Reopened ${etDateTime(r.reopenedAt)} with no due date`
            : "Reopened after delivery with no due date",
          owner: "Kyle",
          nextAction: "Set its due date on the job's edit page",
          href: `/edit/${r.projectId}`,
          ageDays: ageOf(r.reopenedAt ?? r.deliveredAt, now),
        });
      }
    }
  }

  // 10–12. WHAT THE ORDER ACTUALLY ASKED FOR (§10 AU-01, Sep 26 2026). Its own
  // function below; a failed read costs these three kinds, never the board.
  const scope = await orderScopeExceptions({ now: new Date(now), cap, excludeClientIds: excludedClientIds }).catch((e: unknown) => {
    console.warn("orderScopeExceptions failed", (e as Error).message);
    return null;
  });
  if (scope) out.push(...scope.rows);

  // 13. AUTOHDR BATCHES (§10 A53, Sep 26 2026): a batch that came back short
  // or never came back past the vendor's two days, or a raw folder that looks
  // uploaded twice. Built in photoEditBatches.ts; a failed read costs this
  // kind, never the board.
  const photoBatches = await import("@/lib/photoEditBatches")
    .then((m) => m.photoBatchExceptionRows({ now: new Date(now), cap, excludeClientIds: excludedClientIds }))
    .catch(() => null);
  if (photoBatches) out.push(...photoBatches.rows);

  // 14. PROMISES AT RISK (AU-24 / F5, Sep 26 2026): something owed to a client
  // inside a day of its recorded promise, or past it, with no client update
  // drafted for that promise. Built in atRiskUpdates.ts; drafting is a button
  // on Tasks → Comms (the AI runs on the click, never here).
  const atRisk = await import("@/lib/atRiskUpdates")
    .then((m) => m.atRiskExceptionRows({ now: new Date(now), cap, excludeClientIds: excludedClientIds }))
    .catch(() => null);
  if (atRisk) out.push(...atRisk.rows);

  return {
    // High first, then oldest. A list somebody reads top to bottom.
    rows: out.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
      return b.ageDays - a.ageDays;
    }),
    totals: {
      unassigned: { all: assignmentGaps.length, high: assignmentGaps.filter((x) => x.project.deliveryDue && x.project.deliveryDue.getTime() < now).length },
      "aging-review": { all: agingAll, high: agingHigh },
      "overdue-followup": { all: followUpAll, high: followUpHigh },
      // These two are never truncated by SQL, so the rows in hand ARE the pile.
      "stalled-render": {
        all: stalledAll.length,
        high: stalledAll.filter((j) => now - renderClock(j).getTime() >= 24 * HOUR).length,
      },
      "unsent-replacement": { all: qualifying.length, high: qualifying.length },
      // Read whole (under the ceiling), so this is the pile too.
      "unverified-render": { all: heldRenders.length, high: heldRenders.filter((j) => heldHours(j) >= 24).length },
      "library-missing": { all: libraryFailures.length, high: libraryFailures.filter((e) => libraryHours(e) >= 24).length },
      "legacy-identity": { all: legacyByEnrollment.size, high: 0 },
      "reopened-work": { all: reopened.length, high: reopened.filter((r) => r.overdue).length },
      "unmapped-scope": scope?.totals["unmapped-scope"] ?? { all: 0, high: 0 },
      "other-output": scope?.totals["other-output"] ?? { all: 0, high: 0 },
      "missing-prerequisite": scope?.totals["missing-prerequisite"] ?? { all: 0, high: 0 },
      "photo-batch": photoBatches?.total ?? { all: 0, high: 0 },
      "at-risk-promise": atRisk?.total ?? { all: 0, high: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// ORDER SCOPE (§10 AU-01 / H1 / B1, Sep 26 2026).
//
// Settings → Products is the authority for what a product produces, and the
// sync obeys it. What nobody could see was the per-ORDER case: a live job
// carrying a product nobody has mapped is parsed from its name by the keyword
// fallback, and anything the fallback cannot place becomes an OTHER row that no
// lane owns. Both happened silently. Three kinds, all computed on each read and
// stored nowhere, so a re-import can never duplicate them and mapping the
// product clears its row on the next read:
//
//   unmapped-scope        a product title on a live order that neither the
//                         hand-set map nor the static map covers — one row per
//                         TITLE, listing the jobs, because the fix is one
//                         mapping, not one per job.
//   other-output          an owed OTHER row on a live job whose product IS
//                         mapped (a human chose "Other", e.g. Lot Lines) or has
//                         no product at all — the unmapped ones are already the
//                         row above, and a special correction the hub already
//                         tracks (an open asset task on that category) is
//                         that task's, not a second item.
//   missing-prerequisite  a MAPPED product whose owner-set list (Product.
//                         prerequisitesJson) the job does not meet yet.
//
// Live = booked through in revision, not on hold (a parked job is nobody's to
// chase, the rule every kind above keeps) and not an order Aryeo has lost.
// Nothing here blocks anything or writes anything.
// ---------------------------------------------------------------------------
const SCOPE_LIVE_STATUSES = ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] as const;
const SCOPE_IN_PRODUCTION = new Set(["SHOT", "EDITING", "REVIEW", "REVISION"]);
/** Lines that are money or logistics, not work: they produce nothing to map. */
const FEE_LINE_RE = /\b(fees?|tip|gratuity|discount|surcharge|coupon|deposit|tax|travel|mileage|reschedul\w*|cancell?ation)\b/i;
/** "2D Floorplan - Moved to Order #1611" is a negation (aryeo.ts MOVED_TO_ORDER_RE). */
const MOVED_LINE_RE = /moved\s+to\s+order/i;
/** A seatbelt on the live-job read. Live jobs number in the low hundreds; the
 *  read is whole under this so the totals are the pile, not a page. */
const SCOPE_CEILING = 1_000;

type ScopeKind = "unmapped-scope" | "other-output" | "missing-prerequisite";

export async function orderScopeExceptions(opts: { now?: Date; cap?: number; excludeClientIds?: string[] } = {}): Promise<{
  rows: OpsException[];
  totals: Record<ScopeKind, ExceptionTotal>;
}> {
  const now = (opts.now ?? new Date()).getTime();
  const cap = opts.cap ?? EXCEPTION_RULES.perKind;
  const { isMapped, loadManualProductMap } = await import("@/lib/integrations/aryeo");
  const { PREREQUISITES, missingPrerequisites, parsePrerequisites, DISCOVERY_DONE_STATES } = await import("@/lib/productPrerequisites");
  // FRESH, not the five-minute cache: the row's whole promise is "map it and it
  // goes", and the save lands in another lambda. One small read.
  await loadManualProductMap(true);

  const projects = await prisma.project.findMany({
    where: { status: { in: [...SCOPE_LIVE_STATUSES] }, aryeoMissingAt: null, ...(opts.excludeClientIds?.length ? { clientId: { notIn: opts.excludeClientIds } } : {}) },
    select: {
      id: true, title: true, status: true, createdAt: true, clientId: true,
      shootDate: true, addressLine: true, lat: true, lng: true, photographerId: true, reelScript: true, reelHook: true,
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      deliverables: { where: { ...OWED_DELIVERABLE_WHERE, type: "OTHER" }, select: { label: true, productTitle: true } },
    },
    orderBy: { createdAt: "asc" },
    take: SCOPE_CEILING,
  });

  const mappedMemo = new Map<string, boolean>();
  const known = (title: string) => {
    const k = title.trim();
    let v = mappedMemo.get(k);
    if (v === undefined) { v = isMapped(k); mappedMemo.set(k, v); }
    return v;
  };
  const work = (title: string) => !FEE_LINE_RE.test(title) && !MOVED_LINE_RE.test(title);

  // ---- 10. unmapped-scope: one row per title --------------------------------
  const byTitle = new Map<string, { title: string; jobs: typeof projects }>();
  for (const p of projects) {
    const seen = new Set<string>();
    for (const it of p.orderItems) {
      const title = it.title.trim();
      if (!title || seen.has(title) || !work(title) || known(title)) continue;
      seen.add(title);
      const g = byTitle.get(title) ?? { title, jobs: [] };
      g.jobs.push(p);
      byTitle.set(title, g);
    }
  }
  const unmapped = [...byTitle.values()].sort((a, b) => b.jobs.length - a.jobs.length || a.title.localeCompare(b.title));
  const unmappedIsHigh = (g: { jobs: { status: string }[] }) => g.jobs.some((j) => SCOPE_IN_PRODUCTION.has(j.status));
  const productIds = new Map(
    (
      unmapped.length
        ? await prisma.product.findMany({ where: { title: { in: unmapped.slice(0, cap).map((g) => g.title) } }, select: { id: true, title: true } }).catch(() => [])
        : []
    ).map((p) => [p.title, p.id]),
  );
  const rows: OpsException[] = [];
  for (const g of unmapped.slice(0, cap)) {
    const streets = g.jobs.map((j) => streetOf(j.title));
    const shown = streets.slice(0, 3).join(", ") + (streets.length > 3 ? ` and ${streets.length - 3} more` : "");
    const pid = productIds.get(g.title);
    rows.push({
      id: `unmapped:${g.title.toLowerCase()}`,
      kind: "unmapped-scope",
      // Already in production = the guess is already deciding what an editor
      // or photographer owes. Before the shoot there is still time to map it.
      severity: unmappedIsHigh(g) ? "high" : "medium",
      title: `“${g.title.slice(0, 80)}”`,
      why: `On ${g.jobs.length} live job${g.jobs.length === 1 ? "" : "s"} (${shown}) — nobody has said what it produces, so the hub guessed from the name`,
      owner: "Kyle",
      nextAction: "Map it on Settings → Products (what it actually produces), or tell Jordan it is new",
      href: pid ? `/settings/products#${pid}` : "/settings/products",
      ageDays: ageOf(g.jobs.reduce((m, j) => (j.createdAt < m ? j.createdAt : m), g.jobs[0].createdAt), now),
    });
  }

  // ---- 11. other-output: one row per job --------------------------------------
  const otherJobs = projects.filter((p) => p.deliverables.some((d) => !d.productTitle || known(d.productTitle)));
  // A special correction the hub already tracks is that task's (J3,
  // assetDependencies.ts): one owner and one next action per thing, never two.
  const tracked = new Set(
    otherJobs.length
      ? (
          await prisma.smartTask
            .findMany({
              where: {
                projectId: { in: otherJobs.map((p) => p.id) },
                taskType: { in: ["asset_dependency", "asset_interpretation"] },
                deliverableType: "OTHER",
                status: { notIn: ["COMPLETED", "CANCELLED"] },
              },
              select: { projectId: true },
            })
            .catch(() => [] as { projectId: string | null }[])
        ).map((t) => t.projectId)
      : [],
  );
  const other = otherJobs.filter((p) => !tracked.has(p.id));
  const otherIsHigh = (p: { status: string }) => SCOPE_IN_PRODUCTION.has(p.status);
  for (const p of [...other].sort((a, b) => Number(otherIsHigh(b)) - Number(otherIsHigh(a))).slice(0, cap)) {
    const labels = [...new Set(p.deliverables.filter((d) => !d.productTitle || known(d.productTitle)).map((d) => d.productTitle || d.label || "Other"))];
    rows.push({
      id: `other:${p.id}`,
      kind: "other-output",
      severity: otherIsHigh(p) ? "high" : "medium",
      title: streetOf(p.title),
      why: `${labels.slice(0, 3).join(", ")} ${labels.length === 1 ? "is" : "are"} owed, and no lane makes ${labels.length === 1 ? "it" : "them"} — nothing tracks ${labels.length === 1 ? "it" : "them"} until somebody does`,
      owner: "Kyle",
      nextAction: "Decide who makes it and what file it needs, or mark it not required on the job",
      href: `/projects/${p.id}`,
      ageDays: ageOf(p.createdAt, now),
    });
  }

  // ---- 12. missing-prerequisite: one row per job ------------------------------
  const withNeeds = await prisma.product
    .findMany({ where: { prerequisitesJson: { not: null }, mediaTypes: { not: null } }, select: { title: true, prerequisitesJson: true } })
    .catch(() => [] as { title: string; prerequisitesJson: string | null }[]);
  const needsByTitle = new Map(
    withNeeds
      .map((p) => [p.title.toLowerCase().trim(), { title: p.title, keys: parsePrerequisites(p.prerequisitesJson) }] as const)
      .filter(([, v]) => v.keys.length > 0),
  );
  type Missing = { p: (typeof projects)[number]; lines: string[]; soon: boolean };
  const missing: Missing[] = [];
  if (needsByTitle.size) {
    const needing = projects
      .map((p) => ({ p, needs: p.orderItems.map((it) => needsByTitle.get(it.title.toLowerCase().trim())).filter((x): x is NonNullable<typeof x> => !!x) }))
      .filter((x) => x.needs.length > 0);
    const clientIds = [...new Set(needing.filter((x) => x.needs.some((n) => n.keys.includes("brand_discovery"))).map((x) => x.p.clientId))];
    const onboardings = clientIds.length
      ? await prisma.programOnboarding.findMany({ where: { clientId: { in: clientIds } }, select: { clientId: true, status: true, discoveryWaivedAt: true } }).catch(() => [])
      : [];
    const discovery = new Map<string, boolean>();
    for (const o of onboardings) {
      const done = DISCOVERY_DONE_STATES.has(o.status) || !!o.discoveryWaivedAt;
      discovery.set(o.clientId, (discovery.get(o.clientId) ?? false) || done);
    }
    for (const { p, needs } of needing) {
      const facts = {
        shootDate: p.shootDate, addressLine: p.addressLine, lat: p.lat, lng: p.lng, photographerId: p.photographerId,
        reelScript: p.reelScript, reelHook: p.reelHook,
        discoveryDone: discovery.has(p.clientId) ? discovery.get(p.clientId)! : null,
      };
      const lines: string[] = [];
      for (const n of needs) {
        const gaps = missingPrerequisites(n.keys, facts);
        if (gaps.length) lines.push(`${n.title}: ${gaps.map((k) => PREREQUISITES[k].missing).join(", ")}`);
      }
      if (!lines.length) continue;
      // Soon = the shoot is within two days (or has passed): the gap is about
      // to cost something.
      const soon = !!p.shootDate && p.shootDate.getTime() - now <= 2 * DAY;
      missing.push({ p, lines: [...new Set(lines)], soon });
    }
  }
  missing.sort((a, b) => Number(b.soon) - Number(a.soon) || (a.p.shootDate?.getTime() ?? Infinity) - (b.p.shootDate?.getTime() ?? Infinity));
  for (const m of missing.slice(0, cap)) {
    rows.push({
      id: `prereq:${m.p.id}`,
      kind: "missing-prerequisite",
      severity: m.soon ? "high" : "medium",
      title: streetOf(m.p.title),
      why: m.lines.slice(0, 2).join(" · ").slice(0, 200),
      owner: "Kyle",
      nextAction: "Get it in place before it's needed — nothing is blocked; the list is on Settings → Products",
      href: `/projects/${m.p.id}`,
      ageDays: ageOf(m.p.createdAt, now),
    });
  }

  return {
    rows,
    totals: {
      // Read whole under the ceiling, so these are the pile.
      "unmapped-scope": { all: unmapped.length, high: unmapped.filter(unmappedIsHigh).length },
      "other-output": { all: other.length, high: other.filter(otherIsHigh).length },
      "missing-prerequisite": { all: missing.length, high: missing.filter((m) => m.soon).length },
    },
  };
}

/** The rows on their own, for a reader that wants the list and not the tally
 *  (the recon scripts). The dashboard takes the board, because the card has to
 *  be able to say how many it is NOT showing. */
export async function opsExceptions(opts: { now?: Date } = {}): Promise<OpsException[]> {
  return (await opsExceptionsBoard(opts)).rows;
}
