import "server-only";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { etDayKey } from "@/lib/datetime";
import { getSetting } from "@/lib/settings";
import {
  enabledCallMappings, listScheduledEvents, type CallMapping, type CallPurpose, type Invitee, type ScheduledEvent,
} from "@/lib/integrations/calendly";
import { enqueueTranscriptJob, cancelTranscriptJobs } from "@/lib/transcriptJobs";
import { recalcProgramMonth } from "@/lib/programMonths";
import { isTestClientName } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// CALL RECORDS (spec §20 / §21 / §26), Sep 16 2026.
//
// The verified chain from a Calendly booking to an analysable transcript:
//
//   booking ──(event-type URI → ProgramCalendlyEventMapping)──▶ purpose
//     └─(invitee email → Client.email / backupEmail / VERIFIED ClientEmailAlias)──▶ client + enrollment
//         └─(rule: day-of-month → target month | discovery → onboarding)──▶ target
//             └─(calendar_event.external_id → Google Calendar event)──▶ summary + start + Meet conference id
//                 └─(Drive "Notes by Gemini" doc: title prefix == summary AND stamp == start, uniquely)──▶ ProgramTranscriptSource
//                     └──▶ ProgramTranscriptJob INGEST + ANALYZE (run only when transcript_jobs is ON)
//
// Every link that cannot be VERIFIED stops at a review state (UNMATCHED_INVITEE,
// AMBIGUOUS_CLIENT, UNMAPPED_TYPE, CANDIDATES, NEEDS_REVIEW) with a SmartTask
// for Jordan listing the candidates. Nothing here guesses a client from a first
// name, picks "the newest file", or moves a transcript to a rescheduled
// booking. Unrelated bookings (no enabled mapping for their type) never get a
// row at all — that is what keeps "30 Minute Strategy Call" out of the program.
// ---------------------------------------------------------------------------

export type CallRecordRules = {
  /** A monthly call on or after this ET day-of-month plans the NEXT month. */
  nextMonthFromDay: number;
  /** Event types that ALWAYS plan the next month (a mapping-level override kept in the KV — the mapping table has no config column). */
  planNextMonthEventTypeUris: string[];
  lookBackDays: number;
  lookAheadDays: number;
  /** How long after a held call the hub waits for a transcript before raising an exception. */
  transcriptGraceHours: number;
  /** ±minutes between the booked start and a Gemini doc's title stamp to count as the same meeting. */
  startToleranceMinutes: number;
};
export const DEFAULT_CALL_RULES: CallRecordRules = {
  nextMonthFromDay: 24, planNextMonthEventTypeUris: [], lookBackDays: 45, lookAheadDays: 60, transcriptGraceHours: 48, startToleranceMinutes: 20,
};
export const CALL_RULES_KEY = "content_call_rules";
export async function callRecordRules(): Promise<CallRecordRules> {
  const v = await getSetting<Partial<CallRecordRules>>(CALL_RULES_KEY, {});
  return { ...DEFAULT_CALL_RULES, ...v };
}

const REVIEW_KEY_PREFIX = "content-call-review-";
const REVIEW_STATES = ["UNMATCHED_INVITEE", "AMBIGUOUS_CLIENT", "AMBIGUOUS_MONTH", "UNMAPPED_TYPE"];
const DONE = ["COMPLETED", "CANCELLED"];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Raw = {
  calendly?: { event: ScheduledEvent; invitee: Invitee | null };
  target?: { rule: string; reason: string; monthKey?: string | null };
  calendar?: { summary: string | null; start: string | null; end: string | null; conferenceId: string | null; attendees: string[]; linkedAt: string; error?: string | null };
  transcripts?: { checkedAt: string; windowDocs: number; strongDocs: number };
  identity?: { note: string; candidates: { clientId: string; name: string; reason: string }[] };
  /** Why no ANALYZE job was queued for a confirmed transcript (the legacy sweep already analysed that month). */
  analysis?: { skipped: string; at: string };
};
const readRaw = (s: string | null | undefined): Raw => {
  if (!s) return {};
  try { return JSON.parse(s) as Raw; } catch { return {}; }
};

// ---------------------------------------------------------------------------
// Identity — the only three sources of truth for "this email is this client".
// ---------------------------------------------------------------------------
export type IdentityCandidate = {
  clientId: string; enrollmentId: string; name: string; reason: string;
  /** The invitee address is ALREADY on this client's record (email/backupEmail) — an alias proposal would be noise. */
  onFile: boolean;
  /** The candidate's enrollment is ACTIVE — the only kind an alias can ever be verified for. */
  active: boolean;
};
export type IdentityResolution =
  | { state: "MATCHED"; clientId: string; enrollmentId: string; via: "email" | "backupEmail" | "alias" }
  | { state: "UNMATCHED_INVITEE"; candidates: IdentityCandidate[] }
  | { state: "AMBIGUOUS_CLIENT"; candidates: IdentityCandidate[] };

export async function resolveInviteeIdentity(email: string | null | undefined, inviteeName?: string | null): Promise<IdentityResolution> {
  const e = (email ?? "").trim().toLowerCase();
  // Only an ACTIVE enrollment is a program identity: a booking from a client
  // whose program ENDED (Susan McFadden books the generic call) or is PAUSED
  // is not automatic work — it is listed as a candidate for a person.
  const all = await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true, status: true } });
  const enrollmentOf = new Map(all.filter((x) => x.status === "ACTIVE").map((x) => [x.clientId, x.id]));
  const inactiveOf = new Map(all.filter((x) => x.status !== "ACTIVE").map((x) => [x.clientId, x]));
  if (!e) return { state: "UNMATCHED_INVITEE", candidates: [] };

  const [direct, aliases] = await Promise.all([
    prisma.client.findMany({
      where: { OR: [{ email: { equals: e, mode: "insensitive" } }, { backupEmail: { equals: e, mode: "insensitive" } }] },
      select: { id: true, name: true, email: true, backupEmail: true },
    }),
    prisma.clientEmailAlias.findMany({ where: { email: e, active: true, verifiedAt: { not: null } }, select: { clientId: true } }),
  ]);
  const hits = new Map<string, { via: "email" | "backupEmail" | "alias"; name: string }>();
  const inactive: IdentityCandidate[] = [];
  for (const c of direct) {
    const gone = inactiveOf.get(c.id);
    if (gone) inactive.push({ clientId: c.id, enrollmentId: gone.id, name: c.name, reason: `address on file, but the enrollment is ${gone.status}`, onFile: true, active: false });
    if (!enrollmentOf.has(c.id)) continue; // an email on a non-program client is not a program identity
    hits.set(c.id, { via: c.email?.toLowerCase() === e ? "email" : "backupEmail", name: c.name });
  }
  for (const a of aliases) {
    if (!enrollmentOf.has(a.clientId) || hits.has(a.clientId)) continue;
    const c = await prisma.client.findUnique({ where: { id: a.clientId }, select: { name: true } });
    hits.set(a.clientId, { via: "alias", name: c?.name ?? "?" });
  }
  if (hits.size === 1) {
    const [clientId, h] = [...hits.entries()][0];
    return { state: "MATCHED", clientId, enrollmentId: enrollmentOf.get(clientId)!, via: h.via };
  }
  if (hits.size > 1) {
    return {
      state: "AMBIGUOUS_CLIENT",
      candidates: [...hits.entries()].map(([clientId, h]) => ({ clientId, enrollmentId: enrollmentOf.get(clientId)!, name: h.name, reason: `same address on file (${h.via})`, onFile: true, active: true })),
    };
  }
  // No verified identity. Rank candidates for the human — by FULL name only
  // (a first name alone is exactly the guess the spec forbids) — and never act on them.
  const candidates: IdentityCandidate[] = [...inactive];
  const want = norm(inviteeName ?? "");
  if (want && want.includes(" ")) {
    const clients = await prisma.client.findMany({ where: { id: { in: [...enrollmentOf.keys()] } }, select: { id: true, name: true, email: true, backupEmail: true } });
    for (const c of clients) {
      const have = norm(c.name);
      if (have === want || (have.startsWith(want) && have.length - want.length <= 3)) {
        const onFile = [c.email, c.backupEmail].some((x) => x?.toLowerCase() === e);
        candidates.push({ clientId: c.id, enrollmentId: enrollmentOf.get(c.id)!, name: c.name, reason: `invitee name "${inviteeName}" matches the client's name; email ${e} is not on their record`, onFile, active: true });
      }
    }
  }
  return { state: "UNMATCHED_INVITEE", candidates };
}

/**
 * An unverified alias PROPOSAL from an unmatched invitee: Arielle books from
 * @foxroach.com, her record says gmail. A proposal never matches anything —
 * verifyClientEmailAlias (staff) is the only way it becomes one.
 */
export async function proposeClientEmailAlias(clientId: string, enrollmentId: string | null, email: string, source = "calendly"): Promise<{ id: string; created: boolean; verified: boolean }> {
  const e = email.trim().toLowerCase();
  const existing = await prisma.clientEmailAlias.findUnique({ where: { clientId_email: { clientId, email: e } }, select: { id: true, verifiedAt: true } });
  if (existing) return { id: existing.id, created: false, verified: !!existing.verifiedAt };
  const row = await prisma.clientEmailAlias.create({ data: { clientId, enrollmentId, email: e, source, verifiedAt: null }, select: { id: true } });
  return { id: row.id, created: true, verified: false };
}

export async function verifyClientEmailAlias(aliasId: string, by: string | null): Promise<void> {
  await prisma.clientEmailAlias.update({ where: { id: aliasId }, data: { verifiedAt: new Date(), verifiedBy: by, active: true } });
}
export async function dismissClientEmailAlias(aliasId: string): Promise<void> {
  await prisma.clientEmailAlias.update({ where: { id: aliasId }, data: { active: false } });
}

// ---------------------------------------------------------------------------
// Target month rule — explicit, stored with its reason.
// ---------------------------------------------------------------------------
export function targetMonthFor(start: Date, eventTypeUri: string | null, rules: CallRecordRules): { monthKey: string; rule: string; reason: string } {
  const own = etMonthKey(start);
  const day = Number(etDayKey(start).slice(8, 10));
  const next = (() => { const [y, m] = own.split("-").map(Number); return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`; })();
  if (eventTypeUri && rules.planNextMonthEventTypeUris.includes(eventTypeUri)) {
    return { monthKey: next, rule: "mapping", reason: `this event type always plans the next month → ${next}` };
  }
  if (day >= rules.nextMonthFromDay) {
    return { monthKey: next, rule: "late-month", reason: `held on day ${day} (≥ ${rules.nextMonthFromDay}) → plans the next month, ${next}` };
  }
  return { monthKey: own, rule: "same-month", reason: `held on day ${day} (< ${rules.nextMonthFromDay}) → plans its own month, ${own}` };
}

async function ensureMonth(enrollmentId: string, clientId: string, monthKey: string): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId, monthKey } }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { videosPerMonth: true, strategyCallRequired: true } });
  const row = await prisma.contentMonth.create({
    data: {
      enrollmentId, clientId, monthKey,
      videosOwed: e?.videosPerMonth ?? 4,
      strategyCallStatus: e?.strategyCallRequired === false ? "NOT_REQUIRED" : "NOT_SCHEDULED",
      ...(monthKey < etMonthKey() ? { historical: true, status: "IMPORTED" } : {}),
    },
    select: { id: true },
  });
  return { id: row.id, created: true };
}

async function ensureOnboarding(enrollmentId: string, clientId: string): Promise<string> {
  const row = await prisma.programOnboarding.upsert({
    where: { enrollmentId }, create: { enrollmentId, clientId }, update: {}, select: { id: true },
  });
  return row.id;
}

// ---------------------------------------------------------------------------
// Review queue — a task for Jordan with the candidates, closed when resolved.
// ---------------------------------------------------------------------------
async function ensureReviewTask(record: { id: string; clientId: string | null; inviteeName: string | null; inviteeEmail: string | null; scheduledStart: Date | null; callType: string }, reason: string, lines: string[]): Promise<void> {
  if (record.clientId) {
    const c = await prisma.client.findUnique({ where: { id: record.clientId }, select: { name: true } });
    if (isTestClientName(c?.name)) return; // test records make no owner work
  }
  if (isTestClientName(record.inviteeName)) return;
  const dedupeKey = `${REVIEW_KEY_PREFIX}${record.id}`;
  const when = record.scheduledStart ? record.scheduledStart.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "unknown time";
  const who = record.inviteeName || record.inviteeEmail || "unknown invitee";
  const title = clip(`Review a content-program call — ${who}, ${when}`, 140);
  const description = [
    `${reason}`,
    "",
    ...lines,
    "",
    `Resolve it on Settings → Calendly & calls (record ${record.id}). Nothing is analysed until a person confirms.`,
  ].join("\n");
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, status: true } });
  if (existing) {
    if (DONE.includes(existing.status)) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { status: "OPEN", completedAt: null, description, summary: clip(reason, 200) } });
    }
    return;
  }
  await prisma.smartTask.create({
    data: {
      title, description, summary: clip(reason, 200),
      taskType: "todo", status: "OPEN", source: "content_program", priority: "MEDIUM",
      clientId: record.clientId, dedupeKey, assignedKey: "jordan",
      dueAt: new Date(Date.now() + 2 * 864e5),
      reasonCreated: `Content-program call needs a human decision (${record.callType})`,
    },
  });
}

/** Hourly: close review tasks whose record has been resolved (or ignored). */
export async function reconcileCallReviewTasks(): Promise<{ closed: number }> {
  const open = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: REVIEW_KEY_PREFIX }, status: { notIn: DONE } }, select: { id: true, dedupeKey: true } });
  let closed = 0;
  for (const t of open) {
    const id = t.dedupeKey!.slice(REVIEW_KEY_PREFIX.length);
    const r = await prisma.programCallRecord.findUnique({ where: { id }, select: { matchState: true, transcriptState: true, status: true } });
    const stillOpen = r && (REVIEW_STATES.includes(r.matchState) || r.transcriptState === "CANDIDATES" || r.transcriptState === "NEEDS_REVIEW") && r.matchState !== "IGNORED";
    if (stillOpen) continue;
    await prisma.smartTask.update({ where: { id: t.id }, data: { status: r ? "COMPLETED" : "CANCELLED", completedAt: new Date() } });
    closed++;
  }
  return { closed };
}

// ---------------------------------------------------------------------------
// Apply a verified identity + purpose to a record: month or onboarding.
// Shared by the sweep and the staff confirmations, so both take the same path.
// ---------------------------------------------------------------------------
async function applyTarget(recordId: string, rules: CallRecordRules): Promise<{ monthId: string | null; onboardingId: string | null; touchedMonthIds: string[] }> {
  const r = await prisma.programCallRecord.findUnique({
    where: { id: recordId },
    select: { id: true, clientId: true, enrollmentId: true, callType: true, calendlyEventTypeUri: true, scheduledStart: true, scheduledEnd: true, status: true, monthId: true, onboardingId: true, transcriptState: true, matchState: true, rawJson: true, targetMonthKey: true },
  });
  if (!r || !r.clientId || !r.enrollmentId || !r.scheduledStart) return { monthId: null, onboardingId: null, touchedMonthIds: [] };
  const raw = readRaw(r.rawJson);
  const touched: string[] = [];
  if (r.callType === "MONTHLY_STRATEGY") {
    // The rule never overrides a person. A target is LOCKED when
    //   · staff retargeted it (setCallRecordTargetMonth writes rule "staff") —
    //     the hourly sync used to re-run the day-of-month rule over that
    //     decision and quietly move a late-September call back to October;
    //   · staff confirmed the client and saw the target that was computed
    //     then (CONFIRMED_BY_STAFF with a targetMonthKey on file);
    //   · a transcript is confirmed/analysed on the month.
    // Only a fresh MATCHED record with nothing on file follows the rule on
    // every pass (so a rule change before the call applies to it).
    const staffDecided = raw.target?.rule === "staff" || (r.matchState === "CONFIRMED_BY_STAFF" && !!r.targetMonthKey);
    const locked = staffDecided || r.transcriptState === "CONFIRMED" || r.transcriptState === "ANALYZED";
    const target = r.targetMonthKey && locked
      ? { monthKey: r.targetMonthKey, rule: raw.target?.rule ?? "kept", reason: raw.target?.reason ?? (staffDecided ? "kept (decided by staff)" : "kept (transcript on file)") }
      : targetMonthFor(r.scheduledStart, r.calendlyEventTypeUri, rules);
    const month = await ensureMonth(r.enrollmentId, r.clientId, target.monthKey);
    if (r.monthId && r.monthId !== month.id) {
      // Moved: the old month lets go of this record as "the call that planned it".
      await prisma.contentMonth.updateMany({ where: { id: r.monthId, callRecordId: r.id }, data: { callRecordId: null } });
      touched.push(r.monthId);
    }
    touched.push(month.id);
    await prisma.programCallRecord.update({
      where: { id: r.id },
      data: { monthId: month.id, targetMonthKey: target.monthKey, onboardingId: null, rawJson: JSON.stringify({ ...raw, target }) },
    });
    // The month remembers the call that planned it — the first live one wins;
    // a later, second call in the same month is its own record. A cancelled or
    // rescheduled booking releases the pointer so its replacement can take it.
    const dead = r.status === "CANCELLED" || r.status === "RESCHEDULED";
    if (dead) await prisma.contentMonth.updateMany({ where: { id: month.id, callRecordId: r.id }, data: { callRecordId: null } });
    else await prisma.contentMonth.updateMany({ where: { id: month.id, callRecordId: null }, data: { callRecordId: r.id } });
    return { monthId: month.id, onboardingId: null, touchedMonthIds: touched };
  }
  if (r.callType === "BRAND_DISCOVERY") {
    const onboardingId = await ensureOnboarding(r.enrollmentId, r.clientId);
    const ob = await prisma.programOnboarding.findUnique({ where: { id: onboardingId }, select: { status: true, discoveryCallRecordId: true } });
    const held = (r.scheduledEnd ?? r.scheduledStart) < new Date();
    const cancelled = r.status === "CANCELLED" || r.status === "RESCHEDULED";
    const data: { discoveryCallRecordId?: string; status?: string } = {};
    // Point the onboarding at THIS booking when it has none, or its current one
    // was cancelled/rescheduled and this is the live replacement.
    if (!cancelled) {
      const cur = ob?.discoveryCallRecordId ? await prisma.programCallRecord.findUnique({ where: { id: ob.discoveryCallRecordId }, select: { status: true } }) : null;
      if (!ob?.discoveryCallRecordId || cur?.status === "CANCELLED" || cur?.status === "RESCHEDULED") data.discoveryCallRecordId = r.id;
      const early = ["NOT_STARTED", "DISCOVERY_BOOKED", "DISCOVERY_HELD"];
      if (ob && early.includes(ob.status)) data.status = held ? "DISCOVERY_HELD" : "DISCOVERY_BOOKED";
    } else if (ob?.discoveryCallRecordId === r.id && ob.status === "DISCOVERY_BOOKED") {
      data.status = "NOT_STARTED";
    }
    if (Object.keys(data).length) await prisma.programOnboarding.update({ where: { id: onboardingId }, data });
    if (r.monthId) {
      // Reclassified from MONTHLY to DISCOVERY (a mapping's purpose changed):
      // the month it used to plan lets go of the pointer, same as a move.
      await prisma.contentMonth.updateMany({ where: { id: r.monthId, callRecordId: r.id }, data: { callRecordId: null } });
      touched.push(r.monthId);
    }
    await prisma.programCallRecord.update({ where: { id: r.id }, data: { onboardingId, monthId: null, targetMonthKey: null, rawJson: JSON.stringify({ ...raw, target: { rule: "discovery", reason: "brand discovery → onboarding record, never a month" } }) } });
    return { monthId: null, onboardingId, touchedMonthIds: touched };
  }
  return { monthId: r.monthId, onboardingId: r.onboardingId, touchedMonthIds: [] };
}

// ---------------------------------------------------------------------------
// 1. Bookings → records.
// ---------------------------------------------------------------------------
export type SyncCallRecordsResult = {
  scanned: number; unrelated: number; created: number; updated: number; matched: number; review: number; cancelled: number; rescheduled: number;
  aliasProposals: number; monthsTouched: number; dryRun: boolean; window: { from: string; to: string };
  /** Bookings that threw (a P2002 from an overlapping "Sync now", a Prisma hiccup) — logged and skipped, never the whole sweep. */
  errors: number; lastError: string | null;
};

export async function syncCallRecordsFromCalendly(opts: { now?: Date; dryRun?: boolean; lookBackDays?: number; lookAheadDays?: number } = {}): Promise<SyncCallRecordsResult | { skipped: string }> {
  const { getSecret, markSynced } = await import("@/lib/integrations/connections");
  if (!(await getSecret("calendly"))) return { skipped: "Calendly not connected" };
  const mappings = await enabledCallMappings();
  const program = new Map([...mappings].filter(([, m]) => m.purpose !== "IGNORED"));
  if (program.size === 0) return { skipped: "no enabled Calendly mapping — map the dedicated event types on Settings" };
  const rules = await callRecordRules();
  const now = opts.now ?? new Date();
  const dryRun = !!opts.dryRun;
  const from = new Date(now.getTime() - (opts.lookBackDays ?? rules.lookBackDays) * 864e5);
  const to = new Date(now.getTime() + (opts.lookAheadDays ?? rules.lookAheadDays) * 864e5);
  const out: SyncCallRecordsResult = { scanned: 0, unrelated: 0, created: 0, updated: 0, matched: 0, review: 0, cancelled: 0, rescheduled: 0, aliasProposals: 0, monthsTouched: 0, dryRun, window: { from: from.toISOString(), to: to.toISOString() }, errors: 0, lastError: null };

  const events = await listScheduledEvents(from.toISOString(), to.toISOString(), { eventTypeUris: new Set(program.keys()) });
  const touchedMonths = new Set<string>();

  for (const item of events) {
    out.scanned++;
    const mapping: CallMapping | undefined = item.event.event_type ? program.get(item.event.event_type) : undefined;
    if (!mapping) { out.unrelated++; continue; } // outside the program: no row, no trace
    // One booking failing (an overlapping cron + "Sync now" racing the unique
    // calendlyEventUri, a transient DB error) must not abort the other 28.
    try {
      await syncOneBooking(item, mapping, { rules, now, dryRun, out, touchedMonths });
    } catch (e) {
      out.errors++;
      out.lastError = `${item.event.uri}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    }
  }

  for (const m of touchedMonths) await recalcProgramMonth(m, { now });
  out.monthsTouched = touchedMonths.size;
  if (!dryRun) {
    await prisma.programCalendlyEventMapping.updateMany({ where: { id: { in: [...program.values()].map((m) => m.id) } }, data: { lastSyncedAt: now, lastError: out.lastError } });
    await markSynced("calendly").catch(() => {});
  }
  return out;
}

async function syncOneBooking(
  { event, invitees }: { event: ScheduledEvent; invitees: Invitee[] },
  mapping: CallMapping,
  ctx: { rules: CallRecordRules; now: Date; dryRun: boolean; out: SyncCallRecordsResult; touchedMonths: Set<string> },
): Promise<void> {
  const { rules, now, dryRun, out, touchedMonths } = ctx;
  {
    const invitee = invitees.find((i) => i.status === "active") ?? invitees[0] ?? null;
    const start = event.start_time ? new Date(event.start_time) : null;
    const end = event.end_time ? new Date(event.end_time) : null;
    const cancelled = event.status === "canceled";
    const rescheduledAway = !!invitee?.rescheduled && !!invitee?.new_invitee;
    const status = rescheduledAway ? "RESCHEDULED" : cancelled ? "CANCELLED" : end && end < now ? "COMPLETED" : "SCHEDULED";

    const existing = await prisma.programCallRecord.findUnique({
      where: { calendlyEventUri: event.uri },
      select: { id: true, matchState: true, clientId: true, enrollmentId: true, inviteeEmail: true, status: true, monthId: true, rawJson: true, transcriptState: true, callType: true },
    });
    const staffOwned = existing?.matchState === "CONFIRMED_BY_STAFF" || existing?.matchState === "IGNORED";
    const raw: Raw = { ...readRaw(existing?.rawJson), calendly: { event, invitee } };

    // The replacement booking of a reschedule points back at the original.
    let rescheduledFromId: string | null = null;
    if (invitee?.old_invitee) {
      const prev = await prisma.programCallRecord.findFirst({ where: { calendlyInviteeUri: invitee.old_invitee }, select: { id: true } });
      rescheduledFromId = prev?.id ?? null;
    }

    const provider = {
      callType: staffOwned ? undefined : (mapping.purpose as CallPurpose),
      mappingId: mapping.id,
      calendlyInviteeUri: invitee?.uri ?? null,
      calendlyEventTypeUri: event.event_type ?? null,
      inviteeEmail: invitee?.email?.toLowerCase() ?? null,
      inviteeName: invitee?.name ?? null,
      scheduledStart: start, scheduledEnd: end,
      timezone: invitee?.timezone ?? null,
      calendarExternalId: event.calendar_event?.external_id ?? null,
      meetLink: event.location?.join_url ?? null,
      status,
      cancelledAt: cancelled ? (existing?.status === "CANCELLED" ? undefined : now) : null,
      ...(rescheduledFromId ? { rescheduledFromId } : {}),
    };

    if (dryRun) {
      if (!existing) out.created++; else out.updated++;
      if (status === "CANCELLED") out.cancelled++;
      if (status === "RESCHEDULED") out.rescheduled++;
      const idn = staffOwned ? null : await resolveInviteeIdentity(provider.inviteeEmail, provider.inviteeName);
      if (idn?.state === "MATCHED") out.matched++; else if (idn) out.review++;
      return;
    }

    // Identity: re-resolved every pass for records a human has not settled,
    // but a MATCHED record is never silently re-pointed at a DIFFERENT client
    // or silently un-matched (the client's address edited on their row): both
    // keep the identity that was verified and become AMBIGUOUS_CLIENT for a
    // person to look at — the month it planned keeps its call on file.
    let identity: { matchState: string; clientId: string | null; enrollmentId: string | null; note: string | null; candidates: { clientId: string; name: string; reason: string }[] } | null = null;
    if (!staffOwned) {
      const idn = await resolveInviteeIdentity(provider.inviteeEmail, provider.inviteeName);
      const wasVerified = existing?.matchState === "MATCHED" && !!existing.clientId;
      if (idn.state === "MATCHED") {
        if (wasVerified && existing!.clientId !== idn.clientId) {
          identity = { matchState: "AMBIGUOUS_CLIENT", clientId: existing!.clientId, enrollmentId: existing!.enrollmentId, note: `identity changed: was ${existing!.clientId}, now resolves to ${idn.clientId}`, candidates: [] };
        } else {
          identity = { matchState: "MATCHED", clientId: idn.clientId, enrollmentId: idn.enrollmentId, note: `matched via ${idn.via}`, candidates: [] };
        }
      } else if (wasVerified) {
        identity = { matchState: "AMBIGUOUS_CLIENT", clientId: existing!.clientId, enrollmentId: existing!.enrollmentId, note: `was matched to ${existing!.clientId}; ${provider.inviteeEmail ?? "the invitee address"} no longer resolves to any enrolled client — kept, needs a look`, candidates: idn.candidates.map((c) => ({ clientId: c.clientId, name: c.name, reason: c.reason })) };
      } else {
        identity = { matchState: idn.state, clientId: null, enrollmentId: null, note: idn.candidates.length ? `${idn.candidates.length} candidate(s) by full name — not a match` : "no client has this address", candidates: idn.candidates.map((c) => ({ clientId: c.clientId, name: c.name, reason: c.reason })) };
        // Propose (never verify) an alias for a full-name candidate — only one
        // whose enrollment is ACTIVE (verify does nothing for an ENDED one) and
        // whose record does not already carry the address (then it is not an
        // alias, it is a client outside the program).
        if (idn.state === "UNMATCHED_INVITEE" && provider.inviteeEmail) {
          for (const c of idn.candidates.filter((x) => x.active && !x.onFile)) {
            const p = await proposeClientEmailAlias(c.clientId, c.enrollmentId, provider.inviteeEmail, "calendly");
            if (p.created) out.aliasProposals++;
          }
        }
      }
      raw.identity = { note: identity.note ?? "", candidates: identity.candidates };
    }

    const data = {
      ...provider,
      ...(identity ? { matchState: identity.matchState, clientId: identity.clientId, enrollmentId: identity.enrollmentId, matchNote: identity.note } : {}),
      rawJson: JSON.stringify(raw),
      lastError: null, lastErrorAt: null,
    };
    let recordId: string;
    if (existing) {
      await prisma.programCallRecord.update({ where: { id: existing.id }, data });
      recordId = existing.id;
      out.updated++;
    } else {
      const row = await prisma.programCallRecord.create({ data: { calendlyEventUri: event.uri, ...data }, select: { id: true } });
      recordId = row.id;
      out.created++;
    }
    if (status === "CANCELLED") out.cancelled++;
    if (status === "RESCHEDULED") out.rescheduled++;

    const state = identity?.matchState ?? existing?.matchState ?? "PENDING";
    if (state === "MATCHED" || state === "CONFIRMED_BY_STAFF") {
      out.matched++;
      const t = await applyTarget(recordId, rules);
      t.touchedMonthIds.forEach((m) => touchedMonths.add(m));
      if (status === "CANCELLED" || status === "RESCHEDULED") {
        // History stays; open work on the dead booking stops. Its transcript
        // (if any) stays with it — the replacement must be verified on its own.
        await cancelTranscriptJobs(recordId, `booking ${status.toLowerCase()}`);
      }
    } else if (REVIEW_STATES.includes(state)) {
      out.review++;
      if (status !== "CANCELLED" && status !== "RESCHEDULED") {
        const lines = identity?.candidates.length
          ? ["Candidates (by full name — confirm one, or ignore the call):", ...identity.candidates.map((c) => `  · ${c.name} — ${c.reason}`)]
          : ["No enrolled client carries this address. Confirm the client (and verify the address as their alias) or ignore the call."];
        await ensureReviewTask(
          { id: recordId, clientId: null, inviteeName: provider.inviteeName, inviteeEmail: provider.inviteeEmail, scheduledStart: start, callType: mapping.purpose },
          state === "AMBIGUOUS_CLIENT" ? `The client behind ${provider.inviteeEmail ?? "this booking"} is no longer certain — which one booked this ${mapping.eventName}?` : `${mapping.eventName} booked by ${provider.inviteeEmail ?? "an unknown address"} — no verified client match.`,
          lines,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Records → Google Calendar event (summary, start, Meet conference id).
// ---------------------------------------------------------------------------
export async function linkCalendarEvents(opts: { max?: number; now?: Date } = {}): Promise<{ linked: number; missing: number; errors: number; skipped?: string }> {
  const { ownerGoogleToken } = await import("@/lib/integrations/google");
  if (!(await ownerGoogleToken())) return { linked: 0, missing: 0, errors: 0, skipped: "Google not connected" };
  const { getCalendarEvent, CalendarNotConnected } = await import("@/lib/integrations/googleCalendar");
  const now = opts.now ?? new Date();
  const rows = await prisma.programCallRecord.findMany({
    where: { calendarExternalId: { not: null }, matchState: { not: "IGNORED" }, status: { in: ["SCHEDULED", "COMPLETED"] }, scheduledStart: { gte: new Date(now.getTime() - 90 * 864e5) } },
    select: { id: true, calendarExternalId: true, meetLink: true, rawJson: true },
    orderBy: { scheduledStart: "desc" },
    take: 200,
  });
  let linked = 0, missing = 0, errors = 0, budget = opts.max ?? 20;
  for (const r of rows) {
    const raw = readRaw(r.rawJson);
    // Linked once, or failed within the last day: leave it.
    if (raw.calendar?.linkedAt && !raw.calendar.error) continue;
    if (raw.calendar?.error && now.getTime() - new Date(raw.calendar.linkedAt).getTime() < 24 * 3600_000) continue;
    if (budget-- <= 0) break;
    try {
      const ev = await getCalendarEvent(r.calendarExternalId!);
      if (!ev) {
        raw.calendar = { summary: null, start: null, end: null, conferenceId: null, attendees: [], linkedAt: now.toISOString(), error: "calendar event not found on the primary calendar" };
        await prisma.programCallRecord.update({ where: { id: r.id }, data: { rawJson: JSON.stringify(raw) } });
        missing++;
        continue;
      }
      raw.calendar = { summary: ev.summary, start: ev.start?.toISOString() ?? null, end: ev.end?.toISOString() ?? null, conferenceId: ev.conferenceId, attendees: ev.attendees.map((a) => a.email), linkedAt: now.toISOString(), error: null };
      await prisma.programCallRecord.update({
        where: { id: r.id },
        data: { meetConferenceId: ev.conferenceId, ...(r.meetLink ? {} : { meetLink: ev.hangoutLink }), rawJson: JSON.stringify(raw) },
      });
      linked++;
    } catch (e) {
      if (e instanceof CalendarNotConnected) return { linked, missing, errors, skipped: "Google Calendar scope missing" };
      raw.calendar = { summary: null, start: null, end: null, conferenceId: null, attendees: [], linkedAt: now.toISOString(), error: e instanceof Error ? e.message : String(e) };
      await prisma.programCallRecord.update({ where: { id: r.id }, data: { rawJson: JSON.stringify(raw), lastError: `calendar: ${raw.calendar.error}`.slice(0, 500), lastErrorAt: now } }).catch(() => {});
      errors++;
    }
  }
  return { linked, missing, errors };
}

// ---------------------------------------------------------------------------
// 3. Records → Drive "Notes by Gemini" docs → transcript sources.
// ---------------------------------------------------------------------------
export type GeminiDoc = { id: string; name: string; prefix: string; heldAt: Date | null; createdAt: Date; link: string | null };

const ZONE_OFFSET: Record<string, string> = { EDT: "-04:00", EST: "-05:00", CDT: "-05:00", CST: "-06:00", MDT: "-06:00", MST: "-07:00", PDT: "-07:00", PST: "-08:00", UTC: "+00:00", GMT: "+00:00" };

/**
 * "<calendar summary> - 2026/09/11 13:30 CDT - Notes by Gemini" → the summary
 * and the REAL start instant. Gemini stamps the title in whatever zone the
 * notes were generated in (Jordan's files carry EDT and CDT), so the zone is
 * honoured, never assumed; an unknown zone yields no stamp rather than a
 * wrong one. Exported for the probes.
 */
export function parseGeminiTitle(name: string): { prefix: string; heldAt: Date | null } {
  const m = /^(.*?)\s*-?\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*([A-Z]{2,4})?\s*-\s*Notes by Gemini\s*$/i.exec(name);
  if (!m) return { prefix: name.replace(/\s*-\s*Notes by Gemini\s*$/i, "").trim(), heldAt: null };
  const [, prefix, y, mo, d, h, min, zone] = m;
  const off = zone ? ZONE_OFFSET[zone.toUpperCase()] : undefined;
  if (!off) return { prefix: prefix.trim(), heldAt: null };
  const at = new Date(`${y}-${mo}-${d}T${h.padStart(2, "0")}:${min}:00${off}`);
  return { prefix: prefix.trim(), heldAt: Number.isNaN(at.getTime()) ? null : at };
}

async function listGeminiDocs(token: string, createdMin: Date, createdMax: Date): Promise<GeminiDoc[]> {
  const q = [
    "mimeType = 'application/vnd.google-apps.document'",
    "trashed = false",
    "name contains 'Notes by Gemini'",
    `createdTime >= '${createdMin.toISOString()}'`,
    `createdTime <= '${createdMax.toISOString()}'`,
  ].join(" and ");
  const out: GeminiDoc[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "nextPageToken, files(id, name, createdTime, webViewLink)");
    url.searchParams.set("orderBy", "createdTime desc");
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!res.ok) throw new Error(`Drive search failed (${res.status})`);
    const data = (await res.json()) as { nextPageToken?: string; files?: { id?: string; name?: string; createdTime?: string; webViewLink?: string }[] };
    for (const f of data.files ?? []) {
      if (!f.id || !f.name || !f.createdTime) continue;
      const created = new Date(f.createdTime);
      const { prefix, heldAt } = parseGeminiTitle(f.name);
      // A stamped title gives the real START; an unstamped one only says when
      // the notes were written (createdTime, ~90 min late on Jordan's files).
      out.push({ id: f.id, name: f.name, prefix, heldAt, createdAt: created, link: f.webViewLink ?? null });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < 500);
  return out;
}

/**
 * One source row per Drive doc, deduplicated by the TEXT hash (two copies of
 * one meeting = one source). `exportText:false` records the doc WITHOUT
 * pulling its words — for docs no call record has verified yet, so the hub
 * never stores the content of a meeting that may not be program work; INGEST
 * exports the text once a person confirms the link.
 */
async function upsertDriveSource(doc: GeminiDoc, token: string, opts: { exportText?: boolean } = {}): Promise<{ id: string; text: string | null; reused: boolean; matchState: string; callRecordId: string | null }> {
  const byFile = await prisma.programTranscriptSource.findFirst({ where: { provider: "drive", externalId: doc.id }, select: { id: true, text: true, matchState: true, callRecordId: true } });
  if (byFile) return { ...byFile, reused: true };
  let text: string | null = null;
  if (opts.exportText !== false) {
    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (res.ok) text = (await res.text()).trim().slice(0, 500_000) || null;
    } catch { /* the hash below falls back to the file id; INGEST re-exports */ }
  }
  const contentHash = text ? sha(text) : sha(`drive:${doc.id}`);
  const dup = await prisma.programTranscriptSource.findUnique({ where: { contentHash }, select: { id: true, text: true, matchState: true, callRecordId: true } });
  if (dup) return { ...dup, reused: true }; // the same words already on file (another copy of the same meeting)
  const legacy = await prisma.contentMonth.findFirst({ where: { transcriptSource: `drive:${doc.id}` }, select: { id: true } });
  const row = await prisma.programTranscriptSource.create({
    data: {
      provider: "drive", externalId: doc.id, sourceUrl: doc.link ?? `https://docs.google.com/document/d/${doc.id}/edit`,
      title: doc.name, recordedAt: doc.heldAt ?? doc.createdAt, text, contentHash, legacyMonthId: legacy?.id ?? null, createdBy: "drive-sweep",
    },
    select: { id: true, text: true, matchState: true, callRecordId: true },
  });
  return { ...row, reused: false };
}

async function confirmSourceOnRecord(sourceId: string, record: { id: string; enrollmentId: string | null; callType: string; monthId: string | null; rawJson?: string | null }, by: string, note: string): Promise<void> {
  const now = new Date();
  const src = await prisma.programTranscriptSource.findUnique({ where: { id: sourceId }, select: { legacyMonthId: true } });
  await prisma.programTranscriptSource.update({ where: { id: sourceId }, data: { callRecordId: record.id, matchState: "CONFIRMED", confirmedBy: by, confirmedAt: now, candidateCallIdsJson: JSON.stringify([{ callRecordId: record.id, score: 1, note }]) } });
  // A doc the OLD sweep already filed and analysed on a month (Erica's Aug 7
  // notes = ContentMonth.transcriptSource, transcriptProcessedAt set) must not
  // be analysed a second time the moment the mapping is enabled: INGEST still
  // makes the source durable; ANALYZE is skipped and the reason is on the
  // record. A person can queue it from the panel (rerun) if they want it.
  const legacy = src?.legacyMonthId
    ? await prisma.contentMonth.findUnique({ where: { id: src.legacyMonthId }, select: { id: true, monthKey: true, transcriptProcessedAt: true } })
    : null;
  const alreadyAnalysed = !!legacy?.transcriptProcessedAt;
  const raw = readRaw(record.rawJson ?? (await prisma.programCallRecord.findUnique({ where: { id: record.id }, select: { rawJson: true } }))?.rawJson);
  if (alreadyAnalysed) raw.analysis = { skipped: `already analysed by the legacy sweep on ${legacy!.monthKey} (${legacy!.transcriptProcessedAt!.toISOString()}) — not queued twice`, at: now.toISOString() };
  else delete raw.analysis;
  await prisma.programCallRecord.update({ where: { id: record.id }, data: { transcriptState: "CONFIRMED", lastError: null, lastErrorAt: null, rawJson: JSON.stringify(raw) } });
  await enqueueTranscriptJob({ callRecordId: record.id, kind: "INGEST", transcriptSourceId: sourceId, enrollmentId: record.enrollmentId, requestedBy: by });
  if (!alreadyAnalysed) await enqueueTranscriptJob({ callRecordId: record.id, kind: "ANALYZE", enrollmentId: record.enrollmentId, requestedBy: by });
  if (record.callType === "BRAND_DISCOVERY") {
    const ob = await prisma.programOnboarding.findFirst({ where: { discoveryCallRecordId: record.id }, select: { id: true, status: true } });
    if (ob && ["NOT_STARTED", "DISCOVERY_BOOKED", "DISCOVERY_HELD"].includes(ob.status)) await prisma.programOnboarding.update({ where: { id: ob.id }, data: { status: "TRANSCRIPT_PENDING" } });
  }
  if (record.monthId) await recalcProgramMonth(record.monthId);
}

export type TranscriptPair = { doc: GeminiDoc; strong: boolean; why: string };
/**
 * THE matching rule, pure. A doc pairs with a record when its title stamp is
 * within the tolerance of the booked start (or, unstamped, was created within
 * 6h after it). It is STRONG when, additionally, the title prefix equals the
 * Google Calendar event's summary — both read through the booking's own
 * calendar id, never a client's name. A record auto-confirms only when it has
 * exactly ONE strong doc and that doc is strong for NO other record: two calls
 * with the same client on the same day each keep their own doc or neither is
 * confirmed. Everything else is a candidate list for a person.
 */
export function pairTranscriptCandidates(
  records: { id: string; scheduledStart: Date; calendarSummary: string | null }[],
  docs: GeminiDoc[],
  rules: Pick<CallRecordRules, "startToleranceMinutes">,
): Map<string, { list: TranscriptPair[]; auto: TranscriptPair | null }> {
  const tol = rules.startToleranceMinutes * 60_000;
  const lists = new Map<string, TranscriptPair[]>();
  const strongCount = new Map<string, number>();
  for (const r of records) {
    const summary = r.calendarSummary ? norm(r.calendarSummary) : null;
    const list: TranscriptPair[] = [];
    for (const d of docs) {
      const at = d.heldAt;
      const inWindow = at ? Math.abs(at.getTime() - r.scheduledStart.getTime()) <= tol : d.createdAt >= r.scheduledStart && d.createdAt.getTime() - r.scheduledStart.getTime() <= 6 * 3600_000;
      if (!inWindow) continue;
      const strong = !!at && !!summary && norm(d.prefix) === summary;
      list.push({ doc: d, strong, why: strong ? "calendar summary + start stamp both match" : at ? (summary ? "start stamp matches, title does not" : "start stamp matches (no calendar link to compare the title)") : "created shortly after the call (no stamp in the title)" });
      if (strong) strongCount.set(d.id, (strongCount.get(d.id) ?? 0) + 1);
    }
    lists.set(r.id, list);
  }
  const out = new Map<string, { list: TranscriptPair[]; auto: TranscriptPair | null }>();
  for (const r of records) {
    const list = lists.get(r.id) ?? [];
    const strong = list.filter((p) => p.strong);
    const exclusive = strong.filter((p) => strongCount.get(p.doc.id) === 1);
    out.set(r.id, { list, auto: strong.length === 1 && exclusive.length === 1 ? exclusive[0] : null });
  }
  return out;
}

export async function discoverTranscriptSources(opts: { now?: Date; max?: number } = {}): Promise<
  { skipped: string } | { checked: number; confirmed: number; candidates: number; awaiting: number; exceptions: number; docsSeen: number }
> {
  const { ownerGoogleToken } = await import("@/lib/integrations/google");
  const token = await ownerGoogleToken();
  if (!token) return { skipped: "Google not connected" };
  const rules = await callRecordRules();
  const now = opts.now ?? new Date();
  const records = await prisma.programCallRecord.findMany({
    where: {
      callType: { in: ["BRAND_DISCOVERY", "MONTHLY_STRATEGY"] },
      matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] },
      status: { in: ["SCHEDULED", "COMPLETED"] },
      transcriptState: { in: ["NONE", "AWAITING", "CANDIDATES"] },
      scheduledStart: { gte: new Date(now.getTime() - 60 * 864e5), lte: now },
    },
    select: { id: true, enrollmentId: true, clientId: true, callType: true, monthId: true, scheduledStart: true, scheduledEnd: true, inviteeName: true, inviteeEmail: true, transcriptState: true, rawJson: true, calendarExternalId: true },
    orderBy: { scheduledStart: "asc" },
    take: opts.max ?? 40,
  });
  const due = records.filter((r) => (r.scheduledEnd ?? r.scheduledStart)! < now);
  if (due.length === 0) return { checked: 0, confirmed: 0, candidates: 0, awaiting: 0, exceptions: 0, docsSeen: 0 };

  const earliest = due.reduce((m, r) => (r.scheduledStart! < m ? r.scheduledStart! : m), due[0].scheduledStart!);
  let docs: GeminiDoc[];
  try {
    docs = await listGeminiDocs(token, new Date(earliest.getTime() - 864e5), now);
  } catch (e) {
    return { skipped: e instanceof Error ? e.message : "Drive unreachable" };
  }
  const { markSynced } = await import("@/lib/integrations/connections");
  await markSynced("gmail").catch(() => {}); // Drive rides the gmail connection row

  const paired = pairTranscriptCandidates(
    due.map((r) => ({ id: r.id, scheduledStart: r.scheduledStart!, calendarSummary: readRaw(r.rawJson).calendar?.summary ?? null })),
    docs, rules,
  );

  let confirmed = 0, candidates = 0, awaiting = 0, exceptions = 0;
  for (const r of due) {
    const { list, auto } = paired.get(r.id) ?? { list: [], auto: null };
    const raw = readRaw(r.rawJson);
    raw.transcripts = { checkedAt: now.toISOString(), windowDocs: list.length, strongDocs: list.filter((p) => p.strong).length };
    if (auto) {
      const strong = [auto];
      const src = await upsertDriveSource(strong[0].doc, token);
      if (src.matchState === "CONFIRMED" && src.callRecordId && src.callRecordId !== r.id) {
        // That transcript already belongs to another record (e.g. the cancelled
        // original of a reschedule). Not transferable without a person.
        await prisma.programCallRecord.update({ where: { id: r.id }, data: { transcriptState: "NEEDS_REVIEW", rawJson: JSON.stringify(raw), lastError: `the matching transcript is already confirmed on call ${src.callRecordId}`, lastErrorAt: now } });
        await ensureReviewTask(r, "The transcript that matches this call is already attached to another call record.", [`Doc: ${strong[0].doc.name}`, `Attached to record ${src.callRecordId} — confirm which call it belongs to.`]);
        exceptions++;
        continue;
      }
      if (src.matchState === "REJECTED") { await prisma.programCallRecord.update({ where: { id: r.id }, data: { rawJson: JSON.stringify(raw) } }); awaiting++; continue; }
      await prisma.programCallRecord.update({ where: { id: r.id }, data: { rawJson: JSON.stringify(raw) } });
      await confirmSourceOnRecord(src.id, { ...r, rawJson: JSON.stringify(raw) }, "drive-sweep", strong[0].why);
      confirmed++;
      continue;
    }
    if (list.length > 0) {
      // Candidates, ranked, for a person — with title, time and link. A
      // candidate is only NEAR a program call in time (the one the probe
      // surfaced was another person's meeting at the same hour), so its words
      // are NOT exported: INGEST pulls them once a person confirms the link.
      const rows: { sourceId: string; score: number; note: string; title: string }[] = [];
      for (const p of list) {
        const src = await upsertDriveSource(p.doc, token, { exportText: false });
        if (src.matchState === "CONFIRMED" || src.matchState === "REJECTED") continue;
        const prev = await prisma.programTranscriptSource.findUnique({ where: { id: src.id }, select: { candidateCallIdsJson: true } });
        const ids = ((): { callRecordId: string; score: number; note: string }[] => { try { return JSON.parse(prev?.candidateCallIdsJson ?? "[]"); } catch { return []; } })();
        if (!ids.some((x) => x.callRecordId === r.id)) ids.push({ callRecordId: r.id, score: p.strong ? 0.9 : 0.5, note: p.why });
        await prisma.programTranscriptSource.update({ where: { id: src.id }, data: { matchState: "CANDIDATE", candidateCallIdsJson: JSON.stringify(ids) } });
        rows.push({ sourceId: src.id, score: p.strong ? 0.9 : 0.5, note: p.why, title: p.doc.name });
      }
      if (rows.length > 0) {
        await prisma.programCallRecord.update({ where: { id: r.id }, data: { transcriptState: "CANDIDATES", rawJson: JSON.stringify(raw) } });
        await ensureReviewTask(r, `${rows.length} Drive transcript(s) sit near this call but none is verified — pick the right one.`, rows.map((x) => `  · ${x.title} — ${x.note}`));
        candidates++;
        continue;
      }
    }
    // Nothing near it. Wait out the grace period, then it is an exception.
    const overdue = now.getTime() - (r.scheduledEnd ?? r.scheduledStart)!.getTime() > rules.transcriptGraceHours * 3600_000;
    if (overdue) {
      await prisma.programCallRecord.update({ where: { id: r.id }, data: { transcriptState: "NEEDS_REVIEW", rawJson: JSON.stringify(raw), lastError: `no transcript found within ${rules.transcriptGraceHours}h of the call`, lastErrorAt: now } });
      await ensureReviewTask(r, "No Gemini notes doc was found for this call — paste or upload the transcript, or mark the call as held without one.", [
        r.calendarExternalId ? `Calendar event ${r.calendarExternalId}${raw.calendar?.summary ? ` (“${raw.calendar.summary}”)` : ""}` : "No calendar linkage on the booking.",
      ]);
      exceptions++;
    } else {
      await prisma.programCallRecord.update({ where: { id: r.id }, data: { transcriptState: "AWAITING", rawJson: JSON.stringify(raw) } });
      awaiting++;
    }
  }
  return { checked: due.length, confirmed, candidates, awaiting, exceptions, docsSeen: docs.length };
}

/**
 * Historical / unlinked transcripts (spec §26): a Gemini doc in the window
 * that no source row references becomes an UNMATCHED source in the import
 * review queue — but ONLY a doc that is recognisably a program call: its
 * title prefix equals the Google Calendar summary of some call record, or the
 * old sweep already filed it on a month. Drive holds notes for prospect
 * discovery calls and unrelated meetings too (27 docs in 60 days against ~9
 * program calls); Jordan's rule is that those stay out, so they get no row
 * and their text is never exported. Rows for unverified docs carry no text
 * either — INGEST exports it once a person confirms the link. No ownership,
 * no task, no analysis. This is how the second-in-month calls the old sweep
 * dropped (Arielle 09-11, Ashley 08-11, Erica 08-06) become separate,
 * recoverable records once their bookings are on the mapped type.
 */
export async function sweepUnlinkedDriveTranscripts(opts: { sinceDays?: number; now?: Date; max?: number; dryRun?: boolean } = {}): Promise<{ skipped: string } | { seen: number; queued: number; legacyLinked: number; alreadyKnown: number; outsideProgram: number; wouldQueue?: { name: string; legacy: boolean }[] }> {
  const { ownerGoogleToken } = await import("@/lib/integrations/google");
  const token = await ownerGoogleToken();
  if (!token) return { skipped: "Google not connected" };
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.sinceDays ?? 45) * 864e5);
  let docs: GeminiDoc[];
  try { docs = await listGeminiDocs(token, since, now); }
  catch (e) { return { skipped: e instanceof Error ? e.message : "Drive unreachable" }; }
  const known = new Set((await prisma.programTranscriptSource.findMany({ where: { provider: "drive", externalId: { in: docs.map((d) => d.id) } }, select: { externalId: true } })).map((s) => s.externalId!));
  const legacy = new Set((await prisma.contentMonth.findMany({ where: { transcriptSource: { startsWith: "drive:" } }, select: { transcriptSource: true } })).map((m) => m.transcriptSource!.slice(6)));
  // The calendar summaries of every program call record in the window (any
  // status — a cancelled original's doc is still a program doc).
  const summaries = new Set<string>();
  for (const r of await prisma.programCallRecord.findMany({
    where: { callType: { in: ["BRAND_DISCOVERY", "MONTHLY_STRATEGY"] }, matchState: { not: "IGNORED" }, scheduledStart: { gte: new Date(since.getTime() - 7 * 864e5) } },
    select: { rawJson: true },
  })) {
    const s = readRaw(r.rawJson).calendar?.summary;
    if (s) summaries.add(norm(s));
  }
  let queued = 0, legacyLinked = 0, alreadyKnown = 0, outsideProgram = 0, budget = opts.max ?? 10;
  const wouldQueue: { name: string; legacy: boolean }[] = [];
  for (const d of docs) {
    if (known.has(d.id)) { alreadyKnown++; continue; }
    const isLegacy = legacy.has(d.id);
    if (!isLegacy && !summaries.has(norm(d.prefix))) { outsideProgram++; continue; }
    if (opts.dryRun) { wouldQueue.push({ name: d.name, legacy: isLegacy }); if (isLegacy) legacyLinked++; else queued++; continue; }
    if (budget-- <= 0) break;
    // A doc the old sweep filed on a month gets a source row carrying the
    // legacyMonthId pointer (provenance) — still UNMATCHED, because no call
    // record ever verified it; a person may attach it to one. Its text is
    // already on that month, so exporting it adds nothing new to the hub.
    const src = await upsertDriveSource(d, token, { exportText: isLegacy });
    if (!src.reused) { if (isLegacy) legacyLinked++; else queued++; }
  }
  return { seen: docs.length, queued, legacyLinked, alreadyKnown, outsideProgram, ...(opts.dryRun ? { wouldQueue } : {}) };
}

// ---------------------------------------------------------------------------
// Staff decisions — the only way an unverified link becomes verified.
// ---------------------------------------------------------------------------
/**
 * The enrollment a staff decision files a call on: the ACTIVE one, else the
 * most recent — a client with an ENDED program and a later ACTIVE one must
 * not have today's call filed on the ended membership.
 */
async function programEnrollmentFor(clientId: string): Promise<{ id: string } | null> {
  const rows = await prisma.contentEnrollment.findMany({ where: { clientId }, select: { id: true, status: true }, orderBy: { createdAt: "desc" } });
  return rows.find((e) => e.status === "ACTIVE") ?? rows[0] ?? null;
}

export async function confirmCallRecordClient(recordId: string, clientId: string, by: string | null, opts: { verifyInviteeEmailAsAlias?: boolean } = {}): Promise<void> {
  const [record, enrollment] = await Promise.all([
    prisma.programCallRecord.findUnique({ where: { id: recordId }, select: { id: true, inviteeEmail: true } }),
    programEnrollmentFor(clientId),
  ]);
  if (!record) throw new Error("Call record not found.");
  if (!enrollment) throw new Error("That client is not enrolled in the content program.");
  const now = new Date();
  await prisma.programCallRecord.update({ where: { id: recordId }, data: { clientId, enrollmentId: enrollment.id, matchState: "CONFIRMED_BY_STAFF", confirmedBy: by, confirmedAt: now, matchNote: `confirmed by ${by ?? "staff"}` } });
  if (opts.verifyInviteeEmailAsAlias && record.inviteeEmail) {
    const p = await proposeClientEmailAlias(clientId, enrollment.id, record.inviteeEmail, "calendly");
    await verifyClientEmailAlias(p.id, by);
  }
  const t = await applyTarget(recordId, await callRecordRules());
  for (const m of t.touchedMonthIds) await recalcProgramMonth(m);
  await reconcileCallReviewTasks();
}

export async function setCallRecordTargetMonth(recordId: string, monthKey: string, by: string | null): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error("Month must look like 2026-10.");
  const r = await prisma.programCallRecord.findUnique({ where: { id: recordId }, select: { id: true, clientId: true, enrollmentId: true, callType: true, monthId: true, rawJson: true, status: true } });
  if (!r?.clientId || !r.enrollmentId) throw new Error("Confirm the client first.");
  if (r.callType !== "MONTHLY_STRATEGY") throw new Error("Only a monthly strategy call plans a month.");
  const month = await ensureMonth(r.enrollmentId, r.clientId, monthKey);
  const raw = readRaw(r.rawJson);
  await prisma.programCallRecord.update({ where: { id: r.id }, data: { monthId: month.id, targetMonthKey: monthKey, rawJson: JSON.stringify({ ...raw, target: { rule: "staff", reason: `retargeted to ${monthKey} by ${by ?? "staff"}`, monthKey } }) } });
  if (r.monthId && r.monthId !== month.id) {
    await prisma.contentMonth.updateMany({ where: { id: r.monthId, callRecordId: r.id }, data: { callRecordId: null } });
    await recalcProgramMonth(r.monthId);
  }
  if (r.status !== "CANCELLED" && r.status !== "RESCHEDULED") await prisma.contentMonth.updateMany({ where: { id: month.id, callRecordId: null }, data: { callRecordId: r.id } });
  await recalcProgramMonth(month.id);
}

export async function ignoreCallRecord(recordId: string, by: string | null, note?: string): Promise<void> {
  const r = await prisma.programCallRecord.findUnique({ where: { id: recordId }, select: { monthId: true } });
  await prisma.programCallRecord.update({ where: { id: recordId }, data: { matchState: "IGNORED", callType: "UNRELATED", monthId: null, onboardingId: null, confirmedBy: by, confirmedAt: new Date(), matchNote: note?.trim() || `ignored by ${by ?? "staff"}` } });
  await cancelTranscriptJobs(recordId, "call ignored by staff");
  if (r?.monthId) {
    await prisma.contentMonth.updateMany({ where: { id: r.monthId, callRecordId: recordId }, data: { callRecordId: null } });
    await recalcProgramMonth(r.monthId);
  }
  await reconcileCallReviewTasks();
}

/** A call that was not booked through a mapped type (a historical one, a phone call): staff create it, verified by definition. */
export async function createManualCallRecord(input: { clientId: string; callType: "BRAND_DISCOVERY" | "MONTHLY_STRATEGY"; scheduledStart: Date; scheduledEnd?: Date | null; targetMonthKey?: string | null; by: string | null; note?: string }): Promise<string> {
  const enrollment = await programEnrollmentFor(input.clientId);
  if (!enrollment) throw new Error("That client is not enrolled in the content program.");
  const now = new Date();
  const row = await prisma.programCallRecord.create({
    data: {
      clientId: input.clientId, enrollmentId: enrollment.id, callType: input.callType,
      scheduledStart: input.scheduledStart, scheduledEnd: input.scheduledEnd ?? null,
      status: input.scheduledStart < now ? "COMPLETED" : "SCHEDULED",
      matchState: "CONFIRMED_BY_STAFF", confirmedBy: input.by, confirmedAt: now, matchNote: input.note?.trim() || `created by ${input.by ?? "staff"} (no Calendly booking)`,
      rawJson: JSON.stringify({ manual: true }),
    },
    select: { id: true },
  });
  if (input.callType === "MONTHLY_STRATEGY" && input.targetMonthKey) await setCallRecordTargetMonth(row.id, input.targetMonthKey, input.by);
  else { const t = await applyTarget(row.id, await callRecordRules()); for (const m of t.touchedMonthIds) await recalcProgramMonth(m); }
  return row.id;
}

export async function confirmTranscriptSource(sourceId: string, recordId: string, by: string | null): Promise<void> {
  const [src, record] = await Promise.all([
    prisma.programTranscriptSource.findUnique({ where: { id: sourceId }, select: { id: true, matchState: true, callRecordId: true } }),
    prisma.programCallRecord.findUnique({ where: { id: recordId }, select: { id: true, enrollmentId: true, callType: true, monthId: true, matchState: true } }),
  ]);
  if (!src || !record) throw new Error("Source or call record not found.");
  if (src.matchState === "CONFIRMED" && src.callRecordId && src.callRecordId !== recordId) throw new Error("That transcript is already confirmed on another call — reject it there first.");
  if (record.matchState !== "MATCHED" && record.matchState !== "CONFIRMED_BY_STAFF") throw new Error("Confirm the call's client before attaching a transcript.");
  await confirmSourceOnRecord(sourceId, record, by ?? "staff", `confirmed by ${by ?? "staff"}`);
  await reconcileCallReviewTasks();
}

export async function rejectTranscriptSource(sourceId: string, by: string | null): Promise<void> {
  const src = await prisma.programTranscriptSource.findUnique({ where: { id: sourceId }, select: { callRecordId: true, matchState: true } });
  await prisma.programTranscriptSource.update({ where: { id: sourceId }, data: { matchState: "REJECTED", confirmedBy: by, confirmedAt: new Date() } });
  if (src?.callRecordId && src.matchState === "CONFIRMED") {
    const others = await prisma.programTranscriptSource.count({ where: { callRecordId: src.callRecordId, matchState: "CONFIRMED" } });
    if (others === 0) {
      await cancelTranscriptJobs(src.callRecordId, "transcript rejected by staff");
      await prisma.programCallRecord.update({ where: { id: src.callRecordId }, data: { transcriptState: "NEEDS_REVIEW", lastError: "transcript rejected — attach another or mark the call held without one", lastErrorAt: new Date() } });
    }
  }
}

/** Paste / upload: a transcript typed in by staff for a confirmed call. */
export async function attachPastedTranscript(recordId: string, text: string, by: string | null, provider: "paste" | "upload" = "paste"): Promise<string> {
  const body = text.trim();
  if (body.length < 200) throw new Error("That is too short to be a call transcript.");
  const record = await prisma.programCallRecord.findUnique({ where: { id: recordId }, select: { id: true, enrollmentId: true, callType: true, monthId: true, matchState: true, rawJson: true } });
  if (!record) throw new Error("Call record not found.");
  // Same two guards as confirmTranscriptSource: the call must have a verified
  // client (a paste on an UNMATCHED record would queue analysis with no
  // owner), and the same words already confirmed on ANOTHER call are not
  // moved here by a paste — that call would be left CONFIRMED with no source.
  if (record.matchState !== "MATCHED" && record.matchState !== "CONFIRMED_BY_STAFF") throw new Error("Confirm the call's client before attaching a transcript.");
  const contentHash = sha(body);
  const dup = await prisma.programTranscriptSource.findUnique({ where: { contentHash }, select: { id: true, matchState: true, callRecordId: true } });
  if (dup?.matchState === "CONFIRMED" && dup.callRecordId && dup.callRecordId !== recordId) throw new Error("That exact transcript is already confirmed on another call — reject it there first.");
  const src = dup ?? await prisma.programTranscriptSource.create({
    data: { provider, text: body.slice(0, 500_000), contentHash, title: `${provider} by ${by ?? "staff"}`, recordedAt: new Date(), createdBy: by },
    select: { id: true, matchState: true, callRecordId: true },
  });
  await confirmSourceOnRecord(src.id, record, by ?? "staff", `${provider} by ${by ?? "staff"}`);
  await reconcileCallReviewTasks();
  return src.id;
}

// ---------------------------------------------------------------------------
// Reads for the panel, the monitoring view and the completion tests.
// ---------------------------------------------------------------------------
export type CallRecordView = {
  id: string;
  callType: string;
  status: string;
  matchState: string;
  matchNote: string | null;
  transcriptState: string;
  lastError: string | null;
  lastErrorAt: Date | null;
  scheduledStart: Date | null;
  client: { id: string; name: string } | null;
  inviteeEmail: string | null;
  inviteeName: string | null;
  /** The public booking link of the mapped type (people book here) + the machine event uri. */
  bookingLink: string | null;
  eventTypeName: string | null;
  sourceEventUri: string | null;
  calendarExternalId: string | null;
  calendarSummary: string | null;
  meetLink: string | null;
  meetConferenceId: string | null;
  targetMonthKey: string | null;
  monthId: string | null;
  onboardingId: string | null;
  target: { rule: string; reason: string } | null;
  transcripts: { id: string; title: string | null; sourceUrl: string | null; matchState: string; recordedAt: Date | null; provider: string }[];
  jobs: { id: string; kind: string; state: string; attempts: number; lastError: string | null; reviewReason: string | null }[];
  candidates: { clientId: string; name: string; reason: string }[];
};

export async function listCallRecords(opts: { limit?: number; onlyReview?: boolean; enrollmentId?: string } = {}): Promise<CallRecordView[]> {
  const rows = await prisma.programCallRecord.findMany({
    where: {
      ...(opts.enrollmentId ? { enrollmentId: opts.enrollmentId } : {}),
      ...(opts.onlyReview ? { OR: [{ matchState: { in: REVIEW_STATES } }, { transcriptState: { in: ["CANDIDATES", "NEEDS_REVIEW"] } }] } : {}),
    },
    orderBy: { scheduledStart: "desc" },
    take: opts.limit ?? 50,
  });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [clients, mappings, sources, jobs] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: rows.map((r) => r.clientId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.programCalendlyEventMapping.findMany({ where: { id: { in: rows.map((r) => r.mappingId).filter((x): x is string => !!x) } }, select: { id: true, eventName: true, publicUrl: true } }),
    prisma.programTranscriptSource.findMany({ where: { OR: [{ callRecordId: { in: ids } }, { matchState: "CANDIDATE" }] }, select: { id: true, title: true, sourceUrl: true, matchState: true, recordedAt: true, provider: true, callRecordId: true, candidateCallIdsJson: true } }),
    prisma.programTranscriptJob.findMany({ where: { callRecordId: { in: ids } }, select: { id: true, kind: true, state: true, attempts: true, lastError: true, reviewReason: true, callRecordId: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const clientOf = new Map(clients.map((c) => [c.id, c]));
  const mappingOf = new Map(mappings.map((m) => [m.id, m]));
  return rows.map((r) => {
    const raw = readRaw(r.rawJson);
    const m = r.mappingId ? mappingOf.get(r.mappingId) : null;
    const mine = sources.filter((s) => s.callRecordId === r.id || (s.matchState === "CANDIDATE" && (s.candidateCallIdsJson ?? "").includes(r.id)));
    return {
      id: r.id, callType: r.callType, status: r.status, matchState: r.matchState, matchNote: r.matchNote, transcriptState: r.transcriptState,
      lastError: r.lastError, lastErrorAt: r.lastErrorAt, scheduledStart: r.scheduledStart,
      client: r.clientId ? (clientOf.get(r.clientId) ?? null) : null,
      inviteeEmail: r.inviteeEmail, inviteeName: r.inviteeName,
      bookingLink: m?.publicUrl ?? null, eventTypeName: m?.eventName ?? null, sourceEventUri: r.calendlyEventUri,
      calendarExternalId: r.calendarExternalId, calendarSummary: raw.calendar?.summary ?? null,
      meetLink: r.meetLink, meetConferenceId: r.meetConferenceId,
      targetMonthKey: r.targetMonthKey, monthId: r.monthId, onboardingId: r.onboardingId,
      target: raw.target ? { rule: raw.target.rule, reason: raw.target.reason } : null,
      transcripts: mine.map((s) => ({ id: s.id, title: s.title, sourceUrl: s.sourceUrl, matchState: s.matchState, recordedAt: s.recordedAt, provider: s.provider })),
      jobs: jobs.filter((j) => j.callRecordId === r.id).map((j) => ({ id: j.id, kind: j.kind, state: j.state, attempts: j.attempts, lastError: j.lastError, reviewReason: j.reviewReason })),
      candidates: raw.identity?.candidates ?? [],
    };
  });
}

/** Unverified alias proposals + unlinked transcripts, for the review strip. */
export async function callReviewQueue(): Promise<{
  aliases: { id: string; clientId: string; clientName: string; email: string; source: string; createdAt: Date }[];
  unlinkedTranscripts: { id: string; title: string | null; sourceUrl: string | null; recordedAt: Date | null; legacyMonthId: string | null; candidates: { callRecordId: string; score: number; note: string }[] }[];
}> {
  const [aliases, sources] = await Promise.all([
    prisma.clientEmailAlias.findMany({ where: { verifiedAt: null, active: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.programTranscriptSource.findMany({ where: { matchState: { in: ["UNMATCHED", "CANDIDATE"] } }, orderBy: { recordedAt: "desc" }, take: 50, select: { id: true, title: true, sourceUrl: true, recordedAt: true, legacyMonthId: true, candidateCallIdsJson: true } }),
  ]);
  const clients = await prisma.client.findMany({ where: { id: { in: aliases.map((a) => a.clientId) } }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  return {
    aliases: aliases.map((a) => ({ id: a.id, clientId: a.clientId, clientName: nameOf.get(a.clientId) ?? "?", email: a.email, source: a.source, createdAt: a.createdAt })),
    unlinkedTranscripts: sources.map((s) => ({ id: s.id, title: s.title, sourceUrl: s.sourceUrl, recordedAt: s.recordedAt, legacyMonthId: s.legacyMonthId, candidates: ((): { callRecordId: string; score: number; note: string }[] => { try { return JSON.parse(s.candidateCallIdsJson ?? "[]"); } catch { return []; } })() })),
  };
}
