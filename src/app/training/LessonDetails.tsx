"use client";

import { useState, useTransition } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { ShareLessonButton } from "@/components/training/ShareLessonButton";
import { loadLessonText } from "./actions";

// One lesson row. Its summary and transcript load the first time it is opened
// (audit F21, Oct 20 2026), so the page no longer ships every lesson's text.
export function LessonDetails({
  id,
  title,
  embed,
  canShare,
  shareToken,
}: {
  id: string;
  title: string;
  embed: string | null;
  canShare: boolean;
  shareToken: string | null;
}) {
  const [text, setText] = useState<{ body: string; summaryMd: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, start] = useTransition();

  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || text || loading) return;
    start(async () => {
      const r = await loadLessonText(id).catch(() => ({ ok: false as const, message: "Couldn't load this lesson. Close it and open it again." }));
      if (r.ok) { setText({ body: r.body, summaryMd: r.summaryMd }); setErr(null); }
      else setErr(r.message);
    });
  };

  return (
    <details className="group/l" onToggle={onToggle}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2.5 pl-6 hover:bg-surface-2">
        <ChevronDown className="size-3.5 shrink-0 -rotate-90 text-muted-2 transition-transform group-open/l:rotate-0" />
        <span className="text-sm text-foreground/90">{title}</span>
        {embed && <span className="rounded-full bg-brand-soft px-1.5 text-[10px] font-medium text-brand">Video</span>}
        {canShare && (
          <span className="ml-auto">
            <ShareLessonButton lessonId={id} initialToken={shareToken} />
          </span>
        )}
      </summary>
      <div className="px-4 pb-4 pl-12">
        {embed && (
          <div className="mb-3 aspect-video overflow-hidden rounded-xl border border-border bg-black">
            <iframe
              src={embed}
              className="size-full"
              loading="lazy"
              title={title}
              allow="autoplay; fullscreen; picture-in-picture; clipboard-write"
              allowFullScreen
            />
          </div>
        )}
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        {!text && !err && (
          <p className="inline-flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading the lesson…
          </p>
        )}
        {text &&
          (text.summaryMd ? (
            <>
              <Markdown content={text.summaryMd} />
              <details className="group/t mt-3 border-t border-border pt-2">
                <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-2 hover:text-foreground">
                  <ChevronDown className="size-3 shrink-0 -rotate-90 transition-transform group-open/t:rotate-0" /> Full transcript
                </summary>
                <div className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">{text.body}</div>
              </details>
            </>
          ) : (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">{text.body}</div>
          ))}
      </div>
    </details>
  );
}
