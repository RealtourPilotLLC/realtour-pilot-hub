"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ClipboardCheck, Loader2, X } from "lucide-react";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { cn } from "@/lib/utils";
import {
  itemsFor,
  naStartingReason,
  oneScreenInput,
  oneScreenProgress,
  oneScreenStart,
  SELF_CHECK_REASON_MIN,
  validateSelfCheck,
  type OneScreenState,
  type SelfCheckInput,
  type SelfCheckProfile,
} from "@/lib/selfCheck";

// ---------------------------------------------------------------------------
// THE SEND-FOR-REVIEW CHECK (unified handoff §8.2). One dialog for every door:
// an upload (CutUploader), a Final-folder cut (SelfCheckSend), and a held cut
// being finished (HeldCutsCard). The server re-runs the same validation from
// lib/selfCheck and binds the answers to the bytes — this only decides when
// the Send button lights.
//
// ONE SCREEN, ONE SEND (Jordan, Oct 5: six separate "Yes" taps per upload).
// Every line is listed at once with a single send button. EVERY LINE STARTS
// UNANSWERED (review, Oct 5 night — a list that started ticked let one press
// record a full pass nobody gave): the editor ticks each line, or marks it
// "Doesn't apply" and types why (the product's stock sentence is only the
// placeholder). Each revision note still open on the video is answered
// "Fixed" or "Not fixed" with why. The send button stays off until every line
// and note has an answer; each answer is stored on its own, against this exact
// file (lib/selfCheck oneScreenInput).
// ---------------------------------------------------------------------------

export type SelfCheckIssue = { id: string; text: string; category: string; timeSec: number | null; fromRound: number | null; raisedByName: string | null; jobWide?: boolean };
export type SelfCheckContextView = { profile: SelfCheckProfile; isRevision: boolean; issues: SelfCheckIssue[] };

const fmtT = (t: number | null) => (t == null ? "" : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")} `);

export function SelfCheckDialog({
  context,
  file,
  title,
  onBehalfOf,
  notice,
  onCancel,
  onSubmit,
}: {
  context: SelfCheckContextView;
  /** The file being attested to — named in the first line, bound server-side. */
  file: { name: string; size?: number | null; lastModified?: number | null };
  title?: string;
  /** The office attesting for an editor or vendor: shown, and recorded. */
  onBehalfOf?: string | null;
  /** Why the list is back (the server refused the last answers). */
  notice?: string | null;
  onCancel: () => void;
  /** Returns the server's answer; a refusal is shown in place. */
  onSubmit: (input: SelfCheckInput) => Promise<{ ok: boolean; message: string }>;
}) {
  const { profile } = context;
  const issueIds = useMemo(() => context.issues.map((i) => i.id), [context.issues]);
  const ctx = useMemo(() => ({ isRevision: context.isRevision, openIssueIds: issueIds }), [context.isRevision, issueIds]);
  const asked = useMemo(() => itemsFor(profile, ctx), [profile, ctx]);
  const initial = useMemo(() => oneScreenStart(profile, ctx), [profile, ctx]);
  const [state, setState] = useState<OneScreenState>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pending, start] = useTransition();
  const submitting = useRef(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const hadClosePrompt = useRef(false);

  useEffect(() => {
    if (confirmClose) {
      hadClosePrompt.current = true;
      keepEditing.current?.focus();
    } else if (hadClosePrompt.current) {
      hadClosePrompt.current = false;
      closeButton.current?.focus();
    }
  }, [confirmClose]);

  // Only a change the editor made is worth asking about before closing — the
  // list starts unanswered, and closing an untouched list loses nothing.
  const dirty = JSON.stringify(state) !== JSON.stringify(initial);
  function requestClose() {
    if (submitting.current) return;
    // Leave the choice visible on a second Escape. Hiding it during the native
    // cancel event can close the top-layer dialog while retaining this form's
    // React state, making the trigger unable to reopen it.
    if (confirmClose) return;
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onCancel();
  }

  const input = oneScreenInput(profile, ctx, state, file);
  const verdict = validateSelfCheck(profile, input, ctx);
  const progress = oneScreenProgress(profile, ctx, state);
  // A tick is YES; ticking it again takes the answer back. "Doesn't apply" is
  // its own answer and opens the reason box — empty, unless the office's own
  // record is the reason (naStartingReason).
  const answer = (key: string, a: "YES" | "NA") =>
    setState((s) => {
      const next = s.answer[key] === a ? undefined : a;
      const item = asked.find((i) => i.key === key);
      const why = next === "NA" && !s.why[key] && item ? { ...s.why, [key]: naStartingReason(item) } : s.why;
      return { ...s, answer: { ...s.answer, [key]: next }, why };
    });
  const fix = (id: string, on: boolean) => setState((s) => ({ ...s, fixed: { ...s.fixed, [id]: s.fixed[id] === on ? undefined : on } }));

  return (
    <ModalDialog label="Send-for-review check" busy={pending} holdEscape={confirmClose} onCancel={requestClose}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div tabIndex={-1} data-modal-initial-focus className="flex items-center gap-1.5 text-sm font-semibold">
            <ClipboardCheck className="size-4 shrink-0 text-brand" /> {title ?? "Before it goes to review"}
          </div>
          <p className="mt-0.5 break-words text-[12px] leading-snug text-muted">
            {profile.styleName} · <span className="font-medium text-foreground">{file.name}</span>
            {onBehalfOf ? <> · checked on behalf of <span className="font-medium text-foreground">{onBehalfOf}</span>, and recorded that way</> : null}
          </p>
        </div>
        <button ref={closeButton} type="button" onClick={requestClose} disabled={pending} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      {confirmClose && <div role="alert" className="mt-3 rounded-lg border border-warning/40 bg-warning-soft/40 p-3 text-sm">
        <p className="font-medium">You changed this check. Leave and start it over?</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button ref={keepEditing} type="button" onClick={() => setConfirmClose(false)} className="min-h-11 rounded-lg border border-border bg-surface px-3 font-semibold">Keep checking</button>
          <button type="button" disabled={pending} onClick={() => { if (!submitting.current) onCancel(); }} className="min-h-11 rounded-lg border border-warning/50 px-3 font-medium">Discard</button>
        </div>
      </div>}

      {notice && <p className="mt-3 rounded-lg border border-warning/40 bg-warning-soft/40 px-3 py-2 text-xs">{notice}</p>}
      <p className="mt-3 text-[12px] text-muted">Watch the export, then tick each line that&rsquo;s true — or say why it doesn&rsquo;t apply.</p>
      <ul className="mt-2 space-y-1.5">
        {asked.map((it) => {
          const a = state.answer[it.key];
          const yes = a === "YES";
          const na = a === "NA" && it.naAllowed;
          const why = state.why[it.key] ?? "";
          return (
            <li key={it.key} data-check-line={it.key} data-answer={yes ? "yes" : na ? "na" : "open"} className={cn("rounded-xl border px-3 py-2", yes ? "border-success/40" : na ? "border-brand/40 bg-brand-soft/20" : "border-border")}>
              <div className="flex items-start gap-2">
                <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={yes}
                    onChange={() => answer(it.key, "YES")}
                    className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--success)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-snug">{it.label}</span>
                    {it.help && <span className="mt-0.5 block text-[11px] leading-snug text-muted">{it.help}</span>}
                  </span>
                </label>
                {it.naAllowed && (
                  <button
                    type="button"
                    aria-pressed={na}
                    onClick={() => answer(it.key, "NA")}
                    className={cn("min-h-11 shrink-0 rounded-lg border px-2.5 text-[12px] font-medium", na ? "border-brand bg-brand-soft/40 text-brand" : "border-border text-muted hover:bg-surface-2")}
                  >
                    Doesn&rsquo;t apply
                  </button>
                )}
              </div>
              {na && (
                <div className="mt-1.5 pl-8">
                  <input
                    value={why}
                    onChange={(e) => setState((s) => ({ ...s, why: { ...s.why, [it.key]: e.target.value } }))}
                    aria-label={`Why "${it.label}" doesn't apply`}
                    placeholder={it.naHint ?? "Why it doesn't apply to this video"}
                    className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-brand"
                  />
                  <p className="mt-1 text-[11px] text-muted-2">
                    {why.trim().length < SELF_CHECK_REASON_MIN ? "Say why in a few words of your own." : it.naDefault && why === it.naHint ? "The office's own record — recorded as not applying." : "Recorded as not applying, with this reason."}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {context.issues.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-2">Revision notes on this video — fixed in this version?</p>
          <ul className="mt-2 space-y-1.5">
            {context.issues.map((i) => {
              const v = state.fixed[i.id];
              return (
                <li key={i.id} data-check-note={i.id} data-answer={v === true ? "fixed" : v === false ? "not-fixed" : "open"} className={cn("rounded-xl border px-3 py-2", v === true ? "border-success/40" : v === false ? "border-warning/50 bg-warning-soft/30" : "border-border")}>
                  <div className="flex items-start gap-2">
                    <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3">
                      <input type="checkbox" checked={v === true} onChange={() => fix(i.id, true)} aria-label="Fixed in this version" className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--success)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm leading-snug">
                          <span className="font-mono text-[11px] text-muted-2">{fmtT(i.timeSec)}</span>
                          {i.text}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-2">
                          {i.jobWide ? "Every video on this job · " : ""}
                          {i.category}
                          {i.raisedByName ? ` · from ${i.raisedByName}` : ""}
                          {i.fromRound ? ` · on v${i.fromRound}` : ""}
                        </span>
                      </span>
                    </label>
                    <button
                      type="button"
                      aria-pressed={v === false}
                      onClick={() => fix(i.id, false)}
                      className={cn("min-h-11 shrink-0 rounded-lg border px-2.5 text-[12px] font-medium", v === false ? "border-warning bg-warning-soft/40 text-warning" : "border-border text-muted hover:bg-surface-2")}
                    >
                      Not fixed
                    </button>
                  </div>
                  {v === false && (
                    <input
                      value={state.fixedWhy[i.id] ?? ""}
                      onChange={(e) => setState((s) => ({ ...s, fixedWhy: { ...s.fixedWhy, [i.id]: e.target.value } }))}
                      aria-label="Why it isn't fixed"
                      placeholder="Why not — e.g. the client said to leave it, waiting on their logo file"
                      className="mt-1.5 min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-brand"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {err && <p className="mt-3 text-xs text-danger" role="alert">{err}</p>}
      {!verdict.ok && <p className="mt-3 text-[12px] text-muted" data-check-progress>{progress.answered} of {progress.total} answered. {verdict.message}</p>}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={requestClose} disabled={pending} className="min-h-11 rounded-lg border border-border px-3 text-sm text-muted hover:bg-surface-2">
          Not yet
        </button>
        <button
          type="button"
          disabled={pending || !verdict.ok}
          onClick={() => {
            if (submitting.current) return;
            submitting.current = true;
            start(async () => {
              setErr(null);
              try {
                const r = await onSubmit(input).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "That didn't go through — try again." }));
                if (!r.ok) setErr(r.message);
              } finally {
                submitting.current = false;
              }
            });
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />} All checked — send it
        </button>
      </div>
      <p className="mt-2 text-right text-[11px] text-muted-2">
        Each answer is recorded as yours, for this exact file. A different export needs a fresh check.
      </p>
    </ModalDialog>
  );
}
