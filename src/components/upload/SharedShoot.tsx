"use client";

import { useMemo, useState, useTransition } from "react";
import { Users, History, Pencil, Plus, Trash2, AlertTriangle, ChevronDown } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { addSharedInstruction, editSharedInstruction, removeSharedInstruction } from "@/app/upload/sharedActions";
import {
  SERVICE_LABEL, SHARED_NOTE_CAP, changedSince, contributionState, coveredByJobHandoff, findConflicts, halfOfService, lastSubmit,
  type Contribution, type ServiceKey, type SharedNote,
} from "@/lib/sharedShootCore";
import { Initials, StatusChip } from "@/components/upload/portalUi";

// ---------------------------------------------------------------------------
// THE SHARED SHOOT ON THE UPLOAD PAGE (Oct 23 2026). Two pieces:
//   · ShootHandoffCard: who is on the shoot, what each says they captured and
//     where their part stands, and what the others filled in (their part, and
//     the job's submitted answers they handed off). Read-only.
//   · SharedInstructions: the editor's instructions both photographers write
//     together. Each entry shows who wrote it and who changed it last, keeps
//     every earlier version, and a save against a version somebody else has
//     already replaced is refused with theirs (lib/sharedShoot). Where two
//     entries point opposite ways, it says so; the editor's brief does too.
// ---------------------------------------------------------------------------

export type RosterView = { memberId: string; name: string; via: string };
export type OthersAnswers = {
  photos: { handedOffBy: string | null; atISO: string | null; lines: string[] } | null;
  video: { handedOffBy: string | null; atISO: string | null; lines: string[] } | null;
};

const services = (list: ServiceKey[]) => (list.length ? list.map((s) => SERVICE_LABEL[s]).join(", ") : "Nothing ticked yet");

export function ShootHandoffCard({
  members, contributions, meId, floorISO, answers, wholeDoneISO, crewSlot, visits,
}: {
  members: RosterView[];
  contributions: Contribution[];
  meId: string | null;
  floorISO: string | null;
  answers: OthersAnswers;
  wholeDoneISO: string | null;
  crewSlot?: React.ReactNode;
  /** each member's own visit (lib/sharedShootCore memberVisits) */
  visits?: Record<string, string | null>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const floor = floorISO ? new Date(floorISO) : null;
  const byId = new Map(contributions.map((c) => [c.memberId, c]));
  // Somebody with a part on file who is no longer on the roster keeps it (a reassignment never deletes work).
  const former = contributions.filter((c) => !members.some((m) => m.memberId === c.memberId));
  const rows = [...members.map((m) => ({ ...m, former: false })), ...former.map((c) => ({ memberId: c.memberId, name: c.name, via: "former", former: true }))];
  return (
    <section data-shoot-handoff className="rounded-2xl border bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><Users aria-hidden className="size-4.5" /></span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Shoot handoff</h2>
          <p className="text-xs text-muted">{members.length} photographers assigned · each submits their own work</p>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {rows.map((m) => {
          const c = byId.get(m.memberId) ?? null;
          // No part on file and the whole wrap-up covered them: handed off on
          // the job's page (before the revamp, or by the office), not "Not
          // started" (lib/sharedShootCore coveredByJobHandoff).
          const legacy = !c && coveredByJobHandoff(wholeDoneISO, visits?.[m.memberId] ?? null);
          const st = legacy ? "submitted" : contributionState(c, floor);
          const last = lastSubmit(c, floor);
          const mine = m.memberId === meId;
          return (
            <li key={m.memberId} data-roster-member={m.memberId} className={cn("rounded-xl border px-3 py-2.5", mine ? "border-brand/40 bg-brand-soft/20" : "border-border bg-surface-2/40")}>
              <div className="flex items-start gap-2.5">
                <Initials name={m.name} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{m.name}{mine && <span className="font-normal text-muted"> · you</span>}{m.former && <span className="font-normal text-muted"> · no longer assigned</span>}</p>
                  <p className="text-xs text-muted">{legacy ? "Handed off on the job's page" : services(c?.captured ?? [])}{c?.videoDrone ? " (with drone footage)" : ""}</p>
                </div>
                <StatusChip tone={st === "submitted" ? "ok" : st === "in_progress" ? "warn" : "muted"}>
                  {st === "submitted" ? "Submitted" : st === "in_progress" ? "In progress" : "Not started"}
                </StatusChip>
              </div>
              {!mine && (
                <>
                  <button
                    type="button"
                    onClick={() => setOpen(open === m.memberId ? null : m.memberId)}
                    aria-expanded={open === m.memberId}
                    className="mt-1 inline-flex min-h-11 w-full items-center justify-center gap-1 rounded-lg border border-brand/40 text-sm font-medium text-brand hover:bg-brand-soft/30"
                  >
                    {open === m.memberId ? "Hide" : "View"} {m.name.split(/\s+/)[0]}&rsquo;s contribution
                    <ChevronDown aria-hidden className={cn("size-4 transition-transform", open === m.memberId && "rotate-180")} />
                  </button>
                  {open === m.memberId && (
                    <div data-contribution-of={m.memberId} className="mt-2 space-y-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
                      <p><span className="text-muted">Captured:</span> {services(c?.captured ?? [])}</p>
                      <p><span className="text-muted">Says uploaded:</span> {services(c?.uploaded ?? [])}</p>
                      <p><span className="text-muted">Submitted:</span> {last ? `${etDateTime(last.atISO)} (${last.scope === "all" ? "everything" : last.scope === "part" ? "their part" : last.scope})` : "not yet"}</p>
                      {(["photos", "video"] as const).map((h) => {
                        const a = answers[h];
                        if (!a || !a.lines.length) return null;
                        // The job's answers for a half sit under the person who
                        // did that half (their own part, or the name that handed
                        // it off); under everyone only when nobody claims it.
                        const claims = (x: Contribution | null | undefined) => !!x?.captured.some((k) => halfOfService(k) === h);
                        const first = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
                        const byName = !!a.handedOffBy && first(a.handedOffBy) === first(m.name);
                        const anyone = contributions.some(claims) || rows.some((r) => !!a.handedOffBy && first(a.handedOffBy) === first(r.name));
                        if (!claims(c) && !byName && anyone) return null;
                        return (
                          <div key={h} className="border-t border-border pt-1.5">
                            <p className="text-xs font-semibold">{h === "photos" ? "Photo details" : "Video details"}{a.handedOffBy ? ` · handed off by ${a.handedOffBy}` : ""}{a.atISO ? `, ${etDateTime(a.atISO)}` : ""}</p>
                            <ul className="mt-0.5 space-y-0.5 text-foreground/85">{a.lines.map((l, i) => <li key={i} className="whitespace-pre-wrap">{l}</li>)}</ul>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2.5 text-xs text-muted">
        {wholeDoneISO ? `Every part is in (${etDateTime(wholeDoneISO)}). ` : ""}Shared automatically from the shoot&rsquo;s assignments. One person&rsquo;s submit never marks another&rsquo;s part done.
      </p>
      {crewSlot}
    </section>
  );
}

export function SharedNoteRow({
  projectId, note, onSaved, viewerName, handoffISO, blocked,
}: {
  projectId: string;
  note: SharedNote;
  onSaved: (n: SharedNote) => void;
  viewerName: string;
  handoffISO: string | null;
  blocked: boolean;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "add">("view");
  const [text, setText] = useState(note.text);
  const [base, setBase] = useState(note.version);
  const [showHistory, setShowHistory] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [theirs, setTheirs] = useState<SharedNote | null>(null);
  const [pending, start] = useTransition();
  const changedAfter = !!handoffISO && Date.parse(note.lastAtISO) > Date.parse(handoffISO);

  const save = (remove = false) => start(async () => {
    const body = mode === "add" ? `${note.text}\n+ ${viewerName}: ${text.trim()}` : text;
    const r = remove
      ? await removeSharedInstruction(projectId, note.entryId, base).catch(() => ({ ok: false, message: "Couldn't save that. Try again.", current: null }))
      : await editSharedInstruction(projectId, note.entryId, base, body).catch(() => ({ ok: false, message: "Couldn't save that. Try again.", current: null }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok && "note" in r && r.note) { onSaved(r.note); setMode("view"); setTheirs(null); setText(r.note.text); setBase(r.note.version); }
    // A stale save: nothing was written. Their version is shown; the typed words stay in the box.
    else if (!r.ok && r.current) { setTheirs(r.current); onSaved(r.current); setBase(r.current.version); }
  });

  if (note.deleted) return null;
  return (
    <li data-shared-note={note.entryId} className="rounded-xl border border-border bg-surface-2/50 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Initials name={note.authorName} size={30} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">
            <span className="font-semibold text-foreground">{note.authorName}</span> · saved {etDateTime(note.createdAtISO)}
            {note.version > 1 && <> · changed by {note.lastByName}, {etDateTime(note.lastAtISO)}</>}
            {changedAfter && <> · <span className="font-semibold text-warning">changed after the handoff</span></>}
          </p>
          {mode === "view" && <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground/90">{note.text}</p>}
        </div>
      </div>
      {mode !== "view" && (
        <div className="mt-2">
          {mode === "add" && <p className="mb-1 whitespace-pre-wrap rounded-lg bg-surface px-2.5 py-1.5 text-sm text-foreground/80">{note.text}</p>}
          <textarea
            aria-label={mode === "add" ? "What to add to this instruction" : "Edit this instruction"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={SHARED_NOTE_CAP}
            rows={3}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm"
          />
          {theirs && (
            <div role="alert" className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
              <p className="font-semibold text-warning">{theirs.lastByName} changed this; here&rsquo;s {theirs.lastByName === viewerName ? "the newer" : "their"} version:</p>
              <p className="mt-1 whitespace-pre-wrap text-foreground/90">{theirs.deleted ? "(removed)" : theirs.text}</p>
              <p className="mt-1 text-xs text-muted">Nothing of yours was saved. Your words are still in the box: change them to fit, then save again.</p>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={pending || !text.trim()} onClick={() => save(false)} className="min-h-11 rounded-lg bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
              {pending ? "Saving…" : mode === "add" ? "Add to this" : "Save"}
            </button>
            <button type="button" onClick={() => { setMode("view"); setText(note.text); setTheirs(null); setMsg(null); }} className="min-h-11 rounded-lg px-3 text-sm text-muted hover:text-foreground">Cancel</button>
            {mode === "edit" && (
              <button type="button" disabled={pending} onClick={() => save(true)} className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm text-danger hover:bg-danger/10 disabled:opacity-50">
                <Trash2 aria-hidden className="size-4" /> Remove
              </button>
            )}
          </div>
        </div>
      )}
      {mode === "view" && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {!blocked && (
            <>
              <button type="button" onClick={() => { setMode("edit"); setText(note.text); setBase(note.version); setMsg(null); }} className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2">
                <Pencil aria-hidden className="size-3.5" /> Edit
              </button>
              <button type="button" onClick={() => { setMode("add"); setText(""); setBase(note.version); setMsg(null); }} className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-brand/40 px-3 text-sm font-medium text-brand hover:bg-brand-soft/30">
                <Plus aria-hidden className="size-3.5" /> Add to this
              </button>
            </>
          )}
          {note.history.length > 1 && (
            <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory} className="inline-flex min-h-11 items-center gap-1 px-2 text-xs font-medium text-muted hover:text-foreground">
              <History aria-hidden className="size-3.5" /> {showHistory ? "Hide" : "View"} change history ({note.history.length})
            </button>
          )}
        </div>
      )}
      {showHistory && (
        <ol data-note-history className="mt-1.5 space-y-1 border-l-2 border-border pl-3 text-xs">
          {[...note.history].reverse().map((h) => (
            <li key={h.version}>
              <span className="font-semibold">v{h.version}</span> · {h.byName} · {etDateTime(h.atISO)}{h.deleted ? " · removed" : ""}
              {!h.deleted && <p className="whitespace-pre-wrap text-foreground/80">{h.text}</p>}
            </li>
          ))}
        </ol>
      )}
      {msg && !theirs && <p role="status" className={cn("mt-1 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </li>
  );
}

export function SharedInstructions({
  projectId, initial, viewerName, handoffISO, blocked, requests = [],
}: {
  projectId: string;
  initial: SharedNote[];
  viewerName: string;
  /** the job's first handoff: an entry changed after it is marked */
  handoffISO: string | null;
  /** a "view as" preview: read-only */
  blocked: boolean;
  /** the agent's requests, checked against the entries for opposite instructions */
  requests?: { id: string; text: string; source: string }[];
}) {
  const [notes, setNotes] = useState(initial);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const live = notes.filter((n) => !n.deleted);
  const conflicts = useMemo(
    () => findConflicts([
      ...live.map((n) => ({ id: n.entryId, who: n.lastByName, text: n.text, source: "instruction" })),
      ...requests.map((r) => ({ id: `req:${r.id}`, who: "the agent's request", text: r.text, source: r.source })),
    ]).filter((c) => c.a.source === "instruction" || c.b.source === "instruction"),
    [live, requests],
  );
  const after = changedSince(live, handoffISO);
  const put = (n: SharedNote) => setNotes((all) => (all.some((x) => x.entryId === n.entryId) ? all.map((x) => (x.entryId === n.entryId ? n : x)) : [...all, n]));
  const add = () => start(async () => {
    const r = await addSharedInstruction(projectId, text).catch(() => ({ ok: false, message: "Couldn't save that. Try again.", note: null }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok && r.note) { put(r.note); setText(""); }
  });
  return (
    <div data-shared-instructions>
      <p className="text-sm font-semibold">Shared instructions for the editor</p>
      <p className="mt-0.5 text-[13px] text-muted">Either photographer can add, edit or add to these. Each keeps its author and every earlier version.</p>
      {conflicts.length > 0 && (
        <div role="alert" data-instruction-conflicts={conflicts.length} className="mt-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
          <p className="flex items-center gap-1.5 font-semibold text-warning"><AlertTriangle aria-hidden className="size-4" /> These point opposite ways. Agree on one; the editor sees both until you do.</p>
          <ul className="mt-1 space-y-1">
            {conflicts.map((c, i) => <li key={i}>&ldquo;{c.a.text}&rdquo; ({c.a.who}) vs &ldquo;{c.b.text}&rdquo; ({c.b.who})</li>)}
          </ul>
        </div>
      )}
      {after.length > 0 && <p className="mt-2 text-xs text-warning">{after.length} changed after the first handoff; the editor&rsquo;s brief marks {after.length === 1 ? "it" : "them"}.</p>}
      <ul className="mt-2 space-y-2">
        {live.map((n) => <SharedNoteRow key={n.entryId} projectId={projectId} note={n} onSaved={put} viewerName={viewerName} handoffISO={handoffISO} blocked={blocked} />)}
      </ul>
      {!blocked && (
        <div className="mt-2.5">
          <label htmlFor="shared-instruction-new" className="text-[13px] font-medium text-muted">Add instructions or fill a missing detail</label>
          <textarea
            id="shared-instruction-new"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={SHARED_NOTE_CAP}
            rows={2}
            placeholder="e.g. Use the wide patio shot before the pool close-ups"
            className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-base outline-none focus:border-brand sm:text-sm"
          />
          <button type="button" disabled={pending || !text.trim()} onClick={add} className="mt-1.5 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">
            <Plus aria-hidden className="size-4" /> {pending ? "Saving…" : "Add instruction"}
          </button>
        </div>
      )}
      {msg && <p role="status" aria-live="polite" className={cn("mt-1 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}
