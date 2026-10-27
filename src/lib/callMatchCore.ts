import { phoneKey } from "@/lib/phoneKey";
import { isTestClientName } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// THE CALL MATCHER, the pure half (Oct 27 2026).
//
// Jordan, Oct 27 2026: "it's not picking up the last call that we had ...
// Janice, she's one of our clients ... it should be analyzed and assigned
// automatically."
//
// Why calls sat unmatched: a call was filed ONLY when the invitee's address
// was the client's email, backup email or an alias a person had verified. A
// client booking from a work address (Janice booked from one her record does
// not carry), a spouse's phone-booked call, a direct Google Meet invite and a
// full-name match all waited on a person. The extra signals, strongest first:
//   1. portal sign-in: the invitee address is the client's portal login;
//   2. calendar guest: another guest on the call's calendar event is the client;
//   3. phone: the number given to Calendly is the client's phone;
//   4. full name: exactly one active content client has the invitee's full
//      name (nicknames and a first-name prefix allowed, same last name). This
//      replaces the A04 rule "a name match alone never attaches a call",
//      except for a booking carrying a portal token that did not verify
//      (forged, another account's, a stale page): never by name.
// Each signal must point at ONE client; two clients on one signal is not a
// match (it stops there, so a weaker signal never breaks a tie). The model
// (callAutoMatch.ts) is asked only about what is left, and only acts at 0.85.
// No I/O here.
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Meaningful name tokens: no single letters ("John P. Collins" → john collins), no suffixes. */
export const nameTokens = (s: string | null | undefined): string[] =>
  norm(s ?? "").split(" ").filter((t) => t.length > 1 && !["jr", "sr", "ii", "iii", "test"].includes(t));

const NICK: Record<string, string[]> = {
  joseph: ["joe", "joey"], john: ["jack", "johnny"], robert: ["bob", "rob", "bobby"], michael: ["mike"], william: ["bill", "will"],
  james: ["jim", "jimmy"], richard: ["rick", "rich", "dick"], elizabeth: ["liz", "beth"], katherine: ["kate", "kathy", "katie"],
  christopher: ["chris"], jennifer: ["jen", "jenny"], stephen: ["steve"], steven: ["steve"], thomas: ["tom"], daniel: ["dan"], anthony: ["tony"],
};

export function sameFirstName(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return (NICK[a] ?? []).includes(b) || (NICK[b] ?? []).includes(a);
}

/** Same person by name: same last name, same first name (or its nickname / prefix), both at least two words. */
export function sameFullName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = nameTokens(a), y = nameTokens(b);
  if (x.length < 2 || y.length < 2) return false;
  return x[x.length - 1] === y[y.length - 1] && sameFirstName(x[0], y[0]);
}

export const GENERIC_DOMAINS = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "comcast.net", "verizon.net", "live.com", "msn.com"]);
/** Our own addresses on a calendar invite are never the client. */
const TEAM_DOMAINS = ["realtourpilot.com", "realtorpilot.com"];
export const isTeamEmail = (e: string | null | undefined): boolean => {
  const d = (e ?? "").toLowerCase().split("@")[1] ?? "";
  return TEAM_DOMAINS.includes(d) || d.endsWith("calendar.google.com") || d.endsWith("calendly.com");
};

/**
 * The phone numbers a Calendly invitee gave: the text-reminder number and any
 * answer that is a phone number. Calendly sends both on the invitee object
 * (the hub stores it whole on the record's rawJson). 10-digit keys only.
 */
export function inviteePhones(invitee: unknown): string[] {
  const o = (invitee && typeof invitee === "object" ? invitee : {}) as { text_reminder_number?: unknown; questions_and_answers?: unknown };
  const raw: string[] = [];
  if (typeof o.text_reminder_number === "string") raw.push(o.text_reminder_number);
  if (Array.isArray(o.questions_and_answers)) {
    for (const qa of o.questions_and_answers) {
      const a = (qa && typeof qa === "object" ? (qa as { answer?: unknown }).answer : null);
      if (typeof a === "string" && /^[\s()+.\-\d]{10,20}$/.test(a.trim())) raw.push(a);
    }
  }
  return [...new Set(raw.map((p) => phoneKey(p)).filter((k) => k.length === 10))];
}

/** One active content client as the matcher sees it. `logins` are portal sign-in emails; `emails` are email/backup/verified aliases. */
export type MatchClient = { clientId: string; enrollmentId: string; name: string; emails: string[]; logins: string[]; phone: string | null };
export type MatchSignals = { inviteeEmail: string | null; inviteeName: string | null; phones: string[]; attendeeEmails: string[] };
export type MatchVia = "portalLogin" | "attendee" | "phone" | "name";
export type SignalMatch =
  | { state: "MATCHED"; clientId: string; enrollmentId: string; via: MatchVia; evidence: string }
  | { state: "AMBIGUOUS"; via: MatchVia; clientIds: string[]; evidence: string }
  | { state: "NONE" };

export const VIA_WORDS: Record<MatchVia, string> = {
  portalLogin: "the address they booked with is their portal sign-in",
  attendee: "they are a guest on the call's calendar invite",
  phone: "the phone number on the booking is theirs",
  name: "the name on the booking is theirs, and no other client has it",
};

/**
 * Pure. The client behind a call by the extra signals, strongest first. The
 * caller has already tried the verified addresses (resolveInviteeIdentity).
 * `addressOwnedByOther`: the invitee address is on file for some OTHER
 * client (a non-program one too): then the name is never enough.
 */
export function matchBySignals(s: MatchSignals, pool: MatchClient[], opts: { addressOwnedByOther?: boolean } = {}): SignalMatch {
  const e = (s.inviteeEmail ?? "").trim().toLowerCase();
  const settle = (via: MatchVia, hits: MatchClient[], evidence: string): SignalMatch | null => {
    const ids = [...new Set(hits.map((h) => h.clientId))];
    if (ids.length === 1) { const h = hits[0]; return { state: "MATCHED", clientId: h.clientId, enrollmentId: h.enrollmentId, via, evidence }; }
    if (ids.length > 1) return { state: "AMBIGUOUS", via, clientIds: ids, evidence };
    return null;
  };
  if (e) {
    const r = settle("portalLogin", pool.filter((c) => c.logins.includes(e)), `${e} is their portal sign-in`);
    if (r) return r;
  }
  const guests = [...new Set(s.attendeeEmails.map((a) => a.trim().toLowerCase()).filter((a) => a && a !== e && !isTeamEmail(a)))];
  if (guests.length) {
    const hits = pool.filter((c) => guests.some((g) => c.emails.includes(g) || c.logins.includes(g)));
    const r = settle("attendee", hits, `a calendar guest (${guests.filter((g) => hits.some((c) => c.emails.includes(g) || c.logins.includes(g))).join(", ")}) is on their record`);
    if (r) return r;
  }
  const phones = s.phones.filter((p) => p.length === 10);
  if (phones.length) {
    const r = settle("phone", pool.filter((c) => !!c.phone && phones.includes(phoneKey(c.phone))), `the booking's phone number matches their record`);
    if (r) return r;
  }
  if (!opts.addressOwnedByOther && nameTokens(s.inviteeName).length >= 2) {
    const testInvitee = isTestClientName(s.inviteeName);
    const hits = pool.filter((c) => (testInvitee || !isTestClientName(c.name)) && sameFullName(s.inviteeName, c.name));
    const r = settle("name", hits, `booked as "${s.inviteeName}"`);
    if (r) return r;
  }
  return { state: "NONE" };
}

// ---------------------------------------------------------------------------
// A call that never went through Calendly (a Google Meet invite sent by hand,
// like Bernadette's Oct 26 follow-up). Read from the owner's calendar: only an
// event with a Meet link, a client on the guest list, and a title that reads
// like a client call (or a time a curated fact said a call would happen).
// ---------------------------------------------------------------------------
// Only the words of a program call: a plain "call" or "meeting" with a client
// can be a listing consult, and filing that as the month's strategy call would
// mark the month's call held. Those need a one-off fact that expected them.
const CALL_TITLE_RE = /\b(strategy|content|planning|follow[\s-]?up|topics?|videos?|scripts?)\b/i;
const NOT_A_CALL_RE = /\b(buffer|lunch|dinner|dentist|doctor|gym|flight|birthday|holiday|block|focus|hold|ooo|out of office|travel|drive)\b/i;
export function looksLikeClientCall(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  return !!t && CALL_TITLE_RE.test(t) && !NOT_A_CALL_RE.test(t);
}

/** An expected call (a curated one-off fact) within ±windowMin of a start, for one client. Pure. */
export function expectedCallNear<T extends { clientId: string; at: Date }>(start: Date, clientId: string | null, expected: T[], windowMin = 90): T | null {
  const near = expected.filter((x) => (!clientId || x.clientId === clientId) && Math.abs(x.at.getTime() - start.getTime()) <= windowMin * 60_000);
  near.sort((a, b) => Math.abs(a.at.getTime() - start.getTime()) - Math.abs(b.at.getTime() - start.getTime()));
  return near[0] ?? null;
}

// ---------------------------------------------------------------------------
// The model's turn: only for a call the signals left open. One small call per
// record; it names a client from the list or says nobody, with a reason.
// ---------------------------------------------------------------------------
export const CALL_MATCH_MIN_CONFIDENCE = 0.85;

export const CALL_MATCH_SYSTEM = `You match ONE booked call to the real estate agent it belongs to, for Realtour Pilot, a media agency that makes the agent's monthly videos. You get the booking (name, email, phone, the booking's answers, the calendar title and guests) and the list of the agency's current content clients (name, emails, phone, brokerage).

Name a client only when the booking clearly is that person or someone booking for them (an assistant, a spouse, a team member who names them). Typical clear cases: a nickname or maiden name with the same address style, the client's business or team name, a guest list that includes the client. A first name alone, a shared brokerage or a common last name is NOT enough. When unsure, answer null. Never guess.`;

export const CALL_MATCH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["clientId", "confidence", "reason"],
  properties: {
    clientId: { type: ["string", "null"], description: "An id from the client list, or null." },
    confidence: { type: "number", description: "0 to 1." },
    reason: { type: "string", description: "One short sentence: what ties the booking to that client, or why nobody." },
  },
} as const;

export type CallForModel = { inviteeName: string | null; inviteeEmail: string | null; phones: string[]; answers: string[]; calendarTitle: string | null; guests: string[]; eventName: string | null; startISO: string | null };
export type ClientForModel = { id: string; name: string; emails: string[]; phone: string | null; company: string | null };

export function callMatchPrompt(call: CallForModel, clients: ClientForModel[]): string {
  return [
    "BOOKING:",
    `- name: ${call.inviteeName ?? "(none)"}`,
    `- email: ${call.inviteeEmail ?? "(none)"}`,
    call.phones.length ? `- phone: ${call.phones.join(", ")}` : "",
    call.eventName ? `- event type: ${call.eventName}` : "",
    call.startISO ? `- when: ${call.startISO}` : "",
    call.calendarTitle ? `- calendar title: ${call.calendarTitle}` : "",
    call.guests.length ? `- calendar guests: ${call.guests.join(", ")}` : "",
    ...call.answers.slice(0, 6).map((a) => `- booking answer: ${a.slice(0, 300)}`),
    "\nCURRENT CONTENT CLIENTS (id | name | emails | phone | brokerage):",
    ...clients.map((c) => `${c.id} | ${c.name} | ${c.emails.join(", ") || "-"} | ${c.phone ?? "-"} | ${c.company ?? "-"}`),
  ].filter((l) => l !== "").join("\n");
}

/** The model's answer, made safe: an id from the list at or above the bar, else null. Pure. */
export function acceptCallMatch(out: unknown, ids: Set<string>): { clientId: string; reason: string; confidence: number } | null {
  const o = (out && typeof out === "object" ? out : {}) as { clientId?: unknown; confidence?: unknown; reason?: unknown };
  const id = typeof o.clientId === "string" ? o.clientId.trim() : "";
  const conf = typeof o.confidence === "number" ? o.confidence : 0;
  if (!id || !ids.has(id) || !(conf >= CALL_MATCH_MIN_CONFIDENCE)) return null;
  return { clientId: id, reason: String(o.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || "the AI matched the booking", confidence: conf };
}

/** A calendar title that names the client in full ("Bernadette Rabel / Jordan", "Follow up: Bernie Rabel"). Pure. */
export function titleNamesClient(title: string | null | undefined, clientName: string): boolean {
  const t = nameTokens(title), c = nameTokens(clientName);
  if (c.length < 2 || !t.length) return false;
  const last = c[c.length - 1];
  return t.includes(last) && t.some((x) => x !== last && sameFirstName(x, c[0]));
}
