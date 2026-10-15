import { after, NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";
import type { DerivativeStore } from "@/lib/photoDelivery/blob";
import type { Rendered, UiSize } from "@/lib/photoDelivery/qc/derivatives";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// A QC DERIVATIVE OF ONE PHOTO, FOR STAFF (Photo Delivery page, Oct 13 2026).
//
//   GET /api/photo-delivery/img/<photoId>/<thumb256|thumb768|qc1024|qc2048>?v=<hash>
//
// The photos are a client's unreleased listing images, so: OWNER and ADMIN
// only (an owner previewing someone else may still look; nothing is written),
// the bytes always come back THROUGH this route (no blob URL, no Dropbox or
// Aryeo link, no token ever reaches the browser), and responses are
// `Cache-Control: private` so no shared cache keeps a copy.
//
// Where the bytes come from:
//   1. the private Blob store, when a private token is configured and the
//      QC run persisted this size for the photo's current version
//      (private, max-age=3600);
//   2. otherwise the derivative is rendered on the fly from the photo's
//      source (the Aryeo listing image, the Dropbox file or AutoHDR) with
//      the same sharp pipeline the QC run uses, so sizes match the stored
//      boxes (private, max-age=86400). ONE download makes every size, and
//      after the response they are saved to the private store under the
//      same key the QC run uses, so the next request, on any instance, is a
//      store hit. Bounded: a small per-instance concurrency cap (a request
//      for a photo already being rendered joins it), and a 55 s ceiling
//      inside the 60 s function limit.
// `v` is the photo's content hash: it changes when the photo does (for an
// AutoHDR photo, when its version does), so the URL is cache-busted and the
// long browser cache is safe.
// ---------------------------------------------------------------------------

const SIZES = new Set(["thumb256", "thumb768", "qc1024", "qc2048"]);
const RENDER_TIMEOUT_MS = 55_000;
const MAX_RENDERS = 3;
let rendering = 0;
const waiting: (() => void)[] = [];
type AllSizes = Record<UiSize, Rendered>;
/** Renders in progress on this instance, by photo and version. */
const inFlight = new Map<string, Promise<AllSizes>>();

async function acquire(): Promise<void> {
  if (rendering < MAX_RENDERS) {
    rendering++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(() => { rendering++; resolve(); }));
}
function release(): void {
  rendering = Math.max(0, rendering - 1);
  waiting.shift()?.();
}

function headers(etag: string, maxAge: number): Record<string, string> {
  return {
    "content-type": "image/jpeg",
    "cache-control": `private, max-age=${maxAge}`,
    etag,
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ photoId: string; size: string }> }) {
  const { photoId, size } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(photoId) || !SIZES.has(size)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await requireRole(["OWNER", "ADMIN"], { allowImpersonation: true });
  } catch {
    return NextResponse.json({ error: "Office access required." }, { status: 403 });
  }

  const photo = await prisma.photoAsset.findUnique({
    where: { id: photoId },
    select: { id: true, jobId: true, name: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, derivJson: true, derivHash: true, autohdrVersionUuid: true },
  });
  if (!photo) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // An EARLIER version (?version=<PhotoVersion id>, the lightbox's versions
  // strip): its kept 2048 px copy, resized (Oct 14 2026, huddle finding 1:
  // before this the route ignored which version was asked for and always
  // showed the current one, so "before" and "after" looked the same).
  const versionId = req.nextUrl.searchParams.get("version");
  if (versionId && /^[a-z0-9]{10,40}$/i.test(versionId)) {
    const v = await prisma.photoVersion.findUnique({ where: { id: versionId }, select: { id: true, photoId: true, autohdrVersionUuid: true, contentHash: true, derivJson: true } });
    if (!v || v.photoId !== photo.id) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const isCurrent = (!!v.autohdrVersionUuid && v.autohdrVersionUuid === photo.autohdrVersionUuid) || (!v.autohdrVersionUuid && !!v.contentHash && v.contentHash === photo.contentHash);
    if (!isCurrent) return serveVersion(req, photo.id, v, size);
  }

  // The key the QC run stores under (qc/run.ts hashOf). An AutoHDR photo's
  // content hash IS its current version (versions.ts adoptVersion), so a fix
  // or a restore changes the key. (Until Oct 15 2026 this used its own
  // "ahdr-<version>" key, which never matched what QC stored: every AutoHDR
  // photo was downloaded again for every size.)
  const autohdrPhoto = photo.sourceKind === "AUTOHDR";
  const hash = photo.contentHash || `asset:${photo.id}`;
  const etag = `"${hash.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-${size}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: headers(etag, 86400) });

  const [{ derivativeStore, readDerivative }, D] = await Promise.all([import("@/lib/photoDelivery/blob"), import("@/lib/photoDelivery/qc/derivatives")]);

  // 1. The private store.
  const store = derivativeStore();
  const ref = D.parseDerivMap(photo.derivJson)[size as "qc2048"];
  if (store && ref?.pathname && ref.url && photo.derivHash === hash) {
    const r = await readDerivative({ pathname: ref.pathname, url: ref.url });
    if (r) return new Response(r.stream, { status: 200, headers: headers(etag, 3600) });
  }

  // 2. This instance already rendered it (a QC run or an earlier request).
  const key = D.derivKey(photo.id, hash, size);
  const cached = D.derivCache.get(key);
  if (cached) return new Response(new Uint8Array(cached), { status: 200, headers: headers(etag, 86400) });

  // 3. Render from the source, bounded: one download makes every size.
  const { loadPhotoBytes, PhotoSourceError } = await import("@/lib/photoDelivery/qc/source");
  const flight = `${photo.id}:${hash}`;
  let work = inFlight.get(flight);
  let keepHere: Promise<void> | null = null;
  if (!work) {
    work = (async () => {
      await acquire();
      try {
        const bytes = await loadPhotoBytes(photo);
        const raster = await D.decodeRaster(bytes, await D.readMeta(bytes));
        const all = {} as AllSizes;
        for (const s of D.UI_SIZES) all[s] = await D.renderFromRaster(raster, s);
        return all;
      } finally {
        release();
      }
    })();
    inFlight.set(flight, work);
    const done = () => inFlight.delete(flight);
    work.then(done, done);
    // Whoever is still waiting, every size is kept: in this instance's memory
    // at once, and in the private store after the response.
    const keep = work.then(
      (all) => {
        for (const s of D.UI_SIZES) D.derivCache.set(D.derivKey(photo.id, hash, s), all[s].data);
        if (store) return keepSizes(store, photo, hash, all).catch((e: Error) => console.warn("photo-delivery img: sizes not kept", photo.id, e.message.slice(0, 160)));
      },
      () => undefined, // the response says why the photo can't be shown
    );
    try {
      after(() => keep);
    } catch {
      keepHere = keep; // no request scope (a drill): finish before answering
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const all = await Promise.race([
      work,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error("render timed out")), RENDER_TIMEOUT_MS);
      }),
    ]);
    if (keepHere) await keepHere;
    return new Response(new Uint8Array(all[size as UiSize].data), { status: 200, headers: headers(etag, autohdrPhoto ? 600 : 86400) });
  } catch (e) {
    if (e instanceof PhotoSourceError) {
      const status = e.kind === "gone" ? 404 : e.kind === "transient" ? 503 : 422;
      return NextResponse.json({ error: `This photo can't be shown: ${e.publicReason}.` }, { status, headers: { "cache-control": "no-store" } });
    }
    console.warn("photo-delivery img: render failed", photo.id, size, (e as Error).message.slice(0, 160));
    return NextResponse.json({ error: "This photo can't be shown right now." }, { status: 503, headers: { "cache-control": "no-store" } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every size of the photo's current version into the private store, recorded
 * on the photo the way the QC run records them (derivJson + derivHash), so
 * the next request on any instance reads the store instead of the source. A
 * write the QC run made meanwhile is never overwritten.
 */
async function keepSizes(store: DerivativeStore, photo: { id: string; jobId: string; contentHash: string | null; derivJson: string | null; derivHash: string | null }, hash: string, all: AllSizes): Promise<void> {
  const [{ derivativePathname }, D] = await Promise.all([import("@/lib/photoDelivery/blob"), import("@/lib/photoDelivery/qc/derivatives")]);
  // The dust crops the QC run kept for this version stay; anything for an older version goes.
  const map: Record<string, unknown> = photo.derivHash === hash ? { ...D.parseDerivMap(photo.derivJson) } : {};
  await Promise.all(
    D.UI_SIZES.map(async (s) => {
      const r = all[s];
      const ref = await store.put(derivativePathname(photo.jobId, photo.id, hash, s), r.data, "image/jpeg");
      map[s] = { w: r.w, h: r.h, pathname: ref.pathname, url: ref.url, bytes: r.data.length };
    }),
  );
  await prisma.photoAsset.updateMany({
    where: { id: photo.id, contentHash: photo.contentHash, derivHash: photo.derivHash },
    data: { derivJson: JSON.stringify(map), derivHash: hash },
  });
}

/** A kept earlier version: never changes, so it caches for a day. */
async function serveVersion(req: NextRequest, photoId: string, v: { id: string; derivJson: string | null }, size: string): Promise<Response> {
  const { versionMeta } = await import("@/lib/photoDelivery/versions");
  const kept = versionMeta(v.derivJson).preview;
  if (!kept) return NextResponse.json({ error: "This version was not kept: it came before the hub kept copies. Press Load every version in the lightbox to fetch it from AutoHDR." }, { status: 404, headers: { "cache-control": "no-store" } });
  const etag = `"ver-${v.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-${size}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: headers(etag, 86400) });
  const [{ readDerivativeBytes }, D] = await Promise.all([import("@/lib/photoDelivery/blob"), import("@/lib/photoDelivery/qc/derivatives")]);
  const key = D.derivKey(photoId, `ver-${v.id}`, size);
  const cached = D.derivCache.get(key);
  if (cached) return new Response(new Uint8Array(cached), { status: 200, headers: headers(etag, 86400) });
  const bytes = await readDerivativeBytes(kept);
  if (!bytes) return NextResponse.json({ error: "This version's copy could not be read right now." }, { status: 503, headers: { "cache-control": "no-store" } });
  let out: Buffer = bytes;
  if (size !== "qc2048") {
    await acquire();
    try {
      out = (await D.renderFromSource(bytes, await D.readMeta(bytes), size as "qc2048")).data;
    } finally {
      release();
    }
  }
  D.derivCache.set(key, out);
  return new Response(new Uint8Array(out), { status: 200, headers: headers(etag, 86400) });
}
