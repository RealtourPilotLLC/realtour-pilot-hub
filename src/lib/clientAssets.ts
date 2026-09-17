import "server-only";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { dbx, dropboxListFolder, DropboxError } from "@/lib/integrations/dropbox";
import { dropboxWebUrl } from "@/lib/dropboxFolders";
import { brandFolderPath, dropboxConnected, ensureClientBrandFolder } from "@/lib/clientFolders";

// ---------------------------------------------------------------------------
// CLIENT ASSETS — logos, endcards, fonts, brand kits. One Dropbox folder per
// video client (the brand-assets convention in clientFolders.ts), surfaced:
//   · /clients/assets       — owner/admin manage every client in one place
//   · /edit/[id]            — the job's client assets, editors can upload too
//   · hourly cron           — every client with a video order gets a folder
// "Assets available" vs "No assets" comes straight from the folder contents.
// ---------------------------------------------------------------------------

export type ClientAssetFile = {
  name: string;
  path: string;
  url: string | null; // Dropbox shared link (view/download)
};

export type ClientAssets = {
  clientId: string;
  clientName: string;
  path: string;
  folderUrl: string | null;
  folderExists: boolean;
  files: ClientAssetFile[];
};

// List a client's asset folder. A missing folder is a normal state ("no assets
// yet"), not an error. Links are minted per file (stable per path — Dropbox
// returns the existing link on repeat calls); asset folders are small. The
// all-clients manager passes links:false — counts only, no N×M link minting.
export async function listClientAssets(clientId: string, opts: { links?: boolean } = {}): Promise<ClientAssets | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, brandAssetsPath: true },
  });
  if (!client) return null;
  const path = client.brandAssetsPath || brandFolderPath(client.name);
  const base: ClientAssets = {
    clientId: client.id,
    clientName: client.name,
    path,
    folderUrl: dropboxWebUrl(path),
    folderExists: false,
    files: [],
  };
  if (!(await dropboxConnected())) return base;
  try {
    const entries = await dropboxListFolder(path);
    base.folderExists = true;
    const files = entries.filter((e) => e.tag === "file").slice(0, 40);
    // Temporary links, not shared links: team sharing policy blocks per-file
    // shared-link minting here, but get_temporary_link always works for files
    // the app can read (4h expiry — fine, the page re-mints on every render).
    base.files = await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        path: f.path,
        url:
          opts.links === false
            ? null
            : await dbx<{ link?: string }>("files/get_temporary_link", { path: f.path })
                .then((r) => r.link ?? null)
                .catch(() => null),
      })),
    );
    return base;
  } catch (e) {
    if (e instanceof DropboxError && e.message.includes("not_found")) return base; // no folder yet
    return base; // transient Dropbox hiccup → render as empty rather than erroring the page
  }
}

// The clients this system cares about: anyone with a video/reel order.
export async function videoClients(): Promise<{ id: string; name: string; brandAssetsPath: string | null }[]> {
  return prisma.client.findMany({
    where: {
      projects: {
        some: {
          status: { not: "CANCELLED" },
          deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null } },
        },
      },
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, brandAssetsPath: true },
  });
}

// Cron sweep: every video client gets an asset folder (Jordan: "each client
// that has ordered a premium reel or standard reel or personal branding should
// have an asset folder in dropbox"). Idempotent; bounded per run.
export async function ensureVideoClientAssetFolders(limit = 15): Promise<{ ensured: number; checked: number }> {
  if (!(await dropboxConnected())) return { ensured: 0, checked: 0 };
  const missing = await prisma.client.findMany({
    where: {
      brandAssetsPath: null,
      projects: {
        some: {
          status: { not: "CANCELLED" },
          deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null } },
        },
      },
    },
    take: limit,
    select: { id: true },
  });
  let ensured = 0;
  for (const c of missing) {
    const r = await ensureClientBrandFolder(c.id).catch(() => ({ ok: false }));
    if (r.ok) ensured += 1;
    else break; // Dropbox unreachable — next run retries
  }
  return { ensured, checked: missing.length };
}

// ===========================================================================
// ASSET REGISTRY (spec §17 Brand & Assets, Sep 17 2026). The Dropbox folder
// above stays the FILE store; ClientAsset / ClientAssetVersion are the RECORD
// — ownership, type, the active version, and where each version came from.
// Replacing a logo = a new version that becomes the active default for future
// work; the old version row (and the file it points at) stays untouched, so
// what a delivered video used is never rewritten. Text-valued assets (colours,
// pronunciation, contact card, persistent editing instructions, production
// preferences) live in valueText and are the defaults the editor brief reads.
// ===========================================================================

export const ASSET_TYPES = [
  "LOGO", "COLOR_PALETTE", "BRANDING_CARD", "FONT", "HEADSHOT", "APPROVED_PHOTO", "EXAMPLE_VIDEO", "PRONUNCIATION", "CONTACT_CARD",
  "EDITING_INSTRUCTIONS", "PRODUCTION_PREFERENCE", "OTHER",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const isAssetType = (t: unknown): t is AssetType => typeof t === "string" && (ASSET_TYPES as readonly string[]).includes(t);
export const ASSET_TYPE_WORDS: Record<AssetType, string> = {
  LOGO: "Logo", COLOR_PALETTE: "Brand colours", BRANDING_CARD: "Branding card / end card", FONT: "Font or font reference", HEADSHOT: "Headshot", APPROVED_PHOTO: "Approved photo",
  EXAMPLE_VIDEO: "Example video", PRONUNCIATION: "Pronunciation", CONTACT_CARD: "Contact details", EDITING_INSTRUCTIONS: "Persistent editing instructions", PRODUCTION_PREFERENCE: "Production preference", OTHER: "Other",
};
/** Types whose value is TEXT (typed on the tab), not a file. */
export const TEXT_ASSET_TYPES: readonly AssetType[] = ["COLOR_PALETTE", "PRONUNCIATION", "CONTACT_CARD", "EDITING_INSTRUCTIONS", "PRODUCTION_PREFERENCE", "FONT", "EXAMPLE_VIDEO"];
export const OWNERSHIPS = ["CLIENT", "AGENCY", "LICENSED"] as const;

export type AssetVersionRow = { id: string; versionNo: number; source: string; fileRef: string | null; fileName: string | null; valueText: string | null; note: string | null; uploadedBy: string | null; createdAt: Date; url: string | null };
export type AssetRow = {
  id: string; type: AssetType; name: string; ownership: string; status: string; notes: string | null; sortOrder: number; createdBy: string | null; updatedAt: Date;
  active: AssetVersionRow | null; versionCount: number;
};

function verRow(v: { id: string; versionNo: number; source: string; fileRef: string | null; fileName: string | null; valueText: string | null; note: string | null; uploadedByStaffUserId: string | null; uploadedByClientUserId: string | null; createdAt: Date }, url: string | null): AssetVersionRow {
  return { id: v.id, versionNo: v.versionNo, source: v.source, fileRef: v.fileRef, fileName: v.fileName, valueText: v.valueText, note: v.note, uploadedBy: v.uploadedByStaffUserId ?? (v.uploadedByClientUserId ? "client" : null), createdAt: v.createdAt, url };
}

/** Temporary Dropbox link for a version that points at a file in the client folder (4h, re-minted per render). */
async function linkFor(fileRef: string | null, wantLinks: boolean): Promise<string | null> {
  if (!wantLinks || !fileRef) return null;
  if (/^https?:\/\//i.test(fileRef)) return fileRef;
  if (!fileRef.startsWith("/")) return null;
  return dbx<{ link?: string }>("files/get_temporary_link", { path: fileRef }).then((r) => r.link ?? null).catch(() => null);
}

export async function assetRegistry(clientId: string, opts: { links?: boolean; includeRetired?: boolean } = {}): Promise<AssetRow[]> {
  const assets = await prisma.clientAsset.findMany({ where: { clientId, ...(opts.includeRetired ? {} : { status: "ACTIVE" }) }, orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }] });
  if (assets.length === 0) return [];
  const versions = await prisma.clientAssetVersion.findMany({ where: { assetId: { in: assets.map((a) => a.id) } }, orderBy: { versionNo: "desc" } });
  const connected = opts.links ? await dropboxConnected() : false;
  const out: AssetRow[] = [];
  for (const a of assets) {
    const mine = versions.filter((v) => v.assetId === a.id);
    const active = mine.find((v) => v.id === a.activeVersionId) ?? mine[0] ?? null;
    out.push({
      id: a.id, type: (isAssetType(a.type) ? a.type : "OTHER"), name: a.name, ownership: a.ownership, status: a.status, notes: a.notes, sortOrder: a.sortOrder, createdBy: a.createdBy, updatedAt: a.updatedAt,
      active: active ? verRow(active, await linkFor(active.fileRef, connected)) : null, versionCount: mine.length,
    });
  }
  return out;
}

export async function assetVersions(assetId: string, opts: { links?: boolean } = {}): Promise<AssetVersionRow[]> {
  const rows = await prisma.clientAssetVersion.findMany({ where: { assetId }, orderBy: { versionNo: "desc" } });
  const connected = opts.links ? await dropboxConnected() : false;
  const out: AssetVersionRow[] = [];
  for (const v of rows) out.push(verRow(v, await linkFor(v.fileRef, connected)));
  return out;
}

export type NewAssetVersion = {
  source: "dropbox" | "upload" | "aryeo" | "client_portal" | "manual" | "import";
  fileRef?: string | null; fileName?: string | null; mimeType?: string | null; sizeBytes?: number | null;
  valueText?: string | null; valueJson?: string | null; note?: string | null; by: string | null;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Register a new asset with its first version (v1 becomes active). */
export async function createAssetWithVersion(input: { clientId: string; enrollmentId?: string | null; type: AssetType; name: string; ownership?: string; notes?: string | null } & NewAssetVersion): Promise<{ assetId: string; versionId: string }> {
  if (!isAssetType(input.type)) throw new Error("Unknown asset type.");
  const name = input.name.trim();
  if (name.length < 2) throw new Error("Give the asset a name.");
  if (!input.fileRef && !input.valueText?.trim()) throw new Error("An asset needs a file or a value.");
  if (input.ownership && !(OWNERSHIPS as readonly string[]).includes(input.ownership)) throw new Error("Unknown ownership.");
  const asset = await prisma.clientAsset.create({
    data: { clientId: input.clientId, enrollmentId: input.enrollmentId ?? null, type: input.type, name, ownership: input.ownership ?? "CLIENT", notes: input.notes?.trim() || null, createdBy: input.by },
    select: { id: true },
  });
  const { versionId } = await addAssetVersion(asset.id, input);
  return { assetId: asset.id, versionId };
}

/**
 * A new version = the new default for future work. Never edits or deletes an
 * earlier version; the previous file stays where it is.
 */
export async function addAssetVersion(assetId: string, v: NewAssetVersion): Promise<{ versionId: string; versionNo: number }> {
  const asset = await prisma.clientAsset.findUnique({ where: { id: assetId }, select: { id: true, status: true } });
  if (!asset) throw new Error("Asset not found.");
  if (asset.status !== "ACTIVE") throw new Error("This asset is retired — reactivate it first.");
  if (!v.fileRef && !v.valueText?.trim()) throw new Error("A version needs a file or a value.");
  const last = await prisma.clientAssetVersion.findFirst({ where: { assetId }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true, contentHash: true } });
  const contentHash = sha(`${v.fileRef ?? ""}|${(v.valueText ?? "").trim()}|${v.valueJson ?? ""}`);
  if (last && last.contentHash === contentHash) {
    // Same file / same text as the HIGHEST version: nothing new to record —
    // but the highest version is not necessarily the ACTIVE one. After a
    // rollback (active v1, highest v2), re-uploading v2's file used to return
    // "saved as version 2, it is the default from here on" while the asset was
    // still pointing at v1. So make the claim true: point the asset at the
    // version we are handing back.
    await prisma.clientAsset.update({ where: { id: assetId }, data: { activeVersionId: last.id } });
    return { versionId: last.id, versionNo: last.versionNo };
  }
  const row = await prisma.clientAssetVersion.create({
    data: {
      assetId, versionNo: (last?.versionNo ?? 0) + 1, source: v.source, fileRef: v.fileRef ?? null, fileName: v.fileName ?? null, mimeType: v.mimeType ?? null, sizeBytes: v.sizeBytes ?? null,
      valueText: v.valueText?.trim() || null, valueJson: v.valueJson ?? null, contentHash, uploadedByStaffUserId: v.by, note: v.note?.trim() || null,
    },
    select: { id: true, versionNo: true },
  });
  await prisma.clientAsset.update({ where: { id: assetId }, data: { activeVersionId: row.id } });
  return { versionId: row.id, versionNo: row.versionNo };
}

/** Point the asset at an earlier version (a rollback is a pointer move, never a delete). */
export async function setActiveAssetVersion(assetId: string, versionId: string): Promise<void> {
  const v = await prisma.clientAssetVersion.findUnique({ where: { id: versionId }, select: { assetId: true } });
  if (!v || v.assetId !== assetId) throw new Error("That version belongs to another asset.");
  await prisma.clientAsset.update({ where: { id: assetId }, data: { activeVersionId: versionId } });
}

export async function retireAsset(assetId: string, retire: boolean): Promise<void> {
  await prisma.clientAsset.update({ where: { id: assetId }, data: retire ? { status: "RETIRED", retiredAt: new Date() } : { status: "ACTIVE", retiredAt: null } });
}

export async function updateAssetMeta(assetId: string, patch: { name?: string; ownership?: string; notes?: string | null; type?: AssetType }): Promise<void> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) { if (patch.name.trim().length < 2) throw new Error("Give the asset a name."); data.name = patch.name.trim(); }
  if (patch.ownership !== undefined) { if (!(OWNERSHIPS as readonly string[]).includes(patch.ownership)) throw new Error("Unknown ownership."); data.ownership = patch.ownership; }
  if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;
  if (patch.type !== undefined) { if (!isAssetType(patch.type)) throw new Error("Unknown asset type."); data.type = patch.type; }
  if (Object.keys(data).length) await prisma.clientAsset.update({ where: { id: assetId }, data });
}

// ---- the SOURCES the registry sits on top of --------------------------------------------

export type BrandSources = {
  client: { brandColors: string | null; brandAssetsPath: string | null; avatarUrl: string | null; portalVideoStyle: string | null; portalPreferences: string | null; generalNotes: string | null; email: string | null; phone: string | null; company: string | null };
  profile: Record<string, Record<string, string>>; // the six AgentProfile blobs, parsed
  folder: ClientAssets | null; // the Dropbox client folder listing (with temporary links)
  /** Dropbox files already registered as an asset version → asset id. */
  registeredPaths: Record<string, string>;
};

function parseBlob(json: string | null): Record<string, string> {
  try { const v = json ? JSON.parse(json) : {}; if (!v || typeof v !== "object" || Array.isArray(v)) return {}; return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, typeof x === "string" ? x : JSON.stringify(x)])); } catch { return {}; }
}

export async function brandSources(clientId: string, opts: { folder?: boolean } = {}): Promise<BrandSources | null> {
  const [client, profile, mine] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { brandColors: true, brandAssetsPath: true, avatarUrl: true, portalVideoStyle: true, portalPreferences: true, generalNotes: true, email: true, phone: true, company: true } }),
    prisma.agentProfile.findUnique({ where: { clientId } }),
    prisma.clientAsset.findMany({ where: { clientId }, select: { id: true } }),
  ]);
  if (!client) return null;
  const versions = mine.length ? await prisma.clientAssetVersion.findMany({ where: { assetId: { in: mine.map((a) => a.id) }, fileRef: { not: null } }, select: { assetId: true, fileRef: true } }) : [];
  const registeredPaths: Record<string, string> = {};
  for (const v of versions) if (v.fileRef) registeredPaths[v.fileRef.toLowerCase()] = v.assetId;
  const folder = opts.folder === false ? null : await listClientAssets(clientId, { links: true }).catch(() => null);
  return {
    client,
    profile: profile ? { brand: parseBlob(profile.brandJson), voice: parseBlob(profile.voiceJson), contentPrefs: parseBlob(profile.contentPrefsJson), production: parseBlob(profile.productionJson), editing: parseBlob(profile.editingJson), stories: parseBlob(profile.storiesJson) } : {},
    folder, registeredPaths,
  };
}

/**
 * The persistent defaults the EDITOR BRIEF should read (handover: edit/[id]):
 * active EDITING_INSTRUCTIONS / PRODUCTION_PREFERENCE / PRONUNCIATION values,
 * each with its provenance. Accepted client facts are a separate read
 * (clientFacts.productionFactsForProject) — this is the asset side only.
 */
export async function productionDefaults(clientId: string): Promise<{ type: AssetType; name: string; text: string; versionNo: number; source: string }[]> {
  const rows = await assetRegistry(clientId);
  return rows
    .filter((r) => (r.type === "EDITING_INSTRUCTIONS" || r.type === "PRODUCTION_PREFERENCE" || r.type === "PRONUNCIATION") && r.active?.valueText)
    .map((r) => ({ type: r.type, name: r.name, text: r.active!.valueText!, versionNo: r.active!.versionNo, source: r.active!.source }));
}
