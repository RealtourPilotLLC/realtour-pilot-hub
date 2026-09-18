import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cutSlots, slotKeyOf, type CutSlot } from "@/lib/reviewCuts";
import { unitCategoryFor } from "@/lib/evidenceUnits";

/** Rounds that are not a version of anything — the same list reviewCuts keeps. */
const NOT_A_ROUND = ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] as const;

// ===========================================================================
// THE UNIT FACTORY (audit WF-02 — Jordan, Sep 17: "Every owed video needs its
// own identity, current version, owner, deadline, review state, and delivery
// evidence").
//
// A `Deliverable` is ONE ROW PER TYPE. That is not a defect — the Aryeo
// reconcile matches order lines by type and relabels them in place, and a cut's
// identity `deliverableId:slot` is built on it. What it cannot do is carry a
// fact about ONE video: 893 S Matlack St is a single row, quantity 16, and
// until now the sixteenth video existed only as an integer inside a count.
// Nothing could say who was carrying it, when it was due, which version was
// current or whether the client ever got it.
//
// `DeliverableOutput` is that row, and it is deliberately NOT a second tracker:
//   · it materialises exactly the slots reviewCuts.cutSlots already computes —
//     this module CALLS that function and never re-derives the arithmetic,
//     because the office's videos-owed total is split across the video rows by
//     POSITION (editOverrides.effectiveSlotCounts) and a second implementation
//     would drift the first time somebody changed one of them;
//   · the key stays (deliverableId, slot), so every cut, note, verdict and
//     upload already keyed that way attaches with nothing rewritten;
//   · the Deliverable keeps its quantity and its meaning.
//
// NOTHING HERE DELETES. A slot that leaves the order is stamped
// removedFromOrderAt; a row the office waives is stamped waivedAt and keeps its
// review history. BOTH stamps are cleared when the fact that made them goes
// away — the slot comes back onto the order, or the office un-waives the row
// (deliverableActions.unwaiveDeliverable). The notes survive either way; the
// null date is what says the video is owed again.
//
// The evidence stamps are DERIVED from the rounds that already exist
// (refreshOutputsForProject), so re-running any of it is a no-op rather than a
// second opinion — and derived means BOTH WAYS: a stamp whose round is gone is
// retracted, never left asserting an approval nobody stands behind.
// ===========================================================================

/** One slot as this module will store it: what cutSlots said, plus the three
 *  facts the row needs at mint (category, provenance, when it became owed). */
export type PlannedOutput = CutSlot & {
  category: string;
  /** 'quantity' | 'override' | 'manual' — what produced this slot's COUNT. A
   *  label for a person reading the row, never arithmetic anything reads back. */
  source: string;
  requiredFrom: Date | null;
};

export type OutputPlan = {
  projectId: string;
  /** Live slots — the work the job genuinely owes. */
  slots: PlannedOutput[];
  /** Slots that exist only because the office waived the row: recorded, never
   *  worked on. */
  waived: PlannedOutput[];
};

export type EnsureResult = {
  projectId: string;
  created: number;
  /** rows the slot list no longer contains, stamped removedFromOrderAt */
  retired: number;
  /** rows that came back onto the order and had that stamp cleared */
  unretired: number;
  /** rows newly stamped waivedAt because the office waived their row */
  waived: number;
  /** rows whose waivedAt was cleared because the office un-waived their row */
  unwaived: number;
  /** ReviewSubmission rows given their outputId by this pass */
  linkedRounds: number;
  slotKeys: string[];
};

/** What ensureOutputsForProject WOULD write — no writes, for the parity test. */
export async function planOutputsForProject(projectId: string): Promise<OutputPlan> {
  // ONE call, with the waived slots included, so the live set and the waived
  // set come out of the same arithmetic rather than two passes that could
  // disagree about which row the office's total landed on.
  const all = await cutSlots(projectId, { includeWaived: true });
  if (all.length === 0) return { projectId, slots: [], waived: [] };
  const rows = await prisma.deliverable.findMany({
    where: { id: { in: [...new Set(all.map((s) => s.deliverableId))] } },
    select: { id: true, type: true, quantity: true, manual: true, createdAt: true, waivedAt: true },
  });
  const byId = new Map(rows.map((d) => [d.id, d]));
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { videosOwedOverride: true, overrideAt: true },
  });
  const overridden = (project?.videosOwedOverride ?? 0) > 0;

  const plan = (s: CutSlot): PlannedOutput => {
    const d = byId.get(s.deliverableId);
    // The office's number produced this slot when the row's own quantity could
    // not have: "videos owed 6" on a four-video month. Its clock starts when
    // the office typed it, not when the order line was created — a video added
    // mid-job must not inherit the first video's deadline.
    const fromOverride = overridden && s.count > Math.max(1, d?.quantity ?? 1);
    return {
      ...s,
      category: unitCategoryFor(d?.type ?? "VIDEO"),
      source: d?.manual ? "manual" : fromOverride ? "override" : "quantity",
      requiredFrom: (fromOverride ? project?.overrideAt ?? d?.createdAt : d?.createdAt) ?? null,
    };
  };
  return {
    projectId,
    slots: all.filter((s) => !s.waived).map(plan),
    waived: all.filter((s) => s.waived).map(plan),
  };
}

/**
 * Give every owed video on this job a row of its own. Idempotent: the unique
 * key is (deliverableId, slot), so running it twice creates nothing and
 * changes nothing. Safe to call on every cut event and from the hourly sweep.
 *
 * Only the ORDER's facts are written here — which slots exist, what they are,
 * when they became owed, and which of them have left. The review and delivery
 * stamps are refreshOutputsForProject's (they are derived from the rounds);
 * `ownerKey`, `promisedAt` and `targetAt` belong to the owner assignment and
 * the promise engine, and nothing in this file may blank a column it did not
 * set.
 */
export async function ensureOutputsForProject(projectId: string): Promise<EnsureResult> {
  const { slots, waived } = await planOutputsForProject(projectId);
  const out: EnsureResult = { projectId, created: 0, retired: 0, unretired: 0, waived: 0, unwaived: 0, linkedRounds: 0, slotKeys: [] };
  const existing = await prisma.deliverableOutput.findMany({
    where: { projectId },
    select: { id: true, deliverableId: true, slot: true, removedFromOrderAt: true, waivedAt: true },
  });
  // Nothing owed and nothing recorded: two thirds of the jobs in the database
  // sell no video at all, and this runs on every cut event and every sweep.
  if (slots.length === 0 && waived.length === 0 && existing.length === 0) return out;
  const byKey = new Map(existing.map((o) => [slotKeyOf(o.deliverableId, o.slot), o]));

  const upsert = async (p: PlannedOutput, isWaived: boolean) => {
    const key = slotKeyOf(p.deliverableId, p.slot);
    if (!isWaived) out.slotKeys.push(key);
    const row = byKey.get(key);
    if (!row) {
      // Two cut events on the same job can reach this line at once (an upload
      // and a verdict, the sweep and a click). The unique key is the arbiter:
      // the loser of the race gets its row from the winner, which is the right
      // answer, so it is not an error worth failing an editor's action over.
      const created = await prisma.deliverableOutput
        .create({
          data: {
            projectId,
            deliverableId: p.deliverableId,
            slot: p.slot,
            category: p.category,
            source: p.source,
            requiredFrom: p.requiredFrom,
            ...(isWaived ? { waivedAt: new Date(), waivedNote: "The office waived this row before the video was materialised." } : {}),
          },
        })
        .catch(() => null);
      if (created) out.created++;
      return;
    }
    // Back on the order: clear the retirement stamp, keep the note — it is the
    // record of why it left, and the null date is what says it is owed again.
    if (row.removedFromOrderAt) {
      await prisma.deliverableOutput.update({ where: { id: row.id }, data: { removedFromOrderAt: null } });
      out.unretired++;
    }
    if (isWaived && !row.waivedAt) {
      await prisma.deliverableOutput.update({ where: { id: row.id }, data: { waivedAt: new Date() } });
      out.waived++;
    }
    // AND THE MIRROR OF IT (reviewer, Sep 18). The office can undo a waiver —
    // deliverableActions.unwaiveDeliverable clears Deliverable.waivedAt and
    // says so on the timeline — and cutSlots mints the slot again the moment it
    // does. Without this branch the OUTPUT row kept its waivedAt for ever:
    // outputsForProject reads it as "Not required on this job", the promise
    // clock and every "what is owed" reader skip it, and the video is invisible
    // on a job that owes it. The builder's own report claimed "a slot that
    // comes back has that stamp cleared" — true of removedFromOrderAt above,
    // and it was not true here.
    //
    // The NOTE stays, exactly as the retirement note above stays: it is the
    // record of why the row was ever set aside, and the null date is what says
    // it is owed again (house rule — retire, never delete).
    if (!isWaived && row.waivedAt) {
      await prisma.deliverableOutput.update({ where: { id: row.id }, data: { waivedAt: null } });
      out.unwaived++;
    }
  };

  for (const s of slots) await upsert(s, false);
  for (const s of waived) await upsert(s, true);

  // A slot that disappeared from the arithmetic — the order shrank, or the
  // office lowered "videos owed". RETIRED, never deleted: its rounds, notes and
  // verdicts are still the record of work somebody did.
  const live = new Set([...slots, ...waived].map((s) => slotKeyOf(s.deliverableId, s.slot)));
  for (const row of existing) {
    const key = slotKeyOf(row.deliverableId, row.slot);
    if (live.has(key) || row.removedFromOrderAt) continue;
    await prisma.deliverableOutput.update({
      where: { id: row.id },
      data: {
        removedFromOrderAt: new Date(),
        removedFromOrderNote: "No longer one of the job's cut slots — the order or the office's videos-owed number changed.",
      },
    });
    out.retired++;
  }

  out.linkedRounds = await linkRoundsToOutputs(projectId);
  return out;
}

/**
 * Attach existing review rounds to the slot they were always about.
 *
 * (deliverableId, slot) ONLY. 14 of the 35 rounds in production carry NO
 * deliverable — the folder-discovered cuts, identified by a Dropbox path — and
 * a path is mutable: overwrite the file and an old round plays something else.
 * Guessing which video one of those is would put a client's approval on the
 * wrong deliverable, so they are left null and counted instead. Re-keying them
 * is the Review Room's immutable-history ticket, not this one.
 */
export async function linkRoundsToOutputs(projectId: string): Promise<number> {
  // The unlinked rounds FIRST: on a sixteen-video job this is normally an empty
  // list, and asking that one question costs one round trip instead of sixteen
  // update statements that were always going to match nothing. This runs on
  // every upload and every verdict, so it has to be cheap when there is nothing
  // to do.
  const unlinked = await prisma.reviewSubmission.findMany({
    where: { projectId, outputId: null, deliverableId: { not: null } },
    select: { id: true, deliverableId: true, slot: true },
  });
  if (unlinked.length === 0) return 0;
  const outputs = await prisma.deliverableOutput.findMany({
    where: { projectId },
    select: { id: true, deliverableId: true, slot: true },
  });
  const idByKey = new Map(outputs.map((o) => [slotKeyOf(o.deliverableId, o.slot), o.id]));
  const byOutput = new Map<string, string[]>();
  for (const s of unlinked) {
    const outputId = idByKey.get(slotKeyOf(s.deliverableId!, s.slot));
    if (!outputId) continue; // a round on a slot the arithmetic no longer mints
    byOutput.set(outputId, [...(byOutput.get(outputId) ?? []), s.id]);
  }
  let linked = 0;
  for (const [outputId, ids] of byOutput) {
    const r = await prisma.reviewSubmission.updateMany({ where: { id: { in: ids } }, data: { outputId } });
    linked += r.count;
  }
  return linked;
}

/**
 * Re-derive each output's review and delivery state from the rounds that exist.
 *
 * DERIVED, not asserted: the rounds are the record, so this can run after any
 * cut event (upload, verdict, withdrawal, "mark sent") and reach the same
 * answer every time.
 *
 * DERIVED IN BOTH DIRECTIONS (reviewer, Sep 18). This used to be write-once —
 * `if (rs.length === 0) continue` plus a `!o.X` guard on every stamp — so a
 * fact could be written and never taken back. review/actions.removeCut DELETES
 * the submission row outright (Jordan, Sep 16: "when removing the cut, I want
 * it to remove completely"), so approving version 2 and then removing it left
 * `approvedSubmissionId` pointing at a row that no longer exists and
 * `approvedAt` asserting an approval nobody stands behind — on the one column
 * the project view, the promise clock and the content meter read to say a video
 * is accepted. Every stamp below is now recomputed from the rounds that exist
 * NOW, including to null.
 *
 * Two things it still will not do —
 *   · it never clears a `deliveredAt` it did not write. A person pressing
 *     "delivered by hand" on a video the hub holds no file for is the office's
 *     word, and no sweep gets to argue with it (COMPLETION-CONTRACT §4,
 *     *overridden*). Removing the version the client already has does not
 *     un-send it, so the STAMP stays even when the round is gone — only the
 *     dangling pointer to that round is repaired;
 *   · it never invents delivery. `sentToClientAt` on the round is the only
 *     thing here that can mean the client has it — an approval is not a
 *     delivery and a copy in the Final folder is not a delivery (§5).
 */
export async function refreshOutputsForProject(projectId: string): Promise<number> {
  const [outputs, rounds] = await Promise.all([
    prisma.deliverableOutput.findMany({
      where: { projectId },
      select: { id: true, deliverableId: true, slot: true, reviewReadyAt: true, approvedAt: true, deliveredAt: true, currentSubmissionId: true, approvedSubmissionId: true, sentSubmissionId: true },
    }),
    prisma.reviewSubmission.findMany({
      where: { projectId, deliverableId: { not: null }, withdrawnAt: null, status: { notIn: [...NOT_A_ROUND] } },
      orderBy: { round: "asc" },
      select: { id: true, deliverableId: true, slot: true, status: true, round: true, createdAt: true, decidedAt: true, sentToClientAt: true, sentToClientBy: true },
    }),
  ]);
  if (outputs.length === 0) return 0;
  const byKey = new Map<string, typeof rounds>();
  for (const r of rounds) {
    const k = slotKeyOf(r.deliverableId!, r.slot);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  let touched = 0;
  for (const o of outputs) {
    // NO `continue` ON AN EMPTY LIST. A slot whose every round has been removed
    // is exactly the case that has to be retracted — see the header.
    const rs = byKey.get(slotKeyOf(o.deliverableId, o.slot)) ?? [];
    const latest = rs[rs.length - 1] ?? null;
    const approved = [...rs].reverse().find((r) => r.status === "APPROVED") ?? null;
    const sent = [...rs].reverse().find((r) => r.sentToClientAt) ?? null;
    const data: Prisma.DeliverableOutputUpdateInput = {};
    // Each of these is "what the rounds say", computed the same way whether the
    // answer is a row or nothing.
    if (o.currentSubmissionId !== (latest?.id ?? null)) data.currentSubmissionId = latest?.id ?? null;
    const readyAt = rs[0]?.createdAt ?? null;
    if ((o.reviewReadyAt?.getTime() ?? null) !== (readyAt?.getTime() ?? null)) data.reviewReadyAt = readyAt;
    if (o.approvedSubmissionId !== (approved?.id ?? null)) data.approvedSubmissionId = approved?.id ?? null;
    const approvedAt = approved ? approved.decidedAt ?? approved.createdAt : null;
    if ((o.approvedAt?.getTime() ?? null) !== (approvedAt?.getTime() ?? null)) data.approvedAt = approvedAt;
    if (sent && !o.deliveredAt) {
      data.sentSubmissionId = sent.id;
      data.deliveredAt = sent.sentToClientAt;
      data.deliveredBy = sent.sentToClientBy;
      // The hub hands Kyle a file and he uploads it by hand — Aryeo has no
      // delivery endpoint (readyToSend's header note). So the send IS the
      // office's act, whoever proved it afterwards.
      data.deliveredVia = "office-hand";
      data.evidenceSource = "review-sent";
      data.evidenceSucceededAt = new Date();
    } else if (o.sentSubmissionId && !rs.some((r) => r.id === o.sentSubmissionId)) {
      // THE POINTER, NEVER THE STAMP. The round that proved the delivery has
      // gone (removed, or moved to another job), so the id on the row points at
      // nothing. `deliveredAt`, `deliveredBy` and `deliveredVia` stay exactly as
      // they are — the client HAS the video, and deleting our copy of the
      // version is not an un-send (see the header, and correctedCutWithdrawn's
      // note on the same rule for the client's ask). Only the broken reference
      // is repaired, to whichever round can still prove it, or to nothing.
      data.sentSubmissionId = sent?.id ?? null;
    }
    if (Object.keys(data).length === 0) continue;
    await prisma.deliverableOutput.update({ where: { id: o.id }, data });
    touched++;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// ONE MANAGEABLE PROJECT VIEW (Jordan: "Preserve one manageable project view").
// Not a new screen — a single list the project page can print under the status
// card, one line per owed video, saying the only six things a person asks:
// which video, who has it, when it is due, which version is live, whether we
// have accepted it, and whether the client can actually see it.
// ---------------------------------------------------------------------------
export type OutputRowView = {
  id: string;
  key: string;
  label: string;
  /** 1-based position in what the job owes ("video 3 of 16") */
  index: number;
  total: number;
  ownerName: string | null;
  promisedAt: Date | null;
  targetAt: Date | null;
  state: "waived" | "removed" | "not_started" | "in_review" | "in_revisions" | "approved" | "sent";
  /** the sentence the row prints */
  detail: string;
  round: number | null;
  submissionId: string | null;
  deliveredAt: Date | null;
};

/**
 * Every owed video on a job, in order, with the state its own evidence
 * supports. Read-only and self-contained (no Aryeo call, no Dropbox call), so
 * a project page can render it without buying a live listing read.
 *
 * APPROVED IS NOT SENT, and this is the surface that says so out loud: a cut
 * Jordan signed off and nobody has handed to the client still reads as owed
 * work here, for exactly as long as that is true (audit WF-01/WF-03, and the
 * 322 N 62nd St silent-audio morning that produced the Ready-to-send card).
 */
export async function outputsForProject(projectId: string): Promise<OutputRowView[]> {
  const [outputs, rounds] = await Promise.all([
    prisma.deliverableOutput.findMany({
      where: { projectId },
      orderBy: [{ slot: "asc" }],
      select: {
        id: true, deliverableId: true, slot: true, title: true, ownerName: true, promisedAt: true, targetAt: true,
        waivedAt: true, removedFromOrderAt: true, deliveredAt: true, deliveredVia: true,
      },
    }),
    prisma.reviewSubmission.findMany({
      where: { projectId, deliverableId: { not: null }, withdrawnAt: null, status: { notIn: [...NOT_A_ROUND] } },
      orderBy: { round: "asc" },
      select: { id: true, deliverableId: true, slot: true, status: true, round: true, sentToClientAt: true },
    }),
  ]);
  if (outputs.length === 0) return [];
  // The names AND THE ORDER come from the same slot list the Review Room
  // prints, so a video is called one thing, and is the same number, everywhere
  // (cutSlots' whole reason for existing). A row whose slot is no longer in
  // that list — a retired one — sorts after the live ones rather than
  // disappearing.
  const slots = await cutSlots(projectId, { includeWaived: true }).catch(() => []);
  const labelByKey = new Map(slots.map((s) => [slotKeyOf(s.deliverableId, s.slot), s.label]));
  const orderByKey = new Map(slots.map((s, i) => [slotKeyOf(s.deliverableId, s.slot), i]));
  const latestByKey = new Map<string, (typeof rounds)[number]>();
  for (const r of rounds) {
    const k = slotKeyOf(r.deliverableId!, r.slot);
    const cur = latestByKey.get(k);
    if (!cur || r.round > cur.round) latestByKey.set(k, r);
  }
  const ordered = [...outputs].sort(
    (a, b) =>
      (orderByKey.get(slotKeyOf(a.deliverableId, a.slot)) ?? 9_000 + a.slot) -
      (orderByKey.get(slotKeyOf(b.deliverableId, b.slot)) ?? 9_000 + b.slot),
  );
  const live = ordered.filter((o) => !o.removedFromOrderAt && !o.waivedAt);
  return ordered.map((o, i) => {
    const key = slotKeyOf(o.deliverableId, o.slot);
    const latest = latestByKey.get(key) ?? null;
    const sentAt = o.deliveredAt ?? latest?.sentToClientAt ?? null;
    const state: OutputRowView["state"] = o.waivedAt
      ? "waived"
      : o.removedFromOrderAt
        ? "removed"
        : sentAt
          ? "sent"
          : latest?.status === "APPROVED"
            ? "approved"
            : latest?.status === "CHANGES_REQUESTED"
              ? "in_revisions"
              : latest
                ? "in_review"
                : "not_started";
    const ver = latest && latest.round > 1 ? `v${latest.round} ` : "";
    return {
      id: o.id,
      key,
      label: o.title?.trim() || labelByKey.get(key) || `Video ${o.slot}`,
      index: live.findIndex((l) => l.id === o.id) + 1 || i + 1,
      total: live.length,
      ownerName: o.ownerName,
      promisedAt: o.promisedAt,
      targetAt: o.targetAt,
      state,
      round: latest?.round ?? null,
      submissionId: latest?.id ?? null,
      deliveredAt: sentAt,
      detail:
        state === "sent"
          ? `Sent to the client${o.deliveredVia === "aryeo-listing" ? " — on the Aryeo listing" : ""}`
          : state === "approved"
            ? `${ver}approved — still has to go to the client`
            : state === "in_revisions"
              ? `${ver}back with the editor`
              : state === "in_review"
                ? `${ver}waiting on a verdict`
                : state === "waived"
                  ? "Not required on this job"
                  : state === "removed"
                    ? "No longer on the order"
                    : "No cut uploaded yet",
    };
  });
}
