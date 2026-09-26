// ---------------------------------------------------------------------------
// ARM / DISARM ONE TEST FIXTURE ON A PROVIDER-WRITE SWITCH (batch-3 review,
// Sep 25 2026). For the supervised Aryeo and Calendly tests, run by the main
// session. It changes exactly two things, both recorded in AuditLog:
//   · the switch's `authorizedFixtureClientIds` — through lib/hubWriteFixtures
//     (the one writer of that field: a TEST name, never a real client renamed
//     TEST, its own email the verified test inbox, not in the pilot);
//   · with --on / --off, the switch's enabled flag — config untouched.
// It NEVER touches a pilot, a mode or any other config key (the old printed
// command, setAutomation(key, true, by, JSON.stringify({...})), replaced the
// whole config and would have dropped an approved pilot without a trace), and
// it refuses --on while the switch carries a pilot with clients in it: turning
// the switch on would write for those real clients too.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/hub-write-fixture.ts \
//       --switch session_booking --add <clientId> --on            DRY RUN (default): prints the change
//   … --apply                                                     writes it
//   … --switch session_booking --remove <clientId> --off --apply  the cleanup
//
// Prisma self-loads .env: with --apply this writes to the LIVE database, by design.
// ---------------------------------------------------------------------------

type Log = (line: string) => void;
export type FixtureOpResult = { code: number; mode: "dry-run" | "apply"; refused?: string; from?: string[]; to?: string[]; enabled?: boolean };

export const FIXTURE_SCRIPT = "NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/hub-write-fixture.ts";

const arg = (argv: string[], name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

export async function hubWriteFixture(argv: string[], log: Log = (l) => console.log(l)): Promise<FixtureOpResult> {
  const apply = argv.includes("--apply");
  const mode = apply ? "apply" : "dry-run";
  const refuse = (why: string): FixtureOpResult => { log(`REFUSED: ${why}`); return { code: 2, mode, refused: why }; };
  const switchKey = arg(argv, "--switch");
  const add = arg(argv, "--add");
  const remove = arg(argv, "--remove");
  const on = argv.includes("--on");
  const off = argv.includes("--off");
  const { isHubWriteSwitch, parseHubWriteConfig } = await import("@/lib/hubWritePermit");
  if (!isHubWriteSwitch(switchKey)) return refuse(`--switch must be one of session_booking, address_sync, call_booking (got ${switchKey ?? "nothing"})`);
  if (!add && !remove && !on && !off) return refuse("nothing to do: pass --add <clientId>, --remove <clientId>, --on or --off");
  if (on && off) return refuse("--on and --off together");
  if (add && remove) return refuse("--add and --remove together");
  const { prisma } = await import("@/lib/prisma");
  const { storedAutomationConfigForDisplay, getAutomation, setAutomation } = await import("@/lib/programAutomation");
  const cfg = parseHubWriteConfig(await storedAutomationConfigForDisplay(switchKey));
  const state = await getAutomation(switchKey);
  const pilotIds = cfg.pilot?.clientIds ?? [];
  log(`${switchKey}: ${state.enabled ? "ON" : state.missing ? "never configured (off)" : "OFF"} · fixtures ${JSON.stringify(cfg.authorizedFixtureClientIds)} · pilot ${pilotIds.length ? `${pilotIds.length} client(s)` : "none"}`);
  if (on && pilotIds.length) return refuse(`${switchKey} carries a pilot with ${pilotIds.length} real client(s) (${pilotIds.join(", ")}): switching it on would write for them too. End the pilot in Settings first.`);

  const by = "supervised-test (main session)";
  const change = add ? { add: [add] } : remove ? { remove: [remove] } : null;
  const to = change ? [...new Set([...cfg.authorizedFixtureClientIds.filter((id) => id !== remove), ...(add ? [add] : [])])] : cfg.authorizedFixtureClientIds;
  log(`Would set: fixtures ${JSON.stringify(to)}${on ? ", switch ON" : off ? ", switch OFF" : ""}. Nothing else changes (not the pilot, not the mode).`);
  if (!apply) {
    log(`DRY RUN: nothing was written. Re-run with --apply.`);
    return { code: 0, mode, from: cfg.authorizedFixtureClientIds, to, enabled: state.enabled };
  }
  let result = { from: cfg.authorizedFixtureClientIds, to };
  if (change) {
    const { setHubWriteFixtures } = await import("@/lib/hubWriteFixtures");
    const r = await setHubWriteFixtures(switchKey, change, by);
    if (!r.ok) return refuse(r.message);
    log(r.message);
    result = { from: r.from, to: r.to };
  }
  let enabled = state.enabled;
  if ((on && !state.enabled) || (off && state.enabled)) {
    // null config = the stored config is left exactly as it is.
    enabled = (await setAutomation(switchKey, on, by, null)).enabled;
    await prisma.auditLog.create({ data: { actor: by, action: "automation_switch_change", target: `automation:${switchKey}`, detail: `enabled: ${state.enabled} -> ${enabled} (scripts/_ops/hub-write-fixture.ts)` } });
    log(`${switchKey} is now ${enabled ? "ON" : "OFF"} (recorded in AuditLog).`);
  }
  return { code: 0, mode, ...result, enabled };
}

if (require.main === module) {
  hubWriteFixture(process.argv.slice(2))
    .then((r) => { process.exitCode = r.code; })
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(async () => {
      const { prisma } = await import("@/lib/prisma");
      await prisma.$disconnect();
    });
}
