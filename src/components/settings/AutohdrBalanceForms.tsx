"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { recordAutohdrReading, saveAutohdrSettings } from "@/app/settings/autohdr/actions";

// Kyle's Monday reading, and (owner only) who checks, the alert threshold and
// the credits-per-photo rate. Empty boxes stay unset — unset is a real answer.

export function AutohdrReadingForm() {
  const [pending, start] = useTransition();
  const [credits, setCredits] = useState("");
  const [dollars, setDollars] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const r = await recordAutohdrReading({ credits: credits || null, dollars: dollars || null, note: note || null });
            setMsg({ ok: r.ok, text: r.message });
            if (r.ok) { setCredits(""); setDollars(""); setNote(""); }
          } catch (err) {
            setMsg({ ok: false, text: err instanceof Error ? err.message : "That didn't save." });
          }
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">Credits left
          <input value={credits} onChange={(e) => setCredits(e.target.value)} inputMode="numeric" placeholder="e.g. 420" className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-muted">Dollar balance (if shown)
          <input value={dollars} onChange={(e) => setDollars(e.target.value)} inputMode="decimal" placeholder="optional" className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
        </label>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
      <button type="submit" disabled={pending || (!credits && !dollars)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
        {pending && <Loader2 className="size-3.5 animate-spin" />} Record reading
      </button>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
    </form>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function AutohdrSettingsForm({
  initial,
  people,
}: {
  initial: { checkOwnerKey: string | null; checkWeekday: number; thresholdCredits: number | null; thresholdDollars: number | null; creditsPerPhoto: number | null };
  people: { key: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [owner, setOwner] = useState(initial.checkOwnerKey ?? "");
  const [day, setDay] = useState(initial.checkWeekday);
  const [tc, setTc] = useState(initial.thresholdCredits?.toString() ?? "");
  const [td, setTd] = useState(initial.thresholdDollars?.toString() ?? "");
  const [cpp, setCpp] = useState(initial.creditsPerPhoto?.toString() ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const r = await saveAutohdrSettings({ checkOwnerKey: owner || null, checkWeekday: day, thresholdCredits: tc || null, thresholdDollars: td || null, creditsPerPhoto: cpp || null });
            setMsg({ ok: r.ok, text: r.message });
          } catch (err) {
            setMsg({ ok: false, text: err instanceof Error ? err.message : "That didn't save." });
          }
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">Weekly check goes to
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm">
            <option value="">Nobody (no weekly task)</option>
            {people.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted">On
          <select value={day} onChange={(e) => setDay(Number(e.target.value))} className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm">
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted">Alert below (credits)
          <input value={tc} onChange={(e) => setTc(e.target.value)} inputMode="numeric" placeholder="not set" className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-muted">…or below ($)
          <input value={td} onChange={(e) => setTd(e.target.value)} inputMode="decimal" placeholder="not set" className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-muted sm:col-span-2">Credits per finished photo (for the estimate)
          <input value={cpp} onChange={(e) => setCpp(e.target.value)} inputMode="decimal" placeholder="unknown" className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
        </label>
      </div>
      <button type="submit" disabled={pending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
        {pending && <Loader2 className="size-3.5 animate-spin" />} Save
      </button>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
    </form>
  );
}
