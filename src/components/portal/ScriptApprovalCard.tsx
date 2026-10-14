"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Download, Loader2, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalApproveScript, portalEditApprovedScript, portalRequestScriptChanges, portalScriptPdfLink } from "@/app/portal/actions";
import { ScriptWordsEditor, type EditableParts } from "@/components/script/ScriptWordsEditor";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { PortalTopic } from "@/lib/portal";
import { CTA_WORDS } from "@/lib/portalWords";

// ---------------------------------------------------------------------------
// THE CLIENT'S OWN VERDICT ON A SCRIPT (F09) — one component, lifted verbatim
// out of TopicBank (UI-01, Sep 24 2026) so the topic bank and My Plan's
// Scripts view send the decision the same way.
//
// R1 — the decision carries the version THIS PAGE rendered (sharedVersionId).
// If a newer one has been released since, the server refuses and the page
// refreshes, so the client lands on the words we would actually film instead
// of approving something they have not read. Never call the actions without
// it; a second copy of this block is how that guard would get lost.
//
// Two ways to report back: inside TopicBank (v1) the bank's own status line
// and transition (`onResult` + `run`); standing alone (v2), the result shows
// beside these buttons — "saving", then what happened — and a failure keeps
// the client's words so "try again" is one tap.
//
// "TRY AGAIN" ONLY WHEN TRYING AGAIN CAN WORK (Sep 24). It used to follow any
// refusal, and the closure it kept carried the version id of the render that
// failed — so after a stale-version refusal (a newer version released while
// the tab was open) the refresh put the new words on screen while "Try again"
// re-sent the OLD id and met the same refusal, forever, beside words the
// client had just been told to re-read. Now it is offered only when the
// request never got an answer (the network), and only while the version on
// screen is still the one it would send.
// ---------------------------------------------------------------------------

export type ScriptVerdict = NonNullable<PortalTopic["script"]>;
type R = { ok: boolean; message: string };
/** `transport`: the request never reached an answer — the one failure a plain retry can fix. */
type Outcome = R & { transport?: boolean };

export function ScriptApprovalCard({ script, parts = null, onResult, run, busy: parentBusy, large = false }: {
  script: ScriptVerdict;
  /** Oct 14 2026: the words of the version on the page, so the client can edit them once they approve. */
  parts?: EditableParts | null;
  /** The parent's status line (TopicBank v1). Absent → the result renders here. */
  onResult?: (r: R) => void;
  /** The parent's transition, so every button on the bank disables together. */
  run?: (fn: () => Promise<void>) => void;
  busy?: boolean;
  /** 44px touch targets (v2). */
  large?: boolean;
}) {
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [own, setOwn] = useState<{ ok: boolean; text: string } | null>(null);
  /** The send that never got an answer, and the version it carries — "Try again" repeats it only while that version is still on screen. */
  const [retry, setRetry] = useState<{ fn: () => void; versionId: string | null } | null>(null);
  const [ownBusy, startOwn] = useTransition();
  const busy = parentBusy ?? ownBusy;
  const start = run ?? ((fn: () => Promise<void>) => startOwn(fn));
  const done = (r: Outcome, again: () => void) => {
    if (onResult) { onResult({ ok: r.ok, message: r.message }); return; }
    setOwn({ ok: r.ok, text: r.message });
    // An object, never the bare function: React would CALL a function passed
    // to a state setter as an updater.
    setRetry(!r.ok && r.transport ? { fn: again, versionId: script.sharedVersionId ?? null } : null);
    // Refreshed either way: a refusal is most often a newer version released
    // since this page loaded (R1), and the reload is what puts it in front of them.
    router.refresh();
  };
  const approve = () =>
    start(async () => {
      setOwn(null);
      done(await portalApproveScript(portalAuthFromLocation(), script.id, script.sharedVersionId ?? "").catch((): Outcome => ({ ok: false, message: "That didn't save. Try again.", transport: true })), approve);
    });
  const sendChanges = () =>
    start(async () => {
      setOwn(null);
      const r: Outcome = await portalRequestScriptChanges(portalAuthFromLocation(), script.id, changeNote, script.sharedVersionId ?? "").catch((): Outcome => ({ ok: false, message: "That didn't send. Try again.", transport: true }));
      // A stale refusal keeps their words in the box: they are about to read a
      // new version and may well want to say the same thing about it.
      if (r.ok) { setChangeNote(""); setChanging(false); }
      done(r, sendChanges);
    });
  const btn = large ? "min-h-11 rounded-xl px-4 text-sm" : "";
  // AFTER THEY APPROVE (Oct 14 2026, Jordan): the PDF and their own edits.
  const [editing, setEditing] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async () => {
    setPdfBusy(true);
    setOwn(null);
    const r = await portalScriptPdfLink(portalAuthFromLocation(), script.id).catch(() => ({ ok: false, message: "That didn't work. Try again.", url: undefined }));
    setPdfBusy(false);
    if (r.ok && r.url) window.location.assign(r.url);
    else setOwn({ ok: false, text: r.message });
  };
  const saveWords = async (w: { hook: string; points: string[]; close: string; captionCta?: string | null }) => portalEditApprovedScript(portalAuthFromLocation(), script.id, script.sharedVersionId ?? "", w);

  return (
    <div className={cn("mt-3 border-t border-border pt-3", large && "space-y-2")}>
      {script.decision === "APPROVED" ? (
        <>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-success"><CheckCheck className="size-3.5" /> You signed off on this one{script.decidedAtISO ? ` on ${new Date(script.decidedAtISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}` : ""}.</p>
          <p className="mt-1 text-[11px] text-muted">It&rsquo;s yours now: you can change the wording yourself any time before we film, and download it as a PDF to practice with.</p>
          {!editing && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={downloadPdf} disabled={pdfBusy || busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}>{pdfBusy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} Download PDF</button>
              {parts && <button type="button" onClick={() => { setEditing(true); setOwn(null); }} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}><PencilLine className="size-3" /> Edit the wording</button>}
            </div>
          )}
          {editing && parts && (
            <ScriptWordsEditor
              parts={parts}
              intro="Change any line to say it your way. Keep a hook, each talking point and a close. What you save is the version we film."
              onSave={saveWords}
              onCancel={() => setEditing(false)}
              onSaved={(m) => { setEditing(false); setOwn({ ok: true, text: m }); router.refresh(); }}
            />
          )}
        </>
      ) : script.decision === "CHANGES_REQUESTED" ? (
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning"><PencilLine className="size-3.5" /> You asked for changes. We&rsquo;re reworking it and the new version lands here.</p>
      ) : (
        <>
          {script.staleApproval && <p className="mb-1.5 text-[11px] text-muted">We&rsquo;ve rewritten this since you last approved it. Have another read.</p>}
          <p className="mb-1.5 text-[11px] text-muted">Once you approve it, you can edit the wording yourself and download it as a PDF.</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={approve} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}><CheckCheck className="size-3" /> {CTA_WORDS.APPROVE}</button>
            <button type="button" onClick={() => setChanging(!changing)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}><PencilLine className="size-3" /> {CTA_WORDS.CHANGES}</button>
            {!onResult && busy && <span role="status" className="inline-flex items-center gap-1 text-[11px] text-muted"><Loader2 className="size-3 animate-spin" /> Saving…</span>}
          </div>
          {/* Oct 12 2026: the change box says what it's for, takes a few
              lines, and stacks on a phone — Submit and Cancel under the words. */}
          {changing && (
            <div className="mt-2 rounded-lg border border-border bg-surface-2/40 p-2.5">
              <label htmlFor={`script-changes-${script.id}`} className="block text-xs font-semibold">What would you like changed?</label>
              <p className="mt-0.5 text-[11px] text-muted">A line, a word, or the whole angle. We&rsquo;ll rework it and share the new version here.</p>
              <textarea id={`script-changes-${script.id}`} value={changeNote} onChange={(e) => { setChangeNote(e.target.value); setRetry(null); setOwn(null); }} rows={large ? 4 : 3} placeholder="For example: make the hook about first-time buyers" className="mt-1.5 block w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base outline-none focus:border-brand sm:text-sm" />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={sendChanges} disabled={busy || changeNote.trim().length < 3} className={cn("rounded-lg bg-brand-action px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", large ? "min-h-11 px-4 text-sm" : "")}>Submit changes</button>
                <button type="button" onClick={() => setChanging(false)} disabled={busy} className={cn("rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", large ? "min-h-11 px-4 text-sm" : "")}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
      {/* Standing alone, the answer sits beside the buttons that produced it. */}
      {!onResult && own && (
        <p role="status" className={cn("mt-1.5 flex flex-wrap items-center gap-2 text-xs", own.ok ? "text-success" : "text-danger")}>
          {own.text}
          {!own.ok && retry && retry.versionId === (script.sharedVersionId ?? null) && <button type="button" onClick={retry.fn} disabled={busy} className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Try again</button>}
        </p>
      )}
    </div>
  );
}
