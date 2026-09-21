/**
 * ACCEPTANCE DRILL — THE OFFICE DOES NOT FALL SILENT WITH THE OWNER (Sep 21 2026)
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a && \
 *     NODE_OPTIONS=--conditions=react-server \
 *     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/owner-upload-silence.ts
 *
 * THE DEFECT. Jordan asked for two things on Sep 21: Kyle gets the Ready-to-send
 * card, and Kyle gets Slacked when a video is ready for review. Half of the
 * second one did not happen. announceCutInReview honoured an older and entirely
 * correct rule — do not text a man about his own upload (reviewer, Sep 11) — by
 * dropping the `ownerSms` sentence when the owner filed the cut himself. But
 * that sentence is the very field notifyInApp guards the broadcast leg on
 * (`&& t.ownerSms`), so no sentence meant bridgeBroadcast was never called AT
 * ALL and the whole office went quiet with him: Kyle got a bell row and nothing
 * else. Measured on production the same morning: 3 of the last 41
 * ReviewSubmission rows in 60 days carry no editor key and the name "Jordan
 * Spackman", which smsPrefs.ownerActedBy resolves true. One cut in fourteen
 * reaching nobody.
 *
 * THE CLOSE. The sentence always goes now; the carve-out moved to where it can
 * name a person — bridgeBroadcast drops the OWNER roster rows for a row the
 * owner caused, and reaches everybody else exactly as before.
 *
 * WHAT THIS ASSERTS ON: what the code DECIDED, driving the REAL emitter
 * (reviewCuts.announceCutInReview) rather than a hand-copied payload. Slack is
 * held at `fetch` and every other outbound URL is refused outright, so an
 * OpenPhone send would be a recorded refusal rather than a text. Production is
 * never touched — DATABASE_URL is repointed at the drill's own PGlite before a
 * single app module loads. Scaffolding, the fetch seam and the PGlite desync
 * shim are journey-topaz-alert.ts's, carried across with their reasoning.
 *
 * THE CLOCK IS PARKED ON A WEEKDAY, on purpose: cut_ready is a ROUTINE kind, so
 * a run that happened to fall on a Saturday would be answering the coverage
 * question instead of this one. The weekend behaviour is journey-topaz-alert's
 * subject and is deliberately left there.
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
// resolved. notify.ts reaches every transport by dynamic `await import()`, so
// the honest seam is `fetch`, not a stub module.
// ---------------------------------------------------------------------------
type SlackCall = { fn: "dm" | "notify"; to: string; text: string };
const slackCalls: SlackCall[] = [];
/** Every non-Slack URL the code tried to open. Recorded AND refused — an
 *  OpenPhone send landing here would be a text that wanted to go out. */
const blockedUrls: string[] = [];

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
      slackCalls.push({ fn: body.channel === OPS_CHANNEL ? "notify" : "dm", to: body.channel ?? "?", text: body.text ?? "" });
      return jsonRes({ ok: true });
    }
    return jsonRes({ ok: false, error: `drill: unstubbed slack method ${method}` });
  }
  blockedUrls.push(url);
  throw new Error(`drill: outbound network is disabled — ${url}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// THE CLOCK. A Proxy over the real Date, so instances stay real Dates
// (instanceof, Prisma serialisation and PGlite all keep working) and only
// "what time is it now" moves.
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

/** Park the clock on the most recent Tuesday at 10:00 ET (14:00 UTC) — a day
 *  the office rota covers, inside the texting window, so nothing here is
 *  answering the weekend question by accident. */
function parkOnWeekday(): Date {
  clockOffsetMs = 0;
  const d = new RealDate();
  const back = (d.getUTCDay() + 5) % 7; // 0 = already Tuesday
  const tue = RealDate.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, 14, 0, 0);
  clockOffsetMs = tue - RealDate.now();
  return new Date();
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
// PGlite's socket server de-syncs after Postgres answers a unique violation:
// the NEXT query on that connection comes back P1017. Real Postgres does not
// close a connection over a duplicate key, and this drill re-announces one
// event under the same dedupeKey on purpose, so the shim restores the
// behaviour of the database the code actually runs on.
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
const PORT = 5494;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
process.env.AUTH_ENFORCE = "false";
delete process.env.VERCEL;
process.env.NEXT_PUBLIC_APP_URL = "https://hub.realtourpilot.invalid";
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
  const { flushPendingSms, notifyInApp } = await import("@/lib/notify");
  const { announceCutInReview } = await import("@/lib/reviewCuts");
  const { ownerActedBy } = await import("@/lib/smsPrefs");
  const { NOTIFY_EVENTS, notifyKindLabel } = await import("@/lib/notifyPrefDefaults");
  type Role = Parameters<typeof prisma.teamMember.create>[0]["data"]["role"];

  await saveSecret("slack", "xoxb-drill-not-a-real-token");
  parkOnWeekday();

  console.log("=".repeat(78));
  console.log("ACCEPTANCE DRILL — the office does not fall silent with the owner");
  console.log(`  drill clock: ${new Date().toISOString()} (${new Date().toString().slice(0, 3)})`);
  console.log("=".repeat(78));

  // -------------------------------------------------------------------------
  // The cast, as production has it. Every roster row and every login exists
  // before the first call: the notify stack caches the owner and office lists
  // for ten minutes, so a row added later would be invisible for the run.
  // -------------------------------------------------------------------------
  const mkMember = (o: { name: string; email: string; role: Role; phone?: string | null; slackId?: string | null }) =>
    prisma.teamMember.create({
      data: { name: o.name, email: o.email, role: o.role, phone: o.phone ?? null, slackId: o.slackId ?? null, active: true, payPercent: 0.35, payFloor: 100 },
      select: { id: true, name: true },
    });

  // Jordan is PHOTOGRAPHER on the roster and the OWNER by login — the shape
  // defaultPrefsFor's "isOwner wins over the role" rule exists for.
  const jordan = await mkMember({ name: "Jordan Spackman", email: "info@drill.invalid", role: "PHOTOGRAPHER", phone: "(610) 555-0101", slackId: "U-JORDAN" });
  // Kyle: MANAGER on the roster, ADMIN by login, so officeTeamMemberIds finds
  // him. Given a plain US number ON PURPOSE — in production his roster phone is
  // the company OpenPhone line, which the sender refuses outright, and that
  // would let a text switch look off when it is really being refused
  // downstream.
  const kyle = await mkMember({ name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", phone: "(610) 555-0102", slackId: "U-KYLE" });
  // Harrison shot the job. He is here for the leg that must NOT be collateral:
  // the photographer's own row (Sep 18) is person-addressed and has nothing to
  // do with who pressed upload.
  const harrison = await mkMember({ name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", phone: "(610) 555-0103", slackId: "U-HARRISON" });

  await prisma.appUser.create({ data: { email: "info@drill.invalid", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id } });
  await prisma.appUser.create({ data: { email: "kyle@drill.invalid", role: "ADMIN", status: "ACTIVE", teamMemberId: kyle.id } });

  // The saved matrices, copied field for field off production (AppSetting
  // notify-prefs:<id>, read 2026-09-21). Jordan's review_ready is {slack, sms}
  // and EXPLICIT, which is what makes the carve-out a real test: his own saved
  // preference says reach me on both, and the one thing that must still
  // override it is "you filed this yourself".
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
  // Harrison's shipped default: the Room's bell reaches him, his phone does not
  // (notifyPrefDefaults — consent, not load). Written explicitly here so the
  // drill states what it expects rather than inheriting it.
  await putSetting(`notify-prefs:${harrison.id}`, {
    mention: { slack: false, sms: true },
    project_message: { slack: false, sms: false },
    job_ping: { slack: false, sms: false },
    review_ready: { slack: true, sms: false },
    shoot_change: { slack: false, sms: true },
  });

  const client = await prisma.client.create({ data: { name: "Kim Buckwalter", phone: "(610) 555-0300" }, select: { id: true } });
  const job = await prisma.project.create({
    data: { title: "1033 Preserve Ln, Royersford, PA", clientId: client.id, status: "REVIEW", addressLine: "1033 Preserve Ln", photographerId: harrison.id },
    select: { id: true },
  });

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
    dbRetry(() => prisma.pendingSms.findMany({ where: { teamMemberId }, select: { line: true, deferUntil: true } }));
  const bellRows = () => dbRetry(() => prisma.notification.count({ where: { kind: "cut_ready" } }));

  const announce = (submissionId: string, ownerActed: boolean) =>
    announceCutInReview({
      kind: "cut_ready",
      projectId: job.id,
      submissionId,
      round: 2,
      street: "1033 Preserve Ln",
      fileName: "Finish_1033 Preserve Ln.mp4",
      editorName: ownerActed ? "Jordan Spackman" : "Kim Miguel",
      editorKey: ownerActed ? null : "kim",
      ownerActed,
    });

  // =========================================================================
  // 0 — THE FACT THE CARVE-OUT IS KEYED ON
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("0. WHO THE HUB THINKS ACTED");
  console.log("-".repeat(78));
  check("a cut row named 'Jordan Spackman' with no editor key IS the owner acting", await ownerActedBy("Jordan Spackman"));
  check("…and one named 'Kim Miguel' is not", !(await ownerActedBy("Kim Miguel")));

  // =========================================================================
  // 1 — AN EDITOR HANDS A CUT IN (the path that already worked)
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("1. KIM HANDS IN VERSION 2 — nothing here may change");
  console.log("-".repeat(78));
  slackCalls.length = 0;
  await announce("sub-editor-1", false);
  console.log(`     Kyle DMs: ${dms("U-KYLE").length} · Jordan DMs: ${dms("U-JORDAN").length} · Harrison DMs: ${dms("U-HARRISON").length}`);
  if (dms("U-KYLE")[0]) console.log(`     Kyle's line: ${dms("U-KYLE")[0].text}`);
  check("Kyle is Slacked", dms("U-KYLE").length === 1, `${dms("U-KYLE").length}`);
  check("…and the owner is too, on his own saved switch", dms("U-JORDAN").length === 1, `${dms("U-JORDAN").length}`);
  check("…and his text is queued, as it has been since Sep 11", (await texts(jordan.id)).length === 1);
  check("the shooter hears about his own job", dms("U-HARRISON").length === 1, `${dms("U-HARRISON").length}`);
  check("…and is not texted — his default is the bell and Slack", (await texts(harrison.id)).length === 0);
  check("Kyle's Slack leg is logged as sent", (await legs(kyle.id, "slack", "sent")) === 1);

  // =========================================================================
  // 1b — THE DEFECT ITSELF, REPRODUCED
  //
  // The exact payload the emitter built for an owner upload until this morning:
  // the OWNER+ADMIN row with the sentence taken off. Nothing here is a claim
  // about old code — it is the old SHAPE, run through today's bridge, showing
  // that the missing sentence is what silenced the office rather than anything
  // about Jordan's or Kyle's preferences.
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("1b. THE OLD PAYLOAD (no ownerSms) — what Kyle was getting");
  console.log("-".repeat(78));
  slackCalls.length = 0;
  const kyleSlackPre = await legs(kyle.id, "slack", "sent");
  await notifyInApp({
    kind: "cut_ready",
    title: "Version 2 ready to review — 1033 Preserve Ln",
    href: `/review/${job.id}?cut=sub-oldshape`,
    targets: [{ roles: ["OWNER", "ADMIN"] }],
    dedupeKey: "drill-old-shape",
  });
  check("nobody is Slacked at all — the bridge is never called", dms("U-KYLE").length === 0 && dms("U-JORDAN").length === 0);
  check("…and Kyle has no new Slack leg: bell row and nothing else", (await legs(kyle.id, "slack", "sent")) === kyleSlackPre);

  // =========================================================================
  // 2 — THE DEFECT: JORDAN UPLOADS THE CUT HIMSELF
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("2. JORDAN UPLOADS A CUT HIMSELF — the office must still hear it");
  console.log("-".repeat(78));
  slackCalls.length = 0;
  const kyleSlackBefore = await legs(kyle.id, "slack", "sent");
  const jordanTextsBefore = (await texts(jordan.id)).length;
  await announce("sub-owner-1", true);
  console.log(`     Kyle DMs: ${dms("U-KYLE").length} · Jordan DMs: ${dms("U-JORDAN").length} · Harrison DMs: ${dms("U-HARRISON").length}`);
  if (dms("U-KYLE")[0]) console.log(`     Kyle's line: ${dms("U-KYLE")[0].text}`);
  check("KYLE IS SLACKED — this is the line that never went", dms("U-KYLE").length === 1, `${dms("U-KYLE").length}`);
  check("…and it is logged as sent", (await legs(kyle.id, "slack", "sent")) === kyleSlackBefore + 1);
  check("…and it carries the Review Room link to the cut", (dms("U-KYLE")[0]?.text ?? "").includes(`/review/${job.id}?cut=sub-owner-1`));
  check("the shooter still hears about his own job", dms("U-HARRISON").length === 1, `${dms("U-HARRISON").length}`);

  console.log("\n2a. AND THE SEP 11 CARVE-OUT SURVIVES INTACT");
  check(
    "Jordan is NOT texted about his own upload",
    (await texts(jordan.id)).length === jordanTextsBefore,
    `${(await texts(jordan.id)).length} line(s) queued for him in this run, all of them Kim's cut from section 1`,
  );
  check("…and not DM'd either — a DM about a cut he just filed is as wrong as a buzz", dms("U-JORDAN").length === 0, `${dms("U-JORDAN").length}`);
  check(
    "…and the skip is written down, so a quiet phone reads as this rule and not as a broken bridge",
    (await dbRetry(() =>
      prisma.notificationDelivery.count({ where: { teamMemberId: jordan.id, status: "skipped", detail: { contains: "filed this cut himself" } } }),
    )) === 2,
  );
  check("he still gets the bell row, which is how he knows it landed", (await legs(jordan.id, "bell", "sent")) >= 1);

  console.log("\n2b. THE SAME CUT ANNOUNCED AGAIN ADDS NOTHING");
  slackCalls.length = 0;
  const bellsBefore = await bellRows();
  await announce("sub-owner-1", true);
  check("no second DM for one cut", dms("U-KYLE").length === 0, `${dms("U-KYLE").length}`);
  check("no second bell row", (await bellRows()) === bellsBefore, `${await bellRows()} vs ${bellsBefore}`);

  // =========================================================================
  // 3 — THE TWO LABELS
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("3. WHAT SETTINGS NOW SAYS");
  console.log("-".repeat(78));
  const reviewReady = NOTIFY_EVENTS.find((e) => e.key === "review_ready");
  console.log(`     review_ready label → ${reviewReady?.label}`);
  console.log(`     notifyKindLabel("topaz_ready") → ${notifyKindLabel("topaz_ready")}`);
  check("the switch names the Topaz half it also governs now", /Topaz/i.test(reviewReady?.label ?? ""), reviewReady?.label ?? "(missing)");
  check("…and still names the review half", /review/i.test(reviewReady?.label ?? ""));
  check("'Last reached' says it in house words, not '(topaz ready)'", notifyKindLabel("topaz_ready") !== "topaz ready", notifyKindLabel("topaz_ready"));

  // =========================================================================
  // 4 — THE DRILL AND THE EMITTER CANNOT DRIFT APART
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("4. THE SENTENCE IS NO LONGER WHAT CARRIES THE CARVE-OUT");
  console.log("-".repeat(78));
  const cuts = readFileSync(path.join(process.cwd(), "src/lib/reviewCuts.ts"), "utf8");
  const notify = readFileSync(path.join(process.cwd(), "src/lib/notify.ts"), "utf8");
  check("announceCutInReview no longer withholds ownerSms", !/ownerActed[\s\S]{0,40}\?\s*\{\}/.test(cuts));
  check("…it flags the row instead", /ownerActed: true/.test(cuts));
  check("the bridge is where the owner's legs are dropped", /ctx\.ownerActed && owners\.has\(id\)/.test(notify));

  // =========================================================================
  // 5 — NOTHING SENT
  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("5. NOTHING LEFT THE PROCESS");
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
