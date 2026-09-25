import "server-only";
import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockAdvisory } from "@/lib/dbLocks";
import {
  addAssetVersion, createAssetWithVersion, assetRegistry, productionDefaults, listClientAssets, isClearedVersion,
  ASSET_TYPE_WORDS, isAssetType, type AssetType,
} from "@/lib/clientAssets";
import { can, actorLabel, refusalMessage } from "@/lib/portalAccess";
import type { PortalViewer } from "@/lib/portal";
import { isTestClientName } from "@/lib/testClients";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { clip, scrubMoney, stripMoneySentences } from "@/lib/text";

// ---------------------------------------------------------------------------
// THE BRAND PROFILE — one spine for every change to what a client's videos
// look and sound like (completion audit CP-06 / CP-11, Sep 24 2026).
//
// What the audit found: the portal's Brand Profile was three strings and an
// untyped upload button; a client could not clear a field (blanks were
// dropped, and a mixed save reported "Saved" while dropping the clear); portal
// uploads went to Dropbox and nowhere else, so the asset registry the staff
// Brand tab renders never heard of them; and the only signal anyone got was an
// owner bell. The editor — the person the whole profile exists for — was never
// told, and nothing on their brief read the registry at all.
//
// So every change now goes through here, whoever makes it:
//   · the client on their portal (saveClientBrandProfile, recordPortalAssetUpload)
//   · staff on the client file's Brand tab (recordStaffAssetChange)
//   · a person applying a change proposed from a call (CP-11, profileFields.ts
//     → setProfileSlotTx)
// and every change leaves a ClientBrandChange row. That row is three things at
// once: the history the three Client columns never had, the editor's banner on
// /edit/<id> until they press "Got it", and the line on Kyle's confirmation
// task. The editor's Slack DM is the only part behind a switch
// (`brand_change_alerts`, OFF): it is a message to the team, so until Jordan
// turns it on the row is stamped alertChannel "pending" and the banner and the
// task carry the news alone. Jordan never approves an asset update.
//
// STORAGE. Client.brandColors / portalVideoStyle / portalPreferences stay the
// truth for those three — /edit, the shoot brief and the profile builder read
// them. NULL means "never set" (the portal may prefill a suggestion); "" means
// "the client cleared it" (it must stay empty). Everything else lives in the
// registry: single-valued text SLOTS (fonts, website, social, music, and the
// staff-only editing/production slots CP-11 applies into) identified by
// ClientAsset.profileKey, and files as ordinary typed assets. One slot per
// (client, key) is enforced by an advisory-locked find-or-create — a unique
// constraint cannot be added to the live database by `db push`.
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient;

// ---- slots ------------------------------------------------------------------

type SlotDef = { type: AssetType; label: string; ownership: "CLIENT" | "AGENCY"; client: boolean; max: number };

/** Every single-valued text slot. `client: true` = the client edits it on the
 *  portal; the rest are staff/editor preferences a call may change (CP-11). */
export const PROFILE_SLOTS = {
  fonts: { type: "FONT", label: "Font names", ownership: "CLIENT", client: true, max: 300 },
  website: { type: "WEBSITE", label: "Website", ownership: "CLIENT", client: true, max: 500 },
  social: { type: "SOCIAL_LINKS", label: "Social links", ownership: "CLIENT", client: true, max: 1000 },
  music: { type: "MUSIC_PREFERENCE", label: "Music", ownership: "CLIENT", client: true, max: 500 },
  "editing.pace": { type: "EDITING_INSTRUCTIONS", label: "Editing pace", ownership: "AGENCY", client: false, max: 1500 },
  "editing.captions": { type: "EDITING_INSTRUCTIONS", label: "Captions", ownership: "AGENCY", client: false, max: 1500 },
  "production.wardrobe": { type: "PRODUCTION_PREFERENCE", label: "Wardrobe", ownership: "AGENCY", client: false, max: 1500 },
  "production.teleprompter": { type: "PRODUCTION_PREFERENCE", label: "Teleprompter", ownership: "AGENCY", client: false, max: 1500 },
  "production.location": { type: "PRODUCTION_PREFERENCE", label: "Filming location", ownership: "AGENCY", client: false, max: 1500 },
  "production.days": { type: "PRODUCTION_PREFERENCE", label: "Preferred filming days", ownership: "AGENCY", client: false, max: 1500 },
} as const satisfies Record<string, SlotDef>;
export type SlotKey = keyof typeof PROFILE_SLOTS;
export const isSlotKey = (k: unknown): k is SlotKey => typeof k === "string" && k in PROFILE_SLOTS;

/** The slots the CLIENT owns and edits on their Brand Profile. */
export const BRAND_SLOT_KEYS = ["fonts", "website", "social", "music"] as const;
export type BrandSlotKey = (typeof BRAND_SLOT_KEYS)[number];
export const isBrandSlotKey = (k: unknown): k is BrandSlotKey => (BRAND_SLOT_KEYS as readonly unknown[]).includes(k);

/** Whitespace-normalised, for "did this actually change". */
export const normSlot = (v: string | null | undefined): string => (v ?? "").replace(/\s+/g, " ").trim();
/** …and case-folded, for "is this still what the proposal was made against"
 *  (CP-11 drift). Both sides of a comparison must go through the same one. */
export const sameSlotValue = (a: string | null | undefined, b: string | null | undefined): boolean =>
  normSlot(a).toLowerCase() === normSlot(b).toLowerCase();

// ---- social links (one slot, five networks) ---------------------------------

export const SOCIAL_NETWORKS = ["instagram", "facebook", "tiktok", "youtube", "linkedin"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
const SOCIAL_WORDS: Record<SocialNetwork, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn" };

/** The social slot's stored text: one "Network: link" line per network given. */
export function socialToText(o: Partial<Record<SocialNetwork, string | null>>): string {
  return SOCIAL_NETWORKS.map((n) => (o[n] ?? "").trim() ? `${SOCIAL_WORDS[n]}: ${(o[n] ?? "").trim()}` : null).filter(Boolean).join("\n");
}
export function socialFromText(t: string | null | undefined): Partial<Record<SocialNetwork, string>> {
  const out: Partial<Record<SocialNetwork, string>> = {};
  for (const line of (t ?? "").split("\n")) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.+)$/.exec(line);
    const n = m ? SOCIAL_NETWORKS.find((k) => k === m[1].toLowerCase()) : undefined;
    if (n && m) out[n] = m[2].trim();
  }
  return out;
}

// ---- reading a slot -----------------------------------------------------------

export type SlotValue = {
  assetId: string;
  versionId: string | null;
  versionNo: number | null;
  /** The value in use, or null (cleared, retired, or never set). */
  value: string | null;
  cleared: boolean;
  source: string | null;
  at: Date | null;
  status: string;
};

export async function getSlot(clientId: string, key: SlotKey, db: Db = prisma): Promise<SlotValue | null> {
  // ACTIVE sorts before RETIRED, so a reactivated slot is always the one read.
  const asset = await db.clientAsset.findFirst({ where: { clientId, profileKey: key }, orderBy: [{ status: "asc" }, { createdAt: "asc" }], select: { id: true, status: true, activeVersionId: true } });
  if (!asset) return null;
  const v = asset.activeVersionId
    ? await db.clientAssetVersion.findUnique({ where: { id: asset.activeVersionId }, select: { id: true, versionNo: true, valueText: true, valueJson: true, fileRef: true, source: true, createdAt: true } })
    : null;
  const cleared = !!v && isClearedVersion(v);
  return {
    assetId: asset.id, versionId: v?.id ?? null, versionNo: v?.versionNo ?? null,
    value: asset.status === "ACTIVE" && v && !cleared ? v.valueText : null,
    cleared, source: v?.source ?? null, at: v?.createdAt ?? null, status: asset.status,
  };
}

/** Every slot's value for one client, in one read. */
export async function slotValues(clientId: string): Promise<Record<SlotKey, string | null>> {
  const out = Object.fromEntries(Object.keys(PROFILE_SLOTS).map((k) => [k, null])) as Record<SlotKey, string | null>;
  const assets = await prisma.clientAsset.findMany({ where: { clientId, profileKey: { not: null }, status: "ACTIVE" }, select: { profileKey: true, activeVersionId: true } });
  const ids = assets.map((a) => a.activeVersionId).filter((x): x is string => !!x);
  const versions = ids.length ? await prisma.clientAssetVersion.findMany({ where: { id: { in: ids } }, select: { id: true, valueText: true, valueJson: true, fileRef: true } }) : [];
  for (const a of assets) {
    const v = versions.find((x) => x.id === a.activeVersionId);
    if (a.profileKey && isSlotKey(a.profileKey) && v && !isClearedVersion(v)) out[a.profileKey] = v.valueText;
  }
  return out;
}

// ---- the change ledger ---------------------------------------------------------

export type BrandChangeKind = "SET" | "CLEARED" | "FILE_ADDED" | "FILE_REPLACED" | "APPLIED_FROM_CALL";
export type BrandChangeSource = "client_portal" | "staff" | "fact";

export type BrandChangeInput = {
  clientId: string; enrollmentId?: string | null; fieldKey: string; label: string; kind: BrandChangeKind;
  fromText?: string | null; toText?: string | null; assetId?: string | null; assetVersionId?: string | null;
  source: BrandChangeSource; factId?: string | null; proposalId?: string | null;
  clientUserId?: string | null; staffUserId?: string | null; actorLabel?: string | null;
};

/** One row per changed field. Never updated except by the alert and the acknowledgement. */
export async function recordBrandChange(c: BrandChangeInput, db: Db = prisma): Promise<string> {
  const row = await db.clientBrandChange.create({
    data: {
      clientId: c.clientId, enrollmentId: c.enrollmentId ?? null, fieldKey: c.fieldKey, label: c.label, kind: c.kind,
      fromText: c.fromText ? clip(c.fromText, 1500) : null, toText: c.toText ? clip(c.toText, 1500) : null,
      assetId: c.assetId ?? null, assetVersionId: c.assetVersionId ?? null, source: c.source, factId: c.factId ?? null, proposalId: c.proposalId ?? null,
      clientUserId: c.clientUserId ?? null, staffUserId: c.staffUserId ?? null, actorLabel: c.actorLabel ? clip(c.actorLabel, 200) : null,
    },
    select: { id: true },
  });
  return row.id;
}

// ---- writing a slot --------------------------------------------------------------

export type SlotActor = { clientUserId?: string | null; staffUserId?: string | null; staffEmail?: string | null; label: string };
export type SetSlotInput = {
  clientId: string; enrollmentId?: string | null; key: SlotKey;
  /** null or blank = clear. */
  value: string | null;
  actor: SlotActor; source: BrandChangeSource;
  factId?: string | null; proposalId?: string | null; note?: string | null;
  /** CP-11 applies a call's proposal: the ledger says so. */
  kind?: "APPLIED_FROM_CALL";
};
export type SetSlotResult = { changed: boolean; assetId: string | null; versionId: string | null; versionNo: number | null; changeId: string | null; from: string | null; to: string | null };

export const slotLockKey = (clientId: string, key: string) => `brand-slot|${clientId}|${key}`;

/**
 * Set (or clear) one slot inside the caller's transaction. Takes the slot's
 * advisory lock first (re-entrant, so CP-11's apply — which already holds it
 * while it flips the proposal — can call straight in). A value equal to the
 * one in use records nothing; clearing a slot that holds nothing records
 * nothing. Otherwise: a new version (history intact) and a ledger row.
 */
export async function setProfileSlotTx(tx: Db, input: SetSlotInput): Promise<SetSlotResult> {
  const def: SlotDef = PROFILE_SLOTS[input.key];
  await lockAdvisory(tx, slotLockKey(input.clientId, input.key));
  const current = await getSlot(input.clientId, input.key, tx);
  const next = input.value == null ? "" : clip(input.value.trim(), def.max);
  const from = current?.value ?? null;
  const noop: SetSlotResult = { changed: false, assetId: current?.assetId ?? null, versionId: current?.versionId ?? null, versionNo: current?.versionNo ?? null, changeId: null, from, to: from };
  if (!next && from == null) return noop; // nothing there to clear
  if (next && from != null && normSlot(next) === normSlot(from)) return noop;
  const cleared = !next;
  const version = {
    source: input.source === "staff" ? ("manual" as const) : input.source,
    valueText: cleared ? null : next,
    valueJson: !cleared && input.key === "social" ? JSON.stringify(socialFromText(next)) : null,
    note: input.note ?? null, cleared,
    by: input.actor.staffEmail ?? null, byClientUserId: input.actor.clientUserId ?? null,
  };
  let assetId: string;
  let versionId: string;
  if (current) {
    if (current.status !== "ACTIVE") await tx.clientAsset.update({ where: { id: current.assetId }, data: { status: "ACTIVE", retiredAt: null } });
    assetId = current.assetId;
    versionId = (await addAssetVersion(assetId, version, tx)).versionId;
  } else {
    const r = await createAssetWithVersion({ clientId: input.clientId, enrollmentId: input.enrollmentId ?? null, type: def.type, name: def.label, ownership: def.ownership, profileKey: input.key, ...version }, tx);
    assetId = r.assetId;
    versionId = r.versionId;
  }
  const v = await tx.clientAssetVersion.findUnique({ where: { id: versionId }, select: { versionNo: true } });
  const changeId = await recordBrandChange({
    clientId: input.clientId, enrollmentId: input.enrollmentId ?? null, fieldKey: `slot:${input.key}`, label: def.label,
    kind: input.kind ?? (cleared ? "CLEARED" : "SET"), fromText: from, toText: cleared ? null : next, assetId, assetVersionId: versionId,
    source: input.source, factId: input.factId ?? null, proposalId: input.proposalId ?? null,
    clientUserId: input.actor.clientUserId ?? null, staffUserId: input.actor.staffUserId ?? null, actorLabel: input.actor.label,
  }, tx);
  return { changed: true, assetId, versionId, versionNo: v?.versionNo ?? null, changeId, from, to: cleared ? null : next };
}

/** setProfileSlotTx in a transaction of its own. */
export async function setProfileSlot(input: SetSlotInput): Promise<SetSlotResult> {
  return prisma.$transaction((tx) => setProfileSlotTx(tx, input));
}

// ---- the client's own save ---------------------------------------------------------

/** undefined = leave it alone; null or "" = clear it; anything else = set it. */
export type BrandPatch = {
  brandColors?: string | null;
  videoStyle?: string | null;
  preferences?: string | null;
  slots?: Partial<Record<BrandSlotKey, string | null>>;
};
export type BrandSaveResult = { ok: boolean; message: string; saved: string[]; cleared: string[]; changeIds: string[] };

const COLUMN_FIELDS = [
  { patch: "brandColors", column: "brandColors", label: "Brand colors", max: 300 },
  { patch: "videoStyle", column: "portalVideoStyle", label: "Video style & look", max: 1500 },
  { patch: "preferences", column: "portalPreferences", label: "Working preferences", max: 1500 },
] as const;

const stampOf = (v: PortalViewer) => ({
  clientUserId: v.actor.kind === "CLIENT" ? v.actor.clientUserId : null,
  staffUserId: v.actor.kind === "STAFF" ? v.actor.staffUserId : null,
});

/**
 * The client (or staff on their behalf) saves some of their Brand Profile.
 * Compares against what is ON FILE, not against what the form started with,
 * so a stale tab cannot re-write a newer value it never showed. Writes only
 * client-owned fields — never editingPreferences / clientPreferences /
 * generalNotes / AgentProfile (admin-authored), never a staff-only slot — and
 * never another client's rows: every write is keyed on the viewer's own
 * enrollment's clientId.
 */
export async function saveClientBrandProfile(viewer: PortalViewer, patch: BrandPatch): Promise<BrandSaveResult> {
  const none = { saved: [] as string[], cleared: [] as string[], changeIds: [] as string[] };
  if (!can(viewer, "editBrandProfile")) return { ok: false, message: refusalMessage(viewer, "editBrandProfile"), ...none };
  const clientId = viewer.enrollment.clientId;
  const who = { ...stampOf(viewer), actorLabel: actorLabel(viewer) };
  const saved: string[] = [];
  const cleared: string[] = [];
  const changeIds: string[] = [];

  const onFile = await prisma.client.findUnique({ where: { id: clientId }, select: { brandColors: true, portalVideoStyle: true, portalPreferences: true } });
  if (!onFile) return { ok: false, message: "We couldn't find your account — text us and we'll sort it out.", ...none };
  const data: Record<string, string> = {};
  const rows: BrandChangeInput[] = [];
  for (const f of COLUMN_FIELDS) {
    const raw = patch[f.patch];
    if (raw === undefined) continue;
    const next = raw == null ? "" : clip(String(raw).trim(), f.max);
    const cur = onFile[f.column];
    if (next === (cur ?? "").trim()) {
      // NULL → "": nothing the editor sees changes, but the client removed the
      // suggestion we had prefilled — store the tombstone so it stays gone.
      if (!next && cur === null) { data[f.column] = ""; cleared.push(f.label); }
      continue;
    }
    data[f.column] = next;
    (next ? saved : cleared).push(f.label);
    rows.push({ clientId, enrollmentId: viewer.enrollment.id, fieldKey: f.column, label: f.label, kind: next ? "SET" : "CLEARED", fromText: cur || null, toText: next || null, source: "client_portal", ...who });
  }
  if (Object.keys(data).length) {
    await prisma.$transaction(async (tx) => {
      await tx.client.update({ where: { id: clientId }, data });
      for (const r of rows) changeIds.push(await recordBrandChange(r, tx));
    });
  }
  for (const [key, value] of Object.entries(patch.slots ?? {})) {
    if (!isBrandSlotKey(key) || value === undefined) continue; // staff-only slots are never the client's to write
    const r = await setProfileSlot({
      clientId, enrollmentId: viewer.enrollment.id, key, value, source: "client_portal",
      actor: { clientUserId: who.clientUserId, staffUserId: who.staffUserId, label: who.actorLabel },
    });
    if (!r.changed) continue;
    (r.to ? saved : cleared).push(PROFILE_SLOTS[key].label);
    if (r.changeId) changeIds.push(r.changeId);
  }
  if (changeIds.length) await alertBrandChanges(clientId).catch((e) => console.warn("brand alert failed (the change is saved)", e));
  if (!saved.length && !cleared.length) return { ok: true, message: "Nothing changed — that's already what we have on file.", ...none };
  const parts = [saved.length ? `Saved ${saved.join(", ")}` : null, cleared.length ? `Cleared ${cleared.join(", ")}` : null].filter(Boolean);
  return { ok: true, message: `${parts.join(" · ")}. Your editor sees this on every job.`, saved, cleared, changeIds };
}

// ---- files from the portal -----------------------------------------------------------

export const PORTAL_UPLOAD_KINDS = ["LOGO", "HEADSHOT", "FONT", "OTHER"] as const;
export type PortalUploadKind = (typeof PORTAL_UPLOAD_KINDS)[number];
export const isPortalUploadKind = (k: unknown): k is PortalUploadKind => (PORTAL_UPLOAD_KINDS as readonly unknown[]).includes(k);

/** Is this asset one the portal may replace for this client? (checked BEFORE the bytes go to Dropbox) */
export async function replaceableAsset(clientId: string, assetId: string): Promise<{ id: string; type: string } | null> {
  const a = await prisma.clientAsset.findFirst({ where: { id: assetId, clientId, status: "ACTIVE", profileKey: null, ownership: "CLIENT" }, select: { id: true, type: true } });
  return a;
}

/**
 * A file the client uploaded to their Dropbox folder, recorded in the
 * registry: a new asset (v1, source client_portal, the person on it), or a new
 * version of one of THEIR assets when they pressed Replace. The earlier file
 * stays where it is — a delivered video keeps what it was made with.
 */
export async function recordPortalAssetUpload(
  viewer: PortalViewer,
  input: { kind: string; fileName: string; path: string; sizeBytes?: number | null; mimeType?: string | null; replaceAssetId?: string | null },
): Promise<{ ok: boolean; message: string; assetId?: string; versionId?: string; changeId?: string }> {
  if (!can(viewer, "editBrandProfile")) return { ok: false, message: refusalMessage(viewer, "editBrandProfile") };
  if (!isPortalUploadKind(input.kind)) return { ok: false, message: "Pick what this file is: logo, headshot, font or other." };
  const clientId = viewer.enrollment.clientId;
  const who = stampOf(viewer);
  const staffBy = viewer.actor.kind === "STAFF" ? viewer.actor.staffName || viewer.actor.staffUserId : null;
  const version = { source: "client_portal" as const, fileRef: input.path, fileName: input.fileName, sizeBytes: input.sizeBytes ?? null, mimeType: input.mimeType ?? null, by: staffBy, byClientUserId: who.clientUserId };
  let assetId: string;
  let versionId: string;
  let type: string = input.kind;
  let fromName: string | null = null;
  if (input.replaceAssetId) {
    const target = await replaceableAsset(clientId, input.replaceAssetId);
    if (!target) return { ok: false, message: "That file isn't on your profile any more — upload it as a new one instead." };
    const prev = await prisma.clientAsset.findUnique({ where: { id: target.id }, select: { activeVersionId: true } });
    fromName = prev?.activeVersionId ? (await prisma.clientAssetVersion.findUnique({ where: { id: prev.activeVersionId }, select: { fileName: true } }))?.fileName ?? null : null;
    assetId = target.id;
    type = target.type;
    versionId = (await addAssetVersion(target.id, version)).versionId;
  } else {
    const r = await createAssetWithVersion({ clientId, enrollmentId: viewer.enrollment.id, type: input.kind, name: input.fileName, ownership: "CLIENT", ...version });
    assetId = r.assetId;
    versionId = r.versionId;
  }
  const word = isAssetType(type) ? ASSET_TYPE_WORDS[type] : "File";
  const changeId = await recordBrandChange({
    clientId, enrollmentId: viewer.enrollment.id, fieldKey: `asset:${type}`, label: word, kind: input.replaceAssetId ? "FILE_REPLACED" : "FILE_ADDED",
    fromText: fromName, toText: input.fileName, assetId, assetVersionId: versionId, source: "client_portal", ...who, actorLabel: actorLabel(viewer),
  });
  await alertBrandChanges(clientId).catch((e) => console.warn("brand alert failed (the file is saved)", e));
  return { ok: true, message: input.replaceAssetId ? `${input.fileName} replaced your ${word.toLowerCase()} — your editor uses it from here on.` : `${input.fileName} added to your brand kit.`, assetId, versionId, changeId };
}

/**
 * "THIS IS MY LOGO" (review of CP-06, Sep 24 2026). Before CP-06 a portal
 * upload went to the client's brand folder and nowhere else, and so did files
 * staff dropped there — so an existing client's logo is often IN the folder
 * with no registry row, and the setup checklist (which counts only what is
 * filed) told them to upload it again, making a duplicate ("logo (1).png").
 * This files a file ALREADY in their folder as their logo or headshot. The
 * folder is listed here and the file found in it by name — a path from the
 * browser is never trusted — and it is recorded exactly as an upload is: the
 * history row, the editor's banner, Kyle's confirmation task.
 */
export async function claimFolderFileForPortal(viewer: PortalViewer, input: { name: string; kind: string }): Promise<{ ok: boolean; message: string; assetId?: string }> {
  if (!can(viewer, "editBrandProfile")) return { ok: false, message: refusalMessage(viewer, "editBrandProfile") };
  if (input.kind !== "LOGO" && input.kind !== "HEADSHOT") return { ok: false, message: "Pick logo or headshot." };
  const clientId = viewer.enrollment.clientId;
  const folder = await listClientAssets(clientId, { links: false }).catch(() => null);
  const want = (input.name ?? "").trim().toLowerCase();
  const file = want ? folder?.files.find((f) => f.name.toLowerCase() === want) : undefined;
  if (!file) return { ok: false, message: "That file isn't in your brand folder any more. Refresh the page and try again." };
  const assetIds = (await prisma.clientAsset.findMany({ where: { clientId }, select: { id: true } })).map((a) => a.id);
  const filed = assetIds.length ? await prisma.clientAssetVersion.findFirst({ where: { assetId: { in: assetIds }, fileRef: { equals: file.path, mode: "insensitive" } }, select: { id: true } }) : null;
  if (filed) return { ok: false, message: `${file.name} is already on your profile.` };
  const r = await recordPortalAssetUpload(viewer, { kind: input.kind, fileName: file.name, path: file.path });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: `Got it. ${file.name} is your ${input.kind === "LOGO" ? "logo" : "headshot"} now, and your editor has been told.`, assetId: r.assetId };
}

/** Files in the client's brand folder that nothing on the profile points at (any version). Null when the folder cannot be read. */
export async function unfiledFolderFiles(clientId: string): Promise<{ name: string; path: string }[] | null> {
  const folder = await listClientAssets(clientId, { links: false }).catch(() => null);
  if (!folder || !folder.folderExists) return folder ? [] : null;
  const assetIds = (await prisma.clientAsset.findMany({ where: { clientId }, select: { id: true } })).map((a) => a.id);
  const paths = assetIds.length ? await prisma.clientAssetVersion.findMany({ where: { assetId: { in: assetIds }, fileRef: { not: null } }, select: { fileRef: true } }) : [];
  const known = new Set(paths.map((p) => (p.fileRef ?? "").toLowerCase()));
  return folder.files.filter((f) => !known.has(f.path.toLowerCase())).map((f) => ({ name: f.name, path: f.path }));
}

// ---- staff edits on the Brand tab -------------------------------------------------------

/**
 * A staff member changed an asset on the client file's Brand tab. Recorded
 * and alerted exactly like a client change: the editor must learn about a new
 * logo whoever filed it. Best-effort — the asset write has already happened.
 */
export async function recordStaffAssetChange(input: {
  assetId: string; action: "created" | "version" | "rollback" | "retired" | "restored";
  staff: { email: string; id: string | null }; enrollmentId?: string | null; fromVersionId?: string | null;
}): Promise<string | null> {
  const a = await prisma.clientAsset.findUnique({ where: { id: input.assetId }, select: { id: true, clientId: true, type: true, name: true, profileKey: true, activeVersionId: true, enrollmentId: true } });
  if (!a) return null;
  const read = (id: string | null | undefined) => (id ? prisma.clientAssetVersion.findUnique({ where: { id }, select: { id: true, fileRef: true, fileName: true, valueText: true, valueJson: true } }) : Promise.resolve(null));
  const [now, before] = await Promise.all([read(a.activeVersionId), read(input.fromVersionId)]);
  const show = (v: Awaited<ReturnType<typeof read>>) => (v ? (isClearedVersion(v) ? null : v.fileName ?? v.valueText) : null);
  const isFile = !!now?.fileRef;
  const kind: BrandChangeKind =
    input.action === "retired" ? "CLEARED"
      : input.action === "created" ? (isFile ? "FILE_ADDED" : "SET")
        : isFile ? "FILE_REPLACED" : now && isClearedVersion(now) ? "CLEARED" : "SET";
  const slot = a.profileKey && isSlotKey(a.profileKey) ? PROFILE_SLOTS[a.profileKey] : null;
  const word = isAssetType(a.type) ? ASSET_TYPE_WORDS[a.type] : "Asset";
  const label = slot ? slot.label : `${word}${a.name && a.name !== word ? ` (${clip(a.name, 60)})` : ""}${input.action === "retired" ? " retired" : input.action === "restored" ? " back in use" : ""}`;
  const id = await recordBrandChange({
    clientId: a.clientId, enrollmentId: input.enrollmentId ?? a.enrollmentId, fieldKey: slot ? `slot:${a.profileKey}` : `asset:${a.type}`, label, kind,
    fromText: input.action === "created" ? null : show(before), toText: input.action === "retired" ? null : show(now),
    assetId: a.id, assetVersionId: now?.id ?? null, source: "staff", staffUserId: input.staff.id, actorLabel: input.staff.email,
  });
  await alertBrandChanges(a.clientId).catch((e) => console.warn("brand alert failed (the change is saved)", e));
  return id;
}

// ---- who edits this client ----------------------------------------------------------------

export type AssignedEditor = { key: string; name: string; projectId: string | null };

/**
 * The editor(s) a brand change must reach, most specific first:
 *   1. whoever holds an OPEN edit_video / revision task on one of the client's
 *      undelivered jobs (the work actually in their hands);
 *   2. else the in-house editor on a job in production (SHOT…REVISION);
 *   3. else, for a client in the content program, the personal-branding route
 *      (§5: personal branding → Kim) — their next job lands there;
 *   4. else nobody, and Kyle's task says so.
 * Departed editors are never returned.
 */
export async function assignedEditorsForClient(clientId: string): Promise<AssignedEditor[]> {
  const { TEAM_MEMBER_EDITOR_KEYS, editorMeta, editorKeyForTeamName } = await import("@/lib/editors");
  const live = (k: string | null | undefined): k is string => !!k && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(k) && !editorMeta(k)?.departed;
  const out = new Map<string, AssignedEditor>();
  const add = (key: string, projectId: string | null) => { if (!out.has(key)) out.set(key, { key, name: editorMeta(key)?.name ?? key, projectId }); };

  const tasks = await prisma.smartTask.findMany({
    where: { taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] }, assignedKey: { in: [...TEAM_MEMBER_EDITOR_KEYS] }, project: { clientId, status: { notIn: ["DELIVERED", "CANCELLED"] } } },
    orderBy: { updatedAt: "desc" }, select: { assignedKey: true, projectId: true },
  });
  for (const t of tasks) if (live(t.assignedKey)) add(t.assignedKey, t.projectId);
  if (out.size) return [...out.values()];

  const projects = await prisma.project.findMany({
    where: { clientId, status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] }, editorId: { not: null } },
    orderBy: { updatedAt: "desc" }, select: { id: true, editor: { select: { name: true } } },
  });
  for (const p of projects) { const k = editorKeyForTeamName(p.editor?.name); if (live(k)) add(k, p.id); }
  if (out.size) return [...out.values()];

  const enrolled = await prisma.contentEnrollment.findFirst({ where: { clientId, status: "ACTIVE" }, select: { id: true } });
  if (enrolled) {
    const { editorRouting } = await import("@/lib/settings");
    const key = (await editorRouting().catch(() => null))?.personalBranding ?? "kim";
    const next = await prisma.project.findFirst({ where: { clientId, contentMonthId: { not: null }, status: { notIn: ["DELIVERED", "CANCELLED"] } }, orderBy: { updatedAt: "desc" }, select: { id: true } });
    if (live(key)) add(key, next?.id ?? null);
  }
  return [...out.values()];
}

// ---- the alert: Kyle's task always, the editor's message behind the switch ---------------

const ACK_TASK_PREFIX = (clientId: string) => `brand-ack:${clientId}:`;
/** How far back the catch-up reaches once the switch is turned on. Older
 *  unacknowledged changes still sit on the brief's banner. */
export const BRAND_ALERT_CATCHUP_DAYS = 7;

type ChangeRow = { id: string; label: string; kind: string; fromText: string | null; toText: string | null; actorLabel: string | null; source: string; createdAt: Date };

/** One line per change, for Kyle's task and the editor's DM. */
export function describeBrandChange(r: Pick<ChangeRow, "label" | "kind" | "fromText" | "toText">): string {
  const q = (s: string) => `“${clip(s.replace(/\s+/g, " "), 90)}”`;
  if (r.kind === "FILE_ADDED") return `${r.label}: new file ${r.toText ? q(r.toText) : ""}`.trim();
  if (r.kind === "FILE_REPLACED") return `${r.label}: replaced${r.fromText ? ` ${q(r.fromText)}` : ""}${r.toText ? ` → ${q(r.toText)}` : ""}`;
  if (!r.toText) return `${r.label}: cleared${r.fromText ? ` (was ${q(r.fromText)})` : ""}`;
  return `${r.label}: ${r.fromText ? `${q(r.fromText)} → ` : ""}${q(r.toText)}${r.kind === "APPLIED_FROM_CALL" ? " (from a call, applied by the office)" : ""}`;
}

function etHourKey(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}${p.hour}`;
}

export type BrandAlertOutcome = { claimed: number; channel: string | null; editors: string[]; taskId: string | null };

/**
 * Handle every change on this client that nobody has handled yet. Claimed
 * atomically (alertedAt null → this call's claim), so two saves racing each
 * other alert every row exactly once. For each batch:
 *   · a TEST client: the rows are stamped `skipped_test` and nothing else
 *     happens (no task on Kyle's real desk, no message);
 *   · Kyle's confirmation task — one OPEN task per client, later changes
 *     appended to it — so the office knows to make sure the editor has it;
 *   · the editor's bell + Slack DM when `brand_change_alerts` is on (at most
 *     one DM per client per hour, the notify dedupe); otherwise `pending`.
 */
export async function alertBrandChanges(clientId: string, opts: { now?: Date } = {}): Promise<BrandAlertOutcome> {
  const now = opts.now ?? new Date();
  const claim = randomUUID();
  const won = await prisma.clientBrandChange.updateMany({ where: { clientId, alertedAt: null }, data: { alertClaim: claim, alertedAt: now } });
  if (won.count === 0) return { claimed: 0, channel: null, editors: [], taskId: null };
  const rows: ChangeRow[] = await prisma.clientBrandChange.findMany({ where: { alertClaim: claim }, orderBy: { createdAt: "asc" }, select: { id: true, label: true, kind: true, fromText: true, toText: true, actorLabel: true, source: true, createdAt: true } });
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
  const clientName = client?.name ?? "A client";
  if (isTestClientName(client?.name)) {
    // Ledger rows only — the programReminders escalate rule: a synthetic client
    // never puts work on a real person's desk or in their DMs.
    await prisma.clientBrandChange.updateMany({ where: { alertClaim: claim }, data: { alertChannel: "skipped_test" } });
    return { claimed: rows.length, channel: "skipped_test", editors: [], taskId: null };
  }
  const editors = await assignedEditorsForClient(clientId);
  const alertsOn = await isAutomationEnabled("brand_change_alerts");
  const taskId = await ensureAckTask(clientId, clientName, rows, editors, alertsOn, now);
  const channel = editors.length === 0 ? "no_editor" : alertsOn ? await deliverEditorAlert(clientId, clientName, rows, editors, now) : "pending";
  await prisma.clientBrandChange.updateMany({
    where: { alertClaim: claim },
    data: { alertChannel: channel, alertEditorKeys: editors.map((e) => e.key).join(",") || null, taskId },
  });
  return { claimed: rows.length, channel, editors: editors.map((e) => e.key), taskId };
}

/** Kyle's "make sure the editor has it" card: one open card per client, appended to. */
async function ensureAckTask(clientId: string, clientName: string, rows: ChangeRow[], editors: AssignedEditor[], alertsOn: boolean, now: Date): Promise<string> {
  const who = editors.map((e) => e.name);
  const editorWords = who.length ? who.join(" and ") : null;
  const projectId = editors.find((e) => e.projectId)?.projectId ?? null;
  const by = [...new Set(rows.map((r) => r.actorLabel).filter(Boolean))].join(", ") || "the client";
  const at = now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const lines = rows.map((r) => `• ${describeBrandChange(r)}`);
  const how = !editorWords
    ? "No editor is on their work right now, so nobody has been told. When a job is assigned, make sure its editor reads the brief's brand section."
    : `${editorWords} ${who.length > 1 ? "see" : "sees"} it as a banner on the brief${projectId ? ` (/edit/${projectId})` : ""} until they press “Got it”, which closes this task. ${alertsOn ? "They were also messaged on Slack." : "Brand-change alerts to editors are switched off, so they have NOT been messaged — tell them, or wait for them to open the brief."}`;
  return prisma.$transaction(async (tx) => {
    await lockAdvisory(tx, `brand-ack|${clientId}`);
    const open = await tx.smartTask.findFirst({
      where: { dedupeKey: { startsWith: ACK_TASK_PREFIX(clientId) }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      orderBy: { createdAt: "desc" }, select: { id: true, description: true },
    });
    const title = editorWords ? `Confirm ${editorWords} has ${clientName}'s brand update` : `Brand update for ${clientName} — no editor on their work yet`;
    if (open) {
      const description = `${open.description ?? ""}\n\nAlso changed (${at}, by ${by}):\n${lines.join("\n")}`.slice(0, 6000);
      await tx.smartTask.update({ where: { id: open.id }, data: { title, description } });
      return open.id;
    }
    const task = await tx.smartTask.create({
      data: {
        taskType: "todo", title,
        summary: clip(rows.map((r) => describeBrandChange(r)).join(" · "), 200),
        description: [`${clientName} changed their brand profile (${at}, by ${by}):`, ...lines, "", how].join("\n").slice(0, 6000),
        reasonCreated: "A brand profile or brand asset changed (CP-06)",
        source: rows.some((r) => r.source === "client_portal") ? "portal" : "content_program",
        priority: "MEDIUM", dueAt: new Date(now.getTime() + 24 * 3600_000), assignedKey: "kyle",
        clientId, projectId, dedupeKey: `${ACK_TASK_PREFIX(clientId)}${rows[0].id}`,
      },
      select: { id: true },
    });
    return task.id;
  });
}

/** The editor's bell + Slack DM (their "Job pings" switch decides the channel). */
async function deliverEditorAlert(clientId: string, clientName: string, rows: ChangeRow[], editors: AssignedEditor[], now: Date): Promise<string> {
  const { notifyInApp } = await import("@/lib/notify");
  const { appBase } = await import("@/lib/appUrl");
  const dedupeKey = `brand-updated-${clientId}-${etHourKey(now)}`;
  const existedBefore = !!(await prisma.notification.findUnique({ where: { dedupeKey: `${dedupeKey}-0` }, select: { id: true } }).catch(() => null));
  const summary = rows.map((r) => describeBrandChange(r)).join("; ");
  const hrefOf = (e: AssignedEditor) => (e.projectId ? `/edit/${e.projectId}#brand-updates` : "/editing");
  const r = await notifyInApp({
    kind: "brand_updated",
    title: `Brand updated — ${clientName}`,
    body: clip(summary, 140),
    href: hrefOf(editors[0]),
    targets: editors.map((e) => ({
      roles: ["EDITOR"], userKey: `editor:${e.key}`, href: hrefOf(e),
      // Money never reaches a creative: the client's own words are scrubbed.
      slackDm: scrubMoney(`Brand updated — ${clientName}: ${summary}. It's on the brief: ${appBase()}${hrefOf(e)}`),
    })),
    dedupeKey,
  });
  const reached = r.bridged.find((b) => b.channel === "slack") ?? r.bridged.find((b) => b.channel === "sms") ?? r.bridged[0];
  return reached ? reached.channel : existedBefore ? "deduped" : "bell";
}

/**
 * The hourly safety net (cron/sync `brandChangeAlerts`). Two jobs:
 *   1. a change whose inline alert never ran (the save's process died, or the
 *      alert threw) is alerted here — once, by the same claim;
 *   2. once `brand_change_alerts` is ON, changes recorded while it was off
 *      ("pending"), still unacknowledged and under a week old, get their DM.
 */
export async function sweepBrandChangeAlerts(opts: { now?: Date; limit?: number } = {}): Promise<{ clients: number; rows: number; caughtUp: number }> {
  const now = opts.now ?? new Date();
  const stale = await prisma.clientBrandChange.findMany({
    where: { alertedAt: null, createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
    distinct: ["clientId"], take: opts.limit ?? 50, select: { clientId: true },
  });
  let rows = 0;
  for (const s of stale) rows += (await alertBrandChanges(s.clientId, { now }).catch(() => ({ claimed: 0 }))).claimed;
  let caughtUp = 0;
  if (await isAutomationEnabled("brand_change_alerts")) {
    const pending = await prisma.clientBrandChange.findMany({
      where: { alertChannel: "pending", ackAt: null, createdAt: { gte: new Date(now.getTime() - BRAND_ALERT_CATCHUP_DAYS * 86_400_000) } },
      distinct: ["clientId"], take: opts.limit ?? 50, select: { clientId: true },
    });
    for (const p of pending) {
      const claim = randomUUID();
      const won = await prisma.clientBrandChange.updateMany({
        where: { clientId: p.clientId, alertChannel: "pending", ackAt: null, createdAt: { gte: new Date(now.getTime() - BRAND_ALERT_CATCHUP_DAYS * 86_400_000) } },
        data: { alertChannel: "sending", alertClaim: claim },
      });
      if (!won.count) continue;
      const batch = await prisma.clientBrandChange.findMany({ where: { alertClaim: claim }, orderBy: { createdAt: "asc" }, select: { id: true, label: true, kind: true, fromText: true, toText: true, actorLabel: true, source: true, createdAt: true } });
      const client = await prisma.client.findUnique({ where: { id: p.clientId }, select: { name: true } });
      const editors = await assignedEditorsForClient(p.clientId);
      const channel = editors.length ? await deliverEditorAlert(p.clientId, client?.name ?? "A client", batch, editors, now).catch(() => "pending") : "no_editor";
      await prisma.clientBrandChange.updateMany({ where: { alertClaim: claim }, data: { alertChannel: channel, alertEditorKeys: editors.map((e) => e.key).join(",") || null } });
      caughtUp += batch.length;
    }
  }
  return { clients: stale.length, rows, caughtUp };
}

// ---- the banner and the acknowledgement ----------------------------------------------------

export type PendingBrandChange = {
  id: string; label: string; kind: string; fromText: string | null; toText: string | null; assetId: string | null; assetVersionId: string | null;
  actorLabel: string | null; source: string; createdAtISO: string; line: string;
};
const PENDING_DAYS = 45;

/** What the editor has not yet said "Got it" to: unacknowledged, recent, and
 *  not already closed by Kyle by hand (completing his task counts). */
export async function pendingBrandChanges(clientId: string, opts: { now?: Date } = {}): Promise<PendingBrandChange[]> {
  const now = opts.now ?? new Date();
  const rows = await prisma.clientBrandChange.findMany({
    where: { clientId, ackAt: null, createdAt: { gte: new Date(now.getTime() - PENDING_DAYS * 86_400_000) } },
    orderBy: { createdAt: "asc" }, take: 60,
  });
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((x): x is string => !!x))];
  const closed = new Set(taskIds.length ? (await prisma.smartTask.findMany({ where: { id: { in: taskIds }, status: { in: ["COMPLETED", "CANCELLED"] } }, select: { id: true } })).map((t) => t.id) : []);
  return rows
    .filter((r) => !r.taskId || !closed.has(r.taskId))
    .map((r) => ({
      id: r.id, label: r.label, kind: r.kind, fromText: r.fromText, toText: r.toText, assetId: r.assetId, assetVersionId: r.assetVersionId,
      actorLabel: r.actorLabel, source: r.source, createdAtISO: r.createdAt.toISOString(), line: describeBrandChange(r),
    }));
}

/**
 * The editor (or the office) has the change. Stamps every pending row and
 * completes each of Kyle's confirmation tasks that has nothing left open.
 */
export async function acknowledgeBrandChanges(clientId: string, by: string, opts: { now?: Date } = {}): Promise<{ acked: number; tasksClosed: number }> {
  const now = opts.now ?? new Date();
  const pending = await pendingBrandChanges(clientId, { now });
  if (!pending.length) return { acked: 0, tasksClosed: 0 };
  const ids = pending.map((p) => p.id);
  const n = await prisma.clientBrandChange.updateMany({ where: { id: { in: ids }, ackAt: null }, data: { ackAt: now, ackBy: clip(by, 120) } });
  const touched = await prisma.clientBrandChange.findMany({ where: { id: { in: ids } }, select: { taskId: true } });
  let tasksClosed = 0;
  for (const taskId of new Set(touched.map((t) => t.taskId).filter((x): x is string => !!x))) {
    const open = await prisma.clientBrandChange.count({ where: { taskId, ackAt: null } });
    if (open > 0) continue;
    const c = await prisma.smartTask.updateMany({ where: { id: taskId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: now } });
    tasksClosed += c.count;
  }
  return { acked: n.count, tasksClosed };
}

/** Recent history for the staff Brand tab, newest first. */
export async function recentBrandChanges(clientId: string, take = 30) {
  return prisma.clientBrandChange.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take });
}

// ---- the editor's brief ------------------------------------------------------------------

export type BrandBriefFile = { assetId: string; type: string; typeWord: string; name: string; fileName: string | null; url: string | null; versionNo: number; updatedAtISO: string };
export type BrandBrief = {
  colors: string[];
  /** Words saved alongside the hex codes in older data ("navy, gold"). */
  colorWords: string | null;
  fontNames: string | null;
  files: BrandBriefFile[];
  website: string | null;
  social: string | null;
  music: string | null;
  videoStyle: string | null;
  preferences: string | null;
  /** The persistent EDITING_INSTRUCTIONS / PRODUCTION_PREFERENCE / PRONUNCIATION
   *  values (clientAssets.productionDefaults — no caller until now). */
  productionDefaults: { name: string; text: string; versionNo: number; source: string }[];
  /** Accepted, AI-allowed production facts (clientFacts.productionFactsForProject — no caller until now). */
  acceptedPreferences: string[];
  pending: PendingBrandChange[];
};

const HEX_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const BRIEF_FILE_TYPES = new Set(["LOGO", "HEADSHOT", "FONT", "BRANDING_CARD"]);

/**
 * What the editor works from — the latest ACTIVE version of every brand
 * asset, the structured slots, the client's own words, the standing
 * production defaults and the accepted call preferences, plus the changes not
 * yet acknowledged. `scrub` money-scrubs every free-text value for a creative.
 */
export async function brandBriefFor(clientId: string, opts: { projectId?: string | null; scrub?: boolean; links?: boolean } = {}): Promise<BrandBrief> {
  const s = (v: string | null | undefined): string | null => {
    const t = (v ?? "").trim();
    if (!t) return null;
    return opts.scrub ? stripMoneySentences(t) || null : t;
  };
  const { productionFactsForProject } = await import("@/lib/clientFacts");
  const [client, slots, registry, defaults, accepted, pending] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { brandColors: true, portalVideoStyle: true, portalPreferences: true } }),
    slotValues(clientId),
    assetRegistry(clientId, { links: opts.links !== false }),
    productionDefaults(clientId).catch(() => []),
    productionFactsForProject(clientId, opts.projectId ?? null).catch(() => [] as string[]),
    pendingBrandChanges(clientId),
  ]);
  const raw = client?.brandColors ?? "";
  const colors = [...new Set((raw.match(HEX_RE) ?? []).map((c) => c.toLowerCase()))];
  const colorWords = raw.replace(HEX_RE, "").replace(/[,\s]+/g, " ").trim() || null;
  const files: BrandBriefFile[] = registry
    .filter((a) => BRIEF_FILE_TYPES.has(a.type) && a.status === "ACTIVE" && !a.profileKey && a.active?.fileRef && !a.active.cleared)
    .map((a) => ({ assetId: a.id, type: a.type, typeWord: ASSET_TYPE_WORDS[a.type], name: a.name, fileName: a.active!.fileName, url: a.active!.url, versionNo: a.active!.versionNo, updatedAtISO: a.active!.createdAt.toISOString() }));
  return {
    colors, colorWords: s(colorWords),
    fontNames: s(slots.fonts), files, website: s(slots.website), social: s(slots.social), music: s(slots.music),
    videoStyle: s(client?.portalVideoStyle), preferences: s(client?.portalPreferences),
    productionDefaults: defaults.map((d) => ({ name: d.name, text: s(d.text) ?? "", versionNo: d.versionNo, source: d.source })).filter((d) => d.text),
    acceptedPreferences: accepted.map((x) => s(x)).filter((x): x is string => !!x),
    pending: opts.scrub ? pending.map((p) => ({ ...p, fromText: s(p.fromText), toText: s(p.toText), line: scrubMoney(p.line) })) : pending,
  };
}

// ---- the portal's Brand Profile page -------------------------------------------------------

export type PortalBrandFile = { assetId: string; type: string; typeWord: string; name: string; fileName: string | null; url: string | null; versionNo: number; updatedAtISO: string };
export type PortalBrandView = {
  /** Raw columns: null = never set (a suggestion may be offered), "" = cleared. */
  columns: { brandColors: string | null; videoStyle: string | null; preferences: string | null };
  slots: Record<BrandSlotKey, string | null>;
  files: PortalBrandFile[];
  /** Files already in their Dropbox folder that nobody has filed on the profile. */
  folderOnly: { name: string; url: string | null }[];
};

/** Everything the portal's Brand Profile renders — the client's own fields and files only. */
export async function portalBrandProfileView(clientId: string, opts: { folder?: boolean } = {}): Promise<PortalBrandView> {
  const [client, slots, registry, folder] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { brandColors: true, portalVideoStyle: true, portalPreferences: true } }),
    slotValues(clientId),
    assetRegistry(clientId, { links: true }),
    opts.folder === false ? Promise.resolve(null) : listClientAssets(clientId, { links: true }).catch(() => null),
  ]);
  const files = registry
    .filter((a) => a.status === "ACTIVE" && !a.profileKey && a.ownership === "CLIENT" && a.active?.fileRef && !a.active.cleared)
    .map((a) => ({ assetId: a.id, type: a.type, typeWord: ASSET_TYPE_WORDS[a.type], name: a.name, fileName: a.active!.fileName, url: a.active!.url, versionNo: a.active!.versionNo, updatedAtISO: a.active!.createdAt.toISOString() }));
  // Every version's path counts as "on the profile", not just the active one —
  // a replaced logo's old file is history, not an unfiled upload.
  const assetIds = registry.map((a) => a.id);
  const paths = assetIds.length ? await prisma.clientAssetVersion.findMany({ where: { assetId: { in: assetIds }, fileRef: { not: null } }, select: { fileRef: true } }) : [];
  const known = new Set(paths.map((p) => (p.fileRef ?? "").toLowerCase()));
  return {
    columns: { brandColors: client?.brandColors ?? null, videoStyle: client?.portalVideoStyle ?? null, preferences: client?.portalPreferences ?? null },
    slots: { fonts: slots.fonts, website: slots.website, social: slots.social, music: slots.music },
    files,
    folderOnly: (folder?.files ?? []).filter((f) => !known.has(f.path.toLowerCase())).map((f) => ({ name: f.name, url: f.url })),
  };
}

/**
 * The portal's prefill rule, as one pure function so it can be tested: a
 * column that was NEVER set (NULL) may show what we already know about the
 * client; a column the client CLEARED ("") stays empty. The old page tested
 * truthiness, so a cleared field came straight back from the AI read.
 */
export function prefillValue(stored: string | null | undefined, suggested: string | null | undefined): string {
  return stored == null ? (suggested ?? "") : stored;
}
