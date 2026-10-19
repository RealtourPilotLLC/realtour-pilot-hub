"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// VIDEO DELIVERY SERVER ACTIONS (Oct 19 2026, lib/videoAryeoPush). The
// screen moved into the Video Review Room (/review); its buttons call these
// and src/app/review/videoSendActions.ts. The off/shadow/upload/deliver
// switch is gone from the screens (button only, Oct 19), so its save action
// is gone too.
//
// A server action is a public POST, so every export checks its guard first:
// requireAdmin (Jordan or Kyle): Try again, Deliver now, Hold, Release. The
// guard reads the REAL role and refuses "view as" previews. Every answer is
// { ok, message } in plain words; nothing throws to the page.
// ---------------------------------------------------------------------------

export type ActionResult = { ok: boolean; message: string };

const PATH = "/review";
const ID = /^[A-Za-z0-9_-]{6,64}$/;

function denied(e: unknown): ActionResult {
  return { ok: false, message: (e as Error)?.message || "You don't have access to do that." };
}

async function actorName(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return authEnforced() ? "staff" : "local dev";
  return (me.realName || me.name || me.email || "staff").slice(0, 120);
}

function refresh() {
  revalidatePath(PATH);
  revalidatePath("/");
  revalidatePath("/ops");
}

const failed = (what: string, e: unknown): ActionResult => {
  console.error(`[video-delivery] ${what} failed`, e);
  return { ok: false, message: `That didn't go through (${what}). Reload the page to see what is saved, then try again.` };
};

export async function retryVideoPushAction(submissionId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  try {
    const { retryVideoPush } = await import("@/lib/videoAryeoPush");
    const r = await retryVideoPush(submissionId, await actorName());
    refresh();
    return r;
  } catch (e) {
    return failed("retry", e);
  }
}

export async function deliverVideoNowAction(submissionId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  try {
    const { deliverVideoNow } = await import("@/lib/videoAryeoPush");
    const r = await deliverVideoNow(submissionId, await actorName());
    refresh();
    return r;
  } catch (e) {
    return failed("deliver now", e);
  }
}

export async function holdVideoPushAction(submissionId: string, reason: string | null): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  try {
    const { holdVideoPush } = await import("@/lib/videoAryeoPush");
    const r = await holdVideoPush(submissionId, await actorName(), typeof reason === "string" ? reason : null);
    refresh();
    return r;
  } catch (e) {
    return failed("hold", e);
  }
}

export async function releaseVideoPushAction(submissionId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (typeof submissionId !== "string" || !ID.test(submissionId)) return { ok: false, message: "That video id is not valid." };
  try {
    const { releaseVideoPush } = await import("@/lib/videoAryeoPush");
    const r = await releaseVideoPush(submissionId, await actorName());
    refresh();
    return r;
  } catch (e) {
    return failed("release", e);
  }
}
