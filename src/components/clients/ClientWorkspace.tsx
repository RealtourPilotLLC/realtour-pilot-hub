"use client";

import { useEffect, useState, useTransition } from "react";
import { Mail, Save, Sparkles, Copy, Check, StickyNote, AlertTriangle, RefreshCw, ArrowDownToLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { draftClientReply, loadCustomerNotes, saveCustomerNotes, type CustomerNotesState } from "@/app/clients/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

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
      <div className="flex border-b border-border text-sm">
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
        {tab === "email" && <EmailComposer {...props} />}
        {tab === "notes" && <CustomerNotes {...props} />}
      </div>
    </div>
  );
}

function TabBtn({
  active, onClick, icon, label, alert,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; alert?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-4 py-2.5 font-medium",
        active ? "border-b-2 border-brand text-foreground" : "text-muted hover:text-foreground",
      )}
    >
      {icon} {label}
      {alert && <span className="size-1.5 rounded-full bg-danger" title="This note hasn’t reached Aryeo" />}
    </button>
  );
}

function EmailComposer({ clientId, email, lastInbound }: Props) {
  const [body, setBody] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div>
      <AutoTextarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        minRows={5}
        placeholder="Draft an email reply… (use AI draft, then review and send from your mail app)"
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await draftClientReply(clientId, "email", lastInbound);
              if (r.draft) setBody(r.draft);
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          <Sparkles className="size-4 text-brand" /> {pending ? "Drafting…" : "AI draft"}
        </button>
        <button
          disabled={!body.trim()}
          onClick={() => {
            navigator.clipboard.writeText(body);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy"}
        </button>
        {email && (
          <a
            href={`mailto:${email}?body=${encodeURIComponent(body)}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white"
          >
            <Mail className="size-4" /> Open in mail
          </a>
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted-2">Review before sending — the hub drafts, you send.</p>
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
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Pull Aryeo's live copy when the tab opens, so what's on screen is the one
  // reconciled list rather than a mirror that may have gone stale.
  useEffect(() => {
    if (!aryeoLinked) return;
    let alive = true;
    loadCustomerNotes(clientId)
      .then((r) => {
        if (!alive) return;
        setState(r);
        // Nothing typed here yet and Aryeo has the note? Show Aryeo's words.
        if (r.aryeoNotes && !savedText.trim()) {
          setText((t) => (t.trim() ? t : r.aryeoNotes!));
          setSavedText(r.aryeoNotes);
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // Runs once per mount of the tab — clientId is the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, aryeoLinked]);

  const save = (value: string) =>
    start(async () => {
      const r = await saveCustomerNotes(clientId, value);
      setState(r);
      setSavedText(value.trim());
      setFlash(r.message);
      if (r.ok) setTimeout(() => setFlash(null), 4000);
    });

  // Aryeo holds different words than the copy we last saved — surface it and
  // let the note be reconciled in one click instead of silently forking.
  const aryeoDiffers =
    state.linked && state.aryeoNotes !== null && !same(state.aryeoNotes, savedText) && !same(state.aryeoNotes, text);

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <span>Customer notes</span>
          {state.linked ? (
            <span className="normal-case tracking-normal text-muted-2">Saved to Aryeo</span>
          ) : (
            <span className="normal-case tracking-normal text-warning">Hub only — no Aryeo customer</span>
          )}
        </label>
        <AutoTextarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          minRows={5}
          placeholder="Anything the team should know about this client — the same notes you'd write on their Aryeo customer…"
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <p className="mt-1 text-[11px] text-muted-2">
          {state.linked
            ? "One list: these are the customer notes on this client's Aryeo record. Saving here updates Aryeo too."
            : "This client isn’t linked to an Aryeo customer, so this note lives in the hub only."}
        </p>
      </div>

      {loading && <p className="text-[11px] text-muted-2">Checking Aryeo for their copy…</p>}

      {/* Couldn't even READ Aryeo's copy — say so, rather than showing our
          mirror as if it were confirmed. */}
      {!loading && !flash && !state.ok && state.linked && !state.syncError && (
        <p className="text-[11px] text-warning">
          Couldn’t check Aryeo’s copy just now ({state.message}). What’s below is the hub’s last mirror of it.
        </p>
      )}

      {/* The write-back failed: the note is safe here, but the two are apart. */}
      {state.syncError && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft/60 px-3 py-2 text-xs text-danger">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold">Saved in the hub, but not in Aryeo.</p>
              <p className="mt-0.5 break-words opacity-90">{state.syncError}</p>
              <button
                disabled={pending}
                onClick={() => save(text)}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-danger/40 px-2 py-1 font-medium hover:bg-danger-soft disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3.5", pending && "animate-spin")} /> Try Aryeo again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Aryeo moved on since we mirrored it — reconcile, don't fork. */}
      {aryeoDiffers && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft/50 px-3 py-2 text-xs">
          <p className="font-semibold text-warning">Aryeo’s copy is different</p>
          <p className="mt-1 whitespace-pre-wrap text-foreground/80">{state.aryeoNotes}</p>
          <button
            onClick={() => setText(state.aryeoNotes ?? "")}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-warning/40 px-2 py-1 font-medium text-warning hover:bg-warning-soft"
          >
            <ArrowDownToLine className="size-3.5" /> Use Aryeo’s version
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={pending}
          onClick={() => save(text)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? <Save className="size-4" /> : state.ok && flash ? <Check className="size-4" /> : <Save className="size-4" />}
          {pending ? "Saving…" : "Save notes"}
        </button>
        {flash && (
          <span className={cn("text-xs", state.ok ? "text-success" : "text-danger")}>{flash}</span>
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
