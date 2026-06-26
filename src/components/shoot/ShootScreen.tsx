"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  MapPin, Navigation, Copy, Check, Phone, MessageSquare, Mail, Sparkles, Send,
  CheckCircle2, Circle, Flag, AlertTriangle, Loader2, Crown, Upload, Clock,
  ClipboardList, StickyNote, X, ChevronRight, Camera,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BackLink } from "@/components/ui/BackLink";
import { Badge } from "@/components/ui/Badge";
import { Section } from "@/components/ui/Section";
import { DELIVERABLE_META } from "@/lib/pipeline";
import { PALETTE } from "@/lib/palette";
import { SHOOT_STATUS_META, shootStatusText, type ShootStatusKind } from "@/lib/statusTexts";
import type { ShootView } from "@/lib/shoot";
import {
  sendShootStatusText, draftClientMessage, sendClientMessage,
  setDeliverableCaptured, saveShootNote, flagShootIssue, completeShoot,
} from "@/app/shoot/actions";

const STATUS_ORDER: ShootStatusKind[] = ["on_my_way", "arrived", "complete"];

export function ShootScreen({
  view, pay, whenText, timing, media,
}: {
  view: ShootView;
  pay: React.ReactNode;
  whenText: string;
  timing: "today" | "upcoming" | "past" | null;
  media: React.ReactNode;
}) {
  const { project, appointment, client, segment, profile, deliverables } = view;

  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flash(kind: "ok" | "err", text: string) {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }

  // Capture checklist state lives here so the checklist and the "Mark complete"
  // gate always agree, instantly (no waiting on a server round-trip to re-sync).
  const [captured, setCaptured] = useState<Record<string, boolean>>(
    Object.fromEntries(deliverables.map((d) => [d.id, d.capturedAt != null])),
  );
  const [, startCapture] = useTransition();
  function toggleCapture(id: string) {
    const next = !captured[id];
    setCaptured((c) => ({ ...c, [id]: next }));
    startCapture(async () => {
      try { await setDeliverableCaptured(id, next); }
      catch { setCaptured((c) => ({ ...c, [id]: !next })); flash("err", "Couldn’t save"); }
    });
  }
  const capturedCount = Object.values(captured).filter(Boolean).length;

  return (
    <div className="mx-auto max-w-2xl px-4 pb-28 pt-4 sm:px-6">
      <BackLink href="/shoot" label="My shoots" />

      <HeaderCard project={project} appointment={appointment} whenText={whenText} timing={timing} onCopy={() => flash("ok", "Address copied")} />

      <div className="mt-4 space-y-4">
        <StatusUpdates view={view} flash={flash} />
        <CustomerCard client={client} segment={segment} profile={profile} />
        <BriefCard view={view} flash={flash} />
        <Checklist deliverables={deliverables} captured={captured} onToggle={toggleCapture} />
        {pay}
        <NotesCard projectId={project.id} initial={project.editorBrief ?? ""} flash={flash} />
        <MediaCard media={media} uploaded={project.uploadedAt != null} />
      </div>

      <CompleteBar
        projectId={project.id}
        initialCompletedISO={appointment?.completedAtISO ?? null}
        total={deliverables.length}
        captured={capturedCount}
        flash={flash}
      />

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[1400] flex justify-center px-4">
          <div className={cn(
            "pointer-events-auto rounded-full px-4 py-2 text-sm font-medium shadow-lg ring-1",
            toast.kind === "ok" ? "bg-success text-white ring-success/30" : "bg-danger text-white ring-danger/30",
          )}>
            {toast.text}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function HeaderCard({
  project, appointment, whenText, timing, onCopy,
}: {
  project: ShootView["project"];
  appointment: ShootView["appointment"];
  whenText: string;
  timing: "today" | "upcoming" | "past" | null;
  onCopy: () => void;
}) {
  const q = encodeURIComponent(project.mapsQuery);
  const completed = !!appointment?.completedAtISO;
  const dirs = [
    { label: "Apple", href: `https://maps.apple.com/?q=${q}` },
    { label: "Google", href: `https://www.google.com/maps/search/?api=1&query=${q}` },
    { label: "Waze", href: `https://waze.com/ul?q=${q}&navigate=yes` },
  ];
  const tone =
    timing === "today" ? PALETTE.green : timing === "upcoming" ? PALETTE.blue : PALETTE.gray;
  const timingLabel = timing === "today" ? "Today" : timing === "upcoming" ? "Upcoming" : timing === "past" ? "Past" : null;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border bg-surface panel-shadow">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">{project.street}</h1>
            <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
              <MapPin className="size-3.5 shrink-0" />
              <span className="truncate">{project.addressFull}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {completed ? (
              <Badge color={PALETTE.green}><CheckCircle2 className="mr-0.5 inline size-3" /> Complete</Badge>
            ) : timingLabel ? (
              <Badge color={tone}>{timingLabel}</Badge>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          {whenText && (
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Clock className="size-3.5 text-muted" /> {whenText}
            </span>
          )}
          {appointment?.durationMin ? <span className="text-muted">{appointment.durationMin} min</span> : null}
          {project.packageName && <span className="text-muted-2">·</span>}
          {project.packageName && <span className="text-muted">{project.packageName}</span>}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t bg-surface-2/40 px-4 py-2.5">
        <Navigation className="size-4 text-brand" />
        <span className="text-xs font-medium text-muted">Directions</span>
        <div className="ml-auto flex items-center gap-1.5">
          {dirs.map((d) => (
            <a
              key={d.label}
              href={d.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2"
            >
              {d.label}
            </a>
          ))}
          <button
            onClick={() => { navigator.clipboard?.writeText(project.addressFull); onCopy(); }}
            className="flex size-7 items-center justify-center rounded-lg border bg-surface text-muted hover:bg-surface-2 hover:text-foreground"
            title="Copy address"
          >
            <Copy className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatusUpdates({ view, flash }: { view: ShootView; flash: (k: "ok" | "err", t: string) => void }) {
  const { project, client } = view;
  const [sheet, setSheet] = useState<{ kind: ShootStatusKind; text: string } | null>(null);
  const [sent, setSent] = useState<Set<ShootStatusKind>>(new Set());
  const [pending, start] = useTransition();

  // Free-form composer
  const [msg, setMsg] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [polished, setPolished] = useState(false);

  function open(kind: ShootStatusKind) {
    setSheet({
      kind,
      text: shootStatusText(kind, {
        clientName: client.name,
        propertyTitle: project.title,
        photographerName: view.photographer?.name,
      }),
    });
  }

  function sendStatus() {
    if (!sheet) return;
    const { kind, text } = sheet;
    start(async () => {
      const r = await sendShootStatusText(project.id, kind, text);
      if (r.ok) { setSent((s) => new Set(s).add(kind)); setSheet(null); flash("ok", "Text sent to client"); }
      else flash("err", r.message);
    });
  }

  async function polish() {
    if (!msg.trim()) return;
    setDrafting(true);
    try {
      const r = await draftClientMessage(project.id, msg);
      if (r.ok && r.text) { setMsg(r.text); setPolished(true); }
      else flash("err", r.error || "Couldn’t draft");
    } finally { setDrafting(false); }
  }

  function sendMsg() {
    if (!msg.trim()) return;
    start(async () => {
      const r = await sendClientMessage(project.id, msg);
      if (r.ok) { setMsg(""); setPolished(false); flash("ok", "Message sent to client"); }
      else flash("err", r.message);
    });
  }

  const noPhone = !client.phoneE164;

  return (
    <Section icon={MessageSquare} title="Status updates" bodyClassName="space-y-3">
      {noPhone && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="size-3.5" /> No phone number on file for this client — texts can’t be sent.
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {STATUS_ORDER.map((kind) => {
          const done = sent.has(kind);
          return (
            <button
              key={kind}
              onClick={() => open(kind)}
              disabled={noPhone}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center text-xs font-medium transition-colors disabled:opacity-40",
                done ? "border-success/40 bg-success-soft/40 text-success" : "bg-surface hover:bg-surface-2",
              )}
            >
              {done ? <CheckCircle2 className="size-5" /> : kind === "complete" ? <Check className="size-5 text-muted" /> : <Navigation className="size-5 text-brand" />}
              {SHOOT_STATUS_META[kind].label}
            </button>
          );
        })}
      </div>

      {/* Free-form message with AI polish */}
      <div className="rounded-xl border bg-surface-2/40 p-3">
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
          <Sparkles className="size-3.5 text-brand" /> Message the client
        </label>
        <textarea
          value={msg}
          onChange={(e) => { setMsg(e.target.value); setPolished(false); }}
          rows={2}
          placeholder="Type a quick note — e.g. running 10 min late, gate code didn’t work…"
          className="w-full resize-none rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
        {polished && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-brand"><Sparkles className="size-3" /> AI polished — edit as needed before sending</div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={polish}
            disabled={!msg.trim() || drafting}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-40"
          >
            {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Polish with AI
          </button>
          <button
            onClick={sendMsg}
            disabled={!msg.trim() || pending || noPhone}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90 disabled:opacity-40"
          >
            <Send className="size-3.5" /> Send
          </button>
        </div>
      </div>

      {sheet && (
        <SendSheet
          title={SHOOT_STATUS_META[sheet.kind].label}
          text={sheet.text}
          onChange={(t) => setSheet({ ...sheet, text: t })}
          onCancel={() => setSheet(null)}
          onSend={sendStatus}
          sending={pending}
        />
      )}
    </Section>
  );
}

function SendSheet({
  title, text, onChange, onCancel, onSend, sending,
}: {
  title: string; text: string; onChange: (t: string) => void; onCancel: () => void; onSend: () => void; sending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[1400] flex items-end justify-center bg-black/50 sm:items-center" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-t-2xl border bg-surface p-5 shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{title} — review &amp; send</h3>
          <button onClick={onCancel} className="text-muted-2 hover:text-foreground"><X className="size-4" /></button>
        </div>
        <p className="mb-2 text-xs text-muted">This goes to the client as a text. Edit anything before sending.</p>
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className="w-full resize-none rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
        <div className="mt-3 flex items-center gap-2">
          <button onClick={onCancel} className="rounded-lg border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2">Cancel</button>
          <button
            onClick={onSend}
            disabled={sending || !text.trim()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send text
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CustomerCard({
  client, segment, profile,
}: {
  client: ShootView["client"];
  segment: ShootView["segment"];
  profile: ShootView["profile"];
}) {
  const isVip = segment?.key === "vip";
  return (
    <Section
      icon={isVip ? Crown : undefined}
      title="Customer"
      action={
        <div className="flex items-center gap-1.5">
          {client.phoneE164 && (
            <>
              <a href={`tel:${client.phoneE164}`} className="flex size-8 items-center justify-center rounded-lg border bg-surface text-brand hover:bg-surface-2" title="Call"><Phone className="size-4" /></a>
              <a href={`sms:${client.phoneE164}`} className="flex size-8 items-center justify-center rounded-lg border bg-surface text-brand hover:bg-surface-2" title="Text"><MessageSquare className="size-4" /></a>
            </>
          )}
          {client.email && (
            <a href={`mailto:${client.email}`} className="flex size-8 items-center justify-center rounded-lg border bg-surface text-brand hover:bg-surface-2" title="Email"><Mail className="size-4" /></a>
          )}
        </div>
      }
      bodyClassName="space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{client.name}</span>
        {segment && <Badge color={segment.color}>{isVip && <Crown className="mr-0.5 inline size-3" />}{segment.label}</Badge>}
        {client.socialClient && <Badge color={PALETTE.violet}>Social{client.socialPlan ? ` · ${client.socialPlan}` : ""}</Badge>}
      </div>

      {profile ? (
        <div className="space-y-3">
          {profile.summary && <p className="text-sm text-foreground/85">{profile.summary}</p>}
          <div className="flex flex-wrap gap-1.5">
            {profile.touchLevel && <Chip label={`${profile.touchLevel} touch`} />}
            {profile.brandStyle && <Chip label={profile.brandStyle} />}
          </div>
          {profile.dos?.length > 0 && <DoList tone="do" items={profile.dos} />}
          {profile.donts?.length > 0 && <DoList tone="dont" items={profile.donts} />}
          {profile.shootNotes?.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold text-muted">On the shoot</div>
              <ul className="ml-4 list-disc space-y-0.5 text-sm text-foreground/80">
                {profile.shootNotes.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : client.editingPreferences ? (
        <p className="text-sm text-muted">Editing notes: {client.editingPreferences}</p>
      ) : (
        <p className="text-sm text-muted-2">No working profile yet — this builds up as we do more shoots together.</p>
      )}
    </Section>
  );
}

function Chip({ label }: { label: string }) {
  return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium capitalize text-muted">{label}</span>;
}

function DoList({ tone, items }: { tone: "do" | "dont"; items: string[] }) {
  const ok = tone === "do";
  return (
    <div>
      <div className={cn("mb-1 text-xs font-semibold", ok ? "text-success" : "text-danger")}>{ok ? "Do" : "Avoid"}</div>
      <ul className="space-y-0.5">
        {items.slice(0, 4).map((s, i) => (
          <li key={i} className="flex items-start gap-1.5 text-sm text-foreground/80">
            {ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" /> : <X className="mt-0.5 size-3.5 shrink-0 text-danger" />}
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function BriefCard({ view, flash }: { view: ShootView; flash: (k: "ok" | "err", t: string) => void }) {
  const { appointment, specialRequests, project } = view;
  const [flags, setFlags] = useState(view.flags);
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();

  function addFlag() {
    const body = input.trim();
    if (!body) return;
    setFlags((f) => [body, ...f]);
    setInput("");
    start(async () => { await flagShootIssue(project.id, body); flash("ok", "Issue flagged"); });
  }

  const hasBrief = !!appointment?.brief;
  return (
    <Section icon={ClipboardList} title="Access & shoot brief" bodyClassName="space-y-3">
      {specialRequests.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning-soft/40 p-3">
          <div className="mb-1 text-xs font-semibold text-warning">Special requests</div>
          <ul className="ml-4 list-disc space-y-0.5 text-sm text-foreground/85">
            {specialRequests.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {hasBrief ? (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/85">{appointment!.brief}</pre>
      ) : (
        <p className="text-sm text-muted-2">No access notes on this appointment.</p>
      )}
      {view.extraAppointments > 0 && (
        <p className="text-xs text-muted-2">+{view.extraAppointments} more visit{view.extraAppointments === 1 ? "" : "s"} on this order.</p>
      )}

      <div className="border-t pt-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted"><Flag className="size-3.5 text-danger" /> Flag an issue on-site</div>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addFlag()}
            placeholder="e.g. Lockbox code didn’t work, dog loose in backyard"
            className="flex-1 rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          <button onClick={addFlag} disabled={pending} className="rounded-lg border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">Flag</button>
        </div>
        {flags.length > 0 && (
          <ul className="mt-2 space-y-1">
            {flags.map((f, i) => (
              <li key={i} className="flex items-start gap-2 rounded-lg bg-danger-soft/60 px-2.5 py-1.5 text-xs text-danger">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {f}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function Checklist({
  deliverables, captured, onToggle,
}: {
  deliverables: ShootView["deliverables"];
  captured: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  const total = deliverables.length;
  const done = Object.values(captured).filter(Boolean).length;

  if (total === 0) return null;

  return (
    <Section icon={Camera} title="Capture checklist" count={`${done}/${total}`} bodyClassName="space-y-1.5">
      <p className="mb-1 text-xs text-muted">Tick each item once you’ve captured it. Confirm everything before marking the shoot complete.</p>
      {deliverables.map((d) => {
        const on = captured[d.id];
        const meta = DELIVERABLE_META[d.type];
        return (
          <button
            key={d.id}
            onClick={() => onToggle(d.id)}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
              on ? "border-success/40 bg-success-soft/30" : "bg-surface hover:bg-surface-2",
            )}
          >
            {on ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <Circle className="size-5 shrink-0 text-muted-2" />}
            <span className="flex-1 text-sm font-medium">
              {meta?.label ?? d.type}{d.quantity > 1 ? <span className="text-muted"> ×{d.quantity}</span> : null}
            </span>
            {d.uploadCount > 0 && <span className="text-[11px] text-muted-2">{d.uploadCount} uploaded</span>}
          </button>
        );
      })}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function NotesCard({ projectId, initial, flash }: { projectId: string; initial: string; flash: (k: "ok" | "err", t: string) => void }) {
  const [note, setNote] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [pending, start] = useTransition();
  const dirty = note.trim() !== saved.trim();

  function save() {
    start(async () => {
      await saveShootNote(projectId, note);
      setSaved(note);
      flash("ok", "Notes saved for editors");
    });
  }

  return (
    <Section icon={StickyNote} title="Notes for the editor">
      <p className="mb-2 text-xs text-muted">Anything the editor should know — these flow straight into your upload, so you won’t retype them.</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="e.g. House faces west so exteriors are backlit, recover sky. Seller wants the pool emphasized. Skip the cluttered office."
        className="w-full resize-none rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
      <div className="mt-2 flex items-center justify-end">
        <button
          onClick={save}
          disabled={!dirty || pending}
          className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-40"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {dirty ? "Save notes" : "Saved"}
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function MediaCard({ media, uploaded }: { media: React.ReactNode; uploaded: boolean }) {
  return (
    <Section icon={Camera} title="Your media">
      {media ? (
        media
      ) : (
        <p className="text-sm text-muted-2">
          {uploaded
            ? "Your content is in. The finished photos will appear here once they’re published."
            : "Your captured photos will show here once they’re uploaded and live."}
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function CompleteBar({
  projectId, initialCompletedISO, total, captured, flash,
}: {
  projectId: string;
  initialCompletedISO: string | null;
  total: number;
  captured: number;
  flash: (k: "ok" | "err", t: string) => void;
}) {
  const [completed, setCompleted] = useState(initialCompletedISO != null);
  const [pending, start] = useTransition();

  function complete() {
    if (!completed && total > 0 && captured < total) {
      const ok = window.confirm(
        `${total - captured} item${total - captured === 1 ? "" : "s"} on the checklist ${total - captured === 1 ? "isn’t" : "aren’t"} ticked off yet.\n\nMark the shoot complete anyway?`,
      );
      if (!ok) return;
    }
    start(async () => {
      const r = await completeShoot(projectId);
      if (r.ok) { setCompleted(true); flash("ok", "Shoot marked complete"); }
      else flash("err", r.message);
    });
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[1100] border-t border-border bg-surface/95 backdrop-blur-xl">
      <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3 sm:px-6">
        {completed ? (
          <>
            <div className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="size-5" /> Shoot complete
            </div>
            <Link
              href={`/upload/${projectId}`}
              className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg hover:opacity-90"
            >
              <Upload className="size-4" /> Upload content <ChevronRight className="size-4" />
            </Link>
          </>
        ) : (
          <>
            <div className="text-xs text-muted">
              {total > 0 ? <>{captured}/{total} captured</> : "Ready when you are"}
            </div>
            <button
              onClick={complete}
              disabled={pending}
              className="ml-auto inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Mark shoot complete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
