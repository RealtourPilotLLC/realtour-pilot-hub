import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripMoneySentences } from "@/lib/text";
import { cutSlots, owedSlotKeyOf, slotKeyOf, videoLaneRevisionWhere } from "@/lib/reviewCuts";
import { CAUSE_LABEL, isIssueCause, ISSUE_CATEGORIES, ISSUE_SEVERITIES, type IssueCause } from "@/lib/issueCauses";
import { parseDeclarations, SELF_CHECK_REQUIRED_SINCE } from "@/lib/selfCheck";

// ---------------------------------------------------------------------------
// REVISION ISSUES (unified handoff §8.3, Sep 25 2026).
//
// "Capture actionable issues against the output and exact version … The editor
// marks an issue addressed; the reviewer verifies. A repeated unresolved
// instruction reopens its issue rather than being duplicated … Reassignment
// preserves authorship of each submitted version. Keep revision rounds,
// individual issues, and billable/included client revisions separate."
//
// What this layer is, and what it is NOT:
//   · One row per actionable ask, keyed to its SOURCE (@@unique sourceKind ×
//     sourceId), so re-ingesting a note or a brief makes nothing new — the
//     idempotence is the database's, not a hope.
//   · It READS the existing records — a Review Room note (MediaNote), a work
//     order item (RevisionBrief.itemsJson) — and never replaces them. The edit
//     card's round text, the brief ticks and the note statuses all still work;
//     the legacy toggles are MIRRORED into issue state here.
//   · Portal comments are NOT ingested on their own: the portal already folds
//     them into a pinned RevisionBrief (CP-03), so ingesting both would count
//     one ask twice.
//   · It never touches ContentRevisionRound (the client's included/billable
//     rounds), payroll, bonus, kpi.ts or QcRecord. A cause is a reviewer's
//     call; nothing here writes `cause` except classifyIssue.
//   · No history is backfilled as editor error. Rows ingested from notes that
//     predate the ship are flagged imported=true and stay UNCLASSIFIED.
// ---------------------------------------------------------------------------

export type IssueActor = { name: string; userId?: string | null };

type Tx = Prisma.TransactionClient | typeof prisma;

const LIVE = ["OPEN", "REOPENED", "ADDRESSED"];
const NEEDS_EDITOR = ["OPEN", "REOPENED"];

async function event(
  db: Tx,
  issueId: string,
  kind: string,
  actor: IssueActor,
  extra: { from?: string | null; to?: string | null; submissionId?: string | null; note?: string | null } = {},
): Promise<void> {
  await db.revisionIssueEvent
    .create({
      data: {
        issueId,
        kind,
        fromValue: extra.from ?? null,
        toValue: extra.to ?? null,
        submissionId: extra.submissionId ?? null,
        actorName: actor.name.slice(0, 120),
        actorUserId: actor.userId ?? null,
        note: extra.note ? extra.note.slice(0, 500) : null,
      },
    })
    .catch(() => {});
}

const SYSTEM: IssueActor = { name: "Hub" };

/** A cut note's key names its submission (reviewCuts.cutNoteKey). */
function submissionIdFromNoteKey(assetUrl: string | null | undefined): string | null {
  if (!assetUrl) return null;
  if (assetUrl.startsWith("cut:")) return assetUrl.slice(4) || null;
  const m = /\/api\/review\/cut\/([^/]+)\/stream/.exec(assetUrl);
  return m ? m[1] : null;
}

/** The editor holding the job's video work right now — the edit card first,
 *  then an open video-lane revision. Null = nobody (a vendor job Kyle runs). */
async function currentVideoAssignee(projectId: string): Promise<string | null> {
  const card = await prisma.smartTask
    .findUnique({ where: { dedupeKey: `edit-video-${projectId}` }, select: { assignedKey: true, status: true } })
    .catch(() => null);
  if (card?.assignedKey && card.status !== "CANCELLED") return card.assignedKey;
  const rev = await prisma.smartTask
    .findFirst({ where: { ...videoLaneRevisionWhere(projectId), assignedKey: { not: null } }, orderBy: { createdAt: "desc" }, select: { assignedKey: true } })
    .catch(() => null);
  return rev?.assignedKey ?? null;
}

/** Who MADE a version: the editor key on the row, else — an office upload of
 *  an editor's or a vendor's file — the editor its accepted check was for. */
async function versionAuthor(sub: { submittedByKey: string | null; selfCheckId?: string | null } | null): Promise<string | null> {
  if (!sub) return null;
  if (sub.submittedByKey) return sub.submittedByKey;
  if (!sub.selfCheckId) return null;
  const c = await prisma.cutSelfCheck.findUnique({ where: { id: sub.selfCheckId }, select: { editorKey: true, state: true } }).catch(() => null);
  return c?.state === "VALID" ? c.editorKey : null;
}

// ---------------------------------------------------------------------------
// INGESTION
// ---------------------------------------------------------------------------

/**
 * A Review Room note becomes an issue: EDITOR-lane ROOT notes that ask for a
 * fix, written by someone other than the editor (the editor's own notes are
 * context for the reviewer, exactly as requestCutChanges already treats them).
 * Idempotent on the note id. Never throws.
 */
export async function ingestReviewNote(noteId: string, opts: { imported?: boolean } = {}): Promise<string | null> {
  try {
    const n = await prisma.mediaNote.findUnique({ where: { id: noteId } });
    if (!n || n.parentId || n.lane !== "EDITOR" || n.kind === "coaching") return null;
    if ((n.authorKey ?? "").startsWith("editor:")) return null;
    const existing = await prisma.revisionIssue.findUnique({ where: { sourceKind_sourceId: { sourceKind: "REVIEW_NOTE", sourceId: n.id } }, select: { id: true } });
    if (existing) return existing.id;
    const subId = submissionIdFromNoteKey(n.assetUrl);
    const sub = subId
      ? await prisma.reviewSubmission.findUnique({ where: { id: subId }, select: { id: true, projectId: true, deliverableId: true, slot: true, outputId: true, submittedByKey: true, selfCheckId: true, status: true } })
      : null;
    const author = (await versionAuthor(sub)) ?? n.editorKey ?? null;
    const assigned = (await currentVideoAssignee(n.projectId)) ?? author;
    try {
      const row = await prisma.revisionIssue.create({
        data: {
          projectId: n.projectId,
          outputId: sub?.outputId ?? null,
          deliverableId: sub?.deliverableId ?? null,
          slot: sub?.deliverableId ? sub.slot ?? 1 : null,
          raisedOnSubmissionId: sub?.id ?? null,
          sourceKind: "REVIEW_NOTE",
          sourceId: n.id,
          sourceChannel: n.photographerId ? "photographer" : "review_room",
          raisedByKey: n.authorKey,
          raisedByName: n.authorName,
          originalText: n.body.slice(0, 4000),
          timeSec: n.timeSec,
          versionEditorKey: author,
          assignedEditorKey: assigned,
          // A note on a version already signed off is a defect the reviewer
          // found after approving — the client-visible-defects KPI reads it.
          foundAfterApproval: sub?.status === "APPROVED",
          imported: opts.imported ?? n.createdAt.getTime() < SELF_CHECK_REQUIRED_SINCE.getTime(),
        },
        select: { id: true },
      });
      await event(prisma, row.id, "RAISED", { name: n.authorName ?? "Reviewer" }, { submissionId: sub?.id ?? null });
      return row.id;
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") {
        const again = await prisma.revisionIssue.findUnique({ where: { sourceKind_sourceId: { sourceKind: "REVIEW_NOTE", sourceId: n.id } }, select: { id: true } });
        return again?.id ?? null;
      }
      throw e;
    }
  } catch (e) {
    console.error("[issues] note ingest failed", noteId, e);
    return null;
  }
}

type BriefItemShape = { id: string; ask: string; area?: string | null; quote?: string | null; detail?: string | null; cuts?: string[] | null; scope?: string };

/** Is this brief about the VIDEO lane? A photo retouch ask is Kyle's and must
 *  never become an editor issue. A portal (pinned) brief is always a video. */
async function briefIsVideoLane(brief: { projectId: string; taskId: string | null; submissionId: string | null }): Promise<boolean> {
  if (brief.submissionId) return true;
  if (!brief.taskId) return false;
  const n = await prisma.smartTask
    .count({ where: { AND: [videoLaneRevisionWhere(brief.projectId, { anyStatus: true }), { id: brief.taskId }] } })
    .catch(() => 0);
  return n > 0;
}

/**
 * The work order's items become issues — one per item × owed video it names
 * (`${briefId}:${itemId}:${slotKey}`); an item nobody could place is ONE
 * job-level issue (slot null). A brief short enough to have no analysis is
 * one job-level issue for its whole text. Re-running after a re-analysis
 * reconciles instead of duplicating: items that vanished are marked Not
 * needed with a `reanalysed` event, new ones are minted. Never throws.
 */
export async function ingestBriefItems(briefId: string): Promise<number> {
  try {
    const brief = await prisma.revisionBrief.findUnique({
      where: { id: briefId },
      select: { id: true, projectId: true, taskId: true, submissionId: true, outputId: true, roundId: true, source: true, sourceDetail: true, originalText: true, itemsJson: true, analyzedAt: true, createdAt: true },
    });
    if (!brief || !(await briefIsVideoLane(brief))) return 0;
    let items: BriefItemShape[] = [];
    try { items = brief.itemsJson ? ((JSON.parse(brief.itemsJson) as { items?: BriefItemShape[] }).items ?? []) : []; } catch { items = []; }
    // No items has two meanings. Never analysed (a short ask, or the model
    // failed): the whole text is the one ask. Analysed to NOTHING: the message
    // held no edit at all (revisionBrief.standDownNonRevision re-files it as a
    // question) — so there is no issue, and any earlier one stands down below.
    const readAsNoEdits = items.length === 0 && !!brief.analyzedAt && !!brief.itemsJson;
    if (items.length === 0 && !readAsNoEdits) items = [{ id: "whole", ask: brief.originalText.slice(0, 1000), area: "Other", cuts: null, scope: "unknown" }];

    const slots = await cutSlots(brief.projectId).catch(() => []);
    const owedKeys = slots.map((s) => slotKeyOf(s.deliverableId, s.slot));
    // Where each owed video stands NOW — the version the ask is about.
    const rounds = await prisma.reviewSubmission.findMany({
      where: { projectId: brief.projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
      orderBy: { round: "asc" },
      select: { id: true, deliverableId: true, slot: true, status: true, submittedByKey: true, selfCheckId: true, outputId: true, assetPath: true },
    });
    const latestByKey = new Map<string, (typeof rounds)[number]>();
    for (const r of rounds) {
      const k = owedSlotKeyOf(r, owedKeys);
      if (k) latestByKey.set(k, r);
    }
    const assigned = await currentVideoAssignee(brief.projectId);

    const wanted: { sourceId: string; item: BriefItemShape; slotKey: string | null }[] = [];
    for (const it of items) {
      const keys = (it.cuts ?? []).filter(Boolean);
      // One owed video: every ask is about it — the analyser's own rule.
      const placed = keys.length ? keys : owedKeys.length === 1 ? [owedKeys[0]] : [];
      if (placed.length === 0) wanted.push({ sourceId: `${brief.id}:${it.id}:job`, item: it, slotKey: null });
      for (const k of placed) wanted.push({ sourceId: `${brief.id}:${it.id}:${k}`, item: it, slotKey: k });
    }

    let made = 0;
    for (const w of wanted) {
      const latest = w.slotKey ? latestByKey.get(w.slotKey) ?? null : null;
      const [deliverableId, slotStr] = w.slotKey ? w.slotKey.split(":") : [null, null];
      const text = (w.item.quote || w.item.ask || "").trim() || brief.originalText.slice(0, 1000);
      const author = await versionAuthor(latest);
      try {
        const row = await prisma.revisionIssue.create({
          data: {
            projectId: brief.projectId,
            outputId: latest?.outputId ?? (w.slotKey && brief.outputId ? brief.outputId : null),
            deliverableId,
            slot: slotStr ? Number(slotStr) || 1 : null,
            raisedOnSubmissionId: latest?.id ?? null,
            sourceKind: "BRIEF_ITEM",
            sourceId: w.sourceId,
            sourceChannel: brief.source,
            sourceDetail: brief.sourceDetail,
            raisedByName: "Client",
            originalText: text.slice(0, 4000),
            summary: w.item.ask ? w.item.ask.slice(0, 300) : null,
            category: (ISSUE_CATEGORIES as readonly string[]).includes(w.item.area ?? "") ? (w.item.area as string) : "Other",
            versionEditorKey: author,
            assignedEditorKey: assigned ?? author,
            // The client found it on a version we had already approved.
            foundAfterApproval: latest?.status === "APPROVED",
            contentRoundId: brief.roundId,
            imported: brief.createdAt.getTime() < SELF_CHECK_REQUIRED_SINCE.getTime(),
          },
          select: { id: true },
        });
        made++;
        await event(prisma, row.id, "RAISED", { name: "Client" }, { submissionId: latest?.id ?? null, note: brief.source });
      } catch (e) {
        if ((e as { code?: string })?.code !== "P2002") throw e;
      }
    }

    // A re-analysis renumbered the items: what vanished is not an ask any more.
    const keep = new Set(wanted.map((w) => w.sourceId));
    const stale = await prisma.revisionIssue.findMany({
      where: { sourceKind: "BRIEF_ITEM", sourceId: { startsWith: `${brief.id}:` }, state: { in: NEEDS_EDITOR } },
      select: { id: true, sourceId: true, state: true },
    });
    for (const s of stale) {
      if (keep.has(s.sourceId)) continue;
      const moved = await prisma.revisionIssue.updateMany({ where: { id: s.id, state: s.state }, data: { state: "NOT_APPLICABLE" } });
      if (moved.count) await event(prisma, s.id, "REANALYSED", SYSTEM, { from: s.state, to: "NOT_APPLICABLE", note: "The request was re-read and this item is no longer in it." });
    }
    return made;
  } catch (e) {
    console.error("[issues] brief ingest failed", briefId, e);
    return 0;
  }
}

/** Has a person already acted on this brief's issues? Then a re-analysis would
 *  renumber work somebody classified, fixed or verified — refused. */
export async function briefIssuesLocked(briefId: string): Promise<boolean> {
  const n = await prisma.revisionIssue
    .count({
      where: {
        sourceKind: "BRIEF_ITEM",
        sourceId: { startsWith: `${briefId}:` },
        OR: [{ causeConfirmedAt: { not: null } }, { state: { in: ["ADDRESSED", "VERIFIED", "REOPENED", "DUPLICATE"] } }],
      },
    })
    .catch(() => 0);
  return n > 0;
}

// ---------------------------------------------------------------------------
// WHICH ISSUES BELONG TO A CUT
// ---------------------------------------------------------------------------

type CutShape = { id: string; projectId: string; deliverableId: string | null; slot: number | null; assetPath: string | null; createdAt: Date; round: number };
type IssueRow = Awaited<ReturnType<typeof prisma.revisionIssue.findMany>>[number];

/** The job's slot keys plus a resolver from an issue to the cut it is on. */
async function cutKeying(projectId: string) {
  const slots = await cutSlots(projectId).catch(() => []);
  const owedKeys = slots.map((s) => slotKeyOf(s.deliverableId, s.slot));
  const subs = await prisma.reviewSubmission.findMany({
    where: { projectId },
    select: { id: true, deliverableId: true, slot: true, assetPath: true, round: true },
  });
  const byId = new Map(subs.map((s) => [s.id, s]));
  const keyOfSub = (s: { id: string; deliverableId: string | null; slot: number | null; assetPath: string | null }) =>
    owedSlotKeyOf(s, owedKeys) ?? s.assetPath ?? s.id;
  const keyOfIssue = (i: Pick<IssueRow, "deliverableId" | "slot" | "raisedOnSubmissionId">): string | null => {
    if (i.deliverableId) return slotKeyOf(i.deliverableId, i.slot);
    const s = i.raisedOnSubmissionId ? byId.get(i.raisedOnSubmissionId) : null;
    return s ? keyOfSub(s) : null;
  };
  const labelOfKey = new Map(slots.map((s) => [slotKeyOf(s.deliverableId, s.slot), s.label]));
  return { owedKeys, byId, keyOfSub, keyOfIssue, labelOfKey };
}

/**
 * Issues on this cut: the same video (slot, or the file for a legacy folder
 * cut), plus job-level asks. `forGate` narrows job-level asks to one-video
 * jobs — on a four-video month an ask nobody placed cannot hold up video 1.
 */
async function issuesForCut(cut: CutShape, states: string[], opts: { forGate?: boolean } = {}): Promise<IssueRow[]> {
  const k = await cutKeying(cut.projectId);
  const mine = k.keyOfSub(cut);
  const rows = await prisma.revisionIssue.findMany({
    where: { projectId: cut.projectId, state: { in: states }, duplicateOfId: null },
    orderBy: { createdAt: "asc" },
  });
  return rows.filter((i) => {
    const ik = k.keyOfIssue(i);
    if (ik) return ik === mine;
    return !opts.forGate || k.owedKeys.length <= 1;
  });
}

export type SlotIssue = { id: string; text: string; category: string; timeSec: number | null; state: string; raisedByName: string | null; fromRound: number | null };

/** What the self-check asks the editor to account for on a slot: every issue
 *  still waiting on them, plus any they flagged fixed by hand that no version
 *  has carried yet (the check binds those to this submission). Money-scrubbed
 *  — an editor reads this. */
export async function openIssuesForSlot(
  projectId: string,
  slot: { deliverableId: string | null; slot: number | null; assetPath?: string | null },
): Promise<SlotIssue[]> {
  const all = await openIssuesByCut(projectId);
  return all.forCut({ deliverableId: slot.deliverableId, slot: slot.slot, assetPath: slot.assetPath ?? null });
}

/** The same answer for every cut on a job in one read — the upload panel asks
 *  for all of its slots at once, and a sixteen-video month must not cost
 *  sixteen passes over the ledger. `forCut` = that cut's own issues plus the
 *  job-level ones. */
export async function openIssuesByCut(projectId: string): Promise<{ forCut: (c: { deliverableId: string | null; slot: number | null; assetPath: string | null }) => SlotIssue[] }> {
  const k = await cutKeying(projectId);
  await syncBriefTicks(projectId);
  const rows = await prisma.revisionIssue.findMany({
    where: {
      projectId,
      duplicateOfId: null,
      OR: [{ state: { in: NEEDS_EDITOR } }, { state: "ADDRESSED", addressedInSubmissionId: null }],
    },
    orderBy: { createdAt: "asc" },
  });
  const view = (i: (typeof rows)[number]): SlotIssue => ({
    id: i.id,
    text: stripMoneySentences(i.summary || i.originalText) || "(a note mentioned pricing — ask Jordan)",
    category: i.category,
    timeSec: i.timeSec,
    state: i.state,
    raisedByName: i.raisedByName,
    fromRound: i.raisedOnSubmissionId ? k.byId.get(i.raisedOnSubmissionId)?.round ?? null : null,
  });
  const keyed = rows.map((i) => ({ key: k.keyOfIssue(i), v: view(i) }));
  return {
    forCut(c) {
      const mine = k.keyOfSub({ id: "__new__", deliverableId: c.deliverableId, slot: c.slot, assetPath: c.assetPath });
      return keyed.filter((x) => (x.key ? x.key === mine : true)).map((x) => x.v);
    },
  };
}

// ---------------------------------------------------------------------------
// STATE CHANGES
// ---------------------------------------------------------------------------

/** The editor's check accepted: what they declared fixed is ADDRESSED in this
 *  version, what they declared not done is recorded with their reason (the
 *  state stays with them). Idempotent per (issue, submission). */
export async function applySelfCheckDeclarations(
  submissionId: string,
  decl: { addressed: string[]; notAddressed: Record<string, string> },
  actor: IssueActor,
): Promise<void> {
  const now = new Date();
  for (const id of decl.addressed) {
    const cur = await prisma.revisionIssue.findUnique({ where: { id }, select: { state: true, addressedInSubmissionId: true } });
    if (!cur || !LIVE.includes(cur.state)) continue;
    if (cur.state === "ADDRESSED" && cur.addressedInSubmissionId === submissionId) continue;
    const won = await prisma.revisionIssue.updateMany({
      where: { id, state: cur.state },
      data: { state: "ADDRESSED", addressedAt: now, addressedBy: actor.name.slice(0, 120), addressedInSubmissionId: submissionId },
    });
    if (won.count) await event(prisma, id, "ADDRESSED", actor, { from: cur.state, to: "ADDRESSED", submissionId });
  }
  for (const [id, why] of Object.entries(decl.notAddressed)) {
    await event(prisma, id, "NOT_ADDRESSED", actor, { submissionId, note: why });
  }
}

/** The legacy note toggle, mirrored (setCutNoteStatus): FIXED → ADDRESSED with
 *  no version yet (the next check binds it), OPEN → back to the editor,
 *  RESOLVED (the office) → verified. */
export async function mirrorNoteStatus(noteId: string, status: "OPEN" | "FIXED" | "RESOLVED", actor: IssueActor): Promise<void> {
  try {
    const i = await prisma.revisionIssue.findUnique({ where: { sourceKind_sourceId: { sourceKind: "REVIEW_NOTE", sourceId: noteId } } });
    if (!i) return;
    const to = status === "FIXED" ? "ADDRESSED" : status === "RESOLVED" ? "VERIFIED" : "OPEN";
    if (i.state === to || i.state === "DUPLICATE" || i.state === "NOT_APPLICABLE") return;
    if (to === "OPEN" && i.state === "VERIFIED") return; // a reopen of a verified fix is a new round, not a toggle
    const now = new Date();
    const won = await prisma.revisionIssue.updateMany({
      where: { id: i.id, state: i.state },
      data:
        to === "ADDRESSED"
          ? { state: to, addressedAt: now, addressedBy: actor.name.slice(0, 120) }
          : to === "VERIFIED"
            ? { state: to, verifiedAt: now, verifiedBy: actor.name.slice(0, 120) }
            : { state: to, addressedAt: null, addressedBy: null, addressedInSubmissionId: null },
    });
    if (won.count) await event(prisma, i.id, to === "OPEN" ? "REOPENED_BY_HAND" : to, actor, { from: i.state, to, note: `note marked ${status.toLowerCase()}` });
  } catch { /* the note's own status already changed */ }
}

/** The work-order ticks, mirrored on read (the tick action lives in a file
 *  this layer does not own). A ticked item that is still waiting on the
 *  editor becomes ADDRESSED with no version; an unticked one that only a tick
 *  had addressed goes back. Cheap: one read of the job's briefs. */
export async function syncBriefTicks(projectId: string): Promise<void> {
  try {
    const briefs = await prisma.revisionBrief.findMany({ where: { projectId }, select: { id: true, doneJson: true } });
    if (briefs.length === 0) return;
    const issues = await prisma.revisionIssue.findMany({
      where: { projectId, sourceKind: "BRIEF_ITEM", state: { in: ["OPEN", "REOPENED", "ADDRESSED"] } },
      select: { id: true, sourceId: true, state: true, addressedBy: true, addressedInSubmissionId: true },
    });
    if (issues.length === 0) return;
    // null = no tick list at all (never ticked, or wiped by a re-read that was
    // then refused) — that is "no information", never "unticked".
    const ticked = new Map<string, Set<string> | null>();
    for (const b of briefs) {
      let done: string[] | null = null;
      try { done = b.doneJson ? (JSON.parse(b.doneJson) as string[]) : null; } catch { done = null; }
      ticked.set(b.id, done ? new Set(done) : null);
    }
    const TICK = "Work-order tick";
    for (const i of issues) {
      const [briefId, itemId] = i.sourceId.split(":");
      const list = ticked.get(briefId);
      if (list === undefined || list === null) continue;
      const isTicked = list.has(itemId);
      if (isTicked && i.state !== "ADDRESSED") {
        const won = await prisma.revisionIssue.updateMany({ where: { id: i.id, state: i.state }, data: { state: "ADDRESSED", addressedAt: new Date(), addressedBy: TICK } });
        if (won.count) await event(prisma, i.id, "ADDRESSED", { name: TICK }, { from: i.state, to: "ADDRESSED" });
      } else if (!isTicked && i.state === "ADDRESSED" && i.addressedBy === TICK && !i.addressedInSubmissionId) {
        const won = await prisma.revisionIssue.updateMany({ where: { id: i.id, state: "ADDRESSED" }, data: { state: "OPEN", addressedAt: null, addressedBy: null } });
        if (won.count) await event(prisma, i.id, "REOPENED_BY_HAND", { name: TICK }, { from: "ADDRESSED", to: "OPEN", note: "unticked on the work order" });
      }
    }
  } catch { /* a mirror, never a blocker */ }
}

/** The job's video work moved to another editor: open issues follow the work.
 *  versionEditorKey — who made each version — is NEVER rewritten. Lazy (run on
 *  every read of the job's issues) so no assignment path has to remember it. */
export async function syncIssueAssignee(projectId: string): Promise<void> {
  try {
    const now = await currentVideoAssignee(projectId);
    if (!now) return;
    const stale = await prisma.revisionIssue.findMany({
      where: { projectId, state: { in: LIVE }, OR: [{ assignedEditorKey: null }, { assignedEditorKey: { not: now } }] },
      select: { id: true, assignedEditorKey: true },
    });
    for (const s of stale) {
      const won = await prisma.revisionIssue.updateMany({ where: { id: s.id, assignedEditorKey: s.assignedEditorKey }, data: { assignedEditorKey: now } });
      if (won.count) await event(prisma, s.id, "ASSIGNED", SYSTEM, { from: s.assignedEditorKey, to: now });
    }
  } catch { /* display only */ }
}

// ---- the reviewer's side ----------------------------------------------------

export type ApprovalGate =
  | { ok: false; message: string }
  | { ok: true; apply: (actor: IssueActor) => Promise<{ verified: number }> };

/**
 * What an approval may do to the cut's issues, decided BEFORE the verdict is
 * written so a refusal changes nothing.
 *
 *   · `checked` — this version came through the editor's check. Then an issue
 *     from an EARLIER version still open (the editor said it isn't done) holds
 *     the approval: mark it not needed or send the cut back. With the issue
 *     list in hand (`verifyIssueIds`), every issue the editor marked fixed must
 *     be in it — a fix nobody looked at is not verified.
 *   · a legacy / grandfathered version (no check) is never held here: the
 *     approval verifies what it can and says so on each event.
 * Applying: listed (or, from the legacy button, all) ADDRESSED → VERIFIED in
 * this version; the reviewer's own notes on THIS version still open → Not
 * needed ("approved with this note open"), so they are not demanded of a
 * later check on a finished video.
 */
export async function approvalGate(
  cut: CutShape,
  opts: { checked: boolean; verifyIssueIds?: string[] | null },
): Promise<ApprovalGate> {
  const live = await issuesForCut(cut, LIVE, { forGate: true });
  const addressed = live.filter((i) => i.state === "ADDRESSED");
  const earlierOpen = live.filter((i) => NEEDS_EDITOR.includes(i.state) && i.raisedOnSubmissionId !== cut.id && i.createdAt.getTime() < cut.createdAt.getTime());
  // ONLY the reviewer's own notes on THIS version are closed by approving it
  // (review fix, Sep 25). A client ask that arrived while this version sat in
  // review (a work-order item pinned to the latest round) was being closed as
  // "approved with this note still open" — the addendum then vanished from
  // the next version's check and from the missed-correction count. Anything
  // else still open is left open: this version could not have answered it,
  // and the next one must (§3, A36: instructions survive addenda).
  const onThis = live.filter(
    (i) => NEEDS_EDITOR.includes(i.state) && !earlierOpen.includes(i) && i.sourceKind === "REVIEW_NOTE" && i.raisedOnSubmissionId === cut.id,
  );
  const listed = opts.verifyIssueIds ? new Set(opts.verifyIssueIds) : null;
  if (opts.checked) {
    if (listed) {
      const unlisted = addressed.filter((i) => !listed.has(i.id));
      if (unlisted.length) {
        return { ok: false, message: `${unlisted.length} fix${unlisted.length === 1 ? "" : "es"} the editor marked done ${unlisted.length === 1 ? "isn't" : "aren't"} ticked as verified. Tick ${unlisted.length === 1 ? "it" : "them"}, or send the cut back.` };
      }
    }
    if (earlierOpen.length) {
      return {
        ok: false,
        message: `The editor said ${earlierOpen.length} earlier revision${earlierOpen.length === 1 ? " wasn't" : "s weren't"} done in this version. Mark ${earlierOpen.length === 1 ? "it" : "them"} not needed on the issue list (/edit/${cut.projectId}#issues), or send the cut back.`,
      };
    }
  }
  return {
    ok: true,
    async apply(actor) {
      const now = new Date();
      let verified = 0;
      const toVerify = [...addressed, ...(opts.checked ? [] : earlierOpen)];
      for (const i of toVerify) {
        if (listed && i.state === "ADDRESSED" && !listed.has(i.id)) continue;
        const won = await prisma.revisionIssue.updateMany({
          where: { id: i.id, state: i.state },
          data: { state: "VERIFIED", verifiedAt: now, verifiedBy: actor.name.slice(0, 120), verifiedInSubmissionId: cut.id },
        });
        if (won.count) {
          verified++;
          await event(prisma, i.id, "VERIFIED", actor, {
            from: i.state, to: "VERIFIED", submissionId: cut.id,
            note: listed ? null : opts.checked ? "verified by approving this version" : "approved without the issue list (no editor check on this version)",
          });
        }
      }
      for (const i of onThis) {
        const won = await prisma.revisionIssue.updateMany({ where: { id: i.id, state: i.state }, data: { state: "NOT_APPLICABLE" } });
        if (won.count) await event(prisma, i.id, "NOT_APPLICABLE", actor, { from: i.state, to: "NOT_APPLICABLE", submissionId: cut.id, note: "approved with this note still open" });
      }
      return { verified };
    },
  };
}

/**
 * The reviewer sent the cut back. The notes on it become issues on THIS
 * version (idempotent). Fixes the reviewer names as NOT done go back to the
 * editor, stamped missed in this version — that is a miss: the editor said
 * fixed and it wasn't. An earlier ask the editor openly declared NOT done in
 * this version's check (with a reason) is NOT a miss (review fix, Sep 25): the
 * check made them answer it, they answered honestly, and counting that against
 * them rewarded ticking "addressed" instead. It stays open and is recorded as
 * declared-not-done; the quality card shows it apart, with the reason. Only an
 * earlier ask the check did not account for at all is stamped missed here. A
 * new instruction on this version is never a missed old one.
 */
export async function onChangesRequested(
  cut: CutShape,
  opts: { checked: boolean; notFixedIssueIds?: string[] | null; noteIds: string[] },
  actor: IssueActor,
): Promise<void> {
  try {
    for (const id of opts.noteIds) await ingestReviewNote(id);
    const live = await issuesForCut(cut, LIVE);
    const notFixed = new Set(opts.notFixedIssueIds ?? []);
    // What the editor declared NOT done on this version's own check.
    const declaredNotDone = new Set<string>();
    if (opts.checked) {
      const row = await prisma.reviewSubmission.findUnique({ where: { id: cut.id }, select: { selfCheckId: true } }).catch(() => null);
      const check = row?.selfCheckId
        ? await prisma.cutSelfCheck.findUnique({ where: { id: row.selfCheckId }, select: { state: true, addressedIssueIdsJson: true } }).catch(() => null)
        : null;
      if (check?.state === "VALID") for (const id of Object.keys(parseDeclarations(check.addressedIssueIdsJson).notAddressed)) declaredNotDone.add(id);
    }
    for (const i of live) {
      if (i.state === "ADDRESSED" && notFixed.has(i.id)) {
        const won = await prisma.revisionIssue.updateMany({
          where: { id: i.id, state: "ADDRESSED" },
          data: { state: "REOPENED", missedInSubmissionId: cut.id, verifiedAt: null, verifiedBy: null },
        });
        if (won.count) await event(prisma, i.id, "REOPENED", actor, { from: "ADDRESSED", to: "REOPENED", submissionId: cut.id, note: "sent back — not fixed in this version" });
        continue;
      }
      const earlier = NEEDS_EDITOR.includes(i.state) && i.raisedOnSubmissionId !== cut.id && i.createdAt.getTime() < cut.createdAt.getTime();
      if (opts.checked && earlier && !i.missedInSubmissionId && !declaredNotDone.has(i.id)) {
        const won = await prisma.revisionIssue.updateMany({ where: { id: i.id, missedInSubmissionId: null }, data: { missedInSubmissionId: cut.id } });
        if (won.count) await event(prisma, i.id, "MISSED", actor, { submissionId: cut.id, note: "still open when this version was sent back" });
      }
    }
    await syncIssueAssignee(cut.projectId);
  } catch (e) {
    console.error("[issues] changes-requested bookkeeping failed", cut.id, e);
  }
}

export async function markIssueNotApplicable(id: string, reason: string, actor: IssueActor): Promise<{ ok: boolean; message: string }> {
  const r = reason.trim();
  if (r.length < 4) return { ok: false, message: "Say why it isn't needed." };
  const cur = await prisma.revisionIssue.findUnique({ where: { id }, select: { state: true } });
  if (!cur) return { ok: false, message: "That issue no longer exists." };
  if (!LIVE.includes(cur.state)) return { ok: true, message: "Already closed." };
  const won = await prisma.revisionIssue.updateMany({ where: { id, state: cur.state }, data: { state: "NOT_APPLICABLE" } });
  if (won.count) await event(prisma, id, "NOT_APPLICABLE", actor, { from: cur.state, to: "NOT_APPLICABLE", note: r });
  return { ok: true, message: "Marked not needed." };
}

export async function verifyIssues(ids: string[], submissionId: string | null, actor: IssueActor): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const won = await prisma.revisionIssue.updateMany({
      where: { id, state: "ADDRESSED" },
      data: { state: "VERIFIED", verifiedAt: new Date(), verifiedBy: actor.name.slice(0, 120), verifiedInSubmissionId: submissionId },
    });
    if (won.count) { n++; await event(prisma, id, "VERIFIED", actor, { from: "ADDRESSED", to: "VERIFIED", submissionId }); }
  }
  return n;
}

/** Reopen by hand (the reviewer: "this is still wrong"). A fix a version
 *  claimed (ADDRESSED or VERIFIED in it) that the reviewer now says isn't done
 *  is a MISS in that version — the one the missed-correction count is for, and
 *  the one it could not see while only the bounce stamped misses (review fix,
 *  Sep 25). Never overwrites an earlier stamp. */
export async function reopenIssue(id: string, actor: IssueActor, note?: string | null): Promise<{ ok: boolean; message: string }> {
  const cur = await prisma.revisionIssue.findUnique({ where: { id }, select: { state: true, addressedInSubmissionId: true, missedInSubmissionId: true } });
  if (!cur) return { ok: false, message: "That issue no longer exists." };
  if (cur.state === "OPEN" || cur.state === "REOPENED") return { ok: true, message: "It's already open." };
  if (cur.state === "DUPLICATE") return { ok: false, message: "Reopen the issue it duplicates instead." };
  const claimedIn = (cur.state === "ADDRESSED" || cur.state === "VERIFIED") && !cur.missedInSubmissionId ? cur.addressedInSubmissionId : null;
  const won = await prisma.revisionIssue.updateMany({
    where: { id, state: cur.state },
    data: { state: "REOPENED", verifiedAt: null, verifiedBy: null, ...(claimedIn ? { missedInSubmissionId: claimedIn } : {}) },
  });
  if (won.count) {
    await event(prisma, id, "REOPENED", actor, { from: cur.state, to: "REOPENED", note: note ?? null });
    if (claimedIn) await event(prisma, id, "MISSED", actor, { submissionId: claimedIn, note: "reopened — the version that said it was fixed wasn't" });
  }
  return { ok: true, message: "Reopened — it's back with the editor." };
}

/**
 * The reviewer's call on WHY. Correctable: every change writes a CLASSIFIED
 * event with from/to, and the KPIs read the current value, so a correction
 * re-scores. `reviewMiss` = a defect found after approval that review should
 * have caught (§8.4 client-visible defects).
 */
export async function classifyIssue(
  id: string,
  input: { cause: string; note?: string | null; severity?: string | null; category?: string | null; reviewMiss?: boolean | null },
  actor: IssueActor,
): Promise<{ ok: boolean; message: string }> {
  if (!isIssueCause(input.cause)) return { ok: false, message: "Pick a cause." };
  const cur = await prisma.revisionIssue.findUnique({ where: { id }, select: { cause: true, severity: true, category: true, reviewMiss: true } });
  if (!cur) return { ok: false, message: "That issue no longer exists." };
  const data: Prisma.RevisionIssueUpdateInput = {
    cause: input.cause,
    causeConfirmedBy: input.cause === "UNCLASSIFIED" ? null : actor.name.slice(0, 120),
    causeConfirmedAt: input.cause === "UNCLASSIFIED" ? null : new Date(),
  };
  if (input.severity && (ISSUE_SEVERITIES as readonly string[]).includes(input.severity)) data.severity = input.severity;
  if (input.category && (ISSUE_CATEGORIES as readonly string[]).includes(input.category)) data.category = input.category;
  if (typeof input.reviewMiss === "boolean") data.reviewMiss = input.reviewMiss;
  await prisma.revisionIssue.update({ where: { id }, data });
  if (cur.cause !== input.cause) await event(prisma, id, "CLASSIFIED", actor, { from: cur.cause, to: input.cause, note: input.note ?? null });
  if (data.severity && data.severity !== cur.severity) await event(prisma, id, "SEVERITY", actor, { from: cur.severity, to: String(data.severity) });
  if (data.category && data.category !== cur.category) await event(prisma, id, "CATEGORY", actor, { from: cur.category, to: String(data.category) });
  if (typeof input.reviewMiss === "boolean" && input.reviewMiss !== cur.reviewMiss) await event(prisma, id, "REVIEW_MISS", actor, { from: String(cur.reviewMiss), to: String(input.reviewMiss) });
  return { ok: true, message: `Classified: ${CAUSE_LABEL[input.cause as IssueCause]}.` };
}

/** Only a SUGGESTION — never the cause. Kept for an AI pass to write into. */
export async function suggestIssueCause(id: string, cause: IssueCause): Promise<void> {
  await prisma.revisionIssue.updateMany({ where: { id }, data: { causeSuggested: cause } }).catch(() => {});
}

/**
 * The same ask twice (an email and a Slack message about one fix) counts once.
 * The duplicate closes onto its root; if the root had been closed and the ask
 * came back, the root REOPENS — a repeated unresolved instruction reopens its
 * issue rather than becoming a new one.
 */
export async function mergeDuplicate(id: string, intoId: string, actor: IssueActor): Promise<{ ok: boolean; message: string }> {
  if (id === intoId) return { ok: false, message: "Pick a different issue to merge into." };
  const [dup, root] = await Promise.all([
    prisma.revisionIssue.findUnique({ where: { id } }),
    prisma.revisionIssue.findUnique({ where: { id: intoId } }),
  ]);
  if (!dup || !root) return { ok: false, message: "That issue no longer exists." };
  if (dup.projectId !== root.projectId) return { ok: false, message: "Both issues have to be on the same job." };
  if (root.duplicateOfId) return { ok: false, message: "That issue is itself a duplicate — merge into the one it points at." };
  if (dup.state === "DUPLICATE") return { ok: true, message: "Already merged." };
  await prisma.revisionIssue.update({ where: { id }, data: { state: "DUPLICATE", duplicateOfId: intoId } });
  await event(prisma, id, "DUPLICATE", actor, { from: dup.state, to: "DUPLICATE", note: `merged into ${intoId}` });
  // Anything that pointed at the duplicate now points at the root.
  await prisma.revisionIssue.updateMany({ where: { duplicateOfId: id }, data: { duplicateOfId: intoId } });
  const dupStillAsked = NEEDS_EDITOR.includes(dup.state);
  if (dupStillAsked && (root.state === "VERIFIED" || root.state === "NOT_APPLICABLE" || root.state === "ADDRESSED")) {
    const won = await prisma.revisionIssue.updateMany({ where: { id: intoId, state: root.state }, data: { state: "REOPENED", verifiedAt: null, verifiedBy: null } });
    if (won.count) await event(prisma, intoId, "REOPENED", actor, { from: root.state, to: "REOPENED", note: "asked again" });
  }
  return { ok: true, message: "Merged — it counts once." };
}

/** One request, two causes ("fix the logo, and add a pool shot"): the extra
 *  parts become their own issues (splitFromId), each classifiable on its own. */
export async function splitIssue(id: string, parts: string[], actor: IssueActor): Promise<{ ok: boolean; message: string; ids: string[] }> {
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  if (clean.length < 2) return { ok: false, message: "Give at least two parts.", ids: [] };
  const src = await prisma.revisionIssue.findUnique({ where: { id } });
  if (!src) return { ok: false, message: "That issue no longer exists.", ids: [] };
  await prisma.revisionIssue.update({ where: { id }, data: { summary: clean[0].slice(0, 300) } });
  const ids: string[] = [];
  for (let n = 1; n < clean.length; n++) {
    try {
      const row = await prisma.revisionIssue.create({
        data: {
          projectId: src.projectId, outputId: src.outputId, deliverableId: src.deliverableId, slot: src.slot,
          raisedOnSubmissionId: src.raisedOnSubmissionId, sourceKind: "MANUAL", sourceId: `${src.id}:split:${n}`,
          sourceChannel: src.sourceChannel, sourceDetail: src.sourceDetail, raisedByKey: src.raisedByKey, raisedByName: src.raisedByName,
          originalText: src.originalText, summary: clean[n].slice(0, 300), timeSec: src.timeSec, timeEndSec: src.timeEndSec,
          category: src.category, severity: src.severity, versionEditorKey: src.versionEditorKey, assignedEditorKey: src.assignedEditorKey,
          foundAfterApproval: src.foundAfterApproval, state: NEEDS_EDITOR.includes(src.state) ? src.state : "OPEN",
          splitFromId: src.id, contentRoundId: src.contentRoundId, imported: src.imported,
        },
        select: { id: true },
      });
      ids.push(row.id);
      await event(prisma, row.id, "SPLIT_FROM", actor, { note: `split from ${src.id}` });
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e;
    }
  }
  await event(prisma, id, "SPLIT", actor, { note: `${clean.length} parts` });
  return { ok: true, message: `Split into ${clean.length}.`, ids };
}

// ---------------------------------------------------------------------------
// READ — the job's issues for /edit (editor and reviewer alike)
// ---------------------------------------------------------------------------

export type IssueView = {
  id: string;
  cutKey: string | null;
  cutLabel: string | null;
  state: string;
  cause: string;
  causeLabel: string;
  causeSuggested: string | null;
  causeConfirmedBy: string | null;
  category: string;
  severity: string;
  text: string;
  summary: string | null;
  timeSec: number | null;
  sourceKind: string;
  sourceChannel: string | null;
  raisedByName: string | null;
  raisedOnSubmissionId: string | null;
  raisedOnRound: number | null;
  /** the version whose check said this was fixed — the Review Room's not-fixed ticks */
  addressedInSubmissionId: string | null;
  addressedInRound: number | null;
  verifiedInRound: number | null;
  missedInRound: number | null;
  versionEditorKey: string | null;
  assignedEditorKey: string | null;
  foundAfterApproval: boolean;
  reviewMiss: boolean | null;
  duplicateOfId: string | null;
  imported: boolean;
  createdAtISO: string;
  events: { kind: string; from: string | null; to: string | null; actorName: string; note: string | null; atISO: string }[];
  /** The cause is a reviewer's verdict on a version; another editor's isn't
   *  theirs to read (§8.4). True = the viewer is not shown it. */
  causeHidden: boolean;
};

/** Every issue on the job, by project — NOT by editor key, which is what hid a
 *  reassigned editor's inherited notes (getEditorFeedback filters by the key
 *  stamped at write time). The caller decides who may see the job at all
 *  (canViewProject). `scrub` strips money talk for creatives.
 *
 *  `viewer` = somebody who is NOT on the review desk (an editor): they keep
 *  every ask, its state and its version — what to fix — but a cause verdict
 *  and the AI's suggestion only on their OWN versions, and never the
 *  reviewer's history (§8.4: editors see their own progress; James and Jordan
 *  see the team). Redacted here, on the server, so it never reaches the
 *  browser (review fix, Sep 25). Null/omitted = the desk: everything. */
export async function issuesForProject(projectId: string, opts: { scrub: boolean; viewer?: { editorKey: string | null } | null }): Promise<IssueView[]> {
  await syncBriefTicks(projectId);
  await syncIssueAssignee(projectId);
  const k = await cutKeying(projectId);
  const rows = await prisma.revisionIssue.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  if (rows.length === 0) return [];
  const evs = await prisma.revisionIssueEvent.findMany({ where: { issueId: { in: rows.map((r) => r.id) } }, orderBy: { at: "asc" } });
  const byIssue = new Map<string, typeof evs>();
  for (const e of evs) byIssue.set(e.issueId, [...(byIssue.get(e.issueId) ?? []), e]);
  const roundOf = (id: string | null) => (id ? k.byId.get(id)?.round ?? null : null);
  const clean = (s: string | null) => (s == null ? null : opts.scrub ? stripMoneySentences(s) || "(this mentioned pricing — ask Jordan)" : s);
  const redact = opts.viewer ?? null;
  return rows.map((r) => {
    const key = k.keyOfIssue(r);
    const hideCause = !!redact && (!redact.editorKey || r.versionEditorKey !== redact.editorKey);
    return {
      id: r.id,
      cutKey: key,
      cutLabel: key ? k.labelOfKey.get(key) ?? null : null,
      state: r.state,
      cause: hideCause ? "UNCLASSIFIED" : r.cause,
      causeLabel: hideCause ? "" : CAUSE_LABEL[(isIssueCause(r.cause) ? r.cause : "UNCLASSIFIED") as IssueCause],
      causeHidden: hideCause,
      causeSuggested: redact ? null : r.causeSuggested,
      causeConfirmedBy: hideCause ? null : r.causeConfirmedBy,
      category: r.category,
      severity: r.severity,
      text: clean(r.originalText) ?? "",
      summary: clean(r.summary),
      timeSec: r.timeSec,
      sourceKind: r.sourceKind,
      sourceChannel: r.sourceChannel,
      raisedByName: r.raisedByName,
      raisedOnSubmissionId: r.raisedOnSubmissionId,
      raisedOnRound: roundOf(r.raisedOnSubmissionId),
      addressedInSubmissionId: r.addressedInSubmissionId,
      addressedInRound: roundOf(r.addressedInSubmissionId),
      verifiedInRound: roundOf(r.verifiedInSubmissionId),
      missedInRound: roundOf(r.missedInSubmissionId),
      versionEditorKey: hideCause ? null : r.versionEditorKey,
      assignedEditorKey: r.assignedEditorKey,
      foundAfterApproval: r.foundAfterApproval,
      reviewMiss: hideCause ? null : r.reviewMiss,
      duplicateOfId: r.duplicateOfId,
      imported: r.imported,
      createdAtISO: r.createdAt.toISOString(),
      events: redact ? [] : (byIssue.get(r.id) ?? []).map((e) => ({ kind: e.kind, from: e.fromValue, to: e.toValue, actorName: e.actorName, note: opts.scrub && e.note ? stripMoneySentences(e.note) || null : e.note, atISO: e.at.toISOString() })),
    };
  });
}

/** Issues waiting on a reviewer's classification, across the business (the
 *  /quality Editors tab). Newest first, capped. */
export async function unclassifiedIssues(limit = 40): Promise<{ id: string; projectId: string; street: string; text: string; category: string; state: string; raisedByName: string | null; versionEditorKey: string | null; causeSuggested: string | null; createdAtISO: string }[]> {
  const rows = await prisma.revisionIssue.findMany({
    where: { cause: "UNCLASSIFIED", state: { notIn: ["DUPLICATE", "NOT_APPLICABLE"] }, imported: false },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const projects = await prisma.project.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } }, select: { id: true, title: true } });
  const street = new Map(projects.map((p) => [p.id, (p.title ?? "Job").split(",")[0].trim()]));
  return rows.map((r) => ({
    id: r.id, projectId: r.projectId, street: street.get(r.projectId) ?? "Job",
    text: (r.summary || r.originalText).slice(0, 300), category: r.category, state: r.state,
    raisedByName: r.raisedByName, versionEditorKey: r.versionEditorKey, causeSuggested: r.causeSuggested,
    createdAtISO: r.createdAt.toISOString(),
  }));
}
