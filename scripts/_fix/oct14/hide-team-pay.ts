// Oct 14 2026 (Jordan): "shut down the my pay for both Harrison and James.
// They should not be seeing their pay anymore on the shoot page or on the my
// pay page. It should just be their performance tracking page. And tracking
// their bonus." Turns the pay-view pause on (Settings' pay_visibility), which
// now covers every login but the owner. Payroll itself is untouched.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/hide-team-pay.ts [--apply]
import { prisma } from "@/lib/prisma";
async function main() {
  const { payVisibilityRules, putSetting } = await import("@/lib/settings");
  const before = await payVisibilityRules();
  console.log("before:", JSON.stringify(before));
  if (!process.argv.includes("--apply")) { console.log("DRY RUN"); return; }
  await putSetting("pay_visibility", { photographerPayPaused: true, pausedAt: new Date().toISOString(), pausedBy: "info@realtourpilot.com" }, "info@realtourpilot.com");
  await prisma.auditLog.create({ data: { actor: "info@realtourpilot.com", action: "pay_visibility", target: "team", detail: "Pay hidden for everyone but the owner; My Pay shows the performance scorecard and bonus (Jordan, Oct 14)" } });
  console.log("after:", JSON.stringify(await payVisibilityRules()));
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
