"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Clapperboard, ExternalLink, Loader2, Mail, MessageSquare, Phone, Send } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { ClientChat } from "@/components/clients/ClientChat";
import { ClientEmails } from "@/components/clients/ClientEmails";
import { postProgramMessageAction, markProgramThreadHandledAction } from "@/app/content/[id]/workspaceActions";
import type { StaffMessagesTab } from "@/lib/programMessages";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// MESSAGES on the client file (CP-13). Three things, in the order Kyle needs
// them:
//   1. the program conversation — the client's messages, the office's replies,
//      a reply box, and "No reply needed" for a message that wants none;
//   2. a chip on any client message that reads like a VIDEO change. It is a
//      prompt, not a route: video changes belong on the video (the revision
//      workflow), and moving one there is a person's call;
//   3. the client's texts and emails, underneath and labelled by channel —
//      the same components the client page uses, opened on demand so the tab
//      does not call OpenPhone and Gmail every time it is looked at. This is
//      context beside the thread, not a second inbox: texting still happens
//      on the company line, email in Gmail.
// ---------------------------------------------------------------------------

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function ProgramMessagesPanel({ d }: { d: StaffMessagesTab }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [showTexts, setShowTexts] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const msgs = d.thread.messages;
  const lastClient = [...msgs].reverse().find((m) => m.authorKind === "CLIENT") ?? null;

  const reply = () => start(async () => {
    const r = await postProgramMessageAction(d.enrollmentId, body, lastClient?.id ?? null).catch(() => ({ ok: false, message: "That didn't send." }));
    setNote({ ok: r.ok, text: r.message });
    if (r.ok) { setBody(""); router.refresh(); }
  });
  const handled = () => start(async () => {
    const r = await markProgramThreadHandledAction(d.enrollmentId).catch(() => ({ ok: false, message: "Couldn't update the thread." }));
    setNote({ ok: r.ok, text: r.message });
    if (r.ok) router.refresh();
  });

  return (
    <div className="space-y-5">
      <Section icon={MessageSquare} title="Program conversation" count={d.unanswered ? `${d.unanswered} waiting` : undefined}>
        <p className="text-[13px] text-muted">
          Owner: <span className="font-medium text-foreground">{d.thread.owner.label}</span> (client messages — change it on Settings).
          {" "}The client sees this thread on their portal&rsquo;s Messages tab.{d.noticeOn ? " They are emailed when you reply." : " They are not emailed about replies while “Email clients when the office replies” is off; they see them next time they open the portal."}
        </p>
        {msgs.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No messages on this program yet.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {msgs.map((m) => {
              const office = m.authorKind === "STAFF";
              return (
                <li key={m.id} className={cn("flex flex-col", office ? "items-end" : "items-start")}>
                  <div className={cn("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm", office ? "rounded-tr-md bg-brand text-white" : "rounded-tl-md border border-border bg-surface-2/60")}>
                    {m.body}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-2">
                    <span>{m.authorLabel} · {when(m.createdAtISO)}</span>
                    {!office && !m.handled && <span className="rounded-md bg-warning-soft px-1.5 py-0.5 font-semibold text-warning">waiting</span>}
                    {!office && m.handled && <span className="inline-flex items-center gap-0.5 text-success"><CheckCircle2 className="size-3" /> answered</span>}
                    {m.looksLikeVideoChange && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 font-semibold text-brand" title="This reads like a change to a video. Video changes go on the video (the revision workflow); nothing was moved automatically.">
                        <Clapperboard className="size-3" /> looks like a video change
                      </span>
                    )}
                    {m.ref && <span className="rounded-md bg-surface-2 px-1.5 py-0.5">about a {m.ref.kind.toLowerCase()}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4000} placeholder="Reply to the client…"
            className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={reply} disabled={pending || !body.trim()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Reply
            </button>
            {d.unanswered > 0 && (
              <button type="button" onClick={handled} disabled={pending}
                className="rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
                No reply needed
              </button>
            )}
            {note && <span role="status" className={cn("text-xs", note.ok ? "text-success" : "text-warning")}>{note.text}</span>}
          </div>
        </div>
      </Section>

      <Section icon={ExternalLink} title="Related texts and emails">
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Separate from the thread above, and shown here only for context, each labelled with the channel it came through. Texting still happens on the company line and email in Gmail.</p>
          {d.client.hasPhone ? (
            showTexts ? (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted"><Phone className="size-3.5" /> Text · company OpenPhone line</div>
                <ClientChat clientId={d.client.id} clientName={d.client.name} />
              </div>
            ) : (
              <button type="button" onClick={() => setShowTexts(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                <Phone className="size-4" /> Show texts (company OpenPhone line)
              </button>
            )
          ) : (
            <p className="text-[13px] text-muted">No phone number on the client record, so there are no texts to show.</p>
          )}
          {d.client.hasEmail ? (
            showEmails ? (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted"><Mail className="size-3.5" /> Email · Gmail</div>
                <ClientEmails clientId={d.client.id} />
              </div>
            ) : (
              <button type="button" onClick={() => setShowEmails(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                <Mail className="size-4" /> Show emails (Gmail)
              </button>
            )
          ) : (
            <p className="text-[13px] text-muted">No email address on the client record.</p>
          )}
          <Link href={`/clients/${d.client.id}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
            Open the client page <ExternalLink className="size-3.5" />
          </Link>
        </div>
      </Section>
    </div>
  );
}
