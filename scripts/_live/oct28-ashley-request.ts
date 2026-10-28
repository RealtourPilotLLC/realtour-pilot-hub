// ---------------------------------------------------------------------------
// Oct 28 2026: Ashley Brunner's "reel like this" text, filed by the Smart Brain
// on 825 State St (Kyle: "just a general request for a future video, not this
// one"). DRY RUN by default (the connection is proven read-only first): lists
// her open requests on 825 State St, the brief lines that would go with each,
// and the open projects one could move to. Kyle can simply press "Not for this
// project" on the card instead; this exists only if the lead wants it done
// from here.
//
//   npx tsx scripts/_live/oct28-ashley-request.ts
//   npx tsx scripts/_live/oct28-ashley-request.ts --apply --ask=<askId> --outcome=future
//   npx tsx scripts/_live/oct28-ashley-request.ts --apply --ask=<askId> --outcome=move --to=<projectId>
//
// --apply goes through lib/requestPlacement.takeRequestOffProject, the same
// path as the button (timelines on both projects, Undo on the card after).
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

async function main() {
  const prisma = await db();
  const core = await import("../../src/lib/requestPlacementCore");
  const rp = await import("../../src/lib/requestPlacement");
  const clients = await prisma.client.findMany({ where: { name: { contains: "Brunner", mode: "insensitive" } }, select: { id: true, name: true } });
  const projects = await prisma.project.findMany({ where: { clientId: { in: clients.map((c) => c.id) }, title: { startsWith: "825 State" } }, select: { id: true, title: true, status: true, clientId: true } });
  console.log("clients:", JSON.stringify(clients));
  console.log("825 State St projects:", JSON.stringify(projects));
  for (const p of projects) {
    const asks = await prisma.clientAsk.findMany({ where: { projectId: p.id, kind: "SPECIAL_REQUEST", state: "OPEN" }, orderBy: { askedAt: "asc" }, select: { id: true, text: true, summary: true, source: true, sourceRef: true, askedAt: true, createdAt: true } });
    for (const a of asks) {
      const msg = a.sourceRef ? (await prisma.commLog.findUnique({ where: { id: a.sourceRef }, select: { body: true } }).catch(() => null))?.body ?? null : null;
      const near = await prisma.activity.findMany({ where: { projectId: p.id, type: "SPECIAL_REQUEST", createdAt: { gte: new Date(a.createdAt.getTime() - 20 * 60_000), lte: new Date(a.createdAt.getTime() + 20 * 60_000) } }, select: { id: true, body: true } });
      const lines = near.filter((l) => core.isLineOfAsk(l.body, a, msg));
      const ctx = await rp.placementContext(a.id);
      console.log(`\nASK ${a.id} (${a.source}, ${a.askedAt.toISOString()})\n  summary: ${a.summary}\n  text: ${a.text}\n  brief lines that go with it: ${JSON.stringify(lines)}\n  could move to: ${JSON.stringify(ctx.ok ? ctx.choices : ctx.message)}`);
    }
  }
  const askId = arg("ask");
  const outcome = arg("outcome") as "move" | "future" | "dismiss" | null;
  if (!askId || !outcome) {
    console.log("\nNothing chosen. Pass --ask=<id> --outcome=future|dismiss|move [--to=<projectId>] (and --apply to write).");
    return;
  }
  const ask = await prisma.clientAsk.findUniqueOrThrow({ where: { id: askId }, select: { projectId: true } });
  if (!APPLY) {
    console.log(`\nDRY RUN: would take ${askId} off ${ask.projectId} (${outcome}${arg("to") ? ` to ${arg("to")}` : ""}). Add --apply to write.`);
    return;
  }
  const r = await rp.takeRequestOffProject({ askId, fromProjectId: ask.projectId ?? "", outcome, toProjectId: arg("to"), by: "claude: Oct 28 repair for Kyle" });
  console.log("\nAPPLIED:", JSON.stringify(r));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => (await db()).$disconnect().catch(() => {}));
