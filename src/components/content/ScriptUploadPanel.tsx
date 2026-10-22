"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, CheckCircle2, ClipboardPaste, Combine, FileText, Loader2, Send, Sparkles, Undo2, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Section } from "@/components/ui/Section";
import { ScriptView } from "@/components/script/ScriptView";
import { aiSplitScriptUploadAction, confirmScriptUploadAction, previewScriptUploadAction, rereadScriptUploadAction, sendScriptUploadAction, undoScriptUploadAction } from "@/app/content/scriptUploadActions";
import type { UploadBatchUi, UploadDraft, UploadPreview } from "@/lib/scriptUpload";

// ---------------------------------------------------------------------------
// UPLOAD THIS MONTH'S SCRIPTS (Jordan, Oct 12 2026) — Plan › Scripts, owner
// and admin only. Drop the documents (Word, PDF, text — or paste) → "Reading
// your scripts…" → one card per script in the house layout, its topic and
// pillar, what stops approval → Add them to the month → one card per upload
// with "Send to the client for review" and Undo (until anything reaches the
// client). A document not in the house labels (Joe Sutow's skits) is read by
// the AI as written, each script checked word for word against the document;
// a script whose words don't match has to be looked at before it can be added.
// The pillar is picked for each script (AI or the closest words), and stays a
// dropdown the staff can change.
// ---------------------------------------------------------------------------

type Edit = { title?: string; topic?: string; pillarId?: string | null; drop?: boolean; looked?: boolean };
type Stage = "idle" | "reading" | "preview" | "saving";

const btn = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
const quiet = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
const field = "min-h-10 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-base outline-none focus:border-brand sm:text-sm";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** The bank's own normalizer (contentPolicy.normalizeTitle), kept tiny for the browser. */
const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export function ScriptUploadPanel({ enrollmentId, monthId, monthName, clientName, batches, monthHasScripts, startOpen = false }: {
  enrollmentId: string; monthId: string; monthName: string; clientName: string;
  batches: UploadBatchUi[]; monthHasScripts: boolean; startOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen || (!monthHasScripts && batches.length === 0));
  const [stage, setStage] = useState<Stage>("idle");
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [replace, setReplace] = useState<Set<string>>(new Set());
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [slow, setSlow] = useState(false);
  const [, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reading a skit takes the AI up to a minute: after a few seconds the
  // "Reading your scripts…" line says what is happening and how long it takes.
  const startSlowTimer = () => { if (slowTimer.current) clearTimeout(slowTimer.current); setSlow(false); slowTimer.current = setTimeout(() => setSlow(true), 6000); };
  const stopSlowTimer = () => { if (slowTimer.current) clearTimeout(slowTimer.current); slowTimer.current = null; setSlow(false); };

  const loadPreview = (p: UploadPreview, keepEdits = false) => {
    setPreview(p);
    if (!keepEdits) {
      setEdits(Object.fromEntries(p.drafts.filter((d) => !d.isScript).map((d) => [d.key, { drop: true }])));
      setReplace(new Set(p.selections.filter((s) => s.replaceable && !p.drafts.some((d) => d.topicId === s.topicId)).map((s) => s.topicId)));
    }
    setStage("preview");
  };

  const read = (form: FormData, label: string) => {
    setNote(null);
    setStage("reading");
    setBusyLabel(label);
    startSlowTimer();
    start(async () => {
      const r = await previewScriptUploadAction(enrollmentId, monthId, form).catch(() => ({ ok: false as const, message: "That didn't go through — try again." }));
      setBusyLabel(null);
      stopSlowTimer();
      if (!r.ok) { setStage("idle"); setNote({ ok: false, text: r.message }); return; }
      loadPreview(r.preview);
      setNote({ ok: true, text: r.message });
    });
  };

  const readFiles = (files: FileList | File[]) => {
    const list = [...files].filter((f) => /\.(docx|pdf|txt|md)$/i.test(f.name) || f.type === "application/pdf");
    if (!list.length) { setNote({ ok: false, text: "Use Word (.docx), PDF, or text files." }); return; }
    if (list.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) { setNote({ ok: false, text: "Those files are too big to send in one go (4 MB) — upload fewer at a time, or paste the text." }); return; }
    const form = new FormData();
    for (const f of list) form.append("file", f);
    read(form, "Reading your scripts…");
  };

  const readPaste = () => {
    if (paste.trim().length < 20) { setNote({ ok: false, text: "Paste the scripts first." }); return; }
    const form = new FormData();
    form.append("text", paste);
    read(form, "Reading your scripts…");
  };

  const aiSplit = () => {
    if (!preview) return;
    setNote(null);
    setStage("reading");
    setBusyLabel("Reading your scripts as written…");
    startSlowTimer();
    const sources = preview.sources;
    start(async () => {
      const r = await aiSplitScriptUploadAction(enrollmentId, monthId, sources).catch(() => ({ ok: false as const, message: "The AI didn't answer — try again." }));
      setBusyLabel(null);
      stopSlowTimer();
      if (!r.ok) { setStage("preview"); setNote({ ok: false, text: r.message }); return; }
      loadPreview(r.preview);
      setNote({ ok: true, text: r.message });
    });
  };

  const drafts = preview?.drafts ?? [];
  const e = (d: UploadDraft): Edit => edits[d.key] ?? {};
  const titleOf = (d: UploadDraft) => (e(d).title ?? d.title);
  const topicOf = (d: UploadDraft) => e(d).topic ?? d.topicId ?? "new";
  const pillarOf = (d: UploadDraft) => (e(d).pillarId !== undefined ? e(d).pillarId : d.pillarId);
  const kept = drafts.filter((d) => !e(d).drop);
  const setEdit = (key: string, patch: Edit) => setEdits((m) => ({ ...m, [key]: { ...m[key], ...patch } }));

  // What each kept script would be on the month, and what stops the button.
  const view = useMemo(() => {
    if (!preview) return null;
    const slots = Math.max(0, preview.owed - preview.carried);
    const used = new Map<string, number>();
    for (const d of kept) { const t = topicOf(d); if (t !== "new") used.set(t, (used.get(t) ?? 0) + 1); }
    const rows = kept.map((d, i) => {
      const title = titleOf(d).trim();
      const t = topicOf(d);
      const collision = t === "new" && title ? preview.bank.find((b) => b.norm === norm(title)) ?? null : null;
      let problem: string | null = null;
      if (!title) problem = "Add a title.";
      else if (collision && !collision.eligible) problem = `A topic called “${collision.title}” already exists and ${collision.why} — change the title.`;
      else if (t !== "new" && (used.get(t) ?? 0) > 1) problem = "Two scripts use the same topic — give one its own.";
      else if (collision && kept.some((o) => o.key !== d.key && topicOf(o) === collision.id)) problem = `“${collision.title}” is already used by another script here.`;
      // Words that don't match the document: someone reads it before it goes in.
      const unchecked = !!d.asWritten && !(d.asWritten.checked && d.asWritten.ok) && !e(d).looked;
      return { d, extra: i >= slots, collision, problem, unchecked };
    });
    const unchecked = rows.filter((r) => r.unchecked).length;
    return { slots, rows, unchecked, blocked: rows.some((r) => r.problem || r.unchecked) || rows.length === 0 };
  }, [preview, kept, edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = () => {
    if (!preview || !view || view.blocked) return;
    const items = kept.map((d) => ({ key: d.key, text: d.text, title: titleOf(d).trim(), topicId: topicOf(d) === "new" ? null : topicOf(d), pillarId: pillarOf(d) ?? null, sourceName: d.sourceName }));
    setStage("saving");
    setBusyLabel(`Adding ${plural(items.length, "script")} to ${preview.monthName}…`);
    setNote(null);
    start(async () => {
      const r = await confirmScriptUploadAction({ enrollmentId, monthId, fileNames: preview.fileNames, parser: preview.parser, aiRunId: preview.aiRunId, items, replaceTopicIds: [...replace] }).catch(() => ({ ok: false, message: "That didn't go through — try again." }));
      setBusyLabel(null);
      if (!r.ok) { setStage("preview"); setNote({ ok: false, text: r.message }); return; }
      setPreview(null); setEdits({}); setStage("idle"); setOpen(false); setPaste(""); setPasting(false);
      setNote({ ok: true, text: r.message });
      router.refresh();
    });
  };

  const merge = (i: number) => {
    if (!preview) return;
    const a = drafts[i], b = drafts[i + 1];
    if (!a || !b) return;
    const items = drafts.flatMap((d, j) => j === i + 1 ? [] : [{
      key: d.key, sourceName: d.sourceName,
      text: j === i ? `${a.text}\n\n${b.text}` : d.text,
      title: titleOf(d), topicId: topicOf(d) === "new" ? null : topicOf(d), pillarId: pillarOf(d) ?? null,
    }]);
    setBusyLabel("Merging…");
    start(async () => {
      const r = await rereadScriptUploadAction(enrollmentId, monthId, items, preview.sources, preview.parser, preview.aiRunId).catch(() => ({ ok: false as const, message: "That didn't go through — try again." }));
      setBusyLabel(null);
      if (!r.ok) { setNote({ ok: false, text: r.message }); return; }
      const { [b.key]: _gone, ...rest } = edits; void _gone;
      // The merged script is checked against the document afresh: read it again.
      if (rest[a.key]) rest[a.key] = { ...rest[a.key], looked: false };
      setEdits(rest);
      loadPreview(r.preview, true);
    });
  };

  const cancel = () => { setPreview(null); setEdits({}); setStage("idle"); setNote(null); };

  return (
    <div id="upload" className="scroll-mt-20">
      <Section
        icon={Upload}
        title={`Upload ${monthName}'s scripts`}
        action={!open && stage === "idle" ? <button type="button" onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">{batches.length ? "Upload more" : "Upload scripts"}</button> : <span className="text-[12px] text-muted-2">Owner &amp; admin</span>}
      >
        <div className="space-y-4">
          {note && (
            <p role="status" className={cn("rounded-lg border px-3 py-2 text-sm", note.ok ? "border-success/30 bg-success-soft/40 text-foreground" : "border-danger/30 bg-danger/5 text-danger")}>{note.text}</p>
          )}

          {batches.map((b) => <BatchCard key={b.id} b={b} clientName={clientName} onResult={(r) => { setNote(r); router.refresh(); }} />)}

          {!open && stage === "idle" && batches.length === 0 && (
            <p className="text-sm text-muted">Wrote this month&rsquo;s scripts yourself? Upload them here — they become {monthName}&rsquo;s topics and scripts, ready to send to {clientName} for review.</p>
          )}

          {open && stage === "idle" && (
            <div className="space-y-3">
              <div
                onDragOver={(ev) => { ev.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(ev) => { ev.preventDefault(); setDragging(false); if (ev.dataTransfer.files?.length) readFiles(ev.dataTransfer.files); }}
                className={cn("rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors", dragging ? "border-brand bg-brand-soft/40" : "border-border")}
              >
                <FileText className="mx-auto size-6 text-muted" aria-hidden />
                <p className="mt-2 text-sm font-semibold">Drop your script documents here</p>
                <p className="mt-1 text-[13px] text-muted">Word (.docx), PDF or text, one document with every script or one file each. Scripts in any style are read as written: house labels, skits with speakers and directions, or plain paragraphs.</p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <input ref={fileRef} type="file" multiple accept=".docx,.pdf,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" className="hidden" onChange={(ev) => { if (ev.target.files?.length) readFiles(ev.target.files); ev.target.value = ""; }} />
                  <button type="button" onClick={() => fileRef.current?.click()} className={cn(btn, "bg-brand-action text-white")}><Upload className="size-4" aria-hidden />Choose files</button>
                  <button type="button" onClick={() => setPasting(!pasting)} className={quiet}><ClipboardPaste className="size-4" aria-hidden />Paste text</button>
                  {batches.length > 0 && <button type="button" onClick={() => setOpen(false)} className={quiet}>Close</button>}
                </div>
              </div>
              {pasting && (
                <div>
                  <label htmlFor="upload-paste" className="text-sm font-semibold">Paste the scripts</label>
                  <textarea id="upload-paste" value={paste} onChange={(ev) => setPaste(ev.target.value)} rows={10} placeholder={"1. Title\nHOOK\n…\nTALKING POINT 1 - RE-HOOK\n…\nTALKING POINT 2 - BUILD UP\n…\nTALKING POINT 3 - PAYOFF\n…\nCLOSE / CTA\n…"} className={cn(field, "mt-1 font-mono text-[13px] sm:text-[13px]")} />
                  <button type="button" onClick={readPaste} className={cn(btn, "mt-2 bg-brand-action text-white")}>Read the scripts</button>
                </div>
              )}
            </div>
          )}

          {(stage === "reading" || stage === "saving") && (
            <div role="status" className="rounded-lg border border-border bg-surface-2/50 px-3 py-3 text-sm">
              <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin text-brand" aria-hidden />{busyLabel ?? "Working…"}</p>
              {stage === "reading" && slow && <p className="mt-1 pl-6 text-[13px] text-muted">Reading each script as written and filing its lines into Hook, Re-hook, Build up, Payoff and Close. This can take up to a minute.</p>}
            </div>
          )}

          {stage === "preview" && preview && view && (
            <div className="space-y-3">
              <FitLine preview={preview} keptCount={kept.length} slots={view.slots} />
              {preview.parser === "ai" && <p className="text-[13px] text-muted">Read as written: the AI only filed your lines into Hook, Re-hook, Build up, Payoff and Close, and every word was checked against your document.</p>}
              {preview.notes.length > 0 && <ul className="list-inside list-disc space-y-0.5 text-[13px] text-muted">{preview.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
              <PillarSourceLine preview={preview} />
              <p className="rounded-lg bg-surface-2/60 px-3 py-2 text-[13px] text-muted">{preview.route.text}</p>

              {preview.selections.length > 0 && (
                <div className="rounded-lg border border-border px-3 py-2.5 text-[13px]">
                  <p className="font-semibold">Already on {preview.monthName}</p>
                  <ul className="mt-1 space-y-1">
                    {preview.selections.map((s) => {
                      const usedHere = kept.some((d) => topicOf(d) === s.topicId);
                      return (
                        <li key={s.topicId} className="flex flex-wrap items-center gap-2">
                          {s.replaceable && !usedHere ? (
                            <label className="inline-flex min-h-9 items-center gap-2">
                              <input type="checkbox" className="size-4" checked={replace.has(s.topicId)} onChange={(ev) => setReplace((r) => { const n = new Set(r); if (ev.target.checked) n.add(s.topicId); else n.delete(s.topicId); return n; })} />
                              <span>{s.title}</span>
                              <span className="text-muted-2">— {replace.has(s.topicId) ? "goes back to the topic bank" : "stays on the month"}</span>
                            </label>
                          ) : (
                            <span>{s.title} <span className="text-muted-2">— {usedHere ? "one of these scripts uses it" : s.carried ? "carried over, takes a slot first" : s.hasScript ? "has its own script, stays" : "the client has started its answers, stays"}</span></span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <ol className="space-y-3">
                {drafts.map((d, i) => {
                  const ed = e(d);
                  if (ed.drop) {
                    return (
                      <li key={d.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-[13px] text-muted">
                        <span className="min-w-0 flex-1 truncate">Left out: {titleOf(d) || `Script ${i + 1}`}</span>
                        <button type="button" onClick={() => setEdit(d.key, { drop: false })} className="font-medium text-brand hover:underline">Put it back</button>
                      </li>
                    );
                  }
                  const row = view.rows.find((r) => r.d.key === d.key)!;
                  return (
                    <DraftCard
                      key={d.key} d={d} n={kept.indexOf(d) + 1} row={row} preview={preview}
                      title={titleOf(d)} topic={topicOf(d)} pillarId={pillarOf(d) ?? null} pillarChanged={ed.pillarId !== undefined && ed.pillarId !== d.pillarId}
                      looked={!!ed.looked} onLooked={(v) => setEdit(d.key, { looked: v })}
                      onTitle={(v) => setEdit(d.key, { title: v })} onTopic={(v) => setEdit(d.key, { topic: v })} onPillar={(v) => setEdit(d.key, { pillarId: v })}
                      onDrop={() => setEdit(d.key, { drop: true })} onMerge={i < drafts.length - 1 ? () => merge(i) : null}
                      busy={!!busyLabel}
                    />
                  );
                })}
              </ol>

              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <button type="button" onClick={confirm} disabled={view.blocked || !!busyLabel} className={cn(btn, "bg-brand-action text-white")}>
                  <Check className="size-4" aria-hidden />Add {plural(kept.length, "script")} to {preview.monthName}
                </button>
                <button type="button" onClick={cancel} className={quiet}><X className="size-4" aria-hidden />Cancel</button>
                {preview.parser === "house" && preview.sources.length > 0 && (
                  <button type="button" onClick={aiSplit} disabled={!!busyLabel} className={cn(quiet, preview.suggestAi && "border-brand/40 text-brand")}><Sparkles className="size-4" aria-hidden />{preview.suggestAi ? "Doesn't look right? Let AI read it" : "Let AI read it instead"}</button>
                )}
                {view.blocked && kept.length > 0 && <span className="text-[13px] text-danger">{view.rows.some((r) => r.problem) ? "Fix the red lines first." : `Check the wording on ${view.unchecked === 1 ? "the flagged script" : `the ${view.unchecked} flagged scripts`} first.`}</span>}
              </div>
              <p className="text-[12px] text-muted-2">Nothing is saved until you add them. Nothing reaches {clientName} until you send it.</p>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

function FitLine({ preview, keptCount, slots }: { preview: UploadPreview; keptCount: number; slots: number }) {
  const owed = preview.owed;
  const open = Math.max(0, slots - keptCount);
  const extras = Math.max(0, keptCount - slots);
  return (
    <div>
      <p className="text-base font-semibold">{plural(keptCount, "script")} for {preview.monthName} · {owed} owed</p>
      <p className="text-[13px] text-muted">
        {preview.carried > 0 && <>{plural(preview.carried, "carried-over script")} take{preview.carried === 1 ? "s" : ""} the first slot{preview.carried === 1 ? "" : "s"}. </>}
        {extras > 0
          ? `The last ${extras === 1 ? "one is an extra" : `${extras} are extras`} — kept on the month, waiting ${extras === 1 ? "its" : "their"} turn, and not sent with the others.`
          : open > 0
            ? `${plural(open, "slot")} stay${open === 1 ? "s" : ""} open — the client can pick ${open === 1 ? "a topic" : "topics"} on their portal, or upload more later.`
            : `These fill ${preview.monthName}.`}
      </p>
    </div>
  );
}

/** Where the pillar list came from, said once above the cards — plainly, and never as a warning. */
function PillarSourceLine({ preview }: { preview: UploadPreview }) {
  const who = preview.clientName;
  if (preview.pillarSource === "approved") return <p className="text-[13px] text-muted">{who}&rsquo;s pillars come from the approved strategy. They&rsquo;re set up as {who}&rsquo;s pillars when you add these.</p>;
  if (preview.pillarSource === "draft") return <p className="text-[13px] text-muted">{who}&rsquo;s pillars come from the draft strategy (not approved yet), so a pillar is kept as the script&rsquo;s label for now.</p>;
  if (preview.pillarSource === "none") return <p className="text-[13px] text-muted">{who} has no content pillars on file yet. That&rsquo;s fine: these can go in without one.</p>;
  return null;
}

const FROM_GROUP: Record<UploadPreview["pillars"][number]["from"], string> = { pillar: "Pillars", approved: "From the approved strategy", draft: "From the draft strategy" };

function DraftCard({ d, n, row, preview, title, topic, pillarId, pillarChanged, looked, onLooked, onTitle, onTopic, onPillar, onDrop, onMerge, busy }: {
  d: UploadDraft; n: number; row: { extra: boolean; collision: UploadPreview["bank"][number] | null; problem: string | null; unchecked: boolean }; preview: UploadPreview;
  title: string; topic: string; pillarId: string | null; pillarChanged: boolean; looked: boolean; onLooked: (v: boolean) => void;
  onTitle: (v: string) => void; onTopic: (v: string) => void; onPillar: (v: string | null) => void; onDrop: () => void; onMerge: (() => void) | null; busy: boolean;
}) {
  const bankOptions = preview.bank.filter((b) => b.eligible || b.id === topic);
  const onMonth = bankOptions.filter((b) => b.onMonth);
  const rest = bankOptions.filter((b) => !b.onMonth);
  const chosen = topic !== "new" ? preview.bank.find((b) => b.id === topic) : null;
  const skit = d.format === "skit";
  // A skit runs longer than a talking head: its length is shown, never flagged.
  const paceTone = d.pace === "on" || skit ? "text-muted" : "font-medium text-warning";
  const groups = (["pillar", "approved", "draft"] as const).map((from) => ({ from, list: preview.pillars.filter((p) => p.from === from) })).filter((g) => g.list.length);
  const aw = d.asWritten;
  return (
    <li className={cn("rounded-xl border bg-surface p-3", row.problem ? "border-danger/40" : row.unchecked ? "border-warning/50" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-muted-2">#{n}</span>
        <input value={title} onChange={(ev) => onTitle(ev.target.value)} aria-label={`Title of script ${n}`} placeholder="Title" className={cn(field, "min-w-0 flex-1 basis-56 font-semibold")} />
      </div>
      <p className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[12px]">
        <span className={paceTone}>≈{d.seconds}s · {d.words} spoken words{d.pace === "over" ? (skit ? " · runs long, fine for a skit" : " · well over a minute") : d.pace === "under" ? " · on the short side" : ""}</span>
        {skit && <span className="text-muted-2">skit{d.speakers.length ? ` · ${d.speakers.join(", ")}` : ""}{d.directions ? ` · ${plural(d.directions, "direction")}` : ""}</span>}
        {row.extra && <span className="rounded-full bg-surface-2 px-2 text-muted">extra</span>}
        {preview.fileNames.length > 1 && <span className="text-muted-2">from {d.sourceName}</span>}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-[12px] text-muted">Topic
          <select value={topic} onChange={(ev) => onTopic(ev.target.value)} className={cn(field, "mt-0.5 text-foreground")}>
            <option value="new">New topic{title.trim() ? `: ${title.trim().slice(0, 60)}` : ""}</option>
            {onMonth.length > 0 && <optgroup label={`Picked for ${preview.monthName}`}>{onMonth.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</optgroup>}
            {rest.length > 0 && <optgroup label="Topic bank">{rest.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</optgroup>}
          </select>
        </label>
        <label className="text-[12px] text-muted">Pillar
          <select value={pillarId ?? ""} onChange={(ev) => onPillar(ev.target.value || null)} className={cn(field, "mt-0.5 text-foreground")}>
            <option value="">No pillar</option>
            {groups.length === 1 ? groups[0].list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>) : groups.map((g) => <optgroup key={g.from} label={FROM_GROUP[g.from]}>{g.list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
          </select>
          {!pillarChanged && pillarId && d.pillarWhy && <span className="mt-0.5 block text-[12px] text-muted-2">{d.pillarWhy}</span>}
          {!pillarId && preview.pillars.length > 0 && <span className="mt-0.5 block text-[12px] text-muted-2">No close match. Pick one, or leave it.</span>}
        </label>
      </div>
      <div className="mt-2 space-y-1 text-[13px]">
        {row.problem && <p className="flex items-start gap-1.5 text-danger"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{row.problem}</p>}
        {!row.problem && topic === "new" && row.collision?.eligible && <p className="text-muted">Matches “{row.collision.title}” in the topic bank — it&rsquo;ll use that topic.</p>}
        {chosen && <p className="text-muted">{chosen.onMonth ? `Uses “${chosen.title}”, already picked for ${preview.monthName}.` : `Uses “${chosen.title}” from the topic bank.`}</p>}
        {topic === "new" && !row.collision && d.suggestion && (
          <p className="text-muted">Similar topic in the bank: “{d.suggestion.title}” — <button type="button" onClick={() => onTopic(d.suggestion!.topicId)} className="font-medium text-brand hover:underline">use it</button></p>
        )}
        {aw && aw.checked && aw.ok && <p className="flex items-start gap-1.5 text-success"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />Every word matches your document.</p>}
        {aw && !(aw.checked && aw.ok) && (
          <div className="rounded-lg border border-warning/40 bg-warning-soft/30 px-2.5 py-2">
            <p className="font-medium text-foreground">{aw.checked ? "The words don't match your document exactly. Read it against the document." : "This one couldn't be lined up with your document to check its words. Read it against the document."}</p>
            {aw.missingCount > 0 && <p className="mt-1 text-muted">In your document, not in this script ({plural(aw.missingCount, "word")}): {aw.missing.map((m) => `“${m}”`).join(" · ")}</p>}
            {aw.addedCount > 0 && <p className="mt-1 text-muted">In this script, not in your document ({plural(aw.addedCount, "word")}): {aw.added.map((m) => `“${m}”`).join(" · ")}</p>}
            <label className="mt-1.5 inline-flex min-h-9 items-center gap-2 font-medium text-foreground">
              <input type="checkbox" className="size-4" checked={looked} onChange={(ev) => onLooked(ev.target.checked)} />
              I&rsquo;ve checked the wording
            </label>
          </div>
        )}
        {d.shape.map((s, i) => <p key={`s${i}`} className="text-danger">Fix before sending: {s}</p>)}
        {d.notes.filter((x) => !(pillarId && /pillar/i.test(x))).map((s, i) => <p key={`n${i}`} className="text-warning">{s}</p>)}
      </div>
      <details className="mt-2 rounded-lg border border-border bg-surface-2/30 px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-medium text-muted">Read it — Hook · Talking points · Close</summary>
        <div className="mt-2">
          {(d.goal || d.topicLine || d.dimensions) && (
            <div className="mb-2 space-y-0.5 text-[12px] text-muted">
              {d.goal && <p><span className="font-semibold">Purpose:</span> {d.goal}</p>}
              {d.topicLine && <p><span className="font-semibold">Topic:</span> {d.topicLine}</p>}
              {d.dimensions && <p><span className="font-semibold">Dimensions (from the document):</span> {d.dimensions}</p>}
            </div>
          )}
          <ScriptView body={d.houseText} parts={{ title, hook: d.parts.hook, points: d.parts.points, close: d.parts.close, captionCta: d.parts.captionCta }} pillarName={preview.pillars.find((p) => p.id === pillarId)?.name ?? null} size="sm" audience="staff" actions={false} showMissingPillar={false} />
        </div>
      </details>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" onClick={onDrop} disabled={busy} className={cn(quiet, "min-h-9 px-2.5 py-1 text-[13px]")}><X className="size-3.5" aria-hidden />Leave out</button>
        {onMerge && <button type="button" onClick={onMerge} disabled={busy} className={cn(quiet, "min-h-9 px-2.5 py-1 text-[13px]")}><Combine className="size-3.5" aria-hidden />Merge with the next one</button>}
      </div>
    </li>
  );
}

const STATE_WORD: Record<UploadBatchUi["scripts"][number]["state"], { label: string; cls: string }> = {
  review: { label: "needs your OK", cls: "bg-brand-soft text-brand" },
  approved: { label: "approved · not sent", cls: "bg-surface-2 text-muted" },
  released: { label: "with the client", cls: "bg-surface-2 text-foreground" },
  client_approved: { label: "client approved", cls: "bg-success-soft text-success" },
  changes: { label: "client asked for changes", cls: "bg-warning-soft text-warning" },
  // Oct 22 2026: filmed before the client answered. Nothing is asked of them.
  filmed: { label: "filmed", cls: "bg-success-soft text-success" },
};

function BatchCard({ b, clientName, onResult }: { b: UploadBatchUi; clientName: string; onResult: (r: { ok: boolean; text: string }) => void }) {
  const [working, setWorking] = useState<null | "send" | "undo">(null);
  const [, start] = useTransition();
  const c = b.counts;
  const withClient = c.released + c.clientApproved + c.changes + c.filmed;
  const notSent = b.scripts.length - withClient;
  const summary = withClient
    ? `With ${clientName}: ${[c.clientApproved && `${c.clientApproved} approved`, c.changes && `${c.changes} asked for changes`, c.filmed && `${c.filmed} filmed`, c.released && `${c.released} to read`].filter(Boolean).join(", ")}.${notSent ? ` ${notSent} not sent yet.` : ""}`
    : `${plural(b.scripts.length, "script")} — ${c.review ? `${c.review} waiting for your OK` : "all approved"}. Not sent yet.`;
  const send = () => {
    if (!window.confirm(`Send ${plural(b.canSend, "script")} to ${clientName}'s portal for review?\n\nThey can approve each one or ask for changes. They'll see them on their portal.`)) return;
    setWorking("send");
    start(async () => {
      const r = await sendScriptUploadAction(b.id).catch(() => ({ ok: false, message: "That didn't go through — try again." }));
      setWorking(null);
      onResult({ ok: r.ok, text: r.message });
    });
  };
  const undo = () => {
    if (!window.confirm(`Undo this upload?\n\nIts ${plural(b.scripts.length, "script")} (and any edits made to them since) are removed, topics it added are removed, and the month goes back to how it was.`)) return;
    setWorking("undo");
    start(async () => {
      const r = await undoScriptUploadAction(b.id).catch(() => ({ ok: false, message: "That didn't go through — try again." }));
      setWorking(null);
      onResult({ ok: r.ok, text: r.message });
    });
  };
  return (
    <div className="rounded-xl border border-border bg-surface-2/30 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <FileText className="size-4 shrink-0 self-center text-muted" aria-hidden />
        <span className="min-w-0 break-words font-semibold">{b.fileName}</span>
        <span className="text-[12px] text-muted-2">uploaded by {b.byName} · {fmtDay(b.atISO)}{b.parser === "ai" ? " · split by AI" : ""}</span>
      </div>
      <p className="mt-1 text-sm">{summary}</p>
      <ul className="mt-2 space-y-1">
        {b.scripts.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="min-w-0 flex-1 basis-40 break-words">{s.title}{s.versionNo && s.versionNo > 1 ? <span className="text-muted-2"> · v{s.versionNo}</span> : null}</span>
            {s.extra && <span className="rounded-full bg-surface-2 px-2 text-[11px] text-muted">extra</span>}
            <span className={cn("rounded-full px-2 text-[11px] font-medium", STATE_WORD[s.state].cls)}>{STATE_WORD[s.state].label}</span>
            {s.problem && <span className="basis-full text-[12px] text-danger">Fix before sending: {s.problem}</span>}
          </li>
        ))}
      </ul>
      {b.removed > 0 && <p className="mt-1 text-[12px] text-muted-2">{plural(b.removed, "script")} from this upload {b.removed === 1 ? "was" : "were"} deleted since.</p>}
      {b.lastError && <p className="mt-1 text-[12px] text-warning">This upload stopped part-way ({b.lastError}). Undo takes back what was added.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {b.canSend > 0 && (
          <button type="button" onClick={send} disabled={!!working} className={cn(btn, "bg-brand-action text-white")}>
            {working === "send" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            {working === "send" ? "Sending…" : `Send ${b.canSend === b.scripts.length ? (b.canSend === 1 ? "it" : `all ${b.canSend}`) : b.canSend} to ${clientName} for review`}
          </button>
        )}
        {b.canUndo ? (
          <button type="button" onClick={undo} disabled={!!working} className={quiet}>
            {working === "undo" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Undo2 className="size-4" aria-hidden />}
            {working === "undo" ? "Undoing…" : "Undo this upload"}
          </button>
        ) : (
          <span className="text-[12px] text-muted-2">{b.undoWhy}</span>
        )}
      </div>
    </div>
  );
}
