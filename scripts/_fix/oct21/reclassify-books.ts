// ---------------------------------------------------------------------------
// Oct 21 2026 (Books): re-run the bank/card classification rules over every
// UNLOCKED Plaid line, all accounts, and show what changes.
//
// Why: ··3002 (business checking) closed; its last line posted 2026-09-05.
// From the cutover (lib/financeCategories.operatingCutover: the AppSetting
// "finance:operating-cutover", default 2026-09-06) ··0942 is the business
// checking account, and the rules now read it that way: contractors paid by
// Zelle are business costs, a deposit nobody can name waits in REVIEW instead
// of being booked as income, a loan advance is not income, and so on. Lines
// before the cutover, and every other account, are classified as before; the
// diff below proves it.
//
// It plans with the SAME pure function the daily run uses
// (financeCategories.planPlaidCategories), so the dry run is exactly what the
// next early-morning daily run (plaidCategorize) would write once this code is
// deployed. Run the dry run BEFORE the deploy to see it first.
//
//   set -a && source .env && set +a && npx tsx --conditions=react-server scripts/_fix/oct21/reclassify-books.ts            # dry run
//   ... --apply      write the changed rows
//   ... --samples 30 more sample lines per transition (default 15)
//
// Owner-locked rows (financeLocked) are never planned or written. --apply
// writes only the rows that change, each one under a guard: the row must
// still be unlocked AND still carry the kind and category it was planned
// from, so a line the owner tags (or the daily run re-sorts) mid-run is left
// alone and counted. The returned-payment netting the daily run also does is
// unchanged by this work and is not repeated here.
//
// Proven on a drill database by scripts/_drill/oct21-books-0942.ts.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";

export type Transition = {
  from: { kind: string | null; category: string | null };
  to: { kind: string; category: string };
  count: number;
  /** Sum of Plaid amounts (+ = money out, − = money in). */
  amount: number;
  samples: { id: string; date: string; account: string; amount: number; name: string }[];
};

export type ReclassifyResult = {
  cutoverKey: string;
  cutoverSource: string;
  scanned: number;
  locked: number;
  changes: number;
  /** key = `${from} → ${to}` */
  transitions: Map<string, Transition>;
  /** account label → transition key → count */
  byAccount: Map<string, Map<string, { count: number; amount: number }>>;
  /** Net effect on each kind, for the changed rows, in dollars: money out and
   *  money in counted separately, + entering the kind, − leaving it. */
  netByKind: Record<string, { out: number; in: number }>;
  wrote: number;
  /** Planned rows that changed under us before the write (left alone). */
  raced: string[];
};

const tag = (kind: string | null, category: string | null) => `${kind ?? "(none)"} / ${category ?? "(none)"}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function reclassifyBooks(
  prisma: PrismaClient,
  opts: { apply: boolean; samples?: number; beforeApply?: () => Promise<void> },
): Promise<ReclassifyResult> {
  const fc = await import("../../../src/lib/financeCategories");
  const setting = await prisma.appSetting.findUnique({ where: { key: fc.OPERATING_CUTOVER_SETTING }, select: { value: true } });
  const cutoverKey = fc.parseOperatingCutover(setting?.value);
  // A stored value that is not a date falls back to the default; say so.
  const cutoverSource = !setting ? "default" : cutoverKey === fc.OPERATING_CUTOVER_DEFAULT && !setting.value.includes(cutoverKey) ? "default; the stored setting is not a date" : "setting";

  const accounts = await prisma.plaidAccount.findMany({ select: { accountId: true, mask: true, name: true } });
  const label = new Map(accounts.map((a) => [a.accountId, `··${a.mask ?? "????"} ${a.name ?? ""}`.trim()]));
  const raw = await prisma.plaidTransaction.findMany({
    select: {
      id: true, accountId: true, name: true, merchantName: true, amount: true, categoryDetail: true, date: true,
      financeKind: true, financeCategory: true, financeLocked: true, account: { select: { mask: true } },
    },
    orderBy: { date: "asc" },
  });
  const rows = raw.map(({ account, ...r }) => ({ ...r, mask: account?.mask ?? null }));
  const plan = fc.planPlaidCategories(rows, cutoverKey);

  const maxSamples = opts.samples ?? 15;
  const transitions = new Map<string, Transition>();
  const byAccount = new Map<string, Map<string, { count: number; amount: number }>>();
  const netByKind: Record<string, { out: number; in: number }> = {};
  const shift = (kind: string, amount: number, sign: 1 | -1) => {
    const k = (netByKind[kind] ||= { out: 0, in: 0 });
    if (amount >= 0) k.out = r2(k.out + sign * amount);
    else k.in = r2(k.in + sign * -amount);
  };
  const changed: { id: string; from: { kind: string | null; category: string | null }; to: { kind: string; category: string } }[] = [];
  for (const r of rows) {
    const p = plan.get(r.id);
    if (!p || (p.kind === r.financeKind && p.category === r.financeCategory)) continue;
    const key = `${tag(r.financeKind, r.financeCategory)}  →  ${tag(p.kind, p.category)}`;
    const t = transitions.get(key) ?? { from: { kind: r.financeKind, category: r.financeCategory }, to: p, count: 0, amount: 0, samples: [] };
    t.count++;
    t.amount = r2(t.amount + r.amount);
    if (t.samples.length < maxSamples) {
      t.samples.push({ id: r.id, date: r.date.toISOString().slice(0, 10), account: label.get(r.accountId) ?? r.accountId, amount: r.amount, name: (r.name || r.merchantName || "").slice(0, 80) });
    }
    transitions.set(key, t);
    const acct = label.get(r.accountId) ?? r.accountId;
    const a = byAccount.get(acct) ?? new Map<string, { count: number; amount: number }>();
    const x = a.get(key) ?? { count: 0, amount: 0 };
    x.count++; x.amount = r2(x.amount + r.amount);
    a.set(key, x);
    byAccount.set(acct, a);
    shift(r.financeKind ?? "(none)", r.amount, -1);
    shift(p.kind, r.amount, 1);
    changed.push({ id: r.id, from: { kind: r.financeKind, category: r.financeCategory }, to: p });
  }

  let wrote = 0;
  const raced: string[] = [];
  if (opts.apply) {
    if (opts.beforeApply) await opts.beforeApply();
    for (const c of changed) {
      const res = await prisma.plaidTransaction.updateMany({
        where: { id: c.id, financeLocked: false, financeKind: c.from.kind, financeCategory: c.from.category },
        data: { financeKind: c.to.kind, financeCategory: c.to.category },
      });
      if (res.count === 1) wrote++;
      else raced.push(c.id);
    }
  }
  return {
    cutoverKey, cutoverSource,
    scanned: rows.length,
    locked: rows.filter((r) => r.financeLocked).length,
    changes: changed.length,
    transitions, byAccount, netByKind, wrote, raced,
  };
}

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const apply = process.argv.includes("--apply");
  const si = process.argv.indexOf("--samples");
  const samples = si > 0 ? Math.max(1, Number(process.argv[si + 1]) || 15) : 15;
  const { prisma } = await import("../../../src/lib/prisma");
  const r = await reclassifyBooks(prisma as unknown as PrismaClient, { apply, samples });

  console.log(`Cutover: ··0942 is business checking from ${r.cutoverKey} (${r.cutoverSource}).`);
  console.log(`${r.scanned.toLocaleString("en-US")} lines read · ${r.locked.toLocaleString("en-US")} owner-locked (never touched) · ${r.changes.toLocaleString("en-US")} would change.\n`);

  console.log("BY ACCOUNT (old → new, lines, sum of amounts: + out / − in)");
  for (const [acct, m] of [...r.byAccount].sort((a, b) => a[0].localeCompare(b[0]))) {
    const n = [...m.values()].reduce((s, x) => s + x.count, 0);
    console.log(`\n  ${acct}: ${n} line${n === 1 ? "" : "s"}`);
    for (const [key, x] of [...m].sort((a, b) => b[1].count - a[1].count)) console.log(`    ${String(x.count).padStart(5)}  ${money(x.amount).padStart(13)}  ${key}`);
  }

  console.log("\nBY TRANSITION, ALL ACCOUNTS, WITH SAMPLES");
  for (const [key, t] of [...r.transitions].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`\n  ${key}\n    ${t.count} line${t.count === 1 ? "" : "s"}, ${money(t.amount)}`);
    for (const s of t.samples) console.log(`      ${s.date}  ${s.account.padEnd(22).slice(0, 22)}  ${money(s.amount).padStart(12)}  ${s.name}`);
  }

  console.log("\nNET EFFECT ON EACH KIND (changed lines only; + = more dollars filed there, − = fewer)");
  for (const [k, v] of Object.entries(r.netByKind).sort()) console.log(`  ${k.padEnd(10)} money out ${money(v.out).padStart(13)}   money in ${money(v.in).padStart(13)}`);
  console.log("  (BUSINESS money out is what the P&L subtracts; INCOME money in is cash-in for the runway only, never revenue.)");

  if (apply) {
    console.log(`\nWROTE ${r.wrote} line${r.wrote === 1 ? "" : "s"}.${r.raced.length ? ` ${r.raced.length} changed while this ran and were left alone: ${r.raced.slice(0, 20).join(", ")}` : ""}`);
  } else {
    console.log("\nDRY RUN: nothing written. Re-run with --apply.");
  }
  await prisma.$disconnect();
}

// Run only when started as the script itself (the drill imports the function).
if (process.argv[1]?.endsWith("reclassify-books.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
