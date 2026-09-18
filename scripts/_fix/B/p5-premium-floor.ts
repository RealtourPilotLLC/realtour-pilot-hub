// PURE FIXTURE — no database. MINOR 4: is "Premium reel / video" on the
// Settings screen a live control again, and does it stay harmless at 72?
import { premiumDueFrom, PREMIUM_FLOOR_HOURS } from "../../../src/lib/turnaround";
import { etDateTime } from "../../../src/lib/datetime";
import { DEFAULT_TURNAROUNDS } from "../../../src/lib/settings";

const rules = (premiumVideoHours: number) => ({ ...DEFAULT_TURNAROUNDS, premiumVideoHours });

// 1. At the shipped default the floor must never win — no client's deadline
//    may move because this became a live control.
let moved = 0;
let anchors = 0;
const start = new Date("2026-01-01T00:00:00Z").getTime();
for (let h = 0; h < 730 * 24; h++) {
  const anchor = new Date(start + h * 3_600_000);
  anchors++;
  const withRules = premiumDueFrom(anchor, rules(PREMIUM_FLOOR_HOURS));
  const withNone = premiumDueFrom(anchor, null);
  if (withRules.getTime() !== withNone.getTime()) moved++;
}
console.log(`default ${PREMIUM_FLOOR_HOURS}h floor vs no settings at all: ${moved} of ${anchors} hourly anchors differ (2026-2027)`);

// 2. The reviewer's exact check: premiumVideoHours = 240 "now changes nothing".
const cases = [
  ["Fri 9am shoot", new Date("2026-09-11T13:00:00Z")],
  ["Mon 9am shoot", new Date("2026-09-14T13:00:00Z")],
  ["Wed 4pm shoot", new Date("2026-09-16T20:00:00Z")],
] as const;
console.log("\n            anchor            72h (shipped)           240h (Kyle types 240)");
for (const [label, anchor] of cases) {
  const at72 = premiumDueFrom(anchor, rules(72));
  const at240 = premiumDueFrom(anchor, rules(240));
  console.log(`  ${label.padEnd(16)} ${etDateTime(anchor).padEnd(22)} ${etDateTime(at72).padEnd(22)} ${etDateTime(at240)}${at240.getTime() === at72.getTime() ? "   <-- DEAD CONTROL" : "   moved"}`);
}

// 3. The floor may only ever push the promise LATER, and it must never land on
//    a weekend — the reason the reel stopped being elapsed hours at all.
let earlier = 0;
let weekend = 0;
for (let h = 0; h < 365 * 24; h++) {
  const anchor = new Date(start + h * 3_600_000);
  const base = premiumDueFrom(anchor, rules(72));
  for (const hours of [1, 24, 100, 240, 720]) {
    const at = premiumDueFrom(anchor, rules(hours));
    if (at < base) earlier++;
    const dow = at.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
    if (dow === "Sat" || dow === "Sun") weekend++;
  }
}
console.log(`\nany setting that dates a reel EARLIER than the dictated four business days: ${earlier}`);
console.log(`any setting that lands the deadline on a weekend: ${weekend}`);
process.exit(moved === 0 && earlier === 0 && weekend === 0 ? 0 : 1);
