import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";

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
//      source (the Aryeo listing image or the Dropbox file) with the same
//      sharp pipeline the QC run uses, so sizes match the stored boxes
//      (private, max-age=86400). Bounded: one image per request, a small
//      per-instance concurrency cap, and a 55 s ceiling inside the 60 s
//      function limit.
// `v` is the photo's content hash: it changes when the photo does, so the
// URL is cache-busted and the long browser cache is safe.
// ---------------------------------------------------------------------------

const SIZES = new Set(["thumb256", "thumb768", "qc1024", "qc2048"]);
const RENDER_TIMEOUT_MS = 55_000;
const MAX_RENDERS = 3;
let rendering = 0;
const waiting: (() => void)[] = [];

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
    select: { id: true, name: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, derivJson: true, derivHash: true, autohdrVersionUuid: true },
  });
  if (!photo) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The hub's own AutoHDR photo shows AutoHDR's CURRENT version (a fix changes it), so its version is part of the key.
  const autohdrPhoto = photo.sourceKind === "AUTOHDR";
  const hash = autohdrPhoto && photo.autohdrVersionUuid ? `ahdr-${photo.autohdrVersionUuid}` : photo.contentHash || `asset:${photo.id}`;
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

  // 3. Render from the source, bounded.
  const { loadPhotoBytes, PhotoSourceError } = await import("@/lib/photoDelivery/qc/source");
  await acquire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const bytes = await loadPhotoBytes(photo);
      const meta = await D.readMeta(bytes);
      return D.renderFromSource(bytes, meta, size as "qc2048");
    })();
    const out = await Promise.race([
      work,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error("render timed out")), RENDER_TIMEOUT_MS);
      }),
    ]);
    D.derivCache.set(key, out.data);
    return new Response(new Uint8Array(out.data), { status: 200, headers: headers(etag, autohdrPhoto ? 600 : 86400) });
  } catch (e) {
    if (e instanceof PhotoSourceError) {
      const status = e.kind === "gone" ? 404 : e.kind === "transient" ? 503 : 422;
      return NextResponse.json({ error: `This photo can't be shown: ${e.publicReason}.` }, { status, headers: { "cache-control": "no-store" } });
    }
    console.warn("photo-delivery img: render failed", photo.id, size, (e as Error).message.slice(0, 160));
    return NextResponse.json({ error: "This photo can't be shown right now." }, { status: 503, headers: { "cache-control": "no-store" } });
  } finally {
    clearTimeout(timer);
    release();
  }
}
