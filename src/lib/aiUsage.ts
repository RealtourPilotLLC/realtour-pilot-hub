import "server-only";
import { after } from "next/server";
import { etDayKey, etDayStartUtc } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// THE AI USAGE LEDGER (Oct 22 2026, the Anthropic spend investigation).
//
// The hub's Anthropic key cost about $95–125 over 30 days and the hub could
// account for about $35 of it: only the content program (ProgramAiRun) and
// photo QC (PhotoQcRun) wrote down what their calls cost. Everything else —
// the Slack and comms routers, client profiles, Ask the Hub, drafts — read
// the usage block on every answer and threw it away.
//
// Now every answer the hub's ONE transport receives (integrations/ai.ts
// postMessages: callMessages goes through it, as the deleted photo QC engine did) is
// written here: feature, model, input / output / cache tokens and an
// estimated cost. No new table: one AppSetting row per Eastern day,
// `ai_usage:<YYYY-MM-DD>`, a JSON map of "<feature>|<model>" → running sums,
// merged by ONE upsert statement so two calls finishing together cannot
// overwrite each other's numbers (Postgres takes the row lock on conflict).
//
// Recording never breaks or slows a call: the transport does not await it,
// and every failure (no database, a bad row, a test seam) is swallowed.
// ---------------------------------------------------------------------------

export const AI_USAGE_DAY_PREFIX = "ai_usage:";
/** When this ledger recorded its first call (ISO). The run tables' own costs
 *  are counted only BEFORE it, so nothing is counted twice. */
export const AI_USAGE_SINCE_KEY = "ai_usage_since";

export type AiUsageTokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

// Anthropic first-party list prices, USD per million tokens (Oct 2026). An
// ESTIMATE — the invoice is the truth. cacheRead is the model's own cache-read
// price; cache writes (5-minute) are billed at 1.25x input.
type Price = { input: number; output: number; cacheRead: number };
const PRICES: Record<string, Price> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
const CACHE_WRITE_X = 1.25;

/** The price row for a model id: exact, then without a date suffix, then by
 *  family. An unrecognised model is priced as Sonnet 4.6, the hub's default. */
export function aiPriceFor(model: string): Price {
  const m = (model || "").toLowerCase().trim();
  if (PRICES[m]) return PRICES[m];
  const undated = m.replace(/-\d{8}$/, "");
  if (PRICES[undated]) return PRICES[undated];
  if (/haiku-5/.test(m)) return PRICES["claude-haiku-5-5"];
  if (/haiku/.test(m)) return PRICES["claude-haiku-4-5"];
  if (/sonnet-5/.test(m)) return PRICES["claude-sonnet-5-5"];
  if (/opus-5-5/.test(m)) return PRICES["claude-opus-5-5"];
  if (/opus/.test(m)) return PRICES["claude-opus-5"];
  return PRICES["claude-sonnet-4-6"];
}

/** Estimated USD for one call's tokens on `model`. */
export function aiCostUsd(model: string, u: AiUsageTokens): number {
  const p = aiPriceFor(model);
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.input * CACHE_WRITE_X) / 1_000_000;
}

/** A feature name as stored: short, lower-case, no separator characters. */
export function normalizeFeature(feature: string | null | undefined): string {
  const f = (feature ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return f || "other";
}

export type AiUsageRecord = { feature?: string | null; model: string; usage: AiUsageTokens; at?: Date };
type Store = (dayKey: string, slot: string, add: { n: number; in: number; out: number; cr: number; cw: number; usd: number }) => Promise<void>;

let sinceWritten = false;
const defaultStore: Store = async (dayKey, slot, add) => {
  const { prisma } = await import("@/lib/prisma");
  if (!sinceWritten) {
    const iso = new Date().toISOString();
    await prisma.$executeRaw`
      INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${AI_USAGE_SINCE_KEY}, ${iso}, NOW())
      ON CONFLICT ("key") DO NOTHING`;
    sinceWritten = true;
  }
  const key = `${AI_USAGE_DAY_PREFIX}${dayKey}`;
  const first = JSON.stringify({ [slot]: add });
  // One statement: the first call of the day inserts the row, every later
  // one adds its numbers to the slot inside the row lock.
  await prisma.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, ${first}, NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "value" = (
        "AppSetting"."value"::jsonb || jsonb_build_object(${slot}::text, jsonb_build_object(
          'n',   COALESCE(("AppSetting"."value"::jsonb -> ${slot}::text ->> 'n')::numeric, 0)   + ${add.n}::numeric,
          'in',  COALESCE(("AppSetting"."value"::jsonb -> ${slot}::text ->> 'in')::numeric, 0)  + ${add.in}::numeric,
          'out', COALESCE(("AppSetting"."value"::jsonb -> ${slot}::text ->> 'out')::numeric, 0) + ${add.out}::numeric,
          'cr',  COALESCE(("AppSetting"."value"::jsonb -> ${slot}::text ->> 'cr')::numeric, 0)  + ${add.cr}::numeric,
          'cw',  COALESCE(("AppSetting"."value"::jsonb -> ${slot}::text ->> 'cw')::numeric, 0)  + ${add.cw}::numeric,
          'usd', COALESCE(("AppSetting"."value"::jsonb -> ${slot}::text ->> 'usd')::numeric, 0) + ${add.usd}::numeric
        ))
      )::text,
      "updatedAt" = NOW()`;
};
let store: Store = defaultStore;
const pending = new Set<Promise<void>>();

/** Drills only: replace the database write (null restores it). */
export function __setAiUsageStoreForTests(fn: Store | null): void {
  store = fn ?? defaultStore;
  sinceWritten = false;
}

/**
 * Write one call into the ledger. Never throws and never rejects; the caller
 * (the transport) does not wait for it. Calls that billed nothing are skipped.
 */
export function recordAiUsage(rec: AiUsageRecord): Promise<void> {
  let p: Promise<void>;
  try {
    const u = rec.usage;
    const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    if (!(total > 0)) return Promise.resolve();
    const model = (rec.model || "unknown").slice(0, 60).replace(/\|/g, "");
    const slot = `${normalizeFeature(rec.feature)}|${model}`;
    const add = {
      n: 1,
      in: Math.max(0, Math.round(u.inputTokens)),
      out: Math.max(0, Math.round(u.outputTokens)),
      cr: Math.max(0, Math.round(u.cacheReadTokens)),
      cw: Math.max(0, Math.round(u.cacheWriteTokens)),
      usd: Math.round(aiCostUsd(model, u) * 1e6) / 1e6,
    };
    p = Promise.resolve()
      .then(() => store(etDayKey(rec.at ?? new Date()), slot, add))
      .catch(() => { /* the ledger is best-effort; the call it describes already succeeded */ });
  } catch {
    return Promise.resolve();
  }
  pending.add(p);
  void p.finally(() => pending.delete(p));
  // The platform keeps the function alive for the write after the response
  // (errorTracker's pattern); outside a request scope it is already running.
  try { after(() => p); } catch { /* a cron step, a script, a drill */ }
  return p;
}

/** Wait for the writes in flight (drills, and a cron that wants its numbers in
 *  before it reports), never longer than `timeoutMs`: a hung store must not
 *  hang its waiter either. */
export async function flushAiUsage(timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all([...pending]), new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); })]);
  if (timer) clearTimeout(timer);
}

export type AiUsageRow = { day: string; feature: string; model: string; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; usd: number };

/** Every ledger slot for the Eastern days fromDay..toDay (inclusive, YYYY-MM-DD). */
export async function readAiUsage(fromDay: string, toDay: string): Promise<AiUsageRow[]> {
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.appSetting.findMany({
    where: { key: { gte: `${AI_USAGE_DAY_PREFIX}${fromDay}`, lte: `${AI_USAGE_DAY_PREFIX}${toDay}` } },
    select: { key: true, value: true },
  });
  const out: AiUsageRow[] = [];
  for (const r of rows) {
    const day = r.key.slice(AI_USAGE_DAY_PREFIX.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    let map: Record<string, Record<string, unknown>>;
    try { map = JSON.parse(r.value); } catch { continue; }
    if (!map || typeof map !== "object") continue;
    for (const [slot, v] of Object.entries(map)) {
      const bar = slot.indexOf("|");
      if (bar < 0 || !v || typeof v !== "object") continue;
      const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : Number(x) || 0);
      out.push({
        day,
        feature: slot.slice(0, bar),
        model: slot.slice(bar + 1),
        calls: num(v.n),
        inputTokens: num(v.in),
        outputTokens: num(v.out),
        cacheReadTokens: num(v.cr),
        cacheWriteTokens: num(v.cw),
        usd: num(v.usd),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE OWNER'S "AI SPEND" CARD (Finance → Overview). Money, so owner only —
// the same door as the pay-savings tab: the real owner, not previewing
// someone else. The last 30 days by feature and by model: this ledger from
// the day it started, and before that the two run tables that already kept
// their own costs (ProgramAiRun.costCents, PhotoQcRun.costUsd), so the total
// is never counted twice.
// ---------------------------------------------------------------------------

/** Plain-English names for the stored feature keys. */
export const AI_FEATURE_LABEL: Record<string, string> = {
  slack_router: "Slack to-do sorting",
  message_to_todo: "Message to to-do",
  comms_router: "Texts and emails sorting",
  client_profile: "Client working profiles",
  client_brief: "New-client briefs",
  reply_draft: "Reply drafts",
  polish: "Message polish",
  workday_recap: "Day recaps",
  shoot_focus: "Photographer feedback themes",
  hub_chat_recap: "Ask the Hub chat titles",
  hub_agent: "Ask the Hub and advisors",
  content_program: "Content program",
  script_writer: "Script writer",
  photo_qc: "Photo QC",
  client_issue_plan: "Complaint plans",
  client_prefs: "Working preferences sorting",
  key_test: "AI connection test",
  // Names for call sites outside integrations/ai.ts that do not pass one yet
  // (they land under "Other", "Ask the Hub and advisors" or "Content program").
  comms_coaching: "Comms coaching notes",
  growth_plan: "Growth plan",
  meetings: "Meeting notes",
  music: "Music picks",
  revision_brief: "Revision work orders",
  revision_not_needed: "Revision not-needed reads",
  ask_the_hub: "Ask the Hub",
  my_day: "My Day planner",
  finance_advisor: "Finance advisor",
  trends_advisor: "Trends advisor",
  other: "Other",
};
export const aiFeatureLabel = (f: string) => AI_FEATURE_LABEL[f] ?? f.replace(/_/g, " ");

export type AiSpendLine = { key: string; label: string; calls: number; usd: number };
export type AiSpend = {
  fromDay: string;
  toDay: string;
  days: number;
  /** When the ledger began (ISO), or null when it has recorded nothing yet. */
  ledgerSince: string | null;
  totalUsd: number;
  totalCalls: number;
  byFeature: AiSpendLine[];
  byModel: AiSpendLine[];
  /** Where the total came from. */
  sources: { ledgerUsd: number; programRunsUsd: number; photoQcRunsUsd: number };
};

export async function canSeeAiSpend(): Promise<boolean> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { canSeeMoney } = await import("@/lib/auth/access");
  const { authEnforcedNow } = await import("@/lib/auth/enforced");
  const me = await getCurrentUser().catch(() => null);
  if (!me) return !authEnforcedNow();
  return me.realRole === "OWNER" && canSeeMoney(me.role);
}

/** The guarded door: the owner's 30-day AI spend, a refusal for anyone else. */
export async function ownerAiSpend(opts: { days?: number; now?: Date } = {}): Promise<AiSpend> {
  if (!(await canSeeAiSpend())) throw new Error("Only the owner can see AI spend.");
  return computeAiSpend(opts);
}

const MODEL_LABEL: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-opus-5-5": "Opus 5.5",
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-5-5": "Haiku 5.5",
  photo_qc_mixed: "Photo QC (several models)",
};
export const aiModelLabel = (m: string) => MODEL_LABEL[m] ?? m;

async function computeAiSpend(opts: { days?: number; now?: Date }): Promise<AiSpend> {
  const { prisma } = await import("@/lib/prisma");
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.min(120, Math.round(opts.days ?? 30)));
  const fromAt = new Date(now.getTime() - (days - 1) * 86_400_000);
  const fromDay = etDayKey(fromAt);
  const toDay = etDayKey(now);
  const windowStart = etDayStartUtc(fromAt);

  const [ledger, sinceRow] = await Promise.all([
    readAiUsage(fromDay, toDay),
    prisma.appSetting.findUnique({ where: { key: AI_USAGE_SINCE_KEY }, select: { value: true } }).catch(() => null),
  ]);
  const sinceAt = sinceRow?.value && Number.isFinite(Date.parse(sinceRow.value)) ? new Date(sinceRow.value) : null;
  // The run tables count only what happened before the ledger began.
  const runsUntil = sinceAt ?? new Date(now.getTime() + 60_000);

  const { WRITER_STEP_KINDS } = await import("@/lib/aiRuns");
  const writerKinds = new Set<string>(WRITER_STEP_KINDS);
  const [programRuns, qcRuns] = await Promise.all([
    prisma.programAiRun.groupBy({
      by: ["kind", "model"],
      where: { costCents: { gt: 0 }, finishedAt: { gte: windowStart, lt: runsUntil } },
      _sum: { costCents: true },
      _count: { _all: true },
    }).catch(() => [] as { kind: string; model: string | null; _sum: { costCents: number | null }; _count: { _all: number } }[]),
    prisma.photoQcRun.aggregate({
      where: { costUsd: { gt: 0 }, startedAt: { gte: windowStart, lt: runsUntil } },
      _sum: { costUsd: true },
      _count: { _all: true },
    }).catch(() => ({ _sum: { costUsd: 0 as number | null }, _count: { _all: 0 } })),
  ]);

  const feature = new Map<string, { calls: number; usd: number }>();
  const model = new Map<string, { calls: number; usd: number }>();
  const add = (m: Map<string, { calls: number; usd: number }>, k: string, calls: number, usd: number) => {
    const cur = m.get(k) ?? { calls: 0, usd: 0 };
    cur.calls += calls;
    cur.usd += usd;
    m.set(k, cur);
  };

  let ledgerUsd = 0;
  for (const r of ledger) {
    ledgerUsd += r.usd;
    add(feature, r.feature, r.calls, r.usd);
    add(model, r.model.replace(/-\d{8}$/, ""), r.calls, r.usd);
  }
  let programRunsUsd = 0;
  for (const g of programRuns) {
    const usd = (g._sum.costCents ?? 0) / 100;
    programRunsUsd += usd;
    add(feature, writerKinds.has(g.kind) ? "script_writer" : "content_program", g._count._all, usd);
    add(model, (g.model ?? "unknown").replace(/-\d{8}$/, ""), g._count._all, usd);
  }
  const photoQcRunsUsd = qcRuns._sum.costUsd ?? 0;
  if (photoQcRunsUsd > 0) {
    add(feature, "photo_qc", qcRuns._count._all, photoQcRunsUsd);
    add(model, "photo_qc_mixed", qcRuns._count._all, photoQcRunsUsd);
  }

  const lines = (m: Map<string, { calls: number; usd: number }>, label: (k: string) => string): AiSpendLine[] =>
    [...m.entries()]
      .map(([key, v]) => ({ key, label: label(key), calls: v.calls, usd: Math.round(v.usd * 100) / 100 }))
      .sort((a, b) => b.usd - a.usd || b.calls - a.calls);
  const totalUsd = ledgerUsd + programRunsUsd + photoQcRunsUsd;
  return {
    fromDay,
    toDay,
    days,
    ledgerSince: sinceAt ? sinceAt.toISOString() : null,
    totalUsd: Math.round(totalUsd * 100) / 100,
    totalCalls: [...feature.values()].reduce((s, v) => s + v.calls, 0),
    byFeature: lines(feature, aiFeatureLabel),
    byModel: lines(model, aiModelLabel),
    sources: {
      ledgerUsd: Math.round(ledgerUsd * 100) / 100,
      programRunsUsd: Math.round(programRunsUsd * 100) / 100,
      photoQcRunsUsd: Math.round(photoQcRunsUsd * 100) / 100,
    },
  };
}
