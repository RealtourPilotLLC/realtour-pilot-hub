import { prisma } from "./src/lib/prisma";

function fmt(n: number) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

async function main() {
  const all = await prisma.stripeTransaction.findMany({
    orderBy: { createdAt: "asc" },
  });

  console.log("TOTAL ROWS:", all.length);
  if (all.length === 0) return;

  console.log("MIN createdAt:", all[0].createdAt.toISOString());
  console.log("MAX createdAt:", all[all.length - 1].createdAt.toISOString());

  // currency check
  const curr: Record<string, number> = {};
  for (const t of all) curr[t.currency] = (curr[t.currency] || 0) + 1;
  console.log("CURRENCIES:", JSON.stringify(curr));

  // distinct types overall
  const byType: Record<string, { n: number; gross: number; fee: number; net: number }> = {};
  for (const t of all) {
    const b = (byType[t.type] ||= { n: 0, gross: 0, fee: 0, net: 0 });
    b.n++; b.gross += t.gross; b.fee += t.fee; b.net += t.net;
  }
  console.log("\n=== TYPE TOTALS (ALL TIME) ===");
  console.log("type\tn\tgross\tfee\tnet");
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${k}\t${v.n}\t${fmt(v.gross)}\t${fmt(v.fee)}\t${fmt(v.net)}`);
  }

  // monthly x type — use UTC month key (Stripe created is UTC)
  const monthKey = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  const grid: Record<string, Record<string, { n: number; gross: number; fee: number; net: number }>> = {};
  for (const t of all) {
    const m = monthKey(t.createdAt);
    const row = (grid[m] ||= {});
    const b = (row[t.type] ||= { n: 0, gross: 0, fee: 0, net: 0 });
    b.n++; b.gross += t.gross; b.fee += t.fee; b.net += t.net;
  }

  console.log("\n=== MONTHLY x TYPE ===");
  console.log("month\ttype\tn\tgross\tfee\tnet");
  const months = Object.keys(grid).sort();
  for (const m of months) {
    for (const [tp, v] of Object.entries(grid[m]).sort()) {
      console.log(`${m}\t${tp}\t${v.n}\t${fmt(v.gross)}\t${fmt(v.fee)}\t${fmt(v.net)}`);
    }
  }

  // also ET month key to see if boundary matters
  const etKey = (d: Date) => {
    const s = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(d);
    return s.slice(0, 7);
  };
  let etDiff = 0;
  for (const t of all) if (etKey(t.createdAt) !== monthKey(t.createdAt)) etDiff++;
  console.log("\nRows where ET month != UTC month:", etDiff);

  // Stephen Kennedy hunt
  console.log("\n=== STEPHEN KENNEDY SEARCH ===");
  const hits = all.filter((t) => {
    const s = `${t.customerName ?? ""} ${t.description ?? ""} ${t.matchNote ?? ""}`.toLowerCase();
    return s.includes("kennedy") || s.includes("stephen") || s.includes("steve");
  });
  console.log("hits:", hits.length);
  for (const h of hits) {
    console.log(`${h.createdAt.toISOString()}\t${h.type}\t${fmt(h.gross)}\t${fmt(h.fee)}\t${fmt(h.net)}\tcust=${h.customerName}\tdesc=${h.description}\tnote=${h.matchNote}`);
  }

  // distinct customers
  const custs: Record<string, { n: number; gross: number }> = {};
  for (const t of all) {
    const k = t.customerName ?? "(null)";
    const c = (custs[k] ||= { n: 0, gross: 0 });
    c.n++; c.gross += t.gross;
  }
  console.log("\n=== DISTINCT customerName COUNT:", Object.keys(custs).length);
  console.log("top 40 by gross:");
  for (const [k, v] of Object.entries(custs).sort((a, b) => b[1].gross - a[1].gross).slice(0, 40)) {
    console.log(`${fmt(v.gross)}\t${v.n}\t${k}`);
  }

  // sample descriptions per type
  console.log("\n=== SAMPLE ROWS PER TYPE (up to 5) ===");
  for (const tp of Object.keys(byType)) {
    const s = all.filter((t) => t.type === tp).slice(0, 5);
    for (const r of s) {
      console.log(`${tp}\t${r.id}\t${r.createdAt.toISOString()}\tg=${fmt(r.gross)}\tf=${fmt(r.fee)}\tn=${fmt(r.net)}\tcust=${r.customerName}\tdesc=${(r.description ?? "").slice(0, 80)}`);
    }
  }

  // gap detection: days between consecutive txns
  console.log("\n=== GAPS > 14 DAYS between consecutive transactions ===");
  for (let i = 1; i < all.length; i++) {
    const d = (all[i].createdAt.getTime() - all[i - 1].createdAt.getTime()) / 86400000;
    if (d > 14) {
      console.log(`${fmt(d)} days: ${all[i - 1].createdAt.toISOString()} -> ${all[i].createdAt.toISOString()}`);
    }
  }

  // syncedAt distribution
  const sy = all.map((t) => t.syncedAt.getTime());
  console.log("\nsyncedAt min:", new Date(Math.min(...sy)).toISOString(), "max:", new Date(Math.max(...sy)).toISOString());

  // projectId match rate
  const matched = all.filter((t) => t.projectId).length;
  console.log("rows with projectId:", matched, "/", all.length);

  // Connection row
  const conn = await prisma.connection.findUnique({ where: { provider: "stripe" } });
  console.log("\n=== CONNECTION (stripe) ===");
  if (!conn) console.log("NO stripe connection row");
  else {
    console.log(JSON.stringify({
      status: conn.status,
      accountLabel: conn.accountLabel,
      lastSyncedAt: conn.lastSyncedAt,
      lastError: conn.lastError,
      metadata: conn.metadata,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
      hasSecret: !!conn.secretEncrypted,
    }, null, 2));
  }

  const allConns = await prisma.connection.findMany({ select: { provider: true, status: true, lastSyncedAt: true } });
  console.log("ALL CONNECTIONS:", JSON.stringify(allConns));
}

main().finally(() => prisma.$disconnect());
