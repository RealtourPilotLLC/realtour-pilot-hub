import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// THE ERROR TRACKER'S PURE HALF (Oct 6 2026) — scrubbing, normalising and
// fingerprinting. No database, no Next, no "server-only": the drill reads it
// directly and errorTracker.ts builds on it.
//
// WHAT MUST NEVER BE STORED. An error message is whatever the code that threw
// put in it, and a URL is whatever the visitor opened, so both are scrubbed
// before anything is written:
//   · the secret part of token links — /portal/<token>, /upload/<token>,
//     /learn/<token>, /invite/<token>, /api/portal/download/<id>?t=… — and any
//     query string at all (a path is stored without its ?query);
//   · email addresses and phone numbers (the people in our data);
//   · bearer tokens, JWTs, provider keys (sk_live_…, xoxb-…) and any long
//     secret-shaped run of characters.
// Request bodies, cookies and headers are never passed in at all.
// ---------------------------------------------------------------------------

export const ERROR_SOURCES = ["server-request", "server-action", "route-handler", "cron", "client", "client-portal", "background"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const MESSAGE_MAX = 1000;
export const STACK_MAX = 8000;

/** Path segments that are a SECRET when they follow these prefixes. */
const TOKEN_ROUTES = ["portal", "upload", "learn", "invite"];
/** …except these fixed sub-pages, which are route names, not tokens. */
const TOKEN_ROUTE_WORDS = new Set(["login", "me", "address", "auth", "logout", "callback"]);

/** A secret link segment, not a route name: long, or carrying a digit
 *  ("/portal/upload/route" is a route file; "/portal/k3Jx…" is a token). */
function looksLikeToken(seg: string): boolean {
  if (TOKEN_ROUTE_WORDS.has(seg.toLowerCase()) || !/^[A-Za-z0-9_-]{6,}$/.test(seg)) return false;
  return seg.length >= 12 || /\d/.test(seg);
}

/** Scrub free text: an error message, a stack, a context value. */
export function scrubText(input: unknown, max = MESSAGE_MAX): string {
  let s = typeof input === "string" ? input : input == null ? "" : String(input);
  // Query strings in any URL-ish text: drop everything after "?" up to whitespace/quote.
  s = s.replace(/(\/[^\s"'`<>?]*)\?[^\s"'`<>)]*/g, "$1?[query]");
  // Token links anywhere in the text (absolute or relative).
  s = s.replace(new RegExp(`/(${TOKEN_ROUTES.join("|")})/([A-Za-z0-9_-]{6,})`, "g"), (m, route: string, seg: string) =>
    looksLikeToken(seg) ? `/${route}/[token]` : m,
  );
  // Credentials.
  s = s.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [secret]");
  s = s.replace(/\b(token|access_token|refresh_token|apikey|api_key|secret|client_secret|password|passwd|pwd|authorization|sig|signature)(\s*[:=]\s*)("?)[^\s"',;&]+/gi, "$1$2$3[secret]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt]");
  s = s.replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, "[key]");
  s = s.replace(/\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, "[key]");
  s = s.replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi, "$1://[redacted]");
  // People.
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  s = s.replace(/(?<![\w.])\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w])/g, "[phone]");
  s = s.replace(/(?<![\w.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w])/g, "[phone]");
  // Long secret-shaped runs (≥ 40 chars of mixed letters+digits) — ids are
  // shorter, and a file path (slashes, dots) never matches.
  s = s.replace(/\b(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g, "[secret]");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A request path as stored: no query, token segments replaced. Ids kept (the
 *  concrete /projects/<id> is what lets Jordan open the job that broke). */
export function scrubPath(input: unknown): string | null {
  if (typeof input !== "string" || !input) return null;
  let p = input.trim();
  try {
    // An absolute URL → its pathname only.
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch { /* keep the raw text, scrubbed below */ }
  p = p.split("?")[0].split("#")[0];
  if (!p.startsWith("/")) p = `/${p}`;
  const segs = p.split("/");
  for (let i = 1; i < segs.length; i++) {
    const prev = (segs[i - 1] ?? "").toLowerCase();
    const seg = segs[i];
    if (!seg) continue;
    if (TOKEN_ROUTES.includes(prev) && looksLikeToken(seg)) segs[i] = "[token]";
  }
  return scrubText(segs.join("/"), 300);
}

/** The ROUTE an error belongs to, for grouping: the scrubbed path with every
 *  id-shaped segment collapsed, so /projects/abc and /projects/xyz are one route. */
export function normalizeRoute(input: unknown): string | null {
  const p = scrubPath(input);
  if (!p) return null;
  return p
    .split("/")
    .map((seg) => {
      if (!seg || seg.startsWith("[")) return seg;
      if (/^\d+$/.test(seg)) return "[id]";
      if (/^c[a-z0-9]{20,32}$/.test(seg)) return "[id]"; // cuid
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "[id]";
      if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /\d/.test(seg) && /[a-z]/i.test(seg)) return "[id]";
      return seg;
    })
    .join("/");
}

/** The message with its variable parts removed, so one bug is one fingerprint. */
export function normalizeMessage(message: string): string {
  // A React production error's NUMBER is the whole of its meaning (#418 is a
  // hydration mismatch, #423 a render-phase recovery, #185 an update loop) —
  // folding it to "#N" with every other number would make them one row on
  // the same page. Its ?args are scrubbed with every query string; that only
  // merges one error's variants, which is right (Oct 9 2026).
  const reactCodes = [...message.matchAll(/(?:React error #|react\.dev\/errors\/)(\d+)/gi)].map((m) => m[1]);
  const codes = reactCodes.length ? ` [react ${[...new Set(reactCodes)].join(",")}]` : "";
  return (scrubText(message, 400)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[id]")
    .replace(/\bc[a-z0-9]{20,32}\b/g, "[id]")
    .replace(/\b[0-9a-f]{12,}\b/gi, "[hex]")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()) + codes;
}

/** The first stack frame in OUR code: "fn (src/lib/x.ts)" with no line/column
 *  (a deploy moves line numbers; the bug is the same bug) and no bundle hash. */
export function topFrame(stack: string | null | undefined): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ") || /@/.test(l));
  const ours =
    lines.find((l) => !/node_modules|node:internal|\(native\)|<anonymous>|webpack-internal:\/\/\/\(rsc\)\/\.\/node_modules|\bnext\/dist\b/.test(l)) ??
    lines[0] ??
    "";
  const frame = ours
    .replace(/:\d+:\d+\)?$/g, "")
    .replace(/:\d+:\d+/g, "")
    .replace(/[?#].*$/g, "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "[h]") // chunk hashes
    .replace(/https?:\/\/[^/\s)]+/g, "") // origin
    .replace(/\(|\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return builtFrame(frame).slice(0, 200);
}

/**
 * A frame inside the production BUILD (the browser's /_next/static/chunks/…,
 * the server's .next/server/chunks/…) names a Turbopack chunk whose file name
 * carries a content hash ("1sloqs30e_g-z.js", "src_lib_x_ts_1zd0k9e._.js") and
 * a minified function ("rX", "o"). Both change with every deploy, so one bug
 * would come back as a "new" error after each one (Oct 9 2026). Kept: the
 * frame's style (Chrome "at …" / Safari & Firefox "fn@…"), a function name
 * long enough to be a real one, and a server chunk's readable module prefix.
 */
function builtFrame(frame: string): string {
  const browser = /\/_next\/static\/(chunks|media)\//.test(frame);
  const server = /\.next\/server\//.test(frame);
  if (!browser && !server) return frame;
  const safari = /^[^\s@]*@/.test(frame) && !frame.startsWith("at ");
  const fn = safari ? frame.slice(0, frame.indexOf("@")) : (/^at (?:async )?([^\s/]+) /.exec(frame)?.[1] ?? "");
  const name = fn.length >= 4 ? fn : "";
  const file = browser
    ? "/_next/static/chunks/[chunk].js"
    : frame
        .slice(frame.indexOf(".next/server/"))
        .replace(/\[root-of-the-server\]__[^/\s]*$/, "[root-of-the-server]")
        .replace(/_[0-9a-z]{5,12}\._\.js$/i, "")
        .replace(/\.js$/, "");
  return safari ? `${name}@${file}` : `at ${name ? `${name} ` : ""}${file}`;
}

export function fingerprintOf(parts: { message: string; stack?: string | null; route?: string | null }): string {
  const basis = [normalizeMessage(parts.message), topFrame(parts.stack), parts.route ?? ""].join("\n");
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/** Errors that are NOT bugs: framework control flow, a signed-out/forbidden
 *  action refusing on purpose, browser noise and extensions. */
export function isIgnorable(e: { message?: string | null; digest?: string | null; stack?: string | null; name?: string | null }): boolean {
  const msg = e.message ?? "";
  const digest = e.digest ?? "";
  if (/^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING|NEXT_PRERENDER_INTERRUPTED|HANGING_PROMISE_REJECTION)/.test(digest)) return true;
  if (/^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK)/.test(msg)) return true;
  if (e.name === "AbortError") return true;
  // Deliberate refusals from the guards (auth/guards.ts) — the person sees the sentence.
  if (/^(Please sign in to do that\.|You don't have access to do that\.|You're previewing another user)/.test(msg)) return true;
  // Browser noise.
  if (/ResizeObserver loop|Script error\.?$|^cancelled$|Load failed$|NetworkError when attempting to fetch|Failed to fetch$/i.test(msg)) return true;
  if (/chrome-extension:\/\/|moz-extension:\/\/|safari-(web-)?extension:\/\//.test(e.stack ?? "")) return true;
  return false;
}

/** Which bucket a client report belongs to, by where it happened. */
export function clientSourceFor(path: string | null): ErrorSource {
  return path && (path === "/portal" || path.startsWith("/portal/")) ? "client-portal" : "client";
}

/** A thrown value as name/message/stack, whatever was thrown. */
export function describeThrown(err: unknown): { name: string | null; message: string; stack: string | null; digest: string | null } {
  if (err instanceof Error) {
    const digest = (err as { digest?: unknown }).digest;
    return { name: err.name || null, message: err.message || err.name || "Error", stack: err.stack ?? null, digest: typeof digest === "string" ? digest : null };
  }
  if (err && typeof err === "object") {
    const o = err as { name?: unknown; message?: unknown; stack?: unknown; digest?: unknown };
    return {
      name: typeof o.name === "string" ? o.name : null,
      message: typeof o.message === "string" ? o.message : safeJson(err),
      stack: typeof o.stack === "string" ? o.stack : null,
      digest: typeof o.digest === "string" ? o.digest : null,
    };
  }
  return { name: null, message: String(err), stack: null, digest: null };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return "[unserialisable value]";
  }
}

/** Scrub a small context object: strings scrubbed, only primitives kept, keys
 *  that smell of secrets or personal data dropped outright. */
export function scrubContext(ctx: Record<string, unknown> | null | undefined): string | null {
  if (!ctx) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(ctx).slice(0, 20)) {
    if (/token|secret|password|cookie|auth|email|phone|body|header/i.test(k)) continue;
    if (v == null || typeof v === "number" || typeof v === "boolean") out[k] = v as number | boolean | null;
    else if (typeof v === "string") out[k] = scrubText(v, 200);
  }
  const s = JSON.stringify(out);
  return s === "{}" ? null : s.slice(0, 2000);
}
