"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Loader2, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveDeliveryOrderAction } from "@/app/ops/photo-delivery/actions";
import { PhotoImg } from "./PhotoImg";
import { photoTitle, useJob } from "./JobContext";
import { SEVERITY_CLASS, SEVERITY_LABEL, worstOf } from "./format";
import type { PhotoView, Severity } from "./types";

// ---------------------------------------------------------------------------
// THE GALLERY (plan 9.4): every photo in delivery order. Star sets the hero,
// the eye leaves a photo out (with a reason) or puts it back, drag a tile to
// reorder (desktop), or switch on "Reorder" for move-earlier / move-later
// buttons (phone and keyboard). Hover, or press and hold on a phone, shows
// the AI description. The order saves as photo ids (PhotoJob.orderJson); the
// hero always leads the delivery.
// ---------------------------------------------------------------------------

const iconBtn =
  "inline-flex size-10 items-center justify-center rounded-lg bg-black/55 text-white backdrop-blur hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";

export function Gallery() {
  const { data, jobId, findingsByPhoto, openLightbox, excludePhoto, makeHero, run, pending, shown } = useJob();
  const active = useMemo(() => data.photos.filter((p) => p.status === "ACTIVE"), [data.photos]);
  const excluded = useMemo(() => data.photos.filter((p) => p.status === "EXCLUDED"), [data.photos]);
  const serverKey = active.map((p) => p.id).join(",");
  // A local order only while it differs from what the server last sent.
  const [local, setLocal] = useState<{ base: string; ids: string[] } | null>(null);
  const order = local && local.base === serverKey ? local.ids : active.map((p) => p.id);
  const byId = useMemo(() => new Map(data.photos.map((p) => [p.id, p])), [data.photos]);
  const [reorder, setReorder] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);

  const worst = (p: PhotoView): Severity | null =>
    worstOf((findingsByPhoto.get(p.id) ?? []).filter((f) => f.status === "OPEN" && shown(f)).map((f) => f.severity));

  async function move(id: string, to: number) {
    const from = order.indexOf(id);
    if (from < 0 || to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    setLocal({ base: serverKey, ids: next });
    const ok = await run(() => saveDeliveryOrderAction(jobId, next));
    if (!ok) setLocal(null);
  }

  const startPress = (id: string) => {
    if (press.current) clearTimeout(press.current);
    press.current = setTimeout(() => setPeek(id), 500);
  };
  const endPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };

  const tile = (p: PhotoView, index: number | null) => {
    const sev = p.status === "ACTIVE" ? worst(p) : null;
    const isHero = data.heroPhotoId === p.id;
    const isExcluded = p.status === "EXCLUDED";
    const title = photoTitle(p);
    return (
      <li
        key={p.id}
        draggable={!isExcluded && !pending}
        onDragStart={(e) => {
          if (isExcluded) return;
          setDragId(p.id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", p.id);
        }}
        onDragOver={(e) => {
          if (!dragId || isExcluded) return;
          e.preventDefault();
          if (overId !== p.id) setOverId(p.id);
        }}
        onDragLeave={() => setOverId((cur) => (cur === p.id ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          const id = dragId;
          setDragId(null);
          setOverId(null);
          if (id && index != null) void move(id, index);
        }}
        onDragEnd={() => {
          setDragId(null);
          setOverId(null);
        }}
        className={cn(
          "group relative overflow-hidden rounded-xl border bg-surface-2",
          overId === p.id && dragId !== p.id ? "border-brand ring-2 ring-brand/50" : "border-border",
          dragId === p.id && "opacity-50",
        )}
      >
        <button
          type="button"
          onClick={() => {
            if (peek === p.id) return;
            openLightbox(p.id);
          }}
          onTouchStart={() => startPress(p.id)}
          onTouchEnd={endPress}
          onTouchMove={endPress}
          onContextMenu={(e) => {
            if (peek === p.id) e.preventDefault();
          }}
          aria-label={`Open ${title}: ${p.roomLabel}${sev ? `, worst open issue ${SEVERITY_LABEL[sev].toLowerCase()}` : ""}${isExcluded ? ", left out of the delivery" : ""}`}
          className="block aspect-[3/2] w-full select-none [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
        >
          <PhotoImg photoId={p.id} hash={p.contentHash} fallbackUrl={p.sourceUrl} size="thumb768" alt={`${title}: ${p.roomLabel}`} className={cn("size-full object-cover", isExcluded && "opacity-40 grayscale")} />
        </button>

        {/* top row: position, hero, severity */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-1.5">
          <span className="flex items-center gap-1">
            {index != null && <span className="rounded-md bg-black/65 px-1.5 py-0.5 text-[12px] font-semibold tabular-nums text-white">{String(index + 1).padStart(2, "0")}</span>}
            {isHero && (
              <span className="inline-flex items-center gap-1 rounded-md bg-brand px-1.5 py-0.5 text-[12px] font-semibold text-white">
                <Star aria-hidden className="size-3 fill-current" /> Hero
              </span>
            )}
          </span>
          {sev && <span className={cn("rounded-md px-1.5 py-0.5 text-[12px] font-semibold ring-1 ring-inset backdrop-blur", SEVERITY_CLASS[sev])}>{SEVERITY_LABEL[sev]}</span>}
        </div>

        {p.fixing && (
          <span className="pointer-events-none absolute left-1.5 top-9 inline-flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[12px] text-white">
            <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> Fixing
          </span>
        )}

        {isExcluded && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-2 text-center">
            <span className="inline-block rounded-md bg-black/75 px-2 py-1 text-[12px] font-semibold uppercase tracking-wide text-white">Excluded</span>
            {p.excludeReason && <span className="mt-1 block truncate text-[12px] text-white drop-shadow">{p.excludeReason}</span>}
          </div>
        )}

        {/* description: hover on a desktop, press and hold on a phone */}
        {p.description && (
          <div
            className={cn(
              "absolute inset-x-0 bottom-0 bg-black/80 p-2 text-[12px] leading-snug text-white",
              peek === p.id ? "block" : "pointer-events-none hidden lg:group-hover:block",
            )}
          >
            <p className="line-clamp-4">{p.description}</p>
            {peek === p.id && (
              <button type="button" onClick={() => setPeek(null)} aria-label="Close the description" className="absolute right-1 top-1 inline-flex size-8 items-center justify-center rounded-md hover:bg-white/15">
                <X aria-hidden className="size-4" />
              </button>
            )}
          </div>
        )}

        {/* bottom row: room label + actions */}
        <div className={cn("flex items-center gap-1 p-1.5", p.description && "lg:group-hover:invisible")}>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted" title={p.name}>{p.roomLabel}</span>
          {!isExcluded && (
            <button
              type="button"
              className={cn(iconBtn, "size-9", isHero && "text-brand")}
              disabled={pending || isHero}
              aria-pressed={isHero}
              aria-label={isHero ? `${title} is the hero` : `Make ${title} the hero`}
              title={isHero ? "The hero leads the delivery" : "Make this the hero"}
              onClick={() => void makeHero(p)}
            >
              <Star aria-hidden className={cn("size-4", isHero && "fill-current")} />
            </button>
          )}
          <button
            type="button"
            className={cn(iconBtn, "size-9")}
            disabled={pending}
            aria-label={isExcluded ? `Put ${title} back in the delivery` : `Leave ${title} out of the delivery`}
            title={isExcluded ? "Put it back" : "Leave it out (asks why)"}
            onClick={() => void excludePhoto(p, !isExcluded)}
          >
            {isExcluded ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />}
          </button>
          {reorder && index != null && (
            <>
              <button type="button" className={cn(iconBtn, "size-9")} disabled={pending || index === 0} aria-label={`Move ${title} earlier`} onClick={() => void move(p.id, index - 1)}>
                <ArrowUp aria-hidden className="size-4" />
              </button>
              <button type="button" className={cn(iconBtn, "size-9")} disabled={pending || index === order.length - 1} aria-label={`Move ${title} later`} onClick={() => void move(p.id, index + 1)}>
                <ArrowDown aria-hidden className="size-4" />
              </button>
            </>
          )}
        </div>
      </li>
    );
  };

  return (
    <section aria-labelledby="pd-gallery-h" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="pd-gallery-h" className="text-base font-semibold">Gallery</h2>
        <span className="text-[13px] text-muted">
          {active.length} in the delivery{excluded.length ? ` · ${excluded.length} left out` : ""}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={reorder}
            onClick={() => setReorder((v) => !v)}
            className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium", reorder ? "border-brand bg-brand-soft" : "border-border-strong hover:bg-surface-2")}
          >
            <GripVertical aria-hidden className="size-4" /> {reorder ? "Done reordering" : "Reorder"}
          </button>
        </div>
      </div>
      <p className="mb-2 text-[12px] text-muted">Drag a photo to reorder (or use Reorder). The hero always goes first. Order and hero save as you go.</p>
      {active.length === 0 && excluded.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted">
          No photos yet. The gallery fills in once the edited photos land on the Aryeo listing (or the finals folder).
        </p>
      ) : (
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
          {order.map((id, i) => {
            const p = byId.get(id);
            return p ? tile(p, i) : null;
          })}
          {excluded.map((p) => tile(p, null))}
        </ol>
      )}
    </section>
  );
}
