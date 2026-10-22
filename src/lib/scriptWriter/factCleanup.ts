import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// THE ONE-TIME FACT CLEANUP (Oct 22 2026, Jordan's decision 3): "it should
// analyze the call for the script topics chosen, and use what the agent said
// about that topic, with discernment on what they said." The cleanup of the
// ~870 facts waiting for review is approved, "but it should leave out
// anything that doesn't need to be heard by a seller or buyer."
//
// Every PROPOSED ClientFact (field reports excepted: the office confirms those
// on their own list) is sorted by AI into:
//   SCRIPT  a buyer or seller should hear it: her experience, process,
//           expertise, opinions, stories, service facts
//           → --apply: ACCEPTED, aiContext ALLOWED, reviewedBy "ai-cleanup-oct22"
//   TEAM    useful to us, not for an audience: production preferences,
//           scheduling, billing, contacts, internal notes
//           → --apply: ACCEPTED, aiContext UNCHANGED (so never script context),
//             reviewedBy "ai-cleanup-oct22:team" (the script writer skips it)
//   DROP    duplicate, stale, wrong or conflicting
//           → --apply: left PROPOSED for a person, the reason on the row's
//             reviewedBy note ("ai-cleanup-oct22 suggests dropping: ...", the
//             one free text the Facts tab shows; there is no note column) and
//             in the report
// Code overrides the model where a rule is certain: a confidential fact, or a
// category that is never for an audience (production preference, internal,
// reported or measured performance, commitment), is never SCRIPT; a fact that
// conflicts with an accepted one is never accepted (a person decides which
// wins), so it is a DROP candidate.
//
// DRY RUN by default: classifies and writes the report (and the
// classifications, so --apply applies exactly what the report shows) to the
// output folder, and changes NOTHING in the database. --apply writes, one row
// at a time, compare-and-set on the row's updatedAt and PROPOSED status: a
// fact someone touched since it was classified is skipped and listed.
// Idempotent and resumable: a fact already applied is no longer PROPOSED; a
// DROP already noted is skipped; classifications already in the folder for an
// unchanged fact are reused, not paid for twice.
// ---------------------------------------------------------------------------

export const CLEANUP_REVIEWER = "ai-cleanup-oct22";
export const TEAM_REVIEWER = `${CLEANUP_REVIEWER}:team`;
export const DROP_NOTE_PREFIX = `${CLEANUP_REVIEWER} suggests dropping: `;
const NEVER_SCRIPT = new Set(["PRODUCTION_PREFERENCE", "INTERNAL", "PERFORMANCE_REPORTED", "PERFORMANCE_MEASURED", "COMMITMENT"]);
const BATCH = 40;

export type FactClass = "SCRIPT" | "TEAM" | "DROP";
export type CleanupFact = { id: string; clientId: string; category: string; body: string; source: string; speaker: string | null; confidential: boolean; conflictsWithId: string | null; aiContext: string; updatedAt: Date; factDate: Date | null; createdAt: Date };
export type Classified = { id: string; cls: FactClass; reason: string; by: "ai" | "rule"; updatedAt: string };
export type Classifier = (client: { id: string; name: string }, facts: CleanupFact[], accepted: string[]) => Promise<{ id: string; cls: string; reason: string }[]>;

export const CLEANUP_SYSTEM = `You sort ONE real estate agent's recorded facts for Realtour Pilot, a media agency that writes the agent's short social videos. Each fact was noted from a call or an old internal note and nobody has reviewed it yet. Put each fact in exactly one class, with one short reason.

SCRIPT: a home buyer or a home seller would benefit from hearing it in one of her videos: her experience and background, her process and how she advises clients, her expertise, her opinions about buying, selling or her market, her stories, the services she offers. Only what she presents as true about herself or her work.
TEAM: useful to Realtour Pilot but not for an audience: filming and editing preferences, scheduling and availability, billing, our package or pricing, contacts and logistics, internal notes about the account, how she feels about our service, reported video performance, things she or we promised to send.
DROP: a duplicate (of another fact in this list or of one already accepted, listed below), stale (no longer true, or tied to a past date or a finished event), wrong or garbled, or in conflict with another fact. Say which one it duplicates or conflicts with.

Private personal details (health, family trouble, money trouble) are never SCRIPT. When in doubt between SCRIPT and TEAM, choose TEAM. Never invent: judge only the fact's own words.`;

export const CLEANUP_SCHEMA = {
  type: "object", additionalProperties: false, required: ["facts"],
  properties: { facts: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "cls", "reason"], properties: { id: { type: "string" }, cls: { type: "string", enum: ["SCRIPT", "TEAM", "DROP"] }, reason: { type: "string" } } } } },
} as const;

export function cleanupPrompt(client: { name: string }, facts: CleanupFact[], accepted: string[]): string {
  return [
    `AGENT: ${client.name}`,
    accepted.length ? ["ALREADY ACCEPTED (for spotting duplicates):", ...accepted.slice(0, 60).map((a) => `- ${a.slice(0, 300)}`)].join("\n") : "ALREADY ACCEPTED: none.",
    ["FACTS TO SORT (id, category as noted, source, said by):", ...facts.map((f) => `[${f.id}] (${f.category}, ${f.source}${f.speaker ? `, said by ${f.speaker}` : ""}${f.factDate ? `, ${f.factDate.toISOString().slice(0, 10)}` : ""}) ${f.body.replace(/\s+/g, " ").slice(0, 600)}`)].join("\n"),
    "Sort every fact listed: one entry per id.",
  ].join("\n\n");
}

/** The model's answer for one batch, with the certain rules applied on top. Pure. */
export function settleClasses(facts: CleanupFact[], out: { id: string; cls: string; reason: string }[]): Classified[] {
  const res: Classified[] = [];
  for (const f of facts) {
    const got = out.find((o) => o?.id === f.id);
    const at = f.updatedAt.toISOString();
    if (f.conflictsWithId) { res.push({ id: f.id, cls: "DROP", reason: `conflicts with an accepted fact; a person decides which one stands${got?.reason ? ` (${got.reason})` : ""}`, by: "rule", updatedAt: at }); continue; }
    if (!got || !["SCRIPT", "TEAM", "DROP"].includes(got.cls)) continue; // unsorted: left alone, listed in the report
    let cls = got.cls as FactClass;
    let reason = String(got.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    let by: "ai" | "rule" = "ai";
    if (cls === "SCRIPT" && (f.confidential || NEVER_SCRIPT.has(f.category))) { cls = "TEAM"; by = "rule"; reason = `${f.confidential ? "confidential" : `a ${f.category.toLowerCase().replace(/_/g, " ")} is never for an audience`}${reason ? ` (AI said SCRIPT: ${reason})` : ""}`; }
    res.push({ id: f.id, cls, reason: reason || cls.toLowerCase(), by, updatedAt: at });
  }
  return res;
}

/** The AI classifier: the script writer's model path, medium effort, one call per batch. */
export function aiClassifier(requestedBy: string): Classifier {
  return async (client, facts, accepted) => {
    const { runAiJson } = await import("@/lib/aiRuns");
    const r = await runAiJson<{ facts: { id: string; cls: string; reason: string }[] }>({
      kind: "fact_extract", engine: "writer", effort: "medium", clientId: client.id, scope: { cleanup: "oct22", clientId: client.id, factIds: facts.map((f) => f.id) },
      promptKey: "fact-cleanup-oct22", promptVersion: "fact-cleanup.v1", requestedBy, unattended: false,
      system: CLEANUP_SYSTEM, prompt: cleanupPrompt(client, facts, accepted), schema: CLEANUP_SCHEMA as unknown as Record<string, unknown>, maxTokens: 12_000,
    });
    return Array.isArray(r.output?.facts) ? r.output.facts : [];
  };
}

export type CleanupResult = {
  apply: boolean;
  outDir: string;
  reportPath: string;
  classesPath: string;
  total: number;
  classified: number;
  unsorted: number;
  counts: Record<FactClass, number>;
  perClient: { clientId: string; name: string; SCRIPT: number; TEAM: number; DROP: number; unsorted: number }[];
  applied: Record<FactClass, number>;
  skippedChanged: string[];
};

/**
 * Run the cleanup. `db` is the database to read (and with apply, write);
 * `classify` sorts one batch. Dry run: the database is only read.
 */
export async function runFactCleanup(o: { db: PrismaClient; classify: Classifier; apply: boolean; outDir: string; onlyClientId?: string | null; now?: Date; log?: (s: string) => void }): Promise<CleanupResult> {
  const log = o.log ?? (() => {});
  const now = o.now ?? new Date();
  fs.mkdirSync(o.outDir, { recursive: true });
  const classesPath = path.join(o.outDir, "classes.json");
  const reportPath = path.join(o.outDir, "report.md");
  let cache: Record<string, Classified> = {};
  try { cache = JSON.parse(fs.readFileSync(classesPath, "utf8")) as Record<string, Classified>; } catch { cache = {}; }

  const facts = (await o.db.clientFact.findMany({
    // A NOT on a nullable column also drops the NULL rows in Prisma: the OR keeps them.
    where: { status: "PROPOSED", source: { not: "field" }, OR: [{ reviewedBy: null }, { NOT: { reviewedBy: { startsWith: DROP_NOTE_PREFIX } } }], ...(o.onlyClientId ? { clientId: o.onlyClientId } : {}) },
    orderBy: [{ clientId: "asc" }, { createdAt: "asc" }],
    select: { id: true, clientId: true, category: true, body: true, source: true, speaker: true, confidential: true, conflictsWithId: true, aiContext: true, updatedAt: true, factDate: true, createdAt: true },
  })) as CleanupFact[];
  const clientIds = [...new Set(facts.map((f) => f.clientId))];
  const names = new Map((clientIds.length ? await o.db.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name ?? "Client"]));
  const results = new Map<string, Classified>();
  for (const clientId of clientIds) {
    const mine = facts.filter((f) => f.clientId === clientId);
    const todo = mine.filter((f) => { const c = cache[f.id]; if (c && c.updatedAt === f.updatedAt.toISOString()) { results.set(f.id, c); return false; } return true; });
    if (!todo.length) continue;
    const accepted = (await o.db.clientFact.findMany({ where: { clientId, status: "ACCEPTED" }, select: { body: true }, take: 60, orderBy: { createdAt: "desc" } })).map((a) => a.body);
    const client = { id: clientId, name: names.get(clientId) ?? "Client" };
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      let out: { id: string; cls: string; reason: string }[] = [];
      try { out = await o.classify(client, batch, accepted); } catch (e) { log(`  ${client.name}: batch ${i / BATCH + 1} could not be sorted (${e instanceof Error ? e.message : String(e)}); left alone`); }
      for (const c of settleClasses(batch, out)) { results.set(c.id, c); cache[c.id] = c; }
      // Saved after every batch: a stopped run resumes without paying for these again.
      fs.writeFileSync(classesPath, JSON.stringify(cache, null, 1));
    }
    log(`  ${client.name}: ${mine.length} fact(s) sorted`);
  }

  const counts: Record<FactClass, number> = { SCRIPT: 0, TEAM: 0, DROP: 0 };
  for (const c of results.values()) counts[c.cls]++;
  const applied: Record<FactClass, number> = { SCRIPT: 0, TEAM: 0, DROP: 0 };
  const skippedChanged: string[] = [];
  if (o.apply) {
    for (const f of facts) {
      const c = results.get(f.id);
      if (!c) continue;
      // Compare-and-set: still PROPOSED, untouched since it was classified.
      const fence = { id: f.id, status: "PROPOSED", updatedAt: new Date(c.updatedAt) };
      const data =
        c.cls === "SCRIPT" ? { status: "ACCEPTED", aiContext: "ALLOWED", reviewedBy: CLEANUP_REVIEWER, reviewedAt: now }
        : c.cls === "TEAM" ? { status: "ACCEPTED", reviewedBy: TEAM_REVIEWER, reviewedAt: now }
        : { reviewedBy: `${DROP_NOTE_PREFIX}${c.reason}`.slice(0, 400) };
      const where = c.cls === "DROP" ? fence : { ...fence, confidential: c.cls === "SCRIPT" ? false : undefined, conflictsWithId: null };
      const r = await o.db.clientFact.updateMany({ where, data });
      if (r.count) applied[c.cls]++;
      else skippedChanged.push(f.id);
    }
  }

  // --- the report ---------------------------------------------------------------
  const perClient = clientIds.map((id) => {
    const mine = facts.filter((f) => f.clientId === id);
    const by = (k: FactClass) => mine.filter((f) => results.get(f.id)?.cls === k).length;
    return { clientId: id, name: names.get(id) ?? "Client", SCRIPT: by("SCRIPT"), TEAM: by("TEAM"), DROP: by("DROP"), unsorted: mine.filter((f) => !results.has(f.id)).length };
  }).sort((a, b) => b.SCRIPT + b.TEAM + b.DROP - (a.SCRIPT + a.TEAM + a.DROP));
  const bodyOf = new Map(facts.map((f) => [f.id, f]));
  const line = (c: Classified) => { const f = bodyOf.get(c.id)!; return `- [${f.id}] ${names.get(f.clientId) ?? ""}: ${f.body.replace(/\s+/g, " ").slice(0, 200)} _(${c.reason}${c.by === "rule" ? "; by rule" : ""})_`; };
  const all = [...results.values()];
  const md = [
    `# Fact cleanup, Oct 22 2026 (${o.apply ? "APPLIED" : "DRY RUN: nothing was changed"})`,
    "",
    `Generated ${now.toISOString()}. ${facts.length} waiting fact(s) read (field reports are not part of this; they keep their own review list).`,
    "",
    `| Class | Count | What --apply does |`,
    `|---|---|---|`,
    `| SCRIPT | ${counts.SCRIPT} | accepted, AI context ON, reviewed by ${CLEANUP_REVIEWER} |`,
    `| TEAM | ${counts.TEAM} | accepted, AI context unchanged (off), reviewed by ${TEAM_REVIEWER}; never used for scripts |`,
    `| DROP | ${counts.DROP} | left waiting for a person, with the reason as its note |`,
    `| not sorted | ${facts.length - all.length} | left alone |`,
    ...(o.apply ? ["", `Applied: SCRIPT ${applied.SCRIPT}, TEAM ${applied.TEAM}, DROP notes ${applied.DROP}. Skipped because the fact changed after it was sorted: ${skippedChanged.length}${skippedChanged.length ? ` (${skippedChanged.join(", ")})` : ""}.`] : []),
    "",
    "## Per client",
    "",
    "| Client | SCRIPT | TEAM | DROP | not sorted |",
    "|---|---|---|---|---|",
    ...perClient.map((p) => `| ${p.name} | ${p.SCRIPT} | ${p.TEAM} | ${p.DROP} | ${p.unsorted} |`),
    "",
    ...(["SCRIPT", "TEAM"] as const).flatMap((k) => [`## ${k}: 10 samples`, "", ...all.filter((c) => c.cls === k).slice(0, 10).map(line), ""]),
    "## Every DROP, with its reason",
    "",
    ...all.filter((c) => c.cls === "DROP").map(line),
    "",
    "## What changes for other AI features after --apply",
    "",
    "Accepted, AI-allowed facts are read by these, so SCRIPT facts start reaching them (TEAM facts do not: their AI context stays off):",
    "- the current script writer, topic bank and interview planning (contentGeneration.buildClientContext, newest 40 accepted facts);",
    "- the creative identity, rebuilt when a strategy is approved (creativeIdentity.ts, 40 facts);",
    "- the agent profile draft (contentPipeline.ts, 60 facts);",
    "- the topic interview's profile hints (contentInterview.ts: decision, commitment, feedback, reported performance, brand preference categories);",
    "- the CLIENT-VISIBLE portal Profile prefill (portalPrefill.ts: brand preference, production preference and decision categories), rebuilt within a week of its last build. SCRIPT facts are her own words for an audience, so this is her own material shown back to her;",
    "- the editor brief reads production preferences only, which are never SCRIPT, so it does not change; the working profile reads field reports only, which are not part of this.",
  ].join("\n");
  fs.writeFileSync(reportPath, md);
  return { apply: o.apply, outDir: o.outDir, reportPath, classesPath, total: facts.length, classified: all.length, unsorted: facts.length - all.length, counts, perClient, applied, skippedChanged };
}
