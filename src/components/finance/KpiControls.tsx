"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  addKpiNote,
  disputeKpiEntry,
  editKpiNote,
  removeKpiNote,
  resolveKpiEntry,
  saveKpiCheckIn,
  saveKpiTerms,
  setKpiDeadline,
} from "@/app/sales/bonusActions";

// ---------------------------------------------------------------------------
// The scorecard's buttons and forms (Oct 22 2026). Every one calls a server
// action in app/sales/bonusActions.ts, which checks who is asking on its own:
// these only decide what to draw. Dispute is the creative's; resolve is the
// owner's (and the creative manager's, for a creative specialist's entry);
// notes, check-ins, agreed deadlines and James's terms are the owner's.
// ---------------------------------------------------------------------------

type Res = { ok: boolean; message: string };
const BTN = "inline-flex min-h-9 items-center justify-center gap-1 rounded-lg px-3 text-xs font-semibold disabled:opacity-50 sm:min-h-8";
const PRIMARY = `${BTN} bg-brand-action text-white`;
const QUIET = `${BTN} border border-border text-muted hover:bg-surface-2`;
const INPUT = "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-base sm:text-sm";
const LABEL = "text-[11px] font-medium text-muted";

function useAction() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<Res | null>(null);
  const run = (fn: () => Promise<Res>, after?: (ok: boolean) => void) =>
    start(async () => {
      const r = await fn().catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." }));
      setMsg(r);
      if (r.ok) router.refresh();
      after?.(r.ok);
    });
  return { busy, msg, run };
}

function Msg({ msg }: { msg: Res | null }) {
  if (!msg) return null;
  return <p className={`text-[11px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>;
}

/** The creative's own "this is wrong" note on one entry. */
export function DisputeButton({ periodKey, entryId }: { periodKey: string; entryId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const { busy, msg, run } = useAction();
  if (msg?.ok) return <Msg msg={msg} />;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={QUIET}>
        Dispute
      </button>
    );
  }
  return (
    <div className="w-full space-y-1.5">
      <label className={LABEL} htmlFor={`d-${entryId}`}>What is wrong with this entry?</label>
      <textarea id={`d-${entryId}`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} className={INPUT} placeholder="e.g. The agent moved the shoot to 6 PM and Jordan agreed the photos could come in the next morning." />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || note.trim().length < 3} onClick={() => run(() => disputeKpiEntry(periodKey, entryId, note))} className={PRIMARY}>
          {busy && <Loader2 className="size-3 animate-spin" />} Send the dispute
        </button>
        <button type="button" onClick={() => setOpen(false)} className={QUIET}>Cancel</button>
      </div>
      <Msg msg={msg} />
    </div>
  );
}

/** Uphold or remove (or, for an advisory entry, count it or leave it out), always with a reason. */
export function ResolveControls({ memberId, periodKey, entryId, status, advisory }: {
  memberId: string; periodKey: string; entryId: string; status: string; advisory: boolean;
}) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(status === "disputed");
  const { busy, msg, run } = useAction();
  if (status === "upheld" || status === "removed") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => run(() => resolveKpiEntry(memberId, periodKey, entryId, "reopen", ""))} className={QUIET}>
          {busy && <Loader2 className="size-3 animate-spin" />} Reopen
        </button>
        <Msg msg={msg} />
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={QUIET}>
        {advisory ? "Decide" : "Review"}
      </button>
    );
  }
  return (
    <div className="w-full space-y-1.5">
      <label className={LABEL} htmlFor={`r-${entryId}`}>Reason (the creative reads this)</label>
      <input id={`r-${entryId}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={INPUT} placeholder={advisory ? "e.g. The brief was theirs and it missed the pool." : "e.g. Agreed by text: photos the next morning."} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => run(() => resolveKpiEntry(memberId, periodKey, entryId, "upheld", reason))} className={PRIMARY}>
          {advisory ? "Count it" : "Uphold"}
        </button>
        <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => run(() => resolveKpiEntry(memberId, periodKey, entryId, "removed", reason))} className={QUIET}>
          {advisory ? "Leave it out" : "Remove it"}
        </button>
        {busy && <Loader2 className="size-3.5 animate-spin text-muted" />}
      </div>
      <Msg msg={msg} />
    </div>
  );
}

export type ManualPerson = {
  memberId: string;
  name: string;
  areas: { key: string; label: string }[];
  jobs: { id: string; label: string }[];
};
export type ManualInitial = { memberId: string; id: string; area: string; day: string; title: string; note: string; points: number; projectId: string | null };

/**
 * A KPI entry added by hand (Jordan, Oct 22 2026: "I should have a page that
 * can add things there too"): who, the day, the category, counts against or
 * for (or a note), a note and an optional job. It shows on their scorecard
 * like the hub's own entries, and they can dispute it. With `initial` it edits.
 */
export function ManualEntryForm({ people, periodKey, minDay, maxDay, defaultDay, initial, onDone }: {
  people: ManualPerson[];
  periodKey: string;
  minDay: string;
  maxDay: string;
  defaultDay: string;
  initial?: ManualInitial | null;
  onDone?: () => void;
}) {
  const [memberId, setMemberId] = useState(initial?.memberId ?? people[0]?.memberId ?? "");
  const person = people.find((p) => p.memberId === memberId) ?? people[0];
  const [area, setArea] = useState(initial?.area ?? person?.areas[0]?.key ?? "");
  const [day, setDay] = useState(initial?.day ?? defaultDay);
  const [effect, setEffect] = useState<"against" | "for" | "note">(initial ? (initial.points < 0 ? "against" : initial.points > 0 ? "for" : "note") : "against");
  const [size, setSize] = useState(String(initial && initial.points ? Math.abs(initial.points) : 5));
  const [title, setTitle] = useState(initial?.title ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [projectId, setProjectId] = useState(initial?.projectId ?? "");
  const { busy, msg, run } = useAction();
  if (!person) return <p className="text-[11px] text-muted">Nobody on the roster is covered by the KPI bonus.</p>;
  const points = effect === "note" ? 0 : (effect === "against" ? -1 : 1) * Math.abs(Math.round(Number(size) || 0));
  const submit = () => {
    const input = { area, day, title, note, points, projectId: projectId || null };
    run(
      () => (initial ? editKpiNote(initial.memberId, periodKey, initial.id, input) : addKpiNote(memberId, periodKey, input)),
      (ok) => {
        if (!ok) return;
        if (!initial) { setTitle(""); setNote(""); setProjectId(""); }
        onDone?.();
      },
    );
  };
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-0.5">
          <span className={LABEL}>Person</span>
          <select value={memberId} disabled={!!initial} onChange={(e) => { setMemberId(e.target.value); setProjectId(""); }} className={INPUT}>
            {people.map((p) => <option key={p.memberId} value={p.memberId}>{p.name}</option>)}
          </select>
        </label>
        <label className="space-y-0.5">
          <span className={LABEL}>Day</span>
          <input type="date" value={day} min={minDay} max={maxDay} onChange={(e) => setDay(e.target.value)} className={INPUT} />
        </label>
        <label className="space-y-0.5">
          <span className={LABEL}>Category</span>
          <select value={area} onChange={(e) => setArea(e.target.value)} className={INPUT}>
            {person.areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-0.5">
          <span className={LABEL}>Effect</span>
          <select value={effect} onChange={(e) => setEffect(e.target.value as typeof effect)} className={INPUT}>
            <option value="against">Counts against (negative)</option>
            <option value="for">Counts for (positive)</option>
            <option value="note">A note only (no points)</option>
          </select>
        </label>
        {effect !== "note" && (
          <label className="space-y-0.5">
            <span className={LABEL}>Points on the category (1 to 25)</span>
            <input type="number" min={1} max={25} step={1} value={size} onChange={(e) => setSize(e.target.value)} className={INPUT} />
          </label>
        )}
        <label className="space-y-0.5">
          <span className={LABEL}>Job (optional)</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={INPUT}>
            <option value="">No job</option>
            {person.jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
          </select>
        </label>
      </div>
      <label className="block space-y-0.5">
        <span className={LABEL}>Title (they read this)</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} className={INPUT} placeholder="e.g. Missed the Tuesday team meeting without telling anyone" />
      </label>
      <label className="block space-y-0.5">
        <span className={LABEL}>Note</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} className={INPUT} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || title.trim().length < 3} onClick={submit} className={PRIMARY}>
          {busy && <Loader2 className="size-3 animate-spin" />} {initial ? "Save the entry" : "Add the entry"}
        </button>
        {initial && onDone && <button type="button" onClick={onDone} className={QUIET}>Cancel</button>}
      </div>
      <Msg msg={msg} />
    </div>
  );
}

/** One hand-added entry in the owner's list: Edit opens the form in place. */
export function ManualEntryRow({ people, periodKey, minDay, maxDay, initial, children }: {
  people: ManualPerson[];
  periodKey: string;
  minDay: string;
  maxDay: string;
  initial: ManualInitial;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <ManualEntryForm people={people} periodKey={periodKey} minDay={minDay} maxDay={maxDay} defaultDay={initial.day} initial={initial} onDone={() => setEditing(false)} />;
  }
  return (
    // Phone layout (Jordan, Oct 28 2026): the buttons wrap under the words instead of squeezing them.
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1 basis-56">{children}</div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={() => setEditing(true)} className={QUIET}>Edit</button>
        <RemoveNoteButton memberId={initial.memberId} periodKey={periodKey} entryId={initial.id} />
      </div>
    </div>
  );
}

export function RemoveNoteButton({ memberId, periodKey, entryId }: { memberId: string; periodKey: string; entryId: string }) {
  const { busy, msg, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={busy} onClick={() => run(() => removeKpiNote(memberId, periodKey, entryId))} className={QUIET}>
        {busy && <Loader2 className="size-3 animate-spin" />} Delete the note
      </button>
      <Msg msg={msg} />
    </span>
  );
}

/** One month's check-in: a score out of 100 per check-in category, and a note. */
export function CheckInForm({ memberId, periodKey, months, areas, saved }: {
  memberId: string;
  periodKey: string;
  months: { key: string; label: string }[];
  areas: { key: string; label: string }[];
  saved: Record<string, { scores: Record<string, number>; note: string }>;
}) {
  const [month, setMonth] = useState(months[months.length - 1]?.key ?? "");
  const cur = saved[month];
  const [scores, setScores] = useState<Record<string, string>>(() => Object.fromEntries(areas.map((a) => [a.key, cur?.scores[a.key] != null ? String(cur.scores[a.key]) : ""])));
  const [note, setNote] = useState(cur?.note ?? "");
  const { busy, msg, run } = useAction();
  const pick = (k: string) => {
    setMonth(k);
    const s = saved[k];
    setScores(Object.fromEntries(areas.map((a) => [a.key, s?.scores[a.key] != null ? String(s.scores[a.key]) : ""])));
    setNote(s?.note ?? "");
  };
  if (!months.length) return <p className="text-[11px] text-muted">The first month of this period has not started.</p>;
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-0.5">
          <span className={LABEL}>Month</span>
          <select value={month} onChange={(e) => pick(e.target.value)} className={INPUT}>
            {months.map((m) => <option key={m.key} value={m.key}>{m.label}{saved[m.key] ? " (saved)" : ""}</option>)}
          </select>
        </label>
        {areas.map((a) => (
          <label key={a.key} className="space-y-0.5">
            <span className={LABEL}>{a.label} (0 to 100)</span>
            <input type="number" min={0} max={100} step={1} value={scores[a.key] ?? ""} onChange={(e) => setScores((s) => ({ ...s, [a.key]: e.target.value }))} className={INPUT} />
          </label>
        ))}
      </div>
      <label className="block space-y-0.5">
        <span className={LABEL}>Check-in note (the creative reads this)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} className={INPUT} placeholder="What went well this month, and the one thing to work on next." />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => run(() => saveKpiCheckIn(memberId, periodKey, month, { scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v === "" ? null : Number(v)])), note }))}
        className={PRIMARY}
      >
        {busy && <Loader2 className="size-3 animate-spin" />} Save the check-in
      </button>
      <Msg msg={msg} />
    </div>
  );
}

/** A deadline agreed for one shoot (Eastern time). Empty both to fall back to the terms. */
export function DeadlineForm({ projectId, half, current, note: initialNote }: { projectId: string; half: "photos" | "video"; current: string; note: string }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(current);
  const [note, setNote] = useState(initialNote);
  const { busy, msg, run } = useAction();
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={QUIET}>
        Agreed a different deadline
      </button>
    );
  }
  return (
    <div className="w-full space-y-1.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-0.5">
          <span className={LABEL}>{half === "photos" ? "Photos" : "Video"} due (Eastern time)</span>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={INPUT} />
        </label>
        <label className="space-y-0.5">
          <span className={LABEL}>What was agreed</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={INPUT} placeholder="e.g. Twilight shoot, photos by noon the next day" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => run(() => setKpiDeadline(projectId, { [half]: at || null, note }))} className={PRIMARY}>
          {busy && <Loader2 className="size-3 animate-spin" />} Save the deadline
        </button>
        <button type="button" onClick={() => setOpen(false)} className={QUIET}>Cancel</button>
      </div>
      <Msg msg={msg} />
    </div>
  );
}


/**
 * Change a person's weights and score bands from a period that has not
 * started yet, onward. Never retroactive: the running period cannot be picked.
 */
export function TermsForm({ personKey, name, categories, cap, periods, current }: {
  personKey: string;
  name: string;
  categories: { key: string; label: string }[];
  cap: number;
  periods: { key: string; label: string }[];
  current: { weights: Record<string, number>; bands: { min: number; amount: number }[] };
}) {
  const [from, setFrom] = useState(periods[0]?.key ?? "");
  const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries(categories.map((c) => [c.key, String(current.weights[c.key] ?? 0)])));
  const [bands, setBands] = useState<{ min: string; amount: string }[]>(() => {
    const rows = current.bands.filter((b) => b.min > 0).map((b) => ({ min: String(b.min), amount: String(b.amount) }));
    while (rows.length < 3) rows.push({ min: "", amount: "" });
    return rows;
  });
  const [note, setNote] = useState("");
  const { busy, msg, run } = useAction();
  const sum = Object.values(weights).reduce((s, v) => s + (Number(v) || 0), 0);
  return (
    <div className="space-y-3">
      <div>
        <div className={LABEL}>Weights (add to 100; now {sum})</div>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          {categories.map((c) => (
            <label key={c.key} className="flex items-center gap-2">
              <input type="number" min={0} max={100} step={1} value={weights[c.key] ?? ""} onChange={(e) => setWeights((w) => ({ ...w, [c.key]: e.target.value }))} className={`${INPUT} w-20 shrink-0`} />
              <span className="text-xs">{c.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className={LABEL}>Score bands (up to ${cap.toLocaleString("en-US")}; a score below the lowest band pays nothing)</div>
        <div className="mt-1 space-y-1.5">
          {bands.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted">Score</span>
              <input type="number" min={1} max={100} value={b.min} onChange={(e) => setBands((rows) => rows.map((r, j) => (j === i ? { ...r, min: e.target.value } : r)))} className={`${INPUT} w-20`} />
              <span className="text-muted">and above pays $</span>
              <input type="number" min={0} max={cap} value={b.amount} onChange={(e) => setBands((rows) => rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))} className={`${INPUT} w-24`} />
            </div>
          ))}
          {bands.length < 5 && (
            <button type="button" onClick={() => setBands((rows) => [...rows, { min: "", amount: "" }])} className={QUIET}>Add a band</button>
          )}
        </div>
      </div>
      <label className="block space-y-0.5">
        <span className={LABEL}>Applies from (a period that has not started)</span>
        <select value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT}>
          {periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </label>
      <label className="block space-y-0.5">
        <span className={LABEL}>Note (what changed, and that {name} was told)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={INPUT} />
      </label>
      <button
        type="button"
        disabled={busy || sum !== 100 || !from}
        onClick={() =>
          run(() =>
            saveKpiTerms(personKey, {
              weights: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Number(v) || 0])),
              bands: [...bands.filter((b) => b.min !== "" && b.amount !== "").map((b) => ({ min: Number(b.min), amount: Number(b.amount) })), { min: 0, amount: 0 }],
              fromPeriodKey: from,
              note,
            }),
          )
        }
        className={PRIMARY}
      >
        {busy && <Loader2 className="size-3 animate-spin" />} Save {name}&rsquo;s change
      </button>
      <Msg msg={msg} />
    </div>
  );
}
