// ---------------------------------------------------------------------------
// A Content-Disposition header for ANY file name (Oct 27 2026). Joe Sutow's
// video 4 came up as "04 The Bucket Drop — What You Need to Know Before This
// Water.mov": the em dash is not a byte a header can carry, so setting
// `filename="…"` threw, the stream route answered 500 before a single byte of
// video, and Safari called it "This browser couldn't play this video format".
//
// The ASCII fallback (`filename`) is for old clients; `filename*` (RFC 6266 /
// 5987) carries the real name, UTF-8 and percent-encoded, so a download still
// saves under the editor's own name.
// ---------------------------------------------------------------------------

const ASCII_FOR: Record<string, string> = { "\u2013": "-", "\u2014": "-", "\u2018": "'", "\u2019": "'", "\u201c": "", "\u201d": "" };

/** `inline; filename="04 The Bucket Drop - What….mov"; filename*=UTF-8''04%20The%20Bucket%20Drop%20%E2%80%94…` */
export function contentDisposition(kind: "inline" | "attachment", fileName: string | null | undefined, fallback = "file"): string {
  const name = (fileName ?? "").replace(/[\r\n]+/g, " ").trim() || fallback;
  const ascii = name
    .replace(/[\u2013\u2014\u2018\u2019\u201c\u201d]/g, (c) => ASCII_FOR[c] ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
