// ---------------------------------------------------------------------------
// A PROVIDER HICCUP IN A CRON STEP IS NOISE UNTIL IT PERSISTS (Oct 9 2026).
//
// The error tracker's first three days: "Aryeo timed out — please try again."
// from cron:sync/appointments (7×), cron:reconcile/appointmentsSlice (7×) and
// cron:reconcile/ordersSlice (1×). Every one of them was followed by a run that
// worked — the hourly jobs simply pick the work up again (every step is
// idempotent and the slices resume from their cursor). A Slack DM for each is
// a DM Jordan learns to ignore, and then he ignores the one that matters.
//
// So a cron step that fails with a TRANSIENT PROVIDER ERROR (a timeout, a
// dropped connection, a 5xx or 429 from Aryeo/Dropbox/OpenPhone…) is still
// recorded on /settings/errors, but only alerts — and only counts as open in
// the daily digest — once it PERSISTS:
//   · the same step has now failed on 3 runs in a row, or
//   · the same step has not had a successful run for 6 hours.
// The first rule is the one the hourly jobs hit (three bad hours, or fifteen
// minutes for the */5 jobs); the second covers what three-in-a-row cannot — a
// daily job, where one failure is already a day without it, and any step whose
// failures are spread out but which has not caught up all afternoon.
//
// Read from CronRun, the cron's own record: each run's summary carries
// `<step>Error` for a step that threw, the step's timing in `ms` for a step
// that ran, and the `timedOut` / `skipped` lists. A run that never reached
// the step (skipped, killed earlier) neither extends nor breaks a streak.
// Anything that is NOT a transient provider error — a bug in our code, a
// Prisma error, a 4xx refusal — alerts the first time, exactly as before.
// User-facing errors are untouched.
// ---------------------------------------------------------------------------

export const PERSIST_CONSECUTIVE_RUNS = 3;
export const PERSIST_NO_SUCCESS_MS = 6 * 3600_000;

/** A provider being slow or briefly down — not a bug in the hub. */
export function isTransientProviderError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; message?: unknown; status?: unknown; code?: unknown; cause?: unknown };
  const status = typeof err.status === "number" ? err.status : null;
  if (status !== null && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const name = typeof err.name === "string" ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const code = typeof err.code === "string" ? err.code : "";
  if (/^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(code)) return true;
  const msg = typeof err.message === "string" ? err.message : "";
  if (/\btimed out\b|\btimeout\b|socket hang up|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|\b(502|503|504)\b.*(Bad Gateway|Service Unavailable|Gateway Time-?out)|Bad Gateway|Service Unavailable|Gateway Time-?out|Too Many Requests|rate.?limit/i.test(msg)) return true;
  // fetch() wraps the socket error: TypeError("fetch failed", { cause }).
  return err.cause && err.cause !== e ? isTransientProviderError(err.cause) : false;
}

export type StepOutcome = "ok" | "failed" | "timedOut" | "absent";

type RunRow = { startedAt: Date; summary: string | null; error: string | null };

/** What one CronRun says about one step. */
export function stepOutcome(run: RunRow, step: string): StepOutcome {
  let s: Record<string, unknown> = {};
  try { s = run.summary ? (JSON.parse(run.summary) as Record<string, unknown>) : {}; } catch { s = {}; }
  if (`${step}Error` in s) return "failed";
  // The run's FIRST error is also kept whole in its own column — enough for a
  // row written before summaries kept their errors through truncation.
  if (run.error && run.error.startsWith(`${step}: `)) return "failed";
  if (Array.isArray(s.timedOut) && (s.timedOut as unknown[]).includes(step)) return "timedOut";
  const ms = s.ms && typeof s.ms === "object" ? (s.ms as Record<string, unknown>) : {};
  if (step in s || step in ms) return "ok";
  return "absent";
}

export type StepPersistence = {
  /** Failed runs in a row, THIS one included. */
  consecutiveFailures: number;
  /** The newest earlier run where the step succeeded, inside the lookback. */
  lastSuccessAt: string | null;
  persistent: boolean;
  /** Which rule made it persistent, in words for the alert. */
  rule: string | null;
};

/**
 * Pure: given this run's start and the job's EARLIER runs (newest first), is
 * this step's failure persistent? `recent` = the few newest runs (for the
 * streak); `window` = every run inside the last 6 hours (for "no success").
 */
export function persistenceOf(step: string, now: Date, recent: RunRow[], window: RunRow[]): StepPersistence {
  let consecutive = 1; // this run
  for (const run of recent) {
    const o = stepOutcome(run, step);
    if (o === "failed") consecutive++;
    else if (o === "ok") break;
    // timedOut / absent: the step did not get an answer that run — neither a
    // failure to count nor a success that ends the streak.
  }
  const okRun = [...recent, ...window]
    .filter((r) => stepOutcome(r, step) === "ok")
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  const lastSuccessAt = okRun ? okRun.startedAt.toISOString() : null;
  const sinceSuccess = okRun ? now.getTime() - okRun.startedAt.getTime() : Infinity;
  const streak = consecutive >= PERSIST_CONSECUTIVE_RUNS;
  const stale = sinceSuccess >= PERSIST_NO_SUCCESS_MS;
  return {
    consecutiveFailures: consecutive,
    lastSuccessAt,
    persistent: streak || stale,
    rule: streak ? `failed ${consecutive} runs in a row` : stale ? "no successful run in 6 hours" : null,
  };
}

/** Read the job's earlier runs and answer persistenceOf. Never throws (a read
 *  that fails answers "persistent", so a real outage is never hidden by it). */
export async function readStepPersistence(job: string, step: string, runStartedAtMs: number, now: Date = new Date()): Promise<StepPersistence> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const before = new Date(runStartedAtMs);
    const select = { startedAt: true, summary: true, error: true } as const;
    const [recent, window] = await Promise.all([
      prisma.cronRun.findMany({ where: { job, startedAt: { lt: before } }, orderBy: { startedAt: "desc" }, take: 6, select }),
      prisma.cronRun.findMany({
        where: { job, startedAt: { lt: before, gte: new Date(now.getTime() - PERSIST_NO_SUCCESS_MS) } },
        orderBy: { startedAt: "desc" },
        take: 100,
        select,
      }),
    ]);
    return persistenceOf(step, now, recent, window);
  } catch {
    return { consecutiveFailures: 1, lastSuccessAt: null, persistent: true, rule: "its run history could not be read" };
  }
}
