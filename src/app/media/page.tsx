import Link from "next/link";
import { Film, Images, LayoutGrid } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MediaToolbar } from "@/components/media/MediaToolbar";
import { VideoGroup } from "@/components/media/VideoTile";
import { ListingTile } from "@/components/media/ListingTile";
import { toVideoView } from "@/components/media/types";
import { requireMediaPage } from "@/lib/mediaAccess";
import { loadDeliveredListings, loadFinishedVideos, photosByAddress, type ListingCard, type MediaVideo } from "@/lib/mediaLibrary";
import {
  MEDIA_TABS, PAGE_SIZE, byDate, cleanQuery, groupPlaced, inRange, isMediaTab, matchesQuery, pageCount, parseRange, parseSort, rangeYears,
  type MediaTab, type VideoTab,
} from "@/lib/mediaLibraryCore";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /media: THE MEDIA LIBRARY (Jordan, Oct 23 2026: "a really nice media page so
// we can see all of the videos that we have done and download them …
// strictly dedicated to media"). Four tabs: Standard videos and Premium
// videos (each by Style Guide type), Monthly social (by program package),
// Photos (by address). Every tile is a finished piece of work: its title, the
// video itself, the date it went out, the client and the address, with
// Download, View, the listing and the client one press away. Nothing on this
// page is ops status, a task or money, and nothing on it writes. The owner,
// the office and the creative manager (lib/mediaAccess).
// ---------------------------------------------------------------------------

type SP = { tab?: string | string[]; q?: string | string[]; range?: string | string[]; sort?: string | string[]; n?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const EMPTY: Record<MediaTab, string> = {
  standard: "No standard videos here yet.",
  premium: "No premium videos here yet.",
  monthly: "No monthly social videos here yet.",
  photos: "No delivered listings with photos here yet.",
};

export default async function MediaPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireMediaPage("/media");
  const sp = await searchParams;
  const tabParam = one(sp.tab);
  const tab: MediaTab = isMediaTab(tabParam) ? tabParam : "standard";
  const q = cleanQuery(one(sp.q));
  const sort = parseSort(one(sp.sort));
  const range = parseRange(one(sp.range));
  const n = pageCount(one(sp.n));

  const [videos, listings] = await Promise.all([
    loadFinishedVideos().catch((e) => { console.error("[media] videos read failed", e); return null; }),
    loadDeliveredListings().catch((e) => { console.error("[media] listings read failed", e); return null; }),
  ]);

  const keepVideo = (v: MediaVideo) => inRange(v.dateISO, range) && matchesQuery(q, [v.title, v.place, v.clientName, v.eyebrow, v.placement.groupLabel]);
  const keepListing = (l: ListingCard) => inRange(l.dateISO, range) && matchesQuery(q, [l.title, l.clientName]);
  const videosOn = (t: VideoTab) => (videos ?? []).filter((v) => v.placement.tab === t && keepVideo(v));
  const photos = listings ? photosByAddress(listings).filter(keepListing).sort(byDate(sort, (l) => l.dateISO)) : null;
  const counts: Record<MediaTab, number | null> = {
    standard: videos ? videosOn("standard").length : null,
    premium: videos ? videosOn("premium").length : null,
    monthly: videos ? videosOn("monthly").length : null,
    photos: photos ? photos.length : null,
  };
  const years = rangeYears([...(videos ?? []).map((v) => v.dateISO), ...(listings ?? []).map((l) => l.dateISO)]);
  const filtered = !!q || range.key !== "all";
  const hrefFor = (next: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged = { tab, q: q || null, range: range.key === "all" ? null : range.key, sort: sort === "new" ? null : sort, ...next };
    for (const [k, v] of Object.entries(merged)) if (v != null && v !== "" && !(k === "tab" && v === "standard")) p.set(k, String(v));
    const s = p.toString();
    return `/media${s ? `?${s}` : ""}`;
  };

  return (
    <div data-media-page data-tab={tab}>
      <PageHeader
        eyebrow="Library"
        title="Media"
        sticky="desktop"
        subtitle="Every finished video and listing, by type and date. Watch it, download it, or open its listing."
        actions={
          <Link href="/listings" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium hover:bg-surface-2">
            <LayoutGrid aria-hidden className="size-4" />All listings
          </Link>
        }
      />
      <div className="mx-auto max-w-[110rem] space-y-5 p-4 pb-16 sm:p-6">
        <nav aria-label="Media type" className="grid grid-cols-4 gap-1 rounded-2xl border bg-surface p-1 sm:inline-grid sm:auto-cols-max sm:grid-flow-col">
          {MEDIA_TABS.map((t) => {
            const active = t.key === tab;
            return (
              <Link
                key={t.key}
                href={hrefFor({ tab: t.key, n: null })}
                aria-current={active ? "page" : undefined}
                data-media-tab={t.key}
                className={cn(
                  "flex min-h-11 min-w-0 flex-col items-center justify-center rounded-xl px-2 text-center text-xs font-semibold leading-tight sm:flex-row sm:gap-2 sm:px-4 sm:text-sm",
                  active ? "bg-brand-soft text-brand ring-1 ring-inset ring-brand/25" : "text-muted hover:bg-surface-2 hover:text-foreground",
                )}
              >
                <span className="sm:hidden">{t.short}</span>
                <span className="hidden sm:inline">{t.label}</span>
                <span data-count={counts[t.key] ?? ""} className={cn("tabular-nums text-[11px] font-medium sm:text-xs", active ? "text-brand/80" : "text-muted-2")}>{counts[t.key] ?? "–"}</span>
              </Link>
            );
          })}
        </nav>

        <MediaToolbar key={`${q}|${range.key}|${sort}`} basePath="/media" tab={tab === "standard" ? null : tab} q={q} range={range.key} sort={sort} years={years} />

        {tab === "photos" ? (
          !photos ? (
            <Unavailable />
          ) : photos.length === 0 ? (
            <Empty icon={Images} text={filtered ? "No listings match. Clear the search or pick another date." : EMPTY.photos} />
          ) : (
            <section aria-label="Photos by address" className="space-y-4">
              <p className="text-xs text-muted">One tile per address, the newest shoot there first. Open one for its full gallery and downloads.</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                {photos.slice(0, n).map((l) => <ListingTile key={l.projectId} listing={l} show="photos" />)}
              </div>
              {photos.length > n && (
                <div className="flex justify-center">
                  <Link scroll={false} href={hrefFor({ n: n + PAGE_SIZE })} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-4 text-sm font-medium hover:bg-surface-2">
                    Show {Math.min(PAGE_SIZE, photos.length - n)} more <span className="text-muted">({photos.length - n} left)</span>
                  </Link>
                </div>
              )}
            </section>
          )
        ) : !videos ? (
          <Unavailable />
        ) : (() => {
          const groups = groupPlaced(videosOn(tab), sort);
          if (groups.length === 0) return <Empty icon={Film} text={filtered ? "No videos match. Clear the search or pick another date." : EMPTY[tab]} />;
          return (
            <div className="space-y-8">
              {groups.map((g) => (
                <VideoGroup key={g.key} id={g.key} label={g.label} frame={g.frame} items={g.items.map(toVideoView)} />
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function Empty({ icon: Icon, text }: { icon: typeof Film; text: string }) {
  return (
    <div className="panel-shadow rounded-2xl border bg-surface p-10 text-center">
      <Icon aria-hidden className="mx-auto size-8 text-brand" />
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{text}</p>
    </div>
  );
}

function Unavailable() {
  return <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">The library could not be read just now. Refresh to try again.</p>;
}
