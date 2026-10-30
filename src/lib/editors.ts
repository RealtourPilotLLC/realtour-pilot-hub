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
// Since then: Jhon Mark replaced Remar (Aug 2026); premium moved in-house; and
// Luma Visuals is the outside shop jobs are HANDED to by hand — the
// `external_agency` key below (Jordan, Sep 25 2026).
// The Creative Director (Jordan) = scripting / creative direction ONLY.
// Coordination — chasing the client's MUSIC SELECTION, DELIVERY DATES, and
// virtual/digital STAGING direction — is the ADMIN's (Kyle), even "for the video".
// ---------------------------------------------------------------------------

export type BuiltinEditorKey = "kyle" | "jordan" | "creative_director" | "kim" | "john" | "remar" | "luma" | "autohdr" | "cubicasa" | "external_agency" | "cliffside_cuts";
// An editor onboarded on People (Oct 30 2026, Reychelle) has a key that is not
// in this file: it lives on her TeamMember row (TeamMember.editorKey) and joins
// the roster below at runtime (applyEditorRoster). So a key is any string; the
// built-in names above still autocomplete.
export type EditorKey = BuiltinEditorKey | (string & {});

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
  // `tz` is the recipient's LOCAL timezone — their own clock on the editor
  // desk ("12:40am your time"). It holds no notification: since Oct 6 2026
  // editors get night-time pings (Jordan). Default Asia/Manila for the
  // offshore in-house editors.
  teamMemberName?: string;
  /** Older spellings of `teamMemberName` still found on cards and records
   *  ("John Mark", Oct 30 2026), matched like it so nothing loses them. */
  formerNames?: string[];
  slackUserId?: string;
  tz?: string;
  // No longer with us. The entry stays so their finished work still renders with
  // their name; they are excluded from every picker and routing rule, so nothing
  // new can be assigned to them.
  departed?: boolean;
  // An in-house VIDEO editor: has a desk in the Editing Room, can be picked on
  // a job, and can be ticked on an auto-assignment lane (Kim, Jhon Mark, and
  // everyone onboarded on People since Oct 30 2026).
  video?: boolean;
};

// Timezone default when an editor has no explicit tz. The in-house video
// editors (Kim, John) are in the Philippines.
export const DEFAULT_EDITOR_TZ = "Asia/Manila";

/** The clocks an onboarded editor can be on (People → Logins). */
export const EDITOR_TIMEZONES: { value: string; label: string }[] = [
  { value: "Asia/Manila", label: "Philippines (Manila)" },
  { value: "America/New_York", label: "US Eastern" },
  { value: "America/Chicago", label: "US Central" },
  { value: "America/Denver", label: "US Mountain" },
  { value: "America/Los_Angeles", label: "US Pacific" },
  { value: "Europe/London", label: "UK (London)" },
  { value: "Asia/Kolkata", label: "India" },
  { value: "Asia/Karachi", label: "Pakistan" },
  { value: "Africa/Lagos", label: "Nigeria (Lagos)" },
  { value: "America/Sao_Paulo", label: "Brazil (São Paulo)" },
];

export const EDITORS: Record<EditorKey, EditorMeta> = {
  kyle: { key: "kyle", name: "Kyle", kind: "admin", does: "QC (photos, floor plans, 3D, video), item removal, virtual staging, declutter, photo fixes", teamMemberName: "Kyle", tz: "America/New_York" },
  // Jordan (owner) — tasks he handles personally: decisions, approvals, client
  // calls, creative sign-off. An operator like Kyle (not an editor delegation).
  jordan: { key: "jordan", name: "Jordan", kind: "owner", does: "owner decisions, approvals, creative sign-off", tz: "America/New_York" },
  // The Creative Director owns scripting + creative direction (currently Jordan).
  creative_director: { key: "creative_director", name: "Creative Director", kind: "in_house", does: "video scripting + creative direction", tz: "America/New_York" },
  // Kim Miguel — Manila. Has a TeamMember row with a phone → SMS reaches her.
  kim: { key: "kim", name: "Kim", kind: "in_house", does: "personal-branding / monthly social content", teamMemberName: "Kim", tz: "Asia/Manila", video: true },
  // Jhon Mark — Manila. Took over Remar's lane (standard reels + horizontal video)
  // in Aug 2026. Spelled JHON (Jordan, Oct 30 2026: "I didn't realize his name
  // was spelled differently"); the desk key stays "john" because his tasks,
  // jobs and history are filed under it. Needs a phone on his Team row before
  // SMS can reach him.
  john: { key: "john", name: "Jhon Mark", kind: "in_house", does: "standard reels + horizontal video", teamMemberName: "Jhon Mark", formerNames: ["John Mark"], tz: "Asia/Manila", video: true },
  // Remar — DEPARTED Aug 2026, replaced by John. The key is retained ONLY so his
  // finished work still resolves to his name: 12 completed tasks and 8 delivered
  // jobs carry it, and re-pointing those at John would credit his work to someone
  // who never did it. He is absent from every picker and routing rule below, so
  // nothing new can land on him.
  remar: { key: "remar", name: "Remar", kind: "in_house", does: "standard reels + horizontal video (departed)", teamMemberName: "Remar", tz: "Asia/Manila", departed: true, video: true },
  // Luma's OLD lane — the automatic premium-reel routing that ENDED Aug 2026
  // (premium moved in-house to Jhon Mark). Key retained so historical tasks and
  // jobs still render; absent from all pickers. The agency itself is still
  // used: jobs are handed to Luma Visuals by hand through `external_agency`
  // below — this key is never written again.
  luma: { key: "luma", name: "Luma", kind: "external", does: "premium social reels (old automatic lane, no longer used)" },
  autohdr: { key: "autohdr", name: "AutoHDR", kind: "external", does: "AI photo editing" },
  cubicasa: { key: "cubicasa", name: "CubiCasa", kind: "external", does: "floor plans" },
  // The outside editing shop overflow video goes to. Jordan, Sep 7: "I also
  // want to be able to unassign projects from editors and reassign them to an
  // external agency. That way, our editors don't see jobs that are not
  // assigned to them." The key stayed generic until Jordan named the shop, and
  // on Sep 25 he did: "we do work with Luma visuals and I have certain video
  // projects that I reassign to them right now as external agency." So the
  // NAME is Luma Visuals and the key is unchanged — live jobs already carry
  // editorVendorKey = external_agency, and the retired `luma` key above is a
  // different thing (the old automatic lane). Like CubiCasa it has no login,
  // no TeamMember row and no bell: Kyle hands the work over and records the
  // send and Luma's acknowledgement (lib/editorPacket — nothing is sent to
  // Luma automatically), so a job handed to it leaves John's and Kim's queues.
  external_agency: { key: "external_agency", name: "Luma Visuals", kind: "external", does: "overflow video editing (outside agency, handed over by the office)" },
  // A second outside shop (Oct 27 2026, Jordan: "Add Cliffside Cuts as an
  // external editor"). Handed over exactly like Luma Visuals: no login, no
  // bell, off John's and Kim's boards.
  cliffside_cuts: { key: "cliffside_cuts", name: "Cliffside Cuts", kind: "external", does: "video editing (outside shop, handed over by the office)" },
};

/**
 * The outside shops a video job can be handed to by hand. Picking one pins the
 * job away from our editors (Project.editorVendorKey keeps the shop). Oct 27
 * 2026, Jordan: "If I assign it to Luma and change it to in editing, then that
 * should be all we need" — no packet to record, no acknowledgement to wait on,
 * and an EDITING job with a shop reads "In editing" (they never press Start).
 */
export const OUTSIDE_EDITOR_KEYS: EditorKey[] = ["external_agency", "cliffside_cuts"];
export const isOutsideEditor = (key: string | null | undefined): key is EditorKey => !!key && (OUTSIDE_EDITOR_KEYS as string[]).includes(key);

// The keys the VIDEO lane is narrated from — the Editing Room row's status,
// its editor name, and its revision-ask chip all read only these. A photo
// retouch is Kyle's and must never flip a video row (Janice's "remove the
// closets photos" did all three before this scoping). One list, so the queue
// builder and the reassign action can't drift apart.
/**
 * The owner's project-level pin, read the same way by every engine that routes
 * edit work. Three answers, and the difference matters:
 *   · pinned: false           → no human pick; the routing rules decide.
 *   · pinned: true, key: "kim" → pinned to an in-house editor.
 *   · pinned: true, key: "external_agency" | null → pinned AWAY from our editors
 *     (the outside shop, or deliberately nobody). The rules must NOT fill this
 *     back in — an unassigned upcoming job that re-routed itself to John the
 *     moment its raws landed was exactly the bug (review, Sep 7).
 */
export function pinnedEditorFor(p: {
  editorManual?: boolean | null;
  editorVendorKey?: string | null;
  editor?: { name?: string | null } | null;
}): { pinned: boolean; key: EditorKey | null } {
  if (!p.editorManual) return { pinned: false, key: null };
  const inHouse = editorKeyForTeamName(p.editor?.name);
  if (inHouse) return { pinned: true, key: inHouse };
  const vendor = (p.editorVendorKey ?? null) as EditorKey | null;
  return { pinned: true, key: vendor && vendor in EDITORS ? vendor : null };
}

export const VIDEO_LANE_KEYS: EditorKey[] = ["kim", "john", "remar", "luma", "external_agency", "cliffside_cuts"];

// The editor keys that map to an actual person we persist on Project.editorId
// (an in-house TeamMember). Externals (Luma) and vendors stay Kyle-dispatch and
// never get a TeamMember link — their work is tracked by the edit_video task.
// Includes `remar` so his historical jobs still resolve to a TeamMember. New
// work never routes to him — see DELEGATE_KEYS and the routing rules below.
export const TEAM_MEMBER_EDITOR_KEYS: EditorKey[] = ["kim", "john", "remar"];
// The ones of them still here (a desk in the Editing Room). Grown in place by
// applyEditorRoster, like the two lists above.
export const DESK_VIDEO_EDITOR_KEYS: EditorKey[] = ["kim", "john"];

// Resolve an editor key → its TeamMember id (for the phone / Project.editorId),
// or null when the editor isn't a linkable person (external/vendor) or has no
// TeamMember row yet (Remar until Jordan adds her). Best-effort; never throws.
export async function editorTeamMemberId(key: EditorKey | string | null | undefined): Promise<string | null> {
  const meta = editorMeta(key);
  if (!meta?.teamMemberName) return null;
  try {
    const { prisma } = await import("@/lib/prisma");
    // The row that carries the key wins; the name match is for a built-in
    // editor whose row predates TeamMember.editorKey.
    let tm = await prisma.teamMember.findFirst({ where: { editorKey: meta.key }, select: { id: true } });
    for (const name of [meta.teamMemberName, ...(meta.formerNames ?? [])]) {
      tm ??= await prisma.teamMember.findFirst({ where: { name: { contains: name } }, select: { id: true } });
    }
    return tm?.id ?? null;
  } catch {
    return null;
  }
}

// Reverse of editorTeamMemberId: a TeamMember's name → the editor key it
// represents (Kim Miguel → "kim"). Used to read Project.editor back into the
// key space the routing/tasks engines speak. Null for non-editor team members.
// The whole name first: a new "Kimberly" must not read as Kim because her
// name happens to contain his.
export function editorKeyForTeamName(name: string | null | undefined): EditorKey | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const metas = Object.values(EDITORS);
  const names = (meta: EditorMeta) => (meta.teamMemberName ? [meta.teamMemberName, ...(meta.formerNames ?? [])] : []).map((x) => x.trim().toLowerCase());
  for (const meta of metas) {
    if (names(meta).includes(n)) return meta.key;
  }
  for (const meta of metas) {
    if (names(meta).some((x) => n.includes(x))) return meta.key;
  }
  return null;
}

export const EDITOR_KEYS = Object.keys(EDITORS) as EditorKey[];
// The in-house "operators" who work the daily queue (vs. editors we delegate to).
// Their tasks show under "Needs <name>", not the delegated-editor groups.
export const OPERATOR_KEYS: EditorKey[] = ["kyle", "jordan"];
// The ones you delegate editing work to (everyone except the operators). Order =
// how they list. No `luma`: that retired key would list beside "Luma Visuals"
// (external_agency) in the fallback pickers, and setTaskAssignee refuses it.
export const DELEGATE_KEYS: EditorKey[] = ["creative_director", "kim", "john", "autohdr", "cubicasa", "external_agency", "cliffside_cuts"];

export function editorMeta(key: string | null | undefined): EditorMeta | null {
  return key && Object.hasOwn(EDITORS, key) ? EDITORS[key as EditorKey] : null;
}

// ---------------------------------------------------------------------------
// EDITORS ONBOARDED ON PEOPLE (Jordan, Oct 30 2026: "I just onboarded a new
// editor her name is Reychelle. I need to make sure the ops hub is set up to
// be able to onboard new editors and new users, and add their Slack ID,
// assignment, etc."). Kim and Jhon Mark were written into this file; nobody
// else could ever hold a desk. Now an in-house video editor is a TeamMember
// row with an editorKey, and lib/editorRoster reads those rows into the
// roster above (60 s cache) on every sign-in, routing call and cron run. The
// lists below are the SAME arrays every engine already imports, grown in
// place, so a key on a row reaches the Editing Room, the pickers, the bell
// and the routing without each of them learning about the database.
//
// Server only: a client component sees the built-in roster, so a picker is
// handed its people by the page (videoEditorChoices).
// ---------------------------------------------------------------------------

export type RosterEditorRow = {
  key: string;
  /** the TeamMember's name, as the office typed it */
  name: string;
  active: boolean;
  timezone?: string | null;
};

/** Keys that came from the database rather than this file. */
const LOADED = new Set<string>();

const BUILTIN_KEYS = new Set<string>(Object.keys(EDITORS));
/** Each built-in editor's clock in this file, for when their card has none. */
const BUILTIN_TZ = new Map<string, string | undefined>(Object.values(EDITORS).map((m) => [m.key, m.tz]));
const SLUG_RE = /^[a-z][a-z0-9_]{1,31}$/;

/** Is this a key a new editor may be given (not a built-in, not malformed)? */
export function isFreshEditorKey(key: string): boolean {
  return SLUG_RE.test(key) && !BUILTIN_KEYS.has(key);
}

const addOnce = (list: EditorKey[], key: string) => { if (!list.includes(key)) list.push(key); };
const removeFrom = (list: EditorKey[], key: string) => { const i = list.indexOf(key); if (i >= 0) list.splice(i, 1); };

/** Read the database's editors into the roster. A built-in key on a row
 *  keeps its name and place (Kim stays Kim) and takes only the clock on the
 *  card, which the editor sets on their own profile (Oct 30 2026); a key that
 *  left the database stays on the roster as departed, so the work it did
 *  keeps its name. */
export function applyEditorRoster(rows: RosterEditorRow[]): void {
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.key && BUILTIN_KEYS.has(r.key)) {
      const tz = r.timezone || BUILTIN_TZ.get(r.key);
      if (EDITORS[r.key] && EDITORS[r.key].tz !== tz) EDITORS[r.key] = { ...EDITORS[r.key], tz };
      continue;
    }
    if (!r.key || !SLUG_RE.test(r.key)) continue;
    seen.add(r.key);
    LOADED.add(r.key);
    const name = r.name.trim() || r.key;
    EDITORS[r.key] = {
      key: r.key,
      name,
      kind: "in_house",
      does: "video editing",
      teamMemberName: name,
      tz: r.timezone || DEFAULT_EDITOR_TZ,
      video: true,
      ...(r.active ? {} : { departed: true }),
    };
    addOnce(EDITOR_KEYS, r.key);
    addOnce(TEAM_MEMBER_EDITOR_KEYS, r.key);
    addOnce(VIDEO_LANE_KEYS, r.key);
    for (const list of [DELEGATE_KEYS, DESK_VIDEO_EDITOR_KEYS]) {
      if (r.active) addOnce(list, r.key);
      else removeFrom(list, r.key);
    }
  }
  for (const key of LOADED) {
    if (seen.has(key)) continue;
    EDITORS[key] = { ...EDITORS[key], departed: true };
    removeFrom(DELEGATE_KEYS, key);
    removeFrom(DESK_VIDEO_EDITOR_KEYS, key);
  }
}

/** The in-house video editors, built-in and onboarded, in roster order.
 *  Departed ones only when asked for (history: their finished work). */
export function videoEditorKeys(opts: { includeDeparted?: boolean } = {}): EditorKey[] {
  return Object.values(EDITORS)
    .filter((m) => m.video && (opts.includeDeparted || !m.departed))
    .map((m) => m.key);
}

export function isVideoEditorKey(key: string | null | undefined, opts: { includeDeparted?: boolean } = {}): boolean {
  const m = editorMeta(key);
  return !!m?.video && (!!opts.includeDeparted || !m.departed);
}

/** Who a page hands a client-side editor picker: the current video editors. */
export function videoEditorChoices(): { key: string; name: string }[] {
  return videoEditorKeys().map((key) => ({ key, name: EDITORS[key].name }));
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
  // Premium / influencer social reels → Jhon Mark (Luma engagement ended Aug 2026).
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
// So: every one-off video auto-routes to Jhon Mark; monthly personal-branding
// content returns NULL on purpose — it lands in "Needs assigning" and a human
// picks the editor per batch. The old label heuristic (/monthly|brand|social/)
// is gone with it: "Standard Social Media Reel" matches /social/, and the
// heuristic was quietly routing one-off standard reels into the monthly lane.
// isMonthlyContentJob(deliverables) is the real signal — trust only it.
// The video rules are OWNER-EDITABLE on /settings (src/lib/settings.ts
// overlays these code defaults). Callers on a routing path fetch the rules
// once via editorRouting() and pass them; omitting `rules` applies the
// defaults, so nothing breaks if a caller skips the fetch.
// SEVERAL EDITORS ON A LANE (Oct 30 2026, Jordan: "the dropdown for
// assignment could be a dropdown of checkboxes, and then edits get assigned
// based on current workload, turnaround times, etc."). Each lane holds
// everyone ticked for it (`pools`); the single key per lane is whoever the
// workload says is next right now (lib/editorBalance). A job keeps the editor
// it was given while they stay ticked for its lane (keepOrRoute): the next
// pick is for the next job, never a reason to move this one.
export type RoutingLane = "standardVideo" | "premiumVideo" | "personalBranding";
export const ROUTING_LANES: RoutingLane[] = ["standardVideo", "premiumVideo", "personalBranding"];
export const ROUTING_LANE_LABEL: Record<RoutingLane, string> = {
  standardVideo: "Standard reels & video",
  premiumVideo: "Premium reels",
  personalBranding: "Personal branding (monthly)",
};

export type VideoRoutingRules = {
  standardVideo: EditorKey | null;
  premiumVideo: EditorKey | null;
  personalBranding: EditorKey | null; // null = manual (Needs assigning)
  /** everyone ticked for each lane; absent = the single keys above are the whole lane */
  pools?: Partial<Record<RoutingLane, EditorKey[]>>;
};
const CODE_DEFAULT_ROUTING: VideoRoutingRules = { standardVideo: "john", premiumVideo: "john", personalBranding: null };

/** Which auto-assignment lane a deliverable belongs to; null = not video work. */
export function routingLaneFor(type: string | null | undefined, label?: string | null, monthly = false): RoutingLane | null {
  const t = (type || "").toUpperCase();
  if (t !== "SOCIAL_REEL" && t !== "VIDEO") return null;
  if (monthly) return "personalBranding";
  if (/premium|influencer/i.test(label ?? "")) return "premiumVideo";
  return "standardVideo";
}

export function editorForDeliverable(
  type: string | null | undefined,
  label?: string | null,
  monthly = false,
  rules: VideoRoutingRules = CODE_DEFAULT_ROUTING,
): EditorKey | null {
  const t = (type || "").toUpperCase();
  if (t === "FLOORPLAN") return "cubicasa";
  const lane = routingLaneFor(type, label, monthly);
  if (lane) return rules[lane];
  // Photos / drone / twilight / headshots / staging / 3D → Kyle handles the QC
  // + corrections in-house (AutoHDR does the base AI pass automatically).
  return "kyle";
}

/**
 * The editor already on a job keeps it while they are still ticked for its
 * lane; otherwise the rules' pick (`ruled`). With one editor per lane this is
 * exactly the rules, as before. With several it is what stops the hourly
 * refresh from moving an unstarted job each time someone else's queue gets
 * shorter.
 */
export function keepOrRoute(
  current: string | null | undefined,
  lane: RoutingLane | null,
  rules: VideoRoutingRules,
  ruled: EditorKey | null,
): EditorKey | null {
  if (current && lane && rules.pools?.[lane]?.includes(current) && isVideoEditorKey(current)) return current;
  return ruled;
}
