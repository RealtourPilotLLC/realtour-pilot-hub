// ---------------------------------------------------------------------------
// A STATEFUL FAKE ARYEO for the CP-04 / CP-05 drills (Sep 24 2026).
//
// Built from the Phase 0 endpoint docs saved in the session scratchpad
// (aryeo-recon/*.md): the request fields each write takes, the resource shapes
// each read returns, and the envelope ({ status, data }, list meta). Nothing in
// it came from a real write — no real write has ever been made — so every
// shape here is the DOCUMENTED contract, and the drills prove the hub's state
// machine against that contract, not Aryeo itself.
//
// It is reached ONLY through the harness fetch fence:
//   const fake = createFakeAryeo();
//   const fence = fenceFetch((url, init) => fake.handle(url, init));
//
// What a drill can script (each consumed once, in order, per endpoint key):
//   fake.script("POST /orders", { status: 422 })          a refusal
//   fake.script("POST /orders", { status: 503 })          a 5xx (nothing committed)
//   fake.script("POST /orders", "abort-after-commit")     Aryeo commits, the caller times out
//   fake.script("POST /orders", "abort-before-commit")    the caller times out, nothing committed
//   fake.script("POST /appointments/store", "shift-start-30")  commits 30 min later than asked
//   fake.script("POST /appointments/store", "move-order-address")  commits, and the order's address now reads a different street
//   fake.script("POST /appointments/store", "add-fee-on-store")  commits, and the order now owes $75.00 (a fee Aryeo
//     attaches once a creative is on it — the spec's CompanyTeamMember.travel_fee_amount / ORDER_FEE_CREATED)
//   keys fold ids: "PATCH /addresses/:id", "PUT /appointments/:id/cancel"
// and it records every write (method, path, body) so a drill counts exactly
// what reached the provider.
//
// §6.6 batch 3 (Sep 25 2026) adds, each from the saved OpenAPI spec
// (~/Downloads/aryeo.txt) and the Phase 0 measurements:
//   · variant prices (R03): `variants` (product → its one variant) and
//     `variantPrices` (variant → cents) put a price on GET /products and on
//     every order made from it — total_amount AND balance_amount, unpaid — so a
//     drill can see a priced order; setOrderMoney() forces the next orders'
//     money (a customer-group price the catalogue does not show).
//   · GET /products/:id — served here for completeness, though the real route
//     404s for every id (Phase 0); the hub reads prices from the LIST.
//   · GET /customers/:id with an email (R02's fixture-identity read).
//   · GET /appointments with filter[start_at_gte|lte] and include order.address
//     (the adapter's fresh read of a creative's day, with where each one is).
//   · filter[appointment_id] on /scheduling/available-timeslots, with meta
//     echoing duration and company_team_member_ids as Phase 0 saw: "honour"
//     scopes to the appointment (optionally keeping `aryeoDriveMinutes` clear
//     around the creative's other appointments); "ignore" behaves as if the
//     filter were not there (no duration → 422, as the spec says).
//   · PUT /appointments/:id/schedule (the Aryeo-decides adapter's write).
//   · seedNeighbour(): another client's appointment at a map point.
// ---------------------------------------------------------------------------

export type FakeWrite = { method: string; path: string; body: unknown; committed: boolean };
type Behaviour = { status: number; message?: string } | "abort-after-commit" | "abort-before-commit" | "shift-start-30" | "move-order-address" | "add-fee-on-store";

type Address = {
  id: string; street_number: string | null; street_name: string | null; unit_number: string | null; city: string | null;
  state_or_province: string | null; postal_code: string | null; country: string | null; latitude: number | null; longitude: number | null;
  unparsed_address: string | null;
};
type Order = {
  id: string; number: number; title: string; internal_notes: string | null; customer: { id: string; name: string }; addressId: string | null;
  items: { id: string; title: string; variant_id: string; is_canceled: boolean; amount: number }[]; appointmentIds: string[]; created_at: string;
  order_status: string; fulfillment_status: string; payment_status: string; listingId: string | null;
  total: number; balance: number;
};
type Appt = { id: string; status: string; start_at: string | null; end_at: string | null; orderId: string; tmIds: string[]; updated_at: string };

export const DRILL_TEAM = {
  james: { tm: "0192aaaa-0000-4000-8000-00000000a001", user: "0192bbbb-0000-4000-8000-00000000b001", name: "James Drill" },
  jordan: { tm: "0192aaaa-0000-4000-8000-00000000a002", user: "0192bbbb-0000-4000-8000-00000000b002", name: "Jordan Drill" },
  harrison: { tm: "0192aaaa-0000-4000-8000-00000000a003", user: "0192bbbb-0000-4000-8000-00000000b003", name: "Harrison Drill" },
};

const BASE = "https://api.aryeo.com/v1";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const abortError = () => { const e = new Error("The operation was aborted."); e.name = "AbortError"; return e; };
let uuidSeq = 0;
const uuid = () => `0199${(++uuidSeq).toString(16).padStart(4, "0")}-0000-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, "0")}`;

export function createFakeAryeo(opts: {
  /** product id → the team-member ids assigned to it */
  products: Record<string, string[]>;
  /** starts offered on a weekday (ET wall-clock hours); default 9:00–14:00 every 30 min */
  hours?: number[];
  /** R03: product id → its one variant id (what GET /products lists and orders are made from). */
  variants?: Record<string, string>;
  /** R03: variant id → price in cents (default 0). */
  variantPrices?: Record<string, number>;
  /** R02: Aryeo customer id → that customer's email. Unknown ids get `defaultCustomerEmail` (404 when null). */
  customers?: Record<string, string | null>;
  defaultCustomerEmail?: string | null;
  /** W02: how filter[appointment_id] is treated (default "honour"). */
  appointmentScope?: "honour" | "ignore";
  /** W02: with "honour", minutes Aryeo keeps clear around the creative's other appointments (models "Aryeo counts drive time"). */
  aryeoDriveMinutes?: number;
} ) {
  const team = Object.values(DRILL_TEAM);
  const addresses = new Map<string, Address>();
  const orders = new Map<string, Order>();
  const appts = new Map<string, Appt>();
  const writes: FakeWrite[] = [];
  const reads: string[] = [];
  const scripts = new Map<string, Behaviour[]>();
  /** ISO starts nobody may book (taken since the client looked). */
  const taken = new Set<string>();
  let orderNo = 5000;
  /** R03: money forced onto the next orders created (null = from the catalogue). */
  let forcedMoney: { total: number; balance: number } | null = null;
  const priceOf = (variantId: string) => opts.variantPrices?.[variantId] ?? 0;

  const next = (key: string): Behaviour | null => {
    const q = scripts.get(key);
    return q && q.length ? q.shift()! : null;
  };

  const addressOut = (a: Address) => ({ object: "ADDRESS", ...a });
  const apptOut = (a: Appt) => ({
    object: "APPOINTMENT", id: a.id, status: a.status, start_at: a.start_at, end_at: a.end_at, updated_at: a.updated_at,
    duration: a.start_at && a.end_at ? Math.round((Date.parse(a.end_at) - Date.parse(a.start_at)) / 60000) : null,
    order: { id: a.orderId },
    users: a.tmIds.map((tm) => team.find((t) => t.tm === tm)).filter(Boolean).map((t) => ({ id: t!.user, full_name: t!.name, email: `${t!.name.split(" ")[0].toLowerCase()}@drill.invalid` })),
    company_team_members: a.tmIds.map((id) => ({ id })),
    can_cancel: a.status === "SCHEDULED", can_reschedule: a.status === "SCHEDULED",
  });
  const orderOut = (o: Order) => ({
    object: "ORDER", id: o.id, number: o.number, identifier: `Order #${o.number}`, title: o.title, internal_notes: o.internal_notes,
    order_status: o.order_status, fulfillment_status: o.fulfillment_status, payment_status: o.payment_status, currency: "USD",
    total_amount: o.total, balance_amount: o.balance, created_at: o.created_at,
    customer: { id: o.customer.id, name: o.customer.name, email: null },
    address: o.addressId ? addressOut(addresses.get(o.addressId)!) : null,
    items: o.items.map((i) => ({ id: i.id, title: i.title, quantity: 1, is_canceled: i.is_canceled, amount: i.amount })),
    appointments: o.appointmentIds.map((id) => apptOut(appts.get(id)!)),
    listing: o.listingId ? { id: o.listingId } : null,
  });

  /** A weekday's offered starts for a set of team members, minus anything booked or taken. */
  function slotsFor(date: string, durationMin: number, tmIds: string[], scope: { excludeApptId?: string; clearMin?: number } = {}) {
    const out: { start_at: string; end_at: string; users: { id: string }[] }[] = [];
    const hours = opts.hours ?? [9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14];
    for (const h of hours) {
      // ET wall clock → UTC: October 2026 is EDT (UTC-4) until Nov 1.
      const offset = date >= "2026-11-01" ? 5 : 4;
      const start = new Date(`${date}T00:00:00Z`);
      start.setUTCMinutes(Math.round((h + offset) * 60));
      const end = new Date(start.getTime() + durationMin * 60000);
      const iso = start.toISOString().replace(".000Z", "Z");
      if (taken.has(iso)) continue;
      const pad = (scope.clearMin ?? 0) * 60000;
      const free = tmIds.filter((tm) => ![...appts.values()].some((a) => a.id !== scope.excludeApptId && a.status !== "CANCELED" && a.tmIds.includes(tm) && a.start_at && a.end_at && Date.parse(a.start_at) - pad < end.getTime() && Date.parse(a.end_at) + pad > start.getTime()));
      if (!free.length) continue;
      out.push({ start_at: iso, end_at: end.toISOString().replace(".000Z", "Z"), users: free.map((tm) => ({ id: team.find((t) => t.tm === tm)!.user })) });
    }
    return out;
  }

  async function handle(url: string, init?: RequestInit): Promise<Response | null> {
    if (!url.startsWith(BASE)) return null;
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const q = u.searchParams;
    const seg = path.split("/").filter(Boolean);
    // "POST /orders", "PATCH /addresses/:id", "PUT /appointments/:id/cancel" — ids folded.
    const WORDS = new Set(["addresses", "orders", "appointments", "store", "cancel", "reschedule", "schedule", "availability", "scheduling", "available-timeslots", "available-dates", "products", "company-team-members", "customers"]);
    const key = `${method} /${seg.map((x) => (WORDS.has(x) ? x : ":id")).join("/")}`;
    if (method === "GET") reads.push(`${path}?${q.toString()}`);

    // Scripted failures that happen BEFORE anything commits.
    const scripted = method !== "GET" ? next(key) : null;
    if (scripted === "abort-before-commit") { writes.push({ method, path, body, committed: false }); throw abortError(); }
    if (scripted && typeof scripted === "object") { writes.push({ method, path, body, committed: false }); return json(scripted.status, { status: "error", message: scripted.message ?? `scripted ${scripted.status}` }); }
    const commitThen = (res: Response): Response => {
      writes.push({ method, path, body, committed: true });
      if (scripted === "abort-after-commit") throw abortError();
      return res;
    };

    // ---- catalogue + team + scheduling ----
    const productOut = (id: string, tms: string[]) => ({
      id, title: id, providers: tms.map((tm) => ({ id: tm })),
      variants: opts.variants?.[id] ? [{ object: "PRODUCT_VARIANT", id: opts.variants[id], title: id, price_amount: priceOf(opts.variants[id]), price: priceOf(opts.variants[id]) }] : [],
    });
    if (method === "GET" && path === "/products") {
      return json(200, { data: Object.entries(opts.products).map(([id, tms]) => productOut(id, tms)), meta: { current_page: 1, last_page: 1 } });
    }
    if (method === "GET" && seg[0] === "products" && seg[1] && !seg[2]) {
      const tms = opts.products[seg[1]];
      return tms ? json(200, { status: "success", data: productOut(seg[1], tms) }) : json(404, { status: "error", message: "Product not found." });
    }
    if (method === "GET" && seg[0] === "customers" && seg[1]) {
      const email = seg[1] in (opts.customers ?? {}) ? opts.customers![seg[1]] : opts.defaultCustomerEmail;
      return email === undefined || email === null ? json(404, { status: "error", message: "Customer not found." }) : json(200, { status: "success", data: { object: "CUSTOMER", id: seg[1], email } });
    }
    if (method === "GET" && path === "/company-team-members") {
      return json(200, { data: team.map((t) => ({ id: t.tm, is_service_provider: true, company_user: { id: t.user, full_name: t.name, status: "active" } })), meta: { current_page: 1, last_page: 1 } });
    }
    const userFilter = [...q.entries()].filter(([k]) => k.startsWith("filter[user_ids]")).map(([, v]) => v);
    if (method === "GET" && path === "/scheduling/available-timeslots") {
      const apptId = q.get("filter[appointment_id]");
      if (apptId && (opts.appointmentScope ?? "honour") === "honour") {
        const a = appts.get(apptId);
        if (!a) return json(404, { status: "error", message: "Appointment not found." });
        const dur = a.start_at && a.end_at ? Math.round((Date.parse(a.end_at) - Date.parse(a.start_at)) / 60000) : 60;
        return json(200, { status: "success", data: slotsFor(q.get("date") ?? "", dur, a.tmIds, { excludeApptId: a.id, clearMin: opts.aryeoDriveMinutes ?? 0 }), meta: { duration: dur, company_team_member_ids: a.tmIds } });
      }
      // No appointment filter (or one this fake is told to ignore): the spec
      // makes duration required, and a missing one is refused.
      if (!q.get("duration")) return json(422, { status: "fail", message: "The duration field is required when filter.appointment id is not present." });
      const people = userFilter.length ? userFilter : team.map((t) => t.tm);
      return json(200, { status: "success", data: slotsFor(q.get("date") ?? "", Number(q.get("duration")), people), meta: { duration: Number(q.get("duration")), company_team_member_ids: people } });
    }
    if (method === "GET" && path === "/scheduling/available-dates") {
      const from = new Date(q.get("filter[start_at]") ?? Date.now());
      const days: { date: string; is_available: boolean }[] = [];
      for (let i = 0; i < 21; i++) {
        const d = new Date(from.getTime() + i * 864e5).toISOString().slice(0, 10);
        days.push({ date: d, is_available: slotsFor(d, Number(q.get("duration") ?? 60), userFilter).length > 0 });
      }
      return json(200, { status: "success", data: days });
    }

    // ---- addresses ----
    if (method === "POST" && path === "/addresses") {
      if (typeof body?.latitude !== "number" || typeof body?.longitude !== "number") { writes.push({ method, path, body, committed: false }); return json(422, { status: "fail", message: "latitude and longitude are required" }); }
      const a: Address = { id: uuid(), street_number: body.street_number ?? null, street_name: body.street_name ?? null, unit_number: body.unit_number ?? null, city: body.city ?? null, state_or_province: body.state_or_province ?? null, postal_code: body.postal_code ?? null, country: body.country ?? null, latitude: body.latitude, longitude: body.longitude, unparsed_address: null };
      a.unparsed_address = [[a.street_number, a.street_name].filter(Boolean).join(" "), a.city, [a.state_or_province, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      addresses.set(a.id, a);
      return commitThen(json(201, { status: "success", data: addressOut(a) }));
    }
    if (seg[0] === "addresses" && seg[1]) {
      const a = addresses.get(seg[1]);
      if (!a) return json(404, { status: "error", message: "Address not found." });
      if (method === "GET") return json(200, { status: "success", data: addressOut(a) });
      if (method === "PATCH") {
        for (const k of ["street_number", "street_name", "unit_number", "city", "state_or_province", "postal_code", "latitude", "longitude"] as const) if (body && k in body) (a as Record<string, unknown>)[k] = body[k];
        a.unparsed_address = [[a.street_number, a.street_name].filter(Boolean).join(" "), a.city, [a.state_or_province, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
        return commitThen(json(200, { status: "success", data: addressOut(a) }));
      }
    }

    // ---- orders ----
    if (method === "POST" && path === "/orders") {
      const variant = body?.product_items?.[0]?.variant_id;
      if (!body?.customer_id || !variant) { writes.push({ method, path, body, committed: false }); return json(422, { status: "fail", message: "customer_id and product_items are required" }); }
      const price = priceOf(variant);
      const money = forcedMoney ?? { total: price, balance: price };
      const o: Order = {
        id: uuid(), number: ++orderNo, title: `Order #${orderNo + 0}`, internal_notes: body.internal_notes ?? null,
        customer: { id: body.customer_id, name: "Drill customer" }, addressId: body.address_id ?? null,
        items: [{ id: uuid(), title: "Video Accelerator", variant_id: variant, is_canceled: false, amount: price }], appointmentIds: [], created_at: new Date().toISOString(),
        order_status: "OPEN", fulfillment_status: "UNFULFILLED", payment_status: money.balance > 0 ? "UNPAID" : "PAID", listingId: null,
        total: money.total, balance: money.balance,
      };
      orders.set(o.id, o);
      return commitThen(json(201, { status: "success", data: orderOut(o) }));
    }
    if (method === "GET" && path === "/orders") {
      const list = [...orders.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.number - a.number).map(orderOut);
      return json(200, { data: list, meta: { current_page: 1, last_page: 1 } });
    }
    if (seg[0] === "orders" && seg[1] && method === "GET") {
      const o = orders.get(seg[1]);
      return o ? json(200, { status: "success", data: orderOut(o) }) : json(404, { status: "error", message: "Order not found." });
    }

    // ---- appointments ----
    if (method === "POST" && path === "/appointments/store") {
      const o = orders.get(body?.order_id);
      if (!o) { writes.push({ method, path, body, committed: false }); return json(422, { status: "fail", message: "order_id is invalid" }); }
      let start = body.start_at as string;
      let end = body.end_at as string;
      if (scripted === "shift-start-30") {
        start = new Date(Date.parse(start) + 30 * 60000).toISOString().replace(".000Z", "Z");
        end = new Date(Date.parse(end) + 30 * 60000).toISOString().replace(".000Z", "Z");
      }
      const a: Appt = { id: uuid(), status: "SCHEDULED", start_at: start, end_at: end, orderId: o.id, tmIds: body.company_team_member_ids ?? [], updated_at: new Date().toISOString() };
      appts.set(a.id, a);
      o.appointmentIds.push(a.id);
      if (scripted === "move-order-address" && o.addressId) { const ad = addresses.get(o.addressId); if (ad) ad.street_number = "999"; }
      if (scripted === "add-fee-on-store") { o.total += 7500; o.balance += 7500; o.payment_status = "UNPAID"; }
      return commitThen(json(200, { status: "success", data: apptOut(a) }));
    }
    if (seg[0] === "appointments" && seg[1]) {
      const a = appts.get(seg[1]);
      if (!a) return json(404, { status: "error", message: "Appointment not found." });
      if (method === "GET" && seg[2] === "availability") {
        const tm = q.get("assignee_id") ?? "";
        const clash = [...appts.values()].some((x) => x.id !== a.id && x.status !== "CANCELED" && x.tmIds.includes(tm) && x.start_at && x.end_at && a.start_at && a.end_at && Date.parse(x.start_at) < Date.parse(a.end_at) && Date.parse(x.end_at) > Date.parse(a.start_at));
        return json(200, { has_conflicts: clash });
      }
      if (method === "GET") return json(200, { status: "success", data: apptOut(a) });
      if (method === "PUT" && seg[2] === "cancel") {
        a.status = "CANCELED"; a.updated_at = new Date().toISOString();
        return commitThen(json(200, { status: "success", data: apptOut(a) }));
      }
      if (method === "PUT" && seg[2] === "reschedule") {
        a.start_at = body.start_at; a.end_at = body.end_at; a.updated_at = new Date().toISOString();
        return commitThen(json(200, { status: "success", data: apptOut(a) }));
      }
      if (method === "PUT" && seg[2] === "schedule") {
        a.start_at = body.start_at; a.end_at = body.end_at; a.status = "SCHEDULED"; a.updated_at = new Date().toISOString();
        if (Array.isArray(body.company_team_member_ids)) a.tmIds = body.company_team_member_ids;
        return commitThen(json(200, { status: "success", data: apptOut(a) }));
      }
    }
    if (method === "GET" && path === "/appointments") {
      const gte = q.get("filter[start_at_gte]");
      const lte = q.get("filter[start_at_lte]");
      const withAddress = (q.get("include") ?? "").includes("order.address");
      const list = [...appts.values()]
        .filter((a) => a.status !== "CANCELED" && (!gte || (a.start_at && a.start_at >= gte)) && (!lte || (a.start_at && a.start_at <= lte)))
        .map((a) => {
          const out = apptOut(a);
          const o = orders.get(a.orderId);
          return withAddress && o ? { ...out, order: { id: o.id, address: o.addressId ? addressOut(addresses.get(o.addressId)!) : null } } : out;
        });
      return json(200, { data: list, meta: { current_page: 1, last_page: 1 } });
    }
    // Anything else this fake does not model: an honest 404, never a guess.
    if (method !== "GET") writes.push({ method, path, body, committed: false });
    return json(404, { status: "error", message: `fake Aryeo does not model ${method} ${path}` });
  }

  return {
    handle,
    writes,
    reads,
    addresses,
    orders,
    appts,
    taken,
    script: (key: string, b: Behaviour) => { scripts.set(key, [...(scripts.get(key) ?? []), b]); },
    /** R03: the next orders carry this money (a price the catalogue does not show); null = the catalogue's. */
    setOrderMoney: (m: { total: number; balance: number } | null) => { forcedMoney = m; },
    /** W02: another client's appointment for a creative, at a map point (its own order and address). */
    seedNeighbour: (n: { tm: string; start: Date; end: Date; lat: number | null; lng: number | null; status?: string }) => {
      const addr: Address = { id: uuid(), street_number: "1", street_name: "Neighbour Rd", unit_number: null, city: "Elsewhere", state_or_province: "PA", postal_code: "19000", country: "US", latitude: n.lat, longitude: n.lng, unparsed_address: "1 Neighbour Rd" };
      addresses.set(addr.id, addr);
      const o: Order = {
        id: uuid(), number: ++orderNo, title: `Order #${orderNo}`, internal_notes: null, customer: { id: "neighbour-customer", name: "Another client" }, addressId: addr.id,
        items: [], appointmentIds: [], created_at: new Date().toISOString(), order_status: "OPEN", fulfillment_status: "UNFULFILLED", payment_status: "PAID", listingId: null, total: 0, balance: 0,
      };
      orders.set(o.id, o);
      const a: Appt = { id: uuid(), status: n.status ?? "SCHEDULED", start_at: n.start.toISOString().replace(".000Z", "Z"), end_at: n.end.toISOString().replace(".000Z", "Z"), orderId: o.id, tmIds: [n.tm], updated_at: new Date().toISOString() };
      appts.set(a.id, a);
      o.appointmentIds.push(a.id);
      return { appointmentId: a.id, orderId: o.id, addressId: addr.id };
    },
    /** Committed writes to one endpoint key ("POST /orders", "PATCH /addresses/<id>"…). */
    count: (method: string, pathPrefix: string, committedOnly = false) =>
      writes.filter((w) => w.method === method && w.path.startsWith(pathPrefix) && (!committedOnly || w.committed)).length,
    /** Seed an existing, hand-booked order (CP-05's fixture). */
    seedOrder: (o: { id: string; number: number; customerId: string; address: Omit<Address, "id"> & { id: string }; appointments: { id: string; start_at: string; end_at: string; tmIds: string[]; status?: string }[]; listingId?: string | null }) => {
      addresses.set(o.address.id, { ...o.address });
      orders.set(o.id, {
        id: o.id, number: o.number, title: `Order #${o.number}`, internal_notes: null, customer: { id: o.customerId, name: "Drill customer" }, addressId: o.address.id,
        items: [{ id: uuid(), title: "Video Accelerator", variant_id: "seeded", is_canceled: false, amount: 0 }], appointmentIds: o.appointments.map((a) => a.id),
        created_at: new Date(Date.now() - 864e5).toISOString(), order_status: "OPEN", fulfillment_status: "UNFULFILLED", payment_status: "PAID", listingId: o.listingId ?? null,
        total: 0, balance: 0,
      });
      for (const a of o.appointments) appts.set(a.id, { id: a.id, status: a.status ?? "SCHEDULED", start_at: a.start_at, end_at: a.end_at, orderId: o.id, tmIds: a.tmIds, updated_at: new Date().toISOString() });
    },
  };
}

export type FakeAryeo = ReturnType<typeof createFakeAryeo>;
