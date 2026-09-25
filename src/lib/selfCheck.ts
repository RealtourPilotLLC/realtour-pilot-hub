import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// THE EDITOR'S SELF-CHECK (unified handoff §8.2, Sep 25 2026).
//
// "Editors must watch their actual exported edit and complete a required
// checklist before each submission, including revisions. Record the
// attestation against the exact version." (§3, settled.)
//
// This file is the PURE half — the checklist per product, the rule that says
// whether a set of answers is complete, and the predicates every reader uses
// to tell a cut that is in front of the reviewer from one that is still
// waiting on its editor. Plain data and pure functions, so the dialog in the
// browser and the server that enforces it read the SAME list. The database
// half (binding an answer to a file, voiding it when the bytes change) is
// src/lib/selfCheckStore.ts.
//
// A tick is an accountable attestation, not proof of watching (§8.2). It never
// replaces the reviewer, and nothing here touches pay.
// ---------------------------------------------------------------------------

/** The day the gate and the issue ledger begin. Cuts from before it are
 *  grandfathered — and the grandfathering is done by MARKER, not by clock: a
 *  row is only ever held when it carries a check id (selfCheckId), which no
 *  row written before the gate, and no row a drill builds by hand, can have.
 *  A clock rule would have held every legacy cut still in flight on the day of
 *  a late deploy (and broken every drill run after the date — three broke on
 *  Sep 25 for reading the clock), and a blank legacy placeholder refilled by
 *  the folder sweep would have slipped past it the other way. The date is
 *  kept for what IS about time: issues from notes written before it are
 *  flagged `imported`, and the quality report starts here. */
export const SELF_CHECK_REQUIRED_SINCE = new Date("2026-09-25T04:00:00.000Z");

/** A Not-applicable or not-addressed answer must say why, in at least this
 *  many characters ("no captions" is 11) — a reason, not a keystroke. */
export const SELF_CHECK_REASON_MIN = 8;

export type SelfCheckItem = {
  key: string;
  /** The attestation, first person, one sentence. */
  label: string;
  /** What to actually look at. */
  help?: string;
  /** May this product answer "Not applicable" (with a reason)? */
  naAllowed: boolean;
  /** The sentence the N/A box suggests ("There are no captions in this cut"). */
  naHint?: string;
  /** "revision" = asked only when the cut answers earlier notes. */
  when?: "always" | "revision";
};

export type SelfCheckProfile = {
  styleKey: string;
  styleName: string;
  version: number;
  /** `<styleKey>@v<version>` — stored on the check, so a later edit to the
   *  list never re-describes what an editor attested to. */
  checklistKey: string;
  items: SelfCheckItem[];
};

export type SelfCheckAnswer = { answer: "YES" | "NA"; reason?: string | null };
export type SelfCheckAnswers = Record<string, SelfCheckAnswer>;

/** The editor's word on each revision issue still open on the slot. */
export type IssueDeclarations = {
  addressed: string[];
  /** issue id → why it was not done (client said leave it, waiting on a file…) */
  notAddressed: Record<string, string>;
};

/** What the dialog sends. `watchedFile` is the file the editor says they
 *  watched — for an upload the chosen File, for a folder cut the candidate the
 *  server named. The server binds it to the bytes; the browser's word alone is
 *  never the binding. */
export type SelfCheckInput = {
  checklistKey: string;
  answers: SelfCheckAnswers;
  issues?: IssueDeclarations | null;
  watchedFile?: { name: string; size?: number | null; lastModified?: number | null } | null;
};

export type ValidatedSelfCheck = {
  items: { key: string; label: string; answer: "YES" | "NA"; reason: string | null }[];
  addressed: string[];
  notAddressed: Record<string, string>;
};

// ---- the checklist -----------------------------------------------------------

const ITEM = {
  watched_full: {
    key: "watched_full",
    label: "I watched the whole exported file — the actual export, beginning to end, with sound where there is sound.",
    help: "Play the file you are about to send, not the timeline. The first and last seconds are where the black frames and cut-off music hide.",
    naAllowed: false,
  },
  followed_brief: {
    key: "followed_brief",
    label: "It follows the current brief, script, references, required shots and every instruction supplied.",
    help: "Anything I could not follow is flagged in my message to the reviewer, with why.",
    naAllowed: false,
  },
  captions_text: {
    key: "captions_text",
    label: "Captions, names, spelling, on-screen facts and their timing are checked.",
    help: "Agent and brokerage names, the address, prices on screen, phone numbers — read every word.",
    naAllowed: true,
    naHint: "There are no captions or on-screen text in this cut.",
  },
  audio_visual: {
    key: "audio_visual",
    label: "Voice and music balance, continuity, transitions, framing — and no visible defects.",
    help: "Levels, jump cuts, flashes, crooked verticals, dust, a crew member in a mirror.",
    naAllowed: true,
    naHint: "There is no audio in this cut — the visual checks are done.",
  },
  brand_assets: {
    key: "brand_assets",
    label: "The client's approved brand assets are used — fonts, colors, logo and their music preferences.",
    help: "From the brand kit on this page, never an old download.",
    naAllowed: true,
    naHint: "This product carries no client brand assets.",
  },
  export_upload: {
    key: "export_upload",
    label: "The export is right (1080p), it is the right video and topic, the upload is complete and it plays.",
    naAllowed: false,
  },
  revisions_addressed: {
    key: "revisions_addressed",
    label: "Every outstanding revision is addressed, and I re-checked the rest of the video for anything the fixes broke.",
    naAllowed: false,
    when: "revision",
  },
} satisfies Record<string, SelfCheckItem>;

const ORDER = ["watched_full", "followed_brief", "captions_text", "audio_visual", "brand_assets", "export_upload", "revisions_addressed"] as const;
const base = (over: Partial<Record<(typeof ORDER)[number], Partial<SelfCheckItem>>> = {}): SelfCheckItem[] =>
  ORDER.map((k) => ({ ...ITEM[k], ...(over[k] ?? {}) }));

/** The initial list per product (§8.2's seven, tuned by what each product
 *  actually carries — videoStyles.ts is where those facts live). James refines
 *  them through the `editor_self_check` setting; a refined list bumps its
 *  version so earlier attestations keep the words they were given under. */
export const DEFAULT_SELF_CHECK: Record<string, { name: string; version: number; items: SelfCheckItem[] }> = {
  // B-roll to music: no script, often no text — captions may honestly be N/A.
  standard_reel: { name: "Standard Reel", version: 1, items: base() },
  standard_cinematic: { name: "Standard Cinematic Video", version: 1, items: base() },
  // The agent intro carries kinetic title captions — never N/A.
  standard_reel_agent_intro: {
    name: "Standard Reel with Agent Intro", version: 1,
    items: base({ captions_text: { naAllowed: false, naHint: undefined } }),
  },
  // Kinetic text, the client's brand research and assets are the product.
  personal_branding: {
    name: "Personal Branding Reel", version: 1,
    items: base({ captions_text: { naAllowed: false, naHint: undefined }, brand_assets: { naAllowed: false, naHint: undefined } }),
  },
  premium_social_reel: { name: "Premium Social Media Reel", version: 1, items: base() },
  premium_cinematic: { name: "Premium Cinematic Video", version: 1, items: base() },
  // A legacy folder cut on a multi-video job names no product.
  default: { name: "Video", version: 1, items: base() },
};

/** Resolve a product's list, honouring a stored refinement when it is sane. A
 *  malformed override is ignored rather than trusted: an empty list would
 *  wave every cut through. */
export function resolveSelfCheckProfile(
  styleKey: string | null | undefined,
  overrides?: Record<string, { version?: number; items?: SelfCheckItem[] } | undefined> | null,
): SelfCheckProfile {
  const key = styleKey && DEFAULT_SELF_CHECK[styleKey] ? styleKey : "default";
  const def = DEFAULT_SELF_CHECK[key];
  const o = overrides?.[key];
  const items =
    o && Array.isArray(o.items) && o.items.length > 0 && o.items.every((i) => i && typeof i.key === "string" && typeof i.label === "string" && i.label.trim())
      ? o.items.map((i) => ({ key: i.key, label: i.label.trim(), help: i.help, naAllowed: !!i.naAllowed, naHint: i.naHint, when: i.when === "revision" ? ("revision" as const) : ("always" as const) }))
      : def.items;
  // Watching the actual export is the one line no refinement may remove (§3).
  const withWatch = items.some((i) => i.key === "watched_full") ? items : [ITEM.watched_full, ...items];
  const version = o && typeof o.version === "number" && o.version > def.version ? Math.floor(o.version) : def.version;
  return { styleKey: key, styleName: def.name, version, checklistKey: `${key}@v${version}`, items: withWatch };
}

/** The items THIS submission is asked. The revision line is only asked when
 *  there is something to have revised. */
export function itemsFor(profile: SelfCheckProfile, ctx: { isRevision: boolean; openIssueIds: readonly string[] }): SelfCheckItem[] {
  const revising = ctx.isRevision || ctx.openIssueIds.length > 0;
  return profile.items.filter((i) => i.when !== "revision" || revising);
}

/**
 * Is this set of answers a complete attestation? Pure — the server calls it
 * before it reserves anything, and the dialog calls it to enable Send.
 *   · every asked item is YES, or NA (where the product allows it) with a
 *     reason of at least SELF_CHECK_REASON_MIN characters;
 *   · every issue still open on the slot is declared addressed, or declared
 *     not addressed with a reason — silence is not an answer;
 *   · the list answered is the list in force (a stale dialog is refused).
 */
export function validateSelfCheck(
  profile: SelfCheckProfile,
  input: SelfCheckInput | null | undefined,
  ctx: { isRevision: boolean; openIssueIds: readonly string[] },
): { ok: true; value: ValidatedSelfCheck } | { ok: false; message: string; missing: string[] } {
  if (!input || typeof input !== "object") return { ok: false, message: "Complete the send-for-review check first.", missing: [] };
  if (input.checklistKey !== profile.checklistKey) {
    return { ok: false, message: "The checklist for this video changed while you had it open — close it and answer the current one.", missing: [] };
  }
  const asked = itemsFor(profile, ctx);
  const missing: string[] = [];
  const items: ValidatedSelfCheck["items"] = [];
  for (const it of asked) {
    const a = input.answers?.[it.key];
    const reason = (a?.reason ?? "").trim();
    if (a?.answer === "YES") items.push({ key: it.key, label: it.label, answer: "YES", reason: null });
    else if (a?.answer === "NA" && it.naAllowed && reason.length >= SELF_CHECK_REASON_MIN) {
      items.push({ key: it.key, label: it.label, answer: "NA", reason: reason.slice(0, 300) });
    } else missing.push(it.key);
  }
  const open = [...new Set(ctx.openIssueIds)];
  const declaredAddressed = new Set((input.issues?.addressed ?? []).filter((id) => open.includes(id)));
  const notAddressed: Record<string, string> = {};
  for (const [id, why] of Object.entries(input.issues?.notAddressed ?? {})) {
    const r = String(why ?? "").trim();
    if (open.includes(id) && !declaredAddressed.has(id) && r.length >= SELF_CHECK_REASON_MIN) notAddressed[id] = r.slice(0, 300);
  }
  const undeclared = open.filter((id) => !declaredAddressed.has(id) && !(id in notAddressed));
  if (missing.length || undeclared.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`${missing.length} checklist line${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} a tick (or a reason it doesn't apply)`);
    if (undeclared.length) parts.push(`${undeclared.length} revision note${undeclared.length === 1 ? "" : "s"} need${undeclared.length === 1 ? "s" : ""} "done" or a reason it isn't`);
    return { ok: false, message: `Almost — ${parts.join(" and ")}.`, missing: [...missing, ...undeclared] };
  }
  return { ok: true, value: { items, addressed: [...declaredAddressed], notAddressed } };
}

// ---- which cuts are held -------------------------------------------------------

type HeldShape = { status: string; selfCheckedAt: Date | null; selfCheckId: string | null };

/** A cut that exists but is NOT in front of the reviewer yet: PENDING, bound
 *  to a check record (so it came through a gated door), and no check has been
 *  accepted. Discovered folder cuts, an upload whose bytes did not match what
 *  was checked, and a moved cut all sit here until the editor (or the office
 *  on their behalf) finishes the check. A row with no check id at all is a
 *  pre-gate row: grandfathered, never held. */
export function isHeldForSelfCheck(row: HeldShape): boolean {
  return row.status === "PENDING" && !row.selfCheckedAt && !!row.selfCheckId;
}

/** The same test as a query. */
export function awaitingSelfCheckWhere(): Prisma.ReviewSubmissionWhereInput {
  return { status: "PENDING", selfCheckedAt: null, selfCheckId: { not: null } };
}

/** PENDING and genuinely waiting on a verdict: checked, or from before the
 *  gate existed. Every "waiting on review" reader should ask this. */
export function awaitingReviewWhere(): Prisma.ReviewSubmissionWhereInput {
  return { status: "PENDING", OR: [{ selfCheckedAt: { not: null } }, { selfCheckId: null }] };
}

/** The shape stored in CutSelfCheck.addressedIssueIdsJson. */
export function declarationsJson(v: Pick<ValidatedSelfCheck, "addressed" | "notAddressed">): string {
  return JSON.stringify({ addressed: v.addressed, notAddressed: v.notAddressed });
}

export function parseDeclarations(json: string | null | undefined): IssueDeclarations {
  try {
    const v = JSON.parse(json ?? "{}") as Partial<IssueDeclarations>;
    return { addressed: Array.isArray(v.addressed) ? v.addressed.map(String) : [], notAddressed: v.notAddressed && typeof v.notAddressed === "object" ? v.notAddressed : {} };
  } catch {
    return { addressed: [], notAddressed: {} };
  }
}
