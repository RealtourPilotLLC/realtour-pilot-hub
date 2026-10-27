import { Clapperboard, ExternalLink, Music } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { ReelScriptEditor } from "@/components/project/ReelScriptEditor";
import { etDateTime } from "@/lib/datetime";
import type { CurrentScript } from "@/lib/currentScript";
export { currentScriptOf, type CurrentScript } from "@/lib/currentScript";

// The locked reel recipe (hook · script · song · shot list) from Script
// Studio, rendered wherever the CREW needs it — the project page and the
// photographer's shoot screen — not just the editor's reel workspace. The
// photographer directs the agent on camera from this script, so it has to be
// in their hands in the field. Content only for creatives; the external
// Studio link is owner/admin-side (pass studioUrl only there).
//
// Oct 20 2026 (Jordan, via the scripting platform: every job shows its current
// script, kept current automatically): `current` is the platform's current
// crew script and its version (lib/scriptSync). When it is the script shown,
// the header says which version and whether the creative changed it on the
// shoot link. When the photographer's filmed record (or an office correction)
// differs from it, the record stays the script the editor cuts to and the
// platform's current one opens beneath it. A draft waiting on review is a
// status line, never text.

const PREPARING = new Set(["awaiting_review", "generating", "revising", "generating_hooks", "hooks_proposed"]);

/** "v10, changed on site by the creative, Oct 13, 10:22 AM" */
function versionWords(c: CurrentScript): string | null {
  const v = c.version != null ? `v${c.version}` : null;
  const how = c.onSiteBy ? "changed on site by the creative" : null;
  const when = c.versionAt ? etDateTime(c.versionAt) : null;
  const parts = [v, how, when].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** What the working script is, when it is the hub's own record rather than the platform's current script. */
function recordLabel(note: string | null | undefined): string {
  const n = note ?? "";
  if (/^Edited in the hub by /.test(n)) return "Script (corrected in the hub)";
  if (n.startsWith("Provided on site")) return "What was filmed (typed by the photographer)";
  if (n.startsWith("Edited on site")) return "What was filmed (edited on site by the photographer)";
  if (n.startsWith("Delivered as written")) return "What was filmed (confirmed by the photographer)";
  return "Script";
}

export function ReelScriptCard({
  hook,
  script,
  song,
  shotList,
  updatedAt,
  studioUrl,
  projectId,
  canEdit,
  current,
  recordNote,
  showClientVersion,
}: {
  hook: string | null;
  script: string | null;
  song: string | null;
  shotList: string | null;
  updatedAt: string | null;
  studioUrl?: string | null;
  /** owner/admin on the editor brief: the script can be corrected after the
   *  photographer's on-site submit (Jordan, Sep 7). Needs projectId. */
  projectId?: string;
  canEdit?: boolean;
  /** The scripting platform's current crew script and versions (currentScriptOf). */
  current?: CurrentScript | null;
  /** scriptConfirmNote: where the working script came from when it is the hub's own record. */
  recordNote?: string | null;
  /** Office views: the version the agent received. */
  showClientVersion?: boolean;
}) {
  if (!hook && !script && !current?.script) return null;
  const same = !!current?.script && (script ?? "").trim() === current.script.trim();
  const differs = !!current?.script && !same;
  const version = current ? versionWords(current) : null;
  const draftWaiting = !!current && current.draftVersion != null && current.draftVersion > (current.version ?? 0);
  const preparing = !!current && !draftWaiting && !!current.status && PREPARING.has(current.status) && !!current.script;
  return (
    // #script: the owner dashboard's Review script lands here (Oct 27 2026).
    <section id="script" className="panel-shadow scroll-mt-20 rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-4 py-2.5">
        <Clapperboard className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Reel script</h2>
        {same && version ? (
          <span className="text-[11px] text-muted-2">{version}</span>
        ) : (
          updatedAt && <span className="text-[11px] text-muted-2">updated {etDateTime(updatedAt)}</span>
        )}
        {studioUrl && (
          <a
            href={studioUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex min-h-9 items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            Script Writing <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <div className="space-y-3 p-4 text-sm">
        {(draftWaiting || preparing) && (
          <p role="status" className="rounded-lg bg-surface-2/60 px-3 py-2 text-xs text-muted">
            {draftWaiting
              ? `Version ${current!.draftVersion} is waiting on review in Script Writing. ${current!.version != null ? `The crew script below is v${current!.version} until it is released.` : "It shows here once it is released."}`
              : "A new version is being prepared in Script Writing. The crew script below is the current one."}
          </p>
        )}
        {hook && (
          <div>
            <div className="eyebrow mb-1">Hook</div>
            <p className="font-medium leading-snug">{hook}</p>
          </div>
        )}
        {script && (
          <div>
            <div className="eyebrow mb-1">{differs ? recordLabel(recordNote) : "Script"}</div>
            {canEdit && projectId ? (
              <ReelScriptEditor projectId={projectId} script={script} />
            ) : (
              <div className="max-h-80 overflow-y-auto scroll-thin rounded-xl bg-surface-2/50 p-3 leading-relaxed">
                <Markdown content={script} />
              </div>
            )}
          </div>
        )}
        {differs && (
          <details className="rounded-xl border border-border px-3 py-2" open={!script}>
            <summary className="min-h-11 cursor-pointer py-1 text-xs font-semibold sm:min-h-0">
              Current script in Script Writing{version ? ` (${version})` : ""}
            </summary>
            <div className="mt-2 max-h-80 overflow-y-auto scroll-thin rounded-xl bg-surface-2/50 p-3 leading-relaxed">
              <Markdown content={current!.script!} />
            </div>
          </details>
        )}
        {showClientVersion && current?.clientVersion != null && (
          <p className="text-xs text-muted">
            Sent to the agent: v{current.clientVersion}{current.clientSentAt ? `, ${etDateTime(current.clientSentAt)}` : ""}
            {current.version != null && current.version !== current.clientVersion ? ` (the crew script is v${current.version})` : ""}
          </p>
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
