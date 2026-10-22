"use client";

import { etMonthDayTime } from "@/lib/datetime";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalReplyUnderScript } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { ScriptThreadItem } from "@/lib/scriptThread";

// ---------------------------------------------------------------------------
// UNDER THE SCRIPT (Oct 22 2026). Jordan: "Can the replies to the script
// changes not go to the messages but under the scripts?" The client's change
// requests and every reply about this script, oldest first, with who and when,
// and a box to answer right here. Nothing written here changes the script, and
// none of it is in Messages; the office reads it on the script's request card
// (and a client's reply waits on the office's Messages tab too).
//
// The "the office replied" email links to …?tab=plan&pv=scripts#reply-<id>:
// on arrival this opens whatever folds that reply and scrolls to it.
// ---------------------------------------------------------------------------

const SHOWN = 6;
const CLIP = 360;
// Two calls, plain spaces (lib/datetime): one call printed different words on
// the server and in the browser (React #418, audit L4, Oct 22 2026).
const when = (iso: string) => etMonthDayTime(iso);

export function ScriptThread({ scriptId, items, canReply, large = false, noteAbove = null }: {
  scriptId: string;
  items: ScriptThreadItem[];
  /** May write (an owner or collaborator seat on a live program). The server checks again. */
  canReply: boolean;
  /** 44px touch targets (the Scripts view). */
  large?: boolean;
  /** The office's note that came with this version is printed above the script: the thread points at it. */
  noteAbove?: { atISO: string; versionNo: number } | null;
}) {
  const router = useRouter();
  const [all, setAll] = useState(false);
  const [unfolded, setUnfolded] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const [busy, start] = useTransition();

  // Arriving from the reply email: show it, open what folds it, bring it into view.
  // Once per visit: a refresh after they reply must not jump back to it.
  const arrived = useRef(false);
  useEffect(() => {
    const h = decodeURIComponent(window.location.hash.slice(1));
    if (arrived.current || !h || !items.some((i) => i.anchor === h)) return;
    let scroll = 0;
    const show = window.setTimeout(() => {
      setAll(true); // it may be among the earlier ones
      scroll = window.setTimeout(() => {
        const el = document.getElementById(h);
        if (!el) return;
        arrived.current = true;
        for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
        el.scrollIntoView({ block: "center" });
        setLit(h);
      }, 60);
    }, 20);
    return () => { window.clearTimeout(show); window.clearTimeout(scroll); };
  }, [items]);

  if (items.length === 0) return null;
  const shown = all ? items : items.slice(-SHOWN);
  const hidden = items.length - shown.length;
  const send = () => start(async () => {
    setRes(null);
    const r = await portalReplyUnderScript(portalAuthFromLocation(), scriptId, text).catch(() => ({ ok: false, message: "That didn't send. Try again." }));
    setRes({ ok: r.ok, text: r.message });
    if (r.ok) { setText(""); router.refresh(); }
  });
  const btn = large ? "min-h-11 rounded-xl px-4 text-sm" : "min-h-9 rounded-lg px-3 text-xs";

  return (
    <section aria-label="About this script" className="mt-3 rounded-xl border border-border bg-surface-2/40 px-3 py-2.5">
      <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted-2">About this script</p>
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 min-h-9 text-xs font-medium text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
          Show {hidden} earlier
        </button>
      )}
      <ol className="mt-1.5 space-y-2.5">
        {shown.map((m) => {
          const folded = m.body.length > CLIP && !unfolded.includes(m.id);
          const above = !!noteAbove && m.from === "office" && m.atISO === noteAbove.atISO;
          return (
            <li key={m.id} id={m.anchor} className={cn("scroll-mt-24 rounded-lg px-2 py-1.5", m.from === "office" ? "bg-brand-soft/30" : "bg-surface/70", lit === m.anchor && "ring-2 ring-brand/40")}>
              <p className="text-[11px] font-semibold text-muted">
                {m.by}{m.kind === "request" ? " asked for a change" : m.from === "office" ? " replied" : " wrote"} · {when(m.atISO)}
              </p>
              {above ? (
                <p className="text-sm text-muted">Sent with version {noteAbove!.versionNo}: the note is at the top of this script.</p>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{folded ? `${m.body.slice(0, CLIP).trimEnd()}…` : m.body}</p>
              )}
              {!above && folded && (
                <button type="button" onClick={() => setUnfolded((u) => [...u, m.id])} className="min-h-9 text-xs font-medium text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Show all</button>
              )}
            </li>
          );
        })}
      </ol>
      {canReply && (
        <div className="mt-2.5 border-t border-border pt-2.5">
          <label htmlFor={`script-reply-${scriptId}`} className="text-xs font-semibold">Reply about this script</label>
          <textarea id={`script-reply-${scriptId}`} value={text} onChange={(e) => { setText(e.target.value); setRes(null); }} rows={2} maxLength={4000} placeholder="Write a reply"
            className="mt-1 block w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base leading-relaxed outline-none focus:border-brand sm:text-sm" />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button type="button" onClick={send} disabled={busy || text.trim().length < 2}
              className={cn("inline-flex items-center gap-1 bg-brand-action font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send reply
            </button>
            {res && <span role="status" className={cn("text-xs", res.ok ? "text-success" : "text-danger")}>{res.text}</span>}
          </div>
          <p className="mt-1 text-[11px] text-muted">Your reply stays here with the script, and we answer here too.</p>
        </div>
      )}
    </section>
  );
}
