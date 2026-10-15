"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, MessageSquareText, PencilLine, Phone, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalSaveTopicAnswer, portalSendTopicAnswers, portalSetTopicAnswerRoute } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { PortalTopic } from "@/lib/portal";

// ---------------------------------------------------------------------------
// THE QUESTIONS UNDER A CHOSEN TOPIC (Oct 15 2026, Jordan, after Marcee
// McMullen's strategy call): "Once selected, I'd like the questions to open
// underneath it." On a month planned on a call they are read out on the call
// (the answers are on the recording, and the script is written from it); when
// the client plans on her own, or a topic is asked for in writing, she answers
// them right here. The team (Jordan in her portal on the call) can switch one
// topic to written answers ("she needed more time on that one") and back.
// ---------------------------------------------------------------------------

const tap = "min-h-11 px-3 text-xs sm:min-h-0 sm:px-2 sm:text-[11px]";
const ring = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";

export function TopicQuestions({ t, canAct, readOnly, staff, tabHref }: { t: PortalTopic; canAct: boolean; readOnly: boolean; staff: boolean; tabHref: string }) {
  const router = useRouter();
  const q = t.questions;
  const monthId = t.selection?.monthId ?? null;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries((q?.items ?? []).map((i) => [i.key, i.answer ?? ""])));
  const [saved, setSaved] = useState<Record<string, string>>(() => Object.fromEntries((q?.items ?? []).map((i) => [i.key, i.answer ?? ""])));
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; gaps?: boolean } | null>(null);
  const [busy, start] = useTransition();
  if (!q || !monthId || t.state === "FILMED") return null;

  const editable = canAct && !readOnly;
  const sent = q.status === "SUBMITTED";
  const answered = q.items.filter((i) => (drafts[i.key] ?? "").trim()).length;

  const save = (key: string) => {
    const text = (drafts[key] ?? "").trim();
    if (text === (saved[key] ?? "").trim()) return;
    setSavingKey(key);
    start(async () => {
      const r = await portalSaveTopicAnswer(portalAuthFromLocation(), t.id, monthId, key, text).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setSavingKey(null);
      if (r.ok) setSaved((s) => ({ ...s, [key]: text }));
      else setMsg({ ok: false, text: r.message });
    });
  };
  const send = (acknowledgeGaps = false) => start(async () => {
    // Anything typed and not yet saved goes first.
    for (const i of q.items) {
      const text = (drafts[i.key] ?? "").trim();
      if (text && text !== (saved[i.key] ?? "").trim()) {
        const r = await portalSaveTopicAnswer(portalAuthFromLocation(), t.id, monthId, i.key, text).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
        if (!r.ok) return setMsg({ ok: false, text: r.message });
      }
    }
    const r = await portalSendTopicAnswers(portalAuthFromLocation(), t.id, monthId, { acknowledgeGaps }).catch(() => ({ ok: false, message: "That didn't send. Try again." } as { ok: false; message: string; followUp?: boolean; interviewId?: string }));
    if (!r.ok && "followUp" in r && r.followUp && r.interviewId) {
      router.push(`${tabHref}&iv=${encodeURIComponent(r.interviewId)}`);
      return;
    }
    setMsg({ ok: r.ok, text: r.message, gaps: !r.ok && /Not enough to write this one yet/.test(r.message) });
    if (r.ok) router.refresh();
  });
  const switchRoute = (route: "CALL" | "WRITTEN") => start(async () => {
    const r = await portalSetTopicAnswerRoute(portalAuthFromLocation(), t.id, monthId, route).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) router.refresh();
  });

  const teamSwitch = staff && editable && q.callMonth && !t.script && (
    q.route === "CALL" ? (
      <button type="button" onClick={() => switchRoute("WRITTEN")} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted hover:text-foreground disabled:opacity-50", tap, ring)}>
        <PencilLine className="size-3" aria-hidden /> Answer this one in writing instead
      </button>
    ) : (
      <button type="button" onClick={() => switchRoute("CALL")} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted hover:text-foreground disabled:opacity-50", tap, ring)}>
        <Phone className="size-3" aria-hidden /> Back to the call (undo)
      </button>
    )
  );

  return (
    <div className="mt-2 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2">
      <details open={!t.script && !sent}>
        <summary className={cn("flex min-h-11 cursor-pointer items-center gap-1.5 text-xs font-bold sm:min-h-0", ring)}>
          {q.route === "CALL" ? <MessageSquareText className="size-3.5 text-brand" aria-hidden /> : <PencilLine className="size-3.5 text-brand" aria-hidden />}
          {q.route === "CALL" ? "Questions for the call" : sent ? "Your answers (sent)" : `Your questions · ${answered} of ${q.items.length} answered`}
        </summary>
        {q.route === "CALL" ? (
          <>
            <p className="mt-1 text-[11px] text-muted">We talk these through on your strategy call, and your script is written from what you say. Nothing to write.</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-xs">
              {q.items.map((i) => <li key={i.key}>{i.text}</li>)}
            </ol>
          </>
        ) : (
          <>
            <p className="mt-1 text-[11px] text-muted">{sent ? "We write the script from these and share it here for your read-through." : "Answer in your own words, the way you'd say it to a client. Leave any you're unsure of blank."}</p>
            <ol className="mt-2 space-y-2.5">
              {q.items.map((i, n) => (
                <li key={i.key}>
                  <label htmlFor={`q-${t.id}-${i.key}`} className="block text-xs font-medium">{n + 1}. {i.text}</label>
                  {editable && !sent ? (
                    <>
                      <textarea
                        id={`q-${t.id}-${i.key}`}
                        value={drafts[i.key] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [i.key]: e.target.value }))}
                        onBlur={() => save(i.key)}
                        rows={3}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm outline-none focus:border-brand"
                      />
                      {savingKey === i.key ? (
                        <span role="status" className="inline-flex items-center gap-1 text-[11px] text-muted"><Loader2 className="size-3 animate-spin" aria-hidden /> Saving…</span>
                      ) : (drafts[i.key] ?? "").trim() && (drafts[i.key] ?? "").trim() === (saved[i.key] ?? "").trim() ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-success"><CheckCircle2 className="size-3" aria-hidden /> Saved</span>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{i.answer ?? (i.skipped ? "Left blank" : "Not answered yet")}</p>
                  )}
                </li>
              ))}
            </ol>
            {editable && !sent && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" onClick={() => send(false)} disabled={busy || answered === 0} className={cn("inline-flex items-center gap-1 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50", tap, ring)}>
                  {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Send className="size-3" aria-hidden />} Send my answers
                </button>
                {msg?.gaps && (
                  <button type="button" onClick={() => send(true)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted hover:text-foreground disabled:opacity-50", tap, ring)}>
                    Send what I have
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </details>
      {teamSwitch && <div className="mt-1.5">{teamSwitch}</div>}
      {msg && <p role="status" className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}
