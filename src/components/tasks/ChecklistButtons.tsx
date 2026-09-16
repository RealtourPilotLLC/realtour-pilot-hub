"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, X } from "lucide-react";
import { markCommsHandled, setSmartTaskStatus, dismissTask, setTaskAssignee } from "@/app/actions";
import { DISMISS_REASONS } from "@/lib/triage";
import { useRouter } from "next/navigation";

// "I handled this outside the hub" — completes the silent client_reply task,
// which every unanswered-comms surface honors as answered. `groupKey` scopes
// an email tick to exactly this sender's card.
export function HandledButton({ clientId, family = "phone", groupKey }: { clientId: string; family?: "phone" | "email"; groupKey?: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (done) return <span className="shrink-0 text-xs font-medium text-success"><Check className="mr-1 inline size-3.5" />Handled</span>;
  return (
    <>
      {err && <span className="shrink-0 text-xs text-danger">{err}</span>}
      <button
        disabled={busy}
        onClick={() => start(async () => {
          setErr(null);
          const r = await markCommsHandled(clientId, family, groupKey).catch(() => ({ ok: false as const, message: "Something went wrong — try again." }));
          if (r.ok) { setDone(true); router.refresh(); }
          else setErr(("message" in r && r.message) || "No access — admins only.");
        })}
        title="Mark handled — answered on a personal phone, in person, or no reply needed"
        className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Handled ✓"}
      </button>
    </>
  );
}

export function SlackDoneButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [done, setDone] = useState(false);
  if (done) return <span className="mt-0.5 shrink-0 text-xs font-medium text-success"><Check className="mr-1 inline size-3.5" />Done</span>;
  return (
    <button
      disabled={busy}
      onClick={() => start(async () => {
        await setSmartTaskStatus(taskId, "COMPLETED").catch(() => {});
        setDone(true);
        router.refresh();
      })}
      className="mt-0.5 shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Done ✓"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// "NOT NEEDED" — the other half of Done.
//
// Kyle's call (Sep 16): a good share of what's on the board describes work
// that already happened, and "Done ✓" is a lie on those rows while the status
// dropdown's raw "cancelled" recorded nothing at all. This asks WHY in one
// click and writes it onto the row, so the Done tab can show what was cleared
// and who cleared it instead of the row simply evaporating.
// ---------------------------------------------------------------------------

const REASON_LABEL: Record<string, string> = {
  "already done": "Already done",
  "not needed": "Not needed any more",
  duplicate: "Duplicate of another row",
  spam: "Spam / not real work",
};

// A row id out of whatever gets pasted: the hub link off the other task
// (".../tasks?tab=slack&task=cmu1…"), or the bare id.
function taskIdFrom(text: string): string {
  const m = text.match(/[?&]task=([A-Za-z0-9_-]+)/);
  return (m?.[1] ?? text).trim();
}

export function NotNeededButton({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  // "Duplicate" is the one reason that needs a second fact — WHICH row it
  // duplicates — or it records nothing anyone can follow up (review, Sep 16).
  const [dup, setDup] = useState(false);
  const [dupId, setDupId] = useState("");
  const [gone, setGone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (gone) {
    return (
      <span className="shrink-0 text-xs font-medium text-muted">
        <X className="mr-1 inline size-3.5" />{gone}
      </span>
    );
  }

  const pick = (reason: string, otherId?: string) =>
    start(async () => {
      setErr(null);
      const r = await dismissTask(taskId, reason, otherId).catch(() => ({ ok: false as const, message: "Couldn’t save — try again." }));
      if (r.ok) { setGone(REASON_LABEL[reason] ?? "Dismissed"); setOpen(false); setDup(false); router.refresh(); }
      else setErr(r.message);
    });

  const btn = compact
    ? "inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
    : "shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50";

  if (!open) {
    return (
      <>
        <button
          disabled={busy}
          onClick={() => setOpen(true)}
          title="Close this without pretending it got done — say why and it goes on the record"
          className={btn}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Not needed"}
        </button>
        {err && <span className="basis-full text-[11px] font-medium text-danger">{err}</span>}
      </>
    );
  }
  if (dup) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="text-[11px] font-medium text-muted-2">Duplicate of which row?</span>
        <input
          value={dupId}
          onChange={(e) => setDupId(e.target.value)}
          placeholder="Paste the other row’s link"
          className="min-w-0 flex-1 basis-40 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] text-foreground placeholder:text-muted-2"
        />
        <button
          disabled={busy || !taskIdFrom(dupId)}
          onClick={() => pick("duplicate", taskIdFrom(dupId))}
          className="rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-foreground/80 hover:bg-surface-2 disabled:opacity-50"
        >
          Save
        </button>
        <button onClick={() => { setDup(false); setErr(null); }} disabled={busy} className="px-1.5 py-1 text-[11px] text-muted hover:text-foreground">
          Cancel
        </button>
        {busy && <Loader2 className="size-3.5 animate-spin text-muted" />}
        {err && <span className="basis-full text-[11px] font-medium text-danger">{err}</span>}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="text-[11px] font-medium text-muted-2">Why?</span>
      {DISMISS_REASONS.map((r) => (
        <button
          key={r}
          disabled={busy}
          onClick={() => (r === "duplicate" ? (setDup(true), setErr(null)) : pick(r))}
          className="rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-foreground/80 hover:bg-surface-2 disabled:opacity-50"
        >
          {REASON_LABEL[r] ?? r}
        </button>
      ))}
      <button onClick={() => setOpen(false)} disabled={busy} className="px-1.5 py-1 text-[11px] text-muted hover:text-foreground">
        Cancel
      </button>
      {busy && <Loader2 className="size-3.5 animate-spin text-muted" />}
      {err && <span className="basis-full text-[11px] font-medium text-danger">{err}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The same idea on a CONVERSATION rather than a task (Replies tab, Sep 16).
// Three reasons, because they mean three different things to the walk:
//   · answered elsewhere / no reply needed → a cut point on this thread;
//   · spam → the same cut, plus the number is muted until someone un-mutes it.
// `clientId` is passed when we know them, so a client tick still closes their
// reply to-do the way the Comms tab's Handled ✓ does.
// ---------------------------------------------------------------------------

const COMMS_REASONS: { key: string; label: string; title: string }[] = [
  { key: "answered elsewhere", label: "Answered elsewhere", title: "Replied from a personal phone, in person, or by email" },
  { key: "no reply needed", label: "No reply needed", title: "Nothing is owed — close the row" },
  { key: "spam", label: "Spam", title: "Mute this number until someone un-mutes it" },
];

export function CommsDismissButton({
  threadKey,
  family,
  clientId,
  onCleared,
}: {
  threadKey: string;
  family: "phone" | "email";
  clientId?: string | null;
  onCleared?: () => void;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (gone) {
    return <span className="text-xs font-medium text-muted"><Check className="mr-1 inline size-3.5" />Cleared</span>;
  }

  const pick = (reason: string) =>
    start(async () => {
      setErr(null);
      const r = await markCommsHandled(clientId ?? null, family, undefined, { threadKey, reason }).catch(() => ({
        ok: false as const,
        message: "Couldn’t save — try again.",
      }));
      if (r.ok) { setGone(true); setOpen(false); onCleared?.(); router.refresh(); }
      else setErr(("message" in r && r.message) || "No access — admins only.");
    });

  if (!open) {
    return (
      <>
        <button
          disabled={busy}
          onClick={() => setOpen(true)}
          title="Clear this conversation — the messages stay in the Inbox, the row goes"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition hover:text-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />} Dismiss
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-muted-2">Clear it because:</span>
      {COMMS_REASONS.map((r) => (
        <button
          key={r.key}
          disabled={busy}
          title={r.title}
          onClick={() => pick(r.key)}
          className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground/85 hover:bg-surface-2 disabled:opacity-50"
        >
          {r.label}
        </button>
      ))}
      <button onClick={() => setOpen(false)} disabled={busy} className="px-1.5 py-1 text-xs text-muted hover:text-foreground">
        Cancel
      </button>
      {busy && <Loader2 className="size-4 animate-spin text-muted" />}
      {err && <span className="basis-full text-xs text-danger">{err}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ASSIGN, on the Slack tab itself (Sep 16). Slack asks used to double-list —
// the Slack tab AND the Other tab's "Needs assigning" pile — because the only
// place you could give one an owner was over there. Now they live in one
// place, so the control has to live there with them.
// ---------------------------------------------------------------------------
export function SlackAssignPicker({ taskId, options }: { taskId: string; options: { key: string; name: string }[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [picked, setPicked] = useState<string | null>(null);

  if (picked) return <span className="shrink-0 text-xs font-medium text-success">→ {picked}</span>;
  return (
    <select
      disabled={busy}
      defaultValue=""
      onChange={(e) => {
        const key = e.target.value;
        if (!key) return;
        const name = options.find((o) => o.key === key)?.name ?? key;
        start(async () => {
          await setTaskAssignee(taskId, key).catch(() => {});
          setPicked(name);
          router.refresh();
        });
      }}
      className="shrink-0 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
    >
      <option value="">Assign…</option>
      {options.map((o) => (
        <option key={o.key} value={o.key}>{o.name}</option>
      ))}
    </select>
  );
}
