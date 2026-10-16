// ---------------------------------------------------------------------------
// DRILL: a client's style survives every handoff (Oct 15 2026).
//
// Marcee McMullen, Oct 15: stop "Fairy God Realtor", back to the fully
// scripted framework, fonts from her signs and website.
//
//   1. The record: proven format, stopped series (any spelling or case),
//      experiment limit; the prompt block has no dashes.
//   2. The staff write: ledgered, other override keys kept, the office or
//      the creative approver may save it, an editor may not.
//   3. The editor brief (brandBriefFor.styleMemory): the guardrails, her
//      EXAMPLE_VIDEO assets, and her last three approved videos from OTHER
//      jobs, never another client's, never an unapproved cut.
//   4. The stream route: the editor holding one of her jobs may PLAY her
//      approved videos from her other jobs (?ref=), nothing else: not without
//      ref, not another client's, not an unapproved cut, never a download.
//   5. The generators: the bank and script prompts carry the guardrails; a
//      bank idea naming the stopped series is dropped and counted; a script
//      for a topic in the stopped series is refused before any model call.
//   6. The screens.
//
// ISOLATION: PGlite; the login seam and the model are intercepted in-process.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);
const SELLER = "Seller Strategy";
const BUYER = "Buyer Education";
const BRAND = "Personal Brand";
const calls: { kind: string; system: string; prompt: string }[] = [];
const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        const kind = /Video Topic Bank/.test(opts.system) ? "bank" : /writing ONE personal-branding video script/.test(opts.system) ? "script" : /quality judge/.test(opts.system) ? "judge" : "other";
        calls.push({ kind, system: opts.system, prompt: opts.prompt });
        if (kind === "bank") {
          const topics = (prefix: string, extra: string[] = []) => [...extra, ...Array.from({ length: 10 - extra.length }, (_, i) => `${prefix} plan number ${i + 1} for spring`)].map((title) => ({ title, description: "One concrete sentence.", audienceNeed: "n", businessGoal: "g", intendedMessage: "m", sourceRef: null }));
          return { result: { complete: true, gaps: [], pillars: [
            { pillarName: SELLER, topics: topics("Seller", ["Fairy God Realtor: Episode Five"]) },
            { pillarName: BUYER, topics: topics("Buyer", ["The fairy-god REALTOR returns to grant a closing"]) },
            { pillarName: BRAND, topics: topics("Brand") },
          ] }, usage, model: "drill-stub" };
        }
        throw new Error(`unexpected model call: ${kind}`);
      };
    },
  }),
);
installNextStubs();
const fence = fenceFetch();

async function strategyText(name: string): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const doc = {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice.", brandMessage: "Plan the sale.", shortBrandStatement: null, brandVoice: "Plain and warm.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Chester County", pricePositioning: null, primaryClientTypes: "Sellers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Trust, Value, Credibility and Entertainment guide every pillar."], pillars: [
      { number: 1, name: SELLER, heading: `Pillar 1: ${SELLER}`, purpose: "p", focusAreas: "f", contentApproach: null, otherFields: [] },
      { number: 2, name: BUYER, heading: `Pillar 2: ${BUYER}`, purpose: "p", focusAreas: "f", contentApproach: null, otherFields: [] },
      { number: 3, name: BRAND, heading: `Pillar 3: ${BRAND}`, purpose: "p", focusAreas: "f", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PLAN."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["Fully scripted videos."] }, otherSections: [],
  };
  return renderStrategy(doc as unknown as Parameters<typeof renderStrategy>[0]);
}

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7103), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct15-style-memory" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const read = (p: string) => fs.readFileSync(p, "utf8");
  try {
    const { prisma } = await import("@/lib/prisma");
    const core = await import("@/lib/creativeGuardCore");
    const careActions = await import("@/app/clients/clientCareActions");
    const { putSetting } = await import("@/lib/settings");

    const member = (name: string, role: "PHOTOGRAPHER" | "MANAGER" | "EDITOR") => prisma.teamMember.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@style.invalid`, role, active: true }, select: { id: true, name: true } });
    const kyleTm = await member("Kyle Cabrera", "MANAGER");
    const jamesTm = await member("James Livingston", "PHOTOGRAPHER");
    const kimTm = await member("Kim Miguel", "EDITOR");
    const login = (tm: { id: string; name: string }, role: string, extra: Record<string, unknown> = {}) => prisma.appUser.create({ data: { email: `${tm.name.split(" ")[0].toLowerCase()}@style.invalid`, name: tm.name, role, status: "ACTIVE", teamMemberId: tm.id, ...extra }, select: { id: true } });
    const as = (u: { id: string }, tm: { id: string; name: string }, role: string, extra: Partial<Viewer> = {}): Viewer => ({ id: u.id, email: `${tm.name.split(" ")[0].toLowerCase()}@style.invalid`, name: tm.name, role, permissions: null, status: "ACTIVE", teamMemberId: tm.id, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: tm.name, ...extra });
    const V = {
      kyle: as(await login(kyleTm, "ADMIN"), kyleTm, "ADMIN"),
      james: as(await login(jamesTm, "PHOTOGRAPHER"), jamesTm, "PHOTOGRAPHER"),
      kim: as(await login(kimTm, "EDITOR", { editorKey: "kim" }), kimTm, "EDITOR", { editorKey: "kim" }),
    };
    await prisma.appUser.create({ data: { email: "dev@local", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
    await putSetting("review_room", { creativeApproverTeamMemberId: jamesTm.id });

    // ======================================================================
    c.head("1 · the record");
    const g = core.normalizeGuard({ provenFormats: ["Fully scripted, direct to camera"], discontinued: [{ name: "Fairy God Realtor", by: "Jordan", at: "2026-10-15T15:00:00Z", reason: "Client asked to stop it" }], experimentCap: 1 });
    c.ok("a stopped series matches any case or punctuation", core.discontinuedHit("The fairy-god REALTOR returns!", g) === "Fairy God Realtor" && core.discontinuedHit("fairy god realtor", g) === "Fairy God Realtor");
    c.ok("…and not a word inside another", core.discontinuedHit("Fairy tales of a God-fearing realtor", g) === null);
    const block = core.creativeGuardBlock(g);
    c.ok("the prompt block says the format, the stop and the limit, with no dashes", /Proven format: Fully scripted, direct to camera/.test(block) && /DISCONTINUED: "Fairy God Realtor"/.test(block) && /At most 1 experimental concept/.test(block) && !/[—–]/.test(block));
    c.ok("an empty guard says nothing", core.creativeGuardBlock(core.EMPTY_GUARD) === "");

    // ======================================================================
    c.head("2 · the staff write");
    const M = await buildContentMonth(prisma as never, { name: "Marcee Style TEST", package: "Starter", project: { status: "EDITING" } });
    await prisma.contentEnrollment.update({ where: { id: M.enrollmentId }, data: { overridesJson: JSON.stringify({ videoStyle: "DIRECT", catchUps: { "2026-10": { missedMonthKey: "2026-09" } } }) } });
    viewer = V.kim;
    const byEditor = await careActions.saveCreativeGuard({ enrollmentId: M.enrollmentId, addDiscontinued: { name: "Fairy God Realtor" } });
    c.ok("an editor cannot change the guardrails", !byEditor.ok);
    viewer = V.james;
    const byJames = await careActions.saveCreativeGuard({ enrollmentId: M.enrollmentId, addDiscontinued: { name: "Fairy God Realtor", reason: "Client asked to stop it on the Oct 15 call" } });
    c.ok("James (the creative approver) stops the series", byJames.ok, byJames.message);
    viewer = V.kyle;
    const byKyle = await careActions.saveCreativeGuard({ enrollmentId: M.enrollmentId, provenFormats: ["Fully scripted, direct to camera"], experimentCap: 0 });
    c.ok("Kyle (office) sets the proven format", byKyle.ok, byKyle.message);
    const dup = await careActions.saveCreativeGuard({ enrollmentId: M.enrollmentId, addDiscontinued: { name: "fairy god realtor" } });
    c.ok("stopping it twice is refused in words", !dup.ok && /already stopped/.test(dup.message));
    const bag = JSON.parse((await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: M.enrollmentId } })).overridesJson!);
    c.ok("other override keys are kept", bag.videoStyle === "DIRECT" && !!bag.catchUps?.["2026-10"]);
    c.ok("the guard is stored, with who", bag.creative?.discontinued?.[0]?.name === "Fairy God Realtor" && bag.creative.discontinued[0].by === "James Livingston" && bag.creative.provenFormats[0] === "Fully scripted, direct to camera" && bag.creative.experimentCap === 0);
    c.ok("every save is on the enrollment ledger", (await prisma.programEnrollmentChange.count({ where: { enrollmentId: M.enrollmentId, field: "overrides", reason: { contains: "creative guardrails" } } })) === 2);

    // ======================================================================
    c.head("3 · the editor brief");
    const jobA = M.projectId!;
    await prisma.project.update({ where: { id: jobA }, data: { editorId: kimTm.id, editorManual: true } });
    const mkJob = async (clientId: string, title: string) => (await prisma.project.create({ data: { title, clientId, status: "DELIVERED" }, select: { id: true } })).id;
    const jobB = await mkJob(M.clientId, "12 Older Ln, Malvern, PA");
    const other = await prisma.client.create({ data: { name: "Someone Else TEST" }, select: { id: true } });
    const jobC = await mkJob(other.id, "99 Other St, Paoli, PA");
    const cut = (projectId: string, status: string, fileName: string, at: number) => prisma.reviewSubmission.create({ data: { projectId, slot: 1, round: 1, kind: "video", source: "upload", status, fileName, submittedByKey: "john", decidedAt: new Date(Date.now() - at * 3600_000), blobUrl: `https://drillstore.private.blob.vercel-storage.com/${fileName}` } });
    const b1 = await cut(jobB, "APPROVED", "marcee-sept-1.mp4", 30);
    const b2 = await cut(jobB, "APPROVED", "marcee-sept-2.mp4", 20);
    const b3 = await cut(jobB, "APPROVED", "marcee-aug-1.mp4", 50);
    await cut(jobB, "APPROVED", "marcee-jul-1.mp4", 90);
    const bPending = await cut(jobB, "PENDING", "marcee-draft.mp4", 1);
    const cOther = await cut(jobC, "APPROVED", "someone-else.mp4", 2);
    await cut(jobA, "APPROVED", "this-job.mp4", 1);
    const asset = await prisma.clientAsset.create({ data: { clientId: M.clientId, type: "EXAMPLE_VIDEO", name: "Erica Walker bio video", ownership: "AGENCY", status: "ACTIVE" } });
    const v = await prisma.clientAssetVersion.create({ data: { assetId: asset.id, versionNo: 1, source: "manual", valueText: "https://vimeo.com/123456" } });
    await prisma.clientAsset.update({ where: { id: asset.id }, data: { activeVersionId: v.id } });
    const { brandBriefFor } = await import("@/lib/brandProfile");
    const brief = await brandBriefFor(M.clientId, { projectId: jobA, scrub: true });
    const mem = brief.styleMemory!;
    c.ok("the brief carries the guardrails", mem.guard?.discontinued[0]?.name === "Fairy God Realtor" && mem.guard.provenFormats[0] === "Fully scripted, direct to camera");
    c.ok("…her example video, as a link", mem.examples.length === 1 && mem.examples[0].url === "https://vimeo.com/123456" && mem.examples[0].name === "Erica Walker bio video");
    c.ok("…her last three approved videos from OTHER jobs, newest first", mem.recentVideos.length === 3 && mem.recentVideos.map((r) => r.url.split("/")[4]).join(",") === [b2.id, b1.id, b3.id].join(","), mem.recentVideos.map((r) => r.title).join(" | "));
    c.ok("…never this job, another client's, or an unapproved cut", !mem.recentVideos.some((r) => /this-job|someone-else|draft/.test(r.title)));
    c.ok("…each link carries the job being worked", mem.recentVideos.every((r) => r.url.endsWith(`?ref=${jobA}`)));

    // ======================================================================
    c.head("4 · the stream route: play her approved videos, nothing else");
    const { NextRequest } = await import("next/server");
    const route = await import("@/app/api/review/cut/[id]/stream/route");
    const play = (id: string, qs = "") => route.GET(new NextRequest(`http://127.0.0.1/api/review/cut/${id}/stream${qs}`), { params: Promise.resolve({ id }) });
    viewer = V.kim;
    c.ok("without ref: her other job's cut is not Kim's to play", (await play(b1.id)).status === 403);
    c.ok("with ref to the job Kim holds: it plays (not refused)", (await play(b1.id, `?ref=${jobA}`)).status !== 403);
    c.ok("…but never as a download", (await play(b1.id, `?ref=${jobA}&dl=1`)).status === 403);
    c.ok("an unapproved cut stays shut", (await play(bPending.id, `?ref=${jobA}`)).status === 403);
    c.ok("another client's approved cut stays shut", (await play(cOther.id, `?ref=${jobA}`)).status === 403);
    c.ok("a ref to a job Kim doesn't hold opens nothing", (await play(b1.id, `?ref=${jobC}`)).status === 403);

    // ======================================================================
    c.head("5 · the generators");
    await prisma.programAutomation.upsert({ where: { key: "ai_runs" }, create: { key: "ai_runs", enabled: true, enabledBy: "drill", enabledAt: new Date() }, update: { enabled: true } });
    const { createStrategyVersion, structuredFromText, approveStrategyVersion } = await import("@/lib/contentStrategy");
    const text = await strategyText("Marcee Style TEST");
    const sv = await createStrategyVersion({ enrollmentId: M.enrollmentId, stored: structuredFromText(text).stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof createStrategyVersion>[0]);
    await approveStrategyVersion(sv.versionId, "dev@local");
    const gen = await import("@/lib/contentGeneration");
    const policy = await import("@/lib/contentPolicy");
    const built = await gen.buildClientContext(M.enrollmentId, { monthId: M.monthId });
    c.ok("the context carries the guardrails", built.ctx.creativeGuard?.discontinued[0]?.name === "Fairy God Realtor");
    const bankP = policy.buildTopicBankPrompt(built.ctx);
    c.ok("the topic bank prompt carries them", bankP.user.includes('DISCONTINUED: "Fairy God Realtor"') && bankP.user.includes("Proven format: Fully scripted, direct to camera") && bankP.user.includes("No experimental concepts"));
    const topic = { ...policy.makeTopic({ title: "Pricing for spring", pillarName: SELLER, description: "x", clientId: built.ctx.clientId }), id: "t1" };
    c.ok("the script prompt carries them", policy.buildScriptPrompt(built.ctx, { path: "transcript", topic, excerpts: [], selectedOnCall: true }).user.includes('DISCONTINUED: "Fairy God Realtor"'));
    const ct = await import("@/lib/contentTopics");
    const run = await ct.startTopicRefresh({ enrollmentId: M.enrollmentId, kind: "BANK", requestedBy: "dev@local" });
    const row = await prisma.contentTopicRefreshRun.findUnique({ where: { id: run.runId } });
    const suggs = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: run.runId }, select: { title: true } });
    c.ok("the bank ran", calls.some((x) => x.kind === "bank") && suggs.length > 0, `${row?.status} ${row?.changeSummary}`);
    c.ok("ideas naming the stopped series never reach the bank", !suggs.some((s) => /fairy/i.test(s.title)));
    c.ok("…and the run says so", /2 ideas from a discontinued series dropped/.test(row?.changeSummary ?? ""), row?.changeSummary ?? "");
    const fairy = await prisma.contentTopic.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, title: "Fairy God Realtor: the closing wish", status: "SELECTED" } });
    const before = calls.length;
    let refusedMsg = "";
    try { await gen.generateScriptForTopic({ topicId: fairy.id, monthId: M.monthId, requestedBy: "dev@local", unattended: false }); } catch (e) { refusedMsg = (e as Error).message; }
    c.ok("a script for a topic in the stopped series is refused in words", /which this client stopped/.test(refusedMsg), refusedMsg);
    c.ok("…before any model call", calls.length === before);

    // ======================================================================
    c.head("6 · the screens");
    const edit = read("src/app/edit/[id]/page.tsx");
    c.ok("the editor brief shows their style (one small block)", /<ClientStyleMemory memory=\{brandBrief\?\.styleMemory\} \/>/.test(edit));
    c.ok("the client file mounts the guardrails editor", /<CreativeGuardEditor enrollmentId=\{enrollment\.id\} guard=\{creativeGuard\} canEdit=\{canEditGuard\} \/>/.test(read("src/app/clients/[id]/page.tsx")));
    const card = read("src/components/editing/ClientStyleMemory.tsx");
    c.ok("the card says it plainly", /What works for them:/.test(card) && /Don&rsquo;t make/.test(card) && /Their last approved videos/.test(card));

    c.head("isolation");
    c.ok("nothing left the machine (the model is in-process)", fence.blocked.every((u) => /blob\.vercel-storage\.com/.test(u)), fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
