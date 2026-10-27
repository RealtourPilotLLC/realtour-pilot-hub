import "server-only";
import { prisma } from "@/lib/prisma";
import { AI_MODELS, aiJson } from "@/lib/integrations/ai";
import { aiOutageNow, isAiUnavailable } from "@/lib/aiOutage";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { isAckOnlyInbound, isCourtesyMessage } from "@/lib/replyQueue";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { THEME_STORE_KEY, readThemeStore } from "@/lib/ownerTopics";
import { CLIENT_THEMES, EMPTY_THEME_STORE, TEAM_THEMES, WINDOW_DAYS, foldThemeRun, parseThemeReply, type ThemeStore, type ThemeTag } from "@/lib/ownerTopicsCore";

// ---------------------------------------------------------------------------
// WHAT CLIENTS AND THE TEAM KEEP COMPLAINING ABOUT (Jordan's Loom, Oct 27
// 2026: "Recurring client complaint: 3 clients in 7 days about bathroom
// angles, all shoots by James"). The cron's AI job (/api/cron/topics) reads
// the last week's client texts and emails and the team's Slack messages not
// read yet, and asks the fast model for ONE theme per message from a fixed
// list (or "none"). Only the tags are kept (AppSetting
// `owner_complaint_themes`); the grouping into topics, the thresholds and
// the words are lib/ownerTopicsCore's, pure.
//
// FAIL SAFE (his brief: "AI down means nothing changes and nothing is
// deleted"): behind `ai_runs`; not started while the AI account is refusing
// (aiOutage) or without the time to finish; a failed call records its error
// and changes nothing else (foldThemeRun); the dashboard shows the AI topics
// only while the last good run is under a day old. Never a page load: the
// dashboard only reads the store.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
/** One model call a run, at most this many messages in it. */
export const THEMES_BATCH = 40;
export const THEMES_MIN_START_MS = 45_000;

const SYSTEM = `You sort messages for a real estate media agency (photos, videos, scripts for agents) into complaint themes.
For each message return its id, one theme, and a detail of 2 to 5 plain words naming the specific thing (for example "bathroom angles", "dark interior photos", "music choice", "late video").
CLIENT messages may only use: ${Object.keys(CLIENT_THEMES).join(", ")}, or none.
TEAM messages (the agency's own Slack) may only use: ${Object.keys(TEAM_THEMES).join(", ")}, or none.
Use none unless the message complains about, or reports a problem with, the agency's work or service. Questions, thanks, scheduling a new shoot, and neutral updates are none.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, theme: { type: "string" }, detail: { type: "string" } },
        required: ["id", "theme"],
      },
    },
  },
  required: ["items"],
};

async function writeStore(store: ThemeStore): Promise<void> {
  const value = JSON.stringify(store);
  await prisma.appSetting.upsert({ where: { key: THEME_STORE_KEY }, create: { key: THEME_STORE_KEY, value, updatedBy: "ai-cron" }, update: { value, updatedBy: "ai-cron" } });
}

export type ThemesRun =
  | { skipped: string }
  | { read: number; tagged: number; sent: number }
  | { failed: string };

export async function runComplaintThemes(opts: { now?: Date; budgetMs?: number; minStartMs?: number } = {}): Promise<ThemesRun> {
  const now = opts.now ?? new Date();
  if (!(await isAutomationEnabled("ai_runs"))) return { skipped: "ai_runs is off" };
  if ((opts.budgetMs ?? Infinity) < (opts.minStartMs ?? THEMES_MIN_START_MS)) return { skipped: "not enough time left in this run" };
  if (await aiOutageNow().catch(() => null)) return { skipped: "the AI account is refusing calls" };

  const prev = (await readThemeStore()) ?? EMPTY_THEME_STORE;
  const seen = new Set(prev.seen.map((s) => s.id));
  const exclude = await syntheticClientIds().catch(() => [] as string[]);
  const rows = await prisma.commLog.findMany({
    where: {
      direction: "in",
      occurredAt: { gte: new Date(now.getTime() - WINDOW_DAYS * DAY), lte: now },
      OR: [
        { channel: { in: ["text", "email"] }, clientId: { not: null, ...(exclude.length ? { notIn: exclude } : {}) } },
        { channel: "slack" },
      ],
    },
    orderBy: { occurredAt: "desc" },
    take: 400,
    select: { id: true, channel: true, clientId: true, clientName: true, contactName: true, projectId: true, subject: true, body: true, occurredAt: true },
  });
  const fresh = rows.filter((r) => !seen.has(r.id));
  // A thanks, an "ok", an empty line: read, and never sent to the model.
  const trivial = fresh.filter((r) => r.channel !== "slack" && (isCourtesyMessage(r.body ?? "") || isAckOnlyInbound(r.body ?? "", r.channel) || (r.body ?? "").trim().length < 12));
  const trivialIds = new Set(trivial.map((r) => r.id));
  const batch = fresh.filter((r) => !trivialIds.has(r.id) && (r.body ?? "").trim()).slice(0, THEMES_BATCH);
  const readTrivial = trivial.map((r) => ({ id: r.id, at: r.occurredAt.toISOString() }));
  if (!batch.length) {
    await writeStore(foldThemeRun(prev, { ok: true, read: readTrivial, tags: [] }, now));
    return { read: readTrivial.length, tagged: 0, sent: 0 };
  }

  const prompt = batch.map((r) => JSON.stringify({ id: r.id, from: r.channel === "slack" ? "TEAM" : "CLIENT", text: `${r.subject ? `${r.subject}: ` : ""}${(r.body ?? "").replace(/\s+/g, " ").trim()}`.slice(0, 600) })).join("\n");
  let raw: unknown;
  try {
    raw = await aiJson<unknown>({ system: SYSTEM, prompt: `Messages, one per line:\n${prompt}`, schema: SCHEMA, model: AI_MODELS.FAST, maxTokens: 2500, feature: "owner_complaint_themes", timeoutMs: Math.min(60_000, Math.max(20_000, (opts.budgetMs ?? 60_000) - 5_000)) });
  } catch (e) {
    const error = isAiUnavailable(e) ? "The AI account is refusing calls" : (e as Error)?.message ?? "The model call failed";
    await writeStore(foldThemeRun(prev, { ok: false, error }, now)).catch(() => undefined);
    return { failed: error };
  }
  const byId = new Map(batch.map((r) => [r.id, r]));
  const answers = parseThemeReply(raw, batch.map((r) => r.id));
  const tags: ThemeTag[] = [];
  for (const a of answers) {
    const r = byId.get(a.id)!;
    const team = r.channel === "slack";
    // A theme from the other list reads as none (a client can't have an "equipment" complaint).
    if (a.theme === "none" || (team ? !(a.theme in TEAM_THEMES) : !(a.theme in CLIENT_THEMES))) continue;
    tags.push({ commLogId: r.id, channel: r.channel, clientId: r.clientId, client: r.clientName ?? r.contactName ?? null, projectId: r.projectId, theme: a.theme, detail: a.detail, atISO: r.occurredAt.toISOString() });
  }
  // Only what the model answered is marked read: a message it skipped is asked again next run.
  const read = [...readTrivial, ...answers.map((a) => ({ id: a.id, at: byId.get(a.id)!.occurredAt.toISOString() }))];
  await writeStore(foldThemeRun(prev, { ok: true, read, tags }, now));
  return { read: read.length, tagged: tags.length, sent: batch.length };
}
