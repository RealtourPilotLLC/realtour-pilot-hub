import "server-only";
import { prisma } from "@/lib/prisma";
import { ackValue, cleanEmailBody, notClientEmailReason, notClientVerdictKey, parseAckValue } from "@/lib/replyQueue";

// ---------------------------------------------------------------------------
// CLIENT COMMUNICATIONS ONLY, THE AI HALF (Jordan, Oct 27 2026 Loom, 38:23:
// "we should have rules ... and then also AI as a fail safe to clean it up").
//
// The rules (replyQueue notClientEmailReason) take the calendar answers, the
// scheduler confirmations, the shipping notices, the pitches and the blasts.
// What they miss, this reads: matched inbound email the rules let through, a
// few at a time from the gmail cron, and stores a "not a client" verdict for
// each row the model is SURE about (AppSetting comms-not-client:<CommLog id>).
// Messages (the walk and the Email tab) hide those rows.
//
// Fail safe, every way round:
//   · no AI key, a refusal, an outage or a bad answer: nothing is stored and
//     the watermark does not move, so the rows are read again next tick;
//   · "unclear", "client", or not sure: nothing is stored (the row shows);
//   · nothing is ever deleted: CommLog is untouched, and a verdict is one
//     AppSetting row a person can remove (the Email tab's hidden fold shows
//     every hidden row with "Show it").
// ---------------------------------------------------------------------------

export const NOT_CLIENT_WATERMARK_KEY = "comms-not-client-watermark";
/** Rows per model call. */
const BATCH = 15;
/** How far back the first pass reads. */
const LOOKBACK_DAYS = 7;

export type NotClientCandidate = { id: string; from: string; subject: string; text: string };
export type NotClientVerdict = { id: string; kind: "client" | "automated" | "marketing" | "solicitation" | "unclear"; sure: boolean; why?: string };
/** The model boundary: a drill passes its own. */
export type NotClientJudge = (rows: NotClientCandidate[]) => Promise<NotClientVerdict[]>;

const SYSTEM = `You sort the inbox of a real estate media agency (photos, videos, content for real estate agents). Each email below was matched to one of the agency's clients by its sender, but some are not the client writing to the agency at all.
For each email, say what it is:
- "client": a person writing to the agency (the agent, their assistant, a co-agent, a homeowner or a vendor writing about a job). Any question, request, feedback, thanks, scheduling or payment talk from a person is "client".
- "automated": a machine notice (calendar invite or answer, booking or scheduler confirmation, shipping or delivery notice, receipt, platform or app notification).
- "marketing": a newsletter, a listing blast, or any mail sent to a list rather than to the agency.
- "solicitation": a cold sales pitch (funding, loans, SEO, leads, services).
- "unclear": you cannot tell.
"sure" is true only when there is no reasonable reading in which a person is writing to the agency. When in doubt, answer "client" or "unclear". Answer every id.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["client", "automated", "marketing", "solicitation", "unclear"] },
          sure: { type: "boolean" },
          why: { type: "string" },
        },
        required: ["id", "kind", "sure"],
      },
    },
  },
  required: ["verdicts"],
};

/** The shipped judge: the fast model, one call per batch. Throws when the AI is unreachable. */
export const aiNotClientJudge: NotClientJudge = async (rows) => {
  const { aiJson, AI_MODELS } = await import("@/lib/integrations/ai");
  const prompt = rows
    .map((r) => `<email id="${r.id}">\nFrom: ${r.from}\nSubject: ${r.subject}\n${r.text}\n</email>`)
    .join("\n\n");
  const out = await aiJson<{ verdicts: NotClientVerdict[] }>({
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
    maxTokens: 900,
    model: AI_MODELS.FAST,
    feature: "comms-not-client",
  });
  return Array.isArray(out?.verdicts) ? out.verdicts : [];
};

/** Does this verdict hide its row? Only a sure, non-client answer does. */
export function hidesRow(v: NotClientVerdict | undefined): boolean {
  return !!v && v.sure === true && (v.kind === "automated" || v.kind === "marketing" || v.kind === "solicitation");
}

/**
 * One pass: the next batch of matched inbound email after the watermark that
 * the rules let through, judged, sure "not a client" verdicts stored, the
 * watermark moved past what was judged. Never throws.
 */
export async function sweepNotClientEmail(opts: { now?: Date; judge?: NotClientJudge; batch?: number } = {}): Promise<{ checked: number; hidden: number; skipped?: string }> {
  const now = opts.now ?? new Date();
  const judge = opts.judge ?? aiNotClientJudge;
  const batch = opts.batch ?? BATCH;
  try {
    const mark = await prisma.appSetting.findUnique({ where: { key: NOT_CLIENT_WATERMARK_KEY }, select: { value: true } });
    const floor = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
    const at = parseAckValue(mark?.value)?.at;
    const since = at && at > floor ? at : floor;
    const rows = await prisma.commLog.findMany({
      where: { channel: "email", direction: { not: "out" }, clientId: { not: null }, occurredAt: { gt: since, lte: now } },
      orderBy: { occurredAt: "asc" },
      take: batch * 4,
      select: { id: true, subject: true, contactName: true, body: true, occurredAt: true },
    });
    if (rows.length === 0) return { checked: 0, hidden: 0, skipped: "nothing new" };
    // What the rules already hide needs no model.
    const todo: typeof rows = [];
    let through = since;
    for (const r of rows) {
      if (todo.length >= batch) break;
      through = r.occurredAt;
      if (notClientEmailReason(r)) continue;
      todo.push(r);
    }
    let hidden = 0;
    if (todo.length) {
      const candidates: NotClientCandidate[] = todo.map((r) => ({
        id: r.id,
        from: (r.contactName ?? "").slice(0, 120),
        subject: (r.subject ?? "").slice(0, 200),
        text: cleanEmailBody(r.body ?? "").slice(0, 900),
      }));
      let verdicts: NotClientVerdict[];
      try {
        verdicts = await judge(candidates);
      } catch (e) {
        // The AI is down: nothing changes, and these rows are read again next tick.
        console.warn("[comms-not-client] the AI check is unavailable; nothing hidden", e instanceof Error ? e.message : e);
        return { checked: 0, hidden: 0, skipped: "ai unavailable" };
      }
      const byId = new Map(verdicts.filter((v) => v && typeof v.id === "string").map((v) => [v.id, v]));
      for (const r of todo) {
        const v = byId.get(r.id);
        if (!hidesRow(v)) continue;
        const key = notClientVerdictKey(r.id);
        const value = ackValue(now, `${v!.kind}${v!.why ? `: ${v!.why.replace(/\s+/g, " ").slice(0, 140)}` : ""}`);
        await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
        hidden++;
      }
    }
    const value = ackValue(through, `checked ${todo.length}`);
    await prisma.appSetting.upsert({ where: { key: NOT_CLIENT_WATERMARK_KEY }, create: { key: NOT_CLIENT_WATERMARK_KEY, value }, update: { value } });
    return { checked: todo.length, hidden };
  } catch (e) {
    console.error("[comms-not-client] sweep failed", e);
    return { checked: 0, hidden: 0, skipped: "error" };
  }
}

/** Undo one verdict: the row shows again (the Email tab's "Show it"). */
export async function clearNotClientVerdict(commLogId: string): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: notClientVerdictKey(commLogId) } });
}
