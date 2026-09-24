import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { runAiJson, setRunOutputRef, sha256, AutomationDisabledError } from "@/lib/aiRuns";
import { transcriptForCut, cutIdentityHash } from "@/lib/cutTranscripts";
import { buildClientContext } from "@/lib/contentGeneration";
import { canonicalFromParts, pointsFromJson } from "@/lib/contentScripts";
import { buildCaptionPrompt, type Gap } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// CAPTION ASSISTANT (spec §10) — W2-F, Sep 17 2026.
//
// Drafts the caption, a shorter alternative, CTA options and an optional
// cover title for ONE cut. Inputs, in order of authority:
//   1. the transcript OF THIS CUT'S BYTES (cutTranscripts.transcriptForCut) —
//      the primary factual source. Tonight no speech-to-text provider is
//      configured (W1-D), so it is a gap, and the gap is carried on the draft
//      in words: "Drafted from the script — no transcript of the final cut
//      yet." A caption must never claim what the final video no longer says,
//      so a missing transcript is stated, not papered over;
//   2. the APPROVED strategy version (positioning, audience, its own Caption
//      CTA Examples) through the policy's buildCaptionPrompt;
//   3. the linked script version as supporting context.
//
// CTAs fit the client's actual offer: options are limited to what the
// strategy's own CTA examples support plus plain engagement asks. An option
// that invents a lead magnet ("free checklist", "download the guide") when
// the strategy names none is dropped before it is saved.
//
// Every call is a ProgramAiRun (kind "caption"). Every result is a NEW
// ContentCaptionDraft row (versionNo +1, basedOnId = the previous draft), so
// regeneration never overwrites a person's edit; an edit is its own row too.
// Drafts pin the cut (submissionId + contentHash of its bytes), the
// strategy version and the script version they were built on, and go STALE
// when the cut changes (markCaptionDraftsStale, called by the review hook).
//
// Gate: an UNATTENDED run (cron, a job) needs `caption_assistant` ON — missing
// row = off. A staff or client button is a user action and is allowed while
// the switch is off (still gated by ai_runs quotas and logged).
// Nothing here publishes anything.
//
// NOTE (CP-01, Sep 24 2026): nothing imports this module today — the portal's
// "Draft a caption" is postingKit.draftCaptionForVideo, which is gated by the
// switch even for a click. The paragraph above describes THIS file only. And
// whichever path runs, a caption is drafted only for a cut the client may
// have (cutEntitlement.cutDownloadableFor) — never an unapproved review cut.
// ---------------------------------------------------------------------------

export const CAPTION_KEY = "caption_assistant" as const;
export const NO_TRANSCRIPT_GAP = "Drafted from the script — no transcript of the final cut yet. Check every claim against the video before posting.";

// Words that mean "an offer the video promised" — never introduced by a caption.
const INVENTED_OFFER = /\b(free|download|guide|checklist|e-?book|template|webinar|workbook|cheat ?sheet|giveaway|discount|coupon)\b/i;

export type CaptionOutput = {
  captionBody: string;
  shorterAlternative: string;
  captionCta: string | null;
  ctaOptions: string[];
  coverTitle: string | null;
  gaps: Gap[];
};

export type DraftCaptionOpts = {
  submissionId: string;
  /** staff email, client user id, or "cron". */
  by: string;
  /** true for a job/cron — gated by caption_assistant. false = a person clicked. */
  unattended: boolean;
  /** Regenerate from a previous draft (history link); the previous row is untouched. */
  regenerateOfId?: string | null;
  authorKind?: "AI";
};

export type DraftCaptionResult = {
  runId: string;
  drafts: { id: string; kind: string; versionNo: number; body: string }[];
  transcript: { used: boolean; source: "provider" | "corrected" | null; gap: string | null };
  scriptVersionId: string | null;
  strategyVersionId: string | null;
  contentHash: string;
  costCents: number;
};

async function cutContext(submissionId: string) {
  const cut = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, contentHash: true, blobUrl: true, blobPathname: true, sizeBytes: true, fileName: true, videoId: true, withdrawnAt: true, round: true },
  });
  if (!cut) throw new Error("That cut no longer exists.");
  if (cut.withdrawnAt) throw new Error("That cut was withdrawn — pick the current one.");
  const project = await prisma.project.findUnique({ where: { id: cut.projectId }, select: { clientId: true, contentMonthId: true } });
  if (!project) throw new Error("The cut's project no longer exists.");
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { clientId: project.clientId }, select: { id: true, clientId: true, status: true } });
  if (!enrollment) throw new Error("This client is not in the content program.");
  // The logical video: the cut's own pointer first, else the video that lists this cut.
  const video = cut.videoId
    ? await prisma.contentVideo.findUnique({ where: { id: cut.videoId } })
    : await prisma.contentVideo.findFirst({ where: { enrollmentId: enrollment.id, OR: [{ currentSubmissionId: cut.id }, { approvedSubmissionId: cut.id }, { finalSubmissionId: cut.id }] } });
  if (!video) throw new Error("This cut is not linked to a program video yet (My Videos sync) — link it first so the caption has a video to belong to.");
  return { cut, project, enrollment, video, hash: cutIdentityHash(cut) };
}

/** The script version behind a video: the filmed version, else the script's shared → approved → current one. */
async function scriptVersionFor(video: { scriptVersionId: string | null; scriptId: string | null }) {
  if (video.scriptVersionId) return prisma.contentScriptVersion.findUnique({ where: { id: video.scriptVersionId } });
  if (!video.scriptId) return null;
  const s = await prisma.contentScript.findUnique({ where: { id: video.scriptId }, select: { sharedVersionId: true, approvedVersionId: true, currentVersionId: true } });
  const id = s?.sharedVersionId ?? s?.approvedVersionId ?? s?.currentVersionId ?? null;
  return id ? prisma.contentScriptVersion.findUnique({ where: { id } }) : null;
}

export async function draftCaption(o: DraftCaptionOpts): Promise<DraftCaptionResult> {
  if (o.unattended && !(await isAutomationEnabled(CAPTION_KEY))) throw new AutomationDisabledError("The caption assistant is switched off for unattended runs (Settings → Automations). A person can still click Draft.");
  const { cut, project, enrollment, video, hash } = await cutContext(o.submissionId);
  const { cutDownloadableFor } = await import("@/lib/cutEntitlement");
  if (!(await cutDownloadableFor({ id: enrollment.id, clientId: enrollment.clientId }, cut.id))) {
    throw new Error("This cut isn't the client's approved (or delivered) version, so it has no caption yet — captions unlock with the client's approval.");
  }
  const [transcript, sv, built] = await Promise.all([
    transcriptForCut(cut.id),
    scriptVersionFor(video),
    buildClientContext(enrollment.id, { monthId: video.monthId ?? project.contentMonthId ?? null, projectId: cut.projectId }),
  ]);
  if (!transcript.text && !sv) throw new Error("Nothing to draft from: this cut has no transcript and no linked script. Link the script (Video Topics → Scripts) or request a transcript first.");

  // The policy prompt (strategy + script), then this cut's transcript block on top.
  const canonical = sv
    ? canonicalFromParts({ title: sv.title, categoryLabel: sv.categoryLabel, pillarId: sv.pillarId, hook: sv.hook, points: pointsFromJson(sv.pointsJson), close: sv.close, captionCta: sv.captionCta, filmingNotes: sv.filmingNotes, goal: sv.goal }, enrollment.clientId)
    : canonicalFromParts({ title: video.title ?? "Untitled video", hook: "", points: [], close: "", captionCta: null }, enrollment.clientId);
  const bundle = buildCaptionPrompt(built.ctx, canonical);
  const hasExamples = (built.ctx.strategy?.document?.captionCtaExamples?.items ?? []).length > 0;
  const transcriptBlock = transcript.text
    ? `FINAL CUT TRANSCRIPT (${transcript.source === "corrected" ? "human-corrected" : "machine"} — THE PRIMARY FACTUAL SOURCE; where it and the script differ, the transcript wins):\n${transcript.text.slice(0, 20_000)}`
    : `NO TRANSCRIPT OF THE FINAL CUT EXISTS (${transcript.gap ?? "not requested"}). Draft from the script only. Do not state anything the script does not state. Mark the draft as drafted from the script.`;
  const ctaRule = hasExamples
    ? "CTA OPTIONS: at most three, each modelled on the approved strategy's Caption CTA Examples or a plain engagement ask (save, share, comment, a question). Never invent an offer, a lead magnet or a resource the strategy does not name."
    : "CTA OPTIONS: at most three PLAIN ENGAGEMENT asks (save this, share with someone who needs it, a question in the comments, 'reach out if you'd like to talk it through'). The strategy names NO offers, so no free guides, checklists, downloads or discounts may appear.";
  const user = [bundle.user, "", transcriptBlock, "", ctaRule, "", "Also give a SHORTER ALTERNATIVE caption (one sentence) and an optional COVER TITLE (≤ 6 words, or null)."].join("\n");
  const schema = {
    type: "object",
    required: ["captionBody", "shorterAlternative", "captionCta", "ctaOptions", "coverTitle", "gaps"],
    properties: {
      captionBody: { type: "string" },
      shorterAlternative: { type: "string" },
      captionCta: { type: ["string", "null"] },
      ctaOptions: { type: "array", items: { type: "string" }, maxItems: 3 },
      coverTitle: { type: ["string", "null"] },
      gaps: (bundle.outputSchema as { properties?: { gaps?: unknown } }).properties?.gaps ?? { type: "array", items: { type: "object" } },
    },
  } as Record<string, unknown>;

  const run = await runAiJson<CaptionOutput>({
    kind: "caption", enrollmentId: enrollment.id, clientId: enrollment.clientId,
    scope: { submissionId: cut.id, videoId: video.id, projectId: cut.projectId },
    inputRefs: { ...built.inputRefs, cutHash: hash, transcriptId: transcript.transcriptId, transcriptHash: transcript.text ? sha256(transcript.text) : null, scriptVersionId: sv?.id ?? null, regenerateOfId: o.regenerateOfId ?? null },
    promptKey: "caption", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId,
    requestedBy: o.by, unattended: o.unattended, dedupeKey: `caption:${cut.id}`,
    system: bundle.system, prompt: user, schema, maxTokens: 2_000,
  });
  const out = run.output;
  // Post-process: no invented offers, ever — regardless of what the model wrote.
  const ctaOptions = (Array.isArray(out.ctaOptions) ? out.ctaOptions : []).map((s) => String(s).trim()).filter((s) => s && (hasExamples || !INVENTED_OFFER.test(s))).slice(0, 3);
  const captionCta = out.captionCta && (hasExamples || !INVENTED_OFFER.test(out.captionCta)) ? out.captionCta.trim() : null;
  const gaps: Gap[] = Array.isArray(out.gaps) ? out.gaps : [];
  const gapNote = transcript.text ? null : NO_TRANSCRIPT_GAP;

  const meta = {
    videoId: video.id, submissionId: cut.id, enrollmentId: enrollment.id, clientId: enrollment.clientId,
    transcriptId: transcript.transcriptId, scriptVersionId: sv?.id ?? null, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: run.runId,
    authorKind: "AI", staffUserId: o.by.includes("@") ? o.by : null, contentHash: hash, status: "DRAFT",
  };
  const shared = { gapNote, gaps, transcriptSource: transcript.source, transcriptGap: transcript.gap };
  const drafts: DraftCaptionResult["drafts"] = [];
  const save = async (kind: string, body: string, alternatives: Record<string, unknown>) => {
    if (!body.trim()) return;
    const last = await prisma.contentCaptionDraft.findFirst({ where: { videoId: video.id, kind }, orderBy: { versionNo: "desc" }, select: { versionNo: true, id: true } });
    const row = await prisma.contentCaptionDraft.create({
      data: { ...meta, kind, body: body.trim(), alternativesJson: JSON.stringify({ ...shared, ...alternatives }), versionNo: (last?.versionNo ?? 0) + 1, basedOnId: o.regenerateOfId ?? last?.id ?? null },
      select: { id: true, kind: true, versionNo: true, body: true },
    });
    drafts.push(row);
  };
  await save("CAPTION", gapNote ? `${out.captionBody.trim()}\n\n[${gapNote}]` : out.captionBody, { captionCta, shorterAlternative: out.shorterAlternative, ctaOptions, coverTitle: out.coverTitle ?? null });
  await save("SHORT_CAPTION", out.shorterAlternative ?? "", { captionCta });
  if (ctaOptions.length || captionCta) await save("CTA", captionCta ?? ctaOptions[0], { options: ctaOptions });
  if (out.coverTitle) await save("COVER_TITLE", out.coverTitle, {});
  await setRunOutputRef(run.runId, drafts.length ? `ContentCaptionDraft:${drafts[0].id}` : "ContentCaptionDraft:none");
  return { runId: run.runId, drafts, transcript: { used: !!transcript.text, source: transcript.source, gap: gapNote ?? transcript.gap }, scriptVersionId: sv?.id ?? null, strategyVersionId: built.strategyVersionId, contentHash: hash, costCents: run.costCents };
}

/** A person's edit: a NEW row (versionNo +1) based on the one they edited. The AI row is untouched. */
export async function editCaptionDraft(draftId: string, body: string, by: { kind: "STAFF" | "CLIENT"; id: string }): Promise<{ id: string; versionNo: number }> {
  const prev = await prisma.contentCaptionDraft.findUnique({ where: { id: draftId } });
  if (!prev) throw new Error("Draft not found.");
  const text = body.trim();
  if (!text) throw new Error("A caption cannot be empty.");
  const last = await prisma.contentCaptionDraft.findFirst({ where: { videoId: prev.videoId, kind: prev.kind }, orderBy: { versionNo: "desc" }, select: { versionNo: true } });
  const row = await prisma.contentCaptionDraft.create({
    data: {
      videoId: prev.videoId, submissionId: prev.submissionId, enrollmentId: prev.enrollmentId, clientId: prev.clientId, transcriptId: prev.transcriptId, scriptVersionId: prev.scriptVersionId,
      strategyVersionId: prev.strategyVersionId, policyVersionId: prev.policyVersionId, kind: prev.kind, body: text, alternativesJson: prev.alternativesJson,
      versionNo: (last?.versionNo ?? 0) + 1, basedOnId: prev.id, authorKind: by.kind, staffUserId: by.kind === "STAFF" ? by.id : null, clientUserId: by.kind === "CLIENT" ? by.id : null,
      contentHash: prev.contentHash, status: "DRAFT",
    },
    select: { id: true, versionNo: true },
  });
  return row;
}

/** Choose the draft for the posting kit. Other drafts of that kind stay as history (not archived). */
export async function chooseCaptionDraft(draftId: string, by: string): Promise<void> {
  const d = await prisma.contentCaptionDraft.findUnique({ where: { id: draftId }, select: { videoId: true, kind: true, status: true } });
  if (!d) throw new Error("Draft not found.");
  if (d.status === "STALE") throw new Error("This draft is stale — the cut changed after it was written. Regenerate first.");
  await prisma.contentCaptionDraft.updateMany({ where: { videoId: d.videoId, kind: d.kind, status: "CHOSEN" }, data: { status: "DRAFT", chosenAt: null, chosenBy: null } });
  await prisma.contentCaptionDraft.update({ where: { id: draftId }, data: { status: "CHOSEN", chosenAt: new Date(), chosenBy: by } });
}

/** The cut changed (a new round, new bytes): every draft of the old bytes is STALE. HANDOVER: call from the review-round hook. */
export async function markCaptionDraftsStale(videoId: string, currentSubmissionId: string, reason = "cut changed"): Promise<number> {
  const cut = await prisma.reviewSubmission.findUnique({ where: { id: currentSubmissionId }, select: { id: true, contentHash: true, blobUrl: true, blobPathname: true, sizeBytes: true, fileName: true } });
  const hash = cut ? cutIdentityHash(cut) : null;
  const r = await prisma.contentCaptionDraft.updateMany({
    where: { videoId, status: { in: ["DRAFT", "CHOSEN"] }, ...(hash ? { NOT: { contentHash: hash } } : {}) },
    data: { status: "STALE", staleReason: reason },
  });
  return r.count;
}

export type CaptionDraftView = { id: string; kind: string; versionNo: number; body: string; authorKind: string; status: string; staleReason: string | null; createdAt: Date; basedOnId: string | null; alternatives: Record<string, unknown>; gapNote: string | null };

export async function captionDraftsFor(videoId: string): Promise<CaptionDraftView[]> {
  const rows = await prisma.contentCaptionDraft.findMany({ where: { videoId }, orderBy: [{ kind: "asc" }, { versionNo: "desc" }] });
  return rows.map((r) => {
    let alt: Record<string, unknown> = {};
    try { alt = JSON.parse(r.alternativesJson ?? "{}") as Record<string, unknown>; } catch { alt = {}; }
    return { id: r.id, kind: r.kind, versionNo: r.versionNo, body: r.body, authorKind: r.authorKind, status: r.status, staleReason: r.staleReason, createdAt: r.createdAt, basedOnId: r.basedOnId, alternatives: alt, gapNote: typeof alt.gapNote === "string" ? alt.gapNote : null };
  });
}
