// ---------------------------------------------------------------------------
// Oct 26 2026: Jordan: "Do turn it on though, ill check it." The brief writer
// (scriptWriter/briefWriter.ts, his Scripting GPT's rules) switched on for the
// two pilot clients, Erica Walker and Bernadette Rabel (the same pilot as
// script_writer_v2). Dry run without --apply.
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const KEY = "script_brief_writer";
const NAMES = ["Erica Walker", "Bernadette Rabel"];

(async () => {
  const prisma = await db();
  const clients = await prisma.client.findMany({ where: { name: { in: NAMES } }, select: { id: true, name: true } });
  const enrollments = (await prisma.contentEnrollment.findMany({ where: { clientId: { in: clients.map((c) => c.id) } }, select: { id: true, status: true, clientId: true } }))
    .map((e) => ({ ...e, name: clients.find((c) => c.id === e.clientId)!.name }));
  for (const e of enrollments) console.log(`${e.name}: ${e.id} (${e.status})`);
  if (enrollments.length !== NAMES.length || new Set(enrollments.map((e) => e.name)).size !== NAMES.length) throw new Error("not exactly one enrollment for each pilot client");
  const before = await prisma.appSetting.findUnique({ where: { key: KEY } });
  const v2 = await prisma.appSetting.findUnique({ where: { key: "script_writer_v2" } });
  console.log("before:", before?.value ?? "(no row)", "| script_writer_v2:", v2?.value);
  const value = JSON.stringify({ on: true, enrollmentIds: enrollments.map((e) => e.id) });
  if (!APPLY) { console.log("would set:", value); return; }
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  console.log("set:", (await prisma.appSetting.findUnique({ where: { key: KEY } }))?.value);
  await prisma.$disconnect();
})();
