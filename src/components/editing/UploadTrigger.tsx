"use client";

import { CloudUpload, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { OPEN_UPLOAD_EVENT } from "@/components/editing/UploadPanel";

// ---------------------------------------------------------------------------
// "UPLOAD VERSION 3", WHERE THE EDITOR IS (Oct 15 2026, the brief audit). The
// job bar's main button and the end of the fix list both say it; neither is
// a second uploader. A press scrolls to the one upload row (#submit-cut) and
// opens ITS file picker, so the export check, the final check, the progress
// bar and the "still working?" question all happen in the one place they
// always have. Before the page has loaded its scripts, or when the row has no
// picker (a preview, an approved video), it is a plain link to the row.
// Oct 27 2026: the row is the upload panel under the job bar, closed until a
// press opens it (UploadPanel); `pick={false}` opens it without the picker
// (the note to the reviewer).
// ---------------------------------------------------------------------------

export function UploadTrigger({ label, redo = false, quiet = false, pick = true, className }: { label: string; redo?: boolean; quiet?: boolean; pick?: boolean; className?: string }) {
  return (
    <a
      href="#submit-cut"
      data-upload-trigger={pick ? "" : "open"}
      onClick={(e) => {
        window.dispatchEvent(new Event(OPEN_UPLOAD_EVENT));
        const row = document.getElementById("submit-cut");
        const picker = pick ? row?.querySelector<HTMLInputElement>("input[type=file][data-cut-picker]") : null;
        if (!row) return; // the link scrolls there by itself
        e.preventDefault();
        row.scrollIntoView({ behavior: "smooth", block: "start" });
        picker?.click();
      }}
      className={cn(
        "inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        quiet ? "border border-border-strong bg-surface text-foreground hover:bg-surface-2" : "bg-brand-action text-brand-fg hover:brightness-95",
        className,
      )}
    >
      {redo ? <RotateCcw className="size-4 shrink-0" /> : <CloudUpload className="size-4 shrink-0" />}
      {label}
    </a>
  );
}
