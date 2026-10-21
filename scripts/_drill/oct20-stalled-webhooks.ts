// ---------------------------------------------------------------------------
// DRILL: STALLED WEBHOOK RECEIPTS ARE REPLAYED, AND ONLY ONCE (Oct 20 2026,
// audit H8 follow-up).
//
// OpenPhone and Slack store the event row, answer 200 and do the work in
// after(). If that after() dies the row stays RECEIVED, and no provider
// resends it (it was told 200). The hourly sweep (lib/webhookRetry
// retryFailedWebhooks) now replays such a row once it is 15 minutes old:
//
//   1. a stalled Slack row is replayed through the receiver's own processor
//      and closed PROCESSED; a 5-minute-old one is left to its own after();
//      a row from before the after() change is left alone.
//   2. two sweeps at once replay a stalled row ONCE (the claim).
//   3. a stalled OpenPhone row with a processed twin is closed against it,
//      not replayed; one whose newer copy is still in flight waits; an
//      UNSIGNED row keeps its marker through the replay.
//   4. a replay that fails is left ERROR with its retry clock (visible on
//      /connections); a row another sweep holds (its lease) is left alone.
//
// ISOLATION: PGlite via the shared harness. The Slack processor runs for real
// with what it calls stubbed: its comms write is COUNTED (that is how a
// replay is seen), the sender lookup and the AI task step are no-ops. The
// OpenPhone rows here carry no phone numbers, so its processor returns at
// once. No call leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7241);
installNextStubs();
const fence = fenceFetch(async () => null);

// ---- what processSlackEvent calls, stubbed ---------------------------------
const logged: string[] = [];
let slowMs = 0;
let failNext = false;
const isLib = (r: string, p: string) => r === `@/lib/${p}` || new RegExp(`[\\\\/]lib[\\\\/]${p.split("/").join("[\\\\/]")}(\\.ts)?$`).test(r);
interceptModule((r) => isLib(r, "commLog"), (loaded) => ({
  ...(loaded as Record<string, unknown>),
  logComm: async (input: { body: string }) => {
    logged.push(input.body);
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    if (failNext) { failNext = false; throw new Error("isolated processing failure"); }
    return null;
  },
}));
interceptModule((r) => isLib(r, "integrations/slack"), (loaded) => ({ ...(loaded as Record<string, unknown>), slackUserName: async () => "Drill Person" }));
interceptModule((r) => isLib(r, "integrations/slackSync"), (loaded) => ({ ...(loaded as Record<string, unknown>), maybeCreateSlackTask: async () => {} }));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
/** How many times the Slack message with these words was processed. */
const callsFor = (words: string) => logged.filter((b) => b === words).length;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { retryFailedWebhooks, webhookErrorCount } = await import("@/lib/webhookRetry");
  const slackRow = (key: string, createdAt: Date, extra: { status?: string; error?: string | null } = {}) =>
    prisma.webhookEvent.create({ data: { provider: "slack", eventType: "message", externalId: `Ev-${key}`, payload: JSON.stringify({ event_id: `Ev-${key}`, event: { type: "message", user: "U1", channel: "C1", ts: "1760000000.000100", text: key } }), createdAt, ...extra } });
  // No phone numbers on the event: processOpenPhoneEvent returns at once.
  const opRow = (key: string, createdAt: Date, extra: { status?: string; error?: string | null } = {}) =>
    prisma.webhookEvent.create({ data: { provider: "openphone", eventType: "message.received", externalId: `EV-${key}`, payload: JSON.stringify({ id: `EV-${key}`, type: "message.received", data: { object: { id: `OP-${key}`, direction: "incoming", text: "hi" } } }), createdAt, ...extra } });
  const rowOf = (id: string) => prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  try {
    // =======================================================================
    c.head("1 · a stalled receipt is replayed; a fresh one and an old one are not");
    {
      const stalled = await slackRow("s1", minutesAgo(20));
      const fresh = await slackRow("s2", minutesAgo(5));
      const old = await slackRow("s3", new Date("2026-10-01T12:00:00-04:00"));
      const r = await retryFailedWebhooks();
      const s = await rowOf(stalled.id);
      c.ok("the 20-minute-old RECEIVED Slack row went through the receiver's processor once and is PROCESSED", callsFor("s1") === 1 && s.status === "PROCESSED" && !!s.processedAt && r.stalled === 1 && r.recovered === 1, `${s.status} ${JSON.stringify(r)}`);
      c.ok("…a 5-minute-old one is left to its own background step", callsFor("s2") === 0 && (await rowOf(fresh.id)).status === "RECEIVED");
      c.ok("…and one from before the after() change is left alone", callsFor("s3") === 0 && (await rowOf(old.id)).status === "RECEIVED");
      const again = await retryFailedWebhooks();
      c.ok("a second sweep replays nothing again", callsFor("s1") === 1 && again.stalled === 0, JSON.stringify(again));
    }

    // =======================================================================
    c.head("2 · two sweeps at once replay a stalled row once");
    {
      const row = await slackRow("p1", minutesAgo(30));
      slowMs = 150;
      const [a, b] = await Promise.all([retryFailedWebhooks(), retryFailedWebhooks()]);
      slowMs = 0;
      c.ok("the processor ran once; one sweep claimed it, the other left it", callsFor("p1") === 1 && a.stalled + b.stalled === 1 && (await rowOf(row.id)).status === "PROCESSED", `${callsFor("p1")} ${JSON.stringify([a, b])}`);
    }

    // =======================================================================
    c.head("3 · twins, copies in flight, and the UNSIGNED marker");
    {
      const stalled = await opRow("t1", minutesAgo(40));
      await opRow("t1", minutesAgo(35), { status: "PROCESSED" });
      const waiting = await opRow("w1", minutesAgo(40));
      const inFlight = await opRow("w1", minutesAgo(2));
      const unsigned = await opRow("u1", minutesAgo(25), { error: "UNSIGNED: no webhook token configured" });
      const r = await retryFailedWebhooks();
      const t = await rowOf(stalled.id);
      c.ok("a stalled OpenPhone row with a processed twin is closed against it, never replayed", t.status === "PROCESSED" && /^Resolved/.test(t.error ?? "") && r.deduped === 1, `${t.status} ${t.error}`);
      c.ok("…one whose newer copy is still being worked waits (both untouched)", (await rowOf(waiting.id)).status === "RECEIVED" && (await rowOf(inFlight.id)).status === "RECEIVED");
      const u = await rowOf(unsigned.id);
      c.ok("…an UNSIGNED stalled row is replayed and keeps its marker", u.status === "PROCESSED" && (u.error ?? "").startsWith("UNSIGNED") && r.recovered === 1 && r.stalled === 2, `${u.status} ${u.error} ${JSON.stringify(r)}`);
    }

    // =======================================================================
    c.head("4 · a failed replay stays visible; a held row is left alone");
    {
      const before = await webhookErrorCount();
      const row = await slackRow("f1", minutesAgo(50));
      failNext = true;
      const r = await retryFailedWebhooks();
      const f = await rowOf(row.id);
      c.ok("a replay that fails is ERROR with the reason and its retry clock", callsFor("f1") === 1 && f.status === "ERROR" && /isolated processing failure/.test(f.error ?? "") && /\[\[retry n=1 next=/.test(f.error ?? "") && r.failed === 1, `${f.status} ${f.error}`);
      c.ok("…and it counts on /connections", (await webhookErrorCount()) === before + 1);
      const held = await slackRow("h1", minutesAgo(70), { status: "ERROR", error: `Stalled: being replayed [[retry n=1 next=${new Date(Date.now() + 20 * 60_000).toISOString()}]]` });
      await retryFailedWebhooks();
      c.ok("a row another sweep holds (its lease still running) is not replayed", callsFor("h1") === 0 && (await rowOf(held.id)).status === "ERROR");
    }

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => { console.error(e); process.exit(1); },
);
