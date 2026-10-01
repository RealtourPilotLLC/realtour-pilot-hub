"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Mail, Save, Sparkles, Copy, Check, StickyNote, AlertTriangle, RefreshCw, ArrowDownToLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { draftClientReply, loadCustomerNotes, saveCustomerNotes, type CustomerNotesState } from "@/app/clients/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";

type DraftReply = { ok: boolean; message: string; draft?: string };
type DraftFeedback = { ok: boolean; message: string };
type EmailDraft = { value: string; feedback: DraftFeedback | null };
type CopyReceipt = DraftFeedback & { value: string };
type NotesReceipt = { state: "saved" | "partial" | "error"; message: string };

export async function attemptClientEmailDraft(request: () => Promise<DraftReply>): Promise<DraftReply> {
  try {
    return await request();
  } catch {
    return { ok: false, message: "Couldn't create the AI draft. Your words are still here. Try AI draft again when ready." };
  }
}

/** A reply belongs to the text present at request time. Never replace newer typing. */
export function finishClientEmailDraft(current: string, submitted: string, result: DraftReply): EmailDraft {
  if (!result.ok || !result.draft) {
    return { value: current, feedback: { ok: false, message: !result.ok && result.message ? result.message : "No AI draft was returned. Your words are still here." } };
  }
  if (current !== submitted) {
    return { value: current, feedback: { ok: true, message: "Your newer edits were kept. The AI draft wasn't applied; try AI draft again when ready." } };
  }
  return { value: result.draft, feedback: { ok: true, message: result.message } };
}

export async function copyClientEmailDraft(value: string, writeText: (value: string) => Promise<void>): Promise<CopyReceipt> {
  try {
    await writeText(value);
    return { ok: true, message: "Draft copied. Review before sending.", value };
  } catch {
    return { ok: false, message: "Couldn't copy the draft. Your words are still here; select and copy the text manually.", value };
  }
}

export function clientEmailCopyFeedback(receipt: CopyReceipt, current: string): DraftFeedback {
  return receipt.ok && receipt.value !== current
    ? { ok: true, message: "The earlier draft was copied. Your newer edits have not been copied." }
    : receipt;
}

export function confirmedCustomerNotes(previous: string, submitted: string, result: Pick<CustomerNotesState, "ok" | "syncError">): string {
  // syncError explicitly confirms the hub write, even though Aryeo refused it.
  return result.ok || result.syncError ? submitted.trim() : previous;
}

export function customerNotesSaveReceipt(result: Pick<CustomerNotesState, "ok" | "syncError" | "message">): NotesReceipt {
  return { state: result.ok ? "saved" : result.syncError ? "partial" : "error", message: result.message };
}

type Props = {
  clientId: string;
  hasPhone: boolean;
  email: string | null;
  lastInbound: string;
  /** THE customer note, as plain text. Aryeo's copy is the system of record. */
  notes: string;
  /** ET string — last time the mirror was confirmed against Aryeo. */
  notesSyncedAt: string | null;
  /** Set when the last write-back to Aryeo failed. */
  notesSyncError: string | null;
  /** false = no Aryeo customer behind this client, so the note is hub-only. */
  aryeoLinked: boolean;
};

export function ClientWorkspace(props: Props) {
  // Texting lives in the chat above now; this is for email drafts + notes.
  const [tab, setTab] = useState<"email" | "notes">("email");

  return (
    <div className="rounded-2xl border bg-surface">
      <div className="flex flex-wrap border-b border-border text-sm">
        <TabBtn active={tab === "email"} onClick={() => setTab("email")} icon={<Mail className="size-4" />} label="Email draft" />
        <TabBtn
          active={tab === "notes"}
          onClick={() => setTab("notes")}
          icon={<StickyNote className="size-4" />}
          label="Customer notes"
          // A note that never reached Aryeo must be visible before you open the
          // tab — otherwise the divergence hides one click away.
          alert={!!props.notesSyncError}
        />
      </div>
      <div className="p-4">
        {/* Keep local drafts and pending receipts when switching sections. Keys
            prevent those words from following navigation to another client. */}
        <div hidden={tab !== "email"}><EmailComposer key={props.clientId} {...props} active={tab === "email"} /></div>
        <div hidden={tab !== "notes"}><CustomerNotes key={props.clientId} {...props} active={tab === "notes"} /></div>
      </div>
    </div>
  );
}

function TabBtn({
  active, onClick, icon, label, alert,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; alert?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex min-h-11 min-w-11 items-center gap-1.5 rounded-t-xl px-4 py-2.5 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        active ? "border-b-2 border-brand text-foreground" : "text-muted hover:text-foreground",
      )}
    >
      {icon} {label}
      {alert && <span className="size-1.5 rounded-full bg-danger" title="This note hasn’t reached Aryeo" />}
    </button>
  );
}

function EmailComposer({ clientId, email, lastInbound, active }: Props & { active: boolean }) {
  const [draft, setDraft] = useState<EmailDraft>({ value: "", feedback: null });
  const body = draft.value;
  const [copyReceipt, setCopyReceipt] = useState<CopyReceipt | null>(null);
  const [pending, start] = useTransition();
  const [copyPending, startCopy] = useTransition();
  const copied = copyReceipt?.ok && copyReceipt.value === body;
  const copyFeedback = copyReceipt ? clientEmailCopyFeedback(copyReceipt, body) : null;
  return (
    <div>
      <AutoTextarea
        // Re-measure on reveal; the composer holding the draft stays mounted.
        key={active ? "shown" : "hidden"}
        aria-label="Email reply draft"
        value={body}
        onChange={(e) => {
          const value = e.target.value;
          setDraft((current) => ({ ...current, value }));
        }}
        minRows={5}
        placeholder="Draft an email reply… (use AI draft, then review and send from your mail app)"
        className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const submitted = body;
              const result = await attemptClientEmailDraft(() => draftClientReply(clientId, "email", lastInbound));
              setDraft((current) => finishClientEmailDraft(current.value, submitted, result));
            })
          }
        >
          <Sparkles className="size-4 text-brand" /> {pending ? "Drafting…" : "AI draft"}
        </Button>
        <Button
          variant="secondary"
          disabled={!body.trim()}
          busy={copyPending}
          busyLabel="Copying…"
          onClick={() => startCopy(async () => {
            setCopyReceipt(await copyClientEmailDraft(body, (value) => navigator.clipboard.writeText(value)));
          })}
        >
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy"}
        </Button>
        {email && (
          <a
            href={`mailto:${email}?body=${encodeURIComponent(body)}`}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl bg-brand-action px-4 py-2 text-sm font-semibold text-brand-fg hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <Mail className="size-4" /> Open in mail
          </a>
        )}
      </div>
      {draft.feedback && <EmailFeedback feedback={draft.feedback} />}
      {copyFeedback && <EmailFeedback feedback={copyFeedback} />}
      <p className="mt-2 text-sm text-muted">Review before sending — the hub drafts, you send.</p>
    </div>
  );
}

function EmailFeedback({ feedback }: { feedback: DraftFeedback }) {
  return <p role={feedback.ok ? "status" : "alert"} aria-live={feedback.ok ? "polite" : "assertive"} aria-atomic="true"
    className={cn("mt-2 text-sm leading-relaxed", feedback.ok ? "text-muted" : "text-danger")}>
    {feedback.message}
  </p>;
}

// Same note? Compared on collapsed whitespace so a trailing newline isn't a
// divergence. (The server does the same thing over the rich-text/plain-text
// boundary; this is only the client-side echo of it.)
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

// ONE set of customer notes. Aryeo's customer notes field is the system of
// record: what you type here is saved in the hub AND pushed back to Aryeo, and
// this card says out loud which of those two happened.
function CustomerNotes({ clientId, notes, notesSyncedAt, notesSyncError, aryeoLinked, active }: Props & { active: boolean }) {
  const [text, setText] = useState(notes);
  // What's on the server right now — the yardstick for "Aryeo's copy differs".
  const [savedText, setSavedText] = useState(notes);
  const [state, setState] = useState<CustomerNotesState>({
    ok: true,
    message: "",
    linked: aryeoLinked,
    aryeoNotes: null,
    syncError: notesSyncError,
    syncedAt: notesSyncedAt,
  });
  const [loading, setLoading] = useState(aryeoLinked);
  const [flash, setFlash] = useState<NotesReceipt | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const operation = useRef(0);
  const noteEdits = useRef(0);

  // Pull Aryeo's live copy when the tab opens, so what's on screen is the one
  // reconciled list rather than a mirror that may have gone stale.
  useEffect(() => {
    if (!active || !aryeoLinked || pending) return;
    let alive = true;
    const version = ++operation.current;
    loadCustomerNotes(clientId)
      .then((r) => {
        if (!alive || operation.current !== version) return;
        setState(r);
        setReadError(r.ok ? null : r.message);
        // Nothing typed here yet and Aryeo has the note? Show Aryeo's words.
        if (r.aryeoNotes && !savedText.trim()) {
          setText((t) => (noteEdits.current > 0 || t.trim() ? t : r.aryeoNotes!));
          setSavedText(r.aryeoNotes);
        }
      })
      .catch(() => {
        if (alive && operation.current === version) {
          setState((current) => ({ ...current, ok: false, message: "The live read could not be confirmed", aryeoNotes: null }));
          setReadError("The live read could not be confirmed");
        }
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // Recheck on opening Notes, while keeping its local draft mounted. Saving
    // supersedes an in-flight read so an older response cannot undo its receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, aryeoLinked, active]);

  const save = (value: string) =>
    start(async () => {
      ++operation.current;
      try {
        const r = await saveCustomerNotes(clientId, value);
        ++operation.current;
        setState(r);
        // A failed provider push with syncError still confirms the hub write.
        // A known refusal (for example, missing client) confirms neither copy.
        setSavedText((current) => confirmedCustomerNotes(current, value, r));
        setFlash(customerNotesSaveReceipt(r));
        setReadError(null);
      } catch {
        ++operation.current;
        setState((current) => ({ ...current, ok: false }));
        setFlash({ state: "error", message: "The save could not be confirmed. Your words are still here; check the client record before saving again." });
      } finally {
        setLoading(false);
      }
    });

  // Aryeo holds different words than the copy we last saved — surface it and
  // let the note be reconciled in one click instead of silently forking.
  const aryeoDiffers =
    state.linked && state.aryeoNotes !== null && !same(state.aryeoNotes, savedText) && !same(state.aryeoNotes, text);

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`customer-notes-${clientId}`} className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-muted">
          <span>Customer notes</span>
          {state.linked ? (
            <span className="normal-case tracking-normal text-muted-2">Linked to Aryeo</span>
          ) : (
            <span className="normal-case tracking-normal text-warning">Hub only — no Aryeo customer</span>
          )}
        </label>
        <AutoTextarea
          key={active ? "shown" : "hidden"}
          id={`customer-notes-${clientId}`}
          value={text}
          onChange={(e) => {
            ++noteEdits.current;
            setText(e.target.value);
          }}
          minRows={5}
          placeholder="Anything the team should know about this client — the same notes you'd write on their Aryeo customer…"
          className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        />
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {state.linked
            ? "One list: these are the customer notes on this client's Aryeo record. Saving here updates Aryeo too."
            : "This client isn’t linked to an Aryeo customer, so this note lives in the hub only."}
        </p>
      </div>

      {loading && <p className="text-sm text-muted">Checking Aryeo for their copy…</p>}

      {/* Couldn't even READ Aryeo's copy — say so, rather than showing our
          mirror as if it were confirmed. */}
      {!loading && readError && state.linked && !state.syncError && (
        <p className="text-sm text-warning">
          Couldn’t check Aryeo’s copy just now ({readError}). Your current words are kept below.
        </p>
      )}

      {/* The write-back failed: the note is safe here, but the two are apart. */}
      {state.syncError && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft/60 px-3 py-2 text-sm text-danger">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold">Saved in the hub, but not in Aryeo.</p>
              <p className="mt-0.5 break-words opacity-90">{state.syncError}</p>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => save(text)}
                className="mt-1.5 border-danger/40 text-danger hover:bg-danger-soft"
              >
                <RefreshCw className={cn("size-3.5", pending && "animate-spin")} /> Try Aryeo again
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Aryeo moved on since we mirrored it — reconcile, don't fork. */}
      {aryeoDiffers && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft/50 px-3 py-2 text-sm">
          <p className="font-semibold text-warning">Aryeo’s copy is different</p>
          <p className="mt-1 whitespace-pre-wrap text-foreground/80">{state.aryeoNotes}</p>
          <Button
            variant="secondary"
            onClick={() => {
              ++noteEdits.current;
              setText(state.aryeoNotes ?? "");
            }}
            className="mt-1.5 border-warning/40 text-warning hover:bg-warning-soft"
          >
            <ArrowDownToLine className="size-3.5" /> Use Aryeo’s version
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={pending}
          onClick={() => save(text)}
        >
          {pending ? <Save className="size-4" /> : flash?.state === "saved" ? <Check className="size-4" /> : <Save className="size-4" />}
          {pending ? "Saving…" : "Save notes"}
        </Button>
        {flash && (
          <SaveStatus state={flash.state} message={`${flash.message}${text.trim() !== savedText.trim() ? " Your current edits are still unsaved." : ""}`} />
        )}
        {/* Positive confirmation comes from the LIVE read, not a stored
            timestamp — the note can only be called "in sync" when we just saw
            Aryeo's copy say the same thing. */}
        {!flash && state.linked && !state.syncError && state.aryeoNotes !== null && same(state.aryeoNotes, savedText) && (
          <span className="text-[11px] text-muted-2">
            In sync with Aryeo{state.syncedAt ? ` · ${state.syncedAt}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
