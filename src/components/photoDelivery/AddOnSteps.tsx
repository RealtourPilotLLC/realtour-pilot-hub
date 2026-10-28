"use client";

import { useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, ImagePlus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { addPhotosAction } from "@/app/ops/photo-delivery/fileActions";
import { pairFinished } from "@/lib/photoDelivery/addOnSteps";
import { PhotoImg } from "./PhotoImg";
import { photoTitle, useJob } from "./JobContext";
import { uploadPhotoFile } from "./PhotoFiles";

// ---------------------------------------------------------------------------
// ADD-ON WORK NOT DONE YET: THREE STEPS ON THE JOB PAGE (Oct 23 2026, Jordan
// and Kyle's huddle, item 7). Lot lines or virtual staging on the order:
//   1 · Select photos for it (tick them here),
//   2 · Download them (one file each, never a zip; the page's own download),
//   3 · Upload the finished versions: the page's Add photos, as NEW photos,
//       each next to its original (the originals stay). The new photo carries
//       the work's label, so its hold ("Virtual Staging needed") clears.
// Oct 28 2026: the steps sit under the add-on's line in the job's one Client
// requests item (HoldingPanel); the Special requests card that held them is
// gone (Kyle: the same request showed twice). The office's only.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";

/** `addOn`: the add-on's key; `need`: "Virtual Staging needed". */
export function AddOnSteps({ addOn, need, open, onOpen }: { addOn: string; need: string; open: boolean; onOpen: (v: boolean) => void }) {
  const { data, jobId, run, confirm, notify, pending } = useJob();
  const name = need.replace(/\s+needed\.?$/i, "");
  const active = useMemo(() => data.photos.filter((p) => p.status === "ACTIVE"), [data.photos]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const chosen = active.filter((p) => picked.includes(p.id));
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const download = async () => {
    // One file at a time from the page's own download (never a zip, never a paid AutoHDR download).
    for (const p of chosen) {
      const a = document.createElement("a");
      a.href = `/api/photo-delivery/download/${encodeURIComponent(p.id)}?which=current&v=${encodeURIComponent(p.contentHash ?? "")}`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    const nextTo = pairFinished(files.map((f) => f.name), chosen.map((p) => ({ id: p.id, name: p.name })));
    const ok = await confirm({
      title: `Add ${files.length === 1 ? "this finished photo" : `these ${files.length} finished photos`} for ${name}?`,
      body: `Each one is added as a NEW photo right after its original (${chosen.length ? chosen.map((p) => photoTitle(p)).join(", ") : "at the end"}). The originals stay in the delivery as they are.`,
      confirmLabel: files.length === 1 ? "Add it" : `Add ${files.length}`,
    });
    if (!ok) return;
    const stored: { pathname: string; fileName: string }[] = [];
    const pairs: (string | null)[] = [];
    const failed: string[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        setBusy(`Uploading ${i + 1} of ${files.length}… 0%`);
        stored.push(await uploadPhotoFile(files[i], jobId, "new", (n) => setBusy(`Uploading ${i + 1} of ${files.length}… ${n}%`)));
        pairs.push(nextTo[i] ?? null);
      } catch (e) {
        failed.push(e instanceof Error && e.message ? e.message : `${files[i].name}: the upload didn't go through`);
      }
    }
    if (failed.length) notify("err", failed.slice(0, 2).join(" "));
    if (stored.length) {
      setBusy("Adding them next to the originals…");
      await run(() => addPhotosAction({ jobId, files: stored, addOn, nextTo: pairs }));
    }
    setBusy(null);
  };
  if (!active.length) {
    return <p className="mt-1.5 text-[12px] text-muted" data-addon-steps={addOn}>Once the photos are in, select the ones for {name} here, download them, and upload the finished versions.</p>;
  }
  return (
    <div className="mt-2" data-addon-steps={addOn}>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cn(btn, open && "border-brand/60 bg-brand-soft")} onClick={() => onOpen(!open)} aria-expanded={open}>
          1 · Select photos for it{picked.length ? ` (${picked.length})` : ""}
        </button>
        <button type="button" className={btn} disabled={!chosen.length || pending} onClick={() => void download()}>
          <Download aria-hidden className="size-3.5" /> 2 · Download {chosen.length || ""}
        </button>
        <button type="button" className={btn} disabled={pending || !!busy} onClick={() => input.current?.click()}>
          {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <ImagePlus aria-hidden className="size-3.5" />} {busy ?? "3 · Upload the finished versions"}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.heic,.heif,.tif,.tiff,image/jpeg,image/png,image/heic,image/heif,image/tiff"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = "";
            void upload(list);
          }}
        />
      </div>
      <p className="mt-1 text-[12px] text-muted">The finished versions are added as new photos next to the originals; the originals stay.</p>
      {open && (
        <ul className="mt-2 grid grid-cols-4 gap-1.5 sm:grid-cols-6 lg:grid-cols-8" aria-label={`Photos for ${name}`}>
          {active.map((p) => {
            const on = picked.includes(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  aria-pressed={on}
                  title={`${photoTitle(p)}: ${p.roomLabel}`}
                  className={cn("relative block aspect-[3/2] w-full overflow-hidden rounded-lg border-2", on ? "border-brand" : "border-transparent")}
                >
                  <PhotoImg photoId={p.id} hash={p.contentHash} fallbackUrl={p.sourceUrl} size="thumb256" alt={`${photoTitle(p)}: ${p.roomLabel}`} className="size-full object-cover" />
                  {on && <CheckCircle2 aria-hidden className="absolute right-1 top-1 size-5 rounded-full bg-white text-brand" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
