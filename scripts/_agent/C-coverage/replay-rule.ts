// READ-ONLY. Replays the last 90 days of reply-SLA pages under the rule that is
// about to ship, so the choice of "what counts as urgent" is made on numbers.
//
// THE RULE UNDER TEST
//   tier 1 is always ROUTINE  — it is the first, gentlest ping ("30 min waiting")
//   tier 2 is URGENT          — the client has been waiting 2h (VIP 1h)
//   a strong complaint is URGENT at either tier
//   VIP/heavy does NOT promote tier 1; it already buys a faster clock
//     (TIER1_MIN_VIP 15 vs 30, TIER2_MIN_VIP 60 vs 120)
//
// Also replays the rejected alternative (VIP tier-1 = urgent) for comparison.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const VIP_SEGMENTS = new Set(["vip", "heavy"]);
const STRONG =
  /\b(disappoint\w*|unhappy|not happy|frustrat\w*|upset|annoyed|let down|nobody (got|called|responded)|ridiculous|unacceptable)\b/i;

const partsET = (d: Date) => {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { wd: g("weekday"), hour: Number(g("hour")) % 24 };
};
const covered = (d: Date) => {
  const p = partsET(d);
  return p.wd !== "Sat" && p.wd !== "Sun" && p.hour >= 9 && p.hour < 18;
};

async function main() {
  const since = new Date(Date.now() - 90 * 86400_000);
  const rows = await prisma.notification.findMany({
    where: { createdAt: { gte: since }, kind: "reply_sla" },
    select: { dedupeKey: true, createdAt: true, title: true },
    orderBy: { createdAt: "asc" },
  });
  const parse = (k: string | null) => {
    const m = /^sla-([12])-(.+?)-(\d{4}-\d{2}-\d{2}T.+)$/.exec(k ?? "");
    return m ? { tier: Number(m[1]) as 1 | 2, clientId: m[2], iso: m[3], episode: `${m[2]}|${m[3]}` } : null;
  };
  const pages = rows.map((r) => ({ ...r, p: parse(r.dedupeKey)! })).filter((r) => r.p);

  const clientIds = [...new Set(pages.map((r) => r.p.clientId))];
  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds } },
    select: { id: true, segment: true, parent: { select: { segment: true } } },
  });
  const vip = new Map(clients.map((c) => [c.id, VIP_SEGMENTS.has(c.segment ?? "") || VIP_SEGMENTS.has(c.parent?.segment ?? "")]));

  const isos = [...new Set(pages.map((r) => r.p.iso))].map((s) => new Date(s)).filter((d) => !Number.isNaN(d.getTime()));
  const comms = await prisma.commLog.findMany({
    where: { occurredAt: { in: isos }, direction: "INBOUND" },
    select: { clientId: true, occurredAt: true, body: true },
  });
  const bodyAt = new Map<string, string>();
  for (const c of comms) bodyAt.set(`${c.clientId}|${c.occurredAt.toISOString()}`, c.body ?? "");
  const angry = (p: { clientId: string; iso: string }, fallback: string) => {
    const at = new Date(p.iso);
    const body = (Number.isNaN(at.getTime()) ? undefined : bodyAt.get(`${p.clientId}|${at.toISOString()}`)) ?? fallback;
    return STRONG.test(body);
  };

  // Which waiting episodes had their tier-1 page land inside covered hours?
  // Tier 2 may never LEAD, so out of hours it only survives when tier 1 did.
  const tier1Covered = new Set<string>();
  for (const r of pages) if (r.p.tier === 1 && covered(r.createdAt)) tier1Covered.add(r.p.episode);

  for (const rule of ["shipping (tier2 = urgent)", "rejected (VIP tier1 also urgent)"] as const) {
    const vipUrgent = rule.startsWith("rejected");
    let fireNow = 0, defer = 0, held = 0;
    const deferByDay = new Map<string, number>();
    for (const r of pages) {
      if (covered(r.createdAt)) { fireNow++; continue; }
      const urgent = r.p.tier === 2 || angry(r.p, r.title) || (vipUrgent && !!vip.get(r.p.clientId));
      if (r.p.tier === 2) {
        // Tier 2 out of hours: only if tier 1 already went out during cover.
        if (tier1Covered.has(r.p.episode)) fireNow++;
        else held++;
        continue;
      }
      if (urgent) fireNow++;
      else {
        defer++;
        const d = partsET(r.createdAt).wd;
        deferByDay.set(d, (deferByDay.get(d) ?? 0) + 1);
      }
    }
    console.log(`\n--- ${rule} ---`);
    console.log(`  pages that still go out:        ${fireNow}`);
    console.log(`  tier-1 pages deferred to cover: ${defer}`);
    console.log(`  tier-2 pages held (no tier 1):  ${held}`);
    console.log(`  deferred by day:`, [...deferByDay].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join(" · ") || "—");
  }

  const strongHits = pages.filter((r) => angry(r.p, r.title)).length;
  console.log(`\nstrong-complaint pages in the whole 90d window: ${strongHits}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
