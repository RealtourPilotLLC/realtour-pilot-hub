// ---------------------------------------------------------------------------
// LIVE: open next month's workspace for every active (non-bulk) content client
// now, instead of waiting for the hourly sync after deploy (Jordan, Oct 21
// 2026: "I'd like it to show November too, so people can schedule the next
// month ahead of time"). Idempotent: an existing month is left as it is.
// DRY RUN by default (lists who would get one); --apply creates them.
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct21-open-next-month.ts [--apply]
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { ensureNextMonths } = await import("@/lib/contentProgram");
  const { etMonthKey } = await import("@/lib/datetime");
  const now = new Date();
  const [y, m] = etMonthKey(now).split("-").map(Number);
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
  const active = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE", OR: [{ programKind: null }, { programKind: { not: "BULK" } }] }, select: { id: true, clientId: true } });
  const have = new Set((await prisma.contentMonth.findMany({ where: { monthKey: next, enrollmentId: { in: active.map((e) => e.id) } }, select: { enrollmentId: true } })).map((x) => x.enrollmentId));
  const names = new Map((await prisma.client.findMany({ where: { id: { in: active.map((e) => e.clientId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const missing = active.filter((e) => !have.has(e.id));
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: ${next} · ${active.length} active non-bulk programs · ${have.size} already have it · ${missing.length} to open`);
  for (const e of missing) console.log(`  ${names.get(e.clientId) ?? e.clientId}`);
  if (APPLY) console.log("result:", JSON.stringify(await ensureNextMonths()));
  await prisma.$disconnect();
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : String(e)); process.exit(1); });
