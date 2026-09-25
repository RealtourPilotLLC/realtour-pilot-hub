import Link from "next/link";
import { ArrowLeft, Archive, Camera, ChevronLeft, ChevronRight, Clapperboard, Download, FileText, Film, Lock, PlayCircle, Search, Tag } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { VideoListPage, VideoListRow, ClientVideoState, LibrarySection } from "@/lib/contentVideos";
import type { CutVersion } from "@/lib/clientDecisions";
import type { PostingKit } from "@/lib/postingKit";
import type { LibraryView } from "@/lib/portalHome";
import { LIBRARY_FILTERS, VIDEO_WORDS } from "@/lib/portalWords";
import { Card, CardTitle, Empty, LoadFailed, StatusChip, fmtShort } from "@/components/portal/ui";
import { CutReview } from "@/components/portal/CutReview";
import { PostingKitPanel } from "@/components/portal/PostingKitPanel";
import { PortalPlayer } from "@/components/portal/PortalPlayer";
import { ScriptView } from "@/components/script/ScriptView";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// MY VIDEOS (spec §7): a scrollable list grouped by the program month each
// video FULFILS, newest first, with year navigation and pagination — every
// video the client was ever given is reachable. Rows show a thumbnail, title,
// state and one action; filmed and delivered dates are shown separately; a
// listing video says so and never counts as program allowance. The player
// only mounts on the detail view.
//
// PREVIOUS CONTENT (CP-12): older backfill whose month we cannot vouch for is
// one flat section after the months, dated by delivery — it used to lead page
// one as "Undated" and sit under shoot months the program never ran. A staff
// member who confirms a row moves it under its month.
// ---------------------------------------------------------------------------

const STATE: Record<ClientVideoState, { label: string; cls: string; action: string }> = {
  FOR_REVIEW: { label: "For your review", cls: "bg-brand-soft text-brand", action: "Review" },
  CHANGES_IN_PROGRESS: { label: "Changes in progress", cls: "bg-warning-soft text-warning", action: "Open" },
  // The library cannot know WHO approved without reading every decision, and a
  // viewer seat must not be told "by you" about somebody else's approval.
  APPROVED: { label: "Approved", cls: "bg-success-soft text-success", action: "Open" },
  DELIVERED: { label: "Delivered", cls: "bg-success-soft text-success", action: "Open" },
  IN_PRODUCTION: { label: "In production", cls: "bg-surface-2 text-muted", action: "Details" },
};

const chip = (on: boolean) => cn("rounded-full border px-2.5 py-1 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", on ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted");

function VideoRow({ v, to, previous }: { v: VideoListRow; to: string; previous: boolean }) {
  const st = STATE[v.state];
  return (
    <li>
      <Link href={to} className="flex items-center gap-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded-md bg-surface-2">
          {v.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <Film className="absolute inset-0 m-auto size-4 text-muted-2" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold leading-snug">{v.title}</span>
            <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", st.cls)}>{st.label}</span>
            {v.kind !== "PROGRAM" && <span className="inline-flex items-center gap-0.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted"><Tag className="size-2.5" /> {v.kind === "LISTING" ? "Listing video" : v.kind === "EXTRA" ? "Extra" : v.kind.toLowerCase()}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-2">
            {/* A Previous row is dated by delivery only: its filming date is as uncertain as its month. */}
            {!previous && v.filmedAtISO && <span>Filmed {fmtShort(v.filmedAtISO)}</span>}
            {v.deliveredAtISO && <span>Delivered {fmtShort(v.deliveredAtISO)}</span>}
            {!previous && v.pillarName && <span>{v.pillarName}</span>}
            {!previous && v.format && <span>{v.format.replace(/_/g, " ")}</span>}
          </div>
        </div>
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold", v.needsDecision ? "bg-brand text-white" : "border border-border text-muted")}>{st.action} <ChevronRight className="size-3.5" /></span>
      </Link>
    </li>
  );
}

export function VideosList({ page, failed, href }: { page: VideoListPage | null; failed: boolean; href: (tab: string, extra?: string) => string }) {
  if (failed) return <div className="mt-6"><LoadFailed what="your video library" /></div>;
  if (!page) return null;
  const recent = page.rows.filter((r) => r.section !== "PREVIOUS");
  const previous = page.rows.filter((r) => r.section === "PREVIOUS");
  const groups = new Map<string, VideoListRow[]>();
  for (const r of recent) { const k = r.monthKey ?? ""; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const q = (extra: string) => href("videos", extra);
  // Page links keep whichever filter produced this page.
  const scope = page.section ? "filter=previous&" : page.year ? `year=${page.year}&` : "";
  const showNav = page.years.length > 1 || page.pages > 1 || (page.previousTotal > 0 && page.years.length > 0);
  return (
    <div className="mt-6 space-y-4">
      {/* Year navigation + Previous content + count */}
      {showNav && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-2">{page.total} video{page.total === 1 ? "" : "s"}</span>
          <span className="mx-1 text-muted-2">·</span>
          <Link href={q("")} className={chip(!page.year && !page.section)}>All</Link>
          {page.years.map((y) => (
            <Link key={y} href={q(`year=${y}`)} className={chip(page.year === y)}>{y}</Link>
          ))}
          {page.previousTotal > 0 && <Link href={q("filter=previous")} className={chip(!!page.section)}>Previous content</Link>}
        </div>
      )}
      {page.rows.length === 0 ? (
        <Empty icon={Clapperboard}>No videos yet. They land here as each session is delivered — <Link href={href("schedule")} className="font-medium text-brand hover:underline">book your session</Link> to get the first one moving.</Empty>
      ) : (
        <>
          {[...groups.entries()].map(([monthKey, rows]) => (
            <Card key={monthKey}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-base font-semibold">{monthLabel(monthKey)}</span>
                <span className="text-xs text-muted-2">{rows.filter((r) => r.countsTowardAllowance).length} program video{rows.filter((r) => r.countsTowardAllowance).length === 1 ? "" : "s"}{rows.some((r) => !r.countsTowardAllowance) ? ` · ${rows.filter((r) => !r.countsTowardAllowance).length} other` : ""}</span>
              </div>
              <ul className="mt-3 divide-y divide-border">
                {rows.map((v) => <VideoRow key={v.id} v={v} to={q(`v=${v.id}`)} previous={false} />)}
              </ul>
            </Card>
          ))}
          {previous.length > 0 && (
            <Card>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="inline-flex items-center gap-1.5 text-base font-semibold"><Archive className="size-4 text-muted-2" /> Previous content</span>
                <span className="text-xs text-muted-2">{page.previousTotal} video{page.previousTotal === 1 ? "" : "s"}</span>
              </div>
              <p className="mt-1 text-xs text-muted">Videos we made for you before your program moved onto this page. They&rsquo;re yours to watch and download as always; the dates shown are when each one was delivered.</p>
              <ul className="mt-3 divide-y divide-border">
                {previous.map((v) => <VideoRow key={v.id} v={v} to={q(`v=${v.id}`)} previous />)}
              </ul>
            </Card>
          )}
        </>
      )}
      {page.pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between text-xs">
          {page.page > 1 ? <Link href={q(`${scope}page=${page.page - 1}`)} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><ChevronLeft className="size-3.5" /> Newer</Link> : <span />}
          <span className="text-muted-2">Page {page.page} of {page.pages}</span>
          {page.page < page.pages ? <Link href={q(`${scope}page=${page.page + 1}`)} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Older <ChevronRight className="size-3.5" /></Link> : <span />}
        </nav>
      )}
    </div>
  );
}

export type VideoDetailData = {
  video: {
    id: string; title: string; monthKey: string | null; kind: string; state: ClientVideoState; filmedAtISO: string | null; deliveredAtISO: string | null; pillarName: string | null; format: string | null;
    /** CP-12: a PREVIOUS video is never labelled with its (uncertain) month. */
    section?: LibrarySection;
  };
  versions: CutVersion[];
  versionsFailed: boolean;
  kit: PostingKit | null;
  kitFailed: boolean;
  /** The delivered (Aryeo) playable file with its media-safe URL, when the video has no hub cut. */
  delivered: { playback: string; thumb: string | null } | null;
  downloadHref: string | null;
  perms: { comment: boolean; request: boolean; approve: boolean; suggest: boolean };
  readOnly: boolean;
  /** Set only on the emailed-link seat, which can never approve: where to go to get a seat that can. */
  signInHref: string | null;
};

export function VideoDetail({ d, href }: { d: VideoDetailData; href: (tab: string, extra?: string) => string }) {
  const st = STATE[d.video.state];
  const hasCut = d.versions.some((v) => v.isCurrent && v.assetUrl);
  return (
    <div className="mt-6 space-y-4">
      <Link href={href("videos")} className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><ArrowLeft className="size-3.5" /> My Videos</Link>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{d.video.title}</h1>
          <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", st.cls)}>{st.label}</span>
          {d.video.kind !== "PROGRAM" && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">{d.video.kind === "LISTING" ? "Listing video — not part of your monthly program" : d.video.kind === "EXTRA" ? "Extra" : d.video.kind.toLowerCase()}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-2">
          {d.video.section === "PREVIOUS" ? <span>Previous content</span> : d.video.monthKey && <span>{monthLabel(d.video.monthKey)}</span>}
          {d.video.section !== "PREVIOUS" && d.video.filmedAtISO && <span className="inline-flex items-center gap-1"><Camera className="size-3" /> Filmed {fmtShort(d.video.filmedAtISO)}</span>}
          {d.video.deliveredAtISO && <span>Delivered {fmtShort(d.video.deliveredAtISO)}</span>}
          {d.video.pillarName && <span>{d.video.pillarName}</span>}
        </div>
      </div>

      {/* Watch + Review */}
      <Card tone={d.video.state === "FOR_REVIEW" ? "brand" : "default"}>
        <CardTitle icon={PlayCircle}>{hasCut ? "Watch & review" : "Watch"}</CardTitle>
        {d.versionsFailed ? (
          <div className="mt-2"><LoadFailed what="this video's versions" /></div>
        ) : hasCut ? (
          <div className="mt-2">
            {d.perms.request && !d.readOnly && d.video.state === "FOR_REVIEW" && <p className="mb-2 text-xs text-muted-2">Pause where you&rsquo;d change something and save a note; send them all as one change request — or approve this version.</p>}
            <CutReview versions={d.versions} perms={{ comment: d.perms.comment, request: d.perms.request, approve: d.perms.approve }} readOnly={d.readOnly} poster={d.delivered?.thumb ?? null} signInHref={d.signInHref} />
          </div>
        ) : d.delivered ? (
          <div className="mt-2"><PortalPlayer src={d.delivered.playback} poster={d.delivered.thumb} /></div>
        ) : (
          <p className="mt-2 text-sm text-muted">Nothing to watch yet — the first cut appears here after filming and editing.</p>
        )}
      </Card>

      {/* Posting kit: Caption & CTA, Downloads, posted/downloaded facts */}
      <Card>
        <CardTitle icon={FileText}>Caption, CTA &amp; downloads</CardTitle>
        {d.kitFailed ? (
          <div className="mt-2"><LoadFailed what="the posting kit" /></div>
        ) : d.kit ? (
          <div className="mt-2">
            <PostingKitPanel
              videoId={d.video.id} title={d.video.title} downloadHref={d.kit.access.download ? d.downloadHref : null} download={d.kit.download} access={d.kit.access} finalLabel={d.kit.final?.label ?? null} finalNote={d.kit.finalNote}
              captions={d.kit.captions} assistant={d.kit.assistant} postedAtISO={d.kit.postedAtISO} downloadStartedAtISO={d.kit.downloadStartedAtISO} downloadCompletedAtISO={d.kit.downloadCompletedAtISO}
              canEdit={d.perms.suggest && !d.readOnly} transcriptGap={d.kit.transcript.gap}
            />
            {d.kit.final?.approvedByLabel && <p className="mt-2 text-[11px] text-muted-2">Version {d.kit.final.label} was approved by {d.kit.final.approvedByLabel}{d.kit.final.approvedAtISO ? ` on ${fmtShort(d.kit.final.approvedAtISO)}` : ""}.</p>}
            {d.kit.cover && (
              <div className="mt-3">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Cover</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={d.kit.cover} alt="Cover frame" className="mt-1.5 max-h-40 rounded-lg border border-border" />
              </div>
            )}
          </div>
        ) : null}
      </Card>

      {/* Script & transcript */}
      <Card>
        <CardTitle icon={FileText}>Script &amp; transcript</CardTitle>
        {d.kitFailed ? (
          <div className="mt-2"><LoadFailed what="the script and transcript" /></div>
        ) : (
          <div className="mt-2 space-y-2">
            {d.kit?.script ? (
              <details className="rounded-xl border border-border bg-surface-2/40 px-4 py-3" open={!d.kit.script.historical}>
                <summary className="cursor-pointer text-sm font-bold">{d.kit.script.title} <span className="ml-1 text-[11px] font-normal text-muted-2">{d.kit.script.historical ? "from your script history" : d.kit.script.versionLabel ? `script ${d.kit.script.versionLabel}` : "script"}{d.kit.script.strategyLabel ? ` \u00b7 strategy ${d.kit.script.strategyLabel}` : ""}</span></summary>
                {/* An imported script is a record we hold, not this video's script (Jordan's ruling: imported scripts stay history). Say so before the words. */}
                {d.kit.script.historical && <p className="mt-2 text-xs text-muted">This is an earlier script we have on file for this topic — kept as history, not the script this video was made from.</p>}
                <ScriptView body={d.kit.script.body} fileTitle={d.kit.script.title} />
              </details>
            ) : (
              <p className="text-sm text-muted">No script is linked to this video.</p>
            )}
            {d.kit?.transcript.text ? (
              <details className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
                <summary className="cursor-pointer text-sm font-bold">Transcript of the final cut <span className="ml-1 text-[11px] font-normal text-muted-2">{d.kit.transcript.source === "corrected" ? "checked by us" : "automatic"}</span></summary>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">{d.kit.transcript.text}</p>
              </details>
            ) : (
              <p className="text-xs text-muted-2">No transcript yet{d.kit?.transcript.gap ? ` — ${d.kit.transcript.gap}` : "."}</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

// ===========================================================================
// CONTENT LIBRARY — the v2 layout (UI-01, Sep 24 2026). Same data, same
// detail loaders, same CutReview / PostingKitPanel; a different order of
// things. Review first (every video waiting on the client, whatever page),
// then a search box and four plain status filters, then the months, then
// Previous content. The v1 list and detail above are what real clients see
// until `portal_layout_v2` is on, and are deliberately left as they were.
// ===========================================================================

export type LibraryV2Data = {
  view: LibraryView;
  /** CP-02 deadline labels by video id (empty while revision_policy is off). */
  deadlines: Record<string, string>;
  /** Query pairs the search form repeats so the visit stays on this program (e=, layout=). */
  hidden: [string, string][];
  /** The library is larger than one read covers (never true today). */
  incomplete: boolean;
};

type Href = (tab: string, extra?: string) => string;
const linkQuery = (parts: Record<string, string | number | null | undefined>) => Object.entries(parts).filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== "all" && v !== 1).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

function VideoRowV2({ v, to, deadline, previous }: { v: VideoListRow; to: string; deadline?: string | null; previous: boolean }) {
  return (
    <li>
      <Link href={to} className={cn("flex min-h-14 items-center gap-3 rounded-lg py-2.5", focus)}>
        <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded-md bg-surface-2">
          {v.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <Film className="absolute inset-0 m-auto size-4 text-muted-2" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm font-semibold leading-snug">{v.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusChip word={VIDEO_WORDS[v.state]} />
            {v.kind !== "PROGRAM" && <span className="inline-flex items-center gap-0.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-muted"><Tag className="size-2.5" aria-hidden /> {v.kind === "LISTING" ? "Listing video" : v.kind === "EXTRA" ? "Extra" : v.kind.toLowerCase()}</span>}
            {deadline && <span className="text-[11px] font-medium text-foreground/80">Review by {deadline}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-2">
            {!previous && v.filmedAtISO && <span>Filmed {fmtShort(v.filmedAtISO)}</span>}
            {v.deliveredAtISO && <span>Delivered {fmtShort(v.deliveredAtISO)}</span>}
            {!previous && v.pillarName && <span>{v.pillarName}</span>}
          </div>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-2" aria-hidden />
      </Link>
    </li>
  );
}

export function LibraryV2({ d, failed, href }: { d: LibraryV2Data | null; failed: boolean; href: Href }) {
  if (failed) return <div className="mt-6"><LoadFailed what="your content library" /></div>;
  if (!d) return null;
  const { view } = d;
  const q = (parts: Record<string, string | number | null | undefined>) => href("videos", linkQuery(parts));
  const recent = view.rows.filter((r) => r.section !== "PREVIOUS");
  const previous = view.rows.filter((r) => r.section === "PREVIOUS");
  const months = new Map<string, VideoListRow[]>();
  for (const r of recent) { const k = r.monthKey ?? ""; months.set(k, [...(months.get(k) ?? []), r]); }
  const nothingAtAll = view.counts.all === 0 && !view.q;
  const filterLabel = LIBRARY_FILTERS.find((f) => f.key === view.st)?.label ?? "All";
  return (
    <div className="mt-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Content Library</h1>
        <p className="mt-0.5 text-xs text-muted">Every video we&rsquo;ve made for you. Anything waiting on your review comes first.</p>
      </div>

      {!nothingAtAll && (
        <div className="space-y-2">
          {/* A plain GET form: works before any script loads, and the address it
              lands on is the one a client can bookmark or send back to us. */}
          <form method="get" role="search" className="flex gap-2">
            {d.hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <input type="hidden" name="tab" value="library" />
            {view.st !== "all" && <input type="hidden" name="st" value={view.st} />}
            <label htmlFor="library-search" className="sr-only">Search your videos by title</label>
            <input id="library-search" type="search" name="q" defaultValue={view.q} placeholder="Search by title" className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" />
            <button type="submit" className={cn("inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-semibold", focus)}><Search className="size-4" aria-hidden /> Search</button>
          </form>
          <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            {LIBRARY_FILTERS.map((f) => (
              <Link key={f.key} href={q({ q: view.q, st: f.key })} aria-current={view.st === f.key ? "page" : undefined}
                className={cn("inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-semibold sm:min-h-9", focus, view.st === f.key ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground")}>
                {f.label} · {view.counts[f.key]}
              </Link>
            ))}
          </nav>
          {view.q && (
            <p className="text-xs text-muted">
              {view.matched} video{view.matched === 1 ? "" : "s"} match &ldquo;{view.q}&rdquo;{view.st !== "all" ? ` under “${filterLabel}”` : ""}. <Link href={q({ st: view.st })} className="font-medium text-brand hover:underline">Clear the search</Link>
            </p>
          )}
        </div>
      )}

      {nothingAtAll ? (
        <Empty icon={Clapperboard}>No videos yet. They land here as each session is delivered — <Link href={href("schedule")} className="font-medium text-brand hover:underline">book your session</Link> to get the first one moving.</Empty>
      ) : view.matched === 0 ? (
        <Empty icon={Search}>
          {view.q ? <>Nothing matches &ldquo;{view.q}&rdquo;{view.st !== "all" ? ` under “${filterLabel}”` : ""}. <Link href={q({})} className="font-medium text-brand hover:underline">Show every video</Link></> : <>No videos under &ldquo;{filterLabel}&rdquo; right now. <Link href={q({})} className="font-medium text-brand hover:underline">Show every video</Link></>}
        </Empty>
      ) : null}

      {/* 1. Waiting on you — all of them, never page-bound. */}
      {view.review.length > 0 && (
        <section aria-labelledby="needs-review">
          <Card tone="brand">
            <h2 id="needs-review" className="flex items-center gap-2 text-base font-semibold"><PlayCircle className="size-4 text-brand" aria-hidden /> Needs your review ({view.review.length})</h2>
            <p className="mt-0.5 text-xs text-muted">Watch each one, pause where you&rsquo;d change something and leave a note — or approve it.</p>
            <ul className="mt-2 divide-y divide-border">
              {view.review.map((v) => <VideoRowV2 key={v.id} v={v} to={q({ v: v.id })} deadline={d.deadlines[v.id] ?? null} previous={v.section === "PREVIOUS"} />)}
            </ul>
          </Card>
        </section>
      )}

      {/* 2. By month. */}
      {[...months.entries()].map(([monthKey, rows]) => (
        <section key={monthKey || "none"} aria-label={monthKey ? monthLabel(monthKey) : "Videos"}>
          <Card>
            <h2 className="text-base font-semibold">{monthKey ? monthLabel(monthKey) : "Videos"}</h2>
            <ul className="mt-2 divide-y divide-border">
              {rows.map((v) => <VideoRowV2 key={v.id} v={v} to={q({ v: v.id })} previous={false} />)}
            </ul>
          </Card>
        </section>
      ))}

      {/* 3. Previous content — older backfill, dated by delivery (CP-12). */}
      {previous.length > 0 && (
        <section aria-labelledby="previous-content">
          <Card>
            <h2 id="previous-content" className="inline-flex items-center gap-1.5 text-base font-semibold"><Archive className="size-4 text-muted-2" aria-hidden /> Previous content</h2>
            <p className="mt-0.5 text-xs text-muted">Videos we made for you before your program moved onto this page. They&rsquo;re yours to watch and download as always; the dates shown are when each one was delivered.</p>
            <ul className="mt-2 divide-y divide-border">
              {previous.map((v) => <VideoRowV2 key={v.id} v={v} to={q({ v: v.id })} previous />)}
            </ul>
          </Card>
        </section>
      )}

      {view.pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-2 text-xs">
          {view.page > 1 ? <Link href={q({ q: view.q, st: view.st, page: view.page - 1 })} className={cn("inline-flex min-h-11 items-center gap-1 rounded-lg border border-border px-3 font-semibold", focus)}><ChevronLeft className="size-3.5" aria-hidden /> Newer</Link> : <span />}
          <span className="text-muted-2">Page {view.page} of {view.pages}</span>
          {view.page < view.pages ? <Link href={q({ q: view.q, st: view.st, page: view.page + 1 })} className={cn("inline-flex min-h-11 items-center gap-1 rounded-lg border border-border px-3 font-semibold", focus)}>Older <ChevronRight className="size-3.5" aria-hidden /></Link> : <span />}
        </nav>
      )}
      {d.incomplete && <p className="text-center text-[11px] text-muted-2">Showing your most recent videos. Search to find an older one.</p>}
    </div>
  );
}

/**
 * One video, v2: what it is, the player and its review (CutReview carries the
 * deadline, the notes and the decision), THEN — once the release rule says the
 * file is theirs — download and captions. Script and transcript fold away.
 * The server still refuses a download or caption the rule does not allow
 * (CP-01); hiding the panel before then only keeps the page honest.
 */
export function VideoDetailV2({ d, href }: { d: VideoDetailData; href: Href }) {
  const hasCut = d.versions.some((v) => v.isCurrent && v.assetUrl);
  const released = !!d.kit && (d.kit.access.download || d.kit.access.captions);
  return (
    <div className="mt-6 space-y-4">
      <Link href={href("videos")} className={cn("inline-flex min-h-11 items-center gap-1 text-xs font-medium text-muted hover:text-foreground", focus)}><ArrowLeft className="size-3.5" aria-hidden /> Content Library</Link>
      <div>
        <h1 className="break-words text-xl font-semibold tracking-tight">{d.video.title}</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StatusChip word={VIDEO_WORDS[d.video.state]} />
          {d.video.kind !== "PROGRAM" && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-muted">{d.video.kind === "LISTING" ? "Listing video — not part of your monthly program" : d.video.kind === "EXTRA" ? "Extra" : d.video.kind.toLowerCase()}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-2">
          {d.video.pillarName && <span>Pillar: {d.video.pillarName}</span>}
          {d.video.section === "PREVIOUS" ? <span>Previous content</span> : d.video.monthKey && <span>{monthLabel(d.video.monthKey)}</span>}
          {d.video.section !== "PREVIOUS" && d.video.filmedAtISO && <span className="inline-flex items-center gap-1"><Camera className="size-3" aria-hidden /> Filmed {fmtShort(d.video.filmedAtISO)}</span>}
          {d.video.deliveredAtISO && <span>Delivered {fmtShort(d.video.deliveredAtISO)}</span>}
        </div>
      </div>

      {/* Player + review: deadline, notes at the moment, approve or send changes. */}
      <Card tone={d.video.state === "FOR_REVIEW" ? "brand" : "default"}>
        <CardTitle icon={PlayCircle}>{hasCut ? "Watch & review" : "Watch"}</CardTitle>
        {d.versionsFailed ? (
          <div className="mt-2"><LoadFailed what="this video's versions" /></div>
        ) : hasCut ? (
          <div className="mt-2">
            {d.perms.request && !d.readOnly && d.video.state === "FOR_REVIEW" && <p className="mb-2 text-xs text-muted-2">Pause where you&rsquo;d change something and save a note; send them all as one change request — or approve this version.</p>}
            <CutReview versions={d.versions} perms={{ comment: d.perms.comment, request: d.perms.request, approve: d.perms.approve }} readOnly={d.readOnly} poster={d.delivered?.thumb ?? null} signInHref={d.signInHref} />
          </div>
        ) : d.delivered ? (
          <div className="mt-2"><PortalPlayer src={d.delivered.playback} poster={d.delivered.thumb} /></div>
        ) : (
          <p className="mt-2 text-sm text-muted">Nothing to watch yet — the first cut appears here after filming and editing.</p>
        )}
      </Card>

      {/* After approval: the file and the words to post it with. */}
      {d.kitFailed ? (
        <LoadFailed what="the download and captions" />
      ) : released && d.kit ? (
        <Card>
          <CardTitle icon={Download}>Download &amp; caption</CardTitle>
          <div className="mt-2">
            <PostingKitPanel
              videoId={d.video.id} title={d.video.title} downloadHref={d.kit.access.download ? d.downloadHref : null} download={d.kit.download} access={d.kit.access} finalLabel={d.kit.final?.label ?? null} finalNote={d.kit.finalNote}
              captions={d.kit.captions} assistant={d.kit.assistant} postedAtISO={d.kit.postedAtISO} downloadStartedAtISO={d.kit.downloadStartedAtISO} downloadCompletedAtISO={d.kit.downloadCompletedAtISO}
              canEdit={d.perms.suggest && !d.readOnly} transcriptGap={d.kit.transcript.gap}
            />
            {d.kit.final?.approvedByLabel && <p className="mt-2 text-[11px] text-muted-2">Version {d.kit.final.label} was approved by {d.kit.final.approvedByLabel}{d.kit.final.approvedAtISO ? ` on ${fmtShort(d.kit.final.approvedAtISO)}` : ""}.</p>}
            {d.kit.cover && (
              <div className="mt-3">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Cover</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={d.kit.cover} alt="Cover frame" className="mt-1.5 max-h-40 max-w-full rounded-lg border border-border" />
              </div>
            )}
          </div>
        </Card>
      ) : (
        <div className="flex items-start gap-2 rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Download and captions open once this version is approved.{d.kit?.access.why ? ` ${d.kit.access.why}` : ""}</span>
        </div>
      )}

      {/* Script & transcript — folded: reference, not the task. */}
      {!d.kitFailed && (d.kit?.script || d.kit?.transcript.text) && (
        <Card>
          <CardTitle icon={FileText}>Script &amp; transcript</CardTitle>
          <div className="mt-2 space-y-2">
            {d.kit?.script && (
              <details className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
                <summary className={cn("cursor-pointer text-sm font-bold", focus)}>{d.kit.script.title} <span className="ml-1 text-[11px] font-normal text-muted-2">{d.kit.script.historical ? "from your script history" : d.kit.script.versionLabel ? `script ${d.kit.script.versionLabel}` : "script"}</span></summary>
                {d.kit.script.historical && <p className="mt-2 text-xs text-muted">This is an earlier script we have on file for this topic — kept as history, not the script this video was made from.</p>}
                <ScriptView body={d.kit.script.body} fileTitle={d.kit.script.title} />
              </details>
            )}
            {d.kit?.transcript.text && (
              <details className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
                <summary className={cn("cursor-pointer text-sm font-bold", focus)}>Transcript of the final cut <span className="ml-1 text-[11px] font-normal text-muted-2">{d.kit.transcript.source === "corrected" ? "checked by us" : "automatic"}</span></summary>
                <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85">{d.kit.transcript.text}</p>
              </details>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

