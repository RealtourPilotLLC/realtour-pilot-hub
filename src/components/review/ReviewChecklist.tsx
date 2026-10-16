"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ClipboardCheck, Loader2, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveReviewCheck } from "@/app/review/checklistActions";
import { BLOCK_TITLE, ITEMS_FOR, type BlockState, type CheckAnswer, type CheckBlock } from "@/lib/reviewChecklistCore";
import { byLine } from "@/lib/reviewAttribution";

// ---------------------------------------------------------------------------
// THE REVIEWER'S TWO-PART CHECK in the Review Room (Oct 15 2026). Two blocks
// above the verdict: is the FILE right (technical), and is it right for THIS
// client (creative). Each saves on its own, with who and when, so Kyle can do
// the technical pass and James the creative one. The technical block starts
// from the editor's own check; the reviewer confirms, not retypes. The page
// holds Approve until both are saved (and, on program and premium videos,
// until James or Jordan saved the creative one).
// ---------------------------------------------------------------------------

type Draft = Record<string, { answer: "OK" | "NA" | null; reason: string }>;

function startDraft(block: CheckBlock, state: BlockState, prefill: Record<string, CheckAnswer>): Draft {
  const out: Draft = {};
  const saved = new Map((state.saved?.answers ?? []).map((a) => [a.key, a]));
  for (const item of ITEMS_FOR[block]) {
    const s = state.stale ? undefined : saved.get(item.key);
    const p = block === "TECH" ? prefill[item.key] : undefined;
    const a = s ?? p;
    out[item.key] = { answer: a?.answer ?? null, reason: a?.reason ?? "" };
  }
  return out;
}

function OneBlock({
  submissionId, block, state, prefill, canSign, signNote, required,
}: {
  submissionId: string;
  block: CheckBlock;
  state: BlockState;
  prefill: Record<string, CheckAnswer>;
  /** may this viewer save this block? */
  canSign: boolean;
  /** why not, when they may not */
  signNote: string | null;
  required: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => startDraft(block, state, prefill));
  const [note, setNote] = useState(state.saved?.note ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const items = ITEMS_FOR[block];
  const answered = items.filter((i) => draft[i.key]?.answer).length;
  const done = !!state.saved && !state.stale;
  const fromEditor = block === "TECH" && Object.keys(prefill).length > 0;

  const set = (key: string, patch: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  const save = () =>
    start(async () => {
      setMsg(null);
      const answers: CheckAnswer[] = items.map((i) => ({ key: i.key, answer: (draft[i.key]?.answer ?? "OK") as "OK" | "NA", reason: draft[i.key]?.reason || null }))
        .filter((a) => draft[a.key]?.answer);
      const r = await saveReviewCheck({ submissionId, block, answers, note }).catch(() => ({ ok: false, message: "That didn't save. Check your connection and try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });

  const Icon = block === "TECH" ? ClipboardCheck : Palette;
  return (
    <div className={cn("rounded-xl border px-3 py-2.5", done ? "border-success/40 bg-success-soft/30" : "border-border bg-surface")} data-review-check={block}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-4 text-muted" aria-hidden />
        <h3 className="text-sm font-semibold">{BLOCK_TITLE[block]}</h3>
        {required && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">James or Jordan</span>}
        <span className="ml-auto text-xs text-muted">
          {done && state.saved ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="size-3.5" /> {byLine(state.saved.by, state.saved.atISO)}</span>
            : state.stale && state.saved ? <span className="text-warning">The file changed after {state.saved.by.split(/\s+/)[0]}&rsquo;s check</span>
            : `${answered} of ${items.length}`}
        </span>
      </div>
      {fromEditor && !done && <p className="mt-1 text-xs text-muted">Started from the editor&rsquo;s own check. Confirm each line against the file.</p>}
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => {
          const d = draft[item.key] ?? { answer: null, reason: "" };
          return (
            <li key={item.key} className="text-sm">
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  aria-label={item.label}
                  className="mt-1 size-4 shrink-0"
                  checked={d.answer === "OK"}
                  disabled={!canSign || pending}
                  onChange={(e) => set(item.key, { answer: e.target.checked ? "OK" : null })}
                />
                <div className="min-w-0 flex-1">
                  <p className={cn("leading-snug", d.answer === "NA" && "text-muted line-through")}>{item.label}</p>
                  {item.help && <p className="text-xs text-muted-2">{item.help}</p>}
                  {item.naAllowed && canSign && (
                    <label className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted">
                      <input type="checkbox" checked={d.answer === "NA"} disabled={pending} onChange={(e) => set(item.key, { answer: e.target.checked ? "NA" : null })} />
                      Doesn&rsquo;t apply
                    </label>
                  )}
                  {d.answer === "NA" && (
                    <input
                      type="text"
                      value={d.reason}
                      disabled={!canSign || pending}
                      onChange={(e) => set(item.key, { reason: e.target.value })}
                      placeholder="Why it doesn't apply"
                      className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs"
                    />
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {canSign ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            placeholder="Note (optional)"
            className="min-h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm"
          />
          <button
            type="button"
            onClick={save}
            disabled={pending || answered < items.length}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending && <Loader2 className="size-4 animate-spin" />} {done ? "Save again" : `Save ${block === "TECH" ? "technical" : "creative"} check`}
          </button>
        </div>
      ) : (
        signNote && <p className="mt-2 text-xs text-muted">{signNote}</p>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={cn("mt-1 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

export function ReviewChecklist({
  submissionId, tech, creative, prefill, creativeRequired, canSignCreative, approveBlockedReason,
}: {
  submissionId: string;
  tech: BlockState;
  creative: BlockState;
  prefill: Record<string, CheckAnswer>;
  creativeRequired: boolean;
  /** Jordan, or James in the creative-approver seat (or anyone, when not required) */
  canSignCreative: boolean;
  approveBlockedReason: string | null;
}) {
  return (
    <section aria-label="Review checks" className="space-y-2" id="review-checks">
      <OneBlock key={`t-${tech.saved?.atISO ?? "new"}`} submissionId={submissionId} block="TECH" state={tech} prefill={prefill} canSign required={false} signNote={null} />
      <OneBlock
        key={`c-${creative.saved?.atISO ?? "new"}`}
        submissionId={submissionId}
        block="CREATIVE"
        state={creative}
        prefill={{}}
        canSign={canSignCreative}
        required={creativeRequired}
        signNote={creativeRequired ? "On program and premium videos, James or Jordan does the creative check." : null}
      />
      {approveBlockedReason && <p className="text-xs text-muted">{approveBlockedReason}</p>}
    </section>
  );
}
