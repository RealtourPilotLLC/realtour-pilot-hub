export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026). Jordan's answers to the audit summary:
//   5 · Olivia Vecere's Oct 21 Sussex change request never reached an editor:
//       "Notify Kyle and give him instructions."
//   6 · Nehemiah Lindo's premium shoot: "Kyle is working on it - notify Kyle
//       and tell him Monday at 3:30PM is our soonest Availability."
//   2 · "Harrison is scheduled for Adams appointment at 11, James has an
//       appointment at 1PM with Mike flatley": the "Double-booked? James
//       Livingston — Erica Walker" task is not a double booking.
// The two tasks go through the hub's own "task for Kyle" action
// (day/actions.createTaskForKyle, as Jordan: Kyle's queue plus the Slack line
// "Jordan added a task for you"). The double-booked task gets Jordan's words
// as a note, then is dismissed "not needed" (actions.dismissTask).
// "Sussex" is 1337 Carolannes Way (Olivia's links open "1337 Carolannes Way …
// Premium Cinematic Film - Video 1/2" on our media site). No dollar amounts.
// Dry run by default (prints what it would do); --apply writes and posts.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const APPLY = process.argv.includes("--apply");
const DOUBLE_BOOKED = "cmvk1off000039kk5xtt2klg3";

const TASKS = [
  {
    title: "Sharra Mercer's Sussex videos: get Olivia's final changes to the editor",
    dueDate: "2026-10-23",
    detail: [
      "Olivia Vecere (Sharra Mercer's assistant) emailed on Oct 21 with what should be the final change request for the Sussex new construction videos. Jordan replied on Oct 22 that the team is on it, but it never reached an editor.",
      "Why it got stuck: the hub filed her email under Mike Flatley by mistake, and these two videos were never uploaded to the hub's review room, so there was nothing to send an edit request on. That is the \"I can't send edit requests for Sussex\" problem.",
      "",
      "The videos: 1337 Carolannes Way, West Chester (Sharra Mercer's Aug 18 job), \"Premium Cinematic Film\" Video 1 and Video 2 on Aryeo.",
      "",
      "The changes:",
      "1. Video 1: the people are still a bit glitchy. Slow them down in the kitchen clip and in the bedroom clip with the built-in bunk beds.",
      "2. Video 2: the same house is used twice. Replace the first time it appears with footage of 34 Oakland Rd from Monday's shoot (Oct 19). Olivia's email has a screenshot of the spot.",
      "",
      "What to do:",
      "1. Send these two changes to the editor who cut the Sussex videos, with the 34 Oakland Rd raw footage from Oct 19 and Olivia's screenshot (her Oct 21 email, subject \"New construction videos for Sussex\").",
      "2. When the revised versions come back, check them, put them on the 1337 Carolannes Way listing in Aryeo in place of Video 1 and Video 2, and email Olivia and Sharra the links. No Dropbox links to clients.",
      "3. Mark this done once Olivia has them.",
    ].join("\n"),
  },
  {
    title: "Nehemiah Lindo: offer Monday 3:30 PM for the premium shoot at 5 Endlich Ave",
    dueDate: "2026-10-23",
    detail: [
      "Nehemiah wants a premium package (video with him on camera, photos, drone, floor plan) at 5 Endlich Ave, Reading, PA 19606, as soon as possible.",
      "Last night we told him we were trying for Saturday and would get back to him this afternoon at the latest.",
      "",
      "From Jordan: Monday (Oct 26) at 3:30 PM is our soonest availability.",
      "",
      "What to do:",
      "1. Text Nehemiah today and offer Monday at 3:30 PM.",
      "2. He also asked about another package deal, so confirm which package he wants.",
      "3. Once he says yes, book it in Aryeo and confirm the time with him.",
    ].join("\n"),
  },
];
const DOUBLE_NOTE = "Jordan, Oct 23: not a double booking. Harrison has Adam Feine's 11 AM at 871 N Marshall St. James has Erica Walker 8:30 AM to 12:30 PM at 877 S York Dr, then Mike Flatley at 1 PM at 658 W Ridge Pike. Erica's booking stays as is.";

let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };
  console.log(`=== ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  for (const t of TASKS) {
    const dup = await prisma.smartTask.findFirst({ where: { title: t.title.slice(0, 140) }, select: { id: true, status: true } });
    console.log(`\nTASK FOR KYLE (due ${t.dueDate}): ${t.title}${dup ? `  [already exists: ${dup.id} ${dup.status}]` : ""}\n${t.detail}`);
    if (!APPLY || dup) continue;
    const { createTaskForKyle } = await import("../../src/app/day/actions");
    console.log(`→ ${JSON.stringify(await createTaskForKyle(t))}`);
  }
  const db = await prisma.smartTask.findUnique({ where: { id: DOUBLE_BOOKED }, select: { id: true, title: true, status: true } });
  console.log(`\nDOUBLE-BOOKED TASK: ${db?.title} [${db?.status}] → note + dismiss "not needed"\n  note: ${DOUBLE_NOTE}`);
  if (APPLY && db && !["COMPLETED", "CANCELLED"].includes(db.status)) {
    const { addTaskNote } = await import("../../src/app/projects/messageActions");
    console.log(`→ note: ${JSON.stringify(await addTaskNote(DOUBLE_BOOKED, DOUBLE_NOTE))}`);
    const { dismissTask } = await import("../../src/app/actions");
    console.log(`→ dismiss: ${JSON.stringify(await dismissTask(DOUBLE_BOOKED, "not needed"))}`);
  }
  if (!APPLY) console.log("\nDRY RUN: nothing written, nothing posted. Re-run with --apply.");
  await prisma.$disconnect();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
