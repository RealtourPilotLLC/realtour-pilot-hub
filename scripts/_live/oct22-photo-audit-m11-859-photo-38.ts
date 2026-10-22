// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, photo audit M11). 859 N Lawrence St (Joseph Sutow).
//
// Photo 38 is asked for twice on the photo job:
//   · the office question (photo-office:…:38): "Virtually stage the upper
//     patio (photo 38). Not on the order: confirm the scope or price …";
//   · the text's own ask (msg:…): "Virtual staging revisions: pic 11 dining
//     area and pic 38 upper patio".
// And "Not on the order" is wrong: Virtual Staging IS on the order; only the
// 3 staged photos it buys were exceeded. This:
//   1. rewrites the office line's "Not on the order:" as "More than the 3
//      staged photos ordered:" (the words the app now writes, officeWhy);
//   2. narrows every OTHER open photo ask that names photo 38 to the rest of
//      what it asks (pic 11 here), so photo 38 is asked once, by the office
//      question; an ask that is ONLY photo 38 is set aside as a duplicate
//      (Not needed, "the same request as <office ask>").
// Each change gets a history line. Nothing is sent.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-photo-audit-m11-859-photo-38.ts
// Write it:
//   … scripts/_live/oct22-photo-audit-m11-859-photo-38.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const PHOTO = "38";

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PHOTO_OFFICE_KEY_PREFIX } = await import("@/lib/itemMedium");
  const { photoNumbers } = await import("@/lib/photoDelivery/careRules");
  const { officeWhy, STAGED_PHOTOS_PER_LINE } = await import("@/lib/briefPhotoAsks");
  console.log(APPLY ? "APPLYING" : "DRY RUN (read-only connection)");
  const project = await prisma.project.findFirst({ where: { title: { startsWith: "859 N Lawrence St" }, client: { name: "Joseph Sutow" } }, select: { id: true, title: true, deliverables: { where: { removedFromOrderAt: null, type: "VIRTUAL_STAGING" }, select: { quantity: true } } } });
  if (!project) throw new Error("859 N Lawrence St not found");
  const staged = project.deliverables.reduce((s, d) => s + Math.max(1, d.quantity ?? 1), 0) * STAGED_PHOTOS_PER_LINE;
  const asks = await prisma.clientAsk.findMany({ where: { projectId: project.id, state: "OPEN", medium: "photo" }, orderBy: { askedAt: "asc" }, select: { id: true, summary: true, text: true, dedupeKey: true, historyJson: true } });
  const names38 = (a: { summary: string | null }) => (photoNumbers(a.summary ?? "") ?? "").split(/,\s*/).some((n) => n === PHOTO || (n.includes("-") && Number(n.split("-")[0]) <= 38 && Number(n.split("-")[1]) >= 38));
  const office = asks.find((a) => (a.dedupeKey ?? "").startsWith(`${PHOTO_OFFICE_KEY_PREFIX}${project.id}:${PHOTO}`));
  console.log(`${project.title}: ${asks.length} open photo asks; staging ordered: ${staged} photos\n`);
  for (const a of asks) console.log(`  ${a.id} [${a.dedupeKey}] names photo 38: ${names38(a)}\n    "${a.summary}"`);
  type Change = { id: string; summary?: string; notNeeded?: string; what: string };
  const changes: Change[] = [];
  if (office && /Not on the order:/.test(office.summary ?? "")) {
    const fixed = (office.summary ?? "").replace(/Not on the order: confirm the scope or price with the client first\./, officeWhy(["virtual staging"], staged));
    // Not clipped: the new words are a few characters longer than the old, and the column has no limit.
    changes.push({ id: office.id, summary: fixed, what: "office line reworded: staging is on the order, only the count was exceeded" });
  }
  for (const a of asks) {
    if (!office || a.id === office.id || !names38(a)) continue;
    const others = (photoNumbers(a.summary ?? "") ?? "").split(/,\s*/).filter((n) => n && n !== PHOTO);
    if (!others.length) {
      changes.push({ id: a.id, notNeeded: `The same request as the office question ${office.id} (photo 38).`, what: "duplicate of the office question: set aside" });
      continue;
    }
    // Here: "pic 11 dining area and pic 38 upper patio" -> the pic 11 part only.
    const narrowed = (a.summary ?? "").replace(/\s*(?:,|and)?\s*(?:pic|photo)\s*38\b[^,;.]*/i, "").replace(/revisions:/i, "revision:").trim();
    changes.push({ id: a.id, summary: `${narrowed}. Photo 38 is the office question (more staging than ordered).`.slice(0, 240), what: `narrowed to photo${others.length === 1 ? "" : "s"} ${others.join(", ")}: photo 38 is asked once, by the office question` });
  }
  console.log("");
  if (!changes.length) console.log("Nothing to change.");
  for (const c of changes) console.log(`WOULD ${c.notNeeded ? "SET ASIDE" : "UPDATE"} ${c.id}: ${c.what}${c.summary ? `\n    -> "${c.summary}"` : ""}${c.notNeeded ? `\n    -> Not needed: "${c.notNeeded}"` : ""}`);
  if (!APPLY) return prisma.$disconnect();
  const { markNotNeeded } = await import("@/lib/clientAsks");
  const by = "photo audit M11 (Oct 22 2026)";
  for (const c of changes) {
    if (c.notNeeded) {
      console.log(`${c.id}: ${(await markNotNeeded(c.id, by, c.notNeeded)).message}`);
      continue;
    }
    const row = asks.find((a) => a.id === c.id)!;
    let hist: unknown[] = [];
    try { hist = JSON.parse(row.historyJson ?? "[]") as unknown[]; } catch { hist = []; }
    hist.push({ at: new Date().toISOString(), by, what: c.what });
    const r = await prisma.clientAsk.updateMany({ where: { id: c.id, state: "OPEN" }, data: { summary: c.summary, historyJson: JSON.stringify(hist.slice(-30)) } });
    console.log(`${c.id}: ${r.count ? "updated" : "changed meanwhile, left"}`);
  }
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
