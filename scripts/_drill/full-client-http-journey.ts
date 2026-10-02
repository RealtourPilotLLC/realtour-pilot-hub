// @drill-run: engine=postgres timeout=900
// ONE causal first-month journey through the exact built HTTP actions.
// Starts without strategy/topics/scripts/project/cuts. Provider arrivals and
// model output are explicitly fake inputs; no browser/watch/provider evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { buildSampleMp4 } from "../demo/sample";

const CHECKOUT = "/Users/jordanspackman/.codex/worktrees/audit-visual-check/Realtour Pilot POT Dashboard";
const FROZEN_BASE = "/private/tmp/rtp-full-http-ab6-compiled-base";
const COMPILED_BASE = fs.existsSync(path.join(FROZEN_BASE, "fixture-build-proof.json")) ? FROZEN_BASE : CHECKOUT;
const CANDIDATE = "ab6cfdf37314c2107f4a286446f95e396811c5b2";
let builtRoot = CHECKOUT;
const DB_PORT = 5601, APP_PORT = 3211, MEDIA_PORT = 5602, BASE = `http://127.0.0.1:${APP_PORT}`;
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
  { title: "Price for the first weekend", words: "The first weekend decides your price. Buyers compare competing homes, read days on market and look for a clear reason to make an offer. Price it correctly from the start." },
  { title: "Prepare for a buyer's first visit", words: "Before buyers arrive, open the blinds, clear the entry and finish the small repairs. The visit should make it easy to picture living there. Prepare the house before launch." },
];
const strategy = {
  clientName: "Maya Grove", subtitle: "Built around Trust, Value, Credibility, and Entertainment",
  brandOverview: { coreValues: "Honesty and preparation", brandMessage: "Calm advice for West Chester sellers", shortBrandStatement: "Clear advice, calm process", brandVoice: "Warm, calm, direct" },
  targetAudience: { primaryServiceAreas: "West Chester", pricePositioning: "Move-up homes", primaryClientTypes: "Move-up buyers and sellers", longTermPositioningGoal: "Be the local name for a well-prepared move" },
  contentGoals: ["Explain pricing clearly", "Help sellers prepare", "Show local knowledge", "Publish useful video advice"],
  contentPillars: { preamble: "Build Trust through empathy, provide Value with a practical takeaway, establish Credibility with clear reasoning, and create Entertainment through curiosity.", pillars: ["Seller Strategy", "Buyer Guidance", "Local Life", "Behind the Scenes"].map((name) => ({ name, purpose: `Useful ${name.toLowerCase()} advice`, focusAreas: `Real decisions in ${name.toLowerCase()}`, contentApproach: "One useful idea at a time" })) },
  framework: "policy", captionCtaExamples: ["Save this before you list.", "Ask me about your next move.", "Share this with a seller."], strategicDirection: "Lead with pricing clarity and preparation.", gaps: [],
};
type State = { dbPort: number; operationLog: string; monthKey: string; topics: typeof topics; strategy: typeof strategy; sampleSize: number; productId: string; providerId: string; providerUserId: string; clockOffsetMs: number; blobs: Record<string, { pathname: string; bytes: string }>; files: Record<string, { id: string; rev: string; hash: string; bytes: string }> };
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
  for (const port of [DB_PORT, APP_PORT, 5602]) if (!await portFree(port)) throw new Error(`Reserved port${port} is occupied; no process was stopped.`);
  const buildId = fs.readFileSync(path.join(COMPILED_BASE, ".next/BUILD_ID"), "utf8").trim();
  if (COMPILED_BASE === CHECKOUT) {
    const pointer = fs.readFileSync(path.join(CHECKOUT, ".git"), "utf8").trim().replace(/^gitdir: /, "");
    if (fs.readFileSync(path.join(pointer, "HEAD"), "utf8").trim() !== CANDIDATE) throw new Error("The coordinated built checkout no longer matches the reserved candidate.");
  } else {
    const proof = JSON.parse(fs.readFileSync(path.join(COMPILED_BASE, "fixture-build-proof.json"), "utf8"));
    if (proof.candidate !== CANDIDATE || proof.buildId !== buildId) throw new Error("Independent compiled base proof does not match the declared candidate/build.");
  }
  if (fs.existsSync(path.join(COMPILED_BASE, ".env"))) throw new Error("The HTTP acceptance base must not contain a real environment file.");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-full-http-")); fs.chmodSync(runtime, 0o700);
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
  let mediaServer: ReturnType<typeof createServer> | undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(serverLog, "w", 0o600);
    const { prisma } = await import("@/lib/prisma");
    const { hashPassword } = await import("@/lib/auth/password");
    const { setSession } = await import("@/lib/auth/session");
    const { mintLoginLink } = await import("@/lib/portalAccess");
    const { etMonthKey, aryeoProductFor } = await import("@/lib/contentProgram");
    const { PROGRAM_ROLLOUT_SETTING_KEY, serializeProgramRollout } = await import("@/lib/programRolloutCore");
    const { createManualCallRecord } = await import("@/lib/contentCallRecords");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { reconcileSessionRequests } = await import("@/lib/sessionRequests");
    const { outputBriefsFor } = await import("@/lib/deliverableOutputs");
    const { assignmentReceiptStates } = await import("@/lib/editorBriefReceipt");
    const { checkContextForSlot } = await import("@/lib/selfCheckStore");
    const { itemsFor } = await import("@/lib/selfCheck");
    const { FINAL_CHECK_KEYS } = await import("@/lib/finalRendition");
    const { mediaToken } = await import("@/lib/portalMedia");
    const { portalPlanning } = await import("@/lib/portal");
    const monthKey = etMonthKey(new Date());
    const f = await buildContentMonth(prisma, { name: "Full HTTP Journey TEST", package: "Starter", project: false, monthKey, topics: [], portalToken: false, owner: { name: "Maya Grove", email: "maya-full-http@example.test" } });
    const passwordHash = await hashPassword(password), personas = [];
    for (const [name, role, editorKey] of [["Jordan", "OWNER", null], ["Kyle", "ADMIN", null], ["James", "ADMIN", null], ["Kim", "EDITOR", "kim"], ["Harrison", "PHOTOGRAPHER", null], ["John Mark", "EDITOR", "john"]] as const) {
      const tm = await prisma.teamMember.create({ data: { name, email: `${name.toLowerCase().replace(/\s+/g, "-")}-full-http@example.test`, role: role === "EDITOR" || role === "OWNER" ? "MANAGER" : role, active: true } });
      const u = await prisma.appUser.create({ data: { name, email: tm.email!, role, editorKey, teamMemberId: tm.id, status: "ACTIVE", passwordHash } });
      personas.push({ name, role, email: u.email, id: u.id, teamMemberId: tm.id, cookie: null as string | null });
    }
    const [owner, kyle, james, kim, photographer, john] = personas;
    const providerId = randomUUID(), providerUserId = randomUUID(), productId = aryeoProductFor("Starter")!.productId;
    await prisma.teamMember.update({ where: { id: photographer.teamMemberId }, data: { aryeoTeamMemberId: providerId } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const login = await mintLoginLink(f.membershipId!, owner.id);
    await prisma.client.update({ where: { id: f.clientId }, data: { name: "Grove Full Journey Realty", email: "maya-full-http@example.test", autoConfirmationText: false, autoDeliveryText: false } });
    const since = new Date(Date.now() - 60_000).toISOString();
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: serializeProgramRollout({ mode: "PILOT", modeSince: since, pilot: { clientIds: [f.clientId], operations: ["portal_sign_in", "portal_layout_v2"], approvedBy: "declared isolated fixture", approvedAt: since, expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), joinedAt: { [f.clientId]: since }, note: "Disposable causal HTTP acceptance through its declared future filming visit only" } }) } });
    await prisma.programAutomation.create({ data: { key: "portal_layout_v2", enabled: true, enabledBy: "declared isolated layout input", enabledAt: new Date() } });
    await prisma.appSetting.createMany({ data: [{ key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: james.teamMemberId, backupReviewerTeamMemberId: kyle.teamMemberId }) }, { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) }] });
    await saveSecret("dropbox", "isolated-full-http-refresh"); await saveSecret("ai", "isolated-full-http-model-key"); await saveSecret("aryeo", "isolated-full-http-read-key");
    const state: State = { dbPort: DB_PORT, operationLog, monthKey, topics, strategy, sampleSize: sample.length, productId, providerId, providerUserId, clockOffsetMs, blobs: {}, files: {} };
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    // The compiled Blob SDK bundles its own undici. Exercise that real SDK
    // over its supported loopback API override, not an action/head stub.
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
    server = spawn(process.execPath, [path.join(builtRoot, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(APP_PORT)], { cwd: builtRoot, env: { ...process.env, NODE_ENV: "production", AUTH_ENFORCE: "true", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "_full-client-http-preload.cjs"))}`, RTP_HTTP_FIXTURE: stateFile }, stdio: ["ignore", fd, fd] });
    console.log(`Owned Next PID${server.pid} app3211 DB5601; exact build${buildId}; private runtime${runtime}`);
    let ready = false;
    for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw new Error("Owned server stopped during setup; inspect private server log."); try { if ((await get("/login")).status === 200) { ready = true; break; } } catch { /* wait only for our known process */ } await wait(500); }
    if (!ready) throw new Error("Owned server did not become ready in30s.");
    for (const person of personas) { const form = new FormData(); form.set("email", person.email); form.set("password", password); form.set("next", "/"); const logged = await action("/login", "src/app/login/actions.ts", "loginWithPassword", [form]); person.cookie = cookieFrom(logged.response, "rtp_session"); if (logged.response.status !== 200 || logged.flightError || logged.result?.ok !== true || !person.cookie) throw new Error("Isolated signed staff password transport failed."); }
    const entered = await get(login.url); privateManifest.clientCookie = cookieFrom(entered, "rtp_client");
    if (entered.status !== 303 || !privateManifest.clientCookie) throw new Error("One-use client login failed.");
    const clientCookie = privateManifest.clientCookie, auth = { enrollmentId: f.enrollmentId }, contentUrl = `/content/${f.enrollmentId}`, portalUrl = "/portal/me";
    fs.writeFileSync(privateFile, JSON.stringify(privateManifest, null, 2), { mode: 0o600 });
    const staff = (name: string, args: unknown[], cookie = owner.cookie) => must(contentUrl, "src/app/content/actions.ts", name, args, cookie);
    const client = (name: string, args: unknown[]) => must(portalUrl, "src/app/portal/actions.ts", name, [auth, ...args], clientCookie);
    c.head("Empty onboarding → discovery transcript → exact released strategy and bank");
    c.ok("causal fixture begins signed with no released planning/production artifacts", personas.every((p) => !!p.cookie) && await prisma.contentStrategyVersion.count() === 0 && await prisma.contentTopic.count() === 0 && await prisma.contentScript.count() === 0 && await prisma.project.count() === 0 && await prisma.reviewSubmission.count() === 0);
    const discovery = await createManualCallRecord({ clientId: f.clientId, callType: "BRAND_DISCOVERY", scheduledStart: new Date(Date.now() - 3 * 86_400_000), by: owner.email, note: "Declared completed external discovery call; no provider booking" });
    const discoveryText = "Jordan: Tell me about your business and the clients you help.\nMaya Grove: I guide move-up buyers and sellers in West Chester. I explain each step so clients can prepare calmly. I value honesty, preparation and clear advice. I want useful videos about pricing and preparing a home.\nJordan: How should those videos sound?\nMaya Grove: Warm, calm and direct. Each should teach one practical idea, with a clear next step. This is my brand discovery call.";
    await must("/settings", "src/app/settings/calendlyActions.ts", "pasteTranscript", [discovery, discoveryText], owner.cookie);
    await staff("draftStrategyFromDiscovery", [f.enrollmentId]);
    const draft = await prisma.contentStrategyVersion.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId }, orderBy: { versionNo: "desc" } });
    c.ok("HTTP manual strategy drafting consumes the confirmed discovery source and remains unshared", draft.status === "DRAFT" && draft.callRecordId === discovery && !draft.releasedAt && await prisma.programTranscriptSource.count({ where: { callRecordId: discovery, text: discoveryText, createdBy: owner.email } }) === 1);
    await staff("approveStrategy", [draft.id]); await staff("releaseStrategy", [draft.id]);
    await staff("createPillarsFromStrategy", [draft.id]);
    const pillar = await prisma.contentPillar.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, name: "Seller Strategy" } });
    for (const t of topics) { await staff("addTopic", [f.enrollmentId, { title: t.title, concept: t.words, source: "ai", pillarId: pillar.id }], kyle.cookie); const topic = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, title: t.title } }); await staff("topicDecision", [topic.id, "APPROVE", "Matched to released strategy and monthly seller advice"], kyle.cookie); }
    const strategyHtml = await (await get(`${portalUrl}?tab=strategy`, clientCookie)).text(), topicsHtml = await (await get(`${portalUrl}?tab=topics`, clientCookie)).text();
    c.ok("same client receives released strategy and Kyle-approved bank before selection", strategyHtml.includes("Calm advice") && topics.every((t) => topicsHtml.includes(t.title)) && await prisma.contentTopicSelection.count() === 0);

    c.head("First CALL month → reconciled selections → exact script release and client acceptance");
    const monthly = await createManualCallRecord({ clientId: f.clientId, callType: "MONTHLY_STRATEGY", scheduledStart: new Date(Date.now() - 2 * 3_600_000), scheduledEnd: new Date(Date.now() - 90 * 60_000), targetMonthKey: monthKey, by: owner.email, note: "Declared completed external monthly call; no provider booking" });
    const monthlyText = `Jordan: Let's choose the two videos for ${monthKey}.\nMaya Grove: First, ${topics[0].title}. ${topics[0].words}\nJordan: What else would help your sellers?\nMaya Grove: ${topics[1].title}. ${topics[1].words}\nJordan: We will prepare these two scripts for your read-through.\nMaya Grove: Yes, these are my two videos for this month.`;
    await must("/settings", "src/app/settings/calendlyActions.ts", "pasteTranscript", [monthly, monthlyText], owner.cookie);
    // Supported manual month action with the same confirmed call words. The
    // queued ingest/analysis worker remains OFF and is not claimed as tested.
    await staff("saveMonthTranscript", [f.monthId, monthlyText]); await staff("analyzeTranscript", [f.monthId]);
    const selections = await prisma.contentTopicSelection.findMany({ where: { monthId: f.monthId }, orderBy: { rank: "asc" } });
    if (selections.length !== f.videosPerMonth) throw new Error("Manual monthly analysis did not produce the owed source-backed selections.");
    for (const s of selections) { await staff("reconcileTopicSelection", [s.topicId, f.monthId, true], kyle.cookie); await staff("topicDecision", [s.topicId, "APPROVE", "Confirmed from exact monthly call"], kyle.cookie); }
    await staff("generateMonthScripts", [f.monthId]);
    const scripts = await prisma.contentScript.findMany({ where: { monthId: f.monthId }, orderBy: { createdAt: "asc" } });
    if (scripts.length !== f.videosPerMonth) throw new Error("The confirmed CALL month did not draft every owed script.");
    for (const s of scripts) { await staff("approveScriptVersionAction", [s.currentVersionId, "Reviewed exact fake fixture words against the monthly source"]); await staff("releaseScriptAction", [s.id]); const shared = await prisma.contentScript.findUniqueOrThrow({ where: { id: s.id } }); await client("portalApproveScript", [s.id, shared.sharedVersionId]); }
    const agreed = await prisma.contentScript.findMany({ where: { monthId: f.monthId } });
    const currentMonth = await prisma.contentMonth.findUniqueOrThrow({ where: { id: f.monthId } });
    const planning = await portalPlanning({ id: f.enrollmentId, clientId: f.clientId }, f.monthId);
    const provenance = { sameCall: currentMonth.callRecordId === monthly, firstCallMode: planning?.planningMode === "CALL", allOwed: agreed.length === f.videosPerMonth, exactAccepted: agreed.every((s) => s.sharedVersionId && s.clientApprovedVersionId === s.sharedVersionId && s.clientApprovedByUserId === f.clientUserId), sourceVersions: await prisma.contentScriptVersion.count({ where: { scriptId: { in: agreed.map((s) => s.id) }, callRecordId: monthly } }) === f.videosPerMonth, sourceSelections: selections.every((s) => s.source === "call" && topics.some((t) => s.evidenceJson?.includes(t.words))) };
    c.ok("every owed script causally retains CALL source, release version and client actor", Object.values(provenance).every(Boolean), JSON.stringify(provenance));

    c.head("Exact address/request → declared imported visit → photographer handoff");
    const address = await client("portalSaveSessionPlanAddress", [f.monthId, 1, { street: "117 First Lane", city: "West Chester", state: "PA", zip: "19382" }]);
    const planId = String(address.planId), plan = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: planId } });
    const slots = await client("portalSessionSlots", [f.monthId, 1]);
    const days = slots.days as { slots: string[] }[];
    const slotISO = days.flatMap((d) => d.slots)[0];
    if (!slotISO) throw new Error("No actual eligible exact-address slot was offered; session contract is blocked.");
    const request = await client("portalRequestSession", [{ monthId: f.monthId, slotISO, planId, addressVersion: plan.addressVersion, sessionIndex: 1 }]);
    const requestId = String(request.requestId), asked = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: requestId } });
    const project = await prisma.project.create({ data: { clientId: f.clientId, contentMonthId: f.monthId, title: "117 First Lane — causal monthly content", addressLine: "117 First Lane, West Chester, PA 19382", packageName: "Video Starter", status: "SCHEDULED", photographerId: photographer.teamMemberId, editorId: kim.teamMemberId, editorManual: true, shootDate: new Date(slotISO), aryeoOrderId: "isolated-full-imported-order", dropboxFolder: "/isolated/full-http/monthly" } });
    const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Video Starter", productTitle: "Video Starter", quantity: f.videosPerMonth } });
    const appt = await prisma.appointment.create({ data: { projectId: project.id, aryeoId: "isolated-full-imported-appointment", startAt: new Date(slotISO), endAt: new Date(new Date(slotISO).getTime() + 2 * 3_600_000), durationMin: 120, status: "SCHEDULED", assignedToId: photographer.teamMemberId } });
    // Real reconciliation consumes the declared external import; no booking
    // action is invoked and no booking/transport result is inferred.
    await reconcileSessionRequests();
    c.ok("client request hands Kyle exact context and imported evidence closes same desk task", asked.requestedByClientUserId === f.clientUserId && (await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: requestId } })).aryeoAppointmentId === appt.aryeoId && await prisma.smartTask.count({ where: { dedupeKey: `content-session-request-${requestId}`, status: "COMPLETED", assignedKey: "kyle" } }) === 1 && await prisma.programBookingAttempt.count() === 0);
    // Advance only this disposable test clock through the requested appointment;
    // unchanged IDs/address/start times still pass the real future-shoot guard.
    clockOffsetMs = appt.endAt!.getTime() + 3_600_000 - RealDate.now();
    const afterVisit = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State; afterVisit.clockOffsetMs = clockOffsetMs; fs.writeFileSync(stateFile, JSON.stringify(afterVisit), { mode: 0o600 });
    await must("/upload/welcome", "src/app/upload/actions.ts", "acknowledgeUploadProcess", [], photographer.cookie);
    const topicIds = selections.map((s) => s.topicId);
    const handoff = await action(`/upload/${project.id}`, "src/app/upload/actions.ts", "finalizeUpload", [project.id, { editorBrief: "Two calm, practical seller videos.", cullingConfirmed: true, videoInstructions: "Use exact accepted scripts and natural pacing.", videosFilmed: 2, filmedTopicIds: topicIds, topicNotes: Object.fromEntries(agreed.map((s) => [s.topicId, `Retain approved script ${s.sharedVersionId} and the seller example.`])), scriptConfirm: { state: "as-written" }, sawScript: true }], photographer.cookie);
    const outputs = await prisma.deliverableOutput.findMany({ where: { projectId: project.id }, orderBy: { slot: "asc" } });
    const handoffProof = { unblocked: !!handoff.result?.handoff && !handoff.result.blocked && !handoff.result.needsConfirm && !handoff.result.topicsPending, allOwed: outputs.length === f.videosPerMonth, exactTopicNotes: outputs.every((o) => topicIds.includes(o.topicId!) && agreed.some((s) => s.topicId === o.topicId && o.filmingNote?.includes(s.sharedVersionId!))), applied: await prisma.contentFilmingReport.count({ where: { projectId: project.id, state: "APPLIED" } }) === 1, assignedKim: await prisma.smartTask.count({ where: { projectId: project.id, taskType: "edit_video", assignedKey: "kim", status: { notIn: ["COMPLETED", "CANCELLED"] } } }) === 1, notAutoStarted: await prisma.editorWorkItem.count({ where: { projectId: project.id } }) === 0 };
    if (handoff.flightError || handoff.response.status !== 200) throw new Error(`Photographer upload: HTTP${handoff.response.status}; result fields ${Object.keys(handoff.result ?? {}).join(",")}; error classifications ${JSON.stringify(handoff.flightErrors)}; facts ${JSON.stringify(handoffProof)}`);
    if (!handoffProof.assignedKim) console.log("Handoff owner evidence", JSON.stringify({ project: await prisma.project.findUnique({ where: { id: project.id }, select: { id: true, status: true, editorId: true, editorManual: true, handoffBlockedReason: true } }), expectedEditorId: kim.teamMemberId, cards: await prisma.smartTask.findMany({ where: { projectId: project.id, taskType: "edit_video" }, select: { id: true, assignedKey: true, assignedManually: true, status: true } }) }));
    c.ok("actual photographer handoff binds filmed topics/accepted scripts to Kim without auto-Start", Object.values(handoffProof).every(Boolean), JSON.stringify(handoffProof));

    c.head("Exact editor receipt/manual clock → v1 revision → v2 verified by James");
    for (const output of outputs) { const brief = (await outputBriefsFor(project.id)).find((b) => b.outputId === output.id); if (!brief) throw new Error("Filmed output brief unavailable."); await must(`/edit/${project.id}`, "src/app/editing/actions.ts", "saveVideoBrief", [project.id, output.id, {}, brief.version, null, "none"], kyle.cookie); }
    const projectContext = await prisma.project.findUniqueOrThrow({ where: { id: project.id } }), briefs = await outputBriefsFor(project.id, { scrub: true }), receipts = await assignmentReceiptStates(project.id, briefs, projectContext);
    for (const output of outputs) await must(`/edit/${project.id}`, "src/app/edit/[id]/receipt.actions.ts", "acknowledgeEditorBrief", [project.id, output.id, receipts.get(output.id)?.digest], kim.cookie);
    c.ok("Kim receives exact assignments including no-brand choice before separately starting", await prisma.editorBriefReceipt.count({ where: { projectId: project.id, editorKey: "kim", actorUserId: kim.id } }) === f.videosPerMonth && await prisma.editorWorkItem.count({ where: { projectId: project.id } }) === 0);
    const currentReceipts = async () => assignmentReceiptStates(project.id, await outputBriefsFor(project.id, { scrub: true }), await prisma.project.findUniqueOrThrow({ where: { id: project.id } }));
    await must("/editing", "src/app/editing/actions.ts", "setEditVideoEditor", [project.id, "john"], owner.cookie);
    const johnReceipts = await currentReceipts(), formerKim = await action(`/edit/${project.id}`, "src/app/edit/[id]/receipt.actions.ts", "acknowledgeEditorBrief", [project.id, outputs[0].id, receipts.get(outputs[0].id)!.digest], kim.cookie);
    c.ok("office reassignment requires John's exact no-brand receipt and refuses former Kim", formerKim.response.status === 200 && !formerKim.flightError && formerKim.result?.ok === false && [...johnReceipts.values()].every((r) => r.editorKey === "john" && r.intentionalNoBrand && !r.acceptedAtISO) && await prisma.smartTask.count({ where: { projectId: project.id, taskType: "edit_video", assignedKey: "john" } }) === 1 && await prisma.editorWorkItem.count({ where: { projectId: project.id } }) === 0);
    for (const output of outputs) await must(`/edit/${project.id}`, "src/app/edit/[id]/receipt.actions.ts", "acknowledgeEditorBrief", [project.id, output.id, johnReceipts.get(output.id)!.digest], john.cookie);
    c.ok("John acknowledges his own current assignment without deleting Kim's old receipts or starting", await prisma.editorBriefReceipt.count({ where: { projectId: project.id, editorKey: "john", actorUserId: john.id } }) === f.videosPerMonth && await prisma.editorBriefReceipt.count({ where: { projectId: project.id, editorKey: "kim", actorUserId: kim.id } }) === f.videosPerMonth && await prisma.editorWorkItem.count({ where: { projectId: project.id } }) === 0);
    await must("/editing", "src/app/editing/actions.ts", "setEditVideoEditor", [project.id, "kim"], owner.cookie);
    const returnReceipts = await currentReceipts(), staleKim = await action(`/edit/${project.id}`, "src/app/edit/[id]/receipt.actions.ts", "acknowledgeEditorBrief", [project.id, outputs[0].id, receipts.get(outputs[0].id)!.digest], kim.cookie);
    c.ok("returning Kim's prior digest is refused and both exact assignments need fresh receipts", staleKim.response.status === 200 && !staleKim.flightError && staleKim.result?.ok === false && outputs.every((o) => returnReceipts.get(o.id)?.changedSinceReceipt && returnReceipts.get(o.id)?.digest !== receipts.get(o.id)?.digest) && await prisma.editorBriefReceipt.count({ where: { projectId: project.id, editorKey: "kim" } }) === f.videosPerMonth && await prisma.editorWorkItem.count({ where: { projectId: project.id } }) === 0);
    for (const output of outputs) await must(`/edit/${project.id}`, "src/app/edit/[id]/receipt.actions.ts", "acknowledgeEditorBrief", [project.id, output.id, returnReceipts.get(output.id)!.digest], kim.cookie);
    const freshlyReceived = await currentReceipts();
    c.ok("Kim's fresh no-brand receipts preserve both histories and remain separate from manual Start", [...freshlyReceived.values()].every((r) => r.editorKey === "kim" && r.intentionalNoBrand && r.acceptedAtISO && !r.changedSinceReceipt) && await prisma.editorBriefReceipt.count({ where: { projectId: project.id, editorKey: "kim", actorUserId: kim.id } }) === 2 * f.videosPerMonth && await prisma.editorWorkItem.count({ where: { projectId: project.id } }) === 0);
    const queue = (label: string) => must("/editing", "src/app/editing/actions.ts", "setQueueStatus", [project.id, label, randomUUID()], kim.cookie);
    await queue("In editing"); await queue("Paused");
    c.ok("actual Kim Start/Pause preserves manual ownership without completing job", await prisma.editorWorkItem.count({ where: { projectId: project.id, editorKey: "kim", state: "PAUSED" } }) === 1 && (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status === "EDITING");
    await queue("In editing");
    const upload = async (slot: number, round: number, name: string) => {
      const ctx = await checkContextForSlot(project.id, { deliverableId: deliverable.id, slot }, { round });
      const tag = Buffer.from(name), atom = Buffer.alloc(8); atom.writeUInt32BE(8 + tag.length); atom.write("free", 4); const bytes = Buffer.concat([sample, atom, tag]);
      const check = { checklistKey: ctx.profile.checklistKey, answers: Object.fromEntries(itemsFor(ctx.profile, { isRevision: ctx.isRevision, openIssueIds: ctx.issues.map((i) => i.id) }).map((i) => [i.key, { answer: "YES" }])), issues: { addressed: ctx.issues.map((i) => i.id), notAddressed: {} }, watchedFile: { name, size: bytes.length } };
      const reserved = await must(`/edit/${project.id}`, "src/app/review/actions.ts", "startCutUpload", [{ projectId: project.id, deliverableId: deliverable.id, slot, fileName: name, sizeBytes: bytes.length, width: 1080, height: 1920, selfCheck: check }], kim.cookie);
      const submissionId = String(reserved.submissionId), pathname = `${reserved.pathname}-declared.mp4`, url = `https://drillstore.public.blob.vercel-storage.com/${pathname}`;
      const provider = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State; provider.blobs[url] = { pathname, bytes: bytes.toString("base64") }; fs.writeFileSync(stateFile, JSON.stringify(provider), { mode: 0o600 });
      await must(`/edit/${project.id}`, "src/app/review/actions.ts", "finishCutUpload", [{ submissionId, url, pathname }], kim.cookie);
      return { submissionId, bytes };
    };
    const v1 = await upload(1, 1, "seller-v1.mp4");
    await must(`/review/${project.id}`, "src/app/review/actions.ts", "addCutNote", [{ projectId: project.id, submissionId: v1.submissionId, body: "Replace the old logo on the last frame.", lane: "EDITOR", kind: "fix", timeSec: 41 }], james.cookie);
    await must(`/review/${project.id}`, "src/app/review/actions.ts", "requestCutChanges", [v1.submissionId], james.cookie);
    const issue = await prisma.revisionIssue.findFirstOrThrow({ where: { raisedOnSubmissionId: v1.submissionId } });
    c.ok("James exact-v1 feedback returns to Kim and never auto-restarts her", issue.versionEditorKey === "kim" && issue.timeSec === 41 && await prisma.editorWorkItem.count({ where: { projectId: project.id, state: "ACTIVE" } }) === 0);
    await queue("In editing");
    const v2 = await upload(1, 2, "seller-v2.mp4"), sibling = await upload(2, 1, "visit-v1.mp4");
    await must(`/review/${project.id}`, "src/app/review/actions.ts", "approveCut", [v2.submissionId, { verifyIssueIds: [issue.id] }], james.cookie);
    await must(`/review/${project.id}`, "src/app/review/actions.ts", "approveCut", [sibling.submissionId], james.cookie);
    c.ok("James verifies the same issue on current v2 while sibling/version histories remain exact", (await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id } })).verifiedInSubmissionId === v2.submissionId && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v2.submissionId } })).decidedByUserId === james.id && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v1.submissionId } })).status !== "APPROVED");

    c.head("Actual fake Dropbox backup → final check → portal handoff → client approval/download");
    for (const cut of [v2, sibling]) {
      const live = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.submissionId } });
      if (!live.finalPath || !live.completedAt) throw new Error("Approved monthly cut did not finish exact fake Dropbox backup.");
      const read = await must("/", "src/app/ops/finalRenditionActions.ts", "finalFileChoicesAction", [cut.submissionId], kyle.cookie), choices = read.choices as { id: string; url: string }[];
      if (choices.length !== 1) throw new Error("Canonical monthly final check did not offer one exact client rendition.");
      const preview = await get(choices[0].url, kyle.cookie);
      if (preview.status !== 200 || !Buffer.from(await preview.arrayBuffer()).equals(cut.bytes)) throw new Error("Staff final preview did not return exact current client bytes.");
      const form = new FormData(); form.set("submissionId", cut.submissionId); form.set("mediaId", choices[0].id); form.set("attemptId", randomUUID()); FINAL_CHECK_KEYS.forEach((k) => form.set(k, "yes"));
      // These ticks are synthetic acceptance inputs, never human watch proof.
      await must("/", "src/app/ops/finalRenditionActions.ts", "recordFinalFileCheckAction", [form], kyle.cookie);
      await must("/", "src/app/ops/actions.ts", "markVideoSentAction", [cut.submissionId, "not-yet"], kyle.cookie);
    }
    const video = await prisma.contentVideo.findFirstOrThrow({ where: { currentSubmissionId: v2.submissionId } });
    const token = mediaToken(video.id, { kind: "membership", id: f.membershipId! }), download = `/api/portal/download/${video.id}?m=${encodeURIComponent(token)}`;
    c.ok("recorded portal handoff keeps download held until client's distinct exact verdict", (await get(download, clientCookie)).status === 403 && await prisma.auditLog.count({ where: { action: "monthly_portal_handoff", target: v2.submissionId } }) === 1 && await prisma.clientDecision.count() === 0);
    for (const cut of [v2, sibling]) await client("portalApproveCut", [cut.submissionId, "NONE"]);
    const door = await get(download, clientCookie), target = door.headers.get("location");
    if (!target) throw new Error(`Entitled download did not yield its canonical target; HTTP${door.status}.`);
    const bytes = await get(target, clientCookie);
    const provider = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State, liveV2 = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v2.submissionId } });
    const final = provider.files[liveV2.finalPath!];
    c.ok("same client downloads exact revised bytes matching final Dropbox backup", door.status === 302 && bytes.status === 200 && Buffer.from(await bytes.arrayBuffer()).equals(v2.bytes) && !!final && Buffer.from(final.bytes, "base64").equals(v2.bytes) && !v1.bytes.equals(v2.bytes));
    const library = await (await get(`${portalUrl}?tab=library`, clientCookie)).text();
    c.ok("same journey library keeps exact script/topic/output versions and two approved videos", library.includes("Grove Full Journey Realty") && await prisma.contentVideo.count({ where: { enrollmentId: f.enrollmentId, approvedSubmissionId: { in: [v2.submissionId, sibling.submissionId] }, scriptVersionId: { in: agreed.map((s) => s.sharedVersionId!) } } }) === f.videosPerMonth && await prisma.clientDecision.count({ where: { submissionId: { in: [v2.submissionId, sibling.submissionId] }, clientUserId: f.clientUserId, decision: "APPROVE" } }) === f.videosPerMonth);
    const operations = fs.readFileSync(operationLog, "utf8");
    c.ok("only declared fake model/media operations occurred; sends/bookings/dispatchers stay unused", await prisma.outboxMessage.count() === 0 && await prisma.programBookingAttempt.count() === 0 && await prisma.programAutomation.count({ where: { enabled: true, key: { not: "portal_layout_v2" } } }) === 0 && await prisma.programTranscriptJob.count({ where: { state: { not: "QUEUED" } } }) === 0 && fence.blocked.length === 0 && operations.includes("fake-anthropic:strategy") && operations.includes("fake-dropbox:files/save_url") && !fs.readFileSync(serverLog, "utf8").includes("OUTBOUND BLOCKED"));
    fs.writeFileSync(privateFile, JSON.stringify(privateManifest, null, 2), { mode: 0o600 });
    console.log("Evidence: same-fixture supported HTTP actions from empty planning artifacts through final monthly bytes. Declared external calls/import/raw/blob arrivals and fake model/Dropbox only. No browser/phone/human-watch/live-provider proof.");
    console.log(await db.evidence()); c.summary();
  } finally {
    // Every owned resource gets cleanup even if an earlier close rejects.
    // The rejection still reaches main's failure handler; no success is claimed.
    try { await stop(server); }
    finally {
      try {
        if (mediaServer?.listening) await new Promise<void>((resolve, reject) => mediaServer!.close((error) => error ? reject(error) : resolve()));
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); }
        finally { try { await db.stop(); } finally { fence.restore(); } }
      }
    }
    console.log("Stopped only owned Next3211/fake-metadata5602/disposable DB5601; main3200/5599/5598 untouched.");
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Isolated continuous HTTP journey failed."); process.exitCode = 1; });
