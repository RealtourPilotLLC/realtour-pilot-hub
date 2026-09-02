"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";

// Something broke on a page. Before this existed, a failure showed the browser's
// own blank error screen: the person had nothing to read, nothing to press and
// nothing to report, so a bug looked like a dead internet connection (Sep 2
// readiness audit). Every failure should be reportable by the person who hit it.
export default function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The digest is what ties this to the server log — always print it.
    console.error("Page error", error.digest ?? "", error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="panel-shadow w-full max-w-md rounded-2xl border border-border bg-surface p-6">
        <span className="flex size-10 items-center justify-center rounded-xl bg-warning/15 text-warning">
          <AlertTriangle className="size-5" />
        </span>
        <h1 className="mt-3 text-lg font-semibold tracking-tight">This page hit a problem</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Nothing you did caused it and nothing was lost. Try again — if it keeps happening, send
          Jordan the reference below and it can be traced in the logs.
        </p>
        {error.digest && (
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-muted">
            Reference: {error.digest}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <RefreshCw className="size-4" /> Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            Back to home
          </Link>
          <Link
            href="/feedback"
            className="inline-flex items-center rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            Report it
          </Link>
        </div>
      </div>
    </div>
  );
}
