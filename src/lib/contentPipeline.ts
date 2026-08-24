import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// The Content Program AI pipeline:
//   transcript → extraction (topics / ideas / profile intel / notes)
//   selected topics → scripts (Hook → Re-hook → Build-up → Payoff → CTA)
//   script → AI revision on request
//
// Human-review rule holds throughout: everything lands as INTERNAL_REVIEW for
// Jordan to approve; nothing generated is client-visible on its own.
// ---------------------------------------------------------------------------

// The client context the generators read: strategy + profile + curated info.
// Retrieval, not the whole history (spec §9).
async function clientContext(enrollmentId: string): Promise<string> {
  const e = await prisma.contentEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { clientId: true, package: true },
  });
  if (!e) return "";
  const [client, strategy, profile, intelNotes] = await Promise.all([
    prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true, company: true } }),
    prisma.contentStrategy.findFirst({ where: { enrollmentId, status: "ACTIVE" }, select: { sectionsJson: true } }),
    prisma.agentProfile.findUnique({ where: { clientId: e.clientId } }),
    prisma.contentNote.findMany({ where: { clientId: e.clientId, intelligence: true }, orderBy: { createdAt: "desc" }, take: 12, select: { body: true } }),
  ]);
  const parts: string[] = [];
  parts.push(`AGENT: ${client?.name ?? "?"}${client?.company ? ` (${client.company})` : ""} — ${e.package} plan.`);
  if (strategy?.sectionsJson) {
    try {
      const sec = JSON.parse(strategy.sectionsJson) as Record<string, string>;
      for (const [k, v] of Object.entries(sec)) parts.push(`STRATEGY — ${k}:\n${v}`);
    } catch { /* unreadable strategy JSON → skip */ }
  }
  for (const [label, raw] of [
    ["VOICE & STYLE", profile?.voiceJson], ["CONTENT PREFERENCES", profile?.contentPrefsJson],
    ["STORIES / POVs / KNOWLEDGE", profile?.storiesJson], ["BRAND", profile?.brandJson],
  ] as const) {
    if (!raw) continue;
    try {
      const o = JSON.parse(raw) as Record<string, string>;
      const lines = Object.entries(o).map(([k, v]) => `- ${k}: ${v}`);
      if (lines.length) parts.push(`${label}:\n${lines.join("\n")}`);
    } catch { /* skip */ }
  }
  if (intelNotes.length) parts.push(`TEAM INTELLIGENCE NOTES:\n${intelNotes.map((n) => `- ${n.body}`).join("\n")}`);
  return parts.join("\n\n").slice(0, 24_000);
}

// Topics already used/known — duplicate prevention context (spec §12).
async function topicHistory(enrollmentId: string): Promise<string> {
  const topics = await prisma.contentTopic.findMany({
    where: { enrollmentId },
    orderBy: { createdAt: "desc" },
    take: 80,
    select: { title: true, status: true },
  });
  if (!topics.length) return "none yet";
  return topics.map((t) => `- [${t.status}] ${t.title}`).join("\n");
}


// Quote-heavy transcripts can make the model return list fields as JSON-encoded
// strings — coerce before iterating (Aug 24 backfill failure mode).
function arr<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? (p as T[]) : []; } catch { return []; } }
  return [];
}
// ---------------------------------------------------------------------------
// 1. Transcript extraction
// ---------------------------------------------------------------------------
export type ExtractionResult = {
  confirmedTopics: number; futureIdeas: number; rejected: number; intelNotes: number; todos: number;
};

export async function processMonthTranscript(monthId: string): Promise<ExtractionResult> {
  const month = await prisma.contentMonth.findUnique({
    where: { id: monthId },
    select: { id: true, enrollmentId: true, clientId: true, monthKey: true, transcriptText: true, videosOwed: true, transcriptProcessedAt: true },
  });
  if (!month?.transcriptText) throw new Error("No transcript on this month yet.");
  // ATOMIC CLAIM — the cron and a human's Analyze click can race (Aug 24: two
  // concurrent extractions gave John Collins 6 topics and duplicate scripts).
  // Whoever flips transcriptProcessedAt from null wins; everyone else bows out.
  const claim = await prisma.contentMonth.updateMany({
    where: { id: monthId, transcriptProcessedAt: null },
    data: { transcriptProcessedAt: new Date() },
  });
  if (claim.count === 0 && !month.transcriptProcessedAt) throw new Error("This transcript is already being analyzed.");
  if (claim.count === 0) throw new Error("This transcript was already analyzed.");

  const [context, history] = await Promise.all([clientContext(month.enrollmentId), topicHistory(month.enrollmentId)]);
  const { aiJson } = await import("@/lib/integrations/ai");

  const out = await aiJson<{
    confirmedTopics: { title: string; concept: string; pillar: string | null }[];
    futureIdeas: { title: string; concept: string; pillar: string | null }[];
    rejectedIdeas: string[];
    profileIntel: string[];
    locationNotes: string | null;
    todos: string[];
  }>({
    system:
      "You are processing a monthly content-strategy call transcript for a real-estate agent's video program. " +
      "Identify what was actually AGREED, not everything mentioned:\n" +
      "- confirmedTopics: topics the agent and strategist agreed to film THIS month (title = specific, filmable, hook-ready; concept = the angle in 1-2 sentences, grounded in what the agent SAID).\n" +
      "- futureIdeas: ideas raised but saved for later.\n" +
      "- rejectedIdeas: ideas explicitly declined (titles only).\n" +
      "- profileIntel: NEW durable facts about the agent worth remembering (stories, opinions, preferences, positioning changes) — quote or closely paraphrase the agent; never invent.\n" +
      "- locationNotes: filming location/production decisions if discussed.\n" +
      "- todos: action items either side committed to.\n" +
      `The plan owes ${month.videosOwed} videos this month — do not force the count; report what was agreed.\n` +
      "Topics already in this agent's history (avoid lazy duplicates; a fresh angle on an old theme is fine):\n" + history,
    prompt: `AGENT CONTEXT:\n${context}\n\nTRANSCRIPT:\n${month.transcriptText.slice(0, 150_000)}`,
    maxTokens: 8000,
    schema: {
      type: "object",
      properties: {
        confirmedTopics: { type: "array", items: { type: "object", properties: { title: { type: "string" }, concept: { type: "string" }, pillar: { type: ["string", "null"] } }, required: ["title", "concept"] } },
        futureIdeas: { type: "array", items: { type: "object", properties: { title: { type: "string" }, concept: { type: "string" }, pillar: { type: ["string", "null"] } }, required: ["title", "concept"] } },
        rejectedIdeas: { type: "array", items: { type: "string" } },
        profileIntel: { type: "array", items: { type: "string" } },
        locationNotes: { type: ["string", "null"] },
        todos: { type: "array", items: { type: "string" } },
      },
      required: ["confirmedTopics", "futureIdeas", "rejectedIdeas", "profileIntel", "todos"],
    },
  });

  // Confirmed → SELECTED on the month (skip titles that already exist there).
  const existing = new Set(
    (await prisma.contentTopic.findMany({ where: { monthId }, select: { title: true } })).map((t) => t.title.toLowerCase()),
  );
  let confirmed = 0;
  for (const t of arr<{ title: string; concept: string; pillar: string | null }>(out.confirmedTopics)) {
    if (!t.title?.trim() || existing.has(t.title.toLowerCase())) continue;
    await prisma.contentTopic.create({
      data: {
        enrollmentId: month.enrollmentId, clientId: month.clientId, monthId,
        title: t.title.trim().slice(0, 200), concept: t.concept?.trim().slice(0, 2000) || null,
        pillar: t.pillar?.trim().slice(0, 120) || null,
        status: "SELECTED", source: "strategy_call",
      },
    });
    confirmed++;
  }
  // Future ideas → the bank.
  let future = 0;
  for (const t of arr<{ title: string; concept: string; pillar: string | null }>(out.futureIdeas)) {
    if (!t.title?.trim()) continue;
    await prisma.contentTopic.create({
      data: {
        enrollmentId: month.enrollmentId, clientId: month.clientId,
        title: t.title.trim().slice(0, 200), concept: t.concept?.trim().slice(0, 2000) || null,
        pillar: t.pillar?.trim().slice(0, 120) || null,
        status: "SAVED", source: "strategy_call",
      },
    });
    future++;
  }
  // Rejected ideas → recorded so they aren't re-pitched.
  for (const title of arr<string>(out.rejectedIdeas)) {
    if (!title?.trim()) continue;
    await prisma.contentTopic.create({
      data: {
        enrollmentId: month.enrollmentId, clientId: month.clientId,
        title: title.trim().slice(0, 200), status: "REJECTED", source: "strategy_call",
      },
    });
  }
  // Profile intel → PROPOSED as intelligence notes (review happens by reading
  // them — they feed AI context but never silently rewrite the profile, §17).
  let intel = 0;
  for (const fact of arr<string>(out.profileIntel)) {
    if (!fact?.trim()) continue;
    await prisma.contentNote.create({
      data: { clientId: month.clientId, body: `From the ${month.monthKey} strategy call: ${fact.trim().slice(0, 2000)}`, intelligence: true, authorName: "AI (call extraction)" },
    });
    intel++;
  }
  // Location + todos → a plain month note the workspace shows.
  const extras: string[] = [];
  if (out.locationNotes?.trim()) extras.push(`Location/production: ${out.locationNotes.trim()}`);
  const todoList = arr<string>(out.todos);
  if (todoList.length) extras.push(`To-dos:\n${todoList.map((t) => `• ${t}`).join("\n")}`);
  if (extras.length) {
    await prisma.contentMonth.update({ where: { id: monthId }, data: { notes: extras.join("\n\n").slice(0, 8000) } });
  }
  return { confirmedTopics: confirmed, futureIdeas: future, rejected: arr<string>(out.rejectedIdeas).length, intelNotes: intel, todos: todoList.length };
}

// ---------------------------------------------------------------------------
// 2. Script generation — Hook → Re-hook → Build-up → Payoff → CTA/Close.
// One script per SELECTED topic that doesn't have one yet. INTERNAL_REVIEW.
// ---------------------------------------------------------------------------
// Jordan's house script format, learned from his real documents (e.g.
// "Bernadette Rabel August 2026 Social Content Scripts"): numbered title,
// Category line, then HOOK / TALKING POINT 1 - RE-HOOK / TALKING POINT 2 -
// SETUP / TALKING POINT 3 - PAYOFF / CALLBACK / CTA — written in short
// spoken-breath lines, with $[PRICE]-style placeholders for numbers nobody
// has confirmed yet, and an optional "Production note:" for filming needs.
const SCRIPT_SYSTEM = (context: string) =>
  "You write short-form video scripts (20-35 seconds spoken) for a real-estate agent's personal-branding program, in Realtour Pilot's exact house format. " +
  "Sections, in order: " +
  "HOOK (scroll-stopping opener — curiosity, tension, contrast, or a strong POV; never 'Hey guys', 'Did you know', 'Here are three tips'), " +
  "TALKING POINT 1 - RE-HOOK (deepen the curiosity — escalate, tease the real answer, challenge an assumption; NOT fact #1), " +
  "TALKING POINT 2 - SETUP (the context/story/reasoning that develops the argument), " +
  "TALKING POINT 3 - PAYOFF (deliver what the hook promised — the insight or lesson), " +
  "CALLBACK / CTA (finish intentionally — callback to the hook, takeaway, conversation starter, or soft CTA; no hard sell unless the context demands it). " +
  "WRITING STYLE: short spoken-breath lines with a line break after each phrase — the way a person actually talks to camera — not paragraphs. " +
  "Use bracketed placeholders like $[PRICE], $[PAYMENT], [NEIGHBORHOOD] for any figure or detail that must be confirmed before filming, and mention it in productionIdeas. " +
  "Voice: conversational, confident, direct, specific, easy to say ALOUD — the agent's strongest self, never a copywriter. " +
  "Ground every claim in the agent's real context below; NEVER invent stories, opinions, or numbers. Clarity beats cleverness. " +
  "\n\nAGENT CONTEXT:\n" + context;

const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string" }, rehook: { type: "string" }, buildup: { type: "string" },
    payoff: { type: "string" }, cta: { type: "string" },
    productionIdeas: { type: "array", items: { type: "string" }, description: "optional B-roll/location/overlay ideas, not spoken" },
  },
  required: ["hook", "rehook", "buildup", "payoff", "cta"],
} as const;

type ScriptSections = { hook: string; rehook: string; buildup: string; payoff: string; cta: string; productionIdeas?: string[] };

// Keep an existing "Category:" line through AI revisions.
function categoryOf(body: string): string | null {
  const m = body.match(/^Category:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// Render with the house labels so a draft reads exactly like Jordan's own
// script documents.
function sectionsToBody(s: ScriptSections, category?: string | null): string {
  const parts: string[] = [];
  if (category) parts.push(`Category: ${category}`);
  const pairs: [string, string][] = [
    ["HOOK", s.hook], ["TALKING POINT 1 - RE-HOOK", s.rehook], ["TALKING POINT 2 - SETUP", s.buildup],
    ["TALKING POINT 3 - PAYOFF", s.payoff], ["CALLBACK / CTA", s.cta],
  ];
  for (const [label, text] of pairs) if (text?.trim()) parts.push(`${label}\n${text.trim()}`);
  return parts.join("\n\n");
}

export async function generateScriptsForMonth(monthId: string): Promise<{ generated: number; skipped: number }> {
  const month = await prisma.contentMonth.findUnique({
    where: { id: monthId },
    select: { id: true, enrollmentId: true, clientId: true },
  });
  if (!month) throw new Error("Month not found.");
  const topics = await prisma.contentTopic.findMany({
    where: { monthId, status: "SELECTED" },
    select: { id: true, title: true, concept: true, pillar: true },
  });
  if (!topics.length) return { generated: 0, skipped: 0 };
  const scripted = new Set(
    (await prisma.contentScript.findMany({ where: { monthId, topicId: { not: null } }, select: { topicId: true } })).map((s) => s.topicId),
  );
  const context = await clientContext(month.enrollmentId);
  const { aiJson } = await import("@/lib/integrations/ai");

  let generated = 0, skipped = 0;
  for (const t of topics) {
    if (scripted.has(t.id)) { skipped++; continue; }
    // Claim the topic atomically — a concurrent generator sees count 0 and
    // skips, so a topic can never get two scripts.
    const claim = await prisma.contentTopic.updateMany({
      where: { id: t.id, status: "SELECTED" },
      data: { status: "SCRIPTED" },
    });
    if (claim.count === 0) { skipped++; continue; }
    try {
      const s = await aiJson<ScriptSections>({
        system: SCRIPT_SYSTEM(context),
        prompt: `TOPIC: ${t.title}\n${t.concept ? `ANGLE: ${t.concept}\n` : ""}${t.pillar ? `PILLAR: ${t.pillar}\n` : ""}\nWrite the script.`,
        maxTokens: 2500,
        schema: SCRIPT_SCHEMA as unknown as Record<string, unknown>,
      });
      await prisma.contentScript.create({
        data: {
          enrollmentId: month.enrollmentId, clientId: month.clientId, monthId, topicId: t.id,
          title: t.title,
          body: sectionsToBody(s, t.pillar),
          sectionsJson: JSON.stringify({ hook: s.hook, rehook: s.rehook, buildup: s.buildup, payoff: s.payoff, cta: s.cta }),
          productionJson: s.productionIdeas?.length ? JSON.stringify(s.productionIdeas.slice(0, 10)) : null,
          status: "INTERNAL_REVIEW",
          source: "ai",
        },
      });
      generated++;
    } catch {
      // Give the topic back so a retry can script it.
      await prisma.contentTopic.update({ where: { id: t.id }, data: { status: "SELECTED" } }).catch(() => {});
      skipped++;
    }
  }
  return { generated, skipped };
}

// ---------------------------------------------------------------------------
// 3. AI revision — regenerate a script following the reviewer's instruction,
// keeping everything else about the voice/context. Old body preserved in the
// note trail by the caller if needed; sections replaced in place (status stays
// INTERNAL_REVIEW until approved).
// ---------------------------------------------------------------------------
export async function reviseScriptWithInstructions(scriptId: string, instructions: string): Promise<void> {
  const script = await prisma.contentScript.findUnique({
    where: { id: scriptId },
    select: { id: true, enrollmentId: true, title: true, body: true, sectionsJson: true },
  });
  if (!script) throw new Error("Script not found.");
  const context = await clientContext(script.enrollmentId);
  const { aiJson } = await import("@/lib/integrations/ai");
  const s = await aiJson<ScriptSections>({
    system: SCRIPT_SYSTEM(context),
    prompt:
      `Here is the current script for "${script.title}":\n\n${script.body}\n\n` +
      `REVISION REQUEST from the reviewer: ${instructions.trim().slice(0, 2000)}\n\n` +
      "Rewrite the script applying the request. Keep what already works; change only what the request implies.",
    maxTokens: 2500,
    schema: SCRIPT_SCHEMA as unknown as Record<string, unknown>,
  });
  await prisma.contentScript.update({
    where: { id: scriptId },
    data: {
      body: sectionsToBody(s, categoryOf(script.body)),
      sectionsJson: JSON.stringify({ hook: s.hook, rehook: s.rehook, buildup: s.buildup, payoff: s.payoff, cta: s.cta }),
      status: "INTERNAL_REVIEW",
    },
  });
}
