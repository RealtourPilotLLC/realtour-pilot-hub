import { APPLY, db } from "./_oct22-guard";
// ---------------------------------------------------------------------------
// Oct 27 2026, the calls nobody matched (Jordan, on Janice Pigga's call and
// Bernadette's Oct 26 follow-up: "it should be analyzed and assigned
// automatically"). The hourly sync now does this on its own
// (lib/callAutoMatch.ts); this runs the same passes once, now, for the
// calls already waiting:
//   1. the signals: portal login, a guest on the invite, the phone on the
//      booking, a unique full name, a follow-up a previous call agreed;
//   2. the calendar: a Google Meet with a client that never went through
//      Calendly (Bernadette's Oct 26 3:30 PM follow-up);
//   3. the AI, for what is still left (acted on at 85% or better; the
//      booking address is then verified as the client's alias);
//   4. the notes: Gemini docs paired to the newly filed calls, then every
//      matched call with confirmed notes and no analysis is analyzed.
//
// Dry run (default): reads only, on a connection proven read-only, and never
// calls a model. It lists what each pass WOULD file and which calls wait for
// an analysis. --apply writes, asks the model (labelled claude:), and
// analyzes.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-loom-calls.ts [--apply]
// ---------------------------------------------------------------------------

const BY = "claude:oct27-loom-calls";
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "no time");

async function main() {
  const prisma = await db();
  const now = new Date();
  const auto = await import("../../src/lib/callAutoMatch");

  // Named in the Loom: where those calls stand now.
  const named = await prisma.programCallRecord.findMany({
    where: { OR: [{ inviteeName: { contains: "Pigga", mode: "insensitive" } }, { inviteeEmail: { contains: "pigga", mode: "insensitive" } }, { inviteeName: { contains: "Rabel", mode: "insensitive" } }], scheduledStart: { gte: new Date(now.getTime() - 60 * 864e5) } },
    orderBy: { scheduledStart: "desc" }, take: 10,
    select: { id: true, inviteeName: true, inviteeEmail: true, scheduledStart: true, status: true, matchState: true, transcriptState: true, matchNote: true, targetMonthKey: true },
  });
  console.log("\nCALLS NAMED IN THE LOOM (Janice Pigga, Bernadette Rabel), last 60 days:");
  for (const r of named) console.log(`  ${r.id}  ${r.inviteeName ?? r.inviteeEmail}  ${day(r.scheduledStart)}  ${r.status}/${r.matchState}/${r.transcriptState}  month ${r.targetMonthKey ?? "-"}  ${r.matchNote ?? ""}`);
  if (!named.length) console.log("  (none on file: a calendar-only call shows up under pass 2)");

  // Pass 1.
  const plan = await auto.planWaitingMatches({ now });
  console.log(`\nPASS 1, the signals: ${plan.planned.length} waiting call(s) placed, ${plan.left.length} left.`);
  for (const p of plan.planned) console.log(`  ${p.recordId}  ${p.who}  ${day(p.whenISO)}  →  ${p.clientName}  (${p.note})${p.followup ? `  plans ${p.followup.monthKey}` : ""}`);

  // Pass 2.
  let cal: Awaited<ReturnType<typeof auto.discoverCalendarCalls>> | { skipped: string };
  try { cal = await auto.discoverCalendarCalls({ now, dryRun: true }); }
  catch (e) { cal = { skipped: `calendar read failed: ${e instanceof Error ? e.message : String(e)}` }; }
  if ("skipped" in cal) console.log(`\nPASS 2, the calendar: skipped (${cal.skipped}).`);
  else {
    console.log(`\nPASS 2, the calendar: ${cal.seen} virtual event(s) seen, ${cal.found} client call(s) not on file.`);
    for (const f of cal.finds) console.log(`  ${day(f.startISO)}  "${f.title ?? ""}"  →  ${f.clientName}  (${f.why})${f.followup ? `  plans ${f.followup.monthKey}` : ""}`);
  }

  // Pass 3 (the dry run never calls the model).
  const ai = await auto.aiMatchWaitingCalls({ now, dryRun: true, max: 20 });
  console.log(`\nPASS 3, the AI: ${ai.rows.length} call(s) it would be asked about.`);
  for (const r of ai.rows) console.log(`  ${r.recordId}  ${r.who}`);

  // Pass 4: matched calls with confirmed notes and no analysis.
  const toAnalyze = await prisma.programCallRecord.findMany({
    where: { matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] }, callType: { in: ["MONTHLY_STRATEGY", "BRAND_DISCOVERY"] }, transcriptState: "CONFIRMED", status: { in: ["SCHEDULED", "COMPLETED"] }, scheduledStart: { gte: new Date(now.getTime() - 60 * 864e5), lte: now } },
    orderBy: { scheduledStart: "desc" }, take: 20, select: { id: true, inviteeName: true, scheduledStart: true, analysisRunId: true },
  });
  console.log(`\nPASS 4, the notes: ${toAnalyze.length} matched call(s) with confirmed notes waiting for an analysis.`);
  for (const r of toAnalyze) console.log(`  ${r.id}  ${r.inviteeName ?? "?"}  ${day(r.scheduledStart)}`);

  if (!APPLY) { console.log("\nDry run: nothing written, no model called. Add --apply to file, ask the AI and analyze."); return; }

  console.log("\nAPPLYING…");
  const p1 = await auto.rematchWaitingCalls({ now });
  console.log(`pass 1: filed ${p1.filed}, held ${p1.held} (strategy gate or a closed month), ${p1.left} left`);
  for (const r of p1.rows) console.log(`  ${r.recordId}  ${r.client}  ${r.filed ? "filed" : "not filed"}: ${r.why}`);
  const p2 = await auto.discoverCalendarCalls({ now });
  console.log("pass 2:", "skipped" in p2 ? p2.skipped : `created ${p2.created}, refreshed ${p2.refreshed}`);
  const linked = await auto.linkExpectedCalls(now);
  console.log(`expected follow-ups linked: ${linked.linked}`);
  const p3 = await auto.aiMatchWaitingCalls({ now, max: 20, budgetMs: 15 * 60_000, minStartMs: 1, requestedBy: BY, unattended: false });
  console.log(`pass 3: asked ${p3.asked}, filed ${p3.filed}, no match ${p3.noMatch}, failed ${p3.failed}`);
  for (const r of p3.rows) console.log(`  ${r.recordId}  ${r.who}  →  ${r.client ?? "-"}: ${r.why}`);

  const ccr = await import("../../src/lib/contentCallRecords");
  const disc = await ccr.discoverTranscriptSources({ now }).catch((e) => ({ skipped: e instanceof Error ? e.message : String(e) }));
  console.log("notes looked for:", JSON.stringify(disc));

  const ca = await import("../../src/lib/callAnalysis");
  const again = await prisma.programCallRecord.findMany({
    where: { matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] }, callType: { in: ["MONTHLY_STRATEGY", "BRAND_DISCOVERY"] }, transcriptState: "CONFIRMED", status: { in: ["SCHEDULED", "COMPLETED"] }, scheduledStart: { gte: new Date(now.getTime() - 60 * 864e5), lte: now } },
    orderBy: { scheduledStart: "desc" }, take: 20, select: { id: true, inviteeName: true },
  });
  for (const r of again) {
    const claim = await ca.startCallAnalysis(r.id, BY, new Date());
    if (!claim.ok) { console.log(`  analysis ${r.id} (${r.inviteeName ?? "?"}): not started: ${claim.message}`); continue; }
    const res = await ca.runClaimedCallAnalysis({ jobId: claim.jobId, callRecordId: r.id, by: BY, prior: claim.prior });
    console.log(`  analysis ${r.id} (${r.inviteeName ?? "?"}): ${res.ok ? `done, run ${res.runId}, ${res.proposals} proposal(s)` : `failed: ${res.message}`}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
