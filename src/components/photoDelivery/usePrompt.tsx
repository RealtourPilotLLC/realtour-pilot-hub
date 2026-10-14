"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Button } from "@/components/ui/Action";

// ---------------------------------------------------------------------------
// A promise-shaped prompt for the decisions that need words: "why are you
// ignoring this", "why is this photo left out", "why override the checklist"
// (plan 8.3: ignoring a MAJOR or CRITICAL needs a reason, with presets). It
// also serves plain confirmations. Built on the native dialog (ModalDialog),
// so focus stays inside and Escape cancels, which matters in review mode where
// the keyboard drives everything.
//
//   const { ask, dialog } = usePrompt();
//   const reason = await ask({ title, required: true, presets });  // string | null
//   const ok = await confirm({ title, body });                       // boolean
// ---------------------------------------------------------------------------

export type AskOptions = {
  title: string;
  description?: ReactNode;
  presets?: readonly string[];
  /** A reason must be typed (or picked). */
  required?: boolean;
  /** Minimum characters when required (default 3). */
  minLength?: number;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
};

type Pending =
  | { kind: "ask"; opts: AskOptions; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }; resolve: (v: boolean) => void };

export function usePrompt() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<string | null>(null);
  const resolved = useRef(false);

  const ask = useCallback(
    (opts: AskOptions) =>
      new Promise<string | null>((resolve) => {
        resolved.current = false;
        setText("");
        setPreset(null);
        setPending({ kind: "ask", opts, resolve });
      }),
    [],
  );
  const confirm = useCallback(
    (opts: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) => {
        resolved.current = false;
        setPending({ kind: "confirm", opts, resolve });
      }),
    [],
  );

  const close = (value: string | null | boolean) => {
    if (!pending || resolved.current) return;
    resolved.current = true;
    if (pending.kind === "ask") pending.resolve(typeof value === "string" ? value : null);
    else pending.resolve(value === true);
    setPending(null);
  };

  let dialog: ReactNode = null;
  if (pending?.kind === "confirm") {
    const o = pending.opts;
    dialog = (
      <ModalDialog label={o.title} onCancel={() => close(false)}>
        <h2 className="text-base font-semibold">{o.title}</h2>
        {o.body && <div className="mt-2 text-sm text-muted">{o.body}</div>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => close(false)}>Cancel</Button>
          <Button variant={o.danger ? "danger" : "primary"} data-modal-initial-focus onClick={() => close(true)}>{o.confirmLabel ?? "Continue"}</Button>
        </div>
      </ModalDialog>
    );
  } else if (pending?.kind === "ask") {
    const o = pending.opts;
    const min = o.minLength ?? 3;
    const composed = [preset, text.trim()].filter(Boolean).join(": ");
    const ok = !o.required || composed.length >= min;
    dialog = (
      <ModalDialog label={o.title} onCancel={() => close(null)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) close(composed);
          }}
        >
          <h2 className="text-base font-semibold">{o.title}</h2>
          {o.description && <div className="mt-1 text-sm text-muted">{o.description}</div>}
          {o.presets && o.presets.length > 0 && (
            <fieldset className="mt-3">
              <legend className="text-[13px] font-medium text-muted">Pick one, or write your own below</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {o.presets.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={preset === p}
                    onClick={() => setPreset((cur) => (cur === p ? null : p))}
                    className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${preset === p ? "border-brand bg-brand-soft text-foreground" : "border-border-strong text-muted hover:bg-surface-2 hover:text-foreground"}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <label className="mt-3 block text-[13px] font-medium text-muted" htmlFor="pd-prompt-text">
            {o.presets?.length ? "Details (optional with a choice above)" : o.required ? "Reason" : "Note (optional)"}
          </label>
          <textarea
            id="pd-prompt-text"
            data-modal-initial-focus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ok) {
                e.preventDefault();
                close(composed);
              }
            }}
            rows={3}
            maxLength={480}
            placeholder={o.placeholder ?? (o.required ? "Say why, in a few words" : "")}
            className="mt-1 w-full rounded-xl border border-border-strong bg-surface-2 p-3 text-sm text-foreground placeholder:text-muted-2 focus-visible:outline-2 focus-visible:outline-brand"
          />
          {o.required && !ok && <p className="mt-1 text-[13px] text-muted">A reason is required.</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => close(null)}>Cancel</Button>
            <Button type="submit" variant={o.danger ? "danger" : "primary"} disabled={!ok}>{o.confirmLabel ?? "Save"}</Button>
          </div>
        </form>
      </ModalDialog>
    );
  }

  return { ask, confirm, dialog, open: pending !== null };
}
