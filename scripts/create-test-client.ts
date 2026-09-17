// ---------------------------------------------------------------------------
// Create (or top up) a SYNTHETIC content-program client for testing the
// portal's identity layer in production, where the only database is.
//
//   npx tsx scripts/create-test-client.ts                      → "Cara TEST"
//   npx tsx scripts/create-test-client.ts "Dave TEST" dave     → another one
//
// REFUSES any name without the word TEST (src/lib/testClients.ts) and any
// sign-in address outside the staff-controlled @realtourpilot.com domain.
// Idempotent: run it twice and nothing duplicates. Never deletes, never
// touches a non-test row. Prisma self-loads .env, so DATABASE_URL is the live
// Neon — that is the point, and the guards above are the safety.
//
// What it makes:
//   Client "<name>"            email info+<slug>@realtourpilot.com
//   ContentEnrollment          ACTIVE · Starter · 2 videos / 1 session / 2h · manual
//   ContentMonth 2026-09       OPEN
//   portalToken                issued (so the link path is testable)
//   ClientUser + Membership    OWNER seat for the same address
//
// With --scenarios it ALSO stands up the §25 acceptance fixtures on the same
// client (idempotent, tagged, never touching a non-test row):
//
//   npx tsx scripts/create-test-client.ts "Cara TEST" cara 2026-09 --scenarios
//
// Fixtures are marked with the sentinel below so a re-run tops them up rather
// than duplicating, and so scripts/run-acceptance-scenarios.ts can tell a
// fixture from real data. See that script for what each scenario asserts.
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { assertTestClient, isStaffControlledEmail } from "../src/lib/testClients";

const prisma = new PrismaClient();
const NAME = process.argv[2] ?? "Cara TEST";
const SLUG = (process.argv[3] ?? NAME.split(/\s+/)[0]).toLowerCase().replace(/[^a-z0-9]/g, "");
const EMAIL = `info+${SLUG}test@realtourpilot.com`;
const MONTH_KEY = (process.argv[4] && /^\d{4}-\d{2}$/.test(process.argv[4]) ? process.argv[4] : null) ?? "2026-09";
const WITH_SCENARIOS = process.argv.includes("--scenarios");

/** Every row this script writes for §25 carries this, so a re-run tops up and a reader can tell. */
export const SCENARIO_TAG = "[§25 acceptance fixture]";

async function main() {
  assertTestClient({ name: NAME });
  if (!isStaffControlledEmail(EMAIL)) throw new Error(`Refusing: ${EMAIL} is not a staff-controlled address.`);

  let client = await prisma.client.findFirst({ where: { name: NAME }, select: { id: true, name: true } });
  if (!client) {
    client = await prisma.client.create({ data: { name: NAME, email: EMAIL, generalNotes: "SYNTHETIC test client for the portal build (Sep 16 2026). Not a real person." }, select: { id: true, name: true } });
    console.log(`Client created      ${client.id}  ${NAME}`);
  } else console.log(`Client exists       ${client.id}  ${NAME}`);
  assertTestClient(client);

  let e = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id } });
  if (!e) {
    e = await prisma.contentEnrollment.create({
      data: {
        clientId: client.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2,
        status: "ACTIVE", statusManual: true, packageSource: "manual", startedAt: new Date(),
        notes: "SYNTHETIC — portal identity-layer testing.",
      },
    });
    console.log(`Enrollment created  ${e.id}`);
  } else console.log(`Enrollment exists   ${e.id}  ${e.status}`);

  if (!e.portalToken) {
    e = await prisma.contentEnrollment.update({ where: { id: e.id }, data: { portalToken: randomBytes(24).toString("base64url"), portalTokenIssuedAt: new Date() } });
    console.log("Portal link issued");
  }

  const month = await prisma.contentMonth.upsert({
    where: { enrollmentId_monthKey: { enrollmentId: e.id, monthKey: MONTH_KEY } },
    create: { enrollmentId: e.id, clientId: client.id, monthKey: MONTH_KEY, videosOwed: e.videosPerMonth, status: "OPEN" },
    update: {},
  });
  console.log(`Month               ${month.id}  ${MONTH_KEY}`);

  const user = await prisma.clientUser.upsert({
    where: { email: EMAIL },
    create: { email: EMAIL, name: NAME },
    update: {},
  });
  const seat = await prisma.clientMembership.upsert({
    where: { clientUserId_enrollmentId: { clientUserId: user.id, enrollmentId: e.id } },
    create: { clientUserId: user.id, enrollmentId: e.id, clientId: client.id, role: "OWNER", invitedByAppUserId: null },
    update: { revokedAt: null, revokedBy: null, role: "OWNER" },
  });
  console.log(`ClientUser          ${user.id}  ${EMAIL}`);
  console.log(`Membership          ${seat.id}  OWNER`);
  console.log(`\nPortal link: /portal/${e.portalToken}`);

  if (WITH_SCENARIOS) await scenarioFixtures(client.id, e.id, month.id, MONTH_KEY);
}

// ---------------------------------------------------------------------------
// §25 FIXTURES. Only the parts this lane owns or can write without reaching
// into another builder's engine: the topic bank and its selections (2, 6), an
// interview left deliberately insufficient (4), three facts with three
// different scopes plus a strategy-change proposal (5), and a pillar for them
// all to hang from. The package change (9) is NOT seeded — it is performed by
// the harness, because the point of that scenario is what the action does.
// ---------------------------------------------------------------------------
async function scenarioFixtures(clientId: string, enrollmentId: string, monthId: string, monthKey: string) {
  console.log(`\n--- §25 fixtures ---`);

  // A pillar to hang topics on.
  let pillar = await prisma.contentPillar.findFirst({ where: { enrollmentId, name: "Acceptance pillar" } });
  if (!pillar) {
    pillar = await prisma.contentPillar.create({
      data: { enrollmentId, clientId, name: "Acceptance pillar", purpose: `${SCENARIO_TAG} a pillar for the §25 walkthrough`, createdBy: "acceptance-fixture" },
    });
  }
  console.log(`pillar              ${pillar.id}`);

  // Scenario 2: FIVE ideas discussed, THREE selected. The other two stay in
  // the bank — they are not deleted, and they must not feed the month.
  const titles = [
    "What a pre-listing inspection saves you",
    "The three questions every seller forgets to ask",
    "Why the first weekend decides your price",
    "A street-level tour of the neighbourhood",
    "What staging actually costs in this market",
  ];
  const topicIds: string[] = [];
  for (let i = 0; i < titles.length; i++) {
    const selected = i < 3;
    const title = `${titles[i]}`;
    let t = await prisma.contentTopic.findFirst({ where: { enrollmentId, title, notes: { contains: SCENARIO_TAG } } });
    if (!t) {
      t = await prisma.contentTopic.create({
        data: {
          enrollmentId, clientId, title, pillarId: pillar.id, pillar: pillar.name,
          concept: "Discussed on the acceptance call.",
          source: "strategy_call", status: selected ? "SELECTED" : "SAVED",
          monthId: selected ? monthId : null,
          notes: `${SCENARIO_TAG} ${selected ? "explicitly chosen on the call" : "raised on the call, NOT chosen — stays in the bank"}`,
          clientVisible: true,
        },
      });
    }
    topicIds.push(t.id);
    if (selected) {
      await prisma.contentTopicSelection.upsert({
        where: { topicId_monthId: { topicId: t.id, monthId } },
        create: { topicId: t.id, monthId, enrollmentId, clientId, status: "SELECTED", rank: i + 1, source: "call", evidenceJson: JSON.stringify([{ speaker: "client", text: "yes, let's do that one" }]) },
        update: {},
      });
    }
  }
  console.log(`topics              5 (3 selected for ${monthKey}, 2 left in the bank)`);

  // Scenario 4: an interview with answers that are NOT sufficient. The month
  // must read "waiting on their answers", not "script ready".
  const thin = await prisma.contentInterview.upsert({
    where: { topicId_monthId: { topicId: topicIds[2], monthId } },
    create: {
      topicId: topicIds[2], enrollmentId, clientId, monthId, sourceKind: "WRITTEN", status: "NEEDS_FOLLOWUP",
      answeredCount: 1,
      sufficiencyJson: JSON.stringify({ sufficient: false, missing: ["a concrete example from their own business", "what the viewer should do next"] }),
      lastActivityAt: new Date(),
    },
    update: { status: "NEEDS_FOLLOWUP", sufficiencyJson: JSON.stringify({ sufficient: false, missing: ["a concrete example from their own business", "what the viewer should do next"] }), submittedAt: null },
  });
  await prisma.contentInterviewAnswer.upsert({
    where: { id: `${thin.id}-fixture-1` },
    create: { id: `${thin.id}-fixture-1`, interviewId: thin.id, questionKey: "audience_problem", questionRole: "AUDIENCE_PROBLEM", questionText: "Who is this for and what are they stuck on?", answerText: "Sellers.", answerKind: "TYPED", sourceKind: "CLIENT" },
    update: {},
  });
  console.log(`interview           ${thin.id}  NEEDS_FOLLOWUP (1 thin answer)`);

  // Scenario 5: three things said on one call, which must be filed three ways.
  const facts: { body: string; category: string; scope: string; fieldKey?: string; projectId?: string | null }[] = [
    { body: `${SCENARIO_TAG} Always cut the intro tight — no slow build.`, category: "PRODUCTION_PREFERENCE", scope: "PERMANENT", fieldKey: "editing.pace" },
    { body: `${SCENARIO_TAG} For the Maple Street shoot only, try the handheld walk-and-talk.`, category: "PRODUCTION_PREFERENCE", scope: "PROJECT" },
    { body: `${SCENARIO_TAG} Wondering whether to speak to first-time buyers instead of move-up sellers.`, category: "PROPOSED_CHANGE", scope: "PERMANENT" },
  ];
  for (const f of facts) {
    const existing = await prisma.clientFact.findFirst({ where: { clientId, body: f.body } });
    if (!existing) {
      await prisma.clientFact.create({
        data: {
          clientId, enrollmentId, category: f.category, body: f.body, source: "call", scope: f.scope, fieldKey: f.fieldKey ?? null,
          // The permanent preference is accepted and AI-allowed; the project
          // one is accepted but scoped; the change of audience is a PROPOSAL
          // and must never reach a generator as a fact.
          status: f.category === "PROPOSED_CHANGE" ? "PROPOSED" : "ACCEPTED",
          aiContext: f.category === "PROPOSED_CHANGE" ? "DENIED" : "ALLOWED",
          factDate: new Date(),
        },
      });
    }
  }
  const proposalSummary = `${SCENARIO_TAG} Change the primary audience from move-up sellers to first-time buyers`;
  const prop = await prisma.contentStrategyProposal.findFirst({ where: { enrollmentId, summary: proposalSummary } });
  if (!prop) {
    await prisma.contentStrategyProposal.create({
      data: { enrollmentId, clientId, kind: "AUDIENCE", summary: proposalSummary, sourceKind: "call", impact: "Every pillar and the topic bank would be re-read against a different audience.", status: "PROPOSED" },
    });
  }
  console.log(`facts               3 (permanent · project-scoped · proposal) + 1 strategy proposal`);

  // Scenario 6: a refresh AFTER approval. Suggestions sit apart from selected
  // work — accepting one is a separate, explicit act.
  let run = await prisma.contentTopicRefreshRun.findFirst({ where: { enrollmentId, kind: "REFRESH", changeSummary: { contains: SCENARIO_TAG } } });
  if (!run) {
    run = await prisma.contentTopicRefreshRun.create({
      data: { enrollmentId, clientId, kind: "REFRESH", status: "SUCCEEDED", requestedBy: "acceptance-fixture", changeSummary: `${SCENARIO_TAG} refresh run after approval`, generatedCount: 2, finishedAt: new Date() },
    });
  }
  for (const title of ["An open-house walkthrough nobody films", "The one paragraph buyers actually read"]) {
    const s = await prisma.contentTopicSuggestion.findFirst({ where: { refreshRunId: run.id, title } });
    if (!s) {
      await prisma.contentTopicSuggestion.create({
        data: { refreshRunId: run.id, enrollmentId, clientId, pillarId: pillar.id, kind: "BANK", title, description: `${SCENARIO_TAG} suggested by a refresh after the month's scripts were approved.`, disposition: "PENDING" },
      });
    }
  }
  console.log(`refresh run         ${run.id}  2 suggestions PENDING (nothing accepted)`);
  console.log(`\nFixtures are idempotent — re-running tops up, never duplicates.`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
