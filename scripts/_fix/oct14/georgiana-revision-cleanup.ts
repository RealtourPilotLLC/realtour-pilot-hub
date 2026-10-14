// ---------------------------------------------------------------------------
// FIX (Oct 14 2026, Jordan: "go ahead and fix Georgiana's revisions and notify
// John"). 2625 Wassergass Rd, Georgiana Torrella, the Premium Social Media
// Reel approved (v2) and delivered at 2:45 PM ET. What went wrong after:
//   · she texted the same ask ("don't start the video on this frame of my
//     face") three times, plus a screenshot caption: four separate items;
//   · her real change at 3:39 PM ("swap the seated back-deck clip for the
//     standing version") became a separate PHOTO revision task, so it never
//     reached the video's list;
//   · Jordan's review note "back the first frame up a bit" was resolved and
//     reopened 12 s later, but its item stayed VERIFIED (closed);
//   · Jordan's form text repeated both asks as one more item.
// The fix, through the hub's own functions (revisionIssues.ts):
//   1. reopen the start-frame note's item (the note itself is open);
//   2. fold the three repeated texts and the caption into it (mergeDuplicate);
//   3. fold the form text into the leg note (both its asks are now covered);
//   4. put the standing-take swap on the cut as a review note at 0:52, in her
//      words (ingestReviewNote makes it an item for John);
//   5. close the misfiled photo task, moving its brief to the video task;
//   6. one clean summary on the video task, and one bell to John (bridged to
//      his Slack/text like every editor bell).
// Dry run by default; --apply writes. Idempotent.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";

const APPLY = process.argv.includes("--apply");
const PROJECT = "cmurk6qgh0008l704ic0415xp";
const CUT = "cmv8ch6sa0001lb06hhtsg9n6"; // v2, the approved and delivered version
const VIDEO_TASK = "cmv8i9xr1004mjv06ua79eb16";
const PHOTO_TASK = "cmv8ijv8w0008js068phgrr3i";
const SWAP_BRIEF = "cmv8ijv9x000ajs0677bpoy7m";
const START_NOTE_ISSUE = "ysw6yq";
const LEG_NOTE_ISSUE = "pzxsoe";
const REPEATS = ["0a7yf9", "i7615x", "rkeakm", "66bywe"]; // the start-frame texts + the screenshot caption
const FORM_TEXT = "xpg6we";
const SWAP_TAG = "From Georgiana's text at 3:39 PM";

async function main() {
  const R = await import("@/lib/revisionIssues");
  const actor = { name: "Jordan Spackman (cleanup by Claude)", userId: null };
  const issues = await prisma.revisionIssue.findMany({ where: { projectId: PROJECT }, select: { id: true, state: true, originalText: true } });
  const byTail = (t: string) => {
    const hit = issues.find((i) => i.id.endsWith(t));
    if (!hit) throw new Error(`issue …${t} not found`);
    return hit;
  };
  const start = byTail(START_NOTE_ISSUE), leg = byTail(LEG_NOTE_ISSUE), form = byTail(FORM_TEXT);
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: start-frame item ${start.state}, leg item ${leg.state}, form item ${form.state}`);

  // 1-3. The items.
  if (APPLY) {
    console.log(" reopen start frame:", (await R.reopenIssue(start.id, actor, "The note was reopened; its item had stayed closed.")).message);
    for (const t of REPEATS) console.log(` merge …${t} into the start-frame item:`, (await R.mergeDuplicate(byTail(t).id, start.id, actor)).message);
    console.log(" merge the form text into the leg item:", (await R.mergeDuplicate(form.id, leg.id, actor)).message);
  } else {
    console.log(" would reopen the start-frame item, merge", REPEATS.length, "repeats into it, and the form text into the leg item");
  }

  // 4. The standing-take swap, on the cut at 0:52 in her words.
  const existing = await prisma.mediaNote.findFirst({ where: { projectId: PROJECT, body: { startsWith: SWAP_TAG } }, select: { id: true } });
  const body = `${SWAP_TAG}: “Also I notice they kept the seated version of me speaking on the back deck and we talked about swapping that with the standing version if my leg couldn't be cropped, it looks like it couldn't be cropped but the seated version is still being used. Can we swap that frame with the standing version please?” Swap the seated back-deck clip for the standing take. If the standing take can't work here, crop in so her whole leg is out of frame and move the text to fit.`;
  if (existing) console.log(" swap note already on the cut:", existing.id);
  else if (APPLY) {
    const note = await prisma.mediaNote.create({
      data: { projectId: PROJECT, assetUrl: `/api/review/cut/${CUT}/stream`, assetType: "video", timeSec: 52.5, lane: "EDITOR", kind: "fix", body, status: "OPEN", authorKey: "owner", authorName: "Jordan Spackman (from Georgiana's text)", editorKey: "john" },
    });
    const issueId = await R.ingestReviewNote(note.id);
    console.log(" swap note added at 0:52:", note.id, "item", issueId);
  } else console.log(" would add the swap note at 0:52");

  // 5. The misfiled photo task.
  const photo = await prisma.smartTask.findUnique({ where: { id: PHOTO_TASK }, select: { status: true } });
  if (photo && photo.status !== "CANCELLED" && APPLY) {
    await prisma.revisionBrief.updateMany({ where: { id: SWAP_BRIEF, taskId: PHOTO_TASK }, data: { taskId: VIDEO_TASK } });
    await prisma.smartTask.update({ where: { id: PHOTO_TASK }, data: { status: "CANCELLED", completedAt: new Date(), summary: "Not a photo revision: Georgiana's ask was about the reel (swap the seated back-deck clip for the standing take). Moved into the video revision task." } });
    console.log(" photo task closed, its brief moved to the video task");
  } else console.log(" photo task:", photo?.status, APPLY ? "(left)" : "(would close)");

  // 6. One clean summary, and John hears it once.
  const summary = [
    "Georgiana's changes to the Premium Social Media Reel (v2, delivered today), one list:",
    "1. Opening (0:00): start a beat earlier so it doesn't open on a frame of her face mid-word.",
    "2. Back deck (about 0:52): swap the seated clip for the standing take, as she asked by text.",
    "3. If the standing take can't work there: crop in so her whole leg is out of frame and move the text to fit.",
    "Upload the new version in the Review Room as usual.",
  ].join("\n");
  if (APPLY) {
    await prisma.smartTask.update({ where: { id: VIDEO_TASK }, data: { summary } });
    const { notifyInApp } = await import("@/lib/notify");
    const r = await notifyInApp({
      kind: "revision_raised",
      title: "Revision (one clean list) — 2625 Wassergass Rd · Premium Social Media Reel",
      body: "Georgiana's 3 changes: start a beat earlier (0:00), swap to the standing back-deck take (~0:52), else crop her leg out.",
      href: `/edit/${PROJECT}`,
      targets: [{ roles: ["EDITOR"], userKey: "editor:john", href: `/edit/${PROJECT}` }],
      dedupeKey: "georgiana-wassergass-cleanup-oct14",
    });
    console.log(" John notified:", JSON.stringify(r.bridged), "silenced", r.silenced);
  } else console.log(" would set the task summary and notify John:\n" + summary);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
