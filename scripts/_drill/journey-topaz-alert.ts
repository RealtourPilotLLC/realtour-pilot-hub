/**
 * ACCEPTANCE JOURNEY — KYLE HEARS ABOUT THE VIDEO (Sep 21 2026)
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a && \
 *     NODE_OPTIONS=--conditions=react-server \
 *     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/journey-topaz-alert.ts
 *
 * THE INCIDENT. Three approved videos — 5 Raymond Cir (Brie Martinez), 453
 * Cardigan Terrace (Renee Ryan), 5642 Limeport Rd (Sarina Spinelli) — sat
 * unsent for up to three days. Nobody ignored them. Kyle could not see them:
 * the card that lists them is gated to the owner, and his copy lives inside a
 * time block that opens by itself between 1:00 and 1:30 PM.
 *
 * WHAT JORDAN ASKED FOR, in his own words: "I just want to make sure Kyle gets
 * that view and is notified via Slack when a video is ready for review, and
 * then when a video is back from Topaz."
 *
 * THE TWO HALVES ARE NOT IN THE SAME STATE, and that is the first thing this
 * drill exists to hold still:
 *   · "ready for review" (cut_ready) ALREADY WORKS. Kyle's saved matrix reads
 *     review_ready {slack:true, sms:false}, written 2026-09-18 20:54Z, and
 *     every cut_ready broadcast since has written him a slack/sent leg (21:24
 *     Sep 18, 13:26 and 16:22 Sep 19 — three for three). Nothing here touches
 *     it; sections 2 and 4 are there to prove it still behaves after the
 *     change, because a working path broken in passing is the expensive kind.
 *   · "back from Topaz" (topaz_ready) DID NOT. It was unclassified, so it rang
 *     the bell and stopped: 13 topaz_ready delivery legs to Kyle in 21 days,
 *     every one of them channel=bell and nothing else. That is the gap, and
 *     KIND_TO_EVENT now maps it to review_ready — the same switch, because
 *     Jordan named the two events as one want.
 *
 * WHAT THIS ASSERTS ON: what the code DECIDED. Slack is held at `fetch` and
 * every non-Slack URL is refused outright, so an OpenPhone send would be a
 * recorded refusal rather than a text. Production is never touched —
 * DATABASE_URL is repointed at the drill's own PGlite before a single app
 * module loads.
 *
 * THE CLOCK IS MOVED, ON PURPOSE. Sections 3 and 4 ask the Saturday question,
 * and the bridge asks it of `new Date()` from inside itself. Rather than
 * re-implement the rule in the test (the mistake holdUntilCovered's own
 * comment warns about), the drill shifts the process clock onto a real
 * Saturday and lets the product code answer for itself.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import path from "path";
import Module from "node:module";

// ---------------------------------------------------------------------------
// Module overrides + the transport seam — installed BEFORE any app module is
// resolved. Same shape as journey-alerts.ts: notify.ts reaches every transport
// by dynamic `await import()`, so the honest seam is `fetch`, not a stub module.
// ---------------------------------------------------------------------------
type SlackCall = { fn: "dm" | "notify"; to: string; text: string; ok: boolean };
const slackCalls: SlackCall[] = [];
/** Every non-Slack URL the code tried to open. Recorded AND refused — an
 *  OpenPhone send landing here would be a text that wanted to go out. */
const blockedUrls: string[] = [];
// Slack is up for the whole of this drill: the outage and retry behaviour is
// journey-alerts.ts's subject, not this one's. Kept as a named flag so the
// recorder below reads the same as its sibling.
const slackUp = true;

const OPS_CHANNEL = "C-DRILL-OPS";
const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

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
      return jsonRes(slackUp ? { ok: true } : { ok: false, error: "ratelimited" });
    }
    return jsonRes({ ok: false, error: `drill: unstubbed slack method ${method}` });
  }
  blockedUrls.push(url);
  throw new Error(`drill: outbound network is disabled — ${url}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// THE CLOCK. A Proxy over the real Date, so instances stay real Dates
// (instanceof, Prisma serialisation and PGlite all keep working) and only
// "what time is it now" moves. Sections 1, 2 and 5 run on the real clock;
// 3 and 4 run with it parked on a Saturday morning in ET.
// ---------------------------------------------------------------------------
const RealDate = Date;
let clockOffsetMs = 0;
const drillNow = () => RealDate.now() + clockOffsetMs;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(drillNow());
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return drillNow;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

/** Park the clock on the most recent Saturday at 10:00 ET (14:00 UTC — inside
 *  the 9–18 window, so the ONLY reason to hold is the day). */
function parkOnSaturday(): Date {
  clockOffsetMs = 0;
  const d = new RealDate();
  const back = (d.getUTCDay() + 1) % 7; // 0 = already Saturday
  const sat = RealDate.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, 14, 0, 0);
  clockOffsetMs = sat - RealDate.now();
  return new Date();
}
function restoreClock(): void {
  clockOffsetMs = 0;
}

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
// THE ONE HARNESS SHIM, carried forward from journey-alerts.ts with its
// reasoning intact. PGlite's socket server de-syncs after Postgres answers a
// unique violation: the NEXT query on that connection comes back P1017 "Server
// has closed the connection". Section 1b re-announces one event under the same
// dedupeKey ON PURPOSE, so without this the drill would measure the harness —
// and it did on the first run, where notifyInApp swallowed a P1017 and the
// "no second DM" check passed for the wrong reason.
//
// Real Postgres does not close a connection over a duplicate key: the INSERT is
// a single statement outside any transaction and Neon leaves the session
// usable. The shim restores the behaviour of the database the code actually
// runs on; it does not paper over anything the code does.
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
const PORT = 5493;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
process.env.AUTH_ENFORCE = "false";
delete process.env.VERCEL;
process.env.NEXT_PUBLIC_APP_URL = "https://hub.realtourpilot.invalid";
// Pins the ops channel so an ops line is distinguishable from a DM — with no
// channel configured, alertDestination falls back to Kyle's own DM.
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
  const { eventForKind } = await import("@/lib/notifyPrefs");
  type Role = Parameters<typeof prisma.teamMember.create>[0]["data"]["role"];

  await saveSecret("slack", "xoxb-drill-not-a-real-token");

  console.log("=".repeat(78));
  console.log("ACCEPTANCE JOURNEY — Kyle hears about the video");
  console.log(`  real clock: ${new RealDate().toISOString()} (${new RealDate().toString().slice(0, 3)})`);
  console.log("=".repeat(78));

  // -------------------------------------------------------------------------
  // The cast, as production has it. Every roster row and every login exists
  // before the first call: the notify stack caches the owner and office lists
  // for ten minutes, so a row added later would be invisible for the run.
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

  // Jordan is PHOTOGRAPHER on the roster and the OWNER by login — the exact
  // shape defaultPrefsFor's "isOwner wins over the role" rule exists for.
  const jordan = await mkMember({ name: "Jordan Spackman", email: "info@drill.invalid", role: "PHOTOGRAPHER", phone: "(610) 555-0101", slackId: "U-JORDAN" });
  // Kyle: MANAGER on the roster, ADMIN by login, so officeTeamMemberIds finds
  // him. Given a plain US number ON PURPOSE — in production his roster phone
  // is the company OpenPhone line, which the sender refuses outright, and that
  // would let a text switch look off when it is really being refused
  // downstream. With a textable number, the ONLY thing deciding his text leg
  // is his own switch, which is the stricter test.
  const kyle = await mkMember({ name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", phone: "(610) 555-0102", slackId: "U-KYLE" });
  // Harrison: a photographer whose every switch is a text. He is not addressed
  // by topaz_ready at all; he is here to prove the hold actually bites for
  // somebody who CAN be held (section 3b), and that nothing leaks to him.
  const harrison = await mkMember({ name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", phone: "(610) 555-0103", slackId: "U-HARRISON" });

  await prisma.appUser.create({ data: { email: "info@drill.invalid", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id } });
  await prisma.appUser.create({ data: { email: "kyle@drill.invalid", role: "ADMIN", status: "ACTIVE", teamMemberId: kyle.id } });

  // The three saved matrices, copied field for field off production
  // (AppSetting notify-prefs:<id>, read 2026-09-21).
  await putSetting(`notify-prefs:${jordan.id}`, {
    mention: { slack: true, sms: true },
    project_message: { slack: false, sms: false },
    job_ping: { slack: false, sms: false },
    review_ready: { slack: true, sms: true },
    shoot_change: { slack: true, sms: true },
  });
  await putSetting(`notify-prefs:${kyle.id}`, {
    mention: { slack: true, sms: false },
    project_message: { slack: false, sms: false },
    job_ping: { slack: false, sms: false },
    review_ready: { slack: true, sms: false },
    shoot_change: { slack: true, sms: false },
  });
  await putSetting(`notify-prefs:${harrison.id}`, {
    mention: { slack: false, sms: true },
    project_message: { slack: false, sms: true },
    job_ping: { slack: false, sms: true },
    review_ready: { slack: false, sms: true },
    shoot_change: { slack: false, sms: true },
  });

  const client = await prisma.client.create({ data: { name: "Brie Martinez", phone: "(610) 555-0300" }, select: { id: true } });
  const job = await prisma.project.create({
    data: { title: "5 Raymond Cir, Royersford, PA", clientId: client.id, status: "EDITING", addressLine: "5 Raymond Cir" },
    select: { id: true },
  });

  /** The shim above covers the PRODUCT's client. The drill imports its own, and
   *  this whole section is built on unique violations, so the drill's reads
   *  reconnect once rather than reporting a harness artefact as a defect.
   *  (Same pair journey-alerts.ts carries, for the same reason.) */
  const dbRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!isSocketDesync(e)) throw e;
      await prisma.$disconnect().catch(() => {});
      return await fn();
    }
  };

  const dms = (to: string) => slackCalls.filter((c) => c.fn === "dm" && c.to === to);
  const legs = (teamMemberId: string, channel: string, status?: string) =>
    dbRetry(() => prisma.notificationDelivery.count({ where: { teamMemberId, channel, ...(status ? { status } : {}) } }));
  const texts = (teamMemberId: string) =>
    dbRetry(() => prisma.pendingSms.findMany({ where: { teamMemberId }, select: { line: true, deferUntil: true, sentAt: true } }));
  const bellRows = (kind: string) => dbRetry(() => prisma.notification.count({ where: { kind } }));

  // The payload pingKyle builds, reproduced here. Section 5 checks the real
  // emitter still has the pieces this stands in for, so the two cannot drift.
  const street = "5 Raymond Cir";
  const downloadUrl = "https://hub.realtourpilot.invalid/api/topaz/download/tz-drill-1";
  const folderUrl = "https://www.dropbox.com/home/RealTour%20Pilot/Listings/5%20Raymond%20Cir/Final%20Video";
  const aryeoUrl = "https://app.aryeo.com/listings/drill-listing";
  const topazDm = [
    `The 1080p version of ${street} is ready to upload to Aryeo.`,
    `Download it: ${downloadUrl}`,
    `Dropbox folder: ${folderUrl}`,
    `Aryeo listing: ${aryeoUrl}`,
    `Full steps, and Complete when it's delivered: https://hub.realtourpilot.invalid/tasks?task=tsk-drill-1`,
  ].join("\n");
  const announceTopaz = (key: string) =>
    notifyInApp({
      kind: "topaz_ready",
      title: `1080p video ready to upload — ${street}`,
      body: "Video - v1 - 1080p.mp4 is in the job's Final Video folder.",
      href: "/tasks?task=tsk-drill-1",
      targets: [
        { roles: ["ADMIN"], userKey: `tm:${kyle.id}`, href: "/tasks?task=tsk-drill-1", slackDm: topazDm },
        { roles: ["OWNER"], href: "/tasks?task=tsk-drill-1" },
      ],
      dedupeKey: key,
    });

  // The payload announceCutInReview builds for a cut somebody other than the
  // owner handed in (ownerActed false, so the sentence is present).
  const announceCut = (key: string) =>
    notifyInApp({
      kind: "cut_ready",
      title: `Cut ready to review — ${street} · Done_5 Raymond Cir.mp4`,
      body: "Done_5 Raymond Cir.mp4",
      href: `/review/${job.id}?cut=sub-drill-1`,
      targets: [
        {
          roles: ["OWNER", "ADMIN"],
          ownerSms: `Video in review — ${street} (Kim, v1). https://hub.realtourpilot.invalid/review/${job.id}?cut=sub-drill-1`,
        },
      ],
      dedupeKey: key,
    });

  // =========================================================================
  // 0 — THE CLASSIFICATION ITSELF
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("0. WHAT THE TWO KINDS ARE NOW CLASSIFIED AS");
  console.log("-".repeat(78));
  console.log(`     eventForKind("cut_ready")   → ${eventForKind("cut_ready")}`);
  console.log(`     eventForKind("topaz_ready") → ${eventForKind("topaz_ready")}`);
  console.log(`     eventForKind("topaz_problem") → ${eventForKind("topaz_problem")}`);
  check("cut_ready is unchanged: the 'video in review' switch", eventForKind("cut_ready") === "review_ready");
  check("topaz_ready rides the same switch Jordan named it with", eventForKind("topaz_ready") === "review_ready");
  check(
    "topaz_problem stays bell-only — a failure is not a video arriving",
    eventForKind("topaz_problem") === null,
    String(eventForKind("topaz_problem")),
  );

  // =========================================================================
  // 1 — THE GAP, CLOSED: a weekday render lands and Kyle is told on Slack
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("1. A WEEKDAY RENDER COMES BACK FROM TOPAZ");
  console.log("-".repeat(78));
  restoreClock();
  slackCalls.length = 0;
  await announceTopaz("drill-topaz-weekday");
  console.log(`     Kyle DM attempts: ${dms("U-KYLE").length}`);
  if (dms("U-KYLE")[0]) console.log(`     DM text:\n${dms("U-KYLE")[0].text.split("\n").map((l) => `       ${l}`).join("\n")}`);

  check("Kyle gets exactly one Slack DM (it was bell-only until today)", dms("U-KYLE").length === 1, `${dms("U-KYLE").length}`);
  const dm1 = dms("U-KYLE")[0]?.text ?? "";
  check("…carrying the download link", dm1.includes(downloadUrl));
  check("…carrying a Dropbox LINK, not a file path (Jordan, Sep 21)", dm1.includes(folderUrl) && !/\/RealTour Pilot\/Listings/.test(dm1));
  check("…carrying the Aryeo listing", dm1.includes(aryeoUrl));
  check("…and the card that closes the loop", dm1.includes("/tasks?task=tsk-drill-1"));
  check("the Slack leg is logged as sent", (await legs(kyle.id, "slack", "sent")) === 1);
  check("no text was queued — his own switch says Slack only", (await texts(kyle.id)).length === 0);
  check("exactly one bell delivery leg for him, not one per target", (await legs(kyle.id, "bell", "sent")) === 1);

  console.log("\n1a. AND IT IS ONE PING, NOT TWO");
  check("Jordan is not DM'd for it — the owner row carries no sentence", dms("U-JORDAN").length === 0, `${dms("U-JORDAN").length}`);
  check("…and not texted either", (await texts(jordan.id)).length === 0);
  check("…and has no delivery leg at all: bell row only, exactly as yesterday", (await legs(jordan.id, "bell")) === 0);
  check("nothing reached Harrison", dms("U-HARRISON").length === 0 && (await texts(harrison.id)).length === 0);
  check("both bell rows still exist (his row and the owner broadcast)", (await bellRows("topaz_ready")) === 2);
  const opsLines1 = slackCalls.filter((c) => c.fn === "notify").length;
  check("no ops relay — somebody was reached", opsLines1 === 0, `${opsLines1} ops lines`);

  console.log("\n1b. THE SAME RENDER ANNOUNCED AGAIN ADDS NOTHING");
  slackCalls.length = 0;
  await announceTopaz("drill-topaz-weekday");
  check("no second DM for one file", dms("U-KYLE").length === 0, `${dms("U-KYLE").length}`);
  check("still one bell row per target", (await bellRows("topaz_ready")) === 2);

  // =========================================================================
  // 2 — THE HALF THAT ALREADY WORKED, still working
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("2. A CUT GOES IN FOR REVIEW ON A WEEKDAY — the path that already worked");
  console.log("-".repeat(78));
  slackCalls.length = 0;
  await announceCut("drill-cut-weekday");
  check("Kyle still gets his Slack DM", dms("U-KYLE").length === 1, `${dms("U-KYLE").length}`);
  check("Jordan still gets his", dms("U-JORDAN").length === 1, `${dms("U-JORDAN").length}`);
  const jordanTexts = await texts(jordan.id);
  check("…and his text, which is the Sep 11 switch he set by hand", jordanTexts.length === 1, `${jordanTexts.length}`);
  check("the text carries the review link", (jordanTexts[0]?.line ?? "").includes(`/review/${job.id}`));
  check("Kyle is still not texted", (await texts(kyle.id)).length === 0);

  // =========================================================================
  // 3 — THE SATURDAY QUESTION
  // =========================================================================
  const sat = parkOnSaturday();
  console.log("\n" + "-".repeat(78));
  console.log("3. THE CLOCK IS PARKED ON A SATURDAY");
  console.log(`   drill clock: ${sat.toISOString()} (${sat.toString().slice(0, 3)}, ET ${sat.toLocaleString("en-US", { timeZone: "America/New_York" })})`);
  console.log("-".repeat(78));
  const holdTopaz = await holdUntilCovered("topaz_ready", undefined);
  const holdCut = await holdUntilCovered("cut_ready", undefined);
  const holdProblem = await holdUntilCovered("topaz_problem", undefined);
  console.log(`     holdUntilCovered("topaz_ready")   → ${holdTopaz?.toISOString() ?? "null"}`);
  console.log(`     holdUntilCovered("cut_ready")     → ${holdCut?.toISOString() ?? "null"}`);
  console.log(`     holdUntilCovered("topaz_problem") → ${holdProblem?.toISOString() ?? "null"}`);
  check("topaz_ready is ROUTINE, so a Saturday render is dated forward", !!holdTopaz);
  check("…to the same Monday cut_ready is dated to", holdTopaz?.toISOString() === holdCut?.toISOString(), `${holdTopaz?.toISOString()} vs ${holdCut?.toISOString()}`);
  check(
    "…which is a Monday, 9am ET",
    !!holdTopaz && holdTopaz.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" }) === "Mon 9 AM",
    holdTopaz?.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric" }),
  );
  check("a Topaz FAILURE is not routine — it is not on the list at all", holdProblem === null);

  console.log("\n3a. KYLE ON A SATURDAY — the hold is real but it cannot touch him");
  slackCalls.length = 0;
  await announceTopaz("drill-topaz-saturday");
  console.log(`     Kyle DM attempts: ${dms("U-KYLE").length}, texts queued: ${(await texts(kyle.id)).length}`);
  check(
    "he still gets the DM now, because nothing could be held as a text for him",
    dms("U-KYLE").length === 1,
    `${dms("U-KYLE").length}`,
  );
  check("no text, Saturday or not — his switch is Slack only", (await texts(kyle.id)).length === 0);
  const suppressed = await dbRetry(() =>
    prisma.notificationDelivery.count({ where: { teamMemberId: kyle.id, channel: "slack", status: "skipped" } }),
  );
  check("and the DM was NOT suppressed — quieter than today is the goal, silent never is", suppressed === 0, `${suppressed} skipped legs`);

  console.log("\n3b. SOMEBODY WHO *CAN* BE HELD — the classification proved on a text switch");
  // Harrison is not addressed by the real emitter; this is the same kind put
  // in front of a person whose text switch is on, which is what the ROUTINE
  // entry is a standing declaration about. If Jordan ever turns Kyle's text
  // on, this is the behaviour he gets.
  slackCalls.length = 0;
  await notifyInApp({
    kind: "topaz_ready",
    title: `1080p video ready to upload — ${street}`,
    href: "/tasks?task=tsk-drill-1",
    targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${harrison.id}`, href: "/tasks?task=tsk-drill-1", slackDm: topazDm }],
    dedupeKey: "drill-topaz-saturday-harrison",
  });
  const hTexts = await texts(harrison.id);
  console.log(`     Harrison texts queued: ${hTexts.length}, deferUntil ${hTexts[0]?.deferUntil?.toISOString() ?? "null"}`);
  check("the alert is KEPT, as a queued line", hTexts.length === 1, `${hTexts.length}`);
  check("…dated to Monday morning rather than buzzing his phone on a Saturday", hTexts[0]?.deferUntil?.toISOString() === holdTopaz?.toISOString(), hTexts[0]?.deferUntil?.toISOString() ?? "null");
  check("nothing is dropped: a delivery leg records the queued line", (await legs(harrison.id, "sms", "queued")) === 1);

  // =========================================================================
  // 4 — AN EXPLICITLY SAVED PREFERENCE IS NEVER COUNTERMANDED
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("4. JORDAN'S OWN SWITCH ON A SATURDAY — kept and dated, never dropped");
  console.log("-".repeat(78));
  // Jordan's review_ready row is {slack:true, sms:true} — the Sep 11 "make sure
  // I get a text when a video is in review" ask in matrix form. The rule
  // established on Sep 20 is that an automated sweep may DELAY such an alert to
  // a day somebody works; it may never silence it.
  slackCalls.length = 0;
  await announceCut("drill-cut-saturday");
  const jSat = (await texts(jordan.id)).filter((t) => t.deferUntil);
  console.log(`     Jordan: DMs ${dms("U-JORDAN").length}, deferred texts ${jSat.length} → ${jSat[0]?.deferUntil?.toISOString() ?? "-"}`);
  check("his text is queued, not discarded", jSat.length === 1, `${jSat.length}`);
  check("…dated to the Monday", jSat[0]?.deferUntil?.toISOString() === holdCut?.toISOString());
  const jSkipped = await dbRetry(() =>
    prisma.notificationDelivery.findFirst({
      where: { teamMemberId: jordan.id, channel: "slack", status: "skipped" },
      orderBy: { createdAt: "desc" },
      select: { detail: true },
    }),
  );
  check("the DM waits with it, and the log says exactly why", /nobody works today/.test(jSkipped?.detail ?? ""), jSkipped?.detail?.slice(0, 80) ?? "no row");
  check("he still gets a bell row — coverage decides who is woken, never what is seen", (await legs(jordan.id, "bell", "sent")) >= 1);

  restoreClock();

  // =========================================================================
  // 5 — THE DRILL AND THE EMITTER CANNOT DRIFT APART
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("5. THE REAL EMITTER STILL HAS THE PIECES THIS STANDS IN FOR");
  console.log("-".repeat(78));
  const src = readFileSync(path.join(process.cwd(), "src/lib/topazJobs.ts"), "utf8");
  check("pingKyle addresses Kyle with a slackDm sentence", /userKey: `tm:\$\{kyle\.id\}`, href, slackDm/.test(src));
  // `ownerSms:` with the colon — the PROPERTY, not the word. The first cut of
  // this check matched the prose in pingKyle's own comment, which explains why
  // the field is deliberately absent, and failed on a file that was correct.
  check("the owner row still carries NO ownerSms, so his phone stays quiet", !/ownerSms:/.test(src));
  check("the Dropbox folder is a link, not a path", src.includes("dropboxWebUrl(folder)") && !src.includes("`  ${folder}`"));

  // =========================================================================
  // 6 — NOTHING LEFT THE PROCESS
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("6. NOTHING SENT");
  console.log("-".repeat(78));
  const flushed = await flushPendingSms();
  console.log(`     flushPendingSms → ${JSON.stringify(flushed)}`);
  check("no text was ever handed to OpenPhone", !blockedUrls.some((u) => /openphone/i.test(u)), blockedUrls.join(" ") || "no outbound attempts at all");
  check("no outbound call left this process at all", blockedUrls.length === 0, blockedUrls.join(" ") || "none");
  check("and no client was contacted by any route", (await dbRetry(() => prisma.commLog.count())) === 0);

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
