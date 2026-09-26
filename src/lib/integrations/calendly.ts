import "server-only";
import { getSecret } from "@/lib/integrations/connections";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Calendly (v2 API, personal access token). Mostly reads: clients book through
// the mapped public link (now embedded in the portal) and we read what
// happened. The two WRITES — book one invitee (POST /invitees, the Scheduling
// API) and cancel one event — exist for W03's in-portal booking (Sep 25 2026)
// and sit behind THE guard at the bottom of this file (calendlyWritePermit):
// the `call_booking` switch, its fixture/pilot scope, and a permit that only
// that guard can mint. Nothing else in the tree writes to Calendly.
//
// TWO ways of naming a call live side by side here, on purpose (Sep 16 2026):
//
//  1. The LEGACY sweep (contentCalls.syncStrategyCallsFromCalendly) resolves
//     the monthly type by its public SLUG below. It keeps working exactly as
//     it does today until an enabled ProgramCalendlyEventMapping exists, so
//     nothing regresses while the mapping is being configured.
//  2. PROGRAM PROCESSING (contentCallRecords) classifies a booking ONLY by its
//     event-type URI through ProgramCalendlyEventMapping. There is no name
//     fallback anywhere any more: the old `/strategy call/i` regex could make
//     "30 Minute Strategy Call" — the generic type every unrelated business
//     call is booked on — look like program work. A missing mapping is a
//     configuration exception surfaced on Settings, never permission to ingest.
// ---------------------------------------------------------------------------

export const STRATEGY_CALL_BOOKING_URL = "https://calendly.com/realtourpilot-info/content-program-strategy-call";
const STRATEGY_CALL_SLUG = "content-program-strategy-call";
const BASE = "https://api.calendly.com";

export class CalendlyError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CalendlyError";
    this.status = status;
  }
}

/** The dedicated event type cannot be found on the account — nothing may be ingested by name instead. */
export class CalendlyConfigError extends CalendlyError {
  constructor(message: string) {
    super(message, 0);
    this.name = "CalendlyConfigError";
  }
}

async function calendlyRequest<T = unknown>(
  path: string,
  opts: { query?: Record<string, string>; key?: string; method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const key = opts.key ?? (await getSecret("calendly"));
  if (!key) throw new CalendlyError("Calendly is not connected.", 401);
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  // One attempt, always — for a POST that is the point: a timeout after
  // Calendly committed is the one failure a retry turns into a second booking.
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (json as { message?: string; title?: string }).message || (json as { title?: string }).title || `Calendly API ${res.status}`;
    throw new CalendlyError(msg, res.status);
  }
  return json as T;
}

type CalendlyUser = { resource?: { uri?: string; name?: string; email?: string; current_organization?: string } };
export type CalendlyEventType = {
  uri: string;
  name: string;
  slug: string | null;
  active: boolean;
  /** The public booking link people use. The URI above is the machine key. */
  schedulingUrl: string | null;
  kind: string | null; // solo | group
  /** Owner (user) uri of the type, for the host/organization scope on the mapping. */
  ownerUri: string | null;
};
type RawEventType = { uri: string; slug?: string; name?: string; active?: boolean; scheduling_url?: string; kind?: string; profile?: { owner?: string } };
export type ScheduledEvent = {
  uri: string;
  name?: string;
  status?: string; // active | canceled
  start_time?: string;
  end_time?: string;
  event_type?: string;
  location?: { type?: string; join_url?: string; location?: string };
  calendar_event?: { external_id?: string | null; kind?: string | null } | null;
  event_memberships?: { user?: string }[];
};
/** The UTM fields Calendly keeps from the booking page's address (or a POST /invitees body). */
export type InviteeTracking = {
  utm_campaign?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  salesforce_uuid?: string | null;
};
export type Invitee = {
  email?: string;
  name?: string;
  status?: string; // active | canceled
  uri?: string;
  /** The scheduled event this invitee belongs to (the POST /invitees response carries it). */
  event?: string;
  timezone?: string;
  /** W03: the portal's booking token rides here as utm_content. */
  tracking?: InviteeTracking | null;
  rescheduled?: boolean;
  old_invitee?: string | null;
  new_invitee?: string | null;
  cancel_url?: string;
  reschedule_url?: string;
  cancellation?: { canceled_by?: string; reason?: string | null; canceler_type?: string } | null;
  /** When the booking was made — a portal token's stale-page rule reads it (callBooking.verifyPortalCallToken). */
  created_at?: string;
};

export async function testCalendlyKey(key: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const me = await calendlyRequest<CalendlyUser>("/users/me", { key });
    const who = me.resource?.name || me.resource?.email || "Calendly account";
    return { ok: true, label: `Calendly · ${who}` };
  } catch (e) {
    return { ok: false, error: e instanceof CalendlyError ? e.message : "Could not reach Calendly." };
  }
}

// The current user's uri + organization — scheduled-event listing requires one.
async function currentUser(): Promise<{ uri: string; organization: string | null }> {
  const me = await calendlyRequest<CalendlyUser>("/users/me");
  const uri = me.resource?.uri;
  if (!uri) throw new CalendlyError("Calendly /users/me returned no uri.");
  return { uri, organization: me.resource?.current_organization ?? null };
}

/** Every event type on the connected account (active AND inactive, so a
 *  mapping to a retired type can be reported as MISSING rather than vanish). */
export async function listEventTypes(): Promise<CalendlyEventType[]> {
  const user = await currentUser();
  const out: CalendlyEventType[] = [];
  let page: string | undefined = `${BASE}/event_types?user=${encodeURIComponent(user.uri)}&count=100`;
  while (page) {
    const r: { collection?: RawEventType[]; pagination?: { next_page?: string | null } } = await calendlyRequest(page);
    for (const et of r.collection ?? []) {
      if (!et.uri) continue;
      out.push({
        uri: et.uri,
        name: et.name ?? "(unnamed)",
        slug: et.slug ?? null,
        active: et.active !== false,
        schedulingUrl: et.scheduling_url ?? null,
        kind: et.kind ?? null,
        ownerUri: et.profile?.owner ?? null,
      });
    }
    page = r.pagination?.next_page ?? undefined;
  }
  return out;
}

// Resolve the LEGACY strategy-call event type by its public slug (cached per
// lambda). Used only by the legacy month-stamping sweep.
let cachedEventType: string | null = null;
export async function strategyCallEventType(): Promise<string | null> {
  if (cachedEventType) return cachedEventType;
  const types = await listEventTypes();
  const hit = types.find((t) => t.slug === STRATEGY_CALL_SLUG);
  if (hit) cachedEventType = hit.uri;
  return hit?.uri ?? null;
}

async function inviteesOf(eventUri: string): Promise<Invitee[]> {
  const uuid = eventUri.split("/").pop();
  if (!uuid) return [];
  try {
    const ir = await calendlyRequest<{ collection?: Invitee[] }>(`/scheduled_events/${uuid}/invitees`, { query: { count: "100" } });
    return ir.collection ?? [];
  } catch {
    return []; // invitees are an enrichment, not a requirement
  }
}

/**
 * Every booking on the account in a window — active and canceled — with its
 * invitees. No filtering by type or name here: the CALLER classifies through
 * the mapping table. `eventTypeUris` narrows the invitee fetch (one request
 * per event) to the types that matter; events outside it are returned bare.
 */
export async function listScheduledEvents(
  minStartIso: string,
  maxStartIso: string,
  opts: { eventTypeUris?: Set<string> } = {},
): Promise<{ event: ScheduledEvent; invitees: Invitee[] }[]> {
  const user = await currentUser();
  const out: { event: ScheduledEvent; invitees: Invitee[] }[] = [];
  let page: string | undefined =
    `/scheduled_events?user=${encodeURIComponent(user.uri)}&min_start_time=${encodeURIComponent(minStartIso)}&max_start_time=${encodeURIComponent(maxStartIso)}&count=100`;
  while (page) {
    const r: { collection?: ScheduledEvent[]; pagination?: { next_page?: string | null } } = await calendlyRequest(page);
    for (const ev of r.collection ?? []) {
      const wanted = !opts.eventTypeUris || (ev.event_type ? opts.eventTypeUris.has(ev.event_type) : false);
      out.push({ event: ev, invitees: wanted ? await inviteesOf(ev.uri) : [] });
    }
    const next = r.pagination?.next_page;
    page = next ? next.replace(BASE, "") : undefined;
  }
  return out;
}

/** One booking by its uri (used when a record needs re-reading, e.g. after a reschedule). */
export async function getScheduledEvent(eventUri: string): Promise<{ event: ScheduledEvent; invitees: Invitee[] } | null> {
  const uuid = eventUri.split("/").pop();
  if (!uuid) return null;
  try {
    const r = await calendlyRequest<{ resource?: ScheduledEvent }>(`/scheduled_events/${uuid}`);
    if (!r.resource) return null;
    return { event: r.resource, invitees: await inviteesOf(r.resource.uri) };
  } catch (e) {
    if (e instanceof CalendlyError && e.status === 404) return null;
    throw e;
  }
}

/**
 * LEGACY: strategy-call bookings in a window, resolved by the dedicated slug
 * ONLY. When the slug cannot be resolved this THROWS a CalendlyConfigError —
 * it used to fall back to `/strategy call/i` on the event name, which would
 * have swept every "30 Minute Strategy Call" into the program. The caller
 * reports the exception; nobody ingests by name.
 */
export async function listStrategyCalls(minStartIso: string, maxStartIso: string): Promise<
  { event: ScheduledEvent; invitees: Invitee[] }[]
> {
  const eventType = await strategyCallEventType();
  if (!eventType) {
    throw new CalendlyConfigError(
      `The "${STRATEGY_CALL_SLUG}" event type is not on the connected Calendly account — map the monthly strategy type on Settings.`,
    );
  }
  const all = await listScheduledEvents(minStartIso, maxStartIso, { eventTypeUris: new Set([eventType]) });
  return all.filter(({ event }) => event.event_type === eventType);
}

// ---------------------------------------------------------------------------
// Program classification — the mapping table is the ONLY classifier.
// ---------------------------------------------------------------------------
export type CallPurpose = "BRAND_DISCOVERY" | "MONTHLY_STRATEGY" | "IGNORED";
export const CALL_PURPOSES: CallPurpose[] = ["BRAND_DISCOVERY", "MONTHLY_STRATEGY", "IGNORED"];
export const isCallPurpose = (v: unknown): v is CallPurpose => typeof v === "string" && (CALL_PURPOSES as string[]).includes(v);

export type CallMapping = {
  id: string;
  eventTypeUri: string;
  eventName: string;
  publicUrl: string | null;
  purpose: CallPurpose;
  enabled: boolean;
  validationStatus: string;
};

/** Enabled, program-relevant mappings keyed by event-type uri. IGNORED rows
 *  are returned too (they say "this type stays out" explicitly). */
export async function enabledCallMappings(): Promise<Map<string, CallMapping>> {
  const rows = await prisma.programCalendlyEventMapping.findMany({ where: { enabled: true } });
  const map = new Map<string, CallMapping>();
  for (const r of rows) {
    if (!isCallPurpose(r.purpose)) continue;
    map.set(r.eventTypeUri, {
      id: r.id, eventTypeUri: r.eventTypeUri, eventName: r.eventName, publicUrl: r.publicUrl,
      purpose: r.purpose, enabled: r.enabled, validationStatus: r.validationStatus,
    });
  }
  return map;
}

/** Is at least one program purpose mapped and enabled? This is the moment the
 *  legacy sweeps hand over to call records. */
export async function hasEnabledCallMapping(): Promise<boolean> {
  const n = await prisma.programCalendlyEventMapping.count({
    where: { enabled: true, purpose: { in: ["BRAND_DISCOVERY", "MONTHLY_STRATEGY"] } },
  });
  return n > 0;
}

/**
 * The purpose of a booking, by event-type URI, through the mapping table and
 * nothing else. null = no enabled mapping → the booking is outside the program.
 */
export async function purposeForEventType(eventTypeUri: string | null | undefined): Promise<CallPurpose | null> {
  if (!eventTypeUri) return null;
  const row = await prisma.programCalendlyEventMapping.findUnique({ where: { eventTypeUri }, select: { purpose: true, enabled: true } });
  if (!row?.enabled || !isCallPurpose(row.purpose)) return null;
  return row.purpose;
}

// ---------------------------------------------------------------------------
// Notetaker meeting recaps. Jordan keeps Notetaker ON for every strategy call;
// its transcript is the PRIMARY source (Drive/Meet is the backup, paste last).
// NOTE: the account currently returns 403 "Required features are not enabled"
// — everything here degrades to {skipped} until Notetaker is enabled in
// Calendly, then starts working with no code change.
// ---------------------------------------------------------------------------
export type MeetingRecap = Record<string, unknown> & { uri?: string };

export async function listMeetingRecaps(): Promise<MeetingRecap[] | { skipped: string }> {
  try {
    const r = await calendlyRequest<{ collection?: MeetingRecap[] }>("/meeting_recaps", { query: { count: "50" } });
    return r.collection ?? [];
  } catch (e) {
    if (e instanceof CalendlyError && (e.status === 403 || e.status === 404)) {
      return { skipped: "Notetaker not enabled on this Calendly account" };
    }
    throw e;
  }
}

// The scheduled-event uuid a recap belongs to — the docs are gated, so find it
// defensively: any string field (top-level or one deep) containing the
// scheduled_events path is the linkage.
export function recapEventUuid(recap: MeetingRecap): string | null {
  const hunt = (v: unknown): string | null => {
    if (typeof v === "string") {
      const m = v.match(/scheduled_events\/([a-f0-9-]{8,})/i);
      return m ? m[1] : null;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) { const hit = hunt(x); if (hit) return hit; }
    }
    return null;
  };
  return hunt(recap);
}

// The transcript for one recap, flattened to plain text whatever the shape:
// a raw-text body, {transcript: "..."}, or a segments/speakers array.
export async function recapTranscriptText(recapUri: string): Promise<string | null> {
  const uuid = recapUri.split("/").pop();
  if (!uuid) return null;
  const key = await getSecret("calendly");
  if (!key) return null;
  const res = await fetch(`${BASE}/meeting_recaps/${uuid}/transcript`, {
    headers: { Authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const raw = await res.text();
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return raw.trim() || null; }

  const flatten = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      const lines = v
        .map((seg) => {
          if (typeof seg === "string") return seg;
          if (seg && typeof seg === "object") {
            const o = seg as Record<string, unknown>;
            const speaker = typeof o.speaker === "string" ? o.speaker : typeof o.speaker_name === "string" ? o.speaker_name : null;
            const text = typeof o.text === "string" ? o.text : typeof o.content === "string" ? o.content : null;
            if (text) return speaker ? `${speaker}: ${text}` : text;
          }
          return null;
        })
        .filter(Boolean);
      return lines.length ? lines.join("\n") : null;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["transcript", "text", "content", "segments", "utterances", "resource", "collection"]) {
        if (k in o) { const hit = flatten(o[k]); if (hit) return hit; }
      }
    }
    return null;
  };
  const text = flatten(json);
  return text?.trim() || null;
}

// ---------------------------------------------------------------------------
// W03 (unified handoff, Sep 25 2026) — THE SCHEDULING API: an event type's
// detail, its open times, and the two writes. The documented contract
// (developer.calendly.com, "Scheduling API" / "Schedule events with AI agents"):
//
//   GET  /event_type_available_times?event_type&start_time&end_time
//        start in the future, a window of at most 7 days per call. 403 when
//        the account's plan lacks the Scheduling API — the read-only probe
//        (lib/callBooking.runSchedulingProbe) is how the hub learns which.
//   POST /invitees {event_type, start_time (UTC), invitee{name,email,timezone},
//        location{kind,…}, tracking{utm_*}} → 201 {resource: invitee}. Who is
//        emailed is the EVENT TYPE's own notification setting, not this call.
//   POST /scheduled_events/{uuid}/cancellation {reason} → 201.
//   There is no reschedule endpoint: a move is the invitee's reschedule_url.
//
// Nothing here is ever retried (see calendlyRequest).
// ---------------------------------------------------------------------------

export type EventTypeDetail = {
  uri: string;
  name: string;
  durationMinutes: number | null;
  schedulingUrl: string | null;
  active: boolean;
  /** The meeting locations the type offers; POST /invitees must name one of them. */
  locations: { kind: string; location?: string | null }[];
};

export async function getEventType(eventTypeUri: string): Promise<EventTypeDetail | null> {
  const uuid = eventTypeUri.split("/").pop();
  if (!uuid) return null;
  try {
    const r = await calendlyRequest<{ resource?: { uri?: string; name?: string; duration?: number; scheduling_url?: string; active?: boolean; locations?: { kind?: string; location?: string | null }[] | null } }>(`/event_types/${uuid}`);
    const t = r.resource;
    if (!t?.uri) return null;
    return {
      uri: t.uri, name: t.name ?? "(unnamed)",
      durationMinutes: typeof t.duration === "number" && t.duration > 0 ? t.duration : null,
      schedulingUrl: t.scheduling_url ?? null, active: t.active !== false,
      locations: (t.locations ?? []).filter((l): l is { kind: string; location?: string | null } => typeof l?.kind === "string"),
    };
  } catch (e) {
    if (e instanceof CalendlyError && e.status === 404) return null;
    throw e;
  }
}

/** Calendly refuses a longer window per call. */
export const AVAILABLE_TIMES_MAX_WINDOW_MS = 7 * 864e5;

export type AvailableTime = { startTime: string; status: string; inviteesRemaining: number | null; schedulingUrl: string | null };

/** Open start times on ONE event type in [start, end] (≤ 7 days, start in the future). Throws CalendlyError (403 = plan). */
export async function eventTypeAvailableTimes(eventTypeUri: string, startISO: string, endISO: string): Promise<AvailableTime[]> {
  const r = await calendlyRequest<{ collection?: { status?: string; start_time?: string; invitees_remaining?: number; scheduling_url?: string }[] }>(
    "/event_type_available_times",
    { query: { event_type: eventTypeUri, start_time: startISO, end_time: endISO } },
  );
  return (r.collection ?? [])
    .filter((s): s is { status?: string; start_time: string; invitees_remaining?: number; scheduling_url?: string } => typeof s?.start_time === "string")
    .map((s) => ({ startTime: s.start_time, status: s.status ?? "available", inviteesRemaining: typeof s.invitees_remaining === "number" ? s.invitees_remaining : null, schedulingUrl: s.scheduling_url ?? null }));
}

// ---------------------------------------------------------------------------
// THE WRITE GUARD. Same shape as Aryeo's hubWritePermit (integrations/aryeo.ts):
// every write takes a permit, and a permit exists only if calendlyWritePermit()
// issued it in this process a moment ago — there is no other way to construct
// one (the WeakSet is private). The decision itself is callBookingScope
// (lib/callBooking.ts): `call_booking` ON (a missing row is OFF), then R02's
// scope rules — a TEST fixture listed in authorizedFixtureClientIds whose
// invitee address is a verified test inbox, or a real client inside an
// approved, unexpired pilot that names this operation. Today the switch is off
// and both lists are empty, so every write refuses before a socket opens.
// ---------------------------------------------------------------------------

export type CalendlyWriteOperation = "invitees.create" | "scheduled_events.cancel";

/** Proof that THE guard said yes, a moment ago, for this client and operation. */
export type CalendlyWritePermit = {
  readonly clientId: string;
  readonly operation: CalendlyWriteOperation;
  readonly scope: "FIXTURE" | "PILOT";
  readonly issuedAt: number;
};

const issuedCalendlyPermits = new WeakSet<CalendlyWritePermit>();
const CALENDLY_PERMIT_TTL_MS = 120_000;

export async function calendlyWritePermit(a: {
  client: { id: string; name: string | null } | null;
  operation: CalendlyWriteOperation;
  /** The address Calendly will email — a fixture's must be a verified test inbox. */
  inviteeEmail?: string | null;
}): Promise<{ ok: true; permit: CalendlyWritePermit } | { ok: false; reason: string }> {
  if (!a.client?.id) return { ok: false, reason: "no client — the hub does not write to Calendly for nobody" };
  const { callBookingScope } = await import("@/lib/callBooking");
  const d = await callBookingScope({ client: a.client, operation: a.operation, inviteeEmail: a.inviteeEmail ?? null });
  if (!d.ok) return { ok: false, reason: d.reason };
  const permit: CalendlyWritePermit = Object.freeze({ clientId: a.client.id, operation: a.operation, scope: d.scope, issuedAt: Date.now() });
  issuedCalendlyPermits.add(permit);
  return { ok: true, permit };
}

function checkCalendlyPermit(p: CalendlyWritePermit, operation: CalendlyWriteOperation): void {
  if (!p || !issuedCalendlyPermits.has(p)) throw new CalendlyError(`Refusing ${operation}: no write permit from calendlyWritePermit().`, 403);
  if (p.operation !== operation) throw new CalendlyError(`Refusing ${operation}: the permit is for ${p.operation}.`, 403);
  if (Date.now() - p.issuedAt > CALENDLY_PERMIT_TTL_MS) throw new CalendlyError(`Refusing ${operation}: the write permit expired; ask the guard again.`, 403);
}

/**
 * What a failed write MEANS (same three words as Aryeo's).
 *   REJECTED   Calendly answered no (4xx), or we never sent it. Nothing happened.
 *   RETRYABLE  429 — refused for load. Nothing happened.
 *   UNKNOWN    a timeout, a 5xx, a dropped socket — it MAY have happened. Only a
 *              read can settle it; never a second POST.
 */
export function classifyCalendlyWriteError(e: unknown): "REJECTED" | "RETRYABLE" | "UNKNOWN" {
  if (e instanceof CalendlyError && typeof e.status === "number") {
    if (e.status === 429) return "RETRYABLE";
    if (e.status === 408) return "UNKNOWN";
    if (e.status >= 400 && e.status < 500) return "REJECTED";
    if (e.status === 0) return "REJECTED"; // a configuration refusal raised before any request
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

export type CreateInviteeInput = {
  eventTypeUri: string;
  startISO: string;
  invitee: { name: string; email: string; timezone: string };
  location?: { kind: string; location?: string | null } | null;
  tracking?: InviteeTracking;
};

/** POST /invitees — books ONE invitee on the mapped type. One attempt; the caller owns recovery. */
export async function createInvitee(permit: CalendlyWritePermit, input: CreateInviteeInput): Promise<Invitee & { cancel_url?: string; reschedule_url?: string }> {
  checkCalendlyPermit(permit, "invitees.create");
  const body: Record<string, unknown> = {
    event_type: input.eventTypeUri,
    start_time: new Date(input.startISO).toISOString(),
    invitee: { name: input.invitee.name, email: input.invitee.email, timezone: input.invitee.timezone },
    ...(input.location ? { location: input.location.location ? { kind: input.location.kind, location: input.location.location } : { kind: input.location.kind } } : {}),
    ...(input.tracking ? { tracking: input.tracking } : {}),
  };
  const r = await calendlyRequest<{ resource?: Invitee }>("/invitees", { method: "POST", body });
  if (!r.resource?.uri) throw new CalendlyError("Calendly accepted the booking but returned no invitee.", 502);
  return r.resource;
}

/** POST /scheduled_events/{uuid}/cancellation. */
export async function cancelScheduledEvent(permit: CalendlyWritePermit, eventUri: string, reason: string): Promise<void> {
  checkCalendlyPermit(permit, "scheduled_events.cancel");
  const uuid = eventUri.split("/").pop();
  if (!uuid) throw new CalendlyError("No event to cancel.", 400);
  await calendlyRequest(`/scheduled_events/${uuid}/cancellation`, { method: "POST", body: { reason: reason.slice(0, 200) } });
}
