// ---------------------------------------------------------------------------
// THE ONE PLANNING READER — the pure half (R01, unified handoff Sep 25 2026).
//
// "2 chosen but 3 need answers" was the TEST portal's own Home. Three readers
// answered "what does this month still need from the client?" and each had
// its own idea of which topics counted:
//   · portalHome.planModel counted every selected, unfilmed topic without a
//     submitted interview — a call-drafted script in review, a carried script
//     the client already approved and an extra beyond the allowance all read
//     as "needs your answers";
//   · the allowance itself had THREE overflow rules — count-based in
//     portalTopics / monthCapacity (PROPOSED included), a row flag frozen at
//     insert in monthProgress (PROPOSED excluded), and a contentTopic.monthId
//     union that put every extra back into "selected";
//   · recalcProgramMonth read contentTopic.monthId, so an unanswered EXTRA held
//     the written route's filming calendar shut and drove answer reminders.
//
// This file is the rule, stated once and pure (no server-only, no Prisma) so a
// client component, a drill and the server all read the same function:
//   · allowanceOrder — which selections are the month's allowance (IN) and
//     which are extras. Derived on every read; the stored row flag is ignored.
//   · topicPlanStep  — where ONE topic stands, in the client's terms.
//   · monthPlanning  — the month: chosen, extras, what is owed, one headline.
// planningFacts.ts is the server half: it loads the facts in a fixed number
// of queries and hands them here. Every surface — portal Home, Your Month,
// the topic bank, the staff month reader, the filming gate, the drafting
// sweep — asks planningFacts, so the numbers cannot disagree again.
// ---------------------------------------------------------------------------

export type PlanningRoute = "CALL" | "WRITTEN" | "UNDECIDED";
/** The month's strategy call as planning needs it: none on file, booked, or held. */
export type CallState = "NONE" | "BOOKED" | "HELD";
export type AllowanceSlot = "IN" | "EXTRA";

/** A live month selection (or a legacy topic pointer read as one). */
export type AllowanceSelection = {
  topicId: string;
  /** ContentTopicSelection.status: CARRIED | SELECTED | RECONCILED | PROPOSED */
  status: string;
  rank?: number | null;
  createdAt?: Date | string | number | null;
};

// CARRIED first — a retained, unfilmed script consumes a slot before anything
// new does (§6.3: "Retained carryover scripts consume slots first"). Then what
// a person chose, in their order. A call's PROPOSED suggestion comes last: it
// is not the month's plan until somebody reconciles it.
const GROUP = (status: string): number => (status === "CARRIED" ? 0 : status === "PROPOSED" ? 2 : 1);
const rankOf = (r: number | null | undefined): number => (typeof r === "number" && Number.isFinite(r) ? r : Number.MAX_SAFE_INTEGER);
const timeOf = (d: AllowanceSelection["createdAt"]): number => {
  if (d == null) return Number.MAX_SAFE_INTEGER;
  const t = d instanceof Date ? d.getTime() : typeof d === "number" ? d : Date.parse(d);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
};

/**
 * Which selections are the month's allowance. The first `videosOwed` in
 * allowance order are IN, the rest are EXTRA — kept, shown, never deleted, and
 * never asked about until they get a slot. The count is the same arithmetic
 * monthCapacity has always done (total − owed); what this adds is WHICH rows,
 * so the header, the per-row "extra" tag and the "needs answers" list agree.
 */
export function allowanceOrder(sels: readonly AllowanceSelection[], videosOwed: number): Map<string, AllowanceSlot> {
  const owed = Math.max(0, Math.floor(videosOwed) || 0);
  const seen = new Set<string>();
  const unique = sels.filter((s) => (seen.has(s.topicId) ? false : (seen.add(s.topicId), true)));
  const ordered = [...unique].sort((a, b) =>
    GROUP(a.status) - GROUP(b.status) || rankOf(a.rank) - rankOf(b.rank) || timeOf(a.createdAt) - timeOf(b.createdAt) || a.topicId.localeCompare(b.topicId));
  return new Map(ordered.map((s, i) => [s.topicId, i < owed ? "IN" : "EXTRA"] as const));
}

// ---------------------------------------------------------------------------
// ONE TOPIC
// ---------------------------------------------------------------------------

/**
 * Where a topic stands, in the order a client would ask about it. Each maps to
 * one plain sentence in portalWords.PLAN_STEP_WORDS.
 *   FILMED            footage exists (a confirmation or a video past filming)
 *   EXTRA             beyond the allowance — waits its turn
 *   APPROVED          they approved the shared version (or an import on THIS month)
 *   CHANGES_REQUESTED they asked for changes on the shared version
 *   READY_FOR_YOU     shared, no decision on this version yet
 *   TEAM_REVIEW       a script exists and is not released (draft, review, withheld)
 *   CONFIRMING        a call PROPOSED it; staff have not reconciled it
 *   WRITING           the material is in (answers sent and sufficient, or the call carried it),
 *                     or a held call we have not finished reading — the team's move either way
 *   NEEDS_MORE        a genuine gap: a follow-up, a thin send, or a call we READ that left nothing
 *   ON_CALL           the call route, call not held yet — the call covers it
 *   CHOSEN            the route is not chosen yet and nothing is started
 *   NEEDS_ANSWERS     the written route: the questions are theirs to answer
 */
export const PLAN_STEPS = [
  "FILMED", "EXTRA", "APPROVED", "CHANGES_REQUESTED", "READY_FOR_YOU", "TEAM_REVIEW",
  "CONFIRMING", "WRITING", "NEEDS_MORE", "ON_CALL", "CHOSEN", "NEEDS_ANSWERS",
] as const;
export type PlanStep = (typeof PLAN_STEPS)[number];

export type TopicPlanFacts = {
  topicId: string;
  title?: string | null;
  /** The month selection's status (a legacy pointer reads as SELECTED). */
  selectionStatus: string;
  rank?: number | null;
  selectedAt?: Date | string | number | null;
  /** Footage exists for the topic — never inferred from an appointment date. */
  filmed: boolean;
  /**
   * This month's script for the topic. `importedHere` is a historical import
   * attached to THIS month (material that was written outside the hub); an
   * import filed against another month is not passed at all, so it can never
   * hide a new gap. `hubScript` is a non-historical row: something is being
   * written. `released` is postingKit.scriptVisibility's "released";
   * `decidable` = a shared version id the client's decision can bind to.
   */
  script: {
    importedHere: boolean;
    hubScript: boolean;
    released: boolean;
    decidable: boolean;
    decision: "APPROVED" | "CHANGES_REQUESTED" | null;
  } | null;
  /** This month's interview: its status, the gaps it stored, its stored sufficiency (null = none stored). */
  interview: { status: string; missing: number; sufficient: boolean | null } | null;
  /** Speaker-tagged client/Jordan lines from THIS month's call, after the confidentiality scrub. */
  callExcerpts: number;
};

export type TopicPlanContext = {
  route: PlanningRoute;
  call: CallState;
  inAllowance: boolean;
  /**
   * The month's held call has been READ (its transcript analysed), so a topic
   * with no call material really was not covered. Absent = not read: a
   * transcript still waiting, a pasted one, transcript jobs switched off —
   * none of which says anything about what the client told us.
   */
  callRead?: boolean;
};
export type TopicPlan = { step: PlanStep; missing: number };

const STARTED = (status: string | undefined) => !!status && status !== "NOT_STARTED" && status !== "ABANDONED";

export function topicPlanStep(f: TopicPlanFacts, ctx: TopicPlanContext): TopicPlan {
  const at = (step: PlanStep, missing = 0): TopicPlan => ({ step, missing });
  if (f.filmed) return at("FILMED");
  if (!ctx.inAllowance) return at("EXTRA");
  const s = f.script;
  if (s?.hubScript) {
    if (s.released) {
      // Shared before versions existed: there is no version for a decision to
      // bind to, so nothing is left for the client to do on it.
      if (!s.decidable || s.decision === "APPROVED") return at("APPROVED");
      return at(s.decision === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : "READY_FOR_YOU");
    }
    return at("TEAM_REVIEW");
  }
  if (s?.importedHere) return at("APPROVED");
  if (f.selectionStatus === "PROPOSED") return at("CONFIRMING");

  const iv = f.interview;
  const started = STARTED(iv?.status);
  // Sent and sufficient — the same test the filming gate uses (topicMaterialReady).
  if (iv?.status === "SUBMITTED" && iv.sufficient !== false) return at("WRITING");
  const gaps = !!iv && (iv.status === "NEEDS_FOLLOWUP" || iv.status === "SUBMITTED_WITH_GAPS" || (iv.status === "SUBMITTED" && iv.sufficient === false));
  if (gaps) return at("NEEDS_MORE", Math.max(1, iv!.missing));
  // The call already carried it: no questionnaire (A14). The same order the
  // drafting sweep reads — an interview they started wins over the excerpts.
  if (f.callExcerpts > 0 && !started) return at("WRITING");
  if (ctx.route === "CALL") {
    // Before the call, the call covers it. After it, a topic with no material
    // is a genuine gap ONLY once the call has been read: until then the
    // material is simply not captured yet, and asking would send the client
    // back through questions they just talked through (§6.5). That wait is
    // the team's — reading the call — so it reads WRITING, never a client ask.
    // (Batch-2 review, Sep 25 2026: a held call with transcript jobs off put
    // "Answer the questions for 2 topics" on the live v1 Home.) Gaps the
    // interview itself stored are asked above whatever the call's state.
    if (ctx.call !== "HELD") return at("ON_CALL");
    return ctx.callRead ? at("NEEDS_MORE", iv?.missing ?? 0) : at("WRITING");
  }
  if (ctx.route === "UNDECIDED" && !started) return at("CHOSEN");
  return at("NEEDS_ANSWERS");
}

// ---------------------------------------------------------------------------
// THE MONTH
// ---------------------------------------------------------------------------

export type PlanningHeadlineKey = PlanStep | "PICK" | "DONE" | "EMPTY";

export type MonthPlanning = {
  route: PlanningRoute;
  call: CallState;
  videosOwed: number;
  /** Selections inside the allowance. */
  chosen: number;
  /** Selections beyond it — kept, waiting their turn. */
  extras: number;
  /** Topics per step. An extra reads EXTRA (or FILMED once filmed — footage is footage); every other step counts IN topics. */
  counts: Record<PlanStep, number>;
  /** IN topics whose answers the client still owes (NEEDS_ANSWERS + NEEDS_MORE). */
  answersOwed: number;
  /** Sum of the known gaps across NEEDS_MORE topics (0 when unknown). */
  missingAnswers: number;
  /** IN topics with an approved script or already filmed. */
  approved: number;
  topics: { topicId: string; step: PlanStep; missing: number; inAllowance: boolean }[];
  /** One sentence for the month — the client's own next thing first, then what we are doing. */
  headline: { key: PlanningHeadlineKey; text: string };
  /** Precise progress, e.g. "2 of 4 scripts approved"; null before anything is chosen. */
  progress: string | null;
};

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function emptyCounts(): Record<PlanStep, number> {
  return Object.fromEntries(PLAN_STEPS.map((s) => [s, 0])) as Record<PlanStep, number>;
}

export function monthPlanning(facts: readonly TopicPlanFacts[], ctx: { route: PlanningRoute; call: CallState; videosOwed: number; callRead?: boolean }): MonthPlanning {
  const owed = Math.max(0, Math.floor(ctx.videosOwed) || 0);
  const slots = allowanceOrder(facts.map((f) => ({ topicId: f.topicId, status: f.selectionStatus, rank: f.rank ?? null, createdAt: f.selectedAt ?? null })), owed);
  const counts = emptyCounts();
  const topics: MonthPlanning["topics"] = [];
  let missingAnswers = 0;
  for (const f of facts) {
    if (topics.some((t) => t.topicId === f.topicId)) continue;
    const inAllowance = slots.get(f.topicId) === "IN";
    const p = topicPlanStep(f, { route: ctx.route, call: ctx.call, inAllowance, callRead: ctx.callRead });
    counts[p.step]++;
    if (p.step === "NEEDS_MORE") missingAnswers += p.missing;
    topics.push({ topicId: f.topicId, step: p.step, missing: p.missing, inAllowance });
  }
  const chosen = topics.filter((t) => t.inAllowance).length;
  const extras = topics.length - chosen;
  const answersOwed = counts.NEEDS_ANSWERS + counts.NEEDS_MORE;
  const approved = counts.APPROVED + topics.filter((t) => t.inAllowance && t.step === "FILMED").length;
  const target = owed || chosen;
  return {
    route: ctx.route, call: ctx.call, videosOwed: owed, chosen, extras, counts, answersOwed, missingAnswers, approved, topics,
    headline: headlineFor({ route: ctx.route, call: ctx.call, owed, chosen, counts, answersOwed, missingAnswers, approved }),
    progress: chosen === 0 ? null : `${approved} of ${n(target, "script")} approved`,
  };
}

function headlineFor(m: { route: PlanningRoute; call: CallState; owed: number; chosen: number; counts: Record<PlanStep, number>; answersOwed: number; missingAnswers: number; approved: number }): MonthPlanning["headline"] {
  const c = m.counts;
  const h = (key: PlanningHeadlineKey, text: string) => ({ key, text });
  // The client's own next thing first — the order Home ranks them in.
  if (c.READY_FOR_YOU > 0) return h("READY_FOR_YOU", c.READY_FOR_YOU === 1 ? "A script is ready for your review" : `${c.READY_FOR_YOU} scripts are ready for your review`);
  if (m.answersOwed > 0) {
    if (c.NEEDS_ANSWERS === 0 && c.NEEDS_MORE === 1 && m.missingAnswers <= 1) return h("NEEDS_MORE", "We need one more answer");
    return h(c.NEEDS_ANSWERS > 0 ? "NEEDS_ANSWERS" : "NEEDS_MORE", `We need your answers for ${n(m.answersOwed, "topic")}`);
  }
  if (c.CHOSEN > 0) return h("CHOSEN", "Choose how you'd like to plan this month");
  if (m.route === "CALL" && m.call === "NONE" && m.chosen < Math.max(1, m.owed)) return h("ON_CALL", "Book your strategy call — we'll choose your topics on it");
  if (m.owed > 0 && m.chosen === 0) {
    return m.route === "CALL" ? h("ON_CALL", "We'll choose your topics together on your call") : h("PICK", `Choose ${n(m.owed, "topic")} for this month`);
  }
  if (m.chosen < m.owed && m.route !== "CALL") return h("PICK", `${m.chosen} of ${n(m.owed, "topic")} chosen`);
  // Then what we are doing.
  if (c.CHANGES_REQUESTED > 0) return h("CHANGES_REQUESTED", "We're making the changes you asked for");
  if (c.WRITING > 0) return h("WRITING", "We're writing your scripts");
  if (c.TEAM_REVIEW > 0) return h("TEAM_REVIEW", "Our team is reviewing your scripts");
  if (c.CONFIRMING > 0) return h("CONFIRMING", "We're confirming the topics from your call");
  if (c.ON_CALL > 0) return h("ON_CALL", "We'll plan these on your call");
  if (m.chosen === 0) return h("EMPTY", "Nothing planned for this month yet");
  const filmedAll = c.FILMED > 0 && c.APPROVED === 0;
  return h("DONE", filmedAll ? "Filmed — we're editing your videos" : `All ${n(m.chosen, "script")} approved`);
}
