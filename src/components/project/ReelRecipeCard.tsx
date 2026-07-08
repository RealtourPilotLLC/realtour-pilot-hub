"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, Loader2, Check, ExternalLink, Link2, Circle } from "lucide-react";
import { saveReelRecipe } from "@/app/projects/reelActions";
import { ink } from "@/components/ui/Badge";

// The creative plan for a video/reel job — captured pre-shoot, carried to the
// editor. Editable by any crew role. The "script link" bridges to the external
// script generator/tracker until a live API sync is wired.
export function ReelRecipeCard({
  projectId,
  hook,
  script,
  song,
  shotList,
  scriptUrl,
  updatedAt,
}: {
  projectId: string;
  hook: string | null;
  script: string | null;
  song: string | null;
  shotList: string | null;
  scriptUrl: string | null;
  updatedAt: string | null;
}) {
  const router = useRouter();
  const [h, setH] = useState(hook ?? "");
  const [s, setS] = useState(script ?? "");
  const [sg, setSg] = useState(song ?? "");
  const [sl, setSl] = useState(shotList ?? "");
  const [url, setUrl] = useState(scriptUrl ?? "");
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  const dirty = h !== (hook ?? "") || s !== (script ?? "") || sg !== (song ?? "") || sl !== (shotList ?? "") || url !== (scriptUrl ?? "");
  const save = () =>
    start(async () => {
      await saveReelRecipe(projectId, { hook: h, script: s, song: sg, shotList: sl, scriptUrl: url });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    });

  const field = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand";

  return (
    <div className="panel-shadow overflow-hidden rounded-2xl border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg" style={{ background: "#a78bfa22", color: ink("#a78bfa") }}>
          <Clapperboard className="size-4" />
        </span>
        <h2 className="text-sm font-semibold">Reel recipe</h2>
        <span className="text-[11px] text-muted-2">Lock the hook, script &amp; song before you shoot</span>
        {updatedAt && !dirty && <span className="ml-auto text-[11px] text-muted-2">updated {updatedAt}</span>}
      </div>
      {/* Pre-shoot status: lock these three before you press record. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-2/40 px-4 py-2 text-[11px]">
        <span className="text-muted-2">Locked before shooting:</span>
        {([["Hook", h], ["Script", s], ["Song", sg]] as const).map(([label, val]) => (
          <span
            key={label}
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${val.trim() ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}
          >
            {val.trim() ? <Check className="size-3" /> : <Circle className="size-3" />} {label}
          </span>
        ))}
      </div>
      <div className="space-y-3 p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-2">Hook (first line — stop the scroll)</span>
          <textarea value={h} onChange={(e) => setH(e.target.value)} rows={2} placeholder="e.g. “You’ve never seen a kitchen do THIS…”" className={field} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-2">Script</span>
          <textarea value={s} onChange={(e) => setS(e.target.value)} rows={6} placeholder="The full spoken script — locked before you press record." className={field} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-2">Song</span>
            <input value={sg} onChange={(e) => setSg(e.target.value)} placeholder="Chosen before shooting" className={field} />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2"><Link2 className="size-3" /> Script tool link</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link to the script doc / generator" className={field} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-2">Shot list</span>
          <textarea value={sl} onChange={(e) => setSl(e.target.value)} rows={4} placeholder="Hook shot first · walking / standing / sitting · kitchen island · b-roll…" className={field} />
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={pending || !dirty}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : null}
            {saved ? "Saved" : "Save recipe"}
          </button>
          {url.trim() && (
            <a href={url.trim()} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
              Open script <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
