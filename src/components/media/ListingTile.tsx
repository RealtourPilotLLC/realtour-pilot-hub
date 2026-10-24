import Link from "next/link";
import { ImageOff } from "lucide-react";

// One delivered listing (the Photos tab and /listings): its cover, the
// address, what was delivered and when. The whole card opens the listing
// page; an earlier shoot at the same address is its own small link.
// A listing with no stored cover shows a plain panel, never a stand-in photo.

export type ListingTileView = {
  projectId: string;
  street: string;
  town: string | null;
  clientName: string | null;
  dateText: string | null;
  cover: string | null;
  photoCount: number | null;
  delivered: string[];
  earlier: { projectId: string; dateText: string | null }[];
};

export function ListingTile({ listing, show = "photos" }: { listing: ListingTileView; show?: "photos" | "delivered" }) {
  const what = show === "photos" ? (listing.photoCount ? `${listing.photoCount} photos` : "Photos") : listing.delivered.join(" · ") || null;
  return (
    <article data-listing-tile={listing.projectId} className="group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-surface panel-shadow lift">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-2">
        {listing.cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={listing.cover} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none" />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-surface-2 to-surface text-muted-2">
            <ImageOff aria-hidden className="size-6" />
            <span className="text-[11px]">No cover stored</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 p-3">
        <h3 className="line-clamp-2 break-words text-sm font-semibold leading-snug">
          <Link href={`/listings/${listing.projectId}`} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
            {listing.street}
          </Link>
        </h3>
        {listing.town && <p className="truncate text-xs text-muted-2">{listing.town}</p>}
        {what && <p className="text-xs text-muted">{what}</p>}
        {listing.dateText && <p className="truncate text-xs text-muted">Delivered {listing.dateText}</p>}
        {listing.clientName && <p className="truncate text-xs text-muted">{listing.clientName}</p>}
        {listing.earlier.length > 0 && (
          <p className="relative z-[1] -mb-2 flex flex-wrap items-center gap-x-1 text-xs text-muted-2">
            <span>Also shot</span>
            {listing.earlier.slice(0, 3).map((e, i) => (
              <span key={e.projectId}>
                <Link href={`/listings/${e.projectId}`} className="inline-flex min-h-11 items-center text-brand underline-offset-2 hover:underline">{e.dateText ?? "earlier"}</Link>
                {i < Math.min(listing.earlier.length, 3) - 1 ? "," : ""}
              </span>
            ))}
            {listing.earlier.length > 3 && <span>and {listing.earlier.length - 3} more</span>}
          </p>
        )}
      </div>
      {/* The card's focus ring, drawn on the card (the stretched link carries focus). */}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-2xl ring-brand group-has-[a:focus-visible]:ring-2" />
    </article>
  );
}
