"use client";

import { useState } from "react";
import { PlayCircle, X } from "lucide-react";

// "Watch it" on a Ready to send row (Jordan, Oct 19 2026: "add a 'watch it'
// option so we can watch before upload and sending to ensure the topaz render
// came out good"). Plays the exact file "Upload to Aryeo and send" would send:
// the 1080p render when the pass finished, the editor's own export otherwise.
// The player only loads when opened, so the page never pulls a video by itself.
export function WatchFile({ href, fileName, isRender }: { href: string; fileName: string; isRender: boolean }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  return (
    <div className="mt-2">
      {!open ? (
        <button
          type="button"
          onClick={() => { setBroken(false); setOpen(true); }}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border-strong px-3 text-sm font-semibold hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <PlayCircle aria-hidden className="size-4" /> Watch it
        </button>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-surface-2/40 p-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="min-w-0 truncate text-xs text-muted" title={fileName}>
              {isRender ? "The 1080p file that goes to Aryeo" : "The editor's file that goes to Aryeo"} · <span className="font-mono">{fileName}</span>
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close the player"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
          {broken ? (
            <p role="alert" className="px-1 pb-1 text-sm text-danger">
              The file would not play here. Download it below (Done it by hand?) and watch it on your computer before sending.
            </p>
          ) : (
            <video
              src={href}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onError={() => setBroken(true)}
              className="max-h-[70vh] w-full rounded-md bg-black"
            />
          )}
        </div>
      )}
    </div>
  );
}
