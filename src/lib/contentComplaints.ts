import "server-only";
import { prisma } from "@/lib/prisma";
import { isNegativeSentiment } from "@/lib/comms";

// ---------------------------------------------------------------------------
// COMPLAINTS RECORD THEMSELVES (Oct 27 2026). Jordan, on a content client's
// Settings: "record a complaint, I think they should automatically be
// recorded."
//
// Two ways a content client complains to us that nothing recorded:
//   · on a call: the knowledge curator flags a fact that is a complaint about
//     our service (knowledgeCurator.ts → ClientIssue source "call",
//     sourceRef "ClientFact:<id>");
//   · in a portal message: here. A client message that reads negative
//     (comms.isNegativeSentiment, or the words below) is put to the model
//     once: is this a complaint about OUR service, or a request, a question,
//     a change? Only a complaint at 0.75 or better becomes a ClientIssue
//     (source "portal", sourceRef "ProgramMessage:<id>"), once per message.
// Texts and emails on a delivered job already open one through the feedback
// path (feedback.ts → openIssueFromFeedback). The model being down records
// nothing and the message is asked again on a later run.
// ---------------------------------------------------------------------------

const EXTRA_RE = /\b(not what (i|we) (asked|wanted)|(do not|don'?t) like|wrong|mistake|redo|never (got|received|heard)|no response|ignored|waste|poor|bad|worse|terrible|awful|cancel(ling|ing)?|refund|concern(ed)?|problem|issue)\b/i;
export const looksLikeComplaint = (text: string): boolean => isNegativeSentiment(text) || EXTRA_RE.test(text);

export const COMPLAINT_SYSTEM = `You read ONE message a real estate agent sent Realtour Pilot, the media agency that makes their monthly videos. Decide whether it is a COMPLAINT about our service: work late or missing, poor quality, mistakes, not being listened to, slow replies, billing they think is wrong. A request for a change, a question, feedback that is calm and specific about an edit, or scheduling talk is NOT a complaint on its own. When unsure, it is not a complaint.`;
export const COMPLAINT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["complaint", "title", "confidence", "reason"],
  properties: {
    complaint: { type: "boolean" },
    title: { type: ["string", "null"], description: "A short plain title, for example \"Upset the October videos are late\"; null when not a complaint." },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
} as const;
export const COMPLAINT_MIN_CONFIDENCE = 0.75;

/** The model's answer, made safe. Pure. */
export function acceptComplaint(out: unknown): { title: string; reason: string } | null {
  const o = (out && typeof out === "object" ? out : {}) as { complaint?: unknown; title?: unknown; confidence?: unknown; reason?: unknown };
  const title = typeof o.title === "string" ? o.title.replace(/\s*[‒–—―]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, 160) : "";
  if (o.complaint !== true || title.length < 3 || !(typeof o.confidence === "number" && o.confidence >= COMPLAINT_MIN_CONFIDENCE)) return null;
  return { title, reason: String(o.reason ?? "").slice(0, 300) };
}

export const COMPLAINT_MIN_START_MS = 30_000;

/** The 15-minute sweep over the last two weeks of client portal messages. Behind `ai_runs`. */
export async function sweepMessageComplaints(opts: { now?: Date; max?: number; budgetMs?: number; minStartMs?: number; requestedBy?: string; unattended?: boolean; dryRun?: boolean } = {}): Promise<{ looked: number; asked: number; recorded: number; failed: number; outOfTime: boolean; would?: { messageId: string; clientId: string; text: string }[] }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const left = () => (opts.budgetMs ?? 60_000) - (Date.now() - started);
  const msgs = await prisma.programMessage.findMany({
    where: { authorKind: "CLIENT", createdAt: { gte: new Date(now.getTime() - 14 * 864e5) } },
    orderBy: { createdAt: "desc" }, take: 200,
    select: { id: true, clientId: true, enrollmentId: true, body: true, authorLabel: true, createdAt: true },
  });
  const flagged = msgs.filter((m) => looksLikeComplaint(m.body));
  if (!flagged.length) return { looked: msgs.length, asked: 0, recorded: 0, failed: 0, outOfTime: false };
  const [issues, runs] = await Promise.all([
    prisma.clientIssue.findMany({ where: { sourceRef: { in: flagged.map((m) => `ProgramMessage:${m.id}`) } }, select: { sourceRef: true } }),
    prisma.programAiRun.findMany({ where: { kind: "complaint_check", status: "SUCCEEDED", createdAt: { gte: new Date(now.getTime() - 15 * 864e5) } }, select: { scopeJson: true } }),
  ]);
  const done = new Set([...issues.map((i) => i.sourceRef!.slice("ProgramMessage:".length)), ...runs.map((r) => { try { return (JSON.parse(r.scopeJson ?? "{}") as { messageId?: string }).messageId ?? ""; } catch { return ""; } })]);
  const due = flagged.filter((m) => !done.has(m.id));
  if (opts.dryRun) return { looked: msgs.length, asked: 0, recorded: 0, failed: 0, outOfTime: false, would: due.map((m) => ({ messageId: m.id, clientId: m.clientId, text: m.body.slice(0, 200) })) };
  let asked = 0, recorded = 0, failed = 0, outOfTime = false;
  for (const m of due.slice(0, opts.max ?? 4)) {
    if (left() < (opts.minStartMs ?? COMPLAINT_MIN_START_MS)) { outOfTime = true; break; }
    asked++;
    try {
      const { runAiJson } = await import("@/lib/aiRuns");
      const r = await runAiJson<unknown>({
        kind: "complaint_check", clientId: m.clientId, enrollmentId: m.enrollmentId, scope: { messageId: m.id }, promptKey: "complaint-check", promptVersion: "complaint-check.v1",
        requestedBy: opts.requestedBy ?? "cron", unattended: opts.unattended ?? true,
        system: COMPLAINT_SYSTEM, prompt: `MESSAGE from ${m.authorLabel} (${m.createdAt.toISOString().slice(0, 10)}):\n${m.body.slice(0, 4000)}`,
        schema: COMPLAINT_SCHEMA as unknown as Record<string, unknown>, maxTokens: 400,
      });
      const c = acceptComplaint(r.output);
      if (!c) continue;
      const { createClientIssue } = await import("@/lib/clientIssues");
      const when = m.createdAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
      const made = await createClientIssue({ clientId: m.clientId, title: c.title, whatHappened: `${m.authorLabel} wrote in the portal (${when}): ${m.body}`, source: "portal", sourceRef: `ProgramMessage:${m.id}`, createdBy: "hub" });
      if (made.ok) recorded++;
    } catch (e) {
      failed++;
      if (/switched off/i.test(e instanceof Error ? e.message : String(e))) break;
    }
  }
  return { looked: msgs.length, asked, recorded, failed, outOfTime };
}
