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
  | "SCRIPTS_READY" | "STRATEGY_READY" | "SESSION_REQUEST_FOLLOWUP" | "DIGEST" | "ESCALATION"
  | "CONFIRM_ADDRESS" | "APPROVE_SCRIPTS";

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
  /** REVIEW_WORK (CP-02): the earliest open review window's PERSISTED deadline,
   *  in words ("Thu, Oct 1, 5:00 PM ET") — the same instant the portal shows and
   *  enforcement uses. Set only while revision_policy is on; null = no sentence. */
  reviewDeadline?: string | null;
  /** REVIEW_WORK: review_auto_approve is on, so the email says what expiry does. */
  reviewAutoApprove?: boolean;
  /** CONFIRM_ADDRESS (CP-05): "Monday, October 5 at 10:00 AM ET". */
  sessionWhen?: string | null;
  /** CONFIRM_ADDRESS: the general area on file ("West Chester, PA"), or null. */
  areaText?: string | null;
  /** CONFIRM_ADDRESS: THIS session's address form — never the portal sign-in link. */
  addressLink?: string | null;
  /** APPROVE_SCRIPTS (6.5, Sep 25 2026): the session, in words ("Thursday, October 8"). */
  sessionDay?: string | null;
  /** APPROVE_SCRIPTS: the approval deadline, 24 hours before filming, in words ("Wednesday, October 7 at 10:00 AM ET"). */
  approvalDeadline?: string | null;
  /** STRATEGY_READY v2 (6.2, Sep 25 2026), composed at send time: the first
   *  monthly strategy call already on the books, in words ("Tuesday, October 6
   *  at 2:00 PM ET"), or null. */
  firstCallAtET?: string | null;
  /** STRATEGY_READY v2: where to book that call when none is booked. */
  callLink?: string | null;
  /** STRATEGY_READY v2: the brand setup items still missing, in plain words
   *  ("logo", "brand colors"); empty or null = setup is complete, no step. */
  setupMissing?: string[] | null;
  /** STRATEGY_READY v2: an UPDATED strategy for a client who already had one
   *  released — no "first strategy call" step (that was long ago). */
  strategyUpdate?: boolean;
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
/** Kyle's line (Jordan, Sep 24 2026). A literal here because this module stays
 *  pure (no server imports); the same number is reviewWindows.URGENT_CONTACT. */
const KYLE_LINE = "(215) 645-4889";

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
  // v2 (CP-02): quotes the review deadline — only when the caller hands one
  // over, which it does only while revision_policy is on — and, only when
  // automatic approval is on, what happens if nobody answers. With neither it
  // says what v1 said. No em dashes: a client reads it.
  "reminder.review_work.v2": {
    id: "reminder.review_work.v2",
    action: "REVIEW_WORK",
    version: "2",
    purpose: "Cuts have been shared for approval and are waiting on the client (quotes the review deadline when review deadlines are on).",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        `${v.itemCount === 1 ? "A new cut is" : `${v.itemCount} new cuts are`} waiting for your review in your portal. Approve ${v.itemCount === 1 ? "it" : "them"} or tell us what to change, and we'll take it from there: ${v.portalLink}`,
        ...(v.reviewDeadline
          ? ["", `Please review by ${v.reviewDeadline} (review windows count business days, Monday to Friday).${v.reviewAutoApprove ? ` If we haven't heard from you by then, ${v.itemCount === 1 ? "that version is" : "those versions are"} approved automatically.` : ""}`]
          : []),
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
  // CP-05. No em dashes anywhere in it (Jordan's rule), including the sign-off,
  // which is why it does not reuse SIGN_OFF.
  "reminder.confirm_address.v1": {
    id: "reminder.confirm_address.v1",
    action: "CONFIRM_ADDRESS",
    version: "1",
    purpose: "A session booked with only a general area: the exact address, via that session's own link (48 hours before, Friday for Monday).",
    render: (v) =>
      [
        `Hi ${v.firstName},`,
        "",
        `Your filming session is ${v.sessionWhen ?? "coming up"}. ${v.areaText ? `So far we have ${v.areaText} as the location.` : "So far we only have a general area for it."} Add the exact address here so your videographer knows exactly where to go: ${v.addressLink ?? v.portalLink}`,
        "",
        "A good spot has plenty of natural light, room to move around, and says something about the market you work in.",
        "",
        `If anything changes within 24 hours of the session, call or text Kyle at ${KYLE_LINE}.`,
        "",
        "Jordan and the RealTour Pilot team",
        "(Reply to this email and it comes straight to us.)",
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

/** "logo, headshot and brand colors" — a plain list for a sentence. */
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// v2 (6.2, Sep 25 2026): Jordan's "Your Content Strategy is Ready + Next
// Steps" (the subject is outbox.subjectFor's). Numbered next steps: read it and
// suggest changes on the page; the first strategy call, booked or to book; and
// the brand setup, only while something is missing. No em dashes anywhere,
// sign-off included (Jordan's rule for anything a client reads). v1 is kept
// for the ledger's history only: it is RETIRED below, because its body cannot
// go out under v2's subject.
REMINDER_TEMPLATES["strategy_ready.v2"] = {
  id: "strategy_ready.v2",
  action: "STRATEGY_READY",
  version: "2",
  purpose: "The approved content strategy was released to the client's portal, with the next steps: read it, the first strategy call, and brand setup.",
  render: (v) => {
    const call = v.strategyUpdate
      ? (v.firstCallAtET ? [`Your next strategy call is booked for ${v.firstCallAtET}.`] : [])
      : [v.firstCallAtET
        ? `Your first strategy call is booked for ${v.firstCallAtET}. That's where we plan your first month of videos together.`
        // The link ends its line: a period straight after a URL breaks it in some mail apps.
        : `Book your first strategy call, where we plan your first month of videos together${v.callLink ? `: ${v.callLink}` : ". You can book it from your portal."}`];
    const steps = [
      `Read your strategy: ${v.portalLink}\n   If anything needs adjusting, suggest it right on that page and we'll take care of it.`,
      ...call,
      ...(v.setupMissing?.length ? [`Add your ${andList(v.setupMissing)} in your portal so your ${v.strategyUpdate ? "" : "first "}videos match your look. It only takes a few minutes.`] : []),
    ];
    return [
      `Hi ${v.firstName},`,
      "",
      v.strategyUpdate ? "Your content strategy has been updated. It's the foundation every month's topics and scripts are built on." : "Your content strategy is ready. It's the foundation every month's topics and scripts are built on.",
      "",
      "Here's what's next:",
      "",
      ...steps.flatMap((t, i) => [`${i + 1}. ${t}`, ""]),
      "Jordan and the RealTour Pilot team",
      "(Reply to this email and it comes straight to us.)",
    ].join("\n");
  },
};

// 6.5 (Sep 25 2026, Jordan's answer): ONE email, 48 elapsed hours before the
// session (moved into office hours, Friday for a Monday shoot), asking for the
// scripts to be approved by 24 hours before filming — and saying plainly that
// the session goes ahead either way. It never threatens a cancellation because
// there is none. No em dashes (Jordan's rule for anything a client reads).
REMINDER_TEMPLATES["reminder.approve_scripts.v1"] = {
  id: "reminder.approve_scripts.v1",
  action: "APPROVE_SCRIPTS",
  version: "1",
  purpose: "Scripts shared for a coming filming session have not been approved: one email 48 hours before, deadline 24 hours before, the shoot goes ahead either way.",
  render: (v) =>
    [
      `Hi ${v.firstName},`,
      "",
      `Please read and approve your ${v.titles.length === 1 ? "script" : "scripts"} for ${v.sessionDay ?? "your filming session"}${v.approvalDeadline ? ` by ${v.approvalDeadline}` : ""}:`,
      list(v.titles),
      "",
      `We film either way. Approving now means the video matches the words you chose, and if something should change, tell us on the same page: ${v.portalLink}`,
      "",
      "Jordan and the RealTour Pilot team",
      "(Reply to this email and it comes straight to us.)",
    ].join("\n"),
};

/** The default template id per action — the policy JSON (`templates`) may point an action at a newer version. */
export const DEFAULT_TEMPLATE_IDS: Record<Exclude<ReminderAction, "DIGEST" | "ESCALATION" | "SESSION_REQUEST_FOLLOWUP">, string> = {
  CHOOSE_PATH: "reminder.choose_path.v1",
  BOOK_CALL: "reminder.book_call.v1",
  COMPLETE_ANSWERS: "reminder.complete_answers.v1",
  BOOK_SESSION: "reminder.book_session.v1",
  REVIEW_WORK: "reminder.review_work.v2",
  SCRIPTS_READY: "scripts_ready.v1",
  STRATEGY_READY: "strategy_ready.v2",
  CONFIRM_ADDRESS: "reminder.confirm_address.v1",
  APPROVE_SCRIPTS: "reminder.approve_scripts.v1",
};

/** Resolve a template by id, refusing an id nobody has (a typo in the policy
 *  JSON must fail the validation, never send a blank email). */
export function reminderTemplate(id: string): ReminderTemplate {
  const t = REMINDER_TEMPLATES[id];
  if (!t) throw new Error(`Unknown reminder template "${id}".`);
  return t;
}

/**
 * Template ids that may no longer be sent, and what replaces each. A body
 * whose SUBJECT moved on cannot go out under it: outbox.subjectFor names the
 * strategy notice "Your Content Strategy is Ready + Next Steps" (v2's words),
 * and v1 has no next steps. A saved reminders policy keeps a full copy of the
 * template map from the day it was saved, so a v1 pinned there is a stale
 * default, not a choice — and a notice queued before v2 existed is not sent
 * yet, so nothing that already went out changes. The row stays for history.
 * (Batch-2 review, Sep 25 2026.)
 */
export const RETIRED_TEMPLATE_IDS: Readonly<Record<string, string>> = { "strategy_ready.v1": "strategy_ready.v2" };
/** The id a send renders: a retired id resolves to its replacement. */
export const sendableTemplateId = (id: string): string => RETIRED_TEMPLATE_IDS[id] ?? id;

/** The template for an action, honouring the policy's overrides (a retired id resolves to its replacement). */
export function templateForAction(action: keyof typeof DEFAULT_TEMPLATE_IDS, overrides?: Record<string, unknown> | null): ReminderTemplate {
  const chosen = sendableTemplateId(overrides && typeof overrides[action] === "string" ? (overrides[action] as string) : DEFAULT_TEMPLATE_IDS[action]);
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
