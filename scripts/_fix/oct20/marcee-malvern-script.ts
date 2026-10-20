// ---------------------------------------------------------------------------
// Oct 20 2026 — Marcee McMullen's October video "Why I Think Malvern Is One of
// the Most Underrated Towns Near Philadelphia" had TWO scripts: the call
// path's (cmvflpdsi…, placeholders) and, 10 seconds later, a second draft from
// her written answer under a made-up title, "Why Buyers Who Skip Malvern Are
// Often Making a Mistake" (cmvflpltr…). She had pasted her whole answer into
// the first question. Jordan: "We just need one script ... I want this to be
// the script for that video."
//
//   · Jordan's script goes on the original script as a new MANUAL version
//     (editScriptVersion) and is approved as Jordan (approveScriptVersion).
//     NOT released to the portal: that is Jordan's button (it can email her).
//   · The duplicate draft (never shared, nothing else points at it) is
//     removed with its versions, the way the hub removes its own drafts
//     (scriptUpload.stepAsideSystemDrafts) — after a backup of every row.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct20/marcee-malvern-script.ts          # dry run
//   ... same ... --apply
// ---------------------------------------------------------------------------
import fs from "node:fs";

const KEEP = "cmvflpdsi0002jt084xfp7yib";
const DUPLICATE = "cmvflpltr0006jt08updocmel";
const TOPIC = "cmv74em720014i706ojmax9mu";
const JORDAN = "info@realtourpilot.com";
const BACKUP = "/Users/jordanspackman/RTP-backups/marcee-malvern-script-2026-10-20.json";

const PARTS = {
  title: "Why I Think Malvern Is One of the Most Underrated Towns Near Philadelphia",
  categoryLabel: "Local Lifestyle & Market Authority",
  hook: "Malvern has a bit of an identity crisis.\nAnd I think that's actually its biggest advantage.",
  points: [
    { role: "re-hook" as const, text: "Because what if I told you that you could have the best of Chester County AND the Main Line in one place?" },
    { role: "build-up" as const, text: "You've got coffee shops, restaurants, and a train station along King Street.\nPlus quieter, wooded neighborhoods with room to spread out." },
    { role: "payoff" as const, text: "It's that combination of small-town charm, open space, and convenient connections to Philadelphia that makes Malvern so special." },
  ],
  close: "Malvern isn't caught between two worlds.\nIt brings them together.\nAnd that's exactly why it deserves a spot on your list.",
  captionCta: "Considering a move to Malvern or the surrounding Chester County communities? Message me and let's find the right fit.",
};

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../../src/lib/prisma");
  const [keep, dup, topic] = await Promise.all([
    prisma.contentScript.findUnique({ where: { id: KEEP } }),
    prisma.contentScript.findUnique({ where: { id: DUPLICATE } }),
    prisma.contentTopic.findUnique({ where: { id: TOPIC } }),
  ]);
  if (!keep || keep.topicId !== TOPIC) throw new Error("The script to keep is not where it was.");
  const refs = dup
    ? {
        suggestions: await prisma.scriptSuggestion.count({ where: { scriptId: DUPLICATE } }),
        releases: await prisma.contentScriptRelease.count({ where: { scriptId: DUPLICATE } }),
        videos: await prisma.contentVideo.count({ where: { scriptId: DUPLICATE } }),
        matches: await prisma.contentScriptMatch.count({ where: { scriptId: DUPLICATE } }),
      }
    : null;
  console.log("keep:", keep.id, keep.status, keep.title);
  console.log("duplicate:", dup ? `${dup.id} ${dup.status} shared=${!!dup.sharedVersionId} "${dup.title}"` : "already gone", refs ? JSON.stringify(refs) : "");
  if (dup && (dup.topicId !== TOPIC || dup.sharedVersionId || dup.approvedVersionId || dup.videoId)) throw new Error("The duplicate is not a plain unshared draft any more — stopping.");
  if (refs && (refs.suggestions || refs.releases || refs.videos || refs.matches)) throw new Error("Something points at the duplicate — stopping.");

  if (!apply) {
    console.log("\nDRY RUN. Would: back up both scripts, their versions and the topic; add Jordan's script as a new version on the kept script and approve it (not released); remove the duplicate draft.");
    return;
  }

  // 1 · the backup, before anything is written.
  const backup = {
    at: new Date().toISOString(),
    keep, keepVersions: await prisma.contentScriptVersion.findMany({ where: { scriptId: KEEP } }),
    duplicate: dup, duplicateVersions: dup ? await prisma.contentScriptVersion.findMany({ where: { scriptId: DUPLICATE } }) : [],
    topic,
  };
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 1));
  console.log("backup:", BACKUP);

  // 2 · Jordan's script as the next version, keeping the filming notes and her answer as the source.
  const { editScriptVersion, approveScriptVersion, partsFromVersionRow } = await import("../../../src/lib/contentScripts");
  const base = keep.currentVersionId ? await prisma.contentScriptVersion.findUnique({ where: { id: keep.currentVersionId } }) : null;
  const carried = base ? partsFromVersionRow(base) : null;
  const v = await editScriptVersion(KEEP, {
    ...PARTS,
    pillarId: keep.pillarId ?? carried?.pillarId ?? null,
    filmingNotes: carried?.filmingNotes ?? null,
    sourceExcerpts: carried?.sourceExcerpts,
  }, JORDAN, "Jordan's script for this video (Oct 20 2026), from Marcee's written answer");
  console.log("new version:", v.versionNo, v.versionId);
  await approveScriptVersion(v.versionId, { email: JORDAN }, "Jordan wrote this one from Marcee's answer (Oct 20 2026).");
  console.log("approved (not released to the portal)");

  // 3 · the duplicate draft, gone the way the hub removes its own drafts.
  if (dup) {
    await prisma.contentScriptVersion.deleteMany({ where: { scriptId: DUPLICATE } });
    await prisma.contentScript.deleteMany({ where: { id: DUPLICATE } });
    console.log("removed the duplicate draft");
  }
  await prisma.contentTopicEvent.create({ data: { topicId: TOPIC, enrollmentId: keep.enrollmentId, monthId: keep.monthId, kind: "EDITED", actorKind: "STAFF", staffUserId: JORDAN, sourceRef: `ContentScriptVersion:${v.versionId}`, note: "One script for this video: Jordan's, approved Oct 20 2026. A duplicate draft from the written answers was removed (backup on file)." } });

  const after = await prisma.contentScript.findMany({ where: { topicId: TOPIC, monthId: keep.monthId, historical: false }, select: { id: true, status: true, title: true, approvedVersionId: true, sharedVersionId: true, body: true } });
  console.log("\nscripts for this video now:", after.length);
  for (const s of after) console.log(s.id, s.status, `shared=${!!s.sharedVersionId}`, "\n" + s.body);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
