// ---------------------------------------------------------------------------
// THE PORTAL WELCOME EMAIL (Oct 12 2026) — pure: no prisma, no "server-only",
// so a drill, the Settings preview and the review file can render it from
// plain facts. portalAccess.composeWelcomeEmail reads the facts and calls it.
//
// Jordan, Oct 12 2026: "When someone signs up, they book their brand discovery
// call right after signing up ... They only need to book a discovery call if
// they have not yet, or if we didn't put together a content strategy for them.
// Also, the portal is so they can schedule their monthly strategy calls,
// select video topics, schedule their content sessions and review their
// content."
//
//   · The brand discovery call is a step ONLY while it is still needed: no
//     booking we can tie to them, no strategy on file (made or in progress),
//     not waived, not a client who plans their own content, and no monthly
//     strategy call already held. A booking that MAY be theirs under another
//     address keeps the conditional wording (CP-14 / §6.1).
//   · Everything else is what the portal is for, tailored to how THIS client's
//     month runs: the strategy call (or the written route when they may plan
//     without one, or no call when calls are switched off), topics, filming,
//     scripts and videos. Nothing is promised that is switched off for them.
//   · Steps are numbered from what is actually shown, so a dropped step never
//     leaves a gap. "Realtour" (lowercase t), no em dashes, links end a line.
// ---------------------------------------------------------------------------

import { SIGN_OFF_FIRST_LINE, brandProfileStep } from "@/lib/reminderTemplates";

/** Where their brand discovery call stands, as far as the welcome may say. */
export type WelcomeDiscovery =
  /** A booking tied to them, still ahead. */
  | { state: "booked"; at: Date }
  /** A booking tied to them, in the past (held). */
  | { state: "held"; at: Date }
  /** A booking that may be theirs under another address: say neither "booked" nor "book it". */
  | { state: "maybe_booked" }
  /** Nothing booked and no strategy on file: they still need to book it. */
  | { state: "needed" }
  /** A strategy is on file (or in progress), the call was waived, they plan their own content, or they are an established client. */
  | { state: "not_needed" };

/** How their month is planned — what the portal asks of them each month. */
export type WelcomePlanning =
  /** The monthly strategy call plans the month (topics chosen together on it). */
  | "CALL"
  /** A call, or choose topics and answer questions in the portal instead. */
  | "CALL_OR_WRITTEN"
  /** Strategy calls are switched off: topics and answers in the portal. */
  | "WRITTEN"
  /** They plan their own content ("we show up and shoot"). */
  | "CLIENT_PLANNED"
  /** Oct 16 2026: a bulk plan (bulkPlan.ts) — every script written and planned by
   *  session; no monthly call, topics or booking (the office books the sessions). */
  | "BULK";

export type WelcomeFacts = {
  firstName: string;
  /** The durable sign-in page (never a one-time link). */
  signInUrl: string;
  /** Oct 21 2026: the address that signs in, named in the sign-in line when known. */
  signInEmail?: string | null;
  discovery: WelcomeDiscovery;
  /** The brand discovery Calendly page, when one is mapped. */
  discoveryUrl: string | null;
  /** Their content strategy is released to the portal (readable there now). */
  strategyReady: boolean;
  planning: WelcomePlanning;
  /** CLIENT_PLANNED only: strategy calls are still on for them. */
  strategyCallsOn: boolean;
  /** Required Brand Profile items still missing, in plain words. Empty = none. */
  setupMissing: string[];
  /** Filming sessions a month on their package (Pro: 2). Absent = 1. */
  sessionsPerMonth?: number;
  /** BULK only: how many videos, how many sessions, and the first session's day. */
  bulk?: { videos: number; sessions: number; firstSessionISO: string | null } | null;
};

/**
 * Does this client still need to book a brand discovery call? The one rule the
 * welcome (and its drill) reads. Pure over the facts the loader gathers.
 */
export function discoveryStateOf(f: {
  now: Date;
  /** A booking the matcher tied to THIS client (MATCHED / CONFIRMED_BY_STAFF), not cancelled, rescheduled or a no-show. */
  booking: { at: Date } | null;
  /** A booking that may be theirs under another address. */
  candidate: boolean;
  /** Any content strategy on file for them, approved or still being written. */
  hasStrategy: boolean;
  /** The office waived discovery, or marked it not required. */
  waived: boolean;
  clientPlanned: boolean;
  /** A monthly strategy call already held: an established client, past discovery. */
  monthlyCallHeld: boolean;
}): WelcomeDiscovery {
  if (f.booking) return f.booking.at.getTime() > f.now.getTime() ? { state: "booked", at: f.booking.at } : { state: "held", at: f.booking.at };
  if (f.hasStrategy || f.waived || f.clientPlanned || f.monthlyCallHeld) return { state: "not_needed" };
  if (f.candidate) return { state: "maybe_booked" };
  return { state: "needed" };
}

const ET = "America/New_York";
const whenWords = (d: Date) =>
  `${d.toLocaleString("en-US", { timeZone: ET, weekday: "long", month: "long", day: "numeric" })} at ${d.toLocaleString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" })} Eastern`;
const dayWords = (d: Date) => d.toLocaleDateString("en-US", { timeZone: ET, month: "long", day: "numeric" });

/** The once-only steps, in order: the discovery call while needed, then the Brand Profile. */
function oneTimeSteps(f: WelcomeFacts): string[] {
  const out: string[] = [];
  // The link ends its line: a period straight after a URL breaks it in some mail apps.
  const why = "   It's the one call where we get to know you and build your content strategy.";
  if (f.discovery.state === "needed") {
    out.push(f.discoveryUrl
      ? `If you haven't booked your brand discovery call yet, book it here: ${f.discoveryUrl}\n${why}`
      : `If you haven't booked your brand discovery call yet, reply to this email and we'll find a time.\n${why}`);
  } else if (f.discovery.state === "maybe_booked") {
    out.push(f.discoveryUrl
      ? `If you've already booked your brand discovery call, you're all set and we'll confirm it with you. If not, book it here: ${f.discoveryUrl}\n${why}`
      : `If you've already booked your brand discovery call, you're all set and we'll confirm it with you. If not, reply to this email and we'll find a time.\n${why}`);
  }
  // "your first videos" only for someone whose program is just starting (no strategy to read yet).
  const brand = brandProfileStep(f.setupMissing, !f.strategyReady);
  if (brand) out.push(brand);
  return out;
}

/** What they do in the portal each month, for how THEIR month runs. */
function monthlySteps(f: WelcomeFacts): string[] {
  const n = Math.max(1, f.sessionsPerMonth ?? 1);
  const book = n > 1 ? `Book your ${n === 2 ? "two" : n} filming sessions.` : "Book your filming session.";
  const pick = n > 1 ? "You can pick times" : "You can pick a time";
  const scripts = "Read and approve your scripts before filming day.";
  const videos = "Review your videos. Approve them or tell us what to change, then download the finished ones.";
  switch (f.planning) {
    case "BULK": {
      const first = f.bulk?.firstSessionISO ? new Date(f.bulk.firstSessionISO) : null;
      return [
        `Read the scripts for your next filming session before you film${first ? `. Your first session is ${first.toLocaleDateString("en-US", { timeZone: ET, weekday: "long", month: "long", day: "numeric" })}` : ""}. Every later session's scripts are there too, so you can read ahead.`,
        "Tick a script once you've filmed it, if you like. It helps you keep your place.",
        videos,
      ];
    }
    case "CALL":
      return [
        "Book your monthly strategy call. That's where we plan the month's videos and choose your topics together.",
        `${book} ${pick} as soon as your call is booked.`,
        scripts,
        videos,
      ];
    case "CALL_OR_WRITTEN":
      return [
        // Jordan's words (Oct 12 2026).
        "Book your monthly strategy call. That's where we plan the month's videos and choose your topics together. Or skip the call and select your topics and answer a few questions here in your portal.",
        `${book} ${pick} as soon as your call is booked or your answers are in.`,
        scripts,
        videos,
      ];
    case "WRITTEN":
      return [
        "Choose your video topics and answer a few short questions about each. We write your scripts from your answers.",
        `${book} ${pick} as soon as your answers are in.`,
        scripts,
        videos,
      ];
    case "CLIENT_PLANNED":
      return [
        "Add your plan for the month if you'd like (optional). Upload it or paste your notes, and your crew will have it at the shoot.",
        ...(f.strategyCallsOn ? ["Book your monthly strategy call whenever it suits you."] : []),
        book,
        videos,
      ];
  }
}

const numbered = (steps: string[]) => steps.map((t, i) => `${i + 1}. ${t}`);

/**
 * The sign-in paragraph (Oct 21 2026). The link sits on its own line, so the
 * branded email (lib/emailHtml) makes it an "Open your portal" button, and the
 * line names the address that signs in when it is known: a copy of this email
 * can now go to a client's other address too ("Also email"), and "this email
 * address" would send that reader to one with no account.
 */
const signInLines = (url: string, email: string | null | undefined, ending: string): string[] => [
  `To sign in, open the page below and enter ${email?.trim() ? email.trim() : "this email address"}. We'll email you a one-time link, so there's ${ending}.`,
  url,
];

/** The welcome for the person who signed up (or the client's own first seat). */
export function renderWelcomeEmail(f: WelcomeFacts): string {
  const status: string[] = [];
  if (f.discovery.state === "booked") {
    status.push(`Your brand discovery call is booked for ${whenWords(f.discovery.at)}. That's where we get to know you and build your content strategy, so bring anything you'd like us to know.`, "");
  } else if (f.discovery.state === "held") {
    status.push(f.strategyReady
      ? `Thanks for your brand discovery call on ${dayWords(f.discovery.at)}. Your content strategy is built from it, and it's ready to read in your portal.`
      : `Thanks for your brand discovery call on ${dayWords(f.discovery.at)}. Your content strategy is built from it, and we'll let you know when it's ready to read in your portal.`, "");
  }
  const once = oneTimeSteps(f);
  const monthly = monthlySteps(f);
  return [
    `Hi ${f.firstName},`,
    "",
    f.planning === "BULK"
      ? `Welcome to your Realtour Pilot content portal. It's where your ${f.bulk?.videos ? `${f.bulk.videos} ` : ""}videos live: every script, grouped by filming session, your filming dates and every finished video.`
      : f.planning === "CLIENT_PLANNED"
      ? "Welcome to your Realtour Pilot content portal. It's where your content program lives: your plans for each month, your filming dates and every finished video."
      : "Welcome to your Realtour Pilot content portal. It's where your content program lives: your strategy, your video topics, your scripts, your filming dates and every finished video.",
    "",
    ...signInLines(f.signInUrl, f.signInEmail, "no password to set up"),
    "",
    ...status,
    ...(once.length
      ? ["Here's what's next:", ...numbered(once), "", f.planning === "BULK" ? "Then, for each filming session:" : "Then, each month in your portal:", ...numbered(monthly)]
      : [f.planning === "BULK" ? "Here's how it works:" : "Here's what you'll do in your portal each month:", ...numbered(monthly)]),
    "",
    "Questions? Just reply to this email and it comes straight to us.",
    "",
    SIGN_OFF_FIRST_LINE,
  ].join("\n");
}

/** The welcome for a teammate the client added (an assistant, a partner). */
export function renderTeammateWelcomeEmail(f: { firstName: string; clientName: string; signInUrl: string; signInEmail?: string | null }): string {
  return [
    `Hi ${f.firstName},`,
    "",
    `${f.clientName} added you to their Realtour Pilot content portal, so you can work on the program with them: video topics, scripts, filming dates, and reviewing the videos when they're ready.`,
    "",
    ...signInLines(f.signInUrl, f.signInEmail, "no password to set up"),
    "",
    "Anything you do in there shows up under your own name, so the team always knows who asked for what.",
    "",
    "Questions? Just reply to this email and it comes straight to us.",
    "",
    SIGN_OFF_FIRST_LINE,
  ].join("\n");
}

/** A staff invitation to an existing client portal (portalAccess.inviteClientUser). */
export function renderPortalInviteEmail(f: { firstName: string; clientName: string; signInUrl: string; signInEmail?: string | null }): string {
  return [
    `Hi ${f.firstName},`,
    "",
    `You now have access to the ${f.clientName} content portal with Realtour Pilot. The strategy, video topics, scripts, filming dates and finished videos are all in one place.`,
    "",
    ...signInLines(f.signInUrl, f.signInEmail, "no password to remember"),
    "",
    "Questions? Just reply to this email and it comes straight to us.",
    "",
    SIGN_OFF_FIRST_LINE,
  ].join("\n");
}

/** The one-time sign-in link a person asked for on /portal/login (15 minutes). */
export function renderSignInLinkEmail(f: { firstName: string; url: string }): string {
  return [
    `Hi ${f.firstName},`,
    "",
    "Here's your one-time link to sign in to your Realtour Pilot content portal:",
    f.url,
    "",
    "It works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email and nothing changes.",
    "",
    "The Realtour Pilot team",
  ].join("\n");
}
