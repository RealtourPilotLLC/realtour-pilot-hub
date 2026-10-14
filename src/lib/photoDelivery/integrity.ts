import "server-only";

import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { logJobEvent } from "./jobState";
import { alertOwnerAndKyle } from "./notifyOps";

// ---------------------------------------------------------------------------
// CUT-OFF PHOTOS ON THE LISTING (Oct 14 2026). The first live AI QC run found
// two photos on a DELIVERED Aryeo listing (2236 Gregory Dr, 38 and 3 of 52)
// that stop at exactly 2,097,152 and 6,291,456 bytes: an upload into Aryeo cut
// off at a 2 MiB chunk boundary, with no JPEG end marker. Every viewer saw the
// top of the photo and solid gray below it.
//
// This check needs no AI and no download: a byte-range request for the last
// 64 bytes of each listing photo (Aryeo's CDN answers 206), and a complete
// JPEG ends with the end-of-image marker FF D9. It runs once per gallery
// version (keyed by the gallery fingerprint), so a broken upload is flagged
// the moment the gallery lands, before Kyle delivers, and on a gallery that
// already went out. Kyle hears it on Slack whatever the QC shadow mode says:
// a file that does not open is a fact, not a judgement.
// ---------------------------------------------------------------------------

export type TailResult = { name: string; url: string; ok: boolean | null; reason: string | null; size: number | null };

let fetchImpl: typeof fetch | null = null;
/** Drills only. */
export function __setIntegrityFetchForTests(f: typeof fetch | null) {
  fetchImpl = f;
}

const JPEG = /\.(jpe?g)(\?|$)/i;

/** Does this file end like a complete JPEG? null = could not tell cheaply. */
export async function jpegTail(url: string): Promise<{ ok: boolean | null; reason: string | null; size: number | null }> {
  const f = fetchImpl ?? fetch;
  try {
    const res = await f(url, { headers: { Range: "bytes=-64" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (res.status !== 206) {
      // The host ignored the range: reading the whole file just to look is
      // not this check's job (the QC decode covers it).
      await res.body?.cancel().catch(() => {});
      return { ok: null, reason: `range not supported (${res.status})`, size: null };
    }
    const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? NaN);
    const buf = Buffer.from(await res.arrayBuffer());
    for (let i = buf.length - 2; i >= 0; i--) if (buf[i] === 0xff && buf[i + 1] === 0xd9) return { ok: true, reason: null, size: Number.isFinite(total) ? total : null };
    const mib = Number.isFinite(total) && total % 1_048_576 === 0 ? ` (stops at exactly ${total / 1_048_576} MB, an upload cut off mid-transfer)` : "";
    return { ok: false, reason: `the file has no JPEG end marker${mib}`, size: Number.isFinite(total) ? total : null };
  } catch (e) {
    return { ok: null, reason: `could not check (${(e as Error).message.slice(0, 80)})`, size: null };
  }
}

export async function checkTails(images: { name: string; url: string }[], concurrency = 6): Promise<TailResult[]> {
  const out: TailResult[] = [];
  const queue = images.filter((i) => JPEG.test(i.url) || JPEG.test(i.name));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) {
        const img = queue[next++];
        out.push({ name: img.name, url: img.url, ...(await jpegTail(img.url)) });
      }
    }),
  );
  return out;
}

/**
 * Check a job's listing gallery once per gallery version and alert on
 * cut-off files. Returns what it found; never throws.
 */
export async function checkGalleryIntegrity(jobId: string, fingerprint: string, opts: { delivered: boolean }): Promise<{ checked: number; broken: string[]; skipped: boolean }> {
  try {
    const key = `integrity:${fingerprint}`;
    const done = await prisma.photoJobEvent.findFirst({ where: { jobId, action: key }, select: { id: true } });
    if (done) return { checked: 0, broken: [], skipped: true };
    const photos = await prisma.photoAsset.findMany({ where: { jobId, status: { in: ["ACTIVE", "EXCLUDED"] }, sourceKind: "ARYEO", sourceUrl: { not: null } }, orderBy: { sequence: "asc" }, select: { name: true, sourceUrl: true } });
    if (!photos.length) return { checked: 0, broken: [], skipped: true };
    const results = await checkTails(photos.map((p) => ({ name: p.name, url: p.sourceUrl! })));
    const broken = results.filter((r) => r.ok === false);
    await logJobEvent(jobId, "integrity", key, {
      checked: results.length,
      broken: broken.map((b) => ({ name: b.name, reason: b.reason, size: b.size })),
      unknown: results.filter((r) => r.ok === null).length,
    });
    if (broken.length) {
      const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
      const project = job ? await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true } }) : null;
      const street = (project?.title ?? "a listing").split(",")[0];
      const names = broken.map((b) => b.name).join(", ");
      const what = broken.length === 1 ? "1 photo on the Aryeo listing is" : `${broken.length} photos on the Aryeo listing are`;
      await alertOwnerAndKyle({
        kind: "photo_listing_corrupt",
        title: `Cut-off photo${broken.length === 1 ? "" : "s"} on the listing: ${street}`.slice(0, 90),
        body: `${names}`.slice(0, 140),
        href: `/ops/photo-delivery/${jobId}`,
        dedupeKey: `pd-corrupt-${jobId}-${fingerprint}`,
        text: `${street}: ${what} cut off (the upload into Aryeo stopped partway, so the bottom of the photo is gray): ${names}. ${opts.delivered ? "The client can see them now. " : ""}Re-upload ${broken.length === 1 ? "it" : "them"} in Aryeo from AutoHDR${opts.delivered ? "" : " before delivering"}. ${appBase()}/ops/photo-delivery/${jobId}`,
        to: "both",
      });
    }
    return { checked: results.length, broken: broken.map((b) => b.name), skipped: false };
  } catch (e) {
    console.warn("photo integrity check failed", jobId, (e as Error).message);
    return { checked: 0, broken: [], skipped: true };
  }
}
