"use client";

import { useState, useTransition } from "react";
import { Send, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { sendTeamText } from "@/app/team/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// Texting box for one teammate. Includes a one-click "morning well-wish" that
// references their next shoot today, when there is one. Nothing auto-sends —
// the message is drafted into the box for a human to review and Send.
export function TeamTextComposer({
  memberId,
  firstName,
  hasPhone,
  morningGreeting,
}: {
  memberId: string;
  firstName: string;
  hasPhone: boolean;
  morningGreeting: string | null;
}) {
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (!hasPhone) {
    return (
      <p className="text-sm text-muted">
        No phone number on file — add one in OpenPhone to text {firstName}.
      </p>
    );
  }

  return (
    <div>
      <AutoTextarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        minRows={3}
        placeholder={`Text ${firstName} via OpenPhone…`}
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          disabled={pending || !body.trim()}
          onClick={() =>
            start(async () => {
              const r = await sendTeamText(memberId, body);
              setMsg({ ok: r.ok, text: r.message });
              if (r.ok) setBody("");
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          <Send className="size-4" /> {pending ? "Sending…" : "Send text"}
        </button>
        {morningGreeting && (
          <button
            onClick={() => setBody(morningGreeting)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
          >
            <Sun className="size-4 text-warning" /> Morning well-wish
          </button>
        )}
        {msg && <span className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</span>}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-2">Review before sending — nothing auto-sends.</p>
    </div>
  );
}
