import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  const ET = "America/New_York";
  const key = now.toLocaleDateString("en-CA", { timeZone: ET });
  console.log("NOW", now.toISOString(), "ET day", key);

  // Upcoming shoots (next 14 days) — check gaps
  const upcoming = await prisma.project.findMany({
    where: { shootDate: { gte: new Date(Date.now() - 3 * 86400000), lt: new Date(Date.now() + 14 * 86400000) }, status: { notIn: ["CANCELLED", "ON_HOLD"] } },
    select: {
      id: true, title: true, status: true, shootDate: true, source: true,
      aryeoOrderId: true, aryeoListingId: true, lat: true, lng: true,
      dropboxFolder: true,
      photographer: { select: { name: true } },
      client: { select: { name: true } },
      deliverables: { select: { type: true, label: true } },
      appointments: { select: { description: true, status: true, startAt: true } },
      orderItems: { select: { title: true, quantity: true } },
    },
    orderBy: { shootDate: "asc" },
  });
  console.log("\n=== UPCOMING/RECENT SHOOTS (-3d .. +14d):", upcoming.length);
  for (const p of upcoming) {
    const gaps: string[] = [];
    if (!p.photographer) gaps.push("NO-PHOTOG");
    if (!p.appointments.map(a => a.description?.trim()).find(Boolean)) gaps.push("NO-ACCESS-BRIEF");
    if (p.deliverables.length === 0) gaps.push("NO-DELIVERABLES");
    if (p.lat == null || p.lng == null) gaps.push("NO-COORDS(no weather/airspace)");
    if (!p.dropboxFolder) gaps.push("NO-DROPBOX");
    console.log(
      `${p.shootDate?.toISOString().slice(0,16)} | ${p.status.padEnd(9)} | ${(p.title||"").slice(0,34).padEnd(34)} | ${(p.photographer?.name??"-").padEnd(12)} | dl=${p.deliverables.map(d=>d.type).join(",")||"-"} | ${gaps.join(" ")}`
    );
  }
}
main().finally(() => prisma.$disconnect());
