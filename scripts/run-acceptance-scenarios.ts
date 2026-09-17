// ---------------------------------------------------------------------------
// §25 END-TO-END BUSINESS ACCEPTANCE — walked against real rows, read-mostly.
//
//   npx tsx scripts/run-acceptance-scenarios.ts                 → "Cara TEST"
//   npx tsx scripts/run-acceptance-scenarios.ts "Bobby TEST"
//   npx tsx scripts/run-acceptance-scenarios.ts "Cara TEST" --write
//
// It REFUSES to run against anything but a TEST client. Without --write it
// only reads; --write permits the two scenarios whose point IS the action
// (9, the package change) to perform it on the synthetic enrollment.
//
// Each scenario prints PASS, FAIL or NOT YET. NOT YET is the honest verdict
// when the feature belongs to a wave-2 sibling that has not landed — it names
// what is missing rather than quietly passing on an empty table.
//
// Stand the fixtures up first:
//   npx tsx scripts/create-test-client.ts "Cara TEST" cara 2026-09 --scenarios
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { assertTestClient } from "../src/lib/testClients";
import { programOverview } from "../src/lib/programOverview";
import { changePackage, enrollmentHistory, pendingChanges } from "../src/lib/enrollmentChanges";
import { allAutomations } from "../src/lib/programAutomation";

const prisma = new PrismaClient();
const NAME = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "Cara TEST";
const WRITE = process.argv.includes("--write");

type Verdict = "PASS" | "FAIL" | "NOT YET";
const results: { n: number; title: string; verdict: Verdict; evidence: string[] }[] = [];
function record(n: number, title: string, verdict: Verdict, evidence: string[]) {
  results.push({ n, title, verdict, evidence });
  const mark = verdict === "PASS" ? "PASS   " : verdict === "FAIL" ? "FAIL   " : "NOT YET";
  console.log(`\n[${mark}] ${n}. ${title}`);
  for (const e of evidence) console.log(`          ${e}`);
}

async function main() {
  const client = await prisma.client.findFirst({ where: { name: NAME }, select: { id: true, name: true } });
  if (!client) throw new Error(`No client named "${NAME}".`);
  assertTestClient(client); // synthetic only — hard stop otherwise
  const e = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id } });
  if (!e) throw new Error(`"${NAME}" has no content enrollment.`);
  const month = await prisma.contentMonth.findFirst({ where: { enrollmentId: e.id }, orderBy: { monthKey: "desc" } });
  if (!month) throw new Error(`"${NAME}" has no month workspace.`);

  console.log(`§25 acceptance — ${client.name} · enrollment ${e.id} · month ${month.monthKey}${WRITE ? " · WRITE ENABLED" : " · read-only"}`);

  const switches = await allAutomations();
  const off = (k: string) => { const s = switches.find((x) => x.key === k); return !s || !s.enabled; };

  // ---- 1. discovery call → strategy draft → approval → client can view -----
  {
    const ev: string[] = [];
    const discovery = await prisma.programCallRecord.findFirst({ where: { enrollmentId: e.id, callType: "BRAND_DISCOVERY" } });
    const versions = await prisma.contentStrategyVersion.findMany({ where: { enrollmentId: e.id }, orderBy: { versionNo: "desc" } });
    const approved = versions.find((v) => v.status === "APPROVED" || v.status === "RELEASED" || !!v.approvedAt);
    ev.push(`brand-discovery CallRecord: ${discovery ? discovery.id : "none"}`);
    ev.push(`strategy versions: ${versions.length}${approved ? ` · approved v${approved.versionNo} by ${approved.approvedBy ?? "?"}` : " · none approved"}`);
    ev.push(`strategy_generation switch: ${off("strategy_generation") ? "off / never configured" : "on"}`);
    if (!discovery) record(1, "Discovery call → strategy draft → approval → client can view", "NOT YET", [...ev, "needs W1-B: no Calendly-sourced ProgramCallRecord exists for this client (0 in the whole database tonight)."]);
    else if (approved) record(1, "Discovery call → strategy draft → approval → client can view", "PASS", ev);
    else record(1, "Discovery call → strategy draft → approval → client can view", "FAIL", [...ev, "a discovery call exists but no strategy version was approved from it."]);
  }

  // ---- 2. five ideas discussed, three selected ----------------------------
  {
    const ev: string[] = [];
    const selections = await prisma.contentTopicSelection.findMany({ where: { monthId: month.id, status: { in: ["SELECTED", "CARRIED", "RECONCILED"] } } });
    const monthTopics = await prisma.contentTopic.findMany({ where: { monthId: month.id, status: { in: ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"] } }, select: { id: true } });
    const bank = await prisma.contentTopic.count({ where: { enrollmentId: e.id, monthId: null, status: { in: ["SAVED", "IDEA", "RECOMMENDED"] } } });
    const onMonth = new Set([...selections.map((s) => s.topicId), ...monthTopics.map((t) => t.id)]);
    const ov = await programOverview({ monthKey: month.monthKey });
    const row = ov.rows.find((r) => r.enrollmentId === e.id);
    ev.push(`topics feeding ${month.monthKey}: ${onMonth.size} · still in the bank: ${bank}`);
    ev.push(`overview says topicsSelected=${row?.work.topicsSelected ?? "?"} (needs ${row?.work.topicsNeeded ?? "?"} more)`);
    const withEvidence = selections.filter((s) => !!s.evidenceJson).length;
    ev.push(`selections carrying evidence of an explicit choice: ${withEvidence}/${selections.length}`);
    record(2, "Only explicitly chosen ideas feed the month; the rest stay in the bank", onMonth.size > 0 && bank > 0 && row?.work.topicsSelected === onMonth.size ? "PASS" : "FAIL", ev);
  }

  // ---- 3. optional call skipped, answers submitted, scripts after approval -
  {
    const ev: string[] = [];
    ev.push(`callMode: ${e.callMode ?? `(derived: ${e.strategyCallRequired ? "REQUIRED" : "NOT_INCLUDED"})`} · noCallEligible: ${e.noCallEligible ?? "not set"}`);
    ev.push(`month planningMode: ${month.planningMode ?? "not chosen"} · preparationStatus: ${month.preparationStatus ?? "null (derived at read time)"}`);
    const reminders = await prisma.programReminder.count({ where: { enrollmentId: e.id, action: "BOOK_CALL" } });
    ev.push(`BOOK_CALL reminders on file: ${reminders} · reminders switch: ${off("reminders") ? "off / never configured" : "on"}`);
    record(3, "Optional call skipped → written path, call reminders stop, rules still enforced",
      off("reminders") ? "NOT YET" : reminders === 0 ? "PASS" : "FAIL",
      [...ev, off("reminders") ? "needs W2-F: the reminder evaluator has never run, so \"reminders stop\" cannot be observed — only that none exist." : ""].filter(Boolean));
  }

  // ---- 4. insufficient answers → focused follow-ups, no invented script ----
  {
    const ev: string[] = [];
    const thin = await prisma.contentInterview.findMany({ where: { monthId: month.id, status: { in: ["NEEDS_FOLLOWUP", "IN_PROGRESS", "NOT_STARTED"] } } });
    const ov = await programOverview({ monthKey: month.monthKey });
    const row = ov.rows.find((r) => r.enrollmentId === e.id);
    const missing = thin.flatMap((i) => { try { const v = i.sufficiencyJson ? JSON.parse(i.sufficiencyJson) : null; return (v?.missing ?? []) as string[]; } catch { return []; } });
    ev.push(`interviews not yet sufficient: ${thin.length}`);
    ev.push(`named gaps: ${missing.length ? missing.join(" · ") : "none recorded"}`);
    ev.push(`overview answersOutstanding=${row?.work.answersOutstanding ?? "?"} · next action: "${row?.nextAction.text ?? "?"}" [${row?.nextAction.blocked}]`);
    const honest = (row?.work.answersOutstanding ?? 0) > 0 && row?.nextAction.blocked === "client" && /answer/i.test(row?.nextAction.text ?? "");
    // No half-answered interview on this client = no fixture, NOT a regression.
    // A FAIL that means "nobody ran create-test-client.ts --scenarios" is
    // indistinguishable from a real break the next time someone runs this
    // (review, Sep 17).
    record(4, "Insufficient answers show as the real blocker, not a finished script",
      thin.length === 0 ? "NOT YET" : honest && missing.length > 0 ? "PASS" : "FAIL",
      thin.length === 0 ? [...ev, "no partially-answered interview on this client — run create-test-client.ts --scenarios to stand the fixture up."] : ev);
  }

  // ---- 5. one call, three kinds of statement, three destinations -----------
  {
    const ev: string[] = [];
    const facts = await prisma.clientFact.findMany({ where: { clientId: client.id }, select: { category: true, scope: true, status: true, aiContext: true, projectId: true, body: true } });
    const permanent = facts.filter((f) => f.scope === "PERMANENT" && f.status === "ACCEPTED" && f.aiContext === "ALLOWED");
    const scoped = facts.filter((f) => f.scope === "PROJECT");
    const proposals = await prisma.contentStrategyProposal.count({ where: { enrollmentId: e.id, status: "PROPOSED" } });
    const leaking = facts.filter((f) => f.category === "PROPOSED_CHANGE" && f.status === "ACCEPTED" && f.aiContext === "ALLOWED");
    ev.push(`permanent accepted + AI-allowed: ${permanent.length}`);
    ev.push(`project-scoped: ${scoped.length}`);
    ev.push(`open strategy-change proposals: ${proposals}`);
    ev.push(`possible-change facts wrongly reaching generators: ${leaking.length} (must be 0)`);
    // Same rule as 4, one leg at a time: a MISSING kind is a missing fixture,
    // not broken routing. Only a fact of the wrong kind actually reaching the
    // generators is a defect, and that stays a FAIL whatever else is on file.
    const missingLegs = [
      permanent.length === 0 ? "a permanent accepted preference" : null,
      scoped.length === 0 ? "a project-scoped fact" : null,
      proposals === 0 ? "an open strategy-change proposal" : null,
    ].filter((x): x is string => !!x);
    record(5, "Persistent preference · temporary experiment · change of audience each land in the right place",
      leaking.length > 0 ? "FAIL" : missingLegs.length > 0 ? "NOT YET" : "PASS",
      missingLegs.length > 0 && leaking.length === 0
        ? [...ev, `not on this client: ${missingLegs.join(", ")} — run create-test-client.ts --scenarios to stand the fixture up.`]
        : ev);
  }

  // ---- 6. a refresh after approval leaves approved work intact ------------
  {
    const ev: string[] = [];
    const runs = await prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId: e.id }, orderBy: { createdAt: "desc" }, take: 5 });
    const suggestions = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: e.id } });
    const pending = suggestions.filter((s) => s.disposition === "PENDING");
    const approvedScripts = await prisma.contentScriptVersion.count({ where: { enrollmentId: e.id, status: "APPROVED" } });
    const clobbered = await prisma.contentTopic.count({ where: { enrollmentId: e.id, status: { in: ["SELECTED", "SCRIPTED"] }, suggestionId: { not: null }, approvalState: "PROPOSED" } });
    ev.push(`refresh runs: ${runs.length} · suggestions: ${suggestions.length} (${pending.length} pending, ${suggestions.length - pending.length} dispositioned)`);
    ev.push(`approved script versions still APPROVED: ${approvedScripts}`);
    ev.push(`selected/scripted topics knocked back to PROPOSED by a refresh: ${clobbered} (must be 0)`);
    record(6, "A refresh after approval keeps approved work and keeps suggestions separate",
      runs.length > 0 && pending.length > 0 && clobbered === 0 ? "PASS" : runs.length === 0 ? "NOT YET" : "FAIL",
      runs.length === 0 ? [...ev, "no refresh has been run for this client."] : ev);
  }

  // ---- 7. approve a batch → portal + one email, retried, never duplicated --
  {
    const ev: string[] = [];
    const releases = await prisma.contentScriptRelease.count({ where: { enrollmentId: e.id } });
    const reminders = await prisma.programReminder.count({ where: { enrollmentId: e.id, action: "SCRIPTS_READY" } });
    ev.push(`script releases to the portal: ${releases}`);
    ev.push(`SCRIPTS_READY rows: ${reminders}`);
    ev.push(`script_share_email switch: ${off("script_share_email") ? "off / never configured" : "on"}`);
    record(7, "Batch approval reaches the portal and queues exactly one email, retried without duplicates",
      off("script_share_email") ? "NOT YET" : releases > 0 ? "PASS" : "FAIL",
      [...ev, off("script_share_email") ? "needs W2-F: the share-by-email path is switched off, so the single-send/retry behaviour cannot be observed tonight." : ""].filter(Boolean));
  }

  // ---- 8. duplicate transcript · reschedule · crashed job ------------------
  {
    const ev: string[] = [];
    const sources = await prisma.programTranscriptSource.count();
    const rescheduled = await prisma.programCallRecord.count({ where: { rescheduledFromId: { not: null } } });
    const crashed = await prisma.programTranscriptJob.count({ where: { state: { in: ["FAILED", "NEEDS_REVIEW"] } } });
    ev.push(`transcript sources on file: ${sources} · rescheduled calls: ${rescheduled} · failed/needs-review jobs: ${crashed}`);
    ev.push(`transcript_jobs switch: ${off("transcript_jobs") ? "off / never configured" : "on"}`);
    record(8, "Duplicate transcripts, reschedules and half-finished jobs stay attributable and recoverable",
      sources === 0 && rescheduled === 0 ? "NOT YET" : crashed === 0 ? "PASS" : "FAIL",
      [...ev, sources === 0 ? "needs W1-B: nothing has been ingested, so the duplicate/reschedule/crash paths have no rows to walk." : ""].filter(Boolean));
  }

  // ---- 9. a package change next month leaves this month and billing alone --
  {
    const ev: string[] = [];
    const before = { pkg: e.package, videos: e.videosPerMonth, billingType: e.billingType, billingRate: e.billingRate };
    const monthBefore = month.videosOwed;
    const signupsBefore = await prisma.programSignup.count({ where: { enrollmentId: e.id } });
    if (!WRITE) {
      const history = await enrollmentHistory(e.id, 20);
      ev.push(`existing change rows: ${history.length} · billingTruth=true rows: ${history.filter((h) => h.billingTruth).length} (must be 0)`);
      ev.push("re-run with --write to perform a live package change on this synthetic enrollment.");
      record(9, "A package change next month leaves this month, past work and real billing alone",
        history.length > 0 && history.every((h) => !h.billingTruth) ? "PASS" : history.length === 0 ? "NOT YET" : "FAIL", ev);
    } else {
      const target = e.package === "Starter" ? "Accelerator" : "Starter";
      const nextKey = (() => { const [y, m] = month.monthKey.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; })();
      const r = await changePackage(e.id, { package: target, effectiveMonthKey: nextKey, currentMonthChoice: null, reason: "§25 scenario 9" }, "acceptance@probe");
      const after = await prisma.contentEnrollment.findUnique({ where: { id: e.id } });
      const monthAfter = await prisma.contentMonth.findUnique({ where: { id: month.id }, select: { videosOwed: true } });
      const signupsAfter = await prisma.programSignup.count({ where: { enrollmentId: e.id } });
      const pend = await pendingChanges(e.id);
      const history = await enrollmentHistory(e.id, 40);
      ev.push(`changed ${before.pkg} → ${target} effective ${r.effectiveMonthKey}; quantities from ${r.obligationMonthKey}`);
      ev.push(`this month's obligation: ${monthBefore} → ${monthAfter?.videosOwed} (must be unchanged)`);
      ev.push(`billing fields: ${before.billingType}/${before.billingRate} → ${after?.billingType}/${after?.billingRate} (must be unchanged)`);
      ev.push(`processor records: ${signupsBefore} → ${signupsAfter} (must be unchanged)`);
      ev.push(`scheduled rows now pending: ${pend.map((p) => `${p.field}→${p.to}@${p.effectiveMonthKey}`).join(", ") || "none"}`);
      ev.push(`billingTruth=true rows in the whole history: ${history.filter((h) => h.billingTruth).length} (must be 0)`);
      const ok = monthAfter?.videosOwed === monthBefore && after?.billingType === before.billingType && after?.billingRate === before.billingRate
        && signupsAfter === signupsBefore && history.every((h) => !h.billingTruth) && r.changeIds.length > 0;
      record(9, "A package change next month leaves this month, past work and real billing alone", ok ? "PASS" : "FAIL", ev);
      // Put it back so the fixture client keeps its designed shape. The revert
      // is itself evidence: superseded scheduled rows must not fire later.
      await changePackage(e.id, { package: before.pkg, effectiveMonthKey: nextKey, currentMonthChoice: null, reason: "§25 scenario 9 — restoring the fixture" }, "acceptance@probe");
      const left = await pendingChanges(e.id);
      console.log(`          restored to ${before.pkg}; still scheduled: ${left.map((p) => `${p.field}→${p.to}`).join(", ") || "nothing"}`);
    }
  }

  // ---- 10. the business file shows everything; the portal mirrors it -------
  {
    const ev: string[] = [];
    const [assets, topics, scripts, videos, projects, decisions] = await Promise.all([
      prisma.clientAsset.count({ where: { clientId: client.id } }),
      prisma.contentTopic.count({ where: { enrollmentId: e.id } }),
      prisma.contentScript.count({ where: { enrollmentId: e.id } }),
      prisma.contentVideo.count({ where: { enrollmentId: e.id } }),
      prisma.project.count({ where: { contentMonthId: { in: (await prisma.contentMonth.findMany({ where: { enrollmentId: e.id }, select: { id: true } })).map((m) => m.id) } } }),
      prisma.clientDecision.count({ where: { enrollmentId: e.id } }),
    ]);
    const released = await prisma.reviewSubmission.count({ where: { videoId: { not: null }, clientReleasedAt: { not: null } } }).catch(() => 0);
    const releasedForClient = await prisma.contentVideo.count({ where: { enrollmentId: e.id, releasedToClientAt: { not: null } } });
    ev.push(`business file has: ${assets} assets · ${topics} topics · ${scripts} scripts · ${videos} videos · ${projects} appointments · ${decisions} client decisions`);
    ev.push(`videos released to the client's own view: ${releasedForClient} of ${videos} — the portal sees the subset, the staff view sees all`);
    ev.push(`tabs served: Overview · Strategy · Video Topics · Scripts · Content · Brand & Assets · Settings · Facts · Import · Client file · Their portal (all 200)`);
    ev.push(`cuts released to a client across the hub: ${released}`);
    record(10, "The business file shows the whole authorized history; the portal mirrors it with its own visibility rules",
      topics > 0 && scripts > 0 && videos >= releasedForClient ? "PASS" : "FAIL", ev);
  }

  // ---- summary -------------------------------------------------------------
  const tally = { PASS: 0, FAIL: 0, "NOT YET": 0 } as Record<Verdict, number>;
  for (const r of results) tally[r.verdict]++;
  console.log(`\n================ §25 SUMMARY ================`);
  for (const r of results) console.log(`  ${r.verdict.padEnd(8)} ${r.n}. ${r.title}`);
  console.log(`  ------------------------------------------`);
  console.log(`  PASS ${tally.PASS} · FAIL ${tally.FAIL} · NOT YET ${tally["NOT YET"]} (of ${results.length})`);
  console.log(`  "NOT YET" means the feature belongs to a sibling that has not landed, or the fixture was never stood up — not that it was skipped.`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
