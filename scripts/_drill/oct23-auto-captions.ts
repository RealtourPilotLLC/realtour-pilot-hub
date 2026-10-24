// ---------------------------------------------------------------------------
// AUTOMATIC TRANSCRIPTS AND INSTAGRAM CAPTIONS — the drill (Oct 23 2026).
//
//   DRILL_PORT=47xx node scripts/_drill/run-all.cjs scripts/_drill/oct23-auto-captions.ts
//
// Jordan connected Deepgram and said yes to: each approved monthly video is
// transcribed automatically, its caption drafted from the real spoken words,
// waiting in the client's posting kit and on the video in Monthly Content.
// "Caption writing should follow Instagram / meta's rules for writing
// captions that drive the most engagement" (docs/instagram-caption-rules.md).
//
// Isolated PGlite. Deepgram is FAKED at the fence (its request recorded, never
// sent) and the model is a stub (integrations/ai): the run ledger, the switch,
// the rollout, the entitlement, the prompt, the code checks and the saved rows
// are all the shipped code. The Review Room's own approveCut is pressed.
//
//   A  approval asks for ONE transcript of that exact version; the driver
//      transcribes it once (nova-3, English, smart formatting, Token auth,
//      the cut's own URL)
//   B  the caption is drafted ONCE from the transcript, on Sonnet 5.5, from a
//      lean prompt; the code enforces the rules on a rule-breaking reply
//      (dashes, first line, hashtags, bait CTA, fair housing, invented number)
//   C  a caption a person wrote is never overwritten, and skips the draft
//   D  a new approved version: the old automatic draft goes STALE, a fresh
//      one is drafted for the new version, the person's caption untouched
//   E  listing videos are never touched
//   F  the gates: caption_assistant, ai_runs, an AI outage, the rollout,
//      cut_transcripts off (script fallback), no backfill, the wait for a
//      transcript on its way, a cut with no hosted file (script fallback)
//   G  a transcription run that died mid-call is recovered
//   H  the posting kit: a newer version's caption waits while the client keeps
//      the earlier file, and is not marked stale
//   I  the office's view: the caption on the video, with where it came from
//   J  the wiring, read from source
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { PortalViewer } from "@/lib/portal";

const PORT = Number(process.env.DRILL_PORT ?? 4791);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();

// ---- Deepgram, faked at the fence ------------------------------------------
const DG_KEY = ["dgdrill", "a1b2c3d4", "e5f6a7b8", "c9d0"].join("-"); // built at run time; never printed
type DgCall = { url: string; auth: string | null; body: string };
const dgCalls: DgCall[] = [];
let dgTranscript = "";
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://api.deepgram.com/")) return null;
  const h = new Headers(init?.headers ?? {});
  dgCalls.push({ url, auth: h.get("authorization"), body: typeof init?.body === "string" ? init.body : "" });
  return new Response(JSON.stringify({
    metadata: { duration: 41.2 },
    results: { channels: [{ alternatives: [{ transcript: dgTranscript }] }], utterances: [{ start: 0, end: 3.4, transcript: dgTranscript.split(". ")[0] }] },
  }), { status: 200, headers: { "content-type": "application/json" } });
});

// ---- the model, and only the model -----------------------------------------
type Seen = { fn: string; system: string; prompt: string; model: string | null; effort: string | null; maxTokens: number | null; usage: { inputTokens: number; outputTokens: number } };
const seen: Seen[] = [];
let next: Record<string, unknown> = {};
const estTokens = (s: string) => Math.ceil(s.length / 4);
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai") || r.endsWith("/integrations/ai.ts"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage" && k !== "aiStructuredWithUsage") return t[k];
      return async (o: { system: string; prompt: string; model?: string; effort?: string; maxTokens?: number }) => {
        if (!/Instagram caption/.test(o.system)) throw new Error(`unexpected model call in the caption drill: ${o.system.slice(0, 80)}`);
        // Measured from the real prompt: about 4 characters a token, and the
        // answer's JSON for the output (plus no thinking: effort low).
        const usage = { inputTokens: estTokens(o.system + o.prompt), outputTokens: estTokens(JSON.stringify(next)), cacheReadTokens: 0, cacheWriteTokens: 0 };
        seen.push({ fn: String(k), system: o.system, prompt: o.prompt, model: o.model ?? null, effort: o.effort ?? null, maxTokens: o.maxTokens ?? null, usage });
        return { result: next, usage, model: o.model ?? "drill-stub", stopReason: "end_turn" };
      };
    },
  }),
);

const c = makeChecker();
const DASH = /[‒–—―]/;

async function strategyText(name: string, cta: string[]): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const doc = {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice, local depth.", brandMessage: "Plan the sale before the sign goes up.", shortBrandStatement: null, brandVoice: "Plain, direct, warm. Talks like a neighbour.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers before they list", "Show local pricing expertise"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Lead with pricing and timing."], pillars: [
      { number: 1, name: "Market Authority", heading: "Pillar 1: Market Authority", purpose: "Show command of the local market.", focusAreas: "pricing, timing", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: cta.length ? { heading: "Caption CTA Examples", items: cta } : null,
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["Quarterly focus paragraph that a lean caption prompt should never carry."] }, otherSections: [],
  };
  return renderStrategy(doc as unknown as Parameters<typeof renderStrategy>[0]);
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { buildContentMonth } = await import("./_fixtures/contentMonth");
  const pk = await import("@/lib/postingKit");
  const ct = await import("@/lib/cutTranscripts");
  const cv = await import("@/lib/contentVideos");
  const cs = await import("@/lib/contentStrategy");
  const ce = await import("@/lib/cutEntitlement");
  const rules = await import("@/lib/contentPolicy/captionRules");
  const tr = await import("@/lib/integrations/transcription");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const review = await import("@/app/review/actions");
  const core = await import("@/lib/programRolloutCore");
  const { aiCostUsd } = await import("@/lib/aiUsage");

  c.head("0 · the harness");
  c.ok("the app is pointed at the isolated database", (process.env.DATABASE_URL ?? "").includes("127.0.0.1"));

  const setSwitch = (key: string, enabled: boolean) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled } });
  await setSwitch("cut_transcripts", true);
  await setSwitch("caption_assistant", true);
  await setSwitch("ai_runs", true);
  await saveSecret("transcription_deepgram", DG_KEY);
  c.ok("Deepgram is the connected provider (a saved key, no network)", (await tr.activeTranscriptionProvider())?.id === "deepgram" && dgCalls.length === 0);

  const BLOB = (id: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${id}.mp4`;
  const approveStrategy = async (enrollmentId: string, name: string, cta: string[]) => {
    const text = await strategyText(name, cta);
    const { stored } = cs.structuredFromText(text);
    const sv = await cs.createStrategyVersion({ enrollmentId, stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof cs.createStrategyVersion>[0]);
    await cs.approveStrategyVersion(sv.versionId, "jordan@drill.invalid");
  };
  let seq = 0;
  /** A cut on the program's deliverable, slot 1. `pending` = waiting for the Review Room's verdict. */
  const mkCut = async (f: { projectId: string | null; deliverableId: string | null }, round: number, o: { status?: string; blob?: boolean; decidedAt?: Date; released?: boolean } = {}) => {
    seq++;
    const row = await prisma.reviewSubmission.create({
      data: {
        projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, round, fileName: `pricing-v${round}-${seq}.mp4`, status: o.status ?? "PENDING", source: "upload",
        submittedByKey: "kim", submittedByName: "Kim Miguel", sizeBytes: 5, createdAt: new Date(Date.now() + seq),
        ...(o.status === "APPROVED" ? { decidedBy: "James", decidedAt: o.decidedAt ?? new Date(), completedAt: o.decidedAt ?? new Date() } : {}),
        // Published to the portal (the monthly handoff): what lets the client see and approve it.
        ...(o.released ? { clientReleasedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), ...(o.blob === false ? {} : { blobUrl: BLOB(row.id), blobPathname: `review-cuts/${row.id}.mp4` }) } });
    return row.id;
  };
  async function program(name: string, o: { cta?: string[]; cutStatus?: string; blob?: boolean; decidedAt?: Date; released?: boolean } = {}) {
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name, package: "Starter", monthKey: "2026-10",
      project: { status: "SCHEDULED", shootDate: new Date("2026-10-10T14:00:00Z") }, owner: { email: `${name.split(" ")[0].toLowerCase()}@example.com`, name },
    });
    await approveStrategy(f.enrollmentId, name, o.cta ?? ["DM me PRICE."]);
    const sub = await mkCut(f, 1, { status: o.cutStatus, blob: o.blob, decidedAt: o.decidedAt, released: o.released });
    await cv.syncEnrollmentVideos({ id: f.enrollmentId, clientId: f.clientId });
    const video = await prisma.contentVideo.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, OR: [{ currentSubmissionId: sub }, { approvedSubmissionId: sub }] } });
    await prisma.reviewSubmission.update({ where: { id: sub }, data: { videoId: video.id } });
    const pillar = await prisma.contentPillar.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, name: "Market Authority", purpose: "Show command of the local market." }, select: { id: true } });
    await prisma.contentVideo.update({ where: { id: video.id }, data: { pillarId: pillar.id } });
    await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, videoId: video.id, title: "First weekend pricing", body: "Your first weekend decides your price.\nPrice it right and buyers compete.\nThat's the whole game.", status: "CLIENT_VISIBLE", releaseState: "released" } });
    const viewer = {
      enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth },
      actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "x@example.com", name, membershipId: f.membershipId!, membershipRole: "OWNER" },
      access: "FULL", via: "LOGIN",
    } as PortalViewer;
    return { f, sub, video, viewer };
  }
  const transcriptsOf = (submissionId: string) => prisma.contentCutTranscript.findMany({ where: { submissionId }, orderBy: { version: "asc" } });
  const draftsOf = (submissionId: string) => prisma.contentCaptionDraft.findMany({ where: { submissionId }, orderBy: [{ kind: "asc" }, { versionNo: "desc" }] });
  const alt = (d: { alternativesJson: string | null }) => { try { return JSON.parse(d.alternativesJson ?? "{}") as { sourceNote?: string; fixes?: string[]; gaps?: string[]; findings?: string[]; auto?: boolean; hashtags?: string[] }; } catch { return {}; } };
  const drive = () => ct.runCutTranscriptDriver({ leaseBy: "drill", budgetMs: 250_000 });
  const sweep = (now?: Date) => pk.sweepAutoCaptions({ budgetMs: 250_000, now });
  const SPOKEN = "Most sellers in Bucks County price for the wrong weekend. Your first weekend on the market decides your price. Price it right and buyers compete for it. If you want your number, DM me PRICE.";
  dgTranscript = SPOKEN;
  // A reply that breaks every checkable rule at once (the code must fix it).
  const RULE_BREAKER = {
    hook: "Most sellers in Bucks County price for the wrong weekend — and it costs them the bidding war before it even starts.",
    body: "Your first weekend on the market decides your price.\nPrice it right and buyers compete for it. Perfect for growing families who want room.\nHomes here sell in 9 days. #reels",
    cta: "Tag a friend who is selling this spring!",
    hashtags: ["#BucksCountyRealEstate", "#reels", "#explore", "#HomePricing", "#SellingAHome", "#ListingTips", "#PricingStrategy", "#FirstWeekend"],
    shortCaption: "Price it right on day one – buyers compete.",
    coverTitle: "First weekend pricing",
    gaps: [],
  };
  const CLEAN = {
    hook: "Your first weekend on the market decides your price.",
    body: "Price it right and buyers compete for it.\nMost sellers in Bucks County price for the wrong weekend.",
    cta: "Want your number? DM me PRICE.",
    hashtags: ["#BucksCountyRealEstate", "#HomePricing", "#SellingAHome"],
    shortCaption: "Your first weekend decides your price.",
    coverTitle: "First weekend pricing",
    gaps: [],
  };

  // =========================================================================
  c.head("A · approval asks for ONE transcript of that exact version; the driver transcribes it once");
  // =========================================================================
  const ada = await program("Ada Auto TEST");
  {
    const before = await prisma.appSetting.findUnique({ where: { key: ct.AUTO_TRANSCRIPTS_SINCE_KEY } });
    c.ok("(no start date yet: nothing has been automatic)", !before);
    const r = await review.approveCut(ada.sub);
    c.ok("the Review Room approves the monthly cut", r.ok, r.message);
    const rows = await transcriptsOf(ada.sub);
    const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: ada.sub } });
    c.ok("exactly one transcript row for that version, QUEUED for Deepgram", rows.length === 1 && rows[0].status === "QUEUED" && rows[0].provider === "deepgram", rows.map((x) => `${x.status}/${x.provider}`).join(","));
    c.ok("…pinned to the version's own bytes", rows[0]?.contentHash === ct.cutIdentityHash(cut) && rows[0]?.sourceRound === 1);
    const since = await ct.autoTranscriptsSince(null);
    c.ok("the start date is this approval's moment (no backfill before it)", !!since && !!cut.decidedAt && since.getTime() === cut.decidedAt.getTime(), `${since?.toISOString()} vs ${cut.decidedAt?.toISOString()}`);
    const again = await review.approveCut(ada.sub);
    c.ok("a second press: 'Already approved', still one row", again.ok && /Already approved/.test(again.message) && (await transcriptsOf(ada.sub)).length === 1, again.message);
    const catchUp = await ct.requestMissingMonthlyTranscripts();
    c.ok("the catch-up finds nothing missing", catchUp.requested === 0, JSON.stringify(catchUp));

    const d = await drive();
    c.ok("the driver transcribes it: one claim, one success", d.claimed === 1 && d.succeeded === 1 && d.failed === 0, JSON.stringify(d));
    c.ok("ONE request reached the Deepgram fake (none left the machine)", dgCalls.length === 1 && fence.faked.filter((u) => u.startsWith("https://api.deepgram.com/")).length === 1);
    const call = dgCalls[0];
    const u = new URL(call.url);
    c.ok("POST https://api.deepgram.com/v1/listen", u.origin + u.pathname === "https://api.deepgram.com/v1/listen");
    c.ok("model=nova-3, language=en (monolingual English), smart_format=true, utterances=true", u.searchParams.get("model") === "nova-3" && u.searchParams.get("language") === "en" && u.searchParams.get("smart_format") === "true" && u.searchParams.get("utterances") === "true", u.search);
    c.ok("no detect_language (English only), no client name in the tag", !u.searchParams.has("detect_language") && u.searchParams.get("tag") === `rtp-cut-${ada.sub}`);
    c.ok("Authorization: Token <the saved key> (compared, never printed)", call.auth === `Token ${DG_KEY}`);
    c.ok("the body is the cut's own fetchable URL, and no store token rides along", JSON.parse(call.body).url === BLOB(ada.sub) && !/token/i.test(call.body), call.body.replace(/[a-z0-9]{20,}/gi, "…"));
    c.ok("the request shape is the adapter's pure deepgramListenRequest", tr.deepgramListenRequest({ url: BLOB(ada.sub), submissionId: ada.sub }).url === call.url);
    const done = (await transcriptsOf(ada.sub))[0];
    c.ok("the row is SUCCEEDED with the spoken words, English, the duration", done.status === "SUCCEEDED" && done.text === SPOKEN && done.language === "en" && done.durationSec === 41.2 && !!done.segmentsJson, `${done.status}/${done.language}`);
    const d2 = await drive();
    c.ok("the next run transcribes nothing (one transcript per version)", d2.claimed === 0 && dgCalls.length === 1, JSON.stringify(d2));
    const sw = await prisma.programAutomation.findUniqueOrThrow({ where: { key: "cut_transcripts" } });
    c.ok("the switch records the run", !!sw.lastRunAt && !sw.lastError);
  }

  // =========================================================================
  c.head("B · the caption: once, from the transcript, Sonnet 5.5, a lean prompt, the rules enforced in code");
  // =========================================================================
  {
    next = RULE_BREAKER;
    const m0 = seen.length;
    const s = await sweep();
    c.ok("the sweep drafts ONE caption with ONE model call", s.drafted === 1 && seen.length === m0 + 1, JSON.stringify({ ...s, results: s.results.map((x) => x.why) }));
    const call = seen[seen.length - 1];
    c.ok("on the writer path, the model map's Sonnet entry (claude-sonnet-5-5), effort low, never Opus", call.fn === "aiStructuredWithUsage" && call.model === "claude-sonnet-5-5" && call.effort === "low" && !/opus/i.test(call.model ?? ""), `${call.fn}/${call.model}/${call.effort}`);
    c.ok("the prompt leads with the transcript of the final cut", /TRANSCRIPT OF THE FINAL CUT \(primary factual source/.test(call.prompt) && call.prompt.includes(SPOKEN));
    c.ok("…carries the script, her voice, the pillar, the area and her CTA example", call.prompt.includes("Your first weekend decides your price.") && call.prompt.includes("Talks like a neighbour") && call.prompt.includes("Market Authority") && call.prompt.includes("Bucks County") && call.prompt.includes("DM me PRICE."));
    c.ok("…and is lean: not the whole strategy, no earlier scripts", !call.prompt.includes("Quarterly focus paragraph") && !/EARLIER SCRIPTS/.test(call.prompt));
    c.ok("the system prompt carries Instagram's rules (first line, hashtags, no bait, fair housing, no dashes)", /First line/.test(call.system) && /at most 5/.test(call.system) && /engagement bait/.test(call.system) && /Fair housing/.test(call.system) && /No em dashes/.test(call.system));
    c.ok(`input about ${call.usage.inputTokens} tokens (inside Jordan's 3 to 6k aim), answer about ${call.usage.outputTokens}`, call.usage.inputTokens <= 6000 && call.usage.outputTokens <= 600);
    const rows = await draftsOf(ada.sub);
    const cap = rows.find((d) => d.kind === "CAPTION")!;
    c.ok("drafts saved: caption, short caption, CTA, cover title; AI, DRAFT, tied to this version", ["CAPTION", "COVER_TITLE", "CTA", "SHORT_CAPTION"].every((k) => rows.some((d) => d.kind === k)) && rows.every((d) => d.authorKind === "AI" && d.status === "DRAFT" && d.submissionId === ada.sub), rows.map((d) => d.kind).join(","));
    c.ok("each says it came from the transcript, and that it was automatic", rows.every((d) => /^Drafted from the transcript of the final cut/.test(alt(d).sourceNote ?? "") && alt(d).auto === true) && !!cap.transcriptId);
    const lines = cap.body.split("\n");
    const tags = rules.hashtagsIn(cap.body);
    c.ok("no em or en dash anywhere (caption, short caption, cover title)", rows.every((d) => !DASH.test(d.body)), rows.map((d) => d.body).join(" | ").slice(0, 200));
    c.ok(`the first line stands alone, at most ${rules.CAPTION_LIMITS.firstLineMax} characters`, lines[0].length <= rules.CAPTION_LIMITS.firstLineMax && /^Most sellers in Bucks County/.test(lines[0]), `${lines[0].length}: ${lines[0]}`);
    c.ok("at most 5 hashtags, none generic (#reels, #explore gone), all on the last line", tags.length <= 5 && tags.length >= 3 && !tags.some((t) => /^#(reels|explore)$/i.test(t)) && lines[lines.length - 1].split(" ").every((w) => w.startsWith("#")), tags.join(" "));
    c.ok("the bait CTA ('Tag a friend') became her strategy's own ('DM me PRICE.')", !/tag a friend/i.test(cap.body) && rows.find((d) => d.kind === "CTA")?.body === "DM me PRICE." && cap.body.includes("\n\nDM me PRICE.\n\n"));
    c.ok("the fair-housing line ('Perfect for growing families') is gone", !/perfect for|famil/i.test(cap.body));
    c.ok("the invented number ('sell in 9 days') is gone", !/\b9\b/.test(cap.body));
    c.ok("…and both are listed for a person to check", (alt(cap).gaps ?? []).some((g) => /who the home or area suits/.test(g)) && (alt(cap).gaps ?? []).some((g) => /number the sources do not give/.test(g)), JSON.stringify(alt(cap).gaps));
    c.ok("checkCaption finds nothing left to fix", rules.checkCaption(cap.body).length === 0 && (alt(cap).findings ?? ["x"]).length === 0, JSON.stringify(rules.checkCaption(cap.body)));
    const run = await prisma.programAiRun.findFirstOrThrow({ where: { kind: "caption", scopeJson: { contains: `"autoFor":"${ada.sub}"` } } });
    const usd = aiCostUsd(run.model ?? "", { inputTokens: run.inputTokens ?? 0, outputTokens: run.outputTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    c.ok("the run ledger: SUCCEEDED, unattended (cron:caption-auto), Sonnet 5.5, tokens and cost recorded", run.status === "SUCCEEDED" && run.requestedBy === "cron:caption-auto" && run.model === "claude-sonnet-5-5" && (run.inputTokens ?? 0) > 0 && run.costCents != null, `${run.status}/${run.requestedBy}/${run.model}/${run.inputTokens}/${run.outputTokens}/${run.costCents}c`);
    console.log(`  ·· measured on the fake run: input ${run.inputTokens} tokens, output ${run.outputTokens} tokens, costCents ${run.costCents} (exact $${usd.toFixed(4)}) on ${run.model}`);
    console.log(`  ·· the caption as saved:\n${cap.body.split("\n").map((l) => `     | ${l}`).join("\n")}`);
    console.log(`  ·· what the code fixed: ${(alt(cap).fixes ?? []).join("; ")}`);
    const m1 = seen.length;
    const s2 = await sweep();
    c.ok("the next sweep drafts nothing more for this version (at most one automatic draft)", s2.drafted === 0 && seen.length === m1 && (await draftsOf(ada.sub)).filter((d) => d.kind === "CAPTION").length === 1, JSON.stringify(s2.results));
    const direct = await pk.autoDraftCaptionForCut(ada.sub);
    c.ok("…and asking for this version directly says it already has one", !direct.drafted && /already has a caption/.test(direct.why), direct.why);
  }

  // A clean reply, for the sample a real model is aiming at.
  {
    const { buildCaptionDraftPrompt, finishCaption } = rules;
    const p = buildCaptionDraftPrompt({ clientName: "Ada Auto TEST", videoTitle: "First weekend pricing", transcript: SPOKEN, script: "Your first weekend decides your price.", strategy: null });
    const fin = finishCaption(CLEAN, { sourcesText: p.sourcesText, ctaExamples: ["DM me PRICE."] });
    c.ok("a reply that keeps the rules passes through unchanged", fin.fixes.length === 0 && fin.findings.length === 0 && fin.caption.startsWith(CLEAN.hook), JSON.stringify(fin.fixes));
    console.log(`  ·· a clean caption from the same fake transcript:\n${fin.caption.split("\n").map((l) => `     | ${l}`).join("\n")}`);
  }

  // =========================================================================
  c.head("C · a caption a person wrote is never overwritten");
  // =========================================================================
  const MINE = "My own caption, my own words.";
  {
    // saveCaptionEdit's row shape: a new CLIENT row, CHOSEN (the kit's edit).
    await prisma.contentCaptionDraft.create({ data: { videoId: ada.video.id, submissionId: ada.sub, enrollmentId: ada.f.enrollmentId, clientId: ada.f.clientId, kind: "CAPTION", body: MINE, versionNo: 99, authorKind: "CLIENT", status: "CHOSEN", chosenAt: new Date(), chosenBy: "client" } });
    const m0 = seen.length;
    await sweep();
    const mine = await prisma.contentCaptionDraft.findFirstOrThrow({ where: { videoId: ada.video.id, authorKind: "CLIENT" } });
    c.ok("a sweep after her edit: no model call, her caption untouched (CHOSEN, same words)", seen.length === m0 && mine.status === "CHOSEN" && mine.body === MINE);
    const bo = await program("Bo Wrote TEST");
    await review.approveCut(bo.sub);
    await drive();
    await prisma.contentCaptionDraft.create({ data: { videoId: bo.video.id, submissionId: bo.sub, enrollmentId: bo.f.enrollmentId, clientId: bo.f.clientId, kind: "CAPTION", body: "Bo wrote this before any draft.", versionNo: 1, authorKind: "STAFF", status: "CHOSEN", chosenAt: new Date(), chosenBy: "Kyle" } });
    const m1 = seen.length;
    const r = await pk.autoDraftCaptionForCut(bo.sub);
    c.ok("a version that already has a person's caption gets no automatic draft at all", !r.drafted && /already has a caption/.test(r.why) && seen.length === m1 && (await prisma.contentCaptionDraft.count({ where: { submissionId: bo.sub, authorKind: "AI" } })) === 0, r.why);
  }

  // =========================================================================
  c.head("D · a new approved version: the old automatic draft goes STALE, a fresh one is drafted");
  // =========================================================================
  let ada2 = "";
  {
    ada2 = await mkCut(ada.f, 2);
    await prisma.reviewSubmission.update({ where: { id: ada2 }, data: { videoId: ada.video.id } });
    const r = await review.approveCut(ada2);
    c.ok("version 2 approved in the Review Room", r.ok, r.message);
    c.ok("one transcript requested for version 2 (version 1's stays one)", (await transcriptsOf(ada2)).length === 1 && (await transcriptsOf(ada.sub)).length === 1);
    dgTranscript = "Your first weekend on the market decides your price. Price it right and buyers compete for it. DM me PRICE for your number.";
    const d = await drive();
    c.ok("the driver transcribes version 2 (a second Deepgram call, for the new version)", d.succeeded === 1 && dgCalls.length === 3, `${JSON.stringify(d)} calls=${dgCalls.length}`);
    next = CLEAN;
    const m0 = seen.length;
    const s = await sweep();
    c.ok("one fresh draft, for version 2", s.drafted === 1 && seen.length === m0 + 1 && (await draftsOf(ada2)).filter((x) => x.authorKind === "AI").length === 4, JSON.stringify(s.results));
    const v1ai = await prisma.contentCaptionDraft.findMany({ where: { submissionId: ada.sub, authorKind: "AI" } });
    c.ok("version 1's automatic drafts are STALE ('a newer version was approved')", v1ai.length === 4 && v1ai.every((x) => x.status === "STALE" && x.staleReason === "a newer version was approved"), v1ai.map((x) => x.status).join(","));
    const mine = await prisma.contentCaptionDraft.findFirstOrThrow({ where: { videoId: ada.video.id, authorKind: "CLIENT" } });
    c.ok("her own caption is untouched (CHOSEN, same words)", mine.status === "CHOSEN" && mine.body === MINE);
    const v2cap = (await draftsOf(ada2)).find((x) => x.kind === "CAPTION")!;
    c.ok("version 2's caption is drafted from version 2's transcript", v2cap.status === "DRAFT" && /transcript of the final cut/.test(alt(v2cap).sourceNote ?? "") && seen[seen.length - 1].prompt.includes("DM me PRICE for your number."));
    const r1 = await pk.autoDraftCaptionForCut(ada.sub);
    c.ok("version 1 is never drafted again (a newer version was approved)", !r1.drafted && /newer version|already has/.test(r1.why), r1.why);
  }

  // =========================================================================
  c.head("E · listing videos are never touched");
  // =========================================================================
  {
    const lp = await prisma.project.create({ data: { title: "12 Listing Ln", status: "SCHEDULED", clientId: ada.f.clientId }, select: { id: true } });
    const ls = await prisma.reviewSubmission.create({ data: { projectId: lp.id, slot: 1, round: 1, fileName: "12-listing.mp4", status: "APPROVED", source: "upload", decidedAt: new Date(), decidedBy: "James", sizeBytes: 5 }, select: { id: true } });
    await prisma.reviewSubmission.update({ where: { id: ls.id }, data: { blobUrl: BLOB(ls.id), blobPathname: `review-cuts/${ls.id}.mp4` } });
    const req = await ct.requestMonthlyCutTranscript(ls.id, "drill", { fresh: true });
    c.ok("asking for a listing video's transcript is refused in words", !req.requested && /Not a monthly program video/.test(req.why), req.why);
    const dg0 = dgCalls.length, m0 = seen.length;
    await ct.requestMissingMonthlyTranscripts();
    await drive();
    await sweep();
    c.ok("the catch-up, the driver and the caption sweep pass it by: no row, no call", (await transcriptsOf(ls.id)).length === 0 && dgCalls.length === dg0 && seen.length === m0 && (await prisma.contentCaptionDraft.count({ where: { submissionId: ls.id } })) === 0);
    const src = fs.readFileSync(path.join(REPO, "src/app/review/actions.ts"), "utf8");
    c.ok("approveCut asks for a transcript on a program job only", /\.\.\.\(program\s*\?\s*\[\{[\s\S]{0,900}step: "transcript request"[\s\S]{0,600}requestMonthlyCutTranscript\(submissionId, authorName \?\? "review", \{ fresh: true \}\)/.test(src));
  }

  // =========================================================================
  c.head("F · the gates");
  // =========================================================================
  {
    // F1 caption_assistant off
    const cy = await program("Cy Gate TEST");
    await review.approveCut(cy.sub);
    await drive();
    await setSwitch("caption_assistant", false);
    let m0 = seen.length;
    let s = await sweep();
    c.ok("caption_assistant OFF: the sweep is skipped, no model call", s.skipped === "caption_assistant is off" && seen.length === m0, s.skipped ?? "");
    await setSwitch("caption_assistant", true);
    // F2 ai_runs off
    await setSwitch("ai_runs", false);
    s = await sweep();
    c.ok("ai_runs OFF: skipped (the automatic draft is unattended work)", s.skipped === "AI runs are off" && seen.length === m0, s.skipped ?? "");
    await setSwitch("ai_runs", true);
    // F3 the AI account refusing
    const now = new Date().toISOString();
    await prisma.appSetting.create({ data: { key: "ai_outage", value: JSON.stringify({ since: now, lastAt: now, reason: "usage_limit", failures: 3 }) } });
    s = await sweep();
    c.ok("an AI outage on record (the usage limit): skipped, nothing spent", /refusing/.test(s.skipped ?? "") && seen.length === m0, s.skipped ?? "");
    await prisma.appSetting.delete({ where: { key: "ai_outage" } });
    // F4 the rollout
    await prisma.client.update({ where: { id: cy.f.clientId }, data: { name: "Cy Realclient" } });
    const notReached = await pk.autoDraftCaptionForCut(cy.sub);
    c.ok("a real client the rollout does not reach (TEST clients only): no draft, no call", !notReached.drafted && /doesn't reach/.test(notReached.why) && seen.length === m0, notReached.why);
    await prisma.appSetting.upsert({
      where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY },
      create: { key: core.PROGRAM_ROLLOUT_SETTING_KEY, value: core.serializeProgramRollout({ mode: "PILOT", modeSince: new Date(Date.now() - 3_600_000).toISOString(), pilot: { clientIds: [cy.f.clientId], operations: core.opsForGroups(["portal_changes"]), approvedBy: "jordan@drill", approvedAt: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: null, note: null, joinedAt: {} } }), updatedBy: "drill" },
      update: {},
    });
    next = CLEAN;
    const reached = await pk.autoDraftCaptionForCut(cy.sub);
    c.ok("named in the pilot with automatic portal changes: drafted", reached.drafted && seen.length === m0 + 1, reached.why);

    // F5 cut_transcripts off → BLOCKED, no Deepgram call, the caption from the script
    await setSwitch("cut_transcripts", false);
    const dee = await program("Dee NoTranscript TEST");
    await review.approveCut(dee.sub);
    const rows = await transcriptsOf(dee.sub);
    c.ok("cut_transcripts OFF: the request is recorded as waiting (BLOCKED_AUTOMATION_OFF), not lost", rows.length === 1 && rows[0].status === "BLOCKED_AUTOMATION_OFF", rows.map((x) => x.status).join(","));
    const dg0 = dgCalls.length;
    const d = await drive();
    c.ok("…the driver does nothing (skipped: automation_off), no Deepgram call", d.skipped === "automation_off" && dgCalls.length === dg0);
    m0 = seen.length;
    const fb = await pk.autoDraftCaptionForCut(dee.sub);
    const call = seen[seen.length - 1];
    c.ok("the caption is drafted from the script, at once (no transcript is coming)", fb.drafted && seen.length === m0 + 1 && /NO TRANSCRIPT OF THE FINAL CUT EXISTS/.test(call.prompt) && call.prompt.includes("Your first weekend decides your price."), fb.why);
    const fbCap = (await draftsOf(dee.sub)).find((x) => x.kind === "CAPTION")!;
    c.ok("…and says so in words", /^Drafted from the script, with no transcript yet/.test(alt(fbCap).sourceNote ?? ""), alt(fbCap).sourceNote ?? "");
    await setSwitch("cut_transcripts", true);

    // F6 no backfill
    const since = (await ct.autoTranscriptsSince(null))!;
    const old = await program("Eve Before TEST", { cutStatus: "APPROVED", decidedAt: new Date(since.getTime() - 86_400_000) });
    m0 = seen.length;
    const cu = await ct.requestMissingMonthlyTranscripts();
    await sweep();
    c.ok("a version approved before the start date: no transcript requested, no caption drafted", (await transcriptsOf(old.sub)).length === 0 && (await prisma.contentCaptionDraft.count({ where: { submissionId: old.sub } })) === 0 && seen.length === m0, JSON.stringify(cu));
    const oldDirect = await pk.autoDraftCaptionForCut(old.sub);
    c.ok("…and asked directly, it says why", !oldDirect.drafted && /before automatic captions began/.test(oldDirect.why), oldDirect.why);

    // F7 a transcript on its way: the caption waits, then (after the wait) drafts from the script
    const fay = await program("Fay Waiting TEST");
    await review.approveCut(fay.sub);
    m0 = seen.length;
    const w = await pk.autoDraftCaptionForCut(fay.sub);
    c.ok("a transcript queued but not run yet: the caption waits for it (no call)", !w.drafted && /Waiting for the transcript/.test(w.why) && seen.length === m0, w.why);
    const later = await pk.autoDraftCaptionForCut(fay.sub, { now: new Date(Date.now() + pk.AUTO_CAPTION_WAIT_MS + 60_000) });
    c.ok("…three hours on with still no transcript, it drafts from the script", later.drafted && /NO TRANSCRIPT OF THE FINAL CUT EXISTS/.test(seen[seen.length - 1].prompt), later.why);

    // F8 no hosted file → NEEDS_REVIEW, no Deepgram call, the caption from the script
    const gus = await program("Gus NoFile TEST", { blob: false });
    await review.approveCut(gus.sub);
    await drive();
    const gr = await transcriptsOf(gus.sub);
    c.ok("a cut with no hosted file: NEEDS_REVIEW with the reason, no Deepgram call for it", gr.length === 1 && gr[0].status === "NEEDS_REVIEW" && /no hosted file/.test(gr[0].lastError ?? "") && !dgCalls.some((x) => x.url.includes(`rtp-cut-${gus.sub}`)), `${gr.map((x) => x.status).join(",")} ${gr[0]?.lastError ?? ""}`);
    m0 = seen.length;
    const gs = await sweep();
    c.ok("…its caption is drafted from the script in the same tick", gs.results.some((x) => x.submissionId === gus.sub && x.why === "drafted") && /NO TRANSCRIPT OF THE FINAL CUT EXISTS/.test(seen[seen.length - 1].prompt), JSON.stringify(gs.results));
  }

  // =========================================================================
  c.head("G · a transcription run that died mid-call is recovered");
  // =========================================================================
  {
    const hal = await program("Hal Lease TEST");
    await review.approveCut(hal.sub);
    const row = (await transcriptsOf(hal.sub))[0];
    await prisma.contentCutTranscript.update({ where: { id: row.id }, data: { status: "RUNNING", attempts: 1, leaseBy: "dead-lambda", leaseUntil: new Date(Date.now() - 60_000) } });
    const dg0 = dgCalls.length;
    const d = await drive();
    const after = (await transcriptsOf(hal.sub))[0];
    c.ok("the dead run's row is put back in the queue and transcribed (one call)", d.recovered === 1 && after.status === "SUCCEEDED" && dgCalls.length === dg0 + 1 && after.attempts === 2, `${JSON.stringify(d)} ${after.status}/${after.attempts}`);
  }

  // =========================================================================
  c.head("H · the posting kit: a newer version's caption waits while the client keeps the earlier file");
  // =========================================================================
  {
    const ivy = await program("Ivy Kit TEST", { cutStatus: "APPROVED", decidedAt: new Date(), released: true });
    const approveByClient = async (sub: string, round: number) => {
      const row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: sub } });
      await prisma.clientDecision.create({ data: { submissionId: sub, projectId: ivy.f.projectId!, videoId: ivy.video.id, enrollmentId: ivy.f.enrollmentId, clientId: ivy.f.clientId, round, contentHash: ce.stableCutIdentity(row), decision: "APPROVE", actorLabel: "client", clientUserId: ivy.f.clientUserId, membershipRole: "OWNER", receiptState: "DONE" } });
    };
    await approveByClient(ivy.sub, 1);
    await ct.requestMonthlyCutTranscript(ivy.sub, "drill");
    dgTranscript = SPOKEN;
    await drive();
    next = CLEAN;
    const r1 = await pk.autoDraftCaptionForCut(ivy.sub);
    let kit = await pk.postingKitFor(ivy.viewer, await prisma.contentVideo.findUniqueOrThrow({ where: { id: ivy.video.id } }));
    c.ok("version 1 approved by the client: the kit shows its drafted caption", r1.drafted && kit.access.captions && kit.captions.some((x) => x.kind === "CAPTION" && x.status === "DRAFT"), r1.why);
    const v2 = await mkCut(ivy.f, 2, { status: "APPROVED", decidedAt: new Date(), released: true });
    await prisma.reviewSubmission.update({ where: { id: v2 }, data: { videoId: ivy.video.id } });
    await cv.syncEnrollmentVideos({ id: ivy.f.enrollmentId, clientId: ivy.f.clientId });
    await ct.requestMonthlyCutTranscript(v2, "drill");
    await drive();
    next = { ...CLEAN, hook: "Version two: your first weekend decides your price." };
    const r2 = await pk.autoDraftCaptionForCut(v2);
    c.ok("version 2 (awaiting the client) gets its own draft", r2.drafted, r2.why);
    const v1ai = await prisma.contentCaptionDraft.findMany({ where: { submissionId: ivy.sub, authorKind: "AI" } });
    c.ok("version 1's draft is NOT stale: the client still downloads version 1", v1ai.length > 0 && v1ai.every((x) => x.status === "DRAFT"), v1ai.map((x) => x.status).join(","));
    const video = await prisma.contentVideo.findUniqueOrThrow({ where: { id: ivy.video.id } });
    kit = await pk.postingKitFor(ivy.viewer, video);
    const e = await ce.videoEntitlement(video);
    c.ok("(the release rule: the file is version 1, version 2 awaits the client)", e.file?.submissionId === ivy.sub && e.current?.submissionId === v2 && e.priorVersion === true, `${e.file?.submissionId === ivy.sub}/${e.current?.submissionId === v2}`);
    c.ok("the kit shows version 1's caption, not version 2's", kit.captions.some((x) => x.kind === "CAPTION" && !/^Version two/.test(x.body)) && !kit.captions.some((x) => /^Version two/.test(x.body)));
    const v2rows = await prisma.contentCaptionDraft.findMany({ where: { submissionId: v2 } });
    c.ok("…and viewing the kit did not mark version 2's draft stale", v2rows.length > 0 && v2rows.every((x) => x.status === "DRAFT"), v2rows.map((x) => x.status).join(","));
    await approveByClient(v2, 2);
    kit = await pk.postingKitFor(ivy.viewer, await prisma.contentVideo.findUniqueOrThrow({ where: { id: ivy.video.id } }));
    const after1 = await prisma.contentCaptionDraft.findMany({ where: { submissionId: ivy.sub } });
    c.ok("the client approves version 2: the kit shows its caption, version 1's is now stale", kit.captions.some((x) => x.kind === "CAPTION" && x.status === "DRAFT" && /^Version two/.test(x.body)) && after1.every((x) => x.status === "STALE"), after1.map((x) => x.status).join(","));
  }

  // =========================================================================
  c.head("I · the office's view: the caption on the video in Monthly Content, with Copy");
  // =========================================================================
  {
    const m = await pk.staffCaptionsFor([ada.video.id]);
    const v = m.get(ada.video.id);
    c.ok("the client's own caption leads for Ada's video (she chose it)", v?.body === MINE && /Written by the client/.test(v.note), v?.note ?? "none");
    // Dee's video: an automatic draft (from the script) and nobody's own caption.
    const deeClient = await prisma.client.findFirstOrThrow({ where: { name: "Dee NoTranscript TEST" } });
    const dee = await prisma.contentVideo.findFirstOrThrow({ where: { clientId: deeClient.id } });
    const g = (await pk.staffCaptionsFor([dee.id])).get(dee.id);
    c.ok("an automatic draft reads 'Drafted automatically' and where it came from", !!g && /^Drafted automatically\. From the script, with no transcript yet/.test(g.note), g?.note ?? "none");
    const panel = fs.readFileSync(path.join(REPO, "src/components/content/ContentLibraryPanel.tsx"), "utf8");
    c.ok("the library panel shows it with a Copy button, no dollar amounts", /function CaptionBlock/.test(panel) && /<CopyButton value=\{caption\.body\}/.test(panel) && !/\$\{?\(?caption/.test(panel));
    const loader = fs.readFileSync(path.join(REPO, "src/app/content/[id]/workspaceData.ts"), "utf8");
    c.ok("the Monthly Content videos tab loads it (staffCaptionsFor)", /staffCaptionsFor\(ids\)/.test(loader));
  }

  // =========================================================================
  c.head("J · the wiring, read from source");
  // =========================================================================
  {
    const route = fs.readFileSync(path.join(REPO, "src/app/api/cron/topics/route.ts"), "utf8");
    const iT = route.indexOf('step("cutTranscripts"'), iC = route.indexOf('step("captions"'), iR = route.indexOf("for (const name of order)");
    c.ok("the AI work job runs transcripts, then captions, before its rotation", iT > 0 && iC > iT && iR > iC);
    c.ok("…the driver with a budget and a minimum start, the captions with theirs", /runCutTranscriptDriver\(\{[^}]*budgetMs[^}]*minStartMs/.test(route) && /sweepAutoCaptions\(\{[^}]*budgetMs[^}]*minStartMs/.test(route));
    const { RETIRED_AUTOMATION_KEYS, LISTED_AUTOMATION_KEYS } = await import("@/lib/programAutomation");
    c.ok("cut_transcripts is no longer retired (listed again); publishing still is", !RETIRED_AUTOMATION_KEYS.includes("cut_transcripts") && LISTED_AUTOMATION_KEYS.includes("cut_transcripts") && RETIRED_AUTOMATION_KEYS.includes("publishing"));
    c.ok("Deepgram's parameters, in one place", JSON.stringify(tr.DEEPGRAM_LISTEN_PARAMS) === JSON.stringify({ model: "nova-3", language: "en", smart_format: "true", utterances: "true" }));
    const doc = fs.readFileSync(path.join(REPO, "docs/instagram-caption-rules.md"), "utf8");
    const igRows = doc.split("\n").filter((l) => /^\| IG\d \|/.test(l));
    c.ok("the rules list exists with a source URL and a dated source for each Instagram rule", igRows.length === 9 && igRows.every((l) => /https:\/\//.test(l) && /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* \d{1,2},? 20\d\d\b/.test(l)), igRows.filter((l) => !/https:\/\//.test(l)).map((l) => l.slice(0, 12)).join(","));
  }

  c.head("Z · isolation");
  c.ok("nothing left the process (Deepgram answered by the fake, the model by the stub)", fence.blocked.filter((u) => /deepgram|anthropic/i.test(u)).length === 0 && fence.faked.every((u) => u.startsWith("https://api.deepgram.com/")), fence.blocked.slice(0, 3).join(", "));
  c.ok("the Deepgram key never appears in a stored row", (await prisma.contentCutTranscript.count({ where: { OR: [{ lastError: { contains: DG_KEY } }, { text: { contains: DG_KEY } }] } })) === 0);

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
