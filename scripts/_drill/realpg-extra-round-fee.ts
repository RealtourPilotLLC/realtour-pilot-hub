// @drill-run: needs=tools/realpg timeout=900
// ---------------------------------------------------------------------------
// DRILL: R04 — the extra revision round and its fee, on REAL Postgres
// (batch 6, Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/realpg-extra-round-fee.ts
//
// Needs `npm install --prefix tools/realpg` once. DRILL_N=n sets the
// iterations of sections 1-3 (default 20).
//
// Jordan's rules (Sep 24/25 2026): two revision rounds per video are included;
// a third needs an acknowledgement that a $50 fee MAY apply, from the account
// owner OR their assistant; the office then records CHARGE or WAIVE; nothing is
// ever billed automatically, and the round goes to the editor at once. cp02 §3-4
// proved each step alone, on PGlite. Here they race, each racer on its own
// backend, some in a second Node process:
//
//   1. Owner and assistant acknowledge round 3 of one video at the same moment:
//      ONE request, ONE round (ordinal 3, PENDING, acknowledged by whoever won),
//      ONE fee card and bell; the other's notes join it as an addendum.
//   2. Two office users decide CHARGE and WAIVE at once, in two processes:
//      exactly one wins, the other is told who decided; the card is completed
//      once, one timeline line, and no billing host is ever reached.
//   3. The submit's own routing and the cron repair route one request at once
//      (the request's inline route failed; the repair runs 3 minutes on, in a
//      child process): ONE brief, ONE timeline line, ONE Slack ping. OLD
//      (3de6023) first — it wrote the revision twice.
//   4. Four videos of one batch asked at round 3 at once: four rounds, each
//      ordinal 3 on its own video, the unique key never hit. Then a real
//      collision, forced: another row takes ordinal 3 between the request's
//      read and its insert — the retry records exactly one round, at 4.
//   5. Informational: how many new rounds the hourly anti-abuse cap admits
//      under concurrency (a count-then-create; no assertion).
//
// THE CLOCK. Instants the code compares are taken from the rows themselves
// (the repair's `now` is the request's own decidedAt + 3 min); the wall clock
// is not shifted, because the query engine stamps createdAt/decidedAt with it.
// Nothing here depends on the day or the hour it runs.
//
// PROVIDERS ARE FAKE. Slack is answered at the fence and counted (in each
// process); Stripe and QuickBooks are not faked at all — any attempt to reach
// them is blocked and would fail the drill. The model is refused at its seam.
//
// ISOLATION. A disposable Postgres 18 on 127.0.0.1:5878 (tools/realpg); both
// processes pinned to it and fenced. OLD code is 3de6023.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  attachDrillChild, bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors,
  type DrillChild,
} from "./_harness";
import { barrier } from "../_fixtures/barrier";
import { reviewWorldKit, type ReviewWorld } from "../_fixtures/reviewWorld";

const PORT = Number(process.env.DRILL_PORT ?? 5878);
const N = Math.max(1, Number(process.env.DRILL_N ?? 20));
const N_OLD = Math.max(1, Math.min(10, N));
const BASE = "3de6023"; // pinned: never HEAD
const REPO = path.resolve(__dirname, "../..");
const MIN = 60_000;
const HOUR = 3_600_000;
const HOLD_ROUND = [4078, 1] as const;
const ROUTE_LAGS = [0, 3, 6, 9]; // ms the submit's routing starts after the repair's go, by iteration (§3)
const OPS_CHANNEL = "C-DRILL-OPS";
const ROLE = process.env.DRILL_CHILD ? (process.argv[2] ?? "") : null;

installNextStubs();

// ---- Slack, faked at the fence and counted in THIS process ------------------
let slackPosts = 0;
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  if (method === "chat.postMessage") { slackPosts++; return json({ ok: true, ts: String(slackPosts) }); }
  return json({ ok: false, error: `drill: ${method}` });
});

// The model, refused and counted: a brief is written without it.
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

// A round whose insert failed and was retried says so on console.error —
// counted here, so "the unique key was never hit" is measured, not assumed.
let roundRetries = 0;
let routeFailures = 0;
{
  const realError = console.error;
  console.error = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].startsWith("[clientDecisions] revision round did not record")) { roundRetries++; return; }
    // §3 makes the submit's own routing fail on purpose; its log line is expected.
    if (typeof a[0] === "string" && a[0].startsWith("[clientDecisions] routing a portal request failed")) { routeFailures++; return; }
    realError(...a);
  };
}

type Said = { ok: boolean; message: string; decisionId?: string | null };
type Job =
  | { seq: number; op: "request"; viewer: unknown; sub: string; note: string }
  | { seq: number; op: "fee"; roundId: string; decision: "CHARGE" | "WAIVE"; by: string }
  | { seq: number; op: "repair"; now: string; base?: string }
  | { seq: number; op: "exit" };
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type JobBody = DistOmit<Exclude<Job, { op: "exit" }>, "seq">;
const has = (key: string, value?: unknown) => (m: unknown) => !!m && typeof m === "object" && key in m && (value === undefined || (m as Record<string, unknown>)[key] === value);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A world name per iteration: the fixture's email slug keeps letters only. */
const nth = (i: number) => `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;

/** 3de6023's copy of a file, its `@/` imports aimed at this tree. */
function baseCopy(dir: string, file: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${file}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = path.join(dir, path.basename(file).replace(/\.ts$/, ".base.ts"));
  fs.writeFileSync(out, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return out;
}

// ---------------------------------------------------------------------------
// The child: a second seat, a second office user, the cron's repair.
// ---------------------------------------------------------------------------
async function childMain() {
  const ctx = attachDrillChild();
  const { prisma } = await import("@/lib/prisma");
  const cd = await import("@/lib/clientDecisions");
  const rw = await import("@/lib/reviewWindows");
  await prisma.$queryRaw`SELECT 1`;
  await ctx.send({ up: true, processPid: process.pid });
  for (let seq = 1; ; seq++) {
    const job = await ctx.waitFor<Job>((m) => has("seq", seq)(m) && has("op")(m), 900_000);
    if (job.op === "exit") break;
    const mod = job.op === "repair" && job.base ? ((await import(job.base)) as typeof cd) : cd;
    await ctx.send({ armed: seq });
    await ctx.waitFor(has("go", seq), 120_000);
    const before = slackPosts;
    let out: unknown;
    try {
      if (job.op === "request") out = await cd.requestChangesOnCut(job.viewer as Parameters<typeof cd.requestChangesOnCut>[0], job.sub, job.note, { acknowledgeExtraFee: true });
      else if (job.op === "fee") out = await rw.decideRevisionFee(job.roundId, job.decision, job.by);
      else out = await mod.repairPortalRevisionRequests({ now: new Date(job.now) });
    } catch (e) {
      out = { threw: e instanceof Error ? e.message : String(e) };
    }
    await ctx.send({ result: seq, out, slack: slackPosts - before });
  }
  await prisma.$disconnect();
  await ctx.exit(0);
}

// ---------------------------------------------------------------------------
async function main() {
  const drill = await bootDrillDb({ port: PORT, engine: "postgres", pool: 5, env: { SLACK_ALERT_CHANNEL: OPS_CHANNEL } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const rw = await import("@/lib/reviewWindows");
  const cd = await import("@/lib/clientDecisions");
  const { saveSecret } = await import("@/lib/integrations/connections");
  type PortalViewer = import("@/lib/portal").PortalViewer;

  // Slack "connected" so the real client takes its normal path (assembled at
  // run time: a token-shaped literal trips secret scanners even when fake).
  await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

  // ---- the seams, in the database (both processes see them) -----------------
  await drill.sql(`CREATE TABLE drill_seam (kind text NOT NULL, key text NOT NULL, PRIMARY KEY (kind, key))`);
  // route-down: raiseRevisionDetailed's timeline line is refused on this job,
  // so the submit's own routing throws after the request is recorded (the
  // cp03 §6 technique) and the request is left RECEIVED for the repair.
  await drill.sql(`
    CREATE FUNCTION drill_route_down() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM drill_seam WHERE kind = 'route-down' AND key = NEW."projectId") THEN
        RAISE EXCEPTION 'drill: the editor lane is down';
      END IF;
      RETURN NEW;
    END $$`);
  await drill.sql(`CREATE TRIGGER drill_route_down BEFORE INSERT ON "Activity" FOR EACH ROW EXECUTE FUNCTION drill_route_down()`);
  // round-hold: the FIRST round insert on this video waits on an advisory lock
  // the drill holds — between the request's read of the ledger and its write.
  await drill.sql(`CREATE SEQUENCE drill_round_hold`);
  await drill.sql(`
    CREATE FUNCTION drill_round_hold() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM drill_seam WHERE kind = 'round-hold' AND key = NEW."videoKey") AND nextval('drill_round_hold') = 1 THEN
        PERFORM pg_advisory_xact_lock(${HOLD_ROUND[0]}, ${HOLD_ROUND[1]});
      END IF;
      RETURN NEW;
    END $$`);
  await drill.sql(`CREATE TRIGGER drill_round_hold BEFORE INSERT ON "ContentRevisionRound" FOR EACH ROW EXECUTE FUNCTION drill_round_hold()`);
  const seamOn = (kind: string, key: string) => drill.sql(`INSERT INTO drill_seam VALUES ($1, $2) ON CONFLICT DO NOTHING`, [kind, key]);
  const seamOff = (kind: string, key: string) => drill.sql(`DELETE FROM drill_seam WHERE kind = $1 AND key = $2`, [kind, key]);

  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" } });
  const staffUser = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const { world, mkCut, release } = await reviewWorldKit({ staffUserId: staffUser.id });
  const windowOf = (sub: string) => prisma.contentReviewWindow.findUnique({ where: { submissionId: sub } });
  const setPolicy = (config: Record<string, unknown>) =>
    prisma.programAutomation.upsert({
      where: { key: "revision_policy" },
      create: { key: "revision_policy", enabled: true, enabledBy: "drill", enabledAt: new Date(Date.now() - HOUR), configJson: JSON.stringify(config) },
      update: { enabled: true, configJson: JSON.stringify(config) },
    });
  // revision_policy ON in THIS database only; the anti-abuse cap out of the
  // way until §5, which is about it.
  await setPolicy({ maxNewRoundsPerHour: 500 });
  const expectedAck = rw.extraRoundAckText({ ordinal: 3, includedRounds: 2, feeCents: 5000 });

  /** The account's assistant: a COLLABORATOR seat (Jordan, Sep 24: owner OR assistant may acknowledge). */
  const assistantOf = async (W: ReviewWorld, tag: string): Promise<PortalViewer> => {
    const u = await prisma.clientUser.create({ data: { email: `assistant-${tag}@example.com`, name: `Assistant ${tag}`, status: "ACTIVE" }, select: { id: true } });
    return { ...W.viewer, actor: { kind: "CLIENT", clientUserId: u.id, email: `assistant-${tag}@example.com`, name: `Assistant ${tag}`, membershipId: `m-collab-${tag}`, membershipRole: "COLLABORATOR" } } as PortalViewer;
  };
  /** Video `slot` taken through its two included rounds, v3 released: the next ask is round 3. */
  const atRoundThree = async (W: ReviewWorld, slot: number) => {
    const v1 = await mkCut(W, slot, 1);
    await release(v1);
    const r1 = await cd.requestChangesOnCut(W.viewer, v1, "Round one: trim the intro");
    const v2 = await mkCut(W, slot, 2);
    await release(v2);
    const r2 = await cd.requestChangesOnCut(W.viewer, v2, "Round two: a warmer grade");
    const v3 = await mkCut(W, slot, 3);
    await release(v3);
    if (!r1.ok || !r2.ok) throw new Error(`setup of video ${slot}: ${r1.message} / ${r2.message}`);
    const w = (await windowOf(v3))!;
    return { sub: v3, videoKey: w.videoKey, used: await rw.roundsUsed(w.videoKey) };
  };

  const child = drill.runChild(__filename, { args: ["worker"] });
  const up = await child.waitFor<{ processPid: number }>(has("up"), 120_000);
  let seq = 0;
  const armChild = async (ch: DrillChild, job: JobBody) => {
    const s = ++seq;
    ch.send({ ...job, seq: s });
    await ch.waitFor(has("armed", s), 60_000);
    return { go: () => ch.send({ go: s }), result: () => ch.waitFor<{ out: unknown; slack: number }>(has("result", s), 120_000) };
  };
  /** Release the in-process racers and (optionally) the child's job from one barrier. */
  const race = async <T extends unknown[]>(label: string, arm: Awaited<ReturnType<typeof armChild>> | null, racers: { [I in keyof T]: () => Promise<T[I]> }) => {
    const b = barrier(racers.length + (arm ? 1 : 0), { label });
    const mine = Promise.all(racers.map(async (f) => { await b.wait(); return f(); })) as Promise<T>;
    const theirs = arm ? (async () => { await b.wait(); arm.go(); return arm.result(); })() : Promise.resolve(null);
    const [results, child] = await Promise.all([mine, theirs]);
    return { results, child };
  };

  c.head("0 · two processes, one database, fake providers");
  c.ok("the worker is its own process", up.processPid !== process.pid, `child process ${up.processPid}`);
  c.ok("revision_policy is ON (drill database only)", (await rw.revisionPolicy()).on);

  // =========================================================================
  c.head(`1 · owner and assistant acknowledge round 3 at the same moment — ${N} videos`);
  // =========================================================================
  const feeRounds: { id: string; projectId: string }[] = [];
  {
    const W = await world("Fee Race", {}, { slots: N });
    const asst = await assistantOf(W, "fee");
    const ownerId = W.f.clientUserId!;
    const asstId = (asst.actor as { clientUserId: string }).clientUserId;
    const wins = { owner: 0, assistant: 0 };
    let crossProcess = 0, setupOk = 0;
    const fails: Record<string, string[]> = {};
    const check = (name: string, cond: boolean, detail: string) => { if (!cond) (fails[name] ??= []).push(detail); else fails[name] ??= []; };
    for (let i = 0; i < N; i++) {
      const slot = i + 1;
      const { sub, videoKey, used } = await atRoundThree(W, slot);
      if (used === 2) setupOk++;
      const feeBefore = await prisma.smartTask.count({ where: { projectId: W.f.projectId!, taskType: "revision_fee" } });
      const ownerNote = `Owner: swap the ending shot (video ${slot})`;
      const asstNote = `Assistant: brighten the kitchen (video ${slot})`;
      const owner = () => cd.requestChangesOnCut(W.viewer, sub, ownerNote, { acknowledgeExtraFee: true }) as Promise<Said>;
      const assistant = () => cd.requestChangesOnCut(asst, sub, asstNote, { acknowledgeExtraFee: true }) as Promise<Said>;
      let saidOwner: Said, saidAsst: Said;
      if (i % 2) {
        // The assistant in the second process.
        crossProcess++;
        const arm = await armChild(child, { op: "request", viewer: asst, sub, note: asstNote });
        const { results: [o], child: ch } = await race<[Said]>(`§1 #${slot}`, arm, [owner]);
        saidOwner = o;
        saidAsst = ch!.out as Said;
      } else {
        // Both in this process, on two backends; who starts first alternates.
        const { results } = await race<[Said, Said]>(`§1 #${slot}`, null, i % 4 ? [assistant, owner] : [owner, assistant]);
        [saidOwner, saidAsst] = i % 4 ? [results[1], results[0]] : [results[0], results[1]];
      }
      const decs = await prisma.clientDecision.findMany({ where: { submissionId: sub, decision: "REQUEST_CHANGES" } });
      const live = decs.filter((d) => d.receiptState !== "SUPERSEDED");
      const rounds = await prisma.contentRevisionRound.findMany({ where: { videoKey }, orderBy: { ordinal: "asc" } });
      const d = live[0];
      const r3 = rounds.find((r) => r.decisionId === d?.id);
      const ownerWon = d?.clientUserId === ownerId;
      if (d) wins[ownerWon ? "owner" : "assistant"]++;
      const loserSaid = ownerWon ? saidAsst : saidOwner;
      const winnerSaid = ownerWon ? saidOwner : saidAsst;
      const loserNote = ownerWon ? asstNote : ownerNote;
      const addenda = d ? await prisma.revisionBrief.findMany({ where: { sourceDetail: { startsWith: `decision:${d.id}:addendum:` } } }) : [];
      const feeCards = r3 ? await prisma.smartTask.findMany({ where: { dedupeKey: `revision-fee:${r3.id}` } }) : [];
      const feeAfter = await prisma.smartTask.count({ where: { projectId: W.f.projectId!, taskType: "revision_fee" } });
      const bells = r3 ? await prisma.notification.count({ where: { dedupeKey: { startsWith: `revision-fee-${r3.id}` } } }) : 0;
      const tag = `#${slot}`;
      check("one change request (never a second verdict)", decs.length === 1 && live.length === 1, `${tag}: ${decs.length}`);
      check("one round 3: not included, $50 PENDING, the ack text verbatim", rounds.length === 3 && r3?.ordinal === 3 && r3.included === false && r3.feeCents === 5000 && r3.feeDecision === "PENDING" && r3.feeAckText === expectedAck, `${tag}: rounds ${rounds.map((r) => r.ordinal).join(",")}`);
      check("the fee is acknowledged by whoever won — owner or assistant — and nobody else", !!r3 && r3.feeAckClientUserId === (ownerWon ? ownerId : asstId) && r3.feeAckBy === d?.actorLabel, `${tag}: ack ${r3?.feeAckBy} vs decision ${d?.actorLabel}`);
      check("one fee card (on Kyle), one fee bell, and the round points at the card", feeCards.length === 1 && feeAfter - feeBefore === 1 && r3?.feeTaskId === feeCards[0]?.id && feeCards[0]?.assignedKey === "kyle" && bells === 1, `${tag}: cards ${feeCards.length} (+${feeAfter - feeBefore}) bells ${bells}`);
      check("both seats are answered ok: the winner's round, the loser's addendum", winnerSaid.ok && /extra-round fee/.test(winnerSaid.message) && loserSaid.ok && /Added to your open request/.test(loserSaid.message), `${tag}: ${winnerSaid.message.slice(0, 40)} / ${loserSaid.message.slice(0, 40)}`);
      check("the loser's words reach the same request as ONE addendum brief", addenda.length === 1 && addenda[0].originalText.includes(loserNote.split(": ")[1]), `${tag}: ${addenda.length} addenda`);
      if (r3) feeRounds.push({ id: r3.id, projectId: r3.projectId });
    }
    c.ok("setup: every video had used exactly its two included rounds", setupOk === N, `${setupOk}/${N}`);
    for (const [name, f] of Object.entries(fails)) c.ok(name, f.length === 0, `${N - f.length}/${N}${f.length ? ` · first: ${f.slice(0, 3).join(" | ")}` : ""}`);
    c.ok("non-vacuous: both seats won somewhere, and half the races crossed processes", wins.owner >= 1 && wins.assistant >= 1 && crossProcess >= 1, `owner ${wins.owner} · assistant ${wins.assistant} · cross-process ${crossProcess}/${N}`);
  }

  // =========================================================================
  c.head(`2 · CHARGE and WAIVE at the same moment, in two processes — ${feeRounds.length} rounds`);
  // =========================================================================
  {
    const fails: Record<string, string[]> = {};
    const check = (name: string, cond: boolean, detail: string) => { if (!cond) (fails[name] ??= []).push(detail); else fails[name] ??= []; };
    const slackBefore = slackPosts;
    let childSlack = 0;
    const tally = { CHARGE: 0, WAIVE: 0 };
    for (const [i, r] of feeRounds.entries()) {
      const recorded = () => prisma.activity.count({ where: { projectId: r.projectId, body: { contains: "the office recorded" } } });
      const before = await recorded();
      // Which side runs in the child alternates, so neither decision is always the far one.
      const here = i % 2 ? { decision: "WAIVE" as const, by: "Jordan Drill" } : { decision: "CHARGE" as const, by: "Kyle Drill" };
      const there = i % 2 ? { decision: "CHARGE" as const, by: "Kyle Drill" } : { decision: "WAIVE" as const, by: "Jordan Drill" };
      const arm = await armChild(child, { op: "fee", roundId: r.id, ...there });
      const { results: [mine], child: ch } = await race<[Said]>(`§2 #${i + 1}`, arm, [() => rw.decideRevisionFee(r.id, here.decision, here.by)]);
      const theirs = ch!.out as Said;
      childSlack += ch!.slack;
      const round = await prisma.contentRevisionRound.findUniqueOrThrow({ where: { id: r.id } });
      const card = round.feeTaskId ? await prisma.smartTask.findUnique({ where: { id: round.feeTaskId } }) : null;
      const winner = mine.ok ? here : there;
      const loser = mine.ok ? theirs : mine;
      if (round.feeDecision === "CHARGE" || round.feeDecision === "WAIVE") tally[round.feeDecision]++;
      const tag = `#${i + 1}`;
      check("exactly one decision wins", [mine, theirs].filter((x) => x.ok).length === 1, `${tag}: ${mine.ok}/${theirs.ok}`);
      check("the round holds the winner's decision, by the winner", round.feeDecision === winner.decision && round.feeDecidedBy === winner.by, `${tag}: ${round.feeDecision} by ${round.feeDecidedBy}`);
      check("the loser is told who already decided, and that nothing changed", new RegExp(`^Already decided: ${winner.decision.toLowerCase()} \\(${winner.by}\\)\\. Nothing changed\\.$`).test(loser.message), `${tag}: ${loser.message}`);
      check("the fee card is completed, once", card?.status === "COMPLETED" && !!card.completedAt, `${tag}: ${card?.status}`);
      check("one timeline line for the decision", (await recorded()) - before === 1, `${tag}: +${(await recorded()) - before}`);
    }
    for (const [name, f] of Object.entries(fails)) c.ok(name, f.length === 0, `${feeRounds.length - f.length}/${feeRounds.length}${f.length ? ` · first: ${f.slice(0, 3).join(" | ")}` : ""}`);
    c.ok("non-vacuous: both decisions won somewhere", tally.CHARGE >= 1 && tally.WAIVE >= 1, `CHARGE ${tally.CHARGE} · WAIVE ${tally.WAIVE}`);
    c.ok("a fee decision sends nothing to Slack, in either process", slackPosts === slackBefore && childSlack === 0, `${slackPosts - slackBefore}+${childSlack}`);
    c.ok("no Stripe or QuickBooks host was even tried, in either process", !fence.blocked.some((u) => /stripe|intuit|quickbooks/i.test(u)), fence.blocked.filter((u) => /stripe|intuit/i.test(u)).join(",") || "none");
  }

  // =========================================================================
  c.head(`3 · the submit's routing and the cron repair route one request at once`);
  // =========================================================================
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "realpg-fee-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
  const basePath = baseCopy(baseDir, "src/lib/clientDecisions.ts");
  const oldCd = (await import(basePath)) as typeof cd;
  {
    /** One request whose inline routing failed: RECEIVED, no brief, no card, no ping. */
    const stranded = async (name: string) => {
      const W = await world(name, {}, { slots: 1 });
      const sub = await mkCut(W, 1, 1);
      await release(sub);
      await seamOn("route-down", W.f.projectId!);
      const slack0 = slackPosts;
      const said = await cd.requestChangesOnCut(W.viewer, sub, "Please brighten the kitchen shots");
      await seamOff("route-down", W.f.projectId!);
      const d = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: sub, decision: "REQUEST_CHANGES" } });
      const ok = said.ok && /Received/.test(said.message) && d.receiptState === "RECEIVED" && !d.revisionBriefId && d.routeClaimedAt === null
        && (await prisma.revisionBrief.count({ where: { decisionId: d.id } })) === 0 && slackPosts === slack0;
      return { W, sub, d, ok };
    };
    // The submit starts 0-9 ms after the repair's go (by iteration), so the
    // repair — which has a query to run first — wins some claims too.
    const routeRace = async (mod: typeof cd, label: string, base?: string, lag = 0) => {
      const { W, d, ok } = await stranded(label);
      const round = await prisma.contentRevisionRound.findUniqueOrThrow({ where: { decisionId: d.id } });
      const arm = await armChild(child, { op: "repair", now: new Date(d.decidedAt.getTime() + 3 * MIN).toISOString(), base });
      const slack0 = slackPosts;
      const { results: [routed], child: ch } = await race<[Awaited<ReturnType<typeof cd.routePortalRequest>> | { threw: string }]>(label, arm, [
        async () => { if (lag) await sleep(lag); return mod.routePortalRequest(d.id).catch((e: unknown) => ({ threw: String(e) })); },
      ]);
      const repaired = ch!.out as { routed?: number; threw?: string };
      const after = await prisma.clientDecision.findUniqueOrThrow({ where: { id: d.id } });
      return {
        setupOk: ok,
        briefs: await prisma.revisionBrief.count({ where: { sourceDetail: `decision:${d.id}` } }),
        flags: await prisma.activity.count({ where: { projectId: W.f.projectId!, type: "FLAG" } }),
        cards: await prisma.smartTask.count({ where: { projectId: W.f.projectId!, taskType: "revision" } }),
        // One row per target, keyed "<key>-<n>" (notifyInApp), so a second raise
        // could never add rows — at least one is all a count can say.
        bells: await prisma.notification.count({ where: { dedupeKey: { startsWith: `portal-round-${round.id}-` } } }),
        slack: slackPosts - slack0 + ch!.slack,
        linked: !!after.revisionBriefId && after.receiptState === "ROUTED",
        parentLostClaim: routed === null,
        childRouted: repaired.routed ?? 0,
        threw: ("threw" in (routed ?? {}) ? (routed as { threw: string }).threw : null) ?? repaired.threw ?? null,
      };
    };

    // OLD (3de6023): no claim. Both routers pass the "prior brief" check
    // before either writes one.
    type RaceResult = Awaited<ReturnType<typeof routeRace>>;
    const old: RaceResult[] = [];
    for (let i = 0; i < N_OLD; i++) old.push(await routeRace(oldCd, `Old Route ${nth(i)}`, basePath, ROUTE_LAGS[i % ROUTE_LAGS.length]));
    const dup = old.filter((r) => r.briefs > 1).length;
    c.ok("setup: every request's own routing failed and left it RECEIVED, unrouted, unpinged", old.every((r) => r.setupOk), old.map((r) => r.setupOk).join(","));
    c.ok(`OLD (${BASE}): the same request was raised TWICE — two briefs, two timeline lines`, dup >= 1, `${dup}/${N_OLD} races doubled · briefs ${old.map((r) => r.briefs).join(",")} · FLAG lines ${old.map((r) => r.flags).join(",")}`);

    const neu: RaceResult[] = [];
    for (let i = 0; i < N; i++) neu.push(await routeRace(cd, `New Route ${nth(i)}`, undefined, ROUTE_LAGS[i % ROUTE_LAGS.length]));
    const bad = (f: (r: (typeof neu)[number]) => boolean) => neu.filter((r) => !f(r)).length;
    c.ok("setup: every request's own routing failed and left it RECEIVED, unrouted, unpinged (and unclaimed)", neu.every((r) => r.setupOk) && routeFailures === N_OLD + N, `${routeFailures} inline routes failed as arranged`);
    c.ok("NEW: exactly one brief per request", bad((r) => r.briefs === 1) === 0, `briefs ${neu.map((r) => r.briefs).join(",")}`);
    c.ok("NEW: exactly one timeline line and one revision card; the bell rang", bad((r) => r.flags === 1 && r.cards === 1 && r.bells >= 1) === 0, `FLAG ${neu.map((r) => r.flags).join(",")} · cards ${neu.map((r) => r.cards).join(",")} · bells ${neu.map((r) => r.bells).join(",")}`);
    c.ok("NEW: Slack (the fake, both processes) was pinged exactly once per request", bad((r) => r.slack === 1) === 0, neu.map((r) => r.slack).join(","));
    c.ok("NEW: every request ends ROUTED and linked to its brief; nothing threw", bad((r) => r.linked && !r.threw) === 0, neu.filter((r) => r.threw).map((r) => r.threw).join(" | ") || "none threw");
    const byChild = neu.filter((r) => r.childRouted === 1).length;
    const contended = neu.filter((r) => r.parentLostClaim).length;
    c.ok("non-vacuous: the repair in the other process routed some, and the submit found the claim held in some", byChild >= 1 && contended >= 1, `repair routed ${byChild}/${N} · submit lost the claim ${contended}/${N}`);
  }

  // =========================================================================
  c.head("4 · four videos of one batch at round 3 at once; then a real collision on the ledger");
  // =========================================================================
  {
    const W = await world("Batch Four", {}, { slots: 5 });
    const prepared = [];
    for (let slot = 1; slot <= 4; slot++) prepared.push(await atRoundThree(W, slot));
    const retries0 = roundRetries;
    const { results } = await race<Said[]>("§4 four videos", null, prepared.map((p, i) => () => cd.requestChangesOnCut(W.viewer, p.sub, `Video ${i + 1}: swap the music`, { acknowledgeExtraFee: true }) as Promise<Said>));
    const r3s = await prisma.contentRevisionRound.findMany({ where: { videoKey: { in: prepared.map((p) => p.videoKey) }, ordinal: 3 } });
    c.ok("four requests, all answered ok", results.every((r) => r.ok), results.map((r) => r.message.slice(0, 30)).join(" / "));
    c.ok("four rounds, each ordinal 3, each on its own video", r3s.length === 4 && new Set(r3s.map((r) => r.videoKey)).size === 4, `${r3s.length} rounds`);
    c.ok("the unique key was never hit (no round insert retried)", roundRetries === retries0, `${roundRetries - retries0} retries`);
    c.ok("four fee cards, one per round", (await prisma.smartTask.count({ where: { dedupeKey: { in: r3s.map((r) => `revision-fee:${r.id}`) } } })) === 4);

    // The collision the flow never produces, forced: the request reads the
    // ledger (top ordinal 2), its insert of ordinal 3 is held by Postgres, and
    // meanwhile ANOTHER session commits a row at ordinal 3 on the same video.
    const p5 = await atRoundThree(W, 5);
    const w5 = (await windowOf(p5.sub))!;
    await drill.sql(`ALTER SEQUENCE drill_round_hold RESTART WITH 1`);
    await seamOn("round-hold", p5.videoKey);
    await drill.sql(`SELECT pg_advisory_lock(${HOLD_ROUND[0]}, ${HOLD_ROUND[1]})`);
    const retries1 = roundRetries;
    const asking = cd.requestChangesOnCut(W.viewer, p5.sub, "Video 5: swap the music", { acknowledgeExtraFee: true }) as Promise<Said>;
    let waiting = 0;
    for (const until = Date.now() + 15_000; waiting < 1 && Date.now() < until; ) {
      waiting = await drill.waitingLocks();
      if (waiting < 1) await sleep(10);
    }
    const logged = drill.lockWaits();
    await sleep(120); // past deadlock_timeout (50 ms), so the server logs the wait itself
    await drill.sql(
      `INSERT INTO "ContentRevisionRound" ("id","videoKey","projectId","enrollmentId","clientId","submissionId","windowId","decisionId","ordinal","includedRounds","included","state","createdAt","updatedAt")
       VALUES ('drill-phantom-5', $1, $2, $3, $4, $5, $6, 'drill-phantom-decision-5', 3, 2, false, 'CANCELLED', now(), now())`,
      [p5.videoKey, W.f.projectId, W.f.enrollmentId, W.f.clientId, p5.sub, w5.id],
    );
    await drill.sql(`SELECT pg_advisory_unlock(${HOLD_ROUND[0]}, ${HOLD_ROUND[1]})`);
    const said = await asking;
    await seamOff("round-hold", p5.videoKey);
    const d5 = await prisma.clientDecision.findFirst({ where: { submissionId: p5.sub, decision: "REQUEST_CHANGES", receiptState: { not: "SUPERSEDED" } } });
    const mine = d5 ? await prisma.contentRevisionRound.findMany({ where: { decisionId: d5.id } }) : [];
    for (const until = Date.now() + 1_000; drill.lockWaits() === logged && Date.now() < until; ) await sleep(20);
    c.ok("the request's round insert was held by Postgres while the other row committed (and the server logged the wait)", waiting >= 1 && drill.lockWaits() > logged, `${waiting} waiting · ${drill.lockWaits() - logged} logged`);
    c.ok("the insert hit the unique key once and was retried (a real 23505, not a simulated one)", roundRetries - retries1 === 1, `${roundRetries - retries1} retries`);
    c.ok("the request still lands, with exactly one round — at the next ordinal, 4", said.ok && mine.length === 1 && mine[0].ordinal === 4 && mine[0].feeDecision === "PENDING", `${said.message.slice(0, 40)} · ordinals ${mine.map((r) => r.ordinal).join(",")}`);
    c.ok("  …its fee card filed once", mine.length === 1 && (await prisma.smartTask.count({ where: { dedupeKey: `revision-fee:${mine[0].id}` } })) === 1);
  }

  // =========================================================================
  c.head("5 · informational: the hourly cap on new rounds, under concurrency");
  // =========================================================================
  {
    // Cap = max(maxNewRoundsPerHour, videosPerMonth × 2) = max(3, 2) = 3.
    await setPolicy({ maxNewRoundsPerHour: 3 });
    const W = await world("Cap Five", { videosPerMonth: 1 }, { slots: 6 });
    const subs = [];
    for (let slot = 1; slot <= 6; slot++) { const s = await mkCut(W, slot, 1); await release(s); subs.push(s); }
    const { results } = await race<Said[]>("§5 cap", null, subs.map((s, i) => () => cd.requestChangesOnCut(W.viewer, s, `Video ${i + 1}: trim the intro`) as Promise<Said>));
    const admitted = results.filter((r) => r.ok).length;
    const rounds = await prisma.contentRevisionRound.count({ where: { enrollmentId: W.f.enrollmentId } });
    console.log(`    INFO: six new rounds at once under a cap of 3 — admitted ${admitted} (rounds recorded ${rounds}); one at a time it admits 3.`);
    console.log(`    INFO: ${admitted > 3 ? "the count-then-create cap admits more than the cap under concurrency (anti-abuse only; no money rides on it)" : "the cap held under this run's concurrency"}.`);
    await setPolicy({ maxNewRoundsPerHour: 500 });
  }

  c.head("isolation");
  await drill.distinctBackends(); // the evidence line's peak, taken while the child is still connected
  child.send({ seq: ++seq, op: "exit" });
  await child.exited;
  c.ok("every non-Slack outbound attempt was blocked, in both processes; the fence faked only Slack", fence.faked.every((u) => u.startsWith("https://slack.com/api/")) && child.blocked.every((u) => fence.blocked.includes(u)), `faked ${fence.faked.length} (Slack) · blocked ${fence.blocked.length}: ${[...new Set(fence.blocked.map((u) => u.replace(/^(\w+:\/\/[^/]+).*/, "$1")))].join(", ") || "none"}`);
  c.ok("no Stripe or QuickBooks host was ever tried", !fence.blocked.some((u) => /stripe|intuit|quickbooks/i.test(u)));
  console.log(`    ${await drill.evidence()} · Slack posts faked here ${slackPosts} · model calls refused ${aiCalls} · prisma error lines swallowed ${quiet.count}`);
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
