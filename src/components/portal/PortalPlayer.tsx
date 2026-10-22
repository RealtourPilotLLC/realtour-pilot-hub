"use client";

import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import { contactLine } from "@/components/portal/ContactTeam";

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

/**
 * THE SAME FILE, WHATEVER ITS TOKEN (Oct 22 2026). A hub cut's address carries a
 * short-lived media token (`?m=`, minted per page render, lib/portalMedia), so
 * every router.refresh() after a note, a reply or a resolve handed the player a
 * "new" src for the very same file, and it reloaded: the frame went black and
 * the playhead went back to the start. The player loads by this key instead,
 * the address with its token taken off, so a fresh token alone never reloads.
 * (The newest address is kept: if the old token has run out by the time the
 * browser asks for more of the file, the player retries once with it.)
 */
export function playerSourceKey(src: string): string {
  const [path, query] = src.split("?");
  if (!query) return src;
  const kept = query.split("&").filter((p) => p && !/^m=/.test(p));
  return kept.length ? `${path}?${kept.join("&")}` : path;
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

// THE FLASH (Oct 22 2026, Jordan: "When I type in the note box, it makes the
// video disappear / flash"). The load effect below used to list `onError` in
// its dependencies, and CutReview passed an inline arrow for it: a NEW function
// on every render. Every keystroke in the note box re-rendered CutReview, so
// this effect's cleanup ran (`removeAttribute("src")` + `load()`: the video
// unloads, black frame, playhead back to 0:00) and then set the same src again.
// Now the callback lives in a ref the effect reads when it needs it, the effect
// depends on the FILE only (playerSourceKey), and the component is memoised, so
// a parent re-render with the same file never touches the element.
export const PortalPlayer = memo(forwardRef<PortalPlayerHandle, { src: string; poster?: string | null; className?: string; autoPlay?: boolean; onError?: (msg: string) => void }>(
  function PortalPlayer({ src, poster, className, autoPlay = false, onError }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    // Set the first time the playhead actually moves (play, seek, or a
    // timeupdate past 0). Until then there is no "paused moment" to pin to.
    const played = useRef(false);
    const [failed, setFailed] = useState<string | null>(null);
    // The newest callback and address, read by the handlers below without being
    // the load effect's dependencies: a new arrow or a fresh token never reloads.
    // (Declared before the load effect, so it has run when that one reads them.)
    const onErrorRef = useRef(onError);
    const latestSrc = useRef(src);
    useEffect(() => { onErrorRef.current = onError; latestSrc.current = src; });
    // The address the element actually loaded, and whether the one stale-token
    // retry has been spent on it.
    const loadedSrc = useRef<string | null>(null);
    const retried = useRef(false);
    const srcKey = playerSourceKey(src);
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
      // The address current when this FILE was opened; later token-only
      // changes reach latestSrc without re-running this effect.
      const src = latestSrc.current;
      played.current = false;
      retried.current = false;
      loadedSrc.current = src;
      let hls: InstanceType<HlsCtor> | null = null;
      let cancelled = false;
      setFailed(null);
      const fail = (m: string) => { setFailed(m); onErrorRef.current?.(m); };
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
          if (cancelled || !window.Hls?.isSupported()) { if (!cancelled) fail(`This browser can't play this video. Try Safari, or ${contactLine()} and we'll get you the file.`); return; }
          hls = new window.Hls({ enableWorker: true });
          hls.on(window.Hls.Events.ERROR, (_e, data) => { if (data?.fatal) fail(`The video stream stopped. Reload the page to try again, or ${contactLine()} and we'll get you the file.`); });
          hls.loadSource(url);
          hls.attachMedia(el);
        })
        .catch(() => fail(`The video player couldn't load. Check your connection and try again, or ${contactLine()} and we'll get you the file.`));
      return () => { cancelled = true; hls?.destroy(); };
    }, [srcKey]);

    // A plain file that errors after its token was refreshed: the browser asked
    // for more of it with the old, expired token. Load the newest address once,
    // at the same moment, before calling it a failure.
    const onVideoError = () => {
      const el = videoRef.current;
      if (isHls(src)) return;
      const fresh = latestSrc.current;
      if (el && !retried.current && loadedSrc.current && fresh !== loadedSrc.current) {
        retried.current = true;
        loadedSrc.current = fresh;
        const at = Number.isFinite(el.currentTime) ? el.currentTime : 0;
        el.src = fresh;
        if (at > 0) el.addEventListener("loadedmetadata", () => { el.currentTime = at; }, { once: true });
        return;
      }
      setFailed(`This video couldn't be played. Reload to try again, or ${contactLine()} and we'll get you the file.`);
      onErrorRef.current?.("play-error");
    };

    return (
      <div className={className}>
        <video ref={videoRef} poster={poster ?? undefined} controls playsInline preload="metadata" autoPlay={autoPlay} className="mx-auto block max-h-[min(70vh,760px)] w-full rounded-lg bg-black object-contain"
          onPlay={() => { played.current = true; }} onSeeked={() => { played.current = true; }}
          onTimeUpdate={() => { if ((videoRef.current?.currentTime ?? 0) > 0) played.current = true; }}
          onError={onVideoError} />
        {failed && <p role="alert" className="mt-2 text-xs text-danger">{failed}</p>}
      </div>
    );
  },
));
PortalPlayer.displayName = "PortalPlayer";
