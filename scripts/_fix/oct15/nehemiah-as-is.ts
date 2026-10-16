// LIVE (Oct 15 2026). Jordan: "I want to focus on removing things from
// properties where they took the time to prepare, not the ones that are dumps
// like Nehemiah's shoots." Nehemiah Lindo goes on the Photo Delivery as-is
// list (clutter is not checked or fixed on his shoots; trash, cars, camera
// mistakes and warps still are). Undo: Photo Delivery settings › As-is clients.
export {};
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { photoDeliverySettings, savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
  const nehemiah = await prisma.client.findFirstOrThrow({ where: { name: "Nehemiah Lindo" }, select: { id: true } });
  const cur = await photoDeliverySettings();
  if (cur.asIsClientIds.includes(nehemiah.id)) { console.log("already on the as-is list"); return; }
  const next = await savePhotoDeliverySettings({ asIsClientIds: [...cur.asIsClientIds, nehemiah.id] }, "info@realtourpilot.com (Jordan's Oct 15 ask, set by Claude)");
  console.log("as-is clients now:", next.asIsClientIds);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
