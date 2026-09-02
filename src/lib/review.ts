import "server-only";
import { prisma } from "@/lib/prisma";
import { stripMoneySentences } from "@/lib/text";

// ---------------------------------------------------------------------------
// Read layer for the in-house media review room. Root notes
// are pin-point feedback on a delivered asset (EDIT lane → Kyle fixes it,
// PHOTOGRAPHER lane → capture feedback to whoever shot it); replies thread
// under a root via parentId and carry no pin or meaningful status. Rollups
// therefore ALWAYS filter parentId null — a chatty thread must never inflate
// an "open fixes" count. Mutations live in src/app/projects/reviewActions.ts.
// ---------------------------------------------------------------------------

export type ReviewNote = {
  id: string;
  assetUrl: string;
  thumbUrl: string | null;
  assetType: "image" | "video";
  x: number | null;
  y: number | null;
  timeSec: number | null;
  lane: "EDIT" | "PHOTOGRAPHER";
  kind: "fix" | "coaching";
  body: string;
  status: "OPEN" | "FIXED" | "RESOLVED";
  authorName: string | null;
  createdAt: string;
  // Feedback-loop receipts (photographer lane): texted / opened / "got it".
  sharedAt: string | null;
  seenAt: string | null;
  acknowledgedAt: string | null;
  replies: { id: string; body: string; authorName: string | null; createdAt: string }[];
};

// The DB stores these as plain strings (SQLite-era schema style) — narrow them
// defensively so a bad row can't break the page.
const asAssetType = (v: string): "image" | "video" => (v === "video" ? "video" : "image");
const asLane = (v: string): "EDIT" | "PHOTOGRAPHER" => (v === "PHOTOGRAPHER" ? "PHOTOGRAPHER" : "EDIT");
const asKind = (v: string): "fix" | "coaching" => (v === "coaching" ? "coaching" : "fix");
const asStatus = (v: string): "OPEN" | "FIXED" | "RESOLVED" =>
  v === "FIXED" ? "FIXED" : v === "RESOLVED" ? "RESOLVED" : "OPEN";

export type NoteRow = {
  id: string;
  assetUrl: string;
  thumbUrl: string | null;
  assetType: string;
  x: number | null;
  y: number | null;
  timeSec: number | null;
  lane: string;
  kind: string;
  body: string;
  status: string;
  authorName: string | null;
  createdAt: Date;
  sharedAt?: Date | null;
  seenAt?: Date | null;
  acknowledgedAt?: Date | null;
  replies: { id: string; body: string; authorName: string | null; createdAt: Date }[];
};

// Exported for the cross-shoot feedback hub (src/lib/photographerFeedback.ts),
// which maps the same rows into the same view shape.
export function toReviewNote(n: NoteRow): ReviewNote {
  return {
    id: n.id,
    assetUrl: n.assetUrl,
    thumbUrl: n.thumbUrl,
    assetType: asAssetType(n.assetType),
    x: n.x,
    y: n.y,
    timeSec: n.timeSec,
    lane: asLane(n.lane),
    kind: asKind(n.kind),
    body: n.body,
    status: asStatus(n.status),
    authorName: n.authorName,
    createdAt: n.createdAt.toISOString(),
    sharedAt: n.sharedAt?.toISOString() ?? null,
    seenAt: n.seenAt?.toISOString() ?? null,
    acknowledgedAt: n.acknowledgedAt?.toISOString() ?? null,
    replies: n.replies.map((r) => ({
      id: r.id,
      body: r.body,
      authorName: r.authorName,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

// Everything the review room needs for one project: root notes (newest first,
// replies oldest-first inside each thread) + the per-asset quick verdicts.
export async function getProjectReview(
  projectId: string,
): Promise<{ notes: ReviewNote[]; verdicts: Record<string, "APPROVED" | "NEEDS_WORK"> }> {
  const [notes, verdictRows] = await Promise.all([
    prisma.mediaNote.findMany({
      where: { projectId, parentId: null },
      orderBy: { createdAt: "desc" },
      include: { replies: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.mediaVerdict.findMany({ where: { projectId } }),
  ]);
  const verdicts: Record<string, "APPROVED" | "NEEDS_WORK"> = {};
  for (const v of verdictRows) {
    if (v.verdict === "APPROVED" || v.verdict === "NEEDS_WORK") verdicts[v.assetUrl] = v.verdict;
  }
  return { notes: notes.map(toReviewNote), verdicts };
}

// Read receipt: the photographer THEMSELVES opened their feedback — stamp
// every unseen root note in their lane. Callers must pass this only for the
// real photographer's own page load (owner/"view as" previews never stamp;
// a preview isn't the creative reading it).
export async function markFeedbackSeen(memberId: string, projectId?: string): Promise<void> {
  if (!memberId) return;
  await prisma.mediaNote
    .updateMany({
      where: { lane: "PHOTOGRAPHER", photographerId: memberId, parentId: null, seenAt: null, ...(projectId ? { projectId } : {}) },
      data: { seenAt: new Date() },
    })
    .catch(() => {});
}

// A photographer's slice of the review: only PHOTOGRAPHER-lane notes addressed
// to THEM (photographerId scoping, same fail-closed spirit as /shoot).
export async function getPhotographerFeedback(projectId: string, memberId: string): Promise<ReviewNote[]> {
  if (!memberId) return [];
  const notes = await prisma.mediaNote.findMany({
    where: { projectId, parentId: null, lane: "PHOTOGRAPHER", photographerId: memberId },
    orderBy: { createdAt: "desc" },
    include: { replies: { orderBy: { createdAt: "asc" } } },
  });
  return notes.map(toReviewNote);
}

// What the CLIENT said about a shoot, safe for the photographer who shot it.
// The sentiment-in filter deliberately fails closed: NEGATIVE and null-sentiment
// rows never match, because negative client feedback NEVER reaches creatives
// (playbook rule — Jordan handles it, then briefs them himself). Bodies are
// money-scrubbed server-side too: clients mention price in praise all the time.
export type ClientFeedbackRow = {
  id: string;
  rating: number | null;
  body: string;
  authorName: string | null;
  createdAt: string;
};

export async function getClientFeedback(projectId: string, memberId: string): Promise<ClientFeedbackRow[]> {
  if (!memberId) return [];
  const rows = await prisma.feedback.findMany({
    where: { projectId, photographerId: memberId, sentiment: { in: ["POSITIVE", "NEUTRAL"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, rating: true, body: true, authorName: true, createdAt: true },
  });
  const { hasNegativeCues } = await import("@/lib/feedback");
  return rows
    .map((r) => ({
      id: r.id,
      rating: r.rating,
      // The sentiment column trusts stars over words (4★ + "please redo the
      // yard" is POSITIVE) — the criticism itself must never render for the
      // photographer. Mixed reviews show their stars only; Jordan relays the
      // notes himself.
      body: hasNegativeCues(r.body) ? "" : stripMoneySentences(r.body),
      authorName: r.authorName,
      createdAt: r.createdAt.toISOString(),
    }))
    // A row whose body scrubbed away entirely still shows if it carries stars.
    .filter((r) => r.body || r.rating != null);
}

// Badge counts for the project page — root notes only (replies never count).
export async function reviewCounts(
  projectId: string,
): Promise<{ editOpen: number; photogOpen: number; fixed: number }> {
  const [editOpen, photogOpen, fixed] = await Promise.all([
    prisma.mediaNote.count({ where: { projectId, parentId: null, lane: "EDIT", status: "OPEN" } }),
    prisma.mediaNote.count({ where: { projectId, parentId: null, lane: "PHOTOGRAPHER", status: "OPEN" } }),
    prisma.mediaNote.count({ where: { projectId, parentId: null, status: "FIXED" } }),
  ]);
  return { editOpen, photogOpen, fixed };
}
