"use client";

import { cn } from "@/lib/utils";
import type { FindingView, PhotoView } from "./types";

// ---------------------------------------------------------------------------
// Finding boxes over a photo. PhotoQcFinding.bboxJson is [x1, y1, x2, y2] in
// FULL-RESOLUTION pixels and PhotoAsset.width/height is the full-res size, so
// each box is placed in percent of the photo: it lines up at any display size
// as long as the overlay sits exactly on the image (the parent wraps the img
// tightly). Numbers match the findings list beside the photo.
// ---------------------------------------------------------------------------

const BORDER: Record<string, string> = { CRITICAL: "border-[var(--danger)]", MAJOR: "border-[var(--warning)]", MINOR: "border-white/80" };
const TAG: Record<string, string> = { CRITICAL: "bg-danger-action text-white", MAJOR: "bg-[var(--warning)] text-black", MINOR: "bg-black/75 text-white" };

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function BoxOverlay({ photo, findings, selectedId, numbers }: { photo: PhotoView; findings: FindingView[]; selectedId?: string | null; numbers: Map<string, number> }) {
  const W = photo.width;
  const H = photo.height;
  if (!W || !H) return null;
  const boxes = findings.filter((f) => f.bbox && f.photoId === photo.id);
  if (!boxes.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {boxes.map((f) => {
        const [x1, y1, x2, y2] = f.bbox!;
        const left = clamp((Math.min(x1, x2) / W) * 100);
        const top = clamp((Math.min(y1, y2) / H) * 100);
        const width = clamp((Math.abs(x2 - x1) / W) * 100);
        const height = clamp((Math.abs(y2 - y1) / H) * 100);
        const on = selectedId === f.id;
        return (
          <div
            key={f.id}
            className={cn("absolute rounded-sm border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]", BORDER[f.severity] ?? BORDER.MINOR, on && "border-[3px] ring-2 ring-white/70", f.status !== "OPEN" && "border-dashed opacity-60")}
            style={{ left: `${left}%`, top: `${top}%`, width: `${Math.min(width, 100 - left)}%`, height: `${Math.min(height, 100 - top)}%` }}
          >
            <span className={cn("absolute -top-px left-0 -translate-y-full rounded-t px-1 text-[11px] font-bold leading-4", TAG[f.severity] ?? TAG.MINOR)}>{numbers.get(f.id) ?? ""}</span>
          </div>
        );
      })}
    </div>
  );
}
