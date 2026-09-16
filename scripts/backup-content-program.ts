// READ-ONLY export of every content-program table to one JSON file.
//
// Jordan, Sep 16 2026, on authorising live-database work for the portal
// rebuild: "Claude should still preserve existing client records and take a
// backup before schema changes." This is that backup — the layer that is
// always available, because it needs nothing but the Prisma client. A full
// pg_dump is the gold standard and should be taken as well when the tooling is
// installed; this one exists so "no pg_dump on this machine" is never a reason
// to skip the step.
//
// Usage: npx tsx scripts/backup-content-program.ts <output.json>
// Output goes OUTSIDE the repo (it holds real client strategies and scripts).
// Never seeds, never resets, never writes to the database.
import { PrismaClient } from "@prisma/client";
import { writeFileSync, statSync } from "fs";

const p = new PrismaClient();
const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: npx tsx scripts/backup-content-program.ts <output.json>");
  process.exit(2);
}

async function main() {
  const dump: Record<string, unknown[]> = {};
  const tables: Array<[string, () => Promise<unknown[]>]> = [
    ["ContentEnrollment", () => p.contentEnrollment.findMany()],
    ["ContentMonth", () => p.contentMonth.findMany()],
    ["ContentTopic", () => p.contentTopic.findMany()],
    ["ContentScript", () => p.contentScript.findMany()],
    ["ContentStrategy", () => p.contentStrategy.findMany()],
    ["ContentNote", () => p.contentNote.findMany()],
    ["AgentProfile", () => p.agentProfile.findMany()],
    ["PortalVideo", () => p.portalVideo.findMany()],
    ["PortalComment", () => p.portalComment.findMany()],
  ];
  for (const [name, fn] of tables) {
    dump[name] = await fn();
    console.log(`  ${name.padEnd(18)} ${String(dump[name].length).padStart(6)} rows`);
  }
  // The clients those enrollments belong to, so the file stands on its own.
  const clientIds = [...new Set((dump.ContentEnrollment as { clientId: string }[]).map((e) => e.clientId))];
  dump["Client(enrolled)"] = await p.client.findMany({ where: { id: { in: clientIds } } });
  console.log(`  ${"Client(enrolled)".padEnd(18)} ${String(dump["Client(enrolled)"].length).padStart(6)} rows`);
  writeFileSync(OUT, JSON.stringify({ takenAt: new Date().toISOString(), tables: dump }, null, 1));
  console.log(`\nwrote ${OUT} (${(statSync(OUT).size / 1048576).toFixed(2)} MB)`);
}
main().finally(() => p.$disconnect());
