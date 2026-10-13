// ---------------------------------------------------------------------------
// ACTIVATION FORECAST (Oct 14 2026). READ-ONLY.
//
// "Before turning everything on, see if any client would get a flood or a
// wrong/stale message." For every ACTIVE real program client: what the
// AUTOMATIC client-facing emails would send in the next 72 hours IF
// scripts/_fix/oct14/turn-everything-on.ts had been applied: reminders,
// script_share_email (scripts-ready AND strategy-ready notices),
// portal_invites, portal_login_email, program_message_notice and
// auto_onboarding ON, the reminders policy's testClientsOnly lock lifted, and
// every active client on the named list with everything autoOnboardClient
// turns on (lib/everythingOnCore.planEveryoneInScope, the same plan).
//
// HOW, WITHOUT TOUCHING ANYTHING. The app's own dry runs are run against a
// Prisma client that (a) REFUSES every write (create, update, upsert, delete,
// executeRaw: any attempt throws, and the lane says it could not be
// forecast) and (b) answers a handful of reads with the simulated state: the
// ProgramAutomation rows of those switches, the "program-rollout" setting,
// and the Calendly/Aryeo sync stamps (as if the hourly sync keeps running, so
// a future hour is not called "stale"). Everything else is read live. The
// dry runs used are the ones the sends themselves run:
//   · programReminders.evaluateReminders({ dryRun }) — every planning and
//     review reminder (book a call, answers, sessions, catch-up / overdue,
//     mid-month), the exact-address lane and the approve-scripts lane;
//   · scriptShare.drainShareNotices({ dryRun }) — scripts/strategy ready;
//   · programMessages.sweepProgramMessageNotices({ dryRun }) — office replied;
//   · portalAccess.previewHeldAccessRelease() — welcomes held from payment;
//   · autoOnboarding.autoOnboardClient({ dryRun }) — what "Onboard all
//     active clients" would do: the welcome, and releasing an approved
//     strategy (which queues a strategy-ready email).
// Evaluated every --step-hours (default 1) over --hours (default 72). A
// message is listed at the first hour it would go; a dry run writes no row,
// so a follow-up that depends on an earlier send having happened is not
// modelled beyond its dated milestone. portal_login_email only answers a
// sign-in request the client makes, so it schedules nothing. The approved
// client texts (confirmations, delivery) are not program switches and run
// as they do today.
//
// FLAGS, per client: FLOOD? (more than 3 automatic emails in the window),
// STALE? (about a month before this one, a forfeited month, a deadline
// already past when it would be sent, or a catch-up).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/activation-forecast.ts [--hours 72] [--step-hours 1]
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};
const HOURS = arg("--hours", 72);
const STEP = arg("--step-hours", 1);
const BY = "forecast@realtourpilot.com";
const WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany", "$executeRaw", "$executeRawUnsafe", "$runCommandRaw"]);

type Row = Record<string, unknown>;
type Planned = { at: Date; clientId: string; name: string; lane: string; what: string; to: string | null; flags: string[] };

async function main() {
  const real = new PrismaClient();
  const now = new Date();
  // ---- the simulated state, computed from the live one -------------------------
  const { SWITCHES_TURNED_ON, planEveryoneInScope } = await import("@/lib/everythingOnCore");
  const core = await import("@/lib/programRolloutCore");
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const rolloutRow = await real.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } });
  const parsed = core.parseProgramRollout(rolloutRow?.value ?? null);
  if (parsed.problem) throw new Error(`The stored rollout can't be read: ${parsed.problem}`);
  const enrollments = await real.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true, clientId: true } });
  const clients = (await real.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } }))
    .filter((c) => !isSyntheticClientRow(c)).sort((a, b) => a.name.localeCompare(b.name));
  const bookingRows = await real.programAutomation.findMany({ where: { key: { in: ["session_booking", "address_sync"] } } });
  const bookings = bookingRows.length === 2 && bookingRows.every((r) => r.enabled && r.lastRunAt && !(r.lastError && (!r.lastErrorAt || r.lastErrorAt >= r.lastRunAt)));
  const plan = planEveryoneInScope(parsed.rollout, { clients, bookings, by: BY, now });
  if ("error" in plan) throw new Error(`The planned rollout was refused: ${plan.error}`);
  const settled = core.settleRolloutChange(parsed.rollout, plan.rollout, now);
  if ("error" in settled) throw new Error(settled.error);
  const simRollout = core.serializeProgramRollout(settled.rollout);

  const liveSwitches = new Map((await real.programAutomation.findMany()).map((r) => [r.key, r as unknown as Row]));
  const simSwitch = (key: string): Row => {
    const cur = liveSwitches.get(key);
    const base: Row = cur ? { ...cur } : { id: `sim-${key}`, key, enabled: false, enabledBy: null, enabledAt: null, disabledBy: null, disabledAt: null, configJson: null, lastRunAt: null, lastError: null, lastErrorAt: null, createdAt: now, updatedAt: now };
    const on = base.enabled === true;
    const out: Row = { ...base, enabled: true, enabledBy: on ? base.enabledBy : BY, enabledAt: on ? base.enabledAt : now };
    if (key === "reminders") {
      let cfg: Row = {};
      try { cfg = base.configJson ? (JSON.parse(String(base.configJson)) as Row) : {}; } catch { cfg = {}; }
      out.configJson = JSON.stringify({ ...cfg, testClientsOnly: false });
    }
    return out;
  };
  const SIM = new Map<string, Row>((SWITCHES_TURNED_ON as readonly string[]).map((k) => [k, simSwitch(k)]));

  // ---- the read-only, simulating client ------------------------------------------
  let simNow = now;
  const keyMatches = (where: Row | undefined, key: string): boolean => {
    if (!where) return true;
    const k = where.key as unknown;
    if (k === undefined) return true;
    if (typeof k === "string") return k === key;
    if (k && typeof k === "object") {
      const o = k as { in?: string[]; equals?: string; startsWith?: string };
      if (o.in) return o.in.includes(key);
      if (o.equals) return o.equals === key;
      if (o.startsWith) return key.startsWith(o.startsWith);
    }
    return false;
  };
  const enabledMatches = (where: Row | undefined, row: Row) => !where || where.enabled === undefined || where.enabled === row.enabled;
  const sim = real.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (WRITES.has(operation)) throw new Error(`activation-forecast is read-only: refused ${model ?? ""}.${operation}`);
        const a = (args ?? {}) as { where?: Row };
        if (model === "ProgramAutomation") {
          if (operation === "findUnique" || operation === "findUniqueOrThrow" || operation === "findFirst" || operation === "findFirstOrThrow") {
            const key = typeof a.where?.key === "string" ? (a.where.key as string) : null;
            if (key && SIM.has(key)) return SIM.get(key);
          }
          if (operation === "findMany") {
            const rows = ((await query(args)) as Row[]).filter((r) => !SIM.has(String(r.key)));
            for (const [k, r] of SIM) if (keyMatches(a.where, k) && enabledMatches(a.where, r)) rows.push(r);
            return rows;
          }
        }
        if (model === "AppSetting") {
          const value = { key: core.PROGRAM_ROLLOUT_SETTING_KEY, value: simRollout, updatedAt: now, updatedBy: BY };
          if ((operation === "findUnique" || operation === "findFirst") && a.where?.key === core.PROGRAM_ROLLOUT_SETTING_KEY) return value;
          if (operation === "findMany" && keyMatches(a.where, core.PROGRAM_ROLLOUT_SETTING_KEY) && a.where?.key !== undefined) {
            const rows = ((await query(args)) as Row[]).filter((r) => r.key !== core.PROGRAM_ROLLOUT_SETTING_KEY);
            rows.push(value);
            return rows;
          }
        }
        // As if the hourly sync keeps running: a feed fresh now is fresh at every forecast hour.
        if (model === "ProgramCalendlyEventMapping" && operation === "findMany") {
          return ((await query(args)) as Row[]).map((r) => (r.lastSyncedAt instanceof Date && now.getTime() - r.lastSyncedAt.getTime() < 3 * 3_600_000 ? { ...r, lastSyncedAt: simNow } : r));
        }
        if (model === "Connection" && (operation === "findUnique" || operation === "findFirst")) {
          const r = (await query(args)) as Row | null;
          return r && r.lastSyncedAt instanceof Date && now.getTime() - r.lastSyncedAt.getTime() < 3 * 3_600_000 ? { ...r, lastSyncedAt: simNow } : r;
        }
        return query(args);
      },
    },
  });
  (globalThis as unknown as { prisma: unknown }).prisma = sim;

  // ---- the dry runs, hour by hour -------------------------------------------------
  const { evaluateReminders } = await import("@/lib/programReminders");
  const { drainShareNotices } = await import("@/lib/scriptShare");
  const { sweepProgramMessageNotices } = await import("@/lib/programMessages");
  const { previewHeldAccessRelease } = await import("@/lib/portalAccess");
  const { autoOnboardClient } = await import("@/lib/autoOnboarding");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const real_ = new Set(clients.map((c) => c.id));
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const clientOfEnrollment = new Map(enrollments.map((e) => [e.id, e.clientId]));
  const planned: Planned[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  const add = (p: Planned, key: string) => { if (seen.has(key) || !real_.has(p.clientId)) return; seen.add(key); planned.push(p); };
  const et = (d: Date) => `${d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;

  for (let h = 0; h <= HOURS; h += STEP) {
    const t = new Date(now.getTime() + h * 3_600_000);
    simNow = t;
    const thisMonth = etMonthKey(t);
    try {
      const r = await evaluateReminders({ dryRun: true, now: t, requestedBy: "activation-forecast" });
      for (const c of r.candidates) {
        if (c.decision !== "send" || !c.action) continue;
        const flags: string[] = [];
        if (c.monthKey < thisMonth) flags.push(`STALE? about ${c.monthKey}`);
        if (/forfeit/i.test(c.reason)) flags.push("STALE? forfeited month");
        if (c.quotedDeadlineAt && c.quotedDeadlineAt.getTime() < t.getTime()) flags.push("STALE? quotes a past deadline");
        if (/catch.?up/i.test(`${c.reason} ${c.extraParagraph ?? ""}`)) flags.push("catch-up");
        add({ at: t, clientId: c.clientId, name: c.clientName, lane: c.lane === "REVIEW" ? "review reminder" : "reminder", what: `${c.action} (${c.monthKey}, ${c.milestone}${c.attempt > 1 ? `, attempt ${c.attempt}` : ""})${c.extraParagraph ? " + extra paragraph" : ""}`, to: c.to, flags }, c.dedupeKey ?? `${c.clientId}:${c.action}:${c.monthKey}:${c.milestone}:${c.sessionOrdinal ?? ""}`);
      }
      for (const a of r.addressLane) {
        if (a.decision !== "send") continue;
        const cid = clientOfEnrollment.get(a.enrollmentId) ?? "";
        add({ at: t, clientId: cid, name: a.clientName, lane: "address reminder", what: `ADD_ADDRESS for the session ${et(a.shootAt)}${a.overdue ? " (overdue)" : ""}`, to: a.to, flags: a.shootAt.getTime() < t.getTime() ? ["STALE? session already past"] : [] }, a.dedupeKey);
      }
      for (const a of r.scriptApprovalLane) {
        if (a.decision !== "send") continue;
        const cid = clientOfEnrollment.get(a.enrollmentId) ?? "";
        add({ at: t, clientId: cid, name: a.clientName, lane: "approve-scripts reminder", what: `APPROVE_SCRIPTS before ${et(a.shootAt)}: ${a.titles.join("; ").slice(0, 120)}`, to: a.to, flags: a.deadlineAt.getTime() < t.getTime() ? ["STALE? deadline past"] : [] }, a.dedupeKey);
      }
    } catch (e) { problems.push(`${et(t)} reminders: ${e instanceof Error ? e.message.split("\n")[0] : e}`); }
    try {
      const s = await drainShareNotices({ dryRun: true, now: t, max: 500, requestedBy: "activation-forecast" });
      for (const n of s.preview) if (n.decision === "send") add({ at: t, clientId: n.clientId, name: n.clientName, lane: n.action === "STRATEGY_READY" ? "strategy-ready email" : "scripts-ready email", what: n.reason, to: n.to, flags: [] }, `share:${n.reminderId}`);
    } catch (e) { problems.push(`${et(t)} share notices: ${e instanceof Error ? e.message.split("\n")[0] : e}`); }
    try {
      const m = await sweepProgramMessageNotices({ dryRun: true, now: t });
      for (const n of m.preview) if (n.decision === "send") add({ at: t, clientId: n.clientId, name: n.clientName, lane: "office-replied email", what: n.reason, to: n.to, flags: [] }, `msg:${n.enrollmentId}:${n.to}`);
    } catch (e) { problems.push(`${et(t)} office replies: ${e instanceof Error ? e.message.split("\n")[0] : e}`); }
  }

  // ---- what "Onboard all active clients" would send, and held welcomes -----------------
  const onboarding = new Map<string, string[]>();
  for (const c of clients) {
    try {
      const r = await autoOnboardClient(c.id, BY, { sendWelcome: true, dryRun: true });
      onboarding.set(c.id, r.steps.filter((s) => s.status !== "already").map((s) => `${s.key}: ${s.detail}`));
      const w = r.steps.find((s) => s.key === "welcome");
      if (w?.status === "would") add({ at: now, clientId: c.id, name: c.name, lane: "welcome (on Onboard all)", what: w.detail, to: null, flags: [] }, `welcome:${c.id}`);
      const st = r.steps.find((s) => s.key === "strategy");
      if (st?.status === "would") add({ at: now, clientId: c.id, name: c.name, lane: "strategy-ready email (on Onboard all)", what: st.detail, to: null, flags: [] }, `strategy:${c.id}`);
    } catch (e) { problems.push(`${c.name} onboarding: ${e instanceof Error ? e.message.split("\n")[0] : e}`); }
  }
  let held: Awaited<ReturnType<typeof previewHeldAccessRelease>> | null = null;
  try { held = await previewHeldAccessRelease(); } catch (e) { problems.push(`held access: ${e instanceof Error ? e.message.split("\n")[0] : e}`); }

  // ---- the report --------------------------------------------------------------------
  console.log(`ACTIVATION FORECAST · ${et(now)} → +${HOURS} h (every ${STEP} h) · READ-ONLY, nothing was written or sent`);
  console.log(`Simulated: ${SWITCHES_TURNED_ON.join(", ")} ON; reminders lock lifted; ${plan.changes.length} client(s) given everything (bookings ${bookings ? "included" : "not proven, left as is"}).`);
  for (const c of clients) {
    const mine = planned.filter((p) => p.clientId === c.id).sort((a, b) => a.at.getTime() - b.at.getTime());
    const auto = mine.filter((p) => !p.lane.includes("on Onboard all"));
    const flags = [...new Set(mine.flatMap((p) => p.flags))];
    if (auto.length > 3) flags.unshift(`FLOOD? ${auto.length} automatic emails in ${HOURS} h`);
    console.log(`\n== ${c.name}${flags.length ? `   [${flags.join(" · ")}]` : ""}`);
    if (!mine.length) console.log("   nothing automatic in the window");
    for (const p of mine) console.log(`   ${p.lane.includes("on Onboard all") ? "on press      " : et(p.at).padEnd(26)} ${p.lane}: ${p.what}${p.to ? ` → ${p.to}` : ""}${p.flags.length ? `  [${p.flags.join(", ")}]` : ""}`);
    const ob = onboarding.get(c.id) ?? [];
    if (ob.length) console.log(`   Onboard all would: ${ob.join(" | ")}`);
  }
  if (held) {
    console.log(`\nHELD WELCOMES from payment: ${held.grant.length + held.stay.length}`);
    for (const o of held.grant) console.log(`   ${o.clientName} → ${o.email}: sent on "Release held access", OR cleared when Onboard all opens their account (one welcome either way)`);
    for (const o of held.stay) console.log(`   ${o.clientName} → ${o.email}: stays held (${o.why})`);
  }
  const testRows = planned.filter((p) => !real_.has(p.clientId));
  if (testRows.length) console.log(`\n(${testRows.length} TEST-client rows left out.)`);
  if (problems.length) {
    console.log(`\nCOULD NOT FORECAST (${problems.length}):`);
    for (const p of [...new Set(problems)].slice(0, 30)) console.log(`   ${p}`);
  }
  await real.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
