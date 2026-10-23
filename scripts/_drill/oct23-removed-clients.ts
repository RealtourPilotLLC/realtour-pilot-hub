// ---------------------------------------------------------------------------
// DRILL: CLIENTS REMOVED ON PURPOSE STAY REMOVED (Oct 23 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct23-removed-clients.ts
//
// Jordan, Oct 23: "Remove the Jordan Spackman Client Records and all the test
// Client Records." scripts/_live/oct23-remove-test-clients.ts deletes them and
// writes AppSetting "clients:removed" (src/lib/removedClients.ts). Each of
// those people still exists in Aryeo, and three doors would mint them back:
// the daily roster sweep, the order sync (the hourly full reconcile walks the
// whole order history), and the Aryeo customer webhook. This proves:
//   1. the record, pure: parse (malformed → empty, never throws), match on an
//      Aryeo customer id / email / order id case-insensitively and EXACTLY
//      (no plus or dot folding: a stranger can never collide), merge unions.
//   2. syncAllAryeoClients: WITHOUT the record the removed customers come back
//      (the door is real); WITH it they are skipped — by id, and by email
//      under a new id — while a stranger is still created; no adoption of a
//      removed customer's id onto another row.
//   3. upsertAryeoCustomerClient (the webhook door): a removed customer is
//      refused (null, nothing written); a stranger is created as before.
//   4. syncAryeoOrders({ orderId }): a removed order id, and an order whose
//      customer was removed, are not imported (no project, no client,
//      ignoredRemoved counted); an existing job whose order now names a
//      removed customer is not re-linked to a new client.
//
// ISOLATION: PGlite on 127.0.0.1:DRILL_PORT (default 5971). Every non-loopback
// call is fenced; the only Aryeo answers are canned GET /customer-users and
// GET /orders/{id}. Nothing is sent.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5971);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

async function main(): Promise<void> {
  installNextStubs();
  let customerUsers: Record<string, unknown>[] = [];
  const orders = new Map<string, Record<string, unknown>>();
  const fence = fenceFetch(async (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return null;
    if (/^https:\/\/api\.aryeo\.com\/v1\/customer-users(?:[?#].*)?$/.test(url)) return json({ data: customerUsers, meta: { current_page: 1, last_page: 1 } });
    const o = /^https:\/\/api\.aryeo\.com\/v1\/orders\/([^/?#]+)/.exec(url);
    if (o) return orders.has(o[1]) ? json({ data: orders.get(o[1]) }) : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return null;
  });
  const drill = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const rc = await import("@/lib/removedClients");
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", "drill-key-not-a-real-one");
  const aryeo = await import("@/lib/integrations/aryeo");

  const REMOVED_CUST = "0192af76-0000-4000-8000-0000000d0e01";
  const REMOVED_EMAIL = "removed.person@drill.invalid";
  const REMOVED_ORDER = "019d87bb-0000-4000-8000-00000000rem1";
  const record = rc.mergeRemovedClients(null, [{ clientId: "cm-drill-removed", name: "John Doe", aryeoCustomerIds: [REMOVED_CUST], emails: [REMOVED_EMAIL], aryeoOrderIds: [REMOVED_ORDER], removedAt: "2026-10-23T16:00:00.000Z", note: "drill" }]);
  const writeRecord = () => prisma.appSetting.upsert({ where: { key: rc.REMOVED_CLIENTS_KEY }, create: { key: rc.REMOVED_CLIENTS_KEY, value: record }, update: { value: record } });

  try {
    // ======================================================================
    c.head("1 · the record, pure");
    {
      const r = rc.parseRemovedClients(record);
      c.ok("one entry parsed", r.entries.length === 1);
      c.ok("matches the Aryeo customer id, any case", !!rc.removedMatch(r, { customerIds: [REMOVED_CUST.toUpperCase()] }));
      c.ok("matches the email, any case and spacing", !!rc.removedMatch(r, { email: `  ${REMOVED_EMAIL.toUpperCase()} ` }));
      c.ok("matches the order id", rc.removedMatch(r, { orderId: REMOVED_ORDER })?.on === `order ${REMOVED_ORDER}`);
      c.ok("an alternate id in the list is enough", !!rc.removedMatch(r, { customerIds: [null, "other", REMOVED_CUST] }));
      c.ok("a plus-address of the email is NOT the email (no folding)", !rc.removedMatch(r, { email: "removed.person+x@drill.invalid" }));
      c.ok("a dot-variant is NOT the email (no folding)", !rc.removedMatch(r, { email: "removedperson@drill.invalid" }));
      c.ok("a stranger matches nothing", !rc.removedMatch(r, { customerIds: ["0197-stranger"], email: "stranger@drill.invalid", orderId: "0197-order" }));
      c.ok("malformed JSON reads as empty, never throws", rc.parseRemovedClients("{not json").entries.length === 0 && rc.parseRemovedClients(null).entries.length === 0);
      c.ok("a malformed entry is skipped, the good one kept", rc.parseRemovedClients(JSON.stringify({ entries: [null, 7, { name: "no id" }, JSON.parse(record).entries[0]] })).entries.length === 1);
      const merged = rc.parseRemovedClients(rc.mergeRemovedClients(record, [{ clientId: "cm-drill-removed", name: "John Doe", aryeoCustomerIds: [], emails: ["second@drill.invalid"], aryeoOrderIds: [REMOVED_ORDER], removedAt: "2026-10-24T00:00:00.000Z" }]));
      c.ok("merge: one entry per client, lists unioned, first removedAt kept", merged.entries.length === 1 && merged.emails.size === 2 && merged.orderIds.size === 1 && merged.entries[0].removedAt.startsWith("2026-10-23"));
      c.ok("loadRemovedClients reads nothing as empty", (await rc.loadRemovedClients(prisma)).entries.length === 0);
      c.ok("loadRemovedClients on a client that throws reads as empty (the syncs run as before)", (await rc.loadRemovedClients({ appSetting: { findUnique: async () => { throw new Error("boom"); } } })).entries.length === 0);
    }

    // ======================================================================
    c.head("2 · the daily roster sweep (syncAllAryeoClients)");
    {
      customerUsers = [
        { id: REMOVED_CUST, full_name: "John Doe", email: "johndoe.cu@drill.invalid" },
        { id: "0192e426-0000-4000-8000-0000000d0e02", full_name: "John Doe Two", email: REMOVED_EMAIL },
        { id: "0197aaaa-0000-4000-8000-00000stranger", full_name: "Sam Stranger", email: "sam@stranger.invalid" },
      ];
      const before = await aryeo.syncAllAryeoClients();
      const rows = await prisma.client.findMany({ select: { id: true, aryeoCustomerId: true, email: true } });
      c.ok("WITHOUT the record the door is real: all three are created", before.created === 3 && rows.length === 3, JSON.stringify(before));
      await prisma.client.deleteMany({});
      await writeRecord();
      const after = await aryeo.syncAllAryeoClients();
      const rows2 = await prisma.client.findMany({ select: { name: true, aryeoCustomerId: true, email: true } });
      c.ok("WITH the record: only the stranger is created", after.created === 1 && rows2.length === 1 && rows2[0].email === "sam@stranger.invalid", JSON.stringify(after));
      c.ok("…and the two removed customers are counted as skipped", after.skippedRemoved === 2);
      c.ok("a second run creates nothing more", (await aryeo.syncAllAryeoClients()).created === 0 && (await prisma.client.count()) === 1);
      // A row the removed customer could have been ADOPTED onto (same name+company) is left untouched.
      const lookalike = await prisma.client.create({ data: { name: "John Doe", company: "Drill Realty", email: "jd.other@drill.invalid" } });
      customerUsers = [{ id: REMOVED_CUST, full_name: "John Doe", email: "johndoe.cu@drill.invalid", agent_company_name: "Drill Realty" }];
      await aryeo.syncAllAryeoClients();
      const l2 = await prisma.client.findUnique({ where: { id: lookalike.id } });
      c.ok("a removed customer's id is never adopted onto another row", l2?.aryeoCustomerId === null && l2?.backupEmail === null);
    }

    // ======================================================================
    c.head("3 · the customer webhook (upsertAryeoCustomerClient)");
    {
      const n0 = await prisma.client.count();
      const r1 = await aryeo.upsertAryeoCustomerClient({ id: "group-x", name: "John Doe", email: "x@drill.invalid" }, { via: "drill", altIds: [REMOVED_CUST] });
      c.ok("a removed customer (by its nested user id) is refused: null, nothing written", r1 === null && (await prisma.client.count()) === n0);
      const r2 = await aryeo.upsertAryeoCustomerClient({ id: "group-y", name: "John Doe", email: REMOVED_EMAIL.toUpperCase() }, { via: "drill" });
      c.ok("a removed customer by email is refused", r2 === null && (await prisma.client.count()) === n0);
      const r3 = await aryeo.upsertAryeoCustomerClient({ id: "0197bbbb-0000-4000-8000-0000stranger2", name: "Pat Newcomer", email: "pat@stranger.invalid" }, { via: "drill" });
      c.ok("a stranger is created exactly as before", !!r3?.created && (await prisma.client.count()) === n0 + 1);
    }

    // ======================================================================
    c.head("4 · the order sync (syncAryeoOrders, the reconcile's per-order body)");
    {
      const order = (id: string, cust: Record<string, unknown>) => ({ id, number: 9001, order_status: "OPEN", payment_status: "UNPAID", total_amount: 25000, balance_amount: 25000, created_at: "2026-10-20T15:00:00Z", customer: cust, address: { street_number: "1", street_name: "Drill Ln", city: "Testville", state_or_province: "PA", postal_code: "19000" }, items: [], appointments: [] });
      orders.set(REMOVED_ORDER, order(REMOVED_ORDER, { id: "0197cccc-0000-4000-8000-0000000c0de1", name: "Someone Else", email: "someone@drill.invalid" }));
      const n0 = await prisma.client.count();
      const r1 = await aryeo.syncAryeoOrders({ orderId: REMOVED_ORDER });
      c.ok("a removed ORDER is not imported: no project, no client", r1.imported === 0 && r1.ignoredRemoved === 1 && (await prisma.project.count()) === 0 && (await prisma.client.count()) === n0, JSON.stringify(r1));
      const O2 = "0197dddd-0000-4000-8000-000000order2";
      orders.set(O2, order(O2, { id: REMOVED_CUST, name: "John Doe", email: "johndoe.cu@drill.invalid" }));
      const r2 = await aryeo.syncAryeoOrders({ orderId: O2 });
      c.ok("an order whose CUSTOMER was removed is not imported", r2.imported === 0 && r2.ignoredRemoved === 1 && (await prisma.project.count()) === 0 && (await prisma.client.count()) === n0, JSON.stringify(r2));
      // An existing job (a real client's) whose order is now reassigned to the removed customer in Aryeo.
      const real = await prisma.client.create({ data: { name: "Real Agent", email: "real@drill.invalid", aryeoCustomerId: "0197eeee-0000-4000-8000-0000000real1" } });
      const O3 = "0197eeee-0000-4000-8000-000000order3";
      const job = await prisma.project.create({ data: { title: "1 Drill Ln, Testville, PA 19000", clientId: real.id, source: "ARYEO", aryeoOrderId: O3, status: "BOOKED", price: 250, paymentStatus: "UNPAID", balanceAmount: 25000 } });
      orders.set(O3, order(O3, { id: REMOVED_CUST, name: "John Doe", email: "johndoe.cu@drill.invalid" }));
      const n1 = await prisma.client.count();
      await aryeo.syncAryeoOrders({ orderId: O3 }).catch((e) => { c.ok("the update pass ran", false, String(e).slice(0, 160)); });
      const after = await prisma.project.findUnique({ where: { id: job.id }, select: { clientId: true } });
      c.ok("an existing job is not re-linked to a removed customer, and no client is minted for it", after?.clientId === real.id && (await prisma.client.count()) === n1);
      // …and the door is real: without the record the same order IS imported and its removed customer minted back.
      await prisma.appSetting.delete({ where: { key: rc.REMOVED_CLIENTS_KEY } });
      const r4 = await aryeo.syncAryeoOrders({ orderId: O2 }).catch((e) => ({ error: String(e).slice(0, 160) }) as const);
      const back = await prisma.client.findFirst({ where: { aryeoCustomerId: REMOVED_CUST }, select: { id: true } });
      c.ok("WITHOUT the record that order is imported and the removed customer comes back", "imported" in r4 && r4.imported === 1 && !!back && (await prisma.project.count({ where: { aryeoOrderId: O2 } })) === 1, JSON.stringify(r4));
    }

    c.ok("fence: nothing left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    c.summary();
    quiet.restore();
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
