"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { askAboutShootAction } from "@/app/shoot/actions";
import { acknowledgePhotographerBrief } from "@/app/shoot/brief/actions";

// ---------------------------------------------------------------------------
// TWO SMALL ANSWERS FOR A SHOOT (Oct 27 2026, Jordan: "the brief has no way
// to resolve anything"). Used on the creative manager's dashboard rows and on
// the brief page's prep card:
//   · AskOnJob: a question for Kyle (access, the schedule) or Jordan (the
//     script, the creative), in the person's own words, posted on the job's
//     team chat with them tagged. Sent only on Send;
//   · MarkBriefRead: the shoot-day brief's Got it (the version shown), the
//     one thing Kyle's desk waits on before the visit.
// A preview ("view as") shows neither control.
// ---------------------------------------------------------------------------

const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60";
const PRIMARY = `${BTN} bg-brand-action text-brand-fg hover:brightness-95`;
const QUIET = `${BTN} border border-border-strong font-medium hover:bg-surface-2`;
const LINK = "inline-flex min-h-8 items-center text-[12px] font-medium text-brand hover:underline";

type Result = { ok: boolean; message: string };

export function AskOnJob({ projectId, to = null, label, placeholder, readOnly = false, variant = "link" }: {
  projectId: string;
  /** a fixed recipient, or null to choose Kyle or Jordan */
  to?: "kyle" | "jordan" | null;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  variant?: "link" | "primary" | "quiet";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<"kyle" | "jordan">(to ?? "kyle");
  const [words, setWords] = useState("");
  const [msg, setMsg] = useState<Result | null>(null);
  const [busy, start] = useTransition();
  if (readOnly) return null;
  const send = () =>
    start(async () => {
      const r = await askAboutShootAction(projectId, to ?? who, words).catch(() => ({ ok: false, message: "That didn't send. Try again." }));
      setMsg(r);
      if (r.ok) { setWords(""); setOpen(false); router.refresh(); }
    });
  if (!open) {
    return (
      <span className="inline-flex flex-col">
        <button type="button" data-ask={projectId} data-ask-to={to ?? "choose"} onClick={() => { setOpen(true); setMsg(null); }} className={variant === "primary" ? PRIMARY : variant === "quiet" ? QUIET : LINK}>{label}</button>
        {msg?.ok && <span role="status" className="text-[12px] font-medium text-success">{msg.message}</span>}
      </span>
    );
  }
  return (
    <form data-ask-form={projectId} onSubmit={(e) => { e.preventDefault(); send(); }} className="mt-2 w-full basis-full space-y-2 rounded-xl border border-border p-3">
      {!to && (
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Who to ask</legend>
          {(["kyle", "jordan"] as const).map((k) => (
            <label key={k} className={cn("inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm", who === k ? "border-brand bg-brand-soft" : "border-border")}>
              <input type="radio" name={`ask-${projectId}`} value={k} checked={who === k} onChange={() => setWho(k)} className="size-4 accent-[var(--color-brand)]" />
              {k === "kyle" ? "Kyle (access, schedule)" : "Jordan (script, creative)"}
            </label>
          ))}
        </fieldset>
      )}
      <textarea
        value={words}
        onChange={(e) => setWords(e.target.value)}
        rows={2}
        maxLength={1000}
        aria-label={label}
        placeholder={placeholder ?? "Your question"}
        className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm"
      />
      <p className="text-[12px] text-muted">Posted on the job chat with {to === "jordan" || (!to && who === "jordan") ? "Jordan" : "Kyle"} tagged.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || words.trim().length < 3} className={PRIMARY}>{busy && <Loader2 aria-hidden className="size-4 animate-spin" />}Send</button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} className={QUIET}>Cancel</button>
      </div>
      {msg && !msg.ok && <p role="alert" className="text-sm text-danger">{msg.message}</p>}
    </form>
  );
}

export function MarkBriefRead({ day, digest, again = false, readOnly = false, variant = "primary" }: { day: string; digest: string; again?: boolean; readOnly?: boolean; variant?: "primary" | "quiet" }) {
  const router = useRouter();
  const [msg, setMsg] = useState<Result | null>(null);
  const [busy, start] = useTransition();
  if (readOnly) return null;
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        data-brief-ack={day}
        disabled={busy || !!msg?.ok}
        onClick={() => start(async () => {
          const r = await acknowledgePhotographerBrief(day, digest).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
          setMsg(r);
          if (r.ok) router.refresh();
        })}
        className={variant === "primary" ? PRIMARY : QUIET}
      >
        {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}{again ? "Mark changed brief read" : "Mark brief read"}
      </button>
      {msg && <span role={msg.ok ? "status" : "alert"} className={cn("text-[12px]", msg.ok ? "font-medium text-success" : "text-danger")}>{msg.message}</span>}
    </span>
  );
}
