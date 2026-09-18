// READ-ONLY (asserts it, see the guard at the end). Group CE / C1:
// the coverage window the settings card confirms vs the one the pager reads.
//
// Part 1 reads the live internal_alerts row and the normalised rules.
// Part 2 is the scenario the reviewer demonstrated: fromHour 18 / toHour 9.
// Part 3 calls saveInternalAlerts with that window and checks that (a) it is
// refused and (b) the AppSetting row is byte-identical afterwards.
//
// Run with:  NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/CE/probe-coverage.ts
// The one stub below is the price of importing a "use server" module outside a
// request: next/navigation's client module needs React.createContext, which the
// react-server build of React does not have. Nothing on the path under test
// calls redirect().
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Mod = require("module");
const load = Mod._load;
Mod._load = function (request: string, ...rest: unknown[]) {
  if (request === "next/navigation") return { redirect: () => { throw new Error("probe: redirect() is not expected on this path"); } };
  return load.call(this, request, ...rest);
};

import { prisma } from "../../../src/lib/prisma";
import { internalAlertRules } from "../../../src/lib/settings";
import { describeCoverage, withinCoverageAt, nextCoveredMomentAt } from "../../../src/lib/coverage";

async function main() {
  const { saveInternalAlerts } = (await import("../../../src/app/settings/actions")) as any;
  const row = await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } });
  console.log("live AppSetting internal_alerts:", row ? row.value : "(no row — defaults apply)");
  const live = await internalAlertRules();
  console.log("internalAlertRules().coverage:", JSON.stringify(live.coverage), "->", describeCoverage(live.coverage));
  console.log("internalAlertRules().photosUndelivered:", JSON.stringify(live.photosUndelivered));

  // --- the scenario -------------------------------------------------------
  const inverted = { weekdaysOnly: true, fromHour: 18, toHour: 9, onCallTeamMemberId: null };
  console.log("\nJordan types 18 -> 9 for evening cover.");
  console.log("  what the save message / the card would say:", describeCoverage(inverted));
  // Wednesday 2026-09-16, every hour of the ET day.
  const covered: number[] = [];
  for (let h = 0; h < 24; h++) {
    const at = new Date(Date.UTC(2026, 8, 16, h + 4, 30)); // ET = UTC-4 in September
    if (withinCoverageAt(at, inverted)) covered.push(h);
  }
  console.log(`  hours withinCoverageAt() actually covers on a Wednesday with that window: ${covered.length} of 24 ${covered.length ? `(${covered.join(",")})` : "(none — the window can never be true)"}`);
  console.log("  nextCoveredMomentAt(Wed 8pm ET):", nextCoveredMomentAt(new Date(Date.UTC(2026, 8, 17, 0, 0)), inverted).toISOString());
  // And what the READER makes of it once stored: settings.ts:460-461 is
  // `fromHour: covTo > covFrom ? covFrom : d.coverage.fromHour` — 9 > 18 is
  // false, so both hours fall back to the DEFAULT and the pager runs 9am-6pm.
  console.log("  settings.ts:460-461 discards it and returns the DEFAULT 9-18 — so the pager runs Mon-Fri, 9am-6pm ET.");

  // --- the guard ----------------------------------------------------------
  const before = await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } });
  const res = await saveInternalAlerts({ ...live, coverage: inverted });
  console.log("\nsaveInternalAlerts({coverage: 18 -> 9}) =>", JSON.stringify(res));
  const after = await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } });
  const unchanged = before?.value === after?.value && before?.updatedAt?.getTime() === after?.updatedAt?.getTime();
  console.log(`AppSetting row after the refused save: ${after ? after.value : "(still no row)"}`);
  console.log("row unchanged:", unchanged, "| existed before:", !!before, "| exists after:", !!after, "| value equal:", before?.value === after?.value, "| updatedAt equal:", before?.updatedAt?.toISOString() === after?.updatedAt?.toISOString());

  // The same refusal for the other two shapes, so the message is checked as
  // well as the refusal.
  console.log("same hour  =>", JSON.stringify((await saveInternalAlerts({ ...live, coverage: { ...live.coverage, fromHour: 12, toHour: 12 } })).message));
  console.log("photos 19->16 =>", JSON.stringify((await saveInternalAlerts({ ...live, photosUndelivered: { ...live.photosUndelivered, fromHour: 19, toHour: 16 } })).message));
  console.log("chaser hour 25 =>", JSON.stringify((await saveInternalAlerts({ ...live, uploadChaser: { ...live.uploadChaser, hour: 25 } })).message));
  const after2 = await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } });
  console.log("row still untouched after all four refusals:", after2?.value === before?.value && !!after2 === !!before);

  // A valid window must still be accepted — checked WITHOUT writing by asking
  // the same predicate the action uses, on the live values.
  const c = live.coverage;
  console.log("live window passes the new rule:", Number.isInteger(c.fromHour) && Number.isInteger(c.toHour) && c.fromHour >= 0 && c.toHour <= 23 && c.fromHour < c.toHour);
  const p = live.photosUndelivered;
  console.log("live photos window passes the new rule:", Number.isInteger(p.fromHour) && Number.isInteger(p.toHour) && p.fromHour >= 0 && p.toHour <= 23 && p.fromHour < p.toHour);

  if (!unchanged) throw new Error("PROBE FAILED: the settings row was written. That must never happen.");
  await prisma.$disconnect();
}
main();
