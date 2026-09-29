// ---------------------------------------------------------------------------
// DRILL: R03 enforcement — WHO THE PROGRAM MAY REACH, at every send, every
// dispatch and every retry (builder A1, Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/r03-rollout-scope.ts
//
// The scope core (programRolloutCore / programRollout / programRolloutGate) is
// proven on its own by r03-rollout-core.ts (the whole decision matrix lives
// there). This drill proves the WIRING: every client-reaching program send and
// every portal account operation asks the same rule, at creation AND again at
// dispatch, and taking a client out of the pilot stops work already queued.
//
// THE CAST (one database):
//   T   "Rollout TEST"          synthetic, seat info+rt@ (a verified inbox)
//   T2  "Second Rollout TEST"   synthetic, seat nick@ (staff, NOT verified)
//   T3  "Bobby Drill TEST"      synthetic, seat bobmike0214@gmail.com (verified)
//   P   "Pat Pilot Realty"      REAL, in the approved pilot (every group ticked)
//   X   "Xena Excluded Homes"   REAL, excluded
//   Y   "Yves Noseat Group"     REAL, excluded, NO seat (the fallback address)
//   N   the never-synthetic row cmqikskt1008u9k9qej9ltjy5 renamed "Jordan Spackman TEST"
//   Q   one person with OWNER seats on BOTH P and X
//
//    0. OLD, for real: 1075a5b's whole tree, exported with `git archive` into a
//       temp dir (read-only on the repo), runs as a child on ITS OWN PGlite
//       (port +1), same cast, same switches. It reaches X and Y with the
//       reminders lock lifted, mails X's seats the office reply, invites X,
//       releases X's held access, lets Q's session open X, writes Aryeo for X
//       off a per-switch list, and a TEST row on nick@ aborts its live tick.
//    1. The scope as the server reads it (T, P reached; X, Y, N refused).
//    2. Immediate actions: invite, teammate/Stripe grant, sign-in link,
//       consume, sessions, stream + upload routes, minted links.
//    3. Held access: preview == release; only P granted; idempotent.
//    4. The hourly sweeps with every switch on and every lock lifted:
//       reminders (planning lane Fri, address lane Mon), share notices,
//       office-replied notices (backlog before the join is not mailed),
//       auto-share eligibility, carry-over (only what was scripted since the
//       join), review windows (NOT_HELD_BEFORE_SCOPE, X untouched, no panel).
//    5. P taken out of the pilot (one audited write): a young pending row
//       drained → refused; an unknown row retried → "Not sent"; a FAILED
//       reminder → SUPPRESSED, no 4th attempt, no task; a pending notice →
//       SUPPRESSED with the reason on the release; a queued reminder →
//       CANCELLED and its outbox row failed; a removal between evaluation and
//       dispatch → suppressed at the recheck; P's session closes while the
//       token link still renders — and (review fix, Sep 28) a SEAT media
//       token minted while P was in stops streaming at once (it kept playing
//       for up to six hours); Aryeo refuses P and the portal says DESK.
//    6. Non-program comms untouched: six kinds for X accepted, no scope or
//       switch read, and — through the same deliver() with a counting gate —
//       the gate asked 0 times for them and once for a program reminder.
//    7. Fail closed: an EXPIRED pilot covers nobody (no reminder, no sign-in,
//       no Aryeo write); '{bad' → TEST only (client kinds still send); the
//       writer will not overwrite it; an injected client-read error →
//       gate_error; a throwing gate → gate_error.
//    8. TEST destinations: T2 suppressed (dry run and live agree, no abort);
//       T3 on bobmike0214@ allowed both ways.
//    9. Dry run == dispatch, and every preview writes nothing (row counts in
//       every table before and after).
//   10. Q never reaches X by any path.
//   11. Hub writes: the program pilot names who Aryeo/Calendly write for; the
//       FIXTURE path is unchanged.
//
// ISOLATION: PGlite on 127.0.0.1:DRILL_PORT (default 6210) and, for the OLD
// pass, 6211. Google's token endpoint and Gmail's send are FAKES inside the
// fence, and Aryeo's GET /customers/<id> for the one fixture; nothing leaves.
// THE CLOCK IS PINNED to Fri Oct 2 2026 10:00 ET in both processes.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors, runDrillChild } from "./_harness";
import { createFixtureCustomers } from "./_fixtures/fixtureIdentity";

const PORT = Number(process.env.DRILL_PORT ?? 6210);
const OLD_PORT = PORT + 1;
const BASE = "1075a5b"; // pinned: the tree the Sep 28 review read
const REPO = path.resolve(__dirname, "../..");
const OLD_PASS = "--old-pass";
const N_ID = "cmqikskt1008u9k9qej9ltjy5";

// ---- the clock ---------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 2, 14, 0, 0); // Fri Oct 2 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
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
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date(PINNED);
const T0 = new Date(PINNED - 2 * DAY); // P joined the pilot Wed Sep 30, 10:00 ET
const MON = new Date(RealDate.UTC(2026, 9, 5, 14, 5)); // Mon Oct 5, 10:05 ET
const WED_SESSION = new Date(RealDate.UTC(2026, 9, 7, 14, 0)); // Wed Oct 7, 10:00 ET
const WED_FOLLOWUP = new Date(RealDate.UTC(2026, 9, 7, 14, 30)); // Wed Oct 7, 10:30 ET

installNextStubs();

// ---- fake Gmail (and Aryeo's GET /customers for §11's fixture) ----------------
type Mail = { to: string; subject: string; body: string };
const mails: Mail[] = [];
const customers = createFixtureCustomers();
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const hit = customers.route(url, init);
  if (hit) return hit;
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const [head, ...rest] = text.split("\r\n\r\n");
    const subj = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)?.[1] ?? "";
    mails.push({ to: (/^To: (.+)$/m.exec(head)?.[1] ?? "").trim().toLowerCase(), subject: Buffer.from(subj, "base64").toString("utf8"), body: rest.join("\r\n\r\n") });
    return json({ id: `gm-${mails.length}` });
  }
  return null;
});
const mailsSince = (i: number) => mails.slice(i).map((m) => m.to);

// ---- the cast, seeded the same way in both trees -------------------------------
type Fx = { clientId: string; enrollmentId: string; monthId: string; projectId: string | null; clientUserId: string | null; membershipId: string | null; portalToken: string | null; name: string };
type Cast = { T: Fx; T2: Fx; T3: Fx; P: Fx; X: Fx; Y: Fx; N: Fx; Q: { id: string; email: string; seatP: string; seatX: string } };

async function seedCast(prisma: PrismaClient, build: typeof import("./_fixtures/contentMonth").buildContentMonth): Promise<Cast> {
  const mk = async (name: string, realName: string | null, owner: string | false, extra: { clientEmail?: string } = {}): Promise<Fx> => {
    const f = await build(prisma, { name, package: "Starter", videosPerMonth: 3, monthKey: "2026-10", owner: owner === false ? false : { email: owner, name: `${name.split(" ")[0]} Person` }, topics: [{ title: `${name} topic`, selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: f.monthId }, data: { planningMode: "WRITTEN" } });
    if (realName) await prisma.client.update({ where: { id: f.clientId }, data: { name: realName } });
    if (extra.clientEmail) await prisma.client.update({ where: { id: f.clientId }, data: { email: extra.clientEmail } });
    return { clientId: f.clientId, enrollmentId: f.enrollmentId, monthId: f.monthId, projectId: f.projectId, clientUserId: f.clientUserId, membershipId: f.membershipId, portalToken: f.portalToken, name: realName ?? name };
  };
  const T = await mk("Rollout TEST", null, "info+rt@realtourpilot.com");
  const T2 = await mk("Second Rollout TEST", null, "nick@realtourpilot.com");
  const T3 = await mk("Bobby Drill TEST", null, "bobmike0214@gmail.com");
  const P = await mk("Pat Pilot TEST", "Pat Pilot Realty", "pat@example.test");
  const X = await mk("Xena Excluded TEST", "Xena Excluded Homes", "xo@example.test", { clientEmail: "xo-client@example.test" });
  const Y = await mk("Yves Noseat TEST", "Yves Noseat Group", false, { clientEmail: "y@example.test" });
  // N: the never-synthetic real row, renamed TEST — built by hand for its fixed id.
  await prisma.client.create({ data: { id: N_ID, name: "Jordan Spackman TEST", email: "n-client@example.test", socialClient: true, socialPlan: "Starter" } });
  const nE = await prisma.contentEnrollment.create({ data: { clientId: N_ID, status: "ACTIVE", package: "Starter", videosPerMonth: 3, sessionsPerMonth: 1, sessionHours: 1, startedAt: new Date("2026-08-01T04:00:00Z"), portalToken: `ntok${"n".repeat(28)}` } });
  const nM = await prisma.contentMonth.create({ data: { enrollmentId: nE.id, clientId: N_ID, monthKey: "2026-10", videosOwed: 3, status: "OPEN", planningMode: "WRITTEN" } });
  const nU = await prisma.clientUser.create({ data: { email: "n@example.test", name: "N Person", status: "ACTIVE" } });
  const nS = await prisma.clientMembership.create({ data: { clientUserId: nU.id, enrollmentId: nE.id, clientId: N_ID, role: "OWNER", acceptedAt: new Date() } });
  const N: Fx = { clientId: N_ID, enrollmentId: nE.id, monthId: nM.id, projectId: null, clientUserId: nU.id, membershipId: nS.id, portalToken: nE.portalToken, name: "Jordan Spackman TEST" };
  // Q: one person, OWNER seats on P and X (an assistant working for two agents).
  const q = await prisma.clientUser.create({ data: { email: "q@example.test", name: "Quinn Assistant", status: "ACTIVE" } });
  const seatP = await prisma.clientMembership.create({ data: { clientUserId: q.id, enrollmentId: P.enrollmentId, clientId: P.clientId, role: "OWNER" } });
  const seatX = await prisma.clientMembership.create({ data: { clientUserId: q.id, enrollmentId: X.enrollmentId, clientId: X.clientId, role: "OWNER" } });
  return { T, T2, T3, P, X, Y, N, Q: { id: q.id, email: "q@example.test", seatP: seatP.id, seatX: seatX.id } };
}

async function setSwitch(prisma: PrismaClient, key: string, enabled: boolean, config: Record<string, unknown> | null = null, enabledAt: Date = new Date(PINNED - 10 * DAY)) {
  const configJson = config ? JSON.stringify(config) : null;
  await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt, configJson }, update: { enabled, enabledAt, configJson } });
}

async function office(prisma: PrismaClient) {
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@realtourpilot.com" } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
  const jordan = await prisma.appUser.create({ data: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
  return { kyle, jordan };
}

const tokenIn = (body: string) => /portal\/auth\/([A-Za-z0-9_-]{40,60})/.exec(body)?.[1] ?? null;

// ============================================================================
// THE OLD PASS: 1075a5b's tree, its own database.
// ============================================================================
type OldResults = {
  tree: string;
  remindersDry: { name: string; decision: string; reason: string | null; to: string | null }[];
  remindersLiveTo: string[];
  t2Dry: string | null;
  t2Live: string;
  noticeTo: string[];
  inviteX: { emailed: boolean; to: string[] };
  releaseX: { granted: number; to: string[] };
  q: { mailed: boolean; live: string[]; resolvesX: boolean };
  hub: { x: string; p: string };
};

async function oldPass(): Promise<void> {
  const out: Partial<OldResults> = { tree: __filename };
  try {
    const drill = await bootDrillDb({ port: OLD_PORT });
    const { prisma } = await import("@/lib/prisma");
    const db = prisma as unknown as PrismaClient;
    const { buildContentMonth } = await import("./_fixtures/contentMonth");
    const cast = await seedCast(db, buildContentMonth);
    await office(db);
    const R = await import("@/lib/programReminders");
    // (a) reminders with the lock lifted.
    await setSwitch(db, "reminders", true, { testClientsOnly: false });
    const dry = await R.evaluateReminders({ dryRun: true, now: NOW });
    const nameOf = new Map(Object.values(cast).filter((v): v is Fx => "clientId" in v).map((f) => [f.clientId, f.name]));
    out.remindersDry = dry.candidates.filter((c) => c.lane === "PRIMARY").map((c) => ({ name: nameOf.get(c.clientId) ?? c.clientId, decision: c.decision, reason: c.suppressionReason, to: c.to }));
    out.t2Dry = dry.candidates.find((c) => c.clientId === cast.T2.clientId && c.lane === "PRIMARY")?.decision ?? null;
    let i = mails.length;
    await R.evaluateReminders({ dryRun: false, now: NOW, enrollmentIds: [cast.X.enrollmentId, cast.Y.enrollmentId] });
    out.remindersLiveTo = mailsSince(i);
    try {
      await R.evaluateReminders({ dryRun: false, now: NOW, enrollmentIds: [cast.T2.enrollmentId] });
      out.t2Live = "completed";
    } catch (e) {
      out.t2Live = `threw ${(e as Error).name}`;
    }
    // (b) the office replied to X.
    await setSwitch(db, "program_message_notice", true);
    const pm = await import("@/lib/programMessages");
    await prisma.programMessage.create({ data: { enrollmentId: cast.X.enrollmentId, clientId: cast.X.clientId, authorKind: "STAFF", authorLabel: "Kyle Drill", body: "We moved your shoot.", createdAt: new Date(PINNED - HOUR) } });
    i = mails.length;
    await pm.sweepProgramMessageNotices({ now: NOW });
    out.noticeTo = mailsSince(i);
    // (c) a staff invitation on X with invitations on.
    await setSwitch(db, "portal_invites", true);
    const pa = await import("@/lib/portalAccess");
    i = mails.length;
    const inv = await pa.inviteClientUser(cast.X.enrollmentId, "xnew@example.test", "Xavier New", "COLLABORATOR", null);
    out.inviteX = { emailed: inv.emailed, to: mailsSince(i) };
    // (d) access held while invitations were off, then released.
    await setSwitch(db, "portal_invites", false);
    await pa.grantProgramAccess({ enrollmentId: cast.X.enrollmentId, emailRaw: "xx@example.test", name: "Xander Paid", reason: "welcome" });
    await setSwitch(db, "portal_invites", true);
    i = mails.length;
    const rel = await pa.releasePendingProgramAccess("drill");
    out.releaseX = { granted: rel.granted, to: mailsSince(i) };
    // (e) Q asks for a sign-in link.
    await setSwitch(db, "portal_login_email", true);
    i = mails.length;
    await pa.requestLoginLink("q@example.test");
    const qMail = mails.slice(i).find((m) => m.to === "q@example.test");
    const portal = await import("@/lib/portal");
    const live = await portal.liveMemberships(cast.Q.id);
    let resolvesX = false;
    const raw = qMail ? tokenIn(qMail.body) : null;
    if (raw) {
      const consumed = await pa.consumeLoginToken(raw);
      if (consumed.ok) {
        const { signClientSession, CLIENT_COOKIE } = await import("@/lib/auth/clientSession");
        const cookie = await signClientSession({ cu: consumed.clientUserId, email: consumed.email });
        const r = await portal.resolvePortalViewer({ cookies: { get: (n: string) => (n === CLIENT_COOKIE ? cookie : undefined) }, enrollmentId: cast.X.enrollmentId });
        resolvesX = r.ok;
      }
    }
    out.q = { mailed: !!qMail, live: live.map((s) => s.clientName), resolvesX };
    // (f) the Aryeo guard with a per-switch pilot naming X.
    await setSwitch(db, "session_booking", true, { authorizedFixtureClientIds: [], pilot: { clientIds: [cast.X.clientId], operations: ["orders.create"], approvedBy: "info@realtourpilot.com", approvedAt: new Date(PINNED - 3 * DAY).toISOString(), expiresAt: null } });
    const aryeo = await import("@/lib/integrations/aryeo");
    const hx = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: cast.X.clientId, name: cast.X.name }, operation: "orders.create" });
    const hp = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: cast.P.clientId, name: cast.P.name }, operation: "orders.create" });
    out.hub = { x: hx.ok ? `ok ${hx.scope}` : `refused: ${hx.reason}`, p: hp.ok ? `ok ${hp.scope}` : `refused: ${hp.reason}` };
    process.send?.({ drill: { results: out } });
    await drill.stop();
  } catch (e) {
    process.send?.({ drill: { error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e), partial: out } });
  }
  setTimeout(() => process.exit(0), 200);
}

// ============================================================================
// THE NEW PASS.
// ============================================================================

// Counting and fault injection on @/lib/prisma (installed before any app import).
const faults = { client: false };
const reads = new Map<string, number>();
const readsOf = (name: string) => [...reads].filter(([k]) => k.startsWith(`${name}.`)).reduce((a, [, n]) => a + n, 0);
interceptModule(
  (r) => r === "@/lib/prisma",
  (mod) => {
    const m = mod as { prisma: Record<string, unknown> };
    const real = m.prisma;
    const watched = new Set(["client", "appSetting", "programAutomation"]);
    const wrap = (name: string, d: object) =>
      new Proxy(d, {
        get(t, k) {
          const v = Reflect.get(t, k, t);
          if (typeof v !== "function" || typeof k !== "string") return v;
          return (...args: unknown[]) => {
            if (k.startsWith("find") || k === "count") reads.set(`${name}.${k}`, (reads.get(`${name}.${k}`) ?? 0) + 1);
            if (name === "client" && faults.client && k.startsWith("find")) throw new Error("injected client read failure");
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    const proxy = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (typeof k === "string" && watched.has(k) && v && typeof v === "object") return wrap(k, v);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { ...m, prisma: proxy };
  },
);
// A signed-in person for the server actions: resolvePortalViewer reads its
// cookie through a DYNAMIC import of next/headers, which the harness stub does
// not reach, so the resolver is handed this jar instead (cp06's pattern).
const jar = new Map<string, string>();
interceptModule(
  (r) => r === "@/lib/portal",
  (loaded) => {
    const m = loaded as typeof import("@/lib/portal");
    return { ...m, resolvePortalViewer: (i: Parameters<typeof m.resolvePortalViewer>[0]) => m.resolvePortalViewer({ ...i, cookies: i.cookies ?? { get: (n: string) => jar.get(n) } }) };
  },
);
// loadProgramRollout, scriptable for §5(f). (The outbox imports the gate
// LAZILY, and a dynamic import does not pass through the loader hook — so the
// gate is counted by handing a machine a counting gate, §6, not by a hook.)
let rolloutScript: null | { calls: number; after: number; value: string } = null;
interceptModule(
  (r) => r === "@/lib/programRollout",
  (mod) => {
    const m = mod as typeof import("@/lib/programRollout");
    return {
      ...m,
      loadProgramRollout: async () => {
        if (rolloutScript) {
          rolloutScript.calls++;
          if (rolloutScript.calls > rolloutScript.after) {
            const { parseProgramRollout } = await import("@/lib/programRolloutCore");
            return { ...parseProgramRollout(rolloutScript.value), updatedAt: null, updatedBy: "drill-script" };
          }
        }
        return m.loadProgramRollout();
      },
    };
  },
);

async function main(): Promise<void> {
  const drill = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const { buildContentMonth } = await import("./_fixtures/contentMonth");
  const core = await import("@/lib/programRolloutCore");
  const pr = await import("@/lib/programRollout");
  const pa = await import("@/lib/portalAccess");
  const portal = await import("@/lib/portal");
  const outbox = await import("@/lib/outbox");
  const R = await import("@/lib/programReminders");
  const share = await import("@/lib/scriptShare");
  const pm = await import("@/lib/programMessages");
  const rw = await import("@/lib/reviewWindows");
  const { signClientSession, CLIENT_COOKIE } = await import("@/lib/auth/clientSession");
  type Viewer = import("@/lib/portal").PortalViewer;

  const { kyle } = await office(db);
  const cast = await seedCast(db, buildContentMonth);
  const { T, T2, T3, P, X, Y, N, Q } = cast;
  const nameOf = new Map([T, T2, T3, P, X, Y, N].map((f) => [f.clientId, f.name]));
  const ALL_OPS = core.opsForGroups(core.PROGRAM_PILOT_GROUPS.map((g) => g.key));
  const pilotWith = (ids: string[], ops = ALL_OPS, joined: Record<string, string> = { [P.clientId]: T0.toISOString() }): import("@/lib/programRolloutCore").ProgramRollout => ({
    mode: "PILOT",
    modeSince: new Date(PINNED - 5 * DAY).toISOString(),
    pilot: { clientIds: ids, operations: ops, approvedBy: "info@realtourpilot.com", approvedAt: new Date(PINNED - 5 * DAY).toISOString(), expiresAt: new Date(PINNED + 30 * DAY).toISOString(), note: "drill pilot", joinedAt: joined },
  });
  const writeRollout = (value: string) => prisma.appSetting.upsert({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY }, create: { key: core.PROGRAM_ROLLOUT_SETTING_KEY, value, updatedBy: "drill" }, update: { value, updatedBy: "drill" } });
  await writeRollout(core.serializeProgramRollout(pilotWith([P.clientId])));
  const sw = (key: string, enabled: boolean, config: Record<string, unknown> | null = null, at?: Date) => setSwitch(db, key, enabled, config, at);
  const cookieFor = async (userId: string, email: string) => signClientSession({ cu: userId, email });
  const cookieSrc = (cookie: string) => ({ get: (n: string) => (n === CLIENT_COOKIE ? cookie : undefined) });

  // ---- the OLD pass, first, on its own database ------------------------------
  const baseTree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `r03-scope-${BASE}-`)));
  const cleanup = () => fs.rmSync(baseTree, { recursive: true, force: true });
  try {
    execFileSync("/bin/sh", ["-c", `git archive ${BASE} src scripts prisma tsconfig.json package.json | tar -x -C "$0"`, baseTree], { cwd: REPO });
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseTree, "node_modules"));
    fs.copyFileSync(__filename, path.join(baseTree, "scripts/_drill/r03-rollout-scope.ts"));

    // =========================================================================
    c.head(`0 · OLD (${BASE}'s whole tree, its own PGlite on ${OLD_PORT}): where the program reached the excluded client`);
    // =========================================================================
    {
      const child = runDrillChild(drill.url, path.join(baseTree, "scripts/_drill/r03-rollout-scope.ts"), {
        args: [OLD_PASS],
        env: { TSX_TSCONFIG_PATH: path.join(baseTree, "tsconfig.json") },
      });
      const got = await child.waitFor<{ results?: OldResults; error?: string }>((m) => !!m && typeof m === "object" && ("results" in m || "error" in m), 420_000);
      await child.exited;
      if (got.error || !got.results) {
        c.ok(`the ${BASE} pass ran`, false, got.error ?? "no results");
      } else {
        const O = got.results;
        c.ok(`the OLD pass really ran ${BASE}'s tree`, O.tree.startsWith(baseTree), O.tree);
        const dryOf = (n: string) => O.remindersDry.find((r) => r.name === n);
        c.ok("OLD, reminders on with the lock lifted: the dry run says SEND for X and for Y (no seat — the client record's address)", dryOf(X.name)?.decision === "send" && dryOf(Y.name)?.decision === "send", JSON.stringify([dryOf(X.name), dryOf(Y.name)]));
        c.ok("OLD: …and the live run emails X's seat and Y's client address", O.remindersLiveTo.includes("xo@example.test") && O.remindersLiveTo.includes("y@example.test"), O.remindersLiveTo.join(", "));
        c.ok("OLD: the never-synthetic real row renamed TEST (N) is judged as a TEST client by its name (suppressed only for its inbox)", dryOf(N.name)?.decision === "suppressed" && dryOf(N.name)?.reason === "test_client_real_address", JSON.stringify(dryOf(N.name)));
        c.ok("OLD: T2 (nick@) — the dry run says send…", O.t2Dry === "send", O.t2Dry ?? "none");
        c.ok("OLD: …and the live tick THROWS (TestClientSendRefusedError) and aborts", O.t2Live === "threw TestClientSendRefusedError", O.t2Live);
        c.ok("OLD: the office-replied notice mails X's seats (xo@ and Q)", O.noticeTo.includes("xo@example.test") && O.noticeTo.includes("q@example.test"), O.noticeTo.join(", "));
        c.ok("OLD: a staff invitation on X with invitations on sends", O.inviteX.emailed && O.inviteX.to.includes("xnew@example.test"), JSON.stringify(O.inviteX));
        c.ok("OLD: releasing held access grants X and sends its welcome", O.releaseX.granted >= 1 && O.releaseX.to.includes("xx@example.test"), JSON.stringify(O.releaseX));
        c.ok("OLD: Q's sign-in email opens BOTH programs — X is live and Q's session resolves X", O.q.mailed && O.q.live.includes(X.name) && O.q.resolvesX, JSON.stringify(O.q));
        c.ok("OLD: the Aryeo guard writes for X off a per-switch list the program cannot see, and refuses P", O.hub.x === "ok PILOT" && O.hub.p.startsWith("refused"), JSON.stringify(O.hub));
      }
    }
  } finally {
    cleanup();
  }

  // =========================================================================
  c.head("1 · the scope as the server reads it (PILOT: P, all groups, joined Wed 10:00)");
  // =========================================================================
  {
    const m = await pr.programReachMany("reminders", [T.clientId, P.clientId, X.clientId, Y.clientId, N.clientId]);
    const code = (id: string) => { const d = m.get(id); return d?.ok ? `ok ${d.tier}` : d?.code; };
    c.ok("T → TEST, P → PILOT (since = the join), X/Y/N → not_in_pilot", code(T.clientId) === "ok TEST" && code(P.clientId) === "ok PILOT" && code(X.clientId) === "not_in_pilot" && code(Y.clientId) === "not_in_pilot" && code(N.clientId) === "not_in_pilot", [...m.keys()].map((k) => `${nameOf.get(k)}=${code(k)}`).join(" "));
    const dP = m.get(P.clientId);
    c.ok("P's since is its joinedAt", !!dP?.ok && dP.since?.getTime() === T0.getTime(), dP?.ok ? dP.since?.toISOString() : "");
  }

  // =========================================================================
  c.head("2 · immediate actions (portal_invites and portal_login_email on)");
  // =========================================================================
  await sw("portal_invites", true);
  await sw("portal_login_email", true);
  let qCookie = "";
  {
    // invite
    let i = mails.length;
    let refusal = "";
    try { await pa.inviteClientUser(X.enrollmentId, "xnew@example.test", "Xavier New", "COLLABORATOR", null); } catch (e) { refusal = (e as Error).message; }
    c.ok("inviteClientUser(X) throws, naming the rollout", /not in the program rollout/.test(refusal), refusal);
    c.ok("…and writes no person, no seat, no email", !(await prisma.clientUser.findUnique({ where: { email: "xnew@example.test" } })) && mailsSince(i).length === 0);
    const invP = await pa.inviteClientUser(P.enrollmentId, "pat2@example.test", "Pat Two", "COLLABORATOR", null);
    c.ok("inviteClientUser(P) opens a seat and sends ONE invitation", invP.emailed && mailsSince(i).length === 1 && mailsSince(i)[0] === "pat2@example.test", `${invP.note} → ${mailsSince(i).join(",")}`);
    // the name rule: an existing name is never overwritten
    await prisma.clientUser.update({ where: { email: "pat2@example.test" }, data: { name: "Patricia Two" } });
    await pa.inviteClientUser(P.enrollmentId, "pat2@example.test", "Someone Else", "COLLABORATOR", null);
    c.ok("a re-invitation does not overwrite the person's name", (await prisma.clientUser.findUnique({ where: { email: "pat2@example.test" } }))?.name === "Patricia Two");

    // teammate (a staff viewer — the token link cannot manage the team)
    const { inviteTeammate } = await import("@/lib/portalTeam");
    const staffViewer = (f: Fx): Viewer => ({ enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.name, status: "ACTIVE", videosPerMonth: 3, sessionsPerMonth: 1 }, actor: { kind: "STAFF", staffUserId: kyle.id, staffName: "Kyle Drill", staffRole: "ADMIN" }, access: "FULL", via: "STAFF" });
    i = mails.length;
    const tx = await inviteTeammate(staffViewer(X), { name: "Tara Teammate", email: "tara@example.test", role: "OWNER" });
    const owedX = (await pa.owedAccessFor(X.enrollmentId)).find((o) => o.email === "tara@example.test");
    c.ok("inviteTeammate on X → HELD, owed row carries heldBecause not_in_pilot, 0 emails", tx.ok && tx.held === true && owedX?.heldBecause?.code === "not_in_pilot" && mailsSince(i).length === 0, `${tx.message} | ${JSON.stringify(owedX?.heldBecause)}`);
    const tp = await inviteTeammate(staffViewer(P), { name: "Paul Teammate", email: "paul@example.test", role: "OWNER" });
    c.ok("inviteTeammate on P → GRANTED and ONE welcome", tp.ok && !tp.held && mailsSince(i).length === 1 && mailsSince(i)[0] === "paul@example.test", `${tp.message} → ${mailsSince(i).join(",")}`);

    // the Stripe path
    i = mails.length;
    const gx = await pa.grantProgramAccess({ enrollmentId: X.enrollmentId, emailRaw: "xpayer@example.test", name: "X Payer", reason: "welcome", requestedBy: "stripe-signup" });
    c.ok("grantProgramAccess (Stripe) for X → HELD, no person created, no email", gx.outcome === "HELD" && !(await prisma.clientUser.findUnique({ where: { email: "xpayer@example.test" } })) && mailsSince(i).length === 0, gx.note);

    // sign-in link for Q (seats on P and X)
    i = mails.length;
    await pa.requestLoginLink(Q.email);
    const qMails = mails.slice(i).filter((m) => m.to === Q.email);
    c.ok("requestLoginLink(Q) sends ONE email", qMails.length === 1, `${mailsSince(i).join(",")}`);
    const qRow = await prisma.outboxMessage.findFirst({ where: { toRef: Q.email, dedupeKey: { startsWith: "portal_login:" } }, orderBy: { createdAt: "desc" } });
    c.ok("…its outbox row carries the EARNING seat's client (P), so the TEST floor and the gate see whose it is", qRow?.clientId === P.clientId, qRow?.clientId ?? "none");
    c.ok("…and the body names no client", qMails.length === 1 && !/Xena|Pat Pilot/.test(qMails[0].body));
    const raw = qMails[0] ? tokenIn(qMails[0].body) : null;
    const consumed = raw ? await pa.consumeLoginToken(raw) : null;
    const [sP, sX] = await Promise.all([prisma.clientMembership.findUnique({ where: { id: Q.seatP } }), prisma.clientMembership.findUnique({ where: { id: Q.seatX } })]);
    c.ok("consumeLoginToken accepts P's seat only", !!consumed?.ok && !!sP?.acceptedAt && !sX?.acceptedAt, `P=${sP?.acceptedAt?.toISOString()} X=${sX?.acceptedAt?.toISOString() ?? "null"}`);
    qCookie = await cookieFor(Q.id, Q.email);
    const rX = await portal.resolvePortalViewer({ cookies: cookieSrc(qCookie), enrollmentId: X.enrollmentId });
    const rP = await portal.resolvePortalViewer({ cookies: cookieSrc(qCookie), enrollmentId: P.enrollmentId });
    c.ok("resolvePortalViewer(Q's cookie, X) → no_membership; (…, P) → ok", !rX.ok && rX.reason === "no_membership" && rP.ok, `${rX.ok ? "ok" : rX.reason} / ${rP.ok ? "ok" : rP.reason}`);
    const liveQ = await portal.liveMemberships(Q.id);
    c.ok("liveMemberships(Q) = [P]", liveQ.length === 1 && liveQ[0].clientId === P.clientId, liveQ.map((s) => s.clientName).join(","));

    // a person seated only on X
    i = mails.length;
    const obBefore = await prisma.outboxMessage.count();
    await pa.requestLoginLink("xo@example.test");
    const xoUser = await prisma.clientUser.findUnique({ where: { email: "xo@example.test" } });
    const counter = xoUser ? await prisma.appSetting.findUnique({ where: { key: `portal-login-requested:${xoUser.id}` } }) : null;
    c.ok("a person seated only on X: no email, no outbox row, the request counter written", mailsSince(i).length === 0 && (await prisma.outboxMessage.count()) === obBefore && !!counter, counter?.value ?? "no counter");

    // minted links
    let mintX = "";
    try { await pa.mintLoginLink(X.membershipId!, null); } catch (e) { mintX = (e as Error).message; }
    const mintT = await pa.mintLoginLink(T.membershipId!, null).then(() => "ok").catch((e: Error) => e.message);
    const mintP = await pa.mintLoginLink(P.membershipId!, null).then(() => "ok").catch((e: Error) => e.message);
    c.ok("mintLoginLink: X's seat refused; T's and P's minted", /not in the program rollout/.test(mintX) && mintT === "ok" && mintP === "ok", `${mintX} | ${mintT} | ${mintP}`);
    c.ok("portalLoginEmailEnabledFor: P yes, X no, T yes", (await pa.portalLoginEmailEnabledFor(P.clientId)) && !(await pa.portalLoginEmailEnabledFor(X.clientId)) && (await pa.portalLoginEmailEnabledFor(T.clientId)));
  }

  const countAllRows = async () => {
    const tables = await drill.sql<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
    const out = new Map<string, number>();
    for (const t of tables) out.set(t.table_name, Number((await drill.sql<{ n: string }>(`select count(*)::text as n from "${t.table_name}"`))[0]?.n ?? 0));
    return out;
  };
  const diffRows = (a: Map<string, number>, b: Map<string, number>) => [...a].filter(([k, n]) => b.get(k) !== n).map(([k, n]) => `${k}:${n}→${b.get(k)}`);

  // =========================================================================
  c.head("3 · held access: preview == release, only the pilot is granted");
  // =========================================================================
  {
    await sw("portal_invites", false);
    const hp = await pa.grantProgramAccess({ enrollmentId: P.enrollmentId, emailRaw: "pp@example.test", name: "Pat Payer", reason: "welcome" });
    const hx = await pa.grantProgramAccess({ enrollmentId: X.enrollmentId, emailRaw: "xx@example.test", name: "Xander Paid", reason: "welcome" });
    c.ok("with invitations off, both are HELD (switched_off)", hp.outcome === "HELD" && hx.outcome === "HELD");
    await sw("portal_invites", true);
    const rowsBefore = await countAllRows();
    const preview = await pa.previewHeldAccessRelease();
    c.ok("§9: the held-access preview wrote nothing", diffRows(rowsBefore, await countAllRows()).length === 0, diffRows(rowsBefore, await countAllRows()).join(" "));
    const grantP = preview.grant.filter((g) => g.clientId === P.clientId);
    const stayX = preview.stay.filter((g) => g.clientId === X.clientId);
    c.ok("preview: grant = [P's payer]; every X row stays, not_in_pilot", preview.switchOn && preview.grant.length === 1 && grantP.length === 1 && stayX.length === preview.stay.length && stayX.length >= 2 && stayX.every((s) => s.code === "not_in_pilot"), `grant=${preview.grant.map((g) => `${g.clientName}:${g.email}`).join(",")} stay=${preview.stay.map((s) => `${s.clientName}:${s.code}`).join(",")}`);
    c.ok("…addresses are masked in the preview", preview.grant.every((g) => g.email.includes("…")));
    const i = mails.length;
    const r = await pa.releasePendingProgramAccess("drill-owner");
    c.ok("release grants P with ONE welcome; X stays held", r.granted === 1 && mailsSince(i).length === 1 && mailsSince(i)[0] === "pp@example.test" && r.held === stayX.length, JSON.stringify({ ...r, to: mailsSince(i) }));
    const stillX = await pa.owedAccessFor(X.enrollmentId);
    c.ok("…X's debts are still on file with the reason", stillX.length === stayX.length && stillX.every((o) => o.heldBecause?.code === "not_in_pilot"));
    const j = mails.length;
    const again = await pa.releasePendingProgramAccess("drill-owner");
    c.ok("a second release sends nothing new", again.granted === 0 && mailsSince(j).length === 0, JSON.stringify(again));
  }

  // =========================================================================
  c.head("4 · the hourly sweeps — every switch on, every lock lifted");
  // =========================================================================
  await sw("reminders", true, { testClientsOnly: false });
  await sw("script_share_email", true);
  await sw("program_message_notice", true);
  await sw("revision_policy", true, null, new Date(PINNED - 10 * DAY));
  await sw("review_auto_approve", true, { testClientsOnly: false }, new Date(PINNED - 10 * DAY));
  await sw("topic_carryover", true);
  await sw("script_auto_share", true, { testClientsOnly: false, holdMinutes: 0 });
  // Aryeo's session feed fresh for the address lane on Monday.
  await prisma.connection.upsert({ where: { provider: "aryeo" }, create: { provider: "aryeo", status: "CONNECTED", lastSyncedAt: new Date(MON.getTime() - HOUR) }, update: { status: "CONNECTED", lastSyncedAt: new Date(MON.getTime() - HOUR), lastError: null } });


  let dryPairs: string[] = [];
  let livePairs: string[] = [];
  {
    // ---- reminders, the planning lane (Fri Oct 2) ----------------------------
    const before = await countAllRows();
    const dry = await R.evaluateReminders({ dryRun: true, now: NOW });
    c.ok("§9: the reminders dry run wrote nothing", diffRows(before, await countAllRows()).length === 0, diffRows(before, await countAllRows()).join(" "));
    const cand = (f: Fx) => dry.candidates.find((x) => x.clientId === f.clientId && x.lane === "PRIMARY");
    const sends = dry.candidates.filter((x) => x.decision === "send");
    c.ok("dry run: T, T3 and P would be sent — nobody else", new Set(sends.map((x) => x.clientId)).size === 3 && [T, T3, P].every((f) => cand(f)?.decision === "send"), sends.map((x) => nameOf.get(x.clientId)).join(", "));
    c.ok("…X, Y and N suppressed not_in_rollout_scope", [X, Y, N].every((f) => cand(f)?.decision === "suppressed" && cand(f)?.suppressionReason === "not_in_rollout_scope"), [X, Y, N].map((f) => `${f.name}:${cand(f)?.suppressionReason}`).join(" "));
    c.ok("…each still shows who it WOULD have reached (masked): X's seat, Y's client address", cand(X)?.to === outbox.maskToRef("email", "xo@example.test") && cand(Y)?.to === outbox.maskToRef("email", "y@example.test"), `${cand(X)?.to} ${cand(Y)?.to}`);
    c.ok("…and the audience: T TEST, P PILOT, X not_in_pilot, N not_in_pilot (a real row, whatever its name)", cand(T)?.audience.tier === "TEST" && cand(P)?.audience.tier === "PILOT" && cand(X)?.audience.code === "not_in_pilot" && cand(N)?.audience.code === "not_in_pilot");
    c.ok("§8: T2 (nick@) suppressed test_client_real_address in the dry run", cand(T2)?.decision === "suppressed" && cand(T2)?.suppressionReason === "test_client_real_address", `${cand(T2)?.decision} ${cand(T2)?.suppressionReason}`);
    dryPairs = sends.map((x) => `${x.clientId}|${x.to}`).sort();

    const i = mails.length;
    let threw = "";
    const live = await R.evaluateReminders({ dryRun: false, now: NOW }).catch((e: Error) => { threw = `${e.name}: ${e.message}`; return null; });
    c.ok("§8: the live tick COMPLETES (no TestClientSendRefusedError abort)", !threw && !!live, threw);
    const to = mailsSince(i).sort();
    c.ok("live: exactly T, T3 and P were emailed", JSON.stringify(to) === JSON.stringify(["bobmike0214@gmail.com", "info+rt@realtourpilot.com", "pat@example.test"]), to.join(", "));
    const acc = await prisma.outboxMessage.findMany({ where: { dedupeKey: { startsWith: "program_reminder:" }, state: "accepted" }, select: { clientId: true, toRef: true } });
    livePairs = acc.map((r) => `${r.clientId}|${outbox.maskToRef("email", r.toRef)}`).sort();
    c.ok("§9: dry run == dispatch — the {client, masked to} pairs marked send are exactly what went out", JSON.stringify(dryPairs) === JSON.stringify(livePairs), `${dryPairs.join(" ")} vs ${livePairs.join(" ")}`);
    c.ok("X, Y, N got 0 reminder emails and no ledger row", (await prisma.programReminder.count({ where: { clientId: { in: [X.clientId, Y.clientId, N.clientId] } } })) === 0);

    // ---- the ADDRESS lane (Mon Oct 5, sessions Wed Oct 7 with no street) -----
    const addSessionMonth = async (f: Fx) => {
      const month = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-11", videosOwed: 3, status: "OPEN", planningMode: "WRITTEN" } });
      const project = await prisma.project.create({ data: { clientId: f.clientId, title: `${f.name} — Nov content`, status: "SCHEDULED", contentMonthId: month.id, packageName: "Video Starter", shootDate: WED_SESSION, city: "West Chester", state: "PA" } });
      await prisma.appointment.create({ data: { projectId: project.id, aryeoId: `drill-${f.clientId}-nov`, startAt: WED_SESSION, endAt: new Date(WED_SESSION.getTime() + 2 * HOUR), durationMin: 120, status: "SCHEDULED", title: "Content session" } });
      return month.id;
    };
    await addSessionMonth(P);
    await addSessionMonth(X);
    const dryMon = await R.evaluateReminders({ dryRun: true, now: MON });
    const addr = (f: Fx) => dryMon.addressLane.find((a) => a.enrollmentId === f.enrollmentId);
    c.ok("address lane dry run (Mon): P send, X suppressed not_in_rollout_scope with its recipient shown", addr(P)?.decision === "send" && addr(X)?.decision === "suppressed" && addr(X)?.suppressionReason === "not_in_rollout_scope" && addr(X)?.to === outbox.maskToRef("email", "xo@example.test"), `${addr(P)?.decision}/${addr(P)?.reason} | ${addr(X)?.decision}/${addr(X)?.suppressionReason}/${addr(X)?.to}`);
    const j = mails.length;
    await R.evaluateReminders({ dryRun: false, now: MON });
    c.ok("address lane live: only P's seat is asked for the address", JSON.stringify(mailsSince(j)) === JSON.stringify(["pat@example.test"]), mailsSince(j).join(", "));

    // ---- share notices (STRATEGY_READY) --------------------------------------
    const strategyFor = async (f: Fx) => {
      const s = await prisma.contentStrategy.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, sectionsJson: "{}" } });
      const v = await prisma.contentStrategyVersion.create({ data: { strategyId: s.id, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: 1, sectionsJson: "{}", sourceKind: "manual", status: "APPROVED", approvedAt: new Date(PINNED - DAY), releasedAt: new Date(PINNED - DAY) } });
      await prisma.contentStrategy.update({ where: { id: s.id }, data: { approvedVersionId: v.id, currentVersionId: v.id } });
      return v.id;
    };
    const notice = async (f: Fx, state: "PENDING" | "FAILED", svId: string) =>
      prisma.programReminder.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, action: "STRATEGY_READY", templateKey: "strategy_ready.v2", channel: "email", attempt: 1, state, nextEligibleAt: new Date(PINNED - HOUR), ...(state === "FAILED" ? { nextAttemptAt: new Date(PINNED - HOUR) } : {}), dedupeKey: `${f.enrollmentId}:strategy:${svId}:STRATEGY_READY:${state}`, evaluatedStateJson: JSON.stringify({ strategyVersionId: svId }) } });
    const svT = await strategyFor(T), svP = await strategyFor(P), svX = await strategyFor(X);
    const nT = await notice(T, "PENDING", svT), nP = await notice(P, "PENDING", svP), nX = await notice(X, "PENDING", svX), nXf = await notice(X, "FAILED", svX);
    const before2 = await countAllRows();
    const dryShare = await share.drainShareNotices({ now: NOW, dryRun: true, max: 20 });
    c.ok("§9: the share-notice dry run wrote nothing", diffRows(before2, await countAllRows()).length === 0, diffRows(before2, await countAllRows()).join(" "));
    const pv = (id: string) => dryShare.preview.find((p) => p.reminderId === id);
    c.ok("share dry run: T and P send; X (pending AND failed) suppress not_in_rollout_scope, recipient shown", pv(nT.id)?.decision === "send" && pv(nP.id)?.decision === "send" && pv(nX.id)?.decision === "suppress" && pv(nXf.id)?.decision === "suppress" && /not_in_rollout_scope/.test(pv(nX.id)?.reason ?? "") && pv(nX.id)?.to === outbox.maskToRef("email", "xo@example.test"), dryShare.preview.map((p) => `${nameOf.get(p.clientId)}:${p.decision}`).join(" "));
    const k = mails.length;
    const liveShare = await share.drainShareNotices({ now: NOW, max: 20 });
    c.ok("share live: T and P emailed, X nothing", JSON.stringify(mailsSince(k).sort()) === JSON.stringify(["info+rt@realtourpilot.com", "pat@example.test"]), `${mailsSince(k).join(",")} ${liveShare.notes.join(" | ")}`);
    const xRows = await prisma.programReminder.findMany({ where: { id: { in: [nX.id, nXf.id] } } });
    c.ok("…both X notices SUPPRESSED not_in_rollout_scope", xRows.every((r) => r.state === "SUPPRESSED" && r.suppressionReason === "not_in_rollout_scope"), xRows.map((r) => `${r.state}/${r.suppressionReason}`).join(" "));

    // ---- the office replied ----------------------------------------------------
    await prisma.programMessage.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, authorKind: "STAFF", authorLabel: "Kyle Drill", body: "Before you joined.", createdAt: new Date(T0.getTime() - 12 * HOUR) } });
    const rowsBeforeMsg = await countAllRows();
    const dryMsg0 = await pm.sweepProgramMessageNotices({ now: NOW, dryRun: true });
    c.ok("§9: the office-replied dry run wrote nothing", diffRows(rowsBeforeMsg, await countAllRows()).length === 0, diffRows(rowsBeforeMsg, await countAllRows()).join(" "));
    let m = mails.length;
    await pm.sweepProgramMessageNotices({ now: NOW });
    c.ok("a reply written BEFORE P joined is not emailed (the 3-day lookback is not a backlog)", mailsSince(m).length === 0 && dryMsg0.preview.filter((r) => r.clientId === P.clientId).every((r) => r.decision === "skip" && /before this client joined/.test(r.reason)), dryMsg0.preview.map((r) => `${nameOf.get(r.clientId)}:${r.decision}:${r.reason}`).join(" | "));
    // the immediate path, for X and for P
    m = mails.length;
    await pm.postStaffMessage(X.enrollmentId, { id: kyle.id, name: "Kyle Drill", email: "kyle@realtourpilot.com" }, "Your October session is booked.", null, { now: NOW });
    c.ok("postStaffMessage on X (the immediate path): no email to any X seat", mailsSince(m).length === 0, mailsSince(m).join(","));
    const dryMsg = await pm.sweepProgramMessageNotices({ now: NOW, dryRun: true });
    await pm.postStaffMessage(P.enrollmentId, { id: kyle.id, name: "Kyle Drill", email: "kyle@realtourpilot.com" }, "Your October session is booked.", null, { now: NOW });
    const pTo = mailsSince(m).sort();
    const pSeats = await prisma.clientMembership.findMany({ where: { enrollmentId: P.enrollmentId, revokedAt: null, role: { in: ["OWNER", "COLLABORATOR"] } }, select: { clientUserId: true } });
    const pWant = (await prisma.clientUser.findMany({ where: { id: { in: pSeats.map((x) => x.clientUserId) } }, select: { email: true } })).map((u) => u.email).sort();
    c.ok("postStaffMessage on P after the join: every P seat is emailed (Q included) — and only P's", JSON.stringify(pTo) === JSON.stringify(pWant) && pTo.includes("q@example.test") && !pTo.includes("xo@example.test"), `${pTo.join(", ")} vs ${pWant.join(", ")}`);
    c.ok("§9: the message dry run for X said skip (not in the rollout) with the seat shown", dryMsg.preview.filter((r) => r.clientId === X.clientId).length >= 1 && dryMsg.preview.filter((r) => r.clientId === X.clientId).every((r) => r.decision === "skip" && r.audience.code === "not_in_pilot" && !!r.to));

    // ---- auto-share eligibility -------------------------------------------------
    const draft = async (f: Fx, createdAt: Date, strategyVersionId: string) => {
      const topic = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, monthId: f.monthId } });
      const s = await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, title: `${f.name} draft ${createdAt.toISOString()}`, body: "b", topicId: topic.id, monthId: f.monthId } });
      const v = await prisma.contentScriptVersion.create({ data: { scriptId: s.id, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: 1, title: "Draft", hook: "h", pointsJson: "[]", close: "c", body: "b", source: "AI", createdBy: "cron", aiRunId: "drill-run", validationJson: JSON.stringify({ findings: [] }), strategyVersionId, status: "DRAFT", createdAt } });
      await prisma.contentScript.update({ where: { id: s.id }, data: { currentVersionId: v.id } });
      return v.id;
    };
    const { autoShareEligible, sweepAutoShare } = await import("@/lib/scriptAutoShare");
    const vPold = await draft(P, new Date(T0.getTime() - DAY), svP);
    const vPnew = await draft(P, new Date(T0.getTime() + HOUR), svP);
    const vX = await draft(X, new Date(T0.getTime() + HOUR), svX);
    const cfg = { testClientsOnly: false, holdMinutes: 0 };
    const [ePold, ePnew, eX] = await Promise.all([vPold, vPnew, vX].map((id) => autoShareEligible(id, { now: NOW, config: cfg })));
    c.ok("auto-share: X refused as not in the program rollout", eX.reasons.some((r) => /not in the program rollout/.test(r)), eX.reasons.join("; "));
    c.ok("auto-share: P's draft from BEFORE the join waits ('drafted before this client joined the rollout')", ePold.reasons.includes("drafted before this client joined the rollout"), ePold.reasons.join("; "));
    c.ok("auto-share: P's draft from after the join carries neither scope reason", !ePnew.reasons.some((r) => /rollout/.test(r)), ePnew.reasons.join("; "));
    const before3 = await countAllRows();
    const dryAuto = await sweepAutoShare({ now: NOW, dryRun: true });
    c.ok("§9: the auto-share dry run wrote nothing, and never looked at X's draft", diffRows(before3, await countAllRows()).length === 0 && "outcomes" in dryAuto && !dryAuto.outcomes.some((o) => o.versionId === vX), "outcomes" in dryAuto ? dryAuto.outcomes.map((o) => o.versionId === vX ? "X" : o.versionId === vPold ? "Pold" : o.versionId === vPnew ? "Pnew" : "?").join(",") : dryAuto.skipped);

    // ---- carry-over ---------------------------------------------------------------
    const pastTopic = async (f: Fx, scriptedAt: Date, title: string) => {
      const month = (await prisma.contentMonth.findFirst({ where: { enrollmentId: f.enrollmentId, monthKey: "2026-09" } })) ?? (await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-09", videosOwed: 3, status: "OPEN" } }));
      const t = await prisma.contentTopic.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: month.id, title, source: "staff", status: "SCRIPTED" } });
      await prisma.contentTopicSelection.create({ data: { topicId: t.id, monthId: month.id, enrollmentId: f.enrollmentId, clientId: f.clientId, status: "SELECTED", source: "staff", rank: 1 } });
      await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, title, body: "b", topicId: t.id, monthId: month.id, status: "APPROVED", createdAt: scriptedAt } });
      return t.id;
    };
    const tPold = await pastTopic(P, new Date(T0.getTime() - 3 * DAY), "P scripted before joining");
    const tPnew = await pastTopic(P, new Date(T0.getTime() + HOUR), "P scripted after joining");
    const tX = await pastTopic(X, new Date(T0.getTime() + HOUR), "X scripted");
    const { sweepCarryover } = await import("@/lib/contentTopics");
    const carry = await sweepCarryover({ now: NOW });
    const carriedInto = async (topicId: string, f: Fx) => (await prisma.contentTopicSelection.findFirst({ where: { topicId, monthId: f.monthId } })) !== null;
    c.ok("carry-over: X's topic is not carried (outside the rollout)", !(await carriedInto(tX, X)) && "outOfScope" in carry && carry.outOfScope >= 3, JSON.stringify(carry));
    c.ok("carry-over: P's topic scripted BEFORE the join stays where it was", !(await carriedInto(tPold, P)));
    c.ok("carry-over: P's topic scripted after the join is carried into October", await carriedInto(tPnew, P), JSON.stringify(carry));

    // ---- review windows --------------------------------------------------------------
    const windowFor = async (f: Fx, openedAt: Date, tag: string) => {
      const sub = await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, round: 1, fileName: `${tag}.mp4`, status: "APPROVED", decidedAt: openedAt, source: "upload" } });
      return prisma.contentReviewWindow.create({ data: { submissionId: sub.id, videoKey: `${f.projectId}:${tag}`, projectId: f.projectId!, enrollmentId: f.enrollmentId, clientId: f.clientId, round: 1, openedAt, deadlineAt: new Date(PINNED - HOUR), source: "RELEASE", businessDays: 4, state: "OPEN" } });
    };
    const wPold = await windowFor(P, new Date(T0.getTime() - DAY), "p-old");
    const wPnew = await windowFor(P, new Date(T0.getTime() + HOUR), "p-new");
    const wX = await windowFor(X, new Date(T0.getTime() + HOUR), "x");
    const wT = await windowFor(T, new Date(T0.getTime() + HOUR), "t");
    const sweep = await rw.sweepReviewWindows({ now: NOW, max: 25 });
    const [aPold, aPnew, aX, aT] = await Promise.all([wPold, wPnew, wX, wT].map((w) => prisma.contentReviewWindow.findUniqueOrThrow({ where: { id: w.id } })));
    c.ok("review: P's window opened BEFORE the join settles NOT_HELD_BEFORE_SCOPE, once, with no task", aPold.expiryOutcome === "NOT_HELD_BEFORE_SCOPE" && aPold.state === "OPEN" && !aPold.expiryTaskId, `${aPold.expiryOutcome}`);
    c.ok("review: P's window opened after the join is held and processed (never NOT_IN_ROLLOUT)", !!aPnew.expiryOutcome && aPnew.expiryOutcome !== "NOT_HELD_BEFORE_SCOPE" && !/NOT_IN_ROLLOUT/.test(aPnew.expiryOutcome ?? ""), aPnew.expiryOutcome ?? "null");
    c.ok("review: X's window is never touched — no outcome, no approval, no task", aX.expiryOutcome === null && aX.state === "OPEN" && (await prisma.clientDecision.count({ where: { enrollmentId: X.enrollmentId } })) === 0, `${aX.expiryOutcome} ${aX.state}`);
    c.ok("review: T's window is processed", !!aT.expiryOutcome, `${aT.expiryOutcome} ${JSON.stringify(sweep)}`);
    const viewerX: Viewer = { enrollment: { id: X.enrollmentId, clientId: X.clientId, clientName: X.name, status: "ACTIVE", videosPerMonth: 3, sessionsPerMonth: 1 }, actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN" };
    const viewerP: Viewer = { ...viewerX, enrollment: { ...viewerX.enrollment, id: P.enrollmentId, clientId: P.clientId, clientName: P.name } };
    c.ok("reviewPanelFor on X's viewer → null (today's page)", (await rw.reviewPanelFor(viewerX, wX.submissionId, NOW)) === null);
    const panelOld = await rw.reviewPanelFor(viewerP, wPold.submissionId, NOW);
    const panelNew = await rw.reviewPanelFor(viewerP, wPnew.submissionId, NOW);
    c.ok("P: a deadline is shown only on the window opened after the join", !!panelOld && panelOld.deadlineISO === null && !!panelNew?.deadlineISO, `old=${panelOld?.deadlineISO} new=${panelNew?.deadlineISO}`);
    const polX = await rw.revisionPolicyFor(X.clientId, NOW);
    const polP = await rw.revisionPolicyFor(P.clientId, NOW);
    c.ok("revisionPolicyFor: X off; P on from its join (the later of the switch and the join)", !polX.on && polP.on && polP.enabledAt?.getTime() === T0.getTime(), `X=${polX.on} P=${polP.on}@${polP.enabledAt?.toISOString()}`);
  }

  // =========================================================================
  c.head("5 · P taken out of the pilot — work already queued stops");
  // =========================================================================
  {
    // (f) FIRST, while P is still in: a removal landing between the run's read
    // and the dispatch's fresh read. The script makes every read after the
    // run's first return the removed scope.
    const removed = core.serializeProgramRollout({ ...pilotWith([]), pilot: null, mode: "PILOT" });
    rolloutScript = { calls: 0, after: 1, value: removed };
    const i0 = mails.length;
    const runF = await R.evaluateReminders({ dryRun: false, now: WED_FOLLOWUP, enrollmentIds: [P.enrollmentId] });
    rolloutScript = null;
    const sentF = runF.sent.find((s) => s.outcome === "suppressed" && /not_in_rollout_scope/.test(s.detail));
    c.ok("(f) removal between evaluation and dispatch: the run decided send, the fresh recheck suppressed it, nothing went", runF.candidates.some((x) => x.clientId === P.clientId && x.decision === "send") && !!sentF && mailsSince(i0).length === 0, `${runF.sent.map((s) => `${s.outcome}:${s.detail}`).join(" | ")}`);

    // Seed the queued work BEFORE the removal.
    const rid = (await prisma.programReminder.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, monthId: P.monthId, monthKey: "2026-10", action: "COMPLETE_ANSWERS", templateKey: "drill", channel: "email", attempt: 2, state: "QUEUED", toRef: "pat@example.test", dedupeKey: `${P.enrollmentId}:2026-10:COMPLETE_ANSWERS:drill-q` } })).id;
    const queued = await prisma.outboxMessage.create({ data: { channel: "email", toRef: "pat@example.test", body: "queued reminder", dedupeKey: outbox.programReminderKey("COMPLETE_ANSWERS", rid, "2026-10"), clientId: P.clientId, state: "pending", requestedBy: "reminders-cron", createdAt: new Date(PINNED - 20 * 60_000) } });
    await prisma.programReminder.update({ where: { id: rid }, data: { outboxMessageId: queued.id } });
    const failedRid = (await prisma.programReminder.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, monthId: P.monthId, monthKey: "2026-10", action: "COMPLETE_ANSWERS", templateKey: "drill", channel: "email", attempt: 3, state: "FAILED", toRef: "pat@example.test", nextAttemptAt: new Date(PINNED - HOUR), lastError: "provider refused", dedupeKey: `${P.enrollmentId}:2026-10:COMPLETE_ANSWERS:drill-f` } })).id;
    const young = await prisma.outboxMessage.create({ data: { channel: "email", toRef: "pat@example.test", body: "a dead worker's reminder", dedupeKey: "program_reminder:COMPLETE_ANSWERS:dead-worker:2026-10", clientId: P.clientId, state: "pending", requestedBy: "reminders-cron", createdAt: new Date() } });
    const unknownRow = await prisma.outboxMessage.create({ data: { channel: "email", toRef: "pat@example.test", body: "an unconfirmed reminder", dedupeKey: "program_reminder:COMPLETE_ANSWERS:unknown-row:2026-10", clientId: P.clientId, state: "unknown", attempts: 1, requestedBy: "reminders-cron", providerError: "timeout" } });
    // (d)'s pending SCRIPTS_READY notice, with a release row pointing at it
    const script = await prisma.contentScript.findFirstOrThrow({ where: { enrollmentId: P.enrollmentId, currentVersionId: { not: null } } });
    const pend = await prisma.programReminder.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, monthId: P.monthId, monthKey: "2026-10", action: "SCRIPTS_READY", templateKey: "scripts_ready.v1", channel: "email", attempt: 1, state: "PENDING", nextEligibleAt: new Date(PINNED - HOUR), dedupeKey: `${P.enrollmentId}:SCRIPTS_READY:drill` } });
    const rel = await prisma.contentScriptRelease.create({ data: { scriptId: script.id, scriptVersionId: script.currentVersionId!, enrollmentId: P.enrollmentId, clientId: P.clientId, action: "SHARE", reminderId: pend.id, notificationState: "QUEUED", releasedAt: new Date(PINNED - 2 * HOUR) } });

    // (g') a seat media token minted while P is in the pilot (the page mints
    // one per cut; it lives six hours).
    const media = await import("@/lib/portalMedia");
    const cutP5 = await prisma.reviewSubmission.create({ data: { projectId: P.projectId!, round: 1, fileName: "p-media.mp4", status: "APPROVED", decidedAt: new Date(), source: "upload" } });
    const seatScope = { kind: "membership" as const, id: Q.seatP };
    const mTok = media.mediaToken(cutP5.id, seatScope);
    const streamRoute = await import("@/app/api/review/cut/[id]/stream/route");
    const { NextRequest: NR } = await import("next/server");
    const streamWithToken = async () => {
      process.env.AUTH_ENFORCE = "true";
      try { return (await streamRoute.GET(new NR(`http://127.0.0.1/api/review/cut/${cutP5.id}/stream?m=${encodeURIComponent(mTok)}`), { params: Promise.resolve({ id: cutP5.id }) })).status; }
      finally { delete process.env.AUTH_ENFORCE; }
    };
    const liveBefore = await media.mediaScopeLive(seatScope, new Date());
    const statusBefore = await streamWithToken();
    c.ok("(g') a seat media token for P's cut, P in the pilot: live, and the stream door admits it (not 403)", liveBefore && statusBefore !== 403, String(statusBefore));

    // THE REMOVAL: one audited write through the one writer.
    const auditBefore = await prisma.auditLog.count({ where: { target: "program-rollout" } });
    const upd = await pr.updateProgramRollout((cur) => ({ ...cur, pilot: cur.pilot ? { ...cur.pilot, clientIds: cur.pilot.clientIds.filter((id) => id !== P.clientId) } : null }), "info@realtourpilot.com", "program_pilot_remove");
    c.ok("P removed in ONE write, audited", upd.ok && (await prisma.auditLog.count({ where: { target: "program-rollout" } })) === auditBefore + 1, upd.ok ? "" : upd.message);
    const dP = await pr.programReach("reminders", P.clientId);
    c.ok("…and the very next decision refuses P", !dP.ok && dP.code === "not_in_pilot");

    // (a) the drain
    let i = mails.length;
    const drained = await outbox.drainPending({ workerId: "drill-drain", limit: 10, maxAgeMs: 15 * 60_000 });
    const youngAfter = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: young.id } });
    c.ok("(a) a young pending reminder a dead worker left: drained → refused before send, refused = 1, identity released, 0 Gmail calls", drained.refused === 1 && drained.failed === 0 && youngAfter.state === "failed" && youngAfter.dedupeKey === null && youngAfter.attempts === 0 && /^refused before send: /.test(youngAfter.providerError ?? "") && mailsSince(i).length === 0, JSON.stringify(drained) + " " + youngAfter.providerError);
    // (b) Retry on an unknown
    i = mails.length;
    const retried = await outbox.retryUnknownSend(unknownRow.id, "drill-admin");
    c.ok("(b) Retry on an unconfirmed reminder → 'Not sent', 0 Gmail calls", !retried.ok && /^Not sent: /.test(retried.message) && mailsSince(i).length === 0, retried.message);
    // (c) + (e) the reconcile pass
    const tasksBefore = await prisma.smartTask.count();
    const rec = await R.reconcileReminderOutcomes({ now: NOW });
    const [fr, qr, qo] = await Promise.all([prisma.programReminder.findUniqueOrThrow({ where: { id: failedRid } }), prisma.programReminder.findUniqueOrThrow({ where: { id: rid } }), prisma.outboxMessage.findUniqueOrThrow({ where: { id: queued.id } })]);
    c.ok("(c) a FAILED reminder past its retry → SUPPRESSED not_in_rollout_scope, no retry clock", fr.state === "SUPPRESSED" && fr.suppressionReason === "not_in_rollout_scope" && !fr.nextAttemptAt, `${fr.state} ${fr.suppressionReason}`);
    c.ok("(e) a QUEUED reminder with a pending outbox row → CANCELLED not_in_rollout_scope, the outbox row failed", qr.state === "CANCELLED" && qr.suppressionReason === "not_in_rollout_scope" && qo.state === "failed", `${qr.state}/${qr.suppressionReason} outbox=${qo.state}`);
    c.ok("…and no escalation task was raised for either", (await prisma.smartTask.count()) === tasksBefore, `${JSON.stringify(rec)}`);
    i = mails.length;
    await R.evaluateReminders({ dryRun: false, now: new Date(PINNED + HOUR) });
    c.ok("(c) …the evaluator makes no 4th attempt", (await prisma.programReminder.findUniqueOrThrow({ where: { id: failedRid } })).state === "SUPPRESSED" && !mailsSince(i).includes("pat@example.test"), mailsSince(i).join(","));
    // (d) the pending notice
    i = mails.length;
    await share.drainShareNotices({ now: NOW, max: 20 });
    const [pendAfter, relAfter] = await Promise.all([prisma.programReminder.findUniqueOrThrow({ where: { id: pend.id } }), prisma.contentScriptRelease.findUniqueOrThrow({ where: { id: rel.id } })]);
    c.ok("(d) a PENDING scripts-ready notice → SUPPRESSED, and the release says why", pendAfter.state === "SUPPRESSED" && pendAfter.suppressionReason === "not_in_rollout_scope" && relAfter.notificationState === "SUPPRESSED" && /not in the program pilot/.test(relAfter.note ?? "") && mailsSince(i).length === 0, `${pendAfter.state} | ${relAfter.note}`);
    // (g) sessions
    const rPq = await portal.resolvePortalViewer({ cookies: cookieSrc(qCookie), enrollmentId: P.enrollmentId });
    const rTok = await portal.resolvePortalViewer({ token: P.portalToken!, cookies: { get: () => undefined } });
    c.ok("(g) Q's cookie session on P → no_membership, while P's token link still renders", !rPq.ok && rPq.reason === "no_membership" && rTok.ok, `${rPq.ok ? "ok" : rPq.reason} / token ${rTok.ok ? "ok" : rTok.reason}`);
    // REVIEW FIX (Sep 28): the SAME six-hour token, the next Range request.
    const liveAfter = await media.mediaScopeLive(seatScope, new Date());
    const statusAfter = await streamWithToken();
    c.ok("(g') REVIEW FIX: that seat token is dead at once — mediaScopeLive false and the stream door answers 403 (it kept streaming for up to 6 h)", !liveAfter && statusAfter === 403, `${liveAfter} ${statusAfter}`);
    // (h) the Aryeo guard, with a per-switch pilot still naming P
    await sw("session_booking", true, { authorizedFixtureClientIds: [], pilot: { clientIds: [P.clientId], operations: ["orders.create", "appointments.store"], approvedBy: "info@realtourpilot.com", approvedAt: new Date(PINNED - 3 * DAY).toISOString(), expiresAt: null } });
    const aryeo = await import("@/lib/integrations/aryeo");
    const hP = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: P.clientId, name: P.name }, operation: "orders.create" });
    c.ok("(h) hubWritePermit(P) refused 'not in the program pilot' (the per-switch list is read by nobody)", !hP.ok && /not in the program pilot/.test(hP.reason), hP.ok ? "ok" : hP.reason);
    const sched = await portal.portalScheduleMonths({ id: P.enrollmentId, clientId: P.clientId });
    c.ok("(h) …and P's portal books through the desk (DESK)", sched.length > 0 && sched.every((s) => s.bookingMode === "DESK"), sched.map((s) => s.bookingMode).join(","));
  }

  // =========================================================================
  c.head("6 · non-program comms are untouched");
  // =========================================================================
  {
    const r0 = { a: readsOf("appSetting"), p: readsOf("programAutomation") };
    const i = mails.length;
    const kinds = [
      outbox.confirmationKey(`drill-proj-${X.clientId}`, NOW), outbox.deliveryKey(`drill-proj-${X.clientId}`), outbox.welcomeKey(X.clientId),
      outbox.afterHoursKey(X.clientId, "drill-period"), outbox.manualKey(`drill-intent-${X.clientId}`), outbox.staffKey("drill-member", NOW),
    ];
    const outcomes: string[] = [];
    for (const key of kinds) {
      const r = await outbox.sendThroughOutbox({ channel: "email", toRef: "xo@example.test", body: `a ${key.split(":")[0]} message`, dedupeKey: key, clientId: key.startsWith("staff:") ? null : X.clientId, requestedBy: "drill" });
      outcomes.push(`${key.split(":")[0]}=${r.outcome}`);
    }
    c.ok("confirmation, delivery, welcome, afterhours, manual and staff for X: all accepted by the provider", outcomes.every((o) => o.endsWith("=accepted")) && mailsSince(i).length === 6, outcomes.join(" "));
    c.ok("…and nothing read the rollout or a switch for them (0 AppSetting, 0 ProgramAutomation reads)", readsOf("appSetting") === r0.a && readsOf("programAutomation") === r0.p, `appSetting +${readsOf("appSetting") - r0.a}, programAutomation +${readsOf("programAutomation") - r0.p}`);
    // The same deliver() on the REAL store and the REAL (faked) provider, with a
    // counting gate that delegates to the real one: asked for a rollout kind,
    // never for the six others.
    const { programDispatchGate } = await import("@/lib/programRolloutGate");
    const asked: string[] = [];
    const machine = outbox.createOutbox({ store: outbox.prismaOutboxStore(), provider: outbox.realOutboxProvider(), gate: async (row) => { asked.push(outbox.outboxKind(row.dedupeKey) ?? "?"); return programDispatchGate(row); } });
    const j = mails.length;
    for (const key of kinds.map((k) => `${k}:m`)) await machine.sendThroughOutbox({ channel: "email", toRef: "xo@example.test", body: "b", dedupeKey: key, clientId: key.startsWith("staff:") ? null : X.clientId });
    c.ok("…through the same deliver() with a counting gate: the gate is asked 0 times for the six kinds (6 sent)", asked.length === 0 && mailsSince(j).length === 6, asked.join(","));
    const rk = await machine.sendThroughOutbox({ channel: "email", toRef: "xo@example.test", body: "b", dedupeKey: outbox.programReminderKey("COMPLETE_ANSWERS", "counting", "2026-10"), clientId: X.clientId });
    c.ok("…and once for a program reminder to X, which it refuses before any send", asked.join() === "program_reminder" && rk.outcome === "failed" && rk.refused === "not_in_rollout_scope" && mailsSince(j).length === 6, `${asked.join()} ${JSON.stringify(rk)}`);
  }

  // =========================================================================
  c.head("7 · fail closed");
  // =========================================================================
  {
    // An EXPIRED pilot covers nobody: every door refuses P at once.
    const expired = pilotWith([P.clientId]);
    await writeRollout(core.serializeProgramRollout({ ...expired, pilot: { ...expired.pilot!, expiresAt: new Date(PINNED - HOUR).toISOString() } }));
    const dExp = await pr.programReach("reminders", P.clientId);
    const patUser = await prisma.clientUser.findUniqueOrThrow({ where: { email: "pat@example.test" } });
    const liveExp = await portal.liveMemberships(patUser.id);
    const aryeoExp = await (await import("@/lib/integrations/aryeo")).hubWritePermit({ switchKey: "session_booking", client: { id: P.clientId, name: P.name }, operation: "orders.create" });
    const dryExp = await R.evaluateReminders({ dryRun: true, now: WED_FOLLOWUP, enrollmentIds: [P.enrollmentId] });
    c.ok("an EXPIRED pilot: P refused pilot_expired — no reminder, no sign-in, no Aryeo write", !dExp.ok && dExp.code === "pilot_expired" && liveExp.length === 0 && !aryeoExp.ok && /ended/.test(aryeoExp.ok ? "" : aryeoExp.reason) && dryExp.candidates.filter((x) => x.clientId === P.clientId).every((x) => x.decision !== "send"), `${dExp.ok ? "ok" : dExp.code} · seats ${liveExp.length} · ${aryeoExp.ok ? "ok" : aryeoExp.reason}`);
    // Put P back in the pilot so a refusal below is the fault, not the removal.
    await writeRollout(core.serializeProgramRollout(pilotWith([P.clientId])));
    await writeRollout("{bad");
    const loaded = await pr.loadProgramRollout();
    c.ok("'{bad' reads as TEST_ONLY with a problem", loaded.rollout.mode === "TEST_ONLY" && !!loaded.problem, loaded.problem ?? "");
    const [dP, dT] = await Promise.all([pr.programReach("reminders", P.clientId), pr.programReach("reminders", T.clientId)]);
    c.ok("…P refused, T allowed", !dP.ok && dT.ok);
    const i = mails.length;
    const conf = await outbox.sendThroughOutbox({ channel: "email", toRef: "xo@example.test", body: "your shoot is confirmed", dedupeKey: outbox.confirmationKey("drill-proj-fc", NOW), clientId: X.clientId, requestedBy: "drill" });
    c.ok("…and a client confirmation still sends (business default 6: non-program comms never touched)", conf.outcome === "accepted" && mailsSince(i).length === 1);
    const w = await pr.updateProgramRollout((cur) => cur, "info@realtourpilot.com", "drill_overwrite");
    c.ok("updateProgramRollout refuses to overwrite the unreadable value", !w.ok && /could not be read/.test(w.message) && (await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } }))?.value === "{bad", w.ok ? "" : w.message);
    await writeRollout(core.serializeProgramRollout(pilotWith([P.clientId])));
    // an injected client-read error
    faults.client = true;
    const dErr = await pr.programReach("reminders", P.clientId);
    const { programDispatchGate } = await import("@/lib/programRolloutGate");
    const fakeRow = { id: "x", channel: "email", toRef: "pat@example.test", body: "", state: "attempting", attempts: 0, leaseUntil: null, leaseBy: "w", providerId: null, providerError: null, dedupeKey: "program_reminder:COMPLETE_ANSWERS:r:2026-10", requestedBy: null, clientId: P.clientId, projectId: null, taskId: null, createdAt: new Date(), acceptedAt: null, resolvedAt: null, extraToRefsJson: null, mediaUrlsJson: null };
    const vErr = await programDispatchGate(fakeRow);
    faults.client = false;
    c.ok("an injected client-read error → scope_unreadable; the gate refuses gate_error", !dErr.ok && dErr.code === "scope_unreadable" && !vErr.ok && vErr.code === "gate_error", `${dErr.ok ? "ok" : dErr.code} / ${vErr.ok ? "ok" : vErr.code}`);
    // a throwing gate
    const mem = new Map<string, import("@/lib/outbox").OutboxRow>();
    let n = 0;
    const store: import("@/lib/outbox").OutboxStore = {
      async insert(row) { const r = { id: `m${++n}`, channel: row.channel, toRef: row.toRef, body: row.body, state: "pending", attempts: 0, leaseUntil: null, leaseBy: null, providerId: null, providerError: null, dedupeKey: row.dedupeKey, requestedBy: row.requestedBy ?? null, clientId: row.clientId ?? null, projectId: null, taskId: null, createdAt: new Date(), acceptedAt: null, resolvedAt: null, extraToRefsJson: null, mediaUrlsJson: null }; mem.set(r.id, r); return r; },
      async byId(id) { return mem.get(id) ?? null; },
      async byDedupeKey(k) { return [...mem.values()].find((r) => r.dedupeKey === k) ?? null; },
      async patch(id, where, data) {
        const r = mem.get(id); if (!r) return 0;
        const states = where.state ? (Array.isArray(where.state) ? where.state : [where.state]) : null;
        if (states && !states.includes(r.state as never)) return 0;
        if (where.leaseBy && r.leaseBy !== where.leaseBy) return 0;
        const { bumpAttempts, ...rest } = data;
        Object.assign(r, rest, bumpAttempts ? { attempts: r.attempts + 1 } : {});
        return 1;
      },
      async list() { return []; },
      async count() { return 0; },
    };
    let providerCalls = 0;
    const ob = outbox.createOutbox({ store, provider: { async send() { providerCalls++; return { providerId: "p" }; } }, gate: async () => { throw new Error("boom"); } });
    const r = await ob.sendThroughOutbox({ channel: "email", toRef: "pat@example.test", body: "b", dedupeKey: "program_reminder:COMPLETE_ANSWERS:thrown:2026-10", clientId: P.clientId });
    c.ok("a throwing gate → failed, refused gate_error, the provider never called", r.outcome === "failed" && r.refused === "gate_error" && providerCalls === 0, JSON.stringify(r));
    const r2 = await ob.sendThroughOutbox({ channel: "email", toRef: "pat@example.test", body: "b", dedupeKey: "confirmation:drill:none", clientId: P.clientId });
    c.ok("…while a confirmation through the same machine never meets the gate", r2.outcome === "accepted" && providerCalls === 1, JSON.stringify(r2));
  }

  // =========================================================================
  c.head("10 · Q never reaches X by any path");
  // =========================================================================
  {
    const cookie = await cookieFor(Q.id, Q.email);
    // the stream route (auth enforced, so the staff fallback cannot open it)
    const cutX = await prisma.reviewSubmission.create({ data: { projectId: X.projectId!, round: 1, fileName: "x-cut.mp4", status: "APPROVED", decidedAt: new Date(), source: "upload" } });
    const cutP = await prisma.reviewSubmission.create({ data: { projectId: P.projectId!, round: 1, fileName: "p-cut.mp4", status: "APPROVED", decidedAt: new Date(), source: "upload" } });
    const { NextRequest } = await import("next/server");
    const stream = await import("@/app/api/review/cut/[id]/stream/route");
    process.env.AUTH_ENFORCE = "true";
    const req = (id: string) => { const r = new NextRequest(`http://127.0.0.1/api/review/cut/${id}/stream`); r.cookies.set(CLIENT_COOKIE, cookie); return r; };
    const sX = await stream.GET(req(cutX.id), { params: Promise.resolve({ id: cutX.id }) });
    const sP = await stream.GET(req(cutP.id), { params: Promise.resolve({ id: cutP.id }) });
    c.ok("stream route: Q's cookie on X's cut → 403; on P's cut → admitted (not 403)", sX.status === 403 && sP.status !== 403, `${sX.status} / ${sP.status}`);
    // the upload route
    const upload = await import("@/app/api/portal/upload/route");
    const form = (enrollmentId: string) => { const f = new FormData(); f.set("enrollmentId", enrollmentId); return f; };
    const up = (enrollmentId: string) => { const r = new NextRequest("http://127.0.0.1/api/portal/upload", { method: "POST", body: form(enrollmentId) }); r.cookies.set(CLIENT_COOKIE, cookie); return upload.POST(r); };
    const uX = await up(X.enrollmentId);
    const uP = await up(P.enrollmentId);
    c.ok("upload route: X → 401; P → past the door (asks for a file)", uX.status === 401 && uP.status === 400, `${uX.status} / ${uP.status}`);
    delete process.env.AUTH_ENFORCE;
    // a portal action, as the signed-in person (the jar)
    jar.set(CLIENT_COOKIE, cookie);
    const { portalPostMessage } = await import("@/app/portal/actions");
    const aX = await portalPostMessage({ enrollmentId: X.enrollmentId }, { body: "hello from Q" });
    const aP = await portalPostMessage({ enrollmentId: P.enrollmentId }, { body: "hello from Q" });
    jar.delete(CLIENT_COOKIE);
    c.ok("portal action with enrollmentId X → 'Please sign in'; with P → posted", !aX.ok && /sign in/i.test(aX.message) && aP.ok, `${aX.message} / ${aP.message}`);
    c.ok("the picker (/portal/me) offers P only", (await portal.liveMemberships(Q.id)).map((s) => s.clientId).join() === P.clientId);
  }

  // =========================================================================
  c.head("11 · hub writes: ONE pilot list names who Aryeo and Calendly write for");
  // =========================================================================
  {
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("aryeo", "drill-key-not-a-real-one");
    const F = await buildContentMonth(db, { name: "Fixture Booking TEST", project: false, owner: false });
    await customers.makeFixture(db, F.clientId);
    const perSwitchX = { clientIds: [X.clientId], operations: ["orders.create", "appointments.store", "addresses.patch"], approvedBy: "info@realtourpilot.com", approvedAt: new Date(PINNED - 3 * DAY).toISOString(), expiresAt: null };
    await sw("session_booking", true, { authorizedFixtureClientIds: [F.clientId], pilot: perSwitchX });
    await sw("address_sync", true, { authorizedFixtureClientIds: [F.clientId], pilot: perSwitchX });
    const aryeo = await import("@/lib/integrations/aryeo");
    aryeo.resetFixtureIdentityCache();
    const ask = async (switchKey: "session_booking" | "address_sync", f: { clientId: string; name: string }, op: string) => {
      const d = await aryeo.hubWritePermit({ switchKey, client: { id: f.clientId, name: f.name }, operation: op });
      return d.ok ? `ok ${d.scope}` : `refused: ${d.reason}`;
    };
    c.ok("session_booking: P (program pilot, bookings ticked) → PILOT", (await ask("session_booking", P, "orders.create")) === "ok PILOT", await ask("session_booking", P, "orders.create"));
    c.ok("address_sync: P → PILOT", (await ask("address_sync", P, "addresses.patch")) === "ok PILOT");
    const x = await ask("session_booking", X, "orders.create");
    c.ok("X (on the per-switch list only) → refused, 'not in the program pilot'", x.startsWith("refused") && /not in the program pilot/.test(x), x);
    c.ok("the TEST fixture → FIXTURE, exactly as before", (await ask("session_booking", { clientId: F.clientId, name: F.clientName }, "orders.create")) === "ok FIXTURE");
    const cfgRow = await prisma.programAutomation.findUniqueOrThrow({ where: { key: "session_booking" } });
    c.ok("…the stored fixture list is untouched", JSON.stringify((JSON.parse(cfgRow.configJson ?? "{}") as { authorizedFixtureClientIds?: string[] }).authorizedFixtureClientIds) === JSON.stringify([F.clientId]));
    // bookings NOT ticked for the pilot → nothing written for P
    await writeRollout(core.serializeProgramRollout(pilotWith([P.clientId], core.opsForGroups(["accounts", "layout", "emails", "portal_changes"]))));
    const noBook = await ask("session_booking", P, "orders.create");
    c.ok("P with 'bookings' not ticked → refused ('does not include bookings')", noBook.startsWith("refused") && /does not include bookings/.test(noBook), noBook);
    await writeRollout(core.serializeProgramRollout(pilotWith([P.clientId])));
    // the Calendly guard reads the same list
    await sw("call_booking", true, { mode: "API", authorizedFixtureClientIds: [], pilot: perSwitchX });
    const { callBookingScope } = await import("@/lib/callBooking");
    const cP = await callBookingScope({ client: { id: P.clientId, name: P.name }, operation: "invitees.create" });
    const cX = await callBookingScope({ client: { id: X.clientId, name: X.name }, operation: "invitees.create" });
    c.ok("call_booking: P → PILOT, X refused (the program pilot, not the switch's list)", cP.ok && cP.scope === "PILOT" && !cX.ok && /not in the program pilot/.test(cX.reason), `${cP.ok ? cP.scope : cP.reason} / ${cX.ok ? cX.scope : cX.reason}`);
    // the settings panel shows the program pilot, and the per-switch editor refuses
    const pilotActions = await import("@/app/settings/pilotActions");
    const scopes = await pilotActions.loadHubWriteScopes();
    const sb = "switches" in scopes ? scopes.switches.find((s) => s.switchKey === "session_booking") : null;
    c.ok("Settings shows the PROGRAM pilot on each hub-write switch (P, not the drifted X)", sb?.pilotSource === "program" && sb.pilot?.clients.map((x) => x.id).join() === P.clientId, JSON.stringify(sb?.pilot?.clients));
    const add = await pilotActions.addPilotClientAction({ switchKey: "session_booking", clientId: X.clientId, typedName: X.name, groups: ["book"] });
    c.ok("…and the per-switch pilot editor refuses, pointing at the one list", !add.ok && /one pilot list/.test(add.message), add.message);
  }

  c.ok("nothing left this process but the fakes", fence.blocked.length === 0, fence.blocked.join(" "));
  console.log(`\n${await drill.evidence()} · Gmail sends faked: ${mails.length}`);
  c.summary();
  quiet.restore();
  fence.restore();
  await drill.stop();
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes(OLD_PASS)) {
  oldPass().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
