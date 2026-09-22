// ---------------------------------------------------------------------------
// THE JORDAN JOURNEY — THE CALL PATH (Sep 22 2026).
//
//   npx tsx scripts/_drill/jordan-call-path.ts --dry-run   → plan only
//   npx tsx scripts/_drill/jordan-call-path.ts             → run it
//
// The written-answers path was walked in the browser end to end: questions →
// answers → draft → approve → release → the client's own sign-off. This is the
// OTHER path Jordan asked for, and the one nothing had ever exercised: a
// monthly strategy call is transcribed, ANALYZEd into proposed topic selections
// and facts, a person reconciles them, and the scripts follow.
//
// SAFETY. It refuses anything but the §16 TEST client (assertTestClient checks
// the never-synthetic id list BEFORE the name). It plans OCTOBER so September's
// §25 fixtures are untouched. Every row it makes is tagged and idempotent.
// It makes ONE real AI call, attended (requestedBy = this script), which is
// the point — an unattended one would be refused by the ai_runs switch, and a
// mocked one would prove nothing about the prompt.
//
// It does not send anything, does not touch Aryeo, and does not approve,
// release or make client-visible a single thing it produces.
// ---------------------------------------------------------------------------
import { assertTestClient, JORDAN_TEST_CLIENT_NAME } from "../../src/lib/testClients";

const DRY = process.argv.includes("--dry-run");
const MONTH_KEY = "2026-10";
const TAG = "[call-path walkthrough]";
const RUN_BY = "call-path-walkthrough";

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const say = (label: string, v: unknown) => console.log(`  ·    ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

// A real-shaped monthly strategy call. Deliberately mixed: three clear topic
// asks, one thing the client says is private (which must NEVER reach a topic or
// a script), a standing preference, and a vague aside that is not a topic.
const TRANSCRIPT = `
Kyle: Morning Jordan — this is the October planning call. How did September feel?
Jordan: Good. The pre-listing inspection one did really well, way more saves than I expected.
Kyle: Nice. So what do you want to film in October?
Jordan: Three things. First, I keep getting asked whether to price at 399 or 405 when the
comps are right in between. Sellers think the higher number gives them room. It doesn't —
it costs them the first weekend, which is the only weekend that matters. I want to do that one.
Kyle: Got it.
Jordan: Second, escalation clauses. Buyers hear the phrase and panic. I want to explain what
one actually does and when I'd use it, because most agents around here won't touch them.
Kyle: And the third?
Jordan: What happens in the ten days after you go under contract. Nobody tells sellers that
the inspection, the appraisal and the financing all land in the same week and it feels like
everything is falling apart. I walk people through it constantly.
Kyle: Those are strong. Anything else on your mind?
Jordan: Between us — don't put this anywhere — I'm having conversations about moving
brokerages in the spring. Nothing decided, and I don't want that anywhere near a video.
Kyle: Understood, that stays internal.
Jordan: One more thing, and this is a standing preference: stop putting my phone number on
screen. Put "DM me" instead. Every time.
Kyle: Noted. Filming-wise?
Jordan: Same as always, my office, Tuesday mornings if you can.
Kyle: I'll send the slot. And we've got two videos in your package, so the third one carries.
Jordan: That's fine. The pricing one first.
`.trim();

async function main() {
  const { prisma } = await import("../../src/lib/prisma");

  const client = await prisma.client.findFirst({ where: { name: JORDAN_TEST_CLIENT_NAME }, select: { id: true, name: true } });
  if (!client) throw new Error(`No client named "${JORDAN_TEST_CLIENT_NAME}". Run scripts/create-test-client.ts --jordan first.`);
  assertTestClient(client); // id check first, then the name — a renamed real row is still refused
  const enrollment = await prisma.contentEnrollment.findFirst({ where: { clientId: client.id }, select: { id: true, videosPerMonth: true } });
  if (!enrollment) throw new Error("The test client has no enrollment.");
  console.log(`\n=== the call path, ${JORDAN_TEST_CLIENT_NAME} · ${MONTH_KEY}${DRY ? " · DRY RUN" : ""} ===\n`);

  if (DRY) {
    console.log(`WOULD create ContentMonth ${MONTH_KEY}, a MONTHLY_STRATEGY ProgramCallRecord, a CONFIRMED transcript source (${TRANSCRIPT.length} chars),`);
    console.log("WOULD run analyzeTranscriptText (ONE real AI call, attended), then read back what it proposed.");
    console.log("WOULD reconcile the proposed selections and run the drafting chain for the month.");
    console.log("Nothing is approved, released, made client-visible, or sent.");
    return;
  }

  // ---- the month ----------------------------------------------------------
  const month = await prisma.contentMonth.upsert({
    where: { enrollmentId_monthKey: { enrollmentId: enrollment.id, monthKey: MONTH_KEY } },
    update: {},
    create: { enrollmentId: enrollment.id, clientId: client.id, monthKey: MONTH_KEY, videosOwed: enrollment.videosPerMonth, strategyCallStatus: "COMPLETED" },
    select: { id: true, monthKey: true, videosOwed: true },
  });
  say("month", `${month.monthKey} (owes ${month.videosOwed})`);

  // ---- the call and its transcript ----------------------------------------
  const held = new Date("2026-09-22T14:00:00Z");
  const callUri = `drill://call-path/${enrollment.id}/${MONTH_KEY}`;
  const call = await prisma.programCallRecord.upsert({
    where: { calendlyEventUri: callUri },
    update: { monthId: month.id, targetMonthKey: MONTH_KEY, status: "COMPLETED" },
    create: {
      enrollmentId: enrollment.id, clientId: client.id, callType: "MONTHLY_STRATEGY",
      calendlyEventUri: callUri, inviteeName: client.name, scheduledStart: held, scheduledEnd: new Date(held.getTime() + 30 * 60_000),
      monthId: month.id, targetMonthKey: MONTH_KEY, status: "COMPLETED", matchState: "MATCHED",
    },
    select: { id: true },
  });

  const { createHash } = await import("node:crypto");
  const contentHash = createHash("sha256").update(TRANSCRIPT).digest("hex");
  const source = await prisma.programTranscriptSource.upsert({
    where: { contentHash },
    update: { callRecordId: call.id, matchState: "CONFIRMED", confirmedBy: RUN_BY, confirmedAt: new Date() },
    create: {
      callRecordId: call.id, provider: "paste", title: `${TAG} October planning call`, recordedAt: held,
      text: TRANSCRIPT, contentHash, matchState: "CONFIRMED", confirmedBy: RUN_BY, confirmedAt: new Date(), createdBy: RUN_BY,
    },
    select: { id: true },
  });
  ok("a confirmed transcript is on the call", !!source.id);

  // ---- ANALYZE, for real --------------------------------------------------
  const before = await prisma.contentTopicSelection.count({ where: { monthId: month.id } });
  const { analyzeTranscriptText } = await import("../../src/lib/contentGeneration");
  const r = await analyzeTranscriptText({
    enrollmentId: enrollment.id, clientId: client.id, monthId: month.id, monthKey: month.monthKey,
    transcript: TRANSCRIPT, callDate: held, videosOwed: month.videosOwed, requestedBy: RUN_BY, unattended: false,
    callRecordId: call.id, transcriptSourceId: source.id,
  });
  say("analysis", { proposed: r.proposedSelections, kept: r.keptSelections, withheld: r.withheldSelections, discussed: r.discussed, facts: r.facts, confidential: r.confidentialFacts, proposals: r.proposals, priorities: r.priorities });

  // ---- what it proposed ---------------------------------------------------
  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: month.id }, select: { topicId: true, status: true, source: true, evidenceJson: true } });
  const topics = await prisma.contentTopic.findMany({ where: { id: { in: sels.map((s) => s.topicId) } }, select: { id: true, title: true, status: true } });
  console.log("\n  topics the call put on October:");
  for (const s of sels) console.log(`    · [${s.status}] ${topics.find((t) => t.id === s.topicId)?.title ?? s.topicId} (${s.source}, ${s.evidenceJson ? "with excerpts" : "no excerpts"})`);

  ok("the call proposed topics", sels.length > before, `${sels.length} selection(s)`);
  ok("they are PROPOSED, not silently committed", sels.every((s) => s.status === "PROPOSED"), sels.map((s) => s.status).join(","));
  ok("each one carries the excerpt that supports it", sels.every((s) => !!s.evidenceJson));

  // THE CONFIDENTIALITY RULE, which is the one that matters most here.
  const titles = topics.map((t) => t.title.toLowerCase()).join(" | ");
  ok("nothing about the brokerage move became a topic", !/broker|moving|switch|leaving/i.test(titles), titles.slice(0, 200));

  const facts = await prisma.clientFact.findMany({ where: { clientId: client.id, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } }, select: { body: true, status: true, aiContext: true, category: true } });
  console.log("\n  facts the call recorded:");
  for (const f of facts) console.log(`    · [${f.status}/${f.aiContext}] ${f.category}: ${f.body.slice(0, 110)}`);
  const brokerage = facts.filter((f) => /broker/i.test(f.body));
  ok("the private brokerage remark was recorded as a fact, not lost", brokerage.length > 0, `${brokerage.length}`);
  ok("  …and is NOT allowed into any generator", brokerage.every((f) => f.aiContext !== "ALLOWED"), brokerage.map((f) => f.aiContext).join(","));
  ok("the standing 'DM me, not my number' preference was captured", facts.some((f) => /dm|phone number|number on screen/i.test(f.body)));

  // ---- a person reconciles, then the scripts follow -----------------------
  const { reconcileSelection } = await import("../../src/lib/contentTopics");
  const keep = sels.slice(0, month.videosOwed);
  for (const s of keep) await reconcileSelection(s.topicId, month.id, true, { kind: "STAFF", staffUserId: RUN_BY });
  const after = await prisma.contentTopicSelection.findMany({ where: { monthId: month.id }, select: { status: true } });
  ok("a person's reconcile commits only what they kept", after.filter((s) => s.status === "RECONCILED").length === keep.length, after.map((s) => s.status).join(","));

  const { scriptWorkForMonth } = await import("../../src/lib/contentDrafting");
  const work = await scriptWorkForMonth(month.id);
  console.log("\n  what October now owes:");
  for (const w of work) console.log(`    · [${w.readiness}] ${w.title} — ${w.why}`);
  ok("the reconciled topics are ready to draft from the call", work.some((w) => w.readiness === "FROM_CALL"), work.map((w) => w.readiness).join(","));
  ok("anything still only PROPOSED waits for a person", work.filter((w) => w.readiness === "WAITING_ON_PLANNING").length === sels.length - keep.length);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
