import { Palette, ScrollText } from "lucide-react";
import { ClientStyleMemory } from "@/components/editing/ClientStyleMemory";
import type { StyleMemory } from "@/lib/creativeGuard";

// ---------------------------------------------------------------------------
// WHAT THE CREATIVE CHECK IS JUDGED AGAINST, in the Review Room (Oct 15
// 2026): the approved program script for THIS video, the client's brand kit
// and accepted preferences, and their style (proven format, stopped series,
// example and last approved videos). Before this the reviewer saw only the
// reel recipe, so "follows the script" and "their fonts" could not be checked
// where the approval is given. Server-rendered, read-only.
// ---------------------------------------------------------------------------

export type JudgeScript = { title: string; versionNo: number | null; text: string | null; standing: string } | null;
export type JudgeBrand = {
  colors: string[];
  colorWords: string | null;
  fontNames: string | null;
  files: { name: string; typeWord: string; url: string | null; versionNo: number }[];
  videoStyle: string | null;
  preferences: string | null;
  acceptedPreferences: string[];
  music: string | null;
} | null;

export function JudgeAgainst({ topicTitle, script, brand, style }: { topicTitle: string | null; script: JudgeScript; brand: JudgeBrand; style: StyleMemory | null }) {
  const hasBrand = !!brand && (brand.colors.length > 0 || !!brand.fontNames || brand.files.length > 0 || !!brand.videoStyle || !!brand.preferences || brand.acceptedPreferences.length > 0 || !!brand.music);
  const hasStyle = !!style && ((style.guard?.provenFormats.length ?? 0) > 0 || (style.guard?.discontinued.length ?? 0) > 0 || style.examples.length > 0 || style.recentVideos.length > 0);
  if (!script && !topicTitle && !hasBrand && !hasStyle) return null;
  // Oct 16 2026 (Jordan: "I want it to be easy. We know what to look for"):
  // reference only, one card, every part folded — the video and its notes
  // are the page; this is a tap away when a question comes up.
  const fold = "border-t border-border first:border-t-0";
  const summary = "flex min-h-11 cursor-pointer items-center gap-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
  return (
    <div className="rounded-2xl border border-border bg-surface px-4 py-1" data-judge-against>
      {(script || topicTitle) && (
        <details className={fold}>
          <summary className={summary}><ScrollText className="size-4 text-muted" aria-hidden /> The script{topicTitle ? <span className="min-w-0 truncate font-normal text-muted">· {topicTitle}</span> : null}</summary>
          <div className="pb-3">
            {script ? (
              <>
                <p className="text-xs text-muted">{script.title}{script.versionNo ? ` · version ${script.versionNo}` : ""} · {script.standing}</p>
                {script.text && <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/85">{script.text}</p>}
              </>
            ) : (
              <p className="text-xs text-muted">No script on file for this video.</p>
            )}
          </div>
        </details>
      )}
      {hasBrand && brand && (
        <details className={fold}>
          <summary className={summary}><Palette className="size-4 text-muted" aria-hidden /> Their brand</summary>
          <div className="pb-3 text-sm">
            {brand.colors.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {brand.colors.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]"><span aria-hidden className="size-3 rounded-sm border border-border" style={{ backgroundColor: c }} />{c.toUpperCase()}</span>
                ))}
                {brand.colorWords && <span className="text-xs text-muted">{brand.colorWords}</span>}
              </div>
            )}
            {brand.fontNames && <p className="mt-1.5"><span className="text-muted">Fonts:</span> {brand.fontNames}</p>}
            {brand.files.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {brand.files.map((f, i) => (
                  <li key={i} className="rounded-lg border border-border px-2 py-0.5 text-xs">
                    <span className="text-muted">{f.typeWord}</span> {f.url ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{f.name}</a> : f.name}
                  </li>
                ))}
              </ul>
            )}
            {brand.videoStyle && <p className="mt-1.5"><span className="text-muted">How they like their videos:</span> {brand.videoStyle}</p>}
            {brand.music && <p className="mt-1"><span className="text-muted">Music:</span> {brand.music}</p>}
            {brand.acceptedPreferences.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4">{brand.acceptedPreferences.map((p, i) => <li key={i}>{p}</li>)}</ul>
            )}
          </div>
        </details>
      )}
      {hasStyle && (
        <details className={fold}>
          <summary className={summary}>Their style and recent videos</summary>
          <div className="pb-3"><ClientStyleMemory memory={style} /></div>
        </details>
      )}
    </div>
  );
}
