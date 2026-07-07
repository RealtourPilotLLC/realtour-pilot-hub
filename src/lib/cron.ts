// Helpers for the scheduled cron routes.
//
// Vercel kills a function when it hits `maxDuration`. If that happens midway
// through a multi-step cron, the steps after it never run AND no response comes
// back — so we don't even know what got skipped. This wraps each step in a time
// budget: once we're close to the limit we stop starting new steps and report
// what we skipped, instead of being hard-killed. Every step here is idempotent
// (incremental syncs / upserts), so the next scheduled run picks up the rest.
//
// Observability: pass a `job` name and call `finish()` at the end — each
// invocation is persisted as a CronRun row (per-step results in `summary`,
// first error in `error`) so failures/skips are visible on /connections instead
// of vanishing with the HTTP response. A run that errors or skips also sends a
// best-effort Slack ping — but only when the failure is NEW versus the previous
// run of the same job, so a persistent outage alerts once, not every tick.
// Everything in finish() is best-effort: it can never break the cron itself.

export type CronRunner = {
  step: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  out: Record<string, unknown>;
  finish: () => Promise<void>;
};

// What went wrong in a run, from its `out` shape: step names that errored +
// the skipped list. Used to compare consecutive runs for alert dedupe.
function failureSignature(out: Record<string, unknown>): string {
  const errors = Object.keys(out).filter((k) => k.endsWith("Error")).sort();
  const skipped = Array.isArray(out.skipped) ? [...(out.skipped as string[])].sort() : [];
  return [...errors, ...skipped.map((s) => `skip:${s}`)].join(",");
}

/**
 * Build a budgeted step-runner. `budgetMs` should leave headroom under the
 * route's `maxDuration` (e.g. 250s under a 300s limit) so an in-flight step has
 * time to finish before the platform pulls the plug.
 */
export function cronBudget(budgetMs: number, startedAtMs: number, job?: string): CronRunner {
  const out: Record<string, unknown> = { at: new Date(startedAtMs).toISOString() };
  const skipped: string[] = [];
  out.skipped = skipped;
  let firstError: string | null = null;

  // Create the run row EAGERLY (fire-and-forget) so a hard-killed run still
  // leaves a visible row with no finishedAt — the one failure mode a
  // write-at-the-end log can never capture.
  const runRowId: Promise<string | null> = (async () => {
    if (!job) return null;
    try {
      const { prisma } = await import("@/lib/prisma");
      const row = await prisma.cronRun.create({
        data: { job, startedAt: new Date(startedAtMs) },
        select: { id: true },
      });
      return row.id;
    } catch {
      return null; // table not pushed yet / DB blip — never block the cron
    }
  })();

  return {
    out,
    async step(name, fn) {
      if (Date.now() - startedAtMs >= budgetMs) {
        skipped.push(name);
        return;
      }
      try {
        out[name] = await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out[`${name}Error`] = msg;
        if (!firstError) firstError = `${name}: ${msg}`.slice(0, 500);
      }
    },
    async finish() {
      if (!job) return;
      const ok = !firstError && skipped.length === 0;
      try {
        const { prisma } = await import("@/lib/prisma");
        const id = await runRowId;
        const data = {
          finishedAt: new Date(),
          ok,
          summary: JSON.stringify(out).slice(0, 4000),
          error: firstError,
        };
        if (id) await prisma.cronRun.update({ where: { id }, data });
        else await prisma.cronRun.create({ data: { job, startedAt: new Date(startedAtMs), ...data } });

        // Slack-ping on failure/skip — deduped against the PREVIOUS run so a
        // persistent failure pings once (and again if the failure changes).
        if (!ok) {
          const prev = await prisma.cronRun.findFirst({
            where: { job, startedAt: { lt: new Date(startedAtMs) } },
            orderBy: { startedAt: "desc" },
            select: { ok: true, summary: true },
          });
          let prevSig: string | null = null;
          if (prev && !prev.ok && prev.summary) {
            try { prevSig = failureSignature(JSON.parse(prev.summary) as Record<string, unknown>); } catch { /* unreadable */ }
          }
          if (failureSignature(out) !== prevSig) {
            const bits = [
              firstError ? `error — ${firstError}` : null,
              skipped.length ? `skipped: ${skipped.join(", ")}` : null,
            ].filter(Boolean).join(" · ");
            const { opsAlert } = await import("@/lib/notify");
            await opsAlert(`🟥 Cron "${job}" degraded: ${bits || "unknown failure"}`);
          }
        }
      } catch {
        /* recording/alerting is best-effort — the cron response still reports `out` */
      }
    },
  };
}
