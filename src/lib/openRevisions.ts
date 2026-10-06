// ---------------------------------------------------------------------------
// WHAT IS STILL OWED ON A JOB IN REVISIONS, AND SINCE WHEN (Oct 6 2026).
//
// Jordan: "Can we also have notifications sent to the editors for projects
// that have been in revision for over 24 hours? Like for example - Kim has had
// a revision open for a week or more now for Bernadette Rabel."
//
// WHETHER a job is in revisions is NOT decided here. That is the Editing
// Room's own word — editorQueue.buildEditorQueue's "Revisions" pill (a cut
// whose newest round came back with changes, a round still open on the edit
// card, or, on a job the Review Room has never seen, an open video-lane
// revision card) — and only a row wearing that word is ever folded here. This
// file answers the next question for such a row: which asks are open on it,
// per video, and since when — so the editor's reminder, the queue row's
// "waiting N days" and Kyle's stuck list all quote one age.
//
// SINCE WHEN is when the changes were asked for, never Project.updatedAt:
//   · a cut sent back      — the verdict's own moment: the reviewer's
//                            decidedAt, or the client's clientRequestedAt when
//                            the client sent back an approved cut (verdictOf,
//                            the Review Room's attribution rule);
//   · a client's ask on an APPROVED video by email, text, a call or the
//                            Review Room's "record the client's changes" —
//                            which leave the cut approved (the client keeps
//                            it) — the ask's own moment (reopenedByClient);
//   · a round on the card  — the job's "changes requested" stamp, never older
//                            than the version being redone;
//   · a revision card on a job with no cut in the Review Room — the job's
//                            "changes requested" stamp (the newest ask; it is
//                            cleared when a revision is resolved, so a card
//                            reopened weeks later never reads weeks old), else
//                            the card's creation;
//   · an office pin on Revisions with nothing else open — that stamp, else the
//                            pin's own time.
// An ask with no moment on the record is left out rather than aged from a
// guess. NO NEWER VERSION is the queue's rule too: only the NEWEST round of a
// cut speaks for it, so once a v2 is in, v1's send-back is no longer owed.
//
// Pure and client-safe: no "server-only", no prisma. The queue builds the
// facts from rows it has already read; the reminder sweep reads the asks back
// off the queue rows (revisionReminders.ts).
// ---------------------------------------------------------------------------
import { verdictOf } from "@/lib/reviewAttribution";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** One round of a cut, as the queue reads it (rounds that ARE cuts only — the
 *  queue drops UPLOADING / UPLOAD_FAILED / SUPERSEDED / WITHDRAWN first). */
export type RevisionCutRound = {
  id: string;
  /** reviewCuts.cutKeyOf — which cut this round is a version of */
  cutKey: string;
  deliverableId: string | null;
  slot: number | null;
  outputId: string | null;
  round: number;
  status: string;
  createdAt: Date | string;
  decidedAt: Date | string | null;
  decidedBy: string | null;
  clientRequestedAt?: Date | string | null;
  clientRequestedBy?: string | null;
};

/**
 * A client's ask on an open VIDEO-lane revision card (not the office's own
 * reopen): one per work-order brief, or the card itself when it has none.
 * `cutKey` is the video it names (the brief's pinned cut or video), null when
 * it names none.
 */
export type ClientAskFact = { id: string; at: Date | string; cutKey: string | null; by: string | null };

export type RevisionJobFacts = {
  cuts: RevisionCutRound[];
  /** Client asks on the job's open video-lane revision cards (Oct 6). */
  clientAsks?: ClientAskFact[];
  /** The edit card's open round ("Round N — …", tasks.EDIT_ROUND_SUMMARY). */
  roundOwed: boolean;
  /** The open edit card's id, when there is one. */
  editCardId?: string | null;
  /** Open VIDEO-lane revision cards — the set the queue counts as revisions. */
  revisionTasks: { id: string; createdAt: Date | string; outputId?: string | null; officeBy?: string | null; office?: boolean; contactName?: string | null }[];
  /** Project.revisionRequestedAt — the newest ask; cleared on resolve. */
  revisionRequestedAt: Date | string | null;
  /** Project.statusPinnedAt — the office's pin (editOverrides). */
  statusPinnedAt?: Date | string | null;
};

export type RevisionAsk = {
  /** What one reminder series hangs on: the bounced round's id, the revision
   *  card's id, or the round/pin marker. Unique within the job. */
  askId: string;
  kind: "cut" | "client" | "round" | "task" | "pinned";
  /** Who asked: the office (a reviewer, the queue pill, a reopen) or the client. Null = not on the record. */
  source: "office" | "client" | null;
  /** The person, when the record names one. */
  by: string | null;
  deliverableId: string | null;
  slot: number | null;
  outputId: string | null;
  sinceISO: string;
};

const ms = (d: Date | string | null | undefined): number | null => {
  if (!d) return null;
  const t = (typeof d === "string" ? new Date(d) : d).getTime();
  return Number.isFinite(t) ? t : null;
};
const maxMs = (...xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x != null);
  return ok.length ? Math.max(...ok) : null;
};

/** The newest round of each cut — only it speaks for the cut (editorQueue's latestCut). */
function latestOf(cuts: RevisionCutRound[]): Map<string, RevisionCutRound> {
  const latest = new Map<string, RevisionCutRound>();
  for (const c of cuts) {
    const cur = latest.get(c.cutKey);
    if (!cur || c.round > cur.round) latest.set(c.cutKey, c);
  }
  return latest;
}

export type ClientReopen = {
  /** The video the client reopened; null = the job (an ask naming no video). */
  cutKey: string | null;
  /** Its newest round — the APPROVED version the ask came in on. */
  round: RevisionCutRound | null;
  /** The oldest of the client's asks still open on it. */
  ask: ClientAskFact;
};

/**
 * THE CLIENT ASKED FOR CHANGES ON A VIDEO WE HAD APPROVED (Oct 6 2026). An
 * email, a text, a call or the Review Room's "record the client's changes"
 * opens a revision card and leaves the cut APPROVED — rightly: the client
 * keeps the approved version (Jordan's rule), so the Review Room's record is
 * not touched. The EDITOR still owes the next version, and the Editing Room
 * said "Approved". This is that work, read off the same rows:
 *
 *   · an ask naming a video (or any ask on a one-cut job) reopens that video
 *     when its newest round is APPROVED and was handed in BEFORE the ask — a
 *     version uploaded after the ask answers it, so the video leaves
 *     Revisions the moment the editor uploads;
 *   · a video whose newest round is already CHANGES_REQUESTED (an internal
 *     send-back, or the client's own portal send-back) is NOT reopened again:
 *     it is already owed once, and counting the email on top would count it
 *     twice;
 *   · an ask naming no video on a multi-video job reopens the JOB only when
 *     every video's newest round is approved and older than the ask — an
 *     approved job the client wrote back about. Anything else on such a job
 *     is already on the editor's desk by another rule.
 * The oldest still-open ask per video is the one that dates it. Pure.
 */
export function reopenedByClient(cuts: RevisionCutRound[], asks: ClientAskFact[]): ClientReopen[] {
  const latest = latestOf(cuts);
  if (latest.size === 0 || asks.length === 0) return [];
  const only = latest.size === 1 ? [...latest.keys()][0] : null;
  const out = new Map<string, ClientReopen>();
  const sorted = [...asks].filter((a) => ms(a.at) != null).sort((a, b) => ms(a.at)! - ms(b.at)!);
  for (const a of sorted) {
    const at = ms(a.at)!;
    const key = a.cutKey ?? only;
    if (key) {
      const r = latest.get(key);
      // A video with no cut yet is "to edit" already; one not APPROVED is
      // already owed (sent back) or with the office (a newer version is in).
      if (!r || r.status !== "APPROVED" || (ms(r.createdAt) ?? Infinity) >= at) continue;
      if (!out.has(key)) out.set(key, { cutKey: key, round: r, ask: a });
    } else {
      const all = [...latest.values()];
      if (all.every((r) => r.status === "APPROVED" && (ms(r.createdAt) ?? Infinity) < at) && !out.has("")) out.set("", { cutKey: null, round: null, ask: a });
    }
  }
  return [...out.values()];
}

/** The asks open on ONE job the queue calls "Revisions", oldest first. */
export function openRevisionAsks(f: RevisionJobFacts): RevisionAsk[] {
  const latest = latestOf(f.cuts);
  const asks: RevisionAsk[] = [];
  for (const c of latest.values()) {
    if (c.status !== "CHANGES_REQUESTED") continue;
    const v = verdictOf(c);
    const at = ms(v?.atISO) ?? ms(c.decidedAt) ?? ms(c.clientRequestedAt) ?? ms(c.createdAt);
    if (at == null) continue;
    asks.push({
      askId: c.id,
      kind: "cut",
      source: v?.source === "client" ? "client" : "office",
      by: v?.by ?? null,
      deliverableId: c.deliverableId,
      slot: c.deliverableId ? c.slot ?? 1 : null,
      outputId: c.outputId,
      sinceISO: new Date(at).toISOString(),
    });
  }
  // The client's ask on an approved video (never one already sent back).
  for (const r of reopenedByClient(f.cuts, f.clientAsks ?? [])) {
    asks.push({
      askId: `client:${r.ask.id}`,
      kind: "client",
      source: "client",
      by: r.ask.by,
      deliverableId: r.round?.deliverableId ?? null,
      slot: r.round?.deliverableId ? r.round.slot ?? 1 : null,
      outputId: r.round?.outputId ?? null,
      sinceISO: new Date(ms(r.ask.at)!).toISOString(),
    });
  }
  const requested = ms(f.revisionRequestedAt);
  if (latest.size > 0 && asks.length === 0 && f.roundOwed) {
    // A round on the card with no bounced cut behind it — the queue pill's
    // "Revisions" flip. It asks for the version after the newest one in, so
    // it is never older than that version (or its verdict).
    const newest = [...latest.values()].reduce((a, b) => ((ms(b.createdAt) ?? 0) > (ms(a.createdAt) ?? 0) ? b : a));
    const at = maxMs(requested, ms(newest.createdAt), ms(newest.decidedAt), ms(newest.clientRequestedAt ?? null));
    if (at != null) asks.push({ askId: `round:${newest.id}`, kind: "round", source: "office", by: null, deliverableId: null, slot: null, outputId: null, sinceISO: new Date(at).toISOString() });
  } else if (latest.size === 0) {
    // The Review Room has never seen this job: the open revision cards are the
    // asks (one per card — the video lane keeps one card per job).
    for (const t of f.revisionTasks) {
      const at = requested ?? ms(t.createdAt);
      if (at == null) continue;
      asks.push({
        askId: t.id,
        kind: "task",
        source: t.office ? "office" : "client",
        by: t.office ? t.officeBy ?? null : t.contactName ?? null,
        deliverableId: null,
        slot: null,
        outputId: t.outputId ?? null,
        sinceISO: new Date(at).toISOString(),
      });
    }
    if (asks.length === 0 && f.roundOwed && requested != null) {
      asks.push({ askId: `round:${f.editCardId ?? "card"}`, kind: "round", source: "office", by: null, deliverableId: null, slot: null, outputId: null, sinceISO: new Date(requested).toISOString() });
    }
  }
  if (asks.length === 0) {
    // On Revisions by the office's pin and nothing else open: dated by the
    // job's own stamp, else the pin. Nothing on the record → nothing to age.
    const at = requested ?? ms(f.statusPinnedAt ?? null);
    if (at != null) asks.push({ askId: "pinned", kind: "pinned", source: "office", by: null, deliverableId: null, slot: null, outputId: null, sinceISO: new Date(at).toISOString() });
  }
  return asks.sort((a, b) => a.sinceISO.localeCompare(b.sinceISO));
}

/** Whole days an ask has waited (rounded down: 47 hours is "1 day"). */
export function waitedDays(sinceISO: string, now: Date): number {
  const t = Date.parse(sinceISO);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : 0;
}

/** "1 day" / "11 days". */
export const dayWords = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;
