import { etAt, etDate, etDateTime, etDayKey, businessDaysBetweenET } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// PROGRAM VIDEOS, WATCHED BEFORE THE PROMISE (Oct 15 2026). The pure half: no
// prisma, no server-only, so the office's board, the client's portal and the
// drill read the same milestones, the same causes and the same words.
//
// Why: Marcee McMullen told Jordan on Oct 15 that quality and turnaround had
// slipped and that she had to keep asking for updates. The promise watch
// (promiseWatch.ts) left every program video out, and the at-risk list was a
// clock: a video only became "at risk" a day before its promise, by which time
// a ten-business-day job has already used nine of them.
//
// A program video's promise (DeliverableOutput.promisedAt, else the job's
// effective promise) is split into milestones, counted BACK from the promise in
// business days so the end of the window, the client's review and corrections
// time, stays protected:
//
//   window W (business days, 10 for the monthly program; the shoot to the
//   promise when the shoot is known)
//     FOOTAGE     footage in            by day ceil(10% of W)   (day 1 of 10)
//     EDIT_START  editing started       by day round(30% of W)  (day 3)
//     IN_REVIEW   first cut in review   by day round(50% of W)  (day 5)
//     FINAL       final approved        by day floor(80% of W)  (day 8)
//     DELIVERED   on the client's portal by the promise          (day 10)
//
// A video is AT RISK the moment any milestone passes unmet, not 24 hours
// before the promise; LATE once the promise passes undelivered. A milestone is
// met by its own evidence or by any later one (a cut in review proves the
// footage was in and editing started).
// ---------------------------------------------------------------------------

export const MISS_CAUSES = [
  "EDIT_CAPACITY",
  "MISSING_ASSETS",
  "INCOMPLETE_BRIEF",
  "SLOW_HANDOFF",
  "REVIEW_BOTTLENECK",
  "REVISION_CYCLES",
  "CLIENT_APPROVAL",
] as const;
export type MissCause = (typeof MISS_CAUSES)[number];
export const isMissCause = (v: unknown): v is MissCause => typeof v === "string" && (MISS_CAUSES as readonly string[]).includes(v);

/** label: what the office picks from. hint: what it means. client: the plain
 *  reason a client may read when a date moves (no dashes, no internal words). */
export const MISS_CAUSE_WORDS: Record<MissCause, { label: string; hint: string; client: string }> = {
  EDIT_CAPACITY: {
    label: "Editing capacity",
    hint: "The editor had the footage and the brief, but not the time.",
    client: "Our editing team needed a little more time than we planned.",
  },
  MISSING_ASSETS: {
    label: "Missing footage or files",
    hint: "Footage, music, logos or other files were not in place when editing should have started.",
    client: "We were waiting on some of the files we needed to finish it.",
  },
  INCOMPLETE_BRIEF: {
    label: "Incomplete brief",
    hint: "The script, topic or direction was not ready when editing should have started.",
    client: "We needed a few more details before we could finish editing.",
  },
  SLOW_HANDOFF: {
    label: "Slow handoff to the editor",
    hint: "The footage was in, but it reached an editor late.",
    client: "It took us longer than planned to get it to our editor.",
  },
  REVIEW_BOTTLENECK: {
    label: "Waiting on our review",
    hint: "A cut sat waiting for a verdict, or an approved cut sat waiting to be released.",
    client: "Our quality check took longer than planned.",
  },
  REVISION_CYCLES: {
    label: "Extra rounds of changes",
    hint: "It needed more than one round of fixes before it passed.",
    client: "We took an extra pass to get the details right.",
  },
  CLIENT_APPROVAL: {
    label: "Waiting on the client",
    hint: "We were waiting on the client's approval, answers or files.",
    client: "We were waiting on your approval before we could finish it.",
  },
};

/** When a date moved and nobody recorded why: still a plain reason, never blank. */
export const GENERIC_MOVE_REASON = "We needed a little more time to get it right.";

export const MILESTONES = ["FOOTAGE", "EDIT_START", "IN_REVIEW", "FINAL", "DELIVERED"] as const;
export type MilestoneKey = (typeof MILESTONES)[number];

export const MILESTONE_WORDS: Record<MilestoneKey, { label: string; should: string }> = {
  FOOTAGE: { label: "Footage in", should: "the footage should have been in" },
  EDIT_START: { label: "Editing started", should: "editing should have started" },
  IN_REVIEW: { label: "First cut in review", should: "the first cut should have been in review" },
  FINAL: { label: "Final approved", should: "the final should have been approved" },
  DELIVERED: { label: "On the client's portal", should: "it should have been on the client's portal" },
};

/** The monthly program's promise window: business day 10 (turnaround.ts TIERS.monthly_social). */
export const DEFAULT_WINDOW_DAYS = 10;
/** The close of a milestone day, ET (the same 5 PM every day-quoted promise uses). */
const DAY_END_HOUR = 17;

export type Milestone = { key: MilestoneKey; by: Date };

/** Business days after the window starts at which each milestone falls. Pure. */
export function milestoneDays(windowDays: number): Record<MilestoneKey, number> {
  const w = Math.max(1, Math.min(30, Math.round(windowDays) || DEFAULT_WINDOW_DAYS));
  const at = (f: number, round: (n: number) => number) => Math.min(w, Math.max(1, round(w * f)));
  return {
    FOOTAGE: at(0.1, Math.ceil),
    EDIT_START: at(0.3, Math.round),
    IN_REVIEW: at(0.5, Math.round),
    FINAL: at(0.8, Math.floor),
    DELIVERED: w,
  };
}

/** The ET day key `n` business days BEFORE `dayKey` (weekends skipped). Pure. */
export function businessDayKeyBefore(dayKey: string, n: number): string {
  let key = dayKey;
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    const [y, m, d] = key.split("-").map(Number);
    key = new Date(Date.UTC(y, m - 1, d - 1, 12)).toISOString().slice(0, 10);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return key;
}

/**
 * The milestones for ONE video. `anchorAt` (the shoot, when known) sets the
 * window length; without it the program's ten business days apply. Each
 * milestone is the close (5 PM ET) of its business day, counted back from the
 * promise; DELIVERED is the promise itself, to the minute. A milestone never
 * falls before the anchor (a video cannot be late for footage it was never
 * filmed for). Pure.
 */
export function programMilestones(promisedAt: Date, opts: { anchorAt?: Date | null } = {}): Milestone[] {
  const anchor = opts.anchorAt && opts.anchorAt < promisedAt ? opts.anchorAt : null;
  const w = anchor ? Math.max(1, Math.min(30, businessDaysBetweenET(anchor, promisedAt))) : DEFAULT_WINDOW_DAYS;
  const days = milestoneDays(w);
  const promiseKey = etDayKey(promisedAt);
  return MILESTONES.map((key) => {
    if (key === "DELIVERED") return { key, by: promisedAt };
    let by = etAt(businessDayKeyBefore(promiseKey, w - days[key]), DAY_END_HOUR);
    if (by > promisedAt) by = promisedAt;
    if (anchor && by < anchor) by = anchor;
    return { key, by };
  });
}

/** What the hub can PROVE about one video, each the first time it was seen. */
export type VideoFacts = {
  footageAt: Date | null;
  editStartedAt: Date | null;
  inReviewAt: Date | null;
  finalAt: Date | null;
  deliveredAt: Date | null;
};

const FACT_OF: Record<MilestoneKey, keyof VideoFacts> = {
  FOOTAGE: "footageAt",
  EDIT_START: "editStartedAt",
  IN_REVIEW: "inReviewAt",
  FINAL: "finalAt",
  DELIVERED: "deliveredAt",
};

/** Met by its own fact or any LATER one; when met, the earliest time that proves it. Pure. */
export function metAt(key: MilestoneKey, f: VideoFacts): Date | null {
  const from = MILESTONES.indexOf(key);
  let best: Date | null = null;
  for (const k of MILESTONES.slice(from)) {
    const t = f[FACT_OF[k]];
    if (t && (!best || t < best)) best = t;
  }
  return best;
}

export type StageKey = "AWAITING_FOOTAGE" | "READY_TO_EDIT" | "EDITING" | "IN_REVIEW" | "FINAL_TOUCHES" | "DELIVERED";

export function stageOf(f: VideoFacts): StageKey {
  if (f.deliveredAt) return "DELIVERED";
  if (f.finalAt) return "FINAL_TOUCHES";
  if (f.inReviewAt) return "IN_REVIEW";
  if (f.editStartedAt) return "EDITING";
  if (f.footageAt) return "READY_TO_EDIT";
  return "AWAITING_FOOTAGE";
}

/** The office's words for where it stands. */
export const STAGE_STAFF_WORDS: Record<StageKey, string> = {
  AWAITING_FOOTAGE: "no footage confirmed yet",
  READY_TO_EDIT: "footage in, editing not started",
  EDITING: "editing, no cut yet",
  IN_REVIEW: "cut waiting in review",
  FINAL_TOUCHES: "approved, not on the portal yet",
  DELIVERED: "on the client's portal",
};

/** The client's words for the same (no internal tool names, no dashes). */
export const STAGE_CLIENT_WORDS: Record<StageKey | "CHANGES", string> = {
  AWAITING_FOOTAGE: "Filmed, editing is next",
  READY_TO_EDIT: "Filmed, editing is next",
  EDITING: "Being edited",
  IN_REVIEW: "In our quality check",
  FINAL_TOUCHES: "Final touches",
  DELIVERED: "Ready for you",
  CHANGES: "Making your changes",
};

export type WatchStatus = "ON_TRACK" | "AT_RISK" | "LATE" | "DONE";

export type Evaluation = {
  status: WatchStatus;
  /** The EARLIEST milestone that passed unmet (null when none has). */
  missed: Milestone | null;
  /** The next milestone still ahead and unmet. */
  next: Milestone | null;
  /** The earliest milestone that slipped at all: missed now, or met after its time. Drives the cause. */
  slipped: Milestone | null;
  stage: StageKey;
  /** Delivered, but after the promise. */
  deliveredLate: boolean;
};

/** Where one video stands against its milestones. Pure. */
export function evaluateVideo(milestones: Milestone[], f: VideoFacts, now: Date): Evaluation {
  const stage = stageOf(f);
  const promise = milestones.find((m) => m.key === "DELIVERED")?.by ?? null;
  let missed: Milestone | null = null;
  let next: Milestone | null = null;
  let slipped: Milestone | null = null;
  for (const m of milestones) {
    const met = metAt(m.key, f);
    if (!met && m.by <= now && !missed) missed = m;
    if (!met && m.by > now && !next) next = m;
    if (!slipped && ((!met && m.by <= now) || (met && met > m.by))) slipped = m;
  }
  if (f.deliveredAt) {
    const deliveredLate = !!promise && f.deliveredAt > promise;
    return { status: "DONE", missed: null, next: null, slipped, stage, deliveredLate };
  }
  const status: WatchStatus = promise && now > promise ? "LATE" : missed ? "AT_RISK" : "ON_TRACK";
  return { status, missed, next, slipped, stage, deliveredLate: false };
}

// ---- the cause the hub suggests (a person decides) -----------------------------

export type CauseEvidence = {
  /** the milestone the suggestion is about (Evaluation.slipped) */
  slipped: MilestoneKey;
  facts: VideoFacts;
  milestones: Milestone[];
  /** a script, topic or brief is on file for this video */
  briefReady: boolean;
  /** a person (or the job) names its editor */
  editorAssigned: boolean;
  /** cuts handed in before one passed */
  internalRounds: number;
  /** the newest cut has waited this long for a verdict (null = nothing waiting) */
  waitingOnVerdictHours: number | null;
  /** approved this long ago and still not on the portal (null = n/a) */
  approvedUnreleasedHours: number | null;
  /** the client has it to approve, or asked for changes, or owes us answers */
  clientWaiting: boolean;
};

/** The hub's best guess at why, with the evidence in one clause. Pure. */
export function suggestMissCause(e: CauseEvidence): { cause: MissCause; why: string } {
  const by = (k: MilestoneKey) => e.milestones.find((m) => m.key === k)?.by ?? null;
  const footageBy = by("FOOTAGE");
  const footageLate = !e.facts.footageAt ? !metAt("FOOTAGE", e.facts) : !!footageBy && e.facts.footageAt > footageBy;
  const idx = MILESTONES.indexOf(e.slipped);
  if (idx <= MILESTONES.indexOf("EDIT_START") && footageLate) {
    return { cause: "MISSING_ASSETS", why: e.facts.footageAt ? `the footage was confirmed in only on ${etDate(e.facts.footageAt)}` : "no footage has been confirmed in for it" };
  }
  if (idx <= MILESTONES.indexOf("IN_REVIEW")) {
    if (!e.briefReady) return { cause: "INCOMPLETE_BRIEF", why: "there is no script, topic or brief on file for it" };
    if (!e.editorAssigned) return { cause: "SLOW_HANDOFF", why: "the footage is in and no editor has been named" };
    return { cause: "EDIT_CAPACITY", why: "the editor had the footage and the brief and no cut came in on time" };
  }
  if (e.clientWaiting) return { cause: "CLIENT_APPROVAL", why: "it is waiting on the client" };
  if (e.approvedUnreleasedHours != null && e.approvedUnreleasedHours >= 24) {
    return { cause: "REVIEW_BOTTLENECK", why: `it was approved ${Math.round(e.approvedUnreleasedHours)}h ago and is not on the portal` };
  }
  if (e.internalRounds >= 2) return { cause: "REVISION_CYCLES", why: `it took ${e.internalRounds} cuts before one passed` };
  if (e.waitingOnVerdictHours != null && e.waitingOnVerdictHours >= 24) {
    return { cause: "REVIEW_BOTTLENECK", why: `the newest cut has waited ${Math.round(e.waitingOnVerdictHours)}h for a verdict` };
  }
  return { cause: "EDIT_CAPACITY", why: "no cut passed in time" };
}

// ---- the client's line on the portal --------------------------------------------

export type ClientExpected = {
  /** "Being edited" */
  stage: string;
  /** "Expected by Tue, Oct 20" / "Now expected by Thu, Oct 22" / "Running a little behind…" */
  line: string;
  /** set when the date moved or is behind: the plain reason */
  reason: string | null;
  /** the date moved from this one ("Tue, Oct 20") */
  movedFrom: string | null;
  late: boolean;
};

/**
 * What a client is told about one video in production. Pure. The only date it
 * names is the recorded promise (or the revision round's due date while their
 * changes are being made); a promise that has passed with no new date says so
 * and promises nothing, exactly as the at-risk drafts do (atRiskUpdates.ts).
 */
export function clientExpected(input: {
  stage: StageKey | "CHANGES";
  promisedAt: Date | null;
  /** the first promise this video was given, when the office has since moved it */
  originalAt: Date | null;
  cause: MissCause | null;
  now: Date;
}): ClientExpected | null {
  const stage = STAGE_CLIENT_WORDS[input.stage];
  if (input.stage === "DELIVERED") return null;
  const p = input.promisedAt;
  if (!p) return input.stage === "CHANGES" ? { stage, line: "We'll let you know as soon as your changes are ready.", reason: null, movedFrom: null, late: false } : null;
  const why = input.cause ? MISS_CAUSE_WORDS[input.cause].client : GENERIC_MOVE_REASON;
  if (p <= input.now) {
    return { stage, line: "Running a little behind. We'll confirm the new date with you.", reason: why, movedFrom: null, late: true };
  }
  const moved = !!input.originalAt && p.getTime() - input.originalAt.getTime() > 3_600_000 && etDayKey(p) !== etDayKey(input.originalAt);
  if (moved) {
    return { stage, line: `Now expected by ${etDate(p)}`, reason: why, movedFrom: etDate(input.originalAt!), late: false };
  }
  return { stage, line: `Expected by ${etDate(p)}`, reason: null, movedFrom: null, late: false };
}

/** "Tue, Oct 20, 5:00 PM ET" for staff lines. */
export const staffWhen = (d: Date) => `${etDateTime(d)} ET`;

/** The office's one-line reason a video is on the watch. Pure. */
export function watchWhy(ev: Evaluation, promisedAt: Date): string {
  if (ev.status === "LATE") return `past its promise (${staffWhen(promisedAt)}), ${STAGE_STAFF_WORDS[ev.stage]}`;
  if (ev.missed) return `${MILESTONE_WORDS[ev.missed.key].should} by ${staffWhen(ev.missed.by)}; now ${STAGE_STAFF_WORDS[ev.stage]}`;
  if (ev.deliveredLate) return `reached the portal after its promise (${staffWhen(promisedAt)})`;
  return STAGE_STAFF_WORDS[ev.stage];
}
