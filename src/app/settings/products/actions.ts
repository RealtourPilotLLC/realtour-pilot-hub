"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

export type MappingInput = {
  types: string[]; // DeliverableType[] — empty = produces nothing (fee/pure add-on)
  addonTypes: string[]; // subset of types that are POST-SHOOT work (per-part kind)
  videoTier: string | null; // standard | premium | personal_branding
  videoQuantity?: number | null; // videos one order produces (Accelerator = 4)
  videoStyle?: string | null; // style-guide key (VIDEO_STYLE_TIER) → Product.videoStyle
  serviceKind?: string; // legacy product-level kind; derived when absent
};

// THE VIDEO STYLE — which Style Guide type (src/lib/videoStyles.ts headings)
// a product's video is cut as, and the tier each one belongs to. Sep 2 2026:
// the category alone ("Social Reel") threw away the product name, so 626
// Greycliffe's "Standard Reel with Agent Intro" reached the editor as a plain
// reel with no intro script. These keys are the shared contract with
// Deliverable.videoStyle (resolved at sync from this column) — the brief's
// Edit type, the "Send to Review" rows, the upload portal and the Style Guide link
// all read the key, never the label. Mirrors VIDEO_STYLE_OPTIONS on the card
// the same way VALID_TYPES mirrors TYPE_OPTIONS.
const VIDEO_STYLE_TIER: Record<string, "standard" | "premium" | "personal_branding"> = {
  standard_reel: "standard",
  standard_reel_agent_intro: "standard",
  standard_cinematic: "standard",
  premium_social_reel: "premium",
  premium_cinematic: "premium",
  personal_branding: "personal_branding",
};
const VALID_VIDEO_STYLES = new Set(Object.keys(VIDEO_STYLE_TIER));

// The "Agent on Camera" add-on makes no video of its own — it UPGRADES the
// reel on the same order to agent-intro (Jordan: standard reels don't get
// scripts; agent-intro reels get an intro script + notes). It is mapped
// ["OTHER"], so it must be allowed a style without carrying a video type.
// (Same test lives on the card — a "use server" file can only export actions.)
const STYLE_UPGRADE_ADDON_RE = /agent\s*on\s*camera/i;

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
  // A style is only meaningful on something that produces a video — or on
  // the upgrade add-on, which changes the video another line produces.
  const styleAllowed = hasVideo || STYLE_UPGRADE_ADDON_RE.test(product.title);
  const style = styleAllowed && input.videoStyle && VALID_VIDEO_STYLES.has(input.videoStyle) ? input.videoStyle : null;
  // The tier FOLLOWS the style when one is set: a "Premium Social Media Reel"
  // saved on the standard tier is a contradiction the editor's SLA and pay
  // basis would inherit. Without a style the hand-picked tier stands (a drone
  // video add-on has a tier but no style-guide page).
  const tier = !hasVideo
    ? null
    : style
      ? VIDEO_STYLE_TIER[style]
      : ["standard", "premium", "personal_branding"].includes(input.videoTier ?? "") ? input.videoTier : null;
  const me = await getCurrentUser().catch(() => null);

  await prisma.product.update({
    where: { id: productId },
    data: {
      mediaTypes: JSON.stringify(types),
      addonTypes: JSON.stringify(addonTypes),
      videoTier: tier,
      videoStyle: style,
      videoQuantity: hasVideo && input.videoQuantity && input.videoQuantity >= 1 ? Math.min(Math.round(input.videoQuantity), 20) : null,
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

// Shared contract (Sep 2): the parser carries each Aryeo line's verbatim name
// and its resolved style key on the parsed deliverable, and Deliverable stores
// both (productTitle / videoStyle). Read them defensively — only what the
// parser actually defined is written, so a remap can never wipe a style the
// sync set from a field this repair didn't get. This is what turns "Save &
// apply" on the agent-intro product into an agent-intro reel on 626
// Greycliffe today, not at the next sync.
type StyledParsed = { productTitle?: string | null; videoStyle?: string | null };
function styleFields(want: StyledParsed): { productTitle?: string | null; videoStyle?: string | null } {
  return {
    ...(want.productTitle !== undefined ? { productTitle: want.productTitle } : {}),
    ...(want.videoStyle !== undefined ? { videoStyle: want.videoStyle } : {}),
  };
}
function styleChanged(want: StyledParsed, have: StyledParsed): boolean {
  return (want.productTitle !== undefined && want.productTitle !== have.productTitle)
    || (want.videoStyle !== undefined && want.videoStyle !== have.videoStyle);
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
        deliverables: { select: { id: true, type: true, label: true, status: true, manual: true, removedFromOrderAt: true, productTitle: true, videoStyle: true } },
      },
    });
    if (!p) continue;
    const parsed = dedupeParsedDeliverables(p.orderItems.flatMap((it) => deliverablesForTitle(it.title, it.quantity)));
    const wantByType = new Map(parsed.map((d) => [d.type as string, d as typeof d & StyledParsed]));
    let touched = false;
    // Remove phantoms: types no longer implied — PENDING rows only (real work
    // that already happened is evidence the type was real).
    for (const d of p.deliverables) {
      // Same retire semantics as the order reconcile — never a delete.
      if (!wantByType.has(d.type) && d.status === "PENDING" && !d.manual && !d.removedFromOrderAt) {
        await prisma.deliverable.update({
          where: { id: d.id },
          data: { removedFromOrderAt: new Date(), removedFromOrderNote: "No longer implied by the order's products (product-map repair)" },
        });
        removed++; touched = true;
      }
    }
    // Add missing + fix labels in place.
    for (const [type, want] of wantByType) {
      const existing = p.deliverables.find((d) => d.type === type);
      if (existing?.removedFromOrderAt) {
        await prisma.deliverable.update({
          where: { id: existing.id },
          data: { removedFromOrderAt: null, removedFromOrderNote: null, label: want.label, quantity: want.quantity, ...styleFields(want) },
        });
        added++; touched = true;
        continue;
      }
      if (!existing) {
        await prisma.deliverable.create({
          data: { projectId: p.id, type: type as never, label: want.label, quantity: want.quantity, status: "PENDING", ...styleFields(want) },
        });
        added++; touched = true;
      } else if (existing.label !== want.label || styleChanged(want, existing)) {
        // Label AND style fix in place — the editor brief reads the style key
        // off the row, so a re-mapped product must reach live rows here.
        await prisma.deliverable.update({ where: { id: existing.id }, data: { label: want.label, ...styleFields(want) } });
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
