import "server-only";
import { prisma } from "@/lib/prisma";
import { dbx, DropboxError } from "@/lib/integrations/dropbox";
import { actualFolderPaths, type FolderProject } from "@/lib/dropboxFolders";

// ---------------------------------------------------------------------------
// Finished cuts → Review Room rows. ONE place that turns the files in a job's
// Dropbox 05-Final-Video folder into ReviewSubmission rows, used by both the
// hourly sweep (auto-supply) and the editor's "Done — send to review" button.
//
// Why this exists (Sep 1 2026 audit, HIGH): the room had no playable video on
// any submission. Two causes —
//   1. the sweep minted ONE blank placeholder per project (no path, no file)
//      and never looked again, so a monthly batch's videos 2..N never entered
//      review;
//   2. the editor's submit tried to mint a public shared link, but the Dropbox
//      app has no sharing scope, so even a real submit stored assetUrl=null.
// Now: one row per (file, round), keyed by assetPath — the identity every
// reader already uses — and a STABLE same-origin assetUrl that the stream
// route turns into a fresh 4-hour temporary link on every play (the only link
// type this token can mint, and the safer one: no public URLs to unreleased
// client videos).
// ---------------------------------------------------------------------------

export type FinalCut = { path: string; name: string; serverModified: Date; size: number };

const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;
const AUTO_NAME = "Auto — Final folder";

/** The stable URL stored on a submission; the route re-mints the real link. */
export const streamUrlFor = (submissionId: string) => `/api/review/cut/${submissionId}/stream`;

/** Video files in the job's Final folder, oldest first. [] = folder missing or
 *  empty (a trustworthy zero); null = Dropbox couldn't be read (unknown). */
export async function listFinalCuts(project: FolderProject): Promise<FinalCut[] | null> {
  const path = actualFolderPaths(project).finalVideo;
  type Entry = { ".tag": string; name: string; path_display?: string; server_modified?: string; size?: number };
  type Page = { entries: Entry[]; has_more?: boolean; cursor?: string };
  try {
    // Recursive + paginated, like the evidence counter — an editor's subfolder
    // or a >1-page folder must not hide a cut.
    let res = await dbx<Page>("files/list_folder", { path, recursive: true });
    const all = [...(res.entries ?? [])];
    let guard = 0;
    while (res.has_more && res.cursor && guard++ < 50) {
      res = await dbx<Page>("files/list_folder/continue", { cursor: res.cursor });
      all.push(...(res.entries ?? []));
    }
    return all
      .filter((e) => e[".tag"] === "file" && VIDEO_RE.test(e.name) && !!e.path_display)
      .map((e) => ({
        path: e.path_display!,
        name: e.name,
        serverModified: e.server_modified ? new Date(e.server_modified) : new Date(0),
        size: e.size ?? 0,
      }))
      .sort((a, b) => a.serverModified.getTime() - b.serverModified.getTime());
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return [];
    return null;
  }
}

export type CreatedCut = { id: string; assetPath: string; fileName: string; round: number; isRedo: boolean };

/**
 * Bring the Review Room up to date with the Final folder.
 *  - a file with no submission yet → a new PENDING round-1 row;
 *  - a file whose latest round is CHANGES_REQUESTED and that was overwritten
 *    AFTER the verdict → a new round (same path, round+1);
 *  - everything else → left alone (pending/approved rows already point at it).
 *  - a legacy blank placeholder ("Auto — Final folder", no path) is FILLED IN
 *    with the first new file instead of being duplicated or deleted.
 * `onlyNewest` (the editor's button) creates at most one row — the newest
 * eligible file — and reports whether it is a redo.
 */
export async function syncFinalCutsToReview(
  projectId: string,
  opts: {
    /** sweep = the hourly discovery (never touches PENDING rows, redo needs a
     *  newer file); button = the editor's explicit submit (claims an unclaimed
     *  sweep row first, and a CHANGES_REQUESTED cut is always resubmittable). */
    mode?: "sweep" | "button";
    submittedByKey?: string | null;
    submittedByName: string;
    note?: string | null;
    onlyNewest?: boolean;
  },
): Promise<{ created: CreatedCut[]; claimed: CreatedCut | null; folderVideoCount: number; nothingNew: boolean; unreadable: boolean }> {
  const mode = opts.mode ?? "sweep";
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, status: true, deliveredAt: true,
      client: { select: { name: true } },
      reviewSubmissions: {
        select: { id: true, assetPath: true, fileName: true, round: true, status: true, decidedAt: true, createdAt: true, submittedByName: true, submittedByKey: true },
        orderBy: { round: "asc" },
      },
    },
  });
  const none = { created: [] as CreatedCut[], claimed: null, folderVideoCount: 0, nothingNew: true, unreadable: false };
  if (!project) return none;

  // The editor's button: rows the sweep already discovered are THEIRS to
  // claim — otherwise the button would answer "already in review" and the
  // close/transition logic behind it would never run (audit cross-check).
  if (mode === "button") {
    // ONE row per press, so each press runs its own close/transition logic in
    // submitCutForReview (claiming everything at once left a sweep-minted
    // redo stamped but never "submitted", and the revision task could only
    // be cleared by hand — review). A redo (round > 1) goes first: it is the
    // row that answers an open revision and moves REVISION → REVIEW.
    const unclaimed = project.reviewSubmissions
      .filter((s) => s.assetPath && s.status === "PENDING" && !s.submittedByKey)
      .sort((a, b) => (b.round - a.round) || (b.createdAt.getTime() - a.createdAt.getTime()));
    if (unclaimed.length > 0) {
      const note = (opts.note ?? "").trim().slice(0, 1000) || null;
      const pick = unclaimed[0];
      await prisma.reviewSubmission.update({
        where: { id: pick.id },
        data: { submittedByKey: opts.submittedByKey ?? null, submittedByName: opts.submittedByName, ...(note ? { note } : {}) },
      });
      const claimed: CreatedCut = { id: pick.id, assetPath: pick.assetPath!, fileName: pick.fileName ?? "", round: pick.round, isRedo: pick.round > 1 };
      return { created: [], claimed, folderVideoCount: project.reviewSubmissions.filter((s) => s.assetPath).length, nothingNew: false, unreadable: false };
    }
  }

  const cuts = await listFinalCuts(project);
  if (cuts === null) return { ...none, nothingNew: false, unreadable: true };

  // Latest round per path.
  const latestByPath = new Map<string, (typeof project.reviewSubmissions)[number]>();
  for (const s of project.reviewSubmissions) {
    if (!s.assetPath) continue;
    const cur = latestByPath.get(s.assetPath);
    if (!cur || s.round > cur.round) latestByPath.set(s.assetPath, s);
  }

  // The one blank placeholder the old sweep left behind (if any) becomes the
  // first real row — nothing is deleted, the id (and any notes keyed on it)
  // survive.
  let placeholder = project.reviewSubmissions.find(
    (s) => !s.assetPath && s.status === "PENDING" && s.submittedByName === AUTO_NAME,
  ) ?? null;

  // A DELIVERED job's cuts are already with the client — nothing new enters
  // review. The only thing to do is give a legacy blank placeholder its file
  // and record what delivery already meant: approved.
  if (project.status === "DELIVERED") {
    if (placeholder && cuts.length > 0) {
      const c = cuts[cuts.length - 1];
      await prisma.reviewSubmission.update({
        where: { id: placeholder.id },
        data: {
          assetPath: c.path, fileName: c.name, assetUrl: streamUrlFor(placeholder.id), round: 1,
          status: "APPROVED", decidedAt: project.deliveredAt ?? new Date(), decidedBy: "Delivered to the client",
        },
      }).catch(() => {});
    }
    return { ...none, folderVideoCount: cuts.length };
  }

  let eligible = cuts.filter((c) => {
    const latest = latestByPath.get(c.path);
    if (!latest) return true;
    if (latest.status !== "CHANGES_REQUESTED") return false;
    // Button: an explicit resubmit of a bounced cut is a new round, full stop
    // (the editor often re-exports in place BEFORE the owner clicks "request
    // changes"). Sweep: only a file overwritten AFTER the verdict is a redo.
    if (mode === "button") return true;
    const since = latest.decidedAt ?? latest.createdAt;
    return c.serverModified.getTime() > since.getTime();
  });
  if (opts.onlyNewest && eligible.length > 1) eligible = [eligible[eligible.length - 1]];
  if (eligible.length === 0) return { ...none, folderVideoCount: cuts.length };

  const created: CreatedCut[] = [];
  for (const c of eligible) {
    const latest = latestByPath.get(c.path);
    const round = latest ? latest.round + 1 : 1;
    const note = (opts.note ?? "").trim().slice(0, 1000) || null;
    let id: string;
    if (placeholder && !latest) {
      await prisma.reviewSubmission.update({
        where: { id: placeholder.id },
        data: {
          assetPath: c.path,
          fileName: c.name,
          assetUrl: streamUrlFor(placeholder.id),
          round: 1,
          ...(opts.submittedByKey ? { submittedByKey: opts.submittedByKey } : {}),
          submittedByName: opts.submittedByName,
          ...(note ? { note } : {}),
        },
      });
      id = placeholder.id;
      placeholder = null;
    } else {
      let row: { id: string } | null = null;
      try {
        row = await prisma.reviewSubmission.create({
          data: {
            projectId,
            kind: "video",
            assetPath: c.path,
            fileName: c.name,
            round,
            status: "PENDING",
            submittedByKey: opts.submittedByKey ?? null,
            submittedByName: opts.submittedByName,
            note,
          },
          select: { id: true },
        });
      } catch (e) {
        // (projectId, assetPath, round) is unique — a concurrent sweep/button
        // already made this row. Not an error; just don't double it.
        if ((e as { code?: string })?.code === "P2002") continue;
        throw e;
      }
      await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
      id = row.id;
    }
    created.push({ id, assetPath: c.path, fileName: c.name, round, isRedo: !!latest });
  }
  return { created, claimed: null, folderVideoCount: cuts.length, nothingNew: created.length === 0, unreadable: false };
}

/** Distinct files that have been submitted (any round/status) — what closes
 *  a multi-video edit task. */
export async function submittedDistinctCuts(projectId: string): Promise<number> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, assetPath: { not: null } },
    select: { assetPath: true },
  });
  return new Set(rows.map((r) => r.assetPath!)).size;
}

/**
 * The hourly discovery, called from the status sweep for every job in
 * production (SHOT/EDITING/REVIEW/REVISION) whose Final folder holds video.
 * REVISION is deliberately included: it is where a multi-video monthly job
 * spends most of its life, and the editor-handoff path skips it.
 */
export async function discoverCutsForReview(projectId: string, title: string | null): Promise<number> {
  const r = await syncFinalCutsToReview(projectId, {
    mode: "sweep",
    submittedByName: AUTO_NAME,
    note: "Cut detected in the Dropbox Final folder — auto-entered for review.",
  });
  if (r.created.length === 0) return 0;
  const street = (title || "job").split(",")[0].trim();
  const { notifyInApp } = await import("@/lib/notify");
  const { createHash } = await import("crypto");
  for (const row of r.created) {
    // Per-file key: the second video of a batch must ring too.
    const fileKey = createHash("sha1").update(row.assetPath).digest("hex").slice(0, 10);
    await notifyInApp({
      kind: "cut_ready",
      title: `Cut ready to review — ${street} · ${row.fileName}`,
      href: `/review/${projectId}?cut=${row.id}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `autocut-${projectId}-${fileKey}-r${row.round}`,
    }).catch(() => {});
  }
  return r.created.length;
}

/** Distinct files that have an APPROVED round — "videos done" for a batch. */
export async function approvedDistinctCuts(projectId: string): Promise<number> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, status: "APPROVED", assetPath: { not: null } },
    select: { assetPath: true },
  });
  return new Set(rows.map((r) => r.assetPath!)).size;
}
