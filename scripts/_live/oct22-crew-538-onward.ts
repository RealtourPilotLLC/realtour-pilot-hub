// Live one-off (Oct 22 2026, Jordan: Harrison and James shot Joe Sutow's job
// together and both need the upload page). 538 Onward Ave is Harrison's
// (photographer + appointment), so James is added as the second shooter:
// upload-page access only, never pay/KPIs/alerts (ProjectCrew). --apply writes.
import { prisma } from "@/lib/prisma";
const PROJECT = "cmv8imvz10007l40697tgc80c"; // 538 Onward Ave (Joe Sutow), Oct 21 8 AM
const JAMES = "cmqiiczmn00029k2mfmvdkvff";
(async () => {
  const have = await prisma.projectCrew.findUnique({ where: { projectId_memberId: { projectId: PROJECT, memberId: JAMES } } });
  console.log("already crew:", !!have);
  if (process.argv.includes("--apply") && !have) console.log(await prisma.projectCrew.create({ data: { projectId: PROJECT, memberId: JAMES, addedBy: "Jordan Spackman (via Claude)" } }));
  await prisma.$disconnect();
})();
