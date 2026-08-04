"use client";

import { useState, useTransition } from "react";
import { ThumbsUp, TriangleAlert, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { submitAppointmentFeedback } from "@/app/upload/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

export function AppointmentFeedback({ projectId }: { projectId: string }) {
  const [choice, setChoice] = useState<"smooth" | "issue" | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (done) {
    return (
      <section className="mt-4 rounded-2xl border bg-surface p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-success">
          <Check className="size-4" /> {done}
        </div>
      </section>
    );
  }

  return (
    <section className="mt-4 rounded-2xl border bg-surface p-4">
      <h2 className="text-sm font-semibold">How did the shoot go?</h2>
      <p className="mt-0.5 text-xs text-muted">Quick debrief — access, parking, the property, anything the office should know.</p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => setChoice("smooth")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium",
            choice === "smooth" ? "border-success bg-success/10 text-success" : "border-border hover:bg-surface-2",
          )}
        >
          <ThumbsUp className="size-4" /> Went smoothly
        </button>
        <button
          onClick={() => setChoice("issue")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium",
            choice === "issue" ? "border-warning bg-warning/10 text-warning" : "border-border hover:bg-surface-2",
          )}
        >
          <TriangleAlert className="size-4" /> Had issues
        </button>
      </div>
      {choice && (
        <div className="mt-3">
          <AutoTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minRows={3}
            placeholder={choice === "issue" ? "What happened? (lockbox, access, lighting, client no-show…)" : "Anything worth noting? (optional)"}
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <button
            disabled={pending || (choice === "issue" && !note.trim())}
            onClick={() =>
              start(async () => {
                const r = await submitAppointmentFeedback(projectId, choice === "smooth", note);
                setDone(r.message);
              })
            }
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Submit debrief"}
          </button>
        </div>
      )}
    </section>
  );
}
