// ---------------------------------------------------------------------------
// LIVE, Oct 30 2026. Jordan: "Yes restart Mike's clock and close the stale
// windows".
//
// 1. Mike Flatley's two revised videos reached his portal Oct 28 and he was
//    first told Oct 30 2:01 PM (the past-month fix, 2c03987d): both review
//    clocks restart from now, so he has his full four business days. The old
//    deadline is kept in originalDeadlineAt. Nothing is sent.
// 2. Eleven review windows from Sep 24 to Oct 12 that were never announced
//    and never settled. Every one is a cut Jordan or Kyle already delivered
//    outside the portal (Aryeo, Mark as sent): the portal shows the video as
//    Delivered and the job page as Sent. They are settled the way the expiry
//    sweep settles any such window (expiryOutcome SENT_OUTSIDE_PORTAL): no
//    task and no automatic approval can come from them, and the window stays
//    OPEN so the client can still ask for changes.
//
//   dry run:  NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct30-flatley-clock-and-stale-reviews.ts
//   apply:    … --apply
//   undo:     … --undo   (the stale windows only; a restarted clock is not wound back)
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { restartReviewClock } from "@/lib/reviewWindows";

const UNDO = path.resolve(__dirname, "oct30-flatley-clock-and-stale-reviews.undo.json");
const BY = "claude: for Jordan";
const FLATLEY = ["cmvs3ap5a004djt07uylwf4me", "cmvs3d5hd004rjt07w6br0pwb"]; // Video 4 r3, Video 2 r2
const STALE = [
  "cmug6ppdb0003k304n4hxguu3", "cmulg8ohy0006gm0ama3ctv9v", "cmv5bnms3005kl90682gtcwpi", // Rick Schultz
  "cmv6t8hai0055ku06ryv4zdxu", "cmv6t8hcb0056ku063sr7fgw0", "cmv6t8he50057ku06lbc64siu", // John Collins
  "cmv6t8h8g0054ku0641pxfsqn", // Bernadette Rabel
  "cmug8olt50003lb045jh8rqjo", // Mike Flatley, September version
  "cmv6t8h3b0052ku06bed5uwp1", // Mike Ciunci, Video 1
  "cmupjion80005l204arjaurwh", "cmurf39c7000bjs04jxiu9i3d", // Sarina Spinelli (program ended)
];

async function main() {
  const apply = process.argv.includes("--apply"), undo = process.argv.includes("--undo");
  if (undo) {
    const ids = JSON.parse(fs.readFileSync(UNDO, "utf8")) as string[];
    const r = await prisma.contentReviewWindow.updateMany({ where: { id: { in: ids }, state: "OPEN", expiryOutcome: "SENT_OUTSIDE_PORTAL" }, data: { expiryOutcome: null } });
    console.log(`undone: ${r.count} window(s)`);
    return;
  }

  for (const id of FLATLEY) {
    const w = await prisma.contentReviewWindow.findUniqueOrThrow({ where: { id }, select: { round: true, state: true, deadlineAt: true, clientNotifiedAt: true } });
    console.log(`${apply ? "RESTART" : "plan   "} Flatley r${w.round} ${w.state}, due ${w.deadlineAt.toISOString()}, told ${w.clientNotifiedAt?.toISOString() ?? "never"}`);
    if (apply) console.log("        ", (await restartReviewClock(id, BY)).message);
  }

  const ws = await prisma.contentReviewWindow.findMany({ where: { id: { in: STALE } }, select: { id: true, state: true, expiryOutcome: true, clientNotifiedAt: true, submissionId: true } });
  const sent = new Set((await prisma.reviewSubmission.findMany({ where: { id: { in: ws.map((w) => w.submissionId) }, sentToClientAt: { not: null } }, select: { id: true } })).map((s) => s.id));
  const settle = ws.filter((w) => w.state === "OPEN" && !w.expiryOutcome && !w.clientNotifiedAt && sent.has(w.submissionId)).map((w) => w.id);
  for (const w of ws) if (!settle.includes(w.id)) console.log(`skip    ${w.id}: ${w.state} ${w.expiryOutcome ?? ""} ${sent.has(w.submissionId) ? "" : "not sent"}`);
  console.log(`${apply ? "SETTLE " : "plan   "} ${settle.length} of ${STALE.length} stale window(s) as sent outside the portal`);
  if (!apply) { console.log("\nDry run. Pass --apply."); return; }

  fs.writeFileSync(UNDO, JSON.stringify(settle, null, 2));
  const r = await prisma.contentReviewWindow.updateMany({ where: { id: { in: settle }, state: "OPEN", expiryOutcome: null }, data: { expiryOutcome: "SENT_OUTSIDE_PORTAL" } });
  await prisma.auditLog.create({ data: { actor: "claude:oct30-flatley-clock-and-stale-reviews", action: "review_windows_settled", target: "ContentReviewWindow", detail: `Flatley clocks restarted (${FLATLEY.length}); ${r.count} stale window(s) settled SENT_OUTSIDE_PORTAL` } }).catch(() => {});
  console.log(`settled ${r.count}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
