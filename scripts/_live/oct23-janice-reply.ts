// Live one-off (Oct 23 2026): Jordan approved this reply to Janice Pigga's portal message (later filming time). --apply sends.
import { prisma } from "@/lib/prisma";
import { postStaffMessage } from "@/lib/programMessages";
const E = "cmue43gsi0044k404p9zwxruh";
const JORDAN = { id: "cmqv2zj7d00009kxlx2puezph", name: "Jordan Spackman", email: "info@realtourpilot.com" };
const BODY = `Hi Janice, thanks so much for reaching out! For a 4-hour session, 2:30 PM is our latest start time right now. With the sun setting before 7 PM, that keeps beautiful natural light for the whole session.

Whenever you're ready, you can grab a time that works for you in your portal under Your Month. There are openings up to 2:30 PM on Monday, Nov 2, Wednesday, Nov 4, Thursday, Nov 5 and Friday, Nov 6.

A model home alongside Steel Stacks sounds wonderful! Once you hear back from the development, you can add the address right in your portal and we'll plan around both spots.`;
(async () => {
  const q = await prisma.programMessage.findFirst({ where: { enrollmentId: E, authorKind: "CLIENT" }, orderBy: { createdAt: "desc" }, select: { id: true, body: true } });
  console.log("replying to:", q?.body.slice(0, 80));
  if (process.argv.includes("--apply")) console.log(await postStaffMessage(E, JORDAN, BODY, q?.id ?? null));
  await prisma.$disconnect();
})();
