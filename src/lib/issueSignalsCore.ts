// ---------------------------------------------------------------------------
// CLIENT ISSUE SIGNALS, PURE HALF (Oct 24 2026). Jordan: "The Heather Barritt
// issue was marked closed, but it is still showing on Jordan's dashboard. Why?
// If it's for a reason, it should give an action item for that generalized
// reason. Hard-coded, built into the system."
//
// A complaint (ClientIssue) has its own states. The other rows on the Client
// issues card are SIGNALS the hub reads from the records: repeated revision
// rounds, a cancellation after delivery, a refund, shoot issues piling up on
// one client. Until now a signal had no end: a job with 5 rounds stayed on
// the card for 30 days after the work was fixed, sent and closed, with "Next:
// Correction plan" and no way to say it was handled.
//
// THE RULES, for repeated revision rounds (two or more client asks on
// different ET days in 30 days):
//   STILL BEING FIXED   a revision or creative review on the job is open.
//                       Next: finish it; the owner is whoever holds it.
//   CONFIRM THE CLIENT  every round is fixed. The two questions left are the
//                       ones a business cares about: is the client happy, and
//                       why did it take this many rounds. Next: confirm with
//                       the client (Kyle, by Assign) or close it here with the
//                       answer and the cause.
//   SETTLED (hidden)    nobody acted and the client asked for nothing for
//                       SETTLE_QUIET_DAYS after the last fix went out: a
//                       client still unhappy says so within days, and the
//                       listing is live by then.
//   CLOSED (hidden)     a person closed it (client happy, or still unhappy:
//                       that opens a complaint, which takes over), or the
//                       check-in someone was assigned was completed.
// A NEW client ask after any of these brings the row back, marked.
// The other signals close with one line saying what was decided, and come
// back only on new evidence (a later refund is its own row; a pattern grows).
// No prisma, no server-only: the dashboard, the panel and the drill read the
// same words.
// ---------------------------------------------------------------------------

export const SETTLE_QUIET_DAYS = 7;
const DAY = 86_400_000;

/** AppSetting key for one row's closure: `client-issue-closed:<row id>`. */
export const CLOSE_KEY_PREFIX = "client-issue-closed:";
export const closeKeyFor = (rowId: string) => `${CLOSE_KEY_PREFIX}${rowId}`.slice(0, 190);

export type SignalOutcome = "HAPPY" | "COMPLAINT" | "DONE";
export type SignalClosure = {
  v: 1;
  at: string;
  by: string | null;
  outcome: SignalOutcome;
  /** why it took this many rounds (ROUND_CAUSES key); revisions only */
  cause: string | null;
  note: string | null;
  /** the newest evidence this closure covers: the latest round, the event itself */
  upToISO: string | null;
  /** a pattern's flag count when it was closed */
  upToCount: number | null;
  complaintId?: string | null;
};

export function readClosure(value: string | null | undefined): SignalClosure | null {
  if (!value) return null;
  try {
    const j = JSON.parse(value) as Partial<SignalClosure>;
    if (!j || typeof j !== "object" || typeof j.at !== "string") return null;
    const outcome: SignalOutcome = j.outcome === "HAPPY" || j.outcome === "COMPLAINT" ? j.outcome : "DONE";
    return {
      v: 1, at: j.at, by: typeof j.by === "string" ? j.by : null, outcome,
      cause: typeof j.cause === "string" ? j.cause : null, note: typeof j.note === "string" ? j.note : null,
      upToISO: typeof j.upToISO === "string" ? j.upToISO : null, upToCount: typeof j.upToCount === "number" ? j.upToCount : null,
      complaintId: typeof j.complaintId === "string" ? j.complaintId : null,
    };
  } catch {
    return null;
  }
}

/** Why a job took this many rounds. Keys are the complaint vocabulary's
 *  (clientIssuesCore.COMPLAINT_CAUSES), so the two records count alike. */
export const ROUND_CAUSES: { key: string; label: string }[] = [
  { key: "BRIEF_GAP", label: "The ask wasn't clear or written down" },
  { key: "MISSED_INSTRUCTION", label: "We missed something they told us" },
  { key: "EDITOR_ERROR", label: "Editing mistakes" },
  { key: "CLIENT_CHANGE", label: "The client kept changing or adding asks" },
  { key: "CAPTURE", label: "A capture problem at the shoot" },
  { key: "PROCESSING", label: "A processing or platform problem" },
  { key: "OTHER", label: "Not sure, or something else" },
];
export const isRoundCause = (v: unknown): v is string => typeof v === "string" && ROUND_CAUSES.some((c) => c.key === v);
export const roundCauseLabel = (k: string | null | undefined) => ROUND_CAUSES.find((c) => c.key === k)?.label ?? null;

export type OpenFix = { title: string; who: string | null };
export type RoundsInput = {
  rounds: number;
  latestRoundAt: Date;
  /** open revision / creative-review work on the job */
  openWork: OpenFix[];
  /** when the last fix reached the client (a sent cut, a finished revision) */
  lastFixAt: Date | null;
  closure: SignalClosure | null;
  /** the check-in someone was assigned from this row */
  delegated: { open: boolean; who: string | null; completedAt: Date | null } | null;
  clientFirst: string;
  now: Date;
};
export type RoundsStage =
  | { show: false; why: string }
  | {
      show: true;
      stage: "FIXING" | "CONFIRM";
      reopened: boolean;
      /** why the row is on the card, in words */
      whyHere: string;
      nextAction: string;
      owner: string | null;
      /** CONFIRM only: when it settles on its own if nobody acts and the client stays quiet */
      settlesAt: Date | null;
    };

export function roundsStage(i: RoundsInput): RoundsStage {
  const closedUpTo = i.closure?.upToISO ? Date.parse(i.closure.upToISO) : NaN;
  if (Number.isFinite(closedUpTo) && i.latestRoundAt.getTime() <= closedUpTo) {
    return { show: false, why: `Closed ${i.closure!.outcome === "COMPLAINT" ? "into a complaint" : i.closure!.outcome === "HAPPY" ? "with the client happy" : "as handled"}` };
  }
  if (i.delegated && !i.delegated.open && i.delegated.completedAt && i.delegated.completedAt >= i.latestRoundAt) {
    return { show: false, why: `${i.delegated.who ?? "The assignee"} completed the check-in` };
  }
  const reopened = Number.isFinite(closedUpTo);
  const heldBy = i.delegated?.open ? i.delegated.who : null;
  if (i.openWork.length) {
    const w = i.openWork[0];
    return {
      show: true, stage: "FIXING", reopened,
      whyHere: `Round ${i.rounds} is still being fixed${w.who ? ` (${w.who} has it)` : ""}.`,
      nextAction: `Finish the fix: ${w.title}`,
      owner: heldBy ?? w.who, settlesAt: null,
    };
  }
  const from = i.lastFixAt && i.lastFixAt > i.latestRoundAt ? i.lastFixAt : i.latestRoundAt;
  const settlesAt = new Date(from.getTime() + SETTLE_QUIET_DAYS * DAY);
  if (!heldBy && i.now >= settlesAt) {
    return { show: false, why: `Settled: no new ask for ${SETTLE_QUIET_DAYS} days after the last fix` };
  }
  return {
    show: true, stage: "CONFIRM", reopened,
    whyHere: `${i.rounds === 2 ? "Both rounds are" : `All ${i.rounds} rounds are`} fixed, and nobody has confirmed ${i.clientFirst} is happy or recorded why it took ${i.rounds} rounds.`,
    nextAction: `Confirm ${i.clientFirst} is happy`,
    owner: heldBy, settlesAt: heldBy ? null : settlesAt,
  };
}

/** Is a closed one-off signal (a cancellation, a refund) still closed? A pattern
 *  comes back when its count grows past the count it was closed at. */
export function signalClosed(closure: SignalClosure | null, evidence: { atISO?: string | null; count?: number | null }): boolean {
  if (!closure) return false;
  if (evidence.count != null) return closure.upToCount != null && evidence.count <= closure.upToCount;
  if (evidence.atISO && closure.upToISO) return Date.parse(evidence.atISO) <= Date.parse(closure.upToISO);
  return true;
}
