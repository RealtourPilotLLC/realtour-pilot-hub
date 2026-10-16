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
  if (!script && !hasBrand && !style) return null;
  return (
    <div className="space-y-3" data-judge-against>
      {(script || topicTitle) && (
        <div className="rounded-2xl border border-border bg-surface p-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold"><ScrollText className="size-4 text-muted" aria-hidden /> The approved script</h3>
          {topicTitle && <p className="mt-1 text-sm">{topicTitle}</p>}
          {script ? (
            <>
              <p className="text-xs text-muted">{script.title}{script.versionNo ? ` · version ${script.versionNo}` : ""} · {script.standing}</p>
              {script.text && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-medium text-brand">Read the script</summary>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/85">{script.text}</p>
                </details>
              )}
            </>
          ) : (
            <p className="text-xs text-muted">No script on file for this video.</p>
          )}
        </div>
      )}
      {hasBrand && brand && (
        <div className="rounded-2xl border border-border bg-surface p-4 text-sm">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Palette className="size-4 text-muted" aria-hidden /> Their brand</h3>
          {brand.colors.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
                  <span className="text-muted">{f.typeWord}</span> {f.url ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{f.name}</a> : f.name} <span className="text-muted-2">v{f.versionNo}</span>
                </li>
              ))}
            </ul>
          )}
          {brand.videoStyle && <p className="mt-1.5"><span className="text-muted">How they like their videos:</span> {brand.videoStyle}</p>}
          {brand.preferences && <p className="mt-1"><span className="text-muted">How they like to work:</span> {brand.preferences}</p>}
          {brand.music && <p className="mt-1"><span className="text-muted">Music:</span> {brand.music}</p>}
          {brand.acceptedPreferences.length > 0 && (
            <div className="mt-1.5">
              <p className="text-xs text-muted">Confirmed preferences</p>
              <ul className="list-disc space-y-0.5 pl-4">{brand.acceptedPreferences.map((p, i) => <li key={i}>{p}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      <ClientStyleMemory memory={style} />
    </div>
  );
}
