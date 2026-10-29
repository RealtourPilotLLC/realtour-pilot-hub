import { prisma } from "@/lib/prisma";
import { scrubMoney } from "@/lib/text";

// ---------------------------------------------------------------------------
// A PHOTO CHECK FINDING AS COACHING EVIDENCE (Oct 29 2026, Jordan's call table:
// "No 'not an issue' outcome" and "Photo QC flags lack context: neighbor
// vehicles, city parking, and minor objects could become performance issues
// automatically").
//
// The free photo check names who answers for a finding (responsibility), and
// until today every finding the photographer "owned" fed James's coaching
// rows on its own: a neighbor's car in the driveway on 11 shoots read as
// Harrison's habit. Now:
//   · WHAT IS AT THE PROPERTY (vehicles, bins, cords, belongings, staging,
//     furniture, the yard: the PREP_, KIT_, BATH_, BED_, LIV_, UTIL_ and EXT_
//     checks, a few others) counts as coaching evidence only after a person
//     says it was the photographer's to fix. Capture skill (focus, framing,
//     composition, coverage) counts as before: nobody else holds the camera.
//   · Anyone with the development seat (Jordan, James) can call any finding
//     "the photographer's to fix" or "not an issue", the second either
//     "outside the photographer's control" or "the check was wrong", with an
//     optional reason. A call is one AppSetting row, qc_coach:<findingId>,
//     undoable; the finding itself is never touched (the photo desk's own
//     decision stands).
//   · A person's own words on the photo desk count too: an Ignore that says a
//     neighbor's car or the street is a "not an issue" here; a Reshoot a
//     person asked for is a confirmation.
//   · The calls are kept as a tally per check. A capture check that people
//     keep calling "not an issue" (3 or more, two in three of its calls, 90
//     days) needs a person's look too; "the check was wrong" calls also count
//     as "Not there" in what the photo desk learns (fixPolicy.learnedRules:
//     fixed automatically only when very sure). Nothing here switches a check
//     off: that stays Jordan's own call on the photo desk.
// ---------------------------------------------------------------------------

export type CoachVerdict = "coach" | "not_theirs" | "wrong";
export const COACH_VERDICTS: readonly CoachVerdict[] = ["coach", "not_theirs", "wrong"];
export const isCoachVerdict = (v: unknown): v is CoachVerdict => COACH_VERDICTS.includes(v as CoachVerdict);
export type CoachCall = { verdict: CoachVerdict; reason: string | null; by: string; at: string; ruleId: string; jobId: string };
export type CoachState = "counts" | "needs_look" | "dismissed";

export const coachKey = (findingId: string) => `qc_coach:${findingId}`;
const PREFIX = "qc_coach:";
const DAY = 86_400_000;
export const TALLY_DAYS = 90;

export const VERDICT_WORDS: Record<CoachVerdict, string> = {
  coach: "The photographer's to fix",
  not_theirs: "Not an issue: outside the photographer's control",
  wrong: "Not an issue: the check was wrong",
};

// ---- which checks need a person's look --------------------------------------------------

const AT_PROPERTY = /^(PREP|KIT|BATH|BED|LIV|UTIL|EXT)_/;
/** At the property, outside those sections: the catch-all, what shows through a window, the house's own bulbs. */
const AT_PROPERTY_EXTRA = new Set(["OTHER_DEFECT", "REFL_OBJECTS_THROUGH_WINDOWS", "REFL_REFLECTIONS_MISTAKEN_OBJECTS", "EXPO_BURNED_OUT_BULBS"]);
/** Capture skill inside those sections: how the room was shown, and the photographer's own car. */
const CAPTURE_INSIDE = new Set([
  "BATH_TOILET_EMPHASIZED", "BATH_FAILS_TO_REPRESENT", "BATH_FISHEYE_SMALL_BATHROOMS", "UTIL_LAUNDRY_COMPOSITION", "UTIL_MISSING_FEATURES",
  "EXT_MISSING_AMENITIES", "EXT_INCOMPLETE_HOME_VIEW", "EXT_PHOTOGRAPHER_VEHICLE",
]);

/** Is this check about what is at the property (so a person decides whether the photographer could have fixed it)? */
export function atTheProperty(ruleId: string): boolean {
  if (CAPTURE_INSIDE.has(ruleId)) return false;
  return AT_PROPERTY.test(ruleId) || AT_PROPERTY_EXTRA.has(ruleId);
}

export type RuleTally = { ruleId: string; coach: number; notTheirs: number; wrong: number };
/** People keep calling this capture check "not an issue": 3 or more, two in three of its calls. */
export const learnedNeedsLook = (t: RuleTally | undefined): boolean => {
  if (!t) return false;
  const no = t.notTheirs + t.wrong;
  return no >= 3 && no / (no + t.coach) >= 2 / 3;
};
export const needsPerson = (ruleId: string, tally: Map<string, RuleTally>): boolean => atTheProperty(ruleId) || learnedNeedsLook(tally.get(ruleId));

/** "Not an issue 4 of 5 times in 90 days", or null when nobody has called it. */
export function tallyWords(t: RuleTally | undefined): string | null {
  if (!t) return null;
  const no = t.notTheirs + t.wrong;
  const all = no + t.coach;
  if (!all) return null;
  const parts = [t.notTheirs ? `${t.notTheirs} outside the photographer's control` : null, t.wrong ? `${t.wrong} the check was wrong` : null].filter(Boolean);
  return `Called not an issue ${no} of ${all} ${all === 1 ? "time" : "times"} in ${TALLY_DAYS} days${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

// ---- the photo desk's own words ---------------------------------------------------------------

const SYSTEM_DECIDER = /^(auto-|free second look|fix-runner|hub\b|system)/i;
/** A person's reason on the photo desk that says it was not the photographer's: a neighbor's car, the street, the city. */
export const NOT_THEIRS_WORDS = /\b(neighbou?rs?'?s?|next door|across the street|street parking|on the street|parked on the street|city|town|public|not (?:the|their|our|his|her|client'?s?) (?:house|home|car|property)|not (?:part of|on) the (?:property|lot|listing)|outside (?:of )?(?:their|his|her|the photographer'?s?|our) control|couldn'?t (?:be )?(?:moved|move)|can'?t (?:be )?moved?|not movable)\b/i;

export function coachState(
  f: { ruleId: string; status: string; decidedBy: string | null; statusReason: string | null },
  call: CoachCall | null,
  tally: Map<string, RuleTally>,
): { state: CoachState; why: string } {
  if (call) return call.verdict === "coach" ? { state: "counts", why: `Confirmed by ${call.by}` } : { state: "dismissed", why: `${VERDICT_WORDS[call.verdict]} (${call.by})` };
  const person = !!f.decidedBy && !SYSTEM_DECIDER.test(f.decidedBy);
  if (f.status === "FALSE_POSITIVE") return { state: "dismissed", why: "Not there (photo desk)" };
  if (person && (f.status === "IGNORED" || f.status === "OVERRIDDEN") && NOT_THEIRS_WORDS.test(f.statusReason ?? "")) {
    return { state: "dismissed", why: `${f.decidedBy} on the photo desk: ${clip(f.statusReason ?? "", 80)}` };
  }
  if (!needsPerson(f.ruleId, tally)) return { state: "counts", why: "Capture skill" };
  if (person && f.status === "RESHOOT_REQUESTED") return { state: "counts", why: `${f.decidedBy} asked for a reshoot` };
  return { state: "needs_look", why: "Needs a person's look" };
}

const clip = (s: string, n: number) => {
  const t = scrubMoney(s.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim());
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// ---- the store ----------------------------------------------------------------------------------

function parseCall(raw: string | null | undefined): CoachCall | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CoachCall>;
    if (!isCoachVerdict(v.verdict) || typeof v.at !== "string" || typeof v.ruleId !== "string") return null;
    return { verdict: v.verdict, reason: typeof v.reason === "string" && v.reason ? v.reason : null, by: typeof v.by === "string" ? v.by : "someone", at: v.at, ruleId: v.ruleId, jobId: typeof v.jobId === "string" ? v.jobId : "" };
  } catch {
    return null;
  }
}

/** The calls on these findings, by finding id. */
export async function coachCalls(findingIds: string[]): Promise<Map<string, CoachCall>> {
  const out = new Map<string, CoachCall>();
  if (!findingIds.length) return out;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: findingIds.map(coachKey) } }, select: { key: true, value: true } });
  for (const r of rows) {
    const c = parseCall(r.value);
    if (c) out.set(r.key.slice(PREFIX.length), c);
  }
  return out;
}

async function recentCalls(since: Date): Promise<{ findingId: string; call: CoachCall }[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: PREFIX } }, select: { key: true, value: true }, take: 5000 });
  const out: { findingId: string; call: CoachCall }[] = [];
  for (const r of rows) {
    const c = parseCall(r.value);
    if (c && Date.parse(c.at) >= since.getTime()) out.push({ findingId: r.key.slice(PREFIX.length), call: c });
  }
  return out;
}

/** Every check's calls in the last 90 days: the false-alarm tally the coaching rows and the panel read. */
export async function coachTally(now = new Date()): Promise<Map<string, RuleTally>> {
  const out = new Map<string, RuleTally>();
  for (const { call } of await recentCalls(new Date(now.getTime() - TALLY_DAYS * DAY))) {
    const t = out.get(call.ruleId) ?? { ruleId: call.ruleId, coach: 0, notTheirs: 0, wrong: 0 };
    if (call.verdict === "coach") t.coach++;
    else if (call.verdict === "not_theirs") t.notTheirs++;
    else t.wrong++;
    out.set(call.ruleId, t);
  }
  return out;
}

/** "The check was wrong" calls since then, finding id → check: fixPolicy.learnedRules reads them as "Not there". */
export async function checkWasWrong(since: Date): Promise<Map<string, string>> {
  return new Map((await recentCalls(since)).filter((x) => x.call.verdict === "wrong").map((x) => [x.findingId, x.call.ruleId] as const));
}

/**
 * Write (or, with null, take back) a call on these findings. The caller checked
 * the seat and that each finding is one the photographer answers for.
 */
export async function setCoachCalls(
  findings: { id: string; ruleId: string; jobId: string }[],
  verdict: CoachVerdict | null,
  reason: string | null,
  by: string,
  at = new Date(),
): Promise<number> {
  if (!findings.length) return 0;
  if (!verdict) {
    const r = await prisma.appSetting.deleteMany({ where: { key: { in: findings.map((f) => coachKey(f.id)) } } });
    return r.count;
  }
  const words = reason ? clip(reason, 300) || null : null;
  await prisma.$transaction(findings.map((f) => {
    const value = JSON.stringify({ verdict, reason: words, by, at: at.toISOString(), ruleId: f.ruleId, jobId: f.jobId } satisfies CoachCall);
    return prisma.appSetting.upsert({ where: { key: coachKey(f.id) }, create: { key: coachKey(f.id), value }, update: { value } });
  }));
  return findings.length;
}
