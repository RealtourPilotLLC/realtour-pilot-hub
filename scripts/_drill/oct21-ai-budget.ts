// ---------------------------------------------------------------------------
// DRILL: the AI cron's calls end inside its budget, and the Stripe lapse alarm
// cannot die quietly (Oct 21 2026, audit wave 2, H1 + H6), and the every-
// minute topaz job stops writing per-step progress (H2).
//
//   1. timeoutBefore: a sweep's deadline as a call's time limit, never longer
//      than the call's own default;
//   2. runAiJson carries `timeoutMs` to the transport: a model that never
//      answers is cut off at the limit, and the run row says FAILED;
//   3. the revision-brief sweep (the 15-minute AI job) hands its budget to
//      the reading: a hung model ends with the sweep's clock, not 130 s later;
//   4. sweepSubscriptionHealth: no Stripe key is a skip; every check failing
//      throws into the cron step; one failing among several is counted;
//   5. cronBudget("topaz") records its run without a progress UPDATE per step.
//
// ISOLATION: PGlite via the shared harness. The model and Stripe are faked at
// fetch; nothing else leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6986);
installNextStubs();

/** The model: never answers, ends only when the caller's time limit aborts it. */
let modelCalls = 0;
const stripe = new Map<string, number>(); // subscription id → HTTP status to answer
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://api.anthropic.com/")) {
    modelCalls++;
    const signal = init?.signal;
    return new Promise<Response>((_, reject) => {
      if (!signal) return; // would hang for ever: the drill's time limit catches it
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  const m = /^https:\/\/api\.stripe\.com\/v1\/subscriptions\/([^?]+)/.exec(url);
  if (m && stripe.has(m[1])) {
    const status = stripe.get(m[1])!;
    return status === 200
      ? new Response(JSON.stringify({ id: m[1], status: "active" }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: { message: "Stripe is having a moment" } }), { status, headers: { "content-type": "application/json" } });
  }
  return null;
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { timeoutBefore, aiTimeoutFor } = await import("@/lib/integrations/ai");
  const { runAiJson } = await import("@/lib/aiRuns");
  const { sweepUnanalyzedBriefs } = await import("@/lib/revisionBriefSweep");
  const { sweepSubscriptionHealth } = await import("@/lib/stripeSignups");
  try {
    // =======================================================================
    c.head("1 · a sweep's deadline as a call's time limit");
    {
      const now = Date.now();
      c.ok("no deadline: the default (undefined)", timeoutBefore(null) === undefined && timeoutBefore(undefined) === undefined);
      const near = timeoutBefore(now + 20_000, 4000)!;
      c.ok("20 s left: about 20 s", near > 19_000 && near <= 20_000, String(near));
      c.ok("an hour left: never longer than the call's own default", timeoutBefore(now + 3_600_000, 1500) === aiTimeoutFor(1500), String(timeoutBefore(now + 3_600_000, 1500)));
      c.ok("past the deadline: the 1 s floor, never zero or negative", timeoutBefore(now - 5_000) === 1_000);
    }

    await saveSecret("ai", ["sk", "ant", "drill", "0000000000"].join("-"));

    // =======================================================================
    c.head("2 · runAiJson carries timeoutMs to the transport");
    {
      const t0 = Date.now();
      let err: Error | null = null;
      try {
        await runAiJson<{ ok: boolean }>({ kind: "recommendation", promptKey: "drill", requestedBy: "drill", unattended: false, system: "s", prompt: "p", schema: { type: "object" }, maxTokens: 4000, timeoutMs: 1_500 });
      } catch (e) {
        err = e as Error;
      }
      const took = Date.now() - t0;
      c.ok("a model that never answers is cut off at the 1.5 s limit (the default would wait 130 s)", err?.name === "TimeoutError" && took < 6_000, `${err?.name}: ${err?.message} · ${took} ms`);
      const run = await prisma.programAiRun.findFirst({ where: { promptKey: "drill" }, orderBy: { createdAt: "desc" }, select: { status: true, error: true } });
      c.ok("…and the run row says FAILED, with the reason", run?.status === "FAILED" && /timed out/i.test(run.error ?? ""), `${run?.status} · ${run?.error}`);
    }

    // =======================================================================
    c.head("3 · the revision-brief sweep hands its budget to the reading");
    {
      const client = await prisma.client.create({ data: { name: "Budget Agent" }, select: { id: true } });
      const p = await prisma.project.create({ data: { title: "12 Hung Model Ln, Royersford, PA", clientId: client.id, status: "REVISION" }, select: { id: true } });
      const brief = await prisma.revisionBrief.create({ data: { projectId: p.id, source: "openphone", originalText: "Can you brighten the kitchen shots and use a calmer song?", createdAt: new Date(Date.now() - 20 * 60_000) }, select: { id: true } });
      const before = modelCalls;
      const t0 = Date.now();
      const r = await sweepUnanalyzedBriefs({ budgetMs: 1_500, minStartMs: 0 });
      const took = Date.now() - t0;
      c.ok("the sweep started the reading (the model was asked)", modelCalls > before && r.failedIds.includes(brief.id), JSON.stringify({ calls: modelCalls - before, failed: r.failedIds.length }));
      c.ok("…and it ended with the sweep's 1.5 s budget, not the call's own 130 s", took < 8_000, `${took} ms`);
      const row = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: brief.id }, select: { analyzedAt: true, analysisError: true } });
      c.ok("…the brief stays unread, the try and its reason on the row", row.analyzedAt === null && /timed out/i.test(row.analysisError ?? ""), row.analysisError ?? "none");
    }

    // =======================================================================
    c.head("4 · the Stripe lapse alarm cannot die quietly");
    {
      const none = await sweepSubscriptionHealth();
      c.ok("no Stripe key: a skip, said in words", "skipped" in none && /not connected/.test(none.skipped), JSON.stringify(none));
      await saveSecret("stripe", ["rk", "test", "drill0000000000000000"].join("_"));
      let n = 0;
      const enrolledSignup = async (sub: string) => {
        const cl = await prisma.client.create({ data: { name: `Sub Client ${++n}` } });
        const e = await prisma.contentEnrollment.create({ data: { clientId: cl.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, status: "ACTIVE" } });
        await prisma.programSignup.create({ data: { checkoutId: `cs_budget_${n}`, productId: "prod_x", productName: "Video Accelerator", amount: 999, recurring: true, paidAt: new Date(), subscriptionId: sub, enrollmentId: e.id, clientId: cl.id } as never });
      };
      await enrolledSignup("sub_a");
      await enrolledSignup("sub_b");
      stripe.set("sub_a", 500).set("sub_b", 503);
      let thrown: Error | null = null;
      try { await sweepSubscriptionHealth(); } catch (e) { thrown = e as Error; }
      c.ok("every check failing throws into the cron step (it used to read { checked: 0 } as ok)", !!thrown && /Every subscription check failed \(2\)/.test(thrown.message), thrown?.message ?? "no throw");
      stripe.set("sub_a", 200);
      const partial = await sweepSubscriptionHealth();
      c.ok("one failing among two: checked 1, failed 1, no throw", !("skipped" in partial) && partial.checked === 1 && partial.failed === 1, JSON.stringify(partial));
    }

    // =======================================================================
    c.head("5 · (H2) the every-minute topaz job writes no per-step progress");
    {
      const { cronBudget } = await import("@/lib/cron");
      const realUpdate = prisma.cronRun.update.bind(prisma.cronRun);
      let updates = 0;
      prisma.cronRun.update = ((args: Parameters<typeof realUpdate>[0]) => { updates++; return realUpdate(args); }) as unknown as typeof prisma.cronRun.update;
      const threeSteps = async (job: string) => {
        updates = 0;
        const r = cronBudget(250_000, Date.now(), job);
        await r.step("one", async () => ({ ok: 1 }));
        await r.step("two", async () => ({ ok: 2 }));
        await r.step("three", async () => ({ ok: 3 }));
        const during = updates;
        await r.finish();
        return { during, total: updates };
      };
      try {
        const topaz = await threeSteps("topaz");
        const row = await prisma.cronRun.findFirst({ where: { job: "topaz" }, orderBy: { startedAt: "desc" }, select: { finishedAt: true, summary: true } });
        c.ok("topaz: no progress UPDATE after its three steps", topaz.during === 0, JSON.stringify(topaz));
        c.ok("…and the run is still recorded, finished, with every step's result", !!row?.finishedAt && /"three"/.test(row.summary ?? ""), row?.summary?.slice(0, 120));
        const sync = await threeSteps("sync");
        c.ok("(control) the hourly sync still writes its progress after each step", sync.during === 3, JSON.stringify(sync));
      } finally {
        prisma.cronRun.update = realUpdate as typeof prisma.cronRun.update;
      }
    }

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
