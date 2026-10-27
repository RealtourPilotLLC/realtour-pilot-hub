"use client";

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ExternalLink, Mail, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmailMessage, EmailThread } from "@/components/comms/emailThreads";
import { foldOlderEmails, olderEmailsLabel } from "@/components/comms/emailOrder";
import { EmailReplyBox } from "@/components/comms/EmailReplyBox";
import { draftEmailThreadReply } from "@/app/emailActions";

// Expandable email-thread list for Messages · Email. Clicking a row unfolds
// the thread inline.
// REPLY IN THE HUB (Jordan, Oct 27 2026: "I want to be able to respond to
// emails in the hub"): an unfolded thread opens with its reply box on top
// (EmailReplyBox: the AI draft as starting text, Send into the same Gmail
// thread). "Open in Gmail" stays for anything the box can't do.
// NEWEST FIRST, ONE WEEK OPEN (same day: "newest emails should be at the top
// so we dont have to scroll to the bottom. Older than 7 days should be
// collapsed"): messages run newest first, and anything older than seven days
// folds under "Show N older emails", closed until opened (emailOrder.ts).
// `nowMs` comes from the page, so the fold is the same on the server and in
// the browser.
// `focusKey` (Oct 19 2026): the thread a Reply on Messages · Waiting on us
// opened. The page puts it first; here it starts unfolded, marked, with its
// reply box open.
export function EmailThreadList({ threads, focusKey = null, nowMs }: { threads: EmailThread[]; focusKey?: string | null; nowMs: number }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(focusKey ? [focusKey] : []));

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
        const focused = !!focusKey && t.key === focusKey;
        const { recent, older } = foldOlderEmails(t.messages, (m) => m.atISO, nowMs);
        return (
          <div key={t.key} data-email-thread={t.key} aria-current={focused ? "true" : undefined} className={cn("border-b last:border-0", focused && "ring-2 ring-inset ring-brand")}>
            {/* Row header — whole row toggles; the Gmail link stops propagation */}
            <button
              type="button"
              onClick={() => toggle(t.key)}
              className={cn("flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 sm:px-5", expanded && "bg-surface-2")}
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
                  <span className="text-muted-2"> · {t.snippet}</span>
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
              <div className="space-y-3 border-t bg-surface-2/50 px-4 py-4 sm:px-5">
                {t.replyRef ? (
                  <EmailReplyBox
                    target={{ kind: "log", commLogId: t.replyRef }}
                    draft={() => draftEmailThreadReply({ kind: "log", commLogId: t.replyRef! })}
                    startOpen={focused}
                  />
                ) : (
                  <p className="text-xs text-muted">This thread can only be answered in Gmail.</p>
                )}
                {recent.map((m) => <EmailCard key={m.id} m={m} />)}
                {older.length > 0 && (
                  <details data-older-emails={older.length} className="group">
                    <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs font-medium text-brand">
                      <ChevronDown aria-hidden className="size-3.5 transition group-open:rotate-180" /> {olderEmailsLabel(older.length)}
                    </summary>
                    <div className="mt-1 space-y-3">
                      {older.map((m) => <EmailCard key={m.id} m={m} />)}
                    </div>
                  </details>
                )}
                <a
                  href={t.gmailHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-brand hover:underline"
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

function EmailCard({ m }: { m: EmailMessage }) {
  return (
    <div data-email-message={m.id} className="rounded-xl border bg-surface p-3">
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        {m.direction === "in" ? <ArrowDownLeft className="size-3 text-success" /> : <ArrowUpRight className="size-3 text-muted-2" />}
        <span className="font-medium">{m.sender}</span>
        <span className="ml-auto text-muted-2" title={m.ago}>{m.atLabel}</span>
      </div>
      {/* Bodies are often Gmail snippets, sometimes full text — a capped
          scroll keeps one long email from eating the page. */}
      <div className="max-h-56 overflow-y-auto whitespace-pre-wrap text-sm text-muted">{m.body}</div>
    </div>
  );
}
