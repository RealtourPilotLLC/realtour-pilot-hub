// Live one-off (Oct 22 2026, Jordan: "I don't want photo jobs automatically
// going out"). Turns off the only automatic photo delivery (same-day orders
// approving themselves, Oct 15) so every job waits for Kyle's approval, and
// re-queues 615 Cliff Ln's job for the next sync (the board read the earlier
// visit's delivery as the whole job's). --apply writes.
import { prisma } from "@/lib/prisma";
import { photoDeliverySettings, savePhotoDeliverySettings } from "@/lib/photoDelivery/settings";
const CLIFF_JOB = "cmvik1csg000tjt07jbfs79zs";
(async () => {
  const s = await photoDeliverySettings();
  console.log("sameDayAutoDeliver:", s.sameDayAutoDeliver, "→ false");
  if (process.argv.includes("--apply")) {
    await savePhotoDeliverySettings({ sameDayAutoDeliver: false }, "Jordan (Oct 22 2026: no photo job goes out automatically) via Claude");
    await prisma.photoJob.update({ where: { id: CLIFF_JOB }, data: { nextCheckAt: new Date() } });
    console.log("applied; now:", (await photoDeliverySettings()).sameDayAutoDeliver);
  }
  await prisma.$disconnect();
})();
