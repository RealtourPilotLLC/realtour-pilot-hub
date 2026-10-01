"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CalendarOff, X } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { etAt } from "@/lib/datetime";
import { cancelCapacityExceptionAction, recordCapacityExceptionAction, type CapacityActionResult } from "./actions";

// ---------------------------------------------------------------------------
// §10 capacity (Sep 26 2026): the form that writes one CapacityException, and
// the Cancel on a register row. Mirrors lib/capacity's CAPACITY_KINDS the way
// the Settings cards mirror their server lists — that module is server-only.
// Times are Eastern (the business runs on ET); an empty end means "until
// someone says otherwise".
// ---------------------------------------------------------------------------

const KINDS: { key: string; label: string; hint: string }[] = [
  { key: "TIME_OFF", label: "Time off", hint: "a day off, a holiday, leave" },
  { key: "TRAINING", label: "Training", hint: "protected learning time" },
  { key: "BLOCKED", label: "Blocked", hint: "can't work on the queue — waiting on something" },
  { key: "CONNECTIVITY", label: "Offline", hint: "internet or power is down" },
  { key: "OTHER", label: "Other", hint: "a staffing decision, e.g. a backup editor this week" },
];
const SELF_KINDS = new Set(["CONNECTIVITY", "BLOCKED"]);

const TZ = "America/New_York";
function etLocalNow(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
function fromEtLocal(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const d = etAt(m[1], Number(m[2]), Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const INPUT = "min-h-11 min-w-0 max-w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
type Draft = { who: string; kind: string; from: string; until: string; note: string };
type Receipt = { outcome: "confirmed" | "refused" | "unknown"; message: string };

/** One opaque retry marker; no availability dates, notes or names are stored. */
function useCapacityWrite(key: string) {
  const [busy, start] = useTransition();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const pending = useRef(false), held = useRef(false);
  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped || pending.current) return;
      try { if (sessionStorage.getItem(key)) { held.current = true; setReceipt({ outcome: "unknown", message: "A previous capacity change is unconfirmed." }); } }
      catch { /* Each submission refuses locally if recovery storage fails. */ }
    });
    return () => { stopped = true; };
  }, [key]);
  const run = (write: () => Promise<CapacityActionResult>, after?: () => void) => {
    if (pending.current || held.current) return;
    let attempt: string;
    try {
      if (sessionStorage.getItem(key)) { held.current = true; setReceipt({ outcome: "unknown", message: "A previous capacity change is unconfirmed." }); return; }
      attempt = crypto.randomUUID(); sessionStorage.setItem(key, attempt);
    } catch { setReceipt({ outcome: "refused", message: "This browser could not keep the change's recovery status. No request was made. Restore browser storage before trying again." }); return; }
    pending.current = true;
    start(async () => {
      try {
        const r = await write();
        const outcome = r.ok && r.outcome === "confirmed" ? "confirmed" : !r.ok && r.outcome === "refused" ? "refused" : "unknown";
        held.current = outcome === "unknown";
        setReceipt({ outcome, message: outcome === "unknown" ? "The capacity change was not confirmed." : r.message });
        if (outcome !== "unknown") {
          try { if (sessionStorage.getItem(key) === attempt) sessionStorage.removeItem(key); }
          catch { held.current = true; setReceipt({ outcome: "unknown", message: `${r.message} The local recovery status could not be cleared; inspect the entry before another change.` }); }
        }
        if (outcome === "confirmed") after?.();
      } catch { held.current = true; setReceipt({ outcome: "unknown", message: "The capacity change was not confirmed." }); }
      finally { pending.current = false; }
    });
  };
  return { busy, receipt, run, blocked: busy || receipt?.outcome === "unknown" };
}
function CapacityReceipt({ receipt }: { receipt: Receipt | null }) {
  if (!receipt) return null;
  return <span role={receipt.outcome === "confirmed" ? "status" : "alert"} className="block max-w-full break-words text-ui-secondary leading-relaxed">
    {receipt.message}{receipt.outcome === "unknown" && " It may already have been recorded. Further changes are held in this tab. Ask Kyle to check the exact person, dates and capacity register before another request; reload does not prove that nothing changed."}
  </span>;
}

export function CapacityForm({
  people, selfOnly,
}: {
  /** who the viewer may record for; one entry for an editor (themselves) */
  people: { id: string; name: string }[];
  /** an editor: only "offline" and "blocked", only for themselves */
  selfOnly: boolean;
}) {
  const kinds = selfOnly ? KINDS.filter((k) => SELF_KINDS.has(k.key)) : KINDS;
  const [who, setWho] = useState(people[0]?.id ?? "");
  const [kind, setKind] = useState(kinds[0]?.key ?? "OTHER");
  const [from, setFrom] = useState(etLocalNow);
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const draft = useRef<Draft>({ who, kind, from, until, note });
  const { busy, blocked, receipt, run } = useCapacityWrite("ops-capacity-attempt:new");
  const change = <K extends keyof Draft,>(field: K, value: Draft[K], set: (value: Draft[K]) => void) => { draft.current = { ...draft.current, [field]: value }; set(value); };
  const submit = () => {
    const sent = { ...draft.current }, startsAt = fromEtLocal(sent.from), endsAt = sent.until ? fromEtLocal(sent.until) : null;
    if (!startsAt) return setLocalError("Pick when it starts.");
    if (sent.until && !endsAt) return setLocalError("That end isn't a real date.");
    setLocalError(null);
    run(() => recordCapacityExceptionAction({ teamMemberId: sent.who, kind: sent.kind, startsAt, endsAt, note: sent.note }), () => {
      if (Object.keys(sent).some((k) => sent[k as keyof Draft] !== draft.current[k as keyof Draft])) return;
      draft.current = { ...sent, note: "", until: "" }; setNote(""); setUntil("");
    });
  };
  return (
    <div className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-end gap-3">
        {!selfOnly && (
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-ui-secondary font-medium text-muted">
            Who
            <select value={who} onChange={(e) => change("who", e.target.value, setWho)} className={INPUT}>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex min-w-0 max-w-full flex-col gap-1 text-ui-secondary font-medium text-muted">
          What
          <select value={kind} onChange={(e) => change("kind", e.target.value, setKind)} className={INPUT}>
            {kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 max-w-full flex-col gap-1 text-ui-secondary font-medium text-muted">
          From (ET)
          <input type="datetime-local" value={from} onChange={(e) => change("from", e.target.value, setFrom)} className={INPUT} />
        </label>
        <label className="flex min-w-0 max-w-full flex-col gap-1 text-ui-secondary font-medium text-muted">
          Until (ET, optional)
          <input type="datetime-local" value={until} onChange={(e) => change("until", e.target.value, setUntil)} className={INPUT} />
        </label>
      </div>
      <p className="text-ui-status text-muted">{kinds.find((k) => k.key === kind)?.hint}</p>
      <input
        aria-label="Note"
        value={note}
        maxLength={300}
        placeholder="Note — what the office should know (optional)"
        onChange={(e) => change("note", e.target.value, setNote)}
        className={`${INPUT} w-full`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={submit}
          busy={busy}
          disabled={blocked || !who}
        >
          <CalendarOff className="size-4" /> Record it
        </Button>
        <CapacityReceipt receipt={receipt} />
        {localError && <span role="alert" className="text-ui-secondary text-danger">{localError}</span>}
      </div>
      <p className="text-ui-status leading-relaxed text-muted">
        It shows beside the person on the Editing Room&rsquo;s workload panel. Nothing is reassigned, no date moves and pay is not touched — the hub records the decision; people make it.
      </p>
    </div>
  );
}

export function CancelCapacityButton({ id }: { id: string }) {
  const { busy, blocked, receipt, run } = useCapacityWrite(`ops-capacity-attempt:cancel:${id}`);
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2">
      <Button
        variant="secondary" busy={busy} disabled={blocked}
        onClick={() => run(() => cancelCapacityExceptionAction(id))}
      >
        <X className="size-3" /> Cancel
      </Button>
      <CapacityReceipt receipt={receipt} />
    </span>
  );
}
