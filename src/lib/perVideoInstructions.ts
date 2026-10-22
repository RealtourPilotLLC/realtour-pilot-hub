import { meaningfulBrief } from "@/lib/handoff";
import type { VideoStyleKey } from "@/lib/videoStyles";

// ---------------------------------------------------------------------------
// ONE SET OF INSTRUCTIONS PER VIDEO (Oct 22 2026). Jordan: "Add two videos to
// the brief, and a separate instructions area for the upload portal so
// instructions can be added for both videos." 538 Onward Ave owes a premium
// reel (S-Log3 / D-LogM, a Happy Gilmore skit) and a standard highlight reel,
// and the one videoInstructions field could only describe one of them.
//
// WHERE EACH VIDEO'S WORDS LIVE, additively (no new column):
//   · video 1 keeps Project.videoInstructions, exactly as before. Every older
//     reader (the printed brief, the editor packet, the music picker, the
//     KPI, the nudge) keeps reading the first video's words there, and a
//     one-video job is untouched.
//   · video 2 and on keep theirs on their own DeliverableOutput row, in
//     filmingNote: "the photographer's note to the editor about this video".
//     A content session puts its per-topic note there; a listing job had
//     nothing in it. outputBriefsFor already carries it to the editor's page,
//     the printed brief and the agency packet as that video's own note.
// A video with no words of its own goes by the job's (video 1's) words and
// says so; for the completeness checks that does NOT count as its own.
//
// Pure, and safe in the browser (the upload page reads the shapes from here).
// ---------------------------------------------------------------------------

/** How much the upload page asks for, by video style (the portal's BRIEF_BY_STYLE). */
export type BriefShape = "minimal" | "agent_intro" | "full";
export const BRIEF_SHAPE_BY_STYLE: Record<VideoStyleKey, BriefShape> = {
  standard_reel: "minimal",
  standard_reel_agent_intro: "agent_intro",
  standard_cinematic: "minimal",
  personal_branding: "full",
  premium_social_reel: "full",
  premium_cinematic: "full",
};

export type VideoTierWord = "premium" | "standard" | "branding";
export function tierOfStyle(style: VideoStyleKey): VideoTierWord {
  return style.startsWith("premium") ? "premium" : style === "personal_branding" ? "branding" : "standard";
}
/** "Premium, 3-day turnaround" — the words the brief and the upload page print beside a video. */
export function tierWords(style: VideoStyleKey): string {
  const t = tierOfStyle(style);
  return t === "premium" ? "Premium" : t === "branding" ? "Monthly content" : "Standard";
}

/**
 * From when a later video's own instructions are owed. A video half handed in
 * before this was never shown a second area, so it is never retro-flagged
 * (the house rule: a job already submitted is not blocked by a new required
 * field). Fri Oct 23 2026, 12:00 AM ET: the day after the page shipped. If it
 * ships later, move this to that day.
 */
export const PER_VIDEO_FROM = new Date("2026-10-23T04:00:00.000Z");
/** Is a later video's own instructions owed for a video half handed in at `handedInAt` (null = not yet)? */
export function perVideoRuleApplies(handedInAt: Date | null | undefined): boolean {
  return !handedInAt || handedInAt.getTime() >= PER_VIDEO_FROM.getTime();
}

/** The saved "COLOR PROFILE: …" line the editor grades by (upload/actions.ts checks the same values). */
export const COLOR_PROFILE_LINE_RE = /^COLOR PROFILE:\s*(iPhone|S-Log3|D-LogM|S-Log3, D-LogM)\s*$/im;

export type PerVideoRow = {
  /** `${deliverableId}:${slot}`, the cut key */
  key: string;
  deliverableId: string;
  slot: number;
  /** the DeliverableOutput row (null until the job's video rows are materialised) */
  outputId: string | null;
  /** 1-based, in the order the cut slots run */
  number: number;
  /** what the video is called everywhere ("Premium Social Reel") */
  label: string;
  style: VideoStyleKey;
  shape: BriefShape;
  /** this video's OWN words (video 1: the job's field; later videos: their own row) */
  own: string | null;
  /** what the editor reads: its own words, else the job's */
  text: string | null;
  source: "own" | "job" | "none";
  /** when the video's row was made: a video the hub set up after the handoff is not the photographer's miss */
  createdAt: Date | null;
};

/**
 * Every owed video with its instructions (pure). Split per video only on a
 * listing job owing two or more videos; a one-video job and a monthly batch
 * (one shared brief plus a note per topic) come back as ONE row carrying the
 * job's field, exactly as before.
 */
export function perVideoInstructions(input: {
  slots: { deliverableId: string; slot: number; label: string }[];
  styleOf: (deliverableId: string) => VideoStyleKey;
  outputs: { id: string; deliverableId: string; slot: number; filmingNote: string | null }[];
  createdAtOf?: (deliverableId: string) => Date | null;
  videoInstructions: string | null;
  monthly: boolean;
}): PerVideoRow[] {
  const job = input.videoInstructions?.trim() || null;
  const outputOf = new Map(input.outputs.map((o) => [`${o.deliverableId}:${o.slot}`, o]));
  const split = input.slots.length > 1 && !input.monthly;
  const slots = split ? input.slots : input.slots.slice(0, 1);
  return slots.map((s, i) => {
    const key = `${s.deliverableId}:${s.slot}`;
    const out = outputOf.get(key) ?? null;
    const style = input.styleOf(s.deliverableId);
    const own = i === 0 ? job : out?.filmingNote?.trim() || null;
    const text = own ?? job;
    return {
      key,
      deliverableId: s.deliverableId,
      slot: s.slot,
      outputId: out?.id ?? null,
      number: i + 1,
      label: s.label,
      style,
      shape: BRIEF_SHAPE_BY_STYLE[style] ?? "minimal",
      own,
      text,
      source: own ? "own" : job ? "job" : "none",
      createdAt: input.createdAtOf?.(s.deliverableId) ?? null,
    };
  });
}

/**
 * What a LATER video (2 and on) of a multi-video job is missing, in the
 * handoff engine's words, or null when it has what its shape asks for (pure).
 * Video 1 is the job's field and keeps the rules it always had (handoff.ts).
 * A video without words of its own is missing them even when the job has
 * some: that is the whole point (Jordan, Oct 22 2026). A plain reel asks for
 * the least: words of its own, at minimum the color profile it was shot in.
 */
export function laterVideoGap(row: PerVideoRow, opts: { instructionsInDropbox?: boolean } = {}): string | null {
  if (row.number < 2) return null;
  const own = row.own ?? "";
  const name = `video ${row.number} (${row.label})`;
  if (opts.instructionsInDropbox && row.shape !== "minimal") return null;
  if (!own.trim()) return `the instructions for ${name}`;
  if (row.shape === "minimal") return COLOR_PROFILE_LINE_RE.test(own) || meaningfulBrief(own) ? null : `the instructions for ${name}`;
  return meaningfulBrief(own) ? null : `the flow and vision for ${name}`;
}
