"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Download, ImagePlus, ListChecks, Loader2, Quote } from "lucide-react";
import { cn } from "@/lib/utils";
import { addPhotosAction } from "@/app/ops/photo-delivery/fileActions";
import { OPEN_ADDON_STEPS, addOnConfirmLines, pairFinished } from "@/lib/photoDelivery/addOnSteps";
import { PhotoImg } from "./PhotoImg";
import { photoTitle, useJob } from "./JobContext";
import { uploadPhotoFile } from "./PhotoFiles";
import type { GateCheckView } from "./types";

// ---------------------------------------------------------------------------
// SPECIAL REQUESTS, AT THE TOP OF THE JOB (Oct 23 2026, Jordan and Kyle's
// huddle, item 7). What the client ordered or asked beyond the photos: lot
// lines and virtual staging (the delivery checklist's add-on lines, counted by
// stagingCount.ts: done, or not done yet) and the client's open requests
// about the photos. Kept short: one line each.
//
// An add-on not done shows three steps, all on this page:
//   1 · Select photos for it (tick them here),
//   2 · Download them (one file each, never a zip; the page's own download),
//   3 · Upload the finished versions: the page's Add photos, as NEW photos,
//       each next to its original (the originals stay). The new photo carries
//       the work's label, so its hold ("Virtual Staging needed") clears.
// The confirmation before Approve and deliver lists the same lines
// (AryeoPushControls, addOnSteps.addOnConfirmLines) and sends Kyle here when
// one is not done. View only: the lines, no steps.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";

export function SpecialRequests() {
  const { data, readOnly } = useJob();
  const checks = data.gate?.checks ?? [];
  const addOns = checks.filter((c) => !!c.addOn);
  const asks = checks.filter((c) => !!c.askId && !c.ok);
  const lines = useMemo(() => addOnConfirmLines(addOns), [addOns]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => setOpen(String((e as CustomEvent).detail ?? ""));
    window.addEventListener(OPEN_ADDON_STEPS, onOpen);
    return () => window.removeEventListener(OPEN_ADDON_STEPS, onOpen);
  }, []);
  if (!addOns.length && !asks.length) return null;
  const delivered = data.header.stage === "DELIVERED";
  return (
    <section id="pd-special-requests" aria-labelledby="pd-special-h" className="panel-shadow scroll-mt-24 rounded-2xl border border-border bg-surface p-4" data-special-requests>
      <h2 id="pd-special-h" className="flex items-center gap-2 text-base font-semibold">
        <ListChecks aria-hidden className="size-5 text-brand" /> Special requests
      </h2>
      <ul className="mt-2 divide-y divide-border">
        {addOns.map((c) => {
          const l = lines.find((x) => x.key === c.addOn!.key)!;
          const quote = c.addOn!.quotes[0];
          return (
            <li key={c.key} className="py-2.5 first:pt-1 last:pb-0" data-addon-line={c.addOn!.key} data-done={l.done ? "yes" : "no"}>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {l.done ? <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" /> : <CircleAlert aria-hidden className="size-4 shrink-0 text-warning" />}
                <span className={cn("font-medium", !l.done && "text-warning")}>{l.words}</span>
              </p>
              {quote && (
                <p className="mt-1 flex gap-1.5 pl-6 text-[13px] text-muted">
                  <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{quote.text} <span className="text-[12px]">({quote.from})</span></span>
                </p>
              )}
              {!l.done && !readOnly && !delivered && <AddOnSteps line={c} open={open === c.addOn!.key} onOpen={(v) => setOpen(v ? c.addOn!.key : null)} />}
            </li>
          );
        })}
        {asks.map((c) => (
          <li key={c.key} className="flex items-start gap-2 py-2.5 text-sm first:pt-1 last:pb-0" data-ask-line>
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <span className="min-w-0 break-words">
              {c.label}
              <span className="block text-[12px] text-muted">Settle it under What&rsquo;s holding this (Done, or Answer with a note).</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The three steps for add-on work not done yet: select, download, upload the finished versions next to the originals. */
function AddOnSteps({ line, open, onOpen }: { line: GateCheckView; open: boolean; onOpen: (v: boolean) => void }) {
  const { data, jobId, run, confirm, notify, pending } = useJob();
  const key = line.addOn!.key;
  const name = line.addOn!.need.replace(/\s+needed$/i, "");
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
      await run(() => addPhotosAction({ jobId, files: stored, addOn: key, nextTo: pairs }));
    }
    setBusy(null);
  };
  return (
    <div className="mt-2 pl-6" data-addon-steps={key}>
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
