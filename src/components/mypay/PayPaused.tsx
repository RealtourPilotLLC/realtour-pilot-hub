import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";

// ---------------------------------------------------------------------------
// WHAT A PHOTOGRAPHER SEES WHILE THEIR PAY VIEW IS PAUSED (Jordan, Sep 18:
// "make it look like an error loading the shoot pay page").
//
// It is app/error.tsx's screen, on purpose — a pause that looks like a
// different thing from every other failure is not the pause he asked for.
//
// TWO THINGS IT DELIBERATELY DOES NOT COPY from the real one:
//   · no fabricated "Reference:" code. The real screen prints a digest that
//     ties the failure to a line in the server log. Inventing one sends
//     somebody looking for a trace that was never written, which is the single
//     most expensive way this could go wrong.
//   · no "Report it" link into /feedback. The real screen asks the person to
//     file it; a filed report lands on Jordan's own board as a bug he would
//     then have to not-fix, in writing, under his own name.
// Everything else — the icon, the wording, the retry, the way back home — is
// the same screen, because the point is that it reads as an ordinary bad day.
// ---------------------------------------------------------------------------
export function PayPaused() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="panel-shadow w-full max-w-md rounded-2xl border border-border bg-surface p-6">
        <span className="flex size-10 items-center justify-center rounded-xl bg-warning/15 text-warning">
          <AlertTriangle className="size-5" />
        </span>
        <h1 className="mt-3 text-lg font-semibold tracking-tight">This page hit a problem</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Nothing you did caused it and nothing was lost. Your shoots and your pay records are
          safe — try again in a little while.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/my-pay"
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <RefreshCw className="size-4" /> Try again
          </Link>
          <Link
            href="/shoot"
            className="inline-flex items-center rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            Back to my shoots
          </Link>
        </div>
      </div>
    </div>
  );
}
