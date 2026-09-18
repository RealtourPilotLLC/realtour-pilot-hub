import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { cutIdentityHash, transcriptForCut } from "@/lib/cutTranscripts";
import { canonicalFromParts, partsFromBody, pointsFromJson } from "@/lib/contentScripts";
import { renderScript, buildCaptionPrompt, type CanonicalScript } from "@/lib/contentPolicy";
import { videoForEnrollment } from "@/lib/contentVideos";
import { actorLabel } from "@/lib/portalAccess";
import { streamUrlFor } from "@/lib/reviewCuts";
import { CLIENT_VISIBLE_SCRIPT, type PortalViewer } from "@/lib/portal";
import { clip, stripMoneySentences } from "@/lib/text";

// ---------------------------------------------------------------------------
// THE POSTING KIT (spec §10, Sep 17 2026). Per video: the final file (which
// one, which version, and whether the bytes still match the approval), an
// editable caption draft, the cover asset when one exists, the script and the
// transcript it could be drafted from — and two CLIENT-RECORDED facts,
// "Downloaded" and "Marked as posted by me", that are never a verified
// publication (that is §12's job and it is disabled).
//
// Caption drafting: never unattended from the portal. A client's "Draft a
// caption" runs only when `caption_assistant` is ON (a missing row is OFF,
// programAutomation.ts) and it is a person's click (unattended:false), so the
// ai_runs master switch does not gate it but the feature switch does. When
// transcriptForCut reports a gap the draft is made from the script and the
// kit says so in plain words — it never pretends a transcript existed.
// ---------------------------------------------------------------------------

export type CaptionView = {
  id: string;
  kind: string; // CAPTION | SHORT_CAPTION | CTA | COVER_TITLE
  body: string;
  alternatives: string[];
  versionNo: number;
  authorKind: string; // AI | CLIENT | STAFF
  status: string; // DRAFT | CHOSEN | ARCHIVED | STALE
  staleReason: string | null;
  basedOnId: string | null;
  createdAtISO: string;
  /** What the draft was made from — plain words for the client. */
  sourceNote: string | null;
};

export type FinalFile = {
  kind: "cut" | "delivered";
  /** Raw URL: a hub stream URL (the page mints the media token) or an Aryeo CDN file. */
  url: string;
  submissionId: string | null;
  fileName: string | null;
  label: string; // "v2 (final, approved by Cara TEST on Sep 17)"
  approvedByLabel: string | null;
  approvedAtISO: string | null;
  /** The bytes behind the approval still match. False = do not serve under that approval. */
  hashOk: boolean;
};

export type PostingKit = {
  videoId: string;
  title: string;
  final: FinalFile | null;
  /** Why there is no final file yet (client-safe). */
  finalNote: string | null;
  cover: string | null;
  captions: CaptionView[];
  transcript: { text: string | null; gap: string | null; source: string | null };
  /** `historical` = an imported record we hold, shown as history — never re-labelled as this video’s script. */
  script: { title: string; body: string; versionLabel: string | null; strategyLabel: string | null; historical: boolean } | null;
  postedAtISO: string | null;
  downloadedAtISO: string | null;
  assistant: { enabled: boolean; why: string | null };
};

const DOWNLOAD_PATH = (videoId: string) => `/portal/download/${videoId}`;

async function approvalFor(submissionId: string | null): Promise<{ label: string; atISO: string; contentHash: string | null } | null> {
  if (!submissionId) return null;
  const d = await prisma.clientDecision.findFirst({ where: { submissionId, decision: "APPROVE" }, orderBy: { decidedAt: "desc" }, select: { actorLabel: true, decidedAt: true, contentHash: true } });
  return d ? { label: d.actorLabel, atISO: d.decidedAt.toISOString(), contentHash: d.contentHash } : null;
}

/**
 * Which file is "the final" for this video, and whether it may be served.
 * Order: the completed (Dropbox-copied) cut, else the client-approved cut,
 * else the delivered Aryeo file. A cut is served under an approval ONLY when
 * its current identity hash equals the hash recorded on that approval —
 * "never silently serve a different file under an old approval" (§8).
 */
export async function resolveFinalFile(video: { id: string; finalSubmissionId: string | null; approvedSubmissionId: string | null; currentSubmissionId: string | null }): Promise<{ final: FinalFile | null; note: string | null }> {
  const cutId = video.finalSubmissionId ?? video.approvedSubmissionId;
  if (cutId) {
    const sub = await prisma.reviewSubmission.findUnique({ where: { id: cutId }, select: { id: true, round: true, fileName: true, assetUrl: true, assetPath: true, contentHash: true, blobUrl: true, blobPathname: true, sizeBytes: true, completedAt: true } });
    // assetUrl is the STABLE playback address, not proof there are bytes behind
    // it. A cut whose file was moved or withdrawn (the Sep 17 Topaz
    // remediation moved a silent render out of the Final folder) keeps its
    // assetUrl and its approval, so the button rendered and the stream answered
    // raw JSON with a 404 in the client's tab (review, Sep 17). A final needs a
    // file: Dropbox path or hub copy.
    if (sub?.assetUrl && (sub.assetPath || sub.blobUrl)) {
      const approval = await approvalFor(video.approvedSubmissionId === sub.id ? sub.id : null);
      const hashOk = !approval?.contentHash || approval.contentHash === cutIdentityHash(sub);
      const label = `v${sub.round}${sub.completedAt ? " (final)" : approval ? " (approved)" : ""}`;
      return {
        final: { kind: "cut", url: sub.assetUrl ?? streamUrlFor(sub.id), submissionId: sub.id, fileName: sub.fileName, label, approvedByLabel: approval?.label ?? null, approvedAtISO: approval?.atISO ?? null, hashOk },
        note: hashOk ? null : "The file behind your approval has changed since you approved it — we're re-issuing it for approval before it can be downloaded.",
      };
    }
  }
  const delivered = await prisma.contentVideoSource.findFirst({ where: { videoId: video.id, kind: "PORTAL_VIDEO", isFinal: true }, select: { portalVideoId: true, label: true } });
  const row = delivered?.portalVideoId ? await prisma.portalVideo.findUnique({ where: { id: delivered.portalVideoId }, select: { download: true, playback: true, title: true } }) : null;
  if (row?.download || row?.playback) {
    return { final: { kind: "delivered", url: (row.download ?? row.playback)!, submissionId: null, fileName: row.title, label: "Delivered file", approvedByLabel: null, approvedAtISO: null, hashOk: true }, note: null };
  }
  // Told apart on purpose: "the file we had is not there" is not the same news
  // as "there is no file yet", and only one of them needs someone to act.
  if (cutId) return { final: null, note: "We're re-issuing this video's file — it'll be back here shortly. Text us if you need it now." };
  return { final: null, note: video.currentSubmissionId ? "The final file lands here once this version is approved and finished." : "No file yet — it appears here once the video is edited and delivered." };
}

export type ScriptVisibility = "released" | "historical";

/**
 * May a CLIENT read this script, and in what character? This is the portal's
 * ONE script-visibility rule — every surface that shows a client a script calls
 * THIS FUNCTION, because a second gate is a gate that drifts.
 *
 * That sentence was aspirational until Sep 18: `scriptForEnrollment` was still
 * running its own `CLIENT_VISIBLE_SCRIPT.includes(status)` test and
 * `portalInterview` had grown a third one inline. Both now call here. The
 * callers, so the next reader can check the claim rather than trust it:
 *   · postingKit.scriptForVideo    — the script behind one video
 *   · portal.visibleTopicScripts   — the script under one topic (bank + interview)
 *   · portal.scriptForEnrollment   — the write gate on "suggest a change"
 *
 * `releaseState` is authoritative wherever production has written it:
 * approveScript writes "withheld" (approved internally, NOT shared),
 * shareScript writes "released", the import backfill writes "historical".
 * A null releaseState is pre-CPOS data and is judged by status alone.
 */
export function scriptVisibility(s: { status: string; releaseState: string | null; historical: boolean }): ScriptVisibility | null {
  if (s.releaseState === "withheld") return null;
  if (s.releaseState === "released") return "released";
  // Imported scripts are HISTORY (Jordan's ruling) — visible, never re-labelled
  // as this video's script.
  if (s.releaseState === "historical" || s.historical) return "historical";
  return CLIENT_VISIBLE_SCRIPT.includes(s.status) ? "released" : null;
}

/**
 * The script behind one video, gated. Candidates are the script the video
 * names, the script filed against the video, and the script on its topic —
 * all scoped to the enrollment, so another client's script can never be a
 * candidate at all. A released script always outranks a historical one; within
 * the same character the closest link wins.
 */
async function scriptForVideo(video: { id: string; topicId: string | null; scriptId: string | null; scriptVersionId: string | null; enrollmentId: string }): Promise<{ canonical: CanonicalScript; title: string; body: string; versionLabel: string | null; strategyLabel: string | null; clientId: string; historical: boolean } | null> {
  const candidates = await prisma.contentScript.findMany({
    where: { enrollmentId: video.enrollmentId, OR: [{ id: video.scriptId ?? "-" }, { videoId: video.id }, ...(video.topicId ? [{ topicId: video.topicId }] : [])] },
    orderBy: { updatedAt: "desc" },
  });
  const linkRank = (s: { id: string; videoId: string | null }) => (s.id === video.scriptId ? 0 : s.videoId === video.id ? 1 : 2);
  const visible = candidates
    .map((s) => ({ s, vis: scriptVisibility(s) }))
    .filter((c): c is { s: (typeof candidates)[number]; vis: ScriptVisibility } => c.vis !== null)
    .sort((a, b) => (a.vis === b.vis ? linkRank(a.s) - linkRank(b.s) : a.vis === "released" ? -1 : 1));
  const picked = visible[0];
  if (!picked) return null;
  const script = picked.s;
  const historical = picked.vis === "historical";

  // The words: the version actually RELEASED to the portal first, then the
  // approved one. The version this video names is used only when it belongs to
  // the script that passed the gate — an unshared draft is never the client's
  // copy just because a production row points at it.
  const releasedId = script.sharedVersionId ?? script.approvedVersionId ?? null;
  let v = releasedId ? await prisma.contentScriptVersion.findUnique({ where: { id: releasedId } }) : null;
  if (!v && video.scriptVersionId) v = await prisma.contentScriptVersion.findFirst({ where: { id: video.scriptVersionId, scriptId: script.id } });

  const strategyId = v?.strategyVersionId ?? script.strategyVersionId ?? null;
  const strategy = strategyId ? await prisma.contentStrategyVersion.findUnique({ where: { id: strategyId }, select: { versionNo: true } }) : null;
  if (v) {
    const canonical = canonicalFromParts({ title: v.title, categoryLabel: v.categoryLabel, pillarId: v.pillarId, hook: v.hook, points: pointsFromJson(v.pointsJson), close: v.close, captionCta: v.captionCta }, v.clientId);
    return { canonical, title: v.title, body: renderScript(canonical), versionLabel: `v${v.versionNo}`, strategyLabel: strategy ? `v${strategy.versionNo}` : null, clientId: v.clientId, historical };
  }
  const canonical = canonicalFromParts(partsFromBody(script.title, script.body), script.clientId);
  return { canonical, title: script.title, body: script.body, versionLabel: null, strategyLabel: strategy ? `v${strategy.versionNo}` : null, clientId: script.clientId, historical };
}

const captionView = (c: { id: string; kind: string; body: string; alternativesJson: string | null; versionNo: number; authorKind: string; status: string; staleReason: string | null; basedOnId: string | null; createdAt: Date }): CaptionView => {
  let alternatives: string[] = [];
  let sourceNote: string | null = null;
  try {
    const parsed = c.alternativesJson ? (JSON.parse(c.alternativesJson) as { options?: string[]; sourceNote?: string } | string[]) : null;
    if (Array.isArray(parsed)) alternatives = parsed.filter((x): x is string => typeof x === "string");
    else if (parsed) { alternatives = (parsed.options ?? []).filter((x): x is string => typeof x === "string"); sourceNote = parsed.sourceNote ?? null; }
  } catch { /* unreadable alternatives are just none */ }
  return { id: c.id, kind: c.kind, body: c.body, alternatives, versionNo: c.versionNo, authorKind: c.authorKind, status: c.status, staleReason: c.staleReason, basedOnId: c.basedOnId, createdAtISO: c.createdAt.toISOString(), sourceNote };
};

/** The kit for one of the viewer's videos (ownership already proven by the caller). */
export async function postingKitFor(viewer: PortalViewer, video: NonNullable<Awaited<ReturnType<typeof videoForEnrollment>>>): Promise<PostingKit> {
  const { final, note } = await resolveFinalFile(video);
  const kitSubmissionId = final?.submissionId ?? video.approvedSubmissionId ?? video.currentSubmissionId ?? null;
  const [captions, transcript, script, lastDownload, cover, assistantOn] = await Promise.all([
    prisma.contentCaptionDraft.findMany({ where: { videoId: video.id, enrollmentId: viewer.enrollment.id, status: { not: "ARCHIVED" } }, orderBy: [{ kind: "asc" }, { versionNo: "desc" }] }),
    kitSubmissionId ? transcriptForCut(kitSubmissionId).catch(() => ({ text: null, source: null, gap: "The transcript couldn't be read just now.", transcriptId: null, contentHash: null, language: null })) : Promise.resolve({ text: null, source: null, gap: "No cut of this video is on file, so there is no transcript.", transcriptId: null, contentHash: null, language: null }),
    scriptForVideo(video).catch(() => null),
    prisma.portalVisit.findFirst({ where: { enrollmentId: viewer.enrollment.id, path: { startsWith: DOWNLOAD_PATH(video.id) } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.contentVideoSource.findFirst({ where: { videoId: video.id, kind: "PORTAL_VIDEO" }, select: { portalVideoId: true } }).then(async (s) => (s?.portalVideoId ? (await prisma.portalVideo.findUnique({ where: { id: s.portalVideoId }, select: { thumb: true } }))?.thumb ?? null : null)),
    isAutomationEnabled("caption_assistant"),
  ]);
  // Any AI draft tied to a cut that is no longer the final is STALE (spec §10):
  // stamp it rather than serving it as if it described the current file.
  const stale = captions.filter((c) => c.status !== "STALE" && kitSubmissionId && c.submissionId !== kitSubmissionId && !c.submissionId.startsWith("portal-video:"));
  if (stale.length) {
    await prisma.contentCaptionDraft.updateMany({ where: { id: { in: stale.map((c) => c.id) } }, data: { status: "STALE", staleReason: "cut changed" } }).catch(() => {});
    for (const c of stale) { c.status = "STALE"; c.staleReason = "cut changed"; }
  }
  return {
    videoId: video.id,
    title: video.title ?? "Video",
    final, finalNote: note, cover,
    captions: captions.map(captionView),
    transcript: { text: transcript.text ? stripMoneySentences(transcript.text) : null, gap: transcript.gap, source: transcript.source },
    script: script ? { title: script.title, body: stripMoneySentences(script.body), versionLabel: script.versionLabel, strategyLabel: script.strategyLabel, historical: script.historical } : null,
    postedAtISO: video.postedByClientAt?.toISOString() ?? null,
    downloadedAtISO: lastDownload?.createdAt.toISOString() ?? null,
    assistant: { enabled: assistantOn, why: assistantOn ? null : "Caption drafting is switched off until the program launches — we'll write your caption with the script for now, or you can write one below." },
  };
}

type R = { ok: boolean; message: string };

/** "Marked as posted by me" — a client-recorded fact, never a verified publication. */
export async function setPostedByClient(viewer: PortalViewer, videoId: string, posted: boolean): Promise<R> {
  const v = await videoForEnrollment(viewer.enrollment, videoId);
  if (!v) return { ok: false, message: "That video isn't on your page." };
  await prisma.contentVideo.update({ where: { id: v.id }, data: { postedByClientAt: posted ? new Date() : null } });
  // Who said so is the visit row (PortalVisit carries the person / staff id); the video keeps the when.
  await prisma.portalVisit.create({ data: { enrollmentId: viewer.enrollment.id, clientUserId: viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : null, staffUserId: viewer.actor.kind === "STAFF" ? viewer.actor.staffUserId : null, via: viewer.via, path: `/portal/posted/${v.id}${posted ? "" : "?undo=1"}` } }).catch(() => {});
  return { ok: true, message: posted ? "Marked as posted by you. (We don't check the platform — this is your note to yourself and to us.)" : "Unmarked." };
}

/** Record a download as a client fact: a PortalVisit row on the download path, attributable to the person or staff. */
export async function recordDownload(scope: { enrollmentId: string; clientUserId: string | null; staffUserId: string | null; via: "TOKEN" | "LOGIN" | "STAFF" }, videoId: string, submissionId: string | null): Promise<void> {
  await prisma.portalVisit.create({ data: { enrollmentId: scope.enrollmentId, clientUserId: scope.clientUserId, staffUserId: scope.staffUserId, via: scope.via, path: `${DOWNLOAD_PATH(videoId)}${submissionId ? `?cut=${submissionId}` : ""}` } }).catch(() => {});
}

const CAPTION_KINDS = new Set(["CAPTION", "SHORT_CAPTION", "CTA", "COVER_TITLE"]);

/**
 * The client (or staff on their behalf) edits a caption: a NEW row, versioned,
 * based on the one they edited, marked CHOSEN — the previous text is never
 * overwritten, and a later regeneration cannot erase this edit either.
 */
export async function saveCaptionEdit(viewer: PortalViewer, videoId: string, input: { kind: string; body: string; basedOnId?: string | null }): Promise<R & { id?: string }> {
  const v = await videoForEnrollment(viewer.enrollment, videoId);
  if (!v) return { ok: false, message: "That video isn't on your page." };
  const kind = CAPTION_KINDS.has(input.kind) ? input.kind : "CAPTION";
  const body = clip((input.body ?? "").trim(), 2200);
  if (body.length < 2) return { ok: false, message: "Write the caption first." };
  const submissionId = v.finalSubmissionId ?? v.approvedSubmissionId ?? v.currentSubmissionId ?? (await portalVideoRef(v.id));
  if (!submissionId) return { ok: false, message: "This video has no file on record yet, so a caption can't be tied to it." };
  const based = input.basedOnId && /^[a-z0-9]{10,40}$/i.test(input.basedOnId) ? await prisma.contentCaptionDraft.findFirst({ where: { id: input.basedOnId, videoId: v.id }, select: { id: true, versionNo: true, kind: true, strategyVersionId: true, transcriptId: true, scriptVersionId: true } }) : null;
  const last = await prisma.contentCaptionDraft.findFirst({ where: { videoId: v.id, kind }, orderBy: { versionNo: "desc" }, select: { versionNo: true } });
  const a = viewer.actor;
  const row = await prisma.contentCaptionDraft.create({
    data: {
      videoId: v.id, submissionId, enrollmentId: viewer.enrollment.id, clientId: viewer.enrollment.clientId,
      transcriptId: based?.transcriptId ?? null, scriptVersionId: based?.scriptVersionId ?? v.scriptVersionId ?? null, strategyVersionId: based?.strategyVersionId ?? null,
      kind, body, versionNo: (last?.versionNo ?? 0) + 1, basedOnId: based?.id ?? null,
      authorKind: a.kind === "STAFF" ? "STAFF" : "CLIENT", clientUserId: a.kind === "CLIENT" ? a.clientUserId : null, staffUserId: a.kind === "STAFF" ? a.staffUserId : null,
      status: "CHOSEN", chosenAt: new Date(), chosenBy: actorLabel(viewer),
    },
    select: { id: true },
  });
  // One chosen text per kind: the earlier chosen one steps back to DRAFT (kept).
  await prisma.contentCaptionDraft.updateMany({ where: { videoId: v.id, kind, status: "CHOSEN", id: { not: row.id } }, data: { status: "DRAFT" } }).catch(() => {});
  return { ok: true, message: "Saved as your caption.", id: row.id };
}

/** For a video delivered before the Review Room (no cut on file), the draft is tied to the delivered file's library row. Documented deviation: `submissionId` carries "portal-video:<PortalVideo.id>". */
async function portalVideoRef(videoId: string): Promise<string | null> {
  const s = await prisma.contentVideoSource.findFirst({ where: { videoId, kind: "PORTAL_VIDEO", isFinal: true }, select: { portalVideoId: true } });
  return s?.portalVideoId ? `portal-video:${s.portalVideoId}` : null;
}

type CaptionOut = { caption: string; shorterCaption?: string | null; ctaOptions?: string[] | null; coverTitles?: string[] | null; captionCta?: string | null; gaps?: { text?: string }[] };

/**
 * "Draft a caption" from the portal: a person's click, gated by the
 * caption_assistant switch. The final cut's transcript is the primary factual
 * source; when there is none the draft is made from the linked script and
 * every row records that in words.
 */
export async function draftCaptionForVideo(viewer: PortalViewer, videoId: string): Promise<R & { drafted?: number }> {
  const v = await videoForEnrollment(viewer.enrollment, videoId);
  if (!v) return { ok: false, message: "That video isn't on your page." };
  if (!(await isAutomationEnabled("caption_assistant"))) {
    return { ok: false, message: "Caption drafting is switched off until the program launches — write your caption below and it's saved with this video, or text us and we'll draft one." };
  }
  const submissionId = v.finalSubmissionId ?? v.approvedSubmissionId ?? v.currentSubmissionId ?? null;
  const [script, transcript] = await Promise.all([
    scriptForVideo(v).catch(() => null),
    submissionId ? transcriptForCut(submissionId).catch(() => null) : Promise.resolve(null),
  ]);
  const transcriptText = transcript?.text ?? null;
  if (!script && !transcriptText) return { ok: false, message: "There's nothing factual to draft from yet — no transcript of the final cut and no script linked to this video." };
  const { buildClientContext } = await import("@/lib/contentGeneration");
  const { runAiJson } = await import("@/lib/aiRuns");
  const built = await buildClientContext(v.enrollmentId, { monthId: v.monthId, projectId: v.projectId });
  // With no script on file the transcript stands in as the "script" the prompt renders from — clearly labelled below.
  const canonical: CanonicalScript = script?.canonical ?? canonicalFromParts(partsFromBody(v.title ?? "Video", transcriptText ?? ""), viewer.enrollment.clientId);
  const bundle = buildCaptionPrompt(built.ctx, canonical);
  const scriptWord = script?.historical ? "an earlier script we have on file" : "the script";
  const sourceNote = transcriptText
    ? `Drafted from the transcript of the final cut, with ${scriptWord} as supporting context.`
    : `Drafted from ${scriptWord} — no transcript yet${transcript?.gap ? ` (${transcript.gap})` : ""}.`;
  const user = [
    bundle.user,
    "",
    transcriptText ? `TRANSCRIPT OF THE FINAL CUT (primary factual source — the caption must not claim anything the video no longer says):\n${clip(transcriptText, 6000)}` : "NO TRANSCRIPT OF THE FINAL CUT EXISTS. Draft from the script only, and keep every claim to what the script says.",
    "",
    "Also return: shorterCaption (one or two lines), ctaOptions (0-3 short options that fit the video's goal — none if the video is purely educational), coverTitles (0-3 short on-screen title suggestions).",
  ].join("\n");
  const schema = { ...(bundle.outputSchema as Record<string, unknown>) };
  const props = { ...((schema.properties as Record<string, unknown>) ?? {}), shorterCaption: { type: ["string", "null"] }, ctaOptions: { type: "array", items: { type: "string" } }, coverTitles: { type: "array", items: { type: "string" } } };
  const requestedBy = viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : viewer.actor.kind === "STAFF" ? viewer.actor.staffUserId : `portal:${viewer.enrollment.id}`;
  let out: CaptionOut;
  let runId: string | null = null;
  try {
    const r = await runAiJson<CaptionOut>({
      kind: "caption", enrollmentId: v.enrollmentId, clientId: v.clientId, scope: { videoId: v.id, submissionId }, inputRefs: { ...built.inputRefs, transcriptId: transcript?.transcriptId ?? null, scriptVersionId: v.scriptVersionId ?? null },
      promptKey: "caption", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy, unattended: false,
      dedupeKey: `caption:${v.id}:${submissionId ?? "none"}`, system: bundle.system, prompt: user, schema: { ...schema, properties: props }, maxTokens: 1200,
    });
    out = r.output; runId = r.runId;
  } catch (e) {
    return { ok: false, message: e instanceof Error && /quota/i.test(e.message) ? "The caption assistant has hit today's limit — try again tomorrow, or write one below." : "The caption assistant couldn't draft just now — try again in a moment, or write one below." };
  }
  const draftSubmissionId = submissionId ?? (await portalVideoRef(v.id));
  if (!draftSubmissionId) return { ok: false, message: "This video has no file on record yet, so a caption can't be tied to it." };
  const rows: { kind: string; body: string; options: string[] }[] = [
    { kind: "CAPTION", body: out.caption, options: [] },
    ...(out.shorterCaption ? [{ kind: "SHORT_CAPTION", body: out.shorterCaption, options: [] }] : []),
    ...((out.ctaOptions ?? []).length || out.captionCta ? [{ kind: "CTA", body: out.captionCta ?? out.ctaOptions![0], options: (out.ctaOptions ?? []).filter((x) => x !== out.captionCta) }] : []),
    ...((out.coverTitles ?? []).length ? [{ kind: "COVER_TITLE", body: out.coverTitles![0], options: out.coverTitles!.slice(1) }] : []),
  ].filter((r) => typeof r.body === "string" && r.body.trim());
  let drafted = 0;
  for (const r of rows) {
    const last = await prisma.contentCaptionDraft.findFirst({ where: { videoId: v.id, kind: r.kind }, orderBy: { versionNo: "desc" }, select: { versionNo: true } });
    await prisma.contentCaptionDraft.create({
      data: {
        videoId: v.id, submissionId: draftSubmissionId, enrollmentId: v.enrollmentId, clientId: v.clientId, transcriptId: transcript?.transcriptId ?? null,
        scriptVersionId: v.scriptVersionId ?? null, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: runId,
        kind: r.kind, body: clip(r.body.trim(), 2200), alternativesJson: JSON.stringify({ options: r.options, sourceNote, gaps: (out.gaps ?? []).map((g) => g.text).filter(Boolean) }),
        versionNo: (last?.versionNo ?? 0) + 1, authorKind: "AI", status: "DRAFT",
      },
    }).then(() => drafted++).catch(() => {});
  }
  return { ok: true, message: `${drafted} draft${drafted === 1 ? "" : "s"} ready — ${sourceNote} Edit anything before you use it.`, drafted };
}
