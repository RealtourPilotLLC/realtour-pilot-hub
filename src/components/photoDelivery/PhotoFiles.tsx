"use client";

import { useRef, useState } from "react";
import { Download, ImagePlus, Loader2, Replace } from "lucide-react";
import { cn } from "@/lib/utils";
import { addPhotosAction, replaceWithUploadAction } from "@/app/ops/photo-delivery/fileActions";
import { photoTitle, useJob } from "./JobContext";
import type { PhotoView } from "./types";

// ---------------------------------------------------------------------------
// A PHOTO'S FILES, BY HAND (Oct 22 2026). Jordan: "we should be able to
// download photos, and then replace them with an upload, or add photos to the
// gallery manually."
//   · Download (the lightbox): the current file at full size, and the
//     original when the hub changed it. Also on the view-only desk. Only
//     what the hub already has: never a paid AutoHDR download.
//   · Replace with an upload (the lightbox): Kyle's fixed file becomes the
//     photo's new current version; the one before stays under Versions.
//   · Add photos (the gallery): new photos at the end of the delivery order.
// Files go from the browser straight to the hub's PRIVATE store (the
// photo-upload route hands out a token for one path), then the server reads
// them back, checks and converts them (lib/photoDelivery/hubFiles.ts).
// JPEG, PNG, HEIC or TIFF; a HEIC this browser can open is turned into a
// JPEG here first (the server can't read most iPhone HEIC files).
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";
const ACCEPT = ".jpg,.jpeg,.png,.heic,.heif,.tif,.tiff,image/jpeg,image/png,image/heic,image/heif,image/tiff";
const MAX_BYTES = 120 * 1024 * 1024;
const TYPE_OF: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff" };

/** A HEIC photo as a JPEG, when this browser can open it (Safari can); null when it can't. */
async function heicToJpeg(file: File): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")?.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.95));
    c.width = 0;
    c.height = 0;
    return blob && blob.size > 1024 ? blob : null;
  } catch {
    return null;
  }
}

/** One file into the hub's private store, for a photo (`target` = its id) or a new one ("new"). */
export async function uploadPhotoFile(file: File, jobId: string, target: string, onPct: (n: number) => void): Promise<{ pathname: string; fileName: string }> {
  let ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? "").toLowerCase();
  if (!TYPE_OF[ext]) {
    const byType = Object.entries(TYPE_OF).find(([, t]) => t === file.type)?.[0];
    if (!byType) throw new Error(`${file.name}: upload a JPEG, PNG, HEIC or TIFF photo.`);
    ext = byType;
  }
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 120 MB.`);
  let body: Blob = file;
  if (ext === "heic" || ext === "heif") {
    const jpeg = await heicToJpeg(file);
    if (!jpeg) throw new Error(`${file.name}: this browser can't open HEIC photos. Export it as JPEG first (or use Safari).`);
    body = jpeg;
    ext = "jpg";
  }
  const stem = file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "photo";
  const { upload } = await import("@vercel/blob/client");
  const up = await upload(`photo-uploads/${jobId}/${target}/${stem}.${ext}`, body, {
    access: "private",
    handleUploadUrl: "/api/photo-delivery/photo-upload",
    clientPayload: JSON.stringify({ jobId, target }),
    contentType: TYPE_OF[ext],
    multipart: body.size > 8 * 1024 * 1024,
    onUploadProgress: ({ percentage }) => onPct(Math.round(percentage)),
  });
  return { pathname: up.pathname, fileName: file.name };
}

/** Download the photo at full size: the current file, and the original when the hub changed it. On the view-only desk too. */
export function DownloadLinks({ photo }: { photo: PhotoView }) {
  if (photo.status === "GONE") return null;
  const href = (which: "current" | "original") => `/api/photo-delivery/download/${encodeURIComponent(photo.id)}?which=${which}&v=${encodeURIComponent(photo.contentHash ?? "")}`;
  return (
    <>
      <a href={href("current")} download className={btn} title="The full-size file, as it gets delivered (only what the hub already has: never a paid download)">
        <Download aria-hidden className="size-3.5" /> Download
      </a>
      {photo.hubEdit && (
        <a href={href("original")} download className={btn} title="The photo's own file, before the hub's edits">
          <Download aria-hidden className="size-3.5" /> Download original
        </a>
      )}
    </>
  );
}

/** Replace the photo with Kyle's own file (edited in Lightroom or Photoshop): the office's, never on a view-only page. */
export function ReplaceWithUpload({ photo }: { photo: PhotoView }) {
  const { jobId, run, confirm, pending, readOnly, notify } = useJob();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (readOnly || photo.status === "GONE" || photo.status === "ON_LISTING") return null;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const ok = await confirm({
      title: `Replace ${photoTitle(photo)} with ${file.name}?`,
      body: "Your file becomes the photo's current version: what the gallery shows and what gets delivered. The one before stays under Versions, with Restore. Its findings stay as they are, so check them against your file.",
      confirmLabel: "Replace with this file",
    });
    if (!ok) return;
    let stored: { pathname: string; fileName: string };
    try {
      setBusy("Uploading… 0%");
      stored = await uploadPhotoFile(file, jobId, photo.id, (n) => setBusy(`Uploading… ${n}%`));
    } catch (e) {
      setBusy(null);
      notify("err", e instanceof Error && e.message ? e.message : "The upload didn't go through. Try again.");
      return;
    }
    setBusy("Saving the new version…");
    await run(() => replaceWithUploadAction({ jobId, photoId: photo.id, baseHash: photo.contentHash, stored: { pathname: stored.pathname }, fileName: stored.fileName }));
    setBusy(null);
  };
  return (
    <>
      <button type="button" className={btn} disabled={pending || !!busy || photo.fixing} onClick={() => input.current?.click()} title={photo.fixing ? "An AI fix is running on this photo" : "Put your own edited file in this photo's place (JPEG, PNG, HEIC or TIFF)"}>
        {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Replace aria-hidden className="size-3.5" />} {busy ?? "Replace with an upload"}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void pick(f);
        }}
      />
    </>
  );
}

/** Add photos to the gallery by hand (a photo shot later, one edited outside AutoHDR): the office's. */
export function AddPhotosButton({ className }: { className?: string }) {
  const { data, jobId, run, confirm, pending, readOnly, notify } = useJob();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const stage = data.header.stage;
  if (readOnly || stage === "DELIVERED" || stage === "DELIVERING" || stage === "DELIVERY_MISMATCH") return null;
  const pick = async (list: File[]) => {
    if (!list.length) return;
    if (list.length > 40) {
      notify("err", "Add at most 40 photos at a time.");
      return;
    }
    const ok = await confirm({
      title: list.length === 1 ? `Add ${list[0].name} to the gallery?` : `Add these ${list.length} photos to the gallery?`,
      body: "They go in the delivery, at the end of the order (move them like any other photo), marked as added by hand. They are sent with Approve and deliver.",
      confirmLabel: list.length === 1 ? "Add the photo" : `Add ${list.length} photos`,
    });
    if (!ok) return;
    const files: { pathname: string; fileName: string }[] = [];
    const failed: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      try {
        setBusy(`Uploading ${i + 1} of ${list.length}… 0%`);
        files.push(await uploadPhotoFile(f, jobId, "new", (n) => setBusy(`Uploading ${i + 1} of ${list.length}… ${n}%`)));
      } catch (e) {
        failed.push(e instanceof Error && e.message ? e.message : `${f.name}: the upload didn't go through`);
      }
    }
    if (failed.length) notify("err", failed.slice(0, 2).join(" "));
    if (files.length) {
      setBusy("Adding them to the gallery…");
      await run(() => addPhotosAction({ jobId, files }));
    }
    setBusy(null);
  };
  return (
    <>
      <button type="button" disabled={pending || !!busy} onClick={() => input.current?.click()} className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-60", className)} title="Upload photos into this job's gallery (JPEG, PNG, HEIC or TIFF)">
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ImagePlus aria-hidden className="size-4" />} {busy ?? "Add photos"}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = "";
          void pick(list);
        }}
      />
    </>
  );
}
