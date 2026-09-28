"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { PREREQUISITE_KEYS, parsePrerequisites, type PrerequisiteKey } from "@/lib/productPrerequisites";

// ---------------------------------------------------------------------------
// §10 AU-01 phase 2 (Sep 26 2026): what a product needs before it can be made.
// Read by the office (the card shows it to Kyle too); SAVED by the owner only —
// the handoff makes the list Jordan's call, and it changes what lands on
// Kyle's exceptions board. Nothing here blocks a booking or touches an order:
// the list is only ever read by opsExceptions, which only ever reports.
// ---------------------------------------------------------------------------

export async function loadProductPrerequisites(productId: string): Promise<{ ok: boolean; keys: PrerequisiteKey[]; canEdit: boolean; message?: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, keys: [], canEdit: false, message: (e as Error).message };
  }
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { prerequisitesJson: true } }).catch(() => null);
  if (!p) return { ok: false, keys: [], canEdit: false, message: "That product no longer exists." };
  const me = await getCurrentUser().catch(() => null);
  // Local dev (no session) edits like the owner, as every guard does there.
  const canEdit = !me ? true : me.realRole === "OWNER" && !me.impersonating;
  return { ok: true, keys: parsePrerequisites(p.prerequisitesJson), canEdit };
}

export async function saveProductPrerequisites(productId: string, keys: string[]): Promise<{ ok: boolean; message: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, message: "Only Jordan can change what a product needs first." };
  }
  if (!Array.isArray(keys) || keys.length > PREREQUISITE_KEYS.length) return { ok: false, message: "Pick from the list." };
  const known = new Set<string>(PREREQUISITE_KEYS);
  if (keys.some((k) => typeof k !== "string" || !known.has(k))) return { ok: false, message: "Pick from the list." };
  // Stored in the list's own order so two saves of the same set are the same text.
  const clean = PREREQUISITE_KEYS.filter((k) => keys.includes(k));
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, title: true, prerequisitesJson: true } });
  if (!p) return { ok: false, message: "That product no longer exists." };
  const next = clean.length ? JSON.stringify(clean) : null;
  if ((p.prerequisitesJson ?? null) === next) return { ok: true, message: "Nothing changed." };
  await prisma.product.update({ where: { id: productId }, data: { prerequisitesJson: next } });
  revalidatePath("/settings/products");
  revalidatePath("/");
  return {
    ok: true,
    message: clean.length
      ? `Saved. A live job with ${p.title} that is missing any of these shows on Kyle's exceptions — nothing is blocked.`
      : `Saved. ${p.title} needs nothing first.`,
  };
}
