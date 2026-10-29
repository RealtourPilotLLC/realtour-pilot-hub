"use client";

import { useRef, useState, useTransition } from "react";
import { AlertTriangle, FileUp, Loader2, Upload } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { ScriptView } from "@/components/script/ScriptView";
import { applyImportAction, previewImportUpload } from "@/app/content/actions";
import type { ImportKind, ImportPreview, ItemMode } from "@/lib/contentImport";

// ---------------------------------------------------------------------------
// Import tab (spec §14): upload → a PREVIEW that writes nothing → per-item
// decisions (create / link / update proposal / skip) + the month PROPOSAL
// Jordan confirms per client → apply, idempotent by content hash. Imported
// records are history. Mis-filed records surface as review items — no
// auto-fix anywhere. Pillar labels are not asked about (Oct 23 2026): each
// lands on a confirmed pillar or none, shown on the item.
// ---------------------------------------------------------------------------

export type BatchUi = { id: string; kind: string; fileName: string | null; mode: string; proposedMonthKey: string | null; appliedAt: string | null; appliedBy: string | null; created: number; linked: number; updated: number; conflicts: number; skipped: number };
export type ReviewUi = { kind: string; monthKey: string | null; title: string; detail: string };
const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const MODES: ItemMode[] = ["CREATE", "LINK", "UPDATE_PROPOSAL", "SKIP"];

/**
 * Oct 23 2026: an item's pillar as the import will file it. The document's
 * label is matched to one of the client's confirmed pillars automatically
 * (contentPillars.matchConfirmedPillar) or the item gets no pillar; there is
 * nothing to map and no pillar is ever created by an import.
 */
function pillarChip(it: { pillarLabel: string | null; pillarId: string | null; pillarName?: string | null }, pillars: { id: string; name: string }[]): string {
  const name = it.pillarName ?? (it.pillarId ? pillars.find((p) => p.id === it.pillarId)?.name ?? null : null);
  if (!name) return `${it.pillarLabel} → no pillar`;
  return it.pillarLabel && it.pillarLabel.trim().toLowerCase() === name.trim().toLowerCase() ? name : `${it.pillarLabel} → ${name}`;
}

export function ImportPanel({ enrollmentId, batches, reviewItems, pillars }: { enrollmentId: string; batches: BatchUi[]; reviewItems: ReviewUi[]; pillars: { id: string; name: string }[] }) {
  const [kind, setKind] = useState<ImportKind>("SCRIPTS");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [monthKey, setMonthKey] = useState("");
  const [modes, setModes] = useState<Record<number, ItemMode>>({});
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-5">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}
      <Section icon={FileUp} title="Import a document" flush action={<span className="text-[11px] text-muted-2">PDF, Word or text · preview first, nothing is written until you apply</span>}>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return;
          const fd = new FormData(); fd.append("file", f);
          start(async () => { const p = await previewImportUpload(enrollmentId, kind, fd); if (!p.ok) { setNote(p.message); return; } setPreview(p.preview); setMonthKey(p.preview.proposedMonthKey ?? ""); setModes({}); setNote(p.message); });
          e.target.value = "";
        }} />
        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          <select value={kind} onChange={(e) => setKind(e.target.value as ImportKind)} className="rounded border border-border bg-surface-2 px-2 py-1 text-xs"><option value="SCRIPTS">Scripts document</option><option value="TOPICS">Topic bank</option><option value="STRATEGY">Strategy document</option></select>
          <button disabled={busy} onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"><Upload className="size-4" />{busy ? "Reading…" : "Choose a file"}</button>
        </div>
        {preview && (
          <div className="border-t border-border px-5 py-3">
            <p className="break-words text-sm">{preview.fileName} · {preview.items.length} items{preview.existingBatchId ? " · this exact file was imported before — re-opening that batch (already-applied items stay untouched)" : ""}</p>
            {preview.notes.length > 0 && <ul className="mt-1 list-inside list-disc text-[11px] text-muted-2">{preview.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            {preview.kind !== "STRATEGY" && (
              <div className="mt-2 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2 text-[12px]">
                <p>{preview.monthRule}</p>
                <label className="mt-1 inline-flex items-center gap-2">Content month: <input type="month" value={monthKey} onChange={(e) => setMonthKey(e.target.value)} className="rounded border border-border bg-surface px-2 py-1 text-xs" /></label>
                {preview.documentMonthKey && <button onClick={() => setMonthKey(preview.documentMonthKey!)} className="ml-2 text-[11px] text-muted hover:underline">use the document&rsquo;s own month ({preview.documentMonthKey}) instead</button>}
              </div>
            )}
            <div className="mt-2 max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {preview.items.map((it) => (
                <div key={it.ordinal} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-muted-2">#{it.ordinal}</span><span className="text-sm font-medium">{it.title}</span>
                    {it.pillarLabel && <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-muted" title={it.pillarWhy ?? undefined}>{pillarChip(it, pillars)}</span>}
                    {it.importedMark && <span className="text-[11px] text-warning">mark: {it.importedMark} → proposes {it.proposedState?.toLowerCase()}</span>}
                    <select value={modes[it.ordinal] ?? it.proposedMode} onChange={(e) => setModes({ ...modes, [it.ordinal]: e.target.value as ItemMode })} className="ml-auto max-w-full rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px]">
                      {[...new Set([it.proposedMode, ...MODES])].map((m) => <option key={m} value={m}>{m === "CREATE" ? "create" : m === "LINK" ? `link to existing${it.targetTitle ? ` (${it.targetTitle})` : ""}` : m === "UPDATE_PROPOSAL" ? "propose as update / new version" : m === "CONFLICT" ? "conflict — hold" : "skip"}</option>)}
                    </select>
                  </div>
                  {it.conflictNote && <p className="text-[11px] text-warning">{it.conflictNote}</p>}
                  {it.warnings.length > 0 && <p className="text-[11px] text-muted-2">{it.warnings.slice(0, 2).join(" · ")}</p>}
                  <details className="mt-1"><summary className="cursor-pointer text-[11px] text-muted">source text (verbatim)</summary>{it.kind === "SCRIPT" ? <ScriptView body={it.sourceText.slice(0, 3000)} size="xs" audience="staff" actions={false} /> : <pre className="mt-1 whitespace-pre-wrap text-[11px] text-foreground/80">{it.sourceText.slice(0, 3000)}</pre>}</details>
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button disabled={busy || (preview.kind !== "STRATEGY" && !/^\d{4}-\d{2}$/.test(monthKey))} onClick={() => start(async () => { const r = await applyImportAction(preview, { monthKey: preview.kind === "STRATEGY" ? null : monthKey, modes }); setNote(r.message); if (r.ok) setPreview(null); })} className={`${btn} bg-brand-action text-white`}>Apply {preview.items.length} item{preview.items.length === 1 ? "" : "s"} as history</button>
              <button onClick={() => setPreview(null)} className={quiet}>Discard preview</button>
            </div>
          </div>
        )}
      </Section>
      <Section icon={AlertTriangle} title="Review items — mis-filed records, decided by a person" count={reviewItems.length} tone={reviewItems.length ? "warning" : "default"} flush>
        <div className="divide-y divide-border">
          {reviewItems.length === 0 && <p className="px-5 py-3 text-sm text-muted">Nothing looks mis-filed.</p>}
          {reviewItems.map((r, i) => <div key={i} className="px-5 py-2.5"><div className="text-sm font-medium">{r.title}</div><p className="text-[12px] text-muted">{r.detail}</p></div>)}
        </div>
      </Section>
      <Section icon={FileUp} title="Import batches" count={batches.length} flush>
        <div className="divide-y divide-border">
          {batches.length === 0 && <p className="px-5 py-3 text-sm text-muted">No imports through this tool yet.</p>}
          {batches.map((b) => <div key={b.id} className="break-words px-5 py-2 text-[12px]"><span className="font-medium">{b.fileName ?? b.id}</span> · {b.kind.toLowerCase()} · {b.mode.toLowerCase()}{b.proposedMonthKey ? ` · ${b.proposedMonthKey}` : ""}{b.appliedAt ? ` · applied by ${b.appliedBy}` : ""} · {b.created} created / {b.linked} linked / {b.updated} updates / {b.skipped} skipped / {b.conflicts} conflicts</div>)}
        </div>
      </Section>
    </div>
  );
}
