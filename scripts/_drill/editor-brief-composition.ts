// @drill-run: engine=postgres conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Narrow actual-page composition checks for the U3 brief simplification.
// --serve keeps this same disposable fixture open for supported browser review.
// Its independent source copy starts with only this batch's baseline app files.
// No production data, external providers, senders or background workers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isValidElement } from "react";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { createTestClientShell, seedRepresentativeMonth } from "../_fixtures/representativeMonth";
import { buildSampleMp4, ensureSampleClip, startSampleServer, DEMO_CLIP_URL } from "../demo/sample";

const REPO = path.resolve(__dirname, "../..");
const deliveryProof = process.env.DRILL_K === "delivery-preview-serve";
const DB_PORT = deliveryProof || process.env.DRILL_K === "editor-visual-serve" || process.argv.includes("--serve") ? 5617 : 5627, SAMPLE_PORT = 5618, APP_PORT = 3225;
const BASE = `http://localhost:${APP_PORT}`;
const BASELINE = "5596d4e";
const serve = deliveryProof || process.argv.includes("--serve") || process.env.DRILL_K === "editor-visual-serve";
const c = makeChecker();
installNextStubs();
type Props = Record<string, unknown>;
type Element = { name: string; props: Props; ancestors: { name: string; props: Props }[] };
function elements(tree: unknown, ancestors: Element["ancestors"] = []): Element[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, ancestors));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const name = typeof type === "string" ? type : type.name ?? "";
  const entry = { name, props: tree.props, ancestors };
  return [entry, ...Object.values(tree.props).flatMap((part) => elements(part, [...ancestors, { name, props: tree.props }]))];
}
function words(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(words).join(" ");
  if (!isValidElement<Props>(tree)) return "";
  return Object.values(tree.props).map(words).join(" ");
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), wait(5000)]);
  if (child.exitCode === null && child.signalCode === null) throw new Error("Owned visual Next did not stop; no unrelated process was touched.");
}
const sampleBytes = buildSampleMp4();
const hash = createHash("sha256").update(sampleBytes).digest("hex");
const dropboxHash = createHash("sha256").update(createHash("sha256").update(sampleBytes).digest()).digest("hex");
type Proof = { id: string; rev: string; content_hash: string; size: number };
const files: Record<string, Proof> = {};
const fence = fenceFetch((url, init) => {
  if (url === DEMO_CLIP_URL) return new Response(Uint8Array.from(sampleBytes), { headers: { "content-type": "video/mp4" } });
  if (url === "https://api.dropbox.com/oauth2/token") return new Response(JSON.stringify({ access_token: "isolated-visual-access" }));
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return new Response(JSON.stringify({ root_info: { root_namespace_id: "isolated-visual-root" } }));
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const op = url.slice("https://api.dropboxapi.com/2/".length);
    const args = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { path?: string };
    const proof = files[args.path ?? ""];
    if (op === "files/get_metadata" || op === "files/get_temporary_link") {
      if (!proof) return new Response(JSON.stringify({ error_summary: "path/not_found" }), { status: 409 });
      const metadata = { ".tag": "file", ...proof, path_display: args.path };
      return new Response(JSON.stringify(op === "files/get_metadata" ? metadata : { metadata, link: DEMO_CLIP_URL }));
    }
    if (op === "files/list_folder") return new Response(JSON.stringify({ entries: [], has_more: false, cursor: "isolated-empty" }));
    throw new Error(`Visual fixture refuses undeclared Dropbox operation ${op}.`);
  }
  return null;
});

// Only application files in this UI batch differ in the baseline copy.
// Root switches these same private files to the frozen candidate after capture.
const batchFiles = [
  "src/app/edit/[id]/page.tsx", "src/app/editing/page.tsx",
  "src/components/editing/EditorDesk.tsx", "src/components/editing/SimpleQueue.tsx",
  "src/components/editing/AddToQueue.tsx", "src/components/ops/ReadyToSendCard.tsx",
  "src/components/review/DeliveryExitSummary.tsx", "src/components/ops/MarkSent.tsx",
  "src/components/ops/NotTold.tsx", "src/components/ops/FinalRenditionCheck.tsx",
  "src/lib/readyToSend.ts",
];
function sourceCopy(runtime: string) {
  const checkout = path.join(runtime, "app"); fs.mkdirSync(checkout, { mode: 0o700 });
  for (const rel of ["src", "public", "prisma", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "next-env.d.ts"]) {
    if (fs.existsSync(path.join(REPO, rel))) fs.cpSync(path.join(REPO, rel), path.join(checkout, rel), { recursive: true, verbatimSymlinks: true });
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(checkout, "node_modules"), "dir");
  const proof: { path: string; baseline: string; candidate: string }[] = [];
  for (const rel of batchFiles) {
    const current = fs.readFileSync(path.join(REPO, rel));
    const baseline = execFileSync("git", ["show", `${BASELINE}:${rel}`], { cwd: REPO });
    proof.push({ path: rel, baseline: createHash("sha256").update(baseline).digest("hex"), candidate: createHash("sha256").update(current).digest("hex") });
    // Candidate source is retained; baseline hashes document the comparison.
  }
  if (fs.readdirSync(checkout).some((name) => name.startsWith(".env")) || fs.existsSync(path.join(checkout, ".git"))) throw new Error("Private visual copy must contain no environment or Git files.");
  return { checkout, baseline: BASELINE, files: proof };
}

async function main() {
  for (const port of [DB_PORT, ...(serve ? [SAMPLE_PORT, APP_PORT] : [])]) if (!await portFree(port)) throw new Error(`Reserved visual port ${port} is busy; no process stopped.`);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-editor-visual-")); fs.chmodSync(runtime, 0o700);
  const secret = randomBytes(32).toString("hex"), password = `Isolated-${randomBytes(12).toString("hex")}`;
  const db = await bootDrillDb({ port: DB_PORT, engine: "postgres", env: { AUTH_ENFORCE: "true", APP_SECRET: secret, NEXT_PUBLIC_APP_URL: BASE, DROPBOX_APP_KEY: "isolated-visual-key", DROPBOX_APP_SECRET: "isolated-visual-secret" } });
  let server: ChildProcess | undefined;
  let sample: Awaited<ReturnType<typeof startSampleServer>> | undefined;
  let logFd: number | undefined;
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { hashPassword } = await import("@/lib/auth/password");
    const { ensureOutputsForProject, saveOutputBrief, outputBriefsFor } = await import("@/lib/deliverableOutputs");
    const { assignmentReceiptStates } = await import("@/lib/editorBriefReceipt");
    const { acknowledgeEditorBrief } = await import("@/app/edit/[id]/receipt.actions");
    const { startEditingAction, pauseEditingAction } = await import("@/app/editing/workActions");
    const { backupReceiptData } = await import("@/lib/finalDropbox");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const { default: page } = await import("@/app/edit/[id]/page");
    const passwordHash = await hashPassword(password);
    const personas = [];
    for (const [name, role, editorKey] of [["Jordan", "OWNER", null], ["Kyle", "ADMIN", null], ["James", "ADMIN", null], ["Kim", "EDITOR", "kim"], ["John", "EDITOR", "john"]] as const) {
      const email = `${name.toLowerCase()}-visual@example.test`;
      const rosterName = name === "Kim" ? "Kim Miguel" : name === "John" ? "John Mark" : name;
      const member = await prisma.teamMember.create({ data: { name: rosterName, email, role: role === "EDITOR" ? "EDITOR" : "MANAGER", active: true } });
      const user = await prisma.appUser.create({ data: { name, email, role, editorKey, teamMemberId: member.id, status: "ACTIVE", passwordHash } });
      personas.push({ name, email, role, id: user.id, teamMemberId: member.id });
    }
    const [owner, kyle, james, kim, john] = personas;
    const signIn = (u: typeof owner, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, actingAs });
    await signIn(owner);
    const shell = await createTestClientShell(prisma, { name: "Grove Visual TEST", slug: "editorvisual" });
    const monthKey = etMonthKey(new Date());
    const rep = await seedRepresentativeMonth(prisma, { clientId: shell.clientId, monthKey, tier: "program", variant: "accelerator" });
    await prisma.client.update({ where: { id: shell.clientId }, data: { name: "Grove Realty", email: "grove-visual@example.test", autoConfirmationText: false, autoDeliveryText: false, generalNotes: "Keep the client's tone calm and specific. The client paid a $500 rush fee." } });
    const { PROGRAM_ROLLOUT_SETTING_KEY, serializeProgramRollout } = await import("@/lib/programRolloutCore");
    const since = new Date(Date.now() - 60_000).toISOString();
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: serializeProgramRollout({ mode: "PILOT", modeSince: since, pilot: { clientIds: [shell.clientId], operations: ["portal_sign_in", "portal_layout_v2"], approvedBy: "declared isolated visual input", approvedAt: since, expiresAt: new Date(Date.now() + 6 * 864e5).toISOString(), joinedAt: { [shell.clientId]: since }, note: "Disposable visual fixture; no send/worker operations" } }) } });
    await prisma.programAutomation.create({ data: { key: "portal_layout_v2", enabled: true, enabledBy: "declared isolated fixture", enabledAt: new Date() } });
    await prisma.appSetting.createMany({ data: [
      { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: james.teamMemberId, backupReviewerTeamMemberId: kyle.teamMemberId }) },
      { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim", standardVideo: "kim", premiumVideo: "john" }) },
    ] });
    await saveSecret("dropbox", "isolated-visual-refresh");
    const yesterday = new Date(Date.now() - 864e5), tomorrow = new Date(Date.now() + 864e5);
    const mainJob = await prisma.project.create({ data: { clientId: shell.clientId, contentMonthId: rep.monthId, title: "117 Grove Lane — monthly content", addressLine: "117 Grove Lane, West Chester, PA 19382", status: "EDITING", source: "MANUAL", shootDate: yesterday, deliveryDue: tomorrow, videosFilmed: 2, editorId: kim.teamMemberId, editorManual: true, dropboxFolder: "/isolated/visual/grove/session-one", statusEvidence: JSON.stringify({ dropbox: { rawVideo: 8, finalVideo: 2, stale: false } }), videoInstructions: "Use natural speech and keep captions inside the safe area." } });
    const deliverable = await prisma.deliverable.create({ data: { projectId: mainJob.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", videoStyle: "personal_branding", quantity: 16 } });
    await ensureOutputsForProject(mainJob.id);
    const outputs = await prisma.deliverableOutput.findMany({ where: { projectId: mainJob.id }, orderBy: { slot: "asc" } });
    const topicIds = [rep.topics.A, rep.topics.B], scriptIds = [rep.scripts.A, rep.scripts.B];
    const cuts: { id: string }[] = [];
    for (const [i, output] of outputs.entries()) {
      const topic = await prisma.contentTopic.findUniqueOrThrow({ where: { id: topicIds[i % 2] } });
      const script = await prisma.contentScript.findUniqueOrThrow({ where: { id: scriptIds[i % 2] } });
      await prisma.deliverableOutput.update({ where: { id: output.id }, data: { title: topic.title, topicId: topic.id, filmingNote: i === 0 ? "Use take two; the opening was cleaner." : "Keep the walk past the bakery in the second half.", ownerKey: "kim", ownerName: "Kim", ownerSetAt: yesterday, rawInAt: yesterday, promisedAt: tomorrow } });
      const saved = await saveOutputBrief({ projectId: mainJob.id, outputId: output.id, actor: "Kyle — declared visual fixture", brandChoice: "none", sections: { purpose: i === 0 ? "Help a seller understand how the first weekend shapes pricing." : "Show the neighborhood through a Saturday morning walk.", direction: "Conversational vertical reel with readable captions.", mustShow: "Use the approved opening and the named footage folder.", footage: "Use the second take and retain the complete final sentence." } });
      if (!saved.ok) throw new Error("Declared visual brief could not be prepared.");
      await prisma.contentVideo.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, monthId: rep.monthId, monthKey, projectId: mainJob.id, deliverableId: deliverable.id, slot: output.slot, outputId: output.id, topicId: topic.id, title: topic.title, scriptId: script.id, scriptVersionId: script.currentVersionId, filmedAt: yesterday, filmedConfirmedAt: yesterday, filmedConfirmedBy: "Declared fixture photographer", filmedSource: "staff", status: "EDITING" } });
      if (i >= 14) continue;
      const cut = await prisma.reviewSubmission.create({ data: { projectId: mainJob.id, deliverableId: deliverable.id, outputId: output.id, slot: output.slot, round: i + 1, status: i === 0 ? "CHANGES_REQUESTED" : i === 1 ? "PENDING" : "APPROVED", fileName: `grove-video-${i + 1}-v${i + 1}.mp4`, blobUrl: DEMO_CLIP_URL, source: "upload", sourceWidth: 1080, sourceHeight: 1920, sizeBytes: sampleBytes.length, contentHash: hash, submittedByKey: "kim", submittedByName: "Kim", reviewerTeamMemberId: james.teamMemberId, reviewerAssignedAt: yesterday, selfCheckedAt: yesterday, ...(i === 0 ? { decidedAt: yesterday, decidedBy: "James — declared fixture verdict" } : {}) } });
      await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { assetUrl: `/api/review/cut/${cut.id}/stream` } });
      await prisma.deliverableOutput.update({ where: { id: output.id }, data: { currentSubmissionId: cut.id } });
      cuts.push(cut);
    }
    const note = await prisma.mediaNote.create({ data: { projectId: mainJob.id, assetUrl: `/api/review/cut/${cuts[0].id}/stream`, assetType: "video", lane: "EDITOR", editorKey: "kim", kind: "fix", timeSec: 5, body: "At 00:05 keep the opening caption on screen through the full sentence.", authorName: "James", authorUserId: james.id } });
    await prisma.revisionIssue.create({ data: { projectId: mainJob.id, outputId: outputs[0].id, deliverableId: deliverable.id, slot: 1, raisedOnSubmissionId: cuts[0].id, sourceKind: "REVIEW_NOTE", sourceId: note.id, originalText: note.body, summary: "Keep the opening caption through the full sentence", timeSec: 5, assignedEditorKey: "kim", versionEditorKey: "kim", raisedByName: "James", category: "Captions", state: "OPEN" } });
    const praise = await prisma.mediaNote.create({ data: { projectId: mainJob.id, assetUrl: `/api/review/cut/${cuts[0].id}/stream`, assetType: "video", lane: "EDITOR", editorKey: "kim", kind: "fix", status: "OPEN", body: "The opening shot is beautiful", authorName: "James", authorUserId: james.id } });
    const praiseIssue = await prisma.revisionIssue.create({ data: { projectId: mainJob.id, outputId: outputs[0].id, deliverableId: deliverable.id, slot: 1, raisedOnSubmissionId: cuts[0].id, sourceKind: "REVIEW_NOTE", sourceId: praise.id, originalText: praise.body, state: "VERIFIED", cause: "EDITOR_ERROR", causeConfirmedBy: "James", verifiedBy: "James", verifiedAt: yesterday } });
    const issues = await import("@/lib/revisionIssues");
    c.ok("reviewer can correct a verified misclassification without deleting its source", (await issues.markIssueNotApplicable(praiseIssue.id, "This is a comment, not a requested edit", { name: "James", userId: james.id })).ok && await prisma.revisionIssueEvent.count({ where: { issueId: praiseIssue.id, kind: "NOT_APPLICABLE" } }) === 1 && (await prisma.mediaNote.findUniqueOrThrow({ where: { id: praise.id } })).status === "OPEN");
    const reopened = await prisma.revisionIssue.findUniqueOrThrow({ where: { sourceKind_sourceId: { sourceKind: "REVIEW_NOTE", sourceId: note.id } } });
    await prisma.revisionIssue.update({ where: { id: reopened.id }, data: { state: "VERIFIED", verifiedAt: yesterday, verifiedBy: "James" } });
    await issues.reopenIssue(reopened.id, { name: "James", userId: james.id });
    c.ok("reopened change preserves a single linked root", await prisma.revisionIssue.count({ where: { sourceKind: "REVIEW_NOTE", sourceId: note.id } }) === 1 && (await prisma.revisionIssue.findUniqueOrThrow({ where: { id: reopened.id } })).state === "REOPENED");
    await prisma.smartTask.create({ data: { projectId: mainJob.id, clientId: shell.clientId, taskType: "video_revision", title: "Revise Grove video 1 · opening caption", assignedKey: "kim", assignedManually: true, status: "OPEN", dedupeKey: `visual-revision-${cuts[0].id}`, dueAt: tomorrow, outputId: outputs[0].id, source: "manual" } });
    await prisma.projectMessage.create({ data: { projectId: mainJob.id, body: "Creative questions go to James. Kyle can confirm the exact missing source file.", authorName: "Kyle", authorId: kyle.teamMemberId } });
    // This single shared-instruction output previously lacked its #brief target.
    const single = await prisma.project.create({ data: { clientId: shell.clientId, title: "48 Birch Lane — paused listing reel", status: "SHOT", source: "MANUAL", shootDate: yesterday, editorId: kim.teamMemberId, editorManual: true, dropboxFolder: "/isolated/visual/birch", statusEvidence: JSON.stringify({ dropbox: { rawVideo: 4 } }), videoInstructions: "Use natural daylight and retain the final sentence." } });
    await prisma.deliverable.create({ data: { projectId: single.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1 } });
    await ensureOutputsForProject(single.id);
    const singleOutput = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: single.id } });
    await prisma.deliverableOutput.update({ where: { id: singleOutput.id }, data: { ownerKey: "kim", ownerName: "Kim", ownerSetAt: yesterday, rawInAt: yesterday } });
    for (const job of [mainJob, single]) await prisma.smartTask.create({ data: { projectId: job.id, clientId: shell.clientId, taskType: "edit_video", title: `Edit ${job.title}`, assignedKey: "kim", assignedManually: true, status: "OPEN", dedupeKey: `edit-video-${job.id}`, dueAt: tomorrow, source: "manual" } });
    await signIn(kim);
    const safeBriefs = await outputBriefsFor(mainJob.id, { scrub: true });
    const receiptStates = await assignmentReceiptStates(mainJob.id, safeBriefs, mainJob);
    const receipt = await acknowledgeEditorBrief(mainJob.id, outputs[0].id, receiptStates.get(outputs[0].id)!.digest);
    if (!receipt.ok) throw new Error("Declared exact editor receipt could not be prepared.");
    for (const result of [await startEditingAction({ projectId: single.id, requestId: randomUUID() }), await pauseEditingAction({ projectId: single.id, requestId: randomUUID() }), await startEditingAction({ projectId: mainJob.id, requestId: randomUUID() })]) if (!result.ok) throw new Error(`Explicit fixture manual work action refused: ${result.message}`);

    await signIn(owner);
    const ready = await prisma.project.create({ data: { clientId: shell.clientId, contentMonthId: rep.monthId, title: "118 Grove Lane — final delivery checks", addressLine: "118 Grove Lane, West Chester, PA 19382", status: "REVIEW", source: "MANUAL", shootDate: yesterday, deliveryDue: tomorrow, videosFilmed: 2, editorId: kim.teamMemberId, editorManual: true, dropboxFolder: "/isolated/visual/grove/session-two", statusEvidence: JSON.stringify({ dropbox: { rawVideo: 4, finalVideo: 2 } }) } });
    const finalDeliverable = await prisma.deliverable.create({ data: { projectId: ready.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", quantity: 2 } });
    await ensureOutputsForProject(ready.id);
    const readyOutputs = await prisma.deliverableOutput.findMany({ where: { projectId: ready.id }, orderBy: { slot: "asc" } });
    const readyCuts = [];
    for (const output of readyOutputs) {
      const cut = await prisma.reviewSubmission.create({ data: { projectId: ready.id, deliverableId: finalDeliverable.id, outputId: output.id, slot: output.slot, round: 1, status: "APPROVED", fileName: `grove-final-${output.slot}-v1.mp4`, blobUrl: DEMO_CLIP_URL, source: "upload", sourceWidth: 1080, sourceHeight: 1920, sizeBytes: sampleBytes.length, contentHash: hash, submittedByKey: "kim", submittedByName: "Kim", reviewerTeamMemberId: james.teamMemberId, reviewerAssignedAt: yesterday, selfCheckedAt: yesterday, decidedAt: yesterday, decidedBy: "James — declared fixture approval", completedAt: yesterday } });
      const finalPath = `${ready.dropboxFolder}/05-Final-Video/${cut.fileName}`;
      const proof = { id: `id:visual-${cut.id}`, rev: "visual-v1", content_hash: dropboxHash, size: sampleBytes.length };
      files[finalPath] = proof;
      await prisma.auditLog.create({ data: backupReceiptData(cut, { id: proof.id, rev: proof.rev, hash: proof.content_hash, size: proof.size, path: finalPath }) });
      await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { assetUrl: `/api/review/cut/${cut.id}/stream`, finalPath } });
      await prisma.deliverableOutput.update({ where: { id: output.id }, data: { title: `Final content ${output.slot}`, ownerKey: "kim", ownerName: "Kim", currentSubmissionId: cut.id, approvedSubmissionId: cut.id } });
      readyCuts.push(cut);
    }
    const testClient = await prisma.client.create({ data: { name: "Fixture North TEST", autoConfirmationText: false, autoDeliveryText: false } });
    const testJob = await prisma.project.create({ data: { clientId: testClient.id, title: "TEST comparison only", status: "SHOT", shootDate: yesterday, editorId: john.teamMemberId, editorManual: true, statusEvidence: JSON.stringify({ dropbox: { rawVideo: 1 } }) } });
    await prisma.deliverable.create({ data: { projectId: testJob.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1 } });

    c.head("Actual signed brief composition; existing causal journeys are not rerun");
    await signIn(kim);
    const before = JSON.stringify({ work: await prisma.editorWorkItem.findMany({ orderBy: { id: "asc" } }), receipts: await prisma.editorBriefReceipt.findMany({ orderBy: { id: "asc" } }), cuts: await prisma.reviewSubmission.findMany({ orderBy: { id: "asc" } }) });
    const queue = "/editing?editor=kim&due=overdue&stage=changes";
    const tree = await page({ params: Promise.resolve({ id: mainJob.id }), searchParams: Promise.resolve({ queue, cut: cuts[0].id }) });
    const flat = elements(tree), by = (name: string) => flat.filter((e) => e.name === name);
    c.ok("all canonical outputs are selectable while only one article expands", flat.filter((e) => typeof e.props.id === "string" && e.props.id.startsWith("brief-")).length === 1 && outputs.every((o) => flat.some((e) => typeof e.props.href === "string" && e.props.href.includes(`output=${o.id}`))) && flat.some((e) => e.props["aria-label"] === "Video selector"));
    // Oct 5: the per-video "Receive this assignment" became ONE "Got it". Oct 5
    // night review: that one press acknowledged EVERY pending video, opened or
    // not, so it now carries only the exact digest of the video on the page
    // (when that one still needs it) and names Kim's other pending videos,
    // one tap away. The receipt itself is unchanged.
    const gotIt = by("BriefGotIt");
    const pending = (gotIt[0]?.props.pending ?? []) as { outputId: string; digest: string }[];
    const others = (gotIt[0]?.props.otherVideos ?? []) as { number: number; href: string }[];
    const selectedArticle = flat.find((e) => typeof e.props.id === "string" && e.props.id.startsWith("brief-"))?.props.id as string | undefined;
    const selectedOutput = selectedArticle?.slice("brief-".length) ?? null;
    const pendingIds = outputs.filter((o) => o.id !== outputs[0].id).map((o) => o.id);
    c.ok("one Got it, for the video on the page only: never a digest for an unopened video; Kim's other pending videos are named with a link",
      gotIt.length === 1 && pending.every((p) => p.outputId === selectedOutput && p.digest === receiptStates.get(p.outputId)?.digest) && pending.length === (pendingIds.includes(selectedOutput ?? "") ? 1 : 0) && others.length === pendingIds.filter((id) => id !== selectedOutput).length && others.every((v) => pendingIds.some((id) => v.href.includes(`output=${id}`))) && gotIt[0].ancestors.some((a) => typeof a.props.id === "string" && a.props.id.startsWith("brief-")),
      JSON.stringify({ selectedOutput, pending: pending.map((p) => p.outputId), others: others.map((o) => o.number) }));
    c.ok("canonical briefs retain exact filmed script words, source links and intentional no-brand choice", safeBriefs.filter((b) => flat.some((e) => e.props.id === `brief-${b.outputId}`)).every((b) => { const article = flat.find((e) => e.props.id === `brief-${b.outputId}`); const nested = elements(article?.props.children); return !!article && words(article.props.children).includes("the office's choice") && (!b.folder || nested.some((e) => e.props.href === b.folder?.url)) && (!b.script?.text || nested.some((e) => e.name === "BriefScript" && e.props.body === b.script?.text)); }));
    c.ok("selected revision instructions and raw files remain available", flat.some((e) => e.props.target === "_blank" && typeof e.props.href === "string" && e.props.href.includes("grove")) && by("RevisionIssuesPanel").some((e) => e.props.canReview === false));
    c.ok("exact current-cut, submit and conversation destinations survive", flat.some((e) => e.props.id === "submit-cut") && flat.some((e) => typeof e.props.href === "string" && e.props.href.includes(`cut=${cuts[0].id}`) && e.props.href.endsWith(`#cut-${cuts[0].id}`)) && by("EditorCutPanel").some((e) => e.props.submissionId === cuts[0].id) && by("CutUploader").length === 1 && flat.some((e) => e.props.href === "#messages"));
    const currentIssues = by("RevisionIssuesPanel").find((e) => e.props.canReview === false && !e.ancestors.some((a) => a.name === "details"));
    c.ok("linked legacy OPEN notes do not duplicate verified or reopened instructions", (currentIssues?.props.issues as { id: string }[]).filter((issue) => issue.id === reopened.id).length === 1 && !(currentIssues?.props.issues as { id: string }[]).some((issue) => issue.id === praiseIssue.id) && by("EditorCutPanel").every((e) => !(e.props.notes as { id: string }[]).some((entry) => entry.id === praise.id || entry.id === note.id)));
    c.ok("manual work bar and exact uploader/QC controls remain independent of receipt", by("WorkStateBar").length === 1 && by("CutUploader")[0].props.canUpload === true && by("CutUploader")[0].props.checks !== undefined && by("RevisionIssuesPanel").length === 2 && by("ProjectMessages")[0].props.readOnly === false);
    c.ok("visible top tracker and folded sessions retain mounted children", by("EditTracker").some((e) => e.ancestors.some((a) => a.name === "section" && a.props.id === "edit-history")) && flat.some((e) => e.name === "details" && e.props.id === "month-sessions" && e.props.open !== true && !!e.props.children));
    const tracker = by("EditTracker")[0];
    c.ok("top tracker follows selected revision rather than another approved output", String(tracker.props.statusLine).includes("Changes requested") && tracker.props.dueISO === safeBriefs.find((b) => b.outputId === outputs[0].id)?.promisedAtISO);
    c.ok("every history link selects its exact version before anchoring", (tracker.props.rounds as { id: string; href: string }[]).every((r) => r.href.includes(`cut=${r.id}`) && r.href.endsWith(`#cut-${r.id}`)));
    c.ok("editor brief free-text remains creative-safe after recomposition", !words(tree).includes("$500") && !JSON.stringify(by("BriefScript").map((e) => e.props.body)).includes("$500"));
    const empty = elements(await page({ params: Promise.resolve({ id: mainJob.id }), searchParams: Promise.resolve({ queue, output: outputs[15].id }) }));
    c.ok("sixteen mixed-state outputs include an unsubmitted selected workspace", outputs.length === 16 && empty.filter((e) => e.props["aria-current"] === "page").length === 1 && empty.some((e) => e.props.id === `brief-${outputs[15].id}`) && !empty.some((e) => e.name === "EditorCutPanel"));
    for (const data of [
      { body: "Standing natural music", scope: "PERMANENT", projectId: null, monthId: null },
      { body: "Builder walkthrough only", scope: "PROJECT", projectId: mainJob.id, monthId: null },
      { body: "Agent reel only", scope: "PROJECT", projectId: single.id, monthId: null },
      { body: "Exact month instruction", scope: "MONTH", projectId: null, monthId: rep.monthId },
      { body: "Another month instruction", scope: "MONTH", projectId: null, monthId: "unrelated-month" },
    ]) await prisma.clientFact.create({ data: { clientId: shell.clientId, category: "PRODUCTION_PREFERENCE", source: "staff", status: "ACCEPTED", aiContext: "ALLOWED", ...data } });
    await prisma.clientFact.createMany({ data: [
      { clientId: shell.clientId, category: "PRODUCTION_PREFERENCE", body: "Unapproved AI command", source: "ai", status: "PROPOSED", aiContext: "ALLOWED" },
      { clientId: shell.clientId, category: "PRODUCTION_PREFERENCE", body: "Private instruction", source: "staff", status: "ACCEPTED", aiContext: "ALLOWED", confidential: true },
      { clientId: shell.clientId, category: "INTERNAL", body: "General CRM narrative", source: "staff", status: "ACCEPTED", aiContext: "ALLOWED", projectId: mainJob.id, scope: "PROJECT" },
    ] });
    const { productionFactsForBrief } = await import("@/lib/clientFacts");
    const mainFacts = await productionFactsForBrief(shell.clientId, mainJob.id), singleFacts = await productionFactsForBrief(shell.clientId, single.id);
    c.ok("standing preferences travel, project requests do not", mainFacts.some((f) => f.body === "Standing natural music") && mainFacts.some((f) => f.body === "Builder walkthrough only") && !mainFacts.some((f) => f.body === "Agent reel only") && singleFacts.some((f) => f.body === "Agent reel only") && !singleFacts.some((f) => f.body === "Builder walkthrough only"));
    c.ok("actual project month controls scope; private, proposed AI and CRM narrative stay out", mainFacts.some((f) => f.body === "Exact month instruction") && !singleFacts.some((f) => f.scope === "MONTH") && !mainFacts.some((f) => ["Another month instruction", "Private instruction", "Unapproved AI command", "General CRM narrative"].includes(f.body)));
    const one = await page({ params: Promise.resolve({ id: single.id }), searchParams: Promise.resolve({ queue }) });
    const oneFlat = elements(one);
    // Oct 5: one video on a job has no video chooser (its brief IS the page);
    // its link target and its one Got it remain.
    c.ok("single shared-instruction output keeps its exact link target and one Got it", oneFlat.filter((e) => e.props.id === `brief-${singleOutput.id}`).length === 1 && !oneFlat.some((e) => e.props["aria-label"] === "Video selector") && oneFlat.filter((e) => e.name === "BriefGotIt").length === 1 && ((oneFlat.find((e) => e.name === "BriefGotIt")?.props.pending ?? []) as { outputId: string }[]).every((p) => p.outputId === singleOutput.id));
    const after = JSON.stringify({ work: await prisma.editorWorkItem.findMany({ orderBy: { id: "asc" } }), receipts: await prisma.editorBriefReceipt.findMany({ orderBy: { id: "asc" } }), cuts: await prisma.reviewSubmission.findMany({ orderBy: { id: "asc" } }) });
    c.ok("page recomposition never auto-starts, accepts a receipt or changes cut history", before === after && await prisma.outboxMessage.count() === 0);
    await signIn(owner, kim.id);
    const preview = elements(await page({ params: Promise.resolve({ id: mainJob.id }), searchParams: Promise.resolve({}) }));
    c.ok("moved receipt and uploader stay read-only in owner preview", !preview.some((e) => e.name === "BriefGotIt") && preview.find((e) => e.name === "CutUploader")?.props.canUpload === false);
    await signIn(kyle);
    const office = elements(await page({ params: Promise.resolve({ id: mainJob.id }), searchParams: Promise.resolve({}) }));
    c.ok("office brief forms remain mounted inside native disclosures with exact expected versions", outputs.filter((o) => office.some((e) => e.props.id === `brief-${o.id}`)).every((o) => office.some((e) => e.name === "form" && e.ancestors.some((a) => a.name === "details") && elements(e.props.children).some((x) => x.props.name === "outputId" && x.props.value === o.id) && elements(e.props.children).some((x) => x.props.name === "expectedVersion" && x.props.value === 1))));
    c.ok("all providers remained declared fakes and workers/sends stayed off", fence.blocked.length === 0 && await prisma.programAutomation.count({ where: { enabled: true, key: { not: "portal_layout_v2" } } }) === 0 && await prisma.outboxMessage.count() === 0);
    c.ok("social brief never shows the music chooser and directs trending audio", !office.some((e) => e.name === "MusicCard") && words(office.map((e) => e.props.children)).includes("trending audio"));
    // Oct 5: the Brand section is section 5 of the brief itself, so it needs no
    // jump pill; the client's asset shelf (and its upload) sits inside it.
    c.ok("client assets live in the brief's Brand section", office.some((e) => e.name === "section" && e.props.id === "brand-assets" && elements(e.props.children).some((x) => x.name === "ClientAssetsCard" || (typeof x.props.href === "string" && x.props.href.includes("dropbox")))));
    if (!serve) {
      await prisma.deliverable.updateMany({ where: { projectId: single.id }, data: { videoStyle: "standard_cinematic", type: "VIDEO" } });
      const cinematic = elements(await page({ params: Promise.resolve({ id: single.id }), searchParams: Promise.resolve({}) }));
      c.ok("standard horizontal cinematic brief retains the licensed music chooser", cinematic.some((e) => e.name === "MusicCard"));
      const { videoNavigationFor } = await import("@/lib/videoNavigation");
      const initialNavigation = await videoNavigationFor(mainJob.id);
      await prisma.project.update({ where: { id: mainJob.id }, data: { videosOwedOverride: 4 } });
      await ensureOutputsForProject(mainJob.id);
      const reducedNavigation = await videoNavigationFor(mainJob.id);
      c.ok("retiring outputs does not renumber surviving or historical video identities", JSON.stringify([...initialNavigation]) === JSON.stringify([...reducedNavigation]));
      await prisma.project.update({ where: { id: mainJob.id }, data: { videosOwedOverride: 18 } });
      await ensureOutputsForProject(mainJob.id);
      const expandedNavigation = await videoNavigationFor(mainJob.id);
      c.ok("new override outputs append while prior video numbers remain stable", expandedNavigation.size === 18 && [...initialNavigation].every(([key, value]) => expandedNavigation.get(key)?.number === value.number));
    }
    c.summary();
    if (process.exitCode) throw new Error("New brief composition check failed; no visual server started.");
    if (!serve) return;

    if (deliveryProof) {
      await prisma.project.update({ where: { id: ready.id }, data: { aryeoListingId: "isolated-preview-listing" } });
      const { chooseAryeoDelivery, destinationFingerprint } = await import("@/lib/videoDeliveryDestination");
      const { loadCut } = await import("@/lib/finalRendition");
      for (const cut of readyCuts) {
        await prisma.topazJob.create({ data: { projectId: ready.id, submissionId: cut.id, state: "done", finalPath: `${ready.dropboxFolder}/05-Final-Video/${cut.fileName}`, savedAt: yesterday, outputCheck: "verified" } });
        const result = await chooseAryeoDelivery(cut.id, destinationFingerprint((await loadCut(cut.id))!), { id: owner.id, name: "Declared fixture owner" });
        if (!result.ok) throw new Error(result.message);
      }
    }

    const copy = sourceCopy(runtime);
    if (deliveryProof) {
      const route = path.join(copy.checkout, "src/app/delivery-preview-proof"); fs.mkdirSync(route);
      fs.writeFileSync(path.join(route, "page.tsx"), `import { requireAdmin } from '@/lib/auth/guards';
import { readyToSend } from '@/lib/readyToSend';
import { ReadyToSendCard } from '@/components/ops/ReadyToSendCard';
import { WatchDeliveryVideo } from '@/components/ops/WatchDeliveryVideo';
export const dynamic = 'force-dynamic';
export default async function Page() { await requireAdmin(); const board = await readyToSend({projectId:${JSON.stringify(ready.id)}}); return <main className="mx-auto max-w-3xl space-y-4 p-4"><h1>Isolated delivery playback</h1><ReadyToSendCard board={board}/><WatchDeliveryVideo label="Watch unavailable fixture" videos={[{id:${JSON.stringify(readyCuts[0].id)}, src:${JSON.stringify(`/api/review/cut/${readyCuts[0].id}/final?f=stale&play=1`)}, title:'Declared unavailable file'}]}/></main>; }`);
    }
    const fixtureFile = path.join(runtime, "runtime.private.json"), manifestFile = path.join(runtime, "visual.private.json"), serverLog = path.join(runtime, "next-server.log");
    fs.writeFileSync(fixtureFile, JSON.stringify({ runtime, dbPort: DB_PORT, samplePort: SAMPLE_PORT, sampleUrl: deliveryProof ? `http://localhost:${SAMPLE_PORT}/review-cuts/fixture/sample-reel.mp4` : DEMO_CLIP_URL, files }), { mode: 0o600 });
    const manifest = { warning: "Disposable isolated visual fixture only. Every provider fenced; no sends/workers/booking. Credentials and paths private. Baseline batch files only; all other source is current.", base: BASE, runtime, source: copy, password, personas, urls: { login: `${BASE}/login`, editing: `${BASE}/editing`, editingTest: `${BASE}/editing?test=1`, brief: `${BASE}/edit/${mainJob.id}?cut=${cuts[0].id}`, singleBrief: `${BASE}/edit/${single.id}`, readyBrief: `${BASE}/edit/${ready.id}`, review: `${BASE}/review`, reviewCut: `${BASE}/review/${mainJob.id}?cut=${cuts[1].id}`, delivery: `${BASE}/?test=1#ready-to-send` }, projectId: mainJob.id, singleProjectId: single.id, readyProjectId: ready.id, exactCutIds: cuts.map((cut) => cut.id), readyCutIds: readyCuts.map((cut) => cut.id), outputIds: outputs.map((o) => o.id), dbPort: DB_PORT, samplePort: SAMPLE_PORT, appPort: APP_PORT };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    sample = await startSampleServer(ensureSampleClip(runtime), SAMPLE_PORT);
    logFd = fs.openSync(serverLog, "w", 0o600);
    // Node imports this CJS provider layer after the inherited --require
    // isolation boundary. Separate option names avoid Next dev's CLI merging
    // repeated --require paths. The ordinary supported CLI owns dev setup.
    server = spawn(process.execPath, [path.join(REPO, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(APP_PORT)], { cwd: copy.checkout, env: { ...process.env, NODE_ENV: "development", AUTH_ENFORCE: "true", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--import ${JSON.stringify(path.join(__dirname, "_normal-role-http-preload.cjs"))}`, RTP_HTTP_FIXTURE: fixtureFile }, stdio: ["ignore", logFd, logFd] });
    let up = false;
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Owned visual Next exited ${server.exitCode}; inspect private log.`);
      try { if ((await fetch(`${BASE}/login`, { redirect: "manual" })).status === 200) { up = true; break; } } catch { /* wait only for the owned process */ }
      await wait(500);
    }
    if (!up) throw new Error("Owned visual server did not become ready; inspect private log.");
    console.log(`VISUAL READY: candidate from ${BASELINE}; app3225/PG5617/sample5618. Private manifest: ${manifestFile}. Private source: ${copy.checkout}. Owned Next PID ${server.pid}. Main3200/5599/5598 and damaged saved demo untouched.`);
    console.log("Actual browser password login is required; no mounted visual pass is claimed by this runner. Stop this owned fixture with Ctrl-C after review.");
    await new Promise<void>((resolve, reject) => {
      const end = () => { process.removeListener("SIGINT", end); process.removeListener("SIGTERM", end); resolve(); };
      process.once("SIGINT", end); process.once("SIGTERM", end);
      server!.once("exit", (code, signal) => { process.removeListener("SIGINT", end); process.removeListener("SIGTERM", end); reject(new Error(`Owned visual Next exited unexpectedly (${code ?? signal}).`)); });
    });
  } finally {
    try { await stop(server); }
    finally { try { await sample?.stop(); } finally { try { if (logFd !== undefined) fs.closeSync(logFd); } finally { try { await db.stop(); } finally { fence.restore(); } } } }
    console.log(`Cleaned owned fixture PG${DB_PORT}${serve ? `/app${APP_PORT}/sample${SAMPLE_PORT}` : ""}; existing processes and saved demo files preserved.`);
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Isolated visual fixture failed."); process.exitCode = 1; });
