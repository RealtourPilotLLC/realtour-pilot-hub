"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { finalFileChoicesAction, readFinalFileCheckReceiptAction, recordFinalFileCheckAction } from "@/app/ops/finalRenditionActions";

const ITEMS = [
  ["identity", "Correct output and version"], ["playback", "The client-viewable file plays"],
  ["audio", "Audio is present and correct"], ["frames", "First and last frames are clean"],
  ["title", "Title and branding are correct"], ["access", "The client can access this file"],
] as const;
type Choice = { id: string; title: string; url: string; duration: number | null };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HOLD = "The earlier save is unconfirmed. Check its receipt before another save. If no receipt is available, ask office staff to inspect this cut’s check history; a missing receipt does not prove the request ended.";
const control = "min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";

export function FinalRenditionCheck({ submissionId, label, round, monthly = false }: { submissionId: string; label: string; round: number; monthly?: boolean }) {
  const [open, setOpen] = useState(false), [choices, setChoices] = useState<Choice[]>([]), [mediaId, setMediaId] = useState("");
  const [message, setMessage] = useState<string | null>(null), [saved, setSaved] = useState(false), [held, setHeld] = useState(false);
  const [metadata, setMetadata] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [checks, setChecks] = useState<string[]>([]);
  const [receiptAvailable, setReceiptAvailable] = useState(false);
  const [busy, start] = useTransition();
  const busyRef = useRef(false), attempt = useRef<string | null>(null), revision = useRef(0);
  const currentMediaId = useRef(""), selectionRevision = useRef(0);
  const marker = `rtp:final-check:${submissionId}`;
  const selected = choices.find((c) => c.id === mediaId);
  const changed = () => { revision.current++; setSaved(false); };
  const chooseMedia = (id: string) => {
    if (id === currentMediaId.current) return;
    currentMediaId.current = id; selectionRevision.current++;
    // These statements attest to one exact file. Keep their native controls
    // mounted, but never carry another rendition's answers into a new choice.
    setMediaId(id); setMetadata(null); setChecks([]); changed();
  };
  const readMarker = () => { const id = sessionStorage.getItem(marker); return id && UUID.test(id) ? id : null; };
  const release = (id: string) => {
    const stored = readMarker();
    if (stored === id) sessionStorage.removeItem(marker);
    const other = stored && stored !== id ? stored : null;
    attempt.current = other; setHeld(Boolean(other)); setReceiptAvailable(Boolean(other));
  };
  useEffect(() => { queueMicrotask(() => {
    if (busyRef.current) return;
    try { const stored = sessionStorage.getItem(marker); const id = stored && UUID.test(stored) ? stored : null; if (id) { attempt.current = id; setReceiptAvailable(true); setHeld(true); setOpen(true); setMessage(`${HOLD} Unsaved form text is not restored after refresh.`); } }
    catch { setMessage("Device recovery storage is unavailable. Saving stays disabled until it is available."); setHeld(true); }
  }); }, [marker]); // marker is scoped to this cut; it is a retry guard, not server completion proof.

  const load = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const atSelection = selectionRevision.current;
    start(async () => {
      try {
        const r = await finalFileChoicesAction(submissionId);
        if (selectionRevision.current !== atSelection) {
          setOpen(true); setMessage("Your newer file choice is kept. Read the current final file again to refresh its choices."); return;
        }
        setChoices(r.choices); setOpen(true); setMessage(r.message);
        if (monthly && r.choices.length === 1) chooseMedia(r.choices[0].id);
      } catch { setOpen(true); setMessage("The final file could not be read. Your existing form input is kept; try this read again."); }
      finally { busyRef.current = false; }
    });
  };
  const save = (data: FormData) => {
    if (busyRef.current || attempt.current || held) return;
    let id: string;
    try {
      const previous = readMarker();
      if (previous) { attempt.current = previous; setReceiptAvailable(true); setHeld(true); setMessage(HOLD); return; }
      id = crypto.randomUUID(); sessionStorage.setItem(marker, id);
    } catch { setMessage("This device could not prepare a recoverable save. Nothing was submitted; keep your input and retry once device storage is available."); return; }
    attempt.current = id; setReceiptAvailable(true); busyRef.current = true;
    const atRevision = revision.current;
    data.set("submissionId", submissionId); data.set("mediaId", mediaId); data.set("attemptId", id);
    if (metadata) { data.set("duration", String(metadata.duration)); data.set("width", String(metadata.width)); data.set("height", String(metadata.height)); }
    start(async () => {
      try {
        const r = await recordFinalFileCheckAction(data);
        if (r.outcome === "confirmed" || r.outcome === "refused") {
          release(id); setSaved(r.ok && revision.current === atRevision);
          setMessage(`${r.message}${r.ok && revision.current !== atRevision ? " Your later form changes are kept and were not part of that recorded check." : ""}`);
        } else { setHeld(true); setMessage(HOLD); }
      } catch { setHeld(true); setMessage(HOLD); }
      finally { busyRef.current = false; }
    });
  };
  const reconcile = () => {
    if (busyRef.current || !attempt.current) return;
    const id = attempt.current; busyRef.current = true;
    start(async () => {
      try {
        const r = await readFinalFileCheckReceiptAction(submissionId, id);
        if (r.ok) { release(id); setSaved(false); setMessage(`${r.message} Current form edits are kept; reopen the file before recording a different check.`); }
        else setMessage(r.message);
      } catch { setMessage(HOLD); }
      finally { busyRef.current = false; }
    });
  };
  return <div className="min-w-0">
    <button type="button" onClick={open ? () => setOpen(false) : load} disabled={busy} className={`${control} hover:bg-surface-2`}>
      {busy ? "Checking…" : open ? "Close final check" : saved ? "Check another final file" : "Check client-viewable file"}
    </button>
    {/* Keep native answers mounted when folded or while an outcome is unknown. */}
    <form action={save} hidden={!open} onChange={changed} className="mt-2 max-w-xl space-y-3 rounded-xl border border-border bg-surface-2/40 p-3 text-sm">
      <p className="font-semibold">Final file · {label} · v{round}</p>
      <p className="text-muted">{monthly ? "Destination: client portal, with a backup in this job’s final Dropbox folder. Play the exact file clients receive." : "After upload, choose the exact video on Aryeo. Play that version and inspect it there."} These ticks record your check; they do not prove a full watch, a notification or client approval.</p>
      <label className="block font-medium">{monthly ? "Portal final file" : "Aryeo video"}
        <select value={mediaId} onChange={(e) => chooseMedia(e.target.value)} required className={`${control} mt-1 w-full bg-surface text-foreground`}>
          <option value="">Choose the video you checked</option>
          {choices.map((c) => <option key={c.id} value={c.id}>{c.title}{c.duration != null ? ` · ${Math.round(c.duration)}s` : ""} · {c.id.slice(0, 8)}</option>)}
        </select>
      </label>
      {selected && <div className="space-y-1">
        <video key={selected.id} src={selected.url} controls playsInline preload="metadata" onLoadedMetadata={(e) => { if (currentMediaId.current !== selected.id) return; const v = e.currentTarget; setMetadata({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }); }} onError={() => { if (currentMediaId.current === selected.id) setMetadata(null); }} className="max-h-60 w-full rounded-lg bg-black" />
        <a href={selected.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center break-all rounded-lg text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand">Open this {monthly ? "portal final" : "Aryeo"} file in a new tab</a>
        <p className="text-muted">{metadata ? `Browser loaded metadata: ${Math.round(metadata.duration)}s, ${metadata.width}×${metadata.height}. Confirm playback, sound and frames yourself.` : "Browser metadata not confirmed here. Use the file link if the embedded player cannot open it."}</p>
      </div>}
      <div className="grid gap-2 sm:grid-cols-2">{ITEMS.map(([key, words]) => <label key={key} className="flex min-h-11 items-center gap-2"><input type="checkbox" name={key} value="yes" checked={checks.includes(key)} onChange={(e) => { setChecks((current) => e.target.checked ? [...current.filter((item) => item !== key), key] : current.filter((item) => item !== key)); changed(); }} required className="size-4 accent-brand focus-visible:outline-2 focus-visible:outline-brand" />{words}</label>)}</div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || held || !mediaId || saved} className={`${control} bg-brand-action text-brand-fg`}>Record final-file check</button>
        <button type="button" onClick={load} disabled={busy} className={control}>Read current final file</button>
      </div>
    </form>
    {held && receiptAvailable && <button type="button" onClick={reconcile} disabled={busy} className={`${control} mt-2`}>Check earlier save receipt</button>}
    {message && <p role={saved ? "status" : "alert"} className={`mt-1 text-sm ${saved ? "text-success" : "text-warning"}`}>{message}</p>}
  </div>;
}
