// ---------------------------------------------------------------------------
// THE KNOWLEDGE CURATOR, the pure half (Oct 27 2026).
//
// Jordan, Oct 27 2026: "I don't want to have to come in here and review
// everybody's information for their calls. AI should handle it. And if it
// can't figure it out, then get rid of it."
//
// Every fact a call (or an old note) left on a client is sorted by one model
// call per client into where it is USED, and nothing waits for a person:
//   SCRIPT         about them, worth a buyer or seller hearing   → the writer reads it
//   IDENTITY       style inspirations, humour, boundaries …      → creative identity
//   STRATEGY_NOTE  price point, niche, farm area … in ONE line   → beside the strategy
//                  ("Ideal price point $600k to $800k; takes $1M+ homes when they come up.")
//   EDITING        technical edit preferences                    → the editor's brief
//   FILMING        shoot-day preferences                         → the shoot
//   SKIT_CAST      someone the client said may act in skits      → Settings › Skit cast
//   TEAM_NOTE      still true, useful to us, never in a video
//   ONE_OFF        dated, this month only ("follow-up call Mon Oct 26 3:30 PM")
//                  → kept only to recognise that call, then expires
//   DROP           everything else: unidentifiable people ("admires Brandon
//                  Kerrigan as a benchmark"), small talk, duplicates, unsure
// A fact can also carry a complaint about our service, recorded as one.
//
// Code over the model where a rule is certain: low confidence is a DROP; a
// dated one-off with no date, or one already past, is not kept; a skit-cast
// line with no role is a DROP; a missing answer leaves the fact untouched (the
// model being down changes nothing). Nothing is deleted: a dropped fact is
// REJECTED with the reason on its reviewedBy, a merged one SUPERSEDED.
// No I/O here.
// ---------------------------------------------------------------------------

export const CURATOR = "ai-curator";
/** reviewedBy on every row the curator decided: "ai-curator|<DECISION>|<runId>|<reason>" (there is no note column). */
export const curatorTag = (decision: string, runId: string, reason: string): string =>
  `${CURATOR}|${decision}|${runId}|${reason.replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, 240)}`;
export function readCuratorTag(reviewedBy: string | null | undefined): { decision: string; runId: string; reason: string } | null {
  if (!reviewedBy?.startsWith(`${CURATOR}|`)) return null;
  const [, decision = "", runId = "", ...rest] = reviewedBy.split("|");
  return { decision, runId, reason: rest.join("|") };
}

export const DECISIONS = ["SCRIPT", "IDENTITY", "STRATEGY_NOTE", "EDITING", "FILMING", "SKIT_CAST", "TEAM_NOTE", "ONE_OFF", "DROP"] as const;
export type CurateDecision = (typeof DECISIONS)[number];

// The keys line up with the profile slots the editor brief already reads
// (profileFields.PROFILE_TARGETS: editing.pace, editing.captions,
// editing.music, production.wardrobe, …), so a curated preference can fill
// the slot too.
export const EDITING_KEYS: Record<string, string> = {
  style: "editing.style", pace: "editing.pace", pacing: "editing.pace", music: "editing.music", captions: "editing.captions", logo: "editing.logo",
  color: "editing.color", colors: "editing.color", graphics: "editing.graphics", broll: "editing.broll", "b-roll": "editing.broll", transitions: "editing.transitions", length: "editing.length",
};
export const FILMING_KEYS: Record<string, string> = {
  wardrobe: "production.wardrobe", location: "production.location_preference", teleprompter: "production.teleprompter", days: "production.preferred_days", on_camera: "production.on_camera",
};
export const IDENTITY_KEYS = ["style_inspirations", "humor", "on_camera", "boundaries", "interests"] as const;

/** A technical editing preference: what the editor's brief should carry (Jordan, Oct 27: "The editor needs to know technical stuff about the edits"). */
export function isTechnicalEditingFact(f: { fieldKey?: string | null; category?: string | null }): boolean {
  return (f.fieldKey ?? "").toLowerCase().startsWith("editing.");
}

export type CurateFact = {
  id: string; category: string; fieldKey: string | null; body: string; source: string; speaker: string | null;
  factDate: Date | null; createdAt: Date; confidential: boolean; monthKey: string | null;
};
export type CurrentNote = { fieldKey: string; body: string };
export type ModelDecision = {
  id: string; decision: string; key: string | null; line: string | null; eventAt: string | null;
  castName: string | null; castRole: string | null; complaint: string | null; confidence: number; reason: string;
};

export const CURATOR_SYSTEM = `You curate what Realtour Pilot remembers about ONE real estate agent from their calls. Realtour Pilot plans, films and edits the agent's monthly social videos. Nobody reviews your choices, so be strict: keep only what helps make their videos or run their account, put each kept item where it is used, and drop the rest. When unsure, choose DROP.

Give every fact exactly one decision:
SCRIPT: true about the agent or their work that a buyer or seller would benefit from hearing: experience, process, expertise, opinions, stories, services, market knowledge.
IDENTITY: who they are on camera. key: style_inspirations (creators or accounts whose style they want), humor, on_camera (energy, comfort acting), boundaries (what they will never do on camera), interests (real personal interests). A person or account named as an inspiration is kept ONLY when you can say who they are and why they matter for the videos; line then names them, for example "Watches Tea Del Carlo (San Diego agent known for skits) and Two Cents San Diego for style." If you cannot identify them, DROP.
STRATEGY_NOTE: a lasting fact about their business that their content strategy should reflect: price point, niche, farm area, ideal client, specialty, goal. key: a short snake_case subject (price_point, niche, farm_area, ideal_client, specialty, goal). line: ONE summarised sentence, for example "Ideal price point $600k to $800k; takes $1M+ homes when they come up." Facts on the same subject share one key and the SAME line. When a CURRENT NOTE has that key, write the full updated line.
EDITING: a technical editing preference the editor needs. key: style, pace, music, captions, logo, color, graphics, broll, transitions or length. line: one short instruction an editor can act on. Facts with the same key share the SAME line, merged with any CURRENT NOTE for that key.
FILMING: a preference for the shoot day. key: wardrobe, location, teleprompter, days or on_camera. line as for EDITING.
SKIT_CAST: a person the client confirmed may act in their skits. castName: their name if said. castRole: who they are to the client (spouse, business partner, assistant, son).
TEAM_NOTE: still true next month and useful to our team, but never for a video: how they like to be reached, who to copy, package or billing arrangements, access details.
ONE_OFF: tied to a date or to this month only, for example an agreed follow-up call on a set day, files to send this week. eventAt: the date and time it names, ISO 8601 with the Eastern offset (2026-10-26T15:30:00-04:00); null when no date is said.
DROP: everything else: small talk, feedback that is not a preference, anything already in the CURRENT NOTES or ALREADY KNOWN, duplicates of another fact, vague or garbled lines, people or references you cannot identify or that do not help the content (for example "admires Brandon Kerrigan as a local benchmark but would not copy his style"), and anything you are unsure about.

complaint: when the fact shows the client is unhappy with OUR service (late, wrong, poor quality, not listened to), a short title for it, for example "Unhappy with the music on the September videos". A preference or a change request alone is not a complaint: null.
confidence: 0 to 1. reason: one short plain sentence.
Never invent: judge only the facts' own words. Never use a dash as punctuation in a line.`;

const NULLABLE = (description: string) => ({ type: ["string", "null"], description });
export const CURATOR_SCHEMA = {
  type: "object", additionalProperties: false, required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "decision", "key", "line", "eventAt", "castName", "castRole", "complaint", "confidence", "reason"],
        properties: {
          id: { type: "string" },
          decision: { type: "string", enum: [...DECISIONS] },
          key: NULLABLE("The subject key for IDENTITY, STRATEGY_NOTE, EDITING, FILMING; else null."),
          line: NULLABLE("The one line to keep for IDENTITY, STRATEGY_NOTE, EDITING, FILMING; else null."),
          eventAt: NULLABLE("ONE_OFF only: ISO 8601 date and time."),
          castName: NULLABLE("SKIT_CAST only."),
          castRole: NULLABLE("SKIT_CAST only."),
          complaint: NULLABLE("A short complaint title, or null."),
          confidence: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

const fmtDay = (d: Date) => d.toISOString().slice(0, 10);

export function curatorPrompt(client: { name: string }, facts: CurateFact[], notes: CurrentNote[], known: string[], now: Date): string {
  return [
    `AGENT: ${client.name}`,
    `TODAY: ${now.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "short", day: "numeric" })}`,
    notes.length ? ["CURRENT NOTES (key: line):", ...notes.map((n) => `- ${n.fieldKey}: ${n.body.slice(0, 300)}`)].join("\n") : "CURRENT NOTES: none.",
    known.length ? ["ALREADY KNOWN (for spotting duplicates):", ...known.slice(0, 60).map((k) => `- ${k.replace(/\s+/g, " ").slice(0, 240)}`)].join("\n") : "ALREADY KNOWN: none.",
    ["FACTS TO SORT (id, as noted, source, said by, date):", ...facts.map((f) => `[${f.id}] (${f.category}${f.fieldKey ? ` ${f.fieldKey}` : ""}, ${f.source}${f.speaker ? `, said by ${f.speaker}` : ""}, ${fmtDay(f.factDate ?? f.createdAt)}${f.monthKey ? `, month ${f.monthKey}` : ""}) ${f.body.replace(/\s+/g, " ").slice(0, 600)}`)].join("\n"),
    "Decide every fact listed: one entry per id.",
  ].join("\n\n");
}

/** No dashes as punctuation in a kept line (Jordan's house rule); one line, trimmed. */
export const cleanLine = (s: unknown, max = 300): string =>
  typeof s === "string" ? s.replace(/\s*[‒–—―]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const snake = (s: unknown): string => (typeof s === "string" ? s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) : "");

export const MIN_CONFIDENCE = 0.6;
export const COMPLAINT_MIN_CONFIDENCE = 0.7;
/** A one-off is kept until a day after the moment it names. */
export const ONE_OFF_GRACE_MS = 24 * 3600_000;

export type NoteDecision = "IDENTITY" | "STRATEGY_NOTE" | "EDITING" | "FILMING";
export type PlannedAction =
  | { kind: "keep"; decision: "SCRIPT" | "TEAM_NOTE"; factId: string; reason: string; confidence: number }
  | { kind: "note"; decision: NoteDecision; fieldKey: string; category: string; line: string; sourceIds: string[]; reason: string; confidence: number }
  | { kind: "oneoff"; factId: string; fieldKey: "oneoff.call" | "oneoff.other"; at: Date; expired: boolean; reason: string; confidence: number }
  | { kind: "cast"; factId: string; name: string | null; role: string; reason: string; confidence: number }
  | { kind: "drop"; factId: string; reason: string; confidence: number };
export type CurationPlan = { actions: PlannedAction[]; complaints: { factId: string; title: string }[]; untouched: string[] };

const NOTE_CATEGORY: Record<NoteDecision, string> = { IDENTITY: "BRAND_PREFERENCE", STRATEGY_NOTE: "BRAND_PREFERENCE", EDITING: "PRODUCTION_PREFERENCE", FILMING: "PRODUCTION_PREFERENCE" };
const CALL_RE = /\b(call|meeting|zoom|meet|session|follow[\s-]?up)\b/i;

function noteKey(decision: NoteDecision, key: string): string | null {
  if (decision === "EDITING") return EDITING_KEYS[key] ?? null;
  if (decision === "FILMING") return FILMING_KEYS[key] ?? null;
  if (decision === "IDENTITY") return (IDENTITY_KEYS as readonly string[]).includes(key) ? `identity.${key}` : null;
  return key ? `strategy_note.${key}` : null;
}

/**
 * The model's answer for one batch, with the certain rules on top. Pure.
 * Facts the answer does not mention are `untouched` (left as they are).
 */
export function planCuration(facts: CurateFact[], out: unknown, now: Date): CurationPlan {
  const list = (out && typeof out === "object" && Array.isArray((out as { decisions?: unknown }).decisions) ? (out as { decisions: unknown[] }).decisions : []) as Partial<ModelDecision>[];
  const byId = new Map<string, Partial<ModelDecision>>();
  for (const d of list) if (d && typeof d.id === "string" && !byId.has(d.id)) byId.set(d.id, d);
  const actions: PlannedAction[] = [];
  const complaints: { factId: string; title: string }[] = [];
  const untouched: string[] = [];
  const notes = new Map<string, Extract<PlannedAction, { kind: "note" }>>();
  for (const f of facts) {
    const d = byId.get(f.id);
    if (!d || !(DECISIONS as readonly string[]).includes(String(d.decision))) { untouched.push(f.id); continue; }
    const decision = d.decision as CurateDecision;
    const confidence = typeof d.confidence === "number" && Number.isFinite(d.confidence) ? Math.max(0, Math.min(1, d.confidence)) : 0;
    const reason = cleanLine(d.reason, 200) || decision.toLowerCase().replace(/_/g, " ");
    const complaint = cleanLine(d.complaint, 160);
    if (complaint.length >= 3 && confidence >= COMPLAINT_MIN_CONFIDENCE) complaints.push({ factId: f.id, title: complaint });
    const drop = (why: string) => actions.push({ kind: "drop", factId: f.id, reason: why, confidence });
    if (decision !== "DROP" && confidence < MIN_CONFIDENCE) { drop(`not sure enough to keep (${reason})`); continue; }
    switch (decision) {
      case "DROP": drop(reason); break;
      case "SCRIPT": case "TEAM_NOTE": actions.push({ kind: "keep", decision, factId: f.id, reason, confidence }); break;
      case "SKIT_CAST": {
        const role = cleanLine(d.castRole, 60);
        if (!role) { drop("a skit cast member without who they are to the client"); break; }
        actions.push({ kind: "cast", factId: f.id, name: cleanLine(d.castName, 60) || null, role, reason, confidence });
        break;
      }
      case "ONE_OFF": {
        const at = typeof d.eventAt === "string" && Number.isFinite(Date.parse(d.eventAt)) ? new Date(d.eventAt) : null;
        if (!at) { drop(`dated to this month only, with no date to keep it for (${reason})`); break; }
        actions.push({ kind: "oneoff", factId: f.id, fieldKey: CALL_RE.test(f.body) ? "oneoff.call" : "oneoff.other", at, expired: at.getTime() + ONE_OFF_GRACE_MS < now.getTime(), reason, confidence });
        break;
      }
      default: {
        const nd = decision as NoteDecision;
        const fieldKey = noteKey(nd, snake(d.key));
        const line = cleanLine(d.line);
        if (!fieldKey || line.length < 3) { drop(`no clear line to keep (${reason})`); break; }
        const prev = notes.get(fieldKey);
        if (prev) { prev.sourceIds.push(f.id); prev.confidence = Math.min(prev.confidence, confidence); }
        else {
          const a = { kind: "note" as const, decision: nd, fieldKey, category: NOTE_CATEGORY[nd], line, sourceIds: [f.id], reason, confidence };
          notes.set(fieldKey, a);
          actions.push(a);
        }
      }
    }
  }
  return { actions, complaints, untouched };
}

/** Where a kept fact shows on the read-only "What the AI kept" view. */
export type KeptPlace = "identity" | "strategy" | "editing" | "filming" | "cast" | "script" | "team" | "oneoff";
export function keptPlaceOf(f: { fieldKey: string | null; category: string; aiContext: string; confidential: boolean }): KeptPlace {
  const k = (f.fieldKey ?? "").toLowerCase();
  if (k.startsWith("identity.")) return "identity";
  if (k.startsWith("strategy_note.")) return "strategy";
  if (k.startsWith("oneoff.")) return "oneoff";
  if (k === "skit_cast") return "cast";
  if (k.startsWith("editing.")) return "editing";
  if (k.startsWith("production.")) return "filming";
  if (f.category === "PRODUCTION_PREFERENCE" && f.aiContext === "ALLOWED" && !f.confidential) return "editing";
  return f.aiContext === "ALLOWED" && !f.confidential ? "script" : "team";
}
