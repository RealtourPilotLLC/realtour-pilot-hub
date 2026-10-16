// LIVE (Oct 15 2026): the reviewer's two-part check is required on the server
// too (the Review Room already disables Approve until both are saved). The
// management report: "No project should be delivered until the required checks
// are complete." Undo: putSetting("review_checklist", { enforce: false }).
export {};
async function main() {
  const { putSetting } = await import("@/lib/settings");
  const { reviewChecklistSettings, REVIEW_CHECKLIST_SETTING } = await import("@/lib/reviewChecklist");
  await putSetting(REVIEW_CHECKLIST_SETTING, { enforce: true }, "info@realtourpilot.com (Oct 15 report, set by Claude)");
  console.log("review_checklist now:", await reviewChecklistSettings());
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
