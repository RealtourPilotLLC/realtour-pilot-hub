// ---------------------------------------------------------------------------
// DRILL: R03 core — WHO THE PROGRAM MAY REACH (the rollout scope), Sep 28 2026.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/r03-rollout-core.ts
//   (DRILL_ENGINE=postgres adds §11, two owners saving at once, on a real
//    Postgres — PGlite is one session and cannot show a lost update.)
//
// The frozen scope-core API (programRolloutCore / programRollout /
// programRolloutGate) that builders A1 and B code against, exhaustively:
//    0. OLD, at HEAD 1075a5b: the audience rule was `lock && !TEST-name` — a
//       lifted lock reached EVERY real client, a real row renamed TEST was
//       reached with the lock on, and there was no way to admit P without X.
//       And the hub-write PILOT route read a per-switch list the program
//       could not see (the drift Jordan's Sep 28 rule removes).
//    1. rolloutDecision over modes × pilot state × op × op-in-pilot ×
//       featureTestOnly × {T, P, X, N, N-named}; since = joinedAt.
//    2. clientTier, rolloutClientFilter (≡ rolloutDecision for every real
//       client), reachSuppressionReason, effectiveSince, pilotStateOf.
//    3. parse / serialize: round trip, every unreadable shape, the cap.
//    4. settleRolloutChange: modeSince and joinedAt stamping.
//    5. The hub-write pilot read from the program pilot; FIXTURE unchanged.
//    6. describeProgramScope never says "every client" unless ALL.
//    7. Server reads: loadProgramRollout, programReach (never throws),
//       programReachMany (one read each), featureTestOnlyFor, programAudience
//       (ACTIVE + PAUSED), pilotClientCandidates, hubWriteScopeWithProgramPilot.
//    8. updateProgramRollout: advisory lock, one transaction, audit row,
//       refuses to overwrite an unreadable value, backstops.
//    9. programDispatchGate: switch, TEST floor, scope, seats, sign-in links,
//       removal takes effect on the next send, fail-closed codes.
//   10. Fail closed end to end: '{bad' → TEST only; a DB error → refused.
//   12. PER-CLIENT CHOICES (Oct 5 2026, Settings → Client onboarding): an
//       optional clientOps[clientId] list; a value without it means exactly
//       what it did. Every reader (decision, sweep filter, hub-write pilot,
//       scope line, tier, since) is per client; setClientOpsChange widens
//       nobody but the client it names. The cap is PROGRAM_PILOT_MAX (30).
//
// SEP 28 REVIEW FIXES (the fixer's pass; each check below fails without its
// fix): caption_assistant is a reach op (14 ops, in "Automatic portal
// changes"); a widening keeps joinedAt and stamps only the new group
// (groupSince); PILOT → ALL keeps a pilot client's earlier since; the end date
// reads the day the owner chose ("through Oct 18", pilotLastDay); a failed
// LOCK read is "error" (readFeatureTestOnly / programReachWithLock) and the
// gate answers gate_error, never launch_not_authorised; clientReachSummary
// names the groups a client is reached for.
//
// ISOLATION: PGlite (or DRILL_ENGINE=postgres) on 127.0.0.1:6200. Every
// non-loopback call is fenced; this drill sends nothing and calls no provider.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6200);
const BASE = "1075a5b"; // pinned: the tree the Sep 28 review read
const REPO = path.resolve(__dirname, "../..");
const N_ID = "cmqikskt1008u9k9qej9ltjy5"; // a NEVER_SYNTHETIC real row

installNextStubs();
const fence = fenceFetch(() => null);

// ---- fault injection and read counting on @/lib/prisma ---------------------
const faults = { client: false, appSetting: false, programAutomation: false, lockRead: false };
const reads = new Map<string, number>();
const countReads = () => [...reads.values()].reduce((a, b) => a + b, 0);
const lockCalls: string[] = [];
/** §11's "fix bypassed" rounds: the lock call is recorded but not taken. */
let bypassLock = false;
interceptModule(
  (r) => r === "@/lib/prisma",
  (mod) => {
    const m = mod as { prisma: Record<string, unknown> };
    const real = m.prisma;
    const watched = new Set(["client", "appSetting", "programAutomation", "clientMembership", "clientUser", "contentEnrollment"]);
    const wrap = (name: string, d: object) =>
      new Proxy(d, {
        get(t, k) {
          const v = Reflect.get(t, k, t);
          if (typeof v !== "function" || typeof k !== "string") return v;
          return (...args: unknown[]) => {
            if (k.startsWith("find") || k === "count") reads.set(`${name}.${k}`, (reads.get(`${name}.${k}`) ?? 0) + 1);
            if ((faults as Record<string, boolean>)[name]) throw new Error(`injected ${name} read failure`);
            // The LOCK read alone (storedConfigs: findMany over configJson); the
            // switch reads (findUnique) stay healthy — the review's blip.
            if (name === "programAutomation" && k === "findMany" && faults.lockRead) throw new Error("injected lock read failure");
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    const proxy = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (typeof k === "string" && watched.has(k) && v && typeof v === "object") return wrap(k, v);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { ...m, prisma: proxy };
  },
);
interceptModule(
  (r) => r === "@/lib/dbLocks",
  (mod) => {
    const m = mod as { lockAdvisory: (tx: unknown, key: string) => Promise<void> };
    return { ...m, lockAdvisory: async (tx: unknown, key: string) => { lockCalls.push(key); if (!bypassLock) return m.lockAdvisory(tx, key); } };
  },
);

// ---- the old code, runnable (pure files only) -------------------------------
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "r03-rollout-core-base-"));
function showBase(rel: string): string {
  return execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8" });
}
async function loadBasePure<T>(rel: string): Promise<T> {
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  fs.writeFileSync(file, showBase(rel));
  return (await import(file)) as T;
}

const DAY = 86_400_000;
const OWNER_EMAIL = "info@realtourpilot.com";

async function main() {
  const drill = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const core = await import("@/lib/programRolloutCore");
  const hub = await import("@/lib/hubWritePermit");
  const tc = await import("@/lib/testClients");
  const {
    PROGRAM_REACH_OPS, PROGRAM_PILOT_GROUPS, PROGRAM_PILOT_MAX, CLOSED_ROLLOUT, rolloutDecision, clientTier, rolloutClientFilter,
    reachSuppressionReason, effectiveSince, pilotStateOf, parseProgramRollout, serializeProgramRollout, settleRolloutChange,
    describeProgramScope, programPilotAsHubPilot, withProgramPilot, isProgramReachOp, opsForGroups, pilotCandidateProblem,
  } = core;
  type Rollout = import("@/lib/programRolloutCore").ProgramRollout;
  type Op = import("@/lib/programRolloutCore").ProgramReachOp;

  const NOW = new Date(Date.UTC(2026, 9, 2, 18, 0)); // Fri Oct 2 2026 14:00 ET
  const iso = (ms: number) => new Date(ms).toISOString();
  const T = { id: "c_t", name: "Rollout TEST" };
  const P = { id: "c_p", name: "Pat Pilot Realty" };
  const X = { id: "c_x", name: "Xena Excluded Homes" };
  const N = { id: N_ID, name: "Jordan Spackman TEST" };
  const JOINED = iso(NOW.getTime() - 3 * DAY);
  const APPROVED = iso(NOW.getTime() - 10 * DAY);
  const ALL_GROUP_OPS = opsForGroups(PROGRAM_PILOT_GROUPS.map((g) => g.key));
  type PilotKind = "none" | "active" | "unapproved" | "expired";
  const pilotOf = (kind: PilotKind, ids: string[], ops: Op[]): Rollout["pilot"] =>
    kind === "none"
      ? null
      : {
          clientIds: ids,
          operations: ops,
          approvedBy: kind === "unapproved" ? null : "info@realtourpilot.com",
          approvedAt: kind === "unapproved" ? null : APPROVED,
          expiresAt: kind === "expired" ? iso(NOW.getTime() - DAY) : iso(NOW.getTime() + 27 * DAY),
          note: null,
          joinedAt: { [P.id]: JOINED },
        };

  // =========================================================================
  c.head("0. OLD at HEAD 1075a5b: a lock that meant TEST-or-everyone, by name only");
  {
    const reminders = showBase("src/lib/programReminders.ts");
    const autoShare = showBase("src/lib/scriptAutoShare.ts");
    c.ok("OLD reminders read the lock as `p.testClientsOnly && !isTest`, isTest by NAME", reminders.includes("if (p.testClientsOnly && !isTest)") && reminders.includes("const isTest = isTestClientName(e.client.name);"));
    c.ok("OLD auto-share read `cfg.testClientsOnly && !isTestClientName(client?.name)`", autoShare.includes("if (cfg.testClientsOnly && !isTestClientName(client?.name))"));
    const oldAllowed = (name: string, lock: boolean) => !(lock && !tc.isTestClientName(name));
    c.ok("OLD, lock lifted: the excluded client X is reached (every real client)", oldAllowed(X.name, false));
    c.ok("OLD, lock on: the real row renamed TEST (N) is reached as if it were TEST", oldAllowed(N.name, true));
    c.ok("OLD: no lock value admits P without X", [true, false].every((l) => oldAllowed(P.name, l) === oldAllowed(X.name, l)));
    const pilot: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id], ALL_GROUP_OPS) };
    const d = (cl: { id: string; name: string }, fto: boolean) => rolloutDecision({ rollout: pilot, client: cl, op: "reminders", now: NOW, featureTestOnly: fto });
    c.ok("NEW, lock lifted: P reached, X refused, N refused, T reached", d(P, false).ok && !d(X, false).ok && !d(N, false).ok && d(T, false).ok);
    c.ok("NEW, lock on: P refused (feature_test_only), N refused, T reached", !d(P, true).ok && (d(P, true) as { code: string }).code === "feature_test_only" && !d(N, true).ok && d(T, true).ok);

    // The hub-write PILOT route: OLD read the switch's own pilot list.
    const oldHub = await loadBasePure<typeof import("@/lib/hubWritePermit")>("src/lib/hubWritePermit.ts");
    const switchCfg = hub.parseHubWriteConfig({ authorizedFixtureClientIds: [], pilot: { clientIds: [X.id], operations: ["appointments.store"], approvedBy: "info@realtourpilot.com", approvedAt: APPROVED, expiresAt: null } });
    const route = (h: typeof hub, cfg: import("@/lib/hubWritePermit").HubWriteScopeConfig, cl: { id: string; name: string }) =>
      h.routeHubWrite({ switchKey: "session_booking", config: cfg, client: cl, operation: "appointments.store", now: NOW, isTestName: tc.isTestClientName, isNeverSynthetic: tc.isNeverSyntheticClientId }).kind;
    c.ok("OLD: X (on the switch's own list, NOT in the program pilot) is written for", route(oldHub, switchCfg, X) === "PILOT");
    c.ok("OLD: P (in the program pilot with bookings) is refused — two lists that drifted", route(oldHub, switchCfg, P) === "REFUSE");
    const newCfg = withProgramPilot(switchCfg, pilot, "session_booking");
    c.ok("NEW: the program pilot names who is written for — P yes, X no", route(hub, newCfg, P) === "PILOT" && route(hub, newCfg, X) === "REFUSE");
  }

  // =========================================================================
  c.head("1. rolloutDecision — the whole matrix");
  {
    const MODES = ["TEST_ONLY", "PILOT", "ALL"] as const;
    const KINDS: PilotKind[] = ["none", "active", "unapproved", "expired"];
    type Who = "T" | "P" | "X" | "N" | "Nnamed";
    const WHO: Who[] = ["T", "P", "X", "N", "Nnamed"];
    const clientOf = (w: Who) => (w === "T" ? T : w === "P" ? P : w === "X" ? X : N);
    let evaluated = 0;
    for (const mode of MODES) for (const kind of KINDS) {
      let mismatches = 0;
      const detail: string[] = [];
      for (const op of PROGRAM_REACH_OPS) for (const opIn of [true, false]) for (const fto of [true, false]) for (const who of WHO) {
        const ids = who === "Nnamed" ? [P.id, N.id] : [P.id];
        const ops = opIn ? [...PROGRAM_REACH_OPS] : PROGRAM_REACH_OPS.filter((o) => o !== op);
        const rollout: Rollout = { mode, modeSince: iso(NOW.getTime() - 5 * DAY), pilot: pilotOf(kind, ids, ops) };
        const got = rolloutDecision({ rollout, client: clientOf(who), op, now: NOW, featureTestOnly: fto });
        // The oracle: the header's rules, restated independently.
        let want: { ok: true; tier: string; since: string | null } | { ok: false; code: string };
        if (who === "T") want = { ok: true, tier: "TEST", since: null };
        else if (fto) want = { ok: false, code: "feature_test_only" };
        else if (mode === "ALL") want = { ok: true, tier: "ALL", since: rollout.modeSince };
        else if (mode === "TEST_ONLY") want = { ok: false, code: "rollout_test_only" };
        else if (kind === "none" || who === "X" || who === "N") want = { ok: false, code: "not_in_pilot" };
        else if (kind === "unapproved") want = { ok: false, code: "pilot_unapproved" };
        else if (kind === "expired") want = { ok: false, code: "pilot_expired" };
        else if (!opIn || op === "publishing") want = { ok: false, code: "operation_not_in_pilot" };
        else want = { ok: true, tier: "PILOT", since: who === "P" ? JOINED : APPROVED };
        evaluated++;
        const same = got.ok === want.ok && (got.ok
          ? want.ok && got.tier === want.tier && (got.since?.toISOString() ?? null) === want.since && got.reason.length > 0
          : !want.ok && got.code === want.code && got.reason.length > 0);
        if (!same) { mismatches++; if (detail.length < 3) detail.push(`${who}/${op}/in=${opIn}/lock=${fto}: got ${JSON.stringify(got)}`); }
      }
      c.ok(`mode ${mode} × pilot ${kind}: every op × in/out × lock × {T,P,X,N,N-named} matches the rules`, mismatches === 0, detail.join(" | "));
    }
    c.ok(`the matrix covered 3 × 4 × ${PROGRAM_REACH_OPS.length} ops × 2 × 2 × 5 = ${60 * PROGRAM_REACH_OPS.length * 4} decisions (15 ops since manual_messages, Oct 5 2026)`, evaluated === 60 * PROGRAM_REACH_OPS.length * 4 && (PROGRAM_REACH_OPS.length as number) === 15, String(evaluated));
    c.ok("N (a never-synthetic row renamed TEST) is never tier TEST", MODES.every((mode) => {
      const d = rolloutDecision({ rollout: { mode, modeSince: null, pilot: pilotOf("active", [N.id], ALL_GROUP_OPS) }, client: N, op: "reminders", now: NOW });
      return !d.ok || d.tier !== "TEST";
    }));
    const pilotRollout: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id], ALL_GROUP_OPS) };
    const dp = rolloutDecision({ rollout: pilotRollout, client: P, op: "revision_policy", now: NOW });
    c.ok("since = joinedAt for a pilot client", dp.ok && dp.since?.toISOString() === JOINED);
    const dExp = rolloutDecision({ rollout: { ...pilotRollout, pilot: { ...pilotRollout.pilot!, expiresAt: NOW.toISOString() } }, client: P, op: "reminders", now: NOW });
    c.ok("a pilot ending exactly now is expired (end is exclusive, as hubWritePermit)", !dExp.ok && dExp.code === "pilot_expired");
    const dPub = rolloutDecision({ rollout: pilotRollout, client: P, op: "publishing", now: NOW });
    c.ok("publishing never reaches a pilot client, even hand-listed", !dPub.ok && dPub.code === "operation_not_in_pilot");
    const dTest = rolloutDecision({ rollout: { ...CLOSED_ROLLOUT }, client: T, op: "publishing", now: NOW, featureTestOnly: true });
    c.ok("a TEST client is reached for every op, in TEST_ONLY, with the lock on", dTest.ok && dTest.tier === "TEST" && dTest.since === null);
    // Oct 5 2026 review fix: manual_messages ("Messages I send myself") joined them, in its own group.
    c.ok("isProgramReachOp: the 15 ops and nothing else (caption_assistant, then manual_messages, joined them)", PROGRAM_REACH_OPS.every(isProgramReachOp) && !isProgramReachOp("session_booking") && !isProgramReachOp(null) && (PROGRAM_REACH_OPS.length as number) === 15 && isProgramReachOp("caption_assistant") && isProgramReachOp("manual_messages"));
    c.ok("the six groups carry every op but publishing, each exactly once; manual_messages alone in 'messages'", JSON.stringify([...ALL_GROUP_OPS].sort()) === JSON.stringify(PROGRAM_REACH_OPS.filter((o) => o !== "publishing").sort()) && PROGRAM_PILOT_GROUPS.flatMap((g) => g.ops).length === 14 && core.pilotGroupOf("manual_messages")?.ops.join() === "manual_messages" && core.pilotGroupOf("manual_messages")?.key === "messages");
    c.ok("REVIEW FIX: caption_assistant is an automatic portal change (a pilot without that group does not reach it)", core.pilotGroupOf("caption_assistant")?.key === "portal_changes" &&
      !rolloutDecision({ rollout: { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id], opsForGroups(["emails"])) }, client: P, op: "caption_assistant", now: NOW }).ok &&
      rolloutDecision({ rollout: { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id], opsForGroups(["portal_changes"])) }, client: P, op: "caption_assistant", now: NOW }).ok);
    c.ok("the bookings group is exactly hub_writes", PROGRAM_PILOT_GROUPS.find((g) => g.key === "bookings")?.ops.join() === "hub_writes");
  }

  // =========================================================================
  c.head("2. clientTier, rolloutClientFilter, suppression codes, effectiveSince, pilotStateOf");
  {
    const MODES = ["TEST_ONLY", "PILOT", "ALL"] as const;
    const KINDS: PilotKind[] = ["none", "active", "unapproved", "expired"];
    let tierBad = 0, filterBad = 0, combos = 0;
    for (const mode of MODES) for (const kind of KINDS) for (const named of [false, true]) {
      const rollout: Rollout = { mode, modeSince: null, pilot: pilotOf(kind, named ? [P.id, N.id] : [P.id], ALL_GROUP_OPS) };
      const activePilot = mode === "PILOT" && kind === "active";
      if (clientTier(rollout, T, NOW) !== "TEST") tierBad++;
      if (clientTier(rollout, P, NOW) !== (activePilot ? "PILOT" : "REAL")) tierBad++;
      if (clientTier(rollout, X, NOW) !== "REAL") tierBad++;
      if (clientTier(rollout, N, NOW) !== (activePilot && named ? "PILOT" : "REAL")) tierBad++;
      for (const op of PROGRAM_REACH_OPS) for (const fto of [true, false]) for (const opsIn of [true, false]) {
        combos++;
        const r2: Rollout = { ...rollout, pilot: rollout.pilot ? { ...rollout.pilot, operations: opsIn ? ALL_GROUP_OPS : ALL_GROUP_OPS.filter((o) => o !== op) } : null };
        const f = rolloutClientFilter({ rollout: r2, op, now: NOW, featureTestOnly: fto });
        for (const cl of [P, X, N]) {
          const inFilter = f.everyone || f.realClientIds.includes(cl.id);
          if (inFilter !== rolloutDecision({ rollout: r2, client: cl, op, now: NOW, featureTestOnly: fto }).ok) filterBad++;
        }
      }
    }
    c.ok("clientTier: T TEST always; P/N PILOT only in an ACTIVE PILOT they are named in; X REAL", tierBad === 0, String(tierBad));
    c.ok(`rolloutClientFilter ≡ rolloutDecision for every real client (${combos} combinations × 3 clients)`, filterBad === 0, String(filterBad));
    const all = rolloutClientFilter({ rollout: { mode: "ALL", modeSince: null, pilot: null }, op: "reminders", now: NOW });
    c.ok("ALL without the lock → { everyone: true }; with it → nobody real", all.everyone === true && !rolloutClientFilter({ rollout: { mode: "ALL", modeSince: null, pilot: null }, op: "reminders", now: NOW, featureTestOnly: true }).everyone);

    const refuse = (code: string) => ({ ok: false as const, code: code as "not_in_pilot", reason: "x" });
    c.ok("reachSuppressionReason: ok → null, lock → launch_not_authorised, every other refusal → not_in_rollout_scope",
      reachSuppressionReason({ ok: true, tier: "PILOT", since: null, reason: "x" }) === null &&
      reachSuppressionReason(refuse("feature_test_only")) === "launch_not_authorised" &&
      ["rollout_test_only", "not_in_pilot", "pilot_unapproved", "pilot_expired", "operation_not_in_pilot", "client_missing", "scope_unreadable"].every((k) => reachSuppressionReason(refuse(k)) === "not_in_rollout_scope"));

    const sw = new Date(NOW.getTime() - 20 * DAY), later = new Date(NOW.getTime() - 3 * DAY), earlier = new Date(NOW.getTime() - 40 * DAY);
    const okd = (since: Date | null) => ({ ok: true as const, tier: "PILOT" as const, since, reason: "x" });
    c.ok("effectiveSince = the later of the switch and since", effectiveSince(sw, okd(later))?.getTime() === later.getTime() && effectiveSince(sw, okd(earlier))?.getTime() === sw.getTime());
    c.ok("effectiveSince: TEST (since null) → the switch's own enabledAt", effectiveSince(sw, okd(null))?.getTime() === sw.getTime());
    c.ok("effectiveSince: switch never enabled → null; a refusal → null (nothing owed, never 'no bound')", effectiveSince(null, okd(later)) === null && effectiveSince(sw, refuse("not_in_pilot")) === null);

    c.ok("pilotStateOf mirrors hubWritePermit.pilotState", (["none", "active", "unapproved", "expired"] as PilotKind[]).every((k) => {
      const r: Rollout = { mode: "PILOT", modeSince: null, pilot: pilotOf(k, [P.id], ALL_GROUP_OPS) };
      return pilotStateOf(r, NOW) === ({ none: "NONE", active: "ACTIVE", unapproved: "UNAPPROVED", expired: "EXPIRED" } as const)[k];
    }) && pilotStateOf({ mode: "PILOT", modeSince: null, pilot: { ...pilotOf("active", [], ALL_GROUP_OPS)! } }, NOW) === "NONE");
  }

  // =========================================================================
  c.head("3. parse / serialize");
  {
    const full: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id, X.id], ALL_GROUP_OPS) };
    const s1 = serializeProgramRollout(full);
    const p1 = parseProgramRollout(s1);
    c.ok("round trip: parse(serialize(r)) = r, no problem", p1.problem === null && JSON.stringify(p1.rollout) === JSON.stringify(full));
    c.ok("round trip is byte-stable", serializeProgramRollout(p1.rollout) === s1);
    const missing = parseProgramRollout(null);
    c.ok("a missing row is TEST_ONLY with NO problem (it is the default, Stage B)", missing.problem === null && missing.rollout.mode === "TEST_ONLY" && missing.rollout.pilot === null && parseProgramRollout(undefined).problem === null);
    const bad: [string, string][] = [
      ["{bad", "not valid JSON"],
      ["", "not valid JSON"],
      ["[1,2]", "not a JSON object"],
      ["null", "not a JSON object"],
      [JSON.stringify({ mode: "EVERYONE" }), "unknown mode"],
      [JSON.stringify({ pilot: null }), "unknown mode"],
      [JSON.stringify({ mode: "PILOT", pilot: "P" }), "pilot is not a JSON object"],
      [JSON.stringify({ mode: "PILOT", pilot: { clientIds: Array.from({ length: PROGRAM_PILOT_MAX + 1 }, (_, i) => `c${i}`) } }), `more than the cap of ${PROGRAM_PILOT_MAX}`],
    ];
    for (const [raw, why] of bad) {
      const r = parseProgramRollout(raw);
      c.ok(`unreadable ${JSON.stringify(raw).slice(0, 48)} → TEST_ONLY + problem (${why})`, r.rollout.mode === "TEST_ONLY" && r.rollout.pilot === null && !!r.problem?.includes(why), r.problem ?? "");
    }
    const tolerant = parseProgramRollout(JSON.stringify({
      mode: "PILOT", modeSince: "not a date",
      pilot: { clientIds: [" c_p ", "c_p", 7, "", "c_x"], operations: ["reminders", "publishing", "session_booking", "reminders", "hub_writes"], approvedBy: "  info@realtourpilot.com ", approvedAt: APPROVED, expiresAt: "soon", note: "", joinedAt: { c_p: JOINED, c_gone: JOINED, c_x: "yesterday" } },
    }));
    const tp = tolerant.rollout.pilot!;
    c.ok("tolerant read: ids trimmed + de-duplicated, junk dropped", tolerant.problem === null && tp.clientIds.join() === "c_p,c_x");
    c.ok("tolerant read: unknown ops and publishing dropped, canonical order", tp.operations.join() === "reminders,hub_writes");
    c.ok("tolerant read: bad dates → null, text trimmed, empty note → null", tolerant.rollout.modeSince === null && tp.expiresAt === null && tp.approvedBy === "info@realtourpilot.com" && tp.note === null);
    c.ok("tolerant read: joinedAt keeps only listed clients with real dates", JSON.stringify(tp.joinedAt) === JSON.stringify({ c_p: JOINED }));
    c.ok("CLOSED_ROLLOUT is frozen and parse hands out copies", Object.isFrozen(CLOSED_ROLLOUT) && parseProgramRollout("{bad").rollout !== CLOSED_ROLLOUT && CLOSED_ROLLOUT.mode === "TEST_ONLY");
    c.ok(`PROGRAM_PILOT_MAX is 30 (raised from 3, Oct 5 2026 — still a cap); exactly ${PROGRAM_PILOT_MAX} parses`, (PROGRAM_PILOT_MAX as number) === 30 && parseProgramRollout(JSON.stringify({ mode: "PILOT", pilot: { clientIds: Array.from({ length: PROGRAM_PILOT_MAX }, (_, i) => `c${i}`) } })).problem === null);
  }

  // =========================================================================
  c.head("4. settleRolloutChange — modeSince and joinedAt");
  {
    const t0 = NOW, t1 = new Date(NOW.getTime() + 5 * DAY);
    const approved = { approvedBy: "info@realtourpilot.com", approvedAt: iso(t0.getTime()), expiresAt: iso(t0.getTime() + 30 * DAY), note: null };
    const start: Rollout = { ...CLOSED_ROLLOUT };
    const s1 = settleRolloutChange(start, { mode: "PILOT", modeSince: null, pilot: { clientIds: [P.id], operations: ALL_GROUP_OPS, ...approved, joinedAt: { [P.id]: iso(t0.getTime() - 99 * DAY) } } }, t0);
    const r1 = "rollout" in s1 ? s1.rollout : null;
    c.ok("TEST_ONLY → PILOT: modeSince = now; a new client's joinedAt = now (a caller's older date is ignored)", !!r1 && r1.modeSince === iso(t0.getTime()) && r1.pilot?.joinedAt[P.id] === iso(t0.getTime()));
    const s2 = settleRolloutChange(r1!, { ...r1!, pilot: { ...r1!.pilot!, clientIds: [P.id, X.id], note: "second" } }, t1);
    const r2 = "rollout" in s2 ? s2.rollout : null;
    c.ok("adding X later: P keeps joinedAt, X is stamped at the add, modeSince kept", !!r2 && r2.pilot?.joinedAt[P.id] === iso(t0.getTime()) && r2.pilot?.joinedAt[X.id] === iso(t1.getTime()) && r2.modeSince === iso(t0.getTime()));
    const narrowed = settleRolloutChange(r1!, { ...r1!, pilot: { ...r1!.pilot!, operations: opsForGroups(["emails"]) } }, t1);
    c.ok("narrowing the groups keeps joinedAt", "rollout" in narrowed && narrowed.rollout.pilot?.joinedAt[P.id] === iso(t0.getTime()));
    const emailsOnly = settleRolloutChange(start, { mode: "PILOT", modeSince: null, pilot: { clientIds: [P.id], operations: opsForGroups(["emails"]), ...approved, joinedAt: {} } }, t0);
    const widened = settleRolloutChange((emailsOnly as { rollout: Rollout }).rollout, { ...(emailsOnly as { rollout: Rollout }).rollout, pilot: { ...(emailsOnly as { rollout: Rollout }).rollout.pilot!, operations: ALL_GROUP_OPS } }, t1);
    // REVIEW FIX (Sep 28): a widening used to re-stamp joinedAt, which moved
    // "since" forward for the groups the client ALREADY had.
    const wr = "rollout" in widened ? widened.rollout : null;
    c.ok("REVIEW FIX: widening keeps joinedAt; only the newly ticked groups start at the change (groupSince)",
      !!wr && wr.pilot?.joinedAt[P.id] === iso(t0.getTime()) && wr.pilot?.groupSince?.emails === iso(t0.getTime()) && wr.pilot?.groupSince?.portal_changes === iso(t1.getTime()) && wr.pilot?.groupSince?.layout === iso(t1.getTime()),
      JSON.stringify(wr?.pilot));
    const at = (op: Op) => { const d = rolloutDecision({ rollout: wr!, client: P, op, now: new Date(t1.getTime() + DAY) }); return d.ok ? d.since?.toISOString() ?? null : `refused ${d.code}`; };
    c.ok("REVIEW FIX: after the widening, reminders (emails, ticked from the start) keep since = the join; review deadlines (newly ticked) start at the widening",
      at("reminders") === iso(t0.getTime()) && at("revision_policy") === iso(t1.getTime()), `reminders ${at("reminders")} · revision_policy ${at("revision_policy")}`);
    const narrowedAgain = settleRolloutChange(wr!, { ...wr!, pilot: { ...wr!.pilot!, operations: opsForGroups(["emails", "layout"]) } }, new Date(t1.getTime() + DAY));
    c.ok("unticking a group drops its groupSince; the kept groups keep theirs", "rollout" in narrowedAgain && !narrowedAgain.rollout.pilot?.groupSince?.portal_changes && narrowedAgain.rollout.pilot?.groupSince?.layout === iso(t1.getTime()) && narrowedAgain.rollout.pilot?.joinedAt[P.id] === iso(t0.getTime()));
    const gsRound = parseProgramRollout(serializeProgramRollout(wr!));
    c.ok("groupSince round-trips (byte-stable) and is dropped for groups the pilot does not carry", gsRound.problem === null && serializeProgramRollout(gsRound.rollout) === serializeProgramRollout(wr!) &&
      !parseProgramRollout(JSON.stringify({ mode: "PILOT", pilot: { clientIds: [P.id], operations: ["reminders"], groupSince: { emails: iso(t0.getTime()), layout: iso(t1.getTime()), bogus: iso(t1.getTime()) } } })).rollout.pilot?.groupSince?.layout);
    // REVIEW FIX: PILOT → ALL kept "since" for nobody — every client, the
    // pilot's included, read modeSince.
    const toAllFix = settleRolloutChange(r1!, { ...r1!, mode: "ALL" }, t1);
    const ar = "rollout" in toAllFix ? toAllFix.rollout : null;
    const sinceAll = (cl: { id: string; name: string }, op: Op) => { const d = rolloutDecision({ rollout: ar!, client: cl, op, now: new Date(t1.getTime() + DAY) }); return d.ok ? d.since?.toISOString() ?? null : `refused ${d.code}`; };
    c.ok("REVIEW FIX: PILOT → ALL: the pilot client keeps since = its join; everyone else starts at modeSince",
      !!ar && ar.modeSince === iso(t1.getTime()) && sinceAll(P, "revision_policy") === iso(t0.getTime()) && sinceAll(X, "revision_policy") === iso(t1.getTime()),
      `P ${sinceAll(P, "revision_policy")} · X ${sinceAll(X, "revision_policy")}`);
    const addedInAll = settleRolloutChange(ar!, { ...ar!, pilot: { ...ar!.pilot!, clientIds: [P.id, X.id] } }, new Date(t1.getTime() + 2 * DAY));
    c.ok("…a client named in the pilot while the rollout is everyone keeps modeSince (reached since then), never later",
      "rollout" in addedInAll && rolloutDecision({ rollout: addedInAll.rollout, client: X, op: "reminders", now: new Date(t1.getTime() + 3 * DAY) }).ok &&
      (rolloutDecision({ rollout: addedInAll.rollout, client: X, op: "reminders", now: new Date(t1.getTime() + 3 * DAY) }) as { since: Date }).since.toISOString() === iso(t1.getTime()));
    const removed = settleRolloutChange(r2!, { ...r2!, pilot: { ...r2!.pilot!, clientIds: [X.id] } }, t1);
    const readded = settleRolloutChange((removed as { rollout: Rollout }).rollout, { ...(removed as { rollout: Rollout }).rollout, pilot: { ...(removed as { rollout: Rollout }).rollout.pilot!, clientIds: [X.id, P.id] } }, new Date(t1.getTime() + DAY));
    c.ok("removing P drops its joinedAt; re-adding stamps it fresh", "rollout" in removed && !(P.id in removed.rollout.pilot!.joinedAt) && "rollout" in readded && readded.rollout.pilot?.joinedAt[P.id] === iso(t1.getTime() + DAY));
    const expired: Rollout = { ...r1!, pilot: { ...r1!.pilot!, expiresAt: iso(t0.getTime() + DAY) } };
    const renewed = settleRolloutChange(expired, { ...expired, pilot: { ...expired.pilot!, expiresAt: iso(t1.getTime() + 30 * DAY) } }, t1);
    c.ok("re-approving an EXPIRED pilot re-stamps joinedAt (re-entry is a join)", "rollout" in renewed && renewed.rollout.pilot?.joinedAt[P.id] === iso(t1.getTime()));
    const toTestOnly = settleRolloutChange(r1!, { ...r1!, mode: "TEST_ONLY" }, t1);
    const backToPilot = settleRolloutChange((toTestOnly as { rollout: Rollout }).rollout, { ...(toTestOnly as { rollout: Rollout }).rollout, mode: "PILOT" }, new Date(t1.getTime() + DAY));
    c.ok("PILOT → TEST_ONLY → PILOT: modeSince and joinedAt are the moment of return", "rollout" in backToPilot && backToPilot.rollout.modeSince === iso(t1.getTime() + DAY) && backToPilot.rollout.pilot?.joinedAt[P.id] === iso(t1.getTime() + DAY));
    const toAll = settleRolloutChange(r1!, { ...r1!, mode: "ALL" }, t1);
    const allToPilot = settleRolloutChange((toAll as { rollout: Rollout }).rollout, { ...(toAll as { rollout: Rollout }).rollout, mode: "PILOT" }, new Date(t1.getTime() + DAY));
    c.ok("PILOT → ALL → PILOT: a client inside the whole time keeps joinedAt", "rollout" in allToPilot && allToPilot.rollout.pilot?.joinedAt[P.id] === iso(t0.getTime()));
    const four = settleRolloutChange(r1!, { ...r1!, pilot: { ...r1!.pilot!, clientIds: Array.from({ length: PROGRAM_PILOT_MAX + 1 }, (_, i) => `c${i}`) } }, t1);
    c.ok(`a ${PROGRAM_PILOT_MAX + 1}st real client is refused`, "error" in four && four.error.includes(`cap is ${PROGRAM_PILOT_MAX}`));
  }

  // =========================================================================
  c.head("5. The hub-write pilot is the program pilot (Jordan, Sep 28)");
  {
    const pilot: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id], ALL_GROUP_OPS) };
    const fixture = { id: "c_fix", name: "Fixture TEST" };
    const cfg = hub.parseHubWriteConfig({ authorizedFixtureClientIds: [fixture.id], pilot: { clientIds: [X.id], operations: ["appointments.store"], approvedBy: "x", approvedAt: APPROVED } });
    const route = (r: Rollout, sw: import("@/lib/hubWritePermit").HubWriteSwitch, cl: { id: string; name: string }, op: string, now = NOW) =>
      hub.routeHubWrite({ switchKey: sw, config: withProgramPilot(cfg, r, sw), client: cl, operation: op, now, isTestName: tc.isTestClientName, isNeverSynthetic: tc.isNeverSyntheticClientId }).kind;
    const bookOps = hub.HUB_WRITE_OPERATION_GROUPS.session_booking.flatMap((g) => g.operations);
    c.ok("P in the pilot with bookings: every session_booking operation → PILOT", bookOps.every((op) => route(pilot, "session_booking", P, op) === "PILOT"));
    c.ok("… and address_sync's addresses.patch → PILOT", route(pilot, "address_sync", P, "addresses.patch") === "PILOT");
    c.ok("X (only on the old per-switch list) → REFUSE", route(pilot, "session_booking", X, "appointments.store") === "REFUSE");
    const noBookings: Rollout = { ...pilot, pilot: { ...pilot.pilot!, operations: ALL_GROUP_OPS.filter((o) => o !== "hub_writes") } };
    c.ok("P without the bookings group → REFUSE", route(noBookings, "session_booking", P, "appointments.store") === "REFUSE" && programPilotAsHubPilot(noBookings, "session_booking")?.operations.length === 0);
    c.ok("TEST_ONLY → no pilot at all", programPilotAsHubPilot({ ...pilot, mode: "TEST_ONLY" }, "session_booking") === null && route({ ...pilot, mode: "TEST_ONLY" }, "session_booking", P, "appointments.store") === "REFUSE");
    c.ok("an expired or unapproved program pilot → REFUSE", route({ ...pilot, pilot: pilotOf("expired", [P.id], ALL_GROUP_OPS) }, "session_booking", P, "appointments.store") === "REFUSE" && route({ ...pilot, pilot: pilotOf("unapproved", [P.id], ALL_GROUP_OPS) }, "session_booking", P, "appointments.store") === "REFUSE");
    c.ok("ALL still writes only for the NAMED pilot (widening Aryeo writes is its own decision)", route({ ...pilot, mode: "ALL" }, "session_booking", P, "appointments.store") === "PILOT" && route({ ...pilot, mode: "ALL" }, "session_booking", X, "appointments.store") === "REFUSE");
    c.ok("the FIXTURE path is unchanged: the listed TEST fixture → FIXTURE in every mode", (["TEST_ONLY", "PILOT", "ALL"] as const).every((m) => route({ ...pilot, mode: m }, "session_booking", fixture, "appointments.store") === "FIXTURE"));
    c.ok("withProgramPilot keeps the fixture list and copies it", withProgramPilot(cfg, pilot, "session_booking").authorizedFixtureClientIds.join() === fixture.id && withProgramPilot(cfg, pilot, "session_booking").authorizedFixtureClientIds !== cfg.authorizedFixtureClientIds);
    c.ok("call_booking maps to its own Calendly operations", programPilotAsHubPilot(pilot, "call_booking")?.operations.join() === "invitees.create,scheduled_events.cancel");
  }

  // =========================================================================
  c.head("6. describeProgramScope");
  {
    const names = new Map([[P.id, P.name]]);
    const pilot: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id], ALL_GROUP_OPS) };
    const line = (r: Rollout, op: Op, fto: boolean, problem: string | null = null) => describeProgramScope({ rollout: r, op, featureTestOnly: fto, testNames: ["Jordan Spackman TEST"], names, now: NOW, problem });
    const lp = line(pilot, "reminders", false);
    c.ok("PILOT names the TEST clients and the pilot with approver and end date", lp.realClients && lp.line.startsWith("TEST clients (Jordan Spackman TEST) + pilot: Pat Pilot Realty (approved by info@realtourpilot.com") && lp.line.includes("through Oct 29") && lp.pilotNames.join() === P.name, lp.line);
    const cases: [string, ReturnType<typeof line>][] = [
      ["TEST_ONLY", line({ ...pilot, mode: "TEST_ONLY" }, "reminders", false)],
      ["the feature lock", line(pilot, "reminders", true)],
      ["no pilot named", line({ ...pilot, pilot: null }, "reminders", false)],
      ["unapproved", line({ ...pilot, pilot: pilotOf("unapproved", [P.id], ALL_GROUP_OPS) }, "reminders", false)],
      ["expired", line({ ...pilot, pilot: pilotOf("expired", [P.id], ALL_GROUP_OPS) }, "reminders", false)],
      ["group not ticked", line({ ...pilot, pilot: { ...pilot.pilot!, operations: opsForGroups(["accounts"]) } }, "reminders", false)],
      ["publishing", line(pilot, "publishing", false)],
      ["unreadable", line({ ...CLOSED_ROLLOUT }, "reminders", false, "the stored rollout is not valid JSON")],
      ["ALL + lock", line({ ...pilot, mode: "ALL" }, "script_auto_share", true)],
    ];
    for (const [label, d] of cases) c.ok(`${label}: "TEST clients … only", realClients false, never "every client"`, !d.realClients && d.line.includes("only —") && !/every client/i.test(d.line), d.line);
    c.ok("the lock sentence says where to lift it", line(pilot, "reminders", true).line.includes("lift it in Program reminders"));
    c.ok("the unreadable line quotes the problem", line({ ...CLOSED_ROLLOUT }, "reminders", false, "the stored rollout is not valid JSON").line.includes("could not be read: the stored rollout is not valid JSON"));
    const la = line({ ...pilot, mode: "ALL" }, "reminders", false);
    c.ok("only ALL without the lock says every client", la.realClients && la.line === "every client with a program (rollout: everyone)");
    c.ok("no TEST clients yet is said plainly", describeProgramScope({ rollout: { ...CLOSED_ROLLOUT }, op: "reminders", featureTestOnly: false, testNames: [], names, now: NOW }).line.startsWith("TEST clients (none yet) only"));

    // REVIEW FIX (Sep 28): the end date read a day late. The editors store the
    // NEXT ET midnight after the chosen day; Jordan chose Oct 18.
    const end18 = "2026-10-19T04:00:00.000Z"; // the end of Oct 18, ET
    const piloted: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: { ...pilotOf("active", [P.id], ALL_GROUP_OPS)!, expiresAt: end18 } };
    const lineEnd = describeProgramScope({ rollout: piloted, op: "reminders", featureTestOnly: false, testNames: ["Jordan Spackman TEST"], names, now: NOW }).line;
    const dEnd = rolloutDecision({ rollout: piloted, client: P, op: "reminders", now: NOW });
    const dGone = rolloutDecision({ rollout: piloted, client: P, op: "reminders", now: new Date("2026-10-19T16:00:00Z") });
    const hubLine = hub.describeHubWriteScope("session_booking", { enabled: true, missing: false, config: withProgramPilot({ authorizedFixtureClientIds: [], pilot: null }, piloted, "session_booking") }, names, NOW).pilot;
    c.ok("REVIEW FIX: pilotLastDay names the chosen day", core.pilotLastDay(end18) === "Oct 18" && hub.pilotLastDay(end18) === "Oct 18" && core.pilotLastDay(null) === "");
    c.ok("REVIEW FIX: the scope line, the decision, the expiry refusal and the hub-write row all say Oct 18, never Oct 19",
      lineEnd.includes("through Oct 18") && dEnd.ok && dEnd.reason.includes("through Oct 18") && !dGone.ok && dGone.reason.includes("ended after Oct 18") && hubLine.includes("through Oct 18") &&
      ![lineEnd, dEnd.reason, dGone.reason, hubLine].some((x) => /Oct 19|2026-10-19/.test(x)), [lineEnd, dEnd.reason, dGone.reason, hubLine].join(" || "));
    const hubExpired = hub.pilotProblem("session_booking", programPilotAsHubPilot(piloted, "session_booking"), P.id, "orders.create", new Date("2026-10-19T16:00:00Z"));
    c.ok("REVIEW FIX: the hub-write refusal after the end says 'ended after Oct 18', not a raw timestamp", !!hubExpired && hubExpired.includes("ended after Oct 18") && !hubExpired.includes("2026-"), hubExpired ?? "");

    // REVIEW FIX (Sep 28): one client, every group — not one op standing for all.
    const emailsOnly: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id], opsForGroups(["emails"])) };
    const sumP = core.clientReachSummary(emailsOnly, P, NOW);
    const sumX = core.clientReachSummary(emailsOnly, X, NOW);
    const sumT = core.clientReachSummary(emailsOnly, T, NOW);
    c.ok("REVIEW FIX: an emails-only pilot client is PILOT for 'program emails' (it read 'not reached for this' through portal_sign_in)",
      sumP.tier === "PILOT" && sumP.groups.join() === "emails" && !rolloutDecision({ rollout: emailsOnly, client: P, op: "portal_sign_in", now: NOW }).ok, JSON.stringify(sumP));
    const accountsOnly = core.clientReachSummary({ ...emailsOnly, pilot: { ...emailsOnly.pilot!, operations: opsForGroups(["accounts"]) } }, P, NOW);
    c.ok("REVIEW FIX: an accounts-only pilot client lists 'accounts' only (no email group)", accountsOnly.tier === "PILOT" && accountsOnly.groups.join() === "accounts", JSON.stringify(accountsOnly));
    c.ok("…X is refused not_in_pilot for every group; T is TEST", sumX.tier === null && sumX.code === "not_in_pilot" && sumX.groups.length === 0 && sumT.tier === "TEST");
    const allSum = core.clientReachSummary({ mode: "ALL", modeSince: APPROVED, pilot: pilotOf("active", [P.id], ALL_GROUP_OPS) }, X, NOW);
    c.ok("…in ALL, X is reached for every group but bookings (the hub still writes only for the named pilot)", allSum.tier === "ALL" && !allSum.groups.includes("bookings") && allSum.groups.length === PROGRAM_PILOT_GROUPS.length - 1, JSON.stringify(allSum));
    c.ok("pilotCandidateProblem: TEST refused, N gets 'fix the name', a real name passes",
      !!pilotCandidateProblem(T)?.includes("TEST client") && !!pilotCandidateProblem(N)?.includes("fix the name") && pilotCandidateProblem(P) === null);
  }

  // =========================================================================
  // THE DATABASE PART
  // =========================================================================
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const R = await import("@/lib/programRollout");
  const G = await import("@/lib/programRolloutGate");

  const mkClient = (id: string, name: string, email: string | null = null) => db.client.create({ data: { id, name, email } });
  const mkEnrollment = (clientId: string, status = "ACTIVE") =>
    db.contentEnrollment.create({ data: { clientId, package: "Starter", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, status } });
  const people: Record<string, string> = {};
  const seats: Record<string, string> = {};
  const mkSeat = async (label: string, email: string, enrollmentId: string, clientId: string) => {
    const u = await db.clientUser.upsert({ where: { email }, create: { email, name: label }, update: {} });
    people[label] = u.id;
    const m = await db.clientMembership.create({ data: { clientUserId: u.id, enrollmentId, clientId } });
    seats[`${label}@${clientId}`] = m.id;
    return m.id;
  };
  await mkClient(T.id, T.name);
  await mkClient("c_t2", "Rollout Two TEST");
  await mkClient(P.id, P.name);
  await mkClient(X.id, X.name, "xo@example.test");
  await mkClient("c_y", "Yolanda Paused Group");
  await mkClient("c_z", "Zed Ended Team");
  await mkClient(N.id, N.name);
  await mkClient("c_r", "Rae NoProgram");
  for (const id of ["c_p2", "c_p3", "c_p4"]) await mkClient(id, `Cap Client ${id.slice(-1)}`);
  const eT = await mkEnrollment(T.id);
  const eT2 = await mkEnrollment("c_t2");
  const eP = await mkEnrollment(P.id);
  const eX = await mkEnrollment(X.id);
  await mkEnrollment("c_y", "PAUSED");
  await mkEnrollment("c_z", "ENDED");
  await mkEnrollment(N.id);
  for (const id of ["c_p2", "c_p3", "c_p4"]) await mkEnrollment(id);
  await mkSeat("tOwner", "info+rt@realtourpilot.com", eT.id, T.id);
  await mkSeat("t2Owner", "nick@realtourpilot.com", eT2.id, "c_t2");
  await mkSeat("pat", "pat@example.test", eP.id, P.id);
  await mkSeat("xo", "xo@example.test", eX.id, X.id);
  await mkSeat("q", "q@example.test", eP.id, P.id);
  await mkSeat("q", "q@example.test", eX.id, X.id);
  const OWNER = "info@realtourpilot.com";
  const setSwitch = (key: string, enabled: boolean, configJson: string | null = null) =>
    db.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledAt: enabled ? new Date() : null, configJson }, update: { enabled, configJson } });
  const storedRow = () => db.appSetting.findUnique({ where: { key: "program-rollout" } });
  const audits = () => db.auditLog.count({ where: { target: "program-rollout" } });
  const approvePilot = (ids: string[], ops = ALL_GROUP_OPS) => (cur: Rollout, now: Date): Rollout => ({
    ...cur, mode: "PILOT",
    pilot: { clientIds: ids, operations: ops, approvedBy: OWNER, approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * DAY).toISOString(), note: "drill", joinedAt: {} },
  });

  // =========================================================================
  c.head("7. Server reads: loadProgramRollout, programReach(Many), featureTestOnlyFor, programAudience");
  {
    const l0 = await R.loadProgramRollout();
    c.ok("no row → TEST_ONLY, no problem, no updatedAt", l0.rollout.mode === "TEST_ONLY" && l0.problem === null && l0.updatedAt === null);
    const tOnly = await R.programReach("reminders", T.id);
    const pOnly = await R.programReach("reminders", P.id);
    c.ok("default scope: T reached (TEST), P refused rollout_test_only", tOnly.ok && tOnly.tier === "TEST" && !pOnly.ok && pOnly.code === "rollout_test_only");
    c.ok("a client that does not exist → client_missing", (await R.programReach("reminders", "c_nobody")).ok === false && ((await R.programReach("reminders", "c_nobody")) as { code: string }).code === "client_missing");

    await db.appSetting.create({ data: { key: "program-rollout", value: "{bad", updatedBy: "someone" } });
    const lb = await R.loadProgramRollout();
    const pb = await R.programReach("reminders", P.id);
    const tb = await R.programReach("reminders", T.id);
    c.ok("'{bad' → TEST_ONLY + a problem; P refused and the reason says the value is unreadable; T still reached",
      lb.rollout.mode === "TEST_ONLY" && !!lb.problem && !pb.ok && pb.reason.includes("could not be read") && tb.ok, pb.ok ? "" : pb.reason);
    await db.appSetting.delete({ where: { key: "program-rollout" } });

    faults.client = true;
    const ue = await R.programReach("reminders", T.id);
    faults.client = false;
    faults.appSetting = true;
    const ua = await R.programReach("reminders", T.id);
    const manyErr = await R.programReachMany("reminders", [T.id, P.id]);
    faults.appSetting = false;
    c.ok("a client-read error → scope_unreadable (never a throw), even for T", !ue.ok && ue.code === "scope_unreadable");
    c.ok("a scope-read error → scope_unreadable", !ua.ok && ua.code === "scope_unreadable");
    c.ok("programReachMany on error: every id scope_unreadable", [...manyErr.values()].every((d) => !d.ok && d.code === "scope_unreadable") && manyErr.size === 2);

    const pilotRollout: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: { ...pilotOf("active", [P.id], ALL_GROUP_OPS)!, approvedAt: iso(Date.now() - DAY), expiresAt: iso(Date.now() + 29 * DAY), joinedAt: {} } };
    reads.clear();
    const many = await R.programReachMany("reminders", [T.id, P.id, X.id, N.id, P.id, "c_nobody"], { rollout: pilotRollout });
    c.ok("programReachMany with a passed rollout: ONE client query, NO scope read", reads.get("client.findMany") === 1 && !reads.has("appSetting.findUnique") && countReads() === 1, JSON.stringify([...reads]));
    c.ok("… and the answers: T TEST, P PILOT, X/N refused, missing → client_missing, duplicates folded",
      many.size === 5 && many.get(T.id)?.ok === true && (many.get(P.id) as { tier?: string }).tier === "PILOT" && !many.get(X.id)!.ok && !many.get(N.id)!.ok && (many.get("c_nobody") as { code?: string }).code === "client_missing");
    reads.clear();
    await R.programReachMany("reminders", [T.id, P.id]);
    c.ok("programReachMany without one: one scope read + one client query", reads.get("appSetting.findUnique") === 1 && reads.get("client.findMany") === 1 && countReads() === 2, JSON.stringify([...reads]));
    reads.clear();
    await R.programReach("reminders", P.id, { rollout: pilotRollout });
    c.ok("programReach re-reads the client by id (never a caller's name)", reads.get("client.findUnique") === 1);

    // featureTestOnlyFor — every op, stored config whether on or off.
    const fto = async () => Object.fromEntries(await Promise.all(PROGRAM_REACH_OPS.map(async (op) => [op, await R.featureTestOnlyFor(op)] as const)));
    const f0 = await fto();
    c.ok("no rows: the four locked ops read locked, every other op unlocked",
      f0.reminders && f0.script_share_email && f0.script_auto_share && f0.review_auto_approve &&
      PROGRAM_REACH_OPS.filter((o) => !["reminders", "script_share_email", "script_auto_share", "review_auto_approve"].includes(o)).every((o) => f0[o] === false), JSON.stringify(f0));
    await setSwitch("reminders", false, JSON.stringify({ testClientsOnly: false }));
    await setSwitch("script_auto_share", false, JSON.stringify({ testClientsOnly: false }));
    await setSwitch("revision_policy", false, JSON.stringify({ testClientsOnly: false }));
    const f1 = await fto();
    c.ok("lifted in the STORED config with every switch OFF → unlocked (reminders, share emails, auto-share, auto-approve via revision_policy)",
      !f1.reminders && !f1.script_share_email && !f1.script_auto_share && !f1.review_auto_approve, JSON.stringify(f1));
    await setSwitch("review_auto_approve", false, JSON.stringify({ testClientsOnly: true }));
    c.ok("review_auto_approve's own lock wins over revision_policy's", (await R.featureTestOnlyFor("review_auto_approve")) === true);
    await setSwitch("review_auto_approve", false, "{bad");
    c.ok("an unreadable review_auto_approve config → locked", (await R.featureTestOnlyFor("review_auto_approve")) === true);
    await setSwitch("review_auto_approve", false, null);
    c.ok("no own config → revision_policy's (lifted)", (await R.featureTestOnlyFor("review_auto_approve")) === false);
    const { validateReminderPolicy, REMINDER_DEFAULTS } = await import("@/lib/programReminders");
    const invalid = { testClientsOnly: false, maxAttemptsPerAction: "lots" };
    c.ok("(the invalid policy below really is invalid)", !validateReminderPolicy({ ...REMINDER_DEFAULTS, ...invalid }).ok);
    await setSwitch("reminders", true, JSON.stringify(invalid));
    c.ok("an INVALID reminders policy reads locked for reminders AND share emails (as readiness read it)", (await R.featureTestOnlyFor("reminders")) && (await R.featureTestOnlyFor("script_share_email")));
    await setSwitch("reminders", true, "[]");
    await setSwitch("script_auto_share", true, "[]");
    c.ok("a non-object config → locked", (await R.featureTestOnlyFor("reminders")) && (await R.featureTestOnlyFor("script_auto_share")));
    await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));
    await setSwitch("script_auto_share", true, JSON.stringify({ testClientsOnly: false }));
    faults.programAutomation = true;
    const fErr = await fto();
    faults.programAutomation = false;
    c.ok("a failed read → the locked ops read locked (a lock that cannot be read is on)", fErr.reminders && fErr.script_share_email && fErr.script_auto_share && fErr.review_auto_approve && !fErr.portal_invites);
    // REVIEW FIX (Sep 28): the SAME failure, kept apart for a send.
    faults.lockRead = true;
    const rErr = await R.readFeatureTestOnly("reminders");
    const rNo = await R.readFeatureTestOnly("portal_invites");
    const wErr = await R.programReachWithLock("reminders", T.id);
    faults.lockRead = false;
    c.ok("REVIEW FIX: readFeatureTestOnly keeps a failed lock read apart ('error'); an op with no lock reads nothing and is false", rErr === "error" && rNo === false, `${rErr} ${rNo}`);
    c.ok("REVIEW FIX: programReachWithLock on a failed lock read → scope_unreadable, never feature_test_only (even for T)", !wErr.ok && wErr.code === "scope_unreadable", JSON.stringify(wErr));
    c.ok("…and healthy, it reads the stored lock like featureTestOnlyFor (lifted → false)", (await R.readFeatureTestOnly("reminders")) === false && (await R.featureTestOnlyFor("reminders")) === false);

    // programAudience.
    await db.appSetting.create({ data: { key: "program-rollout", value: serializeProgramRollout(pilotRollout), updatedBy: OWNER } });
    const aud = await R.programAudience("reminders");
    const byName = new Map(aud.clients.map((x) => [x.name, x]));
    c.ok("programAudience lists ACTIVE and PAUSED programs, not ENDED", byName.has("Yolanda Paused Group") && !byName.has("Zed Ended Team") && aud.clients.length === 9, aud.clients.map((x) => x.name).join(", "));
    c.ok("… T and T2 TEST, P PILOT, X/Y/N refused not_in_pilot",
      byName.get(T.name)?.tier === "TEST" && byName.get("Rollout Two TEST")?.tier === "TEST" && byName.get(P.name)?.tier === "PILOT" &&
      [X.name, "Yolanda Paused Group", N.name].every((n) => byName.get(n)?.tier === null && (byName.get(n)?.decision as { code?: string }).code === "not_in_pilot"));
    c.ok("… the line names both TEST clients and the pilot, realClients true, mode PILOT",
      aud.realClients && aud.mode === "PILOT" && aud.pilotState === "ACTIVE" && aud.line.includes("Rollout TEST") && aud.line.includes("Rollout Two TEST") && aud.line.includes("pilot: Pat Pilot Realty") && !aud.line.includes(N.name), aud.line);
    c.ok("… TEST first, then PILOT, then the refused", aud.clients[0].tier === "TEST" && aud.clients[2].tier === "PILOT" && aud.clients.slice(3).every((x) => x.tier === null));
    faults.appSetting = true;
    const audErr = await R.programAudience("reminders");
    faults.appSetting = false;
    c.ok("programAudience never throws: an unreadable scope lists everyone scope_unreadable and says why",
      audErr.clients.length === 9 && audErr.clients.every((x) => !x.decision.ok && x.decision.code === "scope_unreadable") && !!audErr.problem && !audErr.realClients && audErr.line.includes("could not be read"));
    faults.client = true;
    const audErr2 = await R.programAudience("reminders");
    faults.client = false;
    c.ok("… and a failed client read gives an empty list with the problem, not a throw", audErr2.clients.length === 0 && !!audErr2.problem && !audErr2.realClients);

    const cands = await R.pilotClientCandidates();
    c.ok("pilotClientCandidates: real clients with an ACTIVE program only (N is real, so it is offered — the editor then says 'fix the name')",
      cands.map((x) => x.id).sort().join() === [P.id, X.id, N.id, "c_p2", "c_p3", "c_p4"].sort().join(), cands.map((x) => x.name).join(", "));

    const hubCfg = hub.parseHubWriteConfig({ authorizedFixtureClientIds: ["c_fix"], pilot: { clientIds: [X.id], operations: ["appointments.store"], approvedBy: "x", approvedAt: APPROVED } });
    const hw = await R.hubWriteScopeWithProgramPilot(hubCfg, "session_booking");
    c.ok("hubWriteScopeWithProgramPilot: the program pilot replaces the switch's list; fixtures kept", hw.problem === null && hw.config.pilot?.clientIds.join() === P.id && hw.config.pilot.operations.includes("appointments.store") && hw.config.authorizedFixtureClientIds.join() === "c_fix");
    faults.appSetting = true;
    const hwErr = await R.hubWriteScopeWithProgramPilot(hubCfg, "session_booking");
    faults.appSetting = false;
    c.ok("… on a read error: no pilot (nobody real written for), fixtures kept, the problem said", hwErr.config.pilot === null && hwErr.config.authorizedFixtureClientIds.join() === "c_fix" && !!hwErr.problem);
    await db.appSetting.delete({ where: { key: "program-rollout" } });
  }

  // =========================================================================
  c.head("8. updateProgramRollout — the one writer");
  {
    lockCalls.length = 0;
    const r1 = await R.updateProgramRollout(approvePilot([P.id]), OWNER, "program_rollout_pilot_add");
    const row1 = await storedRow();
    const a1 = await db.auditLog.findFirst({ where: { target: "program-rollout" }, orderBy: { createdAt: "desc" } });
    c.ok("approve P: ok, from TEST_ONLY to PILOT", r1.ok && r1.from.mode === "TEST_ONLY" && r1.to.mode === "PILOT");
    c.ok("… the advisory lock on 'program-rollout' was taken", lockCalls.join() === "program-rollout");
    c.ok("… AppSetting written with updatedBy", !!row1 && row1.updatedBy === OWNER && parseProgramRollout(row1.value).rollout.pilot?.clientIds.join() === P.id);
    c.ok("… AuditLog: actor, action, target, before -> after", !!a1 && a1.actor === OWNER && a1.action === "program_rollout_pilot_add" && a1.detail.includes('"mode":"TEST_ONLY"') && a1.detail.includes(' -> {"mode":"PILOT"'));
    c.ok("… joinedAt and modeSince stamped by the writer", r1.ok && !!r1.to.pilot?.joinedAt[P.id] && !!r1.to.modeSince);
    c.ok("… and programReach sees it on the very next call", (await R.programReach("reminders", P.id)).ok);

    const before = row1!.value;
    const nAudits = await audits();
    const refusals: [string, string[], string][] = [
      ["a TEST client", [P.id, T.id], "TEST client"],
      ["N, a real row renamed TEST", [P.id, N.id], "fix the name"],
      ["a client with no program", [P.id, "c_r"], "no ACTIVE program"],
      ["a PAUSED program", [P.id, "c_y"], "no ACTIVE program"],
      ["a client that does not exist", [P.id, "c_nobody"], "not found"],
      [`a ${PROGRAM_PILOT_MAX + 1}st real client`, [P.id, ...Array.from({ length: PROGRAM_PILOT_MAX }, (_, i) => `c_cap${i}`)], `cap is ${PROGRAM_PILOT_MAX}`],
    ];
    for (const [label, ids, why] of refusals) {
      const r = await R.updateProgramRollout((cur) => ({ ...cur, pilot: { ...cur.pilot!, clientIds: ids } }), OWNER, "program_rollout_pilot_add");
      c.ok(`refuses ${label}, writes nothing`, !r.ok && r.message.includes(why) && (await storedRow())?.value === before, r.ok ? "saved!" : r.message);
    }
    const e = await R.updateProgramRollout(() => ({ error: "Type the client's name exactly." }), OWNER, "x");
    c.ok("a mutate error is returned as the message, nothing written", !e.ok && e.message === "Type the client's name exactly." && (await storedRow())?.value === before);
    const forced = await R.updateProgramRollout((cur) => ({ ...cur, mode: "ALL" }), null as unknown as string, "x");
    c.ok("a failure after the AppSetting upsert (no actor for the audit row) rolls BOTH back", !forced.ok && (await storedRow())?.value === before && (await audits()) === nAudits, forced.ok ? "" : forced.message);
    c.ok("no refusal wrote an audit row", (await audits()) === nAudits);

    const r3 = await R.updateProgramRollout(approvePilot([P.id, "c_p2", "c_p3"]), OWNER, "program_rollout_pilot_add");
    c.ok("three real clients are allowed (the cap is inclusive)", r3.ok && r3.to.pilot?.clientIds.length === 3);
    const rm = await R.updateProgramRollout((cur) => ({ ...cur, pilot: { ...cur.pilot!, clientIds: cur.pilot!.clientIds.filter((id) => id !== P.id) } }), OWNER, "program_rollout_pilot_remove");
    c.ok("removing P: one write, P refused on the next decision, its joinedAt dropped", rm.ok && !(P.id in (rm.ok ? rm.to.pilot!.joinedAt : {})) && !(await R.programReach("reminders", P.id)).ok);

    await db.appSetting.update({ where: { key: "program-rollout" }, data: { value: "{bad" } });
    const nA = await audits();
    const ur = await R.updateProgramRollout(approvePilot([P.id]), OWNER, "program_rollout_pilot_add");
    c.ok("an unreadable stored value is NEVER overwritten", !ur.ok && ur.message.includes("could not be read") && (await storedRow())?.value === "{bad" && (await audits()) === nA, ur.ok ? "" : ur.message);
    await db.appSetting.delete({ where: { key: "program-rollout" } });
  }

  // =========================================================================
  c.head("9. programDispatchGate");
  {
    await R.updateProgramRollout(approvePilot([P.id]), OWNER, "program_rollout_pilot_add");
    for (const k of ["reminders", "script_share_email", "program_message_notice", "portal_invites", "portal_login_email"]) {
      const existing = await db.programAutomation.findUnique({ where: { key: k } });
      await setSwitch(k, true, existing?.configJson ?? null);
    }
    await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));
    let n = 0;
    const row = (key: string, clientId: string | null, toRef: string, channel = "email") => ({
      id: `o${++n}`, channel, toRef, body: "b", state: "pending", attempts: 0, leaseUntil: null, leaseBy: null, providerId: null, providerError: null,
      dedupeKey: key, requestedBy: "drill", clientId, projectId: null, taskId: null, createdAt: new Date(), acceptedAt: null, resolvedAt: null, extraToRefsJson: null, mediaUrlsJson: null,
    });
    const gate = (r: ReturnType<typeof row>) => G.programDispatchGate(r);
    const code = (v: Awaited<ReturnType<typeof gate>>) => (v.ok ? "ok" : v.code);
    const rem = (clientId: string | null, to: string) => row(`program_reminder:PLANNING_NUDGE:r${n}:2026-10`, clientId, to);

    c.ok("program_reminder: T at a verified inbox → sent", code(await gate(rem(T.id, "info+rt@realtourpilot.com"))) === "ok");
    c.ok("program_reminder: T2 at a colleague's inbox → test_client_real_address", code(await gate(rem("c_t2", "nick@realtourpilot.com"))) === "test_client_real_address");
    c.ok("program_reminder: P (pilot) → sent", code(await gate(rem(P.id, "pat@example.test"))) === "ok");
    c.ok("program_reminder: X → not_in_rollout_scope", code(await gate(rem(X.id, "xo@example.test"))) === "not_in_rollout_scope");
    c.ok("program_reminder: N (real row renamed TEST) at Jordan's inbox → not_in_rollout_scope, not the TEST pass", code(await gate(rem(N.id, "info@realtourpilot.com"))) === "not_in_rollout_scope");
    c.ok("a program row with no clientId → refused", code(await gate(rem(null, "pat@example.test"))) === "not_in_rollout_scope");
    c.ok("script_share / strategy_ready: P sent, X refused", code(await gate(row(`script_share:r${n}`, P.id, "pat@example.test"))) === "ok" && code(await gate(row(`strategy_ready:r${n}`, X.id, "xo@example.test"))) === "not_in_rollout_scope");
    c.ok("program_message: P sent", code(await gate(row(`program_message:e1:${n}`, P.id, "pat@example.test"))) === "ok");

    await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: true }));
    c.ok("the reminders lock back on → P launch_not_authorised, T still sent", code(await gate(rem(P.id, "pat@example.test"))) === "launch_not_authorised" && code(await gate(rem(T.id, "info+rt@realtourpilot.com"))) === "ok");
    await setSwitch("reminders", false, JSON.stringify({ testClientsOnly: false }));
    c.ok("reminders switched off → switched_off, for T too", code(await gate(rem(P.id, "pat@example.test"))) === "switched_off" && code(await gate(rem(T.id, "info+rt@realtourpilot.com"))) === "switched_off");
    await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));

    // Portal invitations.
    const inv = (seatKey: string, clientId: string, to: string, welcome = false) =>
      row(welcome ? `portal_invite:${seats[seatKey]}:welcome` : `portal_invite:${seats[seatKey]}:${new Date().toISOString()}`, clientId, to);
    c.ok("portal_invite to P's seat → sent; to X's seat → not_in_rollout_scope",
      code(await gate(inv(`pat@${P.id}`, P.id, "pat@example.test"))) === "ok" && code(await gate(inv(`xo@${X.id}`, X.id, "xo@example.test"))) === "not_in_rollout_scope");
    c.ok("portal_invite naming X's seat on a row for P → seat_mismatch", code(await gate(inv(`xo@${X.id}`, P.id, "xo@example.test"))) === "seat_mismatch");
    c.ok("portal_invite to an address that is not the seat holder's → seat_mismatch", code(await gate(inv(`pat@${P.id}`, P.id, "someone@example.test"))) === "seat_mismatch");
    await setSwitch("portal_invites", false);
    c.ok("invitations OFF: T's welcome at a verified inbox still goes (Jordan emailing himself)", code(await gate(inv(`tOwner@${T.id}`, T.id, "info+rt@realtourpilot.com", true))) === "ok");
    c.ok("invitations OFF: a re-invitation to T (not a welcome) → switched_off; P's welcome → switched_off; T2's welcome at nick@ → switched_off",
      code(await gate(inv(`tOwner@${T.id}`, T.id, "info+rt@realtourpilot.com"))) === "switched_off" &&
      code(await gate(inv(`pat@${P.id}`, P.id, "pat@example.test", true))) === "switched_off" &&
      code(await gate(inv(`t2Owner@c_t2`, "c_t2", "nick@realtourpilot.com", true))) === "switched_off");
    await setSwitch("portal_invites", true);
    await db.clientMembership.update({ where: { id: seats[`pat@${P.id}`] }, data: { revokedAt: new Date() } });
    c.ok("a revoked seat → seat_mismatch", code(await gate(inv(`pat@${P.id}`, P.id, "pat@example.test"))) === "seat_mismatch");
    await db.clientMembership.update({ where: { id: seats[`pat@${P.id}`] }, data: { revokedAt: null } });

    // Sign-in links.
    const login = (who: string, to: string) => row(`portal_login:${people[who]}:${new Date().toISOString()}`, null, to);
    c.ok("portal_login: Q (seats on P and X) → sent because of P", code(await gate(login("q", "q@example.test"))) === "ok");
    c.ok("portal_login: a person seated only on X → not_in_rollout_scope", code(await gate(login("xo", "xo@example.test"))) === "not_in_rollout_scope");
    c.ok("portal_login: T's owner at a verified inbox → sent; T2's at nick@ → test_client_real_address",
      code(await gate(login("tOwner", "info+rt@realtourpilot.com"))) === "ok" && code(await gate(login("t2Owner", "nick@realtourpilot.com"))) === "test_client_real_address");
    c.ok("portal_login to an address that is not the account's → seat_mismatch", code(await gate(login("pat", "q@example.test"))) === "seat_mismatch");
    await db.clientUser.update({ where: { id: people.pat }, data: { status: "DISABLED" } });
    c.ok("portal_login for a DISABLED person → seat_mismatch", code(await gate(login("pat", "pat@example.test"))) === "seat_mismatch");
    await db.clientUser.update({ where: { id: people.pat }, data: { status: "ACTIVE" } });
    await setSwitch("portal_login_email", false);
    c.ok("portal_login_email OFF → switched_off", code(await gate(login("q", "q@example.test"))) === "switched_off");
    await setSwitch("portal_login_email", true);

    // Removal takes effect at the next send.
    const queued = rem(P.id, "pat@example.test");
    c.ok("(a P reminder queued while P is in the pilot passes)", code(await gate(queued)) === "ok");
    await R.updateProgramRollout((cur) => ({ ...cur, pilot: { ...cur.pilot!, clientIds: [] } }), OWNER, "program_rollout_pilot_remove");
    c.ok("P removed → the SAME queued row is refused at dispatch, and Q's sign-in link too", code(await gate(queued)) === "not_in_rollout_scope" && code(await gate(login("q", "q@example.test"))) === "not_in_rollout_scope");

    // Other kinds: nothing to say, and nothing read.
    reads.clear();
    const other = await gate(row("delivery:proj1", X.id, "+12155550100", "sms"));
    c.ok("a non-rollout kind → ok with ZERO database reads", other.ok && countReads() === 0, JSON.stringify([...reads]));
  }

  // =========================================================================
  c.head("10. Fail closed");
  {
    await R.updateProgramRollout(approvePilot([P.id]), OWNER, "program_rollout_pilot_add");
    const row = (key: string, clientId: string | null, toRef: string) => ({
      id: "f", channel: "email", toRef, body: "b", state: "pending", attempts: 0, leaseUntil: null, leaseBy: null, providerId: null, providerError: null,
      dedupeKey: key, requestedBy: "drill", clientId, projectId: null, taskId: null, createdAt: new Date(), acceptedAt: null, resolvedAt: null, extraToRefsJson: null, mediaUrlsJson: null,
    });
    const pRow = row("program_reminder:X:r1:2026-10", P.id, "pat@example.test");
    const tRow = row("program_reminder:X:r2:2026-10", T.id, "info+rt@realtourpilot.com");
    await db.appSetting.update({ where: { key: "program-rollout" }, data: { value: "{bad" } });
    const vp = await G.programDispatchGate(pRow);
    const vt = await G.programDispatchGate(tRow);
    c.ok("'{bad' stored: P refused (not_in_rollout_scope, reason names the problem); T still sent", !vp.ok && vp.code === "not_in_rollout_scope" && vp.reason.includes("could not be read") && vt.ok, vp.ok ? "" : vp.reason);
    await db.appSetting.delete({ where: { key: "program-rollout" } });
    await R.updateProgramRollout(approvePilot([P.id]), OWNER, "program_rollout_pilot_add");
    faults.appSetting = true;
    const va = await G.programDispatchGate(pRow);
    faults.appSetting = false;
    c.ok("the scope unreadable (DB error) → gate_error: nothing sent, safe to try later", !va.ok && va.code === "gate_error");
    faults.client = true;
    const vc = await G.programDispatchGate(tRow);
    faults.client = false;
    c.ok("a client-read error inside the gate → gate_error (never a throw), even for T", !vc.ok && vc.code === "gate_error");
    faults.programAutomation = true;
    const vs = await G.programDispatchGate(pRow);
    faults.programAutomation = false;
    c.ok("a switch-read error → gate_error", !vs.ok && vs.code === "gate_error");
    // REVIEW FIX (Sep 28): the reminders LOCK alone cannot be read (a blip on
    // the config read; the switch reads fine). It used to come out as
    // "the lock is on" → launch_not_authorised, a decision recordSendResult
    // suppresses for good, with a false reason.
    await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));
    c.ok("(healthy: P's reminder passes with the lock lifted)", (await G.programDispatchGate(pRow)).ok);
    faults.lockRead = true;
    const vl = await G.programDispatchGate(pRow);
    const oldView = await R.featureTestOnlyFor("reminders");
    faults.lockRead = false;
    c.ok("REVIEW FIX: a failed LOCK read → gate_error (retry later), not launch_not_authorised", !vl.ok && vl.code === "gate_error", JSON.stringify(vl));
    c.ok("…the frozen featureTestOnlyFor still folds that failure into 'locked' (readiness/preview), which is what the gate used to pass on", oldView === true);
    c.ok("and with the reads healthy again, P is sent", (await G.programDispatchGate(pRow)).ok);
  }

  // =========================================================================
  c.head("12. Per-client choices (Oct 5 2026): clientOps, back-compatible, per client everywhere");
  {
    const { setClientOpsChange, clientAllowedOps, pilotOpsFor } = core;
    const Q = { id: "c_q2", name: "Quinn Shared Realty" };
    const own = (ops: Record<string, Op[]>, ids = [P.id, X.id, Q.id], extra: Partial<NonNullable<Rollout["pilot"]>> = {}): Rollout => ({
      mode: "PILOT", modeSince: APPROVED,
      pilot: { ...pilotOf("active", ids, ALL_GROUP_OPS)!, joinedAt: Object.fromEntries(ids.map((id) => [id, JOINED])), clientOps: ops, ...extra },
    });
    // P: reminders only. X: listed with NOTHING. Q: no entry → the shared list (every group).
    const r = own({ [P.id]: ["reminders"], [X.id]: [] });
    const ok = (cl: { id: string; name: string }, op: Op) => rolloutDecision({ rollout: r, client: cl, op, now: NOW });
    c.ok("P (own list: reminders) is reached for reminders and nothing else",
      ok(P, "reminders").ok && PROGRAM_REACH_OPS.filter((o) => o !== "reminders").every((o) => { const d = ok(P, o); return !d.ok && d.code === "operation_not_in_pilot"; }));
    c.ok("X (listed, own list EMPTY) is reached for nothing", PROGRAM_REACH_OPS.every((o) => { const d = ok(X, o); return !d.ok && d.code === "operation_not_in_pilot"; }));
    c.ok("Q (listed, no entry) keeps the shared list: every grouped op, never publishing",
      ALL_GROUP_OPS.every((o) => ok(Q, o).ok) && !ok(Q, "publishing").ok);
    c.ok("T is reached for everything whatever the lists say; an unlisted real client for nothing",
      PROGRAM_REACH_OPS.every((o) => ok(T, o).ok) && PROGRAM_REACH_OPS.every((o) => !ok({ id: "c_unlisted", name: "Una Listed" }, o).ok));
    c.ok("pilotOpsFor / clientAllowedOps read the client's own list, else the shared one, else nothing",
      pilotOpsFor(r.pilot!, P.id).join() === "reminders" && pilotOpsFor(r.pilot!, X.id).length === 0 && pilotOpsFor(r.pilot!, Q.id).join() === ALL_GROUP_OPS.join() &&
      clientAllowedOps(r, P).join() === "reminders" && clientAllowedOps(r, { id: "c_unlisted", name: "Una Listed" }).length === 0 && clientAllowedOps(r, T).length === ALL_GROUP_OPS.length);
    c.ok("a per-client publishing entry is dropped (publishing is never a pilot op)", parseProgramRollout(JSON.stringify({ mode: "PILOT", pilot: { clientIds: [P.id], operations: [], clientOps: { [P.id]: ["publishing", "reminders"] } } })).rollout.pilot?.clientOps?.[P.id].join() === "reminders");

    // rolloutClientFilter ≡ rolloutDecision, per client, over many lists.
    let bad = 0, combos = 0;
    const lists: Op[][] = [[], ["reminders"], ["portal_sign_in", "hub_writes"], opsForGroups(["portal_changes"]), ALL_GROUP_OPS];
    for (const lp of lists) for (const lx of lists) for (const shared of [[] as Op[], ALL_GROUP_OPS]) for (const op of PROGRAM_REACH_OPS) for (const fto of [false, true]) {
      combos++;
      const rr: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: { ...pilotOf("active", [P.id, X.id, Q.id], shared)!, clientOps: { [P.id]: lp, [X.id]: lx } } };
      const f = rolloutClientFilter({ rollout: rr, op, now: NOW, featureTestOnly: fto });
      for (const cl of [P, X, Q]) if ((f.everyone || f.realClientIds.includes(cl.id)) !== rolloutDecision({ rollout: rr, client: cl, op, now: NOW, featureTestOnly: fto }).ok) bad++;
    }
    c.ok(`rolloutClientFilter ≡ rolloutDecision for every client's own list (${combos} combinations × 3 clients)`, bad === 0, String(bad));
    c.ok("clientTier: an own EMPTY list is REAL (named, but given nothing); own non-empty and shared are PILOT",
      clientTier(r, X, NOW) === "REAL" && clientTier(r, P, NOW) === "PILOT" && clientTier(r, Q, NOW) === "PILOT");

    // The hub-write pilot, per client.
    const rb = own({ [P.id]: ["reminders"], [X.id]: ["hub_writes"] }, [P.id, X.id]);
    const routeOf = (rr: Rollout, cl: { id: string; name: string }) =>
      hub.routeHubWrite({ switchKey: "session_booking", config: withProgramPilot({ authorizedFixtureClientIds: [], pilot: null }, rr, "session_booking"), client: cl, operation: "appointments.store", now: NOW, isTestName: tc.isTestClientName, isNeverSynthetic: tc.isNeverSyntheticClientId }).kind;
    c.ok("hub writes: only the client whose own list has bookings is written for (X yes, P no)", routeOf(rb, X) === "PILOT" && routeOf(rb, P) === "REFUSE" && programPilotAsHubPilot(rb, "session_booking")?.clientIds.join() === X.id);
    const rnone = own({ [P.id]: ["reminders"], [X.id]: [] }, [P.id, X.id]);
    const hn = programPilotAsHubPilot(rnone, "session_booking");
    c.ok("…nobody booked: the named list with NO operations, so the refusal still says 'does not include bookings'",
      !!hn && hn.operations.length === 0 && hn.clientIds.length === 2 && !!hub.pilotProblem("session_booking", hn, P.id, "orders.create", NOW)?.includes("does not include bookings"));
    c.ok("clientReachSummary: bookings only for the booked client", core.clientReachSummary(rb, X, NOW).groups.includes("bookings") && !core.clientReachSummary(rb, P, NOW).groups.includes("bookings") && core.clientReachSummary(rb, P, NOW).groups.join() === "emails");

    // The scope line names only the clients an op reaches.
    const names = new Map([[P.id, P.name], [X.id, X.name], [Q.id, Q.name]]);
    const line = (rr: Rollout, op: Op) => describeProgramScope({ rollout: rr, op, featureTestOnly: false, testNames: ["Rollout TEST"], names, now: NOW });
    const lr = line(r, "reminders");
    c.ok("describeProgramScope: reminders names P and Q (shared), never X", lr.realClients && lr.line.includes(P.name) && lr.line.includes(Q.name) && !lr.line.includes(X.name) && lr.pilotNames.join() === `${P.name},${Q.name}`, lr.line);
    const lnone = line(own({ [P.id]: ["reminders"], [X.id]: [] }, [P.id, X.id]), "portal_layout_v2");
    c.ok("…an op nobody has: TEST only, 'no named client has … turned on'", !lnone.realClients && lnone.line.includes("no named client has") && !/every client/i.test(lnone.line), lnone.line);

    // parse / serialize.
    const legacy = serializeProgramRollout({ mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [P.id], ALL_GROUP_OPS) });
    c.ok("BACK-COMPAT: a value with no per-client choices serializes byte-for-byte as before (no new keys)", !legacy.includes("clientOps") && serializeProgramRollout(parseProgramRollout(legacy).rollout) === legacy);
    const withOwn = { ...r, pilot: { ...r.pilot!, clientOpsSince: { [P.id]: { reminders: JOINED } } } };
    const sOwn = serializeProgramRollout(withOwn);
    const pOwn = parseProgramRollout(sOwn);
    c.ok("per-client choices round-trip byte-stable (clientOps + clientOpsSince)", pOwn.problem === null && serializeProgramRollout(pOwn.rollout) === sOwn && pOwn.rollout.pilot?.clientOps?.[X.id]?.length === 0 && pOwn.rollout.pilot?.clientOpsSince?.[P.id]?.reminders === JOINED);
    const tol = parseProgramRollout(JSON.stringify({ mode: "PILOT", pilot: { clientIds: [P.id, X.id], operations: ALL_GROUP_OPS, clientOps: { [P.id]: "reminders", [X.id]: ["reminders", "bogus", "reminders"], c_gone: ["reminders"] }, clientOpsSince: { [X.id]: { reminders: "soon", portal_invites: JOINED } } } }));
    c.ok("tolerant read: a malformed entry is NOTHING for that client (never the shared list); junk dropped; entries for unlisted clients dropped; since kept only for held ops with real dates",
      tol.problem === null && tol.rollout.pilot?.clientOps?.[P.id]?.length === 0 && tol.rollout.pilot?.clientOps?.[X.id]?.join() === "reminders" && !("c_gone" in (tol.rollout.pilot?.clientOps ?? {})) && !tol.rollout.pilot?.clientOpsSince,
      JSON.stringify(tol.rollout.pilot));
    const garbled = parseProgramRollout(JSON.stringify({ mode: "PILOT", pilot: { clientIds: [P.id], operations: ALL_GROUP_OPS, clientOps: ["reminders"] } }));
    c.ok("a per-client value that is not an object is UNREADABLE (TEST only + problem), never 'absent' (which would widen)", garbled.rollout.mode === "TEST_ONLY" && !!garbled.problem?.includes("per-client choices"), garbled.problem ?? "");
    c.ok("an empty clientOps object reads as absent (everyone on the shared list)", !parseProgramRollout(JSON.stringify({ mode: "PILOT", pilot: { clientIds: [P.id], operations: ["reminders"], clientOps: {} } })).rollout.pilot?.clientOps);

    // settle: since per client, per op.
    const t0 = NOW, t1 = new Date(NOW.getTime() + 2 * DAY), t2 = new Date(NOW.getTime() + 4 * DAY);
    const s0 = settleRolloutChange({ ...CLOSED_ROLLOUT }, { mode: "PILOT", modeSince: null, pilot: { clientIds: [P.id, Q.id], operations: opsForGroups(["emails"]), approvedBy: OWNER_EMAIL, approvedAt: iso(t0.getTime()), expiresAt: null, note: null, joinedAt: {}, clientOps: { [P.id]: ["reminders"] } } }, t0);
    const r0 = (s0 as { rollout: Rollout }).rollout;
    c.ok("settle: a new client's own ops start at the change (clientOpsSince = now)", r0.pilot?.clientOpsSince?.[P.id]?.reminders === iso(t0.getTime()) && r0.pilot?.joinedAt[P.id] === iso(t0.getTime()));
    const s1 = settleRolloutChange(r0, { ...r0, pilot: { ...r0.pilot!, clientOps: { [P.id]: ["reminders", "revision_policy"], [Q.id]: ["reminders", "portal_sign_in"] } } }, t1);
    const r1 = (s1 as { rollout: Rollout }).rollout;
    const sinceOf = (rr: Rollout, cl: { id: string; name: string }, op: Op, at: Date) => { const d = rolloutDecision({ rollout: rr, client: cl, op, now: at }); return d.ok ? d.since?.toISOString() ?? null : `refused ${d.code}`; };
    c.ok("settle: P keeps reminders' start; review deadlines (newly on) start at the change",
      sinceOf(r1, P, "reminders", t2) === iso(t0.getTime()) && sinceOf(r1, P, "revision_policy", t2) === iso(t1.getTime()), `${sinceOf(r1, P, "reminders", t2)} · ${sinceOf(r1, P, "revision_policy", t2)}`);
    c.ok("settle: Q moving from the shared list to their own keeps the shared start for what they had (reminders), and starts the new op now",
      sinceOf(r1, Q, "reminders", t2) === iso(t0.getTime()) && sinceOf(r1, Q, "portal_sign_in", t2) === iso(t1.getTime()), `${sinceOf(r1, Q, "reminders", t2)} · ${sinceOf(r1, Q, "portal_sign_in", t2)}`);
    const s2 = settleRolloutChange(r1, { ...r1, pilot: { ...r1.pilot!, clientOps: { ...r1.pilot!.clientOps!, [P.id]: ["revision_policy"] } } }, t2);
    const s3 = settleRolloutChange((s2 as { rollout: Rollout }).rollout, { ...(s2 as { rollout: Rollout }).rollout, pilot: { ...(s2 as { rollout: Rollout }).rollout.pilot!, clientOps: { ...r1.pilot!.clientOps!, [P.id]: ["revision_policy", "reminders"] } } }, new Date(t2.getTime() + DAY));
    c.ok("settle: an op turned off and on again restarts (no backlog from the gap)", sinceOf((s3 as { rollout: Rollout }).rollout, P, "reminders", new Date(t2.getTime() + 2 * DAY)) === iso(t2.getTime() + DAY));
    c.ok("settle: the cap still holds with per-client lists", "error" in settleRolloutChange(r1, { ...r1, pilot: { ...r1.pilot!, clientIds: Array.from({ length: PROGRAM_PILOT_MAX + 1 }, (_, i) => `c${i}`) } }, t2));

    // setClientOpsChange — the onboarding page's one change.
    const by = OWNER_EMAIL;
    const fresh = setClientOpsChange({ ...CLOSED_ROLLOUT }, { client: P, ops: ["reminders"], by, now: NOW }) as Rollout;
    c.ok("first turn-on from TEST clients only: mode PILOT, P listed with their own list, approval stamped", fresh.mode === "PILOT" && fresh.pilot?.clientIds.join() === P.id && fresh.pilot?.clientOps?.[P.id]?.join() === "reminders" && fresh.pilot?.approvedBy === by && fresh.pilot?.operations.length === 0);
    const oldOnFile: Rollout = { mode: "TEST_ONLY", modeSince: null, pilot: pilotOf("active", [X.id, Q.id], ALL_GROUP_OPS) };
    // Oct 5 2026 review fix: an old list on file is no longer pinned silently —
    // the change is refused, naming them, unless the owner asks for P only.
    const refusedFlip = setClientOpsChange(oldOnFile, { client: P, ops: ["reminders"], by, now: NOW });
    c.ok("NOBODY ELSE WIDENED: an old list on file under TEST only REFUSES the page's turn-on, naming X and Q",
      "error" in refusedFlip && refusedFlip.othersOnFile?.join() === [X.id, Q.id].join(), JSON.stringify(refusedFlip));
    const flip = setClientOpsChange(oldOnFile, { client: P, ops: ["reminders"], by, now: NOW, onlyThisClient: true }) as Rollout;
    c.ok("…'only this client': X and Q set to nothing, only P reached",
      flip.mode === "PILOT" && flip.pilot?.clientOps?.[X.id]?.length === 0 && flip.pilot?.clientOps?.[Q.id]?.length === 0 &&
      !rolloutDecision({ rollout: flip, client: X, op: "reminders", now: NOW }).ok && !rolloutDecision({ rollout: flip, client: Q, op: "portal_sign_in", now: NOW }).ok && rolloutDecision({ rollout: flip, client: P, op: "reminders", now: NOW }).ok);
    const unapproved: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("unapproved", [X.id], ALL_GROUP_OPS) };
    const reapRefused = setClientOpsChange(unapproved, { client: P, ops: ["reminders"], by, now: NOW });
    const reap = setClientOpsChange(unapproved, { client: P, ops: ["reminders"], by, now: NOW, onlyThisClient: true }) as Rollout;
    c.ok("…and an UNAPPROVED list the page's approval would switch on: refused naming X; for P only, X set to nothing", "error" in reapRefused && reapRefused.othersOnFile?.join() === X.id && !rolloutDecision({ rollout: reap, client: X, op: "reminders", now: NOW }).ok && rolloutDecision({ rollout: reap, client: P, op: "reminders", now: NOW }).ok);
    const live: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: pilotOf("active", [X.id], ALL_GROUP_OPS) };
    const addP = setClientOpsChange(live, { client: P, ops: ["reminders"], by, now: NOW }) as Rollout;
    c.ok("an ACTIVE list: the others keep exactly what they had (X still on the shared list)", !("clientOps" in addP.pilot! && X.id in (addP.pilot!.clientOps ?? {})) && rolloutDecision({ rollout: addP, client: X, op: "portal_sign_in", now: NOW }).ok);
    const narrow = setClientOpsChange(addP, { client: P, ops: [], by: "someone@else", now: new Date(NOW.getTime() + DAY) }) as Rollout;
    c.ok("taking everything off: P leaves the list, the approval is NOT re-stamped, the mode is kept", !narrow.pilot?.clientIds.includes(P.id) && narrow.pilot?.approvedBy === by && narrow.mode === "PILOT");
    const onlyP = setClientOpsChange(fresh, { client: P, ops: [], by, now: NOW }) as Rollout;
    c.ok("…and when P was the only one, the list is removed (mode kept)", onlyP.pilot === null && onlyP.mode === "PILOT");
    const expired: Rollout = { mode: "PILOT", modeSince: APPROVED, pilot: { ...pilotOf("expired", [X.id], ALL_GROUP_OPS)! } };
    const ex = setClientOpsChange(expired, { client: P, ops: ["reminders"], by, now: NOW });
    const exNarrow = setClientOpsChange({ ...expired, pilot: { ...expired.pilot!, clientIds: [X.id, P.id], clientOps: { [P.id]: ["reminders"] } } }, { client: P, ops: [], by, now: NOW });
    c.ok("allowing something on an ENDED list is refused (it would restart everyone); taking things away is fine", "error" in ex && ex.error.includes("ended after") && !("error" in exNarrow));
    const allMode: Rollout = { mode: "ALL", modeSince: APPROVED, pilot: null };
    c.ok("'every client' is left alone (never narrowed or widened by the page)", (setClientOpsChange(allMode, { client: P, ops: ["hub_writes"], by, now: NOW }) as Rollout).mode === "ALL");
    c.ok("a TEST client and N are refused (TEST clients are always reached; N must fix the name)",
      "error" in setClientOpsChange(fresh, { client: T, ops: ["reminders"], by, now: NOW }) && "error" in setClientOpsChange(fresh, { client: N, ops: ["reminders"], by, now: NOW }));
    c.ok("unknown ops and publishing are dropped from the client's list", (setClientOpsChange({ ...CLOSED_ROLLOUT }, { client: P, ops: ["publishing", "reminders", "bogus" as Op], by, now: NOW }) as Rollout).pilot?.clientOps?.[P.id]?.join() === "reminders");

    // Through the writer and the gate (the database part).
    await db.appSetting.deleteMany({ where: { key: "program-rollout" } });
    const w1 = await R.updateProgramRollout((cur, now) => setClientOpsChange(cur, { client: P, ops: ["reminders", "portal_invites"], by, now }), by, "client_onboarding_toggle");
    c.ok("through updateProgramRollout: saved, audited, mode PILOT, P's own list stamped", w1.ok && w1.to.mode === "PILOT" && w1.to.pilot?.clientOps?.[P.id]?.join() === "reminders,portal_invites" && !!w1.to.pilot?.clientOpsSince?.[P.id]?.reminders &&
      (await db.auditLog.count({ where: { action: "client_onboarding_toggle", target: "program-rollout" } })) === 1);
    c.ok("programReach: P reminders yes, P layout no, X nothing", (await R.programReach("reminders", P.id)).ok && !(await R.programReach("portal_layout_v2", P.id)).ok && !(await R.programReach("reminders", X.id)).ok);
    const gRow = (key: string, clientId: string, toRef: string) => ({
      id: "g12", channel: "email", toRef, body: "b", state: "pending", attempts: 0, leaseUntil: null, leaseBy: null, providerId: null, providerError: null,
      dedupeKey: key, requestedBy: "drill", clientId, projectId: null, taskId: null, createdAt: new Date(), acceptedAt: null, resolvedAt: null, extraToRefsJson: null, mediaUrlsJson: null,
    });
    await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));
    await setSwitch("program_message_notice", true);
    c.ok("the dispatch gate reads P's own list: a reminder passes, an office-replied notice is refused", (await G.programDispatchGate(gRow("program_reminder:X:r12:2026-10", P.id, "pat@example.test"))).ok &&
      (await G.programDispatchGate(gRow("program_message:e12:1", P.id, "pat@example.test"))).ok === false);
    const sweep = await R.rolloutSweepClientIds("reminders");
    c.ok("a sweep's prefilter for reminders: the TEST clients and P, never X", !!sweep && sweep.includes(P.id) && !sweep.includes(X.id) && sweep.includes(T.id));
    await db.appSetting.deleteMany({ where: { key: "program-rollout" } });
  }

  // =========================================================================
  if (drill.engine === "postgres") {
    c.head("11. Two owners saving at once (real Postgres): the advisory lock loses nothing");
    await R.updateProgramRollout((cur) => ({ ...cur, pilot: { ...cur.pilot!, clientIds: [] } }), OWNER, "reset");
    const add = (id: string) => R.updateProgramRollout((cur, now) => ({
      ...cur, mode: "PILOT",
      pilot: { clientIds: [...(cur.pilot?.clientIds ?? []), id], operations: ALL_GROUP_OPS, approvedBy: OWNER, approvedAt: now.toISOString(), expiresAt: null, note: null, joinedAt: {} },
    }), OWNER, "program_rollout_pilot_add");
    const round = async () => {
      await R.updateProgramRollout((cur) => ({ ...cur, pilot: { ...cur.pilot!, clientIds: [] } }), OWNER, "reset");
      const { result, distinctBackends } = await drill.backendsDuring(() => Promise.all([add(P.id), add("c_p2"), add("c_p3")]));
      const final = parseProgramRollout((await storedRow())!.value).rollout;
      return { ok: result.every((r) => r.ok), kept: final.pilot?.clientIds.length ?? 0, distinctBackends };
    };
    // The fix bypassed: the same three saves without the lock. Read-modify-
    // write under READ COMMITTED loses whichever change committed first.
    bypassLock = true;
    const bypassed = [];
    for (let i = 0; i < 5; i++) bypassed.push(await round());
    bypassLock = false;
    c.ok("WITHOUT the lock (fix bypassed), concurrent saves drop each other's change", bypassed.some((b) => b.kept < 3), bypassed.map((b) => `kept ${b.kept}/3 on ${b.distinctBackends} backends`).join("; "));
    const locked = [];
    for (let i = 0; i < 5; i++) locked.push(await round());
    c.ok("WITH the lock, three concurrent adds all land in every round", locked.every((b) => b.ok && b.kept === 3), locked.map((b) => `kept ${b.kept}/3 on ${b.distinctBackends} backends`).join("; "));
  } else {
    console.log("\n(11. concurrency runs under DRILL_ENGINE=postgres — PGlite is one session)");
  }

  c.ok("the fence blocked nothing (no provider was contacted)", fence.blocked.length === 0, fence.blocked.join(", "));
  console.log(`\n${await drill.evidence()}`);
  quiet.restore();
  fence.restore();
  c.summary();
  await drill.stop();
  fs.rmSync(baseDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
