"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { VIDEO_PUSH_MODES, type VideoPushMode } from "@/lib/videoDeliverySettings";

// ---------------------------------------------------------------------------
// VIDEO DELIVERY SERVER ACTIONS (Oct 19 2026, lib/videoAryeoPush).
//
// A server action is a public POST, so every export checks its guard first:
//   · requireAdmin (Jordan or Kyle): Retry, Deliver now, Hold, Release;
//   · requireOwner (Jordan): the switch.
// The guards read the REAL role and refuse "view as" previews. Every answer
// is { ok, message } in plain words; nothing throws to the page.
// ---------------------------------------------------------------------------

export type ActionResult = { ok: boolean; message: string };

const PATH = "/ops/video-delivery";
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

export async function saveVideoPushModeAction(mode: VideoPushMode): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  if (!(VIDEO_PUSH_MODES as readonly string[]).includes(String(mode))) return { ok: false, message: "That is not a setting the hub knows." };
  try {
    const { saveVideoDeliverySettings, VIDEO_PUSH_MODE_WORDS } = await import("@/lib/videoDeliverySettings");
    const s = await saveVideoDeliverySettings({ aryeoPush: mode }, await actorName());
    refresh();
    return { ok: true, message: `Saved: ${VIDEO_PUSH_MODE_WORDS[s.aryeoPush].label}. ${VIDEO_PUSH_MODE_WORDS[s.aryeoPush].help}` };
  } catch (e) {
    return failed("save the setting", e);
  }
}
