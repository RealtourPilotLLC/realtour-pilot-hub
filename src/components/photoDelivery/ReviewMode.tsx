"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, EyeOff, History, Keyboard, Layers, ShoppingCart, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PhotoImg } from "./PhotoImg";
import { BoxOverlay } from "./BoxOverlay";
import { FindingActions } from "./FindingActions";
import { FixCartPanel } from "./FixCartPanel";
import { JobProvider, photoTitle, useJob } from "./JobContext";
import { PhotoFacts, sortFindings } from "./Lightbox";
import { FINDING_STATUS_LABEL, RESPONSIBILITY_LABEL, SEVERITY_CLASS, SEVERITY_LABEL, intakeLine } from "./format";
import type { JobDetail, Viewer } from "./types";

// ---------------------------------------------------------------------------
// REVIEW MODE (plan 9.5): full screen, one photo at a time with its findings,
// built for speed (target: a clean 40-photo gallery in under 3 minutes).
//   J / K   next / previous photo        Up / Down  pick a finding
//   F       add the picked finding's fix to the cart (marked "In cart" here,
//           approved only when Run is pressed in the cart)
//   I       not worth fixing: the picked finding (asks for a reason when MAJOR or worse)
//   X       leave the photo out (asks why) or put it back
//   H       make the photo the hero       B  original vs current version
//   O       finding boxes on or off       ?  these shortcuts
// On a phone: swipe left or right, or the buttons along the bottom.
// ---------------------------------------------------------------------------

const KEYS: [string, string][] = [
  ["J", "Next photo"],
  ["K", "Previous photo"],
  ["Up / Down", "Pick a finding"],
  ["F", "Add the picked finding's fix to the cart"],
  ["I", "Not worth fixing: the picked finding (reason for major or critical)"],
  ["X", "Leave the photo out, or put it back"],
  ["H", "Make the photo the hero"],
  ["B", "Original vs current (when there is more than one version)"],
  ["O", "Finding boxes on or off"],
  ["?", "Show or hide these shortcuts"],
  ["Esc", "Close the cart or this list"],
];

export function ReviewMode({ data, viewer, initialPhoto }: { data: JobDetail; viewer: Viewer; initialPhoto: string | null }) {
  return (
    <JobProvider data={data} viewer={viewer} mode="review">
      <ReviewInner initialPhoto={initialPhoto} />
    </JobProvider>
  );
}

const tool = "inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-2.5 text-sm font-medium hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:border-brand aria-pressed:bg-brand-soft";

function ReviewInner({ initialPhoto }: { initialPhoto: string | null }) {
  const { data, jobId, findingsByPhoto, selected, decide, excludePhoto, makeHero, addToCart, cartOpen, setCartOpen, promptOpen, pending, shown } = useJob();
  const photos = useMemo(() => data.photos.filter((p) => p.status !== "GONE"), [data.photos]);
  const [currentId, setCurrentId] = useState<string | null>(initialPhoto ?? photos[0]?.id ?? null);
  const idx = Math.max(0, photos.findIndex((p) => p.id === currentId));
  const photo = photos[idx] ?? null;
  const findings = useMemo(() => (photo ? sortFindings(findingsByPhoto.get(photo.id) ?? []) : []), [photo, findingsByPhoto]);
  const [pick, setPick] = useState<{ photoId: string; findingId: string } | null>(null);
  const picked = (photo && pick?.photoId === photo.id ? findings.find((f) => f.id === pick.findingId) : null) ?? findings.find((f) => f.status === "OPEN" && shown(f)) ?? findings[0] ?? null;
  const [overlays, setOverlays] = useState(true);
  const [original, setOriginal] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const withIssues = photos.filter((p) => (findingsByPhoto.get(p.id) ?? []).some((f) => f.status === "OPEN" && shown(f))).length;
  const cartCount = (data.cart?.lines ?? []).filter((l) => !l.humanCall && l.findingIds.some((id) => selected.has(id))).length;

  const versions = photo?.versions ?? [];
  const canCompare = versions.length >= 2 && !versions[0].current;
  const showOriginal = !!photo && original === photo.id && canCompare;
  const step = (d: number) => {
    const next = photos[idx + d];
    if (next) setCurrentId(next.id);
  };

  // Latest values for the key handler without re-binding it on every render.
  const live = useRef({ step, findings, picked, photo, canCompare });
  useEffect(() => {
    live.current = { step, findings, picked, photo, canCompare };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (promptOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const { step: go, findings: list, picked: f, photo: p, canCompare: cmp } = live.current;
      if (e.key === "Escape") {
        if (help) setHelp(false);
        else if (cartOpen) setCartOpen(false);
        return;
      }
      if (cartOpen && e.key !== "?") return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === "j" || k === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (k === "k" || k === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if ((k === "ArrowDown" || k === "ArrowUp") && p && list.length) {
        e.preventDefault();
        const at = Math.max(0, list.findIndex((x) => x.id === f?.id));
        const n = (at + (k === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        setPick({ photoId: p.id, findingId: list[n].id });
      } else if (k === "f" && f) {
        if (f.status === "OPEN") addToCart([f.id]);
      } else if (k === "i" && f) {
        void decide([f], "IGNORED");
      } else if (k === "x" && p) {
        void excludePhoto(p, p.status !== "EXCLUDED");
      } else if (k === "h" && p && p.status === "ACTIVE") {
        void makeHero(p);
      } else if (k === "b" && p && cmp) {
        setOriginal((cur) => (cur === p.id ? null : p.id));
      } else if (k === "o") {
        setOverlays((v) => !v);
      } else if (e.key === "?") {
        setHelp((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [addToCart, cartOpen, decide, excludePhoto, help, makeHero, promptOpen, setCartOpen]);

  if (!photo) {
    return (
      <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <p className="font-semibold">No photos to review yet.</p>
          <p className="mt-1 text-sm text-muted">{intakeLine(data.intake, false)}</p>
          <Link href={`/ops/photo-delivery/${jobId}`} className="mt-4 inline-flex min-h-11 items-center rounded-xl border border-border-strong px-4 text-sm font-medium">Back to the job</Link>
        </div>
      </div>
    );
  }

  const numbers = new Map(findings.map((f, n) => [f.id, n + 1]));
  const isHero = data.heroPhotoId === photo.id;
  const excluded = photo.status === "EXCLUDED";
  const next = photos[idx + 1];

  return (
    <div className="fixed inset-0 z-[1100] flex flex-col bg-background text-foreground" role="region" aria-label="Review mode">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Link href={`/ops/photo-delivery/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">
          <X aria-hidden className="size-4" /> Exit
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{data.header.street}</p>
          <p className="text-[12px] text-muted">
            {idx + 1} of {photos.length} · {withIssues} with open issues
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={tool} aria-pressed={overlays} onClick={() => setOverlays((v) => !v)} title="Finding boxes (O)">
            <Layers aria-hidden className="size-4" /> <span className="hidden sm:inline">Boxes</span> <kbd className="text-[11px] text-muted">O</kbd>
          </button>
          <button type="button" className={tool} aria-pressed={showOriginal} disabled={!canCompare} onClick={() => setOriginal((cur) => (cur === photo.id ? null : photo.id))} title={canCompare ? "Original vs current (B)" : "Only one version of this photo"}>
            <History aria-hidden className="size-4" /> <span className="hidden sm:inline">{showOriginal ? "Original" : "Current"}</span> <kbd className="text-[11px] text-muted">B</kbd>
          </button>
          <button type="button" className={tool} aria-pressed={isHero} disabled={pending || excluded || isHero} onClick={() => void makeHero(photo)} title="Make hero (H)">
            <Star aria-hidden className={cn("size-4", isHero && "fill-current text-brand")} /> <span className="hidden sm:inline">Hero</span> <kbd className="text-[11px] text-muted">H</kbd>
          </button>
          <button type="button" className={tool} disabled={pending} onClick={() => void excludePhoto(photo, !excluded)} title={excluded ? "Put back (X)" : "Leave out (X)"}>
            {excluded ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />} <span className="hidden sm:inline">{excluded ? "Put back" : "Leave out"}</span> <kbd className="text-[11px] text-muted">X</kbd>
          </button>
          <button type="button" className={tool} aria-pressed={cartOpen} onClick={() => setCartOpen(!cartOpen)} title="Fix Cart">
            <ShoppingCart aria-hidden className="size-4" /> Cart{cartCount ? ` (${cartCount})` : ""}
          </button>
          <button type="button" className={tool} aria-pressed={help} onClick={() => setHelp((v) => !v)} title="Shortcuts (?)">
            <Keyboard aria-hidden className="size-4" /> <span className="sr-only">Shortcuts</span>?
          </button>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full bg-brand transition-[width]" style={{ width: `${((idx + 1) / photos.length) * 100}%` }} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          className="relative flex min-h-[38dvh] min-w-0 flex-1 items-center justify-center bg-black p-2"
          onTouchStart={(e) => {
            const t = e.touches[0];
            touch.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchEnd={(e) => {
            const s = touch.current;
            touch.current = null;
            if (!s) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - s.x;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(t.clientY - s.y)) step(dx < 0 ? 1 : -1);
          }}
        >
          <div className="relative inline-block max-w-full">
            <PhotoImg
              key={`${photo.id}-${showOriginal ? "o" : "c"}`}
              photoId={photo.id}
              hash={showOriginal ? versions[0].contentHash : photo.contentHash}
              fallbackUrl={photo.sourceUrl}
              versionId={showOriginal ? versions[0].id : null}
              size="qc2048"
              large
              eager
              alt={`${photoTitle(photo)}: ${photo.roomLabel}${showOriginal ? " (original)" : ""}`}
              className={cn("block h-auto max-h-[44dvh] w-auto max-w-full lg:max-h-[82dvh]", excluded && "opacity-50")}
            />
            {overlays && !showOriginal && <BoxOverlay photo={photo} findings={findings.filter(shown)} selectedId={picked?.id} numbers={numbers} />}
            {showOriginal && <span className="absolute left-2 top-2 rounded bg-black/75 px-2 py-0.5 text-[12px] font-semibold text-white">Original</span>}
            {excluded && <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-black/80 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-white">Left out</span>}
          </div>
          {next && (
            <div hidden>
              <PhotoImg photoId={next.id} hash={next.contentHash} fallbackUrl={next.sourceUrl} size="qc2048" large eager alt="" />
            </div>
          )}
        </div>

        <aside className="max-h-[46dvh] w-full shrink-0 overflow-y-auto border-t border-border p-3 lg:max-h-none lg:w-[27rem] lg:border-l lg:border-t-0 lg:p-4">
          <h2 className="text-base font-semibold">
            {photoTitle(photo)} <span className="font-normal text-muted">· {photo.roomLabel}</span>
            {isHero && <span className="ml-2 rounded bg-brand-action px-1.5 py-0.5 text-[12px] font-semibold text-white">Hero</span>}
          </h2>
          {excluded && photo.excludeReason && <p className="text-[13px] text-warning">Left out: {photo.excludeReason}</p>}
          {findings.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{data.runs.length ? "Nothing found on this photo. Press J for the next one." : "QC has not run on this gallery yet."}</p>
          ) : (
            <ol className="mt-2 space-y-2" aria-label="Findings on this photo">
              {findings.map((f) => {
                const on = picked?.id === f.id;
                return (
                  <li key={f.id}>
                    <div className={cn("rounded-xl border p-2.5", on ? "border-brand bg-brand-soft/30" : "border-border", !shown(f) && "opacity-70")}>
                      <button type="button" aria-pressed={on} onClick={() => setPick({ photoId: photo.id, findingId: f.id })} className="flex w-full flex-wrap items-center gap-1.5 text-left">
                        <span className="inline-flex size-5 items-center justify-center rounded bg-surface-2 text-[11px] font-bold">{numbers.get(f.id)}</span>
                        <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset", SEVERITY_CLASS[f.severity])}>{SEVERITY_LABEL[f.severity]}</span>
                        <span className="text-sm font-medium">{f.ruleLabel || f.specificIssue}</span>
                        {selected.has(f.id) && f.status === "OPEN" && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold">In cart</span>}
                        {f.status !== "OPEN" && <span className="text-[12px] text-muted">{FINDING_STATUS_LABEL[f.status] ?? f.status}</span>}
                      </button>
                      <p className="mt-1 break-words text-[13px]">{f.specificIssue}</p>
                      <p className="text-[12px] text-muted">
                        {!shown(f) ? "Unsure · " : ""}
                        {RESPONSIBILITY_LABEL[f.responsibility] ?? f.responsibility}
                        {f.locationText ? ` · ${f.locationText}` : ""}
                      </p>
                      {on && <FindingActions findings={[f]} className="mt-2" />}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <PhotoFacts photo={photo} />
        </aside>
      </div>

      <nav aria-label="Photos" className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <button type="button" className={tool} disabled={idx === 0} onClick={() => step(-1)}>
          <ChevronLeft aria-hidden className="size-5" /> Previous <kbd className="hidden text-[11px] text-muted sm:inline">K</kbd>
        </button>
        <span className="text-[13px] text-muted">{picked ? `Finding ${numbers.get(picked.id)} picked: F fix, I not worth fixing` : "Swipe or use J and K"}</span>
        <button type="button" className={tool} disabled={idx >= photos.length - 1} onClick={() => step(1)}>
          Next <kbd className="hidden text-[11px] text-muted sm:inline">J</kbd> <ChevronRight aria-hidden className="size-5" />
        </button>
      </nav>

      {cartOpen && (
        <div className="fixed inset-0 z-[1150] flex justify-end bg-black/50" onClick={(e) => e.target === e.currentTarget && setCartOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Fix Cart" className="flex h-full w-full max-w-xl flex-col bg-surface shadow-2xl">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <h2 className="flex-1 text-base font-semibold">Fix Cart</h2>
              <button type="button" onClick={() => setCartOpen(false)} aria-label="Close the cart" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-2">
                <X aria-hidden className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <p className="mb-3 text-[13px] text-muted">Fixes you pressed F on are ticked. Nothing runs until you press Run selected.</p>
              <FixCartPanel inDrawer />
            </div>
          </div>
        </div>
      )}

      {help && (
        <div className="fixed inset-0 z-[1150] flex items-center justify-center bg-black/60 p-4" onClick={(e) => e.target === e.currentTarget && setHelp(false)}>
          <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl">
            <div className="flex items-center">
              <h2 className="flex-1 text-base font-semibold">Shortcuts</h2>
              <button type="button" onClick={() => setHelp(false)} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-2">
                <X aria-hidden className="size-5" />
              </button>
            </div>
            <dl className="mt-2 space-y-1.5 text-sm">
              {KEYS.map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-24 shrink-0">
                    <kbd className="rounded border border-border-strong bg-surface-2 px-1.5 py-0.5 text-[12px] font-semibold">{k}</kbd>
                  </dt>
                  <dd className="text-muted">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
