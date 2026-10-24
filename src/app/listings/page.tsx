import Link from "next/link";
import { Film, LayoutGrid } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MediaToolbar } from "@/components/media/MediaToolbar";
import { ListingTile } from "@/components/media/ListingTile";
import { requireMediaPage } from "@/lib/mediaAccess";
import { loadDeliveredListings } from "@/lib/mediaLibrary";
import { PAGE_SIZE, byDate, cleanQuery, inRange, matchesQuery, pageCount, parseRange, parseSort, rangeYears } from "@/lib/mediaLibraryCore";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /listings: every delivered listing, newest first, searchable (Oct 23 2026,
// Jordan: "Create listing pages too so we can review the final listings sent
// out just like Aryeo has listings"). Each card opens /listings/<job>, the
// property page. Read from what the hub stores (cover, photo count, what was
// ordered); nothing here calls Aryeo. Owner, office, creative manager.
// ---------------------------------------------------------------------------

type SP = { q?: string | string[]; range?: string | string[]; sort?: string | string[]; n?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ListingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireMediaPage("/listings");
  const sp = await searchParams;
  const q = cleanQuery(one(sp.q));
  const sort = parseSort(one(sp.sort));
  const range = parseRange(one(sp.range));
  const n = pageCount(one(sp.n));

  const all = await loadDeliveredListings().catch((e) => { console.error("[listings] read failed", e); return null; });
  const rows = all ? all.filter((l) => inRange(l.dateISO, range) && matchesQuery(q, [l.title, l.clientName])).sort(byDate(sort, (l) => l.dateISO)) : null;
  const years = rangeYears((all ?? []).map((l) => l.dateISO));
  const hrefMore = () => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (range.key !== "all") p.set("range", range.key);
    if (sort !== "new") p.set("sort", sort);
    p.set("n", String(n + PAGE_SIZE));
    return `/listings?${p.toString()}`;
  };

  return (
    <div data-listings-page>
      <PageHeader
        eyebrow="Library"
        title="Listings"
        sticky="desktop"
        subtitle={rows ? `${rows.length} delivered ${rows.length === 1 ? "listing" : "listings"}${q || range.key !== "all" ? " match" : ""}, newest first. Open one to see it as the client received it.` : "Every delivered listing."}
        actions={
          <Link href="/media" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium hover:bg-surface-2">
            <Film aria-hidden className="size-4" />Media
          </Link>
        }
      />
      <div className="mx-auto max-w-[110rem] space-y-5 p-4 pb-16 sm:p-6">
        <MediaToolbar key={`${q}|${range.key}|${sort}`} basePath="/listings" q={q} range={range.key} sort={sort} years={years} />
        {!rows ? (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">The listings could not be read just now. Refresh to try again.</p>
        ) : rows.length === 0 ? (
          <div className="panel-shadow rounded-2xl border bg-surface p-10 text-center">
            <LayoutGrid aria-hidden className="mx-auto size-8 text-brand" />
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">{q || range.key !== "all" ? "No listings match. Clear the search or pick another date." : "No delivered listings yet."}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {rows.slice(0, n).map((l) => <ListingTile key={l.projectId} listing={l} show="delivered" />)}
            </div>
            {rows.length > n && (
              <div className="flex justify-center">
                <Link scroll={false} href={hrefMore()} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-4 text-sm font-medium hover:bg-surface-2">
                  Show {Math.min(PAGE_SIZE, rows.length - n)} more <span className="text-muted">({rows.length - n} left)</span>
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
