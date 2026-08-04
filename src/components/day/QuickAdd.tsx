"use client";

import { useState, useTransition } from "react";
import { Plus, Loader2, Link2, X } from "lucide-react";
import { addOwnerTodo, searchProjectsForTodo } from "@/app/day/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// Capture has to be FASTER than the thought. One field, Enter, done — the
// options only appear if you reach for them, and every one of them has a
// working default so nothing is ever required beyond the words.

const CHIP = "rounded-lg border px-2 py-1 text-[11px] font-medium transition";
const on = "border-brand bg-brand/15 text-brand";
const off = "border-border text-muted hover:bg-surface-2";

export function QuickAdd() {
  const [title, setTitle] = useState("");
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState("NEXT");
  const [energy, setEnergy] = useState("SHALLOW");
  const [estimateMin, setEstimateMin] = useState(30);
  const [planToday, setPlanToday] = useState(false);
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; label: string }[]>([]);
  const [linked, setLinked] = useState<{ id: string; label: string } | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setTitle(""); setNote(""); setPriority("NEXT"); setEnergy("SHALLOW");
    setEstimateMin(30); setPlanToday(false); setLinked(null); setQ(""); setHits([]); setOpen(false);
  };

  const submit = () => {
    if (!title.trim() || pending) return;
    start(async () => {
      await addOwnerTodo({
        title, notes: note || undefined, priority, energy, estimateMin,
        planToday, projectId: linked?.id ?? null,
        sourceNote: linked ? `Linked to ${linked.label}` : undefined,
      });
      reset();
    });
  };

  const search = (v: string) => {
    setQ(v);
    if (v.trim().length < 2) { setHits([]); return; }
    searchProjectsForTodo(v).then(setHits).catch(() => setHits([]));
  };

  return (
    <div className="panel-shadow rounded-2xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <Plus className="size-4 shrink-0 text-brand" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="What needs doing?"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-2"
        />
        <button
          onClick={submit}
          disabled={pending || !title.trim()}
          className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-2">When</span>
            {[
              { k: "NOW", label: "Today" },
              { k: "NEXT", label: "This week" },
              { k: "LATER", label: "Later" },
            ].map((p) => (
              <button key={p.k} onClick={() => setPriority(p.k)} className={`${CHIP} ${priority === p.k ? on : off}`}>
                {p.label}
              </button>
            ))}
            <span className="ml-2 text-[11px] text-muted-2">Kind</span>
            {[
              { k: "DEEP", label: "Deep work" },
              { k: "SHALLOW", label: "Admin" },
            ].map((p) => (
              <button key={p.k} onClick={() => setEnergy(p.k)} className={`${CHIP} ${energy === p.k ? on : off}`}>
                {p.label}
              </button>
            ))}
            <span className="ml-2 text-[11px] text-muted-2">Needs</span>
            {[15, 30, 60, 120].map((m) => (
              <button key={m} onClick={() => setEstimateMin(m)} className={`${CHIP} ${estimateMin === m ? on : off}`}>
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
            {priority !== "NOW" && (
              <button onClick={() => setPlanToday(!planToday)} className={`${CHIP} ${planToday ? on : off}`}>
                Put it in today
              </button>
            )}
          </div>

          {/* Attach it to a job so the to-do carries its own context later. */}
          {linked ? (
            <div className="flex items-center gap-2 text-xs">
              <Link2 className="size-3.5 text-muted-2" />
              <span className="min-w-0 truncate text-muted">{linked.label}</span>
              <button onClick={() => setLinked(null)} className="text-muted-2 hover:text-foreground"><X className="size-3.5" /></button>
            </div>
          ) : (
            <div className="relative">
              <input
                value={q}
                onChange={(e) => search(e.target.value)}
                placeholder="Link to a job or client (optional)"
                className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs outline-none focus:border-brand"
              />
              {hits.length > 0 && (
                <div className="absolute z-20 mt-1 max-h-44 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
                  {hits.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => { setLinked(h); setHits([]); setQ(""); }}
                      className="block w-full truncate px-2.5 py-1.5 text-left text-xs hover:bg-surface-2"
                    >
                      {h.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <AutoTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minRows={2}
            placeholder="Anything you'd forget by tomorrow (optional)"
            className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs outline-none focus:border-brand"
          />
          <button onClick={reset} className="text-[11px] text-muted-2 hover:text-foreground">Close</button>
        </div>
      )}
    </div>
  );
}
