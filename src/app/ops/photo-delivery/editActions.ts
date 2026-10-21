"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireAdmin, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import type { StraightenParams } from "@/lib/photoDelivery/straighten";

// ---------------------------------------------------------------------------
// THE PHOTO EDITOR'S SERVER ACTIONS (Oct 21 2026, lib/photoDelivery/photoEdit.ts).
//
// Straighten, keystone and crop in the hub; Update on Aryeo for a photo that
// already sits on the listing; an AI re-edit with Kyle's own words. Like
// actions.ts: a server action is a public POST, so EVERY export calls
// requireAdmin first (owner or Kyle, never a "view as" preview), and every
// answer is { ok, message } in plain words. Nothing here sends anything by
// itself: each one is a person's press. Credits are shown, never dollars.
// ---------------------------------------------------------------------------

export type EditActionResult = { ok: boolean; message: string };

const BASE = "/ops/photo-delivery";
const ID = /^[A-Za-z0-9_-]{6,64}$/;

const denied = (e: unknown): EditActionResult => ({ ok: false, message: (e as Error)?.message || "You don't have access to do that." });
const failed = (what: string, e: unknown): EditActionResult => {
  console.error(`[photo-delivery] ${what} failed`, e);
  return { ok: false, message: `That didn't go through (${what}). Reload the page to see what is saved, then try again.` };
};

async function actor(): Promise<{ by: string; role: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return { by: "staff", role: authEnforced() ? "NONE" : "OWNER" };
  return { by: (me.realName || me.name || me.email || "staff").slice(0, 120), role: me.realRole };
}

function refresh(jobId: string) {
  revalidatePath(BASE);
  revalidatePath(`${BASE}/${jobId}`);
  revalidatePath(`${BASE}/${jobId}/review`);
}

/** The 06-Ready-for-Aryeo folder follows a new version (its fingerprint is the version), after the answer. */
function refillReady(jobId: string, by: string) {
  const refill = async () => {
    const { requestReady, advanceReady, readyProgress } = await import("@/lib/photoDelivery/handoff");
    const had = await readyProgress(jobId).catch(() => null);
    if (!had) return;
    const q = await requestReady(jobId, { by }).catch(() => null);
    if (q?.started) await advanceReady(jobId, { budgetMs: 45_000 }).catch(() => null);
  };
  try {
    after(refill);
  } catch {
    // Outside a request (a script): the cron's next pass refills the folder.
  }
}

/** Auto: the measured lean of the photo's own file, as a turn and a keystone (free). */
export async function measureStraightenAction(jobId: string, photoId: string): Promise<EditActionResult & { rotate: number; keystone: number; lines: number }> {
  const none = { rotate: 0, keystone: 0, lines: 0 };
  try {
    await requireAdmin();
  } catch (e) {
    return { ...denied(e), ...none };
  }
  if (!ID.test(String(jobId)) || !ID.test(String(photoId))) return { ok: false, message: "That photo id is not valid.", ...none };
  try {
    const { measureLean } = await import("@/lib/photoDelivery/photoEdit");
    const r = await measureLean(photoId);
    return { ok: r.ok, message: r.message, rotate: r.rotate, keystone: r.keystone, lines: r.lines };
  } catch (e) {
    return { ...failed("measure", e), ...none };
  }
}

type SaveInput = { jobId: string; photoId: string; baseHash: string | null; baseSize: { width: number; height: number }; params: Partial<StraightenParams>; fixFindingIds: string[] };

/** Save what the browser rendered and uploaded (stored.pathname): it becomes the photo's current version. */
export async function saveStraightenAction(input: SaveInput & { stored: { pathname: string } }): Promise<EditActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.jobId)) || !ID.test(String(input.photoId))) return { ok: false, message: "That photo id is not valid." };
  try {
    const { by } = await actor();
    const { saveHubEdit } = await import("@/lib/photoDelivery/photoEdit");
    const r = await saveHubEdit({ jobId: input.jobId, photoId: input.photoId, baseHash: input.baseHash ?? null, baseSize: input.baseSize, params: input.params ?? {}, by, fixFindingIds: Array.isArray(input.fixFindingIds) ? input.fixFindingIds : [], stored: { pathname: String(input.stored?.pathname ?? "") } });
    if (r.ok) {
      refresh(input.jobId);
      refillReady(input.jobId, by);
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("save the edit", e);
  }
}

/** A device that cannot hold the full picture: the server renders it with the same math, then saves it. */
export async function renderStraightenOnServerAction(input: Omit<SaveInput, "baseSize">): Promise<EditActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.jobId)) || !ID.test(String(input.photoId))) return { ok: false, message: "That photo id is not valid." };
  try {
    const { by } = await actor();
    const { renderHubEdit, saveHubEdit } = await import("@/lib/photoDelivery/photoEdit");
    const out = await renderHubEdit(input.photoId, input.params ?? {});
    const r = await saveHubEdit({ jobId: input.jobId, photoId: input.photoId, baseHash: input.baseHash ?? null, baseSize: { width: out.baseWidth, height: out.baseHeight }, params: input.params ?? {}, by, fixFindingIds: Array.isArray(input.fixFindingIds) ? input.fixFindingIds : [], bytes: out.bytes });
    if (r.ok) {
      refresh(input.jobId);
      refillReady(input.jobId, by);
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("save the edit", e);
  }
}

/** Update on Aryeo: replace these photos on the listing with their hub edit (a person's press; nothing is delivered again). */
export async function updateOnAryeoAction(jobId: string, photoIds: string[]): Promise<EditActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId)) || !Array.isArray(photoIds) || !photoIds.length || !photoIds.every((id) => ID.test(String(id)))) return { ok: false, message: "Those photos are not valid." };
  try {
    const { by } = await actor();
    const { requestListingUpdate, advancePush } = await import("@/lib/photoDelivery/aryeoPush");
    const r = await requestListingUpdate(jobId, photoIds, by);
    if (r.started) {
      const go = () => advancePush(jobId, { budgetMs: 50_000 }).then(() => undefined).catch(() => undefined);
      try {
        after(go);
      } catch {
        void go();
      }
      refresh(jobId);
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("update on Aryeo", e);
  }
}

/** The price of one AI re-edit (credits) and whether this job can run one now. */
export async function reeditQuoteAction(jobId: string): Promise<{ ok: boolean; credits: number | null; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, credits: null, message: denied(e).message };
  }
  if (!ID.test(String(jobId))) return { ok: false, credits: null, message: "That job id is not valid." };
  try {
    const { reeditQuote } = await import("@/lib/photoDelivery/photoEdit");
    const q = await reeditQuote(jobId);
    return { ok: !q.blocker, credits: q.credits, message: q.blocker ?? "" };
  } catch (e) {
    return { ok: false, credits: null, message: failed("price", e).message };
  }
}

/** Kyle's own words as an AI re-edit of one photo, at the price he was shown (the usual approval limits apply). */
export async function customReeditAction(input: { jobId: string; photoId: string; prompt: string; expectCredits: number }): Promise<EditActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.jobId)) || !ID.test(String(input.photoId))) return { ok: false, message: "That photo id is not valid." };
  try {
    const { by, role } = await actor();
    const { requestCustomReedit } = await import("@/lib/photoDelivery/photoEdit");
    const r = await requestCustomReedit({ jobId: input.jobId, photoId: input.photoId, prompt: String(input.prompt ?? ""), by, role, expectCredits: Number(input.expectCredits) });
    if (r.ok) refresh(input.jobId);
    return r;
  } catch (e) {
    return failed("AI re-edit", e);
  }
}
