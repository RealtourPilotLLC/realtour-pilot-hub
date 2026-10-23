import "server-only";
import { prisma } from "@/lib/prisma";
import { clip } from "@/lib/text";
import { isHoldingReply } from "@/lib/holdingReply";

// ---------------------------------------------------------------------------
// AN EMAIL WE ANSWERED STILL FILES ITS ASKS (Oct 22 2026, comms audit M6).
//
// The Gmail scan skips the reply task for mail already answered (the thread
// ends with our reply), and it skipped the ASKS with it: a client's "can we
// move Thursday's shoot to Friday?" that Kyle answered "let me check" from
// his phone inside the 5-minute scan never reached the Scheduling screen, and
// a special request on a job in flight never reached the job.
//
// Now the brain still reads it (for its asks only: no reply task is made) and
// the asks are filed as usual, each marked with our reply:
//   · a SCHEDULING ask our reply settled ("Friday at 10 works, you're
//     booked") is filed DONE, "answered by our email reply";
//   · a holding reply ("let me check") leaves it OPEN, noted;
//   · a SPECIAL REQUEST stays OPEN either way: answering is not doing it, and
//     it holds the job's delivery until it is confirmed on the work.
// With the AI refusing, the scheduling fallback files what it can and the
// message is queued like any other (lib/aiOutage). Never throws.
// ---------------------------------------------------------------------------

export async function fileAnsweredEmailAsks(input: {
  clientId: string;
  clientName: string | null;
  contactName: string | null;
  message: string;
  projectId: string | null;
  replyAt: Date | null;
  mailbox: string;
  threadId: string;
  sentReplyId: string | null;
  inboundExternalId?: string | null;
  /** the sender's own client row, before the fold (lib/teamRouting) */
  senderClientId?: string | null;
}, opts: { retry?: boolean } = {}): Promise<{ filed: string[]; answered: string[]; held: string[]; brain: "answered" | "unavailable" | "off" }> {
  const out = { filed: [] as string[], answered: [] as string[], held: [] as string[], brain: "off" as "answered" | "unavailable" | "off" };
  try {
    const sourceRef = input.inboundExternalId
      ? (await prisma.commLog.findUnique({ where: { externalId: input.inboundExternalId }, select: { id: true } }).catch(() => null))?.id ?? null
      : null;
    const { routeCommTask } = await import("@/lib/brain");
    const { isAiUnavailable } = await import("@/lib/aiOutage");
    let decision: Awaited<ReturnType<typeof routeCommTask>> = null;
    let aiDown = false;
    try {
      decision = await routeCommTask({ channel: "email", message: input.message, clientId: input.clientId, clientName: input.clientName, senderIsClient: true });
    } catch (e) {
      if (!isAiUnavailable(e)) throw e;
      aiDown = true;
    }
    out.brain = decision ? "answered" : aiDown ? "unavailable" : "off";
    if (opts.retry && !decision) return out;
    const { fileAsksFromMessage, fileSchedulingFallback } = await import("@/lib/clientAsks");
    if (decision?.asks?.length) {
      const r = await fileAsksFromMessage({
        clientId: input.clientId, clientName: input.clientName, contactName: input.contactName,
        message: input.message, channel: "email", sourceRef, asks: decision.asks,
        defaultProjectId: decision.projectId ?? input.projectId,
        senderClientId: input.senderClientId ?? null,
      });
      out.filed.push(...r.filed);
    } else if (!decision) {
      const id = await fileSchedulingFallback({ clientId: input.clientId, clientName: input.clientName, contactName: input.contactName, message: input.message, channel: "email", projectId: input.projectId, sourceRef });
      if (id) out.filed.push(id);
      if (aiDown && !opts.retry) {
        // Read again for its asks when the AI answers (never a reply task: we answered it).
        const { queueAiRetry } = await import("@/lib/aiOutage");
        await queueAiRetry({ kind: "answered-asks", input: input as unknown as Record<string, unknown>, firstPass: { revision: true, replyTask: true } }, `answered:${input.mailbox}:${input.threadId}:${input.sentReplyId ?? "-"}`);
      }
    }
    if (!out.filed.length) return out;
    // Our reply, as logged (logSentReply's key), decides "answered" or "holding".
    const reply = input.sentReplyId
      ? await prisma.commLog.findUnique({ where: { externalId: `gmail-sent-${input.threadId}-${input.sentReplyId}` }, select: { body: true, occurredAt: true } }).catch(() => null)
      : null;
    const holding = reply ? isHoldingReply(reply.body) : false;
    const at = reply?.occurredAt ?? input.replyAt ?? new Date();
    for (const id of out.filed) {
      const row = await prisma.clientAsk.findUnique({ where: { id }, select: { kind: true, state: true, historyJson: true } });
      if (!row || row.state !== "OPEN") continue;
      let hist: { at: string; by: string; what: string }[] = [];
      try { hist = row.historyJson ? JSON.parse(row.historyJson) : []; } catch { hist = []; }
      if (!Array.isArray(hist)) hist = [];
      const settles = row.kind === "SCHEDULING" && !!reply && !holding;
      hist.push({
        at: at.toISOString(), by: "our email reply",
        what: holding
          ? `we answered "${clip(reply!.body.replace(/\s+/g, " "), 120)}": a holding reply, so it stays open`
          : settles
            ? `answered by our email reply: "${clip(reply!.body.replace(/\s+/g, " "), 120)}"`
            : "we replied by email before the hub read it; still to do",
      });
      await prisma.clientAsk.update({
        where: { id },
        data: {
          historyJson: JSON.stringify(hist.slice(-30)),
          ...(settles ? { state: "DONE", doneAt: at, doneBy: "our email reply" } : {}),
        },
      });
      (settles ? out.answered : out.held).push(id);
    }
  } catch (e) {
    console.error("[answered asks] filing failed", input.clientId, e);
  }
  return out;
}
