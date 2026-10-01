import type { Prisma } from "@prisma/client";

export type TaskClientScope = { excludeClientIds?: string[] };

/** Match either durable link; preserve tasks with no linked client or job. */
export function taskClientScopeWhere(opts: TaskClientScope = {}): Prisma.SmartTaskWhereInput {
  const ids = opts.excludeClientIds;
  return ids?.length ? {
    AND: [
      { OR: [{ clientId: null }, { clientId: { notIn: ids } }] },
      { OR: [{ projectId: null }, { project: { clientId: { notIn: ids } } }] },
    ],
  } : {};
}
