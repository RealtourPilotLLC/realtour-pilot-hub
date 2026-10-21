"use client";

import { useRef, useState, useTransition } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";
import { cn } from "@/lib/utils";
import {
  TEXT_TEMPLATES, ONE_TEXT_CHARS, checkTemplateBody, previewTemplate,
  type TextAudience, type TextTemplateDef,
} from "@/lib/textTemplates";
import { resetTextTemplateAction, saveTextTemplateAction } from "@/app/settings/textTemplateActions";
import type { TextTemplateRow } from "@/lib/textTemplateStore";

// ---------------------------------------------------------------------------
// SETTINGS → TEXT MESSAGES (Jordan, Oct 21 2026: "add settings to customize
// all text templates"). Every text the hub sends on its own, to clients and to
// the team, with its words in a box. The defaults, the placeholder buttons, the
// preview and the checks all come from lib/textTemplates, the same module the
// senders render with, so what this card shows is what goes out. Jordan edits;
// Kyle reads.
// ---------------------------------------------------------------------------

const GROUPS: { audience: TextAudience; title: string; blurb: string }[] = [
  { audience: "client", title: "To clients", blurb: "Never a long dash and never a Dropbox link: those two are refused here." },
  { audience: "team", title: "To the team", blurb: "Texts and Slack messages to photographers, editors, the office and you." },
];

const PART_NOTE: Record<string, string> = {
  upload_chaser: "One part of the 10 PM upload chaser. The parts that apply that night go in one text, greeting first, a blank line between them.",
};

const dayTimeET = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function bodyOf(row: TextTemplateRow): string {
  return row.saved?.body ?? row.legacy?.body ?? TEXT_TEMPLATES[row.key].body;
}

export function TextMessagesSettings({ rows, isOwner }: { rows: TextTemplateRow[]; isOwner: boolean }) {
  const edited = rows.filter((r) => r.source !== "default").length;
  return (
    <div className="space-y-5">
      <div className="space-y-1.5 text-[13px] leading-relaxed text-muted">
        <p>
          The words of every text the hub sends on its own. A placeholder in braces, like <code>{"{first}"}</code>, is filled
          in for each person. Edit a text, check the preview, and save: the next one uses it within a minute. Reset puts the
          default back. When and whether each one sends is set in Automated texts and Internal alerts.
        </p>
        <p>
          Team texts start with &ldquo;⚙️ Realtour Hub:&rdquo; so the team can tell the hub sent them. That marker is added on its
          own and is not part of the wording.
        </p>
        {!isOwner && <p className="font-medium text-foreground/85">Only Jordan can change these. You can read every one here.</p>}
        <p>{edited === 0 ? "All of them use the default wording." : `${edited} of ${rows.length} use wording of your own.`}</p>
      </div>
      {GROUPS.map((g) => {
        const mine = rows.filter((r) => TEXT_TEMPLATES[r.key].audience === g.audience);
        return (
          <section key={g.audience} aria-labelledby={`text-messages-${g.audience}`} className="space-y-2">
            <div>
              <h3 id={`text-messages-${g.audience}`} className="text-sm font-semibold">{g.title} <span className="font-normal text-muted">({mine.length})</span></h3>
              <p className="text-[12px] text-muted">{g.blurb}</p>
            </div>
            <div className="space-y-1.5">
              {mine.map((r) => <TemplateRow key={r.key} initial={r} isOwner={isOwner} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TemplateRow({ initial, isOwner }: { initial: TextTemplateRow; isOwner: boolean }) {
  const def: TextTemplateDef = TEXT_TEMPLATES[initial.key];
  const [row, setRow] = useState(initial);
  const [draft, setDraft] = useState(() => bodyOf(initial));
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string; problems?: string[] } | null>(null);
  const [busy, start] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);

  const stored = bodyOf(row);
  const dirty = draft !== stored;
  const check = checkTemplateBody(row.key, draft);
  const preview = previewTemplate(row.key, draft);
  const overOne = preview.length > ONE_TEXT_CHARS;
  const canReset = row.source !== "default" || !!row.saved || !!row.legacy;
  const id = `text-template-${row.key}`;

  const insert = (name: string) => {
    const el = box.current;
    const token = `{${name}}`;
    const from = el?.selectionStart ?? draft.length;
    const to = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, from) + token + draft.slice(to));
    setFeedback(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + token.length, from + token.length);
    });
  };

  const settle = (res: { ok: boolean; message: string; problems?: string[]; row?: TextTemplateRow }) => {
    setFeedback({ ok: res.ok, message: res.message, problems: res.problems });
    if (res.ok && res.row) {
      setRow(res.row);
      setDraft(bodyOf(res.row));
    }
  };
  const save = () => start(async () => settle(await saveTextTemplateAction(row.key, draft).catch(() => ({ ok: false, message: "Couldn’t save. Try again." }))));
  const reset = () => start(async () => settle(await resetTextTemplateAction(row.key).catch(() => ({ ok: false, message: "Couldn’t reset. Try again." }))));

  const chip = row.savedProblems
    ? { label: "Default in use", tone: "bg-warning-soft text-warning" }
    : row.source === "saved"
      ? { label: "Edited", tone: "bg-brand-soft text-brand" }
      : row.source === "legacy"
        ? { label: "Earlier wording", tone: "bg-brand-soft text-brand" }
        : { label: "Default", tone: "bg-surface-2 text-muted" };

  return (
    <details data-text-template={row.key} className="group rounded-lg border border-border">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{def.label}</span>
          <span className="block text-[12px] text-muted">{def.when}</span>
        </span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", chip.tone)}>{chip.label}</span>
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3">
        {def.partOf && PART_NOTE[def.partOf] && <p className="text-[12px] text-muted">{PART_NOTE[def.partOf]}</p>}

        <div>
          <label htmlFor={id} className="text-[13px] font-medium">Wording</label>
          <textarea
            id={id}
            ref={box}
            value={draft}
            readOnly={!isOwner}
            onChange={(e) => { setDraft(e.target.value); setFeedback(null); }}
            rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))}
            className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-base leading-relaxed outline-none focus:border-brand read-only:opacity-80 sm:text-sm"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Insert a placeholder">
            {def.placeholders.map((p) => {
              const needed = def.required.includes(p.name);
              return (
                <button
                  key={p.name}
                  type="button"
                  disabled={!isOwner}
                  onClick={() => insert(p.name)}
                  title={`${p.means}${p.optional ? " (can be empty)" : ""}${needed ? ". This text has to keep it." : ""}`}
                  aria-label={`Insert {${p.name}}: ${p.means}`}
                  className={cn(
                    "inline-flex min-h-9 items-center rounded-full border px-2.5 font-mono text-[12px] hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent sm:min-h-7",
                    needed ? "border-brand/60 text-foreground" : "border-border text-muted",
                  )}
                >
                  {`{${p.name}}`}
                </button>
              );
            })}
          </div>
          <details className="mt-1.5 text-[12px] text-muted">
            <summary className="cursor-pointer select-none">What each placeholder becomes</summary>
            <ul className="mt-1 space-y-0.5">
              {def.placeholders.map((p) => (
                <li key={p.name}>
                  <code className="text-foreground/85">{`{${p.name}}`}</code> {p.means}
                  {p.optional ? ". Can be empty: then it goes, with the space before it" : ""}
                  {def.required.includes(p.name) ? ". Has to stay in the text" : ""}.
                </li>
              ))}
            </ul>
          </details>
        </div>

        <div className="rounded-lg border border-border bg-surface-2/60 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-2">Preview with sample values</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug">{preview || <span className="text-muted-2">Nothing to send.</span>}</p>
          <p className={cn("mt-2 text-[12px]", overOne ? "text-warning" : "text-muted")}>
            {preview.length} characters{overOne ? `: past ${ONE_TEXT_CHARS}, it goes as more than one text.` : "."}
          </p>
        </div>

        {!check.ok && (
          <ul className="space-y-0.5 text-[13px] text-danger" role="alert">
            {check.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        {row.savedProblems && (
          <p className="text-[13px] text-warning">
            The wording saved here does not pass the checks ({row.savedProblems.join(" ")}), so the default is being sent. Fix it and save, or reset.
          </p>
        )}

        <p className="text-[12px] text-muted">
          {row.saved
            ? `Last edited by ${row.saved.by ?? "someone"} on ${dayTimeET(row.saved.atISO)} ET.`
            : row.legacy
              ? `This is the wording saved earlier in ${row.legacy.where}, and it is what goes out. Saving or resetting here replaces it.`
              : "The default wording. Never edited."}
        </p>

        {isOwner && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} busy={busy} busyLabel="Saving…" disabled={!dirty || !check.ok}>
              {!busy && feedback?.ok && !dirty ? <Check aria-hidden className="size-4" /> : null} Save
            </Button>
            {dirty && <Button variant="quiet" disabled={busy} onClick={() => { setDraft(stored); setFeedback(null); }}>Undo changes</Button>}
            {canReset && (
              <Button variant="secondary" disabled={busy} onClick={reset}>
                <RotateCcw aria-hidden className="size-4" /> Reset to default
              </Button>
            )}
            {(feedback || dirty) && (
              <SaveStatus
                state={busy ? "saving" : feedback?.ok === false ? "error" : dirty ? "dirty" : feedback?.ok ? "saved" : "info"}
                message={!busy && feedback ? <>{feedback.message}{feedback.problems?.length ? ` ${feedback.problems.join(" ")}` : ""}</> : undefined}
              />
            )}
          </div>
        )}
      </div>
    </details>
  );
}
