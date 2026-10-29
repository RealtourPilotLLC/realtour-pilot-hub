"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { PhotoImg } from "./PhotoImg";
import { photoSrc } from "./format";
import type { FindingView, PhotoView } from "./types";

// ---------------------------------------------------------------------------
// THE EDIT BESIDE THE CAMERA'S OWN FRAME (Oct 29 2026, Jordan: "Build a
// comparison"). A cut-off roof or a warp finding the hub compared with the
// photographer's own frame of the same shot (geometry.ts, cameraFrame.ts)
// shows both, with what the comparison found, so Kyle no longer opens the
// raw folder to check ("Checked raws, they're the same"). Each opens full
// size in a new tab.
// ---------------------------------------------------------------------------

const ROOF = "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED";

/** What the comparison found, in a line. Pure. */
export function cameraLine(ruleId: string, verdict: string): string {
  if (ruleId === ROOF) {
    if (verdict === "capture") return "Cut off in the camera's frame too: it was framed that way at the shoot.";
    if (verdict === "edit") return "The camera's frame has sky above the roof: the edit cut it off.";
    return "Could not tell where it was cut: compare the two.";
  }
  if (verdict === "edit") return "Straight in the camera's frame: the edit bent the lines.";
  if (verdict === "same") return "Bows the same in the camera's frame: not the edit.";
  return "Compare the two.";
}

function CameraImg({ photoId, findingId, alt }: { photoId: string; findingId: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span role="img" aria-label={`${alt} (not available)`} className="flex aspect-[3/2] w-full items-center justify-center rounded-lg bg-surface-2 text-muted">
        <ImageOff aria-hidden className="size-5" />
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={photoSrc(photoId, "thumb768", null, null, findingId)} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className="aspect-[3/2] w-full rounded-lg bg-surface-2 object-contain" />;
}

export function CameraCompare({ f, photo, className }: { f: FindingView; photo: PhotoView | null | undefined; className?: string }) {
  if (!f.camera || !f.photoId || !photo) return null;
  const frame = f.camera.frame || "the camera's frame";
  return (
    <figure data-camera-compare={f.camera.verdict} className={cn("text-[12px]", className)}>
      <div className="grid grid-cols-2 gap-1.5">
        <a href={photoSrc(photo.id, "qc1024", photo.contentHash)} target="_blank" rel="noopener noreferrer" className="block min-w-0 focus-visible:outline-2 focus-visible:outline-brand">
          <PhotoImg photoId={photo.id} hash={photo.contentHash} fallbackUrl={photo.sourceUrl} size="thumb768" alt="The edit" className="aspect-[3/2] w-full rounded-lg bg-surface-2 object-contain" />
          <span className="mt-0.5 block text-muted">Edit</span>
        </a>
        <a href={photoSrc(photo.id, "qc1024", null, null, f.id)} target="_blank" rel="noopener noreferrer" className="block min-w-0 focus-visible:outline-2 focus-visible:outline-brand">
          <CameraImg photoId={photo.id} findingId={f.id} alt={`The camera's own frame, ${frame}`} />
          <span className="mt-0.5 block truncate text-muted">Camera&apos;s own frame · {frame}</span>
        </a>
      </div>
      <figcaption className="mt-1 text-[13px]">{cameraLine(f.ruleId, f.camera.verdict)}</figcaption>
    </figure>
  );
}
