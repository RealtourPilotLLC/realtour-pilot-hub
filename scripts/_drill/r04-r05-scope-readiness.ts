// ---------------------------------------------------------------------------
// DRILL: R03 reporting + R04 layout + R05 queue dependencies (builder B),
// Sep 28 2026.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/r04-r05-scope-readiness.ts
//
// The three-client fixture: T (a TEST client on a verified inbox), P (a real
// client in the approved pilot), X (a real client left out), plus N (the real
// row on the never-synthetic list renamed "… TEST") and Q (one person seated
// on P and on X). OLD behaviour first wherever it can be observed: the HEAD
// (1075a5b) portalLayout, readiness (+ its copy) and contentGeneration are
// loaded for real, their `@/` imports aimed at this tree.
//
//   0. OLD: the layout was the switch or a TEST NAME (N got v2, P could not be
//      piloted, the switch gave X v2); readiness said "every client" for the
//      lock-less switches and called strategy_generation effective and healthy
//      with the processor off; a queued "drive-sweep" job ran ATTENDED with
//      ai_runs off (the model was called) and never auto-accepted a fact.
//   1. R04 layout, per REAL client-role session (a cookie from the sign-in
//      link route, consumeLoginToken) and per token link: T v2 TEST_CLIENT, P
//      v2 PILOT, X v1; navigation (PortalPage) and one portal action agree;
//      Q's session opens P and never X; X's token page offers no email
//      sign-in; P removed → v1 and old ?pv= links still land; ALL → X v2
//      SWITCH_ON; staff ?layout=v2 → STAFF_PREVIEW.
//   2. Readiness = audience preview = dispatch, for EVERY op: the readiness
//      scope line, programAudience, programReach, the outbox dispatch gate and
//      the preview rows name the same clients; the office-replied lane's dry
//      run "send" rows are exactly what fake Gmail received in the live run;
//      "every client" only in ALL; the openers name the pilot; the lock says
//      so; TEST_ONLY names nobody real; the hub-write rows read the program
//      pilot.
//   3. Settings actions: owner only; refuses a TEST name, N ("fix the name"),
//      no ACTIVE program, a wrong typed name, a 4th client, a past end date;
//      AppSetting + AuditLog in one transaction (a forced audit failure leaves
//      neither); ALL needs EVERY CLIENT; the save message names what is on.
//   4. R05: every queued run is unattended (drive-sweep, onboarding-cron, a
//      staff email all pause with ai_runs off; the model is not called), and
//      a queued ANALYZE auto-accepts an eligible fact.
//   5. The driver: a STRATEGY_DRAFT waits while strategy_generation is off
//      (attempts untouched, marked once) while INGEST/ANALYZE behind it run;
//      the backlog cutoff (pinned, audited, "include" runs them); the rollout
//      hold (a real client outside the pilot waits; ALL runs it).
//   6. Readiness R05: the blocker names transcript_jobs and the count, healthy
//      "blocked"; a partial dependency is never healthy; "queue not draining";
//      the read-only "Queued now" line.
//   7. transcriptQueueBatch counts by kind, requester, client and tier,
//      runnable, oldest, ticks — and writes nothing.
//   8. ProgramRolloutPanel rendered with react-dom/server (child process):
//      editable for the owner, read-only for an admin.
//
// ISOLATION: PGlite on 127.0.0.1:6220 (DRILL_PORT overrides; this builder's
// range is 6220-6239) through the shared harness; production is never opened.
// Every non-loopback call is fenced; Google's token and Gmail send are faked
// in-process and recorded; the model is stubbed at aiJsonWithUsage. Nothing
// is sent anywhere.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { bootDrillDb, pinDrillEnv, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6220);
const BASE = "1075a5b"; // pinned: the tree the Sep 28 review read
const REPO = path.resolve(__dirname, "../..");
const MODE = process.env.R0405_MODE === "render" ? "render" : "parent";
const N_ID = "cmqikskt1008u9k9qej9ltjy5"; // a NEVER_SYNTHETIC real row
const DAY = 86_400_000;
const HOUR = 3_600_000;

// =============================================================================
// THE CHILD: render ProgramRolloutPanel for the owner and an admin, write HTML.
// =============================================================================
async function renderChild() {
  pinDrillEnv(PORT); // before ANY app import: nothing here may reach a real database
  installNextStubs();
  const fence = fenceFetch();
  const out = process.env.R0405_OUT!;
  const data = JSON.parse(fs.readFileSync(path.join(out, "panel-data.json"), "utf8"));
  const React = await import("react");
  const { renderToString } = (await import("react-dom/server")) as unknown as { renderToString: (n: unknown) => string };
  const { ProgramRolloutPanel } = await import("@/components/settings/ProgramRolloutPanel");
  const errors: string[] = [];
  for (const [who, isOwner] of [["owner", true], ["admin", false]] as const) {
    try {
      fs.writeFileSync(path.join(out, `${who}.html`), renderToString(React.createElement(ProgramRolloutPanel, { isOwner, initial: data })));
    } catch (e) { errors.push(`${who}: ${(e as Error).stack ?? e}`); }
  }
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ errors, blocked: fence.blocked }));
  process.exit(0);
}

if (MODE === "render") {
  renderChild().catch((e) => { console.error(e); process.exit(1); });
} else {
  // ---- modules that cannot load under the react-server build of React --------
  // (ui01's seam: PortalPage is CALLED and its element tree read.)
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => { if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); } return icons.get(k); };
  function Link(p: unknown) { return p; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
    return realLoad.call(this, request, parent, isMain);
  };
  parentMain().catch((e) => { console.error(e); process.exit(1); });
}

// =============================================================================
// THE PARENT.
// =============================================================================
async function parentMain() {
  installNextStubs();

  // ---- the model: stubbed at aiJsonWithUsage, every call counted -------------
  const modelCalls: { system: string }[] = [];
  const seam = (match: (r: string) => boolean, overrides: () => Record<string, unknown>) =>
    interceptModule(match, (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => { const o = overrides(); return typeof k === "string" && k in o ? o[k] : t[k]; } }));
  const excerpt = (text: string) => ({ speaker: "client", speakerName: null, time: null, text });
  let analysisOut: Record<string, unknown> = {};
  seam((r) => r === "@/lib/integrations/ai" || /[\\/]integrations[\\/]ai(\.ts)?$/.test(r), () => ({
    aiJsonWithUsage: async (opts: { system: string }) => {
      modelCalls.push({ system: opts.system });
      return { result: JSON.parse(JSON.stringify(analysisOut)), usage: { inputTokens: 900, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "drill-stub" };
    },
  }));

  // ---- a forced failure INSIDE the rollout writer's transaction ---------------
  let failAuditInTx = false;
  interceptModule((r) => r === "@/lib/prisma", (mod) => {
    const m = mod as { prisma: Record<string, unknown> };
    const real = m.prisma;
    const wrapTx = (tx: object) => new Proxy(tx, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (k === "auditLog" && failAuditInTx && v && typeof v === "object") {
          return new Proxy(v as object, { get: (d, kk) => (kk === "create" ? async () => { throw new Error("drill: forced audit failure"); } : Reflect.get(d, kk, d)) });
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const proxy = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (k === "$transaction" && typeof v === "function") {
          return (arg: unknown, ...rest: unknown[]) => (typeof arg === "function"
            ? (v as (...a: unknown[]) => unknown).call(t, (tx: object) => (arg as (x: object) => unknown)(wrapTx(tx)), ...rest)
            : (v as (...a: unknown[]) => unknown).call(t, arg, ...rest));
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { ...m, prisma: proxy };
  });

  // ---- Google, faked: the token and Gmail's send, recorded ---------------------
  const gmailSent: { to: string; subject: string }[] = [];
  const fence = fenceFetch(async (url, init) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "drill-google-token", expires_in: 3600 });
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const raw = (JSON.parse(String(init?.body ?? "{}")) as { raw?: string }).raw ?? "";
      const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const head = mime.split("\r\n\r\n")[0];
      const hdr = (n: string) => new RegExp(`^${n}: (.*)$`, "m").exec(head)?.[1] ?? "";
      gmailSent.push({ to: hdr("To"), subject: hdr("Subject") });
      return json({ id: `gm-${gmailSent.length}` });
    }
    return null;
  });

  // ---- the old code, runnable ---------------------------------------------------
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "r0405-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const point = (src: string, own: Record<string, string> = {}) =>
    src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${own[p] ?? path.join(REPO, "src", p)}${q}`);
  const baseFile = (name: string, src: string) => { const f = path.join(baseDir, name); fs.writeFileSync(f, src); return f; };
  const oldCopyFile = baseFile("programAutomationCopy.base.ts", point(show("src/lib/programAutomationCopy.ts")));
  const oldReadinessFile = baseFile("readiness.base.ts", point(show("src/lib/readiness.ts"), { "lib/programAutomationCopy": oldCopyFile.replace(/\.ts$/, "") }));
  const oldLayoutFile = baseFile("portalLayout.base.ts", point(show("src/lib/portalLayout.ts")));
  const oldGenFile = baseFile("contentGeneration.base.ts", point(show("src/lib/contentGeneration.ts")));

  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const core = await import("@/lib/programRolloutCore");
  const rollout = await import("@/lib/programRollout");
  const { programDispatchGate } = await import("@/lib/programRolloutGate");
  const { layoutForClient, portalLayoutDecision } = await import("@/lib/portalLayout");
  const portal = await import("@/lib/portal");
  const pa = await import("@/lib/portalAccess");
  const { readinessReport } = await import("@/lib/readiness");
  const { previewProgramAudience } = await import("@/lib/programAudiencePreview");
  const tj = await import("@/lib/transcriptJobs");
  const gen = await import("@/lib/contentGeneration");
  const { AUTOMATION_EFFECTS, EVERY_CLIENT_CONFIRM } = await import("@/lib/programAutomationCopy");
  const ra = await import("@/app/settings/rolloutActions");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { maskToRef } = await import("@/lib/outbox");
  type Rollout = import("@/lib/programRolloutCore").ProgramRollout;
  type Op = import("@/lib/programRolloutCore").ProgramReachOp;
  const OldLayout = (await import(oldLayoutFile)) as { portalLayoutDecision: typeof portalLayoutDecision };
  const OldReadiness = (await import(oldReadinessFile)) as { readinessReport: (o?: { now?: Date }) => Promise<{ rows: { key: string; scope: string | null; realClients: boolean; effective: { ok: boolean; blockers: string[] }; healthy: { ok: boolean | null; detail: string } }[] }> };
  const OldGen = (await import(oldGenFile)) as { runTranscriptJob: typeof gen.runTranscriptJob };
  const { PortalPage } = await import("@/components/portal/PortalPage");

  // ---- element-tree helpers (ui01's) -------------------------------------------
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type El = { $$typeof: symbol; type: any; key: string | null; props: Record<string, any> };
  const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
  const typeName = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
  const walk = (n: any, visit: (e: El) => void) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
    if (!isEl(n)) return;
    visit(n);
    for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v, visit);
  };
  const find = (tree: any, name: string) => { const out: El[] = []; walk(tree, (e) => { if (typeName(e.type) === name) out.push(e); }); return out; };
  const flat = (n: any, seen = new WeakSet<object>()): string => {
    if (n === null || n === undefined || typeof n === "boolean") return "";
    if (typeof n !== "object") return typeof n === "function" ? "" : String(n);
    if (seen.has(n)) return "";
    seen.add(n);
    if (Array.isArray(n)) return n.map((x) => flat(x, seen)).join(" ");
    return Object.entries(n).map(([k, v]) => (typeof v === "boolean" ? `${k}=${v}` : flat(v, seen))).join(" ");
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ---- fixtures --------------------------------------------------------------------
  const realNow = new Date();
  const setSwitch = (key: string, enabled: boolean, configJson?: string | null, enabledAt?: Date) =>
    prisma.programAutomation.upsert({
      where: { key },
      create: { key, enabled, enabledBy: "drill", enabledAt: enabledAt ?? new Date(), ...(configJson !== undefined ? { configJson } : {}) },
      update: { enabled, ...(enabled ? { enabledAt: enabledAt ?? new Date() } : {}), ...(configJson !== undefined ? { configJson } : {}) },
    });
  const writeRollout = (r: Rollout) =>
    prisma.appSetting.upsert({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY }, create: { key: core.PROGRAM_ROLLOUT_SETTING_KEY, value: core.serializeProgramRollout(r), updatedBy: "drill" }, update: { value: core.serializeProgramRollout(r) } });
  type Who = { clientId: string; enrollmentId: string; name: string; token: string; clientUserId: string | null; membershipId: string | null; seat: string | null };
  async function realClient(name: string, o: { id?: string; email?: string | null; seat?: string | null; status?: "ACTIVE" | "PAUSED" } = {}): Promise<Who> {
    const cl = await prisma.client.create({ data: { ...(o.id ? { id: o.id } : {}), name, socialClient: true, email: o.email ?? null }, select: { id: true } });
    const token = randomBytes(24).toString("base64url");
    const e = await prisma.contentEnrollment.create({ data: { clientId: cl.id, status: o.status ?? "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, startedAt: new Date("2026-09-01T04:00:00Z"), portalToken: token, portalTokenIssuedAt: new Date() }, select: { id: true } });
    let clientUserId: string | null = null, membershipId: string | null = null;
    if (o.seat) {
      const u = await prisma.clientUser.upsert({ where: { email: o.seat }, create: { email: o.seat, name, status: "ACTIVE" }, update: {}, select: { id: true } });
      const m = await prisma.clientMembership.create({ data: { clientUserId: u.id, enrollmentId: e.id, clientId: cl.id, role: "OWNER", acceptedAt: new Date() }, select: { id: true } });
      clientUserId = u.id; membershipId = m.id;
    }
    return { clientId: cl.id, enrollmentId: e.id, name, token, clientUserId, membershipId, seat: o.seat ?? null };
  }
  const monthKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(realNow).slice(0, 7);
  const Tf = await buildContentMonth(prisma as never, { name: "Rollout TEST", monthKey, project: false, owner: { email: "info+rt@realtourpilot.com", name: "Rollout TEST" } });
  const T: Who = { clientId: Tf.clientId, enrollmentId: Tf.enrollmentId, name: Tf.clientName, token: Tf.portalToken!, clientUserId: Tf.clientUserId, membershipId: Tf.membershipId, seat: "info+rt@realtourpilot.com" };
  const P = await realClient("Pat Pilot Realty", { seat: "pat@example.test", email: "pat.office@example.test" });
  const X = await realClient("Xena Excluded Homes", { seat: "xo@example.test", email: "xena@example.test" });
  const N = await realClient("Jordan Spackman TEST", { id: N_ID, seat: "jspack.n@example.test" });
  const Y = await realClient("Yara Paused Group", { status: "PAUSED", seat: "yara@example.test" });
  const R1 = await realClient("Rhea One Realty", { seat: "rhea@example.test" });
  const R2 = await realClient("Rio Two Homes", { seat: "rio@example.test" });
  // Q: one person, OWNER on P and on X (an assistant working for two agents).
  const qUser = await prisma.clientUser.create({ data: { email: "q.assistant@example.test", name: "Quinn Assistant", status: "ACTIVE" }, select: { id: true } });
  const qOnP = await prisma.clientMembership.create({ data: { clientUserId: qUser.id, enrollmentId: P.enrollmentId, clientId: P.clientId, role: "OWNER", acceptedAt: new Date() }, select: { id: true } });
  await prisma.clientMembership.create({ data: { clientUserId: qUser.id, enrollmentId: X.enrollmentId, clientId: X.clientId, role: "OWNER", acceptedAt: new Date() } });
  const owner = await prisma.appUser.create({ data: { email: "jordan@drill.test", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
  const admin = await prisma.appUser.create({ data: { email: "kyle@drill.test", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" } });
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": ["drill", "refresh", "not", "real"].join("-") }));
  await saveSecret("ai", ["drill", "model", "key", "not", "real"].join("-"));

  const ALL_OPS = core.opsForGroups(core.PROGRAM_PILOT_GROUPS.map((g) => g.key));
  const JOINED = new Date(realNow.getTime() - 3 * DAY).toISOString();
  const PILOT_P: Rollout = {
    mode: "PILOT", modeSince: new Date(realNow.getTime() - 10 * DAY).toISOString(),
    pilot: { clientIds: [P.clientId], operations: ALL_OPS, approvedBy: "jordan@drill.test", approvedAt: new Date(realNow.getTime() - 10 * DAY).toISOString(), expiresAt: new Date(realNow.getTime() + 30 * DAY).toISOString(), note: "drill pilot", joinedAt: { [P.clientId]: JOINED } },
  };
  await writeRollout(PILOT_P);

  // Through the CJS loader, like ui03: an import() here would reach the real
  // next/headers, not the drill's stub the app code reads.
  const cookieJar = async () => (createRequire(__filename)("next/headers") as { cookies: () => Promise<{ set: (n: string, v: string) => void; delete: (n: string) => void }> }).cookies();
  const sessionFor = async (membershipId: string): Promise<string | null> => {
    const link = await pa.mintLoginLink(membershipId, null);
    const raw = new URL(link.url).pathname.split("/").pop()!;
    const { POST } = await import("@/app/portal/auth/[token]/route"); // Oct 5: the press (POST) signs in; opening the link does not
    const { NextRequest } = await import("next/server");
    // Oct 5 2026 (CSRF fix): the press proves it came from our own page, as a
    // browser's does (Sec-Fetch-Site: same-origin); a bare POST is refused.
    const res = await POST(new NextRequest(link.url, { method: "POST", headers: { "sec-fetch-site": "same-origin" } }), { params: Promise.resolve({ token: raw }) });
    return res.cookies.get("rtp_client")?.value ?? null;
  };
  const cookieSrc = (v: string) => ({ get: (n: string) => (n === "rtp_client" ? v : undefined) });

  try {
    // =========================================================================
    c.head("0 · OLD (HEAD 1075a5b): the layout by name, readiness by lock, queued runs attended");
    // =========================================================================
    {
      const viewerOf = async (w: Who) => { const r = await portal.resolvePortalViewer({ token: w.token }); if (!r.ok) throw new Error(`${w.name} link did not resolve`); return r.viewer; };
      const vP = await viewerOf(P), vX = await viewerOf(X), vN = await viewerOf(N);
      c.ok("OLD: with the switch off a real pilot client could not get the new layout (only a TEST name could)", (await OldLayout.portalLayoutDecision(vP, P.name, {})).layout === "v1");
      c.ok("OLD: the real row renamed \"… TEST\" got v2 (name only)", (await OldLayout.portalLayoutDecision(vN, N.name, {})).why === "TEST_CLIENT");
      await setSwitch("portal_layout_v2", true);
      c.ok("OLD: with the switch on, the EXCLUDED client got v2 too (every client)", (await OldLayout.portalLayoutDecision(vX, X.name, {})).layout === "v2");
      await setSwitch("portal_layout_v2", false);

      await setSwitch("revision_policy", true);
      await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));
      await setSwitch("strategy_generation", true);
      await setSwitch("ai_runs", true);
      await prisma.programAutomation.update({ where: { key: "strategy_generation" }, data: { lastRunAt: new Date() } });
      const old = await OldReadiness.readinessReport({});
      const o = (k: string) => old.rows.find((r) => r.key === k)!;
      c.ok("OLD: revision_policy's scope was \"every client it concerns, once on\" (real clients: yes)", o("revision_policy").scope === "every client it concerns, once on" && o("revision_policy").realClients);
      c.ok("OLD: the reminders lock lifted meant \"every client\"", /^every client/.test(o("reminders").scope ?? "") && o("reminders").realClients, o("reminders").scope ?? "");
      c.ok("OLD: strategy_generation read EFFECTIVE with transcript_jobs off", o("strategy_generation").effective.ok === true, o("strategy_generation").effective.blockers.join("; "));
      for (const k of ["revision_policy", "reminders", "strategy_generation", "ai_runs"]) await setSwitch(k, false, null);
    }

    // =========================================================================
    c.head("1 · R04 — the layout, per real client-role session and per link");
    // =========================================================================
    await setSwitch("portal_login_email", true);
    await setSwitch("portal_layout_v2", true);
    {
      // Real sessions, through the sign-in link route (consumeLoginToken).
      const pCookie = await sessionFor(P.membershipId!);
      c.ok("P (pilot) can be signed in: the link route set a client cookie", !!pCookie);
      let xMint = "minted";
      try { await pa.mintLoginLink(X.membershipId!, null); } catch (e) { xMint = (e as Error).message; }
      c.ok("X (excluded) is refused a sign-in link — no program session exists for X", /not in the program rollout/.test(xMint), xMint);
      const pS = await portal.resolvePortalViewer({ cookies: cookieSrc(pCookie!), enrollmentId: P.enrollmentId });
      c.ok("P's cookie resolves to a CLIENT viewer on P", pS.ok && pS.viewer.actor.kind === "CLIENT" && pS.viewer.enrollment.clientId === P.clientId);
      if (!pS.ok) throw new Error("P session did not resolve");
      const lP = await portalLayoutDecision(pS.viewer, P.name, {});
      c.ok("P's session → v2, reason PILOT", lP.layout === "v2" && lP.why === "PILOT", JSON.stringify(lP));
      const lPc = await layoutForClient({ id: P.clientId, name: P.name });
      c.ok("…the same answer layoutForClient gives (keyed on the client, not the actor)", lPc.layout === lP.layout && lPc.why === lP.why);
      const vT = await portal.resolvePortalViewer({ token: T.token });
      c.ok("T → v2 TEST_CLIENT", vT.ok && (await portalLayoutDecision(vT.viewer, T.name, {})).why === "TEST_CLIENT");
      const vX = await portal.resolvePortalViewer({ token: X.token });
      if (!vX.ok) throw new Error("X link did not resolve");
      const lX = await portalLayoutDecision(vX.viewer, X.name, {});
      c.ok("X's link → v1 DEFAULT (the switch is on, the rollout does not reach X)", lX.layout === "v1" && lX.why === "DEFAULT", JSON.stringify(lX));
      const xAsClient = { ...vX.viewer, actor: { kind: "CLIENT" as const, clientUserId: X.clientUserId!, email: X.seat!, name: X.name, membershipId: X.membershipId!, membershipRole: "OWNER" as const }, via: "LOGIN" as const };
      c.ok("X seen by a client-role actor → still v1 (the actor never decides)", (await portalLayoutDecision(xAsClient, X.name, { layout: "v2" })).layout === "v1");
      const vN = await portal.resolvePortalViewer({ token: N.token });
      c.ok("N (a real row renamed TEST, not named) → v1 (OLD: v2)", vN.ok && (await portalLayoutDecision(vN.viewer, N.name, {})).layout === "v1");
      const staffX = { ...vX.viewer, actor: { kind: "STAFF" as const, staffUserId: admin.id, staffName: "Kyle Drill", staffRole: "ADMIN" }, via: "STAFF" as const };
      c.ok("staff ?layout=v2 on X → STAFF_PREVIEW", (await portalLayoutDecision(staffX, X.name, { layout: "v2" })).why === "STAFF_PREVIEW");

      // Navigation: the page the same decision builds.
      const pageP = await PortalPage({ viewer: pS.viewer, path: "/portal/me", baseQuery: `e=${P.enrollmentId}`, query: { tab: "home" } });
      const navP = isEl(pageP) ? ((pageP.props.nav?.primary ?? []) as { href: string }[]).map((i) => i.href) : [];
      c.ok("P's signed-in page is PortalShell (v2) with five links, none needing layout=v2", isEl(pageP) && typeName(pageP.type) === "PortalShell" && navP.length === 5 && navP.every((h) => h.includes(`e=${P.enrollmentId}`) && !h.includes("layout")), navP.join(" "));
      const pageX = await PortalPage({ viewer: vX.viewer, path: "/portal/[token]", query: { tab: "home" } });
      c.ok("X's link page is the v1 frame (HomeTab, no PortalShell)", isEl(pageX) && find(pageX, "PortalShell").length === 0 && find(pageX, "HomeTab").length === 1);
      // Email sign-in is offered on a link page only where it can be sent.
      const vPt = await portal.resolvePortalViewer({ token: P.token });
      const pageXText = flat(pageX);
      const pagePt = vPt.ok ? flat(await PortalPage({ viewer: vPt.viewer, path: "/portal/[token]", query: { tab: "home" } })) : "";
      c.ok("X's token page does NOT offer email sign-in (OLD: offered whenever the global switch was on)", /offerSignIn=false/.test(pageXText) && !/offerSignIn=true/.test(pageXText));
      c.ok("…while P's does (P is in the rollout, has a seat)", /offerSignIn=true/.test(pagePt));
      c.ok("portalLoginEmailEnabledFor: P yes, X no, T yes", (await pa.portalLoginEmailEnabledFor(P.clientId)) && !(await pa.portalLoginEmailEnabledFor(X.clientId)) && (await pa.portalLoginEmailEnabledFor(T.clientId)));

      // One portal API call, as a real signed-in person: the upload route,
      // which authorises from the request's own cookie. No file is sent, so an
      // authorised caller gets 400 "Pick a file first." and nothing is written;
      // a refused one gets 401 before the form is read further.
      const { POST: upload } = await import("@/app/api/portal/upload/route");
      const { NextRequest } = await import("next/server");
      const probe = async (cookie: string, enrollmentId: string) => {
        const fd = new FormData();
        fd.set("enrollmentId", enrollmentId);
        const res = await upload(new NextRequest("https://drill.invalid/api/portal/upload", { method: "POST", body: fd, headers: { cookie: `rtp_client=${cookie}` } }));
        return { status: res.status, message: ((await res.json()) as { message: string }).message };
      };
      const apiP = await probe(pCookie!, P.enrollmentId);
      c.ok("the upload API with P's session → authorised (400 \"Pick a file first.\", nothing written)", apiP.status === 400 && /Pick a file first/.test(apiP.message), JSON.stringify(apiP));
      // Q: seats on P and X. One session; X is closed on every path.
      const qCookie = await sessionFor(qOnP.id);
      const qSeats = await portal.liveMemberships(qUser.id);
      c.ok("Q's live seats are P only", qSeats.length === 1 && qSeats[0].clientId === P.clientId, qSeats.map((s) => s.clientName).join(","));
      const qX = await portal.resolvePortalViewer({ cookies: cookieSrc(qCookie!), enrollmentId: X.enrollmentId });
      c.ok("Q's session asking for X → no_membership", !qX.ok && qX.reason === "no_membership");
      const apiQX = await probe(qCookie!, X.enrollmentId);
      const apiQP = await probe(qCookie!, P.enrollmentId);
      c.ok("the same API with Q's session: X refused (401), P authorised (400)", apiQX.status === 401 && apiQP.status === 400, `${JSON.stringify(apiQX)} | ${JSON.stringify(apiQP)}`);
      void cookieJar;

      // Removal reverts.
      const rm = await ra.removeProgramPilotClientAction({ clientId: P.clientId });
      c.ok("P taken out of the pilot (the owner's action)", rm.ok && /out of the pilot/.test(rm.message), rm.message);
      c.ok("P → v1 on the next decision", (await layoutForClient({ id: P.clientId, name: P.name })).layout === "v1");
      const pAfter = await portal.resolvePortalViewer({ cookies: cookieSrc(pCookie!), enrollmentId: P.enrollmentId });
      c.ok("P's session → no_membership (back to the shared link)", !pAfter.ok && pAfter.reason === "no_membership");
      const vP2 = await portal.resolvePortalViewer({ token: P.token });
      const deep = vP2.ok ? await PortalPage({ viewer: vP2.viewer, path: "/portal/[token]", query: { tab: "plan", pv: "scripts" } }) : null;
      c.ok("P's old v2 deep link (?tab=plan&pv=scripts) still lands, on the v1 Topics tab", !!deep && find(deep, "PortalShell").length === 0 && find(deep, "TopicsTab").length === 1);
      c.ok("P's seat is kept (not revoked)", !!(await prisma.clientMembership.findFirst({ where: { id: P.membershipId!, revokedAt: null } })));

      // Every client: ALL.
      await writeRollout({ mode: "ALL", modeSince: new Date().toISOString(), pilot: null });
      const lXall = await layoutForClient({ id: X.clientId, name: X.name });
      c.ok("rollout ALL + the switch → X gets v2, reason SWITCH_ON", lXall.layout === "v2" && lXall.why === "SWITCH_ON");
      await setSwitch("portal_layout_v2", false);
      c.ok("…and the switch off → v1 for X again", (await layoutForClient({ id: X.clientId, name: X.name })).layout === "v1");
      await writeRollout(PILOT_P);
    }

    // =========================================================================
    c.head("2 · readiness = audience preview = dispatch, for every op");
    // =========================================================================
    const programOps = Object.entries(AUTOMATION_EFFECTS).filter(([, e]) => e.launchGate === "programScope").map(([k]) => k);
    // Twelve since the Sep 28 review fix: caption_assistant (a client's own
    // "Draft a caption" button) was labelled internal and gated by its switch alone.
    c.ok("twelve client-reaching program switches read the rollout scope (caption_assistant included)", programOps.length === 12 && programOps.includes("caption_assistant") && programOps.every((k) => core.isProgramReachOp(k)), programOps.join(","));
    for (const k of programOps) await setSwitch(k, true);
    await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));
    await setSwitch("script_auto_share", true, JSON.stringify({ testClientsOnly: false }));
    await setSwitch("review_auto_approve", true, JSON.stringify({ testClientsOnly: false }));
    await setSwitch("session_booking", true, JSON.stringify({ authorizedFixtureClientIds: [] }));
    {
      const rep = await readinessReport({});
      const row = (k: string) => rep.rows.find((r) => r.key === k)!;
      const names = [T.name, P.name, X.name, N.name, Y.name, R1.name, R2.name];
      const who = (ids: Set<string>) => [...ids].sort().join(",");
      const byId = new Map([T, P, X, N, Y, R1, R2].map((w) => [w.clientId, w]));
      const everyOp = [...core.PROGRAM_REACH_OPS];
      const disagree: string[] = [];
      for (const op of everyOp) {
        const aud = await rollout.programAudience(op);
        const A = new Set(aud.clients.filter((x) => x.decision.ok).map((x) => x.clientId));
        const lock = await rollout.featureTestOnlyFor(op);
        const D = new Set<string>();
        for (const w of [T, P, X, N, Y, R1, R2]) if ((await rollout.programReach(op, w.clientId, { featureTestOnly: lock })).ok) D.add(w.clientId);
        if (who(A) !== who(D)) disagree.push(`${op}: readiness/audience ${who(A)} vs dispatch ${who(D)}`);
        // The readiness line names exactly the admitted clients, never X.
        if (programOps.includes(op)) {
          const r = row(op);
          const named = names.filter((n) => (r.scope ?? "").includes(n));
          const want = [...A].map((id) => byId.get(id)!.name);
          if (named.sort().join("|") !== want.sort().join("|")) disagree.push(`${op}: line names ${named.join("+")} but admits ${want.join("+")} — ${r.scope}`);
          if (r.realClients !== [...A].some((id) => id !== T.clientId)) disagree.push(`${op}: realClients ${r.realClients}`);
        }
      }
      c.ok("for all 14 ops: programAudience (readiness), programReach (dispatch) and the readiness line name the same clients", disagree.length === 0, disagree.slice(0, 3).join(" || "));
      c.ok("the pilot ops admit exactly T and P; publishing (in no group) admits T only", who(new Set((await rollout.programAudience("reminders")).clients.filter((x) => x.decision.ok).map((x) => x.clientId))) === who(new Set([T.clientId, P.clientId])) && who(new Set((await rollout.programAudience("publishing")).clients.filter((x) => x.decision.ok).map((x) => x.clientId))) === T.clientId);
      c.ok("the reminders line: TEST clients + pilot: Pat Pilot Realty, and never \"every client\"", /^TEST clients \(.*Rollout TEST.*\) \+ pilot: Pat Pilot Realty/.test(row("reminders").scope ?? "") && !rep.rows.some((r) => r.kind === "program" && /every client/.test(r.scope ?? "")), row("reminders").scope ?? "");
      c.ok("N (never-synthetic, renamed TEST) is not named as a TEST client anywhere", !rep.rows.some((r) => (r.scope ?? "").includes(N.name)));
      c.ok("the launch gate is OPEN and each opener names the pilot, e.g. \"Client reminders — pilot: Pat Pilot Realty\"", !rep.rolloutClosed.ok && rep.rolloutClosed.openers.includes(`${AUTOMATION_EFFECTS.reminders.title} — pilot: Pat Pilot Realty`) && rep.rolloutClosed.openers.every((o) => / — pilot: Pat Pilot Realty$/.test(o)), rep.rolloutClosed.openers.join("; "));
      c.ok("\"Who the program may reach\": PILOT, the pilot named, T TEST, P PILOT, X not_in_pilot", rep.programScope.mode === "PILOT" && rep.programScope.pilot?.names.join() === P.name && rep.programScope.clients.find((x) => x.name === T.name)?.tier === "TEST" && rep.programScope.clients.find((x) => x.name === P.name)?.tier === "PILOT" && rep.programScope.clients.find((x) => x.name === X.name)?.code === "not_in_pilot" && rep.programScope.cap === core.PROGRAM_PILOT_MAX, JSON.stringify(rep.programScope.clients));
      c.ok("the hub-write row reads the PROGRAM pilot (bookings ticked → P is written for)", /program pilot: active · Pat Pilot Realty/.test(row("session_booking").scope ?? "") && row("session_booking").realClients, row("session_booking").scope ?? "");

      // The outbox dispatch gate, per rollout kind and client (a row, never sent).
      const gateRow = (kind: string, w: Who, extra: { key?: string; toRef?: string; clientId?: string | null } = {}) => programDispatchGate({
        id: "drill", channel: "email", toRef: extra.toRef ?? w.seat!, body: "", state: "pending", attempts: 0, leaseUntil: null, leaseBy: null, providerId: null, providerError: null,
        dedupeKey: extra.key ?? `${kind}:${w.enrollmentId}:drill`, requestedBy: "drill", clientId: extra.clientId === undefined ? w.clientId : extra.clientId, projectId: null, taskId: null, createdAt: new Date(), acceptedAt: null, resolvedAt: null, extraToRefsJson: null, mediaUrlsJson: null,
      });
      const gateOps: [string, Op][] = [["program_reminder", "reminders"], ["script_share", "script_share_email"], ["strategy_ready", "script_share_email"], ["program_message", "program_message_notice"]];
      const gateDisagree: string[] = [];
      for (const [kind, op] of gateOps) {
        const A = new Set((await rollout.programAudience(op)).clients.filter((x) => x.decision.ok).map((x) => x.clientId));
        for (const w of [T, P, X, N]) {
          const g = await gateRow(kind, w);
          if (g.ok !== A.has(w.clientId)) gateDisagree.push(`${kind} ${w.name}: gate ${g.ok ? "ok" : (g as { code: string }).code} vs audience ${A.has(w.clientId)}`);
        }
      }
      const inviteOk = async (w: Who) => (await gateRow("portal_invite", w, { key: `portal_invite:${w.membershipId}:invite` })).ok;
      const loginOk = async (w: Who) => (await gateRow("portal_login", w, { key: `portal_login:${w.clientUserId}:drill`, clientId: null })).ok;
      const invA = new Set((await rollout.programAudience("portal_invites")).clients.filter((x) => x.decision.ok).map((x) => x.clientId));
      const logA = new Set((await rollout.programAudience("portal_login_email")).clients.filter((x) => x.decision.ok).map((x) => x.clientId));
      for (const w of [T, P, X]) {
        if ((await inviteOk(w)) !== invA.has(w.clientId)) gateDisagree.push(`portal_invite ${w.name}`);
        if ((await loginOk(w)) !== logA.has(w.clientId)) gateDisagree.push(`portal_login ${w.name}`);
      }
      c.ok("the outbox dispatch gate agrees with the audience for all six rollout kinds × T/P/X/N", gateDisagree.length === 0, gateDisagree.join(" | "));

      // The audience preview: per-client lanes agree with the audience.
      const rows = await previewProgramAudience();
      const lane = (l: string) => rows.filter((r) => r.lane === l);
      const laneDisagree: string[] = [];
      for (const [l, op] of [["LAYOUT", "portal_layout_v2"], ["REVIEW_DEADLINES", "revision_policy"], ["TOPIC_CARRYOVER", "topic_carryover"]] as const) {
        const A = new Set((await rollout.programAudience(op)).clients.filter((x) => x.decision.ok).map((x) => x.clientId));
        for (const r of lane(l)) if (!!r.tier !== A.has(r.clientId ?? "")) laneDisagree.push(`${l} ${r.clientName}`);
      }
      c.ok("the preview's layout / review-deadline / carry-over rows agree with the audience for every program client", laneDisagree.length === 0 && lane("LAYOUT").length >= 5, laneDisagree.join(",") || `${lane("LAYOUT").length} layout rows`);
      c.ok("the preview names who each email would reach, masked, even for X (computed before the scope)", rows.every((r) => !r.to || /…@/.test(r.to)));

      // The office-replied lane, live: dry-run "send" == what Gmail received.
      const NOTICE_NOW = await (async () => {
        const { etAt, etDayKey } = await import("@/lib/datetime");
        for (let d = 1; d <= 7; d++) {
          const t = new Date(realNow.getTime() + d * DAY);
          const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(t);
          if (wd !== "Sat" && wd !== "Sun") return etAt(etDayKey(t), 11);
        }
        throw new Error("no weekday");
      })();
      for (const w of [T, P, X]) {
        await prisma.programMessage.create({ data: { enrollmentId: w.enrollmentId, clientId: w.clientId, authorKind: "STAFF", authorLabel: "Kyle", body: `drill reply for ${w.name}`, createdAt: new Date(NOTICE_NOW.getTime() - HOUR) } });
      }
      const { sweepProgramMessageNotices } = await import("@/lib/programMessages");
      const dry = await sweepProgramMessageNotices({ now: NOTICE_NOW, dryRun: true });
      const drySend = dry.preview.filter((p) => p.decision === "send");
      const outboxBefore = await prisma.outboxMessage.count();
      c.ok("the office-replied dry run writes nothing", (await prisma.outboxMessage.count()) === outboxBefore);
      const sentBefore = gmailSent.length;
      await sweepProgramMessageNotices({ now: NOTICE_NOW });
      const live = gmailSent.slice(sentBefore).map((m) => maskToRef("email", m.to.replace(/^.*<([^>]+)>.*$/, "$1").trim()));
      const readinessNames = new Set((await rollout.programAudience("program_message_notice")).clients.filter((x) => x.decision.ok).map((x) => x.clientId));
      c.ok("office-replied: dry run \"send\" = T and P = the readiness audience", who(new Set(drySend.map((p) => p.clientId))) === who(readinessNames) && who(readinessNames) === who(new Set([T.clientId, P.clientId])), JSON.stringify(drySend.map((p) => p.clientName)));
      // T's seat, P's seat and Q (seated on P too) — three people; X's seats
      // (xo@ and Q-on-X) none.
      c.ok("office-replied: fake Gmail received exactly the dry run's addresses — T's seat, P's two seats (Q once), X's none", drySend.map((p) => p.to).sort().join() === live.sort().join() && live.length === 3 && drySend.every((p) => p.clientId !== X.clientId) && gmailSent.filter((m) => /q\.assistant@/.test(m.to)).length === 1 && !gmailSent.some((m) => /xo@example|xena@example/.test(m.to)), `dry ${drySend.map((p) => `${p.clientName}:${p.to}`).join(",")} live ${live.join(",")}`);

      // The lock narrows; TEST_ONLY names nobody real.
      await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: true }));
      const rep2 = await readinessReport({});
      const r2 = rep2.rows.find((r) => r.key === "reminders")!;
      c.ok("reminders lock ON → \"TEST clients only — this feature's own testClientsOnly lock is on\", realClients false", /^TEST clients \(.*\) only — this feature's own testClientsOnly lock is on/.test(r2.scope ?? "") && !r2.realClients, r2.scope ?? "");
      const gLock = await gateRow("program_reminder", P);
      c.ok("…and the dispatch gate refuses P's reminder as launch_not_authorised (the lock), not the rollout", !gLock.ok && (gLock as { code: string }).code === "launch_not_authorised");
      await writeRollout({ ...core.CLOSED_ROLLOUT });
      const rep3 = await readinessReport({});
      c.ok("TEST_ONLY → no readiness line names a real client, the gate is closed, the header says so", rep3.rows.filter((r) => r.kind === "program").every((r) => ![P.name, X.name, N.name].some((n) => (r.scope ?? "").includes(n))) && rep3.rolloutClosed.ok && rep3.programScope.mode === "TEST_ONLY", rep3.rolloutClosed.openers.join(";"));
      await writeRollout({ mode: "ALL", modeSince: new Date().toISOString(), pilot: null });
      const rep4 = await readinessReport({});
      c.ok("ALL → \"every client with a program\" for the lock-less switches, openers say so", rep4.rows.find((r) => r.key === "revision_policy")?.scope === "every client with a program (rollout: everyone)" && rep4.rolloutClosed.openers.some((o) => o === `${AUTOMATION_EFFECTS.revision_policy.title} — every client with a program`));
      await writeRollout(PILOT_P);
      await writeRollout({ ...PILOT_P, pilot: { ...PILOT_P.pilot!, operations: ALL_OPS.filter((o) => o !== "hub_writes") } });
      const rep5 = await readinessReport({});
      const sb = rep5.rows.find((r) => r.key === "session_booking")!;
      c.ok("bookings unticked → the hub-write row says P is not written for, realClients false", /not written for — the program pilot does not include bookings/.test(sb.scope ?? "") && !sb.realClients, sb.scope ?? "");
      await writeRollout(PILOT_P);
      for (const k of [...programOps, "session_booking"]) await setSwitch(k, false);
    }

    // =========================================================================
    c.head("3 · the owner's pilot editor (rolloutActions)");
    // =========================================================================
    {
      const { setSession, clearSession } = await import("@/lib/auth/session");
      const as = async (u: { id: string }) => {
        const row = await prisma.appUser.findUniqueOrThrow({ where: { id: u.id } });
        await setSession({ uid: row.id, email: row.email, role: row.role, name: row.name ?? undefined, permissions: row.permissions });
      };
      process.env.AUTH_ENFORCE = "true";
      await writeRollout({ ...core.CLOSED_ROLLOUT });
      await as(admin);
      const byAdmin = await ra.addProgramPilotClientAction({ clientId: X.clientId, typedName: X.name, groups: ["emails"] });
      const modeByAdmin = await ra.setProgramRolloutModeAction({ mode: "PILOT" });
      c.ok("an ADMIN is refused adding a pilot client and changing the mode", !byAdmin.ok && !modeByAdmin.ok, `${byAdmin.message} | ${modeByAdmin.message}`);
      const adminView = await ra.loadProgramRolloutPanel();
      c.ok("…but may READ the panel", !("error" in adminView));
      await as(owner);
      const add = (w: Who, typed = w.name, extra: Partial<Parameters<typeof ra.addProgramPilotClientAction>[0]> = {}) => ra.addProgramPilotClientAction({ clientId: w.clientId, typedName: typed, groups: core.PROGRAM_PILOT_GROUPS.map((g) => g.key), ...extra });
      const t = await add(T);
      c.ok("a TEST client is refused (TEST clients are always in; never named)", !t.ok && /TEST client/.test(t.message), t.message);
      const n = await add(N);
      c.ok("N, the real row renamed TEST, is refused with \"fix the name\"", !n.ok && /fix the name/.test(n.message), n.message);
      const y = await add(Y);
      c.ok("a client with no ACTIVE program is refused", !y.ok && /no active program/.test(y.message), y.message);
      const wrong = await add(X, "Xena Excluded");
      c.ok("a wrong typed name is refused", !wrong.ok && /Type the client's name exactly/.test(wrong.message), wrong.message);
      const past = await add(X, X.name, { expiresOnET: "2020-01-01" });
      c.ok("an end date in the past is refused", !past.ok && /has to be in the future/.test(past.message), past.message);
      const beforeRow = await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } });
      const auditsBefore = await prisma.auditLog.count({ where: { target: core.PROGRAM_ROLLOUT_SETTING_KEY } });
      failAuditInTx = true;
      const forced = await add(P);
      failAuditInTx = false;
      const afterRow = await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } });
      c.ok("a forced audit failure inside the transaction → refused, and NEITHER the value nor an audit row landed", !forced.ok && afterRow?.value === beforeRow?.value && (await prisma.auditLog.count({ where: { target: core.PROGRAM_ROLLOUT_SETTING_KEY } })) === auditsBefore, forced.message);
      await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));
      await setSwitch("portal_layout_v2", true);
      const okP = await add(P, "  pat pilot   realty ");
      c.ok("P added (typed name compared without case or extra spaces); the message says the rollout is still TEST only", okP.ok && /still set to "Only my TEST clients"/.test(okP.message), okP.message);
      const modeP = await ra.setProgramRolloutModeAction({ mode: "PILOT" });
      c.ok("mode → PILOT: the message names the switches that are on and now reach P", modeP.ok && /Pat Pilot Realty/.test(modeP.message) && /Client reminders/.test(modeP.message) && /New portal layout/.test(modeP.message), modeP.message);
      const audit = (await prisma.auditLog.findMany({ where: { target: core.PROGRAM_ROLLOUT_SETTING_KEY }, orderBy: { createdAt: "asc" } })).slice(auditsBefore);
      c.ok("each change is one AuditLog row with before → after, by the owner", audit.length === 2 && audit.every((a) => a.actor === owner.email && / -> /.test(a.detail ?? "")) && audit[0].action === "program_pilot_add" && audit[1].action === "program_rollout_mode", audit.map((a) => `${a.action}:${a.actor}`).join(","));
      const stored = core.parseProgramRollout((await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } }))!.value).rollout;
      c.ok("stored: PILOT, P with all five groups, approvedBy the owner, joinedAt stamped", stored.mode === "PILOT" && stored.pilot?.clientIds.join() === P.clientId && stored.pilot.operations.length === ALL_OPS.length && stored.pilot.approvedBy === owner.email && !!stored.pilot.joinedAt[P.clientId]);
      const ax = await add(X, X.name, { expiresOnET: new Date(Date.now() + 40 * DAY).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) });
      const a1 = await add(R1);
      const a2 = await add(R2);
      // Oct 5 2026: the cap rose from 3 to PROGRAM_PILOT_MAX (30) so every
      // program client can be named (Settings → Client onboarding); a 4th fits.
      c.ok(`X, R1 and a 4th (R2) added — the cap is now ${core.PROGRAM_PILOT_MAX}`, ax.ok && a1.ok && a2.ok && (core.PROGRAM_PILOT_MAX as number) === 30, a2.message);
      c.ok("the end date is ONE date for the pilot, kept when a later add leaves it blank", /ends/.test(a1.message) && core.parseProgramRollout((await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } }))!.value).rollout.pilot?.expiresAt !== null, a1.message);
      const allWrong = await ra.setProgramRolloutModeAction({ mode: "ALL", typedConfirm: "every client" });
      c.ok("ALL without typing EVERY CLIENT exactly → refused", !allWrong.ok && new RegExp(EVERY_CLIENT_CONFIRM).test(allWrong.message), allWrong.message);
      const allOk = await ra.setProgramRolloutModeAction({ mode: "ALL", typedConfirm: EVERY_CLIENT_CONFIRM });
      c.ok("ALL with EVERY CLIENT → saved", allOk.ok && core.parseProgramRollout((await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } }))!.value).rollout.mode === "ALL", allOk.message);
      const edit = await ra.editProgramPilotAction({ groups: ["emails", "bookings"] });
      c.ok("\"Change the pilot\": the groups for the whole pilot, re-approved", edit.ok && core.parseProgramRollout((await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } }))!.value).rollout.pilot?.operations.join() === core.opsForGroups(["emails", "bookings"]).join(), edit.message);
      const notIn = await ra.removeProgramPilotClientAction({ clientId: N.clientId });
      const auditsNow = await prisma.auditLog.count({ where: { target: core.PROGRAM_ROLLOUT_SETTING_KEY } });
      c.ok("removing someone not in the pilot changes nothing and writes no audit row", notIn.ok && /was not in the pilot/.test(notIn.message) && (await prisma.auditLog.count({ where: { target: core.PROGRAM_ROLLOUT_SETTING_KEY } })) === auditsNow);
      const end = await ra.endProgramPilotAction();
      c.ok("End the pilot → no pilot", end.ok && core.parseProgramRollout((await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } }))!.value).rollout.pilot === null);
      await clearSession();
      delete process.env.AUTH_ENFORCE;
      await setSwitch("reminders", false, null);
      await setSwitch("portal_layout_v2", false);
      await writeRollout(PILOT_P);
    }

    // =========================================================================
    c.head("4 · R05 — every queued run is unattended");
    // =========================================================================
    analysisOut = {
      callKind: "monthly", plannedMonthKey: monthKey,
      selectedTopics: [], discussedTopics: [], rejectedIdeas: [], strategyProposals: [], priorities: [], todos: [],
      facts: [{ body: "Prefers filming on Tuesdays", category: "PRODUCTION_PREFERENCE", fieldKey: "production.preferred_days", scope: "PERMANENT", speaker: "client", confidential: false, confidence: 0.92, excerpt: excerpt("Tuesdays are best for me.") }],
    };
    const TRANSCRIPT = `${"Jordan: how is the market treating you this month? Client: busy, and Tuesdays are best for me to film. ".repeat(6)}`;
    async function monthlyCall(w: { clientId: string; enrollmentId: string }, monthId: string, tag: string) {
      const call = await prisma.programCallRecord.create({ data: { enrollmentId: w.enrollmentId, clientId: w.clientId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date(Date.now() - DAY), targetMonthKey: monthKey, monthId }, select: { id: true } });
      const src = await prisma.programTranscriptSource.create({ data: { callRecordId: call.id, provider: "paste", contentHash: `drill-${tag}-${randomBytes(4).toString("hex")}`, matchState: "CONFIRMED", text: `${TRANSCRIPT} (${tag})` }, select: { id: true } });
      return { callId: call.id, sourceId: src.id };
    }
    const jobFor = (callId: string, kind: "ANALYZE" | "INGEST" | "STRATEGY_DRAFT", requestedBy: string, enrollmentId: string, sourceId?: string, createdAt?: Date) =>
      prisma.programTranscriptJob.create({ data: { callRecordId: callId, enrollmentId, kind, state: "QUEUED", dedupeKey: `${callId}:${sourceId && kind === "INGEST" ? `${sourceId}:` : ""}${kind}`, requestedBy, transcriptSourceId: kind === "INGEST" ? sourceId ?? null : null, ...(createdAt ? { createdAt } : {}) }, select: { id: true, attempts: true } });
    {
      await setSwitch("ai_runs", false);
      const pauses: string[] = [];
      for (const who of ["drive-sweep", "onboarding-cron", "kyle@realtourpilot.com"]) {
        const { callId } = await monthlyCall(T, Tf.monthId, who);
        const before = modelCalls.length;
        const r = await gen.runTranscriptJob({ id: "x", kind: "ANALYZE", callRecordId: callId, transcriptSourceId: null, enrollmentId: T.enrollmentId, requestedBy: who });
        if (!(!r.ok && "paused" in r) || modelCalls.length !== before) pauses.push(`${who}: ${JSON.stringify(r).slice(0, 120)}`);
      }
      c.ok("NEW: jobs requested by drive-sweep, onboarding-cron and a staff email all PAUSE with ai_runs off; the model is not called", pauses.length === 0, pauses.join(" | "));
      const { callId } = await monthlyCall(T, Tf.monthId, "old");
      const before = modelCalls.length;
      const oldR = await OldGen.runTranscriptJob({ id: "x", kind: "ANALYZE", callRecordId: callId, transcriptSourceId: null, enrollmentId: T.enrollmentId, requestedBy: "drive-sweep" });
      c.ok("OLD: the same \"drive-sweep\" job ran ATTENDED with ai_runs off — the model WAS called", oldR.ok && modelCalls.length === before + 1, JSON.stringify(oldR).slice(0, 160));
      const oldFact = await prisma.clientFact.findFirst({ where: { clientId: T.clientId, fieldKey: "production.preferred_days" }, orderBy: { createdAt: "desc" } });
      c.ok("OLD: and its eligible fact was only PROPOSED (auto-accept never applied to queued analysis)", oldFact?.status === "PROPOSED" && !oldFact.autoAccepted, `${oldFact?.status} ${oldFact?.autoAccepted}`);
      await prisma.clientFact.deleteMany({ where: { clientId: T.clientId } });

      // NEW, through the driver: transcript_jobs + ai_runs + fact_extraction on.
      await setSwitch("ai_runs", true);
      await setSwitch("fact_extraction", true);
      await setSwitch("transcript_jobs", true, JSON.stringify({ onlyQueuedAfter: "ALL" }));
      await prisma.programTranscriptJob.updateMany({ where: { state: "QUEUED" }, data: { state: "CANCELLED" } });
      const { callId: c2 } = await monthlyCall(T, Tf.monthId, "new");
      const job = await jobFor(c2, "ANALYZE", "drive-sweep", T.enrollmentId);
      const drv = await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill" });
      const after = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: job.id } });
      const fact = await prisma.clientFact.findFirst({ where: { clientId: T.clientId, fieldKey: "production.preferred_days" } });
      c.ok("NEW: the queued ANALYZE (drive-sweep) SUCCEEDED and its eligible fact was AUTO-ACCEPTED", after.state === "SUCCEEDED" && fact?.status === "ACCEPTED" && fact.autoAccepted === true, `${after.state} ${after.lastError} ${fact?.status} ${JSON.stringify(drv)}`);
      const run = await prisma.programAiRun.findFirst({ where: { enrollmentId: T.enrollmentId, kind: "call_analysis" }, orderBy: { createdAt: "desc" } });
      c.ok("…the run is recorded as unattended, requestedBy kept for attribution", !!run && (run.requestedBy ?? "").includes("drive-sweep"), `${run?.requestedBy}`);
    }

    // =========================================================================
    c.head("5 · the driver: owner switches, the backlog, the rollout");
    // =========================================================================
    {
      await prisma.programTranscriptJob.updateMany({ where: { state: "QUEUED" }, data: { state: "CANCELLED" } });
      // (a) KIND_OWNER: a STRATEGY_DRAFT waits while strategy_generation is off.
      await setSwitch("strategy_generation", false);
      const disc = await prisma.programCallRecord.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, callType: "BRAND_DISCOVERY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date(Date.now() - 2 * DAY) }, select: { id: true } });
      const draft = await jobFor(disc.id, "STRATEGY_DRAFT", "onboarding-cron", T.enrollmentId);
      const { callId: c3, sourceId: s3 } = await monthlyCall(T, Tf.monthId, "behind");
      const ingest = await jobFor(c3, "INGEST", "drive-sweep", T.enrollmentId, s3);
      const analyze = await jobFor(c3, "ANALYZE", "drive-sweep", T.enrollmentId);
      const d1 = await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill" });
      const dj = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: draft.id } });
      c.ok("STRATEGY_DRAFT with strategy_generation off: not claimed, attempts unchanged, \"waiting: strategy_generation is off\"", dj.state === "QUEUED" && dj.attempts === 0 && dj.lastError === "waiting: strategy_generation is off" && !dj.startedAt, `${dj.state} ${dj.attempts} ${dj.lastError}`);
      const [ij, aj] = await Promise.all([prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: ingest.id } }), prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: analyze.id } })]);
      c.ok("…while the INGEST and ANALYZE queued behind it still ran", ij.state === "SUCCEEDED" && aj.state === "SUCCEEDED", `${ij.state} ${ij.lastError} / ${aj.state} ${aj.lastError}`);
      c.ok("…and the tick reports it held, not failed", "held" in d1 && d1.held.owner === 1 && d1.failed === 0, JSON.stringify(d1));
      const markedAt = dj.lastErrorAt?.getTime();
      await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill" });
      c.ok("marked ONCE: a second tick does not rewrite the same reason", (await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: draft.id } })).lastErrorAt?.getTime() === markedAt);
      await prisma.programTranscriptJob.update({ where: { id: draft.id }, data: { state: "CANCELLED" } });

      // (b) The backlog: jobs queued before the processor was first switched on.
      // A processor that has never been switched on has no row at all.
      await prisma.programAutomation.delete({ where: { key: "transcript_jobs" } });
      const { callId: c4 } = await monthlyCall(T, Tf.monthId, "backlog");
      const old = await jobFor(c4, "ANALYZE", "drive-sweep", T.enrollmentId, undefined, new Date(Date.now() - 2 * HOUR));
      const batch0 = await tj.transcriptQueueBatch();
      c.ok("before first switch-on, the batch says the waiting job will be SKIPPED unless included", batch0.backlog.source === "never_on" && batch0.heldBacklog === 1 && /will be SKIPPED when it is switched on/.test(batch0.line), batch0.line);
      await setSwitch("transcript_jobs", true, null, new Date(Date.now() - HOUR));
      const auditsB = await prisma.auditLog.count({ where: { action: "transcript_backlog_pinned" } });
      await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill" });
      const oj = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: old.id } });
      const cfg = JSON.parse((await prisma.programAutomation.findUniqueOrThrow({ where: { key: "transcript_jobs" } })).configJson ?? "{}") as Record<string, unknown>;
      c.ok("the older job is held (\"queued … before the call processor was first switched on\"), attempt untouched", oj.state === "QUEUED" && oj.attempts === 0 && /before the call processor was first switched on/.test(oj.lastError ?? ""), oj.lastError ?? "");
      c.ok("the switch-on moment is PINNED in its config (onlyQueuedAfter), with an audit row", typeof cfg.onlyQueuedAfter === "string" && (await prisma.auditLog.count({ where: { action: "transcript_backlog_pinned" } })) === auditsB + 1, JSON.stringify(cfg));
      await setSwitch("transcript_jobs", false);
      await setSwitch("transcript_jobs", true);
      const cfg2 = JSON.parse((await prisma.programAutomation.findUniqueOrThrow({ where: { key: "transcript_jobs" } })).configJson ?? "{}") as Record<string, unknown>;
      c.ok("turning it off and on again does not move the pinned moment", cfg2.onlyQueuedAfter === cfg.onlyQueuedAfter);
      const { setTranscriptBacklogAction } = await import("@/app/settings/calendlyActions");
      const inc = await setTranscriptBacklogAction("include");
      await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill" });
      c.ok("the owner includes the older jobs → it runs on the next tick", inc.ok && (await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: old.id } })).state === "SUCCEEDED", inc.message);

      // (c) The rollout: internal AI only for TEST and pilot clients.
      const Xm = await prisma.contentMonth.create({ data: { enrollmentId: X.enrollmentId, clientId: X.clientId, monthKey, videosOwed: 4, status: "OPEN" }, select: { id: true } });
      const Pm = await prisma.contentMonth.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, monthKey, videosOwed: 4, status: "OPEN" }, select: { id: true } });
      const { callId: cx } = await monthlyCall(X, Xm.id, "x");
      const { callId: cp } = await monthlyCall(P, Pm.id, "p");
      const xj = await jobFor(cx, "ANALYZE", "drive-sweep", X.enrollmentId);
      const pj = await jobFor(cp, "ANALYZE", "drive-sweep", P.enrollmentId);
      await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill" });
      const [xr, pr] = await Promise.all([prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: xj.id } }), prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: pj.id } })]);
      c.ok("PILOT: X's (excluded) analysis WAITS, \"outside the rollout\", attempt untouched; P's (pilot) ran", xr.state === "QUEUED" && xr.attempts === 0 && /outside the rollout/.test(xr.lastError ?? "") && pr.state === "SUCCEEDED", `${xr.state} ${xr.lastError} / ${pr.state} ${pr.lastError}`);
      await writeRollout({ mode: "ALL", modeSince: new Date().toISOString(), pilot: null });
      await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill" });
      c.ok("rollout ALL → X's analysis runs", (await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: xj.id } })).state === "SUCCEEDED");
      await writeRollout(PILOT_P);
      await prisma.appSetting.update({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY }, data: { value: "{bad" } });
      const { callId: cx2 } = await monthlyCall(X, Xm.id, "x2");
      const xj2 = await jobFor(cx2, "ANALYZE", "drive-sweep", X.enrollmentId);
      await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill" });
      c.ok("an unreadable rollout → TEST only: X's new analysis waits (fail closed)", (await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: xj2.id } })).state === "QUEUED");
      await writeRollout(PILOT_P);
      await prisma.programTranscriptJob.update({ where: { id: xj2.id }, data: { state: "CANCELLED" } });
    }

    // =========================================================================
    c.head("6 · readiness: the processor is a dependency, and the queue is visible");
    // =========================================================================
    {
      await prisma.programTranscriptJob.updateMany({ where: { state: "QUEUED" }, data: { state: "CANCELLED" } });
      await setSwitch("transcript_jobs", false);
      await setSwitch("strategy_generation", true);
      await setSwitch("ai_runs", true);
      await setSwitch("script_drafting", true);
      for (let i = 0; i < 2; i++) {
        const d = await prisma.programCallRecord.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, callType: "BRAND_DISCOVERY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date(Date.now() - DAY) }, select: { id: true } });
        await jobFor(d.id, "STRATEGY_DRAFT", "onboarding-cron", T.enrollmentId);
      }
      const rep = await readinessReport({});
      const sg = rep.rows.find((r) => r.key === "strategy_generation")!;
      c.ok("strategy_generation + ai_runs on, transcript_jobs off, 2 drafts queued → NOT effective; the blocker names transcript_jobs and the 2", !sg.effective.ok && sg.effective.blockers.some((b) => /needs transcript_jobs switched on/.test(b) && /2 strategy drafts are queued and not being processed/.test(b)), sg.effective.blockers.join(" | "));
      c.ok("…and healthy reads \"blocked\", never last-ran", sg.healthy.ok === null && /blocked/.test(sg.healthy.detail), sg.healthy.detail);
      const old = await OldReadiness.readinessReport({});
      const osg = old.rows.find((r) => r.key === "strategy_generation")!;
      c.ok("OLD (same data): strategy_generation EFFECTIVE, no blocker at all", osg.effective.ok && osg.effective.blockers.length === 0);
      const sd = rep.rows.find((r) => r.key === "script_drafting")!;
      c.ok("script_drafting (partial dependency): effective, but PART blocked, and never healthy", sd.effective.ok && sd.effective.partial.some((p) => /planning call/.test(p) && /transcript_jobs/.test(p)) && sd.healthy.ok === false && /partly blocked/.test(sd.healthy.detail), `${sd.healthy.detail}`);
      const fe = rep.rows.find((r) => r.key === "fact_extraction")!;
      c.ok("fact_extraction: the processor is a partial dependency, reported even while it is off (Calendly-mapped calls)", (AUTOMATION_EFFECTS.fact_extraction.requires?.partial ?? []).some((p) => p.switch === "transcript_jobs") && fe.effective.partial.some((p) => /Calendly-mapped calls/.test(p)), fe.effective.partial.join(" | "));
      const tjRow = rep.rows.find((r) => r.key === "transcript_jobs")!;
      c.ok("the transcript_jobs row carries the read-only \"Queued now: 2 jobs (STRATEGY_DRAFT 2) · oldest …\" line", /Queued now: 2 jobs \(STRATEGY_DRAFT 2\) · oldest /.test(tjRow.note ?? "") && /do not use the queue/.test(tjRow.note ?? ""), tjRow.note ?? "");
      c.ok("strategy_generation's row says the buttons run inline", /Draft strategy now/.test(sg.note ?? ""));
      c.ok("the switch copy: strategy_generation needs transcript_jobs AND ai_runs", JSON.stringify(AUTOMATION_EFFECTS.strategy_generation.requires?.switches) === JSON.stringify(["transcript_jobs", "ai_runs"]));

      // Queue not draining: effective, a runnable job waiting 4 h.
      await prisma.programTranscriptJob.updateMany({ where: { state: "QUEUED" }, data: { state: "CANCELLED" } });
      await setSwitch("transcript_jobs", true, JSON.stringify({ onlyQueuedAfter: new Date(Date.now() - 6 * HOUR).toISOString() }), new Date(Date.now() - 5 * HOUR));
      await prisma.programAutomation.update({ where: { key: "transcript_jobs" }, data: { lastRunAt: new Date(Date.now() - 10 * 60_000) } });
      const { callId: cq } = await monthlyCall(T, Tf.monthId, "stuck");
      await jobFor(cq, "ANALYZE", "drive-sweep", T.enrollmentId, undefined, new Date(Date.now() - 4 * HOUR));
      const rep2 = await readinessReport({});
      const t2 = rep2.rows.find((r) => r.key === "transcript_jobs")!;
      c.ok("transcript_jobs effective with a runnable job waiting 4 h → healthy false, \"queue not draining\"", t2.effective.ok && t2.healthy.ok === false && /queue not draining/.test(t2.healthy.detail), `${t2.effective.blockers.join(";")} ${t2.healthy.detail}`);
      await prisma.programTranscriptJob.updateMany({ where: { state: "QUEUED" }, data: { state: "CANCELLED" } });
      for (const k of ["strategy_generation", "script_drafting", "transcript_jobs"]) await setSwitch(k, false);
    }

    // =========================================================================
    c.head("7 · transcriptQueueBatch — counts, tiers, runnable; read-only");
    // =========================================================================
    {
      await setSwitch("transcript_jobs", false, JSON.stringify({ onlyQueuedAfter: "ALL" }));
      await setSwitch("strategy_generation", false);
      const Xm = await prisma.contentMonth.findFirstOrThrow({ where: { enrollmentId: X.enrollmentId } });
      const Pm = await prisma.contentMonth.findFirstOrThrow({ where: { enrollmentId: P.enrollmentId } });
      const a = await monthlyCall(T, Tf.monthId, "b1");
      const b = await monthlyCall(P, Pm.id, "b2");
      const x = await monthlyCall(X, Xm.id, "b3");
      await jobFor(a.callId, "INGEST", "drive-sweep", T.enrollmentId, a.sourceId, new Date(Date.now() - 5 * DAY));
      await jobFor(a.callId, "ANALYZE", "drive-sweep", T.enrollmentId);
      await jobFor(b.callId, "ANALYZE", "kyle@realtourpilot.com", P.enrollmentId);
      await jobFor(x.callId, "ANALYZE", "drive-sweep", X.enrollmentId);
      const disc = await prisma.programCallRecord.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, callType: "BRAND_DISCOVERY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date(Date.now() - DAY) }, select: { id: true } });
      await jobFor(disc.id, "STRATEGY_DRAFT", "onboarding-cron", P.enrollmentId);
      const snap = async () => JSON.stringify([await prisma.programTranscriptJob.findMany({ orderBy: { id: "asc" } }), await prisma.programAutomation.findMany({ orderBy: { key: "asc" } }), await prisma.auditLog.count()]);
      const before = await snap();
      const q = await tj.transcriptQueueBatch();
      c.ok("by kind: INGEST 1 · ANALYZE 3 · STRATEGY_DRAFT 1 (5 queued)", q.queued === 5 && q.byKind.INGEST === 1 && q.byKind.ANALYZE === 3 && q.byKind.STRATEGY_DRAFT === 1, JSON.stringify(q.byKind));
      c.ok("by requester: drive-sweep 3, the staff email 1, onboarding-cron 1", q.byRequester["drive-sweep"] === 3 && q.byRequester["kyle@realtourpilot.com"] === 1 && q.byRequester["onboarding-cron"] === 1, JSON.stringify(q.byRequester));
      const tier = (n: string) => q.clients.find((x2) => x2.name === n)?.tier;
      c.ok("by client with its tier: T TEST, P PILOT, X REAL", tier(T.name) === "TEST" && tier(P.name) === "PILOT" && tier(X.name) === "REAL", JSON.stringify(q.clients));
      c.ok("runnable now 3 (T's two, P's one); X waits on the rollout; the draft on strategy_generation", q.runnableNow === 3 && q.heldScope === 1 && q.waitingOnOwner === 1 && q.ownerOff[0]?.owner === "strategy_generation", JSON.stringify({ r: q.runnableNow, s: q.heldScope, o: q.waitingOnOwner }));
      c.ok("oldest = the 5-day-old INGEST; five per tick; one tick to drain; 4 AI jobs", !!q.oldestQueuedAt && Date.now() - q.oldestQueuedAt.getTime() > 4 * DAY && q.perTick === 5 && q.ticksToDrain === 1 && q.aiJobs === 4);
      c.ok("the line reads as the owner needs it (off, the batch, the real client, the credit)", /^off — 5 waiting: INGEST 1 · ANALYZE 3 · STRATEGY_DRAFT 1 for 3 clients \(1 real: Xena Excluded Homes\)/.test(q.line) && /each AI job spends credit/.test(q.line), q.line);
      await tj.transcriptQueueBatch();
      c.ok("it wrote NOTHING (jobs, switches, audit byte-identical)", (await snap()) === before);
      await prisma.programTranscriptJob.updateMany({ where: { state: "QUEUED" }, data: { state: "CANCELLED" } });
    }

    // =========================================================================
    c.head("8 · the pilot panel, rendered (react-dom/server): owner edits, admin reads");
    // =========================================================================
    {
      const data = await ra.loadProgramRolloutPanel();
      if ("error" in data) throw new Error(data.error);
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "r0405-render-"));
      fs.writeFileSync(path.join(outDir, "panel-data.json"), JSON.stringify(data));
      const env: NodeJS.ProcessEnv = {
        ...process.env, R0405_MODE: "render", R0405_OUT: outDir, DRILL_PORT: String(PORT),
        NODE_OPTIONS: "--require ./scripts/_drill/_drill-preload.cjs --require ./scripts/_drill/_client-drill-preload.cjs",
      };
      const code = await new Promise<number>((resolve) => {
        const child = spawn("npx", ["tsx", path.join("scripts", "_drill", path.basename(__filename))], { cwd: REPO, env, stdio: ["ignore", "inherit", "inherit"] });
        child.on("exit", (n) => resolve(n ?? 1));
      });
      const result = fs.existsSync(path.join(outDir, "result.json")) ? JSON.parse(fs.readFileSync(path.join(outDir, "result.json"), "utf8")) as { errors: string[]; blocked: string[] } : { errors: [`exit ${code}`], blocked: [] };
      c.ok("the render child finished with both renders", code === 0 && result.errors.length === 0, result.errors.join("\n").slice(0, 800));
      // React separates adjacent text with <!-- -->; the words are read without it.
      const html = (w: string) => (fs.existsSync(path.join(outDir, `${w}.html`)) ? fs.readFileSync(path.join(outDir, `${w}.html`), "utf8").replace(/<!-- -->/g, "") : "");
      const O = html("owner"), A = html("admin");
      c.ok("owner: the anchor, the three plain-word choices, add / take out / end, the cap", /id="program-rollout"/.test(O) && (O.match(/name="program-rollout-mode"/g) ?? []).length === 3 && /Add a pilot client/.test(O) && /Take out of the pilot/.test(O) && /End the pilot/.test(O) && new RegExp(`at most ${core.PROGRAM_PILOT_MAX} real clients`).test(O));
      c.ok("owner: shows who is in it, what it covers, who approved it", O.includes(P.name) && /approved by jordan@drill.test/.test(O) && /covers/.test(O));
      c.ok("admin: the same facts, READ-ONLY — no choice, no add, no take-out, no end", /id="program-rollout"/.test(A) && A.includes(P.name) && !/name="program-rollout-mode"/.test(A) && !/Add a pilot client/.test(A) && !/Take out of the pilot/.test(A) && !/End the pilot/.test(A) && /Only Jordan can change it/.test(A));
      c.ok("the render child reached nothing outside the machine", result.blocked.length === 0, result.blocked.join(","));
      fs.rmSync(outDir, { recursive: true, force: true });
    }

    c.head("9 · nothing left the machine");
    c.ok("every non-loopback call was fenced or faked (Google token, Gmail send only)", fence.blocked.length === 0, fence.blocked.slice(0, 5).join(" | "));
  } catch (e) {
    // A throw is a failure, printed — never a quiet early summary.
    c.ok(`the drill ran to the end (it threw: ${(e as Error).message})`, false, (e as Error).stack?.split("\n").slice(0, 8).join("\n"));
  } finally {
    c.summary();
    quiet.restore();
    try { fs.unlinkSync(path.join(baseDir, "node_modules")); fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* harmless */ }
    await stop();
    process.exit(process.exitCode ?? 0);
  }
}
