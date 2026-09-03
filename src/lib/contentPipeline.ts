import "server-only";
import { prisma } from "@/lib/prisma";
import { customerNote } from "@/lib/clientNotes";

// ---------------------------------------------------------------------------
// The Content Program AI pipeline:
//   transcript → extraction (topics / ideas / profile intel / notes)
//   selected topics → scripts (HOOK → TALKING POINT 1-3 → CALL TO ACTION)
//   script → AI revision on request
//
// Human-review rule holds throughout: everything lands as INTERNAL_REVIEW for
// Jordan to approve; nothing generated is client-visible on its own.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// THE CONTENT RULES — injected into every prompt that creates topics, scripts,
// or profile intel. Born from a real failure (Aug 24): the bank recommended
// Ashley "Why I'd Rather Sell Three $350k Houses Than One $1M House" — pulled
// straight from his call, but it undercuts his positioning and price-point
// audience — and his private brokerage plans were fair game for extraction.
// ---------------------------------------------------------------------------
export const CONTENT_RULES =
  "NON-NEGOTIABLE CONTENT RULES:\n" +
  "1. STRATEGIC FIT — every topic/script must actively grow THIS agent's brand with THEIR stated target audience and " +
  "positioning (in the strategy above). An idea the agent mentioned on a call is NOT automatically a good topic: if it " +
  "would undercut their positioning, alienate part of their market, cap their price point, disparage a segment they " +
  "serve, or read as complaining/inside-baseball, DO NOT produce it — no matter who suggested it.\n" +
  "2. THE FOUR OUTCOMES — every topic/script must clearly build at least two of Trust, Credibility, Value, " +
  "Entertainment for the agent's AUDIENCE (home buyers/sellers — not other agents), with Trust and Credibility " +
  "preferred. If you cannot say plainly which outcomes it builds and for whom, it does not qualify.\n" +
  "3. CONFIDENTIALITY — anything the agent frames as private ('between us', 'off the record', 'don't share this yet') " +
  "and categorically: unannounced brokerage moves or exits, internal business plans, recruiting, financial or legal or " +
  "personal disclosures, negative remarks about named people or companies — must NEVER appear in a topic, script, " +
  "hook, or anything a client or the public could see. Such facts may only be recorded as internal profile intel " +
  "prefixed '[CONFIDENTIAL]'.";

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
    prisma.contentNote.findMany({
      // [CONFIDENTIAL] intel stays internal — it must never reach a prompt
      // that writes topics or scripts (rule 3).
      where: { clientId: e.clientId, intelligence: true, NOT: { body: { startsWith: "[CONFIDENTIAL" } } },
      orderBy: { createdAt: "desc" }, take: 12, select: { body: true },
    }),
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
      // Profiles built before the filter above still carry confidential lines,
      // and a human can paste one into a profile box at any time. Drop them
      // here too, so no route into a generation prompt is left open.
      const lines = Object.entries(o)
        .filter(([, v]) => !/^\s*\[CONFIDENTIAL/i.test(String(v ?? "")))
        .map(([k, v]) => `- ${k}: ${v}`);
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
    select: { id: true, enrollmentId: true, clientId: true, monthKey: true, transcriptText: true, videosOwed: true, transcriptProcessedAt: true, strategyCallAt: true },
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

  // From here on the claim is OURS — an AI hiccup must RELEASE it, or the month
  // is permanently marked "analyzed" over zero topics with no way to retry
  // (audit Aug 25: the card said "topics and scripts are below" over nothing).
  try {
  const [context, history] = await Promise.all([clientContext(month.enrollmentId), topicHistory(month.enrollmentId)]);
  const { aiJson } = await import("@/lib/integrations/ai");

  const out = await aiJson<{
    plannedMonthKey: string | null;
    confirmedTopics: { title: string; concept: string; pillar: string | null }[];
    futureIdeas: { title: string; concept: string; pillar: string | null }[];
    rejectedIdeas: string[];
    profileIntel: string[];
    locationNotes: string | null;
    todos: string[];
  }>({
    system:
      "You are processing a call transcript for a real-estate agent's monthly video program. " +
      "FIRST judge what kind of call this is. If it is NOT a monthly content-planning session (e.g. a business proposal, " +
      "a check-in, a review of finished videos), set plannedMonthKey to null and confirmedTopics to [] — file any content " +
      "ideas that came up under futureIdeas instead. " +
      "If it IS a planning session, set plannedMonthKey to the month the topics are FOR: a call in the last third of a month " +
      "usually plans the NEXT month (Jordan's rhythm — e.g. a July 27 call plans August). Use the call date given in the prompt.\n" +
      "Identify what was actually AGREED, not everything mentioned:\n" +
      "- confirmedTopics: topics the agent and strategist agreed to film THIS month (title = specific, filmable, hook-ready; concept = the angle in 1-2 sentences, grounded in what the agent SAID).\n" +
      "- futureIdeas: ideas raised but saved for later.\n" +
      "- rejectedIdeas: ideas explicitly declined (titles only).\n" +
      "- profileIntel: NEW durable facts about the agent worth remembering (stories, opinions, preferences, positioning changes) — quote or closely paraphrase the agent; never invent. Anything told in confidence or commercially sensitive (rule 3) MUST be prefixed '[CONFIDENTIAL] '.\n" +
      "- locationNotes: filming location/production decisions if discussed.\n" +
      "- todos: action items either side committed to.\n" +
      `The plan owes ${month.videosOwed} videos this month — do not force the count; report what was agreed.\n` +
      CONTENT_RULES + "\n" +
      "Topics already in this agent's history (avoid lazy duplicates; a fresh angle on an old theme is fine):\n" + history,
    prompt: `CALL DATE: ${month.strategyCallAt ? month.strategyCallAt.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" }) : `sometime in ${month.monthKey}`}\n\nAGENT CONTEXT:\n${context}\n\nTRANSCRIPT:\n${month.transcriptText.slice(0, 150_000)}`,
    maxTokens: 8000,
    schema: {
      type: "object",
      properties: {
        plannedMonthKey: { type: ["string", "null"], description: "YYYY-MM the confirmed topics are FOR, or null if this isn't a planning call" },
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

  // Confirmed topics land on the month the call PLANNED — an end-of-month call
  // plans the NEXT month (Aug 24: Bernadette's Jul 27 call planned August, and
  // her Aug 20 tourism-proposal call confirmed nothing). Fall back to the
  // call's own month when the model can't tell.
  let targetMonthId = monthId;
  const planned = typeof out.plannedMonthKey === "string" && /^\d{4}-\d{2}$/.test(out.plannedMonthKey) ? out.plannedMonthKey : null;
  if (planned && planned !== month.monthKey) {
    const { etMonthKey } = await import("@/lib/contentProgram");
    const enr = await prisma.contentEnrollment.findUnique({
      where: { id: month.enrollmentId },
      select: { videosPerMonth: true, strategyCallRequired: true },
    });
    const target = await prisma.contentMonth.upsert({
      where: { enrollmentId_monthKey: { enrollmentId: month.enrollmentId, monthKey: planned } },
      create: {
        enrollmentId: month.enrollmentId, clientId: month.clientId, monthKey: planned,
        videosOwed: enr?.videosPerMonth ?? 4,
        strategyCallStatus: "COMPLETED", // this call WAS its planning call
        ...(planned < etMonthKey() ? { historical: true, status: "IMPORTED" } : {}),
      },
      update: {},
      select: { id: true },
    });
    targetMonthId = target.id;
  }
  const existing = new Set(
    (await prisma.contentTopic.findMany({ where: { monthId: targetMonthId }, select: { title: true } })).map((t) => t.title.toLowerCase()),
  );
  // Re-runs (the Re-analyze button / a replaced transcript) must not multiply
  // bank ideas, rejected records, or intel notes — dedupe against EVERYTHING
  // this enrollment already holds (review finding).
  const allTitles = new Set(
    (await prisma.contentTopic.findMany({ where: { enrollmentId: month.enrollmentId }, select: { title: true } })).map((t) => t.title.toLowerCase()),
  );
  const noteBodies = new Set(
    (await prisma.contentNote.findMany({ where: { clientId: month.clientId, intelligence: true }, select: { body: true } })).map((n) => n.body.toLowerCase()),
  );
  let confirmed = 0;
  for (const t of arr<{ title: string; concept: string; pillar: string | null }>(out.confirmedTopics)) {
    if (!t.title?.trim() || existing.has(t.title.toLowerCase())) continue;
    await prisma.contentTopic.create({
      data: {
        enrollmentId: month.enrollmentId, clientId: month.clientId, monthId: targetMonthId,
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
    if (!t.title?.trim() || allTitles.has(t.title.trim().toLowerCase())) continue;
    allTitles.add(t.title.trim().toLowerCase());
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
    if (!title?.trim() || allTitles.has(title.trim().toLowerCase())) continue;
    allTitles.add(title.trim().toLowerCase());
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
    const body = `From the ${month.monthKey} strategy call: ${fact.trim().slice(0, 2000)}`;
    if (noteBodies.has(body.toLowerCase())) continue;
    noteBodies.add(body.toLowerCase());
    await prisma.contentNote.create({
      data: { clientId: month.clientId, body, intelligence: true, authorName: "AI (call extraction)" },
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
  } catch (e) {
    // Release the claim so the month can be analyzed again — a stamped-but-
    // empty month was unrecoverable from the UI (audit Aug 25). CAPPED at
    // three failures: after that the stamp STAYS so a deterministically
    // failing transcript can't become an hourly AI retry loop (review
    // finding); the Re-analyze button still force-clears for a human retry.
    try {
      const key = `transcript-fails-${monthId}`;
      const row = await prisma.appSetting.findUnique({ where: { key } });
      const fails = Number(row?.value ?? 0) + 1;
      await prisma.appSetting.upsert({ where: { key }, create: { key, value: String(fails) }, update: { value: String(fails) } });
      if (fails < 3) {
        await prisma.contentMonth.updateMany({ where: { id: monthId }, data: { transcriptProcessedAt: null } });
      }
    } catch { /* releasing is best-effort */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 2. Script generation — HOOK → TALKING POINT 1-3 → CALL TO ACTION.
// One script per SELECTED topic that doesn't have one yet. INTERNAL_REVIEW.
// ---------------------------------------------------------------------------
// The house format is Jordan's own current deliverable ("Ashley Brunner
// Scripts - Session 1", Aug 2026 — his stated gold standard): a Category
// line, then HOOK / TALKING POINT 1 / TALKING POINT 2 / TALKING POINT 3 /
// CALL TO ACTION with those PLAIN labels, each section 1-3 short
// spoken-breath lines, concrete specifics and quoted client objections, and
// a CTA that is one direct instruction. The re-hook → setup → payoff
// dramaturgy still steers WHAT each talking point does — it just never
// appears in the labels the agent and editor read.
const SCRIPT_SYSTEM = (context: string) =>
  "You write short-form video scripts (20-35 seconds spoken) for a real-estate agent's personal-branding program, in Realtour Pilot's exact house format. " +
  "Sections, in order, using these EXACT plain labels: HOOK, TALKING POINT 1, TALKING POINT 2, TALKING POINT 3, CALL TO ACTION. " +
  "What each section must do: " +
  "HOOK — scroll-stopping opener: curiosity, tension, contrast, or a strong POV (never 'Hey guys', 'Did you know', 'Here are three tips'). " +
  "TALKING POINT 1 — deepen the hook: name the assumption, or quote what people actually say ('Most sellers tell me: ...'); do NOT give the answer yet. " +
  "TALKING POINT 2 — develop it: the reasoning, story, or specifics that earn the payoff. " +
  "TALKING POINT 3 — pay off what the hook promised: the insight, the reframe, the lesson. " +
  "CALL TO ACTION — ONE direct next step in the agent's own voice ('call me before you start packing', 'let's talk'); no hard sell unless the context demands it. " +
  "Also return category: a 2-4 word content category for THIS script, e.g. 'Seller Strategy', 'Pre-Listing Strategy', 'Negotiation & Multiple Offers', 'Personal Brand'. " +
  "LENGTH IS A HARD RULE: the whole script must speak in 20-35 seconds — 70 to 110 words TOTAL across all sections. " +
  "HOOK is 1-2 lines. Each TALKING POINT is 1-3 lines. CALL TO ACTION is 1-2 lines. " +
  "If the material doesn't fit, CUT IDEAS, not words-per-line — one sharp point per talking point, never a list of them. Jordan rejects long scripts on sight. " +
  "WRITING STYLE: short spoken-breath lines with a line break after each phrase — the way a person actually talks to camera, never paragraphs. " +
  "Be concrete: real numbers, real objects, quoted objections — take the RHYTHM of examples like '17 offers on one house' or 'paint. trim. curtains.', never the facts. " +
  "Use bracketed placeholders like $[PRICE], $[PAYMENT], [NEIGHBORHOOD] for any figure or detail that must be confirmed before filming, and mention it in productionIdeas. " +
  "Voice: conversational, confident, direct, specific, easy to say ALOUD — the agent's strongest self, never a copywriter. " +
  "Ground every claim in the agent's real context below; NEVER invent stories, opinions, or numbers. Clarity beats cleverness. " +
  "\n" + CONTENT_RULES +
  "\n\nAGENT CONTEXT:\n" + context;

const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", description: "2-4 word content category for this script, e.g. 'Seller Strategy'" },
    hook: { type: "string" }, point1: { type: "string" }, point2: { type: "string" },
    point3: { type: "string" }, cta: { type: "string" },
    productionIdeas: { type: "array", items: { type: "string" }, description: "optional B-roll/location/overlay ideas, not spoken" },
  },
  required: ["category", "hook", "point1", "point2", "point3", "cta"],
} as const;

type ScriptSections = { category?: string; hook: string; point1: string; point2: string; point3: string; cta: string; productionIdeas?: string[] };

// Keep an existing "Category:" line through AI revisions.
function categoryOf(body: string): string | null {
  const m = body.match(/^Category:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// Render with the house labels so a draft reads exactly like Jordan's own
// script documents. The AI's script-specific category leads; fallbackCategory
// (the topic's pillar, or a preserved Category line on revision) fills in.
function sectionsToBody(s: ScriptSections, fallbackCategory?: string | null): string {
  const parts: string[] = [];
  const cat = (s.category ?? "").trim() || (fallbackCategory ?? "").trim();
  if (cat) parts.push(`Category: ${cat}`);
  const pairs: [string, string][] = [
    ["HOOK", s.hook], ["TALKING POINT 1", s.point1], ["TALKING POINT 2", s.point2],
    ["TALKING POINT 3", s.point3], ["CALL TO ACTION", s.cta],
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
          sectionsJson: JSON.stringify({ category: s.category, hook: s.hook, point1: s.point1, point2: s.point2, point3: s.point3, cta: s.cta }),
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
      // A reviewer's revision shouldn't silently recategorise the script — the
      // existing Category line wins; the AI's only fills a blank.
      body: sectionsToBody({ ...s, category: categoryOf(script.body) ?? s.category }),
      sectionsJson: JSON.stringify({ category: s.category, hook: s.hook, point1: s.point1, point2: s.point2, point3: s.point3, cta: s.cta }),
      status: "INTERNAL_REVIEW",
    },
  });
}

// ---------------------------------------------------------------------------
// 4. Topic bank seeding (spec §10) — built from the client's CONTENT STRATEGY
// and the ideas raised on calls, against their full topic history so nothing
// lazy-duplicates what's already been filmed. Ideas land as RECOMMENDED in the
// bank; humans (or the client, in the portal phase) promote them to months.
// ---------------------------------------------------------------------------
export async function seedTopicBank(enrollmentId: string, perPillar = 10): Promise<{ created: number; pillars: string[] }> {
  const e = await prisma.contentEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { clientId: true },
  });
  if (!e) throw new Error("Enrollment not found.");
  const [context, history, bankIdeas] = await Promise.all([
    clientContext(enrollmentId),
    topicHistory(enrollmentId),
    prisma.contentTopic.findMany({
      where: { enrollmentId, monthId: null, status: { in: ["SAVED", "IDEA"] } },
      select: { title: true, concept: true },
      take: 40,
    }),
  ]);
  const { aiJson } = await import("@/lib/integrations/ai");
  const out = await aiJson<{ pillars: { pillar: string; topics: { title: string; concept: string; scores: string }[] }[] }>({
    system:
      "You build a video TOPIC BANK for a real-estate agent's monthly personal-branding program, working strictly from their " +
      "content strategy, profile, and the ideas they've raised on calls (all below). " +
      `Generate up to ${perPillar} topics per content pillar (use the strategy's own pillars; if none are defined, derive 3-4 from the material). ` +
      "Every topic must be SPECIFIC and FILMABLE with the hook direction already apparent — grounded in THIS agent's real market, " +
      "opinions, stories, and positioning. Strong angles: opinions, misconceptions, client mistakes, surprising truths, real stories, " +
      "local insight, behind-the-scenes. NEVER generic ('tips for sellers', 'market update', 'why you need a Realtor'). " +
      "Do not repeat anything in the topic history below — a fresh angle on an old theme is allowed, lazy duplication is not. " +
      "scores = a short 'Trust/Credibility/Value/Entertainment' judgement like 'Trust: High · Value: Medium'.\n" +
      CONTENT_RULES,
    prompt:
      `AGENT CONTEXT:\n${context}\n\nIDEAS ALREADY IN THE BANK (do not duplicate):\n` +
      bankIdeas.map((b) => `- ${b.title}`).join("\n") +
      `\n\nFULL TOPIC HISTORY (do not duplicate):\n${history}`,
    maxTokens: 16_000,
    schema: {
      type: "object",
      properties: {
        pillars: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pillar: { type: "string" },
              topics: {
                type: "array",
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, concept: { type: "string" }, scores: { type: "string" } },
                  required: ["title", "concept"],
                },
              },
            },
            required: ["pillar", "topics"],
          },
        },
      },
      required: ["pillars"],
    },
  });

  const existing = new Set(
    (await prisma.contentTopic.findMany({ where: { enrollmentId }, select: { title: true } })).map((t) => t.title.toLowerCase()),
  );
  let created = 0;
  const pillars: string[] = [];
  for (const p of arr<{ pillar: string; topics: { title: string; concept: string; scores?: string }[] }>(out.pillars)) {
    if (!p.pillar?.trim()) continue;
    pillars.push(p.pillar.trim());
    for (const t of arr<{ title: string; concept: string; scores?: string }>(p.topics)) {
      if (!t.title?.trim() || existing.has(t.title.toLowerCase())) continue;
      existing.add(t.title.toLowerCase());
      await prisma.contentTopic.create({
        data: {
          enrollmentId, clientId: e.clientId,
          title: t.title.trim().slice(0, 200),
          concept: t.concept?.trim().slice(0, 2000) || null,
          pillar: p.pillar.trim().slice(0, 120),
          status: "RECOMMENDED", source: "ai",
          scoresJson: t.scores ? JSON.stringify({ summary: t.scores.slice(0, 200) }) : null,
        },
      });
      created++;
    }
  }
  return { created, pillars };
}

// ---------------------------------------------------------------------------
// 5. Agent profile builder (spec §6) — synthesized from strategy calls,
// discovery calls (their distilled intel notes), the content strategy, and the
// scripts actually FILMED (the truest record of their voice). Non-destructive:
// existing keys in a section are kept; only NEW keys are added, so a hand-
// written note is never overwritten by AI.
// ---------------------------------------------------------------------------
const PROFILE_BUILD_SECTIONS: { key: "brandJson" | "voiceJson" | "contentPrefsJson" | "productionJson" | "editingJson" | "storiesJson"; label: string; guide: string }[] = [
  { key: "brandJson", label: "Brand & positioning", guide: "Positioning, primary message, target audience, markets, specialties, differentiators, content pillars, goals" },
  { key: "voiceJson", label: "Voice & scripting style", guide: "Tone, cadence, humor, phrases they actually use (from their filmed scripts), phrases to avoid, script format preference, CTA style" },
  { key: "contentPrefsJson", label: "Content preferences", guide: "Topics they love / avoid, formats, storytelling comfort, polarization comfort, personal-life comfort" },
  { key: "productionJson", label: "Production", guide: "Locations, preferred days/times, teleprompter, wardrobe, on-camera notes" },
  { key: "editingJson", label: "Editing style", guide: "Pacing, captions, music, graphics, recurring revision patterns" },
  { key: "storiesJson", label: "Stories, POVs & knowledge", guide: "Real stories, strong opinions, expertise areas, local knowledge — each entry concrete and attributable" },
];

export async function buildAgentProfileFromHistory(clientId: string): Promise<{ sectionsFilled: number; keysAdded: number }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { clientId }, select: { id: true } });
  if (!e) throw new Error("No enrollment for this client.");
  const [client, strategy, intelNotes, scripts] = await Promise.all([
    // generalNotes is THE customer note; editingPreferences is the retired
    // column, still read as a fallback (src/lib/clientNotes.ts).
    prisma.client.findUnique({
      where: { id: clientId },
      select: { name: true, company: true, generalNotes: true, editingPreferences: true },
    }),
    prisma.contentStrategy.findFirst({ where: { enrollmentId: e.id, status: "ACTIVE" }, select: { sectionsJson: true } }),
    // Same guard as clientContext() above. Without it the confidentiality rule
    // was only skin-deep: the profile builder read [CONFIDENTIAL] intel, wrote
    // it into a profile section, and clientContext() then pasted that section
    // into the script prompt verbatim — Ashley Brunner's unannounced brokerage
    // move reached the script writer that way, through storiesJson.
    prisma.contentNote.findMany({
      where: { clientId, intelligence: true, NOT: { body: { startsWith: "[CONFIDENTIAL" } } },
      orderBy: { createdAt: "desc" }, take: 60, select: { body: true },
    }),
    prisma.contentScript.findMany({ where: { clientId, source: "import" }, orderBy: { createdAt: "desc" }, take: 8, select: { title: true, body: true } }),
  ]);

  const material: string[] = [];
  material.push(`AGENT: ${client?.name}${client?.company ? ` (${client.company})` : ""}`);
  if (strategy?.sectionsJson) {
    try {
      const sec = JSON.parse(strategy.sectionsJson) as Record<string, string>;
      material.push("CONTENT STRATEGY:\n" + Object.entries(sec).map(([k, v]) => `## ${k}\n${v}`).join("\n"));
    } catch { /* skip */ }
  }
  if (intelNotes.length) material.push("FACTS LEARNED ON STRATEGY & DISCOVERY CALLS:\n" + intelNotes.map((n) => `- ${n.body}`).join("\n"));
  if (scripts.length) material.push("SCRIPTS THEY ACTUALLY FILMED (their real voice):\n" + scripts.map((s) => `### ${s.title}\n${s.body.slice(0, 1200)}`).join("\n\n"));
  // The customer note on file. It read editingPreferences, which has had no
  // writer since the notes cards merged (NULL on all 349 clients), so this
  // evidence line never made it into the profile build.
  const noteOnFile = customerNote(client);
  if (noteOnFile) material.push("CUSTOMER NOTES ON FILE:\n" + noteOnFile);
  if (material.length < 2) return { sectionsFilled: 0, keysAdded: 0 };

  const { aiJson } = await import("@/lib/integrations/ai");
  const out = await aiJson<{ sections: Record<string, Record<string, string>> }>({
    system:
      "You are building a real-estate agent's internal working profile for a content-production team, ONLY from the evidence below. " +
      "Fill these sections (JSON object per section, short labeled entries — a few sentences each):\n" +
      PROFILE_BUILD_SECTIONS.map((s) => `- ${s.key}: ${s.label} — ${s.guide}`).join("\n") +
      "\nRULES: never invent — every entry must trace to the material; quote their own phrases where possible (especially voice); " +
      "omit any section or field the evidence doesn't support. This is internal — candid, useful, specific. " +
      "Anything told in confidence or commercially sensitive (unannounced brokerage moves, internal plans, personal/financial disclosures) " +
      "must be prefixed '[CONFIDENTIAL] ' so it can never be used in content.",
    prompt: material.join("\n\n").slice(0, 90_000),
    maxTokens: 16_000,
    schema: {
      type: "object",
      properties: {
        sections: {
          type: "object",
          properties: Object.fromEntries(PROFILE_BUILD_SECTIONS.map((s) => [s.key, { type: "object", additionalProperties: { type: "string" } }])),
        },
      },
      required: ["sections"],
    },
  });

  // The whole sections object can arrive JSON-stringified too (Erica, Aug 24 —
  // the biggest-evidence client hit it). Coerce at both levels.
  let raw: Record<string, unknown> = {};
  if (out.sections && typeof out.sections === "object") raw = out.sections;
  else if (typeof out.sections === "string") { try { const p = JSON.parse(out.sections); if (p && typeof p === "object") raw = p; } catch { raw = {}; } }
  const profile = await prisma.agentProfile.findUnique({ where: { clientId } });
  let sectionsFilled = 0, keysAdded = 0;
  const data: Record<string, string> = {};
  for (const s of PROFILE_BUILD_SECTIONS) {
    let incoming = raw[s.key];
    if (typeof incoming === "string") { try { incoming = JSON.parse(incoming); } catch { incoming = undefined as never; } }
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) continue;
    let existing: Record<string, string> = {};
    try { existing = profile?.[s.key] ? JSON.parse(profile[s.key]!) : {}; } catch { existing = {}; }
    let added = 0;
    for (const [k, v] of Object.entries(incoming)) {
      const key = k.trim().slice(0, 80);
      const val = typeof v === "string" ? v.trim().slice(0, 4000) : "";
      if (!key || !val || val.length < 3) continue;
      if (existing[key]) continue; // hand-written (or earlier) entries win
      existing[key] = val;
      added++;
    }
    if (added > 0) { data[s.key] = JSON.stringify(existing); sectionsFilled++; keysAdded += added; }
  }
  if (Object.keys(data).length) {
    await prisma.agentProfile.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  }
  return { sectionsFilled, keysAdded };
}
