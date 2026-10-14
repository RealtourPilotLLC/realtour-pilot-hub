"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Eye, EyeOff, Layers, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { PhotoImg } from "./PhotoImg";
import { BoxOverlay } from "./BoxOverlay";
import { FindingActions } from "./FindingActions";
import { photoTitle, useJob } from "./JobContext";
import { FINDING_STATUS_LABEL, RESPONSIBILITY_LABEL, SEVERITY_CLASS, SEVERITY_LABEL, SEVERITY_ORDER, photoSrc } from "./format";
import type { FindingView, PhotoView } from "./types";

// ---------------------------------------------------------------------------
// THE LIGHTBOX (plan 9.4): one photo large (qc2048 on a desktop, qc1024 on a
// phone), the finding boxes on or off (O), the findings on this photo with
// their decision buttons, the AI description, the CV numbers, every version
// the hub has seen (the original vs the current one), and previous / next
// with the arrow keys.
// ---------------------------------------------------------------------------

const navBtn = "inline-flex size-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-30";

export function sortFindings(list: FindingView[]): FindingView[] {
  return [...list].sort(
    (a, b) => Number(b.status === "OPEN") - Number(a.status === "OPEN") || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.confidence - a.confidence,
  );
}

export function PhotoFacts({ photo }: { photo: PhotoView }) {
  return (
    <>
      {(photo.description || photo.features.length > 0) && (
        <section className="mt-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">AI description</h3>
          {photo.description && <p className="mt-1 text-sm leading-relaxed">{photo.description}</p>}
          {photo.features.length > 0 && <p className="mt-1 text-[13px] text-muted">Features: {photo.features.join(", ")}</p>}
          <p className="mt-1 text-[12px] text-muted-2">
            {photo.roomLabel}
            {photo.isAerial ? " · aerial" : ""}
            {photo.isTwilight ? " · twilight" : ""}
            {photo.isVirtuallyStaged ? " · virtually staged" : ""}
            {photo.heroScore != null ? ` · hero score ${photo.heroScore}` : ""}
          </p>
        </section>
      )}
      {photo.cv.length > 0 && (
        <section className="mt-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Measured (CV)</h3>
          <dl className="mt-1 grid grid-cols-1 gap-y-0.5 text-[13px]">
            {photo.cv.map((m) => (
              <div key={m.label} className="flex justify-between gap-3">
                <dt className="text-muted">{m.label}</dt>
                <dd className="text-right">{m.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </>
  );
}

export function Lightbox() {
  const { data, lightbox, openLightbox, findingsByPhoto, excludePhoto, makeHero, pending, promptOpen, shown } = useJob();
  const photos = useMemo(() => data.photos.filter((p) => p.status !== "GONE"), [data.photos]);
  const idx = photos.findIndex((p) => p.id === lightbox);
  const photo = idx >= 0 ? photos[idx] : null;
  const [overlays, setOverlays] = useState(true);
  const [view, setView] = useState<{ photoId: string; versionId: string | null } | null>(null);
  const versionId = photo && view?.photoId === photo.id ? view.versionId : null;

  const go = (d: number) => {
    const next = photos[idx + d];
    if (next) openLightbox(next.id);
  };

  useEffect(() => {
    if (!photo) return;
    const onKey = (e: KeyboardEvent) => {
      if (promptOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = photos[idx + 1];
        if (next) openLightbox(next.id);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = photos[idx - 1];
        if (prev) openLightbox(prev.id);
      } else if (e.key === "o" || e.key === "O") {
        setOverlays((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [photo, photos, idx, openLightbox, promptOpen]);

  if (!photo) return null;
  const findings = sortFindings(findingsByPhoto.get(photo.id) ?? []);
  const numbers = new Map(findings.map((f, i) => [f.id, i + 1]));
  const isHero = data.heroPhotoId === photo.id;
  const excluded = photo.status === "EXCLUDED";
  const current = photo.versions.find((v) => v.current) ?? photo.versions[photo.versions.length - 1] ?? null;
  const showing = versionId ? photo.versions.find((v) => v.id === versionId) ?? null : null;
  const title = photoTitle(photo);

  return (
    <ModalDialog label={`${title}: ${photo.roomLabel}`} onCancel={() => openLightbox(null)} className="w-[min(98vw,100rem)] max-h-[96dvh] p-0 sm:p-0">
      <div className="flex max-h-[96dvh] flex-col lg:flex-row">
        <div className="relative flex min-h-[40dvh] min-w-0 flex-1 items-center justify-center bg-black p-2 sm:p-4">
          <div className="relative inline-block max-w-full">
            <PhotoImg
              photoId={photo.id}
              hash={showing?.contentHash ?? photo.contentHash}
              fallbackUrl={photo.sourceUrl}
              versionId={showing && !showing.current ? showing.id : null}
              size="qc2048"
              large
              eager
              alt={`${title}: ${photo.roomLabel}${photo.description ? `. ${photo.description}` : ""}`}
              className="block h-auto max-h-[56dvh] w-auto max-w-full lg:max-h-[88dvh]"
            />
            {overlays && (!showing || showing.current) && <BoxOverlay photo={photo} findings={findings.filter(shown)} numbers={numbers} />}
          </div>
          <div className="absolute inset-y-0 left-1 flex items-center sm:left-3">
            <button type="button" className={navBtn} disabled={idx <= 0} onClick={() => go(-1)} aria-label="Previous photo">
              <ChevronLeft aria-hidden className="size-6" />
            </button>
          </div>
          <div className="absolute inset-y-0 right-1 flex items-center sm:right-3">
            <button type="button" className={navBtn} disabled={idx >= photos.length - 1} onClick={() => go(1)} aria-label="Next photo">
              <ChevronRight aria-hidden className="size-6" />
            </button>
          </div>
        </div>

        <aside className="w-full shrink-0 overflow-y-auto border-t border-border p-4 lg:w-[26rem] lg:border-l lg:border-t-0">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">
                {title} <span className="font-normal text-muted">· {photo.roomLabel}</span>
              </h2>
              <p className="break-all text-[12px] text-muted">
                {photo.name}
                {photo.deliveryName ? ` → ${photo.deliveryName}` : ""} · {idx + 1} of {photos.length}
              </p>
              {excluded && <p className="mt-1 text-[13px] font-medium text-warning">Left out of the delivery{photo.excludeReason ? `: ${photo.excludeReason}` : ""}</p>}
            </div>
            <button type="button" onClick={() => openLightbox(null)} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-2">
              <X aria-hidden className="size-5" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {!excluded && (
              <button type="button" disabled={pending || isHero} onClick={() => void makeHero(photo)} aria-pressed={isHero} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60">
                <Star aria-hidden className={cn("size-3.5", isHero && "fill-current text-brand")} /> {isHero ? "Hero" : "Make hero"}
              </button>
            )}
            <button type="button" disabled={pending} onClick={() => void excludePhoto(photo, !excluded)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60">
              {excluded ? <Eye aria-hidden className="size-3.5" /> : <EyeOff aria-hidden className="size-3.5" />} {excluded ? "Put it back" : "Exclude from delivery"}
            </button>
            <button type="button" aria-pressed={overlays} onClick={() => setOverlays((v) => !v)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2">
              <Layers aria-hidden className="size-3.5" /> Boxes {overlays ? "on" : "off"} <kbd className="text-[11px] text-muted">O</kbd>
            </button>
            <a href={photoSrc(photo.id, "qc2048", photo.contentHash)} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2">
              <ExternalLink aria-hidden className="size-3.5" /> Full size
            </a>
          </div>

          <section className="mt-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Findings on this photo ({findings.length})</h3>
            {findings.length === 0 ? (
              <p className="mt-1 text-sm text-muted">{data.runs.length ? "QC found nothing on this photo." : "QC has not run yet."}</p>
            ) : (
              <ol className="mt-1.5 space-y-2">
                {findings.map((f) => (
                  <li key={f.id} className={cn("rounded-xl border p-2.5", f.status === "OPEN" && shown(f) && f.severity === "CRITICAL" ? "border-danger/40" : "border-border")}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex size-5 items-center justify-center rounded bg-surface-2 text-[11px] font-bold">{numbers.get(f.id)}</span>
                      <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset", SEVERITY_CLASS[f.severity])}>{SEVERITY_LABEL[f.severity]}</span>
                      <span className="text-sm font-medium">{f.ruleLabel || f.specificIssue}</span>
                      <span className="text-[12px] text-muted">
                        {Math.round(f.confidence * 100)}%{!shown(f) ? " (low confidence)" : ""} · {RESPONSIBILITY_LABEL[f.responsibility] ?? f.responsibility}
                      </span>
                    </div>
                    {f.ruleLabel && f.specificIssue !== f.ruleLabel && <p className="mt-1 break-words text-[13px]">{f.specificIssue}</p>}
                    {f.explanation && <p className="mt-0.5 break-words text-[13px] text-muted">{f.explanation}</p>}
                    {f.locationText && <p className="text-[13px] text-muted">Where: {f.locationText}</p>}
                    {f.photoIds.length > 1 && <p className="text-[12px] text-muted">Also on {f.photoIds.length - 1} other photo{f.photoIds.length === 2 ? "" : "s"}.</p>}
                    {f.status !== "OPEN" && (
                      <p className="mt-0.5 text-[12px] text-muted">
                        {FINDING_STATUS_LABEL[f.status] ?? f.status}
                        {f.decidedBy ? ` by ${f.decidedBy}` : ""}
                        {f.statusReason ? `: ${f.statusReason}` : ""}
                      </p>
                    )}
                    <FindingActions findings={[f]} className="mt-2" />
                  </li>
                ))}
              </ol>
            )}
          </section>

          {photo.versions.length > 0 && (
            <section className="mt-4">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Versions ({photo.versions.length})</h3>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {photo.versions.map((v, i) => {
                  const on = showing ? showing.id === v.id : v.id === current?.id;
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setView({ photoId: photo.id, versionId: v.current ? null : v.id })}
                        className={cn("min-h-10 rounded-lg border px-2.5 py-1 text-left text-[12px]", on ? "border-brand bg-brand-soft" : "border-border-strong hover:bg-surface-2")}
                        title={v.createdBy ? `By ${v.createdBy}` : undefined}
                      >
                        <span className="block font-medium">{i === 0 ? "Original" : v.label}{v.current ? " (current)" : ""}</span>
                        <span className="block text-muted">{etMonthDayTime(v.createdAt)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {showing && !showing.current && <p className="mt-1 text-[12px] text-muted">Showing an earlier version. Boxes describe the current one, so they are hidden.</p>}
            </section>
          )}

          <PhotoFacts photo={photo} />
        </aside>
      </div>
    </ModalDialog>
  );
}
