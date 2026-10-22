// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, comms audit M1). Old photo questions sit in the
// Video Review Room, and two Cafe La Maude cards are duplicates of a fix
// that is already approved.
//
// A. THREE PHOTO QUESTIONS FROM OCT 19 are open as creative reviews (the
//    video lane), written before items said what they are about:
//      · Brandon Dunbar, 22 White Birch Dr: AI out the personal items in the
//        basement, "pic numbers 4,7,8" (no video on the order);
//      · Stephen Kennedy, 212 N Wanamaker St: "the stove please 16 23", the
//        stove in photos 16 and 23 (no video on the order);
//      · Erica Walker, 47 Venuti Dr: a lot line overlay on one of the photos.
//    Each one moves to its photo job with the app's own functions, the same
//    path as scripts/_live/oct22-lawrence-photo-asks.ts:
//      1. its items and open questions are labelled photo. The app's rule
//         (lib/itemMedium, labelBriefMedia) is printed beside it; where the
//         rule would leave a question on the video side (a question that
//         says "no video was ordered", or names the reel only to say the ask
//         is NOT the reel), this script sets the label by id and says so;
//      2. creativeReview.routeCreativeReview: nothing about the video is
//         left, so the card closes and its creative review task is cancelled;
//      3. briefPhotoAsks.routeBriefPhotoAsks (afterDelivery: false): the
//         photo part becomes the job's client asks. Nothing is reopened (these
//         jobs have no photo job row, and each revision task was already
//         marked resolved: the output says when, so Kyle can confirm).
//
// B. TWO DUPLICATE CAFE LA MAUDE CARDS on 859 N Lawrence St (creative review
//    tasks ...nkjietgp and ...6yvznst6) ask which of the two sign appearances
//    to remove. That fix is in version 2, approved, and its issue is
//    VERIFIED. Each closes with creativeReview.resolveCreativeReview, mode
//    NOT_NEEDED: "No change needed: fixed in the approved version."
//    The second card's work order carries the Cafe La Maude item lifted from
//    the earlier text (an echo: its words are not in "Outdoor furniture, fire
//    pit table, plants?"). resolveCreativeReview hands every unheld item to
//    the editor's issue list, which would raise the sign a second time, so
//    that one item is held first and the reviewer's "no change needed"
//    archives it. Its photo items are already on the photo job and stay.
//
// Nothing messages anyone.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-photo-questions-off-video.ts
// Write it:
//   ... scripts/_live/oct22-photo-questions-off-video.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  // A dry run cannot write, whatever the code below does.
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const one = (s: string | null | undefined, n = 150) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const et = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");

const ACTOR = { name: "Hub repair (Oct 22 audit)" };
const NOT_NEEDED_NOTE = "No change needed: fixed in the approved version.";

/** A: the three photo questions. Every item and every open question on each is about the photos. */
const PHOTO_BRIEFS = [
  { briefId: "cmv6ritoq000cl0063vz7aowo", street: "22 White Birch Dr", client: "Brandon Dunbar", items: 1, questions: 1, why: "the order has no video (photos, drone, floor plan)" },
  { briefId: "cmv5vln4v000lif069697qswp", street: "212 N Wanamaker St", client: "Stephen Kennedy", items: 1, questions: 1, why: "the order has no video (photos only)" },
  { briefId: "cmvfcds9k002al508kigii86e", street: "47 Venuti Dr", client: "Erica Walker", items: 1, questions: 3, why: "a lot line overlay on one of the photos; the reel (V1) is named only to say this is not a video task" },
] as const;

/** B: the two Cafe La Maude duplicates (creative review task ids end nkjietgp / 6yvznst6). */
const CAFE_BRIEFS = [
  { briefId: "cmvk15muq000jjj07uyexq819", taskSuffix: "nkjietgp" },
  { briefId: "cmvk1bfao0018l408a8iv5urw", taskSuffix: "6yvznst6" },
] as const;

type Item = { id: string; ask: string; quote?: string | null; medium?: string; held?: boolean; scope?: string; cuts?: string[] | null; kind?: string };
type Doc = { items?: Item[]; questions?: string[]; photoQuestions?: string[]; creativeReview?: { state: string; taskId: string | null; heldItemIds: string[]; questions: string[] }; [k: string]: unknown };

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { labelBriefMedia, routeBriefPhotoAsks } = await import("@/lib/briefPhotoAsks");
  const { routeCreativeReview, resolveCreativeReview, openCreativeReviews } = await import("@/lib/creativeReview");
  const { creativeReviewOf } = await import("@/lib/creativeReviewCore");
  const { isEcho, isPhotoOnly } = await import("@/lib/itemMedium");

  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: comms audit M1\n`);
  let refused = 0;

  // =========================================================================
  console.log("A. THREE PHOTO QUESTIONS OUT OF THE VIDEO REVIEW ROOM\n");
  // =========================================================================
  for (const t of PHOTO_BRIEFS) {
    const b = await prisma.revisionBrief.findUnique({
      where: { id: t.briefId },
      select: { id: true, projectId: true, taskId: true, createdAt: true, originalText: true, itemsJson: true, requestedBy: true, project: { select: { title: true, status: true, client: { select: { name: true } }, deliverables: { where: { removedFromOrderAt: null }, select: { type: true } } } } },
    });
    const doc: Doc = b?.itemsJson ? JSON.parse(b.itemsJson) : {};
    const items = doc.items ?? [];
    const questions = (doc.questions ?? []).map((q) => String(q).trim()).filter(Boolean);
    const cr = creativeReviewOf(b?.itemsJson);
    console.log(`${t.street} · ${t.client} · brief ${t.briefId}`);
    if (!b || !b.project?.title.startsWith(t.street) || b.project.client?.name !== t.client) { console.log("  REFUSED: not the brief expected\n"); refused++; continue; }
    if (cr?.state !== "OPEN") { console.log(`  nothing to do: no open creative review on it (${cr?.state ?? "none"})\n`); continue; }
    if (items.length !== t.items || questions.length !== t.questions) { console.log(`  REFUSED: the work order changed (${items.length} items, ${questions.length} questions; expected ${t.items} and ${t.questions})\n`); refused++; continue; }
    console.log(`  ${b.requestedBy ?? t.client}, ${et(b.createdAt)}: "${one(b.originalText, 200)}"`);
    console.log(`  on the order: ${b.project.deliverables.map((d) => d.type).join(", ")}`);
    const rt = b.taskId ? await prisma.smartTask.findUnique({ where: { id: b.taskId }, select: { status: true, completedAt: true, title: true } }) : null;
    console.log(`  revision task: ${rt ? `${rt.title}, ${rt.status}${rt.completedAt ? ` ${et(rt.completedAt)}` : ""}` : "none"}`);
    const crTask = cr.taskId ? await prisma.smartTask.findUnique({ where: { id: cr.taskId }, select: { id: true, status: true, title: true } }) : null;
    console.log(`  creative review card: open since ${et(new Date(cr.openedAt))}, task ${crTask?.id ?? "none"} (${crTask?.status ?? "?"})`);

    // 1. Labels: what the app's rule says, and what this repair sets.
    const rule = await labelBriefMedia(b.id, { dryRun: true });
    console.log("  1. labels (stored → app rule → this repair):");
    for (const it of items) {
      const r = rule?.items.find((x) => x.id === it.id)?.medium ?? "?";
      console.log(`     item ${it.id}: ${it.medium ?? "none"} → ${r} → photo${r === "photo" ? "" : `  (set by id: ${t.why})`}  "${one(it.ask, 100)}"`);
    }
    for (const q of questions) {
      const ruleSide = rule?.photoQuestions.includes(q) ? "photo" : "video";
      console.log(`     question: video side → ${ruleSide} → photo${ruleSide === "photo" ? "" : `  (set by id: ${t.why})`}  "${one(q, 110)}"`);
    }
    const next: Doc = {
      ...doc,
      items: items.map((it) => ({ ...it, medium: "photo", held: undefined, scope: "unknown", cuts: null })),
      questions: [],
      photoQuestions: [...new Set([...(doc.photoQuestions ?? []), ...questions])],
    };
    const nextJson = JSON.stringify(next);
    console.log(`  2. creative review card closes: nothing about the video is left on it (task ${crTask?.id ?? "none"} cancelled by routeCreativeReview)`);

    // 3. The photo part, as routeBriefPhotoAsks files it.
    const plan = await routeBriefPhotoAsks(b.id, { dryRun: true, itemsJson: nextJson, afterDelivery: false });
    if (!plan || plan.steps.length === 0) console.log("  3. nothing for the photo job");
    for (const s of plan?.steps ?? []) {
      const label = s.what === "office" ? "Question for Jordan or Kyle" : s.what === "shared" ? "Client asked (both / not clear)" : "Client asked";
      console.log(`  3. photo job ask [${s.what}] ${s.action === "create" ? "create" : `${s.action} (${s.askId})`}\n       key ${s.key}\n       "${label}: ${one(s.summary, 260)}"`);
    }
    console.log("     (afterDelivery: false: the job is not reopened; Kyle confirms the ask or sets it aside)");

    if (APPLY) {
      const w = await prisma.revisionBrief.updateMany({ where: { id: b.id, itemsJson: b.itemsJson }, data: { itemsJson: nextJson } });
      if (!w.count) { console.log("  REFUSED: the work order changed while this ran\n"); refused++; continue; }
      const st = await routeCreativeReview(b.id);
      const done = await routeBriefPhotoAsks(b.id, { afterDelivery: false });
      const task = crTask ? await prisma.smartTask.findUnique({ where: { id: crTask.id }, select: { status: true } }) : null;
      console.log(`  APPLIED: creative review ${st ? `still ${st.state} (${st.questions.length} question(s))` : "closed"}, its task ${task?.status ?? "none"}; photo job asks ${(done?.steps ?? []).map((s) => `${s.what}:${s.action}:${s.askId}`).join(", ") || "none"}`);
    }
    console.log("");
  }

  // =========================================================================
  console.log("B. THE TWO CAFE LA MAUDE DUPLICATES ON 859 N LAWRENCE ST\n");
  // =========================================================================
  const lawrence = await prisma.project.findFirst({ where: { title: { startsWith: "859 N Lawrence St" }, client: { name: "Joseph Sutow" } }, select: { id: true, title: true } });
  if (!lawrence) throw new Error("859 N Lawrence St (Joseph Sutow) not found");
  const cuts = await prisma.reviewSubmission.findMany({ where: { projectId: lawrence.id, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } }, orderBy: { round: "asc" }, select: { round: true, status: true, createdAt: true } });
  console.log(`versions: ${cuts.map((c) => `v${c.round} ${c.status} (${et(c.createdAt)})`).join(", ")}`);
  const cafeIssues = await prisma.revisionIssue.findMany({ where: { projectId: lawrence.id, summary: { contains: "Cafe La Maude" } }, select: { id: true, state: true, sourceId: true } });
  console.log(`Cafe La Maude issues: ${cafeIssues.map((i) => `${i.id} ${i.state}`).join(", ") || "none"}`);
  const approved = cuts.some((c) => c.status === "APPROVED") && cafeIssues.length > 0 && cafeIssues.every((i) => i.state === "VERIFIED");
  if (!approved) { console.log("REFUSED: the fix is not approved and verified; leaving both cards for a person\n"); refused++; }

  for (const t of approved ? CAFE_BRIEFS : []) {
    const b = await prisma.revisionBrief.findUnique({ where: { id: t.briefId }, select: { id: true, projectId: true, createdAt: true, originalText: true, itemsJson: true } });
    const doc: Doc = b?.itemsJson ? JSON.parse(b.itemsJson) : {};
    const cr = creativeReviewOf(b?.itemsJson);
    console.log(`brief ${t.briefId} (${b ? et(b.createdAt) : "?"}): "${one(b?.originalText, 140)}"`);
    if (!b || b.projectId !== lawrence.id) { console.log("  REFUSED: not on 859 N Lawrence St\n"); refused++; continue; }
    if (cr?.state !== "OPEN") { console.log(`  nothing to do: creative review is ${cr?.state ?? "gone"}\n`); continue; }
    if (!cr.taskId?.endsWith(t.taskSuffix)) { console.log(`  REFUSED: its task ${cr.taskId} is not the …${t.taskSuffix} card\n`); refused++; continue; }
    if (!cr.questions.every((q) => /Cafe La Maude/i.test(q))) { console.log("  REFUSED: the card asks about more than the Cafe La Maude sign\n"); refused++; continue; }
    console.log(`  card (task ${cr.taskId}): ${cr.questions.map((q) => `"${one(q, 120)}"`).join(" | ")}`);
    const items = doc.items ?? [];
    // What resolveCreativeReview would hand the editor's issue list: unheld video items with no issue yet.
    const fresh: Item[] = [];
    for (const it of items.filter((x) => !x.held && !isPhotoOnly(x))) {
      const has = await prisma.revisionIssue.count({ where: { sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${b.id}:${it.id}:` } } });
      console.log(`  item ${it.id} (${it.medium ?? "video"}): ${has ? "already on the issue list" : "no issue yet"}${isEcho(it.quote, b.originalText) ? "; an echo of an earlier text" : ""}  "${one(it.ask, 90)}"`);
      if (!has) fresh.push(it);
    }
    for (const it of items.filter((x) => isPhotoOnly(x))) console.log(`  item ${it.id} (photo): stays, already on the photo job  "${one(it.ask, 90)}"`);
    const toHold = fresh.filter((it) => isEcho(it.quote, b.originalText) && /Cafe La Maude/i.test(`${it.ask} ${it.quote ?? ""}`));
    if (fresh.length !== toHold.length) { console.log("  REFUSED: it would hand the editor something other than the Cafe La Maude echo\n"); refused++; continue; }
    if (toHold.length) console.log(`  hold ${toHold.map((i) => i.id).join(", ")} first, so "no change needed" archives it instead of raising the sign for the editor again`);
    console.log(`  resolveCreativeReview: NOT_NEEDED, "${NOT_NEEDED_NOTE}" by ${ACTOR.name}; task ${cr.taskId} completed`);
    if (APPLY) {
      if (toHold.length) {
        const ids = new Set(toHold.map((i) => i.id));
        const held: Doc = { ...doc, items: items.map((it) => (ids.has(it.id) ? { ...it, held: true } : it)), creativeReview: { ...doc.creativeReview!, heldItemIds: [...new Set([...(doc.creativeReview?.heldItemIds ?? []), ...ids])] } };
        const w = await prisma.revisionBrief.updateMany({ where: { id: b.id, itemsJson: b.itemsJson }, data: { itemsJson: JSON.stringify(held) } });
        if (!w.count) { console.log("  REFUSED: the work order changed while this ran\n"); refused++; continue; }
      }
      const r = await resolveCreativeReview({ briefId: b.id, mode: "NOT_NEEDED", note: NOT_NEEDED_NOTE, actor: ACTOR });
      const after = await prisma.revisionIssue.count({ where: { sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${b.id}:` }, state: { notIn: ["VERIFIED", "NOT_APPLICABLE", "DUPLICATE"] } } });
      console.log(`  APPLIED: ${r.ok ? r.message : `refused: ${r.message}`}; open editor issues from this brief: ${after}`);
    }
    console.log("");
  }

  const projects = [...new Set([lawrence.id, ...(await prisma.revisionBrief.findMany({ where: { id: { in: PHOTO_BRIEFS.map((p) => p.briefId) } }, select: { projectId: true } })).map((r) => r.projectId)])];
  if (APPLY) {
    for (const pid of projects) {
      const open = await openCreativeReviews(pid);
      const asks = await prisma.clientAsk.findMany({ where: { projectId: pid, state: "OPEN", medium: { in: ["photo", "both", "unclear"] } }, select: { id: true, summary: true } });
      console.log(`after · ${pid}: ${open.length} creative review card(s) open; ${asks.length} open photo ask(s)${asks.length ? `: ${asks.map((a) => `${a.id} "${one(a.summary, 80)}"`).join("; ")}` : ""}`);
    }
  } else {
    for (const pid of projects) {
      const open = await openCreativeReviews(pid);
      console.log(`now · ${pid}: ${open.length} creative review card(s) open (${open.map((o) => o.briefId).join(", ")})`);
    }
    console.log(`\nNothing was written.${refused ? ` ${refused} refused (see above).` : ""} Run with --apply to write it.`);
  }
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
