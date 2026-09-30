import "server-only";

import { prisma } from "@/lib/prisma";
import { readyToSend, type ReadyBoard } from "@/lib/readyToSend";
import { isSyntheticClientRow } from "@/lib/testClients";

/** The Review Room uses the Home delivery reader, then applies its own TEST toggle. */
export async function reviewDeliveryBoard(opts: { includeTest: boolean; projectId?: string }): Promise<ReadyBoard> {
  const board = await readyToSend({ projectId: opts.projectId, includeNoticeIncidents: true });
  if (opts.includeTest || opts.projectId) return board;

  const ids = [...new Set([
    ...board.ready.map((r) => r.projectId),
    ...board.rendering.map((r) => r.projectId),
    ...board.needsFinishing.map((r) => r.projectId),
    ...(board.notTold ?? []).map((r) => r.projectId),
    ...(board.noticeIncidents ?? []).map((r) => r.projectId),
  ])];
  if (!ids.length) return board;
  const projects = await prisma.project.findMany({
    where: { id: { in: ids } },
    select: { id: true, client: { select: { id: true, name: true } } },
  });
  const hidden = new Set(projects.filter((p) => p.client && isSyntheticClientRow(p.client)).map((p) => p.id));
  return {
    ...board,
    ready: board.ready.filter((r) => !hidden.has(r.projectId)),
    rendering: board.rendering.filter((r) => !hidden.has(r.projectId)),
    needsFinishing: board.needsFinishing.filter((r) => !hidden.has(r.projectId)),
    notTold: (board.notTold ?? []).filter((r) => !hidden.has(r.projectId)),
    noticeIncidents: (board.noticeIncidents ?? []).filter((r) => !hidden.has(r.projectId)),
  };
}
