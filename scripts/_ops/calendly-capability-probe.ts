// ---------------------------------------------------------------------------
// CALENDLY SCHEDULING-API CAPABILITY PROBE (W03, unified handoff Sep 25 2026).
//
// One READ-ONLY question to Calendly: may this account list open times on the
// mapped MONTHLY_STRATEGY event type (GET /event_type_available_times)? The
// Scheduling API — which the portal's API booking mode needs — is a paid-plan
// feature: 200 means yes, 403 means the plan lacks it and the embedded booking
// page is final. The portal never asks Calendly this on a page render; it reads
// the stored answer (AppSetting `calendly_scheduling_probe`).
//
//   set -a && source .env; set +a      # APP_SECRET decrypts the stored Calendly key
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/calendly-capability-probe.ts
//       DRY RUN (the default): asks Calendly (read-only), prints the answer
//       and what is stored today. Writes nothing anywhere.
//
//   … calendly-capability-probe.ts --apply
//       Same question; saves the answer to AppSetting calendly_scheduling_probe
//       (the only row written). Nothing is booked; no switch changes: API mode
//       still needs `call_booking` ON with mode "API" for a scoped client.
//
// Allowed under §4's read-only verification. Prisma self-loads .env, so this
// reads the LIVE database's Calendly key and mapping, by design. Proven against
// a fake Calendly in scripts/_drill/b3-calendly.ts.
// ---------------------------------------------------------------------------

type Log = (line: string) => void;
export type ProbeRunResult = { code: number; mode: "dry-run" | "apply"; status: "ok" | "plan" | "error"; stored: boolean };

export async function runCapabilityProbe(argv: string[], log: Log = (l) => console.log(l)): Promise<ProbeRunResult> {
  const apply = argv.includes("--apply");
  // The Calendly key is stored encrypted under APP_SECRET; without it the key
  // reads as "not connected" and the probe would store a misleading error.
  if (!process.env.APP_SECRET) {
    log("REFUSED: APP_SECRET is not in the environment — run with `set -a && source .env; set +a` first.");
    return { code: 2, mode: apply ? "apply" : "dry-run", status: "error", stored: false };
  }
  const { monthlyStrategyMapping, runSchedulingProbe, storedSchedulingProbe, SCHEDULING_PROBE_KEY } = await import("@/lib/callBooking");
  const mapping = await monthlyStrategyMapping();
  log(`Mapped MONTHLY_STRATEGY type: ${mapping ? `${mapping.eventName} — ${mapping.eventTypeUri} (${mapping.publicUrl})` : "NONE (enabled, with a calendly.com page)"}`);
  const before = await storedSchedulingProbe();
  log(`Stored today (${SCHEDULING_PROBE_KEY}): ${before ? `${before.status} (HTTP ${before.httpStatus ?? "—"}) at ${before.checkedAt} — ${before.message}` : "nothing"}`);
  const probe = await runSchedulingProbe({ store: apply, by: "calendly-capability-probe" });
  log(`Calendly says: ${probe.status.toUpperCase()} (HTTP ${probe.httpStatus ?? "—"}) — ${probe.message}`);
  log(
    probe.status === "ok" ? "  → the Scheduling API is available: API booking mode may be enabled per client (call_booking, mode \"API\")."
    : probe.status === "plan" ? "  → the plan lacks the Scheduling API: the embedded Calendly page is the booking method (no hub write)."
    : "  → could not decide; nothing about booking changes until a probe says ok.",
  );
  log(apply ? `Stored as ${SCHEDULING_PROBE_KEY}.` : "DRY RUN — nothing stored. Re-run with --apply to save this answer.");
  return { code: probe.status === "error" ? 1 : 0, mode: apply ? "apply" : "dry-run", status: probe.status, stored: apply };
}

if (require.main === module) {
  runCapabilityProbe(process.argv.slice(2))
    .then((r) => process.exit(r.code))
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
