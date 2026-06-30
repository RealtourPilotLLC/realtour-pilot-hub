// ---------------------------------------------------------------------------
// The editors that editing work is DELEGATED to and tracked under. A task's
// `assignedKey` holds one of these keys. "Delegated" = anyone other than the
// admin (Kyle) — those tasks move to the admin's "Delegated — in progress"
// group; Kyle's own work stays in "Needs you".
//
// Roster (per Jordan, 2026-06): Kim → personal-branding / monthly social ·
// Remar → standard reels + horizontal video · Luma → premium / influencer social
// reels (external) · Kyle → QC (photos/floor plans/3D/video) + item removal /
// virtual staging / declutter / fixes · AutoHDR → AI photo editing (external) ·
// CubiCasa → floor plans (external). (Adrian was let go — not an editor.)
// The Creative Director (Jordan) = scripting / creative direction ONLY.
// Coordination — chasing the client's MUSIC SELECTION, DELIVERY DATES, and
// virtual/digital STAGING direction — is the ADMIN's (Kyle), even "for the video".
// ---------------------------------------------------------------------------

export type EditorKey = "kyle" | "jordan" | "creative_director" | "kim" | "remar" | "luma" | "autohdr" | "cubicasa";

export type EditorMeta = {
  key: EditorKey;
  name: string;
  kind: "admin" | "owner" | "in_house" | "external";
  does: string;
};

export const EDITORS: Record<EditorKey, EditorMeta> = {
  kyle: { key: "kyle", name: "Kyle", kind: "admin", does: "QC (photos, floor plans, 3D, video), item removal, virtual staging, declutter, photo fixes" },
  // Jordan (owner) — tasks he handles personally: decisions, approvals, client
  // calls, creative sign-off. An operator like Kyle (not an editor delegation).
  jordan: { key: "jordan", name: "Jordan", kind: "owner", does: "owner decisions, approvals, creative sign-off" },
  // The Creative Director owns scripting + creative direction (currently Jordan).
  creative_director: { key: "creative_director", name: "Creative Director", kind: "in_house", does: "video scripting + creative direction" },
  kim: { key: "kim", name: "Kim", kind: "in_house", does: "personal-branding / monthly social content" },
  remar: { key: "remar", name: "Remar", kind: "in_house", does: "standard reels + horizontal video" },
  luma: { key: "luma", name: "Luma", kind: "external", does: "premium social reels" },
  autohdr: { key: "autohdr", name: "AutoHDR", kind: "external", does: "AI photo editing" },
  cubicasa: { key: "cubicasa", name: "CubiCasa", kind: "external", does: "floor plans" },
};

export const EDITOR_KEYS = Object.keys(EDITORS) as EditorKey[];
// The in-house "operators" who work the daily queue (vs. editors we delegate to).
// Their tasks show under "Needs <name>", not the delegated-editor groups.
export const OPERATOR_KEYS: EditorKey[] = ["kyle", "jordan"];
// The ones you delegate editing work to (everyone except the operators). Order =
// how they list.
export const DELEGATE_KEYS: EditorKey[] = ["creative_director", "kim", "remar", "luma", "autohdr", "cubicasa"];

export function editorMeta(key: string | null | undefined): EditorMeta | null {
  return key && key in EDITORS ? EDITORS[key as EditorKey] : null;
}

// A task is "delegated" when it's assigned to an EDITOR — i.e. not one of the
// operators (Kyle/Jordan), whose work stays in their own "Needs <name>" group.
export function isDelegated(key: string | null | undefined): boolean {
  return !!key && !(OPERATOR_KEYS as string[]).includes(key) && key in EDITORS;
}

// Which operator owns a non-delegated task (defaults to Kyle when unset).
export function operatorFor(key: string | null | undefined): "kyle" | "jordan" {
  return key === "jordan" ? "jordan" : "kyle";
}

// Best-effort: who should an editing instruction go to, from its text. Returns
// null when it isn't clearly editing work (stays in "Needs you" for a human to
// assign). Precedence matters — premium reels and floor plans win first.
export function routeEditWork(text: string): EditorKey | null {
  const t = (text || "").toLowerCase();
  // Coordination ABOUT a video/order — not editing/scripting — is the ADMIN's
  // (Kyle). These read like editor work ("...for the video") but the admin owns
  // them: chasing the client's music selection, delivery-date checks, and
  // virtual/digital staging direction. Checked FIRST so an incidental "script"
  // mention in the thread can't pull a delivery/music task to the Creative Director.
  if (/music (selection|choice|option|track|song|pick|window)|select(ing|ion)? (the )?music|deliver(y)? (date|day|window|timeline)|item removal|virtual stag|digital stag|declutter|retouch|photo fix|reflection|blemish|crooked|tilt/.test(t)) return "kyle";

  // Scripting / creative direction → the Creative Director (currently Jordan).
  // That is ALL the Creative Director does — never coordination or production.
  if (/\bscript(ing|s)?\b|storyboard/.test(t)) return "creative_director";

  if (/floor ?plan/.test(t)) return "cubicasa";
  // Premium / influencer social reels → Luma (external).
  if (/(premium|influencer)/.test(t) && /(reel|video|social|bundle)/.test(t)) return "luma";
  // Personal-branding / monthly social, plus logo + animation work → Kim.
  if (/personal ?brand|\bbranding\b|monthly|social (media )?(content|post)|\blogo\b|animat/.test(t)) return "kim";
  // Standard reels + horizontal video → Remar.
  if (/\breel\b|horizontal video|b-?roll|lo-?fi|cross dissolve|text spacing|lengthen (the )?clip|\bvideo\b/.test(t)) return "remar";
  if (/\bphoto|saturation|orange|\bhdr\b|brighten|darken|unedited/.test(t)) return "kyle";
  return null;
}

// Who edits a given deliverable (used to delegate a revision to the right person
// by what's being revised). Mirrors vendors.ts production routing but resolves
// in-house to the actual editor (Remar standard video, Kim social, Kyle QC).
export function editorForDeliverable(type: string | null | undefined, label?: string | null, monthly = false): EditorKey {
  const t = (type || "").toUpperCase();
  const premium = /premium|influencer/i.test(label ?? "");
  if (t === "FLOORPLAN") return "cubicasa";
  if (t === "SOCIAL_REEL" || t === "VIDEO") {
    if (premium) return "luma";
    // Monthly social-plan content (7–10 business-day turnaround) is Kim's.
    if (monthly || /monthly|brand|social/i.test(label ?? "")) return "kim";
    return "remar";
  }
  // Photos / drone / twilight / headshots / staging / 3D → Kyle handles the QC
  // + corrections in-house (AutoHDR does the base AI pass automatically).
  return "kyle";
}
