"use client";

import { useState } from "react";
import { Camera, Loader2, MessageSquarePlus, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { LANE_CHOICES, parseClock, type ReviewKind, type ReviewLane } from "./types";

// Compact note composer shared by the image pin flow and video timestamps.
// Positioning is the PARENT's job (anchored popover next to the pin, bottom
// sheet on phones) — this is just the card. Save resolves through the parent
// so the server action + optimistic state live in one place (MediaGallery);
// we only render busy/error here.
export function NoteComposer({
  heading,
  timeLabel,
  manualTime = false,
  onSave,
  onCancel,
  className,
  style,
}: {
  heading: string;
  timeLabel?: string | null; // "at 1:23" chip when a video timestamp was captured
  manualTime?: boolean; // no playable source → let the owner type mm:ss by hand
  onSave: (
    body: string,
    lane: ReviewLane,
    kind: ReviewKind,
    manualTimeSec: number | null,
  ) => Promise<{ ok: boolean; message?: string }>;
  onCancel: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [body, setBody] = useState("");
  const [choice, setChoice] = useState(0); // default route: Kyle — fix (most common)
  const [clock, setClock] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!body.trim() || saving) return;
    setSaving(true);
    setErr(null);
    const { lane, kind } = LANE_CHOICES[choice];
    const r = await onSave(body.trim(), lane, kind, manualTime ? parseClock(clock) : null);
    setSaving(false);
    if (!r.ok) setErr(r.message ?? "Couldn't save the note.");
  }

  return (
    <div
      style={style}
      onClick={(e) => e.stopPropagation()}
      className={cn("w-80 max-w-full rounded-2xl border border-brand/40 bg-surface p-3 shadow-2xl", className)}
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-brand">
        <MessageSquarePlus className="size-3.5" /> {heading}
        {timeLabel && <span className="rounded bg-brand-soft px-1.5 py-0.5 tabular-nums">{timeLabel}</span>}
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        placeholder="What needs to change here…"
        className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      {/* One tap picks who this goes to AND what kind of note it is. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {LANE_CHOICES.map((c, i) => {
          const Icon = c.lane === "EDIT" ? Pencil : Camera;
          return (
            <button
              key={c.label}
              onClick={() => setChoice(i)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                i === choice ? "border-brand bg-brand text-white" : "border-border bg-surface hover:bg-surface-2",
              )}
            >
              <Icon className="size-3" /> {c.label}
            </button>
          );
        })}
      </div>
      {manualTime && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span>Timestamp (optional)</span>
          <input
            value={clock}
            onChange={(e) => setClock(e.target.value)}
            placeholder="mm:ss"
            className="w-20 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm tabular-nums outline-none focus:border-brand"
          />
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving || !body.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />} Save note
        </button>
        <button onClick={onCancel} className="px-1 text-xs font-medium text-muted hover:text-foreground">
          Cancel
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}
