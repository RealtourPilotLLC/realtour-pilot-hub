"use client";

import { useState, useTransition } from "react";
import { listingFinalChoicesAction, recordListingFinalCheckAction } from "@/app/ops/finalRenditionActions";

const ITEMS = [
  ["identity", "Correct output and version"],
  ["playback", "The client-viewable file plays"],
  ["audio", "Audio is present and correct"],
  ["frames", "First and last frames are clean"],
  ["title", "Title and branding are correct"],
  ["access", "The client can access this file"],
] as const;

type Choice = { id: string; title: string; url: string; duration: number | null };

export function FinalRenditionCheck({ submissionId, label, round }: { submissionId: string; label: string; round: number }) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [mediaId, setMediaId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [metadata, setMetadata] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [busy, start] = useTransition();
  const selected = choices.find((c) => c.id === mediaId);

  const load = () => start(async () => {
    setMessage(null);
    const r = await listingFinalChoicesAction(submissionId).catch(() => ({ ok: false, message: "Could not read Aryeo. Try again.", choices: [] }));
    setChoices(r.choices);
    setOpen(true);
    if (!r.ok || r.choices.length === 0) setMessage(r.message);
  });

  const save = (data: FormData) => start(async () => {
    setMessage(null);
    data.set("submissionId", submissionId);
    data.set("mediaId", mediaId);
    if (metadata) {
      data.set("duration", String(metadata.duration));
      data.set("width", String(metadata.width));
      data.set("height", String(metadata.height));
    }
    const r = await recordListingFinalCheckAction(data).catch(() => ({ ok: false, message: "The check did not save. Try again." }));
    setMessage(r.message);
    setSaved(r.ok);
  });

  return (
    <div className="min-w-0">
      <button type="button" onClick={open ? () => setOpen(false) : load} disabled={busy}
        className="min-h-9 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-2 disabled:opacity-50">
        {busy ? "Checking…" : open ? "Close final check" : saved ? "Check another final file" : "Check client-viewable file"}
      </button>
      {open && <form action={save} className="mt-2 max-w-xl space-y-3 rounded-xl border border-border bg-surface-2/40 p-3 text-xs">
        <p className="font-semibold">Final file · {label} · v{round}</p>
        <p className="text-muted">After upload, choose the exact video on Aryeo. Play that version and inspect it there. These ticks record your check; they do not prove a full watch.</p>
        <label className="block font-medium">Aryeo video
          <select value={mediaId} onChange={(e) => { setMediaId(e.target.value); setMetadata(null); setSaved(false); }} required
            className="mt-1 min-h-10 w-full rounded-lg border border-border bg-surface px-2 text-foreground">
            <option value="">Choose the video you checked</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.title}{c.duration != null ? ` · ${Math.round(c.duration)}s` : ""} · {c.id.slice(0, 8)}</option>)}
          </select>
        </label>
        {selected && <div className="space-y-1">
          <video key={selected.id} src={selected.url} controls playsInline preload="metadata"
            onLoadedMetadata={(e) => { const v = e.currentTarget; setMetadata({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }); }}
            onError={() => setMetadata(null)} className="max-h-60 w-full rounded-lg bg-black" />
          <a href={selected.url} target="_blank" rel="noreferrer" className="inline-block break-all text-brand hover:underline">Open this Aryeo file in a new tab</a>
          <p className="text-muted">{metadata ? `Browser loaded metadata: ${Math.round(metadata.duration)}s, ${metadata.width}×${metadata.height}. Confirm playback, sound and frames yourself.` : "Browser metadata not confirmed here. Use the file link if the embedded player cannot open it."}</p>
        </div>}
        <div className="grid gap-2 sm:grid-cols-2">
          {ITEMS.map(([key, words]) => <label key={key} className="flex min-h-9 items-center gap-2"><input type="checkbox" name={key} value="yes" required />{words}</label>)}
        </div>
        <button type="submit" disabled={busy || !mediaId || saved} className="min-h-10 rounded-lg bg-brand px-3 font-semibold text-white disabled:opacity-50">Record final-file check</button>
      </form>}
      {message && <p role={saved ? "status" : "alert"} className={`mt-1 text-xs ${saved ? "text-success" : "text-warning"}`}>{message}</p>}
    </div>
  );
}
