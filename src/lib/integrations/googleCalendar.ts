import "server-only";
import { ownerGoogleToken } from "./google";

// ---------------------------------------------------------------------------
// GOOGLE CALENDAR — read the owner's real day, and write time blocks back.
//
// Two rules shape everything here:
//
//  1. We write to the PRIMARY calendar on purpose. Calendly reads that calendar
//     to decide when Jordan is bookable, so a block that lives anywhere else is
//     decoration — it would not stop a client booking over his focus time.
//  2. We only ever touch events WE created. Every hub-written event carries a
//     private extended property (`rtpTodoId`); update and delete refuse to act
//     on anything without it. A planner that can silently delete a real meeting
//     is not a planner anyone should trust with their calendar.
// ---------------------------------------------------------------------------

const BASE = "https://www.googleapis.com/calendar/v3";
const CAL = "primary";
/** Marks an event as hub-written, and ties it back to the to-do. */
const TAG = "rtpTodoId";

export class CalendarNotConnected extends Error {
  constructor() {
    super("Google Calendar isn't connected. Reconnect Google on the Connections page.");
    this.name = "CalendarNotConnected";
  }
}

async function call<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const token = init?.token ?? (await ownerGoogleToken());
  if (!token) throw new CalendarNotConnected();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (res.status === 204) return {} as T;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = json.error as { message?: string; status?: string } | undefined;
    // 403 with an insufficient-scope status means the token predates the
    // calendar scope — the fix is a reconnect, not a retry.
    if (res.status === 401 || res.status === 403) throw new CalendarNotConnected();
    throw new Error(err?.message || `Google Calendar ${res.status}`);
  }
  return json as T;
}

export type CalEvent = {
  id: string;
  title: string;
  where: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  /** True when this is a block the hub wrote (so we may move or remove it). */
  ours: boolean;
  todoId: string | null;
  /** A Meet/Zoom link means no drive time is needed. */
  virtual: boolean;
};

type RawEvent = {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  transparency?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
};

const VIRTUAL = /\b(meet\.google|zoom\.us|teams\.microsoft|whereby|hangout|google meet|phone|call)\b/i;

/**
 * Everything on the primary calendar between two instants.
 *
 * Deliberately drops three kinds of row that look like commitments but aren't:
 * cancelled events, events the owner has DECLINED, and events marked "free"
 * (transparent) — birthdays, all-day holidays, FYI holds. Blocking work around
 * a declined meeting is how a plan quietly loses an hour a day.
 */
export async function listCalendarEvents(timeMin: Date, timeMax: Date): Promise<CalEvent[]> {
  const q = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true", // expand recurring series into real instances
    orderBy: "startTime",
    maxResults: "100",
  });
  const data = await call<{ items?: RawEvent[] }>(`/calendars/${CAL}/events?${q}`);
  const out: CalEvent[] = [];
  for (const e of data.items ?? []) {
    if (!e.id || e.status === "cancelled") continue;
    const me = e.attendees?.find((a) => a.self);
    if (me?.responseStatus === "declined") continue;
    if (e.transparency === "transparent") continue;

    const allDay = !e.start?.dateTime;
    const startRaw = e.start?.dateTime ?? e.start?.date;
    const endRaw = e.end?.dateTime ?? e.end?.date;
    if (!startRaw || !endRaw) continue;
    const start = new Date(startRaw);
    const end = new Date(endRaw);
    if (!(start.getTime() < end.getTime())) continue;

    const todoId = e.extendedProperties?.private?.[TAG] ?? null;
    const text = `${e.summary ?? ""} ${e.location ?? ""}`;
    out.push({
      id: e.id,
      title: (e.summary || "Busy").trim(),
      where: e.location?.trim() || null,
      start,
      end,
      allDay,
      ours: !!todoId,
      todoId,
      virtual: !!e.hangoutLink || VIRTUAL.test(text),
    });
  }
  return out;
}

/** Write a focus block onto the primary calendar. Returns the Google event id. */
export async function createBlock(input: {
  todoId: string;
  title: string;
  start: Date;
  end: Date;
  description?: string;
}): Promise<string> {
  const ev = await call<{ id?: string }>(`/calendars/${CAL}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: input.title,
      description: input.description ?? "Blocked by the RealTour Pilot hub. Change or remove it on My Day.",
      start: { dateTime: input.start.toISOString() },
      end: { dateTime: input.end.toISOString() },
      // The entire point: Calendly must read this as busy.
      transparency: "opaque",
      // Focus blocks shouldn't ping. The hub already shows the plan.
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { [TAG]: input.todoId } },
    }),
  });
  if (!ev.id) throw new Error("Google Calendar did not return an event id");
  return ev.id;
}

/** Move or retitle a block we wrote. Refuses to touch anything that isn't ours. */
export async function updateBlock(
  eventId: string,
  patch: { title?: string; start?: Date; end?: Date },
): Promise<void> {
  await assertOurs(eventId);
  const body: Record<string, unknown> = {};
  if (patch.title) body.summary = patch.title;
  if (patch.start) body.start = { dateTime: patch.start.toISOString() };
  if (patch.end) body.end = { dateTime: patch.end.toISOString() };
  if (Object.keys(body).length === 0) return;
  await call(`/calendars/${CAL}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** Remove a block we wrote. Refuses to touch anything that isn't ours. */
export async function deleteBlock(eventId: string): Promise<void> {
  const ok = await assertOurs(eventId, { missingIsFine: true });
  if (!ok) return; // already gone — deleting it by hand in Google is allowed
  await call(`/calendars/${CAL}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
}

/**
 * The safety interlock. Reads the event first and confirms it carries our tag.
 * Costs one extra request per write; the alternative is a bug class where a
 * stale id points at a real meeting and we delete it.
 */
async function assertOurs(eventId: string, opts?: { missingIsFine?: boolean }): Promise<boolean> {
  let ev: RawEvent;
  try {
    ev = await call<RawEvent>(`/calendars/${CAL}/events/${encodeURIComponent(eventId)}`);
  } catch (e) {
    if (e instanceof CalendarNotConnected) throw e;
    if (opts?.missingIsFine) return false; // 404/410: someone deleted it in Google
    throw e;
  }
  if (ev.status === "cancelled") return false;
  if (!ev.extendedProperties?.private?.[TAG]) {
    throw new Error("That event wasn't created by the hub, so it won't be changed.");
  }
  return true;
}

/** Cheap connected/not check for the UI. */
export async function calendarConnected(): Promise<boolean> {
  const token = await ownerGoogleToken();
  if (!token) return false;
  try {
    await call(`/calendars/${CAL}?fields=id`, { token });
    return true;
  } catch {
    return false;
  }
}
