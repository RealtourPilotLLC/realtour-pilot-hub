"use server";

import { requireDeliverableAccess, requireShootAccess, requireUploadFileAccess } from "@/lib/auth/guards";

import { prisma } from "@/lib/prisma";
import { NOTHING_TO_REMOVE_SENTINEL, FRONT_TO_BACK_SENTINEL, INTERIOR_EXTERIOR_SENTINEL } from "@/lib/debrief";
import {
  ADD_TO_ORDER_PREFIX,
  shootAddonKey,
  shootAddonKeyPrefix,
  streetOf,
  type ShootAddOn,
} from "@/app/upload/shootAddOns";
import { revalidatePath } from "next/cache";
import { ProjectStatus, DeliverableStatus, ActivityType } from "@prisma/client";
import { saveUpload, deleteFile } from "@/lib/storage";

// Provenance marker for a script the photographer typed on site (no Script
// Studio draft existed). Kept as a constant so the re-submit guard and the
// portal's re-open both key off the same string.
const PROVIDED_ON_SITE = "Provided on site";

/** Save one or more files, optionally tied to a deliverable, and mark it uploaded. */
export async function uploadFiles(
  projectId: string,
  deliverableId: string | null,
  formData: FormData,
) {
  await requireShootAccess(projectId);
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  const created = [];
  for (const file of files) {
    if (file.size === 0) continue;
    const meta = await saveUpload(projectId, file);
    const row = await prisma.uploadedFile.create({
      data: {
        projectId,
        deliverableId: deliverableId ?? undefined,
        originalName: meta.originalName,
        storedPath: meta.storedPath,
        size: meta.size,
        mimeType: meta.mimeType,
      },
    });
    created.push({ id: row.id, originalName: row.originalName, size: row.size });
  }

  if (deliverableId && created.length) {
    await prisma.deliverable.update({
      where: { id: deliverableId },
      data: { status: DeliverableStatus.UPLOADED },
    });
  }

  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return created;
}

export async function removeUpload(fileId: string) {
  await requireUploadFileAccess(fileId);
  const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
  if (!file) return;
  await deleteFile(file.storedPath);
  await prisma.uploadedFile.delete({ where: { id: fileId } });
  revalidatePath(`/upload/${file.projectId}`);
  revalidatePath(`/projects/${file.projectId}`);
}

/**
 * Tick a deliverable off the upload checklist. Photographers upload to Dropbox
 * directly (no in-app files), so this is the accountability signal that the raw
 * files for this item are in. Also nudges the deliverable status to UPLOADED so
 * the rest of the pipeline reflects it immediately.
 */
export async function markDeliverableUploaded(
  deliverableId: string,
  uploaded: boolean,
): Promise<{ ok: boolean }> {
  await requireDeliverableAccess(deliverableId);
  const d = await prisma.deliverable.findUnique({ where: { id: deliverableId }, select: { projectId: true, status: true } });
  if (!d) return { ok: false };
  await prisma.deliverable.update({
    where: { id: deliverableId },
    data: {
      uploadedAt: uploaded ? new Date() : null,
      // Marking it uploaded supersedes an earlier "couldn't complete" answer.
      ...(uploaded ? { notCompletedReason: null, notCompletedAt: null } : {}),
      // Only move PENDING → UPLOADED on tick; never downgrade work already in
      // progress / done, and clearing the tick leaves the status alone.
      ...(uploaded && d.status === DeliverableStatus.PENDING ? { status: DeliverableStatus.UPLOADED } : {}),
    },
  });
  revalidatePath(`/upload/${d.projectId}`);
  revalidatePath(`/projects/${d.projectId}`);
  return { ok: true };
}

/**
 * The wrap-up's "couldn't complete this" answer (Jordan, Sep 1 2026): the
 * photographer marks a deliverable NOT completed with the reason, so the Admin
 * sees WHY instead of a bare unchecked box. Lands on the project timeline as a
 * FLAG and on Kyle's /ops QC card; marking the item uploaded later clears it.
 * Pass an empty reason to withdraw the mark.
 */
export async function markDeliverableNotCompleted(
  deliverableId: string,
  reason: string,
): Promise<{ ok: boolean; message?: string }> {
  await requireDeliverableAccess(deliverableId);
  const d = await prisma.deliverable.findUnique({
    where: { id: deliverableId },
    select: { projectId: true, type: true, label: true, status: true, notCompletedReason: true },
  });
  if (!d) return { ok: false };
  const trimmed = reason.trim().slice(0, 500);
  if (!trimmed) {
    // Withdraw: back to a plain "not yet" row.
    await prisma.deliverable.update({
      where: { id: deliverableId },
      data: { notCompletedReason: null, notCompletedAt: null },
    });
    revalidatePath(`/upload/${d.projectId}`);
    revalidatePath(`/projects/${d.projectId}`);
    return { ok: true };
  }
  // A DONE deliverable was already delivered to the client — "couldn't
  // complete" is the wrong tool (and nulling its uploadedAt would corrupt the
  // record). Flag a problem instead.
  if (d.status === DeliverableStatus.DONE) {
    return { ok: false, message: "This item is already delivered — use “Flag a problem” instead." };
  }
  await prisma.deliverable.update({
    where: { id: deliverableId },
    data: {
      notCompletedReason: trimmed,
      notCompletedAt: new Date(),
      uploadedAt: null,
      // Mirror of the tick's PENDING→UPLOADED promote: a mis-tap that promoted
      // the status must not leave "Uploaded" contradicting the saved reason
      // on the next page load (review).
      ...(d.status === DeliverableStatus.UPLOADED ? { status: DeliverableStatus.PENDING } : {}),
    },
  });
  // The Admin-visible trail — only when the reason actually changed, so a
  // re-opened portal doesn't stack duplicate timeline rows.
  if (d.notCompletedReason !== trimmed) {
    const { DELIVERABLE_META } = await import("@/lib/pipeline");
    const { NOT_COMPLETED_FLAG_PREFIX } = await import("@/lib/debrief");
    const label = d.label ?? DELIVERABLE_META[d.type]?.label ?? d.type;
    await prisma.activity.create({
      data: { projectId: d.projectId, type: ActivityType.FLAG, body: `${NOT_COMPLETED_FLAG_PREFIX}${label}: ${trimmed}` },
    }).catch(() => {});
  }
  revalidatePath(`/upload/${d.projectId}`);
  revalidatePath(`/projects/${d.projectId}`);
  return { ok: true };
}

// One-time acknowledgment of the new upload process (the /upload/welcome
// page's "I agree"). Keyed per user; /upload gates photographers on it.
export async function acknowledgeUploadProcess(): Promise<{ ok: boolean }> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  if (!me?.email) return { ok: false };
  // "View as" is read-only EVERYWHERE — an owner previewing a photographer's
  // welcome page must not satisfy that photographer's one-time acknowledgment.
  if (me.impersonating) return { ok: false };
  const key = `upload-ack-${me.email.toLowerCase()}`;
  const value = new Date().toISOString();
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return { ok: true };
}

// Post-job feedback on the upload PROCESS itself — the hub's own portal, not
// the shoot ("How was this upload process? Anything we should change?"). This
// is the ONE photographer surface that really is a product note, so it goes to
// the Feedback & requests board the same way the floating widget does, as a
// plain "feedback" row. Shoot problems go to the job — see flagIssue below.
export async function submitUploadFeedback(projectId: string, body: string): Promise<{ ok: boolean }> {
  await requireShootAccess(projectId);
  const trimmed = body.trim().slice(0, 2000);
  if (!trimmed) return { ok: false };
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } });
  const street = (project?.title || "a job").split(",")[0].trim();
  const { submitPlatformFeedback } = await import("@/app/feedback/actions");
  // Reuses the board's own pipeline (session identity, owner email, Slack, bell)
  // instead of a second hand-rolled writer that drifts from it.
  const r = await submitPlatformFeedback({
    kind: "feedback",
    title: `Upload process — ${street}`,
    body: `${trimmed}${project?.title ? `\n\nAfter the job: ${project.title}` : ""}`,
    page: `/upload/${projectId}`,
  });
  return { ok: r.ok };
}

// "Flag a problem" on the wrap-up page — a problem from the JOB (access,
// weather, a deliverable they couldn't get), written down while it's fresh.
// Feedback about the shoot, so: project timeline + an ops loop for Kyle. It
// does NOT go to the Feedback & requests board; a lockbox code is not a
// shippable update (Jordan, Sep 2).
// The home's size, set by the person standing in it. Square footage decides the
// culling tier (photoRangeFor), and Aryeo carries one on just 7 of 1,701
// listings — so without this the target on the page is the smallest tier,
// "aim for 35-45", on every home regardless of size.
//
// Aryeo still wins when it has a number: the hourly sync overwrites this the
// moment somebody fills the listing's building.square_feet. Photographer-set
// values are the floor, not a fight.
export async function setProjectSquareFeet(
  projectId: string,
  squareFeet: number | null,
): Promise<{ ok: boolean; message?: string }> {
  await requireShootAccess(projectId);
  if (squareFeet != null && (!Number.isFinite(squareFeet) || squareFeet < 100 || squareFeet > 60_000)) {
    return { ok: false, message: "That doesn't look like a square footage — enter the finished living area, e.g. 2400." };
  }
  const value = squareFeet == null ? null : Math.round(squareFeet);
  const before = await prisma.project.findUnique({ where: { id: projectId }, select: { squareFeet: true } });
  if (before?.squareFeet === value) return { ok: true };
  await prisma.project.update({ where: { id: projectId }, data: { squareFeet: value } });
  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.NOTE,
      body: value == null
        ? "Square footage cleared on the upload page — the photo target falls back to the default range."
        : `Square footage set to ${value.toLocaleString("en-US")} sq ft on the upload page — the photo target now follows that size tier.`,
    },
  }).catch(() => {});
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function flagIssue(projectId: string, body: string) {
  await requireShootAccess(projectId);
  const trimmed = body.trim();
  if (!trimmed) return;
  await prisma.activity.create({
    data: { projectId, type: ActivityType.FLAG, body: trimmed },
  });
  const { fileFieldIssue } = await import("@/lib/fieldIssues");
  await fileFieldIssue({ projectId, note: trimmed, page: `/upload/${projectId}`, label: "Shoot issue" });
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
}

// The photographer's debrief on how the shoot went. "issues" routes it to ops
// as a FLAG + Kyle's loop for the job; "smooth" just logs a note on the timeline.
export async function submitAppointmentFeedback(
  projectId: string,
  wentWell: boolean,
  note: string,
): Promise<{ ok: boolean; message: string }> {
  await requireShootAccess(projectId);
  const trimmed = note.trim();
  const body = `Shoot debrief — ${wentWell ? "went smoothly" : "had issues"}${trimmed ? `: ${trimmed}` : "."}`;
  await prisma.activity.create({
    data: { projectId, type: wentWell ? ActivityType.NOTE : ActivityType.FLAG, body },
  });
  if (!wentWell) {
    // The job's ONE field-flag loop (fieldIssues.ts) — the same row the
    // "Flag a problem" box above writes to. This used to upsert its own
    // `shoot-issue-<projectId>` task with no assignee, so a photographer who
    // flagged a problem on site AND answered "had issues" here gave Kyle two
    // cards for one incident, one of them in the "Needs assigning" pile
    // (1946 Rowan St, Sep 4). Now the debrief appends to the loop, re-raises
    // the Slack ping + the bell, and stays on the job: a shoot debrief is not
    // a product request (Jordan, Sep 2).
    const { fileFieldIssue } = await import("@/lib/fieldIssues");
    await fileFieldIssue({
      projectId,
      note: trimmed || "Photographer flagged an issue on the shoot.",
      page: `/upload/${projectId}`,
      label: "Shoot debrief",
      priority: "HIGH", // back from the property and wrapping up — not on-site urgent
    });
  }
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: wentWell ? "Thanks — logged." : "Logged and flagged for Kyle." };
}

/**
 * Finalize the guided upload: save the editor brief + per-item notes, advance the
 * project to "Shot / Uploaded", generate the editor PDF into the project folder,
 * and log it on the timeline.
 */
export async function finalizeUpload(
  projectId: string,
  data: {
    editorBrief: string;
    itemNotes?: Record<string, string>;
    force?: boolean;
    // Shoot-debrief fields (upload portal rebuild, Aug 31 2026). The job is
    // not done until these are answered — enforced HERE, not just in the UI.
    cullingConfirmed?: boolean;
    // mode is the new three-way answer; frontToBack kept so a pre-update tab's
    // payload still lands correctly (deploy-skew lesson from the last review).
    shotOrder?: { mode?: "front-to-back" | "interior-exterior" | "out-of-order"; frontToBack?: boolean; notes?: string } | null;
    removalNotes?: string;
    nothingToRemove?: boolean;
    videoInstructions?: string;
    scriptConfirm?: { state: "as-written" | "edited"; script?: string; note?: string } | null;
    /** whether the page the photographer submitted from actually SHOWED a script */
    sawScript?: boolean;
    // Package-scoped requirements (Jordan, Sep 1). Key ABSENT = a pre-update
    // tab (or a package that doesn't use it) — never trap those; null =
    // unanswered on the new page — block with the real message.
    /** agent-intro packages: the intro script typed exactly as delivered */
    introScript?: string | null;
    /** monthly plans: how many videos the photographer actually filmed */
    videosFilmed?: number | null;
    /** premium packages with no Studio script: the script typed on site */
    providedScript?: string | null;
  },
): Promise<{ pdfPath?: string; needsConfirm?: boolean; warning?: string; blocked?: string }> {
  await requireShootAccess(projectId);
  // First finalize or a re-submit? The raws-landed handoff below only fires on
  // the FIRST completed upload (the transition), never on edits/re-submits.
  const prior = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      uploadedAt: true,
      title: true,
      addressLine: true,
      shootDate: true,
      createdAt: true,
      dropboxFolder: true,
      cullingConfirmedAt: true,
      debriefSubmittedAt: true,
      shotOrderNotes: true,
      removalNotes: true,
      videoInstructions: true,
      videosFilmed: true,
      scriptConfirmedAt: true,
      scriptConfirmNote: true,
      reelScript: true,
      client: { select: { name: true } },
      packageName: true,
      // Canceled lines must not drive the gates (review HIGH).
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, notCompletedReason: true } },
    },
  });
  const firstFinalize = !prior?.uploadedAt;
  // A deliverable marked "couldn't complete + why" is EXCUSED from the gates —
  // demanding video instructions for a reel the agent canceled on site forces
  // the photographer to fabricate answers (review HIGH). The reason itself is
  // already on the Admin's QC card / timeline for a human to resolve.
  const liveDeliverables = (prior?.deliverables ?? []).filter((d) => !d.notCompletedReason);
  const anyVideoOrdered = liveDeliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");

  // ---- The debrief gates (Jordan, Aug 31): the job is not done until the
  // cull is confirmed, removal notes are answered, and video jobs carry the
  // editor's instructions + a confirmed script. Prior answers survive
  // re-submits — nobody re-types a form to fix a typo in the brief.
  // Gates apply to the FIRST finalize only — a job already submitted once
  // (or delivered weeks ago and re-opened for a brief tweak) keeps its prior
  // answers and never demands retroactive debrief data (review finding).
  if (prior && firstFinalize) {
    const wantsPhotosGate = liveDeliverables.some((d) => ["PHOTOS", "DRONE", "TWILIGHT"].includes(d.type));
    const wantsVideoGate = liveDeliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    if (wantsPhotosGate && !data.cullingConfirmed && !prior.cullingConfirmedAt) {
      return { blocked: "Run your cull and confirm all four checks first — hero shots in, duplicates out, extras in Backup Photos. Clearly unnecessary photos can carry a $1 production charge; photos a property genuinely needed are never charged." };
    }
    if (wantsPhotosGate && data.shotOrder === undefined && !prior.shotOrderNotes) {
      // Key ABSENT = a pre-update page still open on their phone — an error
      // naming a step their screen doesn't have is a trap. (The new page
      // always sends the key: null when unanswered.)
      return { blocked: "The upload page just got new steps — refresh this page, then submit." };
    }
    if (wantsPhotosGate && data.shotOrder === null && !prior.shotOrderNotes) {
      return { blocked: "Answer the shot order — front to back, or tell us the order you shot the home (so nobody has to guess what's where)." };
    }
    {
      const mode = data.shotOrder ? data.shotOrder.mode ?? (data.shotOrder.frontToBack ? "front-to-back" : "out-of-order") : null;
      if (wantsPhotosGate && mode === "out-of-order" && !data.shotOrder?.notes?.trim() && !prior.shotOrderNotes) {
        return { blocked: "You said the shoot went out of order — tell us why and the order you shot, so the office can organize the gallery without guessing." };
      }
    }
    if (wantsPhotosGate && !data.removalNotes?.trim() && !data.nothingToRemove && !prior.removalNotes) {
      return { blocked: "Answer the removal notes — list anything the editor needs to remove (pets, cans, vehicles, clutter), or tick “Nothing needs removal.”" };
    }
    // What this order's video step demands — computed from LIVE lines only
    // (canceled items filtered in the query; excused deliverables filtered
    // here), mirroring the client so the two can never disagree.
    const { videoStepSpec } = await import("@/lib/pipeline");
    const { videoTier } = await import("@/lib/projectStatus");
    const { isMonthlyContentJob } = await import("@/lib/pipeline");
    const spec = videoStepSpec(
      [prior.packageName, ...prior.orderItems.map((i) => i.title), ...liveDeliverables.map((d) => d.label)],
      {
        hasFullVideo: liveDeliverables.some((d) => d.type === "VIDEO"),
        isPremium: videoTier(liveDeliverables) === "premium",
        isMonthly: isMonthlyContentJob(liveDeliverables, prior.packageName),
      },
    );
    // A plain social reel demands no brief at all (Jordan: "if it's a standard
    // social reel, it doesn't need additional notes").
    if (wantsVideoGate && !spec.minimalReel && !prior.videoInstructions) {
      // Strip the auto-added STYLE / COLOR PROFILE lines and section labels —
      // the gate demands the photographer's OWN words, not machine boilerplate
      // (review: the color-profile line vacuously satisfied a bare check).
      // COLOR PROFILE is matched by PREFIX on purpose: the line follows the
      // video tier ("COLOR PROFILE: iPhone" for standard, "COLOR PROFILE:
      // S-Log3, D-LogM" for premium — Jordan, Sep 2; composed in
      // UploadPortal.tsx), and either one must count as boilerplate here.
      const meaningful = (data.videoInstructions ?? "")
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t && !/^STYLE:/.test(t) && !/^COLOR PROFILE:/.test(t) &&
            !["VISION FOR THE EDIT", "SUMMARY", "SHOTS THAT MUST BE SHOWN", "AREAS TO AVOID", "THINGS TO AVOID", "REALTOR REQUESTS", "ADDITIONAL NOTES", "INTRO SCRIPT", "EDITING NOTES"].includes(t);
        })
        .join("")
        .trim();
      if (!meaningful) {
        return {
          blocked: spec.requireIntro && !spec.fullBrief
            ? "The agent's intro script can't be left blank — type it exactly as it was delivered on camera."
            : "Video instructions are required — the flow and your vision for the edit. This can't be left blank; skipping it forfeits premium shoot assignments.",
        };
      }
      // Agent-intro packages: the INTRO SCRIPT itself is the requirement (a
      // filled notes box alone isn't enough). Key absent = pre-update tab —
      // its old-style brief above already carried the photographer's words,
      // so never trap it behind a refresh that would lose their typing.
      if (
        wantsVideoGate &&
        spec.requireVideoCount &&
        // undefined = a pre-update tab; never trap those. Anything else must be
        // a real positive integer (0 used to pass the gate then be dropped).
        data.videosFilmed !== undefined &&
        !(typeof data.videosFilmed === "number" && Number.isInteger(data.videosFilmed) && data.videosFilmed > 0) &&
        prior.videosFilmed == null
      ) {
        return { blocked: "Tell us how many videos you filmed — the editor cuts to that count." };
      }
      if (wantsVideoGate && spec.requireIntro && data.introScript === null) {
        return { blocked: "The agent's intro script can't be left blank — type it exactly as it was delivered on camera." };
      }
    }
    // Premium packages: the script can NOT be blank (Jordan, Sep 1). When
    // Studio has one, the confirm gate below covers it; when it doesn't, the
    // photographer types what was delivered. Key absent = pre-update tab.
    if (
      wantsVideoGate &&
      spec.requireScript &&
      !prior.reelScript &&
      !prior.scriptConfirmedAt &&
      !prior.videoInstructions &&
      data.providedScript === null
    ) {
      return { blocked: "The script can't be left blank for this premium package — type or paste it exactly as it was delivered on camera." };
    }
    if (wantsVideoGate && prior.reelScript && !data.scriptConfirm && !prior.scriptConfirmedAt) {
      // The script may have landed from Studio AFTER their page loaded — an
      // un-satisfiable error with no visible confirm control is a trap.
      // A photographer who TYPED the script on site has already answered this
      // — their text is the record of what was filmed, and a Studio draft that
      // landed mid-session is just a draft. Telling them to refresh would
      // throw away what they typed (review), so accept it instead.
      if (!(data.sawScript === false && data.providedScript?.trim())) {
        return {
          blocked: data.sawScript === false
            ? "A script just arrived from Script Studio for this shoot — refresh this page to review and confirm it, then submit."
            : "Confirm the script — delivered as written, or edited on site? The editor cuts to whatever you confirm here.",
        };
      }
    }
    if (wantsVideoGate && data.scriptConfirm?.state === "edited" && !data.scriptConfirm.script?.trim()) {
      return { blocked: "You marked the script as changed but the script box is empty — paste what was actually filmed, or choose “Delivered as written.”" };
    }
  }

  // SERVER-SIDE completeness check against the ORDER (the old client-side
  // confirm was honor-system only — July 2026 audit: "photos-only upload reads
  // as raws-in for a video job"). Compare what was ordered against what's
  // actually in the raw folders; a mismatch bounces back for an explicit
  // confirm instead of silently handing editors an empty folder. Dropbox
  // unreadable → don't block (unknown is not proof of absence).
  if (!data.force && prior) {
    try {
      const { actualFolderPaths, folderFileCount, videoFilesUnder } = await import("@/lib/dropboxFolders");
      // The REAL folder (a rescheduled shoot's files stay where they were) —
      // the convention path made this warn "RAW-Video is empty" wrongly.
      const paths = actualFolderPaths(prior);
      const wantsVideo = liveDeliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
      const wantsPhotos = liveDeliverables.some((d) => d.type === "PHOTOS" || d.type === "DRONE");
      // Video is checked across the WHOLE job folder, not just 02-RAW-Video.
      // Clips dropped into the photos folder or the listing root are still
      // delivered footage, and counting only the one folder is what made this
      // warn on nearly every video submit (Jordan, Sep 3: "it's not detecting
      // it right away... warning them every time they go to submit").
      const [rawPhotos, video] = await Promise.all([
        wantsPhotos ? folderFileCount(paths.rawPhotos) : Promise.resolve(null),
        wantsVideo ? videoFilesUnder(paths.listing) : Promise.resolve(null),
      ]);
      const missing: string[] = [];
      if (wantsPhotos && rawPhotos === 0) missing.push("the RAW-Photos folder is empty");
      if (wantsVideo && video && video.count === 0) missing.push("no video files anywhere in this job's Dropbox folder (a video is ordered!)");
      // Footage that landed somewhere unexpected is NOT a blocker — say where
      // it is, let the submit through, and leave a note so the editor is not
      // hunting for it.
      const misfiled = wantsVideo && video && video.count > 0 && !video.where.includes("02-raw-video")
        ? `${video.count} video file${video.count === 1 ? "" : "s"} found in ${video.where.join(" and ")} rather than 02-RAW-Video`
        : null;
      if (missing.length > 0) {
        return {
          needsConfirm: true,
          warning: `Hold on — ${missing.join(" and ")}. If a big upload is still running, give Dropbox a minute and press Submit again. Submit anyway?`,
        };
      }
      if (misfiled) {
        await prisma.activity.create({
          data: { projectId, type: ActivityType.NOTE, body: `Upload check: ${misfiled}.` },
        }).catch(() => {});
      }
    } catch { /* can't check → don't block the submit */ }
  }
  // Persist per-deliverable notes when provided (the simplified checklist portal
  // doesn't send these, but other callers may).
  for (const [deliverableId, note] of Object.entries(data.itemNotes ?? {})) {
    if (note?.trim()) {
      await prisma.deliverable.update({
        where: { id: deliverableId },
        data: { notes: note.trim() },
      });
    }
  }

  const scriptEdited = data.scriptConfirm?.state === "edited";
  // On a RE-submit, an empty note must not wipe the prior "what changed"
  // detail, and an unchanged script text must not re-write reelScript (which
  // would bump timestamps and, from a stale tab, clobber later corrections).
  const priorNote = prior?.scriptConfirmNote ?? null;
  const incomingNote = data.scriptConfirm?.note?.trim() ?? "";
  const newScriptText = data.scriptConfirm?.script?.trim() ?? "";
  const scriptTextChanged = scriptEdited && !!newScriptText && newScriptText !== (prior?.reelScript ?? "").trim();
  const providedOnSitePrior = (prior?.scriptConfirmNote ?? "").startsWith(PROVIDED_ON_SITE);
  // undefined = leave the stored note alone. A script the photographer typed
  // on site must keep that provenance: a later re-submit (even one only
  // tweaking the brief) sends state "as-written" and would otherwise relabel
  // it "Delivered as written", erasing who wrote it (review).
  const nextConfirmNote = !data.scriptConfirm || (providedOnSitePrior && data.scriptConfirm.state === "as-written")
    ? undefined
    : scriptEdited
      ? incomingNote
        ? `Edited on site — ${incomingNote.slice(0, 500)}`
        : priorNote?.startsWith("Edited")
          ? priorNote // keep the existing what-changed detail
          : "Edited on site"
      : "Delivered as written";
  await prisma.project.update({
    where: { id: projectId },
    data: {
      // Only overwrite the brief when the finalize actually carries one — a
      // re-finalize with an empty field must not wipe the photographer's notes.
      ...(data.editorBrief.trim() ? { editorBrief: data.editorBrief.trim() } : {}),
      // The FIRST completed submit is the payroll-visibility moment ("once
      // submitted, this shoot will be added to your payroll") — keep the
      // original stamp on re-submits.
      ...(prior?.debriefSubmittedAt ? {} : { debriefSubmittedAt: new Date() }),
      ...(data.cullingConfirmed ? { cullingConfirmedAt: new Date() } : {}),
      ...(data.shotOrder
        ? {
            shotOrderNotes: (() => {
              const mode = data.shotOrder.mode ?? (data.shotOrder.frontToBack ? "front-to-back" : "out-of-order");
              if (mode === "front-to-back") return FRONT_TO_BACK_SENTINEL;
              if (mode === "interior-exterior") return INTERIOR_EXTERIOR_SENTINEL;
              // Never double-wrap a note that already carries the prefix
              // (belt to the client-side strip — prod data stays clean).
              return data.shotOrder.notes?.trim()
                ? `Out of order — ${data.shotOrder.notes.trim().replace(/^Out of order — /, "").slice(0, 2000)}`
                : undefined;
            })(),
          }
        : {}),
      ...(data.removalNotes?.trim()
        ? { removalNotes: data.removalNotes.trim().slice(0, 4000) }
        : data.nothingToRemove
          ? { removalNotes: NOTHING_TO_REMOVE_SENTINEL }
          : {}),
      // Only a job that actually ordered video can carry a video brief — a
      // fixed-style monthly job with no video deliverable would otherwise
      // store a bare "STYLE:" line that reads as a real brief everywhere.
      ...(anyVideoOrdered && data.videoInstructions?.trim()
        ? { videoInstructions: data.videoInstructions.trim().slice(0, 6000) }
        : {}),
      ...(typeof data.videosFilmed === "number" && data.videosFilmed > 0
        ? { videosFilmed: Math.min(data.videosFilmed, 999) }
        : {}),
      ...(data.scriptConfirm
        ? {
            scriptConfirmedAt: new Date(),
            scriptConfirmNote: nextConfirmNote,
            // An on-site edit replaces the working script — the editor must cut
            // to what was actually filmed, not what Studio drafted.
            ...(scriptTextChanged
              ? { reelScript: newScriptText.slice(0, 20_000), reelRecipeUpdatedAt: new Date() }
              : {}),
          }
        : {}),
      // Premium package with no Studio script: the photographer's typed script
      // becomes the working script (mutually exclusive with scriptConfirm —
      // that flow only runs when a Studio script exists). Never clobbers an
      // existing reelScript.
      // Re-submits must still be able to FIX a typed-on-site script. Only a
      // real Studio script is protected from being overwritten here (review:
      // the old !prior.reelScript guard silently discarded corrections after
      // the first submit, while showing a success banner).
      ...(data.providedScript?.trim() &&
      (!prior?.reelScript || (prior?.scriptConfirmNote ?? "").startsWith(PROVIDED_ON_SITE) || data.sawScript === false)
        ? {
            reelScript: data.providedScript.trim().slice(0, 20_000),
            reelRecipeUpdatedAt: new Date(),
            scriptConfirmedAt: new Date(),
            scriptConfirmNote: `${PROVIDED_ON_SITE} — typed by the photographer`,
          }
        : {}),
      uploadedAt: new Date(),
    },
  });

  // Advance into the editing pipeline if still pre-shoot.
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (
    project &&
    (project.status === ProjectStatus.BOOKED ||
      project.status === ProjectStatus.SCHEDULED)
  ) {
    await prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.SHOT },
    });
  }

  // The editor brief PDF is generated on demand from the project data
  // (/api/projects/<id>/editor-brief) rather than written to disk — Vercel's
  // filesystem is ephemeral, and this way the brief always reflects the latest
  // details. Mark the link so the project + upload pages surface it.
  const pdfPath = `/api/projects/${projectId}/editor-brief`;
  await prisma.project.update({
    where: { id: projectId },
    data: { editorPdfPath: pdfPath },
  });

  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.FILE,
      body: "Photographer completed upload. Editor brief is ready for the editors.",
    },
  });

  // Raws are in → refresh the evidence and run the FULL editor handoff now
  // (bench ping + edit_video task + Luma dispatch + editorId), instead of
  // waiting up to an hour for the cron. The old wiring only pinged Slack and
  // never minted the editor's work item (July 2026 audit: "both photographer
  // 'done' buttons suppress the editor handoff"). syncProjectStatuses re-reads
  // Aryeo/Dropbox and calls the idempotent ensureEditorHandoff inside.
  if (firstFinalize) {
    try {
      const { syncProjectStatuses } = await import("@/lib/projectStatus");
      await syncProjectStatuses({ projectId });
    } catch {
      // Evidence sync failed (Dropbox blip?) — at least announce the raws; the
      // hourly sweep will complete the handoff.
      try {
        const { notifyRawsLanded } = await import("@/lib/tasks");
        await notifyRawsLanded(projectId);
      } catch { /* non-fatal */ }
    }
  }

  // (Review happens in the in-hub Review Room — no external review-project hook here.)

  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
  return { pdfPath };
}

// ---------------------------------------------------------------------------
// "Added at the shoot" (Jordan, Sep 2 2026)
//
// Agents add work on site all the time — an extra twilight, a drone add-on, a
// second reel. The order in Aryeo doesn't know about it, so it never becomes a
// deliverable, never gets billed, and the photographer has nowhere to say it
// happened. This is that place: the photographer names the item, and it lands
// on Kyle's plate as a real internal_instruction task, which /ops Open Loops,
// the Daily Tasks board and the owner Dashboard all already render — no Ops Day
// code change needed.
//
// The dedupe key is deliberately PLAIN TEXT (not the hashed dedupe() used in
// lib/tasks.ts) so the upload page can list this project's add-ons back to the
// photographer with a startsWith query. Key + shape live in ./shootAddOns —
// this is a "use server" file and may only export async functions.
// ---------------------------------------------------------------------------

/**
 * Log an item the agent added at the shoot and put it in front of Kyle so he
 * can add it to the Aryeo order. Idempotent per (project, item): re-submitting
 * the portal, or naming the same item twice, refreshes the one task instead of
 * stacking duplicates, and never re-opens one Kyle has already handled.
 */
export async function addShootAddOn(
  projectId: string,
  item: string,
  note: string,
): Promise<{ ok: boolean; message: string; row?: ShootAddOn }> {
  // requireShootAccess THROWS (session lapsed, "view as" preview, someone
  // else's shoot). A rejected server action reaches the client as a redacted
  // error in production, so the photographer would just see a button that does
  // nothing. This action already speaks in {ok, message} — hand the guard's own
  // words back the same way (the pattern pingFeedbackOnSlack uses).
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to that shoot." };
  }
  const name = item.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return { ok: false, message: "Name the item that was added." };
  const detail = note.trim().slice(0, 500);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, photographer: { select: { name: true } } },
  });
  if (!project) return { ok: false, message: "Couldn't find that shoot." };

  // Who added it: the signed-in person, falling back to the assigned
  // photographer (dev/open mode has no session).
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name || project.photographer?.name || "The photographer").trim().slice(0, 80);

  const street = streetOf(project.title);
  const { etDateTime } = await import("@/lib/datetime");
  const when = etDateTime(new Date());
  const summary =
    `${who} added “${name}” at the shoot on ${street} (${when} ET)` +
    (detail ? `: ${detail}` : ".") +
    ` Add the item to the Aryeo order so it's billed and shows up as a deliverable.`;

  const dedupeKey = shootAddonKey(projectId, name);
  const existing = await prisma.smartTask.findUnique({
    where: { dedupeKey },
    select: { id: true, status: true, createdAt: true },
  });
  if (existing) {
    if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
      return { ok: true, message: `“${name}” was already handled by the office.` };
    }
    // Same item, new detail — refresh the wording, never the status (Kyle may
    // already be part-way through it).
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: { summary: summary.slice(0, 500), description: detail || null, contactName: who },
    });
    revalidatePath(`/upload/${projectId}`);
    return {
      ok: true,
      message: `“${name}” was already on the list — updated.`,
      row: { id: existing.id, item: name, note: detail || null, addedBy: who, addedAtISO: existing.createdAt.toISOString(), handled: false },
    };
  }

  const kyle = await prisma.teamMember.findFirst({
    where: { name: { contains: "Kyle" } },
    select: { id: true },
  });

  let created;
  try {
    created = await prisma.smartTask.create({
      data: {
        taskType: "internal_instruction",
        // The address suffix is dropped rather than truncated when a long item
        // name would push the title past the 120-char cap — the item name is
        // what the portal reads back out of this title.
        title:
          `${ADD_TO_ORDER_PREFIX}${name}`.length + 3 + street.length <= 120
            ? `${ADD_TO_ORDER_PREFIX}${name} — ${street}`
            : `${ADD_TO_ORDER_PREFIX}${name}`.slice(0, 120),
        summary: summary.slice(0, 500),
        description: detail || null,
        reasonCreated: "The photographer logged an item the agent added at the shoot.",
        source: "manual",
        priority: "HIGH",
        // Ordering paperwork is a next-morning job, which is exactly where
        // Jordan wants it: Kyle's Ops Day the day after the shoot.
        dueAt: new Date(Date.now() + 24 * 3600_000),
        assignedKey: "kyle",
        ownerId: kyle?.id ?? null,
        projectId,
        propertyAddress: project.title,
        // clientId stays NULL on purpose: brain.ts MERGEABLE_TYPES includes
        // internal_instruction, so a task carrying a clientId is a merge target
        // for the client's next inbound message — which could retitle this and
        // lose the item name that IS the whole point of the task.
        contactName: who,
        dedupeKey,
      },
      select: { id: true, createdAt: true },
    });
  } catch {
    // Unique dedupeKey lost a race with a double-tap — the other write is the
    // same task, so treat it as success.
    const again = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, createdAt: true } });
    if (!again) return { ok: false, message: "Couldn't save that — try again." };
    created = again;
  }

  // Timeline trail so the item is visible on the project itself, not only on a
  // task. NOTE (not SPECIAL_REQUEST/FLAG) — the upload portal renders those two
  // as the client's requests and the photographer's problems, and this is
  // neither.
  await prisma.activity
    .create({
      data: {
        projectId,
        type: ActivityType.NOTE,
        body: `Added at the shoot — ${name}${detail ? `: ${detail}` : ""} (logged by ${who}). Needs adding to the Aryeo order.`.slice(0, 1000),
      },
    })
    .catch(() => {});

  // Bell for the office as well as the task, so an add-on booked on a Friday
  // afternoon isn't invisible until the next Ops Day. Best-effort, deduped per
  // item — no body (the money clamp aside, there's nothing to add to the title).
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "shoot_add_on",
      title: `Added at the shoot — ${name} on ${street}`,
      href: `/projects/${projectId}`,
      targets: [{ roles: ["ADMIN", "OWNER"] }],
      // Keyed on the task row, not the item key — a row withdrawn and re-added
      // is a new piece of work and deserves its own announcement.
      dedupeKey: `shoot-add-on-${created.id}`,
    });
  } catch { /* bell is best-effort — the task above is the real handoff */ }

  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return {
    ok: true,
    message: `Logged — Kyle will add “${name}” to the order.`,
    row: { id: created.id, item: name, note: detail || null, addedBy: who, addedAtISO: created.createdAt.toISOString(), handled: false },
  };
}

/**
 * Withdraw an add-on the photographer logged by mistake. Only ever touches a
 * still-open task this project's own portal created (the dedupeKey prefix +
 * projectId are both checked), so this can't be used to cancel other work.
 */
export async function removeShootAddOn(
  projectId: string,
  taskId: string,
): Promise<{ ok: boolean; message?: string }> {
  // Same as addShootAddOn: the guard's refusal comes back as a message the
  // photographer can read, not an unhandled rejection.
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to that shoot." };
  }
  const t = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, dedupeKey: true, status: true },
  });
  if (!t || t.projectId !== projectId || !t.dedupeKey?.startsWith(shootAddonKeyPrefix(projectId))) {
    return { ok: false, message: "That item isn't yours to remove." };
  }
  if (t.status === "COMPLETED" || t.status === "CANCELLED") {
    return { ok: false, message: "The office already handled that one." };
  }
  await prisma.smartTask.update({
    where: { id: t.id },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      // Free the per-item key: a photographer who removes the wrong row must be
      // able to add that same item again, and the unique dedupeKey would
      // otherwise make the re-add look like a duplicate forever.
      dedupeKey: null,
    },
  });
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
