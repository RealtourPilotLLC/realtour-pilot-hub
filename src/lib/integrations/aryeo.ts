import "server-only";
import { prisma } from "@/lib/prisma";
import { getSecret, markSynced, markError } from "./connections";
import type { DeliverableType, ProjectStatus } from "@prisma/client";

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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new AryeoError("Aryeo timed out — please try again.", 504);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

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
  for (const d of parsed) {
    const ex = byType.get(d.type);
    if (!ex) byType.set(d.type, { ...d });
    else ex.quantity = Math.max(ex.quantity, d.quantity);
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
// percentage is applied to.
export function payableInvoiceFromItems(items: AryeoOrderItem[]): number {
  const cents = items
    .filter((it) => !it.is_canceled && !isPayExcludedItem(it))
    .reduce((sum, it) => sum + (typeof it.amount === "number" ? it.amount : 0), 0);
  return Math.round(cents) / 100;
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
export function itemToDeliverables(item: AryeoOrderItem): ParsedDeliverable[] {
  const title = (item.title || item.subtitle || item.sub_title || "Item").trim();
  const qty = item.quantity || 1;

  const mapped = PRODUCT_DELIVERABLES.get(normProduct(title));
  if (mapped) {
    const premium = isPremiumProduct(title);
    return mapped.map((type) => ({
      type,
      label: premium && (type === "SOCIAL_REEL" || type === "VIDEO") ? `Premium ${TYPE_LABEL[type]}` : (TYPE_LABEL[type] ?? title),
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

  // No media keywords matched. A photo package/bundle (or interior/exterior-only
  // coverage) is, at its core, photography → PHOTOS (AutoHDR). Fees/travel/misc
  // fall through to OTHER.
  if (found.length === 0) {
    if (/package|bundle|interior|exterior/i.test(title)) return [{ type: "PHOTOS", label: title, quantity: qty }];
    return [{ type: deliverableType(title), label: title, quantity: qty }];
  }

  // Single-service item → keep the real product name as the label.
  if (found.length === 1) return [{ type: found[0].type, label: title, quantity: qty }];

  // Multi-service bundle → one deliverable per detected component.
  return found.map((c) => ({ type: c.type, label: c.label, quantity: qty }));
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
  opts: { full?: boolean } = {},
): Promise<{ imported: number; clients: number; scanned: number }> {
  let imported = 0;
  let scanned = 0;
  let clientsCreated = 0;

  try {
    // Preload what we already have to avoid a per-order round-trip.
    const [existingProjects, existingClients] = await Promise.all([
      prisma.project.findMany({
        where: { aryeoOrderId: { not: null } },
        select: { aryeoOrderId: true },
      }),
      prisma.client.findMany({ select: { id: true, aryeoCustomerId: true, email: true } }),
    ]);
    const seenOrders = new Set(existingProjects.map((p) => p.aryeoOrderId!));

    // Map Aryeo company-team-member id → our TeamMember id (for shoot assignment).
    const team = await prisma.teamMember.findMany({
      where: { aryeoTeamMemberId: { not: null } },
      select: { id: true, aryeoTeamMemberId: true },
    });
    const teamByCtm = new Map(team.map((t) => [t.aryeoTeamMemberId!, t.id]));

    const clientByAryeoId = new Map<string, string>();
    const clientByEmail = new Map<string, string>();
    for (const c of existingClients) {
      if (c.aryeoCustomerId) clientByAryeoId.set(c.aryeoCustomerId, c.id);
      if (c.email) clientByEmail.set(c.email.toLowerCase(), c.id);
    }

    const resolveClient = async (cust?: AryeoCustomer): Promise<string> => {
      const byId = cust?.id ? clientByAryeoId.get(cust.id) : undefined;
      if (byId) return byId;
      const byEmail = cust?.email ? clientByEmail.get(cust.email.toLowerCase()) : undefined;
      if (byEmail) return byEmail;
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
      if (cust?.id) clientByAryeoId.set(cust.id, created.id);
      if (cust?.email) clientByEmail.set(cust.email.toLowerCase(), created.id);
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
      const res = await aryeoRequest<{ data: AryeoOrder[]; meta?: { last_page?: number } }>("/orders", {
        query: { include: ORDER_INCLUDES, page, per_page: perPage },
      });
      const batch = res?.data ?? [];
      if (batch.length === 0) break;

      for (const order of batch) {
        if (!order.id) continue;
        scanned++;
        // Newest-first: once we pass the window floor (full = all history,
        // incremental = the recent window), stop entirely.
        if (order.created_at && new Date(order.created_at) < floorDate) {
          stop = true;
          break;
        }
        // Already imported — skip it, but KEEP scanning the window so a
        // late-finalized order sitting behind it still gets picked up.
        if (seenOrders.has(order.id)) continue;

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

        await prisma.project.create({
          data: {
            title: addressTitle(order),
            source: "ARYEO",
            aryeoOrderId: order.id,
            aryeoListingId: order.listing?.id ?? null,
            status: initialStatus(order),
            clientId,
            photographerId,
            price: money(order.total_amount),
            payableInvoice: payableInvoiceFromItems(items),
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
            orderedAt: order.created_at ? new Date(order.created_at) : null,
            shootDate: shootDate ? new Date(shootDate) : null,
            deliveredAt: order.fulfilled_at ? new Date(order.fulfilled_at) : null,
            deliverables: {
              create: dedupeParsedDeliverables(items.filter((it) => !it.is_canceled).flatMap(itemToDeliverables)),
            },
            activities: {
              create: { type: "SYSTEM", body: `Imported from Aryeo (order #${order.number ?? order.id}).` },
            },
          },
        });
        seenOrders.add(order.id);
        imported++;
      }

      const last = res?.meta?.last_page;
      if (last ? page >= last : batch.length < perPage) break;
      page++;
    }

    await markSynced("aryeo");
    return { imported, clients: clientsCreated, scanned };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markError("aryeo", msg);
    throw e;
  }
}

// Backfill payableInvoice on existing projects by re-reading each order's items
// (excludes canceled + virtual/AI). Run once after adding the field; cheap going
// forward since new orders set it at import.
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
      const val = payableInvoiceFromItems(order.items ?? []);
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
// who placed a recent order. Matches existing clients by email; creates the
// rest. Idempotent — only creates the missing ones.
export async function syncAllAryeoClients(): Promise<{ created: number; scanned: number }> {
  const { prisma } = await import("@/lib/prisma");
  const customers = await Aryeo.customerUsers();
  const existing = await prisma.client.findMany({ select: { email: true, aryeoCustomerId: true } });
  const haveEmail = new Set(existing.map((c) => (c.email ?? "").toLowerCase()).filter(Boolean));
  const usedAryeoId = new Set(existing.map((c) => c.aryeoCustomerId).filter(Boolean) as string[]);

  let created = 0;
  for (const cu of customers) {
    const email = (cu.email ?? "").toLowerCase();
    if (!email || haveEmail.has(email)) continue;
    haveEmail.add(email);
    const name = cu.full_name || [cu.first_name, cu.last_name].filter(Boolean).join(" ") || cu.email!;
    await prisma.client.create({
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
    if (cu.id) usedAryeoId.add(cu.id);
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

  for (let page = 1; page <= 30; page++) {
    const r = await aryeoRequest<{ data?: { email?: string }[]; meta?: { last_page?: number } }>(
      `/customer-users?include=${inc}&per_page=100&page=${page}`,
    );
    const rows = r?.data ?? [];
    if (rows.length === 0) break;
    for (const cu of rows) {
      const email = (cu.email ?? "").toLowerCase();
      if (!email) continue;
      const vals = extractSocial(cu);
      if (vals) byEmail.set(email, vals);
    }
    const last = r?.meta?.last_page;
    if ((last && page >= last) || rows.length < 100) break;
  }

  const clients = await prisma.client.findMany({
    where: { email: { not: null } },
    select: { id: true, email: true, socialClient: true, socialPlan: true },
  });
  let updated = 0;
  let matched = 0;
  for (const cl of clients) {
    const v = byEmail.get((cl.email ?? "").toLowerCase());
    if (!v) continue;
    matched++;
    if (cl.socialClient === v.socialClient && cl.socialPlan === v.socialPlan) continue;
    await prisma.client.update({
      where: { id: cl.id },
      data: { socialClient: v.socialClient, socialPlan: v.socialPlan },
    });
    updated++;
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
export async function syncAryeoAppointments(opts: { recentOnlyDays?: number } = {}): Promise<{
  appointments: number;
  photographerAssigned: number;
}> {
  // Hourly cron passes recentOnlyDays so we only write recent + all future
  // appointments (past shoots are already stored) — keeps the run fast enough
  // to never time out. The daily cron runs it unbounded to reconcile everything.
  const windowAgoTs = opts.recentOnlyDays ? Date.now() - opts.recentOnlyDays * 86_400_000 : null;

  // Preload lookups.
  const [projects, team] = await Promise.all([
    prisma.project.findMany({ where: { aryeoOrderId: { not: null } }, select: { id: true, aryeoOrderId: true } }),
    prisma.teamMember.findMany({ select: { id: true, aryeoUserId: true, name: true, isServiceProvider: true } }),
  ]);
  const projectByOrder = new Map(projects.map((p) => [p.aryeoOrderId!, p.id]));
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
    const res = await aryeoRequest<{ data: AryeoAppointment[]; meta?: { last_page?: number } }>("/appointments", {
      query: { include: "users,order", page, per_page: perPage },
    });
    const batch = res?.data ?? [];
    if (batch.length === 0) break;

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

    const last = res?.meta?.last_page;
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
        ...(info.photographerId ? { photographerId: info.photographerId } : {}),
        ...(info.shootDate ? { shootDate: info.shootDate } : {}),
      },
    });
    if (info.photographerId) assigned++;
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
