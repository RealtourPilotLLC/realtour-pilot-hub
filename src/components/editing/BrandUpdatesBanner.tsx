"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, FileImage, Globe, Loader2, Music, Palette, Sparkles, Type } from "lucide-react";
import { acknowledgeBrandChangesAction } from "@/app/edit/[id]/brand.actions";

// ---------------------------------------------------------------------------
// The editor's view of a client's brand (CP-06, Sep 24 2026), two pieces:
//
//   · BrandUpdatesBanner — what changed since the editor last said "Got it".
//     Sits at the top of the brief, where the "changes requested" line sits,
//     because a new logo mid-edit is the same kind of news. Pressing "Got it"
//     records who and closes Kyle's confirmation task. Nothing here is gated
//     by the brand_change_alerts switch — that only governs the Slack DM.
//
//   · BrandKitBlock — the latest ACTIVE version of each brand asset (logo,
//     headshot, font files), the font names, website/social links and music
//     preference, in the Media card where the colours used to sit alone.
//     "Latest active" is the registry's word: a replaced logo's old file is
//     history, and the brief never shows it.
// ---------------------------------------------------------------------------

export type BrandBannerItem = { id: string; line: string; actorLabel: string | null; createdAtISO: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function BrandUpdatesBanner({ projectId, items, canAck }: { projectId: string; items: BrandBannerItem[]; canAck: boolean }) {
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  if (items.length === 0 || done) {
    return done ? (
      <div id="brand-updates" className="flex items-center gap-2 rounded-xl border border-success/30 bg-success-soft/40 px-3.5 py-2.5 text-sm text-success">
        <CheckCircle2 className="size-4 shrink-0" /> {done}
      </div>
    ) : null;
  }
  return (
    <div id="brand-updates" className="rounded-xl border border-brand/30 bg-brand-soft/40 px-3.5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 font-medium">
        <Sparkles className="size-4 shrink-0 text-brand" />
        The client&rsquo;s brand changed — use the new version from here on
        {canAck && (
          <button
            disabled={busy}
            onClick={() => start(async () => {
              const r = await acknowledgeBrandChangesAction(projectId).catch(() => ({ ok: false, message: "That didn't save — try again." }));
              if (r.ok) { setDone(r.message); setErr(null); } else setErr(r.message);
            })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3 animate-spin" />} Got it
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {items.map((c) => (
          <li key={c.id} className="text-[13px] leading-snug text-foreground/85">
            {c.line}
            <span className="ml-1.5 text-[11px] text-muted-2">— {c.actorLabel ? `${c.actorLabel}, ` : ""}{when(c.createdAtISO)}</span>
          </li>
        ))}
      </ul>
      {err && <p className="mt-1.5 text-xs text-danger">{err}</p>}
    </div>
  );
}

export type BrandKitData = {
  colors: string[];
  colorWords: string | null;
  fontNames: string | null;
  files: { assetId: string; typeWord: string; name: string; fileName: string | null; url: string | null; versionNo: number }[];
  website: string | null;
  social: string | null;
  music: string | null;
};

export function BrandKitBlock({ kit }: { kit: BrandKitData }) {
  const empty = !kit.colors.length && !kit.colorWords && !kit.fontNames && !kit.files.length && !kit.website && !kit.social && !kit.music;
  if (empty) return null;
  const label = "mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-2";
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className={label}>Brand kit — the latest version of each</div>
      {kit.colors.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Palette className="size-3.5 text-muted" />
          {kit.colors.map((c) => (
            <span key={c} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2 py-1 text-xs font-medium">
              <span className="size-4 rounded" style={{ backgroundColor: c }} /> {c.toUpperCase()}
            </span>
          ))}
          {kit.colorWords && <span className="text-xs text-muted">{kit.colorWords}</span>}
        </div>
      )}
      {!kit.colors.length && kit.colorWords && <p className="flex items-center gap-1.5 text-xs text-muted"><Palette className="size-3.5" /> {kit.colorWords}</p>}
      {kit.files.length > 0 && (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {kit.files.map((f) => (
            <li key={f.assetId} className="flex min-w-0 items-center gap-2 rounded-lg border bg-surface px-2.5 py-1.5 text-xs">
              <FileImage className="size-3.5 shrink-0 text-muted-2" />
              <span className="shrink-0 font-semibold text-muted">{f.typeWord}</span>
              {f.url ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:text-brand">{f.fileName ?? f.name}</a>
              ) : (
                <span className="min-w-0 truncate">{f.fileName ?? f.name}</span>
              )}
              {f.versionNo > 1 && <span className="ml-auto shrink-0 text-[10px] text-muted-2">v{f.versionNo}</span>}
            </li>
          ))}
        </ul>
      )}
      {kit.fontNames && <p className="flex items-start gap-1.5 text-sm"><Type className="mt-0.5 size-3.5 shrink-0 text-muted" /> <span><span className="text-muted">Fonts:</span> {kit.fontNames}</span></p>}
      {kit.music && <p className="flex items-start gap-1.5 text-sm"><Music className="mt-0.5 size-3.5 shrink-0 text-muted" /> <span><span className="text-muted">Music:</span> {kit.music}</span></p>}
      {(kit.website || kit.social) && (
        <div className="flex items-start gap-1.5 text-sm">
          <Globe className="mt-0.5 size-3.5 shrink-0 text-muted" />
          <div className="min-w-0 space-y-0.5 break-words">
            {kit.website && <p><span className="text-muted">Website:</span> {kit.website}</p>}
            {kit.social && kit.social.split("\n").map((l, i) => <p key={i} className="text-[13px]">{l}</p>)}
          </div>
        </div>
      )}
    </div>
  );
}
