// LIVE (Oct 16 2026). Jordan: "Make sure you didn't overcomplicate the review
// portion of the videos. I want it to be easy. We know what to look for when
// reviewing the video." The two-part checklist is gone from the Review Room,
// so its server gate goes off too: Approve is one press, recorded with who
// and when. (Reverses scripts/_fix/oct15/review-checklist-on.ts.)
export {};
async function main() {
  const { putSetting } = await import("@/lib/settings");
  const { reviewChecklistSettings, REVIEW_CHECKLIST_SETTING } = await import("@/lib/reviewChecklist");
  await putSetting(REVIEW_CHECKLIST_SETTING, { enforce: false }, "info@realtourpilot.com (Oct 16 ask, set by Claude)");
  console.log("review_checklist now:", await reviewChecklistSettings());
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
