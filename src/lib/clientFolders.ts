import "server-only";
import { prisma } from "@/lib/prisma";
import { dropboxConfigured, dropboxCreateFolder } from "@/lib/integrations/dropbox";
import { dropboxWebUrl } from "@/lib/dropboxFolders";
import { getSecret } from "@/lib/integrations/connections";

// Per-client brand-assets folder convention. One home for each client's logo,
// endcards, fonts and any brand kit, so editors/photographers always know
// where to look:
//   /AutoHDR/Client Assets/<Client Name>
// Under /AutoHDR because that's the tree the Dropbox app can WRITE — the old
// "/RealTour Pilot/Clients" root answered path/no_write_permission for every
// create (verified live Aug 17), so no folder was ever actually made there.
// Clients whose brandAssetsPath already points somewhere custom keep it.
const CLIENTS_ROOT = "/AutoHDR/Client Assets";

function safeName(name: string): string {
  // Dropbox disallows / \ : ? * " < > | — strip them, collapse whitespace.
  return name.replace(/[\\/:?*"<>|]/g, " ").replace(/\s+/g, " ").trim() || "Client";
}

export function brandFolderPath(clientName: string): string {
  return `${CLIENTS_ROOT}/${safeName(clientName)}`;
}

export async function dropboxConnected(): Promise<boolean> {
  return dropboxConfigured() && !!(await getSecret("dropbox"));
}

// Create (idempotently) the client's brand-assets folder + persist its path.
// Returns the path + a web link that opens it in the team's Dropbox.
export async function ensureClientBrandFolder(
  clientId: string,
): Promise<{ ok: boolean; path?: string; url?: string; message: string }> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, brandAssetsPath: true },
  });
  if (!client) return { ok: false, message: "Client not found." };
  if (!(await dropboxConnected())) {
    return { ok: false, message: "Dropbox isn't connected — add it in Connections first." };
  }

  const path = client.brandAssetsPath || brandFolderPath(client.name);
  try {
    // Only build the canonical parent when we're on the canonical path — a
    // custom stored path must not spawn a stray empty canonical folder.
    if (!client.brandAssetsPath) await dropboxCreateFolder(CLIENTS_ROOT);
    await dropboxCreateFolder(path);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not create the folder." };
  }

  if (client.brandAssetsPath !== path) {
    await prisma.client.update({ where: { id: clientId }, data: { brandAssetsPath: path } });
  }
  return { ok: true, path, url: dropboxWebUrl(path), message: "Brand folder ready." };
}
