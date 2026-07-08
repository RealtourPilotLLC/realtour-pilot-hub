import "server-only";
import { prisma } from "@/lib/prisma";
import { dropboxListFolder, dropboxConfigured } from "@/lib/integrations/dropbox";
import { getSecret } from "@/lib/integrations/connections";
import { generateTasksForActiveProjects } from "@/lib/tasks";

// ---------------------------------------------------------------------------
// Mirrors the Zapier "AutoHDR" folder convention so the hub knows exactly where
// photographers/editors upload, and can drive status from file presence:
//   /AutoHDR/{Year}/{Quarter}/{Month}/{Street} ({Client})/
//     01-RAW-Photos · 02-RAW-Video · 04-Final-Photos · 05-Final-Video
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type ProjectFolders = {
  listing: string;
  rawPhotos: string;
  rawVideo: string;
  finalPhotos: string;
  finalVideo: string;
};

type FolderProject = {
  title: string;
  addressLine: string | null;
  shootDate: Date | null;
  createdAt: Date;
  client: { name: string };
};

// Build the folder paths for a project following the Zap's naming.
export function projectFolderPaths(p: FolderProject): ProjectFolders {
  const date = p.shootDate ?? p.createdAt;
  const year = date.getFullYear();
  const month = MONTHS[date.getMonth()];
  const quarter = `Q${Math.floor(date.getMonth() / 3) + 1}`;
  const street = (p.addressLine || p.title.split(",")[0] || "Listing").trim();
  const listingName = `${street} (${p.client.name})`;
  const base = `/AutoHDR/${year}/${quarter}/${month}/${listingName}`;
  return {
    listing: base,
    rawPhotos: `${base}/01-RAW-Photos`,
    rawVideo: `${base}/02-RAW-Video`,
    finalPhotos: `${base}/04-Final-Photos`,
    finalVideo: `${base}/05-Final-Video`,
  };
}

async function folderFileCount(path: string): Promise<number> {
  try {
    const entries = await dropboxListFolder(path);
    return entries.filter((e) => e.tag === "file").length;
  } catch {
    return 0; // folder missing / not yet created
  }
}

// Web deep-link that opens a folder in the Dropbox web app (team members land
// in the team space they have access to).
export function dropboxWebUrl(path: string): string {
  return `https://www.dropbox.com/home${path.split("/").map(encodeURIComponent).join("/")}`;
}

// Live folder state for the upload portal: per-folder file counts + open links.
// Returns null when Dropbox isn't connected so the UI can degrade gracefully.
export async function getProjectFolderState(p: FolderProject): Promise<{
  connected: boolean;
  folders: { key: keyof ProjectFolders; label: string; path: string; url: string; count: number; raw: boolean }[];
  hasRaw: boolean;
  hasFinal: boolean;
} | null> {
  const f = projectFolderPaths(p);
  const defs: { key: keyof ProjectFolders; label: string; raw: boolean }[] = [
    { key: "rawPhotos", label: "Raw Photos", raw: true },
    { key: "rawVideo", label: "Raw Video", raw: true },
    { key: "finalPhotos", label: "Final Photos", raw: false },
    { key: "finalVideo", label: "Final Video", raw: false },
  ];

  const connected = dropboxConfigured() && !!(await getSecret("dropbox"));
  const counts = connected
    ? await Promise.all(defs.map((d) => folderFileCount(f[d.key])))
    : defs.map(() => 0);

  const folders = defs.map((d, i) => ({
    key: d.key,
    label: d.label,
    path: f[d.key],
    url: dropboxWebUrl(f[d.key]),
    count: counts[i],
    raw: d.raw,
  }));
  const hasRaw = folders.filter((x) => x.raw).some((x) => x.count > 0);
  const hasFinal = folders.filter((x) => !x.raw).some((x) => x.count > 0);
  return { connected, folders, hasRaw, hasFinal };
}

// Raw-photo folder count for ONE project (a single Dropbox call), for the upload
// list's "over budget" chip. Returns null when Dropbox isn't connected so the
// caller can skip the whole batch. Kept lean (raw photos only) so a list of
// shoots doesn't fan out four calls per row like getProjectFolderState.
export async function rawPhotoCounts(
  projects: FolderProject[],
): Promise<Map<FolderProject, number> | null> {
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) return null;
  const out = new Map<FolderProject, number>();
  await Promise.all(
    projects.map(async (p) => {
      out.set(p, await folderFileCount(projectFolderPaths(p).rawPhotos));
    }),
  );
  return out;
}

// Poll each active project's RAW + FINAL folders and advance status accordingly:
//   RAW files present  → SHOT  (photographer uploaded → ready for editing/QA)
//   FINAL files present → REVIEW (editor done → QC then deliver)
export async function syncDropboxFolderStatus(): Promise<{
  checked: number;
  movedToShot: number;
  movedToReview: number;
}> {
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) {
    throw new Error("Dropbox is not connected.");
  }

  const projects = await prisma.project.findMany({
    where: { source: "ARYEO", status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW"] } },
    include: { client: { select: { name: true } } },
  });

  let movedToShot = 0;
  let movedToReview = 0;

  for (const p of projects) {
    const f = projectFolderPaths(p);
    const [rawP, rawV, finP, finV] = await Promise.all([
      folderFileCount(f.rawPhotos),
      folderFileCount(f.rawVideo),
      folderFileCount(f.finalPhotos),
      folderFileCount(f.finalVideo),
    ]);
    const hasRaw = rawP + rawV > 0;
    const hasFinal = finP + finV > 0;

    if (hasFinal && (p.status === "SHOT" || p.status === "EDITING")) {
      await prisma.project.update({ where: { id: p.id }, data: { status: "REVIEW" } });
      await prisma.activity.create({
        data: { projectId: p.id, type: "SYSTEM", body: `Final media detected in Dropbox (${finP + finV} files) → moved to Review.` },
      });
      movedToReview++;
    } else if (hasRaw && (p.status === "BOOKED" || p.status === "SCHEDULED")) {
      await prisma.project.update({ where: { id: p.id }, data: { status: "SHOT", uploadedAt: new Date() } });
      await prisma.activity.create({
        data: { projectId: p.id, type: "SYSTEM", body: `Raw media detected in Dropbox (${rawP + rawV} files) → moved to Shot/Uploaded.` },
      });
      // Complete any open confirmation task for this project (the shoot happened).
      await prisma.smartTask.updateMany({
        where: { projectId: p.id, taskType: { in: ["confirmation_text", "appointment_prep"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      // Raws landed → ping the editors + mint the premium-reel Luma dispatch
      // task (audit crack #19). Idempotent; best-effort so it never breaks the sweep.
      try {
        const { notifyRawsLanded } = await import("@/lib/tasks");
        await notifyRawsLanded(p.id);
      } catch { /* non-fatal */ }
      movedToShot++;
    }
  }

  // Regenerate package tasks so the newly-SHOT projects get QA/delivery tasks.
  if (movedToShot > 0 || movedToReview > 0) await generateTasksForActiveProjects();

  return { checked: projects.length, movedToShot, movedToReview };
}
