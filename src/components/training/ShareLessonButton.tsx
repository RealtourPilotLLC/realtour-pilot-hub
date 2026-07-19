"use client";

import { useState, useTransition } from "react";
import { Link2, Check, Loader2, X } from "lucide-react";
import { setLessonShare } from "@/app/training/actions";

// Owner-only control on each training lesson: mint a public share link (and copy
// it), or revoke it. The link is /learn/<token> — viewable with no login.
export function ShareLessonButton({ lessonId, initialToken }: { lessonId: string; initialToken: string | null }) {
  const [token, setToken] = useState(initialToken);
  const [copied, setCopied] = useState(false);
  const [busy, start] = useTransition();

  const linkFor = (t: string) => `${window.location.origin}/learn/${t}`;

  const copy = async (t: string) => {
    await navigator.clipboard.writeText(linkFor(t)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const share = () =>
    start(async () => {
      const r = await setLessonShare(lessonId, true);
      if (r.ok && r.token) { setToken(r.token); await copy(r.token); }
    });

  const revoke = () =>
    start(async () => {
      const r = await setLessonShare(lessonId, false);
      if (r.ok) setToken(null);
    });

  // Stop the row's <summary> from toggling when the buttons are clicked.
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  if (!token) {
    return (
      <button
        onClick={(e) => { stop(e); share(); }}
        disabled={busy}
        title="Create a public link to share this lesson"
        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Link2 className="size-3" />} Share
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={(e) => { stop(e); copy(token); }}
        title="Copy the public link"
        className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand hover:opacity-80"
      >
        {copied ? <><Check className="size-3" /> Copied</> : <><Link2 className="size-3" /> Copy link</>}
      </button>
      <button
        onClick={(e) => { stop(e); revoke(); }}
        disabled={busy}
        title="Revoke the public link"
        className="inline-flex items-center rounded-md border border-border px-1 py-0.5 text-muted-2 hover:text-danger disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
      </button>
    </span>
  );
}
