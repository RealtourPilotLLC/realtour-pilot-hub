import "server-only";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { cutIdentityHash } from "@/lib/cutTranscripts";
import { DELIVERED_STAMP, NOT_A_CUT, streamUrlFor } from "@/lib/reviewCuts";
import { cutReleasedAt, sameVideoTitle, videoCutKey } from "@/lib/contentVideos";
import type { PortalViewer } from "@/lib/portal";
import { TEXT_KYLE_START } from "@/lib/portalWords";

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
//     inherits an approval. While one awaits a decision (or the client asked
//     for changes on it) the EARLIER approved version stays downloadable —
//     Jordan, Sep 24: "approved v1 stays downloadable" (KEEP_PRIOR_APPROVED_
//     VERSION below; false restores the stricter reading in one branch of
//     decideEntitlement).
//   · client approval unlocks it when the approval's recorded identity still
//     matches the cut (stableCutIdentity) and there are bytes to serve.
//   · a delivery made OUTSIDE the portal also unlocks it: Kyle's Mark-as-sent
//     (an unmarked sentToClientAt), the delivery auto-stamp, or — before
//     CLIENT_APPROVAL_GATE_SINCE, when no real client held a seat — a DELIVERED
//     project or an imported historical month. That is the explicit exception
//     that keeps every older delivery downloadable, on ended and paused
//     accounts too.
//   · with no decisive round, an Aryeo-delivered file is the video's final —
//     unless the only thing tying it to a cut chain is list position.
//
// TOPAZ BEFORE RELEASE (unified handoff 9.6b, Sep 25 2026). Jordan: "When we
// approve the edit (which should be done first) it should run through topaz,
// and deliver to the client in the client portal, already ran through topaz."
// The approved cut is still the thing the client decides on — the decision and
// its identity stay bound to the ReviewSubmission — but for a PROGRAM cut the
// BYTES the client is handed are the verified 1080p render once one exists
// (clientCutFiles below). While the pass is still running, or its output is
// HELD because nobody could verify its sound (topazJobs O02), the client gets
// nothing in its place: the video reads as being finished, Kyle's Ready-to-send
// card owns it, and the editor's approved original stays where batch 1 put it.
// A pass that was skipped, failed, cancelled, or resolved by a reviewer as
// "keep the original" leaves the editor's export as the file — the same file
// the ready card offers Kyle in those cases.
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
  id: true, projectId: true, round: true, status: true, decidedAt: true, decidedBy: true, clientReleasedAt: true, portalPublicationRequiredAt: true, clientRequestedAt: true,
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
  /** A person confirmed the pairing: the source row carries confirmedAt, or
   *  staff relinked it (matchBasis "staff") with CP-12's identity tool. */
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
  /** 9.6b: per round, which bytes the CLIENT is handed (clientCutFiles). A
   *  round missing from the map — or the whole map omitted — is the editor's
   *  original, exactly as before. */
  clientFiles?: Map<string, ClientCutFile>;
  /** New monthly portal handoffs reuse sentToClientAt for operational history.
   * Their exact durable marker distinguishes them from older external sends;
   * availability for review is not the client's approval to download/post. */
  portalHandoffs?: Set<string>;
};

/**
 * WHICH BYTES OF A PROGRAM CUT THE CLIENT GETS (9.6b). Decided by the cut's
 * 1080p job alone:
 *   finishing  the pass still owes work, or finished and is HELD for a listen —
 *              the client is handed nothing, not the editor's export instead
 *   processed  the pass is done and its file was verified (or a reviewer
 *              listened and accepted it) — that file is the client's
 *   original   no pass, or it was skipped / failed / cancelled / resolved as
 *              "keep the original" — the editor's approved export
 */
export type ClientCutFile =
  | { kind: "finishing"; state: string }
  | { kind: "processed"; topazJobId: string; path: string; fileName: string }
  | { kind: "original" };

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
  /** 9.6b: the verified 1080p render of this cut, when THAT is what the client
   *  is handed (the stream route serves its Dropbox path for a portal proof).
   *  Absent = the editor's own export. */
  processed?: { topazJobId: string; path: string; fileName: string } | null;
};

export type EntitlementBasis = "CLIENT_APPROVED" | "HISTORICAL_DELIVERY" | "DELIVERED_OUTSIDE_PORTAL" | "NONE";
export type EntitlementBlock = "AWAITING_DECISION" | "CHANGES_REQUESTED" | "HASH_DRIFT" | "NO_FILE" | "UNCONFIRMED_PAIRING" | "FINISHING";

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
  REISSUE: `We're re-issuing this video's file — it'll be back here shortly. ${TEXT_KYLE_START} if you need it now.`,
  UNPAIRED: `We're confirming which delivered file belongs to this video — it'll be here once we've matched it. ${TEXT_KYLE_START} if you need it now.`,
  NOT_YET_CUT: "The final file lands here once this version is approved and finished.",
  NOT_YET: "No file yet — it appears here once the video is edited and delivered.",
  PRIOR: "This is the version you approved. The newer version is waiting for your review above; its download unlocks once you approve it.",
  /** 9.6b — the 1080p pass is running or its file is held for a listen. Client
   *  copy: plain words, no dash. */
  FINISHING: "This video is being finished. It will be ready here shortly.",
} as const;

/** What the stream route can actually serve (stream/route.ts: blob first, then the Dropbox path). */
const hasBytes = (c: ChainRound) => !!c.assetUrl && !!(c.blobUrl || c.assetPath || c.finalPath);

/**
 * THE RULE. Pure: every loader below, and the sync, gathers the facts and
 * calls this — nothing restates it.
 */
export function decideEntitlement(f: EntitlementFacts, opts: { gateSince?: Date } = {}): Entitlement {
  const e = withClientFile(decideForDecisiveRound(f, opts), f);
  if (!KEEP_PRIOR_APPROVED_VERSION || e.basis !== "NONE" || !e.current) return e;
  // FINISHING joins the two waits (9.6b): a v2 still in its 1080p pass is no
  // more the client's than a v2 awaiting their decision, so an approved v1
  // stays theirs meanwhile.
  if (e.blockedBy !== "AWAITING_DECISION" && e.blockedBy !== "CHANGES_REQUESTED" && e.blockedBy !== "FINISHING") return e;
  const prior = priorApprovedVersion(f, e.current.submissionId, opts);
  return prior ? { ...prior, current: e.current, why: WHY.PRIOR, priorVersion: true } : e;
}

/**
 * 9.6b, applied to whatever the rule decided: a cut file whose 1080p pass is
 * still finishing is withheld (never swapped for the editor's export), and one
 * with a verified render hands over the render. Every other answer — an Aryeo
 * file, a refusal, a cut with no 1080p job — passes through untouched.
 */
function withClientFile(e: Entitlement, f: EntitlementFacts): Entitlement {
  if (e.file?.kind !== "cut" || !e.file.submissionId || !f.clientFiles) return e;
  const cf = f.clientFiles.get(e.file.submissionId);
  if (!cf || cf.kind === "original") return e;
  if (cf.kind === "finishing") {
    return { basis: "NONE", current: e.current, file: null, captionRef: null, blockedBy: "FINISHING", why: WHY.FINISHING, deliveredAt: null };
  }
  return { ...e, file: { ...e.file, fileName: cf.fileName, processed: { topazJobId: cf.topazJobId, path: cf.path, fileName: cf.fileName } } };
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
    // An earlier round still in its own 1080p pass is not a fallback either.
    if (f.clientFiles?.get(r.id)?.kind === "finishing") continue;
    const approval = f.priorApprovals?.get(r.id) ?? f.approvals.get(r.id) ?? null;
    if (approval && decisionMatchesCut(approval.contentHash, r)) {
      return withClientFile({
        basis: "CLIENT_APPROVED", current: null, captionRef: r.id, blockedBy: null, why: null, deliveredAt: approval.decidedAt,
        file: { kind: "cut", url: r.assetUrl ?? streamUrlFor(r.id), submissionId: r.id, fileName: r.fileName, label: `v${r.round} (approved)`, approvedByLabel: approval.actorLabel, approvedAtISO: approval.decidedAt.toISOString(), hashOk: true },
      }, f);
    }
    // A version delivered to them outside the portal (or before the gate) is
    // theirs too: judge it by the same rule as if it were the only round.
    const alone = withClientFile(decideForDecisiveRound({ ...f, chain: f.chain.slice(0, i + 1), aryeoFinal: null }, opts), f);
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
  const delivered = (c: ChainRound) => (!!c.sentToClientAt && !f.portalHandoffs?.has(c.id)) || c.decidedBy === DELIVERED_STAMP || preGateDelivered(c) || (!active && f.projectDelivered && !f.portalHandoffs?.has(c.id));

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
  // — at worst under the wrong title, which staff now see flagged and fix with
  // CP-12's identity tool — so holding it would lock a historical delivery.
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

/** The two outcomes of the O02 check a finished render can carry. A "done" job
 *  from before the check was recorded (outputCheck null) is NOT treated as
 *  verified: its client keeps the editor's export, which is what every such
 *  client was already being served. */
const VERIFIED_OUTPUT = new Set(["verified", "resolved-processed"]);

/** The marker and sent stamp are committed together by the monthly handoff.
 * Match all three identifiers; an unrelated audit row is not delivery proof.
 * A failed read must propagate, never turn a new handoff into a legacy send. */
export async function monthlyPortalHandoffsFor(submissionIds: string[]): Promise<Set<string>> {
  if (submissionIds.length === 0) return new Set();
  const rows = await prisma.auditLog.findMany({
    where: { id: { in: submissionIds.map((id) => `monthly-portal-handoff:${id}`) }, action: "monthly_portal_handoff", target: { in: submissionIds } },
    select: { id: true, target: true },
  });
  return new Set(rows.filter((row) => row.id === `monthly-portal-handoff:${row.target}`).map((row) => row.target));
}

/**
 * The name a client's download is saved under: the video's own name (the
 * editor's export, which is what the page has been calling it), with the
 * finished file's extension. The Dropbox name — "… - v1 - FINAL (Topaz).mp4"
 * — is the office's filing word, not the client's.
 */
function clientFileName(cutName: string | null, processedPath: string): string {
  const processed = processedPath.split("/").pop() || "video.mp4";
  const ext = processed.match(/\.[a-z0-9]{2,4}$/i)?.[0] ?? ".mp4";
  const stem = (cutName ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").trim();
  return stem ? `${stem}${ext}` : processed;
}

/**
 * 9.6b — the bytes the CLIENT is handed, per program cut: a fixed two queries
 * however many ids. Cuts that are not on a program month, and cuts with no
 * 1080p job, are left out of the map (= the editor's original), so listing
 * work and the Review Room are untouched by construction.
 *
 * "Still finishing" is read through readyToSend.laneStillOwesWork — the one
 * list of terminal 1080p states — so a state added to the lane later can only
 * make a client wait, never hand them the wrong file. HELD is in it: finished
 * and paid for, but not the client's until a person decides.
 *
 * The hold is for cuts whose delivery IS the portal. A cut the client already
 * has by another road — Kyle marked it sent, the delivery auto-stamp, or a round
 * decided before the portal gate (CLIENT_APPROVAL_GATE_SINCE) — keeps its file
 * while a later pass (a "Try again") runs: taking a delivered video back off a
 * client's page for half an hour would help nobody.
 *
 * …AND SO DOES ONE THE PORTAL ITSELF ALREADY GAVE THEM (review, Sep 25). A
 * program cut whose pass failed or was skipped is served as the editor's
 * export; the client approves it (the cut's live approval pointer,
 * clientApprovedDecisionId — cleared when a reopen sets the approval aside)
 * and downloads it. A later "Try again", or a render queued by hand, used to
 * put that cut back to "being finished": the download door 404'd and the
 * player 409'd on a video the client had approved and had, indefinitely if
 * the re-run ended HELD. §3 keeps prior approved downloads. The client keeps
 * the file they approved while the pass runs, and gets the render once it is
 * verified (the `processed` branch below does not look at this). A client
 * cannot approve a version while it is finishing — the page has no player or
 * decision for it — so this never hands out the editor's export in place of a
 * render the client was still waiting for.
 */
export async function clientCutFiles(submissionIds: string[]): Promise<Map<string, ClientCutFile>> {
  const out = new Map<string, ClientCutFile>();
  const ids = [...new Set(submissionIds.filter((x) => ID_RE.test(x)))];
  if (ids.length === 0) return out;
  const pending = await prisma.reviewSubmission.findMany({ where: { id: { in: ids }, portalPublicationRequiredAt: { not: null }, clientReleasedAt: null }, select: { id: true, topazJob: { select: { state: true, finalPath: true, savedAt: true, outputCheck: true } } } });
  for (const cut of pending) {
    const job = cut.topazJob;
    if (!(job?.state === "done" && job.finalPath && job.savedAt && VERIFIED_OUTPUT.has(job.outputCheck ?? ""))) out.set(cut.id, { kind: "finishing", state: job?.state ?? "awaiting-render" });
  }
  const jobs = await prisma.topazJob.findMany({
    where: { submissionId: { in: ids }, submission: { project: { contentMonthId: { not: null } } } },
    select: {
      id: true, submissionId: true, state: true, finalPath: true, savedAt: true, outputCheck: true,
      submission: { select: { fileName: true, sentToClientAt: true, decidedBy: true, decidedAt: true, clientApprovedDecisionId: true } },
    },
  });
  if (jobs.length === 0) return out;
  const portalHandoffs = await monthlyPortalHandoffsFor(jobs.map((job) => job.submissionId));
  const { laneStillOwesWork } = await import("@/lib/readyToSend");
  const gate = CLIENT_APPROVAL_GATE_SINCE.getTime();
  for (const j of jobs) {
    if (out.has(j.submissionId)) continue;
    if (laneStillOwesWork(j.state)) {
      const s = j.submission;
      const deliveredElsewhere =
        !!s && ((!!s.sentToClientAt && !portalHandoffs.has(j.submissionId)) || s.decidedBy === DELIVERED_STAMP || (!!s.decidedAt && s.decidedAt.getTime() < gate) || !!s.clientApprovedDecisionId);
      out.set(j.submissionId, deliveredElsewhere ? { kind: "original" } : { kind: "finishing", state: j.state });
      continue;
    }
    if (j.state === "done" && j.finalPath && j.savedAt && VERIFIED_OUTPUT.has(j.outputCheck ?? "")) {
      out.set(j.submissionId, { kind: "processed", topazJobId: j.id, path: j.finalPath, fileName: clientFileName(j.submission?.fileName ?? null, j.finalPath) });
      continue;
    }
    out.set(j.submissionId, { kind: "original" });
  }
  return out;
}

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
  const [decisions, sources, clientFiles, portalHandoffs] = await Promise.all([
    chainIds.length
      ? prisma.clientDecision.findMany({ where: { submissionId: { in: chainIds }, enrollmentId: { in: enrollmentIds } }, select: { id: true, submissionId: true, enrollmentId: true, decision: true, actorLabel: true, decidedAt: true, contentHash: true, supersededById: true } })
      : Promise.resolve([]),
    prisma.contentVideoSource.findMany({ where: { videoId: { in: videos.map((v) => v.id) }, kind: "PORTAL_VIDEO", isFinal: true }, orderBy: { createdAt: "asc" }, select: { videoId: true, portalVideoId: true, matchBasis: true, confirmedAt: true } }),
    clientCutFiles(chainIds),
    monthlyPortalHandoffsFor(chainIds),
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
    const src = sources.filter((s) => s.videoId === v.id).find((s) => { const r = pvById.get(s.portalVideoId ?? ""); return !!r && r.enrollmentId === v.enrollmentId && !!(r.download || r.playback); });
    const pv = src ? pvById.get(src.portalVideoId!)! : null;
    // CP-12: the only thing read from the pairing record is whether a PERSON
    // stood behind it. How it was paired is still judged from the titles here,
    // so a stale matchBasis can never make a weak pairing look strong.
    const aryeoFinal: AryeoFinal | null = pv
      ? { portalVideoId: pv.id, url: (pv.download ?? pv.playback)!, title: pv.title, deliveredAt: pv.deliveredAt, matchBasis: aryeoMatchBasis(pv.title, chain), confirmed: !!src!.confirmedAt || src!.matchBasis === "staff" }
      : null;
    out.set(v.id, decideEntitlement({
      chain, approvals, changeRequests, priorApprovals,
      projectDelivered: p?.status === "DELIVERED", projectDeliveredAt: p?.deliveredAt ?? null,
      monthHistorical: !!month && (month.historical || month.status === "IMPORTED"),
      aryeoFinal,
      enrollmentActive: (enrollmentStatus.get(v.enrollmentId) ?? "ACTIVE") === "ACTIVE",
      clientFiles, portalHandoffs,
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
