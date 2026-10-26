import "server-only";
// ---------------------------------------------------------------------------
// THE PER-TOPIC SUMMARY, WRITTEN AND KEPT (Oct 26 2026). Step one of Jordan's
// own workflow: read the month's strategy call (and any written answers) once
// and write, for each chosen topic, a detailed summary of what the agent said
// (briefFormat.ts is its shape and instructions). Kept as ContentTopicBrief
// rows, newest current. The office reads it on the topic and on the script
// card; the brief writer (briefWriter.ts) writes the script from it.
//
// A summary is written again only when what it was written from changed: a
// newer transcript of the month's call, or written answers submitted after
// it. A summary the office edited keeps its edit until then.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { runAiJson } from "@/lib/aiRuns";
import { ANSWER_LABEL } from "./sources";
import { BRIEF_INSTRUCTIONS, BRIEF_SCHEMA, topicBriefText, type MonthBrief, type TopicBrief } from "./briefFormat";

export const BRIEF_MODEL = "claude-opus-5-5";
export const BRIEF_PROMPT_VERSION = "topic-brief.v1";
/** The month's call text read in full up to this (a 75-minute call is about 70k characters). */
const CALL_CHARS = 150_000;
const CHOSEN = ["SELECTED", "RECONCILED", "CARRIED"];

type Answer = { question: string; answer: string };
export type ChosenTopic = { id: string; title: string; concept: string | null; pillar: string; how: string; writtenRoute: boolean; overflow: boolean; interviewId: string | null; answers: Answer[]; answersAt: Date | null };
type CallDoc = { callRecordId: string | null; label: string; text: string; at: Date };
export type BriefRow = { id: string; topicId: string | null; route: string; brief: TopicBrief | null; header: Pick<MonthBrief, "opening" | "mainRequest" | "held"> | null; text: string; edited: boolean; editedBy: string | null; createdAt: Date };

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });

/** The month's chosen topics, with how each was chosen and any written answers. */
export async function monthChosenTopics(monthId: string): Promise<{ clientId: string; enrollmentId: string; monthKey: string; topics: ChosenTopic[] }> {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { clientId: true, enrollmentId: true, monthKey: true } });
  if (!month) throw new Error("Month not found.");
  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId, status: { in: CHOSEN }, removedAt: null }, orderBy: [{ rank: "asc" }, { createdAt: "asc" }] });
  const rows = sels.length ? await prisma.contentTopic.findMany({ where: { id: { in: sels.map((s) => s.topicId) } }, select: { id: true, title: true, concept: true, pillar: true, pillarId: true } }) : [];
  const pillarIds = [...new Set(rows.map((r) => r.pillarId).filter((x): x is string => !!x))];
  const pillars = pillarIds.length ? await prisma.contentPillar.findMany({ where: { id: { in: pillarIds } }, select: { id: true, name: true } }) : [];
  const { assembleInterviewInputs } = await import("@/lib/contentInterview");
  const topics: ChosenTopic[] = [];
  for (const sel of sels) {
    const t = rows.find((r) => r.id === sel.topicId);
    if (!t) continue;
    const iv = await prisma.contentInterview.findFirst({ where: { topicId: t.id, monthId, clientId: month.clientId, OR: [{ submittedAt: { not: null } }, { sentWithGapsAt: { not: null } }, { status: "SUBMITTED" }] }, orderBy: { updatedAt: "desc" }, select: { id: true, submittedAt: true, sentWithGapsAt: true, updatedAt: true } });
    let answers: Answer[] = [];
    if (iv) {
      const a = await assembleInterviewInputs(iv.id).catch(() => null);
      if (a && a.clientId === month.clientId) {
        answers = Object.entries(a.input.answers)
          .filter(([, v]) => v && v.text && v.text.trim())
          .map(([k, v]) => ({ question: ANSWER_LABEL[k] ?? k, answer: `${v!.text!.trim()}${v!.followUpText ? ` (${v!.followUpText.trim()})` : ""}`.slice(0, 2000) }));
      }
    }
    topics.push({
      id: t.id, title: t.title, concept: t.concept, pillar: pillars.find((p) => p.id === t.pillarId)?.name ?? t.pillar ?? "",
      how: sel.source === "client" ? `picked in the portal on ${fmtDate(sel.createdAt)}` : sel.source === "call" ? "chosen on the strategy call" : `planned by the office on ${fmtDate(sel.createdAt)}`,
      writtenRoute: sel.answerRoute === "WRITTEN", overflow: sel.overflow, interviewId: answers.length ? iv!.id : null, answers,
      answersAt: answers.length ? iv!.submittedAt ?? iv!.sentWithGapsAt ?? iv!.updatedAt : null,
    });
  }
  return { clientId: month.clientId, enrollmentId: month.enrollmentId, monthKey: month.monthKey, topics };
}

/** The month's strategy call(s), newest confirmed transcript of each, cleaned the way every prompt is. */
async function monthCalls(monthId: string, clientId: string): Promise<CallDoc[]> {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { callRecordId: true, transcriptText: true, monthKey: true, strategyCallAt: true, updatedAt: true } });
  const ids = new Set<string>();
  if (month?.callRecordId) ids.add(month.callRecordId);
  for (const c of await prisma.programCallRecord.findMany({ where: { monthId, clientId }, select: { id: true }, take: 5 })) ids.add(c.id);
  for (const s of await prisma.contentTopicSelection.findMany({ where: { monthId, callRecordId: { not: null } }, select: { callRecordId: true } })) ids.add(s.callRecordId!);
  const calls = ids.size ? await prisma.programCallRecord.findMany({ where: { id: { in: [...ids] }, clientId, status: { notIn: ["CANCELLED", "NO_SHOW"] } }, select: { id: true, scheduledStart: true, callType: true } }) : [];
  const tx = calls.length ? await prisma.programTranscriptSource.findMany({ where: { callRecordId: { in: calls.map((c) => c.id) }, matchState: "CONFIRMED", text: { not: null } }, orderBy: { version: "desc" }, select: { id: true, callRecordId: true, text: true, supersedesId: true, createdAt: true } }) : [];
  const superseded = new Set(tx.map((x) => x.supersedesId).filter(Boolean));
  const { scrubTranscriptForGeneration } = await import("@/lib/contentGeneration");
  const out: CallDoc[] = [];
  const seen = new Set<string>();
  for (const x of tx) {
    if (superseded.has(x.id) || !x.callRecordId || seen.has(x.callRecordId)) continue;
    seen.add(x.callRecordId);
    const call = calls.find((c) => c.id === x.callRecordId);
    const text = (await scrubTranscriptForGeneration(clientId, x.text!)).text;
    out.push({ callRecordId: x.callRecordId, label: `${call?.callType === "BRAND_DISCOVERY" ? "Brand discovery call" : "Strategy call"} of ${call?.scheduledStart ? fmtDate(call.scheduledStart) : "this month"}`, text, at: x.createdAt });
  }
  if (!out.length && month?.transcriptText?.trim()) {
    out.push({ callRecordId: month.callRecordId, label: `Strategy call for ${month.monthKey}${month.strategyCallAt ? ` (${fmtDate(month.strategyCallAt)})` : ""}`, text: (await scrubTranscriptForGeneration(clientId, month.transcriptText)).text, at: month.updatedAt });
  }
  return out;
}

/** Videos this client already has (shared in the last four months, other months): a new script must not repeat one. */
async function recentVideos(clientId: string, monthId: string): Promise<string[]> {
  const since = new Date(Date.now() - 120 * 86_400_000);
  const rows = await prisma.contentScript.findMany({ where: { clientId, historical: false, sharedAt: { gte: since }, NOT: { monthId } }, orderBy: { sharedAt: "desc" }, select: { title: true, sharedAt: true }, take: 25 });
  return rows.map((r) => `${r.title} (shared ${fmtDate(r.sharedAt!)})`);
}

function rowOf(r: { id: string; topicId: string | null; route: string; briefJson: string; editedText: string | null; editedBy: string | null; createdAt: Date }): BriefRow {
  let brief: TopicBrief | null = null;
  let header: BriefRow["header"] = null;
  try {
    const j = JSON.parse(r.briefJson);
    if (r.topicId) brief = j as TopicBrief; else header = { opening: String(j.opening ?? ""), mainRequest: j.mainRequest ?? null, held: Array.isArray(j.held) ? j.held : [] };
  } catch { /* an unreadable row reads as missing */ }
  const text = r.editedText?.trim() || (brief ? topicBriefText(brief) : header ? [header.opening, header.mainRequest ? `Main request: ${header.mainRequest}` : ""].filter(Boolean).join("\n\n") : "");
  return { id: r.id, topicId: r.topicId, route: r.route, brief, header, text, edited: !!r.editedText?.trim(), editedBy: r.editedBy, createdAt: r.createdAt };
}

/** The current summary of each topic in the month, and the month's header (no model call). */
export async function currentBriefs(monthId: string): Promise<{ header: BriefRow | null; byTopic: Map<string, BriefRow> }> {
  const rows = await prisma.contentTopicBrief.findMany({ where: { monthId }, orderBy: { createdAt: "desc" } });
  const byTopic = new Map<string, BriefRow>();
  let header: BriefRow | null = null;
  for (const r of rows) {
    if (!r.topicId) { if (!header) header = rowOf(r); continue; }
    if (!byTopic.has(r.topicId)) byTopic.set(r.topicId, rowOf(r));
  }
  return { header, byTopic };
}

function staleFor(row: BriefRow | undefined, t: ChosenTopic, calls: CallDoc[]): boolean {
  if (!row || !row.brief) return true;
  if (t.answersAt && t.answersAt > row.createdAt) return true;
  if (calls.some((c) => c.at > row.createdAt)) return true;
  return false;
}

export type BuildBriefOpts = { requestedBy: string; unattended: boolean; topicIds?: string[] | null; force?: boolean; deadline?: number | null };

/**
 * Write the summaries the month needs: every chosen topic with none, or whose
 * call or answers are newer than its summary (or the asked-for topics, with
 * force). One model call reads the call(s) once for all of them.
 */
export async function buildMonthBriefs(monthId: string, o: BuildBriefOpts): Promise<{ written: number; topicIds: string[]; runId: string | null }> {
  const m = await monthChosenTopics(monthId);
  const calls = await monthCalls(monthId, m.clientId);
  const cur = await currentBriefs(monthId);
  const want = m.topics.filter((t) => (o.topicIds ? o.topicIds.includes(t.id) : true) && (o.force || staleFor(cur.byTopic.get(t.id), t, calls)));
  if (!want.length) return { written: 0, topicIds: [], runId: null };
  // Nothing to read yet (no call, no answers): no model call; the topics wait.
  if (!calls.length && !want.some((t) => t.answers.length)) return { written: 0, topicIds: [], runId: null };
  const needHeader = !!calls.length && (o.force || !cur.header || calls.some((c) => c.at > cur.header!.createdAt));
  const client = await prisma.client.findUnique({ where: { id: m.clientId }, select: { name: true } });
  const clientName = client?.name ?? "the agent";
  const recent = await recentVideos(m.clientId, monthId);

  let budget = CALL_CHARS;
  const callBlocks = calls.map((c) => {
    const text = c.text.length > budget ? `${c.text.slice(0, Math.max(0, budget))}\n[... the rest of this call is cut for length]` : c.text;
    budget = Math.max(0, budget - text.length);
    return `=== ${c.label} ===\n${text}`;
  });
  const prompt = [
    `AGENT: ${clientName}`,
    `MONTH: ${m.monthKey}`,
    `THE TOPICS CHOSEN THIS MONTH (summarize the ones marked SUMMARIZE; the rest are listed so you can say how each differs):\n${m.topics.map((t) => `- ${want.some((w) => w.id === t.id) ? "SUMMARIZE" : "listed"} | id ${t.id} | "${t.title}"${t.pillar ? ` (${t.pillar})` : ""} | ${t.how}${t.writtenRoute ? ", answering in writing" : ""}${t.overflow ? ", beyond this month's count" : ""}${t.concept ? `\n  Topic description (ours, not the agent's words): ${t.concept.replace(/\s+/g, " ").slice(0, 300)}` : ""}`).join("\n")}`,
    recent.length ? `VIDEOS THIS AGENT ALREADY HAS (shared recently; flag an overlap):\n${recent.map((r) => `- ${r}`).join("\n")}` : "",
    ...want.filter((t) => t.answers.length).map((t) => `=== ${clientName}'s written answers for "${t.title}" (id ${t.id}) ===\n${t.answers.map((a) => `${a.question}: ${a.answer}`).join("\n")}`),
    callBlocks.length ? callBlocks.join("\n\n") : "There is no call transcript for this month: summarize from the written answers only.",
    needHeader ? "Write opening, mainRequest and held for the call." : "Write opening (one line) and leave mainRequest null and held empty: the month's header is already written.",
    `Return one entry in topics for each topic marked SUMMARIZE (${want.length}), with its id exactly.`,
  ].filter(Boolean).join("\n\n");

  const run = await runAiJson<MonthBrief>({
    kind: "script_brief", engine: "writer", model: BRIEF_MODEL, effort: "medium", maxTokens: 4000 + want.length * 1800,
    enrollmentId: m.enrollmentId, clientId: m.clientId, scope: { monthId, topicIds: want.map((t) => t.id), topicBrief: true },
    inputRefs: { callRecordIds: calls.map((c) => c.callRecordId), interviewIds: want.map((t) => t.interviewId).filter(Boolean) },
    promptKey: "script.topic_brief", promptVersion: BRIEF_PROMPT_VERSION, requestedBy: o.requestedBy, unattended: o.unattended,
    dedupeKey: `topic-brief:${monthId}`, system: BRIEF_INSTRUCTIONS, prompt, schema: BRIEF_SCHEMA as unknown as Record<string, unknown>,
    ...(o.deadline ? { timeoutMs: Math.max(30_000, o.deadline - Date.now()) } : {}),
  });
  const out = run.output;
  const callRecordId = calls[0]?.callRecordId ?? null;
  const written: string[] = [];
  for (const t of want) {
    const b = (out.topics ?? []).find((x) => x.topicId === t.id);
    if (!b) continue;
    const brief: TopicBrief = { ...b, topicId: t.id, title: t.title };
    await prisma.contentTopicBrief.create({ data: {
      enrollmentId: m.enrollmentId, clientId: m.clientId, monthId, topicId: t.id, route: t.answers.length && (t.writtenRoute || !calls.length) ? "WRITTEN" : "CALL",
      callRecordId: calls.length ? callRecordId : null, interviewId: t.interviewId, briefJson: JSON.stringify(brief), aiRunId: run.runId, createdBy: o.requestedBy,
    } });
    written.push(t.id);
  }
  if (needHeader) {
    await prisma.contentTopicBrief.create({ data: {
      enrollmentId: m.enrollmentId, clientId: m.clientId, monthId, topicId: null, route: "CALL", callRecordId, interviewId: null,
      briefJson: JSON.stringify({ opening: out.opening, mainRequest: out.mainRequest, held: out.held ?? [] }), aiRunId: run.runId, createdBy: o.requestedBy,
    } });
  }
  return { written: written.length, topicIds: written, runId: run.runId };
}

/** The topic's current summary, written first when it is missing or out of date. */
export async function ensureTopicBrief(topicId: string, monthId: string, o: Omit<BuildBriefOpts, "topicIds" | "force">): Promise<BriefRow | null> {
  const m = await monthChosenTopics(monthId);
  const t = m.topics.find((x) => x.id === topicId);
  const cur = (await currentBriefs(monthId)).byTopic.get(topicId);
  if (!t) return cur ?? null;
  const calls = await monthCalls(monthId, m.clientId);
  if (!staleFor(cur, t, calls)) return cur!;
  if (!calls.length && !t.answers.length) return cur ?? null;
  // The other stale topics ride along: one read of the call for all of them.
  await buildMonthBriefs(monthId, o);
  return (await currentBriefs(monthId)).byTopic.get(topicId) ?? null;
}

/** The office's own wording of a summary (empty text = back to the written one). */
export async function saveBriefEdit(briefId: string, text: string, by: string): Promise<void> {
  const t = text.replace(/[—–]/g, ", ").trim();
  await prisma.contentTopicBrief.update({ where: { id: briefId }, data: t ? { editedText: t.slice(0, 20_000), editedBy: by, editedAt: new Date() } : { editedText: null, editedBy: null, editedAt: null } });
}
