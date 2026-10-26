// ---------------------------------------------------------------------------
// VIDEO FORMAT, PER VIDEO (Oct 22 2026). The pure half: no I/O, safe to
// import from client components.
//
// Jordan: "I want to add the ability to do direct to camera videos and
// skits." Bernadette Rabel's Oct 21 strategy call: her account was set to
// Direct-to-camera, but they agreed on a MIX: 2 skits a month, the rest
// talking to camera, with her husband acting in the skits. Skits are good
// for attention and personality, but done too much "this guy's just playing
// around", so most accounts stay mostly direct and one (Joe Sutow) is skits
// for nearly every video.
//
//   The ACCOUNT's style (Settings > Program style) is the default:
//     DIRECT ("Direct-to-camera", a missing value, today's behaviour),
//     SKITS ("Skits"), or MIX ("Mix": a target number of skits a month,
//     overridesJson.skitsPerMonth, the rest talking to camera).
//   Each VIDEO has a format: DIRECT ("Talking to camera") or SKIT ("Skit").
//     A topic's format lives in ContentTopic.scoresJson.videoFormat (a JSON
//     bag the code never otherwise reads; 190 imported rows hold a scores
//     `summary` in it, which is kept). No format = the account default:
//     SKIT on a Skits account, DIRECT on a Direct or Mix account, so nothing
//     already on file changes.
//     A script version records the format it was written in
//     (validationJson.videoFormat); an older version without it reads as a
//     skit when it carries speaker labels, else talking to camera.
//   The cast: overridesJson.skitCast, people the client confirmed may act in
//     their skits (prompts.ts skitCastBlock).
//
// No column was added: every value rides in a JSON field that already
// exists, so nothing waits on a schema push.
// ---------------------------------------------------------------------------

export type VideoStyle = "DIRECT" | "SKITS" | "MIX";
export type VideoFormat = "DIRECT" | "SKIT";

export const VIDEO_STYLES: readonly VideoStyle[] = ["DIRECT", "SKITS", "MIX"];
export const VIDEO_FORMATS: readonly VideoFormat[] = ["DIRECT", "SKIT"];
export const VIDEO_STYLE_LABEL: Record<VideoStyle, string> = { DIRECT: "Direct-to-camera", SKITS: "Skits", MIX: "Mix" };
export const VIDEO_FORMAT_LABEL: Record<VideoFormat, string> = { DIRECT: "Talking to camera", SKIT: "Skit" };

/** ContentEnrollment.overridesJson keys. */
export const VIDEO_STYLE_OVERRIDE_KEY = "videoStyle";
export const SKITS_PER_MONTH_KEY = "skitsPerMonth";
export const SKIT_CAST_KEY = "skitCast";
/** ContentTopic.scoresJson key, and ContentScriptVersion.validationJson key. */
export const TOPIC_FORMAT_KEY = "videoFormat";
export const VERSION_FORMAT_KEY = "videoFormat";

/** Bernadette's number; what a Mix account targets until the office types another. */
export const DEFAULT_MIX_SKITS_PER_MONTH = 2;
export const MAX_SKITS_PER_MONTH = 8;
export const MAX_SKIT_CAST = 6;

function bagOf(json: string | Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  let bag: unknown = json;
  if (typeof json === "string") {
    try { bag = JSON.parse(json); } catch { return null; }
  }
  return bag && typeof bag === "object" && !Array.isArray(bag) ? (bag as Record<string, unknown>) : null;
}

/** The account style. Anything that is not SKITS or MIX reads as DIRECT (the default, today's behaviour). */
export function asVideoStyle(v: unknown): VideoStyle {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s === "SKITS" ? "SKITS" : s === "MIX" ? "MIX" : "DIRECT";
}

/** One video's format, or null when none is set. "SKITS" is read as SKIT, so an account value is never misread. */
export function asVideoFormat(v: unknown): VideoFormat | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s === "SKIT" || s === "SKITS" ? "SKIT" : s === "DIRECT" ? "DIRECT" : null;
}

/** The style from ContentEnrollment.overridesJson (a JSON string or the parsed bag). */
export function videoStyleFromOverrides(overrides: string | Record<string, unknown> | null | undefined): VideoStyle {
  const bag = bagOf(overrides);
  return bag ? asVideoStyle(bag[VIDEO_STYLE_OVERRIDE_KEY]) : "DIRECT";
}

/** A Mix account's target number of skits a month; null for any other style. */
export function skitsPerMonthFromOverrides(overrides: string | Record<string, unknown> | null | undefined): number | null {
  const bag = bagOf(overrides);
  if (!bag || asVideoStyle(bag[VIDEO_STYLE_OVERRIDE_KEY]) !== "MIX") return null;
  return clampSkitsPerMonth(bag[SKITS_PER_MONTH_KEY]);
}

export function clampSkitsPerMonth(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SKITS_PER_MONTH) : DEFAULT_MIX_SKITS_PER_MONTH;
}

/** What a video with no format of its own is: a skit on a Skits account, talking to camera on a Direct or Mix one. */
export function defaultFormatFor(style: VideoStyle | null | undefined): VideoFormat {
  return style === "SKITS" ? "SKIT" : "DIRECT";
}

/** Skit concepts belong in this account's topic bank (Skits or Mix). */
export function skitsOn(style: VideoStyle | null | undefined): boolean {
  return style === "SKITS" || style === "MIX";
}

// ---- topics --------------------------------------------------------------------

/** A topic's OWN format (ContentTopic.scoresJson.videoFormat), or null when it follows the account. */
export function topicFormatOf(scoresJson: string | null | undefined): VideoFormat | null {
  const bag = bagOf(scoresJson);
  return bag ? asVideoFormat(bag[TOPIC_FORMAT_KEY]) : null;
}

/** scoresJson with the format set (or cleared with null), every other key kept. Null when the bag ends up empty. */
export function withTopicFormat(scoresJson: string | null | undefined, format: VideoFormat | null): string | null {
  const bag = { ...(bagOf(scoresJson) ?? {}) };
  if (format) bag[TOPIC_FORMAT_KEY] = format;
  else delete bag[TOPIC_FORMAT_KEY];
  return Object.keys(bag).length ? JSON.stringify(bag) : null;
}

/** The format a topic is planned in: its own, else the account's default. */
export function resolvedTopicFormat(own: VideoFormat | null | undefined, style: VideoStyle | null | undefined): VideoFormat {
  return own ?? defaultFormatFor(style);
}

// ---- script versions -------------------------------------------------------------

/**
 * The format a version was WRITTEN in: the stamp a draft or revision records,
 * else a skit when it carries speaker labels (every skit we drafted or read
 * from an upload does), else null (unknown: an older talking-to-camera draft,
 * or a hand-typed script).
 */
export function versionFormatOf(v: { validationJson?: string | null; speakerLabelsJson?: string | null } | null | undefined): VideoFormat | null {
  if (!v) return null;
  const stamped = asVideoFormat(bagOf(v.validationJson)?.[VERSION_FORMAT_KEY]);
  if (stamped) return stamped;
  let labels: unknown = null;
  try { labels = v.speakerLabelsJson ? JSON.parse(v.speakerLabelsJson) : null; } catch { labels = null; }
  return Array.isArray(labels) && labels.length > 0 ? "SKIT" : null;
}

/** What a reader is shown for a version: its own format, else talking to camera. */
export function shownVersionFormat(v: { validationJson?: string | null; speakerLabelsJson?: string | null } | null | undefined): VideoFormat {
  return versionFormatOf(v) ?? "DIRECT";
}

/**
 * THE FORMAT A NEW DRAFT OR REVISION IS WRITTEN IN. The topic's own format
 * wins (the office chose it); a revision with no topic format keeps the
 * format of the version it revises (a skit stays a skit, even an uploaded one
 * on a Direct account); otherwise the account's default.
 */
export function formatForWrite(o: { topicFormat?: VideoFormat | null; baseFormat?: VideoFormat | null; style: VideoStyle | null | undefined }): VideoFormat {
  return o.topicFormat ?? o.baseFormat ?? defaultFormatFor(o.style);
}

// ---- which writer drafts it ---------------------------------------------------------

export type ScriptRoute = "skit" | "writer" | "direct";

/**
 * WHICH WRITER DRAFTS A VIDEO, one rule for both draft paths (the call path
 * and the written-answers path in contentGeneration.ts). A SKIT always goes to
 * the skit path (the existing writer with SKIT_SCRIPT_BLOCK and
 * skitScriptSchema), even when the new writer (src/lib/scriptWriter, switch
 * script_writer_v2) is on, because the new writer has no skit brief yet. A
 * talking-to-camera video goes to the new writer when its switch is on for the
 * client, else to the existing direct prompt.
 */
export function scriptRoute(format: VideoFormat, writerOn: boolean): ScriptRoute {
  if (format === "SKIT") return "skit";
  return writerOn ? "writer" : "direct";
}

// ---- a Mix month's target -----------------------------------------------------------

export type SkitTarget = { picked: number; target: number; met: boolean; line: string };

/** "1 of 2 skits picked": a count shown beside the month, never a block. */
export function skitTargetFor(formats: readonly VideoFormat[], target: number | null | undefined): SkitTarget | null {
  if (!target || target < 1) return null;
  const picked = formats.filter((f) => f === "SKIT").length;
  return { picked, target, met: picked >= target, line: `${picked} of ${target} skit${target === 1 ? "" : "s"} picked` };
}

// ---- both formats in every pillar (Oct 26 2026) -------------------------------------

/**
 * PER-PILLAR FORMATS (Oct 26 2026). Jordan: "anyone that does skits, needs
 * skit concepts as video topics ... They should be able to switch back and
 * forth between direct to camera and skits for each pillar." And: "the skits
 * and topics need to be built around them and their content strategy and
 * strategy calls that we have had."
 *
 * On an account that does skits (Skits or Mix) EVERY pillar holds both
 * formats: the account's MAIN format at the policy's count per pillar (as
 * before), and the OTHER format at OTHER_FORMAT_PER_PILLAR.
 *   Skits: skit concepts are the main format; 5 talking-to-camera topics a pillar.
 *   Mix:   talking to camera is the main format; 5 skit concepts a pillar.
 * A Direct account has one format and is unchanged everywhere.
 *
 * This replaced the one "Skits" section above the pillars (Oct 22): each
 * pillar heading now carries a two-option switch, "Talking to camera | Skits",
 * with the count on each option, office and portal.
 */
export const OTHER_FORMAT_PER_PILLAR = 5;

/** The format most of an account's videos are in: a skit on a Skits account, talking to camera otherwise. */
export function mainFormatFor(style: VideoStyle | null | undefined): VideoFormat {
  return defaultFormatFor(style);
}

export function otherFormat(f: VideoFormat): VideoFormat {
  return f === "SKIT" ? "DIRECT" : "SKIT";
}

export type PillarFormatTarget = { format: VideoFormat; main: boolean; target: number };

/**
 * What one pillar is stocked to, per format, on an account that does skits:
 * the main format at the policy's count, the other at OTHER_FORMAT_PER_PILLAR
 * (main first). Null on a Direct account: one format, the policy's count.
 */
export function pillarFormatTargets(style: VideoStyle | null | undefined, policyCount: number): PillarFormatTarget[] | null {
  if (!skitsOn(style)) return null;
  const main = mainFormatFor(style);
  return [{ format: main, main: true, target: policyCount }, { format: otherFormat(main), main: false, target: OTHER_FORMAT_PER_PILLAR }];
}

/** The pillar switch's two options, always in this order. */
export const FORMAT_SWITCH_OPTIONS: readonly { format: VideoFormat; label: string }[] = [
  { format: "DIRECT", label: "Talking to camera" },
  { format: "SKIT", label: "Skits" },
];

/** How a request or a count names the format in plain words: "skit concepts", "talking-to-camera topics". */
export const FORMAT_PLURAL: Record<VideoFormat, string> = { DIRECT: "talking-to-camera topics", SKIT: "skit concepts" };

/** How many of these topics are in each format. */
export function formatCounts<T>(topics: readonly T[], formatOf: (t: T) => VideoFormat): Record<VideoFormat, number> {
  const out: Record<VideoFormat, number> = { DIRECT: 0, SKIT: 0 };
  for (const t of topics) out[formatOf(t)]++;
  return out;
}

// ---- the cast -------------------------------------------------------------------------

/** Someone the client confirmed may act in their skits. */
export type SkitCastMember = {
  id: string;
  /** First name, when the client gave one. */
  name: string | null;
  /** Who they are to the client, in plain words ("Her husband", "Business partner"). */
  role: string;
  /** What the writer should know ("A voice impressionist. Happy to act."). */
  note: string | null;
  addedBy: string | null;
  addedAt: string | null;
};

const castText = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[‒-―]/g, ",").replace(/\s+/g, " ").trim().slice(0, max) : "");

export function cleanCastMember(raw: unknown): SkitCastMember | null {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const role = castText(o.role, 60);
  if (!role) return null;
  const id = castText(o.id, 40) || `cast_${Math.abs(hash(`${role}|${castText(o.name, 40)}`)).toString(36)}`;
  return { id, name: castText(o.name, 40) || null, role, note: castText(o.note, 240) || null, addedBy: castText(o.addedBy, 120) || null, addedAt: castText(o.addedAt, 40) || null };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** The confirmed cast from ContentEnrollment.overridesJson; [] when none. */
export function skitCastFromOverrides(overrides: string | Record<string, unknown> | null | undefined): SkitCastMember[] {
  const bag = bagOf(overrides);
  const list = bag?.[SKIT_CAST_KEY];
  if (!Array.isArray(list)) return [];
  return list.map(cleanCastMember).filter((m): m is SkitCastMember => !!m).slice(0, MAX_SKIT_CAST);
}

/** How a cast member is named in a prompt or on a card: "Her husband (Mark)". */
export function castMemberLabel(m: Pick<SkitCastMember, "name" | "role">): string {
  return m.name ? `${m.role} (${m.name})` : m.role;
}
