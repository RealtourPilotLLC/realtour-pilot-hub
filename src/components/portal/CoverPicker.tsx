"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalPickCover } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { KitCovers } from "@/lib/videoAnalysis";

// ---------------------------------------------------------------------------
// THE INSTAGRAM COVER, IN THE POSTING KIT (Oct 24 2026; lib/videoAnalysis).
// Three frames from their video, our pick chosen; they can choose another and
// download the chosen one beside the video. Every picture comes through the
// portal's own cover door with a media token, never a storage link.
// ---------------------------------------------------------------------------

export function CoverPicker({ videoId, covers }: { videoId: string; covers: KitCovers }) {
  const router = useRouter();
  const [selected, setSelected] = useState(covers.selected);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const chosen = covers.options.find((o) => o.n === selected) ?? covers.options[0];
  const pick = (n: number) => {
    if (!covers.canPick || n === selected) return;
    const before = selected;
    setSelected(n);
    start(async () => {
      const r = await portalPickCover(portalAuthFromLocation(), videoId, n).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      if (!r.ok) { setSelected(before); setMsg(r.message); } else { setMsg(null); router.refresh(); }
    });
  };
  return (
    <div className="mt-3" data-cover-picker>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Instagram cover</div>
      <p className="mt-1 text-xs text-muted">
        {covers.canPick ? "We picked the first one. Tap another to use it instead." : "The cover we picked for this video."} On your profile grid Instagram shows the middle of it.
      </p>
      <div className="mt-2 grid max-w-sm grid-cols-3 gap-2">
        {covers.options.map((o) => {
          const on = o.n === selected;
          return (
            <button
              key={o.n}
              type="button"
              onClick={() => pick(o.n)}
              disabled={busy || !covers.canPick}
              aria-pressed={on}
              aria-label={`Cover ${o.n + 1}${on ? ", chosen" : ""}`}
              className={cn(
                "relative overflow-hidden rounded-lg border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-default",
                on ? "border-brand" : "border-transparent hover:border-border",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={o.src} alt="" loading="lazy" className="aspect-[9/16] w-full bg-surface-2 object-cover" />
              {on && (
                <span className="absolute right-1 top-1 inline-flex items-center gap-0.5 rounded-full bg-brand-action px-1.5 py-0.5 text-[10px] font-semibold text-brand-fg">
                  <Check aria-hidden className="size-3" /> {o.n === covers.best && !covers.pickedByClient ? "Our pick" : "Chosen"}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {chosen && (
        <a
          href={chosen.downloadHref}
          download
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Download aria-hidden className="size-4" />} Download the cover
        </a>
      )}
      {msg && <p className="mt-1 text-xs text-danger">{msg}</p>}
    </div>
  );
}
