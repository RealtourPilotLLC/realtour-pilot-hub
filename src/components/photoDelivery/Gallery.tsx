"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpToLine, CheckSquare, Eye, EyeOff, GripVertical, Loader2, Square, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveDeliveryOrderAction } from "@/app/ops/photo-delivery/actions";
import { PhotoImg } from "./PhotoImg";
import { photoTitle, useJob } from "./JobContext";
import { SEVERITY_CLASS, SEVERITY_LABEL, intakeLine, moveTogether, worstOf } from "./format";
import type { PhotoView, Severity } from "./types";

// ---------------------------------------------------------------------------
// THE GALLERY (plan 9.4): every photo in delivery order. Star sets the hero,
// the eye leaves a photo out (with a reason) or puts it back, drag a tile to
// reorder (desktop), or switch on "Reorder" to tick photos and move them with
// the toolbar (phone and keyboard). Hover, or press and hold on a phone, shows
// the AI description. The order saves as photo ids (PhotoJob.orderJson); the
// hero always leads the delivery.
//
// Oct 14 2026 (huddle finding 10: "moving photos upward is hard"):
//   · while a photo is dragged, the page scrolls by itself near the top of
//     the window or near the Deliver panel stuck to the bottom (which used to
//     cover the browser's own scroll edge), faster the closer it gets;
//   · in Reorder, tick several photos and move them together: to the front,
//     to a position, one step earlier or later, or drag any ticked photo and
//     the others come with it, in their order.
// ---------------------------------------------------------------------------

/** The element that scrolls the gallery (the window, unless a parent scrolls). */
function scrollerOf(el: HTMLElement | null): HTMLElement {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight + 4) return n;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

const iconBtn =
  "inline-flex size-10 items-center justify-center rounded-lg bg-black/55 text-white backdrop-blur hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";

export function Gallery() {
  const { data, jobId, findingsByPhoto, openLightbox, excludePhoto, makeHero, run, pending, shown, readOnly } = useJob();
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
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [posInput, setPosInput] = useState("");
  const listRef = useRef<HTMLOListElement | null>(null);
  // Only photos still in the delivery can stay ticked.
  const chosen = useMemo(() => order.filter((id) => picked.has(id)), [order, picked]);

  // Auto-scroll while dragging (huddle finding 10).
  useEffect(() => {
    if (!dragId) return;
    const scroller = scrollerOf(listRef.current);
    let y = -1;
    let raf = 0;
    const onOver = (e: DragEvent) => {
      y = e.clientY;
    };
    const tick = () => {
      if (y >= 0) {
        const panel = document.querySelector<HTMLElement>('section[aria-label="Deliver"]');
        const bottomEdge = panel ? Math.min(window.innerHeight, panel.getBoundingClientRect().top) : window.innerHeight;
        const topEdge = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
        const zone = 110;
        let dy = 0;
        if (y < topEdge + zone) dy = -Math.ceil(((topEdge + zone - y) / zone) * 22);
        else if (y > bottomEdge - zone) dy = Math.ceil(((y - (bottomEdge - zone)) / zone) * 22);
        if (dy) scroller.scrollBy({ top: Math.max(-40, Math.min(40, dy)) });
      }
      raf = requestAnimationFrame(tick);
    };
    document.addEventListener("dragover", onOver);
    raf = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener("dragover", onOver);
      cancelAnimationFrame(raf);
    };
  }, [dragId]);

  const worst = (p: PhotoView): Severity | null =>
    worstOf((findingsByPhoto.get(p.id) ?? []).filter((f) => f.status === "OPEN" && shown(f)).map((f) => f.severity));

  async function save(next: string[]) {
    if (next.join(",") === order.join(",")) return;
    setLocal({ base: serverKey, ids: next });
    const ok = await run(() => saveDeliveryOrderAction(jobId, next));
    if (!ok) setLocal(null);
  }
  async function move(id: string, to: number) {
    const from = order.indexOf(id);
    if (from < 0 || to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    await save(next);
  }
  /** The ticked photos, together, to a 0-based place in what is left. */
  async function moveChosenTo(at: number) {
    if (!chosen.length) return;
    const set = new Set(chosen);
    const rest = order.filter((id) => !set.has(id));
    const k = Math.max(0, Math.min(rest.length, at));
    await save([...rest.slice(0, k), ...chosen, ...rest.slice(k)]);
  }
  /** One step earlier (-1) or later (+1), as a block. */
  async function stepChosen(d: -1 | 1) {
    if (!chosen.length) return;
    const first = order.indexOf(chosen[0]);
    const set = new Set(chosen);
    const before = order.slice(0, first).filter((id) => !set.has(id)).length;
    await moveChosenTo(before + d);
  }
  const toggle = (id: string) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

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
        draggable={!readOnly && !isExcluded && !pending}
        onDragStart={(e) => {
          if (readOnly || isExcluded) return;
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
          if (!id || index == null) return;
          // Dragging a ticked photo brings every ticked photo with it.
          if (picked.has(id) && chosen.length > 1) void save(moveTogether(order, chosen, index));
          else void move(id, index);
        }}
        onDragEnd={() => {
          setDragId(null);
          setOverId(null);
        }}
        className={cn(
          "group relative overflow-hidden rounded-xl border bg-surface-2",
          overId === p.id && dragId !== p.id ? "border-brand ring-2 ring-brand/50" : picked.has(p.id) && index != null ? "border-brand" : "border-border",
          (dragId === p.id || (dragId && picked.has(dragId) && picked.has(p.id))) && "opacity-50",
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
            {reorder && index != null && (
              <button
                type="button"
                role="checkbox"
                aria-checked={picked.has(p.id)}
                aria-label={`Select ${title} to move`}
                onClick={() => toggle(p.id)}
                className="pointer-events-auto inline-flex size-9 items-center justify-center rounded-md bg-black/65 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-brand"
              >
                {picked.has(p.id) ? <CheckSquare aria-hidden className="size-4" /> : <Square aria-hidden className="size-4" />}
              </button>
            )}
            {index != null && <span className="rounded-md bg-black/65 px-1.5 py-0.5 text-[12px] font-semibold tabular-nums text-white">{String(index + 1).padStart(2, "0")}</span>}
            {isHero && (
              <span className="inline-flex items-center gap-1 rounded-md bg-brand-action px-1.5 py-0.5 text-[12px] font-semibold text-white">
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
            <span className="inline-block rounded-md bg-black/75 px-2 py-1 text-[12px] font-semibold uppercase tracking-wide text-white">Left out</span>
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

        {/* bottom row: room label + actions (hidden while reordering: the toolbar moves photos then; none on a view-only page) */}
        <div className={cn("flex items-center gap-1 p-1.5", p.description && "lg:group-hover:invisible", readOnly && "min-h-10")}>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted" title={p.name}>{p.roomLabel}</span>
          {!readOnly && !reorder && !isExcluded && (
            <button
              type="button"
              className={cn(iconBtn, isHero && "text-brand")}
              disabled={pending || isHero}
              aria-pressed={isHero}
              aria-label={isHero ? `${title} is the hero` : `Make ${title} the hero`}
              title={isHero ? "The hero leads the delivery" : "Make this the hero"}
              onClick={() => void makeHero(p)}
            >
              <Star aria-hidden className={cn("size-4", isHero && "fill-current")} />
            </button>
          )}
          {!readOnly && !reorder && (
            <button
              type="button"
              className={iconBtn}
              disabled={pending}
              aria-label={isExcluded ? `Put ${title} back in the delivery` : `Leave ${title} out of the delivery`}
              title={isExcluded ? "Put back" : "Leave out (asks why)"}
              onClick={() => void excludePhoto(p, !isExcluded)}
            >
              {isExcluded ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />}
            </button>
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
        {!readOnly && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={reorder}
              onClick={() => {
                setReorder((v) => !v);
                setPicked(new Set());
              }}
              className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium", reorder ? "border-brand bg-brand-soft" : "border-border-strong hover:bg-surface-2")}
            >
              <GripVertical aria-hidden className="size-4" /> {reorder ? "Done reordering" : "Reorder"}
            </button>
          </div>
        )}
      </div>
      <p className="mb-2 text-[12px] text-muted">{readOnly ? "In delivery order. The hero goes first." : "Drag to reorder. The hero always goes first."}</p>
      {reorder && !readOnly && (
        <div className="sticky top-2 z-10 mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface/95 p-2 text-sm backdrop-blur" role="toolbar" aria-label="Move the selected photos">
          <span className="px-1 font-medium">{chosen.length ? `${chosen.length} selected` : "Tick photos to move them together"}</span>
          <button type="button" disabled={pending || !chosen.length} onClick={() => void moveChosenTo(0)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 hover:bg-surface-2 disabled:opacity-50">
            <ArrowUpToLine aria-hidden className="size-4" /> To the front
          </button>
          <button type="button" disabled={pending || !chosen.length} onClick={() => void stepChosen(-1)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 hover:bg-surface-2 disabled:opacity-50">
            <ArrowUp aria-hidden className="size-4" /> Earlier
          </button>
          <button type="button" disabled={pending || !chosen.length} onClick={() => void stepChosen(1)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 hover:bg-surface-2 disabled:opacity-50">
            <ArrowDown aria-hidden className="size-4" /> Later
          </button>
          <form
            className="hidden items-center gap-1 sm:flex"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(posInput);
              if (!Number.isFinite(n) || n < 1) return;
              void moveChosenTo(Math.floor(n) - 1);
              setPosInput("");
            }}
          >
            <label className="flex items-center gap-1">
              <span>To position</span>
              <input inputMode="numeric" value={posInput} onChange={(e) => setPosInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} className="h-10 w-16 rounded-lg border border-border-strong bg-surface px-2 tabular-nums" aria-label="Position to move them to" />
            </label>
            <button type="submit" disabled={pending || !chosen.length || !posInput} className="inline-flex min-h-10 items-center rounded-lg border border-border-strong px-2.5 hover:bg-surface-2 disabled:opacity-50">
              Move
            </button>
          </form>
          {chosen.length > 0 && (
            <button type="button" onClick={() => setPicked(new Set())} className="ml-auto inline-flex min-h-10 items-center rounded-lg px-2.5 text-muted hover:bg-surface-2">
              Clear
            </button>
          )}
        </div>
      )}
      {active.length + excluded.length > 0 && intakeLine(data.intake, true) && <p className="mb-2 rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-[13px] text-muted">{intakeLine(data.intake, true)}</p>}
      {active.length === 0 && excluded.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted">
          {intakeLine(data.intake, false)}
        </p>
      ) : (
        <ol ref={listRef} className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
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
