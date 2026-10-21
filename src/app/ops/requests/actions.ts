"use server";

import { revalidatePath } from "next/cache";
import { authEnforced, requireCutReviewer } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { CHECKLIST_PATH } from "@/lib/homeAnchors";

// ---------------------------------------------------------------------------
// CLIENT ASK ACTIONS (Oct 19 2026, lib/clientAsks). Pressed from Kyle's
// Special requests and Scheduling screens, the Review Room card and the photo
// job page. A server action is a public POST, so every export guards first:
// owner/admin or a named review seat (requireCutReviewer: the same people who
// may approve a cut may confirm what the client asked for), never "view as".
// Every answer is { ok, message } in plain words; nothing throws to the page.
// ---------------------------------------------------------------------------

export type AskActionResult = { ok: boolean; message: string };

const ID = /^[A-Za-z0-9_-]{6,64}$/;

async function who(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return authEnforced() ? "staff" : "Owner";
  return (me.realName || me.name || me.email || "staff").slice(0, 120);
}

async function guard(): Promise<AskActionResult | null> {
  try {
    await requireCutReviewer();
    return null;
  } catch (e) {
    return { ok: false, message: (e as Error)?.message || "You don't have access to do that." };
  }
}

async function refresh(id?: string) {
  // /ops/requests and /ops/scheduling only redirect now; the asks live on the
  // list and on Shoots (audit A20).
  revalidatePath(CHECKLIST_PATH);
  revalidatePath("/jobs");
  revalidatePath("/");
  if (!id) return;
  const { prisma } = await import("@/lib/prisma");
  const row = await prisma.clientAsk.findUnique({ where: { id }, select: { projectId: true } }).catch(() => null);
  if (row?.projectId) {
    revalidatePath(`/review/${row.projectId}`);
    revalidatePath(`/projects/${row.projectId}`);
    revalidatePath("/ops/photo-delivery", "layout");
  }
}

const failed = (what: string, e: unknown): AskActionResult => {
  console.error(`[client-asks] ${what} failed`, e);
  return { ok: false, message: `That didn't go through (${what}). Reload the page to see what is saved, then try again.` };
};

export async function confirmAskAction(id: string, note?: string | null): Promise<AskActionResult> {
  const refused = await guard();
  if (refused) return refused;
  if (!ID.test(id)) return { ok: false, message: "That ask is no longer here. Reload the page." };
  try {
    const { markConfirmed } = await import("@/lib/clientAsks");
    const r = await markConfirmed(id, await who(), typeof note === "string" ? note : null);
    await refresh(id);
    return r;
  } catch (e) {
    return failed("confirm", e);
  }
}

export async function doneAskAction(id: string): Promise<AskActionResult> {
  const refused = await guard();
  if (refused) return refused;
  if (!ID.test(id)) return { ok: false, message: "That ask is no longer here. Reload the page." };
  try {
    const { markDone } = await import("@/lib/clientAsks");
    const r = await markDone(id, await who());
    await refresh(id);
    return r;
  } catch (e) {
    return failed("done", e);
  }
}

export async function notNeededAskAction(id: string, reason?: string | null): Promise<AskActionResult> {
  const refused = await guard();
  if (refused) return refused;
  if (!ID.test(id)) return { ok: false, message: "That ask is no longer here. Reload the page." };
  try {
    const { markNotNeeded } = await import("@/lib/clientAsks");
    const r = await markNotNeeded(id, await who(), typeof reason === "string" ? reason : null);
    await refresh(id);
    return r;
  } catch (e) {
    return failed("not needed", e);
  }
}

export async function reopenAskAction(id: string): Promise<AskActionResult> {
  const refused = await guard();
  if (refused) return refused;
  if (!ID.test(id)) return { ok: false, message: "That ask is no longer here. Reload the page." };
  try {
    const { reopenAsk } = await import("@/lib/clientAsks");
    const r = await reopenAsk(id, await who());
    await refresh(id);
    return r;
  } catch (e) {
    return failed("reopen", e);
  }
}

export async function assignAskJobAction(id: string, projectId: string): Promise<AskActionResult> {
  const refused = await guard();
  if (refused) return refused;
  if (!ID.test(id) || !ID.test(projectId)) return { ok: false, message: "Pick the job it is for." };
  try {
    const { assignAskProject } = await import("@/lib/clientAsks");
    const r = await assignAskProject(id, projectId, await who());
    await refresh(id);
    return r;
  } catch (e) {
    return failed("pick the job", e);
  }
}

export async function addAskAction(input: { projectId: string; text: string; medium: string; holdsDelivery: boolean }): Promise<AskActionResult> {
  const refused = await guard();
  if (refused) return refused;
  if (!input || !ID.test(input.projectId ?? "")) return { ok: false, message: "Pick the job it is for." };
  try {
    const { addAskByHand } = await import("@/lib/clientAsks");
    const r = await addAskByHand({ projectId: input.projectId, text: String(input.text ?? "").slice(0, 2000), medium: input.medium, holdsDelivery: input.holdsDelivery !== false, by: await who() });
    await refresh();
    if (r.ok) {
      revalidatePath(`/review/${input.projectId}`);
      revalidatePath(`/projects/${input.projectId}`);
    }
    return r;
  } catch (e) {
    return failed("add", e);
  }
}
