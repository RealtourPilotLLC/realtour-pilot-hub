// ---------------------------------------------------------------------------
// The job's MUSIC PICK — the Epidemic Sound track chosen for a video job
// (Jordan, Sep 15: "find music in the editor brief for copyright free music").
//
// Stored INSIDE Project.editSpec, the per-job spec JSON the office already
// writes (musicType, colorProfile, desiredLength, instructions), under one
// more key: `music`. No schema change; one pick per job — picking again
// replaces it. Read by the Music card, the Edit-instructions spec and the
// editor-brief PDF, so all three say the same thing. Pure module: no server
// imports, safe from a client component.
// ---------------------------------------------------------------------------
export type MusicPick = {
  provider: "epidemic_sound";
  trackId: string;
  title: string;
  artist: string;
  bpm: number | null;
  durationSec: number | null;
  /** display name of whoever picked it */
  pickedBy: string;
  /** ISO */
  pickedAt: string;
  /** set once the MP3 has been put in the job's Dropbox folder */
  dropboxPath?: string | null;
};

export function parseEditSpec(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readMusicPick(editSpec: string | null | undefined): MusicPick | null {
  return musicPickOf(parseEditSpec(editSpec));
}

export function musicPickOf(spec: Record<string, unknown> | null | undefined): MusicPick | null {
  const m = spec?.music as Partial<MusicPick> | undefined;
  if (!m || typeof m !== "object" || typeof m.trackId !== "string" || typeof m.title !== "string") return null;
  return {
    provider: "epidemic_sound",
    trackId: m.trackId,
    title: m.title,
    artist: typeof m.artist === "string" ? m.artist : "",
    bpm: typeof m.bpm === "number" ? m.bpm : null,
    durationSec: typeof m.durationSec === "number" ? m.durationSec : null,
    pickedBy: typeof m.pickedBy === "string" ? m.pickedBy : "",
    pickedAt: typeof m.pickedAt === "string" ? m.pickedAt : "",
    dropboxPath: typeof m.dropboxPath === "string" ? m.dropboxPath : null,
  };
}

export function fmtMusicDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// "Title — Artist · 118 BPM · 2:41"
export function musicPickLine(p: MusicPick): string {
  const bits = [`${p.title}${p.artist ? ` — ${p.artist}` : ""}`];
  if (p.bpm) bits.push(`${p.bpm} BPM`);
  const d = fmtMusicDuration(p.durationSec);
  if (d) bits.push(d);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// BPM RANGE (Jordan, Sep 15: "set the BPM with a slider"). The card's
// two-handle control and the recommendation's hint share these bounds so
// "90–120 BPM" means the same thing on both. 40–200 in steps of 5 covers what
// Epidemic Sound files for a listing track (its BPM is a whole number). A
// range that spans everything is the same as no filter, so it reads back as
// null and the request carries no bpmMin/bpmMax at all.
// ---------------------------------------------------------------------------
export const BPM_MIN = 40;
export const BPM_MAX = 200;
export const BPM_STEP = 5;
export type BpmRange = { min: number; max: number };

/** The preset chips, in the order the card shows them. */
export const BPM_PRESETS: { label: string; hint: string; range: BpmRange | null }[] = [
  { label: "Slow", hint: "≤90", range: { min: BPM_MIN, max: 90 } },
  { label: "Mid", hint: "90–120", range: { min: 90, max: 120 } },
  { label: "Upbeat", hint: "120–150", range: { min: 120, max: 150 } },
  { label: "Fast", hint: "150+", range: { min: 150, max: BPM_MAX } },
  { label: "Any", hint: "", range: null },
];

const snapBpm = (n: number) => Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(n / BPM_STEP) * BPM_STEP));

/** Orders the pair, snaps to the step, clamps to the bounds. Null when
 *  nothing usable is given or the range spans everything. */
export function clampBpmRange(min: number | null | undefined, max: number | null | undefined): BpmRange | null {
  const hasMin = typeof min === "number" && Number.isFinite(min);
  const hasMax = typeof max === "number" && Number.isFinite(max);
  if (!hasMin && !hasMax) return null;
  let lo = hasMin ? snapBpm(min) : BPM_MIN;
  let hi = hasMax ? snapBpm(max) : BPM_MAX;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo <= BPM_MIN && hi >= BPM_MAX) return null;
  return { min: lo, max: hi };
}

export const sameBpmRange = (a: BpmRange | null, b: BpmRange | null): boolean =>
  (a === null && b === null) || (!!a && !!b && a.min === b.min && a.max === b.max);

/** The pair as request params. A bound sitting on the slider's own edge is
 *  left off, so "150+" means 150 and up (a track filed above 200 BPM still
 *  counts) and "≤90" is 90 and under — the labels already read that way
 *  (review, Sep 15). Any → neither param. */
export function bpmQuery(r: BpmRange | null | undefined): { bpmMin: number | undefined; bpmMax: number | undefined } {
  return {
    bpmMin: r && r.min > BPM_MIN ? r.min : undefined,
    bpmMax: r && r.max < BPM_MAX ? r.max : undefined,
  };
}

/** "90–120 BPM" · "≤90 BPM" · "150+ BPM" · "Any BPM" */
export function bpmRangeLabel(r: BpmRange | null): string {
  if (!r) return "Any BPM";
  if (r.min <= BPM_MIN) return `≤${r.max} BPM`;
  if (r.max >= BPM_MAX) return `${r.min}+ BPM`;
  return `${r.min}–${r.max} BPM`;
}
