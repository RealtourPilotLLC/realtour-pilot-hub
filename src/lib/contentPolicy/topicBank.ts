// ---------------------------------------------------------------------------
// Topic bank: the topic type (spec §5), Arielle's presentation (manifest §5.1),
// a reader for bank documents, the deterministic validator (spec §27 gates:
// configured count, descriptions, basic duplication) and the pure
// "Recommended for your next session" ranking (spec §27).
//
// Counts: topicsPerPillar × the CLIENT's pillar count (4, 5 or 6 — C-B4).
// Imports: descriptions may be null (C-C2); near-duplicates warn (C-C6).
// Generated: descriptions required; near-duplicates block.
//
// Pure. No DB, no AI.
// ---------------------------------------------------------------------------

import { GENERATION_POLICY, type Finding, type Gap, type PolicyStamp, makeGap } from "./policy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Spec §5 vocabulary. Filmed, delivered and published are separate facts kept in history, not states. */
export type TopicState = "SUGGESTED" | "SELECTED" | "PREPARING" | "FILMED" | "ARCHIVED";

export type TopicSource = "GENERATED" | "IMPORTED" | "CLIENT_SUGGESTED" | "CALL" | "STAFF";

/**
 * ContentTopic.source values a model wrote — a topic from one of these is not
 * the client's until staff approve it (§6.3: "New generated bank items follow
 * staff approval before client visibility"). ONE list, read by the portal's
 * visibility rule (contentTopics.clientCanSeeTopic) and the staff bank's
 * "hidden from the client until approved" hint, so the two cannot drift: the
 * discovery call's topics (batch 2) were added as a new source and reached the
 * client's bank unapproved because only the rule's own inline pair was checked.
 */
export const TOPIC_SOURCES_NEEDING_APPROVAL: readonly string[] = ["ai", "strategy_call", "discovery_call"];
export const topicSourceNeedsApproval = (source: string | null | undefined): boolean => !!source && TOPIC_SOURCES_NEEDING_APPROVAL.includes(source);
/** A call transcript's topic (monthly or discovery) — its "declined" mark came from the call. */
export const topicSourceIsCall = (source: string | null | undefined): boolean => source === "strategy_call" || source === "discovery_call";

export type TopicHistoryEvent = {
  at: string; // ISO
  event: string; // "imported" | "suggested" | "selected" | "deselected" | "script-drafted" | "filmed" | "delivered" | "published" | "archived" | "rejected"
  by: string | null;
  note: string | null;
  monthKey?: string | null;
};

export type Topic = {
  id: string | null;
  clientId: string | null;
  title: string;
  /** One-sentence filmable description. Required for GENERATED; null allowed for IMPORTED (C-C2). */
  description: string | null;
  pillarRef: { pillarId: string | null; pillarName: string };
  audienceNeed: string | null;
  businessGoal: string | null;
  intendedMessage: string | null;
  source: TopicSource;
  /** Traceability to source text ("docx:Arielle_Roemer_Team_Video_Topic_Bank.docx#pillar2/item3", "call:2026-07-27#00:14:02"). */
  sourceRef: string | null;
  state: TopicState;
  selectedForMonth: string | null;
  /** Colour / bold marks decoded on import are PROPOSALS awaiting staff confirmation (C-C3). */
  proposedState: TopicState | null;
  importedMark: string | null;
  history: TopicHistoryEvent[];
  strategyVersion: string | null;
  stamp: PolicyStamp | null;
};

export type TopicBankPillar = {
  pillarId: string | null;
  name: string;
  /** Marcee-style pillar-level Purpose line, when the source has one. */
  purpose: string | null;
  topics: Topic[];
};

export type TopicBank = {
  clientId: string | null;
  clientName: string | null;
  /** Front-matter lines other than the client name and the "Video Topic Bank" label (the intro sentence). */
  intro: string[];
  pillars: TopicBankPillar[];
  strategyVersion: string | null;
  stamp: PolicyStamp | null;
};

export function makeTopic(partial: Partial<Topic> & { title: string; pillarName: string }): Topic {
  return {
    id: partial.id ?? null,
    clientId: partial.clientId ?? null,
    title: partial.title,
    description: partial.description ?? null,
    pillarRef: { pillarId: partial.pillarRef?.pillarId ?? null, pillarName: partial.pillarName },
    audienceNeed: partial.audienceNeed ?? null,
    businessGoal: partial.businessGoal ?? null,
    intendedMessage: partial.intendedMessage ?? null,
    source: partial.source ?? "GENERATED",
    sourceRef: partial.sourceRef ?? null,
    state: partial.state ?? "SUGGESTED",
    selectedForMonth: partial.selectedForMonth ?? null,
    proposedState: partial.proposedState ?? null,
    importedMark: partial.importedMark ?? null,
    history: partial.history ?? [],
    strategyVersion: partial.strategyVersion ?? null,
    stamp: partial.stamp ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reader — Arielle's docx (dumped), the markdown form, or a titles-only bank
// ---------------------------------------------------------------------------

const BANK_LABEL_RE = /^video topic bank$/i;
const ITEM_RE = /^\s*(?:[•●▪◦\-–—*]|(\d{1,2})[.)])\s+(.*)$/;
const MD_HEADING_RE = /^#{1,3}\s+(.+)$/;
const PURPOSE_RE = /^Purpose\s*:\s*(.*)$/i;

function normalizeBankLines(text: string): { line: string; heading: boolean; item: boolean }[] {
  const out: { line: string; heading: boolean; item: boolean }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^<([^>]{1,40})>((?:\[[^\]]{0,40}\])*)\s?/.exec(raw);
    const body = (marker ? raw.slice(marker[0].length) : raw).replace(/\s+$/, "");
    if (/^=+\s*PAGE \d+\s*=+$/i.test(body.trim())) continue;
    if (marker && /^heading/i.test(marker[1])) {
      out.push({ line: body.trim(), heading: true, item: false });
      continue;
    }
    const md = MD_HEADING_RE.exec(body);
    if (md) {
      out.push({ line: md[1].trim(), heading: true, item: false });
      continue;
    }
    const isList = !!marker && (/^(list|body list)/i.test(marker[1]) || /\[num:/.test(marker[2]));
    if (isList && body.trim() && !ITEM_RE.test(body)) {
      out.push({ line: body.trim(), heading: false, item: true });
      continue;
    }
    out.push({ line: body, heading: false, item: ITEM_RE.test(body) });
  }
  return out;
}

function stripBold(s: string): string {
  return s.replace(/^\*\*(.+?)\*\*$/, "$1").replace(/^__(.+?)__$/, "$1").trim();
}

export type ParsedTopicBank = TopicBank & {
  /** Whether numbering restarts at 1 under every pillar (Arielle) or runs on (Hutton). */
  numbering: "restarts" | "continuous" | "none";
  warnings: string[];
};

/**
 * Read a topic-bank document: front matter, pillar headings, one item per
 * topic (bold title, optional one-sentence description on the following
 * line). Titles-only banks yield `description: null`; nothing is invented.
 */
export function parseTopicBankDocument(text: string, opts: { clientId?: string | null; source?: TopicSource; sourceRef?: string | null } = {}): ParsedTopicBank {
  const lines = normalizeBankLines(text);
  const warnings: string[] = [];
  const bank: ParsedTopicBank = { clientId: opts.clientId ?? null, clientName: null, intro: [], pillars: [], strategyVersion: null, stamp: null, numbering: "none", warnings };
  const source = opts.source ?? "IMPORTED";
  let pillar = null as TopicBankPillar | null; // `null as …`: keep the declared type past closure assignments
  let topic = null as Topic | null;
  const front: string[] = [];
  const seenNumbers: number[][] = [];
  let sawAnyNumber = false;

  const startPillar = (name: string) => {
    pillar = { pillarId: null, name: name.replace(/:$/, "").trim(), purpose: null, topics: [] };
    bank.pillars.push(pillar);
    seenNumbers.push([]);
    topic = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const { line, heading, item } = lines[i];
    const t = line.trim();
    if (!t) {
      topic = null;
      continue;
    }
    if (heading) {
      startPillar(t);
      continue;
    }
    if (item) {
      const m = ITEM_RE.exec(t);
      const num = m?.[1] ? Number(m[1]) : null;
      const body = m ? m[2] : t;
      if (!pillar) startPillar("(unnamed pillar)");
      if (num != null) {
        sawAnyNumber = true;
        seenNumbers[seenNumbers.length - 1].push(num);
      }
      const p = pillar!;
      topic = makeTopic({
        title: stripBold(body),
        pillarName: p.name,
        source,
        clientId: bank.clientId,
        sourceRef: opts.sourceRef ? `${opts.sourceRef}#pillar${bank.pillars.length}/item${p.topics.length + 1}` : null,
      });
      p.topics.push(topic);
      continue;
    }
    const purpose = PURPOSE_RE.exec(t);
    if (purpose && pillar && !topic) {
      pillar.purpose = purpose[1].trim();
      continue;
    }
    if (topic) {
      topic.description = topic.description ? `${topic.description} ${t}` : t;
      continue;
    }
    if (!pillar) {
      // Front matter. A bare line before any item, followed by a "1." item, is a pillar heading in plain PDF text.
      const next = lines[i + 1];
      if (next && next.item && /^\s*1[.)]\s/.test(next.line) && front.length >= 1) {
        startPillar(t);
        continue;
      }
      front.push(t);
      continue;
    }
    // A bare line inside a pillar with no open topic: a new pillar heading if the next line restarts at 1.
    const next = lines[i + 1];
    if (next && next.item && /^\s*1[.)]\s/.test(next.line)) {
      startPillar(t);
      continue;
    }
    warnings.push(`line ${i + 1} inside “${pillar.name}” attached to nothing: “${t.slice(0, 60)}”`);
  }

  // Front matter → client name / label / intro.
  for (const f of front) {
    if (BANK_LABEL_RE.test(f)) continue;
    if (!bank.clientName && f.split(/\s+/).length <= 6 && !/[.?!]$/.test(f)) bank.clientName = f;
    else bank.intro.push(f);
  }
  if (sawAnyNumber) {
    const restarts = seenNumbers.filter((a) => a.length).every((a) => a[0] === 1);
    bank.numbering = restarts && seenNumbers.filter((a) => a.length).length > 1 ? "restarts" : restarts ? "restarts" : "continuous";
  }
  if (!bank.pillars.length) warnings.push("no pillars found");
  return bank;
}

// ---------------------------------------------------------------------------
// Renderer — Arielle's presentation: pillar heading, numbering restarting at 1
// per pillar, bold title, one-sentence description (omitted when null).
// ---------------------------------------------------------------------------

export function renderTopicBank(bank: TopicBank, opts: { frontMatter?: boolean } = {}): string {
  const out: string[] = [];
  if (opts.frontMatter !== false) {
    if (bank.clientName) out.push(bank.clientName);
    out.push("Video Topic Bank");
    out.push(...bank.intro);
    out.push("");
  }
  bank.pillars.forEach((p, pi) => {
    out.push(`## ${p.name}`, "");
    if (p.purpose) out.push(`Purpose: ${p.purpose}`, "");
    p.topics.forEach((t, i) => {
      out.push(`${i + 1}. **${t.title}**`);
      if (t.description) out.push(`   ${t.description}`);
    });
    if (pi < bank.pillars.length - 1) out.push("");
  });
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  "a an the and or of to in on for with your you our we us is are was be it its this that what when where why how before after about into from by at as do does did not no yes vs versus one".split(" "),
);

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleTokens(title: string): Set<string> {
  const toks = normalizeTitle(title)
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""));
  return new Set(toks.filter((w) => w.length > 1));
}

/** Everything a similarity comparison needs, computed once per title (the pair loops are O(n²)). */
export type TitleProfile = { norm: string; tokens: Set<string>; bigrams: Map<string, number>; bigramTotal: number };

export function titleProfile(title: string): TitleProfile {
  const norm = normalizeTitle(title);
  const bigrams = new Map<string, number>();
  const c = norm.replace(/\s/g, "");
  for (let i = 0; i < c.length - 1; i++) {
    const g = c.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
  }
  return { norm, tokens: titleTokens(title), bigrams, bigramTotal: Math.max(0, c.length - 1) };
}

/** 0–1: max of token Jaccard and character-bigram Dice over two precomputed profiles. */
export function profileSimilarity(a: TitleProfile, b: TitleProfile): number {
  if (!a.norm || !b.norm) return 0;
  if (a.norm === b.norm) return 1;
  let inter = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) inter++;
  const union = a.tokens.size + b.tokens.size - inter;
  const jaccard = union ? inter / union : 0;
  if (jaccard >= 1) return 1;
  // Iterate the smaller bigram map.
  const [small, large] = a.bigrams.size <= b.bigrams.size ? [a.bigrams, b.bigrams] : [b.bigrams, a.bigrams];
  let common = 0;
  for (const [g, n] of small) {
    const o = large.get(g);
    if (o) common += Math.min(n, o);
  }
  const total = a.bigramTotal + b.bigramTotal;
  const dice = total ? (2 * common) / total : 0;
  return Math.max(jaccard, dice);
}

/** 0–1: max of token Jaccard and character-bigram Dice over the normalised titles. */
export function titleSimilarity(a: string, b: string): number {
  return profileSimilarity(titleProfile(a), titleProfile(b));
}

export const NEAR_DUPLICATE_THRESHOLD = 0.7;

export type TopicBankValidation = {
  ok: boolean;
  mode: "generated" | "imported";
  expectedPerPillar: number;
  counts: { pillar: string; count: number }[];
  duplicates: { a: string; b: string; pillarA: string; pillarB: string; similarity: number }[];
  findings: Finding[];
  gaps: Gap[];
};

export type ValidateTopicBankOptions = {
  /** The configured count; default = policy default (10). Must be within [min, max]. */
  topicsPerPillar?: number;
  /** "generated" holds the bank to the count + descriptions + duplicate blocks; "imported" warns. Default: inferred from the topics' `source`. */
  mode?: "generated" | "imported";
  /** Pillar names the approved strategy defines — a topic under any other name is flagged. */
  strategyPillarNames?: string[];
};

export function validateTopicBank(bank: TopicBank, opts: ValidateTopicBankOptions = {}): TopicBankValidation {
  const findings: Finding[] = [];
  const gaps: Gap[] = [];
  const cfg = GENERATION_POLICY.topicsPerPillar;
  const expected = opts.topicsPerPillar ?? cfg.default;
  const all = bank.pillars.flatMap((p) => p.topics);
  const mode: "generated" | "imported" = opts.mode ?? (all.length && all.every((t) => t.source === "IMPORTED" || t.source === "CLIENT_SUGGESTED" || t.source === "CALL" || t.source === "STAFF") ? "imported" : "generated");
  const blockOrWarn: Finding["severity"] = mode === "generated" ? "block" : "warn";

  if (!Number.isInteger(expected) || expected < cfg.min || expected > cfg.max) {
    findings.push({ code: "config.topicsPerPillar.out-of-range", severity: "block", message: `topicsPerPillar must be an integer from ${cfg.min} to ${cfg.max}; got ${expected}.`, measured: { expected } });
  }
  if (!bank.pillars.length) findings.push({ code: "bank.no-pillars", severity: "block", message: "The bank has no pillars." });

  const counts = bank.pillars.map((p) => ({ pillar: p.name, count: p.topics.length }));
  bank.pillars.forEach((p, pi) => {
    if (p.topics.length !== expected) {
      findings.push({
        code: "pillar.count",
        severity: blockOrWarn,
        message: `Pillar “${p.name}” has ${p.topics.length} topics; exactly ${expected} are required${mode === "imported" ? " for a generated bank (imported banks keep their real count)" : ""}.`,
        path: `pillars[${pi}]`,
        measured: { count: p.topics.length, expected },
      });
      if (mode === "generated" && p.topics.length < expected) {
        gaps.push(makeGap("insufficient-context", `Only ${p.topics.length} of ${expected} topics could be supported for “${p.name}” at the quality bar.`, { field: `pillars[${pi}].topics`, question: `What else could ${bank.clientName ?? "the client"} speak to under “${p.name}” from real experience?` }));
      }
    }
    if (opts.strategyPillarNames && !opts.strategyPillarNames.some((n) => normalizeTitle(n) === normalizeTitle(p.name))) {
      findings.push({ code: "pillar.unknown", severity: mode === "generated" ? "block" : "warn", message: `Pillar “${p.name}” is not one of the approved strategy's pillars (${opts.strategyPillarNames.join("; ")}). Map it by alias on import; never rename the client's pillars.`, path: `pillars[${pi}]` });
    }
    p.topics.forEach((t, ti) => {
      const path = `pillars[${pi}].topics[${ti}]`;
      if (!t.title.trim()) findings.push({ code: "topic.title.missing", severity: "block", message: "A topic has no title.", path });
      // C-C2: a description is required for GENERATED topics only; client/call/staff
      // suggestions and imports may carry null.
      if (!t.description && t.source === "GENERATED") {
        findings.push({ code: "topic.description.missing", severity: "block", message: `Generated topic “${t.title}” has no description; every generated topic needs a short concrete description of what the video would show.`, path });
      }
      if (normalizeTitle(t.pillarRef.pillarName) !== normalizeTitle(p.name)) {
        findings.push({ code: "topic.pillar.mismatch", severity: "warn", message: `Topic “${t.title}” says pillar “${t.pillarRef.pillarName}” but sits under “${p.name}”.`, path });
      }
    });
  });

  // Near-duplicates across the whole bank (a title variation is not a distinct idea).
  const duplicates: TopicBankValidation["duplicates"] = [];
  const flat = bank.pillars.flatMap((p) => p.topics.map((t) => ({ t, p: p.name, prof: titleProfile(t.title) })));
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const sim = profileSimilarity(flat[i].prof, flat[j].prof);
      if (sim >= NEAR_DUPLICATE_THRESHOLD) {
        duplicates.push({ a: flat[i].t.title, b: flat[j].t.title, pillarA: flat[i].p, pillarB: flat[j].p, similarity: Math.round(sim * 100) / 100 });
        const bothImported = flat[i].t.source === "IMPORTED" && flat[j].t.source === "IMPORTED";
        findings.push({
          code: "topic.near-duplicate",
          severity: bothImported || mode === "imported" ? "warn" : "block",
          message: `“${flat[i].t.title}” and “${flat[j].t.title}” look like the same idea (similarity ${Math.round(sim * 100)}%).`,
          measured: { similarity: Math.round(sim * 100) / 100 },
        });
      }
    }
  }

  return { ok: !findings.some((f) => f.severity === "block"), mode, expectedPerPillar: expected, counts, duplicates, findings, gaps };
}

// ---------------------------------------------------------------------------
// "Recommended for your next session" — pure ranking (spec §27)
// ---------------------------------------------------------------------------

export type StrategyGoal = { id: string; text: string; priority?: number | null; timeBound?: string | null };

export type FilmedRecord = { topicId: string | null; title: string; pillarName: string; filmedAt: string; verified: true };

export type PriorScript = { topicId: string | null; title: string; pillarName: string; status: "DRAFT" | "APPROVED" | "IN_PRODUCTION" | "DELIVERED"; monthKey: string | null };

export type RecommendationInput = {
  bank: Topic[];
  goals: StrategyGoal[];
  brandMessage?: string | null;
  /** pillarName → weight; 1 = neutral, >1 emphasised (e.g. "Seller strategy will lead the content mix"). */
  pillarEmphasis?: Record<string, number>;
  /** Free text such as "establishing team identity before the November anniversary". Matched by keyword against topics. */
  relationshipPhase?: string | null;
  /** null = no verified filming history at all. An imported script or a selection is NOT filming history. */
  filmingHistory: FilmedRecord[] | null;
  priorScripts: PriorScript[];
  /** Session / month capacity; the shortlist size. */
  capacity: number;
  alternatives?: number;
  feasibility?: { availableLocations?: string[]; availableParticipants?: string[]; notes?: string[] } | null;
  performanceSignals?: { topicId: string | null; title: string | null; pillarName: string | null; metric: string; value: number; verified: boolean }[];
  clientFeedback?: { topicId: string | null; title: string | null; text: string }[];
  /** Deliberate sequels / revisits, each with a reason and a new angle — the only way a filmed topic comes back. */
  sequels?: { topicId: string; reason: string; newAngle: string }[];
};

export type PriorContentRelationship = "new" | "follow-up" | "sequel" | "already-scripted" | "already-filmed";

export type RankedTopic = {
  topic: Topic;
  rank: number;
  score: number;
  linkedGoal: string | null;
  pillar: string;
  priorContentRelationship: PriorContentRelationship;
  whyNow: string;
  historyNote: string | null;
  reasons: string[];
};

export type RecommendationResult = {
  recommended: RankedTopic[];
  alternatives: RankedTopic[];
  excluded: { topic: Topic; reason: string }[];
  historyNote: string;
  pillarFilmedCounts: Record<string, number> | null;
};

const NO_HISTORY = "No verified filming history";

function tokensOf(...parts: (string | null | undefined)[]): Set<string> {
  return titleTokens(parts.filter(Boolean).join(" "));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.min(a.size, b.size);
}

type Profiled<T> = T & { prof: TitleProfile };
function profiled<T extends { title: string }>(rows: T[]): Profiled<T>[] {
  return rows.map((r) => ({ ...r, prof: titleProfile(r.title) }));
}

function sameTopic(t: { id: string | null; prof: TitleProfile }, other: { topicId: string | null; prof: TitleProfile }): boolean {
  if (t.id && other.topicId && t.id === other.topicId) return true;
  return profileSimilarity(t.prof, other.prof) >= 0.85;
}

export function rankRecommendations(input: RecommendationInput): RecommendationResult {
  const excluded: RecommendationResult["excluded"] = [];
  const history = input.filmingHistory;
  const historyNote = history === null ? NO_HISTORY : history.length ? `${history.length} verified filmed piece${history.length === 1 ? "" : "s"}` : "Verified history present: nothing filmed yet";
  const emphasis = input.pillarEmphasis ?? {};
  const phaseTokens = tokensOf(input.relationshipPhase);
  const brandTokens = tokensOf(input.brandMessage);
  const sequelIds = new Map((input.sequels ?? []).map((s) => [s.topicId, s]));

  // Filmed-per-pillar counts (verified only).
  let pillarFilmedCounts: Record<string, number> | null = null;
  if (history) {
    pillarFilmedCounts = {};
    for (const h of history) pillarFilmedCounts[h.pillarName] = (pillarFilmedCounts[h.pillarName] ?? 0) + 1;
  }
  const maxFilmed = pillarFilmedCounts ? Math.max(0, ...Object.values(pillarFilmedCounts)) : 0;

  // Title profiles once per row, not once per pair.
  const historyP = history ? profiled(history) : null;
  const priorP = profiled(input.priorScripts);
  const feedbackP = (input.clientFeedback ?? []).map((fb) => ({ ...fb, prof: fb.title ? titleProfile(fb.title) : null }));

  const scored: RankedTopic[] = [];
  for (const topic of input.bank) {
    const tp = { id: topic.id, prof: titleProfile(topic.title) };
    const sequel = topic.id ? sequelIds.get(topic.id) : undefined;
    if (topic.state === "ARCHIVED") {
      excluded.push({ topic, reason: "archived — never resurfaced as new" });
      continue;
    }
    if (topic.state === "SELECTED" || topic.state === "PREPARING") {
      excluded.push({ topic, reason: `already ${topic.state.toLowerCase()} — recommendations stay separate from selections` });
      continue;
    }
    const filmed = historyP?.find((h) => sameTopic(tp, h)) ?? null;
    const scripted = priorP.find((s) => sameTopic(tp, s)) ?? null;
    if ((topic.state === "FILMED" || filmed) && !sequel) {
      excluded.push({ topic, reason: "already filmed (verified) — only a deliberate sequel with a new angle brings it back" });
      continue;
    }
    if (scripted && !sequel) {
      excluded.push({ topic, reason: `already scripted (${scripted.status.toLowerCase()}${scripted.monthKey ? `, ${scripted.monthKey}` : ""})` });
      continue;
    }

    const reasons: string[] = [];
    let score = 0;
    const tTokens = tokensOf(topic.title, topic.description, topic.audienceNeed, topic.intendedMessage, topic.businessGoal);

    // 1. Goals and brand message.
    let linkedGoal: StrategyGoal | null = null;
    let bestGoal = 0;
    input.goals.forEach((g, idx) => {
      const explicit = topic.businessGoal && (topic.businessGoal === g.id || topic.businessGoal.toLowerCase().includes(g.id.toLowerCase()));
      const ov = overlap(tTokens, tokensOf(g.text));
      const prio = g.priority != null ? g.priority : input.goals.length - idx; // earlier goals weigh a little more
      const weight = 1 + prio / (input.goals.length * 4);
      const v = (explicit ? 1 : ov) * weight;
      if (v > bestGoal) {
        bestGoal = v;
        linkedGoal = g;
      }
    });
    if (linkedGoal) {
      const g: StrategyGoal = linkedGoal;
      score += 4 * bestGoal;
      reasons.push(`supports goal “${g.text.length > 70 ? g.text.slice(0, 67) + "…" : g.text}”`);
      if (g.timeBound) reasons.push(`time-bound: ${g.timeBound}`);
    }
    const brandOv = overlap(tTokens, brandTokens);
    if (brandOv > 0) score += brandOv;

    // 2. Relationship phase.
    const phaseOv = overlap(tTokens, phaseTokens);
    if (phaseOv > 0) {
      score += 2 * phaseOv;
      reasons.push("fits the current phase of the relationship");
    }

    // 3. Pillar emphasis and under-representation.
    const pillar = topic.pillarRef.pillarName;
    const weight = emphasis[pillar] ?? 1;
    score *= weight;
    if (weight > 1) reasons.push("pillar leads the content mix");
    if (pillarFilmedCounts) {
      const filmedHere = pillarFilmedCounts[pillar] ?? 0;
      const under = maxFilmed ? (maxFilmed - filmedHere) / (maxFilmed + 1) : 0;
      if (under > 0) {
        score += 2 * under;
        reasons.push(`pillar under-represented in filmed content (${filmedHere} filmed vs ${maxFilmed} for the most-filmed pillar)`);
      }
    }
    score += 1; // base so an unlinked topic still ranks below linked ones rather than at zero

    // 4. Prior-content relationship.
    let rel: PriorContentRelationship = "new";
    if (sequel) {
      rel = filmed || topic.state === "FILMED" ? "sequel" : "follow-up";
      score += 1.5;
      reasons.push(`deliberate ${rel}: ${sequel.reason} — new angle: ${sequel.newAngle}`);
    } else {
      // A different topic in the same pillar already filmed → this one is a follow-up angle, not a repeat.
      const related = historyP?.filter((h) => h.pillarName === pillar && profileSimilarity(tp.prof, h.prof) >= 0.4) ?? [];
      if (related.length) {
        rel = "follow-up";
        reasons.push(`adds a new angle to filmed content (“${related[0].title}”)`);
      }
    }

    // 5. Feasibility.
    const feas = input.feasibility;
    if (feas) {
      const haystack = `${topic.title} ${topic.description ?? ""}`.toLowerCase();
      const loc = (feas.availableLocations ?? []).find((l) => haystack.includes(l.toLowerCase()));
      const who = (feas.availableParticipants ?? []).find((p) => haystack.includes(p.toLowerCase()));
      if (loc) {
        score += 0.75;
        reasons.push(`filmable at an available location (${loc})`);
      }
      if (who) {
        score += 0.75;
        reasons.push(`available participant (${who})`);
      }
    }

    // 6. Verified performance signals and separately labelled client feedback.
    for (const sig of input.performanceSignals ?? []) {
      if (!sig.verified) continue;
      if (sig.pillarName && sig.pillarName === pillar) {
        score += 0.5;
        reasons.push(`verified performance signal in this pillar (${sig.metric} ${sig.value})`);
        break;
      }
    }
    for (const fb of feedbackP) {
      if ((fb.topicId && fb.topicId === topic.id) || (fb.prof && profileSimilarity(fb.prof, tp.prof) >= 0.85)) {
        score += 0.5;
        reasons.push(`client feedback (reported, not measured): “${fb.text.slice(0, 60)}”`);
        break;
      }
    }

    const whyNow = reasons.length ? reasons.join("; ") : "in the bank with no goal, phase or history signal attached — a filler, not a priority";
    scored.push({
      topic,
      rank: 0,
      score: Math.round(score * 1000) / 1000,
      linkedGoal: linkedGoal ? (linkedGoal as StrategyGoal).text : null,
      pillar,
      priorContentRelationship: rel,
      whyNow,
      historyNote: history === null ? NO_HISTORY : null,
      reasons,
    });
  }

  // Deterministic order: score desc, then pillar name, then title.
  scored.sort((a, b) => b.score - a.score || a.pillar.localeCompare(b.pillar) || a.topic.title.localeCompare(b.topic.title));

  // Assemble the shortlist. No mechanical rotation: a leading pillar may fill
  // most slots; a soft penalty only stops one pillar taking everything when
  // scores are close (third and later picks from one pillar lose 15%).
  const capacity = Math.max(0, input.capacity);
  const altCount = Math.max(0, input.alternatives ?? 0);
  const picked: RankedTopic[] = [];
  const pool = [...scored];
  while (picked.length < capacity + altCount && pool.length) {
    const perPillar: Record<string, number> = {};
    for (const p of picked) perPillar[p.pillar] = (perPillar[p.pillar] ?? 0) + 1;
    let bestIdx = 0;
    let bestVal = -Infinity;
    pool.forEach((c, idx) => {
      const n = perPillar[c.pillar] ?? 0;
      const v = n >= 2 ? c.score * 0.85 : c.score;
      if (v > bestVal) {
        bestVal = v;
        bestIdx = idx;
      }
    });
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  picked.forEach((p, i) => (p.rank = i + 1));
  return { recommended: picked.slice(0, capacity), alternatives: picked.slice(capacity), excluded, historyNote, pillarFilmedCounts };
}

// ---------------------------------------------------------------------------
// THE CLIENT'S REASON (6.3, unified handoff Sep 25 2026).
//
// `whyNow` is the ranking's own account for staff — "in the bank with no goal,
// phase or history signal attached — a filler, not a priority", "verified
// performance signal in this pillar". None of that is a sentence to put in
// front of a client. This builds the one short line a client reads beside a
// recommended topic, from three facts only: the strategy goal the topic
// supports, the pillar it rebalances, and the filmed video it builds on. When
// none applies it says what is true — the topic fits their pillar — and never
// borrows a staff word (filler, signal, score, verified, rank).
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s);

export function clientReasonFor(r: Pick<RankedTopic, "linkedGoal" | "pillar" | "priorContentRelationship" | "reasons">, ctx: { pillarFilmedCounts?: Record<string, number> | null } = {}): string {
  const pillar = r.pillar && !/^\(?\s*no\s+pillar/i.test(r.pillar) ? r.pillar : null;
  if (r.linkedGoal) return `Supports your goal: ${clip(r.linkedGoal.replace(/[.\s]+$/, ""), 90)}.`;
  const counts = ctx.pillarFilmedCounts;
  if (pillar && counts) {
    const mine = counts[pillar] ?? 0;
    const most = Math.max(0, ...Object.values(counts));
    if (most > mine) return `Balances your videos: fewer ${pillar} videos so far.`;
  }
  if (r.priorContentRelationship === "follow-up" || r.priorContentRelationship === "sequel") {
    const m = /(?:new angle to filmed content|deliberate (?:sequel|follow-up)).*?[“"]([^”"]+)[”"]/.exec(r.reasons.join(" "));
    return m ? `A fresh angle on “${clip(m[1], 70)}”.` : "A fresh angle on a video you've already made.";
  }
  return pillar ? `A strong fit for your ${pillar} content.` : "A strong fit for your content strategy.";
}
