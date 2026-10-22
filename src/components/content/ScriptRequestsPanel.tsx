"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, FileText, Info, Loader2, PencilLine, RotateCcw, Send, Sparkles } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { cn } from "@/lib/utils";
import { replyToScriptRequestAction } from "@/app/content/actions";
import {
  discardScriptRequestDraftAction, dismissScriptRequestAction, previewScriptRequestAction, readScriptRequestAction, rewriteScriptRequestAction, sendScriptRequestAction,
} from "@/app/content/scriptRequestActions";
import type { RequestDraft, RequestDraftView, RequestPart, RequestParts, RequestPreview, RequestReadView, ScriptRequestGroupView, ScriptRequestView, SendHow, VersionCheck } from "@/lib/scriptRequests";

// ---------------------------------------------------------------------------
// THE CLIENT ASKED FOR CHANGES (UI-02; reworked Oct 20; rebuilt Oct 22 2026 to
// the design Jordan approved, mock-script-requests Hub-Part / Hub-Part-Edit /
// Hub-Message / Hub-AI-Draft).
//
// Each request: their parts or their message beside our version, then FIRST
// the AI's read of it ("What they're asking for", before anything is
// rewritten), then the actions:
//   · a part change: Use their change · Edit their change · Rewrite with AI · Dismiss
//   · a message: Rewrite with AI · Edit it myself · Use their version as written · Dismiss
// Every path ends in a PREVIEW of the new version and the message, and only
// "Send version N" reaches the client (Jordan's decision 5). "Use their
// change" shows the quality check first; sending anyway is one press
// (decision 4). A handled request stays, folded, with what was sent and why.
// lib/scriptRequests holds the rules; lib/scriptRequestAi the two AI calls.
// ---------------------------------------------------------------------------

/** Mirrors lib/scriptRequests SCRIPT_LENGTH for the live counter; the server's check is the one that counts. */
const AIM_MIN = 55, AIM_MAX = 85, CAP = 110;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const POINT_ROLE: Record<string, string> = { "re-hook": "Re-hook", "build-up": "Build up", payoff: "Payoff" };
const PART_WORDS: Record<string, string> = { title: "title", hook: "hook", point1: "talking point 1", point2: "talking point 2", point3: "talking point 3", point4: "talking point 4", close: "close", caption: "caption" };
const words = (t: string) => t.split(/\s+/).filter((x) => /[0-9A-Za-zÀ-ɏ]/.test(x)).length;
const spoken = (hook: string, points: string[], close: string) => words([hook, ...points, close].join(" "));
const btn = "inline-flex min-h-9 items-center gap-1 rounded-md px-2.5 py-1 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
const primary = cn(btn, "bg-brand-action font-semibold text-white");
const secondary = cn(btn, "border border-brand/40 font-semibold text-brand hover:bg-brand-soft");
const quiet = cn(btn, "border border-border text-muted hover:text-foreground");
const box = "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs leading-relaxed outline-none focus:border-brand";

function list(parts: string[]): string {
  const w = parts.map((p) => PART_WORDS[p] ?? p);
  return w.length <= 1 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}
const partLabel = (key: string, parts: RequestParts | null): string => {
  if (key === "hook") return "Hook";
  if (key === "close") return "Close";
  if (key === "caption") return "Caption";
  if (key === "title") return "Title";
  const i = Number(key.slice(5)) - 1;
  const role = parts?.points[i]?.role;
  return `Talking point ${i + 1}${role ? ` · ${POINT_ROLE[role]}` : ""}`;
};
const pick = (p: RequestParts, key: string): string => (key === "hook" ? p.hook : key === "close" ? p.close : key === "caption" ? p.captionCta ?? "" : p.points[Number(key.slice(5)) - 1]?.text ?? "");
const keysOf = (p: RequestParts): RequestPart[] => ["hook", ...p.points.map((_, i) => `point${i + 1}` as RequestPart), "close"];

function outcome(r: ScriptRequestView, first: string): string | null {
  const v = r.appliedVersionNo != null ? ` as v${r.appliedVersionNo}` : "";
  const when = r.resolvedAtISO ? `, ${day(r.resolvedAtISO)}` : "";
  const d = r.decision;
  if (d && d.action !== "DISMISS") {
    const how = { USE_THEIRS: `used ${first}'s change`, EDIT_THEIRS: `edited ${first}'s change`, EDIT_MINE: "edited by hand", AI_REWRITE: "AI rewrite", AI_REWRITE_EDITED: "AI rewrite, edited", DISMISS: "" }[d.action];
    return `Sent v${d.versionNo} to ${first}${when}: ${how}`;
  }
  if (r.status === "APPLIED" && r.appliedHow === "HERS") return `Used ${first}'s version${v}${when}`;
  if (r.status === "APPLIED" && r.appliedHow === "EDITED") return `Edited and used${v}${when}`;
  if (r.status === "APPLIED") return `Applied with AI${v}${when}`;
  if (r.status === "DISMISSED") return `Dismissed${when}`;
  if (r.status === "APPLYING") return "Being applied…";
  return null;
}

/** One script's words, part by part; `mark` outlines the parts that differ from the other side. */
function PartsView({ parts, mark = [], tags, title, markLabel = "Updated" }: { parts: RequestParts; mark?: string[]; tags?: Record<string, string>; title?: string | null; markLabel?: string }) {
  const row = (key: string, label: string, text: string | null) =>
    text ? (
      <div key={key} className={cn("rounded-md px-2 py-1", mark.includes(key) && "border-l-2 border-brand bg-brand-soft/40")}>
        <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-2">
          {label}
          {mark.includes(key) && <span className="normal-case tracking-normal text-brand">{markLabel}</span>}
          {tags?.[key] && <span className="font-medium normal-case tracking-normal text-muted">· {tags[key]}</span>}
        </div>
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{text}</p>
      </div>
    ) : null;
  return (
    <div className="space-y-1">
      {title && row("title", "Title", title)}
      {row("hook", "Hook", parts.hook)}
      {parts.points.map((p, i) => row(`point${i + 1}`, `Talking point ${i + 1}${p.role ? ` · ${POINT_ROLE[p.role]}` : ""}`, p.text))}
      {row("close", "Close / CTA", parts.close)}
      {row("caption", "Caption", parts.captionCta)}
    </div>
  );
}

function CheckList({ check, title = "Quality check" }: { check: VersionCheck; title?: string }) {
  const tone = check.needsFix ? "border-warning/40 bg-warning-soft/40" : "border-success/30 bg-success/5";
  return (
    <div className={cn("rounded-lg border px-2.5 py-2", tone)}>
      <div className="text-[11px] font-semibold">{title}: {check.needsFix ? "something to fix" : "ready"} · {check.words} spoken words</div>
      <ul className="mt-1 space-y-0.5">
        {check.items.map((i) => (
          <li key={i.key} className="flex items-start gap-1.5 text-[11px] leading-snug">
            {i.status === "pass" ? <Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden /> : i.status === "fix" ? <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden /> : <Info className="mt-0.5 size-3 shrink-0 text-muted" aria-hidden />}
            <span>{i.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "What they're asking for": the AI's read, before anything is rewritten. An open request is read when the card first shows. */
function ReadBox({ r, first }: { r: ScriptRequestView; first: string }) {
  const [read, setRead] = useState<RequestReadView | null>(r.read);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const asked = useRef(false);
  const open = r.status === "OPEN";
  const run = (again: boolean) => start(async () => {
    setErr(null);
    const res = await readScriptRequestAction(r.id, { again }).catch(() => ({ ok: false, message: "The AI read didn't load. Try again.", read: undefined }));
    if (res.ok && res.read) setRead(res.read);
    else setErr(res.message);
  });
  useEffect(() => {
    if (open && !read && !asked.current) { asked.current = true; run(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, read]);
  if (!read && !open) return null;
  return (
    <div className="mt-2.5 rounded-lg border border-border bg-surface-2/40 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xs font-semibold">What {first}&rsquo;s asking for</span>
        <span className="text-[10px] text-muted-2">read by the AI, before anything is rewritten</span>
        {open && read && <button type="button" disabled={busy} onClick={() => run(true)} className="ml-auto inline-flex min-h-9 items-center gap-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50"><RotateCcw className="size-3" /> Read again</button>}
      </div>
      {busy && !read && <p role="status" className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted"><Loader2 className="size-3 animate-spin" /> Reading {first}&rsquo;s request…</p>}
      {err && <p role="alert" className="mt-1 text-[11px] text-danger">{err} {!busy && <button type="button" onClick={() => run(!!read)} className="font-semibold underline">Read it</button>}</p>}
      {read && (
        <div className="mt-1.5 space-y-1 text-xs leading-relaxed">
          <div className="flex flex-wrap gap-1">
            {read.types.map((t) => <span key={t.key} className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">{t.label}</span>)}
            {r.theirWords != null && r.theirWords > AIM_MAX && <span className="rounded-md bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">Length: {r.theirWords} words{r.theirWords > CAP ? `, over the ${CAP} cap` : ""}</span>}
          </div>
          <p><span className="font-semibold">Their intent:</span> {read.intent}</p>
          {read.useful.length > 0 && <p><span className="font-semibold">Useful from their words:</span> {read.useful.join("; ")}</p>}
          <p><span className="font-semibold">Recommendation:</span> {read.recommendation}</p>
          {read.watch && <p className="text-warning"><span className="font-semibold">Watch:</span> {read.watch}</p>}
          {read.profileNote && <p className="text-muted"><span className="font-semibold">From their profile:</span> {read.profileNote}</p>}
        </div>
      )}
    </div>
  );
}

type EditState = { from: "theirs" | "ours" | "draft"; title: string; hook: string; points: string[]; close: string; message: string };
type DraftState = RequestDraftView;
type Stage =
  | { k: "idle" }
  | { k: "edit"; e: EditState }
  | { k: "draft" }
  | { k: "preview"; p: RequestPreview; from: "theirs" | "ours" | "draft" | null; draftRunId: string | null };

/** Their words, our words or the AI's, in boxes, with the live word count. */
function Editor({ e, setE, readParts, merged, changed, first, nextNo, onCancel, onPreview, busy }: {
  e: EditState; setE: (fn: (e: EditState) => EditState) => void; readParts: RequestParts; merged: RequestParts | null; changed: string[];
  first: string; nextNo: number; onCancel: () => void; onPreview: () => void; busy: boolean;
}) {
  const n = spoken(e.hook, e.points, e.close);
  const label = "block text-[10px] font-bold uppercase tracking-wider text-brand";
  const field = (key: string, value: string, set: (v: string) => void) => (
    <label key={key} className="block">
      <span className={label}>{partLabel(key, readParts)}{changed.includes(key) ? <span className="ml-1 normal-case tracking-normal text-muted">· {first} changed this</span> : null}</span>
      <AutoTextarea value={value} onChange={(ev) => set(ev.target.value)} minRows={2} className={cn(box, "mt-0.5 text-sm")} />
      {changed.includes(key) && e.from !== "ours" && <span className="mt-0.5 block text-[11px] text-muted">Your version: {pick(readParts, key)}</span>}
      {changed.includes(key) && e.from === "ours" && merged && <span className="mt-0.5 block text-[11px] text-muted">{first} wrote: {pick(merged, key)}</span>}
    </label>
  );
  return (
    <div className="mt-2.5 space-y-2.5 rounded-lg border border-brand/30 bg-surface px-3 py-2.5">
      <p className="text-xs font-semibold">{e.from === "theirs" ? `Editing ${first}'s change` : e.from === "draft" ? "Editing the AI draft" : "Editing it yourself"} · it becomes version {nextNo}</p>
      <label className="block"><span className={label}>Title</span><input value={e.title} onChange={(ev) => setE((x) => ({ ...x, title: ev.target.value }))} className={cn(box, "mt-0.5 text-sm")} /></label>
      {field("hook", e.hook, (v) => setE((x) => ({ ...x, hook: v })))}
      {e.points.map((t, i) => field(`point${i + 1}`, t, (v) => setE((x) => ({ ...x, points: x.points.map((p, j) => (j === i ? v : p)) }))))}
      {field("close", e.close, (v) => setE((x) => ({ ...x, close: v })))}
      <p className={cn("text-[11px]", n > CAP ? "text-warning" : "text-muted")}>{n} spoken words · aim {AIM_MIN} to {AIM_MAX}, cap {CAP}{e.from === "theirs" ? ". Starts as their wording, so you only change what you want to." : ""}</p>
      <label className="block">
        <span className="text-[11px] font-semibold">Message to {first}</span>
        <AutoTextarea value={e.message} onChange={(ev) => setE((x) => ({ ...x, message: ev.target.value }))} minRows={2} placeholder={`For example: Loved your idea for the hook! I tightened it a little so it lands right away. Take a look and let me know.`} className={cn(box, "mt-0.5 text-sm")} />
      </label>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} onClick={onPreview} className={primary}>{busy ? <Loader2 className="size-3 animate-spin" /> : null} Preview version {nextNo}</button>
        <button type="button" disabled={busy} onClick={onCancel} className={quiet}>Cancel</button>
      </div>
    </div>
  );
}

function RequestCard({ r, g }: { r: ScriptRequestView; g: ScriptRequestGroupView }) {
  const router = useRouter();
  const first = g.clientFirst;
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [stage, setStage] = useState<Stage>({ k: "idle" });
  const [draft, setDraft] = useState<DraftState | null>(r.draft);
  const [draftMessage, setDraftMessage] = useState(r.draft?.message ?? "");
  const [steer, setSteer] = useState("");
  const [redo, setRedo] = useState("");
  const [reply, setReply] = useState("");
  const [showRest, setShowRest] = useState(false);
  const [busy, start] = useTransition();
  const open = r.status === "OPEN";
  const done = outcome(r, first);
  const readParts = r.readParts;
  const merged = r.merged?.parts ?? null;
  const changed: string[] = r.merged?.changed ?? [];
  const nextNo = g.nextVersionNo;
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => {
    setNote(null);
    const res = await fn().catch(() => ({ ok: false, message: "That didn't work. Try again." }));
    setNote({ ok: res.ok, text: res.message });
  });
  const preview = (how: SendHow, from: "theirs" | "ours" | "draft" | null, input: { words?: { hook: string; points: string[]; close: string } | null; title?: string | null; draftRunId?: string | null; message?: string | null }) => start(async () => {
    setNote(null);
    const res = await previewScriptRequestAction(r.id, how, input).catch(() => ({ ok: false, message: "The preview didn't load. Try again.", preview: undefined }));
    if (res.ok && res.preview) setStage({ k: "preview", p: res.preview, from, draftRunId: input.draftRunId ?? null });
    else setNote({ ok: false, text: res.message });
  });
  const toDraftView = async (d: RequestDraft): Promise<DraftState | null> => {
    const res = await previewScriptRequestAction(r.id, "AI", { draftRunId: d.runId }).catch(() => null);
    if (!res?.ok || !res.preview) return null;
    return { ...d, points: res.preview.points, check: res.preview.check, nextVersionNo: res.preview.nextVersionNo, messageWarning: res.preview.messageWarning };
  };
  const rewrite = (redoNote: string | null) => start(async () => {
    setNote(null);
    const res = await rewriteScriptRequestAction(r.id, { steer: steer.trim() || null, redo: redoNote }).catch(() => ({ ok: false, message: "The AI rewrite didn't work. Try again.", draft: undefined }));
    if (!res.ok || !res.draft) { setNote({ ok: false, text: res.message }); return; }
    const v = await toDraftView(res.draft);
    if (!v) { setNote({ ok: false, text: "The draft is saved, but its check didn't load. Reload the page to see it." }); return; }
    setDraft(v); setDraftMessage(v.message); setRedo(""); setStage({ k: "draft" });
  });
  const startEdit = (from: EditState["from"]) => {
    const base = from === "draft" && draft ? { title: draft.title, hook: draft.words.hook, points: draft.words.points, close: draft.words.close }
      : from === "theirs" && merged ? { title: r.readTitle ?? g.title, hook: merged.hook, points: merged.points.map((p) => p.text), close: merged.close }
        : readParts ? { title: r.readTitle ?? g.title, hook: readParts.hook, points: readParts.points.map((p) => p.text), close: readParts.close } : null;
    if (!base) return;
    setNote(null);
    setStage({ k: "edit", e: { from, ...base, message: from === "draft" ? draftMessage : "" } });
  };
  const send = (s: Extract<Stage, { k: "preview" }>, message: string) => start(async () => {
    setNote(null);
    const p = s.p;
    const res = await sendScriptRequestAction(r.id, p.how, { words: p.how === "HERS" || p.how === "AI" ? null : p.words, title: p.title, draftRunId: s.draftRunId, message, startedFrom: s.from }).catch(() => ({ ok: false, message: "That didn't send. Try again." }));
    setNote({ ok: res.ok, text: res.message });
    if (res.ok) { setStage({ k: "idle" }); router.refresh(); }
  });
  const isParts = r.kind === "PARTS" && changed.length > 0;
  const head = isParts
    ? `${first} changed ${changed.length === 1 ? "one part" : `${changed.length} parts`}: the ${list(changed)}`
    : `${first} sent a message${r.merged?.full ? " and a full rewrite" : r.merged ? ` with new wording for the ${list(changed)}` : ""}`;
  const rest = readParts ? keysOf(readParts).filter((k) => !changed.includes(k)) : [];

  return (
    <div className={cn("rounded-lg border px-3 py-2.5", open ? "border-brand/30 bg-brand-soft/20" : "border-border bg-surface")}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[11px] font-semibold">{head} · {day(r.createdAtISO)}{r.readVersionNo != null ? ` · on version ${r.readVersionNo}` : ""}</span>
        {open && <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">{isParts ? "Part change" : "Message"} · open</span>}
        {done && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success"><Check className="size-3" aria-hidden />{done}</span>}
      </div>

      {/* Their words beside ours. */}
      {isParts && readParts && merged ? (
        <>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-[11px] font-semibold text-muted">Your version{r.readVersionNo != null ? ` (v${r.readVersionNo})` : ""}</div>
              <div className="space-y-1">{changed.map((k) => <PartsRow key={k} label={partLabel(k, readParts)} text={pick(readParts, k)} />)}</div>
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] font-semibold text-muted">{first}&rsquo;s wording</div>
              <div className="space-y-1">{changed.map((k) => <PartsRow key={k} label={`${partLabel(k, readParts)} · changed`} text={pick(merged, k)} note={r.notes[k as RequestPart]} mark />)}</div>
            </div>
          </div>
          {rest.length > 0 && (
            <button type="button" onClick={() => setShowRest(!showRest)} className="mt-1 min-h-9 text-[11px] text-muted hover:text-foreground">
              The {list(rest)}: unchanged ({showRest ? "hide" : "show"})
            </button>
          )}
          {showRest && <div className="space-y-1">{rest.map((k) => <PartsRow key={k} label={partLabel(k, readParts)} text={pick(readParts, k)} />)}</div>}
        </>
      ) : (
        <div className="mt-2 grid gap-3 lg:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-semibold text-muted">{first}&rsquo;s message{r.about.length ? ` · about: ${r.about.join(", ")}` : ""}</div>
            <p className="whitespace-pre-wrap rounded-md bg-surface-2/50 px-2 py-1.5 text-xs leading-relaxed text-foreground/90">{r.body}</p>
            {r.merged && <p className="mt-1 text-[11px] text-muted">Read as a script: {r.merged.full ? `a full rewrite${r.theirWords != null ? `, ${r.theirWords} spoken words` : ""}` : `a new ${list(changed)}`}.</p>}
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-semibold text-muted">Your version{r.readVersionNo != null ? ` (v${r.readVersionNo}${readParts ? `, ${spoken(readParts.hook, readParts.points.map((p) => p.text), readParts.close)} words` : ""})` : ""}</div>
            {readParts ? <PartsView parts={readParts} title={r.readTitle} /> : <p className="text-xs text-muted">That version isn&rsquo;t on file.</p>}
          </div>
        </div>
      )}

      <ReadBox r={r} first={first} />

      {open && stage.k === "idle" && (
        <div className="mt-2.5 space-y-2">
          {draft && <p className="text-[11px] text-muted">An AI draft is waiting for you. <button type="button" onClick={() => setStage({ k: "draft" })} className="font-semibold text-brand underline">Open the draft</button></p>}
          <div className="flex flex-wrap items-center gap-1.5">
            {isParts && merged ? (
              <>
                <button type="button" disabled={busy} onClick={() => preview("HERS", "theirs", {})} className={primary}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Use {first}&rsquo;s change</button>
                <button type="button" disabled={busy} onClick={() => startEdit("theirs")} className={secondary}><PencilLine className="size-3" /> Edit {first}&rsquo;s change</button>
                <button type="button" disabled={busy} onClick={() => rewrite(null)} className={quiet}><Sparkles className="size-3" /> Rewrite with AI</button>
              </>
            ) : (
              <>
                <button type="button" disabled={busy} onClick={() => rewrite(null)} className={primary}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} Rewrite with AI: keep the topic, use their best points</button>
                <button type="button" disabled={busy} onClick={() => startEdit(merged ? "theirs" : "ours")} className={secondary}><PencilLine className="size-3" /> Edit it myself</button>
                {merged && <button type="button" disabled={busy} onClick={() => preview("HERS", "theirs", {})} className={quiet}><Check className="size-3" /> Use {first}&rsquo;s version as written</button>}
              </>
            )}
            <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Dismiss ${first}'s request? It stays on this card, and nothing is sent.`)) run(async () => { const res = await dismissScriptRequestAction(r.id); if (res.ok) router.refresh(); return res; }); }} className={quiet}>Dismiss</button>
          </div>
          <details className="text-xs">
            <summary className="min-h-9 cursor-pointer py-1 text-[11px] font-medium text-muted hover:text-foreground">Steer the AI (optional, only the AI sees this)</summary>
            <AutoTextarea value={steer} onChange={(e) => setSteer(e.target.value)} minRows={2} placeholder={`For example: Keep the topic. Open on their belief. Leave mortgage rates out: ${first} didn't say it.`} className={cn(box, "mt-1")} />
          </details>
          <p className="text-[11px] text-muted-2">The AI writes a draft for you to read first. Neither your version nor theirs wins automatically. Nothing goes to {first} until you press Send.</p>
        </div>
      )}

      {open && stage.k === "edit" && readParts && (
        <Editor
          e={stage.e} setE={(fn) => setStage((s) => (s.k === "edit" ? { k: "edit", e: fn(s.e) } : s))}
          readParts={readParts} merged={merged} changed={changed} first={first} nextNo={nextNo} busy={busy}
          onCancel={() => setStage(stage.e.from === "draft" ? { k: "draft" } : { k: "idle" })}
          onPreview={() => preview(stage.e.from === "draft" ? "AI_EDITED" : "EDITED", stage.e.from, { words: { hook: stage.e.hook, points: stage.e.points, close: stage.e.close }, title: stage.e.title, draftRunId: stage.e.from === "draft" ? draft?.runId ?? null : null, message: stage.e.message })}
        />
      )}

      {open && stage.k === "draft" && draft && (
        <div className="mt-2.5 space-y-2.5 rounded-lg border border-brand/30 bg-surface px-3 py-2.5">
          <div>
            <p className="text-sm font-semibold">AI draft: the best of both versions</p>
            <p className="text-[11px] text-muted">{draft.title} · draft version {draft.nextVersionNo} · not sent yet · {spoken(draft.words.hook, draft.words.points, draft.words.close)} spoken words{draft.review.length ? ` · self-review: ${draft.review.filter((x) => x.pass).length} of ${draft.review.length} pass` : ""}</p>
          </div>
          <PartsView parts={{ hook: draft.words.hook, points: draft.points, close: draft.words.close, captionCta: null }} tags={draft.tags} title={draft.title !== (r.readTitle ?? g.title) ? draft.title : null} mark={draft.title !== (r.readTitle ?? g.title) ? ["title"] : []} markLabel="New title" />
          <div className="grid gap-2.5 lg:grid-cols-2">
            <div>
              <div className="text-[11px] font-semibold">Kept from {first}&rsquo;s version</div>
              <ul className="mt-0.5 space-y-0.5 text-xs">{draft.kept.length ? draft.kept.map((k, i) => <li key={i} className="flex gap-1"><Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />{k}</li>) : <li className="text-muted">Nothing named.</li>}</ul>
            </div>
            <div>
              <div className="text-[11px] font-semibold">Left out, and why</div>
              <ul className="mt-0.5 space-y-0.5 text-xs">{draft.leftOut.length ? draft.leftOut.map((k, i) => <li key={i} className="flex gap-1"><span className="text-muted" aria-hidden>–</span><span><span className="font-medium">{k.what}</span>: {k.why}</span></li>) : <li className="text-muted">Nothing left out.</li>}</ul>
            </div>
          </div>
          {draft.check && <CheckList check={draft.check} />}
          {draft.review.some((x) => !x.pass) && (
            <div className="text-[11px]"><span className="font-semibold">The AI&rsquo;s own review flagged:</span> {draft.review.filter((x) => !x.pass).map((x) => `${x.label}${x.note ? ` (${x.note})` : ""}`).join("; ")}</div>
          )}
          <div className="space-y-1">
            <label htmlFor={`redo-${r.id}`} className="text-[11px] font-semibold">Not quite? Tell the AI what to change</label>
            <AutoTextarea id={`redo-${r.id}`} value={redo} onChange={(e) => setRedo(e.target.value)} minRows={1} placeholder="For example: make the re-hook a question" className={box} />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={busy || redo.trim().length < 3} onClick={() => rewrite(redo.trim())} className={quiet}>{busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Redo the draft</button>
              <button type="button" disabled={busy} onClick={() => startEdit("draft")} className={quiet}><PencilLine className="size-3" /> Edit the draft myself</button>
            </div>
          </div>
          <label className="block">
            <span className="text-[11px] font-semibold">Message to {first} <span className="font-normal text-muted">(the AI drafted it from what was kept and why; edit freely)</span></span>
            <AutoTextarea value={draftMessage} onChange={(e) => setDraftMessage(e.target.value)} minRows={3} className={cn(box, "mt-0.5 text-sm")} />
          </label>
          {draft.messageWarning && <p className="text-[11px] text-warning">{draft.messageWarning}</p>}
          <p className="text-[11px] text-muted-2">Sends version {draft.nextVersionNo} to {first} for their OK with your message. Their request and rewrite stay on this card.</p>
          <div className="flex flex-wrap gap-1.5">
            {/* This screen IS the preview (decision 5): the new version, its check and the message, then Send. */}
            <button type="button" disabled={busy} onClick={() => start(async () => {
              setNote(null);
              const res = await sendScriptRequestAction(r.id, "AI", { draftRunId: draft.runId, message: draftMessage, startedFrom: "draft" }).catch(() => ({ ok: false, message: "That didn't send. Try again." }));
              setNote({ ok: res.ok, text: res.message });
              if (res.ok) { setDraft(null); setStage({ k: "idle" }); router.refresh(); }
            })} className={primary}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send version {draft.nextVersionNo} to {first}</button>
            <button type="button" disabled={busy} onClick={() => run(async () => { const res = await discardScriptRequestDraftAction(r.id); if (res.ok) { setDraft(null); setStage({ k: "idle" }); router.refresh(); } return res; })} className={quiet}>Discard the draft</button>
            <button type="button" disabled={busy} onClick={() => setStage({ k: "idle" })} className={quiet}>Back to the request</button>
          </div>
        </div>
      )}

      {open && stage.k === "preview" && readParts && (
        <Preview key={stage.p.nextVersionNo + stage.p.how} s={stage} first={first} readParts={readParts} busy={busy}
          onBack={() => setStage(stage.from === "draft" && stage.p.how === "AI" ? { k: "draft" } : stage.p.how === "EDITED" || stage.p.how === "AI_EDITED" ? { k: "edit", e: { from: stage.from ?? "ours", title: stage.p.title, hook: stage.p.words.hook, points: stage.p.words.points, close: stage.p.words.close, message: stage.p.message } } : { k: "idle" })}
          onSend={(m) => send(stage, m)} />
      )}

      {note && <p role="status" className={cn("mt-1.5 text-[11px]", note.ok ? "text-success" : "text-danger")}>{note.text}</p>}

      {/* A handled request keeps what was sent and why. */}
      {!open && r.decision && r.decision.action !== "DISMISS" && (
        <details className="mt-2 text-xs">
          <summary className="min-h-9 cursor-pointer py-1 text-[11px] font-medium text-muted hover:text-foreground">What was sent (v{r.decision.versionNo}){r.decision.byName || r.decision.by ? ` by ${r.decision.byName ?? r.decision.by}` : ""}</summary>
          <div className="mt-1 space-y-2">
            {r.decision.final && <PartsView parts={r.decision.final.parts} title={r.decision.changed.includes("title") ? r.decision.final.title : null} mark={r.decision.changed} />}
            {r.decision.kept.length > 0 && <p><span className="font-semibold">Kept:</span> {r.decision.kept.join("; ")}</p>}
            {r.decision.leftOut.length > 0 && <p><span className="font-semibold">Left out:</span> {r.decision.leftOut.map((x) => `${x.what} (${x.why})`).join("; ")}</p>}
            {r.decision.checkSummary && <p className="text-muted"><span className="font-semibold">Check when sent:</span> {r.decision.checkSummary}</p>}
          </div>
        </details>
      )}

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
      {stage.k === "idle" && (
        <div className="mt-2.5 space-y-1.5">
          <label htmlFor={`reply-${r.id}`} className="text-[11px] font-medium text-muted">Message to {first} on its own (no new version)</label>
          <AutoTextarea id={`reply-${r.id}`} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`Reply to ${first} about this script…`} className={box} />
          {reply.trim().length > 1 && (
            <button type="button" disabled={busy} onClick={() => run(async () => { const res = await replyToScriptRequestAction(r.id, reply); if (res.ok) { setReply(""); router.refresh(); } return res; })} className={primary}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send the message only
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PartsRow({ label, text, note, mark = false }: { label: string; text: string; note?: string; mark?: boolean }) {
  return (
    <div className={cn("rounded-md px-2 py-1", mark && "border-l-2 border-brand bg-brand-soft/40")}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-2">{label}</div>
      <p className="whitespace-pre-wrap text-xs leading-relaxed">{text}</p>
      {note && <p className="mt-0.5 text-[11px] italic text-muted">Their note: {note}</p>}
    </div>
  );
}

/** THE PREVIEW (decision 5): the new version, the check, the message; Send is the only way out to the client. */
function Preview({ s, first, readParts, busy, onBack, onSend }: { s: Extract<Stage, { k: "preview" }>; first: string; readParts: RequestParts; busy: boolean; onBack: () => void; onSend: (message: string) => void }) {
  const p = s.p;
  const [message, setMessage] = useState(p.message);
  const parts: RequestParts = { hook: p.words.hook, points: p.points.map((x, i) => ({ role: x.role ?? readParts.points[i]?.role ?? null, text: x.text })), close: p.words.close, captionCta: null };
  return (
    <div className="mt-2.5 space-y-2.5 rounded-lg border border-brand/40 bg-surface px-3 py-2.5">
      <div>
        <p className="text-sm font-semibold">Preview: version {p.nextVersionNo} for {first}</p>
        <p className="text-[11px] text-muted">Nothing has gone to {first} yet. Changed from version {p.readVersionNo}: the {list(p.changed)}.</p>
      </div>
      <CheckList check={p.check} title={p.how === "HERS" ? `Checked first: ${first}'s wording` : "Quality check"} />
      {p.check.needsFix && <p className="text-[11px] text-muted">The check found something to fix. You can go back and edit, or send it as it is.</p>}
      <PartsView parts={parts} title={p.titleChanged ? p.title : null} mark={p.changed} />
      <label className="block">
        <span className="text-[11px] font-semibold">Message to {first} <span className="font-normal text-muted">(under the script and in their Messages; optional)</span></span>
        <AutoTextarea value={message} onChange={(e) => setMessage(e.target.value)} minRows={2} className={cn(box, "mt-0.5 text-sm")} placeholder="For example: Great hook, I used it as written. Take a look and let me know." />
      </label>
      {p.messageWarning && <p className="text-[11px] text-warning">{p.messageWarning}</p>}
      <p className="text-[11px] text-muted-2">Send saves version {p.nextVersionNo} as a new version, shares it with {first} for their OK, and posts your message under the script and in their Messages. Their request stays on this card.</p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} onClick={() => onSend(message)} className={primary}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send version {p.nextVersionNo} to {first}</button>
        <button type="button" disabled={busy} onClick={onBack} className={quiet}>Back</button>
      </div>
    </div>
  );
}

export function ScriptRequestsPanel({ groups }: { groups: ScriptRequestGroupView[] }) {
  const openCount = groups.reduce((n, g) => n + g.requests.filter((r) => r.status === "OPEN" || r.status === "APPLYING").length, 0);
  if (groups.length === 0) return null;
  return (
    <Section icon={FileText} title="The client asked for changes" count={openCount}
      action={<span className="text-[11px] text-muted-2">read first · every path ends in a preview · nothing reaches the client until you press Send</span>}>
      <div className="space-y-4">
        {groups.map((g) => {
          const open = g.requests.filter((r) => r.status === "OPEN" || r.status === "APPLYING");
          const handled = g.requests.filter((r) => !(r.status === "OPEN" || r.status === "APPLYING"));
          return (
            <div key={g.scriptId}>
              <p className="mb-1.5 text-[13px] font-semibold">{g.title}{g.versionNo != null && <span className="ml-1.5 text-[11px] font-normal text-muted-2">now v{g.versionNo}</span>}</p>
              <div className="space-y-2">
                {open.map((r) => <RequestCard key={r.id} r={r} g={g} />)}
                {handled.length > 0 && (
                  <details open={open.length === 0 && handled.length === 1}>
                    <summary className="min-h-9 cursor-pointer py-1 text-xs font-medium text-muted hover:text-foreground">Handled request{handled.length === 1 ? "" : "s"} ({handled.length})</summary>
                    <div className="mt-1.5 space-y-2">{handled.map((r) => <RequestCard key={r.id} r={r} g={g} />)}</div>
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
