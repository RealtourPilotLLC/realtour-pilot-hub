import { CheckCircle2, Clock, ImageOff } from "lucide-react";
import { getListingMedia } from "@/lib/integrations/aryeo";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/Badge";
import { MediaGallery } from "@/components/project/MediaGallery";
import type { FlaggedImage } from "@/app/projects/flagActions";
import { PALETTE } from "@/lib/palette";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { getProjectReview } from "@/lib/review";
import type { ReviewData } from "@/components/review/types";

// Async server component: fetches a project's Aryeo media live, then hands it to
// the interactive gallery (grid + lightbox + downloads + photo flagging).
// Rendered inside <Suspense> so the rest of the project page paints immediately.
export async function ListingMedia({ listingId, title, projectId }: { listingId: string; title: string; projectId?: string }) {
  const media = await getListingMedia(listingId);
  if (!media) return null;

  // Open photo-fix flags for this project (for badges + the resolve list).
  const flagRows = projectId
    ? await prisma.imageFlag.findMany({ where: { projectId, status: "OPEN" }, orderBy: { createdAt: "desc" } })
    : [];
  const flagViews: FlaggedImage[] = flagRows.map((f) => ({
    id: f.id, thumbUrl: f.thumbUrl, imageUrl: f.imageUrl, caption: f.caption, note: f.note,
    tags: (() => { try { return JSON.parse(f.tags) as string[]; } catch { return []; } })(),
    createdAt: f.createdAt.toISOString(),
  }));

  // Review room data — the owner's desk only. Gate on the EFFECTIVE role so
  // "view as" shows exactly what that person sees: photographers/editors get
  // NO review affordances and never receive EDIT-lane notes (their capture
  // feedback arrives via the /shoot page instead). Sessionless local dev
  // (enforcement off, no login) renders as the owner so the room works
  // pre-cutover. Fetch failures just hide the room — never break the gallery.
  let review: ReviewData | undefined;
  if (projectId) {
    const viewer = await getCurrentUser().catch(() => null);
    const ownerDesk = viewer ? viewer.role === "OWNER" || viewer.role === "ADMIN" : !authEnforced();
    if (ownerDesk) {
      const r = await getProjectReview(projectId).catch(() => null);
      if (r) review = { notes: r.notes, verdicts: r.verdicts, enabled: true };
    }
  }

  const delivered = media.deliveryStatus === "DELIVERED";
  const hasAny = media.images.length + media.videos.length + media.floorPlans.length > 0;

  // A filename-safe slug from the address, used to name downloads.
  const slug = title.split(",")[0].trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "media";

  if (!hasAny) {
    if (!media.deliveryStatus) return null;
    return (
      <section className="rounded-2xl border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold">Media</h2>
          <StatusBadge delivered={delivered} status={media.deliveryStatus} />
        </div>
        <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted">
          <ImageOff className="size-4" /> Media isn’t live on Aryeo yet.
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-2">
      {media.deliveryStatus && (
        <div className="flex items-center justify-end">
          <StatusBadge delivered={delivered} status={media.deliveryStatus} />
        </div>
      )}
      <MediaGallery media={media} slug={slug} projectId={projectId} flags={flagViews} review={review} />
    </div>
  );
}

function StatusBadge({ delivered, status }: { delivered: boolean; status: string }) {
  return delivered ? (
    <Badge color={PALETTE.green}>
      <CheckCircle2 className="mr-0.5 inline size-3" /> Delivered
    </Badge>
  ) : (
    <Badge color={PALETTE.gold}>
      <Clock className="mr-0.5 inline size-3" /> {status.toLowerCase().replace(/_/g, " ")}
    </Badge>
  );
}

export function ListingMediaSkeleton() {
  return (
    <section className="rounded-2xl border bg-surface">
      <div className="border-b border-border px-5 py-3.5">
        <h2 className="text-sm font-semibold text-muted">Media</h2>
      </div>
      <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-surface-2" />
        ))}
      </div>
    </section>
  );
}
