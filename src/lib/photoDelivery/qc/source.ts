import "server-only";

// ---------------------------------------------------------------------------
// READING A PHOTO'S FULL-RESOLUTION BYTES (Oct 13 2026).
//
// AutoHDR's Dropbox watcher has not been returning finals to 04-Final-Photos;
// the edited photos appear on the Aryeo listing (AutoHDR's Aryeo integration
// imports them) before Kyle delivers. So a PhotoAsset says where its file
// lives and this module dispatches on it:
//
//   DROPBOX  dropboxDownload(dropboxPath), bounded by a timeout
//   ARYEO    fetch(sourceUrl): https only, hosts ending in aryeo.com,
//            amazonaws.com or cloudfront.net (a redirect may also return to
//            the host Aryeo's URL named), redirects followed by hand and each
//            hop re-checked, 60 s timeout, 60 MB cap. Anything else is
//            REFUSED: the QC run records a FILE_OPENS finding with the reason,
//            and nothing is fetched. This is the only place the QC engine
//            fetches a URL that came from outside the hub.
//   AUTOHDR  not supported yet: a skipped check, never a crash
//
// Errors are typed so the run can tell "try again next tick" (transient) from
// "this file will not load" (gone / refused / unsupported). URLs are never
// logged whole: a signed CDN URL carries its credential in the query string.
// ---------------------------------------------------------------------------

export type PhotoSourceRow = {
  id: string;
  name: string;
  sourceKind: string | null;
  sourceUrl: string | null;
  sourceRef: string | null;
  dropboxPath: string | null;
};

export type SourceFailure = "transient" | "gone" | "refused" | "unsupported";

export class PhotoSourceError extends Error {
  constructor(message: string, public kind: SourceFailure, public publicReason: string) {
    super(message);
    this.name = "PhotoSourceError";
  }
}

export const ARYEO_TIMEOUT_MS = 60_000;
export const ARYEO_MAX_BYTES = 60 * 1024 * 1024;
export const DROPBOX_TIMEOUT_MS = 90_000;
export const DROPBOX_MAX_BYTES = 150 * 1024 * 1024;
export const ALLOWED_HOST_SUFFIXES = ["aryeo.com", "amazonaws.com", "cloudfront.net"] as const;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The host part of a URL for logs (never the path or query). */
export function hostOf(raw: string | null | undefined): string {
  try {
    return new URL(String(raw)).hostname;
  } catch {
    return "unreadable-url";
  }
}

/**
 * May the QC engine fetch this URL? `originalHost` is the host of the URL Aryeo
 * gave us: a redirect may return to it even when it is not on the list.
 */
export function checkSourceUrl(raw: string, originalHost?: string | null): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "the photo's address is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "the photo's address is not https" };
  if (url.username || url.password) return { ok: false, reason: "the photo's address carries credentials" };
  if (url.port && url.port !== "443") return { ok: false, reason: "the photo's address uses a non-standard port" };
  const host = url.hostname.toLowerCase();
  if (!host || IPV4.test(host) || host.includes(":") || host.startsWith("[") || host === "localhost" || /\.(local|internal|localhost)$/.test(host)) {
    return { ok: false, reason: `the photo's host (${host || "none"}) is not a public CDN` };
  }
  const listed = ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  if (!listed && !(originalHost && host === originalHost.toLowerCase())) {
    return { ok: false, reason: `the photo's host (${host}) is not an Aryeo, S3 or CloudFront host` };
  }
  return { ok: true, url };
}

async function readCapped(res: Response, cap: number, what: string): Promise<Buffer> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > cap) throw new PhotoSourceError(`${what}: ${len} bytes is above the cap`, "refused", `the file is larger than ${Math.round(cap / 1048576)} MB`);
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new PhotoSourceError(`${what}: body above the cap`, "refused", `the file is larger than ${Math.round(cap / 1048576)} MB`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks);
}

async function fetchAryeo(rawUrl: string): Promise<Buffer> {
  const first = checkSourceUrl(rawUrl);
  if (!first.ok) throw new PhotoSourceError(`aryeo source refused (${hostOf(rawUrl)})`, "refused", first.reason);
  const originalHost = first.url.hostname;
  const signal = AbortSignal.timeout(ARYEO_TIMEOUT_MS);
  let current = first.url;
  for (let hop = 0; hop <= 3; hop++) {
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal, cache: "no-store", headers: { accept: "image/*" } });
    } catch (e) {
      const name = (e as Error)?.name ?? "";
      const why = name === "TimeoutError" || name === "AbortError" ? "the download timed out" : "the photo's host could not be reached";
      throw new PhotoSourceError(`aryeo fetch failed (${current.hostname}): ${(e as Error).message}`, "transient", why);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new PhotoSourceError(`aryeo redirect without a location (${current.hostname})`, "refused", "the photo's host redirected nowhere");
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new PhotoSourceError("aryeo redirect to an unreadable location", "refused", "the photo's host redirected to an unreadable address");
      }
      const ok = checkSourceUrl(next.href, originalHost);
      if (!ok.ok) throw new PhotoSourceError(`aryeo redirect refused (${next.hostname})`, "refused", `it redirected elsewhere: ${ok.reason}`);
      current = ok.url;
      continue;
    }
    if (res.status === 404 || res.status === 410 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new PhotoSourceError(`aryeo source answered ${res.status} (${current.hostname})`, "gone", `the photo is no longer available at its source (HTTP ${res.status})`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new PhotoSourceError(`aryeo source answered ${res.status} (${current.hostname})`, "transient", `the photo's host answered HTTP ${res.status}`);
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream") && !type.startsWith("binary/")) {
      await res.body?.cancel().catch(() => {});
      throw new PhotoSourceError(`aryeo source is ${type} (${current.hostname})`, "refused", `the photo's address returned ${type.split(";")[0]}, not an image`);
    }
    return readCapped(res, ARYEO_MAX_BYTES, `aryeo ${current.hostname}`);
  }
  throw new PhotoSourceError("aryeo source redirected too many times", "refused", "the photo's host redirected too many times");
}

async function downloadDropbox(path: string): Promise<Buffer> {
  const { dropboxDownload, DropboxError } = await import("@/lib/integrations/dropbox");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // dropboxDownload takes no abort signal; the race bounds how long QC
    // waits (the download itself ends with the function at the latest).
    const bytes = await Promise.race([
      dropboxDownload(path),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new PhotoSourceError("dropbox download timed out", "transient", "the Dropbox download timed out")), DROPBOX_TIMEOUT_MS);
      }),
    ]);
    if (bytes.length > DROPBOX_MAX_BYTES) throw new PhotoSourceError("dropbox file above the cap", "refused", "the file is larger than 150 MB");
    return bytes;
  } catch (e) {
    if (e instanceof PhotoSourceError) throw e;
    if (e instanceof DropboxError && (e.status === 409 || /not_found/i.test(e.message))) {
      throw new PhotoSourceError("dropbox path not found", "gone", "the file is no longer in its Dropbox folder");
    }
    throw new PhotoSourceError(`dropbox download failed: ${(e as Error).message.slice(0, 160)}`, "transient", "Dropbox could not be read just now");
  } finally {
    clearTimeout(timer);
  }
}

let testLoader: ((p: PhotoSourceRow) => Promise<Buffer>) | null = null;

/** Drills only: replace every source read with `fn` (no Dropbox, no Aryeo). */
export function __setPhotoBytesLoaderForTests(fn: ((p: PhotoSourceRow) => Promise<Buffer>) | null): void {
  testLoader = fn;
}

/** The photo's full-resolution file. Throws PhotoSourceError. */
export async function loadPhotoBytes(p: PhotoSourceRow): Promise<Buffer> {
  if (testLoader) return testLoader(p);
  const kind = (p.sourceKind ?? "DROPBOX").toUpperCase();
  if (kind === "DROPBOX") {
    if (!p.dropboxPath) throw new PhotoSourceError("dropbox photo without a path", "gone", "the photo has no Dropbox path");
    return downloadDropbox(p.dropboxPath);
  }
  if (kind === "ARYEO") {
    if (!p.sourceUrl) throw new PhotoSourceError("aryeo photo without a url", "refused", "the photo has no Aryeo image address");
    return fetchAryeo(p.sourceUrl);
  }
  if (kind === "AUTOHDR") {
    // Oct 14 2026: the hub's own AutoHDR shoot (display.ts bought each photo
    // once). The stored link lasts 6 hours; an expired one is refreshed free.
    if (p.sourceUrl) {
      try {
        return await fetchAryeo(p.sourceUrl);
      } catch (e) {
        if (!(e instanceof PhotoSourceError) || e.kind === "transient") throw e;
      }
    }
    try {
      const { freshAutohdrUrl } = await import("../display");
      return await fetchAryeo(await freshAutohdrUrl(p));
    } catch (e) {
      if (e instanceof PhotoSourceError) throw e;
      const msg = (e as Error).message;
      throw new PhotoSourceError(`autohdr photo: ${msg}`, /not downloaded/.test(msg) ? "transient" : "refused", /not downloaded/.test(msg) ? "the photo is still being brought over from AutoHDR" : "AutoHDR could not give the photo just now");
    }
  }
  throw new PhotoSourceError(`unknown photo source ${kind}`, "unsupported", `the photo source "${kind}" is not supported`);
}
