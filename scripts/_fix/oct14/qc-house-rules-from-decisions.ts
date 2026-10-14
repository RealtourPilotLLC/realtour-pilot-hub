// Oct 14 2026, Jordan: "For the QC I dont need to know about Resolution
// consistency ... Look over the things I ignored or said were not an issue,
// and let's try to make sure that stuff doesn't get added."
// Every rule Jordan ignored or marked not-an-issue (read from the findings he
// decided, Oct 14 05:12-05:23 UTC) goes on the house list, with his reason.
import { stopRule, houseRules } from "@/lib/photoDelivery/houseRules";
const BY = "Jordan Spackman";
const RULES: [string, string][] = [
  ["GAL_RESOLUTION_CONSISTENCY", "We don't need to know this (ignored 66 times)"],
  ["KIT_CABINET_COLOR_ACROSS_PHOTOS", "Lighting differences are fine"],
  ["PERSP_STRETCHED_EDGE_FURNITURE", "Ignored: not an issue for us"],
  ["PERSP_EXCESSIVE_FISHEYE", "Not an issue: nothing like this was in the photo"],
  ["COMP_MOTION_BLUR", "Not an issue: a ceiling fan's soft blades were flagged"],
  ["BATH_TRASH_CANS", "Not worth fixing"],
];
async function main() {
  for (const [id, why] of RULES) console.log((await stopRule(id, why, BY)).message);
  console.log("house list:", (await houseRules()).map((r) => r.ruleId).join(", "));
}
main().then(() => process.exit(0));
