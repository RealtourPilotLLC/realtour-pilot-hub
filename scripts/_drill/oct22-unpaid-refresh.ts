// ---------------------------------------------------------------------------
// DRILL: REFRESH THE UNPAID LIST FROM ARYEO (Oct 22 2026). Jordan: "would love
// to be able to refresh the unpaid section so that I can update the invoices in
// Aryeo and see the updates in the hub."
//   · a photographer, an editor and the creative manager are refused; the owner
//     and the office may press it;
//   · an empty list says so and calls nobody;
//   · every job on the list is re-read through the single-order refresh (Aryeo
//     faked at the fence); a job Aryeo now shows paid leaves the list and the
//     answer counts it, without amounts; a job whose read fails is counted and
//     the answer says to press again;
//   · the button sits on the Unpaid tab.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

type Me = { id: string; email: string; name: string | null; role: string; permissions: null; status: string; teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: null; impersonating: boolean; realRole: string; realName: string | null } | null;
let me: Me = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();
const user = (role: string): NonNullable<Me> => ({ id: `u-${role}`, email: `${role.toLowerCase()}@x.test`, name: role, role, permissions: null, status: "ACTIVE", teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: role });

// Aryeo, faked at the fence: order A is now paid, order B still owes, order C fails.
const aryeoCalls: string[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const order = (id: string, balance: number, status: string) => ({ data: { id, status: "FULFILLED", fulfillment_status: "FULFILLED", payment_status: status, balance_amount: balance, total_amount: 30000, items: [], appointments: [], listing: null, customer: null, fulfilled_at: "2026-10-01T15:00:00Z", created_at: "2026-09-28T15:00:00Z" } });
const fence = fenceFetch(async (url) => {
  if (!url.startsWith("https://api.aryeo.com/")) return null;
  aryeoCalls.push(url);
  if (url.includes("/orders/ORD-A")) return json(order("ORD-A", 0, "PAID"));
  if (url.includes("/orders/ORD-B")) return json(order("ORD-B", 30000, "UNPAID"));
  if (url.includes("/orders/ORD-C")) return json({ message: "server error" }, 500);
  return json({ data: [] });
});
const REPO = path.resolve(__dirname, "../..");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6533), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct22-unpaid-refresh" } }); // the guard refuses only when sign-in is enforced, as in production
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    const billing = await import("@/app/billing/actions");

    c.head("1 · who may press it");
    for (const role of ["PHOTOGRAPHER", "EDITOR", "CREATIVE_MANAGER"]) {
      me = user(role);
      const r = await billing.refreshUnpaidFromAryeo();
      c.ok(`${role.toLowerCase()} is refused`, !r.ok && aryeoCalls.length === 0, r.message);
    }
    me = user("OWNER");
    const empty = await billing.refreshUnpaidFromAryeo();
    c.ok("an empty list says so and calls nobody", empty.ok && /Nothing on the unpaid list/.test(empty.message) && aryeoCalls.length === 0, empty.message);

    c.head("2 · it re-reads every job on the list");
    const client = await prisma.client.create({ data: { name: "Unpaid Drill" } });
    const mk = (title: string, orderId: string) => prisma.project.create({ data: { title, clientId: client.id, status: "DELIVERED", deliveredAt: new Date("2026-10-01T15:00:00Z"), aryeoOrderId: orderId, balanceAmount: 30000, paymentStatus: "UNPAID", price: 300 } });
    const a = await mk("1 Paid Ln, Malvern, PA", "ORD-A");
    const b = await mk("2 Owes Ct, Malvern, PA", "ORD-B");
    await mk("3 Broken Rd, Malvern, PA", "ORD-C");
    await prisma.project.create({ data: { title: "4 Removed St", clientId: client.id, status: "DELIVERED", aryeoOrderId: "ORD-D", balanceAmount: 30000, arRemovedAt: new Date() } });
    me = user("ADMIN");
    const r = await billing.refreshUnpaidFromAryeo();
    c.ok("the office may press it", r.message.startsWith("Checked"), r.message);
    c.ok("every listed job was read (a removed one is not)", ["ORD-A", "ORD-B", "ORD-C"].every((id) => aryeoCalls.some((u) => u.includes(`/orders/${id}`))) && !aryeoCalls.some((u) => u.includes("ORD-D")), aryeoCalls.join(" "));
    const pa = await prisma.project.findUniqueOrThrow({ where: { id: a.id } });
    const pb = await prisma.project.findUniqueOrThrow({ where: { id: b.id } });
    c.ok("the paid job's balance comes over from Aryeo", (pa.balanceAmount ?? 0) === 0, String(pa.balanceAmount));
    c.ok("the still-owing job keeps its balance", pb.balanceAmount === 30000);
    c.ok("the answer counts the paid one, says to press again for the failure, and names no amount", /1 now paid/.test(r.message) && /could not be read; press again/.test(r.message) && !/\$/.test(r.message) && !r.ok, r.message);

    c.head("3 · the button");
    const tab = fs.readFileSync(path.join(REPO, "src/components/finance/UnpaidTab.tsx"), "utf8");
    c.ok("the Unpaid tab shows Refresh from Aryeo", tab.includes("<RefreshUnpaid />") && fs.readFileSync(path.join(REPO, "src/components/billing/RefreshUnpaid.tsx"), "utf8").includes("Refresh from Aryeo"));

    c.head("isolation");
    c.ok("only the faked Aryeo was called", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
