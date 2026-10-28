// ---------------------------------------------------------------------------
// DRILL: EDIT AND DELETE REVIEW ROOM NOTES (Oct 28 2026).
//
// Jordan: "we need to be able to delete revision notes in the review room and
// also edit them."
//
//   0  The pure rules (lib/noteEditCore): who may change a note, the editor's
//      one line, the edit card's bullet and count, the Undo window.
//   1  Before the send-back: an edit changes the words (and its fix item), a
//      delete takes it away with Undo (same id back), and Request changes
//      bundles exactly what is left, in the current words. Nobody is belled.
//   2  After the send-back: the edit card's bullet is rewritten and its count
//      moves; the editor is belled one plain line; the timeline says who and
//      when; the editor's fix list carries the change. A note the editor
//      already marked fixed: an edit opens it again (not a miss), a delete
//      takes it off as not needed. Undo puts the note, the bullet, the count
//      and the item back, and tells the editor.
//   3  Permissions: the author, the owner, the office and the creative
//      manager; an editor or photographer only on their own; "view as" and a
//      signed-out request write nothing; Undo for the deleter or the desk,
//      for 24 hours.
//   4  A client's notes: their words are never rewritten. Held back before
//      the 15-minute send (the sweep passes it over), reworded before it
//      (the editor gets our words with theirs beside it), reworded or taken
//      off the list after it, each with Undo, the editor told.
//   5  The screens: Edit / Delete / Undo wired, 44px targets, no dashes.
//
// ISOLATION: PGlite via the shared harness on DRILL_PORT (default 5645); every
// outbound call fenced (Slack answered with a fake ok, nothing else leaves).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5645);
const REPO = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

// ---- the login, stubbed at the one seam every guard reads -------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) =>
    new Proxy(loaded as Record<string | symbol, unknown>, {
      get(t, k) {
        if (k === "getCurrentUser") return async () => viewer;
        return t[k];
      },
    }),
);
installNextStubs();
const fence = fenceFetch((url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true, channel: "D1", ts: "1.1" }), { headers: { "content-type": "application/json" } }) : null));

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct28-note-edit" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { putSetting } = await import("@/lib/settings");
  const rr = await import("@/app/review/actions");
  const na = await import("@/app/review/noteEditActions");
  const ne = await import("@/lib/noteEdits");
  const core = await import("@/lib/noteEditCore");
  const { issuesForProject } = await import("@/lib/revisionIssues");
  const { getEditorFeedback } = await import("@/lib/reviewRoom");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { PREVIEW_REFUSED } = await import("@/lib/reviewAttribution");
  const un = await import("@/lib/unsentNotes");
  const DASH = /[—–]/;

  try {
    // ---- the cast ------------------------------------------------------------
    type TeamRole = "ADMIN" | "MANAGER" | "SALES" | "PHOTOGRAPHER" | "EDITOR" | "VA";
    const member = (name: string, email: string, role: TeamRole) =>
      prisma.teamMember.create({ data: { name, email, role, active: true }, select: { id: true, name: true } });
    const jordan = await member("Jordan Spackman", "jordan@notes.invalid", "PHOTOGRAPHER");
    const kyle = await member("Kyle Cabrera", "kyle@notes.invalid", "MANAGER");
    const james = await member("James Livingston", "james@notes.invalid", "PHOTOGRAPHER");
    const harrison = await member("Harrison Wells", "harrison@notes.invalid", "PHOTOGRAPHER");
    const kim = await member("Kim", "kim@notes.invalid", "EDITOR");
    const login = (email: string, name: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
    const uJordan = await login("jordan@notes.invalid", "Jordan Spackman", "OWNER", jordan.id);
    const uKyle = await login("kyle@notes.invalid", "Kyle Cabrera", "ADMIN", kyle.id);
    const uJames = await login("james@notes.invalid", "James Livingston", "CREATIVE_MANAGER", james.id);
    const uHarrison = await login("harrison@notes.invalid", "Harrison Wells", "PHOTOGRAPHER", harrison.id);
    const uKim = await login("kim@notes.invalid", "Kim", "EDITOR", kim.id, { editorKey: "kim" });
    const as = (id: string, email: string, name: string, role: string, tm: string, over: Partial<Viewer> = {}): Viewer => ({
      id, email, name, role, permissions: null, status: "ACTIVE", teamMemberId: tm, editorKey: role === "EDITOR" ? "kim" : null,
      notificationsSeenAt: null, impersonating: false, realRole: role, realName: name, ...over,
    });
    const V = {
      jordan: as(uJordan.id, "jordan@notes.invalid", "Jordan Spackman", "OWNER", jordan.id),
      kyle: as(uKyle.id, "kyle@notes.invalid", "Kyle Cabrera", "ADMIN", kyle.id),
      james: as(uJames.id, "james@notes.invalid", "James Livingston", "CREATIVE_MANAGER", james.id),
      harrison: as(uHarrison.id, "harrison@notes.invalid", "Harrison Wells", "PHOTOGRAPHER", harrison.id),
      kim: as(uKim.id, "kim@notes.invalid", "Kim", "EDITOR", kim.id),
      // Jordan previewing Kim: effective = Kim, real = OWNER.
      preview: as(uKim.id, "kim@notes.invalid", "Kim", "EDITOR", kim.id, { impersonating: true, realRole: "OWNER", realName: "Jordan Spackman" }),
    };
    await putSetting("editor_routing", { standardVideo: "kim", premiumVideo: "kim", personalBranding: "kim" });
    await putSetting("review_room", {
      discoverFromDropbox: false, keepUploadsDays: 90,
      creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id,
      coverOfferHours: 9, coverTransferHours: null,
    });

    // ---- a listing job and its cuts ------------------------------------------
    const client = await prisma.client.create({ data: { name: "Gary Mercer" }, select: { id: true } });
    const mkJob = async (street: string) => {
      const p = await prisma.project.create({
        data: { title: `${street}, Royersford, PA`, clientId: client.id, status: "REVIEW", addressLine: street, photographerId: harrison.id },
        select: { id: true },
      });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
      return { id: p.id, deliverableId: d.id, street };
    };
    let seq = 0;
    const mkCut = async (job: { id: string; deliverableId: string | null }, round: number) => {
      seq++;
      const row = await prisma.reviewSubmission.create({
        data: { projectId: job.id, deliverableId: job.deliverableId, slot: 1, round, kind: "video", source: "upload", status: "PENDING", fileName: `cut-${seq}.mp4`, submittedByKey: "kim", submittedByName: "Kim", createdAt: new Date(Date.now() + seq) },
        select: { id: true },
      });
      await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
      return row.id;
    };
    const card = (projectId: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${projectId}` } });
    const issueOfNote = (noteId: string) => prisma.revisionIssue.findUnique({ where: { sourceKind_sourceId: { sourceKind: "REVIEW_NOTE", sourceId: noteId } } });
    // Kim's bells about a changed note. Her row keeps only its title (lib/notify
    // drops a creative's body; her Slack/text sends the title), so the title is
    // the line she is told.
    const kimBells = (where: Record<string, unknown> = {}) => prisma.notification.findMany({ where: { userKey: "editor:kim", dedupeKey: { startsWith: "review-note-" }, ...where }, orderBy: { createdAt: "asc" } });
    const lastKimTitle = async () => (await kimBells()).at(-1)?.title ?? "";
    const changes = () => prisma.noteChange.count();
    const changerAs = async (v: Viewer | null) => { viewer = v; return ne.noteChangerForViewer(); };

    // =========================================================================
    c.head("0 · the pure rules");
    // =========================================================================
    {
      const who = (realRole: string, authorKeys: string[] = [], over: Partial<import("@/lib/noteEditCore").NoteChanger> = {}) => ({ realRole, impersonating: false, userId: "u-me", authorKeys, ...over });
      const theirs = { authorKey: "tm:someone", authorUserId: "u-them" };
      c.ok("the owner, the office and the creative manager may change anyone's note", ["OWNER", "ADMIN", "CREATIVE_MANAGER"].every((r) => core.mayChangeNote(who(r), theirs)));
      c.ok("an editor or a photographer may not change someone else's", !core.mayChangeNote(who("EDITOR", ["editor:kim"]), theirs) && !core.mayChangeNote(who("PHOTOGRAPHER", ["tm:h"]), theirs));
      c.ok("…but may change their own, by the key it was written under or by their login", core.mayChangeNote(who("EDITOR", ["editor:kim"]), { authorKey: "editor:kim", authorUserId: null }) && core.mayChangeNote(who("PHOTOGRAPHER"), { authorKey: null, authorUserId: "u-me" }));
      c.ok("\"view as\" changes nothing, even for the owner", !core.mayChangeNote(who("OWNER", [], { impersonating: true }), theirs) && !core.mayChangeNote(null, theirs));
      c.ok("a client's note: only the owner, the office and the creative manager", core.mayCorrectClientNote(who("ADMIN")) && core.mayCorrectClientNote(who("CREATIVE_MANAGER")) && !core.mayCorrectClientNote(who("EDITOR")) && !core.mayCorrectClientNote(who("PHOTOGRAPHER")) && !core.mayCorrectClientNote(who("OWNER", [], { impersonating: true })));
      const desc = "Round 2 — sent back\n• [0:12] Music is too loud under the voice\n• [0:12] Music is too loud — James Livingston";
      c.ok("the card's bullet: the whole bullet only, never the start of a longer note, its author kept",
        core.replaceCardBullet(desc, "• [0:12] Music is too loud", "• [0:12] Softer music") === "Round 2 — sent back\n• [0:12] Music is too loud under the voice\n• [0:12] Softer music — James Livingston");
      c.ok("…and nothing when the bullet is not on the card", core.replaceCardBullet("• [0:12] Music is too loud under the voice", "• [0:12] Music is too loud", "x") === null);
      c.ok("the count moves and says note/notes right", core.bumpRoundCount("Round 2 — 3 notes to fix (sent back)", -1) === "Round 2 — 2 notes to fix (sent back)" && core.bumpRoundCount("Round 2 — 2 notes to fix (x)", -1) === "Round 2 — 1 note to fix (x)" && core.bumpRoundCount("Round 2 — 1 note to fix (x)", 1) === "Round 2 — 2 notes to fix (x)");
      const lines = (["EDITED", "DELETED", "RESTORED", "REWORDED", "REMOVED"] as const).map((action) => core.editorChangeLine({ action, by: "Kyle Cabrera", timeSec: 14, before: "Old words", after: "New words", wasFixed: true }));
      c.ok("the editor's line: first name, the time in the video, plain words, no dashes", lines.every((l) => l.startsWith("Kyle ") && !/Cabrera/.test(l) && !DASH.test(l)), lines.join(" | "));
      c.ok("…an edit of a fixed note says it is open again; a delete says nothing to do", /You had marked it fixed, so it is open again\./.test(lines[0]) && /Nothing to do for it, and your fix can stay\./.test(lines[1]));
      const t0 = new Date("2026-10-28T12:00:00Z");
      c.ok("Undo is open for 24 hours", core.undoOpen(t0, new Date(t0.getTime() + 23 * 3_600_000)) && !core.undoOpen(t0, new Date(t0.getTime() + 25 * 3_600_000)) && core.NOTE_UNDO_HOURS === 24);
      const titles = (["EDITED", "DELETED", "RESTORED", "REWORDED", "REMOVED", "REWORD_UNDONE", "REMOVE_UNDONE"] as const).map((action) => core.editorBellTitle({ action, by: "Kyle Cabrera", timeSec: 14 }, "1234 Very Long Street Name Boulevard Extension Northwest"));
      c.ok("the editor's bell title is the line: 90 characters at most, no dashes", titles.every((t) => t.length <= 90 && t.startsWith("Kyle ") && !DASH.test(t)), titles.join(" | "));
      c.ok("…a long street gives way before the words do", core.editorBellTitle({ action: "DELETED", by: "Kyle", timeSec: 14 }, "x".repeat(80)) === "Kyle deleted the note at 0:14: nothing to do");
      c.ok("a client's note reworded keeps their words beside ours", core.correctedClientLine("Raise the contrast", "make it pop", "Kyle Cabrera") === 'Raise the contrast (worded by Kyle. The client wrote: "make it pop")');
    }

    // =========================================================================
    c.head("1 · before the send-back: edit, delete, Undo, and what the editor gets");
    // =========================================================================
    const A = await mkJob("20 Note Edit Rd");
    const cutA = await mkCut(A, 1);
    viewer = V.james;
    const n1 = await rr.addCutNote({ projectId: A.id, submissionId: cutA, body: "Logo is soft at the end", lane: "EDITOR", kind: "fix", timeSec: 41 });
    viewer = V.kyle;
    const n2 = await rr.addCutNote({ projectId: A.id, submissionId: cutA, body: "Music is too loud", lane: "EDITOR", kind: "fix", timeSec: 12 });
    const n3 = await rr.addCutNote({ projectId: A.id, submissionId: cutA, body: "Trim the drone shot", lane: "EDITOR", kind: "fix", timeSec: 20 });
    const N1 = n1.noteId!, N2 = n2.noteId!, N3 = n3.noteId!;
    c.ok("three notes on version 1 (James's and two of Kyle's)", n1.ok && n2.ok && n3.ok && !!N1 && !!N2 && !!N3, [n1.message, n2.message, n3.message].join(" | "));
    {
      const e = await na.editCutNote(N2, "Music is too loud under the voice");
      const row = await prisma.mediaNote.findUnique({ where: { id: N2 } });
      c.ok("Kyle edits his note: the words change, nothing else", e.ok && e.message === "Saved." && row?.body === "Music is too loud under the voice" && row.status === "OPEN", e.message);
      const ch = await prisma.noteChange.findFirst({ where: { noteId: N2, action: "EDITED" } });
      c.ok("…the earlier words are kept for staff (\"edited\"), marked as before the send", ch?.beforeBody === "Music is too loud" && ch.afterBody === "Music is too loud under the voice" && ch.afterSend === false && ch.actorName === "Kyle Cabrera");
      const i2 = await issueOfNote(N2);
      c.ok("…its fix item reads the new words", !!i2 && i2.originalText === "Music is too loud under the voice", i2?.originalText ?? "no issue");
      const history = (await ne.noteEditsFor([N2])).get(N2) ?? [];
      c.ok("…the panel's history has the earlier version", history.length === 1 && history[0].before === "Music is too loud" && history[0].by === "Kyle Cabrera");

      const d = await na.deleteCutNote(N3);
      c.ok("Kyle deletes a note before the send: gone, plain \"Deleted.\"", d.ok && d.message === "Deleted." && !(await prisma.mediaNote.findUnique({ where: { id: N3 } })), d.message);
      const i3 = await issueOfNote(N3);
      c.ok("…its fix item is not needed (never counted against anyone)", i3?.state === "NOT_APPLICABLE" && !!(await prisma.revisionIssueEvent.findFirst({ where: { issueId: i3.id, kind: "NOTE_DELETED", note: { contains: "not counted against anyone" } } })), i3?.state);
      c.ok("…the timeline says who deleted it, where, and what it said", !!(await prisma.activity.findFirst({ where: { projectId: A.id, body: { startsWith: 'Kyle Cabrera deleted a Review Room note at 0:20 on version 1: "Trim the drone shot"' } } })));
      const kyleChanger = await changerAs(V.kyle);
      const listed = await ne.deletedNotesOn(cutA, kyleChanger, uKyle.id);
      c.ok("…the panel lists it under Deleted with Undo for Kyle", listed.length === 1 && listed[0].body === "Trim the drone shot" && listed[0].canUndo && listed[0].timeSec === 20 && !listed[0].afterSend, JSON.stringify(listed));
      const kimChanger = await changerAs(V.kim);
      c.ok("…and without Undo for Kim (not hers, not the desk)", (await ne.deletedNotesOn(cutA, kimChanger, uKim.id))[0]?.canUndo === false);
      viewer = V.kyle;
      const u = await na.undoCutNoteDelete(d.changeId!);
      const back = await prisma.mediaNote.findUnique({ where: { id: N3 } });
      c.ok("Undo puts it back: the same note, its author and its time", u.ok && u.message === "Put back." && back?.body === "Trim the drone shot" && back.authorName === "Kyle Cabrera" && back.timeSec === 20 && back.authorUserId === uKyle.id, u.message);
      c.ok("…its fix item is open again", (await issueOfNote(N3))?.state === "OPEN");
      c.ok("…it leaves the Deleted list, and a second Undo is harmless", (await ne.deletedNotesOn(cutA, kyleChanger, uKyle.id)).length === 0 && (await na.undoCutNoteDelete(d.changeId!)).message === "It is already back.");
      c.ok("…and the timeline says it was put back", !!(await prisma.activity.findFirst({ where: { projectId: A.id, body: { startsWith: "Kyle Cabrera put back the Review Room note at 0:20 that Kyle Cabrera deleted" } } })));

      const d1 = await na.deleteCutNote(N1);
      c.ok("the office may delete James's note too", d1.ok && !(await prisma.mediaNote.findUnique({ where: { id: N1 } })), d1.message);
      c.ok("nothing reached Kim's bell before the send-back", (await kimBells()).length === 0);

      const sent = await rr.requestCutChanges(cutA);
      const k = await card(A.id);
      c.ok("Request changes sends exactly what is left, in the current words", sent.ok && !!k && /^• \[0:12\] Music is too loud under the voice$/m.test(k.description ?? "") && /^• \[0:20\] Trim the drone shot$/m.test(k.description ?? "") && !/Logo is soft/.test(k.description ?? ""), `${sent.message} · ${k?.description?.replace(/\n/g, " | ")}`);
      c.ok("…and counts two notes", /^Round 2 — 2 notes to fix/.test(k?.summary ?? ""), k?.summary ?? "");
    }

    // =========================================================================
    c.head("2 · after the send-back: the editor's card, bell, list and timeline");
    // =========================================================================
    {
      viewer = V.kyle;
      const decorated = await ne.decorateCutNotes(await getEditorFeedback(A.id, null), await ne.noteChangerForViewer());
      const d3 = decorated.find((n) => n.id === N3);
      c.ok("the panel knows the editor has it (the delete asks first) and names Kim", d3?.sent === true && d3.canChange === true && d3.editorName === "Kim", JSON.stringify({ sent: d3?.sent, can: d3?.canChange, ed: d3?.editorName }));

      const e = await na.editCutNote(N3, "Trim the drone shot to two seconds");
      c.ok("Kyle edits a sent note: saved, and says Kim was told", e.ok && e.message === "Saved. Kim has been told what changed.", e.message);
      const k = await card(A.id);
      c.ok("the card's bullet is rewritten with who and when", /^• \[0:20\] Trim the drone shot to two seconds \(changed by Kyle, [^)]+\)$/m.test(k?.description ?? "") && !/^• \[0:20\] Trim the drone shot$/m.test(k?.description ?? ""), k?.description?.replace(/\n/g, " | "));
      c.ok("…the count is unchanged", /^Round 2 — 2 notes to fix/.test(k?.summary ?? ""));
      const bells = await kimBells();
      const b = bells[bells.length - 1];
      c.ok("Kim's bell: one plain line, linked to the cut", bells.length === 1 && b.title === "Kyle changed the note at 0:20 on 20 Note Edit Rd" && b.href === `/edit/${A.id}?cut=${cutA}` && b.kind === "review_changes", JSON.stringify({ t: b?.title, href: b?.href }));
      c.ok("…with no dashes", !DASH.test(b?.title ?? ""));
      c.ok("the timeline has the before and after", !!(await prisma.activity.findFirst({ where: { projectId: A.id, body: { contains: 'changed a Review Room note at 0:20 after it went to the editor (version 1). It said: "Trim the drone shot". It now says: "Trim the drone shot to two seconds".' } } })));
      const issues = await issuesForProject(A.id, { scrub: true, viewer: { editorKey: "kim" } });
      const i3 = issues.find((i) => i.text === "Trim the drone shot to two seconds");
      c.ok("Kim's fix list (as the editor sees it) has the new words and what changed", i3?.noteChange?.kind === "EDITED" && i3.noteChange.before === "Trim the drone shot" && i3.noteChange.after === "Trim the drone shot to two seconds" && i3.noteChange.by === "Kyle Cabrera", JSON.stringify(i3?.noteChange));

      // The editor marks it fixed, then the words change: open again, not a miss.
      viewer = V.kim;
      const fixed = await rr.setCutNoteStatus(N3, "FIXED");
      c.ok("Kim marks it fixed", fixed.ok && (await issueOfNote(N3))?.state === "ADDRESSED", fixed.message);
      viewer = V.kyle;
      const e2 = await na.editCutNote(N3, "Trim the drone shot to two seconds and keep the pull back");
      const row = await prisma.mediaNote.findUnique({ where: { id: N3 } });
      const iss = await issueOfNote(N3);
      c.ok("an edit after she marked it fixed opens it again for her", e2.ok && /it is open again for them/.test(e2.message) && row?.status === "OPEN" && iss?.state === "OPEN", `${e2.message} · ${row?.status} · ${iss?.state}`);
      c.ok("…recorded as reopened by the edit, not a miss", !!(await prisma.revisionIssueEvent.findFirst({ where: { issueId: iss!.id, kind: "REOPENED_BY_EDIT", note: { contains: "not a miss" } } })));
      c.ok("…and her bell says so", (await lastKimTitle()) === "Kyle changed the note at 0:20 on 20 Note Edit Rd, open again", await lastKimTitle());
      const k2 = await card(A.id);
      c.ok("…the card carries one bullet for it, the newest words", (k2?.description?.match(/^• \[0:20\]/gm) ?? []).length === 1 && /^• \[0:20\] Trim the drone shot to two seconds and keep the pull back \(changed by Kyle/m.test(k2?.description ?? ""), k2?.description?.replace(/\n/g, " | "));

      // The creative manager deletes Kyle's sent note; the office puts it back.
      viewer = V.james;
      const d = await na.deleteCutNote(N2);
      c.ok("James (creative manager) deletes Kyle's sent note: Kim is told it is no longer needed", d.ok && d.message === "Deleted. Kim has been told it is no longer needed.", d.message);
      const k3 = await card(A.id);
      c.ok("the card marks the bullet deleted, with who and when", /^• \[0:12\] \(deleted by James, [^)]+, nothing to do\) Music is too loud under the voice$/m.test(k3?.description ?? ""), k3?.description?.replace(/\n/g, " | "));
      c.ok("…and counts one note", /^Round 2 — 1 note to fix/.test(k3?.summary ?? ""), k3?.summary ?? "");
      c.ok("Kim's bell says which and that there is nothing to do", (await lastKimTitle()) === "James deleted the note at 0:12 on 20 Note Edit Rd: nothing to do", await lastKimTitle());
      const i2 = await issueOfNote(N2);
      c.ok("its fix item is not needed, and Kim's list says it was deleted", i2?.state === "NOT_APPLICABLE" && (await issuesForProject(A.id, { scrub: true, viewer: { editorKey: "kim" } })).find((i) => i.id === i2.id)?.noteChange?.kind === "DELETED");
      c.ok("the timeline names James and says it had gone to the editor", !!(await prisma.activity.findFirst({ where: { projectId: A.id, body: { startsWith: "James Livingston deleted a Review Room note at 0:12 on version 1 after it went to the editor" } } })));
      viewer = V.kyle;
      const u = await na.undoCutNoteDelete(d.changeId!);
      const k4 = await card(A.id);
      c.ok("Kyle (the office) can undo James's delete: the note is back with its id", u.ok && u.message === "Put back, and the editor has been told." && (await prisma.mediaNote.findUnique({ where: { id: N2 } }))?.body === "Music is too loud under the voice", u.message);
      c.ok("…the card's bullet and count are back", /^• \[0:12\] Music is too loud under the voice$/m.test(k4?.description ?? "") && !/deleted by James/.test(k4?.description ?? "") && /^Round 2 — 2 notes to fix/.test(k4?.summary ?? ""), `${k4?.summary} · ${k4?.description?.replace(/\n/g, " | ")}`);
      c.ok("…its fix item is open, the list's \"deleted\" line gone", (await issueOfNote(N2))?.state === "OPEN" && (await issuesForProject(A.id, { scrub: true, viewer: { editorKey: "kim" } })).find((i) => i.id === i2!.id)?.noteChange === null);
      c.ok("…and Kim is told it is back", (await lastKimTitle()) === "Kyle put back the note at 0:12 on 20 Note Edit Rd", await lastKimTitle());

      // A note she already fixed, deleted: off her list, her fix can stay.
      viewer = V.kim;
      await rr.setCutNoteStatus(N2, "FIXED");
      viewer = V.kyle;
      const dz = await na.deleteCutNote(N2);
      const iz = await issueOfNote(N2);
      c.ok("deleting a note she marked fixed: not needed, never counted against her", dz.ok && iz?.state === "NOT_APPLICABLE" && !!(await prisma.revisionIssueEvent.findFirst({ where: { issueId: iz.id, kind: "NOTE_DELETED", note: { contains: "after the editor marked it fixed; not counted against anyone" } } })), iz?.state);
      c.ok("…and her bell says there is nothing to do", (await lastKimTitle()) === "Kyle deleted the note at 0:12 on 20 Note Edit Rd: nothing to do", await lastKimTitle());
    }

    // =========================================================================
    c.head("3 · who may, and who may not");
    // =========================================================================
    {
      viewer = V.kim;
      const before = await changes();
      const e = await na.editCutNote(N3, "Kim rewrote the office's note");
      const d = await na.deleteCutNote(N3);
      c.ok("Kim (editor) can't edit or delete the office's note", !e.ok && !d.ok && /Only the person who wrote this note, the office or the creative manager/.test(e.message) && (await prisma.mediaNote.findUnique({ where: { id: N3 } }))?.body === "Trim the drone shot to two seconds and keep the pull back" && (await changes()) === before, `${e.message} | ${d.message}`);
      const own = await prisma.mediaNote.create({ data: { projectId: A.id, assetUrl: streamUrlFor(cutA), assetType: "video", timeSec: 30, lane: "EDITOR", kind: "fix", body: "The 0:30 jump is on purpose", status: "OPEN", authorKey: "editor:kim", authorName: "Kim", authorUserId: uKim.id, editorKey: "kim" } });
      const bellsBefore = (await kimBells()).length;
      const ke = await na.editCutNote(own.id, "The 0:30 jump is on purpose (beat drop)");
      c.ok("Kim can edit her own note for the reviewer; it is not \"sent\", so no bell", ke.ok && ke.message === "Saved." && (await kimBells()).length === bellsBefore, ke.message);
      const kd = await na.deleteCutNote(own.id);
      const ku = kd.changeId ? await na.undoCutNoteDelete(kd.changeId) : { ok: false, message: "no change id" };
      c.ok("…delete it and undo her own delete", kd.ok && ku.ok && !!(await prisma.mediaNote.findUnique({ where: { id: own.id } })), `${kd.message} | ${ku.message}`);
      viewer = V.kim;
      const kimView = await ne.decorateCutNotes(await getEditorFeedback(A.id, "kim"), await ne.noteChangerForViewer());
      c.ok("Kim's page offers Edit on her note only", kimView.find((n) => n.id === own.id)?.canChange === true && kimView.find((n) => n.id === N3)?.canChange === false, JSON.stringify(kimView.map((n) => [n.body.slice(0, 12), n.canChange])));

      viewer = V.harrison;
      const h = await rr.addCutNote({ projectId: A.id, submissionId: cutA, body: "The kitchen was shot twice, use the wide", lane: "PHOTOGRAPHER", kind: "coaching", timeSec: 50 });
      const H = h.noteId!;
      const he = await na.editCutNote(H, "The kitchen was shot twice, use the wide one");
      const hx = await na.editCutNote(N3, "Harrison changed it");
      c.ok("Harrison (photographer) edits his own capture note, not the office's", h.ok && he.ok && !hx.ok, `${h.message} | ${he.message} | ${hx.message}`);
      const hd = await na.deleteCutNote(H);
      viewer = V.kim;
      const kimUndo = await na.undoCutNoteDelete(hd.changeId!);
      c.ok("Kim can't undo Harrison's delete", hd.ok && !kimUndo.ok && /Only the person who deleted it, the office or the creative manager/.test(kimUndo.message), kimUndo.message);
      viewer = V.harrison;
      const hu = await na.undoCutNoteDelete(hd.changeId!);
      c.ok("…Harrison can", hu.ok && !!(await prisma.mediaNote.findUnique({ where: { id: H } })), hu.message);
      viewer = V.jordan;
      const je = await na.editCutNote(H, "Use the wide kitchen take");
      c.ok("Jordan (owner) can edit anyone's note", je.ok && (await prisma.mediaNote.findUnique({ where: { id: H } }))?.body === "Use the wide kitchen take", je.message);

      // A reply: edited and deleted the same way, and listed under Deleted with its Undo.
      viewer = V.kyle;
      const rp = await rr.replyCutNote(N3, "Keep the pull back, it is the money shot");
      const reply = await prisma.mediaNote.findFirst({ where: { parentId: N3 }, orderBy: { createdAt: "desc" } });
      const re = reply ? await na.editCutNote(reply.id, "Keep the pull back, it is the best shot") : { ok: false, message: "no reply" };
      const rd = reply ? await na.deleteCutNote(reply.id) : { ok: false, message: "no reply" };
      const listedReply = (await ne.deletedNotesOn(cutA, await ne.noteChangerForViewer(), uKyle.id)).find((x) => x.changeId === rd.changeId);
      c.ok("a reply is edited and deleted like a note, and listed as a reply with Undo", rp.ok && re.ok && rd.ok && listedReply?.reply === true && listedReply.canUndo && listedReply.body === "Keep the pull back, it is the best shot", JSON.stringify(listedReply));
      const ru = await na.undoCutNoteDelete(rd.changeId!);
      c.ok("…and comes back under its note", ru.ok && (await prisma.mediaNote.findUnique({ where: { id: reply!.id } }))?.parentId === N3, ru.message);

      viewer = V.harrison;
      const late = await na.deleteCutNote(H);
      const hActor = await ne.noteActorFromSession();
      const tooLate = hActor.ok ? await ne.undoNoteDelete(late.changeId!, hActor.actor, new Date(Date.now() + 25 * 3_600_000)) : { ok: false, message: "no actor" };
      c.ok("Undo closes after 24 hours", late.ok && !tooLate.ok && /only offered for 24 hours/.test(tooLate.message), tooLate.message);
      const listedLate = await ne.deletedNotesOn(cutA, await ne.noteChangerForViewer(), uHarrison.id, new Date(Date.now() + 25 * 3_600_000));
      c.ok("…and the Deleted line drops its Undo button then", listedLate.find((x) => x.changeId === late.changeId)?.canUndo === false);

      viewer = V.preview;
      const pBefore = await changes();
      const pe = await na.editCutNote(N3, "preview edit");
      const pd = await na.deleteCutNote(N3);
      const pu = await na.undoCutNoteDelete(late.changeId!);
      const ph = await na.holdBackClientNoteAction("abcdefgh12");
      c.ok("\"view as\" (Jordan previewing Kim) writes nothing anywhere", [pe, pd, pu, ph].every((r) => !r.ok && r.message === PREVIEW_REFUSED) && (await changes()) === pBefore, pe.message);
      c.ok("…and the preview's page offers no Edit", (await ne.decorateCutNotes(await getEditorFeedback(A.id, null), await ne.noteChangerForViewer())).every((n) => !n.canChange));
      viewer = null;
      const so = await na.editCutNote(N3, "signed out");
      c.ok("signed out (auth on): refused", !so.ok && so.message === "Please sign in to do that.", so.message);
      viewer = V.kyle;
      c.ok("an empty edit is refused (use Delete)", !(await na.editCutNote(N3, "   ")).ok);
      c.ok("a made-up id is refused before any lookup", !(await na.editCutNote("x", "words")).ok && !(await na.deleteCutNote("../../etc")).ok);
    }

    // =========================================================================
    c.head("4 · a client's notes: their words stay theirs");
    // =========================================================================
    {
      const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Cora Client TEST", package: "Accelerator", videosPerMonth: 4, monthKey: "2026-10", owner: { email: "cora@example.com", name: "Cora Client" } });
      await ensureOutputsForProject(f.projectId!);
      const vid = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId, deliverableId: f.deliverableId, slot: 1, status: "EDITING", title: "Video 1" }, select: { id: true } });
      const row = await prisma.reviewSubmission.create({
        data: { projectId: f.projectId!, deliverableId: f.deliverableId, slot: 1, round: 1, status: "PENDING", fileName: "video1-v1.mp4", source: "upload", submittedByKey: "kim", submittedByName: "Kim", videoId: vid.id },
        select: { id: true },
      });
      const cut = row.id;
      await prisma.reviewSubmission.update({ where: { id: cut }, data: { assetUrl: streamUrlFor(cut) } });
      viewer = V.james;
      const ap = await rr.approveCut(cut);
      c.ok("the office approves the cut (James)", ap.ok, ap.message);
      // Released to the client the way the portal publication does (scripts/_drill/b6-review-attribution.ts publish).
      await prisma.reviewSubmission.update({ where: { id: cut }, data: { clientReleasedAt: new Date(), clientReleasedBy: "Portal publication" } });
      const { openReviewWindow } = await import("@/lib/reviewWindows");
      await openReviewWindow(cut, { by: "Portal publication" });
      const subRow = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut } });
      const { correctedCutApproved } = await import("@/lib/reviewCuts");
      await correctedCutApproved(subRow.projectId, { cutCreatedAt: subRow.createdAt, round: subRow.round, cut: { id: subRow.id, deliverableId: subRow.deliverableId, slot: subRow.slot, assetPath: subRow.assetPath } });

      const ago = new Date(Date.now() - 20 * 60_000);
      const note = (body: string, timeSec: number) =>
        prisma.portalComment.create({ data: { submissionId: cut, projectId: f.projectId!, enrollmentId: f.enrollmentId, timeSec, body, status: "OPEN", clientUserId: f.clientUserId!, createdAt: ago }, select: { id: true } });
      const C1 = (await note("I hate the music", 3)).id;
      const C2 = (await note("make it pop more", 7)).id;
      const C3 = (await note("Swap the song for something upbeat", 15)).id;

      viewer = V.kim;
      const kh = await na.holdBackClientNoteAction(C1);
      const kr = await na.rewordClientNoteAction(C2, "Kim's words");
      c.ok("Kim (editor) can't hold back or reword a client's note", !kh.ok && !kr.ok && /Only the owner, the office or the creative manager/.test(kh.message), kh.message);

      viewer = V.kyle;
      const hb = await na.holdBackClientNoteAction(C1);
      let c1 = await prisma.portalComment.findUniqueOrThrow({ where: { id: C1 } });
      c.ok("Kyle holds one back before the send: resolved by our team, the client's words untouched", hb.ok && c1.status === "RESOLVED" && c1.resolvedByKind === "STAFF" && c1.body === "I hate the music", hb.message);
      const hbUndo = await na.undoClientNoteChangeAction(hb.changeId!);
      c1 = await prisma.portalComment.findUniqueOrThrow({ where: { id: C1 } });
      c.ok("…Undo lets it go after all", hbUndo.ok && c1.status === "OPEN" && !c1.resolvedByKind, hbUndo.message);
      const hb2 = await na.holdBackClientNoteAction(C1);
      c.ok("…held back again", hb2.ok);
      const rw = await na.rewordClientNoteAction(C2, "Raise the contrast on the kitchen shots a little");
      c.ok("Kyle changes what the editor will get from another (before the send)", rw.ok && /your wording with the client's words beside it/.test(rw.message) && (await prisma.portalComment.findUniqueOrThrow({ where: { id: C2 } })).body === "make it pop more", rw.message);
      const view = (await ne.clientNoteChangesFor([C1, C2, C3]));
      c.ok("the Review Room shows held back and the new wording", !!view.get(C1)?.heldBack && view.get(C2)?.reworded?.words === "Raise the contrast on the kitchen shots a little" && !view.get(C3));

      // The 15-minute send, as the client: the held note stays behind, the reworded one goes in our words.
      viewer = null;
      const run = await un.sweepUnsentClientNotes({ now: new Date() });
      c.ok("the 15-minute send goes for the client", run.sent === 1, JSON.stringify(run));
      const brief = await prisma.revisionBrief.findFirst({ where: { submissionId: cut, sourceDetail: { startsWith: "decision:" } }, orderBy: { createdAt: "desc" } });
      const text = brief?.originalText ?? "";
      c.ok("…the editor gets our wording with the client's words beside it", text.includes('[0:07] Raise the contrast on the kitchen shots a little (worded by Kyle. The client wrote: "make it pop more")'), text.replace(/\n/g, " | "));
      c.ok("…the plain note as the client wrote it, and never the held-back one", text.includes("[0:15] Swap the song for something upbeat") && !text.includes("I hate the music"));
      const rows = await prisma.portalComment.findMany({ where: { id: { in: [C1, C2, C3] } } });
      const by = (id: string) => rows.find((r) => r.id === id)!;
      c.ok("…the held note stayed off the request; the other two went", by(C1).status === "RESOLVED" && !by(C1).decisionId && by(C2).status === "SENT" && by(C3).status === "SENT", rows.map((r) => `${r.body}:${r.status}`).join(", "));

      // After the send: our earlier wording already went, so its Undo is not offered.
      viewer = V.kyle;
      const sentView = (await ne.clientNoteChangesFor([C2])).get(C2);
      const lateUndo = await na.undoClientNoteChangeAction(rw.changeId!);
      c.ok("the wording from before the send can't be undone once it went (the screen hides its Undo)", sentView?.reworded?.afterSend === false && !lateUndo.ok && /already went to the editor in these words/.test(lateUndo.message), lateUndo.message);

      // After the send: reword again, on the work-order item.
      const itemsOf = async () => (JSON.parse((await prisma.revisionBrief.findUniqueOrThrow({ where: { id: brief!.id } })).itemsJson ?? "{}") as { items: { id: string; ask: string; quote?: string | null }[]; setAside?: { id: string }[] });
      const before = await itemsOf();
      const itemC2 = before.items.find((i) => /make it pop more/.test(`${i.ask} ${i.quote ?? ""}`));
      const itemC3 = before.items.find((i) => /Swap the song/.test(i.ask));
      c.ok("the work order has an item for each sent note", !!itemC2 && !!itemC3, JSON.stringify(before.items.map((i) => i.ask)));
      const issuesOfItem = (itemId: string) => prisma.revisionIssue.findMany({ where: { sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${brief!.id}:${itemId}:` } } });
      const clientBells = () => prisma.notification.findMany({ where: { userKey: "editor:kim", dedupeKey: { startsWith: "client-note-" } }, orderBy: { createdAt: "asc" } });
      const bellsBefore = (await clientBells()).length;
      const rw2 = await na.rewordClientNoteAction(C2, "Raise the contrast on the kitchen shots by 10 percent");
      const mid = await itemsOf();
      const it2 = mid.items.find((i) => i.id === itemC2!.id);
      c.ok("after the send: the item reads our new words; the earlier wording is kept as the quote", rw2.ok && it2?.ask === "[0:07] Raise the contrast on the kitchen shots by 10 percent" && /make it pop more/.test(it2.quote ?? ""), `${rw2.message} · ${JSON.stringify(it2)}`);
      const fix2 = await issuesOfItem(itemC2!.id);
      c.ok("…its fix item's summary changes; its original (the client's) words stay", fix2.length > 0 && fix2.every((i) => i.summary === "Raise the contrast on the kitchen shots by 10 percent" && /make it pop more/.test(i.originalText)), JSON.stringify(fix2.map((i) => [i.summary, i.originalText])));
      const kimIssues = await issuesForProject(f.projectId!, { scrub: true, viewer: { editorKey: "kim" } });
      c.ok("…Kim's list says it was reworded", kimIssues.find((i) => i.id === fix2[0]?.id)?.noteChange?.kind === "REWORDED");
      const rwBells = await clientBells();
      c.ok("…and Kim is belled one line", rwBells.length === bellsBefore + 1 && /^Kyle reworded a client note on /.test(rwBells.at(-1)?.title ?? "") && rwBells.at(-1)?.kind === "revision_addendum", rwBells.at(-1)?.title ?? "none");
      const rwUndo = await na.undoClientNoteChangeAction(rw2.changeId!);
      const undone = (await itemsOf()).items.find((i) => i.id === itemC2!.id);
      c.ok("Undo puts the item's earlier wording back", rwUndo.ok && undone?.ask === itemC2!.ask && (undone.quote ?? null) === (itemC2!.quote ?? null), JSON.stringify(undone));
      c.ok("…and Kim's list no longer says reworded", (await issuesForProject(f.projectId!, { scrub: true, viewer: { editorKey: "kim" } })).find((i) => i.id === fix2[0]?.id)?.noteChange === null);

      // Take one off the list (the creative manager), then put it back.
      viewer = V.james;
      const rm = await na.removeClientNoteAction(C3);
      const afterRm = await itemsOf();
      const fix3 = await issuesOfItem(itemC3!.id);
      c.ok("James takes a client's note off the editor's list: the item is set aside, its fix item not needed", rm.ok && !afterRm.items.some((i) => i.id === itemC3!.id) && (afterRm.setAside ?? []).some((i) => i.id === itemC3!.id) && fix3.length > 0 && fix3.every((i) => i.state === "NOT_APPLICABLE"), rm.message);
      c.ok("…Kim is told, and her list shows it was taken off", /^James took a client note off your list on /.test((await clientBells()).at(-1)?.title ?? "") && (await issuesForProject(f.projectId!, { scrub: true, viewer: { editorKey: "kim" } })).find((i) => i.id === fix3[0].id)?.noteChange?.kind === "REMOVED");
      const rmUndo = await na.undoClientNoteChangeAction(rm.changeId!);
      const afterUndo = await itemsOf();
      c.ok("Undo puts it back on the list where it was, its fix item open", rmUndo.ok && afterUndo.items.findIndex((i) => i.id === itemC3!.id) === before.items.findIndex((i) => i.id === itemC3!.id) && !(afterUndo.setAside ?? []).some((i) => i.id === itemC3!.id) && (await issuesOfItem(itemC3!.id)).every((i) => i.state === "OPEN"), rmUndo.message);

      const odd = await prisma.portalComment.create({ data: { submissionId: cut, projectId: f.projectId!, enrollmentId: f.enrollmentId, timeSec: 2, body: "zzz words nobody split out", status: "SENT", clientUserId: f.clientUserId!, decisionId: by(C2).decisionId }, select: { id: true } });
      const cant = await na.rewordClientNoteAction(odd.id, "Something clear");
      c.ok("a note that can't be matched to one item is refused with where to change it instead", !cant.ok && /fix list on the editor brief/.test(cant.message), cant.message);
      const finalRows = await prisma.portalComment.findMany({ where: { id: { in: [C1, C2, C3] } } });
      c.ok("through all of it, the client's own words never changed", finalRows.find((r) => r.id === C1)?.body === "I hate the music" && finalRows.find((r) => r.id === C2)?.body === "make it pop more" && finalRows.find((r) => r.id === C3)?.body === "Swap the song for something upbeat");
      c.ok("every change is on the timeline", (await prisma.activity.count({ where: { projectId: f.projectId!, body: { contains: "client's note" } } })) >= 4);
    }

    // =========================================================================
    c.head("5 · the screens");
    // =========================================================================
    {
      const controls = read("src/components/review/NoteEditControls.tsx");
      const clientControls = read("src/components/review/ClientNoteControls.tsx");
      const panel = read("src/components/review/CutReviewPanel.tsx");
      const feedback = read("src/components/editing/EditFeedback.tsx");
      const reviewPage = read("src/app/review/[id]/page.tsx");
      const editPage = read("src/app/edit/[id]/page.tsx");
      const cutPanel = read("src/components/editing/EditorCutPanel.tsx");
      c.ok("Edit, Delete and Undo are wired to the actions", /data-note-edit/.test(controls) && /editCutNote\(note\.id, words\)/.test(controls) && /data-note-delete/.test(controls) && /deleteCutNote\(note\.id\)/.test(controls) && /data-note-undo/.test(controls) && /undoCutNoteDelete\(n\.changeId\)/.test(controls));
      c.ok("a sent note asks before it is deleted, naming the editor", /already has this \{label\}\. Delete it and tell them it is no longer needed\?/.test(controls));
      c.ok("the client-note controls: hold back only before the send, take off only after, Undo hidden where it would do nothing",
        /data-client-note-hold/.test(clientControls) && /\{waiting && \(/.test(clientControls) && /data-client-note-remove/.test(clientControls) && /\{sent && \(/.test(clientControls) && /change\.reworded\.afterSend \|\| !sent/.test(clientControls));
      c.ok("the Review Room panel shows Edit/Delete, the history and the Deleted list", /<NoteEditControls\b/.test(panel) && /<NoteEditHistory\b/.test(panel) && /<DeletedNotes notes=\{deletedNotes\} \/>/.test(panel));
      c.ok("the page hands it the decorated notes, the deleted ones and the client-note controls", /notes=\{cutNotes\}/.test(reviewPage) && /deletedNotes=\{deletedNotes\}/.test(reviewPage) && /<ClientNoteControls\b/.test(reviewPage));
      c.ok("the editor's page: her own notes editable, each changed item carries its line, removed ones listed", /<NoteEditControls\b/.test(feedback) && /changed: noteChangeLine\(i\)/.test(editPage) && /removed=\{removedFor\(s\)\}/.test(editPage) && /data-note-changed/.test(cutPanel) && /data-notes-removed/.test(cutPanel));
      const buttons = (src: string) => src.split("<button").slice(1).map((b) => b.slice(0, b.indexOf("</button>")));
      const small = [...buttons(controls), ...buttons(clientControls)].filter((b) => !/min-h-11|\bBTN\b/.test(b));
      c.ok("every new button is at least 44px tall", small.length === 0 && /const BTN = "inline-flex min-h-11/.test(controls) && /const BTN = "inline-flex min-h-11/.test(clientControls), small.map((b) => b.slice(0, 60)).join(" | "));
      c.ok("the history toggle is a 44px target too", /<summary className="inline-flex min-h-11/.test(controls));
      const panelButtons = buttons(panel).filter((b) => /aria-label=\{?"?(Resolve|Reopen)/.test(b) || /setNoteLane|lane ===/.test(b));
      c.ok("the Review Room's resolve and reopen buttons grew to 44px", panelButtons.length > 0 && panelButtons.every((b) => /size-11|min-h-11/.test(b)), String(panelButtons.length));
      const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      c.ok("no dashes in the words these screens show", !DASH.test(code(controls)) && !DASH.test(code(clientControls)));
      c.ok("the phone width: long words wrap", /break-words/.test(controls) && /break-words/.test(clientControls) && /min-w-0/.test(controls));
      c.ok("the schema change is one new model, nothing altered", /\nmodel NoteChange \{/.test(read("prisma/schema.prisma")));
    }

    c.head("isolation");
    c.ok("only Slack was answered; nothing else left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
