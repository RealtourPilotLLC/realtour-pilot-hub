"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { loadNotifySchedules, saveNotifySchedule } from "@/app/settings/actions";
import {
  OVERNIGHT_FROM,
  OVERNIGHT_TO,
  WEEKDAY_NAMES,
  clockLabel,
  describeQuietWindows,
  parseQuietWindows,
  quietWindowProblem,
  type NotifyScheduleRow,
  type QuietWindow,
} from "@/lib/notifyPrefDefaults";
import { cn } from "@/lib/utils";

// THE NOTIFICATION SCHEDULE (Jordan, Sep 26 2026: "I just don't want
// notifications on Saturdays, until 7:30pm. Implement in settings a setting for
// controlling notification timing by day and time.")
//
// One block per active person: their quiet windows (weekday + from/to, Eastern),
// the plain sentence of what that means, what is waiting for them right now,
// and a Save of their own — each person is their own store row, so saving
// Kyle's can never overwrite Jordan's, and a tab that went stale is refused by
// the server rather than silently winning. Loaded on its own (the house rule on
// this page: one card's read must not hold the others up).

type Loaded = { rows: NotifyScheduleRow[]; canEditAll: boolean };

const toMinutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

function whenLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(d).replace(",", "");
}

export function NotificationSchedule() {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  // The server's answer to the last save, per person — kept up here because a
  // save remounts that person's block (see the key below).
  const [notes, setNotes] = useState<Record<string, string>>({});
  useEffect(() => {
    loadNotifySchedules().then(setData).catch(() => setFailed(true));
  }, []);

  // #notification-schedule: a link to Jordan's schedule lands on this block
  // inside Internal alerts (Settings → Communication), not the top of the card.
  return (
    <div id="notification-schedule" className="scroll-mt-28 rounded-lg border border-border p-3">
      <p className="text-sm font-semibold">Notification schedule — quiet time, per person</p>
      <p className="text-[13px] text-muted">
        Inside someone&rsquo;s quiet time the bell in the hub still rings at once. Their texts and Slack messages wait, and
        arrive together when it ends — once, oldest first. Nothing is dropped. Times are Eastern.
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted-2">
        For everyone: no texts between {clockLabel(OVERNIGHT_FROM)} and {clockLabel(OVERNIGHT_TO)}, and an urgent page to
        the on-call person overnight waits until {clockLabel(OVERNIGHT_TO)} (the ops channel is told at once). People with no schedule of their own also follow the office rota —
        routine work notices by text raised on a Saturday or Sunday wait for Monday 9 AM. Saving a schedule for someone
        replaces that weekend rule with their own windows.
      </p>
      {failed ? (
        <p className="mt-2 text-[13px] text-muted">The schedules could not be read just now — reload to try again. Nothing about who gets notified has changed.</p>
      ) : !data ? (
        <p className="mt-2 text-[13px] text-muted"><Loader2 className="mr-1.5 inline size-3.5 animate-spin" />Loading schedules…</p>
      ) : data.rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">Your login isn&rsquo;t linked to a roster row, so there is no schedule to show.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {data.rows.map((row) => (
            // Keyed on the stored stamp: a save hands back a fresh row, and the
            // block starts again from what the server now holds.
            <PersonSchedule
              key={`${row.teamMemberId}:${row.setAt ?? ""}`}
              row={row}
              note={notes[row.teamMemberId] ?? null}
              onSaved={(next, message) => {
                setNotes((n) => ({ ...n, [next.teamMemberId]: message }));
                setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.teamMemberId === next.teamMemberId ? next : r)) } : d));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PersonSchedule({ row, note, onSaved }: { row: NotifyScheduleRow; note: string | null; onSaved: (row: NotifyScheduleRow, message: string) => void }) {
  const first = row.name.split(/\s+/)[0];
  const [windows, setWindows] = useState<QuietWindow[]>(row.windows);
  const [touched, setTouched] = useState(false);
  const [day, setDay] = useState(6);
  const [from, setFrom] = useState("00:00");
  const [to, setTo] = useState("19:30");
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(note);

  const dirty = touched && JSON.stringify(windows) !== JSON.stringify(row.windows);
  // An emptied list is a real answer ("no quiet time, weekends included"), so
  // it only counts as a change once the person has actually touched it.
  const dirtyEmpty = touched && windows.length === 0 && row.source !== "saved";

  const fromMin = toMinutes(from);
  const toMinRaw = toMinutes(to);
  // "00:00" as the END means midnight — the end of that day.
  const toMin = toMinRaw === 0 ? 1440 : toMinRaw;
  const draft = fromMin == null || toMin == null ? null : { day, from: fromMin, to: toMin };
  const problem = draft ? quietWindowProblem(draft) : "Give it a start and an end time.";

  const add = () => {
    if (!draft || problem) return;
    const merged = parseQuietWindows([...windows, draft]);
    if (!merged) return;
    setWindows(merged);
    setTouched(true);
    setMsg(null);
  };
  const remove = (i: number) => {
    setWindows((ws) => ws.filter((_, j) => j !== i));
    setTouched(true);
    setMsg(null);
  };
  const save = (next: QuietWindow[] | null) =>
    start(async () => {
      const res = await saveNotifySchedule(row.teamMemberId, next, row.setAt).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      setMsg(res.message);
      if (res.ok && "row" in res && res.row) onSaved(res.row, res.message);
    });

  const sourceChip =
    row.source === "saved" ? "saved" : row.source === "preset" ? "Jordan’s preset" : "not set — office rota";
  const heldWords =
    row.held.texts + row.held.dms > 0
      ? `Waiting now: ${[
          row.held.texts ? `${row.held.texts} text${row.held.texts === 1 ? "" : "s"}` : null,
          row.held.dms ? `${row.held.dms} Slack message${row.held.dms === 1 ? "" : "s"}` : null,
        ].filter(Boolean).join(" and ")}${row.held.nextAt ? ` — first goes ${whenLabel(row.held.nextAt)}` : ""}.`
      : null;

  return (
    <div className="rounded-lg border border-border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{row.name}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", row.source === "none" ? "bg-surface-2 text-muted" : "bg-brand/10 text-brand")}>{sourceChip}</span>
      </div>
      <p className="mt-1 text-[13px]">{touched ? describeQuietWindows(first, windows) : row.summary}</p>
      {heldWords && <p className="text-[12px] text-warning">{heldWords}</p>}

      {windows.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {windows.map((w, i) => (
            <li key={`${w.day}-${w.from}-${w.to}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[12px]">
              {WEEKDAY_NAMES[w.day]} {clockLabel(w.from)}–{clockLabel(w.to)}
              <button type="button" onClick={() => remove(i)} aria-label={`Remove ${WEEKDAY_NAMES[w.day]} ${clockLabel(w.from)} to ${clockLabel(w.to)}`} className="rounded-full p-0.5 text-muted hover:bg-surface hover:text-foreground">
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <span className="text-[13px] text-muted">Quiet</span>
        <select value={day} onChange={(e) => setDay(Number(e.target.value))} aria-label={`Day for ${first}'s quiet time`} className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand">
          {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
        <span className="text-[13px] text-muted">from</span>
        <input type="time" step={900} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand" />
        <span className="text-[13px] text-muted">to</span>
        <input type="time" step={900} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To (00:00 means midnight)" className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand" />
        <button type="button" onClick={add} disabled={!!problem} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50">
          <Plus className="size-3.5" /> Add
        </button>
        {problem && (from || to) && <span className="w-full text-[12px] text-warning">{problem}</span>}
        <span className="w-full text-[11px] text-muted-2">An end of 00:00 means midnight. Overnight quiet is two windows — the evening, then the next morning; they join up.</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Its own Save button, not OperatingRules' SaveRow: that file renders
            this card, and importing back from it would make the two modules a cycle. */}
        <button
          type="button"
          disabled={busy}
          onClick={() => (dirty || dirtyEmpty ? save(windows) : setMsg("Nothing to save — add or remove a window first."))}
          className="mt-3 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save {first}&rsquo;s schedule
        </button>
        {windows.length > 0 && (
          <button type="button" onClick={() => { setWindows([]); setTouched(true); setMsg(null); }} className="mt-3 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2">
            No quiet time
          </button>
        )}
        {row.source === "saved" && (
          <button type="button" disabled={busy} onClick={() => save(null)} className="mt-3 inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50" title={row.isOwner ? "Back to the preset: Saturday until 7:30 PM" : "Back to no schedule of their own — the office rota"}>
            <RotateCcw className="size-3.5" /> {row.isOwner ? "Back to the preset" : "Back to the office rota"}
          </button>
        )}
      </div>
      {msg && <p className="mt-1.5 text-[13px] font-medium text-muted">{msg}</p>}
      {row.setBy && row.setAt && (
        <p className="mt-1 text-[11px] text-muted-2">Last changed by {row.setBy} · {whenLabel(row.setAt)}</p>
      )}
    </div>
  );
}
