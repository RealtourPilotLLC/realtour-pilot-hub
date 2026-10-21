"use client";

import { useState } from "react";
import { Crop, Download, Sparkles, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { editCanSettle } from "@/lib/photoDelivery/straighten";
import { customReeditAction, reeditQuoteAction, updateOnAryeoAction } from "@/app/ops/photo-delivery/editActions";
import { photoTitle, useJob } from "./JobContext";
import type { FindingView, PhotoView } from "./types";

// ---------------------------------------------------------------------------
// THE PHOTO FIXER'S SMALL PIECES (Oct 21 2026), for the lightbox and the
// Issues tab: Straighten on a geometry finding, the hub edit's state (with
// Update on Aryeo for a photo whose listing copy is the old one), and an AI
// re-edit in Kyle's own words. Every send is a person's press, with its
// confirm; credits are shown, never dollars.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";

/** Straighten on a geometry finding (PERSP_*, framing): opens the editor on its photo (one button per photo, at most six). */
export function StraightenButtons({ findings, className }: { findings: FindingView[]; className?: string }) {
  const { openEditor, photoById, pending } = useJob();
  const ids = [...new Set(findings.filter((f) => editCanSettle(f.ruleId) && f.status === "OPEN").flatMap((f) => (f.photoId ? [f.photoId] : f.photoIds)))].filter((id) => photoById.get(id)?.status !== "GONE").slice(0, 6);
  if (!ids.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {ids.map((id) => (
        <button key={id} type="button" className={btn} disabled={pending} onClick={() => openEditor(id)} title="Straighten, fix the vertical perspective or crop this photo in the hub (free, exact)">
          <Crop aria-hidden className="size-3.5" /> Straighten{ids.length > 1 ? ` ${photoTitle(photoById.get(id))}` : ""}
        </button>
      ))}
    </div>
  );
}

/** The hub's own edit on this photo: what it is, and Update on Aryeo when the listing still has the old file. */
export function HubEditPanel({ photo }: { photo: PhotoView }) {
  const { data, jobId, run, confirm, pending } = useJob();
  const e = photo.hubEdit;
  if (!e) return null;
  const push = data.aryeoPush;
  const running = !!push.progress?.active;
  const last = push.lastUpdate && push.lastUpdate.photoIds.includes(photo.id) ? push.lastUpdate : null;
  const canPush = push.mode !== "off" && push.connected;
  const update = async () => {
    const ok = await confirm({
      title: `Update ${photoTitle(photo)} on Aryeo?`,
      body: "The hub puts the edited photo on the Aryeo listing in the old one's place, under the same name, and takes the old one off. Nothing is delivered again and no email goes out.",
      confirmLabel: "Update on Aryeo",
    });
    if (ok) await run(() => updateOnAryeoAction(jobId, [photo.id]));
  };
  return (
    <section className="mt-4 rounded-xl border border-brand/40 bg-brand-soft/40 p-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Edited in the hub</h3>
      <p className="mt-0.5 text-sm">{e.label}. This is the current version.</p>
      {e.needsListingUpdate ? (
        <>
          <p className="mt-1 text-[13px] text-muted">The Aryeo listing still has the old file.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {canPush && (
              <button type="button" className={cn(btn, "border-transparent bg-brand-action font-semibold text-brand-fg hover:brightness-95")} disabled={pending || running} onClick={() => void update()}>
                <UploadCloud aria-hidden className="size-4" /> {running && push.progress?.update ? "Updating on Aryeo…" : "Update on Aryeo"}
              </button>
            )}
            {e.downloadUrl && (
              <a href={e.downloadUrl} className={btn} download>
                <Download aria-hidden className="size-4" /> Download
              </a>
            )}
          </div>
          {!canPush && <p className="mt-1 text-[12px] text-muted">The hub&apos;s Aryeo upload is {push.mode === "off" ? "switched off" : "not connected"}: download it and replace it on the listing by hand.</p>}
        </>
      ) : (
        <p className="mt-1 text-[13px] text-muted">The 06-Ready-for-Aryeo folder and the delivery take it.</p>
      )}
      {last && <p className={cn("mt-1.5 text-[12px]", last.ok ? "text-success" : "text-danger")}>{etMonthDayTime(last.at)}: {last.note}</p>}
    </section>
  );
}

/** An AI re-edit in Kyle's own words, for one photo: the price shown first, spent only on his press. */
export function ReeditBox({ photo }: { photo: PhotoView }) {
  const { jobId, run, confirm, pending } = useJob();
  const [text, setText] = useState("");
  const [quote, setQuote] = useState<{ credits: number | null; message: string; ok: boolean } | null>(null);
  const [asking, setAsking] = useState(false);
  const load = async () => {
    if (quote || asking) return;
    setAsking(true);
    try {
      setQuote(await reeditQuoteAction(jobId));
    } catch {
      setQuote({ ok: false, credits: null, message: "The price could not be read just now." });
    } finally {
      setAsking(false);
    }
  };
  const credits = quote?.credits ?? null;
  const words = text.trim();
  const send = async () => {
    if (credits == null) return;
    const ok = await confirm({
      title: `Spend ${credits} credit${credits === 1 ? "" : "s"} on an AI re-edit?`,
      body: `AutoHDR re-edits ${photoTitle(photo)} with your words: "${words}". The hub checks the result afterwards and puts the photo back if the AI changed the house.${photo.hubEdit ? " It starts from AutoHDR's copy, without the hub's straightening: straighten it again after." : ""}`,
      confirmLabel: `Re-edit (${credits} credit${credits === 1 ? "" : "s"})`,
    });
    if (!ok) return;
    if (await run(() => customReeditAction({ jobId, photoId: photo.id, prompt: words, expectCredits: credits }))) setText("");
  };
  if (photo.status === "GONE") return null;
  return (
    <details className="mt-4 rounded-xl border border-border p-3" onToggle={(ev) => (ev.currentTarget.open ? void load() : undefined)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold [&::-webkit-details-marker]:hidden">
        <Sparkles aria-hidden className="size-4" /> AI re-edit in your own words
      </summary>
      <p className="mt-1 text-[12px] text-muted">For what straightening and cropping can&apos;t do (&quot;remove the wooden sidewalk forms&quot;). Your approval limit and the shoot&apos;s fix budget apply.</p>
      <label className="mt-2 block text-[12px] font-medium text-muted" htmlFor={`reedit-${photo.id}`}>What should change</label>
      <textarea
        id={`reedit-${photo.id}`}
        value={text}
        onChange={(ev) => setText(ev.target.value.slice(0, 400))}
        rows={3}
        placeholder="Remove the wooden sidewalk forms in front of the house"
        className="mt-1 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base sm:text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={btn} disabled={pending || asking || credits == null || !quote?.ok || words.length < 8} onClick={() => void send()}>
          <Sparkles aria-hidden className="size-4" /> {credits == null ? "Re-edit with AI" : `Re-edit with AI (${credits} credit${credits === 1 ? "" : "s"})`}
        </button>
        {asking && <span className="text-[12px] text-muted">Reading the price…</span>}
      </div>
      {quote && !quote.ok && quote.message && <p className="mt-1 text-[12px] text-danger">{quote.message}</p>}
    </details>
  );
}
