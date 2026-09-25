import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { transcriptForCut } from "@/lib/cutTranscripts";
import { canonicalFromParts, partsFromBody, pointsFromJson } from "@/lib/contentScripts";
import { renderScript, buildCaptionPrompt, type CanonicalScript } from "@/lib/contentPolicy";
import { videoForEnrollment } from "@/lib/contentVideos";
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
// "Download started" / "Saved" and "Marked as posted by me", that are never a
// verified publication (that is §12's job and it is disabled).
//
// Caption drafting: never unattended from the portal. A client's "Draft a
// caption" runs only when `caption_assistant` is ON (a missing row is OFF,
// programAutomation.ts) and it is a person's click (unattended:false), so the
// ai_runs master switch does not gate it but the feature switch does. When
// transcriptForCut reports a gap the draft is made from the script and the
// kit says so in plain words — it never pretends a transcript existed.
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
  captions: CaptionView[];
  transcript: { text: string | null; gap: string | null; source: string | null };
  /** `historical` = an imported record we hold, shown as history — never re-labelled as this video’s script. */
  script: { title: string; body: string; versionLabel: string | null; strategyLabel: string | null; historical: boolean } | null;
  postedAtISO: string | null;
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
  const { final, note, entitlement: e } = await resolveFinalFile(video);
  // The transcript shown is the ENTITLED cut's — the one a caption would be
  // drafted from. Stale-marking compares against the decisive round too, so
  // drafts of a replaced cut go STALE as soon as the replacement is released.
  const kitSubmissionId = final?.submissionId ?? null;
  const staleAgainst = kitSubmissionId ?? e.current?.submissionId ?? null;
  // "Approve this version above" is only true for a seat that can approve —
  // and on a paused or ended program NO seat can (every viewer is READ_ONLY,
  // staff included), so "once the account owner approves" would promise
  // something that cannot happen. Kyle can send the file instead.
  const why = e.blockedBy === "AWAITING_DECISION" && viewer.access !== "FULL"
    ? `Your program is ${viewer.enrollment.status === "ENDED" ? "ended" : "paused"}, so this version can't be approved here and its download isn't open. Call or text Kyle at ${URGENT_CONTACT} and he'll get you the file.`
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
    prisma.contentVideoSource.findFirst({ where: { videoId: video.id, kind: "PORTAL_VIDEO" }, select: { portalVideoId: true } }).then(async (s) => (s?.portalVideoId ? (await prisma.portalVideo.findUnique({ where: { id: s.portalVideoId }, select: { thumb: true } }))?.thumb ?? null : null)),
    isAutomationEnabled("caption_assistant"),
    downloadPlanFor(e).catch(() => (e.file ? { mode: "redirect" as const, fileName: e.file.fileName, sizeBytes: null, ref: e.captionRef } : null)),
  ]);
  // Any AI draft tied to a cut that is no longer the final is STALE (spec §10):
  // stamp it rather than serving it as if it described the current file.
  const stale = captions.filter((c) => c.status !== "STALE" && staleAgainst && c.submissionId !== staleAgainst && !c.submissionId.startsWith("portal-video:"));
  if (stale.length) {
    await prisma.contentCaptionDraft.updateMany({ where: { id: { in: stale.map((c) => c.id) } }, data: { status: "STALE", staleReason: "cut changed" } }).catch(() => {});
    for (const c of stale) { c.status = "STALE"; c.staleReason = "cut changed"; }
  }
  return {
    videoId: video.id,
    title: video.title ?? "Video",
    final, finalNote: why, cover,
    captions: captions.map(captionView),
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
    transcript: { text: transcript.text, gap: transcript.gap, source: transcript.source },
    script: script ? { title: script.title, body: script.body, versionLabel: script.versionLabel, strategyLabel: script.strategyLabel, historical: script.historical } : null,
    postedAtISO: video.postedByClientAt?.toISOString() ?? null,
    downloadStartedAtISO: lastStarted?.createdAt.toISOString() ?? null,
    downloadCompletedAtISO: lastCompleted?.createdAt.toISOString() ?? null,
    download,
    assistant: { enabled: assistantOn, why: assistantOn ? null : "Caption drafting is switched off until the program launches — we'll write your caption with the script for now, or you can write one below." },
    access: { download: !!e.file, captions: !!e.captionRef, why, blockedBy: e.blockedBy, basis: e.basis },
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
  // The release rule first, the switch second: a caption for a version the
  // client has not approved is refused whether or not the assistant is on.
  // It used to draft from `final ?? approved ?? CURRENT` — the unapproved
  // review cut — gated by the switch alone.
  const target = await captionTarget(viewer, v);
  if (!target.ok) return { ok: false, message: target.message };
  if (!(await isAutomationEnabled("caption_assistant"))) {
    return { ok: false, message: `Caption drafting is switched off until the program launches — write your caption below and it's saved with this video, or ${TEXT_KYLE} and we'll draft one.` };
  }
  const submissionId = target.submissionId;
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
  // buildCaptionPrompt refuses a prompt whose pieces belong to different
  // clients (contentPolicy/prompts.assertClientScoped), and that refusal is a
  // THROW. It reads CanonicalScript.clientId — a column a client dedupe merge
  // leaves pointing at the merged-away client — so the same stale row that the
  // version fence above now survives would land here as an unhandled 500 on
  // the client's own page. Still refuse, but as an answer.
  let bundle: ReturnType<typeof buildCaptionPrompt>;
  try {
    bundle = buildCaptionPrompt(built.ctx, canonical);
  } catch {
    return { ok: false, message: `We can't draft this one automatically — the records behind this video don't line up. ${TEXT_KYLE_START} and we'll write the caption with you.` };
  }
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
  const draftSubmissionId = target.ref;
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
