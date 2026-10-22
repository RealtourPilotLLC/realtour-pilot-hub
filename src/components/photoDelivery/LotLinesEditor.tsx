"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { LandPlot, Loader2, Maximize, Minus, Plus, Redo2, Trash2, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { loadLotLinesAction, saveLotLinesAction } from "@/app/ops/photo-delivery/fileActions";
import {
  COLOR_PRESETS, DEFAULT_LABEL_TEXT, FILL_OPACITY_MAX, FILL_OPACITY_MIN, LABEL_SIZE_MAX, LABEL_SIZE_MIN, MAX_LABEL_CHARS, MAX_POINTS, WIDTH_MAX, WIDTH_MIN,
  cleanDrawing, dashOf, defaultDrawing, drawingProblem, glowPx, labelPlacement, labelSvgPath, strokePx,
  type LotDrawing, type LotPoint,
} from "@/lib/photoDelivery/lotLines";
import { photoTitle, useJob } from "./JobContext";

// ---------------------------------------------------------------------------
// LOT LINES (Oct 22 2026). Jordan: "Let's add a lot lines adder tool to the
// photos section so we can add lot lines."
//
// Opened from a photo's lightbox (Lot lines, next to Straighten and crop).
// Kyle clicks around the property to place the boundary's corners; drags a
// point to move it; clicks on the line to add a point there; Delete removes
// the selected point; undo and redo; zoom in (the wheel, or + and -) and
// drag the picture to place points exactly. The style (colour, width, dashed,
// a soft shadow that reads on grass and roofs, a light fill) and an optional
// label ("Approximate property lines") show live, from the same numbers the
// save paints (lotLines.ts). Save paints them into the FULL-SIZE photo on the
// server and makes that the photo's current version, "Lot lines by Kyle"
// (hubFiles.ts saveLotLines); the photo before stays under Versions, with
// Restore, and the drawing is kept so this reopens on it. Free: no AutoHDR.
// Keys: Delete removes the selected point, Ctrl or Cmd Z undo (Shift redo),
// arrows nudge the selected point (Shift: more), + and - zoom, 0 fits.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const stageBtn = "inline-flex size-11 items-center justify-center rounded-lg bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-40";
const ZOOM_MAX = 10;
const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

type Hist = { past: LotDrawing[]; now: LotDrawing; future: LotDrawing[] };
type Drag =
  | { kind: "point"; index: number }
  | { kind: "label"; dx: number; dy: number }
  | { kind: "bg"; x: number; y: number; panX: number; panY: number; moved: boolean };

export default function LotLinesEditor({ photoId, onClose }: { photoId: string; onClose: () => void }) {
  const { jobId, photoById, notify } = useJob();
  const photo = photoById.get(photoId) ?? null;
  const [loaded, setLoaded] = useState<{ previewUrl: string | null; baseHash: string | null; current: boolean; earlier: boolean; error: string | null } | null>(null);
  const [hist, setHist] = useState<Hist>(() => ({ past: [], now: defaultDrawing(), future: [] }));
  const d = hist.now;
  const [selected, setSelected] = useState<number | null>(null);
  const [nat, setNat] = useState<{ W: number; H: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number; sw: number; sh: number } | null>(null);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "muted"; text: string } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const picRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  // What to draw on, and the drawing to start from (this photo's lot lines, if any).
  useEffect(() => {
    let alive = true;
    loadLotLinesAction(jobId, photoId)
      .then((r) => {
        if (!alive) return;
        if (r.drawing) setHist({ past: [], now: cleanDrawing(r.drawing), future: [] });
        setLoaded({ previewUrl: r.previewUrl, baseHash: r.baseHash, current: r.current, earlier: !!r.drawing && !r.current, error: r.ok ? (r.previewUrl ? null : "This photo has no file the hub can read yet.") : r.message });
      })
      .catch(() => alive && setLoaded({ previewUrl: null, baseHash: null, current: false, earlier: false, error: "The hub didn't answer. Close and try again." }));
    return () => {
      alive = false;
    };
  }, [jobId, photoId]);

  // The picture fitted inside the stage (zoom 1), same shape.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !nat) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 16) / nat.W, (r.height - 16) / nat.H);
      setBox({ w: Math.max(1, Math.floor(nat.W * s)), h: Math.max(1, Math.floor(nat.H * s)), sw: r.width, sh: r.height });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nat]);

  const commit = useCallback((next: LotDrawing) => setHist((h) => ({ past: [...h.past, h.now].slice(-200), now: next, future: [] })), []);
  /** A change in the middle of a drag: the drag's start is already in the history. */
  const live = useCallback((next: LotDrawing) => setHist((h) => ({ ...h, now: next })), []);
  const snapshot = useCallback(() => setHist((h) => ({ past: [...h.past, h.now].slice(-200), now: h.now, future: [] })), []);
  const undo = useCallback(() => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future] } : h)), []);
  const redo = useCallback(() => setHist((h) => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h)), []);
  const setStyle = (patch: Partial<LotDrawing["style"]>) => commit({ ...d, style: { ...d.style, ...patch } });
  const setLabel = (patch: Partial<LotDrawing["label"]>) => commit({ ...d, label: { ...d.label, ...patch } });
  /** A slider or the colour picker: one undo step per drag (the start is kept when it begins). */
  const slideStyle = (patch: Partial<LotDrawing["style"]>) => live({ ...d, style: { ...d.style, ...patch } });
  const slideLabel = (patch: Partial<LotDrawing["label"]>) => live({ ...d, label: { ...d.label, ...patch } });
  const removePoint = (i: number | null) => {
    if (i == null || i < 0 || i >= d.points.length) return;
    commit({ ...d, points: d.points.filter((_, k) => k !== i) });
    setSelected(d.points.length > 1 ? Math.min(i, d.points.length - 2) : null);
  };

  // ---- the stage's geometry ----------------------------------------------------------------
  const W = nat?.W ?? 1, H = nat?.H ?? 1;
  const shown = box ? { w: box.w * view.z, h: box.h * view.z, left: (box.sw - box.w * view.z) / 2 + view.x, top: (box.sh - box.h * view.z) / 2 + view.y } : null;
  /** Screen pixels per picture pixel (the preview's). */
  const k = shown ? shown.w / W : 1;
  const clampPan = (z: number, x: number, y: number) => {
    if (!box) return { z, x, y };
    const mx = Math.max(0, (box.w * z - box.sw) / 2) + box.w * 0.25;
    const my = Math.max(0, (box.h * z - box.sh) / 2) + box.h * 0.25;
    return { z, x: clampN(x, -mx, mx), y: clampN(y, -my, my) };
  };
  /** Zoom about a point on the screen (the cursor, or the stage's middle). */
  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const st = stageRef.current?.getBoundingClientRect();
    if (!box || !st || !shown) return;
    const z1 = clampN(view.z * factor, 1, ZOOM_MAX);
    const cx = clientX ?? st.left + st.width / 2, cy = clientY ?? st.top + st.height / 2;
    const u = (cx - (st.left + shown.left)) / shown.w, v = (cy - (st.top + shown.top)) / shown.h;
    const x = cx - st.left - (box.sw - box.w * z1) / 2 - u * box.w * z1;
    const y = cy - st.top - (box.sh - box.h * z1) / 2 - v * box.h * z1;
    setView(z1 === 1 ? { z: 1, x: 0, y: 0 } : clampPan(z1, x, y));
  };
  const rel = (clientX: number, clientY: number): LotPoint | null => {
    const r = picRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return { x: clampN((clientX - r.left) / r.width, 0, 1), y: clampN((clientY - r.top) / r.height, 0, 1) };
  };

  // ---- pointer ------------------------------------------------------------------------------
  const startDrag = (e: ReactPointerEvent<Element>, g: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    // The keys (Delete, undo, nudge) reach the editor, never the lightbox behind it.
    stageRef.current?.focus({ preventScroll: true });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = g;
  };
  const onPointDown = (e: ReactPointerEvent<SVGElement>, i: number) => {
    if (busy) return;
    setSelected(i);
    snapshot();
    startDrag(e, { kind: "point", index: i });
  };
  const onSegmentDown = (e: ReactPointerEvent<SVGElement>, after: number) => {
    if (busy || d.points.length >= MAX_POINTS) return;
    const p = rel(e.clientX, e.clientY);
    if (!p) return;
    const points = [...d.points.slice(0, after + 1), p, ...d.points.slice(after + 1)];
    commit({ ...d, points });
    setSelected(after + 1);
    startDrag(e, { kind: "point", index: after + 1 });
  };
  const onLabelDown = (e: ReactPointerEvent<SVGElement>) => {
    if (busy) return;
    const p = rel(e.clientX, e.clientY);
    const at = nat ? labelPlacement(d.label, W, H) : null;
    if (!p || !at) return;
    snapshot();
    startDrag(e, { kind: "label", dx: p.x - ((at.box.x0 + at.box.x1) / 2) / W, dy: p.y - ((at.box.y0 + at.box.y1) / 2) / H });
  };
  const onStageDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || !nat || e.button > 0) return;
    startDrag(e, { kind: "bg", x: e.clientX, y: e.clientY, panX: view.x, panY: view.y, moved: false });
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const g = drag.current;
    if (!g) return;
    if (g.kind === "point") {
      const p = rel(e.clientX, e.clientY);
      if (p) live({ ...d, points: d.points.map((q, i) => (i === g.index ? p : q)) });
    } else if (g.kind === "label") {
      const p = rel(e.clientX, e.clientY);
      if (p) live({ ...d, label: { ...d.label, x: clampN(p.x - g.dx, 0, 1), y: clampN(p.y - g.dy, 0, 1) } });
    } else {
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.moved && Math.hypot(dx, dy) > 5) g.moved = true;
      if (g.moved) setView((v) => clampPan(v.z, g.panX + dx, g.panY + dy));
    }
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const g = drag.current;
    drag.current = null;
    if (!g || g.kind !== "bg" || g.moved) return;
    // A click on the picture (not a drag): the next corner.
    if (d.points.length >= MAX_POINTS) {
      setNote({ tone: "err", text: `At most ${MAX_POINTS} points.` });
      return;
    }
    const r = picRef.current?.getBoundingClientRect();
    if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    const p = rel(e.clientX, e.clientY);
    if (!p) return;
    commit({ ...d, points: [...d.points, p] });
    setSelected(d.points.length);
  };
  const onWheel = (e: ReactWheelEvent) => {
    if (!nat || !e.deltaY) return;
    // In proportion to the scroll (a trackpad sends many small steps, a mouse wheel a few big ones).
    zoomAt(Math.exp(clampN(-e.deltaY, -240, 240) * 0.0018), e.clientX, e.clientY);
  };

  // ---- keys (the lightbox behind never sees them) -----------------------------------------
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") return;
    e.stopPropagation();
    if (busy || isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    let used = true;
    if (mod && (e.key === "z" || e.key === "Z")) (e.shiftKey ? redo : undo)();
    else if (mod && (e.key === "y" || e.key === "Y")) redo();
    else if (e.key === "Delete" || e.key === "Backspace") removePoint(selected);
    else if (e.key === "+" || e.key === "=") zoomAt(1.25);
    else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.25);
    else if (e.key === "0") setView({ z: 1, x: 0, y: 0 });
    else if (e.key.startsWith("Arrow") && selected != null && d.points[selected]) {
      // One screen pixel a press (Shift: ten), whatever the zoom.
      const step = (e.shiftKey ? 10 : 1) / Math.max(1, k);
      const q = d.points[selected];
      const p = { x: clampN(q.x + (e.key === "ArrowLeft" ? -step / W : e.key === "ArrowRight" ? step / W : 0), 0, 1), y: clampN(q.y + (e.key === "ArrowUp" ? -step / H : e.key === "ArrowDown" ? step / H : 0), 0, 1) };
      commit({ ...d, points: d.points.map((x, i) => (i === selected ? p : x)) });
    } else used = false;
    if (used) e.preventDefault();
  };

  const save = async () => {
    if (!photo || !loaded) return;
    const problem = drawingProblem(cleanDrawing(d));
    if (problem) {
      setNote({ tone: "err", text: problem });
      return;
    }
    setNote(null);
    setBusy("Drawing the lot lines on the full-size photo…");
    let r: { ok: boolean; message: string };
    try {
      r = await saveLotLinesAction({ jobId, photoId, baseHash: loaded.baseHash, drawing: cleanDrawing(d) });
    } catch {
      r = { ok: false, message: "The hub didn't answer. Try again." };
    } finally {
      setBusy(null);
    }
    if (r.ok) {
      notify("ok", r.message);
      onClose();
    } else setNote({ tone: "err", text: r.message });
  };

  // ---- what the preview draws (picture pixels: the same numbers the save paints) -------------
  const geo = useMemo(() => {
    if (!nat) return null;
    const w = strokePx(d.style, W, H);
    const glow = d.style.glow ? glowPx(w, W, H) : 0;
    const pts = d.points.map((p) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join(" ");
    const at = labelPlacement(d.label, W, H);
    return { w, glow, pts, dash: d.style.dashed ? `${dashOf(w).on} ${dashOf(w).off}` : undefined, label: at ? { d: labelSvgPath(d.label, W, H), box: at.box, em: at.em } : null };
  }, [d, nat, W, H]);

  if (!photo) return null;
  const problem = drawingProblem(cleanDrawing(d));
  const closed = d.closed && d.points.length >= 3;
  const segs: { a: LotPoint; b: LotPoint; after: number }[] = [];
  for (let i = 0; i + 1 < d.points.length; i++) segs.push({ a: d.points[i], b: d.points[i + 1], after: i });
  if (closed) segs.push({ a: d.points[d.points.length - 1], b: d.points[0], after: d.points.length - 1 });
  const custom = !COLOR_PRESETS.some((c) => c.hex === d.style.color);

  return (
    <ModalDialog label={`Lot lines on ${photoTitle(photo)}`} onCancel={onClose} busy={!!busy} className="h-[100dvh] max-h-[100dvh] w-screen max-w-none rounded-none p-0 sm:h-[96dvh] sm:max-h-[96dvh] sm:w-[min(98vw,96rem)] sm:rounded-2xl sm:p-0">
      <div className="flex h-full flex-col lg:flex-row" onKeyDown={onKey}>
        <div className="relative flex min-h-0 flex-1 flex-col bg-black">
          <div className="flex items-center gap-2 px-3 py-2 text-white">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
              Lot lines · {photoTitle(photo)} <span className="font-normal text-white/70">· {photo.roomLabel}</span>
            </h2>
            <button type="button" onClick={onClose} disabled={!!busy} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-white/10 disabled:opacity-40">
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <div
            ref={stageRef}
            tabIndex={0}
            aria-label="The photo: click to place a corner of the property"
            className={cn("relative min-h-[42dvh] flex-1 touch-none select-none overflow-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand", nat && "cursor-crosshair")}
            onPointerDown={onStageDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onWheel={onWheel}
          >
            {loaded?.previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- a staff-only route, read for its size
              <img
                src={loaded.previewUrl}
                alt=""
                className="pointer-events-none absolute opacity-0"
                onLoad={(e) => setNat({ W: e.currentTarget.naturalWidth, H: e.currentTarget.naturalHeight })}
                onError={() => setNote({ tone: "err", text: "The photo could not be opened. Close and try again." })}
              />
            )}
            {(!loaded || (loaded.previewUrl && !nat)) && !loaded?.error && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 aria-label="Loading the photo" className="size-8 animate-spin text-white/70" />
              </div>
            )}
            {loaded?.error && <p className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-sm text-white">{loaded.error}</p>}
            {nat && shown && geo && loaded?.previewUrl && (
              <div ref={picRef} className="absolute" style={{ left: shown.left, top: shown.top, width: shown.w, height: shown.h }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- the same staff-only preview, scaled */}
                <img src={loaded.previewUrl} alt={`${photoTitle(photo)}: the photo to draw on`} draggable={false} className="pointer-events-none absolute inset-0 size-full max-w-none" />
                <svg className="absolute inset-0 size-full overflow-visible" viewBox={`0 0 ${W} ${H}`} aria-hidden>
                  <defs>
                    <filter id="lot-soft" filterUnits="userSpaceOnUse" x={-W} y={-H} width={W * 3} height={H * 3}>
                      <feGaussianBlur stdDeviation={Math.max(0.5, geo.glow / 2.6)} />
                    </filter>
                    <filter id="lot-halo" filterUnits="userSpaceOnUse" x={-W} y={-H} width={W * 3} height={H * 3}>
                      <feGaussianBlur stdDeviation={Math.max(0.5, (geo.label?.em ?? 10) * 0.05)} />
                    </filter>
                  </defs>
                  {closed && d.style.fill && <polygon points={geo.pts} fill={d.style.color} fillOpacity={d.style.fillOpacity} stroke="none" />}
                  {d.points.length >= 2 && d.style.glow && (
                    <g filter="url(#lot-soft)" opacity={0.55}>
                      {closed ? (
                        <polygon points={geo.pts} fill="none" stroke="black" strokeWidth={geo.w + geo.glow} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={geo.dash} />
                      ) : (
                        <polyline points={geo.pts} fill="none" stroke="black" strokeWidth={geo.w + geo.glow} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={geo.dash} />
                      )}
                    </g>
                  )}
                  {d.points.length >= 2 &&
                    (closed ? (
                      <polygon points={geo.pts} fill="none" stroke={d.style.color} strokeWidth={geo.w} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={geo.dash} />
                    ) : (
                      <polyline points={geo.pts} fill="none" stroke={d.style.color} strokeWidth={geo.w} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={geo.dash} />
                    ))}
                  {geo.label && (
                    <>
                      {d.style.glow && <path d={geo.label.d} fill="black" stroke="black" strokeWidth={geo.label.em * 0.06} filter="url(#lot-halo)" opacity={0.6} />}
                      <path d={geo.label.d} fill={d.style.color} />
                      <rect
                        x={geo.label.box.x0}
                        y={geo.label.box.y0}
                        width={geo.label.box.x1 - geo.label.box.x0}
                        height={geo.label.box.y1 - geo.label.box.y0}
                        fill="transparent"
                        stroke="white"
                        strokeOpacity={0.5}
                        strokeDasharray={`${4 / k} ${4 / k}`}
                        strokeWidth={1 / k}
                        className="cursor-move"
                        onPointerDown={onLabelDown}
                      />
                    </>
                  )}
                  {/* Wide invisible lines: press one to add a point on it. */}
                  {segs.map((s) => (
                    <line
                      key={`seg-${s.after}`}
                      x1={s.a.x * W}
                      y1={s.a.y * H}
                      x2={s.b.x * W}
                      y2={s.b.y * H}
                      stroke="transparent"
                      strokeWidth={Math.max(geo.w, 14 / k)}
                      className="cursor-copy"
                      onPointerDown={(e) => onSegmentDown(e, s.after)}
                    />
                  ))}
                  {d.points.map((p, i) => (
                    <g key={`pt-${i}`} className="cursor-move" onPointerDown={(e) => onPointDown(e, i)}>
                      <circle cx={p.x * W} cy={p.y * H} r={16 / k} fill="transparent" />
                      <circle cx={p.x * W} cy={p.y * H} r={(i === 0 ? 8 : 6.5) / k} fill={selected === i ? "#2563eb" : "white"} stroke="black" strokeWidth={1.5 / k} />
                    </g>
                  ))}
                </svg>
              </div>
            )}
            {nat && (
              <div className="absolute bottom-2 right-2 flex gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" className={stageBtn} onClick={() => zoomAt(1 / 1.25)} disabled={view.z <= 1} aria-label="Zoom out">
                  <Minus aria-hidden className="size-5" />
                </button>
                <button type="button" className={stageBtn} onClick={() => setView({ z: 1, x: 0, y: 0 })} disabled={view.z === 1 && !view.x && !view.y} aria-label="Fit the photo">
                  <Maximize aria-hidden className="size-5" />
                </button>
                <button type="button" className={stageBtn} onClick={() => zoomAt(1.25)} disabled={view.z >= ZOOM_MAX} aria-label="Zoom in">
                  <Plus aria-hidden className="size-5" />
                </button>
              </div>
            )}
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border p-4 lg:w-[24rem] lg:border-l lg:border-t-0">
          <section>
            <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">
              <LandPlot aria-hidden className="size-3.5" /> The boundary
            </h3>
            <p className="mt-1 text-[13px]">Click each corner of the property on the photo. Drag a point to move it, or click on the line to add a point there. Zoom in for accuracy.</p>
            {loaded?.current && <p className="mt-1 text-[12px] text-muted">These are the lot lines on this photo now. Saving replaces them.</p>}
            {loaded?.earlier && <p className="mt-1 text-[12px] text-warning">These are the lot lines drawn before this photo last changed. Check they still sit right, then save to put them back.</p>}
            <p className="mt-1.5 text-[13px] font-medium tabular-nums">
              {d.points.length} point{d.points.length === 1 ? "" : "s"}
              {selected != null && d.points[selected] ? ` · point ${selected + 1} selected` : ""}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button type="button" className={btn} disabled={!!busy || !hist.past.length} onClick={undo} aria-label="Undo">
                <Undo2 aria-hidden className="size-4" /> Undo
              </button>
              <button type="button" className={btn} disabled={!!busy || !hist.future.length} onClick={redo} aria-label="Redo">
                <Redo2 aria-hidden className="size-4" /> Redo
              </button>
              <button type="button" className={btn} disabled={!!busy || selected == null || !d.points[selected]} onClick={() => removePoint(selected)}>
                <Trash2 aria-hidden className="size-4" /> Delete point
              </button>
              <button type="button" className={btn} disabled={!!busy || !d.points.length} onClick={() => { commit({ ...d, points: [] }); setSelected(null); }}>
                Clear
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Shape">
              <button type="button" role="radio" aria-checked={d.closed} disabled={!!busy} onClick={() => commit({ ...d, closed: true })} className={cn(btn, d.closed && "border-brand bg-brand-soft")}>
                Closed boundary
              </button>
              <button type="button" role="radio" aria-checked={!d.closed} disabled={!!busy} onClick={() => commit({ ...d, closed: false })} className={cn(btn, !d.closed && "border-brand bg-brand-soft")}>
                Open line
              </button>
            </div>
            <p className="mt-1 text-[12px] text-muted">An open line is for part of a boundary (one side of the lot).</p>
          </section>

          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Line</h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Colour">
              {COLOR_PRESETS.map((c) => (
                <button key={c.key} type="button" role="radio" aria-checked={d.style.color === c.hex} disabled={!!busy} onClick={() => setStyle({ color: c.hex })} className={cn(btn, d.style.color === c.hex && "border-brand bg-brand-soft")}>
                  <span aria-hidden className="size-4 rounded-full border border-black/30" style={{ background: c.hex }} /> {c.label}
                </button>
              ))}
              <label className={cn(btn, "cursor-pointer", custom && "border-brand bg-brand-soft")}>
                <input type="color" value={d.style.color} disabled={!!busy} onFocus={snapshot} onChange={(e) => slideStyle({ color: e.target.value })} className="size-5 cursor-pointer border-0 bg-transparent p-0" aria-label="Custom colour" />
                Custom
              </label>
            </div>
            <Range label="Width" value={d.style.width} min={WIDTH_MIN} max={WIDTH_MAX} step={0.5} shown={String(d.style.width)} disabled={!!busy} onBegin={snapshot} onChange={(v) => slideStyle({ width: v })} />
            <div className="mt-2 grid gap-1.5">
              <Toggle label="Dashed" checked={d.style.dashed} disabled={!!busy} onChange={(v) => setStyle({ dashed: v })} />
              <Toggle label="Soft shadow (reads on grass and roofs)" checked={d.style.glow} disabled={!!busy} onChange={(v) => setStyle({ glow: v })} />
              <Toggle label="Light fill inside" checked={d.style.fill} disabled={!!busy || !d.closed} onChange={(v) => setStyle({ fill: v })} />
            </div>
            {d.style.fill && d.closed && <Range label="Fill strength" value={d.style.fillOpacity} min={FILL_OPACITY_MIN} max={FILL_OPACITY_MAX} step={0.05} shown={`${Math.round(d.style.fillOpacity * 100)}%`} disabled={!!busy} onBegin={snapshot} onChange={(v) => slideStyle({ fillOpacity: v })} />}
          </section>

          <section>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Label</h3>
            <Toggle label="Show a label on the photo" checked={d.label.show} disabled={!!busy} onChange={(v) => setLabel({ show: v, text: d.label.text || DEFAULT_LABEL_TEXT })} />
            {d.label.show && (
              <>
                <label className="mt-2 block text-[12px] font-medium text-muted" htmlFor={`lot-label-${photoId}`}>Words</label>
                <input
                  id={`lot-label-${photoId}`}
                  value={d.label.text}
                  maxLength={MAX_LABEL_CHARS}
                  disabled={!!busy}
                  onChange={(e) => live({ ...d, label: { ...d.label, text: e.target.value.slice(0, MAX_LABEL_CHARS) } })}
                  onFocus={snapshot}
                  className="mt-1 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base sm:text-sm"
                />
                <Range label="Size" value={d.label.size} min={LABEL_SIZE_MIN} max={LABEL_SIZE_MAX} step={0.1} shown={d.label.size.toFixed(1)} disabled={!!busy} onBegin={snapshot} onChange={(v) => slideLabel({ size: v })} />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button type="button" className={btn} disabled={!!busy} onClick={() => setLabel({ x: 0.5, y: 0.07 })}>Top</button>
                  <button type="button" className={btn} disabled={!!busy} onClick={() => setLabel({ x: 0.5, y: 0.93 })}>Bottom</button>
                  <span className="text-[12px] text-muted">or drag it on the photo.</span>
                </div>
              </>
            )}
          </section>

          {note && <p role="status" className={cn("rounded-lg px-3 py-2 text-[13px]", note.tone === "err" ? "bg-danger/10 text-danger" : note.tone === "ok" ? "bg-success/10 text-success" : "bg-surface-2 text-muted")}>{note.text}</p>}
          {busy && (
            <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 aria-hidden className="size-4 animate-spin" /> {busy}
            </p>
          )}

          <div className="mt-auto flex flex-wrap gap-2">
            <button type="button" className={cn(btn, "flex-1 border-transparent bg-brand-action font-semibold text-brand-fg hover:brightness-95")} disabled={!!busy || !nat || !!problem || !loaded || !!loaded.error} onClick={() => void save()} title={problem ?? undefined}>
              Save lot lines
            </button>
            <button type="button" className={btn} disabled={!!busy} onClick={onClose}>
              Cancel
            </button>
          </div>
          <p className="text-[12px] text-muted">
            Saved as a new version of the photo, drawn at full size. The photo before stays under Versions, with Restore. Free: nothing goes to AutoHDR. Keys: Delete removes the selected point, Ctrl or Cmd Z undoes, arrows nudge a point, + and - zoom.
          </p>
        </aside>
      </div>
    </ModalDialog>
  );
}

function Range({ label, value, min, max, step, shown, disabled, onBegin, onChange }: { label: string; value: number; min: number; max: number; step: number; shown: string; disabled: boolean; onBegin: () => void; onChange: (v: number) => void }) {
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-muted">{label}</span>
        <span className="font-mono text-sm tabular-nums">{shown}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={onBegin}
        onKeyDown={onBegin}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={shown}
        className="h-11 w-full cursor-pointer accent-[var(--color-brand,#2563eb)]"
      />
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 text-[13px]", disabled && "opacity-60")}>
      <input type="checkbox" className="size-5 shrink-0" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
