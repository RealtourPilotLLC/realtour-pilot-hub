import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { etDayKey } from "@/lib/datetime";
import { isTestClientName } from "@/lib/testClients";
import { catchUpInto, catchUpMonthName } from "@/lib/catchUp";

// ---------------------------------------------------------------------------
// STRATEGY CALLS · LAST 30 DAYS (Oct 6 2026) — the read behind /content/calls.
//
// Every monthly-strategy-shaped call record in [now − 30 days, now + 14 days]:
// the dedicated "Content Program - Strategy Call" bookings, the generic
// "30 Minute Strategy Call" ones (STRATEGY_CANDIDATE mapping), manual records
// and anything staff set aside — never brand-discovery calls (onboarding owns
// those). For each: who booked, when, the client + month it is filed on, and
// for an unfiled one a SUGGESTED client. A suggestion is a hint for the
// person holding the button — nothing here or in the sync acts on it.
// ---------------------------------------------------------------------------

export const DESK_LOOK_BACK_DAYS = 30;
export const DESK_LOOK_AHEAD_DAYS = 14;

const shiftMonth = (key: string, by: number) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * The month a call PLANS, by default: a call in the last 10 days of its (ET)
 * month plans the next month, otherwise its own (Sep 24 → October; Oct 6 →
 * October; Oct 22 → November). Only the page's default — staff can change it.
 */
export function suggestedPlanMonthKey(start: Date): string {
  const own = etMonthKey(start);
  const day = Number(etDayKey(start).slice(8, 10));
  const [y, m] = own.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return daysInMonth - day < 10 ? shiftMonth(own, 1) : own;
}

/** The months the picker offers for a call: one before its own through two after (plus whatever it is on now). */
export function monthOptionsFor(start: Date, current?: string | null): string[] {
  const own = etMonthKey(start);
  const keys = new Set([-1, 0, 1, 2].map((n) => shiftMonth(own, n)));
  if (current) keys.add(current);
  return [...keys].sort();
}

// ---- suggestion -------------------------------------------------------------
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** Meaningful name tokens: no single letters ("John P. Collins" → john collins), no suffixes. */
const nameTokens = (s: string | null | undefined) => norm(s ?? "").split(" ").filter((t) => t.length > 1 && !["jr", "sr", "ii", "iii", "test"].includes(t));
const NICK: Record<string, string[]> = {
  joseph: ["joe", "joey"], john: ["jack", "johnny"], robert: ["bob", "rob", "bobby"], michael: ["mike"], william: ["bill", "will"],
  james: ["jim", "jimmy"], richard: ["rick", "rich", "dick"], elizabeth: ["liz", "beth"], katherine: ["kate", "kathy", "katie"],
  christopher: ["chris"], jennifer: ["jen", "jenny"], stephen: ["steve"], steven: ["steve"], thomas: ["tom"], daniel: ["dan"], anthony: ["tony"],
};
function sameFirstName(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return (NICK[a] ?? []).includes(b) || (NICK[b] ?? []).includes(a);
}
const GENERIC_DOMAINS = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "comcast.net", "verizon.net", "live.com", "msn.com"]);

export type SuggestClient = { clientId: string; name: string; emails: string[] };
export type Suggestion = { clientId: string; name: string; reason: string; score: number };

/** Pure: the most likely enrolled client for an invitee, or null. Never used to file anything. */
export function suggestClient(invitee: { name: string | null; email: string | null }, clients: SuggestClient[], storedCandidates: string[] = []): Suggestion | null {
  const email = (invitee.email ?? "").trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : "";
  const it = nameTokens(invitee.name);
  let best: Suggestion | null = null;
  const consider = (s: Suggestion) => { if (!best || s.score > best.score) best = s; };
  for (const c of clients) {
    const emails = c.emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (email && emails.includes(email)) { consider({ clientId: c.clientId, name: c.name, reason: "same email as on file", score: 100 }); continue; }
    if (isTestClientName(c.name) && !isTestClientName(invitee.name)) continue;
    if (storedCandidates.includes(c.clientId)) { consider({ clientId: c.clientId, name: c.name, reason: "same full name", score: 80 }); continue; }
    const ct = nameTokens(c.name);
    if (!it.length || !ct.length) continue;
    const lastMatch = it[it.length - 1] === ct[ct.length - 1];
    const firstMatch = sameFirstName(it[0], ct[0]);
    const sameDomain = !!domain && !GENERIC_DOMAINS.has(domain) && emails.some((e) => e.endsWith(`@${domain}`));
    if (lastMatch && firstMatch && it.length > 1 && ct.length > 1) consider({ clientId: c.clientId, name: c.name, reason: it[0] === ct[0] ? "same name" : `"${invitee.name}" looks like ${c.name}`, score: 70 + (sameDomain ? 10 : 0) });
    else if (lastMatch && sameDomain) consider({ clientId: c.clientId, name: c.name, reason: "same last name and email domain", score: 50 });
    else if (lastMatch && it.length > 1 && ct.length > 1) consider({ clientId: c.clientId, name: c.name, reason: "same last name", score: 30 });
  }
  return best;
}

// ---- the page read ----------------------------------------------------------
export type DeskStatus = "scheduled" | "completed" | "cancelled" | "rescheduled" | "no-show";
export type DeskRow = {
  id: string;
  startISO: string | null;
  endISO: string | null;
  status: DeskStatus;
  inviteeName: string | null;
  inviteeEmail: string | null;
  eventType: string;
  matchState: string;
  /** ASSIGNED (on a month) · OPEN (not on a month) · IGNORED (set aside). */
  state: "ASSIGNED" | "OPEN" | "IGNORED";
  /** How it got there: by the sweep (verified email) or by a person. */
  assignedBy: "auto" | "staff" | null;
  client: { id: string; name: string } | null;
  month: { id: string; key: string } | null;
  suggestion: Suggestion | null;
  defaultMonthKey: string | null;
  monthOptions: string[];
  note: string | null;
  /** Oct 7 2026: the month it is on carries a missed month's catch-up — what this call is to it. */
  catchUpNote: string | null;
};
export type DeskData = {
  rows: DeskRow[];
  clients: { id: string; name: string }[];
  window: { fromISO: string; toISO: string };
  /** The instant this read was taken — the page splits "coming up" from "past" by it. */
  nowISO: string;
  /** Whether the generic type is mapped yet, and when the sync last ran over the mapped types. */
  candidateMapped: boolean;
  lastSyncedISO: string | null;
};

export async function strategyCallDesk(opts: { now?: Date } = {}): Promise<DeskData> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - DESK_LOOK_BACK_DAYS * 864e5);
  const to = new Date(now.getTime() + DESK_LOOK_AHEAD_DAYS * 864e5);
  const [records, mappings, enrollments] = await Promise.all([
    prisma.programCallRecord.findMany({
      where: { scheduledStart: { gte: from, lte: to }, callType: { not: "BRAND_DISCOVERY" } },
      orderBy: { scheduledStart: "desc" },
      take: 300,
      select: { id: true, callType: true, status: true, matchState: true, matchNote: true, confirmedBy: true, scheduledStart: true, scheduledEnd: true, inviteeName: true, inviteeEmail: true, clientId: true, monthId: true, targetMonthKey: true, mappingId: true, rawJson: true },
    }),
    prisma.programCalendlyEventMapping.findMany({ select: { id: true, eventName: true, purpose: true, enabled: true, lastSyncedAt: true } }),
    prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true, clientId: true, overridesJson: true } }),
  ]);
  const mappingOf = new Map(mappings.map((m) => [m.id, m]));
  // A record a brand-discovery mapping classified stays out even if its callType moved.
  const rows0 = records.filter((r) => !(r.mappingId && mappingOf.get(r.mappingId)?.purpose === "BRAND_DISCOVERY" && r.callType !== "MONTHLY_STRATEGY"));
  const activeClientIds = [...new Set(enrollments.map((e) => e.clientId))];
  const [clients, aliases, memberships, monthRows, recordClients] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: activeClientIds } }, select: { id: true, name: true, email: true, backupEmail: true } }),
    prisma.clientEmailAlias.findMany({ where: { clientId: { in: activeClientIds }, active: true }, select: { clientId: true, email: true } }),
    prisma.clientMembership.findMany({ where: { clientId: { in: activeClientIds }, revokedAt: null }, select: { clientId: true, clientUserId: true } }),
    prisma.contentMonth.findMany({ where: { id: { in: rows0.map((r) => r.monthId).filter((x): x is string => !!x) } }, select: { id: true, monthKey: true } }),
    prisma.client.findMany({ where: { id: { in: rows0.map((r) => r.clientId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  const users = memberships.length ? await prisma.clientUser.findMany({ where: { id: { in: memberships.map((m) => m.clientUserId) } }, select: { id: true, email: true } }) : [];
  const userEmail = new Map(users.map((u) => [u.id, u.email]));
  const emailsOf = new Map<string, string[]>();
  const add = (id: string, e: string | null | undefined) => { if (!e) return; const l = emailsOf.get(id) ?? []; l.push(e); emailsOf.set(id, l); };
  for (const c of clients) { add(c.id, c.email); add(c.id, c.backupEmail); }
  for (const a of aliases) add(a.clientId, a.email);
  for (const m of memberships) add(m.clientId, userEmail.get(m.clientUserId));
  const suggestPool: SuggestClient[] = clients.map((c) => ({ clientId: c.id, name: c.name, emails: emailsOf.get(c.id) ?? [] }));
  const monthKeyOf = new Map(monthRows.map((m) => [m.id, m.monthKey]));
  const clientName = new Map([...clients, ...recordClients].map((c) => [c.id, c.name]));

  // Oct 7 2026: a catch-up month may hold two calls — the first planned the
  // month (and keeps anchoring its filming dates), a later one plans the
  // caught-up batch. Said on the row so nobody "fixes" the second one away.
  const overridesOf = new Map(enrollments.map((e) => [e.clientId, e.overridesJson]));
  const liveOnMonth = (monthId: string) => rows0
    .filter((x) => x.monthId === monthId && x.callType === "MONTHLY_STRATEGY" && x.matchState !== "IGNORED" && x.status !== "CANCELLED" && x.status !== "RESCHEDULED" && x.scheduledStart)
    .sort((a, b) => a.scheduledStart!.getTime() - b.scheduledStart!.getTime());
  const catchUpNoteFor = (r: (typeof rows0)[number], monthKey: string | null): string | null => {
    if (!r.clientId || !r.monthId || !monthKey) return null;
    const cu = catchUpInto(overridesOf.get(r.clientId), monthKey);
    if (!cu) return null;
    const missed = catchUpMonthName(cu.missedMonthKey, monthKey), month = catchUpMonthName(monthKey);
    const order = liveOnMonth(r.monthId).findIndex((x) => x.id === r.id);
    return order <= 0
      ? `${month} also catches up ${missed}. This call planned the month; a second call can be filed on ${month} too, to plan the ${missed} videos.`
      : `${month} also catches up ${missed}: this second call plans the ${missed} videos. The first call keeps the filming dates.`;
  };
  const rows: DeskRow[] = rows0.map((r) => {
    let raw: { calendly?: { event?: { name?: string } }; identity?: { candidates?: { clientId: string }[] }; assignment?: unknown } = {};
    try { raw = r.rawJson ? JSON.parse(r.rawJson) : {}; } catch { /* a bad snapshot reads as none */ }
    const end = r.scheduledEnd ?? r.scheduledStart;
    const status: DeskStatus = r.status === "CANCELLED" ? "cancelled" : r.status === "RESCHEDULED" ? "rescheduled" : r.status === "NO_SHOW" ? "no-show"
      : r.status === "COMPLETED" || (end && end < now) ? "completed" : "scheduled";
    const onMonth = !!r.monthId && r.callType === "MONTHLY_STRATEGY" && r.matchState !== "IGNORED";
    const state: DeskRow["state"] = r.matchState === "IGNORED" ? "IGNORED" : onMonth ? "ASSIGNED" : "OPEN";
    const monthKey = r.monthId ? monthKeyOf.get(r.monthId) ?? r.targetMonthKey : null;
    const start = r.scheduledStart;
    return {
      id: r.id,
      startISO: start?.toISOString() ?? null,
      endISO: r.scheduledEnd?.toISOString() ?? null,
      status,
      inviteeName: r.inviteeName,
      inviteeEmail: r.inviteeEmail,
      eventType: (r.mappingId ? mappingOf.get(r.mappingId)?.eventName : null) ?? raw.calendly?.event?.name ?? (r.mappingId ? "Calendly" : "Added by staff"),
      matchState: r.matchState,
      state,
      assignedBy: state !== "ASSIGNED" ? null : r.matchState === "CONFIRMED_BY_STAFF" ? "staff" : "auto",
      client: r.clientId ? { id: r.clientId, name: clientName.get(r.clientId) ?? "Unknown client" } : null,
      month: onMonth && r.monthId && monthKey ? { id: r.monthId, key: monthKey } : null,
      suggestion: state === "ASSIGNED" ? null : suggestClient({ name: r.inviteeName, email: r.inviteeEmail }, suggestPool, (raw.identity?.candidates ?? []).map((c) => c.clientId)),
      defaultMonthKey: onMonth && monthKey ? monthKey : start ? suggestedPlanMonthKey(start) : null,
      monthOptions: start ? monthOptionsFor(start, onMonth ? monthKey : null) : monthKey ? [monthKey] : [],
      note: r.matchNote,
      catchUpNote: onMonth ? catchUpNoteFor(r, monthKey ?? null) : null,
    };
  });
  const candidate = mappings.filter((m) => m.purpose === "STRATEGY_CANDIDATE" && m.enabled);
  const program = mappings.filter((m) => m.enabled && m.purpose !== "IGNORED");
  const last = program.map((m) => m.lastSyncedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    rows,
    clients: clients.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    window: { fromISO: from.toISOString(), toISO: to.toISOString() },
    nowISO: now.toISOString(),
    candidateMapped: candidate.length > 0,
    lastSyncedISO: last?.toISOString() ?? null,
  };
}
