// @drill-run: needs=tools/realpg timeout=900
// ---------------------------------------------------------------------------
// DRILL: R04 — a client's change request against the review window's expiry,
// on REAL Postgres (batch 6, Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/realpg-revision-expiry.ts
//
// Needs `npm install --prefix tools/realpg` once. DRILL_K=n sets the
// iterations per deadline offset (default 30).
//
// WHY REAL POSTGRES. The review window is the referee (reviewWindows.claimWindow,
// a compare-and-set): approve, request and expiry each take it. cp02 §8 proved
// approve vs request 10/10 — but on PGlite, one session, where two single-
// statement compare-and-sets are all that CAN interleave. What had never run:
// two sweepers in separate processes; the sweep against the request's
// multi-statement path (decision → pointer → round → give-back); a staff
// reopen against the sweep; a failed automatic approval against a request.
// Here every racer holds its own backend, the second sweeper is its own Node
// process on its own pool, and the barrier releases them together.
//
// WHAT IT PROVES (invariants checked after every caller has returned):
//   1. K iterations at each of Δ = −50, 0, +50 ms (deadlineAt = now + Δ): the
//      client's request, the client's approve, a sweep in this process and a
//      sweep in a child process, released at once, the sweeps at deadline+1 ms
//      (starting 0–30 ms after the barrier, by iteration, so they meet the
//      request's multi-statement path at every step, not only at its start;
//      on odd iterations the approve starts 60 ms late, or — the shortest
//      path — it would win every race the sweeps do not).
//        · exactly one live decision per cut, and the window says that one;
//        · a change request is 1 round, 1 brief, the job's 1 revision card;
//        · an automatic approval has its pointer, evidence, outcome and basis,
//          no round — and "approved automatically" (Activity, bell) only then;
//        · a request stamped after the deadline is refused and writes nothing;
//        · the cut's and the video's approval caches agree with the decision;
//        · no window is processed by both sweepers; ≤ 1 expiry task.
//   2. (a) auto-approval OFF, a real client: the sweep records MANUAL once and
//      files ONE task; a request stamped before the deadline still wins — and
//      then the office is not left holding a "no answer" task for it (OLD
//      clientDecisions first).
//   3. (b) the automatic approval does not save (the database refuses its row,
//      in both processes): the window goes back OPEN, the office gets it once,
//      a late request is still refused; a late approval afterwards closes the
//      office's task (OLD first).
//   4. (c) a staff reopen against the sweep: never an approval and an open
//      request both live — naturally, then with the sweep held between its
//      claim and its approval row (the interleaving forced, OLD code first).
//   5. (d) a client's press against the same in-flight automatic approval:
//      the window, the decision's basis and the "approved automatically"
//      records agree (OLD code first).
//
// THE CLOCK. Every instant the code compares is pinned relative to the
// iteration's own start: deadlineAt = t0 + Δ, the sweeps' `now` = deadline +
// 1 ms, the switches' enabledAt = t0 − 1 h. The wall clock itself is NOT
// shifted: the query engine stamps createdAt/updatedAt/decidedAt with the real
// clock, and a race drill has to compare like with like. The one calendar
// computation (endOfBusinessDaysET at release) is overwritten before each
// race, so nothing depends on the day or the hour this runs.
//
// THE SEAM IS IN THE DATABASE. autoApprove reaches the approval row through
// `await import("@/lib/clientDecisions")`, and interceptModule cannot wrap a
// module reached through import() — measured: Node's ESM translator calls
// Module._load but snapshots the real exports, not the wrapper. So a trigger
// on ClientDecision acts on AUTO_EXPIRY rows for the cuts listed in
// drill_seam: 'fail' refuses the row (variant b), 'hold' makes the insert wait
// on an advisory lock the drill holds (c, d) — Postgres itself holding the
// sweep between its claim and its row, visible in pg_locks.
//
// ISOLATION. A disposable Postgres 18 on 127.0.0.1:5877 (tools/realpg); the
// parent and the child are both pinned to it and fenced; the model is refused
// at its one seam; nothing is sent, billed or paid. OLD code is 3de6023.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  attachDrillChild, bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors,
  type Checker, type DrillChild,
} from "./_harness";
import { barrier } from "../_fixtures/barrier";
import { reviewWorldKit, type ReviewWorld } from "../_fixtures/reviewWorld";

const PORT = Number(process.env.DRILL_PORT ?? 5877);
const K = Math.max(1, Number(process.env.DRILL_K ?? 30));
const OFFSETS = [-50, 0, 50];
const LAGS = [0, 6, 12, 18, 24, 30]; // ms the sweeps start after the barrier, by iteration
const BASE = "3de6023"; // pinned: never HEAD
const REPO = path.resolve(__dirname, "../..");
const MIN = 60_000;
const HOUR = 3_600_000;
const HOLD_KEY = [4077, 1] as const; // the advisory lock the 'hold' seam waits on
const ROLE = process.env.DRILL_CHILD ? (process.argv[2] ?? "") : null;

installNextStubs();
const fence = fenceFetch();

// The model, refused and counted: a revision brief is written without it.
let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson" && k !== "aiJsonWithUsage") return t[k];
      return async () => { aiCalls++; throw new Error("drill: no model"); };
    },
  }),
);

type SweepOut = { due?: number; autoApproved?: number; toOffice?: number; decidedMeanwhile?: number; sentOutside?: number; errors?: string[]; skipped?: string; threw?: string };
type Said = { ok: boolean; message: string };
const processed = (o: SweepOut) => (o.autoApproved ?? 0) + (o.toOffice ?? 0) + (o.decidedMeanwhile ?? 0) + (o.sentOutside ?? 0);
const has = (key: string, value?: unknown) => (m: unknown) => !!m && typeof m === "object" && key in m && (value === undefined || (m as Record<string, unknown>)[key] === value);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 3de6023's copy of a file, its `@/` imports aimed at this tree. */
function baseCopy(dir: string, file: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${file}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = path.join(dir, path.basename(file).replace(/\.ts$/, ".base.ts"));
  fs.writeFileSync(out, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return out;
}

/** Many iterations, one line per invariant: how many held, and the first few that did not. */
function tally() {
  const seen = new Map<string, number>();
  const fails = new Map<string, string[]>();
  return {
    check(name: string, cond: boolean, detail: string) {
      seen.set(name, (seen.get(name) ?? 0) + 1);
      if (!cond) fails.set(name, [...(fails.get(name) ?? []), detail]);
    },
    report(c: Checker, prefix = "") {
      for (const [name, n] of seen) {
        const f = fails.get(name) ?? [];
        c.ok(`${prefix}${name}`, f.length === 0, `${n - f.length}/${n}${f.length ? ` · first: ${f.slice(0, 3).join(" | ")}` : ""}`);
      }
    },
    failed: (name: string) => (fails.get(name) ?? []).length,
    failures: () => [...fails.values()].reduce((a, f) => a + f.length, 0),
  };
}

// ---------------------------------------------------------------------------
// The child: a second sweeper, on its own process and pool.
// ---------------------------------------------------------------------------
async function childMain() {
  const ctx = attachDrillChild();
  const { prisma } = await import("@/lib/prisma");
  const rw = await import("@/lib/reviewWindows");
  const pid = (await prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid;
  await ctx.send({ up: true, pid, processPid: process.pid });
  for (let seq = 1; ; seq++) {
    const arm = await ctx.waitFor<{ seq: number; op: string }>((m) => has("seq", seq)(m) && has("op")(m), 900_000);
    if (arm.op === "exit") break;
    await ctx.send({ armed: seq });
    const go = await ctx.waitFor<{ go: number; now: string }>(has("go", seq), 120_000);
    const out: SweepOut = await rw.sweepReviewWindows({ now: new Date(go.now) }).catch((e: unknown) => ({ threw: String(e) }));
    await ctx.send({ result: seq, out });
  }
  await prisma.$disconnect();
  await ctx.exit(0);
}

// ---------------------------------------------------------------------------
async function main() {
  const drill = await bootDrillDb({ port: PORT, engine: "postgres", pool: 5 });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const rw = await import("@/lib/reviewWindows");
  const cd = await import("@/lib/clientDecisions");

  // ---- the seam (see the header) -------------------------------------------
  await drill.sql(`CREATE TABLE drill_seam (submission_id text PRIMARY KEY, mode text NOT NULL)`);
  await drill.sql(`CREATE SEQUENCE drill_seam_refused`); // nextval survives the refused row's rollback
  await drill.sql(`
    CREATE FUNCTION drill_seam_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE m text;
    BEGIN
      IF NEW."basis" = 'AUTO_EXPIRY' THEN
        SELECT mode INTO m FROM drill_seam WHERE submission_id = NEW."submissionId";
        IF m = 'fail' THEN
          PERFORM nextval('drill_seam_refused');
          RAISE EXCEPTION 'drill: the automatic approval did not save';
        ELSIF m = 'hold' THEN
          PERFORM pg_advisory_xact_lock(${HOLD_KEY[0]}, ${HOLD_KEY[1]});
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await drill.sql(`CREATE TRIGGER drill_seam BEFORE INSERT ON "ClientDecision" FOR EACH ROW EXECUTE FUNCTION drill_seam_fn()`);
  const seam = (sub: string, mode: "fail" | "hold") => drill.sql(`INSERT INTO drill_seam VALUES ($1, $2) ON CONFLICT (submission_id) DO UPDATE SET mode = EXCLUDED.mode`, [sub, mode]);
  const refusedSoFar = async () => {
    const r = (await drill.sql<{ last_value: string; is_called: boolean }>(`SELECT last_value::text, is_called FROM drill_seam_refused`))[0];
    return r.is_called ? Number(r.last_value) : 0;
  };
  /** Client backends that did anything since `t0` — the race's PARTICIPANTS, both
   *  processes. Not overlap: each process always queries, so this is ≥ 2 even
   *  when the racers run strictly one after another (review, Sep 28). */
  const participants = async (t0: Date) =>
    (await drill.sql<{ n: number }>(
      `SELECT count(DISTINCT pid)::int AS n FROM pg_stat_activity WHERE datname = 'drill' AND backend_type = 'client backend' AND state_change >= $1::timestamptz AND pid <> pg_backend_pid()`,
      [t0.toISOString()],
    ))[0].n;
  /** OVERLAP, MEASURED: the most drill backends seen busy (not idle — a query
   *  running, or a transaction held open) in ONE sample while `fn` runs.
   *  ≥ 2 means two of the racers were inside the database at the same moment. */
  const overlapDuring = async <R,>(fn: () => Promise<R>): Promise<{ result: R; peak: number }> => {
    let running = true;
    let peak = 0;
    const sampler = (async () => {
      while (running) {
        const n = (await drill.sql<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = 'drill' AND backend_type = 'client backend' AND state <> 'idle' AND pid <> pg_backend_pid()`,
        ))[0].n;
        if (n > peak) peak = n;
        await new Promise((r) => setImmediate(r));
      }
    })();
    try {
      const result = await fn();
      return { result, peak };
    } finally {
      running = false;
      await sampler.catch(() => {});
    }
  };

  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" } });
  const staffUser = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const { world, mkCut, release } = await reviewWorldKit({ staffUserId: staffUser.id });
  const windowOf = (sub: string) => prisma.contentReviewWindow.findUnique({ where: { submissionId: sub } });
  // R03 (Sep 28 2026): review deadlines, their expiry and automatic approval
  // reach a REAL client only inside the program rollout — outside it the sweep
  // never looks at the window. Sections (a) and (b) race a REAL client's
  // window against the sweep, so that client is put in the approved pilot
  // first (joined long before any of its windows opened, so no window is
  // "before the join"); every race and every invariant below is unchanged.
  const admitToPilot = async (clientIds: string[]) => {
    const core = await import("@/lib/programRolloutCore");
    const joined = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const value = core.serializeProgramRollout({ mode: "PILOT", modeSince: joined, pilot: { clientIds, operations: core.opsForGroups(core.PROGRAM_PILOT_GROUPS.map((g) => g.key)), approvedBy: "info@realtourpilot.com", approvedAt: joined, expiresAt: null, note: null, joinedAt: Object.fromEntries(clientIds.map((id) => [id, joined])) } });
    await prisma.appSetting.upsert({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY }, create: { key: core.PROGRAM_ROLLOUT_SETTING_KEY, value, updatedBy: "drill" }, update: { value } });
  };
  const setSwitch = (key: string, enabled: boolean, configJson: string | null = null) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(Date.now() - HOUR), configJson }, update: { enabled, enabledAt: new Date(Date.now() - HOUR), configJson } });
  // Both switches ON in THIS database only; the anti-abuse cap out of the way
  // (it is fee-drill §5's subject, not this one's).
  await setSwitch("revision_policy", true, JSON.stringify({ maxNewRoundsPerHour: 500 }));
  await setSwitch("review_auto_approve", true);

  // The OLD modules (3de6023), for the sections that show the old behaviour.
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "realpg-expiry-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
  const oldRw = (await import(baseCopy(baseDir, "src/lib/reviewWindows.ts"))) as typeof rw;
  const oldCd = (await import(baseCopy(baseDir, "src/lib/clientDecisions.ts"))) as typeof cd;

  const child = drill.runChild(__filename, { args: ["sweeper"] });
  const up = await child.waitFor<{ pid: number; processPid: number }>(has("up"), 120_000);
  const parentPid = (await prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid;
  c.head("0 · two processes, two pools, one database");
  c.ok("the child sweeper is its own process with its own backend", up.processPid !== process.pid && up.pid !== parentPid, `child process ${up.processPid} · backends ${parentPid} vs ${up.pid}`);
  c.ok("revision_policy and review_auto_approve are ON (drill database only)", (await rw.revisionPolicy()).autoApprove.on);

  let seq = 0;
  /** Arm the child; `go(now)` starts its sweep, `result()` is what it returned. */
  const armChild = async (ch: DrillChild) => {
    const s = ++seq;
    ch.send({ seq: s, op: "sweep" });
    await ch.waitFor(has("armed", s), 60_000);
    return {
      go: (now: Date) => ch.send({ go: s, now: now.toISOString() }),
      result: async () => (await ch.waitFor<{ out: SweepOut }>(has("result", s), 120_000)).out,
    };
  };
  /** Run the racers from one barrier; the child's sweep is one of them. */
  // `childLag`: the child's sweep starts that many ms after the barrier (the
  // in-process sweep is given the same lag by its caller), so the sweeps meet
  // the request and the approve at every point of their paths, not only at
  // the start.
  const race = async <T extends unknown[]>(label: string, arm: Awaited<ReturnType<typeof armChild>> | null, sweepAt: Date, racers: { [I in keyof T]: () => Promise<T[I]> }, childLag = 0) => {
    const b = barrier(racers.length + (arm ? 1 : 0), { label });
    const t0 = new Date();
    const mine = Promise.all(racers.map(async (f) => { await b.wait(); return f(); })) as Promise<T>;
    const theirs = arm ? (async () => { await b.wait(); if (childLag) await sleep(childLag); arm.go(sweepAt); return arm.result(); })() : Promise.resolve(null);
    const { result: [results, childOut], peak } = await overlapDuring(() => Promise.all([mine, theirs]));
    return { results, childOut, participants: await participants(t0), overlap: peak };
  };

  /** The iteration's window, due at t0 + Δ, the client told (NEVER_SEEN is not the subject). */
  const openDue = async (W: ReviewWorld, slot: number, delta: number) => {
    const sub = await mkCut(W, slot, 1);
    await release(sub);
    const w = (await windowOf(sub))!;
    const t0 = Date.now();
    const deadline = new Date(t0 + delta);
    await prisma.contentReviewWindow.update({ where: { id: w.id }, data: { deadlineAt: deadline, clientNotifiedAt: new Date(t0 - MIN) } });
    return { sub, windowId: w.id, deadline, sweepAt: new Date(deadline.getTime() + 1) };
  };
  const autoRecords = async (W: ReviewWorld, windowId: string) => ({
    activity: await prisma.activity.count({ where: { projectId: W.f.projectId!, body: { contains: "approved automatically" } } }),
    bell: await prisma.notification.count({ where: { dedupeKey: { startsWith: `review-auto-${windowId}` } } }),
  });
  const isLate = (r: Said) => !r.ok && /review window for this version closed/.test(r.message);

  /** Everything that must be true of one cut once every caller has returned. */
  const judge = async (t: ReturnType<typeof tally>, W: ReviewWorld, sub: string, windowId: string, ctx: {
    tag: string; expectOne?: boolean; request?: Said; requestStampedLate?: boolean;
    sweeps: SweepOut[]; before: { activity: number; bell: number };
  }) => {
    const live = await prisma.clientDecision.findMany({ where: { submissionId: sub, receiptState: { not: "SUPERSEDED" } }, orderBy: { decidedAt: "asc" } });
    const all = await prisma.clientDecision.findMany({ where: { submissionId: sub } });
    const w = (await prisma.contentReviewWindow.findUnique({ where: { id: windowId } }))!;
    const rounds = await prisma.contentRevisionRound.findMany({ where: { submissionId: sub } });
    const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: sub } });
    const video = cut.videoId ? await prisma.contentVideo.findUnique({ where: { id: cut.videoId } }) : null;
    const tasks = await prisma.smartTask.findMany({ where: { dedupeKey: `review-expired:${windowId}` } });
    const after = await autoRecords(W, windowId);
    const d = live[live.length - 1];
    const auto = all.find((x) => x.decision === "APPROVE" && x.basis === "AUTO_EXPIRY");
    const kinds = live.map((x) => `${x.decision}/${x.basis}`).join(",") || "none";
    const why = `${ctx.tag}: window ${w.state}/${w.decisionId ? "ptr" : "null"}/${w.expiryOutcome ?? "-"} · live ${kinds}`;
    const expected = !d ? "OPEN" : d.decision === "APPROVE" ? (d.basis === "AUTO_EXPIRY" ? "AUTO_APPROVED" : "APPROVED") : "CHANGES_REQUESTED";

    if (ctx.expectOne !== false) t.check("exactly one live decision on the cut", live.length === 1, why);
    t.check("never an approval and a change request both live", !(live.some((x) => x.decision === "APPROVE") && live.some((x) => x.decision === "REQUEST_CHANGES")), why);
    t.check("the window's state and pointer are the live decision's", w.state === expected && w.decisionId === (d?.id ?? null), `${why} · expected ${expected}`);
    if (d?.decision === "REQUEST_CHANGES") {
      const briefs = await prisma.revisionBrief.count({ where: { sourceDetail: `decision:${d.id}` } });
      const cards = await prisma.smartTask.count({ where: { projectId: W.f.projectId!, taskType: "revision" } });
      t.check("a change request = 1 round, 1 brief, the job's 1 revision card", rounds.filter((r) => r.state !== "CANCELLED").length === 1 && rounds.some((r) => r.decisionId === d.id) && briefs === 1 && cards === 1, `${why} · rounds ${rounds.length} briefs ${briefs} cards ${cards}`);
    } else {
      t.check("no open revision round without a live change request", rounds.filter((r) => r.state === "OPEN").length === 0, `${why} · rounds ${rounds.map((r) => r.state).join(",")}`);
    }
    if (w.state === "AUTO_APPROVED") {
      t.check("AUTO_APPROVED = pointer + evidence + outcome + AUTO_EXPIRY basis, no round", !!w.decisionId && !!w.closeEvidenceJson && w.expiryOutcome === "AUTO_APPROVED" && d?.basis === "AUTO_EXPIRY" && rounds.length === 0, why);
    }
    // expiryOutcome AUTO_APPROVED means an automatic approval STOOD: the window
    // is still auto-approved, or staff reopened it afterwards (the approval
    // then superseded by that very request).
    const autoStood = !!auto && (w.state === "AUTO_APPROVED" || (w.state === "CHANGES_REQUESTED" && auto.receiptState === "SUPERSEDED" && !!d && auto.supersededById === d.id));
    t.check("expiryOutcome AUTO_APPROVED only when an automatic approval stood", w.expiryOutcome !== "AUTO_APPROVED" || autoStood, why);
    const said = w.expiryOutcome === "AUTO_APPROVED" ? 1 : 0;
    t.check("'approved automatically' (Activity + bell) exactly when it did", after.activity - ctx.before.activity === said && after.bell - ctx.before.bell === said, `${why} · activity +${after.activity - ctx.before.activity} bell +${after.bell - ctx.before.bell}`);
    const approvedLive = d?.decision === "APPROVE";
    t.check("the cut's and the video's approval caches agree", approvedLive
      ? cut.clientApprovedDecisionId === d.id && video?.approvedSubmissionId === sub
      : cut.clientApprovedDecisionId === null && video?.approvedSubmissionId !== sub, `${why} · cut cache ${cut.clientApprovedDecisionId ? "set" : "null"} · video ${video?.approvedSubmissionId === sub ? "this cut" : "other"}`);
    if (ctx.request && ctx.requestStampedLate) {
      t.check("a request stamped after the deadline never lands (refused, nothing written)", !ctx.request.ok && all.every((x) => x.decision !== "REQUEST_CHANGES"), `${why} · ${ctx.request.ok ? "ok" : ctx.request.message.slice(0, 60)}`);
    }
    const n = ctx.sweeps.map(processed);
    t.check("no window processed by both sweepers", n.reduce((a, b) => a + b, 0) <= 1, `${why} · processed ${n.join("+")}`);
    if (w.state === "AUTO_APPROVED") {
      t.check("the automatic approval was made exactly once", ctx.sweeps.reduce((a, o) => a + (o.autoApproved ?? 0), 0) === 1, `${why} · ${ctx.sweeps.map((o) => o.autoApproved ?? 0).join("+")}`);
    }
    t.check("≤ 1 review-expired task", tasks.length <= 1, `${why} · ${tasks.length}`);
    t.check("no open 'no answer' task on a window that was answered", !tasks.some((x) => x.status === "OPEN") || w.state === "OPEN", `${why} · task OPEN`);
    t.check("no sweep threw", ctx.sweeps.every((o) => !o.threw && !(o.errors ?? []).length), ctx.sweeps.map((o) => o.threw ?? (o.errors ?? []).join(";")).join(" / "));
    return { w, live, d, tasks };
  };

  // =========================================================================
  c.head(`1 · request vs approve vs two sweepers — ${K} iterations at each Δ ∈ {${OFFSETS.join(", ")}} ms`);
  // =========================================================================
  {
    const t = tally();
    let bothDueAll = 0, leaseLostAll = 0, iterations = 0, lateRefusals = 0;
    const outcomes = new Set<string>();
    const seenBackends: number[] = [];
    const overlaps: number[] = [];
    for (const delta of OFFSETS) {
      const W = await world(`Race ${delta < 0 ? "Minus" : delta > 0 ? "Plus" : "Zero"}`, {}, { slots: K });
      const dist: Record<string, number> = {};
      let bothDue = 0;
      for (let i = 0; i < K; i++) {
        const arm = await armChild(child);
        const { sub, windowId, sweepAt } = await openDue(W, i + 1, delta);
        const before = await autoRecords(W, windowId);
        const lag = LAGS[i % LAGS.length];
        // The approve path is the shortest, so from a standing start it wins
        // every race the sweep does not; on odd iterations it arrives late and
        // the request's own multi-statement path meets the sweeps instead.
        const approveLag = i % 2 ? 60 : 0;
        const { results: [req, appr, sA], childOut, participants: n, overlap } = await race<[Said, Said, SweepOut]>(`Δ${delta} #${i + 1}`, arm, sweepAt, [
          () => cd.requestChangesOnCut(W.viewer, sub, "Please tighten the intro"),
          async () => { await sleep(approveLag); return cd.approveCut(W.viewer, sub, "NONE"); },
          async () => { await sleep(lag); return rw.sweepReviewWindows({ now: sweepAt }) as Promise<SweepOut>; },
        ], lag);
        const sB = childOut!;
        iterations++;
        seenBackends.push(n);
        overlaps.push(overlap);
        if (isLate(req)) lateRefusals++;
        if ((sA.due ?? 0) >= 1 && (sB.due ?? 0) >= 1) { bothDue++; bothDueAll++; }
        leaseLostAll += (sA.due ?? 0) + (sB.due ?? 0) - processed(sA) - processed(sB);
        const j = await judge(t, W, sub, windowId, { tag: `Δ${delta}#${i + 1}`, request: req, requestStampedLate: delta < 0, sweeps: [sA, sB], before });
        t.check("every refused caller is told why", [req, appr].every((r) => r.ok || r.message.length > 10), `${req.message} / ${appr.message}`);
        const k = j.w.state === "OPEN" ? `office(${j.w.expiryOutcome})` : j.w.state;
        dist[k] = (dist[k] ?? 0) + 1;
        outcomes.add(j.w.state);
      }
      console.log(`    Δ ${String(delta).padStart(3)} ms: ${Object.entries(dist).map(([k, n]) => `${k} ${n}`).join(" · ")} · both sweepers found it due in ${bothDue}/${K}`);
    }
    t.report(c);
    const few = seenBackends.filter((n) => n < 2).length;
    const sorted = [...seenBackends].sort((a, b) => a - b);
    // PARTICIPATION IS NOT CONCURRENCY (review, Sep 28). This count is ≥ 2
    // whenever both processes queried at all, which they always do; it would
    // read the same if the four racers ran one after another. It stays as the
    // check that the child took part; the overlap is measured below.
    c.ok("both processes took part in every iteration (≥ 2 backends touched the database since the barrier — participation, not overlap)", few === 0, `${iterations - few}/${iterations} · min ${sorted[0]} · median ${sorted[Math.floor(sorted.length / 2)]} · max ${sorted[sorted.length - 1]}`);
    const overlapped = overlaps.filter((n) => n >= 2).length;
    c.ok("the racers OVERLAPPED: ≥ 2 backends busy in the SAME pg_stat_activity sample, in at least one iteration", overlapped >= 1, `${overlapped}/${iterations} iterations · peak busy backends ${Math.max(0, ...overlaps)}`);
    c.ok("non-vacuous: the two PROCESSES both found the window due, and one of them lost the lease", bothDueAll >= 1 && leaseLostAll >= 1, `both due in ${bothDueAll}/${iterations} · lease lost ${leaseLostAll}× · late refusals ${lateRefusals}`);
    c.ok("non-vacuous: each racer won somewhere — the request, the client's approve and the automatic approval", ["CHANGES_REQUESTED", "APPROVED", "AUTO_APPROVED"].every((x) => outcomes.has(x)), [...outcomes].join(", "));
    const nullAuto = await prisma.contentReviewWindow.count({ where: { state: "AUTO_APPROVED", decisionId: null } });
    c.ok("no AUTO_APPROVED window with a null decisionId once every caller returned", nullAuto === 0, String(nullAuto));
  }

  // =========================================================================
  c.head("2 · (a) automatic approval OFF, a real client: MANUAL once, and a request before the deadline wins");
  // =========================================================================
  {
    await setSwitch("review_auto_approve", false);
    const W = await world("Nia Manual", {}, { slots: 24 });
    await prisma.client.update({ where: { id: W.f.clientId }, data: { name: "Nia Manual" } });
    await admitToPilot([W.f.clientId]);
    const round = async (t: ReturnType<typeof tally>, slot: number, early: boolean, requester: typeof cd.requestChangesOnCut) => {
      const arm = await armChild(child);
      const { sub, windowId, sweepAt } = await openDue(W, slot, early ? 300 : -50);
      const before = await autoRecords(W, windowId);
      const { results: [req, sA], childOut } = await race<[Said, SweepOut]>(`(a) ${slot}`, arm, sweepAt, [
        () => requester(W.viewer, sub, "Please tighten the intro"),
        () => rw.sweepReviewWindows({ now: sweepAt }) as Promise<SweepOut>,
      ]);
      const j = await judge(t, W, sub, windowId, { tag: `(a)#${slot}`, expectOne: early, request: req, requestStampedLate: !early, sweeps: [sA, childOut!], before });
      return { req, j };
    };
    // OLD (3de6023's clientDecisions): the request wins, and Kyle keeps a HIGH
    // "review window closed, the client has not answered" card for it.
    const tOld = tally();
    let oldStale = 0;
    // R03 (Sep 28 2026): the sweep now reads the rollout scope and each
    // client's policy before it claims a window, so it reaches the hand-off a
    // few ms later than at 3de6023 — and a request fired at the barrier then
    // finished first every time, which hid the OLD defect rather than fixing
    // it. The OLD request is started 40 ms after the barrier (still stamped
    // 260 ms BEFORE the deadline), so the hand-off lands while it is in flight
    // — the interleaving this OLD check exists to show. The check is unchanged.
    const oldLate = (async (...a: Parameters<typeof cd.requestChangesOnCut>) => { await sleep(40); return (oldCd.requestChangesOnCut as typeof cd.requestChangesOnCut)(...a); }) as typeof cd.requestChangesOnCut;
    for (let i = 0; i < 3; i++) {
      const { req, j } = await round(tOld, 21 + i, true, oldLate);
      if (req.ok && j.w.state === "CHANGES_REQUESTED" && j.tasks.some((x) => x.status === "OPEN")) oldStale++;
    }
    c.ok(`OLD (${BASE}): a request that beat the deadline but landed after the hand-off left the 'no answer' card OPEN`, oldStale >= 1, `${oldStale}/3`);

    const t = tally();
    let won = 0, handedOff = 0, both = 0;
    for (let i = 0; i < 20; i++) {
      const early = i < 10; // 10 stamped well before the deadline, 10 after it
      const { req, j } = await round(t, i + 1, early, cd.requestChangesOnCut);
      if (early) {
        t.check("a request stamped before the deadline wins", req.ok && j.w.state === "CHANGES_REQUESTED", `${req.message.slice(0, 80)} · ${j.w.state}`);
        if (req.ok) won++;
        if (j.tasks.length) both++;
      } else {
        t.check("late: no decision, window OPEN, MANUAL, exactly one task, still OPEN", j.live.length === 0 && j.w.state === "OPEN" && j.w.expiryOutcome === "MANUAL" && j.tasks.length === 1 && j.tasks[0].status === "OPEN", `${j.w.state}/${j.w.expiryOutcome}/${j.tasks.length}`);
      }
      if (j.w.expiryOutcome === "MANUAL") handedOff++;
      t.check("the outcome is MANUAL or untouched — never an approval", j.w.expiryOutcome === null || j.w.expiryOutcome === "MANUAL", String(j.w.expiryOutcome));
    }
    t.report(c, "(a) ");
    c.ok("(a) non-vacuous: the office got the window WHILE a request was racing it", both >= 1 && handedOff >= 10, `handed off ${handedOff}/20 · requests won ${won}/10 · office card AND request on the same window ${both}/10`);
    await setSwitch("review_auto_approve", true);
  }

  // =========================================================================
  c.head("3 · (b) the automatic approval does not save: back to OPEN, the office once, a late request still refused");
  // =========================================================================
  {
    await setSwitch("review_auto_approve", true, JSON.stringify({ testClientsOnly: false }));
    const t = tally();
    const W = await world("Bo Broken", {}, { slots: 12 });
    await prisma.client.update({ where: { id: W.f.clientId }, data: { name: "Bo Broken" } });
    await admitToPilot([W.f.clientId]);
    const subs: { sub: string; windowId: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const arm = await armChild(child);
      const { sub, windowId, sweepAt } = await openDue(W, i + 1, -50);
      await seam(sub, "fail");
      const refusedBefore = await refusedSoFar();
      const before = await autoRecords(W, windowId);
      const { results: [req, sA], childOut } = await race<[Said, SweepOut]>(`(b) #${i + 1}`, arm, sweepAt, [
        () => cd.requestChangesOnCut(W.viewer, sub, "Please tighten the intro"),
        () => rw.sweepReviewWindows({ now: sweepAt }) as Promise<SweepOut>,
      ]);
      const sB = childOut!;
      const tried = (await refusedSoFar()) - refusedBefore;
      const j = await judge(t, W, sub, windowId, { tag: `(b)#${i + 1}`, expectOne: false, request: req, requestStampedLate: true, sweeps: [sA, sB], before });
      t.check("no decision at all", j.live.length === 0, String(j.live.length));
      t.check("window given back OPEN, no pointer, HELD:APPROVAL_FAILED", j.w.state === "OPEN" && j.w.decisionId === null && j.w.expiryOutcome === "HELD:APPROVAL_FAILED", `${j.w.state}/${j.w.expiryOutcome}`);
      t.check("the office got it once: one task, one toOffice across both sweepers", j.tasks.length === 1 && (sA.toOffice ?? 0) + (sB.toOffice ?? 0) === 1, `${j.tasks.length} tasks · toOffice ${sA.toOffice ?? 0}+${sB.toOffice ?? 0}`);
      t.check("exactly one sweeper tried the approval (the database refused one row)", tried === 1, String(tried));
      subs.push({ sub, windowId });
    }
    t.report(c, "(b) ");
    // Past the deadline an APPROVAL is still accepted (cp02b R17) — and then
    // the office's "nobody answered" card is no longer true.
    const cardOf = (windowId: string) => prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `review-expired:${windowId}` } });
    const [o, n] = subs.slice(-2);
    const oldLate = await oldCd.approveCut(W.viewer, o.sub, "NONE");
    c.ok(`OLD (${BASE}): a late approval after the hand-off is accepted — and the 'no answer' card stays OPEN`, oldLate.ok && (await cardOf(o.windowId)).status === "OPEN", `${oldLate.message.slice(0, 50)} · ${(await cardOf(o.windowId)).status}`);
    const late = await cd.approveCut(W.viewer, n.sub, "NONE");
    c.ok("NEW: a late approval after the hand-off is accepted", late.ok && (await windowOf(n.sub))?.state === "APPROVED", late.message);
    c.ok("NEW: …and the office's 'no answer' card is closed with it", (await cardOf(n.windowId)).status === "COMPLETED", (await cardOf(n.windowId)).status);
    await setSwitch("review_auto_approve", true);
  }

  // =========================================================================
  c.head("4 · (c) a staff reopen against the sweep");
  // =========================================================================
  /** The sweep claims AUTO_APPROVED and is held (by Postgres) before its
   *  approval row; `act` runs to completion; then the sweep is let go. */
  const forced = async (label: string, sweeper: typeof rw, W2: ReviewWorld, slot: number, act: (sub: string) => Promise<Said>) => {
    const { sub, windowId, sweepAt } = await openDue(W2, slot, -50);
    await seam(sub, "hold");
    const before = await autoRecords(W2, windowId);
    const logged = drill.lockWaits();
    await drill.sql(`SELECT pg_advisory_lock(${HOLD_KEY[0]}, ${HOLD_KEY[1]})`);
    const sweeping = sweeper.sweepReviewWindows({ now: sweepAt }) as Promise<SweepOut>;
    let waiting = 0;
    for (const until = Date.now() + 15_000; waiting < 1 && Date.now() < until; ) {
      waiting = await drill.waitingLocks();
      if (waiting < 1) await sleep(10);
    }
    await sleep(120); // past deadlock_timeout (50 ms), so the server logs the wait itself
    const mid = (await windowOf(sub))!;
    const acted = await act(sub);
    await drill.sql(`SELECT pg_advisory_unlock(${HOLD_KEY[0]}, ${HOLD_KEY[1]})`);
    const out = await sweeping;
    for (const until = Date.now() + 1_000; drill.lockWaits() === logged && Date.now() < until; ) await sleep(20);
    const t2 = tally();
    const j = await judge(t2, W2, sub, windowId, { tag: label, expectOne: false, sweeps: [out], before });
    return { mid, waiting, logged: drill.lockWaits() - logged, acted, out, t: t2, j };
  };
  {
    const t = tally();
    const W = await world("Cy Reopen", {}, { slots: 12 });
    let reopened = 0, lostToAuto = 0;
    for (let i = 0; i < 10; i++) {
      const arm = await armChild(child);
      const { sub, windowId, sweepAt } = await openDue(W, i + 1, -50);
      const before = await autoRecords(W, windowId);
      const lag = LAGS[i % LAGS.length];
      const { results: [req, sA], childOut } = await race<[Said, SweepOut]>(`(c) #${i + 1}`, arm, sweepAt, [
        () => cd.requestChangesOnCut(W.staff, sub, "Office: swap the b-roll at 0:20"),
        async () => { await sleep(lag); return rw.sweepReviewWindows({ now: sweepAt }) as Promise<SweepOut>; },
      ], lag);
      await judge(t, W, sub, windowId, { tag: `(c)#${i + 1}`, expectOne: false, request: req, sweeps: [sA, childOut!], before });
      // Staff are never refused by the DEADLINE. A staff request that read the
      // window OPEN and then lost it to the automatic approval is told so (the
      // approved state's words) and nothing is written; pressing again is a
      // reopen of that approval, and lands.
      if (req.ok) {
        t.check("the staff request lands, or loses to the automatic approval and says so", (await prisma.clientDecision.count({ where: { submissionId: sub, decision: "REQUEST_CHANGES", receiptState: { not: "SUPERSEDED" } } })) === 1, req.message);
      } else {
        lostToAuto++;
        const w = await windowOf(sub);
        t.check("the staff request lands, or loses to the automatic approval and says so", w?.state === "AUTO_APPROVED" && /approved when its review window closed/.test(req.message) && (await prisma.clientDecision.count({ where: { submissionId: sub, decision: "REQUEST_CHANGES" } })) === 0, `${w?.state} · ${req.message.slice(0, 60)}`);
        const again = await cd.requestChangesOnCut(W.staff, sub, "Office: swap the b-roll at 0:20");
        const t2 = tally();
        const j2 = await judge(t2, W, sub, windowId, { tag: `(c)#${i + 1} again`, expectOne: true, request: again, sweeps: [], before });
        t.check("…and pressing again reopens the automatic approval, cleanly", again.ok && j2.d?.decision === "REQUEST_CHANGES" && t2.failures() === 0, `${again.message.slice(0, 50)} · ${t2.failures()} invariant failures`);
      }
      if ((await prisma.clientDecision.count({ where: { submissionId: sub, decision: "APPROVE", basis: "AUTO_EXPIRY" } })) > 0) reopened++;
    }
    t.report(c, "(c) ");
    console.log(`    (c) the automatic approval came first in ${reopened}/10 (the staff request then reopened it); the staff press lost the race outright in ${lostToAuto}/10`);

    const R = await world("Rex Forced", {}, { slots: 4 });
    const staffAsk = (sub: string) => cd.requestChangesOnCut(R.staff, sub, "Office: swap the b-roll at 0:20");
    const old = await forced("OLD(c)", oldRw, R, 1, staffAsk);
    c.ok("(c) forced: Postgres held the sweep after its claim — AUTO_APPROVED, no approval row yet", old.waiting >= 1 && old.mid.state === "AUTO_APPROVED" && old.mid.decisionId === null, `${old.waiting} waiting · ${old.mid.state}`);
    c.ok("  …and the server logged that wait itself (log_lock_waits)", old.logged >= 1, `${old.logged} logged`);
    const oldBroken = old.t.failed("never an approval and a change request both live") + old.t.failed("the window's state and pointer are the live decision's") + old.t.failed("the cut's and the video's approval caches agree");
    c.ok(`OLD (${BASE}): the reopen took the claimed window and the sweep then wrote its approval over it`, oldBroken > 0, `staff: ${old.acted.message.slice(0, 40)} · window ${old.j.w.state} · live ${old.j.live.map((x) => x.decision).join("+")}`);
    const neu = await forced("NEW(c)", rw, R, 2, staffAsk);
    c.ok("NEW (c) forced: held after its claim the same way", neu.waiting >= 1 && neu.mid.state === "AUTO_APPROVED" && neu.mid.decisionId === null, `${neu.waiting} waiting · ${neu.mid.state}`);
    neu.t.report(c, "NEW (c) forced: ");
    c.ok("NEW (c) forced: the staff request stands, alone; the sweep reports it lost", neu.acted.ok && neu.j.w.state === "CHANGES_REQUESTED" && neu.j.live.length === 1 && neu.j.live[0].decision === "REQUEST_CHANGES" && (neu.out.decidedMeanwhile ?? 0) === 1, `${neu.acted.message.slice(0, 40)} · ${neu.j.w.state} · live ${neu.j.live.map((x) => x.decision).join("+")} · ${JSON.stringify(neu.out)}`);
  }

  // =========================================================================
  c.head("5 · (d) a client's press against the same in-flight automatic approval");
  // =========================================================================
  {
    const D = await world("Dee Press", {}, { slots: 4 });
    const press = (sub: string) => cd.approveCut(D.viewer, sub, "NONE");
    const old = await forced("OLD(d)", oldRw, D, 1, press);
    const oldBad = old.t.failed("the window's state and pointer are the live decision's") + old.t.failed("expiryOutcome AUTO_APPROVED only when an automatic approval stood") + old.t.failed("'approved automatically' (Activity + bell) exactly when it did");
    c.ok(`OLD (${BASE}): the press took over the claimed window; the window, the decision's basis and "approved automatically" disagree`, oldBad > 0, `press: ${old.acted.message.slice(0, 40)} · window ${old.j.w.state}/${old.j.w.expiryOutcome} · live ${old.j.live.map((x) => `${x.decision}/${x.basis}`).join("+")}`);
    const neu = await forced("NEW(d)", rw, D, 2, press);
    neu.t.report(c, "NEW (d): ");
    c.ok("NEW (d): one approval, the client told it is approved, nothing claims it was automatic", neu.acted.ok && neu.j.live.length === 1 && neu.j.live[0].decision === "APPROVE" && neu.j.w.expiryOutcome !== "AUTO_APPROVED", `${neu.acted.message.slice(0, 50)} · ${neu.j.w.state}/${neu.j.live.map((x) => x.basis).join("+")}`);
  }

  c.head("isolation");
  await drill.distinctBackends(); // the evidence line's peak, taken while the child is still connected
  child.send({ seq: ++seq, op: "exit" });
  await child.exited;
  c.ok("no provider was reached — every outbound attempt was fenced (both processes)", fence.faked.length === 0 && child.blocked.every((u) => fence.blocked.includes(u)), `blocked ${fence.blocked.length}: ${[...new Set(fence.blocked.map((u) => u.replace(/^(\w+:\/\/[^/]+).*/, "$1")))].join(", ") || "none"}`);
  c.ok("no Stripe or QuickBooks host was even tried", !fence.blocked.some((u) => /stripe|intuit|quickbooks/i.test(u)));
  console.log(`    ${await drill.evidence()} · model calls refused ${aiCalls} · prisma error lines swallowed ${quiet.count}`);
  try { fs.unlinkSync(path.join(baseDir, "node_modules")); fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* a leftover temp dir is harmless */ }
  c.summary();
  quiet.restore();
  await drill.stop();
}

(ROLE !== null ? childMain() : main()).catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  // The parent always exits here; a child exits by itself (ctx.exit), or here
  // if it failed — never left holding its pool open.
  if (ROLE === null) { fence.restore(); process.exit(process.exitCode ?? 0); }
  else if (process.exitCode) process.exit(process.exitCode);
});
