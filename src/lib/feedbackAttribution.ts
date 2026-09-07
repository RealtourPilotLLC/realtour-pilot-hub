// ---------------------------------------------------------------------------
// WHOSE PROBLEM IS IT — on-site, or after the shutter?
//
// Jordan, Sep 7 2026, on a client who asked for "reels turned around quicker
// and less spelling errors": "This should not affect the photographer. This is
// an editing and operations issue not a photographer issue. I want to make sure
// photographers aren't getting dinged for that, so we need a system to decide
// whether it's an on-site photographer issue or a post-production/operations
// issue."
//
// The photographer controls what happens at the property: showing up, how they
// carry themselves, what they capture, how they leave it. They do not control
// how fast a reel comes back, whether a title card is spelled right, what the
// colour grade looks like, or when the invoice goes out. Grading them on the
// second list is how a good shooter ends up with a bad score.
//
// Deterministic and explainable on purpose: this decides someone's bonus, so it
// has to be a rule a person can read and argue with, not a model's opinion. It
// says WHY, and an owner can overrule it on /quality — and once a human has,
// nothing re-decides it.
// ---------------------------------------------------------------------------

export type Attribution = "ONSITE" | "OPERATIONS" | "MIXED";

/** After the shutter — nobody at the property can affect any of it. */
const OPERATIONS = [
  { re: /\b(turn ?around|turnaround|quicker|faster|slow(?:er|ly)?|took (?:so |too )?long|took (?:[a-z-]+|\d+) (?:days?|weeks?|months?)|(?:days?|weeks?) to (?:get|come|turn)|delay(?:ed|s)?|late deliver\w*|waiting (?:on|for) (?:the )?(?:reel|video|photos|edits?)|deadline|on time)\b/i, why: "turnaround" },
  { re: /\b(spell\w*|typo|mis-?spell\w*|grammar|wrong (?:name|address|word)|text (?:error|mistake))\b/i, why: "spelling / text errors" },
  { re: /\b(edit(?:s|ing|ed)?|editor|re-?edit|colou?r ?(?:grade|grading|correction)|retouch\w*|cut(?:ting)? (?:of )?the (?:reel|video)|music|song|caption|subtitle|transition|watermark|logo|end ?card|branding)\b/i, why: "editing" },
  { re: /\b(deliver\w*|upload\w*|link (?:expired|broken|not working)|download|gallery|portal|website|zillow (?:upload|sync)|mls)\b/i, why: "delivery" },
  { re: /\b(invoice|billing|charge[ds]?|payment|price|cost|refund)\b/i, why: "billing" },
  { re: /\b(schedul\w*|resched\w*|booking|calendar|confirm\w* (?:the )?(?:time|appointment))\b/i, why: "scheduling" },
];

/** At the property — the photographer's own work and conduct. */
const ONSITE = [
  { re: /\b(photographer|shooter|crew|he |she |they )\s?\b(was|were|is|arrived|showed up|seemed|acted)\b/i, why: "the photographer themselves" },
  { re: /\b(professional\w*|courteous|polite|friendly|rude|late (?:to|for) the (?:shoot|appointment)|on ?site|showed up|arriv\w*|punctual)\b/i, why: "conduct on site" },
  { re: /\b(missed (?:the |a )?(?:room|shot|angle|space|closet)|didn'?t (?:shoot|capture|get)|not captured|forgot to (?:shoot|get)|angles?|composition|framing|lighting (?:at|during) the shoot|staging (?:before|during))\b/i, why: "what was captured" },
  { re: /\b(left (?:the )?(?:lights|doors?|blinds)|moved (?:the )?furniture|damage[ds]?|mess)\b/i, why: "how the property was left" },
];

export type AttributionCall = { attribution: Attribution; why: string };

/**
 * Classify one piece of client feedback.
 *
 * `improveNote` ("what would you like done differently?") is the field that
 * actually carries the complaint, so it is weighed first and hardest; the rest
 * is context. A response with nothing recognisable in it comes back OPERATIONS
 * only when it clearly names post-production, and otherwise ONSITE is NOT
 * assumed — an unreadable note returns null from classifyFeedback so it stays
 * out of anybody's score until a person looks at it.
 */
export function classifyFeedback(input: {
  improveNote?: string | null;
  photographerNote?: string | null;
  contentNote?: string | null;
  body?: string | null;
  /** the client's own rating OF the photographer, when they gave one */
  photographerRating?: number | null;
}): AttributionCall | null {
  const hit = (text: string | null | undefined, list: typeof OPERATIONS) => {
    const t = (text ?? "").trim();
    if (!t) return null;
    for (const r of list) if (r.re.test(t)) return r.why;
    return null;
  };

  // The complaint field carries the most weight; the free-text body is the
  // fallback because it is the whole composed response, boilerplate included.
  const complaint = [input.improveNote, input.contentNote].filter(Boolean).join(" ") || null;
  const aboutPerson = input.photographerNote ?? null;

  const opsWhy = hit(complaint, OPERATIONS) ?? hit(input.body, OPERATIONS);
  const siteWhy = hit(aboutPerson, ONSITE) ?? hit(complaint, ONSITE) ?? hit(input.body, ONSITE);

  // A client who rated the PHOTOGRAPHER poorly has said it is about the person,
  // whatever else the note mentions.
  const ratedPhotographerBadly = input.photographerRating != null && input.photographerRating <= 3;

  if (opsWhy && (siteWhy || ratedPhotographerBadly)) {
    return { attribution: "MIXED", why: `${siteWhy ?? "the photographer's rating"} on site, plus ${opsWhy} after the shoot` };
  }
  if (opsWhy) return { attribution: "OPERATIONS", why: `about ${opsWhy} — after the shoot, not the photographer` };
  if (siteWhy || ratedPhotographerBadly) return { attribution: "ONSITE", why: `about ${siteWhy ?? "the photographer's rating"} — at the property` };
  return null; // unreadable — a person decides
}
