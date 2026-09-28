// ---------------------------------------------------------------------------
// WHAT A PRODUCT NEEDS BEFORE IT CAN BE MADE (§10 AU-01 phase 2, Sep 26 2026).
//
// Settings → Products already says what a product PRODUCES. This says what it
// NEEDS first — a video needs a shoot on the calendar, a personal-branding reel
// needs the client's brand discovery, an agent-intro reel needs its script.
// The owner sets the list per product (Product.prerequisitesJson); null means
// "none known", which is every product until he says otherwise.
//
// THREE RULES:
//   · IT ONLY EVER REPORTS. A missing prerequisite is a row on Kyle's
//     exceptions board (opsExceptions.ts) with an owner and a next action. It
//     never blocks a booking, a shoot, an edit or a delivery.
//   · ONLY WHAT THE HUB CAN ACTUALLY CHECK. Every key below reads a column this
//     database already has. A key nobody can check is not offered, because a
//     checkbox the hub cannot evaluate would read "met" forever.
//   · ONLY MAPPED PRODUCTS. A product nobody has mapped is already its own row
//     ("unmapped-scope"); its prerequisites wait until someone says what it is.
//
// Client-safe on purpose (no prisma import): the Settings card reads the list
// of keys and labels from here.
// ---------------------------------------------------------------------------

export const PREREQUISITE_KEYS = ["shoot_date", "exact_address", "photographer", "brand_discovery", "script"] as const;
export type PrerequisiteKey = (typeof PREREQUISITE_KEYS)[number];

/** The words for each, in the order the card shows them. `missing` is the
 *  clause the exceptions row prints when the job does not have it. */
export const PREREQUISITES: Record<PrerequisiteKey, { label: string; missing: string; hint: string }> = {
  shoot_date: { label: "A shoot on the calendar", missing: "no shoot date", hint: "the job has a shoot date" },
  exact_address: { label: "An exact address", missing: "no exact address", hint: "a street address, or map coordinates from Aryeo" },
  photographer: { label: "A photographer assigned", missing: "no photographer on it", hint: "someone is on the appointment" },
  brand_discovery: { label: "Brand discovery done", missing: "brand discovery not done", hint: "the client's discovery was held or waived" },
  script: { label: "A script on the job", missing: "no script on the job", hint: "the reel's hook or script is filled in" },
};

/** Parse a stored list. Unknown keys are dropped — a key the hub no longer
 *  checks must not read as met or as missing. Never throws. */
export function parsePrerequisites(json: string | null | undefined): PrerequisiteKey[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    const known = new Set<string>(PREREQUISITE_KEYS);
    return [...new Set(raw.filter((k): k is PrerequisiteKey => typeof k === "string" && known.has(k)))];
  } catch {
    return [];
  }
}

/** What one job has, as far as the prerequisites go. */
export type PrerequisiteFacts = {
  shootDate: Date | null;
  addressLine: string | null;
  lat: number | null;
  lng: number | null;
  photographerId: string | null;
  reelScript: string | null;
  reelHook: string | null;
  /** the client's onboarding: held/waived = true, not held = false, no record = null */
  discoveryDone: boolean | null;
};

/** An address a creative could drive to: a house number on the street line,
 *  or the coordinates Aryeo sends with a listing. "Philadelphia, PA" is not. */
const STREET_NUMBER = /^\s*\d+[a-z]?\b/i;

/** Which of `needs` this job is missing. Pure — the drill argues with it. */
export function missingPrerequisites(needs: PrerequisiteKey[], f: PrerequisiteFacts): PrerequisiteKey[] {
  const has: Record<PrerequisiteKey, boolean> = {
    shoot_date: !!f.shootDate,
    exact_address: (!!f.addressLine && STREET_NUMBER.test(f.addressLine)) || (f.lat != null && f.lng != null),
    photographer: !!f.photographerId,
    // No onboarding record at all is "not done" for a product that needs one:
    // the requirement is the owner's, and nothing on file says it was met.
    brand_discovery: f.discoveryDone === true,
    script: !!(f.reelScript?.trim() || f.reelHook?.trim()),
  };
  return needs.filter((k) => !has[k]);
}

/** Onboarding states that mean discovery happened or was waived (the
 *  ProgramOnboarding.status ladder, schema.prisma). */
export const DISCOVERY_DONE_STATES: ReadonlySet<string> = new Set([
  "DISCOVERY_HELD",
  "TRANSCRIPT_PENDING",
  "STRATEGY_DRAFTED",
  "STRATEGY_IN_REVIEW",
  "STRATEGY_APPROVED",
  "BANK_GENERATED",
  "COMPLETE",
  "WAIVED",
]);
