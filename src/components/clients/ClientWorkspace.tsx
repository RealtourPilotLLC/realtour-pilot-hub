"use client";

import { useState, useTransition } from "react";
import { Mail, Save, Sparkles, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { draftClientReply, saveClientNotes } from "@/app/clients/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

type Props = {
  clientId: string;
  hasPhone: boolean;
  email: string | null;
  lastInbound: string;
  editingPreferences: string;
  generalNotes: string;
};

export function ClientWorkspace(props: Props) {
  // Texting lives in the chat above now; this is for email drafts + notes.
  const [tab, setTab] = useState<"email" | "notes">("email");

  return (
    <div className="rounded-2xl border bg-surface">
      <div className="flex border-b border-border text-sm">
        <TabBtn active={tab === "email"} onClick={() => setTab("email")} icon={<Mail className="size-4" />} label="Email draft" />
        <TabBtn active={tab === "notes"} onClick={() => setTab("notes")} icon={<Sparkles className="size-4" />} label="Notes" />
      </div>
      <div className="p-4">
        {tab === "email" && <EmailComposer {...props} />}
        {tab === "notes" && <NotesEditor {...props} />}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-4 py-2.5 font-medium",
        active ? "border-b-2 border-brand text-foreground" : "text-muted hover:text-foreground",
      )}
    >
      {icon} {label}
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

function NotesEditor({ clientId, editingPreferences, generalNotes }: Props) {
  const [prefs, setPrefs] = useState(editingPreferences);
  const [notes, setNotes] = useState(generalNotes);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-brand">Editing preferences</label>
        <AutoTextarea
          value={prefs}
          onChange={(e) => setPrefs(e.target.value)}
          minRows={2}
          placeholder="e.g. Bright & airy, blue skies, no HDR halos"
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
        />
      </div>
      <div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">General notes</label>
        <AutoTextarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          minRows={4}
          placeholder="Anything the team should know about this client…"
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
        />
      </div>
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            await saveClientNotes(clientId, prefs, notes);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          })
        }
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {saved ? <Check className="size-4" /> : <Save className="size-4" />} {saved ? "Saved" : pending ? "Saving…" : "Save notes"}
      </button>
    </div>
  );
}
