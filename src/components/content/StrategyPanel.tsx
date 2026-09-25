"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Compass, Layers, Loader2, MessageSquareText, Mic, Pencil, Send, Trash2, Upload, Wand2, X } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { StrategyDocView, type StrategyDocSection } from "@/components/content/StrategyDocView";
import {
  addPillar, approveStrategy, confirmPillarMappingAction, createPillarsFromStrategy, dismissPillarLabelAction, draftStrategyFromDiscovery, editStrategySection, previewStrategyBackfill, rejectStrategy, releaseStrategy,
  renamePillarAction, resolveStrategyProposal, reviseStrategy, saveMonthPriorities, saveStrategyBackfill, setDutyOwner, waiveDiscoveryAction, type StrategyPreview,
} from "@/app/content/actions";

// ---------------------------------------------------------------------------
// Strategy tab (spec §3/§21): versions never overwrite; approve and release
// are two separate, attributable acts; a call's proposal is accepted or
// rejected with its source in view; pillars are stable identities and the
// free-text pillar labels on old topics are mapped ONLY when Jordan confirms
// each one. The month's priorities live apart from the brand foundation.
//
// CP-11 (Sep 24 2026): a proposal that names ONE section shows that section's
// heading, its text now, and the proposed replacement — editable — and
// accepting drafts a new version with only that section changed. One with no
// section is "Unplaced": place it on a section (and write the text), or accept
// it as before and fold it in by hand.
//
// A08 / U01 (Sep 25 2026): a version reads as a formatted document
// (StrategyDocView — labelled rows, lists, one card per pillar), and Jordan
// can correct it without re-uploading anything:
//   · Edit / Remove on any one section → a new version, that section only, no
//     AI (the "Gaps the draft could not fill" list is removed this way once
//     it is folded in — the release refuses while it is there);
//   · Revise with feedback → one AI run with his notes and the client's own
//     suggestions; only the sections it names change;
//   · Draft from the discovery call → the first draft, by a click, with the
//     automatic switches off.
// ---------------------------------------------------------------------------

export type VersionRow = { id: string; versionNo: number; status: string; structureTemplate: string; sourceKind: string; sourceRef: string | null; createdBy: string | null; createdAt: string; approvedBy: string | null; approvedAt: string | null; releasedAt: string | null; changeSummary: string | null; sections: StrategyDocSection[]; pillarNames: string[] };
/** The brand-discovery call behind the first strategy (A08), for the strip above the versions. */
export type DiscoveryUi = {
  required: boolean;
  waived: { reason: string | null; by: string | null } | null;
  call: { id: string; whenISO: string | null; status: string; transcriptState: string; verified: boolean } | null;
  /** The version the call already produced, if any. */
  draftedVersionNo: number | null;
  /** The call's analysis has run (so what was said in confidence is marked). */
  analysed: boolean;
};
export type ProposalRow = { id: string; kind: string; summary: string; impact: string | null; sourceKind: string; sourceRef: string | null; createdAt: string };
export type PillarRowUi = { id: string; name: string; purpose: string | null; focusAreas: string | null; aliases: string[]; status: string };
export type MappingRowUi = { label: string; topicCount: number; sample: string[]; proposedPillarId: string | null; proposedPillarName: string | null; confidence: number; isQualityDimension: boolean };
export type OwnerUi = { duty: string; label: string; scope: string; appUserId: string | null };
/** CP-11: the section a proposal changes, as the strategy in force has it. */
export type ProposalTargetUi = { heading: string | null; current: string | null; proposed: string; stale: boolean };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");
const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2";

export function StrategyPanel({ enrollmentId, versions, proposals, pillars, mapping, owners, staff, isOwner, month, targets = {}, sections = [], discovery = null }: {
  enrollmentId: string; versions: VersionRow[]; proposals: ProposalRow[]; pillars: PillarRowUi[]; mapping: MappingRowUi[]; owners: OwnerUi[];
  staff: { id: string; name: string }[]; isOwner: boolean; month: { id: string; label: string; priorities: string[]; sourceRef: string | null } | null;
  targets?: Record<string, ProposalTargetUi>; sections?: { id: string; heading: string }[]; discovery?: DiscoveryUi | null;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [open, setOpen] = useState<string | null>(versions.find((v) => v.status === "APPROVED")?.id ?? versions[0]?.id ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<StrategyPreview | null>(null);
  const approved = versions.find((v) => v.status === "APPROVED") ?? null;
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setNote(r.message); });
  const clientSuggestions = proposals.filter((p) => p.sourceKind === "client");

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

      {discovery && <DiscoveryStrip d={discovery} busy={busy} isOwner={isOwner} hasVersions={versions.length > 0}
        onDraft={() => run(() => draftStrategyFromDiscovery(enrollmentId))}
        onWaive={(reason) => run(() => waiveDiscoveryAction(enrollmentId, reason))} />}

      {/* Proposals from calls / clients */}
      {proposals.length > 0 && (
        <Section icon={Send} title="Proposed changes to the strategy" count={proposals.length} tone="warning" flush>
          <div className="divide-y divide-border">
            {proposals.map((p) => <ProposalItem key={p.id} p={p} target={targets[p.id] ?? null} sections={sections} busy={busy} onResolve={(accept, n, text, sectionId) => run(() => resolveStrategyProposal(p.id, accept, n, text, sectionId))} />)}
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
                <StatusChip status={v.status} released={!!v.releasedAt} everApproved={!!v.approvedAt} />
                <span className="text-[12px] text-muted">{v.structureTemplate} · {v.sourceKind.replace("_", " ")}{v.sourceRef ? ` · ${v.sourceRef}` : ""} · {fmt(v.createdAt)}{v.createdBy ? ` by ${v.createdBy}` : ""}</span>
                {v.approvedAt && v.status !== "SUPERSEDED" && <span className="text-[12px] text-success">approved {fmt(v.approvedAt)} by {v.approvedBy}</span>}
                {v.releasedAt && <span className="text-[12px] text-success">released {fmt(v.releasedAt)}</span>}
              </button>
              {v.changeSummary && <p className="mt-1 text-[12px] text-muted">{v.changeSummary}</p>}
              {open === v.id && (
                <div className="mt-2 space-y-2">
                  {v.pillarNames.length > 0 && <p className="text-[12px]"><span className="text-muted-2">Pillars in this version:</span> {v.pillarNames.join(" · ")}</p>}
                  <StrategyDocView
                    sections={v.sections}
                    collapsible
                    openFirst
                    size="xs"
                    actions={EDITABLE.includes(v.status) ? (s) => <SectionEdit key={`${v.id}:${s.id}`} section={s} approved={v.status === "APPROVED"} last={v.sections.length === 1} busy={busy}
                      onSave={(text) => run(() => editStrategySection(v.id, s.id, text))}
                      onRemove={() => run(() => editStrategySection(v.id, s.id, null))} /> : undefined}
                  />
                  {EDITABLE.includes(v.status) && <ReviseBox versionNo={v.versionNo} approved={v.status === "APPROVED"} suggestions={clientSuggestions} busy={busy}
                    onRevise={(notes, ids) => run(() => reviseStrategy(v.id, notes, ids))} />}
                  <div className="flex flex-wrap gap-1.5">
                    {v.status !== "APPROVED" && v.status !== "REJECTED" && v.status !== "SUPERSEDED" && (
                      <button disabled={busy} onClick={() => run(() => approveStrategy(v.id))} className={`${btn} bg-success/15 text-success hover:bg-success/25`}><Check className="mr-1 inline size-3" />Approve v{v.versionNo}</button>
                    )}
                    {/* Only a version that WAS in force can be put back; a draft replaced by a later edit is history. */}
                    {v.status === "SUPERSEDED" && v.approvedAt && <button disabled={busy} onClick={() => run(() => approveStrategy(v.id))} className={quiet}>Re-approve this older version</button>}
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

function StatusChip({ status, released, everApproved }: { status: string; released: boolean; everApproved: boolean }) {
  const cls = status === "APPROVED" ? "bg-success-soft text-success" : status === "DRAFT" || status === "INTERNAL_REVIEW" ? "bg-brand-soft text-brand" : "bg-surface-2 text-muted";
  const label = status === "APPROVED" ? (released ? "in force · released" : "in force")
    : status === "INTERNAL_REVIEW" ? "needs your OK"
    : status === "SUPERSEDED" && !everApproved ? "replaced by a later edit"
    : status.toLowerCase();
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

/** Versions a person may still change (a new version each time; the one edited is kept). */
const EDITABLE = ["DRAFT", "INTERNAL_REVIEW", "APPROVED"];

/** The discovery call behind the first strategy: when it was, whether its transcript is in, and the one-click draft. */
function DiscoveryStrip({ d, busy, isOwner, hasVersions, onDraft, onWaive }: { d: DiscoveryUi; busy: boolean; isOwner: boolean; hasVersions: boolean; onDraft: () => void; onWaive: (reason: string) => void }) {
  const ready = !!d.call && d.call.verified && (d.call.transcriptState === "CONFIRMED" || d.call.transcriptState === "ANALYZED");
  const when = d.call?.whenISO ? new Date(d.call.whenISO).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  let line: string;
  if (d.waived) line = `Discovery waived${d.waived.reason ? `: ${d.waived.reason}` : ""}${d.waived.by ? ` (${d.waived.by})` : ""}.`;
  else if (!d.call) line = "No brand discovery call on file yet.";
  else if (!d.call.verified) line = `Discovery call ${when ?? ""} — whose call it is needs confirming on Settings → Calendly & calls before anything is drafted from it.`;
  else if (d.draftedVersionNo) line = `Discovery call ${when ?? ""} — drafted as v${d.draftedVersionNo}.`;
  else if (ready) line = `Discovery call ${when ?? ""} — transcript confirmed${d.analysed ? " and analysed" : "; its analysis hasn't run yet"}. Ready to draft the strategy.`;
  else line = `Discovery call ${when ?? ""} — ${d.call.transcriptState === "NONE" || d.call.transcriptState === "AWAITING" ? "waiting for its transcript" : `transcript: ${d.call.transcriptState.toLowerCase().replace(/_/g, " ")}`}.`;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-[13px]">
      <Mic className="size-4 text-muted-2" />
      <span className="min-w-0 flex-1">{line}</span>
      {ready && !d.draftedVersionNo && !d.waived && (
        <button disabled={busy} onClick={onDraft} className={`${btn} bg-brand text-white`} title="One AI draft in the house format, from the confirmed transcript. It lands as a draft for you to edit and approve.">
          <Wand2 className="mr-1 inline size-3" />Draft from the discovery call
        </button>
      )}
      {isOwner && !d.waived && d.required && !hasVersions && (
        <button disabled={busy} onClick={() => { const r = window.prompt("Why is discovery not needed for this client? (e.g. their strategy came from an earlier program)") ?? ""; if (r.trim()) onWaive(r); }} className={quiet}>Waive discovery</button>
      )}
    </div>
  );
}

/** Edit or remove ONE section — a new version, nothing else touched. */
function SectionEdit({ section, approved, last, busy, onSave, onRemove }: { section: StrategyDocSection; approved: boolean; last: boolean; busy: boolean; onSave: (text: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(section.text);
  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <button disabled={busy} onClick={() => { setText(section.text); setEditing(true); }} className={quiet}><Pencil className="mr-1 inline size-3" />Edit this section</button>
        {!last && <button disabled={busy} onClick={() => { if (window.confirm(`Remove “${section.heading}”? It becomes a new version without it; this version is kept.`)) onRemove(); }} className={quiet}><Trash2 className="mr-1 inline size-3" />Remove</button>}
        {approved && <span className="text-[11px] text-muted-2">Editing the version in force makes a new version for you to approve.</span>}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={4} aria-label={`Text of ${section.heading}`} className="w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-xs leading-relaxed" />
      <p className="text-[11px] text-muted-2">Keep the labels (“Core Values:”, “Pillar 2: …”, “Purpose:”) and bullets — they are what the formatting reads.</p>
      <div className="flex gap-1.5">
        <button disabled={busy || !text.trim() || text.trim() === section.text.trim()} onClick={() => { onSave(text); setEditing(false); }} className={`${btn} bg-brand text-white`}>Save as a new version</button>
        <button onClick={() => setEditing(false)} className={quiet}>Cancel</button>
      </div>
    </div>
  );
}

/** Jordan's notes + the client's suggestions → one revision where only the named sections change. */
function ReviseBox({ versionNo, approved, suggestions, busy, onRevise }: { versionNo: number; approved: boolean; suggestions: ProposalRow[]; busy: boolean; onRevise: (notes: string, proposalIds: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  if (!open) {
    return (
      <button disabled={busy} onClick={() => setOpen(true)} className={quiet}>
        <MessageSquareText className="mr-1 inline size-3" />Revise v{versionNo} with feedback{suggestions.length ? ` (${suggestions.length} client suggestion${suggestions.length === 1 ? "" : "s"})` : ""}
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2/40 p-3">
      <p className="text-[12px] text-muted">One AI revision. Only the sections your feedback touches change; everything else stays word for word.{approved ? " The version in force stays in force until you approve the revision." : ""}</p>
      <AutoTextarea value={notes} onChange={(e) => setNotes(e.target.value)} minRows={2} placeholder="What should change? e.g. “Make the brand voice warmer and drop the luxury angle from pillar 3.”" className="w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-xs" />
      {suggestions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Fold in the client&rsquo;s suggestions</p>
          {suggestions.map((sg) => (
            <label key={sg.id} className="flex items-start gap-2 text-[12px]">
              <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={picked.includes(sg.id)} onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, sg.id] : cur.filter((x) => x !== sg.id)))} />
              <span>{sg.summary} <span className="text-muted-2">· {fmt(sg.createdAt)}</span></span>
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <button disabled={busy || (!notes.trim() && picked.length === 0)} onClick={() => { onRevise(notes, picked); setOpen(false); setNotes(""); setPicked([]); }} className={`${btn} bg-brand text-white`}>
          <Wand2 className="mr-1 inline size-3" />Revise
        </button>
        <button onClick={() => setOpen(false)} className={quiet}>Cancel</button>
      </div>
    </div>
  );
}

function ProposalItem({ p, target, sections, busy, onResolve }: {
  p: ProposalRow; target: ProposalTargetUi | null; sections: { id: string; heading: string }[]; busy: boolean;
  onResolve: (accept: boolean, note: string, text?: string | null, sectionId?: string | null) => void;
}) {
  const [n, setN] = useState("");
  const [text, setText] = useState(target?.proposed ?? "");
  const [place, setPlace] = useState("");
  return (
    <div className="px-5 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-warning">{p.kind.toLowerCase()} · from {p.sourceKind}{p.sourceRef ? ` · ${p.sourceRef}` : ""} · {fmt(p.createdAt)}</div>
      <p className="mt-1 text-sm">{p.summary}</p>
      {p.impact && <p className="mt-0.5 text-[12px] text-muted">Impact: {p.impact}</p>}
      {target ? (
        <div className="mt-2 space-y-1.5 rounded-lg border border-border bg-surface-2/40 p-2.5">
          <p className="text-[12px] font-semibold">Changes only the “{target.heading ?? "?"}” section</p>
          {target.stale && <p className="rounded bg-warning-soft/60 px-2 py-1 text-[11px] text-warning">That section changed (or is gone) since this was proposed — accepting will be refused. Reject it and look again.</p>}
          {target.current != null && <details><summary className="cursor-pointer text-[11px] text-muted">What it says now</summary><p className="mt-1 whitespace-pre-wrap text-[12px] text-foreground/80">{target.current}</p></details>}
          <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} aria-label="Proposed text for this section" className="w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-xs" />
        </div>
      ) : (
        <div className="mt-2 space-y-1.5 rounded-lg border border-dashed border-border p-2.5">
          <p className="text-[11px] text-muted"><span className="font-semibold text-foreground">Unplaced</span> — no single section named. Place it on one and write the new text, or accept it as-is and it is added as its own section for you to fold in.</p>
          {sections.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <select value={place} onChange={(e) => setPlace(e.target.value)} className="rounded border border-border bg-surface-2 px-2 py-1 text-xs">
                <option value="">— place on a section —</option>
                {sections.map((s) => <option key={s.id} value={s.id}>{s.heading}</option>)}
              </select>
            </div>
          )}
          {place && <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} placeholder="The new text for that section" className="w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-xs" />}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input value={n} onChange={(e) => setN(e.target.value)} placeholder="note (optional)" className="w-56 rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
        <button
          disabled={busy || (!!target && !text.trim()) || (!target && !!place && !text.trim())}
          onClick={() => onResolve(true, n, target || place ? text : null, !target && place ? place : null)}
          className={`${btn} bg-success/15 text-success`}
        >
          Accept → new draft
        </button>
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
