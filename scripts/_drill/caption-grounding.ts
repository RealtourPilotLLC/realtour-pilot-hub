// ---------------------------------------------------------------------------
// CAPTION GROUNDING — the drill (unified handoff, Sep 25 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/caption-grounding.ts
//
// The handoff: "Generate a caption only when the client clicks the action.
// Ground it in the approved video/script, strategy, brand voice, and goals. If
// transcription is unavailable, label script-based grounding honestly."
// Isolated PGlite, clock pinned to Fri Sep 25 2026 10:00 ET; the MODEL is the
// only thing stubbed (integrations/ai.aiJsonWithUsage), so the run ledger, the
// entitlement, the switch, the prompt and the saved rows are all the shipped
// code. The stub records every prompt it is handed and counts every call.
//
//   C1  the retired captionAssistant.ts (fa9a2c9) drafted on a click with the
//       switch OFF — a second, looser gate; it is gone and the live path refuses
//   C2  refused BEFORE any model call: switch off, not approved by the client,
//       still being finished (9.6b), an ended program
//   C3  no transcript: the prompt says so, the saved rows and the kit say
//       "drafted from the script", and the prompt carries the approved script,
//       the strategy's brand message, goals and CTA examples
//   C4  a transcript of THIS cut: it is the primary source and the rows say so
//   C5  a strategy that names no offer: invented offers never reach a draft
//   C6  nothing drafts unattended — no scheduled path calls the drafter
//
// This drill proves the grounding MECHANICS against a stub. Whether a real
// model writes a good caption is the separate, supervised real-model check the
// design names (a TEST enrollment with caption_assistant on); it is not here.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { PortalViewer } from "@/lib/portal";

const PORT = Number(process.env.DRILL_PORT ?? 5717);
const BASE = "fa9a2c9"; // the commit this batch starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ------------------------------------------------------------
const RealDate = Date;
const SIM = RealDate.parse("2026-09-25T10:00:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;

installNextStubs();
const fence = fenceFetch((url) =>
  /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url)
    ? new Response("abcde", { status: 200, headers: { "content-type": "video/mp4", "content-length": "5" } })
    : null,
);

// The model, and only the model.
type Seen = { system: string; prompt: string };
const seen: Seen[] = [];
let next: Record<string, unknown> = {};
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai") || r.endsWith("/integrations/ai.ts"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (o: Seen) => {
        seen.push({ system: o.system, prompt: o.prompt });
        return { result: next, usage: { inputTokens: 900, outputTokens: 120 }, model: "drill-stub" };
      };
    },
  }),
);

const c = makeChecker();

/** `git grep -l` over src/, tracked and untracked; no match is an empty list
 *  (git grep exits 1 for "nothing found", which is the answer, not an error). */
function gitGrep(args: string[]): string[] {
  try {
    return execFileSync("git", ["grep", "-l", "--untracked", ...args], { cwd: REPO, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

/** A strategy document in the house format, rendered and approved. */
async function strategyText(name: string, ctaExamples: string[]): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const doc = {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice, local depth.", brandMessage: "Plan the sale before the sign goes up.", shortBrandStatement: null, brandVoice: "Plain, direct, warm.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers before they list", "Show local pricing expertise"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Lead with pricing and timing."], pillars: [
      { number: 1, name: "Market Authority", heading: "Pillar 1: Market Authority", purpose: "Show command of the local market.", focusAreas: "pricing, timing", contentApproach: null, otherFields: [] },
      { number: 2, name: "Seller Education", heading: "Pillar 2: Seller Education", purpose: "Teach sellers what to do before listing.", focusAreas: "prep, repairs", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: ctaExamples.length ? { heading: "Caption CTA Examples", items: ctaExamples } : null,
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["Lead with pricing this quarter."] }, otherSections: [],
  };
  return renderStrategy(doc as unknown as Parameters<typeof renderStrategy>[0]);
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { buildContentMonth } = await import("./_fixtures/contentMonth");
  const pk = await import("@/lib/postingKit");
  const ce = await import("@/lib/cutEntitlement");
  const cv = await import("@/lib/contentVideos");
  const cs = await import("@/lib/contentStrategy");
  const { cutIdentityHash } = await import("@/lib/cutTranscripts");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { portalDraftCaption } = await import("@/app/portal/actions");

  c.head("0 · the harness");
  c.ok("the app is pointed at the isolated database", (process.env.DATABASE_URL ?? "").includes("127.0.0.1"));
  c.ok("the clock reads Fri Sep 25 10:00 ET", new Date().toISOString() === "2026-09-25T14:00:00.000Z");

  const setSwitch = (enabled: boolean) =>
    prisma.programAutomation.upsert({ where: { key: "caption_assistant" }, create: { key: "caption_assistant", enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled } });
  const approveStrategy = async (enrollmentId: string, name: string, cta: string[]) => {
    const text = await strategyText(name, cta);
    const { stored } = cs.structuredFromText(text);
    const sv = await cs.createStrategyVersion({ enrollmentId, stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof cs.createStrategyVersion>[0]);
    await cs.approveStrategyVersion(sv.versionId, "jordan@drill.invalid");
  };
  const BLOB = (id: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${id}.mp4`;
  async function program(name: string, cta: string[], opts: { enrollmentStatus?: "ACTIVE" | "ENDED" } = {}) {
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name, package: "Starter", monthKey: "2026-09", enrollmentStatus: opts.enrollmentStatus,
      project: { status: "SCHEDULED", shootDate: new Date("2026-09-10T14:00:00Z") }, owner: { email: `${name.split(" ")[0].toLowerCase()}@example.com`, name },
    });
    await approveStrategy(f.enrollmentId, name, cta);
    const sub = await prisma.reviewSubmission.create({
      data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, round: 1, fileName: `${name.split(" ")[0]} pricing v1.mp4`, status: "APPROVED", source: "upload", decidedBy: "James", decidedAt: new Date(Date.now() - 3_600_000), completedAt: new Date(Date.now() - 3_600_000), sizeBytes: 5 },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { assetUrl: streamUrlFor(sub.id), blobUrl: BLOB(sub.id), blobPathname: `review-cuts/${sub.id}.mp4` } });
    await cv.syncEnrollmentVideos({ id: f.enrollmentId, clientId: f.clientId });
    const video = await prisma.contentVideo.findFirstOrThrow({ where: { currentSubmissionId: sub.id } });
    // A released script on the video: "Hook / three points / Close".
    await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, videoId: video.id, title: "First weekend pricing", body: "Your first weekend decides your price.\nPrice it right and buyers compete.\nThat's the whole game.", status: "CLIENT_VISIBLE", releaseState: "released" } });
    const viewer = {
      enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: opts.enrollmentStatus ?? "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth },
      actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "x@example.com", name, membershipId: f.membershipId!, membershipRole: "OWNER" },
      access: opts.enrollmentStatus === "ENDED" ? "READ_ONLY" : "FULL", via: "LOGIN",
    } as PortalViewer;
    return { f, sub: sub.id, video, viewer };
  }
  const approveByClient = async (p: Awaited<ReturnType<typeof program>>) => {
    const row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: p.sub } });
    await prisma.clientDecision.create({ data: { submissionId: p.sub, projectId: p.f.projectId!, videoId: p.video.id, enrollmentId: p.f.enrollmentId, clientId: p.f.clientId, round: 1, contentHash: ce.stableCutIdentity(row), decision: "APPROVE", actorLabel: "client", clientUserId: p.f.clientUserId, membershipRole: "OWNER", receiptState: "DONE" } });
  };
  const draftsOf = (videoId: string) => prisma.contentCaptionDraft.findMany({ where: { videoId }, orderBy: [{ kind: "asc" }, { versionNo: "desc" }] });
  const noteOf = (d: { alternativesJson: string | null }) => { try { return (JSON.parse(d.alternativesJson ?? "{}") as { sourceNote?: string }).sourceNote ?? ""; } catch { return ""; } };

  const ada = await program("Ada Caption TEST", ["DM me PRICE."]);

  // =========================================================================
  c.head("C1 · OLD: the retired captionAssistant drafted on a click with the switch OFF");
  // =========================================================================
  {
    await approveByClient(ada);
    await setSwitch(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-base-"));
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
    const src = execFileSync("git", ["show", `${BASE}:src/lib/captionAssistant.ts`], { cwd: REPO, encoding: "utf8" })
      .replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
    const file = path.join(dir, "captionAssistant.base.ts");
    fs.writeFileSync(file, src);
    const old = (await import(file)) as { draftCaption: (o: { submissionId: string; by: string; unattended: boolean }) => Promise<unknown> };
    next = { captionBody: "Old path caption.", shorterAlternative: "Old.", captionCta: null, ctaOptions: [], coverTitle: null, gaps: [] };
    // The old drafter needs a transcript or a script VERSION on the video; a
    // transcript is lent to it here and taken away again before C3.
    const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: ada.sub } });
    const lent = await prisma.contentCutTranscript.create({ data: { submissionId: ada.sub, contentHash: cutIdentityHash(cut), status: "SUCCEEDED", provider: "drill", text: "Old path transcript." }, select: { id: true } });
    const before = seen.length;
    const r = await old.draftCaption({ submissionId: ada.sub, by: "jordan@drill.invalid", unattended: false }).then(() => "drafted", (e: unknown) => `refused: ${String(e).slice(0, 80)}`);
    await prisma.contentCutTranscript.delete({ where: { id: lent.id } });
    c.ok("OLD: a click drafted with caption_assistant OFF (its own looser gate)", r === "drafted" && seen.length === before + 1, r);
    fs.rmSync(dir, { recursive: true, force: true });
    await prisma.contentCaptionDraft.deleteMany({ where: { videoId: ada.video.id } });
    c.ok("NEW: that module is gone — the posting kit's drafter is the only one", !fs.existsSync(path.join(REPO, "src/lib/captionAssistant.ts")));
    const grep = gitGrep(["-e", "lib/captionAssistant", "--", "src"]);
    c.ok("…and nothing in src/ imports it", grep.length === 0, grep.join(", "));
  }

  // =========================================================================
  c.head("C2 · refused before any model call");
  // =========================================================================
  {
    const before = seen.length;
    const off = await pk.draftCaptionForVideo(ada.viewer, ada.video.id);
    c.ok("switch OFF: refused in plain words", !off.ok && /switched off/.test(off.message), off.message);
    await setSwitch(true);
    const bo = await program("Bo Unapproved TEST", ["DM me PRICE."]);
    const unapproved = await pk.draftCaptionForVideo(bo.viewer, bo.video.id);
    c.ok("not approved by the client: refused with the release rule's reason", !unapproved.ok && unapproved.message === ce.WHY.AWAITING, unapproved.message);
    const cy = await program("Cy Finishing TEST", ["DM me PRICE."]);
    await approveByClient(cy);
    await prisma.topazJob.create({ data: { projectId: cy.f.projectId!, submissionId: cy.sub, state: "processing" } });
    const finishing = await pk.draftCaptionForVideo(cy.viewer, cy.video.id);
    c.ok("approved but still in its 1080p pass (9.6b): refused — being finished", !finishing.ok && finishing.message === ce.WHY.FINISHING, finishing.message);
    const dee = await program("Dee Ended TEST", ["DM me PRICE."], { enrollmentStatus: "ENDED" });
    await approveByClient(dee);
    const ended = await portalDraftCaption({ token: dee.f.portalToken }, dee.video.id);
    c.ok("an ended program: refused at the portal's own door", !ended.ok && /program has ended/i.test(ended.message), ended.message);
    c.ok("ZERO model calls across all four refusals", seen.length === before, `${seen.length - before}`);
    c.ok("…and zero draft rows written", (await prisma.contentCaptionDraft.count({ where: { videoId: { in: [ada.video.id, bo.video.id, cy.video.id, dee.video.id] } } })) === 0);
  }

  // =========================================================================
  c.head("C3 · no transcript: grounded in the script and the strategy, and it says so");
  // =========================================================================
  {
    next = { caption: "Your first weekend sets your price. Price it right and buyers compete.", shorterCaption: "Price it right on day one.", ctaOptions: ["DM me PRICE for your number"], captionCta: "DM me PRICE", coverTitles: ["First weekend"], gaps: [] };
    const before = seen.length;
    const r = await pk.draftCaptionForVideo(ada.viewer, ada.video.id);
    const s = seen[seen.length - 1];
    c.ok("one click, one model call", r.ok && seen.length === before + 1, r.message);
    c.ok("the prompt states there is NO transcript and to keep to the script", /NO TRANSCRIPT OF THE FINAL CUT EXISTS/.test(s.prompt));
    c.ok("the prompt carries the approved script's own lines", s.prompt.includes("Your first weekend decides your price"), s.prompt.slice(s.prompt.indexOf("APPROVED SCRIPT"), s.prompt.indexOf("APPROVED SCRIPT") + 300));
    c.ok("…the strategy's brand message and goals", s.prompt.includes("Plan the sale before the sign goes up.") && s.prompt.includes("Build trust with sellers before they list"));
    c.ok("…and its Caption CTA Examples", s.system.includes("DM me PRICE.") && /CAPTION CTA EXAMPLES FROM THE APPROVED STRATEGY/.test(s.system));
    const rows = await draftsOf(ada.video.id);
    c.ok("drafts saved (caption, short, CTA, cover title)", rows.length === 4, rows.map((d) => d.kind).join(","));
    c.ok("EVERY row says it was drafted from the script, with no transcript", rows.every((d) => /^Drafted from the script — no transcript yet/.test(noteOf(d))), noteOf(rows[0]));
    c.ok("every row is tied to the entitled cut", rows.every((d) => d.submissionId === ada.sub));
    c.ok("the caller is told the same, in the message", /Drafted from the script — no transcript yet/.test(r.message));
    const kit = await pk.postingKitFor(ada.viewer, ada.video);
    c.ok("the posting kit shows the client that note", kit.captions.some((x) => /no transcript yet/.test(x.sourceNote ?? "")));
    c.ok("…and the transcript gap in its own words", !kit.transcript.text && !!kit.transcript.gap, kit.transcript.gap ?? "");
  }

  // =========================================================================
  c.head("C4 · a transcript of THIS cut is the primary source");
  // =========================================================================
  {
    const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: ada.sub } });
    await prisma.contentCutTranscript.create({ data: { submissionId: ada.sub, contentHash: cutIdentityHash(cut), status: "SUCCEEDED", provider: "drill", text: "Your first weekend on market decides your price. Get it right and buyers compete for it." } });
    next = { caption: "The first weekend decides it.", shorterCaption: null, ctaOptions: [], captionCta: null, coverTitles: [], gaps: [] };
    const r = await pk.draftCaptionForVideo(ada.viewer, ada.video.id);
    const s = seen[seen.length - 1];
    c.ok("the prompt leads with the transcript as the primary factual source", /TRANSCRIPT OF THE FINAL CUT \(primary factual source/.test(s.prompt) && s.prompt.includes("buyers compete for it"));
    c.ok("…and no longer claims there is none", !/NO TRANSCRIPT OF THE FINAL CUT EXISTS/.test(s.prompt));
    const newest = (await draftsOf(ada.video.id)).find((d) => d.kind === "CAPTION");
    c.ok("the new caption says it was drafted from the transcript", r.ok && /^Drafted from the transcript of the final cut/.test(noteOf(newest!)), noteOf(newest!));
    c.ok("…and records which transcript", !!newest?.transcriptId);
  }

  // =========================================================================
  c.head("C5 · a strategy with no offers: invented offers never reach a draft");
  // =========================================================================
  {
    const eve = await program("Eve NoOffer TEST", []);
    await approveByClient(eve);
    next = { caption: "Pricing is a first-weekend decision.", shorterCaption: null, ctaOptions: ["Grab my free pricing guide", "Save this for listing day", "Download the seller checklist"], captionCta: "Get your free checklist", coverTitles: [], gaps: [] };
    const r = await pk.draftCaptionForVideo(eve.viewer, eve.video.id);
    const s = seen[seen.length - 1];
    c.ok("the prompt tells the model the strategy names NO offers", /The strategy names NO offers/.test(s.prompt));
    const cta = (await draftsOf(eve.video.id)).find((d) => d.kind === "CTA");
    const opts = (JSON.parse(cta?.alternativesJson ?? "{}") as { options?: string[] }).options ?? [];
    c.ok("the saved CTA is the plain engagement ask, not an invented offer", r.ok && cta?.body === "Save this for listing day", cta?.body ?? "(none)");
    c.ok("no saved option offers a guide, checklist or download", !opts.some((o) => /free|guide|checklist|download/i.test(o)), JSON.stringify(opts));
  }

  // =========================================================================
  c.head("C6 · nothing drafts unattended");
  // =========================================================================
  {
    const callers = gitGrep(["draftCaptionForVideo", "--", "src"]).sort();
    c.ok("the drafter is called only from the portal's click action", JSON.stringify(callers) === JSON.stringify(["src/app/portal/actions.ts", "src/lib/postingKit.ts"]), callers.join(", "));
    const cron = gitGrep(["-i", "caption", "--", "src/app/api/cron"]);
    c.ok("no cron route mentions captions at all", cron.length === 0, cron.join(", "));
    const runs = await prisma.programAiRun.findMany({ where: { kind: "caption" }, select: { requestedBy: true } });
    c.ok("every caption run on record was requested by a person, never 'cron'", runs.length > 0 && runs.every((x) => x.requestedBy !== "cron"), JSON.stringify(runs.map((x) => x.requestedBy)));
  }

  c.head("Z · isolation");
  c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
