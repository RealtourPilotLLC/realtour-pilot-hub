"use server";

import { revalidatePath } from "next/cache";
import { authEnforced, requireCutReviewer } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { CHECKLIST_PATH } from "@/lib/homeAnchors";
import type { MoveChoice, PlaceResult } from "@/lib/requestPlacement";

// ---------------------------------------------------------------------------
// "NOT FOR THIS PROJECT" (Kyle, Oct 28 2026; lib/requestPlacement). The
// presses of components/requests/NotForThisProject and the saved-request
// lists: move a request to another of the client's open projects, keep it for
// their next project, set it aside as not a request, put a saved one on a
// project, and Undo. Guarded like "Checked" (jobs/actions): owner, admin or a
// named review seat, never while previewing someone else. Every answer is
// { ok, message } in plain words; nothing throws to the page.
// ---------------------------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{6,64}$/;

async function who(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return authEnforced() ? "staff" : "Owner";
  return (me.realName || me.name || me.email || "staff").slice(0, 120);
}

async function guard(): Promise<PlaceResult | null> {
  try {
    await requireCutReviewer();
    return null;
  } catch (e) {
    // The shared guard's preview refusal carries an em dash; this surface says it with a comma.
    const { noDashes } = await import("@/lib/text");
    return { ok: false, message: noDashes((e as Error)?.message || "You don't have access to do that.") };
  }
}

/** Every screen that reads a project's requests (cards, briefs, desks, lists). */
function refresh(r: PlaceResult) {
  for (const id of r.projectIds ?? []) {
    revalidatePath(`/projects/${id}`);
    revalidatePath(`/review/${id}`);
    revalidatePath(`/edit/${id}`);
    revalidatePath(`/shoot/${id}`);
    revalidatePath(`/upload/${id}`);
  }
  if (r.clientId) revalidatePath(`/clients/${r.clientId}`);
  revalidatePath("/ops/photo-delivery", "layout");
  revalidatePath("/review");
  revalidatePath("/jobs");
  revalidatePath(CHECKLIST_PATH);
  revalidatePath("/");
}

const failed = (what: string, e: unknown): PlaceResult => {
  console.error(`[request-placement] ${what} failed`, e);
  return { ok: false, message: "That didn't go through. Reload the page to see what is saved, then try again." };
};

/** Where this request can go (the panel the button opens). */
export async function requestPlacementContextAction(askId: string): Promise<{ ok: true; fromProjectId: string; street: string; clientName: string | null; choices: MoveChoice[] } | { ok: false; message: string }> {
  const refused = await guard();
  if (refused) return { ok: false, message: refused.message };
  if (typeof askId !== "string" || !ID.test(askId)) return { ok: false, message: "That request is no longer here. Reload the page." };
  try {
    const { placementContext } = await import("@/lib/requestPlacement");
    return await placementContext(askId);
  } catch (e) {
    const f = failed("context", e);
    return { ok: false, message: f.message };
  }
}

export async function requestNotForProjectAction(input: { askId: string; fromProjectId: string; outcome: "move" | "future" | "dismiss"; toProjectId?: string | null }): Promise<PlaceResult> {
  const refused = await guard();
  if (refused) return refused;
  if (!input || !ID.test(String(input.askId ?? "")) || !ID.test(String(input.fromProjectId ?? ""))) return { ok: false, message: "That request is no longer here. Reload the page." };
  if (!["move", "future", "dismiss"].includes(input.outcome)) return { ok: false, message: "Pick what to do with it." };
  if (input.outcome === "move" && !ID.test(String(input.toProjectId ?? ""))) return { ok: false, message: "Pick the project it is for." };
  try {
    const { takeRequestOffProject } = await import("@/lib/requestPlacement");
    const r = await takeRequestOffProject({ askId: input.askId, fromProjectId: input.fromProjectId, outcome: input.outcome, toProjectId: input.toProjectId ?? null, by: await who() });
    if (r.ok) refresh(r);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("not for this project", e);
  }
}

export async function undoRequestPlacementAction(askId: string): Promise<PlaceResult> {
  const refused = await guard();
  if (refused) return refused;
  if (typeof askId !== "string" || !ID.test(askId)) return { ok: false, message: "That request is no longer here. Reload the page." };
  try {
    const { undoRequestPlacement } = await import("@/lib/requestPlacement");
    const r = await undoRequestPlacement({ askId, by: await who() });
    if (r.ok) refresh(r);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("undo", e);
  }
}

export async function placeSavedRequestAction(askId: string, projectId: string): Promise<PlaceResult> {
  const refused = await guard();
  if (refused) return refused;
  if (typeof askId !== "string" || !ID.test(askId)) return { ok: false, message: "That request is no longer here. Reload the page." };
  if (typeof projectId !== "string" || !ID.test(projectId)) return { ok: false, message: "Pick the project it is for." };
  try {
    const { placeSavedRequest } = await import("@/lib/requestPlacement");
    const r = await placeSavedRequest({ askId, projectId, by: await who() });
    if (r.ok) refresh(r);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("put on a project", e);
  }
}

export async function dismissSavedRequestAction(askId: string): Promise<PlaceResult> {
  const refused = await guard();
  if (refused) return refused;
  if (typeof askId !== "string" || !ID.test(askId)) return { ok: false, message: "That request is no longer here. Reload the page." };
  try {
    const { dismissSavedRequest } = await import("@/lib/requestPlacement");
    const r = await dismissSavedRequest({ askId, by: await who() });
    if (r.ok) refresh(r);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("set aside", e);
  }
}
