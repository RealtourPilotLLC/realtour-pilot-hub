// READ-ONLY export of every content-program table to one JSON file.
//
// Jordan, Sep 16 2026, on authorising live-database work for the portal
// rebuild: "Claude should still preserve existing client records and take a
// backup before schema changes." This is that backup — the layer that is
// always available, because it needs nothing but the Prisma client. A full
// pg_dump is the gold standard and should be taken as well when the tooling is
// installed; this one exists so "no pg_dump on this machine" is never a reason
// to skip the step.
//
// WHAT THE SEP 17 AUDIT FOUND. This listed NINE tables — the program as it
// stood before the rebuild — plus the enrolled clients. Everything the Content
// Program Operating System added was missing: strategy and script VERSIONS,
// pillars, topics and their events, interviews, the video library, client
// decisions and facts, releases, reminders, assets, call records, AI runs,
// import batches, publishing. A ContentScript row in the old backup could
// point at an approvedVersionId whose row was not in the file at all, so the
// "backup" recorded a pointer to nothing. The list below is now derived from
// the schema rather than remembered, and a model that cannot be read is a
// FAILURE, never a silent skip.
//
// Usage: npx tsx scripts/backup-content-program.ts <output.json>
// Output goes OUTSIDE the repo (it holds real client strategies and scripts).
// Never seeds, never resets, never writes to the database.
import { PrismaClient } from "@prisma/client";
import { writeFileSync, statSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { execSync } from "child_process";

const p = new PrismaClient();
const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: npx tsx scripts/backup-content-program.ts <output.json>");
  process.exit(2);
}

// Every model the program owns, in dependency order (parents first) so a
// restore can walk the file top to bottom without dangling a required parent.
const MODELS = [
  // The people and the accounts they sign in with.
  "Client", "ClientUser", "ClientMembership", "ClientEmailAlias", "AgentProfile",
  // Enrollment and the shape of a program.
  "ProgramSignup", "ContentEnrollment", "ProgramOwnerAssignment", "ProgramEnrollmentChange",
  "ProgramOnboarding", "ContentMonth",
  // Strategy, versioned.
  "ContentStrategy", "ContentStrategyVersion", "ContentStrategyProposal",
  "ContentPillar", "ContentPillarAlias",
  // Topics and how they moved.
  "ContentTopic", "ContentTopicEvent", "ContentTopicSelection", "ContentTopicRefreshRun", "ContentTopicSuggestion",
  // Interviews and scripts, versioned, with their release ledger.
  "ContentInterview", "ContentInterviewAnswer",
  "ContentScript", "ContentScriptVersion", "ContentScriptRelease", "ContentScriptMatch",
  "ProgramGenerationPolicyVersion",
  // The video library and what the client said about it.
  "ContentVideo", "ContentVideoSource", "ContentCutTranscript", "ContentCaptionDraft",
  "PortalVideo", "PortalComment", "PortalVisit", "PortalResource", "ScriptSuggestion",
  // What the client told us and what we decided.
  "ClientFact", "ClientDecision", "ContentNote", "RevisionBrief",
  "ClientAsset", "ClientAssetVersion",
  // Calls, transcripts and the machinery behind them.
  "ProgramSessionRequest", "ProgramCalendlyEventMapping", "ProgramCallRecord",
  "ProgramTranscriptSource", "ProgramTranscriptJob",
  // Imports, automation, publishing, AI accounting.
  "ContentImportBatch", "ContentImportItem",
  "ProgramReminder", "ProgramAutomation", "ProgramPublishingAccount", "ProgramPublishingJob",
  "ProgramAiRun", "ProgramAiQuota",
  // Completion audit batches B–D (Sep 24 2026, schema e26cacd): brand-field
  // history, the booking/address ledgers, library corrections, and the
  // program conversation with its read markers.
  "ClientBrandChange", "ProgramBookingAttempt", "ProgramSessionAddress", "ContentVideoCorrection",
  "ProgramMessage", "ProgramMessageRead",
] as const;

const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

async function main() {
  const dump: Record<string, unknown[]> = {};
  const failures: string[] = [];
  const client = p as unknown as Record<string, { findMany?: () => Promise<unknown[]> }>;

  for (const model of MODELS) {
    const d = client[delegateName(model)];
    if (!d?.findMany) {
      // A renamed or dropped model must STOP the backup, not vanish from it.
      failures.push(`${model}: no such model on the Prisma client (renamed or removed?)`);
      continue;
    }
    try {
      dump[model] = await d.findMany();
      console.log(`  ${model.padEnd(32)} ${String(dump[model].length).padStart(6)} rows`);
    } catch (e) {
      failures.push(`${model}: ${(e as Error).message}`);
    }
  }

  if (failures.length) {
    console.error(`\nBACKUP INCOMPLETE — ${failures.length} model(s) could not be read:`);
    for (const f of failures) console.error(`  ${f}`);
    console.error("\nNothing was written. Fix the list above (the schema has moved) and run it again.");
    process.exit(1);
  }

  // WHAT THIS FILE CAN BE RESTORED INTO. A dump is only meaningful against the
  // schema that produced it, so the file carries its own identity: the commit
  // and a hash of schema.prisma. A restore that finds a different hash is
  // restoring across a migration and should say so out loud.
  let commit = "unknown";
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  let schemaHash = "unknown";
  try { schemaHash = createHash("sha256").update(readFileSync("prisma/schema.prisma")).digest("hex").slice(0, 16); } catch { /* not in the repo root */ }

  const rows = Object.values(dump).reduce((a, b) => a + b.length, 0);
  writeFileSync(OUT, JSON.stringify({
    takenAt: new Date().toISOString(),
    commit,
    schemaHash,
    models: MODELS,
    rows,
    tables: dump,
  }, null, 1));
  console.log(`\n${MODELS.length} models, ${rows} rows`);
  console.log(`wrote ${OUT} (${(statSync(OUT).size / 1048576).toFixed(2)} MB) · commit ${commit.slice(0, 8)} · schema ${schemaHash}`);
}
main().finally(() => p.$disconnect());
