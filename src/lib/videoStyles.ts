// ---------------------------------------------------------------------------
// THE VIDEO TYPES — one authoritative list of what we cut, its tier, style
// requirements, and live example links. Jordan's spec (Aug 14 2026). Shared by:
//   · the Style Guide page (/resources/video-styles — renders example players)
//   · the editor brief's "What to make" section (/edit/[id] — Jordan: "notes
//     about the type of video should be on the editing page in the What to
//     make section, with examples")
//   · EVERY video label the hub prints (Sep 2 2026): the tracker's "Edit type",
//     the "Send to Review" rows, the Review Room cut switcher, the approved
//     file name. Jordan: "in Cuts to Deliver, it shouldn't be called 'Social
//     Reel'; it should be called the correct thing everywhere." The type
//     column (SOCIAL_REEL) and its generic label were all the hub kept of an
//     order line, so "Standard Reel with Agent Intro" (626 Greycliffe) read
//     "Social Reel" on every surface. videoStyleFor() below is the ONE
//     resolver; nothing else may invent a video name.
//   · the EXPORT SPEC (Sep 16 2026) — what the finished file has to be when it
//     leaves Final Cut. Same rule: one wording, read by every surface.
// NO pricing here, ever — creatives read both surfaces.
// This file is imported by CLIENT components (the upload panel). Keep it free
// of prisma / settings / integrations imports — plain data and pure functions.
// ---------------------------------------------------------------------------

export type StyleExample = { label: string; url: string };

/**
 * How long one video of each tier takes to cut — Jordan's numbers, in one
 * place (audit WF-07, Sep 18 2026).
 *
 * The Editing Room shows how MANY jobs each editor holds, and a count cannot
 * compare one premium film with five standard reels or a branding batch. These
 * hours are the lightest possible answer: no new data entry, no timer, nothing
 * for anybody to keep up to date — they are the numbers already printed on the
 * Style Guide, now available as arithmetic. They are an ESTIMATE and every
 * surface that uses them must say so; a range is honest where a single number
 * would not be.
 */
export const EDIT_HOURS = {
  standard: { low: 2, high: 2 },
  premium: { low: 4, high: 6 },
  branding: { low: 7, high: 8 },
} as const;

export type VideoTierKey = keyof typeof EDIT_HOURS;

/** "~2 hours to edit" / "4–6 hours to edit", composed from EDIT_HOURS so the
 *  words on the Style Guide and the numbers behind a workload cannot drift. */
export function editHoursLabel(tier: VideoTierKey): string {
  const { low, high } = EDIT_HOURS[tier];
  return low === high ? `~${low} hours to edit` : `${low}–${high} hours to edit`;
}

/** The estimated hours for `count` videos of one tier, as a range. */
export function estimateEditHours(tier: VideoTierKey, count = 1): { low: number; high: number } {
  const { low, high } = EDIT_HOURS[tier];
  return { low: low * count, high: high * count };
}

export const VIDEO_TIER = {
  standard: { label: "Standard", color: "#38bdf8", edit: editHoursLabel("standard"), turnaround: "Next-day delivery" },
  premium: { label: "Premium", color: "#a78bfa", edit: editHoursLabel("premium"), turnaround: "3-day turnaround" },
  branding: { label: "Personal Branding", color: "#f59e0b", edit: editHoursLabel("branding"), turnaround: "Monthly social schedule" },
} as const;

// The Studio 910 treatment, spelled out once — premium + personal branding
// share it, and "go all out" should mean the same list to every editor.
export const STUDIO_910 = [
  "Effects & creative transitions", "SFX & VFX", "Graphics", "Color grading",
  "Masking", "Kinetic text & titles",
];

// ---------------------------------------------------------------------------
// HOW THE FILE LEAVES FINAL CUT — the export spec, written once here.
//
// Jordan, Sep 16 2026, verbatim: "do not let them upload in 4K it should be
// uploaded in 1080P and that should be in the editor brief that the final files
// should be exported in 1080. So its ok to edit it in 4k but when they export
// it from final cut - it should be exported for social media, 1080P,
// multi-pass."
//
// WHY, because the rule is new and nobody has been doing anything wrong: every
// approved cut now runs through a 1080p finishing pass on its way to the
// client, and that pass is billed on the resolution of the file we HAND IT, not
// the one it gives back. Quoted against the live API on our own two files
// (Sep 16): a 60-second 1080 × 1920 cut came back at 9 credits; a 50-second
// 3840 × 2160 cut quoted 27 and charged 24. That is more than three times the
// cost for a SHORTER video — call it four times per second of footage, which is
// exactly the pixel ratio — and the cut we get back is 1080p either way, since
// 1080p is what we deliver. At ~49 videos a month it is the difference between
// sitting inside the monthly plan and going over it every single month.
//
// Size matters too: 4K is four times the pixels, so it is several times the
// upload, and the pass refuses any file over 500 MB outright — a ceiling our
// longer 1080p cuts already brush (three of them run 478-487 MB).
//
// HOW COMMON, measured off the files themselves on Sep 16 (every cut in the
// system read through its own header — reviewCuts.recordArrivedDimensions is
// the same reader): 22 cuts, NINE of them over spec. Split by how they
// arrived, which is the part that matters —
//   · up the upload panel: 2 of 11 (both 3840 × 2160, Kim's personal-branding
//     pieces on 893 S Matlack);
//   · through the Dropbox Final folder: 7 of 11, every one of them
//     2160 × 3840 — portrait 4K, i.e. vertical reels exported at 4K, which is
//     exactly why the test below is on the SHORT side and not on width.
// The folder cuts are also the enormous ones: 1.5 GB, 2.2 GB, 2.2 GB against
// 80-490 MB for everything that came up the panel. The finishing pass will not
// take a file over 500 MB at all, so those are not merely expensive — they
// don't go through.
//
// Read by: the editor brief's "What to make" and its Send-to-Review panel
// (/edit/[id]), the printable brief (lib/editor-pdf.ts) and the Style Guide
// (/resources/video-styles). ONE copy, exactly like the video names above it —
// a second wording is a second rule, and the two would drift.
//
// No credit counts or dollars here, same as the rest of this file: "about four
// times" is the number an editor needs; the rest is the office's business.
// ---------------------------------------------------------------------------
export const EXPORT_SPEC = {
  /** Short side, in pixels. The short side is the honest test — it passes a
   *  1080 × 1920 vertical reel AND a 1920 × 1080 horizontal video, and catches
   *  4K held either way up (3840 × 2160 and 2160 × 3840 are both over). */
  shortSide: 1080,
  headline: "Export at 1080p",
  edit: "Edit in 4K if you want to — nothing about the edit changes. It's the export that has to be 1080p: the social-media file, not a 4K master.",
  // Jordan's words were "exported for social media, 1080P, multi-pass". Two of
  // those three are things an editor can point at in the Export File dialog and
  // one is not, so the fields are named here (Sep 16 review): Resolution is a
  // popup in the Settings tab, and "multi-pass" is the H.264 encoding option
  // Final Cut labels Better Quality — the slower one. "Social media" is the
  // intent, not a control, so it sits in `edit` above where it reads as intent.
  // Spelled with plain words and commas, never "▸": the printable brief draws
  // in WinAnsi and silently strips anything outside it (lib/editor-pdf clean()),
  // so an arrow would print as a hole in the one copy nobody can re-check.
  finalCut: "From Final Cut: Share, then Export File. In Settings, set Resolution to 1080p and pick the multi-pass H.264 — the option labelled Better Quality, not Faster Encode.",
  orientation: "Keep the shape the style calls for: a vertical reel exports 1080 × 1920, a horizontal video 1920 × 1080.",
  // Sep 17: a client was delivered a silent video. Final Cut's Export File
  // dialog can write uncompressed (Linear PCM) audio, which the 1080p pass
  // cannot carry into an mp4 — it drops the track and reports success. AAC is
  // what every social platform wants anyway, so it is now part of the brief,
  // and a file that arrives with uncompressed audio skips the pass rather than
  // going out silent.
  audio: "Set Audio Format to AAC, not Linear PCM. Uncompressed audio can't go through our 1080p pass, and a video that loses its sound can't go out.",
  why: "Everything we deliver goes out at 1080p, and a 4K master costs about four times as much to finish — for a file that ends up 1080p anyway.",
} as const;

/** The spec as plain lines, in the order an editor needs them — for the
 *  printable brief and anywhere else a list beats a card. */
export const EXPORT_SPEC_LINES: readonly string[] = [
  EXPORT_SPEC.finalCut,
  EXPORT_SPEC.edit,
  EXPORT_SPEC.orientation,
  EXPORT_SPEC.audio,
  EXPORT_SPEC.why,
];

/** Is this file over spec? FAIL OPEN on anything we can't measure: a width of
 *  0, a NaN, a browser that couldn't read the header — an unknown file is not
 *  an over-spec file, and a diagnostic must never be the thing that stops an
 *  editor delivering. */
export function isOverExportSpec(width: number | null | undefined, height: number | null | undefined): boolean {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  return Math.min(w, h) > EXPORT_SPEC.shortSide;
}

/** "3840 × 2160" — one spelling of a resolution, everywhere one is printed. */
export function resolutionLabel(width: number | null | undefined, height: number | null | undefined): string | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return `${w} × ${h}`;
}

/**
 * What an editor reads when a file is stopped — the words of the refusal, in
 * one place, so the browser dialog and the server's own answer say the same
 * thing. The FIRST line is the one that matters: somebody has just finished a
 * seven-hour personal-branding edit and been told "no" by a dialog, and the
 * thing they need to know before anything else is that the work is fine.
 *
 * And it ALWAYS ends with a way out (`stuck`, Sep 16 review). Re-exporting is
 * a two-minute job on a good evening; on a bad one Final Cut has crashed, the
 * media is offline, or it is 7pm and the client is waiting. A refusal with no
 * named next step leaves an editor holding a finished edit and no route — and
 * an editor who cannot deliver is a worse outcome than a 4K file getting
 * through. Kyle is that route: an ADMIN, so the override button is really his
 * to press (startCutUpload), and the person they already message about a job.
 */
export function exportRefusal(width: number | null | undefined, height: number | null | undefined) {
  const res = resolutionLabel(width, height);
  return {
    lead: "Nothing's wrong with your edit — this is a two-minute re-export from the same timeline, not a re-edit.",
    what: res
      ? `That file is ${res}. We deliver at 1080p, so 1080p is what comes in.`
      : "That file is bigger than 1080p. We deliver at 1080p, so 1080p is what comes in.",
    fix: EXPORT_SPEC.finalCut,
    orientation: EXPORT_SPEC.orientation,
    why: EXPORT_SPEC.why,
    stuck: "Can't re-export right now — Final Cut playing up, media offline, no time before the deadline? Message Kyle. He can send this exact file through for you, so a delivery never waits on this.",
  };
}

/** The same refusal as one string, for a server action's `message` and any
 *  other surface with a single line to spend. `stuck` rides along: this is the
 *  wording an editor gets when the CARD never drew (the server refused a
 *  request the browser's own check didn't stop), which is precisely the moment
 *  they have nothing else on screen telling them what to do next. */
export function exportRefusalMessage(width: number | null | undefined, height: number | null | undefined): string {
  const r = exportRefusal(width, height);
  return `${r.lead} ${r.what} ${r.fix} ${r.stuck}`;
}

// ---------------------------------------------------------------------------
// STABLE KEYS — the shared contract with the product catalog and the Aryeo
// sync. `Product.videoStyle` (a human pins one per product on /settings/
// products) and `Deliverable.videoStyle` (resolved at sync: the pin, else the
// order-item title) store one of these. A key never changes once stored; the
// display name beside it is free to. Add a type → add a key here.
// ---------------------------------------------------------------------------
export const VIDEO_STYLE_KEYS = [
  "standard_reel",
  "standard_reel_agent_intro",
  "standard_cinematic",
  "personal_branding",
  "premium_social_reel",
  "premium_cinematic",
] as const;
export type VideoStyleKey = (typeof VIDEO_STYLE_KEYS)[number];

export function isVideoStyleKey(k: unknown): k is VideoStyleKey {
  return typeof k === "string" && (VIDEO_STYLE_KEYS as readonly string[]).includes(k);
}

export type VideoStyleType = {
  key: VideoStyleKey;
  name: string;
  tier: keyof typeof VIDEO_TIER;
  style: string[];
  examples: StyleExample[];
  note?: string;
};

export const VIDEO_TYPES: VideoStyleType[] = [
  {
    key: "standard_reel",
    name: "Standard Reel",
    tier: "standard",
    style: ["Speed ramps", "Light sound design", "Light transitions", "No crazy effects"],
    examples: [{ label: "Example", url: "https://media.realtourpilot.com/videos/01989067-fd1c-73ae-a19d-c231f9a764be?v=316" }],
  },
  {
    key: "standard_reel_agent_intro",
    name: "Standard Reel with Agent Intro",
    tier: "standard",
    style: [
      "Speed ramps", "Light sound design", "Light transitions", "No crazy effects",
      "Agent-on-camera intro with kinetic title captions",
    ],
    examples: [{ label: "Example", url: "https://media.realtourpilot.com/videos/019e4ae2-e3de-7223-985a-74ae8f1612e9?v=437" }],
  },
  {
    key: "standard_cinematic",
    name: "Standard Cinematic Video",
    tier: "standard",
    style: ["Speed ramps", "Light sound design", "Light transitions", "No crazy effects"],
    examples: [{ label: "Example", url: "https://media.realtourpilot.com/videos/019e6f2b-44e3-7259-bad0-07709cb5940b?v=479" }],
  },
  {
    key: "personal_branding",
    name: "Personal Branding Reel",
    tier: "branding",
    style: [...STUDIO_910],
    note:
      "These take the longest of anything we make — the kinetic text and titles, the color grade, and the client research + brand asset collection and usage all take real time. Budget the full 7–8 hours and use them.",
    examples: [{ label: "Example", url: "https://media.realtourpilot.com/videos/019e8836-35e4-735c-b144-af78e7e21353?v=326" }],
  },
  {
    key: "premium_social_reel",
    name: "Premium Social Media Reel",
    tier: "premium",
    style: [
      ...STUDIO_910,
      "Storytelling", "Ryan Nangle transitions", "Best color possible",
      "Best clips only", "Best flow",
    ],
    note:
      "Premium comes in more than one voice — match the energy to the listing and the agent. Two lanes we cut in today:",
    examples: [
      { label: "Fast-paced 1", url: "https://media.realtourpilot.com/videos/01a00c9d-dc90-719c-a26b-1d06dabc474c?v=222" },
      { label: "Fast-paced 2", url: "https://media.realtourpilot.com/videos/019fa9fb-5e53-7117-af9d-69b2cbd9cfbd?v=341" },
      { label: "Fast-paced 3", url: "https://media.realtourpilot.com/videos/019fab09-c9bc-7275-a013-6b14d73213fd?v=9" },
      { label: "Timeless & Elegant 1", url: "https://media.realtourpilot.com/videos/019f681f-4840-7131-90b7-aef2a372c033?v=307" },
      { label: "Timeless & Elegant 2", url: "https://media.realtourpilot.com/videos/019dd0a6-6373-7385-863b-581ce5f5c436?v=195" },
    ],
  },
  // The premium HORIZONTAL cut. Not in the Aug 14 spec, but it is a real,
  // separately-sold product ("Premium Cinematic Video", the video in Premium
  // Package / STR PRO BUNDLE; 17 live "Premium Video" rows + "Premium
  // Horizontal Video") and the only premium entry above is the vertical reel
  // — a premium property video was being briefed as a social reel. Same
  // Studio 910 treatment as the premium reel, 16:9. No example link yet:
  // Jordan to add one (the carousel simply renders nothing until then).
  {
    key: "premium_cinematic",
    name: "Premium Cinematic Video",
    tier: "premium",
    style: [
      ...STUDIO_910,
      "Storytelling", "Ryan Nangle transitions", "Best color possible",
      "Best clips only", "Best flow", "Horizontal 16:9 — the property video, not a reel",
    ],
    examples: [],
  },
];

const BY_KEY: Record<VideoStyleKey, VideoStyleType> = Object.fromEntries(
  VIDEO_TYPES.map((t) => [t.key, t]),
) as Record<VideoStyleKey, VideoStyleType>;

/** The style behind a stored key — null for anything that is not a key
 *  (a legacy label someone typed into the column, an empty string). */
export function videoStyleByKey(key: string | null | undefined): VideoStyleType | null {
  return isVideoStyleKey(key) ? BY_KEY[key] : null;
}

/** Display name for a stored key ("standard_reel_agent_intro" → "Standard
 *  Reel with Agent Intro"); null when the key is unknown so a caller can
 *  fall back rather than print a snake_case token to an editor. */
export function videoStyleName(key: string | null | undefined): string | null {
  return videoStyleByKey(key)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Is THIS project a monthly personal-branding / social-content job (7–10
// business-day turnaround, Kim's lane), or a normal listing shoot?
// `Client.socialClient` is a CLIENT attribute — using it alone branded every
// listing shoot those agents booked as "monthly content" (wrong QC copy,
// wrong SLA, wrong editor routing — caught live on 523 S Coventry / 238
// Hudson / 419 Riverview, July 2026). Jordan's definitive rule: monthly
// content is one of the three PLANS — Video Starter, Video Accelerator, or
// Video Pro — and those names appear right on the order item ("Video Starter
// - 2h session", "Video Accelerator - 4HR Content Session", …). Anything else
// — including a one-off "Premium Social Reel" at an office address — is NOT
// monthly. (\b after "pro" keeps "Video Production" from matching.)
// ---------------------------------------------------------------------------
// The Aryeo sync uses this to KEEP a plan title as the deliverable label (a
// generic "Video" label destroys the monthly signal — Aug 18 audit: 39 live
// monthly-plan jobs classified as ordinary listing videos). Also broadened:
// "Monthly Social Media Content Session" / "August Social Media Content Day"
// / "Branding Shoot" are monthly-content wordings the old adjacent-words
// regex missed.
// Defined HERE (re-exported by lib/pipeline, which everyone imports it from)
// because the personal-branding style is decided by the same words and
// pipeline.ts imports this module — a second copy of the regex would drift,
// and an import the other way would be a cycle.
// Sep 16 (Kyle call, Sharra Mercer #1584): "Custom Branding Video Package 16
// Videos Total" is a branding package sold OUTSIDE the three named plans — the
// premium reel she booked was swapped for it after the shoot. Nothing here
// matched it ("branding shoot/session" did not cover "branding video
// package"), so a 16-video branding job ran on the 48-hour single-reel clock
// and every card it owned read overdue from Sep 11. `branding` followed by the
// product word now counts, and so does an explicit "N videos total" batch —
// both are statements that this is a content package, not one listing reel.
// The batch arm is floored at FOUR (Sep 16 review): a listing product can say
// "2 Videos Total" and still be two 48-hour reels, but nobody sells four or
// more videos off one shoot except as a content package, so a small batch
// keeps its ordinary clock.
export const MONTHLY_PLAN_RE =
  /video\s*[-–]?\s*(starter|accelerator|pro)\b|monthly\s+(social\s+)?(media\s+)?content|social\s+(media\s+)?content|personal[-\s]*brand|content\s+(session|day)\b|branding\s+(shoot|session|video|package|content)\b|\b(?:[4-9]|\d{2,})\s+videos?\s+total\b/i;

// The tier words, as videoTier() / aryeo.ts isPremiumProduct read them, with
// the same explicit-"standard" veto ("Standard Cinematic Video" is standard;
// "STR Luxury Cinematic Video Tour" is human-mapped standard).
const PREMIUM_RE = /premium|influencer|luxury|signature|elite|flagship/i;
const STANDARD_VETO_RE = /\bstandard\b/i;
// Horizontal property video vs a vertical reel. Words first; when the name
// says neither, the deliverable TYPE breaks the tie the way the catalog maps
// products: VIDEO is the property video, SOCIAL_REEL the reel.
const CINEMATIC_RE = /cinematic|horizontal|walk-?through|website\s+video/i;
const REEL_RE = /\breels?\b|\bsocial\b|instagram|\big\b|vertical/i;
// Agent-on-camera intro (the upload portal's AGENT_INTRO_RE, same wordings).
// Checked AFTER premium: "Premium Social Media Reel (No Agent on camera or
// Exteriors)" names it inside a negation (live data).
const AGENT_INTRO_RE = /agent[-\s]*intro|agent\s+on\s+camera|intro\s*(and|&|\+|\/)\s*outro/i;

/** The product mapping's tier vocabulary (Product.videoTier) — a human's
 *  verdict, which outranks any word in the title. */
export type VideoStyleTier = "standard" | "premium" | "personal_branding";

/**
 * The style an order-item TITLE (or a label) describes — the heuristic core
 * behind videoStyleFor(), exported on its own so the Aryeo sync can resolve
 * `Deliverable.videoStyle` for a product nobody has pinned yet with the exact
 * rules the display uses (the two can never disagree).
 *   · opts.tier    — Product.videoTier from the mapping, or videoTier()'s
 *                    verdict on the job (both mean "a human/mapping said so").
 *   · opts.type    — the deliverable's DeliverableType, the horizontal/
 *                    vertical tiebreaker for a name that says neither.
 *   · opts.monthly — the PROJECT-level isMonthlyContentJob verdict; the
 *                    plan-name regex is only the safety net when it's absent.
 */
export function videoStyleKeyForTitle(
  title: string | null | undefined,
  opts: { tier?: VideoStyleTier | null; type?: string | null; monthly?: boolean } = {},
): VideoStyleKey {
  const t = (title ?? "").trim();
  const tier = opts.tier ?? null;
  // 1. Personal branding — the monthly plans. The mapping/project verdict is
  //    the real signal; the words are the fallback (see MONTHLY_PLAN_RE).
  if (tier === "personal_branding" || opts.monthly || MONTHLY_PLAN_RE.test(t)) return "personal_branding";
  // 2. Premium — a stated tier wins outright; otherwise the premium words,
  //    vetoed by an explicit "standard" (videoTier()'s rule).
  const premium = tier === "premium" || (tier !== "standard" && PREMIUM_RE.test(t) && !STANDARD_VETO_RE.test(t));
  // 3. Horizontal vs vertical.
  const cinematic = CINEMATIC_RE.test(t) || (!REEL_RE.test(t) && (opts.type ?? "").toUpperCase() === "VIDEO");
  if (premium) return cinematic ? "premium_cinematic" : "premium_social_reel";
  if (cinematic) return "standard_cinematic";
  if (AGENT_INTRO_RE.test(t)) return "standard_reel_agent_intro";
  return "standard_reel";
}

/** What a video deliverable row carries that names its style. Every field is
 *  optional so a bare `{ type, label }` from an older select still resolves. */
export type VideoStyleInput = {
  type?: string | null;
  label?: string | null;
  /** Deliverable.videoStyle — resolved at sync; a VideoStyleKey when set. */
  videoStyle?: string | null;
  /** Deliverable.productTitle — the Aryeo order-item name, verbatim. */
  productTitle?: string | null;
};

/**
 * THE resolver: which style a deliverable is. Precedence —
 *   1. `videoStyle` — resolved at sync (a human's Product.videoStyle pin, or
 *      the title rule at sync time). Only an exact key counts.
 *   2. `productTitle` — the order line's real name ("Standard Reel with Agent
 *      Intro", "Photography and Standard Reel w/ Agent intro"), read with the
 *      caller's tier/monthly verdicts.
 *   3. label + tier heuristics — rows synced before the two columns existed
 *      (the generic "Social Reel"/"Video" labels the old sync kept), exactly
 *      what videoTypeLabel did: a generic label takes the job's tier and the
 *      type's shape (reel vs video), a specific label is read for its words.
 * Never null — an unrecognised video is a Standard Reel, as before.
 */
export function videoStyleFor(
  d: VideoStyleInput,
  opts: { monthly?: boolean; tier?: "standard" | "premium" | null } = {},
): VideoStyleType {
  const pinned = videoStyleByKey(d.videoStyle);
  if (pinned) return pinned;
  const title = (d.productTitle ?? "").trim() || (d.label ?? "").trim();
  return BY_KEY[videoStyleKeyForTitle(title, { tier: opts.tier ?? null, type: d.type, monthly: opts.monthly })];
}

/** @deprecated Label-only entry point kept for the edit page's "What to
 *  make" cards — pass the whole deliverable to videoStyleFor() instead so a
 *  pinned videoStyle / productTitle is honoured. */
export function videoTypeForDeliverable(label: string | null | undefined, monthly: boolean): VideoStyleType {
  return videoStyleFor({ label }, { monthly });
}
