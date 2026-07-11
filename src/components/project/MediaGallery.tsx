"use client";

import { useState, useEffect, useMemo, useRef, useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Images, Video as VideoIcon, Map as MapIcon, Download, X, ChevronLeft, ChevronRight, Play, DownloadCloud,
  Flag, Check, Loader2, MessageSquarePlus, Pencil, Camera,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ListingMedia, MediaImage, MediaVideo, MediaFloorPlan } from "@/lib/integrations/aryeo";
import { flagImages, resolveImageFlag, resolveAllImageFlags, type FlaggedImage } from "@/app/projects/flagActions";
import { IMAGE_FLAG_TAGS } from "@/lib/imageFlags";
import { addMediaNote, replyMediaNote, setMediaNoteStatus, setMediaVerdict } from "@/app/projects/reviewActions";
import { ReviewBar } from "@/components/review/ReviewBar";
import { ImageReview } from "@/components/review/ImageReview";
import { VideoReview } from "@/components/review/VideoReview";
import type { ReviewData, ReviewNote, ReviewVerdict } from "@/components/review/types";

export type ImageFlagView = FlaggedImage;

type Tab = "photos" | "videos" | "floorPlans" | "flags";

function dl(url: string, name: string): string {
  return `/api/media/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;
}
function fmtDuration(s: number | null): string {
  if (!s) return "";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// Canonical identity of a video for notes/verdicts: the same source order the
// player + download button use, falling back to the thumb so even a source-less
// video can still carry (un-timestamped) notes.
function videoAssetUrl(v: MediaVideo): string | null {
  return v.download ?? v.playback ?? v.thumb ?? null;
}

export function MediaGallery({ media, slug, projectId, flags = [], review }: { media: ListingMedia; slug: string; projectId?: string; flags?: FlaggedImage[]; review?: ReviewData }) {
  const router = useRouter();
  // Live list of open flags — grows when you flag a photo in the lightbox,
  // shrinks when you mark one fixed in the Flags tab.
  const [flagList, setFlagList] = useState<FlaggedImage[]>(flags);
  const flaggedSet = new Set(flagList.map((f) => f.imageUrl));
  const [busy, startBusy] = useTransition();

  // --- Review room (owner/admin only — `review` is undefined for creatives).
  // Notes/verdicts live in local state as a zero-latency preview; every server
  // action revalidates the page, and the effect below reconciles with the
  // authoritative payload when it streams back in.
  const reviewable = Boolean(review?.enabled && projectId);
  const [reviewOn, setReviewOn] = useState(false);
  const [rNotes, setRNotes] = useState<ReviewNote[]>(review?.notes ?? []);
  const [rVerdicts, setRVerdicts] = useState<Record<string, ReviewVerdict>>(review?.verdicts ?? {});
  useEffect(() => {
    if (review) {
      setRNotes(review.notes);
      setRVerdicts(review.verdicts);
    }
  }, [review]);

  const noteCountByAsset = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of rNotes) m.set(n.assetUrl, (m.get(n.assetUrl) ?? 0) + 1);
    return m;
  }, [rNotes]);
  const editOpenCount = rNotes.filter((n) => n.lane === "EDIT" && n.status === "OPEN").length;
  const photogOpenCount = rNotes.filter((n) => n.lane === "PHOTOGRAPHER" && n.status === "OPEN").length;
  const fixedCount = rNotes.filter((n) => n.status === "FIXED").length;
  const notesFor = (url: string | null) => (url ? rNotes.filter((n) => n.assetUrl === url) : []);

  async function reviewAdd(input: {
    assetUrl: string;
    thumbUrl?: string | null;
    assetType: "image" | "video";
    x?: number | null;
    y?: number | null;
    timeSec?: number | null;
    lane: "EDIT" | "PHOTOGRAPHER";
    kind: "fix" | "coaching";
    body: string;
  }): Promise<{ ok: boolean; message?: string }> {
    if (!projectId) return { ok: false, message: "No project to note against." };
    const r = await addMediaNote({ projectId, ...input });
    if (r.ok && r.id) {
      const note: ReviewNote = {
        id: r.id,
        assetUrl: input.assetUrl,
        thumbUrl: input.thumbUrl ?? null,
        assetType: input.assetType,
        x: input.x ?? null,
        y: input.y ?? null,
        timeSec: input.timeSec ?? null,
        lane: input.lane,
        kind: input.lane === "EDIT" ? "fix" : input.kind, // mirror the server's coercion
        body: input.body,
        status: "OPEN",
        authorName: "You",
        createdAt: new Date().toISOString(),
        replies: [],
      };
      setRNotes((xs) => [note, ...xs]);
      router.refresh();
    }
    return { ok: r.ok, message: r.message };
  }

  async function reviewReply(noteId: string, body: string): Promise<{ ok: boolean; message?: string }> {
    const r = await replyMediaNote(noteId, body);
    if (r.ok) {
      setRNotes((xs) =>
        xs.map((n) =>
          n.id === noteId
            ? { ...n, replies: [...n.replies, { id: `optimistic-${Date.now()}`, body, authorName: "You", createdAt: new Date().toISOString() }] }
            : n,
        ),
      );
      router.refresh();
    }
    return r;
  }

  async function reviewStatus(noteId: string, status: "OPEN" | "FIXED" | "RESOLVED"): Promise<{ ok: boolean; message?: string }> {
    const r = await setMediaNoteStatus(noteId, status);
    if (r.ok) {
      setRNotes((xs) => xs.map((n) => (n.id === noteId ? { ...n, status } : n)));
      router.refresh();
    }
    return r;
  }

  // Verdicts toggle: tapping the active verdict clears it back to unreviewed.
  // Optimistic flip first, revert on failure.
  function toggleVerdict(assetUrl: string, v: ReviewVerdict) {
    if (!projectId) return;
    const next = rVerdicts[assetUrl] === v ? null : v;
    const before = rVerdicts;
    setRVerdicts((s) => {
      const n = { ...s };
      if (next) n[assetUrl] = next;
      else delete n[assetUrl];
      return n;
    });
    startBusy(async () => {
      const r = await setMediaVerdict(projectId, assetUrl, next);
      if (!r.ok) setRVerdicts(before);
      else router.refresh();
    });
  }

  // Per-photo flagging state inside the lightbox.
  const [lbPanel, setLbPanel] = useState(false);
  const [lbTags, setLbTags] = useState<Set<string>>(new Set());
  const [lbNote, setLbNote] = useState("");
  const [lbMsg, setLbMsg] = useState<string | null>(null);
  const toggleTag = (t: string) =>
    setLbTags((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });

  const mediaTabs = ([
    { key: "photos", label: "Photos", icon: Images, count: media.images.length },
    { key: "videos", label: "Video", icon: VideoIcon, count: media.videos.length },
    { key: "floorPlans", label: "Floor Plans", icon: MapIcon, count: media.floorPlans.length },
  ] as { key: Tab; label: string; icon: typeof Images; count: number }[]).filter((t) => t.count > 0);
  const tabs: typeof mediaTabs = projectId && flagList.length > 0
    ? [...mediaTabs, { key: "flags", label: "Flags", icon: Flag, count: flagList.length }]
    : mediaTabs;

  const [tab, setTab] = useState<Tab>(mediaTabs[0]?.key ?? "photos");
  const [idx, setIdx] = useState<number | null>(null);
  const [open, setOpen] = useState(true);
  const [zoom, setZoom] = useState<string | null>(null); // simple full-screen view for a flagged image
  const sectionRef = useRef<HTMLElement>(null);

  // Deep link: arriving at /projects/<id>#flags (e.g. from an "image fixes" task's
  // "Open →") opens the Flags tab and scrolls the gallery into view.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === "#flags" && projectId && flags.length > 0) {
      setOpen(true);
      setTab("flags");
      requestAnimationFrame(() =>
        sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the Flags tab empties (all marked fixed), fall back to a media tab.
  useEffect(() => {
    if (tab === "flags" && flagList.length === 0) setTab(mediaTabs[0]?.key ?? "photos");
  }, [tab, flagList.length, mediaTabs]);

  const NOUN: Record<string, [string, string]> = {
    photos: ["photo", "photos"],
    videos: ["video", "videos"],
    floorPlans: ["floor plan", "floor plans"],
  };
  const summary = mediaTabs.map((t) => `${t.count} ${NOUN[t.key][t.count === 1 ? 0 : 1]}`).join(" · ");

  const images = tab === "photos" ? media.images : tab === "floorPlans" ? media.floorPlans : [];
  const isImageTab = tab === "photos" || tab === "floorPlans";
  const count = tab === "videos" ? media.videos.length : images.length;

  const close = useCallback(() => setIdx(null), []);
  const prev = useCallback(() => setIdx((i) => (i == null ? i : (i - 1 + count) % count)), [count]);
  const next = useCallback(() => setIdx((i) => (i == null ? i : (i + 1) % count)), [count]);

  // Reset the per-photo flag panel whenever the lightbox photo changes.
  useEffect(() => {
    setLbPanel(false); setLbTags(new Set()); setLbNote(""); setLbMsg(null);
  }, [idx]);

  useEffect(() => {
    if (idx == null) return;
    const onKey = (e: KeyboardEvent) => {
      // Don't steal keys while typing a note/flag/reply — arrow keys inside a
      // textarea would otherwise flip to the next photo mid-sentence.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [idx, close, prev, next]);

  async function downloadAll() {
    const items = (tab === "photos" ? media.images : media.floorPlans) as (MediaImage | MediaFloorPlan)[];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = ("filename" in it && it.filename) || `${slug}-${tab}-${i + 1}.jpg`;
      const a = document.createElement("a");
      a.href = dl(it.original, name);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  // Download one flagged image at full/print resolution (the stored imageUrl is
  // the Aryeo original, not a thumbnail).
  function downloadFlag(f: FlaggedImage, i: number) {
    const name = `${slug}-flagged-${i + 1}.jpg`;
    const a = document.createElement("a");
    a.href = dl(f.imageUrl, name);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Download every flagged image (full size) so Kyle can fix them.
  async function downloadAllFlags() {
    for (let i = 0; i < flagList.length; i++) {
      downloadFlag(flagList[i], i);
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  // Flag the photo currently open in the lightbox.
  function submitLbFlag() {
    if (!projectId || idx == null || !isImageTab) return;
    const it = images[idx] as MediaImage | MediaFloorPlan;
    const caption = ("caption" in it && it.caption) || null;
    startBusy(async () => {
      const r = await flagImages(projectId, [{ url: it.original, thumb: it.thumb, caption }], lbNote, [...lbTags]);
      setLbMsg(r.message);
      if (r.ok && r.created) {
        setFlagList((xs) => [...r.created!, ...xs]);
        setLbTags(new Set()); setLbNote(""); setLbPanel(false);
      }
    });
  }

  const resolveOne = (id: string) =>
    startBusy(async () => { await resolveImageFlag(id); setFlagList((xs) => xs.filter((x) => x.id !== id)); });
  const resolveAll = () => {
    if (!projectId) return;
    startBusy(async () => { await resolveAllImageFlags(projectId); setFlagList([]); });
  };

  if (mediaTabs.length === 0) return null;

  const currentFlagged = idx != null && isImageTab && flaggedSet.has((images[idx] as MediaImage | MediaFloorPlan).original);

  // Canonical URL of the asset open in the lightbox — verdicts + notes key off it.
  const lbAssetUrl =
    idx == null
      ? null
      : tab === "videos"
        ? media.videos[idx] ? videoAssetUrl(media.videos[idx]) : null
        : isImageTab && images[idx] ? (images[idx] as MediaImage | MediaFloorPlan).original : null;
  const lbVerdict = lbAssetUrl ? rVerdicts[lbAssetUrl] : undefined;

  return (
    <section ref={sectionRef} id="flags" className="overflow-hidden rounded-2xl border bg-surface scroll-mt-20">
      {/* Header toggle + tabs + actions */}
      <div className={cn("flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5", open && "border-b border-border")}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5"
          aria-expanded={open}
        >
          <ChevronRight className={cn("size-4 text-muted transition-transform", open && "rotate-90")} />
          <span className="text-sm font-semibold">Media</span>
        </button>
        {!open && <span className="text-xs text-muted">{summary}</span>}
        {open && (
        <>
        <div className="flex items-center gap-1">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            const isFlags = t.key === "flags";
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? isFlags ? "bg-warning/15 text-warning ring-1 ring-inset ring-warning/30" : "bg-brand-soft text-brand ring-1 ring-inset ring-brand/20"
                    : "text-muted hover:bg-surface-2 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" /> {t.label}
                <span className={cn("rounded-full px-1.5 text-[10px]", active ? (isFlags ? "bg-warning/20" : "bg-brand/15") : "bg-surface-2")}>{t.count}</span>
              </button>
            );
          })}
        </div>
        {(reviewable || (isImageTab && count > 0)) && (
          <div className="ml-auto flex items-center gap-1.5">
            {reviewable && (
              <button
                onClick={() => setReviewOn((v) => !v)}
                aria-pressed={reviewOn}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                  reviewOn ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2 hover:text-foreground",
                )}
              >
                <MessageSquarePlus className="size-3.5" /> Review
              </button>
            )}
            {isImageTab && count > 0 && (
              <button
                onClick={downloadAll}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2"
              >
                <DownloadCloud className="size-3.5" /> Download all
              </button>
            )}
          </div>
        )}
        </>
        )}
      </div>

      {open && (
      <div className="p-4 sm:p-5">
        {/* Review rollup — shown once the room is in use (or armed) so the owner
            always sees where the round stands before sending it to a lane. */}
        {reviewable && projectId && (reviewOn || rNotes.length > 0) && (
          <ReviewBar projectId={projectId} editOpen={editOpenCount} photogOpen={photogOpenCount} fixed={fixedCount} />
        )}
        {isImageTab && (
          <>
            <p className="mb-3 text-xs text-muted">
              {reviewOn
                ? "Review mode — open a photo, then tap anywhere on it to drop a pin-point note."
                : "Tap a photo to open it full screen — flag it for fixes from there."}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {(images as (MediaImage | MediaFloorPlan)[]).map((img, i) => {
                const caption = ("caption" in img && img.caption) || null;
                const alreadyFlagged = flaggedSet.has(img.original);
                const verdict = reviewable ? rVerdicts[img.original] : undefined;
                const nNotes = reviewable ? (noteCountByAsset.get(img.original) ?? 0) : 0;
                return (
                  <button
                    key={i}
                    onClick={() => setIdx(i)}
                    className="group relative overflow-hidden rounded-xl border border-border bg-surface-2"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.thumb}
                      alt={caption || `${tab} ${i + 1}`}
                      loading="lazy"
                      className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                    <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                    {alreadyFlagged && (
                      <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-warning px-1 py-0.5 text-[10px] font-semibold text-white"><Flag className="size-2.5" /> flagged</span>
                    )}
                    {verdict && (
                      <span className={cn(
                        "absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold text-white",
                        verdict === "APPROVED" ? "bg-success" : "bg-brand",
                      )}>
                        {verdict === "APPROVED" ? <Check className="size-2.5" /> : <Pencil className="size-2.5" />}
                        {verdict === "APPROVED" ? "approved" : "needs work"}
                      </span>
                    )}
                    {nNotes > 0 && (
                      <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        <MessageSquarePlus className="size-2.5" /> {nNotes}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Flags tab — each flagged photo is its own group */}
        {tab === "flags" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">{flagList.length} photo{flagList.length === 1 ? "" : "s"} flagged for fixes — rolled into one 24-hour task for Kyle.</p>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={downloadAllFlags}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2"
                >
                  <DownloadCloud className="size-3.5" /> Download all (full size)
                </button>
                <button onClick={resolveAll} disabled={busy} className="inline-flex items-center gap-1 px-1 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50">
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Mark all fixed
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {flagList.map((f, i) => (
                <div key={f.id} className="flex gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3">
                  {f.thumbUrl && (
                    <button onClick={() => setZoom(f.imageUrl)} className="shrink-0 overflow-hidden rounded-lg">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={f.thumbUrl} alt="flagged" className="size-24 object-cover transition-transform hover:scale-105" />
                    </button>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex flex-wrap gap-1">
                      {f.tags.map((t) => (
                        <span key={t} className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning">{t}</span>
                      ))}
                    </div>
                    {f.note && <p className="mt-1 break-words text-sm text-foreground/90">{f.note}</p>}
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
                      <button
                        onClick={() => downloadFlag(f, i)}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        <Download className="size-3.5" /> Download
                      </button>
                      <button
                        onClick={() => resolveOne(f.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50"
                      >
                        <Check className="size-3.5" /> Mark fixed
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Video grid */}
        {tab === "videos" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {media.videos.map((v, i) => {
              const vUrl = reviewable ? videoAssetUrl(v) : null;
              const vVerdict = vUrl ? rVerdicts[vUrl] : undefined;
              const vNotes = vUrl ? (noteCountByAsset.get(vUrl) ?? 0) : 0;
              return (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className="group relative overflow-hidden rounded-xl border border-border bg-surface-2 text-left"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {v.thumb ? (
                  <img src={v.thumb} alt={v.title ?? `Video ${i + 1}`} loading="lazy" className="aspect-video w-full object-cover" />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center"><VideoIcon className="size-8 text-muted-2" /></div>
                )}
                {vVerdict && (
                  <span className={cn(
                    "absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold text-white",
                    vVerdict === "APPROVED" ? "bg-success" : "bg-brand",
                  )}>
                    {vVerdict === "APPROVED" ? <Check className="size-2.5" /> : <Pencil className="size-2.5" />}
                    {vVerdict === "APPROVED" ? "approved" : "needs work"}
                  </span>
                )}
                {vNotes > 0 && (
                  <span className="absolute right-1.5 top-1.5 z-10 inline-flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    <MessageSquarePlus className="size-2.5" /> {vNotes}
                  </span>
                )}
                <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/35">
                  <span className="flex size-12 items-center justify-center rounded-full bg-white/90 text-black shadow-lg">
                    <Play className="size-5 translate-x-0.5 fill-black" />
                  </span>
                </span>
                <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 py-2 text-xs text-white">
                  <span className="truncate font-medium">{v.title ?? `Video ${i + 1}`}</span>
                  {v.duration ? <span className="shrink-0 tabular-nums">{fmtDuration(v.duration)}</span> : null}
                </span>
              </button>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* Simple full-screen view for a flagged image */}
      {zoom && (
        <div className="fixed inset-0 z-[1450] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm" onClick={() => setZoom(null)}>
          <button aria-label="Close" className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-lg text-white hover:bg-white/10"><X className="size-5" /></button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="flagged" className="max-h-full max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {/* Lightbox */}
      {idx != null && (
        <div className="fixed inset-0 z-[1450] flex flex-col bg-black/90 backdrop-blur-sm" onClick={close}>
          {/* Top bar */}
          <div className="flex items-center justify-between gap-2 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
            <span className="text-sm text-white/70">{idx + 1} / {count}</span>
            <div className="flex items-center gap-2">
              {/* Review mode swaps the legacy Flag affordance for verdict chips
                  (pins carry the detail; the verdict is the quick thumbs call). */}
              {reviewable && reviewOn && lbAssetUrl && (
                <>
                  <button
                    onClick={() => toggleVerdict(lbAssetUrl, "APPROVED")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium",
                      lbVerdict === "APPROVED" ? "bg-success text-white" : "bg-white/10 text-white hover:bg-white/20",
                    )}
                  >
                    <Check className="size-4" /> {lbVerdict === "APPROVED" ? "Approved" : "Approve"}
                  </button>
                  <button
                    onClick={() => toggleVerdict(lbAssetUrl, "NEEDS_WORK")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium",
                      lbVerdict === "NEEDS_WORK" ? "bg-brand text-white" : "bg-white/10 text-white hover:bg-white/20",
                    )}
                  >
                    <Pencil className="size-4" /> Needs work
                  </button>
                </>
              )}
              {projectId && isImageTab && !reviewOn && (
                <button
                  onClick={() => { setLbPanel((v) => !v); setLbMsg(null); }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium",
                    lbPanel ? "bg-warning text-white" : currentFlagged ? "bg-warning/25 text-warning ring-1 ring-warning/40" : "bg-white/10 text-white hover:bg-white/20",
                  )}
                >
                  <Flag className="size-4" /> {currentFlagged ? "Flagged" : "Flag"}
                </button>
              )}
              <DownloadButton tab={tab} idx={idx} media={media} slug={slug} />
              <button onClick={close} aria-label="Close" className="flex size-9 items-center justify-center rounded-lg hover:bg-white/10">
                <X className="size-5" />
              </button>
            </div>
          </div>

          {/* Stage */}
          <div className="relative flex flex-1 items-center justify-center overflow-hidden px-2 pb-4 sm:px-12" onClick={(e) => e.stopPropagation()}>
            {count > 1 && (
              <button onClick={prev} aria-label="Previous" className="absolute left-2 z-10 flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 sm:left-4">
                <ChevronLeft className="size-6" />
              </button>
            )}

            {tab === "videos" ? (
              reviewable && reviewOn ? (
                <VideoReview
                  key={idx} // reset composer/thread state per video
                  video={media.videos[idx]}
                  notes={notesFor(videoAssetUrl(media.videos[idx]))}
                  onAdd={(body, lane, kind, timeSec) => {
                    const v = media.videos[idx];
                    const url = videoAssetUrl(v);
                    if (!url) return Promise.resolve({ ok: false, message: "No video source to note against." });
                    return reviewAdd({ assetUrl: url, thumbUrl: v.thumb, assetType: "video", timeSec, lane, kind, body });
                  }}
                  onReply={reviewReply}
                  onSetStatus={reviewStatus}
                />
              ) : (
                <VideoPlayer video={media.videos[idx]} />
              )
            ) : reviewable && reviewOn ? (
              <ImageReview
                key={idx} // reset pins-in-progress per photo
                src={(images[idx] as MediaImage | MediaFloorPlan).large}
                alt={("caption" in images[idx] && (images[idx] as MediaImage).caption) || ""}
                notes={notesFor((images[idx] as MediaImage | MediaFloorPlan).original)}
                onAdd={(body, lane, kind, x, y) => {
                  const it = images[idx] as MediaImage | MediaFloorPlan;
                  return reviewAdd({ assetUrl: it.original, thumbUrl: it.thumb, assetType: "image", x, y, lane, kind, body });
                }}
                onReply={reviewReply}
                onSetStatus={reviewStatus}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={(images[idx] as MediaImage | MediaFloorPlan).large}
                alt={("caption" in images[idx] && (images[idx] as MediaImage).caption) || ""}
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            )}

            {count > 1 && (
              <button onClick={next} aria-label="Next" className="absolute right-2 z-10 flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 sm:right-4">
                <ChevronRight className="size-6" />
              </button>
            )}

            {/* Per-photo flag panel */}
            {lbPanel && projectId && isImageTab && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute inset-x-2 bottom-3 mx-auto max-w-lg rounded-2xl border border-warning/40 bg-surface p-4 shadow-2xl sm:inset-x-auto sm:right-4 sm:w-96"
              >
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-warning">
                  <Flag className="size-3.5" /> Flag photo {idx + 1} for fixes
                </div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {IMAGE_FLAG_TAGS.map((t) => (
                    <button
                      key={t}
                      onClick={() => toggleTag(t)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium",
                        lbTags.has(t) ? "border-warning bg-warning text-white" : "border-border bg-surface hover:bg-surface-2",
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <textarea
                  value={lbNote}
                  onChange={(e) => setLbNote(e.target.value)}
                  rows={2}
                  placeholder="Note for Kyle — what needs fixing on this photo…"
                  className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-warning"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={submitLbFlag}
                    disabled={busy || (lbTags.size === 0 && !lbNote.trim())}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-warning px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Flag className="size-3.5" />} Flag for Kyle (24h)
                  </button>
                  {lbMsg && <span className="text-xs text-muted">{lbMsg}</span>}
                </div>
                {/* A flag is "Kyle fixes the file"; a capture problem belongs to
                    whoever shot it — hop straight into Review mode where pins
                    carry the photographer/coaching lanes. */}
                {reviewable && (
                  <button
                    onClick={() => { setLbPanel(false); setReviewOn(true); }}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 hover:underline light:text-sky-600"
                  >
                    <Camera className="size-3.5" /> Capture issue? Pin it for the photographer instead
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Caption */}
          {isImageTab && "caption" in images[idx] && (images[idx] as MediaImage).caption && (
            <div className="px-4 pb-4 text-center text-sm text-white/70" onClick={(e) => e.stopPropagation()}>
              {(images[idx] as MediaImage).caption}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DownloadButton({ tab, idx, media, slug }: { tab: Tab; idx: number; media: ListingMedia; slug: string }) {
  let url: string | null = null;
  let name = `${slug}-${tab}-${idx + 1}`;
  if (tab === "videos") {
    const v: MediaVideo = media.videos[idx];
    url = v.download ?? null;
    name = `${slug}-${(v.title ?? "video").replace(/\s+/g, "-")}.mp4`;
  } else {
    const list = tab === "photos" ? media.images : media.floorPlans;
    const it = list[idx];
    url = it.original;
    name = ("filename" in it && it.filename) || `${name}.jpg`;
  }
  if (!url) return null;
  return (
    <a
      href={dl(url, name)}
      className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/20"
    >
      <Download className="size-4" /> Download
    </a>
  );
}

function VideoPlayer({ video }: { video: MediaVideo }) {
  // Aryeo's download_url is a direct MP4 that plays everywhere; fall back to the
  // (HLS) playback_url for browsers that accept it.
  const src = video.download ?? video.playback ?? undefined;
  if (!src) return <div className="text-white/60">Video unavailable</div>;
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video src={src} poster={video.thumb ?? undefined} controls autoPlay className="max-h-full max-w-full rounded-lg" />
  );
}
