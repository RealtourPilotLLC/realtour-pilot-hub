// Oct 14 2026, Jordan: "Do a re-edit instruction for each removal-type and I
// would really like to automate the QC and fixes in the most cost effective
// way. I want to make sure we are not spending more than $5-$10 MAX on QC
// fixes per shoot. $5 most of the time. Also places like Nehemiahs shoots that
// are completely unprepared we shouldn't have to do any QC fixes other than
// photographer in the mirror, cars, trash cans, dust spots, or anything camera
// user error related." + "Automatically."
// Turns on the automatic fix plan and the fix runner (the first live paid
// fixes), with the $5 target and $10 maximum, and puts Nehemiah Lindo on the
// as-is list.
import { prisma } from "@/lib/prisma";
import { photoDeliverySettings, savePhotoDeliverySettings } from "@/lib/photoDelivery/settings";
async function main() {
  const clients = await prisma.client.findMany({ where: { name: { contains: "Nehemiah", mode: "insensitive" } }, select: { id: true, name: true } });
  console.log("clients", clients);
  const cur = await photoDeliverySettings();
  const asIs = [...new Set([...cur.asIsClientIds, ...clients.filter((c) => /lindo/i.test(c.name)).map((c) => c.id)])];
  const after = await savePhotoDeliverySettings({ autoFix: true, fixRunnerEnabled: true, fixTargetUsd: 5, fixMaxUsd: 10, autoFixDailyMaxCredits: 100, asIsClientIds: asIs }, "claude (for Jordan, Oct 14)");
  console.log({ autoFix: after.autoFix, fixRunnerEnabled: after.fixRunnerEnabled, fixTargetUsd: after.fixTargetUsd, fixMaxUsd: after.fixMaxUsd, daily: after.autoFixDailyMaxCredits, asIs: after.asIsClientIds });
}
main().finally(() => prisma.$disconnect());
