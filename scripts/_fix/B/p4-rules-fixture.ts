// PURE FIXTURES — no database. The two rules that had to keep working while
// SERIOUS 1 was fixed, stated as cases with expected answers.
import { livePromise, pinnedPromise } from "../../../src/lib/turnaround";
import { etDateTime } from "../../../src/lib/datetime";

const d = (s: string) => new Date(s);
let fails = 0;
function check(name: string, got: Date | null, want: Date | null) {
  const ok = (got?.getTime() ?? null) === (want?.getTime() ?? null);
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(62)} -> ${got ? etDateTime(got) : "no pin"}`);
}

const pin = d("2026-09-07T18:30:00.000Z"); // Mon Sep 7 2:30pm ET

console.log("livePromise / pinnedPromise");
// The failure the reviewer demonstrated: a monthly job with no visit. The board
// used to hand this function `now`, so the pin died on every render.
check("no shoot date at all — the pin stands", pinnedPromise({ promisedDueAt: pin, shootDate: null }), pin);
check("column not selected (undefined) — the pin stands", pinnedPromise({ promisedDueAt: pin }), pin);
// The rule that must SURVIVE the fix: a rebook genuinely voids the pin.
check("rebooked to the end of the month — pin voided", pinnedPromise({ promisedDueAt: pin, shootDate: d("2026-09-30T14:00:00Z") }), null);
check("rebooked to a past visit after the pin — pin voided", pinnedPromise({ promisedDueAt: pin, shootDate: d("2026-09-10T14:00:00Z") }), null);
check("shoot BEFORE the pin (the normal job) — pin stands", pinnedPromise({ promisedDueAt: pin, shootDate: d("2026-09-05T14:00:00Z") }), pin);
check("shoot exactly AT the pin — pin voided (precedes its own shoot)", pinnedPromise({ promisedDueAt: pin, shootDate: pin }), null);
check("no pin at all", pinnedPromise({ promisedDueAt: null, shootDate: d("2026-09-05T14:00:00Z") }), null);
// `now` must no longer be able to answer the question — the argument is the
// shoot date, and a caller that has none passes none.
check("livePromise primitive, shoot date null", livePromise(pin, null), pin);

process.exit(fails ? 1 : 0);
