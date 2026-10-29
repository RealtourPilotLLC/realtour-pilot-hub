import "server-only";
import { prisma } from "@/lib/prisma";
import { listAssignees } from "@/lib/assignees";
import { assignTask, escalateTask, type Actor, type Result } from "@/lib/delegation";

// ---------------------------------------------------------------------------
// SEND TO JORDAN (James call, Oct 28 2026: "Some areas already supported
// escalation to you, while others did not. Give James a clear way to escalate
// relevant issues onto your dashboard").
//
// What existed: Kyle's desk had Escalate on every row (DeskControls HandOn);
// James's desk had it on cuts (escalateCutAction), on tasks delegated to him
// (escalateTask) and on his own tasks (handMyTaskAction). Nowhere else: on a
// job's task cards, a complaint, a photo job or a shoot brief there was no way
// up, and escalateTask itself refuses a task nobody delegated ("Assign it
// first, or ask Jordan directly"), which is most of them.
//
// ONE RULE, THE EXISTING MACHINERY (lib/delegation, no new task system):
//   · a delegated task still open        → escalateTask (it stays with its
//     assignee, flagged "Escalated" on Jordan's dashboard)
//   · a task the sender holds            → assignTask on THAT task to Jordan
//     (the creative manager naming the owner is a decision he decides)
//   · anything else (someone else's task, a complaint, a photo job, a brief)
//                                        → a decision task on Jordan's plate,
//     linked to the record by its page (dedupe "deleg:<href>": sending the same
//     record twice re-uses it)
// The sender's words travel as the reason, and every one of these is flagged
// as a decision (assignTask `decision`), so it sits in "Your decision" on
// Jordan's dashboard whoever sent it. Jordan's own login never sees it.
// ---------------------------------------------------------------------------

export type SendToJordanInput = {
  /** what it is about, as the row names it ("893 S Matlack: Video revision") */
  title: string;
  /** what Jordan needs to decide */
  why: string;
  /** the record's page, where Jordan lands */
  href?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  clientId?: string | null;
};

const CLOSED = new Set(["COMPLETED", "CANCELLED"]);

/** The page a task's decision links to when the caller gave none. Pure. */
export function taskDecisionHref(t: { id: string; projectId: string | null }): string {
  return t.projectId ? `/projects/${t.projectId}#task-${t.id}` : `/tasks?task=${t.id}`;
}

export async function sendToJordan(actor: Actor, input: SendToJordanInput, opts: { now?: Date } = {}): Promise<Result> {
  if (actor.role === "OWNER") return { ok: false, message: "You're the one this goes to. Decide it, reassign it or update it." };
  if (actor.role !== "ADMIN" && actor.role !== "CREATIVE_MANAGER") return { ok: false, message: "Ask Kyle or James to send it up." };
  const why = (input.why ?? "").trim().slice(0, 600);
  if (why.length < 3) return { ok: false, message: "Say what Jordan needs to decide." };
  const title = (input.title ?? "").trim().slice(0, 120) || "A decision";
  const roster = await listAssignees();
  const owner = roster.find((a) => a.kind === "owner")?.key ?? null;
  if (!owner) return { ok: false, message: "There is no owner login to send it to." };

  const t = input.taskId
    ? await prisma.smartTask.findUnique({ where: { id: input.taskId }, select: { id: true, title: true, status: true, assignedKey: true, delegatedAt: true, delegation: true, projectId: true, clientId: true } })
    : null;
  if (input.taskId && !t) return { ok: false, message: "That task no longer exists." };
  if (t && CLOSED.has(t.status)) return { ok: false, message: "That task is already closed." };
  if (t && t.assignedKey === owner) return { ok: true, message: "It's already with Jordan." };

  if (t?.delegatedAt && t.delegation) {
    const r = await escalateTask(actor, t.id, why, opts);
    if (r.ok || !/can't escalate/i.test(r.message)) return r;
  }
  if (t && t.assignedKey && actor.keys.has(t.assignedKey)) {
    return assignTask(actor, { title: t.title.slice(0, 140), assigneeKey: owner, sourceTaskId: t.id, note: why, outcome: why }, { ...opts, decision: true });
  }
  const href = input.href ?? (t ? taskDecisionHref(t) : null);
  return assignTask(actor, {
    title: `Decision: ${title}`.slice(0, 140),
    assigneeKey: owner,
    sourceHref: href,
    projectId: input.projectId ?? t?.projectId ?? null,
    clientId: input.clientId ?? t?.clientId ?? null,
    note: why,
    outcome: why,
  }, { ...opts, decision: true });
}
