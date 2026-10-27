import "server-only";
import { isAryeoFileUrl, deliveredFileName, remoteFileSize } from "@/lib/fileRelay";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { transcriptForCut } from "@/lib/cutTranscripts";
import { canonicalFromParts, partsFromBody, pointsFromJson } from "@/lib/contentScripts";
import { renderScript, stripRenderPlaceholders, assertClientScoped, buildCaptionDraftPrompt, finishCaption, strategyExcerpt, type CanonicalScript, type CaptionModelOut } from "@/lib/contentPolicy";
import { deliveredMediaFor, videoForEnrollment } from "@/lib/contentVideos";
import { actorLabel, can } from "@/lib/portalAccess";
import { WHY, captionTarget, videoEntitlement, type Entitlement, type EntitlementBasis, type EntitlementBlock, type EntitlementVideo, type FinalFile } from "@/lib/cutEntitlement";
import { CLIENT_VISIBLE_SCRIPT, type PortalViewer } from "@/lib/portal";
import { URGENT_CONTACT } from "@/lib/reviewWindows";
import { clip } from "@/lib/text";
import { TEXT_KYLE, TEXT_KYLE_START } from "@/lib/portalWords";

// ---------------------------------------------------------------------------
// THE POSTING KIT (spec §10, Sep 17 2026). Per video: the final file (which
// one, which version, and whether the bytes still match the approval), an
// editable caption draft, the cover asset when one exists, the script and the
// transcript it could be drafted from — and the CLIENT-RECORDED facts,
// "Download started" / "Download finished", that are never a verified
// publication (that is §12's job and it is disabled). ("Marked as posted by
// me" was retired Oct 21 and deleted Oct 27 2026; Jordan: "Delete them - but
// add a status that shows it was downloaded", so the Library now says
// "Downloaded" from these same rows: contentVideos.clientDownloadsFor.)
//
// Caption drafting: a client's "Draft a caption" runs only when
// `caption_assistant` is ON (a missing row is OFF, programAutomation.ts) and
// it is a person's click (unattended:false), so the ai_runs master switch does
// not gate it but the feature switch does. When transcriptForCut reports a gap
// the draft is made from the script and the kit says so in plain words — it
// never pretends a transcript existed.
//
// Oct 23 2026 (Jordan): the caption is ALSO drafted automatically, once per
// approved monthly version, from its transcript, following Instagram's caption
// rules (autoDraftCaptionForCut below; the AI work job runs it). That door is
// unattended, so ai_runs gates it too.
//
// AND ONLY FOR CLIENTS THE PROGRAM ROLLOUT REACHES (review fix, Sep 28 2026).
// The switch alone used to decide, and the copy called it "internal": turning
// caption_assistant on gave EVERY real client — pilot or not, token link or
// signed in — a "Draft a caption" button and AI-written text in their portal,
// the same "switch = every client" defect R03 fixed for every other switch.
// It is op caption_assistant now (programRolloutCore, the portal_changes
// group): the kit offers the button, and draftCaptionForVideo drafts, only
// when the switch is on AND the rollout reaches this client (TEST clients,
// the named pilot, or everyone once Jordan chooses it). assistantFor is the
// one question both ask.
//
// WHICH FILE, AND WHETHER THE CLIENT MAY HAVE IT (CP-01, Sep 24 2026), is not
// decided here any more: the download, the caption target and the kit's
// `access` all come from cutEntitlement's one rule. Internal completion is not
// client approval, and a replacement never inherits the approval before it.
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

// Moved to cutEntitlement with the rule that produces it; re-exported for the page.
export type { FinalFile };

export type PostingKit = {
  videoId: string;
  title: string;
  final: FinalFile | null;
  /** Why there is no final file yet (client-safe). */
  finalNote: string | null;
  cover: string | null;
  /** Oct 24 2026 (lib/videoAnalysis): the three Instagram covers of the file handed over, theirs or our pick chosen; null until made. */
  covers?: import("@/lib/videoAnalysis").KitCovers | null;
  captions: CaptionView[];
  transcript: { text: string | null; gap: string | null; source: string | null };
  /** `historical` = an imported record we hold, shown as history — never re-labelled as this video’s script. */
  script: { title: string; body: string; versionLabel: string | null; strategyLabel: string | null; historical: boolean } | null;
  /** The client (never staff) last opened the download door — a download STARTED. */
  downloadStartedAtISO: string | null;
  /** The page received every byte AND handed the file on — the share sheet
   *  finished or the browser's save was started — and said so
   *  (portalDownloadCompleted). Only a proxied download can know this; a
   *  redirect never claims it. Shown as "Download finished", never "Saved". */
  downloadCompletedAtISO: string | null;
  /** How the page should fetch the entitled file (CP-12), or null when there is none. */
  download: DownloadPlan | null;
  assistant: { enabled: boolean; why: string | null };
  /** What the client may do with this video's file right now — the release
   *  rule's answer (cutEntitlement), so the page never offers a button the
   *  server would refuse. */
  access: { download: boolean; captions: boolean; why: string | null; blockedBy: EntitlementBlock | null; basis: EntitlementBasis };
  /** Oct 21 2026: the file handed over is an EARLIER version (or this one as
   *  approved before they asked for changes) while a newer one is open: which
   *  version, and whether they approved it here or we delivered it. The page
   *  labels the button "Download the version you approved (v1)". */
  prior: { version: number; approved: boolean } | null;
};

const DOWNLOAD_PATH = (videoId: string) => `/portal/download/${videoId}`;
/** Every visit row on this video's download door: the bare path or it with a query. */
const downloadVisits = (videoId: string) => ({ OR: [{ path: DOWNLOAD_PATH(videoId) }, { path: { startsWith: `${DOWNLOAD_PATH(videoId)}?` } }] });
const DONE_MARK = "done=1";

// ---------------------------------------------------------------------------
// HOW THE PAGE FETCHES THE FILE (CP-12, Sep 24 2026). The download used to be
// a target=_blank link with no progress and no retry, and on a phone it told
// the client to "open this page on a computer". Two honest modes:
//
//   proxy     the entitled file is a hub cut still in the hub's store: the
//             stream route serves it same-origin with a Content-Length, so the
//             page can read it with fetch(), show real progress, cancel, retry,
//             and hand the finished file to the phone's share sheet.
//   redirect  everything else — a cut the 90-day prune left only in Dropbox
//             (a temporary link this app cannot force to download: it has no
//             sharing scope) and Aryeo's CDN files. The browser is sent there;
//             the page can say the download STARTED, never that it finished.
//
// A proxied file is held in memory until it is saved, so a big one would
// strain a phone: above PROXY_MAX_BYTES (or with no known size) it redirects.
// ---------------------------------------------------------------------------

export const PROXY_MAX_BYTES = 400 * 1024 * 1024;

export type DownloadPlan = {
  mode: "proxy" | "redirect";
  fileName: string | null;
  sizeBytes: number | null;
  /** What the completion beacon names — the entitlement's captionRef (the cut
   *  id, or "portal-video:<id>"), so a stale page cannot record a different file. */
  ref: string | null;
};

async function downloadPlanFor(e: Entitlement): Promise<DownloadPlan | null> {
  const f = e.file;
  if (!f) return null;
  // 9.6b: the client's file is the verified 1080p render, which lives in
  // Dropbox, not the hub's store. The stream route RELAYS it with an attachment
  // header (so it saves under the video's own name), but its size is not known
  // without a Dropbox call on every page render — so the page navigates to the
  // door and the browser's own download shows the progress. Never held in the
  // page's memory.
  if (f.kind === "cut" && f.processed) return { mode: "redirect", fileName: f.processed.fileName, sizeBytes: null, ref: e.captionRef };
  // A video delivered through an Aryeo listing (Oct 19 2026, Rick Schultz on
  // his phone: "it only shows playback speed, not download"). The door relays
  // Aryeo's file same-origin with its length, so the page can read it with
  // progress and hand it to the phone's share sheet (Save Video) like a hub
  // cut. One ranged byte tells the size; unknown or too big → plain download.
  if (f.kind === "delivered" && isAryeoFileUrl(f.url)) {
    const size = await remoteFileSize(f.url).catch(() => null);
    const mode = size != null && size <= PROXY_MAX_BYTES ? "proxy" : "redirect";
    return { mode, fileName: deliveredFileName(f.fileName, f.url), sizeBytes: size, ref: e.captionRef };
  }
  if (f.kind === "cut" && f.submissionId) {
    const sub = await prisma.reviewSubmission.findUnique({ where: { id: f.submissionId }, select: { blobUrl: true, sizeBytes: true, fileName: true } });
    const size = sub?.sizeBytes ?? null;
    const mode = sub?.blobUrl && size != null && size > 0 && size <= PROXY_MAX_BYTES ? "proxy" : "redirect";
    return { mode, fileName: sub?.fileName ?? f.fileName, sizeBytes: size, ref: e.captionRef };
  }
  return { mode: "redirect", fileName: f.fileName, sizeBytes: null, ref: e.captionRef };
}

/**
 * Which file is "the final" for this video, and whether the client may have
 * it — cutEntitlement's answer, in the shape the page and the download door
 * read. It used to serve `finalSubmissionId ?? approvedSubmissionId`, i.e. the
 * newest cut the Review Room had copied to Dropbox, with no client approval at
 * all; and it checked the approval hash only when approvedSubmissionId pointed
 * at that same cut, so a replacement round downloaded under nobody's approval.
 * `final` is set exactly when the file may be served (hashOk is always true).
 */
export async function resolveFinalFile(video: EntitlementVideo): Promise<{ final: FinalFile | null; note: string | null; entitlement: Entitlement }> {
  const e = await videoEntitlement(video);
  return { final: e.file, note: e.why, entitlement: e };
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
  // The fence is scriptId + enrollmentId, and deliberately NOT clientId. A
  // client dedupe merge re-points the surviving client's rows but leaves
  // ContentScriptVersion.clientId naming the loser, so a clientId fence would
  // MISS on exactly the rows it is meant to protect. enrollmentId is what the
  // viewer was proven against upstream and no merge moves it. ("0 rows drift
  // today" — measured Sep 18, 0 of 174 version rows — is a snapshot of a
  // mutable column, not an invariant; the fence must not rest on it.)
  const fence = { scriptId: script.id, enrollmentId: video.enrollmentId };
  let v = releasedId ? await prisma.contentScriptVersion.findFirst({ where: { id: releasedId, ...fence } }) : null;
  if (!v && video.scriptVersionId) v = await prisma.contentScriptVersion.findFirst({ where: { id: video.scriptVersionId, ...fence } });
  // FAIL CLOSED. The fallback below serves ContentScript.body, and that column
  // is only a RECORD in two cases: a historical import, which
  // contentScripts.syncLegacyPointer exempts ("its legacy body is the record of
  // what was filmed and no later version … moves it"), and a script that has no
  // versions at all. Everywhere else syncLegacyPointer mirrors
  // `shared ?? approved ?? THE NEWEST DRAFT` into it — so on a versioned live
  // script the body follows unreviewed work, and a fence miss that falls
  // through to it hands the client the very thing the release gate exists to
  // hold back. Refuse instead: no script is a smaller failure than the wrong
  // script. Measured Sep 18 on production: of 150 client-visible scripts, 6
  // name a released version (all 6 resolve under this fence, 0 dangle) and 144
  // are historical, so nothing live changes and the open door closes.
  const bodyIsRecord = historical || !script.currentVersionId;
  if (!v && !bodyIsRecord) return null;

  const strategyId = v?.strategyVersionId ?? script.strategyVersionId ?? null;
  const strategy = strategyId ? await prisma.contentStrategyVersion.findUnique({ where: { id: strategyId }, select: { versionNo: true } }) : null;
  if (v) {
    const canonical = canonicalFromParts({ title: v.title, categoryLabel: v.categoryLabel, pillarId: v.pillarId, hook: v.hook, points: pointsFromJson(v.pointsJson), close: v.close, captionCta: v.captionCta }, v.clientId);
    // `body` is what the client's posting kit shows AND hands over through
    // Copy / Download .txt — the client's rendering, so no "(no pillar
    // linked)" or empty-block placeholder rides along (§11). The staff caption
    // prompt reads `canonical`, not this.
    return { canonical, title: v.title, body: renderScript(canonical, { audience: "client" }), versionLabel: `v${v.versionNo}`, strategyLabel: strategy ? `v${strategy.versionNo}` : null, clientId: v.clientId, historical };
  }
  const canonical = canonicalFromParts(partsFromBody(script.title, script.body), script.clientId);
  return { canonical, title: script.title, body: stripRenderPlaceholders(script.body), versionLabel: null, strategyLabel: strategy ? `v${strategy.versionNo}` : null, clientId: script.clientId, historical };
}

/**
 * What a CLIENT reads about a missing transcript (audit Oct 25 2026). The gap
 * transcriptForCut gives is the staff sentence: em dashes ("No transcript —
 * the last attempt failed: …") and, after a failure, the hub's own error text
 * ("a store this deployment holds no token for"). The portal's Posting Kit
 * printed it in brackets under every AI caption. One plain phrase each here;
 * the full reason still reaches the caption prompt and the staff screens.
 */
export function clientTranscriptGap(gap: string | null | undefined): string | null {
  if (!gap) return null;
  if (gap === "it comes with the approved version") return gap;
  if (/^No transcript yet/.test(gap)) return "it is on its way";
  return "it isn't available for this version yet";
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

/** Switch on AND the rollout reaches this client for the caption assistant. Never throws (off on any error). */
async function assistantFor(clientId: string): Promise<boolean> {
  if (!(await isAutomationEnabled("caption_assistant").catch(() => false))) return false;
  const { programReach } = await import("@/lib/programRollout");
  return (await programReach("caption_assistant", clientId)).ok;
}

/** The kit for one of the viewer's videos (ownership already proven by the caller). */
export async function postingKitFor(viewer: PortalViewer, video: NonNullable<Awaited<ReturnType<typeof videoForEnrollment>>>): Promise<PostingKit> {
  const { final, note, entitlement: e } = await resolveFinalFile(video);
  // The transcript shown is the ENTITLED cut's — the one a caption would be
  // drafted from. Stale-marking compares against the decisive round too, so
  // drafts of a replaced cut go STALE as soon as the replacement is released.
  const kitSubmissionId = final?.submissionId ?? null;
  // The decisive round, which may be a NEWER version than the file the client
  // still has (KEEP_PRIOR_APPROVED_VERSION). Oct 23 2026: its captions are not
  // stale (they were drafted for it and become the client's when they approve
  // it), but they are not this file's either, so the kit holds them back.
  const openSubmissionId = e.current?.submissionId ?? null;
  const newerOpen = kitSubmissionId && openSubmissionId && openSubmissionId !== kitSubmissionId ? openSubmissionId : null;
  // "Approve this version above" is only true for a seat that can approve —
  // and on a paused or ended program NO seat can (every viewer is READ_ONLY,
  // staff included), so "once the account owner approves" would promise
  // something that cannot happen. Kyle can send the file instead.
  const why = e.blockedBy === "AWAITING_DECISION" && viewer.access !== "FULL"
    ? `Your program is ${viewer.enrollment.status === "ENDED" ? "ended" : "paused"}, so this version can't be approved here and its download isn't open. Call or text Kyle at ${URGENT_CONTACT} and we'll get you the file.`
    : e.blockedBy === "AWAITING_DECISION" && !can(viewer, "approveEdits") ? WHY.AWAITING_OWNER : note;
  // The client's own facts only: a staff member opening the door on their
  // behalf is recorded (attributed) but is not the client downloading.
  const clientVisit = { enrollmentId: viewer.enrollment.id, via: { not: "STAFF" }, staffUserId: null, ...downloadVisits(video.id) };
  const [captions, transcript, script, lastStarted, lastCompleted, cover, assistantOn, download] = await Promise.all([
    prisma.contentCaptionDraft.findMany({ where: { videoId: video.id, enrollmentId: viewer.enrollment.id, status: { not: "ARCHIVED" } }, orderBy: [{ kind: "asc" }, { versionNo: "desc" }] }),
    kitSubmissionId ? transcriptForCut(kitSubmissionId).catch(() => ({ text: null, source: null, gap: "The transcript couldn't be read just now.", transcriptId: null, contentHash: null, language: null })) : Promise.resolve({ text: null, source: null, gap: e.current && !e.file ? "it comes with the approved version" : "No cut of this video is on file, so there is no transcript.", transcriptId: null, contentHash: null, language: null }),
    scriptForVideo(video).catch(() => null),
    prisma.portalVisit.findFirst({ where: { ...clientVisit, NOT: { path: { contains: DONE_MARK } } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.portalVisit.findFirst({ where: { ...clientVisit, path: { contains: DONE_MARK } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    // The cover is the poster OF the file handed over (Oct 21 2026): any
    // delivered file's frame used to be shown, so an approved v3 carried v1's.
    coverFor(video.id, e).catch(() => null),
    assistantFor(viewer.enrollment.clientId),
    downloadPlanFor(e).catch(() => (e.file ? { mode: "redirect" as const, fileName: e.file.fileName, sizeBytes: null, ref: e.captionRef } : null)),
  ]);
  // Any AI draft tied to a cut that is no longer the final is STALE (spec §10):
  // stamp it rather than serving it as if it described the current file.
  const stale = captions.filter((c) => c.status !== "STALE" && (kitSubmissionId || openSubmissionId) && c.submissionId !== kitSubmissionId && c.submissionId !== openSubmissionId && !c.submissionId.startsWith("portal-video:"));
  if (stale.length) {
    await prisma.contentCaptionDraft.updateMany({ where: { id: { in: stale.map((c) => c.id) } }, data: { status: "STALE", staleReason: "cut changed" } }).catch(() => {});
    for (const c of stale) { c.status = "STALE"; c.staleReason = "cut changed"; }
  }
  return {
    videoId: video.id,
    title: video.title ?? "Video",
    final, finalNote: why, cover,
    covers: await import("@/lib/videoAnalysis").then((m) => m.kitCoversFor(viewer, video.id, e)).catch(() => null),
    captions: captions.filter((c) => !newerOpen || c.submissionId !== newerOpen).map(captionView),
    // NEITHER IS MONEY-CLAMPED, on purpose. stripMoneySentences DELETES whole
    // sentences, and text.ts:108 scopes it to the case it was written for —
    // "used when client text lands on an EDITOR-visible task: creatives never
    // see pricing". That is Jordan's rule about CREATIVES. The client is the
    // other party to our pricing, and this is the client's own released script:
    // run over it the clamp removed the thing they are meant to read and film.
    // Measured against production (Sep 18): 64 of the 150 client-visible
    // scripts lost text, and Erica Walker's "The List Price and the Sale Price
    // Are Not the Same Thing" (ContentScript cmt7mxsrt001p9kg1mq0gngt3) went
    // 569 -> 134 characters — hook, close and every line about price gone from
    // a script whose SUBJECT is price. The transcript is the client's own words
    // out of their own finished cut, and the factual source their caption is
    // checked against, so it is served whole for the same reason. What a client
    // may see at all is decided by scriptVisibility above — a release gate, not
    // a word filter.
    transcript: { text: transcript.text, gap: clientTranscriptGap(transcript.gap), source: transcript.source },
    script: script ? { title: script.title, body: script.body, versionLabel: script.versionLabel, strategyLabel: script.strategyLabel, historical: script.historical } : null,
    downloadStartedAtISO: lastStarted?.createdAt.toISOString() ?? null,
    downloadCompletedAtISO: lastCompleted?.createdAt.toISOString() ?? null,
    download,
    assistant: { enabled: assistantOn, why: assistantOn ? null : "We'll write your caption with the script, or you can write one below." },
    access: { download: !!e.file, captions: !!e.captionRef, why, blockedBy: e.blockedBy, basis: e.basis },
    prior: e.priorVersion && e.file ? { version: Number(e.file.label.match(/^v(\d+)/)?.[1] ?? 1), approved: e.basis === "CLIENT_APPROVED" } : null,
  };
}

/** The poster of the entitled file: a delivered (Aryeo) file's own frame, or
 *  the frame of a delivered copy of the entitled cut (contentVideos.posterFor). */
async function coverFor(videoId: string, e: Entitlement): Promise<string | null> {
  if (!e.file) return null;
  if (e.file.kind === "delivered") {
    const id = e.captionRef?.startsWith("portal-video:") ? e.captionRef.slice("portal-video:".length) : null;
    return id ? (await prisma.portalVideo.findUnique({ where: { id }, select: { thumb: true } }))?.thumb ?? null : null;
  }
  return (await deliveredMediaFor(videoId, e.file.submissionId)).thumb;
}

type R = { ok: boolean; message: string };

/** Record a download STARTING as a client fact: a PortalVisit row on the
 *  download path, attributable to the person or staff. The door writes it as
 *  it hands the file over — which proves the door opened, not that the bytes
 *  arrived (that is recordDownloadCompleted). */
export async function recordDownload(scope: { enrollmentId: string; clientUserId: string | null; staffUserId: string | null; via: "TOKEN" | "LOGIN" | "STAFF" }, videoId: string, submissionId: string | null): Promise<void> {
  await prisma.portalVisit.create({ data: { enrollmentId: scope.enrollmentId, clientUserId: scope.clientUserId, staffUserId: scope.staffUserId, via: scope.via, path: `${DOWNLOAD_PATH(videoId)}${submissionId ? `?cut=${submissionId}` : ""}` } }).catch(() => {});
}

const COMPLETION_QUIET_MS = 10 * 60_000;

/**
 * "The whole file arrived" (CP-12) — sent by the page when a proxied download
 * has read its last byte. Deliberately NOT gated by can(): a paused or ended
 * client keeps their downloads, and recording one is theirs to do too. What IS
 * checked is everything that makes the fact true: the video is this viewer's,
 * the file they name is the one the release rule serves them right now (a
 * stale page cannot record a different file), and one row per video per ten
 * minutes — a page left retrying cannot flood the table.
 */
export async function recordDownloadCompleted(viewer: PortalViewer, videoId: string, ref: string): Promise<R> {
  const v = await videoForEnrollment(viewer.enrollment, videoId);
  if (!v) return { ok: false, message: "That video isn't on your page." };
  if (typeof ref !== "string" || !ref || ref.length > 80) return { ok: false, message: "That isn't this video's file." };
  const e = await videoEntitlement(v);
  if (!e.file || e.captionRef !== ref) return { ok: false, message: "That isn't the file this video downloads right now." };
  const recent = await prisma.portalVisit.findFirst({
    where: { enrollmentId: viewer.enrollment.id, createdAt: { gte: new Date(Date.now() - COMPLETION_QUIET_MS) }, path: { startsWith: `${DOWNLOAD_PATH(v.id)}?`, contains: DONE_MARK } },
    select: { id: true },
  });
  if (recent) return { ok: true, message: "Saved." };
  const a = viewer.actor;
  await prisma.portalVisit.create({
    data: {
      enrollmentId: viewer.enrollment.id, via: viewer.via,
      clientUserId: a.kind === "CLIENT" ? a.clientUserId : null, staffUserId: a.kind === "STAFF" ? a.staffUserId : null,
      path: `${DOWNLOAD_PATH(v.id)}?cut=${encodeURIComponent(ref)}&${DONE_MARK}`,
    },
  });
  return { ok: true, message: "Saved." };
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
  // Tied to the entitled file — the same target a draft uses. It fell back to
  // the current (unapproved) review cut, so a caption could be written against
  // a version the client had not approved and might never get.
  const target = await captionTarget(viewer, v);
  if (!target.ok) return { ok: false, message: target.message };
  const submissionId = target.ref;
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

// For a video delivered before the Review Room (no cut on file), a caption is
// tied to the delivered file's library row: `submissionId` carries
// "portal-video:<PortalVideo.id>" (documented deviation). cutEntitlement's
// captionRef is that value for an Aryeo file.

// ---------------------------------------------------------------------------
// THE CAPTION ENGINE (Oct 23 2026). One drafter for both doors: the client's
// "Draft a caption" click (draftCaptionForVideo) and the automatic draft after
// each approved monthly version (autoDraftCaptionForCut). Jordan, Oct 23:
// captions follow Instagram's and Meta's own guidance
// (docs/instagram-caption-rules.md), on a Sonnet-class model (the model map's
// Sonnet entry), from a LEAN prompt — the transcript, the script, a short
// strategy excerpt and the rules — in ONE call per version: no review, no
// rewrite loop. The checkable rules are enforced in code on whatever came
// back (contentPolicy/captionRules.finishCaption).
//
// It fixes a quiet loss on the way: the old prompt's schema REQUIRED
// `captionBody` while the rows read `out.caption`, so a model that followed
// the schema saved no main caption at all (only the drill stubs, which sent
// `caption`, ever produced one). finishCaption reads both shapes.
// ---------------------------------------------------------------------------

/** The model map's Sonnet entry (scriptWriter/pipeline STEP_MODEL: Sonnet 5.5). Never Opus. */
export const CAPTION_MODEL = "claude-sonnet-5-5";
/** A short caption needs little thinking; thinking counts toward the output tokens. */
const CAPTION_EFFORT = "low" as const;
/** Room for the thinking and the answer (about 400 tokens of answer). */
const CAPTION_MAX_TOKENS = 3000;
/** A caption draft starts only with this long left in the caller's budget. */
export const CAPTION_DRAFT_MIN_START_MS = 60_000;

type ContentVideoRow = NonNullable<Awaited<ReturnType<typeof videoForEnrollment>>>;

type EngineInput = {
  video: ContentVideoRow;
  /** The cut whose transcript is the primary source (null = none). */
  transcriptSubmissionId: string | null;
  /** What the rows are tied to (the cut id, or "portal-video:<id>"). */
  draftRef: string;
  requestedBy: string;
  unattended: boolean;
  dedupeKey: string;
  scope?: Record<string, unknown>;
  timeoutMs?: number;
  auto?: boolean;
};
type EngineResult = R & { drafted?: number; runId?: string | null; costCents?: number; sourceNote?: string };

async function draftCaptionRows(input: EngineInput): Promise<EngineResult> {
  const v = input.video;
  const [script, transcript] = await Promise.all([
    scriptForVideo(v).catch(() => null),
    input.transcriptSubmissionId ? transcriptForCut(input.transcriptSubmissionId).catch(() => null) : Promise.resolve(null),
  ]);
  const transcriptText = transcript?.text ?? null;
  if (!script && !transcriptText) return { ok: false, message: "There's nothing factual to draft from yet: no transcript of the final video and no script linked to it." };
  const { buildClientContext } = await import("@/lib/contentGeneration");
  const { runAiJson } = await import("@/lib/aiRuns");
  // Lean (Jordan, Oct 23 2026): no earlier scripts as voice references; the strategy excerpt carries her voice.
  const built = await buildClientContext(v.enrollmentId, { monthId: v.monthId, projectId: v.projectId, priorScripts: 0 });
  // The pieces must all be this client's (contentPolicy/prompts.assertClientScoped).
  // CanonicalScript.clientId is a column a client dedupe merge leaves pointing at
  // the merged-away client, so this refuses as an answer, never a 500.
  try {
    assertClientScoped(built.ctx, script?.canonical ?? null);
  } catch {
    return { ok: false, message: `We can't draft this one automatically, because the records behind this video don't line up. ${TEXT_KYLE_START} and we'll write the caption with you.` };
  }
  const strategyDoc = built.ctx.strategy?.document ?? null;
  // The video's pillar: the script's own, else the library row's (its topic's pillar).
  const pillarName = script?.canonical.pillarRef?.pillarName
    ?? (v.pillarId ? (await prisma.contentPillar.findFirst({ where: { id: v.pillarId, enrollmentId: v.enrollmentId }, select: { name: true } }).catch(() => null))?.name ?? null : null);
  const prompt = buildCaptionDraftPrompt({
    clientName: built.ctx.clientName, videoTitle: v.title ?? script?.title ?? "Video",
    transcript: transcriptText, transcriptGap: transcript?.gap ?? null,
    script: script?.body ?? null, strategy: strategyDoc, pillarName,
  });
  const { ctaExamples } = strategyExcerpt(strategyDoc, null);
  const scriptWord = script?.historical ? "an earlier script we have on file" : "the script";
  const sourceNote = transcriptText
    ? `Drafted from the transcript of the final cut, with ${scriptWord} as supporting context.`
    // Stored on the draft and shown to the client beside it: never the staff
    // gap sentence (dashes, the hub's error text; audit Oct 25 2026).
    : `Drafted from ${scriptWord}, with no transcript yet.`;
  let out: CaptionModelOut;
  let runId: string | null = null;
  let costCents = 0;
  try {
    const r = await runAiJson<CaptionModelOut>({
      kind: "caption", engine: "writer", model: CAPTION_MODEL, effort: CAPTION_EFFORT,
      enrollmentId: v.enrollmentId, clientId: v.clientId, scope: { videoId: v.id, submissionId: input.draftRef, ...(input.scope ?? {}) },
      inputRefs: { ...built.inputRefs, transcriptId: transcript?.transcriptId ?? null, scriptVersionId: v.scriptVersionId ?? null, captionRules: "ig-2026-10-23" },
      promptKey: "caption", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: input.requestedBy, unattended: input.unattended,
      dedupeKey: input.dedupeKey, system: prompt.system, prompt: prompt.prompt, schema: prompt.schema, maxTokens: CAPTION_MAX_TOKENS, timeoutMs: input.timeoutMs,
    });
    out = r.output; runId = r.runId; costCents = r.costCents;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return {
      ok: false,
      message: /quota|limit \(\d+\/day\)/i.test(msg)
        ? "The caption assistant has hit today's limit. Try again tomorrow, or write one below."
        : /already running/i.test(msg)
          ? "A caption is being drafted for this video right now. Give it a moment."
          : "The caption assistant couldn't draft just now. Try again in a moment, or write one below.",
    };
  }
  const fin = finishCaption(out ?? {}, { sourcesText: prompt.sourcesText, ctaExamples });
  const rows: { kind: string; body: string | null; options: string[] }[] = [
    { kind: "CAPTION", body: fin.caption, options: [] },
    { kind: "SHORT_CAPTION", body: fin.shortCaption, options: [] },
    { kind: "CTA", body: fin.cta, options: [] },
    { kind: "COVER_TITLE", body: fin.coverTitle, options: [] },
  ];
  let drafted = 0;
  for (const r of rows) {
    if (!r.body || !r.body.trim()) continue;
    const last = await prisma.contentCaptionDraft.findFirst({ where: { videoId: v.id, kind: r.kind }, orderBy: { versionNo: "desc" }, select: { versionNo: true } });
    await prisma.contentCaptionDraft.create({
      data: {
        videoId: v.id, submissionId: input.draftRef, enrollmentId: v.enrollmentId, clientId: v.clientId, transcriptId: transcript?.transcriptId ?? null,
        scriptVersionId: v.scriptVersionId ?? null, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: runId,
        kind: r.kind, body: clip(r.body.trim(), 2200),
        alternativesJson: JSON.stringify({ options: r.options, sourceNote, gaps: fin.gaps, ...(r.kind === "CAPTION" ? { fixes: fin.fixes, findings: fin.findings, hashtags: fin.hashtags } : {}), ...(input.auto ? { auto: true } : {}) }),
        versionNo: (last?.versionNo ?? 0) + 1, authorKind: "AI", status: "DRAFT",
      },
    }).then(() => drafted++).catch(() => {});
  }
  return { ok: true, message: `${drafted} draft${drafted === 1 ? "" : "s"} ready. ${sourceNote} Edit anything before you use it.`, drafted, runId, costCents, sourceNote };
}

/**
 * "Draft a caption" from the portal: a person's click, gated by the
 * caption_assistant switch and the program rollout (assistantFor). The final
 * cut's transcript is the primary factual source; when there is none the draft
 * is made from the linked script and every row records that in words.
 */
export async function draftCaptionForVideo(viewer: PortalViewer, videoId: string): Promise<R & { drafted?: number }> {
  const v = await videoForEnrollment(viewer.enrollment, videoId);
  if (!v) return { ok: false, message: "That video isn't on your page." };
  // The release rule first, the switch second: a caption for a version the
  // client has not approved is refused whether or not the assistant is on.
  // It used to draft from `final ?? approved ?? CURRENT` — the unapproved
  // review cut — gated by the switch alone.
  const target = await captionTarget(viewer, v);
  if (!target.ok) return { ok: false, message: target.message };
  // The switch AND the rollout (op caption_assistant) — the same question the
  // kit's button asked, so a client never gets a draft the kit did not offer.
  if (!(await assistantFor(viewer.enrollment.clientId))) {
    return { ok: false, message: `Write your caption below and it's saved with this video, or ${TEXT_KYLE} and we'll draft one.` };
  }
  const requestedBy = viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : viewer.actor.kind === "STAFF" ? viewer.actor.staffUserId : `portal:${viewer.enrollment.id}`;
  const r = await draftCaptionRows({
    video: v, transcriptSubmissionId: target.submissionId, draftRef: target.ref, requestedBy, unattended: false,
    dedupeKey: `caption:${v.id}:${target.submissionId ?? "none"}`,
  });
  return { ok: r.ok, message: r.message, ...(r.drafted != null ? { drafted: r.drafted } : {}) };
}

// ---------------------------------------------------------------------------
// THE AUTOMATIC DRAFT (Oct 23 2026). Jordan: each approved monthly video is
// transcribed, its caption drafted from the real spoken words, automatically,
// so it is waiting in the client's posting kit and on the video for Jordan and
// James. Run by the AI work job (sweepAutoCaptions) after the transcript
// driver, so a version transcribed this tick is captioned this tick.
//
//   once        one automatic draft per approved version: a version with any
//               caption row (anyone's) or an automatic run that succeeded or
//               is running is done; two failed runs and it stops trying.
//   transcript  the primary source. While one is on its way (queued or
//               running, or about to be requested), the draft waits, up to
//               AUTO_CAPTION_WAIT_MS after the approval. When none can come
//               (no hosted file, the provider failed, no provider, the switch
//               off) or the wait is over, it drafts from the script and says so.
//   never over  a person's caption is never touched, and the draft never
//               becomes CHOSEN on its own. The older version's AUTOMATIC
//               draft steps aside (STALE) — unless the client still has that
//               older version's file (they keep it until they approve this one).
//   gated       caption_assistant AND the rollout (assistantFor), ai_runs
//               (unattended), the daily AI limits (runAiJson), and no run at
//               all while the AI account is refusing (aiOutage).
//   no backfill only versions approved since automatic transcripts began
//               (cutTranscripts.autoTranscriptsSince), and never a listing video.
// ---------------------------------------------------------------------------

/** How long an automatic caption waits for a transcript that is on its way. */
export const AUTO_CAPTION_WAIT_MS = 3 * 3600_000;
const AUTO_CAPTION_MAX_FAILED = 2;
/** The days the sweep looks back (within the start date). */
const AUTO_CAPTION_DAYS = 14;
const AUTO_REQUESTER = "cron:caption-auto";

export type AutoCaptionResult = { submissionId: string; drafted: boolean; why: string; costCents?: number; runId?: string | null };

export async function autoDraftCaptionForCut(submissionId: string, opts: { now?: Date; timeoutMs?: number } = {}): Promise<AutoCaptionResult> {
  const now = opts.now ?? new Date();
  const no = (why: string): AutoCaptionResult => ({ submissionId, drafted: false, why });
  const cut = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, status: true, decidedAt: true, projectId: true, deliverableId: true, slot: true, round: true, videoId: true, project: { select: { contentMonthId: true } } },
  });
  if (!cut) return no("That cut no longer exists.");
  if (!cut.project?.contentMonthId) return no("Not a monthly program video.");
  if (cut.status !== "APPROVED") return no("Not approved.");
  const { autoTranscriptsSince, transcriptOnItsWay } = await import("@/lib/cutTranscripts");
  const since = await autoTranscriptsSince(null);
  if (!since || !cut.decidedAt || cut.decidedAt < since) return no("Approved before automatic captions began.");
  if (cut.deliverableId) {
    const newer = await prisma.reviewSubmission.findFirst({ where: { projectId: cut.projectId, deliverableId: cut.deliverableId, slot: cut.slot, round: { gt: cut.round }, status: "APPROVED" }, select: { id: true } });
    if (newer) return no("A newer version of this video was approved.");
  }
  const video = cut.videoId
    ? await prisma.contentVideo.findUnique({ where: { id: cut.videoId } })
    : await prisma.contentVideo.findFirst({ where: { OR: [{ currentSubmissionId: cut.id }, { approvedSubmissionId: cut.id }, { finalSubmissionId: cut.id }] } });
  if (!video) return no("Not on the client's video library yet.");
  if (!(await assistantFor(video.clientId))) return no("The caption assistant doesn't reach this client.");
  if (await prisma.contentCaptionDraft.count({ where: { submissionId } })) return no("This version already has a caption.");
  const runs = await prisma.programAiRun.findMany({ where: { kind: "caption", scopeJson: { contains: `"autoFor":"${submissionId}"` } }, select: { status: true } });
  if (runs.some((r) => r.status !== "FAILED")) return no("Already drafted, or drafting now.");
  if (runs.filter((r) => r.status === "FAILED").length >= AUTO_CAPTION_MAX_FAILED) return no("Stopped after failed attempts.");
  const t = await transcriptForCut(submissionId).catch(() => null);
  if (!t?.text && now.getTime() - cut.decidedAt.getTime() < AUTO_CAPTION_WAIT_MS && (await transcriptOnItsWay(submissionId).catch(() => false))) {
    return no("Waiting for the transcript.");
  }
  const r = await draftCaptionRows({
    video, transcriptSubmissionId: submissionId, draftRef: submissionId, requestedBy: AUTO_REQUESTER, unattended: true,
    dedupeKey: `caption-auto:${submissionId}`, scope: { auto: true, autoFor: submissionId }, timeoutMs: opts.timeoutMs, auto: true,
  });
  if (!r.ok || !r.drafted) return { ...no(r.message), runId: r.runId ?? null, costCents: r.costCents };
  // The older version's automatic draft steps aside — never a person's caption,
  // and never the file the client still has (cutEntitlement keeps an approved v1
  // theirs until they approve this one).
  const e = await videoEntitlement(video).catch(() => null);
  const keep = [submissionId, e?.captionRef ?? null, e?.file?.submissionId ?? null].filter((x): x is string => !!x);
  await prisma.contentCaptionDraft.updateMany({
    where: { videoId: video.id, authorKind: "AI", status: "DRAFT", submissionId: { notIn: keep }, NOT: { submissionId: { startsWith: "portal-video:" } } },
    data: { status: "STALE", staleReason: "a newer version was approved" },
  }).catch(() => {});
  return { submissionId, drafted: true, why: r.message, costCents: r.costCents, runId: r.runId ?? null };
}

export type AutoCaptionSweep = { skipped: string | null; checked: number; drafted: number; waiting: number; deferred: number; costCents: number; results: { submissionId: string; why: string }[] };

/** The AI work job's step: draft the automatic captions owed, oldest approval first, each started only with time to finish. */
export async function sweepAutoCaptions(opts: { max?: number; budgetMs?: number; minStartMs?: number; now?: Date } = {}): Promise<AutoCaptionSweep> {
  const startedAt = Date.now();
  const left = () => (opts.budgetMs == null ? Infinity : opts.budgetMs - (Date.now() - startedAt));
  const out: AutoCaptionSweep = { skipped: null, checked: 0, drafted: 0, waiting: 0, deferred: 0, costCents: 0, results: [] };
  if (!(await isAutomationEnabled("caption_assistant"))) return { ...out, skipped: "caption_assistant is off" };
  if (!(await isAutomationEnabled("ai_runs"))) return { ...out, skipped: "AI runs are off" };
  const { aiOutageNow } = await import("@/lib/aiOutage");
  if (await aiOutageNow().catch(() => null)) return { ...out, skipped: "the AI account is refusing requests (usage limit or credit)" };
  const { autoTranscriptsSince } = await import("@/lib/cutTranscripts");
  const now = opts.now ?? new Date();
  // Written now if nothing wrote it yet: only versions approved from here on are captioned on their own.
  const since = await autoTranscriptsSince(now);
  if (!since) return { ...out, skipped: "automatic captions have not started" };
  const floor = new Date(Math.max(since.getTime(), now.getTime() - AUTO_CAPTION_DAYS * 86_400_000));
  const cuts = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", decidedAt: { gte: floor }, project: { contentMonthId: { not: null } } },
    orderBy: { decidedAt: "asc" }, take: 60, select: { id: true },
  });
  if (!cuts.length) return out;
  const captioned = new Set((await prisma.contentCaptionDraft.findMany({ where: { submissionId: { in: cuts.map((c) => c.id) } }, select: { submissionId: true } })).map((d) => d.submissionId));
  for (const c of cuts) {
    if (captioned.has(c.id)) continue;
    if (out.drafted >= (opts.max ?? 3)) break;
    if (left() < (opts.minStartMs ?? CAPTION_DRAFT_MIN_START_MS)) { out.deferred++; continue; }
    out.checked++;
    const r = await autoDraftCaptionForCut(c.id, { now, timeoutMs: Math.max(20_000, Math.min(120_000, left() - 10_000)) });
    out.costCents += r.costCents ?? 0;
    if (r.drafted) out.drafted++;
    else if (/Waiting for the transcript/.test(r.why)) out.waiting++;
    out.results.push({ submissionId: c.id, why: r.drafted ? "drafted" : r.why });
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE OFFICE'S VIEW (Oct 23 2026): the caption beside each video in Monthly
// Content, for Jordan and James, with Copy. The one the client would see first:
// their chosen one, else the newest that is not stale, else the newest.
// ---------------------------------------------------------------------------

export type StaffCaptionUi = {
  body: string;
  authorKind: string;
  status: string;
  versionNo: number;
  createdAtISO: string;
  /** Where it came from, in plain words ("drafted automatically from the transcript…"). */
  note: string;
  /** What the code changed on the model's draft (staff only). */
  fixes: string[];
  gaps: string[];
};

/**
 * "GENERATE AN INSTAGRAM CAPTION" (Jordan, Oct 24 2026: "any that don't have
 * captions, have a button that says generate an Instagram caption"). A
 * person's press from Monthly Content, for a video with an approved version
 * and no caption yet (older videos, approved before automatic captions began).
 * The transcript first: when the approved version has none, it is requested
 * and the transcript driver runs now (Deepgram reads a sub-minute video in
 * seconds); then one draft from the real spoken words, by the same engine and
 * rules as the automatic one. No transcript to be had → the script, and the
 * caption says so. The office's guard (requireCreativeLead) is the action's.
 */
export async function generateCaptionForStaff(videoId: string, by: { userId: string; name: string | null }): Promise<R & { drafted?: number }> {
  const video = await prisma.contentVideo.findUnique({ where: { id: videoId } });
  if (!video) return { ok: false, message: "That video no longer exists." };
  if (!(await assistantFor(video.clientId))) return { ok: false, message: "The caption assistant is switched off for this client." };
  const ids = [video.finalSubmissionId, video.approvedSubmissionId, video.currentSubmissionId].filter((x): x is string => !!x);
  const approved = ids.length
    ? await prisma.reviewSubmission.findFirst({ where: { id: { in: ids }, status: "APPROVED" }, orderBy: { round: "desc" }, select: { id: true } })
    : null;
  if (!approved) return { ok: false, message: "Approve a version of this video first: the caption is written from the approved video." };
  const { transcriptForCut, requestCutTranscript, runCutTranscriptDriver } = await import("@/lib/cutTranscripts");
  const had = await transcriptForCut(approved.id).catch(() => null);
  if (!had?.text) {
    await requestCutTranscript(approved.id, by.name ?? by.userId).catch(() => null);
    // A sub-minute video is read in seconds: start it with 15 s of room, not the cron's 45.
    await runCutTranscriptDriver({ limit: 3, budgetMs: 40_000, minStartMs: 15_000 }).catch(() => null);
  }
  const r = await draftCaptionRows({
    video, transcriptSubmissionId: approved.id, draftRef: approved.id, requestedBy: by.userId, unattended: false,
    // One run at a time per version (audit Oct 25 2026): the timestamp made
    // every key unique, so a double press paid for two drafts. aiRuns clears
    // the key when a run ends, so a later press still drafts again.
    dedupeKey: `caption-staff:${approved.id}`, scope: { staff: true },
  });
  return { ok: r.ok, message: r.message, ...(r.drafted != null ? { drafted: r.drafted } : {}) };
}

export async function staffCaptionsFor(videoIds: string[]): Promise<Map<string, StaffCaptionUi>> {
  const out = new Map<string, StaffCaptionUi>();
  if (!videoIds.length) return out;
  const rows = await prisma.contentCaptionDraft.findMany({
    where: { videoId: { in: videoIds }, kind: "CAPTION", status: { not: "ARCHIVED" } },
    orderBy: [{ versionNo: "desc" }],
    select: { videoId: true, body: true, authorKind: true, status: true, versionNo: true, createdAt: true, alternativesJson: true },
  });
  for (const id of videoIds) {
    const mine = rows.filter((r) => r.videoId === id);
    const pick = mine.find((r) => r.status === "CHOSEN") ?? mine.find((r) => r.status !== "STALE") ?? mine[0];
    if (!pick) continue;
    let alt: { sourceNote?: string; fixes?: string[]; gaps?: string[]; auto?: boolean } = {};
    try { alt = pick.alternativesJson ? (JSON.parse(pick.alternativesJson) as typeof alt) : {}; } catch { alt = {}; }
    const who = pick.authorKind === "CLIENT" ? "Written by the client" : pick.authorKind === "STAFF" ? "Written by the office" : alt.auto ? "Drafted automatically" : "Drafted on the client's request";
    const from = pick.authorKind === "AI" && alt.sourceNote ? `. ${alt.sourceNote.replace(/^Drafted /, "").replace(/^./, (ch) => ch.toUpperCase())}` : "";
    out.set(id, {
      body: pick.body, authorKind: pick.authorKind, status: pick.status, versionNo: pick.versionNo, createdAtISO: pick.createdAt.toISOString(),
      note: `${who}${from}${pick.status === "STALE" ? " (from an older version)" : ""}`,
      fixes: Array.isArray(alt.fixes) ? alt.fixes.filter((x): x is string => typeof x === "string") : [],
      gaps: Array.isArray(alt.gaps) ? alt.gaps.filter((x): x is string => typeof x === "string") : [],
    });
  }
  return out;
}
