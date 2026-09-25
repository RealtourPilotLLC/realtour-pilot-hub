"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, RotateCcw, Share2, X } from "lucide-react";
import { portalDownloadCompleted } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { DownloadPlan } from "@/lib/postingKit";

// ---------------------------------------------------------------------------
// THE DOWNLOAD BUTTON (CP-12, Sep 24 2026). It replaced a target=_blank link
// with no progress, no retry and a line telling phone users to find a
// computer. The server decides the mode (postingKit.downloadPlanFor):
//
//   proxy     the file comes from our own origin with a Content-Length, so
//             this reads it with fetch(): live % and MB, Cancel, and on a
//             failure "Stopped at N% — Try again", which asks for the rest
//             with a Range header rather than starting over. When every byte
//             is in, a phone that can share files gets a SECOND tap — iOS
//             only opens the share sheet from a fresh tap — whose sheet offers
//             Save Video; anything else saves it as a file. Then, and only
//             then — the share sheet finished, or the file was handed to the
//             browser's save — the page tells the server the download
//             FINISHED. Bytes held in memory while the client has not yet
//             tapped Share / save are not that fact (review, Sep 24 2026:
//             closing the sheet used to leave "Saved" on record over nothing).
//   redirect  a Dropbox-held or Aryeo file this page cannot read: a plain
//             link, followed straight from the tap (nothing async first, which
//             is what makes a new tab safe on iOS). The state says the
//             download STARTED and gives the instructions for this phone; it
//             never claims the file arrived.
//
// Nothing here promises a browser can save straight into Photos — iPhone
// needs the share sheet's Save Video, and Android saves to Downloads.
// ---------------------------------------------------------------------------

type Platform = "ios" | "android" | "desktop";

type State =
  | { kind: "idle" }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "failed"; received: number; total: number | null; message: string }
  | { kind: "ready"; file: File }
  | { kind: "saved"; how: "share" | "file" }
  | { kind: "started" };

const HINT: Record<Platform, { redirect: string; share: string; file: string }> = {
  ios: {
    redirect: "If the video opens, tap Share → Save Video. If Safari asks, tap Download, then open it in the Files app and share it to Photos.",
    share: "Tap Share / save, then choose Save Video to put it in Photos.",
    file: "Safari saves it to the Files app (Downloads) — open it there and share it to Photos.",
  },
  android: {
    redirect: "It saves to Downloads — open it from Files or Gallery. If it plays instead, use the ⋮ menu → Download.",
    share: "Tap Share / save to send it to an app or save it.",
    file: "It saved to Downloads — open it from Files or Gallery.",
  },
  desktop: {
    redirect: "It saves to your Downloads folder. If it plays in a new tab instead, right-click the video → Save video as.",
    share: "Tap Share / save to send it on.",
    file: "It saved to your Downloads folder.",
  },
};

const mb = (n: number) => (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);
const pctOf = (received: number, total: number | null) => (total ? Math.min(100, Math.floor((received / total) * 100)) : null);

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

// The device never changes under a page, so there is nothing to subscribe to.
const noSubscription = () => () => {};

function saveAsFile(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the browser to take the bytes; the memory is freed after.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function DownloadButton({ videoId, href, plan, label, title }: {
  videoId: string;
  /** The gated door (/api/portal/download/<id>?m=…) — never the file's own address. */
  href: string;
  plan: DownloadPlan;
  label: string;
  title: string;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  // null on the server: it cannot know the device, and guessing there would
  // flash the wrong instructions before hydration.
  const platform = useSyncExternalStore<Platform | null>(noSubscription, detectPlatform, () => null);
  const abort = useRef<AbortController | null>(null);
  // Bytes kept across a failure, so Try again asks only for the rest.
  const chunks = useRef<Uint8Array[]>([]);
  const received = useRef(0);

  useEffect(() => () => abort.current?.abort(), []);

  const fileName = plan.fileName || `${title.replace(/[^\w .-]+/g, "").trim() || "video"}.mp4`;
  const hint = HINT[platform ?? "desktop"];

  // THE FINISHED FACT, sent once the file has left this page: the share sheet
  // resolved, or the file was handed to the browser's save. Best-effort — the
  // file is theirs either way.
  const finished = () => {
    if (plan.ref) void portalDownloadCompleted(portalAuthFromLocation(), videoId, plan.ref).catch(() => {});
  };

  const run = async () => {
    const ac = new AbortController();
    abort.current = ac;
    let total: number | null = plan.sizeBytes;
    const resumeFrom = received.current;
    setState({ kind: "downloading", received: resumeFrom, total });
    try {
      const res = await fetch(href, {
        signal: ac.signal, cache: "no-store", credentials: "same-origin",
        // The door redirects to our own stream route, which honours Range; a
        // server that ignores it answers 200 and the earlier bytes are dropped.
        headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined,
      });
      if (!res.ok || !res.body) {
        const why = await res.json().then((j: { error?: string }) => j.error).catch(() => null);
        throw new Error(why || "The download didn't start.");
      }
      if (res.status !== 206) { chunks.current = []; received.current = 0; }
      const length = Number(res.headers.get("content-length")) || null;
      if (length) total = res.status === 206 ? received.current + length : length;
      const type = res.headers.get("content-type") || "video/mp4";
      const reader = res.body.getReader();
      let shownPct = -1;
      let shownAt = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.current.push(value);
        received.current += value.length;
        // Re-render on a new percent (or every 2 MB when the size is unknown), not every chunk.
        const pct = pctOf(received.current, total);
        if (pct !== null ? pct !== shownPct : received.current - shownAt > 2 * 1024 * 1024) {
          shownPct = pct ?? shownPct;
          shownAt = received.current;
          setState({ kind: "downloading", received: received.current, total });
        }
      }
      if (total && received.current < total) throw new Error("The connection dropped before the whole file arrived.");
      const file = new File(chunks.current as BlobPart[], fileName, { type });
      chunks.current = [];
      received.current = 0;
      const phone = platform === "ios" || platform === "android";
      if (phone && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) setState({ kind: "ready", file });
      else { saveAsFile(file); finished(); setState({ kind: "saved", how: "file" }); }
    } catch (e) {
      if (ac.signal.aborted) {
        chunks.current = [];
        received.current = 0;
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "failed", received: received.current, total, message: e instanceof Error ? e.message : "The download stopped." });
    } finally {
      if (abort.current === ac) abort.current = null;
    }
  };

  const share = (file: File) => {
    // Called straight from the tap: iOS refuses a share sheet that follows an await.
    navigator.share({ files: [file], title }).then(
      () => { finished(); setState({ kind: "saved", how: "share" }); },
      (e: unknown) => {
        // Closing the sheet is not a failure, and not a finish: the file is
        // still here to try again, and nothing is recorded.
        if (e instanceof DOMException && e.name === "AbortError") return;
        saveAsFile(file);
        finished();
        setState({ kind: "saved", how: "file" });
      },
    );
  };

  const btn = "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
  const primary = `${btn} bg-brand text-white hover:opacity-90`;
  const secondary = `${btn} border border-border text-foreground hover:bg-surface-2`;
  const openInstead = (
    <a href={href} download={fileName} target="_blank" rel="noopener noreferrer" onClick={() => setState({ kind: "started" })} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
      <ExternalLink className="size-3.5" /> Open the file instead
    </a>
  );

  if (plan.mode === "redirect") {
    return (
      <div className="space-y-1.5">
        {/* A link, not a script: followed straight from the tap, so a phone never blocks it. */}
        <a href={href} download={fileName} target="_blank" rel="noopener noreferrer" onClick={() => setState({ kind: "started" })} className={primary}>
          <Download className="size-4" /> Download {label}
        </a>
        {state.kind === "started" ? (
          <p role="status" className="text-xs text-muted"><span className="font-semibold text-foreground">Download started.</span> {hint.redirect}</p>
        ) : (
          platform && <p className="text-[11px] text-muted-2">{hint.redirect}</p>
        )}
      </div>
    );
  }

  if (state.kind === "downloading") {
    const pct = pctOf(state.received, state.total);
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold"><Loader2 className="size-4 animate-spin text-brand" /> Downloading{pct !== null ? ` ${pct}%` : "…"}</span>
          <span className="text-xs text-muted tabular-nums">{state.total ? `${mb(state.received)} of ${mb(state.total)} MB` : `${mb(state.received)} MB`}</span>
          <button type="button" onClick={() => abort.current?.abort()} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><X className="size-3" /> Cancel</button>
        </div>
        <div role="progressbar" aria-label={`Downloading ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} className="h-1.5 max-w-xs overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${pct ?? 5}%` }} />
        </div>
        <p className="text-[11px] text-muted-2">Keep this page open until it finishes.</p>
      </div>
    );
  }

  if (state.kind === "failed") {
    const pct = pctOf(state.received, state.total);
    return (
      <div className="space-y-1.5" role="status">
        <p className="text-sm text-danger">{pct !== null && state.received > 0 ? `Stopped at ${pct}%` : "The download didn't finish"} — {state.message}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void run()} className={primary}><RotateCcw className="size-4" /> Try again</button>
          {openInstead}
        </div>
      </div>
    );
  }

  if (state.kind === "ready") {
    const file = state.file;
    return (
      <div className="space-y-1.5" role="status">
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-success"><CheckCircle2 className="size-4" /> Downloaded — {mb(file.size)} MB</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => share(file)} className={primary}><Share2 className="size-4" /> Share / save</button>
          <button type="button" onClick={() => { saveAsFile(file); finished(); setState({ kind: "saved", how: "file" }); }} className={secondary}><Download className="size-4" /> Save as a file</button>
        </div>
        <p className="text-[11px] text-muted-2">{hint.share}</p>
      </div>
    );
  }

  if (state.kind === "saved") {
    return (
      <div className="space-y-1.5" role="status">
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-success"><CheckCircle2 className="size-4" /> {state.how === "share" ? "Shared" : "Saved"}</p>
        {state.how === "file" && <p className="text-[11px] text-muted-2">{hint.file}</p>}
        <button type="button" onClick={() => void run()} className="text-xs font-medium text-brand hover:underline">Download again</button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button type="button" onClick={() => void run()} className={primary}>
        <Download className="size-4" /> Download {label}
      </button>
      {plan.sizeBytes ? <p className="text-[11px] text-muted-2">{mb(plan.sizeBytes)} MB · you&rsquo;ll see its progress here.</p> : null}
    </div>
  );
}
