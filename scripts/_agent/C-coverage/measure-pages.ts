// READ-ONLY. How many of the last 90 days' internal pages fired when nobody was
// on shift (Mon-Fri 9:00-18:00 ET), by alert type. Verifies the reviewer's
// "47 of 196 reply-SLA on weekends, 8 of 20 photos-undelivered" claim.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const partsET = (d: Date) => {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { wd: g("weekday"), hour: Number(g("hour")) % 24, day: `${g("year")}-${g("month")}-${g("day")}` };
};

async function main() {
  const since = new Date(Date.now() - 90 * 86400_000);
  const rows = await prisma.notification.findMany({
    where: { createdAt: { gte: since }, kind: { in: ["reply_sla", "photos_undelivered"] } },
    select: { kind: true, dedupeKey: true, createdAt: true, audience: true, title: true },
    orderBy: { createdAt: "asc" },
  });
  const buckets = new Map<string, { total: number; weekend: number; weeknight: number; covered: number }>();
  const add = (k: string, p: ReturnType<typeof partsET>) => {
    const b = buckets.get(k) ?? { total: 0, weekend: 0, weeknight: 0, covered: 0 };
    b.total++;
    const weekend = p.wd === "Sat" || p.wd === "Sun";
    const inHours = p.hour >= 9 && p.hour < 18;
    if (weekend) b.weekend++;
    else if (!inHours) b.weeknight++;
    else b.covered++;
    buckets.set(k, b);
  };
  for (const r of rows) {
    const p = partsET(r.createdAt);
    const tier = r.dedupeKey?.startsWith("sla-2-") ? "reply_sla tier2" : r.dedupeKey?.startsWith("sla-1-") ? "reply_sla tier1" : r.kind;
    add(r.kind, p);
    if (r.kind === "reply_sla") add(tier, p);
  }
  console.log(`window: ${since.toISOString().slice(0, 10)} -> today, ${rows.length} notification rows\n`);
  console.log("type".padEnd(20), "total".padStart(6), "weekend".padStart(8), "weeknight".padStart(10), "in-hours".padStart(9));
  for (const [k, b] of [...buckets].sort()) {
    console.log(k.padEnd(20), String(b.total).padStart(6), String(b.weekend).padStart(8), String(b.weeknight).padStart(10), String(b.covered).padStart(9));
  }

  // The old tier-1 gate was 8:00-19:00 ET with no weekday test. What changes is
  // exactly the set that fired outside Mon-Fri 9-18.
  const oldGateOnly = rows.filter((r) => {
    const p = partsET(r.createdAt);
    const weekend = p.wd === "Sat" || p.wd === "Sun";
    return weekend || p.hour < 9 || p.hour >= 18;
  });
  console.log(`\nfired outside Mon-Fri 9:00-18:00 ET: ${oldGateOnly.length} of ${rows.length}`);

  // Staff TEXTS actually sent out of coverage (the ones that buzz a phone).
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { createdAt: { gte: since }, channel: { in: ["sms", "slack"] }, status: "sent" },
    select: { kind: true, channel: true, createdAt: true },
  });
  const outByKind = new Map<string, { total: number; out: number }>();
  for (const d of deliveries) {
    const p = partsET(d.createdAt);
    const out = p.wd === "Sat" || p.wd === "Sun" || p.hour < 9 || p.hour >= 18;
    const k = `${d.kind}/${d.channel}`;
    const b = outByKind.get(k) ?? { total: 0, out: 0 };
    b.total++; if (out) b.out++;
    outByKind.set(k, b);
  }
  console.log(`\nsent staff deliveries, last 90d (kind/channel: out-of-coverage / total)`);
  for (const [k, b] of [...outByKind].sort((a, b2) => b2[1].out - a[1].out).slice(0, 15)) {
    console.log(`  ${k.padEnd(34)} ${String(b.out).padStart(5)} / ${b.total}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
