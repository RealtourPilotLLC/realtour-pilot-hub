// ---------------------------------------------------------------------------
// A SONG REQUEST PER VIDEO (Oct 23 2026, Jordan's upload-page spec: "No
// request / Requested song; song title and artist; song link; preferred start
// time or section (optional)"). Different videos can carry different songs.
//
// WHERE IT LIVES: inside each video's own instructions, as machine lines next
// to the STYLE and COLOR PROFILE lines the page already composes:
//
//   SONG REQUEST: Requested            (or "SONG REQUEST: No request")
//   SONG TITLE: Good Days by LAKEY INSPIRED
//   SONG LINK: https://open.spotify.com/track/…
//   SONG START: 0:30, at the chorus
//
// Video 1's are in Project.videoInstructions, video 2 and on in their own
// DeliverableOutput.filmingNote (lib/perVideoInstructions), so every reader of
// a video's instructions (the editor's page, the printed brief, the packet)
// already carries them. No new column.
//
// NEVER INSTRUCTIONS: like the STYLE and COLOR PROFILE lines, a song line is
// not the photographer's direction for the edit. meaningfulBrief (lib/handoff),
// the KPI's word count (lib/kpiEvidence) and the submit's own gate skip it, so
// a song alone never satisfies "the vision for the edit".
//
// A requested song needs enough to find it: a title (with or without the
// artist) OR a link. Both are welcome, neither is demanded on its own.
//
// Before this, video 2's area had a free-text "SONG OR MUSIC" section (Oct 22).
// That text is read here as a requested song, so nothing typed there is lost.
//
// Pure and client-safe.
// ---------------------------------------------------------------------------

export type SongMode = "unset" | "none" | "requested";
export type SongRequest = { mode: SongMode; title: string; link: string; start: string };

/** A song line (any of the four). */
export const SONG_LINE_RE = /^SONG (?:REQUEST|TITLE|LINK|START):/i;
export const SONG_LIMITS = { title: 200, link: 500, start: 120 } as const;

export function emptySong(): SongRequest {
  return { mode: "unset", title: "", link: "", start: "" };
}

const one = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** A link as it will be saved: trimmed, and given https:// when typed without it. Null = not a web address. */
export function normalizeSongLink(raw: string): string | null {
  const t = (raw ?? "").trim();
  if (!t) return "";
  if (/\s/.test(t)) return null;
  if (/^https?:\/\/[^\s/]+\.[^\s]+/i.test(t)) return t.slice(0, SONG_LIMITS.link);
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(t)) return `https://${t}`.slice(0, SONG_LIMITS.link);
  return null;
}

/** What a requested song still needs, in the photographer's words (null = nothing). */
export function songProblem(s: SongRequest | null | undefined, videoName = "this video"): string | null {
  if (!s || s.mode !== "requested") return null;
  const link = normalizeSongLink(s.link);
  if (link === null) return `the song link for ${videoName} isn't a web address (paste the Spotify, YouTube or Apple Music link)`;
  if (!one(s.title, SONG_LIMITS.title) && !link) return `the song title or a link for ${videoName} (or choose No request)`;
  return null;
}

/** The lines this song adds to a video's instructions. Unset adds nothing. */
export function songLines(s: SongRequest | null | undefined): string[] {
  if (!s || s.mode === "unset") return [];
  if (s.mode === "none") return ["SONG REQUEST: No request"];
  const out = ["SONG REQUEST: Requested"];
  const title = one(s.title, SONG_LIMITS.title);
  const link = normalizeSongLink(s.link) ?? one(s.link, SONG_LIMITS.link);
  const start = one(s.start, SONG_LIMITS.start);
  if (title) out.push(`SONG TITLE: ${title}`);
  if (link) out.push(`SONG LINK: ${link}`);
  if (start) out.push(`SONG START: ${start}`);
  return out;
}

const LEGACY_HEADING = "SONG OR MUSIC";
/** Section headings the composed instructions use (a legacy song section ends at the next one). */
const HEADINGS = new Set([
  "VISION FOR THE EDIT", "SUMMARY", "SHOTS THAT MUST BE SHOWN", "AREAS TO AVOID", "THINGS TO AVOID", "REALTOR REQUESTS",
  "ADDITIONAL NOTES", "INTRO SCRIPT", "EDITING NOTES", "SCRIPT FOR THIS VIDEO", LEGACY_HEADING,
]);

/**
 * The song a video's instructions carry: the SONG lines, else the free-text
 * "SONG OR MUSIC" section from before (read as a requested song), else null.
 */
export function songOfText(text: string | null | undefined): SongRequest | null {
  const lines = (text ?? "").split("\n");
  let found = false;
  const s = emptySong();
  let legacy: string[] | null = null;
  let inLegacy = false;
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^SONG (REQUEST|TITLE|LINK|START):\s*(.*)$/i);
    if (m) {
      found = true;
      const v = m[2].trim();
      const k = m[1].toUpperCase();
      if (k === "REQUEST") s.mode = /^no\b/i.test(v) ? "none" : "requested";
      else if (k === "TITLE") s.title = v;
      else if (k === "LINK") s.link = v;
      else s.start = v;
      continue;
    }
    if (HEADINGS.has(line)) { inLegacy = line === LEGACY_HEADING; if (inLegacy) legacy = []; continue; }
    if (inLegacy && legacy) legacy.push(raw);
  }
  if (found) {
    if (s.mode === "unset") s.mode = s.title || s.link ? "requested" : "unset";
    return s;
  }
  const old = (legacy ?? []).join("\n").trim();
  if (!old) return null;
  const url = old.match(/https?:\/\/\S+/)?.[0] ?? "";
  const rest = old.replace(url, "").replace(/\s+/g, " ").trim();
  return { mode: "requested", title: rest.slice(0, SONG_LIMITS.title), link: url.slice(0, SONG_LIMITS.link), start: "" };
}

/** "Good Days by LAKEY INSPIRED · https://… · start: 0:30" / "No song requested" / null (nothing said). */
export function songSummary(s: SongRequest | null | undefined): string | null {
  if (!s || s.mode === "unset") return null;
  if (s.mode === "none") return "No song requested";
  const bits = [one(s.title, SONG_LIMITS.title), (normalizeSongLink(s.link) ?? s.link).trim(), s.start.trim() ? `start: ${one(s.start, SONG_LIMITS.start)}` : ""].filter(Boolean);
  return bits.length ? bits.join(" · ") : "Song requested (no title or link given)";
}

/** songSummary of whatever a video's instructions carry. */
export function songSummaryOfText(text: string | null | undefined): string | null {
  return songSummary(songOfText(text));
}

/** The instructions with every song line (and a legacy song section) taken out, for readers that print the song on its own line. */
export function withoutSongLines(text: string | null | undefined): string {
  const out: string[] = [];
  let inLegacy = false;
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (SONG_LINE_RE.test(line)) continue;
    if (HEADINGS.has(line)) { inLegacy = line === LEGACY_HEADING; if (inLegacy) continue; }
    if (inLegacy) continue;
    out.push(raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
