// Live one-off (Oct 21 2026, Jordan: "We need to respond to her and let her
// know her brand discovery call is scheduled"). Answers Kristen Pavillard's
// portal message "Am I suppose to have a branding call First?" as Jordan.
// Dry run unless --apply.
import { prisma } from "@/lib/prisma";
import { postStaffMessage } from "@/lib/programMessages";

const ENROLLMENT = "cmve60q460003jn0702c8rfgd";
const JORDAN = { id: "cmqv2zj7d00009kxlx2puezph", name: "Jordan Spackman", email: "info@realtourpilot.com" };
const BODY = "Yes! Your brand discovery call comes first, and you're all set for Thursday, October 29 at 10 AM. We'll get to know your brand and goals, then build your content strategy from there. No need to book a shoot or a strategy call before then.";
const apply = process.argv.includes("--apply");

(async () => {
  const q = await prisma.programMessage.findFirst({ where: { enrollmentId: ENROLLMENT, authorKind: "CLIENT" }, orderBy: { createdAt: "desc" }, select: { id: true, body: true, createdAt: true } });
  const already = await prisma.programMessage.findFirst({ where: { enrollmentId: ENROLLMENT, authorKind: "STAFF", body: BODY } });
  console.log("replying to:", q?.createdAt.toISOString(), JSON.stringify(q?.body), already ? "(ALREADY REPLIED)" : "");
  if (apply && !already) console.log(await postStaffMessage(ENROLLMENT, JORDAN, BODY, q?.id ?? null));
  await prisma.$disconnect();
})();
