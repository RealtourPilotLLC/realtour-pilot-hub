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

export type EditorKey = "kyle" | "jordan" | "creative_director" | "kim" | "john" | "remar" | "luma" | "autohdr" | "cubicasa";

export type EditorMeta = {
  key: EditorKey;
  name: string;
  kind: "admin" | "owner" | "in_house" | "external";
  does: string;
  // --- Notification-channel meta (code constants, NOT schema) ---
  // The video editors are REAL people we now ping directly when raws land / a
  // revision is raised / their edit is reviewed. Two things the bell alone can't
  // reach them by:
  //   · `teamMemberName` — substring we resolve their TeamMember row by (for the
  //     SMS phone). Kim Miguel has one (+63…); Remar does not yet, so SMS no-ops
  //     for her until Jordan adds it. Externals (Luma) intentionally have none.
  //   · `slackUserId`   — a Slack DM id (preferred over SMS when present, same as
  //     Kyle's DM). Fill once we know their Slack ids.
  // `tz` is the recipient's LOCAL timezone for quiet hours — the Manila editors'
  // night is precisely the old ET texting window, so a text keyed to ET would fire
  // at 3am their time. Default Asia/Manila for the offshore in-house editors.
  teamMemberName?: string;
  slackUserId?: string;
  tz?: string;
  // No longer with us. The entry stays so their finished work still renders with
  // their name; they are excluded from every picker and routing rule, so nothing
  // new can be assigned to them.
  departed?: boolean;
};

// Quiet-hours default when an editor has no explicit tz. The in-house video
// editors (Kim, John) are in the Philippines.
export const DEFAULT_EDITOR_TZ = "Asia/Manila";

export const EDITORS: Record<EditorKey, EditorMeta> = {
  kyle: { key: "kyle", name: "Kyle", kind: "admin", does: "QC (photos, floor plans, 3D, video), item removal, virtual staging, declutter, photo fixes", teamMemberName: "Kyle", tz: "America/New_York" },
  // Jordan (owner) — tasks he handles personally: decisions, approvals, client
  // calls, creative sign-off. An operator like Kyle (not an editor delegation).
  jordan: { key: "jordan", name: "Jordan", kind: "owner", does: "owner decisions, approvals, creative sign-off", tz: "America/New_York" },
  // The Creative Director owns scripting + creative direction (currently Jordan).
  creative_director: { key: "creative_director", name: "Creative Director", kind: "in_house", does: "video scripting + creative direction", tz: "America/New_York" },
  // Kim Miguel — Manila. Has a TeamMember row with a phone → SMS reaches her.
  kim: { key: "kim", name: "Kim", kind: "in_house", does: "personal-branding / monthly social content", teamMemberName: "Kim", tz: "Asia/Manila" },
  // John Mark — Manila. Took over Remar's lane (standard reels + horizontal video)
  // in Aug 2026. Needs a phone on his Team row before SMS can reach him.
  john: { key: "john", name: "John Mark", kind: "in_house", does: "standard reels + horizontal video", teamMemberName: "John Mark", tz: "Asia/Manila" },
  // Remar — DEPARTED Aug 2026, replaced by John. The key is retained ONLY so his
  // finished work still resolves to his name: 12 completed tasks and 8 delivered
  // jobs carry it, and re-pointing those at John would credit his work to someone
  // who never did it. He is absent from every picker and routing rule below, so
  // nothing new can land on him.
  remar: { key: "remar", name: "Remar", kind: "in_house", does: "standard reels + horizontal video (departed)", teamMemberName: "Remar", tz: "Asia/Manila", departed: true },
  // Luma — engagement ENDED Aug 2026 (premium moved in-house to John Mark).
  // Key retained so historical tasks/jobs still render; absent from all pickers.
  luma: { key: "luma", name: "Luma", kind: "external", does: "premium social reels (no longer used)" },
  autohdr: { key: "autohdr", name: "AutoHDR", kind: "external", does: "AI photo editing" },
  cubicasa: { key: "cubicasa", name: "CubiCasa", kind: "external", does: "floor plans" },
};

// The editor keys that map to an actual person we persist on Project.editorId
// (an in-house TeamMember). Externals (Luma) and vendors stay Kyle-dispatch and
// never get a TeamMember link — their work is tracked by the edit_video task.
// Includes `remar` so his historical jobs still resolve to a TeamMember. New
// work never routes to him — see DELEGATE_KEYS and the routing rules below.
export const TEAM_MEMBER_EDITOR_KEYS: EditorKey[] = ["kim", "john", "remar"];

// Resolve an editor key → its TeamMember id (for the phone / Project.editorId),
// or null when the editor isn't a linkable person (external/vendor) or has no
// TeamMember row yet (Remar until Jordan adds her). Best-effort; never throws.
export async function editorTeamMemberId(key: EditorKey | string | null | undefined): Promise<string | null> {
  const meta = editorMeta(key);
  if (!meta?.teamMemberName) return null;
  try {
    const { prisma } = await import("@/lib/prisma");
    const tm = await prisma.teamMember.findFirst({
      where: { name: { contains: meta.teamMemberName } },
      select: { id: true },
    });
    return tm?.id ?? null;
  } catch {
    return null;
  }
}

// Reverse of editorTeamMemberId: a TeamMember's name → the editor key it
// represents (Kim Miguel → "kim"). Used to read Project.editor back into the
// key space the routing/tasks engines speak. Null for non-editor team members.
export function editorKeyForTeamName(name: string | null | undefined): EditorKey | null {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const meta of Object.values(EDITORS)) {
    if (meta.teamMemberName && n.includes(meta.teamMemberName.toLowerCase())) return meta.key;
  }
  return null;
}

export const EDITOR_KEYS = Object.keys(EDITORS) as EditorKey[];
// The in-house "operators" who work the daily queue (vs. editors we delegate to).
// Their tasks show under "Needs <name>", not the delegated-editor groups.
export const OPERATOR_KEYS: EditorKey[] = ["kyle", "jordan"];
// The ones you delegate editing work to (everyone except the operators). Order =
// how they list.
export const DELEGATE_KEYS: EditorKey[] = ["creative_director", "kim", "john", "luma", "autohdr", "cubicasa"];

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
  // Premium / influencer social reels → John Mark (Luma engagement ended Aug 2026).
  if (/(premium|influencer)/.test(t) && /(reel|video|social|bundle)/.test(t)) return "john";
  // Personal-branding / monthly social, plus logo + animation work → Kim.
  if (/personal ?brand|\bbranding\b|monthly|social (media )?(content|post)|\blogo\b|animat/.test(t)) return "kim";
  // Standard reels + horizontal video → John (took this lane over from Remar).
  if (/\breel\b|horizontal video|b-?roll|lo-?fi|cross dissolve|text spacing|lengthen (the )?clip|\bvideo\b/.test(t)) return "john";
  if (/\bphoto|saturation|orange|\bhdr\b|brighten|darken|unedited/.test(t)) return "kyle";
  return null;
}

// Who edits a given deliverable (used to delegate a revision to the right person
// by what's being revised). Mirrors vendors.ts production routing but resolves
// in-house to the actual editor (John standard video, Kim social, Kyle QC).
// Jordan, Aug 14 2026 (Luma engagement ended): "John gets standard reels,
// premium, and we can manually assign John the personal branding reels."
// So: every one-off video auto-routes to John Mark; monthly personal-branding
// content returns NULL on purpose — it lands in "Needs assigning" and a human
// picks the editor per batch. The old label heuristic (/monthly|brand|social/)
// is gone with it: "Standard Social Media Reel" matches /social/, and the
// heuristic was quietly routing one-off standard reels into the monthly lane.
// isMonthlyContentJob(deliverables) is the real signal — trust only it.
// The video rules are OWNER-EDITABLE on /settings (src/lib/settings.ts
// overlays these code defaults). Callers on a routing path fetch the rules
// once via editorRouting() and pass them; omitting `rules` applies the
// defaults, so nothing breaks if a caller skips the fetch.
export type VideoRoutingRules = {
  standardVideo: EditorKey | null;
  premiumVideo: EditorKey | null;
  personalBranding: EditorKey | null; // null = manual (Needs assigning)
};
const CODE_DEFAULT_ROUTING: VideoRoutingRules = { standardVideo: "john", premiumVideo: "john", personalBranding: null };

export function editorForDeliverable(
  type: string | null | undefined,
  label?: string | null,
  monthly = false,
  rules: VideoRoutingRules = CODE_DEFAULT_ROUTING,
): EditorKey | null {
  const t = (type || "").toUpperCase();
  if (t === "FLOORPLAN") return "cubicasa";
  if (t === "SOCIAL_REEL" || t === "VIDEO") {
    if (monthly) return rules.personalBranding;
    if (/premium|influencer/i.test(label ?? "")) return rules.premiumVideo;
    return rules.standardVideo;
  }
  // Photos / drone / twilight / headshots / staging / 3D → Kyle handles the QC
  // + corrections in-house (AutoHDR does the base AI pass automatically).
  return "kyle";
}
