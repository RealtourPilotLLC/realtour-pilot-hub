import type { AutomationKey } from "@/lib/programAutomation";
import { PROGRAM_PILOT_GROUPS, type ProgramReachOp } from "@/lib/programRolloutCore";

// ---------------------------------------------------------------------------
// CLIENT ONBOARDING — the words and the rules, pure (Oct 5 2026).
//
// Jordan, Oct 5: "All of them but not yet. I will turn it on and send
// onboarding stuff — just give me a control panel to do that. I'll do each
// client one by one … and I can customize what gets sent or not sent." And:
// "Don't even send anything. I will send it."
//
// So Settings → Client onboarding (src/app/settings/onboarding) walks ONE
// client at a time through seven steps, and everything that could reach the
// client is a press of Jordan's:
//   · the per-client toggles (step 3, and bookings in step 6) only ALLOW a
//     feature for this client — they write the client's own list in the
//     program rollout (programRolloutCore.setClientOpsChange) and send
//     nothing. The automatic features still need their global switch in
//     Content program automations, which this page never turns on;
//   · every message (step 5) is composed for him to read and edit, and goes
//     out ONLY when the owner presses "Send now" — through the outbox, as the
//     `onboarding` kind, which the dispatch gate re-checks at the moment of
//     sending (the client's matching toggle, the TEST-inbox floor). "Mark as
//     sent by me" records a message he sent himself, and sends nothing.
//
// This module is the shared vocabulary: which toggle carries which ops and
// needs which switches, which message needs which toggle, the outbox identity
// of a manual send, and the step statuses. No prisma, no server-only, so the
// page, the client panel, the gate and the drill all read the same table.
//
// REVIEW FIX (Oct 5 2026, late): Jordan's own messages have their OWN toggle,
// "Messages I send myself" (op manual_messages). They used to need "Program
// emails", which is also what lets the AUTOMATIC reminders, scripts-ready and
// office-replied emails through once their switches are on — so a client
// allowed only Jordan's messages would have started getting automatic emails
// the day a switch went on. Now "Automatic program emails" means only those,
// every message in step 5 needs "Messages I send myself", and the welcome also
// needs "Portal account and sign-in". Under each automatic toggle the page says
// plainly what each switch would do; it never asks Jordan to turn one on.
// ---------------------------------------------------------------------------

/** Every toggle on step 3, plus bookings (step 6). */
export type OnboardingToggleKey =
  | "accounts" | "messages" | "layout" | "emails"
  | "revision_policy" | "review_auto_approve" | "topic_carryover" | "script_auto_share" | "caption_assistant"
  | "bookings";

export type OnboardingToggle = {
  key: OnboardingToggleKey;
  label: string;
  /** What turning it on lets happen, in one plain sentence. */
  words: string;
  ops: ProgramReachOp[];
  /** The global switches (Content program automations) that must ALSO be on for it to do anything. */
  switches: AutomationKey[];
  /** Shown in amber beside the toggle: off by default, and why to think twice. */
  careful?: string;
};

const groupOps = (key: string): ProgramReachOp[] => [...(PROGRAM_PILOT_GROUPS.find((g) => g.key === key)?.ops ?? [])];

/**
 * The toggles, derived from PROGRAM_PILOT_GROUPS so they cannot drift from
 * the rollout's own groups: accounts, layout and emails as one toggle each,
 * the automatic portal changes one per feature, bookings last (step 6).
 */
export const ONBOARDING_TOGGLES: readonly OnboardingToggle[] = [
  {
    key: "accounts", label: "Portal account and sign-in", ops: groupOps("accounts"), switches: ["portal_invites", "portal_login_email"],
    words: "They can have a portal account and sign in with their email address. Once their account exists, each approved monthly video is put in their portal automatically by the hourly check, as soon as its 1080p file is ready. That sends them no message.",
  },
  {
    key: "messages", label: "Messages I send myself", ops: groupOps("messages"), switches: [],
    words: "You can send them the messages in step 5. Nothing about this is automatic: a message goes only when you press Send now.",
  },
  {
    key: "layout", label: "New portal layout", ops: groupOps("layout"), switches: ["portal_layout_v2"],
    words: "Their portal opens on the new layout: Home, My Plan, Content Library, Schedule.",
  },
  {
    key: "emails", label: "Automatic program emails", ops: groupOps("emails"), switches: ["reminders", "script_share_email", "program_message_notice"],
    words: "The hub may email them on its own: reminders, \"your scripts are ready\" and \"the office replied\". The messages you send yourself are the separate toggle above.",
  },
  {
    key: "revision_policy", label: "Review deadlines and revision rounds", ops: ["revision_policy"], switches: ["revision_policy"],
    words: "They see a four-business-day review deadline and how many of their two rounds each video has used.",
  },
  {
    key: "review_auto_approve", label: "Automatic approval when a deadline passes", ops: ["review_auto_approve"], switches: ["revision_policy", "review_auto_approve"],
    words: "If they don't answer a review by its deadline, the hub records the approval itself.",
    careful: "Off by default. Leave it off unless you want videos approved without the client answering.",
  },
  {
    key: "topic_carryover", label: "Carry unfilmed scripts into the next month", ops: ["topic_carryover"], switches: ["topic_carryover"],
    words: "On the 1st, a scripted topic they did not film moves into the new month and uses one of its videos.",
  },
  {
    key: "script_auto_share", label: "Share scripts without my approval", ops: ["script_auto_share"], switches: ["script_auto_share"],
    words: "A clean script the hub drafted is released to their portal after a two-hour hold, without you approving it.",
    careful: "Off by default. With it off you approve every script before the client sees it.",
  },
  {
    key: "caption_assistant", label: "Caption assistant", ops: ["caption_assistant"], switches: ["caption_assistant"],
    words: "A \"Draft a caption\" button on each approved video in their portal.",
  },
  {
    key: "bookings", label: "Automatic Aryeo booking", ops: groupOps("bookings"), switches: ["session_booking", "address_sync"],
    words: "Their session requests book a real Aryeo order and appointment, and their filming address is written to Aryeo, instead of Kyle doing it by hand.",
  },
];

/**
 * What each switch a toggle depends on WOULD do for this client if it were on,
 * in one plain sentence. Shown beside the switch's on/off state; the page
 * never suggests turning one on (Jordan: "I will send it").
 */
export const SWITCH_WOULD: Partial<Record<AutomationKey, string>> = {
  portal_invites: "would email a welcome on its own when they pay, and an invitation when someone is invited to their portal",
  portal_login_email: "would email them a one-time sign-in link when they ask for one on the sign-in page",
  portal_layout_v2: "would show them the new layout on their next visit (no message)",
  reminders: "would email them reminders on its own: book a call, finish their answers, approve scripts, review videos",
  script_share_email: "would email them on its own when you approve a script or release their strategy",
  program_message_notice: "would email them on its own when the office replies to them on their portal",
  revision_policy: "would show a four-business-day review deadline and their revision rounds (no message)",
  review_auto_approve: "would record a video as approved on its own when its review deadline passes",
  topic_carryover: "would move an unfilmed scripted topic into the next month on the 1st (no message)",
  script_auto_share: "would release a clean drafted script to their portal on its own after a two-hour hold",
  caption_assistant: "would show a \"Draft a caption\" button on their approved videos (no message)",
  session_booking: "would book their session requests in Aryeo on its own",
  address_sync: "would write their filming address to Aryeo on its own",
};

/** The step-3 toggles (bookings is chosen in step 6). */
export const STEP3_TOGGLES = ONBOARDING_TOGGLES.filter((t) => t.key !== "bookings");

export const toggleOf = (key: OnboardingToggleKey): OnboardingToggle => ONBOARDING_TOGGLES.find((t) => t.key === key)!;
export const isOnboardingToggleKey = (k: unknown): k is OnboardingToggleKey => typeof k === "string" && ONBOARDING_TOGGLES.some((t) => t.key === k);

/** Is this toggle on, given the ops a client is allowed? (Every op of it.) */
export const toggleOn = (t: OnboardingToggle, allowed: readonly ProgramReachOp[]): boolean => t.ops.every((op) => allowed.includes(op));

/** The client's whole list after turning one toggle on or off. */
export function opsWithToggle(allowed: readonly ProgramReachOp[], key: OnboardingToggleKey, on: boolean): ProgramReachOp[] {
  const t = toggleOf(key);
  const set = new Set(allowed);
  for (const op of t.ops) {
    if (on) set.add(op);
    else set.delete(op);
  }
  return [...set];
}

// ---- messages ----------------------------------------------------------------

export type OnboardingMessageKey = "welcome" | "strategy_call" | "strategy_ready" | "scripts_ready" | "video_ready" | "note";
export type OnboardingChannel = "email" | "sms";

export type OnboardingMessage = {
  key: OnboardingMessageKey;
  label: string;
  /**
   * The rollout ops a send of it must pass for a real client — EVERY one.
   * Always manual_messages ("Messages I send myself"); the welcome also needs
   * portal_invites (it tells them to sign in to an account).
   */
  ops: ProgramReachOp[];
  /** The toggles that carry those ops, in the same order — named in the refusal. */
  toggles: OnboardingToggleKey[];
  /** The email subject (the outbox has no subject column; the kind names it). */
  subject: string;
};

const MANUAL = { ops: ["manual_messages"] as ProgramReachOp[], toggles: ["messages"] as OnboardingToggleKey[] };

export const ONBOARDING_MESSAGES: readonly OnboardingMessage[] = [
  { key: "welcome", label: "Welcome and how to sign in", ops: ["manual_messages", "portal_invites"], toggles: ["messages", "accounts"], subject: "Welcome to your RealTour Pilot content portal" },
  { key: "strategy_call", label: "Book your strategy call", ...MANUAL, subject: "Book your RealTour Pilot strategy call" },
  { key: "strategy_ready", label: "Your strategy is ready", ...MANUAL, subject: "Your Content Strategy is Ready + Next Steps" },
  { key: "scripts_ready", label: "Your scripts are ready", ...MANUAL, subject: "Your scripts are ready in your RealTour Pilot portal" },
  { key: "video_ready", label: "Your video is ready", ...MANUAL, subject: "Your videos are ready to review" },
  { key: "note", label: "Your own note", ...MANUAL, subject: "A note from RealTour Pilot" },
];

/** The toggles a message still needs, given what reaches the client ("ok" = reached for that op). */
export function missingToggles(m: OnboardingMessage, reached: (op: ProgramReachOp) => boolean): OnboardingToggleKey[] {
  return m.ops.flatMap((op, i) => (reached(op) ? [] : [m.toggles[i]]));
}

/** "\"Messages I send myself\" and \"Portal account and sign-in\"". */
export const toggleNames = (keys: readonly OnboardingToggleKey[]): string => {
  const names = [...new Set(keys)].map((k) => `"${toggleOf(k).label}"`);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
};

export const messageOf = (key: OnboardingMessageKey): OnboardingMessage => ONBOARDING_MESSAGES.find((m) => m.key === key)!;
export const isOnboardingMessageKey = (k: unknown): k is OnboardingMessageKey => typeof k === "string" && ONBOARDING_MESSAGES.some((m) => m.key === k);

/** The longest message body the page accepts. */
export const ONBOARDING_BODY_MAX = 5000;

/**
 * THE IDENTITY OF A MANUAL ONBOARDING SEND: onboarding:<message>:<clientId>:<intent>.
 * The intent is minted by the browser when Jordan presses Send (the R4 manual
 * rule): a double submit of one press collides, a second deliberate send is a
 * new press and a new identity. The message rides in the key so the outbox
 * can name the email's subject and the dispatch gate can re-check its toggle.
 */
export const onboardingKey = (message: OnboardingMessageKey, clientId: string, intentId: string) => `onboarding:${message}:${clientId}:${intentId}`;
export function parseOnboardingKey(dedupeKey: string | null | undefined): { message: OnboardingMessageKey; clientId: string; intentId: string } | null {
  const [kind, message, clientId, intentId] = (dedupeKey ?? "").split(":");
  if (kind !== "onboarding" || !isOnboardingMessageKey(message) || !clientId || !intentId) return null;
  return { message, clientId, intentId };
}
/** The subject an onboarding email goes out under (outbox.subjectFor). */
export const onboardingSubject = (dedupeKey: string | null | undefined): string => {
  const k = parseOnboardingKey(dedupeKey);
  return k ? messageOf(k.message).subject : "RealTour Pilot";
};
/** A browser-minted press id: letters, digits, dash, underscore, 8–64 long. */
export const isIntentId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(s);

// ---- the onboarding record (one AppSetting row per client) ------------------

export const ONBOARDING_RECORD_PREFIX = "client-onboarding:";

export type OnboardingLogEntry = {
  at: string;
  by: string;
  /** sent = the hub sent it (Send now); marked = Jordan sent it himself; the rest are changes. */
  kind: "sent" | "marked" | "send_failed" | "send_unknown" | "toggle" | "seat" | "onboarded" | "reopened";
  message?: OnboardingMessageKey;
  channel?: OnboardingChannel;
  to?: string;
  detail?: string;
  /** The outbox row that carried a send (Oct 5 2026): a recovered or re-sent message is logged once. */
  outboxId?: string;
};

export type OnboardingRecord = {
  onboardedAt: string | null;
  onboardedBy: string | null;
  log: OnboardingLogEntry[];
};

export const EMPTY_RECORD: OnboardingRecord = Object.freeze({ onboardedAt: null, onboardedBy: null, log: [] as OnboardingLogEntry[] }) as OnboardingRecord;
/** The newest entries kept on the row; AuditLog keeps every one. */
export const ONBOARDING_LOG_MAX = 200;

/** Read the stored row tolerantly: anything unreadable is an empty record (the AuditLog still has the history). */
export function parseOnboardingRecord(raw: string | null | undefined): OnboardingRecord {
  if (!raw) return { ...EMPTY_RECORD, log: [] };
  try {
    const v = JSON.parse(raw) as Partial<OnboardingRecord>;
    const iso = (x: unknown) => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : null);
    const log = Array.isArray(v.log) ? v.log.filter((e): e is OnboardingLogEntry => !!e && typeof e === "object" && typeof (e as OnboardingLogEntry).at === "string" && typeof (e as OnboardingLogEntry).kind === "string") : [];
    return { onboardedAt: iso(v.onboardedAt), onboardedBy: typeof v.onboardedBy === "string" ? v.onboardedBy : null, log };
  } catch {
    return { ...EMPTY_RECORD, log: [] };
  }
}

/** The last time each message was sent (by the hub) or marked sent (by Jordan). */
export function lastSentOf(record: OnboardingRecord, message: OnboardingMessageKey): OnboardingLogEntry | null {
  for (let i = record.log.length - 1; i >= 0; i--) {
    const e = record.log[i];
    if (e.message === message && (e.kind === "sent" || e.kind === "marked")) return e;
  }
  return null;
}

// ---- the steps --------------------------------------------------------------

export type StepStatus = "done" | "needs_you" | "blocked";
export type OnboardingStep = { n: number; key: string; title: string; status: StepStatus; line: string };

/** What the steps are derived from — the page's loaded facts, nothing else. */
export type StepFacts = {
  isTest: boolean;
  paused: boolean;
  emails: string[];
  strategy: { inReview: number | null; draftNo?: number | null; approvedNo: number | null; released: boolean };
  allowed: ProgramReachOp[];
  liveOwnerSeat: boolean;
  record: OnboardingRecord;
  autoBooking: boolean;
};

/** The seven steps' statuses and one line each, in order. Pure. */
export function onboardingSteps(f: StepFacts): OnboardingStep[] {
  const accountsOn = f.isTest || toggleOn(toggleOf("accounts"), f.allowed);
  const on = STEP3_TOGGLES.filter((t) => toggleOn(t, f.allowed)).length;
  const welcomeSent = lastSentOf(f.record, "welcome");
  const anySent = ONBOARDING_MESSAGES.some((m) => lastSentOf(f.record, m.key));
  const s = f.strategy;
  return [
    {
      n: 1, key: "account", title: "Account & package",
      status: f.emails.length ? "done" : "needs_you",
      line: f.emails.length ? `Portal email: ${f.emails[0]}` : "No email on file. Add one on the client's page first.",
    },
    {
      n: 2, key: "strategy", title: "Strategy",
      status: s.inReview ? "needs_you" : s.released ? "done" : s.approvedNo ? "needs_you" : "blocked",
      line: s.inReview
        ? `v${s.inReview} is waiting for your approval${s.approvedNo ? ` (v${s.approvedNo} is the approved one${s.released ? ", in their portal" : ""})` : ""}`
        : s.released
          ? `v${s.approvedNo} approved and released to their portal`
          : s.approvedNo
            ? `v${s.approvedNo} is approved but not released to their portal yet`
            : s.draftNo
              ? `v${s.draftNo} is still a draft`
              : "No strategy on file yet",
    },
    {
      n: 3, key: "features", title: "What this client gets",
      status: f.isTest ? "done" : on > 0 ? "done" : "needs_you",
      line: f.isTest ? "A TEST client gets everything that is switched on, at your test inbox only" : on > 0 ? `${on} of ${STEP3_TOGGLES.length} allowed` : "Nothing allowed yet (all off)",
    },
    {
      n: 4, key: "portal", title: "Portal account",
      status: f.liveOwnerSeat ? "done" : f.paused ? "blocked" : accountsOn ? "needs_you" : "blocked",
      line: f.liveOwnerSeat
        ? "Account created"
        : f.paused
          ? "Their program is paused"
          : accountsOn
            ? "No account yet"
            : "Turn on \"Portal account and sign-in\" in step 3 first",
    },
    {
      n: 5, key: "messages", title: "Messages",
      status: welcomeSent ? "done" : "needs_you",
      line: welcomeSent ? `Welcome ${welcomeSent.kind === "sent" ? "sent" : "marked sent"} ${dayET(welcomeSent.at)}` : anySent ? "Welcome not sent yet" : "Nothing sent yet",
    },
    {
      n: 6, key: "filming", title: "Filming",
      status: "done",
      line: f.autoBooking ? "Automatic Aryeo booking" : "Kyle books by hand",
    },
    {
      n: 7, key: "done", title: "Done",
      status: f.record.onboardedAt ? "done" : "needs_you",
      line: f.record.onboardedAt ? `Onboarded ${dayET(f.record.onboardedAt)}` : "Not marked onboarded",
    },
  ];
}

/** The chip on the client list. */
export type OnboardingChip = "Not started" | "In progress" | "Onboarded";
export function onboardingChip(a: { record: OnboardingRecord; allowedCount: number; seats: number }): OnboardingChip {
  if (a.record.onboardedAt) return "Onboarded";
  if (a.allowedCount > 0 || a.seats > 0 || a.record.log.length > 0) return "In progress";
  return "Not started";
}

/** "Oct 5" in Eastern time. */
export function dayET(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(iso));
}

/** "Oct 5, 3:42 PM ET". */
export function whenET(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso))} ET`;
}
