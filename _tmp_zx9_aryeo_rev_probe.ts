import { prisma } from "@/lib/prisma";

// ET month key from a UTC Date
function etMonth(d: Date): string {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).format(d);
  return s.slice(0, 7);
}
function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
const r2 = (n: number) => Math.round(n * 100) / 100;
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : r2((s[m - 1] + s[m]) / 2);
}

async function main() {
  // ---------- 0. Coverage / sanity ----------
  const total = await prisma.project.count();
  const bySource = await prisma.project.groupBy({ by: ["source"], _count: true });
  const byStatus = await prisma.project.groupBy({ by: ["status"], _count: true });
  const bounds = await prisma.project.aggregate({
    _min: { orderedAt: true, shootDate: true, deliveredAt: true, createdAt: true },
    _max: { orderedAt: true, shootDate: true, deliveredAt: true, createdAt: true },
  });
  console.log("=== COVERAGE ===");
  console.log("total projects:", total);
  console.log("bySource:", JSON.stringify(bySource));
  console.log("byStatus:", JSON.stringify(byStatus));
  console.log("bounds:", JSON.stringify(bounds, null, 1));

  const nullDates = {
    orderedAtNull: await prisma.project.count({ where: { orderedAt: null } }),
    shootDateNull: await prisma.project.count({ where: { shootDate: null } }),
    deliveredAtNull: await prisma.project.count({ where: { deliveredAt: null } }),
    priceNull: await prisma.project.count({ where: { price: null } }),
    priceZero: await prisma.project.count({ where: { price: 0 } }),
    payableNull: await prisma.project.count({ where: { payableInvoice: null } }),
  };
  console.log("nulls:", JSON.stringify(nullDates));

  // ---------- 1. Load all projects ----------
  const rows = await prisma.project.findMany({
    select: {
      id: true, title: true, status: true, price: true, payableInvoice: true,
      orderedAt: true, shootDate: true, deliveredAt: true, createdAt: true,
      paymentStatus: true, balanceAmount: true, packageName: true, source: true,
      client: { select: { id: true, name: true, company: true, email: true } },
    },
  });
  console.log("loaded rows:", rows.length);

  // Unit sanity: price distribution
  const prices = rows.map(r => r.price).filter((p): p is number => p != null);
  console.log("price stats: n=", prices.length,
    "min=", Math.min(...prices), "max=", Math.max(...prices),
    "median=", median(prices), "hasCents=", prices.some(p => !Number.isInteger(p)));
  const pays = rows.map(r => r.payableInvoice).filter((p): p is number => p != null);
  console.log("payableInvoice stats: n=", pays.length, "min=", Math.min(...pays), "max=", Math.max(...pays), "median=", median(pays));
  const bals = rows.map(r => r.balanceAmount).filter((b): b is number => b != null);
  console.log("balanceAmount stats: n=", bals.length, "min=", Math.min(...bals), "max=", Math.max(...bals), "median=", median(bals));

  // ---------- 2. Monthly series ----------
  const MONTHS: string[] = [];
  for (let y = 2025; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      const k = `${y}-${String(m).padStart(2, "0")}`;
      if (k >= "2025-01" && k <= "2026-07") MONTHS.push(k);
    }
  }

  type Bucket = { n: number; sum: number; vals: number[]; zeroOrNull: number; cancelled: number };
  const mk = (): Bucket => ({ n: 0, sum: 0, vals: [], zeroOrNull: 0, cancelled: 0 });

  const byOrdered = new Map<string, Bucket>();
  const byShoot = new Map<string, Bucket>();
  const byDelivered = new Map<string, Bucket>();
  for (const k of MONTHS) { byOrdered.set(k, mk()); byShoot.set(k, mk()); byDelivered.set(k, mk()); }

  const push = (map: Map<string, Bucket>, key: string, price: number | null, cancelled: boolean) => {
    const b = map.get(key);
    if (!b) return;
    if (cancelled) { b.cancelled++; return; }
    b.n++;
    if (price == null || price === 0) b.zeroOrNull++;
    const v = price ?? 0;
    b.sum += v;
    b.vals.push(v);
  };

  for (const r of rows) {
    const cancelled = r.status === "CANCELLED";
    if (r.orderedAt) push(byOrdered, etMonth(r.orderedAt), r.price, cancelled);
    if (r.shootDate) push(byShoot, etMonth(r.shootDate), r.price, cancelled);
    if (r.deliveredAt) push(byDelivered, etMonth(r.deliveredAt), r.price, cancelled);
  }

  const dump = (name: string, map: Map<string, Bucket>) => {
    console.log(`\n=== ${name} ===`);
    console.log("month\tjobs\trevenue\tavg\tmedian\tzero/null\tcancelledExcl");
    for (const k of MONTHS) {
      const b = map.get(k)!;
      const nonZero = b.vals.filter(v => v > 0);
      console.log([
        k, b.n, r2(b.sum),
        b.n ? r2(b.sum / b.n) : 0,
        median(b.vals),
        b.zeroOrNull, b.cancelled,
        nonZero.length ? r2(b.sum / nonZero.length) : 0, // avg over priced jobs only
      ].join("\t"));
    }
  };
  dump("BY orderedAt (BOOKED/INVOICED)", byOrdered);
  dump("BY shootDate (WORK PERFORMED)", byShoot);
  dump("BY deliveredAt (DELIVERED/EARNED)", byDelivered);

  // shootDate series using payableInvoice for comparison
  console.log("\n=== BY shootDate, price vs payableInvoice ===");
  console.log("month\tjobs\tsum(price)\tsum(payable)");
  const payByShoot = new Map<string, { n: number; p: number; pi: number }>();
  for (const k of MONTHS) payByShoot.set(k, { n: 0, p: 0, pi: 0 });
  for (const r of rows) {
    if (!r.shootDate || r.status === "CANCELLED") continue;
    const b = payByShoot.get(etMonth(r.shootDate));
    if (!b) continue;
    b.n++; b.p += r.price ?? 0; b.pi += r.payableInvoice ?? 0;
  }
  for (const k of MONTHS) {
    const b = payByShoot.get(k)!;
    console.log([k, b.n, r2(b.p), r2(b.pi)].join("\t"));
  }

  // ---------- 3. Mar-Jul 2025 vs Mar-Jul 2026 ----------
  const window = ["03", "04", "05", "06", "07"];
  console.log("\n=== MAR-JUL COMPARISON ===");
  for (const [name, map] of [["orderedAt", byOrdered], ["shootDate", byShoot], ["deliveredAt", byDelivered]] as const) {
    for (const y of ["2025", "2026"]) {
      let n = 0, sum = 0; const vals: number[] = [];
      for (const mm of window) {
        const b = map.get(`${y}-${mm}`)!;
        n += b.n; sum += b.sum; vals.push(...b.vals);
      }
      console.log(`${name} ${y} Mar-Jul: jobs=${n} revenue=${r2(sum)} avg=${n ? r2(sum / n) : 0} median=${median(vals)}`);
    }
  }

  // ---------- 4. Stephen Kennedy ----------
  console.log("\n=== STEPHEN KENNEDY ===");
  const sk = await prisma.client.findMany({
    where: { OR: [{ name: { contains: "Kennedy" } }, { company: { contains: "Kennedy" } }] },
    select: { id: true, name: true, company: true, email: true, phone: true },
  });
  console.log("clients matching 'Kennedy':", JSON.stringify(sk, null, 1));
  const skRows = rows.filter(r => (r.client?.name ?? "").toLowerCase().includes("kennedy") || (r.client?.company ?? "").toLowerCase().includes("kennedy"));
  console.log("projects:", skRows.length);
  for (const r of skRows.sort((a, b) => (a.shootDate ?? a.orderedAt ?? a.createdAt).getTime() - (b.shootDate ?? b.orderedAt ?? b.createdAt).getTime())) {
    console.log([
      r.client?.name, r.title,
      "ordered=" + (r.orderedAt ? etDate(r.orderedAt) : "-"),
      "shoot=" + (r.shootDate ? etDate(r.shootDate) : "-"),
      "delivered=" + (r.deliveredAt ? etDate(r.deliveredAt) : "-"),
      "price=" + (r.price ?? "null"),
      "payable=" + (r.payableInvoice ?? "null"),
      "payStatus=" + (r.paymentStatus ?? "null"),
      "balCents=" + (r.balanceAmount ?? "null"),
      "status=" + r.status,
      "pkg=" + (r.packageName ?? "-"),
    ].join(" | "));
  }
  // also search project titles / stripe / qbo
  const skStripe = await prisma.stripeTransaction.findMany({ where: { customerName: { contains: "Kennedy" } }, select: { createdAt: true, gross: true, net: true, type: true, customerName: true } });
  console.log("stripe txns w/ Kennedy:", JSON.stringify(skStripe));
  const skQbo = await prisma.qboTransaction.findMany({ where: { customerName: { contains: "Kennedy" } }, select: { txnDate: true, amount: true, type: true, customerName: true, balance: true } });
  console.log("qbo txns w/ Kennedy:", skQbo.length, JSON.stringify(skQbo.slice(0, 60)));
  const skComm = await prisma.commLog.count({ where: { OR: [{ contactName: { contains: "Kennedy" } }] } }).catch(() => -1);
  console.log("commlogs Kennedy:", skComm);

  // ---------- 5. Zero/null value jobs ----------
  console.log("\n=== ZERO / NULL VALUE JOBS ===");
  const zn = rows.filter(r => (r.price == null || r.price === 0) && r.status !== "CANCELLED");
  console.log("count (non-cancelled):", zn.length, "of", rows.filter(r => r.status !== "CANCELLED").length);
  const znByMonth = new Map<string, number>();
  for (const r of zn) {
    const d = r.shootDate ?? r.orderedAt ?? r.createdAt;
    const k = etMonth(d);
    znByMonth.set(k, (znByMonth.get(k) ?? 0) + 1);
  }
  console.log("zero/null by month (shootDate pref):", JSON.stringify([...znByMonth.entries()].sort()));
  console.log("sample zero/null:", JSON.stringify(zn.slice(0, 15).map(r => ({ t: r.title, c: r.client?.name, s: r.status, price: r.price, pkg: r.packageName, shoot: r.shootDate ? etDate(r.shootDate) : null })), null, 1));
  // how many zero/null have a payableInvoice we could use
  console.log("zero/null WITH payableInvoice>0:", zn.filter(r => (r.payableInvoice ?? 0) > 0).length);

  // ---------- 6. Payment status distribution ----------
  const ps = await prisma.project.groupBy({ by: ["paymentStatus"], _count: true });
  console.log("\npaymentStatus dist:", JSON.stringify(ps));

  // ---------- 7. Cross-check: Stripe + QBO monthly (context only) ----------
  console.log("\n=== STRIPE monthly gross (context) ===");
  const st = await prisma.stripeTransaction.findMany({
    where: { type: { in: ["charge", "payment", "refund", "payment_refund", "adjustment"] } },
    select: { createdAt: true, gross: true },
  });
  const stM = new Map<string, { n: number; g: number }>();
  for (const t of st) { const k = etMonth(t.createdAt); const b = stM.get(k) ?? { n: 0, g: 0 }; b.n++; b.g += t.gross; stM.set(k, b); }
  for (const [k, v] of [...stM.entries()].sort()) console.log(k, v.n, r2(v.g));

  console.log("\n=== QBO monthly (context) ===");
  const qb = await prisma.qboTransaction.groupBy({ by: ["type"], _count: true });
  console.log("qbo types:", JSON.stringify(qb));
  const qbo = await prisma.qboTransaction.findMany({ select: { txnDate: true, amount: true, type: true } });
  const qM = new Map<string, Record<string, { n: number; a: number }>>();
  for (const t of qbo) {
    const k = etMonth(t.txnDate);
    const b = qM.get(k) ?? {};
    b[t.type] = b[t.type] ?? { n: 0, a: 0 };
    b[t.type].n++; b[t.type].a += t.amount;
    qM.set(k, b);
  }
  for (const [k, v] of [...qM.entries()].sort()) {
    console.log(k, Object.entries(v).map(([t, x]) => `${t}:${x.n}/$${r2(x.a)}`).join(" "));
  }
}

main().finally(() => prisma.$disconnect());
