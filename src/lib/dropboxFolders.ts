import "server-only";

import { prisma } from "@/lib/prisma";
import { dropboxCreateFolder, dropboxListFolder, dropboxMoveFolder, dropboxConfigured, DropboxError } from "@/lib/integrations/dropbox";
import { getSecret } from "@/lib/integrations/connections";
import { generateTasksForActiveProjects } from "@/lib/tasks";

// ---------------------------------------------------------------------------
// Mirrors the Zapier "AutoHDR" folder convention so the hub knows exactly where
// photographers/editors upload, and can drive status from file presence:
//   /AutoHDR/{Year}/{Quarter}/{Month}/{Street} ({Client})/
//     01-RAW-Photos · 02-RAW-Video · 03-Backup-Photos · 04-Final-Photos · 05-Final-Video
// (03-Backup-Photos added Aug 31 2026 — the culling standard's home for the
// extra frames; the Zap's original output had no 03, we fill the gap.)
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type ProjectFolders = {
  listing: string;
  rawPhotos: string;
  rawVideo: string;
  backupPhotos: string;
  finalPhotos: string;
  finalVideo: string;
};

export type FolderProject = {
  title: string;
  addressLine: string | null;
  shootDate: Date | null;
  createdAt: Date;
  client: { name: string };
  /** the folder the engine actually created/moved to, when it recorded one */
  dropboxFolder?: string | null;
};

// Year/month of a date IN EASTERN TIME. The Zap names folders by the shoot's
// local (ET) date; getFullYear()/getMonth() run in SERVER time — UTC on Vercel —
// so an ET evening shoot near a month/quarter boundary computed a DIFFERENT
// folder than the one the files actually live in, and every count read zero
// (July 2026 audit: "folder paths are guessed … UTC month boundary").
function etYearMonth(date: Date): { year: number; monthIdx: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((x) => x.type === "year")?.value ?? date.getFullYear());
  const monthIdx = Number(parts.find((x) => x.type === "month")?.value ?? date.getMonth() + 1) - 1;
  return { year, monthIdx };
}

// Build the folder paths for a project following the Zap's naming.
export function projectFolderPaths(p: FolderProject): ProjectFolders {
  const date = p.shootDate ?? p.createdAt;
  const { year, monthIdx } = etYearMonth(date);
  const month = MONTHS[monthIdx];
  const quarter = `Q${Math.floor(monthIdx / 3) + 1}`;
  const street = (p.addressLine || p.title.split(",")[0] || "Listing").trim();
  const listingName = `${street} (${p.client.name})`;
  const base = `/AutoHDR/${year}/${quarter}/${month}/${listingName}`;
  return foldersUnder(base);
}

function foldersUnder(base: string): ProjectFolders {
  return {
    listing: base,
    rawPhotos: `${base}/01-RAW-Photos`,
    rawVideo: `${base}/02-RAW-Video`,
    backupPhotos: `${base}/03-Backup-Photos`,
    finalPhotos: `${base}/04-Final-Photos`,
    finalVideo: `${base}/05-Final-Video`,
  };
}

/**
 * Where this job's files ACTUALLY live. projectFolderPaths() returns the
 * CONVENTION path (year/quarter/month/street) — ensureProjectFolders compares
 * against it to detect a reschedule and move the folder, so it must keep
 * returning the convention. But every READ surface wants the real location:
 * a shoot moved August→September leaves the files in September while the
 * convention still says August, so the portal read an empty/absent folder and
 * told the photographer "the RAW-Video folder is empty" (Jordan, Sep 1 —
 * Harrison; 4 live jobs were mis-pointed, incl. 775 Scotch Way).
 */
export function actualFolderPaths(p: FolderProject): ProjectFolders {
  const base = p.dropboxFolder?.trim();
  return base ? foldersUnder(base) : projectFolderPaths(p);
}

// ---------------------------------------------------------------------------
// FOLDER ENGINE — the hub took this over from Zapier (Aug 2026, the Zap broke
// and new bookings stopped getting folders; the backfill sweep found ELEVEN
// upcoming shoots with no folder). Jordan's ask, beyond what the Zap did:
// "it doesn't change the folder location when it's rescheduled or canceled."
//
// So the engine has three moves, and Project.dropboxFolder is its memory —
// the Zap could never handle reschedules because nothing remembered where the
// folder was put:
//   CREATE   no folder anywhere → listing + the four numbered subfolders
//   MOVE     stored path ≠ path computed from the CURRENT shoot date (a
//            reschedule crossed a month/quarter/year) → files/move_v2, files
//            ride along
//   ARCHIVE  job cancelled with a folder → move under /AutoHDR/Canceled/{Year}/
//            — never delete; a cancelled shoot can carry uploaded raws
//
// Triggers: the Aryeo webhook's APPOINTMENT branch (seconds after booking /
// reschedule / cancel) + the hourly cron sweep as the net. Idempotent at every
// layer: create swallows conflicts, move refuses to clobber an existing
// destination (returns "conflict" and leaves both for a human), archive skips
// anything already under /Canceled/.
// ---------------------------------------------------------------------------

const SUBFOLDERS: (keyof ProjectFolders)[] = ["rawPhotos", "rawVideo", "backupPhotos", "finalPhotos", "finalVideo"];

export type EnsureResult = "created" | "repaired" | "exists" | "moved" | "archived" | "conflict" | "skipped";

type EnsureProject = FolderProject & { id: string; status: string; dropboxFolder: string | null };

async function listingSubfolders(path: string): Promise<Set<string> | null> {
  try {
    return new Set((await dropboxListFolder(path)).filter((e) => e.tag === "folder").map((e) => e.name));
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return null;
    throw e; // auth/rate-limit — the caller must not mistake this for "absent"
  }
}

async function rememberPath(projectId: string, path: string, note?: string): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { dropboxFolder: path } });
  if (note) {
    await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: note } }).catch(() => {});
  }
}

// Make sure ONE project's Dropbox presence matches reality. The Zap's output
// is 01/02/04/05; the hub adds 03-Backup-Photos on create AND on the repair
// pass, so existing upcoming shoots pick it up on the next hourly sweep.
export async function ensureProjectFolders(p: EnsureProject): Promise<EnsureResult> {
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) return "skipped";

  // CANCELLED → archive the folder if we know where it is (or can compute it).
  if (p.status === "CANCELLED") {
    const from = p.dropboxFolder ?? (p.shootDate ? projectFolderPaths(p).listing : null);
    if (!from || from.includes("/Canceled/")) return "skipped"; // nothing to do / already archived
    if ((await listingSubfolders(from)) === null) return "skipped"; // no folder exists — nothing to archive
    const year = from.match(/^\/AutoHDR\/(\d{4})\//)?.[1] ?? "0000";
    const to = `/AutoHDR/Canceled/${year}/${from.split("/").pop()}`;
    const ok = await dropboxMoveFolder(from, to);
    await rememberPath(p.id, ok ? to : from, ok ? `Dropbox folder archived (job cancelled): ${to}` : undefined);
    return ok ? "archived" : "conflict";
  }

  // No shoot date yet → the path (year/quarter/month) isn't knowable. The
  // webhook/sweep runs again once the appointment lands.
  if (!p.shootDate) return "skipped";

  const f = projectFolderPaths(p);

  // RESCHEDULE — we know where the folder was, and it isn't where the current
  // shoot date says it should be. Move it (files ride along), then fall
  // through to verify the subfolders at the new location.
  if (p.dropboxFolder && p.dropboxFolder !== f.listing && !p.dropboxFolder.includes("/Canceled/")) {
    const oldExists = (await listingSubfolders(p.dropboxFolder)) !== null;
    if (oldExists) {
      const ok = await dropboxMoveFolder(p.dropboxFolder, f.listing);
      if (!ok) return "conflict"; // both old and new exist — a human must merge; do NOT clobber
      await rememberPath(p.id, f.listing, `Dropbox folder moved (reschedule): ${p.dropboxFolder} → ${f.listing}`);
      return "moved";
    }
    // Old location is gone (someone moved it by hand) — treat as fresh below.
  }

  const existing = await listingSubfolders(f.listing);
  if (existing) {
    const missing = SUBFOLDERS.filter((k) => !existing.has(f[k].split("/").pop()!));
    for (const k of missing) await dropboxCreateFolder(f[k]);
    if (p.dropboxFolder !== f.listing) await rememberPath(p.id, f.listing);
    return missing.length ? "repaired" : "exists";
  }

  await dropboxCreateFolder(f.listing);
  for (const k of SUBFOLDERS) await dropboxCreateFolder(f[k]);
  await rememberPath(p.id, f.listing, `Dropbox folders created: ${f.listing}`);
  return "created";
}

const ENSURE_SELECT = {
  id: true, title: true, addressLine: true, shootDate: true, createdAt: true,
  status: true, dropboxFolder: true, client: { select: { name: true } },
} as const;

// The hourly net: upcoming shoots get created/moved, freshly-cancelled jobs
// with a known folder get archived. One list call per project; sequential so
// a burst of bookings can't trip Dropbox rate limits.
export async function ensureFoldersForUpcomingShoots(): Promise<{
  checked: number; created: number; moved: number; archived: number; repaired: number; conflicts: string[]; failed: string[];
}> {
  const out = { checked: 0, created: 0, moved: 0, archived: 0, repaired: 0, conflicts: [] as string[], failed: [] as string[] };
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) return out;
  const windowStart = new Date(Date.now() - 86_400_000);
  const [upcoming, cancelled] = await Promise.all([
    prisma.project.findMany({
      where: { shootDate: { gte: windowStart, lte: new Date(Date.now() + 60 * 86_400_000) }, status: { notIn: ["CANCELLED"] } },
      orderBy: { shootDate: "asc" }, take: 80, select: ENSURE_SELECT,
    }),
    // Cancelled jobs whose folder we created/tracked and haven't archived yet.
    prisma.project.findMany({
      where: { status: "CANCELLED", dropboxFolder: { not: null, notIn: [] } },
      take: 20, select: ENSURE_SELECT,
    }).then((rows) => rows.filter((r) => r.dropboxFolder && !r.dropboxFolder.includes("/Canceled/"))),
  ]);
  for (const p of [...upcoming, ...cancelled]) {
    out.checked++;
    try {
      const r = await ensureProjectFolders(p);
      if (r === "created") out.created++;
      if (r === "moved") out.moved++;
      if (r === "archived") out.archived++;
      if (r === "repaired") out.repaired++;
      if (r === "conflict") out.conflicts.push(p.title.split(",")[0]);
    } catch {
      out.failed.push(p.title.split(",")[0]);
    }
  }
  return out;
}

// A missing folder is a trustworthy ZERO (nothing was uploaded there). Any
// OTHER failure — auth, rate limit, network — is UNKNOWN, not zero: an expired
// token used to render every folder "empty" to a photographer double-checking
// their 300-raw drop (July 2026 audit). Same null semantics as the status
// sweep's folderCount.
export async function folderFileCount(path: string, onError?: (e: unknown) => void): Promise<number | null> {
  try {
    // Recursive: a card dump inside a subfolder is still footage that's IN.
    const entries = await dropboxListFolder(path, { recursive: true });
    return entries.filter((e) => e.tag === "file").length;
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return 0;
    onError?.(e); // WHY it failed (429 vs 401) — the contract stays number|null
    return null; // couldn't look — the caller must not treat this as "empty"
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
  // count null = the read FAILED (auth/rate-limit/network) — render "?", never
  // "empty". A photographer double-checking a 300-raw drop must not see 0.
  folders: { key: keyof ProjectFolders; label: string; path: string; url: string; count: number | null; raw: boolean }[];
  hasRaw: boolean;
  hasFinal: boolean;
  readFailed: boolean;
} | null> {
  const f = actualFolderPaths(p);
  const defs: { key: keyof ProjectFolders; label: string; raw: boolean }[] = [
    { key: "rawPhotos", label: "Raw Photos", raw: true },
    { key: "rawVideo", label: "Raw Video", raw: true },
    { key: "backupPhotos", label: "Backup Photos", raw: true },
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
  const hasRaw = folders.filter((x) => x.raw).some((x) => (x.count ?? 0) > 0);
  const hasFinal = folders.filter((x) => !x.raw).some((x) => (x.count ?? 0) > 0);
  const readFailed = connected && counts.some((c) => c === null);
  return { connected, folders, hasRaw, hasFinal, readFailed };
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
      const n = await folderFileCount(projectFolderPaths(p).rawPhotos);
      // A failed read is unknown, not zero — omit the row so the over-budget
      // chip simply doesn't render rather than silently vanishing as "0 raws".
      if (n !== null) out.set(p, n);
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
    const [rawP, rawV, finP, finV] = (
      await Promise.all([
        folderFileCount(f.rawPhotos),
        folderFileCount(f.rawVideo),
        folderFileCount(f.finalPhotos),
        folderFileCount(f.finalVideo),
      ])
    ).map((n) => n ?? 0); // legacy manual sweep: unknown reads as 0 (advance-only logic)
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
