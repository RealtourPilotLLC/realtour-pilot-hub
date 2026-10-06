import { sendClientError } from "@/lib/clientErrorReport";

// ---------------------------------------------------------------------------
// BROWSER ERROR CAPTURE (Oct 6 2026). Runs before the app is interactive, on
// every page — the staff hub and the client portal alike — and reports errors
// that escape React (event handlers, timers, rejected promises) to the error
// tracker via /api/errors. Errors React catches are reported by the error
// screens (app/error.tsx, app/global-error.tsx). Never throws.
// ---------------------------------------------------------------------------
try {
  window.addEventListener("error", (event) => {
    sendClientError(event.error ?? event.message, { boundary: "window" });
  });
  window.addEventListener("unhandledrejection", (event) => {
    sendClientError(event.reason, { boundary: "promise" });
  });
} catch {
  /* instrumentation must never break the page */
}
