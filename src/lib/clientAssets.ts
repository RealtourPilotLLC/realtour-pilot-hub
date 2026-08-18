import "server-only";
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
          deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
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
          deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
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
