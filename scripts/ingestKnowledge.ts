import fs from "fs";
import readline from "readline";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";

// One-off ingestion: stream Jordan's full ChatGPT export, keep BUSINESS-only
// conversations, and use Claude (Haiku, cheap) to extract durable, role-tagged
// knowledge into the KnowledgeItem table for "Ask the Hub".
//   LIMIT=15 npx tsx --env-file=.env scripts/ingestKnowledge.ts   (test)
//   npx tsx --env-file=.env scripts/ingestKnowledge.ts            (full)

const FILE = "/Users/jordanspackman/Documents/FULL CHAT GPT EXPORT.jsonl";
const MODEL = "claude-haiku-4-5-20251001";
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const CONCURRENCY = 6;

// Broad business markers — a conversation must hit at least one to be worth
// spending an AI call on (drops obviously-personal chats cheaply).
const BIZ = /real ?estate|realtor|listing|\bshoot|photo|video|reel|editor|\bedit\b|client|aryeo|kyle|harrison|photographer|drone|matterport|floor ?plan|twilight|realtour|invoice|pricing|\bprice\b|schedul|appointment|dropbox|openphone|slack|vendor|luma|\bagent|brokerage|payout|contractor|social media|content day|script|hook|delivery|deliver|revision|booking|quote|package|bundle|staging|HDR|topaz|matterport|airbnb|business|revenue|margin|payroll|commission|lead\b|crm|hubspot/i;

let key: string | null = null;

type Insight = { category: string; title: string; body: string; minRole: string; tags?: string[]; confidence?: number };

const SYSTEM = `You extract durable BUSINESS knowledge about a real estate media agency ("RealTour Pilot", owner Jordan Spackman) from one of his ChatGPT conversations. You are building a private knowledge base that an internal AI assistant will use to make decisions and understand the business.

Return ONLY a JSON object: {"skip": true} if the conversation is personal, trivial, or not about running/growing the business; otherwise {"insights": [ ... ]}.

Each insight: {"category","title","body","minRole","tags","confidence"}.
- category: one of preference, goal, issue, outcome, sop, fee, pricing, client_insight, strategy, financial, team, comms, script.
- title: a short factual headline (max 12 words).
- body: 1-3 sentences stating the durable fact, decision, preference, problem, outcome, or goal. Be specific and concrete. Write what is TRUE/DECIDED, not a summary of the chat. No em dashes, no emojis.
- minRole: the LOWEST role allowed to see this. Use:
  - "OWNER" for finances, revenue, margins, profit, contractor/employee pay rates, vendor costs, growth targets, strategic plans, personnel assessments (who is underperforming or a flight risk), legal/HR, and anything personal or sensitive.
  - "ADMIN" for client-handling nuances, problem-resolution rules, fee enforcement, scheduling logistics, client preferences, goodwill decisions (Kyle the VA can see these).
  - "CREATIVE" for general SOPs, shoot/prep checklists, editing standards, comms tone, deliverable turnaround (anyone on the team can see these).
- tags: 1-4 short lowercase tags.
- confidence: 1-5 (how strongly the conversation supports this).

Only extract DURABLE knowledge (preferences, decisions, recurring problems, outcomes, goals, policies, how-the-business-works). Skip one-off task chatter, drafts, and anything ephemeral. At most 6 insights. If nothing durable, return {"skip": true}.`;

async function extract(title: string, transcript: string): Promise<Insight[] | null> {
  const user = `Conversation title: ${title}\n\nTranscript (may be truncated):\n"""\n${transcript.slice(0, 7000)}\n"""`;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1500));
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      });
    } catch { continue; }
    if (res.status === 429 || res.status === 529 || res.status >= 500) continue;
    const j = (await res.json().catch(() => ({}))) as { content?: { text?: string }[] };
    const text = j.content?.[0]?.text ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]) as { skip?: boolean; insights?: Insight[] };
      if (parsed.skip || !parsed.insights) return null;
      return parsed.insights;
    } catch { return null; }
  }
  return null;
}

function flatten(conv: any): string {
  const map = conv.mapping;
  if (!map) return "";
  const msgs: { t: number; role: string; text: string }[] = [];
  for (const id of Object.keys(map)) {
    const node = map[id];
    const msg = node?.message;
    if (!msg) continue;
    const role = msg.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    const c = msg.content;
    if (!c) continue;
    let txt = "";
    if (c.content_type === "text" && Array.isArray(c.parts)) txt = c.parts.filter((p: any) => typeof p === "string").join("\n");
    else if (Array.isArray(c.parts)) txt = c.parts.filter((p: any) => typeof p === "string").join("\n");
    if (!txt.trim()) continue;
    msgs.push({ t: msg.create_time ?? 0, role, text: txt });
  }
  msgs.sort((a, b) => a.t - b.t);
  return msgs.map((m) => `${m.role === "user" ? "Jordan" : "AI"}: ${m.text}`).join("\n\n");
}

const normRole = (r: string) => {
  const u = (r || "").toUpperCase();
  return u === "OWNER" || u === "ADMIN" || u === "CREATIVE" ? u : "ADMIN";
};
const CATS = new Set(["preference","goal","issue","outcome","sop","fee","pricing","client_insight","strategy","financial","team","comms","script"]);

async function main() {
  key = await getSecret("ai");
  if (!key) { console.error("AI not connected"); process.exit(1); }

  // 1) Stream + flatten + pre-filter.
  const jobs: { title: string; transcript: string }[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
  let total = 0, kept = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    let conv: any;
    try { conv = JSON.parse(line); } catch { continue; }
    const title = conv.title || "Untitled";
    const transcript = flatten(conv);
    if (transcript.length < 200) continue;
    if (!BIZ.test(title + "\n" + transcript)) continue;
    kept++;
    jobs.push({ title, transcript });
    if (jobs.length >= LIMIT) break;
  }
  console.log(`Streamed ${total} conversations; ${kept} passed the business pre-filter; processing ${jobs.length}.`);

  // 2) Extract with a small concurrency pool.
  const all: (Insight & { sourceRef: string })[] = [];
  let done = 0, skipped = 0;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const i = idx++;
      const job = jobs[i];
      const insights = await extract(job.title, job.transcript);
      done++;
      if (!insights || !insights.length) { skipped++; }
      else for (const ins of insights) {
        if (!ins?.title || !ins?.body) continue;
        all.push({ ...ins, sourceRef: job.title });
      }
      if (done % 25 === 0) console.log(`  extracted ${done}/${jobs.length} (skipped ${skipped}, insights so far ${all.length})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`Extraction done. ${all.length} raw insights from ${jobs.length - skipped} business conversations.`);

  // 3) Coarse dedupe by normalized title, then store.
  const seen = new Set<string>();
  let inserted = 0;
  for (const ins of all) {
    const k = ins.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    await prisma.knowledgeItem.create({
      data: {
        category: CATS.has(ins.category) ? ins.category : "issue",
        title: ins.title.slice(0, 160),
        body: ins.body.slice(0, 1200),
        minRole: normRole(ins.minRole),
        tags: ins.tags && ins.tags.length ? JSON.stringify(ins.tags.slice(0, 4)) : null,
        source: "chatgpt-export",
        sourceRef: ins.sourceRef.slice(0, 160),
        confidence: typeof ins.confidence === "number" ? Math.max(1, Math.min(5, Math.round(ins.confidence))) : null,
      },
    });
    inserted++;
  }
  const byRole = await prisma.knowledgeItem.groupBy({ by: ["minRole"], _count: { _all: true } });
  const byCat = await prisma.knowledgeItem.groupBy({ by: ["category"], _count: { _all: true } });
  console.log(`Inserted ${inserted} knowledge items (after title-dedupe).`);
  console.log("By role:", byRole.map((r) => `${r.minRole}:${r._count._all}`).join("  "));
  console.log("By category:", byCat.map((c) => `${c.category}:${c._count._all}`).join("  "));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
