// READ-ONLY. Of the reply-SLA pages that fired outside Mon-Fri 9:00-18:00 ET in
// the last 90 days, how many would now DEFER (routine) and how many would still
// go out (urgent: VIP/heavy segment, a strong complaint, or tier 2)?
//
// Urgency is reconstructed exactly the way sweepReplySla will decide it:
//   tier 2                       -> urgent
//   client segment vip|heavy     -> urgent
//   strong complaint in the body -> urgent
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const VIP_SEGMENTS = new Set(["vip", "heavy"]);
// comms.ts NEGATIVE_STRONG_RE, copied here ONLY because this probe runs outside
// the "server-only" module graph. The shipped code imports the real one.
const STRONG =
  /\b(disappoint\w*|unhappy|not happy|frustrat\w*|upset|annoyed|let down|nobody (got|called|responded)|ridiculous|unacceptable)\b/i;

const partsET = (d: Date) => {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { wd: g("weekday"), hour: Number(g("hour")) % 24 };
};
const outOfCoverage = (d: Date) => {
  const p = partsET(d);
  return p.wd === "Sat" || p.wd === "Sun" || p.hour < 9 || p.hour >= 18;
};

async function main() {
  const since = new Date(Date.now() - 90 * 86400_000);
  const rows = await prisma.notification.findMany({
    where: { createdAt: { gte: since }, kind: "reply_sla" },
    select: { dedupeKey: true, createdAt: true, title: true },
  });

  // dedupeKey = sla-<tier>-<clientId>-<oldest message ISO>
  const parse = (k: string | null) => {
    const m = /^sla-([12])-(.+?)-(\d{4}-\d{2}-\d{2}T.+)$/.exec(k ?? "");
    return m ? { tier: Number(m[1]) as 1 | 2, clientId: m[2], iso: m[3] } : null;
  };
  const parsed = rows.map((r) => ({ ...r, p: parse(r.dedupeKey) })).filter((r) => r.p);
  const clientIds = [...new Set(parsed.map((r) => r.p!.clientId))];
  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds } },
    select: { id: true, segment: true, parent: { select: { segment: true } } },
  });
  const vip = new Map(clients.map((c) => [c.id, VIP_SEGMENTS.has(c.segment ?? "") || VIP_SEGMENTS.has(c.parent?.segment ?? "")]));

  // The message each page was about, for the complaint test.
  const isos = [...new Set(parsed.map((r) => r.p!.iso))].map((s) => new Date(s)).filter((d) => !Number.isNaN(d.getTime()));
  const comms = await prisma.commLog.findMany({
    where: { occurredAt: { in: isos }, direction: "INBOUND" },
    select: { clientId: true, occurredAt: true, body: true },
  });
  const bodyAt = new Map<string, string>();
  for (const c of comms) bodyAt.set(`${c.clientId}|${c.occurredAt.toISOString()}`, c.body ?? "");

  let out = 0, urgentTier2 = 0, urgentVip = 0, urgentAngry = 0, routine = 0;
  const routineByDay = new Map<string, number>();
  for (const r of parsed) {
    if (!outOfCoverage(r.createdAt)) continue;
    out++;
    const p = r.p!;
    const at = new Date(p.iso);
    const body = (Number.isNaN(at.getTime()) ? undefined : bodyAt.get(`${p.clientId}|${at.toISOString()}`)) ?? r.title;
    if (p.tier === 2) { urgentTier2++; continue; }
    if (vip.get(p.clientId)) { urgentVip++; continue; }
    if (STRONG.test(body)) { urgentAngry++; continue; }
    routine++;
    const d = partsET(r.createdAt);
    routineByDay.set(d.wd, (routineByDay.get(d.wd) ?? 0) + 1);
  }

  console.log(`reply_sla pages in 90d: ${rows.length} (${parsed.length} with a parseable key)`);
  console.log(`fired outside Mon-Fri 9-18 ET: ${out}`);
  console.log(`  would STILL GO (urgent):`);
  console.log(`    tier 2 escalation      ${urgentTier2}`);
  console.log(`    VIP / heavy client     ${urgentVip}`);
  console.log(`    strong complaint       ${urgentAngry}`);
  console.log(`  would DEFER (routine):   ${routine}`);
  console.log(`    by day:`, [...routineByDay].sort().map(([d, n]) => `${d} ${n}`).join(" · "));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
