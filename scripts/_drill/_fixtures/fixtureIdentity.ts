// ---------------------------------------------------------------------------
// FIXTURE IDENTITY for drills (R02 / A26, Sep 25 2026).
//
// Since R02 the Aryeo write guard (integrations/aryeo.ts hubWritePermit) asks
// three things of a TEST fixture before it issues a FIXTURE permit: it is on
// the switch's authorizedFixtureClientIds, its own email is Jordan's verified
// test inbox, and its linked Aryeo customer's email is too (read with GET
// /customers/{id}). A drill fixture built by buildContentMonth has none of the
// last two, so a drill that authorises one needs two lines:
//
//   const ids = createFixtureCustomers();
//   const fence = fenceFetch((url, init) => ids.route(url, init) ?? fake.handle(url, init));
//   ...
//   await ids.makeFixture(prisma, f.clientId);            // before authorising it
//
// `route` answers GET https://api.aryeo.com/v1/customers/<id> for the customers
// registered here, and only those (anything else falls through to the fake,
// which answers an honest 404). Nothing here touches a real provider.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

const CUSTOMER_URL = /^https:\/\/api\.aryeo\.com\/v1\/customers\/([^/?#]+)(?:[?#].*)?$/;

export function createFixtureCustomers() {
  const customers = new Map<string, { email: string | null; name: string }>();
  const reads: string[] = [];
  let failNext = 0;
  return {
    customers,
    /** Every customer id the guard read, in order. */
    reads,
    /** The next n customer reads answer 500 (a provider outage). */
    failReads(n = 1) { failNext = n; },
    /** Register (or re-point) an Aryeo customer's email. */
    setCustomer(id: string, email: string | null, name = "Drill customer") { customers.set(id, { email, name }); },
    /** The fence handler: a canned GET /customers/<id>, or null to fall through. */
    route(url: string, init?: RequestInit): Response | null {
      const m = CUSTOMER_URL.exec(url);
      if (!m || (init?.method ?? "GET").toUpperCase() !== "GET") return null;
      const id = decodeURIComponent(m[1]);
      if (!customers.has(id)) return null;
      reads.push(id);
      if (failNext > 0) { failNext--; return new Response(JSON.stringify({ status: "error", message: "scripted 500" }), { status: 500 }); }
      const c = customers.get(id)!;
      return new Response(JSON.stringify({ status: "success", data: { object: "CUSTOMER", id, name: c.name, email: c.email } }), { status: 200, headers: { "content-type": "application/json" } });
    },
    /**
     * Make a TEST client a provable fixture: its email on the test inbox
     * (plus-addressed so it stays unique) and a linked Aryeo customer whose
     * email is the test inbox too. Returns the customer id.
     */
    async makeFixture(prisma: PrismaClient, clientId: string, opts: { customerEmail?: string | null; clientEmail?: string | null } = {}): Promise<string> {
      const tag = randomBytes(3).toString("hex");
      const row = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { aryeoCustomerId: true } });
      const customerId = row.aryeoCustomerId ?? `0197dddd-0000-4000-8000-${randomBytes(6).toString("hex")}`;
      await prisma.client.update({
        where: { id: clientId },
        data: { email: opts.clientEmail === undefined ? `info+fixture-${tag}@realtourpilot.com` : opts.clientEmail, aryeoCustomerId: customerId },
      });
      customers.set(customerId, { email: opts.customerEmail === undefined ? "info@realtourpilot.com" : opts.customerEmail, name: "Fixture customer" });
      return customerId;
    },
  };
}

export type FixtureCustomers = ReturnType<typeof createFixtureCustomers>;
