import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// NOTES ON A DELIVERED JOB CLOSE THEMSELVES (Jordan, Sep 28 2026: "for the
// editor stuff lets make sure we are up to date and anything completed and
// delivered can be closed out").
//
// The one-time clean-up that morning found 16 editor-cut and delivery-fix
// notes still OPEN or FIXED on 7 jobs that had been delivered AFTER the notes
// were written — the fixes were made and shipped outside the Room, and the
// notes sat in "Feedback follow-through" as if someone still owed them. This
// is the standing rule behind that clean-up, run by the hourly cron:
//
//   · top-level MediaNote rows only (a reply has no status of its own);
//   · lanes EDITOR (edit feedback) and EDIT (Kyle's delivery fixes) — NEVER
//     PHOTOGRAPHER: capture coaching is about the photographer's next shoot,
//     not this job, and delivery does not answer it;
//   · status OPEN or FIXED;
//   · the job is DELIVERED now and its deliveredAt is AFTER the note was
//     written. A note written after delivery is new work on a finished job and
//     stays open; a job the client reopened is not DELIVERED, so its notes stay;
//   · the note's LAST MOVE came before delivery too (statusAt, else its birth).
//     A person who reopens a closed-out note, or an editor who marks a note
//     fixed after the client already had the job, has made a decision about a
//     delivered job, and the next run must not undo it;
//   · the note is on a REVIEW ROOM CUT (its assetUrl is a round's stream URL,
//     or cut:<id> for a round with no link), and THAT CUT shows a fix cycle
//     after the note: a newer live round of the same cut (same deliverable and
//     slot, or the same file for a legacy folder row) uploaded after it, or a
//     round of it — this one or a newer one — APPROVED after it. For a note
//     somebody reopened, "after it" means after the reopen: the desk said
//     "still owed" then, and only a later cycle answers that.
//
// WHY THE LAST TWO (review, Sep 28). deliveredAt is ONE stamp for the whole
// job, written when the status sweep NOTICES the last ordered category landed
// (projectStatus.ts) — not when any particular asset reached the client. On
// the usual photo-plus-video job the photos go out days before the video; a
// photo fix written in between predates the job's stamp without predating the
// photos' delivery, so the job-level comparison alone closed fixes nobody
// made. Likewise video 1 of a multi-video job (closed when the last video
// landed) and a note written on the approved cut after the client had it but
// before the sweep noticed. So the job's stamp only says "the job is
// finished"; what says "this note was answered" is its cut's own history.
// Gallery notes on delivered photos and listing media carry no such history
// and are left to a person; a note written after its cut's own approval (the
// post-approval defect revisionIssues marks foundAfterApproval) has no fix
// cycle after it, so it stays too. And the first version re-closed a hand
// reopen every hour, overwriting the reviewer's name — hence the last-move
// test and the compare-and-set on statusAt below.
//
// Each note is resolved with a compare-and-set on its OWN status and statusAt
// (and on the job still being delivered), stamped statusBy "Closed out: job
// delivered" — the same words the clean-up used — and each job gets ONE
// timeline line per run, written in the same transaction as its notes.
//
// A DELIVERED JOB IS NOT A CHECKED FIX. The desk's own "Approve" on a note
// mirrors it into its RevisionIssue as VERIFIED (revisionIssues.
// mirrorNoteStatus), which is what the editor KPIs count. Nothing here does
// that: a linked issue is left exactly as it is, and only counted in the run
// summary so the number is visible.
// ---------------------------------------------------------------------------

/** statusBy on every note this rule closes — the Sep 28 clean-up's words. */
export const DELIVERED_CLOSE_OUT_BY = "Closed out: job delivered";

/** The lanes a delivery answers. PHOTOGRAPHER is deliberately absent. */
export const DELIVERED_CLOSE_OUT_LANES = ["EDITOR", "EDIT"] as const;

export type DeliveredNotesResult = {
  /** notes that matched the rule when read */
  matched: number;
  /** notes this run resolved */
  closed: number;
  /** matched, but moved (or the job left DELIVERED) before the write — left alone */
  raced: number;
  /** jobs that got a timeline line */
  jobs: number;
  byLane: { EDITOR: number; EDIT: number };
  /** RevisionIssue rows linked to the closed notes — left untouched, never VERIFIED */
  linkedIssuesLeft: number;
};

type Row = { id: string; projectId: string; lane: string; status: string; statusAt: Date | null; title: string | null; deliveredAt: Date };

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

/** The timeline line for one job — the clean-up's sentence, without "at Jordan's request". */
export function deliveredCloseOutLine(deliveredAt: Date, n: number, lanes: { editor: number; fix: number }): string {
  const kinds = [lanes.editor ? "editor" : null, lanes.fix ? "delivery-fix" : null].filter(Boolean).join(" and ");
  const one = n === 1;
  return `Closed out: the job was delivered on ${shortDate(deliveredAt)}, so ${n} ${kinds} note${one ? " that was" : "s that were"} still open or awaiting a re-look ${one ? "was" : "were"} marked resolved.`;
}

/**
 * The hourly step. Idempotent: a second run over the same data finds nothing
 * (every note it closed is RESOLVED, and one a person moves afterwards carries
 * a statusAt after the delivery) and writes nothing. Never sends anything.
 */
export async function closeDeliveredJobNotes(opts: { max?: number; now?: Date } = {}): Promise<DeliveredNotesResult> {
  const max = Math.max(1, Math.min(opts.max ?? 200, 1000));
  const out: DeliveredNotesResult = { matched: 0, closed: 0, raced: 0, jobs: 0, byLane: { EDITOR: 0, EDIT: 0 }, linkedIssuesLeft: 0 };

  // Column against column, so the rule is read exactly in SQL.
  //   s  = the round the note is on (by its stream URL, or cut:<id>)
  //   s2 = a round of the SAME cut (reviewCuts.cutKeyOf: deliverable+slot, or
  //        the file path for a legacy folder row, or s itself) that answers
  //        the note: newer and uploaded after it, or approved after it.
  // "After it" is the note's birth — or, for an OPEN note somebody reopened,
  // the reopen (statusAt): a FIXED note's statusAt is the editor's own click,
  // which usually follows the round that carries the fix.
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT n."id", n."projectId", n."lane", n."status", n."statusAt", p."title", p."deliveredAt"
      FROM "MediaNote" n
      JOIN "Project" p ON p."id" = n."projectId"
     WHERE n."parentId" IS NULL
       AND n."status" IN ('OPEN', 'FIXED')
       AND n."lane" IN ('EDITOR', 'EDIT')
       AND p."status" = 'DELIVERED'
       AND p."deliveredAt" IS NOT NULL
       AND p."deliveredAt" > n."createdAt"
       AND p."deliveredAt" > COALESCE(n."statusAt", n."createdAt")
       AND EXISTS (
         SELECT 1
           FROM "ReviewSubmission" s
           JOIN "ReviewSubmission" s2 ON s2."projectId" = s."projectId"
          WHERE s."projectId" = n."projectId"
            AND (s."assetUrl" = n."assetUrl" OR n."assetUrl" = 'cut:' || s."id")
            AND s2."status" NOT IN ('UPLOADING', 'UPLOAD_FAILED', 'SUPERSEDED', 'WITHDRAWN')
            AND (
                  s2."id" = s."id"
               OR (s."deliverableId" IS NOT NULL AND s2."deliverableId" = s."deliverableId" AND s2."slot" = s."slot")
               OR (s."deliverableId" IS NULL AND s."assetPath" IS NOT NULL AND s2."deliverableId" IS NULL AND s2."assetPath" = s."assetPath")
            )
            AND (
                  (s2."round" > s."round"
                   AND s2."createdAt" > (CASE WHEN n."status" = 'OPEN' THEN COALESCE(n."statusAt", n."createdAt") ELSE n."createdAt" END))
               OR (s2."round" >= s."round" AND s2."status" = 'APPROVED' AND s2."decidedAt" IS NOT NULL
                   AND s2."decidedAt" > (CASE WHEN n."status" = 'OPEN' THEN COALESCE(n."statusAt", n."createdAt") ELSE n."createdAt" END))
            )
       )
     ORDER BY n."projectId", n."createdAt"
     LIMIT ${max}::int`;
  out.matched = rows.length;
  if (rows.length === 0) return out;

  const byJob = new Map<string, Row[]>();
  for (const r of rows) byJob.set(r.projectId, [...(byJob.get(r.projectId) ?? []), r]);

  const closedIds: string[] = [];
  for (const [projectId, notes] of byJob) {
    const at = opts.now ?? new Date();
    // One job at a time, notes and line together: a line is never written for
    // notes that did not close, and notes never close without their line.
    const won = await prisma.$transaction(async (tx) => {
      const mine: Row[] = [];
      for (const r of notes) {
        const u = await tx.mediaNote.updateMany({
          where: {
            id: r.id,
            // compare-and-set on the note's own status AND its last move: a
            // note somebody touched between the read and this write (even one
            // that ended up back where it was) is theirs, not this rule's.
            status: r.status,
            statusAt: r.statusAt,
            parentId: null,
            lane: { in: [...DELIVERED_CLOSE_OUT_LANES] },
            // …and on the job still being delivered: a reopen that lands
            // between the read and this write keeps its notes.
            project: { is: { status: "DELIVERED" } },
          },
          data: { status: "RESOLVED", resolvedAt: at, statusBy: DELIVERED_CLOSE_OUT_BY, statusAt: at },
        });
        if (u.count) mine.push(r);
      }
      if (mine.length) {
        const editor = mine.filter((r) => r.lane === "EDITOR").length;
        await tx.activity.create({
          data: {
            projectId,
            type: "SYSTEM",
            body: deliveredCloseOutLine(notes[0].deliveredAt, mine.length, { editor, fix: mine.length - editor }),
          },
        });
      }
      return mine;
    });
    out.raced += notes.length - won.length;
    if (won.length === 0) continue;
    out.jobs++;
    out.closed += won.length;
    for (const r of won) {
      closedIds.push(r.id);
      if (r.lane === "EDITOR") out.byLane.EDITOR++;
      else out.byLane.EDIT++;
    }
  }

  // Counted, never touched (see the header).
  if (closedIds.length) {
    out.linkedIssuesLeft = await prisma.revisionIssue.count({ where: { sourceKind: "REVIEW_NOTE", sourceId: { in: closedIds } } });
  }
  return out;
}
