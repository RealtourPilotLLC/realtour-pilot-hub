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
//
// SEP 28 2026 (A02-backup-coverage). The hand list had fallen behind again:
// ContentReviewWindow, ContentRevisionRound, ContentFilmingReport and
// ContentTopicFolder (batches B-D) and the four scheduling models of Sep 26
// were program tables this file did not hold — exactly the "hard-coded
// count" failure the Sep 17 audit fixed once already. So every model in the
// schema must now be named in ONE of two lists below: the program's, or the
// operational core's (which backup-all.ts covers). A model in neither stops
// the backup before it connects, naming it; the next person to add a model
// has to decide where it belongs. The connection is read-only and proven so
// (SQLSTATE 25006), and the file is written 0600.
import { writeFileSync, statSync, readFileSync, chmodSync } from "fs";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { Prisma } from "@prisma/client";
import { pinReadOnlyDatabaseUrl, proveReadOnly } from "./_lib/dbGuard";

// Every model the program owns, in dependency order (parents first) so a
// restore can walk the file top to bottom without dangling a required parent.
export const MODELS = [
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
  // Review windows, the per-video revision ledger, filming reports and topic
  // folders (CP-02/03/09), then the Sep 26 scheduling models: the exact-address
  // plan, creative holds, reassessments and portal-booked calls.
  "ContentReviewWindow", "ContentRevisionRound", "ContentFilmingReport", "ContentTopicFolder",
  "ProgramSessionPlan", "ProgramCreativeHold", "ProgramSessionReassessment", "ProgramCallBooking",
] as const;

/**
 * Everything else in the schema: the operational core (jobs, cuts, pay,
 * money, comms, the platform's own machinery). NOT in this file; backup-all.ts
 * holds every model. Listed so that "not in the program backup" is a decision
 * somebody made, not an omission nobody saw.
 */
export const OPERATIONAL_CORE = [
  // People, jobs and what they owe.
  "TeamMember", "Appointment", "Contact", "Project", "Deliverable", "DeliverableOutput", "UploadedFile",
  "ChecklistItem", "Activity", "OrderItem", "Product", "SmartTask", "ProjectMessage", "ThreadRead",
  // Review, QC, revisions and the editors' work.
  "ImageFlag", "MediaNote", "ReviewSubmission", "MediaVerdict", "QcRecord", "TopazJob",
  "EditorWorkItem", "EditorWorkEvent", "CutReviewerEvent", "CutSelfCheck", "RevisionIssue", "RevisionIssueEvent",
  "UploadDraft", "ProductionGap", "EditorDispatch", "CapacityException", "PhotoEditBatch", "ReworkCost",
  // Pay and money.
  "PayrollEntry", "Expense", "CashSnapshot", "StripeTransaction", "JobPayOverride", "PayoutAdjustment",
  "QboTransaction", "BonusPeriod", "BonusAward", "MileageDay", "SavingsItem", "PlaidItem", "PlaidAccount",
  "PlaidTransaction", "FinanceReport", "BudgetTarget", "MarginSnapshot", "GrowthPlan", "VendorBalanceReading",
  // Knowledge, training and the owner's own tools.
  "Resource", "Sop", "TrainingLesson", "KnowledgeItem", "HubChat", "HubMessage", "HubDocument",
  "OwnerTodo", "OwnerMeeting", "Feedback", "PlatformFeedback",
  // Platform machinery: sign-in, settings, integrations, logs, messaging rails.
  "AppUser", "AppSetting", "Connection", "WebhookEvent", "CronRun", "UsageEvent", "AuditLog",
  "Notification", "NotificationDelivery", "OutboxMessage", "PendingSms", "CommLog",
] as const;

/** Schema models in neither list, and listed names the schema does not have. */
export function unclassifiedModels(schemaModels: readonly string[]): { unlisted: string[]; unknown: string[]; both: string[] } {
  const program = new Set<string>(MODELS);
  const core = new Set<string>(OPERATIONAL_CORE);
  const inSchema = new Set(schemaModels);
  return {
    unlisted: schemaModels.filter((m) => !program.has(m) && !core.has(m)),
    unknown: [...program, ...core].filter((m) => !inSchema.has(m)),
    both: [...program].filter((m) => core.has(m)),
  };
}

const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

async function main(OUT: string) {
  const schemaModels = Prisma.dmmf.datamodel.models.map((m) => m.name);
  const cls = unclassifiedModels(schemaModels);
  if (cls.unlisted.length || cls.unknown.length || cls.both.length) {
    console.error("BACKUP REFUSED — the model lists no longer match the schema. Nothing was read or written.");
    if (cls.unlisted.length) console.error(`  in the schema but in neither list (add each to MODELS or OPERATIONAL_CORE): ${cls.unlisted.join(", ")}`);
    if (cls.unknown.length) console.error(`  listed but not in the schema (renamed or removed?): ${cls.unknown.join(", ")}`);
    if (cls.both.length) console.error(`  in both lists: ${cls.both.join(", ")}`);
    process.exit(1);
  }

  pinReadOnlyDatabaseUrl();
  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient();
  try {
    await proveReadOnly(p);
    console.log("read-only connection proven (25006)");
    await dumpTo(p, OUT);
  } finally {
    await p.$disconnect();
  }
}

async function dumpTo(p: unknown, OUT: string) {
  const dump: Record<string, unknown[]> = {};
  const failures: string[] = [];
  const client = p as Record<string, { findMany?: () => Promise<unknown[]> }>;

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
  }, null, 1), { mode: 0o600 });
  chmodSync(OUT, 0o600); // `mode` only applies when the file is created
  console.log(`\n${MODELS.length} models, ${rows} rows`);
  console.log(`wrote ${OUT} (${(statSync(OUT).size / 1048576).toFixed(2)} MB, mode 600) · commit ${commit.slice(0, 8)} · schema ${schemaHash}`);
}

if (require.main === module) {
  const OUT = process.argv[2];
  if (!OUT) {
    console.error("usage: npx tsx scripts/backup-content-program.ts <output.json>");
    process.exit(2);
  }
  main(OUT).catch((e) => { console.error(String((e as Error)?.message ?? e).split("\n")[0]); process.exit(1); });
}
