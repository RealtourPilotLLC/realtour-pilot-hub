// ---------------------------------------------------------------------------
// DRILL: the creative review lane (Oct 15 2026).
//
// Marcee McMullen, Oct 15: "I know I don't like something about it, but I
// wouldn't know how to tell someone to fix it ... I feel like it's too slow or
// too fast or whatever". The editor must never get a feeling like that as a
// literal task.
//
//   1. The vocabulary: her words read as DIRECTION_UNCLEAR, a clear change
//      does not; kinds map to suggested causes; a held item is outstanding.
//   2. Her words by text on a delivered video: the item is held, a Creative
//      review task opens for Jordan with her exact words, the editor's card
//      waits (WAITING_JORDAN), no editor issue and no editor bell; the editor
//      sees only that it is with Jordan, the office sees her words.
//   3. Jordan writes two concrete changes: they reach the editor as issues
//      (suggested cause CLIENT_CHANGE), the card opens again, the task
//      closes, the editor is told; a re-read is refused afterwards. Kyle
//      cannot answer a creative review.
//   4. A mixed ask: the concrete correction goes straight to the editor
//      (suggested EDITOR_ERROR), only the feeling waits; the card stays open.
//   5. The same area again on the same video, and a second round asking for a
//      new overall direction: both go to creative review. With James as the
//      cut's reviewer in the creative-approver seat, the task is James's and
//      the card is BLOCKED with the reason.
//   6. A portal note with no model ("it feels flat"), open questions, Send as
//      is (a reading is required), No change needed, and a reviewer reopening
//      a creative fix that did not land.
//
// ISOLATION: PGlite via the shared harness; the model is answered in-process;
// nothing else leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const MARCEE = "I know I don't like something about it, but I wouldn't know how to tell someone to fix it ... I feel like it's too slow or too fast or whatever";
type Item = { area: string; ask: string; kind: string; detail: string; quote: string; scope: string; videos: string[] };
let nextItems: Item[] = [];
let nextQuestions: string[] = [];
const briefPrompts: string[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: string; messages?: { content: string }[] };
    const prompt = String(body.messages?.[0]?.content ?? "");
    if (prompt.includes("--- WHAT THE CLIENT SAID ---")) {
      briefPrompts.push(`${body.system ?? ""}\n${prompt}`);
      return json({ content: [{ type: "tool_use", name: "emit", input: { headline: "Changes to the video", items: nextItems, keep: [], references: [], questions: nextQuestions } }] });
    }
    return json({ content: [{ type: "text", text: "ok" }] });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  return null;
});
const item = (p: Partial<Item> & { ask: string }): Item => ({ area: "Overall direction", kind: "REFINEMENT", detail: "", quote: "", scope: "all", videos: [], ...p });

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7101), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-creative-review" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession } = await import("@/lib/auth/session");
  const read = (p: string) => fs.readFileSync(p, "utf8");
  try {
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("ai", "drill-ai-key-not-real");
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan-tm@cr.test", role: "PHOTOGRAPHER" } });
    const jordan = await prisma.appUser.create({ data: { name: "Jordan Spackman", email: "jordan@cr.test", role: "OWNER", status: "ACTIVE", teamMemberId: jordanTm.id } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle Cabrera", email: "kyle@cr.test", role: "ADMIN", status: "ACTIVE" } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James Livingston", email: "james-tm@cr.test", role: "PHOTOGRAPHER" } });
    const james = await prisma.appUser.create({ data: { name: "James Livingston", email: "james@cr.test", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: jamesTm.id } });
    await prisma.appUser.create({ data: { name: "Kim", email: "kim@cr.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const kim = await prisma.teamMember.create({ data: { name: "Kim", email: "kim-tm@cr.test", role: "EDITOR" } });
    await setSession({ uid: jordan.id, email: jordan.email, role: "OWNER" });

    const core = await import("@/lib/creativeReviewCore");
    const { outstandingItems, getRevisionBriefs, analyzeBrief, createRevisionBrief } = await import("@/lib/revisionBrief");
    const { raiseRevision } = await import("@/lib/comms");
    const actions = await import("@/app/review/checklistActions");

    // ======================================================================
    c.head("1 · the vocabulary");
    c.ok("Marcee's words read as direction unclear", core.soundsUnclear(MARCEE) && core.kindOf({ kind: "REFINEMENT", quote: MARCEE, ask: "Adjust the pacing" }) === "DIRECTION_UNCLEAR");
    c.ok("'it feels flat' too", core.soundsUnclear("Honestly it feels flat to me"));
    c.ok("a clear change does not: 'the music is too loud'", !core.soundsUnclear("The music is too loud, can you bring it down?") && core.kindOf({ kind: "REFINEMENT", ask: "Lower the music" }) === "REFINEMENT");
    c.ok("'I don't like the font' is a clear change, not a feeling", !core.soundsUnclear("I don't like the font on the intro"));
    c.ok("kinds suggest causes: correction → editor error, refinement → client change, scope → new scope", core.causeSuggestionFor("CORRECTION") === "EDITOR_ERROR" && core.causeSuggestionFor("REFINEMENT") === "CLIENT_CHANGE" && core.causeSuggestionFor("SCOPE") === "NEW_SCOPE");
    c.ok("a held item stays outstanding whatever was approved", outstandingItems({ items: [{ id: "i1", ask: "x", held: true, scope: "all" }], done: [], approvedKeys: new Set(["d:1"]), owedKeys: ["d:1"] }).length === 1);
    c.ok("one change per line, bullets stripped", JSON.stringify(core.changeLines("- Trim the intro\n2) Cut faster in the middle\n\nx")) === JSON.stringify(["Trim the intro", "Cut faster in the middle"]));

    // A delivered program video, Kim's, approved and sent.
    const mk = async (name: string, reviewerTm?: string | null) => {
      const f = await buildContentMonth(prisma as never, { name, package: "Starter", project: { status: "DELIVERED" } });
      await prisma.project.update({ where: { id: f.projectId! }, data: { editorId: kim.id, editorManual: true, deliveredAt: new Date(Date.now() - 2 * 3600_000) } });
      const sub = await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "reel-1-v1.mov", assetUrl: "/api/review/cut/crcut1/stream", decidedBy: "James Livingston", decidedAt: new Date(Date.now() - 3 * 3600_000), submittedByKey: "kim", sentToClientAt: new Date(Date.now() - 2 * 3600_000), reviewerTeamMemberId: reviewerTm ?? null } });
      const out = await prisma.deliverableOutput.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, category: "SOCIAL_REEL", currentSubmissionId: sub.id, approvedSubmissionId: sub.id, deliveredAt: new Date(Date.now() - 2 * 3600_000) } });
      await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { outputId: out.id } });
      return { f, sub, projectId: f.projectId! };
    };
    const latestBrief = (projectId: string) => prisma.revisionBrief.findFirstOrThrow({ where: { projectId }, orderBy: { createdAt: "desc" } });
    const crTask = (briefId: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `creative-review:${briefId}` } });

    // ======================================================================
    c.head("2 · Marcee's words by text: held, with Jordan, the editor waits");
    const M = await mk("Marcee Creative TEST");
    nextItems = [item({ area: "Pacing & movement", ask: "Adjust the pacing of the video", kind: "REFINEMENT", quote: MARCEE })];
    nextQuestions = [];
    await raiseRevision({ projectId: M.projectId, clientId: M.f.clientId, clientName: M.f.clientName, note: MARCEE, source: "openphone", threadRef: "op-marcee-1", requestedBy: { name: "Marcee", kind: "TEXT" } });
    c.ok("the brief prompt asks for a kind on every item and keeps feelings for creative review", /DIRECTION_UNCLEAR/.test(briefPrompts.at(-1) ?? "") && /read by our creative director first/.test(briefPrompts.at(-1) ?? ""));
    const b1 = await latestBrief(M.projectId);
    const cr1 = core.creativeReviewOf(b1.itemsJson);
    const items1 = (JSON.parse(b1.itemsJson!) as { items: { kind?: string; held?: boolean }[] }).items;
    c.ok("the item is DIRECTION_UNCLEAR and held, though the model said REFINEMENT", items1.length === 1 && items1[0].kind === "DIRECTION_UNCLEAR" && items1[0].held === true);
    c.ok("creative review is OPEN, Jordan's, because she can't say what to change", cr1?.state === "OPEN" && cr1.reviewerKey === "jordan" && cr1.reasons.includes("UNCLEAR") && cr1.taskHeld === true, JSON.stringify(cr1));
    const t1 = await crTask(b1.id);
    c.ok("a Creative review task for Jordan with her exact words", !!t1 && t1.taskType === "creative_review" && t1.assignedKey === "jordan" && t1.status === "OPEN" && (t1.description ?? "").includes("too slow or too fast or whatever"));
    const rev1 = await prisma.smartTask.findUniqueOrThrow({ where: { id: b1.taskId! } });
    c.ok("the editor's revision card waits on Jordan", rev1.status === "WAITING_JORDAN" && /^Creative review: /.test(rev1.blockedReason ?? ""), `${rev1.status} / ${rev1.blockedReason}`);
    c.ok("no editor issue was made from the feeling", (await prisma.revisionIssue.count({ where: { projectId: M.projectId } })) === 0);
    c.ok("Kim was not rung for it", (await prisma.notification.count({ where: { userKey: "editor:kim" } })) === 0);
    c.ok("Jordan was rung, linked to the Review Room", !!(await prisma.notification.findFirst({ where: { title: { startsWith: "Creative review" }, href: `/review/${M.projectId}#creative-review` } })));
    const editorView = (await getRevisionBriefs(M.projectId, true)).at(-1)!;
    c.ok("the editor sees that it is with Jordan, never the feeling", editorView.items[0].ask.startsWith("With Jordan for creative review") && !editorView.items[0].quote && !JSON.stringify(editorView.items).includes("too slow"));
    const officeView = (await getRevisionBriefs(M.projectId, false)).at(-1)!;
    c.ok("the office sees her words and why it's held", officeView.items[0].quote === MARCEE && officeView.creativeReview?.state === "OPEN" && /can't say exactly/.test(officeView.creativeReview?.reasons[0] ?? ""));
    const { openCreativeReviews } = await import("@/lib/creativeReview");
    const panel = await openCreativeReviews(M.projectId);
    c.ok("the Review Room panel lists it with her words", panel.length === 1 && panel[0].held[0].quote === MARCEE && panel[0].taskHeld);

    // ======================================================================
    c.head("3 · Jordan turns it into changes; Kyle cannot");
    await setSession({ uid: kyle.id, email: kyle.email, role: "ADMIN" });
    const byKyle = await actions.resolveCreativeReviewAction({ briefId: b1.id, mode: "CHANGES", changes: "Speed it up", note: null });
    c.ok("Kyle (office) cannot answer a creative review", !byKyle.ok && /Jordan's or James's/.test(byKyle.message), byKyle.message);
    await setSession({ uid: jordan.id, email: jordan.email, role: "OWNER" });
    const empty = await actions.resolveCreativeReviewAction({ briefId: b1.id, mode: "CHANGES", changes: "  ", note: null });
    c.ok("no changes written: refused in words", !empty.ok && /at least one change/.test(empty.message));
    const done = await actions.resolveCreativeReviewAction({ briefId: b1.id, mode: "CHANGES", changes: "- Trim the opening to the first line of the hook\n- Cut every 2 to 3 seconds in the middle section", note: "She wants it to feel quicker without losing the script." });
    c.ok("Jordan's two changes go to the editor", done.ok && /Sent 2 changes/.test(done.message), done.message);
    const b1b = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: b1.id } });
    const after = JSON.parse(b1b.itemsJson!) as { items: { id: string; ask: string; kind: string; held?: boolean; quote: string; fromReview?: { by: string } }[]; creativeReview: { state: string; mode: string; archived: { quote: string }[] } };
    c.ok("the held feeling is replaced by the concrete changes, her words kept as the receipt", after.items.length === 2 && after.items.every((i) => !i.held && i.kind === "REFINEMENT" && i.quote === MARCEE && i.fromReview?.by === "Jordan Spackman") && after.creativeReview.state === "RESOLVED" && after.creativeReview.archived[0].quote === MARCEE);
    const issues = await prisma.revisionIssue.findMany({ where: { projectId: M.projectId } });
    c.ok("two editor issues now, suggested cause: client change", issues.length === 2 && issues.every((i) => i.causeSuggested === "CLIENT_CHANGE" && i.cause === "UNCLASSIFIED" && i.state === "OPEN"));
    c.ok("the editor's card is open again", (await prisma.smartTask.findUniqueOrThrow({ where: { id: b1.taskId! } })).status === "OPEN");
    c.ok("the creative review task is done", (await crTask(b1.id))?.status === "COMPLETED");
    c.ok("Kim is told it's ready to work", !!(await prisma.notification.findFirst({ where: { userKey: "editor:kim", title: { startsWith: "Ready to work" } } })));
    c.ok("the timeline says who did the creative review", !!(await prisma.activity.findFirst({ where: { projectId: M.projectId, body: { startsWith: "Creative review done by Jordan Spackman" } } })));
    nextItems = [item({ ask: "Something new", quote: "it feels flat" })];
    const reread = await analyzeBrief(b1.id);
    c.ok("a re-read after the review is refused (it would bring the feeling back)", reread === false && /creative review already/.test((await prisma.revisionBrief.findUniqueOrThrow({ where: { id: b1.id } })).analysisError ?? ""));
    c.ok("the editor view now shows the concrete changes", (await getRevisionBriefs(M.projectId, true)).at(-1)!.items.map((i) => i.ask).join("|") === "Trim the opening to the first line of the hook|Cut every 2 to 3 seconds in the middle section");

    // ======================================================================
    c.head("4 · a mixed ask: the correction goes straight to the editor");
    const X = await mk("Mixed Ask TEST");
    nextItems = [
      item({ area: "On-screen text", ask: "Fix the spelling of the brokerage name", kind: "CORRECTION", quote: "you spelled Keller Williams wrong" }),
      item({ area: "Overall direction", ask: "Make it feel more alive", kind: "REFINEMENT", quote: "it just feels flat" }),
    ];
    await raiseRevision({ projectId: X.projectId, clientId: X.f.clientId, clientName: X.f.clientName, note: "you spelled Keller Williams wrong and honestly it just feels flat", source: "openphone", threadRef: "op-mixed-1", requestedBy: { name: "Pat", kind: "TEXT" } });
    const bx = await latestBrief(X.projectId);
    const crx = core.creativeReviewOf(bx.itemsJson);
    c.ok("only the feeling is held", crx?.state === "OPEN" && crx.heldItemIds.length === 1 && crx.taskHeld === false);
    const xIssues = await prisma.revisionIssue.findMany({ where: { projectId: X.projectId } });
    c.ok("the correction is an editor issue now, suggested cause editor error", xIssues.length === 1 && xIssues[0].category === "On-screen text" && xIssues[0].causeSuggested === "EDITOR_ERROR");
    c.ok("the editor's card stays open for the correction", (await prisma.smartTask.findUniqueOrThrow({ where: { id: bx.taskId! } })).status === "OPEN");
    c.ok("Kim is rung for the correction", (await prisma.notification.count({ where: { userKey: "editor:kim", href: `/edit/${X.projectId}` } })) >= 1);

    // ======================================================================
    c.head("5 · the same area again, a second round's new direction, James as reviewer");
    const { putSetting } = await import("@/lib/settings");
    await putSetting("review_room", { creativeApproverTeamMemberId: jamesTm.id }, "drill");
    const R = await mk("Repeat Area TEST", jamesTm.id);
    // An earlier ask on this video's music, already changed by the editor.
    await prisma.revisionIssue.create({ data: { projectId: R.projectId, deliverableId: R.f.deliverableId!, slot: 1, sourceKind: "BRIEF_ITEM", sourceId: "older-brief:i1:x", originalText: "the music is too loud", category: "Music & sound", state: "ADDRESSED", createdAt: new Date(Date.now() - 86_400_000) } });
    nextItems = [item({ area: "Music & sound", ask: "Change the music again", kind: "REFINEMENT", quote: "the music still isn't right, use something calmer" })];
    await raiseRevision({ projectId: R.projectId, clientId: R.f.clientId, clientName: R.f.clientName, note: "the music still isn't right, use something calmer", source: "openphone", threadRef: "op-repeat-1", requestedBy: { name: "Rae", kind: "TEXT" } });
    const br = await latestBrief(R.projectId);
    const crr = core.creativeReviewOf(br.itemsJson);
    c.ok("the same area again goes to creative review", crr?.state === "OPEN" && crr.reasons.includes("REPEAT_AREA"), JSON.stringify(crr?.reasons));
    c.ok("James is the cut's reviewer in the creative seat: it's James's", crr?.reviewerKey === "james" && (await crTask(br.id))?.assignedKey === "james");
    const rr = await prisma.smartTask.findUniqueOrThrow({ where: { id: br.taskId! } });
    c.ok("the card is BLOCKED with the reason (no WAITING_JORDAN for James)", rr.status === "BLOCKED" && /James is turning/.test(rr.blockedReason ?? ""));
    c.ok("James is rung, Jordan copied", !!(await prisma.notification.findFirst({ where: { userKey: `tm:${jamesTm.id}`, title: { startsWith: "Creative review" } } })));
    await setSession({ uid: james.id, email: james.email, role: "PHOTOGRAPHER" });
    const jr = await actions.resolveCreativeReviewAction({ briefId: br.id, mode: "AS_IS", changes: null, note: "" });
    c.ok("Send as is needs a reading", !jr.ok && /reading/.test(jr.message));
    const jr2 = await actions.resolveCreativeReviewAction({ briefId: br.id, mode: "AS_IS", changes: null, note: "Softer acoustic, no drums, like her listing videos." });
    const brAfter = JSON.parse((await prisma.revisionBrief.findUniqueOrThrow({ where: { id: br.id } })).itemsJson!) as { items: { interpretation?: string; held?: boolean }[] };
    c.ok("James sends it on with his reading attached", jr2.ok && brAfter.items[0].interpretation === "Softer acoustic, no drums, like her listing videos." && !brAfter.items[0].held);
    c.ok("…and it is an editor issue now", (await prisma.revisionIssue.count({ where: { projectId: R.projectId, sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${br.id}:` } } })) === 1);
    c.ok("…the card is open again", (await prisma.smartTask.findUniqueOrThrow({ where: { id: br.taskId! } })).status === "OPEN");
    await setSession({ uid: jordan.id, email: jordan.email, role: "OWNER" });
    await putSetting("review_room", {}, "drill");

    // Round two asking for a new overall direction.
    const T = await mk("Round Two TEST");
    nextItems = [item({ area: "Cuts & content", ask: "Swap the back deck clip", kind: "REFINEMENT", quote: "swap the back deck clip" })];
    await raiseRevision({ projectId: T.projectId, clientId: T.f.clientId, clientName: T.f.clientName, note: "swap the back deck clip", source: "openphone", threadRef: "op-r2-1", requestedBy: { name: "Tess", kind: "TEXT" } });
    const bt1 = await latestBrief(T.projectId);
    c.ok("round one, a clear change: no creative review", !core.creativeReviewOf(bt1.itemsJson) && !(await crTask(bt1.id)));
    await prisma.revisionBrief.update({ where: { id: bt1.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });
    nextItems = [item({ area: "Overall direction", ask: "Make the whole video more upbeat and energetic", kind: "REFINEMENT", quote: "can the whole thing be more upbeat" })];
    await raiseRevision({ projectId: T.projectId, clientId: T.f.clientId, clientName: T.f.clientName, note: "can the whole thing be more upbeat", source: "openphone", threadRef: "op-r2-2", requestedBy: { name: "Tess", kind: "TEXT" } });
    const bt2 = await latestBrief(T.projectId);
    c.ok("round two with a new overall direction goes to creative review", core.creativeReviewOf(bt2.itemsJson)?.reasons.includes("ROUND_TWO_DIRECTION") === true, `${bt2.id === bt1.id ? "same brief" : "new brief"} ${bt2.outputId}/${bt1.outputId} ${bt2.itemsJson}`);

    // ======================================================================
    c.head("6 · a portal note with no model, questions, No change needed, a reopened creative fix");
    const P = await mk("Portal Flat TEST");
    const calls0 = briefPrompts.length;
    const out = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: P.projectId } });
    const pid = await createRevisionBrief({ projectId: P.projectId, source: "portal", text: "• it feels flat", pin: { submissionId: P.sub.id, outputId: out.id, cutKey: `${P.f.deliverableId}:1`, decisionId: null, roundId: null, label: "Video 1" } });
    const pb = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: pid! } });
    c.ok("no model call for a portal note", briefPrompts.length === calls0);
    c.ok("'it feels flat' is held from the editor", core.creativeReviewOf(pb.itemsJson)?.state === "OPEN" && (await prisma.revisionIssue.count({ where: { projectId: P.projectId } })) === 0);
    const nn = await actions.resolveCreativeReviewAction({ briefId: pb.id, mode: "NOT_NEEDED", changes: null, note: "Talked it through on the call: she is happy with it as it is." });
    c.ok("No change needed is recorded with the reason; nothing reaches the editor", nn.ok && (await prisma.revisionIssue.count({ where: { projectId: P.projectId } })) === 0 && core.creativeReviewOf((await prisma.revisionBrief.findUniqueOrThrow({ where: { id: pb.id } })).itemsJson)?.mode === "NOT_NEEDED");

    const Q = await mk("Questions TEST");
    nextItems = [item({ area: "On-screen text", ask: "Add her phone number to the end card", kind: "CORRECTION", quote: "put my number at the end" })];
    nextQuestions = ["Which phone number: the office line or her cell?"];
    await raiseRevision({ projectId: Q.projectId, clientId: Q.f.clientId, clientName: Q.f.clientName, note: "put my number at the end", source: "openphone", threadRef: "op-q-1", requestedBy: { name: "Quinn", kind: "TEXT" } });
    const bq = await latestBrief(Q.projectId);
    const crq = core.creativeReviewOf(bq.itemsJson);
    c.ok("open questions go to creative review, the concrete item to the editor", crq?.reasons.includes("QUESTIONS") === true && crq.taskHeld === false && (await prisma.revisionIssue.count({ where: { projectId: Q.projectId } })) === 1);
    c.ok("the editor does not see the open question", (await getRevisionBriefs(Q.projectId, true)).at(-1)!.questions.length === 0);
    nextQuestions = [];

    // A reviewer reopens a creative ask a version claimed fixed.
    const { reopenIssue } = await import("@/lib/revisionIssues");
    const sub2 = await prisma.reviewSubmission.create({ data: { projectId: X.projectId, deliverableId: X.f.deliverableId!, slot: 1, round: 2, status: "PENDING", source: "upload", fileName: "reel-1-v2.mov", submittedByKey: "kim" } });
    const creativeIssue = await prisma.revisionIssue.create({ data: { projectId: X.projectId, deliverableId: X.f.deliverableId!, slot: 1, sourceKind: "BRIEF_ITEM", sourceId: "manual-x:i9:y", originalText: "warmer colours please", category: "Color & styling", state: "ADDRESSED", addressedInSubmissionId: sub2.id } });
    await reopenIssue(creativeIssue.id, { name: "Jordan Spackman" });
    c.ok("a creative fix reopened after a version claimed it: a creative review task opens", !!(await prisma.smartTask.findUnique({ where: { dedupeKey: `creative-review:issue:${creativeIssue.id}` } })));

    // ======================================================================
    c.head("7 · the screens");
    const panelSrc = read("src/components/review/CreativeReviewPanel.tsx");
    c.ok("the panel offers the three answers in plain words", /Send these changes to the editor/.test(panelSrc) && /Send as is, with my reading/.test(panelSrc) && /No change needed/.test(panelSrc));
    c.ok("the Review Room mounts it at #creative-review", /<CreativeReviewPanel reviews=\{creativeReviews\}/.test(read("src/app/review/[id]/page.tsx")) && /id="creative-review"/.test(panelSrc));
    c.ok("a creative review task opens the Review Room", /creative_review"\s*\n?\s*\? `\/review\/\$\{task\.projectId\}#creative-review`/.test(read("src/components/queue/TaskCard.tsx")));
    c.ok("no em dashes in the editor's placeholder", !/[—–]/.test(core.heldPlaceholder("Jordan Spackman")));

    c.ok("the only thing that left was to the model and Slack", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    quiet.restore();
    c.summary();
    await drill.stop();
    fence.restore();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
