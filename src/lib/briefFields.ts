// ---------------------------------------------------------------------------
// THE OFFICE WRITES THE BRIEF IN THE UPLOAD PORTAL'S OWN FIELDS (Jordan, Oct
// 27 2026: "when we turn on office tools, we can write the brief. But really,
// the brief ... needs to be consistent with what they use on the upload
// page").
//
// The photographer's video instructions are ONE composed text (Project.
// videoInstructions for video 1, DeliverableOutput.filmingNote for video 2
// and on), written by UploadPortal.composeVideoInstructions:
//
//   STYLE: Fast-Paced
//   COLOR PROFILE: S-Log3, D-LogM
//   SONG REQUEST: Requested
//   SONG LINK: https://…
//   SONG START: 0:30
//
//   VISION FOR THE EDIT
//   …
//   EDITING NOTES
//   …
//
// The office's form on the brief edits the same text with the same choices:
// video notes (EDITING NOTES), style, color profile, vision for the edit, and
// the song's link and start. Every other section the photographer wrote
// (summary, must show, avoid, realtor requests, intro script, this video's
// script) is kept exactly as it was, so the office never wipes the shoot's
// words by saving four fields. Pure and client-safe.
// ---------------------------------------------------------------------------

import { emptySong, songLines, songOfText, SONG_LINE_RE, type SongRequest } from "@/lib/songRequest";

/** The STYLE line's words (UploadPortal VID_STYLES). */
export const BRIEF_STYLES = ["Fast-Paced", "Timeless & Elegant (Cinematic)", "Personal Branding"] as const;
/** The COLOR PROFILE line's words (UploadPortal COLOR_PROFILES). */
export const BRIEF_COLOR_PROFILES = ["iPhone", "S-Log3", "D-LogM", "S-Log3, D-LogM"] as const;

/** The portal's sections, in the order it composes them. */
const SECTIONS = [
  "VISION FOR THE EDIT", "SUMMARY", "SHOTS THAT MUST BE SHOWN", "THINGS TO AVOID", "REALTOR REQUESTS",
  "ADDITIONAL NOTES", "INTRO SCRIPT", "EDITING NOTES", "SCRIPT FOR THIS VIDEO", "SONG OR MUSIC",
] as const;
type SectionLabel = (typeof SECTIONS)[number];
const ALIAS: Record<string, SectionLabel> = { "AREAS TO AVOID": "THINGS TO AVOID" };

export type OfficeBriefFields = {
  /** one of BRIEF_STYLES, or "" for none */
  style: string;
  /** one of BRIEF_COLOR_PROFILES, or "" for none */
  colorProfile: string;
  vision: string;
  /** EDITING NOTES */
  videoNotes: string;
  songLink: string;
  songStart: string;
};

type Parsed = { style: string; colorProfile: string; sections: Record<SectionLabel, string>; song: SongRequest | null };

function parse(text: string | null | undefined): Parsed {
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, ""])) as Record<SectionLabel, string>;
  const out: Parsed = { style: "", colorProfile: "", sections, song: songOfText(text) };
  if (!text?.trim()) return out;
  let current: SectionLabel | null = null;
  const prefix: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const style = current === null ? /^STYLE:\s*(.+)$/.exec(line) : null;
    if (style) { out.style = style[1].trim(); continue; }
    const color = /^COLOR PROFILE:\s*(.*)$/.exec(line);
    if (color) { out.colorProfile = color[1].trim(); continue; }
    if (SONG_LINE_RE.test(line)) continue;
    const label = (SECTIONS as readonly string[]).includes(line) ? (line as SectionLabel) : ALIAS[line] ?? null;
    if (label) { current = label; continue; }
    if (current) sections[current] += (sections[current] ? "\n" : "") + raw;
    else prefix.push(raw);
  }
  for (const s of SECTIONS) sections[s] = sections[s].trim();
  // Text before any heading (a legacy free-text brief) is the vision, as the portal reads it.
  const lead = prefix.join("\n").trim();
  if (lead) sections["VISION FOR THE EDIT"] = sections["VISION FOR THE EDIT"] ? `${lead}\n${sections["VISION FOR THE EDIT"]}` : lead;
  return out;
}

/** The office form's starting values for a video's instructions. */
export function readOfficeBrief(text: string | null | undefined): OfficeBriefFields {
  const p = parse(text);
  return {
    style: p.style,
    colorProfile: p.colorProfile,
    vision: p.sections["VISION FOR THE EDIT"],
    videoNotes: p.sections["EDITING NOTES"],
    songLink: p.song?.link ?? "",
    songStart: p.song?.start ?? "",
  };
}

/** The instructions with the office's fields written in and every other section kept. */
export function writeOfficeBrief(text: string | null | undefined, f: OfficeBriefFields): string {
  const p = parse(text);
  const clean = (s: string) => (s ?? "").replace(/\r\n/g, "\n").trim();
  const style = (BRIEF_STYLES as readonly string[]).includes(f.style.trim()) ? f.style.trim() : f.style.trim() ? p.style : "";
  const colorProfile = (BRIEF_COLOR_PROFILES as readonly string[]).includes(f.colorProfile.trim()) ? f.colorProfile.trim() : f.colorProfile.trim() ? p.colorProfile : "";
  const sections = { ...p.sections, "VISION FOR THE EDIT": clean(f.vision), "EDITING NOTES": clean(f.videoNotes) };
  // The song: what was asked stays (a title the photographer typed), with the
  // office's link and start. A link or a start is a request; clearing both
  // leaves whatever else was said (a "No request" stays "No request").
  const link = clean(f.songLink);
  const start = clean(f.songStart);
  const had = p.song;
  let song: SongRequest | null = had ? { ...emptySong(), ...had, link, start } : link || start ? { ...emptySong(), link, start } : null;
  if (song && (link || start)) song = { ...song, mode: "requested" };
  if (song && song.mode === "requested" && !songLines(song).slice(1).length) song = had?.mode === "none" ? { ...emptySong(), mode: "none" } : null;
  // The old free-text song box is read into the song and not written twice.
  const parts: string[] = [];
  if (style) parts.push(`STYLE: ${style}`);
  if (colorProfile) parts.push(`COLOR PROFILE: ${colorProfile}`);
  const sl = songLines(song);
  if (sl.length) parts.push(sl.join("\n"));
  for (const s of SECTIONS) {
    if (s === "SONG OR MUSIC" && song) continue;
    const v = sections[s]?.trim();
    if (v) parts.push(`${s}\n${v}`);
  }
  return parts.join("\n\n");
}
