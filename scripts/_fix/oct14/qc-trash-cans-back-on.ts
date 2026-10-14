// Oct 14 2026, Jordan: "we do want trash can visibility. That one was subjective."
// BATH_TRASH_CANS comes off the house list (switched off minutes earlier from
// his "Not worth a fix on this listing" decisions). His two ignores stay decided.
import { houseRules, resumeRule } from "@/lib/photoDelivery/houseRules";
async function main() {
  console.log((await resumeRule("BATH_TRASH_CANS", "Jordan Spackman")).message);
  console.log("house list:", (await houseRules()).map((r) => r.ruleId).join(", "));
}
main().then(() => process.exit(0));
