"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { authEnforced, requireCutReviewer } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { editorHoldsAssignedWork } from "@/lib/editorWork";
import type { SelfCheckInput, SelfCheckItem } from "@/lib/selfCheck";

// ---------------------------------------------------------------------------
// THE EDITOR'S SELF-CHECK — the doors that are not an upload (§8.2, Sep 25).
//
// An upload carries its check on startCutUpload, and the Final-folder button
// on submitCutForReview. This file is the third way in: FINISHING the check on
// a cut that already exists but is held — found by the folder sweep, an upload
// whose bytes were not the file that was checked, a cut moved to another job.
// The editor whose cut it is, or the office on their behalf (recorded as the
// office, for the editor named). Nothing here can rule on a cut.
// ---------------------------------------------------------------------------

type Actor = { name: string; userId: string | null; editorKey: string | null; office: boolean };

async function checkActorFor(row: { projectId: string; submittedByKey: string | null }): Promise<{ ok: true; actor: Actor } | { ok: false; message: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    if (!authEnforced()) return { ok: true, actor: { name: "Local dev", userId: null, editorKey: null, office: true } };
    return { ok: false, message: "Sign in to finish the check." };
  }
  if (me.impersonating) return { ok: false, message: "You're previewing another user — exit the preview to make changes." };
  if (me.realRole === "OWNER" || me.realRole === "ADMIN") {
    return { ok: true, actor: { name: me.name ?? me.email, userId: me.id, editorKey: null, office: true } };
  }
  if (me.realRole !== "EDITOR") return { ok: false, message: "Only the editor, Kyle or Jordan can finish this check." };
  const key = me.editorKey;
  if (!key) return { ok: false, message: "Your account is not linked to an editor profile yet — ask Jordan or Kyle." };
  // THEIR cut, or an unclaimed one on a job they hold — the same scope an
  // upload has (review/actions.uploadAuthor).
  if (row.submittedByKey && row.submittedByKey !== key) return { ok: false, message: "That cut was handed in by another editor." };
  if (!row.submittedByKey) {
    const mine = await editorHoldsAssignedWork(row.projectId, key);
    if (!mine) return { ok: false, message: "This job isn't on your queue — ask Kyle or Jordan to assign it to you first." };
  }
  return { ok: true, actor: { name: me.name ?? me.email, userId: me.id, editorKey: key, office: false } };
}

/** Finish the check on a held cut and send it to review. */
export async function submitSelfCheck(
  submissionId: string,
  input: SelfCheckInput,
): Promise<{ ok: boolean; message: string; needsSelfCheck?: boolean }> {
  if (typeof submissionId !== "string" || !submissionId) return { ok: false, message: "Which cut?" };
  const row = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, status: true, assetPath: true, blobUrl: true, movedAt: true, submittedByKey: true, selfCheckId: true, selfCheckedAt: true },
  });
  if (!row) return { ok: false, message: "That cut no longer exists." };
  const who = await checkActorFor(row);
  if (!who.ok) return who;
  const { isHeldForSelfCheck } = await import("@/lib/selfCheck");
  if (!isHeldForSelfCheck(row)) return { ok: true, message: row.status === "PENDING" ? "Already in review." : "That version isn't waiting on a check any more." };
  // A Final-folder cut (not moved) goes through the editor's own button, which
  // owns its close-out — the same gate, the same single entry.
  if (row.assetPath && !row.blobUrl && !row.movedAt) {
    const { submitCutForReview } = await import("@/app/review/actions");
    const r = await submitCutForReview(row.projectId, undefined, input, { submissionId: row.id });
    return { ok: r.ok, message: r.message, needsSelfCheck: r.needsSelfCheck };
  }
  const { attestAndEnter } = await import("@/lib/selfCheckStore");
  const r = await attestAndEnter(row.id, input, who.actor);
  revalidatePath(`/edit/${row.projectId}`);
  revalidatePath(`/review/${row.projectId}`);
  revalidatePath("/review");
  revalidatePath("/editing");
  return { ok: r.ok, message: r.message, needsSelfCheck: r.needsSelfCheck };
}

// ---------------------------------------------------------------------------
// THE UPLOAD PANEL'S JOB-LEVEL FACTS (Oct 5). The /edit page hands the Send to
// Review panel only the selected video's row, so the panel asked "0 of 1
// approved" of a four-video job and could not say who the cut went to or which
// video is next. One read, for anyone who may see the job: the job's own
// approved count, who a new version goes to first, the reviewer actually
// holding a just-sent version, and every owed video in the page's numbering
// with its topic and whether it still owes a cut. Read-only.
// ---------------------------------------------------------------------------

export type UploadPanelVideo = {
  key: string;
  /** the DeliverableOutput id — what /edit/<id>?output= selects */
  outputId: string | null;
  /** "Video 2" — the same number the page's Videos row prints */
  number: number;
  topic: string | null;
  /** still owes a cut: nothing in, sent back, or waiting on the editor's check */
  open: boolean;
};
export type UploadPanelSummary = {
  approved: number;
  total: number;
  /** first name of whoever a new version goes to first; null = nobody set up */
  firstReviewer: string | null;
  /** first name of the reviewer holding `submissionId`, once one is assigned */
  sentTo: string | null;
  videos: UploadPanelVideo[];
};

export async function uploadPanelSummary(projectId: string, opts: { submissionId?: string | null } = {}): Promise<UploadPanelSummary | null> {
  if (typeof projectId !== "string" || !projectId) return null;
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) return null;
  if (me?.role === "PHOTOGRAPHER") return null;
  const { canViewProject } = await import("@/lib/auth/guards");
  if (!(await canViewProject(projectId, me))) return null;
  const { cutSlots, slotKeyOf } = await import("@/lib/reviewCuts");
  const { isHeldForSelfCheck } = await import("@/lib/selfCheck");
  const { videoNavigationFor } = await import("@/lib/videoNavigation");
  const { firstName } = await import("@/lib/reviewAttribution");
  const ra = await import("@/lib/reviewerAssignment");
  const [slots, rounds, outputs, navigation, chain, sent] = await Promise.all([
    cutSlots(projectId).catch(() => []),
    prisma.reviewSubmission.findMany({
      where: { projectId, deliverableId: { not: null }, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } },
      orderBy: { round: "asc" },
      select: { deliverableId: true, slot: true, status: true, selfCheckId: true, selfCheckedAt: true },
    }),
    prisma.deliverableOutput.findMany({ where: { projectId }, select: { id: true, deliverableId: true, slot: true, title: true } }),
    videoNavigationFor(projectId).catch(() => new Map<string, { number: number; total: number }>()),
    ra.resolveActiveReviewer().catch(() => null),
    opts.submissionId
      ? prisma.reviewSubmission.findUnique({ where: { id: opts.submissionId }, select: { projectId: true, reviewerTeamMemberId: true } })
      : Promise.resolve(null),
  ]);
  // Newest round per video, the way the page counts: any round for "approved"
  // (the page's own tally), a round that wasn't taken back for "still owed".
  const latest = new Map<string, (typeof rounds)[number]>();
  const latestLive = new Map<string, (typeof rounds)[number]>();
  for (const r of rounds) {
    const k = slotKeyOf(r.deliverableId!, r.slot);
    latest.set(k, r);
    if (r.status !== "WITHDRAWN") latestLive.set(k, r);
  }
  const outputOf = new Map(outputs.map((o) => [slotKeyOf(o.deliverableId, o.slot), o]));
  const videos = slots.map((s, i): UploadPanelVideo => {
    const key = slotKeyOf(s.deliverableId, s.slot);
    const live = latestLive.get(key);
    const out = outputOf.get(key);
    return {
      key,
      outputId: out?.id ?? null,
      number: navigation.get(key)?.number ?? i + 1,
      topic: s.topicTitle?.trim() || out?.title?.trim() || null,
      open: !live || live.status === "CHANGES_REQUESTED" || isHeldForSelfCheck(live),
    };
  });
  let sentTo: string | null = null;
  if (sent && sent.projectId === projectId && sent.reviewerTeamMemberId) {
    const names = await ra.reviewerNamesFor([sent.reviewerTeamMemberId]).catch(() => new Map<string, string>());
    sentTo = firstName(names.get(sent.reviewerTeamMemberId)) ?? null;
  }
  return {
    approved: slots.filter((s) => latest.get(slotKeyOf(s.deliverableId, s.slot))?.status === "APPROVED").length,
    total: slots.length,
    firstReviewer: firstName(chain?.name) ?? null,
    sentTo,
    videos,
  };
}

/**
 * James (or Jordan) refines a product's checklist (§8.2: "James can refine
 * checklist requirements by product"). A refinement is a NEW VERSION: checks
 * already given keep the list they were given under. "Watched the actual
 * export" cannot be removed — resolveSelfCheckProfile puts it back.
 */
export async function saveSelfCheckProfile(
  styleKey: string,
  items: SelfCheckItem[],
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireCutReviewer();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { DEFAULT_SELF_CHECK } = await import("@/lib/selfCheck");
  if (!DEFAULT_SELF_CHECK[styleKey]) return { ok: false, message: "Unknown product." };
  const clean = (Array.isArray(items) ? items : [])
    .filter((i) => i && typeof i.key === "string" && typeof i.label === "string" && i.label.trim().length >= 8)
    .slice(0, 20)
    .map((i) => ({
      key: i.key.replace(/[^a-z0-9_]/gi, "_").slice(0, 40) || "item",
      label: i.label.trim().slice(0, 240),
      help: typeof i.help === "string" && i.help.trim() ? i.help.trim().slice(0, 300) : undefined,
      naAllowed: !!i.naAllowed,
      naHint: typeof i.naHint === "string" && i.naHint.trim() ? i.naHint.trim().slice(0, 160) : undefined,
      when: i.when === "revision" ? ("revision" as const) : ("always" as const),
    }));
  if (clean.length < 3) return { ok: false, message: "Keep at least three lines on the list." };
  const { selfCheckOverrides, SELF_CHECK_SETTING } = await import("@/lib/selfCheckStore");
  const { putSetting } = await import("@/lib/settings");
  const { resolveSelfCheckProfile } = await import("@/lib/selfCheck");
  const current = await selfCheckOverrides();
  const was = resolveSelfCheckProfile(styleKey, current);
  const me = await getCurrentUser().catch(() => null);
  await putSetting(SELF_CHECK_SETTING, { ...current, [styleKey]: { version: was.version + 1, items: clean } }, me?.name ?? me?.email ?? null);
  revalidatePath("/quality");
  return { ok: true, message: `Saved as version ${was.version + 1} — new checks use it; earlier ones keep theirs.` };
}
