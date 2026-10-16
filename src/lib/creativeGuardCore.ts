// ---------------------------------------------------------------------------
// A CLIENT'S CREATIVE GUARDRAILS, PURE HALF (Oct 15 2026). No prisma, no
// server-only: the staff editor, the editor brief, the Review Room, the topic
// bank and the script writer read the same record and the same matching rule.
//
// Marcee McMullen's Oct 15 call: the "Fairy God Realtor" series was not her,
// she wants the fully scripted framework back, and her fonts are on her signs
// and website. A client's style was a sentence in somebody's head; it is now
// a record on the program (ContentEnrollment.overridesJson.creative):
//
//   provenFormats  what works for this client ("Fully scripted, direct to
//                  camera"). The generators lean on it; the editor and the
//                  reviewer see it.
//   discontinued   series and concepts the client stopped, with who, when and
//                  why. The topic bank drops any idea that names one, the
//                  script writer refuses a topic that does, and the editor and
//                  reviewer are told not to make one.
//   experimentCap  how many experimental concepts a month at most (null =
//                  no rule). Said to the generators; a person still picks.
// ---------------------------------------------------------------------------

export const CREATIVE_GUARD_KEY = "creative";

export type DiscontinuedSeries = { name: string; by: string | null; at: string; reason: string | null };
export type CreativeGuard = {
  provenFormats: string[];
  discontinued: DiscontinuedSeries[];
  experimentCap: number | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
};

export const EMPTY_GUARD: CreativeGuard = { provenFormats: [], discontinued: [], experimentCap: null };

const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Normalise whatever is stored into a clean guard. Pure; never throws. */
export function normalizeGuard(raw: unknown): CreativeGuard {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_GUARD };
  const o = raw as Record<string, unknown>;
  const provenFormats = [...new Set((Array.isArray(o.provenFormats) ? o.provenFormats : []).map((x) => str(x, 200)).filter(Boolean))].slice(0, 10);
  const seen = new Set<string>();
  const discontinued: DiscontinuedSeries[] = [];
  for (const d of Array.isArray(o.discontinued) ? o.discontinued : []) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    const name = str(r.name, 120);
    if (!name || seen.has(seriesKey(name))) continue;
    seen.add(seriesKey(name));
    discontinued.push({ name, by: str(r.by, 120) || null, at: str(r.at, 40) || new Date(0).toISOString(), reason: str(r.reason, 400) || null });
  }
  const cap = typeof o.experimentCap === "number" && Number.isInteger(o.experimentCap) && o.experimentCap >= 0 && o.experimentCap <= 20 ? o.experimentCap : null;
  return { provenFormats, discontinued: discontinued.slice(0, 30), experimentCap: cap, updatedBy: str(o.updatedBy, 120) || null, updatedAt: str(o.updatedAt, 40) || null };
}

/** The guard from ContentEnrollment.overridesJson (string or parsed bag). Pure. */
export function creativeGuardFromOverrides(overrides: string | Record<string, unknown> | null | undefined): CreativeGuard {
  if (!overrides) return { ...EMPTY_GUARD };
  let bag: unknown = overrides;
  if (typeof overrides === "string") {
    try { bag = JSON.parse(overrides); } catch { return { ...EMPTY_GUARD }; }
  }
  return bag && typeof bag === "object" && !Array.isArray(bag) ? normalizeGuard((bag as Record<string, unknown>)[CREATIVE_GUARD_KEY]) : { ...EMPTY_GUARD };
}

export const guardIsEmpty = (g: CreativeGuard | null | undefined) => !g || (g.provenFormats.length === 0 && g.discontinued.length === 0 && g.experimentCap == null);

/** "Fairy God Realtor" → "fairy god realtor": case, punctuation and spacing do not matter. */
export function seriesKey(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** The discontinued series this text names, or null. Pure. */
export function discontinuedHit(text: string | null | undefined, guard: CreativeGuard | null | undefined): string | null {
  if (!text || !guard?.discontinued.length) return null;
  const hay = ` ${seriesKey(text)} `;
  for (const d of guard.discontinued) {
    const k = seriesKey(d.name);
    if (k && hay.includes(` ${k} `)) return d.name;
  }
  return null;
}

/** The block every topic-bank and script prompt carries. Empty guard → "". No dashes. */
export function creativeGuardBlock(guard: CreativeGuard | null | undefined): string {
  if (guardIsEmpty(guard)) return "";
  const g = guard!;
  const lines = ["CREATIVE GUARDRAILS FOR THIS CLIENT (set by the office; they win over anything else):"];
  if (g.provenFormats.length) lines.push(`- Proven format: ${g.provenFormats.join("; ")}. Work in this format.`);
  for (const d of g.discontinued) lines.push(`- DISCONTINUED: "${d.name}"${d.reason ? ` (${d.reason})` : ""}. Never write, suggest, name or continue it, or anything built on it.`);
  if (g.experimentCap != null) lines.push(g.experimentCap === 0 ? "- No experimental concepts: stay inside the proven format." : `- At most ${g.experimentCap} experimental concept${g.experimentCap === 1 ? "" : "s"} a month outside the proven format.`);
  return lines.join("\n");
}
