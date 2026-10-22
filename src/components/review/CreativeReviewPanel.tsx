"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveCreativeReviewAction } from "@/app/review/checklistActions";
import type { CreativeReviewView } from "@/lib/creativeReview";
import { byLine } from "@/lib/reviewAttribution";

// ---------------------------------------------------------------------------
// CREATIVE REVIEW in the Review Room (Oct 15 2026). A client's feeling that
// they could not turn into an instruction ("too slow or too fast or
// whatever") waits here instead of reaching the editor as a task. Jordan (or
// James) reads the client's own words and does one of three things:
//   · writes the concrete changes, one per line: they go to the editor;
//   · sends it on as is, with their reading of what the client means;
//   · records that no change is needed.
// ---------------------------------------------------------------------------

function OneReview({ r, canResolve }: { r: CreativeReviewView; canResolve: boolean }) {
  const router = useRouter();
  const [changes, setChanges] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const go = (mode: "CHANGES" | "AS_IS" | "NOT_NEEDED") =>
    start(async () => {
      setMsg(null);
      const res = await resolveCreativeReviewAction({ briefId: r.briefId, mode, changes, note }).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  return (
    <div className="space-y-2 rounded-xl border border-brand/30 bg-brand-soft/20 px-3 py-2.5 text-sm" data-creative-review={r.briefId}>
      <p className="text-xs text-muted">
        {byLine(r.requestedBy ?? "The client", r.createdAtISO)} · with {r.reviewerName.split(/\s+/)[0]} because {r.reasons.join("; ")}
        {r.taskHeld ? ". The editor is waiting on this." : "."}
      </p>
      <ul className="space-y-1.5">
        {r.held.map((h) => (
          <li key={h.id}>
            <p className="border-l-2 border-brand/40 pl-2 italic text-foreground/90">&ldquo;{h.quote || h.ask}&rdquo;</p>
            <p className="pl-2 text-[11px] text-muted-2">{h.area}{h.videos.length ? ` · ${h.videos.join(", ")}` : ""}{h.label ? ` · ${h.label}` : ""}</p>
          </li>
        ))}
        {r.questions.map((q, i) => (
          <li key={`q${i}`} className="text-foreground/85">
            Open question: {q}
            {r.questionLabels[i] && <span className="ml-1 rounded bg-warning/10 px-1 py-px text-[10px] font-medium text-warning">{r.questionLabels[i]}</span>}
          </li>
        ))}
      </ul>
      {/* Oct 22 2026: what the client said about the photos went to the photo job's asks, not here. */}
      {r.photoNote && <p className="text-[11px] text-muted">{r.photoNote}</p>}
      <details>
        <summary className="cursor-pointer py-2 text-xs font-medium text-brand">Everything they said</summary>
        <p className="mt-1 whitespace-pre-wrap text-xs text-foreground/80">{r.originalText}</p>
      </details>
      {canResolve ? (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted">
            Concrete changes for the editor, one per line
            <textarea value={changes} onChange={(e) => setChanges(e.target.value)} rows={3} disabled={pending} placeholder={"Trim the opening to the first line of the hook\nCut every 2 to 3 seconds in the middle section"} className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-base sm:text-sm" />
          </label>
          <label className="block text-xs font-medium text-muted">
            Your reading of what they mean (goes with it)
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={pending} className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-base sm:text-sm" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => go("CHANGES")} disabled={pending || !changes.trim()} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 text-sm font-medium text-white disabled:opacity-50">
              {pending && <Loader2 className="size-4 animate-spin" />} Send these changes to the editor
            </button>
            <button type="button" onClick={() => go("AS_IS")} disabled={pending || !note.trim()} className="min-h-11 rounded-lg border border-border px-3 text-sm font-medium disabled:opacity-50">
              Send as is, with my reading
            </button>
            <button type="button" onClick={() => go("NOT_NEEDED")} disabled={pending || !note.trim()} className="min-h-11 rounded-lg border border-border px-3 text-sm text-muted disabled:opacity-50">
              No change needed
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">Jordan or James turns this into changes for the editor.</p>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

export function CreativeReviewPanel({ reviews, canResolve }: { reviews: CreativeReviewView[]; canResolve: boolean }) {
  if (reviews.length === 0) return null;
  return (
    <section id="creative-review" aria-label="Creative review" className="scroll-mt-24 space-y-2">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="size-4 text-brand" aria-hidden /> Creative review <span className="font-normal text-muted">· {reviews.length}</span></h2>
      {reviews.map((r) => <OneReview key={r.briefId} r={r} canResolve={canResolve} />)}
    </section>
  );
}
