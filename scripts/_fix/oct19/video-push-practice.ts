// ---------------------------------------------------------------------------
// LIVE (Oct 19 2026): the listing-video Aryeo push goes to Practice run
// (shadow): each approved video's row says what the hub WOULD upload and
// re-deliver; nothing is sent to Aryeo or Uploadcare. Step 1 of the rollout
// Jordan was told (Practice run → Upload only for the first real video →
// Upload and deliver). --apply writes; default prints the current setting.
// ---------------------------------------------------------------------------
export {};
const APPLY = process.argv.includes("--apply");
// Oct 19 evening: Jordan chose a button (no automatic mode), so --off sets it back to off.
const MODE = process.argv.includes("--off") ? "off" : "shadow";
async function main() {
  const { videoDeliverySettings, saveVideoDeliverySettings } = await import("@/lib/videoDeliverySettings");
  console.log("now:", JSON.stringify(await videoDeliverySettings()));
  if (APPLY) console.log("saved:", JSON.stringify(await saveVideoDeliverySettings({ aryeoPush: MODE }, MODE === "off" ? "Claude for Jordan (Oct 19: button only, no automatic mode)" : "Claude for Jordan (Oct 19 rollout, step 1)")));
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
