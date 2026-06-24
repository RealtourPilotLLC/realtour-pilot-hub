"use client";

import { useState, useTransition } from "react";
import { Bug, Sparkles, MessageSquare, Send, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { submitPlatformFeedback } from "@/app/feedback/actions";

const KINDS = [
  { key: "feature", label: "Feature request", icon: Sparkles },
  { key: "bug", label: "Bug", icon: Bug },
  { key: "feedback", label: "Feedback", icon: MessageSquare },
];

export function PlatformFeedbackForm() {
  const [kind, setKind] = useState("feature");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [by, setBy] = useState("");
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    setErr(null);
    start(async () => {
      const r = await submitPlatformFeedback({
        kind,
        title,
        body,
        submittedBy: by,
        page: typeof window !== "undefined" ? document.referrer || "the app" : undefined,
      });
      if (r.ok) {
        setDone(r.message);
        setTitle(""); setBody("");
        setTimeout(() => setDone(null), 4000);
      } else setErr(r.message);
    });
  };

  return (
    <div className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <h2 className="mb-3 text-sm font-semibold">Share an idea, request, or bug</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        {KINDS.map((k) => {
          const Icon = k.icon;
          return (
            <button
              key={k.key}
              onClick={() => setKind(k.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                kind === k.key ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-2",
              )}
            >
              <Icon className="size-3.5" /> {k.label}
            </button>
          );
        })}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={kind === "bug" ? "What's broken? (short title)" : "What would you like? (short title)"}
        className="mb-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Any details — what, why, where you saw it…"
        className="mb-2 w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={by}
          onChange={(e) => setBy(e.target.value)}
          placeholder="Your name (optional)"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button
          onClick={submit}
          disabled={pending || !title.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Submit
        </button>
      </div>
      {done && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-success"><Check className="size-3.5" /> {done}</p>
      )}
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </div>
  );
}
