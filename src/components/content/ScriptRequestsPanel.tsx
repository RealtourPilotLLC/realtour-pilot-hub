"use client";

import { useState, useTransition } from "react";
import { Check, FileText, Loader2, PencilLine, Send, Sparkles } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { ScriptWordsEditor } from "@/components/script/ScriptWordsEditor";
import { cn } from "@/lib/utils";
import { applyEditedScriptRequest, applyScriptSuggestion, dismissScriptSuggestion, replyToScriptRequestAction, applyClientScriptVersion } from "@/app/content/actions";
import type { RequestPart, RequestParts, ScriptRequestGroupView, ScriptRequestView } from "@/lib/scriptRequests";

// ---------------------------------------------------------------------------
// THE CLIENT ASKED FOR CHANGES (UI-02; reworked Oct 20 2026). Jordan, on
// Marcee McMullen's requests: "I'd like to be able to take what she wrote and
// apply it, or take what she wrote and edit it and then apply it, and then
// add a message below to be able to respond. I don't want to hit Apply with
// AI and then lose her response. I also would like to be able to see my
// original version here to compare them."
//
// Each request: the version the client read beside their words (an edit's changed
// parts marked), then Use their version / Edit and use / Apply with AI /
// Dismiss, then the replies and a reply box. A handled request stays, folded,
// with how it was handled and the version it became. lib/scriptRequests.
// ---------------------------------------------------------------------------

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const POINT_ROLE: Record<string, string> = { "re-hook": "Re-hook", "build-up": "Build up", payoff: "Payoff" };
const PART_WORDS: Record<RequestPart, string> = { hook: "hook", point1: "talking point 1", point2: "talking point 2", point3: "talking point 3", point4: "talking point 4", close: "close", caption: "caption" };

function list(parts: RequestPart[]): string {
  const w = parts.map((p) => PART_WORDS[p]);
  return w.length <= 1 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

function outcome(r: ScriptRequestView, first: string): string | null {
  const v = r.appliedVersionNo != null ? ` as v${r.appliedVersionNo}` : "";
  const when = r.resolvedAtISO ? `, ${day(r.resolvedAtISO)}` : "";
  if (r.status === "APPLIED" && r.appliedHow === "HERS") return `Used ${first}'s version${v}${when}`;
  if (r.status === "APPLIED" && r.appliedHow === "EDITED") return `Edited and used${v}${when}`;
  if (r.status === "APPLIED") return `Applied with AI${v}${when}`;
  if (r.status === "DISMISSED") return `Dismissed${when}`;
  if (r.status === "APPLYING") return "Being applied…";
  return null;
}

/** One script's words, part by part; `mark` outlines the parts that differ from the other side. */
function PartsView({ parts, mark = [] }: { parts: RequestParts; mark?: RequestPart[] }) {
  const row = (key: RequestPart, label: string, text: string | null) =>
    text ? (
      <div key={key} className={cn("rounded-md px-2 py-1", mark.includes(key) && "border-l-2 border-brand bg-brand-soft/40")}>
        <div className="text-[10px] font-bold uppercase tracking-wider text-muted-2">{label}</div>
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{text}</p>
      </div>
    ) : null;
  return (
    <div className="space-y-1">
      {row("hook", "Hook", parts.hook)}
      {parts.points.map((p, i) => row(`point${i + 1}` as RequestPart, `Talking point ${i + 1}${p.role ? ` · ${POINT_ROLE[p.role]}` : ""}`, p.text))}
      {row("close", "Close / CTA", parts.close)}
      {row("caption", "Caption", parts.captionCta)}
    </div>
  );
}

function RequestCard({ r, first }: { r: ScriptRequestView; first: string }) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, start] = useTransition();
  const open = r.status === "OPEN";
  const done = outcome(r, first);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => {
    setNote(null);
    const res = await fn().catch(() => ({ ok: false, message: "That didn't work. Try again." }));
    setNote({ ok: res.ok, text: res.message });
  });
  const btn = "inline-flex min-h-9 items-center gap-1 rounded-md px-2.5 py-1 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
  const hersLabel = r.merged ? (r.merged.full ? `Use ${first}'s version` : `Use ${first}'s change (${list(r.merged.changed)})`) : null;
  return (
    <div className={cn("rounded-lg border px-3 py-2.5", open ? "border-brand/30 bg-brand-soft/20" : "border-border bg-surface")}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-brand">{first}&rsquo;s request · {day(r.createdAtISO)}{r.readVersionNo != null ? ` · on v${r.readVersionNo}` : ""}{r.edited ? " · edited in place" : ""}</span>
        {done && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success"><Check className="size-3" aria-hidden />{done}</span>}
      </div>

      <div className="mt-2 grid gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-semibold text-muted">Your version{r.readVersionNo != null ? ` (v${r.readVersionNo}, the one ${first} read)` : ""}</div>
          {r.readParts ? <PartsView parts={r.readParts} /> : <p className="text-xs text-muted">That version isn&rsquo;t on file.</p>}
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-semibold text-muted">{first}&rsquo;s words</div>
          {r.edited && r.merged ? (
            <PartsView parts={r.merged.parts} mark={r.merged.changed} />
          ) : (
            <>
              <p className="whitespace-pre-wrap rounded-md bg-surface-2/50 px-2 py-1.5 text-xs leading-relaxed text-foreground/90">{r.body}</p>
              {r.merged && <p className="mt-1 text-[11px] text-muted">Read as a script: {r.merged.full ? "a full rewrite" : `a new ${list(r.merged.changed)}`}. The rest stays as you wrote it.</p>}
            </>
          )}
        </div>
      </div>

      {open && !editing && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {hersLabel && (
            <button type="button" disabled={busy} onClick={() => {
              if (!window.confirm(`Save ${first}'s words as the next version and share it with ${first} for their OK?`)) return;
              run(() => applyClientScriptVersion(r.id));
            }} className={cn(btn, "bg-brand font-semibold text-white")}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} {hersLabel}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => { setEditing(true); setNote(null); }} className={cn(btn, "border border-brand/40 font-semibold text-brand hover:bg-brand-soft")}>
            <PencilLine className="size-3" /> Edit and use
          </button>
          <button type="button" disabled={busy} onClick={() => run(() => applyScriptSuggestion(r.id))} className={cn(btn, "border border-border text-muted hover:text-foreground")}>
            <Sparkles className="size-3" /> Apply with AI
          </button>
          <button type="button" disabled={busy} onClick={() => run(() => dismissScriptSuggestion(r.id))} className={cn(btn, "border border-border text-muted hover:text-foreground")}>Dismiss</button>
        </div>
      )}
      {open && editing && (r.merged?.parts ?? r.readParts) && (
        <ScriptWordsEditor
          parts={r.merged?.parts ?? r.readParts!}
          intro={r.merged ? `${first}'s words, laid over your v${r.readVersionNo ?? ""}. Change anything, then save: it becomes the next version and goes to ${first} for their OK.` : `Your v${r.readVersionNo ?? ""}. Make the change ${first} asked for, then save: it becomes the next version and goes to ${first} for their OK.`}
          saveLabel={`Save and send to ${first}`}
          onSave={(w) => applyEditedScriptRequest(r.id, w)}
          onCancel={() => setEditing(false)}
          onSaved={(m) => { setEditing(false); setNote({ ok: true, text: m }); }}
        />
      )}
      {note && <p role="status" className={cn("mt-1.5 text-[11px]", note.ok ? "text-success" : "text-danger")}>{note.text}</p>}

      {r.replies.length > 0 && (
        <ul className="mt-2.5 space-y-1.5 border-t border-border pt-2">
          {r.replies.map((m, i) => (
            <li key={i} className="text-xs">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-2">{m.by} replied · {day(m.atISO)}</span>
              <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 space-y-1.5">
        <label htmlFor={`reply-${r.id}`} className="sr-only">Reply to {first}</label>
        <AutoTextarea id={`reply-${r.id}`} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`Reply to ${first} about this script…`} className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand" />
        {reply.trim().length > 1 && (
          <button type="button" disabled={busy} onClick={() => run(async () => { const res = await replyToScriptRequestAction(r.id, reply); if (res.ok) setReply(""); return res; })} className={cn(btn, "bg-brand-action font-semibold text-white")}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send reply
          </button>
        )}
      </div>
    </div>
  );
}

export function ScriptRequestsPanel({ groups }: { groups: ScriptRequestGroupView[] }) {
  const openCount = groups.reduce((n, g) => n + g.requests.filter((r) => r.status === "OPEN" || r.status === "APPLYING").length, 0);
  if (groups.length === 0) return null;
  return (
    <Section icon={FileText} title="The client asked for changes" count={openCount}
      action={<span className="text-[11px] text-muted-2">use theirs, edit it first, or apply with AI: each becomes a new version they approve</span>}>
      <div className="space-y-4">
        {groups.map((g) => {
          const open = g.requests.filter((r) => r.status === "OPEN" || r.status === "APPLYING");
          const handled = g.requests.filter((r) => !(r.status === "OPEN" || r.status === "APPLYING"));
          return (
            <div key={g.scriptId}>
              <p className="mb-1.5 text-[13px] font-semibold">{g.title}{g.versionNo != null && <span className="ml-1.5 text-[11px] font-normal text-muted-2">now v{g.versionNo}</span>}</p>
              <div className="space-y-2">
                {open.map((r) => <RequestCard key={r.id} r={r} first={g.clientFirst} />)}
                {handled.length > 0 && (
                  <details open={open.length === 0 && handled.length === 1}>
                    <summary className="min-h-9 cursor-pointer py-1 text-xs font-medium text-muted hover:text-foreground">Handled request{handled.length === 1 ? "" : "s"} ({handled.length})</summary>
                    <div className="mt-1.5 space-y-2">{handled.map((r) => <RequestCard key={r.id} r={r} first={g.clientFirst} />)}</div>
                  </details>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
