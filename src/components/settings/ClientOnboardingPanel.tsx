"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { Check, ChevronDown, Copy, ExternalLink, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { contentHref } from "@/lib/contentNav";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";
import {
  ONBOARDING_MESSAGES, STEP3_TOGGLES, SWITCH_WOULD, dayET, messageOf, toggleOf, whenET,
  type OnboardingChannel, type OnboardingLogEntry, type OnboardingStep, type OnboardingToggle, type StepStatus,
} from "@/lib/clientOnboardingCore";
import type { OnboardingDetail, OnboardingListRow, OnboardingMessageView, OnboardingToggleView } from "@/lib/clientOnboarding";
import {
  createOnboardingSeatAction, markOnboardingSentAction, sendOnboardingMessageAction, setOnboardedAction, setOnboardingToggleAction,
} from "@/app/settings/onboarding/actions";
import { approveStrategy, issuePortalLink, releaseStrategy } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// CLIENT ONBOARDING — the panel (Oct 5 2026). One client at a time: the list
// (a disclosure on a phone, a column from md up) and the seven steps. Every
// control here is Jordan's (canAct); everyone else reads it. A toggle flips
// at once and saves in the background; a send says "Sending…" at once and
// then what the outbox said. Nothing on this panel sends by being opened,
// toggled or refreshed — only "Send now" sends, after a second press.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };

const CHIP: Record<OnboardingListRow["chip"], string> = {
  "Not started": "bg-surface-2 text-muted",
  "In progress": "bg-warning/15 text-warning",
  Onboarded: "bg-success/15 text-success",
};
const STATUS: Record<StepStatus, { label: string; cls: string }> = {
  done: { label: "Done", cls: "bg-success/15 text-success" },
  needs_you: { label: "Needs you", cls: "bg-warning/15 text-warning" },
  blocked: { label: "Blocked", cls: "bg-surface-2 text-muted" },
};
const link = "font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand";
const field = "mt-0.5 min-h-11 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm";

/** A save that answers in the background, with one line of outcome. */
function useAction() {
  const router = useRouter();
  const [note, setNote] = useState<Result | null>(null);
  const [busy, start] = useTransition();
  const running = useRef(false);
  const run = (op: () => Promise<Result>, after?: (r: Result) => void) => {
    if (running.current) return;
    running.current = true;
    setNote(null);
    start(async () => {
      try {
        const r = await op().catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "The request did not finish. Reload to see what was saved." }));
        setNote(r);
        after?.(r);
        router.refresh();
      } finally {
        running.current = false;
      }
    });
  };
  return { note, busy, run, setNote };
}

function Note({ note, busy, busyText }: { note: Result | null; busy: boolean; busyText: string }) {
  if (busy) return <SaveStatus state="saving" message={busyText} />;
  if (!note) return null;
  return <SaveStatus state={note.ok ? "info" : "error"} message={note.message} />;
}

// ---- the list ----------------------------------------------------------------

function ClientList({ list, selectedId }: { list: OnboardingListRow[]; selectedId: string | null }) {
  const real = list.filter((r) => !r.isTest);
  const tests = list.filter((r) => r.isTest);
  const row = (r: OnboardingListRow) => (
    <li key={r.clientId}>
      <Link
        href={`/settings/onboarding?client=${encodeURIComponent(r.clientId)}`}
        aria-current={r.clientId === selectedId ? "page" : undefined}
        data-onboarding-client={r.clientId}
        className={cn("flex min-h-11 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand", r.clientId === selectedId && "bg-surface-2 font-medium")}
      >
        <span className="min-w-0 truncate">
          {r.name}
          {r.trial && <span className="ml-1 text-[11px] text-muted">trial</span>}
          {r.paused && <span className="ml-1 text-[11px] text-muted">paused</span>}
        </span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", r.isTest ? "bg-brand/10 text-brand" : CHIP[r.chip])}>{r.isTest ? "TEST" : r.chip}</span>
      </Link>
    </li>
  );
  const body = (
    <div className="space-y-3">
      {real.length ? <ul className="space-y-0.5">{real.map(row)}</ul> : <p className="text-sm text-muted">No client has an active or paused program.</p>}
      {tests.length > 0 && (
        <div>
          <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Your TEST clients</p>
          <ul className="space-y-0.5">{tests.map(row)}</ul>
        </div>
      )}
    </div>
  );
  const current = list.find((r) => r.clientId === selectedId);
  return (
    <>
      <details className="rounded-xl border border-border bg-surface p-2 md:hidden" open={!selectedId}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-1 text-sm font-medium">
          <span className="min-w-0 truncate">{current ? current.name : `Choose a client (${list.length})`}</span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
        </summary>
        <div className="mt-2">{body}</div>
      </details>
      <nav aria-label="Program clients" className="hidden md:block">{body}</nav>
    </>
  );
}

// ---- one step ------------------------------------------------------------------

function StepCard({ step, open, children }: { step: OnboardingStep; open: boolean; children: React.ReactNode }) {
  const s = STATUS[step.status];
  return (
    <details open={open} data-step={step.key} data-step-status={step.status} className="group rounded-xl border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-start gap-3 px-3 py-2.5">
        <span className={cn("mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold", step.status === "done" ? "bg-success/15 text-success" : "bg-surface-2 text-muted")}>
          {step.status === "done" ? <Check className="size-3.5" aria-hidden /> : step.n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{step.title}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", s.cls)}>{s.label}</span>
          </span>
          <span className="block text-[13px] text-muted">{step.line}</span>
        </span>
        <ChevronDown className="mt-1 size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3 text-sm">{children}</div>
    </details>
  );
}

// ---- step 2: strategy ----------------------------------------------------------------

function StrategyStep({ d, canAct }: { d: OnboardingDetail; canAct: boolean }) {
  const { note, busy, run } = useAction();
  const [confirming, setConfirming] = useState<"approve" | "release" | null>(null);
  const s = d.strategy;
  const read = contentHref(d.enrollment.id, { tab: "plan", view: "strategy" });
  return (
    <>
      {s.inReview && (
        <div className="space-y-2">
          <p>Version {s.inReview.versionNo} is waiting for your approval. <Link href={read} className={link}>Read it on Plan › Strategy</Link>.</p>
          {canAct && (confirming === "approve"
            ? <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px]">Approve version {s.inReview.versionNo} under your name?{s.approved ? ` It replaces version ${s.approved.versionNo} as the approved one.` : ""} The client sees it only once you release it.</span>
                <Button busy={busy} onClick={() => run(() => approveStrategy(s.inReview!.id), () => setConfirming(null))}>Yes, approve</Button>
                <Button variant="quiet" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
              </div>
            : <Button variant="secondary" disabled={busy} onClick={() => setConfirming("approve")}>Approve version {s.inReview.versionNo}</Button>)}
        </div>
      )}
      {s.approved && (
        <div className="space-y-2">
          <p>
            Version {s.approved.versionNo} approved{s.approved.approvedBy ? ` by ${s.approved.approvedBy}` : ""}{s.approved.approvedAt ? ` on ${dayET(s.approved.approvedAt)}` : ""}.{" "}
            {s.approved.releasedAt ? `Released to their portal on ${dayET(s.approved.releasedAt)}.` : "Not released to their portal yet."}
          </p>
          {!s.approved.releasedAt && (
            <p className="text-[13px] text-muted">
              {s.releaseEmails
                ? "Releasing it ALSO emails them \"Your Content Strategy is Ready\" right now, because the scripts-ready email switch and their Automatic program emails are both on."
                : "Releasing it shows it in their portal. It does not email them; tell them yourself from step 5."}
            </p>
          )}
          {canAct && !s.approved.releasedAt && (confirming === "release"
            ? <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px]">Release version {s.approved.versionNo} to {d.client.name}&rsquo;s portal?</span>
                <Button busy={busy} onClick={() => run(() => releaseStrategy(s.approved!.id), () => setConfirming(null))}>Yes, release</Button>
                <Button variant="quiet" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
              </div>
            : <Button variant="secondary" disabled={busy} onClick={() => setConfirming("release")}>Release to their portal</Button>)}
        </div>
      )}
      {!s.inReview && !s.approved && (s.draftNo
        ? <p>Version {s.draftNo} is still a draft. Finish it and send it for approval on <Link href={read} className={link}>Plan › Strategy</Link>.</p>
        : <p>No strategy on file yet. Draft or upload it on <Link href={read} className={link}>Plan › Strategy</Link>.</p>)}
      <Note note={note} busy={busy} busyText="Saving…" />
    </>
  );
}

// ---- step 3 and 6: toggles ------------------------------------------------------------

/**
 * What the automatic switches behind a toggle WOULD do, each with its state —
 * plain words, never a nudge to turn one on (Oct 5 2026 review fix). A toggle
 * with no switch ("Messages I send myself") has nothing automatic to say.
 */
function SwitchLine({ v }: { v: OnboardingToggleView }) {
  if (!v.switches.length) return null;
  return (
    <ul className="mt-0.5 space-y-0.5 text-[12px] text-muted" aria-label="Automatic, and only while its switch is on">
      {v.switches.map((s) => (
        <li key={s.key}>
          {s.title} <span className={s.on ? "font-medium text-warning" : "text-muted"}>({s.on ? "on" : "off"})</span>
          {SWITCH_WOULD[s.key] ? <> — {SWITCH_WOULD[s.key]}</> : null}
        </li>
      ))}
      {v.lockedToTest && <li>Its own &ldquo;TEST clients only&rdquo; lock is on, so it still reaches only TEST clients.</li>}
    </ul>
  );
}

function ToggleRow({ t, v, disabled, onChange }: { t: OnboardingToggle; v: OnboardingToggleView; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <li data-toggle={t.key} data-toggle-on={v.on ? "1" : "0"} className="flex items-start gap-3 py-2">
      <button
        type="button" role="switch" aria-checked={v.on} aria-label={`${t.label} for this client`} disabled={disabled}
        onClick={() => onChange(!v.on)}
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
      >
        <span aria-hidden className={cn("relative h-6 w-11 rounded-full transition-colors", v.on ? "bg-success" : "bg-surface-2 ring-1 ring-border")}>
          <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", v.on ? "left-[22px]" : "left-0.5")} />
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t.label}</p>
        <p className="text-[13px] text-muted">{t.words}</p>
        {t.careful && <p className="text-[13px] text-warning">{t.careful}</p>}
        <SwitchLine v={v} />
      </div>
    </li>
  );
}

function useToggles(d: OnboardingDetail) {
  const { note, busy, run } = useAction();
  // Optimistic: the switch flips at once; the refresh brings the saved truth
  // (a new `d`), which retires every optimistic value made against the old one.
  const [pending, setPending] = useState<{ base: OnboardingDetail; map: Record<string, boolean> } | null>(null);
  // A turn-on refused because other clients still have choices on file: the
  // one-press way through, "Turn on for <client> only" (Oct 5 2026).
  const [choice, setChoice] = useState<{ key: string; others: string[] } | null>(null);
  const map = pending?.base === d ? pending.map : {};
  const view = (key: string): OnboardingToggleView => {
    const v = d.toggles.find((x) => x.key === key)!;
    return key in map ? { ...v, on: map[key] } : v;
  };
  const change = (key: string, on: boolean, onlyThisClient = false) => {
    setChoice(null);
    setPending({ base: d, map: { ...map, [key]: on } });
    run(() => setOnboardingToggleAction({ clientId: d.client.id, toggle: key, on, onlyThisClient }), (r) => {
      if (r.ok) return;
      setPending((p) => { if (!p) return p; const n = { ...p.map }; delete n[key]; return { ...p, map: n }; });
      const others = (r as Result & { othersOnFile?: string[] }).othersOnFile;
      if (on && others?.length) setChoice({ key, others });
    });
  };
  return { note, busy, view, change, choice };
}

function OnlyThisClient({ d, choice, busy, change }: { d: OnboardingDetail; choice: { key: string; others: string[] } | null; busy: boolean; change: (key: string, on: boolean, onlyThisClient?: boolean) => void }) {
  if (!choice) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 p-2 text-[13px]" data-only-this-client>
      <Button variant="secondary" disabled={busy} onClick={() => change(choice.key, true, true)}>Turn on for {d.client.name} only</Button>
      <span className="text-muted">sets {choice.others.join(", ")} to nothing · or change <Link href="/settings#program-rollout" className={link}>Who the program may reach</Link> first</span>
    </div>
  );
}

function FeaturesStep({ d, canAct }: { d: OnboardingDetail; canAct: boolean }) {
  const { note, busy, view, change, choice } = useToggles(d);
  if (d.client.isTest) {
    return <p>{d.client.name} is one of your TEST clients. A TEST client always gets everything that is switched on, and only ever at your verified test inbox or phone, so there is nothing to turn on here.</p>;
  }
  const r = d.rollout;
  const frozen = !canAct || !!r.problem || d.enrollment.status !== "ACTIVE";
  return (
    <>
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
        Turning something on only <strong>allows</strong> it for {d.client.name}. It never sends anything by itself. The automatic ones work only while their switch in Content program automations is on; under each is what that switch would do, and whether it is on. This page never turns a switch on.
      </p>
      {r.problem && <p className="text-[13px] text-warning">The stored program reach could not be read, so nothing can be changed here until it is fixed: {r.problem}.</p>}
      {r.mode === "ALL" && <p className="text-[13px] text-warning">Content program automations are set to reach every client, so these choices only take effect if that is set back to named clients (bookings follow them either way).</p>}
      {r.pilotState === "EXPIRED" && <p className="text-[13px] text-warning">The named-client list ended after {r.endsOn}. Change or remove its end date in <Link href="/settings#program-rollout" className={link}>Who the program may reach</Link> before allowing anything new.</p>}
      {d.enrollment.status !== "ACTIVE" && <p className="text-[13px] text-muted">Their program is {d.enrollment.status.toLowerCase()}, so nothing new can be turned on.</p>}
      {d.reachNote && <p className="text-[13px] text-warning">What is on here is saved, but it does not reach {d.client.name} yet: {d.reachNote}.</p>}
      <ul className="divide-y divide-border">
        {STEP3_TOGGLES.map((t) => <ToggleRow key={t.key} t={t} v={view(t.key)} disabled={frozen || busy} onChange={(on) => change(t.key, on)} />)}
      </ul>
      <p className="text-[12px] text-muted">Booking filming sessions is chosen in step 6.</p>
      <Note note={note} busy={busy} busyText="Saving… nothing is sent" />
      {canAct && <OnlyThisClient d={d} choice={choice} busy={busy} change={change} />}
    </>
  );
}

function FilmingStep({ d, canAct }: { d: OnboardingDetail; canAct: boolean }) {
  const { note, busy, view, change, choice } = useToggles(d);
  const b = d.booking;
  const v = view("bookings");
  const auto = d.client.isTest ? false : v.on;
  const disabled = !canAct || busy || d.client.isTest || !!d.rollout.problem;
  return (
    <>
      <fieldset className="space-y-1" disabled={disabled}>
        <legend className="sr-only">How this client&rsquo;s filming sessions are booked</legend>
        <label className="flex min-h-11 items-start gap-2 py-1">
          <input type="radio" name="booking-mode" className="mt-1" checked={!auto} onChange={() => change("bookings", false)} />
          <span><span className="font-medium">Kyle books by hand</span> <span className="text-muted">— their session requests land on Kyle&rsquo;s desk and he books them in Aryeo.</span></span>
        </label>
        <label className={cn("flex min-h-11 items-start gap-2 py-1", !b.autoAvailable && !auto && "opacity-60")}>
          <input type="radio" name="booking-mode" className="mt-1" checked={auto} disabled={!b.autoAvailable && !auto} onChange={() => change("bookings", true)} />
          <span><span className="font-medium">{toggleOf("bookings").label}</span> <span className="text-muted">— {toggleOf("bookings").words}</span></span>
        </label>
      </fieldset>
      {!b.autoAvailable && <p className="text-[13px] text-muted">Automatic booking can&rsquo;t be chosen yet: {b.whyNot.join("; ")}.</p>}
      {!d.client.isTest && <SwitchLine v={v} />}
      <Note note={note} busy={busy} busyText="Saving… nothing is sent" />
      {canAct && <OnlyThisClient d={d} choice={choice} busy={busy} change={change} />}
    </>
  );
}

// ---- step 4: portal account ---------------------------------------------------------------

function PortalStep({ d, canAct }: { d: OnboardingDetail; canAct: boolean }) {
  const { note, busy, run, setNote } = useAction();
  const emails = d.messages[0]?.recipients.filter((r) => r.channel === "email").map((r) => r.toRef) ?? [];
  const [email, setEmail] = useState(emails[0] ?? "");
  const [name, setName] = useState(d.client.name);
  const [copying, startCopy] = useTransition();
  const live = d.seats.filter((s) => !s.revoked);
  const owner = live.some((s) => s.role === "OWNER");
  const accountsOn = d.client.isTest || d.toggles.find((t) => t.key === "accounts")?.on;
  return (
    <>
      {live.length > 0 && (
        <ul className="space-y-1">
          {live.map((s) => (
            <li key={s.membershipId} className="text-[13px]">
              <span className="font-medium">{s.email}</span> · {s.role.toLowerCase()}
              {s.lastLoginAt ? ` · last signed in ${dayET(s.lastLoginAt)}` : " · has not signed in yet"}
            </li>
          ))}
        </ul>
      )}
      {!owner && !accountsOn && <p className="text-muted">Turn on &ldquo;{toggleOf("accounts").label}&rdquo; in step 3 first.</p>}
      {!owner && accountsOn && canAct && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-[13px]">Creates their account so you can share the portal link yourself. <strong>No email is sent.</strong></p>
          <label className="block text-[13px] text-muted">Email they sign in with
            <input className={field} value={email} onChange={(e) => setEmail(e.target.value)} list="onboarding-emails" autoComplete="off" inputMode="email" />
            <datalist id="onboarding-emails">{emails.map((e) => <option key={e} value={e} />)}</datalist>
          </label>
          <label className="block text-[13px] text-muted">Their name
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <Button busy={busy} busyLabel="Creating…" disabled={!email.trim()} onClick={() => run(() => createOnboardingSeatAction({ clientId: d.client.id, email, name }))}>
            Create the account without emailing
          </Button>
        </div>
      )}
      {d.heldWelcome && <p className="text-[13px] text-muted">A welcome for {d.heldWelcome.email} has been held since their payment ({dayET(d.heldWelcome.since)}). It is cleared when you create that account here, so it never goes out on its own.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {canAct && (
          <Button variant="secondary" busy={copying} onClick={() => startCopy(async () => {
            const r = await issuePortalLink(d.enrollment.id).catch(() => ({ ok: false, message: "The link could not be read. Try again.", url: undefined }));
            if (r.ok && r.url) {
              await navigator.clipboard?.writeText(r.url).catch(() => {});
              setNote({ ok: true, message: "Portal link copied. Paste it into your own text or email when you're ready. Nothing was sent." });
            } else setNote({ ok: false, message: r.message });
          })}>
            <Copy className="size-4" aria-hidden />Copy portal link
          </Button>
        )}
        {canAct && <Link href={`/content/${d.enrollment.id}/preview`} className={cn(link, "inline-flex min-h-11 items-center gap-1 text-sm")}><ExternalLink className="size-3.5" aria-hidden />See their portal</Link>}
      </div>
      <p className="text-[13px] text-muted">
        {d.portal.signInByEmail ? "They can also sign in with their email address: the sign-in page emails them a one-time link." : `Signing in with their email doesn't work yet: ${d.portal.signInWhyNot}. The portal link works without it.`}
      </p>
      <Note note={note} busy={busy || copying} busyText="Working…" />
    </>
  );
}

// ---- step 5: messages -----------------------------------------------------------------------

function MessageCard({ d, m, canAct }: { d: OnboardingDetail; m: OnboardingMessageView; canAct: boolean }) {
  const def = messageOf(m.key);
  const channels = useMemo(() => ([...new Set(m.recipients.map((r) => r.channel))] as OnboardingChannel[]), [m.recipients]);
  const [channel, setChannel] = useState<OnboardingChannel>(channels[0] ?? "email");
  const options = useMemo(() => m.recipients.filter((r) => r.channel === channel), [m.recipients, channel]);
  const [chosenTo, setTo] = useState(options[0]?.toRef ?? "");
  // The recipient is always one on the list: a choice that left it falls back to the first.
  const to = options.some((o) => o.toRef === chosenTo) ? chosenTo : options[0]?.toRef ?? "";
  // null = the composed wording (it follows a refresh); a string = Jordan's edit.
  const [draft, setDraft] = useState<string | null>(null);
  const body = draft ?? m.body[channel];
  const edited = draft !== null;
  const [confirming, setConfirming] = useState<"send" | "mark" | null>(null);
  const { note, busy, run } = useAction();
  const intent = useRef<string | null>(null);
  const last = m.last;
  const toLabel = options.find((o) => o.toRef === to);
  const send = () => {
    intent.current = intent.current ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
    const intentId = intent.current;
    run(() => sendOnboardingMessageAction({ clientId: d.client.id, message: m.key, channel, toRef: to, body, intentId }), (r) => {
      setConfirming(null);
      // A finished press: the next press is a new message.
      if (r.ok || !/could not be queued|being sent/.test(r.message)) intent.current = null;
    });
  };
  return (
    <details data-message={m.key} className="group rounded-lg border border-border">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="font-medium">{def.label}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", last ? "bg-success/15 text-success" : "bg-surface-2 text-muted")}>
          {last ? `${last.kind === "sent" ? "Sent" : "Marked sent"} ${dayET(last.at)}` : "Not sent"}
        </span>
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-3">
        {!m.allowed && <p className="text-[13px] text-warning">{m.blockedWhy}</p>}
        {m.recipients.length === 0 && <p className="text-[13px] text-muted">{d.client.isTest ? "This TEST client has no address that is your verified test inbox or phone, so the hub can't send it." : "No email or phone on file for this client."}</p>}
        <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
          {channels.length > 1 && (
            <label className="block text-[13px] text-muted">How
              <select className={field} value={channel} disabled={!canAct} onChange={(e) => { setChannel(e.target.value as OnboardingChannel); setDraft(null); setConfirming(null); }}>
                {channels.map((c) => <option key={c} value={c}>{c === "email" ? "Email" : "Text"}</option>)}
              </select>
            </label>
          )}
          <label className="block min-w-0 text-[13px] text-muted">To
            <select className={field} value={to} disabled={!canAct || options.length < 2} onChange={(e) => { setTo(e.target.value); setConfirming(null); }}>
              {options.map((o) => <option key={o.toRef} value={o.toRef}>{o.channel === "sms" ? o.label : `${o.toRef} (${o.label})`}</option>)}
            </select>
          </label>
        </div>
        {channel === "email" && <p className="text-[13px]"><span className="text-muted">Subject:</span> {def.subject}</p>}
        <label className="block text-[13px] text-muted">Message (edit it as you like)
          <textarea
            className={cn(field, "min-h-48 font-[inherit] leading-relaxed")} value={body} readOnly={!canAct}
            onChange={(e) => { setDraft(e.target.value); setConfirming(null); }}
          />
        </label>
        {m.note && <p className="text-[13px] text-muted">{m.note}</p>}
        {canAct && (
          <div className="flex flex-wrap items-center gap-2">
            {edited && <Button variant="quiet" disabled={busy} onClick={() => setDraft(null)}>Reset wording</Button>}
            {confirming === "send" ? (
              <>
                <span className="text-[13px]">Send this {channel === "email" ? "email" : "text"} to {toLabel?.channel === "sms" ? toLabel.label.replace(/^text /, "") : to} now?</span>
                <Button busy={busy} busyLabel="Sending…" onClick={send}><Send className="size-4" aria-hidden />Yes, send it</Button>
                <Button variant="quiet" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
              </>
            ) : confirming === "mark" ? (
              <>
                <span className="text-[13px]">Record that you sent it yourself{to ? ` to ${toLabel?.channel === "sms" ? toLabel.label.replace(/^text /, "") : to}` : ""}? The hub sends nothing.</span>
                <Button variant="secondary" busy={busy} onClick={() => run(() => markOnboardingSentAction({ clientId: d.client.id, message: m.key, channel, toRef: to || null }), () => setConfirming(null))}>Yes, record it</Button>
                <Button variant="quiet" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
              </>
            ) : (
              <>
                <Button disabled={busy || !m.allowed || !to || !body.trim()} onClick={() => setConfirming("send")}><Send className="size-4" aria-hidden />Send now</Button>
                <Button variant="secondary" disabled={busy} onClick={() => setConfirming("mark")}>Mark as sent by me</Button>
              </>
            )}
          </div>
        )}
        <Note note={note} busy={busy} busyText={confirming === "send" ? `Sending to ${to}…` : "Saving…"} />
        {last && <p className="text-[12px] text-muted">Last: {last.kind === "sent" ? "sent by the hub" : "marked sent"} {whenET(last.at)} by {last.by}{last.to ? ` to ${last.to}` : ""}.</p>}
      </div>
    </details>
  );
}

// ---- step 7 and the log ---------------------------------------------------------------------

function DoneStep({ d, canAct }: { d: OnboardingDetail; canAct: boolean }) {
  const { note, busy, run } = useAction();
  const at = d.record.onboardedAt;
  return (
    <>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={!!at} disabled={!canAct || busy} onChange={(e) => run(() => setOnboardedAction({ clientId: d.client.id, done: e.target.checked }))} />
        <span className="font-medium">Onboarded</span>
        {at && <span className="text-muted">— {dayET(at)}{d.record.onboardedBy ? ` by ${d.record.onboardedBy}` : ""}</span>}
      </label>
      <Note note={note} busy={busy} busyText="Saving…" />
    </>
  );
}

const LOG_WORDS: Record<OnboardingLogEntry["kind"], string> = {
  sent: "Sent", marked: "Marked sent", send_failed: "Not sent", send_unknown: "May have gone", toggle: "Changed", seat: "Account", onboarded: "Marked onboarded", reopened: "Reopened",
};

function History({ log }: { log: OnboardingLogEntry[] }) {
  if (!log.length) return null;
  const rows = [...log].reverse();
  return (
    <details className="rounded-xl border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium">
        History ({log.length}) <ChevronDown className="size-4 text-muted" aria-hidden />
      </summary>
      <ul className="space-y-1 border-t border-border px-3 py-2 text-[13px]">
        {rows.slice(0, 50).map((e, i) => (
          <li key={`${e.at}:${i}`}>
            <span className="text-muted">{whenET(e.at)}</span> · {LOG_WORDS[e.kind] ?? e.kind}
            {e.message ? ` "${messageOf(e.message).label}"` : ""}{e.to ? ` to ${e.to}` : ""}{e.detail ? ` — ${e.detail}` : ""} <span className="text-muted">({e.by})</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---- the panel ---------------------------------------------------------------------------------

export function ClientOnboardingPanel({ list, detail, selectedId, canAct }: { list: OnboardingListRow[]; detail: OnboardingDetail | null; selectedId: string | null; canAct: boolean }) {
  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <ClientList list={list} selectedId={selectedId} />
      <div className="min-w-0 space-y-3" data-onboarding-detail={detail?.client.id ?? ""}>
        {detail
          // Keyed by client: another client's steps start fresh (no typed
          // email or open card carried over from the last one).
          ? <Steps key={detail.client.id} d={detail} canAct={canAct} />
          : <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">Pick a client to see their onboarding steps. Nothing here is sent until you press Send now on a message.</p>}
      </div>
    </div>
  );
}

function Steps({ d, canAct }: { d: OnboardingDetail; canAct: boolean }) {
  // The card that opens is chosen ONCE, when the client is opened: a step that
  // turns Done while Jordan works in it must not snap shut under him.
  const [openKey] = useState(() => d.steps.find((s) => s.status !== "done")?.key ?? null);
  const step = (key: string) => d.steps.find((s) => s.key === key)!;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{d.client.name}{d.client.isTest && <span className="ml-2 rounded-full bg-brand/10 px-2 py-0.5 align-middle text-[11px] font-semibold text-brand">TEST</span>}</h2>
        <Link href={contentHref(d.enrollment.id)} className={cn(link, "text-sm")}>Open their content workspace</Link>
      </div>
      <StepCard step={step("account")} open={openKey === "account"}>
        <dl className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Client</dt><dd>{d.client.name}{d.client.company ? ` · ${d.client.company}` : ""}</dd>
          <dt className="text-muted">Portal email</dt><dd>{d.messages[0]?.recipients.filter((r) => r.channel === "email").map((r) => r.toRef).join(", ") || "none on file"}</dd>
          <dt className="text-muted">Package</dt>
          <dd>{d.enrollment.package} · {d.enrollment.videosPerMonth} videos a month · {d.enrollment.sessionsPerMonth === 1 ? "one" : d.enrollment.sessionsPerMonth === 2 ? "two" : d.enrollment.sessionsPerMonth} {d.enrollment.sessionMinutes}-minute session{d.enrollment.sessionsPerMonth === 1 ? "" : "s"}{d.enrollment.trial ? " · trial" : ""}{d.enrollment.status !== "ACTIVE" ? ` · ${d.enrollment.status.toLowerCase()}` : ""}</dd>
          <dt className="text-muted">This month</dt>
          <dd>{d.enrollment.monthLabel}{d.enrollment.callStatus ? ` · strategy call ${d.enrollment.callStatus.toLowerCase().replace(/_/g, " ")}` : " · no month opened yet"}</dd>
        </dl>
        <p className="text-[13px]"><Link href={contentHref(d.enrollment.id, { tab: "settings" })} className={link}>Change package or status</Link> · <Link href={`/clients/${d.client.id}`} className={link}>Client page (email, phone)</Link></p>
      </StepCard>
      <StepCard step={step("strategy")} open={openKey === "strategy"}><StrategyStep d={d} canAct={canAct} /></StepCard>
      <StepCard step={step("features")} open={openKey === "features"}><FeaturesStep d={d} canAct={canAct} /></StepCard>
      <StepCard step={step("portal")} open={openKey === "portal"}><PortalStep d={d} canAct={canAct} /></StepCard>
      <StepCard step={step("messages")} open={openKey === "messages"}>
        <p className="text-[13px] text-muted">Each message is written for you to read and change. Nothing goes until you press Send now and confirm. If you send it yourself, press Mark as sent by me.</p>
        <div className="space-y-2">{ONBOARDING_MESSAGES.map((def) => { const m = d.messages.find((x) => x.key === def.key)!; return <MessageCard key={m.key} d={d} m={m} canAct={canAct} />; })}</div>
      </StepCard>
      <StepCard step={step("filming")} open={openKey === "filming"}><FilmingStep d={d} canAct={canAct} /></StepCard>
      <StepCard step={step("done")} open={openKey === "done"}><DoneStep d={d} canAct={canAct} /></StepCard>
      <History log={d.record.log} />
    </>
  );
}
