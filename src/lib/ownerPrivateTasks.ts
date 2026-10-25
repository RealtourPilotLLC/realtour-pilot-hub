import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// OWNER-PRIVATE TASKS (audit Oct 25 2026, F7). Two kinds of task are Jordan's
// alone, whoever else can read the board:
//   · the books audit's action items (lib/financeAuditTasks, keyed
//     `finance-audit:<problem>`): "Open a personal checking account and pay
//     yourself a set draw", "Upload Lauren's Venmo statements";
//   · a teammate's pay question from My Pay (app/my-pay/actions flagPay,
//     keyed `payflag-<member>-<job|period>-<period start>`).
// Their titles carry no dollar figure, so the money scrub let them through,
// and Kyle's board, his Slack digests, the Done ledger, a job's open tasks
// and Ask the Hub all listed them. Every list a non-owner reads drops them
// by these keys; the owner's lists are unchanged.
// ---------------------------------------------------------------------------

export const OWNER_PRIVATE_TASK_KEY_PREFIXES = ["finance-audit:", "payflag-"] as const;

/** True for a task only the owner may see (matched on its dedupeKey). */
export function isOwnerPrivateTask(t: { dedupeKey?: string | null }): boolean {
  const k = t.dedupeKey;
  return !!k && OWNER_PRIVATE_TASK_KEY_PREFIXES.some((p) => k.startsWith(p));
}

/** Every task but the owner-private ones. The null branch is load-bearing:
 *  `NOT (dedupeKey LIKE …)` is NULL, not true, on a task with no key, and
 *  would silently drop every one of them. */
export function notOwnerPrivateWhere(): Prisma.SmartTaskWhereInput {
  return {
    OR: [
      { dedupeKey: null },
      { NOT: { OR: OWNER_PRIVATE_TASK_KEY_PREFIXES.map((p) => ({ dedupeKey: { startsWith: p } })) } },
    ],
  };
}
