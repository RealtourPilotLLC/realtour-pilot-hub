"use client";

import { useState, useTransition } from "react";
import { Plus, Loader2, X } from "lucide-react";
import { createManualTask } from "@/app/actions";
import { DELEGATE_KEYS, EDITORS } from "@/lib/editors";

// Add a to-do by hand from the Daily Tasks page. Collapsed to a button; expands
// to a compact form (title + optional notes, job/client link, due, priority,
// delegate).
export function AddTask() {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [link, setLink] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [assignee, setAssignee] = useState("kyle");
  const [msg, setMsg] = useState<string | null>(null);

  const reset = () => { setTitle(""); setNotes(""); setLink(""); setDue(""); setPriority("MEDIUM"); setAssignee("kyle"); };
  const submit = () =>
    start(async () => {
      setMsg(null);
      const r = await createManualTask({ title, notes, link, dueDate: due, priority, assignedKey: assignee });
      setMsg(r.message);
      if (r.ok) { reset(); setOpen(false); }
    });

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus className="size-4" /> Add a task
        </button>
        {msg && <span className="text-xs text-success">{msg}</span>}
      </div>
    );
  }

  return (
    <div className="panel-shadow rounded-2xl border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">New task</h3>
        <button onClick={() => { setOpen(false); setMsg(null); }} className="text-muted-2 hover:text-foreground"><X className="size-4" /></button>
      </div>
      <div className="space-y-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          placeholder="What needs to get done?"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Notes / details (optional)"
          className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Link to a job or client (optional) — e.g. an address or name"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-muted-2">
            Due
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-brand" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-2">
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-brand">
              {["URGENT", "HIGH", "MEDIUM", "LOW"].map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-2">
            Assign
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-brand">
              <option value="kyle">Kyle</option>
              <option value="jordan">Jordan</option>
              {DELEGATE_KEYS.map((k) => <option key={k} value={k}>→ {EDITORS[k].name}</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={submit}
            disabled={pending || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add task
          </button>
          <button onClick={() => { setOpen(false); reset(); setMsg(null); }} className="text-xs text-muted hover:text-foreground">Cancel</button>
          {msg && <span className="text-xs text-danger">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
