import "server-only";

import { prisma } from "@/lib/prisma";
import { readyToSend, type ReadyBoard } from "@/lib/readyToSend";
import { isSyntheticClientRow } from "@/lib/testClients";

/** Home and Review Room filter the same delivery sources before their caps.
 * Explicit project views keep access to that job, including a test journey. */
export async function reviewDeliveryBoard(opts: { includeTest: boolean; projectId?: string }): Promise<ReadyBoard> {
  const excludeClientIds = opts.includeTest || opts.projectId ? []
    : (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  return readyToSend({ projectId: opts.projectId, includeNoticeIncidents: true, excludeClientIds });
}
