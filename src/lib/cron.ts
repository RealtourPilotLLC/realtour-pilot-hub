// Helpers for the scheduled cron routes.
//
// Vercel kills a function when it hits `maxDuration`. If that happens midway
// through a multi-step cron, the steps after it never run AND no response comes
// back — so we don't even know what got skipped. This wraps each step in a time
// budget: once we're close to the limit we stop starting new steps and report
// what we skipped, instead of being hard-killed. Every step here is idempotent
// (incremental syncs / upserts), so the next scheduled run picks up the rest.

export type CronRunner = {
  step: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  out: Record<string, unknown>;
};

/**
 * Build a budgeted step-runner. `budgetMs` should leave headroom under the
 * route's `maxDuration` (e.g. 250s under a 300s limit) so an in-flight step has
 * time to finish before the platform pulls the plug.
 */
export function cronBudget(budgetMs: number, startedAtMs: number): CronRunner {
  const out: Record<string, unknown> = { at: new Date(startedAtMs).toISOString() };
  const skipped: string[] = [];
  out.skipped = skipped;

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
        out[`${name}Error`] = e instanceof Error ? e.message : String(e);
      }
    },
  };
}
