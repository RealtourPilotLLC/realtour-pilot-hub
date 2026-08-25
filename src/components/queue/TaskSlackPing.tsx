"use client";

import { useState, useTransition } from "react";
import { Hash, Loader2, Send } from "lucide-react";
import { pingTaskOnSlack, listTaskPingTargets } from "@/app/actions";

// "Ping on Slack" for one task — pick a teammate (Kyle first, he runs the day),
// add an optional note, send. The DM carries the task description + a deep link
// that lands on the highlighted card. Targets load lazily the first time the
// row opens, so pages full of cards don't pay for the roster up front.
export function TaskSlackPing({ taskId, compact }: { taskId: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<{ id: string; name: string }[] | null>(null);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const openRow = () =>
    start(async () => {
      setMsg(null);
      if (!targets) {
        const list = await listTaskPingTargets();
        // Kyle first — he's who Jordan pings to check on things.
        list.sort((a, b) => (/^kyle\b/i.test(a.name) ? -1 : /^kyle\b/i.test(b.name) ? 1 : a.name.localeCompare(b.name)));
        setTargets(list);
        const kyle = list.find((t) => /^kyle\b/i.test(t.name));
        if (kyle) setTo(kyle.id);
      }
      setOpen(true);
    });

  if (!open) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          onClick={openRow}
          disabled={busy}
          title="DM a teammate on Slack about this task, with a link to it"
          className={
            compact
              ? "inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
              : "inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
          }
        >
          {busy ? <Loader2 className={compact ? "size-4 animate-spin" : "size-3.5 animate-spin"} /> : <Hash className={compact ? "size-4" : "size-3.5"} />}
          Ping on Slack
        </button>
        {msg && <span className="text-[11px] text-muted">{msg}</span>}
      </span>
    );
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5">
      <select
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-xs outline-none focus:border-brand"
      >
        <option value="">Who should look into this?</option>
        {(targets ?? []).map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="optional note…"
        className="min-w-32 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-xs outline-none focus:border-brand"
      />
      <button
        disabled={busy || !to}
        onClick={() =>
          start(async () => {
            const r = await pingTaskOnSlack(taskId, to, note);
            setMsg(r.message);
            if (r.ok) { setOpen(false); setNote(""); }
          })
        }
        className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send
      </button>
      <button onClick={() => setOpen(false)} className="text-xs text-muted hover:text-foreground">Cancel</button>
      {msg && <span className="w-full text-[11px] text-muted">{msg}</span>}
    </div>
  );
}
