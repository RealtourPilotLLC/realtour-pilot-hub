// ---------------------------------------------------------------------------
// BROWSER → ERROR TRACKER (Oct 6 2026). The one function the error screens and
// the window listeners (src/instrumentation-client.ts) call. Browser-only, no
// server imports. It sends a description of the JavaScript error — name,
// message, stack, the page's path — to /api/errors and nothing else (no form
// contents, no storage, no cookies beyond the browser's own same-origin ones);
// the server scrubs tokens, emails and phone numbers before storing anything.
//
// Quiet by construction: at most 10 reports per page load, each distinct error
// once, never a server-rendered error (it carries a digest and was already
// recorded on the server by onRequestError), and a failure to send is ignored.
// ---------------------------------------------------------------------------

const MAX_PER_PAGE = 10;
const seen = new Set<string>();
let sent = 0;

export function sendClientError(err: unknown, opts: { digest?: string | null; boundary?: string } = {}): void {
  try {
    if (typeof window === "undefined" || typeof fetch !== "function") return;
    if (opts.digest) return; // a server error — recorded where it happened
    if (sent >= MAX_PER_PAGE) return;
    const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
    const message = typeof e?.message === "string" ? e.message : typeof err === "string" ? err : "";
    if (!message) return;
    const name = typeof e?.name === "string" ? e.name : "Error";
    const stack = typeof e?.stack === "string" ? e.stack : "";
    const key = `${name}|${message}|${stack.slice(0, 300)}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    const body = JSON.stringify({
      name: name.slice(0, 80),
      message: message.slice(0, 2000),
      stack: stack.slice(0, 8000),
      path: window.location.pathname.slice(0, 500),
      boundary: opts.boundary ?? null,
    });
    // text/plain keeps it a simple request; keepalive lets it finish if the
    // page is being left.
    void fetch("/api/errors", {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body,
    }).catch(() => {});
  } catch {
    /* reporting must never cause an error of its own */
  }
}
