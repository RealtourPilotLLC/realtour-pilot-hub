// ---------------------------------------------------------------------------
// REPAIR: the TEST portal's fixture wording (U02, unified handoff Sep 25 2026).
//
//   npx tsx scripts/repair-test-fixture-wording.ts                 → dry run (default)
//   npx tsx scripts/repair-test-fixture-wording.ts --write         → apply
//   npx tsx scripts/repair-test-fixture-wording.ts --write --backup-dir=/path
//
// WHAT IT FIXES. `create-test-client.ts --scenarios` wrote demo rows whose
// wording was for developers: a pillar named "Acceptance pillar" whose purpose
// read "[§25 acceptance fixture] a pillar for the §25 walkthrough", topics
// whose concept was "Discussed on the acceptance call.", and refresh
// suggestions whose description carried the marker (it becomes the topic's
// concept if accepted). Jordan demos that portal. This renames the pillar to
// coherent sample content (the old name kept as a PREVIOUS alias, the way
// contentPillars.renamePillar does it, so a script's frozen category still
// resolves), gives each topic its own concept, and moves the marker in a
// suggestion from its description to its staff-only rationale.
//
// WHAT IT REFUSES. Anything whose client is not a TEST client
// (src/lib/testClients.isTestClientName) — listed, never written; a pillar not
// made by the fixture (createdBy "acceptance-fixture"); a topic without the
// marker in its staff notes; a value that is no longer the old wording (a
// person changed it — theirs stands). Script versions are immutable and are
// never touched: the portal resolves a script's category by pillar id (U01).
//
// SAFETY. Dry run by default, on a connection opened with
// default_transaction_read_only=on. --write first saves every before-row to
// ~/rtp-backup-<date>-test-fixture-wording.json (outside git), then writes each
// row with its old value in the WHERE, then reads back and asserts that no
// non-TEST row was touched. Idempotent: a second run finds nothing to do.
// Proven on PGlite only (scripts/_drill/b2-scripts-topics.ts §U02); the main
// session runs it on production.
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTestClientName } from "../src/lib/testClients";

/** Every row create-test-client writes for §25 carries this, so a re-run tops up and a reader can tell. */
export const SCENARIO_TAG = "[§25 acceptance fixture]";
/** Who made the fixture pillar — how it is found again (never by its name). */
export const FIXTURE_PILLAR_BY = "acceptance-fixture";
/** Coherent sample content for the TEST portal. */
export const FIXTURE_PILLAR = { name: "Seller Playbook", purpose: "Walk sellers through the decisions that move their result" } as const;
export const LEGACY_FIXTURE_PILLAR_NAME = "Acceptance pillar";
export const LEGACY_FIXTURE_CONCEPT = "Discussed on the acceptance call.";
export const FIXTURE_TOPICS: readonly { title: string; concept: string }[] = [
  { title: "What a pre-listing inspection saves you", concept: "How an inspection before you list turns surprise repairs into decisions you make on your own schedule." },
  { title: "The three questions every seller forgets to ask", concept: "Three questions to ask before listing: when to launch, how to price, and what happens after the first offer." },
  { title: "Why the first weekend decides your price", concept: "How the first weekend of showings sets the price, and what to have ready before it." },
  { title: "A street-level tour of the neighbourhood", concept: "A walk through the streets, parks and shops buyers ask about most." },
  { title: "What staging actually costs in this market", concept: "A plain look at what staging costs locally and when it pays for itself." },
];
export const FIXTURE_SUGGESTION_CONCEPTS: Record<string, string> = {
  "An open-house walkthrough nobody films": "Filming the open house the way a buyer walks it, room by room.",
  "The one paragraph buyers actually read": "The one paragraph of a listing buyers read, and how to write it.",
};

type Db = PrismaClient;

export type WordingPlan = {
  pillars: { id: string; clientName: string; before: { name: string; purpose: string | null }; after: { name: string; purpose: string | null } }[];
  topics: { id: string; clientName: string; title: string; before: { concept: string | null; pillar: string | null }; after: { concept: string | null; pillar: string | null } }[];
  suggestions: { id: string; clientName: string; title: string; before: { description: string | null; rationale: string | null }; after: { description: string | null; rationale: string | null } }[];
  /** Matched the wording but NOT a TEST client (or not the fixture's) — never written. */
  refused: { table: string; id: string; clientName: string; why: string }[];
};

async function clientNamesFor(db: Db, enrollmentIds: string[], clientIds: string[]): Promise<{ byEnrollment: Map<string, string>; byClient: Map<string, string> }> {
  const enrollments = enrollmentIds.length ? await db.contentEnrollment.findMany({ where: { id: { in: [...new Set(enrollmentIds)] } }, select: { id: true, clientId: true } }) : [];
  const ids = [...new Set([...clientIds, ...enrollments.map((e) => e.clientId)])];
  const clients = ids.length ? await db.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const byClient = new Map(clients.map((c) => [c.id, c.name ?? ""]));
  return { byEnrollment: new Map(enrollments.map((e) => [e.id, byClient.get(e.clientId) ?? ""])), byClient };
}

/** Read-only: what a --write would change, and what it refuses. */
export async function planFixtureWordingRepair(db: Db): Promise<WordingPlan> {
  const plan: WordingPlan = { pillars: [], topics: [], suggestions: [], refused: [] };
  const pillars = await db.contentPillar.findMany({
    where: { OR: [{ createdBy: FIXTURE_PILLAR_BY }, { name: LEGACY_FIXTURE_PILLAR_NAME }, { purpose: { contains: SCENARIO_TAG } }] },
    select: { id: true, enrollmentId: true, clientId: true, name: true, purpose: true, createdBy: true },
  });
  const topics = await db.contentTopic.findMany({
    where: { OR: [{ notes: { contains: SCENARIO_TAG } }, { concept: LEGACY_FIXTURE_CONCEPT }, { pillar: LEGACY_FIXTURE_PILLAR_NAME }] },
    select: { id: true, enrollmentId: true, clientId: true, title: true, concept: true, pillar: true, notes: true },
  });
  const suggestions = await db.contentTopicSuggestion.findMany({
    where: { description: { startsWith: SCENARIO_TAG } },
    select: { id: true, enrollmentId: true, clientId: true, title: true, description: true, rationale: true, disposition: true },
  });
  const names = await clientNamesFor(db, [...pillars, ...topics, ...suggestions].map((r) => r.enrollmentId), [...pillars, ...topics, ...suggestions].map((r) => r.clientId));
  const nameOf = (r: { enrollmentId: string; clientId: string }) => names.byClient.get(r.clientId) ?? names.byEnrollment.get(r.enrollmentId) ?? "";
  // Both the row's own client AND its enrollment's client must be TEST: a row
  // whose two pointers disagree is not one this script can call synthetic.
  const isTest = (r: { enrollmentId: string; clientId: string }) => isTestClientName(names.byClient.get(r.clientId) ?? "") && isTestClientName(names.byEnrollment.get(r.enrollmentId) ?? "");

  for (const p of pillars) {
    if (!isTest(p)) { plan.refused.push({ table: "ContentPillar", id: p.id, clientName: nameOf(p), why: "not a TEST client" }); continue; }
    if (p.createdBy !== FIXTURE_PILLAR_BY) { plan.refused.push({ table: "ContentPillar", id: p.id, clientName: nameOf(p), why: `not the fixture's pillar (createdBy ${p.createdBy ?? "none"})` }); continue; }
    const after = {
      name: p.name === LEGACY_FIXTURE_PILLAR_NAME ? FIXTURE_PILLAR.name : p.name,
      purpose: p.purpose && p.purpose.includes(SCENARIO_TAG) ? FIXTURE_PILLAR.purpose : p.purpose,
    };
    if (after.name !== p.name || after.purpose !== p.purpose) plan.pillars.push({ id: p.id, clientName: nameOf(p), before: { name: p.name, purpose: p.purpose }, after });
  }
  for (const t of topics) {
    if (!isTest(t)) { plan.refused.push({ table: "ContentTopic", id: t.id, clientName: nameOf(t), why: "not a TEST client" }); continue; }
    if (!(t.notes ?? "").includes(SCENARIO_TAG)) { plan.refused.push({ table: "ContentTopic", id: t.id, clientName: nameOf(t), why: "no fixture marker in its staff notes" }); continue; }
    const fixture = FIXTURE_TOPICS.find((f) => f.title === t.title);
    const after = {
      concept: t.concept === LEGACY_FIXTURE_CONCEPT ? fixture?.concept ?? null : t.concept,
      pillar: t.pillar === LEGACY_FIXTURE_PILLAR_NAME ? FIXTURE_PILLAR.name : t.pillar,
    };
    if (t.concept === LEGACY_FIXTURE_CONCEPT && !fixture) { plan.refused.push({ table: "ContentTopic", id: t.id, clientName: nameOf(t), why: `no sample concept for "${t.title}"` }); continue; }
    if (after.concept !== t.concept || after.pillar !== t.pillar) plan.topics.push({ id: t.id, clientName: nameOf(t), title: t.title, before: { concept: t.concept, pillar: t.pillar }, after });
  }
  for (const s of suggestions) {
    if (!isTest(s)) { plan.refused.push({ table: "ContentTopicSuggestion", id: s.id, clientName: nameOf(s), why: "not a TEST client" }); continue; }
    plan.suggestions.push({
      id: s.id, clientName: nameOf(s), title: s.title,
      before: { description: s.description, rationale: s.rationale },
      after: { description: FIXTURE_SUGGESTION_CONCEPTS[s.title] ?? null, rationale: s.rationale ?? s.description },
    });
  }
  return plan;
}

export type RepairResult = {
  plan: WordingPlan;
  backupPath: string | null;
  written: { pillars: number; topics: number; suggestions: number };
  /** Rows written whose client is not TEST. Must be 0; the write refuses to finish otherwise. */
  nonTestTouched: number;
};

/**
 * Dry run (write: false) returns the plan and writes nothing. With write: true
 * it backs up, writes each row guarded by its old value, reads back.
 */
export async function repairTestFixtureWording(db: Db, opts: { write: boolean; backupDir?: string; now?: Date; log?: (line: string) => void } = { write: false }): Promise<RepairResult> {
  const log = opts.log ?? (() => {});
  const plan = await planFixtureWordingRepair(db);
  const result: RepairResult = { plan, backupPath: null, written: { pillars: 0, topics: 0, suggestions: 0 }, nonTestTouched: 0 };
  if (!opts.write) return result;
  if (!plan.pillars.length && !plan.topics.length && !plan.suggestions.length) { log("nothing to write"); return result; }

  // 1. THE BACKUP, before any write — outside git, never into the repo.
  const now = opts.now ?? new Date();
  const dir = opts.backupDir ?? os.homedir();
  const repo = path.resolve(__dirname, "..");
  if (path.resolve(dir).startsWith(repo + path.sep) || path.resolve(dir) === repo) throw new Error(`refusing to write the backup inside the repository (${dir})`);
  const stamp = now.toISOString().slice(0, 10);
  let file = path.join(dir, `rtp-backup-${stamp}-test-fixture-wording.json`);
  if (fs.existsSync(file)) file = path.join(dir, `rtp-backup-${stamp}-test-fixture-wording-${now.getTime()}.json`);
  const before = {
    takenAt: now.toISOString(),
    pillars: await db.contentPillar.findMany({ where: { id: { in: plan.pillars.map((p) => p.id) } } }),
    pillarAliases: await db.contentPillarAlias.findMany({ where: { pillarId: { in: plan.pillars.map((p) => p.id) } } }),
    topics: await db.contentTopic.findMany({ where: { id: { in: plan.topics.map((t) => t.id) } } }),
    suggestions: await db.contentTopicSuggestion.findMany({ where: { id: { in: plan.suggestions.map((s) => s.id) } } }),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(before, null, 2));
  result.backupPath = file;
  log(`backup: ${file}`);

  // 2. THE WRITES — each guarded by the value it replaces.
  for (const p of plan.pillars) {
    const r = await db.contentPillar.updateMany({ where: { id: p.id, name: p.before.name, purpose: p.before.purpose }, data: { name: p.after.name, purpose: p.after.purpose } });
    result.written.pillars += r.count;
    if (r.count && p.before.name !== p.after.name) {
      // The rename keeps every old document resolvable (contentPillars.renamePillar's rule).
      await db.contentPillarAlias.updateMany({ where: { pillarId: p.id, name: p.before.name, kind: "CANONICAL" }, data: { kind: "PREVIOUS", validTo: now } });
      await db.contentPillarAlias.upsert({
        where: { pillarId_name: { pillarId: p.id, name: p.before.name } },
        create: { pillarId: p.id, name: p.before.name, kind: "PREVIOUS", validTo: now, source: "manual", approvedBy: "repair-test-fixture-wording" },
        update: {},
      });
      await db.contentPillarAlias.upsert({
        where: { pillarId_name: { pillarId: p.id, name: p.after.name } },
        create: { pillarId: p.id, name: p.after.name, kind: "CANONICAL", validFrom: now, source: "manual", approvedBy: "repair-test-fixture-wording" },
        update: { kind: "CANONICAL", validTo: null },
      });
    }
  }
  for (const t of plan.topics) {
    const r = await db.contentTopic.updateMany({ where: { id: t.id, concept: t.before.concept, pillar: t.before.pillar }, data: { concept: t.after.concept, pillar: t.after.pillar } });
    result.written.topics += r.count;
  }
  for (const s of plan.suggestions) {
    const r = await db.contentTopicSuggestion.updateMany({ where: { id: s.id, description: s.before.description }, data: { description: s.after.description, rationale: s.after.rationale } });
    result.written.suggestions += r.count;
  }

  // 3. READBACK — every written row's client is TEST, and the wording is gone.
  const names = await clientNamesFor(db, [], [
    ...(await db.contentPillar.findMany({ where: { id: { in: plan.pillars.map((p) => p.id) } }, select: { clientId: true } })).map((r) => r.clientId),
    ...(await db.contentTopic.findMany({ where: { id: { in: plan.topics.map((t) => t.id) } }, select: { clientId: true } })).map((r) => r.clientId),
    ...(await db.contentTopicSuggestion.findMany({ where: { id: { in: plan.suggestions.map((s) => s.id) } }, select: { clientId: true } })).map((r) => r.clientId),
  ]);
  result.nonTestTouched = [...names.byClient.values()].filter((n) => !isTestClientName(n)).length;
  if (result.nonTestTouched) throw new Error(`readback: ${result.nonTestTouched} non-TEST client(s) among the written rows — restore from ${file}`);
  log(`written: ${result.written.pillars} pillar(s), ${result.written.topics} topic(s), ${result.written.suggestions} suggestion(s); non-TEST rows touched: 0`);
  return result;
}

/** The dry run's connection refuses writes at the database, not just in this file. */
function readOnlyDatabaseUrl(): string {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    for (const file of [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../.env")]) {
      if (!fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
      if (m) { url = m[1].trim().replace(/^["']|["']$/g, ""); break; }
    }
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to dry-run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const backupDir = args.find((a) => a.startsWith("--backup-dir="))?.slice("--backup-dir=".length) || undefined;
  const db = write ? new PrismaClient() : new PrismaClient({ datasourceUrl: readOnlyDatabaseUrl() });
  try {
    if (!write) {
      // Prove the connection cannot write before reading anything.
      const refused = await db.$executeRawUnsafe("CREATE TEMP TABLE repair_wording_probe (x int)").then(() => false).catch(() => true);
      if (!refused) throw new Error("the dry-run connection accepted a write — refusing to continue");
    }
    const r = await repairTestFixtureWording(db, { write, backupDir, log: (l) => console.log(l) });
    const p = r.plan;
    console.log(`\n${write ? "APPLIED" : "DRY RUN (nothing written)"} — test fixture wording`);
    for (const x of p.pillars) console.log(`  pillar     ${x.id} [${x.clientName}]  "${x.before.name}" → "${x.after.name}"${x.before.purpose !== x.after.purpose ? `; purpose → "${x.after.purpose}"` : ""}`);
    for (const x of p.topics) console.log(`  topic      ${x.id} [${x.clientName}]  "${x.title}": concept "${x.before.concept}" → "${x.after.concept}"${x.before.pillar !== x.after.pillar ? `; pillar label → "${x.after.pillar}"` : ""}`);
    for (const x of p.suggestions) console.log(`  suggestion ${x.id} [${x.clientName}]  "${x.title}": description → "${x.after.description}" (marker kept in rationale)`);
    for (const x of p.refused) console.log(`  REFUSED    ${x.table} ${x.id} [${x.clientName}] — ${x.why}`);
    if (!p.pillars.length && !p.topics.length && !p.suggestions.length) console.log("  nothing to change");
    if (write) console.log(`\nbackup: ${r.backupPath ?? "(none — nothing to write)"} · written ${r.written.pillars}/${r.written.topics}/${r.written.suggestions} · non-TEST touched ${r.nonTestTouched}`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
