import "server-only";
import { getSecret } from "@/lib/integrations/connections";

// ---------------------------------------------------------------------------
// Calendly (v2 API, personal access token). Read-only: the hub never books or
// cancels — clients book through Jordan's public link, we read what happened.
//
// The strategy-call event type:
//   https://calendly.com/realtourpilot-info/content-program-strategy-call
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

async function calendlyRequest<T = unknown>(path: string, opts: { query?: Record<string, string>; key?: string } = {}): Promise<T> {
  const key = opts.key ?? (await getSecret("calendly"));
  if (!key) throw new CalendlyError("Calendly is not connected.", 401);
  const url = new URL(`${BASE}${path}`);
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
type EventType = { uri: string; slug?: string; name?: string };
export type ScheduledEvent = {
  uri: string;
  name?: string;
  status?: string; // active | canceled
  start_time?: string;
  end_time?: string;
  event_type?: string;
  location?: { type?: string; join_url?: string };
  calendar_event?: { external_id?: string | null; kind?: string | null } | null;
};
export type Invitee = { email?: string; name?: string; status?: string; uri?: string };

export async function testCalendlyKey(key: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const me = await calendlyRequest<CalendlyUser>("/users/me", { key });
    const who = me.resource?.name || me.resource?.email || "Calendly account";
    return { ok: true, label: `Calendly · ${who}` };
  } catch (e) {
    return { ok: false, error: e instanceof CalendlyError ? e.message : "Could not reach Calendly." };
  }
}

// The current user's uri — scheduled-event listing requires it.
async function currentUserUri(): Promise<string> {
  const me = await calendlyRequest<CalendlyUser>("/users/me");
  const uri = me.resource?.uri;
  if (!uri) throw new CalendlyError("Calendly /users/me returned no uri.");
  return uri;
}

// Resolve the strategy-call event type by its public slug (cached per lambda).
let cachedEventType: string | null = null;
export async function strategyCallEventType(): Promise<string | null> {
  if (cachedEventType) return cachedEventType;
  const user = await currentUserUri();
  let page: string | undefined = `${BASE}/event_types?user=${encodeURIComponent(user)}&count=100`;
  while (page) {
    const r: { collection?: EventType[]; pagination?: { next_page?: string | null } } = await calendlyRequest(
      page.replace(BASE, ""),
    );
    for (const et of r.collection ?? []) {
      if (et.slug === STRATEGY_CALL_SLUG) { cachedEventType = et.uri; return et.uri; }
    }
    page = r.pagination?.next_page ?? undefined;
  }
  return null;
}

// Strategy-call bookings in a window, each with its invitees (who booked).
export async function listStrategyCalls(minStartIso: string, maxStartIso: string): Promise<
  { event: ScheduledEvent; invitees: Invitee[] }[]
> {
  const user = await currentUserUri();
  const eventType = await strategyCallEventType();
  const out: { event: ScheduledEvent; invitees: Invitee[] }[] = [];
  let page: string | undefined =
    `/scheduled_events?user=${encodeURIComponent(user)}&min_start_time=${encodeURIComponent(minStartIso)}&max_start_time=${encodeURIComponent(maxStartIso)}&count=100`;
  while (page) {
    const r: { collection?: ScheduledEvent[]; pagination?: { next_page?: string | null } } = await calendlyRequest(page);
    for (const ev of r.collection ?? []) {
      // Filter to the strategy-call event type when we could resolve it; if the
      // slug lookup failed (renamed?), fall back to matching by event name.
      const isCall = eventType
        ? ev.event_type === eventType
        : /strategy call/i.test(ev.name ?? "");
      if (!isCall) continue;
      const uuid = ev.uri?.split("/").pop();
      let invitees: Invitee[] = [];
      if (uuid) {
        try {
          const ir = await calendlyRequest<{ collection?: Invitee[] }>(`/scheduled_events/${uuid}/invitees`, { query: { count: "100" } });
          invitees = ir.collection ?? [];
        } catch { /* invitees are an enrichment, not a requirement */ }
      }
      out.push({ event: ev, invitees });
    }
    const next = r.pagination?.next_page;
    page = next ? next.replace(BASE, "") : undefined;
  }
  return out;
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
