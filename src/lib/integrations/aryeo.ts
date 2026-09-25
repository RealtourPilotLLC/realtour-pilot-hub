import "server-only";
import { prisma } from "@/lib/prisma";
import { MONTHLY_PLAN_RE } from "@/lib/pipeline";
import { getSecret, markSynced, markError } from "./connections";
import type { DeliverableType, Prisma, ProjectStatus } from "@prisma/client";
import type { NotifyTarget } from "@/lib/notify";
import { streetOf } from "@/lib/delivery";

// ---------------------------------------------------------------------------
// Aryeo REST client.  Base: https://api.aryeo.com/v1  ·  Auth: Bearer {key}
// `aryeoRequest` is fully generic so EVERY Aryeo endpoint is reachable; the
// named helpers below are conveniences over the ones we sync today.
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.aryeo.com/v1";

export class AryeoError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
    this.name = "AryeoError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

// Low-level request. Pass an explicit key (used when testing a not-yet-saved
// key); otherwise it loads the stored, decrypted key.
export async function aryeoRequest<T = unknown>(
  path: string,
  opts: { method?: string; query?: Query; body?: unknown; key?: string; timeoutMs?: number } = {},
): Promise<T> {
  const key = opts.key ?? (await getSecret("aryeo"));
  if (!key) throw new AryeoError("Aryeo is not connected — no API key on file.", 401);

  const url = new URL(`${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  // Hard timeout so a stalled Aryeo socket can never hang the request forever
  // (an un-timed media fetch was holding workers open and OOM-ing the instance).
  // GETs are idempotent, and Aryeo throws transient timeouts/5xxs routinely —
  // retry those up to 2 extra times with a short backoff instead of failing the
  // whole sync run on one blip (audit crack #25). Writes are never retried.
  const method = opts.method ?? "GET";
  const maxAttempts = method === "GET" ? 3 : 1;
  let res: Response | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12000);
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (res.status >= 500 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
      break;
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "AbortError";
      if (timedOut && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
      if (timedOut) throw new AryeoError("Aryeo timed out — please try again.", 504);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!res) throw new AryeoError("Aryeo timed out — please try again.", 504);

  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON response */
  }

  if (!res.ok) {
    const msg =
      (json as { message?: string })?.message ||
      `Aryeo API ${res.status} ${res.statusText}`;
    throw new AryeoError(msg, res.status, json ?? text);
  }
  return json as T;
}

// Aryeo wraps lists as { data: [...], meta: { current_page, last_page } } (Laravel-style).
type Paginated<T> = { data: T[]; meta?: { current_page?: number; last_page?: number } };

// Pull every page of a list endpoint.
async function fetchAll<T>(path: string, query: Query = {}, key?: string): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  const perPage = 50;
  // Safety cap so a misbehaving API can't loop forever.
  for (let i = 0; i < 200; i++) {
    const res = await aryeoRequest<Paginated<T>>(path, {
      query: { ...query, page, per_page: perPage },
      key,
    });
    const batch = Array.isArray(res?.data) ? res.data : [];
    out.push(...batch);
    const last = res?.meta?.last_page;
    if (last ? page >= last : batch.length < perPage) break;
    page++;
  }
  return out;
}

// ---- Convenience endpoints (the full surface is reachable via aryeoRequest) --
// Relationships to embed on order reads (Aryeo JSON:API-style includes).
const ORDER_INCLUDES = "customer,items,appointments,listing";

// Only import orders created on/after this date. We import the FULL history so
// every client's real project count + lifetime spend (→ segment) is accurate;
// the pipeline/dashboard apply their own recency window so old jobs don't clutter
// the active views.
const ARYEO_MIN_DATE = new Date("2021-01-01T00:00:00Z");

const LISTING_INCLUDES = "images,videos,floor_plans,interactive_content,files";

// Complete client. `request` reaches ANY endpoint; the named helpers cover every
// resource exposed by the Aryeo v1 API. Endpoints marked (perm) returned 401 for
// the current key (need extra scopes); they're included so they work once granted.
export const Aryeo = {
  request: aryeoRequest,

  // Orders
  orders: (q?: Query) => fetchAll<AryeoOrder>("/orders", { include: ORDER_INCLUDES, ...q }),
  order: (id: string) =>
    aryeoRequest<{ data: AryeoOrder }>(`/orders/${id}`, { query: { include: ORDER_INCLUDES } }).then((r) => r.data),
  createOrder: (body: unknown) => aryeoRequest("/orders", { method: "POST", body }),

  // Listings + their media (images/videos/floor plans/interactive/files are nested)
  listings: (q?: Query) => fetchAll<AryeoListing>("/listings", q),
  listing: (id: string) =>
    aryeoRequest<{ data: AryeoListing }>(`/listings/${id}`, { query: { include: LISTING_INCLUDES } }).then((r) => r.data),

  // Appointments + scheduling
  appointments: (q?: Query) => fetchAll<AryeoAppointment>("/appointments", { include: "order", ...q }),
  appointment: (id: string) =>
    aryeoRequest<{ data: AryeoAppointment }>(`/appointments/${id}`, { query: { include: "users,order" } }).then(
      (r) => r.data,
    ),
  // `notify` is Aryeo's documented key for both calls: it emails the order's
  // CUSTOMER. This used to send `notify_customer`, which Aryeo does not define,
  // so the staff "notify customer" box did nothing. Jordan, Sep 24 2026: make
  // it really email the client when ticked.
  rescheduleAppointment: (id: string, body: { start_at: string; end_at: string; notify?: boolean }) =>
    aryeoRequest(`/appointments/${id}/reschedule`, { method: "PUT", body }),
  cancelAppointment: (id: string, body: { notify?: boolean } = {}) =>
    aryeoRequest(`/appointments/${id}/cancel`, { method: "PUT", body }),
  availableDates: (q?: Query) => aryeoRequest("/scheduling/available-dates", { query: q }),
  availableTimeslots: (q?: Query) => aryeoRequest("/scheduling/available-timeslots", { query: q }),

  // Products (service catalogue)
  products: (q?: Query) => fetchAll<AryeoProduct>("/products", q),
  product: (id: string) => aryeoRequest<{ data: AryeoProduct }>(`/products/${id}`).then((r) => r.data),

  // People — customers + internal team
  customerUsers: (q?: Query) => fetchAll<AryeoCustomerUser>("/customer-users", q),
  customerUser: (id: string) => aryeoRequest<{ data: AryeoCustomerUser }>(`/customer-users/${id}`).then((r) => r.data),
  users: (q?: Query) => fetchAll<AryeoUser>("/users", q),
  me: () => aryeoRequest<{ data: AryeoUser }>("/me").then((r) => r.data),
  companyTeamMembers: (q?: Query) => fetchAll<AryeoCompanyTeamMember>("/company-team-members", q),

  // Tasks (production / payroll line items)
  tasks: (q?: Query) => fetchAll<unknown>("/tasks", q),

  // Activity feed (account-wide audit/timeline)
  activities: (q?: Query) => fetchAll<AryeoActivity>("/activities", q),

  // Forms, tags, company
  orderForms: (q?: Query) => fetchAll<unknown>("/order-forms", q),
  tags: (q?: Query) => fetchAll<AryeoTag>("/tags", q),
  groups: (q?: Query) => fetchAll<unknown>("/groups", q),
  group: () => fetchAll<AryeoGroup>("/groups").then((g) => g[0]),

  // Permission-gated for the current key (work once the key is granted these):
  discounts: (q?: Query) => fetchAll<unknown>("/discounts", q), // (perm)
  addresses: (q?: Query) => fetchAll<unknown>("/addresses", q), // (perm)
};

// Next open shoot dates from Aryeo's scheduling calendar. Used to draft a
// real availability reply when a client asks "when can you come out?".
// Aryeo's /scheduling/available-dates requires: timezone, interval (minutes),
// and filter[start_at]/filter[end_at] as `Y-m-d\TH:i:s\Z` (no milliseconds).
export async function getSchedulingAvailability(opts?: {
  days?: number;
  interval?: number;
  limit?: number;
}): Promise<{ date: string }[] | null> {
  const tz = "America/New_York";
  const interval = opts?.interval ?? 60;
  const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const start = new Date(Date.now() + 86_400_000); // from tomorrow
  const end = new Date(Date.now() + (opts?.days ?? 21) * 86_400_000);
  try {
    const r = await aryeoRequest<{ data?: { date: string; is_available?: boolean }[] }>(
      "/scheduling/available-dates",
      {
        query: {
          timezone: tz,
          interval,
          "filter[start_at]": isoZ(start),
          "filter[end_at]": isoZ(end),
        },
      },
    );
    const dates = (r?.data ?? []).filter((d) => d.is_available !== false).slice(0, opts?.limit ?? 6);
    return dates.length ? dates.map((d) => ({ date: d.date })) : null;
  } catch {
    return null; // not connected / not configured → caller drafts without it
  }
}

// ===========================================================================
// WHO IS ACTUALLY ASSIGNED TO A PRODUCT (Jordan, Sep 21 2026).
//
// Phase 0 measured `is_service_provider` on the company team member, found it
// true for Harrison Wells, and told Jordan he was already eligible for the
// three monthly-content products. He corrected it the same day:
//
//   "Follow Aryeo's product-specific videographer assignments. Harrison is not
//    currently assigned to Starter, Accelerator, or Pro. General availability
//    and is_service_provider do not establish eligibility for those products.
//    James is currently eligible. Reflect future assignment changes from Aryeo."
//
// He is right, and the flag is the wrong field. `is_service_provider` says
// "this person shoots" — it is true for five people including Sarah Anne, whose
// Aryeo user account is INACTIVE. The per-product assignment is a separate
// relation, and it is reachable: GET /products rejects most includes with a 400
// that names the allowed set, and that error message is what found it —
//
//   Requested include(s) `users` are not allowed. Allowed include(s) are
//   `categories, order_form_categories, order_form_categories.order_form,
//    providers`.
//
// `providers` is the assignment. Read against the live account on Sep 21 2026 it
// returns, for all three program products identically:
//
//   Video Starter - 2HR Session      → 3352bfaf… (Jordan), 019cf893-edf5… (James)
//   Video Accelerator - 4HR Session  → 3352bfaf… (Jordan), 019cf893-edf5… (James)
//   VIDEO PRO - 8HR Session          → 3352bfaf… (Jordan), 019cf893-edf5… (James)
//
// Harrison (019470c9-4713…) is on 40 of the other 44 products and on none of
// these three. That is Jordan's ground truth, measured rather than assumed, and
// it is why nothing here is hard-coded: the answer is read from Aryeo on every
// call (cached for a minute), so the day Jordan assigns Harrison to Accelerator
// in the Aryeo UI, the hub offers Harrison's slots with no deploy.
//
// THE IDS ARE COMPANY-TEAM-MEMBER IDS, which matters because the scheduling
// filter wants exactly those and Aryeo's own docs are wrong about it:
// filter[user_ids][] is documented as "The IDs of users" and rejects a user id
// with 422, while a company-team-member id returns 200 (Phase 0). `providers[].id`
// matches the /company-team-members ids exactly, so the two fit together.
//
// AND THE PRODUCT FILTERS ARE A TRAP. /scheduling/available-dates accepts
// filter[product_ids][], filter[product_id], product_id and filter[order_form_id]
// with a 200 and SILENTLY IGNORES ALL FOUR: meta.company_team_member_ids comes
// back as the same five people every time. Scoping to a product is something we
// have to do ourselves, by resolving the providers here and passing them as
// filter[user_ids][]. Believing the 200 is how a caller would ship the exact
// over-offer this whole change exists to fix.
// ===========================================================================

/** One creative Aryeo has assigned to a product, resolved to a real person. */
export type AryeoProductProvider = {
  /** COMPANY_TEAM_MEMBER id — what filter[user_ids][] wants (not the user id). */
  teamMemberId: string;
  name: string | null;
  email: string | null;
  /** the general "this person shoots" flag — NOT eligibility on its own */
  isServiceProvider: boolean;
  /** Aryeo user status; "inactive" people are assigned but must not be offered */
  userStatus: string | null;
  /** assigned to the product AND shootable AND their login is live */
  bookable: boolean;
  /** when not bookable, why — so a picker offering nobody can say so */
  reason: string | null;
};

// Aryeo is asked once a minute at most. Eligibility has to be live enough that
// a change Jordan makes is picked up without a deploy, and cheap enough that a
// portal page rendering a three-week calendar does not make 21 catalogue reads.
// Deliberately IN-PROCESS, not an AppSetting row: companySlotDays' AppSetting
// cache is the reason that function cannot be called from a read-only context
// (Phase 0), and a helper the drills must be able to run has no business
// writing to production to answer a question.
const PROVIDER_TTL_MS = 60_000;
let providerCache: { at: number; byProduct: Map<string, AryeoProductProvider[]> } | null = null;

/**
 * Every program-relevant product's assigned, bookable creatives, keyed by
 * product id. Read live from Aryeo; throws if Aryeo cannot be reached, because
 * a caller must not be handed an empty roster that looks like "nobody is
 * assigned" when it means "we could not ask".
 */
export async function productProviders(): Promise<Map<string, AryeoProductProvider[]>> {
  const hit = providerCache;
  if (hit && Date.now() - hit.at < PROVIDER_TTL_MS) return hit.byProduct;

  const [products, team] = await Promise.all([
    Aryeo.products({ include: "providers" }),
    Aryeo.companyTeamMembers(),
  ]);
  const byTm = new Map<string, AryeoCompanyTeamMember>();
  for (const t of team) if (t.id) byTm.set(t.id, t);

  const byProduct = new Map<string, AryeoProductProvider[]>();
  for (const p of products) {
    if (!p.id) continue;
    const rows: AryeoProductProvider[] = [];
    for (const ref of p.providers ?? []) {
      if (!ref?.id) continue;
      const tm = byTm.get(ref.id);
      const isSp = tm?.is_service_provider ?? false;
      const status = tm?.company_user?.status ?? null;
      // §19's eligibility question, answered with all three facts rather than
      // one. Sarah Anne is is_service_provider:true with an INACTIVE user and
      // still returns 24 bookable days from the availability endpoint, so a
      // picker that trusted the provider list alone would offer a client a
      // photographer who cannot log in (Phase 0).
      const reason =
        !tm ? "Aryeo assigned this person to the product but we could not find their team-member record."
        : !isSp ? "Assigned to the product but not marked as a service provider in Aryeo."
        : status && status.toLowerCase() !== "active" ? `Assigned to the product but their Aryeo account is ${status}.`
        : null;
      rows.push({
        teamMemberId: ref.id,
        name: tm?.company_user?.full_name ?? null,
        email: tm?.company_user?.email ?? null,
        isServiceProvider: isSp,
        userStatus: status,
        bookable: reason === null,
        reason,
      });
    }
    byProduct.set(p.id, rows);
  }
  providerCache = { at: Date.now(), byProduct };
  return byProduct;
}

/**
 * The creatives Aryeo has assigned to ONE product. `bookable` is the set a
 * client may be offered; the rest are returned too, each carrying why, so an
 * empty picker can explain itself instead of showing a blank calendar.
 *
 * An unknown product id returns an EMPTY list, which callers must read as "no
 * eligible creative" and refuse to book — never as "no filter, offer everyone",
 * which is the company-wide behaviour Jordan corrected.
 */
export async function productProvidersFor(productId: string): Promise<AryeoProductProvider[]> {
  return (await productProviders()).get(productId) ?? [];
}

/** Just the ids filter[user_ids][] wants, for the creatives who may be offered. */
export async function bookableProviderIdsFor(productId: string): Promise<string[]> {
  return (await productProvidersFor(productId)).filter((p) => p.bookable).map((p) => p.teamMemberId);
}

/** Drop the in-process provider cache — for a drill that wants a cold read. */
export function resetProductProviderCache(): void {
  providerCache = null;
}

/** One bookable day and the real starts on it, in ISO instants. `slotUsers`
 *  (CP-04) keeps Aryeo's own answer to "who is free at this start" — USER ids,
 *  as the timeslot endpoint returns them — so a slot can be tied to a creative. */
export type AryeoSlotDay = { date: string; slots: string[]; slotUsers?: Record<string, string[]> };

/**
 * REAL availability for ONE product: the package's own duration, scoped to the
 * creatives Aryeo has assigned to that product, with weekends removed.
 *
 * WHAT THIS REPLACES, measured (Phase 0, six consecutive days). The portal
 * asked for company-wide availability at interval 60 with NO duration and NO
 * creative, and over those six days offered 66 starts where 19 fit a four-hour
 * Accelerator with James — including 11 on a Thursday James had none, and 11 on
 * a Saturday. Every one of those is a slot a client could pick and nobody could
 * film.
 *
 * WEEKENDS ARE OURS TO ENFORCE (§8: "no weekend shoots in this program"). Aryeo
 * returned 14 four-hour slots on Saturday 2026-09-26 and will not apply that
 * rule, so it is applied here, on the ET calendar day rather than the server's.
 *
 * Returns null when Aryeo cannot be reached or when the product has no bookable
 * creative — both mean "do not offer a calendar", and they are separated by the
 * throw/empty distinction in productProviders above.
 */
export async function productAvailability(opts: {
  productId: string;
  /** minutes the session needs — 120 Starter, 240 Accelerator, 240 per Pro session */
  durationMin: number;
  /** how far ahead to look */
  days?: number;
  /** granularity of the offered starts */
  interval?: number;
  /** cap on days returned */
  limit?: number;
  /** false only for a drill that wants to SEE the weekend slots Aryeo offers */
  excludeWeekends?: boolean;
}): Promise<{ days: AryeoSlotDay[]; providers: AryeoProductProvider[] } | null> {
  const tz = "America/New_York";
  const interval = opts.interval ?? 30;
  const horizon = opts.days ?? 21;
  const excludeWeekends = opts.excludeWeekends !== false;
  const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  // ET day-of-week, not the server's. A 00:30 ET Saturday start is Saturday to
  // the client and Friday to a UTC box, and this program's rule is the client's.
  const etDow = (day: string) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const isWeekend = (day: string) => {
    const d = etDow(day);
    return d === "Sat" || d === "Sun";
  };

  let providers: AryeoProductProvider[];
  try {
    providers = await productProvidersFor(opts.productId);
  } catch {
    return null; // could not ask Aryeo — say nothing rather than offer everyone
  }
  const ids = providers.filter((p) => p.bookable).map((p) => p.teamMemberId);
  if (ids.length === 0) return { days: [], providers };

  // filter[user_ids][] repeats, once per creative. `query` on aryeoRequest is a
  // flat record, so the repetition is built here.
  const userFilter: Record<string, string> = {};
  ids.forEach((id, i) => { userFilter[`filter[user_ids][${i}]`] = id; });

  const start = new Date(Date.now() + 86_400_000); // from tomorrow
  const end = new Date(Date.now() + horizon * 86_400_000);
  let dates: { date: string; is_available?: boolean }[];
  try {
    const r = await aryeoRequest<{ data?: { date: string; is_available?: boolean }[] }>(
      "/scheduling/available-dates",
      {
        query: {
          timezone: tz,
          interval,
          duration: opts.durationMin,
          "filter[start_at]": isoZ(start),
          "filter[end_at]": isoZ(end),
          ...userFilter,
        },
      },
    );
    dates = (r?.data ?? []).filter((d) => d.is_available !== false);
  } catch {
    return null;
  }
  const wanted = dates.filter((d) => !(excludeWeekends && isWeekend(d.date))).slice(0, opts.limit ?? 21);

  const days: AryeoSlotDay[] = [];
  for (let i = 0; i < wanted.length; i += 4) {
    await Promise.all(
      wanted.slice(i, i + 4).map(async (d) => {
        try {
          const r = await aryeoRequest<{ data?: { start_at?: string; users?: { id?: string }[] }[] }>("/scheduling/available-timeslots", {
            query: {
              timezone: tz,
              interval,
              duration: opts.durationMin,
              date: d.date,
              ...userFilter,
            },
          });
          const slots = (r?.data ?? []).map((s) => s.start_at).filter((s): s is string => !!s);
          const slotUsers: Record<string, string[]> = {};
          for (const s of r?.data ?? []) if (s.start_at) slotUsers[s.start_at] = (s.users ?? []).map((u) => u.id).filter((x): x is string => !!x);
          if (slots.length) days.push({ date: d.date, slots, slotUsers });
        } catch { /* a missing day is fine */ }
      }),
    );
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, providers };
}

// ===========================================================================
// THE HUB'S OWN BOOKING WRITES (CP-04 / CP-05, Sep 24 2026).
//
// Until now the only Aryeo writes in the tree were the staff reschedule/cancel
// buttons and the customer-notes mirror. The content program needs four more —
// create an Address, create an Order, store an Appointment on it, and PATCH an
// Address — and every one of them books or moves a REAL creative's day. So
// they live behind two locks that cannot be forgotten:
//
//   1. Every write method below takes a HubWritePermit as its first argument,
//      and a permit exists only if hubWritePermit() issued it in this process
//      a moment ago. There is no other way to construct one (the WeakSet is
//      private), so a caller cannot reach POST /orders without passing THE
//      guard — not by a missed `if`, not by a refactor.
//   2. hubWritePermit() says yes only when ALL of these hold: the switch that
//      owns the write (`session_booking` / `address_sync`) is ON — a missing
//      ProgramAutomation row is OFF — AND the client is listed in that switch's
//      config `authorizedFixtureClientIds`, AND the client is a TEST client
//      (assertTestClient: a real row renamed to contain TEST is still refused),
//      AND providerWriteDecision agrees. Today both switches are off and no
//      client is listed, so every write refuses before a socket opens. The
//      first real write is Jordan's supervised test on a disposable fixture.
//
// WRITES ARE NEVER RETRIED IN HERE. aryeoRequest already makes one attempt for
// a non-GET, and a timeout after Aryeo committed is the one failure a retry
// turns into a double booking. classifyAryeoWriteError says what a failure
// MEANS; the state machine in sessionBooking.ts decides what to do about it.
//
// CUSTOMER NOTIFICATIONS ARE OFF BY CONSTRUCTION (Jordan, Sep 24 2026: "Aryeo
// notifies OUR TEAM only; the client hears from the hub"). POST /orders'
// `notify` sends to the customer AND the creator, so it is always false; the
// appointment store sends notifyCustomer false and notifyCompany as configured.
// Cancel/reschedule carry the documented `notify` key, always false here.
// ===========================================================================

export type HubWriteSwitch = "session_booking" | "address_sync";

/** Proof that THE guard said yes, a moment ago, for this client and operation. */
export type HubWritePermit = {
  readonly switchKey: HubWriteSwitch;
  readonly clientId: string;
  readonly clientName: string;
  readonly operation: string;
  readonly issuedAt: number;
};

const issuedPermits = new WeakSet<HubWritePermit>();
/** A permit is for the write about to happen, not for later: two minutes covers
 *  one booking's calls and nothing else. */
const PERMIT_TTL_MS = 120_000;

export type HubWriteDecision = { ok: true; permit: HubWritePermit } | { ok: false; reason: string };

/**
 * THE ONE GUARD for every hub-initiated Aryeo write. Pure reads (the switch row,
 * the client row) — nothing is written, and a refusal is a sentence a desk task
 * can carry.
 */
export async function hubWritePermit(a: {
  switchKey: HubWriteSwitch;
  client: { id: string; name: string | null } | null;
  operation: string;
}): Promise<HubWriteDecision> {
  const { automationConfig } = await import("@/lib/programAutomation");
  const { assertTestClient, providerWriteDecision } = await import("@/lib/testClients");
  const cfg = await automationConfig<{ authorizedFixtureClientIds: unknown }>(a.switchKey, { authorizedFixtureClientIds: [] });
  if (!cfg) return { ok: false, reason: `the ${a.switchKey} switch is off, so the hub does not write to Aryeo` };
  const allowed = Array.isArray(cfg.authorizedFixtureClientIds) ? cfg.authorizedFixtureClientIds.filter((x): x is string => typeof x === "string") : [];
  if (!a.client?.id || !allowed.includes(a.client.id)) {
    return { ok: false, reason: `this client is not in ${a.switchKey}'s authorizedFixtureClientIds, so the hub does not write to Aryeo for it` };
  }
  try {
    assertTestClient({ id: a.client.id, name: a.client.name });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "not a TEST client" };
  }
  const d = providerWriteDecision({ provider: "aryeo", operation: a.operation, client: { id: a.client.id, name: a.client.name }, sandbox: true });
  if (!d.allowed) return { ok: false, reason: d.reason };
  const permit: HubWritePermit = Object.freeze({ switchKey: a.switchKey, clientId: a.client.id, clientName: a.client.name ?? "", operation: a.operation, issuedAt: Date.now() });
  issuedPermits.add(permit);
  return { ok: true, permit };
}

function checkPermit(p: HubWritePermit, operation: string): void {
  if (!p || !issuedPermits.has(p)) throw new AryeoError(`Refusing ${operation}: no write permit from hubWritePermit().`, 403);
  if (Date.now() - p.issuedAt > PERMIT_TTL_MS) throw new AryeoError(`Refusing ${operation}: the write permit expired; ask the guard again.`, 403);
}

/**
 * What a failed write MEANS.
 *   REJECTED   Aryeo answered and said no (4xx), or we never sent it (no key,
 *              no permit). Nothing happened at the provider.
 *   RETRYABLE  429: Aryeo refused for load. Nothing happened; try later.
 *   UNKNOWN    a timeout, a 5xx, a dropped socket — it MAY have happened.
 *              aryeoRequest turns an AbortError into AryeoError(504), so a real
 *              504 and our own timeout are the same answer, which is correct:
 *              both are "maybe". Only a readback can settle it.
 */
export function classifyAryeoWriteError(e: unknown): "REJECTED" | "RETRYABLE" | "UNKNOWN" {
  if (e instanceof AryeoError && typeof e.status === "number") {
    if (e.status === 429) return "RETRYABLE";
    if (e.status === 408) return "UNKNOWN";
    if (e.status >= 400 && e.status < 500) return "REJECTED";
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

export type AryeoAddressWrite = {
  street_number?: string | null;
  street_name?: string | null;
  unit_number?: string | null;
  city?: string | null;
  state_or_province?: string | null;
  postal_code?: string | null;
  country?: string | null;
  latitude: number | null;
  longitude: number | null;
};
export type AryeoAddressRead = AryeoAddressWrite & { id: string; unparsed_address?: string | null };
export type AryeoTimeslot = { startAt: string; endAt: string | null; userIds: string[] | null };
export type AryeoBookedAppointment = {
  id: string;
  status: string | null;
  start_at: string | null;
  end_at: string | null;
  orderId: string | null;
  userIds: string[];
  teamMemberIds: string[];
  raw: unknown;
};

const WRITE_TIMEOUT_MS = 20_000;
const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function asAppointment(raw: unknown): AryeoBookedAppointment {
  const a = (raw ?? {}) as AryeoAppointment & { company_team_members?: { id?: string }[] };
  return {
    id: a.id ?? "",
    status: a.status ?? null,
    start_at: a.start_at ?? null,
    end_at: a.end_at ?? null,
    orderId: a.order?.id ?? null,
    userIds: (a.users ?? []).map((u) => u.id).filter((x): x is string => !!x),
    teamMemberIds: (a.company_team_members ?? []).map((t) => t.id).filter((x): x is string => !!x),
    raw,
  };
}

export const AryeoBooking = {
  // ---- reads (no permit; GETs retry inside aryeoRequest) ----
  getAddress: (id: string) =>
    aryeoRequest<{ data: AryeoAddressRead }>(`/addresses/${id}`).then((r) => r.data),
  getOrder: (id: string) =>
    aryeoRequest<{ data: AryeoOrder }>(`/orders/${id}`, { query: { include: "items,appointments,customer,address" } }).then((r) => r.data),
  /** Newest-first, customer included — the marker scan's input. */
  recentOrders: async (pages = 2): Promise<AryeoOrder[]> => {
    const out: AryeoOrder[] = [];
    for (let page = 1; page <= pages; page++) {
      const r = await aryeoRequest<{ data?: AryeoOrder[]; meta?: { last_page?: number } }>("/orders", { query: { include: "customer", page, per_page: 50 } });
      out.push(...(r?.data ?? []));
      if (!r?.meta?.last_page || page >= r.meta.last_page) break;
    }
    return out;
  },
  getAppointment: (id: string) =>
    aryeoRequest<{ data: unknown }>(`/appointments/${id}`, { query: { include: "users,order" } }).then((r) => asAppointment(r.data)),
  appointmentHasConflicts: (id: string, teamMemberId: string, minutes: number) =>
    aryeoRequest<{ has_conflicts?: boolean; data?: { has_conflicts?: boolean } }>(`/appointments/${id}/availability`, { query: { assignee_id: teamMemberId, duration: minutes } })
      .then((r) => (r?.has_conflicts ?? r?.data?.has_conflicts) === true),
  /** One ET day's starts for the given creatives, with who is free at each. */
  timeslotsFor: async (q: { date: string; durationMin: number; teamMemberIds: string[]; interval?: number }): Promise<AryeoTimeslot[]> => {
    const userFilter: Record<string, string> = {};
    q.teamMemberIds.forEach((id, i) => { userFilter[`filter[user_ids][${i}]`] = id; });
    const r = await aryeoRequest<{ data?: { start_at?: string; end_at?: string; users?: { id?: string }[] }[] }>("/scheduling/available-timeslots", {
      query: { timezone: "America/New_York", interval: q.interval ?? 30, duration: q.durationMin, date: q.date, ...userFilter },
    });
    return (r?.data ?? [])
      .filter((s): s is typeof s & { start_at: string } => !!s.start_at)
      .map((s) => ({ startAt: s.start_at, endAt: s.end_at ?? null, userIds: Array.isArray(s.users) ? s.users.map((u) => u.id).filter((x): x is string => !!x) : null }));
  },

  // ---- writes (a permit each; one attempt each; never retried here) ----
  createAddress: async (permit: HubWritePermit, body: AryeoAddressWrite): Promise<{ id: string }> => {
    checkPermit(permit, "addresses.create");
    const r = await aryeoRequest<{ data?: { id?: string } }>("/addresses", { method: "POST", body, timeoutMs: WRITE_TIMEOUT_MS });
    if (!r?.data?.id) throw new AryeoError("Aryeo created no address id.", 502, r);
    return { id: r.data.id };
  },
  patchAddress: async (permit: HubWritePermit, id: string, body: AryeoAddressWrite): Promise<AryeoAddressRead | null> => {
    checkPermit(permit, "addresses.patch");
    const r = await aryeoRequest<{ data?: AryeoAddressRead }>(`/addresses/${id}`, { method: "PATCH", body, timeoutMs: WRITE_TIMEOUT_MS });
    return r?.data ?? null;
  },
  createOrder: async (permit: HubWritePermit, body: { customer_id: string; address_id: string; variantId: string; internal_notes: string }): Promise<{ id: string; number: number | null; itemIds: string[] }> => {
    checkPermit(permit, "orders.create");
    const r = await aryeoRequest<{ data?: AryeoOrder }>("/orders", {
      method: "POST",
      timeoutMs: WRITE_TIMEOUT_MS,
      body: {
        customer_id: body.customer_id,
        address_id: body.address_id,
        product_items: [{ variant_id: body.variantId, quantity: 1 }],
        internal_notes: body.internal_notes,
        // Customer AND creator notifications — always off; see the header.
        notify: false,
      },
    });
    if (!r?.data?.id) throw new AryeoError("Aryeo created no order id.", 502, r);
    return { id: r.data.id, number: r.data.number ?? null, itemIds: (r.data.items ?? []).map((i) => i.id).filter((x): x is string => !!x) };
  },
  storeAppointment: async (permit: HubWritePermit, body: { order_id: string; start: Date; end: Date; teamMemberId: string; itemIds: string[]; notifyCompany: boolean }): Promise<AryeoBookedAppointment> => {
    checkPermit(permit, "appointments.store");
    const r = await aryeoRequest<{ data?: unknown }>("/appointments/store", {
      method: "POST",
      timeoutMs: WRITE_TIMEOUT_MS,
      body: {
        order_id: body.order_id,
        start_at: isoZ(body.start),
        end_at: isoZ(body.end),
        company_team_member_ids: [body.teamMemberId],
        ...(body.itemIds.length ? { item_ids: body.itemIds } : {}),
        notify: false,
        notifyCompany: body.notifyCompany,
        notifyCustomer: false,
      },
    });
    const appt = asAppointment(r?.data);
    if (!appt.id) throw new AryeoError("Aryeo stored no appointment id.", 502, r);
    return appt;
  },
  cancelAppointment: async (permit: HubWritePermit, id: string): Promise<AryeoBookedAppointment> => {
    checkPermit(permit, "appointments.cancel");
    const r = await aryeoRequest<{ data?: unknown }>(`/appointments/${id}/cancel`, { method: "PUT", body: { notify: false }, timeoutMs: WRITE_TIMEOUT_MS });
    return asAppointment(r?.data);
  },
  rescheduleAppointment: async (permit: HubWritePermit, id: string, start: Date, end: Date): Promise<AryeoBookedAppointment> => {
    checkPermit(permit, "appointments.reschedule");
    const r = await aryeoRequest<{ data?: unknown }>(`/appointments/${id}/reschedule`, { method: "PUT", body: { start_at: isoZ(start), end_at: isoZ(end), notify: false }, timeoutMs: WRITE_TIMEOUT_MS });
    return asAppointment(r?.data);
  },
};

// USER id → COMPANY_TEAM_MEMBER id. The timeslot and appointment endpoints
// answer in USER ids; product assignment and the appointment store speak
// team-member ids (Phase 0). Cached a minute, like the provider roster.
let tmByUserCache: { at: number; map: Map<string, string> } | null = null;
export async function teamMemberIdByUserId(): Promise<Map<string, string>> {
  if (tmByUserCache && Date.now() - tmByUserCache.at < PROVIDER_TTL_MS) return tmByUserCache.map;
  const team = await Aryeo.companyTeamMembers();
  const map = new Map<string, string>();
  for (const t of team) if (t.id && t.company_user?.id) map.set(t.company_user.id, t.id);
  tmByUserCache = { at: Date.now(), map };
  return map;
}
/** Drop the user→team-member cache — for a drill that changes the roster. */
export function resetTeamMemberCache(): void {
  tmByUserCache = null;
}

// ---------------------------------------------------------------------------
// Aryeo payload shapes (verified against the live v1 API). Money amounts are
// always integer cents. customer/items/appointments embed via ?include=.
// ---------------------------------------------------------------------------
// The customer GROUP as Aryeo serialises it — on an order's `customer`, and as
// the whole body of a flat CUSTOMER webhook (verified against stored payloads).
// Exported because upsertAryeoCustomerClient takes one straight off the wire.
export interface AryeoCustomer {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
  office_name?: string;
  license_number?: string;
  internal_notes?: string;
  avatar_url?: string | null; // the agent's headshot (Zillow-synced on ~64 customers)
}
interface AryeoAddress {
  /** CP-04/CP-05: the Address record's own id — what PATCH /addresses/{id}
   *  and POST /orders' address_id take. Aryeo has always sent it; nothing
   *  here read it until the hub started writing addresses. */
  id?: string;
  street_number?: string;
  street_name?: string;
  unit_number?: string | null;
  city?: string;
  state_or_province?: string;
  postal_code?: string;
  unparsed_address?: string;
  latitude?: number;
  longitude?: number;
}
export interface AryeoImage {
  id?: string;
  caption?: string | null;
  index?: number;
  filename?: string;
  thumbnail_url?: string;
  large_url?: string;
  original_url?: string;
  display_in_gallery?: boolean;
}
/** The size BAND the client picked when ordering. It rides on the order/
 *  appointment LINE ITEMS as the variant subtitle — "2,000-2,999 Sq. Ft." —
 *  and it is the real source: 80% of orders carry one, against 7 of 1,701
 *  listings with an exact figure (measured Sep 3 2026).
 *
 *  Formatting is not consistent across the catalogue: separators are "-" or
 *  " - ", thousands commas come and go, and the unit appears as "Sq. Ft.",
 *  "Sq.Ft.", "sq. Ft." and "Sq. Ft" — so match loosely and read the numbers. */
const SQFT_BAND_RE = /([\d][\d,]*)\s*[-–—]\s*([\d][\d,]*)\s*sq\.?\s*ft/i;

export type SqftBand = { text: string; low: number; high: number };

export function parseSqftBand(subtitle: string | null | undefined): SqftBand | null {
  const m = SQFT_BAND_RE.exec(subtitle ?? "");
  if (!m) return null;
  const low = Number(m[1].replace(/,/g, ""));
  const high = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= 0 || high > 60_000 || high < low) return null;
  // A band wider than this is a catch-all price bracket ("0-6500 Sq. Ft."),
  // not a statement about the house — sizing a photo budget off its top would
  // hand a 1,500 sq ft home the 70-85 range. Treat it as no size at all.
  if (high - low > 3000) return null;
  return { text: (subtitle ?? "").trim().slice(0, 60), low, high };
}

/** The band on an order's items, if any line carries one. */
export function orderSqftBand(items: AryeoOrderItem[] | null | undefined): SqftBand | null {
  for (const it of items ?? []) {
    const band = parseSqftBand(it.sub_title ?? it.subtitle);
    if (band) return band;
  }
  return null;
}

/** The square footage to SIZE THE CULLING TIER on.
 *
 *  Preference: an exact figure on the listing, else the top of the ordered
 *  band. The top, not the midpoint: the tiers are "≤ X" thresholds, so the
 *  largest the home can be is the only value guaranteed to land it in a tier
 *  big enough — and under-budgeting is the harmful error here, because it
 *  flags a photographer for shooting what the house actually needed. */
export function sqftOf(order: { listing?: AryeoListing | null; items?: AryeoOrderItem[] | null }): number | null {
  const exact = order.listing?.building?.square_feet;
  if (exact != null) {
    const n = Math.round(Number(exact));
    if (Number.isFinite(n) && n > 0 && n < 100_000) return n;
  }
  return orderSqftBand(order.items)?.high ?? null;
}

export interface AryeoListing {
  id?: string;
  address?: AryeoAddress;
  /** Verified against the live API (Sep 3 2026): the size fields sit on
   *  `building`, NOT on the listing root. The old root-level `square_feet`
   *  never existed, so the culling tiers had nothing to size a home on and
   *  every property fell to the smallest range. */
  building?: {
    square_feet?: number | null;
    bedrooms?: number | null;
    bathrooms?: number | null;
    year_built?: number | null;
  };
  delivery_status?: string; // DELIVERED | UNDELIVERED
  thumbnail_url?: string;
  large_thumbnail_url?: string;
  is_showcasable?: boolean;
  images?: AryeoImage[];
  videos?: unknown[];
  floor_plans?: unknown[];
  interactive_content?: unknown[];
  files?: unknown[];
  /** The orders this listing belongs to — only present with `include=orders`
   *  (verified live Sep 16 2026; `include=order` is rejected). The reverse
   *  link the LISTING webhook needs when no project carries the listing id. */
  orders?: { id?: string; number?: number }[];
}

export interface AryeoProductVariant {
  id?: string;
  title?: string;
  price_amount?: number; // cents
  duration?: number;
}
export interface AryeoProduct {
  id?: string;
  title?: string;
  type?: string; // MAIN | ADDON
  active?: boolean;
  is_serviceable?: boolean; // Aryeo's OWN shoot-service flag (Jordan, Aug 24)
  is_twilight?: boolean;
  description?: string;
  categories?: { title?: string }[];
  tags?: { name?: string; title?: string }[];
  variants?: AryeoProductVariant[];
  /** PER-PRODUCT VIDEOGRAPHER ASSIGNMENT (Jordan, Sep 21 2026). Present only
   *  when the read asks for `include=providers`. Each entry carries a
   *  COMPANY_TEAM_MEMBER id and nothing else — see productProviders(). */
  providers?: { id?: string }[];
}

export interface AryeoCustomerUser {
  id?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  agent_company_name?: string;
  agent_license_number?: string;
  internal_notes?: string;
  avatar_url?: string | null;
}

export interface AryeoTag {
  id?: string;
  name?: string;
  slug?: string;
  color?: string;
  font_color?: string;
}

export interface AryeoActivity {
  id?: string;
  name?: string; // e.g. APPOINTMENT_SCHEDULED, ORDER_MEDIA_DOWNLOADED
  description?: string;
  occurred_at?: string;
  target_label?: string | null;
  target_url?: string | null;
  source?: string;
  system_activity?: boolean;
}

export interface AryeoUser {
  id?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  avatar_url?: string;
  is_super?: boolean;
  internal_notes?: string;
  /** "active" | "inactive" — live on /company-team-members.company_user. Sarah
   *  Anne is inactive and still returns bookable days, so any picker has to
   *  read this as well as is_service_provider (Phase 0, Sep 21 2026). */
  status?: string;
}

export interface AryeoCompanyTeamMember {
  id?: string; // referenced by appointment.initial_assigned_company_team_member_id
  is_service_provider?: boolean;
  calendar_color?: string;
  external_id?: string;
  company_user?: AryeoUser;
}

export interface AryeoGroup {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
  currency?: string;
  logo_url?: string;
  order_page_url?: string;
  timezone?: string;
}
interface AryeoAppointment {
  id?: string;
  start_at?: string | null;
  end_at?: string | null;
  duration?: number; // minutes
  title?: string;
  description?: string;
  status?: string; // SCHEDULED | CANCELED | UNSCHEDULED
  preference_type?: string;
  requires_confirmation?: boolean;
  can_cancel?: boolean;
  can_reschedule?: boolean;
  rescheduled_at?: string | null;
  postponed_at?: string | null;
  previous_start_at?: string | null;
  initial_assigned_company_team_member_id?: string | null;
  users?: AryeoUser[]; // assigned team members (via ?include=users)
  order?: { id?: string };
}
interface AryeoOrderItem {
  id?: string;
  title?: string;
  subtitle?: string;
  sub_title?: string;
  description?: string;
  quantity?: number;
  is_canceled?: boolean;
  amount?: number; // line total in cents (list price)
  gross_total_amount?: number; // cents, after discounts
}
interface AryeoOrder {
  id?: string;
  number?: number;
  /** Team-only notes. CP-04 writes its booking marker here (hub-session:<id>:<n>). */
  internal_notes?: string | null;
  title?: string;
  fulfillment_status?: string; // FULFILLED | UNFULFILLED
  payment_status?: string; // PAID | UNPAID | PARTIALLY_PAID
  order_status?: string;
  total_amount?: number; // cents
  balance_amount?: number; // cents owed
  invoice_url?: string | null;
  payment_url?: string | null;
  currency?: string;
  created_at?: string;
  fulfilled_at?: string | null;
  address?: AryeoAddress;
  customer?: AryeoCustomer;
  items?: AryeoOrderItem[];
  appointments?: AryeoAppointment[];
  listing?: AryeoListing;
}

// ---- field helpers --------------------------------------------------------
// Aryeo monetary amounts are integer cents.
function money(cents: number | null | undefined): number | null {
  return typeof cents === "number" ? cents / 100 : null;
}

export const UNKNOWN_CUSTOMER_NAME = "Unknown customer (no customer on the Aryeo order)";

function customerName(c?: AryeoCustomer): string {
  return c?.name || c?.email || "Unknown client";
}

function addressTitle(order: AryeoOrder): string {
  const a = order.address;
  if (a?.unparsed_address) return a.unparsed_address;
  const street = [a?.street_number, a?.street_name].filter(Boolean).join(" ").trim();
  const parts = [street, a?.city, a?.state_or_province].filter(Boolean);
  if (parts.length) return parts.join(", ");
  return order.title || `Order #${order.number ?? ""}`.trim();
}

const TYPE_KEYWORDS: [RegExp, DeliverableType][] = [
  [/floor\s?plan/i, "FLOORPLAN"],
  // 3D tours: classify by brand FIRST. "Zillow [Showcase] 3D Tour" must beat the
  // generic "3d tour" rule. Matterport only when explicitly named; a plain
  // "3D Tour" defaults to Zillow (that's our standard product).
  [/zillow/i, "ZILLOW_3D"],
  [/matterport/i, "MATTERPORT_3D"],
  [/3d tour|3-d tour|3d virtual|interactive tour/i, "ZILLOW_3D"],
  [/twilight|dusk/i, "TWILIGHT"],
  [/drone|aerial/i, "DRONE"],
  [/virtual stag/i, "VIRTUAL_STAGING"],
  [/reel|social/i, "SOCIAL_REEL"],
  [/headshot|portrait/i, "HEADSHOT"],
  [/video|walkthrough|cinematic/i, "VIDEO"],
  [/photo|image|hdr/i, "PHOTOS"],
];

export function deliverableType(label: string): DeliverableType {
  for (const [re, t] of TYPE_KEYWORDS) if (re.test(label)) return t;
  return "OTHER";
}

// Component detection over the full product text (title + subtitle + description).
// Order matters only for which standard label we attach; types are de-duped.
const COMPONENT_RULES: [RegExp, DeliverableType, string][] = [
  [/photo|photograph|\bimage|hdr/i, "PHOTOS", "Photos"],
  [/twilight|dusk/i, "TWILIGHT", "Twilight"],
  [/drone|aerial/i, "DRONE", "Drone / Aerial"],
  [/floor\s?plan/i, "FLOORPLAN", "Floor Plan"],
  [/matterport/i, "MATTERPORT_3D", "Matterport 3D"],
  [/zillow|3d tour|3-d tour|interactive tour|3d virtual/i, "ZILLOW_3D", "Zillow 3D Tour"],
  [/virtual stag/i, "VIRTUAL_STAGING", "Virtual Staging"],
  [/reel|social media|vertical video/i, "SOCIAL_REEL", "Social Reel"],
  [/headshot|portrait/i, "HEADSHOT", "Headshot"],
  [/video|cinematic|walkthrough/i, "VIDEO", "Video"],
];

// One order line → one row per media type. `type` is the CATEGORY the
// pipeline tracks; the last two fields are the PRODUCT IDENTITY the category
// discards (Sep 2 2026 — "Standard Reel with Agent Intro" was landing as a
// SOCIAL_REEL labelled "Social Reel", and every downstream surface read the
// wrong video type off it). Both are written to Deliverable at sync.
export type ParsedDeliverable = {
  type: DeliverableType;
  label: string;
  quantity: number;
  /** the Aryeo order-item title this row came from, verbatim */
  productTitle: string;
  /** VIDEO_STYLE key on VIDEO / SOCIAL_REEL rows (drone video included), null elsewhere */
  videoStyle: VideoStyleKey | null;
  /** Settings → Products calls the product an ADDON — a merged row keeps the MAIN product's title (stripped before rows are written) */
  addon?: boolean;
};

// ---------------------------------------------------------------------------
// VIDEO STYLE — the Style Guide type a video row is cut as (VIDEO_TYPES in
// src/lib/videoStyles.ts), keyed STABLE so the database never stores a display
// name. Shared contract with every reader — editor brief "Edit type", cuts to
// deliver, the upload portal's brief shape, the Style Guide reference: these
// six keys and nothing else. `premium_cinematic` has no Style Guide entry yet;
// it is the premium HORIZONTAL video (Premium Cinematic Video, Premium
// Package's video) — readers fall back to the premium-reel treatment until the
// guide grows one.
// ---------------------------------------------------------------------------
export const VIDEO_STYLE = {
  standard_reel: "Standard Reel",
  standard_reel_agent_intro: "Standard Reel with Agent Intro",
  standard_cinematic: "Standard Cinematic Video",
  personal_branding: "Personal Branding Reel",
  premium_social_reel: "Premium Social Media Reel",
  premium_cinematic: "Premium Cinematic Video",
} as const;
export type VideoStyleKey = keyof typeof VIDEO_STYLE;
export const isVideoStyleKey = (s: unknown): s is VideoStyleKey => typeof s === "string" && s in VIDEO_STYLE;

// Mapping-level video kinds (DRONE_VIDEO is translated to a VIDEO row at emit).
const VIDEOISH = new Set<string>(["VIDEO", "SOCIAL_REEL", "DRONE_VIDEO"]);

// An agent-on-camera line: the product itself ("Standard Reel with Agent
// Intro", "Photography and Standard Reel w/ Agent intro") or the add-on that
// upgrades a plain standard reel ("Agent on Camera", "Agent on Camera Intro",
// "Agent Outro Add-on (Standard Reel)"). A NEGATION is not an order for one —
// "Premium Social Media Reel (No Agent on camera or Exteriors)" is live data.
// (pipeline.ts keeps its own AGENT_INTRO_RE for the upload-portal step; this
// one also accepts "outro" and "w/ agent".)
const AGENT_INTRO_RE = /agent[-\s]+(on[-\s]+cam(era)?|intro|outro)|\bw\/\s*agent\b/i;
const NO_AGENT_RE = /\b(no|without)\s+agent\b/i;
export const isAgentIntroTitle = (title: string | null | undefined): boolean =>
  !!title && AGENT_INTRO_RE.test(title) && !NO_AGENT_RE.test(title);

/**
 * The style a video row is cut as. Precedence: the human-set Product.videoStyle
 * → the product's tier (personal_branding / premium / standard; when no tier
 * is known the name decides, same tests the label engines use) → the name.
 * Inside a tier the ROW TYPE decides reel vs cinematic: a SOCIAL_REEL is the
 * vertical reel, a VIDEO row (drone video included) is the horizontal
 * cinematic video — the two shapes the Style Guide keeps separate types for.
 * "Cinematic" / "horizontal" in the name forces cinematic either way; an
 * agent-on-camera name forces the agent-intro type on a standard product
 * (the intro script is the thing the brief must demand). Non-video: null.
 */
export function resolveVideoStyle(
  type: string,
  opts: { style?: string | null; tier?: string | null; title?: string | null },
): VideoStyleKey | null {
  if (!VIDEOISH.has(type)) return null;
  if (isVideoStyleKey(opts.style)) return opts.style;
  const title = opts.title ?? "";
  const tier =
    opts.tier ?? (MONTHLY_PLAN_RE.test(title) ? "personal_branding" : isPremiumProduct(title) ? "premium" : "standard");
  if (tier === "personal_branding") return "personal_branding";
  const cinematic = type !== "SOCIAL_REEL" || /cinematic|horizontal/i.test(title);
  if (tier === "premium") return cinematic ? "premium_cinematic" : "premium_social_reel";
  if (isAgentIntroTitle(title)) return "standard_reel_agent_intro";
  return cinematic ? "standard_cinematic" : "standard_reel";
}

// Specificity of a style, for the dedupe tie-break below (a plain standard
// reel must lose to the agent-intro reel bought on the same order).
const STYLE_RANK: Record<string, number> = {
  personal_branding: 4, premium_cinematic: 3, premium_social_reel: 3,
  standard_reel_agent_intro: 2, standard_cinematic: 1, standard_reel: 1,
};

// May a video row be LABELLED with its verbatim product title? Only when the
// label-reading engines — projectStatus.videoTier() (PREMIUM_VIDEO_RE +
// STANDARD_VETO_RE, mirrored here because that module is server-only and
// imports pipeline), isMonthlyContentJob(), and dedupe's rank — would read
// the SAME tier off the title that the human mapping says. Otherwise the
// tier-generic label stays, so an SLA or editor lane can never flip on a
// name: "STR PRO BUNDLE" is mapped premium but doesn't say so; "STR Luxury
// Cinematic Video Tour" is mapped standard but reads premium.
const LABEL_PREMIUM_RE = /premium|influencer|cinematic|luxury|signature|elite|flagship/i;
const LABEL_STANDARD_VETO_RE = /\bstandard\b/i;
function labelReadsTier(title: string, tier: "standard" | "premium" | "personal_branding"): boolean {
  const monthly = MONTHLY_PLAN_RE.test(title);
  const readsPremium = LABEL_PREMIUM_RE.test(title) && !LABEL_STANDARD_VETO_RE.test(title);
  if (tier === "personal_branding") return monthly;
  if (tier === "premium") return isPremiumProduct(title) && !monthly;
  return !readsPremium && !monthly;
}

// Collapse a project's parsed deliverables to ONE per type. Several order items
// can each mention the same deliverable in their descriptions (e.g. a Zillow
// add-on and a package both list "photos" + "floor plan", and an extra item like
// "Missing Office Photo" adds another photos) — without this they'd show up two
// or three times. One deliverable per type is what we QA/deliver/track.
//
// IDENTITY RULE (Sep 2 2026): the dedupe key stays the TYPE — reconcile matches
// rows by type and updates labels IN PLACE, so a row's id (and with it every
// cut key `${deliverableId}:${slot}`, upload, verdict and note) survives a
// relabel. When two lines land on one type, label + productTitle + videoStyle
// travel TOGETHER from the line whose label ranks highest (they describe one
// product). `itemTitles` — every live line on the order, when the caller has
// them — lets the order-level upgrade below see an add-on whose own mapping
// produces no row.
export function dedupeParsedDeliverables(parsed: ParsedDeliverable[], itemTitles: string[] = []): ParsedDeliverable[] {
  const byType = new Map<DeliverableType, ParsedDeliverable>();
  // How much a label TELLS US, so first-wins can't erase the signal: a premium
  // or monthly-plan label must survive a generic "Video" from another line
  // item on the same order (audit: a standard reel add-on was stripping the
  // premium label off the package's reel).
  // Same premium semantics as isPremiumProduct (the \bstandard\b veto): a raw
  // title like "Standard Listing Reel w/ Premium Song Licensing" must not
  // outrank the mapped standard label. Monthly ranks highest — it carries the
  // SLA + routing signal, which a premium word alone can't restore.
  const rank = (label: string | null | undefined) =>
    MONTHLY_PLAN_RE.test(label ?? "") ? 3 : isPremiumProduct(label ?? "") ? 2 : 1;
  // Tie-breaks inside one label rank, in order: the more specific video style
  // ("Photography and Standard Reel" and "Standard Reel with Agent Intro" both
  // rank 1 — the agent-intro one must name the row), then the MAIN product
  // over an add-on (a package's photos row says the package, not "Same Day
  // Photo Delivery"), then first on the order — the pre-existing behaviour.
  const score = (d: ParsedDeliverable) =>
    rank(d.label) * 100 + (STYLE_RANK[d.videoStyle ?? ""] ?? 0) * 10 + (d.addon ? 0 : 1);
  for (const d of parsed) {
    const ex = byType.get(d.type);
    if (!ex) byType.set(d.type, { ...d });
    else {
      ex.quantity = Math.max(ex.quantity, d.quantity);
      if (score(d) > score(ex)) {
        ex.label = d.label;
        ex.productTitle = d.productTitle;
        ex.videoStyle = d.videoStyle;
        ex.addon = d.addon;
      }
    }
  }
  // ORDER-LEVEL signal only the whole order can answer: an "Agent on Camera"
  // add-on bought beside a plain standard reel makes THAT reel the agent-intro
  // type (Jordan: agent-intro reels get an intro script + notes; standard
  // reels get no script). Premium and monthly rows are untouched. Seen through
  // the lines' titles — so the add-on's mapping must keep producing a row
  // (today: OTHER) unless the caller passes itemTitles.
  const agentAddon = [...itemTitles, ...parsed.map((d) => d.productTitle)].some(isAgentIntroTitle);
  return [...byType.values()].map(({ addon: _addon, ...row }) => ({
    ...row,
    videoStyle: agentAddon && row.videoStyle === "standard_reel" ? "standard_reel_agent_intro" : row.videoStyle,
  }));
}

// Virtual / AI add-ons creatives are NOT paid a percentage on (no work on a
// shoot): virtual twilight/staging/declutter/renovation, AI renderings, etc.
const PAY_EXCLUDED_RE =
  /\bvirtual\b|\bai\b|a\.i\.|\brender(ing|ings)?\b|\bdigital (stag|declutter|twilight)/i;

export function isPayExcludedItem(item: { title?: string; subtitle?: string; sub_title?: string; description?: string }): boolean {
  const text = `${item.title ?? ""} ${item.sub_title ?? item.subtitle ?? ""}`;
  return PAY_EXCLUDED_RE.test(text);
}

// The eligible services invoice for creative pay: sum of non-canceled order
// items in DOLLARS, excluding virtual/AI add-ons. This is what the shoot-pay
// percentage is applied to. Capped at the order total when provided: item list
// prices can sum ABOVE a discounted order's total, and the % must never be paid
// on money the client didn't actually pay (audit crack #18 — 205 orders).
export function payableInvoiceFromItems(items: AryeoOrderItem[], orderTotalDollars?: number | null): number {
  const cents = items
    .filter((it) => !it.is_canceled && !isPayExcludedItem(it))
    .reduce((sum, it) => sum + (typeof it.amount === "number" ? it.amount : 0), 0);
  const dollars = Math.round(cents) / 100;
  if (orderTotalDollars != null && orderTotalDollars >= 0 && dollars > orderTotalDollars) return orderTotalDollars;
  return dollars;
}

// Friendly deliverable label per type (for the explicit product map below).
const TYPE_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Drone / Aerial", FLOORPLAN: "Floor Plan",
  MATTERPORT_3D: "Matterport 3D", ZILLOW_3D: "Zillow 3D Tour", TWILIGHT: "Twilight",
  VIRTUAL_STAGING: "Virtual Staging", SOCIAL_REEL: "Social Reel", VIDEO: "Video",
  HEADSHOT: "Headshots", OTHER: "Item",
};

// AUTHORITATIVE per-product deliverable map — built by reading each catalog
// product's real description (Jun 2026). This is the source of truth; the
// description parser below is only a fallback for products not listed here.
// Key insight: premium bundles include BOTH an MLS/cinematic Video AND a Social
// Reel; standard/cinematic "video" products are Video; "reel" products are a reel.
const PRODUCT_DELIVERABLES_RAW: [string, DeliverableType[]][] = [
  ["BRONZE PACKAGE - Simple Solutions for Straightforward Listings", ["PHOTOS"]],
  ["BRONZE PACKAGE - Two Separate Appointments", ["PHOTOS"]],
  ["STR Photography", ["PHOTOS"]],
  ["STR Photography - Interior Only Photos", ["PHOTOS"]],
  ["STR Exterior Only Photography With Detail Shots", ["PHOTOS"]],
  ["Community Photography (Ground Photos)", ["PHOTOS"]],
  ["Detail Shots", ["PHOTOS"]],
  ["Twilight Photography", ["TWILIGHT"]],
  ["STR Twilight Photography", ["TWILIGHT"]],
  ["Virtual Twilight", ["TWILIGHT"]],
  ["Virtual Staging", ["VIRTUAL_STAGING"]],
  ["Virtual Decluttering", ["VIRTUAL_STAGING"]],
  ["2D Floor Plan", ["FLOORPLAN"]],
  ["Matterport 3D Tour", ["MATTERPORT_3D"]],
  // NO FLOORPLAN. Zillow Showcase generates its own floor plan as part of the
  // tour — nobody shoots or orders one. OUR floor plan is the measured CubiCasa
  // product, sold on its own "2D Floor Plan" line. See ZILLOW_OWN_FLOORPLAN
  // below, which enforces this against the hand-set map too (Jordan, Sep 2 2026:
  // 2410 E Clementine St demanded a floor-plan tick nobody ordered).
  ["Zillow Showcase 3D Tour Add-on", ["ZILLOW_3D"]],
  ["Drone Aerial Photography", ["DRONE"]],
  ["STR Drone Aerial Photography", ["DRONE"]],
  ["Drone Photography", ["DRONE"]],
  ["Drone Videography", ["DRONE", "VIDEO"]],
  ["Lot Lines", ["OTHER"]],
  ["Agent on Camera Intro", ["SOCIAL_REEL"]],
  // Video products
  ["Standard Cinematic Video", ["VIDEO"]],
  ["Premium Cinematic Video", ["VIDEO", "DRONE"]],
  ["STR Luxury Cinematic Video Tour (with drone video)", ["VIDEO", "DRONE"]],
  ["Video Starter - 2HR Session", ["VIDEO"]],
  ["Video Accelerator - 4HR Session", ["VIDEO"]],
  ["VIDEO PRO - 8HR Session", ["VIDEO", "PHOTOS"]],
  // Reel products
  ["Standard Video Highlight Reel", ["SOCIAL_REEL"]],
  ["Standard Reel with Agent Intro", ["SOCIAL_REEL"]],
  ["Premium Social Media Reel", ["SOCIAL_REEL"]],
  ["Photography and Standard Reel", ["PHOTOS", "SOCIAL_REEL"]],
  ["Photography and Standard Reel w/ Agent intro", ["PHOTOS", "SOCIAL_REEL"]],
  ["SOCIAL MEDIA INFLUENCER - Dominate Social Media, Build Your Brand.", ["PHOTOS", "SOCIAL_REEL", "DRONE", "FLOORPLAN"]],
  // Combos / land
  ["Deluxe Land Only Package - Drone Photo and Video", ["DRONE", "VIDEO"]],
  ["STR Photography & Drone Aerial Photography", ["PHOTOS", "DRONE"]],
  ["STR Photography | Drone Aerial Photos | Real Twilight", ["PHOTOS", "DRONE", "TWILIGHT"]],
  ["STR Photography | Video | Drone Aerial Photos | Real Twilight", ["PHOTOS", "VIDEO", "DRONE", "TWILIGHT"]],
  // Bundles
  ["SILVER BUNDLE - Effortless Essentials for Everyday Listings", ["PHOTOS", "DRONE", "FLOORPLAN"]],
  // Photos + drone photos + 2D floor plan, NO video — the keyword parser was
  // minting a phantom VIDEO off an upsell mention in the description (Barb
  // Matyszczak / 1066 Hackney Cir, Aug 17 — Jordan: "didn't have video").
  ["Essentials Package", ["PHOTOS", "DRONE", "FLOORPLAN"]],
  ["AERIAL BUNDLE - Highlight Your Listing's Best Features", ["PHOTOS", "DRONE", "FLOORPLAN", "VIDEO"]],
  ["STR GOLD BUNDLE", ["PHOTOS", "VIDEO", "DRONE"]],
  ["STR PRO BUNDLE", ["PHOTOS", "VIDEO", "DRONE", "FLOORPLAN", "TWILIGHT"]],
  ["GOLD BUNDLE - Comprehensive Marketing Package", ["PHOTOS", "DRONE", "VIDEO", "FLOORPLAN"]],
  ["GOLD BUNDLE - Photography, Video, Drone, 2D Floor Plan, & More!", ["PHOTOS", "VIDEO", "SOCIAL_REEL", "DRONE", "FLOORPLAN"]],
  // "Zillow 3D Tour/Floor Plan" in these two names is ONE thing — the tour and
  // the floor plan Zillow derives from it. No separate measured floor plan is
  // ordered, so no FLOORPLAN row (the BASICS variant below, sold as "2D Floor
  // Plan", is the real CubiCasa one and keeps it).
  ["EVERYTHING BUNDLE - Photography, Video, Drone, Zillow 3D Tour/Floor Plan, & More!", ["PHOTOS", "VIDEO", "SOCIAL_REEL", "DRONE", "ZILLOW_3D"]],
  ["BASICS BUNDLE - Photography, Drone Photos, Zillow 3D Tour / Floor Plan", ["PHOTOS", "DRONE", "ZILLOW_3D", "TWILIGHT"]],
  ["BASICS BUNDLE - Photography, Drone Photos, 2D Floor Plan", ["PHOTOS", "DRONE", "FLOORPLAN", "TWILIGHT"]],
  ["DIAMOND BUNDLE - The Ultimate Real Estate Marketing Package", ["PHOTOS", "SOCIAL_REEL", "VIDEO", "DRONE", "FLOORPLAN"]],
  ["THE PLATINUM BUNDLE - High-End Real Estate Marketing Package", ["PHOTOS", "VIDEO", "DRONE", "FLOORPLAN"]],
  ["REALTOUR PRO BUNDLE - Top Tier Luxury Marketing", ["PHOTOS", "SOCIAL_REEL", "VIDEO", "DRONE", "TWILIGHT", "FLOORPLAN"]],
];
const normProduct = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const PRODUCT_DELIVERABLES = new Map(PRODUCT_DELIVERABLES_RAW.map(([t, types]) => [normProduct(t), types]));

// Aryeo renames products with marketing suffixes — "Premium Social Media Reel
// - Most Popular" (Aug 18, 1337 Carolannes) missed the exact map and the
// keyword fallback stamped a generic "Social Reel", losing the premium tier.
// After an exact miss, accept the LONGEST map key that word-prefixes the title
// — but only when the leftover is pure fluff: a suffix that mentions media
// ("… - Now With Video!"), restricts scope ("… - Interior Only", "… No Drone"),
// or is a fee line ("… - Reschedule Fee") may change what's delivered, so fall
// through to the keyword parser instead of stamping the full product set.
const MEDIA_WORD_RE = /photo|video|reel|drone|aerial|floor|twilight|matterport|zillow|3d|tour|stag|headshot|portrait|virtual|cinematic/i;
const SUFFIX_VETO_RE = /\bonly\b|\bno\b|\bnot\b|\bwithout\b|\bfee\b|refund|cancel|reschedul/i;
let productKeysByLength: string[] | null = null;
function mappedTypesForTitle(title: string): DeliverableType[] | undefined {
  const norm = normProduct(title);
  const exact = PRODUCT_DELIVERABLES.get(norm);
  if (exact) return exact;
  productKeysByLength ??= [...PRODUCT_DELIVERABLES.keys()].sort((a, b) => b.length - a.length);
  for (const key of productKeysByLength) {
    if (!norm.startsWith(key + " ")) continue;
    const leftover = norm.slice(key.length + 1);
    if (!MEDIA_WORD_RE.test(leftover) && !SUFFIX_VETO_RE.test(leftover)) {
      return PRODUCT_DELIVERABLES.get(key);
    }
  }
  return bindByBaseName(title, norm, productKeysByLength, (k) => PRODUCT_DELIVERABLES.get(k));
}

// A discounted or renamed VARIANT of a product — "SOCIAL MEDIA INFLUENCER - AAP
// Discounted" beside the catalogue's "SOCIAL MEDIA INFLUENCER - Dominate Social
// Media, Build Your Brand." — shares the product's BASE NAME (the part before
// the first " - " in the raw title) but not its full title, so it started
// with neither map key, fell through to the keyword parser, derived only a
// reel, and the reconciler retired the photos, drone and floor plan the
// package really includes (47 Venuti Dr, Sep 2 catalogue audit). Bind on the
// base only when exactly ONE key owns it and the variant's own suffix is pure
// fluff (no media word, no scope/fee veto) — never on an ambiguous base.
function bindByBaseName<T>(rawTitle: string, norm: string, keys: string[], get: (k: string) => T | undefined): T | undefined {
  const rawBase = rawTitle.split(/\s+[-–—]\s+/)[0] ?? "";
  const base = normProduct(rawBase);
  if (!base || base === norm) return undefined;
  const leftover = norm.startsWith(base + " ") ? norm.slice(base.length + 1) : "";
  if (MEDIA_WORD_RE.test(leftover) || SUFFIX_VETO_RE.test(leftover)) return undefined;
  const owners = keys.filter((k) => k === base || k.startsWith(base + " "));
  return owners.length === 1 ? get(owners[0]) : undefined;
}

// Whether a product's reel/video is PREMIUM (→ Luma, 3–4 day turnaround) vs
// STANDARD (→ in-house Remar/Kim, 1–2 days). Premium is signalled by the product
// NAME: explicit Premium/Luxury products and the genuinely high-end tiers
// (Platinum, Diamond/Ultimate, RealTour Pro "Top Tier Luxury", Influencer).
//
// IMPORTANT: the generic tier bundles — Silver / Gold / Aerial / Basics /
// EVERYTHING / STR combos — include a STANDARD reel/video, NOT a premium one, so
// they must NOT match here. Anything explicitly named "Standard …" is never
// premium. (Per Jordan: the EVERYTHING bundle has no premium reels.)
function isPremiumProduct(name: string): boolean {
  const t = name.toLowerCase();
  if (/\bstandard\b/.test(t)) return false;
  return /\b(premium|luxury|platinum|diamond|influencer|ultimate|high[\s-]?end|top[\s-]?tier)\b/.test(t);
}

// Turn ONE ordered item into one or more deliverables. Uses the authoritative
// per-product map first (exact, hand-verified from descriptions); falls back to
// description parsing only for products not in the map.
// Aryeo line items → OrderItem rows. Keeps the product name EXACTLY as sold
// ("Standard Reel with Agent Intro", "GOLD BUNDLE …") and the real line total,
// which itemToDeliverables below deliberately discards when it maps a product
// down to the media types we have to capture.
export function orderItemRows(items: AryeoOrderItem[]): {
  aryeoId: string | null; title: string; quantity: number; amount: number; isCanceled: boolean;
}[] {
  return (items ?? [])
    .filter((it) => (it.title || it.sub_title || it.subtitle))
    .map((it) => ({
      aryeoId: it.id ?? null,
      title: (it.title || it.sub_title || it.subtitle || "Item").trim().slice(0, 200),
      quantity: it.quantity || 1,
      // gross_total_amount is after discounts and is the truer figure; fall back
      // to the list amount. Aryeo sends cents.
      amount: Math.round((it.gross_total_amount ?? it.amount ?? 0)) / 100,
      isCanceled: !!it.is_canceled,
    }));
}

/**
 * Deliverables implied by a STORED OrderItem row, which keeps only the product
 * title and quantity. The authoritative product map is keyed on the title, so
 * every catalogued product resolves exactly; unmapped one-offs fall through to
 * the keyword parser with less to go on than a live sync has.
 */
export function deliverablesForTitle(title: string, quantity = 1): ParsedDeliverable[] {
  return itemToDeliverables({ title, quantity } as AryeoOrderItem);
}

// ---------------------------------------------------------------------------
// MANUAL PRODUCT MAPPING — the authoritative override, set by a human on
// Settings → Products (Aug 24: descriptions kept minting phantom deliverables
// — a floor plan nobody ordered, a video on Faye's photo-only shoot — so the
// platform now trusts the hand-set category over every parser below).
// Loaded once per lambda (5-min TTL); sync entry points await the load.
// ---------------------------------------------------------------------------
// types may include the mapping-level pseudo-types DRONE_PHOTO / DRONE_VIDEO,
// translated to real deliverable rows at emit time.
export type ManualMapping = {
  types: string[];
  tier: "standard" | "premium" | "personal_branding" | null;
  addOn: boolean;
  addonTypes: Set<string>;
  videoQty: number | null;
  /** human-set VIDEO_STYLE key (Product.videoStyle); null = derive from tier + name */
  style: string | null;
  /** Product.type — MAIN | ADDON | LEGACY; an ADDON never names a merged row over the MAIN product */
  catalogType: string | null;
};
let MANUAL_MAP: Map<string, ManualMapping> | null = null;
let manualLoadedAt = 0;

export async function loadManualProductMap(force = false): Promise<void> {
  if (!force && MANUAL_MAP && Date.now() - manualLoadedAt < 300_000) return;
  try {
    const { prisma } = await import("@/lib/prisma");
    const rows = await prisma.product.findMany({
      where: { mediaTypes: { not: null } },
      select: { title: true, type: true, mediaTypes: true, videoTier: true, videoStyle: true, serviceKind: true, addonTypes: true, videoQuantity: true },
    });
    const map = new Map<string, ManualMapping>();
    for (const r of rows) {
      try {
        const types = JSON.parse(r.mediaTypes!) as string[];
        if (!Array.isArray(types)) continue;
        let addonList: string[] = [];
        try { addonList = r.addonTypes ? (JSON.parse(r.addonTypes) as string[]) : []; } catch { addonList = []; }
        map.set(normProduct(r.title), {
          types,
          tier: (r.videoTier as ManualMapping["tier"]) ?? null,
          addOn: r.serviceKind === "addon",
          addonTypes: new Set(addonList),
          videoQty: r.videoQuantity ?? null,
          style: r.videoStyle ?? null,
          catalogType: r.type ?? null,
        });
      } catch { /* one bad row must not break the map */ }
    }
    MANUAL_MAP = map;
    manualLoadedAt = Date.now();
  } catch { /* keep whatever map we had */ }
}

// Exact normalized-title hit, then the same suffix-tolerant prefix match the
// static map uses (marketing suffixes must not dodge a manual mapping either).
function manualMappingForTitle(title: string): ManualMapping | undefined {
  if (!MANUAL_MAP || MANUAL_MAP.size === 0) return undefined;
  const norm = normProduct(title);
  const exact = MANUAL_MAP.get(norm);
  if (exact) return exact;
  for (const key of [...MANUAL_MAP.keys()].sort((a, b) => b.length - a.length)) {
    if (!norm.startsWith(key + " ")) continue;
    const leftover = norm.slice(key.length + 1);
    if (!MEDIA_WORD_RE.test(leftover) && !SUFFIX_VETO_RE.test(leftover)) return MANUAL_MAP.get(key);
  }
  return bindByBaseName(title, norm, [...MANUAL_MAP.keys()], (k) => MANUAL_MAP!.get(k));
}

// Labels for manually-mapped products carry the tier signal every downstream
// engine reads from the label text: premium → "Premium <Type>"; personal
// branding keeps the plan TITLE (suffixed so MONTHLY_PLAN_RE always matches
// even when the product name itself doesn't say "monthly").
function manualLabel(m: ManualMapping, type: DeliverableType, title: string, singleVideo: boolean): string {
  const videoish = type === "VIDEO" || type === "SOCIAL_REEL";
  if (videoish && m.tier === "personal_branding") {
    return MONTHLY_PLAN_RE.test(title) ? title : `${title} · Monthly Content`;
  }
  // The real product name (Sep 2 2026 — "Standard Reel with Agent Intro" was
  // labelled "Social Reel", and the editor brief's Edit type read that): when
  // it is the ONLY video the product produces and the label-reading engines
  // agree with the mapping about its tier (labelReadsTier). Bundles with a
  // video AND a reel keep the tier-generic labels — the bundle name can't tell
  // the rows apart; productTitle carries it.
  if (videoish && singleVideo && labelReadsTier(title, m.tier ?? "standard")) return title;
  if (videoish && m.tier === "premium") return `Premium ${TYPE_LABEL[type]}`;
  return TYPE_LABEL[type] ?? title;
}

// ---------------------------------------------------------------------------
// ZILLOW_OWN_FLOORPLAN — a Zillow Showcase tour is not a floor-plan order.
//
// Jordan, Sep 2 2026: "The Zillow Showcase 3D Tour does provide floor plans,
// but we do floor plans with measurements separately with CubiCasa." Zillow
// makes its floor plan from the tour scan; there is nothing to shoot, nothing
// to upload and nothing to send CubiCasa. A FLOORPLAN row off a Zillow line
// therefore puts a phantom check on the photographer's upload portal and a
// phantom missing item on Kyle's /ops QC card (2410 E Clementine St).
//
// This runs on EVERY branch below — including the hand-set Settings → Products
// map, which normally outranks the parsers. That is deliberate: the mapping
// row for "Zillow Showcase 3D Tour Add-on" still ticks Floor plan in the
// database, and only a human on /settings/products can untick it. The veto is
// scoped to ONE order line, so a job that also buys a real "2D Floor Plan"
// line keeps its floor plan from that line.
//
// The escape hatch is the product name itself: a line that explicitly sells a
// 2D / measured / CubiCasa floor plan keeps it even alongside a Zillow tour.
const MEASURED_FLOORPLAN_RE = /\b2d\s*floor[\s-]?plan|cubicasa|floor[\s-]?plans?\s*(with|w\/)\s*measur/i;

function withoutZillowFloorPlan(title: string, parsed: ParsedDeliverable[]): ParsedDeliverable[] {
  if (!parsed.some((d) => d.type === "ZILLOW_3D")) return parsed;
  if (MEASURED_FLOORPLAN_RE.test(title)) return parsed;
  return parsed.filter((d) => d.type !== "FLOORPLAN");
}

// ---------------------------------------------------------------------------
// DRONE ON A VIDEO-ONLY LINE IS FOOTAGE, NOT STILLS.
//
// Jordan, Sep 18 2026: "On Brie's shoot she ordered drone videography but the
// hub is considering it as drone photos and is expecting photos to be in Aryeo
// when the order never had photos."
//
// 5 Raymond Cir, Downingtown. Her order is Drone Videography + 2D Floor Plan +
// Standard Video Highlight Reel — no photography of any kind. The job reads
// `expected: ["Floor plan","Video","Photos"]` and has been missing Photos ever
// since, because a DRONE row rides the PHOTOS lane (projectStatus's
// CATEGORY_KEYWORDS put /drone|aerial/ there, correctly: drone stills land in
// the client's photo gallery). Nothing can ever clear it. Two other jobs are in
// the same state — 108 Sheeder Rd and 632 Greenridge Rd.
//
// THE CAUSE IS A MAPPING, NOT A PARSER. Settings → Products has "Standard Video
// Highlight Reel" down as ["SOCIAL_REEL","DRONE_PHOTO"], and "Drone Videography"
// itself is already mapped correctly to DRONE_VIDEO — so the phantom came off
// the REEL line, not the drone line. "Premium Cinematic Video" and "STR Luxury
// Cinematic Video Tour (with drone video)" carry the same DRONE_PHOTO, the last
// one while saying "with drone video" in its own name.
//
// So this is a veto over the hand-set map, exactly like the Zillow one above
// and for the same reason: only a human on /settings/products can correct the
// row, and until they do the hub must not invent a deliverable nobody bought.
// A line that sells VIDEO and no PHOTOGRAPHY cannot owe drone stills — its
// drone is footage for the video it sells.
//
// Scoped to ONE line, so a job that also buys real photography keeps its drone
// stills from THAT line. And the escape hatch is the product's own name: a line
// that says it sells drone photos keeps them, which is what saves "Deluxe Land
// Only Package - Drone Photo and Video".
const DRONE_STILLS_RE = /\b(drone|aerial)[\s-]*(photo|photograph|still|image)/i;

function droneOnVideoLineIsFootage(title: string, parsed: ParsedDeliverable[]): ParsedDeliverable[] {
  if (!parsed.some((d) => d.type === "DRONE")) return parsed;
  const sellsVideo = parsed.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const sellsPhotos = parsed.some((d) => d.type === "PHOTOS" || d.type === "TWILIGHT" || d.type === "HEADSHOT");
  if (!sellsVideo || sellsPhotos) return parsed;
  if (DRONE_STILLS_RE.test(title)) return parsed;
  // Loud, because the right repair is the mapping row and not this veto.
  console.warn(`[aryeo] "${title}" sells video and no photography — reading its drone as footage, not stills. Fix the mapping on /settings/products.`);
  return parsed.filter((d) => d.type !== "DRONE");
}

/** One order line → the deliverables it owes. */
export function itemToDeliverables(item: AryeoOrderItem): ParsedDeliverable[] {
  const title = (item.title || item.subtitle || item.sub_title || "Item").trim();
  // Lines the catalogue doesn't know (static map / keyword parser) can still
  // say they are an add-on in their name — "Agent Outro Add-on (Standard
  // Reel)" must not out-name the "Standard Reel" it was bought for (dedupe's
  // MAIN-over-add-on tie-break).
  const addon = /\badd-?on\b/i.test(title);
  const parsed = droneOnVideoLineIsFootage(title, withoutZillowFloorPlan(title, deliverablesForItem(item)));
  return parsed.map((d) => (d.addon === undefined ? { ...d, addon } : d));
}

// ---------------------------------------------------------------------------
// "MOVED TO ORDER #N" — a line that is a NEGATION, not a deliverable.
//
// Sep 16 (Kyle call, 68 New St / 2 Grace Cir). James shot one floor plan
// across two adjacent bookings, so the office moved the line: order #1608
// carries "2D Floorplan - Moved to Order#1611" at $0 and #1611 carries "2D
// Floorplan - From Order #1608". The keyword parser read both as a floor plan,
// and #1608's Essentials Package implied one anyway — so the source order read
// "Partial delivery — still missing Floor plan" for nine days until Kyle
// closed it twice by hand.
//
// The receiving side already works (a real row is created there). This is the
// source side: the line NAMES the category it is taking away, so the type it
// implies is struck off this order — even when a package still implies it —
// and reconcileDeliverablesToOrder retires the row with the destination in the
// note. "From Order #N" deliberately does not match.
// ---------------------------------------------------------------------------
const MOVED_TO_ORDER_RE = /moved\s+to\s+order\s*#?\s*(\d+)/i;

/** Types this order has explicitly moved away, → the order number they went to. */
export function movedAwayTypes(items: AryeoOrderItem[] | null | undefined): Map<DeliverableType, string> {
  const out = new Map<DeliverableType, string>();
  for (const it of items ?? []) {
    if (it.is_canceled) continue;
    const title = (it.title || it.sub_title || it.subtitle || "").trim();
    const m = MOVED_TO_ORDER_RE.exec(title);
    if (!m) continue;
    // Read the line for what it names WITHOUT the marker, so "2D Floorplan -
    // Moved to Order#1611" still resolves to FLOORPLAN.
    const types = deliverablesForTitle(title.replace(MOVED_TO_ORDER_RE, "").replace(/[-–—\s]+$/, "").trim() || title);
    // ONE line moves ONE thing. An add-on title carries the base gallery with
    // it in the parser ("Drone Photos" → PHOTOS + DRONE, "Twilight Photos" →
    // PHOTOS + TWILIGHT), so striking everything the title implies would take
    // the whole shoot off the order — no QC gate, no chase, nothing "missing".
    // Take the SPECIFIC category the line names and leave the base gallery
    // owed; only a line that names nothing else ("Listing Photography - Moved
    // to Order#9") strikes PHOTOS itself.
    const specific = types.filter((d) => d.type !== "PHOTOS");
    for (const d of specific.length > 0 ? specific : types) {
      if (!out.has(d.type)) out.set(d.type, m[1]);
    }
  }
  return out;
}

/**
 * Everything an ORDER owes: its live (non-canceled) lines → rows, collapsed to
 * one per type, with the order-level signals only the whole order can answer
 * (an "Agent on Camera" add-on upgrading the standard reel it was bought for —
 * passed as titles so it counts even if its own mapping produces no row).
 * The one entry point for "what does this order owe" — import, reconcile and
 * every re-derive go through it so they can never disagree.
 */
export function orderDeliverables(items: AryeoOrderItem[] | null | undefined): ParsedDeliverable[] {
  const live = (items ?? []).filter((it) => !it.is_canceled);
  const moved = movedAwayTypes(items);
  const parsed = dedupeParsedDeliverables(
    live.flatMap(itemToDeliverables),
    live.map((it) => (it.title || it.sub_title || it.subtitle || "").trim()).filter(Boolean),
  );
  // A type this order moved to another order is not owed here, however many
  // packages on the line-up imply it (see MOVED_TO_ORDER_RE).
  return moved.size === 0 ? parsed : parsed.filter((d) => !moved.has(d.type));
}

function deliverablesForItem(item: AryeoOrderItem): ParsedDeliverable[] {
  const title = (item.title || item.subtitle || item.sub_title || "Item").trim();
  const qty = item.quantity || 1;

  // A human-set mapping beats every parser — including an EMPTY one (a fee or
  // pure post-shoot add-on legitimately produces no deliverables).
  const manual = manualMappingForTitle(title);
  if (manual) {
    // Hand-set videos-per-order multiplies the line quantity (Accelerator=4).
    const vidQty = (manual.videoQty && manual.videoQty > 0 ? manual.videoQty : 1) * qty;
    // The identity every row keeps beside its category (see ParsedDeliverable):
    // the verbatim line title, whether the catalogue calls the product an
    // add-on, and — video rows only — the Style Guide type, human-set on the
    // product or derived from its tier + name.
    const identity = (raw: string) => ({
      productTitle: title,
      addon: manual.catalogType === "ADDON",
      videoStyle: resolveVideoStyle(raw, { style: manual.style, tier: manual.tier, title }),
    });
    const singleVideo = manual.types.filter((t) => VIDEOISH.has(t)).length === 1;
    return manual.types.map((raw) => {
      // Drone splits at the mapping level: photos stay a DRONE capture
      // deliverable (photo pipeline); drone VIDEO is footage for the order's
      // video and never a row of its own (see the DRONE_VIDEO fold below).
      if (raw === "DRONE_PHOTO") return { type: "DRONE" as DeliverableType, label: "Drone Photos", quantity: qty, ...identity(raw) };
      // Drone video is FOOTAGE for the order's video, never a cut of its own
      // (Jordan, Sep 2: "drone videography is just an add-on for standard
      // videos" — and a premium bundle's drone pass is part of its cinematic).
      // Folding it here stops the phantom "Premium Drone Video" cut a bundle
      // used to mint beside its reel and video. The order item keeps the
      // "with drone video" signal via productTitle / OrderItem.title.
      if (raw === "DRONE_VIDEO") return null;
      const type = raw as DeliverableType;
      const videoish = type === "VIDEO" || type === "SOCIAL_REEL";
      return { type, label: manualLabel(manual, type, title, singleVideo), quantity: videoish ? vidQty : qty, ...identity(raw) };
    }).filter((d): d is NonNullable<typeof d> => d !== null);
  }

  const mapped = mappedTypesForTitle(title);
  if (mapped) {
    const premium = isPremiumProduct(title);
    // A monthly-plan product's TITLE is its identity — "Video Starter - 2HR
    // Session" flattened to a generic "Video" label made isMonthlyContentJob()
    // false everywhere (wrong SLA, wrong routing, wrong tier — Aug 18 audit,
    // 39 live jobs). Keep the plan name on its video deliverables.
    // Monthly outranks premium: keeping the TITLE preserves both signals (the
    // premium word stays in it for videoTier), while "Premium Video" would
    // erase the monthly one — wrong SLA + lane for a premium-worded plan.
    const monthlyPlan = MONTHLY_PLAN_RE.test(title);
    const tier = monthlyPlan ? "personal_branding" : premium ? "premium" : "standard";
    // Same single-video title rule as the manual map (manualLabel) — the
    // static map is only a fallback for products nobody has mapped yet, and
    // the two must name rows the same way.
    const singleVideo = mapped.filter((t) => VIDEOISH.has(t)).length === 1;
    return mapped.map((type) => ({
      type,
      label:
        monthlyPlan && (type === "SOCIAL_REEL" || type === "VIDEO")
          ? title
          : (type === "SOCIAL_REEL" || type === "VIDEO") && singleVideo && labelReadsTier(title, tier)
            ? title
            : premium && (type === "SOCIAL_REEL" || type === "VIDEO")
              ? `Premium ${TYPE_LABEL[type]}`
              : (TYPE_LABEL[type] ?? title),
      quantity: qty,
      productTitle: title,
      videoStyle: resolveVideoStyle(type, { tier, title }),
    }));
  }
  const text = `${item.title ?? ""} ${item.sub_title ?? item.subtitle ?? ""} ${item.description ?? ""}`;

  const found: { type: DeliverableType; label: string }[] = [];
  const seen = new Set<DeliverableType>();
  for (const [re, type, label] of COMPONENT_RULES) {
    if (seen.has(type)) continue;
    if (re.test(text)) { found.push({ type, label }); seen.add(type); }
  }

  // For a social-content item, the "video" IS the social reel ("drone video
  // included in the social media reel"), not a separate property video — so
  // don't create a standalone VIDEO alongside the reel.
  if (seen.has("SOCIAL_REEL") && seen.has("VIDEO")) {
    const i = found.findIndex((f) => f.type === "VIDEO");
    if (i >= 0) { found.splice(i, 1); seen.delete("VIDEO"); }
  }

  // No media keywords matched. A content/branding session IS a video shoot —
  // "Content Day", "Branding Shoot", monthly plans in freehand wording — and
  // was falling through to OTHER, leaving 8 live personal-branding shoots with
  // NO video deliverable at all (Aug 18 audit). Keep the full title as the
  // label so the monthly detection reads it.
  if (found.length === 0) {
    if (MONTHLY_PLAN_RE.test(title) || /\bfilm\s*session\b/i.test(title)) {
      return [{ type: "VIDEO", label: title, quantity: qty, productTitle: title, videoStyle: resolveVideoStyle("VIDEO", { title }) }];
    }
    // A photo package/bundle (or interior/exterior-only coverage) is, at its
    // core, photography → PHOTOS (AutoHDR). Fees/travel/misc → OTHER.
    if (/package|bundle|interior|exterior/i.test(title)) return [{ type: "PHOTOS", label: title, quantity: qty, productTitle: title, videoStyle: null }];
    const type = deliverableType(title);
    return [{ type, label: title, quantity: qty, productTitle: title, videoStyle: resolveVideoStyle(type, { title }) }];
  }

  // Single-service item → keep the real product name as the label.
  if (found.length === 1) {
    return [{ type: found[0].type, label: title, quantity: qty, productTitle: title, videoStyle: resolveVideoStyle(found[0].type, { title }) }];
  }

  // Multi-service bundle → one deliverable per detected component. The video
  // components must keep the title's tier signal: a premium/monthly product
  // whose description ALSO mentions drone splits here, and the generic
  // "Social Reel" label was erasing the tier (same Carolannes failure).
  const fbPremium = isPremiumProduct(title);
  const fbMonthly = MONTHLY_PLAN_RE.test(title);
  return found.map((c) => ({
    type: c.type,
    label:
      fbMonthly && (c.type === "SOCIAL_REEL" || c.type === "VIDEO")
        ? title
        : fbPremium && (c.type === "SOCIAL_REEL" || c.type === "VIDEO")
          ? `Premium ${TYPE_LABEL[c.type]}`
          : c.label,
    quantity: qty,
    productTitle: title,
    videoStyle: resolveVideoStyle(c.type, { title }),
  }));
}

// The live, non-cancelled appointment for an order (if any).
function scheduledAppointment(order: AryeoOrder): AryeoAppointment | undefined {
  return order.appointments?.find((a) => (a.status || "").toUpperCase() === "SCHEDULED");
}

function initialStatus(order: AryeoOrder): ProjectStatus {
  const f = (order.fulfillment_status || "").toUpperCase();
  if (f === "FULFILLED" || order.fulfilled_at) return "DELIVERED";
  // Only "scheduled" if there's an actual SCHEDULED (not CANCELED) appointment.
  if (scheduledAppointment(order)) return "SCHEDULED";
  return "BOOKED";
}

// ---------------------------------------------------------------------------
// Test a key by hitting a cheap endpoint. Returns a label for the account.
// ---------------------------------------------------------------------------
export async function testAryeoKey(key: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    await aryeoRequest("/orders", { query: { page: 1, per_page: 1 }, key });
    return { ok: true, label: "Aryeo account" };
  } catch (e) {
    const err = e instanceof AryeoError ? e : new AryeoError(String(e));
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Sync orders → clients, projects, deliverables.
//
// Incremental by default: orders come newest-first, so we create any new ones
// and STOP as soon as we hit one we've already imported. This keeps "Sync now"
// fast (seconds) and serverless-safe after the initial backfill. Pass
// { full: true } to sweep the entire history (used for the one-time backfill).
// Live status/fulfillment changes are handled by webhooks, not this path.
// ---------------------------------------------------------------------------
export async function syncAryeoOrders(
  // `orderId` scopes the whole sweep to ONE order — the per-project "Refresh
  // from Aryeo" button. It reuses this function's entire per-order body (money
  // mirroring, cancel mapping, customer re-link, deliverable rebuild) instead
  // of a parallel implementation that would drift, but skips pagination and the
  // recent-window floor, so an old job can be refreshed on demand in ~1 call.
  // `budgetMs` (full mode only) makes the sweep RESUMABLE: it walks pages
  // until the budget is spent, persists the next page number, and the next
  // run picks up there. Without it the daily "safety net" restarted at page 1
  // every morning, ran ~130-330s, and was killed by the 5-minute platform
  // limit 29 of the last 30 days — so it had never once reached the end
  // (audit HIGH). The cursor lives in AppSetting "aryeo:fullReconcile".
  opts: { full?: boolean; orderId?: string; budgetMs?: number; maxPages?: number } = {},
): Promise<{
  imported: number; updated: number; clients: number; scanned: number;
  /** full mode: did this run reach the END of the order history? */
  complete?: boolean;
  /** full mode: the page the next run resumes from (1 = starting over) */
  resumeFromPage?: number;
  budgetHit?: boolean;
  /** single-order mode: Aryeo returned 404/410 for that order */
  missing?: boolean;
  /** Jobs whose per-video rows could not be materialised on this pass (R06).
   *  Reported, never swallowed — the hourly `outputUnits` sweep retries them
   *  and escalates a job that keeps failing. */
  outputErrors?: string[];
}> {
  await loadManualProductMap(); // hand-set product categories override the parsers below
  let imported = 0;
  let updated = 0;
  let scanned = 0;
  let clientsCreated = 0;
  const t0 = Date.now();
  const resumable = !!opts.full && !opts.orderId;
  // Direct AppSetting reads/writes (not getSetting's 60s cache) — a cursor has
  // to be exact across two runs minutes apart.
  const cursor = resumable ? await readReconcileCursor() : null;
  let reachedEnd = false;
  let budgetHit = false;
  let orderMissing = false;
  const outputErrors: string[] = [];

  try {
    // Preload what we already have to avoid a per-order round-trip. The extra
    // fields feed the UPDATE PASS below (payments/cancellations/client drift).
    const [existingProjects, existingClients] = await Promise.all([
      prisma.project.findMany({
        where: { aryeoOrderId: { not: null } },
        select: {
          id: true, aryeoOrderId: true, status: true, clientId: true, deliveredAt: true,
          price: true, payableInvoice: true, paymentStatus: true, balanceAmount: true, title: true,
          photographerId: true, // cancel bell targets the assigned photographer
          squareFeet: true, squareFeetBand: true, // so a size entered in Aryeo AFTER the import still lands
          // The listing id and the address: both are written at import and were
          // never revisited, which is the 39 Saratoga Ln bug — see the backfill
          // in the update pass below.
          aryeoListingId: true,
          addressLine: true, city: true, state: true, zip: true, lat: true, lng: true,
        },
      }),
      prisma.client.findMany({ select: { id: true, aryeoCustomerId: true, email: true, backupEmail: true, phone: true, name: true, company: true } }),
    ]);
    const seenOrders = new Set(existingProjects.map((p) => p.aryeoOrderId!));
    const projByOrder = new Map(existingProjects.map((p) => [p.aryeoOrderId!, p]));

    // Map Aryeo company-team-member id → our TeamMember id (for shoot assignment).
    const team = await prisma.teamMember.findMany({
      where: { aryeoTeamMemberId: { not: null } },
      select: { id: true, aryeoTeamMemberId: true },
    });
    const teamByCtm = new Map(team.map((t) => [t.aryeoTeamMemberId!, t.id]));

    // Which projects hold a deliverable the Aryeo order does not know about —
    // a photographer's extra shoot (upload/additionalShoots) or an editor's
    // hand-added video row. Preloaded ONCE, so the DELIVERED branch of the
    // update pass below (Sep 18 review, F3) costs nothing on the 600+ delivered
    // jobs that carry none; measured Sep 18, that is every job in the database.
    const manualRowProjects = new Set(
      (
        await prisma.deliverable.findMany({
          where: { manual: true, removedFromOrderAt: null },
          select: { projectId: true },
          distinct: ["projectId"],
        })
      ).map((r) => r.projectId),
    );

    const clientByAryeoId = new Map<string, string>();
    const clientByEmail = new Map<string, string>();
    // Same-person signals beyond id/email — the identity rule the merge tool
    // (src/lib/clientDedupe.ts) uses: matching phone, or matching name+company.
    // Without these, an Aryeo order under a NEW email (assistant books it, agent
    // changes address) minted a duplicate client and moved live jobs onto the
    // twin, cut off from history/segment/open tasks (audit critical).
    const { phoneKey } = await import("@/lib/integrations/openphone");
    const normId = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const clientByPhone = new Map<string, { id: string; name: string }>();
    const clientByNameCo = new Map<string, string>();
    // Rows that already own an Aryeo customer id — adoption must never steal
    // the unique slot from them (an agent with TWO live Aryeo customer records
    // would otherwise thrash the id back and forth every sync).
    const hasAryeoId = new Set<string>();
    for (const c of existingClients) {
      if (c.aryeoCustomerId) { clientByAryeoId.set(c.aryeoCustomerId, c.id); hasAryeoId.add(c.id); }
      if (c.email) clientByEmail.set(c.email.toLowerCase(), c.id);
      const pk = phoneKey(c.phone);
      if (pk.length === 10 && !clientByPhone.has(pk)) clientByPhone.set(pk, { id: c.id, name: c.name });
      const nc = normId(c.name) && normId(c.company) ? `${normId(c.name)}|${normId(c.company)}` : null;
      if (nc && !clientByNameCo.has(nc)) clientByNameCo.set(nc, c.id);
    }
    // Second pass: backupEmail (a merged-away twin's old address) also resolves
    // to the surviving row. Kept in its OWN map: backup addresses are often
    // shared team inboxes (that's how they got stashed), so a backup hit must
    // be corroborated by the customer's NAME before it counts — otherwise agent
    // Bob's order lands on Jane because both once booked through team@acme.com.
    // Primary emails always win on collision.
    const clientByBackupEmail = new Map<string, { id: string; name: string }>();
    for (const c of existingClients) {
      const be = c.backupEmail?.toLowerCase();
      if (be && !clientByEmail.has(be) && !clientByBackupEmail.has(be)) {
        clientByBackupEmail.set(be, { id: c.id, name: c.name });
      }
    }
    // Rows whose backupEmail slot is already occupied — the stash below must
    // never overwrite it (after a twin merge that address is the load-bearing
    // identity key; losing it re-arms the twin re-mint).
    const hasBackupEmail = new Set(existingClients.filter((c) => c.backupEmail).map((c) => c.id));

    const resolveClient = async (cust?: AryeoCustomer): Promise<string> => {
      const byId = cust?.id ? clientByAryeoId.get(cust.id) : undefined;
      if (byId) return byId;
      const byEmail = cust?.email ? clientByEmail.get(cust.email.toLowerCase()) : undefined;
      if (byEmail) {
        // Learn this Aryeo customer id for the rest of the run (in-memory only —
        // the DB slot stays with whichever id the row already owns).
        if (cust?.id && !clientByAryeoId.has(cust.id)) clientByAryeoId.set(cust.id, byEmail);
        return byEmail;
      }
      // Phone / name+company hit → this is an EXISTING person under a new
      // email or Aryeo customer id: adopt onto the existing row (stash the new
      // email as backupEmail) instead of minting a twin. A phone match ALSO
      // requires the same name — two agents sharing an office line must not
      // get collapsed into one client.
      const pk = phoneKey(cust?.phone);
      const phoneHit = pk.length === 10 ? clientByPhone.get(pk) : undefined;
      const samePersonByPhone = phoneHit && normId(phoneHit.name) === normId(customerName(cust)) ? phoneHit.id : undefined;
      const nameCo =
        normId(customerName(cust)) && normId(cust?.office_name) ? `${normId(customerName(cust))}|${normId(cust?.office_name)}` : null;
      // backupEmail ranks BELOW phone+name and name+company and needs the same
      // name corroboration — backup addresses can be shared team inboxes.
      const backupHit = cust?.email ? clientByBackupEmail.get(cust.email.toLowerCase()) : undefined;
      const sameByBackup = backupHit && normId(backupHit.name) === normId(customerName(cust)) ? backupHit.id : undefined;
      const byStrongSignal = samePersonByPhone ?? (nameCo ? clientByNameCo.get(nameCo) : undefined);
      const bySignal = byStrongSignal ?? sameByBackup;
      if (bySignal) {
        await prisma.client
          .update({
            where: { id: bySignal },
            data: {
              // Take the unique Aryeo-id slot only if the row has none yet.
              ...(cust?.id && !hasAryeoId.has(bySignal) ? { aryeoCustomerId: cust.id } : {}),
              // Stash the new address only into an EMPTY slot — an occupied
              // backupEmail is an identity key (often the merged twin's old
              // address) and must never be clobbered.
              ...(cust?.email && !hasBackupEmail.has(bySignal) ? { backupEmail: cust.email } : {}),
            },
          })
          .catch(() => {});
        if (cust?.id) {
          hasAryeoId.add(bySignal);
          // Learn the id in-memory only for the STRONG signals; a backup-email
          // hit must not teach the update-pass re-linker to move projects.
          if (byStrongSignal) clientByAryeoId.set(cust.id, bySignal);
        }
        if (cust?.email) {
          clientByEmail.set(cust.email.toLowerCase(), bySignal);
          if (!hasBackupEmail.has(bySignal)) hasBackupEmail.add(bySignal);
        }
        return bySignal;
      }
      // NO CUSTOMER ON THE ORDER AT ALL — Aryeo itself has nobody attached (the
      // two delivered jobs traced on Sep 7 confirmed it). Minting a fresh
      // "Unknown client" per order is how eight of them piled up; reuse the one
      // placeholder so the pile stops growing and the name says what happened.
      if (!cust?.id && !cust?.email && !(cust?.name ?? "").trim()) {
        const ph = await prisma.client.findFirst({ where: { name: UNKNOWN_CUSTOMER_NAME }, select: { id: true } })
          ?? await prisma.client.create({ data: { name: UNKNOWN_CUSTOMER_NAME }, select: { id: true } });
        console.warn("[aryeo] order arrived with no customer — filed under the placeholder client", ph.id);
        return ph.id;
      }
      const created = await prisma.client.create({
        data: {
          name: customerName(cust),
          email: cust?.email ?? null,
          phone: cust?.phone ?? null,
          company: cust?.office_name ?? null,
          licenseNumber: cust?.license_number ?? null,
          // The customer note comes FROM Aryeo, so the mirror is in sync the
          // moment the row is created — stamp it, or the client card would warn
          // about a note it just received.
          generalNotes: cust?.internal_notes ?? null,
          notesSyncedAt: cust?.internal_notes ? new Date() : null,
          aryeoCustomerId: cust?.id ?? null,
          // A client who first reaches us by placing an order is still a new
          // client: card, brief and welcome all key off this stamp.
          firstSeenAt: new Date(),
          firstSeenVia: "order",
          avatarUrl: cust?.avatar_url ?? null,
        },
      });
      clientsCreated++;
      try {
        const { greetNewClient } = await import("@/lib/newClients");
        await greetNewClient(created.id);
      } catch { /* the create stands on its own */ }
      if (cust?.id) { clientByAryeoId.set(cust.id, created.id); hasAryeoId.add(created.id); }
      if (cust?.email) clientByEmail.set(cust.email.toLowerCase(), created.id);
      const cpk = phoneKey(cust?.phone);
      if (cpk.length === 10) clientByPhone.set(cpk, { id: created.id, name: created.name });
      return created.id;
    };

    // Paginate newest-first. We CAN'T just stop at the first order we've already
    // imported: Aryeo orders finalize out of created_at order (a draft placed
    // today can carry a created_at from days ago), so an order can appear "behind"
    // ones we've already synced and would be stranded forever. Instead, incremental
    // scans a bounded RECENT WINDOW and imports anything in it we don't yet have; a
    // full sweep scans the entire history. (The daily cron also runs a full sweep
    // as a safety net for anything that finalized older than the window.)
    const RECENT_WINDOW_DAYS = 45;
    const floorDate = opts.full ? ARYEO_MIN_DATE : new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 3600_000);
    const perPage = 50;
    let page = cursor?.page ?? 1;
    let stop = false;
    let pagesThisRun = 0;
    for (let i = 0; i < 200 && !stop; i++) {
      // Budget / slice check BEFORE each page fetch, so the page we were
      // mid-way through is never half-applied; the cursor always points at a
      // page boundary.
      if (resumable && ((opts.budgetMs && Date.now() - t0 >= opts.budgetMs) || (opts.maxPages && pagesThisRun >= opts.maxPages))) {
        budgetHit = true;
        break;
      }
      let batch: AryeoOrder[];
      let lastPage: number | undefined;
      if (opts.orderId) {
        // Single-order mode: one fetch, one pass, no pagination. A definitive
        // 404 is information the caller must see ("Refresh from Aryeo" used to
        // swallow it and report no change on an order that no longer exists).
        let one: AryeoOrder | null = null;
        try {
          one = await Aryeo.order(opts.orderId);
        } catch (e) {
          // Never THROW here: the outer catch marks the whole Aryeo connection
          // as errored on /connections. A 404 is a fact about one order.
          if (e instanceof AryeoError && (e.status === 404 || e.status === 410)) orderMissing = true;
          one = null;
        }
        batch = one ? [one] : [];
        stop = true;
      } else {
        // Resumable passes page OLDEST-first: Aryeo honours sort=created_at
        // (verified; updated_at is not an allowed sort) and it gives stable
        // page positions, so an order booked between two runs can't push
        // another order across the cursor's page boundary and get it skipped.
        // Every other caller keeps the newest-first default byte-for-byte.
        const res = await aryeoRequest<{ data: AryeoOrder[]; meta?: { last_page?: number } }>("/orders", {
          query: { include: ORDER_INCLUDES, page, per_page: perPage, ...(resumable ? { sort: "created_at" } : {}) },
        });
        batch = res?.data ?? [];
        lastPage = res?.meta?.last_page;
        pagesThisRun++;
      }
      if (batch.length === 0) {
        reachedEnd = true;
        break;
      }

      for (const order of batch) {
        if (!order.id) continue;
        scanned++;
        // Newest-first: once we pass the window floor (full = all history,
        // incremental = the recent window), stop entirely. An explicit
        // single-order refresh ignores the floor — the owner asked for THIS job.
        // (Never on an ascending resumable pass — the oldest orders come FIRST
        // there, and the floor is 2021 anyway.)
        if (!opts.orderId && !resumable && order.created_at && new Date(order.created_at) < floorDate) {
          stop = true;
          reachedEnd = true;
          break;
        }
        // Already imported → UPDATE PASS (audit cracks #1/#14/#18/#29): orders
        // change after import — payments land, invoices grow, orders get
        // canceled, customers get swapped — and a write-once import froze all of
        // it (phantom AR, stale payroll basis, 30 undead cancellations). Mirror
        // the money fields, map CANCELED, and re-link a changed customer.
        if (seenOrders.has(order.id)) {
          const proj = projByOrder.get(order.id);
          if (!proj) continue;
          const price = money(order.total_amount);
          const payable = payableInvoiceFromItems(order.items ?? [], price);
          const isCanceled = (order.order_status ?? "").toUpperCase().startsWith("CANCEL");
          const cust = order.customer;
          const custClientId = cust?.id ? clientByAryeoId.get(cust.id) : undefined;

          const neq = (a: number | null, b: number | null) =>
            (a == null) !== (b == null) || (a != null && b != null && Math.abs(a - b) > 0.005);
          const moneyChanged =
            neq(proj.price, price) || neq(proj.payableInvoice, payable) ||
            (proj.paymentStatus ?? null) !== (order.payment_status ?? null) ||
            (proj.balanceAmount ?? null) !== (order.balance_amount ?? null);
          // Never cancel a delivered job from here (refunds are a human call).
          const cancelNow = isCanceled && proj.status !== "CANCELLED" && !proj.deliveredAt;
          // A cancel AFTER delivery keeps that policy — but the human it defers
          // to has to actually hear about it, or the canceled order silently
          // stays in /billing's AR chase. Surface it exactly once: a SYSTEM
          // activity (checked by marker text, since this update pass re-scans
          // the same canceled order every hour) + an owner-only bell (dedupeKey
          // backstops the race). Best-effort — never breaks the sync.
          if (isCanceled && proj.status !== "CANCELLED" && proj.deliveredAt) {
            try {
              const marker = "Order canceled in Aryeo AFTER delivery";
              const already = await prisma.activity.findFirst({
                where: { projectId: proj.id, type: "SYSTEM", body: { startsWith: marker } },
                select: { id: true },
              });
              if (!already) {
                await prisma.activity.create({
                  data: { projectId: proj.id, type: "SYSTEM", body: `${marker} — review for refund / AR write-off.` },
                });
                const { notifyInApp } = await import("@/lib/notify");
                await notifyInApp({
                  kind: "order_canceled",
                  title: `Canceled after delivery — ${(proj.title || "a job").split(",")[0].trim()}`,
                  href: `/projects/${proj.id}`,
                  targets: [{ roles: ["OWNER"] }],
                  dedupeKey: `order-canceled-delivered-${proj.id}`,
                });
              }
            } catch { /* visibility is best-effort */ }
          }
          // Customer changed on the order: same person under a new Aryeo id
          // re-links silently; a different person gets an activity trail.
          const clientChanged = !!cust?.id && custClientId !== undefined && custClientId !== proj.clientId;
          const clientNeedsResolve = !!cust?.id && custClientId === undefined;
          // Square footage is usually filled in Aryeo AFTER the order is
          // created (or never — only 7 of 1,701 listings carry one), so the
          // import-time read is not enough. Aryeo wins when it HAS a number;
          // a null there never wipes a size the photographer typed on site.
          const liveBand = orderSqftBand(order.items);
          const liveSqft = sqftOf(order);
          const sqftChanged =
            (liveSqft != null && liveSqft !== proj.squareFeet) ||
            (liveBand?.text ?? null) !== (proj.squareFeetBand ?? null);

          // ---- THE LISTING ID (Sep 16, Kyle call — 39 Saratoga Ln) ---------
          // The listing is where ALL the media lives: projectStatus only calls
          // Aryeo when aryeoListingId is set, so a project without one can
          // never see a photo, whatever is live. It was written ONCE, at
          // import (`order.listing?.id ?? null`), and orders created by the
          // webhook from a thin/ghost payload ("Imported from Aryeo (order
          // #-1)") arrive before a listing exists — so Saratoga's 77 delivered
          // photos read as "Photos missing" and Refresh from Aryeo could
          // report nothing, because the one field it needed was the one field
          // this pass never wrote. Backfill it the moment the order carries
          // one; never overwrite a listing id we already have (that is a
          // re-point, and no Aryeo order changes its listing under us).
          const listingLinked = !proj.aryeoListingId && !!order.listing?.id;

          // ---- THE ADDRESS ------------------------------------------------
          // Same shape, same cause: an order re-addressed in Aryeo (#1615 was
          // re-pointed from 245 S Bryn Mawr Ave to 99 Bridge St, Phoenixville)
          // kept the hub's import-time title forever. Aryeo wins when it HAS a
          // street; a blank there never wipes what we hold.
          const addr = order.address;
          const liveStreet = [addr?.street_number, addr?.street_name].filter(Boolean).join(" ") || null;
          // Compared loosely (case + spacing) so a formatting difference in an
          // old import doesn't re-title half the history on the next full
          // sweep — only a genuinely different street counts.
          const sameStreet = (a: string | null, b: string | null) =>
            (a ?? "").trim().toLowerCase().replace(/\s+/g, " ") === (b ?? "").trim().toLowerCase().replace(/\s+/g, " ");
          const addressChanged = !!liveStreet && !sameStreet(liveStreet, proj.addressLine ?? null);

          // (deliveredAt is HUB-owned — stamped at the hub's own DELIVERED
          // transition. Aryeo's fulfilled_at lands at the FIRST media delivery,
          // i.e. photos on day 1 of a staged listing job; mirroring it here
          // would have marked every in-production job "delivered" — review.)
          if (moneyChanged || cancelNow || clientChanged || clientNeedsResolve || sqftChanged || listingLinked || addressChanged) {
            const newClientId = clientChanged || clientNeedsResolve ? await resolveClient(cust) : proj.clientId;
            await prisma.project.update({
              where: { id: proj.id },
              data: {
                price,
                payableInvoice: payable,
                paymentStatus: order.payment_status ?? null,
                balanceAmount: order.balance_amount ?? null,
                invoiceUrl: order.invoice_url ?? null,
                paymentUrl: order.payment_url ?? null,
                ...(listingLinked ? { aryeoListingId: order.listing!.id } : {}),
                ...(addressChanged
                  ? {
                      title: addressTitle(order),
                      addressLine: liveStreet,
                      city: addr?.city ?? proj.city,
                      state: addr?.state_or_province ?? proj.state,
                      zip: addr?.postal_code ?? proj.zip,
                      ...(addr?.latitude != null ? { lat: addr.latitude } : {}),
                      ...(addr?.longitude != null ? { lng: addr.longitude } : {}),
                    }
                  : {}),
                ...(newClientId !== proj.clientId ? { clientId: newClientId } : {}),
                // A cancel from Aryeo always wins over the office's status
                // pin (Sep 13, editOverrides.ts) — the order is gone; the pin
                // goes with it.
                ...(cancelNow ? { status: "CANCELLED", statusPinnedAt: null } : {}),
                ...(sqftChanged
                  ? { ...(liveSqft != null ? { squareFeet: liveSqft } : {}), squareFeetBand: liveBand?.text ?? null }
                  : {}),
              },
            });
            if (cancelNow) {
              try {
                const { closeObsoleteTasks } = await import("@/lib/tasks");
                await closeObsoleteTasks(proj.id, "CANCELLED");
              } catch { /* tasks close on the next cron sweep */ }
              await prisma.activity.create({
                data: { projectId: proj.id, type: "SYSTEM", body: "Order canceled in Aryeo — project cancelled and its tasks closed." },
              }).catch(() => {});
              // Bell: a canceled order otherwise just vanishes from /schedule,
              // /shoot and /upload (they all filter CANCELLED) with zero notice —
              // the photographer could still drive out, and nobody knows to
              // release the slot. Mirrors the order_booked/order_paid emitters.
              try {
                const { notifyInApp } = await import("@/lib/notify");
                const targets: NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
                if (proj.photographerId) {
                  targets.push({ roles: ["PHOTOGRAPHER"], userKey: `tm:${proj.photographerId}`, href: "/shoot" });
                }
                await notifyInApp({
                  kind: "order_canceled",
                  title: `Canceled — ${(proj.title || "a job").split(",")[0].trim()}`,
                  href: `/projects/${proj.id}`,
                  targets,
                  dedupeKey: `order-canceled-${proj.id}`,
                });
              } catch { /* bell is best-effort */ }
            }
            if (newClientId !== proj.clientId) {
              await prisma.activity.create({
                data: { projectId: proj.id, type: "SYSTEM", body: `Client re-linked to match the order's current Aryeo customer (${customerName(cust)}).` },
              }).catch(() => {});
            }
            if (listingLinked) {
              // Said out loud on the timeline: the media the hub is about to
              // start seeing did not appear, it was always there — we just had
              // nowhere to look. (Refresh from Aryeo reads this line back so
              // the button can report "Listing linked" instead of "Up to date".)
              await prisma.activity.create({
                data: { projectId: proj.id, type: "SYSTEM", body: "Listing linked from the order — the hub can now see this job's media on Aryeo." },
              }).catch(() => {});
            }
            if (addressChanged) {
              await prisma.activity.create({
                data: { projectId: proj.id, type: "SYSTEM", body: `Address updated from Aryeo: ${proj.addressLine ?? "no address"} → ${liveStreet}.`.slice(0, 1000) },
              }).catch(() => {});
            }
            // First flip to PAID → owner bell (same "paid" literal /billing keys
            // off). Checked against the PRE-update proj so it fires exactly once;
            // the dedupe key backstops any re-read race. Best-effort.
            if ((proj.paymentStatus ?? null) !== "paid" && order.payment_status === "paid") {
              try {
                const { notifyInApp } = await import("@/lib/notify");
                await notifyInApp({
                  kind: "order_paid",
                  title: `Paid — ${proj.title}${price != null ? ` ($${Math.round(price).toLocaleString("en-US")})` : ""}`,
                  href: "/billing",
                  targets: [{ roles: ["OWNER"] }],
                  dedupeKey: `order-paid-${proj.id}`,
                });
              } catch { /* bell is best-effort */ }
            }
            // Keep the in-memory row current so a duplicate page doesn't re-write.
            Object.assign(proj, {
              price, payableInvoice: payable,
              paymentStatus: order.payment_status ?? null,
              balanceAmount: order.balance_amount ?? null,
              clientId: newClientId,
              status: cancelNow ? "CANCELLED" : proj.status,
              // …so a second page carrying the same order is a true no-op
              // (and the listing link is never logged twice).
              ...(listingLinked ? { aryeoListingId: order.listing!.id } : {}),
              ...(addressChanged ? { addressLine: liveStreet } : {}),
            });
            updated++;
          }
          // The other half of the update pass: line items. A write-once
          // import meant an item removed from the order kept its deliverable
          // forever — 632 Greenridge chased a "Premium Video" for a week after
          // the item was pulled and the order re-priced (Sep 1 2026 audit).
          if (!["DELIVERED", "CANCELLED"].includes(proj.status)) {
            try {
              const r = await reconcileDeliverablesToOrder(proj.id, order);
              if (r.changed) updated++;
              // A per-video materialisation that failed rides home in this
              // sync's result instead of vanishing into the catch below (R06).
              if (r.outputsError) outputErrors.push(`${proj.title}: ${r.outputsError}`.slice(0, 200));
              // A line this order now sells that could not be filed against the
              // merge carrying the job's work rides home the same way, rather
              // than being minted somewhere nothing can find it again (Sep 20).
              if (r.mergeError) outputErrors.push(`${proj.title}: ${r.mergeError}`.slice(0, 200));
            } catch { /* reconcile is best-effort — the money mirror above already landed */ }
          } else if (proj.status === "DELIVERED" && manualRowProjects.has(proj.id)) {
            // The gate above is right and stays (see the note on
            // reconcileDeliverablesToOrder), but it also meant Kyle's "Add to
            // the order" card could never close on a delivered job — which is
            // where an extra shoot almost always happens. This touches no
            // deliverable; it only ticks off the card the order just answered.
            try {
              await completeAbsorbedAddOnsFromOrder(proj.id, order);
            } catch { /* closing a stale card never breaks the sync */ }
          }
          continue;
        }

        const cust = order.customer;
        const addr = order.address;
        const clientId = await resolveClient(cust);
        const appt = scheduledAppointment(order) ?? order.appointments?.[0];
        const shootDate = scheduledAppointment(order)?.start_at;
        const photographerId =
          (appt?.initial_assigned_company_team_member_id &&
            teamByCtm.get(appt.initial_assigned_company_team_member_id)) ||
          null;
        const items = order.items ?? [];

        const createdProject = await prisma.project.create({
          data: {
            title: addressTitle(order),
            source: "ARYEO",
            aryeoOrderId: order.id,
            aryeoListingId: order.listing?.id ?? null,
            status: initialStatus(order),
            clientId,
            photographerId,
            price: money(order.total_amount),
            payableInvoice: payableInvoiceFromItems(items, money(order.total_amount)),
            paymentStatus: order.payment_status ?? null,
            balanceAmount: order.balance_amount ?? null,
            invoiceUrl: order.invoice_url ?? null,
            paymentUrl: order.payment_url ?? null,
            addressLine: [addr?.street_number, addr?.street_name].filter(Boolean).join(" ") || null,
            city: addr?.city ?? null,
            state: addr?.state_or_province ?? null,
            zip: addr?.postal_code ?? null,
            lat: addr?.latitude ?? null,
            lng: addr?.longitude ?? null,
            // Square footage sizes the culling tiers. It lives on
            // listing.BUILDING (checked against the live API Sep 3 2026) — the
            // old code read listing.square_feet, a field that does not exist,
            // which is why all 1,542 projects had null and every home was shown
            // the smallest "aim for 35-45" range regardless of size.
            squareFeet: sqftOf(order),
            squareFeetBand: orderSqftBand(items)?.text ?? null,
            orderedAt: order.created_at ? new Date(order.created_at) : null,
            shootDate: shootDate ? new Date(shootDate) : null,
            deliveredAt: order.fulfilled_at ? new Date(order.fulfilled_at) : null,
            deliverables: {
              create: orderDeliverables(items),
            },
            // The real line items, kept verbatim beside the production view —
            // this is the only place the actual product names and per-item
            // prices survive (see the OrderItem model comment).
            orderItems: { create: orderItemRows(items) },
            activities: {
              create: { type: "SYSTEM", body: `Imported from Aryeo (order #${order.number ?? order.id}).` },
            },
          },
        });
        seenOrders.add(order.id);
        imported++;
        // EVERY OWED VIDEO GETS ITS ROW AT BOOKING (audit R06, Sep 18).
        //
        // The claim the WF-02 build made — "booking creates every video's row"
        // — was ahead of the code: ensureOutputsForProject was called by the
        // one-off materialisation script and by the four CUT events, all of
        // which happen after a file exists. So a four-video order imported this
        // morning owed four videos and had zero rows until somebody uploaded
        // the first cut, and the project view, the per-video promise and the
        // delivery board had nothing to count.
        //
        // Here is the earliest honest moment: the deliverables were created in
        // the same statement above, so cutSlots can already say what the job
        // owes. Never fatal — an order that imports is worth keeping even if
        // this fails, and the hourly `outputUnits` sweep retries it.
        {
          const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
          const ensured = await ensureOutputsSafely(createdProject.id, `aryeo-import#${order.number ?? order.id}`);
          if (!ensured.ok) outputErrors.push(`${createdProject.title}: ${ensured.error}`.slice(0, 200));
        }
        // The booking conversation predates this row — texts/emails naming this
        // street were filed to the client's previous job (or unfiled) because
        // this project didn't exist yet. Re-point them now so the shoot card,
        // project page, and Hub see the access/lockbox chat. Best-effort.
        try {
          const { refileRecentCommsToProject } = await import("@/lib/contacts");
          await refileRecentCommsToProject(createdProject);
        } catch { /* refile is best-effort */ }
        // Bell: a fresh booking, announced here (not the webhook receiver — it
        // only triggers this sync, and emitting here covers cron-discovered
        // orders too). Deduped per project. Best-effort.
        try {
          const { notifyInApp } = await import("@/lib/notify");
          await notifyInApp({
            kind: "order_booked",
            title: `Booked — ${createdProject.title}`,
            href: `/projects/${createdProject.id}`,
            targets: [{ roles: ["OWNER", "ADMIN"] }],
            dedupeKey: `order-booked-${createdProject.id}`,
          });
        } catch { /* bell is best-effort */ }
      }

      if (opts.orderId) break; // single-order mode already has everything
      const last = lastPage;
      if (last ? page >= last : batch.length < perPage) {
        reachedEnd = true;
        break;
      }
      page++;
      // Page boundary reached and fully applied → remember it. A run killed
      // mid-page re-does that one page next time (every write here is an
      // idempotent upsert/update), never skips it.
      if (resumable) await writeReconcileCursor({ page, startedAt: cursor?.startedAt ?? new Date(t0).toISOString(), lastCompletedAt: cursor?.lastCompletedAt ?? null });
    }

    if (resumable) {
      if (reachedEnd) {
        await writeReconcileCursor({ page: 1, startedAt: null, lastCompletedAt: new Date().toISOString() });
      } else if (!budgetHit) {
        // Hit the 200-iteration safety cap without reaching the end — keep the
        // cursor where the loop left it so the next run continues.
        await writeReconcileCursor({ page, startedAt: cursor?.startedAt ?? new Date(t0).toISOString(), lastCompletedAt: cursor?.lastCompletedAt ?? null });
      }
    }

    await markSynced("aryeo");
    return {
      imported, updated, clients: clientsCreated, scanned,
      ...(resumable ? { complete: reachedEnd, resumeFromPage: reachedEnd ? 1 : page, budgetHit } : {}),
      ...(opts.orderId ? { missing: orderMissing } : {}),
      ...(outputErrors.length > 0 ? { outputErrors } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markError("aryeo", msg);
    throw e;
  }
}

// WHICH ORDER DOES THIS LISTING BELONG TO? (Sep 16, Kyle call.)
//
// The hub links a project to a listing at import, from the ORDER side. When
// that fails — a thin/ghost order webhook fires before the listing exists, as
// it did for 39 Saratoga Ln — every later LISTING event about the job looks
// like a listing we have never heard of. `include=orders` on the listing is
// the reverse link (verified live Sep 16 2026; `include=order` is rejected by
// the API, and there is no working listing filter on /orders). Returns null
// when the listing exists but carries no order, which really does mean "not
// ours"; a listing id Aryeo has never heard of THROWS (a plain 404 out of
// aryeoRequest), so every caller keeps it inside a try.
export async function orderIdForListing(listingId: string): Promise<string | null> {
  const r = await aryeoRequest<{ data: AryeoListing }>(`/listings/${listingId}`, { query: { include: "orders" } });
  return r?.data?.orders?.find((o) => !!o?.id)?.id ?? null;
}

// ---- Order items → deliverables (re-sync) ----------------------------------
// Bring a project's Deliverable rows in line with the order's CURRENT line
// items. Compares by TYPE (one row per type is the invariant), because a
// Deliverable has no item id and several items can imply the same type.
//   · type no longer implied by any non-canceled item → RETIRE the row
//     (removedFromOrderAt + why). Never deleted: status, uploads, capturedAt
//     stay as evidence of work that happened. Hub-created rows (manual) are
//     never touched — the reconcile only knows Aryeo's line items.
//   · type newly implied → un-retire a retired row of that type, else create.
//   · label / quantity drift → update in place (status untouched).
//   · stored OrderItem rows replaced when the item set changed.
// Guards: an order with NO parseable items (fee-only, or a thin API page) is
// left alone — "unknown beats wrong". DELIVERED/CANCELLED projects are never
// reconciled (post-delivery edits are billing, not production).
export async function reconcileDeliverablesToOrder(
  projectId: string,
  order: AryeoOrder,
): Promise<{ changed: boolean; retired: string[]; restored: string[]; added: string[]; relabeled: string[]; outputsError?: string | null; mergeError?: string | null }> {
  const out = {
    changed: false, retired: [] as string[], restored: [] as string[], added: [] as string[], relabeled: [] as string[],
    // Set when the per-video rows could NOT be brought in line with the order
    // this pass. It rides home in the sync's own result rather than being
    // swallowed, and the hourly `outputUnits` sweep retries it (R06).
    outputsError: null as string | null,
    // Set when a row this order now sells could not be filed against the merge
    // that carried the job's work away, so it was NOT created at all this pass
    // (Sep 20 2026 review). Rides home the same way. The next sweep retries it.
    mergeError: null as string | null,
  };
  const parsed = orderDeliverables(order.items);
  if (parsed.length === 0) return out;

  // WHERE THIS ORDER'S ROWS ACTUALLY LIVE (Sep 20 2026, audit F01).
  //
  // This function reads what a job owes BY PROJECT and computes what is wanted
  // FROM THE ORDER, and merging two jobs (editing/actions mergeProjectWork,
  // shipped Sep 18) breaks exactly that correspondence: the second shoot's rows
  // move onto the original job while both orders stand. Nothing here knew that,
  // so the very next sweep undid the merge — within the hour on /api/cron/sync,
  // within ~4 hours on the full /api/cron/reconcile pass, instantly on a webhook
  // or a press of "Refresh from Aryeo". The donor, its rows gone, fell through
  // to the create loop and re-minted the video it had just given away, putting
  // itself back on the Editing Room owing work nobody would ever find footage
  // for; the survivor, holding a row its own order does not sell, had it stamped
  // "no longer on Aryeo order" with the editor's cut already sitting under it.
  //
  // So the merge is read first and the rest of the function works on THIS
  // ORDER's rows, wherever they physically sit:
  //   · movedAway — this job's work is on `rowHome` now. Read its rows there,
  //     and mint anything new there too (recorded in the marker, so the undo
  //     stays exact).
  //   · movedIn — the rows another order's job parked here. They are not this
  //     order's to retire, to relabel or to count against its line quantities.
  const mergeLib = await import("@/lib/projectMerge");
  let merge: Awaited<ReturnType<typeof mergeLib.mergeContext>>;
  try {
    merge = await mergeLib.mergeContext(projectId);
  } catch (e) {
    // COULD NOT READ THE MARKER, SO DO NOTHING (Sep 20 2026 review). An empty
    // answer here is indistinguishable from "these jobs were never merged", and
    // that answer is the bug: this function would go on to retire the moved reel
    // out from under the editor's cut and re-mint it on the job that gave it
    // away. Every other unknown in here makes it do nothing; this is the one
    // that used to make it write. A skipped job is repaired an hour later.
    //
    // AND IT SAYS SO (Sep 20 2026 re-review). The skip shipped as a bare
    // `return out` with mergeError left null, which is indistinguishable from
    // "this order needed nothing". This read is unconditional and sits ahead of
    // every write in the function, so one AppSetting read that keeps failing
    // silently disables ALL deliverable reconciliation — retire, restore,
    // relabel, create, OrderItem refresh, deliveryDue, per-video outputs — for
    // every ordered job, hourly, hub-wide, with nothing raised anywhere. The
    // field exists for exactly this and the caller already pushes it into the
    // sync's result, the same way a failed marker append rides home.
    const why = e instanceof Error ? e.message : String(e);
    out.mergeError = `merge marker unreadable, reconcile skipped this pass: ${why}`.slice(0, 200);
    console.warn(`[aryeo-reconcile#${order.number ?? order.id ?? "?"}] ${projectId}: ${out.mergeError}`);
    return out;
  }
  const movedAway = merge.movedAway;
  const foreign = mergeLib.foreignDeliverableIds(merge.movedIn);
  const rowHome = movedAway?.intoId ?? projectId;
  const homeIds = [...(movedAway?.moved.deliverableIds ?? [])];
  const ownWhere = (): Prisma.DeliverableWhereInput =>
    movedAway ? { OR: [{ projectId }, { id: { in: homeIds } }] } : { projectId };

  // THE JOB HOLDING THE WORK KEEPS ITS OWN PROTECTION (Sep 20 2026 review).
  //
  // Reading this order's rows wherever they sit means this function can now
  // write to rows that physically belong to ANOTHER project — and the gate the
  // sync applies per project (aryeo.ts, the update pass) was applied to the job
  // that holds the ORDER, never to the job that holds the ROWS. That matters
  // because a delivered survivor is not an edge case, it is what every finished
  // merge looks like: the pair delivers once, so the survivor goes DELIVERED
  // while the donor keeps EDITING for ever (nothing moves it — it has no video
  // rows left, so it is off the Editing Room and nobody presses Completed on
  // it). Measured Sep 20: of 141 same-client/same-street pairs carrying an order
  // on both sides, 140 have a DELIVERED side. Without this, every hourly sweep,
  // every webhook and every press of "Refresh from Aryeo" on the donor would be
  // a live write path into a delivered client job — exactly what the note on
  // completeAbsorbedAddOnsFromOrder says is not to happen, and what Jordan was
  // explicit about: the first delivery is not disturbed.
  //
  // So this returns like a fee-only order does: nothing read, nothing written,
  // not even the stored line items. That is strictly more conservative than
  // before this change, and it still fixes the merge — the create loop never
  // runs, so the donor never re-mints the video it gave away.
  //
  // WHAT THIS GATE MAY NO LONGER DO IS SWALLOW A WHOLE LINE (Sep 20 2026
  // re-review). Holding an order change back from a delivered job is right;
  // losing it is not. A line this order sells that nothing owes anywhere — the
  // client bought a floor plan on the second order after the pair delivered —
  // was skipped in silence, hourly, for ever, and the only way it ever landed
  // was somebody undoing the merge. It rides home in mergeError instead, which
  // is the channel the caller already reads. Nothing is written either way.
  //
  // WHAT IT STILL HOLDS BACK IN SILENCE, SAID PLAINLY (Sep 20 2026 wave-3
  // review). `held` compares BY TYPE, so it catches a whole type nothing owes
  // and says nothing when an existing type's QUANTITY rises — the ordinary
  // Aryeo edit, and the one journey 3 is built on (a reel going 1 to 2). That
  // is a real gap and it is left open deliberately rather than by oversight:
  // the write this gate is holding back for a quantity rise is not "the order
  // sells more than the row says", it is
  // `Math.max(r.quantity, Math.max(1, want.quantity - manualOwed[type]))` over
  // the DEDUPED `want` map, with manual rows netted off (see the row loop and
  // the manualOwed note below). None of those three inputs exists yet at this
  // point in the function — this gate deliberately sits ahead of every read so
  // it can return having touched nothing — so a quantity-aware `held` here
  // would be a second, hand-copied definition of "how much does this order owe
  // for this type", drifting from the first the day either changes. The honest
  // fix is to move the gate below `own`/`want`/`manualOwed` and reuse them,
  // which is a restructure of this function and not a diagnostic tweak. Until
  // then: a quantity rise on a delivered pair's order is invisible here, and
  // the way it lands is still undoing the merge.
  //
  // Note what this gate can and cannot be reached by since the same review:
  // mergeProjectWork now REFUSES a destination the Editing Room cannot show
  // (editing/actions.ts), so a merge can no longer be made INTO a delivered
  // job. What is left is the honest shape — merged while both were live, then
  // delivered — and that is what this protects.
  if (rowHome !== projectId) {
    const home = await prisma.project.findUnique({ where: { id: rowHome }, select: { status: true } }).catch(() => null);
    if (!home || ["DELIVERED", "CANCELLED"].includes(home.status)) {
      const owed: { id: string; type: DeliverableType }[] | null = await prisma.deliverable
        .findMany({ where: { ...ownWhere(), removedFromOrderAt: null }, select: { id: true, type: true } })
        .catch(() => null);
      // A read that failed is an unknown, not "nothing owes this" — say nothing.
      const held = owed
        ? parsed.filter((p) => !owed.some((r) => r.type === p.type && !foreign.has(r.id))).map((p) => p.label)
        : [];
      if (held.length > 0) {
        out.mergeError = `${held.join(", ")} not filed: the job carrying this one's work is ${home ? home.status.toLowerCase() : "gone"}, so nothing owes it`.slice(0, 200);
        console.warn(`[aryeo-reconcile#${order.number ?? order.id ?? "?"}] ${projectId}: ${out.mergeError}`);
      }
      return out;
    }
  }

  const found = await prisma.deliverable.findMany({
    where: ownWhere(),
    select: { id: true, projectId: true, type: true, label: true, quantity: true, status: true, manual: true, removedFromOrderAt: true, uploadedAt: true, productTitle: true, videoStyle: true, createdAt: true },
  });
  // LIVE ROWS FIRST, THEN OLDEST (Sep 20 2026). The read had no orderBy at all,
  // so when a job carried two rows of one type — the ordinary shape after a
  // merge, and reachable before one through a photographer's manual extra reel
  // — which one the loop below kept and which one it retired was Postgres row
  // order. The same sweep could keep the original one hour and retire it the
  // next, orphaning whichever cuts hung off the loser.
  const rows = found
    .slice()
    .sort((a, b) =>
      Number(!!a.removedFromOrderAt) - Number(!!b.removedFromOrderAt) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
    );
  // The rows this ORDER answers for. A merged-in row belongs to the other job's
  // order and is left completely alone here.
  const own = rows.filter((r) => !foreign.has(r.id));
  // A ROW THE DONOR HAD ALREADY RETIRED STAYS RETIRED WHILE THE MERGE STANDS
  // (Sep 20 2026 review). previewMerge only carries rows that are still owed
  // (removedFromOrderAt: null), so a row this job retired BEFORE the merge is
  // still sitting here, on the job whose work has gone. If the order starts
  // selling that type again, un-retiring it in place brings the merged-away job
  // back onto the Editing Room owing a video nobody will ever find footage for
  // — the phantom job this whole fix is about, reached through the other branch,
  // while the create loop a few lines down would have put the identical business
  // event on the job that holds the work. So it is left exactly as it is, with
  // its note and its history, and the create loop mints the live row where the
  // work is. It is not moved: its own per-video rows and cuts hang off it by
  // projectId, and dragging a retired row between jobs inside an hourly sweep
  // is more invasive than the bug.
  const strandedOnDonor = (r: { projectId: string; removedFromOrderAt: Date | null }) =>
    !!movedAway && r.projectId === projectId && !!r.removedFromOrderAt;
  const want = new Map(parsed.map((p) => [p.type, p]));
  const orderNo = order.number ?? order.id ?? "?";
  // WHAT THE HUB ALREADY OWES OUTSIDE THE ORDER (Sep 18). A photographer who
  // shoots a second reel for a listing files it as a MANUAL Deliverable and
  // Kyle adds the matching line to the Aryeo order afterwards. The order then
  // says SOCIAL_REEL ×2 — one original, one extra — while the hub already holds
  // the extra as its own row. Raising the ORIGINAL row to 2 makes the job owe
  // three videos for two shoots, and cutSlots would relabel the video the
  // client already has as "Video 1 of 2".
  //
  // So the order's number is read as a TOTAL for the type and the manual rows
  // are taken off it before the original is raised. This is the only place two
  // sources of truth for one type can meet, because manual rows are skipped
  // everywhere else in this function by design.
  const manualOwed = new Map<string, number>();
  for (const r of own) {
    if (!r.manual || r.removedFromOrderAt) continue;
    manualOwed.set(r.type, (manualOwed.get(r.type) ?? 0) + Math.max(1, r.quantity ?? 1));
  }
  // …AND KYLE'S CARD HAS TO CLOSE FOR THAT ROW TOO (Sep 18 review, F3).
  // completeShootAddonTasksFor had exactly ONE caller: the create loop at the
  // bottom, right after a deliverable is minted. An extra reel is filed on a job
  // that already HAS a SOCIAL_REEL row, so the row loop below consumes the type
  // (`want.delete`) and the create loop never runs — the "Add to the order:
  // Extra reel shot Sep 18" card sat open indefinitely, which is the same
  // failure that loop's Sep 16 comment says was fixed, coming back through the
  // other branch. It runs BEFORE the OrderItem rows are replaced at the bottom
  // of this function, because those rows are the "before" it compares against.
  await completeAddOnsWhenOrderQuantityRose(projectId, order, own)
    .catch(() => { /* closing a stale card never breaks the reconcile */ });
  // Types this order says it moved elsewhere — orderDeliverables has already
  // struck them off `want`; this is only for the wording of the retire note.
  const moved = movedAwayTypes(order.items);

  for (const r of own) {
    if (r.manual || /added manually/i.test(r.label ?? "")) continue;
    // Not this order's to revive while its work lives on another job, and it
    // must not consume the order's line either — see strandedOnDonor.
    if (strandedOnDonor(r)) continue;
    const w = want.get(r.type);
    if (!w) {
      if (!r.removedFromOrderAt) {
        const movedTo = moved.get(r.type);
        await prisma.deliverable.update({
          where: { id: r.id },
          data: {
            removedFromOrderAt: new Date(),
            removedFromOrderNote: (movedTo
              ? `'${r.label ?? r.type}' moved to Aryeo order #${movedTo}`
              : `'${r.label ?? r.type}' is no longer on Aryeo order #${orderNo}`
            ).slice(0, 300),
            // The photographer's "couldn't complete" excuse is moot for an
            // item the order no longer carries.
            notCompletedReason: null,
            notCompletedAt: null,
          },
        });
        out.retired.push(r.label ?? r.type);
        // The office's "is this really not required?" card, if one was minted
        // off the photographer's note, is answered by the order itself now.
        try {
          const { confirmNotRequiredTask } = await import("@/lib/tasks");
          await confirmNotRequiredTask(r.id);
        } catch { /* best-effort */ }
      }
      continue;
    }
    // Back on the order — and note what is NOT reset here: Deliverable.waivedAt.
    // The waiver is the OFFICE's word ("not required on this job"), and the
    // Aryeo order will never say a package-implied floor plan was discounted
    // off, so a restore must not quietly re-owe it. Only a human unwaives
    // (projects/deliverableActions.ts).
    if (r.removedFromOrderAt) {
      // Back on the order. A previously-DONE row stays DONE only if its work
      // is still on the site — safest is PENDING unless the photographer
      // already uploaded for it; the status sweep re-derives DONE from Aryeo.
      await prisma.deliverable.update({
        where: { id: r.id },
        data: {
          removedFromOrderAt: null, removedFromOrderNote: null,
          label: w.label, quantity: w.quantity, productTitle: w.productTitle, videoStyle: w.videoStyle,
          ...(r.status === "DONE" ? { status: "PENDING" } : {}),
        },
      });
      out.restored.push(w.label);
    } else {
      // The order's quantity minus anything the hub already owes for this type
      // on its own (see manualOwed). Never below 1: an order line exists, so
      // the row it belongs to is owed at least once.
      const fromOrder = Math.max(1, w.quantity - (manualOwed.get(r.type) ?? 0));
      const relabel = (r.label ?? "") !== w.label || r.quantity < fromOrder;
      // Product identity (Sep 2 2026) follows the same in-place rule — the
      // row's id, and every cut/upload/verdict keyed on it, never changes.
      const identity = (r.productTitle ?? null) !== w.productTitle || (r.videoStyle ?? null) !== w.videoStyle;
      if (relabel || identity) {
        // Quantity only ever RISES here: the status sweep lifts a monthly plan's
        // video row to the plan quota (Starter 2 / Accelerator 4 / Pro 8) while
        // the order line says 1 — writing 1 back would ping-pong hourly.
        await prisma.deliverable.update({
          where: { id: r.id },
          data: { label: w.label, quantity: Math.max(r.quantity, fromOrder), productTitle: w.productTitle, videoStyle: w.videoStyle },
        });
        // Identity alone — a title/style filled in under a label that already
        // matched — is a silent repair, not an "order changed" event.
        if (relabel) out.relabeled.push(w.label);
      }
    }
    want.delete(r.type);
  }
  // Types on the order with no row at all (live, retired OR manual — one row
  // per type is the invariant, and an editor-added video plus a later video
  // line item must not become two).
  for (const [, w] of want) {
    // A row another job's order parked here does not answer this order's line:
    // the second shoot's reel sitting on the original job must not stop the
    // original job's own reel from being minted. A row stranded retired on a
    // merged-away job does not answer it either — the live row belongs with the
    // work now.
    if (own.some((r) => r.type === w.type && !strandedOnDonor(r))) continue;
    const data = {
      type: w.type, label: w.label, quantity: w.quantity, status: "PENDING" as const,
      productTitle: w.productTitle, videoStyle: w.videoStyle,
    };
    if (movedAway) {
      // ON THE JOB THAT CARRIES THE WORK, not the job that holds the order
      // (Sep 20 2026, audit F01). A line added to a merged-away job's order
      // belongs with the rest of that job's work, and creating it back on the
      // donor is what silently undid the merge every hour.
      //
      // THE MARKER APPEND IS THE PRECONDITION, NOT AN AFTERTHOUGHT (Sep 20
      // review). The marker is the only thing that can find this row again —
      // both for the undo and for the NEXT sweep, which looks for it by id. It
      // shipped as a best-effort append after the row already existed, so one
      // swallowed failure left a row on the survivor that neither job could
      // account for: the donor minted a replacement every hour and the survivor
      // retired each one in the same pass, "'2D Floorplan' is no longer on Aryeo
      // order #<n>", for ever, with nothing raising a hand. So the two land
      // together or neither lands, and an un-minted row is simply minted next
      // hour.
      let mintedId: string | null = null;
      try {
        mintedId = await prisma.$transaction(async (tx) => {
          const d = await tx.deliverable.create({ data: { ...data, projectId: rowHome }, select: { id: true } });
          const recorded = await mergeLib.recordMergedRow(tx, projectId, "deliverableIds", d.id);
          if (!recorded) throw new Error("merge marker would not take the row");
          return d.id;
        });
      } catch (e) {
        mintedId = null;
        const why = e instanceof Error ? e.message : String(e);
        out.mergeError = `'${w.label}' not filed: ${why}`.slice(0, 200);
        console.warn(`[aryeo-reconcile#${orderNo}] ${projectId}: ${out.mergeError}`);
      }
      if (!mintedId) continue;
      homeIds.push(mintedId);
    } else {
      await prisma.deliverable.create({ data: { ...data, projectId }, select: { id: true } });
    }
    out.added.push(w.label);
    // THE ADD-ON TASK IS ANSWERED BY THE ORDER ITSELF (Sep 16, Kyle call).
    // A photographer who logs an item the agent bought on site puts one
    // "Add to the order: <item>" card on Kyle's plate (upload/shootAddOns).
    // Kyle adds the line, this reconcile creates the row — and the card sat
    // OPEN anyway, because SHOOT_ADDON_PREFIX had no consumer: 2 Grace Cir's
    // "Add to the order: 2D Floorplan" was still open ten days after the
    // floor plan was added, delivered and paid for. Best-effort.
    try {
      await completeShootAddonTasksFor(projectId, w.type);
    } catch { /* closing a stale card never breaks the reconcile */ }
  }

  // Stored line items: replace wholesale when the set differs (same shape as
  // backfillOrderItems). Titles/amounts feed /billing, margins and trends.
  const nextItems = orderItemRows(order.items ?? []);
  if (nextItems.length > 0) {
    const cur = await prisma.orderItem.findMany({
      where: { projectId },
      select: { aryeoId: true, title: true, quantity: true, amount: true, isCanceled: true },
    });
    const sig = (r: { aryeoId: string | null; title: string; quantity: number; amount: number; isCanceled: boolean }) =>
      `${r.aryeoId ?? ""}|${r.title}|${r.quantity}|${r.amount}|${r.isCanceled}`;
    const same = cur.length === nextItems.length && cur.map(sig).sort().join("\n") === nextItems.map(sig).sort().join("\n");
    if (!same) {
      await prisma.$transaction([
        prisma.orderItem.deleteMany({ where: { projectId } }),
        prisma.orderItem.createMany({ data: nextItems.map((r) => ({ ...r, projectId })) }),
      ]);
      out.changed = true;
    }
  }

  const touched = out.retired.length + out.restored.length + out.added.length + out.relabeled.length > 0;
  if (touched) {
    out.changed = true;
    const bits = [
      out.retired.length ? `removed ${out.retired.join(", ")}` : null,
      out.added.length ? `added ${out.added.join(", ")}` : null,
      out.restored.length ? `restored ${out.restored.join(", ")}` : null,
      out.relabeled.length ? `relabeled ${out.relabeled.join(", ")}` : null,
    ].filter(Boolean).join(" · ");
    await prisma.activity.create({
      data: { projectId, type: "SYSTEM", body: `Order changed in Aryeo (#${orderNo}): ${bits}.`.slice(0, 1000) },
    }).catch(() => {});
    // AND ON THE JOB THE ROWS ACTUALLY SIT ON (Sep 20 2026 review). The line
    // above is written where the ORDER is. After a merge that is the job nobody
    // opens: the survivor is where Kyle and John work, and a video quietly
    // dropping off its owed list with nothing on its own timeline to explain it
    // is the same two-sided silence audit F01 was raised about. Nothing here
    // vanishes without a record, and the record belongs on the page where the
    // change shows up. The note on the row itself still names the order the row
    // belongs to, which is the donor's — that is correct, and this line is what
    // makes it read correctly on the survivor's page.
    if (rowHome !== projectId) {
      const donor = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } }).catch(() => null);
      const street = (donor?.title || "the merged job").split(",")[0].trim();
      await prisma.activity.create({
        data: {
          projectId: rowHome, type: "SYSTEM",
          body: `Aryeo order #${orderNo} changed on ${street}'s job, whose work is here: ${bits}. That job keeps its own order, so this is where the change lands.`.slice(0, 1000),
        },
      }).catch(() => {});
    }
    // The job's promise follows what is still owed.
    try {
      const { standardDeliveryDue } = await import("@/lib/tasks");
      const p = await prisma.project.findUnique({
        where: { id: projectId },
        select: { shootDate: true, packageName: true },
      });
      if (p?.shootDate) {
        // What this ORDER still owes, wherever its rows sit. Reading the job's
        // own `deliverables` would hand a merged-away job an empty list and
        // re-date its promise off nothing at all.
        const owed = await prisma.deliverable.findMany({
          where: { ...ownWhere(), removedFromOrderAt: null },
          select: { type: true, label: true },
        });
        const { isMonthlyContentJob } = await import("@/lib/pipeline");
        await prisma.project.update({
          where: { id: projectId },
          data: { deliveryDue: standardDeliveryDue(p.shootDate, owed, isMonthlyContentJob(owed, p.packageName)) },
        });
      }
    } catch { /* due refresh is best-effort */ }
    // A retired video takes its chases with it. edit_video only when nobody
    // hand-assigned it (the assignedManually invariant every engine respects).
    if (out.retired.length > 0) {
      // Counted the same way the rows were read (Sep 20 2026, audit F01). A
      // survivor is owed the videos the merge brought it — they sit on its own
      // projectId, so they count — and a merged-away job is owed the ones its
      // order still sells even though they live on the other job now. Counting
      // by bare projectId cancelled the edit card the merge had just carried
      // over, on a job that still owed the video.
      const owedVideo = await prisma.deliverable.count({
        where: { ...ownWhere(), removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
      });
      if (owedVideo === 0) {
        const { createHash } = await import("crypto");
        // Same shape as tasks.ts dedupe(): sha1 hex, first 24 chars.
        const notCompletableKey = createHash("sha1").update([projectId, "video-not-completable"].join("|")).digest("hex").slice(0, 24);
        await prisma.smartTask.updateMany({
          where: {
            // The merge carries this job's cards to the survivor, and all three
            // dedupe keys below already name the job they belong to, so the
            // card is found wherever it was moved to.
            projectId: { in: [projectId, rowHome] },
            status: { notIn: ["COMPLETED", "CANCELLED"] },
            OR: [
              { dedupeKey: `raw-video-missing-${projectId}` },
              { dedupeKey: `edit-video-${projectId}`, assignedManually: false },
              { dedupeKey: notCompletableKey }, // "video marked not completable — decide" is answered by the order itself
            ],
          },
          data: { status: "CANCELLED" },
        }).catch(() => {});
      }
    }
    // THE ORDER MOVED, SO THE PER-VIDEO ROWS MOVE (audit R06, Sep 18).
    //
    // A quantity change is the case that matters: "Video x2" becoming "Video
    // x4" is TWO more owed videos, and until now the two new rows appeared only
    // when somebody uploaded a cut — so the project view, the promise clock and
    // the delivery board counted two while the client had bought four. A line
    // leaving the order is the mirror: ensureOutputsForProject RETIRES the
    // slots that are no longer in the arithmetic (never deletes them), which is
    // what stops a video nobody owes sitting on the board.
    //
    // Only inside `touched` on purpose: the reconcile runs against every order
    // the hourly page scan returns, and three round trips per untouched job,
    // every hour, buys nothing the sweep does not already cover.
    const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
    // On the job the rows live on: ensureOutputsForProject plans and mints per
    // project, so running it on a merged-away job would look at an empty set
    // and leave the survivor's new slot unmaterialised.
    const ensured = await ensureOutputsSafely(rowHome, `aryeo-reconcile#${orderNo}`);
    if (!ensured.ok) out.outputsError = ensured.error;
  }
  return out;
}

/**
 * The line quantity a set of order lines implies for each type, SUMMED across
 * the lines.
 *
 * Deliberately not `orderDeliverables`, and this is the trap that has to be
 * written down (Sep 18 review, F3). dedupeParsedDeliverables collapses the
 * order to ONE parsed row per type and takes `Math.max` of the quantities,
 * because its job is to NAME a deliverable row, not to count lines. Kyle's
 * add-on card tells him, in those words, to add the extra reel as its OWN line
 * — and two separate reel lines of one each come back out of that max as ONE.
 * So the deduped number cannot tell "before Kyle" from "after Kyle" at all.
 * Summed across the raw lines, it can: 1 becomes 2.
 *
 * Moved-away types are struck off for the same reason orderDeliverables strikes
 * them: a "2D Floorplan — Moved to Order #1611" line is a negation, not a line
 * that raises anything.
 */
function impliedLineTotals(parsed: ParsedDeliverable[], moved: Map<DeliverableType, string>): Map<DeliverableType, number> {
  const out = new Map<DeliverableType, number>();
  for (const d of parsed) {
    if (moved.has(d.type)) continue;
    out.set(d.type, (out.get(d.type) ?? 0) + Math.max(1, d.quantity ?? 1));
  }
  return out;
}

/**
 * KYLE'S CARD CLOSES WHEN THE ORDER PICKS THE EXTRA LINE UP (Sep 18 review, F3).
 *
 * completeShootAddonTasksFor had exactly one caller: the create loop at the
 * bottom of reconcileDeliverablesToOrder, immediately after a deliverable is
 * minted. An extra shoot is filed on a job that ALREADY has a SOCIAL_REEL row,
 * so the row loop consumes the type and the create loop never runs — the card
 * sat open indefinitely, the same failure the Sep 16 comment in that loop says
 * was fixed.
 *
 * Nor can the DELIVERABLE row answer it. reconcile subtracts the hub's manual
 * rows from the order's number on purpose (`fromOrder`), so the original row
 * stays at quantity 1 whatever Kyle types — nothing on it ever changes.
 *
 * What DID change is the order, and the hub keeps the previous order in
 * OrderItem rows. So the signal is the honest one: the implied line total for
 * that type ROSE against what we last stored, on a type the hub is holding a
 * manual row for. No stored rows at all means no "before" to compare, and this
 * stays out of it rather than closing a card on a first sync.
 */
async function completeAddOnsWhenOrderQuantityRose(
  projectId: string,
  order: AryeoOrder,
  rows: { type: string; manual: boolean; removedFromOrderAt: Date | null }[],
): Promise<void> {
  const manualTypes = new Set(rows.filter((r) => r.manual && !r.removedFromOrderAt).map((r) => r.type));
  if (manualTypes.size === 0) return; // nothing outside the order → nothing to pick up
  const stored = await prisma.orderItem.findMany({
    where: { projectId, isCanceled: false },
    select: { title: true, quantity: true },
  });
  if (stored.length === 0) return; // no "before" — never guess on a first sync
  const moved = movedAwayTypes(order.items);
  const next = impliedLineTotals(
    (order.items ?? []).filter((it) => !it.is_canceled).flatMap(itemToDeliverables),
    moved,
  );
  const cur = impliedLineTotals(
    stored.flatMap((r) => deliverablesForTitle(r.title, r.quantity)),
    moved,
  );
  for (const t of manualTypes) {
    const type = t as DeliverableType;
    if ((next.get(type) ?? 0) > (cur.get(type) ?? 0)) {
      await completeShootAddonTasksFor(projectId, type).catch(() => { /* a stale card never breaks a sync */ });
    }
  }
}

/**
 * The same close, for a job the full reconcile will never touch.
 *
 * reconcileDeliverablesToOrder is gated on not-DELIVERED-or-CANCELLED, and 609
 * of the 646 non-cancelled jobs with a live video row are DELIVERED (measured
 * Sep 18) — which is most of the jobs an extra shoot happens on. That gate is
 * right and stays: a delivered job's rows, labels, quantities and retirements
 * are not to be rewritten by a later order edit, and Jordan was explicit that
 * the first delivery is not disturbed.
 *
 * But Kyle's card is not the delivery record. It is a to-do the order itself
 * has now answered, so this writes NOTHING to any deliverable, any project or
 * any OrderItem — it only ticks off a card nobody needs any more.
 *
 * HOW THIS AND THE EDITING RAIL (F2) INTERACT: they do not, and that is the
 * point. The rail fix (uploadHistory.OWES_AN_ADDITIONAL_SHOOT) puts the
 * delivered job in front of an editor off the hub's OWN manual row, without
 * waiting on Aryeo and without moving the job off DELIVERED. This one closes
 * the office's paperwork when the billing catches up, hours or days later.
 * Neither waits for the other, and neither is what files the extra video — the
 * upload portal already did that.
 */
async function completeAbsorbedAddOnsFromOrder(projectId: string, order: AryeoOrder): Promise<void> {
  const rows = await prisma.deliverable.findMany({
    where: { projectId, manual: true, removedFromOrderAt: null },
    select: { type: true, manual: true, removedFromOrderAt: true },
  });
  if (rows.length === 0) return;
  await completeAddOnsWhenOrderQuantityRose(projectId, order, rows);
}

/** Close the office's "Add to the order: <item>" cards whose item names this
 *  category — the line is now ON the order, which is the only proof that
 *  matters. Never re-opens anything and never touches a card a human already
 *  finished. */
async function completeShootAddonTasksFor(projectId: string, type: DeliverableType): Promise<number> {
  const { shootAddonKeyPrefix, addonSlugNamesType } = await import("@/app/upload/shootAddOns");
  const prefix = shootAddonKeyPrefix(projectId);
  const open = await prisma.smartTask.findMany({
    where: { dedupeKey: { startsWith: prefix }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, dedupeKey: true },
  });
  const hits = open.filter((t) => addonSlugNamesType((t.dedupeKey ?? "").slice(prefix.length), type)).map((t) => t.id);
  if (hits.length === 0) return 0;
  const r = await prisma.smartTask.updateMany({
    where: { id: { in: hits } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return r.count;
}

// ---- Postponed shoots -------------------------------------------------------
// The one card that keeps a dateless job alive: "Rebook — <street>". Minted
// when the appointment sync clears a shoot date because every Aryeo
// appointment is postponed/unscheduled, closed by the same sync the moment a
// scheduled date returns. Cancelled orders never get here (the order sync
// cancels the project first).
async function mintRebookTask(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true, clientId: true, status: true, aryeoMissingAt: true,
      client: { select: { name: true } },
      appointments: { select: { status: true, startAt: true, postponedAt: true } },
    },
  });
  if (!p || p.status === "CANCELLED" || p.status === "DELIVERED" || p.aryeoMissingAt) return;
  // Only a POSTPONED job ("we'll rebook") gets the card. A job whose
  // appointments were all CANCELED while the order stayed open is a
  // different conversation, and the card's wording would be wrong.
  const postponed = p.appointments.filter(
    (a) =>
      !(a.status ?? "").toUpperCase().startsWith("CANCEL") && // Aryeo keeps postponed_at on a later cancel
      ((a.status ?? "").toUpperCase() === "UNSCHEDULED" || (!!a.postponedAt && a.startAt === null)),
  );
  if (postponed.length === 0) return;
  const newestPostponedAt = postponed
    .map((a) => a.postponedAt?.getTime() ?? 0)
    .reduce((m, t) => Math.max(m, t), 0);
  const street = (p.title || "this job").split(",")[0].trim();
  const key = `rebook-${projectId}`;
  await prisma.smartTask.upsert({
    where: { dedupeKey: key },
    create: {
      taskType: "internal_instruction",
      title: `Rebook — ${street} (postponed, no new date)`.slice(0, 120),
      summary: `${p.client?.name ?? "The client"}'s shoot at ${street} was postponed in Aryeo and has no new date. It has dropped off the schedule, Ops Day and the confirmation texts until one is set — reach out and get it rebooked (or cancel the order if it's not happening). This closes itself when a scheduled appointment appears.`.slice(0, 500),
      reasonCreated: "Every Aryeo appointment on this job is postponed or unscheduled.",
      source: "system",
      priority: "HIGH",
      // Due the business day after it was postponed — an old postponement
      // arrives already overdue, which is the point (80 W Lancaster sat 12
      // days with nothing open).
      dueAt: new Date((newestPostponedAt || Date.now()) + 24 * 3600_000),
      assignedKey: "kyle",
      projectId,
      clientId: p.clientId,
      propertyAddress: p.title,
      dedupeKey: key,
    },
    // Re-open a closed one only if it was COMPLETED by a rebook that later fell
    // through again — a human CANCELLING it means "stop asking".
    update: {},
  }).catch(() => {});
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { status: true, completedAt: true } });
  // Kyle marking it Done ("they'll pick a date next week") stays done. Only a
  // postponement NEWER than that completion re-opens it.
  if (existing?.status === "COMPLETED" && newestPostponedAt > (existing.completedAt?.getTime() ?? Infinity)) {
    await prisma.smartTask.update({ where: { dedupeKey: key }, data: { status: "OPEN", completedAt: null } }).catch(() => {});
  }
}

// ---- Orphaned orders --------------------------------------------------------
// A job the hub still treats as live whose Aryeo order no longer exists (404:
// deleted or merged on their side). The list scan can never see these — an
// order that isn't there isn't listed — so nothing noticed: three live jobs
// kept chasing raws, minting QC, and queueing client texts against orders that
// were gone (Sep 1 2026 audit). One GET per active project, once a day.
//
// Policy: flag, stand down, ask. NEVER auto-cancel — a 404 can also mean the
// order was re-created under a new id, and cancelling would close real work.
const ORPHAN_STAND_DOWN = "aryeo-orphan-stand-down";
export async function flagOrphanedOrders(): Promise<{ checked: number; flagged: number; cleared: number; unreachable: number }> {
  // Live jobs — plus DELIVERED jobs still carrying an unpaid balance: an order
  // that no longer exists can't be paid through Aryeo, and four of them were
  // sitting in /billing as $875 of phantom AR (Sep 1 2026 audit).
  const active = await prisma.project.findMany({
    where: {
      aryeoOrderId: { not: null },
      OR: [
        { status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] } },
        { status: "DELIVERED", balanceAmount: { gt: 0 }, paidMarkedAt: null, arRemovedAt: null },
      ],
    },
    select: { id: true, title: true, aryeoOrderId: true, aryeoMissingAt: true, clientId: true, status: true },
  });
  let checked = 0, flagged = 0, cleared = 0, unreachable = 0;
  for (const p of active) {
    checked++;
    const isGone = (e: unknown) => e instanceof AryeoError && (e.status === 404 || e.status === 410);
    let missing = false;
    try {
      await Aryeo.order(p.aryeoOrderId!);
    } catch (e) {
      // Only a definitive "not there" counts. A timeout / 5xx / auth blip is
      // unknown — say nothing, try again next tick.
      if (!isGone(e)) { unreachable++; continue; }
      // Confirm once more before flagging — a routing blip must not pause a
      // live job's automations.
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await Aryeo.order(p.aryeoOrderId!);
      } catch (e2) {
        if (!isGone(e2)) { unreachable++; continue; }
        missing = true;
      }
    }
    const street = (p.title || "this job").split(",")[0].trim();
    const key = `aryeo-orphan-${p.id}`;
    if (missing && !p.aryeoMissingAt) {
      await prisma.project.update({ where: { id: p.id }, data: { aryeoMissingAt: new Date() } });
      // Stand down: every open production/pre-shoot task on a job whose order
      // is gone would chase a ghost. CANCELLED, not COMPLETED — history must
      // not claim the work happened. The decision task below is the one row
      // that stays.
      await prisma.smartTask.updateMany({
        where: {
          projectId: p.id,
          taskType: { in: ["confirmation_text", "appointment_prep", "media_qa", "delivery", "finish_delivery", "delivery_text", "edit_video"] },
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          assignedManually: false,
        },
        // Marked, so the clear branch below can put exactly these back — the
        // reconciler never re-mints a CANCELLED dedupe key on its own.
        data: { status: "CANCELLED", sourceDetail: ORPHAN_STAND_DOWN },
      }).catch(() => {});
      await prisma.activity.create({
        data: {
          projectId: p.id, type: "SYSTEM",
          body: "Order no longer exists in Aryeo (404). Automations are paused on this job until someone decides: cancel it here, or re-link it to the right order.",
        },
      }).catch(() => {});
      await prisma.smartTask.upsert({
        where: { dedupeKey: key },
        create: {
          taskType: "internal_instruction",
          title: `Order gone from Aryeo — ${street}`.slice(0, 120),
          summary: (p.status === "DELIVERED"
            ? `The Aryeo order behind ${street} returns "not found" but the job still shows an unpaid balance here. It can't be paid through Aryeo any more — write it off (remove from AR), mark it paid if it was settled another way, or re-link it to the right order.`
            : `The Aryeo order behind ${street} returns "not found". The hub still holds it as a live job, so its automations (status checks, client texts, editor chases) are paused. Decide: was it deleted or re-created in Aryeo? Cancel the job here, or update its Aryeo order id on the project page.`).slice(0, 500),
          reasonCreated: "Aryeo returned 404 for this project's order.",
          source: "system",
          priority: "HIGH",
          dueAt: new Date(Date.now() + 24 * 3600_000),
          assignedKey: "kyle",
          projectId: p.id,
          clientId: p.clientId,
          propertyAddress: p.title,
          dedupeKey: key,
        },
        update: {},
      }).catch(() => {});
      try {
        const { notifyInApp } = await import("@/lib/notify");
        await notifyInApp({
          kind: "system",
          title: `Order gone from Aryeo — ${street}`,
          href: `/projects/${p.id}`,
          targets: [{ roles: ["OWNER", "ADMIN"] }],
          dedupeKey: key,
        });
      } catch { /* bell is best-effort */ }
      flagged++;
    } else if (!missing && p.aryeoMissingAt) {
      await prisma.project.update({ where: { id: p.id }, data: { aryeoMissingAt: null } });
      await prisma.smartTask.updateMany({
        where: { dedupeKey: key, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "COMPLETED", completedAt: new Date() },
      }).catch(() => {});
      // "Resumed" has to mean it: put back the tasks the stand-down cancelled
      // and let the reconciler refresh their due dates.
      await prisma.smartTask.updateMany({
        where: { projectId: p.id, status: "CANCELLED", sourceDetail: ORPHAN_STAND_DOWN },
        data: { status: "OPEN", sourceDetail: null },
      }).catch(() => {});
      try {
        const { generateTasksForProject } = await import("@/lib/tasks");
        await generateTasksForProject(p.id);
      } catch { /* best-effort */ }
      await prisma.activity.create({
        data: { projectId: p.id, type: "SYSTEM", body: "Order is back in Aryeo — automations resumed and the paused tasks re-opened." },
      }).catch(() => {});
      cleared++;
    }
  }
  return { checked, flagged, cleared, unreachable };
}

// ---- Full-reconcile cursor ---------------------------------------------------
// One JSON row in AppSetting. `page` = next page to process (1 = a fresh pass);
// `startedAt` = when the current pass began (null between passes);
// `lastCompletedAt` = the last time a pass reached the end of the history —
// the number /connections shows so "the safety net ran" is provable.
export const RECONCILE_CURSOR_KEY = "aryeo:fullReconcile";
export type ReconcileCursor = { page: number; startedAt: string | null; lastCompletedAt: string | null };

export async function readReconcileCursor(): Promise<ReconcileCursor> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: RECONCILE_CURSOR_KEY }, select: { value: true } });
    const c = row ? (JSON.parse(row.value) as Partial<ReconcileCursor>) : null;
    const page = Number(c?.page);
    return {
      page: Number.isInteger(page) && page >= 1 ? page : 1,
      startedAt: typeof c?.startedAt === "string" ? c.startedAt : null,
      lastCompletedAt: typeof c?.lastCompletedAt === "string" ? c.lastCompletedAt : null,
    };
  } catch {
    return { page: 1, startedAt: null, lastCompletedAt: null };
  }
}

async function writeReconcileCursor(c: ReconcileCursor): Promise<void> {
  const value = JSON.stringify(c);
  await prisma.appSetting
    .upsert({ where: { key: RECONCILE_CURSOR_KEY }, create: { key: RECONCILE_CURSOR_KEY, value }, update: { value } })
    .catch(() => { /* cursor persistence is best-effort — worst case a page is re-done */ });
}

// Backfill payableInvoice on existing projects by re-reading each order's items
// (excludes canceled + virtual/AI). Run once after adding the field; cheap going
// forward since new orders set it at import.
// Backfill OrderItem rows for orders imported before the table existed (and
// refresh any that changed). One Aryeo call per order, so it is scoped by date
// and safe to re-run — items are replaced wholesale per project, never merged.
// Deliverables are NOT touched: production status stays exactly as it is.
export async function backfillOrderItems(opts: { since?: Date; limit?: number } = {}): Promise<{
  scanned: number; withItems: number; itemsWritten: number; failed: number;
}> {
  const { prisma } = await import("@/lib/prisma");
  const projects = await prisma.project.findMany({
    where: {
      aryeoOrderId: { not: null },
      ...(opts.since ? { orderedAt: { gte: opts.since } } : {}),
    },
    select: { id: true, aryeoOrderId: true, _count: { select: { orderItems: true } } },
    orderBy: { orderedAt: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  let scanned = 0, withItems = 0, itemsWritten = 0, failed = 0;
  for (const p of projects) {
    scanned++;
    try {
      const order = await Aryeo.order(p.aryeoOrderId!);
      const rows = orderItemRows(order?.items ?? []);
      if (rows.length === 0) continue;
      await prisma.$transaction([
        prisma.orderItem.deleteMany({ where: { projectId: p.id } }),
        prisma.orderItem.createMany({ data: rows.map((r) => ({ ...r, projectId: p.id })) }),
      ]);
      withItems++;
      itemsWritten += rows.length;
    } catch {
      failed++;
    }
  }
  return { scanned, withItems, itemsWritten, failed };
}

export async function backfillPayableInvoice(): Promise<{ updated: number; scanned: number }> {
  let page = 1;
  const perPage = 50;
  let updated = 0;
  let scanned = 0;
  for (let i = 0; i < 60; i++) {
    const res = await aryeoRequest<{ data: AryeoOrder[]; meta?: { last_page?: number } }>("/orders", {
      query: { include: "items", page, per_page: perPage },
    });
    const batch = res?.data ?? [];
    if (batch.length === 0) break;
    for (const order of batch) {
      if (!order.id) continue;
      scanned++;
      const val = payableInvoiceFromItems(order.items ?? [], money(order.total_amount));
      const r = await prisma.project.updateMany({
        where: { aryeoOrderId: order.id },
        data: { payableInvoice: val },
      });
      updated += r.count;
    }
    const last = res?.meta?.last_page;
    if (last ? page >= last : batch.length < perPage) break;
    page++;
  }
  return { updated, scanned };
}

// ---------------------------------------------------------------------------
// Sync the service catalogue from /products into our Product table.
// ---------------------------------------------------------------------------
export async function syncAryeoProducts(): Promise<{ products: number }> {
  const products = await Aryeo.products();
  let count = 0;
  for (const p of products) {
    if (!p.id) continue;
    const variants = (p.variants ?? []).map((v) => ({
      title: v.title,
      price_amount: v.price_amount,
      duration: v.duration,
    }));
    const prices = variants.map((v) => v.price_amount).filter((n): n is number => typeof n === "number");
    const tagNames = [...new Set((p.tags ?? []).map((t) => t.name || t.title).filter(Boolean))] as string[];
    const tagsJson = tagNames.length ? JSON.stringify(tagNames) : null;
    await prisma.product.upsert({
      where: { aryeoId: p.id },
      create: {
        aryeoId: p.id,
        title: p.title ?? "Untitled product",
        type: p.type ?? null,
        category: p.categories?.[0]?.title ?? null,
        active: p.active ?? true,
        isTwilight: p.is_twilight ?? false,
        aryeoServiceable: p.is_serviceable ?? null,
        description: p.description ?? null,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        variants: variants.length ? JSON.stringify(variants) : null,
        tags: tagsJson,
      },
      update: {
        title: p.title ?? "Untitled product",
        type: p.type ?? null,
        category: p.categories?.[0]?.title ?? null,
        active: p.active ?? true,
        isTwilight: p.is_twilight ?? false,
        aryeoServiceable: p.is_serviceable ?? null,
        description: p.description ?? null,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        variants: variants.length ? JSON.stringify(variants) : null,
        tags: tagsJson,
      },
    });
    count++;
  }
  return { products: count };
}

// ---------------------------------------------------------------------------
// CUSTOMER NOTES — one list, and Aryeo owns it.
//
// Aryeo keeps a single free-text "internal notes" field per customer. That is
// the system of record (Jordan, Sep 2: "I just want to make sure we don't have
// different customer notes in different spots"); `Client.generalNotes` is only
// our mirror of it, and a note typed in the hub is pushed straight back.
//
// Probed read-only against the LIVE API on Sep 2 2026 (Aryeo's public docs list
// neither of the per-customer routes, so this was settled by OPTIONS, which
// mutates nothing):
//   GET     /customers              → the customer GROUP carries `internal_notes`
//   GET     /customers/{id}         → same field, single record (undocumented, works)
//   OPTIONS /customers/{id}/notes   → Allow: PUT            ← the write door
//   OPTIONS /customers/{id}         → Allow: GET,HEAD,PATCH,DELETE  (fallback)
//   OPTIONS /customer-users         → Allow: GET,HEAD,POST — and there is NO
//                                     per-id route at all (GET /customer-users/{id}
//                                     404s), so that projection can be read in
//                                     bulk but never written.
// `/customers/{id}/notes` is the customer twin of the documented
// `PUT /orders/{order_id}/notes`, whose body is `{ internal_notes }` — the same
// shape used here. Customer ids and customer-user ids are the SAME id space (all
// 366 accounts overlap), so `Client.aryeoCustomerId` addresses either.
//
// Aryeo stores the note as rich text (`<div>…</div>`); the hub edits it as plain
// text. We convert on both legs and compare on the PLAIN TEXT — markup Aryeo
// re-serialises must never read as "someone changed the note".
// ---------------------------------------------------------------------------

// Deliberately a whitelist of the tags Aryeo's notes editor emits, not "any
// <word>": a client note really can read "shoot the <front door> first", and
// that has to survive verbatim rather than being eaten as markup.
const NOTE_TAGS = "div|p|br|span|strong|b|em|i|u|ul|ol|li|h[1-6]|a|blockquote|table|tbody|tr|td|font|hr|img";
const looksHtml = (s: string) =>
  new RegExp(`<\\/?(?:${NOTE_TAGS})\\b[^>]*>|&(?:nbsp|amp|lt|gt|quot|apos|#\\d+);`, "i").test(s);

// Aryeo's rich text → what the hub shows in a textarea. Plain text is passed
// through UNTOUCHED (older hub notes were saved as plain text, and so is
// anything typed in the box), which also makes this idempotent — running it
// over an already-converted note can't eat what it converted last time.
export function notesHtmlToText(html?: string | null): string {
  if (!html) return "";
  if (!looksHtml(html)) {
    return html.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return (
    html
      .replace(/\r\n?/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Bullets open the line; the closing </li> is left to the generic strip
      // below, or every list item would come out double-spaced.
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<\/(?:div|p|h[1-6]|tr|ul|ol|blockquote)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      // Entities last, and `&amp;` LAST of all — decoding it first would turn a
      // literal "&lt;" written by the client into a real tag.
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// What the hub typed → the rich text Aryeo's own notes editor renders. One
// `<div>` per line keeps the line breaks people actually typed.
export function notesTextToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim() ? `<div>${esc(line)}</div>` : "<div><br /></div>"))
    .join("");
}

// Same note? Compared on the plain text with whitespace collapsed, so neither
// Aryeo's markup nor a trailing newline counts as a divergence.
export function sameCustomerNote(a?: string | null, b?: string | null): boolean {
  const norm = (s?: string | null) => notesHtmlToText(s).replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

export type AryeoNotesRead =
  | { ok: true; text: string; raw: string | null }
  | { ok: false; error: string };

// Read a customer's notes straight from Aryeo (the system of record).
export async function readAryeoCustomerNotes(aryeoCustomerId: string): Promise<AryeoNotesRead> {
  try {
    const r = await aryeoRequest<{ data?: { internal_notes?: string | null } }>(
      `/customers/${aryeoCustomerId}`,
      { timeoutMs: 8000 },
    );
    const raw = r?.data?.internal_notes ?? null;
    return { ok: true, text: notesHtmlToText(raw), raw };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach Aryeo." };
  }
}

export type AryeoNotesWrite =
  | { ok: true; text: string; raw: string | null }
  | { ok: false; error: string };

// Write a customer's notes back to Aryeo, then READ THEM BACK to prove it
// landed. The verify leg is not belt-and-braces: these customer routes are
// undocumented, and a field the API doesn't recognise can be accepted and
// quietly dropped — which would look exactly like success while the two lists
// silently diverged, the one outcome this whole path exists to prevent. Never
// retried (a write isn't safe to replay blindly); the caller keeps the local
// copy and shows the failure.
export async function writeAryeoCustomerNotes(
  aryeoCustomerId: string,
  plainText: string,
): Promise<AryeoNotesWrite> {
  const text = plainText.trim();
  const html = text ? notesTextToHtml(text) : "";
  const body = { internal_notes: html };
  try {
    await aryeoRequest(`/customers/${aryeoCustomerId}/notes`, { method: "PUT", body, timeoutMs: 12000 });
  } catch (e) {
    // Only a MISSING route falls back to patching the customer itself. Anything
    // else (auth, validation, a 500) is a real answer from the notes endpoint
    // and must be reported, not papered over with a second write.
    const status = e instanceof AryeoError ? e.status : undefined;
    if (status !== 404 && status !== 405) {
      return { ok: false, error: e instanceof Error ? e.message : "Aryeo rejected the note." };
    }
    try {
      await aryeoRequest(`/customers/${aryeoCustomerId}`, { method: "PATCH", body, timeoutMs: 12000 });
    } catch (e2) {
      return { ok: false, error: e2 instanceof Error ? e2.message : "Aryeo rejected the note." };
    }
  }

  const back = await readAryeoCustomerNotes(aryeoCustomerId);
  if (!back.ok) {
    return { ok: false, error: `Aryeo accepted the note but we couldn't confirm it: ${back.error}` };
  }
  if (!sameCustomerNote(back.text, text)) {
    return {
      ok: false,
      error:
        "Aryeo took the request but the note didn't change on their side — the notes field may be read-only for this API key.",
    };
  }
  return { ok: true, text: back.text, raw: back.raw };
}

// ---------------------------------------------------------------------------
// Enrich clients from /customer-users. The customer object embedded on orders
// is a GROUP (name/email/phone only) — it does NOT carry the agent's license #,
// brokerage, or internal notes. Those live on the customer-user record, so we
// match by email and backfill any EMPTY client fields (never overwrite edits).
// The ONE exception is customer notes: Aryeo owns those, so its copy wins — but
// only on a client actually LINKED to an Aryeo customer, and only from that
// linked record. Email alone can fill a blank; it can never replace words a
// human typed. See the adopt rules inline below.
// ---------------------------------------------------------------------------
export async function syncAryeoCustomers(): Promise<{ enriched: number }> {
  const { prisma } = await import("@/lib/prisma");
  const customers = await Aryeo.customerUsers();
  const byEmail = new Map<string, AryeoCustomerUser>();
  for (const c of customers) if (c.email) byEmail.set(c.email.toLowerCase(), c);
  if (byEmail.size === 0) return { enriched: 0 };

  const clients = await prisma.client.findMany({
    where: { email: { not: null } },
    select: {
      id: true, email: true, phone: true, company: true, licenseNumber: true,
      generalNotes: true, aryeoCustomerId: true, notesSyncError: true, avatarUrl: true,
    },
  });
  let enriched = 0;
  for (const cl of clients) {
    const cu = byEmail.get((cl.email ?? "").toLowerCase());
    if (!cu) continue;
    const data: Record<string, string | Date | null> = {};
    if (!cl.phone && cu.phone) data.phone = cu.phone;
    if (!cl.company && cu.agent_company_name) data.company = cu.agent_company_name;
    if (!cl.licenseNumber && cu.agent_license_number) data.licenseNumber = cu.agent_license_number;
    // The headshot is a MIRROR, not a backfill: Aryeo owns it, nobody edits it
    // here, so a photo changed or removed over there follows on the next run.
    if ((cu.avatar_url ?? null) !== cl.avatarUrl) data.avatarUrl = cu.avatar_url ?? null;

    // Customer notes are NOT a backfill-if-empty field like the three above:
    // Aryeo owns them, so an edit made over there has to reach the hub or the
    // two lists drift apart again (before this, the mirror was written once on
    // import and never refreshed). Three guards keep the adopt safe:
    //  1. Only a LINKED client (aryeoCustomerId) may be adopted onto. The match
    //     above is by email ALONE — enough to fill a blank field, nowhere near
    //     enough to replace words somebody typed. With no link there is also no
    //     way back: saveCustomerNotes calls an unlinked client's note honestly
    //     hub-only and clears notesSyncError, so guard 3 can never fire for it
    //     either. Without this gate, a note Kyle wrote on an unlinked client was
    //     silently replaced by whatever sat on a same-email Aryeo record, every
    //     run, with nothing pushing his words back. 7 notes live on unlinked
    //     clients today (2 of them inside this loop's email-bearing population).
    //  2. An EMPTY note in Aryeo never overwrites words we hold — a blank remote
    //     is far more likely to be "nobody has written one there" than "delete
    //     what the hub has".
    //  3. An unsynced local edit (notesSyncError) is left alone — somebody typed
    //     here, the write-back failed, and their words must survive until the
    //     retry lands. The client card shows that state in red.
    const incomingText = notesHtmlToText(cu.internal_notes);
    if (cl.aryeoCustomerId && incomingText && !cl.notesSyncError && !sameCustomerNote(cl.generalNotes, cu.internal_notes)) {
      // The projection above only decides whether it's worth looking. The words
      // we actually adopt come from the LINKED customer GROUP (/customers/{id}),
      // which is both the system of record and the same door the write-back
      // uses — never from the email-matched row. If that read fails we skip this
      // round rather than fall back to the projection: an unconfirmed copy is
      // exactly what this check exists to refuse, and the next run retries.
      const authoritative = await readAryeoCustomerNotes(cl.aryeoCustomerId);
      const incoming = authoritative.ok ? authoritative.raw : null;
      if (notesHtmlToText(incoming) && !sameCustomerNote(cl.generalNotes, incoming)) {
        data.generalNotes = incoming!;
        data.notesSyncedAt = new Date();
      }
    }

    if (Object.keys(data).length > 0) {
      await prisma.client.update({ where: { id: cl.id }, data });
      enriched++;
    }
  }
  return { enriched };
}

// ---------------------------------------------------------------------------
// A NEW ARYEO CONTACT BECOMES A CLIENT THE MOMENT WE HEAR ABOUT IT.
//
// Jordan (Sep 7 2026): "if they were not in our system before and are added as
// a contact [which should be done via webhook with Aryeo], any new clients
// added to Aryeo should be added here and start getting tracked."
//
// Before this, the CUSTOMER_* webhook only ran syncAryeoCustomers(), which
// ENRICHES clients it can match by email and creates nobody. The only door that
// created was syncAllAryeoClients() on the daily cron, so a contact added in
// Aryeo at 9am was invisible here until the small hours — a whole day in which
// nothing pinged, no profile existed and no welcome text could fire.
//
// THIS FUNCTION DOES NOT GET TO MINT A TWIN. That engine has been burned twice
// (the order sync's resolveClient, then this file's own roster sweep) by
// re-creating a client a merge had just repaired, so the match order here is
// deliberately the SAME one those two use, strongest signal first:
//   1. a row that already owns this Aryeo id  → it is this person, whatever
//      their email says now (emails drift; the id does not)
//   2. primary email
//   3. phone AND the same name (two agents share an office line — a bare phone
//      match would collapse them into one client)
//   4. name + brokerage
//   5. backupEmail AND the same name (a backup address is often a shared team
//      inbox, and after a twin merge it is the load-bearing identity key)
// Only a true stranger is created, and a hit only ever has EMPTY identity slots
// filled — an occupied aryeoCustomerId or backupEmail is never overwritten.
// ---------------------------------------------------------------------------

/** What the webhook needs back: which client this was, and whether WE made it. */
export type AryeoClientUpsert = {
  clientId: string;
  name: string;
  /** True only when this call minted the row. The ping, the brief and the
   *  welcome text all hang off this, so it must never be true for an adopt. */
  created: boolean;
};

const CLIENT_IDENT = {
  id: true, name: true, email: true, backupEmail: true, phone: true, aryeoCustomerId: true,
  createdAt: true, firstSeenAt: true,
} as const;

// THE RACE THIS CLOSES. Aryeo fires CUSTOMER_CREATED and ORDER_CREATED for the
// same new agent within seconds, and webhook delivery order is not promised. If
// the ORDER lands first, syncAryeoOrders' resolveClient mints the row (it has
// to — the order needs a client), and the CUSTOMER event that follows would
// then find an existing row, report `created: false`, and silently drop the
// ping, the brief and the welcome text for exactly the clients Jordan cares
// most about: the ones who booked.
//
// So a matched row that has never been stamped and was born minutes ago is
// still a NEW client, and gets stamped and announced. Twelve hours is far more
// than any delivery race or webhook retry needs, and short enough that no bulk
// import can be mistaken for an arrival. Anything older is left alone.
const RACE_WINDOW_MS = 12 * 3600_000;

export async function upsertAryeoCustomerClient(
  cust: AryeoCustomer,
  opts: { via?: string; altIds?: (string | null | undefined)[] } = {},
): Promise<AryeoClientUpsert | null> {
  const { prisma } = await import("@/lib/prisma");
  const { phoneKey } = await import("@/lib/integrations/openphone");
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

  // customerName() falls back to the literal string "Unknown client" — four of
  // those were minted through the order sync on Sep 7 alone. A nameless payload
  // is not a person we can welcome, ping about, or write a brief for, so this
  // door refuses it outright rather than adding to that pile.
  // A payload with no name would otherwise be named after its email address —
  // and then texted "Hey foo@kw.com" (review, Sep 7). Refuse it.
  const name = (cust.name || "").trim();
  if (!name || name.toLowerCase() === (cust.email ?? "").trim().toLowerCase()) return null;
  const email = (cust.email ?? "").trim().toLowerCase() || null;
  // Aryeo's flat CUSTOMER webhook is a GROUP object; the same person also has a
  // USER id nested under `owner`/`users[0]` (identical on every live payload
  // checked, but the API does not promise that). Both are candidates for the
  // aryeoCustomerId slot, so we search on all of them.
  const ids = [...new Set([cust.id, ...(opts.altIds ?? [])].filter((v): v is string => !!v && !!v.trim()))];

  const pk = phoneKey(cust.phone);
  const company = norm(cust.office_name);

  // The five signals, in order. Returns the row or null — re-run after a lost
  // claim race below, so it lives in one place.
  const findExisting = async () => {
    if (ids.length > 0) {
      const byId = await prisma.client.findFirst({ where: { aryeoCustomerId: { in: ids } }, select: CLIENT_IDENT });
      if (byId) return byId;
    }
    if (email) {
      const byEmail = await prisma.client.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: CLIENT_IDENT,
      });
      if (byEmail) return byEmail;
    }
    // Signals 3 and 4 both require the same NAME, so one query serves both:
    // phone matching is done in JS because the stored numbers are free-form
    // ("(610) 555-0134", "+16105550134") and only phoneKey() can compare them.
    if (pk.length === 10 || company) {
      const sameName = await prisma.client.findMany({
        where: { name: { equals: name, mode: "insensitive" } },
        select: { ...CLIENT_IDENT, company: true },
      });
      const named = sameName.filter((c) => norm(c.name) === norm(name));
      if (pk.length === 10) {
        const byPhone = named.find((c) => phoneKey(c.phone) === pk);
        if (byPhone) return byPhone;
      }
      if (company) {
        const byNameCo = named.find((c) => norm(c.company) === company);
        if (byNameCo) return byNameCo;
      }
    }
    if (email) {
      const byBackup = await prisma.client.findFirst({
        where: { backupEmail: { equals: email, mode: "insensitive" } },
        select: CLIENT_IDENT,
      });
      // Name corroboration: a shared team inbox sitting in someone's backup slot
      // must not swallow a different agent who happens to use it.
      if (byBackup && norm(byBackup.name) === norm(name)) return byBackup;
    }
    return null;
  };

  const existing = await findExisting();
  if (existing) {
    // Adopt: fill EMPTY identity slots only. Step 1 already proved no row owns
    // any of these Aryeo ids, so taking the @unique slot cannot collide.
    const takeId = ids[0] && !existing.aryeoCustomerId ? ids[0] : null;
    const takeBackup = email && !existing.backupEmail && norm(existing.email) !== email ? cust.email! : null;
    // …and the race above: a row minted minutes ago by the ORDER webhook, which
    // this is the first CUSTOMER event to reach. Stamped exactly once — a row
    // that already carries firstSeenAt has been through here before.
    const raceWinner =
      !existing.firstSeenAt && existing.createdAt.getTime() > Date.now() - RACE_WINDOW_MS;
    // An order with no customer object on it mints a row literally named
    // "Unknown client" (customerName's last-resort fallback — four such rows
    // were made on Sep 7 alone). That is the sync's own placeholder, never
    // something a person typed, so when the CUSTOMER event finally brings a
    // real name it is safe to fill in — and it stops the dashboard card and the
    // ping from announcing "New client: Unknown client".
    const fixName = existing.name === "Unknown client" && name !== "Unknown client" ? name : null;
    let wrote = false;
    if (takeId || takeBackup || raceWinner || fixName) {
      wrote = await prisma.client
        .update({
          where: { id: existing.id },
          data: {
            ...(takeId ? { aryeoCustomerId: takeId } : {}),
            ...(takeBackup ? { backupEmail: takeBackup } : {}),
            ...(fixName ? { name: fixName } : {}),
            // Their real arrival is when the ROW was made, not this moment —
            // the welcome text's 30-day cap measures from it.
            ...(raceWinner ? { firstSeenAt: existing.createdAt, firstSeenVia: opts.via ?? "aryeo-webhook" } : {}),
          },
        })
        .then(() => true)
        .catch(() => false);
    }
    // `created` gates the ping, the brief and (through firstSeenAt) the welcome
    // text, so it may only be true if the stamp actually LANDED. Announcing a
    // client whose firstSeenAt failed to write would put a card on the dashboard
    // that the next render cannot find.
    return { clientId: existing.id, name: (wrote && fixName) || existing.name, created: raceWinner && wrote };
  }

  // Nobody matched, so this would be a new person — but a payload carrying
  // neither an Aryeo id nor an email is not a person we can identify, dedupe or
  // ever contact. Matching on a bare name+phone is fine (it can only ever ADOPT
  // onto someone we already know); minting off one is how the identity-less
  // rows get made. So the guard sits here, on the create, not on the lookup.
  if (ids.length === 0 && !email) return null;

  // CLAIM BEFORE CREATING. Aryeo fires these in bursts — six byte-identical
  // GROUP payloads for one agent inside 30 seconds on Sep 7 — and two of them
  // in flight together would each miss the other's half-written row. The unique
  // AppSetting key is the same atomic-claim pattern the text sweeps use.
  const claim = `aryeo-new-client-${ids[0] ?? email}`;
  try {
    await prisma.appSetting.create({ data: { key: claim, value: new Date().toISOString() } });
  } catch {
    // Someone else owns this create. Read back what they made rather than
    // racing them; if the row has since been merged away the daily
    // syncAllAryeoClients sweep remains the backstop that re-creates it.
    const again = await findExisting();
    return again ? { clientId: again.id, name: again.name, created: false } : null;
  }
  try {
    const row = await prisma.client.create({
      data: {
        name,
        email: cust.email ?? null,
        phone: cust.phone ?? null,
        company: cust.office_name ?? null,
        licenseNumber: cust.license_number ?? null,
        // Straight from Aryeo → the note mirror starts in sync (same rule as the
        // two other create sites; a fresh row must not warn about its own note).
        generalNotes: cust.internal_notes ?? null,
        notesSyncedAt: cust.internal_notes ? new Date() : null,
        aryeoCustomerId: ids[0] ?? null,
        avatarUrl: cust.avatar_url ?? null,
        firstSeenAt: new Date(),
        firstSeenVia: opts.via ?? "aryeo-webhook",
      },
      select: { id: true, name: true },
    });
    return { clientId: row.id, name: row.name, created: true };
  } catch {
    // The create failed (most likely the @unique aryeoCustomerId was taken
    // between the search and the write). Release the claim so a later event can
    // try again, and report whatever is actually on file now.
    await prisma.appSetting.delete({ where: { key: claim } }).catch(() => {});
    const again = await findExisting();
    return again ? { clientId: again.id, name: again.name, created: false } : null;
  }
}

// Import the FULL Aryeo client roster (every customer-user), not just the ones
// who placed a recent order. Matches existing clients with the SAME identity
// signals as the order sync's resolveClient — email/backupEmail, then phone +
// same name, then name+company — and ADOPTS onto a hit instead of creating.
// Without those signals this daily sweep was the second twin-minting door: a
// merged-away address (living on only as backupEmail) re-created the twin the
// merge had just repaired. Idempotent — only creates true strangers.
export async function syncAllAryeoClients(): Promise<{ created: number; scanned: number }> {
  const { prisma } = await import("@/lib/prisma");
  const { phoneKey } = await import("@/lib/integrations/openphone");
  const customers = await Aryeo.customerUsers();
  const existing = await prisma.client.findMany({
    select: { id: true, email: true, backupEmail: true, phone: true, name: true, company: true, aryeoCustomerId: true },
  });
  const normId = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const byEmail = new Map<string, string>();
  const byBackupEmail = new Map<string, { id: string; name: string }>();
  const byPhone = new Map<string, { id: string; name: string }>();
  const byNameCo = new Map<string, string>();
  const byAryeoId = new Map<string, string>();
  const hasAryeoId = new Set<string>();
  const hasBackupEmail = new Set<string>();
  const usedAryeoId = new Set(existing.map((c) => c.aryeoCustomerId).filter(Boolean) as string[]);
  for (const c of existing) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c.id);
    if (c.aryeoCustomerId) { byAryeoId.set(c.aryeoCustomerId, c.id); hasAryeoId.add(c.id); }
    if (c.backupEmail) hasBackupEmail.add(c.id);
    const pk = phoneKey(c.phone);
    if (pk.length === 10 && !byPhone.has(pk)) byPhone.set(pk, { id: c.id, name: c.name });
    const nc = normId(c.name) && normId(c.company) ? `${normId(c.name)}|${normId(c.company)}` : null;
    if (nc && !byNameCo.has(nc)) byNameCo.set(nc, c.id);
  }
  for (const c of existing) {
    const be = c.backupEmail?.toLowerCase();
    if (be && !byEmail.has(be) && !byBackupEmail.has(be)) byBackupEmail.set(be, { id: c.id, name: c.name });
  }

  let created = 0;
  for (const cu of customers) {
    const email = (cu.email ?? "").toLowerCase();
    if (!email || byEmail.has(email)) continue;
    const name = cu.full_name || [cu.first_name, cu.last_name].filter(Boolean).join(" ") || cu.email!;
    // Strongest signal first, exactly like the order sync's resolveClient: a
    // row that already OWNS this customer-user's Aryeo id is this person —
    // without this check a row whose emails have drifted minted an empty twin.
    const ownRow = cu.id ? byAryeoId.get(cu.id) : undefined;
    // Same-person signals: phone (only with a matching name — shared office
    // lines must not collapse two agents), name+company, or a name-corroborated
    // backupEmail hit (backup addresses can be shared team inboxes).
    const pk = phoneKey(cu.phone);
    const phoneHit = pk.length === 10 ? byPhone.get(pk) : undefined;
    const samePersonByPhone = phoneHit && normId(phoneHit.name) === normId(name) ? phoneHit.id : undefined;
    const nc = normId(name) && normId(cu.agent_company_name) ? `${normId(name)}|${normId(cu.agent_company_name)}` : null;
    const backupHit = byBackupEmail.get(email);
    const sameByBackup = backupHit && normId(backupHit.name) === normId(name) ? backupHit.id : undefined;
    const bySignal = ownRow ?? samePersonByPhone ?? (nc ? byNameCo.get(nc) : undefined) ?? sameByBackup;
    if (bySignal) {
      // No-clobber on BOTH identity slots: an occupied backupEmail is a
      // load-bearing key (often the merged twin's old address), and the
      // in-memory marks only flip when the write actually carried the field.
      const writeBackup = !hasBackupEmail.has(bySignal);
      const writeAryeoId = !!cu.id && !hasAryeoId.has(bySignal) && !usedAryeoId.has(cu.id);
      if (writeBackup || writeAryeoId) {
        await prisma.client
          .update({
            where: { id: bySignal },
            data: {
              ...(writeBackup ? { backupEmail: cu.email } : {}),
              ...(writeAryeoId ? { aryeoCustomerId: cu.id! } : {}),
            },
          })
          .catch(() => {});
      }
      byEmail.set(email, bySignal);
      if (writeBackup) hasBackupEmail.add(bySignal);
      if (writeAryeoId) { hasAryeoId.add(bySignal); usedAryeoId.add(cu.id!); byAryeoId.set(cu.id!, bySignal); }
      continue;
    }
    const createdRow = await prisma.client.create({
      data: {
        name,
        email: cu.email!,
        phone: cu.phone ?? null,
        company: cu.agent_company_name ?? null,
        licenseNumber: cu.agent_license_number ?? null,
        // Straight from Aryeo → the mirror starts in sync (see the create in
        // the order sync above).
        generalNotes: cu.internal_notes ?? null,
        notesSyncedAt: cu.internal_notes ? new Date() : null,
        // Keep the Aryeo id only when it isn't already taken (it's @unique).
        aryeoCustomerId: cu.id && !usedAryeoId.has(cu.id) ? cu.id : null,
        firstSeenAt: new Date(),
        firstSeenVia: "roster sweep",
        avatarUrl: cu.avatar_url ?? null,
      },
    });
    try {
      const { greetNewClient } = await import("@/lib/newClients");
      await greetNewClient(createdRow.id);
    } catch { /* the create stands on its own */ }
    byEmail.set(email, createdRow.id);
    if (cu.id) usedAryeoId.add(cu.id);
    const cpk = phoneKey(cu.phone);
    if (cpk.length === 10 && !byPhone.has(cpk)) byPhone.set(cpk, { id: createdRow.id, name });
    created++;
  }
  return { created, scanned: customers.length };
}

// ---------------------------------------------------------------------------
// Sync the monthly social-content subscription from Aryeo customer custom
// fields. Aryeo exposes them under
//   customer_team_memberships.user.custom_field_entries.custom_field
// as { custom_field.name, value }:
//   "Social Client"       → Yes / No
//   "Social Content Plan" → Starter / Accelerator / Pro
// We match the customer-user to our client by email and store the result.
// ---------------------------------------------------------------------------
function extractSocial(cu: unknown): { socialClient: boolean; socialPlan: string | null } | null {
  let socialClient = false;
  let socialPlan: string | null = null;
  let found = false;
  const walk = (obj: unknown, depth = 0) => {
    if (!obj || depth > 9) return;
    if (Array.isArray(obj)) { obj.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      const cfRaw = (o.custom_field as { data?: unknown } | undefined)?.data ?? o.custom_field;
      const cf = cfRaw as { name?: string } | undefined;
      if (cf?.name === "Social Client") { found = true; socialClient = /^yes$/i.test(String(o.value ?? "")); }
      if (cf?.name === "Social Content Plan") { found = true; const v = String(o.value ?? "").trim(); socialPlan = v || null; }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    }
  };
  walk(cu);
  if (!found) return null;
  // A plan implies they're a social client even if the Yes/No box wasn't ticked.
  if (socialPlan && !socialClient) socialClient = true;
  return { socialClient, socialPlan };
}

export async function syncAryeoSocialPlans(): Promise<{ updated: number; matched: number }> {
  const { prisma } = await import("@/lib/prisma");
  const inc = "customer_team_memberships.user.custom_field_entries.custom_field";
  const byEmail = new Map<string, { socialClient: boolean; socialPlan: string | null }>();
  // Every customer-user email the pull saw, social fields or not. REMOVING a
  // client from the program in Aryeo DELETES their custom-field entries rather
  // than setting "Social Client" to No (verified Aug 24: Alex/Tony/Matthew
  // stayed flagged forever because extractSocial returned null and they never
  // entered byEmail). Present-but-fieldless + previously flagged = removed.
  const seen = new Set<string>();

  for (let page = 1; page <= 30; page++) {
    const r = await aryeoRequest<{ data?: { email?: string }[]; meta?: { last_page?: number } }>(
      `/customer-users?include=${inc}&per_page=100&page=${page}`,
    );
    const rows = r?.data ?? [];
    if (rows.length === 0) break;
    for (const cu of rows) {
      const email = (cu.email ?? "").toLowerCase();
      if (!email) continue;
      seen.add(email);
      const vals = extractSocial(cu);
      if (vals) byEmail.set(email, vals);
    }
    const last = r?.meta?.last_page;
    if ((last && page >= last) || rows.length < 100) break;
  }

  const clients = await prisma.client.findMany({
    where: { OR: [{ email: { not: null } }, { backupEmail: { not: null } }] },
    select: { id: true, email: true, backupEmail: true, socialClient: true, socialPlan: true },
  });
  let updated = 0;
  let matched = 0;
  for (const cl of clients) {
    // A merged client may live under either address in Aryeo.
    const emails = [cl.email, cl.backupEmail].filter(Boolean).map((e) => e!.toLowerCase());
    const v = emails.map((e) => byEmail.get(e)).find(Boolean);
    if (v) {
      matched++;
      if (cl.socialClient === v.socialClient && cl.socialPlan === v.socialPlan) continue;
      await prisma.client.update({
        where: { id: cl.id },
        data: { socialClient: v.socialClient, socialPlan: v.socialPlan },
      });
      updated++;
      continue;
    }
    // Flagged with us, present in Aryeo, but no social fields anymore → they
    // were removed from the program. Deliberately requires POSITIVE presence:
    // a client absent from the pull entirely is left untouched, so a partial
    // Aryeo response can never mass-unflag the roster.
    if (cl.socialClient && emails.some((e) => seen.has(e))) {
      await prisma.client.update({
        where: { id: cl.id },
        data: { socialClient: false, socialPlan: null },
      });
      updated++;
    }
  }
  return { updated, matched };
}

// ---------------------------------------------------------------------------
// Sync Aryeo CUSTOMER teams (agency teams like "The Jamie Achberger Group").
// Each team groups the agent + their assistants/coordinators as separate
// customer-users (e.g. Jamie + Kelly "admin" + Ruthie "admin"). Orders live
// under the AGENT, so we fold every teammate who has NO orders of their own
// under the agent (`parentClientId`). Comms from a folded assistant then route
// to the agent's projects (see resolveClientByPhones). Roles are all "admin"
// in practice, so the agent is identified as the member who actually has orders.
// ---------------------------------------------------------------------------
type CuTeamMembership = {
  customer_team?: { data?: { id?: string; name?: string } } | { id?: string; name?: string };
};
type CuWithTeams = { email?: string; customer_team_memberships?: { data?: CuTeamMembership[] } | CuTeamMembership[] };

export async function syncAryeoCustomerTeams(): Promise<{ teams: number; folded: number }> {
  const inc = "customer_team_memberships.customer_team";
  const teams = new Map<string, { name: string; emails: Set<string> }>();

  for (let page = 1; page <= 40; page++) {
    const r = await aryeoRequest<{ data?: CuWithTeams[]; meta?: { last_page?: number } }>(
      `/customer-users?include=${inc}&per_page=100&page=${page}`,
    );
    const rows = r?.data ?? [];
    if (rows.length === 0) break;
    for (const cu of rows) {
      const email = (cu.email ?? "").toLowerCase();
      if (!email) continue;
      const mships = (cu.customer_team_memberships as { data?: CuTeamMembership[] })?.data
        ?? (cu.customer_team_memberships as CuTeamMembership[])
        ?? [];
      for (const m of mships) {
        const t = (m.customer_team as { data?: { id?: string; name?: string } })?.data
          ?? (m.customer_team as { id?: string; name?: string });
        if (!t?.id) continue;
        if (!teams.has(t.id)) teams.set(t.id, { name: t.name ?? "Team", emails: new Set() });
        teams.get(t.id)!.emails.add(email);
      }
    }
    const last = r?.meta?.last_page;
    if ((last && page >= last) || rows.length < 100) break;
  }

  // Our clients, keyed by email, with how many orders each has placed.
  const clients = await prisma.client.findMany({
    select: { id: true, email: true, parentClientId: true, _count: { select: { projects: true } } },
  });
  const byEmail = new Map<string, (typeof clients)[number]>();
  for (const c of clients) if (c.email) byEmail.set(c.email.toLowerCase(), c);

  let folded = 0;
  let realTeams = 0;
  for (const [teamId, { name, emails }] of teams) {
    const members = [...emails].map((e) => byEmail.get(e)).filter(Boolean) as (typeof clients)[number][];
    if (members.length < 2) continue; // a solo team needs no folding
    // The agent = the member who has placed the most orders. If nobody has any,
    // we can't tell who's the agent — leave them all standalone.
    const sorted = [...members].sort((a, b) => b._count.projects - a._count.projects);
    const agent = sorted[0];
    if (agent._count.projects === 0) continue;
    realTeams++;
    for (const m of members) {
      const isAgent = m.id === agent.id;
      // Fold ONLY teammates with no orders of their own (true assistants); a
      // co-agent with their own orders stays standalone but is still tagged.
      const parentClientId = isAgent ? null : m._count.projects === 0 ? agent.id : null;
      await prisma.client.update({
        where: { id: m.id },
        data: { aryeoTeamId: teamId, aryeoTeamName: name, parentClientId },
      });
      if (parentClientId) folded++;
    }
  }
  return { teams: realTeams, folded };
}

// ---------------------------------------------------------------------------
// Sync the internal team from Aryeo (/company-team-members embeds the user).
// Replaces placeholder team members with the real roster.
// ---------------------------------------------------------------------------
export async function syncAryeoTeam(): Promise<{ team: number }> {
  const members = await Aryeo.companyTeamMembers();
  let count = 0;

  for (const m of members) {
    const u = m.company_user;
    if (!m.id || !u?.email) continue;
    const role = u.is_super ? "ADMIN" : m.is_service_provider ? "PHOTOGRAPHER" : "MANAGER";
    const data = {
      name: u.full_name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email,
      email: u.email,
      role: role as "ADMIN" | "PHOTOGRAPHER" | "MANAGER",
      phone: u.phone ?? null,
      avatarColor: m.calendar_color || "#6366f1",
      isServiceProvider: m.is_service_provider ?? false,
      title: m.is_service_provider ? "Service Provider" : null,
      aryeoUserId: u.id ?? null,
      aryeoTeamMemberId: m.id,
    };
    // Upsert by the Aryeo team-member id; tolerate email collisions with seed rows.
    const existing = await prisma.teamMember.findFirst({
      where: { OR: [{ aryeoTeamMemberId: m.id }, { email: u.email }] },
    });
    if (existing) {
      await prisma.teamMember.update({ where: { id: existing.id }, data });
    } else {
      await prisma.teamMember.create({ data });
    }
    count++;
  }

  // Drop placeholder/seed members that aren't part of the real Aryeo roster
  // (only those not referenced by any project, to respect foreign keys).
  const stale = await prisma.teamMember.findMany({
    where: {
      aryeoTeamMemberId: null,
      shootsAsPhotographer: { none: {} },
      projectsAsEditor: { none: {} },
      projectsAsVa: { none: {} },
      // Payroll history blocks the sweep — these all cascade on delete, and a
      // manually-paid member (addShootToPayroll) has no photographer links, so
      // without this guard one "Sync team" could silently erase pay overrides,
      // adjustments, and Jordan's mileage corrections.
      jobPayOverrides: { none: {} },
      payoutAdjustments: { none: {} },
      mileageDays: { none: {} },
      assignedAppointments: { none: {} },
    },
    select: { id: true },
  });
  if (stale.length) {
    await prisma.teamMember.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }

  return { team: count };
}

// ---------------------------------------------------------------------------
// Sync appointments (with their assigned users) → Appointment rows, and use
// them to assign the photographer + shoot date on each project. The assigned
// user comes from ?include=users (reliable: 100% filled), not the sparse
// initial_assigned_company_team_member_id. Also assigns the VA (Kyle).
// ---------------------------------------------------------------------------
export async function syncAryeoAppointments(
  // `orderId` scopes to ONE order's appointments — the per-project "Refresh
  // from Aryeo" button. GET /appointments ignores every order filter (see the
  // probe notes below), and walking the bounded list costs ~53s, far too slow
  // for a button. The ORDER payload already carries its appointments, so we
  // read those ids and fetch each in full (users included) — 2-4 calls, ~1s —
  // then run them through this function's normal body.
  // `maxPages` / `budgetMs` (unbounded mode only) make the full-history pass
  // RESUMABLE: walk a slice, persist the next page, continue next run. The
  // full pass is ~190s of API on its own (16 pages × ~12s) — it was the step
  // that exhausted the old single daily run (Sep 1 2026 audit).
  opts: { recentOnlyDays?: number; orderId?: string; maxPages?: number; budgetMs?: number } = {},
): Promise<{
  appointments: number;
  photographerAssigned: number;
  complete?: boolean;
  resumeFromPage?: number;
}> {
  await loadManualProductMap(); // hand-set product categories override the parsers below
  // Hourly cron passes recentOnlyDays so we only write recent + all future
  // appointments (past shoots are already stored) — keeps the run fast enough
  // to never time out. The reconcile cron runs it unbounded, in page slices,
  // to reconcile everything.
  const windowAgoTs = opts.recentOnlyDays ? Date.now() - opts.recentOnlyDays * 86_400_000 : null;
  const resumable = windowAgoTs === null && !opts.orderId && !!(opts.maxPages || opts.budgetMs);
  const apptCursor = resumable ? await readApptCursor() : null;
  const t0 = Date.now();
  let pagesThisRun = 0;
  let reachedEnd = false;

  // Preload lookups.
  const [projects, team] = await Promise.all([
    prisma.project.findMany({ where: { aryeoOrderId: { not: null } }, select: { id: true, aryeoOrderId: true, title: true, photographerManual: true } }),
    prisma.teamMember.findMany({ select: { id: true, aryeoUserId: true, name: true, isServiceProvider: true } }),
  ]);
  const projectByOrder = new Map(projects.map((p) => [p.aryeoOrderId!, p.id]));
  const titleByProject = new Map(projects.map((p) => [p.id, p.title]));
  const manualPhotogByProject = new Map(projects.map((p) => [p.id, p.photographerManual]));
  const teamByUser = new Map(team.filter((t) => t.aryeoUserId).map((t) => [t.aryeoUserId!, t]));
  const va = team.find((t) => /kyle/i.test(t.name));

  // Per-project pick of the best appointment for primary assignment.
  const pick = new Map<string, { photographerId: string | null; shootDate: Date | null; scheduled: boolean }>();
  let appointmentCount = 0;
  const nowTs = Date.now();

  // Among an order's appointments, the "primary" shoot is the NEXT upcoming one
  // (so a multi-appointment order surfaces its soonest visit). If all are past,
  // use the most recent. Future always beats past.
  const betterShoot = (next: Date, cur: Date | null): boolean => {
    if (!cur) return true;
    const nf = next.getTime() >= nowTs;
    const cf = cur.getTime() >= nowTs;
    if (nf !== cf) return nf; // a future shoot wins over a past one
    return nf ? next < cur : next > cur; // both future: soonest; both past: latest
  };

  const perPage = 100;
  let page = apptCursor?.page ?? 1;
  for (let i = 0; i < 200; i++) {
    if (resumable && ((opts.budgetMs && Date.now() - t0 >= opts.budgetMs) || (opts.maxPages && pagesThisRun >= opts.maxPages))) break;
    // Incremental runs used to fetch the ENTIRE appointment history (~15 heavy
    // pages hourly) and only apply the window locally — the repeated Aryeo
    // timeouts stalled the one reliable propagation path for reschedules and
    // cancels. Probed live against GET /appointments (2026-07-07):
    //   · sort=-start_at IS honored: undated rows (UNSCHEDULED/CANCELED with
    //     start_at null) come FIRST, then start_at strictly descending — so we
    //     can stop paging once a page dips below the window floor.
    //   · filter[start_at_gte] IS honored too, but it silently DROPS the
    //     null-start rows — exactly the postponed/canceled appointments the
    //     transition detection below must observe — so sort + early-break is
    //     the only bounded fetch that still sees them.
    //   · filter[start_at][gte] / start_at_after / start_at_min / filter[status]
    //     are all silently ignored (same totals as unfiltered).
    // Full (nightly) runs keep the plain unbounded pagination to reconcile all
    // of history.
    let batch: AryeoAppointment[];
    let lastPage: number | undefined;
    if (opts.orderId) {
      const order = await Aryeo.order(opts.orderId).catch(() => null);
      const ids = (order?.appointments ?? []).map((a) => a.id).filter((id): id is string => !!id);
      const full = await Promise.all(ids.map((id) => Aryeo.appointment(id).catch(() => null)));
      batch = full.filter((a): a is AryeoAppointment => !!a);
    } else {
      const res = await aryeoRequest<{ data: AryeoAppointment[]; meta?: { last_page?: number } }>("/appointments", {
        query: { include: "users,order", page, per_page: perPage, ...(windowAgoTs !== null ? { sort: "-start_at" } : {}) },
      });
      batch = res?.data ?? [];
      pagesThisRun++;
      // A page past the end (rows deleted since the cursor was saved) answers
      // 200 + [] — that is the end of history, not a parked cursor.
      if (batch.length === 0) {
        reachedEnd = true;
        break;
      }
      lastPage = res?.meta?.last_page;
    }
    if (batch.length === 0) break;

    // Pre-read this page's stored rows in ONE query, so after each upsert we can
    // tell a real reschedule/cancel (start moved ≥ 1 min, or status flipped to
    // canceled) from a routine re-sync — those changes ring the bell below.
    const priorRows = await prisma.appointment.findMany({
      where: { aryeoId: { in: batch.map((a) => a.id).filter((id): id is string => !!id) } },
      select: { aryeoId: true, startAt: true, status: true, assignedToId: true },
    });
    const priorByAryeoId = new Map(priorRows.map((r) => [r.aryeoId, r]));

    for (const appt of batch) {
      const orderId = appt.order?.id;
      const projectId = orderId ? projectByOrder.get(orderId) : undefined;
      if (!appt.id || !projectId) continue;

      // Assigned user → our team member (prefer a known service provider).
      const assignedUser =
        appt.users?.find((u) => u.id && teamByUser.get(u.id)?.isServiceProvider) ||
        appt.users?.find((u) => u.id && teamByUser.has(u.id)) ||
        undefined;
      const assignedToId = assignedUser?.id ? teamByUser.get(assignedUser.id)?.id ?? null : null;
      const startAt = appt.start_at ? new Date(appt.start_at) : null;
      // In incremental (hourly) mode, skip writing long-past shoots — they're
      // already stored and don't change. Keep undated + recent + all future.
      if (windowAgoTs !== null && startAt && startAt.getTime() < windowAgoTs) continue;
      const scheduled = (appt.status || "").toUpperCase() === "SCHEDULED";

      const fields = {
        startAt,
        endAt: appt.end_at ? new Date(appt.end_at) : null,
        durationMin: appt.duration ?? null,
        status: appt.status ?? null,
        title: appt.title ?? null,
        description: appt.description ?? null,
        preferenceType: appt.preference_type ?? null,
        requiresConfirmation: appt.requires_confirmation ?? false,
        canCancel: appt.can_cancel ?? false,
        canReschedule: appt.can_reschedule ?? false,
        rescheduledAt: appt.rescheduled_at ? new Date(appt.rescheduled_at) : null,
        postponedAt: appt.postponed_at ? new Date(appt.postponed_at) : null,
        previousStartAt: appt.previous_start_at ? new Date(appt.previous_start_at) : null,
        rawJson: JSON.stringify(appt),
        assignedToId,
      };
      await prisma.appointment.upsert({
        where: { aryeoId: appt.id },
        create: { aryeoId: appt.id, projectId, ...fields },
        update: fields,
      });
      appointmentCount++;

      // Bell: a KNOWN appointment that moved or got canceled — admin broadcast +
      // the assigned photographer (routed to /shoot). New appointments stay quiet
      // here (the booking already announced). The new start time (or "canceled")
      // lives IN the dedupe key, so each further reschedule rings again exactly
      // once. Best-effort — never breaks the sync.
      const prior = priorByAryeoId.get(appt.id);
      if (prior) {
        const nowCanceled = (appt.status ?? "").toUpperCase().startsWith("CANCEL");
        const wasCanceled = (prior.status ?? "").toUpperCase().startsWith("CANCEL");
        const canceled = nowCanceled && !wasCanceled;
        const moved =
          !nowCanceled && !!startAt && !!prior.startAt &&
          Math.abs(startAt.getTime() - prior.startAt.getTime()) >= 60_000;
        // Both legs of the postpone-then-rebook cycle (the most common real
        // reschedule flow) fell between `canceled` and `moved` and rang nothing:
        // a start cleared to TBD isn't a cancel, and a dateless appointment
        // gaining a start has no prior.startAt for the moved delta.
        const postponed = !nowCanceled && !startAt && !!prior.startAt;
        const rebooked = !nowCanceled && !!startAt && !prior.startAt;
        // Reassignment rings ONLY on a real handoff (both sides known). A null
        // transition still wrote the row above, but stays silent: a transient
        // empty `users` array from a flaky API page would otherwise fire a
        // spurious "No longer yours" — worse than silence on the rare true
        // unassignment.
        const reassigned = !nowCanceled && !!prior.assignedToId && !!assignedToId && prior.assignedToId !== assignedToId;
        // Shared by both bell blocks below — hoisted so neither duplicates the
        // imports / street derivation. Best-effort like the bells themselves.
        const bellDeps =
          canceled || moved || postponed || rebooked || reassigned
            ? await Promise.all([import("@/lib/notify"), import("@/lib/datetime")]).catch(() => null)
            : null;
        const street = streetOf(titleByProject.get(projectId)) || "a shoot"; // never "[No address provided]" in a staff text (audit, Sep 8)
        if ((canceled || moved || postponed || rebooked) && bellDeps) {
          try {
            const [{ notifyInApp }, { etDateTime }] = bellDeps;
            const targets: NotifyTarget[] = [{ roles: ["ADMIN"] }];
            if (assignedToId) targets.push({ roles: ["PHOTOGRAPHER"], userKey: `tm:${assignedToId}`, href: "/shoot" });
            // The changing part lives IN the dedupe key (new start, or the start
            // being abandoned for TBD), so each further transition rings again
            // exactly once while re-syncs of the same state stay silent.
            const [title, keyPart] = canceled
              ? [`Canceled — ${street}`, "canceled"]
              : postponed
                ? [`Postponed — ${street} (new date TBD)`, `tbd-${prior.startAt!.toISOString()}`]
                : rebooked
                  ? [`Scheduled — ${street} → ${etDateTime(startAt)}`, `rebooked-${startAt!.toISOString()}`]
                  : [`Rescheduled — ${street} → ${etDateTime(startAt)}`, startAt!.toISOString()];
            await notifyInApp({
              kind: "appointment_change",
              title,
              href: `/projects/${projectId}`,
              targets,
              dedupeKey: `appt-${appt.id}-${keyPart}`,
            });
          } catch { /* bell is best-effort */ }
        }
        // Reassignment: the shoot silently moving between photographers' /shoot
        // lists is at least as bell-worthy as a 1-minute move. Old and new
        // assignee read different messages, so each audience gets its own row
        // (a cancel already rings above — don't double-announce it here).
        if (reassigned && bellDeps) {
          try {
            const [{ notifyInApp }, { etDateTime }] = bellDeps;
            // Both sides in the key so an A→B→A swap still rings each leg once.
            const base = `appt-${appt.id}-assign-${prior.assignedToId ?? "none"}-${assignedToId ?? "none"}`;
            const when = startAt ? `, ${etDateTime(startAt)}` : "";
            await notifyInApp({
              kind: "appointment_change",
              title: `Reassigned — ${street}`,
              href: `/projects/${projectId}`,
              targets: [{ roles: ["ADMIN"] }],
              dedupeKey: `${base}-admin`,
            });
            if (prior.assignedToId) {
              await notifyInApp({
                kind: "appointment_change",
                title: `No longer yours — ${street}`,
                href: "/shoot",
                targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${prior.assignedToId}`, href: "/shoot" }],
                dedupeKey: `${base}-old`,
              });
            }
            if (assignedToId) {
              await notifyInApp({
                kind: "appointment_change",
                title: `New shoot — ${street}${when}`,
                href: "/shoot",
                targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${assignedToId}`, href: "/shoot" }],
                dedupeKey: `${base}-new`,
              });
            }
          } catch { /* bell is best-effort */ }
        }
      }

      // Primary assignment = the next upcoming scheduled appointment (with the
      // photographer assigned to THAT visit). Non-scheduled only seeds a fallback.
      const cur = pick.get(projectId);
      if (scheduled && startAt) {
        if (!cur || !cur.scheduled || betterShoot(startAt, cur.shootDate)) {
          pick.set(projectId, { photographerId: assignedToId, shootDate: startAt, scheduled: true });
        }
      } else if (!cur) {
        pick.set(projectId, { photographerId: assignedToId, shootDate: null, scheduled: false });
      } else if (!cur.photographerId && assignedToId) {
        cur.photographerId = assignedToId;
      }
    }

    // Incremental early-break: with sort=-start_at (verified: undated first,
    // then start_at strictly descending), once this page's oldest dated row
    // falls before the window floor every later page is older still — stop
    // paging instead of fetching all of history. The per-row window skip above
    // already dropped this page's stale tail.
    if (windowAgoTs !== null) {
      const starts = batch
        .map((a) => (a.start_at ? new Date(a.start_at).getTime() : null))
        .filter((t): t is number => t !== null);
      if (starts.length > 0 && Math.min(...starts) < windowAgoTs) break;
    }

    if (opts.orderId) break; // single-order mode fetched everything up front
    const last = lastPage;
    if (last ? page >= last : batch.length < perPage) {
      reachedEnd = true;
      break;
    }
    page++;
    if (resumable) await writeApptCursor({ page, startedAt: apptCursor?.startedAt ?? new Date(t0).toISOString(), lastCompletedAt: apptCursor?.lastCompletedAt ?? null });
  }
  if (resumable) {
    if (reachedEnd) await writeApptCursor({ page: 1, startedAt: null, lastCompletedAt: new Date().toISOString() });
    else await writeApptCursor({ page, startedAt: apptCursor?.startedAt ?? new Date(t0).toISOString(), lastCompletedAt: apptCursor?.lastCompletedAt ?? null });
  }

  // A resumable SLICE saw only some of each project's visits — Aryeo lists
  // undated rows first, then start_at descending, so a later page holds the
  // OLDER visits of a multi-visit job. Writing shootDate from that partial
  // view made such jobs oscillate between visits every pass (review). Rebuild
  // the pick for every touched project from the DB (this page's rows are
  // already upserted; the hourly path keeps the rest current).
  if (resumable && pick.size > 0) {
    const stored = await prisma.appointment.findMany({
      where: { projectId: { in: [...pick.keys()] } },
      select: { projectId: true, startAt: true, status: true, assignedToId: true },
    });
    const rebuilt = new Map<string, { photographerId: string | null; shootDate: Date | null; scheduled: boolean }>();
    for (const a of stored) {
      const scheduled = (a.status || "").toUpperCase() === "SCHEDULED";
      const cur = rebuilt.get(a.projectId);
      if (scheduled && a.startAt) {
        if (!cur || !cur.scheduled || betterShoot(a.startAt, cur.shootDate)) {
          rebuilt.set(a.projectId, { photographerId: a.assignedToId, shootDate: a.startAt, scheduled: true });
        }
      } else if (!cur) {
        rebuilt.set(a.projectId, { photographerId: a.assignedToId, shootDate: null, scheduled: false });
      } else if (!cur.photographerId && a.assignedToId) {
        cur.photographerId = a.assignedToId;
      }
    }
    pick.clear();
    for (const [k, v] of rebuilt) pick.set(k, v);
  }

  // Apply photographer + shoot date per project (non-destructive: only fill).
  let assigned = 0;
  for (const [projectId, info] of pick) {
    if (!info.photographerId && !info.shootDate) continue;
    await prisma.project.update({
      where: { id: projectId },
      data: {
        // Tug-of-war guard: a hand-picked photographer (assignMember sets
        // photographerManual) must not be silently reverted to Aryeo's assignee
        // an hour later — skip the auto-fill until the manual hold is released
        // (unassigning in the app clears the flag, so Aryeo resumes control).
        ...(info.photographerId && !manualPhotogByProject.get(projectId) ? { photographerId: info.photographerId } : {}),
        ...(info.shootDate ? { shootDate: info.shootDate } : {}),
      },
    });
    if (info.photographerId) assigned++;
    // A scheduled date is on the books again → the rebook chase is answered.
    if (info.scheduled && info.shootDate) {
      await prisma.smartTask.updateMany({
        where: { dedupeKey: `rebook-${projectId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "COMPLETED", completedAt: new Date() },
      }).catch(() => {});
    }
  }

  // Cancel/postpone propagation: when NO live appointment remains on a project
  // (live = dated and not canceled), its stored shootDate is an abandoned slot —
  // the fill-only apply above can never clear it, so the job sat SCHEDULED
  // forever on the pipeline, /upload and My Shoots, and payroll's shootDate
  // fallback could pay for a shoot that never happened. Constraints: only clear
  // a FUTURE shootDate (a past one may describe a shoot that actually took
  // place — payroll history must not rewrite), and only for projects that HAVE
  // appointment rows (an appointment-less project's shootDate comes from order
  // data). photographerId is deliberately left alone. Re-checks against the DB
  // (not just this fetch) so an old dated visit outside the incremental window
  // still counts as live. Idempotent: once cleared, the future-shootDate filter
  // stops matching.
  const deadCandidates = [...pick.entries()].filter(([, info]) => !info.scheduled).map(([id]) => id);
  if (deadCandidates.length > 0) {
    // Future-shootDate filter FIRST: it usually whittles the dead candidates to
    // a handful, and appointment rows are only needed for those — the nightly
    // full run would otherwise pull thousands of rows to gate a few writes.
    // FUTURE shootDates as before — plus, for jobs that never reached SHOT, a
    // PAST shootDate that Aryeo explicitly abandoned: an UNSCHEDULED
    // (postponed) row whose previousStartAt IS that stored date. A client who
    // postpones the morning after the slot used to leave the job SCHEDULED
    // on a past date with no rebook card (review). SHOT+ jobs are untouched:
    // a past date there may describe a shoot that happened (payroll).
    const candProjects = await prisma.project.findMany({
      where: {
        id: { in: deadCandidates },
        OR: [
          { shootDate: { gt: new Date() } },
          {
            status: { in: ["BOOKED", "SCHEDULED"] },
            shootDate: { lte: new Date() },
            appointments: { some: { status: { equals: "UNSCHEDULED", mode: "insensitive" }, startAt: null, previousStartAt: { not: null } } },
          },
        ],
      },
      select: { id: true, shootDate: true, appointments: { where: { previousStartAt: { not: null } }, select: { previousStartAt: true, status: true } } },
    });
    const candAppts = candProjects.length
      ? await prisma.appointment.findMany({
          where: { projectId: { in: candProjects.map((p) => p.id) } },
          select: { projectId: true, startAt: true, status: true },
        })
      : [];
    const hasRows = new Set(candAppts.map((a) => a.projectId));
    // "Live" = an appointment that can EXPLAIN a future stored shootDate: dated,
    // not canceled, and not already in the past (small grace for in-progress
    // shoots). A past leg — e.g. a completed earlier visit on a job whose future
    // return visit was canceled — can't justify keeping a future date, and
    // counting it would leave that stale slot on the books forever.
    const liveFloor = Date.now() - 60 * 60 * 1000;
    const hasLive = new Set(
      candAppts
        .filter((a) => a.startAt && a.startAt.getTime() > liveFloor && !(a.status ?? "").toUpperCase().startsWith("CANCEL"))
        .map((a) => a.projectId),
    );
    for (const p of candProjects) {
      if (!hasRows.has(p.id) || hasLive.has(p.id)) continue;
      // The past-date branch only fires when Aryeo names THIS slot as the one
      // it abandoned.
      if (p.shootDate && p.shootDate.getTime() <= Date.now()) {
        const abandoned = p.appointments.some(
          (a) => (a.status ?? "").toUpperCase() === "UNSCHEDULED" && a.previousStartAt && Math.abs(a.previousStartAt.getTime() - p.shootDate!.getTime()) < 60_000,
        );
        if (!abandoned) continue;
      }
      await Promise.all([
        prisma.project.update({ where: { id: p.id }, data: { shootDate: null } }),
        // Pre-shoot tasks are moot without a shoot on the books. CANCELLED, not
        // COMPLETED — history must not claim a confirmation was ever sent.
        prisma.smartTask.updateMany({
          where: {
            projectId: p.id,
            taskType: { in: ["confirmation_text", "appointment_prep"] },
            status: { notIn: ["COMPLETED", "CANCELLED"] },
          },
          data: { status: "CANCELLED" },
        }),
        prisma.activity.create({
          data: {
            projectId: p.id,
            type: "SYSTEM",
            body: "All Aryeo appointments are canceled or unscheduled — cleared the upcoming shoot date and retired the pre-shoot tasks.",
          },
        }).catch(() => {}),
      ]);
      // A job with no date is invisible to every date-keyed list (schedule,
      // Ops Day, My Shoots, the confirmation sweep) — 775 Scotch Way was
      // postponed and simply disappeared (Sep 1 2026 audit). ONE rebook task
      // keeps it on Kyle's plate until a new date lands; the apply loop above
      // closes it the moment a scheduled appointment reappears.
      await mintRebookTask(p.id);
    }
  }

  // Every dateless live job whose appointments are all postponed/unscheduled
  // carries ONE rebook card — including jobs postponed BEFORE this card
  // existed (80 W Lancaster sat dateless for 12 days with nothing open) and
  // the incremental runs that never touch the dead-slot sweep above. The
  // apply loop closes the card the moment a scheduled date returns.
  try {
    const dateless = await prisma.project.findMany({
      where: {
        source: "ARYEO",
        status: { in: ["BOOKED", "SCHEDULED"] },
        OR: [{ shootDate: null }, { shootDate: { lt: new Date() } }],
        aryeoMissingAt: null,
        appointments: { some: { status: { equals: "UNSCHEDULED", mode: "insensitive" } } },
        NOT: { appointments: { some: { startAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }, NOT: { status: { startsWith: "CANCEL", mode: "insensitive" } } } } },
      },
      select: { id: true },
    });
    for (const p of dateless) await mintRebookTask(p.id);
  } catch { /* the rebook card is best-effort */ }

  // VA = Kyle on all Aryeo projects.
  if (va) {
    await prisma.project.updateMany({ where: { source: "ARYEO" }, data: { vaId: va.id } });
  }

  return {
    appointments: appointmentCount,
    photographerAssigned: assigned,
    ...(resumable ? { complete: reachedEnd, resumeFromPage: reachedEnd ? 1 : page } : {}),
  };
}

// Same cursor shape as the orders sweep, its own key.
export const APPT_CURSOR_KEY = "aryeo:apptReconcile";
export async function readApptCursor(): Promise<ReconcileCursor> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: APPT_CURSOR_KEY }, select: { value: true } });
    const c = row ? (JSON.parse(row.value) as Partial<ReconcileCursor>) : null;
    const page = Number(c?.page);
    return {
      page: Number.isInteger(page) && page >= 1 ? page : 1,
      startedAt: typeof c?.startedAt === "string" ? c.startedAt : null,
      lastCompletedAt: typeof c?.lastCompletedAt === "string" ? c.lastCompletedAt : null,
    };
  } catch {
    return { page: 1, startedAt: null, lastCompletedAt: null };
  }
}
async function writeApptCursor(c: ReconcileCursor): Promise<void> {
  const value = JSON.stringify(c);
  await prisma.appSetting
    .upsert({ where: { key: APPT_CURSOR_KEY }, create: { key: APPT_CURSOR_KEY, value }, update: { value } })
    .catch(() => {});
}

// Backfill map coordinates onto existing projects from each Aryeo order's
// address (order.address.latitude/longitude). New projects already get these on
// create; this catches everything imported before lat/lng was tracked.
export async function backfillProjectCoords(): Promise<{ updated: number; scanned: number }> {
  const { prisma } = await import("@/lib/prisma");
  const need = await prisma.project.findMany({
    where: { aryeoOrderId: { not: null }, OR: [{ lat: null }, { lng: null }] },
    select: { id: true, aryeoOrderId: true },
  });
  if (need.length === 0) return { updated: 0, scanned: 0 };
  const wanted = new Map(need.map((p) => [p.aryeoOrderId!, p.id]));

  let updated = 0;
  let scanned = 0;
  let page = 1;
  for (let i = 0; i < 200 && wanted.size > 0; i++) {
    const res = await aryeoRequest<{ data: AryeoOrder[] }>("/orders", {
      query: { include: "listing", page, per_page: 50 },
    });
    const batch = res?.data ?? [];
    if (batch.length === 0) break;
    for (const order of batch) {
      scanned++;
      if (!order.id || !wanted.has(order.id)) continue;
      const a = order.address ?? order.listing?.address;
      if (a?.latitude != null && a?.longitude != null) {
        await prisma.project.update({
          where: { id: wanted.get(order.id)! },
          data: { lat: a.latitude, lng: a.longitude },
        });
        updated++;
      }
      wanted.delete(order.id);
    }
    page++;
  }
  return { updated, scanned };
}

// Re-derive every Aryeo project's deliverables from its order items' full
// descriptions (so old bundles/packages get split + correctly categorized).
// Preserves completed/in-progress status per type where it still applies.
const STATUS_RANK: Record<string, number> = { PENDING: 0, UPLOADED: 1, FLAGGED: 1, IN_PROGRESS: 2, DONE: 3 };
export async function reclassifyAryeoDeliverables(): Promise<{
 projects: number; before: number; after: number }> {
  await loadManualProductMap(); // hand-set product categories override the parsers below
  const { prisma } = await import("@/lib/prisma");
  const projects = await prisma.project.findMany({
    where: { aryeoOrderId: { not: null } },
    select: { id: true, aryeoOrderId: true, status: true, deliverables: { select: { type: true, status: true } } },
  });
  const byOrder = new Map(projects.map((p) => [p.aryeoOrderId!, p]));
  type Proj = (typeof projects)[number];

  let changed = 0, before = 0, after = 0;
  const rebuild = async (proj: Proj, items: AryeoOrderItem[]) => {
    const parsed = orderDeliverables(items);
    if (parsed.length === 0) return;
    const prior = new Map<string, string>();
    for (const d of proj.deliverables) {
      const cur = prior.get(d.type);
      if (!cur || (STATUS_RANK[d.status] ?? 0) > (STATUS_RANK[cur] ?? 0)) prior.set(d.type, d.status);
    }
    before += proj.deliverables.length;
    await prisma.$transaction([
      prisma.deliverable.deleteMany({ where: { projectId: proj.id } }),
      prisma.deliverable.createMany({
        data: parsed.map((p) => ({
          projectId: proj.id,
          type: p.type,
          label: p.label,
          quantity: p.quantity,
          productTitle: p.productTitle,
          videoStyle: p.videoStyle,
          status: (proj.status === "DELIVERED" ? "DONE" : (prior.get(p.type) ?? "PENDING")) as DeliverableStatusValue,
        })),
      }),
    ]);
    after += parsed.length;
    changed++;
  };

  // Fast pass over the paged order list…
  for (let i = 0, page = 1; i < 200 && byOrder.size > 0; i++, page++) {
    const res = await aryeoRequest<{ data: AryeoOrder[] }>("/orders", { query: { include: "items", page, per_page: 50 } });
    const batch = res?.data ?? [];
    if (batch.length === 0) break;
    for (const order of batch) {
      const proj = order.id ? byOrder.get(order.id) : undefined;
      if (!proj) continue;
      byOrder.delete(order.id!);
      await rebuild(proj, order.items ?? []);
    }
  }
  // …then fetch any orders the list didn't return, one by one, so nothing is missed.
  for (const [orderId, proj] of byOrder) {
    try {
      const order = await Aryeo.order(orderId);
      await rebuild(proj, order.items ?? []);
    } catch {
      /* skip unreachable order */
    }
  }

  // Safety net: any leftover OTHER deliverable that's clearly a photo package /
  // bundle / interior-exterior coverage → PHOTOS (so it routes to AutoHDR).
  await prisma.deliverable.updateMany({
    where: {
      type: "OTHER",
      OR: [
        { label: { contains: "PACKAGE", mode: "insensitive" } },
        { label: { contains: "BUNDLE", mode: "insensitive" } },
        { label: { contains: "Interior", mode: "insensitive" } },
        { label: { contains: "Exterior", mode: "insensitive" } },
      ],
    },
    data: { type: "PHOTOS" },
  });

  return { projects: changed, before, after };
}

// Surgical re-label: fix deliverables whose "Premium …" label came from the OLD
// over-broad premium list (e.g. the EVERYTHING bundle). Re-derives the correct
// label per type from the live order items and UPDATES IN PLACE — so unlike a
// full re-derive it preserves each deliverable's status, upload tick, and notes.
// Bounded to projects that actually have a premium video/reel right now.
export async function relabelPremiumDeliverables(): Promise<{ scanned: number; relabeled: number }> {
  const { prisma } = await import("@/lib/prisma");
  const projects = await prisma.project.findMany({
    where: {
      aryeoOrderId: { not: null },
      deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, label: { startsWith: "Premium" } } },
    },
    select: { id: true, aryeoOrderId: true, deliverables: { select: { id: true, type: true, label: true, productTitle: true, videoStyle: true } } },
  });
  let scanned = 0, relabeled = 0;
  for (const proj of projects) {
    scanned++;
    let order: AryeoOrder;
    try { order = await Aryeo.order(proj.aryeoOrderId!); } catch { continue; }
    const parsed = orderDeliverables(order.items);
    const want = new Map<string, ParsedDeliverable>();
    for (const p of parsed) want.set(p.type, p);
    for (const d of proj.deliverables) {
      const desired = want.get(d.type);
      if (!desired) continue;
      // Label and product identity move together, in place (same rule as the
      // order reconcile) — the row's id is what the cuts hang off.
      if (desired.label !== d.label || desired.productTitle !== (d.productTitle ?? null) || desired.videoStyle !== (d.videoStyle ?? null)) {
        await prisma.deliverable.update({
          where: { id: d.id },
          data: { label: desired.label, productTitle: desired.productTitle, videoStyle: desired.videoStyle },
        });
        relabeled++;
      }
    }
  }
  return { scanned, relabeled };
}

type DeliverableStatusValue = "PENDING" | "UPLOADED" | "IN_PROGRESS" | "DONE" | "FLAGGED";

// Fetch a listing's media live (for the project detail gallery). Returns a
// compact summary plus gallery image URLs. Never throws — returns null on error.
export type MediaImage = { thumb: string; large: string; original: string; caption: string | null; filename: string | null };
export type MediaVideo = {
  /**
   * ARYEO'S OWN ID FOR THIS VIDEO (F23, Sep 22 2026). Carried through because
   * the client library used to key its rows on the video's POSITION in this
   * array, which changes whenever a video is added, removed or reordered — so
   * a refresh could rewrite one video's row with another video's title and
   * URLs. Null only for a listing payload that omitted it.
   */
  id: string | null;
  title: string | null;
  thumb: string | null;
  playback: string | null;
  download: string | null;
  duration: number | null;
};
export type MediaFloorPlan = { title: string | null; thumb: string; large: string; original: string };

export type ListingMedia = {
  deliveryStatus: string | null;
  photoCount: number;
  videoCount: number;
  floorPlanCount: number;
  cover: string | null;
  images: MediaImage[];
  videos: MediaVideo[];
  floorPlans: MediaFloorPlan[];
};

export async function getListingMedia(listingId: string): Promise<ListingMedia | null> {
  try {
    const l = await Aryeo.listing(listingId);
    const videos = (l.videos ?? []) as { id?: string; title?: string; thumbnail_url?: string; playback_url?: string; download_url?: string; duration?: number }[];
    const floorPlans = (l.floor_plans ?? []) as { title?: string; thumbnail_url?: string; large_url?: string; original_url?: string }[];
    const images = (l.images ?? []).filter((i) => i.display_in_gallery !== false);
    return {
      deliveryStatus: l.delivery_status ?? null,
      photoCount: l.images?.length ?? 0,
      videoCount: l.videos?.length ?? 0,
      floorPlanCount: l.floor_plans?.length ?? 0,
      cover: l.thumbnail_url ?? images[0]?.thumbnail_url ?? null,
      images: images.map((i) => ({
        thumb: i.thumbnail_url ?? i.large_url ?? i.original_url ?? "",
        large: i.large_url ?? i.original_url ?? i.thumbnail_url ?? "",
        original: i.original_url ?? i.large_url ?? i.thumbnail_url ?? "",
        caption: i.caption ?? null,
        filename: i.filename ?? null,
      })),
      videos: videos.map((v) => ({
        id: typeof v.id === "string" && v.id.trim() ? v.id : null,
        title: v.title ?? null,
        thumb: v.thumbnail_url ?? null,
        playback: v.playback_url ?? null,
        download: v.download_url ?? null,
        duration: v.duration ?? null,
      })),
      floorPlans: floorPlans.map((f) => ({
        title: f.title ?? null,
        thumb: f.thumbnail_url ?? f.large_url ?? f.original_url ?? "",
        large: f.large_url ?? f.original_url ?? f.thumbnail_url ?? "",
        original: f.original_url ?? f.large_url ?? f.thumbnail_url ?? "",
      })),
    };
  } catch {
    return null;
  }
}
