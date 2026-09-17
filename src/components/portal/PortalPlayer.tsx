"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// One player for every portal video. Hub cuts stream as plain files through
// /api/review/cut/<id>/stream (Range-proxied MP4/MOV) and play natively. The
// delivered files on Aryeo are Mux HLS (stream.mux.com/<id>) — Safari plays
// HLS natively, every other browser needs hls.js, which is loaded from cdnjs
// on first use (never bundled, never before a video is opened). The old
// library grid handed Chrome a bare stream.mux.com URL and got a black box.
// ---------------------------------------------------------------------------

const HLS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.20/hls.min.js";

type HlsCtor = new (config?: Record<string, unknown>) => {
  loadSource(url: string): void;
  attachMedia(el: HTMLVideoElement): void;
  destroy(): void;
  on(event: string, cb: (evt: string, data: { fatal?: boolean; type?: string }) => void): void;
};
declare global { interface Window { Hls?: HlsCtor & { isSupported(): boolean; Events: { ERROR: string } } } }

let hlsLoading: Promise<void> | null = null;
function loadHls(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.Hls) return Promise.resolve();
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = HLS_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { hlsLoading = null; reject(new Error("hls.js failed to load")); };
      document.head.appendChild(s);
    });
  }
  return hlsLoading;
}

/** A Mux playback URL is HLS whether or not it says .m3u8. */
const isMuxUrl = (src: string) => /^https:\/\/stream\.mux\.com\//i.test(src);
const hlsUrlOf = (src: string) => (isMuxUrl(src) && !/\.m3u8(\?|$)/i.test(src) ? `${src}.m3u8` : src);
const isHls = (src: string) => isMuxUrl(src) || /\.m3u8(\?|$)/i.test(src);

/** `currentTime` is NULL until the player has a real playhead to report — no
 *  metadata, or the client has never started it. A `<video>` that failed to
 *  load still answers `currentTime === 0`, and a note saved from it was pinned
 *  to "0:00" and sent to the editor as "fix the first frame" of a video the
 *  client never watched (review blocker, Sep 17). Unknown is not zero. */
export type PortalPlayerHandle = { seek(t: number): void; pause(): void; currentTime(): number | null };

export const PortalPlayer = forwardRef<PortalPlayerHandle, { src: string; poster?: string | null; className?: string; autoPlay?: boolean; onError?: (msg: string) => void }>(
  function PortalPlayer({ src, poster, className, autoPlay = false, onError }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    // Set the first time the playhead actually moves (play, seek, or a
    // timeupdate past 0). Until then there is no "paused moment" to pin to.
    const played = useRef(false);
    const [failed, setFailed] = useState<string | null>(null);
    useImperativeHandle(ref, () => ({
      seek(t) { const v = videoRef.current; if (v) { played.current = true; v.currentTime = t; v.play().catch(() => {}); } },
      pause() { videoRef.current?.pause(); },
      currentTime() {
        const v = videoRef.current;
        if (!v || v.readyState === 0 || !played.current || !Number.isFinite(v.currentTime)) return null;
        return v.currentTime;
      },
    }));

    useEffect(() => {
      const el = videoRef.current;
      if (!el) return;
      played.current = false;
      let hls: InstanceType<HlsCtor> | null = null;
      let cancelled = false;
      setFailed(null);
      const fail = (m: string) => { setFailed(m); onError?.(m); };
      if (!isHls(src)) {
        el.src = src;
        return () => { el.removeAttribute("src"); el.load(); };
      }
      const url = hlsUrlOf(src);
      if (el.canPlayType("application/vnd.apple.mpegurl")) {
        el.src = url; // Safari / iOS: native HLS
        return () => { el.removeAttribute("src"); el.load(); };
      }
      loadHls()
        .then(() => {
          if (cancelled || !window.Hls?.isSupported()) { if (!cancelled) fail("This browser can't play this video — try Safari, or text us and we'll get you the file."); return; }
          hls = new window.Hls({ enableWorker: true });
          hls.on(window.Hls.Events.ERROR, (_e, data) => { if (data?.fatal) fail("The video stream stopped — reload the page to try again, or text us and we'll get you the file."); });
          hls.loadSource(url);
          hls.attachMedia(el);
        })
        .catch(() => fail("The video player couldn't load — check your connection and try again, or text us and we'll get you the file."));
      return () => { cancelled = true; hls?.destroy(); };
    }, [src, onError]);

    return (
      <div className={className}>
        <video ref={videoRef} poster={poster ?? undefined} controls playsInline preload="metadata" autoPlay={autoPlay} className="w-full rounded-lg bg-black"
          onPlay={() => { played.current = true; }} onSeeked={() => { played.current = true; }}
          onTimeUpdate={() => { if ((videoRef.current?.currentTime ?? 0) > 0) played.current = true; }}
          onError={() => { if (!isHls(src)) { setFailed("This video couldn't be played — reload to try again, or text us and we'll get you the file."); onError?.("play-error"); } }} />
        {failed && <p role="alert" className="mt-2 text-xs text-danger">{failed}</p>}
      </div>
    );
  },
);
