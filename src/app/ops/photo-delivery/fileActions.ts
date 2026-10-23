"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import type { LotDrawing } from "@/lib/photoDelivery/lotLines";

// ---------------------------------------------------------------------------
// LOT LINES, AN UPLOADED REPLACEMENT, PHOTOS ADDED BY HAND: THE SERVER
// ACTIONS (Oct 22 2026, lib/photoDelivery/hubFiles.ts).
//
// Like editActions.ts: a server action is a public POST, so EVERY export
// calls requireAdmin first (owner or Kyle, never a "view as" preview and
// never the creative manager's view-only desk), and every answer is
// { ok, message } in plain words. Nothing here sends anything anywhere and
// nothing costs AutoHDR credits: Update on Aryeo stays a person's press.
// (Downloads are a GET route: /api/photo-delivery/download/<photoId>.)
// ---------------------------------------------------------------------------

export type FileActionResult = { ok: boolean; message: string };

const BASE = "/ops/photo-delivery";
const ID = /^[A-Za-z0-9_-]{6,64}$/;

const denied = (e: unknown): FileActionResult => ({ ok: false, message: (e as Error)?.message || "You don't have access to do that." });
const failed = (what: string, e: unknown): FileActionResult => {
  console.error(`[photo-delivery] ${what} failed`, e);
  return { ok: false, message: `That didn't go through (${what}). Reload the page to see what is saved, then try again.` };
};

async function actor(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return "staff";
  return (me.realName || me.name || me.email || "staff").slice(0, 120);
}

function refresh(jobId: string) {
  revalidatePath(BASE);
  revalidatePath(`${BASE}/${jobId}`);
  revalidatePath(`${BASE}/${jobId}/review`);
}

/** The 06-Ready-for-Aryeo folder follows a new version or a new photo (its fingerprint is the set and each version), after the answer. */
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

/** What the Lot lines tool opens on: the picture to draw on and the last drawing for this photo. */
export async function loadLotLinesAction(jobId: string, photoId: string): Promise<FileActionResult & { previewUrl: string | null; drawing: LotDrawing | null; current: boolean; baseHash: string | null }> {
  const none = { previewUrl: null, drawing: null, current: false, baseHash: null };
  try {
    await requireAdmin();
  } catch (e) {
    return { ...denied(e), ...none };
  }
  if (!ID.test(String(jobId)) || !ID.test(String(photoId))) return { ok: false, message: "That photo id is not valid.", ...none };
  try {
    const { loadLotLines } = await import("@/lib/photoDelivery/hubFiles");
    const { prisma } = await import("@/lib/prisma");
    const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { jobId: true } });
    if (!photo || photo.jobId !== jobId) return { ok: false, message: "That photo is not on this job. Reload the page.", ...none };
    return await loadLotLines(photoId);
  } catch (e) {
    return { ...failed("open the lot lines", e), ...none };
  }
}

/** Save the lot lines: drawn on the full-size photo on the server, the photo's new current version. */
export async function saveLotLinesAction(input: { jobId: string; photoId: string; baseHash: string | null; drawing: LotDrawing }): Promise<FileActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.jobId)) || !ID.test(String(input.photoId))) return { ok: false, message: "That photo id is not valid." };
  try {
    const by = await actor();
    const { saveLotLines } = await import("@/lib/photoDelivery/hubFiles");
    const r = await saveLotLines({ jobId: input.jobId, photoId: input.photoId, baseHash: input.baseHash ?? null, drawing: input.drawing, by });
    if (r.ok) {
      refresh(input.jobId);
      refillReady(input.jobId, by);
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("save the lot lines", e);
  }
}

/** Replace a photo with the file Kyle uploaded (stored.pathname): its new current version. */
export async function replaceWithUploadAction(input: { jobId: string; photoId: string; baseHash: string | null; stored: { pathname: string }; fileName: string }): Promise<FileActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.jobId)) || !ID.test(String(input.photoId))) return { ok: false, message: "That photo id is not valid." };
  try {
    const by = await actor();
    const { replaceWithUpload } = await import("@/lib/photoDelivery/hubFiles");
    const r = await replaceWithUpload({ jobId: input.jobId, photoId: input.photoId, baseHash: input.baseHash ?? null, stored: { pathname: String(input.stored?.pathname ?? "") }, fileName: String(input.fileName ?? ""), by });
    if (r.ok) {
      refresh(input.jobId);
      refillReady(input.jobId, by);
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("replace the photo", e);
  }
}

/**
 * Add the photos Kyle uploaded to the job's gallery, at the end of the
 * delivery order. Oct 23 2026 (huddle item 7): `addOn` + `nextTo`, the
 * finished versions of virtual staging or lot lines done outside the hub,
 * each right after its original (never replacing it).
 */
export async function addPhotosAction(input: { jobId: string; files: { pathname: string; fileName: string }[]; addOn?: string | null; nextTo?: (string | null)[] | null }): Promise<FileActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.jobId)) || !Array.isArray(input.files)) return { ok: false, message: "That job id is not valid." };
  const addOn = input.addOn == null ? null : String(input.addOn);
  if (addOn != null && !/^[a-z_]{3,40}$/.test(addOn)) return { ok: false, message: "That add-on is not one the hub knows." };
  const nextTo = Array.isArray(input.nextTo) ? input.nextTo.slice(0, input.files.length).map((x) => (typeof x === "string" && ID.test(x) ? x : null)) : null;
  try {
    const by = await actor();
    const { addPhotosByHand } = await import("@/lib/photoDelivery/hubFiles");
    const r = await addPhotosByHand({ jobId: input.jobId, files: input.files.map((f) => ({ pathname: String(f?.pathname ?? ""), fileName: String(f?.fileName ?? "") })), by, addOn, nextTo });
    if (r.ok) {
      refresh(input.jobId);
      refillReady(input.jobId, by);
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("add the photos", e);
  }
}
