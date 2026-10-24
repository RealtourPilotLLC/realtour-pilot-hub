import Link from "next/link";
import { notFound } from "next/navigation";
import { Box, Briefcase, ExternalLink, FileText, Film, Images, LayoutGrid, MapPin, UserRound } from "lucide-react";
import { BackLink } from "@/components/ui/BackLink";
import { Section } from "@/components/ui/Section";
import { ListingGallery, type GalleryPhoto } from "@/components/media/ListingGallery";
import { VideoFileRow, VideoGroup } from "@/components/media/VideoTile";
import { toVideoView, type MediaVideoView } from "@/components/media/types";
import { requireMediaPage } from "@/lib/mediaAccess";
import { loadFinishedVideos, loadListingHeader } from "@/lib/mediaLibrary";
import { aryeoDownloadHref, readAryeoListing } from "@/lib/mediaListing";
import { cleanVideoTitle, fileStem, streetOf } from "@/lib/mediaLibraryCore";
import { aryeoJobUrl } from "@/lib/aryeoUrl";
import { etDateYear } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /listings/<job>: ONE LISTING, LIKE ARYEO'S PROPERTY PAGE (Oct 23 2026).
// The cover and the address, the agent, the delivered date; the photos in a
// grid with a full-screen viewer; the videos; the floor plans, 3D tours and
// files; every file downloadable on its own (and all photos, one file at a
// time). What the client received is read from the Aryeo listing, once per
// open (lib/mediaListing). The hub's own finished files for the job (the
// checked Topaz masters) sit under the videos. No ops status, no money,
// nothing that writes. Owner, office, creative manager.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{10,40}$/i;
const extOf = (url: string, fallback: string) => (/\.([a-z0-9]{2,4})(?:\?|$)/i.exec(new URL(url).pathname)?.[1] ?? fallback).toLowerCase();

export default async function ListingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!ID_RE.test(projectId)) notFound();
  await requireMediaPage(`/listings/${projectId}`);
  const head = await loadListingHeader(projectId);
  if (!head) notFound();
  const { project: p, otherShoots, indexCover } = head;

  const [aryeo, hub] = await Promise.all([
    p.aryeoListingId ? readAryeoListing(p.aryeoListingId) : Promise.resolve(null),
    // The hub's own files only: the listing's videos are read live just above (the index is /media's).
    loadFinishedVideos({ projectIds: [p.id] }).then((all) => all.filter((v) => !v.key.startsWith("aryeo:"))).catch((e) => { console.error("[listing page] hub videos failed", e); return [] as Awaited<ReturnType<typeof loadFinishedVideos>>; }),
  ]);

  const street = streetOf(p.title) || p.title;
  const town = p.title.split(",").slice(1).join(",").trim() || null;
  const stem = fileStem(p.title, "listing");
  const delivered = p.deliveredAt ? etDateYear(p.deliveredAt) : null;
  const cover = p.coverImageUrl ?? aryeo?.cover ?? indexCover ?? null;

  const photos: GalleryPhoto[] = (aryeo?.photos ?? []).map((ph, i) => ({
    thumb: ph.thumb, large: ph.large, caption: ph.caption,
    downloadHref: aryeoDownloadHref(ph.original, ph.filename ?? `${stem}-${String(i + 1).padStart(2, "0")}.${extOf(ph.original, "jpg")}`),
  }));
  const floorPlans: GalleryPhoto[] = (aryeo?.floorPlans ?? []).map((f, i) => ({
    thumb: f.thumb, large: f.large, caption: f.caption,
    downloadHref: aryeoDownloadHref(f.original, `${stem}-floor-plan-${i + 1}.${extOf(f.original, "jpg")}`),
  }));
  // The job's video rows say what shape its videos are cut in (a reel is vertical).
  const videoish = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const allReels = videoish.length > 0 && videoish.every((d) => d.type === "SOCIAL_REEL");
  const listingVideos: MediaVideoView[] = (aryeo?.videos ?? []).filter((v) => !!v.file).map((v, i) => {
    const title = cleanVideoTitle(v.title) ?? `Video ${i + 1}`;
    return {
      key: `aryeo:${v.id ?? i}`, title, eyebrow: null, place: null,
      clientId: p.client?.id ?? null, clientName: p.client?.name ?? null, projectId: p.id,
      dateText: delivered ? `Delivered ${delivered}` : null, orientation: null, poster: v.thumb,
      playSrc: v.file!, downloadHref: aryeoDownloadHref(v.file!, `${fileStem(title, "video")}.${extOf(v.file!, "mp4")}`), durationSec: v.duration,
    };
  });
  const hubVideos = hub.map((v) => toVideoView({ ...v, place: null }));
  const vertical = hubVideos.filter((v) => v.orientation === "vertical").length;
  const horizontal = hubVideos.filter((v) => v.orientation === "horizontal").length;
  const hubFrame: "vertical" | "horizontal" = vertical || horizontal ? (vertical >= horizontal ? "vertical" : "horizontal") : allReels ? "vertical" : "horizontal";
  const videoCount = Math.max(listingVideos.length, hubVideos.length);
  const facts = [
    photos.length ? `${photos.length} ${photos.length === 1 ? "photo" : "photos"}` : null,
    videoCount ? `${videoCount} ${videoCount === 1 ? "video" : "videos"}` : null,
    floorPlans.length ? `${floorPlans.length === 1 ? "Floor plan" : `${floorPlans.length} floor plans`}` : null,
    aryeo?.tours.length ? (aryeo.tours.length === 1 ? "3D tour" : `${aryeo.tours.length} tours`) : null,
  ].filter(Boolean);
  const aryeoUrl = aryeoJobUrl(p);
  const link = "inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

  return (
    <div data-listing-page={p.id}>
      <div className="mx-auto max-w-6xl space-y-5 p-4 pb-16 sm:p-6">
        <BackLink href="/listings" label="All listings" />

        <section aria-label="Listing" className="panel-shadow overflow-hidden rounded-3xl border bg-surface">
          <div className="relative aspect-[4/3] w-full sm:aspect-[21/9]">
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cover} alt={`${street}, the cover photo`} className="absolute inset-0 size-full object-cover" />
            ) : (
              <div aria-hidden className="absolute inset-0 bg-gradient-to-br from-surface-2 via-surface to-background" />
            )}
            <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-4 text-white sm:p-7">
              {delivered && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/80">Delivered {delivered}</p>}
              <h1 className="mt-1 break-words text-2xl font-semibold leading-tight tracking-tight sm:text-4xl">{street}</h1>
              {town && <p className="mt-1 flex items-center gap-1.5 text-sm text-white/80 sm:text-base"><MapPin aria-hidden className="size-4 shrink-0" />{town}</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 sm:px-7">
            <div className="min-w-0 flex-1 basis-56">
              {p.client && <p className="truncate text-sm font-semibold">{p.client.name}{p.client.company ? <span className="font-normal text-muted"> · {p.client.company}</span> : null}</p>}
              {facts.length > 0 && <p className="text-sm text-muted">{facts.join(" · ")}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {p.client && <Link href={`/clients/${p.client.id}`} className={link}><UserRound aria-hidden className="size-4" />Client</Link>}
              <Link href={`/projects/${p.id}`} className={link}><Briefcase aria-hidden className="size-4" />Job</Link>
              {aryeoUrl && <a href={aryeoUrl} target="_blank" rel="noopener noreferrer" className={link}>Aryeo<ExternalLink aria-hidden className="size-3.5" /></a>}
            </div>
          </div>
        </section>

        {!p.aryeoListingId ? (
          <p className="rounded-2xl border bg-surface p-4 text-sm text-muted">This job has no Aryeo listing linked, so only the hub&rsquo;s finished videos are shown.</p>
        ) : !aryeo ? (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">Aryeo didn&rsquo;t answer just now, so the listing&rsquo;s photos and files can&rsquo;t be shown. Refresh to try again.</p>
        ) : null}

        {photos.length > 0 && (
          <Section icon={Images} title="Photos" count={photos.length}>
            <ListingGallery photos={photos} />
          </Section>
        )}

        {(listingVideos.length > 0 || hubVideos.length > 0) && (
          <Section icon={Film} title="Videos" count={videoCount}>
            <div className="space-y-6">
              {listingVideos.length > 0 ? (
                <VideoGroup id="listing-videos" label="On the listing" frame={allReels ? "vertical" : "horizontal"} items={listingVideos} hideListing headingLevel={3} />
              ) : (
                <VideoGroup id="hub-videos" label="Finished videos" frame={hubFrame} items={hubVideos} hideListing headingLevel={3} />
              )}
              {listingVideos.length > 0 && hubVideos.length > 0 && (
                <div>
                  <h3 className="text-base font-semibold">Master files from the hub</h3>
                  <p className="text-xs text-muted">The finished file the hub keeps for each video (the checked Topaz file when there is one).</p>
                  <ul className="mt-1 divide-y">{hubVideos.map((v) => <VideoFileRow key={v.key} video={v} />)}</ul>
                </div>
              )}
            </div>
          </Section>
        )}

        {floorPlans.length > 0 && (
          <Section icon={LayoutGrid} title="Floor plans" count={floorPlans.length}>
            <ListingGallery photos={floorPlans} noun="floor plan" />
          </Section>
        )}

        {aryeo && aryeo.tours.length > 0 && (
          <Section icon={Box} title="3D tours and links" count={aryeo.tours.length}>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {aryeo.tours.map((t, i) => (
                <li key={`${t.url}-${i}`}>
                  <a href={t.url} target="_blank" rel="noopener noreferrer" className="flex min-h-16 items-center gap-3 rounded-xl border bg-surface-2/50 p-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                    {t.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.thumb} alt="" loading="lazy" className="size-14 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-surface text-muted"><Box aria-hidden className="size-5" /></span>
                    )}
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{t.title}</span><span className="block text-xs text-muted">Opens in a new tab</span></span>
                    <ExternalLink aria-hidden className="size-4 shrink-0 text-muted" />
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {aryeo && aryeo.files.length > 0 && (
          <Section icon={FileText} title="Files" count={aryeo.files.length} flush>
            <ul className="divide-y">
              {aryeo.files.map((f, i) => (
                <li key={`${f.url}-${i}`} className="flex items-center gap-3 px-5 py-2.5">
                  <FileText aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm">{f.title}</span>
                  <a href={f.url} target="_blank" rel="noopener noreferrer" className={link}>Open<ExternalLink aria-hidden className="size-3.5" /></a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {aryeo && p.aryeoListingId && photos.length + floorPlans.length + listingVideos.length + aryeo.tours.length + aryeo.files.length === 0 && hubVideos.length === 0 && (
          <p className="rounded-2xl border bg-surface p-6 text-center text-sm text-muted">Nothing is on this Aryeo listing yet.</p>
        )}

        {otherShoots.length > 0 && (
          <Section icon={MapPin} title="Other shoots at this address" count={otherShoots.length} flush>
            <ul className="divide-y">
              {otherShoots.map((o) => (
                <li key={o.projectId}>
                  <Link href={`/listings/${o.projectId}`} className="flex min-h-11 items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-surface-2">
                    <span>{o.dateText ? `Delivered ${o.dateText}` : "Delivered (date not recorded)"}</span>
                    <span className="text-brand">Open</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
