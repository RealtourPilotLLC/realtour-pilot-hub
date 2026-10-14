import "server-only";

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { appBase } from "@/lib/appUrl";
import { autohdr, autohdrConfigured, AutohdrError, AUTOHDR_BILLING_URL } from "@/lib/integrations/autohdr";
import { alertOwnerAndKyle } from "./notifyOps";

// ---------------------------------------------------------------------------
// THE AUTOHDR CREDIT MONITOR (docs/photo-delivery/01 §10, Oct 13 2026).
//
//   · Source of truth: GET /v1/credits (free). Read every 15 minutes by the
//     cron, after every spend the pipeline makes, and on page load (cached).
//   · Ledger: a BALANCE_SNAPSHOT per read, the pipeline's own spends
//     (DOWNLOAD / TRANSFORM / STYLE / PRESET) and refunds, and an ADJUSTMENT
//     for any difference between two snapshots the ledger cannot explain
//     ("outside the pipeline": the AutoHDR watcher editing uploads, the web
//     app, Aryeo's integration; or "refill" when the balance rises by 500+).
//   · Alerts: below 250 (WARN) and below 100 (CRITICAL) to Jordan and Kyle,
//     once per episode. Flags reset only after a real refill (threshold +
//     reset buffer), so a small refund near a threshold never re-alerts.
// The hub never buys credits: top-ups happen in the AutoHDR web app.
// ---------------------------------------------------------------------------

export type CreditThresholds = { warn: number; critical: number; resetBuffer: number; usdPerCredit: number };

const SETTINGS_KEY = "photo_delivery:credits";
const STATE_KEY = "photo_delivery:credit_alert_state";

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

export const DEFAULT_THRESHOLDS: CreditThresholds = {
  warn: envInt("CREDIT_ALERT_WARN", 250),
  critical: envInt("CREDIT_ALERT_CRITICAL", 100),
  resetBuffer: envInt("CREDIT_ALERT_RESET_BUFFER", 50),
  usdPerCredit: Number(process.env.AUTOHDR_USD_PER_CREDIT) > 0 ? Number(process.env.AUTOHDR_USD_PER_CREDIT) : 0.5,
};

export async function creditThresholds(): Promise<CreditThresholds> {
  const s = await getSetting<Partial<CreditThresholds>>(SETTINGS_KEY, {});
  const pos = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max ? v : null);
  const warn = pos(s.warn, 100_000) ?? DEFAULT_THRESHOLDS.warn;
  const critical = Math.min(pos(s.critical, 100_000) ?? DEFAULT_THRESHOLDS.critical, warn);
  return {
    warn,
    critical,
    resetBuffer: pos(s.resetBuffer, 10_000) ?? DEFAULT_THRESHOLDS.resetBuffer,
    usdPerCredit: pos(s.usdPerCredit, 100) ?? DEFAULT_THRESHOLDS.usdPerCredit,
  };
}

export async function saveCreditThresholds(next: Partial<CreditThresholds>, by: string | null): Promise<CreditThresholds> {
  const cur = await creditThresholds();
  await putSetting(SETTINGS_KEY, { ...cur, ...next }, by);
  return creditThresholds();
}

export type CreditAlertState = { below250Sent: boolean; below100Sent: boolean; episodeId: string | null; lastBalance: number | null; lastCheckedAt: string | null };
const EMPTY_STATE: CreditAlertState = { below250Sent: false, below100Sent: false, episodeId: null, lastBalance: null, lastCheckedAt: null };

export async function creditAlertState(): Promise<CreditAlertState> {
  return { ...EMPTY_STATE, ...(await getSetting<Partial<CreditAlertState>>(STATE_KEY, {})) };
}

/**
 * The alert state machine (plan §10.2), pure so a drill can walk every
 * crossing and reset. Returns the new state and which alert (if any) to send.
 */
export function evaluateCreditAlerts(
  balance: number,
  s: CreditAlertState,
  t: Pick<CreditThresholds, "warn" | "critical" | "resetBuffer">,
  newId: () => string = randomUUID,
): { state: CreditAlertState; send: null | { level: "WARN" | "CRITICAL"; episodeId: string } } {
  const next: CreditAlertState = { ...s };
  // Reset only after a real refill, so a small refund near a line can't re-alert.
  if (balance >= t.warn + t.resetBuffer) {
    next.below250Sent = false;
    next.below100Sent = false;
  } else if (balance >= t.critical + t.resetBuffer) {
    next.below100Sent = false;
  }
  let send: null | { level: "WARN" | "CRITICAL"; episodeId: string } = null;
  // Every alert gets its own id. (The plan reused the 250 episode's id for the
  // 100 alert; after a partial refill to 150-249 the flag resets and a second
  // drop below 100 would have carried the SAME dedupe key, so the bell, Slack
  // and text would all have swallowed it.)
  if (balance < t.critical && !next.below100Sent) {
    next.episodeId = newId();
    send = { level: "CRITICAL", episodeId: next.episodeId };
    next.below100Sent = true;
    next.below250Sent = true; // one alert when the balance jumps straight past both
  } else if (balance < t.warn && !next.below250Sent) {
    next.episodeId = newId();
    send = { level: "WARN", episodeId: next.episodeId };
    next.below250Sent = true;
  }
  next.lastBalance = balance;
  next.lastCheckedAt = new Date().toISOString();
  return { state: next, send };
}

// ---- ledger -----------------------------------------------------------------------

export async function latestSnapshot(): Promise<{ at: Date; balance: number } | null> {
  const row = await prisma.autohdrCreditEntry.findFirst({ where: { kind: "BALANCE_SNAPSHOT", balanceAfter: { not: null } }, orderBy: { at: "desc" }, select: { at: true, balanceAfter: true } });
  return row && row.balanceAfter != null ? { at: row.at, balance: row.balanceAfter } : null;
}

/** Record a spend (or refund) the pipeline itself made. credits < 0 = spent. */
export async function recordLedgerEntry(e: { kind: "DOWNLOAD" | "TRANSFORM" | "STYLE" | "PRESET" | "REFUND" | "ADJUSTMENT"; credits: number; jobId?: string | null; ref?: string | null; note?: string | null }) {
  return prisma.autohdrCreditEntry.create({
    data: { kind: e.kind, credits: Math.round(e.credits), jobId: e.jobId ?? null, ref: e.ref?.slice(0, 190) ?? null, note: e.note?.slice(0, 500) ?? null },
  });
}

/** Days of credits left at the last 14 days' average daily net spend (refills excluded). */
export async function runwayDays(balance: number, now = new Date()): Promise<{ days: number | null; perDay: number }> {
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const rows = await prisma.autohdrCreditEntry.findMany({ where: { at: { gte: since }, kind: { not: "BALANCE_SNAPSHOT" } }, select: { credits: true, kind: true, note: true } });
  let spent = 0;
  for (const r of rows) {
    if (r.kind === "ADJUSTMENT" && r.credits > 0) continue; // refills and top-ups are not spend
    if (r.credits < 0) spent += -r.credits;
    else if (r.kind === "REFUND") spent -= r.credits;
  }
  const firstSnap = await prisma.autohdrCreditEntry.findFirst({ where: { kind: "BALANCE_SNAPSHOT" }, orderBy: { at: "asc" }, select: { at: true } });
  const spanDays = firstSnap ? Math.max(1, Math.min(14, (now.getTime() - firstSnap.at.getTime()) / 86_400_000)) : 14;
  const perDay = Math.max(0, spent) / spanDays;
  return { days: perDay > 0 ? Math.floor(balance / perDay) : null, perDay: Math.round(perDay * 10) / 10 };
}

/**
 * Read the live balance, write the snapshot, reconcile the difference since
 * the previous one, and run the alert state machine. Spends nothing.
 */
export async function recordCreditSnapshot(opts: { trigger: "cron" | "connect" | "manual" | "after-spend" | "page" } = { trigger: "cron" }): Promise<{ ok: true; balance: number; alert: string | null } | { ok: false; reason: string }> {
  if (!(await autohdrConfigured())) return { ok: false, reason: "AutoHDR API not connected" };
  let balance: number;
  try {
    const c = await autohdr.credits();
    if (typeof c.credit_balance !== "number" || !Number.isFinite(c.credit_balance)) return { ok: false, reason: "AutoHDR returned no credit_balance" };
    balance = Math.round(c.credit_balance);
  } catch (e) {
    const err = e as AutohdrError;
    await prisma.connection.update({ where: { provider: "autohdr" }, data: { lastError: err.message.slice(0, 300) } }).catch(() => {});
    return { ok: false, reason: err.message };
  }
  const now = new Date();
  const prev = await latestSnapshot();
  if (prev) {
    // What the ledger explains between the two reads.
    const explained = await prisma.autohdrCreditEntry.aggregate({
      where: { at: { gt: prev.at, lte: now }, kind: { notIn: ["BALANCE_SNAPSHOT", "ADJUSTMENT"] } },
      _sum: { credits: true },
    });
    const delta = balance - prev.balance;
    const unexplained = delta - (explained._sum.credits ?? 0);
    if (unexplained !== 0) {
      await prisma.autohdrCreditEntry.create({
        data: {
          at: now,
          kind: "ADJUSTMENT",
          credits: unexplained,
          note: unexplained >= 500 ? "refill or top-up" : unexplained > 0 ? "credit returned outside the pipeline" : "used outside the pipeline (Dropbox watcher edits, web app, Aryeo)",
        },
      });
    }
  }
  await prisma.autohdrCreditEntry.create({ data: { at: now, kind: "BALANCE_SNAPSHOT", credits: 0, balanceAfter: balance, note: opts.trigger } });
  await prisma.connection.update({ where: { provider: "autohdr" }, data: { lastSyncedAt: now, lastError: null } }).catch(() => {});

  const t = await creditThresholds();
  const s = await creditAlertState();
  const { state, send } = evaluateCreditAlerts(balance, s, t);
  await putSetting(STATE_KEY, state, "system");
  let alert: string | null = null;
  if (send) {
    const runway = await runwayDays(balance, now).catch(() => ({ days: null, perDay: 0 }));
    const runwayText = runway.days != null ? ` About ${runway.days} day${runway.days === 1 ? "" : "s"} left at the current pace.` : "";
    const link = `${appBase()}/ops/photo-delivery/credits`;
    const critical = send.level === "CRITICAL";
    const line = critical
      ? `AutoHDR credits are at ${balance} (below ${t.critical}). New edits may fail.${runwayText} Top up now: ${AUTOHDR_BILLING_URL}`
      : `AutoHDR credits are at ${balance} (below ${t.warn}).${runwayText} Top up: ${AUTOHDR_BILLING_URL}`;
    await alertOwnerAndKyle({
      kind: critical ? "autohdr_credits_critical" : "autohdr_credits_low",
      title: critical ? `AutoHDR credits below ${t.critical}: ${balance} left` : `AutoHDR credits below ${t.warn}: ${balance} left`,
      body: runwayText.trim() || "Top up in the AutoHDR web app.",
      href: "/ops/photo-delivery/credits",
      dedupeKey: `autohdr-credits-${critical ? "100" : "250"}-${send.episodeId}`,
      text: `${line} Hub: ${link}`,
    });
    alert = send.level;
  }
  return { ok: true, balance, alert };
}

export type CreditView = {
  connected: boolean;
  balance: number | null;
  checkedAt: Date | null;
  level: "ok" | "warn" | "critical" | "unknown";
  runwayDays: number | null;
  perDay: number;
  thresholds: CreditThresholds;
  committed: number;
  lastError: string | null;
};

/** Credits committed to work in progress: fix batches approved but not run. */
export async function committedCredits(): Promise<number> {
  const ops = await prisma.photoFixOperation.aggregate({ where: { status: { in: ["QUEUED", "SUBMITTING"] } }, _sum: { estimatedCredits: true } }).catch(() => null);
  return ops?._sum.estimatedCredits ?? 0;
}

export async function creditView(now = new Date()): Promise<CreditView> {
  const [connected, snap, thresholds, conn] = await Promise.all([
    autohdrConfigured().catch(() => false),
    latestSnapshot().catch(() => null),
    creditThresholds(),
    prisma.connection.findUnique({ where: { provider: "autohdr" }, select: { lastError: true } }).catch(() => null),
  ]);
  const balance = snap?.balance ?? null;
  const runway = balance != null ? await runwayDays(balance, now).catch(() => ({ days: null, perDay: 0 })) : { days: null, perDay: 0 };
  const level: CreditView["level"] = balance == null ? "unknown" : balance < thresholds.critical ? "critical" : balance < thresholds.warn ? "warn" : "ok";
  return {
    connected,
    balance,
    checkedAt: snap?.at ?? null,
    level,
    runwayDays: runway.days,
    perDay: runway.perDay,
    thresholds,
    committed: await committedCredits(),
    lastError: conn?.lastError ?? null,
  };
}
