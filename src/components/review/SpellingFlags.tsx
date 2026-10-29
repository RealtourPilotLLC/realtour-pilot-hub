"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, SpellCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { markSpellingFlag } from "@/app/review/spellingActions";

// ---------------------------------------------------------------------------
// ON-SCREEN SPELLING FLAGS (Oct 24 2026; lib/videoAnalysis). During the trial
// only the owner sees them, each with Right (a real mistake) and Wrong (a false
// alarm), which is how the hub measures the check. Once Jordan turns on "Show
// spelling flags to reviewers" in Settings, the reviewer sees the same lines
// above Approve, without the buttons. It never blocks anything.
// ---------------------------------------------------------------------------

export type SpellingFlagItem = { id: string; line: string; verdict: "RIGHT" | "WRONG" | null };

function FlagRow({ submissionId, flag, owner, href }: { submissionId: string; flag: SpellingFlagItem; owner: boolean; href?: string }) {
  const router = useRouter();
  const [verdict, setVerdict] = useState(flag.verdict);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const mark = (v: "RIGHT" | "WRONG") =>
    start(async () => {
      const next = verdict === v ? null : v;
      const r = await markSpellingFlag(submissionId, flag.id, next);
      if (r.ok) { setVerdict(next); setMsg(null); router.refresh(); } else setMsg(r.message);
    });
  const btn = "inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";
  return (
    // Phone layout (Jordan, Oct 28 2026): Right and Wrong wrap under the line instead of squeezing it.
    <li data-spelling-flag={flag.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-0 flex-1 basis-48 break-words text-sm text-foreground">
        {href ? <Link href={href} className="hover:text-brand hover:underline">{flag.line}</Link> : flag.line}
      </span>
      {owner && (
        <span className="ml-auto flex flex-wrap justify-end gap-1.5">
          <button type="button" onClick={() => mark("RIGHT")} disabled={busy} aria-pressed={verdict === "RIGHT"} title="It is a real mistake on screen"
            className={cn(btn, verdict === "RIGHT" ? "border-success bg-success-soft text-success" : "border-border hover:bg-surface-2")}>
            <Check aria-hidden className="size-3.5" /> Right
          </button>
          <button type="button" onClick={() => mark("WRONG")} disabled={busy} aria-pressed={verdict === "WRONG"} title="A false alarm: the screen is fine"
            className={cn(btn, verdict === "WRONG" ? "border-danger bg-danger-soft text-danger" : "border-border hover:bg-surface-2")}>
            <X aria-hidden className="size-3.5" /> Wrong
          </button>
        </span>
      )}
      {msg && <span className="w-full text-xs text-danger">{msg}</span>}
    </li>
  );
}

/** The box above the verdict in the Review Room. */
export function SpellingFlagsNote({ submissionId, flags, owner, trialWords }: { submissionId: string; flags: SpellingFlagItem[]; owner: boolean; trialWords?: string | null }) {
  if (!flags.length) return null;
  return (
    <div role="note" data-spelling-flags className="rounded-lg border border-warning/40 bg-warning-soft/30 px-3 py-2">
      <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-foreground">
        <SpellCheck aria-hidden className="size-4 text-warning" />
        Check the spelling on screen
        {owner && <span className="text-xs font-normal text-muted">· trial, only you see this{trialWords ? ` · ${trialWords}` : ""}</span>}
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {flags.map((f) => <FlagRow key={f.id} submissionId={submissionId} flag={f} owner={owner} />)}
      </ul>
    </div>
  );
}

/** The trial's open flags (the Connections card), each linking to its video. */
export function SpellingFlagList({ items }: { items: { submissionId: string; href: string; flag: SpellingFlagItem }[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-1.5 space-y-1.5">
      {items.map((x) => <FlagRow key={`${x.submissionId}:${x.flag.id}`} submissionId={x.submissionId} flag={x.flag} owner href={x.href} />)}
    </ul>
  );
}
