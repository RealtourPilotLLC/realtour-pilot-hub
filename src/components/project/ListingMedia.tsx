import { Image as ImageIcon, Video, Map, CheckCircle2, Clock } from "lucide-react";
import { getListingMedia } from "@/lib/integrations/aryeo";
import { Badge } from "@/components/ui/Badge";

// Async server component: fetches a project's Aryeo listing media live. Rendered
// inside <Suspense> so the rest of the project page paints immediately.
export async function ListingMedia({ listingId }: { listingId: string }) {
  const media = await getListingMedia(listingId);
  if (!media) return null;

  const delivered = media.deliveryStatus === "DELIVERED";
  const hasAny = media.photoCount + media.videoCount + media.floorPlanCount > 0;
  if (!hasAny && !delivered) return null;

  return (
    <section className="rounded-2xl border bg-surface">
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Delivered media</h2>
        {media.deliveryStatus &&
          (delivered ? (
            <Badge color="#16a34a" soft="#dcfce7">
              <CheckCircle2 className="mr-0.5 inline size-3" /> Delivered
            </Badge>
          ) : (
            <Badge color="#d97706" soft="#fef3c7">
              <Clock className="mr-0.5 inline size-3" /> {media.deliveryStatus}
            </Badge>
          ))}
      </div>

      <div className="px-5 py-4">
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1">
            <ImageIcon className="size-3.5 text-brand" /> {media.photoCount} photos
          </span>
          <span className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1">
            <Video className="size-3.5 text-brand" /> {media.videoCount} videos
          </span>
          <span className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1">
            <Map className="size-3.5 text-brand" /> {media.floorPlanCount} floor plans
          </span>
        </div>

        {media.images.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {media.images.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <a key={i} href={img.large} target="_blank" rel="noopener noreferrer" className="group block">
                <img
                  src={img.thumb}
                  alt={img.caption ?? `Photo ${i + 1}`}
                  loading="lazy"
                  className="aspect-[4/3] w-full rounded-lg object-cover transition-transform group-hover:scale-[1.02]"
                />
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function ListingMediaSkeleton() {
  return (
    <section className="rounded-2xl border bg-surface">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold text-muted">Delivered media</h2>
      </div>
      <div className="px-5 py-4 text-xs text-muted">Loading media from Aryeo…</div>
    </section>
  );
}
