// ---------------------------------------------------------------------------
// DRILL: IS EACH MAILBOX ACTUALLY BEING READ? (§9 "hello@ vs info@", unified
// handoff batch 5, Sep 26 2026)
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/gmail-mailbox-health.ts
//
// A fake Google (token endpoint + Gmail API) answers inside the fence; every
// other URL is refused. Isolated PGlite; the clock is pinned. OLD behaviour
// first: src/lib/integrations/google.ts at 17df024 (pinned — never HEAD).
//
//   1. OLD: hello@'s token refused → skipped with no record; the scan says
//      nothing about it and no task exists.
//   2. NEW, three scans with hello@ refused: ONE open owner task for hello@,
//      one owner bell, info@ still read and logged, the scan says degraded
//      with the reason; the real comms cron route stores that on its run.
//   3. A good SEND from info@ does not close hello@'s READ task.
//   4. hello@ recovers: its task closes itself and the last-read stamp lands.
//   5. A LIST failure on hello@ is hello@'s alone — info@ is still read (the
//      old code threw out of the whole scan).
//   6. A map holding only info@: "hello@ not connected", once.
//   7. The footnote (§9 related comms): silent while both read; names hello@
//      when its last read is over an hour old; the client panel's action
//      returns the same sentence.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5784);
const BASE = "17df024"; // pinned: the tree batch 5 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");
const INFO = "info@realtourpilot.com";
const HELLO = "hello@realtourpilot.com";

// ---- the clock: Tue Oct 6 2026, 11:07 AM EDT (minute ≥ 5 → the hourly
// OpenPhone backstop in the comms cron stands down, as it does at :07) --------
const RealDate = Date;
let offset = RealDate.UTC(2026, 9, 6, 15, 7) - RealDate.now();
const setNow = (ms: number) => { offset = ms - RealDate.now(); };
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

// ---- the fake Google -------------------------------------------------------------
// Refresh tokens are built at run time and are obviously not real.
const RT = { info: ["rt", "info", "drill"].join("-"), hello: ["rt", "hello", "drill"].join("-") };
const google = { helloToken: "refuse" as "ok" | "refuse", helloList: "ok" as "ok" | "500" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const MESSAGES: Record<string, { from: string; subject: string; body: string; thread: string }> = {
  mi1: { from: "Erica Walker <erica@clients.invalid>", subject: "Vertical cut for 812 Linden Ave?", body: "Can you send the vertical cut for 812 Linden Ave by Friday?", thread: "ti1" },
  mh1: { from: "Sam Porter <sam@newleads.invalid>", subject: "Pricing for a listing shoot", body: "Hi, what would photos and a reel cost for a 3 bed in Malvern?", thread: "th1" },
};
const fence = fenceFetch((url, init) => {
  if (url === "https://oauth2.googleapis.com/token") {
    const rt = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
    if (rt === RT.info) return json(200, { access_token: "tok-info", expires_in: 3600 });
    if (rt === RT.hello) return google.helloToken === "ok" ? json(200, { access_token: "tok-hello", expires_in: 3600 }) : json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    return json(400, { error: "invalid_grant" });
  }
  const m = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me(\/[^?]*)(\?.*)?$/.exec(url);
  if (m) {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const box = auth.endsWith("tok-info") ? "info" : auth.endsWith("tok-hello") ? "hello" : null;
    if (!box) return json(401, { error: "no token" });
    const p = m[1];
    if (p === "/messages") {
      if (box === "hello" && google.helloList === "500") return json(500, { error: "backend error" });
      return json(200, { messages: [{ id: box === "info" ? "mi1" : "mh1" }] });
    }
    const msg = /^\/messages\/([^/]+)$/.exec(p);
    if (msg && MESSAGES[msg[1]]) {
      const x = MESSAGES[msg[1]];
      return json(200, {
        id: msg[1], threadId: x.thread, snippet: x.body, internalDate: String(RealDate.UTC(2026, 9, 6, 14)),
        payload: { mimeType: "text/plain", headers: [{ name: "From", value: x.from }, { name: "Subject", value: x.subject }], body: { data: b64(x.body) } },
      });
    }
    if (/^\/threads\//.test(p)) return json(200, { messages: [{ id: "only", payload: { headers: [{ name: "From", value: "someone@clients.invalid" }] } }] });
    return json(404, { error: "no such fake" });
  }
  return null;
});
installNextStubs();

// ---- the old code, runnable ----------------------------------------------------
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-health-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
async function loadBase<T>(rel: string): Promise<T> {
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  const dir = path.join(REPO, path.dirname(rel));
  fs.writeFileSync(
    file,
    show(rel)
      .replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`)
      .replace(/(["'])\.\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(dir, p)}${q}`),
  );
  return (await import(file)) as T;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { GOOGLE_CLIENT_ID: "drill-client", GOOGLE_CLIENT_SECRET: "drill-client-secret" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const google2 = await import("@/lib/integrations/google");
  const health = await import("@/lib/gmailHealth");
  const oldGoogle = await loadBase<{ syncGmail: () => Promise<Record<string, unknown>> }>("src/lib/integrations/google.ts");
  const { loadMailboxGap } = await import("@/components/clients/mailboxHealth.actions");
  const c = makeChecker();

  // The roster Kyle's lead tasks land on, one known client, both mailboxes.
  await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", active: true, payPercent: 0.35, payFloor: 100 } });
  await prisma.client.create({ data: { name: "Erica Walker", email: "erica@clients.invalid" } });
  await saveSecret("gmail", JSON.stringify({ [INFO]: RT.info, [HELLO]: RT.hello }));
  const readTask = (mb: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `gmail-read-${mb}` } });
  const logged = (id: string) => prisma.commLog.count({ where: { externalId: { endsWith: `:${id}` } } });

  // =========================================================================
  c.head("1 · OLD (17df024): a refused mailbox leaves no trace");
  // =========================================================================
  const old = await oldGoogle.syncGmail();
  c.ok("OLD: the scan returns only {scanned, tasks} — nothing says hello@ was skipped", !("mailboxes" in old) && !("degraded" in old) && old.scanned === 1, JSON.stringify(old));
  c.ok("OLD: no task exists for hello@", !(await readTask(HELLO)));
  await prisma.webhookEvent.deleteMany({});
  await prisma.commLog.deleteMany({});
  await prisma.smartTask.deleteMany({});

  // =========================================================================
  c.head("2 · NEW: three scans with hello@ refused");
  // =========================================================================
  const runs = [];
  for (let i = 0; i < 3; i++) { setNow(RealDate.UTC(2026, 9, 6, 15, 7 + i * 5)); runs.push(await google2.syncGmail()); }
  const last = runs[2];
  const hello = last.mailboxes.find((m) => m.email === HELLO);
  const info = last.mailboxes.find((m) => m.email === INFO);
  c.ok("the scan reports degraded", runs.every((r) => r.degraded), runs.map((r) => r.degraded).join(","));
  c.ok("…naming hello@ and why", !!hello && !hello.ok && /token refresh failed/.test(hello.error ?? ""), JSON.stringify(hello));
  c.ok("info@ is still read", !!info && info.ok && info.scanned === 1, JSON.stringify(info));
  c.ok("…and its client email is logged", (await logged("mi1")) === 1);
  const t = await readTask(HELLO);
  c.ok("ONE open owner task for hello@ after three scans", !!t && t.status === "OPEN" && t.taskType === "connection_fix" && t.assignedKey === "jordan", `${t?.status} ${t?.taskType} ${t?.assignedKey}`);
  c.ok("…which says leads are not arriving", /leads/i.test(t?.summary ?? ""), t?.summary ?? "");
  c.ok("…and only one such task exists", (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: "gmail-read-" } } })) === 1);
  const bells = await prisma.notification.findMany({ where: { kind: "system", dedupeKey: { startsWith: `gmail-read-${HELLO}` } } });
  c.ok("ONE owner bell for it", bells.length === 1 && bells[0].audience === JSON.stringify(["OWNER"]), `${bells.length}`);
  c.ok("no task for info@", !(await readTask(INFO)));
  const mh = await health.mailboxReadHealth();
  const mhHello = mh.find((m) => m.email === HELLO);
  c.ok("Connections reads hello@ as connected but NOT reading, with the reason", !!mhHello && mhHello.connected && !mhHello.reading && /token refresh failed/.test(mhHello.problem ?? ""), JSON.stringify(mhHello));
  c.ok("…and info@ as reading", mh.find((m) => m.email === INFO)?.reading === true);

  // The real comms cron route stores the flag /connections reads.
  const route = await import("@/app/api/cron/gmail/route");
  const { NextRequest } = await import("next/server");
  setNow(RealDate.UTC(2026, 9, 6, 15, 27));
  await route.GET(new NextRequest("https://drill.invalid/api/cron/gmail", { headers: { authorization: "Bearer drill-secret" } }));
  const run = await prisma.cronRun.findFirst({ where: { job: "gmail" }, orderBy: { startedAt: "desc" } });
  c.ok("the comms cron run stores the gmail step's degraded flag and hello@ (what /connections turns amber)", /\\?"degraded\\?":true/.test(run?.summary ?? "") && /hello@realtourpilot\.com/.test(run?.summary ?? ""), (run?.summary ?? "").slice(0, 200));

  // =========================================================================
  c.head("3 · A good send from info@ does not close hello@'s READ task");
  // =========================================================================
  await health.reportGmailSendWorking(INFO);
  c.ok("hello@'s read task is still open", (await readTask(HELLO))?.status === "OPEN");

  // =========================================================================
  c.head("4 · hello@ recovers");
  // =========================================================================
  google.helloToken = "ok";
  setNow(RealDate.UTC(2026, 9, 6, 15, 37));
  const ok = await google2.syncGmail();
  c.ok("the scan is no longer degraded", !ok.degraded && ok.mailboxes.every((m) => m.ok), JSON.stringify(ok.mailboxes));
  c.ok("hello@'s task closed itself", (await readTask(HELLO))?.status === "COMPLETED");
  c.ok("hello@'s mail is read (the unknown sender became a lead)", (await logged("mh1")) === 1 && (await prisma.smartTask.count({ where: { taskType: "lead" } })) === 1);
  const stamp = await prisma.appSetting.findUnique({ where: { key: health.gmailReadOkKey(HELLO) } });
  c.ok("the last-read stamp for hello@ landed", !!stamp && Math.abs(Date.parse(JSON.parse(stamp.value).at) - RealDate.UTC(2026, 9, 6, 15, 37)) < 10_000, stamp?.value);
  c.ok("both read → no footnote", health.mailboxGapSentence(await health.mailboxReadHealth()) === null);

  // =========================================================================
  c.head("5 · A LIST failure on hello@ is hello@'s alone");
  // =========================================================================
  google.helloList = "500";
  await prisma.webhookEvent.deleteMany({});
  setNow(RealDate.UTC(2026, 9, 6, 15, 42));
  const listFail = await google2.syncGmail().then((r) => r, (e: unknown) => ({ threw: String(e) }));
  const lf = "mailboxes" in listFail ? listFail.mailboxes : [];
  c.ok("the scan did not throw — info@ was still read", "mailboxes" in listFail && lf.find((m) => m.email === INFO)?.ok === true, JSON.stringify(listFail).slice(0, 200));
  c.ok("hello@ is recorded as an inbox read failure", /inbox read failed/.test(lf.find((m) => m.email === HELLO)?.error ?? ""), JSON.stringify(lf));
  c.ok("…and its task is open again (reopened, not a second row)", (await readTask(HELLO))?.status === "OPEN" && (await prisma.smartTask.count({ where: { dedupeKey: `gmail-read-${HELLO}` } })) === 1);
  google.helloList = "ok";

  // =========================================================================
  c.head("6 · A map holding only info@");
  // =========================================================================
  await prisma.smartTask.deleteMany({ where: { dedupeKey: { startsWith: "gmail-read-" } } });
  await saveSecret("gmail", JSON.stringify({ [INFO]: RT.info }));
  for (let i = 0; i < 3; i++) { setNow(RealDate.UTC(2026, 9, 6, 16, 7 + i * 5)); await google2.syncGmail(); }
  const nc = await readTask(HELLO);
  c.ok("hello@ not connected → its task, once", !!nc && nc.status === "OPEN" && /not connected/.test(nc.reasonCreated ?? "") && (await prisma.smartTask.count({ where: { dedupeKey: `gmail-read-${HELLO}` } })) === 1, nc?.reasonCreated ?? "none");
  const ncHealth = (await health.mailboxReadHealth()).find((m) => m.email === HELLO);
  c.ok("Connections reads hello@ as NOT connected", !!ncHealth && !ncHealth.connected && !ncHealth.reading, JSON.stringify(ncHealth));

  // =========================================================================
  c.head("7 · The footnote on related-message views");
  // =========================================================================
  await saveSecret("gmail", JSON.stringify({ [INFO]: RT.info, [HELLO]: RT.hello }));
  setNow(RealDate.UTC(2026, 9, 6, 16, 30));
  await google2.syncGmail(); // both read again; hello@'s task closes
  c.ok("both reading → the panel's action returns no footnote", (await loadMailboxGap()) === null);
  // hello@'s last good read, two hours ago (an hour is the line).
  await prisma.appSetting.update({ where: { key: health.gmailReadOkKey(HELLO) }, data: { value: JSON.stringify({ at: new RealDate(RealDate.UTC(2026, 9, 6, 14, 30)).toISOString() }) } });
  const gap = await loadMailboxGap();
  c.ok("a hello@ read over an hour old → the footnote names hello@ and the time", !!gap && /hello@realtourpilot\.com has not been read since Oct 6, 10:30 AM ET/.test(gap), gap ?? "null");
  c.ok("…and does not name info@", !!gap && !/info@/.test(gap));

  c.ok("nothing left this process but the fake Google", fence.blocked.every((u) => /slack\.com|openphone/.test(u)), fence.blocked.join(" ") || "no refusals");
  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
