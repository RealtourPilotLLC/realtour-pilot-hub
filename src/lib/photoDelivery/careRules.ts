// ---------------------------------------------------------------------------
// PHOTO MISSES (Oct 21 2026, 859 N Lawrence St). Jordan: "Kyle should not have
// missed this on Joe's photos. Can we figure out why he may have missed this
// ... and make sure things like this do not get missed again?"
//
// The free check flagged the wooden sidewalk forms the client had been
// promised would be cropped out; about 20 major findings were then set aside
// in three minutes with the stock "Not worth a fix on this listing". So:
//   · IGNORING WITH CARE: a major finding outside the house, or anything on
//     Jordan's always-fixed list (trash cans, cars, camera mistakes, lens
//     distortion; fixPolicy.ALWAYS_FIX), is set aside only with the person's
//     own words, once per group. The stock presets stay for minor and inside
//     items. A listing-specific ignore is still allowed and is never a rule
//     rejection (Oct 14 2026).
//   · THE APPROVE SUMMARY: "You're delivering with 6 exterior issues ignored
//     (construction materials ×4, trash cans ×2)". Shown, never blocking.
//   · THE CLIENT'S PHOTO NUMBERS: "Photos 1-5 and 38-40" read off the client's
//     words, so the item on the photo job says which photos.
//
// Pure and client-safe (no prisma, no rules registry): the job page's prompt
// and the server's decision write apply the same rule.
// ---------------------------------------------------------------------------

/** The stock reasons the ignore prompt offers (format.IGNORE_PRESETS shows them). */
export const STOCK_IGNORE_REASONS = ["Client preference", "Intentional staging", "Permanent feature", "Not worth a fix on this listing"] as const;
/** How many characters of a person's own words a careful ignore needs. */
export const MIN_OWN_WORDS = 10;

export type CareFacts = { severity: string; exterior: boolean; alwaysFixed: boolean };

/** Setting this aside needs the person's own words: a major (or critical) outside finding, or anything always fixed. */
export function needsOwnWords(f: CareFacts): boolean {
  return f.alwaysFixed || (f.exterior && f.severity !== "MINOR");
}

/** The words a reason carries once a stock preset at its start is taken off. */
export function ownWords(reason: string | null | undefined): string {
  let r = (reason ?? "").replace(/\s+/g, " ").trim();
  for (const s of STOCK_IGNORE_REASONS) {
    if (r.toLowerCase().startsWith(s.toLowerCase())) r = r.slice(s.length).replace(/^[\s:;,.-]+/, "");
  }
  return r.trim();
}

/** A typed reason: at least MIN_OWN_WORDS characters of the person's own, not a stock preset alone. */
export function ownWordsOk(reason: string | null | undefined): boolean {
  return ownWords(reason).length >= MIN_OWN_WORDS;
}

export type IgnoredGroup = { label: string; n: number; exterior: boolean };

/**
 * "You're delivering with 6 exterior issues ignored (construction materials
 * ×4, trash cans ×2)." Null when nothing careful was ignored.
 */
export function ignoredSummaryLine(groups: IgnoredGroup[]): string | null {
  const list = groups.filter((g) => g.n > 0);
  if (!list.length) return null;
  const total = list.reduce((s, g) => s + g.n, 0);
  const allOutside = list.every((g) => g.exterior);
  const noneOutside = list.every((g) => !g.exterior);
  const kind = allOutside ? "exterior" : noneOutside ? "always-fixed" : "exterior or always-fixed";
  const parts = [...list].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).map((g) => (g.n > 1 ? `${g.label} ×${g.n}` : g.label));
  return `You're delivering with ${total} ${kind} issue${total === 1 ? "" : "s"} ignored (${parts.join(", ")}).`;
}

// ---- a finding the client asked about ------------------------------------------------------
//
// Oct 21 2026 (859 N Lawrence St): the order note said "Wooden Side walk forms
// ... photoshopped in photos"; the free check said "construction materials"
// on the sidewalk; nothing connected them, and the finding was set aside as
// ordinary clutter. A plain word overlap is enough to say "the client asked
// for this to be removed": the words of the client's request against the
// finding's own words (its check, what it saw, where, and a few plain words
// per check: rulesLinkWords on the server).

// Words that say nothing about WHAT is in the photo.
const LINK_NOISE = new Set(
  ("photo photos picture pictures image images shot shots house home front back side left right outside inside room area property listing listed list " +
    "please remove removed removing edit edited editing photoshop photoshopped avoid avoided need needed needs will would could should they them there " +
    "their that this these those with from when what were being been have guess tomorrow today video videos also just make sure want wants like " +
    "client agent seller owner team shoot shooting order note notes special instructions photographer only every some more than then into onto over " +
    "under about around near next behind across still while because done").split(/\s+/),
);

/** The words of a text that can say what something is ("Side walk forms" → sidewalk, form). Pure. */
export function linkWords(text: string | null | undefined): Set<string> {
  const t = (text ?? "").toLowerCase().replace(/side\s+walk/g, "sidewalk").replace(/drive\s+way/g, "driveway").replace(/trash\s+can/g, "trashcan");
  const out = new Set<string>();
  for (const raw of t.split(/[^a-z]+/)) {
    if (raw.length < 4 || LINK_NOISE.has(raw)) continue;
    const w = raw.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
    if (w.length >= 3 && !LINK_NOISE.has(w)) out.add(w);
  }
  return out;
}

/** The words a client's request and a finding share (empty: not linked). Pure. */
export function sharedLinkWords(askText: string, findingText: string): string[] {
  const a = linkWords(askText);
  const b = linkWords(findingText);
  return [...a].filter((w) => b.has(w));
}

// ---- the client's photo numbers --------------------------------------------------------

const NUM = String.raw`#?\d{1,3}`;
const RANGE = String.raw`${NUM}(?:\s*(?:-|–|—|to|thru|through)\s*${NUM})?`;
const LIST_RE = new RegExp(String.raw`\b(?:photos?|pics?|pictures?|images?|shots?|numbers?)\s*(${RANGE}(?:\s*(?:,|&|\+|and|or)\s*${RANGE})*)`, "gi");

/**
 * The photo numbers a client named ("Photos 1-5 and 38-40" → "1-5, 38-40";
 * "photo #12" → "12"). Null when none. Pure.
 */
export function photoNumbers(text: string | null | undefined): string | null {
  const t = text ?? "";
  const out: string[] = [];
  for (const m of t.matchAll(LIST_RE)) {
    for (const part of m[1].split(/\s*(?:,|&|\+|\band\b|\bor\b)\s*/i)) {
      const r = /^#?(\d{1,3})(?:\s*(?:-|–|—|to|thru|through)\s*#?(\d{1,3}))?$/i.exec(part.trim());
      if (!r) continue;
      const a = Number(r[1]);
      const b = r[2] ? Number(r[2]) : null;
      // A gallery is never 400 photos; "5-3" is not a range.
      if (!a || a > 400 || (b != null && (b > 400 || b <= a))) continue;
      out.push(b != null ? `${a}-${b}` : String(a));
    }
  }
  const seen = [...new Set(out)];
  return seen.length ? seen.join(", ") : null;
}
