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
  opts: { method?: string; query?: Query; body?: unknown; key?: string } = {},
): Promise<T> {
  const key = opts.key ?? (await getSecret("aryeo"));
  if (!key) throw new AryeoError("Aryeo is not connected — no API key on file.", 401);

  const url = new URL(`${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });

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

// Only import orders created on/after this date. Aryeo history goes back years;
// the hub focuses on current work. Bump this to widen the window.
const ARYEO_MIN_DATE = new Date("2026-01-01T00:00:00Z");

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
  appointment: (id: string) => aryeoRequest<{ data: AryeoAppointment }>(`/appointments/${id}`).then((r) => r.data),
  rescheduleAppointment: (id: string, body: unknown) =>
    aryeoRequest(`/appointments/${id}/reschedule`, { method: "PUT", body }),
  cancelAppointment: (id: string) => aryeoRequest(`/appointments/${id}/cancel`, { method: "PUT" }),
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

  // Forms, tags, company
  orderForms: (q?: Query) => fetchAll<unknown>("/order-forms", q),
  tags: (q?: Query) => fetchAll<AryeoTag>("/tags", q),
  groups: (q?: Query) => fetchAll<unknown>("/groups", q),
  group: () => fetchAll<AryeoGroup>("/groups").then((g) => g[0]),

  // Permission-gated for the current key (work once the key is granted these):
  discounts: (q?: Query) => fetchAll<unknown>("/discounts", q), // (perm)
  addresses: (q?: Query) => fetchAll<unknown>("/addresses", q), // (perm)
};

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
  start_at?: string;
  end_at?: string;
  status?: string; // SCHEDULED | CANCELED | UNSCHEDULED
  initial_assigned_company_team_member_id?: string | null;
}
interface AryeoOrderItem {
  id?: string;
  title?: string;
  subtitle?: string;
  quantity?: number;
}
interface AryeoOrder {
  id?: string;
  number?: number;
  title?: string;
  fulfillment_status?: string; // FULFILLED | UNFULFILLED
  payment_status?: string; // PAID | ...
  order_status?: string;
  total_amount?: number; // cents
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
  [/matterport|3d tour/i, "MATTERPORT_3D"],
  [/zillow/i, "ZILLOW_3D"],
  [/twilight|dusk/i, "TWILIGHT"],
  [/drone|aerial/i, "DRONE"],
  [/virtual stag/i, "VIRTUAL_STAGING"],
  [/reel|social/i, "SOCIAL_REEL"],
  [/headshot|portrait/i, "HEADSHOT"],
  [/video|walkthrough|cinematic/i, "VIDEO"],
  [/photo|image|hdr/i, "PHOTOS"],
];

function deliverableType(label: string): DeliverableType {
  for (const [re, t] of TYPE_KEYWORDS) if (re.test(label)) return t;
  return "OTHER";
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

    // Paginate newest-first so incremental can stop early.
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
        // Orders are newest-first: once we pass the cutoff date, stop entirely.
        if (order.created_at && new Date(order.created_at) < ARYEO_MIN_DATE) {
          stop = true;
          break;
        }
        if (seenOrders.has(order.id)) {
          if (!opts.full) {
            stop = true; // everything older is already imported
            break;
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
            addressLine: [addr?.street_number, addr?.street_name].filter(Boolean).join(" ") || null,
            city: addr?.city ?? null,
            state: addr?.state_or_province ?? null,
            zip: addr?.postal_code ?? null,
            shootDate: shootDate ? new Date(shootDate) : null,
            deliveredAt: order.fulfilled_at ? new Date(order.fulfilled_at) : null,
            deliverables: {
              create: items.map((it) => {
                const label = it.title || it.subtitle || "Item";
                return { type: deliverableType(label), label, quantity: it.quantity || 1 };
              }),
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

// Fetch a listing's media live (for the project detail gallery). Returns a
// compact summary plus gallery image URLs. Never throws — returns null on error.
export async function getListingMedia(listingId: string): Promise<{
  deliveryStatus: string | null;
  photoCount: number;
  videoCount: number;
  floorPlanCount: number;
  cover: string | null;
  images: { thumb: string; large: string; caption: string | null }[];
} | null> {
  try {
    const l = await Aryeo.listing(listingId);
    const images = (l.images ?? []).filter((i) => i.display_in_gallery !== false);
    return {
      deliveryStatus: l.delivery_status ?? null,
      photoCount: l.images?.length ?? 0,
      videoCount: l.videos?.length ?? 0,
      floorPlanCount: l.floor_plans?.length ?? 0,
      cover: l.thumbnail_url ?? images[0]?.thumbnail_url ?? null,
      images: images.slice(0, 24).map((i) => ({
        thumb: i.thumbnail_url ?? i.large_url ?? i.original_url ?? "",
        large: i.large_url ?? i.original_url ?? i.thumbnail_url ?? "",
        caption: i.caption ?? null,
      })),
    };
  } catch {
    return null;
  }
}
