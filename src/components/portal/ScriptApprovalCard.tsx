"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Loader2, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalApproveScript, portalRequestScriptChanges } from "@/app/portal/actions";
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

export function ScriptApprovalCard({ script, onResult, run, busy: parentBusy, large = false }: {
  script: ScriptVerdict;
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
      done(await portalApproveScript(portalAuthFromLocation(), script.id, script.sharedVersionId ?? "").catch((): Outcome => ({ ok: false, message: "That didn't save — try again.", transport: true })), approve);
    });
  const sendChanges = () =>
    start(async () => {
      setOwn(null);
      const r: Outcome = await portalRequestScriptChanges(portalAuthFromLocation(), script.id, changeNote, script.sharedVersionId ?? "").catch((): Outcome => ({ ok: false, message: "That didn't send — try again.", transport: true }));
      // A stale refusal keeps their words in the box: they are about to read a
      // new version and may well want to say the same thing about it.
      if (r.ok) { setChangeNote(""); setChanging(false); }
      done(r, sendChanges);
    });
  const btn = large ? "min-h-11 px-3 text-sm sm:min-h-0 sm:px-2 sm:py-1 sm:text-[11px]" : "";

  return (
    <div className="mt-2 border-t border-border pt-2">
      {script.decision === "APPROVED" ? (
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-success"><CheckCheck className="size-3.5" /> You signed off on this one{script.decidedAtISO ? ` on ${new Date(script.decidedAtISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}` : ""}.</p>
      ) : script.decision === "CHANGES_REQUESTED" ? (
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning"><PencilLine className="size-3.5" /> You asked for changes — we&rsquo;re reworking it and the new version lands here.</p>
      ) : (
        <>
          {script.staleApproval && <p className="mb-1.5 text-[11px] text-muted">We&rsquo;ve rewritten this since you last approved it — have another read.</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={approve} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}><CheckCheck className="size-3" /> {CTA_WORDS.APPROVE}</button>
            <button type="button" onClick={() => { setChanging(!changing); setChangeNote(""); }} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}><PencilLine className="size-3" /> {CTA_WORDS.CHANGES}</button>
            {!onResult && busy && <span role="status" className="inline-flex items-center gap-1 text-[11px] text-muted"><Loader2 className="size-3 animate-spin" /> Saving…</span>}
          </div>
          {changing && (
            <div className="mt-1.5 flex items-start gap-2">
              <textarea value={changeNote} onChange={(e) => setChangeNote(e.target.value)} rows={2} placeholder="What should change? A line, a word, the whole angle&hellip;" aria-label="What should change about this script" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
              <button type="button" onClick={sendChanges} disabled={busy || changeNote.trim().length < 3} className={cn("shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", large ? "min-h-11" : "")}>Send</button>
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
