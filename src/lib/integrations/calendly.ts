import "server-only";
import { getSecret } from "@/lib/integrations/connections";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Calendly (v2 API, personal access token). Read-only: the hub never books or
// cancels — clients book through Jordan's public links, we read what happened.
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

async function calendlyRequest<T = unknown>(path: string, opts: { query?: Record<string, string>; key?: string } = {}): Promise<T> {
  const key = opts.key ?? (await getSecret("calendly"));
  if (!key) throw new CalendlyError("Calendly is not connected.", 401);
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
export type Invitee = {
  email?: string;
  name?: string;
  status?: string; // active | canceled
  uri?: string;
  timezone?: string;
  rescheduled?: boolean;
  old_invitee?: string | null;
  new_invitee?: string | null;
  cancel_url?: string;
  reschedule_url?: string;
  cancellation?: { canceled_by?: string; reason?: string | null; canceler_type?: string } | null;
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
