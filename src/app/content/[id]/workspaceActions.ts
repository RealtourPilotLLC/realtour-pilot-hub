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
      return { ok: true, message: `Nothing changed — those are already this client's terms.${cancelled}` };
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

export async function createAssetAction(
  enrollmentId: string,
  input: { clientId: string; type: string; name: string; ownership?: string; notes?: string | null; valueText?: string | null; fileRef?: string | null; fileName?: string | null; source?: string },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!isAssetType(input.type)) return { ok: false, message: "Unknown asset type." };
  try {
    const me = await actor();
    await createAssetWithVersion({
      clientId: input.clientId, enrollmentId, type: input.type as AssetType, name: input.name, ownership: input.ownership, notes: input.notes,
      source: (input.source as "manual" | "dropbox") ?? "manual", valueText: input.valueText ?? null, fileRef: input.fileRef ?? null, fileName: input.fileName ?? null, by: me.email,
    });
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
    const r = await addAssetVersion(assetId, {
      source: (input.source as "manual" | "dropbox") ?? "manual",
      valueText: input.valueText ?? null, fileRef: input.fileRef ?? null, fileName: input.fileName ?? null, note: input.note ?? null, by: me.email,
    });
    touch(enrollmentId);
    return { ok: true, message: `Saved as version ${r.versionNo} — it is the default for work from here on; earlier versions and what they were used on are untouched.` };
  } catch (e) { return fail(e); }
}

export async function setActiveAssetVersionAction(enrollmentId: string, assetId: string, versionId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    await setActiveAssetVersion(assetId, versionId);
    touch(enrollmentId);
    return { ok: true, message: "That version is the default again. Nothing was deleted." };
  } catch (e) { return fail(e); }
}

export async function retireAssetAction(enrollmentId: string, assetId: string, retire: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    await retireAsset(assetId, retire);
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
    await createAssetWithVersion({
      clientId: input.clientId, enrollmentId, type: input.type as AssetType, name: input.name,
      source: "dropbox", fileRef: input.path, fileName: input.fileName, by: me.email,
    });
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
