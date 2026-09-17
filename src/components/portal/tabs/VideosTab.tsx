import Link from "next/link";
import { ArrowLeft, Camera, ChevronLeft, ChevronRight, Clapperboard, FileText, Film, PlayCircle, Tag } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { VideoListPage, VideoListRow, ClientVideoState } from "@/lib/contentVideos";
import type { CutVersion } from "@/lib/clientDecisions";
import type { PostingKit } from "@/lib/postingKit";
import { Card, CardTitle, Empty, LoadFailed, fmtShort } from "@/components/portal/ui";
import { CutReview } from "@/components/portal/CutReview";
import { PostingKitPanel } from "@/components/portal/PostingKitPanel";
import { PortalPlayer } from "@/components/portal/PortalPlayer";
import { ScriptBody } from "@/components/portal/ScriptBody";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// MY VIDEOS (spec §7): a scrollable list grouped by the program month each
// video FULFILS, newest first, with year navigation and pagination — every
// video the client was ever given is reachable. Rows show a thumbnail, title,
// state and one action; filmed and delivered dates are shown separately; a
// listing video says so and never counts as program allowance. The player
// only mounts on the detail view.
// ---------------------------------------------------------------------------

const STATE: Record<ClientVideoState, { label: string; cls: string; action: string }> = {
  FOR_REVIEW: { label: "For your review", cls: "bg-brand-soft text-brand", action: "Review" },
  CHANGES_IN_PROGRESS: { label: "Changes in progress", cls: "bg-warning-soft text-warning", action: "Open" },
  APPROVED: { label: "Approved by you", cls: "bg-success-soft text-success", action: "Open" },
  DELIVERED: { label: "Delivered", cls: "bg-success-soft text-success", action: "Open" },
  IN_PRODUCTION: { label: "In production", cls: "bg-surface-2 text-muted", action: "Details" },
};

export function VideosList({ page, failed, href }: { page: VideoListPage | null; failed: boolean; href: (tab: string, extra?: string) => string }) {
  if (failed) return <div className="mt-6"><LoadFailed what="your video library" /></div>;
  if (!page) return null;
  const groups = new Map<string, VideoListRow[]>();
  for (const r of page.rows) { const k = r.monthKey ?? "unknown"; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const q = (extra: string) => href("videos", extra);
  return (
    <div className="mt-6 space-y-4">
      {/* Year navigation + count */}
      {(page.years.length > 1 || page.pages > 1) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-2">{page.total} video{page.total === 1 ? "" : "s"}</span>
          <span className="mx-1 text-muted-2">·</span>
          <Link href={q("")} className={cn("rounded-full border px-2.5 py-1 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", !page.year ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted")}>All years</Link>
          {page.years.map((y) => (
            <Link key={y} href={q(`year=${y}`)} className={cn("rounded-full border px-2.5 py-1 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", page.year === y ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted")}>{y}</Link>
          ))}
        </div>
      )}
      {page.rows.length === 0 ? (
        <Empty icon={Clapperboard}>No videos yet. They land here as each session is delivered — <Link href={href("schedule")} className="font-medium text-brand hover:underline">book your session</Link> to get the first one moving.</Empty>
      ) : (
        [...groups.entries()].map(([monthKey, rows]) => (
          <Card key={monthKey}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-base font-semibold">{monthKey === "unknown" ? "Undated" : monthLabel(monthKey)}</span>
              <span className="text-xs text-muted-2">{rows.filter((r) => r.countsTowardAllowance).length} program video{rows.filter((r) => r.countsTowardAllowance).length === 1 ? "" : "s"}{rows.some((r) => !r.countsTowardAllowance) ? ` · ${rows.filter((r) => !r.countsTowardAllowance).length} other` : ""}</span>
            </div>
            <ul className="mt-3 divide-y divide-border">
              {rows.map((v) => {
                const st = STATE[v.state];
                return (
                  <li key={v.id}>
                    <Link href={q(`v=${v.id}`)} className="flex items-center gap-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
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
                          {v.filmedAtISO && <span>Filmed {fmtShort(v.filmedAtISO)}</span>}
                          {v.deliveredAtISO && <span>Delivered {fmtShort(v.deliveredAtISO)}</span>}
                          {v.pillarName && <span>{v.pillarName}</span>}
                          {v.format && <span>{v.format.replace(/_/g, " ")}</span>}
                        </div>
                      </div>
                      <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold", v.needsDecision ? "bg-brand text-white" : "border border-border text-muted")}>{st.action} <ChevronRight className="size-3.5" /></span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}
      {page.pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between text-xs">
          {page.page > 1 ? <Link href={q(`${page.year ? `year=${page.year}&` : ""}page=${page.page - 1}`)} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><ChevronLeft className="size-3.5" /> Newer</Link> : <span />}
          <span className="text-muted-2">Page {page.page} of {page.pages}</span>
          {page.page < page.pages ? <Link href={q(`${page.year ? `year=${page.year}&` : ""}page=${page.page + 1}`)} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Older <ChevronRight className="size-3.5" /></Link> : <span />}
        </nav>
      )}
    </div>
  );
}

export type VideoDetailData = {
  video: { id: string; title: string; monthKey: string | null; kind: string; state: ClientVideoState; filmedAtISO: string | null; deliveredAtISO: string | null; pillarName: string | null; format: string | null };
  versions: CutVersion[];
  versionsFailed: boolean;
  kit: PostingKit | null;
  kitFailed: boolean;
  /** The delivered (Aryeo) playable file with its media-safe URL, when the video has no hub cut. */
  delivered: { playback: string; thumb: string | null } | null;
  downloadHref: string | null;
  perms: { comment: boolean; request: boolean; approve: boolean; suggest: boolean };
  readOnly: boolean;
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
          {d.video.monthKey && <span>{monthLabel(d.video.monthKey)}</span>}
          {d.video.filmedAtISO && <span className="inline-flex items-center gap-1"><Camera className="size-3" /> Filmed {fmtShort(d.video.filmedAtISO)}</span>}
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
            <CutReview versions={d.versions} perms={{ comment: d.perms.comment, request: d.perms.request, approve: d.perms.approve }} readOnly={d.readOnly} poster={d.delivered?.thumb ?? null} />
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
              videoId={d.video.id} downloadHref={d.kit.final?.hashOk ? d.downloadHref : null} finalLabel={d.kit.final?.label ?? null} finalNote={d.kit.finalNote}
              captions={d.kit.captions} assistant={d.kit.assistant} postedAtISO={d.kit.postedAtISO} downloadedAtISO={d.kit.downloadedAtISO}
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
                <ScriptBody body={d.kit.script.body} />
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
