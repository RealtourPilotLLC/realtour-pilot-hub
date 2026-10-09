"use client";

import { etDateTimeYear, etWeekdayDateYear } from "@/lib/datetime";
import { useEffect, useRef, useState, useTransition } from "react";
import { Calendar, Clock, RefreshCw, XCircle, Loader2, AlertTriangle, ChevronDown } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { rescheduleAppointmentAction, cancelAppointmentAction } from "@/app/actions";
import type { ApptResult } from "@/app/actions";

export type ApptView = {
  id: string;
  startAt: string | Date | null;
  endAt: string | Date | null;
  durationMin: number | null;
  status: string | null;
  title: string | null;
  description: string | null;
  preferenceType: string | null;
  requiresConfirmation: boolean;
  canCancel: boolean;
  canReschedule: boolean;
  rescheduledAt: string | Date | null;
  postponedAt: string | Date | null;
  previousStartAt: string | Date | null;
  assignedTo: { name: string; avatarColor: string } | null;
};

// Shoots are Eastern. Date and time as two calls (see datetime.ts).
function fmt(d: string | Date | null, withTime = true) {
  if (!d) return null;
  return (withTime ? etDateTimeYear(d) : etWeekdayDateYear(d)) || null;
}

// Aryeo appointment descriptions mix newlines + light HTML.
function cleanBrief(s: string): string {
  return s
    .replace(/<\/(div|p|li|ul)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// datetime-local needs "YYYY-MM-DDTHH:mm" in local time.
function toLocalInput(d: string | Date | null): string {
  if (!d) return "";
  const date = new Date(d);
  const off = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - off).toISOString().slice(0, 16);
}

type AppointmentHold = {
  appointmentId: string; attemptId: string; operation: "reschedule" | "cancel";
  draft: { start: string; notify: boolean };
};
function readHold(key: string, appointmentId: string): AppointmentHold | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value?.appointmentId === appointmentId && typeof value.attemptId === "string" && /^[0-9a-f-]{36}$/i.test(value.attemptId) && (value.operation === "reschedule" || value.operation === "cancel") && typeof value.draft?.start === "string" && typeof value.draft?.notify === "boolean" ? value : null;
  } catch { return null; }
}

export function AppointmentManager({ appt }: { appt: ApptView }) {
  const status = (appt.status || "").toUpperCase();
  const canceled = status === "CANCELED";
  const scheduled = status === "SCHEDULED";

  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showReschedule, setShowReschedule] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [newStart, setNewStart] = useState(toLocalInput(appt.startAt));
  // Unticked by default. Until Sep 24 2026 this box sent a field Aryeo does not
  // recognise and emailed nobody; now it really emails the client (Jordan's
  // call), so it must be a deliberate tick, not something to remember to undo.
  const [notify, setNotify] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const busyRef = useRef(false);
  const uncertainRef = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const startRef = useRef(newStart);
  const notifyRef = useRef(notify);
  const activeAttemptRef = useRef<AppointmentHold | null>(null);
  const nativeEditedRef = useRef(false);
  const holdKey = `appointment-unconfirmed:${appt.id}`;
  const holdMessage = "The appointment change is unconfirmed. Your typed date and email choice are kept. Ask Kyle to check this exact appointment in Aryeo, the hub timeline and any customer email before another change. Reloading does not prove the earlier request finished.";
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted || busyRef.current) return;
      try {
        const saved = readHold(holdKey, appt.id);
        if (saved) {
          activeAttemptRef.current = saved;
          if (!nativeEditedRef.current) {
            startRef.current = saved.draft.start; notifyRef.current = saved.draft.notify;
            setNewStart(saved.draft.start); setNotify(saved.draft.notify);
          }
          setShowReschedule(saved.operation === "reschedule"); setConfirmCancel(saved.operation === "cancel");
          uncertainRef.current = true; setUncertain(true); setMsg({ ok: false, text: holdMessage });
        }
      } catch { /* native input remains usable when device storage is unavailable */ }
    });
    return () => { mounted = false; };
  }, [appt.id, holdKey, holdMessage]);
  const hold = (operation: "reschedule" | "cancel", report?: string) => {
    uncertainRef.current = true; setUncertain(true);
    setShowReschedule(operation === "reschedule"); setConfirmCancel(operation === "cancel");
    setMsg({ ok: false, text: `${holdMessage}${report ? ` Server report: ${report}` : ""}` });
  };
  const mirrorInput = () => {
    nativeEditedRef.current = true;
    const active = activeAttemptRef.current;
    if (!active || (!busyRef.current && !uncertainRef.current)) return;
    const next = { ...active, draft: { start: startRef.current, notify: notifyRef.current } };
    activeAttemptRef.current = next;
    // A late response/input must not erase a different tab's newer marker.
    if (readHold(holdKey, appt.id)?.attemptId === active.attemptId) {
      try { localStorage.setItem(holdKey, JSON.stringify(next)); } catch { /* native draft is kept */ }
    }
  };
  const clearOwnMarker = (attempt: AppointmentHold) => {
    if (readHold(holdKey, appt.id)?.attemptId === attempt.attemptId) {
      try { localStorage.removeItem(holdKey); } catch { /* persisted hold stays conservative */ }
    }
  };

  const run = (operation: "reschedule" | "cancel", fn: () => Promise<ApptResult>) => {
    if (busyRef.current || uncertainRef.current) return;
    try {
      const earlier = readHold(holdKey, appt.id);
      if (earlier) {
        activeAttemptRef.current = earlier; hold(earlier.operation);
        if (nativeEditedRef.current) mirrorInput();
        return;
      }
    } catch { /* in-memory guards remain active */ }
    const submittedStart = newStart, submittedNotify = notify;
    let attemptId: string;
    try { attemptId = crypto.randomUUID(); }
    catch { setMsg({ ok: false, text: "The change request could not be prepared. Your input is kept; please try again." }); return; }
    const attempt: AppointmentHold = { appointmentId: appt.id, attemptId, operation, draft: { start: submittedStart, notify: submittedNotify } };
    busyRef.current = true;
    activeAttemptRef.current = attempt;
    // A refresh while awaiting the action is uncertain too. This local ID is
    // a device guard, not a provider receipt or cross-tab/server write lock.
    try { localStorage.setItem(holdKey, JSON.stringify(attempt)); }
    catch { /* pending/unknown guards still protect this mounted page */ }
    start(async () => {
      try {
        const r = await fn();
        if (r.outcome === "refused" && !r.ok) {
          clearOwnMarker(attempt);
          setMsg({ ok: false, text: r.message }); return;
        }
        // Omitted legacy outcomes cannot distinguish a pre-write refusal from
        // provider uncertainty. Neither a reload nor a local stamp settles it.
        if (r.outcome !== "confirmed" || !r.ok) { hold(operation, r.message); return; }
        clearOwnMarker(attempt);
        const newerInput = startRef.current !== submittedStart || notifyRef.current !== submittedNotify;
        setMsg({ ok: true, text: `${r.message}${newerInput ? " Your newer local date or email choice is kept and has not been submitted." : ""}` });
        if (!newerInput) {
          setShowReschedule(false);
          setConfirmCancel(false);
        }
      } catch { hold(operation); }
      finally { busyRef.current = false; }
    });
  };
  const reschedule = () => {
    if (busyRef.current || uncertainRef.current) return;
    const start = new Date(newStart);
    if (!Number.isFinite(start.getTime())) { setMsg({ ok: false, text: "Choose a valid date and time. Your input is kept." }); return; }
    const startISO = start.toISOString();
    run("reschedule", () => rescheduleAppointmentAction(appt.id, startISO, notify));
  };

  const details: [string, string | null][] = [
    ["Starts", fmt(appt.startAt)],
    ["Ends", fmt(appt.endAt)],
    ["Duration", appt.durationMin ? `${appt.durationMin} min` : null],
    ["Preference", appt.preferenceType && appt.preferenceType !== "NONE" ? appt.preferenceType : null],
    ["Requires confirmation", appt.requiresConfirmation ? "Yes" : null],
    ["Rescheduled at", fmt(appt.rescheduledAt)],
    ["Previously", fmt(appt.previousStartAt)],
    ["Postponed at", fmt(appt.postponedAt)],
  ];

  return (
    <div className="px-5 py-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-start gap-2 text-base font-medium leading-relaxed">
            <Calendar className="mt-1 size-4 shrink-0 text-muted" />
            {fmt(appt.startAt) ?? "Unscheduled"}
          </div>
          {appt.title && <div className="mt-1 break-words text-sm leading-relaxed text-muted">{appt.title}</div>}
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {appt.assignedTo && (
            <span className="flex min-w-0 items-center gap-2 break-words text-sm text-muted">
              <Avatar name={appt.assignedTo.name} color={appt.assignedTo.avatarColor} size={20} />
              {appt.assignedTo.name.split(" ")[0]}
            </span>
          )}
          <Badge
            color={canceled ? "#dc2626" : scheduled ? "#16a34a" : "#64748b"}
            soft={canceled ? "#fee2e2" : scheduled ? "#dcfce7" : "var(--surface-2)"}
          >
            {(appt.status || "—").toLowerCase()}
          </Badge>
        </div>
      </div>

      {/* All fields */}
      <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-3 text-sm leading-relaxed min-[360px]:grid-cols-2 sm:grid-cols-3">
        {details
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="min-w-0 break-words">
              <div className="text-muted-2">{k}</div>
              <div className="font-medium text-foreground/85">{v}</div>
            </div>
          ))}
      </div>

      {/* Shoot brief (customer, lockbox, special instructions) */}
      {appt.description && (
        <details className="mt-4 rounded-lg bg-surface-2 px-3 py-2 [&_summary]:list-none">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md text-sm font-semibold text-foreground/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            <ChevronDown className="size-4 shrink-0" /> Shoot brief
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/80">
            {cleanBrief(appt.description)}
          </pre>
        </details>
      )}

      {/* Actions */}
      {!canceled && (appt.canReschedule || appt.canCancel) && (
        <div className="mt-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            {appt.canReschedule && (
              <Button variant="secondary"
                disabled={pending || uncertain}
                onClick={() => {
                  setShowReschedule((s) => !s);
                  setConfirmCancel(false);
                }}
              >
                <RefreshCw className="size-4 shrink-0" /> Reschedule
              </Button>
            )}
            {appt.canCancel && !confirmCancel && (
              <Button variant="secondary"
                disabled={pending || uncertain}
                onClick={() => {
                  setConfirmCancel(true);
                  setShowReschedule(false);
                }}
                className="text-danger hover:bg-danger-soft"
              >
                <XCircle className="size-4 shrink-0" /> Cancel shoot
              </Button>
            )}
          </div>

          {/* Reschedule form */}
          {showReschedule && (
            <div className="mt-3 space-y-3 rounded-lg border border-border bg-surface-2 p-3">
              <TextField
                id={`appointment-start-${appt.id}`}
                label="New date & time"
                hint="This field uses your device's local time zone. Appointment times above are shown in Eastern time."
                type="datetime-local"
                value={newStart}
                onChange={(e) => { startRef.current = e.target.value; setNewStart(e.target.value); mirrorInput(); }}
              />
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm leading-relaxed text-muted">
                <input type="checkbox" checked={notify} onChange={(e) => { notifyRef.current = e.target.checked; setNotify(e.target.checked); mirrorInput(); }} className="size-5 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" />
                Notify the customer by email
              </label>
              <Button
                disabled={pending || uncertain || !newStart}
                onClick={reschedule}
              >
                {pending ? <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-4 shrink-0" />}
                Confirm reschedule
              </Button>
            </div>
          )}

          {/* Cancel confirm */}
          {confirmCancel && (
            <div className="mt-3 space-y-3 rounded-lg border border-danger/30 bg-danger-soft p-3">
              <div className="flex items-start gap-2 text-sm font-medium leading-relaxed text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Cancel this shoot in Aryeo? This can&apos;t be undone here.
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm leading-relaxed text-muted">
                <input type="checkbox" checked={notify} onChange={(e) => { notifyRef.current = e.target.checked; setNotify(e.target.checked); mirrorInput(); }} className="size-5 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" />
                Notify the customer by email
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger"
                  disabled={pending || uncertain}
                  onClick={() => run("cancel", () => cancelAppointmentAction(appt.id, notify))}
                >
                  {pending ? <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" /> : <XCircle className="size-4 shrink-0" />}
                  Yes, cancel shoot
                </Button>
                <Button variant="secondary"
                  disabled={pending || uncertain}
                  onClick={() => setConfirmCancel(false)}
                >
                  Keep it
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {msg && (
        <p role={msg.ok ? "status" : "alert"} aria-live={msg.ok ? "polite" : "assertive"} aria-atomic="true" className={`mt-3 text-sm leading-relaxed ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>
      )}

      {/* Raw fields toggle (every field, for completeness) */}
      <Button variant="quiet"
        onClick={() => setShowAll((s) => !s)}
        aria-expanded={showAll}
        aria-controls={`appointment-fields-${appt.id}`}
        className="mt-3 text-muted"
      >
        <Clock className="size-4 shrink-0" /> {showAll ? "Hide" : "All"} appointment fields
      </Button>
      {showAll && (
        <dl id={`appointment-fields-${appt.id}`} className="mt-2 space-y-2 rounded-lg bg-surface-2 p-3 text-sm leading-relaxed">
          {[
            ["Status", appt.status],
            ["Can reschedule", String(appt.canReschedule)],
            ["Can cancel", String(appt.canCancel)],
            ["Preference type", appt.preferenceType],
            ["Requires confirmation", String(appt.requiresConfirmation)],
            ["Start", fmt(appt.startAt)],
            ["End", fmt(appt.endAt)],
            ["Duration (min)", appt.durationMin?.toString() ?? "—"],
            ["Rescheduled at", fmt(appt.rescheduledAt) ?? "—"],
            ["Previous start", fmt(appt.previousStartAt) ?? "—"],
            ["Postponed at", fmt(appt.postponedAt) ?? "—"],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 break-words text-right font-medium text-foreground/80">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
