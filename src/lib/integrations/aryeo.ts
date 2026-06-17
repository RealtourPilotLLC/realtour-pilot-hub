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

export const Aryeo = {
  request: aryeoRequest,
  orders: (q?: Query) => fetchAll<AryeoOrder>("/orders", { include: ORDER_INCLUDES, ...q }),
  order: (id: string) =>
    aryeoRequest<{ data: AryeoOrder }>(`/orders/${id}`, { query: { include: ORDER_INCLUDES } }).then(
      (r) => r.data,
    ),
  listings: (q?: Query) => fetchAll<AryeoListing>("/listings", q),
  listing: (id: string) => aryeoRequest<{ data: AryeoListing }>(`/listings/${id}`).then((r) => r.data),
  appointments: (q?: Query) => fetchAll<AryeoAppointment>("/appointments", q),
  products: (q?: Query) => fetchAll<unknown>("/products", q),
  vendors: (q?: Query) => fetchAll<unknown>("/vendors", q),
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
interface AryeoListing {
  id?: string;
  address?: AryeoAddress;
  square_feet?: number;
}
interface AryeoAppointment {
  id?: string;
  start_at?: string;
  end_at?: string;
  status?: string;
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

function initialStatus(order: AryeoOrder): ProjectStatus {
  const f = (order.fulfillment_status || "").toUpperCase();
  if (f === "FULFILLED" || order.fulfilled_at) return "DELIVERED";
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
      const cust = order.customer;
      const addr = order.address;
      const title = addressTitle(order);

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
            phone: existingClient.phone ?? cust?.phone ?? null,
            company: existingClient.company ?? cust?.office_name ?? null,
          },
        });
      } else {
        const created = await prisma.client.create({
          data: {
            name: customerName(cust),
            email: cust?.email ?? null,
            phone: cust?.phone ?? null,
            company: cust?.office_name ?? null,
            aryeoCustomerId: cust?.id ?? null,
          },
        });
        clientId = created.id;
      }
      clientIds.add(clientId);

      const shootDate = order.appointments?.[0]?.start_at;
      const price = money(order.total_amount);
      const addressLine = [addr?.street_number, addr?.street_name].filter(Boolean).join(" ") || null;

      const existing = await prisma.project.findUnique({ where: { aryeoOrderId: order.id } });

      if (existing) {
        // Non-destructive update: refresh facts, preserve workflow state
        // (status, assignments, notes the team changed by hand).
        await prisma.project.update({
          where: { id: existing.id },
          data: {
            title,
            price: price ?? existing.price,
            addressLine: addressLine ?? existing.addressLine,
            city: addr?.city ?? existing.city,
            state: addr?.state_or_province ?? existing.state,
            zip: addr?.postal_code ?? existing.zip,
            shootDate: existing.shootDate ?? (shootDate ? new Date(shootDate) : null),
          },
        });
        updated++;
        continue;
      }

      // Create new project + deliverables from order line items.
      const items = order.items ?? [];
      await prisma.project.create({
        data: {
          title,
          source: "ARYEO",
          aryeoOrderId: order.id,
          status: initialStatus(order),
          clientId,
          price,
          addressLine,
          city: addr?.city ?? null,
          state: addr?.state_or_province ?? null,
          zip: addr?.postal_code ?? null,
          shootDate: shootDate ? new Date(shootDate) : null,
          deliveredAt: order.fulfilled_at ? new Date(order.fulfilled_at) : null,
          deliverables: {
            create: items.map((it) => {
              const label = it.title || it.subtitle || "Item";
              return {
                type: deliverableType(label),
                label,
                quantity: it.quantity || 1,
              };
            }),
          },
          activities: {
            create: { type: "SYSTEM", body: `Imported from Aryeo (order #${order.number ?? order.id}).` },
          },
        },
      });
      imported++;
    }

    await markSynced("aryeo");
    return { imported, updated, clients: clientIds.size };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markError("aryeo", msg);
    throw e;
  }
}
