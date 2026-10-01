"use client";

import { useState, useTransition } from "react";
import { Calendar, Clock, RefreshCw, XCircle, Loader2, AlertTriangle, ChevronDown } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { rescheduleAppointmentAction, cancelAppointmentAction } from "@/app/actions";

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

function fmt(d: string | Date | null, withTime = true) {
  if (!d) return null;
  const date = new Date(d);
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York", // shoots are Eastern
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
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

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        setShowReschedule(false);
        setConfirmCancel(false);
      }
    });

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
                onChange={(e) => setNewStart(e.target.value)}
              />
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm leading-relaxed text-muted">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-5 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" />
                Notify the customer by email
              </label>
              <Button
                disabled={pending || !newStart}
                onClick={() => run(() => rescheduleAppointmentAction(appt.id, new Date(newStart).toISOString(), notify))}
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
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-5 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" />
                Notify the customer by email
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger"
                  disabled={pending}
                  onClick={() => run(() => cancelAppointmentAction(appt.id, notify))}
                >
                  {pending ? <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" /> : <XCircle className="size-4 shrink-0" />}
                  Yes, cancel shoot
                </Button>
                <Button variant="secondary"
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
