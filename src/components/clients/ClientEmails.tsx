"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2, Mail, ChevronDown, ChevronRight, Sparkles, Copy } from "lucide-react";
import type { GmailEmail } from "@/lib/integrations/google";
import { loadClientEmails, draftEmailReply } from "@/app/clients/actions";

function fmt(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// Read-only Gmail conversation for a client, lazy-loaded on the client detail
// page so the page paints instantly. Gives context on what email threads are
// about (we never send from here — that stays in the mail app).
export function ClientEmails({ clientId }: { clientId: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [emails, setEmails] = useState<GmailEmail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [, start] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [draft, setDraft] = useState<{ text?: string; error?: string; note?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // The most recent email is unanswered when it came FROM the client (not us).
  const latest = emails[emails.length - 1];
  const unanswered = state === "ready" && !!latest && !latest.fromUs;

  const makeDraft = () =>
    startDraft(async () => {
      setCopied(false);
      const r = await draftEmailReply(clientId);
      setDraft(r.ok ? { text: r.draft, note: r.message } : { error: r.message });
    });

  useEffect(() => {
    let alive = true;
    start(async () => {
      const r = await loadClientEmails(clientId);
      if (!alive) return;
      if (r.ok) {
        const list = r.emails ?? [];
        setEmails(list);
        // Expand the most recent message by default.
        if (list.length) setOpen(new Set([list[list.length - 1].id]));
        setState("ready");
      } else {
        setError(r.message);
        setState("error");
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const toggle = (id: string) =>
    setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Mail className="size-4 text-muted" /> Email
        {state === "ready" && emails.length > 0 && (
          <span className="rounded-full bg-surface-2 px-1.5 text-[11px] font-normal text-muted">{emails.length}</span>
        )}
        {unanswered && (
          <button
            onClick={makeDraft}
            disabled={drafting}
            title="AI-draft a reply (uses our scheduling availability when they ask)"
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand hover:bg-brand/20 disabled:opacity-60"
          >
            {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Draft reply
          </button>
        )}
      </h2>

      {draft && (
        <div className="mb-3 rounded-2xl border border-brand/30 bg-surface p-3">
          {draft.error ? (
            <p className="text-xs text-danger">{draft.error}</p>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Suggested reply</span>
                <button
                  onClick={() => { navigator.clipboard?.writeText(draft.text ?? ""); setCopied(true); }}
                  className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
                >
                  <Copy className="size-3" /> {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{draft.text}</p>
              <p className="mt-2 text-[10px] text-muted-2">{draft.note ?? "Review before sending. The hub never sends on its own."}</p>
            </>
          )}
        </div>
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
            {emails.map((e) => {
              const isOpen = open.has(e.id);
              return (
                <div key={e.id} className="border-b border-border last:border-0">
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
            })}
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
