// ---------------------------------------------------------------------------
// CRON HEALTH, ONE ROW PER EXPECTED JOB (A01-cron-health, Sep 28 2026).
//
// /connections used to read the 60 newest CronRun rows across ALL jobs. gmail
// and topaz each run every five minutes, so between them they fill 60 rows in
// about two and a half hours, and daily, daily-clients and daily-reconcile
// dropped off Sync health for most of every day. Worse, the panel only drew
// the jobs it happened to receive, so a job that had NEVER recorded a run (the
// evening cron, until today) looked exactly like a healthy one.
//
// So the list of jobs now comes from vercel.json, the schedule Vercel actually
// runs, and each job gets its own newest N rows (one windowed query). A job
// with no rows says "never recorded"; a job whose newest run is older than
// twice its cadence says "stale". /connections, the readiness report and the
// config probe all read this one function, so they cannot tell three stories.
// Read-only: nothing here writes.
// ---------------------------------------------------------------------------
import vercelConfig from "../../vercel.json";
import { prisma } from "@/lib/prisma";

export type CronRunHealth = {
  id: string;
  /** startedAt, ISO */
  at: string;
  /** null = no finishedAt: still running, or hard-killed mid-run */
  ok: boolean | null;
  error: string | null;
  skipped: string[];
  timedOut: string[];
  slowest: string | null;
  /** A firing that did nothing and finished ok: the evening route's DST twin
   *  (an `idle` note, no step run). A dot, never the job's "last run". */
  noop: boolean;
};

export type CronJobHealth = {
  job: string;
  /** The vercel.json path, or null for a job that recorded runs but is not scheduled. */
  path: string | null;
  expected: boolean;
  /** Longest gap between two scheduled firings; null when not scheduled. */
  cadenceMs: number | null;
  /** Scheduled firings per day (the evening job's DST pairs count as four). */
  firingsPerDay: number | null;
  /** Newest first. */
  runs: CronRunHealth[];
  /** The newest run that DID something (or failed) — see lastActing. */
  lastRunAt: string | null;
  /** That run's outcome; null when it has not finished or there is none. */
  lastOk: boolean | null;
  /** The newest run that is not a no-op, looked for past `runs` when every
   *  row in the window is one (the readiness report reads one row per job).
   *  Null when the job has never done anything but no-ops, or has no rows. */
  lastActing: CronRunHealth | null;
  /** Measured from the newest firing of ANY kind: a no-op still proves the
   *  schedule fires. */
  stale: boolean;
  neverRecorded: boolean;
};

export type ExpectedCron = { job: string; path: string; cadenceMs: number; firingsPerDay: number };

// Every route passes its own name to cronBudget; that name is the last path
// segment for every job scheduled today. An exception goes here, and the
// a01 drill fails if a scheduled route records under a name this map does not
// predict (it would read "never recorded" forever).
const JOB_BY_PATH: Record<string, string> = {};
export const jobForPath = (p: string) => JOB_BY_PATH[p] ?? p.replace(/\/+$/, "").split("/").pop() ?? p;

/** The minutes of the day a five-field cron fires at, or null for a shape
 *  this reader does not understand (only minute and hour may vary). */
export function firingMinutes(schedule: string): number[] | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5 || parts.slice(2).some((f) => f !== "*")) return null;
  const expand = (field: string, size: number): number[] | null => {
    const all = Array.from({ length: size }, (_, i) => i);
    if (field === "*") return all;
    const step = /^\*\/(\d+)$/.exec(field);
    if (step) return Number(step[1]) > 0 ? all.filter((v) => v % Number(step[1]) === 0) : null;
    if (/^\d+(,\d+)*$/.test(field)) {
      const vals = field.split(",").map(Number);
      return vals.every((v) => v < size) ? vals : null;
    }
    return null;
  };
  const mins = expand(parts[0], 60);
  const hours = expand(parts[1], 24);
  if (!mins || !hours) return null;
  return hours.flatMap((h) => mins.map((m) => h * 60 + m));
}

const DAY_MS = 24 * 3600_000;

/** Every job vercel.json schedules, with its cadence: the LONGEST gap between
 *  two consecutive firings across all of that path's schedules (the evening
 *  route has four UTC firings for its two ET hours, so its longest gap is 20 h,
 *  not 6). A schedule this cannot read counts as daily, so an odd job is
 *  judged loosely rather than never. */
export function expectedCrons(config: { crons?: { path: string; schedule: string }[] } = vercelConfig): ExpectedCron[] {
  const byPath = new Map<string, { minutes: Set<number>; unreadable: boolean }>();
  for (const c of config.crons ?? []) {
    const e = byPath.get(c.path) ?? { minutes: new Set<number>(), unreadable: false };
    const mins = firingMinutes(c.schedule);
    if (mins) for (const m of mins) e.minutes.add(m);
    else e.unreadable = true;
    byPath.set(c.path, e);
  }
  return [...byPath].map(([path, e]) => {
    const sorted = [...e.minutes].sort((a, b) => a - b);
    let gap = 0;
    for (let i = 0; i < sorted.length; i++) {
      const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 1440;
      gap = Math.max(gap, next - sorted[i]);
    }
    const cadenceMs = e.unreadable || sorted.length === 0 ? DAY_MS : gap * 60_000;
    return { job: jobForPath(path), path, cadenceMs, firingsPerDay: sorted.length || 1 };
  });
}

/** Twice the cadence, but never under 15 minutes: one late five-minute tick is
 *  Vercel's jitter, not an outage, and a panel that flickers red is ignored. */
export const staleAfterMs = (cadenceMs: number) => Math.max(2 * cadenceMs, 15 * 60_000);

type Row = { id: string; job: string; startedAt: Date; finishedAt: Date | null; ok: boolean; error: string | null; summary: string | null };

function runHealth(r: Row): CronRunHealth {
  let skipped: string[] = [];
  let timedOut: string[] = [];
  let slowest: string | null = null;
  let idle = false;
  let stepsRun = 0;
  try {
    const s = r.summary ? (JSON.parse(r.summary) as { skipped?: string[]; timedOut?: string[]; ms?: Record<string, number>; idle?: unknown }) : null;
    if (Array.isArray(s?.skipped)) skipped = s.skipped;
    if (Array.isArray(s?.timedOut)) timedOut = s.timedOut;
    idle = s?.idle !== undefined && s?.idle !== null;
    stepsRun = s?.ms && typeof s.ms === "object" ? Object.keys(s.ms).length : 0;
    // Per-step timings are checkpointed after every step (lib/cron), so even a
    // hard-killed run says which step was the hog.
    const ms = s?.ms && typeof s.ms === "object" ? Object.entries(s.ms) : [];
    if (ms.length) {
      const [name, t] = ms.reduce((a, b) => (b[1] > a[1] ? b : a));
      slowest = `${name} ${Math.round(t / 1000)}s`;
    }
  } catch { /* unreadable summary */ }
  // A run whose steps all returned can still have failed at part of its job:
  // the comms scan reads two mailboxes and says `degraded` when one of them was
  // not read (§9, Sep 26). That is not green.
  const degraded = r.job === "gmail" && /\\?"degraded\\?":true/.test(r.summary ?? "");
  const ok = r.finishedAt ? r.ok && !degraded : null;
  return {
    id: r.id,
    at: r.startedAt.toISOString(),
    ok,
    error: r.error ?? (degraded ? "degraded — a mailbox was not read (see Mailboxes below)" : null),
    skipped,
    timedOut,
    slowest,
    // A failure is never a no-op, whatever it was marked.
    noop: idle && ok === true && stepsRun === 0 && skipped.length === 0 && timedOut.length === 0,
  };
}

/**
 * The newest `perJob` runs of every job, plus every job vercel.json expects
 * even when it has no row at all. Throws when CronRun cannot be read (callers
 * decide whether that is "unknown" or an error); never writes.
 */
export async function cronHealthByJob(perJob = 5, now: Date = new Date()): Promise<CronJobHealth[]> {
  const n = Math.max(1, Math.min(50, Math.floor(perJob)));
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "id", "job", "startedAt", "finishedAt", "ok", "error", "summary"
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY "job" ORDER BY "startedAt" DESC) AS rn
      FROM "CronRun"
    ) x
    WHERE rn <= ${n}
    ORDER BY "job", "startedAt" DESC`;
  const byJob = new Map<string, CronRunHealth[]>();
  for (const r of rows) byJob.set(r.job, [...(byJob.get(r.job) ?? []), runHealth(r)]);

  // THE NEWEST RUN THAT DID SOMETHING (review, Sep 28). The evening route
  // records its DST twin — all through EDT, the firing an hour AFTER the one
  // that acts — as an ok `idle` row. As "the newest run" it turned a failed
  // 7 PM digest green by 8 PM, on /connections, in the readiness report
  // (which reads one row per job) and in the probe. A no-op is a dot; the
  // last run and its outcome come from the newest firing that ran a step or
  // failed. When the window holds only no-ops, a few more rows are read.
  const acting = new Map<string, CronRunHealth | null>();
  for (const [job, runs] of byJob) {
    const hit = runs.find((r) => !r.noop) ?? null;
    if (hit || runs.length === 0) { acting.set(job, hit); continue; }
    const more = await prisma.cronRun
      .findMany({ where: { job }, orderBy: { startedAt: "desc" }, take: 12, select: { id: true, job: true, startedAt: true, finishedAt: true, ok: true, error: true, summary: true } })
      .catch(() => [] as Row[]);
    acting.set(job, more.map(runHealth).find((r) => !r.noop) ?? null);
  }

  const expected = expectedCrons();
  const jobs = new Set([...expected.map((e) => e.job), ...byJob.keys()]);
  const out: CronJobHealth[] = [];
  for (const job of jobs) {
    const e = expected.find((x) => x.job === job) ?? null;
    const runs = byJob.get(job) ?? [];
    const latest = runs[0] ?? null;
    const lastActing = acting.get(job) ?? null;
    // A job that has only ever idled still ran: its newest row speaks.
    const judged = lastActing ?? latest;
    out.push({
      job,
      path: e?.path ?? null,
      expected: !!e,
      cadenceMs: e?.cadenceMs ?? null,
      firingsPerDay: e?.firingsPerDay ?? null,
      runs,
      lastRunAt: judged?.at ?? null,
      lastOk: judged?.ok ?? null,
      lastActing,
      // Only a SCHEDULED job can be late; a job nobody schedules any more is
      // shown for its history, not paged about.
      stale: !!e && !!latest && now.getTime() - new Date(latest.at).getTime() > staleAfterMs(e.cadenceMs),
      neverRecorded: !!e && runs.length === 0,
    });
  }
  return out.sort((a, b) => a.job.localeCompare(b.job));
}

/** "every 5 min" · "hourly" · "4× a day" · "daily", for a job's schedule. */
export function cadenceLabel(j: Pick<CronJobHealth, "firingsPerDay" | "cadenceMs">): string {
  if (!j.firingsPerDay || !j.cadenceMs) return "not scheduled";
  if (j.firingsPerDay >= 24) {
    const mins = Math.round(1440 / j.firingsPerDay);
    return mins === 60 ? "hourly" : `every ${mins} min`;
  }
  return j.firingsPerDay === 1 ? "daily" : `${j.firingsPerDay}× a day`;
}
