// @drill-run: engine=postgres timeout=900
// Targeted later Pro month: two independently planned four-video sessions.
// Prior strategy/call and external appointments are declared fixture inputs.
// Actual signed HTTP actions; fake providers, no browser or human-watch proof.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { buildSampleMp4 } from "../demo/sample";

const CANDIDATE = "fa346fa1d9a45b2b0a49e291511af0c066003b3f";
const EXPECTED_BUILD_ID = "v7eqA6pIg4XsD5SgdOobV";
const EXPECTED_ACTION_HASH = "f9beeab391bfe80d0054367ed7169a0b18016042b839b693ffba68d12e6f108e";
// Only inspect this fixture's explicitly named private build snapshots.
const base = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("rtp-pro-http-build-")).map((name) => path.join(os.tmpdir(), name)).find((root) => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, "isolated-build.json"), "utf8"));
    const hash = createHash("sha256").update(fs.readFileSync(path.join(root, ".next/server/server-reference-manifest.json"))).digest("hex");
    const aliases = path.join(root, ".next/node_modules/@prisma");
    const aliasesReady = fs.existsSync(aliases) && fs.readdirSync(aliases).some((name) => name.startsWith("client-") && fs.existsSync(path.join(aliases, name, "package.json")));
    return m.candidate === CANDIDATE && m.buildId === EXPECTED_BUILD_ID && m.manifestHash === EXPECTED_ACTION_HASH &&
      fs.readFileSync(path.join(root, ".next/BUILD_ID"), "utf8").trim() === EXPECTED_BUILD_ID && hash === EXPECTED_ACTION_HASH && aliasesReady && !fs.existsSync(path.join(root, ".env"));
  } catch { return false; }
});
if (!base) throw new Error("Copy the declared compiled candidate into a private rtp-pro-http-build-* snapshot first; no build or production fallback is performed.");
const COMPILED_BASE: string = base;
let builtRoot = COMPILED_BASE;
const DB_PORT = 5604, APP_PORT = 3214, MEDIA_PORT = 5606, BASE = `http://127.0.0.1:${APP_PORT}`;
const { encodeReply } = createRequire(__filename)("next/dist/compiled/react-server-dom-webpack/client.node") as { encodeReply: (args: unknown[]) => Promise<string | FormData> };
const c = makeChecker();
const checked = c.ok.bind(c);
c.ok = (label, condition, detail) => {
  checked(label, condition, detail);
  if (!condition) throw new Error(`Journey stopped at its first unmet transition: ${label}`);
  return true;
};
installNextStubs();
const RealDate = Date;
let clockOffsetMs = 0;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) { return args.length ? Reflect.construct(target, args) : new target(RealDate.now() + clockOffsetMs); },
  get(target, property, receiver) { return property === "now" ? () => RealDate.now() + clockOffsetMs : Reflect.get(target, property, receiver); },
}) as DateConstructor;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const topics = [
  "Price for the first weekend", "Prepare for a buyer visit", "Compare nearby listings", "Plan your listing photos",
  "Read the inspection report", "Review the offer terms", "Prepare for closing day", "Plan the move after closing",
].map((title, i) => ({ title, words: `For ${title.toLowerCase()}, sellers need a clear plan. I suggest comparing the choices, writing down the next step, and allowing time for questions. Session ${i < 4 ? 1 : 2} example ${i + 1}: a seller can prepare a simple checklist before meeting the agent.` }));
const strategy = {
  clientName: "Maya Grove", subtitle: "Built around Trust, Value, Credibility, and Entertainment",
  brandOverview: { coreValues: "Honesty and preparation", brandMessage: "Calm advice for West Chester sellers", shortBrandStatement: "Clear advice, calm process", brandVoice: "Warm, calm, direct" },
  targetAudience: { primaryServiceAreas: "West Chester", pricePositioning: "Move-up homes", primaryClientTypes: "Move-up buyers and sellers", longTermPositioningGoal: "Be the local name for a well-prepared move" },
  contentGoals: ["Explain pricing clearly", "Help sellers prepare", "Show local knowledge", "Publish useful video advice"],
  contentPillars: { preamble: "Build Trust through empathy, provide Value with a practical takeaway, establish Credibility with clear reasoning, and create Entertainment through curiosity.", pillars: ["Seller Strategy", "Buyer Guidance", "Local Life", "Behind the Scenes"].map((name) => ({ name, purpose: `Useful ${name.toLowerCase()} advice`, focusAreas: `Real decisions in ${name.toLowerCase()}`, contentApproach: "One useful idea at a time" })) },
  framework: "policy", captionCtaExamples: ["Save this before you list.", "Ask me about your next move.", "Share this with a seller."], strategicDirection: "Lead with pricing clarity and preparation.", gaps: [],
};
type State = { dbPort: number; operationLog: string; monthKey: string; topics: typeof topics; strategy: typeof strategy; sampleSize: number; rawFolders: string[]; productId: string; providerId: string; providerUserId: string; clockOffsetMs: number; blobs: Record<string, { pathname: string; bytes: string }>; files: Record<string, { id: string; rev: string; hash: string; bytes: string }> };
function actionId(filename: string, name: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(builtRoot, ".next/server/server-reference-manifest.json"), "utf8")) as { node: Record<string, { workers: Record<string, { filename: string; exportedName: string }> }> };
  const entry = Object.entries(manifest.node).find(([, row]) => Object.values(row.workers).some((w) => w.filename === filename && w.exportedName === name));
  if (!entry) throw new Error(`Built supported action is absent: ${filename} ${name}`);
  return entry[0];
}
function cookieFrom(r: Response, name: string) { const value = r.headers.getSetCookie().find((x) => x.startsWith(`${name}=`)); return value ? value.split(";", 1)[0] : null; }
async function get(url: string, cookie?: string | null, headers?: Record<string, string>) { return fetch(new URL(url, BASE), { redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...headers } }); }
async function action(url: string, filename: string, name: string, args: unknown[], cookie?: string | null) {
  const encoded = await encodeReply(args);
  const headers: Record<string, string> = { "next-action": actionId(filename, name), origin: BASE, accept: "text/x-component", ...(cookie ? { cookie } : {}) };
  if (typeof encoded === "string") headers["content-type"] = "text/plain;charset=UTF-8";
  const response = await fetch(new URL(url, BASE), { method: "POST", body: encoded, headers, redirect: "manual" });
  const body = await response.text();
  const result = body.split("\n").map((line) => /^\w+:(\{.*\})$/.exec(line)?.[1]).filter((x): x is string => !!x).map((x) => { try { return JSON.parse(x) as Record<string, unknown>; } catch { return null; } }).find((x) => x && (typeof x.ok === "boolean" || "handoff" in x || "blocked" in x || "needsConfirm" in x || "topicsPending" in x)) ?? null;
  const flightErrors = body.split("\n").map((line) => /^\w+:E(\{.*\})$/.exec(line)?.[1]).filter((x): x is string => !!x).map((x) => { try { const e = JSON.parse(x); return { digest: String(e.digest ?? ""), message: String(e.message ?? "").slice(0, 200) }; } catch { return { digest: "unparsed", message: "" }; } });
  return { response, result, flightError: flightErrors.length > 0, flightErrors };
}
async function must(url: string, filename: string, name: string, args: unknown[], cookie: string | null) {
  const r = await action(url, filename, name, args, cookie);
  if (r.response.status !== 200 || r.flightError || r.result?.ok !== true) throw new Error(`${name}: HTTP${r.response.status}; ${r.flightError ? "server action error" : String(r.result?.message ?? "unparsed action result")}`);
  return r.result;
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), wait(5000)]);
  if (child.exitCode === null && child.signalCode === null) throw new Error("Owned HTTP journey server did not stop; no unrelated process was touched.");
}

async function main() {
  for (const port of [DB_PORT, APP_PORT, MEDIA_PORT]) if (!await portFree(port)) throw new Error(`Reserved port${port} is occupied; no process was stopped.`);
  const buildId = fs.readFileSync(path.join(COMPILED_BASE, ".next/BUILD_ID"), "utf8").trim();
  if (fs.existsSync(path.join(COMPILED_BASE, ".env"))) throw new Error("The HTTP acceptance base must not contain a real environment file.");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-pro-http-")); fs.chmodSync(runtime, 0o700);
  builtRoot = path.join(runtime, "compiled-app"); fs.mkdirSync(path.join(builtRoot, ".next"), { recursive: true, mode: 0o700 });
  // Immutable production runtime copy; development cache/trace files are not
  // runtime inputs. The coordinated checkout can build again after this copy.
  for (const entry of fs.readdirSync(path.join(COMPILED_BASE, ".next"), { withFileTypes: true })) if ((entry.isDirectory() && ["server", "static", "node_modules"].includes(entry.name)) || (entry.isFile() && (entry.name.endsWith(".json") || entry.name === "BUILD_ID"))) fs.cpSync(path.join(COMPILED_BASE, ".next", entry.name), path.join(builtRoot, ".next", entry.name), { recursive: true, verbatimSymlinks: true });
  for (const file of ["package.json", "next.config.ts"]) fs.copyFileSync(path.join(COMPILED_BASE, file), path.join(builtRoot, file));
  fs.symlinkSync(path.join(COMPILED_BASE, "node_modules"), path.join(builtRoot, "node_modules"), "dir");
  if (fs.existsSync(path.join(COMPILED_BASE, "public"))) fs.cpSync(path.join(COMPILED_BASE, "public"), path.join(builtRoot, "public"), { recursive: true });
  console.log(`Independent exact compiled runtime prepared: ${builtRoot}`);
  const stateFile = path.join(runtime, "fake-provider-inputs.json"), privateFile = path.join(runtime, "private-sessions.json"), operationLog = path.join(runtime, "fake-operations.jsonl"), serverLog = path.join(runtime, "next-server.log");
  const secret = randomBytes(32).toString("hex"), password = `Isolated-${randomBytes(12).toString("hex")}`;
  const sample = buildSampleMp4();
  const db = await bootDrillDb({ port: DB_PORT, engine: "postgres", env: { APP_SECRET: secret, AUTH_ENFORCE: "true", NEXT_PUBLIC_APP_URL: BASE, DROPBOX_APP_KEY: "isolated-full-key", DROPBOX_APP_SECRET: "isolated-full-secret", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_drillstore_isolated", VERCEL_BLOB_API_URL: `http://127.0.0.1:${MEDIA_PORT}/blob` } });
  const fence = fenceFetch();
  let server: ChildProcess | undefined;
  let mediaServer: Server | undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(serverLog, "w", 0o600);
    const { prisma } = await import("@/lib/prisma");
    const { hashPassword } = await import("@/lib/auth/password");
    const { setSession } = await import("@/lib/auth/session");
    const { mintLoginLink } = await import("@/lib/portalAccess");
    const { etMonthKey, aryeoProductFor, monthSessionClocks } = await import("@/lib/contentProgram");
    const { PROGRAM_ROLLOUT_SETTING_KEY, serializeProgramRollout } = await import("@/lib/programRolloutCore");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { reconcileSessionRequests } = await import("@/lib/sessionRequests");
    const { outputBriefsFor } = await import("@/lib/deliverableOutputs");
    const { assignmentReceiptStates } = await import("@/lib/editorBriefReceipt");
    const { checkContextForSlot } = await import("@/lib/selfCheckStore");
    const { itemsFor } = await import("@/lib/selfCheck");
    const { FINAL_CHECK_KEYS } = await import("@/lib/finalRendition");
    const { mediaToken } = await import("@/lib/portalMedia");
    const { portalPlanning, sessionGate } = await import("@/lib/portal");
    const monthKey = etMonthKey(new Date());
    const f = await buildContentMonth(prisma, { name: "Pro HTTP Journey TEST", package: "Pro", project: false, monthKey, topics: [], portalToken: false, owner: { name: "Maya Grove", email: "maya-pro-http@example.test" } });
    const passwordHash = await hashPassword(password);
    const personas: { name: string; role: "OWNER" | "ADMIN" | "EDITOR" | "PHOTOGRAPHER"; email: string; id: string; teamMemberId: string; cookie: string | null }[] = [];
    for (const [name, role, editorKey] of [["Jordan", "OWNER", null], ["Kyle", "ADMIN", null], ["James", "ADMIN", null], ["Kim", "EDITOR", "kim"], ["Harrison", "PHOTOGRAPHER", null]] as const) {
      const tm = await prisma.teamMember.create({ data: { name, email: `${name.toLowerCase()}-pro-http@example.test`, role: role === "EDITOR" || role === "OWNER" ? "MANAGER" : role, active: true } });
      const u = await prisma.appUser.create({ data: { name, email: tm.email!, role, editorKey, teamMemberId: tm.id, status: "ACTIVE", passwordHash } });
      personas.push({ name, role, email: u.email, id: u.id, teamMemberId: tm.id, cookie: null as string | null });
    }
    const [owner, kyle, james, kim, photographer] = personas;
    const providerId = randomUUID(), providerUserId = randomUUID(), productId = aryeoProductFor("Pro")!.productId;
    await prisma.teamMember.update({ where: { id: photographer.teamMemberId }, data: { aryeoTeamMemberId: providerId } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const login = await mintLoginLink(f.membershipId!, owner.id);
    await prisma.client.update({ where: { id: f.clientId }, data: { name: "Grove Pro Journey Realty", email: "maya-pro-http@example.test", autoConfirmationText: false, autoDeliveryText: false } });
    const since = new Date(Date.now() - 60_000).toISOString();
    const pilotInput = serializeProgramRollout({ mode: "PILOT", modeSince: since, pilot: { clientIds: [f.clientId], operations: ["portal_sign_in", "portal_layout_v2"], approvedBy: "declared isolated fixture", approvedAt: since, expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(), joinedAt: { [f.clientId]: since }, note: "Disposable causal HTTP acceptance through two declared future filming visits only; one initial fourteen-day window" } });
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: pilotInput } });
    await prisma.programAutomation.create({ data: { key: "portal_layout_v2", enabled: true, enabledBy: "declared isolated layout input", enabledAt: new Date() } });
    await prisma.appSetting.createMany({ data: [{ key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: james.teamMemberId, backupReviewerTeamMemberId: kyle.teamMemberId }) }, { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) }] });
    await saveSecret("dropbox", "isolated-pro-http-refresh"); await saveSecret("ai", "isolated-pro-http-model-key"); await saveSecret("aryeo", "isolated-pro-http-read-key");
    const state: State = { dbPort: DB_PORT, operationLog, rawFolders: [], monthKey, topics, strategy, sampleSize: sample.length, productId, providerId, providerUserId, clockOffsetMs, blobs: {}, files: {} };
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    // The real compiled Blob SDK uses bundled undici; its supported API URL
    // points only at this declared loopback metadata fixture, with real guards.
    mediaServer = createServer((req, res) => {
      const requested = new URL(req.url || "/", `http://127.0.0.1:${MEDIA_PORT}`), provider = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
      const blobUrl = requested.searchParams.get("url"), blob = blobUrl ? provider.blobs[blobUrl] : null;
      if (req.method !== "GET" || requested.pathname !== "/blob" || !blob) { res.writeHead(404); res.end(); return; }
      fs.appendFileSync(operationLog, JSON.stringify({ op: "fake-blob-head" }) + "\n", { mode: 0o600 });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ url: blobUrl, downloadUrl: blobUrl, pathname: blob.pathname, size: Buffer.from(blob.bytes, "base64").length, contentType: "video/mp4", uploadedAt: new Date().toISOString(), etag: "fake-exact-object" }));
    });
    await new Promise<void>((resolve, reject) => { mediaServer!.once("error", reject); mediaServer!.listen(MEDIA_PORT, "127.0.0.1", resolve); });
    const privateManifest = { candidate: CANDIDATE, buildId, base: BASE, password, personas, signIn: login.url, clientCookie: null as string | null, enrollmentId: f.enrollmentId, monthId: f.monthId, warning: "Disposable exact HTTP action fixture only; no real provider/send/browser/watch evidence." };
    fs.writeFileSync(privateFile, JSON.stringify(privateManifest, null, 2), { mode: 0o600 });
    server = spawn(process.execPath, [path.join(builtRoot, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(APP_PORT)], { cwd: builtRoot, env: { ...process.env, NODE_ENV: "production", AUTH_ENFORCE: "true", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "_pro-session-http-preload.cjs"))}`, RTP_HTTP_FIXTURE: stateFile }, stdio: ["ignore", fd, fd] });
    console.log(`Owned Next PID${server.pid} app3214 DB5604; exact build${buildId}; private runtime${runtime}`);
    let ready = false;
    for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw new Error("Owned server stopped during setup; inspect private server log."); try { if ((await get("/login")).status === 200) { ready = true; break; } } catch { /* wait only for our known process */ } await wait(500); }
    if (!ready) throw new Error("Owned server did not become ready in30s.");
    for (const person of personas) { const form = new FormData(); form.set("email", person.email); form.set("password", password); form.set("next", "/"); const logged = await action("/login", "src/app/login/actions.ts", "loginWithPassword", [form]); person.cookie = cookieFrom(logged.response, "rtp_session"); if (logged.response.status !== 200 || logged.flightError || logged.result?.ok !== true || !person.cookie) throw new Error("Isolated signed staff password transport failed."); }
    const entered = await get(login.url); privateManifest.clientCookie = cookieFrom(entered, "rtp_client");
    if (entered.status !== 303 || !privateManifest.clientCookie) throw new Error("One-use client login failed.");
    const clientCookie = privateManifest.clientCookie;
    const auth = { enrollmentId: f.enrollmentId }, contentUrl = `/content/${f.enrollmentId}`, portalUrl = "/portal/me";
    fs.writeFileSync(privateFile, JSON.stringify(privateManifest, null, 2), { mode: 0o600 });
    const staff = (name: string, args: unknown[], cookie = owner.cookie) => must(contentUrl, "src/app/content/actions.ts", name, args, cookie);
    const client = (name: string, args: unknown[]) => must(portalUrl, "src/app/portal/actions.ts", name, [auth, ...args], clientCookie);
    const providerState = () => JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
    const saveProvider = (s: State) => fs.writeFileSync(stateFile, JSON.stringify(s), { mode: 0o600 });
    const advanceAfterVisit = async (at: Date) => {
      clockOffsetMs = at.getTime() + 60_000 - RealDate.now();
      const s = providerState(); s.clockOffsetMs = clockOffsetMs; saveProvider(s);
      // Renew actual staff authentication after the declared clock advance.
      // The original client cookie lasts 30 days; no new client link is minted.
      // The initial bounded pilot stays unchanged throughout both sessions.
      for (const person of personas) {
        const form = new FormData(); form.set("email", person.email); form.set("password", password); form.set("next", "/");
        const loginAgain = await action("/login", "src/app/login/actions.ts", "loginWithPassword", [form]);
        person.cookie = cookieFrom(loginAgain.response, "rtp_session");
        if (!person.cookie || loginAgain.flightError || loginAgain.result?.ok !== true) throw new Error("Staff cookie was not renewed.");
      }
    };

    c.head("Declared existing strategy and prior call → normal later Pro month");
    const { createStrategyVersion, approveStrategyVersion, releaseStrategyVersion } = await import("@/lib/contentStrategy");
    const priorMonth = new Date(`${monthKey}-15T12:00:00Z`); priorMonth.setUTCMonth(priorMonth.getUTCMonth() - 1);
    await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: etMonthKey(priorMonth), videosOwed: 8, status: "COMPLETE", historical: true, strategyCallStatus: "COMPLETED" } });
    const baseline = await createStrategyVersion({ enrollmentId: f.enrollmentId, createdBy: "declared existing strategy fixture", sourceKind: "import", sourceRef: "isolated-prior-approved-strategy", stored: { structureVersion: "LEGACY", document: null, sections: [
      { id: "brand", number: 1, order: 1, heading: "Brand Overview", text: "Maya Grove gives warm, calm, direct seller advice. Honesty and preparation. Clear advice, calm process." },
      { id: "audience", number: 2, order: 2, heading: "Target Audience", text: "Move-up buyers and sellers in West Chester who want to prepare their homes and understand each step." },
      { id: "goals", number: 3, order: 3, heading: "Content Goals", text: "Explain pricing, prepare sellers, show local knowledge and publish useful video advice." },
    ] } });
    await approveStrategyVersion(baseline.versionId, owner.email); await releaseStrategyVersion(baseline.versionId, owner.email);
    const pillar = await prisma.contentPillar.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, strategyVersionId: baseline.versionId, name: "Seller Strategy", status: "ACTIVE", purpose: "Practical seller preparation", createdBy: owner.email } });
    await client("portalPlanWithoutCall", [f.monthId]);
    for (const t of topics) {
      await staff("addTopic", [f.enrollmentId, { title: t.title, concept: t.words, source: "staff", pillarId: pillar.id }], kyle.cookie);
      const topic = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, title: t.title } });
      await staff("topicDecision", [topic.id, "APPROVE", "Declared Pro topic, matched to approved strategy"], kyle.cookie);
    }
    c.ok("ordinary Pro client has eight videos/two sessions and explicitly chose eligible written planning", f.videosPerMonth === 8 && f.sessionsPerMonth === 2 && (await portalPlanning({ id: f.enrollmentId, clientId: f.clientId }, f.monthId))?.planningMode === "WRITTEN" && await prisma.contentScript.count({ where: { monthId: f.monthId } }) === 0 && await prisma.project.count() === 0);
    await must("/upload/welcome", "src/app/upload/actions.ts", "acknowledgeUploadProcess", [], photographer.cookie);

    const sessionResults: { projectId: string; root: string; planId: string; street: string; requestId: string; anchorAt: number; earliestAt: number; appointmentId: string; endAt: number; topicIds: string[]; scriptIds: string[]; outputIds: string[]; cutIds: string[]; bytes: Buffer[] }[] = [];
    for (const sessionIndex of [1, 2]) {
      c.head(`Pro session ${sessionIndex}: its own material, address, request and four exact outputs`);
      const before = await sessionGate(f.enrollmentId, f.monthId, { sessionIndex });
      c.ok(`session ${sessionIndex} cannot inherit the other session's completed material`, before.locked);
      const start = (sessionIndex - 1) * 4, batch = topics.slice(start, start + 4);
      const topicIds: string[] = [], answerIds: string[] = [];
      for (const t of batch) {
        const row = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, title: t.title } }); topicIds.push(row.id);
        await client("portalSelectTopic", [row.id, f.monthId]);
        const opened = await client("portalOpenInterview", [row.id, f.monthId]);
        const interviewId = String(opened.id);
        const answers = {
          audienceProblem: `Move-up sellers preparing their West Chester home worry about ${t.title.toLowerCase()} and making a rushed decision.`,
          pointOfView: `${t.words} My view is that a clear plan is more useful than rushing this decision.`,
          talkingPoints: `1. Compare the available choices before making the decision.\n2. Write the next step on a checklist; for example, prepare a folder before the meeting.\n3. Leave time to ask questions so the seller understands what happens next.`,
          evidence: "I am giving general preparation advice, not claiming a client outcome or a statistic.",
          story: `We can show a written checklist for ${t.title.toLowerCase()} and compare an unprepared folder with an organized folder.`,
          nextAction: "Write down your next question before meeting your agent so the conversation has a useful starting point.",
        };
        for (const [key, words] of Object.entries(answers)) await client("portalAnswerInterview", [interviewId, key, words, "TYPED"]);
        const { interviewState } = await import("@/lib/contentInterview");
        for (let step = 0; step < 12; step++) {
          const current = await interviewState(interviewId, { readOnly: true });
          if (current.next.kind === "done") break;
          if (!current.nextKey) throw new Error("An unfinished interview did not name its next question.");
          await client("portalAnswerInterview", [interviewId, current.nextKey, answers[current.next.question.id], "TYPED"]);
        }
        const submitted = await client("portalSubmitInterview", [interviewId]);
        if (submitted.status !== "SUBMITTED") throw new Error("Written session material did not meet the actual sufficiency rule.");
        answerIds.push(...(await prisma.contentInterviewAnswer.findMany({ where: { interviewId }, select: { id: true } })).map((a) => a.id));
      }
      const ready = await sessionGate(f.enrollmentId, f.monthId, { sessionIndex });
      c.ok(`session ${sessionIndex} opens on its own submitted material and weekday preparation window`, !ready.locked && ready.preparation?.anchor?.kind === "SUBMISSION" && ready.preparation.windowHours === 72 && ready.earliest.getTime() > ready.preparation.anchor.at.getTime());
      if (sessionIndex === 1) c.ok("second session stays closed after first session material is complete", (await sessionGate(f.enrollmentId, f.monthId, { sessionIndex: 2 })).locked);
      await staff("draftOwedScriptsAction", [f.monthId]);
      const scripts = await prisma.contentScript.findMany({ where: { monthId: f.monthId, topicId: { in: topicIds } } });
      if (scripts.length !== 4) throw new Error(`Session ${sessionIndex} generated ${scripts.length}/4 scripts; inspect isolated model trace.`);
      for (const script of scripts) {
        await staff("approveScriptVersionAction", [script.currentVersionId, "Exact isolated words reviewed against this session's source answers"]);
        await staff("releaseScriptAction", [script.id]);
        const released = await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id } });
        await client("portalApproveScript", [script.id, released.sharedVersionId]);
      }
      const agreed = await prisma.contentScript.findMany({ where: { id: { in: scripts.map((s) => s.id) } } });
      const versions = await prisma.contentScriptVersion.findMany({ where: { id: { in: agreed.map((s) => s.sharedVersionId!) } } });
      c.ok(`session ${sessionIndex} retains four exact released/client-approved versions and its own answer provenance`, agreed.every((s) => s.sharedVersionId && s.clientApprovedVersionId === s.sharedVersionId && s.clientApprovedByUserId === f.clientUserId) && versions.length === 4 && versions.every((v) => { const refs: unknown = v.answerIdsJson ? JSON.parse(v.answerIdsJson) : null; return v.strategyVersionId === baseline.versionId && Array.isArray(refs) && refs.length > 0 && refs.every((id) => typeof id === "string" && answerIds.includes(id)); }));
      const addressInput = { street: sessionIndex === 1 ? "117 First Lane" : "228 Second Street", city: "West Chester", state: "PA", zip: "19382" };
      const address = await client("portalSaveSessionPlanAddress", [f.monthId, sessionIndex, addressInput]);
      const planId = String(address.planId), plan = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: planId } });
      const slots = await client("portalSessionSlots", [f.monthId, sessionIndex]);
      const slotISO = (slots.days as { slots: string[] }[]).flatMap((d) => d.slots)[0];
      if (!slotISO) throw new Error(`Session ${sessionIndex} has no offered exact-address slot.`);
      if (sessionIndex === 2) {
        const first = sessionResults[0];
        const wrong = await action(portalUrl, "src/app/portal/actions.ts", "portalRequestSession", [auth, { monthId: f.monthId, slotISO, planId: first.planId, addressVersion: 1, sessionIndex }], clientCookie);
        c.ok("second session refuses the first session's address plan", wrong.result?.ok === false && await prisma.programSessionRequest.count({ where: { monthId: f.monthId } }) === 1);
      }
      const asked = await client("portalRequestSession", [{ monthId: f.monthId, slotISO, planId, addressVersion: plan.addressVersion, sessionIndex }]);
      const requestId = String(asked.requestId), request = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: requestId } });
      const root = `/isolated/pro-http/session-${sessionIndex}`, s = providerState(); s.rawFolders.push(root); saveProvider(s);
      const project = await prisma.project.create({ data: { clientId: f.clientId, contentMonthId: f.monthId, title: `${addressInput.street} — Pro session ${sessionIndex}`, addressLine: `${addressInput.street}, West Chester, PA 19382`, packageName: "Video Pro", status: "SCHEDULED", photographerId: photographer.teamMemberId, editorId: kim.teamMemberId, editorManual: true, shootDate: new Date(slotISO), aryeoOrderId: `isolated-pro-order-${sessionIndex}`, dropboxFolder: root } });
      const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Video Pro", productTitle: "Video Pro", quantity: 4 } });
      const endAt = new Date(new Date(slotISO).getTime() + 4 * 3_600_000);
      const appointment = await prisma.appointment.create({ data: { projectId: project.id, aryeoId: `isolated-pro-appointment-${sessionIndex}`, startAt: new Date(slotISO), endAt, durationMin: 240, status: "SCHEDULED", assignedToId: photographer.teamMemberId } });
      await reconcileSessionRequests();
      c.ok(`session ${sessionIndex} exact address/window request reconciles only its declared four-hour imported appointment`, request.sessionIndex === sessionIndex && request.requestedByClientUserId === f.clientUserId && request.gateWindowHours === 72 && request.gateAnchorAt?.getTime() === ready.preparation?.anchor?.at.getTime() && new Date(slotISO) >= ready.earliest && (await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: requestId } })).aryeoAppointmentId === appointment.aryeoId && await prisma.smartTask.count({ where: { dedupeKey: `content-session-request-${requestId}`, status: "COMPLETED", assignedKey: "kyle" } }) === 1);
      await advanceAfterVisit(endAt);
      const handoff = await action(`/upload/${project.id}`, "src/app/upload/actions.ts", "finalizeUpload", [project.id, { editorBrief: `Four Pro session ${sessionIndex} videos only.`, cullingConfirmed: true, videoInstructions: `Use session ${sessionIndex} accepted scripts and its own raw folder.`, videosFilmed: 4, filmedTopicIds: topicIds, topicNotes: Object.fromEntries(agreed.map((script) => [script.topicId, `Session ${sessionIndex}: retain exact accepted script ${script.sharedVersionId}.`])), scriptConfirm: { state: "as-written" }, sawScript: true }], photographer.cookie);
      const outputs = await prisma.deliverableOutput.findMany({ where: { projectId: project.id, removedFromOrderAt: null }, orderBy: { slot: "asc" } });
      const handoffProof = { http: handoff.response.status === 200 && !handoff.flightError, unblocked: !!handoff.result?.handoff && !handoff.result.blocked && !handoff.result.needsConfirm && !handoff.result.topicsPending, ownFour: outputs.length === 4, exactNotes: outputs.every((o) => topicIds.includes(o.topicId!) && agreed.some((script) => script.topicId === o.topicId && o.filmingNote?.includes(script.sharedVersionId!))), applied: await prisma.contentFilmingReport.count({ where: { projectId: project.id, state: "APPLIED" } }) === 1, notStarted: await prisma.editorWorkItem.count({ where: { projectId: project.id } }) === 0 };
      c.ok(`session ${sessionIndex} photographer handoff binds only its four topics/scripts/raw folder and leaves editor clock stopped`, Object.values(handoffProof).every(Boolean), JSON.stringify({ facts: handoffProof, response: handoff.result, errors: handoff.flightErrors, slots: outputs.map((o) => ({ slot: o.slot, topicId: o.topicId, filmingNote: o.filmingNote })), project: await prisma.project.findUnique({ where: { id: project.id }, select: { videosFilmed: true, videosOwedOverride: true } }), row: await prisma.deliverable.findUnique({ where: { id: deliverable.id }, select: { quantity: true } }) }));
      for (const output of outputs) {
        const brief = (await outputBriefsFor(project.id)).find((b) => b.outputId === output.id)!;
        await must(`/edit/${project.id}`, "src/app/editing/actions.ts", "saveVideoBrief", [project.id, output.id, {}, brief.version, null, "none"], kyle.cookie);
      }
      const context = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      const receipts = await assignmentReceiptStates(project.id, await outputBriefsFor(project.id, { scrub: true }), context);
      for (const output of outputs) await must(`/edit/${project.id}`, "src/app/edit/[id]/receipt.actions.ts", "acknowledgeEditorBrief", [project.id, output.id, receipts.get(output.id)?.digest], kim.cookie);
      const queue = (label: string) => must("/editing", "src/app/editing/actions.ts", "setQueueStatus", [project.id, label, randomUUID()], kim.cookie);
      await queue("In editing"); await queue("Paused");
      c.ok(`session ${sessionIndex} has separate exact receipts and manual Start/Pause`, await prisma.editorBriefReceipt.count({ where: { projectId: project.id, editorKey: "kim", actorUserId: kim.id } }) === 4 && await prisma.editorWorkItem.count({ where: { projectId: project.id, editorKey: "kim", state: "PAUSED" } }) === 1);
      await queue("In editing");
      const cutIds: string[] = [], cutBytes: Buffer[] = [];
      for (const output of outputs) {
        const ctx = await checkContextForSlot(project.id, { deliverableId: deliverable.id, slot: output.slot }, { round: 1 });
        const name = `session-${sessionIndex}-video-${output.slot}.mp4`, tag = Buffer.from(name), atom = Buffer.alloc(8); atom.writeUInt32BE(8 + tag.length); atom.write("free", 4); const bytes = Buffer.concat([sample, atom, tag]);
        const check = { checklistKey: ctx.profile.checklistKey, answers: Object.fromEntries(itemsFor(ctx.profile, { isRevision: ctx.isRevision, openIssueIds: ctx.issues.map((i) => i.id) }).map((i) => [i.key, { answer: "YES" }])), issues: { addressed: [], notAddressed: {} }, watchedFile: { name, size: bytes.length } };
        const reserved = await must(`/edit/${project.id}`, "src/app/review/actions.ts", "startCutUpload", [{ projectId: project.id, deliverableId: deliverable.id, slot: output.slot, fileName: name, sizeBytes: bytes.length, width: 1080, height: 1920, selfCheck: check }], kim.cookie);
        const submissionId = String(reserved.submissionId), pathname = `${reserved.pathname}-declared.mp4`, url = `https://drillstore.public.blob.vercel-storage.com/${pathname}`, state = providerState();
        state.blobs[url] = { pathname, bytes: bytes.toString("base64") }; saveProvider(state);
        await must(`/edit/${project.id}`, "src/app/review/actions.ts", "finishCutUpload", [{ submissionId, url, pathname }], kim.cookie);
        await must(`/review/${project.id}`, "src/app/review/actions.ts", "approveCut", [submissionId], james.cookie);
        const live = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: submissionId } });
        if (!live.finalPath?.startsWith(root) || !live.completedAt) throw new Error("Session final backup did not retain its exact raw-folder root.");
        const read = await must("/", "src/app/ops/finalRenditionActions.ts", "finalFileChoicesAction", [submissionId], kyle.cookie), choices = read.choices as { id: string; url: string }[];
        if (choices.length !== 1) throw new Error("Expected one exact final rendition per Pro output.");
        const preview = await get(choices[0].url, kyle.cookie);
        if (preview.status !== 200 || !Buffer.from(await preview.arrayBuffer()).equals(bytes)) throw new Error("Pro final preview bytes changed.");
        const form = new FormData(); form.set("submissionId", submissionId); form.set("mediaId", choices[0].id); form.set("attemptId", randomUUID()); FINAL_CHECK_KEYS.forEach((key) => form.set(key, "yes"));
        await must("/", "src/app/ops/finalRenditionActions.ts", "recordFinalFileCheckAction", [form], kyle.cookie);
        await must("/", "src/app/ops/actions.ts", "markVideoSentAction", [submissionId, "not-yet"], kyle.cookie);
        const video = await prisma.contentVideo.findFirstOrThrow({ where: { currentSubmissionId: submissionId } });
        const token = mediaToken(video.id, { kind: "membership", id: f.membershipId! }), download = `/api/portal/download/${video.id}?m=${encodeURIComponent(token)}`;
        if ((await get(download, clientCookie)).status !== 403) throw new Error("Pro portal handoff incorrectly bypassed exact client approval.");
        await client("portalApproveCut", [submissionId, "NONE"]);
        const door = await get(download, clientCookie), destination = door.headers.get("location");
        if (!destination) throw new Error("Approved Pro output did not yield a canonical download.");
        const downloaded = await get(destination, clientCookie), final = providerState().files[live.finalPath];
        c.ok(`session ${sessionIndex} output ${output.slot} has James/client exact approval and matching final portal/Dropbox bytes`, door.status === 302 && downloaded.status === 200 && Buffer.from(await downloaded.arrayBuffer()).equals(bytes) && !!final && Buffer.from(final.bytes, "base64").equals(bytes) && live.decidedByUserId === james.id && video.outputId === output.id && video.scriptVersionId === agreed.find((script) => script.topicId === output.topicId)?.sharedVersionId);
        cutIds.push(submissionId); cutBytes.push(bytes);
      }
      sessionResults.push({ projectId: project.id, root, planId, street: addressInput.street, requestId, anchorAt: request.gateAnchorAt!.getTime(), earliestAt: request.gateEarliestAt!.getTime(), appointmentId: appointment.id, endAt: endAt.getTime(), topicIds, scriptIds: agreed.map((script) => script.id), outputIds: outputs.map((output) => output.id), cutIds, bytes: cutBytes });
      if (sessionIndex === 1) c.ok("first session's four final approvals do not unlock unplanned second-session scheduling", await prisma.clientDecision.count({ where: { submissionId: { in: cutIds }, decision: "APPROVE", clientUserId: f.clientUserId } }) === 4 && (await sessionGate(f.enrollmentId, f.monthId, { sessionIndex: 2 })).locked);
    }
    const [first, second] = sessionResults, clocks = await monthSessionClocks(f.monthId);
    c.ok("Pro production clocks stay on each distinct four-hour appointment end", clocks.length === 2 && clocks.every((clock) => { const s = sessionResults.find((item) => item.appointmentId === clock.appointmentId); return s && clock.anchorAt?.getTime() === s.endAt && clock.bookedMinutes === 240 && clock.packageMinutes === 240 && !clock.anchorEstimated && !!clock.productionTargetAt && !!clock.productionDueAt; }) && clocks[0].productionDueAt!.getTime() !== clocks[1].productionDueAt!.getTime());
    const savedPlans = await prisma.programSessionPlan.findMany({ where: { id: { in: sessionResults.map((s) => s.planId) } } });
    c.ok("second session owns a later material anchor/window and distinct address, request, script, output and raw-root identities", second.anchorAt > first.anchorAt && second.earliestAt > first.earliestAt && first.planId !== second.planId && first.requestId !== second.requestId && first.root !== second.root && second.topicIds.every((id) => !first.topicIds.includes(id)) && second.scriptIds.every((id) => !first.scriptIds.includes(id)) && second.outputIds.every((id) => !first.outputIds.includes(id)) && savedPlans.length === 2 && sessionResults.every((s, i) => { const plan = savedPlans.find((p) => p.id === s.planId); return plan?.sessionIndex === i + 1 && `${plan.streetNumber} ${plan.streetName}` === s.street && plan.city === "West Chester" && plan.stateCode === "PA" && plan.postalCode === "19382" && plan.requestId === s.requestId; }));
    const allCuts = sessionResults.flatMap((s) => s.cutIds), library = await (await get(`${portalUrl}?tab=library`, clientCookie)).text();
    c.ok("same ordinary client library retains all eight independently approved exact outputs", library.includes("Grove Pro Journey Realty") && await prisma.contentVideo.count({ where: { enrollmentId: f.enrollmentId, approvedSubmissionId: { in: allCuts } } }) === 8 && await prisma.clientDecision.count({ where: { submissionId: { in: allCuts }, clientUserId: f.clientUserId, decision: "APPROVE" } }) === 8);
    const operations = fs.readFileSync(operationLog, "utf8");
    c.ok("Pro branch uses both raw folders and no booking/send/worker activation", sessionResults.every((s) => operations.includes(`fake-dropbox:files/list_folder:${s.root}`)) && await prisma.outboxMessage.count() === 0 && await prisma.programBookingAttempt.count() === 0 && await prisma.programAutomation.count({ where: { enabled: true, key: { not: "portal_layout_v2" } } }) === 0 && (await prisma.appSetting.findUniqueOrThrow({ where: { key: PROGRAM_ROLLOUT_SETTING_KEY } })).value === pilotInput && fence.blocked.length === 0 && !fs.readFileSync(serverLog, "utf8").includes("OUTBOUND BLOCKED"));
    fs.writeFileSync(privateFile, JSON.stringify({ ...privateManifest, clientCookie, sessionResults: sessionResults.map(({ bytes, ...rest }) => ({ ...rest, byteLengths: bytes.map((b) => b.length) })) }, null, 2), { mode: 0o600 });
    console.log("Evidence: two causal Pro sessions through actual signed HTTP actions; prior strategy/call, imported bookings/raw arrivals, clock progression and watch ticks are declared synthetic inputs. No real provider, browser, phone or human-watch acceptance.");
    console.log(await db.evidence()); c.summary();
  } finally {
    // Failure to close one owned resource must not skip the remaining cleanup.
    // The rejection still fails the drill instead of claiming a clean teardown.
    try { await stop(server); }
    finally {
      try {
        if (mediaServer?.listening) await new Promise<void>((resolve, reject) => mediaServer!.close((error) => error ? reject(error) : resolve()));
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); }
        finally {
          try { await db.stop(); }
          finally { try { fence.restore(); } finally { globalThis.Date = RealDate; } }
        }
      }
    }
    console.log("Stopped only owned Next3214/disposable DB5604/fake metadata5606; other fixtures and main preview untouched.");
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Isolated Pro HTTP journey failed."); process.exitCode = 1; });
