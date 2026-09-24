"use server";

import { deliverableInProject, requireDeliverableAccess, requireShootAccess, requireUploadFileAccess } from "@/lib/auth/guards";

import { prisma } from "@/lib/prisma";
import { NOTHING_TO_REMOVE_SENTINEL, FRONT_TO_BACK_SENTINEL, INTERIOR_EXTERIOR_SENTINEL } from "@/lib/debrief";
import {
  ADD_TO_ORDER_PREFIX,
  shootAddonKey,
  shootAddonKeyPrefix,
  streetOf,
  type ShootAddOn,
} from "@/app/upload/shootAddOns";
import {
  ADDITIONAL_VIDEO_WORD,
  additionalShootItem,
  additionalShootLabel,
  additionalShootSentence,
  isAdditionalVideoType,
  shootDayWords,
  type AdditionalShoot,
} from "@/app/upload/additionalShoots";
import { etAt, etDate, etDayKey, etDayStartUtc } from "@/lib/datetime";
// The Sep 2 pay gate — the day from which a shoot is expected to carry a
// photographer's submit at all. Static, the way both upload pages take it:
// this file loads its heavy helpers lazily inside the branch that needs them,
// but this one is a single parsed date read on every finalize, and reaching
// for the whole payroll engine through a dynamic import to get at a number is
// ceremony with nothing behind it.
import { DEBRIEF_PAY_GATE_FROM } from "@/lib/payroll";
import { revalidatePath } from "next/cache";
import { ProjectStatus, DeliverableStatus, ActivityType } from "@prisma/client";
import { saveUpload, deleteFile } from "@/lib/storage";
import { UPLOAD_COMPLETED_BODY, UPLOAD_EDITED_BY_PREFIX, UPLOAD_SUBMITTED_BY_PREFIX } from "@/lib/uploadSummary";

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
  // The guard above proves this shoot is theirs; it says nothing about the
  // deliverable id the form sent (RTP-02, Sep 16). Unchecked, a photographer
  // on their own job could file an upload against — and flip to UPLOADED —
  // another client's line item. Drop a foreign id rather than throw: the files
  // still belong on this job, they just land unattached.
  if (deliverableId && !(await deliverableInProject(deliverableId, projectId))) deliverableId = null;
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
    // …and the question it put on the office's plate goes with it.
    try {
      const { confirmNotRequiredTask } = await import("@/lib/tasks");
      await confirmNotRequiredTask(deliverableId);
    } catch { /* best-effort */ }
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
  // ONE QUESTION FOR THE OFFICE (Sep 16, Kyle call). Until now this answer was
  // a note on a card: the hub kept the item owed, kept saying "still missing",
  // and chased CubiCasa for a floor plan James had already told us nobody
  // ordered. It still isn't a waiver — only the office can say what the client
  // bought — so it becomes one deduped card on Kyle's plate with a one-tap
  // link to the job's deliverables. Best-effort: the photographer's answer is
  // saved either way.
  try {
    const { confirmNotRequiredTask } = await import("@/lib/tasks");
    await confirmNotRequiredTask(deliverableId);
  } catch { /* the hourly reconcile is not a backstop for this — see above */ }
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
    /**
     * F12: WHICH of the month's topics were filmed. Absent on a listing shoot
     * and on a pre-update tab; an empty array is a real answer ("none of them"),
     * which is why absence and emptiness are not folded together.
     */
    filmedTopicIds?: string[];
    /** CP-09: topicId → the photographer's note to the editor about that video (≤1000 chars each). */
    topicNotes?: Record<string, string>;
    /** CP-09: topics filmed on site that were not on the month's list (≤10; title ≤200). */
    extraTopics?: { key: string; title: string; note?: string }[];
    /** premium packages with no Studio script: the script typed on site */
    providedScript?: string | null;
  },
): Promise<{
  pdfPath?: string;
  needsConfirm?: boolean;
  warning?: string;
  blocked?: string;
  /**
   * CP-09: the footage is in, but the filmed topics have not been recorded
   * yet. They are saved (ContentFilmingReport) and the hub retries on its own;
   * the page says so rather than reporting a success that has not happened.
   */
  topicsPending?: { count: number; message: string };
}> {
  await requireShootAccess(projectId);
  // First finalize or a re-submit? The debrief gates and the raws-landed
  // handoff below only fire on the FIRST human submit (the transition), never
  // on edits/re-submits — see `firstFinalize` under the query for what counts.
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
  // WHO is submitting (Jordan, Sep 15: the office can now re-open a submitted
  // page from /upload history "and also make adjustments"). A submitted page
  // is the photographer's word that the footage is in, and everything that
  // word triggers — the Waiting-hold release, the move to Ready for editing,
  // the raws-in handoff — must stay the photographer's: an office edit of the
  // notes must not release a hold the office itself set, or move a held job
  // on. So each of those runs only on the first human submit
  // (debriefSubmittedAt unset) or when the submitter is the shoot's own
  // photographer. Resolved once here; every side effect below reads it.
  const everSubmitted = !!prior?.debriefSubmittedAt;
  // Is this the first HUMAN submit? This used to read `!prior.uploadedAt`, and
  // that was wrong: uploadedAt means "the raws landed", and the hourly status
  // sweep stamps it off a Dropbox file count alone (projectStatus.ts,
  // rawsDetected — shoot happened, no hold, files in the folder; it never looks
  // at debriefSubmittedAt). So on any job where the footage sat in the folder
  // across an hour boundary before the photographer pressed Submit, the stamp
  // was already there, this flag was already false, and every debrief gate
  // below went silently inert on the photographer's genuine first submit —
  // 12 of the 36 submits since the Sep 2 pay gate, the widest of them 5 days
  // apart (5642 Limeport Rd, Emmaus). Nothing bad reached an editor only
  // because UploadPortal refuses to call this action while anything is
  // unanswered; the server had no rule left. debriefSubmittedAt is the one
  // stamp finalizeUpload itself writes, so it is the only one that can tell a
  // human submit from a folder read — schema.prisma and queueWaiting.ts both
  // already say so.
  //
  // The escape hatch that the old predicate gave by accident is deliberate
  // now: 83 production jobs shot before the Sep 2 pay gate carry uploadedAt
  // with no submit, because back then there was no submit step — the sweep's
  // stamp is the only record they ever finished. Demanding retroactive cull,
  // shot-order and removal answers the first time the office re-opens one of
  // those is exactly the trap the gate comment below warns about. Same test
  // UploadPortal.tsx uses to decide a legacy page reads as already submitted.
  const shootMs: number | null = prior?.shootDate?.getTime() ?? null;
  const legacyDone =
    !everSubmitted &&
    !!prior?.uploadedAt &&
    (shootMs == null || shootMs < DEBRIEF_PAY_GATE_FROM);
  const firstFinalize = !everSubmitted && !legacyDone;
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  let submitterIsPhotographer = false;
  if (me) {
    const { photographerMemberId, photographerOwnsShoot } = await import("@/lib/shoot");
    const mid = await photographerMemberId(me);
    submitterIsPhotographer = !!mid && (await photographerOwnsShoot(projectId, mid));
  }
  const submitterName = (me?.name?.trim() || me?.email || "the office").slice(0, 80);
  /** a re-submit by someone other than the shoot's photographer — notes only */
  const officeEdit = everSubmitted && !submitterIsPhotographer;
  /** may this submit move the job on (hold release, Waiting → Ready for editing)? */
  const mayAdvance = !everSubmitted || submitterIsPhotographer;
  // A deliverable marked "couldn't complete + why" is EXCUSED from the gates —
  // demanding video instructions for a reel the agent canceled on site forces
  // the photographer to fabricate answers (review HIGH). The reason itself is
  // already on the Admin's QC card / timeline for a human to resolve.
  const liveDeliverables = (prior?.deliverables ?? []).filter((d) => !d.notCompletedReason);
  const anyVideoOrdered = liveDeliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");

  // CP-09 — WHICH TOPICS WERE FILMED, made durable. The ticks (plus any note
  // per topic and any topic filmed on site) become a ContentFilmingReport row
  // written in the SAME transaction as the debrief below, so the footage submit
  // and the photographer's word about what it contains commit together or not
  // at all. Applying it is a separate, retryable step (lib/filmedTopics.ts).
  // The number the editor cuts to is the SERVER's count from the same answer —
  // the videos already confirmed on this project, the ticks, and the extras —
  // never a second number the browser sends that could disagree with it.
  const filming = Array.isArray(data.filmedTopicIds)
    ? await (await import("@/lib/filmedTopics")).prepareFilmingReport(
        projectId,
        { filmedTopicIds: data.filmedTopicIds, topicNotes: data.topicNotes, extraTopics: data.extraTopics },
        { name: submitterName, email: me?.email ?? null },
      )
    : null;
  const videosFilmedIn = filming ? filming.videosFilmed : data.videosFilmed;

  // ---- The debrief gates (Jordan, Aug 31): the job is not done until the
  // cull is confirmed, removal notes are answered, and video jobs carry the
  // editor's instructions + a confirmed script. Prior answers survive
  // re-submits — nobody re-types a form to fix a typo in the brief.
  // Gates apply to the FIRST finalize only — a job already submitted once
  // (or delivered weeks ago and re-opened for a brief tweak) keeps its prior
  // answers and never demands retroactive debrief data (review finding), and
  // a pre-pay-gate shoot that never had a submit step is left alone entirely
  // (see `legacyDone` above).
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
    // here). It does NOT quite mirror the client, whatever this comment used
    // to claim: the portal resolves the same spec from the Deliverable
    // .videoStyle stamp (upload/[id]/page.tsx, specForStyle) and only falls
    // back to product names, while the gate here is name-based throughout.
    // When a stamp and the names disagree, the server can demand a brief the
    // browser never asked for — and the photographer is then stuck in the
    // field, blocked by a step their screen doesn't show. Measured against
    // production Sep 20 2026 (scripts/_drill/fix-F06-verify.ts): of 630 jobs
    // with video and no submit on record, four resolve differently and three
    // of those would block — all four pre-pay-gate, all three already reachable
    // before the first-submit predicate above was corrected, and none of the 16
    // post-pay-gate ones diverge at all. Re-run that replay after the next
    // Aryeo product mapping change. The cure is lifting specForStyle into
    // lib/pipeline so both sides read the stamp — page.tsx's own comment
    // already anticipates this one "once it reads the stamp".
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
        videosFilmedIn !== undefined &&
        !(typeof videosFilmedIn === "number" && Number.isInteger(videosFilmedIn) && videosFilmedIn > 0) &&
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
  // Not on an office edit of the notes (Sep 15): the office isn't attesting
  // to footage, and an old job's folder may have moved since — "the RAW-Photos
  // folder is empty" on a delivered job is a false alarm. A photographer's own
  // re-submit (a job the office put back to Waiting, say) still gets checked.
  if (!data.force && prior && !officeEdit) {
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
    if (!note?.trim()) continue;
    // Same rule as uploadFiles (RTP-02, Sep 16): requireShootAccess vouched
    // for the JOB, so every related id the submit carries has to be shown to
    // belong to it before it is written. A note for another job's deliverable
    // is silently skipped — it was never this form's to send.
    if (!(await deliverableInProject(deliverableId, projectId))) continue;
    await prisma.deliverable.update({
      where: { id: deliverableId },
      data: { notes: note.trim() },
    });
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
  // The script confirmation keeps its first stamp unless the ANSWER changed
  // (Sep 15): the re-opened page always sends state "as-written", and "What
  // you submitted" reads scriptConfirmedAt as when the photographer confirmed
  // the script — an office notes edit must not move it to the edit date.
  const scriptAnswerChanged =
    !prior?.scriptConfirmedAt || scriptTextChanged || (nextConfirmNote !== undefined && nextConfirmNote !== priorNote);
  const projectWrite = prisma.project.update({
    where: { id: projectId },
    data: {
      // Only overwrite the brief when the finalize actually carries one — a
      // re-finalize with an empty field must not wipe the photographer's notes.
      ...(data.editorBrief.trim() ? { editorBrief: data.editorBrief.trim() } : {}),
      // The FIRST completed submit is the payroll-visibility moment ("once
      // submitted, this shoot will be added to your payroll") — keep the
      // original stamp on re-submits.
      ...(prior?.debriefSubmittedAt ? {} : { debriefSubmittedAt: new Date() }),
      // The cull confirmation keeps its first stamp too (Sep 15): the
      // re-opened page sends the four ticks pre-checked, and "What you
      // submitted" reads this as WHEN the cull was confirmed.
      ...(data.cullingConfirmed && !prior?.cullingConfirmedAt ? { cullingConfirmedAt: new Date() } : {}),
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
      ...(typeof videosFilmedIn === "number" && videosFilmedIn > 0
        ? { videosFilmed: Math.min(videosFilmedIn, 999) }
        : {}),
      ...(data.scriptConfirm
        ? {
            ...(scriptAnswerChanged ? { scriptConfirmedAt: new Date() } : {}),
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
      // uploadedAt is WHEN THE RAWS LANDED — first stamp only (Sep 15). It
      // used to be re-stamped on every submit, so an office edit of the notes
      // weeks later would have moved the raws-in time the on-time KPI
      // (kpi.ts) scores the photographer's bonus on. The Waiting hold clears
      // this stamp on an unsubmitted job, so the photographer's next real
      // submit still lands a fresh one.
      ...(prior?.uploadedAt ? {} : { uploadedAt: new Date() }),
    },
  });
  // The report and the debrief commit together. createMany + skipDuplicates:
  // the same answer submitted twice is the one row (unique projectId +
  // payloadHash), and a duplicate is a no-op rather than a P2002 that would
  // fail the whole submit.
  let reportIsNew = false;
  if (filming) {
    const [made] = await prisma.$transaction([
      prisma.contentFilmingReport.createMany({ data: [filming.row], skipDuplicates: true }),
      projectWrite,
    ]);
    reportIsNew = made.count > 0;
  } else {
    await projectWrite;
  }

  // F12 / CP-09 — APPLY IT NOW, and say so when it did not land.
  //
  // After the commit, and never able to fail the submit: the footage is in,
  // and the photographer's answer is on file whatever happens next. A failure
  // leaves the report FAILED (lib/filmedTopics.ts applyFilmingReport, which
  // now also raises the unverified-date flag this block used to), and the
  // hourly sweep (cron/sync filmingReports) retries it until it lands, without
  // anybody re-entering anything. The page hears `topicsPending` instead of a
  // success that has not happened, and the job's timeline gets ONE flag per
  // report — not one per re-submit.
  let topicsPending: { count: number; message: string } | undefined;
  if (filming) {
    let state = "FAILED";
    let error: string | null = null;
    try {
      const { applyFilmingReport } = await import("@/lib/filmedTopics");
      const report = await prisma.contentFilmingReport.findUnique({
        where: { projectId_payloadHash: { projectId, payloadHash: filming.payloadHash } },
        select: { id: true },
      });
      if (report) ({ state, error } = await applyFilmingReport(report.id));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (state !== "APPLIED") {
      topicsPending = {
        count: filming.topicCount,
        message: "Your footage is in and the editors have it. The topics you ticked are saved, but the hub has not finished recording them yet — it retries on its own, so there is nothing more you need to do.",
      };
      if (reportIsNew) {
        await prisma.activity
          .create({
            data: {
              projectId,
              type: ActivityType.FLAG,
              body: `Filmed topics from ${submitterName} are saved but not recorded yet (${filming.topicCount} topic${filming.topicCount === 1 ? "" : "s"}) — the hub retries hourly.${error ? ` Last error: ${error.slice(0, 300)}` : ""}`,
            },
          })
          .catch(() => {});
      }
    }
  }

  // The office's Waiting hold ends here (Jordan, Sep 11): this submit is the
  // photographer's own word that the footage is in — the first of the two
  // things that release a job the office put back to Waiting (the other is
  // the office moving it on from the queue pill; src/lib/queueWaiting.ts).
  // Every submit, not just the first: debriefSubmittedAt keeps its original
  // stamp on a re-submit, so the sweep's stamp-after-hold test alone would
  // miss a job held after its first submit. Best-effort — the SHOT write
  // below moves the job on regardless. `holdReleased` also re-runs the
  // raws-landed handoff below: the office's Waiting clears the sweep's
  // uploadedAt stamp, so this submit is usually the first finalize anyway,
  // but a job held AFTER a real submit keeps its stamp and would otherwise
  // wait an hour for its editor bell (Sep 11 review).
  // Sep 15: ONLY the first submit or the photographer's own re-submit
  // (mayAdvance) — the office re-opening a submitted page to fix the notes is
  // not the photographer's word, and must not release a hold the office set.
  let holdReleased = false;
  if (mayAdvance) {
    try {
      const { releaseWaitingHold } = await import("@/lib/queueWaiting");
      holdReleased = await releaseWaitingHold(projectId);
      if (holdReleased) {
        await prisma.activity.create({
          data: { projectId, type: ActivityType.SYSTEM, body: "Waiting hold released — the photographer submitted the upload page." },
        }).catch(() => {});
      }
    } catch { /* the marker is best-effort here — the SHOT write below stands on its own */ }
  }

  // Advance into the editing pipeline if still pre-shoot. Same rule as the
  // hold (Sep 15): an office edit of the notes on a job the office holds in
  // Waiting must leave it in Waiting.
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (
    project &&
    mayAdvance &&
    (project.status === ProjectStatus.BOOKED ||
      project.status === ProjectStatus.SCHEDULED)
  ) {
    await prisma.project.update({
      where: { id: projectId },
      // The photographer's submit is a human status write, and a human write
      // ends the office's status pin (Sep 13, editOverrides.ts) — a pinned
      // Waiting gives way the same way the office's Waiting hold does.
      data: { status: ProjectStatus.SHOT, statusPinnedAt: null },
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

  // The timeline line. The photographer's submit — first or re-submit — logs
  // the same FILE line it always has. An office re-submit logs WHO edited
  // instead (Sep 15): "Photographer completed upload" would be untrue, and
  // the job page's "What you submitted" card reads the editor's name off
  // this line (submissionTrail in lib/uploadSummary.ts). An office FIRST
  // submit keeps the FILE line (it is the raws-in handoff line) and adds
  // who did it, for the same reader.
  if (officeEdit) {
    await prisma.activity.create({
      data: { projectId, type: ActivityType.NOTE, body: `${UPLOAD_EDITED_BY_PREFIX}${submitterName}.` },
    });
  } else {
    await prisma.activity.create({
      data: { projectId, type: ActivityType.FILE, body: UPLOAD_COMPLETED_BODY },
    });
    if (!everSubmitted && me && !submitterIsPhotographer) {
      await prisma.activity.create({
        data: { projectId, type: ActivityType.NOTE, body: `${UPLOAD_SUBMITTED_BY_PREFIX}${submitterName}.` },
      }).catch(() => {});
    }
  }

  // Raws are in → refresh the evidence and run the FULL editor handoff now
  // (bench ping + edit_video task + Luma dispatch + editorId), instead of
  // waiting up to an hour for the cron. The old wiring only pinged Slack and
  // never minted the editor's work item (July 2026 audit: "both photographer
  // 'done' buttons suppress the editor handoff"). syncProjectStatuses re-reads
  // Aryeo/Dropbox and calls the idempotent ensureEditorHandoff inside. A
  // submit that just released the office's Waiting hold runs it too (Sep 11):
  // the editors are owed a fresh "Raws in" the moment the job moves on.
  // This reads the human-submit `firstFinalize` now. On the old raws-landed
  // one it skipped any job the sweep had already stamped, and since that same
  // sweep pass had itself run the handoff off an empty debrief, the editor's
  // card could keep saying "Waiting on the flow and vision for the edit" for
  // up to an hour after the photographer had in fact written it. Re-running is
  // safe: ensureEditorHandoff is idempotent (activity marker + dedupeKeys), so
  // no second bench ping and no second edit_video card.
  if (firstFinalize || holdReleased) {
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
  return { pdfPath, ...(topicsPending ? { topicsPending } : {}) };
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

// ---------------------------------------------------------------------------
// BACK FOR A SECOND SHOOT (Jordan, Sep 18 2026 — 204 Spring Ln, Mike Flatley).
//
// "He ended up doing a second reel for that listing and it was shot on a
// separate day. So the photographer should be able to go back into the upload
// portal and re open the upload portal for that job and be able to add another
// project."
//
// The reasoning for putting the extra video on the SAME job — and the 82 live
// re-shoots that argument was measured against — is in ./additionalShoots.ts.
// This is the write half. Three things happen, in this order, and the order
// matters: the row first (it is the thing that is owed), then the per-video
// slot, then the office's paperwork. If the last one fails the work still
// exists; if the first one failed there would be nothing to bill for.
// ---------------------------------------------------------------------------

/**
 * Reopen a finished job for an extra video shot on another day.
 *
 * What it does NOT touch, because Jordan was explicit that the first delivery
 * stays exactly as it is: Project.status, Project.deliveredAt, Project.shootDate,
 * any ReviewSubmission, any sent stamp, and the quantity of the video row the
 * client's delivered cut hangs off.
 */
export async function reopenForAdditionalShoot(
  projectId: string,
  input: { type: string; shotOn: string; note?: string },
): Promise<{ ok: boolean; message: string; row?: AdditionalShoot }> {
  // Same shape as addShootAddOn: a guard that throws reaches the client as a
  // redacted error in production, which reads as a button that does nothing.
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to that shoot." };
  }
  if (!isAdditionalVideoType(input.type)) {
    return { ok: false, message: "Pick whether it was a reel or a video." };
  }
  const type = input.type;
  const dayKey = (input.shotOn || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return { ok: false, message: "Pick the day you shot it." };
  const shotOn = etAt(dayKey, 12); // noon ET — the day is the fact, the clock is not
  if (Number.isNaN(shotOn.getTime())) return { ok: false, message: "That date didn't read as a day — pick it again." };

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true, shootDate: true, status: true,
      videosOwedOverride: true,
      // THE JOB'S OWN SLA INPUTS (Sep 18 review, F4). The extra video's promise
      // was asked for with monthlyContent=false and an EMPTY opts object, so
      // slaOptsForTier(undefined) returned null and deliveryPromiseFor fell back
      // to isPremiumLabel() on the row's own label — and "Reel — extra shoot
      // Sep 18" is worded, by design, to trip none of the premium words. Every
      // extra video was therefore promised on the standard 48h clock: on a
      // branding job whose real window is 7–10 business days it read overdue two
      // days later. Measured Sep 18: of the 646 non-cancelled jobs with a live
      // video row, 234 resolve premium and 64 branding — 46% of the jobs this
      // card can appear on. These two columns plus the deliverables' labels are
      // exactly what slaTierOf/isMonthlyContentJob need, and they are the same
      // inputs the only other production caller uses (projectStatus.ts:1665).
      packageName: true, tierOverride: true,
      photographer: { select: { name: true } },
      deliverables: {
        where: { removedFromOrderAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, label: true, videoStyle: true, manual: true, capturedAt: true },
      },
    },
  });
  if (!project) return { ok: false, message: "Couldn't find that shoot." };
  if (project.status === "CANCELLED") return { ok: false, message: "That job is cancelled — the office has to un-cancel it first." };

  // A shoot that has not happened is a BOOKING, and bookings are Aryeo's job.
  // This also keeps the client-text sweep out of it: a future date on a job is
  // a shoot to confirm, and nothing on this screen may cause an outbound text.
  if (shotOn.getTime() > Date.now()) {
    return { ok: false, message: "That day hasn't happened yet — this is for footage you've already shot." };
  }
  // …and it cannot predate the job's own shoot. A typo there would put the
  // extra video's clock before the original's and read as the older of the two
  // everywhere they are listed side by side.
  if (project.shootDate && shotOn.getTime() < etDayStartUtc(project.shootDate).getTime()) {
    return { ok: false, message: `That's before this job's own shoot on ${etDate(project.shootDate)} — check the date.` };
  }

  // One open extra shoot per job at a time. Two at once is a real thing that
  // could happen, but it would mint two cards, two slots and two payroll
  // questions from a screen with no way to tell them apart — and nobody has
  // ever needed it (measured Sep 18: no job in the database carries even one).
  if (project.deliverables.some((d) => d.manual && d.capturedAt)) {
    return { ok: false, message: "This job already has an extra shoot on it — upload that one first, or remove it below." };
  }

  // THE OVERRIDE HAS TO HAVE ROOM FOR THE NEW ROW (Sep 18 review, minor 1).
  // editOverrides.effectiveSlotCounts spreads `videosOwedOverride` across the
  // video rows BY POSITION and fills from the FRONT, while cutSlots orders the
  // rows `createdAt: "asc"` — so the row minted below is always LAST. Raising
  // the override by one only reaches that last row when the override was
  // already at least the video-row count: with 3 rows and an override of 2,
  // raising it to 3 gives [1, 1, 1, 0] and the extra shoot is minted owing no
  // cut at all — no slot, nowhere for the editor to upload. Raising it further
  // instead would silently re-owe the videos the office took off.
  //
  // So this refuses rather than guesses, and says whose desk it is on. Measured
  // Sep 18 on the live database: 3 projects carry a videosOwedOverride and NONE
  // of them sits below its video-row count, so this turns nobody away today.
  const videoRowsNow = project.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").length;
  const owedBefore = project.videosOwedOverride ?? 0;
  if (owedBefore > 0 && owedBefore < videoRowsNow) {
    return {
      ok: false,
      message: `The office has this job set to ${owedBefore} video${owedBefore === 1 ? "" : "s"} against ${videoRowsNow} video lines — ask Kyle to add the extra one on the job so the count still adds up.`,
    };
  }

  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name || project.photographer?.name || "The photographer").trim().slice(0, 80);
  const street = streetOf(project.title);
  const note = (input.note ?? "").trim().slice(0, 500);
  const sentence = additionalShootSentence(type, dayKey, who, street);

  // The Style Guide type the job's existing video already resolved to — the
  // extra reel is the same product shot again, so the editor's brief, the cut
  // label and the "what to make" card should read the same. `productTitle` is
  // deliberately left null: the schema's word for it is "the Aryeo order-item
  // name this row came from, VERBATIM", and this row came from no order line.
  const styleFrom = project.deliverables.find((d) => (d.type === "VIDEO" || d.type === "SOCIAL_REEL") && d.videoStyle);

  const row = await prisma.deliverable.create({
    data: {
      projectId,
      type,
      label: additionalShootLabel(type, dayKey),
      // Manual: the Aryeo reconcile skips these rows outright, so the order
      // catching up later can never retire or relabel the extra video.
      manual: true,
      quantity: 1,
      status: DeliverableStatus.PENDING,
      // "The photographer ticked this off on site" — the schema's own meaning,
      // holding the day the extra footage was shot. evidenceUnits reads it as
      // RAW_IN, which is exactly what this is until the files land.
      capturedAt: shotOn,
      videoStyle: styleFrom?.videoStyle ?? null,
      notes: (note ? `${sentence} ${note}` : sentence).slice(0, 1000),
    },
    select: { id: true, label: true, createdAt: true },
  });

  // THE OFFICE'S NUMBER STILL HAS TO ADD UP (found by reading the arithmetic,
  // Sep 18). editOverrides.effectiveSlotCounts lays `videosOwedOverride` over
  // the video rows BY POSITION: with an override of 1 and two video rows it
  // returns [1, 0], so the extra row would have been minted owing nothing at
  // all. 204 Spring Ln carries exactly that override. Raise it by one so the
  // office's total still means what it says — never INTRODUCE an override on
  // a job that had none, where the row count already answers the question.
  //
  // …AND THE THREE COLUMNS ARE NOT OURS TO WRITE (Sep 18 review, F1). That was
  // wrong, and it was wrong on the one job this feature was built for.
  // overrideBy/overrideAt/overrideNote are ONE provenance triple for the WHOLE
  // override record: saveEditOverrides stamps them once for dueOverrideAt,
  // videosOwedOverride, tierOverride, typeDetailOverride and priorityOverride
  // together, and editOverrides.ts:102-104 reads them back as the single note
  // behind the chip. 204 Spring Ln is the only project in the database carrying
  // an override note — "Ordered after the original appointment", typed by
  // Jordan on Sep 17 over a due date, a standard tier, an URGENT priority AND
  // a type detail. One tap of Add another shoot rewrote all three columns, so
  // the chip would have explained that URGENT, that tier and that Sep 17
  // deadline with the portal's sentence about a reel filmed the following day —
  // and the office's typed reason was gone, with no Activity row anywhere to
  // recover it from.
  //
  // So: raise the number the arithmetic needs, and record who and why on the
  // timeline, which is where a photographer's action belongs and is exactly
  // what withdrawAdditionalShoot already does on the way back out.
  if (owedBefore > 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: { videosOwedOverride: owedBefore + 1 },
    });
    await prisma.activity.create({
      data: {
        projectId,
        type: ActivityType.NOTE,
        body: `Videos owed on this job raised ${owedBefore} → ${owedBefore + 1} by ${who}: ${sentence} The office's own override note is untouched.`.slice(0, 1000),
      },
    }).catch(() => {});
  }

  // The per-video row, its deadline and its place in the Editing Room. Same
  // entry point the order reconcile, the waiver and the office override use —
  // it never throws into this action, and the hourly sweep repairs a failure.
  const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
  await ensureOutputsSafely(projectId, `upload-additional-shoot#${row.id}`);

  // ---- A VIDEO SHOT TODAY IS NOT LATE (Sep 18) ----------------------------
  //
  // Left alone, the new slot inherits the JOB's promise, because outputsForProject
  // falls back to it when a slot carries no date of its own. On 204 Spring Ln —
  // the job Jordan asked for this by name — the job's date is already past, so
  // the extra reel would be born overdue on the board, on the exceptions card
  // and in the photographer's own view, for work nobody had been asked for
  // until today.
  //
  // The portal does NOT invent a date. It asks the same engine every other
  // promise comes from (deliveryPromiseFor) for this ONE deliverable, anchored
  // on the day it was actually shot, and records the answer on the slot. That
  // is what DeliverableOutput.promisedAt is for, and it is the only way a
  // per-video deadline can differ from the job's — which is the whole point of
  // a second shoot on a later day.
  //
  // Best-effort, and deliberately: a slot with no date of its own falls back to
  // the job's exactly as it does today, which is the behaviour this replaces.
  try {
    // …ASKED WITH THE JOB'S TIER, NOT WITHOUT ONE (Sep 18 review, F4). This
    // call used to pass monthlyContent=false and `{}`, which is not "no
    // opinion" — slaOptsForTier(undefined) returns null and the engine then
    // reads the tier off the ROW'S OWN LABEL, and additionalShootLabel is
    // deliberately worded to trip none of the premium words. So every extra
    // video, on every job, was promised on the standard 48h clock. These are
    // the same two inputs projectStatus.ts:1665 passes, which is the only other
    // production caller: the office's tierOverride wins (on 204 Spring Ln that
    // is a deliberate "standard" over a premium_social_reel row, so the answer
    // there is unchanged — but now it is the office's answer, not an accident).
    const { deliveryPromiseFor, slaTierOf } = await import("@/lib/tasks");
    const { isMonthlyContentJob } = await import("@/lib/pipeline");
    const promise = deliveryPromiseFor(
      shotOn,
      [{ type, label: row.label, productTitle: null }],
      isMonthlyContentJob(project.deliverables, project.packageName),
      null,
      { tier: slaTierOf(project) },
    );
    await prisma.deliverableOutput.updateMany({
      // Only the slots of THIS new row, and only while they carry no promise —
      // never a second write over a date somebody has already set.
      where: { projectId, deliverableId: row.id, promisedAt: null },
      data: {
        promisedAt: promise.at,
        targetAt: promise.targetAt,
        promiseSource: "additional-shoot",
        promiseAnchorAt: shotOn,
      },
    });
  } catch (e) {
    console.warn("additional shoot: could not date the new video", projectId, (e as Error).message);
  }

  // Kyle's paperwork, through the card the office already reads on Ops Day.
  // Reusing addShootAddOn rather than minting a second kind of task buys the
  // whole hardened path: the plain-text dedupe key, the double-tap race, the
  // timeline line, the office bell — and the auto-close, so this card ticks
  // itself off the moment the line appears on the Aryeo order.
  //
  // The wording is kept tight on purpose: addShootAddOn folds this detail into
  // a 500-character summary behind its own "<who> added <item> at the shoot on
  // <street>" prefix, so a long preamble would push the one instruction that
  // matters — add a SEPARATE line — off the end of the card Kyle reads.
  const addon = await addShootAddOn(
    projectId,
    additionalShootItem(type, dayKey),
    `Shot ${shootDayWords(dayKey)}, a separate day from this job's own shoot. Add it to the order as its OWN line — raising the existing line's quantity would owe one more video than was shot. Its due date runs from the shoot day. NOT PAID unless Aryeo says so — an appointment or an order. This is neither, so write it into Aryeo and payroll picks it up by itself.${note ? ` Photographer: ${note}` : ""}`,
  );

  revalidatePath("/upload");
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return {
    ok: true,
    // The office half can fail on its own (a lost race, a dropped write) and
    // the video still exists — say which half landed rather than claiming both.
    message: addon.ok
      ? "Added — upload the raws below, and the office will add it to the order."
      : `Added to the job — but the office's card didn't save. Tell Kyle about the extra ${ADDITIONAL_VIDEO_WORD[type].toLowerCase()}.`,
    row: {
      id: row.id,
      type,
      label: row.label ?? additionalShootLabel(type, dayKey),
      shotOnISO: shotOn.toISOString(),
      uploadedISO: null,
      addedBy: who,
      addedAtISO: row.createdAt.toISOString(),
      hasWork: false,
    },
  };
}

/**
 * Take an extra shoot back off the job — the wrong listing, the wrong day, or
 * the agent changed their mind before anything was cut.
 *
 * RETIRED, NEVER DELETED (house rule): the row keeps its capturedAt, its notes
 * and its id, and `removedFromOrderAt` is the stamp that says it is not owed.
 * ensureOutputsSafely then stamps the per-video slot the same way, and BOTH
 * stamps clear on their own if the row ever comes back.
 */
export async function withdrawAdditionalShoot(
  projectId: string,
  deliverableId: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to that shoot." };
  }
  const d = await prisma.deliverable.findUnique({
    where: { id: deliverableId },
    select: {
      id: true, projectId: true, type: true, label: true, manual: true,
      capturedAt: true, uploadedAt: true, removedFromOrderAt: true,
      _count: { select: { uploads: true, reviewSubmissions: true } },
    },
  });
  // Every condition of the shape reopenForAdditionalShoot created, re-checked
  // here: this must never be usable to retire a real order line.
  if (!d || d.projectId !== projectId || !d.manual || !d.capturedAt) {
    return { ok: false, message: "That isn't an extra shoot you can remove." };
  }
  if (d.removedFromOrderAt) return { ok: false, message: "That one is already off the job." };
  // Work has started on it — a cut, a file, a tick. Retiring the row now would
  // leave that work pointing at something nobody owes.
  if (d.uploadedAt || d._count.uploads > 0 || d._count.reviewSubmissions > 0) {
    return { ok: false, message: "The raws are already in on that one — ask the office to take it off." };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true, videosOwedOverride: true,
      // The video rows that will still be live once this one is retired — the
      // floor the office's number must not be pushed below (see the lower
      // below). The row being withdrawn is excluded by id, because this read
      // happens before the retire stamp lands.
      deliverables: {
        where: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] }, id: { not: d.id } },
        select: { id: true },
      },
    },
  });
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name || "the photographer").trim().slice(0, 80);

  await prisma.deliverable.update({
    where: { id: d.id },
    data: {
      removedFromOrderAt: new Date(),
      removedFromOrderNote: `Extra shoot withdrawn by ${who} — it was never uploaded.`.slice(0, 300),
    },
  });
  // The mirror of the raise above: put the office's total back where it was, so
  // withdrawing an extra shoot does not leave the job owing a video that no row
  // asks for.
  //
  // TWO THINGS THE SEP 18 REVIEW CAUGHT HERE.
  //
  // F1 — the three override columns are the OFFICE's provenance for its whole
  // override record (due date, tier, priority, type detail and videos owed are
  // all explained by the one note). Stamping them from the portal wiped
  // Jordan's typed reason on 204 Spring Ln. The number still moves; who moved
  // it and why goes on the timeline, in the Activity row this action already
  // writes a few lines down.
  //
  // Minor 2 — `owedNow > 1` lowered an override the reopen may never have
  // raised: the raise only happens on a job that ALREADY had one, so on a job
  // the office overrode AFTERWARDS this quietly took a video off the office's
  // count. The real condition is the one the raise created — the override
  // standing above the video rows that remain. Below that floor there is
  // nothing of ours left to give back.
  const owedNow = project?.videosOwedOverride ?? 0;
  const videoRowsLeft = project?.deliverables.length ?? 0;
  const lowered = owedNow > 1 && owedNow > videoRowsLeft;
  if (lowered) {
    await prisma.project.update({
      where: { id: projectId },
      data: { videosOwedOverride: owedNow - 1 },
    });
  }
  const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
  await ensureOutputsSafely(projectId, `upload-additional-shoot-withdrawn#${d.id}`);

  // Kyle's card goes with it — the same withdrawal removeShootAddOn performs,
  // found by the key the item name slugifies to rather than by an id the client
  // would have to hand back.
  if (isAdditionalVideoType(d.type)) {
    const key = shootAddonKey(projectId, additionalShootItem(d.type, etDayKey(d.capturedAt)));
    const t = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true, status: true } });
    if (t && t.status !== "COMPLETED" && t.status !== "CANCELLED") {
      await prisma.smartTask.update({
        where: { id: t.id },
        // dedupeKey freed so the same extra shoot can be logged again — the
        // same reason removeShootAddOn frees it.
        data: { status: "CANCELLED", completedAt: new Date(), dedupeKey: null },
      }).catch(() => {});
    }
  }

  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.NOTE,
      body: `Extra shoot withdrawn by ${who} — “${d.label ?? d.type}” is no longer owed on ${streetOf(project?.title)}. The row is kept, not deleted.${lowered ? ` Videos owed put back ${owedNow} → ${owedNow - 1}; the office's own override note is untouched.` : ""}`.slice(0, 1000),
    },
  }).catch(() => {});

  revalidatePath("/upload");
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
