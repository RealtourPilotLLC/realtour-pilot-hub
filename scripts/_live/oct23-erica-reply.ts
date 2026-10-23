// Live one-off (Oct 23 2026): Jordan approved this reply to Erica Walker's portal message. --apply sends.
import { prisma } from "@/lib/prisma";
import { postStaffMessage } from "@/lib/programMessages";
const E = "cmt7h6b0300059kcj990r34x7";
const JORDAN = { id: "cmqv2zj7d00009kxlx2puezph", name: "Jordan Spackman", email: "info@realtourpilot.com" };
const BODY = `Hi Erica, thanks for your patience! The booking issue on our end is fixed, and your October filming is confirmed for Thursday, October 29 at 8:30 AM with James. You'll see it in your portal. If you ever need a different time, you can pick one right there, and early November dates are open too.

Thank you for the "Reverse offers for sellers" idea. We love it! I added it to your November topics. When you have a few minutes, open Your Month in your portal, switch to November, and answer the short questions under that topic. We'll write the script from your answers.`;
(async () => {
  const q = await prisma.programMessage.findFirst({ where: { enrollmentId: E, authorKind: "CLIENT" }, orderBy: { createdAt: "desc" }, select: { id: true, body: true } });
  console.log("replying to:", q?.body.slice(0, 80));
  if (process.argv.includes("--apply")) console.log(await postStaffMessage(E, JORDAN, BODY, q?.id ?? null));
  await prisma.$disconnect();
})();
