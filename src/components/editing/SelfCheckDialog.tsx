"use client";

import { useMemo, useState, useTransition } from "react";
import { CheckCircle2, ClipboardCheck, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  itemsFor,
  SELF_CHECK_REASON_MIN,
  validateSelfCheck,
  type SelfCheckAnswers,
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
// Written for someone who has just finished an edit: one line per thing to
// have done, "Yes" is the whole answer, "Not for this video" asks why in a
// sentence. The revision notes still open on this video sit underneath, each
// "Done" or "Not done — why". Nothing here is a test of the editor; it is the
// record of what they looked at.
// ---------------------------------------------------------------------------

export type SelfCheckIssue = { id: string; text: string; category: string; timeSec: number | null; fromRound: number | null; raisedByName: string | null };
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
  const asked = useMemo(() => itemsFor(profile, { isRevision: context.isRevision, openIssueIds: issueIds }), [profile, context.isRevision, issueIds]);
  const [answers, setAnswers] = useState<SelfCheckAnswers>({});
  const [done, setDone] = useState<Record<string, boolean | undefined>>({});
  const [why, setWhy] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const input: SelfCheckInput = {
    checklistKey: profile.checklistKey,
    answers,
    issues: {
      addressed: issueIds.filter((id) => done[id] === true),
      notAddressed: Object.fromEntries(issueIds.filter((id) => done[id] === false).map((id) => [id, why[id] ?? ""])),
    },
    watchedFile: { name: file.name, size: file.size ?? null, lastModified: file.lastModified ?? null },
  };
  const verdict = validateSelfCheck(profile, input, { isRevision: context.isRevision, openIssueIds: issueIds });

  const set = (key: string, a: "YES" | "NA", reason?: string) => setAnswers((s) => ({ ...s, [key]: { answer: a, reason: reason ?? s[key]?.reason ?? null } }));

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={() => !pending && onCancel()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send-for-review check"
        className="fixed left-1/2 top-1/2 z-[70] max-h-[90vh] w-[min(94vw,40rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-2xl sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <ClipboardCheck className="size-4 text-brand" /> {title ?? "Before it goes to review"}
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-muted">
              {profile.styleName} · the check for <span className="font-medium text-foreground">{file.name}</span>
              {onBehalfOf ? <> · you are checking it on behalf of <span className="font-medium text-foreground">{onBehalfOf}</span>, and it is recorded that way</> : null}
            </p>
          </div>
          <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg p-1 text-muted hover:bg-surface-2" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {notice && <p className="mt-3 rounded-lg border border-warning/40 bg-warning-soft/40 px-3 py-2 text-xs">{notice}</p>}
        <ol className="mt-4 space-y-2.5">
          {asked.map((it, n) => {
            const a = answers[it.key];
            return (
              <li key={it.key} className={cn("rounded-xl border p-3", a?.answer === "YES" ? "border-success/40 bg-success/5" : "border-border")}>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 w-4 shrink-0 text-right text-[11px] font-semibold text-muted-2">{n + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug">{it.key === "watched_full" ? `${it.label} (${file.name})` : it.label}</p>
                    {it.help && <p className="mt-0.5 text-[11px] leading-snug text-muted">{it.help}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => set(it.key, "YES")}
                        className={cn("inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold", a?.answer === "YES" ? "border-success bg-success text-white" : "border-border hover:bg-surface-2")}
                      >
                        <CheckCircle2 className="size-3.5" /> Yes
                      </button>
                      {it.naAllowed && (
                        <button
                          type="button"
                          onClick={() => set(it.key, "NA", a?.reason ?? it.naHint ?? "")}
                          className={cn("rounded-lg border px-2.5 py-1 text-xs font-medium", a?.answer === "NA" ? "border-brand bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-2")}
                        >
                          Not for this video
                        </button>
                      )}
                    </div>
                    {a?.answer === "NA" && (
                      <input
                        value={a.reason ?? ""}
                        onChange={(e) => set(it.key, "NA", e.target.value)}
                        placeholder={it.naHint ?? "Why it doesn't apply"}
                        className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs outline-none focus:border-brand"
                      />
                    )}
                    {a?.answer === "NA" && (a.reason ?? "").trim().length < SELF_CHECK_REASON_MIN && (
                      <p className="mt-1 text-[11px] text-muted-2">Say why in a few words.</p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {context.issues.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-2">Revision notes still open on this video</p>
            <ul className="mt-2 space-y-2">
              {context.issues.map((i) => (
                <li key={i.id} className="rounded-xl border border-border p-3">
                  <p className="text-sm leading-snug">
                    <span className="font-mono text-[11px] text-muted-2">{fmtT(i.timeSec)}</span>
                    {i.text}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-2">
                    {i.category}
                    {i.raisedByName ? ` · from ${i.raisedByName}` : ""}
                    {i.fromRound ? ` · on v${i.fromRound}` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDone((d) => ({ ...d, [i.id]: true }))}
                      className={cn("rounded-lg border px-2.5 py-1 text-xs font-semibold", done[i.id] === true ? "border-success bg-success text-white" : "border-border hover:bg-surface-2")}
                    >
                      Done in this version
                    </button>
                    <button
                      type="button"
                      onClick={() => setDone((d) => ({ ...d, [i.id]: false }))}
                      className={cn("rounded-lg border px-2.5 py-1 text-xs font-medium", done[i.id] === false ? "border-warning bg-warning-soft text-warning" : "border-border text-muted hover:bg-surface-2")}
                    >
                      Not done
                    </button>
                  </div>
                  {done[i.id] === false && (
                    <input
                      value={why[i.id] ?? ""}
                      onChange={(e) => setWhy((w) => ({ ...w, [i.id]: e.target.value }))}
                      placeholder="Why — e.g. the client said to leave it, waiting on their logo file"
                      className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs outline-none focus:border-brand"
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {err && <p className="mt-3 text-xs text-danger">{err}</p>}
        {!verdict.ok && <p className="mt-3 text-[11px] text-muted">{verdict.message}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:bg-surface-2">
            Not yet
          </button>
          <button
            type="button"
            disabled={pending || !verdict.ok}
            onClick={() =>
              start(async () => {
                setErr(null);
                const r = await onSubmit(input).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "That didn't go through — try again." }));
                if (!r.ok) setErr(r.message);
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />} Checked — send it
          </button>
        </div>
        <p className="mt-2 text-right text-[11px] text-muted-2">
          Recorded against this exact file ({profile.checklistKey}). A different export needs a fresh check.
        </p>
      </div>
    </>
  );
}
