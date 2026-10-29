// ---------------------------------------------------------------------------
// The shapes of a client's sorted working preferences (lib/workingPrefs) and
// the pure helpers the screens use. Client-safe: no database, no model.
// ---------------------------------------------------------------------------

/** The editing topics, in the order the brief shows them. */
export const EDIT_TOPICS = ["Branding and contact details", "Colors and fonts", "Text and captions", "Music and sound", "Look and pacing", "What must or must not appear", "Revisions", "Other"] as const;
export type EditTopic = (typeof EDIT_TOPICS)[number];

export type SortedPref = { text: string; topic: EditTopic | null };
export type SortedPrefs = {
  v: 1;
  /** What the sort read (lib/workingPrefs workingPrefSources); a different hash means it is stale. */
  hash: string;
  at: string;
  by: string;
  model: string | null;
  editing: SortedPref[];
  shooting: SortedPref[];
  communication: SortedPref[];
  other: SortedPref[];
};

export const PREF_GROUPS = [
  { key: "editing", label: "Editing" },
  { key: "shooting", label: "Shooting" },
  { key: "communication", label: "Communication and scheduling" },
  { key: "other", label: "Other" },
] as const;

/** The editing preferences under their topics, in EDIT_TOPICS order; empty topics left out. */
export function editingByTopic(prefs: Pick<SortedPrefs, "editing">, scrub: (s: string) => string | null = (s) => s): { topic: EditTopic; lines: string[] }[] {
  return EDIT_TOPICS.map((topic) => ({
    topic,
    lines: prefs.editing.filter((p) => (p.topic ?? "Other") === topic).map((p) => scrub(p.text)).filter((t): t is string => !!t),
  })).filter((g) => g.lines.length > 0);
}
