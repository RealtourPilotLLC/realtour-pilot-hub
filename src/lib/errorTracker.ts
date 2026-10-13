import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import {
  clientSourceFor,
  describeThrown,
  fingerprintOf,
  isIgnorable,
  normalizeRoute,
  scrubContext,
  scrubPath,
  scrubText,
  MESSAGE_MAX,
  STACK_MAX,
  type ErrorSource,
} from "@/lib/errorScrub";
import { stepOutcome, type StepPersistence } from "@/lib/cronNoise";

// ---------------------------------------------------------------------------
// THE ERROR TRACKER (Oct 6 2026). Jordan: "I also want to make sure we are
// tracking any errors that arise so we can get the reports of them and fix
// them quickly."
//
// WHERE ERRORS COME FROM
//   · src/instrumentation.ts onRequestError → captureRequestError: every
//     uncaught server error — a page/server-component render, a route handler,
//     a server action, the middleware;
//   · /api/errors (src/app/api/errors/route.ts): browser errors — the error
//     screens (app/error.tsx, app/global-error.tsx) and the window error /
//     unhandledrejection listener (src/instrumentation-client.ts), staff and
//     client portal alike;
//   · lib/cron.ts: every cron step that throws;
//   · reportError(err, { area }): the few swallowed catches that matter (the
//     Review Room's background follow-ups, an outbox send, the Aryeo and
//     OpenPhone webhook processors).
//
// ONE BUG, ONE ROW. Rows are keyed by fingerprint (normalised message + top
// stack frame + route, errorScrub.ts) and counted. A row marked FIXED that
// happens again is REOPENED; IGNORED keeps counting silently.
//
// RECORDING NEVER HURTS THE PERSON WHO HIT THE ERROR. Nothing here throws;
// reportError returns at once (the write runs alongside and after() keeps the
// lambda alive for it); captureRequestError is time-capped. If the table has
// not been pushed yet, every call is a silent no-op (checked once, then
// remembered for five minutes).
//
// TRANSIENT CRON FAILURES (Oct 9 2026, lib/cronNoise.ts). A cron step that
// fails with a provider timeout / 5xx is recorded like anything else, but its
// row is marked `transient` in its context and stays quiet — no alert, not
// counted in the daily digest — until the step has failed 3 runs in a row or
// gone 6 hours without a success. Then it alerts ONCE ("keeps failing") and
// stamps `persistentSince`, which sticks: from then on it is an ordinary open
// error until Jordan marks it fixed (a reopen starts the quiet count again).
//
// ALERTS. A NEW error, or a FIXED one that came back, tells Jordan — a bell row
// addressed to him and his Slack DM through notify.notifyStaffSms, which asks
// notifySchedule.holdFor first (so his Saturday-until-7:30 PM quiet window
// HOLDS the DM and releases it then; the bell is never held). At most one alert
// per error per 6 hours, and at most ALERT_CAP_PER_HOUR across all errors in
// an hour — past that, one "more errors this hour" line and the rest wait for
// the page and the daily digest (errorDigest, from the daily cron).
// ---------------------------------------------------------------------------

export const ALERT_DEDUPE_MS = 6 * 3600_000;
export const ALERT_CAP_PER_HOUR = 10;
/** New CLIENT fingerprints per hour, across all visitors — a flood of made-up
 *  messages from the public beacon cannot grow the table past this. */
export const NEW_CLIENT_ROWS_PER_HOUR = 100;
const MISSING_TABLE_RETRY_MS = 5 * 60_000;
const CAPTURE_CAP_MS = 4000;

export type ErrorStatus = "OPEN" | "FIXED" | "IGNORED";

export type ErrorInput = {
  error: unknown;
  source: ErrorSource;
  /** The concrete path (scrubbed before storage). */
  path?: string | null;
  /** The grouping route; defaults to the normalised path. */
  route?: string | null;
  digest?: string | null;
  userId?: string | null;
  userRole?: string | null;
  context?: Record<string, unknown>;
  at?: Date;
  /** false = record only, never alert (drills, the digest's own failures). */
  alert?: boolean;
  /** A cron step's TRANSIENT provider failure (lib/cronNoise.ts): recorded
   *  always, alerted and counted in the digest only once it persists. */
  persistence?: StepPersistence;
};

export type RecordResult = {
  id: string;
  fingerprint: string;
  isNew: boolean;
  reopened: boolean;
  alert: AlertOutcome | null;
};

export type AlertOutcome = "sent" | "deduped" | "capped" | "ignored" | "failed";

// ---- only the real deployment records (Oct 9 2026) --------------------------
//
// Local dev, `next start` on a laptop, preview deployments and the drills all
// share the LIVE database through .env — and on Oct 9 a mid-edit parse error on
// a developer's localhost:3000 landed in production's ErrorEvent table and
// Slack-messaged Jordan. So the tracker records, alerts and digests ONLY when
// it is the production deployment: VERCEL_ENV === "production" (Vercel sets
// it; it is absent everywhere else, the drills' scrubbed environment
// included). A drill that tests recording turns it on through the seam below —
// explicitly, never by an environment variable leaking in. Reading the table
// (the Errors page, marking fixed) is not gated.

let enabledOverride: boolean | null = null;
/** Test seam: true/false forces recording on/off; null returns to the rule. */
export function setErrorTrackingForTests(on: boolean | null): void {
  enabledOverride = on;
}
/** Is this process the production deployment the tracker records for? */
export function errorTrackingEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  return process.env.VERCEL_ENV === "production";
}

// ---- the table may not exist yet ------------------------------------------

let missingUntil = 0;
/** Test seam: forget the "table missing" memory. */
export function resetErrorTrackerState(): void {
  missingUntil = 0;
  limiter.reset();
}

function isMissingTable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "P2021" || code === "P2022") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /ErrorEvent.*does not exist|relation "?(public\.)?"?ErrorEvent"? does not exist|table .*ErrorEvent.* does not exist/i.test(msg);
}

type ErrorEventDelegate = typeof prisma.errorEvent;
function table(): ErrorEventDelegate | null {
  if (Date.now() < missingUntil) return null;
  const t = (prisma as unknown as { errorEvent?: ErrorEventDelegate }).errorEvent;
  return t ?? null;
}
function noteMissing(e: unknown): boolean {
  if (!isMissingTable(e)) return false;
  missingUntil = Date.now() + MISSING_TABLE_RETRY_MS;
  return true;
}

// ---- in-flight writes, so a drill (or a cron) can wait for them -----------

const pending = new Set<Promise<unknown>>();
function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  void p.finally(() => pending.delete(p)).catch(() => {});
  return p;
}
/** Wait for every report still being written. Never throws. */
export async function flushErrorReports(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

function capped<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}

// ---- recording ----------------------------------------------------------------

const CLIENT_SOURCES: ErrorSource[] = ["client", "client-portal"];

/**
 * Record one occurrence. Returns what happened, or null when nothing was
 * recorded (ignorable error, table missing, a store failure). NEVER throws.
 */
export async function recordError(input: ErrorInput): Promise<RecordResult | null> {
  try {
    if (!errorTrackingEnabled()) return null;
    const d = describeThrown(input.error);
    const digest = input.digest ?? d.digest;
    if (isIgnorable({ message: d.message, digest, stack: d.stack, name: d.name })) return null;
    const db = table();
    if (!db) return null;

    const now = input.at ?? new Date();
    const path = scrubPath(input.path ?? null);
    const route = input.route ? scrubText(input.route, 200) : normalizeRoute(input.path ?? null);
    const message = scrubText(d.message || "Unknown error", MESSAGE_MAX);
    const stack = d.stack ? scrubText(d.stack, STACK_MAX) : null;
    const fingerprint = fingerprintOf({ message: d.message || "Unknown error", stack: d.stack, route });
    const transient = input.persistence ?? null;
    const transientContext = (persistentSince: string | null) =>
      transient
        ? {
            ...(input.context ?? {}),
            transient: true,
            failedRunsInARow: transient.consecutiveFailures,
            lastSuccessAt: transient.lastSuccessAt,
            persistentSince,
            ...(transient.rule ? { rule: transient.rule } : {}),
          }
        : input.context;
    let context = scrubContext(transientContext(transient?.persistent ? now.toISOString() : null));
    const user = {
      lastUserId: input.userId ? String(input.userId).slice(0, 40) : null,
      lastUserRole: input.userRole ? String(input.userRole).slice(0, 20) : null,
    };

    let existing: { id: string; recentPaths: string | null; status: string; context: string | null; resolvedBy: string | null } | null;
    try {
      existing = await db.findUnique({ where: { fingerprint }, select: { id: true, recentPaths: true, status: true, context: true, resolvedBy: true } });
    } catch (e) {
      if (noteMissing(e)) return null;
      throw e;
    }

    if (!existing) {
      // A flood of invented messages from the public beacon stops here.
      if (CLIENT_SOURCES.includes(input.source)) {
        const fresh = await db.count({ where: { source: { in: CLIENT_SOURCES }, firstSeenAt: { gte: new Date(now.getTime() - 3600_000) } } });
        if (fresh >= NEW_CLIENT_ROWS_PER_HOUR) return null;
      }
      try {
        const row = await db.create({
          data: {
            fingerprint,
            source: input.source,
            errorName: d.name ? scrubText(d.name, 80) : null,
            message,
            stack,
            route,
            lastPath: path,
            recentPaths: path ? JSON.stringify([path]) : null,
            digest: digest ? digest.slice(0, 80) : null,
            context,
            firstSeenAt: now,
            lastSeenAt: now,
            ...user,
          },
          select: { id: true },
        });
        const quiet = input.alert === false || (transient !== null && !transient.persistent);
        const alert = quiet ? null : await alertForError({ id: row.id, fingerprint, message, route, source: input.source, count: 1, rule: transient?.rule ?? null }, transient ? "persistent" : "new", now);
        return { id: row.id, fingerprint, isNew: true, reopened: false, alert };
      } catch (e) {
        if ((e as { code?: string } | null)?.code !== "P2002") throw e;
        // Somebody else created it a moment ago — count this one on their row.
        existing = await db.findUnique({ where: { fingerprint }, select: { id: true, recentPaths: true, status: true, context: true, resolvedBy: true } });
        if (!existing) return null;
      }
    }

    // A transient row that already persisted keeps its stamp (it stays an open
    // error, counted in the digest) — unless it was marked fixed, in which case
    // this occurrence starts the quiet count again.
    let escalateNow = false;
    if (transient) {
      let prior: { persistentSince?: unknown } = {};
      try { prior = existing.context ? (JSON.parse(existing.context) as { persistentSince?: unknown }) : {}; } catch { prior = {}; }
      const kept = existing.status !== "FIXED" && typeof prior.persistentSince === "string" ? prior.persistentSince : null;
      escalateNow = transient.persistent && !kept;
      context = scrubContext(transientContext(kept ?? (transient.persistent ? now.toISOString() : null)));
    }

    let recent: string[] = [];
    try { recent = existing.recentPaths ? (JSON.parse(existing.recentPaths) as string[]) : []; } catch { recent = []; }
    if (path && !recent.includes(path)) recent = [path, ...recent].slice(0, 5);

    const row = await db.update({
      where: { fingerprint },
      data: {
        count: { increment: 1 },
        lastSeenAt: now,
        ...(path ? { lastPath: path, recentPaths: JSON.stringify(recent) } : {}),
        ...(digest ? { digest: digest.slice(0, 80) } : {}),
        ...(context ? { context } : {}),
        ...(stack ? { stack } : {}),
        ...user,
      },
      select: { id: true, count: true, status: true },
    });
    // FIXED and it happened again: reopen. The conditional update is the claim,
    // so two lambdas hitting it together reopen (and alert) once.
    const reopen = await db.updateMany({
      where: { fingerprint, status: "FIXED" },
      data: { status: "OPEN", reopenedAt: now, reopenCount: { increment: 1 }, resolvedAt: null, resolvedBy: null },
    });
    const reopened = reopen.count === 1;
    // A row the tracker closed ITSELF (it had stopped happening — B8) comes
    // back OPEN, counted in the daily report, but without the "you marked
    // this fixed and it is back" alert: nobody claimed it was fixed.
    const wasAutoResolved = isAutoResolved(existing.resolvedBy);
    let alert: AlertOutcome | null = null;
    if (input.alert !== false && row.status !== "IGNORED") {
      if (transient) {
        // Quiet until it persists; then once, as "keeps failing".
        if (escalateNow) alert = await alertForError({ id: row.id, fingerprint, message, route, source: input.source, count: row.count, rule: transient.rule }, "persistent", now);
      } else if (reopened && !wasAutoResolved) {
        alert = await alertForError({ id: row.id, fingerprint, message, route, source: input.source, count: row.count }, "reopened", now);
      }
    }
    return { id: row.id, fingerprint, isNew: false, reopened, alert };
  } catch (e) {
    if (noteMissing(e)) return null;
    try { console.warn("[errors] could not record an error", e instanceof Error ? e.message : e); } catch { /* nothing */ }
    return null;
  }
}

/**
 * For a catch block that swallows an error on purpose: write it down, return
 * at once. `area` names the place ("review:approve/dropboxCopy") and is the
 * grouping route. Never throws, never waits.
 */
export function reportError(err: unknown, ctx: { area: string; source?: ErrorSource; path?: string | null } & Record<string, unknown>): void {
  try {
    if (!errorTrackingEnabled()) return;
    const { area, source, path, ...rest } = ctx;
    const p = track(recordError({ error: err, source: source ?? "background", route: area, path: path ?? null, context: { area, ...rest } }));
    try {
      after(() => p.then(() => undefined));
    } catch {
      /* no request scope (a cron, a script): the write is already running */
    }
  } catch {
    /* reporting must never break the caller */
  }
}

// ---- server request errors (instrumentation.ts) -----------------------------

type RequestInfo = { path: string; method: string; headers: Record<string, string | string[] | undefined> };
type RequestCtx = { routePath?: string; routeType?: string; renderSource?: string; routerKind?: string };

function cookieValue(headers: RequestInfo["headers"], name: string): string | null {
  const raw = headers?.cookie;
  const all = Array.isArray(raw) ? raw.join("; ") : raw ?? "";
  for (const part of all.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

/** Who was signed in, from the session cookie alone (a signature check, no
 *  database read). Only the id and role are kept — never the email or token. */
export async function sessionUserFromHeaders(headers: RequestInfo["headers"]): Promise<{ id: string; role: string } | null> {
  try {
    const { verifySession, SESSION_COOKIE } = await import("@/lib/auth/jwt");
    const s = await verifySession(cookieValue(headers, SESSION_COOKIE));
    return s ? { id: s.uid, role: s.role } : null;
  } catch {
    return null;
  }
}

export function sourceForRequest(routeType: string | undefined, path: string | null): ErrorSource {
  if (routeType === "action") return "server-action";
  if (routeType === "route") return path?.startsWith("/api/cron/") ? "cron" : "route-handler";
  return "server-request";
}

export async function captureRequestError(err: unknown, request: RequestInfo, context: RequestCtx): Promise<void> {
  try {
    if (!errorTrackingEnabled()) return;
    const path = request?.path ?? null;
    const user = await sessionUserFromHeaders(request?.headers ?? {});
    // The route FILE (/app/projects/[id]/page) is the best grouping key Next
    // gives us — already free of ids and tokens.
    const route = context?.routePath ? `${context.routePath}` : null;
    await capped(
      track(
        recordError({
          error: err,
          source: sourceForRequest(context?.routeType, path),
          path,
          route,
          userId: user?.id ?? null,
          userRole: user?.role ?? null,
          context: { routeType: context?.routeType ?? null, method: request?.method ?? null, renderSource: context?.renderSource ?? null },
        }),
      ),
      CAPTURE_CAP_MS,
    );
  } catch {
    /* never */
  }
}

// ---- browser reports (/api/errors) --------------------------------------------

export const CLIENT_BODY_MAX = 16_000;

/** Per-IP and per-instance rate limits for the public beacon (in memory: a
 *  lambda instance's own view, which is what a flood from one browser hits). */
function makeLimiter(opts: { perKeyPerMinute: number; perKeyPerHour: number; globalPerMinute: number }) {
  let hits = new Map<string, number[]>();
  let global: number[] = [];
  return {
    allow(key: string, now = Date.now()): boolean {
      global = global.filter((t) => now - t < 60_000);
      if (global.length >= opts.globalPerMinute) return false;
      const mine = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
      if (mine.length >= opts.perKeyPerHour) return false;
      if (mine.filter((t) => now - t < 60_000).length >= opts.perKeyPerMinute) return false;
      mine.push(now);
      global.push(now);
      hits.set(key, mine);
      if (hits.size > 5000) hits = new Map([...hits].slice(-2500));
      return true;
    },
    reset() {
      hits = new Map();
      global = [];
    },
  };
}
export const limiter = makeLimiter({ perKeyPerMinute: 10, perKeyPerHour: 60, globalPerMinute: 120 });

export type ClientReport = { message?: unknown; name?: unknown; stack?: unknown; path?: unknown; boundary?: unknown; digest?: unknown };

/** Record one browser report. The body is a description of a JS error and
 *  nothing else is taken from it; the user comes from the staff session
 *  cookie (portal visitors stay anonymous). */
export async function recordClientReport(body: ClientReport, user: { id: string; role: string } | null, at?: Date): Promise<RecordResult | null> {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
  const message = str(body.message, 2000);
  if (!message) return null;
  const path = str(body.path, 500);
  const err = { name: str(body.name, 80) ?? "Error", message, stack: str(body.stack, STACK_MAX) };
  return recordError({
    error: err,
    source: clientSourceFor(scrubPath(path)),
    path,
    digest: str(body.digest, 80),
    userId: user?.id ?? null,
    userRole: user?.role ?? null,
    context: { boundary: str(body.boundary, 20) },
    at,
  });
}

// ---- alerts ---------------------------------------------------------------------

type AlertRow = { id: string; fingerprint: string; message: string; route: string | null; source: string; count: number; rule?: string | null };

const hourKey = (d: Date) => d.toISOString().slice(0, 13).replace("T", "-");

async function alertForError(row: AlertRow, why: "new" | "reopened" | "persistent", now: Date): Promise<AlertOutcome> {
  try {
    const db = table();
    if (!db) return "failed";
    // Per-error dedupe: the conditional stamp is the claim (one alert per 6 h).
    const claim = await db.updateMany({
      where: { id: row.id, status: "OPEN", OR: [{ lastAlertedAt: null }, { lastAlertedAt: { lt: new Date(now.getTime() - ALERT_DEDUPE_MS) } }] },
      data: { lastAlertedAt: now },
    });
    if (claim.count !== 1) return "deduped";
    // Global cap: this row is already counted in the hour.
    const inHour = await db.count({ where: { lastAlertedAt: { gte: new Date(now.getTime() - 3600_000) } } });
    if (inHour > ALERT_CAP_PER_HOUR) {
      await deliverToOwner({
        kind: "error_report",
        title: "More new errors than usual this hour",
        body: `Over ${ALERT_CAP_PER_HOUR} new errors in the last hour — the rest are on the Errors page.`,
        href: "/settings/errors",
        slack: `🐞 More than ${ALERT_CAP_PER_HOUR} new errors in the last hour. Further error alerts are paused until next hour — every one is listed at ${link("/settings/errors")}`,
        dedupeKey: `error-overflow-${hourKey(now)}`,
      });
      return "capped";
    }
    const label = why === "new" ? "New error" : why === "persistent" ? "Keeps failing" : "Error is back (was marked fixed)";
    const where = row.route ? ` · ${row.route}` : "";
    const why2 = why === "persistent" && row.rule ? ` · ${row.rule}` : "";
    const sent = await deliverToOwner({
      kind: "error_report",
      title: `${label} — ${row.message}`.slice(0, 90),
      body: `${row.source}${where}${why2}${why !== "new" ? ` · ${row.count}× in all` : ""}`.slice(0, 140),
      href: `/settings/errors?id=${row.id}`,
      slack: `🐞 ${label} (${row.source}${where}${why2}):\n> ${row.message.replace(/\s+/g, " ").slice(0, 300)}\n${link(`/settings/errors?id=${row.id}`)}`,
      dedupeKey: `error-${row.fingerprint}-${hourKey(now)}`,
    });
    return sent ? "sent" : "failed";
  } catch (e) {
    try { console.warn("[errors] alert failed", e instanceof Error ? e.message : e); } catch { /* nothing */ }
    return "failed";
  }
}

function link(path: string): string {
  try {
    return `${appBase()}${path}`;
  } catch {
    return path;
  }
}

/**
 * One notice for Jordan: a bell row addressed to each OWNER roster row (never
 * held — notifySchedule rule 1) and the Slack DM through notifyStaffSms, which
 * holds it inside his quiet time and releases it after. The bell row's unique
 * dedupeKey is the claim — only the call that wrote it sends the DM. With no
 * owner roster row, an OWNER-role bell row and nothing else.
 */
async function deliverToOwner(n: { kind: string; title: string; body: string; href: string; slack: string; dedupeKey: string }): Promise<boolean> {
  const { notifyInApp, notifyStaffSms, logDelivery } = await import("@/lib/notify");
  const { ownerTeamMemberIds } = await import("@/lib/smsPrefs");
  const owners = await ownerTeamMemberIds().catch(() => [] as string[]);
  if (owners.length === 0) {
    await notifyInApp({ kind: n.kind, title: n.title, body: n.body, href: n.href, targets: [{ roles: ["OWNER"] }], dedupeKey: n.dedupeKey });
    return true;
  }
  const winners: string[] = [];
  for (let i = 0; i < owners.length; i++) {
    const row = await prisma.notification
      .create({
        data: { kind: n.kind, title: n.title.slice(0, 90), body: n.body.slice(0, 140), href: n.href, audience: JSON.stringify(["OWNER"]), userKey: `tm:${owners[i]}`, dedupeKey: `${n.dedupeKey}-${i}` },
        select: { id: true },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code === "P2002") return null;
        throw e;
      });
    if (!row) continue;
    winners.push(owners[i]);
    await logDelivery({ notificationId: row.id, teamMemberId: owners[i], kind: n.kind, channel: "bell", status: "sent" });
  }
  if (winners.length === 0) return false;
  await notifyStaffSms(winners, n.slack, n.kind);
  return true;
}

// ---- the daily digest (cron/daily) ----------------------------------------------

/** A transient cron row (cronNoise) that has not persisted: recorded, quiet. */
export function isQuietTransient(context: string | null | undefined): boolean {
  if (!context) return false;
  try {
    const c = JSON.parse(context) as { transient?: unknown; persistentSince?: unknown };
    return c.transient === true && typeof c.persistentSince !== "string";
  } catch {
    return false;
  }
}

export async function errorDigest(now: Date = new Date()): Promise<{ sent: boolean; open: number; recent?: number; watching?: number; reason?: string }> {
  if (!errorTrackingEnabled()) return { sent: false, open: 0, reason: "not the production deployment" };
  const db = table();
  if (!db) return { sent: false, open: 0, reason: "error table not present" };
  try {
    const openRows = await db.findMany({
      where: { status: "OPEN" },
      orderBy: [{ lastSeenAt: "desc" }],
      take: 200,
      select: { id: true, message: true, route: true, source: true, count: true, lastSeenAt: true, context: true },
    });
    // A transient cron failure that never persisted is not an open problem —
    // the next run picked the work up. Said in one line, never counted.
    const watching = openRows.filter((r) => isQuietTransient(r.context));
    const open = openRows.filter((r) => !isQuietTransient(r.context));
    if (open.length === 0) return { sent: false, open: 0, watching: watching.length, reason: "no open errors" };
    const dayAgo = now.getTime() - 24 * 3600_000;
    const recent = open.filter((r) => r.lastSeenAt.getTime() >= dayAgo);
    const top = (recent.length ? recent : open).sort((a, b) => b.count - a.count).slice(0, 8);
    const { etDayKey } = await import("@/lib/datetime");
    const lines = top.map((r) => `• ${r.count}× ${r.message.replace(/\s+/g, " ").slice(0, 90)}${r.route ? ` — ${r.route}` : ""}`);
    const more = (recent.length ? recent.length : open.length) - top.length;
    const slack = [
      `🐞 Daily error report — ${open.length} open, ${recent.length} seen in the last 24 h`,
      ...lines,
      ...(more > 0 ? [`…and ${more} more`] : []),
      ...(watching.length ? [`(${watching.length} brief provider timeout${watching.length === 1 ? "" : "s"} in scheduled jobs not counted — each recovered on its next run)`] : []),
      link("/settings/errors"),
    ].join("\n");
    const sent = await deliverToOwner({
      kind: "error_report",
      title: `${open.length} open error${open.length === 1 ? "" : "s"} — daily report`,
      body: `${recent.length} seen in the last 24 hours`,
      href: "/settings/errors",
      slack,
      dedupeKey: `error-digest-${etDayKey(now)}`,
    });
    return { sent, open: open.length, recent: recent.length, watching: watching.length, ...(sent ? {} : { reason: "already sent today" }) };
  } catch (e) {
    if (noteMissing(e)) return { sent: false, open: 0, reason: "error table not present" };
    throw e;
  }
}

// ---- errors that stopped happening close themselves (B8, Oct 13 2026) -------------
//
// Jordan's Errors page filled with rows nobody would ever mark fixed: a cron
// step that failed one night and has worked every run since, a page error from
// a bug fixed two deploys ago. Each stays OPEN, in the daily report, for ever.
// So a server-side error tied to a route or a step closes itself — status
// FIXED (the page's "resolved"), resolvedBy saying why, starting "auto:" — once
//   · a CRON STEP's error: that same step has since run cleanly
//     AUTO_RESOLVE_CLEAN_RUNS times in a row (read from the job's own CronRun
//     rows, the record cronNoise reads), or it has had at least one clean run
//     and no recurrence for 24 hours, or the step no longer runs at all (three
//     runs of its job since, none of them running it — a retired step);
//   · any other server error keyed to a route or an area: no recurrence for
//     24 hours.
// Browser errors are left alone (a page nobody has opened since is not a fix).
// Nothing is sent. The alerting rules are untouched (cronNoise.ts): if it
// happens again it reopens as before — quietly, counted in the daily report,
// because nobody claimed it was fixed (see recordError).

export const AUTO_RESOLVE_CLEAN_RUNS = 3;
export const AUTO_RESOLVE_QUIET_MS = 24 * 3600_000;
const AUTO_PREFIX = "auto:";
/** Server-side sources an auto-resolve may close. "cron" rows go through the step history. */
const QUIET_RESOLVE_SOURCES: ErrorSource[] = ["server-request", "server-action", "route-handler", "background"];

/** Did the tracker close this row itself (rather than a person)? */
export function isAutoResolved(resolvedBy: string | null | undefined): boolean {
  return typeof resolvedBy === "string" && resolvedBy.startsWith(AUTO_PREFIX);
}

type RunRow = { startedAt: Date; summary: string | null; error: string | null };

/**
 * Pure: should this cron step's open error close, given the job's runs that
 * STARTED AFTER the error was last seen (newest first)? Returns the reason, or
 * null to leave it open.
 */
export function cronStepResolution(step: string, lastSeenAt: Date, runsSince: RunRow[], now: Date): string | null {
  let clean = 0;
  let ran = false;
  for (const r of runsSince) {
    const o = stepOutcome(r, step);
    if (o === "failed") break; // cannot be newer than lastSeenAt, but never count past one
    if (o === "ok") { clean++; ran = true; }
    else if (o === "timedOut") ran = true; // ran, no answer: neither a clean run nor a failure
  }
  if (clean >= AUTO_RESOLVE_CLEAN_RUNS) return `${AUTO_PREFIX} ran cleanly ${clean} times in a row since`;
  if (clean >= 1 && now.getTime() - lastSeenAt.getTime() >= AUTO_RESOLVE_QUIET_MS) return `${AUTO_PREFIX} no recurrence in 24 h, and the step has run cleanly since`;
  if (!ran && runsSince.length >= AUTO_RESOLVE_CLEAN_RUNS && now.getTime() - lastSeenAt.getTime() >= AUTO_RESOLVE_QUIET_MS) return `${AUTO_PREFIX} the step no longer runs (${runsSince.length} runs of its job since without it)`;
  return null;
}

/** "cron:sync/orders" → { job: "sync", step: "orders" }. */
function cronRoute(route: string | null): { job: string; step: string } | null {
  const m = /^cron:([^/]+)\/(.+)$/.exec(route ?? "");
  return m ? { job: m[1], step: m[2] } : null;
}

/** Close the open cron-step rows `rows` whose step's history says it stopped failing. */
async function resolveCronRows(db: ErrorEventDelegate, rows: { id: string; route: string | null; lastSeenAt: Date }[], now: Date): Promise<number> {
  let resolved = 0;
  const byJob = new Map<string, { id: string; step: string; lastSeenAt: Date }[]>();
  for (const r of rows) {
    const c = cronRoute(r.route);
    if (!c) continue;
    byJob.set(c.job, [...(byJob.get(c.job) ?? []), { id: r.id, step: c.step, lastSeenAt: r.lastSeenAt }]);
  }
  for (const [job, list] of byJob) {
    const oldest = new Date(Math.min(...list.map((x) => x.lastSeenAt.getTime())));
    const runs = await prisma.cronRun.findMany({
      where: { job, startedAt: { gt: oldest } },
      orderBy: { startedAt: "desc" },
      take: 200,
      select: { startedAt: true, summary: true, error: true },
    });
    for (const x of list) {
      const since = runs.filter((r) => r.startedAt.getTime() > x.lastSeenAt.getTime());
      const why = cronStepResolution(x.step, x.lastSeenAt, since, now);
      if (!why) continue;
      // Conditional on lastSeenAt: an occurrence recorded since this read wins.
      const r = await db.updateMany({ where: { id: x.id, status: "OPEN", lastSeenAt: x.lastSeenAt }, data: { status: "FIXED", resolvedAt: now, resolvedBy: why.slice(0, 120) } });
      resolved += r.count;
    }
  }
  return resolved;
}

/**
 * From cron.ts finish(): the steps of `job` that just ran cleanly may close
 * their own open errors. Bounded, never throws.
 */
export async function autoResolveCleanCronSteps(job: string, cleanSteps: string[], now: Date = new Date()): Promise<{ resolved: number }> {
  try {
    if (!errorTrackingEnabled() || cleanSteps.length === 0) return { resolved: 0 };
    const db = table();
    if (!db) return { resolved: 0 };
    const rows = await db.findMany({
      where: { status: "OPEN", source: "cron", route: { in: cleanSteps.map((s) => `cron:${job}/${s}`) } },
      select: { id: true, route: true, lastSeenAt: true },
      take: 50,
    });
    if (rows.length === 0) return { resolved: 0 };
    return { resolved: await resolveCronRows(db, rows, now) };
  } catch (e) {
    noteMissing(e);
    return { resolved: 0 };
  }
}

/**
 * Hourly (cron/sync): server errors quiet for 24 hours close; cron-step errors
 * not seen for 24 hours are judged by their step's history (a retired step's
 * error closes; a daily step that failed yesterday and has not run since does
 * not). Never throws.
 */
export async function autoResolveQuietErrors(now: Date = new Date()): Promise<{ resolved: number; cron: number } | { skipped: string }> {
  if (!errorTrackingEnabled()) return { skipped: "not the production deployment" };
  const db = table();
  if (!db) return { skipped: "error table not present" };
  try {
    const before = new Date(now.getTime() - AUTO_RESOLVE_QUIET_MS);
    const server = await db.updateMany({
      where: { status: "OPEN", source: { in: QUIET_RESOLVE_SOURCES }, route: { not: null }, lastSeenAt: { lt: before } },
      data: { status: "FIXED", resolvedAt: now, resolvedBy: `${AUTO_PREFIX} no recurrence in 24 h` },
    });
    const quietCron = await db.findMany({
      where: { status: "OPEN", source: "cron", route: { startsWith: "cron:" }, lastSeenAt: { lt: before } },
      select: { id: true, route: true, lastSeenAt: true },
      orderBy: { lastSeenAt: "asc" },
      take: 100,
    });
    const cron = quietCron.length ? await resolveCronRows(db, quietCron, now) : 0;
    return { resolved: server.count + cron, cron };
  } catch (e) {
    if (noteMissing(e)) return { skipped: "error table not present" };
    throw e;
  }
}

// ---- the owner's page --------------------------------------------------------------

export type ErrorRowView = {
  id: string;
  status: ErrorStatus;
  source: string;
  errorName: string | null;
  message: string;
  stack: string | null;
  route: string | null;
  lastPath: string | null;
  recentPaths: string[];
  digest: string | null;
  context: Record<string, unknown> | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUserRole: string | null;
  reopenedAt: string | null;
  reopenCount: number;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

export async function listErrors(status: ErrorStatus | "ALL", sort: "recent" | "frequent" = "recent"): Promise<{ rows: ErrorRowView[]; counts: Record<ErrorStatus, number>; missing: boolean }> {
  const db = table();
  const empty = { OPEN: 0, FIXED: 0, IGNORED: 0 };
  if (!db) return { rows: [], counts: empty, missing: true };
  try {
    const [rows, grouped] = await Promise.all([
      db.findMany({
        where: status === "ALL" ? {} : { status },
        orderBy: sort === "frequent" ? [{ count: "desc" }, { lastSeenAt: "desc" }] : [{ lastSeenAt: "desc" }],
        take: 200,
      }),
      db.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const counts = { ...empty };
    for (const g of grouped) if (g.status in counts) counts[g.status as ErrorStatus] = g._count._all;
    return { rows: rows.map(view), counts, missing: false };
  } catch (e) {
    if (noteMissing(e)) return { rows: [], counts: empty, missing: true };
    throw e;
  }
}

function view(r: NonNullable<Awaited<ReturnType<ErrorEventDelegate["findFirst"]>>>): ErrorRowView {
  let recentPaths: string[] = [];
  try { recentPaths = r.recentPaths ? (JSON.parse(r.recentPaths) as string[]) : []; } catch { recentPaths = []; }
  let context: Record<string, unknown> | null = null;
  try { context = r.context ? (JSON.parse(r.context) as Record<string, unknown>) : null; } catch { context = null; }
  return {
    id: r.id,
    status: (["OPEN", "FIXED", "IGNORED"].includes(r.status) ? r.status : "OPEN") as ErrorStatus,
    source: r.source,
    errorName: r.errorName,
    message: r.message,
    stack: r.stack,
    route: r.route,
    lastPath: r.lastPath,
    recentPaths,
    digest: r.digest,
    context,
    count: r.count,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    lastUserRole: r.lastUserRole,
    reopenedAt: r.reopenedAt?.toISOString() ?? null,
    reopenCount: r.reopenCount,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedBy: r.resolvedBy,
  };
}

export async function setErrorStatus(id: string, status: ErrorStatus, by: string, now: Date = new Date()): Promise<boolean> {
  const db = table();
  if (!db) return false;
  const data =
    status === "OPEN"
      ? { status, resolvedAt: null, resolvedBy: null }
      : { status, resolvedAt: now, resolvedBy: by.slice(0, 120) };
  const r = await db.updateMany({ where: { id }, data });
  return r.count === 1;
}

/** The paste-able report for "Copy for Claude": what broke, where, how often,
 *  and the stack — already scrubbed, nothing else. */
export function claudeReport(r: ErrorRowView): string {
  const lines = [
    `Please investigate and fix this error from the Realtour Pilot hub (tracked on /settings/errors).`,
    ``,
    `Error: ${r.errorName ? `${r.errorName}: ` : ""}${r.message}`,
    `Source: ${r.source}`,
    `Route: ${r.route ?? "(none)"}`,
    r.recentPaths.length ? `Paths: ${r.recentPaths.join(", ")}` : r.lastPath ? `Path: ${r.lastPath}` : null,
    `Seen: ${r.count} time${r.count === 1 ? "" : "s"} — first ${r.firstSeenAt}, last ${r.lastSeenAt}${r.reopenCount ? ` (came back ${r.reopenCount}× after being marked fixed)` : ""}`,
    r.digest ? `Next.js digest: ${r.digest}` : null,
    r.lastUserRole ? `Signed-in role: ${r.lastUserRole}` : null,
    r.context ? `Context: ${JSON.stringify(r.context)}` : null,
    ``,
    `Stack:`,
    r.stack ? r.stack.split("\n").slice(0, 25).join("\n") : "(no stack recorded)",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}
