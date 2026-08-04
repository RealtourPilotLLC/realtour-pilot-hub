"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, ArrowRight, CalendarCheck2, CheckCircle2, Copy, Loader2,
  MapPin, PackageCheck, Send, User, type LucideIcon,
} from "lucide-react";
import { setSmartTaskStatus } from "@/app/actions";
import { sendDraftText } from "@/app/tasks/sendAllActions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// The /texts review list. Every row is a drafted client text: review the message,
// tap Send (the SAME server actions the /today cards used — a human tap is the
// only way anything goes out), or Done to clear it without sending.

export type ClientTextRow = {
  id: string;
  taskType: string; // "confirmation_text" | "delivery_text"
  title: string;
  summary: string | null;
  draft: string | null; // pre-written message from the task description
  clientName: string | null;
  hasPhone: boolean;
  street: string | null;
  projectId: string | null;
  dueAt: string | null;
  overdue: boolean;
  warnStale: boolean; // confirmation past its due time — shoot may have happened
  warnQcOpen: boolean; // delivery text while the job's QC is still open
};

function dueLabel(row: ClientTextRow): { text: string; danger: boolean } {
  if (row.overdue) return { text: "overdue", danger: true };
  if (!row.dueAt) return { text: "", danger: false };
  const d = new Date(row.dueAt);
  const isToday = d.getTime() - Date.now() < 24 * 3600_000;
  const t = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const day = d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  return { text: isToday ? `by ${t}` : day, danger: false };
}

// Same color language as the Today feed (Kyle's feedback — Done and Send were
// both orange in the same spot): GREEN = Done/complete, leftmost; ORANGE =
// outbound send; neutral = everything else.
function Btn({ children, onClick, primary, success, disabled, busy }: {
  children: React.ReactNode; onClick?: () => void; primary?: boolean; success?: boolean; disabled?: boolean; busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
        success
          ? "bg-success text-white hover:opacity-90"
          : primary
          ? "bg-brand text-white hover:opacity-90"
          : "border border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground"
      }`}
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> <span>{children}</span>
    </div>
  );
}

function TextCard({ row, onGone }: { row: ClientTextRow; onGone: (id: string, note: string) => void }) {
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState(row.draft ?? "");
  const [copied, setCopied] = useState(false);
  const due = dueLabel(row);

  // Sends EXACTLY what's in the box — the review box is the message (the old
  // per-type actions re-rendered server-side and silently discarded edits).
  const send = () =>
    start(async () => {
      setErr(null);
      const r = await sendDraftText(row.id, text);
      if (r.ok) onGone(row.id, `Text sent${row.clientName ? ` to ${row.clientName}` : ""}`);
      else setErr(r.message);
    });

  // "Done" without sending = the /today card's skip: already handled elsewhere,
  // or the text shouldn't go out. Completes the task like the feed did.
  const done = () =>
    start(async () => {
      await setSmartTaskStatus(row.id, "COMPLETED");
      onGone(row.id, "Marked done");
    });

  const copy = async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      {/* Title + due chip */}
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug">{row.title}</p>
        {due.text && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${due.danger ? "bg-danger/10 font-semibold text-danger" : "bg-surface-2 text-muted"}`}>
            {due.text}
          </span>
        )}
      </div>

      {/* Who / where chips */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        {row.street && (
          <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 font-medium text-muted">
            <MapPin className="size-3" /> {row.street}
          </span>
        )}
        {row.clientName && (
          <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 font-medium text-muted">
            <User className="size-3" /> {row.clientName}
          </span>
        )}
      </div>

      <div className="mt-3 space-y-2.5">
        {row.warnStale && <Warn>This confirmation may be out of date — the shoot time may have already passed. Double-check before sending (or just mark it done).</Warn>}
        {row.warnQcOpen && <Warn>QC is still open on this job — the content may not all be delivered yet. Finish the check before telling the client it&apos;s all sent.</Warn>}

        {/* Review box: preloaded with the drafted message off the task. */}
        <AutoTextarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          minRows={4}
          placeholder="No draft on this task — Send composes the message fresh from the job."
          className="w-full rounded-xl border border-border bg-surface-2/50 p-3 text-sm"
        />
        <p className="text-[11px] text-muted-2">
          Sends via OpenPhone — nothing goes out until you tap Send. What&rsquo;s in the box is exactly what gets sent, edits included.
        </p>
        {row.summary && <p className="text-xs text-muted-2">{row.summary}</p>}
        {err && <p className="text-xs font-medium text-danger">{err}</p>}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Btn success onClick={done} busy={busy}>
            <CheckCircle2 className="size-4" /> Done
          </Btn>
          <Btn primary onClick={send} busy={busy} disabled={!row.hasPhone}>
            <Send className="size-4" /> Send text
          </Btn>
          <Btn onClick={copy}>{copied ? "Copied ✓" : <><Copy className="size-4" /> Copy</>}</Btn>
          {!row.hasPhone && <span className="text-[11px] text-warning">No phone on file</span>}
          {row.projectId && (
            <Link href={`/projects/${row.projectId}`} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
              Open job <ArrowRight className="size-3" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, blurb, icon: Icon, accent, rows, gone, onGone }: {
  title: string;
  blurb: string;
  icon: LucideIcon;
  accent: string;
  rows: ClientTextRow[];
  gone: Record<string, string>;
  onGone: (id: string, note: string) => void;
}) {
  const live = rows.filter((r) => !gone[r.id]).length;
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2 px-1">
        <span className="flex size-6 items-center justify-center rounded-lg" style={{ background: `${accent}22`, color: accent }}>
          <Icon className="size-3.5" />
        </span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{live}</span>
        <span className="hidden text-[11px] text-muted-2 sm:inline">· {blurb}</span>
      </div>
      {rows.length === 0 && <p className="px-1 text-xs text-muted-2">None waiting right now.</p>}
      {rows.map((r) =>
        gone[r.id] ? (
          // Cleared just now — the collapsed success trail, same as the feed.
          <p key={r.id} className="flex items-center gap-2 px-1 text-xs text-muted-2">
            <CheckCircle2 className="size-3.5 text-success" /> {gone[r.id]} — {r.title.slice(0, 60)}
          </p>
        ) : (
          <TextCard key={r.id} row={r} onGone={onGone} />
        ),
      )}
    </section>
  );
}

export function ClientTextsList({ confirmations, deliveries }: {
  confirmations: ClientTextRow[];
  deliveries: ClientTextRow[];
}) {
  const router = useRouter();
  const [gone, setGone] = useState<Record<string, string>>({});
  const onGone = (id: string, note: string) => {
    setGone((m) => ({ ...m, [id]: note }));
    // Re-run the server page so counts (and /today's rollup) stay honest.
    router.refresh();
  };
  const allClear = [...confirmations, ...deliveries].every((r) => gone[r.id]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {allClear && (
        <div className="rounded-2xl border border-dashed border-border bg-surface p-10 text-center">
          <CheckCircle2 className="mx-auto mb-3 size-10 text-success" />
          <p className="text-base font-semibold">No client texts waiting. 🎉</p>
          <p className="mt-1 text-sm text-muted">New confirmation and delivery texts show up here as jobs book and deliver.</p>
        </div>
      )}
      {/* Both sections always render (even at 0) so the tab reads the same every
          day — a glance confirms both kinds of texts were checked. */}
      <Section title="Confirmations" blurb="Day-before texts confirming tomorrow's shoot." icon={CalendarCheck2} accent="#38bdf8" rows={confirmations} gone={gone} onGone={onGone} />
      <Section title="Delivery texts" blurb="“Your content is ready” texts for finished jobs." icon={PackageCheck} accent="#22c55e" rows={deliveries} gone={gone} onGone={onGone} />
    </div>
  );
}
