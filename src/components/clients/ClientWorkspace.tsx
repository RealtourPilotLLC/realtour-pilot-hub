"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Save, Check, StickyNote, AlertTriangle, RefreshCw, ArrowDownToLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { loadCustomerNotes, saveCustomerNotes, type CustomerNotesState } from "@/app/clients/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";

type NotesReceipt = { state: "saved" | "partial" | "error"; message: string };

// ---------------------------------------------------------------------------
// THE CLIENT PAGE'S CUSTOMER NOTES. Until Oct 21 2026 this card had a second
// tab, "Email draft", an AI email draft from the client's last message beside
// the Gmail-thread draft in ClientEmails (audit F9: two email-draft tools on
// one page). Jordan kept one: ClientEmails' "AI-draft a reply", which reads
// the whole Gmail thread. This card is the customer notes alone.
// ---------------------------------------------------------------------------

export function confirmedCustomerNotes(previous: string, submitted: string, result: Pick<CustomerNotesState, "ok" | "syncError">): string {
  // syncError explicitly confirms the hub write, even though Aryeo refused it.
  return result.ok || result.syncError ? submitted.trim() : previous;
}

export function customerNotesSaveReceipt(result: Pick<CustomerNotesState, "ok" | "syncError" | "message">): NotesReceipt {
  return { state: result.ok ? "saved" : result.syncError ? "partial" : "error", message: result.message };
}

type Props = {
  clientId: string;
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
  return (
    <div className="rounded-2xl border bg-surface p-4">
      <CustomerNotes key={props.clientId} {...props} />
    </div>
  );
}

// Same note? Compared on collapsed whitespace so a trailing newline isn't a
// divergence. (The server does the same thing over the rich-text/plain-text
// boundary; this is only the client-side echo of it.)
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

// ONE set of customer notes. Aryeo's customer notes field is the system of
// record: what you type here is saved in the hub AND pushed back to Aryeo, and
// this card says out loud which of those two happened.
function CustomerNotes({ clientId, notes, notesSyncedAt, notesSyncError, aryeoLinked }: Props) {
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

  // Pull Aryeo's live copy when the card opens, so what's on screen is the one
  // reconciled list rather than a mirror that may have gone stale.
  useEffect(() => {
    if (!aryeoLinked || pending) return;
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
    // Saving supersedes an in-flight read so an older response cannot undo its receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, aryeoLinked]);

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
          <span className="inline-flex items-center gap-1.5"><StickyNote className="size-4" aria-hidden /> Customer notes</span>
          {state.linked ? (
            <span className="normal-case tracking-normal text-muted-2">Linked to Aryeo</span>
          ) : (
            <span className="normal-case tracking-normal text-warning">Hub only — no Aryeo customer</span>
          )}
        </label>
        <AutoTextarea
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
