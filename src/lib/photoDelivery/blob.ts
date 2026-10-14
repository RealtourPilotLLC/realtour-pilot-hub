import "server-only";

// ---------------------------------------------------------------------------
// WHERE QC DERIVATIVES ARE KEPT (plan §3.4, prompt pack 0.2), PRIVATE ONLY.
//
// The derivatives are downsized copies of a client's UNRELEASED listing
// photos. The Blob store connected to the project today is PUBLIC (any object
// URL is a credential-free link forever: the RTP-01 audit pulled an unreleased
// video off it), so photos never go there (the lead, Oct 13 2026). They are
// persisted ONLY when a PRIVATE store token is configured:
//   REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN  the private review-cut store (its
//                                         pathnames start review-cuts/; ours
//                                         start photo-qc/, which the cut
//                                         store's own delete guard refuses)
//   PHOTO_QC_BLOB_TOKEN                   a dedicated private store, if one
//                                         is ever connected for photos
// With neither, nothing is persisted: the QC run builds derivatives in memory
// and the image route renders them on the fly from the source.
//
// Reads carry the store token server-side only (get() with the token); the
// browser only ever sees /api/photo-delivery/img/..., never a blob URL or a
// token.
// ---------------------------------------------------------------------------

export type StoredRef = { pathname: string; url: string };

export type DerivativeStore = {
  put(pathname: string, data: Buffer, contentType: string): Promise<StoredRef>;
  read(ref: StoredRef): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null; contentType: string | null } | null>;
};

const PUT_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;

/** The private store token, or null (then nothing is persisted). */
export function privateBlobToken(): string | null {
  const t = (process.env.PHOTO_QC_BLOB_TOKEN ?? "").trim() || (process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN ?? "").trim();
  return t || null;
}

const vercelPrivateStore = (token: string): DerivativeStore => ({
  async put(pathname, data, contentType) {
    const { put } = await import("@vercel/blob");
    const r = await put(pathname, data, {
      access: "private",
      token,
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      abortSignal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
    return { pathname: r.pathname, url: r.url };
  },
  async read(ref) {
    const { get } = await import("@vercel/blob");
    const r = await get(ref.url || ref.pathname, { access: "private", token, abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return { stream: r.stream, size: r.blob.size ?? null, contentType: r.blob.contentType ?? null };
  },
});

// undefined = no override; null = force "no store"; a store = use it.
let testStore: DerivativeStore | null | undefined;

/** Drills only: route derivative persistence to an in-memory fake (or force none). */
export function __setDerivativeStoreForTests(store: DerivativeStore | null | undefined): void {
  testStore = store;
}

/** The store derivatives are persisted to, or null when none is private. */
export function derivativeStore(): DerivativeStore | null {
  if (testStore !== undefined) return testStore;
  const token = privateBlobToken();
  return token ? vercelPrivateStore(token) : null;
}

/** Deterministic pathname: one object per photo, content version and size, so
 *  a rebuild overwrites instead of piling up copies. */
export function derivativePathname(jobId: string, photoId: string, contentHash: string, size: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40) || "x";
  return `photo-qc/${safe(jobId)}/${safe(photoId)}/${safe(contentHash).slice(0, 24)}/${safe(size)}.jpg`;
}

/** Persist one derivative to the private store; null when none is configured. */
export async function putDerivative(pathname: string, data: Buffer, contentType = "image/jpeg"): Promise<StoredRef | null> {
  const store = derivativeStore();
  return store ? store.put(pathname, data, contentType) : null;
}

/** A stored derivative as a stream (the image route); null when missing. */
export async function readDerivative(ref: StoredRef): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null; contentType: string | null } | null> {
  const store = derivativeStore();
  if (!store) return null;
  return store.read(ref).catch((e) => {
    console.warn("photo-qc: derivative read failed", ref.pathname, (e as Error).message);
    return null;
  });
}

/** Read a stored derivative into memory, bounded. null = missing or unreadable. */
export async function readDerivativeBytes(ref: StoredRef, maxBytes = 25 * 1024 * 1024): Promise<Buffer | null> {
  const store = derivativeStore();
  if (!store) return null;
  try {
    const r = await store.read(ref);
    if (!r) return null;
    const reader = r.stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  } catch (e) {
    console.warn("photo-qc: derivative read failed", ref.pathname, (e as Error).message);
    return null;
  }
}
