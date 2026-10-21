// ---------------------------------------------------------------------------
// WHERE A FRESH SIGN-IN MAY LAND (Oct 20 2026, audit G3).
//
// The `next` address rides from /login through Google (a cookie) or the
// password form and back. It used to be checked with only
// `startsWith("/") && !startsWith("//")`, and `/\evil.com` (or `/%5Cevil.com`
// once decoded) passes that: `new URL("/\\evil.com", base)` resolves to
// https://evil.com/, because browsers and the URL parser read a backslash as a
// slash. That turned every sign-in path into an open redirect a phishing link
// could ride.
//
// The ONE check, used by all four places that read `next`: a same-origin
// relative path, or nothing. Anything else falls back to the caller's default.
// No server-only import: the login page, the route handlers and the server
// action all share it.
// ---------------------------------------------------------------------------

const PROBE_ORIGIN = "https://hub.invalid";

/** `raw` when it is a safe same-origin path ("/sales?tab=payroll"), else null. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const next = raw.trim();
  if (!next || next.length > 2048) return null;
  // Backslashes and control characters (tab, newline, NUL) are how a path is
  // smuggled into a host: browsers strip or normalise them before resolving.
  // A percent-encoded backslash or control byte is refused too, because a
  // second decode anywhere downstream would turn it back into one.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return null;
  if (/%5c|%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(next)) return null;
  // Exactly one leading slash: never "//host" (protocol-relative) and never a
  // scheme ("https:", "javascript:").
  if (!/^\/(?![/\\])/.test(next)) return null;
  try {
    const u = new URL(next, PROBE_ORIGIN);
    if (u.origin !== PROBE_ORIGIN) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

/** The safe `next`, or `fallback` (a role's home) when it is missing, "/" or unsafe. */
export function safeNextOr(raw: string | null | undefined, fallback: string): string {
  const next = safeNextPath(raw);
  return next && next !== "/" ? next : fallback;
}
