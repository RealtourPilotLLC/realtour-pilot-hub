"use client";

import { useState, useTransition, useRef } from "react";
import { Send, StickyNote, Star, Flag } from "lucide-react";
import { addProjectNote } from "@/app/projects/noteActions";
import { ActivityType } from "@prisma/client";
import { cn } from "@/lib/utils";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// One shared "Request" (Kyle call, Sep 16). The field that reaches BOTH the
// photographer and the editor already existed — SPECIAL_REQUEST renders on the
// shoot screen, the upload page, the editor brief and the PDF — but the chip
// said "Special request" (reads like a client-intake item), sat second, and
// nothing said who sees what; 0 of 11 such rows were ever typed by a human,
// and the same client ask for 358 N Church St was typed twice (a Note and the
// editor's Additional notes) without reaching the photographer at all. So the
// Request is first and default, every chip names its audience, and the hint
// under the box says where each one lands.
const TYPES: { type: ActivityType; label: string; hint: string; icon: typeof Star; color: string }[] = [
  {
    type: ActivityType.SPECIAL_REQUEST,
    label: "Request — the photographer and the editor see it",
    hint: "A Request lands on the photographer's shoot screen and upload page, in the editor's brief, and pings them both — text or Slack, whatever their settings say.",
    icon: Star,
    color: "#d97706",
  },
  {
    type: ActivityType.NOTE,
    label: "Note — office only",
    hint: "A Note stays on this page, for the office. The crew never sees it.",
    icon: StickyNote,
    color: "#64748b",
  },
  {
    type: ActivityType.FLAG,
    label: "Flag",
    hint: "A Flag marks an issue on the job for the office and Kyle's QC card.",
    icon: Flag,
    color: "#dc2626",
  },
];

export function ActivityComposer({ projectId, readOnly = false }: { projectId: string; readOnly?: boolean }) {
  const [type, setType] = useState<ActivityType>(ActivityType.SPECIAL_REQUEST);
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);
  const current = TYPES.find((t) => t.type === type) ?? TYPES[0];

  function submit() {
    const body = value.trim();
    if (!body) return;
    startTransition(async () => {
      try {
        // addProjectNote opens with requireAdmin(), which THROWS rather than
        // returning — a "view as" preview would otherwise blow the transition
        // up with no message on screen (review, Sep 16). Same shape as
        // ProjectMessages.submit(): the rejection becomes the note line.
        const r = await addProjectNote(projectId, body, type);
        setNote(r.message);
        if (r.ok) {
          setValue("");
          setType(ActivityType.SPECIAL_REQUEST);
        }
      } catch (e) {
        setNote(e instanceof Error ? e.message : "Couldn’t post that.");
      }
      ref.current?.focus();
    });
  }

  // A "view as" preview reads the job; it never writes on someone's behalf —
  // the same rule the editor-note card above this one applies (canEdit).
  if (readOnly) {
    return (
      <div className="rounded-xl border bg-surface-2/50 p-3">
        <p className="text-xs text-muted">
          You’re viewing as someone else — requests, notes and flags are read-only here.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-surface-2/50 p-3">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {TYPES.map((t) => {
          const Icon = t.icon;
          const active = type === t.type;
          return (
            <button
              key={t.type}
              type="button"
              onClick={() => { setType(t.type); setNote(null); }}
              className={cn(
                "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors",
                active ? "text-white" : "text-muted hover:bg-surface-2",
              )}
              style={active ? { backgroundColor: t.color } : undefined}
            >
              <Icon className="size-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>
      <AutoTextarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
        minRows={2}
        placeholder={
          type === ActivityType.SPECIAL_REQUEST
            ? "What the photographer and the editor need to know for this job…  (⌘/Ctrl + Enter to post)"
            : type === ActivityType.NOTE
              ? "An office note on this job…  (⌘/Ctrl + Enter to post)"
              : "What's wrong on this job…  (⌘/Ctrl + Enter to post)"
        }
        className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
      {/* Where this lands — one line, so nobody has to guess the audience. */}
      <p className="mt-1.5 text-[11px] leading-snug text-muted">{current.hint}</p>
      <div className="mt-2 flex items-center justify-end gap-3">
        {note && <span className="text-xs text-muted">{note}</span>}
        <button
          type="button"
          onClick={submit}
          disabled={isPending || !value.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Send className="size-3.5" />
          {type === ActivityType.SPECIAL_REQUEST ? "Post request" : "Post"}
        </button>
      </div>
    </div>
  );
}
