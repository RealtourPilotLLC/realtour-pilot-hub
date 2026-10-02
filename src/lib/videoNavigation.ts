import "server-only";
import { prisma } from "@/lib/prisma";

/** Display identities include retired outputs: removing one must not rename
 * another. New outputs append in mint order; no receipt/slot data is changed. */
export async function videoNavigationFor(projectId: string) {
  const rows = await prisma.deliverableOutput.findMany({
    where: { projectId, deliverable: { type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, deliverableId: true, slot: true },
  });
  return new Map(rows.map((row, index) => [`${row.deliverableId}:${row.slot}`, { number: index + 1, total: rows.length }]));
}
