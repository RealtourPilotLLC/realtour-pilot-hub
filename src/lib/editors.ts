// ---------------------------------------------------------------------------
// The editors that editing work is DELEGATED to and tracked under. A task's
// `assignedKey` holds one of these keys. "Delegated" = anyone other than the
// admin (Kyle) — those tasks move to the admin's "Delegated — in progress"
// group; Kyle's own work stays in "Needs you".
//
// Roster (per Jordan, 2026-06): Kim → personal-branding / monthly social ·
// Remar → standard reels + horizontal video · Luma → premium social reels
// (external) · Kyle → QC (photos/floor plans/3D/video) + item removal /
// virtual staging / declutter / fixes · AutoHDR → AI photo editing (external) ·
// CubiCasa → floor plans (external). (Adrian was let go — not an editor.)
// ---------------------------------------------------------------------------

export type EditorKey = "kyle" | "kim" | "remar" | "luma" | "autohdr" | "cubicasa";

export type EditorMeta = {
  key: EditorKey;
  name: string;
  kind: "admin" | "in_house" | "external";
  does: string;
};

export const EDITORS: Record<EditorKey, EditorMeta> = {
  kyle: { key: "kyle", name: "Kyle", kind: "admin", does: "QC (photos, floor plans, 3D, video), item removal, virtual staging, declutter, photo fixes" },
  kim: { key: "kim", name: "Kim", kind: "in_house", does: "personal-branding / monthly social content" },
  remar: { key: "remar", name: "Remar", kind: "in_house", does: "standard reels + horizontal video" },
  luma: { key: "luma", name: "Luma", kind: "external", does: "premium social reels" },
  autohdr: { key: "autohdr", name: "AutoHDR", kind: "external", does: "AI photo editing" },
  cubicasa: { key: "cubicasa", name: "CubiCasa", kind: "external", does: "floor plans" },
};

export const EDITOR_KEYS = Object.keys(EDITORS) as EditorKey[];
// The ones you delegate to (everyone except the admin). Order = how they list.
export const DELEGATE_KEYS: EditorKey[] = ["kim", "remar", "luma", "autohdr", "cubicasa"];

export function editorMeta(key: string | null | undefined): EditorMeta | null {
  return key && key in EDITORS ? EDITORS[key as EditorKey] : null;
}

// A task is "delegated" when it's assigned to someone other than the admin.
export function isDelegated(key: string | null | undefined): boolean {
  return !!key && key !== "kyle" && key in EDITORS;
}

// Best-effort: who should an editing instruction go to, from its text. Returns
// null when it isn't clearly editing work (stays in "Needs you" for a human to
// assign). Precedence matters — premium reels and floor plans win first.
export function routeEditWork(text: string): EditorKey | null {
  const t = (text || "").toLowerCase();
  if (/floor ?plan/.test(t)) return "cubicasa";
  if (/premium/.test(t) && /(reel|video|social)/.test(t)) return "luma";
  if (/personal ?brand|monthly|branding|social (media )?(content|post)/.test(t)) return "kim";
  if (/\breel\b|horizontal video|b-?roll|animat|lo-?fi|cross dissolve|text spacing|lengthen (the )?clip/.test(t)) return "remar";
  if (/\bvideo\b/.test(t)) return "remar";
  if (/photo|saturation|orange|retouch|item removal|virtual stag|declutter|unedited|hdr|brighten|darken|crooked|tilt|reflection|blemish/.test(t)) return "kyle";
  return null;
}

// Who edits a given deliverable (used to delegate a revision to the right person
// by what's being revised). Mirrors vendors.ts production routing but resolves
// in-house to the actual editor (Remar standard video, Kim social, Kyle QC).
export function editorForDeliverable(type: string | null | undefined, label?: string | null): EditorKey {
  const t = (type || "").toUpperCase();
  const premium = /premium/i.test(label ?? "");
  if (t === "FLOORPLAN") return "cubicasa";
  if (t === "SOCIAL_REEL" || t === "VIDEO") {
    if (premium) return "luma";
    if (/monthly|brand|social/i.test(label ?? "")) return "kim";
    return "remar";
  }
  // Photos / drone / twilight / headshots / staging / 3D → Kyle handles the QC
  // + corrections in-house (AutoHDR does the base AI pass automatically).
  return "kyle";
}
