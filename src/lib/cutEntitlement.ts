import "server-only";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { cutIdentityHash } from "@/lib/cutTranscripts";
import { DELIVERED_STAMP, NOT_A_CUT, streamUrlFor } from "@/lib/reviewCuts";
import { cutReleasedAt, sameVideoTitle, videoCutKey } from "@/lib/contentVideos";
import type { PortalViewer } from "@/lib/portal";

// ---------------------------------------------------------------------------
// THE ONE RELEASE RULE (completion audit CP-01, Sep 24 2026).
//
// "A completed production file and a client-approved video are different
// facts." Until today the portal treated them as one: resolveFinalFile served
// `finalSubmissionId ?? approvedSubmissionId`, and the sync set
// finalSubmissionId to the newest cut with completedAt — which Review Room
// approval stamps the moment the Dropbox copy lands. So an internally approved
// cut the client had never decided on downloaded, drafted captions and read
// "Delivered", and a replacement round inherited all of it because approving
// round N+1 nulls round N's completedAt. The stream route's `dl=1` was a
// second, ungated door to the same file, and a client's own change request
// on a finished cut still read "Download and post".
//
// Every surface that answers "may the client have THIS file" now asks here:
// the download door, the stream route's dl=1, caption draft and save, the
// library caches the sync writes, and (next) the staff month-progress reader.
//
// THE RULE, on one video's cut chain (every round of the same deliverable ×
// slot, or the same file name for legacy rows — contentVideos.videoCutKey):
//   · the DECISIVE round is the newest one the client was shown (released for
//     review, delivery-stamped, or marked sent by Kyle). Internal rounds they
//     never saw are skipped.
//   · only the decisive round's OWN decision counts. A replacement never
//     inherits an approval, and while one awaits a decision the earlier
//     approved version is NOT downloadable (Jordan's default; flipping it is
//     one branch in decideEntitlement).
//   · client approval unlocks it when the approval's recorded identity still
//     matches the cut (stableCutIdentity) and there are bytes to serve.
//   · a delivery made OUTSIDE the portal also unlocks it: Kyle's Mark-as-sent
//     (sentToClientAt — content cuts are never Aryeo-stamped, so that column
//     only ever means he pressed it), the delivery auto-stamp, or — before
//     CLIENT_APPROVAL_GATE_SINCE, when no real client held a seat — a DELIVERED
//     project or an imported historical month. That is the explicit exception
//     that keeps every older delivery downloadable, on ended and paused
//     accounts too.
//   · with no decisive round, an Aryeo-delivered file is the video's final —
//     unless the only thing tying it to a cut chain is list position.
// ---------------------------------------------------------------------------

/**
 * Before this instant no real client held a portal seat, so every earlier
 * content cut reached its client outside the portal (text, Aryeo, Dropbox).
 * Rounds decided before it are grandfathered by delivery facts; rounds after
 * it need the client's own decision or Kyle's Mark-as-sent. Midnight ET on the
 * day this rule shipped.
 */
export const CLIENT_APPROVAL_GATE_SINCE = new Date("2026-09-24T04:00:00Z");

const ID_RE = /^[a-z0-9]{10,40}$/i;

/** One round of a cut chain, with every field the rule and the stream route read. */
export const CHAIN_SELECT = {
  id: true, projectId: true, round: true, status: true, decidedAt: true, decidedBy: true, clientReleasedAt: true, clientRequestedAt: true,
  completedAt: true, sentToClientAt: true, assetUrl: true, assetPath: true, finalPath: true, blobUrl: true, blobPathname: true,
  sizeBytes: true, fileName: true, contentHash: true, deliverableId: true, slot: true, createdAt: true,
} as const;

export type ChainRound = {
  id: string; projectId: string; round: number; status: string; decidedAt: Date | null; decidedBy: string | null;
  clientReleasedAt: Date | null; clientRequestedAt: Date | null; completedAt: Date | null; sentToClientAt: Date | null;
  assetUrl: string | null; assetPath: string | null; finalPath: string | null; blobUrl: string | null; blobPathname: string | null;
  sizeBytes: number | null; fileName: string | null; contentHash: string | null; deliverableId: string | null; slot: number; createdAt: Date;
};

// ---- identity --------------------------------------------------------------

type IdentityInput = { id: string; contentHash: string | null; sizeBytes: number | null; fileName: string | null };

const ident2Of = (c: Pick<IdentityInput, "id" | "sizeBytes" | "fileName">): string =>
  `ident2:${createHash("sha256").update(["ident2", c.id, String(c.sizeBytes ?? ""), c.fileName ?? ""].join("\n")).digest("hex")}`;

/**
 * The identity a decision records for a cut: the real sha256 when a writer
 * ever fills ReviewSubmission.contentHash, else a hash of what does not move
 * when the STORAGE moves (id, size, name). cutIdentityHash also folded in the
 * blob URL and pathname, which pruneReviewUploads clears 90 days after
 * completion and the public→private store cutover rewrites — so every client
 * approval on a hub-uploaded cut would have voided itself on either event.
 */
export function stableCutIdentity(c: IdentityInput): string {
  return c.contentHash ?? ident2Of(c);
}

/**
 * Does the identity recorded on a decision still describe this cut? Judged by
 * the FORM it was recorded in, so a later real contentHash does not void an
 * ident2 approval, and a legacy `ident:` approval survives the storage release
 * it could never have anticipated (its file is then the filed Dropbox copy).
 */
export function decisionMatchesCut(recorded: string | null, c: IdentityInput & { blobUrl: string | null; blobPathname: string | null; assetPath: string | null; finalPath: string | null }): boolean {
  if (!recorded) return true;
  if (recorded.startsWith("ident2:")) return recorded === ident2Of(c);
  // A legacy `ident:` value folded in the blob URL. The private-store cutover
  // (scripts/_fix/R05/migrate-cut-store.ts) REWRITES that URL and pins the old
  // identity onto the row's contentHash — so the pin is the first thing
  // checked, or every legacy approval on a moved cut (and every new one, which
  // records the pinned value) would read as a changed file for good.
  if (recorded.startsWith("ident:")) return recorded === c.contentHash || recorded === cutIdentityHash({ ...c, contentHash: null }) || (!c.blobUrl && !!(c.assetPath || c.finalPath));
  return recorded === c.contentHash;
}

// ---- the pure core -----------------------------------------------------------

export type ApprovalFact = { id: string; actorLabel: string; decidedAt: Date; contentHash: string | null };

export type AryeoFinal = {
  portalVideoId: string;
  url: string;
  title: string | null;
  deliveredAt: Date | null;
  /** How the file is tied to this video's cut chain: "name" (the titles agree),
   *  "index" (only list position), null when the video has no chain. */
  matchBasis: "name" | "index" | null;
  /** A person confirmed the pairing. No column records that yet — CP-12's
   *  identity tool will; until then this is always false. */
  confirmed: boolean;
};

export type EntitlementFacts = {
  /** One video's rounds, oldest first, NOT_A_CUT excluded. */
  chain: ChainRound[];
  /** submissionId → the approval that is that round's LATEST live decision (this enrollment, not superseded). */
  approvals: Map<string, ApprovalFact>;
  /** submissionIds whose latest live decision is a change request. */
  changeRequests: Set<string>;
  /** submissionId → the approval that is that round's LATEST decision of any
   *  kind, INCLUDING rows a newer round's decision superseded. Read only by
   *  the KEEP_PRIOR_APPROVED_VERSION fallback. Omitted = none. */
  priorApprovals?: Map<string, ApprovalFact>;
  projectDelivered: boolean;
  projectDeliveredAt: Date | null;
  /** ContentMonth.historical || status IMPORTED. */
  monthHistorical: boolean;
  aryeoFinal: AryeoFinal | null;
  /** The enrollment is ACTIVE. A PAUSED or ENDED program is read-only in the
   *  portal (portal.accessFor) — nobody, staff included, can approve there —
   *  so a delivery fact the gate would otherwise wait past is taken as it is.
   *  Omitted = active. */
  enrollmentActive?: boolean;
};

export type FinalFile = {
  kind: "cut" | "delivered";
  /** Raw URL: a hub stream URL (the page mints the media token) or an Aryeo CDN file. */
  url: string;
  submissionId: string | null;
  fileName: string | null;
  label: string; // "v2 (approved)" | "v2 (final)" | "Delivered file"
  approvedByLabel: string | null;
  approvedAtISO: string | null;
  /** Kept for readers of the old shape: a file is only ever handed out when it is true. */
  hashOk: boolean;
};

export type EntitlementBasis = "CLIENT_APPROVED" | "HISTORICAL_DELIVERY" | "DELIVERED_OUTSIDE_PORTAL" | "NONE";
export type EntitlementBlock = "AWAITING_DECISION" | "CHANGES_REQUESTED" | "HASH_DRIFT" | "NO_FILE" | "UNCONFIRMED_PAIRING";

export type Entitlement = {
  basis: EntitlementBasis;
  /** The decisive round and the client's standing on it. */
  current: { submissionId: string; round: number; state: "AWAITING" | "APPROVED" | "CHANGES_REQUESTED" } | null;
  /** Set exactly when the client may download it. */
  file: FinalFile | null;
  /** What a caption is tied to: the cut id, or "portal-video:<id>" for an Aryeo-only file. */
  captionRef: string | null;
  blockedBy: EntitlementBlock | null;
  /** Client-safe reason when nothing is served — or, when an earlier approved
   *  version is being served (priorVersion), a note that says so. */
  why: string | null;
  deliveredAt: Date | null;
  /** The file is an EARLIER version than `current` (KEEP_PRIOR_APPROVED_VERSION). */
  priorVersion?: boolean;
};

/**
 * Jordan, Sep 24 2026: when a client approved v1 and we release a fixed v2 for
 * them to review, v1 STAYS downloadable until they approve v2 — including
 * while they have asked for changes on v2. v2 still needs its own approval
 * before IT can be downloaded; nothing is inherited. false = only the newest
 * released version's own approval counts.
 */
export const KEEP_PRIOR_APPROVED_VERSION = true;

export const WHY = {
  AWAITING: "Approve this version above to unlock the download and captions.",
  /** The same block, said to a seat that cannot approve (the emailed link, a collaborator, a viewer). */
  AWAITING_OWNER: "The download and captions unlock once the account owner approves this version.",
  CHANGES: "You asked for changes to this version — the new one will ask for its own approval, and the download and captions unlock with it.",
  DRIFT: "The file behind your approval has changed since you approved it — we're re-issuing it for approval before it can be downloaded.",
  REISSUE: "We're re-issuing this video's file — it'll be back here shortly. Text us if you need it now.",
  UNPAIRED: "We're confirming which delivered file belongs to this video — it'll be here once we've matched it. Text us if you need it now.",
  NOT_YET_CUT: "The final file lands here once this version is approved and finished.",
  NOT_YET: "No file yet — it appears here once the video is edited and delivered.",
  PRIOR: "This is the version you approved. The newer version is waiting for your review above; its download unlocks once you approve it.",
} as const;

/** What the stream route can actually serve (stream/route.ts: blob first, then the Dropbox path). */
const hasBytes = (c: ChainRound) => !!c.assetUrl && !!(c.blobUrl || c.assetPath || c.finalPath);

/**
 * THE RULE. Pure: every loader below, and the sync, gathers the facts and
 * calls this — nothing restates it.
 */
export function decideEntitlement(f: EntitlementFacts, opts: { gateSince?: Date } = {}): Entitlement {
  const e = decideForDecisiveRound(f, opts);
  if (!KEEP_PRIOR_APPROVED_VERSION || e.basis !== "NONE" || !e.current) return e;
  if (e.blockedBy !== "AWAITING_DECISION" && e.blockedBy !== "CHANGES_REQUESTED") return e;
  const prior = priorApprovedVersion(f, e.current.submissionId, opts);
  return prior ? { ...prior, current: e.current, why: WHY.PRIOR, priorVersion: true } : e;
}

/**
 * The newest round BEFORE the decisive one that the client could already
 * download on its own terms: their own identity-matching approval of it, or a
 * delivery of it, with bytes behind it. Never a round they sent back.
 */
function priorApprovedVersion(f: EntitlementFacts, decisiveId: string, opts: { gateSince?: Date }): Entitlement | null {
  const idx = f.chain.findIndex((c) => c.id === decisiveId);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const r = f.chain[i];
    if (!hasBytes(r) || f.changeRequests.has(r.id)) continue;
    const approval = f.priorApprovals?.get(r.id) ?? f.approvals.get(r.id) ?? null;
    if (approval && decisionMatchesCut(approval.contentHash, r)) {
      return {
        basis: "CLIENT_APPROVED", current: null, captionRef: r.id, blockedBy: null, why: null, deliveredAt: approval.decidedAt,
        file: { kind: "cut", url: r.assetUrl ?? streamUrlFor(r.id), submissionId: r.id, fileName: r.fileName, label: `v${r.round} (approved)`, approvedByLabel: approval.actorLabel, approvedAtISO: approval.decidedAt.toISOString(), hashOk: true },
      };
    }
    // A version delivered to them outside the portal (or before the gate) is
    // theirs too: judge it by the same rule as if it were the only round.
    const alone = decideForDecisiveRound({ ...f, chain: f.chain.slice(0, i + 1), aryeoFinal: null }, opts);
    if (alone.file && alone.file.submissionId === r.id && alone.basis !== "CLIENT_APPROVED") return { ...alone, current: null };
  }
  return null;
}

function decideForDecisiveRound(f: EntitlementFacts, opts: { gateSince?: Date } = {}): Entitlement {
  const gate = (opts.gateSince ?? CLIENT_APPROVAL_GATE_SINCE).getTime();
  const preGate = (c: ChainRound) => (c.decidedAt ?? c.completedAt ?? c.createdAt).getTime() < gate;
  const active = f.enrollmentActive !== false;
  // Before the gate every released content cut reached its client OUTSIDE the
  // portal (the premise above), so a pre-gate round the Review Room approved or
  // finished is a delivery whatever the project's status. Reading only a
  // DELIVERED project or a historical month locked every finished video of a
  // month still in EDITING over one outstanding cut — for good on an ended
  // account, where nobody can approve (review, Sep 24).
  const preGateDelivered = (c: ChainRound) => preGate(c) && (f.projectDelivered || f.monthHistorical || !!c.completedAt || c.status === "APPROVED");
  // A paused or ended program cannot approve anything, so the gate would wait
  // for ever: an Aryeo-delivered project counts as the delivery it is.
  const delivered = (c: ChainRound) => !!c.sentToClientAt || c.decidedBy === DELIVERED_STAMP || preGateDelivered(c) || (!active && f.projectDelivered);

  const decisive = [...f.chain].reverse().find((c) => !!cutReleasedAt(c) || c.decidedBy === DELIVERED_STAMP || !!c.sentToClientAt) ?? null;
  const approval = decisive ? f.approvals.get(decisive.id) ?? null : null;
  const requested = !!decisive && !approval && f.changeRequests.has(decisive.id);
  const current: Entitlement["current"] = decisive
    ? { submissionId: decisive.id, round: decisive.round, state: approval ? "APPROVED" : requested ? "CHANGES_REQUESTED" : "AWAITING" }
    : null;
  const approvalOk = !!approval && !!decisive && decisionMatchesCut(approval.contentHash, decisive);
  const none = (blockedBy: EntitlementBlock, why: string): Entitlement => ({ basis: "NONE", current, file: null, captionRef: null, blockedBy, why, deliveredAt: null });
  const cutFile = (c: ChainRound, label: string): FinalFile => ({
    kind: "cut", url: c.assetUrl ?? streamUrlFor(c.id), submissionId: c.id, fileName: c.fileName, label,
    approvedByLabel: approvalOk ? approval!.actorLabel : null, approvedAtISO: approvalOk ? approval!.decidedAt.toISOString() : null, hashOk: true,
  });

  // The client sent THIS version back. Their own decision outranks a delivery
  // fact: a file they rejected is not "ready to post", whoever sent it.
  if (decisive && requested) return none("CHANGES_REQUESTED", WHY.CHANGES);

  let lostFile = false;
  if (decisive && delivered(decisive)) {
    if (hasBytes(decisive)) {
      const basis: EntitlementBasis = preGate(decisive) || f.monthHistorical ? "HISTORICAL_DELIVERY" : "DELIVERED_OUTSIDE_PORTAL";
      const deliveredAt = decisive.sentToClientAt
        ?? (decisive.decidedBy === DELIVERED_STAMP ? decisive.decidedAt : null)
        ?? (f.projectDelivered ? f.projectDeliveredAt : null)
        ?? decisive.completedAt ?? decisive.decidedAt ?? decisive.createdAt;
      return { basis, current, file: cutFile(decisive, `v${decisive.round} (final)`), captionRef: decisive.id, blockedBy: null, why: null, deliveredAt };
    }
    lostFile = true; // delivered, but the file behind it is gone — an Aryeo copy may still stand in
  } else if (decisive) {
    if (!approval) return none("AWAITING_DECISION", WHY.AWAITING);
    if (!approvalOk) return none("HASH_DRIFT", WHY.DRIFT);
    if (!hasBytes(decisive)) return none("NO_FILE", WHY.REISSUE);
    return { basis: "CLIENT_APPROVED", current, file: cutFile(decisive, `v${decisive.round} (approved)`), captionRef: decisive.id, blockedBy: null, why: null, deliveredAt: approval.decidedAt };
  }

  const a = f.aryeoFinal;
  // Pairing by list position is only held back where it could matter: a chain
  // that is still going through the client's review. On a month or a project
  // delivered before the gate the file is this client's own finished delivery
  // — at worst under the wrong title — and nothing (no CP-12 tool yet) would
  // ever confirm it, so holding it locked a historical delivery for good.
  const pairingSettled = !!a && (a.confirmed || a.matchBasis !== "index" || f.chain.length === 0 || f.monthHistorical
    || (f.projectDelivered && (!f.projectDeliveredAt || f.projectDeliveredAt.getTime() < gate)) || f.chain.every(preGate));
  if (a && pairingSettled) {
    return {
      basis: "DELIVERED_OUTSIDE_PORTAL", current,
      file: { kind: "delivered", url: a.url, submissionId: null, fileName: a.title, label: "Delivered file", approvedByLabel: null, approvedAtISO: null, hashOk: true },
      captionRef: `portal-video:${a.portalVideoId}`, blockedBy: null, why: null, deliveredAt: a.deliveredAt,
    };
  }
  if (a) return none("UNCONFIRMED_PAIRING", WHY.UNPAIRED);
  // Told apart on purpose: "the file we had is not there" is not the same news
  // as "there is no file yet", and only one of them needs someone to act.
  if (lostFile) return none("NO_FILE", WHY.REISSUE);
  return none("NO_FILE", f.chain.length ? WHY.NOT_YET_CUT : WHY.NOT_YET);
}

/**
 * Fold decision rows into the two sets the rule reads: per submission, only
 * the LATEST live decision counts (an approval after a change request
 * approves; a change request after an approval sends it back). Rows must
 * already be fenced to one enrollment and exclude superseded ones.
 */
export function foldDecisions(rows: { id: string; submissionId: string; decision: string; actorLabel: string; decidedAt: Date; contentHash: string | null }[]): { approvals: Map<string, ApprovalFact>; changeRequests: Set<string> } {
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = latest.get(r.submissionId);
    if (!prev || r.decidedAt.getTime() > prev.decidedAt.getTime() || (r.decidedAt.getTime() === prev.decidedAt.getTime() && r.id > prev.id)) latest.set(r.submissionId, r);
  }
  const approvals = new Map<string, ApprovalFact>();
  const changeRequests = new Set<string>();
  for (const [sid, r] of latest) {
    if (r.decision === "APPROVE") approvals.set(sid, { id: r.id, actorLabel: r.actorLabel, decidedAt: r.decidedAt, contentHash: r.contentHash });
    else if (r.decision === "REQUEST_CHANGES") changeRequests.add(sid);
  }
  return { approvals, changeRequests };
}

/** Is an Aryeo file tied to this chain by its title, or only by position? */
export function aryeoMatchBasis(title: string | null, chain: { fileName: string | null }[]): "name" | "index" | null {
  if (chain.length === 0) return null;
  return chain.some((c) => sameVideoTitle(title, c.fileName)) ? "name" : "index";
}

// ---- loaders -----------------------------------------------------------------

/**
 * Every round of the video this cut belongs to, oldest first. One chain for
 * approval, history and the library alike — including legacy rows, where the
 * Review Room's own key (the file PATH) split "X v1.mov" and "X v2.mov" into
 * two chains and let the older one pass approveCut's "is this current" check.
 */
export async function cutChainOf(anchorId: string): Promise<ChainRound[]> {
  if (!ID_RE.test(anchorId)) return [];
  const anchor = await prisma.reviewSubmission.findUnique({ where: { id: anchorId }, select: CHAIN_SELECT });
  if (!anchor) return [];
  const key = videoCutKey(anchor);
  const rounds = await prisma.reviewSubmission.findMany({
    where: { projectId: anchor.projectId, status: { notIn: [...NOT_A_CUT] } },
    orderBy: [{ round: "asc" }, { createdAt: "asc" }],
    select: CHAIN_SELECT,
  });
  return rounds.filter((r) => videoCutKey(r) === key);
}

/** The ContentVideo columns the loaders read (a full row satisfies it). */
export type EntitlementVideo = {
  id: string; enrollmentId: string; clientId: string; monthId: string | null;
  currentSubmissionId: string | null; approvedSubmissionId: string | null; finalSubmissionId: string | null;
};

/**
 * The rule for MANY videos at once — a fixed handful of queries however long
 * the list, so a roster or a month-progress reader never goes N+1. Reads the
 * cuts, decisions, project, month flags and Aryeo source directly; the
 * library's cached pointers are used only to FIND each video's chain.
 */
export async function entitlementsForVideos(videos: EntitlementVideo[], opts: { gateSince?: Date } = {}): Promise<Map<string, Entitlement>> {
  const out = new Map<string, Entitlement>();
  if (videos.length === 0) return out;
  // The cached pointers are plain ids with no foreign key: a take-back
  // (removeCut) deletes the round currentSubmissionId still names until the
  // next sync, and a dangling first pointer used to leave the video with an
  // EMPTY chain — "no file" on a video whose approved v1 was decisive again.
  // So each pointer is tried in turn, and a video none of them resolves for
  // falls back to its cuts' own videoId, like an unpointed one.
  const candidates = new Map(videos.map((v) => [v.id, [v.currentSubmissionId, v.approvedSubmissionId, v.finalSubmissionId].filter((x): x is string => !!x)]));
  const pointedIds = [...new Set([...candidates.values()].flat())];
  const anchors = pointedIds.length ? await prisma.reviewSubmission.findMany({ where: { id: { in: pointedIds } }, select: CHAIN_SELECT }) : [];
  const anchorById = new Map<string, ChainRound>(anchors.map((a) => [a.id, a]));
  const pointer = new Map<string, string | null>(videos.map((v) => [v.id, candidates.get(v.id)!.find((id) => anchorById.has(id)) ?? null]));
  const unpointed = videos.filter((v) => !pointer.get(v.id)).map((v) => v.id);
  if (unpointed.length) {
    const subs = await prisma.reviewSubmission.findMany({ where: { videoId: { in: unpointed }, status: { notIn: [...NOT_A_CUT] } }, orderBy: [{ round: "desc" }, { createdAt: "desc" }], select: { ...CHAIN_SELECT, videoId: true } });
    for (const s of subs) {
      if (!s.videoId || pointer.get(s.videoId)) continue;
      pointer.set(s.videoId, s.id);
      anchorById.set(s.id, s);
    }
  }
  const projectIds = [...new Set([...pointer.values()].map((id) => (id ? anchorById.get(id)?.projectId : null)).filter((x): x is string => !!x))];
  const [rounds, projects] = await Promise.all([
    projectIds.length ? prisma.reviewSubmission.findMany({ where: { projectId: { in: projectIds }, status: { notIn: [...NOT_A_CUT] } }, orderBy: [{ round: "asc" }, { createdAt: "asc" }], select: CHAIN_SELECT }) : Promise.resolve([] as ChainRound[]),
    projectIds.length ? prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, clientId: true, status: true, deliveredAt: true, contentMonthId: true } }) : Promise.resolve([]),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const monthIds = [...new Set([...projects.map((p) => p.contentMonthId), ...videos.map((v) => v.monthId)].filter((x): x is string => !!x))];
  const [months, enrollments] = await Promise.all([
    monthIds.length ? prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: { id: true, enrollmentId: true, historical: true, status: true } }) : Promise.resolve([]),
    prisma.contentEnrollment.findMany({ where: { id: { in: [...new Set(videos.map((v) => v.enrollmentId))] } }, select: { id: true, status: true } }),
  ]);
  const monthById = new Map(months.map((m) => [m.id, m]));
  const enrollmentStatus = new Map(enrollments.map((e) => [e.id, e.status]));

  const chainOf = new Map<string, ChainRound[]>();
  const projectOf = new Map<string, (typeof projects)[number]>();
  for (const v of videos) {
    const a = anchorById.get(pointer.get(v.id) ?? "");
    const p = a ? projectById.get(a.projectId) : undefined;
    const m = p?.contentMonthId ? monthById.get(p.contentMonthId) : undefined;
    // A chain on another client's job, or on another program's month, is not
    // this video's — whatever a stale pointer says.
    if (!a || !p || p.clientId !== v.clientId || m?.enrollmentId !== v.enrollmentId) { chainOf.set(v.id, []); continue; }
    const key = videoCutKey(a);
    chainOf.set(v.id, rounds.filter((r) => r.projectId === a.projectId && videoCutKey(r) === key));
    projectOf.set(v.id, p);
  }
  const chainIds = [...new Set([...chainOf.values()].flat().map((r) => r.id))];
  const enrollmentIds = [...new Set(videos.map((v) => v.enrollmentId))];
  const [decisions, sources] = await Promise.all([
    chainIds.length
      ? prisma.clientDecision.findMany({ where: { submissionId: { in: chainIds }, enrollmentId: { in: enrollmentIds } }, select: { id: true, submissionId: true, enrollmentId: true, decision: true, actorLabel: true, decidedAt: true, contentHash: true, supersededById: true } })
      : Promise.resolve([]),
    prisma.contentVideoSource.findMany({ where: { videoId: { in: videos.map((v) => v.id) }, kind: "PORTAL_VIDEO", isFinal: true }, orderBy: { createdAt: "asc" }, select: { videoId: true, portalVideoId: true } }),
  ]);
  const pvIds = [...new Set(sources.map((s) => s.portalVideoId).filter((x): x is string => !!x))];
  const pvs = pvIds.length ? await prisma.portalVideo.findMany({ where: { id: { in: pvIds }, source: "aryeo" }, select: { id: true, enrollmentId: true, title: true, download: true, playback: true, deliveredAt: true } }) : [];
  const pvById = new Map(pvs.map((r) => [r.id, r]));

  for (const v of videos) {
    const chain = chainOf.get(v.id) ?? [];
    const ids = new Set(chain.map((c) => c.id));
    const mine = decisions.filter((d) => d.enrollmentId === v.enrollmentId && ids.has(d.submissionId));
    const { approvals, changeRequests } = foldDecisions(mine.filter((d) => !d.supersededById));
    const priorApprovals = foldDecisions(mine).approvals;
    const p = projectOf.get(v.id);
    const month = (v.monthId ? monthById.get(v.monthId) : undefined) ?? (p?.contentMonthId ? monthById.get(p.contentMonthId) : undefined);
    const pv = sources.filter((s) => s.videoId === v.id).map((s) => pvById.get(s.portalVideoId ?? "")).find((r) => !!r && r.enrollmentId === v.enrollmentId && !!(r.download || r.playback));
    const aryeoFinal: AryeoFinal | null = pv
      ? { portalVideoId: pv.id, url: (pv.download ?? pv.playback)!, title: pv.title, deliveredAt: pv.deliveredAt, matchBasis: aryeoMatchBasis(pv.title, chain), confirmed: false }
      : null;
    out.set(v.id, decideEntitlement({
      chain, approvals, changeRequests, priorApprovals,
      projectDelivered: p?.status === "DELIVERED", projectDeliveredAt: p?.deliveredAt ?? null,
      monthHistorical: !!month && (month.historical || month.status === "IMPORTED"),
      aryeoFinal,
      enrollmentActive: (enrollmentStatus.get(v.enrollmentId) ?? "ACTIVE") === "ACTIVE",
    }, opts));
  }
  return out;
}

/** The rule for one video. */
export async function videoEntitlement(video: EntitlementVideo): Promise<Entitlement> {
  return (await entitlementsForVideos([video])).get(video.id)!;
}

/**
 * May the client proven by `pair` (an enrollment and its client) download
 * THIS cut? True only when the cut is the file its video's entitlement serves.
 * The stream route's dl=1 asks this for any portal-proved request.
 */
export async function cutDownloadableFor(pair: { id: string; clientId: string }, submissionId: string): Promise<boolean> {
  if (!ID_RE.test(submissionId)) return false;
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { videoId: true } });
  if (!sub) return false;
  const v = sub.videoId
    ? await prisma.contentVideo.findUnique({ where: { id: sub.videoId } })
    : await prisma.contentVideo.findFirst({ where: { enrollmentId: pair.id, OR: [{ currentSubmissionId: submissionId }, { approvedSubmissionId: submissionId }, { finalSubmissionId: submissionId }] } });
  if (!v || v.enrollmentId !== pair.id || v.clientId !== pair.clientId) return false;
  const e = await videoEntitlement(v);
  return e.file?.kind === "cut" && e.file.submissionId === submissionId;
}

/**
 * What a caption for this video may be tied to — or why not yet. Caption
 * drafting and saving both go through here, BEFORE any switch or model call.
 */
export async function captionTarget(viewer: PortalViewer, video: EntitlementVideo): Promise<{ ok: true; submissionId: string | null; ref: string; entitlement: Entitlement } | { ok: false; message: string; entitlement: Entitlement | null }> {
  if (video.enrollmentId !== viewer.enrollment.id || video.clientId !== viewer.enrollment.clientId) return { ok: false, message: "That video isn't on your page.", entitlement: null };
  const e = await videoEntitlement(video);
  if (!e.file || !e.captionRef) return { ok: false, message: e.why ?? WHY.NOT_YET, entitlement: e };
  return { ok: true, submissionId: e.file.submissionId, ref: e.captionRef, entitlement: e };
}
