"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { AlertTriangle, CheckCircle2, CloudUpload, Loader2, MessageSquarePlus, RotateCcw, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
// The 1080p export spec and its words, from the file that owns both
// (lib/videoStyles — plain data and pure functions, safe in a client bundle).
import { EXPORT_SPEC, exportRefusal, isOverExportSpec, resolutionLabel } from "@/lib/videoStyles";
import { startCutUpload, finishCutUpload, abandonCutUpload, cutTakeBackFlags } from "@/app/review/actions";
import { saveCutMessage } from "@/components/editing/cutMessage.actions";
import { CutTakeBack, CutTakeBackFlags } from "@/components/review/CutTakeBack";
import type { CutTakeBackInfo } from "@/components/review/types";

// ---------------------------------------------------------------------------
// "Upload version N" — the editor's way into the Review Room (Jordan, Sep 1:
// cuts come in through the editor portal as Version 1, get reviewed, come
// back with revisions marked, and on approval go to Dropbox and get marked
// complete — per deliverable). One row per cut the job owes.
//
// The file goes straight from this browser to the hub's store in resumable
// parts (nothing large touches a server); the server only hands out a
// path-scoped token and records the result.
//
// Each row also carries the editor's MESSAGE to whoever reviews it (Jordan,
// Sep 2: "no border version", "couldn't fix the audio at 0:42"). It is stored
// on the submission's own note field, so the Review Room shows it next to that
// cut with nothing new to wire up.
// ---------------------------------------------------------------------------

// THE ONE LINE THAT FLIPS THE CUT STORE (RTP-01, Sep 17). `access` is the
// BROWSER's decision, not the server's: the SDK turns it into the
// `x-vercel-blob-access` header on this client's own PUT (createPutHeaders,
// @vercel/blob 2.8.0), and the signed token the hub hands back cannot overrule
// it — onBeforeGenerateToken's return type is
// Pick<GenerateClientTokenOptions,'allowedContentTypes'|'maximumSizeInBytes'
// |'validUntil'|'addRandomSuffix'|'allowOverwrite'|'cacheControlMaxAge'
// |'ifMatch'>, which has no `access` key at all. That is why the fix for 14
// world-readable client videos has to be made here and not in the route that
// audits the upload.
//
// So it reads an environment variable instead of a literal: the day the store
// is replaced with a private one, the hub's side of the change is
// NEXT_PUBLIC_REVIEW_CUT_ACCESS=private in Vercel plus a redeploy, and nobody
// has to find this file. It is NOT flipped ahead of the store: private access
// against the public store that exists today is refused by the control plane
// ("Cannot use private access on a public store") and every editor's upload
// stops that minute. Store first, rows moved second, token third, THIS
// VARIABLE LAST — docs/REVIEW-CUT-STORE-HANDOVER.md has the order and why
// each step is where it is. No private upload has ever been performed, so the
// first one is the test; §4.1 of that note is the finalize call that refuses a
// non-public URL and has to be fixed before an editor meets it.
const CUT_STORE_ACCESS = process.env.NEXT_PUBLIC_REVIEW_CUT_ACCESS === "private" ? "private" : "public";

export type CutRow = {
  deliverableId: string;
  slot: number;
  label: string;
  latest: {
    id: string; round: number; status: string; fileName: string | null; completedAt: string | null; note: string | null;
    /** What that version actually was, when we could measure it (Sep 16). */
    sourceWidth: number | null; sourceHeight: number | null;
  } | null;
  openNotes: number;
};

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);

// ---------------------------------------------------------------------------
// THE EXPORT CHECK — read the file's shape BEFORE a byte is uploaded.
//
// The browser already knows: hand a <video> a blob: URL of the chosen file and
// `loadedmetadata` carries videoWidth/videoHeight, rotation already applied, in
// a few milliseconds and with nothing sent anywhere. Doing it here rather than
// server-side is the whole point — a 355 MB 4K upload that gets refused on
// arrival has already cost an editor twenty minutes of their evening.
//
// It FAILS OPEN, deliberately and in three ways: an unreadable header, a codec
// the browser won't decode, or a machine slow enough to miss the timeout all
// resolve to null, and null is not a refusal. The server records what really
// arrived afterwards (review/actions recordArrivedDimensions). A diagnostic
// must never be the thing that stops an editor delivering.
// ---------------------------------------------------------------------------
const EXPORT_CHECK_TIMEOUT_MS = 8_000;

function readDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let el: HTMLVideoElement;
    let url: string;
    try {
      el = document.createElement("video");
      url = URL.createObjectURL(file);
    } catch {
      resolve(null); // no object URLs (a locked-down browser) — let it through
      return;
    }
    // One holder so the timeout can be cleared from inside the handler it
    // races (and so the whole thing resolves exactly once, whichever wins).
    const run: { timer?: ReturnType<typeof setTimeout>; done: boolean } = { done: false };
    const finish = (v: { width: number; height: number } | null) => {
      if (run.done) return;
      run.done = true;
      if (run.timer) clearTimeout(run.timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute("src");
      el.load(); // drop the decoder's hold on the file before we revoke the URL
      URL.revokeObjectURL(url);
      resolve(v);
    };
    run.timer = setTimeout(() => finish(null), EXPORT_CHECK_TIMEOUT_MS);
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () =>
      finish(el.videoWidth > 0 && el.videoHeight > 0 ? { width: el.videoWidth, height: el.videoHeight } : null);
    el.onerror = () => finish(null);
    el.src = url;
  });
}

// The hourly folder sweep parks its OWN provenance line in the same column
// ("Cut detected in the Dropbox Final folder — auto-entered for review.").
// That is the system talking, not the editor: 11 of the 13 cuts on file carry
// it. Never show it as somebody's message and never pre-fill the composer with
// it — the editor would end up "editing" a sentence they never wrote.
const AUTO_NOTE = /^Cut detected in the Dropbox Final folder/i;
const editorMessage = (n: string | null | undefined) => (n && !AUTO_NOTE.test(n) ? n : null);

function StatusPill({ latest, reopened }: { latest: CutRow["latest"]; reopened?: boolean }) {
  if (!latest) return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">Not uploaded yet</span>;
  if (latest.status === "APPROVED" && reopened) {
    // The client asked for changes after this version was approved — the
    // slot takes the corrected cut as the next version (Sep 8).
    return <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger"><Undo2 className="size-3" /> v{latest.round} approved · client asked for changes</span>;
  }
  if (latest.status === "APPROVED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
        <CheckCircle2 className="size-3" /> Approved{latest.completedAt ? " · in Dropbox" : " · copying to Dropbox"}
      </span>
    );
  }
  if (latest.status === "CHANGES_REQUESTED") {
    return <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger"><Undo2 className="size-3" /> Changes requested on v{latest.round}</span>;
  }
  // Withdrawn (rows from the afternoon of Sep 16 only — a take-back deletes
  // the version now). Nothing is in front of the reviewer, and v{round} is
  // free again for the right file.
  if (latest.status === "WITHDRAWN") {
    return <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted"><Undo2 className="size-3" /> v{latest.round} withdrawn</span>;
  }
  return <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">v{latest.round} in review</span>;
}

// The message that rides with one cut. Two shapes, because a message belongs to
// a VERSION, not to a slot:
//  · the version is already with the reviewer (PENDING) → editing it saves
//    straight onto that submission, so the reviewer sees the correction;
//  · nothing uploaded yet, or the last version was bounced → the next upload is
//    the one this message is about, so it is held here and sent up with it.
function CutMessage({
  savedNote,
  liveTargetId,
  draft,
  onDraft,
  nextVersion,
  canWrite,
  onSaved,
}: {
  savedNote: string | null;
  liveTargetId: string | null;
  draft: string;
  onDraft: (v: string) => void;
  nextVersion: number | null;
  canWrite: boolean;
  onSaved: (note: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, start] = useTransition();

  // Nothing to write and nothing written — say nothing.
  if (!canWrite && !savedNote) return null;

  const save = () => {
    if (!liveTargetId) {
      // Draft: no version exists to attach it to yet, so hold it for the upload.
      onDraft(text.trim());
      setOpen(false);
      return;
    }
    start(async () => {
      setErr(null);
      const r = await saveCutMessage(liveTargetId, text).catch(() => ({ ok: false as const, message: "That didn't save — try again." }));
      if (!r.ok) setErr(r.message);
      else {
        onSaved(text.trim() || null);
        setOpen(false);
      }
    });
  };

  if (open) {
    return (
      <div className="mt-2 space-y-1.5">
        <textarea
          autoFocus
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          placeholder="e.g. no border version · client's logo added · couldn't fix the audio at 0:42"
          className="w-full resize-none rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-sm outline-none focus:border-brand"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="size-3 animate-spin" />}
            {liveTargetId ? "Save message" : `Send with version ${nextVersion ?? ""}`.trim()}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setErr(null); }}
            className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface-2"
          >
            Cancel
          </button>
          {err && <span className="text-[11px] text-danger">{err}</span>}
        </div>
      </div>
    );
  }

  // In draft mode the message on the LAST version is not shown: it belongs to
  // a cut the reviewer has already seen (and the round history still carries
  // it) — reprinting it here reads as if it were about the version they are
  // uploading next.
  // Read-only viewers (and an approved cut, where nobody rewrites what the
  // reviewer signed off) always see the message that was actually sent.
  const shown = liveTargetId || !canWrite ? savedNote : (draft || null);
  return (
    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {shown ? (
        <p className="min-w-0 flex-1 text-xs italic leading-relaxed text-foreground/75">
          &ldquo;{shown}&rdquo;
          {!liveTargetId && canWrite && (
            <span className="ml-1.5 not-italic text-[10px] font-semibold uppercase tracking-wide text-muted-2">goes with version {nextVersion}</span>
          )}
        </p>
      ) : null}
      {canWrite && (
        <button
          type="button"
          onClick={() => { setText(liveTargetId ? (savedNote ?? "") : draft); setOpen(true); }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <MessageSquarePlus className="size-2.5" /> {shown ? "Edit message" : "Message for the reviewer"}
        </button>
      )}
    </div>
  );
}

// revisionOpen: the client has a VIDEO-lane revision open on this job. An
// approved cut normally takes no more versions; with a revision open the
// corrected cut goes in as the next version of the same slot (the server's
// startCutUpload allows exactly that — Sep 8 review: without it the editor
// had no button for the one scenario the revision flow exists for).
// canOverrideExport: OWNER/ADMIN. Jordan or Kyle will occasionally have a
// reason to send an over-spec file anyway, and a hard wall at 6pm with a client
// waiting is its own kind of failure. An EDITOR never sees that button — and
// this prop only decides whether it is DRAWN: startCutUpload checks the real
// role and records the override with a name on it (a browser's claim about who
// it is has never been worth anything).
export function CutUploader({
  projectId, cuts, canUpload, revisionOpen = false, canOverrideExport = false,
}: { projectId: string; cuts: CutRow[]; canUpload: boolean; revisionOpen?: boolean; canOverrideExport?: boolean }) {
  const router = useRouter();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [busy, setBusy] = useState<Record<string, { pct: number; label: string }>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  // Messages typed before the file exists (held until the upload creates the
  // version they belong to) and messages already saved this session (so the row
  // reads right without waiting on the refresh).
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string | null>>({});
  // A file the export check stopped, held so it can still be sent (owner/admin)
  // or simply replaced — the picker is one click away either way.
  const [blocked, setBlocked] = useState<Record<string, { file: File; width: number; height: number }>>({});
  const clearBlocked = (key: string) => setBlocked((s) => { const n = { ...s }; delete n[key]; return n; });
  // Remove / move state per version (Sep 16). The /edit page hands this panel
  // the cut rows, not these columns, so the panel asks for them itself — one
  // read per job, re-read whenever a version changes here or a control fires.
  const [flags, setFlags] = useState<Record<string, CutTakeBackInfo>>({});
  const [tick, setTick] = useState(0);
  const sig = useMemo(
    () => cuts.map((c) => `${c.deliverableId}:${c.slot}:${c.latest?.id ?? ""}:${c.latest?.status ?? ""}`).join("|"),
    [cuts],
  );
  useEffect(() => {
    let live = true;
    void cutTakeBackFlags(projectId)
      .then((rows) => { if (live) setFlags(Object.fromEntries(rows.map((r) => [r.submissionId, r]))); })
      .catch(() => { /* the panel works without the flags */ });
    return () => { live = false; };
  }, [projectId, sig, tick]);

  // Picking a file runs the export check first, then hands off to send(). The
  // check is local and quick; an over-spec file never reaches the network.
  async function begin(cut: CutRow, file: File) {
    const key = `${cut.deliverableId}:${cut.slot}`;
    setErr((e) => ({ ...e, [key]: "" }));
    clearBlocked(key);
    setBusy((b) => ({ ...b, [key]: { pct: 0, label: "Checking the export…" } }));
    const dim = await readDimensions(file);
    if (dim && isOverExportSpec(dim.width, dim.height)) {
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setBlocked((s) => ({ ...s, [key]: { file, width: dim.width, height: dim.height } }));
      return;
    }
    await send(cut, file, dim, false);
  }

  // `dim` is what the browser measured (null = it couldn't); `override` is an
  // owner/admin knowingly sending an over-spec file. Both ride up to the server
  // so the row records what arrived and who waved it through.
  async function send(cut: CutRow, file: File, dim: { width: number; height: number } | null, override: boolean) {
    const key = `${cut.deliverableId}:${cut.slot}`;
    setErr((e) => ({ ...e, [key]: "" }));
    setBusy((b) => ({ ...b, [key]: { pct: 0, label: "Starting…" } }));
    const started = await startCutUpload({
      projectId, deliverableId: cut.deliverableId, slot: cut.slot, fileName: file.name, sizeBytes: file.size,
      width: dim?.width ?? null, height: dim?.height ?? null, overrideExportSpec: override,
    })
      .catch(() => ({ ok: false as const, message: "Couldn't start the upload — try again." }));
    if (!started.ok) {
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setErr((e) => ({ ...e, [key]: started.message }));
      return;
    }
    // The reservation exists, so the refusal card (and the file it was holding)
    // has done its job and can go. NOT a moment earlier (Sep 16 review): if the
    // server turns an override down — a session that timed out, a role that
    // changed, a job no longer on the order — clearing first would have thrown
    // away the File reference too, and Jordan or Kyle would be picking the same
    // file off disk again to read the reason why.
    clearBlocked(key);
    let landed: string | null = null;
    try {
      const blob = await upload(started.pathname, file, {
        access: CUT_STORE_ACCESS,
        handleUploadUrl: "/api/review/upload",
        clientPayload: JSON.stringify({ submissionId: started.submissionId }),
        multipart: true,
        contentType: file.type || "application/octet-stream",
        onUploadProgress: ({ percentage }) => setBusy((b) => ({ ...b, [key]: { pct: percentage, label: `Uploading ${fmtBytes(file.size)}…` } })),
      });
      landed = blob.url;
      setBusy((b) => ({ ...b, [key]: { pct: 100, label: "Checking the file…" } }));
      const done = await finishCutUpload({ submissionId: started.submissionId, url: blob.url, pathname: blob.pathname });
      if (!done.ok) throw new Error(done.message);
      // The message the editor typed BEFORE the file existed now has a version
      // to belong to. Best-effort: the cut is already safely in review, so a
      // failure here keeps the draft and says so rather than losing the words.
      const pendingMsg = (draft[key] ?? "").trim();
      if (pendingMsg) {
        const m = await saveCutMessage(started.submissionId, pendingMsg).catch(() => ({ ok: false as const, message: "" }));
        if (m.ok) setDraft((d) => ({ ...d, [key]: "" }));
        else setErr((e) => ({ ...e, [key]: "The cut went to review, but your message didn't save — add it again below." }));
      }
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      // The row's saved-note memory belongs to the version that just went; the
      // fresh render carries the truth.
      setSaved((s) => { const n = { ...s }; delete n[key]; return n; });
      router.refresh();
    } catch (e) {
      await abandonCutUpload(started.submissionId, landed).catch(() => {});
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setErr((er) => ({ ...er, [key]: e instanceof Error ? e.message : "The upload failed — try again." }));
    }
  }

  if (cuts.length === 0) return null;
  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-brand/25 bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <CloudUpload className="size-4 text-brand" />
        {/* Named for what the panel DOES — it is how a cut gets in front of
            the reviewer (Jordan, Sep 2: "instead of Cuts to deliver, it
            should say Send to Review"). */}
        <h2 className="text-sm font-semibold">Send to Review</h2>
        <span className="text-xs text-muted">
          {cuts.filter((c) => c.latest?.status === "APPROVED").length} of {cuts.length} approved
        </span>
      </div>
      {/* THE EXPORT SPEC, right above the Upload buttons. It is also in "What
          to make" further up the brief — that is where it is read before the
          edit starts, and this is where it is read at the moment of export,
          which is the last minute it can still save somebody a re-render.
          Same words in both places (lib/videoStyles EXPORT_SPEC). */}
      <div className="border-b border-border bg-surface-2/40 px-4 py-2 sm:px-5">
        <p className="text-xs leading-relaxed text-foreground/85">
          <span className="font-semibold">{EXPORT_SPEC.headline}.</span> {EXPORT_SPEC.finalCut}{" "}
          <span className="text-muted">{EXPORT_SPEC.edit}</span>{" "}
          <span className="font-medium">{EXPORT_SPEC.audio}</span>
        </p>
      </div>
      <ul className="divide-y divide-border">
        {cuts.map((c) => {
          const key = `${c.deliverableId}:${c.slot}`;
          const b = busy[key];
          const reopened = revisionOpen && c.latest?.status === "APPROVED";
          // A withdrawn version FREES its number (Sep 16): the next upload is
          // that same version, not the one after it.
          const withdrawn = c.latest?.status === "WITHDRAWN";
          const next = (c.latest?.status === "APPROVED" && !reopened)
            ? null
            : c.latest ? (withdrawn ? c.latest.round : c.latest.round + 1) : 1;
          const isRedo = c.latest?.status === "CHANGES_REQUESTED" || reopened || withdrawn;
          // The remove/move state for this version. The flags read lands a
          // moment after the page does, so until it arrives the control is
          // drawn from what the row already knows: anyone who may upload here
          // may take their own cut back, and the server (removeCut) refuses
          // anyone it shouldn't — this only decides whether the link is drawn,
          // never whether the action is allowed. The optimistic guess is the
          // NARROW one (reviewer, Sep 16): only a version still in front of the
          // reviewer. An APPROVED cut is the office's call and a co-editor's
          // cut is theirs, so offering "Wrong video?" on either before the read
          // lands would only walk the editor into a refusal. `office` stays
          // false so the Dropbox checkbox is never drawn on a guess.
          const live = c.latest?.status === "PENDING" || c.latest?.status === "CHANGES_REQUESTED";
          const flag: CutTakeBackInfo | null =
            (c.latest ? flags[c.latest.id] : undefined) ??
            (c.latest && canUpload
              ? {
                  submissionId: c.latest.id, round: c.latest.round, status: c.latest.status,
                  fileName: c.latest.fileName,
                  canRemove: live,
                  canMove: live,
                  office: false,
                  finalPath: null, folderSourcePath: null,
                  withdrawnAt: null, withdrawnBy: null, withdrawnReason: null,
                  strandedFinalPath: null, movedFromStreet: null, movedAt: null, movedBy: null,
                }
              : null);
          // A message edits in place only while its version is with the
          // reviewer; otherwise the next upload is the one it describes.
          const liveTargetId = c.latest && c.latest.status === "PENDING" ? c.latest.id : null;
          const savedNote = key in saved ? saved[key] : editorMessage(c.latest?.note);
          const latestRes = resolutionLabel(c.latest?.sourceWidth, c.latest?.sourceHeight);
          const latestOver = isOverExportSpec(c.latest?.sourceWidth, c.latest?.sourceHeight);
          // A file this browser just stopped, and the words to hand back.
          const blk = blocked[key];
          const refusal = blk ? exportRefusal(blk.width, blk.height) : null;
          return (
            <li key={key} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.label}</span>
                  <StatusPill latest={c.latest} reopened={reopened} />
                  {c.openNotes > 0 && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">{c.openNotes} note{c.openNotes === 1 ? "" : "s"} to fix</span>
                  )}
                </div>
                {c.latest?.fileName && (
                  <p className="mt-0.5 truncate text-xs text-muted-2">
                    {c.latest.fileName}
                    {/* What that version actually was. Said out loud on every
                        row so "are we exporting 1080p now?" is answerable by
                        looking, and flagged when it isn't (Sep 16). */}
                    {latestRes && (
                      <span className={cn("ml-1.5", latestOver ? "font-semibold text-warning" : "text-muted-2")}>
                        · {latestRes}{latestOver ? " — over spec" : ""}
                      </span>
                    )}
                  </p>
                )}
                <CutMessage
                  savedNote={savedNote}
                  liveTargetId={liveTargetId}
                  draft={draft[key] ?? ""}
                  onDraft={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                  nextVersion={next}
                  // Approved cuts are history — the message stays readable, but
                  // nobody rewrites what the reviewer already signed off.
                  canWrite={canUpload && (c.latest?.status !== "APPROVED" || reopened)}
                  onSaved={(n) => setSaved((s) => ({ ...s, [key]: n }))}
                />
                {flag && <div className="mt-2"><CutTakeBackFlags info={flag} onDone={() => setTick((t) => t + 1)} /></div>}
                {flag?.canRemove && (
                  <div className="mt-1.5">
                    <CutTakeBack info={flag} cutLabel={c.label} onDone={() => setTick((t) => t + 1)} />
                  </div>
                )}
                {b && (
                  <div className="mt-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.max(2, b.pct)}%` }} />
                    </div>
                    <p className="mt-1 text-[11px] text-muted">{b.label} {b.pct > 0 && b.pct < 100 ? `${Math.round(b.pct)}%` : ""}</p>
                  </div>
                )}
                {err[key] && <p className="mt-1 text-xs text-danger">{err[key]}</p>}
                {/* THE REFUSAL. Whoever is reading this has just finished an
                    edit and been told "no" by a dialog, so the first line is
                    the only one that has to land: the work is fine. Then what
                    is wrong, then the exact export to use — in that order, and
                    never a word of telling-off. The rule is new; they have been
                    doing nothing wrong. */}
                {blk && refusal && (
                  <div className="mt-2 rounded-xl border border-warning/40 bg-warning-soft/40 p-3">
                    <p className="flex items-start gap-2 text-sm font-semibold">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                      <span>{refusal.lead}</span>
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-foreground/85">{refusal.what}</p>
                    <p className="mt-1.5 text-xs font-medium leading-relaxed text-foreground">{refusal.fix}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{refusal.orientation}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{refusal.why}</p>
                    {/* THE WAY OUT. Everything above assumes re-exporting is
                        easy, and most evenings it is — but the evening it
                        isn't is the one that matters, and a refusal with no
                        named next step leaves somebody holding a finished edit
                        (Sep 16 review). Kyle is the route, and he is an ADMIN,
                        so it is not a polite fiction: the button below is
                        genuinely his to press. */}
                    <p className="mt-2 text-xs leading-relaxed text-foreground/85">{refusal.stuck}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={!!b}
                        onClick={() => inputs.current[key]?.click()}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        <CloudUpload className="size-3.5" /> Choose the 1080p export
                      </button>
                      <button
                        type="button"
                        disabled={!!b}
                        onClick={() => clearBlocked(key)}
                        className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 disabled:opacity-60"
                      >
                        Cancel
                      </button>
                      {canOverrideExport && (
                        <button
                          type="button"
                          // Left drawn (and the file left held) until the
                          // server has actually taken it — send() clears this
                          // card the moment the reservation exists, and not
                          // before, so a refused override is still readable
                          // with the same file still in hand.
                          disabled={!!b}
                          onClick={() => { void send(c, blk.file, { width: blk.width, height: blk.height }, true); }}
                          className="rounded-lg border border-warning/50 px-2.5 py-1.5 text-xs font-medium text-warning hover:bg-warning-soft disabled:opacity-60"
                        >
                          Send the {resolutionLabel(blk.width, blk.height)} file anyway
                        </button>
                      )}
                    </div>
                    {canOverrideExport && (
                      <p className="mt-1.5 text-[11px] text-muted-2">
                        Sending it anyway is yours to do — it goes on the job&apos;s history with your name.
                      </p>
                    )}
                  </div>
                )}
              </div>
              {canUpload && next && (
                <>
                  <input
                    ref={(el) => { inputs.current[key] = el; }}
                    type="file"
                    accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void begin(c, f); }}
                  />
                  <button
                    type="button"
                    disabled={!!b}
                    onClick={() => inputs.current[key]?.click()}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60",
                      isRedo ? "bg-danger hover:opacity-90" : "bg-brand hover:opacity-90",
                    )}
                  >
                    {b ? <Loader2 className="size-4 animate-spin" /> : isRedo ? <RotateCcw className="size-4" /> : <CloudUpload className="size-4" />}
                    {b ? "Uploading" : `Upload version ${next}`}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-2 sm:px-5">
        The file goes straight to the hub in resumable parts and lands in the Review Room as the next version, with your
        message beside it. Once a cut is approved it is copied to the job&apos;s Final folder in Dropbox automatically.
      </p>
    </section>
  );
}
