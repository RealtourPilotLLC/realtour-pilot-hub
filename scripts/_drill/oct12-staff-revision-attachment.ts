// ---------------------------------------------------------------------------
// DRILL: a staff revision request with an attachment (Oct 12 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct12-staff-revision-attachment.ts
//
// Kyle, Oct 7, 1033 Preserve Ln (Mike Ciunci), Video 2: "Turn this into a
// revision request" with Mike's notes and "Realtour Pilot Session 14 edits.docx"
// → "the original upload is not confirmed", the pickers blank, every Resume
// failing the same way. Production: the receipt (no task) named
// /RealTour Pilot/Hub/…, a Dropbox root the app may not write
// (path/no_write_permission) — no hub upload had EVER landed there.
//
//   §1 the store: the prefix is under /AutoHDR (writable); a legacy path maps
//      to the same file name there; anything else does not.
//   §2 Kyle's failure, reproduced: a refused write keeps the client's words,
//      says WHY in plain words, offers "finish without", creates no task.
//   §3 the saved request is readable: video, version, contact, words,
//      attachment and its state — by key, and with no key (another browser).
//   §4 resuming without the file asks for it (or finishing without), uploads
//      nothing; with the same .docx the legacy path is re-homed, uploaded,
//      confirmed, the task created, the file recorded under its real name.
//   §5 /api/file hands the .docx back under its real name, as a download.
//   §6 finish without the attachment: SKIPPED, said in the references, task
//      created, nothing uploaded; a replay changes nothing.
//   §7 discard: the receipt goes (no task, no issues), a job note keeps the
//      words; again is harmless; a recorded request cannot be discarded.
//   §8 a newer version uploaded after the request is flagged (John's V2).
//   §9 a PDF and an image upload as well; the form keeps what was typed (no
//      React form action) and its spinner is not a transition.
//
// ISOLATION: PGlite on 127.0.0.1 (the harness); Dropbox is a byte-preserving
// local fake that refuses writes outside /AutoHDR like the real team space.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch();

let refuseAll = false;
let uploads = 0;
const files = new Map<string, Buffer>();
const writable = (p: string) => p.startsWith("/AutoHDR/");
interceptModule((r) => r === "@/lib/integrations/dropbox" || /integrations[\\/]dropbox(\.ts)?$/.test(r), (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get(t, k) {
    const DropboxError = t.DropboxError as new (message: string, status: number) => Error;
    if (k === "dropboxUpload") return async (p: string, bytes: Uint8Array, opts: { autorename?: boolean; overwrite?: boolean }) => {
      uploads++;
      if (refuseAll || !writable(p)) throw new DropboxError(`Dropbox upload failed: {"error_summary": "path/no_write_permission/..", "error": {".tag": "path"}}`, 409);
      if (files.has(p) && !opts.overwrite) throw new DropboxError(`Dropbox upload failed: {"error_summary": "path/conflict/file/.."}`, 409);
      files.set(p, Buffer.from(bytes));
      return { pathDisplay: p };
    };
    if (k === "dropboxDownload") return async (p: string) => {
      const bytes = files.get(p);
      if (!bytes) throw new DropboxError("Dropbox download failed: path/not_found/", 409);
      return bytes;
    };
    return t[k];
  },
}));
interceptModule((r) => r === "@/lib/integrations/ai", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get: (t, k) => (k === "aiJson" ? async () => ({ headline: "Analysis", items: [], keep: [], references: [], questions: [] }) : t[k]),
}));

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const docxBytes = Buffer.alloc(13_769, 7);
const docx = () => new File([docxBytes], "Realtour Pilot Session 14 edits.docx", { type: DOCX });

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6042), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct12-staff-attachment-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { requestApprovedCutRevision, savedStaffRevision, finishStaffRevisionWithoutAttachment, discardStaffRevision } = await import("@/app/review/staffRevisionActions");
    const { staffReceiptIntake } = await import("@/lib/revisionBrief");
    const { STORAGE_PREFIX, LEGACY_STORAGE_PREFIX, rehomedLegacyPath } = await import("@/lib/storage");
    const { GET: fileRoute } = await import("@/app/api/file/route");
    const kyle = await prisma.appUser.create({ data: { name: "Kyle Smith", email: "kyle-oct12att@example.test", role: "ADMIN", status: "ACTIVE" } });
    await setSession({ uid: kyle.id, email: kyle.email, role: kyle.role });
    const f = await buildContentMonth(prisma as never, { name: "Oct12 Mike Ciunci TEST", package: "Starter", videosPerMonth: 2, owner: false, project: { status: "DELIVERED" } });
    const projectId = f.projectId!, deliverableId = f.deliverableId!;
    const v2 = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 2, round: 1, status: "APPROVED", source: "upload", fileName: "Mike Ciunci_Video2_V3.mov" } });
    await prisma.deliverableOutput.create({ data: { projectId, deliverableId, slot: 2, category: "SOCIAL_REEL", currentSubmissionId: v2.id, approvedSubmissionId: v2.id } });
    const msg = await prisma.projectMessage.create({ data: { projectId, authorName: "Kyle Smith", body: "Hey bro @John Mark, we have a revision from Mike for this one:\n\nNotes for Sign video\n-This one feels a bit too heavy and dramatic\n-Each clip is drawn out a little too long" } });
    // What the panel and the form send.
    const newRequest = (file: File | null) => {
      const d = new FormData();
      d.set("projectId", projectId); d.set("submissionId", v2.id); d.set("requestKey", crypto.randomUUID());
      d.set("clientContact", "Mike Ciunci"); d.set("timecode", ""); d.set("confirmedClientWords", "yes"); d.set("sourceMessageId", msg.id);
      if (file) d.set("attachment", file);
      return d;
    };
    const resume = (key: string, file: File | null) => {
      const d = new FormData();
      d.set("projectId", projectId); d.set("submissionId", v2.id); d.set("requestKey", key);
      if (file) d.set("attachment", file);
      return d;
    };
    const receipt = (key: string) => prisma.revisionBrief.findFirst({ where: { projectId, sourceDetail: { endsWith: `:${key}` } } });
    const stuck = async () => {
      refuseAll = true;
      const form = newRequest(docx());
      const r = await requestApprovedCutRevision(form);
      refuseAll = false;
      return { key: String(form.get("requestKey")), r };
    };

    c.head("§1 the store can be written");
    c.ok("hub storage lives under /AutoHDR (the tree the Dropbox app can write)", STORAGE_PREFIX === "/AutoHDR/Hub" && LEGACY_STORAGE_PREFIX === "/RealTour Pilot/Hub");
    c.ok("a legacy path maps to the same file name under today's prefix", rehomedLegacyPath(`/RealTour Pilot/Hub/projects/${projectId}/uploads/a.attachment`) === `/AutoHDR/Hub/projects/${projectId}/uploads/a.attachment`);
    c.ok("…and nothing else maps (other roots, traversal)", rehomedLegacyPath("/RealTour Pilot/Attachments/x.png") === null && rehomedLegacyPath("/RealTour Pilot/Hub/../Personal/x") === null && rehomedLegacyPath(`${STORAGE_PREFIX}/x`) === null);

    c.head("§2 Kyle's failure, reproduced");
    const A = await stuck();
    const a0 = await receipt(A.key);
    const att0 = staffReceiptIntake(a0?.itemsJson ?? null)?.attachment;
    c.ok("a refused upload is not confirmed and says why, in plain words", !A.r.ok && A.r.message.includes("not confirmed") && A.r.message.includes("Dropbox refused to save it in that folder") && A.r.message.includes("finish without the attachment"), A.r.message);
    c.ok("…no raw provider text reaches the person", !/error_summary|\{/.test(A.r.message));
    c.ok("…the client's words and contact are kept, no task yet", a0?.originalText === msg.body && a0.requestedBy === "Kyle Smith (on behalf of Mike Ciunci)" && a0.taskId === null && att0?.state === "UNKNOWN");
    // The production row (cmuyivxwh0009ii044nuyr6vq) names the old root.
    const legacyPath = `${LEGACY_STORAGE_PREFIX}${att0!.storedPath.slice(STORAGE_PREFIX.length)}`;
    const parsed = JSON.parse(a0!.itemsJson!); parsed.staffReceipt.intake.attachment.storedPath = legacyPath;
    await prisma.revisionBrief.update({ where: { id: a0!.id }, data: { itemsJson: JSON.stringify(parsed) } });

    c.head("§3 the saved request, as saved");
    const sA = await savedStaffRevision(projectId, A.key);
    c.ok("by this browser's key: video, version, contact, words, attachment", sA.found && !sA.recorded && sA.round === 1 && sA.fileName === "Mike Ciunci_Video2_V3.mov" && sA.contact === "Mike Ciunci" && sA.words === msg.body && sA.attachment?.name === "Realtour Pilot Session 14 edits.docx" && sA.attachment.state === "UNKNOWN" && sA.newerRound === null && !!sA.videoLabel, JSON.stringify(sA).slice(0, 300));
    const anyA = await savedStaffRevision(projectId, null);
    c.ok("with no key (another browser) the same stuck request is found, with its key", anyA.found && anyA.requestKey === A.key && anyA.submissionId === v2.id);
    c.ok("a malformed key reads nothing", !(await savedStaffRevision(projectId, "not-a-key")).found);

    c.head("§4 resume: ask for the file, then finish with it");
    const uploadsBefore = uploads;
    const noFile = await requestApprovedCutRevision(resume(A.key, null));
    c.ok("resuming without the file asks for the same file (or finishing without) and uploads nothing", !noFile.ok && noFile.message.includes("Realtour Pilot Session 14 edits.docx") && noFile.message.includes("finish without the attachment") && uploads === uploadsBefore, noFile.message);
    const wrongFile = await requestApprovedCutRevision(resume(A.key, new File([Buffer.alloc(13_769, 8)], "Realtour Pilot Session 14 edits.docx", { type: DOCX })));
    c.ok("a different file under the same name is refused before any upload", !wrongFile.ok && uploads === uploadsBefore);
    const done = await requestApprovedCutRevision(resume(A.key, docx()));
    const a1 = await receipt(A.key);
    const att1 = staffReceiptIntake(a1?.itemsJson ?? null)?.attachment;
    const expected = `${STORAGE_PREFIX}/projects/${projectId}/uploads/staff-${A.key}-${createHash("sha256").update(docxBytes).digest("hex")}.attachment`;
    c.ok("the same .docx finishes it: recorded for version 1", done.ok && /Recorded for version 1/.test(done.message), done.message);
    c.ok("…re-homed from the dead root and uploaded once, bytes intact", att1?.state === "CONFIRMED" && att1.storedPath === expected && uploads === uploadsBefore + 1 && files.get(expected)?.equals(docxBytes) === true);
    const task = a1?.taskId ? await prisma.smartTask.findUnique({ where: { id: a1.taskId } }) : null;
    const fileRow = await prisma.uploadedFile.findFirst({ where: { projectId, storedPath: expected } });
    c.ok("…the revision task exists and the file is recorded under its real name", task?.taskType === "revision" && fileRow?.originalName === "Realtour Pilot Session 14 edits.docx" && fileRow.mimeType === DOCX);
    c.ok("…the work order links the attachment", JSON.parse(a1!.itemsJson!).references.some((r: { what: string; where: string }) => r.what === "Realtour Pilot Session 14 edits.docx" && r.where === `/api/file?path=${encodeURIComponent(expected)}`));
    c.ok("…and the request now reads as recorded", (await savedStaffRevision(projectId, A.key)).found && (await savedStaffRevision(projectId, A.key) as { recorded: boolean }).recorded === true);

    c.head("§5 the file opens under its real name");
    const served = await fileRoute(new (await import("next/server")).NextRequest(`http://drill.local/api/file?path=${encodeURIComponent(expected)}`));
    const body = Buffer.from(await served.arrayBuffer());
    const disposition = served.headers.get("content-disposition") ?? "";
    c.ok("/api/file returns the .docx as a download named like the original", served.status === 200 && body.equals(docxBytes) && disposition.startsWith("attachment;") && disposition.includes("filename*=UTF-8''Realtour%20Pilot%20Session%2014%20edits.docx"), `${served.status} ${disposition}`);

    c.head("§6 finish without the attachment");
    const B = await stuck();
    const uploadsB = uploads;
    const skipped = await finishStaffRevisionWithoutAttachment(projectId, B.key);
    const b1 = await receipt(B.key);
    const attB = staffReceiptIntake(b1?.itemsJson ?? null)?.attachment;
    c.ok("it records, and says the attachment was left off", skipped.ok && skipped.message.includes("the attachment was left off"), skipped.message);
    c.ok("…SKIPPED by Kyle, identity kept, nothing uploaded", attB?.state === "SKIPPED" && attB.skippedBy === "Kyle Smith" && attB.originalName === "Realtour Pilot Session 14 edits.docx" && uploads === uploadsB && !(await prisma.uploadedFile.findFirst({ where: { storedPath: attB.storedPath } })));
    c.ok("…the work order says the file is not attached and who to ask", JSON.parse(b1!.itemsJson!).references.some((r: { what: string }) => r.what === "Realtour Pilot Session 14 edits.docx, not attached (ask Kyle Smith for it)"));
    c.ok("…the task handoff happened", !!b1?.taskId);
    const replay = await finishStaffRevisionWithoutAttachment(projectId, B.key);
    c.ok("a replay changes nothing (one reference, same task)", replay.ok && (await receipt(B.key))?.taskId === b1?.taskId && JSON.parse((await receipt(B.key))!.itemsJson!).references.filter((r: { what: string }) => r.what.includes("not attached")).length === 1);
    c.ok("finishing a request that was never saved is a plain refusal", !(await finishStaffRevisionWithoutAttachment(projectId, crypto.randomUUID())).ok);

    c.head("§7 discard");
    const C = await stuck();
    const cRow = await receipt(C.key);
    const notesBefore = await prisma.activity.count({ where: { projectId, type: "NOTE" } });
    const gone = await discardStaffRevision(projectId, C.key);
    const note = await prisma.activity.findFirst({ where: { projectId, type: "NOTE" }, orderBy: { createdAt: "desc" } });
    c.ok("a stuck request is discarded: the receipt goes, no task, no issue", gone.ok && /Discarded/.test(gone.message) && !(await receipt(C.key)) && await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${cRow!.id}:` } } }) === 0);
    c.ok("…a job note keeps who discarded what, with the words", await prisma.activity.count({ where: { projectId, type: "NOTE" } }) === notesBefore + 1 && /Kyle Smith discarded an unfinished revision request/.test(note?.body ?? "") && (note?.body ?? "").includes("Notes for Sign video"));
    c.ok("…it no longer reads as saved", !(await savedStaffRevision(projectId, C.key)).found);
    c.ok("discarding again is harmless", (await discardStaffRevision(projectId, C.key)).ok);
    const refusedDiscard = await discardStaffRevision(projectId, A.key);
    c.ok("a recorded request cannot be discarded (its task stays)", !refusedDiscard.ok && /already recorded/.test(refusedDiscard.message) && !!(await receipt(A.key))?.taskId);

    c.head("§8 a newer version since the request");
    const D = await stuck();
    await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot: 2, round: 2, status: "PENDING", source: "upload", fileName: "Done_Rev_1033 Preserve Ln (Mike Ciunci)_Video2.mov" } });
    const sD = await savedStaffRevision(projectId, D.key);
    c.ok("the saved request flags Version 2 uploaded after it", sD.found && sD.newerRound === 2);
    c.ok("…and it can be discarded in favour of that version", (await discardStaffRevision(projectId, D.key)).ok && !(await receipt(D.key)));

    c.head("§9 other files, and the form");
    await prisma.reviewSubmission.updateMany({ where: { projectId, slot: 2, round: 2 }, data: { status: "APPROVED" } });
    const v2b = await prisma.reviewSubmission.findFirst({ where: { projectId, slot: 2, round: 2 } });
    await prisma.deliverableOutput.updateMany({ where: { projectId, slot: 2 }, data: { currentSubmissionId: v2b!.id, approvedSubmissionId: v2b!.id } });
    for (const [name, type] of [["notes.pdf", "application/pdf"], ["frame.png", "image/png"]] as const) {
      const form = newRequest(new File([Buffer.alloc(2048, name.length)], name, { type }));
      form.set("submissionId", v2b!.id);
      const r = await requestApprovedCutRevision(form);
      const state = staffReceiptIntake((await receipt(String(form.get("requestKey"))))?.itemsJson ?? null)?.attachment?.state;
      c.ok(`a ${name.split(".")[1].toUpperCase()} attachment uploads and records`, r.ok && state === "CONFIRMED", r.message);
    }
    // (The form's own source checks went with components/review/StaffCutRevisionForm
    // on Oct 20 2026, audit H13: the Review Room has had no revision form since
    // Oct 14, "Reopen for revisions" replaced it.)
    c.ok("no provider request escaped the fence", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    console.log(await drill.evidence());
    c.summary();
    quiet.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
