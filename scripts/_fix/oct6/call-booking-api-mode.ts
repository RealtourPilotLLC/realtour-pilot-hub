// Oct 12 2026 (Jordan: "Ok go ahead"): switch strategy-call booking from the
// embedded Calendly page to API mode, so the portal lists open times and the
// hub books the call itself. Calendly still sends its own confirmation.
//
// Preconditions met the same day:
//   · the read-only probe passed (31 open times on Content Program - Strategy Call);
//   · the supervised write test (scripts/_ops/calendly-supervised-test.ts --apply)
//     booked, read back, matched and cancelled one call for Jordan Spackman TEST.
//
// Changes exactly two things, both recorded:
//   · call_booking config.mode EMBED -> API (setAutomationConfigField: AuditLog row);
//   · the stored Scheduling API probe (AppSetting calendly_scheduling_probe), re-run now.
// The on/off switch, the fixture list and the program pilot are untouched.
//
//   set -a && source .env; set +a
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct6/call-booking-api-mode.ts           DRY RUN
//   … --apply                                                                                         writes
//   … --apply --embed                                                                                 puts it back to EMBED
import { prisma } from "@/lib/prisma";

async function main() {
  const apply = process.argv.includes("--apply");
  const target = process.argv.includes("--embed") ? "EMBED" : "API";
  const by = "jordan (Oct 12, via main session)";
  const cb = await import("@/lib/callBooking");
  const { setAutomationConfigField, storedAutomationConfigForDisplay } = await import("@/lib/programAutomation");

  const before = await storedAutomationConfigForDisplay("call_booking");
  console.log(`call_booking config now: ${JSON.stringify(before)}`);
  const probe = await cb.runSchedulingProbe({ store: false });
  console.log(`live probe: ${probe.status} (HTTP ${probe.httpStatus}) ${probe.message}`);
  if (target === "API" && probe.status !== "ok") {
    console.log("REFUSED: the Scheduling API probe did not pass, so API mode would fall back to the embedded page anyway.");
    process.exit(2);
  }
  if (!apply) {
    console.log(`DRY RUN: would set mode ${JSON.stringify(before?.mode ?? null)} -> "${target}" and store the probe. Re-run with --apply.`);
    return;
  }
  const r = await setAutomationConfigField("call_booking", "mode", target, by, "call_booking_mode_change");
  console.log(`mode: ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)} (recorded in AuditLog)`);
  const stored = await cb.runSchedulingProbe({ store: true, by });
  console.log(`stored probe: ${stored.status} ${stored.checkedAt} ${stored.message}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
