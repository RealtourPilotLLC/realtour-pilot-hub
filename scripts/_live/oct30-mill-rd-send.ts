// ---------------------------------------------------------------------------
// LIVE, Oct 30 2026: 265 Mill Rd (Tim Bonner) version 2, unstuck and sent.
//
// Jordan pressed "Checked, approve and send" on version 2 at 9:46 AM with
// Tim's "Video must follow logical flow" request on screen. The press marked
// checked only the job checklist's requests, which left that one out (asked
// 6:01 PM Oct 29, before the photos' 9:01 PM re-delivery), so the send held
// on it with nothing left to press. Jordan: "Please also fix this so that if
// we approve it, it completes the check and sends ... And then make sure it
// sends." This records the request checked, as his 9:46 AM press meant to;
// the held send carries on by itself once its gate clears (videoAryeoPush).
//
//   dry run:  npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct30-mill-rd-send.ts
//   apply:    … --apply
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { confirmAsksForSend, openAsksHolding } from "@/lib/clientAsks";
import { videoPushRun, videoPushReadiness } from "@/lib/videoAryeoPush";

const PROJECT_ID = "cmvlakwyx0025js08gdp375ok";
const SUBMISSION_ID = "cmvu8riz10001l3088ifc18qf"; // version 2, approved by Jordan 9:46 AM
const BY = "claude: for Jordan (his Checked, approve and send, Oct 30 9:46 AM)";

async function main() {
  const apply = process.argv.includes("--apply");
  const run = await videoPushRun(SUBMISSION_ID);
  console.log("send run:", run ? { state: run.state, mode: run.mode, hold: run.hold, note: run.note } : null);
  console.log("held on:", (await openAsksHolding(PROJECT_ID, "video")).map((a) => a.summary));
  if (!apply) { console.log("\nDry run. Pass --apply to record the request checked."); return; }
  console.log(await confirmAsksForSend(PROJECT_ID, "video", BY));
  console.log("held on now:", (await openAsksHolding(PROJECT_ID, "video")).map((a) => a.summary));
  console.log("readiness:", await videoPushReadiness(SUBMISSION_ID));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
