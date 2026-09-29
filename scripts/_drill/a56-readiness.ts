// ---------------------------------------------------------------------------
// DRILL: A56 — READINESS. Configured, connected, enabled, effective and
// healthy as five separate facts per automation, and the launch gate
// (rolloutClosed) in one boolean (unified handoff §11/§12, batch 6, Sep 28
// 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/a56-readiness.ts
//
// What it proves, the OLD behaviour first (BASE is pinned to 3de6023, the tree
// batch 6 starts from — never HEAD):
//   0. OLD: no readiness reader existed; the switch copy carried no
//      dependencies, recipients or cadence; the settings row badge and the
//      CP-15 probe both said "on"/ENABLED from the row alone.
//   1. With no rows: every program switch is off, unconfigured, not effective
//      and has NO health verdict (null, never "failed"); rolloutClosed is true.
//      The approved client texts are reported and never counted in the gate.
//   2. script_drafting ON with ai_runs OFF: enabled, not effective, "needs
//      ai_runs". A missing provider is its own blocker.
//   3. review_auto_approve ON without revision_policy: blocked.
//   4. session_booking ON: no fixture → "no authorized client"; a real client
//      on the fixture list → "not a TEST client"; a real TEST fixture with Aryeo
//      connected → effective, the scope names it, rolloutClosed stays true; an
//      approved pilot of a real client opens the gate and is named.
//   5. reminders ON with an invalid stored policy: configured=false; a valid
//      one is TEST-only until testClientsOnly is cleared.
//   6. Health: late by more than twice the cadence → false; a recorded error
//      → false; a CLOSED switch with an old error → null (the Sep 23
//      regression); a late hourly run → false; a failed text step → false.
//   7. portal_invites ON for real clients: closed while Gmail is missing
//      ("armed"), open once connected and named; the live Gmail check turns a
//      mailbox that cannot send into a blocker, and only the live check calls
//      Google.
//   8. One report, one set of rows: every AUTOMATION_KEY exactly once; the
//      CP-15 probe's facts are this report's rows (same keys, same order, the
//      report's own readinessLine as evidence); recipients on every row.
//   9. Nothing is written: ProgramAutomation, AppSetting, Connection and
//      AuditLog are byte-identical across every report.
//  10. fixtureScopeProblems, pure: a real client renamed TEST, a client on both
//      lists, an expired or unapproved pilot.
//  11. The Sep 28 review: script_auto_share names no dependency its sweep does
//      not enforce, so on for real clients it OPENS the gate with drafting and
//      AI off (18); a drifted fixture entry beside an active pilot is a
//      configuration note, not a blocker, and the pilot is an opener (19); a
//      provider row in ERROR that keeps its key is connected, the error a
//      health fact (20); nothing on-action is "healthy" without a run (23); a
//      row that is its whole run fails with it (13).
//  §2 and §4 each had one check MOVED to that law (never loosened).
//  R03 (Sep 28 2026, builder B): WHO a client-reaching switch reaches is now
//      the rollout scope (Settings → Who the program may reach), read through
//      programRollout.programAudience — never "every client" unless the
//      rollout says everyone — and the three hub-write switches read the ONE
//      program pilot. Every check that asserted "the switch alone opens the
//      gate for every real client" (§3, §5, §7, §11/18) or read a per-switch
//      pilot (§4, §11/19-20) is MOVED to that law: with the default rollout
//      (TEST only) the gate stays closed, and naming Dana in the pilot opens it
//      with an opener that names her. Nothing was loosened.
//
// ISOLATION: PGlite on 127.0.0.1:5870 (DRILL_PORT overrides) through the shared
// harness; production is never opened. Every non-loopback call is fenced; the
// only answered hosts are Google's token and tokeninfo endpoints, faked, and
// only the live check reaches them. Nothing is sent.
// THE CLOCK IS PINNED to Mon Sep 28 2026 11:00 ET.
// ---------------------------------------------------------------------------
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5870);
const BASE = "3de6023"; // pinned: the tree batch 6 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 8, 28, 15, 0, 0); // Mon Sep 28 2026, 11:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const minsAgo = (m: number) => new RealDate(PINNED - m * 60_000);

installNextStubs();

// Google, faked: the token mint and the tokeninfo scope read — the two calls
// gmailSendHealth makes. Everything else is refused and counted.
let tokenScope = "https://www.googleapis.com/auth/gmail.readonly";
const fence = fenceFetch((url) => {
  // tokeninfo first: "…/tokeninfo" also starts with "…/token".
  if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) return new Response(JSON.stringify({ scope: tokenScope }), { status: 200 });
  if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "drill-access-token", expires_in: 3600 }), { status: 200 });
  return null;
});

const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
const existsAtBase = (f: string) => {
  try { execFileSync("git", ["cat-file", "-e", `${BASE}:${f}`], { cwd: REPO, stdio: "pipe" }); return true; } catch { return false; }
};

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { GOOGLE_CLIENT_ID: "drill-google-client", GOOGLE_CLIENT_SECRET: "drill-google-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const R = await import("@/lib/readiness");
  const { AUTOMATION_KEYS, isAutomationKey } = await import("@/lib/programAutomation");
  const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { NEVER_SYNTHETIC_CLIENT_IDS, JORDAN_TEST_EMAIL } = await import("@/lib/testClients");

  const NOW = new Date();
  const report = (live = false) => R.readinessReport({ now: NOW, live });
  const rowOf = (rep: Awaited<ReturnType<typeof report>>, key: string) => {
    const r = rep.rows.find((x) => x.key === key);
    if (!r) throw new Error(`no readiness row ${key}`);
    return r;
  };
  const setSwitch = (key: string, data: { enabled?: boolean; configJson?: string | null; lastRunAt?: Date | null; lastError?: string | null; lastErrorAt?: Date | null }) =>
    db.programAutomation.upsert({ where: { key }, create: { key, enabled: false, ...data }, update: data });
  const connect = (provider: string, secret = `drill-${provider}-credential`) => saveSecret(provider, secret);
  const disconnect = (provider: string) => db.connection.deleteMany({ where: { provider } });
  // R03: the rollout scope (one AppSetting row). TEST_ONLY is the default.
  const core = await import("@/lib/programRolloutCore");
  const setRollout = (r: import("@/lib/programRolloutCore").ProgramRollout) =>
    db.appSetting.upsert({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY }, create: { key: core.PROGRAM_ROLLOUT_SETTING_KEY, value: core.serializeProgramRollout(r), updatedBy: "drill" }, update: { value: core.serializeProgramRollout(r) } });
  const pilotOf = (ids: string[], o: { ops?: import("@/lib/programRolloutCore").ProgramReachOp[]; expiresAt?: string | null } = {}): import("@/lib/programRolloutCore").ProgramRollout => ({
    mode: "PILOT", modeSince: minsAgo(120).toISOString(),
    pilot: { clientIds: ids, operations: o.ops ?? core.opsForGroups(core.PROGRAM_PILOT_GROUPS.map((g) => g.key)), approvedBy: "jordan@drill", approvedAt: minsAgo(60).toISOString(), expiresAt: o.expiresAt ?? null, note: null, joinedAt: {} },
  });
  const testOnly = () => setRollout({ ...core.CLOSED_ROLLOUT });
  /** Is this switch an opener / armed — its opener now names who ("Title — pilot: Dana Realclient"). */
  const opens = (rep: Awaited<ReturnType<typeof report>>, key: keyof typeof AUTOMATION_EFFECTS) => rep.rolloutClosed.openers.some((o) => o.startsWith(`${AUTOMATION_EFFECTS[key].title} — `));
  const armedFor = (rep: Awaited<ReturnType<typeof report>>, key: keyof typeof AUTOMATION_EFFECTS) => rep.rolloutClosed.armed.some((o) => o.startsWith(`${AUTOMATION_EFFECTS[key].title} — `));

  // Clients for the scope checks.
  const fixture = await db.client.create({ data: { name: "Drill Fixture TEST", email: JORDAN_TEST_EMAIL } });
  const real = await db.client.create({ data: { name: "Dana Realclient", email: "dana@example.com" } });

  // =========================================================================
  c.head("0 · OLD (3de6023): 'on' was read from the row alone");
  // =========================================================================
  {
    const oldCopy = show("src/lib/programAutomationCopy.ts");
    const oldPanel = show("src/components/settings/ProgramAutomationPanel.tsx");
    const oldProbe = show("scripts/_recon/cp15-config-probe.ts");
    c.ok("OLD: there was no readiness reader (src/lib/readiness.ts did not exist)", !existsAtBase("src/lib/readiness.ts"));
    c.ok("OLD: the switch copy named no dependencies, recipients or cadence", !/requires:|recipients:|cadence:/.test(oldCopy));
    c.ok("OLD: each switch row's badge was on / never configured / off, from the row alone", /r\.enabled \? "on" : r\.missing \? "never configured" : "off"/.test(oldPanel));
    c.ok("OLD: only the three script switches were checked for a dependency (the ScriptReleaseSummary), nothing else", /on, but blocked/.test(oldPanel) && !/session_booking[^\n]*blocked|fixture[^\n]*blocked/i.test(oldPanel));
    c.ok("OLD: the CP-15 probe labelled a switch ENABLED from its row, never asking what it needs", /s\?\.enabled \? \(\["ENABLED"\]/.test(oldProbe) && !/readinessReport/.test(oldProbe));
  }

  // =========================================================================
  c.head("1 · no rows: everything off, nothing judged a failure, launch closed");
  // =========================================================================
  {
    const rep = await report();
    const program = rep.rows.filter((r) => r.kind === "program");
    c.ok(`one program row per switch (${AUTOMATION_KEYS.length})`, program.length === AUTOMATION_KEYS.length && program.every((r, i) => r.key === AUTOMATION_KEYS[i]));
    c.ok("every program switch: enabled=false", program.every((r) => r.enabled.ok === false));
    c.ok("every program switch: configured=false (no row = never configured)", program.every((r) => r.configured.ok === false && /never configured/.test(r.configured.detail)));
    c.ok("every program switch: effective=false", program.every((r) => r.effective.ok === false));
    c.ok("every program switch: healthy=null — a closed switch has no verdict, never a failure", program.every((r) => r.healthy.ok === null));
    c.ok("rolloutClosed: true, no openers, nothing armed", rep.rolloutClosed.ok && rep.rolloutClosed.openers.length === 0 && rep.rolloutClosed.armed.length === 0);
    const texts = rep.rows.filter((r) => r.key.startsWith("auto_texts."));
    c.ok("the four approved client texts are reported (on by default, from the built-in rules)", texts.length === 4 && texts.every((r) => r.enabled.ok && r.kind === "business"));
    c.ok("…and they need OpenPhone, which is not connected: not effective, and the blocker says so", texts.every((r) => !r.effective.ok && r.effective.blockers.some((b) => /OpenPhone/.test(b))));
    await connect("openphone");
    const rep2 = await report();
    c.ok("with OpenPhone connected the texts are effective — and the launch gate is STILL closed (approved comms are not counted)", rep2.rows.filter((r) => r.key.startsWith("auto_texts.")).every((r) => r.effective.ok) && rep2.rolloutClosed.ok);
    c.ok("no report without live:true called anything outside (0 faked, 0 blocked)", fence.faked.length === 0 && fence.blocked.length === 0, `faked ${fence.faked.length} blocked ${fence.blocked.join(",")}`);
    c.ok("the Gmail send line says it was not checked", !rep2.gmailSend.checked && /not checked/i.test(rep2.gmailSend.detail));
  }

  // =========================================================================
  c.head("2 · script_drafting ON with ai_runs OFF: on, but not effective");
  // =========================================================================
  {
    await connect("ai");
    await setSwitch("script_drafting", { enabled: true });
    let r = rowOf(await report(), "script_drafting");
    c.ok("enabled=true", r.enabled.ok === true);
    c.ok("effective=false with the blocker 'needs ai_runs'", r.effective.ok === false && r.effective.blockers.some((b) => /needs ai_runs/.test(b)), r.effective.blockers.join(" | "));
    c.ok("configured=true (the row exists and needs no config) and connected=true (AI is connected)", r.configured.ok && r.connected.ok === true);
    c.ok("healthy=null while blocked — not a failure", r.healthy.ok === null && /blocked/.test(r.healthy.detail));
    await setSwitch("ai_runs", { enabled: true });
    r = rowOf(await report(), "script_drafting");
    c.ok("ai_runs ON → effective, no blockers", r.effective.ok && r.effective.blockers.length === 0);
    await disconnect("ai");
    r = rowOf(await report(), "script_drafting");
    c.ok("AI disconnected → connected=false and 'needs AI (Claude) connected'", r.connected.ok === false && r.effective.blockers.some((b) => /AI \(Claude\) connected/.test(b)));
    await connect("ai");
    await setSwitch("script_auto_share", { enabled: true });
    r = rowOf(await report(), "script_auto_share");
    c.ok("script_auto_share ON behind drafting + AI: effective, TEST clients only, not a real-client opener", r.effective.ok && r.realClients === false && /^TEST clients \(.*\) only/.test(r.scope ?? ""), r.scope ?? "");
    await setSwitch("script_drafting", { enabled: false });
    r = rowOf(await report(), "script_auto_share");
    // MOVED TO THE REVIEW'S LAW (Sep 28): this asserted "needs script_drafting".
    // The hourly sweep checks only its own switch and releases drafts that
    // already exist, so drafting OFF does not stop it — a blocker here made
    // the launch gate read closed while it shared scripts (§11 below).
    c.ok("drafting OFF → auto-share is STILL effective (it shares drafts that exist; the sweep checks only its own switch)", r.enabled.ok && r.effective.ok && !r.effective.blockers.some((b) => /script_drafting|ai_runs/.test(b)), r.effective.blockers.join(" | "));
    await setSwitch("script_auto_share", { enabled: false });
    await setSwitch("ai_runs", { enabled: false });
  }

  // =========================================================================
  c.head("3 · review_auto_approve ON without revision_policy: blocked");
  // =========================================================================
  {
    await setSwitch("review_auto_approve", { enabled: true });
    let rep = await report();
    let r = rowOf(rep, "review_auto_approve");
    c.ok("enabled, not effective, 'needs revision_policy'", r.enabled.ok && !r.effective.ok && r.effective.blockers.some((b) => /needs revision_policy/.test(b)));
    c.ok("TEST clients only by default (testClientsOnly)", r.realClients === false);
    await setSwitch("revision_policy", { enabled: true });
    rep = await report();
    r = rowOf(rep, "review_auto_approve");
    c.ok("revision_policy ON → auto-approve effective", r.effective.ok);
    // MOVED TO R03's LAW (Sep 28): this asserted "revision_policy reaches
    // every client once on → OPEN". The switch alone reaches the rollout scope,
    // which is TEST clients only by default; naming Dana opens it for her.
    c.ok("revision_policy ON with the rollout at its default (TEST only) → reaches TEST clients only; the gate stays CLOSED", rep.rolloutClosed.ok && !rowOf(rep, "revision_policy").realClients && /^TEST clients \(.*\) only — the rollout is set to TEST only/.test(rowOf(rep, "revision_policy").scope ?? ""), rowOf(rep, "revision_policy").scope ?? "");
    await setRollout(pilotOf([real.id]));
    rep = await report();
    c.ok("…Dana named in the pilot → the gate is OPEN, and the opener names her: \"Review deadlines and revision rounds — pilot: Dana Realclient\"", !rep.rolloutClosed.ok && rep.rolloutClosed.openers.includes(`${AUTOMATION_EFFECTS.revision_policy.title} — pilot: Dana Realclient`), rep.rolloutClosed.openers.join(" | "));
    c.ok("…and auto-approve (its own TEST-only lock) is not among the openers", !opens(rep, "review_auto_approve"));
    await testOnly();
    await setSwitch("review_auto_approve", { enabled: false });
    await setSwitch("revision_policy", { enabled: false });
    c.ok("both off → closed again", (await report()).rolloutClosed.ok);
  }

  // =========================================================================
  c.head("4 · session_booking: scope decides, not the switch");
  // =========================================================================
  {
    await setSwitch("session_booking", { enabled: true, configJson: JSON.stringify({ authorizedFixtureClientIds: [] }) });
    let r = rowOf(await report(), "session_booking");
    c.ok("empty fixture list → configured=false, blocker 'no authorized client'", !r.configured.ok && r.effective.blockers.some((b) => /no authorized client/.test(b)));
    c.ok("…and Aryeo is not connected → its own blocker", r.effective.blockers.some((b) => /needs Aryeo connected/.test(b)));
    await connect("aryeo");
    await setSwitch("session_booking", { configJson: JSON.stringify({ authorizedFixtureClientIds: [real.id] }) });
    r = rowOf(await report(), "session_booking");
    // MOVED TO THE REVIEW'S LAW (Sep 28): the entry's problem is a
    // configuration fact about that entry; what blocks the switch is that
    // nobody usable is left in scope (§11 below: a drifted entry beside an
    // active pilot must not read as "blocked").
    c.ok("a real client on the fixture list → not effective ('no usable TEST fixture'), and the entry is named 'not a TEST client'", !r.effective.ok && r.effective.blockers.some((b) => /no usable TEST fixture/.test(b)) && /not a TEST client/.test(r.configured.detail) && !r.configured.ok, `${r.effective.blockers.join(" | ")} || ${r.configured.detail}`);
    await setSwitch("session_booking", { configJson: JSON.stringify({ authorizedFixtureClientIds: [fixture.id] }) });
    let rep = await report();
    r = rowOf(rep, "session_booking");
    c.ok("a real TEST fixture + Aryeo connected → effective", r.configured.ok && r.connected.ok === true && r.effective.ok, r.effective.blockers.join(" | "));
    c.ok("the scope names the fixture, and says there is no pilot", /Drill Fixture TEST/.test(r.scope ?? "") && /no pilot/.test(r.scope ?? ""), r.scope ?? "");
    c.ok("rolloutClosed stays true (a fixture is not a real client)", rep.rolloutClosed.ok && !r.realClients);
    // MOVED TO R03's LAW (Sep 28, Jordan's one-pilot rule): a real client is
    // written for through the PROGRAM pilot with bookings ticked; a pilot left
    // in the switch's own config is no longer read by anything.
    const approvedAt = minsAgo(60).toISOString();
    await setSwitch("session_booking", { configJson: JSON.stringify({ authorizedFixtureClientIds: [fixture.id], pilot: { clientIds: [real.id], operations: ["orders.create"], approvedBy: "jordan@drill", approvedAt, expiresAt: null, note: null } }) });
    rep = await report();
    r = rowOf(rep, "session_booking");
    c.ok("a per-switch pilot on file (the old list) → NOT read: the gate stays closed and the row says so", rep.rolloutClosed.ok && !r.realClients && /older per-switch pilot on file \(Dana Realclient\) is no longer read/.test(r.scope ?? ""), r.scope ?? "");
    await setSwitch("session_booking", { configJson: JSON.stringify({ authorizedFixtureClientIds: [fixture.id] }) });
    await setRollout(pilotOf([real.id]));
    rep = await report();
    r = rowOf(rep, "session_booking");
    c.ok("Dana in the PROGRAM pilot with bookings → the gate is OPEN and names Self-booking — pilot: Dana Realclient", !rep.rolloutClosed.ok && rep.rolloutClosed.openers.includes(`${AUTOMATION_EFFECTS.session_booking.title} — pilot: Dana Realclient`) && /program pilot: active · Dana Realclient/.test(r.scope ?? ""), r.scope ?? "");
    await setRollout(pilotOf([real.id], { ops: core.opsForGroups(["emails"]) }));
    c.ok("the program pilot without bookings ticked → closed for the hub writes", !opens(await report(), "session_booking"));
    await setRollout(pilotOf([real.id], { expiresAt: minsAgo(5).toISOString() }));
    c.ok("the same pilot, expired → closed again", (await report()).rolloutClosed.ok);
    await testOnly();
    await setSwitch("session_booking", { enabled: false, configJson: JSON.stringify({ authorizedFixtureClientIds: [fixture.id] }) });
    r = rowOf(await report(), "session_booking");
    c.ok("switched off with a good list → configured=true, enabled=false, healthy=null", r.configured.ok && !r.enabled.ok && r.healthy.ok === null);
  }

  // =========================================================================
  c.head("5 · reminders: an invalid policy is not 'configured'");
  // =========================================================================
  {
    await connect("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    await setSwitch("reminders", { enabled: true, configJson: JSON.stringify({ timezone: "Mars/Olympus_Mons", maxAttemptsPerAction: -3 }) });
    let rep = await report();
    let r = rowOf(rep, "reminders");
    c.ok("reminders ON with an invalid stored policy → configured=false, and the evaluator's reason is shown", !r.configured.ok && /reminder policy would not run/.test(r.configured.detail), r.configured.detail);
    c.ok("…so it is not effective (the evaluator would treat it as off)", !r.effective.ok);
    await setSwitch("reminders", { configJson: JSON.stringify({}) });
    rep = await report();
    r = rowOf(rep, "reminders");
    c.ok("a valid policy → configured, effective, TEST clients only; the gate stays closed", r.configured.ok && r.effective.ok && !r.realClients && rep.rolloutClosed.ok, r.effective.blockers.join(" | "));
    await setSwitch("reminders", { configJson: JSON.stringify({ testClientsOnly: false }) });
    rep = await report();
    // MOVED TO R03's LAW (Sep 28): lifting the lock used to mean "every
    // client". It now lets the ROLLOUT SCOPE in — TEST only by default.
    c.ok("testClientsOnly cleared with the rollout TEST only → still TEST clients only; the gate stays closed", rep.rolloutClosed.ok && !rowOf(rep, "reminders").realClients, rowOf(rep, "reminders").scope ?? "");
    await setRollout(pilotOf([real.id]));
    rep = await report();
    c.ok("…Dana in the pilot → the gate is OPEN: \"Client reminders — pilot: Dana Realclient\"", !rep.rolloutClosed.ok && rep.rolloutClosed.openers.includes(`${AUTOMATION_EFFECTS.reminders.title} — pilot: Dana Realclient`), rep.rolloutClosed.openers.join(" | "));
    await testOnly();
    await setSwitch("reminders", { enabled: false, configJson: JSON.stringify({}) });
  }

  // =========================================================================
  c.head("6 · health: late, failed, closed, and the hourly run itself");
  // =========================================================================
  {
    await setSwitch("topic_carryover", { enabled: true, lastRunAt: minsAgo(180), lastError: null });
    let r = rowOf(await report(), "topic_carryover");
    c.ok("hourly, last ran 3 h ago → stale, healthy=false", r.effective.ok && r.healthy.stale && r.healthy.ok === false && /late/.test(r.healthy.detail), r.healthy.detail);
    await setSwitch("topic_carryover", { lastRunAt: minsAgo(10) });
    r = rowOf(await report(), "topic_carryover");
    c.ok("last ran 10 min ago → healthy=true", r.healthy.ok === true && !r.healthy.stale);
    await setSwitch("topic_carryover", { lastError: "drill: the carry failed", lastErrorAt: minsAgo(10) });
    r = rowOf(await report(), "topic_carryover");
    c.ok("a recorded error → healthy=false, and the error is shown", r.healthy.ok === false && r.healthy.lastError === "drill: the carry failed");
    await setSwitch("topic_carryover", { enabled: false });
    r = rowOf(await report(), "topic_carryover");
    c.ok("the SAME row switched off → healthy=null, not a failure (the Sep 23 regression)", r.healthy.ok === null && r.healthy.lastError === null);

    await connect("dropbox");
    await setSwitch("topic_folders", { enabled: true });
    r = rowOf(await report(), "topic_folders");
    c.ok("on and effective, never stamped, the hourly run never recorded → unknown (null), not late", r.effective.ok && r.healthy.ok === null && /no run recorded/.test(r.healthy.detail));
    const lateRun = await db.cronRun.create({ data: { job: "sync", startedAt: minsAgo(180), finishedAt: minsAgo(175), ok: true, summary: JSON.stringify({ at: minsAgo(180).toISOString() }) } });
    r = rowOf(await report(), "topic_folders");
    c.ok("the hourly run last started 3 h ago → healthy=false, 'the hourly run is late'", r.healthy.ok === false && /hourly run is late/.test(r.healthy.detail), r.healthy.detail);
    await setSwitch("topic_folders", { enabled: false });
    await db.cronRun.delete({ where: { id: lateRun.id } });

    await db.cronRun.create({ data: { job: "sync", startedAt: minsAgo(10), finishedAt: minsAgo(5), ok: false, error: "confirmationTexts: boom", summary: JSON.stringify({ at: minsAgo(10).toISOString(), confirmationTextsError: "drill: OpenPhone said no" }) } });
    const rep = await report();
    const conf = rowOf(rep, "auto_texts.confirmation");
    const deliv = rowOf(rep, "auto_texts.delivery");
    c.ok("a text step that failed in the last hourly run → that row unhealthy, with the step's own error", conf.healthy.ok === false && /OpenPhone said no/.test(conf.healthy.detail));
    c.ok("…and only that row: the delivery texts in the same run are healthy", deliv.healthy.ok === true);
  }

  // =========================================================================
  c.head("7 · portal_invites for real clients: armed, open, and the live Gmail check");
  // =========================================================================
  {
    await disconnect("gmail");
    await setSwitch("portal_invites", { enabled: true });
    // R03: "for real clients" is now the rollout naming one (Dana).
    let rep = await report();
    c.ok("R03: ON with the rollout TEST only → reaches no real client: neither open nor armed", rep.rolloutClosed.ok && !armedFor(rep, "portal_invites"));
    await setRollout(pilotOf([real.id]));
    rep = await report();
    c.ok("ON with Gmail missing → not effective, the gate stays closed, but it is named as ARMED", rep.rolloutClosed.ok && armedFor(rep, "portal_invites"), rep.rolloutClosed.armed.join(" | "));
    await connect("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    rep = await report();
    c.ok("Gmail connected → the gate is OPEN and names Portal invitations — pilot: Dana Realclient", !rep.rolloutClosed.ok && rep.rolloutClosed.openers.includes(`${AUTOMATION_EFFECTS.portal_invites.title} — pilot: Dana Realclient`), rep.rolloutClosed.openers.join(" | "));
    const before = fence.faked.length;
    tokenScope = "https://www.googleapis.com/auth/gmail.readonly";
    rep = await report(true);
    const r = rowOf(rep, "portal_invites");
    c.ok("live check, mailbox lacks gmail.send → canSend=false and a blocker on the email switch", rep.gmailSend.checked && rep.gmailSend.canSend === false && !r.effective.ok && r.effective.blockers.some((b) => /cannot send/.test(b)), `${rep.gmailSend.detail} | ${r.effective.blockers.join(";")}`);
    c.ok("…which closes the gate again and names it as armed (fixing Gmail would open it)", rep.rolloutClosed.ok && armedFor(rep, "portal_invites"));
    c.ok("only the live check reached Google: token + tokeninfo, nothing else blocked", fence.faked.length - before >= 1 && fence.faked.slice(before).every((u) => u.startsWith("https://oauth2.googleapis.com/")) && fence.blocked.length === 0, fence.faked.slice(before).join(" "));
    tokenScope = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
    rep = await report(true);
    c.ok("live check with gmail.send → can send, portal_invites effective, gate open", rep.gmailSend.canSend === true && rowOf(rep, "portal_invites").effective.ok && !rep.rolloutClosed.ok);
    await setSwitch("portal_invites", { enabled: false });
    c.ok("off → closed", (await report()).rolloutClosed.ok);
    await testOnly();
  }

  // =========================================================================
  c.head("8 · one report, one set of rows");
  // =========================================================================
  {
    const rep = await report();
    const keys = rep.rows.map((r) => r.key);
    c.ok("no row key appears twice", new Set(keys).size === keys.length);
    c.ok("every AUTOMATION_KEY is a row, in order", AUTOMATION_KEYS.every((k) => keys.includes(k)) && rep.rows.filter((r) => r.kind === "program").map((r) => r.key).join() === AUTOMATION_KEYS.join());
    c.ok("the business rows: 4 client texts, 5 team alerts, Topaz, editor routing, review owner", ["auto_texts.confirmation", "auto_texts.delivery", "auto_texts.afterHours", "auto_texts.welcome", "internal_alerts.uploadReminder", "internal_alerts.uploadChaser", "internal_alerts.photosUndelivered", "internal_alerts.rawVideoMissing", "internal_alerts.kyleDigests", "topaz", "editor_routing", "review_room.coverage"].every((k) => keys.includes(k)));
    // The probe's own formatter (scripts/_recon/cp15-config-probe.ts), fed
    // this report: one fact per row, in the same order, plus the gate.
    const { readinessFacts } = await import("../_recon/cp15-config-probe");
    const facts = readinessFacts(rep, R.readinessLine);
    c.ok("the CP-15 probe prints one fact per report row, same keys, same order, plus the rollout gate", facts.length === rep.rows.length + 1 && rep.rows.every((r, i) => facts[i].fact === r.key) && facts[facts.length - 1].fact === "real-client rollout is closed");
    c.ok("…each row's evidence is the report's own readinessLine (all five facts, by name)", rep.rows.every((r, i) => facts[i].evidence.startsWith(R.readinessLine(r)) && /· configured .* · connected .* · enabled .* · effective .* · healthy /.test(facts[i].evidence)));
    c.ok("…and its labels agree with the report (ENABLED iff enabled, BLOCKED iff on but not effective)", rep.rows.every((r, i) => facts[i].labels.includes("ENABLED") === r.enabled.ok && facts[i].labels.includes("BLOCKED") === (r.enabled.ok && !r.effective.ok)));
    c.ok("every row says who hears about it", rep.rows.every((r) => r.recipients.trim().length > 5));
    c.ok("every program row that reaches clients states a scope", rep.rows.filter((r) => r.kind === "program" && r.reaches === "clients").every((r) => !!r.scope));
    const deps = AUTOMATION_KEYS.flatMap((k) => (AUTOMATION_EFFECTS[k].requires?.switches ?? []).map((d) => [k, d] as const));
    c.ok("every dependency names a real switch, never itself", deps.every(([k, d]) => isAutomationKey(d) && d !== k));
    c.ok("every switch has a cadence and recipients in the copy", AUTOMATION_KEYS.every((k) => ["hourly", "daily", "on-action"].includes(AUTOMATION_EFFECTS[k].cadence) && AUTOMATION_EFFECTS[k].recipients.length > 5));
    c.ok("the providers list covers every provider a switch needs", AUTOMATION_KEYS.every((k) => (AUTOMATION_EFFECTS[k].requires?.providers ?? []).every((p) => rep.providers.some((x) => x.id === p))));
    const probe = (await import("node:fs")).readFileSync(path.join(REPO, "scripts/_recon/cp15-config-probe.ts"), "utf8");
    c.ok("the probe builds its switch facts from readinessReport({ live: false }), in place of its old switch loop", /readinessReport\(\{ live: false \}\)/.test(probe) && !/for \(const key of AUTOMATION_KEYS\)/.test(probe));
  }

  // =========================================================================
  c.head("9 · a report writes nothing");
  // =========================================================================
  {
    await setSwitch("reminders", { enabled: true, configJson: JSON.stringify({ testClientsOnly: true }) });
    const snap = async () => JSON.stringify([
      await db.programAutomation.findMany({ orderBy: { key: "asc" } }),
      await db.appSetting.findMany({ orderBy: { key: "asc" } }),
      await db.connection.findMany({ orderBy: { provider: "asc" } }),
      await db.auditLog.count(),
      await db.cronRun.count(),
    ]);
    const a = await snap();
    await report();
    await report(true);
    await report();
    const b = await snap();
    c.ok("ProgramAutomation, AppSetting, Connection, AuditLog and CronRun are byte-identical after three reports (one live)", a === b);
  }

  // =========================================================================
  c.head("10 · fixtureScopeProblems, pure");
  // =========================================================================
  {
    const clients = new Map<string, { id: string; name: string | null; email: string | null }>([
      [fixture.id, { id: fixture.id, name: fixture.name, email: fixture.email }],
      [real.id, { id: real.id, name: real.name, email: real.email }],
      [NEVER_SYNTHETIC_CLIENT_IDS[0], { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST", email: JORDAN_TEST_EMAIL }],
      ["wrong-inbox", { id: "wrong-inbox", name: "Other TEST", email: "someone@example.com" }],
    ]);
    const P = (ids: string[], pilot: unknown = null) => R.fixtureScopeProblems({ authorizedFixtureClientIds: ids, pilot: pilot as never }, clients, NOW);
    c.ok("a good fixture → no problems", P([fixture.id]).length === 0);
    c.ok("a real client renamed TEST (never-synthetic) → named", P([NEVER_SYNTHETIC_CLIENT_IDS[0]]).some((x) => /real client carrying a TEST name/.test(x)));
    c.ok("a TEST name on a real inbox → named", P(["wrong-inbox"]).some((x) => /not the verified test inbox/.test(x)));
    c.ok("an id that does not exist → named", P(["ghost"]).some((x) => /no such client/.test(x)));
    const pilot = { clientIds: [fixture.id], operations: ["orders.create"], approvedBy: "j", approvedAt: minsAgo(60).toISOString(), expiresAt: null, note: null };
    c.ok("a client on both lists → named", P([fixture.id], pilot).some((x) => /both the fixture list and the pilot/.test(x)));
    c.ok("no fixture, an expired pilot → 'the pilot has expired'", P([], { ...pilot, clientIds: [real.id], expiresAt: minsAgo(1).toISOString() }).some((x) => /pilot has expired/.test(x)));
    c.ok("no fixture, an unapproved pilot → 'no recorded approval'", P([], { ...pilot, clientIds: [real.id], approvedBy: null }).some((x) => /no recorded approval/.test(x)));
    c.ok("no fixture, an active pilot → no problems (a pilot alone is a scope)", P([], { ...pilot, clientIds: [real.id] }).length === 0);
  }

  // =========================================================================
  c.head("11 · the Sep 28 review: dependencies the code enforces, per-entry scope, errored keys, evidence");
  // =========================================================================
  {
    // Finding 18 — script_auto_share declared script_drafting + ai_runs, which
    // the sweep never checks: on for real clients with both OFF it releases
    // drafts every hour while the gate read "closed" (armed).
    c.ok("18 · script_auto_share lists no switch dependency (its sweep enforces none)", (AUTOMATION_EFFECTS.script_auto_share.requires?.switches ?? []).length === 0);
    const sweepSrc = (await import("node:fs")).readFileSync(path.join(REPO, "src/lib/scriptAutoShare.ts"), "utf8");
    c.ok("…and indeed the sweep's only switch gate is its own", /isAutomationEnabled\(AUTO_SHARE_KEY\)/.test(sweepSrc) && !/isAutomationEnabled\("(script_drafting|ai_runs)"\)/.test(sweepSrc));
    await setSwitch("script_drafting", { enabled: false });
    await setSwitch("ai_runs", { enabled: false });
    await setSwitch("script_auto_share", { enabled: true, configJson: JSON.stringify({ testClientsOnly: false }) });
    // R03: "for real clients" = its lock lifted AND the rollout naming Dana.
    await setRollout(pilotOf([real.id]));
    let rep = await report();
    let r = rowOf(rep, "script_auto_share");
    c.ok("18 · ON for real clients with drafting and AI OFF → effective, and the gate is OPEN naming it (it was 'closed', armed)", r.effective.ok && r.realClients && !rep.rolloutClosed.ok && opens(rep, "script_auto_share") && !armedFor(rep, "script_auto_share"), rep.rolloutClosed.openers.join(", "));
    await setSwitch("script_auto_share", { enabled: false, configJson: null });

    // Finding 19 — one drifted fixture entry beside an ACTIVE pilot (R03:
    // the PROGRAM pilot, with bookings — set just above).
    await connect("aryeo");
    await setSwitch("session_booking", { enabled: true, configJson: JSON.stringify({ authorizedFixtureClientIds: ["c_deleted_fixture"] }) });
    rep = await report();
    r = rowOf(rep, "session_booking");
    c.ok("19 · a deleted fixture beside an approved pilot → still EFFECTIVE (the pilot writes per client), and an opener", r.effective.ok && !rep.rolloutClosed.ok && opens(rep, "session_booking"), r.effective.blockers.join(" | "));
    c.ok("…the bad entry is named as configuration, never as a blocker", !r.configured.ok && /c_deleted_fixture is on the fixture list but no such client exists \(this entry only/.test(r.configured.detail) && !r.effective.blockers.some((b) => /c_deleted_fixture/.test(b)), r.configured.detail);
    c.ok("…and with no pilot and only bad entries, nobody is in scope → blocked", R.fixtureScope({ authorizedFixtureClientIds: ["c_deleted_fixture"], pilot: null }, new Map(), NOW).blocking.some((b) => /no usable TEST fixture/.test(b)));

    // Finding 20 — a transient failure flips Connection to ERROR and keeps the
    // key; getSecret() still hands it to aryeo.ts, so the pilot still writes.
    await db.connection.update({ where: { provider: "aryeo" }, data: { status: "ERROR", lastError: "drill: Aryeo 503 on the hourly sync" } });
    rep = await report();
    r = rowOf(rep, "session_booking");
    const aryeo = rep.providers.find((p) => p.id === "aryeo")!;
    c.ok("20 · Aryeo ERROR with its key kept → connected (the key is still used), status 'error' with the error", aryeo.connected && aryeo.status === "error" && /503/.test(aryeo.lastError ?? ""));
    c.ok("…session_booking stays effective and an OPENER — no 'needs Aryeo connected' (the gate no longer reads closed while it writes)", r.effective.ok && !r.effective.blockers.some((b) => /Aryeo connected/.test(b)) && opens(rep, "session_booking"));
    c.ok("…and the failure is a HEALTH fact: healthy=false, naming it", r.healthy.ok === false && /Aryeo is connected but refused the hub last time: drill: Aryeo 503/.test(r.healthy.detail), r.healthy.detail);
    await db.connection.update({ where: { provider: "aryeo" }, data: { status: "DISCONNECTED", secretEncrypted: null } });
    c.ok("…a DISCONNECTED row (no key) is still not connected", !(await report()).providers.find((p) => p.id === "aryeo")!.connected);
    await connect("transcription_openai");
    await db.connection.update({ where: { provider: "transcription_openai" }, data: { status: "ERROR", lastError: "drill: refused" } });
    c.ok("…speech-to-text keeps the strict test (its reader refuses unless CONNECTED)", !(await report()).providers.find((p) => p.id === "stt")!.connected);
    await setSwitch("session_booking", { enabled: false });
    await testOnly();

    // Finding 23 — healthy needs evidence.
    await connect("ai");
    await setSwitch("ai_runs", { enabled: true, lastRunAt: null, lastError: null });
    await setSwitch("caption_assistant", { enabled: true, lastRunAt: null, lastError: null });
    rep = await report();
    c.ok("23 · an on-action switch, on and effective, never run → healthy=null ('no run recorded yet'), not 'healthy yes'", ["ai_runs", "caption_assistant"].every((k) => rowOf(rep, k).effective.ok && rowOf(rep, k).healthy.ok === null && /no run recorded yet/.test(rowOf(rep, k).healthy.detail)), rowOf(rep, "ai_runs").healthy.detail);
    c.ok("…and so is a business row with no run record at all (editor routing, the raw-video alert)", ["editor_routing", "internal_alerts.rawVideoMissing"].every((k) => rowOf(rep, k).healthy.ok !== true), ["editor_routing", "internal_alerts.rawVideoMissing"].map((k) => `${k}: ${rowOf(rep, k).healthy.ok}`).join(" · "));
    await setSwitch("ai_runs", { enabled: false });
    await setSwitch("caption_assistant", { enabled: false });
    // A row that IS its run (Topaz) fails with it.
    await connect("topaz");
    const { putSetting, DEFAULT_TOPAZ } = await import("@/lib/settings");
    await putSetting("topaz", { ...DEFAULT_TOPAZ, enabled: true });
    await db.cronRun.create({ data: { job: "topaz", startedAt: minsAgo(4), finishedAt: minsAgo(3), ok: false, error: "advance: Topaz 500", summary: JSON.stringify({ advanceError: "Topaz 500" }) } });
    rep = await report();
    c.ok("13 · a Topaz run that failed → the Topaz row is unhealthy, with the run's error", rowOf(rep, "topaz").healthy.ok === false && /Topaz 500/.test(rowOf(rep, "topaz").healthy.lastError ?? ""), rowOf(rep, "topaz").healthy.detail);
  }

  c.ok("fence: nothing outside loopback was reached except the faked Google calls", fence.blocked.length === 0, fence.blocked.join(","));
  quiet.restore();
  c.summary();
  await stop();
  fence.restore();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
