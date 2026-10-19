// ---------------------------------------------------------------------------
// DRILL: every decision and draft reads the conversation; a text goes straight
// to the editor unless someone says it's not needed (Oct 14 2026).
//
// Jordan: "Texts should be analyzed, as well as previous message context any
// time a decision is being made or response is being drafted. Context is
// important across all fronts. Texts can go straight to the editor, unless
// someone says it's not needed."
//
//   1. The conversation reader: both sides, timed to the minute, team chat
//      marked internal, oldest first.
//   2. A client's text: the triage reads the timed conversation and the
//      "already said not needed" rule; it goes straight to the editor (the
//      delivered video reopens); the editor's write-up reads the conversation.
//   3. Our explanation alone is not a "not needed": nothing is withdrawn.
//   4. The client says never mind: the ask is set aside in their words, the
//      editor hears "Not needed after all", the video goes back to approved,
//      the revision closes and the job returns to Delivered.
//   5. Drafts read the conversation: the client-page reply and the
//      photographer's polished text.
//
// ISOLATION: PGlite; the model is answered in-process; nothing else leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const asked: { kind: string; prompt: string }[] = [];
let judgeNeeded: "yes" | "no" = "yes";
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[]; tools?: unknown[] };
    const prompt = String(body.messages?.[0]?.content ?? "");
    if (prompt.includes("THE CLIENT'S OPEN ASKS")) {
      asked.push({ kind: "judge", prompt });
      const ids = [...prompt.matchAll(/- id (\S+) ·/g)].map((m) => m[1]);
      return json({ content: [{ type: "tool_use", name: "emit", input: { asks: ids.map((id) => judgeNeeded === "no" ? { id, needed: "no", saidBy: "Gina", quote: "never mind, the start is fine as is" } : { id, needed: "yes" }) } }] });
    }
    if (prompt.includes("--- WHAT THE CLIENT SAID ---")) {
      asked.push({ kind: "brief", prompt });
      return json({ content: [{ type: "tool_use", name: "emit", input: { headline: "Start the video earlier", items: [{ area: "Other", ask: "Start the video a little earlier so it does not open on her face", detail: "", quote: "" }], keep: [], references: [], questions: [] } }] });
    }
    if (prompt.includes("Decide how we should handle this message")) {
      asked.push({ kind: "triage", prompt });
      const order = /revision\):\n(\S+) \|/.exec(prompt)?.[1] ?? null; // the order the real brain picks from the list
      return json({ content: [{ type: "text", text: JSON.stringify({ actionable: true, projectId: order, title: "Change the video start", detail: "x", priority: "HIGH", mergeIntoTaskId: null, isRevisionRequest: true, flags: [], reason: "client asks to change the delivered video" }) }] });
    }
    if (prompt.includes("Their rough note")) {
      asked.push({ kind: "polish", prompt });
      return json({ content: [{ type: "text", text: "Hi Gina, running about ten minutes behind, see you soon." }] });
    }
    asked.push({ kind: "other", prompt });
    return json({ content: [{ type: "text", text: "Hi Gina, thanks for letting us know. We're on it." }] });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  return null;
});

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7001), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-context" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession } = await import("@/lib/auth/session");
  try {
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("ai", "drill-ai-key-not-real");
    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@context.test", role: "OWNER", status: "ACTIVE" } });
    await prisma.appUser.create({ data: { name: "Kim", email: "kim@context.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const kim = await prisma.teamMember.create({ data: { name: "Kim", email: "kim-tm@context.test", role: "EDITOR" } });
    await setSession({ uid: owner.id, email: owner.email, role: "OWNER" });

    const f = await buildContentMonth(prisma as never, { name: "Gina Context TEST", package: "Starter", project: { status: "DELIVERED" } });
    const projectId = f.projectId!;
    await prisma.client.update({ where: { id: f.clientId }, data: { phone: "6105550188" } });
    await prisma.project.update({ where: { id: projectId }, data: { editorId: kim.id, editorManual: true, deliveredAt: new Date(Date.now() - 2 * 3600_000) } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId, deliverableId: f.deliverableId!, slot: 1, round: 2, status: "APPROVED", source: "upload", fileName: "reel-v2.mov", assetUrl: "/api/review/cut/ctx1/stream", decidedBy: "James Livingston", decidedAt: new Date(Date.now() - 3 * 3600_000), completedAt: new Date(Date.now() - 3 * 3600_000) } });
    const out = await prisma.deliverableOutput.create({ data: { projectId, deliverableId: f.deliverableId!, slot: 1, category: "SOCIAL_REEL", currentSubmissionId: cut.id, approvedSubmissionId: cut.id } });
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { outputId: out.id } });
    const t0 = Date.now() - 60 * 60_000;
    const log = (dir: "in" | "out", body: string, minsAfter: number, who?: string) =>
      prisma.commLog.create({ data: { channel: "text", direction: dir, clientId: f.clientId, clientName: f.clientName, projectId, contactName: who ?? (dir === "out" ? "Us" : "Gina"), body, occurredAt: new Date(t0 + minsAfter * 60_000), source: "openphone" } });

    // ======================================================================
    c.head("1 · the conversation reader");
    await log("out", "Hi Gina! Your reel for 1 Context Ln is ready.", 0);
    await prisma.projectMessage.create({ data: { projectId, authorName: "Kyle", body: "Delivered, she seemed happy on the call.", createdAt: new Date(t0 + 2 * 60_000) } });
    const { recentConversation, convoBlock, etStamp } = await import("@/lib/conversationContext");
    const lines = await recentConversation(f.clientId, { teamChatProjectIds: [projectId] });
    c.ok("both sides, oldest first, team chat marked internal", lines.length === 2 && lines[0].role === "us" && lines[1].who.includes("team chat, internal"));
    c.ok("each line timed to the minute, Eastern", convoBlock(lines).includes(`${etStamp(new Date(t0))} · Us (text): Hi Gina!`), convoBlock(lines));

    // ======================================================================
    c.head("2 · a client's text: the triage reads the timed conversation; straight to the editor");
    const { recordClientCommunication } = await import("@/lib/comms");
    const ask = "Is it possible to not have the start of the video on this frame of my face? Can we rewind it a bit more";
    await log("in", ask, 30);
    await recordClientCommunication({ clientId: f.clientId, clientName: f.clientName, projectId, projectStatus: "DELIVERED", propertyAddress: "1 Context Ln", text: ask, kind: "text", source: "openphone", contactName: "Gina" });
    // The ask landed when she sent it (the drill wrote her text 30 minutes back).
    await prisma.revisionBrief.updateMany({ where: { projectId }, data: { createdAt: new Date(t0 + 30 * 60_000 + 5_000) } });
    const triage = asked.find((a) => a.kind === "triage")?.prompt ?? "";
    c.ok("the triage read the conversation with times", triage.includes(etStamp(new Date(t0))) && triage.includes("Your reel for 1 Context Ln is ready"));
    c.ok("…and the rule: already said not needed, and not asked again, is not a revision", /ALREADY said this change is not needed/.test(triage));
    c.ok("the text went straight to the editor: the delivered video reopened", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id } })).status === "CHANGES_REQUESTED" && (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status === "REVISION");
    const brief = asked.find((a) => a.kind === "brief")?.prompt ?? "";
    c.ok("the editor's write-up read the conversation around the ask (context only)", brief.includes("THE CONVERSATION AROUND IT") && brief.includes("Your reel for 1 Context Ln is ready") && brief.includes("team chat, internal"));
    const issuesOpen = () => prisma.revisionIssue.count({ where: { projectId, state: { in: ["OPEN", "REOPENED"] } } });
    c.ok("Kim has the item", (await issuesOpen()) >= 1, String(await issuesOpen()));

    // ======================================================================
    c.head("3 · our explanation alone is not a 'not needed'");
    const { reviewAsksAgainstConversation } = await import("@/lib/revisionNotNeeded");
    const none = await reviewAsksAgainstConversation(f.clientId);
    c.ok("nothing said since the ask: nothing re-read (no model call)", none.checked === 0 && !asked.some((a) => a.kind === "judge"));
    await log("out", "Hey Gina! When posting on Instagram you can pick a cover frame, and it auto-plays. Does that work for you?", 34, "Kyle (us)");
    judgeNeeded = "yes";
    const r1 = await reviewAsksAgainstConversation(f.clientId);
    const judgePrompt = asked.find((a) => a.kind === "judge")?.prompt ?? "";
    c.ok("re-read after our reply: still wanted, nothing withdrawn", r1.checked === 1 && r1.withdrawn.length === 0 && (await issuesOpen()) >= 1);
    c.ok("…the judge saw the ask, our reply with its time, and the rule that an explanation is not enough", judgePrompt.includes(ask.slice(0, 40)) && judgePrompt.includes("pick a cover frame") && /explanation, a suggestion or a question from our team is NOT enough/.test(judgePrompt));

    // ======================================================================
    c.head("4 · the client says never mind: set aside, editor told, video and job put back");
    await log("in", "Oh ok never mind, the start is fine as is. Thanks!", 40);
    judgeNeeded = "no";
    const r2 = await reviewAsksAgainstConversation(f.clientId);
    c.ok("the ask is withdrawn", r2.withdrawn.length === 1, JSON.stringify(r2));
    const na = await prisma.revisionIssue.findFirst({ where: { projectId, state: "NOT_APPLICABLE" } });
    const ev = na ? await prisma.revisionIssueEvent.findFirst({ where: { issueId: na.id, kind: "NOT_APPLICABLE" } }) : null;
    c.ok("…its item says who said so, in their words", !!ev && /Not needed: Gina said “never mind, the start is fine as is”/.test(ev.note ?? ""), ev?.note ?? "none");
    c.ok("…Kim's bell: Not needed after all", !!(await prisma.notification.findFirst({ where: { userKey: "editor:kim", title: { startsWith: "Not needed after all" } } })));
    const cutAfter = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id } });
    c.ok("…the video is approved again (no newer version, no open notes)", cutAfter.status === "APPROVED" && !!cutAfter.completedAt && cutAfter.clientRequestedAt === null);
    c.ok("…the revision task closed", (await prisma.smartTask.count({ where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } } })) === 0);
    c.ok("…and the job is back to Delivered", (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status === "DELIVERED");

    // ======================================================================
    c.head("5 · drafts read the conversation");
    const { draftClientReply } = await import("@/app/clients/actions");
    await draftClientReply(f.clientId, "text", "Thanks!");
    const reply = asked.filter((a) => a.kind === "other").pop()?.prompt ?? "";
    c.ok("the client-page reply draft read the earlier messages, not only the last one", reply.includes("pick a cover frame") && reply.includes("never mind, the start is fine"), reply.slice(0, 200));
    const { draftClientMessage } = await import("@/app/shoot/actions");
    const pol = await draftClientMessage(projectId, "running 10 min late");
    const polish = asked.find((a) => a.kind === "polish")?.prompt ?? "";
    c.ok("the photographer's polished text read the recent conversation", pol.ok && polish.includes("Recent conversation with this client") && polish.includes("never mind, the start is fine"));

    // ======================================================================
    c.head("6 · the hooks");
    // CHANGED Oct 19 2026 (audit): the client's INBOUND text starts the re-read, not our outbound one.
    c.ok("a text from the client re-reads open asks (not our own outbound text)", /isInboundText\) \{\s*const \{ reviewAsksAgainstConversation \} = await import\("@\/lib\/revisionNotNeeded"\);\s*await reviewAsksAgainstConversation\(clientId\)/.test(fs.readFileSync("src/lib/webhooks/openphone.ts", "utf8")));
    c.ok("a team-chat note can be the 'not needed'", /reviewAsksAgainstConversation\(owner\.clientId\)/.test(fs.readFileSync("src/app/projects/messageActions.ts", "utf8")));
    c.ok("only the model was answered; nothing else left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
