// Oct 14 2026 (Jordan, Oct 13): "Can you just automate this and turn
// everything on when you are done? I want a sign-up email to go out and for
// everything to be activated."
//
// WHAT IT CHANGES (dry run by default; --apply writes):
//   1. Switches ON: reminders, script_share_email, portal_invites,
//      portal_login_email, program_message_notice, auto_onboarding
//      (lib/everythingOnCore.SWITCHES_TURNED_ON). Each change gets an
//      AuditLog row (turn_everything_on_switch).
//   2. The reminders policy's testClientsOnly lock is LIFTED (set false, the
//      rest of the stored policy kept, through setAutomationConfigField, which
//      audits). That one lock covers reminders AND script_share_email: with it
//      on, turning those two on would still email TEST clients only. Pass
//      --keep-reminders-lock to leave it.
//   3. Who the program may reach: the named-client list (mode PILOT), with
//      EVERY ACTIVE real program client on it, each keeping what they have and
//      gaining everything autoOnboardClient turns on (accounts, messages,
//      program emails, review deadlines, automatic approval, carry-over,
//      caption assistant; bookings only while automatic Aryeo booking is
//      proven). Never "Share scripts without my approval". ONE write through
//      updateProgramRollout (advisory lock, AuditLog turn_everything_on).
//      Why PILOT and not "every client": lib/everythingOnCore.ts header.
//   4. Left as they are: script_auto_share's and review_auto_approve's own
//      TEST-only locks. review_auto_approve is allowed per client by the list
//      (3), but while its own lock is on (the default when its config says
//      nothing) it still approves on expiry for TEST clients only; lift it in
//      Settings → Automatic approval when you want it for real clients.
//      publishing and legacy_call_sweeps stay off.
// It prints every switch, lock and client's list before and after. It sends
// nothing itself: emails follow from the switches on their own schedules
// (scripts/_ops/activation-forecast.ts shows the next 72 hours first), and
// welcomes go out when you press "Onboard all active clients".
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/turn-everything-on.ts [--apply] [--keep-reminders-lock]
import { prisma } from "@/lib/prisma";

const BY = "info@realtourpilot.com";

async function main() {
  const apply = process.argv.includes("--apply");
  const keepLock = process.argv.includes("--keep-reminders-lock");
  console.log(apply ? "APPLY" : "DRY RUN (pass --apply to write)");
  const { getAutomation, setAutomation, setAutomationConfigField } = await import("@/lib/programAutomation");
  const { featureTestOnlyFor, loadProgramRollout, updateProgramRollout } = await import("@/lib/programRollout");
  const { clientAllowedOps, parseProgramRollout } = await import("@/lib/programRolloutCore");
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const { SWITCHES_TURNED_ON, SWITCHES_LEFT_OFF, LOCKS_LEFT_AS_THEY_ARE, planEveryoneInScope } = await import("@/lib/everythingOnCore");
  const { autoBookingProblems } = await import("@/lib/clientOnboarding");
  const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
  const { REMINDER_DEFAULTS, validateReminderPolicy } = await import("@/lib/programReminders");

  // ---- before ------------------------------------------------------------------
  const switchState = async () => Object.fromEntries(await Promise.all([...SWITCHES_TURNED_ON, ...SWITCHES_LEFT_OFF, "script_auto_share", "review_auto_approve", "revision_policy", "session_booking", "address_sync"].map(async (k) => [k, (await getAutomation(k as never)).enabled] as const)));
  const lockState = async () => ({
    "reminders + script_share_email (reminders policy testClientsOnly)": await featureTestOnlyFor("reminders"),
    "script_auto_share testClientsOnly": await featureTestOnlyFor("script_auto_share"),
    "review_auto_approve testClientsOnly": await featureTestOnlyFor("review_auto_approve"),
  });
  const before = { switches: await switchState(), locks: await lockState() };
  const loaded = await loadProgramRollout();
  if (loaded.problem) throw new Error(`The stored rollout can't be read (${loaded.problem}). Fix it first; nothing was changed.`);

  const enrollments = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { clientId: true } });
  const clients = (await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } }))
    .filter((c) => !isSyntheticClientRow(c)).sort((a, b) => a.name.localeCompare(b.name));
  const bookingRows = await prisma.programAutomation.findMany({ where: { key: { in: ["session_booking", "address_sync"] } }, select: { key: true, enabled: true, lastRunAt: true, lastError: true, lastErrorAt: true } });
  const bookingWhyNot = autoBookingProblems(bookingRows, AUTOMATION_EFFECTS);
  const now = new Date();
  const plan = planEveryoneInScope(loaded.rollout, { clients, bookings: bookingWhyNot.length === 0, by: BY, now });
  if ("error" in plan) throw new Error(`The rollout change was refused: ${plan.error}. Nothing was changed.`);

  const otherIds = [...new Set([...(loaded.rollout.pilot?.clientIds ?? [])])].filter((id) => !clients.some((c) => c.id === id));
  const otherNames = new Map((await prisma.client.findMany({ where: { id: { in: otherIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const printLists = (label: string, r: typeof loaded.rollout) => {
    console.log(`\n${label}: mode ${r.mode}${r.pilot ? `, ${r.pilot.clientIds.length} named, approved by ${r.pilot.approvedBy ?? "nobody"}${r.pilot.expiresAt ? `, ends ${r.pilot.expiresAt}` : ""}` : ""}`);
    for (const c of clients) console.log(`  ${c.name.padEnd(26)} ${clientAllowedOps(r, c).join(", ") || "(nothing)"}`);
    for (const id of (r.pilot?.clientIds ?? []).filter((x) => !clients.some((c) => c.id === x))) {
      const who = { id, name: otherNames.get(id) ?? null };
      console.log(`  ${(who.name ?? id).padEnd(26)} ${clientAllowedOps(r, who).join(", ") || "(nothing)"}  (not ACTIVE: left as it is)`);
    }
  };

  console.log("\nSWITCHES before:");
  for (const [k, on] of Object.entries(before.switches)) console.log(`  ${k.padEnd(24)} ${on ? "ON" : "off"}${(SWITCHES_TURNED_ON as readonly string[]).includes(k) ? (on ? "" : "  → ON") : (SWITCHES_LEFT_OFF as readonly string[]).includes(k) ? "  (stays off)" : "  (unchanged)"}`);
  console.log("\nLOCKS before (true = TEST clients only):");
  for (const [k, v] of Object.entries(before.locks)) console.log(`  ${k.padEnd(68)} ${v}${k.startsWith("reminders") && v && !keepLock ? "  → false (lifted)" : "  (unchanged)"}`);
  console.log(`\nAutomatic Aryeo booking: ${bookingWhyNot.length ? `NOT added (Kyle books by hand): ${bookingWhyNot.join("; ")}` : "proven, so bookings is added for everyone"}`);
  printLists("ROLLOUT before", loaded.rollout);
  printLists("ROLLOUT after (planned)", plan.rollout);
  for (const ch of plan.changes) console.log(`  + ${ch.name}: ${ch.added.join(", ")}`);
  if (plan.cleared.length) console.log(`  (set to nothing first, then re-added if active: ${plan.cleared.join(", ")})`);
  if (!plan.changes.length) console.log("  (every active client already has everything)");

  // The reminders policy must be one the evaluator can run, or turning it on is refused (as Settings refuses it).
  const remCfgRow = await prisma.programAutomation.findUnique({ where: { key: "reminders" }, select: { configJson: true } });
  let remCfg: Record<string, unknown> = {};
  try { remCfg = remCfgRow?.configJson ? (JSON.parse(remCfgRow.configJson) as Record<string, unknown>) : {}; } catch { throw new Error("The stored reminders policy is not valid JSON. Fix it in Settings → Program reminders first; nothing was changed."); }
  const v = validateReminderPolicy({ ...REMINDER_DEFAULTS, ...remCfg, ...(keepLock ? {} : { testClientsOnly: false }) });
  if (!v.ok) throw new Error(`The reminders policy would not run (${v.errors.join("; ")}). Fix it in Settings → Program reminders first; nothing was changed.`);

  const held = await prisma.appSetting.findMany({ where: { key: { startsWith: "portal-access-owed:" } }, select: { value: true } });
  if (held.length) console.log(`\nHELD WELCOMES from payment (${held.length}): with portal_invites on they are sent by "Release held access" OR cleared by Client onboarding's account step (Onboard all active clients), never both.`);

  if (!apply) {
    console.log("\nNothing was written. Run with --apply to make these changes.");
    return;
  }

  // ---- apply ---------------------------------------------------------------------
  const r = await updateProgramRollout((cur, at) => {
    const p = planEveryoneInScope(cur, { clients, bookings: bookingWhyNot.length === 0, by: BY, now: at });
    return "error" in p ? p : p.rollout;
  }, BY, "turn_everything_on");
  if (!r.ok) throw new Error(`The rollout was not changed: ${r.message}. No switch was touched.`);
  if (!keepLock && before.locks["reminders + script_share_email (reminders policy testClientsOnly)"]) {
    await setAutomationConfigField("reminders", "testClientsOnly", false, BY, "turn_everything_on_reminders_lock");
  }
  for (const k of SWITCHES_TURNED_ON) {
    if (before.switches[k]) continue;
    await setAutomation(k, true, BY);
    await prisma.auditLog.create({ data: { actor: BY, action: "turn_everything_on_switch", target: `automation:${k}`, detail: `${k}: off -> ON (Jordan, Oct 13 2026: "turn everything on")` } });
  }

  // ---- after ---------------------------------------------------------------------
  const after = { switches: await switchState(), locks: await lockState() };
  console.log("\nSWITCHES after:");
  for (const [k, on] of Object.entries(after.switches)) console.log(`  ${k.padEnd(24)} ${on ? "ON" : "off"}${before.switches[k] !== on ? `  (was ${before.switches[k] ? "ON" : "off"})` : ""}`);
  console.log("\nLOCKS after (true = TEST clients only):");
  for (const [k, val] of Object.entries(after.locks)) console.log(`  ${k.padEnd(68)} ${val}${before.locks[k as keyof typeof before.locks] !== val ? `  (was ${before.locks[k as keyof typeof before.locks]})` : ""}`);
  const stored = await prisma.appSetting.findUnique({ where: { key: "program-rollout" }, select: { value: true } });
  printLists("ROLLOUT after", parseProgramRollout(stored?.value ?? null).rollout);
  for (const k of LOCKS_LEFT_AS_THEY_ARE) console.log(`(${k}'s own lock was not touched)`);
  console.log("\nDone. Next: Settings → Client onboarding → Onboard all active clients sends each welcome once.");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
