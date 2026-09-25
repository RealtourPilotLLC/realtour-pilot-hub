"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import { setOwnerOverride, type OwnerDuty, OWNER_DUTIES } from "@/lib/contentProgram";
import {
  changePackage, setCallMode, setEnrollmentStatus, setBillingTerms, setWorkflowFlags, setOverride,
  OVERRIDE_KEYS, type CurrentMonthChoice, type OverrideKey,
} from "@/lib/enrollmentChanges";
import {
  createAssetWithVersion, addAssetVersion, setActiveAssetVersion, retireAsset, updateAssetMeta,
  isAssetType, type AssetType,
} from "@/lib/clientAssets";
import type { CallMode } from "@/lib/programMonths";

// ---------------------------------------------------------------------------
// The client file's write surface (spec §17). Two rules hold for every action
// in this file, and they are the reason it is separate from the program
// actions:
//
//   · NOTHING HERE TOUCHES BILLING. Not Stripe, not QuickBooks, not Aryeo.
//     `setBillingTerms` records what Jordan has AGREED with a client, as a
//     ledger row plus a column — it can no more charge someone than a note
//     can. The Settings tab says so beside the fields, in those words.
//   · EVERY CHANGE IS A LEDGER ROW FIRST. The setters in enrollmentChanges.ts
//     write ProgramEnrollmentChange before they update anything; this file
//     only supplies the actor and the revalidate.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

async function actor(): Promise<{ email: string; id: string | null }> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return { email: me?.email ?? "dev@local", id: me?.id ?? null };
}

function touch(enrollmentId: string) {
  revalidatePath(`/content/${enrollmentId}`);
  revalidatePath("/content");
}

// ---- package & enrollment --------------------------------------------------------------

/**
 * A package change (spec §17). The caller MUST supply an effective month and,
 * when that month is the one in flight, an explicit choice for its obligation:
 * KEEP the number already minted, or APPLY the new one. There is no silent
 * rewrite path — `changePackage` throws when the choice is missing.
 */
export async function changePackageAction(
  enrollmentId: string,
  input: { package: string; effectiveMonthKey: string | null; currentMonthChoice: CurrentMonthChoice | null; videosPerMonth?: number | null; sessionsPerMonth?: number | null; reason?: string | null },
): Promise<Result & { effectiveMonthKey?: string; obligationMonthKey?: string }> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const r = await changePackage(enrollmentId, input, me.email);
    touch(enrollmentId);
    // A decision this one CANCELLED is named out loud. Superseding a scheduled
    // change silently would be exactly the rewrite Jordan's rule forbids.
    const cancelled = r.superseded.length
      ? ` It replaces ${r.superseded.length} decision${r.superseded.length === 1 ? "" : "s"} that had been scheduled and will now never take effect: ${r.superseded.map((x) => x.sentence).join("; ")}. ${r.superseded.length === 1 ? "That row is" : "Those rows are"} kept in the history, marked superseded.`
      : "";
    if (r.changeIds.length === 0) {
      // A true no-op cancels nothing now (enrollmentChanges.supersedePending);
      // a revert that only retires a LATER scheduled decision says so.
      return {
        ok: true,
        message: r.superseded.length
          ? `The current terms stay.${cancelled}`
          : "Nothing changed — those are already this client's terms from that month, and nothing scheduled was cancelled.",
      };
    }
    return {
      ok: true,
      effectiveMonthKey: r.effectiveMonthKey,
      obligationMonthKey: r.obligationMonthKey,
      message: `Recorded. The package changes from ${r.effectiveMonthKey}; the video/session quantities apply from ${r.obligationMonthKey}.${cancelled} No invoice, subscription or payment was touched.`,
    };
  } catch (e) { return fail(e); }
}

export async function setCallModeAction(enrollmentId: string, mode: CallMode, noCallEligible: boolean | null, reason?: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    await setCallMode(enrollmentId, mode, noCallEligible, me.email, reason);
    touch(enrollmentId);
    return { ok: true, message: "Call requirement saved — open months re-derive their planning path." };
  } catch (e) { return fail(e); }
}

export async function setEnrollmentStatusAction(enrollmentId: string, status: "ACTIVE" | "PAUSED" | "ENDED", reason?: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    await setEnrollmentStatus(enrollmentId, status, me.email, reason);
    touch(enrollmentId);
    // Jordan's rule: paused/ended KEEP read-only portal access to released
    // work unless a person explicitly revokes it on the access card.
    return {
      ok: true,
      message: status === "ACTIVE"
        ? "Back to active."
        : `Marked ${status.toLowerCase()}. Their portal still opens, read-only, on work already released — revoke it on the Portal access card if that is what you want. No subscription was cancelled.`,
    };
  } catch (e) { return fail(e); }
}

export async function setBillingTermsAction(enrollmentId: string, terms: { type: string | null; rate: number | null; months: number | null }): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    await setBillingTerms(enrollmentId, terms, me.email);
    touch(enrollmentId);
    return { ok: true, message: "Terms recorded on the client file. This is a note of what was agreed — it does not bill anyone." };
  } catch (e) { return fail(e); }
}

export async function setWorkflowFlagsAction(enrollmentId: string, flags: { clientSuppliesTopics?: boolean; timezone?: string | null; notes?: string | null }): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    await setWorkflowFlags(enrollmentId, flags, me.email);
    touch(enrollmentId);
    return { ok: true, message: "Saved." };
  } catch (e) { return fail(e); }
}

export async function setOverrideAction(enrollmentId: string, key: string, value: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) return { ok: false, message: "Unknown override." };
  try {
    const me = await actor();
    const raw = value.trim();
    const parsed: unknown = raw === "" ? null : key === "extraSessionsAllowed" ? raw === "true" : Number(raw);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) return { ok: false, message: "That needs to be a number." };
    await setOverride(enrollmentId, key as OverrideKey, parsed, me.email);
    touch(enrollmentId);
    return { ok: true, message: raw === "" ? "Override removed — back to the program default." : "Override saved." };
  } catch (e) { return fail(e); }
}

// ---- owners ----------------------------------------------------------------------------

/** Hand a duty to somebody else for this client (or clear the override). */
export async function setEnrollmentOwnerAction(enrollmentId: string, duty: string, appUserId: string | null): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  if (!OWNER_DUTIES.includes(duty as OwnerDuty)) return { ok: false, message: "Unknown duty." };
  try {
    const me = await actor();
    await setOwnerOverride("ENROLLMENT", enrollmentId, duty as OwnerDuty, appUserId, me.email);
    touch(enrollmentId);
    return { ok: true, message: appUserId ? "Owner set for this client." : "Back to the program default." };
  } catch (e) { return fail(e); }
}

// ---- brand & assets --------------------------------------------------------------------
//
// CP-06: every change below is also RECORDED as a brand change
// (brandProfile.recordStaffAssetChange) — the editor must learn about a new
// logo whoever filed it, so a staff edit puts the same banner on the brief and
// the same confirmation task on Kyle's desk as a client's. Best-effort: the
// asset write has already happened and is the thing that matters.

async function noteBrandChange(input: Parameters<typeof import("@/lib/brandProfile").recordStaffAssetChange>[0]) {
  try {
    const { recordStaffAssetChange } = await import("@/lib/brandProfile");
    await recordStaffAssetChange(input);
  } catch (e) {
    console.warn("brand change not recorded (the asset change stands)", e);
  }
}

export async function createAssetAction(
  enrollmentId: string,
  input: { clientId: string; type: string; name: string; ownership?: string; notes?: string | null; valueText?: string | null; fileRef?: string | null; fileName?: string | null; source?: string },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!isAssetType(input.type)) return { ok: false, message: "Unknown asset type." };
  // CP-06: website / social links / music are the client's single-valued
  // profile SLOTS. A second free-standing asset of one of those types would be
  // a value the brief never reads, so "track something new" writes the slot.
  const slot = ({ WEBSITE: "website", SOCIAL_LINKS: "social", MUSIC_PREFERENCE: "music" } as Record<string, "website" | "social" | "music" | undefined>)[input.type];
  if (slot) {
    try {
      const me = await actor();
      const { setProfileSlot, alertBrandChanges } = await import("@/lib/brandProfile");
      const r = await setProfileSlot({ clientId: input.clientId, enrollmentId, key: slot, value: input.valueText ?? "", source: "staff", actor: { staffEmail: me.email, staffUserId: me.id, label: me.email } });
      if (r.changed) await alertBrandChanges(input.clientId).catch(() => {});
      touch(enrollmentId);
      return { ok: true, message: r.changed ? `Saved as the client's profile value (version ${r.versionNo}) — the editor sees it on the brief.` : "That's already the value on file." };
    } catch (e) { return fail(e); }
  }
  try {
    const me = await actor();
    const r = await createAssetWithVersion({
      clientId: input.clientId, enrollmentId, type: input.type as AssetType, name: input.name, ownership: input.ownership, notes: input.notes,
      source: (input.source as "manual" | "dropbox") ?? "manual", valueText: input.valueText ?? null, fileRef: input.fileRef ?? null, fileName: input.fileName ?? null, by: me.email,
    });
    await noteBrandChange({ assetId: r.assetId, action: "created", staff: me, enrollmentId });
    touch(enrollmentId);
    return { ok: true, message: "Added as version 1." };
  } catch (e) { return fail(e); }
}

/**
 * A NEW VERSION, never an edit in place. This is the rule the tab exists to
 * make visible: replacing a logo changes what future work uses and leaves
 * every delivered video exactly as it was delivered.
 */
export async function addAssetVersionAction(
  enrollmentId: string,
  assetId: string,
  input: { valueText?: string | null; fileRef?: string | null; fileName?: string | null; note?: string | null; source?: string },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const before = await prisma.clientAsset.findUnique({ where: { id: assetId }, select: { activeVersionId: true } });
    const r = await addAssetVersion(assetId, {
      source: (input.source as "manual" | "dropbox") ?? "manual",
      valueText: input.valueText ?? null, fileRef: input.fileRef ?? null, fileName: input.fileName ?? null, note: input.note ?? null, by: me.email,
    });
    if (r.versionId !== before?.activeVersionId) await noteBrandChange({ assetId, action: "version", staff: me, enrollmentId, fromVersionId: before?.activeVersionId ?? null });
    touch(enrollmentId);
    return { ok: true, message: `Saved as version ${r.versionNo} — it is the default for work from here on; earlier versions and what they were used on are untouched.` };
  } catch (e) { return fail(e); }
}

export async function setActiveAssetVersionAction(enrollmentId: string, assetId: string, versionId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const before = await prisma.clientAsset.findUnique({ where: { id: assetId }, select: { activeVersionId: true } });
    await setActiveAssetVersion(assetId, versionId);
    if (before?.activeVersionId !== versionId) await noteBrandChange({ assetId, action: "rollback", staff: await actor(), enrollmentId, fromVersionId: before?.activeVersionId ?? null });
    touch(enrollmentId);
    return { ok: true, message: "That version is the default again. Nothing was deleted." };
  } catch (e) { return fail(e); }
}

export async function retireAssetAction(enrollmentId: string, assetId: string, retire: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const before = await prisma.clientAsset.findUnique({ where: { id: assetId }, select: { status: true } });
    await retireAsset(assetId, retire);
    if (before && (before.status === "ACTIVE") === retire) await noteBrandChange({ assetId, action: retire ? "retired" : "restored", staff: await actor(), enrollmentId });
    touch(enrollmentId);
    return { ok: true, message: retire ? "Retired — kept on file, out of the way." : "Back in use." };
  } catch (e) { return fail(e); }
}

export async function updateAssetMetaAction(enrollmentId: string, assetId: string, patch: { name?: string; ownership?: string; notes?: string | null }): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    await updateAssetMeta(assetId, patch);
    touch(enrollmentId);
    return { ok: true, message: "Saved." };
  } catch (e) { return fail(e); }
}

/** Register a file that is already in the client's Dropbox folder as a tracked asset. */
export async function registerFolderFileAction(enrollmentId: string, input: { clientId: string; type: string; name: string; path: string; fileName: string }): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!isAssetType(input.type)) return { ok: false, message: "Unknown asset type." };
  try {
    const me = await actor();
    const r = await createAssetWithVersion({
      clientId: input.clientId, enrollmentId, type: input.type as AssetType, name: input.name,
      source: "dropbox", fileRef: input.path, fileName: input.fileName, by: me.email,
    });
    await noteBrandChange({ assetId: r.assetId, action: "created", staff: me, enrollmentId });
    touch(enrollmentId);
    return { ok: true, message: "Tracked. The file stays where it is in Dropbox." };
  } catch (e) { return fail(e); }
}

/**
 * Staff list for the owner pickers. Guarded like every other action in this
 * file: a "use server" export is a reachable endpoint, and this one hands back
 * every active owner/admin's name (or their email when they have no name).
 */
export async function staffOptions(): Promise<{ id: string; name: string }[]> {
  await requireAdmin();
  const users = await prisma.appUser.findMany({ where: { status: "ACTIVE", role: { in: ["OWNER", "ADMIN"] } }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } });
  return users.map((u) => ({ id: u.id, name: u.name ?? u.email }));
}

// ---- filming sessions: requests, bookings and addresses (CP-04 / CP-05) ---------------
//
// The staff half of the booking adapter, from the client file's Sessions panel.
// Same rule as the rest of this file: nothing here writes to Aryeo. Confirm,
// decline and approve-extra are ledger changes; Retry only re-queues (the cron
// driver makes the provider call, behind its switch and guard); an address set
// here is SAVED and then synced or handed to Kyle exactly like a client's.
// One form dispatcher, because the panel is a server component of plain forms.

export async function sessionPanelAction(formData: FormData): Promise<void> {
  try { await requireAdmin(); } catch { return; }
  const me = await actor();
  const op = String(formData.get("op") ?? "");
  const enrollmentId = String(formData.get("enrollmentId") ?? "");
  const requestId = String(formData.get("requestId") ?? "");
  const s = await import("@/lib/sessionRequests");
  try {
    if (op === "confirm" && requestId) {
      const appointmentId = String(formData.get("appointmentId") ?? "").trim();
      const appt = appointmentId ? await prisma.appointment.findUnique({ where: { aryeoId: appointmentId }, select: { projectId: true } }) : null;
      if (appointmentId && !appt) throw new Error("No appointment with that Aryeo id has synced yet.");
      await s.confirmSessionRequest(requestId, { aryeoAppointmentId: appointmentId || null, projectId: appt?.projectId ?? null }, me.email);
    } else if (op === "decline" && requestId) {
      await s.declineSessionRequest(requestId, me.email, String(formData.get("reason") ?? "") || "declined by the office");
    } else if (op === "approveExtra" && requestId) {
      await s.approveExtraSession(requestId, me.email);
    } else if (op === "retry" && requestId) {
      const { retrySessionBooking } = await import("@/lib/sessionBooking");
      const r = await retrySessionBooking(requestId, { confirmedNoOrder: formData.get("confirmedNoOrder") === "on", by: me.email });
      if (!r.ok) throw new Error(r.message);
    } else if (op === "addressRecheck") {
      const { recheckSessionAddress } = await import("@/lib/sessionAddress");
      await recheckSessionAddress(String(formData.get("rowId") ?? ""));
    } else if (op === "addressSet") {
      const { submitSessionAddress } = await import("@/lib/sessionAddress");
      await submitSessionAddress(
        { kind: "STAFF", enrollmentId, sessionKey: String(formData.get("sessionKey") ?? ""), by: me.email },
        { street: String(formData.get("street") ?? ""), unit: String(formData.get("unit") ?? ""), city: String(formData.get("city") ?? ""), state: String(formData.get("state") ?? ""), zip: String(formData.get("zip") ?? "") },
      ).then(async (r) => {
        // A refusal (not an address, session gone) is shown on the row, since a plain form has no reply channel.
        if (!r.ok) await prisma.programSessionAddress.updateMany({ where: { sessionKey: String(formData.get("sessionKey") ?? "") }, data: { lastError: `staff: ${r.message}`, lastErrorAt: new Date() } });
      });
    }
  } catch (e) {
    // Plain forms have no reply channel, so the refusal lands on the row the panel shows.
    const msg = `staff action failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    if (requestId) await prisma.programSessionRequest.update({ where: { id: requestId }, data: { lastError: msg, lastErrorAt: new Date() } }).catch(() => null);
  } finally {
    if (enrollmentId) touch(enrollmentId);
  }
}

// ---- the library's identity tool (CP-12) ---------------------------------------------
//
// Title / topic / file-pairing corrections from the Content tab. Admin-only:
// a relink changes which file the client downloads. Each lib function fences
// to this enrollment, writes a ContentVideoCorrection row per changed field in
// the same transaction as the change, and re-syncs the library. Nothing here
// touches a provider — the file stays where it is; only which video it is
// counted as changes.

export async function correctVideoIdentityAction(
  enrollmentId: string,
  videoId: string,
  patch: { title?: string | null; topicId?: string | null; scriptId?: string | null; kind?: string | null; confirmMonth?: boolean },
  reason?: string | null,
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { correctVideoIdentity } = await import("@/lib/contentVideos");
    const r = await correctVideoIdentity(enrollmentId, videoId, patch, (await actor()).email, reason);
    if (r.ok) touch(enrollmentId);
    return { ok: r.ok, message: r.message };
  } catch (e) { return fail(e); }
}

export async function relinkDeliveredFileAction(enrollmentId: string, sourceId: string, targetVideoId: string, reason: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  // It changes which file a client downloads: the reason is not optional.
  if (!reason?.trim()) return { ok: false, message: "Say why first — moving a file changes what the client downloads." };
  try {
    const { relinkDeliveredFile } = await import("@/lib/contentVideos");
    const r = await relinkDeliveredFile(enrollmentId, sourceId, targetVideoId, (await actor()).email, reason);
    if (r.ok) touch(enrollmentId);
    return { ok: r.ok, message: r.message };
  } catch (e) { return fail(e); }
}

export async function confirmPairingAction(enrollmentId: string, sourceId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { confirmPairing } = await import("@/lib/contentVideos");
    const r = await confirmPairing(enrollmentId, sourceId, (await actor()).email);
    if (r.ok) touch(enrollmentId);
    return { ok: r.ok, message: r.message };
  } catch (e) { return fail(e); }
}

export async function adoptTopicVideoAction(enrollmentId: string, chainVideoId: string, topicVideoId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { adoptTopicVideo } = await import("@/lib/contentVideos");
    const r = await adoptTopicVideo(enrollmentId, chainVideoId, topicVideoId, (await actor()).email);
    if (r.ok) touch(enrollmentId);
    return { ok: r.ok, message: r.message };
  } catch (e) { return fail(e); }
}

// ---- the program conversation (CP-13) ---------------------------------------------------

/** Reply on the client's program conversation. Answers every waiting message and closes the desk task. */
export async function postProgramMessageAction(enrollmentId: string, body: string, replyToId: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    const { postStaffMessage } = await import("@/lib/programMessages");
    const r = await postStaffMessage(String(enrollmentId ?? ""), { id: me?.id ?? null, name: me?.realName ?? me?.name ?? null, email: me?.email ?? null }, String(body ?? ""), replyToId ?? null);
    touch(enrollmentId);
    return { ok: r.ok, message: r.message };
  } catch (e) { return fail(e); }
}

/** "No reply needed" — closes the waiting run without sending anything. */
export async function markProgramThreadHandledAction(enrollmentId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const me = await actor();
    const { markThreadHandled } = await import("@/lib/programMessages");
    const r = await markThreadHandled(String(enrollmentId ?? ""), { id: me.id, email: me.email });
    touch(enrollmentId);
    return { ok: true, message: r.handled ? `Marked ${r.handled} message${r.handled === 1 ? "" : "s"} as needing no reply.` : "Nothing was waiting." };
  } catch (e) { return fail(e); }
}
