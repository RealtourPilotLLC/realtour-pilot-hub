import type { Prisma } from "@prisma/client";
import { notOwnerPrivateWhere } from "@/lib/ownerPrivateTasks";

/** `hideOwnerPrivate`: the reader is not the owner, so the books-audit items
 *  and pay questions stay off the list (lib/ownerPrivateTasks). */
export type TaskClientScope = { excludeClientIds?: string[]; hideOwnerPrivate?: boolean };

/** Match either durable link; preserve tasks with no linked client or job. */
export function taskClientScopeWhere(opts: TaskClientScope = {}): Prisma.SmartTaskWhereInput {
  const ids = opts.excludeClientIds;
  const AND: Prisma.SmartTaskWhereInput[] = ids?.length ? [
    { OR: [{ clientId: null }, { clientId: { notIn: ids } }] },
    { OR: [{ projectId: null }, { project: { clientId: { notIn: ids } } }] },
  ] : [];
  if (opts.hideOwnerPrivate) AND.push(notOwnerPrivateWhere());
  return AND.length ? { AND } : {};
}
