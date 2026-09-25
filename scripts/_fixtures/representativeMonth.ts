// ---------------------------------------------------------------------------
// FIXTURE: THE REPRESENTATIVE TEST MONTH (CP-15, Sep 24 2026).
//
//   await seedRepresentativeMonth(prisma, { clientId, monthKey, tier: "program", variant: "accelerator" });
//
// Run by scripts/create-test-client.ts --month-fixture=program|full, and by the
// drills (cp15-seed-and-probe.ts, cron-route-journey.ts). It stands up ONE
// TEST client's month the way production would hold it after a normal few
// weeks — so a person (or a drill) can walk every screen against something that
// looks like a real month, instead of against the empty shell a new TEST client
// is.
//
// WHY IT GOES THROUGH THE APP'S OWN FUNCTIONS. Raw inserts would give the right
// rows the wrong history: a topic with no event, a script "approved" with no
// ledger row, a cut "in review" with no window. Wherever a business rule
// decides the shape, the shipped function writes it — createTopic and
// selectTopicForMonth, the interview's answer/submit path, createScriptVersion
// → approveScriptVersion → releaseScriptVersion, the client's own
// clientApproveScript / clientRequestScriptChanges, the release's
// openReviewWindow, the client's approveCut / requestChangesOnCut with a TEST
// portal viewer, markVideoSent, syncEnrollmentVideos, createSessionRequest,
// changePackage, setEnrollmentStatus. The rows those functions do not own
// (the two months, the Project shell, a cut row) are plain inserts.
//
// WHAT IT BUILDS
//   program tier (the only tier allowed on a hosted database; creates NO Project)
//     · an approved, released strategy with 3 pillars; 10 approved topics per
//       pillar and 2 AI-proposed topics nobody has reviewed
//     · LAST month COMPLETED, its one scripted-but-unfilmed topic (E) carried
//       into this month (a released script still waiting on the client). When
//       the month seeded is a FUTURE one, "last month" is the live current
//       month: it is left exactly as it is (never closed, nothing carried out
//       of it) and E is put straight on the seeded month
//     · the monthly call held a week before this month's shoot (one date
//       anchor: a few days ago, never before the 1st), then filmed
//     · THIS month OPEN with 4 selected topics: A and B planned on a confirmed
//       monthly call with a pasted transcript, C with sufficient written
//       answers, D with thin answers that need follow-up
//     · scripts: C's draft waiting on Jordan, E released and waiting on the
//       client, A approved by the client, B with a change requested
//     · one session request, REQUESTED, on a weekday inside the month
//   On an Accelerator (4 owed) the carried topic is the fifth on the month, so
//   it is kept and flagged beyond capacity — exactly what the carryover does to
//   a full month (CP-07: a carry is never dropped; the client may swap it).
//
//   full tier (an isolated database only — refused before any write when
//   DATABASE_URL/DIRECT_URL looks hosted, and only for the current ET month)
//     · everything above, plus this month's Project (MANUAL, no Aryeo ids),
//       filmed at the anchor, with the photographer's filming report applied
//       (A–D confirmed filmed and bound to the job's four video slots, so each
//       library video carries its topic, title and script) and
//       four cuts: A waiting for the client's review; B sent back by the client
//       (decision + revision brief + round) with round 2 waiting in the Review
//       Room; C approved by the client, download unlocked; D approved and sent,
//       delivered in the library
//     · last month's Project with 2 delivered videos, filmed on two topics
//       chosen, scripted and client-approved last month (L1, L2)
//     · the session request is the client's ask for the morning that was
//       filmed, confirmed on this month's job (never a future slot on a past
//       job); Pro: a second 4-hour session later in the month, confirmed —
//       two distinct confirmed sessions
//     · Ended: the same month, then the program ENDED — the library stays
//   Cut files point at DEMO_CLIP_URL, a local sample the isolated demo serves.
//
// GUARDS, ALL BEFORE THE FIRST WRITE
//   · assertTestClient — the id is checked against the never-synthetic list
//     before the name, so a real row renamed "… TEST" is still refused
//   · assertTestDestinations on the client's email, backup email and phone and
//     on the portal seat's email; no aryeoCustomerId
//   · no provider records: Projects are MANUAL with no Aryeo order, sessions are
//     session REQUESTS (never Appointments), nothing is uploaded anywhere
//   · the app's prisma IS the prisma handed in (a second client could point at
//     a different database — the real functions write through the app's)
//   · full tier: not on a hosted-looking URL, not on a client with Aryeo jobs
//
// IDEMPOTENT, NEVER DELETES. Every step first looks for what it would make —
// by the marker "[CP-15 representative month]" (topic notes, call note,
// session-request notes, script change summaries, Project titles, the
// strategy's file name) or by the natural key the app itself enforces — and
// does nothing when it is there. Running it twice leaves the same rows.
//
// WHAT A PROGRAM-TIER RUN LEAVES ON A LIVE HUB, said out loud because the
// functions are the real ones: a bell row for OWNER/ADMIN "Script change asked
// for — <TEST client>" (B's change request); ProgramEnrollmentChange rows for
// the package change; a pasted transcript whose INGEST and ANALYZE jobs sit
// QUEUED while transcript_jobs is off. Once it is on they run for this TEST
// client like any other — and because a paste is a PERSON's request
// (requestedBy = "cp15-fixture"), runTranscriptJob runs its ANALYZE attended,
// i.e. on the model even with ai_runs off (one small analysis, a few cents).
// No text, email, Slack message or provider call — the
// session request makes no desk task for a TEST client (sessionRequests.ts),
// and every client-facing sender is behind a switch the fixture never touches.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import type { PortalViewer } from "@/lib/portal";
import fs from "node:fs";
import path from "node:path";
import { DEMO_CLIP_URL as DEMO_SAMPLE_URL } from "../demo/sample";

export const REPRESENTATIVE_MARKER = "[CP-15 representative month]";

/**
 * Where the full tier's cut files point: the isolated demo's clip
 * (scripts/demo/sample.ts), overridable with DEMO_CLIP_URL. It is shaped like a
 * Vercel Blob URL because the cut stream route proxies nothing else
 * (reviewCuts.blobFetchDecision refuses any other host), on an invented public
 * store that the demo's network fence answers from a local file. Nothing is
 * uploaded, and no real store sits behind the name — outside the demo the
 * clip simply does not play.
 */
export const DEMO_CLIP_URL = process.env.DEMO_CLIP_URL || DEMO_SAMPLE_URL;

/** guard-prod-db.ts's pattern, the one definition of "hosted". */
export const HOSTED_DB_RE = /neon\.tech|vercel|amazonaws/i;

export type RepresentativeTier = "program" | "full";
export type RepresentativeVariant = "accelerator" | "pro" | "ended";

export type RepresentativeOptions = {
  clientId: string;
  /** "2026-09". Program: this ET month or later. Full: this ET month only. */
  monthKey: string;
  tier: RepresentativeTier;
  variant: RepresentativeVariant;
  log?: (line: string) => void;
};

export type RepresentativeResult = {
  clientId: string;
  enrollmentId: string;
  monthId: string;
  lastMonthId: string;
  monthKey: string;
  lastMonthKey: string;
  tier: RepresentativeTier;
  variant: RepresentativeVariant;
  /** A–E as described above. */
  topics: { A: string; B: string; C: string; D: string; E: string };
  scripts: { A: string; B: string; C: string; E: string };
  interviews: { C: string; D: string };
  callRecordId: string;
  sessionRequestIds: string[];
  /** full tier only */
  projectId: string | null;
  lastProjectId: string | null;
  cuts: { A: string; B: string; B2: string; C: string; D: string; last: string[] } | null;
  /** what this run actually wrote — empty on a re-run */
  wrote: string[];
};

export class RepresentativeMonthRefused extends Error {
  constructor(message: string) {
    super(`seedRepresentativeMonth refused: ${message}`);
    this.name = "RepresentativeMonthRefused";
  }
}

/** Who the fixture says did a staff act. Never a real person's address. */
const ACTOR = "cp15-fixture";

// ---- the content ----------------------------------------------------------

const PILLARS = [
  { name: "Market Authority", purpose: "Explain what the local market is doing and what it means for a seller's price", focus: "Pricing, days on market, inventory" },
  { name: "Neighborhood Life", purpose: "Show the streets, schools and weekends buyers are really buying into", focus: "Restaurants, parks, commutes" },
  { name: "Seller Playbook", purpose: "Walk a seller through the decisions that move the result", focus: "Prep, staging, the first weekend" },
] as const;

const TOPIC_TITLES: string[][] = [
  [
    "Why the first weekend decides your price",
    "What days on market really tell a buyer",
    "Three numbers to read before you list",
    "Why the list price is a marketing decision",
    "What a price cut costs you after week two",
    "How spring inventory changes your pricing",
    "Reading a comparable sale like an appraiser",
    "When a bidding war is not a good sign",
    "What rates are doing to move-up buyers",
    "The one chart every seller should see",
  ],
  [
    "A Saturday morning on Main Street",
    "Where the new families are moving first",
    "The commute nobody tells you about",
    "Three parks buyers ask me about",
    "What the school boundary really changes",
    "The coffee shop test for a neighborhood",
    "Why this street sells in a weekend",
    "The walkable blocks nobody lists",
    "What a new restaurant does to prices nearby",
    "Five minutes from the train, block by block",
  ],
  [
    "What a pre-listing inspection saves you",
    "The three rooms buyers decide on",
    "What staging actually costs in this market",
    "Photos first: the order that sells a house",
    "The questions to ask before you pick an agent",
    "How to price the repairs you will not make",
    "The paperwork to have ready on day one",
    "What to do the week before photos",
    "How to read your first offer",
    "When to say yes to an early offer",
  ],
];

/** AI suggestions nobody has reviewed: PROPOSED, never on the client's page. */
const PROPOSED_TITLES = ["A tour of the quiet cul-de-sacs", "What a rent-back agreement looks like"];

/** The month's five: A and B from the call, C and D written, E carried in. */
const PICK = { A: [0, 0], B: [1, 0], C: [2, 0], D: [0, 1], E: [2, 1] } as const;
/**
 * Full tier only: the two topics LAST month's two delivered videos were filmed
 * on (bank positions no drill or --scenarios run selects). Without them those
 * videos had no topic, so their titles were file names and the caption
 * assistant had no script to draft from.
 */
const LAST_FILMED = { L1: [1, 1], L2: [2, 3] } as const;

const CALL_LINES: Record<"A" | "B", string[]> = {
  A: [
    "Every listing I have taken that sat past the first weekend ended up selling for less than the one that went in priced right.",
    "I tell sellers the first weekend is the whole negotiation, and they never believe me until they live it.",
  ],
  B: [
    "People come to the open house and then walk to the coffee shop on the corner, and that is when they decide.",
    "I want to film a Saturday morning on Main Street so buyers can see the town before they see the house.",
  ],
};

const CANNED_ANSWERS: Record<string, string> = {
  audienceProblem: "Sellers who think the right repairs are obvious and spend on the wrong ones before they list.",
  pointOfView: "An inspection before you list turns surprises into decisions you make on your own schedule.",
  talkingPoints: "For example, a seller last spring found a roof issue early and priced it in. Second, buyers trust a house with a report. Finally, you keep the negotiation on your terms.",
  evidence: "Last year a seller on Oak Street did the inspection first and had no repair requests at all.",
  story: "A seller who skipped it lost two weeks and four thousand dollars to a repair ask she could have planned for.",
  nextAction: "Call me before you book the photographer so we can plan the inspection together.",
};
const FOLLOW_UP_ANSWER = "A client last year had exactly this: the report came back clean, we said so in the listing, and the offers came in without conditions.";

function scriptParts(title: string, pillar: { id: string; name: string }, hook: string) {
  return {
    title,
    categoryLabel: pillar.name,
    pillarId: pillar.id,
    hook,
    points: [
      { role: "re-hook" as const, text: "Most sellers learn this the expensive way, after the listing has already gone live." },
      { role: "build-up" as const, text: "Buyers read every week on the market as a signal, and the first weekend sets the story they tell each other." },
      { role: "payoff" as const, text: "Get the price, the photos and the paperwork right before day one, and the first weekend does the negotiating for you." },
    ],
    close: "Planning to sell this year? Call me before you book the photographer and we will plan your first weekend together.",
    captionCta: "Comment PLAN and I will send you my first-weekend checklist.",
  };
}

function transcriptFor(clientName: string, monthKey: string): string {
  return [
    `Monthly strategy call — ${clientName} — planning ${monthKey} ${REPRESENTATIVE_MARKER}`,
    "Jordan: Let's pick this month's videos. What are sellers asking you about right now?",
    `Client: ${CALL_LINES.A[0]}`,
    `Client: ${CALL_LINES.A[1]}`,
    "Jordan: That's a great one. What else?",
    `Client: ${CALL_LINES.B[0]}`,
    `Client: ${CALL_LINES.B[1]}`,
    "Jordan: Good. I'll send the written questions for the other two topics.",
  ].join("\n");
}

function strategyText(clientName: string): string {
  return `${clientName}
Social Content Strategy ${REPRESENTATIVE_MARKER}
1. Brand Overview
Core Values: Straight answers, local knowledge
Brand Message: The agent who explains the market before selling it
Brand Voice: Warm, direct and expert
Target Audience
Primary service areas: Montgomery County
Primary client types: Move-up sellers
Long-term positioning goal: The local name for pricing a house right
2. Content Goals
- Grow to 5,000 local followers
- Two listing appointments a month from video
3. Content Pillars
Pillar 1: ${PILLARS[0].name}
Purpose: ${PILLARS[0].purpose}
Focus Areas: ${PILLARS[0].focus}
Pillar 2: ${PILLARS[1].name}
Purpose: ${PILLARS[1].purpose}
Focus Areas: ${PILLARS[1].focus}
Pillar 3: ${PILLARS[2].name}
Purpose: ${PILLARS[2].purpose}
Focus Areas: ${PILLARS[2].focus}
4. Video Structure Framework
Hook
Close / Call to Action`;
}

// ---- small helpers ----------------------------------------------------------

function previousMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 15));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The database this process writes to, as far as the environment says. */
export function databaseUrlsInUse(): string[] {
  const env = [process.env.DATABASE_URL, process.env.DIRECT_URL].filter((u): u is string => !!u && u.trim() !== "");
  if (env.length) return env;
  // Prisma self-loads .env only when a client is constructed; a caller that
  // has not built one yet still means that file.
  try {
    const m = /^\s*DATABASE_URL\s*=\s*"?([^"\n]+)/m.exec(fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8"));
    return m ? [m[1]] : [];
  } catch {
    return [];
  }
}

/** Refuses when a URL looks hosted, or when there is no URL to judge at all. */
export function assertIsolatedDatabase(): void {
  const urls = databaseUrlsInUse();
  if (urls.length === 0) throw new RepresentativeMonthRefused("the full tier needs an isolated database, and no DATABASE_URL could be read to prove this is one.");
  const hosted = urls.find((u) => HOSTED_DB_RE.test(u));
  if (hosted) {
    let host = "a hosted database";
    try { host = new URL(hosted).hostname; } catch { /* keep the generic word */ }
    throw new RepresentativeMonthRefused(`the full tier creates Projects and cuts, and DATABASE_URL points at ${host} — a hosted database. It runs on an isolated copy only (see the header).`);
  }
}

// ---------------------------------------------------------------------------

export async function seedRepresentativeMonth(prisma: PrismaClient, opts: RepresentativeOptions): Promise<RepresentativeResult> {
  const log = opts.log ?? (() => {});
  const wrote: string[] = [];
  const did = (line: string) => { wrote.push(line); log(`  + ${line}`); };

  // ---- 1. every refusal, before anything is written ------------------------
  if (opts.tier !== "program" && opts.tier !== "full") throw new RepresentativeMonthRefused(`unknown tier "${String(opts.tier)}".`);
  if (!["accelerator", "pro", "ended"].includes(opts.variant)) throw new RepresentativeMonthRefused(`unknown variant "${String(opts.variant)}".`);
  if (!/^\d{4}-\d{2}$/.test(opts.monthKey)) throw new RepresentativeMonthRefused(`month "${opts.monthKey}" must look like 2026-09.`);
  if (opts.tier === "full") assertIsolatedDatabase();

  const { prisma: appPrisma } = await import("@/lib/prisma");
  if (appPrisma !== prisma) throw new RepresentativeMonthRefused("the prisma client handed in is not the app's own (@/lib/prisma). Set globalThis.prisma to it before any app module loads, so the real functions write where this fixture reads.");

  const tc = await import("@/lib/testClients");
  const client = await prisma.client.findUnique({
    where: { id: opts.clientId },
    select: { id: true, name: true, email: true, backupEmail: true, phone: true, aryeoCustomerId: true },
  });
  if (!client) throw new RepresentativeMonthRefused(`no client ${opts.clientId}.`);
  tc.assertTestClient(client); // the id first, then the name
  tc.assertTestDestinations({ email: client.email, phone: client.phone });
  tc.assertTestDestinations({ email: client.backupEmail });
  if (client.aryeoCustomerId) throw new RepresentativeMonthRefused(`${client.name} carries an Aryeo customer id — a TEST client holds no provider record.`);

  const { etMonthKey, PACKAGE_RULES } = await import("@/lib/contentProgram");
  const now = new Date();
  const currentKey = etMonthKey(now);
  if (opts.monthKey < currentKey) throw new RepresentativeMonthRefused(`${opts.monthKey} is in the past (this ET month is ${currentKey}); past months keep their quantities, so a representative month is this month or later.`);
  if (opts.tier === "full" && opts.monthKey !== currentKey) throw new RepresentativeMonthRefused(`the full tier holds cuts from footage already shot, so it seeds this ET month (${currentKey}) only.`);

  // ONE ANCHOR FOR THE MONTH'S DATES (Sep 24). The call used to be "3 days
  // ago" and the shoot "4 days ago", set in two places — so the month was
  // filmed the day before the call that planned it, and the demo narrated
  // exactly that. Now the shoot is the anchor (a few days ago, never before the
  // 1st at 10:00 ET, never in the future) and the planning call is a week
  // before it — in the prior month early on, which targetMonthKey allows.
  const { etAt, etDayKey } = await import("@/lib/datetime");
  const monthFirst = etAt(`${opts.monthKey}-01`, 10).getTime();
  const shootAt = new Date(Math.min(now.getTime() - 60 * 60_000, Math.max(monthFirst, now.getTime() - 4 * 86_400_000)));
  const callAt = new Date(Math.floor((shootAt.getTime() - 7 * 86_400_000) / 60_000) * 60_000);

  let enrollment = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id } });
  if (!enrollment) throw new RepresentativeMonthRefused(`${client.name} has no content enrollment — run scripts/create-test-client.ts first.`);

  const seats = await prisma.clientMembership.findMany({
    where: { enrollmentId: enrollment.id, clientId: client.id, role: "OWNER", revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, clientUserId: true },
  });
  const { liveMemberships } = await import("@/lib/portal");
  let owner: { seatId: string; person: { id: string; email: string; name: string | null } } | null = null;
  for (const s of seats) {
    const person = await prisma.clientUser.findUnique({ where: { id: s.clientUserId }, select: { id: true, email: true, name: true, status: true } });
    if (!person || person.status === "DISABLED") continue;
    // The resolver's own ownership rule, not a restatement of it.
    if (!(await liveMemberships(person.id)).some((m) => m.id === s.id)) continue;
    owner = { seatId: s.id, person };
    break;
  }
  if (!owner) throw new RepresentativeMonthRefused(`${client.name} has no live OWNER portal seat — the client's own decisions need one (create-test-client makes it).`);
  tc.assertTestDestinations({ email: owner.person.email });

  if (opts.tier === "full") {
    const aryeoJobs = await prisma.project.count({ where: { clientId: client.id, OR: [{ aryeoOrderId: { not: null } }, { source: { not: "MANUAL" } }] } });
    if (aryeoJobs) throw new RepresentativeMonthRefused(`${client.name} already has ${aryeoJobs} provider-backed job(s); the full tier only builds on a client with none.`);
  }

  const lastMonthKey = previousMonthKey(opts.monthKey);
  const callNote = `${REPRESENTATIVE_MARKER} ${opts.monthKey}`;

  // An ENDED run that already finished: everything below is in place, and the
  // functions that built it need an ACTIVE program. Report and stop.
  if (enrollment.status !== "ACTIVE") {
    const done = await prisma.programCallRecord.findFirst({ where: { enrollmentId: enrollment.id, callType: "MONTHLY_STRATEGY", matchNote: { contains: callNote } }, select: { id: true } });
    if (!(opts.variant === "ended" && enrollment.status === "ENDED" && done)) {
      throw new RepresentativeMonthRefused(`${client.name}'s program is ${enrollment.status}; the fixture builds an active month. Reactivate it on the client file first.`);
    }
    log(`  = ${client.name}'s ENDED month is already seeded — nothing to do`);
    return summarise(prisma, { client, enrollmentId: enrollment.id, opts, lastMonthKey, callNote, wrote });
  }

  // ---- 2. the package the variant stands for -------------------------------
  const pkg = opts.variant === "pro" ? "Pro" : "Accelerator";
  const rule = PACKAGE_RULES[pkg];
  if (enrollment.package !== pkg || enrollment.videosPerMonth !== rule.videosPerMonth || enrollment.sessionsPerMonth !== rule.sessionsPerMonth || enrollment.sessionHours !== rule.sessionHours) {
    const { changePackage } = await import("@/lib/enrollmentChanges");
    await changePackage(enrollment.id, { package: pkg, currentMonthChoice: "APPLY", reason: `${REPRESENTATIVE_MARKER} ${opts.variant} variant` }, ACTOR);
    enrollment = (await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id } }))!;
    did(`package → ${pkg} (${enrollment.videosPerMonth} videos, ${enrollment.sessionsPerMonth} session(s) of ${enrollment.sessionHours}h), through changePackage`);
  }
  const enrollmentId = enrollment.id;

  // ---- 3. the two months ---------------------------------------------------
  const ensureMonth = async (monthKey: string) => {
    const existing = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId, monthKey } } });
    if (existing) return existing;
    const m = await prisma.contentMonth.create({ data: { enrollmentId, clientId: client.id, monthKey, videosOwed: enrollment!.videosPerMonth, status: "OPEN" } });
    did(`ContentMonth ${monthKey}`);
    return m;
  };
  const lastMonth = await ensureMonth(lastMonthKey);
  const month = await ensureMonth(opts.monthKey);
  if (month.videosOwed !== enrollment.videosPerMonth) log(`  ! ${opts.monthKey} owes ${month.videosOwed} videos, the package ${enrollment.videosPerMonth} — left as it stands`);

  // ---- 4. strategy → pillars -----------------------------------------------
  const cs = await import("@/lib/contentStrategy");
  const strategyFile = "cp15-representative-strategy.txt";
  let version = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId, sourceRef: strategyFile }, orderBy: { versionNo: "desc" }, select: { id: true, status: true, releasedAt: true } });
  if (!version) {
    const imp = await cs.importStrategyVersion({ enrollmentId, text: strategyText(client.name ?? "TEST client"), fileName: strategyFile, createdBy: ACTOR });
    version = { id: imp.versionId, status: "INTERNAL_REVIEW", releasedAt: null };
    did(`strategy v${imp.versionNo} imported (${imp.pillarCount} pillars)`);
  }
  if (version.status !== "APPROVED") {
    await cs.approveStrategyVersion(version.id, ACTOR);
    did("strategy approved (pillars created from it)");
  }
  if (!version.releasedAt) {
    await cs.releaseStrategyVersion(version.id, ACTOR);
    did("strategy released to the portal");
  }
  const { listPillars } = await import("@/lib/contentPillars");
  const pillarRows = await listPillars(enrollmentId);
  const pillars = PILLARS.map((p) => {
    const row = pillarRows.find((r) => r.name === p.name);
    if (!row) throw new Error(`pillar "${p.name}" was not created from the approved strategy`);
    return { id: row.id, name: row.name };
  });

  // ---- 5. the topic bank ---------------------------------------------------
  const ct = await import("@/lib/contentTopics");
  const staff = { kind: "STAFF" as const, staffUserId: null };
  const clientActor = { kind: "CLIENT" as const, clientUserId: owner.person.id };
  const topicId = async (title: string, pillar: { id: string; name: string }, proposed: boolean): Promise<string> => {
    const found = await prisma.contentTopic.findFirst({ where: { enrollmentId, title, notes: { contains: REPRESENTATIVE_MARKER } }, select: { id: true } });
    if (found) return found.id;
    const r = await ct.createTopic({
      enrollmentId, title, pillarId: pillar.id, pillarLabel: pillar.name, concept: `${title}.`,
      source: proposed ? "ai" : "staff", approvalState: proposed ? "PROPOSED" : "APPROVED", approvedBy: proposed ? null : ACTOR,
      actor: proposed ? { kind: "AI" } : staff, note: REPRESENTATIVE_MARKER,
    });
    await prisma.contentTopic.updateMany({ where: { id: r.id, notes: null }, data: { notes: REPRESENTATIVE_MARKER } });
    if (!r.existed) did(`topic "${title}"${proposed ? " (proposed)" : ""}`);
    return r.id;
  };
  const bank: string[][] = [];
  for (const [i, titles] of TOPIC_TITLES.entries()) {
    const ids: string[] = [];
    for (const t of titles) ids.push(await topicId(t, pillars[i], false));
    bank.push(ids);
  }
  for (const [i, t] of PROPOSED_TITLES.entries()) await topicId(t, pillars[i], true);
  const T = Object.fromEntries(Object.entries(PICK).map(([k, [p, n]]) => [k, bank[p][n]])) as Record<keyof typeof PICK, string>;
  const pillarOf = (k: keyof typeof PICK) => pillars[PICK[k][0]];
  const titleOf = (k: keyof typeof PICK) => TOPIC_TITLES[PICK[k][0]][PICK[k][1]];

  // ---- 6. the monthly call, with its transcript -----------------------------
  const calls = await import("@/lib/contentCallRecords");
  let call = await prisma.programCallRecord.findFirst({ where: { enrollmentId, callType: "MONTHLY_STRATEGY", matchNote: { contains: callNote } }, select: { id: true } });
  if (!call) {
    // A week before the shoot (the anchor above): planned, then filmed.
    const id = await calls.createManualCallRecord({ clientId: client.id, callType: "MONTHLY_STRATEGY", scheduledStart: callAt, scheduledEnd: new Date(callAt.getTime() + 45 * 60_000), targetMonthKey: opts.monthKey, by: ACTOR, note: callNote });
    call = { id };
    did(`monthly strategy call record (held ${callAt.toISOString().slice(0, 10)})`);
  }
  const callId = call.id;
  if (!(await prisma.programTranscriptSource.count({ where: { callRecordId: callId, matchState: "CONFIRMED" } }))) {
    await calls.attachPastedTranscript(callId, transcriptFor(client.name ?? "TEST client", opts.monthKey), ACTOR, "paste");
    did("pasted transcript confirmed on the call (INGEST + ANALYZE jobs queued)");
  }

  // ---- 7. this month's selections ------------------------------------------
  const selected = async (topic: string, monthId: string) =>
    !!(await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: topic, monthId } }, select: { id: true } }));
  for (const k of ["A", "B"] as const) {
    if (await selected(T[k], month.id)) continue;
    await ct.selectTopicForMonth(T[k], month.id, {
      source: "call", actor: staff, callRecordId: callId, status: "SELECTED",
      evidence: { excerpts: CALL_LINES[k].map((text) => ({ speaker: "client", source: "call", text })) },
    });
    did(`${k}: "${titleOf(k)}" selected from the call`);
  }
  for (const k of ["C", "D"] as const) {
    if (await selected(T[k], month.id)) continue;
    await ct.selectTopicForMonth(T[k], month.id, { source: "client", actor: clientActor, status: "SELECTED" });
    did(`${k}: "${titleOf(k)}" chosen by the client (written path)`);
  }

  // ---- 8. the written answers: C sufficient, D thin -------------------------
  const ci = await import("@/lib/contentInterview");
  const answerer = { clientUserId: owner.person.id };
  const interviewFor = async (k: "C" | "D") => {
    const id = await ci.getOrCreateInterview(T[k], month.id, answerer);
    if (await prisma.contentInterviewAnswer.count({ where: { interviewId: id } })) return id;
    const MAIN = ["audienceProblem", "pointOfView", "talkingPoints", "evidence", "story", "nextAction"];
    if (k === "C") {
      for (const q of MAIN) await ci.answerQuestion(id, q, { text: CANNED_ANSWERS[q], kind: "TYPED", actor: answerer });
    } else {
      await ci.answerQuestion(id, "audienceProblem", { text: "Sellers.", kind: "TYPED", actor: answerer });
      for (const q of MAIN.slice(1)) await ci.answerQuestion(id, q, { kind: "SKIPPED", actor: answerer });
    }
    // Follow-ups and gap questions the plan asks next, answered (C) or skipped (D).
    for (let i = 0; i < 12; i++) {
      const st = await ci.interviewState(id);
      if (st.next.kind === "done" || !st.nextKey) break;
      await ci.answerQuestion(id, st.nextKey, k === "C" ? { text: FOLLOW_UP_ANSWER, kind: "TYPED", actor: answerer } : { kind: "SKIPPED", actor: answerer });
    }
    if (k === "C") {
      const out = await ci.submitInterview(id, answerer);
      did(`C: interview answered and ${out.status}`);
    } else {
      const st = await ci.interviewState(id);
      did(`D: interview answered thinly — ${st.status}`);
    }
    return id;
  };
  const ivC = await interviewFor("C");
  await interviewFor("D");

  // ---- 9. scripts ----------------------------------------------------------
  const scr = await import("@/lib/contentScripts");
  const sd = await import("@/lib/scriptDecisions");
  const enrollmentName = client.name ?? "";
  const viewer = (): PortalViewer => ({
    enrollment: { id: enrollmentId, clientId: client.id, clientName: enrollmentName, status: "ACTIVE", videosPerMonth: enrollment!.videosPerMonth, sessionsPerMonth: enrollment!.sessionsPerMonth },
    actor: { kind: "CLIENT", clientUserId: owner!.person.id, email: owner!.person.email, name: owner!.person.name, membershipId: owner!.seatId, membershipRole: "OWNER" },
    access: "FULL",
    via: "LOGIN",
  });
  const scriptFor = async (k: "A" | "B" | "C" | "E", monthId: string, extra: { interviewId?: string; callRecordId?: string }): Promise<string> => {
    const found = await prisma.contentScript.findFirst({ where: { enrollmentId, topicId: T[k], historical: false }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (found) return found.id;
    const hook = k === "A" ? "The first weekend decides your price." : k === "B" ? "Buyers decide on the walk to the coffee shop." : k === "C" ? "The inspection you skip is the one that costs you." : "Your photos are sold in the first three rooms.";
    const r = await scr.createScriptVersion({
      enrollmentId, monthId, topicId: T[k], parts: scriptParts(titleOf(k), pillarOf(k), hook), source: "MANUAL", status: "INTERNAL_REVIEW",
      createdBy: ACTOR, changeSummary: REPRESENTATIVE_MARKER, interviewId: extra.interviewId ?? null, callRecordId: extra.callRecordId ?? null,
    });
    did(`${k}: script drafted`);
    return r.scriptId;
  };
  const approveAndRelease = async (k: string, scriptId: string) => {
    const s = await prisma.contentScript.findUniqueOrThrow({ where: { id: scriptId }, select: { currentVersionId: true, approvedVersionId: true, sharedVersionId: true, releaseState: true } });
    if (!s.approvedVersionId) {
      await scr.approveScriptVersion(s.currentVersionId!, { email: ACTOR });
      did(`${k}: script approved`);
    }
    if (!s.sharedVersionId || s.releaseState !== "released") {
      await scr.releaseScriptVersion(scriptId, { email: ACTOR }, { note: REPRESENTATIVE_MARKER });
      did(`${k}: script released to the portal`);
    }
    return (await prisma.contentScript.findUniqueOrThrow({ where: { id: scriptId }, select: { sharedVersionId: true } })).sharedVersionId!;
  };
  const clientVerdict = async (scriptId: string) =>
    prisma.contentScriptRelease.count({ where: { scriptId, action: { in: ["CLIENT_APPROVED", "CLIENT_CHANGES"] } } });

  // IS "LAST MONTH" REALLY PAST? (Sep 24.) The program tier seeds any month
  // from this one on — `create-test-client --jordan 2026-10` — and then "last
  // month" is the LIVE current month: the §16 account's month in flight. The
  // fixture used to select E into it, close it with a raw status update (no
  // month-close function, no close checks) and carry E out of it. Now a month
  // that is not over is left exactly as it is, and E goes straight onto the
  // month being seeded, still released and waiting on the client.
  const lastIsPast = lastMonthKey < currentKey;
  const lastTopics: string[] = [];
  if (lastIsPast) {
    // E lives in LAST month first: selected, scripted, released, never filmed.
    if (!(await selected(T.E, lastMonth.id)) && !(await selected(T.E, month.id))) {
      await ct.selectTopicForMonth(T.E, lastMonth.id, { source: "staff", actor: staff, status: "SELECTED" });
      did(`E: "${titleOf("E")}" selected for ${lastMonthKey}`);
    }
    const sE = await scriptFor("E", lastMonth.id, {});
    await approveAndRelease("E", sE);
    // Full tier: the two topics last month's two delivered videos were filmed
    // on — chosen, scripted, released and approved by the client, as a
    // finished month's would be. seedFullTier records them filmed on last
    // month's job, so those library rows carry a topic, a title and a script.
    if (opts.tier === "full") {
      for (const [k, [pi, ti]] of Object.entries(LAST_FILMED)) {
        const id = bank[pi][ti];
        lastTopics.push(id);
        if (!(await selected(id, lastMonth.id))) {
          await ct.selectTopicForMonth(id, lastMonth.id, { source: "client", actor: clientActor, status: "SELECTED" });
          did(`${k}: "${TOPIC_TITLES[pi][ti]}" chosen for ${lastMonthKey}`);
        }
        let sid = (await prisma.contentScript.findFirst({ where: { enrollmentId, topicId: id, historical: false }, select: { id: true } }))?.id ?? null;
        if (!sid) {
          sid = (await scr.createScriptVersion({
            enrollmentId, monthId: lastMonth.id, topicId: id, parts: scriptParts(TOPIC_TITLES[pi][ti], pillars[pi], "Here is what the listings never tell you."), source: "MANUAL", status: "INTERNAL_REVIEW",
            createdBy: ACTOR, changeSummary: REPRESENTATIVE_MARKER,
          })).scriptId;
          did(`${k}: script drafted`);
        }
        const v = await approveAndRelease(k, sid);
        if (!(await clientVerdict(sid))) {
          const r = await sd.clientApproveScript(viewer(), sid, v);
          if (!r.ok) throw new Error(`${k}: the client's approval was refused — ${r.message}`);
          did(`${k}: the client approved the script`);
        }
      }
    }
    if (lastMonth.status !== "COMPLETED") {
      await prisma.contentMonth.update({ where: { id: lastMonth.id }, data: { status: "COMPLETED" } });
      did(`${lastMonthKey} COMPLETED`);
    }
  } else {
    log(`  ! ${lastMonthKey} is the live current month — left ${lastMonth.status} and untouched (not closed, nothing carried out of it); E goes straight onto ${opts.monthKey}`);
    if (!(await selected(T.E, month.id))) {
      await ct.selectTopicForMonth(T.E, month.id, { source: "staff", actor: staff, status: "SELECTED" });
      did(`E: "${titleOf("E")}" selected for ${opts.monthKey} (no past month to carry it from)`);
    }
    await approveAndRelease("E", await scriptFor("E", month.id, {}));
  }

  const sA = await scriptFor("A", month.id, { callRecordId: callId });
  const vA = await approveAndRelease("A", sA);
  if (!(await clientVerdict(sA))) {
    const r = await sd.clientApproveScript(viewer(), sA, vA);
    if (!r.ok) throw new Error(`A: the client's approval was refused — ${r.message}`);
    did("A: the client approved the script");
  }
  const sB = await scriptFor("B", month.id, { callRecordId: callId });
  const vB = await approveAndRelease("B", sB);
  if (!(await clientVerdict(sB))) {
    const r = await sd.clientRequestScriptChanges(viewer(), sB, "Can we open on the coffee shop line instead? And mention the farmers market on Saturdays.", vB);
    if (!r.ok) throw new Error(`B: the client's change request was refused — ${r.message}`);
    did("B: the client asked for a change");
  }
  await scriptFor("C", month.id, { interviewId: ivC });

  // The carry, last: on a full month it is kept and flagged, never dropped.
  if (!(await selected(T.E, month.id))) {
    const r = await ct.carryScriptedTopic(T.E, month.id, { actor: { kind: "SYSTEM" }, reason: "ROLLOVER" });
    if (r.outcome !== "CARRIED") throw new Error(`E: the carry did not happen — ${r.refusal ?? r.note ?? r.outcome}`);
    did(`E: carried into ${opts.monthKey}${r.overflow ? " (beyond this month's allowance — kept and flagged)" : ""}`);
  }

  // ---- 10. the session request ---------------------------------------------
  const sr = await import("@/lib/sessionRequests");
  const dayWord = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
  const slotFor = (monthKey: string, afterDays: number): { start: Date; end: Date } | null => {
    // A weekday at 10:00 ET, `afterDays` ahead — CLAMPED to the month's last
    // weekday (Sep 24: there was no upper bound, so late in a month Pro's
    // "second September session" was filed under September and dated in
    // October). Null when no weekday of the month is still ahead; the ask is
    // then a free-text one, as a client would make it.
    const [y, m] = monthKey.split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const weekday = (d: number) => { const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); return dow !== 0 && dow !== 6; };
    const want = etDayKey(new Date(Math.max(now.getTime() + afterDays * 86_400_000, monthFirst)));
    const wantDay = want.slice(0, 7) === monthKey ? Number(want.slice(8, 10)) : want < monthKey ? 1 : days;
    const at = (d: number) => etAt(`${monthKey}-${String(d).padStart(2, "0")}`, 10);
    const ahead = (d: number) => at(d).getTime() > now.getTime() + 60 * 60_000;
    let day: number | null = null;
    for (let d = wantDay; d <= days && day === null; d++) if (weekday(d) && ahead(d)) day = d;
    for (let d = Math.min(wantDay, days); d >= 1 && day === null; d--) if (weekday(d) && ahead(d)) day = d;
    if (day === null) return null;
    const start = at(day);
    return { start, end: new Date(start.getTime() + (enrollment!.sessionHours || 4) * 3_600_000) };
  };
  const markedRequests = () => prisma.programSessionRequest.findMany({ where: { enrollmentId, monthId: month.id, notes: { contains: REPRESENTATIVE_MARKER } }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, projectId: true } });
  const requestSession = async (label: string, slot: { start: Date; end: Date } | null, when: string) => {
    const r = await sr.createSessionRequest({
      enrollmentId, monthId: month.id, actor: { kind: "CLIENT", clientUserId: owner!.person.id },
      slot: {
        ...(slot ? { startISO: slot.start.toISOString(), endISO: slot.end.toISOString() } : { when }),
        timezone: "America/New_York", locationText: "Montgomery County (general area)", notes: `${REPRESENTATIVE_MARKER} ${label}`,
      },
    });
    if (!r.ok) throw new Error(`session request refused — ${r.reason}`);
    // Two free-text asks in one month are one request (sessionRequests' dedupe
    // key) — only possible when no weekday of the month is left for a time.
    if (r.duplicate) log(`  ! session request ${label} is the same ask as ${r.id} — no weekday of ${opts.monthKey} is left for a separate time`);
    else did(`session request ${label} (${slot ? `${slot.start.toISOString().slice(0, 16)}Z` : `"${when}"`}, ${r.status})`);
    return r.id;
  };
  if ((await markedRequests()).length === 0) {
    // The full tier's first ask IS the session already filmed (shootAt): the
    // office confirms it on that job below. It used to be a slot two days
    // AHEAD confirmed onto a job filmed four days AGO, so a one-session month
    // showed the session held and a second one booked. A request cannot be
    // made for a past slot (sessionRequests refuses it), so it is the
    // client's free-text ask for that morning.
    if (opts.tier === "full") await requestSession("1", null, `${dayWord(shootAt)}, morning`);
    else await requestSession("1", slotFor(opts.monthKey, 2), `Any weekday morning before ${opts.monthKey} ends`);
  }

  // ---- 11. the full tier ---------------------------------------------------
  // (The ids it makes are read back by summarise, like everything else.)
  if (opts.tier === "full") {
    const { projectId } = await seedFullTier(prisma, {
      client: { id: client.id, name: enrollmentName }, enrollmentId, pkg, videosOwed: enrollment.videosPerMonth, month, lastMonth, viewer, did, now, shootAt,
      filmed: { now: [T.A, T.B, T.C, T.D], last: lastTopics },
    });

    // Sessions: the ask is confirmed on the job it was filmed on; Pro books its
    // second four-hour session and it is confirmed too.
    let reqs = await markedRequests();
    const first = reqs[0];
    if (first && first.status !== "CONFIRMED") {
      await sr.confirmSessionRequest(first.id, { projectId }, ACTOR);
      did("session 1 confirmed on this month's job");
    }
    if (pkg === "Pro") {
      if (reqs.length < 2) await requestSession("2", slotFor(opts.monthKey, 9), `Any weekday before ${opts.monthKey} ends`);
      reqs = await markedRequests();
      if (reqs[1] && reqs[1].status !== "CONFIRMED") {
        await sr.confirmSessionRequest(reqs[1].id, {}, ACTOR);
        did("session 2 confirmed");
      }
    }
    const { syncEnrollmentVideos } = await import("@/lib/contentVideos");
    const lib = await syncEnrollmentVideos({ id: enrollmentId, clientId: client.id });
    if (lib.created) did(`library: ${lib.created} video row(s) built by syncEnrollmentVideos`);
  }

  // ---- 12. the ended account ---------------------------------------------------
  if (opts.variant === "ended") {
    const { setEnrollmentStatus } = await import("@/lib/enrollmentChanges");
    await setEnrollmentStatus(enrollmentId, "ENDED", ACTOR, `${REPRESENTATIVE_MARKER} ended variant`);
    did("program ENDED (the library and the month stay)");
  }

  return summarise(prisma, { client, enrollmentId, opts, lastMonthKey, callNote, wrote });
}

// ---------------------------------------------------------------------------
// THE FULL TIER: cuts, a revision round, a delivery, last month's deliveries.
// ---------------------------------------------------------------------------
type MonthRow = { id: string; monthKey: string };

async function seedFullTier(
  prisma: PrismaClient,
  a: {
    client: { id: string; name: string }; enrollmentId: string; pkg: string; videosOwed: number;
    month: MonthRow; lastMonth: MonthRow; viewer: () => PortalViewer; did: (line: string) => void; now: Date;
    /** the anchor the call and the session request were dated from */
    shootAt: Date;
    /** the topics each job's footage is of, in slot order */
    filmed: { now: string[]; last: string[] };
  },
): Promise<{ projectId: string; lastProjectId: string; cuts: NonNullable<RepresentativeResult["cuts"]> }> {
  const { did, now } = a;
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { openReviewWindow } = await import("@/lib/reviewWindows");
  const { addApprovedCutToLibrary } = await import("@/lib/portalLibrary");
  const cd = await import("@/lib/clientDecisions");
  const { markVideoSent } = await import("@/lib/readyToSend");
  const slug = a.client.name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "") || "test";

  const ensureProject = async (m: MonthRow, o: { status: "EDITING" | "DELIVERED"; shootDate: Date; quantity: number; deliveredAt?: Date | null }) => {
    const title = `${a.client.name} — ${m.monthKey} program month ${REPRESENTATIVE_MARKER}`;
    const found = await prisma.project.findFirst({ where: { clientId: a.client.id, contentMonthId: m.id, title }, select: { id: true } });
    let id = found?.id ?? null;
    if (!id) {
      // MANUAL, no Aryeo order, listing or customer: a job the hub made, which
      // every Aryeo sweep skips.
      const p = await prisma.project.create({
        data: { clientId: a.client.id, title, status: o.status, contentMonthId: m.id, packageName: `Video ${a.pkg}`, shootDate: o.shootDate, source: "MANUAL", deliveredAt: o.deliveredAt ?? null },
        select: { id: true },
      });
      id = p.id;
      await prisma.deliverable.create({ data: { projectId: id, type: "SOCIAL_REEL", label: `Video ${a.pkg}`, productTitle: `Video ${a.pkg}`, quantity: o.quantity } });
      did(`Project ${m.monthKey} (${o.status}, ${o.quantity} videos owed)`);
    }
    await ensureOutputsForProject(id);
    const reel = await prisma.deliverable.findFirstOrThrow({ where: { projectId: id, type: "SOCIAL_REEL" }, select: { id: true } });
    return { id, deliverableId: reel.id };
  };
  const ensureCut = async (p: { id: string; deliverableId: string }, slot: number, round: number, monthKey: string) => {
    const found = await prisma.reviewSubmission.findFirst({ where: { projectId: p.id, deliverableId: p.deliverableId, slot, round }, select: { id: true } });
    if (found) return found.id;
    const row = await prisma.reviewSubmission.create({
      data: { projectId: p.id, deliverableId: p.deliverableId, slot, round, status: "PENDING", source: "upload", fileName: `${slug}-${monthKey}-video${slot}-v${round}.mp4` },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), blobUrl: DEMO_CLIP_URL } });
    did(`cut ${monthKey} video ${slot} v${round}`);
    return row.id;
  };
  /** Jordan's Review Room approve IS the release (CP-02): the verdict, then the
   *  window with its frozen deadline, then the library row. The Dropbox copy
   *  and the 1080p job the Review Room also starts are provider work and are
   *  not part of a fixture. */
  const release = async (id: string, at: Date) => {
    const moved = await prisma.reviewSubmission.updateMany({ where: { id, status: "PENDING" }, data: { status: "APPROVED", decidedAt: at, decidedBy: "Jordan (CP-15 fixture)" } });
    await openReviewWindow(id, { at, by: "Jordan (CP-15 fixture)" });
    await addApprovedCutToLibrary(id).catch(() => false);
    if (moved.count) did(`released cut ${id.slice(-6)}`);
  };
  const decided = async (id: string) => prisma.clientDecision.count({ where: { submissionId: id, enrollmentId: a.enrollmentId } });
  const approveAsClient = async (id: string, label: string) => {
    if (await decided(id)) return;
    const r = await cd.approveCut(a.viewer(), id, "NONE");
    if (!r.ok) throw new Error(`${label}: the client's approval was refused — ${r.message}`);
    did(`${label}: approved by the client`);
  };
  const sendToClient = async (id: string, label: string) => {
    const s = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id }, select: { sentToClientAt: true } });
    if (s.sentToClientAt) return;
    const r = await markVideoSent(id, "Kyle (CP-15 fixture)");
    if (!r.ok) throw new Error(`${label}: could not be marked sent — ${r.message}`);
    did(`${label}: sent to the client (delivered)`);
  };

  /**
   * THE FILMING HANDOFF (Sep 24): the photographer's "which topics did you
   * film", through the upload page's own path — prepareFilmingReport, the row
   * (createMany + skipDuplicates, with the job's videosFilmed, as
   * finalizeUpload writes them), then applyFilmingReport, which confirms each
   * topic's video and binds it to the job's owed-video slot in the month's
   * order. Without it every library row was a file name ("Avery accelerator
   * test 2026 09 video3"), had no topic or script, and the caption assistant
   * had nothing to draft from. It runs BEFORE the cuts: a slot that already
   * holds a review round is not free to bind.
   */
  const reportFilming = async (projectId: string, topicIds: string[], label: string) => {
    if (!topicIds.length || (await prisma.contentFilmingReport.count({ where: { projectId, state: "APPLIED" } }))) return;
    const ft = await import("@/lib/filmedTopics");
    const prep = await ft.prepareFilmingReport(projectId, { filmedTopicIds: topicIds }, { name: "Harrison (CP-15 fixture)" }, now);
    if (!prep) throw new Error(`${label}: the filming report had nothing to record`);
    await prisma.$transaction([
      prisma.contentFilmingReport.createMany({ data: [prep.row], skipDuplicates: true }),
      prisma.project.update({ where: { id: projectId }, data: { videosFilmed: prep.videosFilmed } }),
    ]);
    const row = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { projectId_payloadHash: { projectId, payloadHash: prep.payloadHash } }, select: { id: true } });
    const r = await ft.applyFilmingReport(row.id, { now });
    if (r.state !== "APPLIED" || r.unbound.length) throw new Error(`${label}: the filming report did not land cleanly — ${r.state} ${r.error ?? ""} ${r.unbound.join(", ")}`);
    did(`${label}: ${r.confirmed} topic(s) confirmed filmed, ${r.bound} bound to the job's video slots`);
  };

  // Last month first: its two videos were filmed, approved and delivered.
  const lastShoot = new Date(now.getTime() - 30 * 86_400_000);
  const lastP = await ensureProject(a.lastMonth, { status: "DELIVERED", shootDate: lastShoot, quantity: 2, deliveredAt: new Date(now.getTime() - 20 * 86_400_000) });
  await reportFilming(lastP.id, a.filmed.last, `${a.lastMonth.monthKey} filming`);
  const last: string[] = [];
  for (const slot of [1, 2]) {
    const id = await ensureCut(lastP, slot, 1, a.lastMonth.monthKey);
    await release(id, new Date(now.getTime() - 60 * 60_000));
    await approveAsClient(id, `${a.lastMonth.monthKey} video ${slot}`);
    await sendToClient(id, `${a.lastMonth.monthKey} video ${slot}`);
    last.push(id);
  }

  // This month: filmed at the anchor — a few days ago, a week after the call.
  const p = await ensureProject(a.month, { status: "EDITING", shootDate: a.shootAt, quantity: a.videosOwed });
  await reportFilming(p.id, a.filmed.now, `${a.month.monthKey} filming`);
  const releasedAt = new Date(now.getTime() - 30 * 60_000);
  const A = await ensureCut(p, 1, 1, a.month.monthKey);
  const B = await ensureCut(p, 2, 1, a.month.monthKey);
  const C = await ensureCut(p, 3, 1, a.month.monthKey);
  const D = await ensureCut(p, 4, 1, a.month.monthKey);
  for (const id of [A, B, C, D]) await release(id, releasedAt);
  // B: the client sends it back with a note — decision, round, revision brief.
  if (!(await decided(B))) {
    const r = await cd.requestChangesOnCut(a.viewer(), B, "Tighten the first three seconds and bring the music down under my voice.");
    if (!r.ok) throw new Error(`B: the client's change request was refused — ${r.message}`);
    did("B: the client asked for changes (round 1)");
  }
  // …and the editor's round 2 is in, waiting for Jordan in the Review Room.
  const B2 = await ensureCut(p, 2, 2, a.month.monthKey);
  await approveAsClient(C, "C");
  await approveAsClient(D, "D");
  await sendToClient(D, "D");
  return { projectId: p.id, lastProjectId: lastP.id, cuts: { A, B, B2, C, D, last } };
}

// ---------------------------------------------------------------------------

async function summarise(
  prisma: PrismaClient,
  s: { client: { id: string }; enrollmentId: string; opts: RepresentativeOptions; lastMonthKey: string; callNote: string; wrote: string[] },
): Promise<RepresentativeResult> {
  const [month, lastMonth] = await Promise.all([
    prisma.contentMonth.findUniqueOrThrow({ where: { enrollmentId_monthKey: { enrollmentId: s.enrollmentId, monthKey: s.opts.monthKey } }, select: { id: true } }),
    prisma.contentMonth.findUniqueOrThrow({ where: { enrollmentId_monthKey: { enrollmentId: s.enrollmentId, monthKey: s.lastMonthKey } }, select: { id: true } }),
  ]);
  const topic = async (k: keyof typeof PICK) =>
    (await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: s.enrollmentId, title: TOPIC_TITLES[PICK[k][0]][PICK[k][1]] }, select: { id: true } })).id;
  const topics = { A: await topic("A"), B: await topic("B"), C: await topic("C"), D: await topic("D"), E: await topic("E") };
  const script = async (t: string) => (await prisma.contentScript.findFirstOrThrow({ where: { enrollmentId: s.enrollmentId, topicId: t, historical: false }, orderBy: { createdAt: "asc" }, select: { id: true } })).id;
  const interview = async (t: string) => (await prisma.contentInterview.findUniqueOrThrow({ where: { topicId_monthId: { topicId: t, monthId: month.id } }, select: { id: true } })).id;
  const call = await prisma.programCallRecord.findFirstOrThrow({ where: { enrollmentId: s.enrollmentId, callType: "MONTHLY_STRATEGY", matchNote: { contains: s.callNote } }, select: { id: true } });
  const requests = await prisma.programSessionRequest.findMany({ where: { enrollmentId: s.enrollmentId, monthId: month.id, notes: { contains: REPRESENTATIVE_MARKER } }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const projectOf = async (monthId: string) =>
    (await prisma.project.findFirst({ where: { clientId: s.client.id, contentMonthId: monthId, title: { contains: REPRESENTATIVE_MARKER } }, select: { id: true } }))?.id ?? null;
  const projectId = await projectOf(month.id);
  const lastProjectId = await projectOf(lastMonth.id);
  let cuts: RepresentativeResult["cuts"] = null;
  if (projectId && lastProjectId) {
    const cut = async (projectId: string, slot: number, round: number) =>
      (await prisma.reviewSubmission.findFirstOrThrow({ where: { projectId, slot, round }, select: { id: true } })).id;
    cuts = {
      A: await cut(projectId, 1, 1), B: await cut(projectId, 2, 1), B2: await cut(projectId, 2, 2), C: await cut(projectId, 3, 1), D: await cut(projectId, 4, 1),
      last: [await cut(lastProjectId, 1, 1), await cut(lastProjectId, 2, 1)],
    };
  }
  return {
    clientId: s.client.id, enrollmentId: s.enrollmentId, monthId: month.id, lastMonthId: lastMonth.id, monthKey: s.opts.monthKey, lastMonthKey: s.lastMonthKey,
    tier: s.opts.tier, variant: s.opts.variant, topics,
    scripts: { A: await script(topics.A), B: await script(topics.B), C: await script(topics.C), E: await script(topics.E) },
    interviews: { C: await interview(topics.C), D: await interview(topics.D) },
    callRecordId: call.id, sessionRequestIds: requests.map((r) => r.id), projectId, lastProjectId, cuts, wrote: s.wrote,
  };
}

// ---------------------------------------------------------------------------
// FOR ISOLATED DRILLS: the bare TEST client scripts/create-test-client.ts makes
// (name with TEST, a plus-address of info@, no phone, no Aryeo id, both
// auto-texts OFF, a Starter enrollment owned by hand, one OWNER seat), so a
// drill seeds on the same starting point a live run would. Never used on a
// live database — create-test-client is the tool there.
// ---------------------------------------------------------------------------
export async function createTestClientShell(prisma: PrismaClient, o: { name: string; slug: string; email?: string }): Promise<{ clientId: string; enrollmentId: string; clientUserId: string; membershipId: string }> {
  const email = o.email ?? `info+${o.slug}test@realtourpilot.com`;
  const client = await prisma.client.create({
    data: { name: o.name, email, phone: null, autoConfirmationText: false, autoDeliveryText: false, brandAssetsPath: `/RealTour Pilot TEST FIXTURES/${o.name}/Brand Assets`, generalNotes: "SYNTHETIC TEST CLIENT (drill)." },
    select: { id: true },
  });
  const e = await prisma.contentEnrollment.create({
    data: { clientId: client.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, status: "ACTIVE", statusManual: true, packageSource: "manual", startedAt: new Date(Date.now() - 60 * 86_400_000) },
    select: { id: true },
  });
  const person = await prisma.clientUser.create({ data: { email, name: o.name, status: "ACTIVE" }, select: { id: true } });
  const seat = await prisma.clientMembership.create({ data: { clientUserId: person.id, enrollmentId: e.id, clientId: client.id, role: "OWNER", acceptedAt: new Date() }, select: { id: true } });
  return { clientId: client.id, enrollmentId: e.id, clientUserId: person.id, membershipId: seat.id };
}
