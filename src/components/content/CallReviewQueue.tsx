"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Link2, Mail, Phone } from "lucide-react";
import { Section } from "@/components/ui/Section";
import {
  confirmCallClientAction, ignoreCallAction, setCallMonthAction,
  verifyAliasAction, dismissAliasAction, confirmTranscriptAction, rejectTranscriptAction, retryTranscriptJobAction,
} from "@/app/content/monitoring/actions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE CALL REVIEW QUEUE (spec §20/§26). Three kinds of question the matcher
// refused to answer on its own, each with an explicit, logged resolution:
//
//   · which client was on this call (candidates are RANKED, never chosen);
//   · is this email address really theirs (an alias proposal);
//   · is this document the transcript of that call.
//
// Everything is per-row. There is no "accept all": that is the button that
// files Mike Flatley's call under Gary Mercer Sr and nobody notices for a
// month.
// ---------------------------------------------------------------------------

export type CallUi = {
  id: string; callType: string; status: string; matchState: string; matchNote: string | null; transcriptState: string;
  scheduledStartISO: string | null; clientName: string | null; inviteeEmail: string | null; inviteeName: string | null;
  eventTypeName: string | null; targetMonthKey: string | null; lastError: string | null;
  candidates: { clientId: string; name: string; reason: string }[];
  jobs: { id: string; kind: string; state: string; attempts: number; lastError: string | null; reviewReason: string | null }[];
  transcripts: { id: string; title: string | null; sourceUrl: string | null; matchState: string; recordedAtISO: string | null }[];
};
export type AliasUi = { id: string; clientName: string; email: string; source: string; createdAtISO: string };
export type UnlinkedUi = { id: string; title: string | null; sourceUrl: string | null; recordedAtISO: string | null; candidates: { callRecordId: string; score: number; note: string }[] };

const btn = "rounded-md px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50";
const input = "rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[12px]";
const when = (isoStr: string | null) => (isoStr ? new Date(isoStr).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export function CallReviewQueue({
  calls, aliases, unlinked, clients, monthKeys, isOwner,
}: { calls: CallUi[]; aliases: AliasUi[]; unlinked: UnlinkedUi[]; clients: { id: string; name: string }[]; monthKeys: string[]; isOwner: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const say = (r: { ok: boolean; message: string }) => setNote(`${r.ok ? "" : "Couldn't do that — "}${r.message}`);
  const total = calls.length + aliases.length + unlinked.length;

  return (
    <div className="space-y-4">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">{note}</p>}

      <Section icon={Phone} title="Calls waiting for a person" count={calls.length} tone={calls.length ? "warning" : "default"} flush>
        <div className="divide-y divide-border">
          {calls.length === 0 && (
            <p className="px-5 py-3 text-sm text-success"><CheckCircle2 className="mr-1 inline size-4" />No call is waiting to be identified.</p>
          )}
          {calls.map((c) => <CallRow key={c.id} c={c} clients={clients} monthKeys={monthKeys} isOwner={isOwner} busy={busy} start={start} say={say} />)}
        </div>
      </Section>

      <Section icon={Mail} title="Email addresses proposed as a client's" count={aliases.length} flush
        action={<span className="hidden text-[11px] text-muted-2 sm:inline">a proposal never matches a call until it is verified</span>}>
        <div className="divide-y divide-border">
          {aliases.length === 0 && <p className="px-5 py-3 text-sm text-muted">Nothing proposed.</p>}
          {aliases.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 px-5 py-2 text-[13px]">
              <span className="font-medium">{a.email}</span>
              <span className="text-muted">→ {a.clientName}</span>
              <span className="text-[11px] text-muted-2">from {a.source} · {when(a.createdAtISO)}</span>
              <span className="ml-auto flex gap-1.5">
                <button className={cn(btn, "bg-brand text-white")} disabled={busy} onClick={() => start(async () => say(await verifyAliasAction(a.id)))}>That is them</button>
                <button className={quiet} disabled={busy} onClick={() => start(async () => say(await dismissAliasAction(a.id)))}>Not them</button>
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={Link2} title="Transcripts with no call" count={unlinked.length} flush>
        <div className="divide-y divide-border">
          {unlinked.length === 0 && <p className="px-5 py-3 text-sm text-muted">Every transcript on file is linked to a call.</p>}
          {unlinked.map((u) => (
            <div key={u.id} className="px-5 py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {u.sourceUrl ? <a href={u.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{u.title ?? "Untitled document"}</a> : (u.title ?? "Untitled document")}
                </span>
                <span className="text-[11px] text-muted-2">{when(u.recordedAtISO)}</span>
                <button className={quiet} disabled={busy} onClick={() => start(async () => say(await rejectTranscriptAction(u.id)))}>Not ours</button>
              </div>
              {u.candidates.length > 0 ? (
                <div className="mt-1 space-y-0.5">
                  {u.candidates.slice(0, 4).map((k) => (
                    <div key={k.callRecordId} className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="text-muted">{k.note}</span>
                      <span className="text-muted-2">score {k.score}</span>
                      <button className={cn(btn, "bg-brand text-white")} disabled={busy} onClick={() => start(async () => say(await confirmTranscriptAction(u.id, k.callRecordId)))}>This call</button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-0.5 text-[12px] text-muted-2">No call looks like a plausible match — similar names and times rank candidates but never establish ownership.</p>
              )}
            </div>
          ))}
        </div>
      </Section>

      {total === 0 && (
        <p className="text-[12px] text-muted-2">
          Nothing is in the queue. Calls reach it when the invitee&rsquo;s address matches no client, when two clients are plausible, when the target month is ambiguous,
          or when a transcript could belong to more than one call.
        </p>
      )}
    </div>
  );
}

function CallRow({
  c, clients, monthKeys, isOwner, busy, start, say,
}: { c: CallUi; clients: { id: string; name: string }[]; monthKeys: string[]; isOwner: boolean; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void }) {
  const [pick, setPick] = useState("");
  const [verifyEmail, setVerifyEmail] = useState(true);
  const [why, setWhy] = useState("");
  const [month, setMonth] = useState(c.targetMonthKey ?? "");
  return (
    <div className="px-5 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.inviteeName ?? c.inviteeEmail ?? "Unknown invitee"}</span>
        <span className="text-muted-2">{c.eventTypeName ?? c.callType.toLowerCase().replace(/_/g, " ")}</span>
        <span className="text-muted-2">{when(c.scheduledStartISO)}</span>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">{c.matchState.toLowerCase().replace(/_/g, " ")}</span>
        {c.transcriptState !== "NONE" && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted-2">transcript {c.transcriptState.toLowerCase().replace(/_/g, " ")}</span>}
        {c.clientName && <span className="text-muted">currently: {c.clientName}</span>}
      </div>
      {c.matchNote && <p className="text-muted">{c.matchNote}</p>}
      {c.lastError && <p className="text-warning"><AlertTriangle className="mr-1 inline size-3" />{c.lastError.slice(0, 200)}</p>}

      {/* WHICH CLIENT — candidates are shown with their reason and never pre-selected. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-muted">Who was this?</span>
        {c.candidates.slice(0, 3).map((k) => (
          <button key={k.clientId} className={quiet} disabled={busy} title={k.reason}
            onClick={() => start(async () => say(await confirmCallClientAction(c.id, k.clientId, verifyEmail)))}>
            {k.name} <span className="text-muted-2">({k.reason})</span>
          </button>
        ))}
        <select className={input} value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
          <option value="">pick a client…</option>
          {clients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <button className={cn(btn, "bg-brand text-white")} disabled={busy || !pick} onClick={() => start(async () => say(await confirmCallClientAction(c.id, pick, verifyEmail)))}>Match</button>
        {c.inviteeEmail && (
          <label className="flex items-center gap-1 text-[11px] text-muted">
            <input type="checkbox" checked={verifyEmail} onChange={(e) => setVerifyEmail(e.target.checked)} />
            also remember {c.inviteeEmail} as theirs
          </label>
        )}
      </div>

      {/* WHICH MONTH — a call in late September may be planning October. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-muted">Which month was it planning?</span>
        <select className={input} value={month} onChange={(e) => setMonth(e.target.value)} disabled={busy}>
          <option value="">choose…</option>
          {monthKeys.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button className={quiet} disabled={busy || !month} onClick={() => start(async () => say(await setCallMonthAction(c.id, month)))}>Set</button>
      </div>

      {/* SET ASIDE — needs a reason. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input className={`${input} flex-1`} placeholder="Why this is not program work (required to set it aside)" value={why} onChange={(e) => setWhy(e.target.value)} disabled={busy} />
        <button className={quiet} disabled={busy || !why.trim()} onClick={() => start(async () => say(await ignoreCallAction(c.id, why)))}>Set aside</button>
      </div>

      {c.transcripts.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {c.transcripts.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate">{t.sourceUrl ? <a href={t.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{t.title ?? "document"}</a> : (t.title ?? "document")}</span>
              <span className="text-muted-2">{t.matchState.toLowerCase()} · {when(t.recordedAtISO)}</span>
              {t.matchState !== "CONFIRMED" && (
                <>
                  <button className={cn(btn, "bg-brand text-white")} disabled={busy} onClick={() => start(async () => say(await confirmTranscriptAction(t.id, c.id)))}>This is the one</button>
                  <button className={quiet} disabled={busy} onClick={() => start(async () => say(await rejectTranscriptAction(t.id)))}>No</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {c.jobs.length > 0 && (
        <p className="mt-1 text-[12px] text-muted-2">
          jobs: {c.jobs.map((j) => `${j.kind} ${j.state.toLowerCase()}${j.attempts > 1 ? ` (${j.attempts} attempts)` : ""}`).join(" · ")}
          {isOwner && c.jobs.filter((j) => j.state === "FAILED" || j.state === "NEEDS_REVIEW").map((j) => (
            <button key={j.id} className={`${quiet} ml-1.5`} disabled={busy} onClick={() => start(async () => say(await retryTranscriptJobAction(j.id)))}>retry {j.kind}</button>
          ))}
        </p>
      )}
    </div>
  );
}
