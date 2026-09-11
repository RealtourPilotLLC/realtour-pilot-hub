import "server-only";
import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dbx, DropboxError } from "@/lib/integrations/dropbox";
import { actualFolderPaths, type FolderProject } from "@/lib/dropboxFolders";
import { videoStyleFor } from "@/lib/videoStyles";
import { editorMeta, VIDEO_LANE_KEYS } from "@/lib/editors";

/** Stamped on a cut row that was auto-approved BECAUSE the job was delivered —
 *  not because anyone reviewed it. The client portal keys off this to keep
 *  delivered work in the Library instead of asking for a verdict on it. */
export const DELIVERED_STAMP = "Delivered to the client";

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

/**
 * A cut has landed in the Room waiting on a verdict: ring the office, and —
 * through the bell row it makes — text the owner (Jordan, Sep 11: "make sure
 * I get a text when a video is in review"). ONE announcer for the three ways
 * in (the portal upload, the Final-folder submit, the hourly discovery), so
 * the text reads the same whichever door the cut came through, and ONE
 * dedupe key per SUBMISSION rather than per door: a row the sweep discovered
 * and the editor's button later claimed used to ring twice under two keys,
 * and now it can't; a new version is a new submission id and rings again.
 * The owner's line is the exact sentence his phone gets (notify.ts prefixes
 * it): "Video in review — 1033 Preserve Ln (Kim, v2). <link to the cut>".
 * `ownerActed` = the owner put the cut there himself (a vendor's file from
 * his own login): the office still gets the bell, his phone stays quiet —
 * he knows (reviewer, Sep 11). Best-effort like every bell: never throws.
 */
export async function announceCutInReview(input: {
  kind: "cut_ready" | "review_submitted";
  projectId: string;
  submissionId: string;
  round: number;
  street: string;
  fileName?: string | null;
  editorKey?: string | null;
  editorName?: string | null;
  ownerActed?: boolean;
}): Promise<void> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const { appBase } = await import("@/lib/appUrl");
    const href = `/review/${input.projectId}?cut=${input.submissionId}`;
    // The editor by roster name when the key resolves ("Kim"), else whoever
    // handed it in — the owner or Kyle uploading on an editor's behalf.
    const editor = editorMeta(input.editorKey)?.name ?? input.editorName ?? "editor";
    await notifyInApp({
      kind: input.kind,
      title: `${input.round > 1 ? `Version ${input.round}` : "Cut"} ready to review — ${input.street}${input.fileName ? ` · ${input.fileName}` : ""}`,
      body: input.fileName ?? undefined,
      href,
      targets: [{
        roles: ["OWNER", "ADMIN"],
        // No sentence = no text (notify.ts): the owner's own upload is bell-only.
        ...(input.ownerActed
          ? {}
          : { ownerSms: `Video in review — ${input.street} (${editor}, v${input.round}). ${appBase()}${href}` }),
      }],
      dedupeKey: `cut-in-review-${input.submissionId}`,
    });
  } catch { /* bell is best-effort */ }
}

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
        select: { id: true, assetPath: true, finalPath: true, fileName: true, round: true, status: true, decidedAt: true, createdAt: true, submittedByName: true, submittedByKey: true },
        orderBy: { round: "asc" },
      },
    },
  });
  const none = { created: [] as CreatedCut[], claimed: null, folderVideoCount: 0, nothingNew: true, unreadable: false };
  if (!project) return none;
  // Files the hub itself put in the Final folder (approved uploads) are not
  // new cuts — the button and the sweep must skip them (review).
  const hubCopies = new Set(project.reviewSubmissions.map((s) => s.finalPath).filter((x): x is string => !!x));

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

  const listed = await listFinalCuts(project);
  if (listed === null) return { ...none, nothingNew: false, unreadable: true };
  const cuts = listed.filter((c) => !hubCopies.has(c.path));

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
          status: "APPROVED", decidedAt: project.deliveredAt ?? new Date(), decidedBy: DELIVERED_STAMP,
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
    where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] }, OR: [{ assetPath: { not: null } }, { blobUrl: { not: null } }] },
    select: { id: true, deliverableId: true, slot: true, assetPath: true },
  });
  return new Set(rows.map(cutKeyOf)).size;
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
  for (const row of r.created) {
    // One row per (file, round) already — the submission id IS the per-file
    // key, so the second video of a batch rings too, and the editor's later
    // claim of this same row can't ring it again (announceCutInReview).
    await announceCutInReview({
      kind: "cut_ready",
      projectId,
      submissionId: row.id,
      round: row.round,
      street,
      fileName: row.fileName,
      editorName: "Final folder",
    });
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

// ===========================================================================
// INTERNAL UPLOAD FLOW (Jordan, Sep 1 2026): "when the editor is done with an
// edit and it's ready to review, it gets uploaded through the editor portal as
// Version 1, it gets sent to the review room, the revisions get added in the
// review room, and it gets sent back with the revisions marked — or if it's
// approved, it automatically gets uploaded to Dropbox and marked complete for
// that cut. Some jobs have multiple deliverables so it has to work for each."
//
// A CUT is (deliverable × slot): "Premium Reel", or "Video 2 of 4" on a
// monthly plan. Rounds are versions of that cut. Bytes go straight from the
// editor's browser to the hub's own store (Vercel Blob — Dropbox temporary
// links refuse to play in a browser); approval copies the file into the
// job's 05-Final-Video folder via Dropbox's save_url and stamps completedAt.
// ===========================================================================

export type CutSlot = {
  deliverableId: string;
  /** The Style Guide name of the cut — "Standard Reel with Agent Intro",
   *  "Personal Branding Reel" — from videoStyleFor(), never the raw
   *  Deliverable.label (which is the generic category the sync kept). */
  deliverableLabel: string;
  slot: number;
  count: number;
  /** "Standard Reel with Agent Intro" or "Personal Branding Reel — Video 2 of 4" */
  label: string;
};

/** Identity of a cut across rounds — uploaded rows by (deliverable, slot),
 *  legacy folder rows by file path. */
export function cutKeyOf(s: { deliverableId?: string | null; slot?: number | null; assetPath?: string | null; id: string }): string {
  return s.deliverableId ? `${s.deliverableId}:${s.slot ?? 1}` : (s.assetPath ?? s.id);
}

/** Every video cut this job owes, in order. Monthly plans put the whole batch
 *  on their one video row (quantity / videosFilmed / plan quota).
 *  Each cut is NAMED by its resolved style (Deliverable.videoStyle →
 *  productTitle → label heuristics), with the same tier/monthly verdicts the
 *  tracker's "Edit type" uses — so "Send to Review", the Review Room
 *  switcher, the approved file name and the brief all say one thing. Jordan
 *  (Sep 2): a Standard Reel with Agent Intro cut must not read "Social Reel". */
export async function cutSlots(projectId: string): Promise<CutSlot[]> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      packageName: true, videosFilmed: true,
      deliverables: {
        where: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, label: true, quantity: true, videoStyle: true, productTitle: true },
      },
    },
  });
  if (!p || p.deliverables.length === 0) return [];
  const { isMonthlyContentJob, monthlyVideoQuota } = await import("@/lib/pipeline");
  const { videoTier } = await import("@/lib/projectStatus");
  const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
  const tier = videoTier(p.deliverables);
  const out: CutSlot[] = [];
  for (const [i, d] of p.deliverables.entries()) {
    let count = Math.max(1, d.quantity ?? 1);
    if (monthly && i === 0) {
      const owed = Math.max(count, p.videosFilmed ?? monthlyVideoQuota([p.packageName, ...p.deliverables.map((x) => x.label)]));
      count = owed;
    }
    const base = videoStyleFor(d, { monthly, tier }).name;
    for (let slot = 1; slot <= count; slot++) {
      out.push({
        deliverableId: d.id,
        deliverableLabel: base,
        slot,
        count,
        label: count > 1 ? `${base} — Video ${slot} of ${count}` : base,
      });
    }
  }
  return out;
}

const SAFE_NAME = (name: string) => name.replace(/[^\w.\- ()]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "cut.mp4";
export const uploadPathnameFor = (projectId: string, submissionId: string, fileName: string) =>
  `review-cuts/${projectId}/${submissionId}/${SAFE_NAME(fileName)}`;

/** The upload landed in the store → the cut is in review. Idempotent (the
 *  client calls it, and Vercel's upload-completed callback may call it too). */
export async function finalizeCutUpload(
  submissionId: string,
  blob: { url: string; pathname: string; size?: number | null },
): Promise<{ ok: boolean; message: string }> {
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    include: { project: { select: { id: true, title: true, status: true, deliveredAt: true } } },
  });
  if (!sub) return { ok: false, message: "That upload no longer exists." };
  if (sub.blobUrl) return { ok: true, message: "Already in review." };
  if (!blob.pathname.startsWith(`review-cuts/${sub.projectId}/${sub.id}/`)) {
    return { ok: false, message: "That file doesn't belong to this cut." };
  }
  // Only an UPLOADING row becomes a cut — a late store callback must not
  // resurrect an abandoned/failed row (its bytes get released instead).
  if (sub.status !== "UPLOADING") {
    if (sub.status === "UPLOAD_FAILED") {
      try { const { del } = await import("@vercel/blob"); await del(blob.url); } catch { /* the retention sweep catches strays */ }
    }
    return { ok: false, message: "That upload was cancelled — start it again from the editor portal." };
  }
  // ATOMIC: the browser's finish() and the store's completion callback can
  // both arrive; exactly one of them flips the row, and only that one runs
  // the side effects below.
  const won = await prisma.reviewSubmission.updateMany({
    where: { id: sub.id, status: "UPLOADING" },
    data: {
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      ...(blob.size ? { sizeBytes: blob.size } : {}),
      status: "PENDING",
      assetUrl: streamUrlFor(sub.id),
      assetPath: null,
    },
  });
  if (won.count === 0) return { ok: true, message: "Already in review." };
  // An earlier round of this cut still waiting for a verdict is superseded by
  // this one — it must not keep counting as "in review" (dashboard, content
  // program, queue). SUPERSEDED is excluded by every PENDING-keyed count.
  if (sub.deliverableId) {
    await prisma.reviewSubmission.updateMany({
      where: { projectId: sub.projectId, deliverableId: sub.deliverableId, slot: sub.slot, status: "PENDING", round: { lt: sub.round } },
      data: { status: "SUPERSEDED" },
    }).catch(() => {});
  }
  const street = (sub.project.title || "job").split(",")[0].trim();
  // Sep 8 (one card per cut): a Review Room bounce is a ROUND on the edit
  // card now, not a cut-changes-* task, and this upload answers it through the
  // reconciler's evidence close / the approval. Any straggler row from the old
  // rail closes here so it can't outlive the cut it was about.
  await closeStragglerCutTasks(sub.projectId);
  // The job is in review. A client's revision the editor is answering moves
  // to "waiting on review"; a never-delivered job returns to REVIEW once no
  // ask stays OPEN in another lane (a photo-lane ask keeps it); a delivered
  // job keeps REVISION until the approval — see correctedCutSubmitted.
  const st = sub.project.status;
  if (st === "EDITING" || st === "SHOT") {
    await prisma.project.update({ where: { id: sub.projectId }, data: { status: "REVIEW" } });
  } else {
    await correctedCutSubmitted(sub.projectId, { round: sub.round });
  }
  // The editor's work item answers the way the Final-folder submit always
  // has (submitCutForReview's closeEdit): COMPLETED on a one-video job or once
  // every owed cut has been through review, scoped to the uploading editor's
  // own key; on a batch that still owes cuts a stale "Round N — fix them"
  // summary is rewritten instead. Sep 8 review: a portal re-upload left the
  // round on the card until the reconciler's evidence close, up to an hour
  // after the queue row already read Ready for review.
  try {
    const slots = await cutSlots(sub.projectId).catch(() => []);
    const owed = slots.length;
    const distinct = await submittedDistinctCuts(sub.projectId);
    const { editCardCutSubmitted } = await import("@/lib/tasks");
    await editCardCutSubmitted(sub.projectId, {
      round: sub.round,
      cutLabel: slots.find((s) => s.deliverableId === sub.deliverableId && s.slot === sub.slot)?.label ?? sub.fileName ?? null,
      close: owed <= 1 || distinct >= owed,
      editorKey: sub.submittedByKey,
    });
  } catch { /* best-effort — the cut is already in review */ }
  await prisma.activity.create({
    data: {
      projectId: sub.projectId, type: "SYSTEM",
      body: `Cut uploaded for review — ${sub.fileName ?? "video"} (version ${sub.round})${sub.submittedByName ? ` by ${sub.submittedByName}` : ""}.`,
    },
  }).catch(() => {});
  // A version the owner uploaded himself rings the bell but does not text
  // him (reviewer, Sep 11). The store's completion callback carries no
  // session, so the row's own name is the only witness: an owner/admin row
  // (no editor key) whose name is one of the owner's (smsPrefs.ownerActedBy).
  const { ownerActedBy } = await import("@/lib/smsPrefs");
  const ownerActed = !sub.submittedByKey && (await ownerActedBy(sub.submittedByName));
  await announceCutInReview({
    kind: "cut_ready",
    projectId: sub.projectId,
    submissionId: sub.id,
    round: sub.round,
    street,
    fileName: sub.fileName,
    editorKey: sub.submittedByKey,
    editorName: sub.submittedByName,
    ownerActed,
  });
  return { ok: true, message: `Version ${sub.round} is in the Review Room.` };
}

/** Approved → copy the file into the job's Final folder. Dropbox pulls it
 *  from the store (save_url) so no bytes pass through a function; the
 *  in-flight job id is kept so the hourly sweep can finish it. */
export async function startDropboxCopy(submissionId: string, opts: { inline?: boolean } = {}): Promise<{ complete: boolean; finalPath: string | null }> {
  const inline = opts.inline !== false;
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    include: {
      deliverable: { select: { label: true, type: true, quantity: true, videoStyle: true, productTitle: true } },
      project: { select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } } },
    },
  });
  if (!sub?.blobUrl || !sub.project) return { complete: false, finalPath: null };
  if (sub.completedAt) return { complete: true, finalPath: sub.finalPath };
  // Bounded: after three failed copies in a day, stop and ring the owner once
  // instead of an Activity row every hour forever (review).
  const failures = await prisma.activity.count({
    where: { projectId: sub.projectId, type: "SYSTEM", body: { startsWith: "Dropbox could not copy the approved cut" }, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
  });
  if (failures >= 3) {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "system",
        title: `Dropbox copy keeps failing — ${(sub.project.title || "job").split(",")[0].trim()}`,
        href: `/review/${sub.projectId}?cut=${sub.id}`,
        targets: [{ roles: ["OWNER", "ADMIN"] }],
        dedupeKey: `cut-copy-failing-${sub.id}`,
      });
    } catch { /* bell is best-effort */ }
    return { complete: false, finalPath: sub.finalPath };
  }
  // The previous approved round of this cut, if it was already copied, moves
  // aside so the Final folder holds ONE file per cut (review: a bounced v1
  // stayed beside the approved v2).
  const prior = (await prisma.reviewSubmission.findMany({
    where: { projectId: sub.projectId, deliverableId: sub.deliverableId, slot: sub.slot, id: { not: sub.id }, finalPath: { not: null } },
    select: { id: true, finalPath: true },
  })).filter((p) => !p.finalPath!.includes("/superseded/")); // already aside — never nest superseded/superseded
  for (const p of prior) {
    const folder = p.finalPath!.slice(0, p.finalPath!.lastIndexOf("/"));
    const name = p.finalPath!.split("/").pop()!;
    await dbx("files/create_folder_v2", { path: `${folder}/superseded`, autorename: false }).catch(() => {});
    await dbx("files/move_v2", { from_path: p.finalPath, to_path: `${folder}/superseded/${name}`, autorename: true }).catch(() => {});
    await prisma.reviewSubmission.update({ where: { id: p.id }, data: { finalPath: `${folder}/superseded/${name}`, completedAt: null } }).catch(() => {});
  }
  const ext = (sub.fileName ?? "").match(/\.(mp4|mov|m4v|webm|mkv)$/i)?.[0] ?? ".mp4";
  // The slot label (style name + "Video N of M") names the file; the bare
  // style name is the fallback if the row is no longer on the order.
  const base = sub.deliverable ? videoStyleFor(sub.deliverable).name : "Video";
  const slots = await cutSlots(sub.projectId).catch(() => [] as CutSlot[]);
  const mine = slots.find((s) => s.deliverableId === sub.deliverableId && s.slot === sub.slot);
  // Plain hyphens: the em dash in the slot label is not a safe filename char.
  const name = SAFE_NAME(`${(mine?.label ?? base).replace(/\s+—\s+/g, " - ")} - v${sub.round}${ext}`);
  const folder = actualFolderPaths(sub.project).finalVideo;
  const path = `${folder}/${name}`;
  await dbx("files/create_folder_v2", { path: folder, autorename: false }).catch(() => {});
  type SaveUrl = { ".tag": "complete" | "async_job_id"; async_job_id?: string };
  let r: SaveUrl;
  try {
    r = await dbx<SaveUrl>("files/save_url", { path, url: sub.blobUrl });
  } catch (e) {
    // The file is already there (an earlier attempt landed after we lost
    // track of it) → that IS the copy.
    if (e instanceof DropboxError && /conflict/i.test(e.message)) {
      const meta = await dbx<{ size?: number }>("files/get_metadata", { path }).catch(() => null);
      if (meta) {
        await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { finalPath: path, completedAt: new Date(), dropboxJobId: null } });
        return { complete: true, finalPath: path };
      }
    }
    throw e;
  }
  if (r[".tag"] === "complete") {
    await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { finalPath: path, completedAt: new Date(), dropboxJobId: null } });
    return { complete: true, finalPath: path };
  }
  await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { finalPath: path, dropboxJobId: r.async_job_id ?? null } });
  if (!inline) return { complete: false, finalPath: path };
  // Give it a short inline chance (most files land within seconds).
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 2500));
    const done = await checkDropboxCopy(sub.id);
    if (done !== "pending") return { complete: done === "complete", finalPath: path };
  }
  return { complete: false, finalPath: path };
}

/** Poll one in-flight copy. */
export async function checkDropboxCopy(submissionId: string): Promise<"complete" | "pending" | "failed"> {
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { dropboxJobId: true, finalPath: true, projectId: true, fileName: true } });
  if (!sub?.dropboxJobId) return sub?.finalPath ? "complete" : "failed";
  type Status = { ".tag": "in_progress" | "complete" | "failed"; failed?: { ".tag"?: string } };
  let st: Status;
  try {
    st = await dbx<Status>("files/save_url/check_job_status", { async_job_id: sub.dropboxJobId });
  } catch {
    return "pending";
  }
  if (st[".tag"] === "in_progress") return "pending";
  if (st[".tag"] === "complete") {
    await prisma.reviewSubmission.update({ where: { id: submissionId }, data: { completedAt: new Date(), dropboxJobId: null } });
    await prisma.activity.create({
      data: { projectId: sub.projectId, type: "SYSTEM", body: `Approved cut copied to Dropbox — ${sub.finalPath?.split("/").pop() ?? sub.fileName ?? "video"}.` },
    }).catch(() => {});
    return "complete";
  }
  await prisma.reviewSubmission.update({ where: { id: submissionId }, data: { dropboxJobId: null } });
  await prisma.activity.create({
    data: { projectId: sub.projectId, type: "SYSTEM", body: `Dropbox could not copy the approved cut (${st.failed?.[".tag"] ?? "unknown"}) — it will be retried on the next hourly pass.` },
  }).catch(() => {});
  return "failed";
}

/** Hourly: finish in-flight copies, retry failed ones, retire abandoned uploads. */
export async function finalizeApprovedCuts(): Promise<{ checked: number; completed: number; retried: number; abandoned: number }> {
  let completed = 0, retried = 0;
  const inFlight = await prisma.reviewSubmission.findMany({
    where: { dropboxJobId: { not: null }, completedAt: null },
    select: { id: true },
    take: 50,
  });
  for (const s of inFlight) if ((await checkDropboxCopy(s.id)) === "complete") completed++;
  // Approved uploads that never got a copy started (a failed save_url, or an
  // approval made before this flow existed).
  const stranded = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", blobUrl: { not: null }, completedAt: null, dropboxJobId: null },
    select: { id: true },
    take: 20,
  });
  for (const s of stranded) {
    try {
      const r = await startDropboxCopy(s.id, { inline: false });
      retried++;
      if (r.complete) completed++;
    } catch { /* next hour */ }
  }
  // An upload that never finished (closed tab, dead connection) is not a cut.
  const abandoned = await prisma.reviewSubmission.updateMany({
    where: { status: "UPLOADING", createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
    data: { status: "UPLOAD_FAILED" },
  });
  return { checked: inFlight.length, completed, retried, abandoned: abandoned.count };
}

/** Distinct cuts (deliverable×slot, or file) with an APPROVED round. */
export async function approvedCutCount(projectId: string): Promise<number> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, status: "APPROVED" },
    select: { id: true, deliverableId: true, slot: true, assetPath: true },
  });
  return new Set(rows.map(cutKeyOf)).size;
}


/** Retention: an approved cut's upload is kept in the hub store for a while
 *  (the client portal shows this and last month's cuts), then released. The
 *  row keeps pointing at the Dropbox copy so the room can still stream it. */
export async function pruneReviewUploads(keepDays: number): Promise<{ pruned: number; failed: number }> {
  const cutoff = new Date(Date.now() - keepDays * 24 * 3600_000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  const { del } = await import("@vercel/blob");
  let pruned = 0, failed = 0;
  // Release the row FIRST, then the bytes: a deleted blob behind a live
  // blobUrl would leave the stream route redirecting to a 404 (review).
  const release = async (id: string, blobUrl: string, assetPath: string | null) => {
    let cleared = false;
    try {
      await prisma.reviewSubmission.update({ where: { id }, data: { blobUrl: null, blobPathname: null, ...(assetPath ? { assetPath } : {}) } });
      cleared = true;
    } catch {
      // (projectId, assetPath, round) collision with a legacy row → keep the
      // row pointing nowhere rather than at a path that belongs to another row.
      try {
        await prisma.reviewSubmission.update({ where: { id }, data: { blobUrl: null, blobPathname: null } });
        cleared = true;
      } catch { /* leave it for next time */ }
    }
    // Bytes go only once the row no longer points at them — a live blobUrl
    // behind a deleted blob would 302 every viewer to a 404 (review).
    if (!cleared) { failed++; return; }
    try { await del(blobUrl); pruned++; } catch { failed++; }
  };
  // 1. Approved and copied — after the retention window, the Dropbox copy is
  //    the file of record and the room streams it from there.
  const approved = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null }, completedAt: { lt: cutoff }, finalPath: { not: null } },
    select: { id: true, blobUrl: true, finalPath: true },
    take: 50,
  });
  for (const r of approved) await release(r.id, r.blobUrl!, r.finalPath);
  // 2. Failed uploads whose bytes landed have no reason to stay at a public URL.
  const dead = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null }, status: "UPLOAD_FAILED", updatedAt: { lt: weekAgo } },
    select: { id: true, blobUrl: true },
    take: 50,
  });
  for (const r of dead) await release(r.id, r.blobUrl!, null);
  // 3. Superseded versions — a NEWER round of the same cut exists and this one
  //    is a week old. A bounced cut with no newer round stays: the editor is
  //    still working from it and a client who bounced it still sees it in the
  //    portal (review).
  const older = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null }, deliverableId: { not: null }, status: { in: ["PENDING", "SUPERSEDED", "CHANGES_REQUESTED"] }, updatedAt: { lt: weekAgo } },
    select: { id: true, blobUrl: true, projectId: true, deliverableId: true, slot: true, round: true },
    take: 50,
  });
  for (const r of older) {
    const newer = await prisma.reviewSubmission.count({
      where: { projectId: r.projectId, deliverableId: r.deliverableId, slot: r.slot, round: { gt: r.round }, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } },
    });
    if (newer > 0) await release(r.id, r.blobUrl!, null);
  }
  return { pruned, failed };
}
// ===========================================================================
// THE REVISION LIFECYCLE ON THE VIDEO LANE (Jordan, Sep 8: "A revision should
// be changed to ready for review when an editor marks it complete and submits
// it for review.")
//
// Before: the editor's "Completed" click set the job DELIVERED, left the
// client's revision task OPEN + URGENT, rang the editor "Delivered ✓", and
// the next per-project recompute flipped the job back to REVISION (332 Ruth
// Ridge, 1956 Wetherhill — rev-open-after-complete audit). Now:
//   · corrected cut submitted (portal upload, "Done — send to review", or the
//     queue's "Completed" with a new cut) → the video-lane revision task goes
//     IN_PROGRESS "Corrected cut submitted — waiting on review" (assignee
//     kept) and the cut sits in the Review Room;
//   · approved → the video-lane task closes whoever holds it; when no lane
//     is left open the job resolves the normal way (resolveRevision: stamp
//     cleared, a delivered job back to Delivered with the close-out + bells);
//   · sent back with notes → the task returns to OPEN, the job stays in
//     Revisions (review/actions.requestCutChanges).
//
// Project.status while the corrected cut waits: a NEVER-delivered job goes
// to REVIEW (stamp cleared — the IN_PROGRESS task is the memory). A DELIVERED
// job has to stay REVISION: the status engine (projectStatus.computeStatus)
// returns REVISION whenever revisionRequestedAt is newer than deliveredAt,
// and with the stamp cleared it would read the old media as "all live" and
// write DELIVERED before Jordan ruled — the exact lie this rule exists to
// stop. The queue row, the /edit tracker and the Review Room all read the
// PENDING cut itself, so all three say "Ready for review" either way.
//
// "Video lane" = every revision task except Kyle's photo-lane card (its own
// dedupe key, comms.raiseRevision): unassigned, held by a video editor, or
// titled as video work when Kyle relays it for an outside shop.
// ===========================================================================

export const WAITING_ON_REVIEW_SUMMARY = "Corrected cut submitted — waiting on review";

/** The state sentence a round trip puts in front of the client's ask line on
 *  the revision task. Only this prefix is replaced on the next hop — the ask
 *  itself ("Client asked for changes after delivery: “…”", raiseRevision)
 *  survives every submit and bounce (Sep 8 review: it used to be overwritten
 *  after one round trip and survive only in the description). */
const REVISION_STATE_PREFIX =
  /^(?:Corrected cut submitted — waiting on review\.?|The corrected cut came back from review with \d+ notes? — fix them \(they are on the edit card\) and upload the next version\.?)\s*/;
export function revisionStateSummary(existing: string | null | undefined, state: string): string {
  const ask = (existing ?? "").replace(REVISION_STATE_PREFIX, "").trim();
  const sentence = /[.!?]$/.test(state) ? state : `${state}.`;
  return (ask ? `${sentence} ${ask}` : sentence).slice(0, 500);
}

/** Does this cut answer the client's open ask? A re-version of a cut always
 *  does (round > 1 / a redo of a bounced file); on a job the client already
 *  has (deliveredAt) any cut made after the ask is the correction; on a
 *  one-video job any cut is THE cut. A fresh video 3 on a never-delivered
 *  monthly batch is NOT the correction to video 1 (Sep 8 review). */
async function cutAnswersAsk(projectId: string, opts: { round?: number | null; isRedo?: boolean; deliveredAt?: Date | null }): Promise<boolean> {
  if ((opts.round ?? 1) > 1 || opts.isRedo) return true;
  if (opts.deliveredAt) return true;
  const owed = (await cutSlots(projectId).catch(() => [])).length;
  return owed <= 1;
}

/** The photo-lane revision key — the one revision row a cut never answers
 *  (same scheme as comms.ts dedupeKey([project, "revision", "photo"])). */
export function photoLaneRevisionKey(projectId: string): string {
  return createHash("sha1").update(`${projectId}|revision|photo`).digest("hex").slice(0, 24);
}

/** Open revision tasks on the VIDEO lane of a job. */
export function videoLaneRevisionWhere(projectId: string): Prisma.SmartTaskWhereInput {
  return {
    projectId,
    taskType: "revision",
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    AND: [
      { OR: [{ dedupeKey: null }, { dedupeKey: { not: photoLaneRevisionKey(projectId) } }] },
      {
        OR: [
          { assignedKey: null },
          { assignedKey: { in: [...VIDEO_LANE_KEYS] } },
          { title: { startsWith: "Video revision" } },
          { title: { startsWith: "New cut" } },
        ],
      },
    ],
  };
}

/** Rows from the retired cut-changes-* / queue-revision-* rails (folded into
 *  the edit card on Sep 8). None should be open; any straggler closes with
 *  the next upload so it cannot outlive the cut it was about. */
export async function closeStragglerCutTasks(projectId: string): Promise<void> {
  await prisma.smartTask.updateMany({
    where: {
      projectId,
      taskType: "revision",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      OR: [{ dedupeKey: { startsWith: `cut-changes-${projectId}-` } }, { dedupeKey: `queue-revision-${projectId}` }],
    },
    data: { status: "COMPLETED", completedAt: new Date() },
  }).catch(() => {});
}

/** The editor handed in the corrected cut. Idempotent — safe to call from the
 *  portal upload, the Final-folder submit and the queue's "Completed" alike. */
export async function correctedCutSubmitted(
  projectId: string,
  opts: { round?: number; isRedo?: boolean } = {},
): Promise<{ moved: number; status: string | null }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, deliveredAt: true, revisionRequestedAt: true },
  });
  if (!project) return { moved: 0, status: null };
  const lane = await prisma.smartTask.findMany({ where: videoLaneRevisionWhere(projectId), select: { id: true, status: true, summary: true } });
  // A cut that is not the correction (a fresh video on a never-delivered
  // batch) leaves the ask — and the stage — exactly where they are. With no
  // lane task at all (a queue flip / Room bounce that only stamped the job)
  // the stage move below still runs, as it always did.
  if (lane.length > 0 && !(await cutAnswersAsk(projectId, { round: opts.round, isRedo: opts.isRedo, deliveredAt: project.deliveredAt }))) {
    return { moved: 0, status: project.status };
  }
  const toMove = lane.filter((t) => t.status !== "IN_PROGRESS");
  if (toMove.length > 0) {
    // Per row: the state sentence goes in FRONT of the client's ask line, it
    // does not replace it (revisionStateSummary).
    for (const t of toMove) {
      await prisma.smartTask.update({
        where: { id: t.id },
        data: { status: "IN_PROGRESS", summary: revisionStateSummary(t.summary, WAITING_ON_REVIEW_SUMMARY) },
      });
    }
    await prisma.activity.create({
      data: {
        projectId,
        type: "SYSTEM",
        body: `Corrected cut submitted for review${opts.round ? ` (version ${opts.round})` : ""} — the client's revision now waits on the verdict.`,
      },
    }).catch(() => {});
  }
  // Stage: a never-delivered job returns to REVIEW (and drops the stamp so the
  // hourly sweep can't flip it straight back) once nothing is left OPEN in
  // another lane. A delivered job keeps REVISION — see the section note.
  let status: string = project.status;
  if (!project.deliveredAt && (project.status === "REVISION" || project.status === "REVIEW")) {
    const otherOpen = await prisma.smartTask.count({
      where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED", "IN_PROGRESS"] } },
    });
    if (otherOpen === 0 && (project.status === "REVISION" || project.revisionRequestedAt)) {
      await prisma.project.update({ where: { id: projectId }, data: { status: "REVIEW", revisionRequestedAt: null } });
      status = "REVIEW";
    }
  }
  return { moved: toMove.length, status };
}

/** Jordan approved a cut. When it is newer than the client's ask it answers
 *  it: the video-lane task closes whoever holds it, and if no lane is left
 *  open the job resolves the normal way (resolveRevision — stamp cleared, a
 *  delivered job back to Delivered with the close-out and today's bells). */
export async function correctedCutApproved(
  projectId: string,
  opts: { cutCreatedAt: Date; round?: number | null; isRedo?: boolean },
): Promise<{ closed: number; resolved: boolean }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { revisionRequestedAt: true, deliveredAt: true },
  });
  if (!project) return { closed: 0, resolved: false };
  const lane = await prisma.smartTask.findMany({ where: videoLaneRevisionWhere(projectId), select: { id: true, createdAt: true } });
  if (lane.length === 0) return { closed: 0, resolved: false };
  // Only a cut newer than the ask answers it — approving an older pending cut
  // (video 2 of a batch, a legacy folder row) must not close a revision that
  // arrived after it was made. The stamp is refreshed on every raise; a task
  // without one (queue-added) dates from its own creation. And it has to be
  // the correction (a re-version, or any cut on a delivered / one-video job)
  // — a fresh video on a never-delivered batch is not (cutAnswersAsk).
  const raisedAt = project.revisionRequestedAt ?? new Date(Math.min(...lane.map((t) => t.createdAt.getTime())));
  if (opts.cutCreatedAt.getTime() < raisedAt.getTime()) return { closed: 0, resolved: false };
  if (!(await cutAnswersAsk(projectId, { round: opts.round, isRedo: opts.isRedo, deliveredAt: project.deliveredAt }))) return { closed: 0, resolved: false };
  const laneIds = lane.map((t) => t.id);
  const otherOpen = await prisma.smartTask.count({
    where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] }, id: { notIn: laneIds } },
  });
  if (otherOpen === 0) {
    // The last open lane: the whole resolve — closes the tasks, clears the
    // stamp and note, returns the job to where it genuinely stands, and
    // rings ops + the editor. Dynamic import: comms → tasks → (this file).
    const { resolveRevision } = await import("@/lib/comms");
    await resolveRevision(projectId);
    return { closed: lane.length, resolved: true };
  }
  await prisma.smartTask.updateMany({
    where: { id: { in: laneIds } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  await prisma.activity.create({
    data: {
      projectId,
      type: "SYSTEM",
      body: `Corrected cut approved — the video revision is closed; ${otherOpen} ask${otherOpen === 1 ? "" : "s"} still open in another lane.`,
    },
  }).catch(() => {});
  return { closed: lane.length, resolved: false };
}

// ===========================================================================
// VIDEO REVIEW STATE — one read for every surface that answers "where is
// this job's video?" (Ops Day, the Dashboard, the QC card). Jordan (Sep 1):
// "a card for videos in revision and videos waiting on review; the same on my
// dashboard; and in morning QC, the video status for shoots that have video."
// ===========================================================================

export type VideoCutState = {
  submissionId: string;
  projectId: string;
  street: string;
  clientName: string;
  clientAvatarUrl: string | null; // the agent's Aryeo headshot, beside the name on the home Video Review card
  /** "Premium Social Media Reel" / "Personal Branding Reel — Video 2 of 4" /
   *  the file name for legacy rows */
  cutLabel: string;
  round: number;
  status: "PENDING" | "CHANGES_REQUESTED" | "APPROVED";
  /** when this state began (uploaded / bounced / approved) */
  sinceISO: string;
  editorKey: string | null;
  submittedByName: string | null;
  /** open EDITOR-lane notes on the cut (what the editor still has to fix) */
  openNotes: number;
  projectStatus: string;
};

export type ProjectVideoState = {
  projectId: string;
  /** owed cuts on this job (0 = no video ordered) */
  owed: number;
  approved: number;
  waiting: number;   // cuts awaiting a verdict
  revising: number;  // cuts bounced back to the editor
  uploaded: number;  // distinct cuts with any round
  /** one-word stage for a status line. ready_to_edit (Sep 10): the editor
   *  has the card but nobody has said "In editing" yet — the raws-landed
   *  state, which used to read as editing on every surface. */
  stage: "none" | "not_started" | "ready_to_edit" | "editing" | "waiting_review" | "in_revisions" | "approved" | "delivered";
  /** short human line, e.g. "v2 waiting on review · 1 of 4 cuts done" */
  detail: string;
  cuts: VideoCutState[];
};

// The pure twin of cutSlots() for the batched reader below — same rows, same
// order, same NAMES (videoStyleFor with the job's tier + monthly verdicts), so
// a cut is called the same thing on Ops Day as in the Review Room.
const pureSlots = (
  p: { packageName: string | null; videosFilmed: number | null; deliverables: { id: string; type: string; label: string | null; quantity: number | null; videoStyle: string | null; productTitle: string | null }[] },
  monthly: boolean,
  quota: number,
  tier: "standard" | "premium" | null,
) => {
  const vids = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const out: CutSlot[] = [];
  for (const [i, d] of vids.entries()) {
    let count = Math.max(1, d.quantity ?? 1);
    if (monthly && i === 0) count = Math.max(count, p.videosFilmed ?? quota);
    const base = videoStyleFor(d, { monthly, tier }).name;
    for (let slot = 1; slot <= count; slot++) out.push({ deliverableId: d.id, deliverableLabel: base, slot, count, label: count > 1 ? `${base} — Video ${slot} of ${count}` : base });
  }
  return out;
};

// The roster's display name when the key is on it ("john" → "John",
// "external_agency" → "External agency"); an unknown lowercase key gets its
// underscores spaced and a capital; "tm:abc" stays as-is (a name lookup isn't
// worth a query here). The old rule only capitalised /^[a-z]+$/, so the vendor
// key printed raw on Kyle's morning QC card — "Video: In editing —
// external_agency" beside "In editing — John" (102 Knoxlyn, audit Sep 8 2026).
const prettyKey = (k: string) =>
  editorMeta(k)?.name ?? (/^[a-z_]+$/.test(k) ? k.replace(/_/g, " ").replace(/^[a-z]/, (c) => c.toUpperCase()) : k);

/** Batched: the video state of many projects in two queries. */
export async function videoStatesFor(projectIds: string[]): Promise<Map<string, ProjectVideoState>> {
  const out = new Map<string, ProjectVideoState>();
  if (projectIds.length === 0) return out;
  const { isMonthlyContentJob, monthlyVideoQuota } = await import("@/lib/pipeline");
  const { videoTier } = await import("@/lib/projectStatus");
  const [projects, subs, editTasks, notes] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: {
        id: true, title: true, status: true, packageName: true, videosFilmed: true, statusEvidence: true,
        client: { select: { name: true, avatarUrl: true } },
        // Same order as cutSlots() — the monthly batch count lands on the FIRST
        // video row, so both slot builders must see the rows the same way.
        deliverables: { where: { removedFromOrderAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, type: true, label: true, quantity: true, videoStyle: true, productTitle: true } },
      },
    }),
    prisma.reviewSubmission.findMany({
      where: { projectId: { in: projectIds }, status: { in: ["PENDING", "CHANGES_REQUESTED", "APPROVED"] } },
      orderBy: { round: "asc" },
      select: { id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, assetUrl: true, fileName: true, round: true, status: true, createdAt: true, decidedAt: true, submittedByKey: true, submittedByName: true },
    }),
    prisma.smartTask.findMany({
      where: { projectId: { in: projectIds }, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { projectId: true, assignedKey: true },
    }),
    prisma.mediaNote.groupBy({
      by: ["assetUrl"],
      where: { projectId: { in: projectIds }, parentId: null, lane: "EDITOR", status: "OPEN", NOT: { authorKey: { startsWith: "editor:" } } },
      _count: true,
    }),
  ]);
  const notesByAsset = new Map(notes.map((n) => [n.assetUrl, n._count]));
  const editByProject = new Map(editTasks.map((t) => [t.projectId, t.assignedKey]));
  const subsByProject = new Map<string, typeof subs>();
  for (const s of subs) {
    const arr = subsByProject.get(s.projectId) ?? [];
    arr.push(s);
    subsByProject.set(s.projectId, arr);
  }
  for (const p of projects) {
    const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
    const quota = monthlyVideoQuota([p.packageName, ...p.deliverables.map((d) => d.label)]);
    const slots = pureSlots(p, monthly, quota, videoTier(p.deliverables));
    const rows = subsByProject.get(p.id) ?? [];
    // latest round per cut
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const k = cutKeyOf(r);
      const cur = latest.get(k);
      if (!cur || r.round > cur.round) latest.set(k, r);
    }
    const street = (p.title || "Project").split(",")[0].trim();
    const cuts: VideoCutState[] = [...latest.values()].map((r) => {
      const slot = slots.find((s) => s.deliverableId === r.deliverableId && s.slot === r.slot);
      return {
        submissionId: r.id,
        projectId: p.id,
        street,
        clientName: p.client?.name ?? "",
        clientAvatarUrl: p.client?.avatarUrl ?? null,
        cutLabel: slot?.label ?? r.fileName ?? "Video",
        round: r.round,
        status: r.status as VideoCutState["status"],
        sinceISO: (r.status === "PENDING" ? r.createdAt : (r.decidedAt ?? r.createdAt)).toISOString(),
        editorKey: r.submittedByKey ?? editByProject.get(p.id) ?? null,
        submittedByName: r.submittedByName,
        openNotes: (r.assetUrl ? notesByAsset.get(r.assetUrl) : 0) ?? 0,
        projectStatus: p.status,
      };
    });
    const approved = cuts.filter((c) => c.status === "APPROVED").length;
    const waiting = cuts.filter((c) => c.status === "PENDING").length;
    const revising = cuts.filter((c) => c.status === "CHANGES_REQUESTED").length;
    const owed = slots.length;
    let videoLive = false;
    try { videoLive = ((JSON.parse(p.statusEvidence ?? "{}") as { present?: string[] }).present ?? []).includes("Video"); } catch { /* none */ }
    let stage: ProjectVideoState["stage"] = "none";
    if (owed > 0) {
      if (p.status === "DELIVERED" && videoLive) stage = "delivered";
      else if (revising > 0) stage = "in_revisions";
      else if (waiting > 0) stage = "waiting_review";
      // Most jobs never pass through the Review Room (folder discovery is off)
      // — a video already live on Aryeo is done, whatever the room knows
      // (review: 1244 West Chester Pike read "Not started" under "Live on
      // Aryeo: Video").
      else if (videoLive) stage = "delivered";
      else if (owed > 0 && approved >= owed) stage = "approved";
      // "In editing" only when a human said so (the editor's click on the
      // queue pill writes EDITING) or a cut has actually been uploaded. An
      // open edit card on its own is footage waiting for the editor — Kyle's
      // QC card read "Video: In editing — John Mark" for a job nobody had
      // opened (Jordan, Sep 10: "the video projects should not automatically
      // be in editing, it should say ready for editing").
      else if (p.status === "EDITING" || cuts.length > 0) stage = "editing";
      else if (editByProject.has(p.id)) stage = "ready_to_edit";
      else stage = "not_started";
    }
    const done = owed > 1 ? ` · ${approved} of ${owed} cuts done` : "";
    const ver = (c: VideoCutState) => (c.round > 1 ? `v${c.round} ` : "");
    const first = (st: VideoCutState["status"]) => cuts.find((c) => c.status === st);
    const detail =
      stage === "none" ? "" :
      stage === "delivered" ? (p.status === "DELIVERED" ? "Delivered" : "Live on Aryeo") :
      stage === "in_revisions" ? `${ver(first("CHANGES_REQUESTED")!)}in revisions${first("CHANGES_REQUESTED")!.openNotes ? ` (${first("CHANGES_REQUESTED")!.openNotes} note${first("CHANGES_REQUESTED")!.openNotes === 1 ? "" : "s"})` : ""}${done}` :
      stage === "waiting_review" ? `${ver(first("PENDING")!)}waiting on review${done}` :
      stage === "approved" ? `Approved${owed > 1 ? ` — all ${owed} cuts` : ""}` :
      stage === "editing" ? `In editing${editByProject.get(p.id) ? ` — ${prettyKey(editByProject.get(p.id) as string)}` : ""}${done}` :
      stage === "ready_to_edit" ? `Ready for editing${editByProject.get(p.id) ? ` — ${prettyKey(editByProject.get(p.id) as string)}` : ""}${done}` :
      "Not started — no cut uploaded yet";
    out.set(p.id, { projectId: p.id, owed, approved, waiting, revising, uploaded: cuts.length, stage, detail, cuts });
  }
  return out;
}

/** Every cut across the business that is waiting on a verdict or back with an editor. */
export async function videoReviewBoard(): Promise<{ waiting: VideoCutState[]; revising: VideoCutState[] }> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { status: { in: ["PENDING", "CHANGES_REQUESTED"] }, project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  const states = await videoStatesFor(rows.map((r) => r.projectId));
  const all = [...states.values()].flatMap((s) => s.cuts);
  const byAge = (a: VideoCutState, b: VideoCutState) => a.sinceISO.localeCompare(b.sinceISO);
  return {
    // A delivered job's still-pending cut is not the owner's work list.
    waiting: all.filter((c) => c.status === "PENDING" && c.projectStatus !== "DELIVERED").sort(byAge),
    revising: all.filter((c) => c.status === "CHANGES_REQUESTED").sort(byAge),
  };
}
