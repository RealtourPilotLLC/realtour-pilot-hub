// ---------------------------------------------------------------------------
// DRILL: the isolated demo (E2) — every printed link leads to data, and the
// demo server can reach nothing.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/demo-smoke.ts
//
// Boots the demo database the way scripts/demo/isolated-demo.ts does
// (bootDemoDb: PGlite behind the demo's socket server, schema pushed), in
// memory on this drill's port, runs the SAME seed (scripts/demo/seedDemo.ts —
// three TEST clients through E1's representative month), and installs the
// SAME network fence the demo dev server loads (scripts/demo/demo-preload.cjs)
// with an ephemeral copy of the clip server behind it. Then:
//
//   S1  the seed: three TEST clients, E1's month on each, Kyle as the portal
//       contact, Jordan's staff login, the ended account ENDED
//   S2  every portal link resolves: token → the right enrollment, FULL for the
//       running programs and READ_ONLY for the ended one; each library lists
//       videos, and the Accelerator month shows review / approved / delivered
//   S3  every sign-in link is single use and signs in the client's OWNER
//   S4  every staff link's loader returns rows: the program overview, the
//       client file's topics and scripts, the Review Room queue and the cut
//       workspace the printed link names
//   S5  a demo cut plays through the shipped stream route (206, the clip's own
//       bytes); approved and delivered videos download through the shipped
//       door; one awaiting review is refused
//   S6  the AI paths run into the stub: "Apply with AI" writes a new script
//       version and nothing leaves the process
//   S7  the fence: providers blocked, the invented store answered locally, and
//       the fence refuses to load against any other database
//   S8  no provider env var is visible here, and run-demo-dev.sh hands next dev
//       an environment with every secret blank even when its caller's is poisoned
//   S9  two processes on one PGlite session: the OLD socket server collides on
//       Prisma's statement names (42P05, the demo's first-click failure), the
//       demo's does not
//
// No provider is reached and no message is sent: the fence under test blocks
// every non-loopback destination, and the drill asserts it blocked what it saw.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { DrillSocketServer, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import { bootDemoDb } from "../demo/bootDemoDb";
import { namespaceStatementNames } from "../demo/demoSocketServer";
import { buildSampleMp4, ensureSampleClip, startSampleServer, DEMO_CLIP_URL, isDemoClipUrl } from "../demo/sample";
import config from "../demo/demo-config.json";

const PORT = Number(process.env.DRILL_PORT ?? 5533);
const REPO = path.resolve(__dirname, "../..");
const BASE = `http://localhost:${config.devPort}`;
const execP = promisify(execFile);

type Preload = {
  install: (o: { dbPort?: number; samplePort?: number; dataDir?: string }) => { restore: () => void };
  blocked: string[];
  aiCallCount: () => number;
};
const preload = createRequire(__filename)("../demo/demo-preload.cjs") as Preload;

installNextStubs();
const c = makeChecker();

/** The env as the drill process started — S8 checks nothing from it leaks. */
const PARENT_ENV_KEYS = new Set(Object.keys(process.env));

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demo-smoke-"));
  const { stop, db, server } = await bootDemoDb({ port: PORT, env: { APP_SECRET: config.appSecret, NEXT_PUBLIC_APP_URL: BASE } });
  const clip = ensureSampleClip(tmp);
  const sample = await startSampleServer(clip, 0);
  const fence = preload.install({ dbPort: PORT, samplePort: sample.port, dataDir: tmp });
  const quiet = quietPrismaErrors();

  const { prisma } = await import("@/lib/prisma");
  const demo = await import("../demo/seedDemo");
  const { NextRequest } = await import("next/server");

  // ---- S1 ------------------------------------------------------------------
  c.head("S1 · the seed");
  const seed = await demo.seedDemo(prisma);
  c.ok("three TEST clients, one per variant", seed.clients.length === 3 && new Set(seed.clients.map((x) => x.variant)).size === 3, seed.clients.map((x) => x.name).join(", "));
  const { isTestClientName } = await import("@/lib/testClients");
  c.ok("every name carries TEST", seed.clients.every((x) => isTestClientName(x.name)));
  const rep = fs.existsSync(demo.REPRESENTATIVE_MONTH_FILE);
  c.ok("E1's representative month is in the tree", rep, demo.REPRESENTATIVE_MONTH_FILE);
  c.ok("…and seeded every client", Object.values(seed.representative).every((s) => s === "seeded"), JSON.stringify(seed.representative));
  c.ok("each month came back with a job and five cuts (A, B, B2, C, D)", seed.clients.every((x) => !!x.month?.projectId && !!x.month.cuts));
  const contact = await prisma.appSetting.findUnique({ where: { key: "portal-contact" } });
  const { portalContact } = await import("@/lib/programMessages");
  const pc = await portalContact();
  c.ok("the portal contact is Kyle, (215) 645-4889", !!contact && pc.name === "Kyle" && pc.display === "(215) 645-4889", JSON.stringify(pc));
  const staff = await prisma.appUser.findUnique({ where: { email: config.staffEmail } });
  const { verifyPassword } = await import("@/lib/auth/password");
  c.ok("Jordan's staff login is an ACTIVE OWNER with the demo password", !!staff && staff.role === "OWNER" && staff.status === "ACTIVE" && (await verifyPassword(config.staffPassword, staff.passwordHash)));
  const ended = seed.clients.find((x) => x.variant === "ended")!;
  const endedRow = await prisma.contentEnrollment.findUnique({ where: { id: ended.enrollmentId }, select: { status: true } });
  c.ok("the ended account is ENDED", endedRow?.status === "ENDED", endedRow?.status);
  const cuts = await prisma.reviewSubmission.findMany({ where: { projectId: { in: seed.clients.flatMap((x) => [x.month?.projectId, x.month?.lastProjectId].filter((v): v is string => !!v)) } }, select: { id: true, blobUrl: true } });
  c.ok("every demo cut's file is the demo clip on the invented store", cuts.length > 0 && cuts.every((x) => isDemoClipUrl(x.blobUrl)), `${cuts.length} cuts; E1 wrote ${DEMO_CLIP_URL}`);
  c.ok("…so pointing them at the sample moves nothing", (await demo.pointCutsAtSample(prisma, seed)) === 0);
  const { blobFetchDecision } = await import("@/lib/reviewCuts");
  c.ok("the stream route's blob rule accepts that URL (a plain loopback URL would be 'unreadable')", blobFetchDecision(DEMO_CLIP_URL).ok && !blobFetchDecision("http://127.0.0.1:5540/demo/sample.mp4").ok);
  c.ok("no provider connection exists but the demo's stub model", (await prisma.connection.findMany({ select: { provider: true } })).map((x) => x.provider).join(",") === "ai");

  // ---- S2 ------------------------------------------------------------------
  c.head("S2 · portal links");
  const links = await demo.demoLinks(prisma, seed, BASE);
  const portal = await import("@/lib/portal");
  const { portalVideoList } = await import("@/lib/contentVideos");
  const noCookies = { get: () => undefined };
  const statesOf: Record<string, string[]> = {};
  for (const x of seed.clients) {
    const l = links.clients.find((y) => y.variant === x.variant)!;
    const token = l.portal.slice(`${BASE}/portal/`.length);
    c.ok(`${x.name}: link is ${BASE}/portal/<token> and the page's token shape`, l.portal.startsWith(`${BASE}/portal/`) && /^[a-zA-Z0-9_-]{20,}$/.test(token));
    const r = await portal.resolvePortalViewer({ token, cookies: noCookies });
    const want = x.variant === "ended" ? "READ_ONLY" : "FULL";
    c.ok(`${x.name}: token → this enrollment, ${want}`, r.ok && r.viewer.enrollment.id === x.enrollmentId && r.viewer.enrollment.clientName === x.name && r.viewer.access === want, r.ok ? r.viewer.access : r.reason);
    const list = await portalVideoList({ id: x.enrollmentId, clientId: x.clientId }, { perPage: 60 });
    statesOf[x.variant] = list.rows.map((v) => v.state);
    c.ok(`${x.name}: the library lists videos`, list.rows.length > 0, `${list.total}: ${[...new Set(statesOf[x.variant])].join(", ")}`);
  }
  const acc = seed.clients.find((x) => x.variant === "accelerator")!;
  c.ok("the Accelerator month shows a video to review, an approved one and a delivered one", ["FOR_REVIEW", "APPROVED", "DELIVERED"].every((s) => statesOf.accelerator.includes(s)), statesOf.accelerator.join(", "));
  const pro = seed.clients.find((x) => x.variant === "pro")!;
  const proSessions = await prisma.programSessionRequest.findMany({ where: { enrollmentId: pro.enrollmentId, monthId: pro.month?.monthId ?? undefined }, select: { status: true } });
  c.ok("the Pro month holds two confirmed sessions", proSessions.filter((s) => s.status === "CONFIRMED").length === 2, proSessions.map((s) => s.status).join(", "));
  const proRow = await prisma.contentEnrollment.findUnique({ where: { id: pro.enrollmentId }, select: { package: true } });
  c.ok("…on the Pro package", proRow?.package === "Pro", proRow?.package);

  // ---- S3 ------------------------------------------------------------------
  c.head("S3 · sign-in links");
  const { consumeLoginToken } = await import("@/lib/portalAccess");
  const { signClientSession } = await import("@/lib/auth/clientSession");
  const signIns = await demo.mintDemoSignInLinks(prisma, seed);
  c.ok("one sign-in link per client, on the demo's own address", signIns.length === 3 && signIns.every((s) => s.url.startsWith(`${BASE}/portal/auth/`)));
  for (const s of signIns) {
    const x = seed.clients.find((y) => y.name === s.name)!;
    const raw = s.url.split("/").pop()!;
    const first = await consumeLoginToken(raw);
    const again = await consumeLoginToken(raw);
    const seat = await prisma.clientMembership.findUnique({ where: { id: x.membershipId! }, select: { clientUserId: true, role: true } });
    c.ok(`${x.name}: the link signs in the OWNER seat's person, once`, first.ok && first.clientUserId === seat?.clientUserId && seat?.role === "OWNER" && !again.ok);
    if (first.ok) {
      const cookie = await signClientSession({ cu: first.clientUserId, email: first.email });
      const r = await portal.resolvePortalViewer({ cookies: { get: (n: string) => (n === "rtp_client" ? cookie : undefined) } });
      c.ok(`${x.name}: …and the portal then knows them as the owner`, r.ok && r.viewer.actor.kind === "CLIENT" && r.viewer.actor.membershipRole === "OWNER" && r.viewer.enrollment.id === x.enrollmentId);
    }
  }

  // ---- S4 ------------------------------------------------------------------
  c.head("S4 · staff links");
  c.ok("the staff links are the hub's own pages", links.staff.map((s) => s.url.slice(BASE.length)).join(" ") === "/login /content /review /editing /content/monitoring");
  const { programOverview } = await import("@/lib/programOverview");
  const overview = await programOverview({ monthKey: seed.monthKey, includeEnded: true });
  c.ok("/content: the overview has a row for every demo client", seed.clients.every((x) => overview.rows.some((r) => r.enrollmentId === x.enrollmentId)), `${overview.rows.length} rows`);
  const { getProgramRoster } = await import("@/lib/contentProgram");
  const roster = await getProgramRoster();
  c.ok("/content (cards): the roster has both running programs", [acc, pro].every((x) => roster.some((r) => r.enrollmentId === x.enrollmentId)));
  const running = await programOverview({ monthKey: seed.monthKey });
  c.ok("…and the ended account appears only behind \"Show ended clients\" (/content?ended=1)", !running.rows.some((r) => r.enrollmentId === ended.enrollmentId) && roster.every((r) => r.enrollmentId !== ended.enrollmentId));
  const programData = await import("@/app/content/[id]/programData");
  for (const x of seed.clients) {
    const l = links.clients.find((y) => y.variant === x.variant)!;
    const ws = l.staff.find((s) => s.label.startsWith("Client file"))!;
    c.ok(`${x.name}: the client file link names this enrollment`, ws.url === `${BASE}/content/${x.enrollmentId}` && !!(await prisma.contentEnrollment.findUnique({ where: { id: x.enrollmentId } })));
    const month = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId: x.enrollmentId, monthKey: seed.monthKey } }, select: { id: true, monthKey: true } });
    const topics = await programData.loadTopicsTab(x.enrollmentId, month);
    const scripts = await programData.loadScriptsTab(x.enrollmentId, month);
    c.ok(`${x.name}: its Topics and Scripts tabs load rows`, topics.monthTopics.length > 0 && scripts.scripts.length > 0, `${topics.monthTopics.length} month topics, ${scripts.scripts.length} scripts`);
    for (const s of l.staff.filter((s) => /\/(projects|edit)\//.test(s.url))) {
      const id = s.url.split("/").pop()!;
      c.ok(`${x.name}: "${s.label}" names a job that exists`, !!(await prisma.project.findUnique({ where: { id }, select: { id: true } })));
    }
  }
  const { getReviewQueue, getCutWorkspace } = await import("@/lib/reviewRoom");
  const queue = await getReviewQueue();
  const b2s = seed.clients.map((x) => x.month?.cuts?.B2).filter((v): v is string => !!v);
  const queued = [...queue.pending, ...queue.waitingOnEditor].map((q) => q.id);
  c.ok("/review: round 2 of video B is in the Review Room queue for the running programs", [acc, pro].every((x) => queued.includes(x.month!.cuts!.B2)), `${queue.pending.length} pending`);
  for (const x of seed.clients) {
    const l = links.clients.find((y) => y.variant === x.variant)!;
    const rr = l.staff.find((s) => s.label.startsWith("Review Room"))!;
    const u = new URL(rr.url);
    const projectId = u.pathname.split("/").pop()!;
    const w = await getCutWorkspace(projectId, u.searchParams.get("cut"));
    c.ok(`${x.name}: the Review Room link opens that cut's workspace`, !!w && b2s.includes(u.searchParams.get("cut")!), w ? "loaded" : "null");
  }

  // ---- S5 ------------------------------------------------------------------
  c.head("S5 · playback and downloads");
  const { mediaToken } = await import("@/lib/portalMedia");
  const streamRoute = await import("@/app/api/review/cut/[id]/stream/route");
  const downloadRoute = await import("@/app/api/portal/download/[videoId]/route");
  const bytes = buildSampleMp4();
  const scopeOf = (x: typeof acc) => ({ kind: "enrollment" as const, id: x.enrollmentId });
  const cutA = acc.month!.cuts!.A;
  const played = await streamRoute.GET(new NextRequest(`${BASE}/api/review/cut/${cutA}/stream?m=${encodeURIComponent(mediaToken(cutA, scopeOf(acc)))}`, { headers: { range: "bytes=0-99" } }), { params: Promise.resolve({ id: cutA }) });
  const body = Buffer.from(await played.arrayBuffer());
  c.ok("a cut awaiting review PLAYS through the shipped stream route: 206, video/mp4, the clip's own first 100 bytes", played.status === 206 && played.headers.get("content-type") === "video/mp4" && body.equals(bytes.subarray(0, 100)), `${played.status} ${played.headers.get("content-range")}`);
  const videoAt = async (x: typeof acc, cut: "A" | "C" | "D") => {
    const slot = { A: 1, C: 3, D: 4 }[cut];
    const sub = x.month!.cuts![cut];
    return prisma.contentVideo.findFirst({
      where: { enrollmentId: x.enrollmentId, OR: [{ projectId: x.month!.projectId!, slot }, { currentSubmissionId: sub }, { approvedSubmissionId: sub }, { finalSubmissionId: sub }] },
      select: { id: true },
    });
  };
  const door = (videoId: string, x: typeof acc) =>
    downloadRoute.GET(new NextRequest(`${BASE}/api/portal/download/${videoId}?m=${encodeURIComponent(mediaToken(videoId, scopeOf(x)))}`), { params: Promise.resolve({ videoId }) });
  for (const [x, cut, want] of [[acc, "C", "allowed"], [acc, "D", "allowed"], [acc, "A", "refused"], [ended, "D", "allowed"]] as const) {
    const v = await videoAt(x, cut);
    if (!v) { c.ok(`${x.name}: video ${cut} exists in the library`, false); continue; }
    const res = await door(v.id, x);
    if (want === "refused") {
      c.ok(`${x.name}: video ${cut} (awaiting the client) is NOT downloadable`, res.status === 403, `${res.status}`);
      continue;
    }
    const loc = res.headers.get("location") ?? "";
    let saved = 0;
    if (res.status === 302 && loc) {
      const u = new URL(loc);
      const sid = u.pathname.split("/")[4];
      const file = await streamRoute.GET(new NextRequest(u.toString()), { params: Promise.resolve({ id: sid }) });
      saved = file.status === 200 && /attachment/.test(file.headers.get("content-disposition") ?? "") ? Buffer.from(await file.arrayBuffer()).length : 0;
    }
    c.ok(`${x.name}: video ${cut} downloads — the door redirects to the file and the file comes back as an attachment`, res.status === 302 && saved === bytes.length, `${res.status}, ${saved} bytes`);
  }

  // ---- S6 ------------------------------------------------------------------
  c.head("S6 · the model is the stub");
  const { getSecret } = await import("@/lib/integrations/connections");
  c.ok("the seeded 'ai' key decrypts under the demo APP_SECRET (the one run-demo-dev.sh passes)", (await getSecret("ai")) === config.aiStubKey);
  const scriptB = acc.month!.scripts.B;
  const before = await prisma.contentScriptVersion.count({ where: { scriptId: scriptB } });
  const calls = preload.aiCallCount();
  const blockedBefore = preload.blocked.length;
  const { reviseScriptWithInstructions } = await import("@/lib/contentPipeline");
  await reviseScriptWithInstructions(scriptB, "Open on the coffee shop line.", { requestedBy: config.staffEmail, source: "CLIENT_REQUEST" });
  const after = await prisma.contentScriptVersion.findMany({ where: { scriptId: scriptB }, orderBy: { versionNo: "desc" }, take: 1, select: { versionNo: true, hook: true, spokenWordCount: true, estimatedSeconds: true } });
  c.ok("'Apply with AI' writes a new script version from the stub", (await prisma.contentScriptVersion.count({ where: { scriptId: scriptB } })) === before + 1 && preload.aiCallCount() === calls + 1, after[0]?.hook ?? "");
  // The app's own estimate (spoken parts only, 2.2 words/s), as stored on the version.
  const secs = after[0]?.estimatedSeconds ?? -1;
  c.ok("…inside the 20–30 s target by the app's own estimate, so the demo shows no length warning", secs >= 20 && secs <= 30, `${after[0]?.spokenWordCount} spoken words ≈ ${secs}s`);
  const run = await prisma.programAiRun.findFirst({ where: { kind: "script_revise" }, orderBy: { createdAt: "desc" }, select: { status: true } });
  c.ok("…through the real run ledger", run?.status === "SUCCEEDED", run?.status);
  c.ok("…and nothing tried to leave the process", preload.blocked.length === blockedBefore, preload.blocked.slice(blockedBefore).join(", "));

  // ---- S7 ------------------------------------------------------------------
  c.head("S7 · the fence");
  const refused = async (label: string, attempt: () => Promise<unknown>) => {
    const at = preload.blocked.length;
    let threw = "";
    try { await attempt(); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    c.ok(label, /BLOCKED BY DEMO FENCE/.test(threw) && preload.blocked.length > at, threw.slice(0, 90));
  };
  await refused("fetch to Aryeo is blocked", () => fetch("https://api.aryeo.com/v1/orders"));
  await refused("fetch to Dropbox is blocked", () => fetch("https://api.dropboxapi.com/2/files/get_temporary_link", { method: "POST" }));
  await refused("a raw HTTPS request to Stripe (node:https, as its SDK does) is blocked", () =>
    new Promise((resolve, reject) => { const r = https.get("https://api.stripe.com/v1/charges", resolve); r.on("error", reject); }));
  const local = await fetch(DEMO_CLIP_URL, { headers: { Range: "bytes=0-9" } });
  c.ok("the invented store is answered by the local clip server (206)", local.status === 206 && Buffer.from(await local.arrayBuffer()).equals(bytes.subarray(0, 10)) && sample.hits() > 0);
  let refusedLoad = "";
  try { preload.install({ dbPort: config.dbPort }); } catch (e) { refusedLoad = e instanceof Error ? e.message : String(e); }
  c.ok("the fence refuses to load when DATABASE_URL is not the database it was told", /refusing to start/.test(refusedLoad), refusedLoad.slice(0, 100));

  // ---- S8 ------------------------------------------------------------------
  c.head("S8 · environment");
  const envKeys = new Set<string>();
  for (const f of fs.readdirSync(REPO).filter((n) => n.startsWith(".env"))) {
    for (const m of fs.readFileSync(path.join(REPO, f), "utf8").matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) envKeys.add(m[1]);
  }
  const pinnedHere = new Set(["DATABASE_URL", "DIRECT_URL", "APP_SECRET", "NEXT_PUBLIC_APP_URL", "CRON_SECRET"]);
  const visible = [...envKeys].filter((k) => !pinnedHere.has(k) && process.env[k]);
  c.ok("no .env provider key is visible to this process", visible.length === 0, visible.join(", ") || `${envKeys.size} keys checked`);
  c.ok("this process's database is the drill's loopback one", new URL(process.env.DATABASE_URL ?? "").host === `127.0.0.1:${PORT}`);

  const poisoned = {
    ...process.env,
    DATABASE_URL: "postgresql://prod:secret@ep-poison.us-east-2.aws.neon.tech/neondb",
    DIRECT_URL: "postgresql://prod:secret@ep-poison.us-east-2.aws.neon.tech/neondb",
    STRIPE_SECRET_KEY: "sk_live_poison",
    ANTHROPIC_API_KEY: "poison",
    AUTH_ENFORCE: "true",
    SOME_UNLISTED_TOKEN: "poison",
  };
  const { stdout } = await execP("/bin/bash", [path.join(REPO, "scripts/demo/run-demo-dev.sh"), "--print-env"], { env: poisoned, cwd: REPO });
  const printed = new Map(stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const demoUrl = "postgresql://postgres:postgres@127.0.0.1:5599/postgres?sslmode=disable";
  c.ok("run-demo-dev.sh: DATABASE_URL and DIRECT_URL are the demo's 127.0.0.1:5599, whatever the caller exported", printed.get("DATABASE_URL") === demoUrl && printed.get("DIRECT_URL") === demoUrl);
  const leaked = [...printed].filter(([, v]) => v.includes("poison"));
  c.ok("…no poisoned value reaches next dev", leaked.length === 0, leaked.map(([k]) => k).join(", "));
  c.ok("…a variable the script has never heard of is not passed at all (env -i)", !printed.has("SOME_UNLISTED_TOKEN") && [...PARENT_ENV_KEYS].filter((k) => !printed.has(k) && k !== "PATH" && k !== "HOME").length > 0);
  const notBlank = [...envKeys].filter((k) => !["DATABASE_URL", "DIRECT_URL", "APP_SECRET", "NEXT_PUBLIC_APP_URL"].includes(k) && printed.get(k) !== "(blank)");
  c.ok("…every .env key is passed BLANK, so next's and Prisma's .env loading cannot refill it", notBlank.length === 0, notBlank.join(", ") || `${envKeys.size} keys`);
  c.ok("…STRIPE_SECRET_KEY, ANTHROPIC_API_KEY blank; AUTH_ENFORCE blank (the dev gate is off)", ["STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY", "AUTH_ENFORCE", "VERCEL"].every((k) => printed.get(k) === "(blank)"));
  c.ok("…APP_SECRET is the demo's (the key the seed encrypted the stub model under) and links point at :3100", printed.get("APP_SECRET") === config.appSecret && printed.get("NEXT_PUBLIC_APP_URL") === BASE);
  c.ok("…and every server process loads the fence", /--require=.*\/demo-preload\.cjs$/.test(printed.get("NODE_OPTIONS") ?? "") && printed.get("RTP_DEMO") === "1");

  // ---- S9 ------------------------------------------------------------------
  c.head("S9 · two processes on one session");
  const msg = (type: string, body: Buffer) => { const b = Buffer.alloc(5 + body.length); b.write(type, 0, "latin1"); b.writeInt32BE(4 + body.length, 1); body.copy(b, 5); return new Uint8Array(b); };
  const parse = msg("P", Buffer.concat([Buffer.from("s7\0SELECT 1\0", "latin1"), Buffer.from([0, 0])]));
  const seen = new Set<string>();
  const renamed = Buffer.from(namespaceStatementNames(4, parse, seen));
  c.ok("Parse 's7' becomes 'h4_s7', length rewritten, remembered for DEALLOCATE", renamed.subarray(5).toString("latin1").startsWith("h4_s7\0SELECT 1\0") && renamed.readInt32BE(1) === renamed.length - 1 && seen.has("h4_s7"));
  const bind = Buffer.from(namespaceStatementNames(4, msg("B", Buffer.from("\0s7\0\0\0\0\0\0\0", "latin1"))));
  c.ok("Bind to 's7' binds 'h4_s7' (the unnamed portal untouched)", bind.subarray(5).toString("latin1").startsWith("\0h4_s7\0"));
  const unnamed = msg("P", Buffer.from("\0SELECT 1\0\0\0", "latin1"));
  const portalDescribe = msg("D", Buffer.from("P\0", "latin1"));
  const simple = msg("Q", Buffer.from("SELECT 1\0", "latin1"));
  c.ok("the unnamed statement, a portal Describe and a simple query pass through unchanged", namespaceStatementNames(4, unnamed) === unnamed && namespaceStatementNames(4, portalDescribe) === portalDescribe && namespaceStatementNames(4, simple) === simple);
  namespaceStatementNames(4, msg("C", Buffer.from("Ss7\0", "latin1")), seen);
  c.ok("a Close of that statement forgets it (nothing left to free)", !seen.has("h4_s7"));

  // A fresh process's first statements, against a session that already holds
  // another process's: exactly the demo's first click.
  const child = async (port: number) => {
    const code = `const { PrismaClient } = require("@prisma/client");
      const p = new PrismaClient({ datasourceUrl: process.argv[1] });
      (async () => {
        try {
          await p.appSetting.findMany({ where: { key: "x" } });
          await p.client.count();
          await p.contentEnrollment.findFirst({ select: { id: true } });
          console.log("OK");
        } catch (e) { console.log("ERR " + String(e && e.message).replace(/\\s+/g, " ").slice(-160)); }
        finally { await p.$disconnect(); }
      })();`;
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
    const { stdout: out } = await execP(process.execPath, ["-e", code, url], { cwd: REPO, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } });
    return out.trim().split("\n").pop() ?? "";
  };
  const old = new DrillSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections: 16 });
  await old.start();
  const oldPort = (old as unknown as { port: number }).port;
  const first = await child(oldPort);
  const second = await child(oldPort);
  c.ok("OLD (the harness's server): the second process collides with the first's statements — 42P05", first === "OK" && /already exists/.test(second), `${first} / ${second.slice(0, 120)}`);
  await old.stop();
  // The first two children's raw s0… are still in the session. Namespaced
  // names never meet them, which is the point.
  const a = await child(PORT);
  const b = await child(PORT);
  await new Promise((r) => setTimeout(r, 300));
  c.ok("NEW (the demo's server): both processes run clean", a === "OK" && b === "OK", `${a} / ${b}`);
  c.ok("…and a closed connection's statements are deallocated", server.deallocated > 0, `${server.deallocated} freed`);

  c.head("fence tally");
  c.ok("every blocked attempt was one this drill made on purpose", preload.blocked.every((b) => /aryeo|dropbox|stripe/i.test(b)), preload.blocked.join(", "));

  quiet.restore();
  fence.restore();
  await sample.stop();
  c.summary();
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
