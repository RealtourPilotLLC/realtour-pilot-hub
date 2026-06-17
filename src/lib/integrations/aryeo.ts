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
export const Aryeo = {
  request: aryeoRequest,
  orders: (q?: Query) => fetchAll<AryeoOrder>("/orders", q),
  order: (id: string) => aryeoRequest<{ data: AryeoOrder }>(`/orders/${id}`).then((r) => r.data),
  listings: (q?: Query) => fetchAll<AryeoListing>("/listings", q),
  listing: (id: string) => aryeoRequest<{ data: AryeoListing }>(`/listings/${id}`).then((r) => r.data),
  appointments: (q?: Query) => fetchAll<AryeoAppointment>("/appointments", q),
  products: (q?: Query) => fetchAll<unknown>("/products", q),
  vendors: (q?: Query) => fetchAll<unknown>("/vendors", q),
};

// ---------------------------------------------------------------------------
// Loose shapes — Aryeo's payloads vary, so we read defensively everywhere.
// ---------------------------------------------------------------------------
type Money = { amount?: number; currency?: string } | number | null | undefined;

interface AryeoCustomer {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  email?: string;
  phone_number?: string;
  phone?: string;
  company_name?: string;
}
interface AryeoAddress {
  address_line_1?: string;
  city_locality?: string;
  city?: string;
  state_province?: string;
  state?: string;
  postal_code?: string;
  zip_code?: string;
  formatted_address?: string;
}
interface AryeoListing {
  id?: string;
  address?: AryeoAddress;
  square_feet?: number;
}
interface AryeoAppointment {
  id?: string;
  start_at?: string;
  start_time?: string;
}
interface AryeoOrderItem {
  quantity?: number;
  title?: string;
  product?: { title?: string; category?: string };
}
interface AryeoOrder {
  id?: string;
  fulfillment_status?: string;
  payment_status?: string;
  total?: Money;
  total_amount?: Money;
  amount_total?: Money;
  currency?: string;
  created_at?: string;
  customer?: AryeoCustomer;
  contact?: AryeoCustomer;
  listing?: AryeoListing;
  listings?: AryeoListing[];
  items?: AryeoOrderItem[];
  order_items?: AryeoOrderItem[];
  products?: { title?: string; category?: string; quantity?: number }[];
  appointments?: AryeoAppointment[];
}

// ---- field helpers --------------------------------------------------------
function money(...candidates: Money[]): number | null {
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "number") return c > 1000 ? c / 100 : c; // heuristic: large ints are cents
    if (typeof c === "object" && typeof c.amount === "number") return c.amount / 100;
  }
  return null;
}

function customerName(c?: AryeoCustomer): string {
  if (!c) return "Unknown client";
  if (c.name) return c.name;
  const full = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return full || c.email || "Unknown client";
}

function addressTitle(l?: AryeoListing): string | null {
  const a = l?.address;
  if (!a) return null;
  return a.formatted_address || a.address_line_1 || null;
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

function initialStatus(order: AryeoOrder): ProjectStatus {
  const f = (order.fulfillment_status || "").toLowerCase();
  if (f.includes("fulfil") || f.includes("deliver")) return "DELIVERED";
  if ((order.appointments?.length ?? 0) > 0) return "SCHEDULED";
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
// Sync: pull all orders → upsert clients, projects, deliverables.
// Non-destructive on re-sync: never clobbers manual status/owner changes.
// ---------------------------------------------------------------------------
export async function syncAryeoOrders(): Promise<{ imported: number; updated: number; clients: number }> {
  let imported = 0;
  let updated = 0;
  const clientIds = new Set<string>();

  try {
    const orders = await Aryeo.orders();

    for (const order of orders) {
      if (!order.id) continue;
      const cust = order.customer ?? order.contact;
      const listing = order.listing ?? order.listings?.[0];
      const title = addressTitle(listing) || customerName(cust) + " — order";
      const addr = listing?.address;

      // Upsert client (match by aryeoCustomerId, else by email).
      let clientId: string;
      const existingClient = cust?.id
        ? await prisma.client.findUnique({ where: { aryeoCustomerId: cust.id } })
        : cust?.email
          ? await prisma.client.findFirst({ where: { email: cust.email } })
          : null;

      if (existingClient) {
        clientId = existingClient.id;
        await prisma.client.update({
          where: { id: existingClient.id },
          data: {
            aryeoCustomerId: cust?.id ?? existingClient.aryeoCustomerId,
            phone: existingClient.phone ?? cust?.phone_number ?? cust?.phone,
            company: existingClient.company ?? cust?.company_name,
          },
        });
      } else {
        const created = await prisma.client.create({
          data: {
            name: customerName(cust),
            email: cust?.email ?? null,
            phone: cust?.phone_number ?? cust?.phone ?? null,
            company: cust?.company_name ?? null,
            aryeoCustomerId: cust?.id ?? null,
          },
        });
        clientId = created.id;
      }
      clientIds.add(clientId);

      const appt = order.appointments?.[0];
      const shootDate = appt?.start_at || appt?.start_time;
      const price = money(order.total, order.total_amount, order.amount_total);

      const existing = await prisma.project.findUnique({ where: { aryeoOrderId: order.id } });

      if (existing) {
        // Non-destructive update: refresh facts, preserve workflow state.
        await prisma.project.update({
          where: { id: existing.id },
          data: {
            price: price ?? existing.price,
            addressLine: addr?.address_line_1 ?? existing.addressLine,
            city: addr?.city_locality ?? addr?.city ?? existing.city,
            state: addr?.state_province ?? addr?.state ?? existing.state,
            zip: addr?.postal_code ?? addr?.zip_code ?? existing.zip,
            shootDate: existing.shootDate ?? (shootDate ? new Date(shootDate) : null),
            aryeoListingId: listing?.id ?? existing.aryeoListingId,
          },
        });
        updated++;
        continue;
      }

      // Create new project + deliverables.
      const items = (order.items ?? order.order_items ?? order.products ?? []) as Array<{
        title?: string;
        quantity?: number;
        product?: { title?: string; category?: string };
      }>;
      const project = await prisma.project.create({
        data: {
          title,
          source: "ARYEO",
          aryeoOrderId: order.id,
          aryeoListingId: listing?.id ?? null,
          status: initialStatus(order),
          clientId,
          price,
          addressLine: addr?.address_line_1 ?? null,
          city: addr?.city_locality ?? addr?.city ?? null,
          state: addr?.state_province ?? addr?.state ?? null,
          zip: addr?.postal_code ?? addr?.zip_code ?? null,
          squareFeet: listing?.square_feet ?? null,
          shootDate: shootDate ? new Date(shootDate) : null,
          deliverables: {
            create: items.map((it) => {
              const label = it.title || it.product?.title || "Item";
              return {
                type: deliverableType(String(label)),
                label: String(label),
                quantity: it.quantity || 1,
              };
            }),
          },
          activities: {
            create: { type: "SYSTEM", body: `Imported from Aryeo (order ${order.id}).` },
          },
        },
      });
      if (project) imported++;
    }

    await markSynced("aryeo");
    return { imported, updated, clients: clientIds.size };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markError("aryeo", msg);
    throw e;
  }
}
