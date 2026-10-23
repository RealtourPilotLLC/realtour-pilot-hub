// Live one-off (Oct 23 2026, Jordan: "remove these from Mike Ciunci's account,
// we already did video 1 and 2 for August, they are fixed"). Three stale
// August rows from the review room read "Changes in progress" on Mike's
// portal; August's finished videos (Video 1 - Average Agents Vs Elite Agents,
// Video 2 - Behind the Scenes in Real Estate) are DELIVERED rows of their own.
// ARCHIVED, never deleted: every list and count skips it, the sync leaves an
// archived row archived (contentVideos.ts), and setting status back restores it.
import { prisma } from "@/lib/prisma";
const IDS = ["cmu5oqmdg002j9k8m1xjeva33", "cmu5oqm28002e9k8m3yqdzx5y", "cmu5oqm8d002g9k8mkcfr65tq"]; // Mike video 1 august, Mike's Video 1, Mike's Video 2
(async () => {
  const rows = await prisma.contentVideo.findMany({ where: { id: { in: IDS } }, select: { id: true, title: true, status: true, monthKey: true, clientId: true } });
  for (const r of rows) console.log(r.monthKey, r.status, r.title);
  if (rows.length !== 3 || rows.some((r) => r.clientId !== "cmqiks57u000m9k9qwlgjzfyn" || r.monthKey !== "2026-08")) throw new Error("unexpected rows; nothing changed");
  if (process.argv.includes("--apply")) {
    const u = await prisma.contentVideo.updateMany({ where: { id: { in: IDS }, status: { not: "ARCHIVED" } }, data: { status: "ARCHIVED" } });
    console.log("archived", u.count);
  }
  await prisma.$disconnect();
})();
