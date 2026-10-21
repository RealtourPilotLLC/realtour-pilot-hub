"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Columns2, Crop, Grid3x3, Loader2, Minus, Plus, Undo2, Wand2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { measureStraightenAction, renderStraightenOnServerAction, saveStraightenAction } from "@/app/ops/photo-delivery/editActions";
import {
  ASPECTS, FULL_CROP, KEYSTONE_LIMIT, ROTATE_LIMIT, aspectRatio, autoCrop, cleanParams, cropFits, cssMatrix3d, editCanSettle, fitCrop, outputSize, renderRows, settledByDefault,
  type AspectKey, type CropRect, type StraightenParams,
} from "@/lib/photoDelivery/straighten";
import { photoTitle, useJob } from "./JobContext";
import type { FindingView } from "./types";

// ---------------------------------------------------------------------------
// STRAIGHTEN AND CROP (Oct 21 2026). Jordan: "Kyle needs a quick and easy way
// to fix image perspective, and cropping, etc."
//
// Opened from a photo's lightbox (Straighten and crop) or from a geometry
// finding (Straighten). The sliders move a live preview (the browser's GPU
// draws the same transform the save uses, straighten.ts); the crop follows
// the turn so no empty corner is ever kept. Save renders the photo's OWN
// full-size file in the browser with the same math, uploads the JPEG to the
// hub's private store and makes it the photo's current version
// (photoEdit.ts saveHubEdit); a phone that cannot hold the full picture asks
// the server to render it instead. Every earlier version stays under
// Versions, with Restore.
// Keys: ← → turn 0.1° (Shift 1°), ↑ ↓ keystone 1 (Shift 10), B before/after,
// G grid. Every control is at least 44 px.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const MAX_SAFE_CANVAS = 16_777_216; // iOS Safari's canvas limit (pixels)
const round1 = (n: number) => Math.round(n * 10) / 10;
const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";
const HANDLES: { h: Exclude<Handle, "move">; x: number; y: number; cursor: string }[] = [
  { h: "nw", x: 0, y: 0, cursor: "nwse-resize" }, { h: "n", x: 0.5, y: 0, cursor: "ns-resize" }, { h: "ne", x: 1, y: 0, cursor: "nesw-resize" }, { h: "e", x: 1, y: 0.5, cursor: "ew-resize" },
  { h: "se", x: 1, y: 1, cursor: "nwse-resize" }, { h: "s", x: 0.5, y: 1, cursor: "ns-resize" }, { h: "sw", x: 0, y: 1, cursor: "nesw-resize" }, { h: "w", x: 0, y: 0.5, cursor: "ew-resize" },
];

/** A crop dragged by one handle (shares of the frame), the shape kept when a preset is on. */
function dragCrop(start: CropRect, h: Handle, dx: number, dy: number, ratio: number | null, W: number, H: number): CropRect {
  const min = 0.05;
  if (h === "move") return { ...start, x: clampN(start.x + dx, 0, 1 - start.w), y: clampN(start.y + dy, 0, 1 - start.h) };
  let { x, y, w, h: hh } = start;
  const right = x + w, bottom = y + hh;
  if (h.includes("w")) x = Math.min(start.x + dx, right - min);
  if (h.includes("e")) w = Math.max(min, start.w + dx);
  if (h.includes("n")) y = Math.min(start.y + dy, bottom - min);
  if (h.includes("s")) hh = Math.max(min, start.h + dy);
  if (h.includes("w")) w = right - x;
  if (h.includes("n")) hh = bottom - y;
  if (ratio) {
    // Pixel shape kept: w·W / (h·H) = ratio.
    const byW = (h === "e" || h === "w" || ((h.length === 2) && Math.abs(dx) * W >= Math.abs(dy) * H));
    if (byW) {
      const nh = (w * W) / (ratio * H);
      if (h.includes("n")) y = bottom - nh;
      else if (!h.includes("s")) y = start.y + (start.h - nh) / 2;
      hh = nh;
    } else {
      const nw = (hh * H * ratio) / W;
      if (h.includes("w")) x = right - nw;
      else if (!h.includes("e")) x = start.x + (start.w - nw) / 2;
      w = nw;
    }
  }
  return { x, y, w, h: hh };
}

const nextFrame = () => new Promise<void>((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

async function loadImage(url: string): Promise<HTMLImageElement> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw Object.assign(new Error(j?.error ?? `The full-size photo answered ${res.status}.`), { status: res.status });
  }
  const blob = await res.blob();
  const obj = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = obj;
    await img.decode();
    return img;
  } finally {
    // Kept until drawn: the caller revokes nothing, the image holds its own decoded copy.
    setTimeout(() => URL.revokeObjectURL(obj), 60_000);
  }
}

/**
 * The full-size render in the browser (straighten.ts renderRows, in slices so
 * the page keeps breathing), as a top-quality JPEG. Throws "too-big" when the
 * device cannot hold the picture.
 */
async function renderInBrowser(img: HTMLImageElement, p: StraightenParams, onPct: (n: number) => void): Promise<{ blob: Blob; width: number; height: number; baseWidth: number; baseHeight: number }> {
  const W = img.naturalWidth, H = img.naturalHeight;
  const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent + (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent) ? " iPad" : ""));
  const size = outputSize(W, H, p.crop);
  if (ios && (W * H > MAX_SAFE_CANVAS || size.width * size.height > MAX_SAFE_CANVAS)) throw new Error("too-big");
  const src = document.createElement("canvas");
  src.width = W;
  src.height = H;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("too-big");
  sctx.drawImage(img, 0, 0);
  const sdata = sctx.getImageData(0, 0, W, H);
  // A canvas past the device's limit draws nothing: the centre must be a real pixel.
  if (sdata.data[((H >> 1) * W + (W >> 1)) * 4 + 3] !== 255) throw new Error("too-big");
  const out = document.createElement("canvas");
  out.width = size.width;
  out.height = size.height;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("too-big");
  const odata = octx.createImageData(size.width, size.height);
  const s = { data: sdata.data, width: W, height: H, channels: 4 as const };
  const o = { data: odata.data, width: size.width, height: size.height, channels: 4 as const };
  const step = Math.max(32, Math.floor(2_000_000 / size.width));
  for (let y = 0; y < size.height; y += step) {
    renderRows(s, o, p, y, Math.min(size.height, y + step));
    onPct(Math.round((100 * Math.min(size.height, y + step)) / size.height));
    await nextFrame();
  }
  octx.putImageData(odata, 0, 0);
  src.width = 0;
  src.height = 0;
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/jpeg", 0.93));
  out.width = 0;
  out.height = 0;
  if (!blob || blob.size < 1024) throw new Error("too-big");
  return { blob, width: size.width, height: size.height, baseWidth: W, baseHeight: H };
}

export default function PhotoEditor({ photoId, onClose }: { photoId: string; onClose: () => void }) {
  const { jobId, photoById, findingsByPhoto, notify } = useJob();
  const photo = photoById.get(photoId) ?? null;
  const start = useMemo(() => cleanParams(photo?.hubEdit?.params ?? { rotate: 0, keystone: 0, crop: FULL_CROP, aspect: "original" }), [photo?.hubEdit?.params]);
  const [rotate, setRotate] = useState(start.rotate);
  const [keystone, setKeystone] = useState(start.keystone);
  const [aspect, setAspect] = useState<AspectKey>(start.aspect);
  const [crop, setCrop] = useState<CropRect>(start.crop);
  const [manualCrop, setManualCrop] = useState(!!photo?.hubEdit);
  const [before, setBefore] = useState(false);
  const [grid, setGrid] = useState(true);
  const [busy, setBusy] = useState<{ label: string; pct?: number } | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "muted"; text: string } | null>(null);
  const [nat, setNat] = useState<{ W: number; H: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ h: Handle; x: number; y: number; crop: CropRect } | null>(null);

  // The geometry findings a save can mark fixed, ticked by default when the edit speaks to them.
  const geometry = useMemo(() => (findingsByPhoto.get(photoId) ?? []).filter((f) => f.photoId === photoId && f.status === "OPEN" && editCanSettle(f.ruleId)), [findingsByPhoto, photoId]);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const params: StraightenParams = useMemo(() => cleanParams({ rotate, keystone, crop, aspect }), [rotate, keystone, crop, aspect]);
  const isTicked = (f: FindingView) => ticked[f.id] ?? settledByDefault(f.ruleId, params);

  // The stage's size: the picture fitted inside it, same shape.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !nat) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / nat.W, r.height / nat.H);
      setBox({ w: Math.max(1, Math.floor(nat.W * s)), h: Math.max(1, Math.floor(nat.H * s)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nat]);

  // The crop follows the turn and keystone: automatic until a person drags it, then kept while it still fits.
  const applyGeometry = useCallback((r: number, k: number, a: AspectKey, manual: boolean) => {
    if (!nat) return;
    setCrop((c) => (manual ? fitCrop(r, k, nat.W, nat.H, c, a) : autoCrop(r, k, nat.W, nat.H, a)));
  }, [nat]);
  const setTurn = (v: number) => {
    const r = round1(clampN(v, -ROTATE_LIMIT, ROTATE_LIMIT));
    setRotate(r);
    applyGeometry(r, keystone, aspect, manualCrop);
  };
  const setKey = (v: number) => {
    const k = Math.round(clampN(v, -KEYSTONE_LIMIT, KEYSTONE_LIMIT));
    setKeystone(k);
    applyGeometry(rotate, k, aspect, manualCrop);
  };
  const pickAspect = (a: AspectKey) => {
    setAspect(a);
    setManualCrop(false);
    applyGeometry(rotate, keystone, a, false);
  };
  const reset = () => {
    setRotate(0);
    setKeystone(0);
    setAspect("original");
    setManualCrop(false);
    setCrop({ ...FULL_CROP });
    setTicked({});
    setNote(null);
  };

  // The preview's size is known: a crop saved by an earlier session that no longer fits (it always should) is fitted.
  const onPreview = (W: number, H: number) => {
    setNat({ W, H });
    if (!cropFits(start.rotate, start.keystone, W, H, start.crop)) setCrop(fitCrop(start.rotate, start.keystone, W, H, start.crop, start.aspect));
  };

  const onKey = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (busy) return;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") {
      // A slider moves itself; the lightbox behind must not change photo.
      if (e.key.startsWith("Arrow")) e.stopPropagation();
      return;
    }
    const big = e.shiftKey;
    let used = true;
    if (e.key === "ArrowLeft") setTurn(rotate - (big ? 1 : 0.1));
    else if (e.key === "ArrowRight") setTurn(rotate + (big ? 1 : 0.1));
    else if (e.key === "ArrowUp") setKey(keystone + (big ? 10 : 1));
    else if (e.key === "ArrowDown") setKey(keystone - (big ? 10 : 1));
    else if (e.key === "b" || e.key === "B") setBefore((v) => !v);
    else if (e.key === "g" || e.key === "G") setGrid((v) => !v);
    else used = false;
    if (used) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (busy || before) return;
    const h = (e.currentTarget.dataset.handle ?? "move") as Handle;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { h, x: e.clientX, y: e.clientY, crop };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || !box || !nat) return;
    const next = dragCrop(d.crop, d.h, (e.clientX - d.x) / box.w, (e.clientY - d.y) / box.h, aspectRatio(aspect, nat.W, nat.H), nat.W, nat.H);
    // Never past the picture: a move that would show an empty corner is not taken.
    if (next.w > 0.04 && next.h > 0.04 && cropFits(rotate, keystone, nat.W, nat.H, next)) {
      setCrop(next);
      if (!manualCrop) setManualCrop(true);
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const measure = async () => {
    setBusy({ label: "Measuring the lines…" });
    setNote(null);
    try {
      const r = await measureStraightenAction(jobId, photoId);
      if (r.ok) {
        setRotate(r.rotate);
        setKeystone(r.keystone);
        applyGeometry(r.rotate, r.keystone, aspect, false);
        setManualCrop(false);
      }
      setNote({ tone: r.ok ? "ok" : "err", text: r.ok ? `${r.message} A starting point: check it on the grid.` : r.message });
    } catch {
      setNote({ tone: "err", text: "The hub didn't answer. Try again." });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!photo) return;
    const p = params;
    const fixFindingIds = geometry.filter((f) => isTicked(f)).map((f) => f.id);
    const baseHash = photo.contentHash;
    setNote(null);
    let result: { ok: boolean; message: string } | null = null;
    try {
      setBusy({ label: "Loading the full-size photo…" });
      let rendered: Awaited<ReturnType<typeof renderInBrowser>> | null = null;
      try {
        const img = await loadImage(`/api/photo-delivery/edit-source/${encodeURIComponent(photoId)}?size=full&v=${encodeURIComponent(photo.contentHash ?? "")}`);
        setBusy({ label: "Straightening at full size…", pct: 0 });
        rendered = await renderInBrowser(img, p, (pct) => setBusy({ label: "Straightening at full size…", pct }));
      } catch (e) {
        // Refused (not allowed, gone): say so. Anything else (too big to send or to hold here): the server renders it with the same math.
        const status = (e as { status?: number }).status;
        if (status && status < 500 && status !== 413) throw e;
        rendered = null;
      }
      if (rendered) {
        setBusy({ label: "Uploading the edited photo…", pct: 0 });
        const { upload } = await import("@vercel/blob/client");
        const up = await upload(`photo-edits/${jobId}/${photoId}/edit.jpg`, rendered.blob, {
          access: "private",
          handleUploadUrl: "/api/photo-delivery/edit-upload",
          clientPayload: JSON.stringify({ jobId, photoId }),
          contentType: "image/jpeg",
          multipart: rendered.blob.size > 8 * 1024 * 1024,
          onUploadProgress: ({ percentage }) => setBusy({ label: "Uploading the edited photo…", pct: Math.round(percentage) }),
        });
        setBusy({ label: "Saving the new version…" });
        result = await saveStraightenAction({ jobId, photoId, baseHash, baseSize: { width: rendered.baseWidth, height: rendered.baseHeight }, params: p, fixFindingIds, stored: { pathname: up.pathname } });
      } else {
        setBusy({ label: "This device can't hold the full photo: the hub is straightening it…" });
        result = await renderStraightenOnServerAction({ jobId, photoId, baseHash, params: p, fixFindingIds });
      }
    } catch (e) {
      result = { ok: false, message: e instanceof Error && e.message ? e.message : "The save didn't go through. Try again." };
    } finally {
      setBusy(null);
    }
    if (result.ok) {
      notify("ok", result.message);
      onClose();
    } else {
      setNote({ tone: "err", text: result.message });
    }
  };

  if (!photo) return null;
  const preview = `/api/photo-delivery/edit-source/${encodeURIComponent(photoId)}?size=preview&v=${encodeURIComponent(photo.contentHash ?? "")}`;
  const identity = rotate === 0 && keystone === 0 && crop.x <= 1e-6 && crop.y <= 1e-6 && crop.w >= 1 - 1e-6 && crop.h >= 1 - 1e-6;
  const out = nat ? outputSize(nat.W, nat.H, crop) : null;
  const transform = box && !before ? cssMatrix3d(rotate, keystone, box.w, box.h) : "none";
  const cropPx = box ? { left: crop.x * box.w, top: crop.y * box.h, width: crop.w * box.w, height: crop.h * box.h } : null;

  return (
    <ModalDialog label={`Straighten and crop ${photoTitle(photo)}`} onCancel={onClose} busy={!!busy} className="h-[100dvh] max-h-[100dvh] w-screen max-w-none rounded-none p-0 sm:h-[96dvh] sm:max-h-[96dvh] sm:w-[min(98vw,96rem)] sm:rounded-2xl sm:p-0">
      <div className="flex h-full flex-col lg:flex-row" onKeyDown={onKey}>
        <div className="relative flex min-h-0 flex-1 flex-col bg-black">
          <div className="flex items-center gap-2 px-3 py-2 text-white">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
              Straighten and crop · {photoTitle(photo)} <span className="font-normal text-white/70">· {photo.roomLabel}</span>
            </h2>
            <button type="button" onClick={onClose} disabled={!!busy} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-white/10 disabled:opacity-40">
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <div ref={stageRef} className="relative flex min-h-[38dvh] flex-1 touch-none items-center justify-center overflow-hidden p-2 sm:p-4" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a staff-only route, transformed live */}
            <img
              src={preview}
              alt=""
              className="pointer-events-none absolute opacity-0"
              onLoad={(e) => onPreview(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
              onError={() => setNote({ tone: "err", text: "The photo could not be opened for editing. Close and try again." })}
            />
            {!nat && <Loader2 aria-label="Loading the photo" className="size-8 animate-spin text-white/70" />}
            {nat && box && (
              <div className="relative overflow-hidden" style={{ width: box.w, height: box.h }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- the same preview, drawn through the transform */}
                <img src={preview} alt={`${photoTitle(photo)} ${before ? "before" : "after"}`} draggable={false} className="absolute left-0 top-0 max-w-none select-none" style={{ width: box.w, height: box.h, transformOrigin: "0 0", transform }} />
                {!before && cropPx && (
                  <>
                    <div className="pointer-events-none absolute" style={{ ...cropPx, boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)" }} />
                    {grid && (
                      <svg className="pointer-events-none absolute left-0 top-0" width={box.w} height={box.h} aria-hidden>
                        {Array.from({ length: 11 }, (_, i) => (i * box.w) / 12 + box.w / 12).map((x) => (
                          <line key={`v${x}`} x1={x} x2={x} y1={0} y2={box.h} stroke="white" strokeOpacity={0.35} strokeWidth={1} />
                        ))}
                        {Array.from({ length: 7 }, (_, i) => (i * box.h) / 8 + box.h / 8).map((y) => (
                          <line key={`h${y}`} x1={0} x2={box.w} y1={y} y2={y} stroke="white" strokeOpacity={0.35} strokeWidth={1} />
                        ))}
                      </svg>
                    )}
                    <div
                      role="presentation"
                      className="absolute cursor-move border border-white/90"
                      style={cropPx}
                      data-handle="move"
                      onPointerDown={onPointerDown}
                    />
                    {HANDLES.map((hd) => (
                      <button
                        key={hd.h}
                        type="button"
                        tabIndex={-1}
                        aria-label={`Crop handle ${hd.h}`}
                        data-handle={hd.h}
                        onPointerDown={onPointerDown}
                        className="absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                        style={{ left: cropPx.left + hd.x * cropPx.width, top: cropPx.top + hd.y * cropPx.height, cursor: hd.cursor }}
                      >
                        <span className="block size-3.5 rounded-sm border border-black/50 bg-white shadow" />
                      </button>
                    ))}
                  </>
                )}
                {before && <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[12px] font-semibold text-white">Before</span>}
              </div>
            )}
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border p-4 lg:w-[24rem] lg:border-l lg:border-t-0">
          <div className="flex flex-wrap gap-2">
            <button type="button" className={cn(btn, "border-brand/50 bg-brand-soft")} disabled={!!busy || !nat} onClick={() => void measure()} title="Measure the lines in the photo and set the turn and keystone from them (free)">
              <Wand2 aria-hidden className="size-4" /> Auto
            </button>
            <button type="button" className={btn} aria-pressed={before} disabled={!!busy} onClick={() => setBefore((v) => !v)}>
              <Columns2 aria-hidden className="size-4" /> {before ? "Show after" : "Show before"}
            </button>
            <button type="button" className={btn} aria-pressed={grid} disabled={!!busy} onClick={() => setGrid((v) => !v)}>
              <Grid3x3 aria-hidden className="size-4" /> Grid {grid ? "on" : "off"}
            </button>
            <button type="button" className={btn} disabled={!!busy} onClick={reset}>
              <Undo2 aria-hidden className="size-4" /> Reset
            </button>
          </div>

          <Slider label="Straighten" value={rotate} min={-ROTATE_LIMIT} max={ROTATE_LIMIT} step={0.1} shown={`${rotate > 0 ? "+" : ""}${rotate.toFixed(1)}°`} hint="Turns the picture. Positive turns it clockwise." disabled={!!busy} onChange={setTurn} />
          <Slider label="Vertical perspective" value={keystone} min={-KEYSTONE_LIMIT} max={KEYSTONE_LIMIT} step={1} shown={`${keystone > 0 ? "+" : ""}${keystone}`} hint="Makes walls that lean in parallel. Positive for walls that lean in toward the top (camera pointed up)." disabled={!!busy} onChange={setKey} nudge={1} />

          <section>
            <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">
              <Crop aria-hidden className="size-3.5" /> Crop
            </h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Crop shape">
              {ASPECTS.map((a) => (
                <button key={a.key} type="button" role="radio" aria-checked={aspect === a.key} disabled={!!busy} onClick={() => pickAspect(a.key)} className={cn(btn, aspect === a.key && "border-brand bg-brand-soft")}>
                  {a.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[12px] text-muted">
              Drag the corners or the box. The crop always leaves out the empty corners a turn makes. The saved photo keeps the original&apos;s size on its long side (a very tight crop keeps its own pixels)
              {out && (out.width !== nat?.W || out.height !== nat?.H) ? `, in a ${(out.width / out.height).toFixed(2)} to 1 shape` : ""}.
            </p>
          </section>

          {geometry.length > 0 && (
            <section>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Mark fixed when saved</h3>
              <ul className="mt-1.5 space-y-1.5">
                {geometry.map((f) => (
                  <li key={f.id}>
                    <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-border p-2 text-[13px]">
                      <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={isTicked(f)} disabled={!!busy} onChange={(e) => setTicked((t) => ({ ...t, [f.id]: e.target.checked }))} />
                      <span>
                        <span className="font-medium">{f.ruleLabel || f.ruleId}</span>
                        <span className="block text-muted">{f.specificIssue}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {note && <p role="status" className={cn("rounded-lg px-3 py-2 text-[13px]", note.tone === "err" ? "bg-danger/10 text-danger" : note.tone === "ok" ? "bg-success/10 text-success" : "bg-surface-2 text-muted")}>{note.text}</p>}
          {busy && (
            <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 aria-hidden className="size-4 animate-spin" /> {busy.label}
              {busy.pct != null ? ` ${busy.pct}%` : ""}
            </p>
          )}

          <div className="mt-auto flex flex-wrap gap-2">
            <button type="button" className={cn(btn, "flex-1 border-transparent bg-brand-action font-semibold text-brand-fg hover:brightness-95")} disabled={!!busy || !nat || (identity && !photo.hubEdit)} onClick={() => void save()}>
              Save as the current version
            </button>
            <button type="button" className={btn} disabled={!!busy} onClick={onClose}>
              Cancel
            </button>
          </div>
          <p className="text-[12px] text-muted">
            Keys: ← → turn 0.1° (Shift 1°), ↑ ↓ perspective (Shift 10), B before and after, G grid. Earlier versions stay under Versions, with Restore. AutoHDR does not get this edit: an AI re-edit later starts from AutoHDR&apos;s copy.
          </p>
        </aside>
      </div>
    </ModalDialog>
  );
}

function Slider({ label, value, min, max, step, shown, hint, disabled, onChange, nudge }: { label: string; value: number; min: number; max: number; step: number; shown: string; hint: string; disabled: boolean; onChange: (v: number) => void; nudge?: number }) {
  const n = nudge ?? step;
  return (
    <section>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{label}</h3>
        <span className="font-mono text-sm tabular-nums">{shown}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button type="button" className={btn} disabled={disabled || value <= min} onClick={() => onChange(value - n)} aria-label={`${label}: less`}>
          <Minus aria-hidden className="size-4" />
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => onChange(0)}
          aria-label={label}
          aria-valuetext={shown}
          className="h-11 min-w-0 flex-1 cursor-pointer accent-[var(--color-brand,#2563eb)]"
        />
        <button type="button" className={btn} disabled={disabled || value >= max} onClick={() => onChange(value + n)} aria-label={`${label}: more`}>
          <Plus aria-hidden className="size-4" />
        </button>
      </div>
      <p className="mt-0.5 text-[12px] text-muted">{hint} Double-click the slider for zero.</p>
    </section>
  );
}
