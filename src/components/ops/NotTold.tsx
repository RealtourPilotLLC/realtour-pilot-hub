"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquareWarning } from "lucide-react";
import { recordClientNoticeAction } from "@/app/ops/actions";
import { NOTICE_OPTIONS } from "@/components/ops/MarkSent";
import { Button } from "@/components/ui/Action";
import { SaveStatus, type SaveState } from "@/components/ui/SaveStatus";
import { etDateTime } from "@/lib/datetime";
import type { NotTold as NotToldRow } from "@/lib/readyToSend";

type Attempt = { id: string; via: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const UNKNOWN = "The notice record is unconfirmed. It may already have saved. Refresh the status, or explicitly check and record the same notice below. Nothing retries automatically or sends a message.";

/** Records only. A monthly portal handoff does not establish client approval,
 * file receipt, or an Aryeo delivery. The server retains first-notice-wins. */
export function NotTold({ rows }: { rows: NotToldRow[] }) {
  if (!rows.length) return null;
  return <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
    <p className="flex items-center gap-2 text-sm font-semibold text-warning">
      <MessageSquareWarning aria-hidden className="size-4" />
      {rows.length === 1 ? "Client notification owed for one video" : `Client notification owed for ${rows.length} videos`}
    </p>
    <p className="mt-1 text-sm text-muted">Record how the client was actually told. These controls send no message.</p>
    <ul className="mt-3 space-y-3">{rows.map((r) => <Row key={r.submissionId} r={r} />)}</ul>
  </div>;
}

function Row({ r }: { r: NotToldRow }) {
  const router = useRouter();
  const [receipt, setReceipt] = useState<{ state: SaveState; message: string } | null>(null);
  const [recovery, setRecovery] = useState<Attempt | null>(null), [done, setDone] = useState(false);
  const [busy, start] = useTransition(), [refreshing, refresh] = useTransition();
  const pending = useRef(false), completed = useRef(false), uncertain = useRef<Attempt | null>(null);
  const storageKey = `rtp:client-notice:${r.submissionId}`;
  const options = NOTICE_OPTIONS.filter((o) => o.value !== "not-yet" && (!r.monthlyProgram || o.value !== "aryeo-email"));
  const readAttempt = (): Attempt | null => {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("id" in parsed) || !("via" in parsed) || typeof parsed.id !== "string" || !UUID.test(parsed.id) || typeof parsed.via !== "string" || !options.some((o) => o.value === parsed.via)) throw new Error("Unreadable notice recovery record");
    return { id: parsed.id, via: parsed.via };
  };
  const hold = (attempt: Attempt, message = UNKNOWN, state: SaveState = "error") => { uncertain.current = attempt; setRecovery(attempt); setReceipt({ state, message }); };
  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped || pending.current) return;
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (!raw) return;
        const attempt = JSON.parse(raw) as Attempt;
        if (UUID.test(attempt.id) && NOTICE_OPTIONS.some((o) => o.value === attempt.via && o.value !== "not-yet" && (!r.monthlyProgram || o.value !== "aryeo-email"))) {
          uncertain.current = attempt; setRecovery(attempt); setReceipt({ state: "error", message: UNKNOWN });
        }
      } catch { /* Every mutation checks recovery storage before dispatch. */ }
    });
    return () => { stopped = true; };
  }, [storageKey, r.monthlyProgram]);

  const record = (value: string, reconcile = false) => {
    if (pending.current || completed.current || !options.some((o) => o.value === value)) return;
    let previous: Attempt | null, attempt: Attempt;
    try {
      previous = readAttempt() ?? uncertain.current;
      if (previous && (!reconcile || value !== previous.via)) { hold(previous); return; }
      attempt = { id: crypto.randomUUID(), via: value };
      // Only the opaque ID and canonical notice enum survive refresh. No name,
      // client text, contact details or actor is stored on the device.
      sessionStorage.setItem(storageKey, JSON.stringify(attempt));
    } catch { setReceipt({ state: "error", message: "Browser recovery status could not be read or stored. No new request was made. Refresh the delivery status and restore browser storage before recording a notice." }); return; }
    pending.current = true; setReceipt(null);
    start(async () => {
      try {
        const res = await recordClientNoticeAction(r.submissionId, value);
        if (!res || typeof res.ok !== "boolean" || typeof res.message !== "string") { hold(attempt); return; }
        if (!res.ok && previous) { hold(attempt, `${res.message} The earlier notice record is still unconfirmed; resolve this blocker before checking it again.`); return; }
        completed.current = res.ok; setDone(res.ok);
        uncertain.current = null; setRecovery(null);
        const state = res.ok ? "saved" : "error";
        setReceipt({ state, message: res.message });
        try {
          if (readAttempt()?.id === attempt.id) sessionStorage.removeItem(storageKey);
          const other = readAttempt();
          if (other) hold(other, `${res.message} A different notice attempt remains unconfirmed. Refresh the status before another change.`, state);
        } catch { setReceipt({ state, message: `${res.message} The local recovery status could not be cleared. Refresh the notice status before another change.` }); uncertain.current = attempt; setRecovery(attempt); }
        if (res.ok) router.refresh();
      } catch { hold(attempt); }
      finally { pending.current = false; }
    });
  };
  const recoveryLabel = options.find((o) => o.value === recovery?.via)?.label;
  return <li className="space-y-2 text-sm text-muted">
    <p><span className="font-medium text-foreground">{r.street}</span> · {r.fileName} · {r.monthlyProgram ? "portal handoff recorded" : "delivery recorded"} {etDateTime(new Date(r.sentAtISO))} ET{r.sentBy ? ` by ${r.sentBy}` : ""}</p>
    {r.monthlyProgram && <p>Client notification is owed. The handoff alone does not establish client approval or file receipt.</p>}
    <div className="flex flex-wrap items-center gap-2">
      <span>Client was told by:</span>
      {options.map((o) => <Button key={o.value} variant="secondary" busy={busy} disabled={done || !!recovery} onClick={() => record(o.value)}>{o.label}</Button>)}
    </div>
    {receipt && <SaveStatus state={receipt.state} message={receipt.message} className="block" />}
    {recovery && <div className="space-y-2">
      <p>Checking again records the same notice if needed and preserves the first saved notice. It does not contact the client. A refresh alone does not prove the earlier request failed.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" busy={refreshing} disabled={busy} onClick={() => refresh(() => router.refresh())}>Refresh notice status</Button>
        <Button variant="secondary" busy={busy} busyLabel="Checking notice…" disabled={done || refreshing} onClick={() => record(recovery.via, true)}>Check and record: {recoveryLabel}</Button>
      </div>
    </div>}
  </li>;
}
