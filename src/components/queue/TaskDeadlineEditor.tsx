"use client";

import { useEffect, useRef, useState } from "react";
import { readTaskDeadline, setTaskDeadline } from "@/app/actions";
import { etDateTime, etDayKey } from "@/lib/datetime";
import { reconcileTaskDeadline } from "@/lib/taskDeadline";
import { Button } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { SaveStatus, type SaveState } from "@/components/ui/SaveStatus";

const dayOf = (value: string | null) => value ? etDayKey(new Date(value)) : "";

export function TaskDeadlineEditor({ taskId, title, dueAt, editable: allowed, disabled, onBusyChange, onConfirmed }: {
  taskId: string; title: string; dueAt: string | null; editable: boolean; disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onConfirmed: (dueAt: string | null) => void;
}) {
  const [baseline, setBaseline] = useState(dueAt);
  const [draft, setDraft] = useState(dayOf(dueAt));
  const [pending, setPending] = useState<"save" | "check" | null>(null);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [editable, setEditable] = useState(true);
  const [feedback, setFeedback] = useState<{ state: SaveState; message: string } | null>(null);
  const busyRef = useRef(false);
  const submittedRef = useRef(draft);
  // A server refresh may move the date, but must not erase a user's newer
  // input or unlock an uncertain save. This card remains mounted in its drawer.
  useEffect(() => {
    if (dueAt === baseline || needsCheck || busyRef.current) return;
    setBaseline(dueAt);
    setDraft((current) => current === dayOf(baseline) ? dayOf(dueAt) : current);
  }, [dueAt, baseline, needsCheck]);
  const busy = disabled || pending !== null;
  const mayEdit = allowed && editable;
  const dirty = draft !== dayOf(baseline);
  const begin = (kind: "save" | "check") => {
    if (busyRef.current || disabled) return false;
    busyRef.current = true; setPending(kind); onBusyChange(true); return true;
  };
  const finish = () => { busyRef.current = false; setPending(null); onBusyChange(false); };
  const save = async () => {
    if (needsCheck || !mayEdit || !dirty || !begin("save")) return;
    const submitted = draft; submittedRef.current = submitted;
    setFeedback({ state: "saving", message: submitted ? `Saving ${submitted} for 5pm Eastern.` : "Clearing this task's date." });
    try {
      const result = await setTaskDeadline(taskId, submitted, baseline);
      if (result.ok && result.dueAt !== undefined) {
        setBaseline(result.dueAt); onConfirmed(result.dueAt);
        setFeedback({ state: "saved", message: result.message });
      } else {
        setNeedsCheck(result.needsRefresh === true || result.ok);
        setFeedback({ state: "error", message: result.message });
      }
    } catch {
      setNeedsCheck(true);
      setFeedback({ state: "error", message: "The save response was lost. Your chosen date is kept. Check the current task date before trying again." });
    } finally { finish(); }
  };
  const check = async () => {
    if (!needsCheck || !begin("check")) return;
    setFeedback({ state: "info", message: "Checking this task's current date…" });
    try {
      const result = await readTaskDeadline(taskId);
      if (!result.ok) { setFeedback({ state: "error", message: result.message }); return; }
      const receipt = reconcileTaskDeadline(result, submittedRef.current);
      setBaseline(result.dueAt); onConfirmed(result.dueAt); setEditable(result.editable); setNeedsCheck(false);
      setFeedback({ state: receipt.matches ? "saved" : "info", message: receipt.message });
    } catch { setFeedback({ state: "error", message: "The current task date could not be checked. Your chosen date is kept; retry this check before saving." }); }
    finally { finish(); }
  };
  return (
    <section data-task-deadline className="mt-3 space-y-3 rounded-xl border border-border bg-surface-2/40 p-3">
      <p className="text-sm text-muted">Current task date: {baseline ? etDateTime(baseline) : "No due date"}.</p>
      <TextField id={`task-deadline-${taskId}`} label={`Due date for ${title}`} type="date" value={draft} disabled={busy || needsCheck || !mayEdit}
        data-task-deadline-input hint="This ad hoc task uses 5pm Eastern on the chosen date. Clearing the field removes its date."
        onChange={(event) => { if (busyRef.current || needsCheck || !mayEdit) return; setDraft(event.target.value); setFeedback(null); }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || needsCheck || !mayEdit || !dirty} busy={pending === "save"} busyLabel="Saving date…" onClick={() => { void save(); }}>Save task date</Button>
        <Button variant="quiet" disabled={busy || needsCheck || !mayEdit || !draft} onClick={() => { setDraft(""); setFeedback(null); }}>Clear date</Button>
        {needsCheck && <Button variant="secondary" disabled={busy} busy={pending === "check"} busyLabel="Checking date…" onClick={() => { void check(); }}>Check current task date</Button>}
      </div>
      {!mayEdit && <p className="text-sm text-muted">This task is now closed or follows a workflow deadline. Its date cannot be changed here.</p>}
      {feedback ? <SaveStatus {...feedback} /> : dirty ? <SaveStatus state="dirty" message="Save to apply this date to the task." /> : null}
    </section>
  );
}
