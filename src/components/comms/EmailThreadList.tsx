"use client";

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Mail, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmailThread } from "@/components/comms/emailThreads";

// Expandable email-thread list for the Communications hub. Read-only by design
// (no gmail.send scope) — clicking a row unfolds the messages inline; the
// "Open in Gmail" link is the reply path.
export function EmailThreadList({ threads }: { threads: EmailThread[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  if (threads.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
        <Mail className="mx-auto mb-2 size-6 text-muted-2" />
        <p className="text-sm text-muted">
          No client email in the last 60 days. Inbound mail lands here automatically once the Gmail sync sees it.
        </p>
      </div>
    );
  }

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="overflow-hidden rounded-2xl border bg-surface">
      {threads.map((t) => {
        const expanded = open.has(t.key);
        return (
          <div key={t.key} className="border-b last:border-0">
            {/* Row header — whole row toggles; the Gmail link stops propagation */}
            <button
              type="button"
              onClick={() => toggle(t.key)}
              className={cn("flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-2", expanded && "bg-surface-2")}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                <Mail className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{t.counterpart}</span>
                  {t.isClient && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-success-soft px-1.5 text-[10px] font-medium text-success">
                      <User className="size-2.5" /> client
                    </span>
                  )}
                  {t.count > 1 && (
                    <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-semibold text-muted">{t.count}</span>
                  )}
                </div>
                <div className="truncate text-xs text-muted">
                  <span className="font-medium text-foreground/80">{t.subject}</span>
                  <span className="text-muted-2"> — {t.snippet}</span>
                </div>
              </div>
              {/* Direction of the LATEST message: in = they wrote last (ball's in
                  our court), out = we replied last. */}
              {t.lastDirection === "in" ? (
                <ArrowDownLeft className="size-3.5 shrink-0 text-success" aria-label="received" />
              ) : (
                <ArrowUpRight className="size-3.5 shrink-0 text-muted-2" aria-label="sent" />
              )}
              <span className="shrink-0 text-xs text-muted-2">{t.lastAgo}</span>
            </button>

            {expanded && (
              <div className="space-y-3 border-t bg-surface-2/50 px-5 py-4">
                {t.messages.map((m) => (
                  <div key={m.id} className="rounded-xl border bg-surface p-3">
                    <div className="mb-1.5 flex items-center gap-2 text-xs">
                      {m.direction === "in" ? (
                        <ArrowDownLeft className="size-3 text-success" />
                      ) : (
                        <ArrowUpRight className="size-3 text-muted-2" />
                      )}
                      <span className="font-medium">{m.sender}</span>
                      <span className="ml-auto text-muted-2" title={m.ago}>{m.atLabel}</span>
                    </div>
                    {/* Bodies are often Gmail snippets, sometimes full text — a
                        capped scroll keeps one long email from eating the page. */}
                    <div className="max-h-56 overflow-y-auto whitespace-pre-wrap text-sm text-muted">{m.body}</div>
                  </div>
                ))}
                <a
                  href={t.gmailHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline"
                >
                  <ExternalLink className="size-3" /> Open in Gmail
                </a>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
