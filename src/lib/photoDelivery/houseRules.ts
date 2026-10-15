import "server-only";

import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
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

export async function houseRules(): Promise<HouseRule[]> {
  const raw = await getSetting<{ rules?: HouseRule[] }>(KEY, {});
  return (Array.isArray(raw.rules) ? raw.rules : []).filter((r) => r && typeof r.ruleId === "string");
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
export async function stopRule(ruleId: string, reason: string, by: string): Promise<{ ok: boolean; message: string; setAside: number }> {
  const rule = ruleById(ruleId);
  if (!rule) return { ok: false, message: "That check is not one the hub knows.", setAside: 0 };
  if (ruleId === "OTHER_DEFECT") return { ok: false, message: "The catch-all check can't be switched off; ignore those one by one.", setAside: 0 };
  // Oct 14 2026 (huddle): an AI fix that changed the house is never hidden house-wide.
  if (ruleId === "FIX_DAMAGE_AI_EDIT") return { ok: false, message: "This one can't be switched off: it is how the hub says an AI fix changed a house. Restore the photo, or decide it one by one.", setAside: 0 };
  const why = reason.trim().slice(0, 300) || "Jordan does not need to know about this";
  const list = await houseRules();
  if (!list.some((r) => r.ruleId === ruleId)) {
    await putSetting(KEY, { rules: [...list, { ruleId, reason: why, by: by.slice(0, 120), at: new Date().toISOString() }] }, by);
  }
  const r = await prisma.photoQcFinding.updateMany({
    where: { ruleId, status: "OPEN" },
    data: { status: "IGNORED", statusReason: `Not checked any more: ${why}`.slice(0, 300), decidedBy: by.slice(0, 120), decidedAt: new Date() },
  });
  return { ok: true, message: `"${rule.shortLabel}" is no longer checked on any shoot${r.count ? ` (${r.count} open finding${r.count === 1 ? "" : "s"} set aside)` : ""}.`, setAside: r.count };
}

/** Check it again from the next QC on. Findings set aside stay decided. */
export async function resumeRule(ruleId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const list = await houseRules();
  if (!list.some((r) => r.ruleId === ruleId)) return { ok: false, message: "That check is already on." };
  await putSetting(KEY, { rules: list.filter((r) => r.ruleId !== ruleId) }, by);
  return { ok: true, message: `"${ruleById(ruleId)?.shortLabel ?? ruleId}" is checked again from the next QC on.` };
}
