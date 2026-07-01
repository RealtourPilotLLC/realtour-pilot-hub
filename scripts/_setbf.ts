import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
(async () => {
  const p = await prisma.project.findUnique({ where: { id: "cmqiks4q600079k9ql5px79zt" }, select: { clientId: true, client: { select: { name: true, brandAssetsPath: true } } } });
  console.log("client:", p?.client?.name, "| before:", p?.client?.brandAssetsPath);
  await prisma.client.update({ where: { id: p!.clientId }, data: { brandAssetsPath: "/AutoHDR/Clients/Jamie Adler/Brand Assets" } });
  console.log("set temp brandAssetsPath");
  await prisma.$disconnect();
})();
