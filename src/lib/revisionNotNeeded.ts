import "server-only";

import { prisma } from "@/lib/prisma";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// "UNLESS SOMEONE SAYS IT'S NOT NEEDED" (Oct 14 2026).
//
// Jordan: "Texts can go straight to the editor, unless someone says it's not
// needed." A client's ask reaches the editor the moment it lands (raiseRevision
// reopens the video). After that, every new message in the conversation (a
// text either way, or a note in the job's team chat) re-reads the client's
// open asks from the last three days against what has been said since. When
// someone clearly says an ask is not needed (the client: "never mind, it's
// fine"; the team: "no need to change the start frame") and the client has
// not asked for it again after that, the ask is set aside:
//   · its open items are marked not needed, with who said it, in their words;
//   · the editor and the office hear "Not needed after all";
//   · when nothing is left to do on the job, the revision task closes, a video
//     the client's ask reopened goes back to approved (no newer version, no
//     open notes on it), and the job returns to where it was (resolveRevision).
// An explanation alone is not a "not needed" (Kyle telling Georgiana she can
// pick a cover frame, and her asking again: still wanted).
// ---------------------------------------------------------------------------

const WINDOW_MS = 3 * 86_400_000;
const LIVE = ["OPEN", "REOPENED"];

type Verdict = { id: string; needed: "yes" | "no" | "unclear"; saidBy?: string; quote?: string };

let judgeImpl: ((prompt: string) => Promise<{ asks: Verdict[] }>) | null = null;
/** Drills only. */
export function __setNotNeededJudgeForTests(fn: typeof judgeImpl) {
  judgeImpl = fn;
}

const SYSTEM = "You read a real estate media agency's conversation with a client and decide, for each change the client asked for, whether it is still wanted. You output only JSON. No em dashes.";

async function judge(prompt: string): Promise<{ asks: Verdict[] }> {
  if (judgeImpl) return judgeImpl(prompt);
  const { aiJson } = await import("@/lib/integrations/ai");
  return aiJson<{ asks: Verdict[] }>({
    system: SYSTEM,
    prompt,
    schema: { type: "object", properties: { asks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, needed: { type: "string", enum: ["yes", "no", "unclear"] }, saidBy: { type: "string" }, quote: { type: "string" } }, required: ["id", "needed"] } } }, required: ["asks"] },
    maxTokens: 800,
  });
}

// Oct 19 2026: the client's open special requests and scheduling asks
// (lib/clientAsks) are re-read in the same call, over a week: "never mind,
// the lot lines are fine" or "keep the original time" sets them aside too.
const CLIENT_ASK_DAYS = 7;
const ASK_ID = "ask:";

/** Re-read a client's open asks against the conversation since. Never throws. */
export async function reviewAsksAgainstConversation(clientId: string | null | undefined, opts: { now?: Date } = {}): Promise<{ checked: number; withdrawn: string[]; asksWithdrawn?: string[] }> {
  const out = { checked: 0, withdrawn: [] as string[], asksWithdrawn: [] as string[] };
  if (!clientId) return out;
  try {
    const now = opts.now ?? new Date();
    const briefs = await prisma.revisionBrief.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - WINDOW_MS) }, project: { clientId } },
      orderBy: { createdAt: "asc" },
      select: { id: true, projectId: true, createdAt: true, originalText: true, taskId: true, requestedBy: true, project: { select: { title: true } } },
    });
    // The open ClientAsks. A read that fails (the table not there yet) leaves
    // the revision re-read exactly as it was.
    const clientAsks = await import("@/lib/clientAsks").then((m) => m.openAsksForClient(clientId, CLIENT_ASK_DAYS, now)).catch(() => []);
    if (!briefs.length && !clientAsks.length) return out;
    const open = new Map<string, { id: string; originalText: string }[]>();
    for (const b of briefs) {
      const items = await prisma.revisionIssue.findMany({ where: { sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${b.id}:` }, state: { in: LIVE }, duplicateOfId: null }, select: { id: true, originalText: true } });
      if (items.length) open.set(b.id, items);
    }
    const asks = briefs.filter((b) => open.has(b.id));
    if (!asks.length && !clientAsks.length) return out;
    const { recentConversation, convoBlock, etStamp } = await import("@/lib/conversationContext");
    const first = new Date(Math.min(...[...asks.map((a) => a.createdAt.getTime()), ...clientAsks.map((a) => a.askedAt.getTime())]));
    const projectIds = [...new Set([...asks.map((a) => a.projectId), ...clientAsks.map((a) => a.projectId).filter((x): x is string => !!x)])];
    const lines = await recentConversation(clientId, { since: new Date(first.getTime() - 2 * 3600_000), limit: 30, teamChatProjectIds: projectIds });
    // Nothing said since the first ask: nothing to re-read.
    if (!lines.some((l) => l.at.getTime() > first.getTime() + 1000)) return out;
    out.checked = asks.length + clientAsks.length;
    const prompt = [
      "THE CLIENT'S OPEN ASKS (each has an id):",
      ...asks.map((a) => `- id ${a.id} · asked ${etStamp(a.createdAt)}${a.requestedBy ? ` by ${a.requestedBy}` : ""}: "${clip(a.originalText, 400)}"`),
      ...clientAsks.map((a) => `- id ${ASK_ID}${a.id} · asked ${etStamp(a.askedAt)}${a.askedBy ? ` by ${a.askedBy}` : ""}${a.kind === "SCHEDULING" ? " (a scheduling request)" : ""}: "${clip(a.text, 400)}"`),
      "",
      "THE CONVERSATION (oldest first; 'us' and 'team chat' lines are our team):",
      convoBlock(lines),
      "",
      'For each ask id, answer needed: "no" ONLY when, AFTER that ask, someone clearly said this change is not needed or not wanted (the client: "never mind", "it\'s fine as is", "don\'t worry about it"; or our team stated it is not needed or will not be done) AND the client did not ask for it again after that. An explanation, a suggestion or a question from our team is NOT enough on its own (for example "you can pick a different cover frame, does that work?" with no answer, or with the client asking again, stays "yes"). "yes" when it is still wanted, "unclear" when you cannot tell. For "no", give saidBy (who said it) and quote (their exact words, short).',
      'Answer JSON: {"asks":[{"id":"...","needed":"yes|no|unclear","saidBy":"...","quote":"..."}]}',
    ].join("\n");
    const verdicts = (await judge(prompt)).asks ?? [];
    const { markIssueNotApplicable } = await import("@/lib/revisionIssues");
    const touched = new Set<string>();
    for (const v of verdicts) {
      if (v.needed !== "no") continue;
      // A ClientAsk the conversation withdrew: Not needed, with who said so.
      if (typeof v.id === "string" && v.id.startsWith(ASK_ID)) {
        const ask = clientAsks.find((a) => a.id === v.id.slice(ASK_ID.length));
        if (!ask) continue;
        const who = (v.saidBy ?? "Someone").trim().slice(0, 60);
        const quote = clip((v.quote ?? "").trim(), 200);
        const { markNotNeeded } = await import("@/lib/clientAsks");
        const r = await markNotNeeded(ask.id, "Hub (from the conversation)", `${who} said${quote ? ` “${quote}”` : " so"}.`).catch(() => null);
        if (r?.ok) out.asksWithdrawn.push(ask.id);
        continue;
      }
      const brief = asks.find((a) => a.id === v.id);
      if (!brief) continue;
      const who = (v.saidBy ?? "Someone").trim().slice(0, 60);
      const quote = clip((v.quote ?? "").trim(), 200);
      const reason = `Not needed: ${who} said${quote ? ` “${quote}”` : " so"}.`;
      for (const it of open.get(brief.id) ?? []) await markIssueNotApplicable(it.id, reason, { name: "Hub (from the conversation)" });
      out.withdrawn.push(brief.id);
      touched.add(brief.projectId);
      await prisma.activity.create({ data: { projectId: brief.projectId, type: "SYSTEM", body: `Not needed after all: “${clip(brief.originalText, 200)}”. ${reason}` } }).catch(() => {});
      // The editor (and the office) hear it, so nobody works on it.
      try {
        const task = brief.taskId ? await prisma.smartTask.findUnique({ where: { id: brief.taskId }, select: { assignedKey: true } }) : null;
        const { TEAM_MEMBER_EDITOR_KEYS } = await import("@/lib/editors");
        const { notifyInApp } = await import("@/lib/notify");
        const targets: import("@/lib/notify").NotifyTarget[] = [{ roles: ["OWNER", "ADMIN", "CREATIVE_MANAGER"] }];
        if (task?.assignedKey && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(task.assignedKey)) targets.push({ roles: ["EDITOR"], userKey: `editor:${task.assignedKey}`, href: `/edit/${brief.projectId}` });
        await notifyInApp({
          kind: "revision_resolved",
          title: `Not needed after all — ${(brief.project?.title ?? "a job").split(",")[0].trim()}`,
          body: clip(`${clip(brief.originalText, 80)} (${who}${quote ? `: “${quote}”` : ""})`, 140),
          href: `/projects/${brief.projectId}`,
          targets,
          dedupeKey: `not-needed-${brief.id}`,
        });
      } catch { /* the bell is a courtesy; the items already say why */ }
    }
    for (const projectId of touched) await settleIfNothingLeft(projectId);
  } catch (e) {
    console.error("[revision] re-reading asks against the conversation failed", clientId, e);
  }
  return out;
}

/** Nothing left to do on the job: close its revision task, put a client-reopened video back, return the job. */
async function settleIfNothingLeft(projectId: string): Promise<void> {
  const left = await prisma.revisionIssue.count({ where: { projectId, state: { in: ["OPEN", "REOPENED", "ADDRESSED"] }, duplicateOfId: null } });
  if (left) return;
  const { newerVersionOf } = await import("@/lib/cutReopen");
  const reopened = await prisma.reviewSubmission.findMany({ where: { projectId, status: "CHANGES_REQUESTED", clientRequestedAt: { not: null } }, select: { id: true, projectId: true, status: true, round: true, deliverableId: true, slot: true, assetUrl: true } });
  for (const cut of reopened) {
    if (await newerVersionOf(cut)) continue;
    const notes = await prisma.mediaNote.count({ where: { projectId, assetUrl: cut.assetUrl ?? `cut:${cut.id}`, lane: "EDITOR", status: "OPEN", parentId: null } });
    if (notes) continue;
    // A program video's portal ledger was set aside by the reopen; it stays with the office to restore.
    const program = await prisma.contentReviewWindow.count({ where: { submissionId: cut.id } });
    if (program) continue;
    await prisma.reviewSubmission.updateMany({ where: { id: cut.id, status: "CHANGES_REQUESTED" }, data: { status: "APPROVED", completedAt: new Date(), clientRequestedAt: null, clientRequestedBy: null } });
  }
  const tasks = await prisma.smartTask.findMany({ where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true } });
  const { resolveRevisionForTask } = await import("@/lib/comms");
  for (const t of tasks) {
    await prisma.smartTask.update({ where: { id: t.id }, data: { status: "COMPLETED", completedAt: new Date(), summary: "Not needed after all: everything the client asked for was set aside in the conversation." } }).catch(() => {});
    await resolveRevisionForTask(t.id, projectId, "dismissed").catch(() => null);
  }
}
