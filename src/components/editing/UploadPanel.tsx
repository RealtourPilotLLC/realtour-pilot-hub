"use client";

import { useEffect, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { X } from "lucide-react";

// ---------------------------------------------------------------------------
// THE UPLOAD OPENS WHERE THE BUTTON IS (Jordan, Oct 27 2026: "I don't think we
// need another thing down here, until it actually goes through, gets sent ...
// when they click the upload, it opens up this"). The one upload row used to
// sit in its own "Send for review" block at the bottom of the brief. It now
// sits right under the job bar, closed until the job bar's Upload button (or
// a link to #submit-cut / #upload) opens it.
//
// Closed is HIDDEN, never unmounted: the hand-in card and the "still working
// on this job?" question live inside the uploader and must survive the
// refresh that moves the video on (Oct 15 2026), and an upload in progress
// keeps going if the panel is closed. Once opened it stays open across those
// refreshes (the state is this component's own).
//
// An approved video's row stays folded under "Upload a revised version":
// replacing it is a decision, not the next step.
// ---------------------------------------------------------------------------

export const OPEN_UPLOAD_EVENT = "rtp:open-upload";

export function UploadPanel({ title, mode = "panel", children }: { title: string; mode?: "panel" | "fold"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Synchronous, so the job bar's button can open the picker in the same click.
    const onOpen = () => flushSync(() => setOpen(true));
    const onHash = () => { if (/^#(submit-cut|upload)$/.test(window.location.hash)) setOpen(true); };
    onHash();
    window.addEventListener(OPEN_UPLOAD_EVENT, onOpen);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener(OPEN_UPLOAD_EVENT, onOpen);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  if (mode === "fold") {
    return (
      <details id="submit-cut" data-upload-panel="fold" open={open || undefined} className="rounded-2xl border border-border bg-surface px-4 sm:px-5">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand">Upload a revised version</summary>
        <span id="upload" aria-hidden />
        <div className="space-y-3 pb-4">{children}</div>
      </details>
    );
  }
  return (
    <section id="submit-cut" data-upload-panel={open ? "open" : "closed"} hidden={!open} aria-label={title} className="min-w-0 space-y-3 rounded-2xl border border-brand/40 bg-surface p-4 sm:p-5">
      <span id="upload" aria-hidden />
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold leading-snug">{title}</h2>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            // So a second press of a #submit-cut link opens it again.
            if (/^#(submit-cut|upload)$/.test(window.location.hash)) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
          }}
          aria-label="Close the upload" className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      {children}
    </section>
  );
}
