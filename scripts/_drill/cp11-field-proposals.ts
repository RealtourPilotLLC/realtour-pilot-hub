// ---------------------------------------------------------------------------
// DRILL: CP-11 — call knowledge: "remember this" vs "apply this change", and
// strategy changes kept section-specific (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp11-field-proposals.ts
//
// What it proves, the OLD behaviour first (the OLD contentGeneration and
// contentStrategy are loaded for real from HEAD, their `@/` imports pointed at
// this tree; the model is stubbed at aiJsonWithUsage only, so the run ledger,
// the dedupe and every write around it are the shipped code):
//   0. OLD — a call that changed the client's music produced a fact and a
//      free-floating strategy proposal: nothing named the field or the value,
//      so there was nothing to apply; accepting a positioning proposal
//      APPENDED an "Accepted proposal" section instead of changing one; and
//      the editor's brief read no accepted fact at all.
//   1. NEW — the same call makes a PROFILE proposal (target, from, to, the
//      call, the fact); re-running it makes no second one.
//   2. Remembering (accepting the fact) changes nothing on the profile.
//   3. Applying is a person's act: a new version, history intact, the notes
//      kept, the brief reads it, the editor is told; a second apply refused.
//   4. Ignoring changes nothing.
//   5. Drift: the field changed since → refused, and who changed it is named.
//   6. Confidential knowledge never proposes, and never applies.
//   7. A section proposal drafts a version with ONLY that section changed —
//      ids, order and every other section byte-identical, nothing appended —
//      and the version in force (and the portal) is untouched until approval.
//   8. A proposal made against a section that has since changed is refused;
//      one whose section did not change still goes through.
//   9. Rejecting changes nothing.  10. Confidential strategy knowledge becomes
//      a locked fact, and a marked version cannot be released.
//  11. A profile proposal can't be accepted as strategy, and isn't listed there.
//  12. The brief reads accepted production facts, never proposed ones.
//  13. An unplaced proposal can be placed on a section.
//  14. A portal correction naming a section is aimed at it.
//
// ISOLATION: PGlite on 127.0.0.1:5512 via the shared harness; production is
// never opened. Slack is answered by a fake at the fetch fence; every other
// outbound call is blocked and counted.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5512);
const REPO = path.resolve(__dirname, "../..");
const BASE = "HEAD";

installNextStubs();

// ---- the model boundary: the answer is a fixture, everything around it is real
let nextAnalysis: Record<string, unknown> | null = null;
const prompts: string[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { prompt: string }) => {
        prompts.push(opts.prompt);
        if (!nextAnalysis) throw new Error("drill: no fixture analysis queued");
        const result = nextAnalysis;
        return { result, usage: { inputTokens: 1000, outputTokens: 300 }, model: "drill-stub" };
      };
    },
  }),
);

const slackPosts: { channel: string; text: string }[] = [];
const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { channel?: string; text?: string }) : {};
  if (method === "chat.postMessage") slackPosts.push({ channel: body.channel ?? "?", text: body.text ?? "" });
  return new Response(JSON.stringify({ ok: true, channels: [] }), { status: 200, headers: { "content-type": "application/json" } });
});

function writeBaseCopies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp11-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const gen = path.join(dir, "contentGeneration.base.ts");
  fs.writeFileSync(gen, point(show("src/lib/contentGeneration.ts")));
  const strat = path.join(dir, "contentStrategy.base.ts");
  fs.writeFileSync(strat, point(show("src/lib/contentStrategy.ts")));
  return { dir, gen, strat, editPage: show("src/app/edit/[id]/page.tsx") };
}

const STRATEGY_TEXT = `Mara Lindqvist
2026 Social Content Strategy
1. Brand Overview
Core Values: Honesty, local knowledge
Brand Message: Luxury listings on the Main Line
Brand Voice: Warm and expert
Target Audience
Primary service areas: Main Line
Primary client types: Move-up buyers
Long-term positioning goal: The Main Line luxury name
2. Content Goals
- Grow to 5,000 local followers
- Two listing leads a month from video
3. Content Pillars
Pillar 1: Market Insight
Purpose: Explain the market
Focus Areas: Prices, inventory
Pillar 2: Neighborhood Life
Purpose: Show the lifestyle
Focus Areas: Restaurants, schools
4. Video Structure Framework
Hook
Close / Call to Action`;

const analysis = (o: { facts?: unknown[]; strategyProposals?: unknown[] }) => ({
  callKind: "planning", plannedMonthKey: null, selectedTopics: [], discussedTopics: [], rejectedIdeas: [],
  facts: o.facts ?? [], strategyProposals: o.strategyProposals ?? [], priorities: [], todos: [],
});
const MUSIC_FACT = { body: "Now wants calm acoustic music under every video", category: "PRODUCTION_PREFERENCE", fieldKey: "editing.music", scope: "PERMANENT", speaker: "client", confidential: false, confidence: 0.9, excerpt: { speaker: "client", text: "Honestly I'm over the upbeat pop — something calm, acoustic." }, proposedValue: "Calm acoustic" };
const GOALS_PROPOSAL = { kind: "POSITIONING", summary: "Repositioning toward relocation buyers", impact: "Changes the goals", section: "Content Goals", proposedText: "- Become the relocation specialist for the western suburbs\n- Two listing leads a month from video", confidential: false };

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const gen = await import("@/lib/contentGeneration");
  const cs = await import("@/lib/contentStrategy");
  const pf = await import("@/lib/profileFields");
  const bp = await import("@/lib/brandProfile");
  const facts = await import("@/lib/clientFacts");
  const { portalStrategy } = await import("@/lib/portal");
  const actions = await import("@/app/content/actions");
  const base = writeBaseCopies();
  const oldGen = (await import(base.gen)) as { analyzeTranscriptText: typeof gen.analyzeTranscriptText };
  const oldStrat = (await import(base.strat)) as { acceptStrategyProposal: (id: string, by: string, note?: string) => Promise<{ versionId: string | null }> };
  type PortalViewer = import("@/lib/portal").PortalViewer;

  await saveSecret("slack", "xoxb-drill-not-a-real-token");
  await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim-drill@example.com", role: "EDITOR", slackId: "U-KIM" } });
  await prisma.appUser.create({ data: { email: "kim-drill@example.com", name: "Kim", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
  await prisma.appUser.create({ data: { email: "jordan@realtourpilot.com", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
  await prisma.programAutomation.create({ data: { key: "brand_change_alerts", enabled: true, enabledBy: "drill", enabledAt: new Date() } });

  /** A real client on the program with an APPROVED + released strategy v1, music 'Upbeat pop', Kim on the job, and a call. */
  async function world(name: string) {
    const client = await prisma.client.create({ data: { name, socialClient: true }, select: { id: true } });
    const e = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2 }, select: { id: true } });
    const month = await prisma.contentMonth.create({ data: { enrollmentId: e.id, clientId: client.id, monthKey: "2026-10", videosOwed: 4 }, select: { id: true } });
    const p = await prisma.project.create({ data: { clientId: client.id, title: `${name} — October`, status: "EDITING", contentMonthId: month.id }, select: { id: true } });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: `Edit ${name}`, assignedKey: "kim", projectId: p.id, clientId: client.id } });
    const person = await prisma.clientUser.create({ data: { email: `${name.split(" ")[0].toLowerCase()}@example.com`, name, status: "ACTIVE" }, select: { id: true } });
    const seat = await prisma.clientMembership.create({ data: { clientUserId: person.id, enrollmentId: e.id, clientId: client.id, role: "OWNER", acceptedAt: new Date() }, select: { id: true } });
    const imp = await cs.importStrategyVersion({ enrollmentId: e.id, text: STRATEGY_TEXT, fileName: "strategy.docx", createdBy: "drill" });
    await cs.approveStrategyVersion(imp.versionId, "jordan@realtourpilot.com");
    await cs.releaseStrategyVersion(imp.versionId, "jordan@realtourpilot.com");
    await bp.setProfileSlot({ clientId: client.id, enrollmentId: e.id, key: "music", value: "Upbeat pop", source: "client_portal", actor: { clientUserId: person.id, label: name } });
    const call = await prisma.programCallRecord.create({ data: { enrollmentId: e.id, clientId: client.id, callType: "MONTHLY_STRATEGY", status: "COMPLETED", scheduledStart: new Date("2026-09-24T14:00:00Z"), matchState: "MATCHED" }, select: { id: true } });
    const enrollment = { id: e.id, clientId: client.id, clientName: name, status: "ACTIVE", videosPerMonth: 4, sessionsPerMonth: 1 };
    const viewer: PortalViewer = { enrollment, actor: { kind: "CLIENT", clientUserId: person.id, email: `${name.split(" ")[0].toLowerCase()}@example.com`, name, membershipId: seat.id, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" };
    return { clientId: client.id, enrollmentId: e.id, monthId: month.id, projectId: p.id, v1: imp.versionId, callId: call.id, viewer, name };
  }
  const analyze = (w: Awaited<ReturnType<typeof world>>, out: ReturnType<typeof analysis>, fn = gen.analyzeTranscriptText) => {
    nextAnalysis = out;
    return fn({ enrollmentId: w.enrollmentId, clientId: w.clientId, monthId: w.monthId, monthKey: "2026-10", transcript: "…the call…", callDate: new Date("2026-09-24T14:00:00Z"), videosOwed: 4, requestedBy: "drill", unattended: false, callRecordId: w.callId });
  };
  const musicVersions = async (clientId: string) => {
    const a = await prisma.clientAsset.findFirst({ where: { clientId, profileKey: "music" } });
    return { asset: a, versions: a ? await prisma.clientAssetVersion.findMany({ where: { assetId: a.id }, orderBy: { versionNo: "asc" } }) : [] };
  };
  const sectionsOf = async (versionId: string) => cs.parseStoredSections((await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: versionId } })).sectionsJson)!;

  // =========================================================================
  c.head("0 · OLD (HEAD): nothing to apply, an appended section, a brief blind to accepted facts");
  // =========================================================================
  {
    const o = await world("Olga Oldfield");
    const r = await analyze(o, analysis({ facts: [MUSIC_FACT], strategyProposals: [GOALS_PROPOSAL] }), oldGen.analyzeTranscriptText);
    const fact = await prisma.clientFact.findFirst({ where: { clientId: o.clientId, fieldKey: "editing.music" } });
    const props = await prisma.contentStrategyProposal.findMany({ where: { clientId: o.clientId } });
    c.ok("OLD: the fact was stored, PROPOSED", r.facts === 1 && fact?.status === "PROPOSED");
    c.ok("OLD: no PROFILE proposal — nothing named the music field or 'Calm acoustic'", !props.some((p) => p.kind === "PROFILE") && !props.some((p) => (p.diffJson ?? "").includes("Calm acoustic")), props.map((p) => p.kind).join(","));
    c.ok("OLD: the strategy proposal named no section", props.length === 1 && props[0].targetKey === null && props[0].diffJson === null);
    const before = await sectionsOf(o.v1);
    const acc = await oldStrat.acceptStrategyProposal(props[0].id, "jordan@realtourpilot.com");
    const after = await sectionsOf(acc.versionId!);
    c.ok("OLD: accepting APPENDED an 'Accepted proposal' section", after.sections.length === before.sections.length + 1 && /^Accepted proposal/.test(after.sections.at(-1)!.heading), after.sections.at(-1)?.heading);
    c.ok("  …and the Content Goals section it was about is unchanged", after.sections.find((s) => s.id === "content-goals")?.text === before.sections.find((s) => s.id === "content-goals")?.text);
    c.ok("OLD: the editor brief read no accepted fact (no productionFactsForProject, no brand brief)", !/productionFactsForProject|brandBriefFor/.test(base.editPage));
    await facts.acceptFact(fact!.id, "jordan@realtourpilot.com");
    c.ok("OLD and NEW alike: accepting the fact left the music at 'Upbeat pop'", (await bp.getSlot(o.clientId, "music"))?.value === "Upbeat pop");
  }

  const W = await world("Mara Lindqvist");
  // The actions run as the drill's session-less "dev@local" — the STRATEGY duty
  // for this client is handed to that person (Jordan's own override card), so
  // the duty-owner check passes for the reason it would in production.
  const strategist = await prisma.appUser.create({ data: { email: "dev@local", name: "Drill Strategist", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const { setOwnerOverride } = await import("@/lib/contentProgram");
  await setOwnerOverride("ENROLLMENT", W.enrollmentId, "STRATEGY", strategist.id, "drill");

  // =========================================================================
  c.head("1 · the call proposes the change: target, from, to, the call, the fact");
  // =========================================================================
  let musicProposalId = "";
  let musicFactId = "";
  {
    const r = await analyze(W, analysis({ facts: [MUSIC_FACT] }));
    const f = await prisma.clientFact.findFirst({ where: { clientId: W.clientId, fieldKey: "editing.music" } });
    const p = await prisma.contentStrategyProposal.findFirst({ where: { clientId: W.clientId, kind: "PROFILE" } });
    const diff = JSON.parse(p?.diffJson ?? "[]") as { path: string; from: string | null; to: string }[];
    c.ok("a PROPOSED ClientFact", r.facts === 1 && f?.status === "PROPOSED");
    c.ok("a PROFILE proposal, targetKey 'profile.music'", p?.targetKey === "profile.music" && p.status === "PROPOSED", p?.summary);
    c.ok("diff 'Upbeat pop' → 'Calm acoustic'", diff[0]?.from === "Upbeat pop" && diff[0]?.to === "Calm acoustic", p?.diffJson ?? "");
    c.ok("factId and callRecordId on it", p?.factId === f?.id && p?.callRecordId === W.callId);
    c.ok("the prompt carried the approved section headings", /APPROVED STRATEGY SECTION HEADINGS[\s\S]*2\. Content Goals/.test(prompts.at(-1) ?? ""));
    const again = await pf.applyCallKnowledge({ enrollmentId: W.enrollmentId, clientId: W.clientId, targetMonthId: W.monthId, callRecordId: W.callId, callDate: null, unattended: false, sourceRef: `ProgramCallRecord:${W.callId}` }, { facts: [MUSIC_FACT as never] });
    c.ok("re-running the same extraction makes no second proposal", again.fieldProposals === 0 && (await prisma.contentStrategyProposal.count({ where: { clientId: W.clientId, kind: "PROFILE" } })) === 1);
    musicProposalId = p!.id;
    musicFactId = f!.id;
    c.ok("the Strategy tab does not list it (it is applied from Facts)", !(await cs.openStrategyProposals(W.enrollmentId)).some((x) => x.id === musicProposalId));
  }

  // =========================================================================
  c.head("2 · remember ≠ apply");
  // =========================================================================
  {
    const r = await actions.factDecision(musicFactId, "ACCEPT");
    const mv = await musicVersions(W.clientId);
    c.ok("accepting the fact → ACCEPTED", r.ok && (await prisma.clientFact.findUnique({ where: { id: musicFactId } }))?.status === "ACCEPTED", r.message);
    c.ok("  …the message says it doesn't change the profile", /doesn't change their profile/.test(r.message) && /editor brief/.test(r.message), r.message);
    c.ok("the music is still 'Upbeat pop', one version", mv.versions.length === 1 && (await bp.getSlot(W.clientId, "music"))?.value === "Upbeat pop");
    c.ok("the proposal is still PROPOSED", (await prisma.contentStrategyProposal.findUnique({ where: { id: musicProposalId } }))?.status === "PROPOSED");
  }

  // =========================================================================
  c.head("3 · applying is a person's act: a new version, history, notes, the editor told");
  // =========================================================================
  {
    const dms = slackPosts.filter((p) => p.channel === "U-KIM").length;
    const r = await actions.applyFieldProposalAction(musicProposalId, null, "Confirmed on the call");
    const mv = await musicVersions(W.clientId);
    c.ok("applied", r.ok, r.message);
    c.ok("music v2 'Calm acoustic', source 'fact'; v1 untouched", mv.versions.length === 2 && mv.versions[1].valueText === "Calm acoustic" && mv.versions[1].source === "fact" && mv.versions[0].valueText === "Upbeat pop" && mv.asset?.activeVersionId === mv.versions[1].id);
    const p = await prisma.contentStrategyProposal.findUnique({ where: { id: musicProposalId } });
    c.ok("proposal ACCEPTED, notes kept, appliedAt, resultAssetVersionId = v2", p?.status === "ACCEPTED" && p.resolutionNote === "Confirmed on the call" && !!p.appliedAt && p.resultAssetVersionId === mv.versions[1].id && p.resolvedBy === "dev@local");
    const ch = await prisma.clientBrandChange.findFirst({ where: { clientId: W.clientId, source: "fact" } });
    c.ok("a ClientBrandChange APPLIED_FROM_CALL, from/to, the fact and the proposal", ch?.kind === "APPLIED_FROM_CALL" && ch.fromText === "Upbeat pop" && ch.toText === "Calm acoustic" && ch.factId === musicFactId && ch.proposalId === musicProposalId);
    const brief = await bp.brandBriefFor(W.clientId, { projectId: W.projectId, scrub: true, links: false });
    c.ok("the editor brief now says 'Calm acoustic'", brief.music === "Calm acoustic");
    c.ok("one Slack DM to Kim", slackPosts.filter((x) => x.channel === "U-KIM").length === dms + 1 && /Calm acoustic/.test(slackPosts.at(-1)?.text ?? ""), slackPosts.at(-1)?.text.slice(0, 140));
    c.ok("Kyle's confirmation task is open", (await prisma.smartTask.count({ where: { assignedKey: "kyle", status: "OPEN", dedupeKey: { startsWith: `brand-ack:${W.clientId}:` } } })) === 1);
    c.ok("the brief banner carries it", brief.pending.some((x) => x.kind === "APPLIED_FROM_CALL"));
    const again = await pf.applyFieldProposal(musicProposalId, { email: "jordan@realtourpilot.com" });
    c.ok("applying again → refused, still 2 versions", !again.ok && (await musicVersions(W.clientId)).versions.length === 2, again.message);
  }

  // =========================================================================
  c.head("4 · ignoring changes nothing");
  // =========================================================================
  {
    const f = await facts.createFact({ clientId: W.clientId, enrollmentId: W.enrollmentId, category: "BRAND_PREFERENCE", fieldKey: "brand.fonts", body: "Switching the brand font to Playfair Display", source: "call" });
    const id = await pf.proposeFieldChange({ clientId: W.clientId, enrollmentId: W.enrollmentId, factId: f.id, fieldKey: "brand.fonts", proposedValue: "Playfair Display" });
    const r = await actions.ignoreFieldProposalAction(id!, "Not what she meant");
    c.ok("a fonts proposal → ignored → REJECTED", !!id && r.ok && (await prisma.contentStrategyProposal.findUnique({ where: { id: id! } }))?.status === "REJECTED", r.message);
    c.ok("no fonts slot was created, no brand change recorded", (await prisma.clientAsset.count({ where: { clientId: W.clientId, profileKey: "fonts" } })) === 0 && (await prisma.clientBrandChange.count({ where: { clientId: W.clientId, fieldKey: "slot:fonts" } })) === 0);
  }

  // =========================================================================
  c.head("5 · drift: the field changed since the proposal → refused, and who is named");
  // =========================================================================
  {
    const f = await facts.createFact({ clientId: W.clientId, enrollmentId: W.enrollmentId, category: "PRODUCTION_PREFERENCE", fieldKey: "editing.music", body: "Wants jazz now", source: "call" });
    const id = await pf.proposeFieldChange({ clientId: W.clientId, enrollmentId: W.enrollmentId, factId: f.id, fieldKey: "editing.music", proposedValue: "Jazz" });
    const diff = JSON.parse((await prisma.contentStrategyProposal.findUnique({ where: { id: id! } }))!.diffJson!) as { from: string }[];
    c.ok("proposal 'Calm acoustic' → 'Jazz'", diff[0].from === "Calm acoustic");
    await bp.saveClientBrandProfile(W.viewer, { slots: { music: "Lo-fi" } });
    const r = await pf.applyFieldProposal(id!, { email: "jordan@realtourpilot.com" });
    c.ok("apply refused, naming the change and who made it", !r.ok && /changed since/.test(r.message) && /Lo-fi/.test(r.message) && /Mara Lindqvist/.test(r.message), r.message);
    c.ok("the slot stays 'Lo-fi', the proposal still PROPOSED", (await bp.getSlot(W.clientId, "music"))?.value === "Lo-fi" && (await prisma.contentStrategyProposal.findUnique({ where: { id: id! } }))?.status === "PROPOSED");
    await pf.ignoreFieldProposal(id!, "jordan@realtourpilot.com", "superseded by the client");
  }

  // =========================================================================
  c.head("6 · confidential knowledge never proposes and never applies");
  // =========================================================================
  {
    const before = await prisma.contentStrategyProposal.count({ where: { clientId: W.clientId } });
    await pf.applyCallKnowledge({ enrollmentId: W.enrollmentId, clientId: W.clientId, targetMonthId: W.monthId, callDate: null, unattended: false, sourceRef: "drill" }, {
      facts: [
        { ...MUSIC_FACT, body: "Confidentially: switching to techno before the divorce news", confidential: true, proposedValue: "Techno" } as never,
        { ...MUSIC_FACT, body: "[CONFIDENTIAL] wants dark ambient for the listing she's hiding", confidential: false, proposedValue: "Dark ambient" } as never,
      ],
    });
    c.ok("a confidential fact, or a [CONFIDENTIAL] body, makes no proposal", (await prisma.contentStrategyProposal.count({ where: { clientId: W.clientId } })) === before);
    const f = await facts.createFact({ clientId: W.clientId, enrollmentId: W.enrollmentId, category: "PRODUCTION_PREFERENCE", fieldKey: "editing.music", body: "Wants strings", source: "call" });
    const id = await pf.proposeFieldChange({ clientId: W.clientId, enrollmentId: W.enrollmentId, factId: f.id, fieldKey: "editing.music", proposedValue: "Strings" });
    await prisma.clientFact.update({ where: { id: f.id }, data: { confidential: true } });
    const r = await pf.applyFieldProposal(id!, { email: "jordan@realtourpilot.com" });
    c.ok("a proposal whose fact is later marked confidential → apply refused, slot unchanged", !r.ok && /confidence/.test(r.message) && (await bp.getSlot(W.clientId, "music"))?.value === "Lo-fi", r.message);
  }

  // =========================================================================
  c.head("7 · a strategy proposal changes ONE section, in a draft");
  // =========================================================================
  {
    await analyze(W, analysis({ strategyProposals: [GOALS_PROPOSAL] }));
    const p = await prisma.contentStrategyProposal.findFirst({ where: { clientId: W.clientId, kind: "POSITIONING" } });
    c.ok("targetKey 'strategy.section:content-goals'", p?.targetKey === "strategy.section:content-goals", p?.targetKey ?? "");
    const v1 = await sectionsOf(W.v1);
    const count = await prisma.contentStrategyVersion.count({ where: { enrollmentId: W.enrollmentId } });
    const r = await actions.resolveStrategyProposal(p!.id, true, "Agreed on the call");
    const v = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: W.enrollmentId }, orderBy: { versionNo: "desc" } });
    const next = await sectionsOf(v!.id);
    c.ok("accepted → a new INTERNAL_REVIEW version based on v1", r.ok && v?.status === "INTERNAL_REVIEW" && v.basedOnVersionId === W.v1 && (await prisma.contentStrategyVersion.count({ where: { enrollmentId: W.enrollmentId } })) === count + 1, r.message);
    c.ok("the message names the section", /only the "2\. Content Goals" section/.test(r.message), r.message);
    c.ok("same section count, no 'Accepted proposal' section", next.sections.length === v1.sections.length && !next.sections.some((s) => /Accepted proposal/.test(s.heading)));
    const others = v1.sections.filter((s) => s.id !== "content-goals");
    c.ok("every other section: same id, order, heading and text, byte for byte", others.every((s, i) => JSON.stringify(s) === JSON.stringify(next.sections.filter((x) => x.id !== "content-goals")[i])));
    c.ok("Content Goals now carries the new text", next.sections.find((s) => s.id === "content-goals")?.text === GOALS_PROPOSAL.proposedText);
    c.ok("the structured read followed (generation will see the new goal)", (next.document?.contentGoals.items ?? []).some((g) => /relocation specialist/.test(g)), JSON.stringify(next.document?.contentGoals.items));
    c.ok("v1 is still APPROVED — the strategy in force", (await prisma.contentStrategyVersion.findUnique({ where: { id: W.v1 } }))?.status === "APPROVED");
    const portal = await portalStrategy({ id: W.enrollmentId, clientId: W.clientId });
    c.ok("the portal still shows v1's goals", portal?.versionNo === 1 && (portal.sections.find((s) => s.id === "content-goals")?.body ?? "").includes("5,000 local followers"));
    c.ok("the proposal is ACCEPTED with the draft on it", (await prisma.contentStrategyProposal.findUnique({ where: { id: p!.id } }))?.resultVersionId === v!.id);
  }

  // =========================================================================
  c.head("8 · stale: the section changed in a newer approved version → refused");
  // =========================================================================
  {
    const overview = { kind: "POSITIONING", summary: "Lead with relocation in the brand message", impact: null, section: "Brand Overview", proposedText: "Brand Message: The relocation specialist for the western suburbs", confidential: false };
    const goalsAgain = { kind: "STRATEGY", summary: "Add a newsletter goal", impact: null, section: "Content Goals", proposedText: "- Grow to 5,000 local followers\n- Launch a monthly newsletter", confidential: false };
    await analyze(W, analysis({ strategyProposals: [overview, goalsAgain] }));
    const po = await prisma.contentStrategyProposal.findFirst({ where: { clientId: W.clientId, targetKey: "strategy.section:brand-overview", status: "PROPOSED" } });
    const pg = await prisma.contentStrategyProposal.findFirst({ where: { clientId: W.clientId, targetKey: "strategy.section:content-goals", status: "PROPOSED" } });
    // A newer version that edits Brand Overview (and nothing else) is approved.
    const v1 = await sectionsOf(W.v1);
    const edited = { ...v1, sections: v1.sections.map((s) => (s.id === "brand-overview" ? { ...s, text: `${s.text}\nShort Brand Statement: Main Line, done right.` } : s)) };
    const v3 = await cs.createStrategyVersion({ enrollmentId: W.enrollmentId, stored: edited, sourceKind: "manual", createdBy: "jordan@realtourpilot.com", status: "INTERNAL_REVIEW", changeSummary: "Jordan's own edit" });
    await cs.approveStrategyVersion(v3.versionId, "jordan@realtourpilot.com");
    const r = await actions.resolveStrategyProposal(po!.id, true, "");
    c.ok("the Brand Overview proposal (made against v1) is refused", !r.ok && /changed in v\d/.test(r.message), r.message);
    c.ok("  …and is still PROPOSED", (await prisma.contentStrategyProposal.findUnique({ where: { id: po!.id } }))?.status === "PROPOSED");
    const ok = await actions.resolveStrategyProposal(pg!.id, true, "", "- Grow to 5,000 local followers\n- Launch a monthly newsletter (Jordan's wording)");
    const v = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: W.enrollmentId }, orderBy: { versionNo: "desc" } });
    const next = await sectionsOf(v!.id);
    c.ok("a v1-based proposal whose section did NOT change goes through, on top of the version in force", ok.ok && v?.basedOnVersionId === v3.versionId && !!next.sections.find((s) => s.id === "brand-overview")?.text.includes("Main Line, done right"), ok.message);
    c.ok("  …with the person's edited wording, recorded on the proposal", !!next.sections.find((s) => s.id === "content-goals")?.text.endsWith("(Jordan's wording)") && ((await prisma.contentStrategyProposal.findUnique({ where: { id: pg!.id } }))?.diffJson ?? "").includes("appliedTo"));
    await actions.resolveStrategyProposal(po!.id, false, "stale");
  }

  // =========================================================================
  c.head("9 · rejecting changes nothing");
  // =========================================================================
  {
    const id = await cs.createStrategyProposal({ enrollmentId: W.enrollmentId, kind: "AUDIENCE", summary: "Target first-time buyers", sourceKind: "staff" });
    const before = await prisma.contentStrategyVersion.count({ where: { enrollmentId: W.enrollmentId } });
    const r = await actions.resolveStrategyProposal(id, false, "no");
    c.ok("REJECTED, and the version count is unchanged", r.ok && (await prisma.contentStrategyProposal.findUnique({ where: { id } }))?.status === "REJECTED" && (await prisma.contentStrategyVersion.count({ where: { enrollmentId: W.enrollmentId } })) === before);
  }

  // =========================================================================
  c.head("10 · confidential strategy knowledge becomes a locked fact; a marked version can't be released");
  // =========================================================================
  {
    const before = await prisma.contentStrategyProposal.count({ where: { clientId: W.clientId } });
    const r = await pf.applyCallKnowledge({ enrollmentId: W.enrollmentId, clientId: W.clientId, targetMonthId: W.monthId, callDate: null, unattended: false, sourceRef: "drill" }, {
      strategyProposals: [{ kind: "POSITIONING", summary: "Is merging with a rival brokerage next spring", impact: null, section: "Brand Overview", proposedText: "Brand Message: part of the merged firm", confidential: true }],
    });
    const f = await prisma.clientFact.findFirst({ where: { clientId: W.clientId, category: "INTERNAL", body: { contains: "merging" } } });
    c.ok("no proposal; a confidential INTERNAL fact instead, locked out of AI", r.confidentialProposals === 1 && (await prisma.contentStrategyProposal.count({ where: { clientId: W.clientId } })) === before && f?.confidential === true && f.aiContext === "DENIED");
    let threw = false;
    try { await cs.createStrategyProposal({ enrollmentId: W.enrollmentId, kind: "STRATEGY", summary: "[CONFIDENTIAL] their pricing floor", sourceKind: "staff" }); } catch { threw = true; }
    c.ok("createStrategyProposal refuses a [CONFIDENTIAL] marker", threw);
    const v1 = await sectionsOf(W.v1);
    const leaky = { ...v1, sections: v1.sections.map((s) => (s.id === "content-goals" ? { ...s, text: `${s.text}\n[CONFIDENTIAL] their pricing floor` } : s)) };
    const lv = await cs.createStrategyVersion({ enrollmentId: W.enrollmentId, stored: leaky, sourceKind: "manual", createdBy: "drill", status: "INTERNAL_REVIEW" });
    await cs.approveStrategyVersion(lv.versionId, "jordan@realtourpilot.com");
    let refused = "";
    try { await cs.releaseStrategyVersion(lv.versionId, "jordan@realtourpilot.com"); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    c.ok("releasing a version whose text carries [CONFIDENTIAL…] throws", /CONFIDENTIAL/.test(refused) && !(await prisma.contentStrategyVersion.findUnique({ where: { id: lv.versionId } }))?.releasedAt, refused);
  }

  // =========================================================================
  c.head("11 · a profile proposal is not a strategy change");
  // =========================================================================
  {
    const f = await facts.createFact({ clientId: W.clientId, enrollmentId: W.enrollmentId, category: "PRODUCTION_PREFERENCE", fieldKey: "editing.captions", body: "Wants bold yellow captions", source: "call" });
    const id = await pf.proposeFieldChange({ clientId: W.clientId, enrollmentId: W.enrollmentId, factId: f.id, fieldKey: "editing.captions", proposedValue: "Bold yellow" });
    const before = await prisma.contentStrategyVersion.count({ where: { enrollmentId: W.enrollmentId } });
    let msg = "";
    try { await cs.acceptStrategyProposal(id!, "jordan@realtourpilot.com"); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    c.ok("acceptStrategyProposal on 'profile.*' throws, no version made", /Facts tab/.test(msg) && (await prisma.contentStrategyVersion.count({ where: { enrollmentId: W.enrollmentId } })) === before, msg);
    const listed = await cs.openStrategyProposals(W.enrollmentId);
    const legacy = await cs.createStrategyProposal({ enrollmentId: W.enrollmentId, kind: "STRATEGY", summary: "A legacy, untargeted idea", sourceKind: "staff" });
    const listed2 = await cs.openStrategyProposals(W.enrollmentId);
    c.ok("openStrategyProposals excludes it — and still lists a legacy row with no target", !listed.some((x) => x.id === id) && listed2.some((x) => x.id === legacy));
    c.ok("the staff-only captions slot applies like any other", (await pf.applyFieldProposal(id!, { email: "kyle@realtourpilot.com" })).ok && (await bp.getSlot(W.clientId, "editing.captions"))?.value === "Bold yellow");
  }

  // =========================================================================
  c.head("12 · the brief reads ACCEPTED production facts, never proposed ones");
  // =========================================================================
  {
    const a = await facts.createFact({ clientId: W.clientId, enrollmentId: W.enrollmentId, category: "PRODUCTION_PREFERENCE", body: "Prefers to film at the office on Tuesdays", source: "staff" });
    await facts.acceptFact(a.id, "jordan@realtourpilot.com");
    await facts.createFact({ clientId: W.clientId, enrollmentId: W.enrollmentId, category: "PRODUCTION_PREFERENCE", body: "Might want a drone shot someday", source: "call" });
    const brief = await bp.brandBriefFor(W.clientId, { projectId: W.projectId, scrub: true, links: false });
    c.ok("accepted one is on the brief", brief.acceptedPreferences.some((x) => /office on Tuesdays/.test(x)), brief.acceptedPreferences.join(" | "));
    c.ok("the proposed one is not", !brief.acceptedPreferences.some((x) => /drone/.test(x)));
    c.ok("the staff captions default is on the brief too", brief.productionDefaults.some((d) => d.text === "Bold yellow"), JSON.stringify(brief.productionDefaults));
  }

  // =========================================================================
  c.head("13 · an unplaced proposal can be placed on a section");
  // =========================================================================
  {
    const id = await cs.createStrategyProposal({ enrollmentId: W.enrollmentId, kind: "PILLAR", summary: "Add a pillar about schools", sourceKind: "call" });
    const inForce = await cs.approvedStrategy(W.enrollmentId);
    const r = await actions.resolveStrategyProposal(id, true, "", "Pillar 1: Market Insight\nPurpose: Explain the market\nFocus Areas: Prices, inventory, school districts", "content-pillars");
    const v = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: W.enrollmentId }, orderBy: { versionNo: "desc" } });
    const next = await sectionsOf(v!.id);
    c.ok("placed → a section-only draft on the version in force", r.ok && v?.basedOnVersionId === inForce?.versionId && next.sections.length === inForce!.stored.sections.length && next.sections.find((s) => s.id === "content-pillars")!.text.includes("school districts"), r.message);
    c.ok("  …and the proposal now names its section", (await prisma.contentStrategyProposal.findUnique({ where: { id } }))?.targetKey === "strategy.section:content-pillars");
  }

  // =========================================================================
  c.head("14 · a portal correction naming a section is aimed at it");
  // =========================================================================
  {
    const { portalProposeStrategyCorrection } = await import("@/app/portal/actions");
    const token = `tok${"y".repeat(30)}`;
    await prisma.contentEnrollment.update({ where: { id: W.enrollmentId }, data: { portalToken: token } });
    const r = await portalProposeStrategyCorrection({ token }, { summary: "We don't do new construction any more", section: "content goals" });
    const p = await prisma.contentStrategyProposal.findFirst({ where: { enrollmentId: W.enrollmentId, sourceKind: "client" }, orderBy: { createdAt: "desc" } });
    c.ok("the correction targets the Content Goals section", r.ok && p?.targetKey === "strategy.section:content-goals", `${r.message} · ${p?.targetKey}`);
    const noText = await actions.resolveStrategyProposal(p!.id, true, "");
    c.ok("accepting it without writing the replacement is refused", !noText.ok && /Write the new text/.test(noText.message), noText.message);
    const leak = await actions.resolveStrategyProposal(p!.id, true, "", "- New goal [CONFIDENTIAL: their commission split]");
    c.ok("a replacement carrying a [CONFIDENTIAL] marker is refused, and nothing is drafted", !leak.ok && /confidential/i.test(leak.message) && (await prisma.contentStrategyProposal.findUnique({ where: { id: p!.id } }))?.status === "PROPOSED", leak.message);
    const fine = await actions.resolveStrategyProposal(p!.id, true, "", "- Grow to 5,000 local followers\n- Resale homes only");
    c.ok("with clean text it drafts the section change", fine.ok, fine.message);
  }

  // =========================================================================
  c.head("15 · accepting is compare-and-set: two tabs, different text → one draft, one winner");
  // =========================================================================
  // Review fix (Sep 24 2026): the accept read PROPOSED, built a version, then
  // wrote ACCEPTED unconditionally, so two concurrent accepts with different
  // edited text both built a draft and the first was orphaned. (The section
  // path is new in this batch, so there is no older build to race.)
  {
    const inForce = await cs.approvedStrategy(W.enrollmentId);
    const goals = inForce!.stored.sections.find((x) => x.id === "content-goals")!;
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const results: string[] = [];
    let clean = true;
    let i = 0;
    for (const delay of [0, 1, 3, 8, 20]) {
      i++;
      const id = await cs.createStrategyProposal({ enrollmentId: W.enrollmentId, kind: "POSITIONING", summary: `Race ${i}`, sourceKind: "call", targetKey: "strategy.section:content-goals", diff: [{ path: "strategy.section:content-goals", from: goals.text, to: `- Race goal ${i}` }] });
      const before = await prisma.contentStrategyVersion.count({ where: { enrollmentId: W.enrollmentId } });
      const res = await Promise.allSettled([
        cs.acceptStrategyProposal(id, "tab-a", undefined, { text: `- Tab A goal ${i}` }),
        (async () => { await tick(delay); return cs.acceptStrategyProposal(id, "tab-b", undefined, { text: `- Tab B goal ${i}` }); })(),
      ]);
      const made = await prisma.contentStrategyVersion.findMany({ where: { enrollmentId: W.enrollmentId }, orderBy: { versionNo: "asc" }, skip: before, select: { id: true } });
      const p = await prisma.contentStrategyProposal.findUniqueOrThrow({ where: { id } });
      const won = res.filter((r) => r.status === "fulfilled");
      const lost = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      const ok = made.length === 1 && won.length === 1 && lost.length === 1 && /already handled/.test(String((lost[0]?.reason as Error)?.message)) && p.status === "ACCEPTED" && p.resultVersionId === made[0].id;
      if (!ok) clean = false;
      results.push(`${delay}ms: drafts=${made.length} won=${won.length} ${p.status}${p.resultVersionId === made[0]?.id ? "" : " (result points elsewhere)"}`);
    }
    c.ok("at every interleaving: exactly one draft, one success, the loser told 'already handled', the proposal pointing at that draft", clean, results.join(" | "));
    // A failed build hands the proposal back rather than leaving it ACCEPTED with no draft.
    const stale = await cs.createStrategyProposal({ enrollmentId: W.enrollmentId, kind: "POSITIONING", summary: "Stale on arrival", sourceKind: "call", targetKey: "strategy.section:no-such-section", diff: [{ path: "strategy.section:no-such-section", from: "x", to: "y" }] });
    let why = "";
    try { await cs.acceptStrategyProposal(stale, "tab-a"); } catch (e) { why = e instanceof Error ? e.message : String(e); }
    c.ok("a refused accept leaves the proposal PROPOSED", /isn't in the strategy in force/.test(why) && (await prisma.contentStrategyProposal.findUniqueOrThrow({ where: { id: stale } })).status === "PROPOSED", why);
  }

  c.ok("nothing left the machine: zero blocked outbound calls", fence.blocked.length === 0, fence.blocked.join(", "));
  c.summary();
  quiet.restore();
  fence.restore();
  try { fs.unlinkSync(path.join(base.dir, "node_modules")); fs.rmSync(base.dir, { recursive: true, force: true }); } catch { /* harmless */ }
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
