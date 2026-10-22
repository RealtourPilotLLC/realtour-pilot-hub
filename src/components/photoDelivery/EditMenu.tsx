"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, Crop, LandPlot, PenLine, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { ReeditBox } from "./EditTools";
import { photoTitle, useJob } from "./JobContext";
import type { PhotoView } from "./types";

// ---------------------------------------------------------------------------
// EDIT MANUALLY (Oct 22 2026). Jordan: "I want to just have an edit manually
// button on the photos so we can crop and adjust verticals / horizontals, add
// lot lines, or do an AI re-edit." The lightbox had Straighten and crop and
// Lot lines as two buttons and the AI re-edit folded away at the bottom of the
// side panel; review mode had none of them. Now one button, on both, opens the
// three:
//   · Crop and straighten: the free, exact editor (PhotoEditor, via the job's
//     openEditor), verticals, horizontals and crop;
//   · Lot lines: the boundary drawing tool (LotLinesEditor), free;
//   · AI re-edit: Kyle's own words to AutoHDR (ReeditBox) in a small window,
//     the price read first and nothing spent until he presses it.
// The office's only: not on a view-only page, and not on a photo that is
// already delivered on the Aryeo listing (it is never sent again).
// ---------------------------------------------------------------------------

const LotLinesEditor = dynamic(() => import("./LotLinesEditor"), { ssr: false });

const defaultBtn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-brand/50 bg-brand-soft px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60";

export function EditMenu({ photo, buttonClassName, align = "left" }: { photo: PhotoView; buttonClassName?: string; align?: "left" | "right" }) {
  const { openEditor, pending, readOnly } = useJob();
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<"lot" | "reedit" | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (readOnly || photo.status === "GONE" || photo.status === "ON_LISTING") return null;
  const busy = pending || photo.fixing;
  const pick = (t: "crop" | "lot" | "reedit") => {
    setOpen(false);
    if (t === "crop") openEditor(photo.id);
    else setTool(t);
  };
  const item = "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50";

  return (
    <>
      <div
        ref={wrap}
        className="relative"
        onKeyDown={(e) => {
          // Escape closes the menu, not the photo window behind it.
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={() => setOpen((v) => !v)}
          title={photo.fixing ? "An AI fix is running on this photo" : "Crop and straighten, lot lines, or an AI re-edit"}
          className={buttonClassName ?? defaultBtn}
        >
          <PenLine aria-hidden className="size-3.5" /> Edit manually <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <div role="menu" aria-label="Edit this photo" className={cn("absolute top-full z-30 mt-1 w-72 rounded-xl border border-border bg-surface p-1.5 text-foreground shadow-xl", align === "right" ? "right-0" : "left-0")}>
            <button type="button" role="menuitem" autoFocus className={item} onClick={() => pick("crop")}>
              <Crop aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="block text-sm font-medium">Crop and straighten</span>
                <span className="block text-[12px] text-muted">Fix the verticals and horizontals, or crop. Free.</span>
              </span>
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => pick("lot")}>
              <LandPlot aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="block text-sm font-medium">Lot lines</span>
                <span className="block text-[12px] text-muted">Draw the property boundary on this photo. Free.</span>
              </span>
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => pick("reedit")}>
              <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="block text-sm font-medium">AI re-edit</span>
                <span className="block text-[12px] text-muted">Say what should change and AutoHDR redoes it. Uses credits; you see how many first.</span>
              </span>
            </button>
            {photo.hubEdit?.kind === "lotLines" && (
              <p className="px-2.5 pb-1 pt-1.5 text-[12px] text-muted">This photo has lot lines. Crop and straighten starts from the photo without them; open Lot lines after it, the drawing is kept.</p>
            )}
          </div>
        )}
      </div>

      {tool === "lot" && <LotLinesEditor photoId={photo.id} onClose={() => setTool(null)} />}
      {tool === "reedit" && (
        <ModalDialog label={`AI re-edit of ${photoTitle(photo)}`} onCancel={() => setTool(null)} className="w-[min(96vw,34rem)]">
          <div className="flex items-start gap-2">
            <h2 className="flex-1 text-base font-semibold">
              AI re-edit <span className="font-normal text-muted">· {photoTitle(photo)}</span>
            </h2>
            <button type="button" onClick={() => setTool(null)} aria-label="Close" className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-2">
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <ReeditBox photo={photo} inDialog onDone={() => setTool(null)} />
        </ModalDialog>
      )}
    </>
  );
}
