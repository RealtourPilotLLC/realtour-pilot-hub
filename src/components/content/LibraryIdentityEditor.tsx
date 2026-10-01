"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, History, Link2, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { adoptTopicVideoAction, confirmPairingAction, correctVideoIdentityAction, relinkDeliveredFileAction } from "@/app/content/[id]/workspaceActions";
import type { LibraryIdentityOptions, LibraryIdentityUi } from "@/components/content/ContentLibraryPanel";
import { contentControlOutcome, identityCorrectionPatch, reconcileIdentityFields, type ContentControlOutcome, type ContentControlResult, type IdentityFields, type IdentityField, type ConfirmedIdentityDraft } from "@/lib/contentControlReceipt";

// ---------------------------------------------------------------------------
// THE IDENTITY TOOL, one video at a time (CP-12). Four acts, each a ledger
// row per changed field (ContentVideoCorrection) and each re-checked by the
// server (OWNER/ADMIN, this enrollment only):
//
//   · correct the title / topic / script / kind, and confirm a backfilled
//     month (which moves the row out of the client's "Previous content");
//   · confirm a delivered file's pairing where it stands;
//   · move a delivered file to the video it really belongs to — this changes
//     which file the client downloads, so it asks for a reason;
//   · join a photographer-confirmed topic row onto the cut chain it never met.
//
// Nothing here deletes, and nothing here writes to Aryeo or Dropbox: the file
// stays where it is; only which video it counts as changes.
// ---------------------------------------------------------------------------

const BASIS_WORD: Record<string, string> = {
  cut: "the review cut itself", own: "its own video", known: "linked earlier", name: "matched by title", index: "matched by list position only", staff: "set by staff",
};
const day = (isoStr: string) => new Date(isoStr).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fieldsFor = (video: { title: string; topicId: string | null; scriptId: string | null; kind: string }): IdentityFields => ({ title: video.title, topicId: video.topicId ?? "", scriptId: video.scriptId ?? "", kind: video.kind });

export function LibraryIdentityEditor({ options, video, identity }: {
  options: LibraryIdentityOptions;
  video: { id: string; title: string; topicId: string | null; scriptId: string | null; kind: string; monthKey: string | null; status: string };
  identity: LibraryIdentityUi;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ outcome: ContentControlOutcome; text: string } | null>(null);
  const [draft, setDraft] = useState(() => fieldsFor(video));
  const { title, topicId, scriptId, kind } = draft;
  const liveDraft = useRef(draft), baseline = useRef(fieldsFor(video));
  const confirmed = useRef<ConfirmedIdentityDraft | null>(null);
  const [conflicts, setConflicts] = useState<IdentityField[]>([]);
  const [reason, setReason] = useState("");
  const liveReason = useRef(reason);
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const liveMoveTo = useRef(moveTo);
  const [adoptInto, setAdoptInto] = useState(identity.adoptInto[0]?.id ?? "");
  const liveAdoptInto = useRef(adoptInto);
  const e = options.enrollmentId;
  const entity = `${e}/${video.id}`, activeEntity = useRef(entity);
  const [shownEntity, setShownEntity] = useState(entity);
  const pending = useRef(false), heldRef = useRef(false);
  const [held, setHeld] = useState(false);
  const [confirmedVersion, setConfirmedVersion] = useState(0);
  const defaultAdopt = identity.adoptInto[0]?.id ?? "";
  const incomingKey = JSON.stringify(fieldsFor(video));

  useEffect(() => {
    const incoming = JSON.parse(incomingKey) as IdentityFields;
    if (activeEntity.current !== entity) {
      activeEntity.current = entity; setShownEntity(entity);
      baseline.current = incoming; liveDraft.current = incoming; setDraft(incoming);
      confirmed.current = null; heldRef.current = false; setHeld(false); setMsg(null); setConflicts([]);
      liveReason.current = ""; setReason(""); liveMoveTo.current = {}; setMoveTo({});
      liveAdoptInto.current = defaultAdopt; setAdoptInto(defaultAdopt);
      return;
    }
    const merged = reconcileIdentityFields(liveDraft.current, baseline.current, incoming, confirmed.current);
    baseline.current = merged.baseline;
    liveDraft.current = merged.draft; setDraft(merged.draft);
    if (merged.sourceChanged || merged.confirmedApplied) setConflicts(merged.conflicts);
    if (merged.confirmedApplied) confirmed.current = null;
  }, [entity, incomingKey, defaultAdopt, confirmedVersion]);

  const change = (field: IdentityField, value: string) => { const next = { ...liveDraft.current, [field]: value }; liveDraft.current = next; setDraft(next); };
  const act = (label: string, fn: () => Promise<ContentControlResult>, correction?: ConfirmedIdentityDraft) => {
    if (pending.current || heldRef.current || activeEntity.current !== entity) return;
    pending.current = true; setMsg(null);
    const submittedReason = liveReason.current;
    start(async () => {
      let result: ContentControlResult;
      try { result = await fn(); } catch { result = { ok: false, outcome: "unknown", message: `${label} was not confirmed. It may already have been applied.` }; }
      const outcome = contentControlOutcome(result);
      if (activeEntity.current === entity) {
        if (outcome === "unknown") { heldRef.current = true; setHeld(true); }
        if (outcome === "confirmed" && correction) { confirmed.current = correction; setConfirmedVersion((version) => version + 1); }
        const newer = correction && JSON.stringify(liveDraft.current) !== JSON.stringify(correction.draft) || liveReason.current !== submittedReason;
        setMsg({ outcome, text: `${label}: ${result.message}${outcome === "confirmed" && newer ? " Your newer input is kept; it was not part of this request." : ""}` });
        if (outcome === "confirmed") { try { router.refresh(); } catch { setMsg({ outcome, text: `${label}: ${result.message} The write is confirmed; the refreshed view could not be loaded. Your input is kept.` }); } }
      }
      pending.current = false;
    });
  };

  const dirty = Object.keys(identityCorrectionPatch(draft, fieldsFor(video))).length > 0;
  const saveIdentity = () => {
    if (pending.current || heldRef.current || activeEntity.current !== entity) return;
    const merged = reconcileIdentityFields(liveDraft.current, baseline.current, fieldsFor(video), confirmed.current);
    baseline.current = merged.baseline; liveDraft.current = merged.draft; setDraft(merged.draft);
    if (merged.sourceChanged) setConflicts(merged.conflicts);
    const patch = identityCorrectionPatch(merged.draft, merged.baseline);
    if (!Object.keys(patch).length || !merged.draft.title.trim()) return;
    const why = liveReason.current;
    act(`Correction for video ${video.id}`, () => correctVideoIdentityAction(e, video.id, patch, why), { draft: { ...merged.draft }, fields: Object.keys(patch) as IdentityField[] });
  };
  const blocked = busy || held || shownEntity !== entity;
  const field = "min-h-11 min-w-0 max-w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
  const small = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-muted whitespace-normal hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";

  return (
    <div className="space-y-2.5 rounded-lg border border-border/70 bg-surface px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-1.5 text-ui-status font-semibold text-muted-2">
        <ShieldCheck className="size-3" /> Identity
        <span className="font-normal normal-case tracking-normal">
          {identity.confirmedAtISO ? `confirmed by ${identity.confirmedBy ?? "staff"} ${day(identity.confirmedAtISO)}` : "not confirmed by a person"}
          {identity.section === "PREVIOUS" ? " · the client sees it under Previous content" : ""}
        </span>
      </p>

      {/* Title / topic / script / kind */}
      <div className="grid gap-1.5 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-ui-secondary font-medium text-muted">Title
          <input value={title} onChange={(ev) => change("title", ev.target.value)} maxLength={200} className={field} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-ui-secondary font-medium text-muted">Topic
          <select value={topicId} onChange={(ev) => change("topicId", ev.target.value)} className={field}>
            <option value="">— no topic —</option>
            {topicId && !options.topics.some((t) => t.id === topicId) && <option value={topicId}>Selected topic — not in the latest choices</option>}
            {options.topics.map((t) => <option key={t.id} value={t.id}>{t.title}{t.status === "ARCHIVED" || t.status === "REJECTED" ? ` (${t.status.toLowerCase()})` : ""}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-ui-secondary font-medium text-muted">Script
          <select value={scriptId} onChange={(ev) => change("scriptId", ev.target.value)} className={field}>
            <option value="">— no script —</option>
            {scriptId && !options.scripts.some((s) => s.id === scriptId) && <option value={scriptId}>Selected script — not in the latest choices</option>}
            {options.scripts.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-ui-secondary font-medium text-muted">Counts as
          <select value={kind} onChange={(ev) => change("kind", ev.target.value)} className={field}>
            <option value="PROGRAM">Program video (counts toward the allowance)</option>
            <option value="LISTING">Listing video (does not count)</option>
            <option value="EXTRA">Extra (does not count)</option>
            {!["PROGRAM", "LISTING", "EXTRA"].includes(video.kind) && <option value={video.kind} disabled>{video.kind.toLowerCase()}</option>}
          </select>
        </label>
      </div>
      {conflicts.length > 0 && <p role="alert" className="text-ui-status leading-relaxed text-warning">The stored {conflicts.join(", ")} changed while you were editing. Your exact input is kept; saving a correction replaces those current fields. Check the latest video and history first.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-0 flex-1 basis-48 text-ui-secondary font-medium text-muted">Reason (kept in history)
          <input value={reason} onChange={(ev) => { liveReason.current = ev.target.value; setReason(ev.target.value); }} placeholder="Why (kept in the history)" maxLength={500} className={cn(field, "mt-1 block w-full")} />
        </label>
        <button type="button" onClick={saveIdentity} disabled={blocked || !dirty || !title.trim()} className="inline-flex min-h-11 min-w-11 max-w-full items-center justify-center rounded-lg bg-brand-action px-3 py-2 text-sm font-semibold text-brand-fg whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50">Save correction</button>
        {identity.monthHistorical && !identity.confirmedAtISO && (
          <button type="button" onClick={() => { const why = liveReason.current; act(`Confirm month for video ${video.id}`, () => correctVideoIdentityAction(e, video.id, { confirmMonth: true }, why)); }} disabled={blocked} className={small} title="The client will see it under this month instead of Previous content">
            Confirm {video.monthKey ?? "month"}
          </button>
        )}
        {identity.monthHistorical && identity.confirmedAtISO && (
          <button type="button" onClick={() => { const why = liveReason.current; act(`Return video ${video.id} to Previous content`, () => correctVideoIdentityAction(e, video.id, { confirmMonth: false }, why)); }} disabled={blocked} className={small}>Back to Previous content</button>
        )}
      </div>

      {/* Delivered files */}
      {identity.files.length > 0 && (
        <ul className="space-y-1.5">
          {identity.files.map((f) => {
            const weak = !f.confirmedAtISO && f.matchBasis !== "staff" && (f.matchBasis === "index" || f.legacyKey);
            return (
              <li key={f.sourceId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-secondary">
                <Link2 className="size-3 text-muted-2" />
                <span className="font-medium">{f.title ?? "Delivered file"}</span>
                <span className="max-w-full break-all font-mono text-ui-status text-muted-2">{f.externalKey}</span>
                <span className={cn("text-ui-status", weak ? "text-warning" : "text-muted")}>
                  {f.matchBasis ? BASIS_WORD[f.matchBasis] ?? f.matchBasis : "pairing not recorded"}
                  {f.legacyKey ? " · legacy position key" : ""}
                  {f.confirmedAtISO ? ` · confirmed by ${f.confirmedBy ?? "staff"}` : ""}
                </span>
                {!f.confirmedAtISO && f.matchBasis !== "staff" && (
                  <button type="button" onClick={() => act(`Confirm file ${f.sourceId} pairing`, () => confirmPairingAction(e, f.sourceId))} disabled={blocked} className={small}><CheckCircle2 className="mr-0.5 inline size-3" />Right video</button>
                )}
                {identity.relinkTargets.length > 0 && (
                  <span className="flex max-w-full flex-wrap items-center gap-1.5">
                    <select value={moveTo[f.sourceId] ?? ""} onChange={(ev) => { const next = { ...liveMoveTo.current, [f.sourceId]: ev.target.value }; liveMoveTo.current = next; setMoveTo(next); }} className={field} aria-label="Move this file to">
                      <option value="">Move to…</option>
                      {moveTo[f.sourceId] && !identity.relinkTargets.some((t) => t.id === moveTo[f.sourceId]) && <option value={moveTo[f.sourceId]}>Selected video — not in latest choices</option>}
                      {identity.relinkTargets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                    </select>
                    <button
                      type="button" disabled={blocked || !moveTo[f.sourceId] || !identity.relinkTargets.some((t) => t.id === moveTo[f.sourceId]) || !reason.trim()} className={small}
                      title={!reason.trim() ? "Say why first — this changes which file the client downloads" : undefined}
                      onClick={() => { const target = liveMoveTo.current[f.sourceId], why = liveReason.current; if (target && why.trim() && identity.relinkTargets.some((t) => t.id === target)) act(`Move file ${f.sourceId} to video ${target}`, () => relinkDeliveredFileAction(e, f.sourceId, target, why)); }}
                    >Move</button>
                  </span>
                )}
              </li>
            );
          })}
          {identity.relinkTargets.length > 0 && <li className="text-ui-status leading-relaxed text-muted-2">Moving a file changes which file the client downloads for each video — write the reason above first.</li>}
        </ul>
      )}

      {/* A filmed topic that never met its cut */}
      {identity.adoptInto.length > 0 && video.status !== "ARCHIVED" && (
        <div className="flex flex-wrap items-center gap-2 text-ui-secondary">
          <span className="text-muted">This topic row has no cut. Join it to the video that has the cuts:</span>
          <select value={adoptInto} onChange={(ev) => { liveAdoptInto.current = ev.target.value; setAdoptInto(ev.target.value); }} className={field} aria-label="Video with cuts to join this topic into">
            {adoptInto && !identity.adoptInto.some((t) => t.id === adoptInto) && <option value={adoptInto}>Selected video — not in latest choices</option>}
            {identity.adoptInto.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <button type="button" onClick={() => { const target = liveAdoptInto.current; if (identity.adoptInto.some((t) => t.id === target)) act(`Join topic video ${video.id} to video ${target}`, () => adoptTopicVideoAction(e, target, video.id)); }} disabled={blocked || !adoptInto || !identity.adoptInto.some((t) => t.id === adoptInto)} className={small}>Join</button>
        </div>
      )}

      {/* History */}
      {identity.corrections.length > 0 && (
        <details className="text-ui-status">
          <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-1 rounded-lg py-2 text-muted-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"><History className="size-3" /> {identity.corrections.length} correction{identity.corrections.length === 1 ? "" : "s"} on file</summary>
          <ul className="mt-1 space-y-0.5">
            {identity.corrections.map((c) => (
              <li key={c.id} className="break-words leading-relaxed text-muted">
                <span className="font-medium text-foreground">{c.field}</span>: {c.fromValue ?? "—"} → {c.toValue ?? "—"} · {c.by} · {day(c.createdAtISO)}{c.reason ? ` · “${c.reason}”` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {busy && <p role="status" className="flex items-center gap-1 text-ui-status text-muted"><Loader2 className="size-3 animate-spin" /> Saving the submitted choice… You can keep editing; newer input stays here.</p>}
      {msg && <p role={msg.outcome === "confirmed" ? "status" : "alert"} className={cn("break-words text-ui-status leading-relaxed", msg.outcome === "confirmed" ? "text-success" : "text-danger")}>{msg.text}</p>}
      {held && <p role="alert" className="text-ui-status leading-relaxed text-warning">This result is unconfirmed. Further identity, month, pairing, move and join changes are held in this editor. Keep your input and ask staff to inspect this exact video, file pairing and correction history before another write; a refresh alone does not establish what completed.</p>}
    </div>
  );
}
