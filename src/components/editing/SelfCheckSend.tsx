"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ClipboardCheck, Loader2, Send } from "lucide-react";
import { submitCutForReview, type SelfCheckCandidate } from "@/app/review/actions";
import { submitSelfCheck } from "@/app/review/selfCheckActions";
import { SelfCheckDialog, type SelfCheckContextView } from "@/components/editing/SelfCheckDialog";
import { withVideoFacts, type SelfCheckVideoFacts } from "@/lib/selfCheck";

// ---------------------------------------------------------------------------
// The two non-upload ways a cut reaches the reviewer, both behind the editor's
// check (§8.2):
//   · FolderSendForReview — the "Done — send to review" for a file exported
//     straight into 05-Final-Video. The server names the file it would send,
//     the check is asked about THAT file, and only then is anything written.
//   · HeldCutsCard — cuts that exist but wait on a check: found by the folder
//     sweep, an upload whose bytes were not the checked file, a moved cut.
// ---------------------------------------------------------------------------

export function FolderSendForReview({
  projectId,
  onBehalfOf = null,
  videoFacts = {},
}: {
  projectId: string;
  onBehalfOf?: string | null;
  /** Oct 16 2026: each video's own words for its final check (the names to
   *  spell, the end card), keyed by slot. The server names the file and its
   *  list; this only fills in the captions and brand lines' help. */
  videoFacts?: Record<string, SelfCheckVideoFacts>;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<SelfCheckCandidate | null>(null);

  if (done) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
        <Check className="size-4 shrink-0" /> {done}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note to the reviewer (optional)"
        className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-base outline-none focus:border-brand sm:text-sm"
      />
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setErr(null);
            const r = await submitCutForReview(projectId, note).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "Couldn't send. Try again." }));
            if ("needsSelfCheck" in r && r.needsSelfCheck && "candidate" in r && r.candidate) setCandidate(r.candidate);
            else if (r.ok) setDone(r.message);
            else setErr(r.message || "Couldn't send. Try again.");
          })
        }
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[#5b53ff] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4a43e0] disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send that file for review
      </button>
      {err && <p className="text-xs text-danger">{err}</p>}
      {candidate && (
        <SelfCheckDialog
          // A different file is a different check — the answers start over.
          key={`${candidate.submissionId ?? "new"}:${candidate.fileName}`}
          context={(() => {
            const ctx = candidate.context as SelfCheckContextView & { key?: string };
            const facts = ctx.key ? videoFacts[ctx.key] : undefined;
            return facts ? { ...ctx, profile: withVideoFacts(ctx.profile, facts) } : ctx;
          })()}
          file={{ name: candidate.fileName }}
          title={`Before ${candidate.fileName} goes to review`}
          onBehalfOf={onBehalfOf}
          onCancel={() => setCandidate(null)}
          onSubmit={async (input) => {
            const r = await submitCutForReview(projectId, note, input);
            if (r.ok) {
              setCandidate(null);
              setDone(r.message);
              router.refresh();
            } else if ("candidate" in r && r.candidate && r.candidate.fileName !== candidate.fileName) {
              // A newer export landed while the list was open — ask about that one.
              setCandidate(r.candidate);
            }
            return { ok: r.ok, message: r.message };
          }}
        />
      )}
    </div>
  );
}

export type HeldCutView = {
  submissionId: string;
  round: number;
  fileName: string | null;
  label: string;
  reason: string | null;
  sizeBytes: number | null;
  context: SelfCheckContextView;
};

export function HeldCutsCard({ held, onBehalfOf = null, canFinish }: { held: HeldCutView[]; onBehalfOf?: string | null; canFinish: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<HeldCutView | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  if (held.length === 0) return null;
  return (
    <section id="self-check" className="scroll-mt-20 rounded-2xl border border-warning/40 bg-warning-soft/30 p-4 sm:p-5">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <ClipboardCheck className="size-4 text-warning" /> Waiting on your final check
      </div>
      <p className="mt-0.5 text-xs text-muted">
        The reviewer can&apos;t see these yet. Watch the file, finish the check, and it goes to review.
      </p>
      <ul className="mt-3 space-y-2">
        {held.map((h) => (
          <li key={h.submissionId} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {h.label} · version {h.round}
                {h.fileName ? <span className="ml-1.5 text-xs font-normal text-muted-2">{h.fileName}</span> : null}
              </p>
              {h.reason && <p className="mt-0.5 text-xs text-muted">{h.reason}</p>}
              {msg[h.submissionId] && <p className="mt-0.5 text-xs text-foreground/80">{msg[h.submissionId]}</p>}
            </div>
            {canFinish && (
              <button
                type="button"
                onClick={() => setOpen(h)}
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-brand-action px-4 py-2 text-sm font-semibold text-brand-fg hover:brightness-95"
              >
                <ClipboardCheck className="size-4" /> Finish the check
              </button>
            )}
          </li>
        ))}
      </ul>
      {open && (
        <SelfCheckDialog
          context={open.context}
          file={{ name: open.fileName ?? "this version", size: open.sizeBytes }}
          title={`Before ${open.label} version ${open.round} goes to review`}
          onBehalfOf={onBehalfOf}
          onCancel={() => setOpen(null)}
          onSubmit={async (input) => {
            const r = await submitSelfCheck(open.submissionId, input);
            if (r.ok) {
              setMsg((m) => ({ ...m, [open.submissionId]: r.message }));
              setOpen(null);
              router.refresh();
            }
            return r;
          }}
        />
      )}
    </section>
  );
}
