// ---------------------------------------------------------------------------
// REMINDER TEMPLATES (spec §24, §22, §21) — W2-F, Sep 17 2026.
//
// Pure module: no prisma, no "server-only", so the settings panel can preview
// a template, a probe can render one, and the evaluator can stamp the exact
// template id + version it used on the ProgramReminder row (templateKey /
// templateVersion). Wording starts from the spec's own example ("Hi
// {firstName}, we still need to plan your {month} content…") and is plain
// text: the outbox email rail sends the body as-is under a subject the kind
// derives (outbox.subjectFor), so nothing here is HTML.
//
// Rules the templates enforce, not the caller:
//   · the no-call option is a SEPARATE sentence that only renders when
//     `noCallEligible` is true (spec: "Only include the no-call option for
//     eligible clients") — a REQUIRED-call client never reads it;
//   · a session paragraph rides along in a digest only when asked for, and
//     it never carries its own CTA — the main CTA is the planning action;
//   · the "We'd love to have it planned by <date>" sentence renders ONLY when
//     the caller hands over a date. No template invents one and none derives
//     it from a milestone — a date a client is promised is Jordan's to set
//     (F20 review, Sep 21 2026);
//   · {portalLink} is whatever the evaluator minted: an authenticated sign-in
//     link for a person, or the enrollment's token link for a token-era client.
//     The template never invents a URL.
//   · every template ends with the same sign-off so a reply lands on the
//     company inbox the outbox sends from (info@realtourpilot.com).
// ---------------------------------------------------------------------------

export type ReminderAction =
  | "CHOOSE_PATH" | "BOOK_CALL" | "COMPLETE_ANSWERS" | "BOOK_SESSION" | "REVIEW_WORK"
  | "SCRIPTS_READY" | "STRATEGY_READY" | "SESSION_REQUEST_FOLLOWUP" | "DIGEST" | "ESCALATION";

export type TemplateVars = {
  firstName: string;
  /** "October" — the month being planned / filmed. */
  month: string;
  portalLink: string;
  /** The Calendly booking page for the monthly strategy call. */
  bookCallLink: string | null;
  /** Whether "plan without a call" may be offered to THIS client for THIS month. */
  noCallEligible: boolean;
  /** COMPLETE_ANSWERS: the client has started the preparation questions (vs. nothing chosen yet). */
  answersStarted: boolean;
  /** Digest: the session paragraph, when both appointments are outstanding. */
  sessionNote: string | null;
  /** BOOK_SESSION: the earliest the session may start ("Thursday, October 2"), when known. */
  earliestSession: string | null;
  /** REVIEW_WORK: how many cuts are waiting. */
  itemCount: number;
  /** SCRIPTS_READY / STRATEGY_READY: the titles released in this batch (already deduplicated). */
  titles: string[];
  /** SCRIPTS_READY: titles that were UPDATED after an earlier share. */
  updatedTitles: string[];
  /** THE ONE DATE A CLIENT IS PROMISED, in words ("October 20"), or null for
   *  no deadline sentence at all — which is the default. It is never the
   *  evaluator's internal escalation clock or a milestone date: those move with
   *  the calendar, and a promise a client reads must not move with them. The
   *  caller passes it only when Jordan has deliberately set one
   *  (quotedPlanningDeadlineDayOfMonth, F20 review, Sep 21 2026). */
  deadline: string | null;
};

export type ReminderTemplate = {
  id: string;
  action: ReminderAction;
  version: string;
  /** One line for the settings panel. */
  purpose: string;
  render: (v: TemplateVars) => string;
};

const SIGN_OFF = "— Jordan & the RealTour Pilot team\n(Reply to this email and it comes straight to us.)";

const noCallLine = (v: TemplateVars) =>
  v.noCallEligible
    ? " Or, if you'd rather skip the call this month, you can choose your topics and answer the preparation questions in your portal instead."
    : "";

const deadlineLine = (v: TemplateVars) => (v.deadline ? ` We'd love to have it planned by ${v.deadline} so your filming session lands on time.` : "");

const sessionParagraph = (v: TemplateVars) => (v.sessionNote ? `\n\n${v.sessionNote}` : "");

const list = (titles: string[]) => titles.map((t) => `  • ${t}`).join("\n");

export const REMINDER_TEMPLATES: Record<string, ReminderTemplate> = {
  "reminder.choose_path.v1": {
    id: "reminder.choose_path.v1",
    action: "CHOOSE_PATH",
    version: "1",
    purpose: "Planning is open and the client has not chosen a call or the written path (call optional).",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        `We still need to plan your ${v.month} content. You can book your strategy call${v.bookCallLink ? ` here: ${v.bookCallLink}` : " from your portal"}.${noCallLine(v)}${deadlineLine(v)}`,
        "",
        `Your portal: ${v.portalLink}${sessionParagraph(v)}`,
        "",
        SIGN_OFF,
      ].join("\n"),
  },
  "reminder.book_call.v1": {
    id: "reminder.book_call.v1",
    action: "BOOK_CALL",
    version: "1",
    purpose: "A strategy call is required for the month and none is booked.",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        `We still need to plan your ${v.month} content — grab a time for your strategy call${v.bookCallLink ? ` here: ${v.bookCallLink}` : " from your portal"}.${deadlineLine(v)}`,
        "",
        `You can see where ${v.month} stands in your portal: ${v.portalLink}${sessionParagraph(v)}`,
        "",
        SIGN_OFF,
      ].join("\n"),
  },
  "reminder.complete_answers.v1": {
    id: "reminder.complete_answers.v1",
    action: "COMPLETE_ANSWERS",
    version: "1",
    purpose: "The client chose the written path and the preparation questions are not finished.",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        v.answersStarted
          ? `Your ${v.month} preparation questions are part-way done — they're the last step before we write your scripts, and they pick up right where you left off: ${v.portalLink}${deadlineLine(v)}${sessionParagraph(v)}`
          : `The next step for ${v.month} is choosing your topics and answering the short preparation questions in your portal — about ten minutes, and we write your scripts from them: ${v.portalLink}${deadlineLine(v)}${sessionParagraph(v)}`,
        "",
        SIGN_OFF,
      ].join("\n"),
  },
  "reminder.book_session.v1": {
    id: "reminder.book_session.v1",
    action: "BOOK_SESSION",
    version: "1",
    purpose: "Preparation is done and no content session is booked or requested.",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        `Your ${v.month} content is planned — the next step is booking your filming session.${v.earliestSession ? ` The earliest slot we can film is ${v.earliestSession} (that gives us time to finish your scripts).` : ""} Pick a time in your portal and we'll confirm it: ${v.portalLink}`,
        "",
        SIGN_OFF,
      ].join("\n"),
  },
  "reminder.review_work.v1": {
    id: "reminder.review_work.v1",
    action: "REVIEW_WORK",
    version: "1",
    purpose: "Cuts have been shared for approval and are waiting on the client.",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        `${v.itemCount === 1 ? "A new cut is" : `${v.itemCount} new cuts are`} waiting for your review in your portal — approve ${v.itemCount === 1 ? "it" : "them"} or tell us what to change, and we'll take it from there: ${v.portalLink}`,
        "",
        SIGN_OFF,
      ].join("\n"),
  },
  "scripts_ready.v1": {
    id: "scripts_ready.v1",
    action: "SCRIPTS_READY",
    version: "1",
    purpose: "Approve & share: the scripts Jordan just released (one email per batch).",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        `${v.titles.length === 1 ? "Your script for" : `${v.titles.length} scripts for`} ${v.month} ${v.titles.length === 1 ? "is" : "are"} ready in your portal:`,
        list(v.titles),
        ...(v.updatedTitles.length ? ["", `Updated since you last saw ${v.updatedTitles.length === 1 ? "it" : "them"}:`, list(v.updatedTitles)] : []),
        "",
        `Read ${v.titles.length === 1 ? "it" : "them"} here: ${v.portalLink}`,
        "",
        SIGN_OFF,
      ].join("\n"),
  },
  "strategy_ready.v1": {
    id: "strategy_ready.v1",
    action: "STRATEGY_READY",
    version: "1",
    purpose: "The approved content strategy was released to the client's portal.",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        `Your content strategy is ready. It's the foundation every month's topics and scripts are built on, so it's worth a read: ${v.portalLink}`,
        "",
        SIGN_OFF,
      ].join("\n"),
  },
};

/** The default template id per action — the policy JSON (`templates`) may point an action at a newer version. */
export const DEFAULT_TEMPLATE_IDS: Record<Exclude<ReminderAction, "DIGEST" | "ESCALATION" | "SESSION_REQUEST_FOLLOWUP">, string> = {
  CHOOSE_PATH: "reminder.choose_path.v1",
  BOOK_CALL: "reminder.book_call.v1",
  COMPLETE_ANSWERS: "reminder.complete_answers.v1",
  BOOK_SESSION: "reminder.book_session.v1",
  REVIEW_WORK: "reminder.review_work.v1",
  SCRIPTS_READY: "scripts_ready.v1",
  STRATEGY_READY: "strategy_ready.v1",
};

/** Resolve a template by id, refusing an id nobody has (a typo in the policy
 *  JSON must fail the validation, never send a blank email). */
export function reminderTemplate(id: string): ReminderTemplate {
  const t = REMINDER_TEMPLATES[id];
  if (!t) throw new Error(`Unknown reminder template "${id}".`);
  return t;
}

/** The template for an action, honouring the policy's overrides. */
export function templateForAction(action: keyof typeof DEFAULT_TEMPLATE_IDS, overrides?: Record<string, unknown> | null): ReminderTemplate {
  const chosen = overrides && typeof overrides[action] === "string" ? (overrides[action] as string) : DEFAULT_TEMPLATE_IDS[action];
  const t = reminderTemplate(chosen);
  if (t.action !== action) throw new Error(`Template "${chosen}" is for ${t.action}, not ${action}.`);
  return t;
}

export function renderReminder(template: ReminderTemplate, vars: TemplateVars): string {
  return template.render(vars);
}

/** "October" from "2026-10" — month names never depend on the server clock. */
export function monthName(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
}

/** The first name the way the welcome text derives it: first token of the client's name. */
export function firstNameOf(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}
