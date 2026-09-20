/**
 * ACCEPTANCE JOURNEY — A STAFF ALERT THAT SLACK DROPPED (Sep 20 2026)
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a && \
 *     NODE_OPTIONS=--conditions=react-server \
 *     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/journey-alerts.ts
 *
 * THE INCIDENT THIS EXISTS FOR (journey-comms.ts journey 5, the one FAIL):
 * Slack ratelimits a DM to Kim Miguel. notifyInApp had already written the bell
 * row, so re-announcing the identical event threw P2002 on Notification.dedupeKey
 * and the catch swallowed it BEFORE bridgePerson — 0 further DM attempts, ever.
 * No sweep picked it up either: NotificationDelivery.status="failed" is read by
 * notifyPrefs.lastReachedByMember for the Settings "Last reached" line and by
 * nothing else, and the one safety net (relayUnreached) is opsAlert, which is
 * Slack, so during a Slack outage it fails with the message it is relaying. The
 * only way through was a NEW dedupeKey — which left two bell rows for one tag.
 * No duplicates OR a retry, never both. Kim is the person that strands: her
 * mention.sms switch is off and her +63 number is one staffTextNumber refuses,
 * so Slack is her only interruptive channel.
 *
 * WHAT THIS DRILL HAS TO SHOW, in both directions:
 *   1. the failure still looks exactly like the incident (bell kept, one DM
 *      attempt, Slack's own words in the log, the ops relay failing too), and
 *      a SECOND announcement arriving while that pass could still be running
 *      sends nothing at all (Sep 20 review: the first pass commits the bell row
 *      and then awaits Slack, so a retry that overtook it would DM twice);
 *   2. a re-announcement of the SAME event now retries the channel and lands,
 *      with ONE bell row and no second bell delivery line;
 *   3. once somebody has been reached, a further re-announcement sends nothing;
 *   4. a permanently broken Slack ID cannot loop — three attempts, then never;
 *   5. THE CONSERVATIVE HALF: a queued text counts as reached, so the retry can
 *      never add a second text — not even when the delivery log has LOST the
 *      row that said so, because the queue itself is asked before a retry
 *      texts — and a routine weekend alert held until Monday is not un-held by
 *      a re-announcement;
 *   6. a missing Slack ID stays the weekly People nudge's problem and burns its
 *      attempts like any other dead end.
 *
 * NOTHING SENDS. `fetch` itself is replaced with a recorder that answers the two
 * Slack methods and REFUSES every other URL, and OpenPhone is left unconnected,
 * so no text can be handed over at all. Every assertion is on what the code
 * DECIDED. Production is never touched: DATABASE_URL is repointed at the drill's
 * own PGlite before a single app module loads.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

// ---------------------------------------------------------------------------
// Module overrides — installed BEFORE any app module is resolved.
// ---------------------------------------------------------------------------
type SlackCall = { fn: "dm" | "notify"; to: string; text: string; ok: boolean };
const slackCalls: SlackCall[] = [];
/** Every non-Slack URL the code tried to open. Recorded AND refused — an
 *  OpenPhone send landing here would be a text that wanted to go out. */
const blockedUrls: string[] = [];
let slackUp = true;
let slackError = "ratelimited";

const OPS_CHANNEL = "C-DRILL-OPS";
const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// THE TRANSPORT IS HELD AT THE SOCKET, NOT AT THE MODULE (journey-comms.ts, the
// harness note worth carrying forward): notify.ts reaches every transport by
// DYNAMIC `await import()`, which arrives already resolved and comes back
// through Node's CJS→ESM interop with `default` alone, so a stub module becomes
// `undefined` on the very call being held still. The real Slack client runs and
// `fetch` is the seam.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  if (url.startsWith("https://slack.com/api/")) {
    const method = url.slice("https://slack.com/api/".length);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { channel?: string; text?: string }) : {};
    if (method === "conversations.list") return jsonRes({ ok: true, channels: [] });
    if (method === "conversations.open") return jsonRes({ ok: false, error: "missing_scope" });
    if (method === "chat.postMessage") {
      slackCalls.push({
        fn: body.channel === OPS_CHANNEL ? "notify" : "dm",
        to: body.channel ?? "?",
        text: body.text ?? "",
        ok: slackUp,
      });
      return jsonRes(slackUp ? { ok: true } : { ok: false, error: slackError });
    }
    return jsonRes({ ok: false, error: `drill: unstubbed slack method ${method}` });
  }
  blockedUrls.push(url);
  throw new Error(`drill: outbound network is disabled — ${url}`);
}) as typeof fetch;

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
const OVERRIDES: Record<string, unknown> = {
  "next/cache": { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f },
  "next/navigation": {
    redirect: () => {
      throw new Error("redirect");
    },
    notFound: () => {
      throw new Error("notFound");
    },
  },
  "next/headers": {},
};
// ---------------------------------------------------------------------------
// THE ONE HARNESS SHIM, AND WHY IT IS NOT HIDING THE BUG.
//
// PGlite's socket server de-syncs after Postgres answers a unique violation:
// the NEXT query on that connection comes back P1017 "Server has closed the
// connection". journey-comms.ts hit this too and worked around it in the drill's
// own reads (`dbRetry`), which was enough while the product code returned
// immediately on P2002. It is not enough now — the retry's first act is a
// findUnique on the row the collision named, i.e. a query on exactly the
// connection PGlite has just dropped, so without this shim the drill measures
// the harness instead of the fix.
//
// Real Postgres does not close a connection over a duplicate key. The INSERT is
// a single statement outside any transaction, and Neon leaves the session
// usable — verified against production below in the report. So the shim
// restores the behaviour of the database the code actually runs on; it does not
// paper over anything the code does.
//
// It hangs off the STATIC `import { prisma } from "@/lib/prisma"` in notify.ts,
// which reaches Module._load as the bare specifier (the same seam journey-comms
// used for the session stub). The extension shares the underlying engine, so
// the drill's own client and the product's are the same database.
// ---------------------------------------------------------------------------
type QueryHook = (p: { query: (a: unknown) => Promise<unknown>; args: unknown }) => Promise<unknown>;
type RetryableClient = {
  $disconnect(): Promise<void>;
  $extends(ext: { query: { $allOperations: QueryHook } }): unknown;
};
const isSocketDesync = (e: unknown): boolean =>
  (e as { code?: string } | null)?.code === "P1017" || /closed the connection/i.test(String(e));

let prismaModule: unknown = null;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request in OVERRIDES) return OVERRIDES[request];
  if (request === "@/lib/prisma") {
    if (!prismaModule) {
      const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
      const base = real.prisma as RetryableClient;
      const resilient = base.$extends({
        query: {
          $allOperations: async ({ query, args }) => {
            try {
              return await query(args);
            } catch (e) {
              if (!isSocketDesync(e)) throw e;
              await base.$disconnect().catch(() => {});
              return await query(args);
            }
          },
        },
      });
      const shape = { ...real, prisma: resilient };
      prismaModule = { __esModule: true, ...shape, default: shape };
    }
    return prismaModule;
  }
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = 5491;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
process.env.AUTH_ENFORCE = "false";
delete process.env.VERCEL;
process.env.NEXT_PUBLIC_APP_URL = "https://hub.realtourpilot.invalid";
// Pins the ops channel so an ops-channel line is distinguishable from a DM —
// with no channel configured, alertDestination falls back to Kyle's own DM.
process.env.SLACK_ALERT_CHANNEL = OPS_CHANNEL;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else {
    fail++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
  }
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const { notifyInApp, holdUntilCovered, flushPendingSms } = await import("@/lib/notify");
  type Role = Parameters<typeof prisma.teamMember.create>[0]["data"]["role"];

  // Slack is "connected" so the real client takes its normal path; every call
  // it makes lands in the fetch recorder above, never on a socket.
  await saveSecret("slack", "xoxb-drill-not-a-real-token");

  /** PGlite's socket server de-syncs after Postgres answers a unique violation:
   *  the next query can come back P1017 "server has closed the connection".
   *  This whole drill is BUILT on unique violations, so a read after one
   *  reconnects once rather than reporting a harness artefact as a product
   *  defect. (Carried forward from journey-comms.ts.) */
  const dbRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== "P1017" && !/closed the connection/i.test(String(e))) throw e;
      await prisma.$disconnect().catch(() => {});
      return await fn();
    }
  };

  const NOW = new Date();
  console.log("=".repeat(78));
  console.log("ACCEPTANCE JOURNEY — a staff alert that Slack dropped");
  console.log(`  clock: ${NOW.toISOString()} (${NOW.toString().slice(0, 3)}, ET ${NOW.toLocaleString("en-US", { timeZone: "America/New_York" })})`);
  console.log("=".repeat(78));

  // -------------------------------------------------------------------------
  // The cast. Every roster row exists before the first call, because the notify
  // stack caches the editor map and the owner list for ten minutes.
  // -------------------------------------------------------------------------
  const mkMember = (o: { name: string; email: string; role: Role; phone?: string | null; slackId?: string | null }) =>
    prisma.teamMember.create({
      data: {
        name: o.name,
        email: o.email,
        role: o.role,
        phone: o.phone ?? null,
        slackId: o.slackId ?? null,
        active: true,
        payPercent: 0.35,
        payFloor: 100,
      },
      select: { id: true, name: true },
    });

  await mkMember({ name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", phone: "(610) 555-0102", slackId: "U-KYLE" });
  // Kim: Slack-only by preference AND by policy (+63 is untextable).
  const kim = await mkMember({ name: "Kim Miguel", email: "kim@drill.invalid", role: "MANAGER", phone: "+63 917 555 0134", slackId: "U-KIM" });
  // John: the same shape with a Slack ID that will never work again.
  const john = await mkMember({ name: "John Mark", email: "johnmark@drill.invalid", role: "EDITOR", phone: null, slackId: "U-JOHN" });
  // James: a US number AND Slack — the person a careless retry would text twice.
  const james = await mkMember({ name: "James Ortiz", email: "james@drill.invalid", role: "PHOTOGRAPHER", phone: "(610) 555-0177", slackId: "U-JAMES" });
  // Remar: a brand-new card with no Slack ID on file at all.
  const remar = await mkMember({ name: "Remar Cruz", email: "remar@drill.invalid", role: "EDITOR", phone: null, slackId: null });

  const client = await prisma.client.create({ data: { name: "Nadia Okafor", phone: "(610) 555-0300" }, select: { id: true } });
  const job = await prisma.project.create({
    data: { title: "632 Greenridge Rd, Royersford, PA", clientId: client.id, status: "EDITING", addressLine: "632 Greenridge Rd" },
    select: { id: true },
  });

  await putSetting(`notify-prefs:${kim.id}`, { mention: { slack: true, sms: false } });
  await putSetting(`notify-prefs:${john.id}`, { mention: { slack: true, sms: false } });
  await putSetting(`notify-prefs:${james.id}`, { mention: { slack: true, sms: true }, review_ready: { slack: true, sms: true } });
  await putSetting(`notify-prefs:${remar.id}`, { mention: { slack: true, sms: false } });

  const dmFor = (who: string) => `💬 Kyle Smith mentioned you on 632 Greenridge Rd (Nadia Okafor) — a cut note\n> ${who}, please brighten the kitchen\nhttps://hub.realtourpilot.invalid/edit/${job.id}`;
  const announce = (o: { tmId: string; key: string; dm: string; kind?: string; title?: string }) =>
    notifyInApp({
      kind: o.kind ?? "mention",
      title: o.title ?? "Kyle Smith mentioned you — 632 Greenridge Rd",
      body: "please brighten the kitchen",
      href: `/edit/${job.id}`,
      targets: [{ roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${o.tmId}`, slackDm: o.dm }],
      dedupeKey: o.key,
    });

  /** A re-announcement only counts as an outage recovery once the first pass
   *  has had time to finish (BRIDGE_IN_FLIGHT_MS, Sep 20 review): inside that
   *  minute the first pass may still be awaiting Slack, and a retry that
   *  overtook it would DM the same person twice. Every re-announcement below
   *  is a stand-in for one minutes or hours later, so the drill ages the bell
   *  row rather than sleeping. Section 1a is the one that does NOT age it, and
   *  proves the guard. */
  const ageBellRow = (key: string, minutes = 5) =>
    dbRetry(() =>
      prisma.notification.updateMany({
        where: { dedupeKey: `${key}-0` },
        data: { createdAt: new Date(Date.now() - minutes * 60_000) },
      }),
    );

  const dms = (to: string) => slackCalls.filter((c) => c.fn === "dm" && c.to === to);
  const legs = (teamMemberId: string, channel: string, status?: string) =>
    dbRetry(() => prisma.notificationDelivery.count({ where: { teamMemberId, channel, ...(status ? { status } : {}) } }));
  const bellRows = (key: string) => dbRetry(() => prisma.notification.count({ where: { dedupeKey: `${key}-0` } }));

  // =========================================================================
  // 1 — THE FAILURE, unchanged: the incident still looks like the incident
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("1. SLACK RATELIMITS THE DM — the bell row is written first, as it always was");
  console.log("-".repeat(78));

  const KIM_KEY = "drill-mention-kim-transient";
  slackUp = false;
  slackError = "ratelimited";
  slackCalls.length = 0;
  await announce({ tmId: kim.id, key: KIM_KEY, dm: dmFor("Kim") });

  console.log(`     attempt 1: bell rows=${await bellRows(KIM_KEY)} DM attempts=${dms("U-KIM").length}`);
  check("the bell row is created and kept", (await bellRows(KIM_KEY)) === 1);
  check("the Slack DM was attempted exactly once", dms("U-KIM").length === 1, `${dms("U-KIM").length}`);
  const failedLog = await prisma.notificationDelivery.findFirst({
    where: { teamMemberId: kim.id, channel: "slack", status: "failed" },
    orderBy: { createdAt: "desc" },
    select: { detail: true },
  });
  check("the failure is recorded with Slack's own words", /ratelimited/.test(failedLog?.detail ?? ""), failedLog?.detail?.slice(0, 60) ?? "no row");
  check("the bell delivery is logged too, so \"bell only\" is visible as such", (await legs(kim.id, "bell", "sent")) === 1);
  check("no text leg was attempted — her switch is off", (await legs(kim.id, "sms")) === 0);
  const relay1 = slackCalls.find((c) => c.fn === "notify" && /Couldn't reach/.test(c.text));
  check("the unreached relay fires", !!relay1, relay1?.text.slice(0, 60) ?? "none");
  check("…and it failed too, because the relay is Slack as well", relay1?.ok === false, `ok=${relay1?.ok}`);

  // =========================================================================
  // 1a — TWO ANNOUNCEMENTS OF ONE EVENT, MILLISECONDS APART
  //      (the TOCTOU the retry opened, Sep 20 review)
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("1a. THE SAME EVENT ANNOUNCED TWICE AT ONCE — the first pass may still be in flight");
  console.log("-".repeat(78));
  // No ageing: this is the shape of two processes (two webhook deliveries, a
  // cron overlapping a save) announcing one event inside the same second. The
  // delivery log cannot yet say what the first pass did, so the only safe
  // answer is silence — a second DM here would be the duplicate the whole fix
  // exists to avoid.
  slackCalls.length = 0;
  const kimSlackLegsBefore = await legs(kim.id, "slack");
  await announce({ tmId: kim.id, key: KIM_KEY, dm: dmFor("Kim") });
  check("no second DM while the first pass could still be running", dms("U-KIM").length === 0, `${dms("U-KIM").length} attempts`);
  check("no second channel leg either", (await legs(kim.id, "slack")) === kimSlackLegsBefore, `${kimSlackLegsBefore} → ${await legs(kim.id, "slack")}`);
  check("and still one bell row", (await bellRows(KIM_KEY)) === 1);

  // =========================================================================
  // 2 — THE RETRY: re-announcing the same event once Slack is back
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("2. THE SAME ALERT, RE-ANNOUNCED — this is the line that used to be a no-op");
  console.log("-".repeat(78));

  slackUp = true;
  slackCalls.length = 0;
  await ageBellRow(KIM_KEY);
  const bellLegsBefore = await legs(kim.id, "bell", "sent");
  const attempt2 = await announce({ tmId: kim.id, key: KIM_KEY, dm: dmFor("Kim") });
  const dm2 = dms("U-KIM");
  console.log(`     attempt 2 (same dedupeKey): bell rows=${await bellRows(KIM_KEY)} DM attempts=${dm2.length}`);
  check("the Slack leg is retried and lands", dm2.length === 1 && dm2[0].ok, `${dm2.length} attempts, ok=${dm2[0]?.ok}`);
  check("re-announcing does NOT duplicate the alert", (await bellRows(KIM_KEY)) === 1, `${await bellRows(KIM_KEY)} bell rows`);
  check("only ONE bell row exists for the whole tag", (await dbRetry(() => prisma.notification.count({ where: { userKey: `tm:${kim.id}` } }))) === 1);
  check("the delivery log records a successful Slack DM", (await legs(kim.id, "slack", "sent")) === 1);
  check("the bell leg is NOT logged a second time — the row was rung once", (await legs(kim.id, "bell", "sent")) === bellLegsBefore, `${bellLegsBefore} → ${await legs(kim.id, "bell", "sent")}`);
  check("no ops relay this time, because she was reached", !slackCalls.some((c) => c.fn === "notify" && /Couldn't reach/.test(c.text)));
  check("the retry does not re-announce the delivery to the emitter", attempt2.bridged.length === 0, `${attempt2.bridged.length} bridged entries`);

  // =========================================================================
  // 3 — ONCE REACHED, NOTHING IS SENT AGAIN
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("3. A THIRD ANNOUNCEMENT OF A DELIVERED ALERT — silence is the right answer");
  console.log("-".repeat(78));
  slackCalls.length = 0;
  await ageBellRow(KIM_KEY);
  await announce({ tmId: kim.id, key: KIM_KEY, dm: dmFor("Kim") });
  check("no further DM is sent", dms("U-KIM").length === 0, `${dms("U-KIM").length} attempts`);
  check("the slack sent-row count is unchanged", (await legs(kim.id, "slack", "sent")) === 1);
  check("still one bell row", (await bellRows(KIM_KEY)) === 1);

  // =========================================================================
  // 4 — A PERMANENTLY BROKEN SLACK ID CANNOT LOOP
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("4. SLACK NEVER COMES BACK — the attempt cap, read off the delivery log");
  console.log("-".repeat(78));
  const JOHN_KEY = "drill-mention-john-dead-id";
  slackUp = false;
  slackError = "account_inactive";
  slackCalls.length = 0;
  for (let i = 0; i < 6; i++) {
    await ageBellRow(JOHN_KEY);
    await announce({ tmId: john.id, key: JOHN_KEY, dm: dmFor("John") });
  }
  const johnDms = dms("U-JOHN").length;
  console.log(`     six announcements of one event → ${johnDms} DM attempts`);
  check("the DM is attempted three times and then never again", johnDms === 3, `${johnDms} attempts over 6 announcements`);
  check("three failures are on the log, one per attempt", (await legs(john.id, "slack", "failed")) === 3, `${await legs(john.id, "slack", "failed")}`);
  check("and still exactly one bell row for the event", (await bellRows(JOHN_KEY)) === 1, `${await bellRows(JOHN_KEY)}`);
  check("the bell leg was logged once, not six times", (await legs(john.id, "bell", "sent")) === 1, `${await legs(john.id, "bell", "sent")}`);
  // THE ONE THING THAT GOES UP. relayUnreached is not suppressed on a retry,
  // on purpose: in the scenario this whole fix exists for, the FIRST relay
  // fails because it is Slack and Slack is the thing that is down (proved in
  // section 1, ok=false), so a retry that stayed silent would relay nothing at
  // all. The cost is bounded by the same cap — one ops line per attempt, three
  // for the life of an alert, and zero once anybody is reached (section 2).
  const johnOps = slackCalls.filter((c) => c.fn === "notify" && /Couldn't reach John Mark/.test(c.text)).length;
  check("the ops relay repeats once per attempt and no more", johnOps === 3, `${johnOps} ops lines across 6 announcements`);

  // =========================================================================
  // 5 — THE CONSERVATIVE HALF: a retry may never add a send
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("5. A QUEUED TEXT COUNTS AS REACHED — the retry can never text anybody twice");
  console.log("-".repeat(78));
  // James wants both channels. Slack is down; the text queues. He HAS been
  // reached — the line is in PendingSms with the flusher behind it — so a
  // re-announcement must not queue a second copy, even though his DM failed.
  const JAMES_KEY = "drill-mention-james-both-channels";
  slackUp = false;
  slackError = "ratelimited";
  slackCalls.length = 0;
  await announce({ tmId: james.id, key: JAMES_KEY, dm: dmFor("James") });
  const jamesQueued1 = await dbRetry(() => prisma.pendingSms.count({ where: { teamMemberId: james.id } }));
  check("his DM failed", (await legs(james.id, "slack", "failed")) === 1);
  check("his text was queued", jamesQueued1 === 1 && (await legs(james.id, "sms", "queued")) === 1, `${jamesQueued1} PendingSms rows`);

  slackUp = true;
  slackCalls.length = 0;
  await ageBellRow(JAMES_KEY);
  await announce({ tmId: james.id, key: JAMES_KEY, dm: dmFor("James") });
  const jamesQueued2 = await dbRetry(() => prisma.pendingSms.count({ where: { teamMemberId: james.id } }));
  check("re-announcing queues NO second text", jamesQueued2 === jamesQueued1, `${jamesQueued1} → ${jamesQueued2}`);
  check(
    "…and does not re-fire the DM either: a queued line means he was reached",
    dms("U-JAMES").length === 0,
    `${dms("U-JAMES").length} attempts — deliberately conservative; the retry exists for an alert that reached NOBODY`,
  );

  console.log("\n5a. THE DELIVERY LOG LOSES THE QUEUED LINE — the queue still stops the second text");
  // logDelivery is best-effort by contract ("never throws; a failure is a
  // console line"), and queueStaffSms writes the PendingSms row FIRST and logs
  // the queued leg SECOND. Lose that one write and the text really is on its
  // way while the log says nobody was reached. Production shows the shape is
  // real: 99 of 126 PendingSms rows carry no queued leg at all. Deleting the
  // leg here IS that lost write, exactly.
  await dbRetry(() => prisma.notificationDelivery.deleteMany({ where: { teamMemberId: james.id, channel: "sms", status: "queued" } }));
  const jamesUnsent = await dbRetry(() =>
    prisma.pendingSms.count({ where: { teamMemberId: james.id, sentAt: null, skippedAt: null } }),
  );
  slackUp = true;
  slackCalls.length = 0;
  await ageBellRow(JAMES_KEY);
  await announce({ tmId: james.id, key: JAMES_KEY, dm: dmFor("James") });
  const jamesQueued3 = await dbRetry(() => prisma.pendingSms.count({ where: { teamMemberId: james.id } }));
  check("the line is still sitting unsent in the queue", jamesUnsent === 1, `${jamesUnsent} unsent`);
  check("with the log gone, STILL no second text is queued", jamesQueued3 === jamesQueued2, `${jamesQueued2} → ${jamesQueued3}`);
  check(
    "the refusal is written down as its own leg, not left silent",
    (await dbRetry(() =>
      prisma.notificationDelivery.count({ where: { teamMemberId: james.id, channel: "sms", status: "skipped", detail: { contains: "already queued" } } }),
    )) === 1,
  );
  check("and the DM, which nothing else recorded, IS retried", dms("U-JAMES").length === 1, `${dms("U-JAMES").length} attempts`);
  check("no ops relay: the queued line means he is being reached", !slackCalls.some((c) => c.fn === "notify" && /Couldn't reach James/.test(c.text)));

  console.log("\n5b. A ROUTINE WEEKEND ALERT HELD UNTIL MONDAY IS NOT UN-HELD BY A RE-ANNOUNCEMENT");
  // cut_ready is a ROUTINE kind on the office clock. Raised on a day the rota
  // does not cover, the text is dated to the next covered moment and the DM is
  // held beside it (Sep 20, audit F07). A retry must not undo that.
  const hold = await holdUntilCovered("cut_ready", undefined);
  console.log(`     holdUntilCovered("cut_ready") → ${hold ? hold.toISOString() : "null (a day somebody works)"}`);
  const CUT_KEY = "drill-cutready-james-weekend";
  slackUp = true;
  slackCalls.length = 0;
  await announce({ tmId: james.id, key: CUT_KEY, dm: "", kind: "cut_ready", title: "Cut ready to review — 632 Greenridge Rd" });
  const heldRow = await dbRetry(() =>
    prisma.pendingSms.findFirst({ where: { teamMemberId: james.id, line: { contains: "Cut ready" } }, select: { id: true, deferUntil: true } }),
  );
  const dmsAfterFirst = dms("U-JAMES").length;
  if (hold) {
    check("the text is dated to the next covered moment", heldRow?.deferUntil?.toISOString() === hold.toISOString(), `${heldRow?.deferUntil?.toISOString() ?? "null"}`);
    check("and the DM is held beside it, not fired", dmsAfterFirst === 0, `${dmsAfterFirst} DM attempts`);
    check("the hold is logged as a hold, not a failure", (await legs(james.id, "slack", "skipped")) >= 1);
  } else {
    check("in cover, the DM goes now", dmsAfterFirst === 1, `${dmsAfterFirst} DM attempts`);
  }
  slackCalls.length = 0;
  await ageBellRow(CUT_KEY);
  await announce({ tmId: james.id, key: CUT_KEY, dm: "", kind: "cut_ready", title: "Cut ready to review — 632 Greenridge Rd" });
  const heldAfter = await dbRetry(() =>
    prisma.pendingSms.findFirst({ where: { teamMemberId: james.id, line: { contains: "Cut ready" } }, select: { deferUntil: true } }),
  );
  check("re-announcing does not release the hold", heldAfter?.deferUntil?.toISOString() === heldRow?.deferUntil?.toISOString(), `${heldAfter?.deferUntil?.toISOString() ?? "null"}`);
  check("and does not buzz the DM the hold was protecting", dms("U-JAMES").length === 0, `${dms("U-JAMES").length} attempts`);
  const cutTexts = await dbRetry(() => prisma.pendingSms.count({ where: { teamMemberId: james.id, line: { contains: "Cut ready" } } }));
  check("exactly one queued line for the cut, not two", cutTexts === 1, `${cutTexts}`);

  // =========================================================================
  // 6 — A MISSING SLACK ID STAYS THE WEEKLY NUDGE'S PROBLEM
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("6. NO SLACK ID ON FILE — a configuration gap, not an outage");
  console.log("-".repeat(78));
  const REMAR_KEY = "drill-mention-remar-no-slack-id";
  slackUp = true;
  slackCalls.length = 0;
  for (let i = 0; i < 5; i++) {
    await ageBellRow(REMAR_KEY);
    await announce({ tmId: remar.id, key: REMAR_KEY, dm: dmFor("Remar") });
  }
  const skipped = await legs(remar.id, "slack", "skipped");
  console.log(`     five announcements → ${skipped} "no Slack ID on file" rows`);
  check("the gap is logged, and the attempts are capped like any other dead end", skipped === 3, `${skipped} rows`);
  check("one bell row, five announcements", (await bellRows(REMAR_KEY)) === 1);
  check(
    "no ops relay per announcement — the weekly People nudge owns this",
    !slackCalls.some((c) => c.fn === "notify" && /Couldn't reach Remar/.test(c.text)),
    slackCalls.filter((c) => c.fn === "notify").length + " ops lines",
  );

  console.log("\n6a. THE SAME KEY, A DIFFERENT PERSON AT THAT INDEX");
  // dedupeKey is "<base>-<i>", the POSITION in the target array. A target list
  // whose composition changes between two announcements (an editor row that is
  // in-house one time and external the next) slides everybody after it up an
  // index, so a collision can name somebody else's row. The retry refuses
  // rather than DM person B on person A's row (Sep 20 review).
  const SWAP_KEY = "drill-positional-key-swap";
  slackUp = false;
  slackError = "ratelimited";
  slackCalls.length = 0;
  await announce({ tmId: john.id, key: SWAP_KEY, dm: dmFor("John") });
  slackUp = true;
  slackCalls.length = 0;
  await ageBellRow(SWAP_KEY);
  await announce({ tmId: james.id, key: SWAP_KEY, dm: dmFor("James") });
  check("the person at that index changed, so nothing is sent", dms("U-JAMES").length === 0, `${dms("U-JAMES").length} attempts`);
  const swapRows = await dbRetry(() => prisma.notification.findMany({ where: { dedupeKey: `${SWAP_KEY}-0` }, select: { id: true } }));
  const swapLegs = await dbRetry(() =>
    prisma.notificationDelivery.count({ where: { teamMemberId: james.id, notificationId: { in: swapRows.map((r) => r.id) } } }),
  );
  check("and no delivery leg is written against the other person's row", swapLegs === 0, `${swapLegs} legs`);
  check("the row still belongs to the person it was minted for", (await dbRetry(() => prisma.notification.count({ where: { dedupeKey: `${SWAP_KEY}-0`, userKey: `tm:${john.id}` } }))) === 1);

  // =========================================================================
  // 7 — NOTHING LEFT THE PROCESS
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("7. NOTHING SENT");
  console.log("-".repeat(78));
  const flushed = await flushPendingSms();
  console.log(`     flushPendingSms → ${JSON.stringify(flushed)}`);
  check("no text was ever handed to OpenPhone", !blockedUrls.some((u) => /openphone/i.test(u)), blockedUrls.join(" ") || "no outbound attempts at all");
  check("no outbound call left this process at all", blockedUrls.length === 0, blockedUrls.join(" ") || "none");

  console.log("\n" + "=".repeat(78));
  console.log(`${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailed checks:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log("=".repeat(78));

  await prisma.$disconnect();
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
