// ---------------------------------------------------------------------------
// DRILL: OCT 6 2026 — THE ERROR TRACKER (Jordan: "I also want to make sure we
// are tracking any errors that arise so we can get the reports of them and fix
// them quickly.")
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct6-error-tracker.ts --logs /private/tmp/oct6-error-tracker
//
// Drives the SHIPPED code — lib/errorTracker.ts on the real schema, the real
// instrumentation hook, the real /api/errors route handler, the real cron step
// wrapper, the real owner bell + Slack DM path (notify.notifyStaffSms and its
// quiet-time hold) and the real held-DM flusher:
//
//   1  ONE BUG, ONE ROW: the same failure on two different job pages (ids and
//      numbers in the message differ) is one row counted twice; a different
//      message, or the same message from another route, is its own row; a
//      Next redirect/notFound or a guard's deliberate refusal is not recorded.
//   2  SCRUBBING: a portal/upload token, an email, a phone number, a bearer
//      token, a JWT and a query string never reach the table (message, stack,
//      path, recent paths, context) — and the signed-in user is stored as id +
//      role only, read from the session cookie's signature.
//   3  REOPEN: a row marked FIXED that happens again is OPEN again, counted,
//      reopenCount 1, and alerts; IGNORED keeps counting and never alerts.
//   4  ALERTS: a NEW error → Jordan's bell row + ONE Slack DM; the same error
//      again → nothing; per-error dedupe of 6 h (a reopen inside it is quiet,
//      after it alerts); the hourly global cap of 10 → one "more errors" line,
//      the rest silent.
//   5  SATURDAY: a new error on Saturday 10:00 ET → the bell at once, the DM
//      HELD and delivered at 19:30 ET by the flusher, once. Kyle-free: the ops
//      relay is not used.
//   6  THE BEACON: /api/errors takes a same-origin report (portal visitor →
//      client-portal, anonymous, path scrubbed), refuses cross-origin (403) and
//      origin-less (403), oversize (413), and rate-limits one IP at 10/min (429)
//      while another IP still gets through.
//   7  CRON + reportError + onRequestError: a throwing cron step is a "cron"
//      row grouped per job/step; reportError returns at once and the row lands;
//      instrumentation.onRequestError records a server action as such.
//   8  DAILY DIGEST: lists open errors with counts, once per ET day.
//   9  TABLE MISSING (schema not pushed): every entry point is a silent no-op —
//      no throw, null results, the page reads "missing".
//
// ISOLATION: PGlite on 127.0.0.1:6871 (this builder's range 6870-6879);
// production is never opened; every non-loopback call is fenced; Slack is a
// counted fake; OpenPhone's two calls are replaced in-process. THE CLOCK IS
// PINNED and only moves forward: Tue Oct 13 2026 09:00 EDT on.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = 6871;

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const edt = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
let offset = edt(10, 13, 9, 0).getTime() - RealDate.now();
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
let last = edt(10, 13, 9, 0).getTime();
const setClock = (d: Date) => {
  if (d.getTime() < last) throw new Error(`drill clock may only move forward (${d.toISOString()})`);
  last = d.getTime();
  offset = d.getTime() - RealDate.now();
};

installNextStubs();

// ---- Slack, faked at fetch and counted --------------------------------------
type SlackPost = { channel: string; text: string; at: number };
const slack: SlackPost[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") {
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "", at: Date.now() });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  if (method === "conversations.open") return json({ ok: false, error: "missing_scope" });
  return json({ ok: false, error: `drill: ${method}` });
});

const S = { jordan: "U0JORDAN01", kyle: "U0KYLE0001" };

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", NEXT_RUNTIME: "nodejs" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const tracker = await import("@/lib/errorTracker");
  const scrub = await import("@/lib/errorScrub");
  const notify = await import("@/lib/notify");
  const { signSession, SESSION_COOKIE } = await import("@/lib/auth/jwt");

  const op = await import("@/lib/integrations/openphone");
  (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: "+16105550100" }];
  const texts: { to: string; body: string }[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
    texts.push({ to: String(to), body });
    return { data: { id: `op-${texts.length}` } };
  };
  await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

  // The cast: Jordan (OWNER login → his roster row, Slack) and Kyle (ADMIN).
  const jordan = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan@drill.invalid", role: "PHOTOGRAPHER", phone: "(610) 555-0111", slackId: S.jordan, active: true }, select: { id: true } });
  const kyle = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", phone: null, slackId: S.kyle, active: true }, select: { id: true } });
  const uJordan = await prisma.appUser.create({ data: { email: "jordan@drill.invalid", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id }, select: { id: true } });
  await prisma.appUser.create({ data: { email: "kyle@drill.invalid", role: "ADMIN", status: "ACTIVE", teamMemberId: kyle.id }, select: { id: true } });

  const dmsTo = (id: string, since = 0) => slack.slice(since).filter((m) => m.channel === id);
  const bells = () => prisma.notification.findMany({ where: { kind: "error_report" }, orderBy: { createdAt: "asc" } });
  const row = (fingerprint: string) => prisma.errorEvent.findUnique({ where: { fingerprint } });
  const boom = (message: string, frame = "loadJob (src/lib/jobs.ts:42:7)") => {
    const e = new Error(message);
    e.stack = `Error: ${message}\n    at ${frame}\n    at async Page (src/app/projects/[id]/page.tsx:10:3)\n    at node_modules/next/dist/server/app-render.js:1:1`;
    return e;
  };

  // =========================================================================
  c.head("1 · ONE BUG, ONE ROW");
  {
    const a = await tracker.recordError({ error: boom("Job cmabc123def456ghi789jkl0 has 3 cuts but expected 4"), source: "server-request", path: "/projects/cmabc123def456ghi789jkl0" });
    const b = await tracker.recordError({ error: boom("Job cmzzz999yyy888xxx777www6 has 7 cuts but expected 9"), source: "server-request", path: "/projects/cmzzz999yyy888xxx777www6" });
    c.ok("the same failure on two job pages is one fingerprint", !!a && !!b && a.fingerprint === b.fingerprint, `${a?.fingerprint} / ${b?.fingerprint}`);
    const r = a ? await row(a.fingerprint) : null;
    c.ok("…one row, counted twice, both pages kept", r?.count === 2 && JSON.parse(r?.recentPaths ?? "[]").length === 2 && a?.isNew === true && b?.isNew === false, `count=${r?.count} paths=${r?.recentPaths}`);
    c.ok("…the route is the id-free shape", r?.route === "/projects/[id]", String(r?.route));
    const other = await tracker.recordError({ error: boom("Cannot read properties of undefined (reading 'title')"), source: "server-request", path: "/projects/cmabc123def456ghi789jkl0" });
    c.ok("a different message is its own row", !!other && other.fingerprint !== a?.fingerprint);
    const elsewhere = await tracker.recordError({ error: boom("Job cmabc123def456ghi789jkl0 has 3 cuts but expected 4"), source: "server-request", path: "/editing" });
    c.ok("the same message on another route is its own row", !!elsewhere && elsewhere.fingerprint !== a?.fingerprint);
    const moved = boom("Job cmabc123def456ghi789jkl0 has 3 cuts but expected 4", "loadJob (src/lib/jobs.ts:97:11)");
    const sameAfterDeploy = await tracker.recordError({ error: moved, source: "server-request", path: "/projects/cmqqq111rrr222sss333ttt4" });
    c.ok("a deploy that moves the line number keeps the fingerprint", sameAfterDeploy?.fingerprint === a?.fingerprint);
    const redirect = await tracker.recordError({ error: Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }), source: "server-request", path: "/tasks" });
    const notFound = await tracker.recordError({ error: Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }), source: "server-request", path: "/x" });
    const refusal = await tracker.recordError({ error: new Error("You don't have access to do that."), source: "server-action", path: "/settings" });
    c.ok("redirect / notFound / a guard's refusal are not recorded", redirect === null && notFound === null && refusal === null);
  }

  // =========================================================================
  c.head("2 · NOTHING PRIVATE IS STORED");
  {
    const token = "pt_8f3KqZ2mN9xV7bL4cR1tY6wE";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJjbWFiYzEyMyIsImVtYWlsIjoiYUBiLmNvIn0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc";
    const message = `Fetch https://hub.realtourpilot.com/portal/${token}?t=abc&email=paula@client.com failed for paula@client.com (215) 555-0199 +63 917 555 0101 Authorization: Bearer sk_live_abcdefghijklmnop1234 token=${jwt}`;
    const e = new Error(message);
    e.stack = `Error: ${message}\n    at sendIt (src/lib/outbox.ts:10:2)\n    at https://hub.realtourpilot.com/upload/${token}?x=1:5:5`;
    const session = await signSession({ uid: uJordan.id, email: "jordan@drill.invalid", role: "OWNER", name: "Jordan" });
    await tracker.captureRequestError(e, { path: `/upload/${token}?code=999`, method: "POST", headers: { cookie: `foo=1; ${SESSION_COOKIE}=${encodeURIComponent(session)}` } }, { routeType: "route", routePath: "/api/portal/upload/route" });
    const rows = await prisma.errorEvent.findMany({ where: { source: "route-handler" } });
    const stored = JSON.stringify(rows);
    const leaks = [token, jwt, "paula@client.com", "555-0199", "917 555 0101", "sk_live_abcdefghijklmnop1234", "t=abc", "code=999", "jordan@drill.invalid", session].filter((s) => stored.includes(s));
    c.ok("token, JWT, email, phones, key, query strings and the session never reach the table", rows.length === 1 && leaks.length === 0, leaks.join(" | ") || `${rows.length} row(s)`);
    c.ok("…the shapes are kept so the message still reads", /\/portal\/\[token\]/.test(rows[0]?.message ?? "") && /\[email\]/.test(rows[0]?.message ?? "") && /\[phone\]/.test(rows[0]?.message ?? "") && rows[0]?.lastPath === "/upload/[token]", `${rows[0]?.message} · ${rows[0]?.lastPath}`);
    c.ok("…the signed-in person is id + role only", rows[0]?.lastUserId === uJordan.id && rows[0]?.lastUserRole === "OWNER");
    c.ok("…route-handler source and the route file as its group", rows[0]?.route === "/api/portal/upload/route");
    c.ok("scrubPath keeps a portal sub-page name but hides a token", scrub.scrubPath("/portal/login?next=/x") === "/portal/login" && scrub.scrubPath(`/portal/${token}/videos`) === "/portal/[token]/videos" && scrub.scrubPath(`/learn/${token}`) === "/learn/[token]");
    const ctx = scrub.scrubContext({ step: "x", email: "a@b.co", authHeader: "Bearer zzz", note: "call 610-555-0111" });
    c.ok("context drops secret/personal keys and scrubs the rest", !!ctx && !ctx.includes("a@b.co") && !ctx.includes("zzz") && !ctx.includes("555-0111") && ctx.includes("[phone]"), String(ctx));
  }

  // =========================================================================
  c.head("4 · ALERTS: NEW → BELL + ONE DM; THE SAME AGAIN → NOTHING");
  let fpAlert = "";
  {
    // Everything so far was new in this hour — move on two hours so the cap
    // starts clean, then raise one fresh error.
    setClock(edt(10, 13, 11, 0));
    const s0 = slack.length;
    const b0 = (await bells()).length;
    const r = await tracker.recordError({ error: boom("Dropbox copy failed: path/not_found"), source: "background", route: "review:approve/dropboxCopy" });
    fpAlert = r?.fingerprint ?? "";
    const dm = dmsTo(S.jordan, s0);
    c.ok("a new error alerts", r?.alert === "sent", String(r?.alert));
    c.ok("…ONE Slack DM to Jordan, with the message and the page link", dm.length === 1 && /New error/.test(dm[0].text) && /Dropbox copy failed/.test(dm[0].text) && /\/settings\/errors\?id=/.test(dm[0].text), dm.map((m) => m.text).join(" | "));
    const bellRows = (await bells()).slice(b0);
    c.ok("…and a bell row addressed to him", bellRows.length === 1 && bellRows[0].userKey === `tm:${jordan.id}` && bellRows[0].href.startsWith("/settings/errors"));
    c.ok("…nothing to Kyle (no ops relay)", dmsTo(S.kyle, s0).length === 0);
    const s1 = slack.length;
    const again = await tracker.recordError({ error: boom("Dropbox copy failed: path/not_found"), source: "background", route: "review:approve/dropboxCopy" });
    c.ok("the same error again: counted, no alert", again?.isNew === false && again.alert === null && slack.length === s1 && (await row(fpAlert))?.count === 2);
  }

  c.head("3 · REOPEN ON RECURRENCE (and the 6-hour per-error dedupe)");
  {
    const id = (await row(fpAlert))!.id;
    c.ok("Mark fixed", await tracker.setErrorStatus(id, "FIXED", "jordan@drill.invalid"));
    setClock(edt(10, 13, 13, 0)); // 2 h after its alert
    const s0 = slack.length;
    const r = await tracker.recordError({ error: boom("Dropbox copy failed: path/not_found"), source: "background", route: "review:approve/dropboxCopy" });
    const after1 = await row(fpAlert);
    c.ok("a FIXED error that happens again is OPEN, counted, reopenCount 1", r?.reopened === true && after1?.status === "OPEN" && after1.reopenCount === 1 && after1.count === 3 && after1.resolvedAt === null, `${after1?.status} ${after1?.reopenCount} ${after1?.count}`);
    c.ok("…inside 6 h of its last alert: deduped, no DM", r?.alert === "deduped" && dmsTo(S.jordan, s0).length === 0, String(r?.alert));
    await tracker.setErrorStatus(id, "FIXED", "jordan@drill.invalid");
    setClock(edt(10, 13, 18, 0)); // 7 h after its alert
    const s1 = slack.length;
    const r2 = await tracker.recordError({ error: boom("Dropbox copy failed: path/not_found"), source: "background", route: "review:approve/dropboxCopy" });
    const dm = dmsTo(S.jordan, s1);
    c.ok("…after 6 h a reopen alerts, saying it came back", r2?.reopened === true && r2.alert === "sent" && dm.length === 1 && /back/.test(dm[0].text), dm.map((m) => m.text).join(" | "));
    await tracker.setErrorStatus(id, "IGNORED", "jordan@drill.invalid");
    setClock(edt(10, 14, 2, 0));
    const s2 = slack.length;
    const r3 = await tracker.recordError({ error: boom("Dropbox copy failed: path/not_found"), source: "background", route: "review:approve/dropboxCopy" });
    const ign = await row(fpAlert);
    c.ok("IGNORED keeps counting and never alerts or reopens", r3?.reopened === false && r3.alert === null && ign?.status === "IGNORED" && ign.count === 5 && slack.length === s2);
  }

  c.head("4b · THE HOURLY GLOBAL CAP");
  {
    setClock(edt(10, 14, 9, 0));
    const s0 = slack.length;
    const outcomes: string[] = [];
    for (let i = 0; i < 13; i++) {
      const r = await tracker.recordError({ error: boom(`Distinct failure kind ${String.fromCharCode(65 + i)}`, `fn${String.fromCharCode(65 + i)} (src/lib/f.ts:1:1)`), source: "server-action", path: "/tasks" });
      outcomes.push(String(r?.alert));
    }
    const dm = dmsTo(S.jordan, s0);
    const individual = dm.filter((m) => /New error/.test(m.text));
    const overflow = dm.filter((m) => /More than 10 new errors/.test(m.text));
    c.ok("10 individual alerts, then capped", outcomes.filter((o) => o === "sent").length === 10 && outcomes.slice(10).every((o) => o === "capped"), outcomes.join(","));
    c.ok("…Jordan got 10 error DMs and ONE summary line", individual.length === 10 && overflow.length === 1, `${individual.length} + ${overflow.length}`);
  }

  // =========================================================================
  c.head("5 · SATURDAY: THE BELL NOW, THE DM AT 7:30 PM");
  {
    setClock(edt(10, 17, 10, 0)); // Saturday
    const s0 = slack.length;
    const b0 = (await bells()).length;
    const r = await tracker.recordError({ error: boom("Saturday-only failure in the upload portal"), source: "client-portal", path: "/portal/abcdefghijklmnop" });
    c.ok("recorded as new; the alert is queued, not dropped", r?.isNew === true && r.alert === "sent", String(r?.alert));
    c.ok("…the bell row is written at once", (await bells()).length === b0 + 1);
    c.ok("…no DM to Jordan on Saturday morning", dmsTo(S.jordan, s0).length === 0);
    const held = await prisma.appSetting.findMany({ where: { key: { startsWith: "held-dm:" } } });
    const mine = held.map((h) => JSON.parse(h.value) as { teamMemberId: string; text: string; until: string; settledAt?: string }).filter((h) => h.teamMemberId === jordan.id && !h.settledAt);
    c.ok("…it is a held DM dated 19:30 ET", mine.length === 1 && new Date(mine[0].until).getTime() === edt(10, 17, 19, 30).getTime() && /Saturday-only failure/.test(mine[0].text), mine.map((m) => m.until).join(","));
    c.ok("…and Kyle is not paged instead", dmsTo(S.kyle, s0).length === 0);
    setClock(edt(10, 17, 19, 25));
    await notify.releaseHeldStaffDms();
    c.ok("19:25: still held", dmsTo(S.jordan, s0).length === 0);
    setClock(edt(10, 17, 19, 31));
    await notify.releaseHeldStaffDms();
    await notify.releaseHeldStaffDms();
    const dm = dmsTo(S.jordan, s0);
    c.ok("19:31: delivered, once", dm.length === 1 && /Saturday-only failure/.test(dm[0].text), `${dm.length}`);
  }

  // =========================================================================
  c.head("6 · THE BROWSER BEACON (/api/errors)");
  {
    tracker.resetErrorTrackerState();
    const { POST } = await import("@/app/api/errors/route");
    const post = (body: unknown, h: Record<string, string> = {}) =>
      POST(new Request("http://hub.test/api/errors", {
        method: "POST",
        headers: { host: "hub.test", origin: "http://hub.test", "x-forwarded-for": "198.51.100.7", "content-type": "text/plain", ...h },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }));
    const token = "Zx9Kq2mN8vB7cL5tR4yW3pQ1";
    const res = await post({ name: "TypeError", message: "x.map is not a function", stack: "TypeError: x.map is not a function\n    at Videos (https://hub.test/_next/static/chunks/abc123def456.js:1:200)", path: `/portal/${token}/videos`, boundary: "page" });
    const portalRows = await prisma.errorEvent.findMany({ where: { source: "client-portal", message: { contains: "x.map" } } });
    c.ok("a same-origin portal report is accepted (204) as client-portal", res.status === 204 && portalRows.length === 1, `${res.status} ${portalRows.length}`);
    c.ok("…anonymous, path scrubbed", portalRows[0]?.lastUserId === null && portalRows[0]?.lastPath === "/portal/[token]/videos" && !JSON.stringify(portalRows).includes(token));
    c.ok("cross-origin → 403", (await post({ message: "x" }, { origin: "https://evil.example" })).status === 403);
    const noOrigin = await POST(new Request("http://hub.test/api/errors", { method: "POST", headers: { host: "hub.test", "x-forwarded-for": "198.51.100.8" }, body: JSON.stringify({ message: "y" }) }));
    c.ok("no Origin and no Sec-Fetch-Site → 403", noOrigin.status === 403);
    c.ok("oversize → 413", (await post("x".repeat(20_000), { "x-forwarded-for": "198.51.100.9" })).status === 413);
    tracker.resetErrorTrackerState();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post({ message: `beacon flood ${i}`, path: "/tasks" }, { "x-forwarded-for": "203.0.113.50" })).status);
    c.ok("one IP: 10 accepted a minute, then 429", codes.slice(0, 10).every((s) => s === 204) && codes.slice(10).every((s) => s === 429), codes.join(","));
    c.ok("…another IP still gets through", (await post({ message: "other visitor" }, { "x-forwarded-for": "203.0.113.51" })).status === 204);
    c.ok("a body that is not an error description is ignored, not stored", (await post("[1,2,3]", { "x-forwarded-for": "203.0.113.52" })).status === 204 && (await prisma.errorEvent.count({ where: { message: "1,2,3" } })) === 0);
  }

  // =========================================================================
  c.head("7 · CRON STEPS, reportError, onRequestError");
  {
    const { cronBudget } = await import("@/lib/cron");
    const run = cronBudget(60_000, Date.now(), "drilljob");
    await run.step("boom", async () => { throw new Error("Aryeo 503 Service Unavailable on order 48213"); });
    await run.step("boom", async () => { throw new Error("Aryeo 503 Service Unavailable on order 99120"); });
    const cronRows = await prisma.errorEvent.findMany({ where: { source: "cron" } });
    c.ok("a throwing cron step is one 'cron' row per job/step, counted", cronRows.length === 1 && cronRows[0].route === "cron:drilljob/boom" && cronRows[0].count === 2 && cronRows[0].lastPath === "/api/cron/drilljob", JSON.stringify(cronRows.map((r) => [r.route, r.count])));
    c.ok("…and the cron's own record is unchanged", run.out.boomError === "Aryeo 503 Service Unavailable on order 99120");

    const t0 = RealDate.now();
    tracker.reportError(new Error("OpenPhone 500 while sending"), { area: "outbox:send/sms", ambiguous: true });
    const returnedIn = RealDate.now() - t0;
    await tracker.flushErrorReports();
    const bg = await prisma.errorEvent.findFirst({ where: { route: "outbox:send/sms" } });
    c.ok("reportError returns at once and the row lands", returnedIn < 50 && bg?.source === "background" && bg.context?.includes("\"ambiguous\":true") === true, `${returnedIn}ms ${bg?.context}`);
    let threw = false;
    try { tracker.reportError(undefined, { area: "weird" }); tracker.reportError(Object.create(null), { area: "weirder" }); await tracker.flushErrorReports(); } catch { threw = true; }
    c.ok("reportError never throws on odd values", !threw);

    const { onRequestError } = await import("../../src/instrumentation");
    await onRequestError(Object.assign(new Error("Unique constraint failed on the fields: (`dedupeKey`)"), { digest: "2817461" }), { path: "/review?cut=1", method: "POST", headers: {} }, { routerKind: "App Router", routePath: "/review/page", routeType: "action", renderSource: "react-server-components", revalidateReason: undefined, renderType: "dynamic" } as never);
    const act = await prisma.errorEvent.findFirst({ where: { source: "server-action" , route: "/review/page" } });
    c.ok("instrumentation.onRequestError records a server action with its digest", act?.digest === "2817461" && act.lastPath === "/review", `${act?.digest} ${act?.lastPath}`);
  }

  // =========================================================================
  c.head("8 · THE DAILY DIGEST");
  {
    setClock(edt(10, 18, 4, 0));
    const s0 = slack.length;
    const d1 = await tracker.errorDigest();
    const dm = dmsTo(S.jordan, s0);
    c.ok("lists open errors with counts, to Jordan", d1.sent && d1.open > 0 && dm.length === 1 && /Daily error report/.test(dm[0].text) && /\d+× /.test(dm[0].text), dm.map((m) => m.text.slice(0, 200)).join(" | "));
    const d2 = await tracker.errorDigest();
    c.ok("…once per ET day", d2.sent === false && dmsTo(S.jordan, s0).length === 1);
    const list = await tracker.listErrors("OPEN", "frequent");
    c.ok("the owner page's list reads, most frequent first", !list.missing && list.rows.length > 0 && list.rows.every((r, i, a) => i === 0 || a[i - 1].count >= r.count) && list.counts.IGNORED === 1);
    const report = tracker.claudeReport(list.rows[0]);
    c.ok("'Copy for Claude' carries message, route, counts and stack", report.includes(list.rows[0].message) && report.includes("Seen:") && report.includes("Stack:"));
  }

  // =========================================================================
  c.head("9 · THE TABLE IS NOT THERE YET (schema not pushed)");
  {
    await drill.sql('DROP TABLE "ErrorEvent"');
    tracker.resetErrorTrackerState();
    const s0 = slack.length;
    let threw = false;
    let r: unknown = "unset";
    let list: Awaited<ReturnType<typeof tracker.listErrors>> | null = null;
    let digest: Awaited<ReturnType<typeof tracker.errorDigest>> | null = null;
    try {
      r = await tracker.recordError({ error: new Error("after the drop"), source: "server-request", path: "/" });
      tracker.reportError(new Error("after the drop, background"), { area: "x" });
      await tracker.flushErrorReports();
      await tracker.captureRequestError(new Error("after the drop, request"), { path: "/", method: "GET", headers: {} }, { routeType: "render" });
      list = await tracker.listErrors("OPEN");
      digest = await tracker.errorDigest();
      const { cronBudget } = await import("@/lib/cron");
      const run = cronBudget(60_000, Date.now());
      await run.step("x", async () => { throw new Error("cron after the drop"); });
    } catch {
      threw = true;
    }
    c.ok("nothing throws", !threw);
    c.ok("recording is a silent no-op (null)", r === null);
    c.ok("the page reads 'missing', the digest says so, no alert went out", list?.missing === true && digest?.sent === false && slack.length === s0, `${digest?.reason}`);
  }

  c.ok("nothing left the machine but the fakes", fence.blocked.length === 0, fence.blocked.join(", "));
  quiet.restore();
  c.summary();
  await drill.stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
