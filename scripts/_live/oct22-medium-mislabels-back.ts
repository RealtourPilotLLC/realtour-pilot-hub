// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, comms audit C2): put video changes the photo
// words misread back on the video side.
//
// Today's photo / video labelling (lib/itemMedium, deployed about 6:05 PM ET)
// counted bare "still", "stage" and "image" as photo words, and let those
// words overrule the model's own label. So "The people are still a bit
// glitchy", "Can you still add my logo at the end?" and "make my brand image
// pop in the end card" read as photo items: off the editor's brief, onto the
// photo job's asks. The rule is fixed (specific photo words only; the words
// decide only when the model said "unclear" or gave no label). This finds
// what the old rule filed and moves it back, with the app's own functions:
//
//   1. the item says video again (and a question the old words moved to the
//      photo side goes back to the video side);
//   2. revisionIssues.ingestBriefItems: the editor gets the item, exactly as
//      the analyser would have filed it;
//   3. creativeReview.routeCreativeReview: a video question opens (or joins)
//      the Video Review Room card, as it would have;
//   4. clientAsks.markNotNeeded: a photo ask filed ONLY from moved items is
//      set aside ("Not about the photos: a video change (audit C2)"); an ask
//      that also carries a real photo item is left and printed.
// A photo job the old rule reopened is printed, never touched: a person
// decides whether it goes back.
//
// WHAT IS A MISLABEL (the same scan as the read-only check): on a work order
// created or analysed since 5:30 PM ET Oct 22 (or any older one carrying
// medium labels), an item stored as photo / both whose words read as photos
// under the OLD rule and not under the NEW one (the model's own label is not
// stored, so these are the items only the old words could have made photo);
// a question the old words moved to the photo side that the new words do
// not; a client ask filed since then whose medium came from the old words.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-medium-mislabels-back.ts
// Write it:
//   ... scripts/_live/oct22-medium-mislabels-back.ts --apply
// A wider look (read-only unless --apply): --since=2026-10-01T00:00:00Z
// Nothing messages anyone.
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  // A dry run cannot write, whatever the code below does.
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

// 5:30 PM ET, half an hour before the photo-asks deploy. `--since=<ISO>` scans further back (a wider look; same rule).
const SINCE_ARG = process.argv.find((a) => a.startsWith("--since="))?.slice(8);
const DEPLOY = new Date(SINCE_ARG && !Number.isNaN(Date.parse(SINCE_ARG)) ? SINCE_ARG : "2026-10-22T21:30:00Z");
const BY = "Hub repair (Oct 22 audit C2)";
const WHY = "Not about the photos: a video change (audit C2)";

// ---- the OLD photo words (a pure copy of lib/itemMedium before the fix) ----
const OLD_PHOTO = new RegExp([
  String.raw`\b(?:photo|pic|picture|image|still)s?\s*(?:#|no\.?\s*|number\s*)?\d{1,3}\b`,
  String.raw`\b(?:photos?|pics?|pictures?|images?|stills?|headshots?|photograph(?:s|y)?)\b`,
  String.raw`\bvirtual(?:ly)?[\s-]*stag\w*`, String.raw`\bre-?stag\w*`, String.raw`\bstag(?:e|ed|ing|er)\b`,
  String.raw`\btwilights?\b`, String.raw`\b(?:lot|property|boundary)\s*lines?\b`, String.raw`\bfloor\s*-?\s*plans?\b`,
  String.raw`\bretouch\w*`, String.raw`\bsky\s*replace\w*`,
].join("|"), "i");
const OLD_VIDEO = new RegExp([
  String.raw`\b(?:videos?|reels?|clips?|footage|films?|cinematic)\b`, String.raw`\b(?:rough|final|first|new)\s+cut\b`, String.raw`\bre-?cut\b`,
  String.raw`\b(?:music|song|audio|voice-?over|b-?roll|intro|outro|caption|subtitle)s?\b`, String.raw`\bon-?screen text\b`, String.raw`\bV\d{1,2}\b`, String.raw`\b\d{1,2}:\d{2}\b`,
].join("|"), "i");
const oldQuestionMedium = (q: string) => {
  const t = q.replace(/\s+/g, " ");
  const p = OLD_PHOTO.test(t), v = OLD_VIDEO.test(t);
  return p && !v ? "photo" : p && v ? "both" : "video";
};
// ---- the OLD askMedium photo words (lib/comms before the fix) ----
const A_VIDEO = /\b(video|reel|clip|footage|(?:rough|final|first|new)\s+cut|re-?cut|music|audio|song|caption|subtitle|intro|outro|walk-?through|transition|b-?roll|speaking|talking|voice-?over|scene|frames?|on-?screen text|stabiliz\w*|zoom(?:ed|ing)? in|punch(?:ed)? in)\b/gi;
const A_PHOTO_OLD = /\b(photos?|pictures?|pics?|images?|shots?|stills?|headshots?|retouch\w*|edit(?:ed|ing)? (?:this|these|the)? ?(?:photo|picture|pic|image|shot)s?|twilight|floor ?plan|virtual(?:ly)? stag\w*)\b/gi;
const REQ = /\b(can|could|would|will|are you able|is it possible|possible to|any chance|please|need|want|send me|resend|swap|replace|remove|add)\b|\?/i;
function oldAskMedium(note: string): string {
  const text = (note ?? "").trim();
  if (!text) return "unclear";
  const count = (re: RegExp, s: string) => (s.match(new RegExp(re.source, "gi")) ?? []).length;
  const firstLine = text.split(/\n|—/)[0] ?? "";
  const asks = text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean).filter((x) => REQ.test(x));
  const scope = asks.length > 0 ? asks.join(" ") : text;
  const v = count(A_VIDEO, scope) + count(A_VIDEO, firstLine);
  const p = count(A_PHOTO_OLD, scope) + count(A_PHOTO_OLD, firstLine);
  return v > p ? "video" : p > v ? "photo" : "unclear";
}

const one = (s: string | null | undefined, n = 150) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const ET = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "-");

type Item = { id: string; ask: string; detail?: string | null; quote?: string | null; medium?: string; held?: boolean; [k: string]: unknown };
type Doc = { items?: Item[]; questions?: string[]; photoQuestions?: string[]; photoAsks?: { at: string; ids: string[] }; [k: string]: unknown };

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const M = await import("@/lib/itemMedium");
  const { askMedium } = await import("@/lib/comms");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: comms audit C2, video changes the old photo words misread\n`);

  const sel = { id: true, createdAt: true, analyzedAt: true, source: true, originalText: true, itemsJson: true, projectId: true, project: { select: { title: true, client: { select: { name: true } } } } } as const;
  const recent = await prisma.revisionBrief.findMany({ where: { OR: [{ createdAt: { gte: DEPLOY } }, { analyzedAt: { gte: DEPLOY } }] }, orderBy: { createdAt: "asc" }, select: sel });
  const relabelled = await prisma.revisionBrief.findMany({ where: { createdAt: { lt: DEPLOY }, analyzedAt: { lt: DEPLOY }, itemsJson: { contains: "\"medium\"" } }, orderBy: { createdAt: "asc" }, select: sel });
  const briefs = [...recent, ...relabelled];
  let nItems = 0, nLabelled = 0, nQuestions = 0, moved = 0;

  for (const b of briefs) {
    let doc: Doc = {};
    try { doc = JSON.parse(b.itemsJson ?? "{}") as Doc; } catch { doc = {}; }
    const items = Array.isArray(doc.items) ? doc.items : [];
    nItems += items.length;
    nLabelled += items.filter((it) => typeof it.medium === "string").length;
    const back = items.filter((it) => (it.medium === "photo" || it.medium === "both") && OLD_PHOTO.test(M.itemWords(it)) && !M.namesPhotos(M.itemWords(it)));
    const photoQs = (doc.photoQuestions ?? []).map((q) => String(q ?? "").trim()).filter(Boolean);
    nQuestions += photoQs.length + (doc.questions ?? []).length;
    const qBack = photoQs.filter((q) => oldQuestionMedium(q) === "photo" && M.itemMediumOf(q) !== "photo");
    if (!back.length && !qBack.length) continue;
    moved += back.length + qBack.length;

    console.log(`BRIEF ${b.id} (${ET(b.createdAt)}) · ${b.project?.title ?? b.projectId} · ${b.project?.client?.name ?? "?"}`);
    console.log(`  message: "${one(b.originalText, 200)}"`);
    for (const it of back) console.log(`  1. item ${it.id}: ${it.medium} → video  "${one(M.itemWords(it), 140)}"`);
    for (const q of qBack) console.log(`  1. question: photo side → video side  "${one(q, 140)}"`);

    const backIds = new Set(back.map((it) => it.id));
    const next: Doc = {
      ...doc,
      items: items.map((it) => (backIds.has(it.id) ? { ...it, medium: "video" } : it)),
      questions: [...(doc.questions ?? []), ...qBack],
      photoQuestions: photoQs.filter((q) => !qBack.includes(q)),
    };
    // Asks filed from this brief: the ids it recorded, and the keys it would use.
    const fileIds = new Set(doc.photoAsks?.ids ?? []);
    const asks = await prisma.clientAsk.findMany({
      where: { OR: [{ id: { in: [...fileIds] } }, { dedupeKey: `${M.PHOTO_SHARED_KEY_PREFIX}${b.id}` }, { dedupeKey: { startsWith: `${M.PHOTO_OFFICE_KEY_PREFIX}${b.projectId}:` }, createdAt: { gte: b.createdAt } }] },
      select: { id: true, state: true, dedupeKey: true, text: true, summary: true, medium: true },
    });
    const stillPhoto = items.filter((it) => !backIds.has(it.id) && it.medium !== "video");
    const keptQs = next.photoQuestions ?? [];
    const asksToSetAside = asks.filter((a) => a.state === "OPEN" && !stillPhoto.some((it) => (a.summary ?? a.text).includes(it.ask.slice(0, 40))) && !keptQs.some((q) => (a.summary ?? a.text).includes(q.slice(0, 40))));
    console.log(`  2. revisionIssues.ingestBriefItems: the editor gets ${back.length} item(s)`);
    console.log(`  3. creativeReview.routeCreativeReview: ${qBack.length ? `${qBack.length} question(s) back on the video side` : "re-read (nothing new to ask)"}`);
    for (const a of asks) console.log(`  4. ask ${a.id} [${a.state}] ${a.dedupeKey ?? "-"}: ${asksToSetAside.includes(a) ? `set aside, "${WHY}"` : "left as it is (it still carries photo work, or is already closed)"}  "${one(a.summary ?? a.text, 120)}"`);
    if (!asks.length) console.log("  4. no photo ask was filed from it");
    const pj = await prisma.photoJob.findUnique({ where: { projectId: b.projectId }, select: { id: true, stage: true, stageChangedAt: true } });
    if (pj) console.log(`  photo job ${pj.id}: ${pj.stage} since ${ET(pj.stageChangedAt)} (not touched; a person decides if it was reopened by mistake)`);

    if (APPLY) {
      await prisma.revisionBrief.update({ where: { id: b.id }, data: { itemsJson: JSON.stringify(next) } });
      const { ingestBriefItems } = await import("@/lib/revisionIssues");
      const n = await ingestBriefItems(b.id);
      const { routeCreativeReview } = await import("@/lib/creativeReview");
      const cr = await routeCreativeReview(b.id);
      const { markNotNeeded } = await import("@/lib/clientAsks");
      for (const a of asksToSetAside) console.log(`     ask ${a.id}: ${(await markNotNeeded(a.id, BY, WHY)).message}`);
      console.log(`     written: ${n} editor issue(s) on the brief; creative review ${cr?.state ?? "none"}`);
    }
    console.log("");
  }

  // Asks filed straight from a message since the deploy, whose photo medium came from the old words.
  const recentAsks = await prisma.clientAsk.findMany({ where: { createdAt: { gte: DEPLOY }, medium: { in: ["photo", "both"] }, state: "OPEN" }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, text: true, summary: true, dedupeKey: true, medium: true } });
  const askBack = recentAsks.filter((a) => !(a.dedupeKey ?? "").startsWith(M.PHOTO_OFFICE_KEY_PREFIX) && !(a.dedupeKey ?? "").startsWith(M.PHOTO_SHARED_KEY_PREFIX) && oldAskMedium(a.text) === "photo" && askMedium(a.text) !== "photo");
  for (const a of askBack) {
    moved++;
    console.log(`ASK ${a.id} (${ET(a.createdAt)}) medium ${a.medium}: the old words read photo, now ${askMedium(a.text)}  "${one(a.summary ?? a.text, 140)}"`);
    console.log(`  set aside, "${WHY}" (the message's video change is raised from the message itself; check the job's work order)`);
    if (APPLY) {
      const { markNotNeeded } = await import("@/lib/clientAsks");
      console.log(`  ${(await markNotNeeded(a.id, BY, WHY)).message}`);
    }
  }

  console.log(`scanned: ${briefs.length} work order(s) (${recent.length} created or analysed since ${ET(DEPLOY)} ET, ${relabelled.length} older with labels), ${nItems} item(s) (${nLabelled} labelled), ${nQuestions} question(s); ${recentAsks.length} open photo ask(s) filed since then`);
  if (!moved) console.log("nothing to move back: no item, question or ask was labelled photo by the words the fix removed");
  else console.log(APPLY ? `moved back: ${moved}` : `would move back: ${moved}. Nothing was written. Run with --apply to write it.`);
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
