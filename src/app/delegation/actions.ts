"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import {
  acceptTask, actorFor, assignTask, cancelTask, completeTask, escalateTask, flagBlocker, LOCAL_OWNER_ACTOR, reassignTask, requestUpdate, returnForChanges,
  submitForVerification, updateTask, type Actor, type AssignInput,
} from "@/lib/delegation";

// ---------------------------------------------------------------------------
// DELEGATION ACTIONS (Oct 23 2026): the one set every dashboard calls, so
// Jordan's oversight, James's "Assigned to me" and Kyle's desk act on the
// same SmartTask. lib/delegation holds the rules; these resolve WHO is acting
// from the session (never from the caller's claims) and refuse:
//   · no sign-in (when sign-in is enforced);
//   · the owner's read-only "view as" preview: nothing is written;
//   · editors and photographers assigning work (they accept, update, flag a
//     blocker, submit and complete their own).
// Each returns { ok, message } for the screen to print as it is.
// ---------------------------------------------------------------------------

type Out = { ok: boolean; message: string };

async function actorNow(): Promise<Actor | Out> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    if (authEnforced()) return { ok: false, message: "Please sign in to do that." };
    // Local development with sign-in off acts as the owner (the hub's own rule).
    return LOCAL_OWNER_ACTOR;
  }
  if (me.impersonating) return { ok: false, message: "You're previewing another user. Exit the preview to make changes." };
  return actorFor(me);
}

function refresh() {
  for (const p of ["/", "/tasks", "/day"]) {
    try { revalidatePath(p); } catch { /* outside a request (a drill): nothing to revalidate */ }
  }
}

async function run(fn: (a: Actor) => Promise<Out>): Promise<Out> {
  const a = await actorNow();
  if ("ok" in a) return a;
  try {
    const r = await fn(a);
    if (r.ok) refresh();
    return { ok: r.ok, message: r.message };
  } catch (e) {
    console.warn("delegation action failed", (e as Error)?.message);
    return { ok: false, message: "That didn't go through. Nothing was changed; try again." };
  }
}

export async function assignTaskAction(input: AssignInput): Promise<Out> {
  if (!input || typeof input !== "object") return { ok: false, message: "Nothing to assign." };
  return run(async (a) => {
    if (a.role !== "OWNER" && a.role !== "ADMIN" && a.role !== "CREATIVE_MANAGER") return { ok: false, message: "You can't assign work. Escalate it instead." };
    return assignTask(a, {
      title: String(input.title ?? ""),
      outcome: input.outcome ? String(input.outcome) : undefined,
      assigneeKey: String(input.assigneeKey ?? ""),
      dueAt: input.dueAt ? String(input.dueAt) : undefined,
      needsVerification: input.needsVerification === true,
      sourceTaskId: input.sourceTaskId ? String(input.sourceTaskId) : undefined,
      clientId: input.clientId ? String(input.clientId) : undefined,
      projectId: input.projectId ? String(input.projectId) : undefined,
      sourceHref: input.sourceHref ? String(input.sourceHref) : undefined,
      note: input.note ? String(input.note) : undefined,
    });
  });
}

export async function acceptTaskAction(taskId: string): Promise<Out> {
  return run((a) => acceptTask(a, String(taskId ?? "")));
}

export async function updateTaskAction(taskId: string, note: string): Promise<Out> {
  return run((a) => updateTask(a, String(taskId ?? ""), String(note ?? "")));
}

export async function flagBlockerAction(taskId: string, why: string): Promise<Out> {
  return run((a) => flagBlocker(a, String(taskId ?? ""), String(why ?? "")));
}

export async function submitForVerificationAction(taskId: string, evidence?: string): Promise<Out> {
  return run((a) => submitForVerification(a, String(taskId ?? ""), evidence ? String(evidence) : null));
}

export async function completeTaskAction(taskId: string, evidence?: string): Promise<Out> {
  return run((a) => completeTask(a, String(taskId ?? ""), evidence ? String(evidence) : null));
}

export async function escalateTaskAction(taskId: string, why: string): Promise<Out> {
  return run((a) => escalateTask(a, String(taskId ?? ""), String(why ?? "")));
}

export async function reassignTaskAction(taskId: string, assigneeKey: string): Promise<Out> {
  return run((a) => reassignTask(a, String(taskId ?? ""), String(assigneeKey ?? "")));
}

// ---- the assigner's side, beyond the shared eight ------------------------------------

/** "Request update" / "Follow up": a ping to the assignee, at most hourly. */
export async function requestUpdateAction(taskId: string, note?: string): Promise<Out> {
  return run((a) => requestUpdate(a, String(taskId ?? ""), note ? String(note) : null));
}

/** Verification failed: back to the assignee with what still needs doing. */
export async function returnForChangesAction(taskId: string, why: string): Promise<Out> {
  return run((a) => returnForChanges(a, String(taskId ?? ""), String(why ?? "")));
}

/** No longer needed (the assigner or the owner). */
export async function cancelTaskAction(taskId: string, why: string): Promise<Out> {
  return run((a) => cancelTask(a, String(taskId ?? ""), String(why ?? "")));
}
