// ---------------------------------------------------------------------------
// DRILL: CP-07 — the topic bank keeps itself stocked, clients can say "not
// interested", unfilmed scripts carry forward and can be swapped, a client's
// own idea goes straight into the month, and call-extracted ideas stay off the
// client's page until Jordan approves them (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp07-topic-bank.ts
//
// The OLD behaviour is asserted first wherever it can be observed: the old
// contentTopics.ts and portal/actions.ts are loaded for real from HEAD (the
// commit this batch starts from), their `@/` imports pointed at this tree.
//
//   1. The shared primitives: who may see what, and what occupies a month.
//   2. Approving a strategy queues ONE initial bank run and spends nothing;
//      with `topic_refresh` absent the sweep does nothing at all.
//   3. `topic_refresh` ON, `ai_runs` OFF: the run stays QUEUED, attempt
//      refunded — a pause, not a failure. A lone RECOMMENDATION run does not
//      raise BANK_GENERATED any more (it did).
//   4. Both ON: the initial bank lands as 24 PENDING suggestions, zero topics,
//      and the client's page is unchanged.
//   5. Accept 10 per pillar, archive the rest: every pillar at target, the
//      sweep queues nothing; COMPLETE only once the bank was reviewed.
//   6. Film two pillar-A topics: exactly one refill, for pillar A, keeping 2;
//      an archived title the model offers again is withheld. A second sweep
//      queues nothing (weekly cooldown).
//   7. "Not interested" (portal action): off the page, on the staff list with
//      the reason, blocked from refreshes; undo brings it back on the record.
//   8. Carryover: off → nothing; dry run lists it; on → the unfilmed script
//      carries into October with its history; monthCapacity counts it (the
//      old one did not); the month owes no new script; a second sweep is a
//      no-op.
//   9. Swap (portal action): the carried slot goes to another topic, script /
//      versions / decisions untouched, allowance unchanged; the parked script
//      is re-used for November without a draft.
//  10. A late filming confirmation undoes a carry (FILMED_LATE).
//  11. deselect: a call's PROPOSED re-mention of a topic scripted months ago
//      can be dropped (the old code threw).
//  12. A client's own idea goes into the month; a full month says "extra"; a
//      closed month is an honest failure (the old action said "Added").
//  13. Call analysis: discussed and "declined on the call" ideas stay off the
//      client's page (the old bank showed them); the call's PROPOSED pick is
//      shown; an approved one appears.
//
// ISOLATION: PGlite on 127.0.0.1:5513 via the shared harness. Production is
// never opened; every outbound call is fenced and counted; the model is
// stubbed at aiJsonWithUsage (the ledger, leases, dedupe and switches are real).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5513);
const REPO = path.resolve(__dirname, "../..");
const BASE = "e26cacd"; // the commit batch B starts from

installNextStubs();
const fence = fenceFetch();

// The staff actions run on the sessionless dev path (getCurrentUser throws
// outside a request and they fall back to "dev@local"), so the drill makes
// that address the strategy owner — assertDutyOwner then passes on its own
// rules rather than on a stub.
const STAFF_EMAIL = "dev@local";

// ---- the model boundary: the tokens are fake, everything around them is real ----
let aiCalls = 0;
const prompts: { system: string; prompt: string }[] = [];
/** Titles to put FIRST in the next bank answer for a pillar (then consumed). */
const inject: Record<string, string[]> = {};
let bankRound = 0;
let analysisNext: unknown = null;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        aiCalls++;
        prompts.push({ system: opts.system, prompt: opts.prompt });
        const usage = { inputTokens: 900, outputTokens: 300 };
        if (/Video Topic Bank/.test(opts.system)) {
          bankRound++;
          const pillars = [...new Set([...opts.prompt.matchAll(/Pillar \d+: ([A-Za-z ]+)/g)].map((m) => m[1].trim()))];
          const out = pillars.map((p) => {
            const extra = inject[p] ?? [];
            inject[p] = [];
            const fresh = Array.from({ length: 12 }, (_, i) => `${p} angle ${bankRound}.${i + 1}`);
            return {
              pillarName: p,
              topics: [...extra, ...fresh].map((title) => ({ title, description: `About ${title}.`, audienceNeed: "Sellers deciding when to list", businessGoal: "Trust", intendedMessage: "Plan before you list", sourceRef: null })),
            };
          });
          return { result: { complete: true, pillars: out, gaps: [] }, usage, model: "drill-stub" };
        }
        if (/processing a call transcript/.test(opts.system)) {
          return { result: analysisNext, usage, model: "drill-stub" };
        }
        const title = (/TOPIC:\s*(.+)/.exec(opts.prompt)?.[1] ?? "Drafted topic").trim().slice(0, 90);
        return {
          result: { title, category: "Market Authority", hook: "The first weekend decides it.", points: [{ role: "re-hook", text: "Buyers read days on market." }, { role: "build-up", text: "Stale listings invite low offers." }, { role: "payoff", text: "Price it right on day one." }], close: "Plan before the photos.", captionCta: null, filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [] },
          usage, model: "drill-stub",
        };
      };
    },
  }),
);

/** The OLD modules, byte for byte from BASE, their `@/` imports aimed at this tree. */
function writeBaseCopies(): { dir: string; topics: string; portalActions: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp07-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const topics = path.join(dir, "contentTopics.base.ts");
  fs.writeFileSync(topics, point(show("src/lib/contentTopics.ts")));
  const portalActions = path.join(dir, "portalActions.base.ts");
  fs.writeFileSync(portalActions, point(show("src/app/portal/actions.ts")));
  return { dir, topics, portalActions };
}
function removeBaseCopies(dir: string) {
  try {
    fs.unlinkSync(path.join(dir, "node_modules"));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* a leftover temp dir is harmless */ }
}

/** An Arielle-template strategy with two pillars, rendered by the policy's own renderer (what a discovery draft produces). */
async function strategyText(name: string): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const doc = {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice, local depth.", brandMessage: "Plan the sale before the sign goes up.", shortBrandStatement: null, brandVoice: "Plain, direct, warm.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers and first-time buyers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers", "Show local market expertise"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Lead with pricing and timing."], pillars: [
      { number: 1, name: "Market Authority", heading: "Pillar 1: Market Authority", purpose: "Show command of the local market.", focusAreas: "pricing, timing, days on market", contentApproach: null, otherFields: [] },
      { number: 2, name: "Seller Education", heading: "Pillar 2: Seller Education", purpose: "Teach sellers what to do before listing.", focusAreas: "prep, repairs, inspections", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PRICE for a pricing plan."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["Lead with pricing and timing this quarter."] }, otherSections: [],
  };
  return renderStrategy(doc as unknown as Parameters<typeof renderStrategy>[0]);
}

/** "YYYY-MM" shifted by n months. */
const shiftKey = (key: string, n: number) => { const [y, m] = key.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

async function main() {
  const { server, stop } = await bootDrillDb({ port: PORT });
  // The months are relative to the real ET month: the portal's actions (and a
  // carry) only treat a month as open from the current one on, so a drill
  // pinned to fixed dates would stop being about "last month" next month.
  const { etMonthKey } = await import("@/lib/contentProgram");
  const CUR = etMonthKey(new Date());
  const PREV = shiftKey(CUR, -1);
  const NEXT = shiftKey(CUR, 1);
  const LONG_AGO = shiftKey(CUR, -2);
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const ct = await import("@/lib/contentTopics");
  const { createStrategyVersion, structuredFromText, approveStrategyVersion, releaseStrategyVersion } = await import("@/lib/contentStrategy");
  const { ensureOnboardingRecord, advanceOnboarding } = await import("@/lib/programOnboarding");
  const { portalTopics } = await import("@/lib/portal");
  const { confirmFilmedTopics } = await import("@/lib/filmedTopics");
  const { scriptWorkForMonth, sweepOwedScripts } = await import("@/lib/contentDrafting");
  const { createScriptVersion } = await import("@/lib/contentScripts");
  const { recalcProgramMonth } = await import("@/lib/programMonths");
  const contentActions = await import("@/app/content/actions");
  const portalActions = await import("@/app/portal/actions");
  const base = writeBaseCopies();
  type Actor = import("@/lib/contentTopics").Actor;
  const old = (await import(base.topics)) as {
    monthCapacity: (m: string) => Promise<{ owed: number; selected: number; overflow: number }>;
    selectTopicForMonth: (t: string, m: string, o: { source: "call"; actor: Actor; status: "PROPOSED" }) => Promise<unknown>;
    deselectTopic: (t: string, m: string, a: Actor) => Promise<void>;
    topicBankByPillar: (e: string) => Promise<{ groups: { topics: { id: string; title: string }[] }[]; total: number }>;
  };
  const oldPortal = (await import(base.portalActions)) as { portalSuggestTopic: (auth: { token?: string | null }, input: { title: string; monthId?: string | null }) => Promise<{ ok: boolean; message: string; id?: string }> };

  const setSwitch = async (key: string, enabled: boolean) => {
    await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled } });
  };
  const STAFF: Actor = { kind: "STAFF", staffUserId: STAFF_EMAIL };

  try {
    // ======================================================================
    c.head("1 · the shared primitives");
    const see = (o: Partial<Parameters<typeof ct.clientCanSeeTopic>[0]>, live = false) => ct.clientCanSeeTopic({ status: "SAVED", approvalState: "PROPOSED", source: "staff", proposedState: null, clientDeclinedAt: null, ...o }, live);
    c.ok("a staff topic is visible", see({}));
    c.ok("a client's own PROPOSED idea is visible (usable without approval)", see({ source: "client" }));
    c.ok("an unapproved call topic is NOT visible", !see({ source: "strategy_call" }));
    c.ok("…unless the call selected it for a month (PROPOSED selection)", see({ source: "strategy_call" }, true));
    c.ok("an approved call topic is visible", see({ source: "strategy_call", approvalState: "APPROVED" }));
    c.ok("a 'declined on the call' proposal is never visible", !see({ source: "strategy_call", proposedState: "REJECTED" }, true));
    c.ok("a topic the client declined is not visible", !see({ clientDeclinedAt: new Date() }));
    c.ok("CARRIED occupies the allowance", ct.ALLOWANCE_SELECTION_STATUSES.includes("CARRIED"));

    // ======================================================================
    c.head("2 · approving a strategy queues the bank — and spends nothing");
    const A = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Bank Drill TEST", package: "Accelerator", monthKey: NEXT, appointments: [{ startAt: new Date(`${NEXT}-06T14:00:00Z`), durationMin: 240 }] });
    const text = await strategyText("Bank Drill TEST");
    const { stored } = structuredFromText(text);
    const sv = await createStrategyVersion({ enrollmentId: A.enrollmentId, stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof createStrategyVersion>[0]);
    const owner = await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Drill", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
    const { setOwnerOverride } = await import("@/lib/contentProgram");
    await setOwnerOverride("ENROLLMENT", A.enrollmentId, "STRATEGY", owner.id, "drill");
    // OLD: the approval itself (what the action called before today) creates no run.
    const r0 = await approveStrategyVersion(sv.versionId, STAFF_EMAIL);
    c.ok("the strategy has its two pillars", r0.pillarsCreated === 2, `${r0.pillarsCreated}`);
    c.ok("OLD: approval alone leaves no bank run at all", (await prisma.contentTopicRefreshRun.count()) === 0);
    const act = await contentActions.approveStrategy(sv.versionId);
    const runs2 = await prisma.contentTopicRefreshRun.findMany();
    c.ok("NEW: the approve action queues exactly one run", act.ok && runs2.length === 1, act.message);
    c.ok("…QUEUED, kind BANK (the bank was empty)", runs2[0]?.status === "QUEUED" && runs2[0]?.kind === "BANK", `${runs2[0]?.status}/${runs2[0]?.kind}`);
    c.ok("…and the model was never called", aiCalls === 0);
    const again = await contentActions.approveStrategy(sv.versionId);
    c.ok("approving again queues nothing more", again.ok && (await prisma.contentTopicRefreshRun.count()) === 1);
    const s2 = await ct.sweepTopicBanks();
    c.ok("switch absent (production today): the sweep is skipped", "skipped" in s2, JSON.stringify(s2));
    c.ok("…the run is still QUEUED and nothing was spent", (await prisma.contentTopicRefreshRun.findFirst())?.status === "QUEUED" && aiCalls === 0);

    // ======================================================================
    c.head("3 · topic_refresh ON, ai_runs OFF — a pause, not a failure");
    await ensureOnboardingRecord(A.enrollmentId);
    const approvedAt = (await prisma.contentStrategyVersion.findUnique({ where: { id: sv.versionId } }))!.approvedAt!;
    await prisma.contentTopicRefreshRun.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, kind: "RECOMMENDATION", status: "SUCCEEDED", requestedBy: "drill", createdAt: new Date(approvedAt.getTime() + 1000) } });
    const oldBankQuery = await prisma.contentTopicRefreshRun.findFirst({ where: { enrollmentId: A.enrollmentId, status: "SUCCEEDED", createdAt: { gte: approvedAt } } });
    c.ok("OLD: the ladder's query took a lone RECOMMENDATION run for a bank", oldBankQuery?.kind === "RECOMMENDATION");
    const ob3 = await advanceOnboarding(A.enrollmentId, { enqueue: false });
    c.ok("NEW: a RECOMMENDATION run does NOT raise BANK_GENERATED", ob3.to === "STRATEGY_APPROVED", ob3.to);
    await setSwitch("topic_refresh", true);
    const s3 = await ct.sweepTopicBanks();
    const run3 = await prisma.contentTopicRefreshRun.findFirst({ where: { kind: "BANK" } });
    c.ok("the sweep ran and paused on ai_runs", !("skipped" in s3) && !!s3.drained.paused, JSON.stringify(s3).slice(0, 200));
    c.ok("the run is back to QUEUED (not FAILED)", run3?.status === "QUEUED", run3?.status);
    c.ok("…its attempt refunded", run3?.attempts === 0, `${run3?.attempts}`);
    c.ok("…no suggestion, no model call", (await prisma.contentTopicSuggestion.count()) === 0 && aiCalls === 0);
    c.ok("…and no second initial run was queued", (await prisma.contentTopicRefreshRun.count({ where: { kind: { in: ["BANK", "REFRESH"] } } })) === 1);

    // ======================================================================
    c.head("4 · both ON — the initial bank lands as suggestions only");
    await setSwitch("ai_runs", true);
    const before4 = await portalTopics({ id: A.enrollmentId, clientId: A.clientId });
    const s4 = await ct.sweepTopicBanks();
    const run4 = await prisma.contentTopicRefreshRun.findUnique({ where: { id: run3!.id } });
    const pend4 = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: A.enrollmentId, disposition: "PENDING" } });
    c.ok("the queued run SUCCEEDED", run4?.status === "SUCCEEDED", `${run4?.status} ${run4?.changeSummary ?? run4?.lastError ?? ""}`);
    c.ok("24 PENDING suggestions over 2 pillars", pend4.length === 24 && new Set(pend4.map((p) => p.pillarId)).size === 2, `${pend4.length}`);
    c.ok("zero topics were created", (await prisma.contentTopic.count({ where: { enrollmentId: A.enrollmentId } })) === 0);
    const after4 = await portalTopics({ id: A.enrollmentId, clientId: A.clientId });
    c.ok("the client's page is unchanged (suggestions are invisible)", before4.total === 0 && after4.total === 0);
    c.ok("one model call", aiCalls === 1 && !("skipped" in s4));
    const ob4 = await advanceOnboarding(A.enrollmentId, { enqueue: false });
    c.ok("the BANK run raises BANK_GENERATED", ob4.to === "BANK_GENERATED", ob4.to);

    // ======================================================================
    c.head("5 · accept 10 per pillar — at target, nothing queued");
    const pillars = await prisma.contentPillar.findMany({ where: { enrollmentId: A.enrollmentId }, orderBy: { name: "asc" } });
    const pA = pillars.find((p) => p.name === "Market Authority")!;
    const pB = pillars.find((p) => p.name === "Seller Education")!;
    const archivedTitle = pend4.find((p) => p.pillarId === pA.id && p.rank === 12)!.title;
    for (const p of [pA, pB]) {
      const mine = pend4.filter((s) => s.pillarId === p.id).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      for (const s of mine.slice(0, 10)) await ct.acceptSuggestion(s.id, STAFF_EMAIL);
      for (const s of mine.slice(10)) await ct.archiveSuggestion(s.id, STAFF_EMAIL);
    }
    const stock5 = await ct.bankStock(A.enrollmentId);
    c.ok("both pillars at 10 usable, need 0", stock5.every((p) => p.usable === 10 && p.need === 0), JSON.stringify(stock5.map((p) => [p.pillarName, p.usable, p.pending, p.need])));
    const runsBefore5 = await prisma.contentTopicRefreshRun.count();
    await ct.sweepTopicBanks();
    c.ok("the sweep queues nothing", (await prisma.contentTopicRefreshRun.count()) === runsBefore5 && aiCalls === 1);
    c.ok("the client now sees the 20 accepted topics", (await portalTopics({ id: A.enrollmentId, clientId: A.clientId })).total === 20);
    await releaseStrategyVersion(sv.versionId, STAFF_EMAIL);
    const ob5 = await advanceOnboarding(A.enrollmentId, { enqueue: false });
    c.ok("released + the initial bank fully reviewed → COMPLETE", ob5.to === "COMPLETE", ob5.to);

    // ======================================================================
    c.head("6 · film two pillar-A topics — one targeted refill");
    const aTopics = await prisma.contentTopic.findMany({ where: { enrollmentId: A.enrollmentId, pillarId: pA.id }, orderBy: { createdAt: "asc" } });
    for (const t of aTopics.slice(0, 2)) await ct.selectTopicForMonth(t.id, A.monthId, { source: "staff", actor: STAFF });
    const conf = await confirmFilmedTopics(A.projectId!, aTopics.slice(0, 2).map((t) => t.id), "photographer-drill");
    c.ok("two topics confirmed filmed", conf.confirmed === 2, JSON.stringify(conf));
    const stock6 = await ct.bankStock(A.enrollmentId);
    c.ok("pillar A: 8 usable, needs 2; pillar B needs 0", stock6.find((p) => p.pillarId === pA.id)?.need === 2 && stock6.find((p) => p.pillarId === pB.id)?.need === 0, JSON.stringify(stock6.map((p) => [p.pillarName, p.usable, p.need])));
    inject["Market Authority"] = [archivedTitle];
    const s6 = await ct.sweepTopicBanks();
    const refills = await prisma.contentTopicRefreshRun.findMany({ where: { kind: "REFRESH" } });
    const inputs6 = JSON.parse(refills[0]?.inputsJson ?? "{}") as { pillarId?: string; keep?: number };
    c.ok("exactly one REFRESH run was queued", refills.length === 1 && !("skipped" in s6) && s6.refills === 1, JSON.stringify(s6).slice(0, 160));
    c.ok("…for pillar A, keeping 2", inputs6.pillarId === pA.id && inputs6.keep === 2, JSON.stringify(inputs6));
    c.ok("…and it ran (SUCCEEDED)", refills[0]?.status === "SUCCEEDED", `${refills[0]?.status} ${refills[0]?.lastError ?? ""}`);
    c.ok("the archived title offered again was withheld", /1 archived concept withheld/.test(refills[0]?.changeSummary ?? "") && !(await prisma.contentTopicSuggestion.findFirst({ where: { title: archivedTitle, disposition: "PENDING" } })), refills[0]?.changeSummary ?? "");
    c.ok("2 new suggestions, all pillar A", (await prisma.contentTopicSuggestion.count({ where: { refreshRunId: refills[0]?.id } })) === 2 && (await prisma.contentTopicSuggestion.count({ where: { refreshRunId: refills[0]?.id, pillarId: { not: pA.id } } })) === 0);
    const calls6 = aiCalls;
    const runs6 = await prisma.contentTopicRefreshRun.count();
    await ct.sweepTopicBanks();
    c.ok("an immediate second sweep queues nothing (cooldown + pending stock)", (await prisma.contentTopicRefreshRun.count()) === runs6 && aiCalls === calls6);

    // ======================================================================
    c.head("7 · \"not interested\" — off the page, on the record, never re-offered");
    const bTopic = (await prisma.contentTopic.findMany({ where: { enrollmentId: A.enrollmentId, pillarId: pB.id }, orderBy: { createdAt: "asc" } }))[0];
    const auth = { token: A.portalToken };
    const dec = await portalActions.portalDeclineTopic(auth, bTopic.id, "not my market");
    c.ok("the portal action sets it aside", dec.ok, dec.message);
    const page7 = await portalTopics({ id: A.enrollmentId, clientId: A.clientId });
    const shown = page7.groups.flatMap((g) => g.topics).find((t) => t.id === bTopic.id);
    c.ok("off the client's bank (flagged declined, not counted)", !!shown?.declined && page7.total === 19, `${page7.total}`);
    const bank7 = await ct.topicBankByPillar(A.enrollmentId);
    c.ok("on the staff 'not interested' list with the reason", bank7.declined.some((t) => t.id === bTopic.id && t.clientDeclineReason === "not my market"));
    c.ok("in blockedTopicHashes", (await ct.blockedTopicHashes(A.enrollmentId)).has(bTopic.dedupeHash ?? ct.topicDedupeHash(bTopic.title)));
    c.ok("a DECLINED event records it", (await prisma.contentTopicEvent.count({ where: { topicId: bTopic.id, kind: "DECLINED" } })) === 1);
    c.ok("pillar B stock dropped to 9", (await ct.bankStock(A.enrollmentId)).find((p) => p.pillarId === pB.id)?.usable === 9);
    inject["Seller Education"] = [bTopic.title];
    const r7 = await ct.startTopicRefresh({ enrollmentId: A.enrollmentId, kind: "REFRESH", requestedBy: STAFF_EMAIL, pillarId: pB.id, keep: 3 });
    const run7 = await prisma.contentTopicRefreshRun.findUnique({ where: { id: r7.runId } });
    c.ok("a refresh offering it again withholds it", /1 archived concept withheld/.test(run7?.changeSummary ?? "") && !(await prisma.contentTopicSuggestion.findFirst({ where: { title: bTopic.title, refreshRunId: r7.runId } })), run7?.changeSummary ?? "");
    c.ok("…and the model was told it is set aside, with the reason", prompts[prompts.length - 1].prompt.includes(`${bTopic.title} — client not interested: not my market`));
    const und = await portalActions.portalUndeclineTopic(auth, bTopic.id);
    c.ok("undo brings it back", und.ok && (await portalTopics({ id: A.enrollmentId, clientId: A.clientId })).total === 20, und.message);
    c.ok("…with a REINTRODUCED event", (await prisma.contentTopicEvent.count({ where: { topicId: bTopic.id, kind: "REINTRODUCED" } })) === 1);

    // ======================================================================
    c.head("8 · carryover — an unfilmed script moves into the new month, with its history");
    const C = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Carry Drill TEST", package: "Accelerator", videosPerMonth: 3, monthKey: PREV, appointments: [{ startAt: new Date(`${PREV}-15T14:00:00Z`), durationMin: 240 }], topics: [
      { title: "Filmed one", selection: "RECONCILED", topicStatus: "SCRIPTED" },
      { title: "Filmed two", selection: "RECONCILED", topicStatus: "SCRIPTED" },
      { title: "Unfilmed swap me", selection: "RECONCILED", topicStatus: "SCRIPTED" },
      { title: "Unfilmed late", selection: "RECONCILED", topicStatus: "SCRIPTED" },
      { title: "Replacement pick", selection: null, topicStatus: "SAVED" },
      { title: "Client pick", selection: null, topicStatus: "SAVED" },
    ] });
    const [tF1, tF2, tSwap, tLate, tRepl, tPick] = C.topicIds;
    // "sep" is LAST month, "oct" THIS month, "nov" NEXT month — named for the
    // audit's example (September → October) so the assertions read as it does.
    const sep = C.monthId;
    const oct = (await prisma.contentMonth.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, monthKey: CUR, videosOwed: 3, status: "OPEN" }, select: { id: true } })).id;
    const parts = (title: string, hook: string) => ({ title, hook, points: [{ role: "re-hook" as const, text: "One." }, { role: "build-up" as const, text: "Two." }, { role: "payoff" as const, text: "Three." }], close: "Close." });
    const scriptOf: Record<string, string> = {};
    for (const [tid, title] of [[tF1, "Filmed one"], [tF2, "Filmed two"], [tSwap, "Unfilmed swap me"], [tLate, "Unfilmed late"]] as const) {
      const v1 = await createScriptVersion({ enrollmentId: C.enrollmentId, monthId: sep, topicId: tid, parts: parts(title, "v1 hook"), source: "AI", createdBy: "drill", status: "INTERNAL_REVIEW" });
      const v2 = await createScriptVersion({ scriptId: v1.scriptId, enrollmentId: C.enrollmentId, monthId: sep, topicId: tid, parts: parts(title, "v2 hook"), source: "MANUAL", createdBy: "drill", basedOnVersionId: v1.versionId });
      await prisma.contentScript.update({ where: { id: v1.scriptId }, data: { status: "APPROVED", approvedVersionId: v2.versionId, approvedAt: new Date(`${PREV}-10T15:00:00Z`), sharedVersionId: v2.versionId, releaseState: "released", clientApprovedVersionId: v2.versionId, clientApprovedAt: new Date(`${PREV}-11T15:00:00Z`) } });
      await prisma.contentScriptRelease.create({ data: { scriptId: v1.scriptId, scriptVersionId: v2.versionId, enrollmentId: C.enrollmentId, clientId: C.clientId, monthId: sep, action: "CLIENT_APPROVED", actorClientUserId: C.clientUserId } });
      scriptOf[tid] = v1.scriptId;
    }
    await confirmFilmedTopics(C.projectId!, [tF1, tF2], "photographer-drill");
    const NOW = new Date(`${CUR}-01T14:00:00Z`); // the 1st of the month the carry runs on
    const counts = async () => ({ scripts: await prisma.contentScript.count({ where: { enrollmentId: C.enrollmentId } }), versions: await prisma.contentScriptVersion.count({ where: { enrollmentId: C.enrollmentId } }), decisions: await prisma.contentScriptRelease.count({ where: { enrollmentId: C.enrollmentId } }) });
    const before8 = await counts();
    const off8 = await ct.sweepCarryover({ now: NOW });
    c.ok("topic_carryover absent: skipped", "skipped" in off8, JSON.stringify(off8));
    c.ok("…nothing carried", (await prisma.contentTopicSelection.count({ where: { status: "CARRIED" } })) === 0);
    const dry = await ct.carryUnfilmedTopics(C.enrollmentId, { now: NOW, dryRun: true });
    c.ok("a dry run lists exactly the two unfilmed scripts", dry.candidates.length === 2 && dry.candidates.every((x) => [tSwap, tLate].includes(x.topicId)) && dry.carried === 0, dry.candidates.map((x) => x.title).join(", "));
    c.ok("…and writes nothing", (await prisma.contentTopicSelection.count({ where: { status: "CARRIED" } })) === 0);
    await setSwitch("topic_carryover", true);
    const on8 = await ct.sweepCarryover({ now: NOW });
    c.ok("ON: two carried", !("skipped" in on8) && on8.carried === 2, JSON.stringify(on8));
    const carried = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tSwap, monthId: oct } } });
    c.ok("an October CARRIED selection, from September, pointing at its script", carried?.status === "CARRIED" && carried.carriedFromMonthId === sep && carried.carriedScriptId === scriptOf[tSwap], JSON.stringify({ s: carried?.status, from: carried?.carriedFromMonthId === sep }));
    const sc8 = await prisma.contentScript.findUnique({ where: { id: scriptOf[tSwap] } });
    c.ok("the script moved to October and remembers September", sc8?.monthId === oct && sc8?.carriedFromMonthId === sep);
    c.ok("the topic's month moved (status still SCRIPTED)", (await prisma.contentTopic.findUnique({ where: { id: tSwap } }))?.monthId === oct && (await prisma.contentTopic.findUnique({ where: { id: tSwap } }))?.status === "SCRIPTED");
    c.ok("a CARRIED event carries the versions", !!(await prisma.contentTopicEvent.findFirst({ where: { topicId: tSwap, kind: "CARRIED", evidenceJson: { contains: scriptOf[tSwap] } } })));
    c.ok("scripts, versions and decisions all still there", JSON.stringify(await counts()) === JSON.stringify(before8));
    c.ok("OLD: monthCapacity ignored CARRIED (0 of 3)", (await old.monthCapacity(oct)).selected === 0);
    c.ok("NEW: monthCapacity counts it (2 of 3)", (await ct.monthCapacity(oct)).selected === 2);
    const work8 = await scriptWorkForMonth(oct);
    c.ok("October owes no new script for them (HAS_SCRIPT)", work8.length === 2 && work8.every((w) => w.readiness === "HAS_SCRIPT"), work8.map((w) => w.readiness).join(","));
    await setSwitch("script_drafting", true);
    const calls8 = aiCalls;
    await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
    c.ok("the drafting sweep makes no model call for them", aiCalls === calls8);
    const rc8 = await recalcProgramMonth(oct, { now: NOW, dryRun: true });
    const ready8 = rc8?.after.sessions.flatMap((s) => s.readyTopicIds) ?? [];
    c.ok("October's preparation counts the carried approved scripts as material", [tSwap, tLate].every((t) => ready8.includes(t)), JSON.stringify(ready8));
    const ev8 = await prisma.contentTopicEvent.count();
    const sel8 = await prisma.contentTopicSelection.count();
    const again8 = await ct.sweepCarryover({ now: NOW });
    c.ok("a second sweep carries nothing and writes nothing", !("skipped" in again8) && again8.carried === 0 && (await prisma.contentTopicEvent.count()) === ev8 && (await prisma.contentTopicSelection.count()) === sel8);

    // ======================================================================
    c.head("9 · swap — the slot changes hands, the script is kept");
    const pick = await ct.selectTopicForMonth(tPick, oct, { source: "client", actor: { kind: "CLIENT", clientUserId: C.clientUserId } });
    c.ok("October is full: 2 carried + 1 pick = 3 of 3", pick.overflow === false && (await ct.monthCapacity(oct)).selected === 3);
    const before9 = await counts();
    const sw = await portalActions.portalSwapCarriedTopic({ token: C.portalToken }, carried!.id, tRepl);
    c.ok("the portal swap succeeds", sw.ok, sw.message);
    const gone = await prisma.contentTopicSelection.findUnique({ where: { id: carried!.id } });
    c.ok("carried selection REMOVED, reason SWAPPED, pointing at the replacement", gone?.status === "REMOVED" && gone.removedReason === "SWAPPED" && gone.replacedByTopicId === tRepl);
    const repl = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tRepl, monthId: oct } } });
    c.ok("the replacement is SELECTED and not overflow", repl?.status === "SELECTED" && repl.overflow === false);
    c.ok("allowance unchanged: 3 of 3, no overflow", JSON.stringify(await ct.monthCapacity(oct)) === JSON.stringify({ owed: 3, selected: 3, overflow: 0 }));
    c.ok("scripts, versions and decisions identical", JSON.stringify(await counts()) === JSON.stringify(before9));
    const t9 = await prisma.contentTopic.findUnique({ where: { id: tSwap } });
    const s9 = await prisma.contentScript.findUnique({ where: { id: scriptOf[tSwap] } });
    c.ok("the swapped topic is SCRIPTED, on no month; its script parked with its approval", t9?.status === "SCRIPTED" && t9.monthId === null && s9?.monthId === null && s9.clientApprovedVersionId !== null && s9.carriedFromMonthId === sep);
    const kinds = (await prisma.contentTopicEvent.findMany({ where: { topicId: tSwap }, orderBy: { createdAt: "asc" }, select: { kind: true } })).map((e) => e.kind);
    c.ok("its history reads … CARRIED, DESELECTED", kinds.includes("CARRIED") && kinds.indexOf("DESELECTED") > kinds.indexOf("CARRIED"), kinds.join(","));
    c.ok("the replacement's history has SELECTED", (await prisma.contentTopicEvent.count({ where: { topicId: tRepl, kind: "SELECTED" } })) >= 1);
    const page9 = await portalTopics({ id: C.enrollmentId, clientId: C.clientId });
    const p9 = page9.groups.flatMap((g) => g.topics).find((t) => t.id === tSwap);
    c.ok("the client sees it under 'Scripted, not filmed'", !!p9?.scriptedNotFilmed && !p9.carried);
    const pLate = page9.groups.flatMap((g) => g.topics).find((t) => t.id === tLate);
    c.ok("the other carried one is shown carried and swappable", !!pLate?.carried && !!pLate.swappable && pLate.scriptedNotFilmed);
    const nov = (await prisma.contentMonth.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, monthKey: NEXT, videosOwed: 3, status: "OPEN" }, select: { id: true } })).id;
    const calls9 = aiCalls;
    const scripts9 = await prisma.contentScript.count({ where: { enrollmentId: C.enrollmentId } });
    const re = await ct.selectTopicForMonth(tSwap, nov, { source: "client", actor: { kind: "CLIENT", clientUserId: C.clientUserId } });
    c.ok("re-selecting it for November re-uses the parked script", re.outcome === "SELECTED" && (await prisma.contentScript.findUnique({ where: { id: scriptOf[tSwap] } }))?.monthId === nov);
    c.ok("…no new script, no model call", (await prisma.contentScript.count({ where: { enrollmentId: C.enrollmentId } })) === scripts9 && aiCalls === calls9);
    c.ok("…and November has it as a SELECTED slot", (await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tSwap, monthId: nov } } }))?.status === "SELECTED");
    let stolen = "";
    try { await ct.selectTopicForMonth(tSwap, oct, { source: "staff", actor: STAFF }); } catch (e) { stolen = e instanceof Error ? e.message : String(e); }
    c.ok("a script planned for an open month is never pulled into another one", /already planned for/.test(stolen) && (await prisma.contentScript.findUnique({ where: { id: scriptOf[tSwap] } }))?.monthId === nov, stolen);

    // ======================================================================
    c.head("10 · a late filming confirmation undoes a carry");
    const lateSelBefore = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tLate, monthId: oct } } });
    c.ok("before: carried into October", lateSelBefore?.status === "CARRIED");
    const conf10 = await confirmFilmedTopics(C.projectId!, [tLate], "photographer-drill");
    c.ok("September's session confirms it after all", conf10.confirmed === 1, JSON.stringify(conf10));
    const lateSel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tLate, monthId: oct } } });
    c.ok("October's slot released: REMOVED, FILMED_LATE", lateSel?.status === "REMOVED" && lateSel.removedReason === "FILMED_LATE", `${lateSel?.status}/${lateSel?.removedReason}`);
    c.ok("the script is back on September", (await prisma.contentScript.findUnique({ where: { id: scriptOf[tLate] } }))?.monthId === sep);
    c.ok("October is 2 of 3 again", (await ct.monthCapacity(oct)).selected === 2);

    // ======================================================================
    c.head("11 · deselect: a call's re-mention of an old scripted topic can be dropped");
    const tOld = (await prisma.contentTopic.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, monthId: sep, title: "Scripted in September, raised again", status: "SCRIPTED", source: "staff" }, select: { id: true } })).id;
    await createScriptVersion({ enrollmentId: C.enrollmentId, monthId: sep, topicId: tOld, parts: parts("Scripted in September, raised again", "hook"), source: "AI", createdBy: "drill", status: "INTERNAL_REVIEW" });
    await prisma.contentTopicSelection.create({ data: { topicId: tOld, monthId: nov, enrollmentId: C.enrollmentId, clientId: C.clientId, status: "PROPOSED", source: "call" } });
    let oldThrew = false;
    try { await old.deselectTopic(tOld, nov, STAFF); } catch { oldThrew = true; }
    c.ok("OLD: deselect refused it on the topic's global SCRIPTED status", oldThrew);
    let newErr: string | null = null;
    try { await ct.reconcileSelection(tOld, nov, false, STAFF); } catch (e) { newErr = e instanceof Error ? e.message : String(e); }
    c.ok("NEW: reconcileSelection(keep=false) drops the PROPOSED row", !newErr && (await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tOld, monthId: nov } } }))?.status === "REMOVED", newErr ?? "");
    c.ok("…and the topic keeps its September script (still SCRIPTED)", (await prisma.contentTopic.findUnique({ where: { id: tOld } }))?.status === "SCRIPTED");

    // ======================================================================
    c.head("12 · a client's own idea goes straight into the month");
    const O = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Own Idea Drill TEST", package: "Starter", monthKey: NEXT, project: false });
    const past = (await prisma.contentMonth.create({ data: { enrollmentId: O.enrollmentId, clientId: O.clientId, monthKey: LONG_AGO, videosOwed: 2, historical: true, status: "IMPORTED" }, select: { id: true } })).id;
    const oldR = await oldPortal.portalSuggestTopic({ token: O.portalToken }, { title: "Old path idea for a closed month", monthId: past });
    const oldSel = oldR.id ? await prisma.contentTopicSelection.count({ where: { topicId: oldR.id } }) : 0;
    c.ok("OLD: a closed month still said success, with no selection", oldR.ok && oldSel === 0, oldR.message);
    const bad = await portalActions.portalSuggestTopic({ token: O.portalToken }, { title: "New path idea for a closed month", monthId: past });
    c.ok("NEW: a closed month is an honest failure", !bad.ok, bad.message);
    const good = await portalActions.portalSuggestTopic({ token: O.portalToken }, { title: "Why spring listings start in January", monthId: O.monthId });
    const goodSel = good.id ? await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: good.id, monthId: O.monthId } } }) : null;
    c.ok("with a month: created AND selected (SELECTED, no approval needed)", good.ok && good.selected === true && goodSel?.status === "SELECTED", good.message);
    const t12 = good.id ? await prisma.contentTopic.findUnique({ where: { id: good.id } }) : null;
    c.ok("…the topic is the client's, PROPOSED, and on their page", t12?.source === "client" && t12.approvalState === "PROPOSED" && (await portalTopics({ id: O.enrollmentId, clientId: O.clientId })).groups.some((g) => g.topics.some((t) => t.id === good.id)));
    c.ok("…no pillar → an internal alignment flag, not a block", !!(await prisma.contentTopicEvent.findFirst({ where: { topicId: good.id!, kind: "DISCUSSED", actorKind: "SYSTEM", note: { startsWith: "Alignment check:" } } })));
    await portalActions.portalSuggestTopic({ token: O.portalToken }, { title: "Second idea for October", monthId: O.monthId });
    const full = await portalActions.portalSuggestTopic({ token: O.portalToken }, { title: "Third idea for October", monthId: O.monthId });
    c.ok("a full month says 'as an extra' (overflow kept)", full.ok && /as an extra/.test(full.message), full.message);

    // ======================================================================
    c.head("13 · call analysis: ideas stay off the client's page until approved");
    const { analyzeTranscriptText } = await import("@/lib/contentGeneration");
    analysisNext = {
      callKind: "planning", plannedMonthKey: null,
      selectedTopics: [{ title: "The call's own pick", concept: "c", pillar: "Market Authority", excerpts: [{ speaker: "client", text: "Let's definitely do the one about pricing in the first week." }] }],
      discussedTopics: [{ title: "An idea raised on the call", concept: "c", pillar: "Seller Education", excerpts: [{ speaker: "jordan", text: "We could also talk about staging." }] }],
      rejectedIdeas: [{ title: "An idea declined on the call", reason: "not for my market" }],
      facts: [], strategyProposals: [], priorities: [], todos: [],
    };
    await analyzeTranscriptText({ enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: A.monthId, monthKey: NEXT, transcript: "(drill transcript)", callDate: new Date(`${CUR}-28T15:00:00Z`), videosOwed: 4, requestedBy: STAFF_EMAIL, unattended: false });
    const byTitle = async (title: string) => (await prisma.contentTopic.findFirst({ where: { enrollmentId: A.enrollmentId, title } }))!;
    const [pickT, discT, rejT] = [await byTitle("The call's own pick"), await byTitle("An idea raised on the call"), await byTitle("An idea declined on the call")];
    const oldBank = await old.topicBankByPillar(A.enrollmentId);
    const oldIds = oldBank.groups.flatMap((g) => g.topics.map((t) => t.id));
    c.ok("OLD: the bank the portal read listed the discussed AND the declined idea", oldIds.includes(discT.id) && oldIds.includes(rejT.id));
    const page13 = await portalTopics({ id: A.enrollmentId, clientId: A.clientId });
    const ids13 = page13.groups.flatMap((g) => g.topics.map((t) => t.id));
    c.ok("NEW: the discussed idea is not on the client's page", !ids13.includes(discT.id));
    c.ok("NEW: the 'declined on the call' idea is not either", !ids13.includes(rejT.id));
    c.ok("the call's PROPOSED pick IS shown (they chose it out loud)", ids13.includes(pickT.id) && page13.groups.flatMap((g) => g.topics).find((t) => t.id === pickT.id)?.selection?.status === "PROPOSED");
    const byId = await portalActions.portalSelectTopic({ token: A.portalToken }, discT.id, A.monthId);
    c.ok("a portal action cannot reach the hidden idea by id", !byId.ok, byId.message);
    await ct.approveTopic(discT.id, STAFF_EMAIL);
    const ids13b = (await portalTopics({ id: A.enrollmentId, clientId: A.clientId })).groups.flatMap((g) => g.topics.map((t) => t.id));
    c.ok("once Jordan approves it, it appears", ids13b.includes(discT.id));

    // ======================================================================
    // Review fixes (Sep 24 2026).
    c.head("14 · a client's own idea that matches a HIDDEN call topic becomes theirs, visible");
    const hiddenTitle = "First-time buyer mistakes";
    const hid = await ct.createTopic({ enrollmentId: A.enrollmentId, title: hiddenTitle, source: "strategy_call", status: "SAVED", approvalState: "PROPOSED", actor: { kind: "AI" }, eventKind: "DISCUSSED" });
    const visible = async (id: string) => (await portalTopics({ id: A.enrollmentId, clientId: A.clientId })).groups.some((g) => g.topics.some((t) => t.id === id));
    c.ok("(the call's topic is hidden from the client)", !(await visible(hid.id)));
    const oldSays = await oldPortal.portalSuggestTopic({ token: A.portalToken }, { title: hiddenTitle });
    c.ok("OLD: the client was told it is already in their bank — and it stayed hidden", oldSays.ok && /already/.test(oldSays.message) && !(await visible(hid.id)), oldSays.message);
    const newSays = await portalActions.portalSuggestTopic({ token: A.portalToken }, { title: hiddenTitle });
    const hidAfter = await prisma.contentTopic.findUnique({ where: { id: hid.id } });
    c.ok("NEW: it is adopted as the client's own idea, not 'already on your list'", newSays.ok && newSays.id === hid.id && !/already/.test(newSays.message) && hidAfter?.source === "client", `${newSays.message} · source ${hidAfter?.source}`);
    c.ok("  and it is on their page, usable without approval", await visible(hid.id) && hidAfter?.approvalState === "PROPOSED");
    c.ok("  with where it came from kept on its history", !!(await prisma.contentTopicEvent.findFirst({ where: { topicId: hid.id, note: { contains: "already on file" } } })));
    const rejSays = await portalActions.portalSuggestTopic({ token: A.portalToken }, { title: "An idea declined on the call" });
    c.ok("a 'declined on the call' proposal they now suggest themselves is theirs too", rejSays.ok && (await visible(rejT.id)) && (await prisma.contentTopic.findUnique({ where: { id: rejT.id } }))?.proposedState === null, rejSays.message);

    c.head("15 · 'Not interested' stays not interested when a later call raises it again");
    await setSwitch("ai_runs", true);
    const D = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Decline Reproposal TEST", package: "Accelerator", monthKey: CUR, project: false, topics: [{ title: "Pricing in the first week", selection: "SELECTED" }, { title: "Another planned one", selection: "SELECTED" }] });
    const T = D.topicIds[0];
    await ct.declineTopicForClient(T, { kind: "CLIENT", clientUserId: D.clientUserId }, "not for my market");
    const later = (await prisma.contentMonth.create({ data: { enrollmentId: D.enrollmentId, clientId: D.clientId, monthKey: shiftKey(CUR, 2), videosOwed: 4 }, select: { id: true } })).id;
    await old.selectTopicForMonth(T, later, { source: "call", actor: { kind: "AI" }, status: "PROPOSED" });
    c.ok("OLD: a call's proposal put the declined topic into another month", (await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: T, monthId: later } } }))?.status === "PROPOSED");
    analysisNext = {
      callKind: "planning", plannedMonthKey: NEXT,
      selectedTopics: [{ title: "Pricing in the first week", concept: "c", pillar: null, excerpts: [{ speaker: "client", text: "Maybe the first-week pricing one." }] }],
      discussedTopics: [], rejectedIdeas: [], facts: [], strategyProposals: [], priorities: [], todos: [],
    };
    await analyzeTranscriptText({ enrollmentId: D.enrollmentId, clientId: D.clientId, monthId: D.monthId, monthKey: CUR, transcript: "(drill transcript)", callDate: new Date(`${CUR}-27T15:00:00Z`), videosOwed: 4, requestedBy: STAFF_EMAIL, unattended: false });
    const Dnext = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId: D.enrollmentId, monthKey: NEXT } } });
    const selNext = Dnext ? await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: T, monthId: Dnext.id } } }) : null;
    c.ok("NEW: the later call's analysis withholds it — no selection in the planned month", !!Dnext && !selNext, `${selNext?.status ?? "none"}`);
    c.ok("  so it takes no allowance slot there", !!Dnext && (await ct.monthCapacity(Dnext.id)).selected === 0);
    c.ok("  and the mention is on the record", !!(await prisma.contentTopicEvent.findFirst({ where: { topicId: T, kind: "DISCUSSED", note: { contains: "Not interested" } } })));
    let refused = "";
    try { await ct.reconcileSelection(T, Dnext!.id, true, STAFF); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    c.ok("staff 'Keep' cannot select it while it is declined", /Not interested/.test(refused), refused);
    await ct.undeclineTopicForClient(T, STAFF);
    const kept = await ct.selectTopicForMonth(T, Dnext!.id, { source: "staff", actor: STAFF });
    c.ok("after undoing the 'not interested' (on the record), selecting it works", kept.outcome === "SELECTED");

    // ======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
  } finally {
    removeBaseCopies(base.dir);
    quiet.restore();
    c.summary();
    void server;
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
