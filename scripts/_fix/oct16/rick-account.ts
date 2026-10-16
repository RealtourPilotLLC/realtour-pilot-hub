// LIVE (Oct 16 2026). Jordan: "make sure ricks settings are correct on our end
// and make sure hes on a normal account not trial, also make sure his
// onboarding email went out."
//   1. No monthly strategy calls (a bulk plan: his scripts are written).
//   2. Off the trial: the August trial's billing terms are cleared (the
//      package price is Jordan's to enter on the owner billing panel), notes
//      say what the program is now.
//   3. Onboarding through the hub's own routine (autoOnboarding): his portal
//      account at his email on file, the client's features on, and the
//      welcome email (the bulk-plan welcome) sent once.
// Dry run by default; --apply writes and sends.
export {};
const ENROLLMENT = "cmt7n9kdl000w9kunldguh6hl";
const RICK = "cmqiks8n7003j9k9qj43v4ti1";
const BY = "info@realtourpilot.com (Oct 16 ask, set by Claude)";
async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("@/lib/prisma");
  const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: ENROLLMENT } });
  if (e.clientId !== RICK) throw new Error("mismatch");
  console.log(`now: ${e.status} ${e.programKind} billing ${e.billingType} ${e.billingMonths}mo callMode ${e.callMode ?? "(derived)"} notes "${e.notes}"`);
  const notes = "Bulk plan: 48 videos, 8 a session, weekly from Tue Oct 20 2026 (Plan › Bulk plan). His own script bank. No monthly strategy calls. Billing terms: enter the package price.";
  const { autoOnboardClient } = await import("@/lib/autoOnboarding");
  if (!apply) {
    const r = await autoOnboardClient(RICK, BY, { sendWelcome: true, dryRun: true });
    console.log("onboarding would:", r.steps.map((s) => `${s.key}: ${s.status}`).join(" · "));
    console.log("DRY RUN — re-run with --apply");
    await prisma.$disconnect();
    return;
  }
  const ch = await import("@/lib/enrollmentChanges");
  await ch.setCallMode(ENROLLMENT, "NOT_INCLUDED", false, BY, "Bulk plan: his scripts are written; no monthly strategy calls");
  if (e.billingType === "TRIAL") await ch.setBillingTerms(ENROLLMENT, { type: null, rate: null, months: null }, BY);
  await ch.setWorkflowFlags(ENROLLMENT, { notes }, BY);
  const after = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: ENROLLMENT } });
  console.log(`set: ${after.status} ${after.programKind} billing ${after.billingType ?? "none on file"} callMode ${after.callMode} notes "${after.notes}"`);
  const r = await autoOnboardClient(RICK, BY, { sendWelcome: true });
  console.log("onboarding:", r.outcome, r.reason ?? "", "| seat:", r.seatEmail);
  for (const s of r.steps) console.log("  ", s.key, s.status, "|", s.detail.slice(0, 220));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
