// ---------------------------------------------------------------------------
// "ASK A QUESTION" ON A REVISION, AND ON WHAT TO MAKE (Jordan, Oct 27 2026:
// "there should be a little ask a question button, small here, and the editor
// should be able to click the button and ask a question about a specific
// revision, and then the creative manager should get a text, and whoever left
// the revision should get a text, asking for whatever clarification that's
// needed. Same thing with the what to make").
//
// WHO IS TEXTED:
//   · the creative manager, always;
//   · whoever left the revision, when that was someone on our team (the
//     reviewer who wrote the note, the office person who recorded the ask);
//   · never a client. A revision the client left goes to the creative
//     manager only, who takes it to the client the usual way.
// For "What to make" the person who wrote the video's instructions is the
// photographer on the job, so they are asked beside the creative manager.
//
// The question is posted on the job's team chat (no @-tag, so it does not
// ring twice) and recorded on the revision itself as an EDITOR_QUESTION event
// (no schema change: the reviewer sees it in the issue's history). Texts go
// through the one staff texting path (notify.notifyStaffSms).
// ---------------------------------------------------------------------------

import { leftByOfAuthorKey, leftByOfBrief, questionRecipients, questionText, type LeftBy, type QuestionTarget } from "@/lib/editorQuestionsCore";
export { askWhoWords, leftByOfAuthorKey, leftByOfBrief, questionRecipients, questionText, type LeftBy, type QuestionTarget } from "@/lib/editorQuestionsCore";

/**
 * Send one question. The caller has checked the asker may see the job.
 * Returns who was texted, by first name, for the button's own confirmation.
 */
export async function askEditQuestion(input: {
  projectId: string;
  target: QuestionTarget;
  words: string;
  asker: { name: string; teamMemberId: string | null; userId: string | null };
}): Promise<{ ok: boolean; message: string }> {
  const { prisma } = await import("@/lib/prisma");
  const words = input.words.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (words.length < 3) return { ok: false, message: "Write the question first." };
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, title: true, photographerId: true } });
  if (!project) return { ok: false, message: "That job no longer exists." };
  const street = (project.title ?? "").split(",")[0].trim() || "the job";
  const { creativeManagerDesk, ownerDesk } = await import("@/lib/taskRouting");
  const cm = await creativeManagerDesk().catch(() => null);

  let leftBy: LeftBy = { kind: "unknown" };
  let about = "what to make";
  let issueId: string | null = null;
  const t = input.target;
  if (t.kind === "issue") {
    const issue = await prisma.revisionIssue.findFirst({
      where: { id: t.id, projectId: project.id },
      select: { id: true, sourceKind: true, sourceId: true, raisedByKey: true, summary: true, originalText: true },
    });
    if (!issue) return { ok: false, message: "That note is no longer on this job. Reload the page." };
    issueId = issue.id;
    about = `the note "${(issue.summary || issue.originalText).replace(/\s+/g, " ").trim().slice(0, 80)}"`;
    if (issue.sourceKind === "BRIEF_ITEM") {
      const brief = await prisma.revisionBrief.findUnique({ where: { id: issue.sourceId.split(":")[0] }, select: { requestedByKind: true, requestedByUserId: true } }).catch(() => null);
      leftBy = await briefLeftBy(brief);
    } else {
      let key = issue.raisedByKey;
      if (!key && issue.sourceKind === "REVIEW_NOTE") {
        const note = await prisma.mediaNote.findUnique({ where: { id: issue.sourceId }, select: { authorKey: true, authorUserId: true, photographerId: true } }).catch(() => null);
        key = note?.authorKey ?? (note?.authorUserId ? `user:${note.authorUserId}` : note?.photographerId ? `tm:${note.photographerId}` : null);
      }
      leftBy = await authorLeftBy(key, ownerDesk);
    }
  } else if (t.kind === "ask") {
    const task = await prisma.smartTask.findFirst({ where: { id: t.id, projectId: project.id }, select: { id: true, title: true } });
    if (!task) return { ok: false, message: "That request is no longer open. Reload the page." };
    about = "the client's change request";
    const brief = await prisma.revisionBrief.findFirst({ where: { taskId: task.id }, orderBy: { createdAt: "asc" }, select: { requestedByKind: true, requestedByUserId: true } }).catch(() => null);
    // A request with no work order on file came from the client's own words.
    leftBy = brief ? await briefLeftBy(brief) : { kind: "client" };
  } else if (project.photographerId) {
    leftBy = { kind: "staff", teamMemberId: project.photographerId };
  }

  const to = questionRecipients({ creativeManagerId: cm?.id ?? null, leftBy, askerTeamMemberId: input.asker.teamMemberId });
  if (!to.length) return { ok: false, message: "Nobody is set up to answer this yet (no creative manager on the team list). Ask in the team messages." };
  const { appBase } = await import("@/lib/appUrl");
  const link = `${appBase()}/edit/${project.id}#messages`;
  const { notifyStaffSms } = await import("@/lib/notify");
  const sent = await notifyStaffSms(to, questionText({ asker: input.asker.name, street, about, words, link }), "editor_question").catch(() => []);
  const people = await prisma.teamMember.findMany({ where: { id: { in: to } }, select: { id: true, name: true } }).catch(() => []);
  const firstOf = (id: string) => (people.find((p) => p.id === id)?.name ?? "").trim().split(/\s+/)[0] || "the team";
  const names = to.map(firstOf);

  // On the job's chat, so the answer lands where the editor reads (no @, so no second ping).
  try {
    const { postProjectMessage } = await import("@/app/projects/messageActions");
    await postProjectMessage(project.id, null, `Question about ${about}: ${words} (texted to ${names.join(" and ")})`, []);
  } catch { /* the text went; the chat line is a courtesy */ }
  // On the revision itself, so the reviewer sees it in the note's history.
  if (issueId) {
    await prisma.revisionIssueEvent
      .create({ data: { issueId, kind: "EDITOR_QUESTION", actorName: input.asker.name.slice(0, 120), actorUserId: input.asker.userId, note: words.slice(0, 1000), toValue: to.join(",").slice(0, 500) } })
      .catch(() => null);
  } else {
    await prisma.activity
      .create({ data: { projectId: project.id, type: "SYSTEM", body: `${input.asker.name} asked about ${about}: "${words.slice(0, 300)}" (texted to ${names.join(" and ")}).`, authorId: input.asker.teamMemberId } })
      .catch(() => null);
  }
  const reached = sent.some((s) => !["no-phone", "failed", "own-line"].includes(s.outcome));
  return reached || sent.length === 0
    ? { ok: true, message: `Sent to ${names.join(" and ")}. The answer comes back in the team messages.` }
    : { ok: true, message: `Posted in the team messages. The text to ${names.join(" and ")} did not go through, so they will see it there.` };
}

async function briefLeftBy(brief: { requestedByKind: string | null; requestedByUserId: string | null } | null): Promise<LeftBy> {
  if (!brief) return { kind: "unknown" };
  let officeTm: string | null = null;
  if ((brief.requestedByKind ?? "").toUpperCase() === "OFFICE" && brief.requestedByUserId) {
    const { prisma } = await import("@/lib/prisma");
    officeTm = (await prisma.appUser.findUnique({ where: { id: brief.requestedByUserId }, select: { teamMemberId: true } }).catch(() => null))?.teamMemberId ?? null;
  }
  return leftByOfBrief(brief.requestedByKind, officeTm);
}

async function authorLeftBy(key: string | null, ownerDesk: () => Promise<{ id: string } | null>): Promise<LeftBy> {
  const k = (key ?? "").trim();
  if (!k) return { kind: "unknown" };
  const { prisma } = await import("@/lib/prisma");
  const owner = k === "owner" ? await ownerDesk().catch(() => null) : null;
  const userTm = k.startsWith("user:") ? (await prisma.appUser.findUnique({ where: { id: k.slice(5) }, select: { teamMemberId: true } }).catch(() => null))?.teamMemberId ?? null : null;
  const { editorTeamMemberId } = await import("@/lib/editors");
  const editorTm = k.startsWith("editor:") ? await editorTeamMemberId(k.slice(7)).catch(() => null) : null;
  return leftByOfAuthorKey(k, { ownerId: owner?.id ?? null, userTeamMember: () => userTm, editorTeamMember: () => editorTm });
}
