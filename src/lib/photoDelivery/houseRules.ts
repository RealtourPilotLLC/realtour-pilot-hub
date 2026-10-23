import "server-only";

import { prisma } from "@/lib/prisma";
import { ruleById, type RuleOverride } from "./registry";

// ---------------------------------------------------------------------------
// CHECKS JORDAN SWITCHED OFF, FOR EVERY SHOOT (Oct 14 2026).
//
// Jordan: "For the QC I dont need to know about Resolution consistency ...
// Look over the things I ignored or said were not an issue, and let's try to
// make sure that stuff doesn't get added." One house-wide list (a client's own
// profile can still say otherwise, rule by rule). A rule on it is:
//   · never asked about (the paid QC's rule lists, the free check's prompt),
//   · never written (measured checks such as gallery resolution included),
//   · never counted in a verdict or shown,
// and its open findings are set aside, with the reason, when it goes on.
// Taken off again from Photo Delivery settings. Owner only.
// ---------------------------------------------------------------------------

export type HouseRule = { ruleId: string; reason: string; by: string; at: string };
const KEY = "photo_delivery:house_rules";

async function readList(): Promise<{ raw: string | null; rules: HouseRule[] }> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { value: true } });
  if (!row) return { raw: null, rules: [] };
  let parsed: { rules?: unknown } = {};
  try {
    parsed = JSON.parse(row.value) as { rules?: unknown };
  } catch {
    /* an unreadable row reads as an empty list; the next change replaces it */
  }
  const rules = (Array.isArray(parsed.rules) ? (parsed.rules as HouseRule[]) : []).filter((r) => r && typeof r.ruleId === "string");
  return { raw: row.value, rules };
}

/**
 * The list, read fresh (audit C19, Oct 20 2026): a check switched off applies
 * on the next QC everywhere, not a minute later. A read that fails is an empty
 * list, as before: it must never break a QC run.
 */
export async function houseRules(): Promise<HouseRule[]> {
  return (await readList().catch(() => null))?.rules ?? [];
}

/**
 * One compare-and-swap on the list (audit C19): two quick presses never drop
 * each other's rule. `change` answers null when there is nothing to change.
 */
async function changeList(by: string, change: (list: HouseRule[]) => HouseRule[] | null): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { raw, rules } = await readList();
    const next = change(rules);
    if (!next) return false;
    const value = JSON.stringify({ rules: next });
    const updatedBy = by.slice(0, 120);
    if (raw == null) {
      const made = await prisma.appSetting.create({ data: { key: KEY, value, updatedBy } }).then(() => true, () => false);
      if (made) return true;
      continue; // someone else wrote the first rule a moment ago: read again
    }
    const r = await prisma.appSetting.updateMany({ where: { key: KEY, value: raw }, data: { value, updatedBy } });
    if (r.count === 1) return true;
  }
  throw new Error("The list of switched-off checks kept changing. Try again in a moment.");
}

/** As rule overrides (disabled), for the engines. */
export async function houseOverrides(): Promise<RuleOverride[]> {
  return (await houseRules()).map((r) => ({ ruleId: r.ruleId, disabled: true, reason: r.reason }));
}

/** House rules first, then the client's own: a client entry for the same rule wins. */
export function mergeOverrides(house: RuleOverride[], client: RuleOverride[] | null | undefined): RuleOverride[] {
  const own = new Set((client ?? []).map((o) => o.ruleId));
  return [...house.filter((o) => !own.has(o.ruleId)), ...(client ?? [])];
}

export const disabledIn = (overrides: RuleOverride[] | null | undefined) => new Set((overrides ?? []).filter((o) => o.disabled).map((o) => o.ruleId));

/** Switch a check off for every shoot and set its open findings aside. */
/** Oct 22 2026 (photo audit M6): checks only the owner can switch off for every shoot, whoever calls stopRule (the caller passes the real role). */
export const OWNER_ONLY_SWITCH = new Set(["AIEDIT_FLOATING_OBJECT"]);

export async function stopRule(ruleId: string, reason: string, by: string, opts: { role?: string | null } = {}): Promise<{ ok: boolean; message: string; setAside: number }> {
  const rule = ruleById(ruleId);
  if (!rule) return { ok: false, message: "That check is not one the hub knows.", setAside: 0 };
  if (OWNER_ONLY_SWITCH.has(ruleId) && opts.role !== "OWNER") return { ok: false, message: "Only Jordan can switch this check off for every shoot (an editing mistake the client sees). Decide it one by one instead.", setAside: 0 };
  if (ruleId === "OTHER_DEFECT") return { ok: false, message: "The catch-all check can't be switched off; ignore those one by one.", setAside: 0 };
  // Oct 14 2026 (huddle): an AI fix that changed the house is never hidden house-wide.
  if (ruleId === "FIX_DAMAGE_AI_EDIT") return { ok: false, message: "This one can't be switched off: it is how the hub says an AI fix changed a house. Restore the photo, or decide it one by one.", setAside: 0 };
  // Audit C19 (Oct 20 2026): what the house fixes on every shoot (trash cans
  // above all: always wanted) is never switched off for every shoot.
  const { ALWAYS_FIX } = await import("./fixPolicy");
  if (ALWAYS_FIX.has(ruleId)) return { ok: false, message: "This one can't be switched off: the hub fixes it on every shoot (trash cans, cars, camera mistakes, lens distortion). Decide it one by one instead.", setAside: 0 };
  const why = reason.trim().slice(0, 300) || "Jordan does not need to know about this";
  await changeList(by, (list) => (list.some((r) => r.ruleId === ruleId) ? null : [...list, { ruleId, reason: why, by: by.slice(0, 120), at: new Date().toISOString() }]));
  const r = await prisma.photoQcFinding.updateMany({
    where: { ruleId, status: "OPEN" },
    data: { status: "IGNORED", statusReason: `Not checked any more: ${why}`.slice(0, 300), decidedBy: by.slice(0, 120), decidedAt: new Date() },
  });
  return { ok: true, message: `"${rule.shortLabel}" is no longer checked on any shoot${r.count ? ` (${r.count} open finding${r.count === 1 ? "" : "s"} set aside)` : ""}.`, setAside: r.count };
}

/** Check it again from the next QC on. Findings set aside stay decided. */
export async function resumeRule(ruleId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const changed = await changeList(by, (list) => (list.some((r) => r.ruleId === ruleId) ? list.filter((r) => r.ruleId !== ruleId) : null));
  if (!changed) return { ok: false, message: "That check is already on." };
  return { ok: true, message: `"${ruleById(ruleId)?.shortLabel ?? ruleId}" is checked again from the next QC on.` };
}
