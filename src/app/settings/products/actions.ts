"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

export type MappingInput = {
  types: string[]; // DeliverableType[] — empty = produces nothing (fee/pure add-on)
  addonTypes: string[]; // subset of types that are POST-SHOOT work (per-part kind)
  videoTier: string | null; // standard | premium | personal_branding
  serviceKind?: string; // legacy product-level kind; derived when absent
};

// DRONE_PHOTO / DRONE_VIDEO are mapping-level distinctions (Jordan, Aug 24:
// "drone can be drone video or drone photo") — the parser translates them to
// real deliverable types+labels. Plain DRONE stays valid for older mappings.
const VALID_TYPES = new Set(["PHOTOS", "VIDEO", "SOCIAL_REEL", "DRONE", "DRONE_PHOTO", "DRONE_VIDEO", "FLOORPLAN", "MATTERPORT_3D", "ZILLOW_3D", "TWILIGHT", "VIRTUAL_STAGING", "HEADSHOT", "OTHER"]);

// Save a product's manual mapping, refresh the parser cache, and REPAIR every
// live (non-delivered) project that ordered this product so "the entire
// platform recognizes that" immediately — not on the next sync.
export async function saveProductMapping(
  productId: string,
  input: MappingInput,
): Promise<{ ok: boolean; message: string }> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, title: true } });
  if (!product) return { ok: false, message: "Product not found." };

  const types = input.types.filter((t) => VALID_TYPES.has(t));
  const addonTypes = input.addonTypes.filter((t) => types.includes(t));
  const hasVideo = types.includes("VIDEO") || types.includes("SOCIAL_REEL") || types.includes("DRONE_VIDEO");
  const tier = hasVideo && ["standard", "premium", "personal_branding"].includes(input.videoTier ?? "") ? input.videoTier : null;
  const me = await getCurrentUser().catch(() => null);

  await prisma.product.update({
    where: { id: productId },
    data: {
      mediaTypes: JSON.stringify(types),
      addonTypes: JSON.stringify(addonTypes),
      videoTier: tier,
      // Product-level kind = add-on only when EVERY part is post-shoot work.
      serviceKind: types.length > 0 && addonTypes.length === types.length ? "addon" : "service",
      mappedAt: new Date(),
      mappedBy: me?.email ?? null,
    },
  });

  const { loadManualProductMap } = await import("@/lib/integrations/aryeo");
  await loadManualProductMap(true);
  const repaired = await repairProjectsForProduct(product.title);
  revalidatePath("/settings/products");
  revalidatePath("/editing");
  return {
    ok: true,
    message: repaired.projects
      ? `Saved — ${repaired.projects} live project${repaired.projects === 1 ? "" : "s"} updated (${repaired.added} deliverables added, ${repaired.removed} phantom${repaired.removed === 1 ? "" : "s"} removed).`
      : "Saved — no live projects carry this product right now.",
  };
}

// Rebuild deliverables for NON-DELIVERED projects that ordered this product,
// from their STORED order items (no Aryeo round-trip). Preserves the best
// status per type; only PENDING work can vanish — anything DONE/UPLOADED for
// a type that survives keeps its state. DELIVERED history is never touched.
async function repairProjectsForProduct(title: string): Promise<{ projects: number; added: number; removed: number }> {
  const { deliverablesForTitle, dedupeParsedDeliverables } = await import("@/lib/integrations/aryeo");
  const { standardDeliveryDue } = await import("@/lib/tasks");
  const { isMonthlyContentJob } = await import("@/lib/pipeline");

  const items = await prisma.orderItem.findMany({
    where: { title: { equals: title }, isCanceled: false, project: { status: { notIn: ["DELIVERED", "CANCELLED"] } } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  let projects = 0, added = 0, removed = 0;
  for (const { projectId } of items) {
    if (!projectId) continue;
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true, status: true, shootDate: true,
        orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
        deliverables: { select: { id: true, type: true, label: true, status: true } },
      },
    });
    if (!p) continue;
    const parsed = dedupeParsedDeliverables(p.orderItems.flatMap((it) => deliverablesForTitle(it.title, it.quantity)));
    const wantByType = new Map(parsed.map((d) => [d.type as string, d]));
    let touched = false;
    // Remove phantoms: types no longer implied — PENDING rows only (real work
    // that already happened is evidence the type was real).
    for (const d of p.deliverables) {
      if (!wantByType.has(d.type) && d.status === "PENDING") {
        await prisma.deliverable.delete({ where: { id: d.id } });
        removed++; touched = true;
      }
    }
    // Add missing + fix labels in place.
    for (const [type, want] of wantByType) {
      const existing = p.deliverables.find((d) => d.type === type);
      if (!existing) {
        await prisma.deliverable.create({
          data: { projectId: p.id, type: type as never, label: want.label, quantity: want.quantity, status: "PENDING" },
        });
        added++; touched = true;
      } else if (existing.label !== want.label) {
        await prisma.deliverable.update({ where: { id: existing.id }, data: { label: want.label } });
        touched = true;
      }
    }
    if (touched) {
      projects++;
      // Due date follows the (possibly changed) video tier.
      if (p.shootDate) {
        const fresh = await prisma.deliverable.findMany({ where: { projectId: p.id }, select: { type: true, label: true } });
        const due = standardDeliveryDue(p.shootDate, fresh, isMonthlyContentJob(fresh));
        await prisma.project.update({ where: { id: p.id }, data: { deliveryDue: due } }).catch(() => {});
      }
    }
  }
  return { projects, added, removed };
}
