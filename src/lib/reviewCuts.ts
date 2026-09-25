import "server-only";
import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dbx, DropboxError } from "@/lib/integrations/dropbox";
import { actualFolderPaths, type FolderProject } from "@/lib/dropboxFolders";
import { videoStyleFor } from "@/lib/videoStyles";
import { editorMeta, VIDEO_LANE_KEYS } from "@/lib/editors";
import { effectiveSlotCounts } from "@/lib/editOverrides";

/** Stamped on a cut row that was auto-approved BECAUSE the job was delivered —
 *  not because anyone reviewed it. The client portal keys off this to keep
 *  delivered work in the Library instead of asking for a verdict on it. */
export const DELIVERED_STAMP = "Delivered to the client";

/** LEGACY (the afternoon of Sep 16 only). A take-back used to park the row
 *  here — status WITHDRAWN, row and file kept — until Jordan settled it the
 *  same evening: "When removing the cut, I want it to remove completely." A
 *  removal now DELETES the row (review/actions.removeCut), so nothing new ever
 *  carries this status. It stays because rows written that afternoon do: every
 *  surface must keep reading them without crashing, and "is this a cut?" must
 *  keep answering no. */
export const WITHDRAWN = "WITHDRAWN";

/** Rows that are not a cut anybody is waiting on: bytes still moving, bytes
 *  that never arrived, or one of those legacy withdrawn rows. */
export const NOT_A_CUT = ["UPLOADING", "UPLOAD_FAILED", WITHDRAWN] as const;

/** The key a cut's review notes hang on. MediaNote has no submission column —
 *  a cut note is keyed by the cut's own streaming URL, or the synthetic
 *  "cut:<id>" when Dropbox couldn't mint one (see review/actions.addCutNote,
 *  which writes exactly this, and replyCutNote, which copies it onto replies).
 *  Both forms carry the submission's OWN id, which is what makes a removal
 *  safe: one version's notes, never another round's. */
export function cutNoteKey(sub: { id: string; assetUrl?: string | null }): string {
  return sub.assetUrl ?? `cut:${sub.id}`;
}

/** Is this note key this submission's alone? Both shapes name the submission
 *  (`/api/review/cut/<id>/stream`, `cut:<id>`), so a key that does NOT is a
 *  row from some other era pointing at a shared file — and a delete keyed on
 *  it could take another round's notes with it. Anything unrecognised is left
 *  alone and reported (Jordan, Sep 16: remove the version, not the job). */
export function isOwnCutNoteKey(key: string, submissionId: string): boolean {
  return key === `cut:${submissionId}` || key === streamUrlFor(submissionId);
}

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

/** `contentHash` (Dropbox's content_hash) is what binds an editor's self-check
 *  to THESE bytes (§8.2): a re-export in place keeps the path and the name and
 *  changes the hash. null when Dropbox did not say. */
export type FinalCut = { path: string; name: string; serverModified: Date; size: number; contentHash?: string | null; rev?: string | null };

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
 * his own login): his phone and his DM stay quiet, he knows (reviewer,
 * Sep 11) — and ONLY his, which is the Sep 21 correction below.
 * Best-effort like every bell: never throws.
 *
 * THE CARVE-OUT USED TO SILENCE THE WHOLE OFFICE WITH HIM (Sep 21 2026).
 * Until today this emitter dropped the `ownerSms` sentence entirely when the
 * owner acted. But the sentence is what the broadcast leg is GUARDED on —
 * notifyInApp only calls bridgeBroadcast when a target carries one — so no
 * sentence meant no bridge at all, and Kyle got a bell row and nothing else on
 * a cut Jordan uploaded himself. That is precisely the silence the Ready-to-
 * send work exists to end ("Kyle gets Slacked when a video is ready for
 * review"). Measured on production the same day: 3 of the last 41
 * ReviewSubmission rows in 60 days carry no editor key and the name "Jordan
 * Spackman", which smsPrefs.ownerActedBy resolves true — one cut in fourteen
 * reaching nobody.
 * So the sentence always goes now, and the suppression moved to where it can
 * name a person: bridgeBroadcast skips the OWNER roster rows for this row and
 * reaches the office normally.
 *
 * `dedupeSuffix` (Sep 16, Jordan: "it would also be cool if they could
 * reassign that video to a different project") is the one thing allowed to
 * widen the key. A MOVED cut keeps its submission id, so the per-submission
 * key would swallow the announcement on the job it landed on — the reviewer
 * would never hear that a cut arrived. The move stamps its own timestamp into
 * the key so exactly one new announcement goes out per move, and a repeat
 * render of the same move still can't ring twice.
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
  dedupeSuffix?: string | null;
  /** §8.1: the cut's ONE reviewer, when the caller already assigned it. Left
   *  out, it is assigned here — this announcer is the one moment every door
   *  into the Room shares, so it is where a cut gets its owner. */
  reviewer?: { teamMemberId: string; name: string } | null;
}): Promise<void> {
  // WHO IT IS WAITING ON (unified handoff §8.1, Sep 25). Outside the bell's
  // try on purpose: the assignment is queue state and must land even when a
  // notification cannot. Null = no chain configured or nobody present, and
  // everything below then runs exactly as it did before.
  let reviewer = input.reviewer;
  if (reviewer === undefined) {
    try {
      const { ensureCutReviewer } = await import("@/lib/reviewerAssignment");
      reviewer = await ensureCutReviewer(input.submissionId);
    } catch (e) {
      console.warn("cut reviewer assignment failed (announcing to the office)", input.submissionId, e);
      reviewer = null;
    }
  }
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const { appBase } = await import("@/lib/appUrl");
    const href = `/review/${input.projectId}?cut=${input.submissionId}`;
    // The editor by roster name when the key resolves ("Kim"), else whoever
    // handed it in — the owner or Kyle uploading on an editor's behalf.
    const editor = editorMeta(input.editorKey)?.name ?? input.editorName ?? "editor";
    // The assignee, Jordan's oversight copy and the chain's FYI — or null, and
    // the office broadcast below stands (lib/reviewerAssignment explains each).
    const { reviewAnnounceTargets } = await import("@/lib/reviewerAssignment");
    const assigned = await reviewAnnounceTargets({
      reviewer: reviewer ?? null, street: input.street, editor, round: input.round, href, ownerActed: input.ownerActed,
    }).catch(() => null);
    // The person who SHOT it hears about it too (Jordan, Sep 18: "I want to be
    // able to share the review room with the photographer who shot the video …
    // they should be notified just like I am, with access to the review room").
    // Same href the office gets — the Room parked on this cut — because that
    // page has admitted the job's photographer since Sep 17 and now gives them
    // an index of their own. Their own line, not the ownerSms one: that field
    // is read only for an OWNER+ADMIN broadcast, and a person-addressed row's
    // sentence is `slackDm` (notify.ts bridgePerson). Money never enters it.
    const { photographerNotifyTarget } = await import("@/lib/projectPhotographer");
    const shooter = await photographerNotifyTarget(input.projectId, {
      href,
      slackDm: `🎬 A cut from your shoot is in review — ${input.street} (v${input.round}). Watch it and leave notes: ${appBase()}${href}`,
      // James shooting a job he also reviews hears it once, as its reviewer.
      skipMemberId: reviewer?.teamMemberId ?? null,
    }).catch(() => null);
    await notifyInApp({
      kind: input.kind,
      title: `${input.round > 1 ? `Version ${input.round}` : "Cut"} ready to review — ${input.street}${input.fileName ? ` · ${input.fileName}` : ""}`,
      body: input.fileName ?? undefined,
      href,
      targets: [
        ...(assigned ?? [
          {
            roles: ["OWNER", "ADMIN"],
            ownerSms: `Video in review — ${input.street} (${editor}, v${input.round}). ${appBase()}${href}`,
            // …and the owner's own upload takes his name off the fan-out inside
            // the bridge, one person at a time, instead of taking the sentence
            // away from everybody (see the note above this function).
            ...(input.ownerActed ? { ownerActed: true } : {}),
          },
        ]),
        ...(shooter && !assigned?.some((t) => t.userKey === shooter.userKey) ? [shooter] : []),
      ],
      dedupeKey: `cut-in-review-${input.submissionId}${input.dedupeSuffix ? `-${input.dedupeSuffix}` : ""}`,
    });
  } catch { /* bell is best-effort */ }
}

/** Video files in the job's Final folder, oldest first. [] = folder missing or
 *  empty (a trustworthy zero); null = Dropbox couldn't be read (unknown). */
export async function listFinalCuts(project: FolderProject): Promise<FinalCut[] | null> {
  const path = actualFolderPaths(project).finalVideo;
  type Entry = { ".tag": string; name: string; path_display?: string; server_modified?: string; size?: number; content_hash?: string; rev?: string };
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
        contentHash: e.content_hash ?? null,
        rev: e.rev ?? null,
      }))
      .sort((a, b) => a.serverModified.getTime() - b.serverModified.getTime());
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return [];
    return null;
  }
}

/** `sizeBytes`: what Dropbox says the file weighs, carried so the export
 *  measurement below can skip a HEAD request it would otherwise have to make.
 *  Null on a CLAIMED row — a claim creates nothing, and the sweep that minted
 *  that row is the pass that measures it.
 *  `legacy` (§8.2): a claimed row from before the self-check gate — it was
 *  announced the day the old sweep found it, so its release must not ring
 *  again. `contentHash`: the Dropbox hash the row was minted against. */
export type CreatedCut = { id: string; assetPath: string; fileName: string; round: number; isRedo: boolean; sizeBytes: number | null; legacy?: boolean; contentHash?: string | null };

// ---------------------------------------------------------------------------
// WHAT ACTUALLY ARRIVED — the resolution of a cut, recorded on its own row.
//
// The 1080p export spec (lib/videoStyles EXPORT_SPEC) is only a rule if
// somebody can see whether it is being followed, and the upload panel can only
// measure the files it sends: on the live data, 14 of the 26 rows came in
// through the panel and 12 through this folder — nearly half the cuts enter
// review by a door with no browser in it. Measuring here is what makes "are
// they exporting 1080p now?" a question about ALL the cuts rather than the
// convenient ones, and it is not a formality: reading the existing files on
// Sep 16 found SEVEN of the eleven folder cuts at 2160 × 3840, against two of
// eleven on the panel. The 4K is mostly on this side of the house.
//
// It measures and never blocks. A file that is already in the Final folder has
// been delivered as far as the editor is concerned; refusing it here would only
// mean a finished cut silently not reaching the Review Room, which is the one
// outcome worse than a 4K file getting through.
//
// The reader is the finishing pass's own probeVideoMetadata — a few HTTP range
// requests against the file's header, no download, no second copy of the
// parser. Nothing is written when it can't be read: null means "we don't know",
// never "it was fine".
// ---------------------------------------------------------------------------
export async function recordArrivedDimensions(submissionId: string, url: string, sizeBytes: number | null): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // WHAT THE PROBE IS ALLOWED TO FETCH (Sep 18). Two kinds of URL arrive
    // here: a Dropbox temporary link (the folder door, measureFolderCuts) and
    // the hub store's own object URL (the panel door, review/actions'
    // finishCutUpload). probeVideoMetadata takes a URL and nothing else — it
    // range-GETs it with no headers — so the store's half cannot be
    // authenticated by passing a token down; it has to be a URL that already
    // carries its own permission. On today's public store that is the object's
    // own URL and this line is a no-op; on a private one it is a short-lived
    // presigned GET. A Dropbox link is left exactly as it came.
    const probeUrl = await probeableUrl(url);
    if (!probeUrl) return;
    const { probeVideoMetadata } = await import("@/lib/integrations/topaz");
    const meta = await Promise.race([
      probeVideoMetadata(probeUrl, sizeBytes),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 6_000); }),
    ]);
    if (!meta || !(meta.width > 0 && meta.height > 0)) return;
    await prisma.reviewSubmission.update({
      where: { id: submissionId },
      data: { sourceWidth: meta.width, sourceHeight: meta.height },
    });
  } catch {
    /* an unreadable header stays unmeasured — a truthful answer for the one
       report this feeds. */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Measure the cuts a folder pass just entered. Strictly best-effort and
 *  capped: this runs inside the hourly sweep, so it may not become a way for
 *  one job with a folder full of video to eat the whole cron. A pass normally
 *  finds nothing new at all — MEASURE_CAP is for the day somebody drops a
 *  month's batch in at once.
 *  Cost, timed against the real folder (Sep 16): ~0.5-2s of Dropbox plus
 *  ~1.7s of header reads per file, and the file's SIZE makes no difference —
 *  a 2.2 GB cut measures as fast as a 200 MB one, because only the header is
 *  ever read. Four files is about ten seconds in the worst case. */
const MEASURE_CAP = 4;
export async function measureFolderCuts(created: CreatedCut[]): Promise<void> {
  for (const c of created.slice(0, MEASURE_CAP)) {
    try {
      // A temporary link, because probeVideoMetadata needs something it can
      // send Range requests at — the hub's own /stream route would want a
      // session, and Dropbox's API is not a byte server. Four hours' life,
      // which is 3h59m longer than this needs.
      //
      // The SIZE is handed in because it is already known and it saves a round
      // trip. It is NOT a workaround for a broken fallback: measured again on
      // Sep 17 against three live Dropbox temporary links, probeVideoMetadata
      // reads the size out of a ranged GET's Content-Range and succeeds with no
      // size passed. (The note that used to stand here said the fallback "gives
      // up every single time", which was true of the HEAD-only version and is
      // the sentence a future reader would use to conclude the fallback does
      // not work — it does.) The listing already knew the size — that is what
      // CreatedCut.sizeBytes carries — and get_metadata is the cheap read for
      // the case where it didn't.
      let size = c.sizeBytes;
      if (!size) size = (await dbx<{ size?: number }>("files/get_metadata", { path: c.assetPath })).size ?? null;
      if (!size) continue;
      const r = await dbx<{ link?: string }>("files/get_temporary_link", { path: c.assetPath });
      if (!r.link) continue;
      await recordArrivedDimensions(c.id, r.link, size);
    } catch {
      /* Dropbox having a bad minute is not this pass's problem — the row
         simply stays unmeasured. */
    }
  }
}

/** THE LEFTOVER REGISTER (Sep 16). A removal deletes the ReviewSubmission, so
 *  nothing in the Room remembers a cut that is gone — but its file can still
 *  be sitting in the job's Final folder, either because Jordan left the
 *  Dropbox box unticked or because it was a folder-discovered row whose source
 *  export is not ours to delete. Without this the next discovery pass (and the
 *  editor's "Send for review" button, which reads the folder whatever the
 *  discovery setting says) mints a fresh PENDING row for the very video that
 *  was just pulled, and rings the desk about it.
 *
 *  The record lives on the office's own task — the `stranded-final-<id>`
 *  SmartTask review/actions.removeCut writes, whose sourceDetail IS the path
 *  and whose createdAt is when the removal happened. Path → removed-at; a file
 *  modified after that moment is a re-export, not the thing that was removed.
 *  Status-agnostic on purpose: a task closed by hand doesn't make the pulled
 *  video reviewable again. */
async function removedCutLeftovers(projectId: string): Promise<Map<string, Date>> {
  const rows = await prisma.smartTask
    .findMany({
      where: { projectId, dedupeKey: { startsWith: "stranded-final-" }, sourceDetail: { not: null } },
      select: { sourceDetail: true, createdAt: true },
    })
    .catch(() => [] as { sourceDetail: string | null; createdAt: Date }[]);
  const out = new Map<string, Date>();
  for (const r of rows) {
    if (!r.sourceDetail) continue;
    const seen = out.get(r.sourceDetail);
    if (!seen || r.createdAt > seen) out.set(r.sourceDetail, r.createdAt);
  }
  return out;
}

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
    /** §8.2: say which file the button WOULD send, and write nothing. The
     *  editor's check is asked about that file before any row exists. A dry
     *  run's created rows carry id "". */
    dryRun?: boolean;
  },
): Promise<{ created: CreatedCut[]; claimed: CreatedCut | null; folderVideoCount: number; nothingNew: boolean; unreadable: boolean }> {
  const mode = opts.mode ?? "sweep";
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, status: true, deliveredAt: true,
      client: { select: { name: true } },
      reviewSubmissions: {
        select: { id: true, assetPath: true, finalPath: true, fileName: true, round: true, status: true, decidedAt: true, createdAt: true, submittedByName: true, submittedByKey: true, selfCheckId: true, selfCheckedAt: true, sourceRev: true },
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
    // A row HELD for its check (§8.2) is claimable too when it is already this
    // editor's: a press whose check failed half-way must find its own row
    // again, not answer "already in review" about a cut nobody can see.
    const { isHeldForSelfCheck } = await import("@/lib/selfCheck");
    const unclaimed = project.reviewSubmissions
      .filter((s) => s.assetPath && s.status === "PENDING" && (!s.submittedByKey || (isHeldForSelfCheck(s) && s.submittedByKey === (opts.submittedByKey ?? null))))
      .sort((a, b) => (b.round - a.round) || (b.createdAt.getTime() - a.createdAt.getTime()));
    if (unclaimed.length > 0) {
      const note = (opts.note ?? "").trim().slice(0, 1000) || null;
      const pick = unclaimed[0];
      if (!opts.dryRun) {
        await prisma.reviewSubmission.update({
          where: { id: pick.id },
          data: { submittedByKey: opts.submittedByKey ?? null, submittedByName: opts.submittedByName, ...(note ? { note } : {}) },
        });
      }
      // sizeBytes null: a claim creates nothing — the sweep that minted this
      // row already measured it. `legacy`: a pre-gate row, rung the day the old
      // sweep found it; it keeps its grandfathered place in the Room.
      const claimed: CreatedCut = { id: pick.id, assetPath: pick.assetPath!, fileName: pick.fileName ?? "", round: pick.round, isRedo: pick.round > 1, sizeBytes: null, legacy: !pick.selfCheckId, contentHash: pick.sourceRev };
      return { created: [], claimed, folderVideoCount: project.reviewSubmissions.filter((s) => s.assetPath).length, nothingNew: false, unreadable: false };
    }
  }

  const listed = await listFinalCuts(project);
  if (listed === null) return { ...none, nothingNew: false, unreadable: true };
  const removed = await removedCutLeftovers(projectId);
  const cuts = listed.filter((c) => {
    if (hubCopies.has(c.path)) return false;
    // A REMOVED cut's file can still be in the folder, and its row is gone, so
    // nothing above remembers it (reviewer, Sep 16 — the BLOCKER-shaped one):
    // the editor's next "Send for review" press reads this folder whatever the
    // discovery setting says, and would hand Jordan back the very video he
    // just pulled. The leftover register below is what remembers it.
    const gone = removed.get(c.path);
    // …but only the file that WAS removed. A re-export lands on the same path
    // with a newer server_modified, and that one is a genuinely new cut — the
    // usual way an editor fixes the mistake they were removing.
    return !gone || c.serverModified.getTime() > gone.getTime();
  });

  // Latest round per path. A legacy WITHDRAWN row counts here on purpose
  // (Sep 16): the file it came from is still sitting in the Final folder, so
  // if the withdrawn round didn't hold the path the next sweep would
  // re-discover the very cut the editor took back. Only "changes requested"
  // reopens a path, and a withdrawal is not that. A REMOVED cut has no row to
  // hold anything, which is what `removed` above is for.
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
    if (placeholder && cuts.length > 0 && !opts.dryRun) {
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
  if (opts.dryRun) {
    return {
      created: eligible.map((c) => {
        const latest = latestByPath.get(c.path);
        return { id: "", assetPath: c.path, fileName: c.name, round: latest ? latest.round + 1 : 1, isRedo: !!latest, sizeBytes: c.size || null, contentHash: c.contentHash ?? null };
      }),
      claimed: null, folderVideoCount: cuts.length, nothingNew: false, unreadable: false,
    };
  }

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
          sourceRev: c.contentHash ?? null,
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
            // The bytes this row was minted against (§8.2) — what a check binds to.
            sourceRev: c.contentHash ?? null,
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
    // HELD UNTIL THE EDITOR'S CHECK (§8.2: "a discovered cut may wait for
    // self-QC; discovery cannot silently satisfy it"). Every folder row minted
    // from here on carries the marker, sweep or button alike; the button's own
    // check releases its row a moment later (review/actions.submitCutForReview).
    const { holdForSelfCheck } = await import("@/lib/selfCheckStore");
    await holdForSelfCheck(id, mode === "sweep" ? "Found in the Final folder — the editor's check before review is still to do." : "Waiting on the send-for-review check.").catch(() => {});
    created.push({ id, assetPath: c.path, fileName: c.name, round, isRedo: !!latest, sizeBytes: c.size || null, contentHash: c.contentHash ?? null });
  }
  return { created, claimed: null, folderVideoCount: cuts.length, nothingNew: created.length === 0, unreadable: false };
}

/** Distinct files that have been submitted (any round/status) — what closes
 *  a multi-video edit task. A WITHDRAWN round is not a cut the editor handed
 *  in (Sep 16): counting it would close the edit card for a video that is no
 *  longer in front of anybody. */
export async function submittedDistinctCuts(projectId: string): Promise<number> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", WITHDRAWN] }, OR: [{ assetPath: { not: null } }, { blobUrl: { not: null } }] },
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
  // NOT ANNOUNCED (§8.2, Sep 25). A cut the sweep found is held for the
  // editor's check, so it is not in front of the reviewer and ringing the desk
  // about it would be the one notice that lies. The editor (and the office,
  // bell only) hears that a check is owed; the review announcement goes out
  // once, when the check releases it (review/actions.submitCutForReview).
  const { notifySelfCheckNeeded } = await import("@/lib/selfCheckStore");
  for (const row of r.created) {
    await notifySelfCheckNeeded(row.id, `Found in ${street}'s Final folder — finish the check to send it to review.`);
  }
  // What the files actually were. AFTER the bell, always: a desk that knows a
  // cut is waiting matters and a number on a report does not, so nothing above
  // this line waits on a probe. measureFolderCuts swallows everything.
  await measureFolderCuts(r.created);
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
  /** The office waived this row — "not required on this job". Only ever true
   *  when the caller asked for waived slots (`{ includeWaived: true }`); the
   *  default answer is the work that is genuinely owed. */
  waived?: boolean;
  /** CP-09: the content topic filmed for this slot, by its title as it reads
   *  NOW (bound by id on DeliverableOutput.topicId, so a rename shows at once).
   *  Present only on a content session's bound slots. Deliberately NOT folded
   *  into `label`: the label is what the approved file and the Review Room's
   *  cut identity are named by, and a topic rename must not rename a file. */
  topicTitle?: string;
};

/** Identity of a cut across rounds — uploaded rows by (deliverable, slot),
 *  legacy folder rows by file path. */
export function cutKeyOf(s: { deliverableId?: string | null; slot?: number | null; assetPath?: string | null; id: string }): string {
  return s.deliverableId ? `${s.deliverableId}:${s.slot ?? 1}` : (s.assetPath ?? s.id);
}

/** The same identity from the two parts, for callers holding a slot rather than
 *  a round — `DeliverableOutput`, the unit model in evidenceUnits, the revision
 *  work order's per-video scope. One function so the three can never spell the
 *  key differently. */
export function slotKeyOf(deliverableId: string, slot: number | null | undefined): string {
  return `${deliverableId}:${slot ?? 1}`;
}

/**
 * THE OWED-SLOT KEY OF A ROUND — not the same thing as cutKeyOf (reviewer,
 * Sep 18, and the reason the per-item revision rule could never close an ask).
 *
 * cutKeyOf answers "which cut is this a version of", and for a round carrying
 * no deliverable it answers with the Dropbox path (or the row's own id). That
 * is a perfectly good IDENTITY — it is what groups rounds of the same file —
 * but it is not a SLOT, and `cutSlots`/`slotKeyOf`/the work order's per-item
 * scope all speak in slots. Compare the two sets and they never intersect: on
 * 1956 Wetherhill Dr the job owes one slot, `cmsnr2ycm000vjr0411ci8om2:1`, and
 * its two APPROVED rounds key as
 * `/AutoHDR/…/05-Final-Video/Finish_1956 Wetherhill Dr….mp4`. Measured across
 * production: 14 of the 35 rounds carry no deliverableId, and NOT ONE of them
 * intersected its job's owed keys, so every `all`/`unknown` item on those jobs
 * was outstanding for ever on a job with nothing left to do.
 *
 * Where the deliverable IS on the row, the two keys agree by construction.
 * Where it is not, exactly one thing can be said honestly:
 *   · the job owes ONE slot → the round is that slot. A fact, not a guess, and
 *     the same fact cutAnswersAsk ("owed <= 1") and the analyser
 *     (`cuts.length === 1 → scope "all"`) already act on;
 *   · the job owes several → NOTHING. Guessing which of four videos a Dropbox
 *     path is would put a client's approval on the wrong deliverable
 *     (deliverableOutputs.linkRoundsToOutputs refuses the same guess, which is
 *     why `outputId` is null on all 14 of these rows and cannot rescue them).
 *     The ask then holds open until a keyed round lands on each slot, and the
 *     task's own Complete button is the person's override — the same escape
 *     outstandingItems documents. Production today: 3 jobs, 8 rounds
 *     (1033 Preserve Ln ×5, 38 E Gay St ×2, 131 Woodcutter St ×1).
 */
export function owedSlotKeyOf(
  round: { deliverableId?: string | null; slot?: number | null },
  owedKeys: readonly string[],
): string | null {
  if (round.deliverableId) return slotKeyOf(round.deliverableId, round.slot);
  return owedKeys.length === 1 ? owedKeys[0] : null;
}

/** Every slot with an APPROVED round since the ask, in the key space the work
 *  order's items are scoped in. Pure, so the rule can be exercised against the
 *  shapes the REAL submit paths produce (scripts/_fix/A/scope-real-path.ts)
 *  rather than against hand-written slot keys the folder path never mints. */
export function approvedSlotKeys(
  rounds: readonly { deliverableId?: string | null; slot?: number | null; status?: string | null }[],
  owedKeys: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const r of rounds) {
    if (r.status !== "APPROVED") continue;
    const k = owedSlotKeyOf(r, owedKeys);
    if (k) out.add(k);
  }
  return out;
}

/** Every video cut this job owes, in order. Monthly plans put the whole batch
 *  on their one video row (quantity / videosFilmed / plan quota).
 *  Each cut is NAMED by its resolved style (Deliverable.videoStyle →
 *  productTitle → label heuristics), with the same tier/monthly verdicts the
 *  tracker's "Edit type" uses — so "Send to Review", the Review Room
 *  switcher, the approved file name and the brief all say one thing. Jordan
 *  (Sep 2): a Standard Reel with Agent Intro cut must not read "Social Reel".
 *
 *  A WAIVED ROW OWES NOTHING (audit WF-02, Sep 18). "Not required on this job"
 *  (Deliverable.waivedAt, Kyle's call Sep 16) was honoured by every OTHER owed
 *  reader and not by this one, so a waived video still minted a cut slot, still
 *  counted against the approved-cut gate and still told the editor the job was
 *  short. It is dropped AFTER the counts are computed, never before: the
 *  office's videos-owed total is split across the video rows BY POSITION
 *  (editOverrides.effectiveSlotCounts), so removing a row from the array
 *  silently re-points every later row's count — which is how 893 S Matlack's
 *  sixteen cuts would have read as one. `includeWaived` hands the waived slots
 *  back, flagged, for the one caller that has to record them rather than work
 *  on them (deliverableOutputs.ts — a waived video keeps its row and its
 *  history; it is retired, not deleted). */
export async function cutSlots(projectId: string, opts: { includeWaived?: boolean } = {}): Promise<CutSlot[]> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      packageName: true, videosFilmed: true,
      videosOwedOverride: true, // the office's batch size (Sep 13) — wins over every rule below
      contentMonthId: true, // CP-09: only a content session can have topics on its slots
      deliverables: {
        where: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, label: true, quantity: true, videoStyle: true, productTitle: true, waivedAt: true },
      },
    },
  });
  if (!p || p.deliverables.length === 0) return [];
  // CP-09: the topic each bound slot was filmed for, read by id and titled
  // live. Two small reads, and only on a content session — every listing job
  // (the overwhelming majority of callers) skips them. A failure costs the
  // titles, never the slots.
  const topicByKey = new Map<string, string>();
  if (p.contentMonthId) {
    try {
      const bound = await prisma.deliverableOutput.findMany({
        where: { projectId, topicId: { not: null } },
        select: { deliverableId: true, slot: true, topicId: true },
      });
      const ids = [...new Set(bound.map((b) => b.topicId!))];
      const titles = ids.length ? await prisma.contentTopic.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }) : [];
      const titleOf = new Map(titles.map((t) => [t.id, t.title.trim()]));
      for (const b of bound) {
        const t = titleOf.get(b.topicId!);
        if (t) topicByKey.set(slotKeyOf(b.deliverableId, b.slot), t);
      }
    } catch { /* titles are a label — the slot list stands without them */ }
  }
  const { isMonthlyContentJob, monthlyVideoQuota } = await import("@/lib/pipeline");
  const { videoTier } = await import("@/lib/projectStatus");
  const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
  const tier = videoTier(p.deliverables);
  // The hub's own count per row, then the office's total laid over it
  // (Sep 13, editOverrides.effectiveSlotCounts): "videos owed 6" on a 4-video
  // month makes six slots here, six on the QC card, six before the approved
  // gate opens.
  const baseCounts = p.deliverables.map((d, i) => {
    let count = Math.max(1, d.quantity ?? 1);
    if (monthly && i === 0) {
      count = Math.max(count, p.videosFilmed ?? monthlyVideoQuota([p.packageName, ...p.deliverables.map((x) => x.label)]));
    }
    return count;
  });
  const counts = effectiveSlotCounts(p, baseCounts);
  const out: CutSlot[] = [];
  for (const [i, d] of p.deliverables.entries()) {
    const count = counts[i];
    // The waived row kept its place in the arithmetic above (see the note on
    // this function) and drops out here, where dropping it costs nothing.
    if (d.waivedAt && !opts.includeWaived) continue;
    const base = videoStyleFor(d, { monthly, tier }).name;
    for (let slot = 1; slot <= count; slot++) {
      out.push({
        deliverableId: d.id,
        deliverableLabel: base,
        slot,
        count,
        label: count > 1 ? `${base} — Video ${slot} of ${count}` : base,
        ...(d.waivedAt ? { waived: true } : {}),
        ...(topicByKey.has(slotKeyOf(d.id, slot)) ? { topicTitle: topicByKey.get(slotKeyOf(d.id, slot))! } : {}),
      });
    }
  }
  return out;
}

const SAFE_NAME = (name: string) => name.replace(/[^\w.\- ()]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "cut.mp4";
export const uploadPathnameFor = (projectId: string, submissionId: string, fileName: string) =>
  `review-cuts/${projectId}/${submissionId}/${SAFE_NAME(fileName)}`;

// ===========================================================================
// THE CUT STORE — who may read these bytes, and with what.
//
// RTP-01 (Sep 16 → Sep 18). A review cut is an unreleased client video, and the
// store holding them was created PUBLIC, which makes every object URL a
// permanent credential-free link: the Sep 16 audit pulled a 368 MB .mov off
// `mphvkcyomow88h9w.public.blob.vercel-storage.com` with no session at all.
// The store's access level is fixed AT CREATION — `access` is the BROWSER's
// header (@vercel/blob 2.8.0 writes `x-vercel-blob-access` in createPutHeaders,
// and `onBeforeGenerateToken` has no `access` key to return), so only a human
// in the Vercel dashboard can make a private one. THAT is a real external
// dependency.
//
// The code half is not, and on Sep 17 it was reported finished while six paths
// still handed a bare public URL to somebody else's servers (reviewer, Sep 18):
// the approval's Dropbox copy, the Topaz upload, the header probes, Meta's
// container fetch, the transcription provider, and both delete guards. This
// section is that half, in ONE place so there is never a seventh.
//
// Three rules:
//   1. OUR OWN fetch carries the store's read token — blobFetchDecision.
//   2. SOMEBODY ELSE'S fetch — Dropbox pulling `files/save_url`, Meta pulling
//      `video_url`, a speech-to-text provider — gets a SHORT-LIVED PRESIGNED
//      GET scoped to that one pathname (fetchableCutUrl). Never the read-write
//      token: a presigned URL carries a delegation naming one object and one
//      expiry, which is a categorically different thing to hand a stranger than
//      a credential that can write and delete every cut we hold.
//   3. Nothing is decided by a hard-coded hostname. The store this deployment
//      owns is whatever its TOKEN says — and during the cutover it owns TWO
//      (BLOB_READ_WRITE_TOKEN and BLOB_READ_WRITE_TOKEN_LEGACY). That pair is
//      what makes the cutover window-free: a row may name either store at any
//      instant and every read, probe and delete still resolves to the right
//      token. docs/REVIEW-CUT-STORE-HANDOVER.md §3 is the order.
//
// NOTHING BELOW HAS EVER RUN AGAINST A PRIVATE STORE, because no private store
// exists. On today's public store every function here returns exactly what the
// code it replaced returned — no signing call is made, no header is added, the
// same URL comes back (scripts/_fix/R05/probe-store-decisions.ts runs them
// against the real token and the real rows and prints old beside new). That is
// deliberate: this ships dormant and wakes the day the store is replaced.
// ===========================================================================

/** Every blob read-write token this deployment holds, primary first.
 *
 *  BLOB_READ_WRITE_TOKEN is the store new uploads land in. The LEGACY slot is
 *  the store cutover and nothing else: for as long as some rows still name the
 *  old store and some name the new one, BOTH have to be readable and
 *  deletable, or `del()` is aimed at the wrong store — which is the 08:40
 *  window in handover §4, where a row's only pointer was cleared and then
 *  nothing was deleted. It comes out again once every row has moved. */
export function blobStoreTokens(): string[] {
  return [process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN, process.env.BLOB_READ_WRITE_TOKEN, process.env.BLOB_READ_WRITE_TOKEN_LEGACY]
    .map((t) => (t ?? "").trim())
    .filter((t, i, all) => t.length > 0 && all.indexOf(t) === i);
}

// THE PRIVATE STORE, BY CONNECTION (Sep 25 2026). The private store exists
// (`review-cuts-private`) and is connected to the project with the env prefix
// REVIEW_CUTS_PRIVATE_, so its token arrives as
// REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN beside the public store's
// integration-managed BLOB_READ_WRITE_TOKEN — which cannot simply be
// overwritten while the public store is still connected. So instead of the
// handover's env swap, the PRESENCE of the private token decides both halves
// of the upload at once: blobStoreTokens() lists it first (new uploads land
// there; the public store becomes the legacy slot, still readable and
// deletable while its objects move), and cutStoreAccess() tells the browser
// "private" through startCutUpload. One setting, so the token and the
// browser's access word can never disagree — the half-flipped state the
// handover's step 3 had to choreograph. Nothing changes while the variable is
// absent: the public store and the old NEXT_PUBLIC flag behave as before.

/** The token new cut uploads are signed with: the private store's once it is
 *  connected, else the public store's. handleUpload is given it explicitly —
 *  by default it would read BLOB_READ_WRITE_TOKEN, the public store. */
export function cutUploadToken(): string | undefined {
  return blobStoreTokens()[0];
}

/** The `access` word the browser must send on its own PUT for the store
 *  cutUploadToken() names. A mismatch is refused by the control plane
 *  ("Cannot use public access on a private store"), so this is never guessed. */
export function cutStoreAccess(): "private" | "public" {
  if ((process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN ?? "").trim()) return "private";
  return process.env.NEXT_PUBLIC_REVIEW_CUT_ACCESS === "private" ? "private" : "public";
}

/** The store id a read-write token names: the fourth underscore-separated
 *  field, CASE-FOLDED. The token spells it the way the dashboard writes it
 *  (`mphvkCyOMoW88h9w`) while a hostname is case-insensitive by DNS and
 *  `new URL().host` lower-cases it before anyone sees it — compared raw, the
 *  guard refused every legitimate object, on the one day it is meant to start
 *  working (review, Sep 17). */
export function blobStoreIdOf(token: string | null | undefined): string {
  return (token ?? "").split("_")[3]?.toLowerCase() ?? "";
}

/** What, if anything, this cut's object may be fetched with.
 *  `foreign-store` means the URL names a Vercel store this deployment holds no
 *  token for — refuse rather than hand our bearer credential to a stranger. */
export type BlobFetchDecision =
  | { ok: true; authorization: string | null; token: string | null }
  | { ok: false; reason: "unreadable" | "foreign-store"; host: string };

/** A private blob needs the store's read token; a public one ignores it. The
 *  host says which — the SDK builds `<store>.<access>.blob.vercel-storage.com`
 *  (constructBlobUrl) and reads a private object with a plain
 *  `authorization: Bearer <read-write token>` (get(), same package, read line
 *  by line in 2.8.0).
 *
 *  The token is a bearer credential for ONE store, so matching on `.private.`
 *  alone would have offered it to ANY Vercel store's host. Not hypothetical:
 *  the cutover puts two stores in play at once, and a row carrying a store we
 *  do not hold must fail loudly rather than quietly present our credential.
 *
 *  Lived in the stream route until Sep 18 and is still re-exported from there
 *  (scripts/_fix/G/probe-guard.ts imports it by that path). It moved because
 *  the workers that now need it — Topaz, the probes, the prune — have no
 *  business importing an app route. */
export function blobFetchDecision(
  blobUrl: string,
  tokens: string | readonly string[] | undefined = blobStoreTokens(),
): BlobFetchDecision {
  const list = (typeof tokens === "string" ? [tokens] : [...(tokens ?? [])]).filter(Boolean);
  let host = "";
  try { host = new URL(blobUrl).host.toLowerCase(); } catch { return { ok: false, reason: "unreadable", host: "" }; }
  if (!host.endsWith(".blob.vercel-storage.com")) return { ok: false, reason: "unreadable", host };
  const owner = list.find((t) => {
    const id = blobStoreIdOf(t);
    return !!id && host.startsWith(`${id}.`);
  }) ?? null;
  // A PUBLIC object needs no credential and never gets one, whichever store it
  // sits in. `token` is still reported when we own that store, because a
  // delete has to be aimed at the right one even when a read does not.
  if (!host.includes(".private.")) return { ok: true, authorization: null, token: owner };
  if (!owner || host !== `${blobStoreIdOf(owner)}.private.blob.vercel-storage.com`) {
    return { ok: false, reason: "foreign-store", host };
  }
  return { ok: true, authorization: `Bearer ${owner}`, token: owner };
}

/** Is this object ours to delete, and with which token?
 *
 *  A different question from blobFetchDecision: reading a public object needs
 *  no ownership, DELETING one does. `del()` deletes from the store the TOKEN
 *  names, not the store the URL names, so a delete aimed with the wrong token
 *  removes nothing and reports success (handover §4). It also pins the path:
 *  this code may only ever delete review cuts.
 *
 *  `ok: true` with `token: null` means no blob token is configured at all
 *  (local dev, a preview with no store bound). A caller that only asks "is
 *  this one of ours" may proceed on the host and path; a caller that DELETES
 *  must require the token. */
export type CutObjectOwner =
  | { ok: true; token: string | null; host: string; pathname: string; access: "public" | "private" | "unknown" }
  | { ok: false; reason: "unreadable" | "not-a-cut-path" | "foreign-store"; host: string };

export function ownCutObject(
  blobUrl: string,
  tokens: string | readonly string[] | undefined = blobStoreTokens(),
): CutObjectOwner {
  const list = (typeof tokens === "string" ? [tokens] : [...(tokens ?? [])]).filter(Boolean);
  let u: URL;
  try { u = new URL(blobUrl); } catch { return { ok: false, reason: "unreadable", host: "" }; }
  const host = u.host.toLowerCase();
  if (!host.endsWith(".blob.vercel-storage.com")) return { ok: false, reason: "unreadable", host };
  const pathname = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!pathname.startsWith("review-cuts/")) return { ok: false, reason: "not-a-cut-path", host };
  const access = host.includes(".private.") ? "private" : host.includes(".public.") ? "public" : "unknown";
  const token = list.find((t) => {
    const id = blobStoreIdOf(t);
    return !!id && host.startsWith(`${id}.`);
  }) ?? null;
  if (!token && list.length > 0) return { ok: false, reason: "foreign-store", host };
  return { ok: true, token, host, pathname, access };
}

/** A URL that SOMEBODY ELSE'S servers can fetch this cut with.
 *
 *  Public store (today): the object's own URL, unchanged, and no network call
 *  at all — so Dropbox, Topaz and the header probes behave exactly as they did
 *  before this function existed.
 *
 *  Private store: a presigned GET, minted through the SDK's own two-step
 *  (`issueSignedToken` → `presignUrl`, @vercel/blob 2.8.0). The delegation is
 *  scoped to ONE pathname with ONE expiry and is signed per issuance, so what
 *  leaves the building is a link to one video for a few hours — not the
 *  read-write token. `presignUrl` is local HMAC; only `issueSignedToken` talks
 *  to the control API, which is why today's public branch costs nothing.
 *
 *  UNPROVEN, and it must not be described otherwise: no private store exists,
 *  so no presigned URL has ever been minted or fetched from here. The two-step,
 *  the option names and the pathname/expiry scoping are read off the installed
 *  SDK's own types and implementation. The first private upload is the first
 *  test (handover §5). */
export type FetchableCutUrl =
  | { ok: true; url: string; signed: boolean; expiresAt: Date | null }
  | { ok: false; reason: "no-file" | "unreadable" | "foreign-store" | "mint-failed"; message: string };

const SIGNED_URL_MIN_MS = 60_000;
const SIGNED_URL_MAX_MS = 24 * 3600_000;

export async function fetchableCutUrl(
  cut: { blobUrl?: string | null; blobPathname?: string | null },
  opts: { ttlMs?: number; purpose?: string } = {},
): Promise<FetchableCutUrl> {
  const url = (cut.blobUrl ?? "").trim();
  const purpose = opts.purpose ?? "external fetch";
  if (!url) return { ok: false, reason: "no-file", message: "The hub no longer holds this cut's file." };
  const decision = blobFetchDecision(url);
  if (!decision.ok) {
    // The host goes in the log, never in the sentence a person reads: it names
    // a half-finished configuration, not anything about the video.
    console.error(`[cut-store] ${purpose}: refused a cut url (${decision.reason})`, decision.host);
    return {
      ok: false,
      reason: decision.reason,
      message: decision.reason === "unreadable"
        ? "That cut's file link is unreadable."
        : "That cut's file is in a store this deployment holds no token for.",
    };
  }
  // Public object: nothing to sign, and signing it would turn a URL that works
  // today into one that can expire. This is the branch production takes.
  if (!decision.authorization || !decision.token) return { ok: true, url, signed: false, expiresAt: null };

  const pathname = (cut.blobPathname ?? "").trim() || decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  const ttl = Math.min(Math.max(opts.ttlMs ?? 4 * 3600_000, SIGNED_URL_MIN_MS), SIGNED_URL_MAX_MS);
  try {
    const { issueSignedToken, presignUrl } = await import("@vercel/blob");
    const signed = await issueSignedToken({
      token: decision.token,
      pathname,
      operations: ["get"],
      validUntil: Date.now() + ttl,
    });
    // validUntil is deliberately NOT repeated to presignUrl: the SDK caps the
    // URL at the delegation's ceiling and omits it on the wire when the two are
    // equal, so passing it again can only disagree with the token just minted.
    const { presignedUrl } = await presignUrl(signed, { operation: "get", pathname, access: "private" });
    return { ok: true, url: presignedUrl, signed: true, expiresAt: new Date(signed.validUntil) };
  } catch (e) {
    console.error(`[cut-store] ${purpose}: could not mint a signed url for ${pathname}`, e);
    return { ok: false, reason: "mint-failed", message: "The hub could not mint a temporary link to this cut's file." };
  }
}

/** A URL our OWN header probes can be pointed at.
 *  `probeVideoMetadata` takes a bare URL and sends no headers, so a store
 *  object has to arrive already carrying its permission — the same handoff an
 *  outside fetcher gets. Anything that is not a store object (a Dropbox
 *  temporary link, a Topaz download link) is returned untouched. null = this
 *  file cannot be read at all, so there is nothing honest to measure. */
export async function probeableUrl(url: string): Promise<string | null> {
  if (!/^https:\/\/[^/]+\.blob\.vercel-storage\.com\//i.test(url)) return url;
  const r = await fetchableCutUrl({ blobUrl: url }, { ttlMs: 30 * 60_000, purpose: "header probe" });
  return r.ok ? r.url : null;
}

/** Delete one cut object with the token of the store it is ACTUALLY in.
 *  Returns why not, in words, when it did not happen — every caller says so
 *  out loud rather than counting a miss as a success (handover §4). */
export async function deleteCutObject(blobUrl: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const owner = ownCutObject(blobUrl);
  if (!owner.ok) return { ok: false, reason: owner.reason };
  if (!owner.token) return { ok: false, reason: "no-token" };
  try {
    const { del } = await import("@vercel/blob");
    await del(blobUrl, { token: owner.token });
    return { ok: true };
  } catch (e) {
    console.error("[cut-store] delete failed", owner.host, e);
    return { ok: false, reason: "delete-failed" };
  }
}

/** The words an upload hears when its bytes are not the file that was checked. */
export const HELD_UPLOAD_MESSAGE =
  "The upload landed, but it isn't the file you checked — it is waiting for a fresh check before it goes to review (Finish the check on this page).";

const loadEnteringCut = (id: string) =>
  prisma.reviewSubmission.findUnique({
    where: { id },
    include: { project: { select: { id: true, title: true, status: true, deliveredAt: true } } },
  });
type EnteringCut = NonNullable<Awaited<ReturnType<typeof loadEnteringCut>>>;

/** The upload landed in the store → the cut is in review. Idempotent (the
 *  client calls it, and Vercel's upload-completed callback may call it too).
 *  §8.2: only once the editor's check is bound to THESE bytes — see
 *  enterReview below. `held` = the bytes are safe in the store but the cut is
 *  waiting on a check, so the browser must not treat it as a failed upload. */
export async function finalizeCutUpload(
  submissionId: string,
  blob: { url: string; pathname: string; size?: number | null },
): Promise<{ ok: boolean; message: string; held?: boolean }> {
  const sub = await loadEnteringCut(submissionId);
  if (!sub) return { ok: false, message: "That upload no longer exists." };
  if (sub.blobUrl) return bindLandedUpload(sub, blob);
  if (!blob.pathname.startsWith(`review-cuts/${sub.projectId}/${sub.id}/`)) {
    return { ok: false, message: "That file doesn't belong to this cut." };
  }
  // …and the object has to be in a store this deployment actually holds a token
  // for. The path above says which CUT the bytes are for; this says whose STORE
  // they are in, which is the question that starts mattering the moment there
  // are two of them (handover §3). Deliberately NOT a hostname match: the
  // regex this replaces named `.public.` and would have refused every upload
  // the day the store went private.
  const owner = ownCutObject(blob.url);
  if (!owner.ok) {
    console.error("[review] upload finalize refused a foreign object", owner.reason, owner.host);
    return { ok: false, message: "That file isn't in the hub's cut store." };
  }
  // Only an UPLOADING row becomes a cut — a late store callback must not
  // resurrect an abandoned/failed row (its bytes get released instead).
  if (sub.status !== "UPLOADING") {
    if (sub.status === "UPLOAD_FAILED") {
      // Aimed at the store the URL names, not whatever token happens to be
      // primary — see deleteCutObject. The retention sweep catches a stray.
      await deleteCutObject(blob.url);
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
  if (won.count === 0) {
    // The other caller flipped the row between our read and our flip. If it
    // could not say what landed (the store's callback carries no size, and its
    // own read of the store failed) the check is still waiting on the bytes —
    // and this caller may be the one holding the measurement. Answer from the
    // row as it is now, never a blind "already in review" (review fix, Sep 25).
    const again = await loadEnteringCut(submissionId);
    if (again?.blobUrl) return bindLandedUpload(again, blob);
    return { ok: true, message: "Already in review." };
  }
  // THE EDITOR'S CHECK, BOUND TO WHAT LANDED (§8.2). The bytes are ours now;
  // whether they are in front of the reviewer depends on them being the file
  // the editor checked. A reservation from before the gate carries no check
  // and enters exactly as it always did (grandfathered).
  const { bindUploadCheck } = await import("@/lib/selfCheckStore");
  const bound = await bindUploadCheck(sub, { url: blob.url, pathname: blob.pathname, size: blob.size ?? null });
  if (bound === "void" || bound === "unverified") return { ok: false, held: true, message: HELD_UPLOAD_MESSAGE };
  const entered = await enterReview(sub.id, { legacy: bound === "none" });
  return entered.entered ? { ok: true, message: entered.message } : { ok: true, message: "Already in review." };
}

/** The bytes are already recorded (by the other of the two finalize callers).
 *  When that one could not say what landed, the check is still waiting on
 *  them — bind it now with this caller's measurement and enter the cut; a row
 *  whose check is gone or whose bytes did not match stays held, and says so. */
async function bindLandedUpload(
  sub: EnteringCut,
  blob: { url: string; pathname: string; size?: number | null },
): Promise<{ ok: boolean; message: string; held?: boolean }> {
  if (sub.status === "PENDING" && sub.blobUrl && sub.selfCheckId && !sub.selfCheckedAt) {
    const { bindUploadCheck } = await import("@/lib/selfCheckStore");
    const bound = await bindUploadCheck(sub, { url: sub.blobUrl, pathname: sub.blobPathname ?? blob.pathname, size: blob.size ?? null });
    if (bound === "void" || bound === "unverified") return { ok: false, held: true, message: HELD_UPLOAD_MESSAGE };
    if (bound === "valid" || bound === "already") {
      const r = await enterReview(sub.id);
      if (r.entered) return { ok: true, message: r.message };
      if (r.held) return { ok: false, held: true, message: HELD_UPLOAD_MESSAGE };
    }
  }
  return { ok: true, message: "Already in review." };
}

/**
 * THE MOMENT A CUT IS IN FRONT OF THE REVIEWER (§8.2, Sep 25).
 *
 * Every gated door ends here or in claimReviewEntry: a VALID self-check bound
 * to the row, then ONE compare-and-set on selfCheckedAt, and only the caller
 * that wins it runs the entry's side effects — the job to REVIEW, the edit
 * card's close-out, the Activity line and the announcement (which names the
 * cut's one reviewer, §8.1, and is where the editor's active stretch closes,
 * §7.1). A repeat call is a no-op. A row with no check id is a pre-gate row;
 * it enters only when its caller says so (`legacy`), because that caller's
 * own compare-and-set is then the guard — finalize's UPLOADING → PENDING.
 *
 * Handles the upload door and a moved cut. A Final-folder cut's side effects
 * stay with the editor's button (review/actions.submitCutForReview), which
 * claims its entry through claimReviewEntry — same gate, same single CAS.
 */
export async function enterReview(
  submissionId: string,
  opts: { legacy?: boolean } = {},
): Promise<{ entered: boolean; held: boolean; message: string }> {
  const sub = await loadEnteringCut(submissionId);
  if (!sub || sub.status !== "PENDING") return { entered: false, held: false, message: "Already in review." };
  const moved = !!(sub.movedAt && sub.movedFromProjectId);
  if (!moved && !sub.blobUrl) {
    return { entered: false, held: false, message: "A Final-folder cut goes to review from the editor's send-for-review check." };
  }
  const claim = await claimReviewEntry(sub.id);
  if (claim === "held") return { entered: false, held: true, message: "Waiting on the editor's check." };
  if (claim === "already" || (claim === "legacy" && !opts.legacy)) return { entered: false, held: false, message: "Already in review." };
  const r = moved ? await movedCutEntered(sub) : await uploadCutEntered(sub);
  try {
    const { ensureOutputsForProject, refreshOutputsForProject } = await import("@/lib/deliverableOutputs");
    await ensureOutputsForProject(sub.projectId);
    await refreshOutputsForProject(sub.projectId);
  } catch { /* the per-video rows re-derive on the next read */ }
  return { entered: true, held: false, message: r.message };
}

/**
 * The single compare-and-set that puts a checked cut in review.
 *   entered — this caller stamped selfCheckedAt and owns the side effects
 *   held    — no VALID check is bound (the row waits for one)
 *   already — somebody else entered it, or it is no longer PENDING
 *   legacy  — a pre-gate row with no check id (nothing stamped)
 */
export async function claimReviewEntry(submissionId: string): Promise<"entered" | "held" | "already" | "legacy"> {
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { status: true, selfCheckId: true, selfCheckedAt: true } });
  if (!sub || sub.status !== "PENDING") return "already";
  if (!sub.selfCheckId) return "legacy";
  if (sub.selfCheckedAt) return "already";
  const check = await prisma.cutSelfCheck.findUnique({ where: { id: sub.selfCheckId }, select: { state: true } });
  if (check?.state !== "VALID") return "held";
  const won = await prisma.reviewSubmission.updateMany({
    where: { id: submissionId, status: "PENDING", selfCheckedAt: null, selfCheckId: sub.selfCheckId },
    data: { selfCheckedAt: new Date() },
  });
  return won.count ? "entered" : "already";
}

/** A moved cut, checked on the job it landed on (§8.2: a move changes the
 *  output, so the check made for the old job does not travel). The same stage
 *  move the move itself used to make — and, as before, never a word about the
 *  target's own revision lane: a cut that arrived from another job is not
 *  automatically the correction to this client's ask. One announcement, keyed
 *  to the move so the cut's first trip into the Room cannot swallow it. */
async function movedCutEntered(sub: EnteringCut): Promise<{ ok: boolean; message: string }> {
  const street = (sub.project.title || "job").split(",")[0].trim();
  if (sub.project.status === "EDITING" || sub.project.status === "SHOT") {
    await prisma.project.update({ where: { id: sub.projectId }, data: { status: "REVIEW", statusPinnedAt: null } }).catch(() => {});
  }
  await prisma.activity.create({
    data: { projectId: sub.projectId, type: "SYSTEM", body: `Moved cut checked and in the Review Room — version ${sub.round}${sub.fileName ? ` (${sub.fileName})` : ""}.` },
  }).catch(() => {});
  await announceCutInReview({
    kind: "review_submitted",
    projectId: sub.projectId,
    submissionId: sub.id,
    round: sub.round,
    street,
    fileName: sub.fileName,
    editorKey: sub.submittedByKey,
    editorName: sub.submittedByName,
    dedupeSuffix: `moved-${(sub.movedAt ?? new Date()).getTime()}`,
  });
  return { ok: true, message: `Version ${sub.round} is in the Review Room.` };
}

/** The upload door's entry — moved here verbatim from finalizeCutUpload when
 *  the check gate split "the bytes landed" from "the cut is in review". */
async function uploadCutEntered(sub: EnteringCut): Promise<{ ok: boolean; message: string }> {
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
    // An upload is the editor's own status write, and a human write ends the
    // office's status pin (Sep 13, editOverrides.ts) — the pin only ever
    // holds off the engines.
    await prisma.project.update({ where: { id: sub.projectId }, data: { status: "REVIEW", statusPinnedAt: null } });
  } else {
    await correctedCutSubmitted(sub.projectId, { round: sub.round });
  }
  // The uploading editor's active stretch on this job ends with the hand-in
  // (§7.1): SUBMITTED, their item only — a co-editor on the same job keeps
  // theirs, and no other output is touched. An office upload carries no editor
  // key, so it closes nothing. Never throws.
  if (sub.submittedByKey) {
    const { closeActiveWork } = await import("@/lib/editorWork");
    await closeActiveWork(sub.projectId, {
      editorKey: sub.submittedByKey,
      // Only the stretch on THIS video (or one that named no video): a fix to
      // video 1 does not end the editor's stretch on video 3 (review fix, Sep 25).
      forOutputId: sub.outputId ?? null,
      reason: "SUBMITTED",
      actor: { userId: null, name: sub.submittedByName ?? sub.submittedByKey, role: "EDITOR" },
      detail: `version ${sub.round} submitted`,
    });
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
  // …and so does any 1080p file the Topaz pass made from an earlier round of
  // this cut (Sep 16). Without this, a v3 approval left last round's
  // "… - v2 - 1080p.mp4" sitting in Final beside the new v3 export and Kyle had
  // two files to choose from — exactly the ambiguity the naming exists to
  // avoid. Best-effort and independent of Topaz being connected at all: this
  // is a Dropbox move, not a render.
  // This cut's OWN 1080p file is excluded by supersedePriorEnhanced (it keys on
  // the cut and skips the cut's own job), which matters on the stranded-copy
  // retry below: a cut whose original failed to copy while its Topaz pass
  // succeeded would otherwise have had its finished 1080p file buried in
  // superseded/ every hour, after Kyle's card had already named the path.
  try {
    const { supersedePriorEnhanced } = await import("@/lib/topazJobs");
    await supersedePriorEnhanced({ id: sub.id, projectId: sub.projectId, deliverableId: sub.deliverableId, slot: sub.slot, assetPath: sub.assetPath });
  } catch { /* the folder tidy must never block the copy */ }
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
  // DROPBOX'S SERVERS FETCH THIS, NOT OURS (RTP-01, Sep 18). "Server-side" is
  // not the same as "authenticated" — it matters whose server does the
  // fetching, and save_url is Dropbox's. So the URL handed over has to carry
  // its own permission: on today's public store that is the object's own URL
  // and nothing changes; on a private store it is a presigned GET scoped to
  // this one pathname for six hours. The read-write token is never in it.
  //
  // Six hours because save_url is asynchronous: Dropbox answers with a job id
  // and pulls the bytes on its own schedule, and the hourly finalizeApprovedCuts
  // pass is what finishes it. A link that outlives the poll loop costs nothing;
  // one that expires mid-pull costs an approval.
  const source = await fetchableCutUrl(sub, { ttlMs: 6 * 3600_000, purpose: "dropbox save_url" });
  if (!source.ok) {
    // Same first words as a failed save_url, on purpose: the bounded-failure
    // counter above reads this prefix, so a store misconfiguration rings the
    // owner after three hours instead of writing an Activity row forever.
    await prisma.activity.create({
      data: {
        projectId: sub.projectId, type: "SYSTEM",
        body: `Dropbox could not copy the approved cut (${source.reason}) — ${source.message} It will be retried on the next hourly pass.`,
      },
    }).catch(() => {});
    return { complete: false, finalPath: sub.finalPath };
  }
  type SaveUrl = { ".tag": "complete" | "async_job_id"; async_job_id?: string };
  let r: SaveUrl;
  try {
    r = await dbx<SaveUrl>("files/save_url", { path, url: source.url });
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
  // NEVER release the bytes a 1080p pass still needs (Sep 16). A Topaz job can
  // legitimately wait days — the monthly credit cap parks one until the 1st of
  // next month — and releasing its source would turn a waiting render into a
  // dead one. A finished, failed or skipped job holds nothing. A HELD one does
  // (O02): until a person decides, the editor's upload may yet be the file the
  // ready card offers, so its bytes stay.
  const notAwaitingTopaz = {
    OR: [
      { topazJob: { is: null } },
      { topazJob: { state: { notIn: ["queued", "estimated", "uploading", "processing", "saving", "held"] } } },
    ],
  } satisfies Prisma.ReviewSubmissionWhereInput;
  let pruned = 0, failed = 0;
  // Release the row FIRST, then the bytes: a deleted blob behind a live
  // blobUrl would leave the stream route redirecting to a 404 (review).
  const release = async (id: string, blobUrl: string, assetPath: string | null) => {
    // …BUT ONLY IF WE CAN AIM THE DELETE (RTP-01, Sep 18 — handover §4).
    // `del()` deletes from the store the TOKEN names, not the store the URL
    // names, and it is idempotent about a path it cannot find. So during a
    // store cutover this function used to clear the row's pointer — the only
    // record of where those bytes were — and then delete nothing, counting it
    // as `pruned`, silently. The pointer is now only cleared once the object
    // has been matched to a token we hold; anything else is left whole and
    // counted as failed, which is the one outcome that is recoverable.
    //
    // The old plan answered this by telling a human to pull the daily cron
    // from vercel.json before the swap and put it back after. This is the same
    // safety without a person having to remember it.
    const owner = ownCutObject(blobUrl);
    if (!owner.ok || !owner.token) {
      console.error("[review] prune left a cut alone — no token owns its store", id, owner.ok ? "no-token" : owner.reason);
      failed++;
      return;
    }
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
    const gone = await deleteCutObject(blobUrl);
    if (gone.ok) pruned++; else failed++;
  };
  // 1. Approved and copied — after the retention window, the Dropbox copy is
  //    the file of record and the room streams it from there.
  const approved = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null }, completedAt: { lt: cutoff }, finalPath: { not: null }, ...notAwaitingTopaz },
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
  //    WITHDRAWN rounds join them (reviewer, Sep 16): once the right file has
  //    come in, the wrong one's bytes have no reason to sit in the store. The
  //    ROW always survives — the history of what was taken back and why is the
  //    point of a withdrawal. A withdrawn round FREES its number, so its
  //    replacement carries the SAME round: "newer" has to mean round >= for
  //    those, or a taken-back v2 replaced by a fresh v2 would never release.
  const older = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null }, deliverableId: { not: null }, status: { in: ["PENDING", "SUPERSEDED", "CHANGES_REQUESTED", WITHDRAWN] }, updatedAt: { lt: weekAgo } },
    select: { id: true, blobUrl: true, projectId: true, deliverableId: true, slot: true, round: true, status: true },
    take: 50,
  });
  for (const r of older) {
    const newer = await prisma.reviewSubmission.count({
      where: {
        projectId: r.projectId,
        deliverableId: r.deliverableId,
        slot: r.slot,
        id: { not: r.id },
        round: r.status === WITHDRAWN ? { gte: r.round } : { gt: r.round },
        // A round that was itself taken back is nobody's replacement.
        status: { notIn: [...NOT_A_CUT] },
      },
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

/** The client's ask ALONE — the state sentence a round trip put in front of it
 *  stripped off. Used when a submit is taken back (Sep 16 withdraw / move):
 *  the revision returns to the words it had before the cut claimed to answer
 *  it, never to a sentence the hub invented over the client's. */
export function revisionAskOnly(existing: string | null | undefined): string {
  return (existing ?? "").replace(REVISION_STATE_PREFIX, "").trim().slice(0, 500);
}

/** Is this row's summary one the "corrected cut submitted" hop wrote? Only
 *  those go back to OPEN on a withdrawal — an IN_PROGRESS revision a person
 *  picked up by hand is theirs, not ours to reopen. */
const WAITING_ON_REVIEW_RE = /^Corrected cut submitted — waiting on review/;

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

/** Open revision tasks on the VIDEO lane of a job.
 *
 *  `anyStatus` drops the open-only filter, for the one caller that needs the
 *  lane's IDENTITY rather than its open work: correctionStillOwed matches a
 *  RevisionBrief to the lane it was raised on, and a brief whose task has since
 *  been closed and re-raised is still that lane's brief (WF-03 follow-up). The
 *  time window around the ask is what keeps an OLD lane's brief out. */
export function videoLaneRevisionWhere(projectId: string, opts: { anyStatus?: boolean } = {}): Prisma.SmartTaskWhereInput {
  return {
    projectId,
    taskType: "revision",
    ...(opts.anyStatus ? {} : { status: { notIn: ["COMPLETED", "CANCELLED"] } }),
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
      // The editor's resubmit is a human status write, and a human write
      // ends the office's status pin (Sep 13, editOverrides.ts).
      await prisma.project.update({ where: { id: projectId }, data: { status: "REVIEW", revisionRequestedAt: null, statusPinnedAt: null } });
      status = "REVIEW";
    }
  }
  return { moved: toMove.length, status };
}

/** Jordan approved a cut. When it is newer than the client's ask it answers
 *  it: the video-lane task closes whoever holds it, and if no lane is left
 *  open the job resolves the normal way (resolveRevision — stamp cleared, a
 *  delivered job back to Delivered with the close-out and today's bells). */
/**
 * Does this job VISIBLY still owe work on the client's ask? Returns the reason
 * in words, or null when nothing says it does.
 *
 * WF-03 (audit, Sep 17-18). correctedCutApproved used to be handed a project, a
 * time and a round — never the identity of the item being satisfied — and it
 * closed the whole video lane. One card per medium is Jordan's decision (Sep 7:
 * two asks about the same video are one job of work), so the fix is not to
 * split the card; it is to stop ONE approval speaking for work nobody has done.
 *
 * The first pass at this (Sep 17) asked whether the JOB looked unfinished: was
 * another slot re-cut and not yet approved, was the work order partly ticked.
 * Jordan's verdict on it: "checking whether another correction was uploaded or
 * a checklist was partly ticked does not establish that every requested change
 * is done. Link requests to the affected videos. Fixing video 1 must not close
 * an untouched request for video 3."
 *
 * So the question is now asked PER ITEM, against the video that item is about
 * (revisionBrief.outstandingItems — scope `named` / `all` / `unknown`, and the
 * approved-since-the-ask slots). An item on a video nobody has re-cut holds the
 * ask open, which is exactly the case the old rule let through.
 *
 * The in-flight signal is kept as a second, narrower test for the asks that
 * have NO itemised work order at all (a Review Room bounce, a one-line text
 * under the analyser's threshold): a corrected cut somebody has started and not
 * landed is still work in flight, by the editor's own hand.
 *
 * Every manual close still works — the task's Complete button, the last
 * checklist tick, the project-page button — so a held card is never a trap.
 */
async function correctionStillOwed(
  projectId: string,
  raisedAt: Date,
  /** The round Jordan just ruled on — the ROW, not a pre-built key. It has to
   *  be re-keyed here into the slot space the items are scoped in, and a
   *  caller holding a cutKeyOf string cannot do that (reviewer, Sep 18). */
  approvedRound: { deliverableId?: string | null; slot?: number | null; assetPath?: string | null; id: string } | null,
  /** The video lane this approval belongs to — every task on it, open or since
   *  closed. The brief is matched to THIS lane so a photo-lane ask cannot gate
   *  a video ask (below). */
  laneTaskIds: readonly string[],
  /** CP-03: portal revision rounds still OPEN on OTHER videos of this job
   *  (their labels). The ledger says it outright, so no brief is consulted. */
  otherOpenRounds: readonly string[] = [],
): Promise<string | null> {
  if (otherOpenRounds.length > 0) {
    const names = [...new Set(otherOpenRounds)];
    return `the client's change request on ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} is still open.`;
  }
  const since = await prisma.reviewSubmission.findMany({
    where: { projectId, kind: "video", createdAt: { gte: raisedAt }, status: { notIn: ["WITHDRAWN", "UPLOAD_FAILED"] } },
    select: { deliverableId: true, slot: true, assetPath: true, id: true, status: true },
  });
  // One entry per CUT (cutKeyOf): did any round of it land an approval since
  // the ask? This is the in-flight fallback's own question and its own key
  // space — every key in it is built the same way, so it is self-consistent.
  const approvedByCut = new Map<string, boolean>();
  for (const r of since) {
    const k = cutKeyOf(r);
    approvedByCut.set(k, (approvedByCut.get(k) ?? false) || r.status === "APPROVED");
  }
  // The cut being approved right now counts as approved even if its row has not
  // been re-read yet (approveCut writes the verdict and calls straight in).
  if (approvedRound) approvedByCut.set(cutKeyOf(approvedRound), true);

  // THE BRIEF FOR THIS LANE, not for this minute (reviewer, Sep 18). A job can
  // carry an open PHOTO-lane ask and an open VIDEO-lane ask against the same
  // project.revisionRequestedAt — 1956 Wetherhill Dr already carries two briefs
  // on two different tasks — and the old lookup took the newest brief in the
  // window whatever lane it was raised on, so the photo brief's items could
  // hold the video ask open (or close it). Every one of the 17 briefs in
  // production carries a taskId, so scoping to the lane loses nothing.
  // The minute of slack absorbs the gap between stamping revisionRequestedAt
  // and writing the brief row.
  // A PORTAL brief (roundId set) is answered by its round on the ledger, per
  // video — it is not "the newest brief on the lane". Letting it stand in for
  // the whole job is how approving video 4's fix used to close video 1's ask.
  const brief = laneTaskIds.length === 0
    ? null
    : await prisma.revisionBrief.findFirst({
        where: { projectId, taskId: { in: [...laneTaskIds] }, roundId: null, createdAt: { gte: new Date(raisedAt.getTime() - 60_000) } },
        orderBy: { createdAt: "desc" },
        select: { itemsJson: true, doneJson: true },
      });
  let items: RevisionItemShape[] = [];
  let done: string[] = [];
  try { items = brief?.itemsJson ? ((JSON.parse(brief.itemsJson) as { items?: RevisionItemShape[] }).items ?? []) : []; } catch { /* unreadable analysis holds nothing up */ }
  try { done = brief?.doneJson ? (JSON.parse(brief.doneJson) as string[]) : []; } catch { /* ticks are best-effort */ }

  if (items.length > 0) {
    // Dynamic import: revisionBrief imports this module for the slot list, so a
    // static import here would close the circle.
    const { outstandingItems, outstandingReason } = await import("@/lib/revisionBrief");
    const owedKeys = (await cutSlots(projectId).catch(() => [])).map((s) => slotKeyOf(s.deliverableId, s.slot));
    // ONE KEY SPACE. The items are scoped in slot keys (briefCutsFor hands the
    // analyser slotKeyOf keys), so the approvals have to be counted in slot
    // keys too — owedSlotKeyOf, never cutKeyOf. See its header for what a
    // round with no deliverable can and cannot be resolved to.
    const approvedKeys = approvedSlotKeys(
      approvedRound ? [...since, { ...approvedRound, status: "APPROVED" }] : since,
      owedKeys,
    );
    const open = outstandingItems({ items, done, approvedKeys, owedKeys });
    return open.length > 0 ? outstandingReason(open, items.length) : null;
  }

  // No work order to reason about: fall back to work in flight.
  const waiting = [...approvedByCut.values()].filter((ok) => !ok).length;
  if (waiting > 0) {
    return `${waiting} other video${waiting === 1 ? "" : "s"} on this job ${waiting === 1 ? "has a corrected cut" : "have corrected cuts"} still waiting on a verdict.`;
  }
  return null;
}

/**
 * The per-video revision ledger around one approval (CP-03). The approved
 * video's OPEN rounds asked before this cut was made are ANSWERED by it
 * (openReviewWindow has usually done this already at release — idempotent),
 * and the answer is when this video's own ask was made plus which OTHER
 * videos still have one open. A job with no portal rounds answers
 * { null, [] } and behaves exactly as before.
 */
async function portalRoundsAt(
  projectId: string,
  cut: { id: string },
  cutCreatedAt: Date,
): Promise<{ ownAskAt: Date | null; otherOpen: string[] }> {
  const rounds = await prisma.contentRevisionRound.findMany({
    where: { projectId, state: { in: ["OPEN", "ANSWERED"] } },
    select: { id: true, videoKey: true, state: true, createdAt: true, answeredBySubmissionId: true, submissionId: true },
  }).catch(() => []);
  if (rounds.length === 0) return { ownAskAt: null, otherOpen: [] };
  const row = await prisma.reviewSubmission.findUnique({ where: { id: cut.id }, select: { id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, fileName: true } });
  if (!row) return { ownAskAt: null, otherOpen: [] };
  // Dynamic: reviewWindows imports this module for the slot list.
  const { videoKeyOf, videoLabelOf } = await import("@/lib/reviewWindows");
  const key = videoKeyOf(row);
  const answer = rounds.filter((r) => r.videoKey === key && r.state === "OPEN" && r.createdAt.getTime() <= cutCreatedAt.getTime());
  if (answer.length) {
    await prisma.contentRevisionRound.updateMany({ where: { id: { in: answer.map((r) => r.id) }, state: "OPEN" }, data: { state: "ANSWERED", answeredBySubmissionId: row.id, answeredAt: new Date() } }).catch(() => {});
  }
  const own = rounds.filter((r) => r.videoKey === key && (r.state === "OPEN" || r.answeredBySubmissionId === row.id || answer.some((a) => a.id === r.id)));
  const ownAskAt = own.length ? new Date(Math.min(...own.map((r) => r.createdAt.getTime()))) : null;
  const others = rounds.filter((r) => r.videoKey !== key && r.state === "OPEN");
  const subs = others.length ? await prisma.reviewSubmission.findMany({ where: { id: { in: [...new Set(others.map((r) => r.submissionId))] } }, select: { id: true, projectId: true, deliverableId: true, slot: true, fileName: true, round: true } }) : [];
  const otherOpen: string[] = [];
  for (const r of others) {
    const s = subs.find((x) => x.id === r.submissionId);
    otherOpen.push(s ? await videoLabelOf(s) : "another video");
  }
  return { ownAskAt, otherOpen };
}

/** The shape correctionStillOwed needs out of itemsJson. Structurally the same
 *  as revisionBrief.RevisionItem — declared here so reading a brief needs no
 *  runtime import of that module (the analyser pulls in the AI client). */
type RevisionItemShape = { id: string; ask: string; cuts?: string[] | null; scope?: "named" | "all" | "unknown" };

export async function correctedCutApproved(
  projectId: string,
  opts: {
    cutCreatedAt: Date;
    round?: number | null;
    isRedo?: boolean;
    /** WHICH CUT was approved (WF-03). The caller passes the row it just ruled
     *  on; `submissionId` is enough — the identity is looked up here so a caller
     *  that only has the round (the queue pill's "Completed") does not have to
     *  re-derive it. Without either, nothing is assumed: the items scoped to a
     *  named video all stay open, which holds the ask rather than closing it. */
    cut?: { deliverableId?: string | null; slot?: number | null; assetPath?: string | null; id: string } | null;
    submissionId?: string | null;
  },
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
  // WHICH video this approval is about. The row itself when the caller handed
  // one over, else the row it names, else nothing — and nothing is honest, not
  // permissive: an unidentified approval closes only the items no video is
  // attached to.
  const cut =
    opts.cut ??
    (opts.submissionId
      ? await prisma.reviewSubmission
          .findUnique({ where: { id: opts.submissionId }, select: { id: true, deliverableId: true, slot: true, assetPath: true } })
          .catch(() => null)
      : null);
  // THE PORTAL'S ASKS ARE PER VIDEO (CP-03). Every portal ask refreshes the
  // job's revisionRequestedAt, so a fix for video 1 cut BEFORE video 4 was
  // asked about looked "older than the ask" and closed nothing. The approved
  // video's OWN round dates its ask; rounds on OTHER videos still open hold the
  // lane (correctionStillOwed).
  const portal = cut ? await portalRoundsAt(projectId, cut, opts.cutCreatedAt) : { ownAskAt: null, otherOpen: [] as string[] };
  const askAt = portal.ownAskAt ?? raisedAt;
  if (opts.cutCreatedAt.getTime() < askAt.getTime()) return { closed: 0, resolved: false };
  if (!(await cutAnswersAsk(projectId, { round: opts.round, isRedo: opts.isRedo, deliveredAt: project.deliveredAt }))) return { closed: 0, resolved: false };
  // This approval answers the work it answers — not the whole conversation,
  // and not the other lane's. The lane is handed over with its CLOSED tasks
  // too: the brief belongs to the lane it was raised on, and a task that was
  // closed and re-raised inside the same ask is still this lane (the time
  // window is what keeps an older ask's brief out).
  const laneTaskIds = (
    await prisma.smartTask
      .findMany({ where: videoLaneRevisionWhere(projectId, { anyStatus: true }), select: { id: true } })
      .catch(() => lane.map((t) => ({ id: t.id })))
  ).map((t) => t.id);
  const owed = await correctionStillOwed(projectId, raisedAt, cut, laneTaskIds, portal.otherOpen);
  if (owed) {
    await prisma.activity
      .create({ data: { projectId, type: "SYSTEM", body: `Corrected cut approved. The revision stays open: ${owed}`.slice(0, 500) } })
      .catch(() => {});
    return { closed: 0, resolved: false };
  }
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
// TAKING A CUT BACK (Jordan, Sep 16): "I want the editor to be able to remove
// the video from upload / for review in case they mistakenly upload the wrong
// video or to the wrong project. It would also be cool if they could reassign
// that video to a different project."
//
// A withdrawal is the EXACT INVERSE of the submit, and a move is a withdrawal
// on the job the cut left. Both run correctedCutWithdrawn() below, so the one
// place that knows how a submit moved the revision and the stage is the one
// place that knows how to move them back. Nothing is deleted: the row, the
// blob and any Dropbox file all stay (see WITHDRAWN at the top of this file).
// ===========================================================================

/** The line the ask carries when a withdrawal leaves it with no words of its
 *  own (a hub-minted revision whose whole summary was the state sentence). */
const WITHDRAWN_ASK_SUMMARY = "The corrected cut was taken back — this is still waiting on a new version.";

/**
 * A cut has LEFT this job — withdrawn, or moved to another one. Undo what the
 * submit did to the job, and nothing else:
 *   · a client's video-lane revision the submit parked "waiting on review"
 *     goes back to OPEN with its own ask line intact (revisionAskOnly);
 *   · a job the cut had moved to REVIEW steps back to where it stood — REVISION
 *     when an ask is open (the stamp restored to the ask's own age, so the
 *     status engine keeps honouring it), else EDITING.
 * NEVER touched: a job whose status a human pinned (statusPinnedAt — the
 * office's override is not ours to undo, Sep 13), a DELIVERED job (the client
 * has the work; a withdrawal upstream doesn't un-deliver it), and a job whose
 * every owed cut is already approved (it is waiting on Kyle, not on an editor).
 * `excludeSubmissionId` is the row being taken back — it may not have been
 * written yet when this runs.
 *
 * ONE THING THIS DELIBERATELY DOES NOT UNDO (reviewer, Sep 16). Pulling an
 * APPROVED cut does NOT re-open the client revision that the approval closed,
 * and does not re-open the edit card approveCut completed when the last owed
 * cut came in: only an IN_PROGRESS row still carrying the "waiting on review"
 * sentence comes back, and correctedCutApproved/resolveRevision COMPLETED that
 * row, cleared the stamp, re-delivered a delivered job and rang the close-out
 * bells. Re-running all of that backwards would tell the client's lane and
 * Kyle's delivery a second, contradictory story. So: when the office pulls a
 * cut Jordan had already signed off, the client's ask stays CLOSED and the
 * withdraw message says so — whoever pulled it re-raises the revision if the
 * client still needs the fix.
 */
export async function correctedCutWithdrawn(
  projectId: string,
  opts: { excludeSubmissionId?: string | null } = {},
): Promise<{ reopened: number; status: string | null }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, statusPinnedAt: true, deliveredAt: true, revisionRequestedAt: true },
  });
  if (!project) return { reopened: 0, status: null };

  // 1. The client's ask goes back to OPEN, in the client's own words.
  const parked = await prisma.smartTask.findMany({
    where: { ...videoLaneRevisionWhere(projectId), status: "IN_PROGRESS" },
    select: { id: true, summary: true, createdAt: true },
  });
  const mine = parked.filter((t) => WAITING_ON_REVIEW_RE.test(t.summary ?? ""));
  for (const t of mine) {
    await prisma.smartTask.update({
      where: { id: t.id },
      data: { status: "OPEN", summary: revisionAskOnly(t.summary) || WITHDRAWN_ASK_SUMMARY },
    }).catch(() => {});
  }

  // 2. The stage. Only a job the submit had put in REVIEW is ours to step back,
  //    and only once no other cut is still waiting on a verdict.
  let status: string = project.status;
  if (project.status === "REVIEW" && !project.statusPinnedAt && !project.deliveredAt) {
    const stillWaiting = await prisma.reviewSubmission.count({
      where: {
        projectId,
        status: "PENDING",
        ...(opts.excludeSubmissionId ? { id: { not: opts.excludeSubmissionId } } : {}),
      },
    });
    const owed = (await cutSlots(projectId).catch(() => [])).length;
    const approved = await approvedCutCount(projectId).catch(() => 0);
    // Everything owed is approved → the job really is past review; leave it.
    if (stillWaiting === 0 && !(owed > 0 && approved >= owed)) {
      const openAsks = await prisma.smartTask.findMany({
        where: videoLaneRevisionWhere(projectId), // already excludes COMPLETED/CANCELLED
        select: { createdAt: true },
      });
      if (openAsks.length > 0) {
        // Back to Revisions, with the stamp the submit cleared restored to the
        // ask's own age — a fresh `new Date()` here would reset its SLA and
        // make a three-day-old ask look like it arrived this minute.
        const raisedAt =
          project.revisionRequestedAt ?? new Date(Math.min(...openAsks.map((t) => t.createdAt.getTime())));
        await prisma.project.update({
          where: { id: projectId },
          data: { status: "REVISION", revisionRequestedAt: raisedAt },
        }).catch(() => {});
        status = "REVISION";
      } else {
        // SHOT, not EDITING (§7.1, Sep 25): a withdrawal is the office taking
        // a cut back, and nobody has started the redo — EDITING here read as
        // "someone is in the edit" on every surface. SHOT is Ready for editing,
        // and the sweep's shootHappened guard keeps it off Scheduled/Booked.
        await prisma.project.update({ where: { id: projectId }, data: { status: "SHOT" } }).catch(() => {});
        status = "SHOT";
      }
    }
  }
  return { reopened: mine.length, status };
}

/** Where a moved cut lands on the job it is going to: the first cut slot with
 *  no live version; failing that the first slot that is NOT already approved
 *  (the move is still legible — the message names the cut it landed on and the
 *  office can move it again). The round is the target's own newest round for
 *  that slot + 1, counting a withdrawn round too so a move never reuses a
 *  number the target already spent. Slots come from cutSlots(), so the
 *  office's "videos owed" override (effectiveSlotCounts, Sep 13) decides how
 *  many there are here too.
 *
 *  Two refusals, both in the caller's plain words: `no-video` (nothing on the
 *  order for a cut to become) and `all-approved` (reviewer, Sep 16: landing a
 *  PENDING round on a slot Jordan has already signed off dropped that job's
 *  approved count, re-opened the deliver gate and made every surface read a
 *  finished cut as "waiting review" — a sentence in the success message was
 *  never going to be enough). */
export type CutMoveTarget = { deliverableId: string; slot: number; label: string; round: number; freeSlot: boolean };
export type CutMovePick = { ok: true; target: CutMoveTarget } | { ok: false; reason: "no-video" | "all-approved" };
export async function pickCutSlotForMove(projectId: string): Promise<CutMovePick> {
  const slots = await cutSlots(projectId).catch(() => [] as CutSlot[]);
  if (slots.length === 0) return { ok: false, reason: "no-video" };
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, deliverableId: { not: null }, status: { notIn: [...NOT_A_CUT] } },
    orderBy: { round: "asc" },
    select: { deliverableId: true, slot: true, status: true },
  });
  const taken = new Set(rows.map((r) => `${r.deliverableId}:${r.slot}`));
  // The LAST word on each slot — an approved slot is finished work.
  const verdict = new Map<string, string>();
  for (const r of rows) verdict.set(`${r.deliverableId}:${r.slot}`, r.status);
  const free = slots.find((s) => !taken.has(`${s.deliverableId}:${s.slot}`));
  const pick = free ?? slots.find((s) => verdict.get(`${s.deliverableId}:${s.slot}`) !== "APPROVED");
  if (!pick) return { ok: false, reason: "all-approved" };
  const highest = await prisma.reviewSubmission.aggregate({
    where: { projectId, deliverableId: pick.deliverableId, slot: pick.slot, status: { not: "UPLOAD_FAILED" } },
    _max: { round: true },
  });
  return {
    ok: true,
    target: {
      deliverableId: pick.deliverableId,
      slot: pick.slot,
      label: pick.label,
      round: (highest._max.round ?? 0) + 1,
      freeSlot: !!free,
    },
  };
}

/** The round a withdrawal UN-supersedes. finalizeCutUpload flips the previous
 *  PENDING round of a cut to SUPERSEDED the moment a newer one lands; if that
 *  newer round is now taken back, the one it replaced is again the newest
 *  version anybody stands behind and goes back to the Room where it was
 *  (reviewer, Sep 16 — without this the cut that WAS waiting on Jordan left the
 *  queue, the editor tally and videoStatesFor for good, and "exactly what it
 *  was before" was not true). Only when nothing newer is live on the slot.
 *  Returns the restored round, or null. */
export async function restorePriorCutRound(
  projectId: string,
  cut: { id: string; deliverableId: string | null; slot: number | null; round: number },
): Promise<number | null> {
  // Legacy folder rows never supersede one another — only an uploaded cut,
  // which always carries both a deliverable and a slot.
  const { deliverableId, slot } = cut;
  if (!deliverableId || slot == null) return null;
  const newer = await prisma.reviewSubmission.count({
    where: {
      projectId,
      deliverableId,
      slot,
      id: { not: cut.id },
      round: { gte: cut.round },
      status: { notIn: [...NOT_A_CUT, "SUPERSEDED"] },
    },
  });
  if (newer > 0) return null;
  const prior = await prisma.reviewSubmission.findFirst({
    where: { projectId, deliverableId, slot, round: { lt: cut.round }, status: "SUPERSEDED" },
    orderBy: { round: "desc" },
    select: { id: true, round: true },
  });
  if (!prior) return null;
  await prisma.reviewSubmission.update({ where: { id: prior.id }, data: { status: "PENDING" } }).catch(() => {});
  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body: `Version ${prior.round} is back in the Review Room — the version that replaced it was taken back.` },
  }).catch(() => {});
  return prior.round;
}

/** The cut has left this job — put the editor's work item back if the job owes
 *  a video again and nobody holds one.
 *
 *  BLOCKER, reviewer Sep 16: finalizeCutUpload COMPLETES the editor's
 *  edit_video card at SUBMIT time, and uploadAuthor / submitCutForReview both
 *  refuse an EDITOR with no open edit_video or revision on their key. So an
 *  editor who took their own wrong upload back had no door left — the whole
 *  point of Jordan's ask dead-ended on a one-video job. The hourly self-heal
 *  makes the same write (ensureEditorHandoff step 5); this makes it immediate.
 *
 *  The close it undoes is `owed <= 1 || distinct >= owed`, so this is its exact
 *  inverse: a set that is still all in stays closed. Never touches a DELIVERED
 *  or CANCELLED job, and never adds a second card to a job whose editor already
 *  holds one (Jordan's one-card-per-cut rule). */
export async function reopenEditCardAfterTakeBack(
  projectId: string,
  editorKey: string | null,
): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true } });
  if (!project || project.status === "DELIVERED" || project.status === "CANCELLED") return false;
  const owed = (await cutSlots(projectId).catch(() => [])).length;
  if (owed === 0) return false;
  if ((await submittedDistinctCuts(projectId)) >= owed) return false;
  const held = await prisma.smartTask.count({
    where: {
      projectId,
      taskType: { in: ["edit_video", "revision"] },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      // The editor who sent the cut in is the one who needs a door back; with
      // no key (an office upload) any open work item means the job is covered.
      ...(editorKey ? { assignedKey: editorKey } : {}),
    },
  });
  if (held > 0) return false;
  const card = await prisma.smartTask.findUnique({
    where: { dedupeKey: `edit-video-${projectId}` },
    select: { id: true, status: true },
  });
  // Only a COMPLETED card comes back — a CANCELLED one was killed on purpose.
  if (card?.status !== "COMPLETED") return false;
  await prisma.smartTask.update({ where: { id: card.id }, data: { status: "OPEN", completedAt: null } }).catch(() => {});
  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body: "Edit task reopened — the cut was taken back, so the video is owed again." },
  }).catch(() => {});
  return true;
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
  p: { packageName: string | null; videosFilmed: number | null; videosOwedOverride: number | null; deliverables: { id: string; type: string; label: string | null; quantity: number | null; videoStyle: string | null; productTitle: string | null; waivedAt?: Date | null }[] },
  monthly: boolean,
  quota: number,
  tier: "standard" | "premium" | null,
) => {
  const vids = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  // Same rule as cutSlots(): the hub's count per row, the office's total over
  // it (Sep 13, editOverrides.effectiveSlotCounts).
  const baseCounts = vids.map((d, i) => {
    let count = Math.max(1, d.quantity ?? 1);
    if (monthly && i === 0) count = Math.max(count, p.videosFilmed ?? quota);
    return count;
  });
  const counts = effectiveSlotCounts(p, baseCounts);
  const out: CutSlot[] = [];
  for (const [i, d] of vids.entries()) {
    const count = counts[i];
    // Waived after the counts, exactly as cutSlots does it — the office's
    // total is split by row position, so the row has to keep its place.
    if (d.waivedAt) continue;
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
  // Who has pressed Start (§7.1) — the one reader every "is anyone editing
  // this" answer shares. A failed read means nobody is claimed as active.
  const { workStateFor, workClock } = await import("@/lib/editorWork");
  const [projects, subs, editTasks, notes, work] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: {
        id: true, title: true, status: true, packageName: true, videosFilmed: true, statusEvidence: true,
        videosOwedOverride: true, // the office's batch size (Sep 13)
        client: { select: { name: true, avatarUrl: true } },
        // Same order as cutSlots() — the monthly batch count lands on the FIRST
        // video row, so both slot builders must see the rows the same way.
        deliverables: { where: { removedFromOrderAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, type: true, label: true, quantity: true, videoStyle: true, productTitle: true, waivedAt: true } },
      },
    }),
    prisma.reviewSubmission.findMany({
      where: { projectId: { in: projectIds }, status: { in: ["PENDING", "CHANGES_REQUESTED", "APPROVED"] } },
      orderBy: { round: "asc" },
      select: { id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, assetUrl: true, fileName: true, round: true, status: true, createdAt: true, decidedAt: true, submittedByKey: true, submittedByName: true, selfCheckId: true, selfCheckedAt: true },
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
    workStateFor(projectIds).catch(() => new Map<string, import("@/lib/editorWork").ProjectWork>()),
  ]);
  const notesByAsset = new Map(notes.map((n) => [n.assetUrl, n._count]));
  const editByProject = new Map(editTasks.map((t) => [t.projectId, t.assignedKey]));
  const subsByProject = new Map<string, typeof subs>();
  const { isHeldForSelfCheck } = await import("@/lib/selfCheck");
  for (const s of subs) {
    // A version still waiting on its editor's check (§8.2) is not waiting on
    // the reviewer — the cut reads as wherever its last handed-in version
    // left it, and the Review Room lists the held one on its own.
    if (isHeldForSelfCheck(s)) continue;
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
      // "In editing" only when an editor has pressed Start (§7.1, Sep 25 —
      // the work layer, not Project.status: EDITING stays set through a
      // pause, an office pin, a board move). Paused work, part of a batch
      // handed in, or a legacy EDITING nobody confirmed are still the editing
      // stage, in their own words below. An open edit card on its own is
      // footage waiting for the editor — Kyle's QC card read "Video: In
      // editing — John Mark" for a job nobody had opened (Jordan, Sep 10).
      else if (work.has(p.id) || p.status === "EDITING" || cuts.length > 0) stage = "editing";
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
      stage === "editing" ? editingDetail(work.get(p.id), { uploaded: cuts.length, owed, approved, legacy: p.status === "EDITING", editor: editByProject.get(p.id) ?? null, done, clock: workClock }) :
      stage === "ready_to_edit" ? `Ready for editing${editByProject.get(p.id) ? ` — ${prettyKey(editByProject.get(p.id) as string)}` : ""}${done}` :
      "Not started — no cut uploaded yet";
    out.set(p.id, { projectId: p.id, owed, approved, waiting, revising, uploaded: cuts.length, stage, detail, cuts });
  }
  return out;
}

/** The editing stage in words (§7.1). "In editing" only for somebody ACTIVE. */
function editingDetail(
  w: import("@/lib/editorWork").ProjectWork | undefined,
  o: { uploaded: number; owed: number; approved: number; legacy: boolean; editor: string | null; done: string; clock: (iso: string | null) => string },
): string {
  const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(", ");
  if (w?.active.length) {
    const since = w.active.length === 1 && w.active[0].sinceISO ? ` since ${o.clock(w.active[0].sinceISO)}` : "";
    return `In editing — ${names(w.active)}${since}${o.done}`;
  }
  if (w?.paused.length) return `Paused — ${names(w.paused)}${o.done}`;
  const who = o.editor ? ` — ${prettyKey(o.editor)}` : "";
  if (o.uploaded > 0) return `${o.uploaded} of ${o.owed} handed in${o.approved ? ` · ${o.approved} approved` : ""}${who}`;
  return o.legacy ? `In editing — not confirmed${who}${o.done}` : `Ready for editing${who}${o.done}`;
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
