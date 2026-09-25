"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { portalPostMessage } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";

// The Messages tab's box (CP-13). One field and one button: the thread is a
// conversation with the office, not a form. The server answers with a
// sentence, and when the words read like a change to a video it repeats where
// those go — the message is still sent and kept, never re-routed.
export function MessageComposer({ replyToId, ownerFirst, hint }: { replyToId: string | null; ownerFirst: string; hint: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);

  const send = () => start(async () => {
    const text = body.trim();
    if (!text) { box.current?.focus(); return; }
    const r = await portalPostMessage(portalAuthFromLocation(), { body: text, replyToId }).catch(() => ({ ok: false, message: "That didn't send. Try again in a moment." }));
    setNote({ ok: r.ok, text: r.message });
    if (r.ok) { setBody(""); router.refresh(); }
  });

  return (
    <div className="space-y-2">
      <label htmlFor="program-message" className="sr-only">Message {ownerFirst}</label>
      <textarea
        id="program-message" ref={box} value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={4000}
        placeholder={`Ask ${ownerFirst} anything about your program: topics, scheduling, your brand, the month ahead.`}
        className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-base sm:text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-muted-2">{hint}</p>
        <button type="button" onClick={send} disabled={pending || !body.trim()}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send
        </button>
      </div>
      {note && <p role="status" className={note.ok ? "text-xs text-success" : "text-xs text-warning"}>{note.text}</p>}
    </div>
  );
}
