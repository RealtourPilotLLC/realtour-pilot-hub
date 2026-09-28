// ---------------------------------------------------------------------------
// DRILL: MONEY AND IDENTITY EXCEPTIONS (§10 AU-25 / I2 / I3, unified handoff
// batch 5, Sep 26 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/money-exceptions.ts
//
//   0. OLD (17df024): checkSubscription read a lapsed plan from Stripe, rang
//      the bell once and KEPT NOTHING — the status was gone after the bell.
//   1. NEW: the status and when it was read are kept on the signup.
//   2. One seeded case per kind → exactly one row per kind, each with an
//      owner, evidence and a next action; the negative controls stay off.
//   3. The duplicate on two Aryeo customers says the credits are not moved.
//   4. Owner only: ADMIN, no session, and the owner previewing as ADMIN all
//      get nothing.
//   5. Reading the list calls no provider and changes no row.
//
// ISOLATION. PGlite on 127.0.0.1:5793 (DRILL_PORT overrides). Stripe's
// /v1/subscriptions/<id> is answered by the fence faker (GET only is allowed
// to be answered at all); everything else is blocked.
// THE CLOCK: Saturday Sep 26 2026 19:30 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5793);
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");

const RealDate = Date;
const SIM = RealDate.parse("2026-09-26T19:30:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;

installNextStubs();

const SUB_STATUS: Record<string, string> = { sub_old: "past_due", sub_1: "past_due", sub_2: "active" };
const methods: string[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  const u = new URL(url);
  if (u.hostname !== "api.stripe.com") return null;
  methods.push((init?.method ?? "GET").toUpperCase());
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return null; // a write is never answered — it is blocked and counted
  const m = /^\/v1\/subscriptions\/([^/]+)$/.exec(u.pathname);
  if (m && SUB_STATUS[m[1]]) return json({ id: m[1], status: SUB_STATUS[m[1]], billing_cycle_anchor: 1_790_000_000 });
  return null;
});

function writeBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-exc-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `${BASE}:src/lib/stripeSignups.ts`], { cwd: REPO, encoding: "utf8" });
  const file = path.join(dir, "stripeSignups.base.ts");
  fs.writeFileSync(file, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return file;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Walk a server component's element tree to text, running nested server
 *  components; a client component (hooks) renders as nothing here. */
async function renderText(node: any): Promise<string> {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (await Promise.all(node.map(renderText))).join("");
  if (typeof node === "object" && typeof node.then === "function") return renderText(await node);
  if (typeof node === "object" && node.type) {
    if (typeof node.type === "function") {
      try { return await renderText(await node.type(node.props)); } catch { return ""; }
    }
    return renderText(node.props?.children);
  }
  return "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
/** lucide-react and next/link create React contexts at load, which the
 *  react-server build of React cannot do; for a text walk an icon is nothing
 *  and a link is its children. Installed just before a component is imported. */
function stubUiModules() {
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  const Icon = () => null;
  const lucide = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : Icon) });
  const link = { __esModule: true, default: ({ children }: { children?: unknown }) => children };
  L._load = function (r: string, p: unknown, m: boolean) {
    if (r === "lucide-react") return lucide;
    if (r === "next/link") return link;
    return prev.call(this, r, p, m);
  };
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { checkSubscription } = await import("@/lib/stripeSignups");
  const { moneyExceptions } = await import("@/lib/moneyExceptions");
  const { DEDUPE_CANDIDATES_KEY } = await import("@/lib/clientDedupe");
  // A restricted-key-shaped value, assembled at run time (push protection flags
  // even fake literals of the real shape).
  await saveSecret("stripe", ["rk", "test", "drill0000000000000000"].join("_"));

  let n = 0;
  const enrolled = async (name: string, status: string) => {
    const client = await prisma.client.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@drill.invalid` } });
    const e = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, status } });
    return { client, e };
  };
  const signup = (data: Record<string, unknown>) =>
    prisma.programSignup.create({ data: { checkoutId: `cs_drill_${++n}`, productId: "prod_x", productName: "Video Accelerator", amount: 999, recurring: true, paidAt: new Date("2026-09-01T12:00:00Z"), ...data } as never });

  // =========================================================================
  c.head("0 · OLD (17df024): the lapse was rung once and forgotten");
  {
    const { client, e } = await enrolled("Olga Old TEST", "ACTIVE");
    await signup({ subscriptionId: "sub_old", enrollmentId: e.id, clientId: client.id });
    const old = (await import(writeBase())) as { checkSubscription: (id: string) => Promise<{ status: string } | null> };
    const r = await old.checkSubscription("sub_old");
    const row = await prisma.programSignup.findFirst({ where: { subscriptionId: "sub_old" } });
    c.ok("OLD read 'past_due' from Stripe", r?.status === "past_due");
    c.ok("OLD kept no status on the signup", row?.subscriptionStatus === null && row?.subscriptionCheckedAt === null);
    await prisma.programSignup.deleteMany({ where: { subscriptionId: "sub_old" } });
    await prisma.contentEnrollment.delete({ where: { id: e.id } });
  }

  // =========================================================================
  c.head("1 · NEW: the status it read is kept");
  const one = await enrolled("Lapsed Lana TEST", "ACTIVE");
  await signup({ subscriptionId: "sub_1", enrollmentId: one.e.id, clientId: one.client.id });
  const two = await enrolled("Ended Eddie TEST", "ENDED");
  await signup({ subscriptionId: "sub_2", enrollmentId: two.e.id, clientId: two.client.id });
  {
    await checkSubscription("sub_1");
    await checkSubscription("sub_2");
    const r1 = await prisma.programSignup.findFirst({ where: { subscriptionId: "sub_1" } });
    const r2 = await prisma.programSignup.findFirst({ where: { subscriptionId: "sub_2" } });
    c.ok("past_due kept, with when it was read", r1?.subscriptionStatus === "past_due" && r1.subscriptionCheckedAt?.getTime() === SIM);
    c.ok("active kept on the ended enrollment's signup", r2?.subscriptionStatus === "active");
    c.ok("Stripe was only ever asked with GET", methods.length === 3 && methods.every((m) => m === "GET"), methods.join(","));
  }

  // ---- the other four kinds, and a negative control each --------------------
  // 3. parked
  await signup({ status: "NEEDS_REVIEW", note: "Two enrollments match this email", recurring: false, email: "parked@drill.invalid", name: "Parker Parked" });
  // 4. a program session's Aryeo order shows money owed while Stripe-paid
  const four = await enrolled("Balance Betty TEST", "ACTIVE");
  await signup({ subscriptionId: "sub_4", subscriptionStatus: "active", enrollmentId: four.e.id, clientId: four.client.id });
  const owed = await prisma.project.create({ data: { title: "44 Owed Way, Emmaus, PA", clientId: four.client.id, status: "SCHEDULED", balanceAmount: 45000, paymentStatus: "UNPAID", aryeoOrderId: "ord-44" } });
  const paid = await prisma.project.create({ data: { title: "45 Paid Path, Emmaus, PA", clientId: four.client.id, status: "SCHEDULED", balanceAmount: 0, paymentStatus: "PAID", aryeoOrderId: "ord-45" } });
  await prisma.programSessionRequest.create({ data: { enrollmentId: four.e.id, clientId: four.client.id, monthId: "m-1", status: "CONFIRMED", projectId: owed.id, aryeoOrderId: "ord-44" } });
  await prisma.programSessionRequest.create({ data: { enrollmentId: four.e.id, clientId: four.client.id, monthId: "m-1", status: "CONFIRMED", projectId: paid.id, aryeoOrderId: "ord-45" } });
  await prisma.programSessionRequest.create({ data: { enrollmentId: four.e.id, clientId: four.client.id, monthId: "m-1", status: "CANCELLED", projectId: owed.id } });
  // 5. duplicate candidates: two Aryeo ids (listed), one (not), two but decided (not)
  const cand = (key: string, ids: (string | null)[]) => ({
    key,
    clients: ids.map((a, i) => ({ id: `${key}-${i}`, name: `${key} Person ${i}`, email: null, company: null, phone10: "6105550100", aryeoCustomerId: a, projects: 1 })),
    matchedOn: ["phone 6105550100"],
    blockers: [],
  });
  await prisma.appSetting.create({
    data: {
      key: DEDUPE_CANDIDATES_KEY,
      value: JSON.stringify({ at: "2026-09-26T08:20:00Z", candidates: [cand("split", ["ary-1", "ary-2"]), cand("single", ["ary-3", null]), cand("decided", ["ary-4", "ary-5"])] }),
    },
  });
  await prisma.smartTask.create({ data: { taskType: "todo", title: "Possible duplicate clients — decided", status: "COMPLETED", dedupeKey: "client-dupe-decided" } });
  // 6. an alias that is another client's own address (and one that is its own)
  const ann = await prisma.client.create({ data: { name: "Alias Ann TEST", email: "ann@drill.invalid" } });
  await prisma.client.create({ data: { name: "Other Bob TEST", email: "bob@drill.invalid" } });
  await prisma.clientEmailAlias.create({ data: { clientId: ann.id, email: "bob@drill.invalid" } });
  await prisma.clientEmailAlias.create({ data: { clientId: ann.id, email: "ann@drill.invalid" } });

  // =========================================================================
  c.head("2 · one row per kind, each owned and evidenced");
  const owner = { role: "OWNER", realRole: "OWNER" };
  const beforeFaked = fence.faked.length;
  const snapshot = async () => JSON.stringify(await Promise.all([
    prisma.contentEnrollment.findMany({ select: { id: true, status: true }, orderBy: { id: "asc" } }),
    prisma.programSignup.findMany({ select: { id: true, status: true, subscriptionStatus: true }, orderBy: { id: "asc" } }),
    prisma.client.count(),
    prisma.clientEmailAlias.findMany({ select: { id: true, active: true }, orderBy: { id: "asc" } }),
    prisma.smartTask.count(),
  ]));
  const before = await snapshot();
  const rows = await moneyExceptions(owner);
  const byKind = (k: string) => rows.filter((r) => r.kind === k);
  for (const k of ["subscription-lapsed-active-enrollment", "enrollment-ended-subscription-active", "signup-parked", "program-order-balance", "duplicate-with-split-aryeo", "alias-conflict"]) {
    c.ok(`exactly one '${k}'`, byKind(k).length === 1, byKind(k).map((r) => r.title).join(" | "));
  }
  c.ok("six rows, no more", rows.length === 6, String(rows.length));
  c.ok("every row: owner Jordan, evidence, a next action, a link", rows.every((r) => r.owner === "Jordan" && r.evidence.length > 0 && r.nextAction.length > 10 && r.href.startsWith("/")));
  c.ok("the lapsed plan names the enrollment and the Stripe status", byKind("subscription-lapsed-active-enrollment")[0]?.title === "Lapsed Lana TEST" && /past due/.test(byKind("subscription-lapsed-active-enrollment")[0]?.why ?? ""));
  c.ok("the owed order is 44 Owed Way at $450.00, not the paid one", /44 Owed Way/.test(byKind("program-order-balance")[0]?.title ?? "") && /\$450\.00/.test(byKind("program-order-balance")[0]?.why ?? ""));
  c.ok("the alias row is Ann's alias that is Bob's email", byKind("alias-conflict")[0]?.title === "bob@drill.invalid" && /Other Bob/.test(byKind("alias-conflict")[0]?.why ?? ""));
  c.ok("no row tells anyone to charge, refund or merge automatically", rows.every((r) => !/\b(auto(matically)? (charge|refund|merge)|will be (charged|refunded|merged))\b/i.test(`${r.why} ${r.nextAction}`)));

  // =========================================================================
  c.head("3 · a split duplicate says the credits stay where they are");
  {
    const d = byKind("duplicate-with-split-aryeo")[0];
    c.ok("the split pair is the one listed (single and decided are not)", /^split Person/.test(d?.title ?? ""));
    c.ok("its evidence says a hub merge does not move Aryeo credits", d?.evidence.some((e) => /credits/i.test(e) && /does not move/i.test(e)) === true, d?.evidence.join(" / "));
  }

  // =========================================================================
  c.head("4 · owner only");
  c.ok("ADMIN gets nothing", (await moneyExceptions({ role: "ADMIN", realRole: "ADMIN" })).length === 0);
  c.ok("no session gets nothing", (await moneyExceptions(null)).length === 0);
  c.ok("the owner previewing as ADMIN gets nothing", (await moneyExceptions({ role: "ADMIN", realRole: "OWNER" })).length === 0);

  // =========================================================================
  c.head("4b · the Finance card renders the rows (auth off = owner view)");
  {
    stubUiModules();
    const { MoneyExceptionsCard } = await import("@/components/finance/MoneyExceptionsCard");
    const text = await renderText(await MoneyExceptionsCard());
    c.ok("card lists the rows with their next actions", /Money & identity checks/.test(text) && /Lapsed Lana TEST/.test(text) && /Next:/.test(text), text.slice(0, 160));
  }

  // =========================================================================
  c.head("5 · reading it touches nothing");
  c.ok("no provider was asked while building the list", fence.faked.length === beforeFaked);
  c.ok("no enrollment, signup, client, alias or task changed", (await snapshot()) === before);
  c.ok("zero blocked outbound calls", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  c.summary();
  await stop();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
