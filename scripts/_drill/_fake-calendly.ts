// ---------------------------------------------------------------------------
// A FAKE CALENDLY (W03, Sep 25 2026) — the v2 API the hub reads and the two
// writes W03 adds, answered in-process through fenceFetch's `allow`, so the
// shipped client (src/lib/integrations/calendly.ts) runs unmodified.
//
// Built from Calendly's documented contract (developer.calendly.com — "Scheduling
// API", "Schedule events with AI agents", the scheduled-event and invitee
// resources). What it enforces, because the hub's safety depends on it:
//   · GET /event_type_available_times: start_time in the future, end − start ≤
//     7 days, else 400; plan "free" → 403 ("Permission Denied").
//   · POST /invitees: the event type exists, start_time is an open slot on it
//     and not taken, invitee name/email/timezone present, location.kind is one
//     the type offers; plan "free" → 403. Books ONE event + ONE invitee and
//     keeps `tracking` exactly as posted (utm_content is the portal token).
//   · POST /scheduled_events/{uuid}/cancellation: an active event only.
//   · GET /scheduled_events (min/max start, user), /{uuid}, /{uuid}/invitees.
// Fault injection for the recovery paths: `commitThenTimeout` (the booking IS
// made, the caller sees a timeout) and `failNextPost` (a status, nothing made).
// `bookFromPage` books the way the embedded Calendly page does — no hub write.
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";

export const CAL = "https://api.calendly.com";
const USER = `${CAL}/users/USER-JORDAN`;

type Json = Record<string, unknown>;
export type FakeEventType = { uri: string; name: string; slug: string; duration: number; scheduling_url: string; active: boolean; locations: { kind: string; location?: string }[] };
export type FakeInvitee = {
  uri: string; event: string; name: string; email: string; timezone: string; status: "active" | "canceled";
  tracking: Json; rescheduled: boolean; old_invitee: string | null; new_invitee: string | null;
  cancel_url: string; reschedule_url: string; cancellation: Json | null; created_at: string;
};
export type FakeEvent = {
  uri: string; name: string; status: "active" | "canceled"; start_time: string; end_time: string; event_type: string;
  location: Json; calendar_event: { external_id: string; kind: string }; event_memberships: { user: string }[]; created_at: string;
};

export type FakeCalendly = ReturnType<typeof makeFakeCalendly>;

export function makeFakeCalendly(opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const types = new Map<string, FakeEventType>();
  const open = new Map<string, Set<string>>(); // event type → ISO starts
  const events = new Map<string, FakeEvent>(); // uuid → event
  const invitees = new Map<string, FakeInvitee[]>(); // event uuid → invitees
  const state = {
    plan: "paid" as "paid" | "free",
    commitThenTimeout: 0,
    failNextPost: null as number | null,
    posts: 0, postsCommitted: 0, cancels: 0, reads: 0,
    log: [] as string[],
  };

  const iso = (d: Date | string) => new Date(d).toISOString().replace(/\.\d{3}Z$/, ".000000Z");
  const norm = (s: string) => new Date(s).toISOString();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const err = (status: number, title: string, message: string) => json(status, { title, message });
  const taken = (typeUri: string, startIso: string) =>
    [...events.values()].some((e) => e.event_type === typeUri && e.status === "active" && norm(e.start_time) === norm(startIso));

  function addEventType(t: Partial<FakeEventType> & { id: string; name: string }): FakeEventType {
    const et: FakeEventType = {
      uri: `${CAL}/event_types/${t.id}`, name: t.name, slug: t.slug ?? t.id.toLowerCase(), duration: t.duration ?? 30,
      scheduling_url: t.scheduling_url ?? `https://calendly.com/realtourpilot-info/${t.slug ?? t.id.toLowerCase()}`, active: t.active ?? true,
      locations: t.locations ?? [{ kind: "google_conference" }],
    };
    types.set(et.uri, et);
    open.set(et.uri, new Set());
    return et;
  }
  function openSlots(typeUri: string, starts: (Date | string)[]) {
    const s = open.get(typeUri);
    if (!s) throw new Error(`no fake event type ${typeUri}`);
    for (const x of starts) s.add(norm(typeof x === "string" ? x : x.toISOString()));
  }

  function book(typeUri: string, startIso: string, who: { name: string; email: string; timezone?: string; tracking?: Json; old_invitee?: string | null }): { event: FakeEvent; invitee: FakeInvitee } {
    const t = types.get(typeUri)!;
    const evId = randomUUID();
    const invId = randomUUID();
    const start = new Date(startIso);
    const event: FakeEvent = {
      uri: `${CAL}/scheduled_events/${evId}`, name: t.name, status: "active", start_time: iso(start),
      end_time: iso(new Date(start.getTime() + t.duration * 60_000)), event_type: t.uri,
      location: { type: "google_conference", join_url: `https://meet.google.com/fake-${evId.slice(0, 8)}` },
      calendar_event: { external_id: `gcal-${evId.slice(0, 12)}`, kind: "google" }, event_memberships: [{ user: USER }], created_at: iso(new Date(now())),
    };
    const invitee: FakeInvitee = {
      uri: `${CAL}/scheduled_events/${evId}/invitees/${invId}`, event: event.uri, name: who.name, email: who.email.toLowerCase(),
      timezone: who.timezone ?? "America/New_York", status: "active",
      tracking: { utm_campaign: null, utm_source: null, utm_medium: null, utm_content: null, utm_term: null, salesforce_uuid: null, ...(who.tracking ?? {}) },
      rescheduled: false, old_invitee: who.old_invitee ?? null, new_invitee: null,
      cancel_url: `https://calendly.com/cancellations/${invId}`, reschedule_url: `https://calendly.com/reschedulings/${invId}`,
      cancellation: null, created_at: iso(new Date(now())),
    };
    events.set(evId, event);
    invitees.set(evId, [invitee]);
    return { event, invitee };
  }

  /** The embedded page: the CLIENT books; the hub writes nothing. `tracking` is whatever the page's address carried. */
  function bookFromPage(typeUri: string, startIso: string, who: { name: string; email: string; timezone?: string; tracking?: Json }) {
    if (!types.has(typeUri)) throw new Error(`no fake event type ${typeUri}`);
    return book(typeUri, startIso, who);
  }

  /** Calendly's reschedule page: the old invitee is marked rescheduled, its event canceled; the new one points back. */
  function rescheduleFromPage(eventUri: string, newStartIso: string, opts2: { carryTracking?: boolean } = {}) {
    const uuid = eventUri.split("/").pop()!;
    const ev = events.get(uuid)!;
    const old = invitees.get(uuid)![0];
    const made = book(ev.event_type, newStartIso, { name: old.name, email: old.email, timezone: old.timezone, tracking: opts2.carryTracking ? old.tracking : {}, old_invitee: old.uri });
    old.rescheduled = true; old.new_invitee = made.invitee.uri; old.status = "canceled";
    old.cancellation = { canceled_by: old.name, reason: "rescheduled", canceler_type: "invitee" };
    ev.status = "canceled";
    return made;
  }

  function cancelFromPage(eventUri: string) {
    const uuid = eventUri.split("/").pop()!;
    const ev = events.get(uuid)!;
    ev.status = "canceled";
    for (const i of invitees.get(uuid) ?? []) { i.status = "canceled"; i.cancellation = { canceled_by: i.name, reason: "cancelled by invitee", canceler_type: "invitee" }; }
  }

  async function handle(url: string, init?: RequestInit): Promise<Response | null> {
    if (!url.startsWith(CAL)) return null;
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const p = u.pathname;
    state.log.push(`${method} ${p}${u.search}`);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!/^Bearer .+/.test(auth)) return err(401, "Unauthenticated", "The access token is missing");

    if (method === "GET" && p === "/users/me") return json(200, { resource: { uri: USER, name: "Jordan Spackman", email: "info@realtourpilot.com", current_organization: `${CAL}/organizations/ORG1` } });
    if (method === "GET" && p === "/event_types") return json(200, { collection: [...types.values()].map((t) => ({ ...t, profile: { owner: USER } })), pagination: { next_page: null } });
    let m = /^\/event_types\/([^/]+)$/.exec(p);
    if (method === "GET" && m) {
      const t = types.get(`${CAL}/event_types/${m[1]}`);
      return t ? json(200, { resource: { ...t, profile: { owner: USER } } }) : err(404, "Resource Not Found", "no such event type");
    }
    if (method === "GET" && p === "/event_type_available_times") {
      state.reads++;
      if (state.plan === "free") return err(403, "Permission Denied", "This feature requires a paid Calendly plan");
      const t = types.get(u.searchParams.get("event_type") ?? "");
      if (!t) return err(404, "Resource Not Found", "no such event type");
      const start = Date.parse(u.searchParams.get("start_time") ?? "");
      const end = Date.parse(u.searchParams.get("end_time") ?? "");
      if (!Number.isFinite(start) || !Number.isFinite(end)) return err(400, "Invalid Argument", "start_time and end_time are required");
      if (start <= now()) return err(400, "Invalid Argument", "start_time must be in the future");
      if (end - start > 7 * 864e5) return err(400, "Invalid Argument", "The date range can be no greater than 1 week (7 days)");
      const collection = [...(open.get(t.uri) ?? [])]
        .filter((s) => { const x = Date.parse(s); return x >= start && x <= end && !taken(t.uri, s); })
        .sort()
        .map((s) => ({ status: "available", invitees_remaining: 1, start_time: iso(s), scheduling_url: `${t.scheduling_url}/${s}` }));
      return json(200, { collection });
    }
    if (method === "POST" && p === "/invitees") {
      state.posts++;
      if (state.plan === "free") return err(403, "Permission Denied", "This feature requires a paid Calendly plan");
      if (state.failNextPost) { const s = state.failNextPost; state.failNextPost = null; return err(s, "Error", `injected ${s}`); }
      const b = JSON.parse(String(init?.body ?? "{}")) as { event_type?: string; start_time?: string; invitee?: { name?: string; email?: string; timezone?: string }; location?: { kind?: string }; tracking?: Json };
      const t = types.get(b.event_type ?? "");
      if (!t) return err(400, "Invalid Argument", "event_type is invalid");
      if (!b.invitee?.name || !b.invitee?.email || !b.invitee?.timezone) return err(400, "Invalid Argument", "invitee name, email and timezone are required");
      if (!b.start_time || !(open.get(t.uri) ?? new Set()).has(norm(b.start_time)) || taken(t.uri, b.start_time) || Date.parse(b.start_time) <= now()) {
        return err(400, "Invalid Argument", "The selected time is no longer available");
      }
      if (t.locations.length && !t.locations.some((l) => l.kind === b.location?.kind)) return err(400, "Invalid Argument", "location.kind must be one of the event type's locations");
      const made = book(t.uri, b.start_time, { name: b.invitee.name, email: b.invitee.email, timezone: b.invitee.timezone, tracking: b.tracking ?? {} });
      state.postsCommitted++;
      if (state.commitThenTimeout > 0) {
        state.commitThenTimeout--;
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e; // committed at "Calendly", lost on the way back
      }
      return json(201, { resource: made.invitee });
    }
    if (method === "GET" && p === "/scheduled_events") {
      const min = Date.parse(u.searchParams.get("min_start_time") ?? "");
      const max = Date.parse(u.searchParams.get("max_start_time") ?? "");
      const collection = [...events.values()]
        .filter((e) => { const s = Date.parse(e.start_time); return (!Number.isFinite(min) || s >= min) && (!Number.isFinite(max) || s <= max); })
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      return json(200, { collection, pagination: { next_page: null } });
    }
    m = /^\/scheduled_events\/([^/]+)$/.exec(p);
    if (method === "GET" && m) {
      const e = events.get(m[1]);
      return e ? json(200, { resource: e }) : err(404, "Resource Not Found", "no such event");
    }
    m = /^\/scheduled_events\/([^/]+)\/invitees$/.exec(p);
    if (method === "GET" && m) {
      return events.has(m[1]) ? json(200, { collection: invitees.get(m[1]) ?? [], pagination: { next_page: null } }) : err(404, "Resource Not Found", "no such event");
    }
    m = /^\/scheduled_events\/([^/]+)\/cancellation$/.exec(p);
    if (method === "POST" && m) {
      state.cancels++;
      const e = events.get(m[1]);
      if (!e) return err(404, "Resource Not Found", "no such event");
      if (e.status !== "active") return err(403, "Permission Denied", "Event is already canceled");
      const b = JSON.parse(String(init?.body ?? "{}")) as { reason?: string };
      e.status = "canceled";
      for (const i of invitees.get(m[1]) ?? []) { i.status = "canceled"; i.cancellation = { canceled_by: "Jordan Spackman", reason: b.reason ?? null, canceler_type: "host" }; }
      return json(201, { resource: { canceled_by: "Jordan Spackman", reason: b.reason ?? null, canceler_type: "host", created_at: iso(new Date(now())) } });
    }
    return err(404, "Resource Not Found", `fake Calendly has no ${method} ${p}`);
  }

  const activeInvitees = () => [...invitees.values()].flat().filter((i) => i.status === "active");
  return { state, types, events, invitees, addEventType, openSlots, bookFromPage, rescheduleFromPage, cancelFromPage, handle, activeInvitees, USER };
}
