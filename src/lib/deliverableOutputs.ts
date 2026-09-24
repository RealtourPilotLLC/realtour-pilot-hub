import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cutSlots, slotKeyOf, type CutSlot } from "@/lib/reviewCuts";
import type { EditorKey } from "@/lib/editors";
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

/** Where the name on the row came from. The three are NOT the same claim, and
 *  a screen that prints them identically is guessing on the office's behalf:
 *    row      — somebody set an owner on THIS video (DeliverableOutput.ownerKey)
 *    job      — the job's editor answers for it (the schema's own rule for a
 *               null ownerKey: "null means the job-level editor still answers")
 *    routing  — nobody has taken it; this is where today's rules WOULD send it. */
export type OutputOwnerFrom = "row" | "job" | "routing";

export type OutputRowView = {
  id: string;
  key: string;
  label: string;
  /** 1-based position in what the job owes ("video 3 of 16") */
  index: number;
  total: number;
  ownerName: string | null;
  ownerFrom: OutputOwnerFrom | null;
  promisedAt: Date | null;
  targetAt: Date | null;
  /** true when the dates above are the JOB's promise rather than a date set on
   *  this video — every video on a job shares one client deadline today. */
  promiseFromJob: boolean;
  state: "waived" | "removed" | "not_started" | "in_review" | "in_revisions" | "approved" | "sent";
  /** the sentence the row prints */
  detail: string;
  round: number | null;
  submissionId: string | null;
  /** When the client last received A VERSION of this video. History: it is
   *  never cleared, and it is not a claim about the CURRENT version. */
  deliveredAt: Date | null;
  /** Set only when the client has an OLDER version than the one this job is
   *  working on — the fact `state` alone used to swallow (R03). */
  priorDelivery: { at: Date; round: number | null } | null;
  /** The current version is finished and has NOT gone out. */
  awaitingSend: boolean;
  /** CP-09: the content topic this slot was filmed for, bound from the photographer's confirmation. */
  topicId: string | null;
  /** That topic's title as it reads NOW — a rename shows here the moment it is made. */
  topicTitle: string | null;
  /** The photographer's note to the editor about this video. */
  filmingNote: string | null;
};

/** "v3 " when there is more than one version, "" otherwise. */
const verPrefix = (round: number | null | undefined) => (round && round > 1 ? `v${round} ` : "");

/**
 * Every owed video on a job, in order, with the state its own evidence
 * supports. Read-only and self-contained (no Aryeo call, no Dropbox call), so
 * a project page can render it without buying a live listing read.
 *
 * APPROVED IS NOT SENT, and this is the surface that says so out loud: a cut
 * Jordan signed off and nobody has handed to the client still reads as owed
 * work here, for exactly as long as that is true (audit WF-01/WF-03, and the
 * 322 N 62nd St silent-audio morning that produced the Ready-to-send card).
 *
 * AND AN OLD SEND DOES NOT HIDE AN UNSENT REPLACEMENT (audit R03, Sep 18).
 * This read used to open with `o.deliveredAt ?? latest?.sentToClientAt`, so ONE
 * historical stamp outranked every later fact: with version 1 sent and version
 * 2 approved-but-unsent the row printed "Sent to the client" while Kyle's
 * Ready-to-send card printed the opposite about the same video. Two screens
 * disagreeing about one video is the whole class of contradiction this audit
 * exists to remove.
 *
 * The two facts are now kept apart and BOTH printed:
 *   · `deliveredAt` / `priorDelivery` — what the client actually has. History,
 *     never cleared, never rewritten (house rule: retire, never delete).
 *   · `state` / `detail` — what the CURRENT version still owes. A replacement
 *     that is in review, back with the editor, or approved-and-unsent is owed
 *     work, and says so beside the delivery that already happened:
 *     "v1 sent; v2 approved, awaiting send".
 *
 * WHY THE ROUNDS AND NOT THE STAMP decide "has the current version gone out":
 * `DeliverableOutput.deliveredAt` is written once and deliberately not moved
 * (readyToSend.ts guards its update with `deliveredAt: null`, and
 * refreshOutputsForProject with `sent && !o.deliveredAt`) — it is the FIRST
 * proven send, and overwriting it would rewrite a historical timestamp. Every
 * later send is on its own round (`ReviewSubmission.sentToClientAt`), so the
 * rounds are the only complete record of what went out and when.
 */
export async function outputsForProject(projectId: string): Promise<OutputRowView[]> {
  const [outputs, rounds] = await Promise.all([
    prisma.deliverableOutput.findMany({
      where: { projectId },
      orderBy: [{ slot: "asc" }],
      select: {
        id: true, deliverableId: true, slot: true, title: true, ownerName: true, ownerKey: true, promisedAt: true, targetAt: true,
        waivedAt: true, removedFromOrderAt: true, deliveredAt: true, deliveredVia: true, topicId: true, filmingNote: true,
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
  // CP-09: the TOPIC's title is read live rather than copied onto the row, so
  // a topic renamed after filming renames its video everywhere this is read.
  const topicIds = [...new Set(outputs.map((o) => o.topicId).filter((x): x is string => !!x))];
  const [slots, planning, topics] = await Promise.all([
    cutSlots(projectId, { includeWaived: true }).catch(() => []),
    jobPlanningFor(projectId),
    topicIds.length
      ? prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true } }).catch(() => [])
      : Promise.resolve([] as { id: string; title: string }[]),
  ]);
  const topicTitleOf = new Map(topics.map((t) => [t.id, t.title]));
  const labelByKey = new Map(slots.map((s) => [slotKeyOf(s.deliverableId, s.slot), s.label]));
  const orderByKey = new Map(slots.map((s, i) => [slotKeyOf(s.deliverableId, s.slot), i]));
  const roundsByKey = new Map<string, typeof rounds>();
  for (const r of rounds) {
    const k = slotKeyOf(r.deliverableId!, r.slot);
    roundsByKey.set(k, [...(roundsByKey.get(k) ?? []), r]);
  }
  const ordered = [...outputs].sort(
    (a, b) =>
      (orderByKey.get(slotKeyOf(a.deliverableId, a.slot)) ?? 9_000 + a.slot) -
      (orderByKey.get(slotKeyOf(b.deliverableId, b.slot)) ?? 9_000 + b.slot),
  );
  const live = ordered.filter((o) => !o.removedFromOrderAt && !o.waivedAt);
  return ordered.map((o, i) => {
    const key = slotKeyOf(o.deliverableId, o.slot);
    const rs = roundsByKey.get(key) ?? [];
    const latest = rs[rs.length - 1] ?? null;
    // The last round anybody proved a send for — not necessarily the newest
    // round, which is exactly the case R03 is about.
    const lastSent = [...rs].reverse().find((r) => r.sentToClientAt) ?? null;
    // What the client HAS. Both witnesses count: a round's own send stamp, and
    // the office's hand-delivery stamp on the row (a video the hub holds no
    // file for — COMPLETION-CONTRACT §4, *overridden*).
    const everSentAt = lastSent?.sentToClientAt ?? o.deliveredAt ?? null;
    // What the job is working on NOW. With no round at all the row's own stamp
    // is the current state (hand-delivered, nothing pending); with rounds, only
    // the newest round can say the current version has gone out.
    const currentSent = latest ? !!latest.sentToClientAt : !!o.deliveredAt;
    const prior = !currentSent && everSentAt ? { at: everSentAt, round: lastSent?.round ?? null } : null;
    const state: OutputRowView["state"] = o.waivedAt
      ? "waived"
      : o.removedFromOrderAt
        ? "removed"
        : currentSent
          ? "sent"
          : latest?.status === "APPROVED"
            ? "approved"
            : latest?.status === "CHANGES_REQUESTED"
              ? "in_revisions"
              : latest
                ? "in_review"
                : "not_started";
    const ver = verPrefix(latest?.round);
    // "v1 sent; " — the delivery that already happened, in front of the
    // sentence about what is still owed. Without a round number behind it
    // (a hand-delivery) it can only say that one happened.
    const priorBit = prior ? (prior.round ? `v${prior.round} sent; ` : "Sent once already; ") : "";
    const detail =
      state === "sent"
        ? `${ver ? `${ver}sent` : "Sent"} to the client${o.deliveredVia === "aryeo-listing" ? " — on the Aryeo listing" : ""}`
        : state === "approved"
          ? prior
            ? `${priorBit}${ver}approved, awaiting send`
            : `${ver}approved — still has to go to the client`
          : state === "in_revisions"
            ? `${priorBit}${ver}back with the editor`
            : state === "in_review"
              ? `${priorBit}${ver}waiting on a verdict`
              : state === "waived"
                ? "Not required on this job"
                : state === "removed"
                  ? "No longer on the order"
                  : prior
                    ? `${priorBit}no replacement uploaded yet`
                    : "No cut uploaded yet";
    const owner = ownerForOutput(o, planning, o.deliverableId);
    const isLive = !o.waivedAt && !o.removedFromOrderAt;
    const topicTitle = o.topicId ? topicTitleOf.get(o.topicId)?.trim() || null : null;
    return {
      id: o.id,
      key,
      // A name somebody typed on the row, then the topic it was filmed for,
      // then the slot's own name ("Personal Branding Reel — Video 2 of 4").
      label: o.title?.trim() || topicTitle || labelByKey.get(key) || `Video ${o.slot}`,
      index: live.findIndex((l) => l.id === o.id) + 1 || i + 1,
      total: live.length,
      ownerName: owner.name,
      ownerFrom: owner.from,
      // A waived or retired video is not owed, so it is not due: printing the
      // job's deadline beside "Not required on this job" would read as a
      // missed one.
      promisedAt: isLive ? o.promisedAt ?? planning.promisedAt : o.promisedAt,
      targetAt: isLive ? o.targetAt ?? planning.targetAt : o.targetAt,
      promiseFromJob: isLive && !o.promisedAt && planning.promisedAt !== null,
      state,
      round: latest?.round ?? null,
      submissionId: latest?.id ?? null,
      deliveredAt: everSentAt,
      priorDelivery: prior,
      awaitingSend: state === "approved",
      detail,
      topicId: o.topicId,
      topicTitle,
      filmingNote: o.filmingNote,
    };
  });
}

// ---------------------------------------------------------------------------
// WHO HAS IT AND WHEN IT IS DUE — DERIVED, not a second place to type it
// (audit R06, Sep 18).
//
// The reviewer's measurement: all 922 DeliverableOutput rows in production
// carry ownerKey = null, promisedAt = null and targetAt = null, and nothing in
// the application writes any of the three — so the project view printed a video
// with no owner and no deadline on a job that has both.
//
// It is answered by READING what the job already knows, not by stamping the
// columns:
//   · the schema's own rule for ownerKey is "an assignees.ts slug, SET BY A
//     PERSON; null means the job-level editor still answers for it". Writing
//     the job's editor into it would turn a derived fallback into a frozen
//     assignment, and a later reassignment of the job would leave sixteen rows
//     pointing at the editor who used to have it.
//   · the promise is already frozen ONCE, on the project (Project.promisedDueAt,
//     projectStatus.ts: "NEVER an update — nothing anywhere writes these
//     columns a second time"). Copying it per video adds a second copy that can
//     only drift; reading it cannot.
// A value somebody DID set on the row still wins — that is the office's word,
// and it is preserved exactly (`o.ownerName ?? …`, `o.promisedAt ?? …`).
// ---------------------------------------------------------------------------
type JobPlanning = {
  promisedAt: Date | null;
  targetAt: Date | null;
  /** the editor the office actually put on the job, if any */
  editorName: string | null;
  /** where today's rules would send each video row, by deliverable id */
  routedNameByDeliverable: Map<string, string>;
};

const NO_PLANNING: JobPlanning = { promisedAt: null, targetAt: null, editorName: null, routedNameByDeliverable: new Map() };

async function jobPlanningFor(projectId: string): Promise<JobPlanning> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        packageName: true, deliveryDue: true, dueOverrideAt: true, promisedDueAt: true, promisedTargetAt: true, shootDate: true,
        editorManual: true, editorId: true, editorVendorKey: true,
        editor: { select: { name: true } },
        deliverables: {
          where: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
          select: { id: true, type: true, label: true },
        },
      },
    });
    if (!project) return NO_PLANNING;
    const { effectiveDue } = await import("@/lib/editOverrides");
    const { editorKeyForTeamName, editorForDeliverable, editorMeta } = await import("@/lib/editors");
    const { isMonthlyContentJob } = await import("@/lib/pipeline");
    const { editorRouting } = await import("@/lib/settings");

    // THE SAME LADDER EVERY OTHER PROMISE READER USES (editOverrides.effectiveDue):
    // the office's typed date, else the promise the job was SOLD under, else
    // today's computed date. Nothing new is invented here.
    const promisedAt = effectiveDue(project, project.deliveryDue);
    // …and the internal aim only while the pin is still the promise in force.
    // Once the office types its own date, the aim frozen under the old promise
    // is not the aim any more, and showing it would contradict the deadline
    // printed beside it.
    const targetAt = project.dueOverrideAt ? null : project.promisedTargetAt ?? null;

    // WHO. The job's own editor first (a TeamMember, or the outside shop's
    // vendor key), read exactly the way the editor queue reads it.
    const pinnedKey =
      (editorKeyForTeamName(project.editor?.name) as EditorKey | null) ??
      ((project.editorVendorKey ?? null) as EditorKey | null);
    const editorName = pinnedKey ? editorMeta(pinnedKey)?.name ?? null : null;

    // …and, when nobody has it, where the rules WOULD send it. That is a
    // destination, never an assignment — `ownerFrom` carries the difference so
    // a screen cannot print a routing guess as a person's name. "Pinned to
    // nobody" (editorManual with no editor and no vendor) is a real answer and
    // the rules do not get to fill it back in (editors.pinnedEditorFor).
    const takenOff = !!project.editorManual && !project.editorId && !project.editorVendorKey;
    const routedNameByDeliverable = new Map<string, string>();
    if (!editorName && !takenOff) {
      const rules = await editorRouting().catch(() => undefined);
      const monthly = isMonthlyContentJob(project.deliverables, project.packageName);
      for (const d of project.deliverables) {
        const k = editorForDeliverable(d.type, d.label, monthly, rules);
        const name = k ? editorMeta(k)?.name ?? null : null;
        if (name) routedNameByDeliverable.set(d.id, name);
      }
    }
    return { promisedAt, targetAt, editorName, routedNameByDeliverable };
  } catch {
    // A lost lookup leaves the row rendering exactly as it did before this
    // existed — a missing owner, never a wrong one.
    return NO_PLANNING;
  }
}

function ownerForOutput(
  o: { ownerName: string | null; ownerKey: string | null },
  planning: JobPlanning,
  deliverableId: string,
): { name: string | null; from: OutputOwnerFrom | null } {
  // The office's own pick on THIS video, preserved untouched.
  if (o.ownerName?.trim() || o.ownerKey) return { name: o.ownerName?.trim() || o.ownerKey, from: "row" };
  if (planning.editorName) return { name: planning.editorName, from: "job" };
  const routed = planning.routedNameByDeliverable.get(deliverableId) ?? null;
  return routed ? { name: routed, from: "routing" } : { name: null, from: null };
}

// ===========================================================================
// THE LIFECYCLE, AFTER THE BACKFILL (audit R06, Sep 18).
//
// `ensureOutputsForProject` was called by the one-off materialisation script
// and by the four cut events in review/actions.ts — an UPLOAD, a verdict, a
// removal, a send. Every one of those happens after the video exists, so the
// claim that "booking gives every owed video a row" was ahead of the code: an
// order imported at 9am owed four videos and had four rows only once somebody
// uploaded the first cut. The reviewer found the same hole on the office's own
// edits (deliverableActions.recomputeAfterWaiver re-ran the status engine and
// the task engine, but not this one).
//
// The two helpers below are what the write paths call:
//   · ensureOutputsSafely — the per-event catch. It NEVER throws into an
//     editor's click or an order sync, and it never swallows the failure
//     silently either: it returns the error to its caller (which puts it in the
//     sync's own result) and logs it under one greppable tag.
//   · sweepOutputUnits    — the hourly repair, so a failed event is temporary
//     divergence rather than permanent. A job that fails the sweep TWICE IN A
//     ROW is not a blip: the sweep then throws, which is what puts the job on
//     the CronRun row and into the Slack ping (lib/cron failureSignature). That
//     is the difference between "recoverable" and "quietly wrong until somebody
//     runs scripts/materialise-outputs.ts by hand".
// ===========================================================================

export type EnsureAttempt = { ok: boolean; error: string | null; result: EnsureResult | null };

/** ensureOutputsForProject + refreshOutputsForProject, for a caller that must
 *  not fail because of them. Returns what went wrong instead of hiding it. */
export async function ensureOutputsSafely(projectId: string, source: string): Promise<EnsureAttempt> {
  try {
    const result = await ensureOutputsForProject(projectId);
    await refreshOutputsForProject(projectId);
    return { ok: true, error: null, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // One tag, so a person can find every one of these in the platform logs.
    console.warn(`[deliverable-outputs] ${source} could not materialise ${projectId}: ${error}`);
    return { ok: false, error, result: null };
  }
}

// ===========================================================================
// CP-09 — A FILMED TOPIC IS ONE OF THE EDITOR'S OWED VIDEOS (Sep 24 2026).
//
// The photographer's confirmation made a ContentVideo with a topic and no slot,
// and the editor's work is slots: "Personal Branding Reel — Video 2 of 4". The
// two never met. So the first cut uploaded for a slot made a SECOND logical
// video with no topic (the library keys cut chains by project × deliverable ×
// slot — contentVideos.ts videoBySlot), the topic → script link was lost on the
// way to the client, and the editor was told "Video 2 of 4" and nothing about
// which of the client's topics that is.
//
// bindTopicVideosToSlots gives each confirmed video a slot on the job's monthly
// video row: ContentVideo gets (deliverableId, slot, outputId), and the slot's
// DeliverableOutput gets the topic and the photographer's note. The library's
// videoBySlot then hands that slot's first cut to the topic's own video.
//
// NEVER A GUESS. Only a slot with nothing in it is used — no topic, no bound
// video, no review round. A slot an editor has already uploaded to is somebody
// else's video until a person says otherwise, so a video with no free slot
// (the office's videos-owed number is lower than what was filmed, or the cuts
// came first) is returned as unbound for the caller to flag. No Deliverable row
// is created, so editor routing — the monthly row goes to personal branding
// (Kim) — is exactly what it was.
// ===========================================================================

/**
 * "CP09" in ASCII. The namespace half of the per-project filming lock; the
 * other half is hashtext(projectId). Every writer of a filmed topic's video or
 * of its slot binding takes this lock first, so two submits, a submit and the
 * hourly sweep, or two sweeps can never each make or bind the same video.
 */
const FILMING_LOCK_NS = 0x43503039;

/**
 * Take the project's filming lock inside `tx`. ::int4 IS NOT DECORATION (Topaz
 * drill, Sep 18): Prisma sends a JS number as a bigint, Postgres has no
 * pg_advisory_xact_lock(bigint, bigint), and without the casts every call
 * raises 42883.
 */
export async function lockFilmingForProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FILMING_LOCK_NS}::int4, hashtext(${projectId})::int4)`;
}

export type BindResult = {
  /** videos given a slot by this call */
  bound: number;
  /** titles of confirmed videos that could not be given one — the caller flags them */
  unbound: string[];
  /** bound slots whose note to the editor changed */
  notesUpdated: number;
};

/**
 * Bind every confirmed filmed video on this job to a free owed-video slot, in
 * the month's rank order. Idempotent: a bound video keeps its slot, and a second
 * run binds nothing new. `notes` (topicId → the photographer's note) is written
 * onto the slot, and updates a note on a slot already bound.
 */
export async function bindTopicVideosToSlots(projectId: string, opts: { notes?: Record<string, string> } = {}): Promise<BindResult> {
  const out: BindResult = { bound: 0, unbound: [], notesUpdated: 0 };
  const confirmed = await prisma.contentVideo.findMany({
    where: { projectId, filmedConfirmedAt: { not: null }, status: { not: "ARCHIVED" } },
    select: { id: true },
  });
  if (!confirmed.length) return out;
  // The slots are sized from videosFilmed (reviewCuts.cutSlots: the monthly
  // row's count is at least the number filmed), and finalizeUpload writes that
  // number before any report is applied — so the rows exist by the time this
  // asks for them, provided materialisation itself works.
  // A failure here THROWS: binding against slots that were never made would
  // report every video as unbound, and the report's retry is the right answer.
  const ensured = await ensureOutputsSafely(projectId, "filmed-topics");
  if (!ensured.ok) throw new Error(`The job's video slots could not be materialised: ${ensured.error}`);
  // THE MONTHLY ROW — the first live video row by creation, which is the row
  // cutSlots sizes from videosFilmed. The same query cutSlots makes.
  const row = await prisma.deliverable.findFirst({
    where: { projectId, removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, waivedAt: true },
  });
  const notes = opts.notes ?? {};

  await prisma.$transaction(
    async (tx) => {
      await lockFilmingForProject(tx, projectId);
      // Everything re-read INSIDE the lock — a run that got here first has
      // bound some of these already.
      const videos = await tx.contentVideo.findMany({
        where: { projectId, filmedConfirmedAt: { not: null }, status: { not: "ARCHIVED" } },
        select: { id: true, topicId: true, selectionId: true, title: true, outputId: true, deliverableId: true, slot: true, createdAt: true },
      });
      const outputs =
        row && !row.waivedAt
          ? await tx.deliverableOutput.findMany({
              where: { deliverableId: row.id, removedFromOrderAt: null, waivedAt: null },
              orderBy: { slot: "asc" },
              select: { id: true, slot: true, topicId: true, filmingNote: true },
            })
          : [];
      const outputIds = outputs.map((o) => o.id);
      const [holders, rounds, selections] = await Promise.all([
        // Any live video already holding one of these slots, whoever made it.
        outputs.length
          ? tx.contentVideo.findMany({
              where: { status: { not: "ARCHIVED" }, OR: [{ outputId: { in: outputIds } }, { projectId, deliverableId: row!.id }] },
              select: { id: true, outputId: true, slot: true },
            })
          : Promise.resolve([] as { id: string; outputId: string | null; slot: number | null }[]),
        outputs.length
          ? tx.reviewSubmission.findMany({ where: { projectId, deliverableId: row!.id }, select: { slot: true } })
          : Promise.resolve([] as { slot: number | null }[]),
        tx.contentTopicSelection.findMany({
          where: { id: { in: videos.map((v) => v.selectionId).filter((x): x is string => !!x) } },
          select: { id: true, rank: true },
        }),
      ]);
      const takenOutput = new Set(holders.map((h) => h.outputId).filter((x): x is string => !!x));
      const takenSlot = new Set([...holders.filter((h) => h.slot != null).map((h) => h.slot as number), ...rounds.map((r) => r.slot ?? 1)]);
      const rankOf = new Map(selections.map((s) => [s.id, s.rank ?? 9_999]));
      const noteFor = (topicId: string | null) => (topicId && notes[topicId]?.trim() ? notes[topicId].trim().slice(0, 1000) : null);

      // A slot already bound keeps it; only its note can move.
      for (const v of videos.filter((x) => x.outputId)) {
        const o = outputs.find((x) => x.id === v.outputId);
        const note = noteFor(v.topicId);
        if (o && note && note !== o.filmingNote) {
          await tx.deliverableOutput.update({ where: { id: o.id }, data: { filmingNote: note } });
          out.notesUpdated++;
        }
      }

      // The rest, in the month's rank order, then the order they were filmed.
      const waiting = videos
        .filter((x) => !x.outputId)
        .sort((a, b) => (rankOf.get(a.selectionId ?? "") ?? 9_999) - (rankOf.get(b.selectionId ?? "") ?? 9_999) || a.createdAt.getTime() - b.createdAt.getTime());
      for (const v of waiting) {
        // A video that already names a slot (a staff mapping) is bound to THAT
        // slot or not at all — moving it, or binding it on another row, would
        // be a guess. Only a video with no slot of its own takes a free one.
        let free: (typeof outputs)[number] | null = null;
        if (v.deliverableId) {
          const own = row && v.deliverableId === row.id ? outputs.find((o) => o.slot === (v.slot ?? 1)) ?? null : null;
          free = own && !takenOutput.has(own.id) && (!own.topicId || own.topicId === v.topicId) ? own : null;
        } else {
          free = outputs.find((o) => !o.topicId && !takenOutput.has(o.id) && !takenSlot.has(o.slot)) ?? null;
        }
        if (!free) {
          out.unbound.push(v.title?.trim() || "(untitled video)");
          continue;
        }
        const moved = await tx.contentVideo.updateMany({
          where: { id: v.id, outputId: null },
          data: { deliverableId: row!.id, slot: free.slot, outputId: free.id },
        });
        if (!moved.count) continue;
        await tx.deliverableOutput.updateMany({
          where: { id: free.id, topicId: null },
          data: { topicId: v.topicId, filmingNote: noteFor(v.topicId) },
        });
        takenOutput.add(free.id);
        takenSlot.add(free.slot);
        out.bound++;
      }
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
  return out;
}

const SWEEP_HEALTH_KEY = "deliverable_outputs_sweep";
type SweepHealth = {
  failing: Record<string, { title: string; error: string; since: string; runs: number }>;
  lastRunAt: string | null;
  /** the last project id the rotation reached — see rotateFrom */
  cursor: string | null;
};
const EMPTY_HEALTH: SweepHealth = { failing: {}, lastRunAt: null, cursor: null };

export type OutputSweepResult = {
  /** jobs that owe video at all */
  owing: number;
  /** …of those, the ones that had NO row when the sweep started. This is the
   *  number that says whether the lifecycle wiring is holding. */
  bare: number;
  checked: number;
  created: number;
  retired: number;
  unretired: number;
  waived: number;
  unwaived: number;
  linkedRounds: number;
  stamped: number;
  failed: { projectId: string; title: string; error: string; runs: number }[];
  budgetHit: boolean;
};

/**
 * THE HOURLY REPAIR. Brings the per-video rows back in line with what each job
 * owes, without the manual backfill script.
 *
 * What it checks, and why it is not "every job, every hour": 645 jobs owe video
 * and each check is three round trips, which is not an hour's work to repeat
 * forever. It spends its budget where divergence actually shows up:
 *   1. every job that owes video and has NO row at all — the exact shape a
 *      missed booking leaves, and cheap to find (one groupBy);
 *   2. then a rotating window over the rest, oldest-checked first, so a
 *      quantity change, an office override or a failed event that nothing else
 *      caught is repaired within a full cycle rather than never.
 * Both are idempotent (ensureOutputsForProject's unique key is the arbiter), so
 * a run killed mid-way simply resumes.
 */
export async function sweepOutputUnits(opts: { max?: number; budgetMs?: number } = {}): Promise<OutputSweepResult> {
  const max = Math.max(1, opts.max ?? 40);
  const budgetMs = opts.budgetMs ?? 20_000;
  const t0 = Date.now();
  const out: OutputSweepResult = {
    owing: 0, bare: 0, checked: 0, created: 0, retired: 0, unretired: 0, waived: 0, unwaived: 0,
    linkedRounds: 0, stamped: 0, failed: [], budgetHit: false,
  };

  // Every job that owes a video today. CANCELLED is excluded and DELIVERED is
  // NOT: a delivered job whose client came back for a revision still owes the
  // replacement, and its rows are what the Review Room hangs the new round off.
  const owing = await prisma.project.findMany({
    where: {
      status: { not: "CANCELLED" },
      deliverables: { some: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
    },
    select: { id: true, title: true },
    orderBy: { id: "asc" },
  });
  out.owing = owing.length;
  if (owing.length === 0) return out;

  const withRows = new Set((await prisma.deliverableOutput.groupBy({ by: ["projectId"] })).map((g) => g.projectId));
  const bare = owing.filter((p) => !withRows.has(p.id));
  out.bare = bare.length;

  const health = await readSweepHealth();
  // A job that failed last time is looked at again FIRST — that is what makes
  // the second failure (and the alarm) happen on the next tick rather than
  // whenever the rotation happens to come round.
  const retry = owing.filter((p) => health.failing[p.id] && !bare.some((b) => b.id === p.id));
  const rotation = rotateFrom(owing, health.cursor, max);
  const inRotation = new Set(rotation.map((p) => p.id));
  const queue: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const p of [...retry, ...bare, ...rotation]) {
    if (seen.has(p.id) || queue.length >= max) continue;
    seen.add(p.id);
    queue.push(p);
  }

  const stillFailing: SweepHealth["failing"] = {};
  // The cursor only ever moves for a job the ROTATION reached. A tick spent
  // entirely on bare or retried jobs must not teleport the window somewhere
  // else and leave a stretch of the list unvisited for another full cycle.
  let lastRotated: string | null = null;
  const visited = new Set<string>();
  for (const p of queue) {
    if (Date.now() - t0 > budgetMs) {
      out.budgetHit = true;
      break;
    }
    out.checked++;
    visited.add(p.id);
    if (inRotation.has(p.id)) lastRotated = p.id;
    try {
      const r = await ensureOutputsForProject(p.id);
      out.created += r.created;
      out.retired += r.retired;
      out.unretired += r.unretired;
      out.waived += r.waived;
      out.unwaived += r.unwaived;
      out.linkedRounds += r.linkedRounds;
      out.stamped += await refreshOutputsForProject(p.id);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const before = health.failing[p.id];
      const runs = (before?.runs ?? 0) + 1;
      stillFailing[p.id] = { title: p.title, error, since: before?.since ?? new Date().toISOString(), runs };
      out.failed.push({ projectId: p.id, title: p.title, error, runs });
    }
  }
  // Only the jobs this run actually LOOKED AT have an answer. A job the budget
  // cut off before it was reached keeps whatever the ledger already said about
  // it — clearing it would reset a failing job's run count to zero and the
  // escalation below could never fire on a busy tick.
  const nextFailing = { ...health.failing };
  for (const id of visited) delete nextFailing[id];
  await writeSweepHealth(
    { failing: { ...nextFailing, ...stillFailing }, lastRunAt: new Date().toISOString() },
    lastRotated ?? health.cursor,
  );

  // PERMANENT DIVERGENCE IS AN ALARM, NOT A FIELD IN A JSON BLOB. One bad tick
  // is a blip and stays in the result above; the same job failing on two
  // consecutive sweeps means nothing is going to fix it on its own, so it is
  // thrown — cronBudget records it as `outputUnitsError` on the CronRun row and
  // Slack-pings it once (lib/cron). Everything this run repaired is already
  // committed; throwing only changes how loudly the rest is reported.
  const permanent = out.failed.filter((f) => f.runs >= 2);
  if (permanent.length > 0) {
    throw new Error(
      `${permanent.length} job(s) cannot be brought in line with what they owe: ` +
        permanent.map((f) => `${f.title} (${f.error})`).join("; ").slice(0, 400),
    );
  }
  return out;
}

/** The rotation window: `max` jobs starting after the last id this sweep
 *  reached, wrapping round. Ids are stable and ordered, so the window walks the
 *  whole list and comes back — no timestamp column to add, nothing to migrate. */
function rotateFrom<T extends { id: string }>(all: T[], afterId: string | null, max: number): T[] {
  if (all.length === 0) return [];
  const start = afterId ? all.findIndex((p) => p.id === afterId) + 1 : 0;
  const from = start <= 0 || start >= all.length ? 0 : start;
  const window = all.slice(from, from + max);
  return window.length >= max ? window : [...window, ...all.slice(0, max - window.length)];
}

async function readSweepHealth(): Promise<SweepHealth> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SWEEP_HEALTH_KEY }, select: { value: true } });
    if (!row) return EMPTY_HEALTH;
    const parsed = JSON.parse(row.value) as Partial<SweepHealth>;
    return { failing: parsed.failing ?? {}, lastRunAt: parsed.lastRunAt ?? null, cursor: parsed.cursor ?? null };
  } catch {
    return EMPTY_HEALTH;
  }
}

async function writeSweepHealth(health: Omit<SweepHealth, "cursor">, cursor: string | null): Promise<void> {
  const value = JSON.stringify({ ...health, cursor });
  await prisma.appSetting
    .upsert({ where: { key: SWEEP_HEALTH_KEY }, create: { key: SWEEP_HEALTH_KEY, value }, update: { value } })
    .catch(() => {
      /* the ledger is diagnostics — losing it must never fail the sweep */
    });
}
