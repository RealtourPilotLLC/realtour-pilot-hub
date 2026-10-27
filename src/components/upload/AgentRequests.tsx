"use client";

import { useState, useTransition, type ReactNode } from "react";
import { ListChecks, MessageSquareText, FileText, UserCheck, StickyNote, MapPin, Plus, ExternalLink, ChevronDown } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { addAgentRequest, markRequestNotFulfilled, undoRequestNotFulfilled } from "@/app/upload/sharedActions";
import { GROUP_TITLE, NOT_DONE_WHY_CAP, type AgentRequestGroup, type AgentRequestItem, type AgentRequestSource } from "@/lib/agentRequestsCore";
import { PortalCard, Fold } from "@/components/upload/portalUi";

// ---------------------------------------------------------------------------
// AGENT REQUESTS, FIRST ON THE PAGE (Oct 23 2026). What the agent (or the
// office for them) already asked for this shoot, each with where it came from
// and the original one tap away. Read-only: these are the agent's words, kept
// apart from the photographer's own editable notes further down. This
// shoot's requests first; what is waiting on the office and the standing
// notes next; anything already handled or from an earlier visit is folded.
//
// A request the agent made on site that is not here yet can be added: it is
// filed like any other client request (Kyle's list, the editor's brief), and
// never twice.
// ---------------------------------------------------------------------------

const ICON: Record<AgentRequestSource, typeof FileText> = {
  order_note: FileText,
  client_ask: MessageSquareText,
  office: StickyNote,
  on_site: MapPin,
  preference: UserCheck,
  customer_note: StickyNote,
};

/**
 * "I couldn't fulfill this" (Jordan, Oct 27 2026: "there needs to be an option
 * for them to say I wasn't able to fulfill this request, and then just explain
 * why"). The why is required; it lands on the editor's brief (so the editor
 * does not hunt for it) and on Kyle's Follow-Ups (so the client hears).
 */
function NotDone({ r, projectId, blocked, onItems }: { r: AgentRequestItem; projectId: string; blocked: string | null; onItems: (items: AgentRequestItem[]) => void }) {
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const fail = { ok: false, message: "Couldn't save that. Check your connection and try again.", items: undefined };
  const send = () => {
    const t = why.trim();
    if (t.length < 3) return;
    start(async () => {
      const res = await markRequestNotFulfilled(projectId, { requestId: r.id, why: t }).catch(() => fail);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) { setAsking(false); setWhy(""); }
      if (res.items) onItems(res.items);
    });
  };
  const undo = () => start(async () => {
    const res = await undoRequestNotFulfilled(projectId, { requestId: r.id }).catch(() => fail);
    setMsg({ ok: res.ok, text: res.message });
    if (res.items) onItems(res.items);
  });
  if (r.notDone) {
    return (
      <div data-request-not-done className="mt-1.5 rounded-lg border border-warning/40 bg-warning-soft/30 px-3 py-2 text-xs">
        <p className="font-semibold text-foreground">{r.notDone.by ? `${r.notDone.by} couldn't do this` : "Couldn't be done on site"}</p>
        <p className="mt-0.5 text-foreground/85">Why: {r.notDone.why}</p>
        <p className="mt-0.5 text-muted">On the editor&rsquo;s brief, and Kyle has it on his follow-ups.</p>
        {!blocked && (
          <button type="button" disabled={pending} onClick={undo} className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-brand hover:underline disabled:opacity-50">
            {pending ? "Taking back…" : "Undo"}
          </button>
        )}
        {msg && <p role="status" aria-live="polite" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
      </div>
    );
  }
  if (blocked || r.group === "history") return null;
  return (
    <div className="mt-1">
      {asking ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
          <label htmlFor={`not-done-${r.id}`} className="text-xs font-semibold">Why couldn&rsquo;t it be done? <span className="text-danger">*</span></label>
          <textarea
            id={`not-done-${r.id}`}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            maxLength={NOT_DONE_WHY_CAP}
            rows={2}
            placeholder="e.g. The deck was being repaired, so there was no view to open on"
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm"
          />
          <div className="mt-1.5 flex flex-wrap gap-2">
            <button type="button" disabled={pending || why.trim().length < 3} onClick={send} className="min-h-11 rounded-lg bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
              {pending ? "Saving…" : "Tell Kyle and the editor"}
            </button>
            <button type="button" onClick={() => { setAsking(false); setWhy(""); }} className="min-h-11 rounded-lg px-3 text-sm text-muted hover:text-foreground">Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => { setAsking(true); setMsg(null); }} className="inline-flex min-h-11 items-center text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline">
          I couldn&rsquo;t fulfill this
        </button>
      )}
      {msg && <p role="status" aria-live="polite" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

function Row({ r, projectId, blocked, onItems }: { r: AgentRequestItem; projectId: string; blocked: string | null; onItems: (items: AgentRequestItem[]) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[r.source];
  const longer = r.original.replace(/\s+/g, " ").trim() !== r.text.replace(/\s+/g, " ").trim();
  return (
    <li data-agent-request={r.source} className={cn("rounded-xl border px-3 py-2.5", r.group === "history" ? "border-border bg-surface-2/30" : "border-border bg-surface-2/60")}>
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-medium leading-snug", r.group === "history" && "text-foreground/75")}>{r.text}</p>
          <p className="mt-0.5 text-xs text-muted">
            From: {r.sourceWords}
            {r.atISO ? ` · ${etDateTime(r.atISO)}` : ""}
            {r.medium === "photo" ? " · photos" : r.medium === "video" ? " · video" : ""}
          </p>
          {r.closedWords && !r.notDone && <p className="mt-0.5 text-xs text-success">{r.closedWords}</p>}
          <NotDone r={r} projectId={projectId} blocked={blocked} onItems={onItems} />
        </div>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline"
      >
        <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {open ? "Hide the original" : longer ? "Open the original (full words)" : "Open the original"}
      </button>
      {open && (
        <div className="mt-1 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
          <p className="whitespace-pre-wrap text-foreground/90">{r.original}</p>
          <p className="mt-1.5 text-xs text-muted">{r.sourceWords}{r.atISO ? `, ${etDateTime(r.atISO)}` : ""}</p>
          {r.link && (
            <a href={r.link.href} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline">
              {r.link.label} <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}

export function AgentRequests({
  projectId,
  initial,
  blocked,
  reviewed,
  onReviewed,
  extra,
}: {
  projectId: string;
  initial: AgentRequestItem[];
  /** why nothing can be added from this view (a "view as" preview); null = it can */
  blocked: string | null;
  reviewed: boolean;
  onReviewed: (v: boolean) => void;
  /** Oct 27 2026: the client preference box (FieldFeedback) lives in this card, not lower on the page */
  extra?: ReactNode;
}) {
  const [items, setItems] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [medium, setMedium] = useState<"photo" | "video" | "both">("both");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const groups = (["visit", "unresolved", "standing"] as AgentRequestGroup[]).map((g) => ({ g, rows: items.filter((r) => r.group === g) })).filter((x) => x.rows.length);
  const history = items.filter((r) => r.group === "history");
  const live = items.length - history.length;

  const save = () => {
    const t = text.trim();
    if (!t) return;
    start(async () => {
      const r = await addAgentRequest(projectId, { text: t, medium }).catch(() => ({ ok: false, message: "Couldn't save that. Check your connection and try again.", items: undefined, duplicate: false }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.items) setItems(r.items);
      if (r.ok) { setText(""); setAdding(false); }
    });
  };

  return (
    <PortalCard
      id="agent-requests"
      icon={<ListChecks className="size-4.5" />}
      title="Agent requests"
      subtitle={live ? "Already saved for this shoot. Nothing here needs retyping." : "Nothing saved for this shoot yet."}
    >
      {groups.map(({ g, rows }) => (
        <div key={g} className="mt-3 first:mt-0">
          {(groups.length > 1 || g !== "visit") && <p className="mb-1.5 text-[11px] font-bold uppercase tracking-widest text-muted">{GROUP_TITLE[g]}</p>}
          <ul className="space-y-2">{rows.map((r) => <Row key={r.id} r={r} projectId={projectId} blocked={blocked} onItems={setItems} />)}</ul>
        </div>
      ))}
      {history.length > 0 && (
        <Fold className="mt-3" title={GROUP_TITLE.history} summary={`(${history.length})`}>
          <ul className="space-y-2">{history.map((r) => <Row key={r.id} r={r} projectId={projectId} blocked={blocked} onItems={setItems} />)}</ul>
        </Fold>
      )}

      {!blocked && (adding ? (
        <div className="mt-3 rounded-xl border border-brand/30 bg-brand-soft/20 p-3">
          <label htmlFor="new-agent-request" className="text-sm font-semibold">A request the agent made on site</label>
          <p className="text-xs text-muted">Only something that isn&rsquo;t listed above. It goes to Kyle&rsquo;s request list and the editor&rsquo;s brief, with your name.</p>
          <textarea
            id="new-agent-request"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="e.g. Open the reel on the view from the deck"
            className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm"
          />
          <div role="radiogroup" aria-label="Which work it is about" className="mt-2 flex flex-wrap gap-2">
            {(["photo", "video", "both"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={medium === m}
                onClick={() => setMedium(m)}
                className={cn("min-h-11 rounded-lg border px-3 text-sm font-medium", medium === m ? "border-brand bg-brand-soft text-brand" : "border-border hover:bg-surface-2")}
              >
                {m === "photo" ? "Photos" : m === "video" ? "Video" : "Both"}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={pending || !text.trim()} onClick={save} className="min-h-11 rounded-lg bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
              {pending ? "Saving…" : "Add request"}
            </button>
            <button type="button" onClick={() => { setAdding(false); setText(""); }} className="min-h-11 rounded-lg px-3 text-sm text-muted hover:text-foreground">Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => { setAdding(true); setMsg(null); }} className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand hover:underline">
          <Plus aria-hidden className="size-4" /> Add a request the agent made on site
        </button>
      ))}
      {msg && <p role="status" aria-live="polite" className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}

      {extra && <div className="mt-3 border-t border-border pt-3">{extra}</div>}

      {live > 0 && (
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2.5 border-t border-border pt-3 text-sm">
          <input type="checkbox" checked={reviewed} onChange={(e) => onReviewed(e.target.checked)} className="size-5 shrink-0 accent-[var(--brand)]" />
          I&rsquo;ve read the agent&rsquo;s requests
        </label>
      )}
    </PortalCard>
  );
}
