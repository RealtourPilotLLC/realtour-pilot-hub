import type { Prisma } from "@prisma/client";
import { MESSAGE_TASK_TYPES } from "@/lib/queries";
import { recentProjectWhere } from "@/lib/recency";
import { boardVisibleWhere } from "@/lib/triage";
import { taskClientScopeWhere, type TaskClientScope } from "@/lib/taskClientScope";
export { taskClientScopeWhere, type TaskClientScope } from "@/lib/taskClientScope";

export const BOARD_ACTIVE_STATUSES = [
  "OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER",
  "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED",
];

/** One membership rule for Tasks → Other and every Home badge linking to it.
 * Editor assignment, live work, triage and message recency keep their rules. */
export function boardWhere(editorScope: string | null, opts: TaskClientScope = {}): Prisma.SmartTaskWhereInput {
  return {
    status: { in: BOARD_ACTIVE_STATUSES },
    AND: [
      editorScope
        ? { taskType: { notIn: ["client_reply", "comms_followup", "callback"] }, assignedKey: editorScope }
        : boardVisibleWhere(),
      {
        OR: [
          { projectId: null },
          { project: recentProjectWhere() },
          { taskType: { in: MESSAGE_TASK_TYPES } },
        ],
      },
      taskClientScopeWhere(opts),
    ],
  };
}

/** Review Room media-check list, including orphan tasks still owed a check. */
export function photoQcWhere(opts: TaskClientScope = {}): Prisma.SmartTaskWhereInput {
  return {
    taskType: "media_qa",
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    OR: [{ projectId: null }, { project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } } }],
    AND: [taskClientScopeWhere(opts)],
  };
}
