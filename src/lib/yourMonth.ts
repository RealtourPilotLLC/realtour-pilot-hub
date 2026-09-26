import type { MonthPlanning } from "@/lib/planningState";
import { CTA_WORDS, answerCta } from "@/lib/portalWords";

// ---------------------------------------------------------------------------
// YOUR MONTH — the guided plan's steps (§6.4 / §11, Sep 25 2026). Pure, so the
// page, a drill and anything else that asks "what is this client's next step
// this month?" read the same answer.
//
// Planning and scheduling used to be two pages (My Plan, Schedule) with the
// route choice tucked inside the strategy-call card, and nothing said which
// ONE thing the month needed next. The month is five steps, in the order it
// runs:
//
//   route    How would you like to plan this month's videos?
//   topics   the allowance, chosen (on the call route: together on the call)
//   answers  the written route's questions — only what is actually owed
//   call     the call route's strategy call — booked, then held
//   filming  Book filming, or Schedule later (the step stays outstanding)
//   scripts  review and approve what we wrote
//
// Each step is done, current, waiting (on us, or on a date) or still to come.
// At most ONE is current: the first step the client can act on now; a
// "Schedule later" filming step is current only when nothing else is waiting
// on them. The steps read the planning reader (R01) and the schedule month —
// no new query and no new rule.
// ---------------------------------------------------------------------------

export type YourMonthStepKey = "route" | "topics" | "answers" | "call" | "filming" | "scripts";
export type YourMonthStepState = "done" | "current" | "todo" | "waiting";
export type YourMonthStep = {
  key: YourMonthStepKey;
  state: YourMonthStepState;
  title: string;
  detail: string | null;
  cta: { label: string; href: string; external?: boolean } | null;
};

export type YourMonthInput = {
  monthLabel: string;
  planning: {
    callMode: string;
    planningMode: string;
    callStatus: string;
    callAtISO: string | null;
    noCallEligible: boolean;
    chosenAtISO: string | null;
    deferredAtISO: string | null;
  };
  month: MonthPlanning;
  /** The month's scheduling card (portalScheduleMonths), or null when the month is not open for booking. */
  schedule: {
    locked: boolean;
    reason: string;
    earliestISO: string | null;
    sessionsRequired: number;
    sessionsMissing: number;
    /** A request is waiting on the office's confirmation. */
    pendingRequest: boolean;
    capacityRemaining: number;
  } | null;
  can: { suggest: boolean; session: boolean };
  readOnly: boolean;
  hrefs: { bank: string; month: string; scripts: string; bookingUrl: string };
  timezone?: string;
};

type Raw = Omit<YourMonthStep, "state"> & { status: "done" | "action" | "deferred" | "waiting" | "todo" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function yourMonthSteps(i: YourMonthInput): YourMonthStep[] {
  const m = i.month;
  const tz = i.timezone ?? "America/New_York";
  const day = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const dayOnly = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
  const route = i.planning.planningMode === "WRITTEN" ? "WRITTEN" : i.planning.planningMode === "CALL" ? "CALL" : "UNDECIDED";
  const actSuggest = i.can.suggest && !i.readOnly;
  const actSession = i.can.session && !i.readOnly;
  const owed = m.videosOwed;
  const inTopics = m.topics.filter((t) => t.inAllowance);
  const steps: Raw[] = [];

  // ---- 1 · the route -------------------------------------------------------
  if (route === "UNDECIDED") {
    steps.push({ key: "route", status: actSession ? "action" : "waiting", title: "How would you like to plan this month's videos?", detail: "Choose your topics here, or talk them through on a call. You can switch later — nothing you've done is lost.", cta: null });
  } else {
    const first = i.planning.callMode === "REQUIRED" && route === "CALL";
    steps.push({
      key: "route", status: "done",
      title: route === "WRITTEN" ? "You're choosing your topics here" : first ? "This month is planned on a strategy call" : "You're talking your topics through on a call",
      detail: i.planning.noCallEligible && actSession ? "You can switch any time — nothing you've done is lost." : null,
      cta: null,
    });
  }

  // ---- 2 · topics ----------------------------------------------------------
  const extrasNote = m.extras > 0 ? ` · ${plural(m.extras, "extra")} waiting ${m.extras === 1 ? "its" : "their"} turn` : "";
  if (owed === 0 || m.chosen >= owed) {
    steps.push({ key: "topics", status: m.chosen > 0 || owed === 0 ? "done" : "todo", title: `${m.chosen} of ${plural(owed, "topic")} chosen${extrasNote}`, detail: null, cta: null });
  } else if (route === "CALL") {
    steps.push({
      key: "topics", status: "waiting",
      title: m.call === "HELD" ? "We're confirming the topics from your call" : "We'll choose your topics together on the call",
      detail: `${m.chosen} of ${owed} chosen so far${extrasNote}. Browsing your topic bank first is optional.`,
      cta: { label: "Browse topics", href: i.hrefs.bank },
    });
  } else {
    const left = owed - m.chosen;
    steps.push({
      key: "topics", status: actSuggest ? "action" : "waiting",
      title: m.chosen === 0 ? `Choose ${plural(owed, "topic")} for ${i.monthLabel}` : `Choose ${plural(left, "more topic")}`,
      detail: `${m.chosen} of ${owed} chosen${extrasNote}.`,
      cta: actSuggest ? { label: "Choose topics", href: i.hrefs.bank } : null,
    });
  }

  // ---- 3 · answers (written) or the call -------------------------------------
  const owedAnswers = m.answersOwed;
  const oneGap = m.counts.NEEDS_ANSWERS === 0 && m.counts.NEEDS_MORE === 1 ? m.missingAnswers : 0;
  if (route === "CALL") {
    if (m.call === "HELD") {
      steps.push(owedAnswers > 0
        ? { key: "call", status: actSuggest ? "action" : "waiting", title: oneGap === 1 ? "We need one more answer" : `We need a little more on ${plural(owedAnswers, "topic")}`, detail: "Just the questions your call didn't cover.", cta: actSuggest ? { label: answerCta(oneGap), href: i.hrefs.month } : null }
        : { key: "call", status: "done", title: "Strategy call held", detail: "Your month is planned.", cta: null });
    } else if (m.call === "BOOKED") {
      steps.push({ key: "call", status: "waiting", title: i.planning.callAtISO ? `Your call is booked for ${day(i.planning.callAtISO)}` : "Your call is booked", detail: "Filming can be booked now — you don't need to wait for the call.", cta: null });
    } else {
      // W03: "#step-call" when the booking sits inside this page; a Calendly
      // address opens in a new tab only when that is all there is.
      steps.push({ key: "call", status: actSession ? "action" : "waiting", title: "Book your strategy call", detail: "We plan the month on it, and filming opens as soon as it's booked.", cta: actSession ? { label: "Book the call", href: i.hrefs.bookingUrl, external: /^https?:/i.test(i.hrefs.bookingUrl) } : null });
    }
  } else {
    const inputsReady = m.chosen >= Math.max(1, owed);
    if (owedAnswers > 0) {
      steps.push({
        key: "answers", status: actSuggest ? "action" : "waiting",
        title: oneGap === 1 ? "We need one more answer" : `Answer the questions for ${plural(owedAnswers, "topic")}`,
        detail: "We write each script from your answers. Your progress saves as you go.",
        cta: actSuggest ? { label: answerCta(oneGap), href: i.hrefs.month } : null,
      });
    } else if (inputsReady && m.counts.CHOSEN === 0 && route === "WRITTEN") {
      steps.push({ key: "answers", status: "done", title: "Your answers are in", detail: null, cta: null });
    } else {
      steps.push({ key: "answers", status: "todo", title: "Answer a few questions for each topic", detail: route === "UNDECIDED" ? "If you plan here, we'll ask a few short questions per topic." : null, cta: null });
    }
  }

  // ---- 4 · filming ---------------------------------------------------------
  const s = i.schedule;
  if (!s) {
    steps.push({ key: "filming", status: "todo", title: CTA_WORDS.BOOK, detail: "Your next program month isn't open for booking yet.", cta: null });
  } else if (s.sessionsMissing === 0 && s.sessionsRequired > 0) {
    steps.push({ key: "filming", status: "done", title: s.sessionsRequired > 1 ? `All ${s.sessionsRequired} filming sessions are booked` : "Filming is booked", detail: null, cta: null });
  } else if (s.pendingRequest) {
    steps.push({ key: "filming", status: "waiting", title: "Filming requested", detail: "We're confirming the time with you.", cta: null });
  } else if (s.locked) {
    steps.push({ key: "filming", status: "todo", title: CTA_WORDS.BOOK, detail: s.reason || null, cta: null });
  } else if (!actSession || s.capacityRemaining <= 0) {
    steps.push({ key: "filming", status: "waiting", title: CTA_WORDS.BOOK, detail: i.readOnly ? "Booking is off while your program is paused or ended." : "The program owner books filming for this account.", cta: null });
  } else {
    const booked = s.sessionsRequired - s.sessionsMissing;
    steps.push({
      key: "filming", status: i.planning.deferredAtISO ? "deferred" : "action",
      title: s.sessionsRequired > 1 && booked > 0 ? `Book your next filming session (${booked} of ${s.sessionsRequired} booked)` : CTA_WORDS.BOOK,
      detail: i.planning.deferredAtISO
        ? "You chose to schedule later — book any time."
        : s.earliestISO ? `Sessions start on or after ${dayOnly(s.earliestISO)}.` : null,
      // The picker sits inside this step; the page's next-step button jumps to it.
      cta: { label: CTA_WORDS.BOOK, href: "#step-filming" },
    });
  }

  // ---- 5 · scripts ---------------------------------------------------------
  const ready = m.counts.READY_FOR_YOU;
  const allApproved = inTopics.length > 0 && m.chosen >= owed && inTopics.every((t) => t.step === "APPROVED" || t.step === "FILMED");
  if (ready > 0) {
    steps.push({ key: "scripts", status: actSuggest ? "action" : "waiting", title: ready === 1 ? "A script is ready for your review" : `${ready} scripts are ready for your review`, detail: m.progress, cta: { label: CTA_WORDS.REVIEW, href: i.hrefs.scripts } });
  } else if (allApproved) {
    steps.push({ key: "scripts", status: "done", title: `All ${plural(m.chosen, "script")} approved`, detail: null, cta: null });
  } else if (m.counts.CHANGES_REQUESTED + m.counts.WRITING + m.counts.TEAM_REVIEW > 0) {
    const doing = m.counts.CHANGES_REQUESTED > 0 ? "We're making the changes you asked for" : m.counts.WRITING > 0 ? "We're writing your scripts" : "Our team is reviewing your scripts";
    steps.push({ key: "scripts", status: "waiting", title: doing, detail: m.progress, cta: null });
  } else {
    steps.push({ key: "scripts", status: "todo", title: "Review your scripts", detail: route === "CALL" ? "We write them from your call, then share them here." : "We write them from your answers, then share them here.", cta: null });
  }

  // ---- one current step ------------------------------------------------------
  const currentIdx = steps.findIndex((x) => x.status === "action") >= 0 ? steps.findIndex((x) => x.status === "action") : steps.findIndex((x) => x.status === "deferred");
  return steps.map((x, idx): YourMonthStep => ({
    key: x.key, title: x.title, detail: x.detail, cta: x.cta,
    state: idx === currentIdx ? "current" : x.status === "done" ? "done" : x.status === "waiting" ? "waiting" : "todo",
  }));
}
