// @drill-run: engine=postgres timeout=600
// Uncovered real Next cookie/middleware/action transport on the exact built
// candidate. Disposable PostgreSQL; declared fixture states and fake read-only
// Dropbox/sample media. This is not browser, provider or human-watch evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { createTestClientShell, seedRepresentativeMonth } from "../_fixtures/representativeMonth";
import { buildSampleMp4, ensureSampleClip, startSampleServer, DEMO_CLIP_URL } from "../demo/sample";

const CHECKOUT = "/Users/jordanspackman/.codex/worktrees/audit-visual-check/Realtour Pilot POT Dashboard";
const DB_PORT = 5601, SAMPLE_PORT = 5602, APP_PORT = 3211;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const c = makeChecker();
const { encodeReply } = createRequire(__filename)("next/dist/compiled/react-server-dom-webpack/client.node") as { encodeReply: (args: unknown[]) => Promise<string | FormData> };
installNextStubs();
const sampleBytes = buildSampleMp4();
const bytesHash = createHash("sha256").update(sampleBytes).digest("hex");
const dropboxHash = createHash("sha256").update(createHash("sha256").update(sampleBytes).digest()).digest("hex");
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Proof = { id: string; rev: string; content_hash: string; size: number };
const files: Record<string, Proof> = {};
const fence = fenceFetch((url) => {
  if (url === DEMO_CLIP_URL) return new Response(Uint8Array.from(sampleBytes), { headers: { "content-type": "video/mp4" } });
  return null;
});

function actionId(filename: string, exportedName: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(CHECKOUT, ".next/server/server-reference-manifest.json"), "utf8")) as { node: Record<string, { workers: Record<string, { filename: string; exportedName: string }> }> };
  const entry = Object.entries(manifest.node).find(([, row]) => Object.values(row.workers).some((w) => w.filename === filename && w.exportedName === exportedName));
  if (!entry) throw new Error(`Built action absent: ${filename} ${exportedName}`);
  return entry[0];
}
function cookieFrom(r: Response, name: string): string | null {
  const value = r.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  return value ? value.split(";", 1)[0] : null;
}
async function get(url: string, cookie?: string | null, headers?: Record<string, string>) {
  return fetch(new URL(url, BASE), { redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...headers } });
}
async function action(url: string, filename: string, name: string, args: unknown[] | FormData, cookie?: string | null) {
  const body = args instanceof FormData ? args : JSON.stringify(args);
  const headers: Record<string, string> = { "next-action": actionId(filename, name), origin: BASE, accept: "text/x-component", ...(cookie ? { cookie } : {}) };
  if (typeof body === "string") headers["content-type"] = "text/plain;charset=UTF-8";
  const response = await fetch(new URL(url, BASE), { method: "POST", body, headers, redirect: "manual" });
  const text = await response.text();
  // React Flight's action return is a JSON row. Do not log payloads/cookies.
  const returned = text.split("\n").map((line) => /^\w+:(\{.*\})$/.exec(line)?.[1]).filter((x): x is string => !!x).map((x) => { try { return JSON.parse(x) as Record<string, unknown>; } catch { return null; } }).find((x) => x && typeof x.ok === "boolean");
  return { response, returned, hasError: /\d+:E\{/.test(text) };
}
async function terminate(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), wait(5000)]);
  if (child.exitCode === null && child.signalCode === null) throw new Error(`Owned Next process ${child.pid} did not stop after SIGTERM; no unrelated process was touched.`);
}

async function main() {
  for (const port of [DB_PORT, SAMPLE_PORT, APP_PORT]) if (!(await portFree(port))) throw new Error(`Allocated port ${port} is occupied; no process stopped.`);
  if (!fs.existsSync(path.join(CHECKOUT, ".next/BUILD_ID"))) throw new Error("The coordinated exact build is missing.");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-signed-http-")); fs.chmodSync(runtime, 0o700);
  const secret = randomBytes(32).toString("hex"), password = `Isolated-${randomBytes(12).toString("hex")}`;
  const db = await bootDrillDb({ port: DB_PORT, engine: "postgres", env: { APP_SECRET: secret, AUTH_ENFORCE: "true", NEXT_PUBLIC_APP_URL: BASE, DROPBOX_APP_KEY: "isolated-http-key", DROPBOX_APP_SECRET: "isolated-http-secret" } });
  const clip = await startSampleServer(ensureSampleClip(runtime), SAMPLE_PORT);
  let server: ChildProcess | undefined;
  const serverLog = path.join(runtime, "next-server.log"), manifestFile = path.join(runtime, "fixture.json"), sessionsFile = path.join(runtime, "private-sessions.json");
  const logFd = fs.openSync(serverLog, "w", 0o600);
  try {
    const { prisma } = await import("@/lib/prisma");
    const { hashPassword } = await import("@/lib/auth/password");
    const { setSession } = await import("@/lib/auth/session");
    const { mintLoginLink } = await import("@/lib/portalAccess");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const { PROGRAM_ROLLOUT_SETTING_KEY, serializeProgramRollout } = await import("@/lib/programRolloutCore");
    const { backupReceiptData } = await import("@/lib/finalDropbox");
    const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
    const { syncEnrollmentVideos } = await import("@/lib/contentVideos");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const passwordHash = await hashPassword(password);
    const personas = [];
    for (const [name, role, editorKey] of [["Jordan", "OWNER", null], ["Kyle", "ADMIN", null], ["James", "ADMIN", null], ["Kim", "EDITOR", "kim"], ["Harrison", "PHOTOGRAPHER", null]] as const) {
      const email = `${name.toLowerCase()}-signed@example.test`;
      const tm = await prisma.teamMember.create({ data: { name, email, role: role === "EDITOR" ? "MANAGER" : role === "OWNER" ? "PHOTOGRAPHER" : role, active: true } });
      const user = await prisma.appUser.create({ data: { name, email, role, editorKey, status: "ACTIVE", teamMemberId: tm.id, passwordHash } });
      personas.push({ name, role, email, userId: user.id, teamMemberId: tm.id, cookie: null as string | null });
    }
    const owner = personas[0], kyle = personas[1], james = personas[2], kim = personas[3], photographer = personas[4];
    await setSession({ uid: owner.userId, email: owner.email, role: owner.role });
    const shell = await createTestClientShell(prisma, { name: "Grove Acceptance TEST", slug: "signedacceptance" });
    const monthKey = etMonthKey(new Date());
    const rep = await seedRepresentativeMonth(prisma, { clientId: shell.clientId, monthKey, tier: "program", variant: "accelerator" });
    // The production login route consumes a real minted single-use token.
    // Mint while synthetic under the existing no-send gate, then declare a
    // normal named pilot fixture before any HTTP request resolves its seat.
    const signIn = await mintLoginLink(shell.membershipId, owner.userId);
    await prisma.client.update({ where: { id: shell.clientId }, data: { name: "Grove Acceptance Realty", email: "maya-grove@example.test", autoConfirmationText: false, autoDeliveryText: false } });
    const since = new Date(Date.now() - 60_000).toISOString();
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: serializeProgramRollout({ mode: "PILOT", modeSince: since, pilot: { clientIds: [shell.clientId], operations: ["portal_sign_in", "portal_layout_v2"], approvedBy: "declared isolated input", approvedAt: since, expiresAt: new Date(Date.now() + 864e5).toISOString(), joinedAt: { [shell.clientId]: since }, note: "Disposable role acceptance; no dispatchers or sends" } }) } });
    await prisma.programAutomation.create({ data: { key: "portal_layout_v2", enabled: true, enabledBy: "declared isolated fixture", enabledAt: new Date() } });
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: james.teamMemberId, backupReviewerTeamMemberId: kyle.teamMemberId }) } });
    await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
    await saveSecret("dropbox", "isolated-http-refresh");
    const p = await prisma.project.create({ data: { clientId: shell.clientId, contentMonthId: rep.monthId, title: "117 Acceptance Lane — October content", addressLine: "117 Acceptance Lane, West Chester, PA 19382", status: "REVIEW", source: "MANUAL", shootDate: new Date(), photographerId: photographer.teamMemberId, editorId: kim.teamMemberId, editorManual: true, dropboxFolder: "/isolated/acceptance/monthly" } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", quantity: 2 } });
    await ensureOutputsForProject(p.id);
    const outputs = await prisma.deliverableOutput.findMany({ where: { projectId: p.id, deliverableId: d.id }, orderBy: { slot: "asc" } });
    const cuts = [];
    for (const slot of [1, 2]) {
      const approved = slot === 2;
      const cut = await prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: d.id, outputId: outputs[slot - 1].id, slot, round: 1, source: "folder", fileName: `acceptance-topic-${slot}-v1.mp4`, blobUrl: DEMO_CLIP_URL, sizeBytes: sampleBytes.length, contentHash: bytesHash, status: approved ? "APPROVED" : "PENDING", submittedByKey: "kim", submittedByName: "Kim", reviewerTeamMemberId: james.teamMemberId, reviewerAssignedAt: new Date(), selfCheckedAt: new Date(), clientReleasedAt: approved ? new Date() : null, decidedAt: approved ? new Date() : null, decidedBy: approved ? "James (declared fixture)" : null } });
      const finalPath = `/isolated/acceptance/monthly/05-Final-Video/${cut.fileName}`;
      const file = { id: `id:acceptance-${cut.id}`, rev: "fixture-v1", content_hash: dropboxHash, size: sampleBytes.length };
      if (approved) {
        files[finalPath] = file;
        await prisma.auditLog.create({ data: backupReceiptData(cut, { id: file.id, rev: file.rev, hash: file.content_hash, size: file.size, path: finalPath }) });
      }
      await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { assetUrl: `/api/review/cut/${cut.id}/stream`, ...(approved ? { finalPath, completedAt: new Date() } : {}) } });
      await prisma.deliverableOutput.update({ where: { id: outputs[slot - 1].id }, data: { ownerKey: "kim", currentSubmissionId: cut.id, ...(approved ? { approvedSubmissionId: cut.id } : {}) } });
      cuts.push(cut);
    }
    await syncEnrollmentVideos({ id: shell.enrollmentId, clientId: shell.clientId });
    const ready = await prisma.project.create({ data: { clientId: shell.clientId, contentMonthId: rep.monthId, title: "118 Acceptance Lane — ready for Kim", status: "SHOT", source: "MANUAL", shootDate: new Date(), photographerId: photographer.teamMemberId, editorId: kim.teamMemberId, editorManual: true, editorBrief: "Declared isolated footage: keep the opening sentence and exact accepted script." } });
    await prisma.deliverable.create({ data: { projectId: ready.id, type: "SOCIAL_REEL", label: "Video Accelerator", quantity: 1 } });
    await ensureOutputsForProject(ready.id);
    await prisma.smartTask.create({ data: { projectId: ready.id, clientId: shell.clientId, taskType: "edit_video", title: "Edit 118 Acceptance Lane", status: "OPEN", assignedKey: "kim", assignedManually: true, source: "manual", dedupeKey: `edit-video-${ready.id}` } });
    await prisma.smartTask.create({ data: { clientId: shell.clientId, taskType: "manual", title: "Confirm October content context", status: "OPEN", assignedKey: "kyle", ownerId: kyle.teamMemberId, source: "manual", flaggedBy: "Jordan", flaggedAt: new Date() } });
    const foreign = await buildContentMonth(prisma, { name: "Unrelated Private Client TEST", project: { title: "900 Private Lane — John only", status: "SHOT" }, owner: { email: "unrelated@example.test", name: "Unrelated" } });
    await prisma.project.update({ where: { id: foreign.projectId! }, data: { editorVendorKey: "john", editorManual: true } });
    const pendingScript = await prisma.contentScript.findUniqueOrThrow({ where: { id: rep.scripts.E }, select: { sharedVersionId: true } });
    const video = await prisma.contentVideo.findFirstOrThrow({ where: { currentSubmissionId: cuts[1].id } });
    const runtimeManifest = { runtime, dbPort: DB_PORT, samplePort: SAMPLE_PORT, sampleUrl: DEMO_CLIP_URL, files };
    fs.writeFileSync(manifestFile, JSON.stringify(runtimeManifest), { mode: 0o600 });
    const urls = { home: BASE, portal: `${BASE}/portal/me?tab=dashboard`, content: `${BASE}/content/${shell.enrollmentId}`, review: `${BASE}/review/${p.id}?cut=${cuts[0].id}`, editor: `${BASE}/edit/${ready.id}`, shoot: `${BASE}/shoot/${p.id}`, upload: `${BASE}/upload/${p.id}`, project: `${BASE}/projects/${p.id}` };
    const privateManifest = { warning: "Disposable local data and credentials only. Real HTTP transport, not browser proof. Tokens expire in15min; cookiesSecure are carried explicitly over loopback HTTP. No provider/send/automation operations.", buildId: fs.readFileSync(path.join(CHECKOUT, ".next/BUILD_ID"), "utf8").trim(), base: BASE, signIn: signIn.url, signInExpiresAt: signIn.expiresAt.toISOString(), password, personas, urls, enrollmentId: shell.enrollmentId, monthId: rep.monthId, projectId: p.id, readyProjectId: ready.id, pendingCutId: cuts[0].id, releasedCutId: cuts[1].id, videoId: video.id, scripts: rep.scripts, clientCookie: null as string | null };
    fs.writeFileSync(sessionsFile, JSON.stringify(privateManifest, null, 2), { mode: 0o600 });
    const nextPath = path.join(CHECKOUT, "node_modules/next/dist/bin/next");
    server = spawn(process.execPath, [nextPath, "start", "--hostname", "127.0.0.1", "--port", String(APP_PORT)], { cwd: CHECKOUT, env: { ...process.env, NODE_ENV: "production", AUTH_ENFORCE: "true", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "_normal-role-http-preload.cjs"))}`, RTP_HTTP_FIXTURE: manifestFile }, stdio: ["ignore", logFd, logFd] });
    console.log(`Owned Next PID ${server.pid}; app3211 DB5601 sample5602; private manifest ${sessionsFile}; server log ${serverLog}`);
    let up = false;
    for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw new Error(`Owned Next exited ${server.exitCode}; inspect private server log.`); try { if ((await get("/login")).status === 200) { up = true; break; } } catch { /* only wait for our known child */ } await wait(500); }
    if (!up) throw new Error("Owned Next did not become ready in30s.");

    c.head("Actual password action cookies and middleware role routes");
    c.ok("anonymous office route is gated by actual running middleware", (await get("/content")).status === 307 && !!(await get("/content")).headers.get("location")?.includes("/login"));
    for (const person of personas) {
      const form = new FormData(); form.set("email", person.email); form.set("password", password); form.set("next", "/");
      // Use the installed encoder, including its streaming field order.
      const encoded = await encodeReply([form]);
      if (!(encoded instanceof FormData)) throw new Error("Password action encoder did not produce multipart FormData.");
      const login = await action("/login", "src/app/login/actions.ts", "loginWithPassword", encoded);
      person.cookie = cookieFrom(login.response, "rtp_session");
      const row = await prisma.appUser.findUniqueOrThrow({ where: { id: person.userId }, select: { lastLoginAt: true, status: true } });
      c.ok(`${person.name} password transport sets signed HttpOnly Secure cookie and real login stamp`, login.response.status === 200 && login.returned?.ok === true && !!person.cookie && login.response.headers.getSetCookie().some((x) => /httponly/i.test(x) && /secure/i.test(x)) && !!row.lastLoginAt && row.status === "ACTIVE", `HTTP${login.response.status}; response=${login.returned?.ok === true ? "accepted" : String(login.returned?.message ?? "unparsed")}; cookie=${Boolean(person.cookie)}; lastLogin=${Boolean(row.lastLoginAt)}`);
    }
    fs.writeFileSync(sessionsFile, JSON.stringify(privateManifest, null, 2), { mode: 0o600 });
    const staffPaths: [string, string, string][] = [["Kyle", "/", "Home"], ["Kyle", "/content", "Content"], ["Kyle", "/editing", "Editing Room"], ["Kyle", "/schedule", "Schedule"], ["James", "/review", "Review Room"], ["Kim", "/editing", "Editing Room"], ["Harrison", "/shoot", "My Shoots"]];
    for (const [name, url, expected] of staffPaths) { const person = personas.find((x) => x.name === name)!; const r = await get(url, person.cookie); const html = await r.text(); c.ok(`${name} own normal role ${url} renders declared work surface`, r.status === 200 && html.includes(expected) && !html.includes('"digest":"')); }
    const forbiddenEditor = await get("/content", kim.cookie), forbiddenShooter = await get("/content", photographer.cookie);
    c.ok("editor and photographer office navigation denied by actual middleware", forbiddenEditor.status === 307 && !!forbiddenEditor.headers.get("location")?.endsWith("/editing") && forbiddenShooter.status === 307 && !!forbiddenShooter.headers.get("location")?.endsWith("/shoot"));
    const editorQueue = await (await get("/editing", kim.cookie)).text(), shooterList = await (await get("/shoot", photographer.cookie)).text();
    c.ok("actual editor/shooter HTML is scoped to owned fixture and excludes foreign job", editorQueue.includes(ready.title!) && !editorQueue.includes("900 Private Lane") && shooterList.includes(p.title!) && !shooterList.includes("900 Private Lane"));
    const foreignEdit = await get(`/edit/${foreign.projectId}`, kim.cookie), foreignEditHtml = await foreignEdit.text();
    const foreignShoot = await get(`/shoot/${foreign.projectId}`, photographer.cookie), foreignShootHtml = await foreignShoot.text();
    // Next may have started streaming the shell before notFound; its Flight
    // boundary still must carry404 and none of the forbidden job's content.
    c.ok("editor contextual foreign job read fails closed", (foreignEdit.status === 404 || (foreignEdit.status === 200 && foreignEditHtml.includes("NEXT_HTTP_ERROR_FALLBACK;404"))) && !foreignEditHtml.includes("900 Private Lane"), `HTTP${foreignEdit.status};404boundary=${foreignEditHtml.includes("NEXT_HTTP_ERROR_FALLBACK;404")}`);
    const shootRedirect = foreignShoot.status === 307 && !!foreignShoot.headers.get("location")?.endsWith("/shoot");
    const streamedShootRedirect = foreignShoot.status === 200 && (foreignShootHtml.includes("NEXT_REDIRECT;replace;/shoot;307;") || /id="__next-page-redirect"[^>]*content="[^\"]*url=\/shoot"/.test(foreignShootHtml));
    c.ok("photographer contextual foreign shoot redirects to own list before reading private job", (shootRedirect || streamedShootRedirect) && !foreignShootHtml.includes("900 Private Lane"), `HTTP${foreignShoot.status};streamedOwnRedirect=${streamedShootRedirect}`);

    c.head("Actual one-use named OWNER session and exact action/media journey");
    const clientLogin = await get(signIn.url);
    privateManifest.clientCookie = cookieFrom(clientLogin, "rtp_client");
    c.ok("normal named-pilot owner actual one-use auth route stamps acceptance and sets separate Secure cookie", clientLogin.status === 303 && !!clientLogin.headers.get("location")?.endsWith("/portal/me") && !!privateManifest.clientCookie && !!(await prisma.clientUser.findUniqueOrThrow({ where: { id: shell.clientUserId } })).lastLoginAt);
    c.ok("same consumed link cannot sign in again", !!(await get(signIn.url)).headers.get("location")?.includes("/portal/login?reason=invalid"));
    c.ok("client session cannot open staff office", !!(await get("/content", privateManifest.clientCookie)).headers.get("location")?.includes("/login"));
    for (const tab of ["dashboard", "strategy", "topics", "scripts", "filming", "library", "messages"]) { const r = await get(`/portal/me?tab=${tab}`, privateManifest.clientCookie); const html = await r.text(); c.ok(`normal signed client ${tab} HTTP route resolves its exact enrollment without render error`, r.status === 200 && html.includes("Grove Acceptance Realty") && !html.includes('"digest":"')); }
    const anonApprove = await action("/portal/me?tab=scripts", "src/app/portal/actions.ts", "portalApproveScript", [{ enrollmentId: shell.enrollmentId }, rep.scripts.E, pendingScript.sharedVersionId]);
    c.ok("actual action transport rejects script acceptance without client cookie", anonApprove.returned?.ok === false);
    const accepted = await action("/portal/me?tab=scripts", "src/app/portal/actions.ts", "portalApproveScript", [{ enrollmentId: shell.enrollmentId }, rep.scripts.E, pendingScript.sharedVersionId], privateManifest.clientCookie);
    c.ok("signed client action transport pins acceptance to exact released script and actor", accepted.returned?.ok === true && await prisma.contentScriptRelease.count({ where: { scriptId: rep.scripts.E, scriptVersionId: pendingScript.sharedVersionId!, actorClientUserId: shell.clientUserId, action: "CLIENT_APPROVED" } }) === 1);
    const { mediaToken } = await import("@/lib/portalMedia");
    const ownScope = { kind: "membership" as const, id: shell.membershipId };
    const downloadUrl = `/api/portal/download/${video.id}?m=${encodeURIComponent(mediaToken(video.id, ownScope))}`;
    c.ok("unapproved final cannot download over actual HTTP", (await get(downloadUrl, privateManifest.clientCookie)).status === 403);
    const cutApproved = await action("/portal/me?tab=library", "src/app/portal/actions.ts", "portalApproveCut", [{ enrollmentId: shell.enrollmentId }, cuts[1].id, "NONE"], privateManifest.clientCookie);
    c.ok("signed client cut approval action binds own exact released version", cutApproved.returned?.ok === true && await prisma.clientDecision.count({ where: { submissionId: cuts[1].id, clientUserId: shell.clientUserId, decision: "APPROVE" } }) === 1);
    const door = await get(downloadUrl, privateManifest.clientCookie);
    const target = door.headers.get("location");
    const bytes = target ? await get(target, privateManifest.clientCookie, { range: "bytes=0-99" }) : null;
    const streamFailure = bytes && bytes.status !== 206 ? (await bytes.json().catch(() => ({ error: "non-JSON refusal" })) as { error?: string }).error : null;
    c.ok("approved download door and same-origin range stream carry exact fixture bytes", door.status === 302 && bytes?.status === 206 && Buffer.from(await bytes.arrayBuffer()).equals(sampleBytes.subarray(0, 100)), `door=${door.status}; stream=${bytes?.status ?? "not reached"}; ${streamFailure ?? ""}`);
    const wrongScope = `/api/portal/download/${video.id}?m=${encodeURIComponent(mediaToken(video.id, { kind: "membership", id: foreign.membershipId! }))}`;
    c.ok("foreign exact membership media proof cannot cross enrollment over HTTP", (await get(wrongScope)).status === 403);

    c.head("Manual Start/Pause across actual signed server action transport");
    c.ok("declared upload/assignment state never starts Kim automatically", await prisma.editorWorkItem.count({ where: { projectId: ready.id } }) === 0);
    const start = await action("/editing", "src/app/editing/actions.ts", "setQueueStatus", [ready.id, "In editing", randomUUID()], kim.cookie);
    c.ok("Kim actual manual Start records only her own active work", start.returned?.ok === true && await prisma.editorWorkItem.count({ where: { projectId: ready.id, editorKey: "kim", state: "ACTIVE" } }) === 1);
    const pause = await action("/editing", "src/app/editing/actions.ts", "setQueueStatus", [ready.id, "Paused", randomUUID()], kim.cookie);
    c.ok("Kim actual manual Pause retains job stage and exact work event", pause.returned?.ok === true && await prisma.editorWorkItem.count({ where: { projectId: ready.id, editorKey: "kim", state: "PAUSED" } }) === 1 && (await prisma.project.findUniqueOrThrow({ where: { id: ready.id } })).status === "EDITING");
    c.ok("no client sends/provider bookings/automation runner invoked", await prisma.outboxMessage.count() === 0 && await prisma.programAutomation.count({ where: { enabled: true, key: { not: "portal_layout_v2" } } }) === 0 && fence.blocked.length === 0);
    fs.writeFileSync(sessionsFile, JSON.stringify(privateManifest, null, 2), { mode: 0o600 });
    console.log(`HTTP evidence only; exact build ${privateManifest.buildId}; private fixture/session manifest ${sessionsFile}; no browser/provider/phone/full-watch claim.`);
    c.summary();
  } finally {
    try { await terminate(server); }
    finally { fs.closeSync(logFd); await clip.stop(); await db.stop(); fence.restore(); }
    console.log("Stopped only owned Next3211/sample5602/disposable DB5601; main3200/5599/5598 untouched.");
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "Isolated HTTP acceptance failed."); process.exitCode = 1; });
