"use client";

import { etMonthDayTime } from "@/lib/datetime";
import { useEffect, useState, useTransition } from "react";
import { Loader2, Mail, ChevronDown, ChevronRight, AlertCircle } from "lucide-react";
import type { GmailEmail } from "@/lib/integrations/google";
import { loadClientEmails, draftEmailReply } from "@/app/clients/actions";
import { loadMailboxGap } from "@/components/clients/mailboxHealth.actions";
import { EmailReplyBox } from "@/components/comms/EmailReplyBox";
import { foldOlderEmails, olderEmailsLabel } from "@/components/comms/emailOrder";

// ET, date and time as two calls (see datetime.ts).
const fmt = (iso: string): string => (iso ? etMonthDayTime(iso) : "");

// The client's Gmail conversation, lazy-loaded on the client detail page so
// the page paints instantly. THE page's one email-draft tool (Oct 21 2026,
// audit F9): "Draft a reply" reads the whole Gmail thread.
// REPLY IN THE HUB (Jordan, Oct 27 2026: "One queue + Gmail draft. I want to
// be able to respond to emails in the hub"): that draft is the starting text
// of the reply box (EmailReplyBox), which sends into the Gmail thread of the
// client's latest email, to the client's own address, when a person presses
// Send. Nothing sends on its own.
// NEWEST FIRST, ONE WEEK OPEN (same day): the newest email is at the top, and
// anything older than seven days folds under "Show N older emails".
export function ClientEmails({ clientId }: { clientId: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [emails, setEmails] = useState<GmailEmail[]>([]);
  // When the list was read: the seven-day fold is measured from it (never a
  // clock read while rendering).
  const [readAt, setReadAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [, start] = useTransition();
  const [reload, setReload] = useState(0);
  // Which inbox is NOT being read, if any (§9, Sep 26): this list is live from
  // Gmail, and a mailbox whose token Google refused is skipped silently — so
  // the panel says so rather than implying it saw every inbox.
  const [gap, setGap] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadMailboxGap().then((g) => { if (alive) setGap(g); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // What a reply answers: the client's newest email, in its own Gmail thread.
  // The list arrives oldest first (google.clientEmailThreads).
  const theirs = state === "ready" ? [...emails].reverse().find((e) => !e.fromUs) ?? null : null;

  useEffect(() => {
    let alive = true;
    start(async () => {
      // Caught here: a thrown action inside a transition reaches the error
      // boundary in React 19 and takes the whole client page with it (F8).
      const r = await loadClientEmails(clientId).catch(() => ({ ok: false as const, message: "Couldn't load email. Refresh to try again.", emails: undefined }));
      if (!alive) return;
      if (r.ok) {
        const list = r.emails ?? [];
        setEmails(list);
        setReadAt(Date.now());
        // Expand the most recent message by default.
        if (list.length) setOpen(new Set([list[list.length - 1].id]));
        setState("ready");
      } else {
        setError(r.message);
        setState("error");
      }
    });
    return () => { alive = false; };

  }, [clientId, reload]);

  const toggle = (id: string) =>
    setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const { recent, older } = foldOlderEmails(emails, (e) => e.date, readAt);

  const row = (e: GmailEmail) => {
    const isOpen = open.has(e.id);
    return (
      <div key={e.id} data-client-email={e.id} className="border-b border-border last:border-0">
        <button
          onClick={() => toggle(e.id)}
          className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-surface-2"
        >
          <span className="mt-0.5 text-muted-2">
            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cnDir(e.fromUs)}>{e.fromUs ? "We replied" : e.from}</span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-2">{fmt(e.date)}</span>
            </div>
            <div className="truncate text-sm font-medium">{e.subject || "(no subject)"}</div>
            {!isOpen && <div className="truncate text-xs text-muted">{e.snippet}</div>}
          </div>
        </button>
        {isOpen && (
          <div className="px-4 pb-4 pl-10">
            <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
              {e.body || e.snippet || "(no content)"}
            </p>
            <div className="mt-2 text-[11px] text-muted-2">via {e.mailbox}</div>
          </div>
        )}
      </div>
    );
  };

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Mail className="size-4 text-muted" /> Email
        {state === "ready" && emails.length > 0 && (
          <span className="rounded-full bg-surface-2 px-1.5 text-[11px] font-normal text-muted">{emails.length}</span>
        )}
      </h2>

      {theirs && (
        <div className="mb-3">
          <EmailReplyBox
            key={`${theirs.mailbox}:${theirs.threadId}`}
            target={{ kind: "gmail", clientId, mailbox: theirs.mailbox, threadId: theirs.threadId }}
            draft={() => draftEmailReply(clientId)}
            onSent={() => setReload((n) => n + 1)}
          />
        </div>
      )}

      {gap && (
        <p className="mb-2 flex items-start gap-1.5 text-[11px] text-warning" data-mailbox-gap>
          <AlertCircle className="mt-px size-3.5 shrink-0" /> {gap}
        </p>
      )}

      {state === "loading" && (
        <div className="flex h-[120px] items-center justify-center rounded-2xl border bg-surface text-sm text-muted">
          <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading email…</span>
        </div>
      )}

      {state === "error" && (
        <div className="rounded-2xl border bg-surface px-4 py-6 text-center text-sm text-muted">{error}</div>
      )}

      {state === "ready" && (
        emails.length === 0 ? (
          <div className="rounded-2xl border bg-surface px-4 py-6 text-center text-sm text-muted">
            No email found with this client in the last year.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-surface">
            {recent.map(row)}
            {older.length > 0 && (
              <details data-older-emails={older.length} className="group border-t border-border">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 text-xs font-medium text-brand">
                  <ChevronDown aria-hidden className="size-3.5 transition group-open:rotate-180" /> {olderEmailsLabel(older.length)}
                </summary>
                <div className="border-t border-border">{older.map(row)}</div>
              </details>
            )}
          </div>
        )
      )}
    </section>
  );
}

function cnDir(fromUs: boolean): string {
  return fromUs
    ? "inline-flex rounded bg-brand-soft px-1.5 text-[11px] font-medium text-brand"
    : "truncate text-xs font-medium text-foreground";
}
