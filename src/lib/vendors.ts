import { DeliverableType } from "@prisma/client";
import { refinedDeliverableLabel } from "@/lib/pipeline";
import { PALETTE } from "@/lib/palette";

// ---------------------------------------------------------------------------
// Production routing — who edits what. Each deliverable is routed to either an
// external vendor or the in-house team, so the editor queue only surfaces what
// the in-house editors actually touch, and Kyle can see what's out at a vendor.
//
//   Photos / Twilight / Headshots  → AutoHDR  (photo editing service)
//   Floor plans                    → CubiCasa (floor-plan vendor)
//   Virtual staging                → Staging vendor
//   Premium Reel / Premium Video   → Luma Visuals (premium video)
//   Standard Reel / Monthly / Std  → In-house editors
//   3D tours (Matterport/Zillow)   → In-house (auto-processed on-site)
// ---------------------------------------------------------------------------

export type VendorKey = "in_house" | "autohdr" | "luma" | "cubicasa" | "staging";

export type VendorMeta = {
  key: VendorKey;
  name: string;
  kind: "in_house" | "external";
  color: string;
};

export const VENDOR_META: Record<VendorKey, VendorMeta> = {
  in_house: { key: "in_house", name: "In-house", kind: "in_house", color: PALETTE.indigo },
  autohdr: { key: "autohdr", name: "AutoHDR", kind: "external", color: PALETTE.blue },
  luma: { key: "luma", name: "Luma", kind: "external", color: PALETTE.violet },
  cubicasa: { key: "cubicasa", name: "CubiCasa", kind: "external", color: PALETTE.teal },
  staging: { key: "staging", name: "Staging", kind: "external", color: PALETTE.gold },
};

// Route one deliverable to its production destination.
export function routeDeliverable(type: DeliverableType, label?: string | null): VendorMeta {
  switch (type) {
    case DeliverableType.PHOTOS:
    case DeliverableType.TWILIGHT:
    case DeliverableType.DRONE:
    case DeliverableType.HEADSHOT:
      return VENDOR_META.autohdr;
    case DeliverableType.FLOORPLAN:
      return VENDOR_META.cubicasa;
    case DeliverableType.VIRTUAL_STAGING:
      return VENDOR_META.staging;
    case DeliverableType.SOCIAL_REEL:
    case DeliverableType.VIDEO: {
      // Premium reels/video go to Luma; standard reels & Monthly content are in-house.
      const refined = refinedDeliverableLabel(type, label);
      // Premium moved in-house Aug 2026 (John Mark) — Luma engagement ended.
      if (/premium/i.test(refined) || /premium/i.test(label ?? "")) return VENDOR_META.in_house;
      return VENDOR_META.in_house;
    }
    case DeliverableType.MATTERPORT_3D:
    case DeliverableType.ZILLOW_3D:
    case DeliverableType.OTHER:
    default:
      return VENDOR_META.in_house;
  }
}

// Summarize a project's deliverables into the distinct vendors involved, so a
// card can show "AutoHDR · Luma · In-house" at a glance.
export function projectVendors(
  deliverables: { type: DeliverableType; label?: string | null }[],
): VendorMeta[] {
  const seen = new Map<VendorKey, VendorMeta>();
  for (const d of deliverables) {
    const v = routeDeliverable(d.type, d.label);
    if (!seen.has(v.key)) seen.set(v.key, v);
  }
  // In-house first, then externals alphabetically — stable display order.
  return [...seen.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "in_house" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
