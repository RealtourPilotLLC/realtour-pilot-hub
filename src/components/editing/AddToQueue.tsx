"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronLeft, Clapperboard, Loader2, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { etFullDate } from "@/lib/datetime";
import { EDITORS, type EditorKey } from "@/lib/editors";
import { addToEditorQueue, searchQueueCandidates, type QueueCandidate } from "@/app/editing/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// Owner/admin "Add a job to the editor queue" — the human override for jobs the
// automatic handoff never picks up (video added after booking, old footage,
// non-Aryeo work). Search any project → pick the editor (pre-filled with where
// the routing rules would send it) → optional note → it's in the queue and the
// editor gets pinged.

const EDITOR_CHOICES: EditorKey[] = ["kim", "remar", "luma"];

const STATUS_CHIP: Record<string, string> = {
  BOOKED: "bg-surface-2 text-muted",
  SCHEDULED: "bg-surface-2 text-muted",
  SHOT: "bg-brand-soft text-brand",
  EDITING: "bg-brand-soft text-brand",
  REVIEW: "bg-brand-soft text-brand",
  REVISION: "bg-warning/10 text-warning",
  DELIVERED: "bg-success/10 text-success",
  ON_HOLD: "bg-warning/10 text-warning",
};

export function AddToQueue() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<QueueCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<QueueCandidate | null>(null);
  const [editor, setEditor] = useState<EditorKey>("remar");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  // Debounced server search; a stale response never overwrites a newer one.
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) {
      seq.current++; // invalidate any in-flight search so it can't repopulate
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mySeq = ++seq.current;
    timer.current = setTimeout(async () => {
      const rows = await searchQueueCandidates(query).catch(() => []);
      if (seq.current === mySeq) {
        setResults(rows);
        setSearching(false);
      }
    }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, open]);

  const reset = () => {
    seq.current++; // stale in-flight searches must not land after a reset
    setQ(""); setResults([]); setPicked(null); setNote(""); setErr(null); setDone(null);
  };

  const pick = (c: QueueCandidate) => {
    setPicked(c);
    setEditor(EDITOR_CHOICES.includes(c.suggestedEditor) ? c.suggestedEditor : "remar");
    setErr(null);
    setDone(null);
  };

  const add = () => {
    if (!picked) return;
    start(async () => {
      setErr(null);
      // The action returns {ok:false} for expected failures; a thrown/network
      // error must surface too instead of silently doing nothing.
      const r = await addToEditorQueue(picked.id, editor, note).catch(() => ({
        ok: false as const,
        message: "Couldn't add it — check your connection and try again.",
      }));
      if (!r.ok) { setErr(r.message); return; }
      setDone(r.message);
      setPicked(null);
      setQ("");
      setResults([]);
      setNote("");
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button
        onClick={() => { reset(); setOpen(true); }}
        className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"
      >
        <Plus className="size-4" /> Add a job to the queue
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-brand/25 bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Clapperboard className="size-4 text-brand" /> Add a job to the editor queue
        </h2>
        <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      {done && (
        <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-success">
          <CheckCircle2 className="size-4" /> {done}
        </p>
      )}

      {!picked ? (
        <>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
              placeholder="Search by address or client…"
              className="w-full rounded-xl border border-border bg-surface-2/50 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-brand"
            />
            {searching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-2" />}
          </div>

          {results.length > 0 && (
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
              {results.map((c) => (
                <li key={c.id}>
                  {c.inQueue ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface-2/40 px-3 py-2.5">
                      <Candidate c={c} />
                      <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted">
                        Already in the queue
                        <Link href={`/edit/${c.id}`} className="font-medium text-brand hover:underline">Open →</Link>
                      </span>
                    </div>
                  ) : (
                    <button
                      onClick={() => pick(c)}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-surface-2"
                    >
                      <Candidate c={c} />
                      <span className="ml-auto shrink-0 text-xs font-medium text-brand">Select →</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {q.trim().length >= 2 && !searching && results.length === 0 && (
            <p className="mt-2 text-xs text-muted">No jobs match “{q.trim()}”.</p>
          )}
        </>
      ) : (
        <div className="mt-3 space-y-3">
          <button onClick={() => setPicked(null)} className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground">
            <ChevronLeft className="size-3.5" /> Pick a different job
          </button>
          <div className="rounded-xl border border-border bg-surface-2/40 px-3 py-2.5">
            <Candidate c={picked} />
            {!picked.hasVideo && (
              <p className="mt-1.5 text-xs text-warning">
                This order has no video on it — adding it creates a “Video — added manually” deliverable.
              </p>
            )}
            {picked.priorCut && (
              <p className="mt-1.5 text-xs text-muted">
                A cut already exists for this job, so it&rsquo;ll be queued as a <span className="font-medium text-foreground/80">new cut (revision)</span> — that keeps the finished delivery intact.
              </p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted">Who edits it?</label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {EDITOR_CHOICES.map((k) => {
                const m = EDITORS[k];
                const active = editor === k;
                return (
                  <button
                    key={k}
                    onClick={() => setEditor(k)}
                    className={cn(
                      "rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                      active ? "border-brand bg-brand-soft text-brand" : "border-border bg-surface hover:bg-surface-2",
                    )}
                  >
                    <span className="font-semibold">{m.name}</span>
                    {picked.suggestedEditor === k && <span className="ml-1.5 text-[11px] text-muted">suggested</span>}
                    <span className="block text-[11px] text-muted">{m.does}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <AutoTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minRows={2}
            placeholder="Optional note for the editor — what this cut needs…"
            className="w-full rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
          />

          <div className="flex items-center gap-2">
            <button
              onClick={add}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add to queue
            </button>
            <span className="text-[11px] text-muted-2">
              {editor === "luma"
                ? "Opens the work item for Luma — Kyle gets the dispatch ping (Luma is external)."
                : `Opens the ${picked.priorCut ? "new-cut" : "edit"} task for ${EDITORS[editor].name} and pings them.`}
            </span>
          </div>
          {err && <p className="text-xs font-medium text-danger">{err}</p>}
        </div>
      )}
    </div>
  );
}

function Candidate({ c }: { c: QueueCandidate }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="truncate text-sm font-semibold">{c.street}</span>
      <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", STATUS_CHIP[c.status] ?? "bg-surface-2 text-muted")}>
        {c.status.replace("_", " ").toLowerCase()}
      </span>
      <span className="w-full text-xs text-muted sm:w-auto">
        {c.clientName}
        {c.shootDate ? ` · shot ${etFullDate(c.shootDate)}` : ""}
        {c.deliverables.length > 0 ? ` · ${c.deliverables.join(", ")}` : ""}
      </span>
    </span>
  );
}
