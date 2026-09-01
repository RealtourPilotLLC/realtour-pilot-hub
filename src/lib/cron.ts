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

import { NextResponse } from "next/server";

/** The one cron auth rule, shared by every route. FAIL CLOSED: in prod/Vercel a
 *  missing CRON_SECRET refuses (losing an env var never opens the door). Returns
 *  a 401 response to send, or null when the caller may proceed. */
export function authorizeCron(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  const enforced = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  if (!secret && enforced) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 401 });
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export type CronRunner = {
  /** Run one step. `maxMs` caps it: on timeout the step is recorded as
   *  `{ timedOut: true }` and the run moves on (the work keeps running in the
   *  background until the function returns — every step is idempotent, so the
   *  next run simply resumes). */
  step: (name: string, fn: () => Promise<unknown>, opts?: { maxMs?: number; after?: string }) => Promise<void>;
  out: Record<string, unknown>;
  finish: () => Promise<void>;
  /** ms since the run started — lets a step size its own internal budget */
  elapsed: () => number;
  /** ms left before the runner stops starting new steps */
  remaining: () => number;
};

// What went wrong in a run, from its `out` shape: step names that errored +
// the skipped list. Used to compare consecutive runs for alert dedupe.
function failureSignature(out: Record<string, unknown>): string {
  const errors = Object.keys(out).filter((k) => k.endsWith("Error")).sort();
  const skipped = Array.isArray(out.skipped) ? [...(out.skipped as string[])].sort() : [];
  const timedOut = Array.isArray(out.timedOut) ? [...(out.timedOut as string[])].sort() : [];
  return [...errors, ...skipped.map((s) => `skip:${s}`), ...timedOut.map((s) => `timeout:${s}`)].join(",");
}

/**
 * Build a budgeted step-runner. `budgetMs` should leave headroom under the
 * route's `maxDuration` (e.g. 250s under a 300s limit) so an in-flight step has
 * time to finish before the platform pulls the plug.
 */
// A 4000-char hard slice used to cut the JSON mid-string, and then /connections
// parsed nothing (skipped / timedOut / timings all lost). Clip each step's
// RESULT instead so the envelope always parses.
function serialize(out: Record<string, unknown>): string {
  const clipped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) {
    if (["at", "skipped", "timedOut", "ms"].includes(k)) { clipped[k] = v; continue; }
    const s = typeof v === "string" ? v : JSON.stringify(v);
    clipped[k] = s && s.length > 300 ? `${s.slice(0, 297)}…` : v;
  }
  const json = JSON.stringify(clipped);
  return json.length <= 4000 ? json : JSON.stringify({ at: out.at, skipped: out.skipped, timedOut: out.timedOut, ms: out.ms, truncated: true });
}

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

  // Write-through after EVERY step. The summary used to be written only by
  // finish(), so a hard-killed run left a row with finishedAt=null and NOTHING
  // else — 29 of the last 30 daily runs died that way and not one of them said
  // which step it died in or how long the earlier ones took. Now a killed run
  // still shows every completed step with its duration; only the in-flight one
  // is unrecorded. Best-effort, one small UPDATE per step.
  // Gated to long-budget jobs: the */5 gmail job would otherwise add ~60k
  // small UPDATEs a month for no diagnostic value.
  const checkpoint = async () => {
    if (!job || budgetMs < 120_000) return;
    try {
      const id = await runRowId;
      if (!id) return;
      const { prisma } = await import("@/lib/prisma");
      await prisma.cronRun.update({ where: { id }, data: { summary: serialize(out) } });
    } catch { /* progress log is best-effort */ }
  };
  const timings: Record<string, number> = {};
  out.ms = timings;
  const timedOut: string[] = [];

  return {
    out,
    elapsed: () => Date.now() - startedAtMs,
    remaining: () => Math.max(0, budgetMs - (Date.now() - startedAtMs)),
    async step(name, fn, opts) {
      if (Date.now() - startedAtMs >= budgetMs) {
        skipped.push(name);
        return;
      }
      // A step that consumes another's output must not run against a
      // half-finished predecessor: booksClassify after a timed-out booksSync
      // would classify a half-pulled ledger. The timed-out work is still
      // running in the background, so "skip and let tomorrow catch up" is the
      // honest answer (every step is idempotent).
      if (opts?.after && (timedOut.includes(opts.after) || `${opts.after}Error` in out || skipped.includes(opts.after))) {
        skipped.push(name);
        return;
      }
      const t0 = Date.now();
      try {
        // Never let one step run past what's left of the budget either — a step
        // that starts at 240s of a 250s budget with no cap is exactly how the
        // platform kill (maxDuration) beats finish() to the punch.
        const cap = Math.min(opts?.maxMs ?? Infinity, Math.max(5_000, budgetMs - (t0 - startedAtMs)));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          fn(),
          new Promise<{ timedOut: true; afterMs: number }>((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true, afterMs: cap }), cap);
          }),
        ]).finally(() => clearTimeout(timer));
        out[name] = result;
        if (result && typeof result === "object" && (result as { timedOut?: boolean }).timedOut) {
          timedOut.push(name);
          out.timedOut = timedOut;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out[`${name}Error`] = msg;
        if (!firstError) firstError = `${name}: ${msg}`.slice(0, 500);
      }
      timings[name] = Date.now() - t0;
      await checkpoint();
    },
    async finish() {
      if (!job) return;
      const ok = !firstError && skipped.length === 0 && timedOut.length === 0;
      try {
        const { prisma } = await import("@/lib/prisma");
        const id = await runRowId;
        const data = {
          finishedAt: new Date(),
          ok,
          summary: serialize(out),
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
              timedOut.length ? `timed out: ${timedOut.join(", ")}` : null,
            ].filter(Boolean).join(" · ");
            const { opsAlert, notifyInApp } = await import("@/lib/notify");
            await opsAlert(`🟥 Cron "${job}" degraded: ${bits || "unknown failure"}`);
            // Bell mirror for the owner — hour-bucketed key on top of the
            // previous-run signature guard above, so a flapping job can't spam.
            await notifyInApp({
              kind: "system",
              title: `Sync degraded — ${job}`,
              href: "/connections",
              targets: [{ roles: ["OWNER"] }],
              dedupeKey: `cron-${job}-${new Date().toISOString().slice(0, 13).replace("T", "-")}`,
            });
          }
        }
      } catch {
        /* recording/alerting is best-effort — the cron response still reports `out` */
      }
    },
  };
}
