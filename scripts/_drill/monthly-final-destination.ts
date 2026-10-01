// @drill-run: engine=postgres
// Actual signed monthly final-file actions/routes; isolated Postgres and fake
// Dropbox/media only. No production records, sends, bookings or activation.
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, portFree } from "./_harness";
const ORIGINAL = Buffer.from("ORIGINAL exact approved cut bytes"), PROCESSED = Buffer.from("PROCESSED exact portal rendition"), WRONG = Buffer.from("different file at the expected path");
const contentHash = (bytes: Buffer) => createHash("sha256").update(createHash("sha256").update(bytes).digest()).digest("hex");
type File = { bytes: Buffer; id: string; rev: string };
const files = new Map<string, File>(), sources = new Map<string, Buffer>(), calls: { op: string; args: Record<string, string> }[] = [];
let mode: "complete" | "pending" | "lost" | "wrong" = "complete", jobDone = false, moveFails = false, seq = 0;
let metadataHook: (() => Promise<void>) | null = null;
let linkReplacement = false, replaceAfterAck = false;
const put = (path: string, bytes: Buffer) => files.set(path, { bytes, id: `id:fixture${++seq}`, rev: `rev${seq}` });
interceptModule((r) => r === "@/lib/integrations/dropbox" || /[\\/]src[\\/]lib[\\/]integrations[\\/]dropbox(\.ts)?$/.test(r), (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) {
  if (k !== "dbx") return t[k];
  return async (op: string, args: Record<string, string>) => {
    calls.push({ op, args });
    const fail = (message: string) => { const E = t.DropboxError as new (s: string) => Error; throw new E(message); };
    if (op === "files/create_folder_v2") return {};
    if (op === "files/save_url") {
      if (mode === "wrong" && !files.has(args.path)) put(args.path, WRONG);
      if (files.has(args.path)) return fail("path/conflict/file");
      if (mode === "pending") return { ".tag": "async_job_id", async_job_id: "isolated-job" };
      put(args.path, replaceAfterAck ? Buffer.alloc(sources.get(args.url)!.length, 88) : sources.get(args.url)!);
      if (mode === "lost") throw new Error("fake lost save_url response after copy");
      return { ".tag": "complete" };
    }
    if (op === "files/save_url/check_job_status") return { ".tag": jobDone ? "complete" : "in_progress" };
    if (op === "files/get_metadata") {
      const hook = metadataHook; metadataHook = null; if (hook) await hook();
      const f = files.get(args.path); if (!f) return fail("path/not_found");
      return { ".tag": "file", id: f.id, rev: f.rev, content_hash: contentHash(f.bytes), size: f.bytes.length, path_display: args.path };
    }
    if (op === "files/move_v2") {
      if (moveFails) return fail("fake refused move");
      const f = files.get(args.from_path); if (!f) return fail("path/not_found");
      const actual = files.has(args.to_path) ? args.to_path.replace(/\.mp4$/, " (1).mp4") : args.to_path;
      files.set(actual, f); files.delete(args.from_path); return { metadata: { path_display: actual } };
    }
    if (op === "files/get_temporary_link") {
      if (linkReplacement) { put(args.path, WRONG); linkReplacement = false; }
      const f = files.get(args.path)!;
      return { link: `https://media.example.test/${encodeURIComponent(args.path)}`, metadata: { ".tag": "file", id: f.id, rev: f.rev, content_hash: contentHash(f.bytes), size: f.bytes.length, path_display: args.path } };
    }
    throw new Error(`Unexpected fake Dropbox operation: ${op}`);
  };
} }));
installNextStubs();
const fence = fenceFetch((url, init) => {
  if (url === "https://api.dropbox.com/oauth2/token") return new Response(JSON.stringify({ access_token: "isolated-access-token" }));
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return new Response(JSON.stringify({ root_info: { root_namespace_id: "isolated-namespace" } }));
  if (url === "https://api.dropboxapi.com/2/files/get_temporary_link") {
    const path = (JSON.parse(String(init?.body ?? "{}")) as { path: string }).path;
    const f = files.get(path)!;
    return new Response(JSON.stringify({ link: `https://media.example.test/${encodeURIComponent(path)}`, metadata: { ".tag": "file", id: f.id, rev: f.rev, content_hash: contentHash(f.bytes), size: f.bytes.length, path_display: path } }));
  }
  if (sources.has(url)) return new Response(Uint8Array.from(sources.get(url)!), { headers: { "content-type": "video/mp4" } });
  if (url.startsWith("https://media.example.test/")) { const path = decodeURIComponent(url.slice("https://media.example.test/".length)); return new Response(files.has(path) ? Uint8Array.from(files.get(path)!.bytes) : "missing", { status: files.has(path) ? 200 : 404, headers: { "content-type": "video/mp4", "accept-ranges": "bytes" } }); }
  return null;
});
async function main() {
  const port = Number(process.env.DRILL_PORT ?? 5969); if (!(await portFree(port))) throw new Error(`Reserved fixture port ${port} is not free; no process stopped.`);
  const db = await bootDrillDb({ port, engine: "postgres", env: { AUTH_ENFORCE: "true", APP_SECRET: "monthly-isolated-staff-secret", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_drillstore_isolated", DROPBOX_APP_KEY: "isolated-app-key", DROPBOX_APP_SECRET: "isolated-app-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("dropbox", "isolated-refresh-token");
    const { startDropboxCopy, checkDropboxCopy, streamUrlFor } = await import("@/lib/reviewCuts");
    const { monthlyFinalSnapshot, monthlyOwnerAccess } = await import("@/lib/monthlyFinal");
    const { manualFinalCheckReady, FINAL_CHECK_KEYS } = await import("@/lib/finalRendition");
    const { finalFileChoicesAction, recordFinalFileCheckAction, readFinalFileCheckReceiptAction } = await import("@/app/ops/finalRenditionActions");
    const { GET: finalPreview } = await import("@/app/api/review/cut/[id]/final/route");
    const { GET: reviewOriginal } = await import("@/app/api/review/cut/[id]/stream/route");
    const { markVideoSent, readyToSend } = await import("@/lib/readyToSend");
    const { mediaToken } = await import("@/lib/portalMedia");
    const { PROGRAM_ROLLOUT_SETTING_KEY, serializeProgramRollout, CLOSED_ROLLOUT } = await import("@/lib/programRolloutCore");
    const since = new Date(Date.now() - 60_000).toISOString();
    const { supersedePriorEnhanced } = await import("@/lib/topazJobs");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { NextRequest } = createRequire(__filename)("next/server") as typeof import("next/server");
    const kyle = await prisma.appUser.create({ data: { email: "kyle-monthly@example.test", name: "Kyle TEST", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "editor-monthly@example.test", name: "Editor TEST", role: "EDITOR", editorKey: "john", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { email: "owner-monthly@example.test", name: "Owner TEST", role: "OWNER", status: "ACTIVE" } });
    const client = await prisma.client.create({ data: { name: "Monthly Destination TEST" } });
    const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Starter", videosPerMonth: 6, sessionsPerMonth: 1, sessionHours: 1 } });
    const month = await prisma.contentMonth.create({ data: { enrollmentId: enrollment.id, clientId: client.id, monthKey: "2026-10", videosOwed: 6 } });
    const person = await prisma.clientUser.create({ data: { email: "monthly-owner@example.test", name: "Client TEST", status: "ACTIVE" } });
    const seat = await prisma.clientMembership.create({ data: { enrollmentId: enrollment.id, clientId: client.id, clientUserId: person.id, role: "OWNER" } });
    const project = await prisma.project.create({ data: { clientId: client.id, contentMonthId: month.id, title: "Monthly fixture", status: "REVIEW", dropboxFolder: "/isolated/monthly" } });
    const d = await prisma.deliverable.create({ data: { projectId: project.id, type: "VIDEO", quantity: 6 } });
    const makeCut = async (slot: number, round = 1) => {
      const url = `https://drillstore.public.blob.vercel-storage.com/slot-${slot}-v${round}.mp4`; sources.set(url, ORIGINAL);
      const cut = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: d.id, slot, round, fileName: `topic-${slot}-v${round}.mp4`, status: "APPROVED", blobUrl: url, sizeBytes: ORIGINAL.length, decidedAt: new Date(), clientReleasedAt: new Date() } });
      await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { assetUrl: streamUrlFor(cut.id) } });
      const output = await prisma.deliverableOutput.findFirst({ where: { projectId: project.id, deliverableId: d.id, slot } });
      if (output) await prisma.deliverableOutput.update({ where: { id: output.id }, data: { currentSubmissionId: cut.id, approvedSubmissionId: cut.id } });
      else await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: d.id, slot, category: "VIDEO", currentSubmissionId: cut.id, approvedSubmissionId: cut.id } });
      return cut;
    };
    const form = (id: string, choice: string, attemptId = randomUUID()) => { const f = new FormData(); f.set("submissionId", id); f.set("mediaId", choice); f.set("attemptId", attemptId); FINAL_CHECK_KEYS.forEach((key) => f.set(key, "yes")); return f; };
    await setSession({ uid: kyle.id, email: kyle.email, role: kyle.role });
    const prior = await makeCut(1, 1), original = await makeCut(1, 2), sibling = await makeCut(2);
    const oldPath = "/isolated/monthly/05-Final-Video/prior-v1.mp4", siblingPath = "/isolated/monthly/05-Final-Video/sibling-v1.mp4";
    put(oldPath, ORIGINAL); put(siblingPath, ORIGINAL);
    const oldAt = new Date("2026-09-20T12:00:00Z");
    await prisma.reviewSubmission.update({ where: { id: prior.id }, data: { status: "SUPERSEDED", finalPath: oldPath, completedAt: oldAt } });
    await prisma.reviewSubmission.update({ where: { id: sibling.id }, data: { finalPath: siblingPath, completedAt: oldAt } });
    moveFails = true;
    const copied = await startDropboxCopy(original.id, { inline: false });
    const old = await prisma.reviewSubmission.findUnique({ where: { id: prior.id } });
    c.ok("actual save_url core records exact original backup and hashed provenance", copied.complete && !!copied.finalPath && await prisma.auditLog.count({ where: { action: "cut_dropbox_backup", target: original.id } }) === 1);
    c.ok("failed prior move preserves historical real path and completion; sibling untouched", old?.finalPath === oldPath && old.completedAt?.getTime() === oldAt.getTime() && files.has(oldPath) && (await prisma.reviewSubmission.findUnique({ where: { id: sibling.id } }))?.finalPath === siblingPath);
    const read = await finalFileChoicesAction(original.id);
    c.ok("monthly final choice targets portal canonical preview with no Aryeo requirement", read.ok && read.choices.length === 1 && read.choices[0].url.includes("/final?f="));
    c.ok("unattested monthly delivery refused despite release, owner seat and copied path", !(await manualFinalCheckReady(original.id)).ok);
    const attemptId = randomUUID(), saved = await recordFinalFileCheckAction(form(original.id, read.choices[0].id, attemptId));
    const checked = await prisma.finalRenditionCheck.findUnique({ where: { id: `final-check:${attemptId}` } });
    c.ok("actual signed staff monthly attestation binds exact file/access and actor atomically", saved.ok && saved.outcome === "confirmed" && checked?.destination === "client-portal" && checked.checkedByUserId === kyle.id && await prisma.activity.count({ where: { projectId: project.id, body: { startsWith: "Final portal video checked" } } }) === 1);
    c.ok("exact attempt receipt reconciles response loss without another write", (await readFinalFileCheckReceiptAction(original.id, attemptId)).ok && (await recordFinalFileCheckAction(form(original.id, read.choices[0].id, attemptId))).ok && await prisma.finalRenditionCheck.count({ where: { submissionId: original.id } }) === 1);
    c.ok("monthly dispatcher accepts checked portal + final Dropbox without listing", (await manualFinalCheckReady(original.id)).ok);
    const board = await readyToSend({ projectId: project.id, recordFollowUpHealth: false, includeNoticeIncidents: false });
    c.ok("released portal row keeps handoff visible with exact access/check facts instead of seat inference", board.ready.some((r) => r.submissionId === original.id && r.monthlyPortalAccess && r.monthlyFinalCheckRecorded));
    const preview = await finalPreview(new NextRequest(`http://fixture.local${read.choices[0].url}`), { params: Promise.resolve({ id: original.id }) });
    c.ok("original final preview streams approved original, with private no-store and no delivery stamp", preview.status === 200 && await preview.text() === ORIGINAL.toString() && preview.headers.get("cache-control")?.includes("no-store") === true && !(await prisma.reviewSubmission.findUnique({ where: { id: original.id } }))?.sentToClientAt);
    const bad = await makeCut(3); mode = "wrong";
    const wrong = await startDropboxCopy(bad.id, { inline: false });
    c.ok("wrong existing file cannot satisfy conflict reconciliation or completion timestamp", !wrong.complete && !(await prisma.reviewSubmission.findUnique({ where: { id: bad.id } }))?.completedAt);
    const pending = await makeCut(4); mode = "pending";
    const pendingCopy = await startDropboxCopy(pending.id, { inline: false });
    c.ok("pending exact copy stays held and path alone does not certify completion", !pendingCopy.complete && await checkDropboxCopy(pending.id) === "pending" && !(await monthlyFinalSnapshot(pending.id)).ok);
    put(pendingCopy.finalPath!, ORIGINAL); jobDone = true;
    c.ok("exact completed async source job plus file metadata confirms pending backup", await checkDropboxCopy(pending.id) === "complete" && (await monthlyFinalSnapshot(pending.id)).ok);
    const lost = await makeCut(5); mode = "lost";
    let rejected = false; try { await startDropboxCopy(lost.id, { inline: false }); } catch { rejected = true; }
    mode = "complete"; const recovered = await startDropboxCopy(lost.id, { inline: false });
    c.ok("lost save_url response reconciles existing matching bytes without trusting path", rejected && recovered.complete && await prisma.auditLog.count({ where: { action: "cut_dropbox_backup", target: lost.id } }) === 1);
    await prisma.clientUser.update({ where: { id: person.id }, data: { status: "DISABLED" } });
    c.ok("disabled owner cannot settle monthly final-file access", !(await monthlyFinalSnapshot(original.id)).ok);
    await prisma.clientUser.update({ where: { id: person.id }, data: { status: "ACTIVE" } });
    const otherClient = await prisma.client.create({ data: { name: "Other program TEST" } });
    const otherEnrollment = await prisma.contentEnrollment.create({ data: { clientId: otherClient.id, status: "ACTIVE", package: "Other", videosPerMonth: 1, sessionsPerMonth: 1, sessionHours: 1 } });
    await prisma.clientMembership.update({ where: { id: seat.id }, data: { enrollmentId: otherEnrollment.id } });
    c.ok("a live owner seat pointing at another enrollment does not certify this month", !(await monthlyFinalSnapshot(original.id)).ok);
    await prisma.clientMembership.update({ where: { id: seat.id }, data: { enrollmentId: enrollment.id } });
    await prisma.client.update({ where: { id: client.id }, data: { name: "Normal client outside pilot" } });
    c.ok("real client outside stored TEST_ONLY rollout cannot certify access", !(await monthlyOwnerAccess([month.id])).get(month.id)?.ok);
    const pilotValue = serializeProgramRollout({ mode: "PILOT", modeSince: since, pilot: { clientIds: [client.id], operations: ["portal_sign_in", "portal_layout_v2"], approvedBy: "isolated-fixture", approvedAt: since, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), joinedAt: { [client.id]: since }, note: "Disposable monthly destination fixture" } });
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: pilotValue } });
    c.ok("normal named-pilot owner access certifies exact monthly program under existing rollout policy", (await monthlyFinalSnapshot(original.id)).ok && (await monthlyOwnerAccess([month.id])).get(month.id)?.ok === true);
    await prisma.appSetting.delete({ where: { key: PROGRAM_ROLLOUT_SETTING_KEY } });
    await prisma.client.update({ where: { id: client.id }, data: { name: "Monthly Destination TEST" } });
    const processedPath = "/isolated/monthly/05-Final-Video/topic-1-v2-1080p.mp4"; put(processedPath, PROCESSED);
    await prisma.topazJob.create({ data: { projectId: project.id, submissionId: original.id, fileName: original.fileName!, state: "done", finalPath: processedPath, savedAt: new Date(), outputCheck: "verified" } });
    c.ok("new processed rendition invalidates prior original attestation", !(await manualFinalCheckReady(original.id)).ok);
    const processed = await finalFileChoicesAction(original.id);
    const actualFinal = await finalPreview(new NextRequest(`http://fixture.local${processed.choices[0].url}`), { params: Promise.resolve({ id: original.id }) });
    const staffOriginal = await reviewOriginal(new NextRequest(`http://fixture.local/api/review/cut/${original.id}/stream`), { params: Promise.resolve({ id: original.id }) });
    const normalClient = await reviewOriginal(new NextRequest(`http://fixture.local/api/review/cut/${original.id}/stream?m=${encodeURIComponent(mediaToken(original.id, { kind: "membership", id: seat.id }))}`), { params: Promise.resolve({ id: original.id }) });
    const clientLocation = normalClient.headers.get("location");
    const normalClientBytes = clientLocation ? await fetch(clientLocation).then((r) => r.text()) : await normalClient.text();
    c.ok("normal live membership media proof receives same processed bytes as staff final preview", [200, 302].includes(normalClient.status) && normalClientBytes === PROCESSED.toString(), JSON.stringify({ status: normalClient.status, body: normalClientBytes }));
    c.ok("staff final check streams exact processed client bytes while Review Room retains original", actualFinal.status === 200 && await actualFinal.text() === PROCESSED.toString() && staffOriginal.status === 200 && await staffOriginal.text() === ORIGINAL.toString());
    linkReplacement = true;
    const mediaBeforeReplacement = fence.faked.filter((u) => u.startsWith("https://media.example.test/")).length;
    const replacementLink = await finalPreview(new NextRequest(`http://fixture.local${processed.choices[0].url}`), { params: Promise.resolve({ id: original.id }) });
    c.ok("provider replacement during temporary-link read refuses different client bytes", replacementLink.status === 409 && fence.faked.filter((u) => u.startsWith("https://media.example.test/")).length === mediaBeforeReplacement);
    put(processedPath, PROCESSED);
    const refreshedProcessed = await finalFileChoicesAction(original.id);
    c.ok("stale preview fingerprint cannot serve replacement final bytes", (await finalPreview(new NextRequest(`http://fixture.local${read.choices[0].url}`), { params: Promise.resolve({ id: original.id }) })).status === 409);
    const processedSaved = await recordFinalFileCheckAction(form(original.id, refreshedProcessed.choices[0].id));
    c.ok("exact processed final backup/check allows monthly handoff independently of client verdict", processedSaved.ok && (await manualFinalCheckReady(original.id)).ok && !(await prisma.reviewSubmission.findUnique({ where: { id: original.id } }))?.clientApprovedDecisionId);
    put(processedPath, WRONG);
    c.ok("changed Dropbox bytes/revision invalidate saved final check", !(await manualFinalCheckReady(original.id)).ok);
    put(processedPath, PROCESSED);
    const currentChoice = await finalFileChoicesAction(original.id);
    metadataHook = async () => { await makeCut(1, 3); };
    const stale = await recordFinalFileCheckAction(form(original.id, currentChoice.choices[0].id));
    c.ok("newer cut entered during provider read refuses old attestation without mutation", !stale.ok && stale.outcome === "refused" && await prisma.finalRenditionCheck.count({ where: { submissionId: original.id } }) === 2);
    const beforePrune = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: lost.id } });
    await prisma.reviewSubmission.update({ where: { id: lost.id }, data: { blobUrl: null, blobPathname: null, assetPath: beforePrune.finalPath } });
    c.ok("verified exact backup survives normal source retention without timestamp-only trust", (await monthlyFinalSnapshot(lost.id)).ok);
    const legacySource = "/isolated/legacy/source-original.mp4";
    put(legacySource, WRONG);
    await prisma.reviewSubmission.update({ where: { id: lost.id }, data: { assetPath: legacySource } });
    c.ok("changed canonical original cannot be certified by a different intact final backup", !(await monthlyFinalSnapshot(lost.id)).ok);
    put(legacySource, ORIGINAL);
    c.ok("distinct legacy source and backup with matching exact bytes remain verifiable", (await monthlyFinalSnapshot(lost.id)).ok);
    await prisma.reviewSubmission.update({ where: { id: lost.id }, data: { blobUrl: beforePrune.blobUrl, blobPathname: beforePrune.blobPathname, assetPath: beforePrune.assetPath } });
    const raceClaim = async (cutId: string, mutate: () => Promise<void>) => {
      const transaction = prisma.$transaction;
      let reach!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => { reach = r; }), gate = new Promise<void>((r) => { release = r; });
      prisma.$transaction = ((...args: unknown[]) => { reach(); return gate.then(() => Reflect.apply(transaction, prisma, args)); }) as typeof prisma.$transaction;
      const claim = markVideoSent(cutId, "Kyle isolated fixture");
      await reached; prisma.$transaction = transaction;
      try { await mutate(); } finally { release(); }
      return claim;
    };
    for (const target of [pending, lost]) {
      const choice = await finalFileChoicesAction(target.id);
      if (!choice.ok) throw new Error(choice.message);
      const checkedTarget = await recordFinalFileCheckAction(form(target.id, choice.choices[0].id));
      if (!checkedTarget.ok) throw new Error(checkedTarget.message);
    }
    const replacedClaim = await raceClaim(pending.id, async () => { const next = await makeCut(4, 2); await prisma.reviewSubmission.update({ where: { id: next.id }, data: { status: "PENDING" } }); });
    c.ok("real request captured proof before newer entered cut, then atomic first claim refuses stale send", !replacedClaim.ok && !(await prisma.reviewSubmission.findUnique({ where: { id: pending.id } }))?.sentToClientAt);
    const revokedClaim = await raceClaim(lost.id, async () => { await prisma.clientMembership.update({ where: { id: seat.id }, data: { revokedAt: new Date() } }); });
    c.ok("owner revocation after provider/read-only proof but before atomic claim prevents delivery stamp", !revokedClaim.ok && !(await prisma.reviewSubmission.findUnique({ where: { id: lost.id } }))?.sentToClientAt);
    await prisma.clientMembership.update({ where: { id: seat.id }, data: { revokedAt: null } });
    const delivered = await markVideoSent(lost.id, "Kyle isolated fixture");
    const portalHandoff = await prisma.auditLog.findUnique({ where: { id: `monthly-portal-handoff:${lost.id}` } });
    c.ok("first portal handoff stamp has durable matching atomic entitlement marker", !!(await prisma.reviewSubmission.findUnique({ where: { id: lost.id } }))?.sentToClientAt && portalHandoff?.action === "monthly_portal_handoff" && portalHandoff.target === lost.id && typeof JSON.parse(portalHandoff.detail).sourceFingerprint === "string" && !!JSON.parse(portalHandoff.detail).finalCheckId);
    c.ok("checked monthly handoff records portal channel without client send or approval", delivered.ok && !!(await prisma.reviewSubmission.findUnique({ where: { id: lost.id } }))?.sentToClientAt && (await prisma.deliverableOutput.findFirst({ where: { projectId: project.id, deliverableId: d.id, slot: 5 } }))?.deliveredVia === "client-portal");
    const enhancedPrior = "/isolated/monthly/05-Final-Video/prior-enhanced.mp4";
    put(enhancedPrior, PROCESSED); put("/isolated/monthly/05-Final-Video/superseded/prior-enhanced.mp4", WRONG);
    const oldEnhanced = await prisma.topazJob.create({ data: { projectId: project.id, submissionId: prior.id, fileName: prior.fileName!, state: "done", finalPath: enhancedPrior, savedAt: oldAt, outputCheck: "verified" } });
    moveFails = false;
    await supersedePriorEnhanced({ id: original.id, projectId: project.id, deliverableId: d.id, slot: 1, assetPath: null });
    const movedEnhanced = await prisma.topazJob.findUnique({ where: { id: oldEnhanced.id } });
    c.ok("enhanced collision records actual provider autorename path and preserves saved time", movedEnhanced?.finalPath === "/isolated/monthly/05-Final-Video/superseded/prior-enhanced (1).mp4" && movedEnhanced.savedAt?.getTime() === oldAt.getTime() && files.has(movedEnhanced.finalPath));
    await prisma.reviewSubmission.update({ where: { id: prior.id }, data: { completedAt: null, finalPath: null } });
    await startDropboxCopy(prior.id, { inline: false });
    c.ok("late old-original copy completion cannot move newer processed file", (await prisma.topazJob.findUnique({ where: { submissionId: original.id } }))?.finalPath === processedPath && files.has(processedPath));
    for (const [label, who, actingAs] of [["unassigned editor", editor, undefined], ["owner preview", owner, kyle.id]] as const) {
      await setSession({ uid: who.id, email: who.email, role: who.role, ...(actingAs ? { actingAs } : {}) });
      const before = calls.length;
      const denied = await finalPreview(new NextRequest(`http://fixture.local${processed.choices[0].url}`), { params: Promise.resolve({ id: original.id }) });
      c.ok(`${label} denied final-byte route before provider read`, denied.status === 403 && calls.length === before);
    }
    await clearSession();
    c.ok("unsigned access is denied before Dropbox/final-byte reads", (await finalPreview(new NextRequest(`http://fixture.local${processed.choices[0].url}`), { params: Promise.resolve({ id: original.id }) })).status === 403);
    const racedAck = await makeCut(6); mode = "complete"; replaceAfterAck = true;
    const falseAck = await startDropboxCopy(racedAck.id, { inline: false }); replaceAfterAck = false;
    c.ok("same-size replacement after save_url acknowledgment cannot create false source provenance", !falseAck.complete && !(await prisma.reviewSubmission.findUnique({ where: { id: racedAck.id } }))?.completedAt && await prisma.auditLog.count({ where: { action: "cut_dropbox_backup", target: racedAck.id } }) === 0);
    await setSession({ uid: kyle.id, email: kyle.email, role: kyle.role });
    await prisma.client.update({ where: { id: client.id }, data: { name: "Normal named-pilot client" } });
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: pilotValue } });
    const pilotCut = await makeCut(6, 2); mode = "complete";
    const pilotCopy = await startDropboxCopy(pilotCut.id, { inline: false });
    const pilotChoice = await finalFileChoicesAction(pilotCut.id);
    if (!pilotCopy.complete || !pilotChoice.ok) throw new Error("Normal named-pilot fixture final file was not ready");
    const pilotCheck = await recordFinalFileCheckAction(form(pilotCut.id, pilotChoice.choices[0].id));
    if (!pilotCheck.ok) throw new Error(pilotCheck.message);
    const withdrawn = await raceClaim(pilotCut.id, async () => { await prisma.appSetting.update({ where: { key: PROGRAM_ROLLOUT_SETTING_KEY }, data: { value: serializeProgramRollout(CLOSED_ROLLOUT) } }); });
    c.ok("named-pilot scope withdrawal after captured final proof prevents first delivery stamp", !withdrawn.ok && !(await prisma.reviewSubmission.findUnique({ where: { id: pilotCut.id } }))?.sentToClientAt);
    c.ok("new copy/proof logs keep private URLs, source body and client identity out", !(await prisma.auditLog.findMany({ where: { action: { in: ["cut_dropbox_backup", "cut_dropbox_copy_started"] } } })).some((r) => /blob.vercel|approved cut bytes|Monthly Destination/.test(r.detail)));
    c.ok("fixture escapes no provider/network fence and creates no client notice or decision", fence.blocked.length === 0 && await prisma.clientDecision.count() === 0 && await prisma.notificationDelivery.count() === 0);
    c.summary();
  } finally { await db.stop(); fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
