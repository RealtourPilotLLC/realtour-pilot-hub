import "server-only";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { refinedDeliverableLabel } from "@/lib/pipeline";
import type { ProjectStatus, DeliverableType } from "@prisma/client";

// ---------------------------------------------------------------------------
// Flattens a project into one tracker row (a spreadsheet-style line for the
// Pipeline / Editor tables). Derives the photo-vs-video split, the Premium/
// Standard video tier, and the RAW/Final Dropbox folder deep-links.
// ---------------------------------------------------------------------------

export type TrackerKind = "video" | "photo" | "other";

export type TrackerRow = {
  id: string;
  street: string;        // short address (table label)
  title: string;         // full address
  client: string | null;
  status: ProjectStatus;
  priority: string;
  shootISO: string | null;
  dueISO: string | null;
  deliveredISO: string | null;
  kind: TrackerKind;
  videoTier: "Premium" | "Standard" | null; // null = not a video project
  details: string;       // "Premium Social Reel", "Standard MLS Video", package, …
  deliverableCount: number;
  photographer: string | null;
  photographerColor: string | null;
  editor: string | null;
  editorColor: string | null;
  rawUrl: string;        // Dropbox raw folder (video → raw video, else raw photos)
  finalUrl: string;      // Dropbox final folder
  listingUrl: string;    // Dropbox listing root
};

const VIDEO_TYPES = new Set(["VIDEO", "SOCIAL_REEL"]);
const PHOTO_TYPES = new Set(["PHOTOS", "DRONE", "TWILIGHT", "HEADSHOT", "VIRTUAL_STAGING"]);

type TrackerProject = {
  id: string;
  title: string;
  addressLine: string | null;
  status: ProjectStatus;
  priority: string;
  shootDate: Date | null;
  deliveryDue: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  packageName: string | null;
  client: { name: string } | null;
  photographer: { name: string; avatarColor: string } | null;
  editor: { name: string; avatarColor: string } | null;
  deliverables: { type: string; label: string | null }[];
};

export function buildTrackerRows(projects: TrackerProject[]): TrackerRow[] {
  return projects.map((p) => {
    const dels = p.deliverables;
    const videoDel = dels.find((d) => VIDEO_TYPES.has(d.type));
    const isVideo = !!videoDel;
    const isPhoto = !isVideo && dels.some((d) => PHOTO_TYPES.has(d.type));
    const kind: TrackerKind = isVideo ? "video" : isPhoto ? "photo" : "other";
    const premium = isVideo && dels.some((d) => VIDEO_TYPES.has(d.type) && /premium/i.test(d.label ?? ""));
    const videoTier = isVideo ? (premium ? "Premium" : "Standard") : null;
    const details =
      isVideo && videoDel
        ? refinedDeliverableLabel(videoDel.type as DeliverableType, videoDel.label)
        : p.packageName || (isPhoto ? "Photos" : "—");

    const f = projectFolderPaths({
      title: p.title,
      addressLine: p.addressLine,
      shootDate: p.shootDate,
      createdAt: p.createdAt,
      client: { name: p.client?.name ?? "Client" },
    });

    return {
      id: p.id,
      street: (p.addressLine || p.title.split(",")[0] || p.title).trim(),
      title: p.title,
      client: p.client?.name ?? null,
      status: p.status,
      priority: p.priority,
      shootISO: p.shootDate ? p.shootDate.toISOString() : null,
      dueISO: p.deliveryDue ? p.deliveryDue.toISOString() : null,
      deliveredISO: p.deliveredAt ? p.deliveredAt.toISOString() : null,
      kind,
      videoTier,
      details,
      deliverableCount: dels.length,
      photographer: p.photographer?.name ?? null,
      photographerColor: p.photographer?.avatarColor ?? null,
      editor: p.editor?.name ?? null,
      editorColor: p.editor?.avatarColor ?? null,
      rawUrl: dropboxWebUrl(isVideo ? f.rawVideo : f.rawPhotos),
      finalUrl: dropboxWebUrl(isVideo ? f.finalVideo : f.finalPhotos),
      listingUrl: dropboxWebUrl(f.listing),
    };
  });
}
