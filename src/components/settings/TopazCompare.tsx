"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Columns2, Pause, Play, SplitSquareHorizontal, Volume2 } from "lucide-react";
import { applyTopazTestSettingsAction } from "@/app/settings/topazTestActions";
// Type-only: lib/topazTests is server-only.
import type { TopazTestView } from "@/lib/topazTests";
import { etDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE COMPARE PAGE for one "Try these settings" test (Jordan, Oct 22 2026).
//
// Two ways to look, both on the SAME two <video> elements so they can never
// drift apart: side by side (two synced players), and a wipe (the two
// stacked, Topaz clipped to the right of a handle you drag). One set of
// controls drives both: play, pause, a scrubber and one-frame steps, which is
// how a crunchy hedge or a waxy face is found and held still. The two layouts
// share one DOM shape, so switching keeps the time.
//
// NO ZOOM ON VIDEO (Jordan, Oct 22 2026: "I don't want to zoom in on video,
// just photos."). A 2x zoom box was built and taken out the same day; do not
// add one back here.
//
// The Topaz file streams from Topaz's own storage (they keep it 7 days); the
// original streams through the hub's cut route.
// ---------------------------------------------------------------------------

const CODEC: Record<string, string> = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC", mp4a: "AAC", apcn: "ProRes", apch: "ProRes", vp09: "VP9", av01: "AV1" };
const codecName = (c: string | null | undefined) => (c ? CODEC[c] ?? c : "unknown");
const pct = (v: number) => Math.round(v * 100);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 10))}`;

export function TopazCompare({ view, topazUrl, originalUrl }: { view: TopazTestView; topazUrl: string | null; originalUrl: string }) {
  const origRef = useRef<HTMLVideoElement>(null);
  const topRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"side" | "wipe">("side");
  const [wipe, setWipe] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(view.source.durationSec || 0);
  const [hear, setHear] = useState<"original" | "topaz">("original");
  const [topazError, setTopazError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  const fps = view.source.frameRate > 0 ? view.source.frameRate : 30;
  const aspect = view.source.width > 0 && view.source.height > 0 ? view.source.width / view.source.height : 16 / 9;

  // ---- keep the follower on the leader's frame ------------------------------
  const follow = useCallback((force = false) => {
    const a = origRef.current;
    const b = topRef.current;
    if (!a || !b) return;
    if (force || Math.abs(b.currentTime - a.currentTime) > 0.12) {
      try { b.currentTime = a.currentTime; } catch { /* not loaded yet */ }
    }
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = origRef.current;
      if (a) setT(a.currentTime);
      follow();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, follow]);

  useEffect(() => {
    const a = origRef.current;
    const b = topRef.current;
    if (a) a.muted = hear !== "original";
    if (b) b.muted = hear !== "topaz";
  }, [hear]);

  // ---- one set of controls for both ------------------------------------------
  const playPause = () => {
    const a = origRef.current;
    const b = topRef.current;
    if (!a) return;
    if (a.paused) {
      follow(true);
      void a.play().catch(() => {});
      void b?.play().catch(() => {});
      setPlaying(true);
    } else {
      a.pause();
      b?.pause();
      follow(true);
      setPlaying(false);
    }
  };
  const seek = (to: number) => {
    const a = origRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(dur || a.duration || 0, to));
    follow(true);
    setT(a.currentTime);
  };
  const step = (frames: number) => {
    const a = origRef.current;
    if (!a) return;
    a.pause();
    topRef.current?.pause();
    setPlaying(false);
    seek(a.currentTime + frames / fps);
  };

  // ---- pointer: drag the wipe -------------------------------------------------
  const aim = (e: React.PointerEvent<HTMLElement>, force = false) => {
    if (mode !== "wipe" || (!dragging && !force) || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setWipe(Math.round(nx * 1000) / 10);
  };

  const applySettings = () =>
    start(async () => {
      const r = await applyTopazTestSettingsAction(view.id).catch(() => ({ ok: false, message: "Couldn't save just now. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
    });

  const frameBox = (which: "original" | "topaz") =>
    cn(
      "overflow-hidden bg-black",
      mode === "side" ? "relative rounded-lg" : "absolute inset-0",
      mode === "wipe" && which === "topaz" && "pointer-events-none",
    );

  const p = view.settings.params;
  const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50";

  return (
    <div className="space-y-4">
      {!topazUrl && (
        <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {view.expired
            ? "Topaz has deleted its copy of this test (it keeps finished files for 7 days). The settings and the numbers below are still on record. Run the test again to see it."
            : view.state === "done"
              ? "Topaz didn't hand over a link to its copy just now. Reload the page to try again."
              : `This test isn't finished yet: ${view.says}`}
        </p>
      )}

      {/* ---- the players ------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setMode("side")} aria-pressed={mode === "side"} className={cn(btn, mode === "side" && "border-brand bg-brand/10")}>
          <Columns2 className="size-4" /> Side by side
        </button>
        <button type="button" onClick={() => setMode("wipe")} aria-pressed={mode === "wipe"} className={cn(btn, mode === "wipe" && "border-brand bg-brand/10")}>
          <SplitSquareHorizontal className="size-4" /> Wipe
        </button>
      </div>

      <div
        ref={stageRef}
        data-compare-stage
        className={cn(mode === "side" ? "grid gap-2 sm:grid-cols-2" : "relative mx-auto touch-none select-none")}
        style={mode === "wipe" ? { aspectRatio: `${aspect}`, width: "100%", maxWidth: `calc(70vh * ${aspect})` } : undefined}
        onPointerDown={(e) => {
          if (mode === "wipe") { setDragging(true); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
          aim(e, true);
        }}
        onPointerMove={(e) => aim(e)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        <figure className={frameBox("original")} style={mode === "side" ? { aspectRatio: `${aspect}` } : undefined}>
          <video
            ref={origRef}
            src={originalUrl}
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => { if (e.currentTarget.duration) setDur(e.currentTarget.duration); }}
            onSeeked={() => follow(true)}
            onEnded={() => { setPlaying(false); topRef.current?.pause(); }}
            className="block h-full w-full object-contain"
          />
          <figcaption className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">Original</figcaption>
        </figure>
        <figure
          className={frameBox("topaz")}
          style={mode === "side" ? { aspectRatio: `${aspect}` } : { clipPath: `inset(0 0 0 ${wipe}%)` }}
        >
          {topazUrl ? (
            <video
              ref={topRef}
              src={topazUrl}
              playsInline
              preload="auto"
              muted
              onError={() => setTopazError("Topaz's copy couldn't be loaded. It keeps finished files for 7 days; after that, run the test again.")}
              className="block h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-white/70">No Topaz version to show.</div>
          )}
          <figcaption className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">Topaz</figcaption>
        </figure>
        {mode === "wipe" && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/90 shadow" style={{ left: `${wipe}%` }}>
            <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-bold text-black">⇆</span>
          </div>
        )}
      </div>
      {topazError && <p role="alert" className="text-sm text-warning">{topazError}</p>}

      {mode === "wipe" && (
        <label className="flex items-center gap-2 text-[13px] text-muted">
          Wipe
          <input type="range" min={0} max={100} step={0.5} value={wipe} onChange={(e) => setWipe(Number(e.target.value))} aria-label="Wipe position" className="w-full accent-[var(--brand)]" />
        </label>
      )}

      {/* ---- one set of controls ------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={playPause} className={btn} aria-label={playing ? "Pause both" : "Play both"}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />} {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => step(-1)} className={btn} aria-label="Back one frame"><ChevronLeft className="size-4" /> Frame</button>
        <button type="button" onClick={() => step(1)} className={btn} aria-label="Forward one frame">Frame <ChevronRight className="size-4" /></button>
        <span className="text-sm tabular-nums text-muted">{clock(t)} / {clock(dur)}</span>
        <button type="button" onClick={() => setHear((h) => (h === "original" ? "topaz" : "original"))} className={btn}>
          <Volume2 className="size-4" /> Sound: {hear === "original" ? "original" : "Topaz"}
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={dur || 1}
        step={1 / fps}
        value={t}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Position in the video"
        className="w-full accent-[var(--brand)]"
      />

      {/* ---- what was tested, and what it cost ------------------------------ */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-3 text-[13px]">
          <p className="font-semibold">The two files</p>
          <p className="mt-1 text-muted">
            Original: {view.source.width}x{view.source.height}, {codecName(view.source.codec)}
            {view.source.mbit != null ? `, ${view.source.mbit} Mbit` : ""}, sound {view.source.hasAudio ? codecName(view.source.audioCodec) : "none"}.
          </p>
          <p className="text-muted">
            Topaz:{" "}
            {view.output
              ? `${view.output.width}x${view.output.height}, ${codecName(view.output.codec)}${view.output.mbit != null ? `, ${view.output.mbit} Mbit` : ""}, sound ${view.output.hasAudio ? codecName(view.output.audioCodec) : "none"}.`
              : "its header couldn't be read."}
          </p>
          <p className="mt-1 text-muted">
            Cost: {view.creditsCharged != null ? `${Math.round(view.creditsCharged)} credits` : view.estimateCredits != null ? `about ${Math.round(view.estimateCredits)} credits` : "unknown"}.
            {view.finishedAtISO ? ` Finished ${etDateTime(new Date(view.finishedAtISO))} ET.` : ""}
            {view.expiresAtISO ? ` Topaz keeps its copy until ${etDateTime(new Date(view.expiresAtISO))} ET.` : ""}
          </p>
          <p className="mt-1 text-[12px] text-muted-2">{view.wholeVideoNote}</p>
        </div>
        <div className="rounded-lg border border-border p-3 text-[13px]">
          <p className="font-semibold">The settings this test used</p>
          <p className="mt-1 text-muted">
            Mode: {p.auto === "Auto" ? "Auto (Topaz picks its own amounts; the sliders were not used)" : p.auto}.
          </p>
          <p className="text-muted">
            Fix compression {pct(p.compression)} · Improve detail {pct(p.details)} · Sharpen {pct(p.blur)} · Reduce noise {pct(p.noise)} ·
            Dehalo {pct(p.halo)} · Anti-alias/deblur {pct(p.preblur)} · Recover detail {pct(p.recover_original_detail_value)}
          </p>
          <p className="text-muted">
            File: {view.settings.videoEncoder} {view.settings.videoProfile}, {view.settings.videoBitrate || `compression ${view.settings.dynamicCompressionLevel}`}, {view.settings.outputShortSide}p, sound {view.settings.audioCodec} ({view.settings.audioTransfer}).
          </p>
          <button type="button" onClick={applySettings} disabled={busy} className="mt-2 inline-flex min-h-11 items-center rounded-lg bg-brand-action px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
            Use these settings for every video
          </button>
          {msg && <p role={msg.ok ? "status" : "alert"} className={cn("mt-1", msg.ok ? "text-muted" : "text-warning")}>{msg.text}</p>}
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer py-2 text-[12px] font-medium text-muted">The exact request sent to Topaz</summary>
            <pre className="max-h-64 overflow-auto rounded bg-surface-2 p-2 text-[11px] leading-snug">{(() => { try { return JSON.stringify(JSON.parse(view.presetJson), null, 2); } catch { return view.presetJson; } })()}</pre>
          </details>
        </div>
      </div>
    </div>
  );
}
