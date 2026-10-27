"use server";

// ---------------------------------------------------------------------------
// THE UPLOAD PAGE'S NEW WRITES (Oct 23 2026, Jordan's upload-page spec): what
// a photographer says they captured, the shared instructions on a shared
// shoot, a request the agent made on site, a service added on site and the
// instructions for a video added on site. Every one checks the page's own
// access rule (requireUploadAccess: the shoot's photographer, a second
// shooter on it, or the office; never a "view as" preview) and answers
// {ok, message} instead of throwing, so a refusal reads as words on a phone.
//
// Heavy modules load inside the functions (the file is also loaded by the
// portal's render in the drills, where nothing here may reach a database).
// None of these writes Project stamps, pay lines or KPI evidence: the submit
// (actions.finalizeUpload) is still the only thing that hands work off.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import type { Contribution, ServiceKey, SharedNote } from "@/lib/sharedShootCore";
import type { AgentRequestItem } from "@/lib/agentRequestsCore";

type Who = { memberId: string | null; key: string; name: string; actor: string; office: boolean; money: boolean };

async function who(projectId: string): Promise<{ ok: true; who: Who } | { ok: false; message: string }> {
  try {
    const { requireUploadAccess } = await import("@/lib/auth/guards");
    await requireUploadAccess(projectId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "You don't have access to that shoot." };
  }
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: "You're previewing as someone else, so nothing can be saved from here." };
  const { photographerMemberId } = await import("@/lib/shoot");
  const memberId = me ? await photographerMemberId(me).catch(() => null) : null;
  const { displayNameFor } = await import("@/lib/actorName");
  const name = ((await displayNameFor(me).catch(() => null)) || me?.name || "the office").trim().slice(0, 80);
  const office = !me || me.role === "OWNER" || me.role === "ADMIN" || me.role === "CREATIVE_MANAGER";
  // Amounts in the agent's words: the owner only (lib/agentRequests).
  const money = !me || me.role === "OWNER";
  return { ok: true, who: { memberId, key: memberId ?? me?.email?.toLowerCase() ?? "office", name, actor: me?.email?.trim().toLowerCase() ?? "local-development", office, money } };
}

function refresh(projectId: string) {
  for (const p of [`/upload/${projectId}`, `/edit/${projectId}`, `/projects/${projectId}`]) revalidatePath(p);
}

/** Is this person on the shoot's roster (an appointment, the job, or crew)? Only they have a part of their own. */
async function onRoster(projectId: string, memberId: string | null): Promise<boolean> {
  if (!memberId) return false;
  const { shootRoster } = await import("@/lib/sharedShoot");
  return (await shootRoster(projectId)).members.some((m) => m.memberId === memberId);
}

// ---- what I captured ------------------------------------------------------------

export async function saveMyCapture(
  projectId: string,
  input: { captured: string[]; videoDrone: boolean },
): Promise<{ ok: boolean; message: string; contribution?: Contribution | null }> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  // The office (or anyone not on the roster) has no part of its own: the
  // selection stays on their page and in their draft.
  if (!(await onRoster(projectId, w.who.memberId))) return { ok: true, message: "Kept on this page.", contribution: null };
  const { isServiceKey } = await import("@/lib/sharedShootCore");
  const { writeContribution } = await import("@/lib/sharedShoot");
  try {
    const c = await writeContribution(projectId, { memberId: w.who.memberId!, name: w.who.name, actor: w.who.actor }, {
      captured: (input.captured ?? []).filter(isServiceKey).slice(0, 10),
      videoDrone: input.videoDrone === true,
    });
    refresh(projectId);
    return { ok: true, message: "Saved.", contribution: c };
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Couldn't save that. Try again." };
  }
}

/**
 * "My selected files are uploaded": the person's word, per service. It ticks
 * the matching ordered items off (the same tick the item list has always
 * had, actions.markDeliverableUploaded) and records it on their part. It
 * never says files were FOUND: only a Dropbox read says that. Unticking takes
 * an item's tick off only when nobody else on the shoot says theirs is in.
 */
export async function markMyUploads(
  projectId: string,
  input: { services: string[]; uploaded: boolean },
): Promise<{ ok: boolean; message: string; ticks?: Record<string, boolean>; contribution?: Contribution | null }> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const { isServiceKey, serviceOfType } = await import("@/lib/sharedShootCore");
  const services = (input.services ?? []).filter(isServiceKey);
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.deliverable.findMany({
    where: { projectId, removedFromOrderAt: null },
    select: { id: true, type: true, uploadedAt: true, status: true, notCompletedReason: true, waivedAt: true },
  });
  const { readContributions, writeContribution } = await import("@/lib/sharedShoot");
  const mine = await onRoster(projectId, w.who.memberId);
  const others = [...(await readContributions(projectId)).values()].filter((c) => c.memberId !== w.who.memberId);
  const claimedByOthers = new Set(others.flatMap((c) => c.uploaded));
  const { markDeliverableUploaded } = await import("@/app/upload/actions");
  const ticks: Record<string, boolean> = {};
  for (const d of rows) {
    const s = serviceOfType(d.type);
    if (!s || !services.includes(s) || d.waivedAt) continue;
    // A "couldn't complete" answer is never silently turned into an upload.
    if (input.uploaded && d.notCompletedReason) continue;
    const on = d.uploadedAt != null || ["UPLOADED", "IN_PROGRESS", "DONE"].includes(d.status);
    if (input.uploaded && !on) { await markDeliverableUploaded(d.id, true); ticks[d.id] = true; }
    if (!input.uploaded && d.uploadedAt && !claimedByOthers.has(s)) { await markDeliverableUploaded(d.id, false); ticks[d.id] = false; }
  }
  let contribution: Contribution | null = null;
  if (mine) {
    const cur = (await readContributions(projectId)).get(w.who.memberId!);
    const set = new Set<ServiceKey>(cur?.uploaded ?? []);
    for (const s of services) { if (input.uploaded) set.add(s); else set.delete(s); }
    contribution = await writeContribution(projectId, { memberId: w.who.memberId!, name: w.who.name, actor: w.who.actor }, { uploaded: [...set] }).catch(() => null);
  }
  refresh(projectId);
  return { ok: true, message: input.uploaded ? "Marked as uploaded. Dropbox still has to show the files." : "Unmarked.", ticks, contribution };
}

/**
 * A shared-shoot part with no handoff half of its own (a floor plan or a 3D
 * tour, say): it is recorded on the person's part, said on the timeline, and
 * hands nothing else off. Photos and video go through the normal submit.
 */
export async function submitMyPart(projectId: string, input: { services: string[] }): Promise<{ ok: boolean; message: string; contribution?: Contribution | null }> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  if (!(await onRoster(projectId, w.who.memberId))) return { ok: false, message: "Only the photographers on this shoot submit a part of their own." };
  const { isServiceKey, SERVICE_LABEL } = await import("@/lib/sharedShootCore");
  const services = (input.services ?? []).filter(isServiceKey);
  if (!services.length) return { ok: false, message: "Tick what you captured first, then submit your part." };
  const { writeContribution } = await import("@/lib/sharedShoot");
  const c = await writeContribution(projectId, { memberId: w.who.memberId!, name: w.who.name, actor: w.who.actor }, {
    captured: services,
    submit: { scope: "part", services, atISO: new Date().toISOString() },
  });
  const { prisma } = await import("@/lib/prisma");
  await prisma.activity
    .create({ data: { projectId, type: "NOTE", body: `${w.who.name} submitted their part on the upload page${services.length ? ` (${services.map((s) => SERVICE_LABEL[s]).join(", ")})` : ""}.` } })
    .catch(() => {});
  refresh(projectId);
  return { ok: true, message: "Your part is submitted.", contribution: c };
}

// ---- shared instructions ----------------------------------------------------------

export type SharedNoteAnswer = { ok: boolean; message: string; note?: SharedNote | null; current?: SharedNote | null; changed?: boolean };

export async function addSharedInstruction(projectId: string, text: string): Promise<SharedNoteAnswer> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const { addSharedNote } = await import("@/lib/sharedShoot");
  const r = await addSharedNote(projectId, { key: w.who.key, name: w.who.name, actor: w.who.actor }, String(text ?? "").slice(0, 4000)).catch((e: Error) => ({ ok: false as const, message: e.message || "Couldn't save that.", current: null }));
  if (r.ok) refresh(projectId);
  return r.ok ? { ok: true, message: r.changed ? "Added." : "That instruction is already on the job.", note: r.note, changed: r.changed } : { ok: false, message: r.message, current: r.current };
}

export async function editSharedInstruction(projectId: string, entryId: string, expectedVersion: number, text: string): Promise<SharedNoteAnswer> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const { editSharedNote } = await import("@/lib/sharedShoot");
  const r = await editSharedNote(projectId, { key: w.who.key, name: w.who.name, actor: w.who.actor }, String(entryId ?? "").slice(0, 64), Number(expectedVersion), String(text ?? "").slice(0, 4000)).catch((e: Error) => ({ ok: false as const, message: e.message || "Couldn't save that.", current: null }));
  if (r.ok) refresh(projectId);
  return r.ok ? { ok: true, message: r.changed ? "Saved." : "Nothing changed.", note: r.note, changed: r.changed } : { ok: false, message: r.message, current: r.current };
}

export async function removeSharedInstruction(projectId: string, entryId: string, expectedVersion: number): Promise<SharedNoteAnswer> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const { editSharedNote } = await import("@/lib/sharedShoot");
  const r = await editSharedNote(projectId, { key: w.who.key, name: w.who.name, actor: w.who.actor }, String(entryId ?? "").slice(0, 64), Number(expectedVersion), "", { remove: true }).catch((e: Error) => ({ ok: false as const, message: e.message || "Couldn't save that.", current: null }));
  if (r.ok) refresh(projectId);
  return r.ok ? { ok: true, message: "Removed. It stays in the history.", note: r.note, changed: true } : { ok: false, message: r.message, current: r.current };
}

// ---- a request the agent made on site --------------------------------------------

export async function addAgentRequest(
  projectId: string,
  input: { text: string; medium: string },
): Promise<{ ok: boolean; duplicate?: boolean; message: string; items?: AgentRequestItem[] }> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const medium = input.medium === "photo" || input.medium === "video" ? input.medium : "both";
  const { addOnSiteRequest } = await import("@/lib/agentRequests");
  try {
    const r = await addOnSiteRequest({ projectId, text: String(input.text ?? ""), medium, by: { name: w.who.name }, office: w.who.office, money: w.who.money });
    if (r.ok) refresh(projectId);
    return r;
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Couldn't save that. Try again." };
  }
}

// ---- "I couldn't fulfill this" (Oct 27 2026, lib/agentRequests) -------------------

export async function markRequestNotFulfilled(
  projectId: string,
  input: { requestId: string; why: string },
): Promise<{ ok: boolean; message: string; items?: AgentRequestItem[] }> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const { requestNotFulfilled } = await import("@/lib/agentRequests");
  try {
    const r = await requestNotFulfilled({ projectId, requestId: String(input.requestId ?? ""), why: String(input.why ?? ""), by: { name: w.who.name }, office: w.who.office, money: w.who.money });
    if (r.ok) refresh(projectId);
    return r;
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Couldn't save that. Try again." };
  }
}

export async function undoRequestNotFulfilled(projectId: string, input: { requestId: string }): Promise<{ ok: boolean; message: string; items?: AgentRequestItem[] }> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const { withdrawNotFulfilled } = await import("@/lib/agentRequests");
  try {
    const r = await withdrawNotFulfilled({ projectId, requestId: String(input.requestId ?? ""), office: w.who.office, money: w.who.money });
    if (r.ok) refresh(projectId);
    return r;
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Couldn't undo that. Try again." };
  }
}

// ---- "Video half shot: needs a second appointment" (Oct 27 2026) ------------------
// Jordan: "the video half shot, hold it for the next appointment should really
// just be on the upload portal ... they were the ones shooting it." The SAME
// hold the office's control sets (lib/secondShoot markVideoWaitingOnShoot):
// the video leaves the editors' queue and every clock until footage from a
// later appointment is in or the office releases it. Undo takes the hold back
// while it has not been released.

export async function setVideoHalfShot(
  projectId: string,
  input: { key: string; on: boolean },
): Promise<{ ok: boolean; message: string; waiting?: string | null }> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const key = String(input.key ?? "");
  try {
    const ss = await import("@/lib/secondShoot");
    if (input.on) {
      const r = await ss.markVideoWaitingOnShoot({ projectId, key, note: HALF_SHOT_NOTE, actor: w.who.name });
      if (r.ok) refresh(projectId);
      return { ok: r.ok, message: r.ok ? "Held for the next appointment. The editor won't start this video until that footage is in." : r.message, waiting: r.ok ? HALF_SHOT_NOTE : null };
    }
    const r = await ss.clearVideoWaitingOnShoot({ projectId, key, actor: w.who.name });
    if (r.ok) refresh(projectId);
    return { ok: r.ok, message: r.message, waiting: r.ok ? null : undefined };
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Couldn't save that. Try again." };
  }
}

const HALF_SHOT_NOTE = "Half shot; needs a second appointment";

// ---- a video added on site ------------------------------------------------------
// (Adding the service itself is the Added at the shoot card, actions.addShootAddOn,
// unchanged: its task, its bell, its billing note, the reconcile that closes it.)

export async function saveAddedVideo(projectId: string, input: { taskId: string; text: string }): Promise<{ ok: boolean; message: string; attachedKey?: string | null }> {
  const w = await who(projectId);
  if (!w.ok) return { ok: false, message: w.message };
  const { saveAddedVideoInstructions } = await import("@/lib/addedOnSite");
  try {
    const r = await saveAddedVideoInstructions(projectId, { taskId: String(input.taskId ?? ""), text: String(input.text ?? ""), byName: w.who.name, actor: w.who.actor });
    if (r.ok) refresh(projectId);
    return r;
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Couldn't save that. Try again." };
  }
}
