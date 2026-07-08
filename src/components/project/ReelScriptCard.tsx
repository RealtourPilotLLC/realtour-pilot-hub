import { Clapperboard, ExternalLink, Music } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { etDateTime } from "@/lib/datetime";

// The locked reel recipe (hook · script · song · shot list) from Script
// Studio, rendered wherever the CREW needs it — the project page and the
// photographer's shoot screen — not just the editor's reel workspace. The
// photographer directs the agent on camera from this script, so it has to be
// in their hands in the field. Content only for creatives; the external
// Studio link is owner/admin-side (pass studioUrl only there).
export function ReelScriptCard({
  hook,
  script,
  song,
  shotList,
  updatedAt,
  studioUrl,
}: {
  hook: string | null;
  script: string | null;
  song: string | null;
  shotList: string | null;
  updatedAt: string | null;
  studioUrl?: string | null;
}) {
  if (!hook && !script) return null;
  return (
    <section className="panel-shadow rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Clapperboard className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Reel script</h2>
        {updatedAt && (
          <span className="text-[11px] text-muted-2">updated {etDateTime(updatedAt)}</span>
        )}
        {studioUrl && (
          <a
            href={studioUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            Script Studio <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <div className="space-y-3 p-4 text-sm">
        {hook && (
          <div>
            <div className="eyebrow mb-1">Hook</div>
            <p className="font-medium leading-snug">{hook}</p>
          </div>
        )}
        {script && (
          <div>
            <div className="eyebrow mb-1">Script</div>
            <div className="max-h-80 overflow-y-auto scroll-thin rounded-xl bg-surface-2/50 p-3 leading-relaxed">
              <Markdown content={script} />
            </div>
          </div>
        )}
        {(song || shotList) && (
          <div className="flex flex-col gap-3 sm:flex-row">
            {song && (
              <div className="min-w-0 flex-1">
                <div className="eyebrow mb-1">Song</div>
                <p className="flex items-start gap-1.5 text-muted"><Music className="mt-0.5 size-3.5 shrink-0" />{song}</p>
              </div>
            )}
            {shotList && (
              <div className="min-w-0 flex-1">
                <div className="eyebrow mb-1">Shot list</div>
                <p className="whitespace-pre-wrap text-muted">{shotList}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
