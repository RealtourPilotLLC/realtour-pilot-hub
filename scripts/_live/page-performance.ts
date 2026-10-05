/** Read-only timing of page data loaders. No customer data or SQL parameters
 * are printed. Run with NODE_OPTIONS=--conditions=react-server under Node 20. */
import { pinReadOnlyDatabaseUrl, proveReadOnly } from "../_lib/dbGuard";
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

pinReadOnlyDatabaseUrl();
const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
(globalThis as unknown as { prisma: PrismaClient }).prisma = client;
let queries: { ms: number; table: string }[] = [];
client.$on("query", (e) => queries.push({ ms: e.duration, table: e.query.match(/(?:FROM|UPDATE|INTO)\s+"(?:public"\.)?"?([\w]+)"/i)?.[1] ?? "other" }));

async function main() {
  await proveReadOnly(client);
  console.log("Read-only connection proven; only aggregate timings follow.");
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const excludeClientIds = (await client.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map(c => c.id);
  const queue = await import("@/lib/editorQueue");
  const review = await import("@/lib/reviewRoom");
  const delivery = await import("@/lib/readyToSend");
  const exceptions = await import("@/lib/opsExceptions");
  const board = await import("@/lib/deliveryBoard");
  const results = [];
  for (const [name, run] of [
    ["database roundtrip", () => client.$queryRaw`SELECT 1`],
    ["Editing Room queue", () => queue.buildEditorQueue({ excludeClientIds })],
    ["Review Room queue", () => review.getReviewQueue({ includeTest: false })],
    ["Delivery queue", () => delivery.readyToSend({ excludeClientIds, recordFollowUpHealth: false, includeNoticeIncidents: true })],
    ["Home exceptions", () => exceptions.opsExceptionsBoard({ includeTest: false })],
    ["Home pipeline", () => board.deliveryBoard({ excludeClientIds })],
  ] as [string, () => Promise<unknown>][]) {
    queries = [];
    const start = performance.now();
    await run();
    const result = { name, elapsedMs: Math.round(performance.now() - start), queries: queries.length, databaseMs: queries.reduce((n, q) => n + q.ms, 0), slowest: [...queries].sort((a,b) => b.ms-a.ms).slice(0,5) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(results, null, 2));
}
main().finally(() => client.$disconnect()).catch(() => { console.error("Read-only profiling failed; no production write was permitted."); process.exitCode = 1; });
