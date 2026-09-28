// ---------------------------------------------------------------------------
// DRILL: NOTHING AUTOMATIC MOVES MONEY OR MERGES PEOPLE (§10 A54, unified
// handoff batch 5, Sep 26 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/merge-guard.ts
//
//   0. OLD (17df024): mergeClientsById merged two clients who were two Aryeo
//      customers and kept ONE Aryeo link — the other customer's orders,
//      invoices and any credit lost their client — and left no record.
//   1. NEW merge: two Aryeo customers → refused, nothing changed; a blocker
//      with no written reason → refused; no named approver → refused; a clean
//      pair → merged, with an AuditLog carrying every moved id per table and
//      the deleted row, written in the same transaction.
//   2. STATIC: no cron route, webhook route or sweep reaches mergeClientsById;
//      nothing writes to Stripe; no Aryeo write path touches refunds, credits,
//      payments, charges or invoices; nothing calls AutoHDR; no Plaid transfer
//      or payment call; QuickBooks POSTs only for its OAuth token.
//   3. BEHAVIOUR: every automated path batch 5 added (photo register sweep,
//      balance check, waiver derivation, AutoHDR mail, money exceptions) plus
//      the nightly duplicate review runs — no client deleted, no merge, no
//      provider call.
//
// ISOLATION. PGlite on 127.0.0.1:5794 (DRILL_PORT overrides). Dropbox listing
// answers empty at the module boundary; every outbound call is blocked.
// THE CLOCK: Monday Sep 28 2026 04:00 ET (the daily cron's hour).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5794);
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");
const SRC = path.join(REPO, "src");

const RealDate = Date;
const SIM = RealDate.parse("2026-09-28T04:00:00-04:00");
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
const fence = fenceFetch();
const isMod = (r: string, tail: string) => r === `@/lib/${tail}` || r.endsWith(`/src/lib/${tail}`) || r.endsWith(`/src/lib/${tail}.ts`);
const wrapped = new WeakMap<object, unknown>();
interceptModule(
  (r) => isMod(r, "integrations/dropbox"),
  (loaded) => {
    const m = loaded as Record<string | symbol, unknown>;
    if (!wrapped.has(m)) wrapped.set(m, new Proxy(m, { get: (t, k) => (k === "dropboxListFolder" ? async () => [] : t[k]) }));
    return wrapped.get(m);
  },
);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(REPO, p);

function writeBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-guard-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `${BASE}:src/lib/clientDedupe.ts`], { cwd: REPO, encoding: "utf8" });
  const file = path.join(dir, "clientDedupe.base.ts");
  fs.writeFileSync(file, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(SRC, p)}${q}`));
  return file;
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { mergeClientsById } = await import("@/lib/clientDedupe");

  const person = async (name: string, extra: Record<string, unknown> = {}, orders = 0) => {
    const cl = await prisma.client.create({ data: { name, phone: "6105550100", ...extra } as never });
    for (let i = 0; i < orders; i++) await prisma.project.create({ data: { title: `${i + 1} ${name.split(" ")[0]} St`, clientId: cl.id, status: "DELIVERED" } });
    await prisma.commLog.create({ data: { channel: "text", body: `hello from ${name}`, occurredAt: new Date(), source: "drill", clientId: cl.id } });
    return cl;
  };

  // =========================================================================
  c.head("0 · OLD (17df024): two Aryeo customers merged, one link dropped, no record");
  {
    const a = await person("Old Anna TEST", { aryeoCustomerId: "ary-old-a" }, 2);
    const b = await person("Old Anna Two TEST", { aryeoCustomerId: "ary-old-b" }, 1);
    const old = (await import(writeBase())) as { mergeClientsById: (ids: string[]) => Promise<{ ok: boolean; survivor?: string }> };
    const r = await old.mergeClientsById([a.id, b.id]);
    const left = await prisma.client.findMany({ where: { id: { in: [a.id, b.id] } }, select: { aryeoCustomerId: true } });
    c.ok("OLD merged them", r.ok && left.length === 1);
    c.ok("OLD kept one Aryeo link and dropped the other", left[0]?.aryeoCustomerId === "ary-old-a" && (await prisma.client.count({ where: { aryeoCustomerId: "ary-old-b" } })) === 0);
    c.ok("OLD wrote no audit record", (await prisma.auditLog.count()) === 0);
  }

  // =========================================================================
  c.head("1 · NEW: refused when it can't be undone honestly, recorded when it runs");
  {
    const a = await person("Split Sam TEST", { aryeoCustomerId: "ary-1" }, 1);
    const b = await person("Split Sam Two TEST", { aryeoCustomerId: "ary-2" });
    const before = await prisma.client.count();
    const r = await mergeClientsById([a.id, b.id], { actor: "info@drill.invalid", overrideBlockers: "I checked, same person" });
    c.ok("two Aryeo customers → refused, even with a written reason", !r.ok && /2 separate customers/.test(r.message ?? ""), r.message);
    c.ok("…nothing changed", (await prisma.client.count()) === before && (await prisma.client.count({ where: { aryeoCustomerId: { in: ["ary-1", "ary-2"] } } })) === 2);

    const x = await person("Co Cara TEST", { company: "Alpha Realty" }, 1);
    const y = await person("Co Cara Two TEST", { company: "Beta Homes" });
    const r2 = await mergeClientsById([x.id, y.id], { actor: "info@drill.invalid" });
    c.ok("different companies, no reason → refused, blocker named", !r2.ok && /different companies/.test(r2.message ?? ""), r2.message);
    const r3 = await mergeClientsById([x.id, y.id], { actor: "" });
    c.ok("no named approver → refused", !r3.ok && /approving/.test(r3.message ?? ""));
    const r4 = await mergeClientsById([x.id, y.id], { actor: "info@drill.invalid", overrideBlockers: "Cara moved brokerages in August" });
    c.ok("with a written reason → merged", r4.ok);
    const logX = await prisma.auditLog.findFirst({ where: { action: "client_merge" }, orderBy: { createdAt: "desc" } });
    c.ok("…and the record carries the override reason", !!logX && JSON.parse(logX.detail).override === "Cara moved brokerages in August");

    const buyer = await person("Clean Carl TEST", { aryeoCustomerId: "ary-9", company: "Gamma" }, 2);
    const empty = await person("Clean Carl Dup TEST");
    const loserComms = (await prisma.commLog.findMany({ where: { clientId: empty.id }, select: { id: true } })).map((r) => r.id);
    const r5 = await mergeClientsById([buyer.id, empty.id], { actor: "info@drill.invalid" });
    c.ok("one buyer + one empty record → merged into the buyer", r5.ok && r5.survivor === buyer.id);
    c.ok("…the survivor keeps its one Aryeo link", (await prisma.client.findUnique({ where: { id: buyer.id } }))?.aryeoCustomerId === "ary-9");
    const log = await prisma.auditLog.findFirst({ where: { action: "client_merge", actor: "info@drill.invalid" }, orderBy: { createdAt: "desc" } });
    const d = log ? (JSON.parse(log.detail) as { survivorId: string; deleted: { id: string; name: string }[]; moved: Record<string, string[]> }) : null;
    c.ok("an AuditLog row names the survivor and holds the deleted row whole", d?.survivorId === buyer.id && d.deleted.length === 1 && d.deleted[0].id === empty.id && d.deleted[0].name === "Clean Carl Dup TEST");
    c.ok("…and every re-pointed id, per table", !!d && loserComms.every((id) => d.moved.commLog.includes(id)) && Array.isArray(d.moved.project) && Array.isArray(d.moved.smartTask) && Array.isArray(d.moved.programSignup));
    c.ok("…the moved rows really moved", (await prisma.commLog.count({ where: { id: { in: loserComms }, clientId: buyer.id } })) === loserComms.length);
  }

  // =========================================================================
  c.head("2 · STATIC: no automatic path to money or merges");
  {
    const files = walk(SRC);
    const text = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

    const mergeRefs = files.filter((f) => /\bmergeClientsById\b/.test(text.get(f)!) && !f.endsWith("src/lib/clientDedupe.ts"));
    const automated = (f: string) => /src\/app\/api\//.test(f) || /sweep/i.test(path.basename(f)) || /src\/lib\/(tasks|cron|listener|smartListener)/.test(f);
    c.ok("no cron route, webhook route or sweep references mergeClientsById", mergeRefs.filter(automated).length === 0, mergeRefs.map(rel).join(", ") || "no callers at all");
    c.ok("any caller is a human action ('use server' file)", mergeRefs.every((f) => /^\s*["']use server["']/m.test(text.get(f)!)), mergeRefs.map(rel).join(", ") || "none");

    const stripeFiles = files.filter((f) => text.get(f)!.includes("api.stripe.com"));
    const stripeWrites = stripeFiles.filter((f) => /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(text.get(f)!));
    c.ok("every Stripe client in the tree is read-only (no POST/PUT/PATCH/DELETE)", stripeFiles.length >= 2 && stripeWrites.length === 0, `${stripeFiles.map(rel).join(", ")}${stripeWrites.length ? ` — WRITES: ${stripeWrites.map(rel).join(", ")}` : ""}`);
    c.ok("no Stripe SDK in the tree", files.every((f) => !/from\s+["']stripe["']/.test(text.get(f)!)));

    const aryeoWrites: string[] = [];
    for (const [f, t] of text) {
      for (const m of t.matchAll(/aryeoRequest(?:<[^>]*>)?\(\s*([`"'][^`"']+[`"'])\s*,\s*\{[^}]*?method:\s*["'](POST|PUT|PATCH|DELETE)["']/g)) aryeoWrites.push(`${m[2]} ${m[1]} (${rel(f)})`);
    }
    const moneyish = aryeoWrites.filter((w) => /refund|credit|payment|charge|invoice|transfer|merge/i.test(w.split(" (")[0]));
    c.ok("Aryeo write paths exist and none touches refunds, credits, payments, charges or invoices", aryeoWrites.length > 0 && moneyish.length === 0, aryeoWrites.map((w) => w.split(" (")[0]).join(" · "));

    const autohdrUrls = files.filter((f) => /https?:\/\/[^\s"'`]*autohdr/i.test(text.get(f)!));
    c.ok("nothing calls AutoHDR (no AutoHDR URL anywhere in the code)", autohdrUrls.length === 0, autohdrUrls.map(rel).join(", "));
    // A function whose name STARTS with the act (topUpX, buyCredits, purchase…,
    // replenish…). Readers named for what they read (lastAutohdrTopUp) pass.
    const buyers = files.filter((f) => /function\s+(top_?up|buy|purchase|replenish)\w*\s*\(/i.test(text.get(f)!));
    c.ok("no vendor top-up or purchase function exists", buyers.length === 0, buyers.map(rel).join(", "));

    c.ok("no Plaid transfer or payment-initiation call", files.every((f) => !/\.(transferCreate|transferAuthorizationCreate|paymentInitiation\w*)\s*\(/.test(text.get(f)!)));

    const qb = text.get(path.join(SRC, "lib/integrations/quickbooks.ts")) ?? "";
    const posts = (qb.match(/method:\s*["']POST["']/g) ?? []).length;
    const tokenPosts = (qb.match(/fetch\(TOKEN_URL,\s*\{\s*method:\s*["']POST["']/g) ?? []).length;
    c.ok("QuickBooks POSTs only to its OAuth token endpoint", posts > 0 && posts === tokenPosts, `${posts} POST, ${tokenPosts} to TOKEN_URL`);
  }

  // =========================================================================
  c.head("3 · BEHAVIOUR: the automated paths run and nothing is merged, charged or sent");
  {
    // A pair the nightly review will find (same phone) — it must only report.
    await person("Dana Doubled", {}, 1); // not "TEST": the review skips test names
    await person("Dana Doubled Again");
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan-mg@drill.invalid", role: "PHOTOGRAPHER" } });
    await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-mg@drill.invalid", role: "ADMIN" } });
    await prisma.appUser.create({ data: { email: "owner-mg@drill.invalid", name: "Jordan", role: "OWNER", status: "ACTIVE", teamMemberId: jordanTm.id } });
    const clientsBefore = await prisma.client.count();
    const mergesBefore = await prisma.auditLog.count({ where: { action: "client_merge" } });

    const { reviewClientDuplicates } = await import("@/lib/clientDedupe");
    const { sweepPhotoCounts } = await import("@/lib/photoCount");
    const { ensureWeeklyBalanceCheck, handleAutohdrMail } = await import("@/lib/vendorBalance");
    const { deriveWaivedRevenue } = await import("@/lib/reworkCost");
    const { moneyExceptions } = await import("@/lib/moneyExceptions");
    const dupes = await reviewClientDuplicates();
    await sweepPhotoCounts();
    const check = await ensureWeeklyBalanceCheck();
    await deriveWaivedRevenue();
    await handleAutohdrMail({ externalId: "gmail-mg-1", gmailId: "mg-1", subject: "Your credits are running low", body: "Top up now.", fromEmail: "billing@autohdr.com" });
    await moneyExceptions({ role: "OWNER", realRole: "OWNER" });

    c.ok("the nightly review found the pair and only filed a question", dupes.candidates >= 1 && dupes.tasksFiled >= 1);
    c.ok("no client was deleted or merged by any automated path", (await prisma.client.count()) === clientsBefore && (await prisma.auditLog.count({ where: { action: "client_merge" } })) === mergesBefore);
    c.ok("the Monday check filed a task (a reading request, not a purchase)", check.created);
    c.ok("zero outbound calls from all of it", fence.blocked.length === 0 && fence.faked.length === 0, fence.blocked.join(", "));
  }

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
