// @drill-run: engine=postgres timeout=900
// ONE causal later-WRITTEN journey through the exact built HTTP actions.
// Starts with an empty later month. Prior eligibility is a declared fixture input;
// prior script is generated from confirmed HTTP transcript source; current script from HTTP-saved answers. Provider arrivals and
// model output are explicitly fake inputs; no browser/watch/provider evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { buildSampleMp4 } from "../demo/sample";

const CANDIDATE = "ab6cfdf37314c2107f4a286446f95e396811c5b2";
const EXPECTED_BUILD_ID = "E-uORzmXJnuvQHgk3woRz";
const EXPECTED_ACTION_HASH = "f9beeab391bfe80d0054367ed7169a0b18016042b839b693ffba68d12e6f108e";
let builtRoot = "";
const DB_PORT = 5603, APP_PORT = 3213, MEDIA_PORT = 5605, BASE = `http://127.0.0.1:${APP_PORT}`;
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
type State = { phase?: "prior-carry-source" | "written"; dbPort: number; operationLog: string; monthKey: string; topics: typeof topics; strategy: typeof strategy; sampleSize: number; productId: string; providerId: string; providerUserId: string; clockOffsetMs: number; blobs: Record<string, { pathname: string; bytes: string }>; files: Record<string, { id: string; rev: string; hash: string; bytes: string }> };
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

function compiledRuntime(): string {
  // Root preserved this exact compiled app before advancing its build checkout.
  // Every invocation validates the reserved build and action manifest. No Git,
  // source build or environment file is read; no running runtime is modified.
  const candidates = fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith("rtp-written-ab6-runtime-"));
  for (const entry of candidates) {
    const dir = path.join(os.tmpdir(), entry), proofFile = path.join(dir, "runtime-proof.private.json");
    if (!fs.existsSync(proofFile)) continue;
    const proof = JSON.parse(fs.readFileSync(proofFile, "utf8"));
    const buildId = fs.readFileSync(path.join(dir, ".next/BUILD_ID"), "utf8").trim();
    const hash = createHash("sha256").update(fs.readFileSync(path.join(dir, ".next/server/server-reference-manifest.json"))).digest("hex");
    const prismaAliases = path.join(dir, ".next/node_modules/@prisma");
    const aliasReady = fs.existsSync(prismaAliases) && fs.readdirSync(prismaAliases).some((name) => name.startsWith("client-") && fs.existsSync(path.join(prismaAliases, name, "package.json")));
    if (proof.candidate === CANDIDATE && proof.buildId === EXPECTED_BUILD_ID && buildId === EXPECTED_BUILD_ID && proof.manifestHash === EXPECTED_ACTION_HASH && hash === EXPECTED_ACTION_HASH && aliasReady && !fs.existsSync(path.join(dir, ".env"))) return dir;
  }
  throw new Error("Reserved exact ab6 compiled runtime is unavailable; no build or different candidate is substituted.");
}
async function main() {
  for (const port of [DB_PORT, APP_PORT, MEDIA_PORT]) if (!await portFree(port)) throw new Error(`Reserved port${port} is occupied; no process was stopped.`);
  builtRoot = compiledRuntime();
  const buildId = EXPECTED_BUILD_ID;
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-written-http-")); fs.chmodSync(runtime, 0o700);
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
    const { interviewState } = await import("@/lib/contentInterview");
    const monthKey = etMonthKey(new Date());
    const f = await buildContentMonth(prisma, { name: "Written HTTP Journey TEST", package: "Starter", project: false, monthKey, topics: [], portalToken: false, owner: { name: "Maya Grove", email: "maya-written-http@example.test" } });
    const passwordHash = await hashPassword(password), personas = [];
    for (const [name, role, editorKey] of [["Jordan", "OWNER", null], ["Kyle", "ADMIN", null], ["James", "ADMIN", null], ["Kim", "EDITOR", "kim"], ["Harrison", "PHOTOGRAPHER", null]] as const) {
      const tm = await prisma.teamMember.create({ data: { name, email: `${name.toLowerCase()}-written-http@example.test`, role: role === "EDITOR" || role === "OWNER" ? "MANAGER" : role, active: true } });
      const u = await prisma.appUser.create({ data: { name, email: tm.email!, role, editorKey, teamMemberId: tm.id, status: "ACTIVE", passwordHash } });
      personas.push({ name, role, email: u.email, id: u.id, teamMemberId: tm.id, cookie: null as string | null });
    }
    const [owner, kyle, james, kim, photographer] = personas;
    const providerId = randomUUID(), providerUserId = randomUUID(), productId = aryeoProductFor("Starter")!.productId;
    await prisma.teamMember.update({ where: { id: photographer.teamMemberId }, data: { aryeoTeamMemberId: providerId } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const login = await mintLoginLink(f.membershipId!, owner.id);
    await prisma.client.update({ where: { id: f.clientId }, data: { name: "Grove Written Journey Realty", email: "maya-written-http@example.test", autoConfirmationText: false, autoDeliveryText: false } });
    const since = new Date(Date.now() - 60_000).toISOString();
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: serializeProgramRollout({ mode: "PILOT", modeSince: since, pilot: { clientIds: [f.clientId], operations: ["portal_sign_in", "portal_layout_v2"], approvedBy: "declared isolated fixture", approvedAt: since, expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), joinedAt: { [f.clientId]: since }, note: "Disposable causal HTTP acceptance through its declared future filming visit only" } }) } });
    await prisma.programAutomation.create({ data: { key: "portal_layout_v2", enabled: true, enabledBy: "declared isolated layout input", enabledAt: new Date() } });
    await prisma.appSetting.createMany({ data: [{ key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: james.teamMemberId, backupReviewerTeamMemberId: kyle.teamMemberId }) }, { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) }] });
    await saveSecret("dropbox", "isolated-written-http-refresh"); await saveSecret("ai", "isolated-written-http-model-key"); await saveSecret("aryeo", "isolated-written-http-read-key");
    const state: State = { dbPort: DB_PORT, operationLog, monthKey, topics, strategy, sampleSize: sample.length, productId, providerId, providerUserId, clockOffsetMs, blobs: {}, files: {} };
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    // Real compiled Blob SDK/head, using only its supported loopback override.
    // Declared blob arrivals exist before metadata reads; unknown URLs fail.
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
    server = spawn(process.execPath, [path.join(builtRoot, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(APP_PORT)], { cwd: builtRoot, env: { ...process.env, NODE_ENV: "production", AUTH_ENFORCE: "true", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "_later-written-http-preload.cjs"))}`, RTP_HTTP_FIXTURE: stateFile }, stdio: ["ignore", fd, fd] });
    console.log(`Owned Next PID${server.pid} app3213 DB5603; exact build${buildId}; private runtime${runtime}`);
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
    for (const t of topics.slice(0, 1)) { await staff("addTopic", [f.enrollmentId, { title: t.title, concept: t.words, source: "ai", pillarId: pillar.id }], kyle.cookie); const topic = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, title: t.title } }); await staff("topicDecision", [topic.id, "APPROVE", "Matched to released strategy and monthly seller advice"], kyle.cookie); }
    const strategyHtml = await (await get(`${portalUrl}?tab=strategy`, clientCookie)).text(), topicsHtml = await (await get(`${portalUrl}?tab=topics`, clientCookie)).text();
    c.ok("same client receives released strategy and Kyle-approved bank before selection", strategyHtml.includes("Calm advice") && topicsHtml.includes(topics[0].title) && await prisma.contentTopicSelection.count() === 0);

    c.head("Empty later month → prior transcript-generated unfilmed script → exact carry");
    const previousKey = new Date(`${monthKey}-01T12:00:00Z`); previousKey.setUTCMonth(previousKey.getUTCMonth() - 1);
    const priorKey = previousKey.toISOString().slice(0, 7);
    const firstKeyDate = new Date(previousKey); firstKeyDate.setUTCMonth(firstKeyDate.getUTCMonth() - 1);
    const firstKey = firstKeyDate.toISOString().slice(0, 7);
    // Existing first-call eligibility is a declared historical input only.
    // No old topic, interview, script, release, project or media is seeded.
    const first = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: firstKey, videosOwed: f.videosPerMonth, status: "CLOSED" } });
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: first.id, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date(`${firstKey}-03T17:00:00Z`), scheduledEnd: new Date(`${firstKey}-03T17:30:00Z`), transcriptState: "ANALYZED" } });
    const prior = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: priorKey, videosOwed: f.videosPerMonth, status: "OPEN" } });
    c.ok("current later month starts without selections/interviews/scripts/production", await prisma.contentTopicSelection.count({ where: { monthId: f.monthId } }) === 0 && await prisma.contentInterview.count({ where: { monthId: f.monthId } }) === 0 && await prisma.contentScript.count({ where: { monthId: f.monthId } }) === 0 && await prisma.project.count() === 0 && !(await prisma.contentMonth.findUniqueOrThrow({ where: { id: f.monthId } })).planningChosenAt);
    const answerInterview = async (topicId: string, monthId: string, index: number) => {
      const open = await client("portalOpenInterview", [topicId, monthId]), id = String(open.id);
      const answers: Record<string, string> = index === 0 ? {
        audienceProblem: "Sellers who wait for a better offer can miss the strongest first weekend of demand.",
        pointOfView: "The first weekend is the whole negotiation, so price for it and you set the terms.",
        talkingPoints: "First, buyers compare competing homes. Second, buyers read days on market as a discount signal. Finally, the right price on day one brings competing offers.",
        evidence: "An example from my own practice is an Oak Street seller who had three offers by Sunday after pricing for the first weekend.",
        story: "Show two similar homes on the same street, one prepared for the first weekend and one sitting for a month.",
        nextAction: "Call me before you book the photographer so we can plan the first weekend together.",
      } : {
        audienceProblem: "Busy sellers can overlook small repairs and leave buyers distracted before they see the home's best features.",
        pointOfView: "Prepare the whole visit before launch so buyers can picture living there without avoidable distractions.",
        talkingPoints: "First, open the blinds for natural light. Second, clear the entry so buyers feel welcomed. Finally, finish small repairs before the first visit.",
        evidence: "An example from my own practice is a seller on Elm Street who repaired a sticking door and cleared the entry before the first showing.",
        story: "Show the same entry before and after clearing the shoes, repairing the door and opening the blinds.",
        nextAction: "Call me before the first showing so we can walk through a practical preparation checklist together.",
      };
      const expected = new Map<string, string>();
      for (let n = 0; n < 18; n++) {
        const reading = await interviewState(id, { readOnly: true });
        if (!reading.nextKey) break;
        const key = reading.nextKey, text = answers[key] ?? `${topics[index].words} This is the advice I give sellers in my own practice, with one practical action before the home launches.`;
        await client("portalAnswerInterview", [id, key, text, "TYPED"]); expected.set(key, text);
      }
      const submitted = await client("portalSubmitInterview", [id]);
      const stored = await prisma.contentInterviewAnswer.findMany({ where: { interviewId: id } });
      const iv = await prisma.contentInterview.findUniqueOrThrow({ where: { id } });
      c.ok(`topic${index + 1} exact HTTP answers are submitted by the client without a booking`, submitted.status === "SUBMITTED" && iv.submittedByClientUserId === f.clientUserId && stored.length >= 6 && stored.every((a) => a.clientUserId === f.clientUserId && a.answerKind === "TYPED" && a.sourceKind === "CLIENT" && expected.get(a.questionKey) === a.answerText) && await prisma.programSessionRequest.count() === 0);
      return { id, answers: stored };
    };
    const priorCall = await createManualCallRecord({ clientId: f.clientId, callType: "MONTHLY_STRATEGY", scheduledStart: new Date(`${priorKey}-03T17:00:00Z`), scheduledEnd: new Date(`${priorKey}-03T17:30:00Z`), targetMonthKey: priorKey, by: owner.email, note: "Declared completed prior external monthly call, not a provider booking" });
    const priorText = `Jordan: Which video will carry your advice?\nMaya Grove: ${topics[0].title}. ${topics[0].words}\nJordan: We will prepare that one script for your read-through.\nMaya Grove: Yes, that is my selected video for ${priorKey}.`;
    await must("/settings", "src/app/settings/calendlyActions.ts", "pasteTranscript", [priorCall, priorText], owner.cookie);
    const priorProvider = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
    priorProvider.phase = "prior-carry-source"; priorProvider.monthKey = priorKey; priorProvider.topics = topics.slice(0, 1); fs.writeFileSync(stateFile, JSON.stringify(priorProvider), { mode: 0o600 });
    await staff("saveMonthTranscript", [prior.id, priorText]); await staff("analyzeTranscript", [prior.id]);
    const carriedTopic = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, title: topics[0].title } });
    await staff("reconcileTopicSelection", [carriedTopic.id, prior.id, true], kyle.cookie);
    await staff("generateMonthScripts", [prior.id]);
    const beforeCarry = await prisma.contentScript.findFirstOrThrow({ where: { monthId: prior.id, topicId: carriedTopic.id } });
    const carriedVersion = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: beforeCarry.currentVersionId! } });
    c.ok("prior unfilmed script is generated from confirmed source call and remains unreleased", carriedVersion.callRecordId === priorCall && carriedVersion.source === "AI" && !!carriedVersion.aiRunId && !beforeCarry.sharedVersionId && await prisma.programTranscriptSource.count({ where: { callRecordId: priorCall, text: priorText, createdBy: owner.email } }) === 1 && await prisma.contentScriptRelease.count() === 0);
    const writtenProvider = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
    writtenProvider.phase = "written"; writtenProvider.monthKey = monthKey; writtenProvider.topics = topics; fs.writeFileSync(stateFile, JSON.stringify(writtenProvider), { mode: 0o600 });
    await client("portalPlanWithoutCall", [f.monthId]);
    await staff("carryNowAction", [f.enrollmentId, false], kyle.cookie);
    const carry = await prisma.contentTopicSelection.findUniqueOrThrow({ where: { topicId_monthId: { topicId: carriedTopic.id, monthId: f.monthId } } });
    const moved = await prisma.contentScript.findUniqueOrThrow({ where: { id: beforeCarry.id } });
    c.ok("staff carry preserves the exact source script/version and consumes one current slot", carry.status === "CARRIED" && carry.carriedFromMonthId === prior.id && carry.carriedScriptId === beforeCarry.id && moved.monthId === f.monthId && moved.currentVersionId === carriedVersion.id && (await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: carriedVersion.id } })).body === carriedVersion.body && await prisma.contentScriptVersion.count({ where: { scriptId: beforeCarry.id } }) === 1);

    c.head("Client-added topic → exact current WRITTEN source answers → staff review/release");
    const added = await client("portalSuggestTopic", [{ title: topics[1].title, concept: topics[1].words, pillarId: pillar.id, monthId: f.monthId }]);
    const addedId = String(added.id), ownTopic = await prisma.contentTopic.findUniqueOrThrow({ where: { id: addedId } });
    c.ok("normal client adds and selects their own topic as theirs without a staff-bank substitute", added.selected === true && ownTopic.source === "client" && ownTopic.clientUserId === f.clientUserId && ownTopic.clientWording === topics[1].title && await prisma.contentTopicSelection.count({ where: { monthId: f.monthId } }) === f.videosPerMonth);
    const currentInterview = await answerInterview(addedId, f.monthId, 1);
    await staff("reconcileTopicSelection", [addedId, f.monthId, true], kyle.cookie);
    await staff("draftOwedScriptsAction", [f.monthId]);
    const scripts = await prisma.contentScript.findMany({ where: { monthId: f.monthId }, orderBy: { createdAt: "asc" } });
    if (scripts.length !== f.videosPerMonth) throw new Error("Written HTTP fixture contract: every in-allowance source-backed topic must have one generated/carried script.");
    const newScript = scripts.find((s) => s.topicId === addedId);
    if (!newScript?.currentVersionId) throw new Error("Written HTTP fixture contract: current written answers did not produce their exact topic script.");
    const newVersion = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: newScript.currentVersionId } });
    const sourceAnswerIds = JSON.parse(newVersion.answerIdsJson || "[]") as string[];
    c.ok("new WRITTEN script uses current exact answer rows with no CALL/source substitution", newScript.interviewId === currentInterview.id && newVersion.interviewId === currentInterview.id && !newVersion.callRecordId && newVersion.source === "AI" && !!newVersion.aiRunId && sourceAnswerIds.length === currentInterview.answers.length && currentInterview.answers.every((a) => sourceAnswerIds.includes(a.id)) && !sourceAnswerIds.some((id) => (JSON.parse(carriedVersion.answerIdsJson || "[]") as string[]).includes(id)));
    for (const s of scripts) {
      await staff("approveScriptVersionAction", [s.currentVersionId, "Reviewed exact fake fixture words against saved client-written source"]);
      const approved = await prisma.contentScript.findUniqueOrThrow({ where: { id: s.id } });
      c.ok("owner approval alone keeps this exact script unshared", !approved.sharedVersionId);
      await staff("releaseScriptAction", [s.id]);
      const shared = await prisma.contentScript.findUniqueOrThrow({ where: { id: s.id } });
      await client("portalApproveScript", [s.id, shared.sharedVersionId]);
    }
    const agreed = await prisma.contentScript.findMany({ where: { monthId: f.monthId } });
    const currentMonth = await prisma.contentMonth.findUniqueOrThrow({ where: { id: f.monthId } });
    const planning = await portalPlanning({ id: f.enrollmentId, clientId: f.clientId }, f.monthId);
    const selections = await prisma.contentTopicSelection.findMany({ where: { monthId: f.monthId } });
    // The stored preparationCompletedAt is historical; the canonical session
    // derivation, including an approved carried script, determines readiness.
    const provenance = { writtenMode: planning?.planningMode === "WRITTEN" && currentMonth.planningChosenBy === `client:${f.clientUserId}`, prepared: planning?.preparationStatus === "READY_FOR_FILMING" && !!planning.earliestSessionISO, allOwed: agreed.length === f.videosPerMonth, exactAccepted: agreed.every((s) => s.sharedVersionId && s.clientApprovedVersionId === s.sharedVersionId && s.clientApprovedByUserId === f.clientUserId), priorSourcePreserved: (await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: carriedVersion.id } })).body === carriedVersion.body, noMonthlyCall: !currentMonth.callRecordId && !currentMonth.transcriptText, noProduction: await prisma.project.count() === 0 && await prisma.editorWorkItem.count() === 0 };
    c.ok("later WRITTEN month causally retains carried/new sources, exact release/client acceptance and no auto-Start", Object.values(provenance).every(Boolean), JSON.stringify(provenance));

    c.head("Exact address/request → declared imported visit → photographer handoff");
    const address = await client("portalSaveSessionPlanAddress", [f.monthId, 1, { street: "117 First Lane", city: "West Chester", state: "PA", zip: "19382" }]);
    const planId = String(address.planId), plan = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: planId } });
    const slots = await client("portalSessionSlots", [f.monthId, 1]);
    const days = slots.days as { slots: string[] }[];
    const slotISO = days.flatMap((d) => d.slots)[0];
    if (!slotISO) throw new Error("No actual eligible exact-address slot was offered; session contract is blocked.");
    const request = await client("portalRequestSession", [{ monthId: f.monthId, slotISO, planId, addressVersion: plan.addressVersion, sessionIndex: 1 }]);
    const requestId = String(request.requestId), asked = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: requestId } });
    const project = await prisma.project.create({ data: { clientId: f.clientId, contentMonthId: f.monthId, title: "117 First Lane — causal monthly content", addressLine: "117 First Lane, West Chester, PA 19382", packageName: "Video Starter", status: "SCHEDULED", photographerId: photographer.teamMemberId, editorId: kim.teamMemberId, editorManual: true, shootDate: new Date(slotISO), aryeoOrderId: "isolated-full-imported-order", dropboxFolder: "/isolated/written-http/monthly" } });
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
    c.ok("same journey library keeps exact script/topic/output versions and two approved videos", library.includes("Grove Written Journey Realty") && await prisma.contentVideo.count({ where: { enrollmentId: f.enrollmentId, approvedSubmissionId: { in: [v2.submissionId, sibling.submissionId] }, scriptVersionId: { in: agreed.map((s) => s.sharedVersionId!) } } }) === f.videosPerMonth && await prisma.clientDecision.count({ where: { submissionId: { in: [v2.submissionId, sibling.submissionId] }, clientUserId: f.clientUserId, decision: "APPROVE" } }) === f.videosPerMonth);
    const operations = fs.readFileSync(operationLog, "utf8");
    c.ok("only declared fake model/media operations occurred; sends/bookings/dispatchers stay unused", await prisma.outboxMessage.count() === 0 && await prisma.programBookingAttempt.count() === 0 && await prisma.programAutomation.count({ where: { enabled: true, key: { not: "portal_layout_v2" } } }) === 0 && await prisma.programTranscriptJob.count({ where: { state: { not: "QUEUED" } } }) === 0 && fence.blocked.length === 0 && operations.includes("fake-anthropic:strategy") && operations.includes("fake-anthropic:written-script") && operations.includes("fake-dropbox:files/save_url") && !fs.readFileSync(serverLog, "utf8").includes("OUTBOUND BLOCKED"));
    fs.writeFileSync(privateFile, JSON.stringify(privateManifest, null, 2), { mode: 0o600 });
    console.log("Evidence: same-fixture supported HTTP actions from an empty later month, HTTP source answers and exact script carry through final monthly bytes. Declared external calls/import/raw/blob arrivals and fake model/Dropbox only. No browser/phone/human-watch/live-provider proof.");
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
    console.log("Stopped only owned Next3213/fake-metadata5605/disposable DB5603; first-CALL3211/5601/5602 and Pro3214/5604/5606 untouched; main3200/5599/5598 untouched.");
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Isolated continuous HTTP journey failed."); process.exitCode = 1; });
