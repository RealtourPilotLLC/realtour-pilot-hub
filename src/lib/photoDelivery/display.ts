import "server-only";

import { prisma } from "@/lib/prisma";
import { autohdr } from "@/lib/integrations/autohdr";
import { photoDeliverySettings } from "./settings";
import { recordLedgerEntry } from "./credits";
import { logJobEvent } from "./jobState";

// ---------------------------------------------------------------------------
// SHOWING THE HUB'S OWN AUTOHDR PHOTOS (Oct 14 2026).
//
// Jordan: "Right now, the photos from auto HDR in the hub are not displaying.
// Please make sure they display." AutoHDR's API has no free preview: the only
// way to the pixels is POST …/photos/download, which charges 1 credit the first
// time a photo is downloaded and nothing after ("re-downloads are free and
// idempotent"). That first download is the same credit the Aryeo push has
// always charged: a photo already bought is not charged again when Kyle pushes
// the shoot. So once AutoHDR has finished a shoot the hub sent, the hub downloads
// its photos ONCE, here (logged in the credit ledger), and from then on every
// view re-downloads for free. Nothing is charged by opening a page: the image
// route only ever re-downloads a photo this file already downloaded.
//
// Behind the owner's switch `showAutohdrPhotos`. Never repeated blindly: a
// download is idempotent per photo, so asking again for a photo already bought
// costs nothing, and the ledger records whatever AutoHDR says it charged.
// ---------------------------------------------------------------------------

type Entry = { image_uuid: string; image_version_uuid: string; name: string | null; downloaded?: boolean; url?: string | null };
const parse = (json: string | null): Entry[] => {
  try {
    const a = JSON.parse(json ?? "[]") as Entry[];
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

/** First download of the photos of finished hub shoots that are not downloaded yet. */
export async function downloadForDisplay(opts: { max?: number; batchId?: string } = {}): Promise<{ skipped?: string; batches: number; photos: number; credits: number }> {
  const settings = await photoDeliverySettings();
  if (!settings.showAutohdrPhotos) return { skipped: "showing AutoHDR photos is switched off", batches: 0, photos: 0, credits: 0 };
  const batches = await prisma.photoIntakeBatch.findMany({
    where: { state: "DONE", photoshootId: { not: null }, photosJson: { not: null }, ...(opts.batchId ? { id: opts.batchId } : { doneAt: { gte: new Date(Date.now() - 6 * 86_400_000) } }) },
    orderBy: { doneAt: "asc" },
    select: { id: true, projectId: true, photoshootId: true, photosJson: true, address: true },
    take: 20,
  });
  let done = 0, photos = 0, credits = 0;
  for (const b of batches) {
    if (done >= (opts.max ?? 3)) break;
    const entries = parse(b.photosJson);
    const todo = entries.filter((e) => !e.downloaded);
    if (!todo.length) continue;
    done++;
    const job = await prisma.photoJob.findUnique({ where: { projectId: b.projectId }, select: { id: true } });
    for (let i = 0; i < todo.length; i += 50) {
      const chunk = todo.slice(i, i + 50);
      const r = await autohdr.download(b.photoshootId!, chunk.map((e) => ({ image_uuid: e.image_uuid })));
      const charged = r.data.credits_charged ?? 0;
      if (charged) {
        credits += charged;
        await recordLedgerEntry({ kind: "DOWNLOAD", credits: -charged, jobId: job?.id ?? null, ref: `${b.photoshootId}:display`, note: `${charged} photo${charged === 1 ? "" : "s"} of "${b.address ?? "a shoot"}" downloaded to show in the hub (the delivery credit: the Aryeo push will not charge them again)` });
      }
      const urls = new Map((r.data.downloads ?? []).map((d) => [d.image_uuid, d.url]));
      for (const e of chunk) {
        e.downloaded = true;
        e.url = urls.get(e.image_uuid) ?? null;
      }
      photos += chunk.length;
      await prisma.photoIntakeBatch.update({ where: { id: b.id }, data: { photosJson: JSON.stringify(entries) } });
    }
    // The gallery rows pick up the links now (they last 6 hours; views refresh them for free).
    for (const e of todo) {
      if (!e.url) continue;
      await prisma.photoAsset.updateMany({ where: { sourceKind: "AUTOHDR", sourceRef: `${b.photoshootId}/${e.image_uuid}` }, data: { sourceUrl: e.url } });
    }
    if (job) await logJobEvent(job.id, "display", `${todo.length} photo${todo.length === 1 ? "" : "s"} downloaded from AutoHDR to show in the hub${credits ? "" : " (already paid for)"}`);
  }
  return { batches: done, photos, credits };
}

/** A fresh link to a downloaded photo's CURRENT version (free). Throws when the photo was never downloaded. */
export async function freshAutohdrUrl(photo: { id: string; sourceRef: string | null }): Promise<string> {
  const [shoot, uuid] = (photo.sourceRef ?? "").split("/");
  const shootId = Number(shoot);
  if (!Number.isFinite(shootId) || !uuid) throw new Error("not an AutoHDR photo of the hub");
  const batch = await prisma.photoIntakeBatch.findFirst({ where: { photoshootId: shootId }, select: { photosJson: true } });
  const entry = parse(batch?.photosJson ?? null).find((e) => e.image_uuid === uuid);
  if (!entry?.downloaded) throw new Error("not downloaded yet");
  const r = await autohdr.download(shootId, [{ image_uuid: uuid }]);
  if ((r.data.credits_charged ?? 0) > 0) {
    await recordLedgerEntry({ kind: "DOWNLOAD", credits: -(r.data.credits_charged ?? 0), jobId: null, ref: `${shootId}:${uuid}`, note: "unexpected charge on a re-download for display" });
  }
  const url = r.data.downloads?.[0]?.url;
  if (!url) throw new Error("AutoHDR returned no link");
  await prisma.photoAsset.update({ where: { id: photo.id }, data: { sourceUrl: url } }).catch(() => {});
  return url;
}
