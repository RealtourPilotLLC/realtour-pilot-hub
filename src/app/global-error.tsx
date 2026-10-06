"use client";

import { useEffect } from "react";
import { sendClientError } from "@/lib/clientErrorReport";
import "./globals.css";

// ---------------------------------------------------------------------------
// THE LAST-RESORT ERROR SCREEN (Oct 6 2026). app/error.tsx handles a broken
// page; this replaces the ROOT LAYOUT when the layout itself fails, so it
// brings its own <html> and <body>. It reports a browser-side failure to the
// error tracker (a server failure carries a digest and was recorded by
// onRequestError already) and offers the two things a person can do: try
// again, or go back to the start.
// ---------------------------------------------------------------------------
export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    console.error("App error", error.digest ?? "", error);
    sendClientError(error, { digest: error.digest, boundary: "global" });
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-full bg-background text-foreground">
        <title>Something went wrong — RealTour Pilot</title>
        <div className="flex min-h-[70vh] items-center justify-center p-6">
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6">
            <h1 className="text-lg font-semibold tracking-tight">The hub hit a problem</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              Something went wrong while loading. It has been reported. Try again, or start from the beginning.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              If this interrupted a save or send, check its recorded status before trying that action again.
            </p>
            {error.digest && (
              <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-muted">Reference: {error.digest}</p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => unstable_retry()}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-transparent bg-brand-action px-4 py-2 text-sm font-semibold text-brand-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Try again
              </button>
              {/* A plain link on purpose: the router may be what broke. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border-strong bg-surface px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Start over
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
