import "server-only";
import { prisma } from "@/lib/prisma";
import { MONTHLY_PLAN_RE } from "@/lib/pipeline";
import { getSecret, markSynced, markError } from "./connections";
import type { DeliverableType, ProjectStatus } from "@prisma/client";
import type { NotifyTarget } from "@/lib/notify";

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
  rescheduleAppointment: (id: string, body: { start_at: string; end_at: string; notify_customer?: boolean }) =>
    aryeoRequest(`/appointments/${id}/reschedule`, { method: "PUT", body }),
  cancelAppointment: (id: string, body: { notify_customer?: boolean } = {}) =>
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

// ---------------------------------------------------------------------------
// Aryeo payload shapes (verified against the live v1 API). Money amounts are
// always integer cents. customer/items/appointments embed via ?include=.
// ---------------------------------------------------------------------------
interface AryeoCustomer {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
  office_name?: string;
  license_number?: string;
  internal_notes?: string;
}
interface AryeoAddress {
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
export interface AryeoListing {
  id?: string;
  address?: AryeoAddress;
  square_feet?: number;
  delivery_status?: string; // DELIVERED | UNDELIVERED
  thumbnail_url?: string;
  large_thumbnail_url?: string;
  is_showcasable?: boolean;
  images?: AryeoImage[];
  videos?: unknown[];
  floor_plans?: unknown[];
  interactive_content?: unknown[];
  files?: unknown[];
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
  is_twilight?: boolean;
  description?: string;
  categories?: { title?: string }[];
  tags?: { name?: string; title?: string }[];
  variants?: AryeoProductVariant[];
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

export type ParsedDeliverable = { type: DeliverableType; label: string; quantity: number };

// Collapse a project's parsed deliverables to ONE per type. Several order items
// can each mention the same deliverable in their descriptions (e.g. a Zillow
// add-on and a package both list "photos" + "floor plan", and an extra item like
// "Missing Office Photo" adds another photos) — without this they'd show up two
// or three times. One deliverable per type is what we QA/deliver/track.
export function dedupeParsedDeliverables(parsed: ParsedDeliverable[]): ParsedDeliverable[] {
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
  for (const d of parsed) {
    const ex = byType.get(d.type);
    if (!ex) byType.set(d.type, { ...d });
    else {
      ex.quantity = Math.max(ex.quantity, d.quantity);
      if (rank(d.label) > rank(ex.label)) ex.label = d.label;
    }
  }
  return [...byType.values()];
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
  ["Zillow Showcase 3D Tour Add-on", ["ZILLOW_3D", "FLOORPLAN"]],
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
  ["EVERYTHING BUNDLE - Photography, Video, Drone, Zillow 3D Tour/Floor Plan, & More!", ["PHOTOS", "VIDEO", "SOCIAL_REEL", "DRONE", "ZILLOW_3D", "FLOORPLAN"]],
  ["BASICS BUNDLE - Photography, Drone Photos, Zillow 3D Tour / Floor Plan", ["PHOTOS", "DRONE", "ZILLOW_3D", "FLOORPLAN", "TWILIGHT"]],
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
  return undefined;
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

export function itemToDeliverables(item: AryeoOrderItem): ParsedDeliverable[] {
  const title = (item.title || item.subtitle || item.sub_title || "Item").trim();
  const qty = item.quantity || 1;

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
    return mapped.map((type) => ({
      type,
      label:
        monthlyPlan && (type === "SOCIAL_REEL" || type === "VIDEO")
          ? title
          : premium && (type === "SOCIAL_REEL" || type === "VIDEO")
            ? `Premium ${TYPE_LABEL[type]}`
            : (TYPE_LABEL[type] ?? title),
      quantity: qty,
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
      return [{ type: "VIDEO", label: title, quantity: qty }];
    }
    // A photo package/bundle (or interior/exterior-only coverage) is, at its
    // core, photography → PHOTOS (AutoHDR). Fees/travel/misc → OTHER.
    if (/package|bundle|interior|exterior/i.test(title)) return [{ type: "PHOTOS", label: title, quantity: qty }];
    return [{ type: deliverableType(title), label: title, quantity: qty }];
  }

  // Single-service item → keep the real product name as the label.
  if (found.length === 1) return [{ type: found[0].type, label: title, quantity: qty }];

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
  opts: { full?: boolean; orderId?: string } = {},
): Promise<{ imported: number; updated: number; clients: number; scanned: number }> {
  let imported = 0;
  let updated = 0;
  let scanned = 0;
  let clientsCreated = 0;

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
      const created = await prisma.client.create({
        data: {
          name: customerName(cust),
          email: cust?.email ?? null,
          phone: cust?.phone ?? null,
          company: cust?.office_name ?? null,
          licenseNumber: cust?.license_number ?? null,
          generalNotes: cust?.internal_notes ?? null,
          aryeoCustomerId: cust?.id ?? null,
        },
      });
      clientsCreated++;
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
    let page = 1;
    let stop = false;
    for (let i = 0; i < 200 && !stop; i++) {
      let batch: AryeoOrder[];
      let lastPage: number | undefined;
      if (opts.orderId) {
        // Single-order mode: one fetch, one pass, no pagination.
        const one = await Aryeo.order(opts.orderId).catch(() => null);
        batch = one ? [one] : [];
        stop = true;
      } else {
        const res = await aryeoRequest<{ data: AryeoOrder[]; meta?: { last_page?: number } }>("/orders", {
          query: { include: ORDER_INCLUDES, page, per_page: perPage },
        });
        batch = res?.data ?? [];
        lastPage = res?.meta?.last_page;
      }
      if (batch.length === 0) break;

      for (const order of batch) {
        if (!order.id) continue;
        scanned++;
        // Newest-first: once we pass the window floor (full = all history,
        // incremental = the recent window), stop entirely. An explicit
        // single-order refresh ignores the floor — the owner asked for THIS job.
        if (!opts.orderId && order.created_at && new Date(order.created_at) < floorDate) {
          stop = true;
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

          if (moneyChanged || cancelNow || clientChanged || clientNeedsResolve) {
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
                ...(newClientId !== proj.clientId ? { clientId: newClientId } : {}),
                ...(cancelNow ? { status: "CANCELLED" } : {}),
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
            });
            updated++;
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
            // Square footage lives on the LISTING, not the address. It was never
            // mapped (audit: 0/153 projects had it), so the culling budget had
            // nothing to size the 50-vs-80 photo default on — every home fell
            // back to 50. Pull it through so large homes get the 80 target.
            squareFeet:
              order.listing?.square_feet != null ? Math.round(order.listing.square_feet) : null,
            orderedAt: order.created_at ? new Date(order.created_at) : null,
            shootDate: shootDate ? new Date(shootDate) : null,
            deliveredAt: order.fulfilled_at ? new Date(order.fulfilled_at) : null,
            deliverables: {
              create: dedupeParsedDeliverables(items.filter((it) => !it.is_canceled).flatMap(itemToDeliverables)),
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
      if (last ? page >= last : batch.length < perPage) break;
      page++;
    }

    await markSynced("aryeo");
    return { imported, updated, clients: clientsCreated, scanned };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markError("aryeo", msg);
    throw e;
  }
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
// Enrich clients from /customer-users. The customer object embedded on orders
// is a GROUP (name/email/phone only) — it does NOT carry the agent's license #,
// brokerage, or internal notes. Those live on the customer-user record, so we
// match by email and backfill any EMPTY client fields (never overwrite edits).
// ---------------------------------------------------------------------------
export async function syncAryeoCustomers(): Promise<{ enriched: number }> {
  const { prisma } = await import("@/lib/prisma");
  const customers = await Aryeo.customerUsers();
  const byEmail = new Map<string, AryeoCustomerUser>();
  for (const c of customers) if (c.email) byEmail.set(c.email.toLowerCase(), c);
  if (byEmail.size === 0) return { enriched: 0 };

  const clients = await prisma.client.findMany({
    where: { email: { not: null } },
    select: { id: true, email: true, phone: true, company: true, licenseNumber: true, generalNotes: true },
  });
  let enriched = 0;
  for (const cl of clients) {
    const cu = byEmail.get((cl.email ?? "").toLowerCase());
    if (!cu) continue;
    const data: Record<string, string> = {};
    if (!cl.phone && cu.phone) data.phone = cu.phone;
    if (!cl.company && cu.agent_company_name) data.company = cu.agent_company_name;
    if (!cl.licenseNumber && cu.agent_license_number) data.licenseNumber = cu.agent_license_number;
    if (!cl.generalNotes && cu.internal_notes) data.generalNotes = cu.internal_notes;
    if (Object.keys(data).length > 0) {
      await prisma.client.update({ where: { id: cl.id }, data });
      enriched++;
    }
  }
  return { enriched };
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
        generalNotes: cu.internal_notes ?? null,
        // Keep the Aryeo id only when it isn't already taken (it's @unique).
        aryeoCustomerId: cu.id && !usedAryeoId.has(cu.id) ? cu.id : null,
      },
    });
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
  opts: { recentOnlyDays?: number; orderId?: string } = {},
): Promise<{
  appointments: number;
  photographerAssigned: number;
}> {
  // Hourly cron passes recentOnlyDays so we only write recent + all future
  // appointments (past shoots are already stored) — keeps the run fast enough
  // to never time out. The daily cron runs it unbounded to reconcile everything.
  const windowAgoTs = opts.recentOnlyDays ? Date.now() - opts.recentOnlyDays * 86_400_000 : null;

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
  let page = 1;
  for (let i = 0; i < 200; i++) {
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
        const street = (titleByProject.get(projectId) || "a shoot").split(",")[0].trim();
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
    if (last ? page >= last : batch.length < perPage) break;
    page++;
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
    const candProjects = await prisma.project.findMany({
      where: { id: { in: deadCandidates }, shootDate: { gt: new Date() } },
      select: { id: true },
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
    }
  }

  // VA = Kyle on all Aryeo projects.
  if (va) {
    await prisma.project.updateMany({ where: { source: "ARYEO" }, data: { vaId: va.id } });
  }

  return { appointments: appointmentCount, photographerAssigned: assigned };
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
export async function reclassifyAryeoDeliverables(): Promise<{ projects: number; before: number; after: number }> {
  const { prisma } = await import("@/lib/prisma");
  const projects = await prisma.project.findMany({
    where: { aryeoOrderId: { not: null } },
    select: { id: true, aryeoOrderId: true, status: true, deliverables: { select: { type: true, status: true } } },
  });
  const byOrder = new Map(projects.map((p) => [p.aryeoOrderId!, p]));
  type Proj = (typeof projects)[number];

  let changed = 0, before = 0, after = 0;
  const rebuild = async (proj: Proj, items: AryeoOrderItem[]) => {
    const parsed = dedupeParsedDeliverables(items.filter((it) => !it.is_canceled).flatMap(itemToDeliverables));
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
    select: { id: true, aryeoOrderId: true, deliverables: { select: { id: true, type: true, label: true } } },
  });
  let scanned = 0, relabeled = 0;
  for (const proj of projects) {
    scanned++;
    let order: AryeoOrder;
    try { order = await Aryeo.order(proj.aryeoOrderId!); } catch { continue; }
    const parsed = dedupeParsedDeliverables((order.items ?? []).filter((it) => !it.is_canceled).flatMap(itemToDeliverables));
    const want = new Map<string, string>();
    for (const p of parsed) want.set(p.type, p.label);
    for (const d of proj.deliverables) {
      const desired = want.get(d.type);
      if (desired && desired !== d.label) {
        await prisma.deliverable.update({ where: { id: d.id }, data: { label: desired } });
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
export type MediaVideo = { title: string | null; thumb: string | null; playback: string | null; download: string | null; duration: number | null };
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
    const videos = (l.videos ?? []) as { title?: string; thumbnail_url?: string; playback_url?: string; download_url?: string; duration?: number }[];
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
