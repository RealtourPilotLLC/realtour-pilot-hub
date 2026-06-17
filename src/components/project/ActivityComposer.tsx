"use client";

import { useState, useTransition, useRef } from "react";
import { Send, StickyNote, Star, Flag } from "lucide-react";
import { addNote } from "@/app/actions";
import { ActivityType } from "@prisma/client";
import { cn } from "@/lib/utils";

const TYPES = [
  { type: ActivityType.NOTE, label: "Note", icon: StickyNote, color: "#64748b" },
  { type: ActivityType.SPECIAL_REQUEST, label: "Special request", icon: Star, color: "#d97706" },
  { type: ActivityType.FLAG, label: "Flag", icon: Flag, color: "#dc2626" },
];

export function ActivityComposer({ projectId }: { projectId: string }) {
  const [type, setType] = useState<ActivityType>(ActivityType.NOTE);
  const [value, setValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const body = value.trim();
    if (!body) return;
    startTransition(async () => {
      await addNote(projectId, body, type);
      setValue("");
      setType(ActivityType.NOTE);
      ref.current?.focus();
    });
  }

  return (
    <div className="rounded-xl border bg-surface-2/50 p-3">
      <div className="mb-2 flex gap-1.5">
        {TYPES.map((t) => {
          const Icon = t.icon;
          const active = type === t.type;
          return (
            <button
              key={t.type}
              onClick={() => setType(t.type)}
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
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
        rows={2}
        placeholder="Add a note, request, or flag…  (⌘/Ctrl + Enter to post)"
        className="w-full resize-none rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={submit}
          disabled={isPending || !value.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Send className="size-3.5" />
          Post
        </button>
      </div>
    </div>
  );
}
