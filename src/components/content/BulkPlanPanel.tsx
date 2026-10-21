"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, CalendarRange, ClipboardPaste, FileText, Layers, Loader2, Send, Shuffle, Undo2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Section } from "@/components/ui/Section";
import type { BulkBoard, BulkItem } from "@/lib/bulkPlan";
import {
  createBulkPlanAction, importBulkScriptsAction, moveBulkScriptAction, nudgeBulkScriptAction, previewBulkScriptsAction,
  rebalanceBulkAction, releaseBulkScriptsAction, setBulkShootSessionAction, setClientScriptFormatAction, undoBulkImportAction, updateBulkPlanAction,
} from "@/app/content/actions";

// ---------------------------------------------------------------------------
// BULK PLAN (Oct 15 2026) — the office side of bulkPlan.ts. Turn it on for a
// client, drop in their script bank (in order), and the board shows every
// session: what is planned, what the upload portal says was filmed (and at
// which session), what the client ticked, and what is delivered. Scripts move
// between sessions with a select; "Spread the rest" re-packs what nobody has
// filmed across the sessions still to come.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
const quiet = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
const input = "min-h-10 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand";

const STATE_WORDS: Record<BulkItem["state"], { label: string; cls: string }> = {
  planned: { label: "To film", cls: "bg-surface-2 text-muted" },
  client_done: { label: "Client ticked", cls: "bg-brand-soft text-brand" },
  filmed: { label: "Filmed", cls: "bg-success-soft text-success" },
  editing: { label: "Editing", cls: "bg-brand-soft text-brand" },
  in_review: { label: "In review", cls: "bg-brand-soft text-brand" },
  delivered: { label: "Delivered", cls: "bg-success-soft text-success" },
};
const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" }) : "no date");
const ymd = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");

export type BulkImportUi = { id: string; fileName: string | null; atISO: string; count: number };

export function BulkPlanPanel({ enrollmentId, clientFirst, board, imports, clientFormat, defaultMonthKey }: {
  enrollmentId: string; clientFirst: string; board: BulkBoard | null; imports: BulkImportUi[]; clientFormat: string | null; defaultMonthKey: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (f: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await f().catch(() => ({ ok: false, message: "That didn't go through. Try again." }));
      setNote({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });

  if (!board) return <CreatePlan enrollmentId={enrollmentId} clientFirst={clientFirst} defaultMonthKey={defaultMonthKey} busy={busy} run={run} note={note} />;

  const p = board.plan;
  const sessionOptions = Array.from({ length: Math.max(p.sessionsPlanned, ...board.sessions.map((s) => s.no)) + 1 }, (_, i) => i + 1);
  return (
    <div className="space-y-5">
      <Section
        icon={Layers}
        title={p.title || `${clientFirst}'s bulk plan`}
        action={<span className="text-[12px] text-muted-2">{p.status === "ACTIVE" ? "Active" : p.status === "COMPLETE" ? "Complete" : "Cancelled"} · owner &amp; admin</span>}
      >
        <div className="space-y-3">
          <p className="text-sm">
            <b>{board.totals.planned}</b> of {p.totalVideos} scripts planned · <b>{board.totals.filmed}</b> filmed · <b>{board.totals.delivered}</b> delivered · {board.totals.released} on {clientFirst}&rsquo;s portal · {board.totals.clientDone} ticked by {clientFirst}
          </p>
          <p className="text-[13px] text-muted">
            {p.perSession} a session · {Math.max(p.sessionsPlanned, board.sessions.length)} sessions · every {p.cadenceDays} days{p.startsOnISO ? ` from ${fmtDay(p.startsOnISO)}` : ""}. Filming is what the upload portal says; {clientFirst}&rsquo;s ticks are advisory.
          </p>
          <PlanSettings board={board} busy={busy} run={run} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => run(() => rebalanceBulkAction(p.id))} className={quiet}><Shuffle className="size-4" aria-hidden />Spread the unfilmed scripts</button>
            {board.totals.released < board.totals.planned && (
              <button type="button" disabled={busy} onClick={() => run(() => releaseBulkScriptsAction(p.id))} className={quiet}><Send className="size-4" aria-hidden />Put all scripts on the portal</button>
            )}
          </div>
          <FormatLine enrollmentId={enrollmentId} clientFormat={clientFormat} busy={busy} run={run} />
          {note && <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", note.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>{note.text}</p>}
        </div>
      </Section>

      <ImportBank planId={p.id} clientFirst={clientFirst} imports={imports} busy={busy} run={run} />

      <div className="space-y-3">
        {board.sessions.map((s) => (
          <Section
            key={s.no}
            icon={CalendarRange}
            title={`Session ${s.no} · ${fmtDay(s.dateISO)}${s.booked ? "" : " (planned)"}`}
            action={<span className="text-[12px] text-muted">{s.filmed}/{s.items.length} filmed{s.filmedHere > s.filmed ? ` · ${s.filmedHere} filmed at this shoot` : ""}{s.no === board.nextSessionNo ? " · up next" : ""}</span>}
          >
            {s.shoots.length > 0 && (
              <ul className="mb-2 space-y-1 text-[13px]">
                {s.shoots.map((sh) => (
                  <li key={sh.projectId} className="flex flex-wrap items-center gap-2 text-muted">
                    <a href={`/projects/${sh.projectId}`} className="font-medium text-foreground hover:underline">{fmtDay(sh.shootDateISO)} shoot</a>
                    <span>({sh.status.toLowerCase()})</span>
                    <label className="inline-flex items-center gap-1">
                      <span className="sr-only">Session for this shoot</span>
                      <select
                        disabled={busy}
                        value={sh.explicit ? String(sh.sessionNo) : ""}
                        onChange={(e) => run(() => setBulkShootSessionAction(sh.projectId, e.target.value ? Number(e.target.value) : null))}
                        className="min-h-9 rounded-md border border-border bg-surface-2 px-2 text-[13px]"
                      >
                        <option value="">Session by date ({sh.sessionNo})</option>
                        {sessionOptions.map((n) => <option key={n} value={n}>Session {n}</option>)}
                      </select>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {s.items.length === 0 ? (
              <p className="text-sm text-muted">Nothing planned for this session.</p>
            ) : (
              <ol className="divide-y divide-border">
                {s.items.map((x) => (
                  <Row key={x.topicId} x={x} planId={p.id} sessionOptions={sessionOptions} busy={busy} run={run} />
                ))}
              </ol>
            )}
          </Section>
        ))}
        {board.unplanned.length > 0 && (
          <Section icon={Layers} title={`Not in a session (${board.unplanned.length})`}>
            <ol className="divide-y divide-border">
              {board.unplanned.map((x) => <Row key={x.topicId} x={x} planId={p.id} sessionOptions={sessionOptions} busy={busy} run={run} />)}
            </ol>
          </Section>
        )}
      </div>
    </div>
  );
}

function Row({ x, planId, sessionOptions, busy, run }: { x: BulkItem; planId: string; sessionOptions: number[]; busy: boolean; run: (f: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const w = STATE_WORDS[x.state];
  const open = x.state === "planned" || x.state === "client_done";
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span className="w-7 shrink-0 text-right text-[12px] tabular-nums text-muted">{x.rank}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{x.title}</p>
        <p className="text-[12px] text-muted">
          {x.pillar ?? "No pillar"}{x.released ? "" : " · not on the portal yet"}
          {x.filmedSessionNo && x.filmedSessionNo !== x.sessionNo ? ` · filmed at session ${x.filmedSessionNo}` : ""}
          {x.clientMarkedDoneAtISO && open ? ` · ticked ${fmtDay(x.clientMarkedDoneAtISO)}, no footage yet` : ""}
        </p>
      </div>
      <span className={cn("rounded-md px-2 py-0.5 text-[12px] font-semibold", w.cls)}>{w.label}</span>
      {open && (
        <>
          <button type="button" aria-label={`Move “${x.title}” up`} disabled={busy} onClick={() => run(() => nudgeBulkScriptAction(planId, x.topicId, "up"))} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-40"><ArrowUp className="size-4" /></button>
          <button type="button" aria-label={`Move “${x.title}” down`} disabled={busy} onClick={() => run(() => nudgeBulkScriptAction(planId, x.topicId, "down"))} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-40"><ArrowDown className="size-4" /></button>
          <label>
            <span className="sr-only">Session for “{x.title}”</span>
            <select disabled={busy} value={x.sessionNo ?? ""} onChange={(e) => e.target.value && run(() => moveBulkScriptAction(planId, x.topicId, Number(e.target.value)))} className="min-h-9 rounded-md border border-border bg-surface-2 px-2 text-[13px]">
              {x.sessionNo == null && <option value="">Pick a session</option>}
              {sessionOptions.map((n) => <option key={n} value={n}>Session {n}</option>)}
            </select>
          </label>
        </>
      )}
    </li>
  );
}

function PlanSettings({ board, busy, run }: { board: BulkBoard; busy: boolean; run: (f: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const p = board.plan;
  const [per, setPer] = useState(String(p.perSession));
  const [sessions, setSessions] = useState(String(p.sessionsPlanned));
  const [cadence, setCadence] = useState(String(p.cadenceDays));
  const [startsOn, setStartsOn] = useState(ymd(p.startsOnISO));
  const [editing, setEditing] = useState(p.editingNote ?? "");
  return (
    <details className="rounded-lg border border-border">
      <summary className="flex min-h-10 cursor-pointer items-center px-3 text-sm font-medium">Plan numbers and the editing note</summary>
      <div className="grid gap-3 p-3 sm:grid-cols-4">
        <label className="text-[13px] text-muted">Videos a session<input className={input} inputMode="numeric" value={per} onChange={(e) => setPer(e.target.value)} /></label>
        <label className="text-[13px] text-muted">Sessions<input className={input} inputMode="numeric" value={sessions} onChange={(e) => setSessions(e.target.value)} /></label>
        <label className="text-[13px] text-muted">Days between<input className={input} inputMode="numeric" value={cadence} onChange={(e) => setCadence(e.target.value)} /></label>
        <label className="text-[13px] text-muted">First session<input className={input} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
        <label className="text-[13px] text-muted sm:col-span-4">Editing note for every video (editors see it on each script)
          <textarea className={cn(input, "min-h-20")} value={editing} onChange={(e) => setEditing(e.target.value)} maxLength={2000} />
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-4">
          <button type="button" disabled={busy} className={cn(btn, "bg-brand-action text-white")} onClick={() => run(() => updateBulkPlanAction(p.id, { perSession: Number(per), sessionsPlanned: Number(sessions), cadenceDays: Number(cadence), startsOn: startsOn || null, editingNote: editing }))}>Save</button>
          {p.status === "ACTIVE" ? (
            <>
              <button type="button" disabled={busy} className={quiet} onClick={() => run(() => updateBulkPlanAction(p.id, { status: "COMPLETE" }))}>Mark the plan complete</button>
              <button type="button" disabled={busy} className={quiet} onClick={() => { if (window.confirm("Cancel this bulk plan? Scripts and videos stay; the plan stops driving sessions.")) run(() => updateBulkPlanAction(p.id, { status: "CANCELLED" })); }}>Cancel the plan</button>
            </>
          ) : (
            <button type="button" disabled={busy} className={quiet} onClick={() => run(() => updateBulkPlanAction(p.id, { status: "ACTIVE" }))}>Reopen the plan</button>
          )}
        </div>
      </div>
    </details>
  );
}

function FormatLine({ enrollmentId, clientFormat, busy, run }: { enrollmentId: string; clientFormat: string | null; busy: boolean; run: (f: () => Promise<{ ok: boolean; message: string }>) => void }) {
  return (
    <p className="text-[13px] text-muted">
      Script format: {clientFormat ? <>the client&rsquo;s own (<b>{clientFormat}</b>). The three-point house rule is not enforced. </> : "the house format (hook and three talking points). "}
      <button type="button" disabled={busy} className="font-medium text-brand hover:underline" onClick={() => run(() => setClientScriptFormatAction(enrollmentId, clientFormat ? null : "Hook, Beat, Payoff (the client's own script bank)"))}>
        {clientFormat ? "Use the house format" : "Keep their own format"}
      </button>
    </p>
  );
}

function ImportBank({ planId, clientFirst, imports, busy, run }: { planId: string; clientFirst: string; imports: BulkImportUi[]; busy: boolean; run: (f: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [pasting, setPasting] = useState(false);
  const [release, setRelease] = useState(true);
  const [preview, setPreview] = useState<{ ok: boolean; message: string; count?: number; titles?: string[]; problems?: string[]; note?: string | null } | null>(null);
  const [reading, startRead] = useTransition();
  const form = () => {
    const f = new FormData();
    if (pasting && text.trim()) f.set("text", text);
    else if (file) f.set("file", file);
    f.set("release", release ? "1" : "0");
    return f;
  };
  const read = () => startRead(async () => setPreview(await previewBulkScriptsAction(form()).catch(() => ({ ok: false, message: "That didn't read. Try again." }))));
  return (
    <Section icon={Upload} title="Add the script bank" action={<span className="text-[12px] text-muted-2">In order, words kept exactly</span>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">One document with every script, in the order to film them (VIDEO 1, VIDEO 2…). They fill the sessions in that order, after anything already planned. A DELIVERY NOTE at the top becomes the editing note.</p>
        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept=".docx,.pdf,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPasting(false); setPreview(null); }} />
          <button type="button" onClick={() => fileRef.current?.click()} className={cn(btn, "bg-brand-action text-white")}><FileText className="size-4" aria-hidden />{file ? file.name : "Choose the document"}</button>
          <button type="button" onClick={() => { setPasting(!pasting); setPreview(null); }} className={quiet}><ClipboardPaste className="size-4" aria-hidden />Paste text</button>
        </div>
        {pasting && <textarea aria-label="Paste the scripts" className={cn(input, "min-h-40 font-mono text-[13px]")} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} className="size-4" />
          Put them on {clientFirst}&rsquo;s portal right away (no email goes out; you tell {clientFirst})
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={reading || busy || (!file && !text.trim())} onClick={read} className={quiet}>{reading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}Read it first</button>
          <button type="button" disabled={busy || !preview?.ok} onClick={() => run(async () => { const r = await importBulkScriptsAction(planId, form()); if (r.ok) { setPreview(null); setFile(null); setText(""); } return r; })} className={cn(btn, "bg-brand-action text-white")}>
            <Send className="size-4" aria-hidden />Add {preview?.count ?? ""} scripts to the plan
          </button>
        </div>
        {preview && (
          <div className={cn("rounded-lg border px-3 py-2 text-sm", preview.ok ? "border-border" : "border-danger/40 bg-danger-soft text-danger")}>
            <p className="font-medium">{preview.message}</p>
            {preview.note && <p className="mt-1 text-[13px] text-muted">Editing note: {preview.note}</p>}
            {preview.problems && preview.problems.length > 0 && <ul className="mt-1 list-inside list-disc text-[13px] text-warning">{preview.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
            {preview.titles && preview.titles.length > 0 && (
              <details className="mt-1"><summary className="cursor-pointer text-[13px] text-muted">See the {preview.titles.length} titles</summary><ol className="mt-1 columns-1 text-[13px] sm:columns-2">{preview.titles.map((t) => <li key={t}>{t}</li>)}</ol></details>
            )}
          </div>
        )}
        {imports.length > 0 && (
          <ul className="space-y-1 text-[13px] text-muted">
            {imports.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2">
                <span>{b.fileName ?? "Scripts"} · {b.count} scripts · {fmtDay(b.atISO)}</span>
                <button type="button" disabled={busy} onClick={() => { if (window.confirm("Take these scripts off the plan? Only possible while none of them is filmed.")) run(() => undoBulkImportAction(b.id)); }} className="inline-flex items-center gap-1 font-medium text-brand hover:underline"><Undo2 className="size-3.5" aria-hidden />Undo</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function CreatePlan({ enrollmentId, clientFirst, defaultMonthKey, busy, run, note }: { enrollmentId: string; clientFirst: string; defaultMonthKey: string; busy: boolean; run: (f: () => Promise<{ ok: boolean; message: string }>) => void; note: { ok: boolean; text: string } | null }) {
  const [total, setTotal] = useState("48");
  const [per, setPer] = useState("8");
  const [cadence, setCadence] = useState("7");
  const [startsOn, setStartsOn] = useState("");
  const [monthKey, setMonthKey] = useState(defaultMonthKey);
  const sessions = Math.max(1, Math.ceil((Number(total) || 0) / Math.max(1, Number(per) || 1)));
  return (
    <Section icon={Layers} title="Bulk plan" action={<span className="text-[12px] text-muted-2">Owner &amp; admin</span>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          For a client filming a batch of videos over a few weeks instead of month by month. Their scripts are planned session by session, they read and tick them on their portal, and the upload portal records what was filmed. Monthly planning, reminders and topic ideas stop for {clientFirst} while the plan runs.
        </p>
        <div className="grid gap-3 sm:grid-cols-5">
          <label className="text-[13px] text-muted">Total videos<input className={input} inputMode="numeric" value={total} onChange={(e) => setTotal(e.target.value)} /></label>
          <label className="text-[13px] text-muted">Videos a session<input className={input} inputMode="numeric" value={per} onChange={(e) => setPer(e.target.value)} /></label>
          <label className="text-[13px] text-muted">Days between<input className={input} inputMode="numeric" value={cadence} onChange={(e) => setCadence(e.target.value)} /></label>
          <label className="text-[13px] text-muted">First session<input className={input} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
          <label className="text-[13px] text-muted">Plan month<input className={input} value={monthKey} onChange={(e) => setMonthKey(e.target.value)} /></label>
        </div>
        <p className="text-[13px] text-muted">{sessions} session{sessions === 1 ? "" : "s"} of {per || "?"}.</p>
        <button
          type="button"
          disabled={busy}
          className={cn(btn, "bg-brand-action text-white")}
          onClick={() => run(() => createBulkPlanAction({ enrollmentId, totalVideos: Number(total), perSession: Number(per), cadenceDays: Number(cadence), startsOn: startsOn || null, monthKey }))}
        >
          Turn on the bulk plan
        </button>
        {note && <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", note.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>{note.text}</p>}
      </div>
    </Section>
  );
}
