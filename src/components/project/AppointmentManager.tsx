"use client";

import { useState, useTransition } from "react";
import { Calendar, Clock, RefreshCw, XCircle, Loader2, AlertTriangle, ChevronDown } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
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
  const [notify, setNotify] = useState(true);
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Calendar className="size-4 text-muted" />
            {fmt(appt.startAt) ?? "Unscheduled"}
          </div>
          {appt.title && <div className="mt-0.5 truncate text-xs text-muted">{appt.title}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {appt.assignedTo && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
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
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
        {details
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <div className="text-muted-2">{k}</div>
              <div className="font-medium text-foreground/85">{v}</div>
            </div>
          ))}
      </div>

      {/* Shoot brief (customer, lockbox, special instructions) */}
      {appt.description && (
        <details className="mt-3 rounded-lg bg-surface-2 px-3 py-2 [&_summary]:list-none">
          <summary className="flex cursor-pointer items-center gap-1 text-xs font-semibold text-foreground/80">
            <ChevronDown className="size-3.5" /> Shoot brief
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground/80">
            {cleanBrief(appt.description)}
          </pre>
        </details>
      )}

      {/* Actions */}
      {!canceled && (appt.canReschedule || appt.canCancel) && (
        <div className="mt-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            {appt.canReschedule && (
              <button
                onClick={() => {
                  setShowReschedule((s) => !s);
                  setConfirmCancel(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
              >
                <RefreshCw className="size-3.5" /> Reschedule
              </button>
            )}
            {appt.canCancel && !confirmCancel && (
              <button
                onClick={() => {
                  setConfirmCancel(true);
                  setShowReschedule(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft"
              >
                <XCircle className="size-3.5" /> Cancel shoot
              </button>
            )}
          </div>

          {/* Reschedule form */}
          {showReschedule && (
            <div className="mt-3 space-y-2 rounded-lg border bg-surface-2 p-3">
              <label className="text-xs font-medium">New date &amp; time</label>
              <input
                type="datetime-local"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="w-full rounded-lg border bg-surface px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                Notify the customer by email
              </label>
              <button
                disabled={pending || !newStart}
                onClick={() => run(() => rescheduleAppointmentAction(appt.id, new Date(newStart).toISOString(), notify))}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                Confirm reschedule
              </button>
            </div>
          )}

          {/* Cancel confirm */}
          {confirmCancel && (
            <div className="mt-3 space-y-2 rounded-lg border border-danger/30 bg-danger-soft p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-danger">
                <AlertTriangle className="size-3.5" /> Cancel this shoot in Aryeo? This can&apos;t be undone here.
              </div>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                Notify the customer by email
              </label>
              <div className="flex gap-2">
                <button
                  disabled={pending}
                  onClick={() => run(() => cancelAppointmentAction(appt.id, notify))}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <XCircle className="size-3.5" />}
                  Yes, cancel shoot
                </button>
                <button
                  onClick={() => setConfirmCancel(false)}
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-surface"
                >
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {msg && (
        <p className={`mt-2 text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>
      )}

      {/* Raw fields toggle (every field, for completeness) */}
      <button
        onClick={() => setShowAll((s) => !s)}
        className="mt-3 inline-flex items-center gap-1 text-[11px] text-muted-2 hover:text-foreground"
      >
        <Clock className="size-3" /> {showAll ? "Hide" : "All"} appointment fields
      </button>
      {showAll && (
        <dl className="mt-2 space-y-0.5 rounded-lg bg-surface-2 p-3 text-[11px]">
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
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-muted-2">{k}</dt>
              <dd className="text-right font-medium text-foreground/80">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
