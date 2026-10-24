import "server-only";

import type { StoredCoverRef } from "@/lib/videoAnalysisCore";

// ---------------------------------------------------------------------------
// WHERE THE COVERS ARE KEPT (Oct 24 2026). A cover is a frame of a client's
// video, so it is kept like their video: internal only, never a link a client
// is handed. Two stores, chosen the way the photo QC derivatives choose
// (lib/photoDelivery/blob.ts):
//   · the PRIVATE blob store, when its token is configured (fast to serve);
//   · otherwise the hub's own Dropbox folder (/AutoHDR/Hub/projects/<job>/…),
//     the tree lib/storage.ts keeps every app-written file under.
// Never the public blob store (any object URL there is a link forever).
// Everything leaves through an access-checked route: /api/video-cover/<cut>
// for staff, /api/portal/cover/<video> for the client.
// ---------------------------------------------------------------------------

export type CoverStore = {
  put(pathname: string, bytes: Buffer): Promise<StoredCoverRef>;
  read(ref: StoredCoverRef): Promise<Buffer | null>;
  remove?(ref: StoredCoverRef): Promise<void>;
};

let testStore: CoverStore | undefined;

/** Drills only: keep covers in memory. */
export function __setCoverStoreForTests(store: CoverStore | undefined): void {
  testStore = store;
}

/** An in-memory store (drills). */
export function memoryCoverStore(): CoverStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(pathname, bytes) {
      files.set(pathname, Buffer.from(bytes));
      return { store: "memory", pathname, url: null };
    },
    async read(ref) {
      return files.get(ref.pathname) ?? null;
    },
    async remove(ref) {
      files.delete(ref.pathname);
    },
  };
}

function privateToken(): string | null {
  const t = (process.env.PHOTO_QC_BLOB_TOKEN ?? "").trim() || (process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN ?? "").trim();
  return t || null;
}

const blobStore = (token: string): CoverStore => ({
  async put(pathname, bytes) {
    const { put } = await import("@vercel/blob");
    const r = await put(pathname, bytes, {
      access: "private", token, contentType: "image/jpeg", addRandomSuffix: false, allowOverwrite: true,
      abortSignal: AbortSignal.timeout(30_000),
    });
    return { store: "blob", pathname: r.pathname, url: r.url };
  },
  async read(ref) {
    const { get } = await import("@vercel/blob");
    const r = await get(ref.url || ref.pathname, { access: "private", token, abortSignal: AbortSignal.timeout(30_000) });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  },
});

const dropboxStore: CoverStore = {
  async put(pathname, bytes) {
    const { dropboxUpload } = await import("@/lib/integrations/dropbox");
    const r = await dropboxUpload(pathname, bytes, { overwrite: true });
    return { store: "dropbox", pathname: r.pathDisplay || pathname, url: null };
  },
  async read(ref) {
    const { withinStorage, readFile } = await import("@/lib/storage");
    if (!withinStorage(ref.pathname)) return null;
    return readFile(ref.pathname).catch(() => null);
  },
};

/** Which store a NEW cover goes to. */
export function coverStore(): CoverStore {
  if (testStore) return testStore;
  const token = privateToken();
  return token ? blobStore(token) : dropboxStore;
}

/** Read a cover back from whichever store it went to. */
export async function readCover(ref: StoredCoverRef): Promise<Buffer | null> {
  if (testStore) return testStore.read(ref);
  if (ref.store === "blob") {
    const token = privateToken();
    return token ? blobStore(token).read(ref) : null;
  }
  if (ref.store === "dropbox") return dropboxStore.read(ref);
  return null;
}

/** Where cover n of a cut is written. */
export async function coverPathname(projectId: string, submissionId: string, n: number, store: CoverStore): Promise<string> {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40) || "x";
  if (store === dropboxStore) {
    const { STORAGE_PREFIX } = await import("@/lib/storage");
    return `${STORAGE_PREFIX}/projects/${safe(projectId)}/video-covers/${safe(submissionId)}-cover-${n + 1}.jpg`;
  }
  return `video-covers/${safe(projectId)}/${safe(submissionId)}-cover-${n + 1}.jpg`;
}
