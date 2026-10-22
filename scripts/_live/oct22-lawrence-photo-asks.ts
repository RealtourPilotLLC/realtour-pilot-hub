// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, 859 N Lawrence St, Joseph Sutow).
//
// Jordan: "Joe Sutow texted about a video revision, then texted about virtual
// staging in photos. The photo staging issue is showing up on the video
// review room. It should not be."
//
// His 5:07 PM and 5:09 PM texts ("are they able to virtually stage the upper
// patio. Now pic 38" / "Outdoor furniture, fire pit table, plants?") were
// read as video work orders written before items said what they are about,
// so the photo-38 staging questions opened creative review cards in the Video
// Review Room. This puts them where the app now puts them (lib/itemMedium,
// lib/briefPhotoAsks), with the app's own functions:
//   1. labelBriefMedia: each item says video or photo, photo questions move
//      off the video side;
//   2. creativeReview.routeCreativeReview: a card with nothing about the
//      video left closes (its task cancelled); a card with a video question
//      keeps only that one (the Cafe La Maude sign);
//   3. routeBriefPhotoAsks: the photo-38 staging (not on the order) becomes
//      ONE open question for Jordan or Kyle on the photo job's asks; the pic
//      11 restaging is already an open ask there and is left as it is. The
//      photo job is already reopened, so it and Kyle's task are not touched.
// Only briefs that mention the photos are changed. Nothing messages anyone.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-lawrence-photo-asks.ts
// Write it:
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-lawrence-photo-asks.ts --apply
// (the preload stubs next/navigation, which lib/clientAsks reaches through
// lib/auth/user; it leaves scripts/_live connected to the real database)
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

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { labelBriefMedia, routeBriefPhotoAsks } = await import("@/lib/briefPhotoAsks");
  const { routeCreativeReview, openCreativeReviews } = await import("@/lib/creativeReview");
  const { creativeReviewOf } = await import("@/lib/creativeReviewCore");
  const { isPhotoOnly } = await import("@/lib/itemMedium");

  const project = await prisma.project.findFirst({
    where: { title: { startsWith: "859 N Lawrence St" }, client: { name: "Joseph Sutow" } },
    select: { id: true, title: true },
  });
  if (!project) throw new Error("859 N Lawrence St (Joseph Sutow) not found");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: ${project.title} (${project.id})\n`);

  const before = await openCreativeReviews(project.id);
  console.log(`Video Review Room now: ${before.length} creative review card(s)`);
  for (const r of before) console.log(`  · ${r.briefId} ${r.createdAtISO}: ${r.questions.map((q) => `"${one(q, 110)}"`).join(" | ")}`);
  console.log("");

  const briefs = await prisma.revisionBrief.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, originalText: true, itemsJson: true } });
  const plannedKeys = new Map<string, string>(); // key → the summary it will carry
  const stillOpen: { briefId: string; questions: string[] }[] = [];
  for (const b of briefs) {
    const l = await labelBriefMedia(b.id, { dryRun: true });
    if (!l) continue;
    const photoItems = l.items.filter((it) => isPhotoOnly(it));
    const cr = creativeReviewOf(b.itemsJson);
    console.log(`BRIEF ${b.id} (${b.createdAt.toISOString()}): "${one(b.originalText, 120)}"`);
    if (photoItems.length === 0 && l.photoQuestions.length === 0) {
      console.log("  about the video only: left as it is");
      if (cr?.state === "OPEN") stillOpen.push({ briefId: b.id, questions: cr.questions });
      console.log("");
      continue;
    }
    console.log("  1. label the items:");
    for (const it of l.items) console.log(`     ${it.id} ${it.medium.padEnd(5)} ${one(it.ask, 110)}`);
    for (const q of l.questions) console.log(`     question stays with the video: "${one(q, 120)}"`);
    for (const q of l.photoQuestions) console.log(`     question moves to the photo job: "${one(q, 120)}"`);

    // 2. What the creative review does with the labelled row (routeCreativeReview's rule).
    const doc = JSON.parse(l.itemsJson) as { items: { held?: boolean; medium?: string }[] };
    const heldVideo = doc.items.filter((it) => it.held && !isPhotoOnly(it)).length;
    const stays = l.questions.length > 0 || heldVideo > 0;
    if (cr?.state === "OPEN") {
      console.log(stays
        ? `  2. creative review card stays open with only the video: ${l.questions.map((q) => `"${one(q, 90)}"`).join(" | ") || `${heldVideo} held video item(s)`}`
        : `  2. creative review card closes: nothing about the video is left on it (task ${cr.taskId} cancelled)`);
    } else {
      console.log("  2. no open creative review card on this one");
    }
    if (stays && cr?.state === "OPEN") stillOpen.push({ briefId: b.id, questions: l.questions });

    // 3. The photo part, as routeBriefPhotoAsks would file it.
    const plan = await routeBriefPhotoAsks(b.id, { dryRun: true, itemsJson: l.itemsJson, afterDelivery: false });
    if (!plan || plan.steps.length === 0) console.log("  3. nothing new for the photo job");
    for (const s of plan?.steps ?? []) {
      const earlier = s.action === "create" ? plannedKeys.get(s.key) : undefined;
      const action = earlier !== undefined ? "append (to the question created just above; adds this message's words)" : s.action === "exists" ? `exists already (${s.askId}), left as it is` : s.action === "append" ? `append to open ask ${s.askId}` : "create";
      // The line the ask will carry (routeBriefPhotoAsks' append rule: "<before>. Then they asked: <this message>").
      const summary = earlier !== undefined ? `${/[.?!]$/.test(earlier) ? earlier : `${earlier.replace(/[;:,]+$/, "")}.`} Then they asked: ${s.core}` : s.summary;
      if (s.action === "create") plannedKeys.set(s.key, summary);
      const label = s.what === "office" ? "Question for Jordan or Kyle" : s.what === "shared" ? "Client asked (both / not clear)" : "Client asked";
      console.log(`  3. photo job ask [${s.what}] ${action}\n       key ${s.key}\n       "${label}: ${one(summary, 260)}"`);
    }
    for (const e of plan?.echoes ?? []) console.log(`     (not filed again, said in an earlier message: "${one(e, 90)}")`);

    if (APPLY) {
      await labelBriefMedia(b.id);
      const st = await routeCreativeReview(b.id);
      const done = await routeBriefPhotoAsks(b.id, { afterDelivery: false });
      console.log(`  APPLIED: creative review ${st ? `${st.state} (${st.questions.length} question(s))` : "closed"}; photo job asks ${(done?.steps ?? []).map((s) => `${s.what}:${s.action}:${s.askId}`).join(", ") || "none"}`);
    }
    console.log("");
  }

  if (APPLY) {
    const after = await openCreativeReviews(project.id);
    console.log(`Video Review Room after: ${after.length} card(s)`);
    for (const r of after) console.log(`  · ${r.briefId}: ${r.questions.map((q) => `"${one(q, 110)}"`).join(" | ")}`);
    const asks = await prisma.clientAsk.findMany({ where: { projectId: project.id, state: "OPEN" }, orderBy: { askedAt: "asc" }, select: { id: true, medium: true, summary: true, dedupeKey: true } });
    console.log(`Photo job open asks after: ${asks.length}`);
    for (const a of asks) console.log(`  · ${a.id} ${a.medium} ${a.dedupeKey}: ${one(a.summary, 160)}`);
  } else {
    console.log(`Video Review Room would show: ${stillOpen.length} card(s)`);
    for (const r of stillOpen) console.log(`  · ${r.briefId}: ${r.questions.map((q) => `"${one(q, 110)}"`).join(" | ")}`);
    console.log("\nNothing was written. Run with --apply to write it.");
  }
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
