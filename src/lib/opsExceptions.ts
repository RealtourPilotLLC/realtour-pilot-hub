import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assigneeName, listAssignees, type Assignee } from "@/lib/assignees";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";

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
  | "unsent-replacement";

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
};

/** An empty board — what the dashboard shows when the read itself failed. */
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
    },
  };
}

export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  unassigned: "Nobody assigned",
  "aging-review": "Waiting on a verdict",
  "overdue-followup": "Follow-up date passed",
  "stalled-render": "Render stuck at the provider",
  "unsent-replacement": "Approved replacement, not sent",
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
  /** a cut with no verdict after this many days */
  reviewAgingDays: 3,
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
  const login = await prisma.appUser
    .findFirst({ where: { teamMemberId: row.id, role: { in: ["OWNER", "ADMIN"] }, status: "ACTIVE" }, select: { id: true } })
    .catch(() => null);
  return { id: row.id, name: row.name, from: picked ? "designated" : "creative-manager-flag", canApprove: !!login };
}

export async function opsExceptionsBoard(opts: { now?: Date } = {}): Promise<OpsExceptionBoard> {
  const now = (opts.now ?? new Date()).getTime();
  const cap = EXCEPTION_RULES.perKind;
  // The roster is read WITH the approver rather than after it: resolving the
  // key an engine wrote on a task ("john", "kim", "cubicasa") to a person costs
  // one read of the team table for the whole card.
  const [approver, roster] = await Promise.all([creativeApprover(), listAssignees().catch((): Assignee[] => [])]);
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

  // 1. NOBODY ASSIGNED. A job in the editing lane whose editor is neither a
  // person nor the outside shop. The routing rules usually fill this in; a
  // row that reaches here is one they could not.
  const unassignedWhere: Prisma.ProjectWhereInput = {
    status: { in: ["SHOT", "EDITING", "REVISION"] },
    editorId: null,
    editorVendorKey: null,
    // OWED, not merely ordered. This carried half the shared rule — waivedAt
    // and not removedFromOrderAt — so a job whose video line had been PULLED
    // off the Aryeo order could still be listed as "ready for editing with no
    // editor on it". That is the 632 Greenridge Rd shape the removedFromOrderAt
    // flag was invented for: a video chased for a week after the item was taken
    // off the order (Sep 20).
    deliverables: { some: { ...OWED_DELIVERABLE_WHERE, type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
  };
  // High = the delivery date has already gone by. Same test as the row builder.
  const unassignedHighWhere: Prisma.ProjectWhereInput = { ...unassignedWhere, deliveryDue: { lt: new Date(now) } };

  // 2. WAITING ON A VERDICT. Uploaded, nobody has ruled, and the clock has
  // been running. The editor is finished; this one is the office's.
  const agingReviewWhere: Prisma.ReviewSubmissionWhereInput = {
    status: "PENDING",
    createdAt: { lt: new Date(now - EXCEPTION_RULES.reviewAgingDays * DAY) },
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
    project: { status: { notIn: ["DELIVERED", "CANCELLED", "ON_HOLD"] } },
  };
  // High = twice the waiting rule, exactly as the row builder scores it.
  const agingReviewHighWhere: Prisma.ReviewSubmissionWhereInput = {
    ...agingReviewWhere,
    createdAt: { lt: new Date(now - EXCEPTION_RULES.reviewAgingDays * 2 * DAY) },
  };

  // 3. A CHASE DATE THAT PASSED. SmartTask.followUpAt is the date somebody
  // set for coming back to it; a date in the past with the task still open is
  // a promise to oneself that was not kept.
  const followUpWhere: Prisma.SmartTaskWhereInput = {
    followUpAt: { lt: new Date(now) },
    status: { notIn: ["COMPLETED", "CANCELLED"] },
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
    status: "APPROVED",
    sentToClientAt: null,
    decidedAt: { lt: new Date(now - EXCEPTION_RULES.unsentDays * DAY) },
  };

  const [unassignedRows, agingRows, followUpRows, liveRenders, unsentRows] = await Promise.all([
    prisma.project.findMany({
      where: unassignedWhere,
      select: { id: true, title: true, status: true, shootDate: true, deliveryDue: true, updatedAt: true },
      orderBy: { deliveryDue: "asc" },
      // One MORE than we keep — the open-loops idiom (opsDay.ts): the extra row
      // is how we know the list was really truncated, so a viewer with exactly
      // four does not get a "+" and a viewer with nine is not told there are
      // four. Only an overflow pays for the count below.
      take: cap + 1,
    }),
    prisma.reviewSubmission.findMany({
      where: agingReviewWhere,
      select: { id: true, projectId: true, round: true, createdAt: true, fileName: true, project: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
      take: cap + 1,
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

  // The real size of each pile, and how much of it is urgent. Three of the five
  // are capped in SQL, so they are counted — but ONLY when the over-fetch proved
  // there was an overflow; below the cap the rows in hand are the whole pile and
  // the severity rule can simply be applied to them. So a quiet day pays for
  // nothing and a bad day pays for six cheap indexed counts.
  const overflowed = {
    unassigned: unassignedRows.length > cap,
    aging: agingRows.length > cap,
    followUp: followUpRows.length > cap,
  };
  const [unassignedAll, unassignedHigh, agingAll, agingHigh, followUpAll, followUpHigh] = await Promise.all([
    overflowed.unassigned ? prisma.project.count({ where: unassignedWhere }) : unassignedRows.length,
    overflowed.unassigned
      ? prisma.project.count({ where: unassignedHighWhere })
      : unassignedRows.filter((p) => p.deliveryDue && p.deliveryDue.getTime() < now).length,
    overflowed.aging ? prisma.reviewSubmission.count({ where: agingReviewWhere }) : agingRows.length,
    overflowed.aging
      ? prisma.reviewSubmission.count({ where: agingReviewHighWhere })
      : agingRows.filter((r) => ageOf(r.createdAt, now) >= EXCEPTION_RULES.reviewAgingDays * 2).length,
    overflowed.followUp ? prisma.smartTask.count({ where: followUpWhere }) : followUpRows.length,
    overflowed.followUp
      ? prisma.smartTask.count({ where: followUpHighWhere })
      : followUpRows.filter((t) => ageOf(t.followUpAt, now) >= 3).length,
  ]);

  const out: OpsException[] = [];

  for (const p of unassignedRows.slice(0, cap)) {
    out.push({
      id: `unassigned:${p.id}`,
      kind: "unassigned",
      severity: p.deliveryDue && p.deliveryDue.getTime() < now ? "high" : "medium",
      title: streetOf(p.title),
      why: p.deliveryDue && p.deliveryDue.getTime() < now
        ? `Ready for editing, past its date, and no editor on it`
        : `Ready for editing with no editor on it`,
      owner: "Nobody yet",
      nextAction: "Pick an editor on the row in the Editing Room",
      href: `/edit/${p.id}`,
      ageDays: ageOf(p.shootDate ?? p.updatedAt, now),
    });
  }

  for (const r of agingRows.slice(0, cap)) {
    out.push({
      id: `review:${r.id}`,
      kind: "aging-review",
      severity: ageOf(r.createdAt, now) >= EXCEPTION_RULES.reviewAgingDays * 2 ? "high" : "medium",
      title: streetOf(r.project?.title),
      why: `Version ${r.round} has been waiting ${ageOf(r.createdAt, now)} days for a verdict`,
      owner: verdictOwner,
      nextAction: "Watch it and approve or send it back in the Review Room",
      href: `/edit/${r.projectId}`,
      ageDays: ageOf(r.createdAt, now),
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

  return {
    // High first, then oldest. A list somebody reads top to bottom.
    rows: out.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
      return b.ageDays - a.ageDays;
    }),
    totals: {
      unassigned: { all: unassignedAll, high: unassignedHigh },
      "aging-review": { all: agingAll, high: agingHigh },
      "overdue-followup": { all: followUpAll, high: followUpHigh },
      // These two are never truncated by SQL, so the rows in hand ARE the pile.
      "stalled-render": {
        all: stalledAll.length,
        high: stalledAll.filter((j) => now - renderClock(j).getTime() >= 24 * HOUR).length,
      },
      "unsent-replacement": { all: qualifying.length, high: qualifying.length },
    },
  };
}

/** The rows on their own, for a reader that wants the list and not the tally
 *  (the recon scripts). The dashboard takes the board, because the card has to
 *  be able to say how many it is NOT showing. */
export async function opsExceptions(opts: { now?: Date } = {}): Promise<OpsException[]> {
  return (await opsExceptionsBoard(opts)).rows;
}
