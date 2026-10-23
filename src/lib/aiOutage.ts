import "server-only";
import { after } from "next/server";
import { etDayKey } from "@/lib/datetime";
import { normalizeFeature } from "@/lib/aiUsage";

// ---------------------------------------------------------------------------
// WHEN THE AI SAYS NO (Oct 22 2026, comms audit H5).
//
// A spend limit or an empty credit balance comes back from Anthropic as a
// plain 400 ("You have reached your specified API usage limits", "Your credit
// balance is too low"), a revoked key as 401 / 403. None is retryable, so the
// transport threw, and the callers that matter most swallowed it: the comms
// router (brain.ts) answered "no decision", the Slack router (slackSync.ts)
// made a raw-text card, and the usage ledger recorded only successes. The hub
// went on looking fine while every text and email was sorted by keyword.
//
// Now:
//   · the transport (integrations/ai.ts) recognises the answer
//     (aiOutageReason) and throws an AiUnavailableError;
//   · each refusal is written to the ledger as a failure, by feature
//     (AppSetting `ai_failures:<ET day>`, beside the usage rows);
//   · the first refusal raises ONE owner alert (the bell and a Slack DM to
//     Jordan), at most once an hour while it lasts (AppSetting `ai_outage`);
//   · the next successful answer clears it;
//   · a client message the comms router could not read is queued
//     (queueAiRetry) and read again by the 5-minute sweep once the AI answers
//     (sweepAiRetries): its asks, special requests and revision are filed
//     then, never dropped as "no decision". A Slack message is retried by the
//     Slack poll itself: the router gives the message back.
// Everything here is best-effort and never throws into a caller.
// ---------------------------------------------------------------------------

export type AiOutageReason = "usage_limit" | "credit" | "auth";

/** The AI refused for a reason that waiting a minute will not fix. */
export class AiUnavailableError extends Error {
  readonly code = "AI_UNAVAILABLE" as const;
  constructor(readonly reason: AiOutageReason, readonly status: number, message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/** Pure: is this answer a spend limit, an empty balance or a refused key? Null for anything else. */
export function aiOutageReason(status: number, message: string | null | undefined): AiOutageReason | null {
  const m = (message ?? "").toLowerCase();
  if (/credit balance|insufficient (?:credit|funds)|billing/.test(m)) return "credit";
  if (/usage limit|spend(?:ing)? limit|monthly limit|usage cap/.test(m)) return "usage_limit";
  if (status === 401 || status === 403 || /organization (?:has been )?disabled|invalid x-api-key/.test(m)) return "auth";
  return null;
}

/** Did this error come from an AI refusal (above)? Works across module copies. */
export function isAiUnavailable(e: unknown): e is AiUnavailableError {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "AI_UNAVAILABLE";
}

const REASON_WORDS: Record<AiOutageReason, string> = {
  usage_limit: "the Anthropic usage limit was reached",
  credit: "the Anthropic credit balance ran out",
  auth: "Anthropic refused the hub's key",
};

export const AI_OUTAGE_KEY = "ai_outage";
export const AI_FAILURE_DAY_PREFIX = "ai_failures:";
/** The owner hears about it at most once an hour while it lasts. */
export const AI_OUTAGE_ALERT_EVERY_MS = 60 * 60_000;

type OutageRow = { since: string; lastAt: string; reason: AiOutageReason; feature: string; message: string; alertedAt: string | null; failures: number };
const parseRow = (v: string | null | undefined): OutageRow | null => {
  try {
    const r = v ? (JSON.parse(v) as OutageRow) : null;
    return r && typeof r.since === "string" ? r : null;
  } catch {
    return null;
  }
};

type Alert = (a: { title: string; body: string; hourKey: string }) => Promise<void>;
const defaultAlert: Alert = async ({ title, body, hourKey }) => {
  const { notifyInApp, holdStaffDmForQuietTime } = await import("@/lib/notify");
  await notifyInApp({ kind: "ai_outage", title, body, href: "/finance", targets: [{ roles: ["OWNER"] }], dedupeKey: `ai-outage-${hourKey}` }).catch(() => null);
  const { jordanSlackId } = await import("@/lib/integrations/slackSync");
  const slackId = await jordanSlackId().catch(() => null);
  if (!slackId) return;
  const text = `${title}. ${body}`;
  // Jordan's quiet window (Saturday until 7:30 PM ET) holds it; otherwise it goes now.
  const { ownerTeamMemberIds } = await import("@/lib/smsPrefs");
  const tm = (await ownerTeamMemberIds().catch(() => [] as string[]))[0] ?? null;
  const held = tm ? await holdStaffDmForQuietTime({ teamMemberId: tm, slackId, text, kind: "ai_outage" }).catch(() => null) : null;
  if (held) return;
  const { slackNotify } = await import("@/lib/integrations/slack");
  await slackNotify(slackId, text);
};
let alert: Alert = defaultAlert;
/** Drills only: replace the owner alert (null restores it). */
export function __setAiOutageAlertForTests(fn: Alert | null): void {
  alert = fn ?? defaultAlert;
  knownClear = null;
}

const pending = new Set<Promise<void>>();
function keepAlive(p: Promise<void>): Promise<void> {
  pending.add(p);
  void p.finally(() => pending.delete(p));
  try { after(() => p); } catch { /* a cron step, a script, a drill */ }
  return p;
}
/** Drills: wait for the writes in flight. */
export async function flushAiOutage(timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all([...pending]), new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); })]);
  if (timer) clearTimeout(timer);
}

/**
 * One refusal: written to the ledger by feature, the outage row kept, and the
 * owner told (once an hour at most). Never throws, never rejects.
 */
export function recordAiOutage(o: { feature?: string | null; reason: AiOutageReason; status: number; message?: string | null; at?: Date }): Promise<void> {
  const p = (async () => {
    const { prisma } = await import("@/lib/prisma");
    const at = o.at ?? new Date();
    const feature = normalizeFeature(o.feature);
    const slot = `${feature}|${o.reason}`;
    const day = `${AI_FAILURE_DAY_PREFIX}${etDayKey(at)}`;
    const first = JSON.stringify({ [slot]: { n: 1, last: at.toISOString() } });
    // The ledger: one row per Eastern day, "<feature>|<reason>" → count and last time.
    await prisma.$executeRaw`
      INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${day}, ${first}, NOW())
      ON CONFLICT ("key") DO UPDATE SET
        "value" = (
          "AppSetting"."value"::jsonb || jsonb_build_object(${slot}::text, jsonb_build_object(
            'n', COALESCE(("AppSetting"."value"::jsonb -> ${slot}::text ->> 'n')::numeric, 0) + 1,
            'last', ${at.toISOString()}::text
          ))
        )::text,
        "updatedAt" = NOW()`.catch(() => null);
    knownClear = null;
    // The outage row, and the hourly claim on the alert.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await prisma.appSetting.findUnique({ where: { key: AI_OUTAGE_KEY }, select: { value: true } });
      const cur = parseRow(row?.value);
      const due = !cur?.alertedAt || at.getTime() - Date.parse(cur.alertedAt) >= AI_OUTAGE_ALERT_EVERY_MS;
      const next: OutageRow = {
        since: cur?.since ?? at.toISOString(),
        lastAt: at.toISOString(),
        reason: o.reason,
        feature,
        message: (o.message ?? "").slice(0, 300),
        alertedAt: due ? at.toISOString() : cur?.alertedAt ?? null,
        failures: (cur?.failures ?? 0) + 1,
      };
      const value = JSON.stringify(next);
      let won = false;
      if (!row) {
        won = await prisma.appSetting.create({ data: { key: AI_OUTAGE_KEY, value } }).then(() => true, () => false);
      } else {
        won = (await prisma.appSetting.updateMany({ where: { key: AI_OUTAGE_KEY, value: row.value }, data: { value } })).count === 1;
      }
      if (!won) continue; // someone else wrote it this instant: read it again
      if (due) {
        const hourKey = at.toISOString().slice(0, 13);
        const title = cur ? "The AI is still refusing the hub's requests" : "The AI stopped answering the hub";
        const body = `${REASON_WORDS[o.reason]} (first seen on ${feature.replace(/_/g, " ")}). Texts, emails and Slack are being sorted without it and will be read again when it answers. Check the Anthropic console.`;
        await alert({ title, body, hourKey }).catch(() => null);
      }
      return;
    }
  })().catch(() => { /* best-effort: the refusal itself already reached the caller */ });
  return keepAlive(p);
}

// Whether this process has seen the outage row cleared recently, so a success
// costs no database read most of the time.
let knownClear: number | null = null;
const CLEAR_RECHECK_MS = 5 * 60_000;

/** A successful answer: the outage, if one is on record, is over. Never throws. */
export function noteAiSuccess(): Promise<void> {
  if (knownClear && Date.now() - knownClear < CLEAR_RECHECK_MS) return Promise.resolve();
  const p = (async () => {
    const { prisma } = await import("@/lib/prisma");
    const row = await prisma.appSetting.findUnique({ where: { key: AI_OUTAGE_KEY }, select: { value: true } });
    if (row) await prisma.appSetting.deleteMany({ where: { key: AI_OUTAGE_KEY, value: row.value } });
    knownClear = Date.now();
  })().catch(() => {});
  return keepAlive(p);
}

/** The outage on record, or null. */
export async function aiOutageNow(): Promise<{ since: Date; lastAt: Date; reason: AiOutageReason; failures: number } | null> {
  const { prisma } = await import("@/lib/prisma");
  const row = await prisma.appSetting.findUnique({ where: { key: AI_OUTAGE_KEY }, select: { value: true } }).catch(() => null);
  const r = parseRow(row?.value);
  return r ? { since: new Date(r.since), lastAt: new Date(r.lastAt), reason: r.reason, failures: r.failures ?? 0 } : null;
}

/** The ledger's refusals for the Eastern days fromDay..toDay (inclusive). */
export async function readAiFailures(fromDay: string, toDay: string): Promise<{ day: string; feature: string; reason: string; count: number; last: string | null }[]> {
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.appSetting.findMany({
    where: { key: { gte: `${AI_FAILURE_DAY_PREFIX}${fromDay}`, lte: `${AI_FAILURE_DAY_PREFIX}${toDay}` } },
    select: { key: true, value: true },
  }).catch(() => []);
  const out: { day: string; feature: string; reason: string; count: number; last: string | null }[] = [];
  for (const r of rows) {
    const day = r.key.slice(AI_FAILURE_DAY_PREFIX.length);
    let map: Record<string, { n?: unknown; last?: unknown }>;
    try { map = JSON.parse(r.value); } catch { continue; }
    for (const [slot, v] of Object.entries(map ?? {})) {
      const bar = slot.indexOf("|");
      if (bar < 0 || !v) continue;
      out.push({ day, feature: slot.slice(0, bar), reason: slot.slice(bar + 1), count: Number(v.n) || 0, last: typeof v.last === "string" ? v.last : null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE RETRY QUEUE. A WebhookEvent row per message (provider "ai-retry"): a
// durable queue the hub already has, RECEIVED until the message is read
// again, PROCESSED after, EXPIRED when it was given up on (never ERROR:
// the webhook retry sweep and the Connections health strip read ERROR rows).
// ---------------------------------------------------------------------------
export const AI_RETRY_PROVIDER = "ai-retry";
/** Tries that reached the AI and still got no decision, before a message is given up on. */
const MAX_TRIES = 6;
/** A message older than this is not read again: someone has answered it by now. */
const RETRY_MAX_AGE_MS = 3 * 86_400_000;

export type CommsRetryPayload = {
  /** "comms": recordClientCommunication again. "answered-asks": an email we
   *  had already answered, read again for its asks only (lib/answeredAsks). */
  kind: "comms" | "answered-asks";
  /** recordClientCommunication's input, as it was. */
  input: Record<string, unknown>;
  /** What the first read did without the AI, so the retry does not do it twice. */
  firstPass: { revision: boolean; replyTask: boolean };
  queuedAt: string;
  tries?: number;
};

/** Queue a client message for a second read when the AI answers. Never throws. */
export async function queueAiRetry(p: Omit<CommsRetryPayload, "queuedAt" | "tries">, key: string): Promise<boolean> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const externalId = `ai-retry:${key}`.slice(0, 300);
    const exists = await prisma.webhookEvent.findFirst({ where: { provider: AI_RETRY_PROVIDER, externalId }, select: { id: true } });
    if (exists) return false;
    await prisma.webhookEvent.create({
      data: { provider: AI_RETRY_PROVIDER, eventType: p.kind, externalId, payload: JSON.stringify({ ...p, queuedAt: new Date().toISOString(), tries: 0 } satisfies CommsRetryPayload) },
    });
    return true;
  } catch (e) {
    console.error("[ai-retry] queueing failed", e);
    return false;
  }
}

/**
 * Read the queued messages again, oldest first. Stops at the first one the AI
 * still refuses (the rest wait for the next tick). Never throws.
 */
export async function sweepAiRetries(opts: { limit?: number; now?: Date } = {}): Promise<{ tried: number; done: number; stillDown: boolean; gaveUp: number }> {
  const out = { tried: 0, done: 0, stillDown: false, gaveUp: 0 };
  const { prisma } = await import("@/lib/prisma");
  const now = opts.now ?? new Date();
  const rows = await prisma.webhookEvent.findMany({
    where: { provider: AI_RETRY_PROVIDER, status: "RECEIVED" },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 8,
    select: { id: true, payload: true, createdAt: true },
  }).catch(() => []);
  for (const row of rows) {
    let p: CommsRetryPayload | null = null;
    try { p = JSON.parse(row.payload) as CommsRetryPayload; } catch { p = null; }
    if (!p || (p.kind !== "comms" && p.kind !== "answered-asks")) {
      await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: "EXPIRED", error: "unreadable retry row", processedAt: now } }).catch(() => null);
      out.gaveUp++;
      continue;
    }
    if (now.getTime() - row.createdAt.getTime() > RETRY_MAX_AGE_MS) {
      await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: "EXPIRED", error: "too old to read again", processedAt: now } }).catch(() => null);
      out.gaveUp++;
      continue;
    }
    out.tried++;
    try {
      let r: { brain: "answered" | "unavailable" | "off" };
      if (p.kind === "answered-asks") {
        const { fileAnsweredEmailAsks } = await import("@/lib/answeredAsks");
        r = await fileAnsweredEmailAsks(p.input as unknown as Parameters<typeof fileAnsweredEmailAsks>[0], { retry: true });
      } else {
        const { recordClientCommunication } = await import("@/lib/comms");
        r = await recordClientCommunication({ ...(p.input as unknown as Parameters<typeof recordClientCommunication>[0]), aiRetry: { firstPass: p.firstPass } });
      }
      if (r.brain === "unavailable") { out.stillDown = true; break; }
      if (r.brain === "answered") {
        await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: "PROCESSED", processedAt: now } });
        out.done++;
        continue;
      }
      // The AI answered nothing usable (or is not connected): a few more tries, then let it go.
      const tries = (p.tries ?? 0) + 1;
      await prisma.webhookEvent.update({
        where: { id: row.id },
        data: tries >= MAX_TRIES ? { status: "EXPIRED", error: "no decision after retries", processedAt: now, payload: JSON.stringify({ ...p, tries }) } : { payload: JSON.stringify({ ...p, tries }) },
      });
      if (tries >= MAX_TRIES) out.gaveUp++;
    } catch (e) {
      if (isAiUnavailable(e)) { out.stillDown = true; break; }
      await prisma.webhookEvent.update({ where: { id: row.id }, data: { error: (e instanceof Error ? e.message : String(e)).slice(0, 300) } }).catch(() => null);
    }
  }
  return out;
}
