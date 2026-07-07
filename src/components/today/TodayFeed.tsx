"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MessageSquare, ClipboardCheck, Send, PackageCheck, CheckCircle2, Loader2,
  AlertTriangle, Sparkles, Copy, Camera, ArrowRight, User, MapPin, type LucideIcon,
} from "lucide-react";
import { setSmartTaskStatus, setTaskAssignee, draftTaskReply, sendDeliveryText, sendConfirmationText } from "@/app/actions";
import { sendReplyForTask } from "@/app/today/actions";
import { sourceMeta } from "@/lib/taskSource";

// One card = one action. The stack is finish-able: every card ends in a tap
// that makes it disappear, and the page ends at "All clear".

export type TodayCard = {
  id: string;
  verb: "reply" | "send" | "do" | "check";
  taskType: string;
  typeLabel: string;
  title: string;
  summary: string | null;
  draft: string | null; // send cards: the ready-to-send text
  quote: string | null; // reply cards: the client's own message (never auto-send)
  body: string | null; // do/check cards: instructions/context
  clientId: string | null;
  clientName: string | null;
  hasPhone: boolean;
  street: string | null;
  projectId: string | null;
  source: string;
  priority: string;
  status: string;
  dueAt: string | null;
  overdue: boolean;
  triage: boolean;
  warnStale: boolean;
  warnQcOpen: boolean;
};

export type TodayShoot = { key: string; id: string; title: string; time: string; photographer: string | null };

const SECTIONS: { verb: TodayCard["verb"]; title: string; blurb: string; accent: string; icon: LucideIcon }[] = [
  { verb: "reply", title: "Reply to people", blurb: "Clients waiting on an answer.", accent: "#38bdf8", icon: MessageSquare },
  { verb: "do", title: "Do these", blurb: "Instructions and to-dos.", accent: "#f59e0b", icon: ClipboardCheck },
  { verb: "send", title: "Send these texts", blurb: "Pre-written — review, tap Send, done.", accent: "#22c55e", icon: Send },
  { verb: "check", title: "Check & deliver", blurb: "QC the content, then deliver.", accent: "#a78bfa", icon: PackageCheck },
];

const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const PRIORITY_DOT: Record<string, string> = { URGENT: "#dc2626", HIGH: "#d97706", MEDIUM: "#0ea5e9", LOW: "#64748b" };

function dueLabel(card: TodayCard): { text: string; danger: boolean } {
  if (card.overdue) return { text: "overdue", danger: true };
  if (!card.dueAt) return { text: "", danger: false };
  const d = new Date(card.dueAt);
  const isToday = d.getTime() - Date.now() < 24 * 3600_000;
  const t = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const day = d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  return { text: isToday ? `by ${t}` : day, danger: false };
}

function Btn({ children, onClick, primary, disabled, busy }: {
  children: React.ReactNode; onClick?: () => void; primary?: boolean; disabled?: boolean; busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
        primary ? "bg-brand text-white hover:opacity-90" : "border border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground"
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

function Clamp({ text, limit = 260 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= limit) return <p className="whitespace-pre-wrap text-sm text-muted">{text}</p>;
  return (
    <div>
      <p className="whitespace-pre-wrap text-sm text-muted">{open ? text : text.slice(0, limit) + "…"}</p>
      <button onClick={() => setOpen((o) => !o)} className="mt-1 text-xs font-medium text-brand hover:underline">
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

function ActionCard({ card, assignees, onGone }: {
  card: TodayCard;
  assignees: { key: string; name: string }[];
  onGone: (id: string, note: string) => void;
}) {
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [drafting, startDraft] = useTransition();
  const [kept, setKept] = useState(false); // triage: Kyle tapped "I'll do it"
  const [copied, setCopied] = useState(false);

  const src = sourceMeta(card.source);
  const due = dueLabel(card);

  const done = (note = "Done") =>
    start(async () => {
      await setSmartTaskStatus(card.id, "COMPLETED");
      onGone(card.id, note);
    });

  const sendPredrafted = () =>
    start(async () => {
      setErr(null);
      const r = card.taskType === "confirmation_text" ? await sendConfirmationText(card.id) : await sendDeliveryText(card.id);
      if (r.ok) onGone(card.id, `Text sent${card.clientName ? ` to ${card.clientName}` : ""}`);
      else setErr(r.message);
    });

  const sendReply = () =>
    start(async () => {
      setErr(null);
      const r = await sendReplyForTask(card.id, draftText);
      if (r.ok) onGone(card.id, `Reply sent${card.clientName ? ` to ${card.clientName}` : ""}`);
      else setErr(r.message);
    });

  const aiDraft = () =>
    startDraft(async () => {
      setErr(null);
      const r = await draftTaskReply(card.id);
      if (r.ok && r.text) { setDraftText(r.text); setCompose(true); }
      else setErr(r.error ?? "Couldn't draft a reply.");
    });

  const assign = (key: string, name: string) =>
    start(async () => {
      await setTaskAssignee(card.id, key);
      if (key === "kyle") setKept(true);
      else onGone(card.id, `Moved to ${name}'s list`);
    });

  const copyDraft = async () => {
    if (!card.draft) return;
    await navigator.clipboard.writeText(card.draft).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      {/* Title row */}
      <div className="flex items-start gap-2">
        <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: PRIORITY_DOT[card.priority] ?? PRIORITY_DOT.MEDIUM }} />
        <p className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug">{card.title}</p>
        {due.text && (
          <span className={`shrink-0 text-[11px] ${due.danger ? "font-semibold text-danger" : "text-muted"}`}>{due.text}</span>
        )}
      </div>

      {/* Identity row */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-[11px] text-muted-2">
        {card.clientName && (
          <span className="inline-flex items-center gap-1 font-medium text-muted">
            <User className="size-3" /> {card.clientName}
          </span>
        )}
        {card.street && !card.title.toLowerCase().includes(card.street.toLowerCase()) && (
          <span className="inline-flex items-center gap-1"><MapPin className="size-3" /> {card.street}</span>
        )}
        <span className="rounded bg-surface-2 px-1 font-medium">{src.label}</span>
        <span className="text-muted-2">· {card.typeLabel}</span>
        {card.status.startsWith("WAITING") && <span className="rounded bg-warning/10 px-1 font-medium text-warning">{card.status.replace(/_/g, " ").toLowerCase()}</span>}
      </div>

      {/* Body by verb */}
      <div className="mt-3 space-y-2.5 pl-4">
        {card.verb === "send" && card.draft && (
          <>
            {card.warnStale && <Warn>This confirmation may be out of date — the shoot time may have already passed. Double-check before sending (or just mark it done).</Warn>}
            {card.warnQcOpen && <Warn>QC is still open on this job — the content may not all be delivered yet. Finish the check before telling the client it&apos;s all sent.</Warn>}
            <div className="rounded-xl bg-surface-2/70 p-3">
              <p className="whitespace-pre-wrap text-sm">{card.draft}</p>
            </div>
          </>
        )}
        {card.verb === "reply" && card.quote && (
          <blockquote className="border-l-2 border-border pl-3">
            <Clamp text={card.quote} />
          </blockquote>
        )}
        {(card.verb === "do" || card.verb === "check") && (card.summary || card.body) && (
          <Clamp text={card.summary && card.body && card.summary !== card.body ? `${card.summary}\n\n${card.body}` : (card.body ?? card.summary ?? "")} />
        )}
        {card.verb === "send" && card.summary && <p className="text-xs text-muted-2">{card.summary}</p>}

        {/* Triage chips */}
        {card.triage && !kept && (
          <div className="rounded-xl border border-warning/30 bg-warning/5 p-2.5">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">Who owns this?</p>
            <div className="flex flex-wrap gap-1.5">
              {assignees.slice(0, 8).map((a) => (
                <button
                  key={a.key}
                  onClick={() => assign(a.key, a.name)}
                  disabled={busy}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
                >
                  {a.key === "kyle" ? "I'll do it" : a.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Reply compose */}
        {card.verb === "reply" && compose && (
          <div className="space-y-2">
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              rows={4}
              placeholder="Write your reply…"
              className="w-full rounded-xl border border-border bg-surface-2/50 p-3 text-sm"
            />
            <p className="text-[11px] text-muted-2">Sends as a text via OpenPhone — nothing goes out until you tap Send.</p>
          </div>
        )}

        {err && <p className="text-xs font-medium text-danger">{err}</p>}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {card.verb === "send" && (
            <>
              <Btn primary onClick={sendPredrafted} busy={busy} disabled={!card.hasPhone}>
                <Send className="size-4" /> Send text
              </Btn>
              <Btn onClick={copyDraft}>{copied ? "Copied ✓" : <><Copy className="size-4" /> Copy</>}</Btn>
              <Btn onClick={() => done("Marked done")}>Done</Btn>
              {!card.hasPhone && <span className="text-[11px] text-warning">No phone on file</span>}
            </>
          )}
          {card.verb === "reply" && (
            <>
              {!compose && (
                <>
                  <Btn primary onClick={aiDraft} busy={drafting}>
                    <Sparkles className="size-4" /> Draft reply
                  </Btn>
                  <Btn onClick={() => setCompose(true)}>Write my own</Btn>
                </>
              )}
              {compose && card.hasPhone && (
                <Btn primary onClick={sendReply} busy={busy} disabled={!draftText.trim()}>
                  <Send className="size-4" /> Send
                </Btn>
              )}
              {compose && !card.hasPhone && <span className="text-[11px] text-warning">No phone on file — reply from Gmail/OpenPhone directly</span>}
              <Btn onClick={() => done("Marked done")}>Done</Btn>
              {card.clientId && (
                <Link href={`/clients/${card.clientId}`} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                  Open client <ArrowRight className="size-3" />
                </Link>
              )}
            </>
          )}
          {(card.verb === "do" || card.verb === "check") && (
            <>
              <Btn primary onClick={() => done("Done")} busy={busy}>
                <CheckCircle2 className="size-4" /> Done
              </Btn>
              {card.projectId && (
                <Link href={`/projects/${card.projectId}`} className="inline-flex items-center gap-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                  Open job <ArrowRight className="size-3.5" />
                </Link>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function TodayFeed({ cards, shoots, handledToday, assignees }: {
  cards: TodayCard[];
  shoots: TodayShoot[];
  handledToday: number;
  assignees: { key: string; name: string }[];
}) {
  const router = useRouter();
  const [goneNotes, setGoneNotes] = useState<Record<string, string>>({});

  const onGone = (id: string, note: string) => {
    setGoneNotes((m) => ({ ...m, [id]: note }));
    router.refresh();
  };

  const sorted = useMemo(() => {
    const cmp = (a: TodayCard, b: TodayCard) =>
      (a.overdue ? 0 : 1) - (b.overdue ? 0 : 1) ||
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity);
    return [...cards].sort(cmp);
  }, [cards]);

  const remaining = sorted.filter((c) => !goneNotes[c.id]).length;
  const clearedNow = Object.keys(goneNotes).length;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Progress line */}
      <div className="flex items-center justify-between px-1">
        <p className="text-sm text-muted">
          {remaining === 0 ? "Nothing needs you." : <><span className="font-semibold text-foreground">{remaining}</span> {remaining === 1 ? "thing needs" : "things need"} you</>}
        </p>
        <Link href="/queue" className="text-xs font-medium text-muted hover:text-foreground hover:underline">Full board →</Link>
      </div>

      {/* Today's shoots strip */}
      {shoots.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Camera className="size-4 text-muted" />
            <h2 className="text-sm font-semibold">Today&apos;s shoots</h2>
            <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted">{shoots.length}</span>
          </div>
          <div className="divide-y divide-border/60">
            {shoots.map((s) => (
              <Link key={s.key} href={`/shoot/${s.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-surface-2">
                <span className="truncate text-sm">{s.title}</span>
                <span className="shrink-0 text-xs text-muted">{s.time}{s.photographer ? ` · ${s.photographer}` : ""}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* All clear */}
      {remaining === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-surface p-10 text-center">
          <CheckCircle2 className="mx-auto mb-3 size-10 text-success" />
          <p className="text-base font-semibold">All clear 🎉</p>
          <p className="mt-1 text-sm text-muted">
            {clearedNow > 0 ? `You cleared ${clearedNow} just now. ` : ""}New texts, emails, and Slack messages will show up here.
          </p>
        </div>
      )}

      {/* Sections */}
      {SECTIONS.map((sec) => {
        const items = sorted.filter((c) => c.verb === sec.verb);
        if (items.length === 0) return null;
        const live = items.filter((c) => !goneNotes[c.id]).length;
        if (live === 0 && items.every((c) => goneNotes[c.id])) {
          // Whole section cleared — show the collapsed success trail.
          return (
            <div key={sec.verb} className="space-y-1.5">
              {items.map((c) => (
                <p key={c.id} className="flex items-center gap-2 px-1 text-xs text-muted-2">
                  <CheckCircle2 className="size-3.5 text-success" /> {goneNotes[c.id]} — {c.title.slice(0, 60)}
                </p>
              ))}
            </div>
          );
        }
        const Icon = sec.icon;
        return (
          <section key={sec.verb} className="space-y-2.5">
            <div className="flex items-center gap-2 px-1">
              <span className="flex size-6 items-center justify-center rounded-lg" style={{ background: `${sec.accent}22`, color: sec.accent }}>
                <Icon className="size-3.5" />
              </span>
              <h2 className="text-sm font-semibold">{sec.title}</h2>
              <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{live}</span>
              <span className="hidden text-[11px] text-muted-2 sm:inline">· {sec.blurb}</span>
            </div>
            {items.map((c) =>
              goneNotes[c.id] ? (
                <p key={c.id} className="flex items-center gap-2 px-1 text-xs text-muted-2">
                  <CheckCircle2 className="size-3.5 text-success" /> {goneNotes[c.id]} — {c.title.slice(0, 60)}
                </p>
              ) : (
                <ActionCard key={c.id} card={c} assignees={assignees} onGone={onGone} />
              ),
            )}
          </section>
        );
      })}

      {/* Auto-handled footer */}
      <p className="pb-4 text-center text-xs text-muted-2">
        {handledToday > 0 ? `${handledToday} task${handledToday === 1 ? "" : "s"} handled today ✓ · ` : ""}
        <Link href="/queue" className="hover:text-foreground hover:underline">Open the full board</Link>
      </p>
    </div>
  );
}
