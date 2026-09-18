// READ-ONLY: why does an unmatched conversation have no lead to-do behind it?
// Looks at every `lead-*` task ever filed and at the recent unmatched inbound
// texts, to tell "the receiver never filed one" apart from "somebody closed it".
import { prisma } from "@/lib/prisma";

async function main() {
  const leads = await prisma.smartTask.findMany({
    where: { taskType: "lead" },
    select: { id: true, dedupeKey: true, status: true, createdAt: true, title: true, source: true },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  console.log(`\nlead tasks on record: ${leads.length}`);
  for (const l of leads.slice(0, 20)) {
    console.log(`  ${l.status.padEnd(10)} ${l.createdAt.toISOString().slice(0, 10)} ${String(l.dedupeKey).padEnd(28)} ${l.title.slice(0, 60)}`);
  }
  const phoneLeads = new Set(leads.map((l) => String(l.dedupeKey ?? "").slice(5)).filter((k) => /^\d{10}$/.test(k)));

  const since = new Date(Date.now() - 45 * 86_400_000);
  const rows = await prisma.commLog.findMany({
    where: { channel: { in: ["text", "call"] }, direction: "in", clientId: null, occurredAt: { gte: since } },
    select: { fromPhone: true, contactName: true, occurredAt: true, source: true, body: true },
    orderBy: { occurredAt: "desc" },
    take: 400,
  });
  const byPhone = new Map<string, { n: number; last: Date; name: string | null; sources: Set<string>; sample: string }>();
  for (const r of rows) {
    if (!r.fromPhone) continue;
    const e = byPhone.get(r.fromPhone) ?? { n: 0, last: r.occurredAt, name: r.contactName, sources: new Set<string>(), sample: r.body.slice(0, 70) };
    e.n++;
    e.sources.add(r.source);
    byPhone.set(r.fromPhone, e);
  }
  console.log(`\nunmatched inbound numbers in the last 45 days: ${byPhone.size}`);
  let orphans = 0;
  for (const [phone, e] of [...byPhone.entries()].sort((a, b) => b[1].last.getTime() - a[1].last.getTime())) {
    const has = phoneLeads.has(phone);
    if (!has) orphans++;
    console.log(
      `  ${has ? "lead ✓" : "NO LEAD"} ${phone} ${String(e.name ?? "").slice(0, 22).padEnd(22)} ${e.n} msg · last ${e.last.toISOString().slice(0, 10)} · sources=[${[...e.sources].join(",")}]`,
    );
  }
  console.log(`\n  ${orphans} unmatched number(s) with no lead to-do ever filed.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
