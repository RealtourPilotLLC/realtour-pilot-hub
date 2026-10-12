"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Paperclip } from "lucide-react";
import {
  approvedRevisionTargets, discardStaffRevision, finishStaffRevisionWithoutAttachment, requestApprovedCutRevision, savedStaffRevision,
  type ApprovedRevisionTarget, type SavedStaffRevision,
} from "@/app/review/staffRevisionActions";
import { clearStaffRevisionDraft, keepStaffRevisionDraft, parseStaffRevisionDraft, staffRevisionDraftKey } from "@/lib/staffRevisionDraft";

// ---------------------------------------------------------------------------
// RECORD A CLIENT'S CHANGE REQUEST ON AN APPROVED VIDEO.
//
// Oct 12 2026 (Kyle, Mike Ciunci's Video 2). Three things went wrong at once:
//   · the form was a React form ACTION, and React resets a form after its
//     action returns — so every failed try blanked the video and contact
//     pickers and the file. It now submits by hand and keeps what was typed;
//   · "Resume saved request" re-showed EMPTY fields, though the server only
//     ever finishes what the first try saved. A started request now shows what
//     is actually saved (video, contact, words, attachment) instead;
//   · the only way out of a stuck attachment was the same failing retry. A
//     saved request can now be finished with the file, finished without it,
//     or discarded.
// The spinner is tied to the server's answer only (plain async, no
// transition), so a page refresh after the answer can never hold it open.
// ---------------------------------------------------------------------------

const DRAFT_EVENT = "staff-revision-receipt-changed";
function subscribeDraft(onChange: () => void) {
  window.addEventListener("storage", onChange); window.addEventListener(DRAFT_EVENT, onChange);
  return () => { window.removeEventListener("storage", onChange); window.removeEventListener(DRAFT_EVENT, onChange); };
}
const draftChanged = () => window.dispatchEvent(new Event(DRAFT_EVENT));
const MAX_BYTES = 5_000_000;

type Note = { ok: boolean; text: string } | null;
type Busy = null | "record" | "finish" | "skip" | "discard";
type Saved = { key: string; data: Extract<SavedStaffRevision, { found: true }> } | { key: string; missing: true } | { key: string; error: string };
type Result = { ok: boolean; message: string };

const ATTACHMENT_STATE: Record<string, string> = {
  PENDING: "not uploaded yet",
  UNKNOWN: "not uploaded yet",
  UPLOADING: "upload not confirmed yet",
  CONFIRMED: "uploaded",
  SKIPPED: "left off",
};

export function StaffCutRevisionForm({
  projectId, fixedTarget, sourceMessage,
}: {
  projectId: string;
  fixedTarget?: ApprovedRevisionTarget;
  sourceMessage?: { id: string; body: string };
}) {
  const [targets, setTargets] = useState<ApprovedRevisionTarget[]>(fixedTarget ? [fixedTarget] : []);
  const [targetsLoading, setTargetsLoading] = useState(!fixedTarget);
  const [selected, setSelected] = useState(fixedTarget?.submissionId ?? "");
  const [contact, setContact] = useState("");
  const [words, setWords] = useState("");
  const [timecode, setTimecode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const resumeFileRef = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [recorded, setRecorded] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const rawDraft = useSyncExternalStore(subscribeDraft, () => {
    try { return window.localStorage.getItem(staffRevisionDraftKey(projectId)); } catch { return null; }
  }, () => null);
  const draft = parseStaffRevisionDraft(rawDraft);
  const draftKey = draft?.requestKey ?? null;

  // The approved videos, loaded as soon as the form opens (not on first focus:
  // the picker was empty until you clicked into the form).
  useEffect(() => {
    if (fixedTarget) return;
    let live = true;
    approvedRevisionTargets(projectId).then(
      (rows) => {
        if (!live) return;
        setTargets(rows);
        setTargetsLoading(false);
        if (rows.length === 1) setSelected((s) => s || rows[0].submissionId);
        if (!rows.length) setNote({ ok: false, text: "No current approved video is available on this job. Open the Review Room to check its versions." });
      },
      (e) => { if (live) { setTargetsLoading(false); setNote({ ok: false, text: e instanceof Error ? e.message : "Could not load the approved videos." }); } },
    );
    return () => { live = false; };
  }, [projectId, fixedTarget]);

  function clearDraft(requestKey: string) {
    try { clearStaffRevisionDraft(window.localStorage, projectId, requestKey); draftChanged(); } catch { /* the server copy is what counts */ }
  }

  function settleSaved(requestKey: string, data: SavedStaffRevision) {
    if (!data.found) { setSaved({ key: requestKey, missing: true }); return; }
    if (data.recorded) {
      // Recorded on an earlier try — release this browser for a new request.
      clearDraft(requestKey);
      setSaved(null);
      setNote({ ok: true, text: `The request you started for ${data.videoLabel} is already recorded and with the editor.` });
      return;
    }
    setSaved({ key: requestKey, data });
  }

  // What the server holds for the request this browser started — or, with no
  // request started here, one somebody else saved on this job and never
  // finished (adopted into this browser so it can be finished or discarded).
  useEffect(() => {
    let live = true;
    savedStaffRevision(projectId, draftKey).then(
      (data) => {
        if (!live) return;
        if (draftKey) { settleSaved(draftKey, data); return; }
        if (!data.found || data.recorded) return;
        try {
          keepStaffRevisionDraft(window.localStorage, projectId, { version: 1, requestKey: data.requestKey, submissionId: data.submissionId });
          draftChanged();
        } catch { return; /* no browser storage: the plain form still works */ }
        setSaved({ key: data.requestKey, data });
      },
      (e) => { if (live && draftKey) setSaved({ key: draftKey, error: e instanceof Error ? e.message : "Could not check the saved request." }); },
    );
    return () => { live = false; };
    // settleSaved only closes over setters and projectId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, draftKey]);

  async function recheck(requestKey: string) {
    try { settleSaved(requestKey, await savedStaffRevision(projectId, requestKey)); } catch { /* keep the last view */ }
  }

  function finished(r: Result, requestKey: string) {
    setNote({ ok: r.ok, text: r.message });
    if (!r.ok) return false;
    clearDraft(requestKey);
    setSaved(null);
    setRecorded(true);
    setConfirmDiscard(false);
    return true;
  }

  async function run(which: Exclude<Busy, null>, requestKey: string, call: () => Promise<Result>) {
    if (busy) return;
    setBusy(which);
    setNote(null);
    try {
      const r = await call();
      if (!finished(r, requestKey)) await recheck(requestKey);
    } catch {
      setNote({ ok: false, text: "The hub didn't answer. Nothing you typed was lost; try again." });
      await recheck(requestKey);
    } finally {
      setBusy(null);
    }
  }

  function record(e: React.FormEvent<HTMLFormElement>) {
    // NOT a form action: React resets a form after its action, which blanked
    // the pickers on every failed try.
    e.preventDefault();
    if (busy) return;
    const file = fileRef.current?.files?.[0] ?? null;
    if (file && file.size > MAX_BYTES) { setNote({ ok: false, text: "That file is over 5 MB. Choose a smaller one, or leave it off." }); return; }
    let receipt;
    try {
      receipt = keepStaffRevisionDraft(window.localStorage, projectId, { version: 1, requestKey: key, submissionId: fixedTarget?.submissionId ?? selected });
      draftChanged();
    } catch (err) { setNote({ ok: false, text: err instanceof Error ? err.message : "Could not save the retry receipt in this browser." }); return; }
    const data = new FormData();
    data.set("projectId", projectId);
    data.set("submissionId", receipt.submissionId);
    data.set("requestKey", receipt.requestKey);
    data.set("clientContact", contact);
    if (!sourceMessage) data.set("originalText", words);
    data.set("timecode", timecode);
    if (confirmed) data.set("confirmedClientWords", "yes");
    if (file) data.set("attachment", file);
    if (sourceMessage) data.set("sourceMessageId", sourceMessage.id);
    void run("record", receipt.requestKey, () => requestApprovedCutRevision(data));
  }

  function finishSaved(requestKey: string, submissionId: string) {
    const file = resumeFileRef.current?.files?.[0] ?? null;
    if (file && file.size > MAX_BYTES) { setNote({ ok: false, text: "That file is over 5 MB. Finish without the attachment instead." }); return; }
    const data = new FormData();
    data.set("projectId", projectId);
    data.set("submissionId", submissionId);
    data.set("requestKey", requestKey);
    if (file) data.set("attachment", file);
    void run("finish", requestKey, () => requestApprovedCutRevision(data));
  }

  function startOver() {
    setRecorded(false);
    setNote(null);
    setContact(""); setWords(""); setTimecode(""); setConfirmed(false);
    if (fileRef.current) fileRef.current.value = "";
    setKey(crypto.randomUUID());
  }

  const header = (
    <div>
      <p className="font-semibold text-foreground">Record the client’s change request</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">This creates an exact-video revision record and an assigned task. It keeps the approved file and the client’s wording intact.</p>
    </div>
  );
  const noteLine = note && <p role="status" className={`text-xs leading-relaxed ${note.ok ? "text-success" : "text-danger"}`}>{note.text}</p>;
  const spin = (which: Busy) => busy === which && <Loader2 className="size-3.5 animate-spin" />;

  if (recorded) {
    return (
      <div className="space-y-3 rounded-xl border border-success/30 bg-success/5 p-3 text-sm">
        {header}
        {noteLine}
        <button type="button" onClick={startOver} className="text-xs font-medium text-brand hover:underline">Start a new request</button>
      </div>
    );
  }

  // A request this browser started and the server saved, not yet handed off.
  const current = draft && saved && saved.key === draft.requestKey ? saved : null;
  if (draft && current && "data" in current) {
    const s = current.data;
    const a = s.attachment;
    const fileOutstanding = !!a && a.state !== "CONFIRMED" && a.state !== "SKIPPED";
    return (
      <div className="space-y-3 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm">
        {header}
        <div className="space-y-1.5 rounded-lg border border-warning/30 bg-surface px-2.5 py-2 text-xs leading-relaxed">
          <p className="font-semibold text-foreground">A request was started here and is not recorded yet</p>
          <p><span className="text-muted">Video:</span> {s.videoLabel}{s.round ? ` · Version ${s.round}` : ""}{s.fileName ? ` · ${s.fileName}` : ""}</p>
          {s.contact && <p><span className="text-muted">Client contact:</span> {s.contact}</p>}
          <div>
            <span className="text-muted">Client’s words:</span>
            <p className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1.5">{s.words}</p>
          </div>
          {a && <p><span className="text-muted">Attachment:</span> {a.name} · {ATTACHMENT_STATE[a.state] ?? a.state}</p>}
          {s.newerRound && (
            <p className="text-warning">Version {s.newerRound} of this video was uploaded after this request was saved. If it already covers these changes, discard this request.</p>
          )}
        </div>
        {fileOutstanding && (
          <label className="block text-xs font-medium">Select “{a!.name}” again to upload it
            <span className="mt-1 flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-2"><Paperclip className="size-3.5" /><input ref={resumeFileRef} type="file" className="min-w-0 w-full text-xs" /></span>
          </label>
        )}
        {noteLine}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => finishSaved(draft.requestKey, draft.submissionId)} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
            {spin("finish")}{busy === "finish" ? "Recording…" : "Finish recording"}
          </button>
          {fileOutstanding && (
            <button type="button" onClick={() => void run("skip", draft.requestKey, () => finishStaffRevisionWithoutAttachment(projectId, draft.requestKey))} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium disabled:opacity-50">
              {spin("skip")}Finish without the attachment
            </button>
          )}
          {confirmDiscard ? (
            <span className="inline-flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted">Discard it? Nothing goes to an editor.</span>
              <button type="button" disabled={!!busy} onClick={() => void run("discard", draft.requestKey, () => discardStaffRevision(projectId, draft.requestKey)).then(() => setKey(crypto.randomUUID()))} className="inline-flex items-center gap-1 font-semibold text-danger hover:underline disabled:opacity-50">
                {spin("discard")}Yes, discard
              </button>
              <button type="button" disabled={!!busy} onClick={() => setConfirmDiscard(false)} className="text-muted hover:text-foreground">Keep it</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDiscard(true)} disabled={!!busy} className="text-xs text-muted hover:text-danger disabled:opacity-50">Discard this request</button>
          )}
        </div>
      </div>
    );
  }
  const checking = !!draft && !current;

  return (
    <form onSubmit={record} className="space-y-3 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm">
      {header}
      {checking && <p className="flex items-center gap-1.5 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Checking the request you started…</p>}
      {current && "missing" in current && <p className="rounded-lg border border-warning/30 bg-surface px-2.5 py-2 text-xs leading-relaxed">Your last try was not saved. Check the details below and record it again.</p>}
      {current && "error" in current && <p className="rounded-lg border border-warning/30 bg-surface px-2.5 py-2 text-xs leading-relaxed">Could not check the request you started ({current.error}). Recording below finishes that same request if it was saved.</p>}
      {fixedTarget ? (
        <p className="rounded-lg bg-surface px-2.5 py-2 text-xs font-medium">{fixedTarget.label} · Version {fixedTarget.round}{fixedTarget.fileName ? ` · ${fixedTarget.fileName}` : ""}</p>
      ) : (
        <label className="block text-xs font-medium">Which approved video?
          <select value={selected} onChange={(e) => setSelected(e.target.value)} required className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm">
            <option value="">{targetsLoading ? "Loading approved videos…" : "Choose the exact video"}</option>
            {targets.map((t) => <option key={t.submissionId} value={t.submissionId}>{t.label} · Version {t.round}{t.fileName ? ` · ${t.fileName}` : ""}</option>)}
          </select>
        </label>
      )}
      <label className="block text-xs font-medium">Client contact who asked
        <input value={contact} onChange={(e) => setContact(e.target.value)} required minLength={2} maxLength={120} placeholder="Name the person, not just the account" className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm" />
      </label>
      <label className="block text-xs font-medium">Client’s exact words
        {sourceMessage ? (
          <>
            <p className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-surface px-2.5 py-2 text-sm font-normal">{sourceMessage.body}</p>
            <p className="mt-1 font-normal text-muted">Copied from the stored team message. If it paraphrases the client, record the exact wording from the Review Room instead.</p>
          </>
        ) : <textarea value={words} onChange={(e) => setWords(e.target.value)} required rows={4} maxLength={24000} placeholder="Paste or type what the client actually said" className="mt-1 w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-sm font-normal" />}
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs font-medium">Timestamp, if known
          <input value={timecode} onChange={(e) => setTimecode(e.target.value)} inputMode="numeric" placeholder="e.g. 1:23" pattern="[0-9]{1,3}:[0-9]{2}" className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm" />
        </label>
        <label className="block text-xs font-medium">Reference file, if supplied
          <span className="mt-1 flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-2"><Paperclip className="size-3.5" /><input ref={fileRef} type="file" className="min-w-0 w-full text-xs" /></span>
          <span className="font-normal text-muted">Word, PDF or image, up to 5 MB</span>
        </label>
      </div>
      <label className="flex items-start gap-2 text-xs leading-relaxed text-foreground"><input checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} type="checkbox" required className="mt-0.5" />These are the client’s words, and this is the video they meant.</label>
      {noteLine}
      <button type="submit" disabled={!!busy || checking || (!fixedTarget && !selected)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {spin("record")}{busy === "record" ? "Recording…" : "Record revision request"}
      </button>
    </form>
  );
}
