import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { lockAdvisory } from "@/lib/dbLocks";
import type { PortalViewer } from "@/lib/portal";
import type { Invitee, ScheduledEvent } from "@/lib/integrations/calendly";
import type { HubPilot } from "@/lib/hubWritePermit";

// ---------------------------------------------------------------------------
// IN-PORTAL STRATEGY-CALL BOOKING (W03, unified handoff Sep 25 2026).
//
// The portal used to send a client away to Calendly (target=_blank, on a
// hard-coded URL) and the booking came back only through the hourly sweep,
// matched by email and filed on a month by the call's DATE. So a client who
// booked October's planning call on Sep 26 had it filed on October only
// because the 26th is past the late-month line, and a booking made from a
// different address sat in review. Three things fix that here:
//
//   THE EVENT TYPE is the enabled MONTHLY_STRATEGY mapping and nothing else —
//   never discovery, never a hard-coded link. No mapping = no booking offered
//   (NONE): a page the sweep would not read is worse than no page.
//
//   THE TOKEN. Every booking the portal starts carries
//     utm_content = rtp1.<monthId>.<hmac10(APP_SECRET, enrollmentId|monthId)>
//   Calendly keeps it on the invitee (tracking.utm_content). A booking whose
//   token verifies is the viewer's, for that month — not by name or by the
//   day of the month (A04) — and the month is LOCKED like a staff decision.
//   A token cannot be made without APP_SECRET.
//
//   TWO MODES.
//     EMBED — the mapped booking page inside the portal, prefilled with the
//             person's name, email and the token. The client books on
//             Calendly's own page; the hub writes nothing to Calendly. On
//             calendly.event_scheduled the server RE-READS the event and its
//             invitees (the browser's payload is never trusted), checks the
//             event type is the mapped monthly one and the token is this
//             viewer's, and ingests it at once — so A19's filming gate opens
//             in the same request.
//     API   — the hub lists open times (7-day pages, each slot with the
//             filming start it would give: slot END + the preparation window)
//             and books the invitee itself (POST /invitees). Only when the
//             `call_booking` switch is ON with config.mode "API", the client
//             is inside its fixture/pilot scope (R02's rules), AND the stored
//             read-only probe of GET /event_type_available_times said 200 —
//             the Scheduling API needs a paid plan and a 403 means embed.
//
// The API write is a durable attempt (ProgramCallBooking, unique month+start):
// INTENT before the POST, CREATED after it. A timeout is UNKNOWN and is settled
// by a READ (the token on the invitee), never a second POST.
// ---------------------------------------------------------------------------

export type CallBookingMode = "API" | "EMBED" | "NONE";
export type CallBookingOperation = "invitees.create" | "scheduled_events.cancel";
export const CALL_BOOKING_SWITCH = "call_booking" as const;
export const SCHEDULING_PROBE_KEY = "calendly_scheduling_probe";
/** How long an UNKNOWN/INTENT attempt waits for its booking to appear on a READ before it is called FAILED (safe to pick again). */
export const UNKNOWN_GRACE_MS = 5 * 60_000;
const DEFAULT_TZ = "America/New_York";
const SOURCE_UTM = "rtp-portal";

// ---------------------------------------------------------------------------
// THE TOKEN
// ---------------------------------------------------------------------------

function tokenSecret(): string {
  const s = process.env.APP_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("APP_SECRET must be set in production (portal call-booking token).");
  return "dev-insecure-secret-change-me";
}
const TOKEN_RE = /^rtp1\.([a-z0-9]{10,40})\.([A-Za-z0-9_-]{10})$/i;
const sig10 = (enrollmentId: string, monthId: string): string =>
  createHmac("sha256", tokenSecret()).update(`${enrollmentId}|${monthId}`).digest("base64url").slice(0, 10);

/** The booking token for one enrollment's month. */
export function portalCallToken(enrollmentId: string, monthId: string): string {
  return `rtp1.${monthId}.${sig10(enrollmentId, monthId)}`;
}

export type VerifiedCallToken = { token: string; enrollmentId: string; clientId: string; monthId: string; monthKey: string };

/**
 * Is this a genuine portal token for a live program month? The month named in
 * the token is loaded and the signature recomputed over ITS enrollment, so a
 * token cannot be pointed at another client's month. Refused: a malformed or
 * forged token, a month that no longer exists or is historical, an enrollment
 * that is not ACTIVE (not a program identity any more), and a STALE PAGE — a
 * token for a month earlier than the month the booking was MADE in (a page
 * left open since September must not file an October booking on September).
 *
 * Staleness is judged by when the booking was made (`bookedAt`: the invitee's
 * created_at), not by when the call happens. It used to be the call's start,
 * and that refused an honest late-month booking: on Oct 29 a client planning
 * October picks the first open time, Mon Nov 2; the token was refused, the
 * call was filed on November by email and date, the portal said "Booked",
 * October's filming stayed shut and every new pick for October was "already
 * booked" (batch-3 review, Sep 25 2026). `callStart` is the fallback only when
 * the booking time is unknown.
 */
export async function verifyPortalCallToken(token: string | null | undefined, opts: { bookedAt?: Date | null; callStart?: Date | null } = {}): Promise<VerifiedCallToken | null> {
  const m = TOKEN_RE.exec((token ?? "").trim());
  if (!m) return null;
  const [, monthId, sig] = m;
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, monthKey: true, historical: true } });
  if (!month || month.historical) return null;
  const want = Buffer.from(sig10(month.enrollmentId, month.id));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const e = await prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: { clientId: true, status: true } });
  if (!e || e.status !== "ACTIVE") return null;
  const madeAt = opts.bookedAt && Number.isFinite(opts.bookedAt.getTime()) ? opts.bookedAt : opts.callStart ?? null;
  if (madeAt && month.monthKey < etMonthKey(madeAt)) return null;
  return { token: (token ?? "").trim(), enrollmentId: month.enrollmentId, clientId: e.clientId, monthId: month.id, monthKey: month.monthKey };
}

export const tokenOfInvitee = (i: Invitee | null | undefined): string | null => {
  const t = i?.tracking?.utm_content;
  return typeof t === "string" && t.startsWith("rtp1.") ? t : null;
};

/** When the booking was made: the invitee's created_at (null when Calendly did not say). */
export const bookedAtOfInvitee = (i: Invitee | null | undefined): Date | null => {
  const t = i?.created_at ? new Date(i.created_at) : null;
  return t && Number.isFinite(t.getTime()) ? t : null;
};

// ---------------------------------------------------------------------------
// THE EVENT TYPE — the enabled MONTHLY_STRATEGY mapping, nothing else.
// ---------------------------------------------------------------------------

export type MonthlyMapping = { id: string; eventTypeUri: string; eventName: string; publicUrl: string };

const CALENDLY_PAGE = /^https:\/\/calendly\.com\/[A-Za-z0-9._~\-/]+$/;

/** The one monthly strategy event type the portal books on, or null (no booking offered). A VALID row wins over an unverified one. */
export async function monthlyStrategyMapping(): Promise<MonthlyMapping | null> {
  const rows = await prisma.programCalendlyEventMapping.findMany({
    where: { enabled: true, purpose: "MONTHLY_STRATEGY" },
    orderBy: { createdAt: "asc" },
    select: { id: true, eventTypeUri: true, eventName: true, publicUrl: true, validationStatus: true },
  });
  const usable = rows.filter((r) => !!r.publicUrl && CALENDLY_PAGE.test(r.publicUrl));
  const pick = usable.find((r) => r.validationStatus === "VALID") ?? usable[0] ?? null;
  return pick ? { id: pick.id, eventTypeUri: pick.eventTypeUri, eventName: pick.eventName, publicUrl: pick.publicUrl! } : null;
}

/** The mapped page with Calendly's own prefill and UTM parameters. */
export function bookingPageUrl(publicUrl: string, p: { token?: string | null; name?: string | null; email?: string | null }): string {
  const u = new URL(publicUrl);
  if (p.name) u.searchParams.set("name", p.name);
  if (p.email) u.searchParams.set("email", p.email);
  if (p.token) {
    u.searchParams.set("utm_source", SOURCE_UTM);
    u.searchParams.set("utm_content", p.token);
  }
  return u.toString();
}

// ---------------------------------------------------------------------------
// THE SWITCH AND ITS SCOPE (R02's rules — lib/hubWritePermit.ts — applied to Calendly).
// ---------------------------------------------------------------------------

export type CallBookingConfig = { mode: "API" | "EMBED"; authorizedFixtureClientIds: string[]; pilot: HubPilot | null };

/** The switch's config, or null when `call_booking` is off (a missing row is off). The scope lists are read by R02's one parser. */
export async function callBookingConfig(): Promise<CallBookingConfig | null> {
  const { automationConfig } = await import("@/lib/programAutomation");
  const raw = await automationConfig<Record<string, unknown>>(CALL_BOOKING_SWITCH, {});
  if (!raw) return null;
  const { parseHubWriteConfig } = await import("@/lib/hubWritePermit");
  return { mode: raw.mode === "API" ? "API" : "EMBED", ...parseHubWriteConfig(raw) };
}

export type CallBookingScope = { ok: true; scope: "FIXTURE" | "PILOT" } | { ok: false; reason: string };

/**
 * May the hub WRITE to Calendly for this client? R02's ONE rule set
 * (lib/hubWritePermit.routeHubWrite — the same the Aryeo guard reads), on the
 * client row as the database has it (the name a caller passes is ignored):
 *   switch off → no.
 *   a TEST name: never a never-synthetic id, must be in
 *     authorizedFixtureClientIds, and then — Calendly's half of the fixture
 *     identity — the row's own email AND the address Calendly will email must
 *     both fold to the verified test inbox: renaming a real row "… TEST" does
 *     not move whose inbox the confirmation lands in → FIXTURE.
 *   a real client: never from the fixture list; an approved (approvedBy +
 *     approvedAt), unexpired pilot naming the client AND this operation → PILOT.
 * Pure reads. Nothing is written.
 */
export async function callBookingScope(a: {
  client: { id: string; name: string | null } | null;
  operation: CallBookingOperation;
  inviteeEmail?: string | null;
  now?: Date;
}): Promise<CallBookingScope> {
  const cfg = await callBookingConfig();
  if (!cfg) return { ok: false, reason: "the call_booking switch is off, so the hub does not write to Calendly" };
  if (!a.client?.id) return { ok: false, reason: "no client" };
  const row = await prisma.client.findUnique({ where: { id: a.client.id }, select: { id: true, name: true, email: true } });
  if (!row) return { ok: false, reason: "no such client" };
  const t = await import("@/lib/testClients");
  const { routeHubWrite } = await import("@/lib/hubWritePermit");
  const route = routeHubWrite({
    switchKey: CALL_BOOKING_SWITCH, config: { authorizedFixtureClientIds: cfg.authorizedFixtureClientIds, pilot: cfg.pilot },
    client: { id: row.id, name: row.name }, operation: a.operation, now: a.now ?? new Date(),
    isTestName: t.isTestClientName, isNeverSynthetic: t.isNeverSyntheticClientId,
  });
  if (route.kind === "REFUSE") return { ok: false, reason: route.reason };
  if (route.kind === "FIXTURE") {
    try {
      t.assertTestClient({ id: row.id, name: row.name });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "not a TEST client" };
    }
    if (!t.isVerifiedTestDestinationEmail(row.email)) {
      return { ok: false, reason: `the fixture's own email (${row.email || "none"}) is not the verified test inbox ${t.JORDAN_TEST_EMAIL}, so it may be a real client carrying a TEST name` };
    }
    if (!t.isVerifiedTestDestinationEmail(a.inviteeEmail)) {
      return { ok: false, reason: `a fixture's invitee must be the verified test inbox (${t.JORDAN_TEST_EMAIL}); "${a.inviteeEmail ?? "(none)"}" is not` };
    }
    const d = t.providerWriteDecision({ provider: "other", operation: `calendly.${a.operation}`, client: { id: row.id, name: row.name }, sandbox: true });
    return d.allowed ? { ok: true, scope: "FIXTURE" } : { ok: false, reason: d.reason };
  }
  const d = t.providerWriteDecision({ provider: "other", operation: `calendly.${a.operation}`, client: { id: row.id, name: row.name }, sandbox: false });
  return d.allowed ? { ok: true, scope: "PILOT" } : { ok: false, reason: d.reason };
}

// ---------------------------------------------------------------------------
// THE READ-ONLY PROBE. GET /event_type_available_times on the mapped type:
// 200 = the plan has the Scheduling API; 403 = it does not (embed is final).
// Allowed under §4's read-only verification; stored so a page render never
// asks Calendly.
// ---------------------------------------------------------------------------

export type SchedulingProbe = {
  status: "ok" | "plan" | "error";
  httpStatus: number | null;
  eventTypeUri: string | null;
  checkedAt: string;
  slotsSeen: number | null;
  message: string;
};

export async function storedSchedulingProbe(): Promise<SchedulingProbe | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: SCHEDULING_PROBE_KEY }, select: { value: true } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<SchedulingProbe>;
    return v && (v.status === "ok" || v.status === "plan" || v.status === "error") ? (v as SchedulingProbe) : null;
  } catch {
    return null;
  }
}

async function storeProbe(p: SchedulingProbe, by: string | null): Promise<void> {
  const { putSetting } = await import("@/lib/settings");
  await putSetting(SCHEDULING_PROBE_KEY, p, by);
}

/** Ask Calendly once (read-only) whether this account can list open times on the mapped monthly type. `store` saves the answer. */
export async function runSchedulingProbe(opts: { store: boolean; now?: Date; by?: string | null } = { store: false }): Promise<SchedulingProbe> {
  const now = opts.now ?? new Date();
  const mapping = await monthlyStrategyMapping();
  const base = { checkedAt: now.toISOString(), eventTypeUri: mapping?.eventTypeUri ?? null };
  let probe: SchedulingProbe;
  if (!mapping) {
    probe = { ...base, status: "error", httpStatus: null, slotsSeen: null, message: "no enabled MONTHLY_STRATEGY mapping with a Calendly page" };
  } else {
    const { eventTypeAvailableTimes, CalendlyError, AVAILABLE_TIMES_MAX_WINDOW_MS } = await import("@/lib/integrations/calendly");
    const start = new Date(now.getTime() + 10 * 60_000);
    const end = new Date(start.getTime() + AVAILABLE_TIMES_MAX_WINDOW_MS - 60_000);
    try {
      const slots = await eventTypeAvailableTimes(mapping.eventTypeUri, start.toISOString(), end.toISOString());
      probe = { ...base, status: "ok", httpStatus: 200, slotsSeen: slots.length, message: `${slots.length} open time(s) in the next 7 days` };
    } catch (e) {
      const status = e instanceof CalendlyError ? e.status ?? null : null;
      probe = status === 403
        ? { ...base, status: "plan", httpStatus: 403, slotsSeen: null, message: `the Scheduling API is not on this Calendly plan: ${e instanceof Error ? e.message : ""}`.trim() }
        : { ...base, status: "error", httpStatus: status, slotsSeen: null, message: e instanceof Error ? e.message : String(e) };
    }
  }
  if (opts.store) await storeProbe(probe, opts.by ?? null);
  return probe;
}

// ---------------------------------------------------------------------------
// THE MODE for a client.
// ---------------------------------------------------------------------------

export type CallBookingDecision = { mode: CallBookingMode; mapping: MonthlyMapping | null; scope: "FIXTURE" | "PILOT" | null; reason: string };

/**
 * API only when the switch's config says API AND this client is inside its
 * scope AND the stored probe passed on THIS event type; otherwise EMBED; NONE
 * only when no monthly mapping is enabled. `inviteeEmail` is the address the
 * booking would carry (a fixture's must be a test inbox); the client's own
 * address when omitted.
 */
export async function callBookingMode(clientId: string, opts: { inviteeEmail?: string | null } = {}): Promise<CallBookingDecision> {
  const mapping = await monthlyStrategyMapping();
  if (!mapping) return { mode: "NONE", mapping: null, scope: null, reason: "no enabled MONTHLY_STRATEGY mapping" };
  const cfg = await callBookingConfig();
  if (!cfg) return { mode: "EMBED", mapping, scope: null, reason: "call_booking is off — the embedded page" };
  if (cfg.mode !== "API") return { mode: "EMBED", mapping, scope: null, reason: "call_booking config mode is EMBED" };
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, email: true } });
  const scope = await callBookingScope({ client: client ? { id: client.id, name: client.name } : null, operation: "invitees.create", inviteeEmail: opts.inviteeEmail ?? client?.email ?? null });
  if (!scope.ok) return { mode: "EMBED", mapping, scope: null, reason: scope.reason };
  const probe = await storedSchedulingProbe();
  if (!probe || probe.status !== "ok" || probe.eventTypeUri !== mapping.eventTypeUri) {
    return { mode: "EMBED", mapping, scope: scope.scope, reason: probe ? `the Scheduling API probe says ${probe.status} (${probe.message})` : "the Scheduling API probe has not been run" };
  }
  return { mode: "API", mapping, scope: scope.scope, reason: `API (${scope.scope})` };
}

// ---------------------------------------------------------------------------
// WHO IS BOOKING — the person, else the account's own name and address.
// ---------------------------------------------------------------------------

async function bookerOf(viewer: PortalViewer): Promise<{ name: string | null; email: string | null; timezone: string }> {
  const [client, e] = await Promise.all([
    prisma.client.findUnique({ where: { id: viewer.enrollment.clientId }, select: { name: true, email: true } }),
    prisma.contentEnrollment.findUnique({ where: { id: viewer.enrollment.id }, select: { timezone: true } }),
  ]);
  const tz = e?.timezone || DEFAULT_TZ;
  if (viewer.actor.kind === "CLIENT") return { name: viewer.actor.name || client?.name || null, email: viewer.actor.email, timezone: tz };
  // The link and staff-on-behalf book AS the account: a staff member's own
  // address on a client's call would send Calendly's notices to the wrong person.
  return { name: client?.name ?? null, email: client?.email?.trim().toLowerCase() || null, timezone: tz };
}

async function canBookFor(viewer: PortalViewer): Promise<string | null> {
  const { can, refusalMessage } = await import("@/lib/portalAccess");
  return can(viewer, "requestSession") ? null : refusalMessage(viewer, "requestSession");
}

// ---------------------------------------------------------------------------
// THE PORTAL'S VIEW of one month's call booking.
// ---------------------------------------------------------------------------

export type PortalCallBookingView = {
  mode: CallBookingMode;
  monthId: string;
  monthKey: string;
  eventName: string | null;
  /** The mapped page, prefilled (name, email) and tokened, for the inline widget. */
  embedUrl: string | null;
  /** The mapped page with only the token — the "open in a new tab" fallback. */
  linkUrl: string | null;
  /** This viewer may book / change here (role, program status, open month). */
  canBook: boolean;
  timezone: string;
  /** The month's live monthly call, when there is one. */
  booked: { startISO: string; endISO: string | null; rescheduleUrl: string | null; cancelUrl: string | null; inPortal: boolean } | null;
};

const PAGE_URL = /^https:\/\/calendly\.com\//;

export async function portalCallBookingView(viewer: PortalViewer, monthId: string, opts: { now?: Date } = {}): Promise<PortalCallBookingView | null> {
  const now = opts.now ?? new Date();
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, monthKey: true, historical: true } });
  if (!month || month.enrollmentId !== viewer.enrollment.id) return null;
  const booker = await bookerOf(viewer);
  const decision = await callBookingMode(viewer.enrollment.clientId, { inviteeEmail: booker.email });
  const open = !month.historical && month.monthKey >= etMonthKey(now);
  const canBook = open && (await canBookFor(viewer)) === null;
  const token = portalCallToken(viewer.enrollment.id, month.id);
  const live = await prisma.programCallRecord.findFirst({
    where: {
      monthId: month.id, callType: "MONTHLY_STRATEGY", status: "SCHEDULED",
      matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] },
      OR: [{ scheduledEnd: { gt: now } }, { scheduledEnd: null, scheduledStart: { gt: now } }],
    },
    orderBy: { scheduledStart: "asc" },
    select: { scheduledStart: true, scheduledEnd: true, rawJson: true, bookingSource: true },
  });
  let booked: PortalCallBookingView["booked"] = null;
  if (live?.scheduledStart) {
    let inv: { reschedule_url?: unknown; cancel_url?: unknown } | null = null;
    try { inv = (JSON.parse(live.rawJson ?? "{}") as { calendly?: { invitee?: { reschedule_url?: unknown; cancel_url?: unknown } | null } }).calendly?.invitee ?? null; } catch { inv = null; }
    // The invitee's own change/cancel pages — only to someone who may change it.
    const url = (v: unknown) => (canBook && typeof v === "string" && PAGE_URL.test(v) ? v : null);
    booked = {
      startISO: live.scheduledStart.toISOString(), endISO: live.scheduledEnd?.toISOString() ?? null,
      rescheduleUrl: url(inv?.reschedule_url), cancelUrl: url(inv?.cancel_url), inPortal: (live.bookingSource ?? "").startsWith("PORTAL"),
    };
  }
  const page = decision.mapping?.publicUrl ?? null;
  return {
    mode: decision.mode, monthId: month.id, monthKey: month.monthKey,
    eventName: decision.mapping?.eventName ?? null,
    embedUrl: page ? bookingPageUrl(page, { token, name: booker.name, email: booker.email }) : null,
    linkUrl: page ? bookingPageUrl(page, { token }) : null,
    canBook, timezone: booker.timezone, booked,
  };
}

/**
 * What the portal's "Book the call" links point at, and the month view.
 *   v1 (today's layout, every real client until portal_layout_v2): the mapped
 *      page itself, from the mapping row — no token, no prefill. With no
 *      mapping it keeps the old public link, exactly as the reminder emails do
 *      (programReminders' bookCallLink), so v1 stays today's page in every
 *      state (UI-01). The in-portal booking below never uses that constant.
 *   v2: the guided plan's call step (`<planHref>#step-call`), where the booking
 *      happens inside the portal — except on the written route, whose only
 *      call link is "book one anyway" and has no call step to land on: there
 *      the mapped page with the token, in a new tab.
 * bookingUrl null = no monthly page is set up (the caller shows the office).
 */
export async function portalBookingLinks(viewer: PortalViewer, opts: { layout: "v1" | "v2"; planHref: string | null; now?: Date }): Promise<{ bookingUrl: string | null; view: PortalCallBookingView | null }> {
  const now = opts.now ?? new Date();
  const mapping = await monthlyStrategyMapping();
  if (opts.layout === "v1") {
    const { STRATEGY_CALL_BOOKING_URL } = await import("@/lib/integrations/calendly");
    return { bookingUrl: mapping?.publicUrl ?? STRATEGY_CALL_BOOKING_URL, view: null };
  }
  const month = await prisma.contentMonth.findFirst({
    where: { enrollmentId: viewer.enrollment.id, historical: false, monthKey: { gte: etMonthKey(now) } },
    orderBy: { monthKey: "asc" },
    select: { id: true, planningMode: true },
  });
  const view = month ? await portalCallBookingView(viewer, month.id, { now }) : null;
  if (!view || view.mode === "NONE") return { bookingUrl: view && opts.planHref ? `${opts.planHref}#step-call` : null, view };
  const written = month?.planningMode === "WRITTEN";
  return { bookingUrl: !written && opts.planHref ? `${opts.planHref}#step-call` : view.linkUrl, view };
}

// ---------------------------------------------------------------------------
// API MODE — open times, a page of 7 days at a time.
// ---------------------------------------------------------------------------

export type CallSlot = { startISO: string; endISO: string; filmingFromISO: string };
export type CallSlotsResult =
  | { ok: true; slots: CallSlot[]; fromISO: string; toISO: string; nextFromISO: string; prevFromISO: string | null }
  | { ok: false; message: string; fallback?: "EMBED" };

const durationCache = new Map<string, { at: number; minutes: number; location: { kind: string; location?: string | null } | null | "UNSUPPORTED" }>();
/** Location kinds the hub can name for the invitee (a video link the host's calendar makes). Anything that needs the client's own details → embed. */
const HUB_LOCATION_KINDS = new Set(["google_conference", "zoom_conference", "microsoft_teams_conference", "webex_conference", "gotomeeting", "physical", "custom"]);

async function eventShape(eventTypeUri: string): Promise<{ minutes: number; location: { kind: string; location?: string | null } | null | "UNSUPPORTED" }> {
  const hit = durationCache.get(eventTypeUri);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  const { getEventType } = await import("@/lib/integrations/calendly");
  const t = await getEventType(eventTypeUri);
  const minutes = t?.durationMinutes ?? 30;
  const first = t?.locations[0] ?? null;
  const location = !first ? null : HUB_LOCATION_KINDS.has(first.kind) ? { kind: first.kind, location: first.location ?? null } : ("UNSUPPORTED" as const);
  const v = { at: Date.now(), minutes, location };
  durationCache.set(eventTypeUri, v);
  return v;
}

/** The month's preparation window, from the same derivation the filming gate reads. */
async function monthWindow(monthId: string, now: Date): Promise<{ windowHours: number; windowWaived: boolean } | null> {
  const { recalcProgramMonth } = await import("@/lib/programMonths");
  const r = await recalcProgramMonth(monthId, { dryRun: true, now });
  return r ? { windowHours: r.after.windowHours, windowWaived: r.after.windowWaived } : null;
}

async function apiPreflight(viewer: PortalViewer, monthId: string, now: Date): Promise<
  | { ok: true; month: { id: string; monthKey: string }; decision: CallBookingDecision & { mapping: MonthlyMapping }; booker: { name: string | null; email: string | null; timezone: string } }
  | { ok: false; message: string; fallback?: "EMBED" }
> {
  const refused = await canBookFor(viewer);
  if (refused) return { ok: false, message: refused };
  const { openMonthForEnrollment } = await import("@/lib/portal");
  const month = await openMonthForEnrollment(viewer.enrollment.id, monthId);
  if (!month || month.monthKey < etMonthKey(now)) return { ok: false, message: "Pick one of your open program months." };
  const booker = await bookerOf(viewer);
  const decision = await callBookingMode(viewer.enrollment.clientId, { inviteeEmail: booker.email });
  if (decision.mode !== "API" || !decision.mapping) return { ok: false, message: "Book your call on the calendar below.", fallback: "EMBED" };
  return { ok: true, month, decision: decision as CallBookingDecision & { mapping: MonthlyMapping }, booker };
}

export async function callSlots(viewer: PortalViewer, monthId: string, fromISO?: string | null, opts: { now?: Date } = {}): Promise<CallSlotsResult> {
  const now = opts.now ?? new Date();
  const pre = await apiPreflight(viewer, monthId, now);
  if (!pre.ok) return pre;
  const { eventTypeAvailableTimes, CalendlyError, AVAILABLE_TIMES_MAX_WINDOW_MS } = await import("@/lib/integrations/calendly");
  const { earliestFilmingStart } = await import("@/lib/programMonths");
  const floor = now.getTime() + 5 * 60_000; // Calendly: start_time must be in the future
  const asked = fromISO ? Date.parse(fromISO) : NaN;
  const from = new Date(Math.max(floor, Number.isFinite(asked) ? asked : floor));
  if (from.getTime() - now.getTime() > 120 * 864e5) return { ok: false, message: "Pick a time in the next few months." };
  const to = new Date(from.getTime() + AVAILABLE_TIMES_MAX_WINDOW_MS - 1000);
  const [shape, win] = await Promise.all([eventShape(pre.decision.mapping.eventTypeUri), monthWindow(pre.month.id, now)]);
  if (!win) return { ok: false, message: "Pick one of your open program months." };
  let open: Awaited<ReturnType<typeof eventTypeAvailableTimes>>;
  try {
    open = await eventTypeAvailableTimes(pre.decision.mapping.eventTypeUri, from.toISOString(), to.toISOString());
  } catch (e) {
    if (e instanceof CalendlyError && e.status === 403) {
      // The plan lost the Scheduling API since the probe: record it, so the
      // next render is the embed rather than this error again.
      await storeProbe({ status: "plan", httpStatus: 403, eventTypeUri: pre.decision.mapping.eventTypeUri, checkedAt: now.toISOString(), slotsSeen: null, message: `403 while listing times: ${e.message}` }, "call-booking").catch(() => {});
      return { ok: false, message: "Book your call on the calendar below.", fallback: "EMBED" };
    }
    return { ok: false, message: "We couldn't load the open times just now. Try again in a minute." };
  }
  const slots: CallSlot[] = open
    .filter((s) => s.status === "available" && Date.parse(s.startTime) >= floor)
    .map((s) => {
      const start = new Date(s.startTime);
      const end = new Date(start.getTime() + shape.minutes * 60_000);
      // THE SEAM: what the filming gate will say once this call is booked —
      // measured from the call's scheduled END, never from this click.
      return { startISO: start.toISOString(), endISO: end.toISOString(), filmingFromISO: earliestFilmingStart(end, win).toISOString() };
    })
    .sort((a, b) => a.startISO.localeCompare(b.startISO));
  const prev = new Date(from.getTime() - AVAILABLE_TIMES_MAX_WINDOW_MS);
  return { ok: true, slots, fromISO: from.toISOString(), toISO: to.toISOString(), nextFromISO: new Date(to.getTime() + 1000).toISOString(), prevFromISO: from.getTime() > floor + 60_000 ? new Date(Math.max(prev.getTime(), floor)).toISOString() : null };
}

// ---------------------------------------------------------------------------
// API MODE — book one invitee, as a durable attempt.
// ---------------------------------------------------------------------------

export type BookCallResult = {
  ok: boolean;
  state: "CREATED" | "PENDING" | "REFUSED" | "FAILED";
  message: string;
  callAtISO?: string;
  filmingFromISO?: string | null;
  duplicate?: boolean;
};

const LIVE_ATTEMPT = ["INTENT", "UNKNOWN"];

/** After a booking is on file: when filming may start, from the gate itself. */
async function filmingFrom(enrollmentId: string, monthId: string, now: Date): Promise<string | null> {
  const { sessionGate } = await import("@/lib/portal");
  const g = await sessionGate(enrollmentId, monthId, { now }).catch(() => null);
  return g && !g.locked ? g.earliest.toISOString() : null;
}

async function ingestEvent(eventUri: string, token: string, source: "PORTAL_API" | "PORTAL_EMBED", now: Date): Promise<{ ok: boolean; monthId: string | null }> {
  const { getScheduledEvent } = await import("@/lib/integrations/calendly");
  const got = await getScheduledEvent(eventUri).catch(() => null);
  if (!got) return { ok: false, monthId: null };
  const { ingestCalendlyBooking } = await import("@/lib/contentCallRecords");
  const r = await ingestCalendlyBooking(got, { token, source, now });
  return { ok: r.ok, monthId: r.ok ? r.monthId : null };
}

/** Mark an attempt CREATED from the invitee that proves it, then read the event back into a call record. Returns the month the record was filed on (null = not filed yet). */
async function adopt(rowId: string, inv: { uri?: string; event?: string }, token: string, now: Date): Promise<string | null> {
  await prisma.programCallBooking.updateMany({
    where: { id: rowId, state: { in: LIVE_ATTEMPT } },
    data: { state: "CREATED", calendlyEventUri: inv.event ?? null, calendlyInviteeUri: inv.uri ?? null, lastError: null },
  });
  if (!inv.event) return null;
  const filed = await ingestEvent(inv.event, token, "PORTAL_API", now).catch(() => ({ ok: false, monthId: null }));
  return filed.ok ? filed.monthId : null;
}

/**
 * What the client is told once Calendly HAS the booking. "Booked" and the
 * filming date only when the call record landed on the month being planned —
 * the month the filming gate reads. Otherwise the booking is real but not on
 * this page yet, and the words say exactly that (never "Booked" over a page
 * that still offers the picker).
 */
async function afterBooked(viewer: PortalViewer, monthId: string, filedOn: string | null, callAt: Date, now: Date, opts: { tz: string; duplicate?: boolean }): Promise<BookCallResult> {
  const duplicate = !!opts.duplicate;
  const when = callAt.toLocaleString("en-US", { timeZone: opts.tz || DEFAULT_TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  if (filedOn === monthId) {
    return { ok: true, state: "CREATED", ...(duplicate ? { duplicate: true } : {}), message: duplicate ? "Your call is booked." : "Booked. Your strategy call is on the calendar.", callAtISO: callAt.toISOString(), filmingFromISO: await filmingFrom(viewer.enrollment.id, monthId, now) };
  }
  if (filedOn) {
    await prisma.programCallBooking.updateMany({ where: { monthId, startAt: callAt, state: "CREATED" }, data: { lastError: `the call record was filed on another month (${filedOn}); Kyle decides which month it plans` } });
    return { ok: false, state: "PENDING", message: `Your call is booked for ${when}. Kyle will confirm which month's plan it counts for, and this page will update.`, callAtISO: callAt.toISOString() };
  }
  return { ok: false, state: "PENDING", message: `Your call is booked for ${when}. It will show on this page within the hour.`, callAtISO: callAt.toISOString() };
}

/**
 * Settle an INTENT/UNKNOWN attempt by READING Calendly — never by posting
 * again. The booking is ours when an event on the mapped type starts at the
 * attempt's time and one of its invitees carries the attempt's token. Nothing
 * found: still PENDING inside the grace window, FAILED after it (then a new
 * pick may POST, because the read has shown the first one never landed).
 */
export async function resolveCallBooking(bookingId: string, opts: { now?: Date } = {}): Promise<"CREATED" | "PENDING" | "FAILED" | "GONE"> {
  const now = opts.now ?? new Date();
  const row = await prisma.programCallBooking.findUnique({ where: { id: bookingId } });
  if (!row) return "GONE";
  if (row.state === "CREATED") return "CREATED";
  if (!LIVE_ATTEMPT.includes(row.state)) return "FAILED";
  const { listScheduledEvents } = await import("@/lib/integrations/calendly");
  let found: { event: ScheduledEvent; invitee: Invitee } | null = null;
  try {
    const events = await listScheduledEvents(new Date(row.startAt.getTime() - 60_000).toISOString(), new Date(row.startAt.getTime() + 60_000).toISOString(), { eventTypeUris: new Set([row.eventTypeUri]) });
    for (const { event, invitees } of events) {
      if (event.event_type !== row.eventTypeUri) continue;
      const inv = invitees.find((i) => tokenOfInvitee(i) === row.token);
      if (inv) { found = { event, invitee: inv }; break; }
    }
  } catch {
    return "PENDING"; // could not read — "maybe" stays "maybe"
  }
  if (found) {
    await adopt(row.id, { uri: found.invitee.uri, event: found.event.uri }, row.token, now);
    return "CREATED";
  }
  // updatedAt is written by this module with the caller's clock at every
  // attempt transition (below), so the grace is measured on one clock.
  if (now.getTime() - row.updatedAt.getTime() > UNKNOWN_GRACE_MS) {
    await prisma.programCallBooking.updateMany({ where: { id: row.id, state: { in: LIVE_ATTEMPT } }, data: { state: "FAILED", lastError: "no booking with this token on Calendly after the timeout — safe to pick again", updatedAt: now } });
    return "FAILED";
  }
  return "PENDING";
}

/** The month a Calendly event's call record is filed on (null: no record yet, or on no month). */
async function filedMonthOf(eventUri: string | null): Promise<string | null> {
  if (!eventUri) return null;
  const rec = await prisma.programCallRecord.findUnique({ where: { calendlyEventUri: eventUri }, select: { monthId: true } });
  return rec?.monthId ?? null;
}

export async function bookStrategyCall(viewer: PortalViewer, monthId: string, startISO: string, opts: { now?: Date } = {}): Promise<BookCallResult> {
  const now = opts.now ?? new Date();
  const refuse = (message: string): BookCallResult => ({ ok: false, state: "REFUSED", message });
  const pre = await apiPreflight(viewer, monthId, now);
  if (!pre.ok) return refuse(pre.message);
  const start = new Date(startISO);
  if (!Number.isFinite(start.getTime())) return refuse("Pick a time from the list.");
  if (start.getTime() < now.getTime() + 5 * 60_000) return refuse("That time has passed. Pick another.");
  if (!pre.booker.email || !pre.booker.name) return refuse("Book your call on the calendar below.");
  const shape = await eventShape(pre.decision.mapping.eventTypeUri).catch(() => null);
  if (!shape || shape.location === "UNSUPPORTED") return refuse("Book your call on the calendar below.");
  const end = new Date(start.getTime() + shape.minutes * 60_000);
  const token = portalCallToken(viewer.enrollment.id, pre.month.id);
  const eventTypeUri = pre.decision.mapping.eventTypeUri;

  // ONE booking per month, decided under the month's lock: two tabs, a double
  // click, or two different slots at once cannot both reach POST /invitees.
  type Plan = { kind: "post"; id: string } | { kind: "resolve"; id: string } | { kind: "done"; result: BookCallResult };
  const plan: Plan = await prisma.$transaction(async (tx) => {
    await lockAdvisory(tx, `call-booking:${pre.month.id}`);
    const live = await tx.programCallRecord.findFirst({
      where: {
        monthId: pre.month.id, callType: "MONTHLY_STRATEGY", status: "SCHEDULED", matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] },
        OR: [{ scheduledEnd: { gt: now } }, { scheduledEnd: null, scheduledStart: { gt: now } }],
      },
      select: { scheduledStart: true, calendlyEventUri: true },
    });
    const rows = await tx.programCallBooking.findMany({ where: { monthId: pre.month.id } });
    // A CREATED attempt stands until Calendly says its event was cancelled or
    // moved — even when its call record is not on file yet (a read-back that
    // failed), so a missing record can never let a second POST through.
    const uris = rows.map((r) => r.calendlyEventUri).filter((u): u is string => !!u);
    const dead = new Set(uris.length ? (await tx.programCallRecord.findMany({ where: { calendlyEventUri: { in: uris }, status: { in: ["CANCELLED", "RESCHEDULED"] } }, select: { calendlyEventUri: true } })).map((r) => r.calendlyEventUri) : []);
    // …and a booking whose record is on file for ANOTHER month (a person
    // retargeted it) does not hold this one: this month still has no call,
    // and the picker must not answer "already booked" for ever.
    const elsewhere = new Set(uris.length ? (await tx.programCallRecord.findMany({ where: { calendlyEventUri: { in: uris }, monthId: { not: null }, NOT: { monthId: pre.month.id } }, select: { calendlyEventUri: true } })).map((r) => r.calendlyEventUri) : []);
    const standing = (r: { state: string; calendlyEventUri: string | null }) => r.state === "CREATED" && !(r.calendlyEventUri && (dead.has(r.calendlyEventUri) || elsewhere.has(r.calendlyEventUri)));
    const same = rows.find((r) => r.startAt.getTime() === start.getTime()) ?? null;
    if (same && standing(same)) {
      return { kind: "done", result: { ok: true, state: "CREATED", duplicate: true, message: "Your call is already booked for that time.", callAtISO: start.toISOString() } } as Plan;
    }
    if (live || rows.some((r) => r.id !== same?.id && standing(r))) return { kind: "done", result: refuse("Your call is already booked. Change it from here if you need another time.") } as Plan;
    if (same && LIVE_ATTEMPT.includes(same.state)) return { kind: "resolve", id: same.id } as Plan;
    const other = rows.find((r) => r.id !== same?.id && LIVE_ATTEMPT.includes(r.state));
    if (other) return { kind: "resolve", id: other.id } as Plan;
    if (same) {
      await tx.programCallBooking.update({ where: { id: same.id }, data: { state: "INTENT", token, endAt: end, eventTypeUri, attempts: { increment: 1 }, lastError: null, calendlyEventUri: null, calendlyInviteeUri: null, updatedAt: now } });
      return { kind: "post", id: same.id } as Plan;
    }
    const row = await tx.programCallBooking.create({
      data: { enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId, monthId: pre.month.id, eventTypeUri, startAt: start, endAt: end, token, state: "INTENT", attempts: 1, createdAt: now, updatedAt: now },
      select: { id: true },
    });
    return { kind: "post", id: row.id } as Plan;
  });

  if (plan.kind === "done") return plan.result;
  if (plan.kind === "resolve") {
    const r = await resolveCallBooking(plan.id, { now });
    const row = await prisma.programCallBooking.findUnique({ where: { id: plan.id }, select: { startAt: true, calendlyEventUri: true } });
    if (r === "CREATED" && row) return afterBooked(viewer, pre.month.id, await filedMonthOf(row.calendlyEventUri), row.startAt, now, { tz: pre.booker.timezone, duplicate: true });
    if (r === "PENDING") return { ok: false, state: "PENDING", message: "We're confirming your booking with the calendar. This page will update in a minute." };
    return { ok: false, state: "FAILED", message: "That booking didn't go through. Pick a time again." };
  }

  const { calendlyWritePermit, createInvitee, classifyCalendlyWriteError } = await import("@/lib/integrations/calendly");
  const client = await prisma.client.findUnique({ where: { id: viewer.enrollment.clientId }, select: { id: true, name: true } });
  const gate = await calendlyWritePermit({ client, operation: "invitees.create", inviteeEmail: pre.booker.email });
  if (!gate.ok) {
    await prisma.programCallBooking.update({ where: { id: plan.id }, data: { state: "FAILED", lastError: `refused before sending: ${gate.reason}`.slice(0, 500), updatedAt: now } });
    return refuse("Book your call on the calendar below.");
  }
  try {
    const inv = await createInvitee(gate.permit, {
      eventTypeUri, startISO: start.toISOString(),
      invitee: { name: pre.booker.name, email: pre.booker.email, timezone: pre.booker.timezone },
      location: shape.location,
      tracking: { utm_source: SOURCE_UTM, utm_content: token },
    });
    const filedOn = await adopt(plan.id, inv, token, now);
    return afterBooked(viewer, pre.month.id, filedOn, start, now, { tz: pre.booker.timezone });
  } catch (e) {
    const kind = classifyCalendlyWriteError(e);
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 400);
    if (kind === "UNKNOWN") {
      await prisma.programCallBooking.update({ where: { id: plan.id }, data: { state: "UNKNOWN", lastError: `no answer from Calendly: ${detail}`, updatedAt: now } });
      const r = await resolveCallBooking(plan.id, { now });
      if (r === "CREATED") {
        const row = await prisma.programCallBooking.findUnique({ where: { id: plan.id }, select: { calendlyEventUri: true } });
        return afterBooked(viewer, pre.month.id, await filedMonthOf(row?.calendlyEventUri ?? null), start, now, { tz: pre.booker.timezone });
      }
      return { ok: false, state: "PENDING", message: "We're confirming your booking with the calendar. This page will update in a minute." };
    }
    await prisma.programCallBooking.update({ where: { id: plan.id }, data: { state: "FAILED", lastError: `${kind}: ${detail}`, updatedAt: now } });
    return { ok: false, state: "FAILED", message: kind === "RETRYABLE" ? "The calendar is busy. Try again in a minute." : "That time was just taken. Pick another." };
  }
}

// ---------------------------------------------------------------------------
// EMBED MODE — the widget said "scheduled". Believe Calendly, not the browser.
// ---------------------------------------------------------------------------

const EVENT_URI_RE = /^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9-]{8,64}$/;

export async function confirmEmbeddedBooking(viewer: PortalViewer, input: { eventUri: string }, opts: { now?: Date } = {}): Promise<BookCallResult> {
  const now = opts.now ?? new Date();
  const refuse = (message: string): BookCallResult => ({ ok: false, state: "REFUSED", message });
  const refused = await canBookFor(viewer);
  if (refused) return refuse(refused);
  const eventUri = String(input?.eventUri ?? "").trim();
  if (!EVENT_URI_RE.test(eventUri)) return refuse("We couldn't read that booking. It will show here within the hour.");
  const mapping = await monthlyStrategyMapping();
  if (!mapping) return refuse("We couldn't read that booking. It will show here within the hour.");
  const { getScheduledEvent } = await import("@/lib/integrations/calendly");
  const got = await getScheduledEvent(eventUri).catch(() => null);
  if (!got) return { ok: false, state: "PENDING", message: "Thanks. Your booking will show here within the hour." };
  // The server's own read decides. A discovery call, the generic 30-minute
  // call, anything that is not the mapped monthly type: no record, no month.
  if (got.event.event_type !== mapping.eventTypeUri) return refuse("That booking isn't your monthly strategy call.");
  const callStart = got.event.start_time ? new Date(got.event.start_time) : null;
  let mine: VerifiedCallToken | null = null;
  let viaChain = false;
  for (const inv of got.invitees) {
    const v = await verifyPortalCallToken(tokenOfInvitee(inv), { bookedAt: bookedAtOfInvitee(inv), callStart });
    if (!v) continue;
    if (v.enrollmentId !== viewer.enrollment.id) return refuse("That booking belongs to a different account.");
    mine = v;
    break;
  }
  if (!mine) {
    // A move made through the invitee's reschedule page: the replacement names
    // the invitee it replaced; if THAT one was this viewer's portal booking,
    // the chain is Calendly's own record, not a guess.
    for (const inv of got.invitees) {
      if (!inv.old_invitee) continue;
      const prev = await prisma.programCallRecord.findFirst({ where: { calendlyInviteeUri: inv.old_invitee }, select: { portalToken: true } });
      const v = await verifyPortalCallToken(prev?.portalToken, { bookedAt: bookedAtOfInvitee(inv), callStart });
      if (v && v.enrollmentId === viewer.enrollment.id) { mine = v; viaChain = true; break; }
    }
  }
  if (!mine) return { ok: false, state: "PENDING", message: "Thanks. Your booking will show here within the hour." };
  const { ingestCalendlyBooking } = await import("@/lib/contentCallRecords");
  // Through the chain, ingest finds the token by old_invitee itself (and says so on the record).
  const r = await ingestCalendlyBooking(got, { token: viaChain ? null : mine.token, source: "PORTAL_EMBED", now });
  // Staff may already have settled this booking (ignored it, or confirmed it
  // as someone else's): their decision stands and the client is not told "booked".
  if (!r.ok || (r.matchState !== "MATCHED" && r.matchState !== "CONFIRMED_BY_STAFF")) return { ok: false, state: "PENDING", message: "Thanks. Your booking will show here within the hour." };
  // A move: the booking it replaced is re-read too, so the month does not show
  // two live calls (and measure filming from the old one) until the hour.
  for (const inv of got.invitees) {
    if (!inv.old_invitee) continue;
    const prev = await prisma.programCallRecord.findFirst({ where: { calendlyInviteeUri: inv.old_invitee }, select: { calendlyEventUri: true } });
    const old = prev?.calendlyEventUri ? await getScheduledEvent(prev.calendlyEventUri).catch(() => null) : null;
    if (old) await ingestCalendlyBooking(old, { now }).catch(() => null);
  }
  // The ledger row, for the month's one portal booking (idempotent: the
  // widget can fire twice, and the sweep may have seen it first).
  const inv = got.invitees.find((i) => i.status === "active") ?? got.invitees[0] ?? null;
  if (callStart) {
    const data = { enrollmentId: mine.enrollmentId, clientId: mine.clientId, monthId: mine.monthId, eventTypeUri: mapping.eventTypeUri, startAt: callStart, endAt: got.event.end_time ? new Date(got.event.end_time) : null, token: mine.token, state: got.event.status === "canceled" ? "CANCELLED" : "CREATED", calendlyEventUri: got.event.uri, calendlyInviteeUri: inv?.uri ?? null };
    const existing = await prisma.programCallBooking.findFirst({ where: { OR: [{ calendlyEventUri: got.event.uri }, { monthId: mine.monthId, startAt: callStart }] }, select: { id: true } });
    try {
      if (existing) await prisma.programCallBooking.update({ where: { id: existing.id }, data });
      else await prisma.programCallBooking.create({ data });
    } catch { /* a concurrent confirm wrote it first; the record above is what counts */ }
  }
  return { ok: true, state: "CREATED", message: "Booked. Your strategy call is on the calendar.", callAtISO: callStart?.toISOString(), filmingFromISO: await filmingFrom(mine.enrollmentId, mine.monthId, now) };
}

/**
 * After a change or cancel on Calendly's own pages (there is no postMessage
 * for a cancellation): re-read the month's call and file what Calendly says.
 * The hourly sweep does the same; this is just sooner.
 */
export async function refreshPortalCall(viewer: PortalViewer, monthId: string, opts: { now?: Date } = {}): Promise<{ ok: boolean; message: string }> {
  const now = opts.now ?? new Date();
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true } });
  if (!month || month.enrollmentId !== viewer.enrollment.id) return { ok: false, message: "Pick one of your program months." };
  // Every call the month still counts as live — a move leaves two rows until
  // both are read, and the one that matters is not always the latest start.
  const live = await prisma.programCallRecord.findMany({
    where: { monthId, enrollmentId: viewer.enrollment.id, callType: "MONTHLY_STRATEGY", calendlyEventUri: { not: null }, status: "SCHEDULED" },
    orderBy: { scheduledStart: "asc" },
    select: { calendlyEventUri: true },
  });
  if (!live.length) return { ok: true, message: "Nothing to update." };
  const { getScheduledEvent } = await import("@/lib/integrations/calendly");
  const { ingestCalendlyBooking } = await import("@/lib/contentCallRecords");
  let cancelled = 0;
  for (const rec of live) {
    const got = await getScheduledEvent(rec.calendlyEventUri!).catch(() => null);
    if (!got) return { ok: false, message: "We couldn't reach the calendar. Your change will show here within the hour." };
    await ingestCalendlyBooking(got, { now });
    if (got.event.status === "canceled") {
      cancelled++;
      await prisma.programCallBooking.updateMany({ where: { calendlyEventUri: rec.calendlyEventUri, state: "CREATED" }, data: { state: "CANCELLED" } });
    }
  }
  return { ok: true, message: cancelled === live.length ? "Your call is cancelled. Book a new time whenever you're ready." : "Your call is up to date." };
}

/**
 * Hourly (from the call-record sweep): settle attempts left INTENT/UNKNOWN by a
 * crash or a timeout, and close the ledger on calls Calendly cancelled.
 */
export async function reconcileCallBookings(opts: { now?: Date } = {}): Promise<{ created: number; failed: number; pending: number; cancelled: number }> {
  const now = opts.now ?? new Date();
  const out = { created: 0, failed: 0, pending: 0, cancelled: 0 };
  const open = await prisma.programCallBooking.findMany({ where: { state: { in: LIVE_ATTEMPT } }, select: { id: true }, take: 25 });
  for (const r of open) {
    const s = await resolveCallBooking(r.id, { now });
    if (s === "CREATED") out.created++; else if (s === "FAILED") out.failed++; else if (s === "PENDING") out.pending++;
  }
  const made = await prisma.programCallBooking.findMany({ where: { state: "CREATED", calendlyEventUri: { not: null } }, select: { id: true, calendlyEventUri: true }, take: 200 });
  if (made.length) {
    const dead = await prisma.programCallRecord.findMany({ where: { calendlyEventUri: { in: made.map((m) => m.calendlyEventUri!) }, status: { in: ["CANCELLED", "RESCHEDULED"] } }, select: { calendlyEventUri: true } });
    if (dead.length) {
      const r = await prisma.programCallBooking.updateMany({ where: { calendlyEventUri: { in: dead.map((d) => d.calendlyEventUri!) }, state: "CREATED" }, data: { state: "CANCELLED" } });
      out.cancelled = r.count;
    }
  }
  return out;
}
