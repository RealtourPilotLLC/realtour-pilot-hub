"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Compass, Layers, Loader2, Send, Upload, X } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import {
  addPillar, approveStrategy, confirmPillarMappingAction, createPillarsFromStrategy, dismissPillarLabelAction, previewStrategyBackfill, rejectStrategy, releaseStrategy,
  renamePillarAction, resolveStrategyProposal, saveMonthPriorities, saveStrategyBackfill, setDutyOwner, type StrategyPreview,
} from "@/app/content/actions";

// ---------------------------------------------------------------------------
// Strategy tab (spec §3/§21): versions never overwrite; approve and release
// are two separate, attributable acts; a call's proposal is accepted or
// rejected with its source in view; pillars are stable identities and the
// free-text pillar labels on old topics are mapped ONLY when Jordan confirms
// each one. The month's priorities live apart from the brand foundation.
// ---------------------------------------------------------------------------

export type VersionRow = { id: string; versionNo: number; status: string; structureTemplate: string; sourceKind: string; sourceRef: string | null; createdBy: string | null; createdAt: string; approvedBy: string | null; approvedAt: string | null; releasedAt: string | null; changeSummary: string | null; sections: { heading: string; text: string }[]; pillarNames: string[] };
export type ProposalRow = { id: string; kind: string; summary: string; impact: string | null; sourceKind: string; sourceRef: string | null; createdAt: string };
export type PillarRowUi = { id: string; name: string; purpose: string | null; focusAreas: string | null; aliases: string[]; status: string };
export type MappingRowUi = { label: string; topicCount: number; sample: string[]; proposedPillarId: string | null; proposedPillarName: string | null; confidence: number; isQualityDimension: boolean };
export type OwnerUi = { duty: string; label: string; scope: string; appUserId: string | null };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");
const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2";

export function StrategyPanel({ enrollmentId, versions, proposals, pillars, mapping, owners, staff, isOwner, month }: {
  enrollmentId: string; versions: VersionRow[]; proposals: ProposalRow[]; pillars: PillarRowUi[]; mapping: MappingRowUi[]; owners: OwnerUi[];
  staff: { id: string; name: string }[]; isOwner: boolean; month: { id: string; label: string; priorities: string[]; sourceRef: string | null } | null;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [open, setOpen] = useState<string | null>(versions.find((v) => v.status === "APPROVED")?.id ?? versions[0]?.id ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<StrategyPreview | null>(null);
  const approved = versions.find((v) => v.status === "APPROVED") ?? null;
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setNote(r.message); });

  return (
    <div className="space-y-5">
      {/* Owners */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        {owners.filter((o) => o.duty === "STRATEGY" || o.duty === "SCRIPTS" || o.duty === "SCHEDULING" || o.duty === "DELIVERY").map((o) => (
          <span key={o.duty} className="inline-flex items-center gap-1">
            <span className="uppercase tracking-wide text-muted-2">{o.duty.toLowerCase()}</span>
            {isOwner ? (
              <select value={o.appUserId ?? ""} disabled={busy} onChange={(e) => run(() => setDutyOwner(enrollmentId, o.duty as never, e.target.value || null))} className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[12px]">
                <option value="">{o.scope === "DEFAULT" ? `${o.label} (default)` : "program default"}</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}{o.appUserId === s.id && o.scope !== "DEFAULT" ? " (override)" : ""}</option>)}
              </select>
            ) : <span className="font-medium text-foreground">{o.label}</span>}
          </span>
        ))}
      </div>

      {/* Proposals from calls / clients */}
      {proposals.length > 0 && (
        <Section icon={Send} title="Proposed changes to the strategy" count={proposals.length} tone="warning" flush>
          <div className="divide-y divide-border">
            {proposals.map((p) => <ProposalItem key={p.id} p={p} busy={busy} onResolve={(accept, n) => run(() => resolveStrategyProposal(p.id, accept, n))} />)}
          </div>
        </Section>
      )}

      {/* Versions */}
      <Section icon={Compass} title="Strategy versions" count={versions.length} flush
        action={
          <button onClick={() => fileRef.current?.click()} disabled={busy} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline disabled:opacity-50">
            <Upload className="size-3.5" /> Upload a strategy document (becomes the next version)
          </button>
        }>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return;
          const fd = new FormData(); fd.append("file", f);
          start(async () => { const p = await previewStrategyBackfill(fd); if (!p.ok) { setNote(p.message); return; } setPreview(p); });
          e.target.value = "";
        }} />
        {preview && (
          <div className="border-b border-border bg-surface-2/40 px-5 py-3">
            <p className="text-sm">{preview.message}</p>
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-surface p-2">
              {Object.entries(preview.sections ?? {}).map(([k, v]) => (
                <details key={k}><summary className="cursor-pointer text-xs font-semibold">{k}</summary><p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground/80">{v.slice(0, 1500)}{v.length > 1500 ? "…" : ""}</p></details>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button disabled={busy} onClick={() => run(async () => { const r = await saveStrategyBackfill(enrollmentId, preview.sections ?? {}, preview.rawText ?? "", preview.sourceFile ?? "upload"); if (r.ok) setPreview(null); return r; })} className={`${btn} bg-brand text-white`}>Save as the next version</button>
              <button onClick={() => setPreview(null)} className={quiet}>Discard</button>
            </div>
          </div>
        )}
        <div className="divide-y divide-border">
          {versions.length === 0 && <p className="px-5 py-4 text-sm text-muted">No strategy on file yet — upload their strategy document, or draft one from a brand-discovery call.</p>}
          {versions.map((v) => (
            <div key={v.id} className="px-5 py-3">
              <button onClick={() => setOpen(open === v.id ? null : v.id)} className="flex w-full flex-wrap items-center gap-2 text-left">
                <span className="text-[15px] font-semibold">v{v.versionNo}</span>
                <StatusChip status={v.status} released={!!v.releasedAt} />
                <span className="text-[12px] text-muted">{v.structureTemplate} · {v.sourceKind.replace("_", " ")}{v.sourceRef ? ` · ${v.sourceRef}` : ""} · {fmt(v.createdAt)}{v.createdBy ? ` by ${v.createdBy}` : ""}</span>
                {v.approvedAt && <span className="text-[12px] text-success">approved {fmt(v.approvedAt)} by {v.approvedBy}</span>}
                {v.releasedAt && <span className="text-[12px] text-success">released {fmt(v.releasedAt)}</span>}
              </button>
              {v.changeSummary && <p className="mt-1 text-[12px] text-muted">{v.changeSummary}</p>}
              {open === v.id && (
                <div className="mt-2 space-y-2">
                  {v.pillarNames.length > 0 && <p className="text-[12px]"><span className="text-muted-2">Pillars in this version:</span> {v.pillarNames.join(" · ")}</p>}
                  {v.sections.map((s, i) => (
                    <details key={i} className="rounded-xl border border-border px-3 py-2"><summary className="cursor-pointer text-sm font-medium">{s.heading}</summary><p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">{s.text || "(empty)"}</p></details>
                  ))}
                  <div className="flex flex-wrap gap-1.5">
                    {v.status !== "APPROVED" && v.status !== "REJECTED" && v.status !== "SUPERSEDED" && (
                      <button disabled={busy} onClick={() => run(() => approveStrategy(v.id))} className={`${btn} bg-success/15 text-success hover:bg-success/25`}><Check className="mr-1 inline size-3" />Approve v{v.versionNo}</button>
                    )}
                    {v.status === "SUPERSEDED" && <button disabled={busy} onClick={() => run(() => approveStrategy(v.id))} className={quiet}>Re-approve this older version</button>}
                    {v.status === "APPROVED" && !v.releasedAt && isOwner && (
                      <button disabled={busy} onClick={() => run(() => releaseStrategy(v.id))} className={`${btn} bg-brand text-white`}>Release to the portal</button>
                    )}
                    {/* The four lifted v1s were approved before pillar creation existed — this creates the document's pillars on demand (idempotent). */}
                    {v.status === "APPROVED" && v.pillarNames.some((n) => !pillars.some((p) => p.name.toLowerCase() === n.toLowerCase() || p.aliases.some((a) => a.toLowerCase() === n.toLowerCase()))) && (
                      <button disabled={busy} onClick={() => run(() => createPillarsFromStrategy(v.id))} className={quiet}>Create the missing pillars from this document</button>
                    )}
                    {v.status !== "APPROVED" && v.status !== "REJECTED" && (
                      <button disabled={busy} onClick={() => { const n = window.prompt("Why reject this version?") ?? ""; run(() => rejectStrategy(v.id, n)); }} className={quiet}><X className="mr-1 inline size-3" />Reject</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* This month's priorities (apart from the foundation) */}
      {month && <PrioritiesCard month={month} busy={busy} onSave={(t) => run(() => saveMonthPriorities(month.id, t))} />}

      {/* Pillars + mapping proposal */}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Section icon={Layers} title="Content pillars" count={pillars.length} flush action={approved ? <span className="text-[11px] text-muted-2">from v{approved.versionNo} + edits</span> : undefined}>
          <div className="divide-y divide-border">
            {pillars.map((p) => <PillarItem key={p.id} p={p} busy={busy} onRename={(n) => run(() => renamePillarAction(enrollmentId, p.id, n))} />)}
            {pillars.length === 0 && <p className="px-5 py-3 text-sm text-muted">No pillars yet — approving a strategy creates them from the document, or add one below.</p>}
          </div>
          <AddPillar busy={busy} onAdd={(n, pu, fa) => run(() => addPillar(enrollmentId, n, pu, fa))} />
        </Section>
        <Section icon={Layers} title="Pillar labels to map" count={mapping.length} flush
          action={<span className="text-[11px] text-muted-2">free-text labels on old topics — confirm each</span>}>
          <div className="divide-y divide-border">
            {mapping.length === 0 && <p className="px-5 py-3 text-sm text-muted">Every topic label is linked to a pillar.</p>}
            {mapping.map((m) => <MappingItem key={m.label} m={m} pillars={pillars} busy={busy}
              onConfirm={(pid) => run(() => confirmPillarMappingAction(enrollmentId, m.label, pid))}
              onDismiss={() => run(() => dismissPillarLabelAction(enrollmentId, m.label))} />)}
          </div>
        </Section>
      </div>
      {note && <p className="text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}
    </div>
  );
}

function StatusChip({ status, released }: { status: string; released: boolean }) {
  const cls = status === "APPROVED" ? "bg-success-soft text-success" : status === "DRAFT" || status === "INTERNAL_REVIEW" ? "bg-brand-soft text-brand" : "bg-surface-2 text-muted";
  const label = status === "APPROVED" ? (released ? "in force · released" : "in force") : status === "INTERNAL_REVIEW" ? "needs your OK" : status.toLowerCase();
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

function ProposalItem({ p, busy, onResolve }: { p: ProposalRow; busy: boolean; onResolve: (accept: boolean, note: string) => void }) {
  const [n, setN] = useState("");
  return (
    <div className="px-5 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-warning">{p.kind.toLowerCase()} · from {p.sourceKind}{p.sourceRef ? ` · ${p.sourceRef}` : ""} · {fmt(p.createdAt)}</div>
      <p className="mt-1 text-sm">{p.summary}</p>
      {p.impact && <p className="mt-0.5 text-[12px] text-muted">Impact: {p.impact}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input value={n} onChange={(e) => setN(e.target.value)} placeholder="note (optional)" className="w-56 rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
        <button disabled={busy} onClick={() => onResolve(true, n)} className={`${btn} bg-success/15 text-success`}>Accept → new draft</button>
        <button disabled={busy} onClick={() => onResolve(false, n)} className={quiet}>Reject</button>
      </div>
    </div>
  );
}

function PrioritiesCard({ month, busy, onSave }: { month: { label: string; priorities: string[]; sourceRef: string | null }; busy: boolean; onSave: (t: string) => void }) {
  const [t, setT] = useState(month.priorities.join("\n"));
  return (
    <Section icon={Compass} title={`${month.label} priorities`} action={<span className="text-[11px] text-muted-2">{month.sourceRef ? `from ${month.sourceRef.split(":")[0]}` : "this month only — the brand foundation is above"}</span>}>
      <AutoTextarea value={t} onChange={(e) => setT(e.target.value)} minRows={2} placeholder="One priority per line — e.g. 'Lead with the November anniversary'" className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs" />
      <button disabled={busy || t === month.priorities.join("\n")} onClick={() => onSave(t)} className={`${btn} mt-1.5 bg-brand text-white`}>Save priorities</button>
    </Section>
  );
}

function PillarItem({ p, busy, onRename }: { p: PillarRowUi; busy: boolean; onRename: (n: string) => void }) {
  const [edit, setEdit] = useState(false);
  const [n, setN] = useState(p.name);
  return (
    <div className="px-5 py-2.5">
      {edit ? (
        <div className="flex gap-1.5">
          <input value={n} onChange={(e) => setN(e.target.value)} className="flex-1 rounded border border-border bg-surface-2 px-2 py-1 text-sm" />
          <button disabled={busy || !n.trim()} onClick={() => { onRename(n); setEdit(false); }} className={`${btn} bg-brand text-white`}>Rename</button>
          <button onClick={() => { setN(p.name); setEdit(false); }} className={quiet}>Cancel</button>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{p.name}{p.status === "RETIRED" && <span className="ml-1 text-[11px] text-muted-2">retired</span>}</div>
            {p.purpose && <p className="text-[12px] text-muted">{p.purpose}</p>}
            {p.aliases.length > 0 && <p className="text-[11px] text-muted-2">also known as: {p.aliases.join(" · ")}</p>}
          </div>
          <button onClick={() => setEdit(true)} className="text-[11px] text-muted hover:underline">rename</button>
        </div>
      )}
    </div>
  );
}

function AddPillar({ busy, onAdd }: { busy: boolean; onAdd: (n: string, purpose: string, focus: string) => void }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(""); const [pu, setPu] = useState(""); const [fa, setFa] = useState("");
  if (!open) return <div className="border-t border-border px-5 py-2.5"><button onClick={() => setOpen(true)} className="text-xs font-medium text-brand hover:underline">+ Add a pillar</button></div>;
  return (
    <div className="space-y-1.5 border-t border-border px-5 py-3">
      <input value={n} onChange={(e) => setN(e.target.value)} placeholder="Pillar name (the client's own words)" className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-sm" />
      <input value={pu} onChange={(e) => setPu(e.target.value)} placeholder="Purpose" className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
      <input value={fa} onChange={(e) => setFa(e.target.value)} placeholder="Focus areas" className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
      <div className="flex gap-1.5">
        <button disabled={busy || !n.trim()} onClick={() => { onAdd(n, pu, fa); setN(""); setPu(""); setFa(""); setOpen(false); }} className={`${btn} bg-brand text-white`}>Add</button>
        <button onClick={() => setOpen(false)} className={quiet}>Cancel</button>
      </div>
    </div>
  );
}

function MappingItem({ m, pillars, busy, onConfirm, onDismiss }: { m: MappingRowUi; pillars: PillarRowUi[]; busy: boolean; onConfirm: (pillarId: string) => void; onDismiss: () => void }) {
  const [pick, setPick] = useState(m.proposedPillarId ?? "");
  return (
    <div className="px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">“{m.label}”</span>
        <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted">{m.topicCount} topic{m.topicCount === 1 ? "" : "s"}</span>
        {m.isQualityDimension && <span className="text-[11px] text-warning">a quality dimension, not a pillar</span>}
      </div>
      <p className="text-[11px] text-muted-2">e.g. {m.sample.join(" · ")}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <select value={pick} onChange={(e) => setPick(e.target.value)} className="rounded border border-border bg-surface-2 px-2 py-1 text-xs">
          <option value="">— choose a pillar —</option>
          {pillars.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === m.proposedPillarId ? ` (proposed, ${Math.round(m.confidence * 100)}%)` : ""}</option>)}
        </select>
        <button disabled={busy || !pick} onClick={() => onConfirm(pick)} className={`${btn} bg-brand text-white`}>Confirm</button>
        <button disabled={busy} onClick={onDismiss} className={quiet}>Not a pillar</button>
      </div>
    </div>
  );
}
