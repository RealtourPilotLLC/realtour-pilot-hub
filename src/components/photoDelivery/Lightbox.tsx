"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Crop, ExternalLink, Eye, EyeOff, LandPlot, Layers, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { PhotoImg } from "./PhotoImg";
import { BoxOverlay } from "./BoxOverlay";
import { FindingActions } from "./FindingActions";
import { HubEditPanel, ReeditBox, StraightenButtons } from "./EditTools";
import { DownloadLinks, ReplaceWithUpload } from "./PhotoFiles";
import { photoTitle, useJob } from "./JobContext";
import { FINDING_STATUS_LABEL, RESPONSIBILITY_LABEL, SEVERITY_CLASS, SEVERITY_LABEL, SEVERITY_ORDER, photoSrc } from "./format";
import { loadVersionsAction, restoreVersionAction } from "@/app/ops/photo-delivery/actions";
import type { FindingView, PhotoView, VersionView } from "./types";

// ---------------------------------------------------------------------------
// THE LIGHTBOX (plan 9.4): one photo large (qc2048 on a desktop, qc1024 on a
// phone), the finding boxes on or off (O), the findings on this photo with
// their decision buttons, the AI description (the CV numbers and hero score
// for the owner only), every version the hub has seen (the original vs the
// current one), and previous / next with the arrow keys.
// ---------------------------------------------------------------------------

// Oct 22 2026: loaded when first opened (its drawing code is only needed then).
const LotLinesEditor = dynamic(() => import("./LotLinesEditor"), { ssr: false });

const navBtn = "inline-flex size-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-30";

export function sortFindings(list: FindingView[]): FindingView[] {
  return [...list].sort(
    (a, b) => Number(b.status === "OPEN") - Number(a.status === "OPEN") || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.confidence - a.confidence,
  );
}

export function PhotoFacts({ photo }: { photo: PhotoView }) {
  const { viewer } = useJob();
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
            {viewer.isOwner && photo.heroScore != null ? ` · hero score ${photo.heroScore}` : ""}
          </p>
        </section>
      )}
      {viewer.isOwner && photo.cv.length > 0 && (
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
  const { data, lightbox, openLightbox, findingsByPhoto, excludePhoto, makeHero, pending, promptOpen, shown, openEditor, readOnly } = useJob();
  const photos = useMemo(() => data.photos.filter((p) => p.status !== "GONE"), [data.photos]);
  const idx = photos.findIndex((p) => p.id === lightbox);
  const photo = idx >= 0 ? photos[idx] : null;
  const [overlays, setOverlays] = useState(true);
  const [view, setView] = useState<{ photoId: string; versionId: string | null } | null>(null);
  const versionId = photo && view?.photoId === photo.id ? view.versionId : null;
  // Oct 22 2026: the photo open in the Lot lines tool (LotLinesEditor), the office's only.
  const [lotFor, setLotFor] = useState<string | null>(null);

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
  // Oct 22 2026: already delivered on the Aryeo listing (a split job): read only, never sent again.
  const listed = photo.status === "ON_LISTING";
  const current = photo.versions.find((v) => v.current) ?? photo.versions[photo.versions.length - 1] ?? null;
  const showing = versionId ? photo.versions.find((v) => v.id === versionId) ?? null : null;
  const title = photoTitle(photo);

  return (
    <>
    <ModalDialog label={`${title}: ${photo.roomLabel}`} onCancel={() => openLightbox(null)} className="w-[min(98vw,100rem)] max-h-[96dvh] p-0 sm:p-0">
      <div className="flex max-h-[96dvh] flex-col lg:flex-row">
        <div className="relative flex min-h-[40dvh] min-w-0 flex-1 items-center justify-center bg-black p-2 sm:p-4">
          <div className="relative inline-block max-w-full">
            {showing && !showing.current ? (
              // An earlier version beside the current one, same size (huddle finding 1).
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {[showing, current].map((v, k) =>
                  v ? (
                    <figure key={v.id} className="min-w-0">
                      <PhotoImg
                        photoId={photo.id}
                        hash={v.contentHash ?? photo.contentHash}
                        fallbackUrl={null}
                        versionId={k === 0 ? v.id : null}
                        size="qc2048"
                        large
                        eager
                        alt={`${title}: ${k === 0 ? v.label : "current version"}`}
                        className="block h-auto max-h-[40dvh] w-full object-contain lg:max-h-[80dvh]"
                      />
                      <figcaption className="mt-1 text-center text-[12px] text-white/80">{k === 0 ? `${versionName(v, photo.versions)} (earlier)` : `${versionName(v, photo.versions)} (current: this is what downloads)`}</figcaption>
                    </figure>
                  ) : null,
                )}
              </div>
            ) : (
              <PhotoImg
                photoId={photo.id}
                hash={photo.contentHash}
                fallbackUrl={photo.sourceUrl}
                size="qc2048"
                large
                eager
                alt={`${title}: ${photo.roomLabel}${photo.description ? `. ${photo.description}` : ""}`}
                className="block h-auto max-h-[56dvh] w-auto max-w-full lg:max-h-[88dvh]"
              />
            )}
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
              {listed && (
                <p className="mt-1 text-[13px] font-medium text-success">
                  Delivered: already on the Aryeo listing{photo.delivered?.since ? ` (first seen there ${etMonthDayTime(photo.delivered.since)})` : ""}{photo.delivered?.asName ? `, added by hand as ${photo.delivered.asName}` : ""}. Never sent again.
                </p>
              )}
              {!listed && photo.status === "ACTIVE" && (data.listing?.delivered ?? 0) > 0 && <p className="mt-1 text-[13px] font-medium text-warning">Not delivered yet: it goes out with this delivery.</p>}
              {photo.sourceKind === "UPLOAD" && <p className="mt-1 text-[13px] text-muted">Added to the gallery by hand.</p>}
            </div>
            <button type="button" onClick={() => openLightbox(null)} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-2">
              <X aria-hidden className="size-5" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {/* View only (Oct 22 2026): the hero and the delivery set are the office's calls; a viewer reads them. */}
            {readOnly || listed ? (
              isHero && (
                <span className="inline-flex min-h-10 items-center gap-1.5 px-1 text-[13px] font-medium">
                  <Star aria-hidden className="size-3.5 fill-current text-brand" /> Hero
                </span>
              )
            ) : (
              <>
                {!excluded && (
                  <button type="button" disabled={pending || isHero} onClick={() => void makeHero(photo)} aria-pressed={isHero} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60">
                    <Star aria-hidden className={cn("size-3.5", isHero && "fill-current text-brand")} /> {isHero ? "Hero" : "Make hero"}
                  </button>
                )}
                <button type="button" disabled={pending} onClick={() => void excludePhoto(photo, !excluded)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60">
                  {excluded ? <Eye aria-hidden className="size-3.5" /> : <EyeOff aria-hidden className="size-3.5" />} {excluded ? "Put back" : "Leave out"}
                </button>
              </>
            )}
            <button type="button" aria-pressed={overlays} onClick={() => setOverlays((v) => !v)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2">
              <Layers aria-hidden className="size-3.5" /> Boxes {overlays ? "on" : "off"} <kbd className="text-[11px] text-muted">O</kbd>
            </button>
            {photo.status !== "GONE" && !listed && !readOnly && (
              <button type="button" disabled={pending || photo.fixing} onClick={() => openEditor(photo.id)} title={photo.fixing ? "An AI fix is running on this photo" : "Straighten, fix the vertical perspective or crop (free, exact)"} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-brand/50 bg-brand-soft px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60">
                <Crop aria-hidden className="size-3.5" /> Straighten and crop
              </button>
            )}
            {/* Oct 22 2026: the property boundary on a drone or aerial photo (free, drawn at full size on the server). */}
            {photo.status !== "GONE" && !listed && !readOnly && (
              <button type="button" disabled={pending || photo.fixing} onClick={() => setLotFor(photo.id)} title={photo.fixing ? "An AI fix is running on this photo" : "Draw the property's lot lines on this photo (free)"} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-brand/50 bg-brand-soft px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60">
                <LandPlot aria-hidden className="size-3.5" /> Lot lines
              </button>
            )}
            <a href={photoSrc(photo.id, "qc2048", photo.contentHash)} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2">
              <ExternalLink aria-hidden className="size-3.5" /> Full size
            </a>
            {/* Oct 22 2026: the file at full size (the view-only desk too); a replacement upload is the office's. */}
            <DownloadLinks photo={photo} />
            {!listed && <ReplaceWithUpload photo={photo} />}
          </div>
          {photo.hubEdit?.kind === "lotLines" && !readOnly && !listed && (
            <p className="mt-1.5 text-[12px] text-muted">This photo has lot lines. Straighten and crop starts again from the photo without them: open Lot lines after it, the drawing is kept.</p>
          )}

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
                        {!shown(f) ? "Unsure · " : ""}
                        {RESPONSIBILITY_LABEL[f.responsibility] ?? f.responsibility}
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
                    <StraightenButtons findings={[f]} className="mt-1.5" />
                  </li>
                ))}
              </ol>
            )}
          </section>

          <HubEditPanel photo={photo} />

          <VersionsStrip photo={photo} showingId={showing?.id ?? null} currentId={current?.id ?? null} onShow={(id) => setView({ photoId: photo.id, versionId: id })} />

          {/* An AI re-edit spends credits: the office's (Oct 22 2026). */}
          {!readOnly && !listed && <ReeditBox photo={photo} />}

          <PhotoFacts photo={photo} />
        </aside>
      </div>
    </ModalDialog>
    {lotFor && !readOnly && <LotLinesEditor photoId={lotFor} onClose={() => setLotFor(null)} />}
    </>
  );
}

/** "Original", "AutoHDR edit", "AutoHDR reedit"…: what a person calls a version. */
function versionName(v: VersionView, all: VersionView[]): string {
  if (v.source === "ORIGINAL_FETCH" || (all[0]?.id === v.id && !v.inAutohdr)) return "Original";
  return v.label;
}

/**
 * Every version of the photo (Oct 14 2026, huddle finding 1): pick one to see
 * it beside the current one, Restore it (it becomes what downloads and what
 * goes to 06-Ready-for-Aryeo), or load every step AutoHDR has (the capture,
 * its first edit, the straightening, each fix) to find where a photo went
 * wrong. Sharpness is measured at one size, so a softer step is flagged.
 */
function VersionsStrip({ photo, showingId, currentId, onShow }: { photo: PhotoView; showingId: string | null; currentId: string | null; onShow: (id: string | null) => void }) {
  const { jobId, run, confirm, pending, readOnly } = useJob();
  const versions = photo.versions;
  const sharpest = Math.max(0, ...versions.map((v) => v.sharpness ?? 0));
  const showing = showingId ? versions.find((v) => v.id === showingId) ?? null : null;
  const linked = versions.some((v) => v.inAutohdr) || photo.sourceKind === "AUTOHDR";
  const restore = async (v: VersionView) => {
    const ok = await confirm({
      title: `Make "${versionName(v, versions)}" the current version?`,
      body: v.inAutohdr
        ? "AutoHDR switches to it (free). The hub, its downloads and the 06-Ready-for-Aryeo folder use it from now on. Every other version stays here, so you can switch back."
        : "The hub uses it from now on (its downloads and the 06-Ready-for-Aryeo folder too). Every other version stays here, so you can switch back.",
      confirmLabel: "Restore this version",
    });
    if (!ok) return;
    if (await run(() => restoreVersionAction(jobId, photo.id, v.id))) onShow(null);
  };
  if (!versions.length && !linked) return null;
  return (
    <section className="mt-4">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Versions ({versions.length})</h3>
      <p className="mt-0.5 text-[12px] text-muted">
        {photo.sourceKind === "AUTOHDR" || readOnly
          ? "Pick a version to compare. The current one is what gets delivered."
          : "Pick a version to compare. The current one is the file on the Aryeo listing; Restore puts its file under Replace these on the Aryeo listing."}
      </p>
      {versions.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {versions.map((v) => {
            const on = showing ? showing.id === v.id : v.id === currentId;
            // Measured at one size (huddle finding 4): an AI re-edit usually loses up to a sixth of the detail; more is worth a look.
            const loss = v.sharpness != null && sharpest > 0 ? 1 - v.sharpness / sharpest : 0;
            const softer = loss >= 0.15;
            return (
              <li key={v.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onShow(v.current ? null : v.id)}
                  className={cn("min-h-10 rounded-lg border px-2.5 py-1 text-left text-[12px]", on ? "border-brand bg-brand-soft" : "border-border-strong hover:bg-surface-2")}
                  title={v.createdBy ? `By ${v.createdBy}` : undefined}
                >
                  <span className="block font-medium">
                    {versionName(v, versions)}
                    {v.current ? " (current)" : ""}
                  </span>
                  <span className="block text-muted">{etMonthDayTime(v.createdAt)}</span>
                  {softer && <span className="block font-medium text-warning">{Math.round(loss * 100)}% softer than the sharpest version</span>}
                  {!v.kept && !v.current && <span className="block text-muted-2">No copy kept yet</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {showing && !showing.current && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* Comparing is viewing; Restore changes what is delivered: the office's (Oct 22 2026). */}
          {readOnly || photo.status === "ON_LISTING" ? null : showing.inAutohdr || showing.restorable ? (
            <button type="button" disabled={pending} onClick={() => void restore(showing)} className="inline-flex min-h-10 items-center rounded-lg bg-brand-action px-3 text-[13px] font-semibold text-brand-fg hover:brightness-95 disabled:opacity-50">
              Restore this version
            </button>
          ) : (
            <p className="text-[12px] text-muted">This version can&apos;t be made current from here{showing.hubEdit ? ": the photo's own file changed since it was made. Open Straighten and crop to make it again." : ", because it is not in AutoHDR."}</p>
          )}
          <button type="button" onClick={() => onShow(null)} className="inline-flex min-h-10 items-center rounded-lg border border-border-strong px-3 text-[13px] hover:bg-surface-2">
            Back to the current one
          </button>
          <p className="w-full text-[12px] text-muted">Boxes describe the current version, so they are hidden while comparing.</p>
        </div>
      )}
      {linked && !readOnly && (
        <button
          type="button"
          disabled={pending}
          onClick={() => void run(() => loadVersionsAction(jobId, photo.id))}
          className="mt-2 inline-flex min-h-10 items-center rounded-lg border border-border-strong px-3 text-[13px] hover:bg-surface-2 disabled:opacity-50"
          title="Fetch every step AutoHDR has for this photo (free): the capture, the first edit, the straightening and each fix"
        >
          Load every version from AutoHDR
        </button>
      )}
    </section>
  );
}
