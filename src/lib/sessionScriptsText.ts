import "server-only";
import { prisma } from "@/lib/prisma";
import { etAt, etDayKey, etHour, etTime } from "@/lib/datetime";
import { staffText, staffTextNumber } from "@/lib/hubSms";
import { isSyntheticClientRow } from "@/lib/testClients";
import { DEFAULT_TEXTS, type TextTemplateSet } from "@/lib/textTemplates";
import { liveAppointment } from "@/lib/shootDayText";

// ---------------------------------------------------------------------------
// THE SCRIPTS LINK, THE MORNING OF A CONTENT SESSION (Oct 23 2026). Jordan:
// "make sure that the creatives (either Harrison or James) whoever is assigned
// to the appointment gets a text with a link to their My Shoots page for the
// scripts for the monthly content sessions. Like John's session today,
// Harrison should get a text."
//
// WHEN. Every 5 minutes (cron/gmail), from 7 AM ET on the session's own day
// until its start: the first tick at or after 7 sends, and a session booked
// later that morning is texted on the next tick. Never after the start, never
// for a cancelled or postponed appointment, a cancelled or on-hold job, or a
// test client.
//
// WHO. The creative on that appointment (Appointment.assignedTo; the job's
// photographer when the appointment names nobody). Texted from the company
// line through the durable outbox (kind `session_scripts`), keyed per job, per
// creative, per ET day: sent once, never twice. No textable number, our own
// office line on file, or their own quiet time: nothing (the quiet time is
// asked again next tick, inside the window).
//
// WHAT. The session_scripts template (Settings → Text messages): who, when,
// where, and the session's shoot page, where its topics and scripts are.
//
// Behind its own switch (Settings, Internal alerts, "Scripts link on session
// day"), default on. Staff only: no client is ever texted from here.
// ---------------------------------------------------------------------------

/** The ET hour the session-day text may first go. */
export const SESSION_SCRIPTS_FROM_HOUR = 7;
const REQUESTED_BY = "session-scripts-text";

const streetOf = (title: string, addressLine: string | null) =>
  (addressLine?.trim() && !/^\[No address/i.test(addressLine) ? addressLine.trim() : title.split(",")[0].trim()) || "the session";
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;
const clientFirst = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || "the client";

export const sessionScriptsKey = (projectId: string, teamMemberId: string, day: string) => `session_scripts:${projectId}:${teamMemberId}:${day}`;

/** "⚙️ Realtour Hub: Hi Harrison, John's content session is today at 1:30 PM at 80 W Lancaster Ave. …" */
export function composeSessionScriptsText(o: { name: string; client: string; startAt: Date; street: string; link: string }, t: TextTemplateSet = DEFAULT_TEXTS): string {
  return staffText(t.render("session_scripts", { firstName: firstName(o.name), client: clientFirst(o.client), time: etTime(o.startAt), street: o.street, link: o.link }));
}

export type SessionScriptsCandidate = {
  projectId: string; startAt: Date; street: string; teamMemberId: string; name: string;
  toKey: string | null; dedupeKey: string; text: string | null; skip: string | null;
};

/** Every (content session, creative) on today's ET calendar that has not started, with the text it would get. */
export async function sessionScriptsCandidates(now: Date = new Date()): Promise<SessionScriptsCandidate[]> {
  if (etHour(now) < SESSION_SCRIPTS_FROM_HOUR) return [];
  const day = etDayKey(now);
  const [y, m, d] = day.split("-").map(Number);
  const dayEnd = etAt(new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10), 0);
  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gt: now, lt: dayEnd },
      project: { contentMonthId: { not: null }, status: { notIn: ["CANCELLED", "ON_HOLD"] } },
    },
    orderBy: { startAt: "asc" },
    select: {
      id: true, startAt: true, status: true, assignedToId: true,
      project: { select: { id: true, title: true, addressLine: true, photographerId: true, client: { select: { id: true, name: true } } } },
    },
  });
  type Appt = (typeof appts)[number];
  const groups = new Map<string, { a: Appt; teamMemberId: string }>();
  for (const a of appts) {
    if (!liveAppointment(a) || isSyntheticClientRow(a.project.client)) continue;
    const who = a.assignedToId ?? a.project.photographerId;
    if (!who) continue;
    const k = `${a.project.id}|${who}`;
    if (!groups.has(k)) groups.set(k, { a, teamMemberId: who });
  }
  if (groups.size === 0) return [];
  const rows = [...groups.values()].map(({ a, teamMemberId }) => ({ a, teamMemberId, dedupeKey: sessionScriptsKey(a.project.id, teamMemberId, day) }));
  const { appBase } = await import("@/lib/appUrl");
  const { loadTextTemplates } = await import("@/lib/textTemplateStore");
  const [words, taken, members] = await Promise.all([
    loadTextTemplates(),
    prisma.outboxMessage.findMany({ where: { dedupeKey: { in: rows.map((r) => r.dedupeKey) } }, select: { dedupeKey: true } }),
    prisma.teamMember.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.teamMemberId))] } }, select: { id: true, name: true, phone: true, active: true } }),
  ]);
  const takenKeys = new Set(taken.map((t) => t.dedupeKey));
  const memberOf = new Map(members.map((mm) => [mm.id, mm]));
  return rows.map(({ a, teamMemberId, dedupeKey }) => {
    const mm = memberOf.get(teamMemberId);
    const num = staffTextNumber(mm?.phone);
    const street = streetOf(a.project.title, a.project.addressLine);
    const base = { projectId: a.project.id, startAt: a.startAt!, street, teamMemberId, name: mm?.name ?? "(not on the roster)", toKey: num?.key ?? null, dedupeKey };
    if (takenKeys.has(dedupeKey)) return { ...base, text: null, skip: "already sent" };
    const text = composeSessionScriptsText({ name: base.name, client: a.project.client?.name ?? "", startAt: base.startAt, street, link: `${appBase()}/shoot/${a.project.id}` }, words);
    const skip = !mm || !mm.active ? "not an active team member" : !num ? "no phone" : null;
    return { ...base, text, skip };
  });
}

export type SessionScriptsRun = { skipped: string } | { considered: number; sent: string[]; notSent: string[] };

/** Every 5 minutes (cron/gmail). Idle before 7 AM ET and on days with no content session left. */
export async function sweepSessionScriptsTexts(now: Date = new Date()): Promise<SessionScriptsRun> {
  const { internalAlertRules } = await import("@/lib/settings");
  const rules = await internalAlertRules();
  if (!rules.sessionScriptsText.enabled) return { skipped: "switched off (Settings, Internal alerts, Scripts link on session day)" };
  const candidates = await sessionScriptsCandidates(now);
  const run = { considered: candidates.length, sent: [] as string[], notSent: [] as string[] };
  const due = candidates.filter((c) => !c.skip && c.text && c.toKey);
  for (const c of candidates) if (c.skip && c.skip !== "already sent") run.notSent.push(`${c.street} to ${c.name}: ${c.skip}`);
  if (due.length === 0) return run;
  const { ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
  const { holdFor } = await import("@/lib/notifySchedule");
  const { sendThroughOutbox } = await import("@/lib/outbox");
  const ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
  for (const c of due) {
    const label = `${c.street} to ${c.name}`;
    if (ours.has(c.toKey!)) { run.notSent.push(`${label}: their number is our own office line`); continue; }
    if (await holdFor(c.teamMemberId, now)) { run.notSent.push(`${label}: their quiet time`); continue; }
    try {
      const r = await sendThroughOutbox({ channel: "sms", toRef: c.toKey!, body: c.text!, dedupeKey: c.dedupeKey, projectId: c.projectId, requestedBy: REQUESTED_BY });
      if (r.outcome === "accepted" || r.outcome === "unknown") {
        await prisma.activity.create({ data: { projectId: c.projectId, type: "SYSTEM", body: `Texted ${firstName(c.name)} the link to today's scripts at ${etTime(new Date())}${r.outcome === "unknown" ? ", but OpenPhone did not confirm it" : ""}.` } }).catch(() => {});
        if (r.outcome === "accepted") run.sent.push(label);
        else run.notSent.push(`${label}: unconfirmed, held for a person`);
      } else {
        run.notSent.push(`${label}: ${r.outcome}${"error" in r && r.error ? ` (${r.error})` : ""}`);
      }
    } catch (e) {
      run.notSent.push(`${label}: could not queue (${e instanceof Error ? e.message : "error"})`);
    }
  }
  return run;
}
