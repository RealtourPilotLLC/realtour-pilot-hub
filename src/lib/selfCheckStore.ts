import "server-only";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";
import { dbx } from "@/lib/integrations/dropbox";
import { VIDEO_TYPES } from "@/lib/videoStyles";
import {
  declarationsJson,
  parseDeclarations,
  resolveSelfCheckProfile,
  validateSelfCheck,
  isHeldForSelfCheck,
  type SelfCheckInput,
  type SelfCheckItem,
  type SelfCheckProfile,
} from "@/lib/selfCheck";

// ---------------------------------------------------------------------------
// THE SELF-CHECK, BOUND TO BYTES (unified handoff §8.2).
//
// The pure rules are in selfCheck.ts. This file is where an attestation meets
// a FILE and a ROW:
//   · an upload's check is written in the SAME transaction as the upload's
//     reservation (review/actions.startCutUpload), PENDING_BYTES, and bound at
//     finalize only when what landed is what was checked (size, and the name
//     the reservation was made for). The store's session-less completion
//     callback can bind it too, because the check hangs off the reservation,
//     not off anybody's login;
//   · a Final-folder cut is bound to Dropbox's content_hash, read at the moment
//     of the check — a re-export in place under the same name is new bytes and
//     VOIDS the check (approveCut / requestCutChanges re-read it);
//   · a cut the hub found on its own (the folder sweep), an upload whose bytes
//     did not match, and a moved cut are HELD: PENDING, not announced, not on
//     anybody's review list, waiting for the editor — or the office on their
//     behalf, recorded as such — to finish the check.
// Nothing here can make a check VALID except an attestation that passed
// validateSelfCheck against the list in force.
// ---------------------------------------------------------------------------

export const SELF_CHECK_SETTING = "editor_self_check";

type Overrides = Record<string, { version?: number; items?: SelfCheckItem[] } | undefined>;

export async function selfCheckOverrides(): Promise<Overrides> {
  return getSetting<Overrides>(SELF_CHECK_SETTING, {});
}

export async function profileForStyle(styleKey: string | null | undefined): Promise<SelfCheckProfile> {
  return resolveSelfCheckProfile(styleKey, await selfCheckOverrides().catch(() => ({})));
}

/** Which product a cut is — the Style Guide key behind cutSlots' label. A
 *  folder cut with no deliverable is its job's only video when the job owes
 *  one; otherwise it names no product and gets the default list. */
export async function styleOfSlot(projectId: string, deliverableId: string | null): Promise<string> {
  const { cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(projectId).catch(() => []);
  const s = deliverableId ? slots.find((x) => x.deliverableId === deliverableId) : slots.length === 1 ? slots[0] : null;
  return VIDEO_TYPES.find((t) => t.name === s?.deliverableLabel)?.key ?? "default";
}

export type SlotCheckContext = {
  /** slotKeyOf, or "folder" for a legacy file-keyed cut */
  key: string;
  profile: SelfCheckProfile;
  isRevision: boolean;
  issues: import("@/lib/revisionIssues").SlotIssue[];
};

/** Everything the dialog needs for one slot: the list in force, whether this
 *  is a revision, and the issues the editor has to account for. */
export async function checkContextForSlot(
  projectId: string,
  slot: { deliverableId: string | null; slot: number | null; assetPath?: string | null },
  opts: { round?: number | null } = {},
): Promise<SlotCheckContext> {
  const { slotKeyOf } = await import("@/lib/reviewCuts");
  const { openIssuesForSlot } = await import("@/lib/revisionIssues");
  const [styleKey, issues, earlier] = await Promise.all([
    styleOfSlot(projectId, slot.deliverableId),
    openIssuesForSlot(projectId, slot).catch(() => []),
    prisma.reviewSubmission.count({
      where: {
        projectId,
        status: { in: ["CHANGES_REQUESTED", "APPROVED", "SUPERSEDED"] },
        ...(slot.deliverableId ? { deliverableId: slot.deliverableId, slot: slot.slot ?? 1 } : slot.assetPath ? { assetPath: slot.assetPath } : { id: "__none__" }),
      },
    }).catch(() => 0),
  ]);
  return {
    key: slot.deliverableId ? slotKeyOf(slot.deliverableId, slot.slot) : "folder",
    profile: await profileForStyle(styleKey),
    isRevision: (opts.round ?? 1) > 1 || earlier > 0 || issues.length > 0,
    issues,
  };
}

/** One context per owed slot, for the upload panel — in a fixed handful of
 *  reads however many videos the job owes. */
export async function checkContextsForProject(projectId: string): Promise<Record<string, SlotCheckContext>> {
  const { cutSlots, slotKeyOf } = await import("@/lib/reviewCuts");
  const { openIssuesByCut } = await import("@/lib/revisionIssues");
  const [slots, overrides, issues, decided] = await Promise.all([
    cutSlots(projectId).catch(() => []),
    selfCheckOverrides().catch(() => ({})),
    openIssuesByCut(projectId).catch(() => ({ forCut: () => [] })),
    prisma.reviewSubmission
      .findMany({ where: { projectId, deliverableId: { not: null }, status: { in: ["CHANGES_REQUESTED", "APPROVED", "SUPERSEDED"] } }, select: { deliverableId: true, slot: true } })
      .catch(() => []),
  ]);
  const hadVersion = new Set(decided.map((r) => slotKeyOf(r.deliverableId!, r.slot)));
  const out: Record<string, SlotCheckContext> = {};
  for (const s of slots) {
    const key = slotKeyOf(s.deliverableId, s.slot);
    const slotIssues = issues.forCut({ deliverableId: s.deliverableId, slot: s.slot, assetPath: null });
    const styleKey = VIDEO_TYPES.find((t) => t.name === s.deliverableLabel)?.key ?? "default";
    out[key] = { key, profile: resolveSelfCheckProfile(styleKey, overrides), isRevision: hadVersion.has(key) || slotIssues.length > 0, issues: slotIssues };
  }
  return out;
}

export type CheckActor = {
  name: string;
  userId?: string | null;
  /** the actor's own editor key when they are the editor */
  editorKey?: string | null;
  /** OWNER/ADMIN attesting for a vendor or an editor */
  office?: boolean;
};

/** Validate an upload's check BEFORE anything is reserved. Returns the row to
 *  write inside the reservation's transaction. */
export async function prepareUploadCheck(input: {
  projectId: string;
  deliverableId: string;
  slot: number;
  fileName: string;
  sizeBytes: number;
  selfCheck: SelfCheckInput | null | undefined;
  actor: CheckActor;
  intendedEditorKey: string | null;
}): Promise<
  | { ok: true; row: { checklistKey: string; itemsJson: string; addressedIssueIdsJson: string; editorKey: string | null; actorUserId: string | null; actorName: string; onBehalfOf: string | null; attestedFileName: string; attestedSize: number } }
  | { ok: false; message: string; needsSelfCheck: true }
> {
  if (!input.selfCheck) return { ok: false, needsSelfCheck: true, message: "Complete the send-for-review check first — watch the export, then tick the list." };
  const ctx = await checkContextForSlot(input.projectId, { deliverableId: input.deliverableId, slot: input.slot });
  const v = validateSelfCheck(ctx.profile, input.selfCheck, { isRevision: ctx.isRevision, openIssueIds: ctx.issues.map((i) => i.id) });
  if (!v.ok) return { ok: false, needsSelfCheck: true, message: v.message };
  const wf = input.selfCheck.watchedFile;
  if (!wf || wf.name !== input.fileName || (wf.size != null && Number(wf.size) !== Math.floor(input.sizeBytes))) {
    return { ok: false, needsSelfCheck: true, message: "The check has to be for the file you are uploading — pick it again and re-tick the list." };
  }
  const forKey = input.actor.office ? input.intendedEditorKey : (input.actor.editorKey ?? null);
  return {
    ok: true,
    row: {
      checklistKey: ctx.profile.checklistKey,
      itemsJson: JSON.stringify(v.value.items),
      addressedIssueIdsJson: declarationsJson(v.value),
      editorKey: forKey,
      actorUserId: input.actor.userId ?? null,
      actorName: input.actor.name.slice(0, 120),
      onBehalfOf: input.actor.office ? (input.intendedEditorKey ?? "vendor") : null,
      attestedFileName: input.fileName.slice(0, 200),
      attestedSize: Math.floor(input.sizeBytes),
    },
  };
}

/** The file the reservation was made for, as the store names it: our path
 *  plus the store's random suffix before the extension. */
function pathMatchesName(pathname: string, projectId: string, submissionId: string, fileName: string, uploadPathnameFor: (p: string, s: string, n: string) => string): boolean {
  const expected = uploadPathnameFor(projectId, submissionId, fileName);
  const dot = expected.lastIndexOf(".");
  const stem = dot > expected.lastIndexOf("/") ? expected.slice(0, dot) : expected;
  const ext = dot > expected.lastIndexOf("/") ? expected.slice(dot).toLowerCase() : "";
  return pathname.startsWith(stem) && (!ext || pathname.toLowerCase().endsWith(ext));
}

/** The size the store actually holds, when the caller could not say (the
 *  store's completion callback carries none). null = could not read. */
async function storedSize(url: string): Promise<number | null> {
  try {
    const { ownCutObject } = await import("@/lib/reviewCuts");
    const owner = ownCutObject(url);
    if (!owner.ok) return null;
    const { head } = await import("@vercel/blob");
    const meta = await head(url, owner.token ? { token: owner.token } : undefined);
    return typeof meta.size === "number" ? meta.size : null;
  } catch {
    return null;
  }
}

/**
 * Bind an upload's check to the bytes that landed.
 *   valid      — same size and the reserved name: the check now names these bytes
 *   void       — a different file arrived; the row is held, the editor is told
 *   unverified — nothing could say what landed yet (retried by the next call)
 *   none       — a reservation from before the gate (grandfathered)
 *   already    — bound earlier
 */
export async function bindUploadCheck(
  sub: { id: string; projectId: string; fileName: string | null; selfCheckId: string | null },
  blob: { url: string; pathname: string; size?: number | null },
): Promise<"valid" | "void" | "unverified" | "none" | "already"> {
  if (!sub.selfCheckId) return "none";
  const check = await prisma.cutSelfCheck.findUnique({ where: { id: sub.selfCheckId } });
  if (!check) return "none";
  if (check.state === "VALID") return "already";
  if (check.state === "VOID") return "void";
  const size = blob.size ?? (await storedSize(blob.url));
  if (size == null) return "unverified";
  const { uploadPathnameFor } = await import("@/lib/reviewCuts");
  const nameOk = !!check.attestedFileName && pathMatchesName(blob.pathname, sub.projectId, sub.id, check.attestedFileName, uploadPathnameFor);
  const sizeOk = check.attestedSize != null && check.attestedSize === size;
  if (nameOk && sizeOk) {
    const { stableCutIdentity } = await import("@/lib/cutEntitlement");
    const won = await prisma.cutSelfCheck.updateMany({
      where: { id: check.id, state: "PENDING_BYTES" },
      data: { state: "VALID", fileIdentity: stableCutIdentity({ id: sub.id, contentHash: null, sizeBytes: size, fileName: sub.fileName }), sourceRev: `blob:${blob.pathname}` },
    });
    if (won.count === 0) return "already";
    const { applySelfCheckDeclarations } = await import("@/lib/revisionIssues");
    await applySelfCheckDeclarations(sub.id, parseDeclarations(check.addressedIssueIdsJson), { name: check.actorName, userId: check.actorUserId }).catch(() => {});
    return "valid";
  }
  const reason = !sizeOk
    ? `A different file arrived than the one checked (${size} bytes, the check was for ${check.attestedSize ?? "an unknown size"}).`
    : "A different file arrived than the one checked (the name does not match).";
  const won = await prisma.cutSelfCheck.updateMany({ where: { id: check.id, state: "PENDING_BYTES" }, data: { state: "VOID", voidReason: reason, voidedAt: new Date() } });
  if (won.count) await notifySelfCheckNeeded(sub.id, reason);
  return "void";
}

/** A cut the hub is holding for its check: the placeholder record says so
 *  (state VOID — no check has been given for these bytes), and it is what the
 *  row's selfCheckId points at, which is what makes the row HELD. Idempotent:
 *  a row already bound to a check is left alone. */
export async function holdForSelfCheck(submissionId: string, reason: string): Promise<boolean> {
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, outputId: true, deliverableId: true, slot: true, round: true, submittedByKey: true, selfCheckId: true, sourceRev: true },
  });
  if (!sub || sub.selfCheckId) return false;
  const placeholder = await prisma.cutSelfCheck.create({
    data: {
      submissionId: sub.id, projectId: sub.projectId, outputId: sub.outputId, deliverableId: sub.deliverableId, slot: sub.slot, round: sub.round,
      editorKey: sub.submittedByKey, actorName: "Hub", checklistKey: "none", itemsJson: "[]", sourceRev: sub.sourceRev,
      state: "VOID", voidReason: reason.slice(0, 300), voidedAt: new Date(),
    },
    select: { id: true },
  });
  const won = await prisma.reviewSubmission.updateMany({ where: { id: sub.id, selfCheckId: null }, data: { selfCheckId: placeholder.id } });
  return won.count > 0;
}

/** New bytes, a move, a drift: the check no longer describes what the
 *  reviewer would watch. `release` also takes the cut back out of review
 *  (selfCheckedAt cleared) so it is held until a fresh check. */
export async function voidSelfCheck(submissionId: string, reason: string, opts: { release?: boolean; notify?: boolean } = {}): Promise<void> {
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { selfCheckId: true } });
  if (!sub?.selfCheckId) return;
  await prisma.cutSelfCheck.updateMany({ where: { id: sub.selfCheckId, state: { not: "VOID" } }, data: { state: "VOID", voidReason: reason.slice(0, 300), voidedAt: new Date() } });
  if (opts.release) await prisma.reviewSubmission.updateMany({ where: { id: submissionId }, data: { selfCheckedAt: null } });
  if (opts.notify) await notifySelfCheckNeeded(submissionId, reason);
}

/** Dropbox's content_hash for a folder cut, or null when it can't be read. */
async function folderContentHash(path: string): Promise<{ ok: true; hash: string | null } | { ok: false }> {
  try {
    const meta = await dbx<{ content_hash?: string; rev?: string }>("files/get_metadata", { path });
    return { ok: true, hash: meta.content_hash ?? meta.rev ?? null };
  } catch {
    return { ok: false };
  }
}

/**
 * THE VERDICT'S OWN RE-READ for a Final-folder cut: are the bytes the reviewer
 * is about to rule on the bytes the editor checked? The stream route re-mints
 * a link to the PATH, so an in-place re-export would otherwise be approved on
 * the strength of a check made on a different file. Upload cuts are immutable
 * (a new file is a new version) and are never re-read.
 */
export async function folderDriftCheck(sub: {
  id: string; assetPath: string | null; blobUrl: string | null; selfCheckId: string | null; selfCheckedAt: Date | null; sourceRev: string | null;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (sub.blobUrl || !sub.assetPath || !sub.selfCheckId || !sub.selfCheckedAt || !sub.sourceRev) return { ok: true };
  const now = await folderContentHash(sub.assetPath);
  if (!now.ok) return { ok: false, message: "Dropbox couldn't be read to confirm this is the file the editor checked — try again in a minute." };
  if (!now.hash || now.hash === sub.sourceRev) return { ok: true };
  await voidSelfCheck(sub.id, "The file in the Final folder was replaced after the editor checked it.", { release: true, notify: true });
  return { ok: false, message: "The file in the Final folder changed after the editor checked it, so it's back with them for a fresh check — nothing was decided." };
}

/**
 * The editor (or the office for them) attests to a cut that already has a row
 * — a held folder cut, the button's claim, an upload whose bytes did not
 * match, a moved cut. Validates against the list in force, binds a VALID
 * check to the bytes as they are NOW, records the issue declarations. Does
 * NOT put the cut in review: the caller claims the entry (reviewCuts
 * claimReviewEntry / enterReview), so exactly one caller runs the side
 * effects however many attest at once.
 */
export async function attestRow(
  submissionId: string,
  input: SelfCheckInput | null | undefined,
  actor: CheckActor,
): Promise<{ ok: boolean; message: string; needsSelfCheck?: boolean; bound?: boolean; wasLegacy?: boolean }> {
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true, projectId: true, deliverableId: true, slot: true, round: true, status: true, outputId: true, fileName: true, assetPath: true, blobUrl: true,
      sizeBytes: true, contentHash: true, submittedByKey: true, submittedByName: true, selfCheckId: true, selfCheckedAt: true, createdAt: true,
    },
  });
  if (!sub) return { ok: false, message: "That cut no longer exists." };
  if (sub.status !== "PENDING") return { ok: false, message: "That version isn't waiting to go to review any more." };
  if (sub.selfCheckedAt) return { ok: true, message: "Already in review.", bound: false };
  const ctx = await checkContextForSlot(sub.projectId, { deliverableId: sub.deliverableId, slot: sub.slot, assetPath: sub.assetPath }, { round: sub.round });
  const v = validateSelfCheck(ctx.profile, input, { isRevision: ctx.isRevision, openIssueIds: ctx.issues.map((i) => i.id) });
  if (!v.ok) return { ok: false, message: v.message, needsSelfCheck: true };
  if (input?.watchedFile?.name && sub.fileName && input.watchedFile.name !== sub.fileName) {
    return { ok: false, needsSelfCheck: true, message: `You checked ${input.watchedFile.name}, but this version is ${sub.fileName} — check that one.` };
  }
  // WHICH BYTES. A folder cut: Dropbox's hash, now. An upload: its identity.
  let sourceRev: string | null = null;
  let fileIdentity: string | null = null;
  if (!sub.blobUrl && sub.assetPath) {
    const h = await folderContentHash(sub.assetPath);
    if (!h.ok) return { ok: false, message: "Dropbox couldn't be read to confirm the file — try again in a minute." };
    sourceRev = h.hash;
    fileIdentity = h.hash ? `dbx:${h.hash}` : null;
  } else {
    const { stableCutIdentity } = await import("@/lib/cutEntitlement");
    fileIdentity = stableCutIdentity({ id: sub.id, contentHash: sub.contentHash, sizeBytes: sub.sizeBytes, fileName: sub.fileName });
    sourceRev = sub.blobUrl ? "blob" : null;
  }
  const wasLegacy = !sub.selfCheckId;
  const forKey = actor.office ? (sub.submittedByKey ?? null) : (actor.editorKey ?? sub.submittedByKey ?? null);
  const check = await prisma.cutSelfCheck.create({
    data: {
      submissionId: sub.id, projectId: sub.projectId, outputId: sub.outputId, deliverableId: sub.deliverableId, slot: sub.slot, round: sub.round,
      editorKey: forKey, actorUserId: actor.userId ?? null, actorName: actor.name.slice(0, 120),
      onBehalfOf: actor.office ? (sub.submittedByKey ?? "vendor") : null,
      checklistKey: ctx.profile.checklistKey, itemsJson: JSON.stringify(v.value.items), addressedIssueIdsJson: declarationsJson(v.value),
      attestedFileName: sub.fileName, attestedSize: sub.sizeBytes, fileIdentity, sourceRev, state: "VALID",
    },
    select: { id: true },
  });
  // The row now points at THIS check, and — a sweep-found row nobody had
  // claimed — becomes the attesting editor's submission.
  const claim = !sub.submittedByKey && !actor.office && actor.editorKey ? { submittedByKey: actor.editorKey, submittedByName: actor.name } : {};
  // THE BIND AND THE SUPERSEDE ARE ONE STEP, under the row's lock (review fix,
  // Sep 25). They used to be two statements with a bind that only tested
  // selfCheckedAt: two attestations racing (the edit page's Finish-the-check
  // and the queue button in another tab) could each bind, then each void the
  // other's check, leaving the row pointing at a VOID check — held, both told
  // "the check didn't take", nothing announced. Now the bind is a
  // compare-and-set on the pointer this attestation READ: if another
  // attestation moved it meanwhile and its check stands (VALID), that one
  // wins and this one is recorded as the second attestation that bound to
  // nothing; the caller's claimReviewEntry then enters the cut on the winner.
  // A pointer that moved to something that is NOT a standing check (the sweep
  // parking a placeholder on a pre-gate row) is no contest — this binds over it.
  const loser = { state: "VOID" as const, voidReason: "Another check on this cut landed first.", voidedAt: new Date() };
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ReviewSubmission" WHERE "id" = ${sub.id} FOR UPDATE`;
    const now = await tx.reviewSubmission.findUnique({ where: { id: sub.id }, select: { status: true, selfCheckedAt: true, selfCheckId: true } });
    if (!now || now.status !== "PENDING" || now.selfCheckedAt) {
      await tx.cutSelfCheck.updateMany({ where: { id: check.id }, data: { ...loser, voidReason: "The cut had already entered review on another check." } });
      return "entered-elsewhere" as const;
    }
    if (now.selfCheckId !== sub.selfCheckId && now.selfCheckId) {
      const standing = await tx.cutSelfCheck.findUnique({ where: { id: now.selfCheckId }, select: { state: true } });
      if (standing?.state === "VALID") {
        await tx.cutSelfCheck.updateMany({ where: { id: check.id }, data: loser });
        return "lost" as const;
      }
    }
    await tx.reviewSubmission.updateMany({
      where: { id: sub.id, status: "PENDING", selfCheckedAt: null, selfCheckId: now.selfCheckId },
      data: { selfCheckId: check.id, ...(sourceRev && !sub.blobUrl ? { sourceRev } : {}), ...claim },
    });
    // Every OTHER record on this row (a placeholder, a mismatched upload's
    // check, an earlier attestation that never entered) is superseded — kept,
    // marked, never deleted. Inside the lock, so it can never void a check
    // another attestation has just bound.
    await tx.cutSelfCheck.updateMany({
      where: { submissionId: sub.id, id: { not: check.id }, state: { not: "VOID" } },
      data: { state: "VOID", voidReason: "Replaced by a later check.", voidedAt: new Date() },
    });
    return "bound" as const;
  });
  if (outcome === "entered-elsewhere") return { ok: true, message: "Already in review.", bound: false };
  if (outcome === "lost") return { ok: true, message: "Already checked — it goes to review on that check.", bound: false };
  const { applySelfCheckDeclarations } = await import("@/lib/revisionIssues");
  await applySelfCheckDeclarations(sub.id, v.value, { name: actor.name, userId: actor.userId ?? null }).catch(() => {});
  return { ok: true, message: "Checked.", bound: true, wasLegacy };
}

/** Attest, then enter review — for the doors whose entry lives in the library
 *  (an upload, a moved cut). A Final-folder cut goes through the editor's
 *  button instead (review/actions.submitCutForReview), which owns its close-out. */
export async function attestAndEnter(
  submissionId: string,
  input: SelfCheckInput | null | undefined,
  actor: CheckActor,
): Promise<{ ok: boolean; message: string; needsSelfCheck?: boolean; entered?: boolean }> {
  const a = await attestRow(submissionId, input, actor);
  if (!a.ok) return { ok: a.ok, message: a.message, needsSelfCheck: a.needsSelfCheck, entered: false };
  // A racing attestation that lost the bind still falls through to the entry:
  // claimReviewEntry is the one compare-and-set, so whichever caller reaches it
  // first enters the cut on the check that stands, and the other is a no-op.
  const { enterReview } = await import("@/lib/reviewCuts");
  if (!a.bound) {
    const r = await enterReview(submissionId);
    return { ok: true, entered: r.entered, message: r.entered ? `Checked and sent — ${r.message}` : a.message };
  }
  const r = await enterReview(submissionId);
  return { ok: true, entered: r.entered, message: r.entered ? `Checked and sent — ${r.message}` : r.held ? "The check didn't take — try again." : "Already in review." };
}

/** The cuts on a job waiting on their check, for the /edit page. */
export async function heldCutsFor(projectId: string): Promise<{ submissionId: string; round: number; fileName: string | null; deliverableId: string | null; slot: number | null; assetPath: string | null; reason: string | null; sizeBytes: number | null; context: SlotCheckContext }[]> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, status: "PENDING", selfCheckedAt: null, selfCheckId: { not: null } },
    orderBy: { round: "asc" },
    select: { id: true, round: true, fileName: true, deliverableId: true, slot: true, assetPath: true, sizeBytes: true, status: true, selfCheckedAt: true, selfCheckId: true, createdAt: true },
  });
  const held = rows.filter(isHeldForSelfCheck);
  const checks = held.length ? await prisma.cutSelfCheck.findMany({ where: { id: { in: held.map((h) => h.selfCheckId!) } }, select: { id: true, voidReason: true, state: true } }) : [];
  const out = [];
  for (const h of held) {
    const c = checks.find((x) => x.id === h.selfCheckId);
    out.push({
      submissionId: h.id, round: h.round, fileName: h.fileName, deliverableId: h.deliverableId, slot: h.slot, assetPath: h.assetPath, sizeBytes: h.sizeBytes,
      reason: c?.state === "PENDING_BYTES" ? "The upload landed but the hub could not confirm it is the file you checked." : c?.voidReason ?? null,
      context: await checkContextForSlot(projectId, { deliverableId: h.deliverableId, slot: h.slot, assetPath: h.assetPath }, { round: h.round }),
    });
  }
  return out;
}

/** The attestation on a version, for the reviewer's eyes. */
export async function attestationFor(submissionId: string): Promise<{
  actorName: string; onBehalfOf: string | null; editorKey: string | null; at: Date; checklistKey: string;
  items: { key: string; label: string; answer: string; reason: string | null }[];
  declarations: { addressed: string[]; notAddressed: Record<string, string> };
} | null> {
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { selfCheckId: true, selfCheckedAt: true } });
  if (!sub?.selfCheckId || !sub.selfCheckedAt) return null;
  const c = await prisma.cutSelfCheck.findUnique({ where: { id: sub.selfCheckId } });
  if (!c || c.state !== "VALID") return null;
  let items: { key: string; label: string; answer: string; reason: string | null }[] = [];
  try { items = JSON.parse(c.itemsJson); } catch { items = []; }
  return { actorName: c.actorName, onBehalfOf: c.onBehalfOf, editorKey: c.editorKey, at: c.createdAt, checklistKey: c.checklistKey, items, declarations: parseDeclarations(c.addressedIssueIdsJson) };
}

/** Bell-only, to the editor the cut is for and the office: a cut is waiting on
 *  a check. No text, no Slack — this is not a new external channel. */
export async function notifySelfCheckNeeded(submissionId: string, reason: string): Promise<void> {
  try {
    const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { id: true, projectId: true, round: true, fileName: true, submittedByKey: true, selfCheckId: true, project: { select: { title: true } } } });
    if (!sub) return;
    const { notifyInApp } = await import("@/lib/notify");
    const { TEAM_MEMBER_EDITOR_KEYS } = await import("@/lib/editors");
    const street = (sub.project?.title ?? "job").split(",")[0].trim();
    const href = `/edit/${sub.projectId}#self-check`;
    const targets: import("@/lib/notify").NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"], href }];
    if (sub.submittedByKey && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(sub.submittedByKey)) {
      targets.push({ roles: ["EDITOR"], userKey: `editor:${sub.submittedByKey}`, href });
    }
    await notifyInApp({
      kind: "self_check_needed",
      title: `Check needed before review — ${street}${sub.fileName ? ` · ${sub.fileName}` : ""}`,
      body: reason.slice(0, 140),
      href,
      targets,
      dedupeKey: `self-check-needed-${sub.id}-${sub.selfCheckId ?? "none"}`,
    });
  } catch { /* bell is best-effort */ }
}
