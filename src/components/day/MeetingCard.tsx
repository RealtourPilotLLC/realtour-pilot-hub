"use client";

import { useState, useTransition } from "react";
import { Check, X, Loader2, Mail, ChevronDown, Plus, Copy } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { acceptMeeting, dismissMeeting, addMeetingItem, scanMeetings } from "@/app/day/actions";

// A meeting recap awaiting a decision. Jordan's shape: "one task with multiple
// tasks in it… tap to accept". So everything is ticked by default and Accept is
// one click — untick only what you don't want.

export type MeetingItem = { title: string; notes: string; dueInDays: number; energy: string; estimateMin: number };
export type MeetingCardData = {
  id: string;
  title: string;
  heldAt: Date;
  summary: string | null;
  draftEmail: string | null;
  items: MeetingItem[];
};

export function ScanMeetingsButton() {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() =>
          start(async () => {
            const r = await scanMeetings();
            setMsg(
              r.error
                ? r.error
                : r.created > 0
                  ? `${r.created} new recap${r.created === 1 ? "" : "s"} to review.`
                  : r.found === 0
                    ? "No Meet transcripts found this month."
                    : "Nothing new — all this month's calls are already in.",
            );
          })
        }
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 disabled:opacity-40"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Copy className="size-3" />}
        Check for new call recaps
      </button>
      {msg && <span className="text-[11px] text-muted-2">{msg}</span>}
    </div>
  );
}

export function MeetingCard({ m }: { m: MeetingCardData }) {
  const [busy, start] = useTransition();
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [openSummary, setOpenSummary] = useState(false);
  const [openEmail, setOpenEmail] = useState(false);
  const [adding, setAdding] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const toggle = (i: number) =>
    setSkip((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  const keeping = m.items.length - skip.size;
  const held = m.heldAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{m.title}</div>
          <div className="text-[11px] text-muted-2">
            {held} · {m.items.length} action item{m.items.length === 1 ? "" : "s"} found
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() =>
              start(async () => {
                const r = await acceptMeeting(m.id, [...skip]);
                if (r.error) setErr(r.error);
              })
            }
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            Accept {keeping > 0 ? keeping : ""}
          </button>
          <button
            onClick={() => start(async () => { await dismissMeeting(m.id); })}
            disabled={busy}
            className="rounded-lg border border-border px-2 py-1 text-[11px] text-muted hover:text-danger disabled:opacity-40"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {m.items.length > 0 && (
        <div className="mt-2.5 space-y-1">
          {m.items.map((it, i) => {
            const off = skip.has(i);
            return (
              <button
                key={i}
                onClick={() => toggle(i)}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-surface-2 ${off ? "opacity-40" : ""}`}
              >
                <span
                  className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${off ? "border-border" : "border-brand bg-brand text-white"}`}
                >
                  {!off && <Check className="size-2.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-xs ${off ? "line-through" : ""}`}>{it.title}</span>
                  {it.notes && <span className="block text-[11px] text-muted-2">{it.notes}</span>}
                  <span className="block text-[10px] text-muted-2">
                    due in {it.dueInDays}d · {it.energy === "DEEP" ? "deep work" : "admin"} · {it.estimateMin}m
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <Plus className="size-3 shrink-0 text-muted-2" />
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && adding.trim()) {
              e.preventDefault();
              const t = adding;
              setAdding("");
              start(async () => { await addMeetingItem(m.id, t); });
            }
          }}
          placeholder="Something it missed…"
          className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-2"
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-3 border-t border-border/60 pt-2 text-[11px]">
        {m.summary && (
          <button onClick={() => setOpenSummary(!openSummary)} className="inline-flex items-center gap-1 text-muted-2 hover:text-foreground">
            <ChevronDown className={`size-3 transition ${openSummary ? "rotate-180" : ""}`} /> Full recap
          </button>
        )}
        {m.draftEmail && (
          <button onClick={() => setOpenEmail(!openEmail)} className="inline-flex items-center gap-1 text-muted-2 hover:text-foreground">
            <Mail className="size-3" /> Follow-up draft
          </button>
        )}
      </div>

      {openSummary && m.summary && (
        <div className="mt-2 rounded-lg bg-surface p-2.5 text-xs">
          <Markdown content={m.summary} />
        </div>
      )}
      {openEmail && m.draftEmail && (
        <div className="mt-2 rounded-lg bg-surface p-2.5">
          {/* A draft, and only a draft — the hub does not send it. Copy it into
              your mail client when you're happy with the words. */}
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-2">Draft — nothing is sent from here</p>
          <textarea
            readOnly
            value={m.draftEmail}
            rows={8}
            className="w-full resize-y rounded border border-border bg-surface-2 p-2 text-[11px] leading-relaxed outline-none"
          />
        </div>
      )}

      {err && <p className="mt-1.5 text-[11px] text-danger">{err}</p>}
    </div>
  );
}
