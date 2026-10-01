"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Paperclip } from "lucide-react";
import { approvedRevisionTargets, requestApprovedCutRevision, type ApprovedRevisionTarget } from "@/app/review/staffRevisionActions";
import { clearStaffRevisionDraft, keepStaffRevisionDraft, parseStaffRevisionDraft, staffRevisionDraftKey } from "@/lib/staffRevisionDraft";

const DRAFT_EVENT = "staff-revision-receipt-changed";
function subscribeDraft(onChange: () => void) {
  window.addEventListener("storage", onChange); window.addEventListener(DRAFT_EVENT, onChange);
  return () => { window.removeEventListener("storage", onChange); window.removeEventListener(DRAFT_EVENT, onChange); };
}

export function StaffCutRevisionForm({
  projectId, fixedTarget, sourceMessage,
}: {
  projectId: string;
  fixedTarget?: ApprovedRevisionTarget;
  sourceMessage?: { id: string; body: string };
}) {
  const router = useRouter();
  const [targets, setTargets] = useState<ApprovedRevisionTarget[]>(fixedTarget ? [fixedTarget] : []);
  const [selected, setSelected] = useState(fixedTarget?.submissionId ?? "");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, start] = useTransition();
  const rawDraft = useSyncExternalStore(subscribeDraft, () => {
    try { return window.localStorage.getItem(staffRevisionDraftKey(projectId)); } catch { return null; }
  }, () => null);
  const draft = parseStaffRevisionDraft(rawDraft);

  function loadTargets() {
    if (fixedTarget || targets.length) return;
    start(async () => {
      try {
        const rows = await approvedRevisionTargets(projectId);
        setTargets(rows);
        if (rows.length === 1) setSelected(rows[0].submissionId);
        if (!rows.length) setNote("No current approved video is available on this job. Open the Review Room to check its versions.");
      } catch (e) { setNote(e instanceof Error ? e.message : "Could not load approved videos."); }
    });
  }

  function submit(data: FormData) {
    let receipt;
    try {
      receipt = keepStaffRevisionDraft(window.localStorage, projectId, { version: 1, requestKey: key, submissionId: fixedTarget?.submissionId ?? selected });
      window.dispatchEvent(new Event(DRAFT_EVENT));
    } catch (e) { setSuccess(false); setNote(e instanceof Error ? e.message : "Could not save the retry receipt in this browser."); return; }
    data.set("projectId", projectId);
    data.set("submissionId", receipt.submissionId);
    data.set("requestKey", receipt.requestKey);
    if (sourceMessage) data.set("sourceMessageId", sourceMessage.id);
    start(async () => {
      try {
        const r = await requestApprovedCutRevision(data);
        setSuccess(r.ok);
        setNote(r.message);
        if (r.ok) {
          try {
            clearStaffRevisionDraft(window.localStorage, projectId, receipt.requestKey);
            window.dispatchEvent(new Event(DRAFT_EVENT));
          } catch { setNote(`${r.message} This browser could not clear its retry reminder; reopening it will confirm the same recorded request.`); }
          setKey(crypto.randomUUID()); router.refresh();
        }
      } catch (e) { setNote(e instanceof Error ? e.message : "Could not record this revision."); }
    });
  }

  return (
    <form action={submit} className="space-y-3 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm" onFocus={loadTargets}>
      <div>
        <p className="font-semibold text-foreground">Record the client’s change request</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">This creates an exact-video revision record and an assigned task. It keeps the approved file and the client’s wording intact.</p>
      </div>
      {draft && !success && <p className="rounded-lg border border-warning/30 bg-surface px-2.5 py-2 text-xs leading-relaxed">A request was started on this job. Resume it to confirm whether it was recorded. Words, contact and video already saved will be preserved. If an attachment is still needed, select that original file below.</p>}
      {fixedTarget ? (
        <p className="rounded-lg bg-surface px-2.5 py-2 text-xs font-medium">{fixedTarget.label} · Version {fixedTarget.round}{fixedTarget.fileName ? ` · ${fixedTarget.fileName}` : ""}</p>
      ) : (
        <label className="block text-xs font-medium">Which approved video?
          <select value={selected} onChange={(e) => setSelected(e.target.value)} onClick={loadTargets} required className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm">
            <option value="">Choose the exact video</option>
            {targets.map((t) => <option key={t.submissionId} value={t.submissionId}>{t.label} · Version {t.round}{t.fileName ? ` · ${t.fileName}` : ""}</option>)}
          </select>
        </label>
      )}
      <label className="block text-xs font-medium">Client contact who asked
        <input name="clientContact" required minLength={2} maxLength={120} placeholder="Name the person, not just the account" className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm" />
      </label>
      <label className="block text-xs font-medium">Client’s exact words
        {sourceMessage ? (
          <>
            <p className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-surface px-2.5 py-2 text-sm font-normal">{sourceMessage.body}</p>
            <p className="mt-1 font-normal text-muted">Copied from the stored team message. If it paraphrases the client, record the exact wording from the Review Room instead.</p>
          </>
        ) : <textarea name="originalText" required rows={4} maxLength={24000} placeholder="Paste or type what the client actually said" className="mt-1 w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-sm font-normal" />}
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs font-medium">Timestamp, if known
          <input name="timecode" inputMode="numeric" placeholder="1:23" pattern="[0-9]{1,3}:[0-9]{2}" className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm" />
        </label>
        <label className="block text-xs font-medium">Reference file, if supplied
          <span className="mt-1 flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-2"><Paperclip className="size-3.5" /><input name="attachment" type="file" className="min-w-0 w-full text-xs" /></span>
          <span className="font-normal text-muted">Up to 5 MB</span>
        </label>
      </div>
      <label className="flex items-start gap-2 text-xs leading-relaxed text-foreground"><input name="confirmedClientWords" value="yes" type="checkbox" required className="mt-0.5" />These are the client’s words, and this is the video they meant.</label>
      {note && <p role="status" className={`text-xs ${success ? "text-success" : "text-danger"}`}>{note}</p>}
      <button type="submit" formNoValidate={!!draft} disabled={pending || success || (!selected && !draft)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {pending && <Loader2 className="size-3.5 animate-spin" />}{pending ? "Recording…" : draft ? "Resume saved request" : "Record revision request"}
      </button>
    </form>
  );
}
