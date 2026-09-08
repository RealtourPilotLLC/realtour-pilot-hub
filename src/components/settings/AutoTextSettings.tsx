"use client";

import { useState, useTransition } from "react";
import { MessageSquareText, Send, Loader2, Check } from "lucide-react";
import { saveAutoTextRules } from "@/app/settings/actions";
import type { AutoTextRules } from "@/lib/settings";
import { cn } from "@/lib/utils";

// Every automated CLIENT text, what it does, when it fires, and the switches —
// Jordan (Sep 1): "I want to see exactly what automations there are, what time
// they go out (the rules), be able to change the rules, and turn off the
// automations." Internal/team notifications are listed read-only below so the
// page is a complete inventory, not just the parts that happen to be editable.

// A clock time, minutes included. The cutoff has ALWAYS been 4:30 (Jordan's
// rule), but this file only had an on-the-hour formatter and pasted the minutes
// on after the meridiem, so every window on the page read "4:00 PM:30". Same
// output as windowLabel() in lib/clientTextSweeps, which is what actually gates
// the send.
const hhmm = (h: number, m = 0) => {
  const am = h < 12 || h === 24;
  const v = h % 12 === 0 ? 12 : h % 12;
  return `${v}:${String(m).padStart(2, "0")} ${am ? "AM" : "PM"}`;
};
const hour12 = (h: number) => hhmm(h);

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
        on ? "bg-success" : "bg-surface-2 ring-1 ring-border",
      )}
    >
      <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

function Num({ value, onChange, min, max, suffix }: { value: number; onChange: (n: number) => void; min: number; max: number; suffix: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/[^\d]/g, ""));
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="w-16 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm tabular-nums outline-none focus:border-brand"
      />
      <span className="text-xs text-muted">{suffix}</span>
    </span>
  );
}

// What the placeholders become when the text really sends. The two links are
// read from the saved rules, so this preview shows the REAL destinations; the
// name is a sample, and the website is the public site (lib/settings
// PUBLIC_WEBSITE — a client component cannot import a server-only module, so
// this is the one place it is written twice; keep them in step).
const SAMPLE_FIRST = "Sarah";
const PREVIEW_WEBSITE = "realtourpilot.com";

function fillPlaceholders(tpl: string, vars: Record<string, string>): string {
  // Same rule as lib/delivery applyTemplate: an unknown placeholder is left
  // exactly as typed rather than blanked, so a typo is visible in the preview
  // instead of silently sending a gap.
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m)).trim();
}

export function AutoTextSettings({ initial }: { initial: AutoTextRules }) {
  const [r, setR] = useState<AutoTextRules>(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const set = (patch: Partial<AutoTextRules>) => { setR((p) => ({ ...p, ...patch })); setMsg(null); };

  // autoTextRules() always resolves `welcome`, so this fallback is unreachable
  // at runtime; it exists because the STORED shape has the field optional (a
  // settings row saved before the welcome text existed).
  const welcome = r.welcome ?? { enabled: true, strategyCallUrl: "", message: "" };
  const setWelcome = (patch: Partial<typeof welcome>) => set({ welcome: { ...welcome, ...patch } });
  const welcomePreview = fillPlaceholders(welcome.message, {
    first: SAMPLE_FIRST,
    strategyCallLink: welcome.strategyCallUrl,
    website: PREVIEW_WEBSITE,
    portal: r.afterHours?.portalUrl ?? "media.realtourpilot.com",
  });

  const save = () =>
    start(async () => {
      const res = await saveAutoTextRules(r).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      setMsg(res.message);
    });

  // Reflect the real rule (Jordan, Sep 2): weekdays only, and a minute-precise
  // cutoff — "never after 4:30 PM to clients". Team texts are NOT governed here.
  const untilMin = r.sendUntilMinute ?? 30;
  const untilLabel = hhmm(r.sendUntilHour, untilMin);
  const windowLine = `${hour12(r.sendFromHour)} – ${untilLabel} ET${r.weekdaysOnly !== false ? ", Mon–Fri" : ""}`;

  return (
    <div className="space-y-4">
      {/* Master switch + window */}
      <div className="rounded-xl border border-border p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">All automated client texts</p>
            <p className="mt-0.5 text-[13px] text-muted">
              {r.enabled
                ? `On — nothing sends outside ${windowLine}. Past the cutoff it waits for the next morning.`
                : "Off — the hub will not text any client automatically. Drafted texts still wait for you on Tasks."}
            </p>
          </div>
          <Toggle on={r.enabled} onChange={(v) => set({ enabled: v })} label="All automated client texts" />
        </div>
        <div className={cn("mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3", !r.enabled && "opacity-50")}>
          <span className="text-[13px] font-medium text-muted">Send window</span>
          <Num value={r.sendFromHour} onChange={(n) => set({ sendFromHour: n })} min={0} max={22} suffix={`(${hour12(r.sendFromHour)})`} />
          <span className="text-xs text-muted-2">to</span>
          <Num value={r.sendUntilHour} onChange={(n) => set({ sendUntilHour: n })} min={1} max={24} suffix={`(${hour12(r.sendUntilHour)})`} />
          <span className="text-[11px] text-muted-2">24-hour ET · nothing sends at or after the cutoff{r.weekdaysOnly !== false ? " · weekdays only" : ""} · clients only, team texts are unaffected</span>
        </div>
      </div>

      {/* Welcome — first in the list because it is first in the client's life */}
      <div className={cn("rounded-xl border border-border p-3.5", !r.enabled && "opacity-50")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Welcome text</p>
            <p className="mt-0.5 text-[13px] text-muted">
              Goes to a brand-new client the first time they book a shoot. Once each, ever.
            </p>
            <p className="mt-1 text-[13px] text-foreground/80">Sends inside {windowLine}.</p>
          </div>
          <Toggle on={welcome.enabled} onChange={(v) => setWelcome({ enabled: v })} label="Welcome texts" />
        </div>

        <div className="mt-3 border-t border-border pt-3">
          <label className="text-[13px] font-medium" htmlFor="welcome-link">Free strategy call link</label>
          <input
            id="welcome-link"
            value={welcome.strategyCallUrl}
            onChange={(e) => setWelcome({ strategyCallUrl: e.target.value })}
            placeholder="https://calendly.com/…"
            className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <p className="mt-1 text-[11px] text-muted-2">
            This is what <code>{"{strategyCallLink}"}</code> becomes. Leave it blank to use the booking link on file.
          </p>
        </div>

        <div className="mt-3">
          <label className="text-[13px] font-medium" htmlFor="welcome-msg">Message</label>
          <textarea
            id="welcome-msg"
            value={welcome.message}
            onChange={(e) => setWelcome({ message: e.target.value })}
            rows={4}
            placeholder="Using the built-in wording"
            className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <p className="mt-1 text-[11px] text-muted-2">
            Placeholders: <code>{"{first}"}</code> · <code>{"{strategyCallLink}"}</code> · <code>{"{website}"}</code> ·{" "}
            <code>{"{portal}"}</code>. Anything else you type in braces is sent exactly as written. Empty box = the
            hub&rsquo;s built-in wording.
          </p>
        </div>

        {/* Live preview — the whole point of the box above is seeing the text a
            real client receives, links and all, before it ever sends. */}
        <div className="mt-3 rounded-lg border border-border bg-surface-2/60 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-2">
            What {SAMPLE_FIRST} receives
          </p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug">
            {welcomePreview || <span className="text-muted-2">Using the built-in wording.</span>}
          </p>
        </div>

        <p className="mt-2 text-[11px] text-muted-2">
          Only new contacts added since this was switched on, never your existing client list. A client with no phone
          number on file cannot receive one, and that is called out on the new-client card on your dashboard.
        </p>
      </div>

      {/* Confirmation */}
      <div className={cn("rounded-xl border border-border p-3.5", !r.enabled && "opacity-50")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Shoot confirmation text</p>
            <p className="mt-0.5 text-[13px] text-muted">
              Confirms the date, time and what was ordered, and asks for anything we should know.
            </p>
            <p className="mt-1 text-[13px] text-foreground/80">
              Sends <b>{r.confirmation.hoursBefore}h</b> before the shoot, inside {windowLine}.
            </p>
          </div>
          <Toggle on={r.confirmation.enabled} onChange={(v) => set({ confirmation: { ...r.confirmation, enabled: v } })} label="Confirmation texts" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <span className="text-[13px] font-medium text-muted">Lead time</span>
          <Num value={r.confirmation.hoursBefore} onChange={(n) => set({ confirmation: { ...r.confirmation, hoursBefore: n } })} min={1} max={168} suffix="hours before" />
        </div>
        <p className="mt-2 text-[11px] text-muted-2">
          Never sends twice: a hand-sent confirmation inside the window closes the task and the robot stands down.
          A shoot booked after the cutoff for early next morning is left for a human and flagged.
        </p>
      </div>

      {/* Delivery */}
      <div className={cn("rounded-xl border border-border p-3.5", !r.enabled && "opacity-50")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Delivery text</p>
            <p className="mt-0.5 text-[13px] text-muted">
              Goes out when Aryeo shows every ordered deliverable shipped. Asks how we did and links the feedback form.
            </p>
            <p className="mt-1 text-[13px] text-foreground/80">
              Only while the delivery task is under <b>{r.delivery.maxTaskAgeHours}h</b> old, inside {windowLine}.
            </p>
          </div>
          <Toggle on={r.delivery.enabled} onChange={(v) => set({ delivery: { ...r.delivery, enabled: v } })} label="Delivery texts" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <span className="text-[13px] font-medium text-muted">Auto-send window</span>
          <Num value={r.delivery.maxTaskAgeHours} onChange={(n) => set({ delivery: { ...r.delivery, maxTaskAgeHours: n } })} min={1} max={720} suffix="hours after delivery" />
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 border-t border-border pt-3">
          <input
            type="checkbox"
            checked={r.delivery.requireMonthlyBatch}
            onChange={(e) => set({ delivery: { ...r.delivery, requireMonthlyBatch: e.target.checked } })}
            className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
          />
          <span className="text-[13px] leading-snug">
            <b>Monthly content: wait for the whole batch.</b>{" "}
            <span className="text-muted">
              A monthly order is one line item but owes several videos, so the text waits until the plan&rsquo;s videos are live
              (Starter 2 · Accelerator 4 · Pro 8) or an editor marks the job Completed. Turning this off would announce
              &ldquo;everything delivered&rdquo; after the first video.
            </span>
          </span>
        </label>
      </div>

      {/* Cross-cutting safeties */}
      <div className={cn("rounded-xl border border-border p-3.5", !r.enabled && "opacity-50")}>
        <p className="text-sm font-semibold">Safeties</p>
        <label className="mt-2 flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" checked={r.skipWhenClientWaiting} onChange={(e) => set({ skipWhenClientWaiting: e.target.checked })} className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
          <span className="text-[13px] leading-snug">
            <b>Never text a client who is waiting on an answer.</b>{" "}
            <span className="text-muted">If they have an unanswered question, the automation stands down and leaves it to a human.</span>
          </span>
        </label>
        <label className="mt-2.5 flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" checked={r.onePerClientPerRun} onChange={(e) => set({ onePerClientPerRun: e.target.checked })} className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
          <span className="text-[13px] leading-snug">
            <b>At most one automated text per client per run.</b>{" "}
            <span className="text-muted">A client with several listings gets one an hour instead of four in a minute.</span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save rules
        </button>
        {msg && <span className="text-[13px] font-medium text-muted">{msg}</span>}
      </div>

      {/* Read-only inventory of everything else that sends on its own */}
      <div className="rounded-xl border border-border bg-surface-2/40 p-3.5">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Send className="size-3.5 text-muted" /> Also automated (internal — not client-facing)
        </p>
        <ul className="mt-2 space-y-1.5 text-[13px] text-muted">
          <li>· <b className="text-foreground/85">Upload reminder, 7:00 PM ET</b> — texts a photographer whose shoot has no submitted upload page.</li>
          <li>· <b className="text-foreground/85">Upload chaser, 10:00 PM ET</b> — second nudge if it is still not submitted.</li>
          <li>· <b className="text-foreground/85">Photos-not-delivered alert</b> — late afternoon, texts Kyle and Jordan when yesterday&rsquo;s photos are still not released.</li>
          <li>· <b className="text-foreground/85">Raw video missing</b> — bell + text to the creative when a video job&rsquo;s footage can&rsquo;t be found.</li>
          <li>· <b className="text-foreground/85">Kyle&rsquo;s Slack digests</b> — morning list and 4 PM open-items recap.</li>
        </ul>
        <p className="mt-2 text-[11px] text-muted-2">
          These go to the team, never to clients. Tell me if you want any of them on this page too.
        </p>
      </div>
    </div>
  );
}
