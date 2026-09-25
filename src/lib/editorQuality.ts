import "server-only";
import { prisma } from "@/lib/prisma";
import { etAt, etDayKey, isWeekdayET } from "@/lib/datetime";
import { editorMeta, VIDEO_LANE_KEYS } from "@/lib/editors";
import { videoStyleFor } from "@/lib/videoStyles";
import { isEditorCaused } from "@/lib/issueCauses";
import { SELF_CHECK_REQUIRED_SINCE } from "@/lib/selfCheck";

// ---------------------------------------------------------------------------
// EDITOR QUALITY (unified handoff §8.4, Sep 25 2026).
//
// "Editors see their own progress, examples, and improvement focus. James and
// Jordan see the team view … Show sample size and complexity context; avoid
// misleading global rankings. Unknown historic causes stay unknown until
// reviewed."
//
// What this is NOT, on purpose:
//   · not kpi.ts — that file is the PHOTOGRAPHER quarterly bonus (money); an
//     editor number feeding it would make attribution drive pay. Nothing here
//     writes anywhere: every figure is computed live from the current
//     classification, so a corrected cause re-scores the next time it is read.
//   · not QcRecord / qc.ts — Kyle's delivery-QC dial stays exactly as it is.
//   · not a ranking: every block carries its own n, and below THIN_SAMPLE it
//     says "not enough to judge" rather than a percentage.
// History before the ledger began (SELF_CHECK_REQUIRED_SINCE) has no issue
// records, so the report starts there instead of scoring an unknown past.
// ---------------------------------------------------------------------------

/** Below this many, a block reads "not enough to judge" — the same floor the
 *  photographer scorecard uses (kpi.ts TARGETS.minShoots). */
export const THIN_SAMPLE = 5;
/** Where the report starts: the day issues began being recorded. */
export const QUALITY_TRACKED_SINCE = SELF_CHECK_REQUIRED_SINCE;

const HOUR = 3_600_000;

/** Elapsed WEEKDAY hours between two instants in America/New_York — the
 *  handoff's meaning of business hours (§3: "72 elapsed weekday hours …
 *  excluding Saturdays and Sundays", not office hours). Pure. */
export function weekdayHoursBetween(a: Date, b: Date): number {
  if (!(b.getTime() > a.getTime())) return 0;
  let total = 0;
  let t = new Date(a);
  for (let guard = 0; guard < 800 && t.getTime() < b.getTime(); guard++) {
    const key = etDayKey(t);
    const [y, m, d] = key.split("-").map(Number);
    const next = etAt(new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10), 0);
    const end = next.getTime() < b.getTime() ? next : b;
    if (isWeekdayET(t)) total += (end.getTime() - t.getTime()) / HOUR;
    t = next;
  }
  return Math.round(total * 10) / 10;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) * 10) / 10;
};

// ---- pure rules, exported for the drills ---------------------------------------

export type FirstReviewOutcome = "passed" | "failed" | "pendingReview" | "pendingClassification" | "replacedBeforeReview";
type IssueForOutcome = { cause: string; state: string; duplicateOfId: string | null; foundAfterApproval: boolean };

/**
 * The first version of a video, judged on its FIRST review. Only a confirmed
 * editor-caused issue fails it — a client preference, new scope, a brief gap,
 * a capture or processing problem does not. A bounce whose issues nobody has
 * classified is not a pass or a fail yet: it is pending classification. A
 * version replaced before anyone ruled was never reviewed. Defects found after
 * approval belong to the client-visible block, not here.
 */
export function firstReviewOutcome(round: { status: string; decidedAt: Date | null }, issues: IssueForOutcome[]): FirstReviewOutcome {
  if (round.status === "PENDING" || round.status === "UPLOADING") return "pendingReview";
  if (!round.decidedAt && (round.status === "SUPERSEDED" || round.status === "WITHDRAWN" || round.status === "UPLOAD_FAILED")) return "replacedBeforeReview";
  const live = issues.filter((i) => !i.foundAfterApproval && !i.duplicateOfId && i.state !== "DUPLICATE" && i.state !== "NOT_APPLICABLE");
  if (live.some((i) => isEditorCaused(i.cause))) return "failed";
  if (live.some((i) => i.cause === "UNCLASSIFIED")) return "pendingClassification";
  // Sent back with nothing recorded on it: the reason is unknown, not good.
  if (round.status === "CHANGES_REQUESTED" && live.length === 0) return "pendingClassification";
  return "passed";
}

/** Still-valid earlier asks the next version did not address (stamped at the
 *  bounce, revisionIssues.onChangesRequested, or when the reviewer reopens a
 *  fix a version claimed). A new instruction on that version is never one; an
 *  ask later marked not needed or merged away drops; and once a reviewer has
 *  classified the ask as somebody else's (a client change, new scope, a brief
 *  gap, capture, processing) it is not the editor's miss (§3, A37 — review
 *  fix, Sep 25). Unclassified still counts: it is not known to be anyone else's. */
export function missedCorrections<T extends { missedInSubmissionId: string | null; state: string; duplicateOfId: string | null; cause?: string | null }>(issues: T[]): T[] {
  return issues.filter(
    (i) =>
      !!i.missedInSubmissionId && i.state !== "NOT_APPLICABLE" && i.state !== "DUPLICATE" && !i.duplicateOfId &&
      (i.cause == null || i.cause === "UNCLASSIFIED" || isEditorCaused(i.cause)),
  );
}

/** How long a cut waited on review, split by whose queue it sat in. Starts
 *  when the cut ENTERED review (selfCheckedAt, else created), so editing time
 *  is never billed to the reviewer and waiting is never billed to the editor.
 *  `reviewer` null = nobody was named. Weekday hours. Pure. */
export function reviewWaitSegments(
  sub: { enteredAt: Date; decidedAt: Date | null },
  events: { toTeamMemberId: string; at: Date }[],
  now: Date,
): { reviewer: string | null; hours: number }[] {
  const end = sub.decidedAt ?? now;
  if (end.getTime() <= sub.enteredAt.getTime()) return [];
  const evs = [...events].filter((e) => e.at.getTime() <= end.getTime()).sort((a, b) => a.at.getTime() - b.at.getTime());
  let holder: string | null = null;
  for (const e of evs) if (e.at.getTime() <= sub.enteredAt.getTime()) holder = e.toTeamMemberId;
  const acc = new Map<string | null, number>();
  const add = (who: string | null, h: number) => { if (h > 0) acc.set(who, (acc.get(who) ?? 0) + h); };
  let t = sub.enteredAt;
  for (const e of evs) {
    if (e.at.getTime() <= sub.enteredAt.getTime()) continue;
    add(holder, weekdayHoursBetween(t, e.at));
    holder = e.toTeamMemberId;
    t = e.at;
  }
  add(holder, weekdayHoursBetween(t, end));
  return [...acc.entries()].map(([reviewer, hours]) => ({ reviewer, hours: Math.round(hours * 10) / 10 }));
}

// ---- the report ----------------------------------------------------------------

/** `href` is the desk's link (the Review Room, parked on the version);
 *  `editHref` is the job's issue list, which an editor can open — the Room
 *  redirects them (review fix, Sep 25). */
export type Example = { text: string; href: string; editHref: string; atISO: string; street: string };

export type EditorQualityReport = {
  editorKey: string | null;
  editorName: string;
  fromISO: string;
  toISO: string;
  trackedSinceISO: string;
  firstReview: {
    passed: number; reviewed: number; pendingReview: number; pendingClassification: number; replacedBeforeReview: number;
    rate: number | null; thin: boolean;
    byProduct: { product: string; passed: number; reviewed: number }[];
  };
  recurring: {
    n: number; thin: boolean;
    groups: { category: string; product: string; count: number; examples: Example[] }[];
    weekly: { weekISO: string; count: number }[];
  };
  missed: { count: number; asked: number; thin: boolean; examples: Example[] };
  /** Earlier asks the editor openly declared NOT done in a version's check,
   *  with their reason — shown apart from misses, never counted as one. */
  declaredNotDone: { count: number; examples: (Example & { reason: string })[] };
  turnaround: {
    n: number; thin: boolean; medianHours: number | null;
    processingN: number; medianProcessingHours: number | null;
    /** null = the active-work layer has recorded no pauses — "not recorded", never 0 */
    waitingOnAssetsHours: number | null;
    clientWaitN: number; medianClientWaitHours: number | null;
  };
  clientVisible: { n: number; editingFault: number; reviewMiss: number; unclassified: number; other: number; examples: Example[] };
  reviewWaiting: { n: number; thin: boolean; byReviewer: { name: string; n: number; medianHours: number | null; totalHours: number }[]; pending: number; oldestPendingHours: number | null };
};

const streetOf = (t: string | null | undefined) => (t || "Job").split(",")[0].trim();
const weekStartISO = (d: Date): string => {
  const key = etDayKey(d);
  const [y, m, day] = key.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, day, 12));
  const dow = (utc.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(utc.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
};

/**
 * One editor's numbers (editorKey), or the whole team's (null). Every block
 * carries its own n. Read-only.
 */
export async function editorQuality(opts: { editorKey?: string | null; from?: Date; to?: Date; now?: Date } = {}): Promise<EditorQualityReport> {
  const now = opts.now ?? new Date();
  const to = opts.to ?? now;
  const from = new Date(Math.max((opts.from ?? new Date(to.getTime() - 90 * 86_400_000)).getTime(), QUALITY_TRACKED_SINCE.getTime()));
  const editorKey = opts.editorKey ?? null;
  const editorName = editorKey ? editorMeta(editorKey)?.name ?? editorKey : "Team";

  // An editor's versions: the ones on their key, plus the office's uploads of
  // their files (no key on the row; the accepted check names who it was for).
  const forEditor = editorKey
    ? (await prisma.cutSelfCheck.findMany({ where: { editorKey, state: "VALID", createdAt: { gte: from, lte: to } }, select: { submissionId: true } }).catch(() => [])).map((c) => c.submissionId)
    : [];
  const subs = await prisma.reviewSubmission.findMany({
    where: {
      kind: "video",
      createdAt: { gte: from, lte: to },
      status: { notIn: ["UPLOAD_FAILED"] },
      ...(editorKey ? { OR: [{ submittedByKey: editorKey }, { submittedByKey: null, id: { in: forEditor } }] } : {}),
    },
    select: {
      id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, round: true, status: true, createdAt: true, decidedAt: true,
      decidedBy: true, selfCheckedAt: true, selfCheckId: true, submittedByKey: true, clientReleasedAt: true, sentToClientAt: true,
    },
  });
  const issues = await prisma.revisionIssue.findMany({
    where: { createdAt: { gte: from, lte: to }, ...(editorKey ? { versionEditorKey: editorKey } : {}) },
  });
  const projectIds = [...new Set([...subs.map((s) => s.projectId), ...issues.map((i) => i.projectId)])];
  const [projects, deliverables] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, title: true } }),
    prisma.deliverable.findMany({
      where: { id: { in: [...new Set([...subs.map((s) => s.deliverableId), ...issues.map((i) => i.deliverableId)].filter((x): x is string => !!x))] } },
      select: { id: true, type: true, label: true, videoStyle: true, productTitle: true },
    }),
  ]);
  const street = new Map(projects.map((p) => [p.id, streetOf(p.title)]));
  const productOfDeliverable = new Map(deliverables.map((d) => [d.id, videoStyleFor(d).name]));
  const productOf = (deliverableId: string | null) => (deliverableId ? productOfDeliverable.get(deliverableId) ?? "Video" : "Video (folder cut)");
  const cutHref = (projectId: string, submissionId: string | null) => (submissionId ? `/review/${projectId}?cut=${submissionId}` : `/edit/${projectId}#issues`);
  const example = (i: (typeof issues)[number]): Example => ({
    text: (i.summary || i.originalText).slice(0, 160),
    href: cutHref(i.projectId, i.raisedOnSubmissionId),
    editHref: `/edit/${i.projectId}#issues`,
    atISO: i.createdAt.toISOString(),
    street: street.get(i.projectId) ?? "Job",
  });

  // ---- first review ----------------------------------------------------------
  const issuesBySub = new Map<string, typeof issues>();
  // An issue raised on a version in this window may itself be older than the
  // window's issue read; re-read those by submission id so none is missed.
  const subIds = subs.map((s) => s.id);
  const raisedOn = subIds.length
    ? await prisma.revisionIssue.findMany({ where: { raisedOnSubmissionId: { in: subIds } }, select: { raisedOnSubmissionId: true, cause: true, state: true, duplicateOfId: true, foundAfterApproval: true } })
    : [];
  for (const i of raisedOn) {
    const arr = issuesBySub.get(i.raisedOnSubmissionId!) ?? [];
    arr.push(i as never);
    issuesBySub.set(i.raisedOnSubmissionId!, arr);
  }
  const firsts = subs.filter((s) => s.round === 1);
  let passed = 0, failed = 0, pendingReview = 0, pendingClassification = 0, replacedBeforeReview = 0;
  const prod = new Map<string, { passed: number; reviewed: number }>();
  for (const s of firsts) {
    const o = firstReviewOutcome(s, (issuesBySub.get(s.id) ?? []) as unknown as IssueForOutcome[]);
    if (o === "passed") passed++;
    else if (o === "failed") failed++;
    else if (o === "pendingReview") pendingReview++;
    else if (o === "pendingClassification") pendingClassification++;
    else replacedBeforeReview++;
    if (o === "passed" || o === "failed") {
      const p = productOf(s.deliverableId);
      const cur = prod.get(p) ?? { passed: 0, reviewed: 0 };
      cur.reviewed++;
      if (o === "passed") cur.passed++;
      prod.set(p, cur);
    }
  }
  const reviewed = passed + failed;

  // ---- recurring editor-caused issues ----------------------------------------
  const roots = issues.filter((i) => !i.duplicateOfId && i.state !== "DUPLICATE" && i.state !== "NOT_APPLICABLE" && isEditorCaused(i.cause));
  const groupMap = new Map<string, { category: string; product: string; items: typeof issues }>();
  for (const i of roots) {
    const product = productOf(i.deliverableId);
    const k = `${i.category}|${product}`;
    const g = groupMap.get(k) ?? { category: i.category, product, items: [] };
    g.items.push(i);
    groupMap.set(k, g);
  }
  const weeklyMap = new Map<string, number>();
  for (const i of roots) weeklyMap.set(weekStartISO(i.createdAt), (weeklyMap.get(weekStartISO(i.createdAt)) ?? 0) + 1);

  // ---- missed corrections ------------------------------------------------------
  // A miss belongs to the version that MISSED it (missedInSubmissionId), not to
  // the version the ask was raised on (review fix, Sep 25): after Kim → John,
  // John's v2 that misses Kim's v1 note is John's miss, and Kim's card shows
  // none. The pool is every ask a version in scope had to carry — claimed
  // fixed in it, or stamped missed in it — so `asked` is the same scope.
  const carried = subIds.length
    ? await prisma.revisionIssue.findMany({ where: { OR: [{ missedInSubmissionId: { in: subIds } }, { addressedInSubmissionId: { in: subIds } }] } })
    : [];
  const missed = missedCorrections(carried);
  const asked = carried.filter((i) => i.state !== "DUPLICATE" && i.state !== "NOT_APPLICABLE" && !i.duplicateOfId && !i.foundAfterApproval).length;
  // Declared not done: the editor's own honest "not in this version, because…"
  // on the checks of the versions in scope. Their own figure, with the reason.
  const declared = subIds.length
    ? await prisma.revisionIssueEvent.findMany({ where: { kind: "NOT_ADDRESSED", submissionId: { in: subIds } }, orderBy: { at: "asc" }, select: { issueId: true, note: true, at: true } }).catch(() => [])
    : [];
  const declaredIssues = declared.length
    ? await prisma.revisionIssue.findMany({ where: { id: { in: [...new Set(declared.map((d) => d.issueId))] } } }).catch(() => [])
    : [];
  const declaredRows = declared
    .map((d) => ({ d, i: declaredIssues.find((x) => x.id === d.issueId) }))
    .filter((x): x is { d: (typeof declared)[number]; i: (typeof declaredIssues)[number] } => !!x.i && x.i.state !== "DUPLICATE" && !x.i.duplicateOfId);

  // ---- revision turnaround -----------------------------------------------------
  const keyOf = (s: { deliverableId: string | null; slot: number | null; assetPath: string | null; id: string }) =>
    s.deliverableId ? `${s.deliverableId}:${s.slot ?? 1}` : s.assetPath ?? s.id;
  // Every version on the jobs in scope (not only this editor's), so the "next
  // version" of a bounce is found whoever made it — and credited to the ask.
  const allRounds = projectIds.length
    ? await prisma.reviewSubmission.findMany({
        where: { projectId: { in: projectIds }, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
        select: {
          id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, round: true, createdAt: true, selfCheckedAt: true, clientReleasedAt: true,
          sentToClientAt: true, status: true, decidedAt: true, submittedByKey: true, selfCheckId: true,
        },
      })
    : [];
  // WHO MADE each version: the row's key, else (an office upload of their
  // file) the editor its accepted check was for — the same rule the issue
  // ledger uses (revisionIssues.versionAuthor).
  const checkFor = new Map(
    (await prisma.cutSelfCheck
      .findMany({ where: { id: { in: allRounds.filter((r) => !r.submittedByKey && r.selfCheckId).map((r) => r.selfCheckId!) }, state: "VALID" }, select: { id: true, editorKey: true } })
      .catch(() => [])).map((c) => [c.id, c.editorKey]),
  );
  const authorOf = (r: { submittedByKey: string | null; selfCheckId: string | null }) => r.submittedByKey ?? (r.selfCheckId ? checkFor.get(r.selfCheckId) ?? null : null);
  const inScope = new Set(subIds);
  const byCut = new Map<string, typeof allRounds>();
  for (const r of allRounds) {
    const k = `${r.projectId}|${keyOf(r)}`;
    byCut.set(k, [...(byCut.get(k) ?? []), r]);
  }
  const turnHours: number[] = [];
  const clientWait: number[] = [];
  // A bounce is timed to the version that ANSWERED it, and credited to that
  // version's author — who is in scope when the answer is (review fix, Sep
  // 25). A stretch that crossed a reassignment (Kim's bounce, John's answer a
  // week later) is left out of BOTH editors' figures: neither one's pace.
  for (const s of allRounds) {
    if (s.status !== "CHANGES_REQUESTED" || !s.decidedAt) continue;
    const next = (byCut.get(`${s.projectId}|${keyOf(s)}`) ?? [])
      .filter((r) => r.round > s.round && r.createdAt.getTime() >= s.decidedAt!.getTime())
      .sort((a, b) => a.round - b.round)[0];
    if (!next || !inScope.has(next.id)) continue;
    const by = authorOf(next);
    if (!by || by !== authorOf(s)) continue;
    turnHours.push(weekdayHoursBetween(s.decidedAt, next.selfCheckedAt ?? next.createdAt));
    const out = (byCut.get(`${s.projectId}|${keyOf(s)}`) ?? [])
      .filter((r) => r.round > s.round && (r.clientReleasedAt || r.sentToClientAt))
      .map((r) => (r.sentToClientAt ?? r.clientReleasedAt)!.getTime())
      .sort((a, b) => a - b)[0];
    if (out) clientWait.push(weekdayHoursBetween(s.decidedAt, new Date(out)));
  }
  // Client asks (work orders) → the next version on a video they named.
  const briefs = projectIds.length
    ? await prisma.revisionBrief.findMany({ where: { projectId: { in: projectIds }, createdAt: { gte: from, lte: to } }, select: { id: true, projectId: true, createdAt: true, analyzedAt: true } })
    : [];
  for (const b of briefs) {
    const briefIssues = issues.filter((i) => i.sourceKind === "BRIEF_ITEM" && i.sourceId.startsWith(`${b.id}:`) && i.deliverableId);
    if (briefIssues.length === 0) continue;
    const ask = b.analyzedAt ?? b.createdAt;
    const nexts = briefIssues
      .map((i) => (byCut.get(`${b.projectId}|${i.deliverableId}:${i.slot ?? 1}`) ?? []).filter((r) => r.createdAt.getTime() > ask.getTime()).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0])
      .filter((r): r is NonNullable<typeof r> => !!r);
    if (nexts.length === 0) continue;
    const first = nexts.sort((x, y) => (x.selfCheckedAt ?? x.createdAt).getTime() - (y.selfCheckedAt ?? y.createdAt).getTime())[0];
    // Same rule as a bounce: the answer's author, and only when the ask was
    // on their own version — never a reassignment gap.
    const askedOf = briefIssues[0].versionEditorKey;
    if (!inScope.has(first.id) || !authorOf(first) || (askedOf != null && authorOf(first) !== askedOf)) continue;
    turnHours.push(weekdayHoursBetween(ask, first.selfCheckedAt ?? first.createdAt));
  }
  // Processing (the 1080p pass) on the versions in scope.
  const topaz = subIds.length
    ? await prisma.topazJob.findMany({ where: { submissionId: { in: subIds }, savedAt: { not: null } }, select: { createdAt: true, savedAt: true } })
    : [];
  const processing = topaz.map((t) => weekdayHoursBetween(t.createdAt, t.savedAt!));
  // Waiting on assets / feedback: the §7.1 active-work layer's paused-with-a-
  // reason stretches. None recorded → null ("not recorded"), never 0.
  const pauses = await prisma.editorWorkEvent
    .findMany({
      where: { kind: { in: ["PAUSE", "AUTO_PAUSE", "RESUME", "START", "SUBMIT", "CLOSE"] }, at: { gte: from, lte: to }, ...(editorKey ? { editorKey } : {}), ...(projectIds.length ? { projectId: { in: projectIds } } : {}) },
      orderBy: { at: "asc" },
      select: { itemId: true, kind: true, reason: true, at: true },
    })
    .catch(() => []);
  let waitingOnAssetsHours: number | null = null;
  {
    const open = new Map<string, Date>();
    let total = 0;
    let any = false;
    for (const e of pauses) {
      if ((e.kind === "PAUSE" || e.kind === "AUTO_PAUSE") && e.reason) { open.set(e.itemId, e.at); any = true; continue; }
      const since = open.get(e.itemId);
      if (since) { total += weekdayHoursBetween(since, e.at); open.delete(e.itemId); }
    }
    for (const since of open.values()) total += weekdayHoursBetween(since, to);
    waitingOnAssetsHours = any ? Math.round(total * 10) / 10 : null;
  }

  // ---- client-visible defects -------------------------------------------------
  const visible = issues.filter((i) => i.foundAfterApproval && !i.duplicateOfId && i.state !== "DUPLICATE" && i.state !== "NOT_APPLICABLE");
  const cv = { editingFault: 0, reviewMiss: 0, unclassified: 0, other: 0 };
  for (const i of visible) {
    if (i.reviewMiss) cv.reviewMiss++;
    else if (isEditorCaused(i.cause)) cv.editingFault++;
    else if (i.cause === "UNCLASSIFIED") cv.unclassified++;
    else cv.other++;
  }

  // ---- review waiting, by the reviewer whose queue it sat in -------------------
  const entered = subs.filter((s) => s.status !== "UPLOADING" && (s.selfCheckedAt || s.decidedAt || s.status === "PENDING"));
  const revEvents = entered.length
    ? await prisma.cutReviewerEvent.findMany({ where: { submissionId: { in: entered.map((s) => s.id) } }, select: { submissionId: true, toTeamMemberId: true, at: true } }).catch(() => [])
    : [];
  const members = await prisma.teamMember.findMany({ where: { id: { in: [...new Set(revEvents.map((e) => e.toTeamMemberId))] } }, select: { id: true, name: true } }).catch(() => []);
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const perReviewer = new Map<string, number[]>();
  let pending = 0;
  let oldest: number | null = null;
  const { isHeldForSelfCheck } = await import("@/lib/selfCheck");
  for (const s of entered) {
    if (s.status === "PENDING") {
      if (isHeldForSelfCheck(s)) continue; // waiting on the editor, not the reviewer
      pending++;
      const h = weekdayHoursBetween(s.selfCheckedAt ?? s.createdAt, now);
      oldest = oldest == null ? h : Math.max(oldest, h);
      continue;
    }
    if (!s.decidedAt || s.decidedBy === "Delivered to the client") continue;
    const segs = reviewWaitSegments({ enteredAt: s.selfCheckedAt ?? s.createdAt, decidedAt: s.decidedAt }, revEvents.filter((e) => e.submissionId === s.id), now);
    for (const seg of segs) {
      const who = seg.reviewer ? nameOf.get(seg.reviewer) ?? "Reviewer" : s.decidedBy ?? "Not assigned";
      perReviewer.set(who, [...(perReviewer.get(who) ?? []), seg.hours]);
    }
  }
  const byReviewer = [...perReviewer.entries()]
    .map(([name, hs]) => ({ name, n: hs.length, medianHours: median(hs), totalHours: Math.round(hs.reduce((a, b) => a + b, 0) * 10) / 10 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const reviewN = byReviewer.reduce((n, r) => n + r.n, 0);

  return {
    editorKey,
    editorName,
    fromISO: from.toISOString(),
    toISO: to.toISOString(),
    trackedSinceISO: QUALITY_TRACKED_SINCE.toISOString(),
    firstReview: {
      passed, reviewed, pendingReview, pendingClassification, replacedBeforeReview,
      rate: reviewed >= THIN_SAMPLE ? Math.round((passed / reviewed) * 1000) / 10 : null,
      thin: reviewed < THIN_SAMPLE,
      byProduct: [...prod.entries()].map(([product, v]) => ({ product, ...v })).sort((a, b) => b.reviewed - a.reviewed),
    },
    recurring: {
      n: roots.length,
      thin: roots.length < THIN_SAMPLE,
      groups: [...groupMap.values()]
        .map((g) => ({ category: g.category, product: g.product, count: g.items.length, examples: g.items.slice(-3).reverse().map(example) }))
        .sort((a, b) => b.count - a.count),
      weekly: [...weeklyMap.entries()].map(([weekISO, count]) => ({ weekISO, count })).sort((a, b) => a.weekISO.localeCompare(b.weekISO)),
    },
    missed: { count: missed.length, asked, thin: asked < THIN_SAMPLE, examples: missed.slice(-3).reverse().map(example) },
    declaredNotDone: {
      count: new Set(declaredRows.map((x) => x.i.id)).size,
      examples: declaredRows.slice(-3).reverse().map((x) => ({ ...example(x.i), reason: (x.d.note ?? "").slice(0, 160) })),
    },
    turnaround: {
      n: turnHours.length,
      thin: turnHours.length < THIN_SAMPLE,
      medianHours: median(turnHours),
      processingN: processing.length,
      medianProcessingHours: median(processing),
      waitingOnAssetsHours,
      clientWaitN: clientWait.length,
      medianClientWaitHours: median(clientWait),
    },
    clientVisible: { n: visible.length, ...cv, examples: visible.slice(-3).reverse().map(example) },
    reviewWaiting: { n: reviewN, thin: reviewN < THIN_SAMPLE, byReviewer, pending, oldestPendingHours: oldest },
  };
}

/** The editors with any work in the window, for the team view — one card each,
 *  in roster order, never sorted by score. */
export async function editorsWithWork(from: Date, to: Date): Promise<{ key: string; name: string }[]> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { kind: "video", createdAt: { gte: new Date(Math.max(from.getTime(), QUALITY_TRACKED_SINCE.getTime())), lte: to }, submittedByKey: { not: null } },
    select: { submittedByKey: true },
    distinct: ["submittedByKey"],
  });
  const keys = new Set(rows.map((r) => r.submittedByKey!));
  const order = [...VIDEO_LANE_KEYS.filter((k) => keys.has(k)), ...[...keys].filter((k) => !(VIDEO_LANE_KEYS as string[]).includes(k)).sort()];
  return order.map((key) => ({ key, name: editorMeta(key)?.name ?? key }));
}
