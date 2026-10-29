// ---------------------------------------------------------------------------
// Kristin Ciarmella's brand colors (Jordan, Oct 28 2026: "For Kristin
// Ciarmella, can you please add her color pallet to her branding", from her
// Canva brand kit: #dcc277 · #b3935c · #c8e0f7 · #142954).
//
// Writes Client.brandColors the way a brand save does: the column, ONE row in
// the brand-change ledger (source staff, labelled claude:), then the same
// editor alert a portal or staff brand change gets. Dry run by default
// (read-only connection, proven); --apply writes.
//
//   npx tsx --require ./scripts/_drill/_client-drill-preload.cjs \
//     scripts/_live/oct28-kristin-brand-colors.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const CLIENT_ID = "cmt7n3fw2006w9kg10ne5wwo7"; // Kristin Ciarmella (klciarmella@gmail.com)
const COLORS = "#dcc277, #b3935c, #c8e0f7, #142954";

(async () => {
  const prisma = await db();
  const c = await prisma.client.findUnique({ where: { id: CLIENT_ID }, select: { id: true, name: true, brandColors: true } });
  if (!c || c.name !== "Kristin Ciarmella") throw new Error(`Not Kristin Ciarmella: ${JSON.stringify(c)}`);
  const enrollment = await prisma.contentEnrollment.findFirst({ where: { clientId: c.id }, orderBy: { createdAt: "desc" }, select: { id: true } });
  console.log(`${c.name}: brand colors now ${JSON.stringify(c.brandColors)} → ${JSON.stringify(COLORS)}`);
  if ((c.brandColors ?? "").trim() === COLORS) { console.log("Already on file. Nothing to do."); await prisma.$disconnect(); return; }
  if (!APPLY) { console.log("dry run: nothing written."); await prisma.$disconnect(); return; }

  const { recordBrandChange, alertBrandChanges } = await import("../../src/lib/brandProfile");
  const changeId = await prisma.$transaction(async (tx) => {
    await tx.client.update({ where: { id: c.id }, data: { brandColors: COLORS } });
    return recordBrandChange({
      clientId: c.id, enrollmentId: enrollment?.id ?? null, fieldKey: "brandColors", label: "Brand colors", kind: "SET",
      fromText: c.brandColors || null, toText: COLORS, source: "staff",
      actorLabel: "claude: for Jordan (Kristin's Canva brand kit)",
    }, tx);
  });
  console.log(`saved; ledger row ${changeId}`);
  const alert = await alertBrandChanges(c.id).catch((e) => ({ error: String(e).slice(0, 200) }));
  console.log("editor alert:", JSON.stringify(alert));
  const after = await prisma.client.findUnique({ where: { id: c.id }, select: { brandColors: true } });
  const row = await prisma.clientBrandChange.findUnique({ where: { id: changeId }, select: { alertChannel: true, alertEditorKeys: true, taskId: true } });
  console.log("on file:", JSON.stringify(after), "ledger:", JSON.stringify(row));
  await prisma.$disconnect();
})();
