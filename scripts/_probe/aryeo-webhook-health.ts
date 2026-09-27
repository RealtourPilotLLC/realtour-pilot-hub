// ---------------------------------------------------------------------------
// ARYEO WEBHOOK HEALTH — read, don't assume (unified handoff 9.3, Sep 25 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_probe/aryeo-webhook-health.ts [--days 14]
//
// The handoff corrected two earlier claims — that Aryeo's webhooks were dead
// for good, and that LISTING_CHANGED only needed a handler — and asked for the
// CURRENT state to be read before anything is changed. This prints it:
//   · what the hub's receiver is set to do (the arm state: watching / armed /
//     holding, and whether a post has ever proved Aryeo holds the secret);
//   · per Aryeo event type, the last post RECEIVED and the last one PROCESSED,
//     with self-tests (our own replays) counted apart so they cannot pass for
//     Aryeo talking;
//   · how many posts were REJECTED, accepted UNSIGNED, or ERRORED in the window;
//   · which event types the delivery handler acts on (aryeoDelivery) against
//     which ones actually arrive;
//   · what the hourly recovery passes (readyToSendAryeo, webhookSilence)
//     recorded on their last runs — the proof that delivery evidence reaches
//     the hub even when a post does not.
//
// It does not — cannot — list Aryeo's own subscriptions: that endpoint answers
// 401 to our key (docs/handoff memory, Sep 16). Registering or re-signing a
// subscription is a provider-configuration step for Jordan; this only shows
// whether one is needed.
//
// STRUCTURALLY READ-ONLY, the cp15 probe's way: the connection is opened with
// default_transaction_read_only=on and a refused UPDATE (SQLSTATE 25006) is
// proven before anything is read; every outbound fetch is refused. It asks no
// provider anything. `webhookHealth(prisma)` is exported so a drill can run the
// same reading over an isolated database.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

/** Event types lib/aryeoDelivery's handler acts on (its own switch). */
export const HANDLED_DELIVERY_EVENTS = ["LISTING_DELIVERED", "LISTING_CONTENT_DOWNLOADED", "MEDIA_REQUEST_DELIVERED"] as const;

export type EventLine = {
  eventType: string;
  received: number;
  processed: number;
  errored: number;
  rejected: number;
  unsigned: number;
  selfTests: number;
  lastReceivedAt: Date | null;
  lastProcessedAt: Date | null;
  handledByDelivery: boolean;
};

export type WebhookHealth = {
  windowDays: number;
  arm: { mode: string; watchingSince: string | null; armedAt: string | null; armedBy: string | null; proofAt: string | null; proofCredential: string | null; heldAt: string | null; heldReason: string | null } | null;
  totals: { received: number; processed: number; errored: number; rejected: number; unsigned: number; selfTests: number };
  lastRealEventAt: Date | null;
  events: EventLine[];
  /** Handled delivery events that did not arrive once in the window. */
  silentHandledEvents: string[];
  recovery: { job: string; at: Date; ok: boolean; step: string; result: string }[];
  verdict: string[];
};

const isSelfTest = (error: string | null) => !!error && /SELF-TEST:/.test(error);
const isUnsigned = (error: string | null) => !!error && error.startsWith("UNSIGNED");

/** The reading itself — pure queries over whatever client it is given. */
export async function webhookHealth(prisma: PrismaClient, opts: { days?: number; now?: Date } = {}): Promise<WebhookHealth> {
  const days = opts.days ?? 14;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.webhookEvent.findMany({
    where: { provider: "aryeo", createdAt: { gte: since } },
    select: { eventType: true, status: true, error: true, createdAt: true, processedAt: true },
    orderBy: { createdAt: "asc" },
  });
  const byType = new Map<string, EventLine>();
  const line = (t: string) => {
    const k = t || "(no event type)";
    const l = byType.get(k) ?? { eventType: k, received: 0, processed: 0, errored: 0, rejected: 0, unsigned: 0, selfTests: 0, lastReceivedAt: null, lastProcessedAt: null, handledByDelivery: (HANDLED_DELIVERY_EVENTS as readonly string[]).includes(k) };
    byType.set(k, l);
    return l;
  };
  let lastRealEventAt: Date | null = null;
  for (const r of rows) {
    const l = line(r.eventType ?? "");
    if (isSelfTest(r.error)) { l.selfTests++; continue; }
    if (r.status === "REJECTED") { l.rejected++; continue; }
    l.received++;
    if (!lastRealEventAt || r.createdAt > lastRealEventAt) lastRealEventAt = r.createdAt;
    if (!l.lastReceivedAt || r.createdAt > l.lastReceivedAt) l.lastReceivedAt = r.createdAt;
    if (isUnsigned(r.error)) l.unsigned++;
    if (r.status === "PROCESSED") {
      l.processed++;
      const at = r.processedAt ?? r.createdAt;
      if (!l.lastProcessedAt || at > l.lastProcessedAt) l.lastProcessedAt = at;
    } else if (r.status === "ERROR") l.errored++;
  }
  for (const t of HANDLED_DELIVERY_EVENTS) line(t);
  const events = [...byType.values()].sort((a, b) => (b.lastReceivedAt?.getTime() ?? 0) - (a.lastReceivedAt?.getTime() ?? 0) || a.eventType.localeCompare(b.eventType));
  const sum = (k: keyof Pick<EventLine, "received" | "processed" | "errored" | "rejected" | "unsigned" | "selfTests">) => events.reduce((n, e) => n + e[k], 0);
  const totals = { received: sum("received"), processed: sum("processed"), errored: sum("errored"), rejected: sum("rejected"), unsigned: sum("unsigned"), selfTests: sum("selfTests") };

  // The receiver's own state, read raw — the secret is never touched here.
  const armRow = await prisma.appSetting.findUnique({ where: { key: "webhook-arm:aryeo" }, select: { value: true } }).catch(() => null);
  let arm: WebhookHealth["arm"] = null;
  if (armRow?.value) {
    try {
      const a = (typeof armRow.value === "string" ? JSON.parse(armRow.value) : armRow.value) as Record<string, unknown> & { proof?: Record<string, unknown> | null };
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      arm = {
        mode: str(a.mode) ?? "unknown", watchingSince: str(a.watchingSince), armedAt: str(a.armedAt), armedBy: str(a.armedBy),
        proofAt: str(a.proof?.at), proofCredential: str(a.proof?.credential), heldAt: str(a.heldAt), heldReason: str(a.heldReason),
      };
    } catch { arm = { mode: "unreadable", watchingSince: null, armedAt: null, armedBy: null, proofAt: null, proofCredential: null, heldAt: null, heldReason: null }; }
  }

  // The hourly passes that recover what a missing post would have carried.
  const runs = await prisma.cronRun.findMany({ where: { job: "sync", startedAt: { gte: since } }, orderBy: { startedAt: "desc" }, take: 6, select: { startedAt: true, ok: true, summary: true } });
  const recovery: WebhookHealth["recovery"] = [];
  for (const r of runs) {
    let summary: Record<string, unknown> = {};
    try { summary = JSON.parse(r.summary ?? "{}") as Record<string, unknown>; } catch { /* unreadable run */ }
    for (const step of ["readyToSendAryeo", "webhookSilence"]) {
      if (step in summary) recovery.push({ job: "sync", at: r.startedAt, ok: r.ok, step, result: JSON.stringify(summary[step]).slice(0, 240) });
    }
  }

  const silentHandledEvents = events.filter((e) => e.handledByDelivery && e.received === 0).map((e) => e.eventType);
  const verdict: string[] = [];
  if (!rows.length) verdict.push(`No Aryeo post at all in ${days} days — delivery evidence is arriving only through the hourly recovery pass, if at all.`);
  else if (!lastRealEventAt) verdict.push(`Only self-tests and refusals in ${days} days — Aryeo itself has not posted.`);
  else verdict.push(`Aryeo last posted ${Math.round((now.getTime() - lastRealEventAt.getTime()) / 3_600_000)}h ago.`);
  if (silentHandledEvents.length) verdict.push(`Handled delivery events never received in the window: ${silentHandledEvents.join(", ")} — the hourly readyToSendAryeo pass is the only source of that evidence.`);
  if (totals.rejected) verdict.push(`${totals.rejected} post(s) REFUSED at the door — a subscription is posting without the secret (check the arm state and Aryeo's subscription list).`);
  if (totals.unsigned) verdict.push(`${totals.unsigned} post(s) accepted UNSIGNED — the receiver is ${arm?.mode ?? "without a saved secret"}, not enforcing.`);
  if (arm?.mode === "armed" && arm.proofAt) verdict.push(`Signature enforcement is ARMED since ${arm.armedAt ?? arm.proofAt} (proved by ${arm.proofCredential ?? "a verified post"}).`);
  if (totals.errored) verdict.push(`${totals.errored} post(s) errored in processing — the retry sweep (webhookRetry) re-runs these.`);
  if (!recovery.some((r) => r.step === "readyToSendAryeo")) verdict.push("No recent hourly run recorded a readyToSendAryeo result — the recovery pass itself is not visible.");
  return { windowDays: days, arm, totals, lastRealEventAt, events, silentHandledEvents, recovery, verdict };
}

// ---- the command ------------------------------------------------------------

function readOnlyUrl(): string {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const m = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("DATABASE_URL not found");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}

async function main() {
  process.env.DATABASE_URL = readOnlyUrl();
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`OUTBOUND BLOCKED BY PROBE: ${typeof input === "string" ? input : "(request)"}`);
  }) as typeof fetch;
  const { prisma } = await import("../../src/lib/prisma");
  try {
    await prisma.$executeRawUnsafe(`UPDATE "Client" SET "name" = "name" WHERE false`);
    throw new Error("GUARD FAILED — the connection accepted a write");
  } catch (e) {
    if (!/25006|read-only/i.test(String(e))) throw e;
  }
  console.log("read-only connection proven (25006); outbound network refused\n");
  const i = process.argv.indexOf("--days");
  const days = i > 0 ? Math.max(1, Math.min(90, Number(process.argv[i + 1]) || 14)) : 14;
  const h = await webhookHealth(prisma as unknown as PrismaClient, { days });
  const when = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) + "Z" : "never");
  console.log(`ARYEO WEBHOOKS — last ${h.windowDays} days`);
  console.log(`receiver arm state: ${h.arm ? `${h.arm.mode}${h.arm.armedAt ? ` (armed ${h.arm.armedAt} by ${h.arm.armedBy ?? "?"})` : ""}${h.arm.heldAt ? ` (held ${h.arm.heldAt}: ${h.arm.heldReason ?? ""})` : ""}${h.arm.watchingSince ? ` · watching since ${h.arm.watchingSince}` : ""}` : "no arm record (no secret saved, or never cut over)"}`);
  console.log(`totals: received ${h.totals.received} · processed ${h.totals.processed} · errored ${h.totals.errored} · refused ${h.totals.rejected} · unsigned ${h.totals.unsigned} · self-tests ${h.totals.selfTests}`);
  console.log(`last real post: ${when(h.lastRealEventAt)}\n`);
  console.log("event type                      recv  proc  err  refused  unsigned  self  last received      last processed     handled");
  for (const e of h.events) {
    console.log(`${e.eventType.padEnd(30)} ${String(e.received).padStart(5)} ${String(e.processed).padStart(5)} ${String(e.errored).padStart(4)} ${String(e.rejected).padStart(8)} ${String(e.unsigned).padStart(9)} ${String(e.selfTests).padStart(5)}  ${when(e.lastReceivedAt).padEnd(18)} ${when(e.lastProcessedAt).padEnd(18)} ${e.handledByDelivery ? "yes" : ""}`);
  }
  console.log("\nhourly recovery (latest runs):");
  for (const r of h.recovery) console.log(`  ${when(r.at)} ${r.step.padEnd(18)} ${r.ok ? "ok " : "NOT OK"} ${r.result}`);
  if (!h.recovery.length) console.log("  (none recorded)");
  console.log("\nverdict:");
  for (const v of h.verdict) console.log(`  · ${v}`);
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
