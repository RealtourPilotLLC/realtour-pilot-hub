import "server-only";
import { prisma } from "@/lib/prisma";
import {
  CALL_MATCH_SCHEMA, CALL_MATCH_SYSTEM, acceptCallMatch, callMatchPrompt, expectedCallNear, inviteePhones, isTeamEmail,
  looksLikeClientCall, titleNamesClient, VIA_WORDS, type MatchVia,
} from "@/lib/callMatchCore";
import { fileCallAutomatically, loadMatchPool, resolveInviteeIdentity, strategyCallHold } from "@/lib/contentCallRecords";
import { expectedCalls, expireOneOffFacts, markExpectedCallUsed } from "@/lib/knowledgeCurator";

// ---------------------------------------------------------------------------
// THE CALL MATCHER (Oct 27 2026). Jordan: "it's not picking up the last call
// that we had, so like, unmatched calls ... Janice, she's one of our clients
// ... it should be analyzed and assigned automatically."
//
// Three passes, each logged on the record (matchNote, raw.identity):
//   1. WAITING CALLS — every call still waiting for a client (unmatched, a
//      possible strategy call, never one a person set aside) is asked again
//      with the extra signals (callMatchCore): portal sign-in, calendar guest,
//      phone, a unique full name, or a follow-up call a curated one-off said
//      would happen at that time. The hourly sync already re-asks the bookings
//      in its window; this reaches the older ones and the calendar-only ones.
//   2. CALENDAR CALLS — a Google Meet call on the owner's calendar that never
//      went through Calendly (Bernadette's Oct 26 follow-up), with a client on
//      the guest list or named in the title, and either a program-call title or
//      a one-off that expected it. It gets a record (bookingSource CALENDAR),
//      so its Gemini notes are found and analysed like any booking's.
//   3. THE AI (15-minute AI job only, behind `ai_runs`) — for what is left,
//      one small model call per call, acted on only at 0.85 confidence; the
//      booking address is then verified as the client's alias so the hourly
//      sync reads the same answer.
// A filed call follows the existing chain: transcript discovery, INGEST and
// ANALYZE (transcript_jobs), so analysis runs once a call is matched.
// ---------------------------------------------------------------------------

const WAITING_STATES = ["UNMATCHED_INVITEE", "CANDIDATE", "PENDING"];
const LIVE = { notIn: ["CANCELLED", "RESCHEDULED"] };
const EXPECTED_WINDOW_MIN = 45;

type RawLite = {
  calendly?: { event?: { name?: string | null }; invitee?: unknown };
  calendar?: { summary?: string | null; attendees?: string[] };
  staff?: { unassignedAt?: string };
};
const readRawLite = (s: string | null): RawLite => { try { return s ? (JSON.parse(s) as RawLite) : {}; } catch { return {}; } };

export type WaitingCall = { id: string; inviteeName: string | null; inviteeEmail: string | null; scheduledStart: Date | null; callType: string; matchState: string; rawJson: string | null };

/** Calls still waiting for a client, a person's set-aside ones excepted. */
export async function waitingCalls(now: Date, sinceDays = 120): Promise<WaitingCall[]> {
  const rows = await prisma.programCallRecord.findMany({
    where: { matchState: { in: WAITING_STATES }, status: LIVE, callType: { in: ["MONTHLY_STRATEGY", "BRAND_DISCOVERY", "UNCLASSIFIED"] }, scheduledStart: { gte: new Date(now.getTime() - sinceDays * 864e5) } },
    orderBy: { scheduledStart: "desc" }, take: 200,
    select: { id: true, inviteeName: true, inviteeEmail: true, scheduledStart: true, callType: true, matchState: true, rawJson: true },
  });
  return rows.filter((r) => !(r.matchState === "CANDIDATE" && readRawLite(r.rawJson).staff?.unassignedAt));
}

export type PlannedMatch = { recordId: string; who: string; whenISO: string | null; clientId: string; enrollmentId: string; clientName: string; via: MatchVia | "expected" | "ai"; note: string; followup: { monthKey: string; reason: string } | null; factId: string | null };

/** The month the call that agreed a follow-up planned, for the follow-up to plan too. */
async function followupTarget(f: { callRecordId: string | null; monthId: string | null }, start: Date): Promise<{ monthKey: string; reason: string } | null> {
  const src = f.callRecordId ? await prisma.programCallRecord.findUnique({ where: { id: f.callRecordId }, select: { targetMonthKey: true, scheduledStart: true } }) : null;
  const key = src?.targetMonthKey ?? (f.monthId ? (await prisma.contentMonth.findUnique({ where: { id: f.monthId }, select: { monthKey: true } }))?.monthKey : null) ?? null;
  if (!key) return null;
  const when = (src?.scheduledStart ?? start).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  return { monthKey: key, reason: `the follow-up agreed on the ${when} call, so it plans ${key} as that call did` };
}

/** Pass 1, read-only: who each waiting call belongs to, by the signals and the expected calls. */
export async function planWaitingMatches(opts: { now?: Date; sinceDays?: number } = {}): Promise<{ planned: PlannedMatch[]; left: WaitingCall[] }> {
  const now = opts.now ?? new Date();
  const [waiting, expected, pool] = await Promise.all([waitingCalls(now, opts.sinceDays), expectedCalls(now), loadMatchPool()]);
  const nameOf = new Map(pool.map((c) => [c.clientId, c]));
  const planned: PlannedMatch[] = [];
  const left: WaitingCall[] = [];
  for (const r of waiting) {
    const raw = readRawLite(r.rawJson);
    // A portal token still on a waiting booking did not verify (the sync files a verified one): no name rule then.
    const { tokenOfInvitee } = await import("@/lib/callBooking");
    const unverifiedToken = !!tokenOfInvitee(raw.calendly?.invitee as Parameters<typeof tokenOfInvitee>[0]);
    const idn = await resolveInviteeIdentity(r.inviteeEmail, r.inviteeName, { phones: inviteePhones(raw.calendly?.invitee), attendeeEmails: raw.calendar?.attendees ?? [], nameAllowed: !unverifiedToken });
    const who = r.inviteeName ?? r.inviteeEmail ?? "someone";
    const whenISO = r.scheduledStart?.toISOString() ?? null;
    const exp = r.scheduledStart ? expectedCallNear(r.scheduledStart, idn.state === "MATCHED" ? idn.clientId : null, expected, EXPECTED_WINDOW_MIN) : null;
    if (idn.state === "MATCHED") {
      const c = nameOf.get(idn.clientId);
      planned.push({
        recordId: r.id, who, whenISO, clientId: idn.clientId, enrollmentId: idn.enrollmentId, clientName: c?.name ?? "?", via: idn.via as MatchVia,
        note: idn.via in VIA_WORDS ? `matched automatically: ${VIA_WORDS[idn.via as MatchVia]}${idn.evidence ? ` (${idn.evidence})` : ""}` : `matched via ${idn.via}`,
        followup: exp && r.scheduledStart ? await followupTarget(exp, r.scheduledStart) : null, factId: exp?.factId ?? null,
      });
      continue;
    }
    // A call nobody could place, at the time a client agreed to a follow-up
    // ("Bernadette agreed to a follow-up strategy call on Monday, October 26th
    // at 3:30pm"), with no address on file for anyone else: that client's.
    const own = exp ? nameOf.get(exp.clientId) : null;
    const otherOwner = r.inviteeEmail ? await prisma.client.count({ where: { id: { not: exp?.clientId ?? "" }, OR: [{ email: { equals: r.inviteeEmail, mode: "insensitive" } }, { backupEmail: { equals: r.inviteeEmail, mode: "insensitive" } }] } }) : 0;
    if (exp && own && !otherOwner && r.scheduledStart) {
      planned.push({
        recordId: r.id, who, whenISO, clientId: own.clientId, enrollmentId: own.enrollmentId, clientName: own.name, via: "expected",
        note: `matched automatically: ${own.name} agreed on a call to a follow-up at this time ("${exp.body.slice(0, 160)}")`,
        followup: await followupTarget(exp, r.scheduledStart), factId: exp.factId,
      });
      continue;
    }
    left.push(r);
  }
  return { planned, left };
}

/** Pass 1, applied. */
export async function rematchWaitingCalls(opts: { now?: Date; sinceDays?: number } = {}): Promise<{ filed: number; held: number; left: number; rows: { recordId: string; client: string; filed: boolean; why: string }[] }> {
  const now = opts.now ?? new Date();
  const { planned, left } = await planWaitingMatches({ now, sinceDays: opts.sinceDays });
  const rows: { recordId: string; client: string; filed: boolean; why: string }[] = [];
  let filed = 0, held = 0;
  for (const p of planned) {
    const r = await fileCallAutomatically(p.recordId, { clientId: p.clientId, enrollmentId: p.enrollmentId, note: p.note, followup: p.followup }, { now });
    if (r.filed) { filed++; if (p.factId) await markExpectedCallUsed(p.factId, p.recordId, now); } else held++;
    rows.push({ recordId: p.recordId, client: p.clientName, filed: r.filed, why: r.why });
  }
  return { filed, held, left: left.length, rows };
}

// ---------------------------------------------------------------------------
// Pass 2: the calendar.
// ---------------------------------------------------------------------------
export type CalendarFind = { eventId: string; title: string | null; startISO: string; clientId: string; clientName: string; enrollmentId: string; guest: string | null; why: string; followup: { monthKey: string; reason: string } | null; factId: string | null };

export async function discoverCalendarCalls(opts: { now?: Date; dryRun?: boolean; maxReads?: number } = {}): Promise<{ skipped: string } | { seen: number; found: number; created: number; refreshed: number; finds: CalendarFind[] }> {
  const { ownerGoogleToken } = await import("@/lib/integrations/google");
  if (!(await ownerGoogleToken())) return { skipped: "Google not connected" };
  const cal = await import("@/lib/integrations/googleCalendar");
  const now = opts.now ?? new Date();
  let events: Awaited<ReturnType<typeof cal.listCalendarEvents>>;
  try { events = await cal.listCalendarEvents(new Date(now.getTime() - 14 * 864e5), new Date(now.getTime() + 14 * 864e5)); }
  catch (e) { if (e instanceof cal.CalendarNotConnected) return { skipped: "Google Calendar scope missing" }; throw e; }
  const timed = events.filter((e) => !e.allDay && !e.ours && !e.buffer && e.virtual);
  const known = new Set((await prisma.programCallRecord.findMany({ where: { calendarExternalId: { in: timed.map((e) => e.id) } }, select: { calendarExternalId: true } })).map((r) => r.calendarExternalId!));
  const [pool, expected] = await Promise.all([loadMatchPool(), expectedCalls(now)]);
  const finds: CalendarFind[] = [];
  let reads = opts.maxReads ?? 15, created = 0;
  for (const e of timed) {
    if (known.has(e.id)) continue;
    const strong = looksLikeClientCall(e.title);
    const exp = expectedCallNear(e.start, null, expected, EXPECTED_WINDOW_MIN);
    if (!strong && !exp) continue;
    if (reads-- <= 0) break;
    const ev = await cal.getCalendarEvent(e.id).catch(() => null);
    if (!ev || ev.status === "cancelled" || !ev.start) continue;
    if (!ev.hangoutLink && !ev.conferenceId) continue; // no Meet, no Gemini notes to analyse
    const guests = ev.attendees.map((a) => a.email).filter((g) => !isTeamEmail(g));
    const byGuest = pool.filter((c) => guests.some((g) => c.emails.includes(g) || c.logins.includes(g)));
    const byTitle = pool.filter((c) => titleNamesClient(ev.summary, c.name));
    let client = new Set(byGuest.map((c) => c.clientId)).size === 1 ? byGuest[0] : null;
    let why = client ? `${guests.find((g) => client!.emails.includes(g) || client!.logins.includes(g))} is a guest on the invite` : "";
    if (!client && !byGuest.length && new Set(byTitle.map((c) => c.clientId)).size === 1) { client = byTitle[0]; why = `the invite's title names ${client.name}`; }
    const expFor = client ? expectedCallNear(ev.start, client.clientId, expected, EXPECTED_WINDOW_MIN) : exp;
    if (!client && expFor && !byGuest.length && !byTitle.length) { client = pool.find((c) => c.clientId === expFor.clientId) ?? null; if (client) why = `${client.name} agreed to a call at this time`; }
    if (!client) continue;
    // A program call: its title says so, or a one-off fact expected it.
    if (!strong && !(expFor && expFor.clientId === client.clientId)) continue;
    // The same call already on file (a Calendly booking of the same meeting).
    const near = await prisma.programCallRecord.count({ where: { clientId: client.clientId, scheduledStart: { gte: new Date(ev.start.getTime() - 30 * 60_000), lte: new Date(ev.start.getTime() + 30 * 60_000) } } });
    if (near) continue;
    // The strategy gate (Oct 21): a call before the program started or before
    // the strategy is in the portal is not a month's call. Not recorded.
    if (await strategyCallHold(client.enrollmentId, ev.start, null)) continue;
    const followup = expFor && expFor.clientId === client.clientId ? await followupTarget(expFor, ev.start) : null;
    finds.push({ eventId: ev.id, title: ev.summary, startISO: ev.start.toISOString(), clientId: client.clientId, clientName: client.name, enrollmentId: client.enrollmentId, guest: guests.find((g) => client!.emails.includes(g) || client!.logins.includes(g)) ?? null, why, followup, factId: expFor?.clientId === client.clientId ? expFor.factId : null });
    if (opts.dryRun) continue;
    const end = ev.end ?? new Date(ev.start.getTime() + 30 * 60_000);
    const note = `found on the calendar: ${why}${ev.summary ? ` ("${ev.summary}")` : ""}`;
    const raw = {
      calendar: { summary: ev.summary, start: ev.start.toISOString(), end: end.toISOString(), conferenceId: ev.conferenceId, attendees: ev.attendees.map((a) => a.email), linkedAt: now.toISOString(), error: null, attachmentFileIds: ev.attachments.map((a) => a.fileId) },
      identity: { note, candidates: [] },
    };
    const row = await prisma.programCallRecord.create({
      data: {
        callType: "MONTHLY_STRATEGY", inviteeEmail: finds[finds.length - 1].guest, inviteeName: client.name, scheduledStart: ev.start, scheduledEnd: end,
        calendarExternalId: ev.id, meetLink: ev.hangoutLink, meetConferenceId: ev.conferenceId, status: end < now ? "COMPLETED" : "SCHEDULED",
        matchState: "PENDING", bookingSource: "CALENDAR", rawJson: JSON.stringify(raw),
      },
      select: { id: true },
    });
    const filed = await fileCallAutomatically(row.id, { clientId: client.clientId, enrollmentId: client.enrollmentId, note, followup }, { now });
    created++;
    const f = finds[finds.length - 1];
    if (filed.filed && f.factId) await markExpectedCallUsed(f.factId, row.id, now);
  }
  // A calendar-only call moves on with the calendar: held once it ended,
  // cancelled once the event is gone (the month lets go of it then).
  let refreshed = 0;
  if (!opts.dryRun) {
    const mine = await prisma.programCallRecord.findMany({ where: { bookingSource: "CALENDAR", status: "SCHEDULED", calendarExternalId: { not: null } }, select: { id: true, calendarExternalId: true, scheduledEnd: true, scheduledStart: true, clientId: true, enrollmentId: true, matchNote: true }, take: 50 });
    for (const r of mine) {
      const live = timed.find((e) => e.id === r.calendarExternalId) ?? null;
      const gone = !live && (await cal.getCalendarEvent(r.calendarExternalId!).catch(() => undefined)) === null;
      const ended = (r.scheduledEnd ?? r.scheduledStart ?? now) < now;
      if (!gone && !ended) continue;
      await prisma.programCallRecord.update({ where: { id: r.id }, data: { status: gone ? "CANCELLED" : "COMPLETED", ...(gone ? { cancelledAt: now } : {}) } });
      if (gone && r.clientId && r.enrollmentId) await fileCallAutomatically(r.id, { clientId: r.clientId, enrollmentId: r.enrollmentId, note: r.matchNote ?? "found on the calendar" }, { now });
      refreshed++;
    }
  }
  return { seen: timed.length, found: finds.length, created, refreshed, finds };
}

/**
 * A FOLLOW-UP THAT ARRIVED BY CALENDLY: the hourly sync filed it by the
 * client's own address, so pass 1 never sees it. A kept one-off that expected
 * a call at that time is used up, and the call plans the month the original
 * call planned (unless a person or the portal already set it).
 */
export async function linkExpectedCalls(now: Date = new Date()): Promise<{ linked: number }> {
  let linked = 0;
  for (const exp of await expectedCalls(now)) {
    const rec = await prisma.programCallRecord.findFirst({
      where: { clientId: exp.clientId, status: LIVE, matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] }, scheduledStart: { gte: new Date(exp.at.getTime() - EXPECTED_WINDOW_MIN * 60_000), lte: new Date(exp.at.getTime() + EXPECTED_WINDOW_MIN * 60_000) } },
      select: { id: true, matchState: true, enrollmentId: true, matchNote: true, rawJson: true, transcriptState: true },
    });
    if (!rec) continue;
    const rule = (() => { try { return (JSON.parse(rec.rawJson ?? "{}") as { target?: { rule?: string } }).target?.rule ?? null; } catch { return null; } })();
    const settled = rec.matchState === "CONFIRMED_BY_STAFF" || rule === "staff" || rule === "portal" || rule === "followup" || rec.transcriptState === "CONFIRMED" || rec.transcriptState === "ANALYZED";
    if (!settled && rec.enrollmentId) {
      const followup = await followupTarget(exp, exp.at);
      if (followup) await fileCallAutomatically(rec.id, { clientId: exp.clientId, enrollmentId: rec.enrollmentId, note: rec.matchNote ?? "matched", followup }, { now });
    }
    await markExpectedCallUsed(exp.factId, rec.id, now);
    linked++;
  }
  return { linked };
}

/**
 * THE HOURLY PART (api/cron/sync, contentCallRecords step, before the
 * transcript discovery so a call filed here has its notes looked for in the
 * same pass). No model. Expired one-offs go first, so a past call is never
 * "expected".
 */
export async function autoMatchCalls(opts: { now?: Date } = {}): Promise<Record<string, unknown>> {
  const now = opts.now ?? new Date();
  const expired = await expireOneOffFacts(now);
  const waiting = await rematchWaitingCalls({ now });
  const calendar = await discoverCalendarCalls({ now });
  const expected = await linkExpectedCalls(now);
  return { expired: expired.expired, filed: waiting.filed, held: waiting.held, left: waiting.left, calendar: "skipped" in calendar ? calendar.skipped : { found: calendar.found, created: calendar.created, refreshed: calendar.refreshed }, expectedLinked: expected.linked };
}

// ---------------------------------------------------------------------------
// Pass 3: the AI, for what the signals left. One call per record, asked once
// a week at most (the run ledger is the memory); acted on at 0.85 only.
// ---------------------------------------------------------------------------
export const CALL_MATCH_MIN_START_MS = 40_000;

export async function aiMatchWaitingCalls(opts: { now?: Date; max?: number; budgetMs?: number; minStartMs?: number; requestedBy?: string; unattended?: boolean; dryRun?: boolean } = {}): Promise<{ asked: number; filed: number; noMatch: number; failed: number; outOfTime: boolean; rows: { recordId: string; who: string; client: string | null; why: string }[] }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const left = () => (opts.budgetMs ?? 60_000) - (Date.now() - started);
  const { left: waiting } = await planWaitingMatches({ now, sinceDays: 60 });
  // An ANSWERED ask is remembered for a week; a failed one (the model down) is asked again on the next tick.
  const recentRuns = await prisma.programAiRun.findMany({ where: { kind: "call_match", status: "SUCCEEDED", createdAt: { gte: new Date(now.getTime() - 7 * 864e5) } }, select: { scopeJson: true } });
  const askedIds = new Set(recentRuns.map((r) => { try { return (JSON.parse(r.scopeJson ?? "{}") as { callRecordId?: string }).callRecordId ?? ""; } catch { return ""; } }).filter(Boolean));
  const due = waiting.filter((w) => !askedIds.has(w.id) && (w.inviteeName || w.inviteeEmail));
  const rows: { recordId: string; who: string; client: string | null; why: string }[] = [];
  let asked = 0, filed = 0, noMatch = 0, failed = 0, outOfTime = false;
  if (!due.length) return { asked, filed, noMatch, failed, outOfTime, rows };
  const pool = await loadMatchPool();
  const companies = new Map((await prisma.client.findMany({ where: { id: { in: pool.map((c) => c.clientId) } }, select: { id: true, company: true } })).map((c) => [c.id, c.company]));
  const clients = pool.map((c) => ({ id: c.clientId, name: c.name, emails: [...c.emails, ...c.logins], phone: c.phone, company: companies.get(c.clientId) ?? null }));
  const ids = new Set(clients.map((c) => c.id));
  for (const w of due.slice(0, opts.max ?? 3)) {
    const who = w.inviteeName ?? w.inviteeEmail ?? "someone";
    if (opts.dryRun) { rows.push({ recordId: w.id, who, client: null, why: "would ask the AI" }); continue; }
    if (left() < (opts.minStartMs ?? CALL_MATCH_MIN_START_MS)) { outOfTime = true; break; }
    const raw = readRawLite(w.rawJson);
    const inv = (raw.calendly?.invitee ?? {}) as { questions_and_answers?: { answer?: string }[] };
    const call = {
      inviteeName: w.inviteeName, inviteeEmail: w.inviteeEmail, phones: inviteePhones(raw.calendly?.invitee),
      answers: (inv.questions_and_answers ?? []).map((q) => String(q?.answer ?? "")).filter(Boolean),
      calendarTitle: raw.calendar?.summary ?? null, guests: (raw.calendar?.attendees ?? []).filter((g) => !isTeamEmail(g)), eventName: raw.calendly?.event?.name ?? null, startISO: w.scheduledStart?.toISOString() ?? null,
    };
    asked++;
    try {
      const { runAiJson } = await import("@/lib/aiRuns");
      const r = await runAiJson<unknown>({
        kind: "call_match", clientId: null, enrollmentId: null, scope: { callRecordId: w.id }, promptKey: "call-match", promptVersion: "call-match.v1",
        requestedBy: opts.requestedBy ?? "cron", unattended: opts.unattended ?? true,
        system: CALL_MATCH_SYSTEM, prompt: callMatchPrompt(call, clients), schema: CALL_MATCH_SCHEMA as unknown as Record<string, unknown>, maxTokens: 600,
      });
      const m = acceptCallMatch(r.output, ids);
      if (!m) { noMatch++; rows.push({ recordId: w.id, who, client: null, why: "the AI could not place it" }); continue; }
      const c = pool.find((x) => x.clientId === m.clientId)!;
      const res = await fileCallAutomatically(w.id, { clientId: c.clientId, enrollmentId: c.enrollmentId, note: `matched by the AI (${Math.round(m.confidence * 100)}%): ${m.reason}`, verifyAliasBy: `ai-call-match: ${m.reason}`.slice(0, 190) }, { now });
      if (res.filed) filed++;
      rows.push({ recordId: w.id, who, client: c.name, why: res.why });
    } catch (e) {
      failed++;
      if (/switched off/i.test(e instanceof Error ? e.message : String(e))) break;
    }
  }
  return { asked, filed, noMatch, failed, outOfTime, rows };
}
