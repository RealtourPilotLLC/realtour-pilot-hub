import "server-only";
import { prisma } from "@/lib/prisma";
import { dropboxConfigured, dropboxCreateFolder } from "@/lib/integrations/dropbox";
import { dropboxWebUrl } from "@/lib/dropboxFolders";
import { getSecret } from "@/lib/integrations/connections";

// Per-client brand-assets folder convention. One home for each client's logo,
// fonts, brand colors and any brand kit, so editors/photographers always know
// where to look:
//   /RealTour Pilot/Clients/<Client Name>/Brand Assets
const CLIENTS_ROOT = "/RealTour Pilot/Clients";

function safeName(name: string): string {
  // Dropbox disallows / \ : ? * " < > | — strip them, collapse whitespace.
  return name.replace(/[\\/:?*"<>|]/g, " ").replace(/\s+/g, " ").trim() || "Client";
}

export function brandFolderPath(clientName: string): string {
  return `${CLIENTS_ROOT}/${safeName(clientName)}/Brand Assets`;
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
    // create_folder_v2 needs each level; create the parent client folder first.
    await dropboxCreateFolder(`${CLIENTS_ROOT}/${safeName(client.name)}`);
    await dropboxCreateFolder(path);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not create the folder." };
  }

  if (client.brandAssetsPath !== path) {
    await prisma.client.update({ where: { id: clientId }, data: { brandAssetsPath: path } });
  }
  return { ok: true, path, url: dropboxWebUrl(path), message: "Brand folder ready." };
}
