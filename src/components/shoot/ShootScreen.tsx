"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  MapPin, Navigation, Copy, Check, Phone, MessageSquare, Mail, Sparkles, Send,
  CheckCircle2, Circle, Flag, AlertTriangle, Loader2, Crown, Upload, Clock,
  ClipboardList, StickyNote, X, ChevronRight, Camera,
  KeyRound, DoorOpen, Home, FileText, Info, Box, ExternalLink, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BackLink } from "@/components/ui/BackLink";
import { ReelScriptCard } from "@/components/project/ReelScriptCard";
import { AocPlaybookCard } from "@/components/project/AocPlaybookCard";
import { Badge } from "@/components/ui/Badge";
import { Section } from "@/components/ui/Section";
import { DELIVERABLE_META } from "@/lib/pipeline";
import { PALETTE } from "@/lib/palette";
import { SHOOT_STATUS_META, shootStatusText, type ShootStatusKind } from "@/lib/statusTexts";
import { CullingReminder } from "@/components/upload/CullingReminder";
import { photoTargetFor, roomBudgetText } from "@/lib/culling";
import type { ShootView } from "@/lib/shoot";
import {
  sendShootStatusText, draftClientMessage, sendClientMessage,
  setDeliverableCaptured, saveShootNote, flagShootIssue, completeShoot,
} from "@/app/shoot/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

const STATUS_ORDER: ShootStatusKind[] = ["on_my_way", "arrived", "complete"];

// What the photographer actually needs to CAPTURE on-site for each ordered
// deliverable — so the checklist tells them exactly what the job requires, not
// just the product name. Keyed by DeliverableType.
const CAPTURE_GUIDE: Record<string, string> = {
  PHOTOS: "Full set — every room, both exteriors, and the key selling features (kitchen, primary suite, baths, yard).",
  VIDEO: "Cinematic walkthrough — exterior establishing shot, smooth room-to-room flow, highlight the best features.",
  SOCIAL_REEL: "Vertical clips for the reel — hook shot, walking transitions, feature close-ups (agent on camera if it’s booked).",
  DRONE: "Aerials — front, rear, roofline, lot lines, and a little neighborhood context.",
  TWILIGHT: "Twilight exterior at dusk with the interior lights on (schedule a dusk return if you’re there in daylight).",
  FLOORPLAN: "CubiCasa scan — walk every room and level slowly with the app so the floor plan is complete.",
  MATTERPORT_3D: "Matterport scan — every room and transition so the 3D tour has no gaps.",
  ZILLOW_3D: "Zillow 3D Home — pano scan of every room (use the Capture button above).",
  HEADSHOT: "Agent headshots — a few clean, well-lit options framed for their brand.",
  OTHER: "Capture per the order notes and the brief above.",
};

// Deliverables produced in EDITING, not captured on-site — they don't belong on
// the capture checklist (ticking "captured virtual staging" makes no sense). We
// still surface a shooting reminder for staging via the must-gets block.
const POST_PRODUCTION_TYPES = new Set<string>(["VIRTUAL_STAGING"]);

export function ShootScreen({
  view, pay, map, whenText, timing, media, backHref = "/shoot",
}: {
  view: ShootView;
  pay: React.ReactNode;
  map: React.ReactNode;
  whenText: string;
  timing: "today" | "upcoming" | "past" | null;
  media: React.ReactNode;
  backHref?: string;
}) {
  const { project, appointment, client, segment, profile, deliverables } = view;

  // Only on-site captureable deliverables go on the capture checklist (editing-
  // only items like virtual staging are surfaced as a shooting reminder instead).
  const captureables = deliverables.filter((d) => !POST_PRODUCTION_TYPES.has(d.type));
  const stagingOrdered = deliverables.some((d) => POST_PRODUCTION_TYPES.has(d.type));
  // Photo budget for this home (counts only — never money on the field view).
  // Only relevant when a photo set is actually being captured; the room budget
  // rides on the PHOTOS capture row and the culling reminder above the checklist.
  const photosOrdered = deliverables.some((d) => ["PHOTOS", "DRONE", "TWILIGHT"].includes(d.type));
  const photoTarget = photosOrdered ? photoTargetFor(project) : null;
  // Video/reel jobs get the Agent-on-Camera playbook + reel recipe on-site.
  const isVideo = deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  // Hard, order-specific must-dos (amber "don't leave without"): the order's
  // special instructions + any logged special requests for this property.
  const mustGets = Array.from(
    new Set(
      [...(appointment?.parsed?.special ? [appointment.parsed.special] : []), ...view.specialRequests]
        // Strip the "Client request (openphone):" provenance prefix logged on
        // special-request activities so the checklist reads as a clean instruction.
        .map((s) => s.replace(/^Client request \([^)]*\):\s*/i, "").trim())
        .filter(Boolean),
    ),
  ).slice(0, 6);
  // Softer working context for this agent, from their profile shoot notes (how
  // they like to work, access habits, on-camera timing) — good to know, not a gate.
  const agentNotes = Array.from(new Set((profile?.shootNotes ?? []).map((s) => s.trim()).filter(Boolean)))
    .filter((n) => !mustGets.includes(n))
    .slice(0, 5);

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
    Object.fromEntries(captureables.map((d) => [d.id, d.capturedAt != null])),
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

  // Card order = the field flow (July 2026 field-UX audit, Jordan's spec):
  //   get there (map) → get in (access/brief) → shoot (checklist, capture
  //   tools, script) → who it's for (customer, collapsed) → wrap up (editor
  //   notes, media) → pay last. Status texts + client messaging live in the
  //   floating action bar so quick actions are ALWAYS one thumb away.
  return (
    <div className="mx-auto max-w-2xl px-4 pb-36 pt-4 sm:px-6">
      <BackLink href={backHref} label={backHref === "/shoot" ? "My shoots" : "Back"} />

      <HeaderCard project={project} appointment={appointment} whenText={whenText} timing={timing} onCopy={() => flash("ok", "Address copied")} />

      <div className="mt-4 space-y-4">
        {map}
        <BriefCard view={view} flash={flash} />
        <Checklist deliverables={captureables} captured={captured} onToggle={toggleCapture} mustGets={mustGets} agentNotes={agentNotes} staging={stagingOrdered} photoTarget={photoTarget} />
        {view.zillowTourUrl && <ZillowCta url={view.zillowTourUrl} />}
        {/* The locked script from Script Studio — READ-ONLY. Scripts are written
            in the Studio (the API/webhook sync keeps this fresh); the
            photographer directs the agent from it in the field. */}
        {isVideo &&
          (project.reelHook || project.reelScript ? (
            <ReelScriptCard
              hook={project.reelHook}
              script={project.reelScript}
              song={project.reelSong}
              shotList={project.reelShotList}
              updatedAt={project.reelRecipeUpdatedAt}
            />
          ) : (
            <div className="rounded-2xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-foreground/85">
              <span className="font-semibold">No script yet.</span> This reel&rsquo;s script is written in Script
              Studio and shows up here automatically once it&rsquo;s ready — check back before you press record, or
              ask Jordan.
            </div>
          ))}
        {isVideo && <AocPlaybookCard context="shoot" />}
        <CustomerCard client={client} segment={segment} profile={profile} />
        <NotesCard projectId={project.id} initial={project.editorBrief ?? ""} flash={flash} />
        <MediaCard media={media} uploaded={project.uploadedAt != null} />
        {pay}
      </div>

      <ActionBar
        view={view}
        projectId={project.id}
        initialCompletedISO={appointment?.completedAtISO ?? null}
        total={captureables.length}
        captured={capturedCount}
        flash={flash}
      />

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-32 z-[1400] flex justify-center px-4">
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

// The free-form "message the client" composer, as a bottom sheet off the
// action bar (it lived in a mid-page card before — the July 2026 field-UX
// audit moved every quick action into the always-visible bar).
function MessageSheet({
  projectId, noPhone, onClose, flash,
}: {
  projectId: string;
  noPhone: boolean;
  onClose: () => void;
  flash: (k: "ok" | "err", t: string) => void;
}) {
  const [msg, setMsg] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [polished, setPolished] = useState(false);
  const [pending, start] = useTransition();

  async function polish() {
    if (!msg.trim()) return;
    setDrafting(true);
    try {
      const r = await draftClientMessage(projectId, msg);
      if (r.ok && r.text) { setMsg(r.text); setPolished(true); }
      else flash("err", r.error || "Couldn’t draft");
    } finally { setDrafting(false); }
  }

  function sendMsg() {
    if (!msg.trim()) return;
    start(async () => {
      const r = await sendClientMessage(projectId, msg);
      if (r.ok) { flash("ok", "Message sent to client"); onClose(); }
      else flash("err", r.message);
    });
  }

  return (
    <div className="fixed inset-0 z-[1400] flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl border bg-surface p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="size-4 text-brand" /> Message the client</h3>
          <button onClick={onClose} className="text-muted-2 hover:text-foreground"><X className="size-4" /></button>
        </div>
        {noPhone && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="size-3.5" /> No phone number on file for this client — texts can’t be sent.
          </div>
        )}
        <AutoTextarea
          autoFocus
          value={msg}
          onChange={(e) => { setMsg(e.target.value); setPolished(false); }}
          minRows={3}
          placeholder="Type a quick note — e.g. running 10 min late, gate code didn’t work…"
          className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
        {polished && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-brand"><Sparkles className="size-3" /> AI polished — edit as needed before sending</div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={polish}
            disabled={!msg.trim() || drafting}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-40"
          >
            {drafting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Polish with AI
          </button>
          <button
            onClick={sendMsg}
            disabled={!msg.trim() || pending || noPhone}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-40"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send
          </button>
        </div>
      </div>
    </div>
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
        <AutoTextarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          minRows={4}
          className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
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

// COLLAPSED by default (July 2026 field-UX audit): the long working profile
// buried the checklist under paragraphs. The summary row keeps what the field
// needs at a glance — who, their tier, one summary line, and one-tap
// call/text/email — and the full profile (dos/donts, shoot notes) is one tap
// away when it matters.
function CustomerCard({
  client, segment, profile,
}: {
  client: ShootView["client"];
  segment: ShootView["segment"];
  profile: ShootView["profile"];
}) {
  const isVip = segment?.key === "vip";
  const [open, setOpen] = useState(false);
  const hasMore = !!profile || !!client.editingPreferences;

  return (
    <section className="panel-shadow rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          onClick={() => hasMore && setOpen((v) => !v)}
          className={cn("flex min-w-0 flex-1 items-center gap-2 text-left", hasMore && "cursor-pointer")}
        >
          {isVip && <Crown className="size-4 shrink-0 text-warning" />}
          <span className="truncate font-semibold">{client.name}</span>
          {segment && <Badge color={segment.color}>{segment.label}</Badge>}
          {client.socialClient && <Badge color={PALETTE.violet}>Social{client.socialPlan ? ` · ${client.socialPlan}` : ""}</Badge>}
          {profile?.touchLevel && <Chip label={`${profile.touchLevel} touch`} />}
          {hasMore && (
            <ChevronRight className={cn("ml-auto size-4 shrink-0 text-muted-2 transition-transform", open && "rotate-90")} />
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
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
      </div>

      {/* Collapsed: one clamped summary line so they know who they're shooting
          for without scrolling. Expanded: the full working profile. */}
      {!open && profile?.summary && (
        <button onClick={() => setOpen(true)} className="block w-full px-4 pb-3 text-left">
          <p className="line-clamp-2 text-sm text-muted">{profile.summary}</p>
          <span className="mt-1 inline-block text-xs font-medium text-brand">Show full profile</span>
        </button>
      )}
      {!open && !profile && (
        <p className="px-4 pb-3 text-sm text-muted-2">
          {client.editingPreferences ? `Editing notes: ${client.editingPreferences}` : "No working profile yet — this builds up as we do more shoots together."}
        </p>
      )}

      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3">
          {profile ? (
            <>
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
            </>
          ) : (
            <p className="text-sm text-muted">Editing notes: {client.editingPreferences}</p>
          )}
        </div>
      )}
    </section>
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

function BriefRow({ icon: Icon, label, value, tone = "default", mono }: { icon: LucideIcon; label: string; value: string; tone?: "default" | "key" | "warning"; mono?: boolean }) {
  const accent = tone === "key" ? "text-brand" : tone === "warning" ? "text-warning" : "text-muted";
  return (
    <div className="flex gap-2.5">
      <Icon className={cn("mt-0.5 size-4 shrink-0", accent)} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{label}</div>
        <div className={cn("text-sm text-foreground/85", mono && "font-mono text-base font-semibold tracking-wide text-foreground")}>{value}</div>
      </div>
    </div>
  );
}

function ZillowCta({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-2xl border border-brand/30 bg-brand-soft/40 p-4 transition-colors hover:bg-brand-soft/60"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand"><Box className="size-5" /></span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">Capture Zillow 3D Home Tour</div>
        <div className="text-xs text-muted">Open the Zillow 3D tour link from this order</div>
      </div>
      <ExternalLink className="size-4 shrink-0 text-muted-2" />
    </a>
  );
}

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
  const p = appointment?.parsed ?? null;
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

      {p ? (
        <div className="space-y-3">
          {p.lockbox && <BriefRow icon={KeyRound} label="Lockbox / door code" value={p.lockbox} tone="key" mono />}
          {p.access && <BriefRow icon={DoorOpen} label="Getting in" value={p.access} />}
          {p.presence && <BriefRow icon={Home} label="At the property" value={p.presence} />}
          {p.special && <BriefRow icon={AlertTriangle} label="Special instructions" value={p.special} tone="warning" />}
          {p.timing && <BriefRow icon={Clock} label="Timing" value={p.timing} />}
          {p.orderNotes && <BriefRow icon={FileText} label="Order notes" value={p.orderNotes} />}
          {p.extra.map((e, i) => <BriefRow key={i} icon={Info} label={e.label} value={e.value} />)}
        </div>
      ) : hasBrief ? (
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
  deliverables, captured, onToggle, mustGets, agentNotes, staging, photoTarget,
}: {
  deliverables: ShootView["deliverables"];
  captured: Record<string, boolean>;
  onToggle: (id: string) => void;
  mustGets: string[];
  agentNotes: string[];
  staging: boolean;
  photoTarget: number | null;
}) {
  const total = deliverables.length;
  const done = Object.values(captured).filter(Boolean).length;

  if (total === 0 && mustGets.length === 0 && agentNotes.length === 0 && !staging) return null;

  return (
    <Section icon={Camera} title="What to capture" count={total > 0 ? `${done}/${total}` : undefined} bodyClassName="space-y-1.5">
      {/* Photo budget for THIS home (counts only). Culling in the field is far
          cheaper than culling after AutoHDR blends every bracket. */}
      {photoTarget != null && (
        <div className="mb-1">
          <CullingReminder compact target={photoTarget} hidePay />
        </div>
      )}
      {/* Agent-specific must-gets — the things that aren't a standard deliverable
          but WILL come back as a revision if missed. Surfaced first, on purpose. */}
      {mustGets.length > 0 && (
        <div className="mb-1 rounded-xl border border-warning/40 bg-warning-soft p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
            <AlertTriangle className="size-3.5" /> Don’t leave without
          </div>
          <ul className="mt-1.5 space-y-1">
            {mustGets.map((m, i) => (
              <li key={i} className="flex gap-2 text-sm text-foreground/90">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {total > 0 && (
        <p className="mb-1 text-xs text-muted">Everything this order needs. Tick each one as you capture it, and confirm the list before you mark the shoot complete.</p>
      )}
      {deliverables.map((d) => {
        const on = captured[d.id];
        const meta = DELIVERABLE_META[d.type];
        const guide = CAPTURE_GUIDE[d.type] ?? CAPTURE_GUIDE.OTHER;
        return (
          <button
            key={d.id}
            onClick={() => onToggle(d.id)}
            className={cn(
              "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
              on ? "border-success/40 bg-success-soft/30" : "bg-surface hover:bg-surface-2",
            )}
          >
            {on ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted-2" />}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span>{meta?.label ?? d.type}{d.quantity > 1 ? <span className="text-muted"> ×{d.quantity}</span> : null}</span>
                {d.uploadCount > 0 && <span className="ml-auto shrink-0 text-[11px] font-normal text-muted-2">{d.uploadCount} uploaded</span>}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted">{guide}</span>
              {/* Room-by-room photo budget, on the PHOTOS row only — turns
                  "aim ~N" into a concrete plan (counts only, never money). */}
              {d.type === "PHOTOS" && photoTarget != null && (
                <span className="mt-1 block text-xs leading-snug text-warning">{roomBudgetText(photoTarget)}</span>
              )}
            </span>
          </button>
        );
      })}

      {/* Editing-only deliverable (e.g. virtual staging): not captured on-site,
          but the photographer still needs to shoot it a specific way. */}
      {staging && (
        <div className="flex items-start gap-3 rounded-xl border border-dashed px-3 py-2.5">
          <Sparkles className="mt-0.5 size-5 shrink-0 text-muted-2" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Virtual staging <span className="font-normal text-muted-2">— done in editing</span></span>
            <span className="mt-0.5 block text-xs leading-snug text-muted">Nothing to capture for this one. Just shoot the rooms to be staged empty, clean, and straight-on so the editor can furnish them.</span>
          </span>
        </div>
      )}

      {/* Softer working context for this agent — good to know, not a gate. */}
      {agentNotes.length > 0 && (
        <div className="mt-1 rounded-xl border bg-surface-2/40 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
            <Info className="size-3.5" /> Good to know for this agent
          </div>
          <ul className="mt-1.5 space-y-1">
            {agentNotes.map((n, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-2" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
      <AutoTextarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        minRows={3}
        placeholder="e.g. House faces west so exteriors are backlit, recover sky. Seller wants the pool emphasized. Skip the cluttered office."
        className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
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

// The floating ACTION BAR — every quick action one thumb away, always visible
// (July 2026 field-UX audit; Jordan: "status updates should be a floating bar
// at the bottom"). Two compact rows:
//   · status texts (On my way / Arrived / Complete — each opens the drafted
//     text for review) + the free-form message sheet
//   · capture progress + the primary Mark-complete → Upload flow
function ActionBar({
  view, projectId, initialCompletedISO, total, captured, flash,
}: {
  view: ShootView;
  projectId: string;
  initialCompletedISO: string | null;
  total: number;
  captured: number;
  flash: (k: "ok" | "err", t: string) => void;
}) {
  const { project, client } = view;
  const [completed, setCompleted] = useState(initialCompletedISO != null);
  const [sheet, setSheet] = useState<{ kind: ShootStatusKind; text: string } | null>(null);
  const [msgOpen, setMsgOpen] = useState(false);
  const [sent, setSent] = useState<Set<ShootStatusKind>>(new Set());
  const [pending, start] = useTransition();
  const noPhone = !client.phoneE164;

  function openStatus(kind: ShootStatusKind) {
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
      <div className="mx-auto max-w-2xl px-4 py-2.5 sm:px-6">
        {/* Row 1 — client comms: the three drafted status texts + free-form message */}
        <div className="flex items-center gap-1.5">
          {STATUS_ORDER.map((kind) => {
            const done = sent.has(kind);
            return (
              <button
                key={kind}
                onClick={() => openStatus(kind)}
                disabled={noPhone}
                title={noPhone ? "No phone number on file for this client" : `Text the client: ${SHOOT_STATUS_META[kind].label}`}
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40",
                  done ? "border-success/40 bg-success-soft/40 text-success" : "bg-surface hover:bg-surface-2",
                )}
              >
                {done ? <CheckCircle2 className="size-3.5" /> : kind === "complete" ? <Check className="size-3.5 text-muted" /> : <Navigation className="size-3.5 text-brand" />}
                <span className="truncate">{SHOOT_STATUS_META[kind].label}</span>
              </button>
            );
          })}
          <button
            onClick={() => setMsgOpen(true)}
            title="Message the client"
            className="inline-flex shrink-0 items-center justify-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-[11px] font-medium hover:bg-surface-2"
          >
            <MessageSquare className="size-3.5 text-brand" /> <span className="hidden sm:inline">Message</span>
          </button>
        </div>

        {/* Row 2 — progress + the primary action */}
        <div className="mt-2 flex items-center gap-3">
          {completed ? (
            <>
              <div className="flex items-center gap-1.5 text-sm font-medium text-success">
                <CheckCircle2 className="size-4" /> Shoot complete
              </div>
              <Link
                href={`/upload/${projectId}`}
                className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90"
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
                className="ml-auto inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Mark shoot complete
              </button>
            </>
          )}
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
      {msgOpen && <MessageSheet projectId={projectId} noPhone={noPhone} onClose={() => setMsgOpen(false)} flash={flash} />}
    </div>
  );
}
