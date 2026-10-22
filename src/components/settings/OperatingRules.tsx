"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { saveTurnarounds, saveInternalAlerts, saveReviewRoomRules, loadOnCallCandidates } from "@/app/settings/actions";
import { loadCutReviewerSeats, setCutReviewerAway } from "@/app/review/actions";
import type { ReviewerSeat } from "@/components/review/reviewerTypes";
import type { TurnaroundRules, InternalAlertRules, ReviewRoomRules } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { EmailSlaSettings } from "@/components/settings/EmailSlaSettings";
import { NotificationSchedule } from "@/components/settings/NotificationSchedule";
import { useSettingsDraft } from "@/components/settings/useSettingsDraft";
import type { SettingsSaveResult } from "@/lib/settingsDraft";
import { Button } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { SaveStatus } from "@/components/ui/SaveStatus";
import { Switch } from "@/components/ui/Switch";

// Everything that used to be a constant in the code (Jordan, Sep 1: "I want
// settings for turnaround promises, alert thresholds, anything currently hard
// coded"). Each group saves independently so one bad edit can't take the rest
// with it, and every value is clamped again server-side on read.

const hour12 = (h: number) => {
  const am = h < 12 || h === 24;
  const v = h % 12 === 0 ? 12 : h % 12;
  return `${v}:00 ${am ? "AM" : "PM"}`;
};

// THE EVENING SEND TIMES (Oct 21 2026, audit H23). The reminder and the
// chaser are sent by the evening cron, which only ever acts at 7 PM and 10 PM
// Eastern in every season (lib/settings EVENING_SEND_HOURS; the UTC schedule in
// vercel.json lands on other hours for half the year at most). These two
// fields used to take any hour from 0 to 23 and say it back as if it were
// true. Now they offer the two real times, and a stored hour that is neither
// is shown as the time it actually goes out, with a line saying what was
// saved. Kept as literals here: lib/settings is server-only.
const EVENING_CHOICES = [19, 22] as const;

function EveningHour({ label, value, onChange, savedAs }: { label: string; value: number; onChange: (n: number) => void; savedAs: number | null }) {
  const id = useId();
  return (
    <div className="mt-2 border-t border-border pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-[13px] text-muted">Sends at</label>
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="min-h-9 rounded-lg border border-border bg-surface-2 px-2 py-1 text-base outline-none focus:border-brand sm:min-h-0 sm:text-sm"
          aria-label={label}
        >
          {EVENING_CHOICES.map((h) => (
            <option key={h} value={h}>{hour12(h)} ET</option>
          ))}
        </select>
        <span className="text-[11px] text-muted-2">The evening run fires at 7 PM and 10 PM Eastern all year, so those are the two choices.</span>
      </div>
      {savedAs != null && (
        <p className="mt-1.5 text-[13px] text-warning">
          Saved as {hour12(savedAs)}, which isn&rsquo;t one of the evening run&rsquo;s two year-round times. It goes out at {hour12(value)}, the nearest one. Save to make that the setting.
        </p>
      )}
    </div>
  );
}

function Num({ label, value, onChange, min, max, suffix, wide }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; suffix?: string; wide?: boolean }) {
  const id = useId();
  return (
    <div className="inline-flex items-center gap-1.5">
      <TextField id={id} label={label} labelHidden
        inputMode="numeric"
        aria-describedby={suffix ? `${id}-unit` : undefined}
        value={String(value)}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/[^\d]/g, ""));
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className={wide ? "w-20" : "w-16"} inputClassName="bg-surface-2 px-2 text-sm tabular-nums"
      />
      {suffix && <span id={`${id}-unit`} className="text-sm text-muted">{suffix}</span>}
    </div>
  );
}

// Exported (Sep 11) so the owner's "Text me" card uses the same switch and
// Save row as the rest of the page rather than a look-alike. Oct 21 2026
// (audit H17): the switch itself is now the shared ui/Switch; `label` is its
// accessible name.
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <Switch checked={on} onChange={onChange} aria-label={label} disabled={disabled} />;
}

export function SaveRow({ onSave, msg, busy, feedback, dirty, label = "Save" }: { onSave: () => void; msg?: string | null; busy: boolean; feedback?: SettingsSaveResult | null; dirty?: boolean; label?: string }) {
  const message = feedback?.message ?? msg;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button onClick={onSave} busy={busy} busyLabel="Saving…">
        {!busy && feedback?.ok && !dirty ? <Check aria-hidden className="size-4" /> : null} {label}
      </Button>
      {(dirty !== undefined || message || busy) && <SaveStatus
        state={busy ? "saving" : feedback?.ok === false ? "error" : dirty ? "dirty" : feedback?.ok ? "saved" : dirty !== undefined ? "loaded" : "info"}
        message={!busy && message ? <>{message}{feedback?.ok && dirty ? " Newer edits are still unsaved." : ""}</> : undefined} />}
    </div>
  );
}

const TURN_ROWS: { key: keyof TurnaroundRules; label: string; hint: string; max: number; unit: string }[] = [
  { key: "photos", label: "Photos", hint: "the promise clients hear most", max: 720, unit: "hours after the shoot" },
  { key: "drone", label: "Drone / aerial", hint: "", max: 720, unit: "hours" },
  { key: "twilight", label: "Twilight", hint: "", max: 720, unit: "hours" },
  { key: "floorPlan", label: "Floor plan", hint: "CubiCasa round-trip", max: 720, unit: "hours" },
  { key: "tour3d", label: "3D tour (Matterport / Zillow)", hint: "", max: 720, unit: "hours" },
  { key: "headshot", label: "Headshots", hint: "", max: 720, unit: "hours" },
  { key: "virtualStaging", label: "Virtual staging", hint: "", max: 720, unit: "hours" },
  { key: "standardVideoHours", label: "Standard reel / video", hint: "in-house edit", max: 720, unit: "hours" },
  { key: "premiumVideoHours", label: "Premium reel / video", hint: "beats monthly when both apply", max: 720, unit: "hours" },
  { key: "otherHours", label: "Anything else", hint: "unmapped products", max: 720, unit: "hours" },
];

export function TurnaroundSettings({ initial }: { initial: TurnaroundRules }) {
  const { value: r, setValue: setR, busy, feedback, dirty, save } = useSettingsDraft(initial);
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted">
        What we promise, per deliverable. These drive every due date, the QC card&rsquo;s deadline, the late/overdue
        flags, and the video SLA countdown — change one and the whole hub follows.
      </p>
      <div className="space-y-1.5">
        {TURN_ROWS.map((row) => (
          <div key={row.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <span className="text-[13px]">
              <b>{row.label}</b>
              {row.hint && <span className="text-muted"> — {row.hint}</span>}
            </span>
            <Num label={row.label + " turnaround"}
              value={r[row.key] as number}
              onChange={(n) => { setR((p) => ({ ...p, [row.key]: n })); }}
              min={1} max={row.max} suffix={row.unit}
            />
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <span className="text-[13px]"><b>Monthly content</b><span className="text-muted"> — personal branding batches</span></span>
          <Num label="Monthly content turnaround" value={r.monthlyBusinessDays} onChange={(n) => { setR((p) => ({ ...p, monthlyBusinessDays: n })); }} min={1} max={60} suffix="days" />
        </div>
      </div>
      <SaveRow busy={busy} feedback={feedback} dirty={dirty} label="Save turnaround promises" onSave={() => save(saveTurnarounds)} />
    </div>
  );
}

// WHAT READS EACH SWITCH (Sep 26 2026, unified handoff §11: "do not make a
// switch look effective when another gate prevents its operation"). Two of
// these toggles — Raw video missing and Kyle's Slack digests — were drawn here
// and read by nothing until today. Each card now names the engine that obeys
// it, and scripts/_drill/alert-switch-readers.ts fails the build's drill run
// when a key has no entry here or a named file stops reading it.
const ALERT_SWITCH_READERS: Record<keyof InternalAlertRules, { words: string; files: string[] }> = {
  uploadReminder: { words: "the evening upload sweep", files: ["src/app/api/cron/evening/route.ts"] },
  uploadChaser: { words: "the evening upload sweep", files: ["src/app/api/cron/evening/route.ts"] },
  photosUndelivered: { words: "the late-photos check, 4–7 PM", files: ["src/lib/deliveryWatch.ts"] },
  rawVideoMissing: { words: "the raw-footage check when a video job's folders are read", files: ["src/lib/tasks.ts"] },
  kyleDigests: { words: "Kyle's morning list and 4 o'clock check", files: ["src/lib/notify.ts", "src/lib/commsBoard.ts"] },
  leadPing: { words: "the new-lead check, every 5 minutes", files: ["src/lib/leadDesk.ts"] },
  eveningPush: { words: "the 6 PM wrap, Monday to Saturday", files: ["src/lib/eveningPush.ts"] },
  photographerBrief: { words: "the 6 PM shoot briefs for tomorrow", files: ["src/lib/eveningPush.ts"] },
  shootDayText: { words: "the shoot start check, every 5 minutes", files: ["src/lib/shootDayText.ts"] },
  uploadGap: { words: "the upload check, every 5 minutes (each job at most every 15)", files: ["src/lib/uploadGaps.ts"] },
  missingInstructions: { words: "the morning instructions check, every 5 minutes from 10 AM", files: ["src/lib/missingInstructions.ts"] },
  promiseWatch: { words: "the promise check, every 5 minutes", files: ["src/lib/promiseWatch.ts"] },
  coverage: { words: "the client-reply pager, the late-photos alert and the review cover clock", files: ["src/lib/coverage.ts"] },
};

function ReadBy({ k }: { k: keyof InternalAlertRules }) {
  return <p className="mt-0.5 text-[11px] text-muted-2">Read by {ALERT_SWITCH_READERS[k].words}.</p>;
}

type OnCallCandidate = Awaited<ReturnType<typeof loadOnCallCandidates>>[number];

// Coverage in one sentence, live as the boxes change. The server says the same
// thing back on save (describeCoverage, in lib/coverage.ts — server-only, so it
// cannot be imported here); this is the version you read BEFORE committing to
// it, which is the one that stops a mistake.
// A window runs forwards inside one day or it is not a window: the pager reads
// it as one `mins >= from && mins < to` comparison, so 6pm → 9am covers nothing
// at all and the server refuses to store it (review, Sep 18 2026 — it used to
// be saved, confirmed back in words, and then silently read as the 9am–6pm
// default). Said here as well as there, because the message you read BEFORE
// committing to a mistake is the one that stops it.
const windowOk = (w: { fromHour: number; toHour: number }) => w.fromHour < w.toHour;

function coverageSentence(c: InternalAlertRules["coverage"], onCall: OnCallCandidate | null): string {
  if (c.fromHour === c.toHour) {
    return `${hour12(c.fromHour)} to ${hour12(c.toHour)} is no time at all, so this can't be saved. Give the window an end hour later in the same day.`;
  }
  if (!windowOk(c)) {
    return `${hour12(c.fromHour)} to ${hour12(c.toHour)} runs backwards, so this can't be saved. Put the earlier hour first — and for evening, weekend or overnight cover, name somebody on call below instead.`;
  }
  const days = c.weekdaysOnly ? "Monday to Friday" : "every day";
  const window = `${days}, ${hour12(c.fromHour)} to ${hour12(c.toHour)} Eastern`;
  // Oct 6 2026 (Jordan: "Anyone on the team can get pinged anytime. Just not
  // Jordan on Saturday until 7:30PM."): the Sep 26 clause "except between
  // 10 PM and 7 AM, when the page waits until 7 AM" is gone with the rule — an
  // urgent page goes to the on-call at once, held only by their own quiet time.
  const first = onCall?.name.split(/\s+/)[0];
  const rota = onCall
    ? `Outside it, routine alerts wait for the next covered period and urgent ones go to ${first} at any hour — only a quiet time of ${first}'s own holds them.`
    : "Outside it, routine alerts wait for the next covered period. Nobody is named for urgent ones, so they still page whoever holds the owner or admin role — the same people as today.";
  // Oct 6 2026: coverage days decide when the OFFICE alerts run — it is not a
  // hold on any person (Notification schedule says who may be reached when),
  // so the sentence says plainly what widening it to seven days does.
  const runs = c.weekdaysOnly
    ? "The office alerts (late photos, the client-reply pager) run Monday to Friday only — turn off Weekdays only to run them every day."
    : "The office alerts (late photos, the client-reply pager) run every day, weekends included.";
  return `Somebody is on ${window}. ${rota} ${runs}`;
}

export function InternalAlertSettings({
  initial,
  offSchedule = { uploadReminder: null, uploadChaser: null },
}: {
  initial: InternalAlertRules;
  /** A stored evening hour that isn't a real firing time (lib/settings eveningHoursOffSchedule). */
  offSchedule?: { uploadReminder: number | null; uploadChaser: number | null };
}) {
  const { value: r, setValue: setR, busy, feedback, dirty, save } = useSettingsDraft(initial);
  const set = (patch: Partial<InternalAlertRules>) => { setR((p) => ({ ...p, ...patch })); };
  const setCover = (patch: Partial<InternalAlertRules["coverage"]>) => set({ coverage: { ...r.coverage, ...patch } });
  // The roster is fetched rather than passed in: this card is rendered from
  // /settings/page.tsx and the picker should not make every visit to that page
  // wait on a roster query it may not need.
  const [roster, setRoster] = useState<OnCallCandidate[] | null>(null);
  useEffect(() => { loadOnCallCandidates().then(setRoster).catch(() => setRoster([])); }, []);
  const onCall = roster?.find((m) => m.id === r.coverage.onCallTeamMemberId) ?? null;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">These go to the team, never to clients.</p>

      {/* COVERAGE — first, because it governs every card below it. */}
      <div className="rounded-lg border border-border p-3">
        <p className="text-sm font-semibold">Coverage — when somebody is actually here</p>
        <p className="text-[13px] text-muted">
          Messages are captured around the clock and always show up on the boards. This decides when the office alerts
          run — late photos and the client-reply pager. When a person may be notified is the Notification schedule.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Covered</span>
          <Num label="Coverage start hour" value={r.coverage.fromHour} onChange={(n) => setCover({ fromHour: n })} min={0} max={22} suffix={hour12(r.coverage.fromHour)} />
          <span className="text-xs text-muted-2">to</span>
          <Num label="Coverage end hour" value={r.coverage.toHour} onChange={(n) => setCover({ toHour: n })} min={1} max={23} suffix={`ET (${hour12(r.coverage.toHour)})`} />
        </div>

        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
          <span className="text-[13px]">Weekdays only<span className="text-muted"> — turn off to run the office alerts every day, weekends included</span></span>
          <Toggle on={r.coverage.weekdaysOnly} onChange={(v) => setCover({ weekdaysOnly: v })} label="Weekdays only" />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">On call for urgent, out of hours</span>
          <select
            value={r.coverage.onCallTeamMemberId ?? ""}
            onChange={(e) => setCover({ onCallTeamMemberId: e.target.value || null })}
            disabled={roster === null}
            className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand disabled:opacity-50"
          >
            <option value="">Nobody</option>
            {(roster ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.reachable === "none" ? " — no Slack or textable number" : ""}
              </option>
            ))}
          </select>
          {onCall?.reachable === "none" && (
            <span className="text-[13px] text-warning">
              {onCall.name.split(/\s+/)[0]} has no Slack ID and no textable number, so an urgent page would only reach the ops channel.
            </span>
          )}
        </div>

        <p className={cn("mt-2 border-t border-border pt-2 text-[13px]", windowOk(r.coverage) ? "text-muted" : "text-warning")}>{coverageSentence(r.coverage, onCall)}</p>
        <ReadBy k="coverage" />
      </div>

      {/* Unanswered client email (O06, Sep 26) — counts on the coverage above; saves on its own. */}
      <EmailSlaSettings />

      {/* Quiet time per person (Jordan, Sep 26) — loads and saves on its own, one person at a time. */}
      <NotificationSchedule />

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Upload reminder</p>
            <p className="text-[13px] text-muted">Texts a photographer whose shoot has no submitted upload page.</p>
            <ReadBy k="uploadReminder" />
          </div>
          <Toggle on={r.uploadReminder.enabled} onChange={(v) => set({ uploadReminder: { ...r.uploadReminder, enabled: v } })} label="Upload reminder" />
        </div>
        <EveningHour label="Upload reminder send time" value={r.uploadReminder.hour} onChange={(n) => set({ uploadReminder: { ...r.uploadReminder, hour: n } })} savedAs={offSchedule.uploadReminder} />
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Late-night chaser</p>
            <p className="text-[13px] text-muted">Second nudge if the upload page is still not submitted.</p>
            <ReadBy k="uploadChaser" />
          </div>
          <Toggle on={r.uploadChaser.enabled} onChange={(v) => set({ uploadChaser: { ...r.uploadChaser, enabled: v } })} label="Upload chaser" />
        </div>
        <EveningHour label="Late-night chaser send time" value={r.uploadChaser.hour} onChange={(n) => set({ uploadChaser: { ...r.uploadChaser, hour: n } })} savedAs={offSchedule.uploadChaser} />
        {r.uploadReminder.enabled && r.uploadChaser.enabled && r.uploadReminder.hour === r.uploadChaser.hour && (
          <p className="mt-1.5 text-[13px] text-warning">
            The reminder and the chaser are both set to {hour12(r.uploadChaser.hour)}. Only the reminder would go out, so this can&rsquo;t be saved. Put one at 7 PM and the other at 10 PM, or switch one off.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Photos not delivered</p>
            <p className="text-[13px] text-muted">Texts Kyle and Jordan when a shoot&rsquo;s photos still aren&rsquo;t released.</p>
            <ReadBy k="photosUndelivered" />
          </div>
          <Toggle on={r.photosUndelivered.enabled} onChange={(v) => set({ photosUndelivered: { ...r.photosUndelivered, enabled: v } })} label="Photos not delivered" />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Late after</span>
          <Num label="Undelivered photos late threshold" value={r.photosUndelivered.lateAfterHours} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, lateAfterHours: n } })} min={1} max={336} suffix="hours" />
          <span className="text-[13px] text-muted">· alert between</span>
          <Num label="Undelivered photos alert start hour" value={r.photosUndelivered.fromHour} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, fromHour: n } })} min={0} max={22} suffix={hour12(r.photosUndelivered.fromHour)} />
          <span className="text-xs text-muted-2">and</span>
          <Num label="Undelivered photos alert end hour" value={r.photosUndelivered.toHour} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, toHour: n } })} min={1} max={23} suffix={hour12(r.photosUndelivered.toHour)} />
        </div>
        {!windowOk(r.photosUndelivered) && (
          <p className="mt-2 text-[13px] text-warning">
            {hour12(r.photosUndelivered.fromHour)} to {hour12(r.photosUndelivered.toHour)} {r.photosUndelivered.fromHour === r.photosUndelivered.toHour ? "is no time at all" : "runs backwards"}, so this can&rsquo;t be saved — the alert would never fire. Give the window an end hour later in the same day.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Raw video missing</p>
          <p className="text-[13px] text-muted">Bell + text to the creative when a video job&rsquo;s footage can&rsquo;t be found. The &ldquo;Find the raw video&rdquo; task for Kyle is made either way.</p>
          <ReadBy k="rawVideoMissing" />
        </div>
        <Toggle on={r.rawVideoMissing.enabled} onChange={(v) => set({ rawVideoMissing: { enabled: v } })} label="Raw video missing" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Kyle&rsquo;s Slack digests</p>
          <p className="text-[13px] text-muted">Morning list and the 4 PM open-items recap. Timed by Kyle&rsquo;s own quiet time on the schedule above.</p>
          <ReadBy k="kyleDigests" />
        </div>
        <Toggle on={r.kyleDigests.enabled} onChange={(v) => set({ kyleDigests: { enabled: v } })} label="Kyle's Slack digests" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">New lead pings</p>
          <p className="text-[13px] text-muted">New call, text and email leads go on Kyle&rsquo;s list. This switch is the Slack nudge to Kyle at 15 and 60 covered minutes while a lead is still untouched.</p>
          <ReadBy k="leadPing" />
        </div>
        <Toggle on={r.leadPing.enabled} onChange={(v) => set({ leadPing: { enabled: v } })} label="New lead pings" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Jordan&rsquo;s 6 PM wrap</p>
          <p className="text-[13px] text-muted">One Slack message at 6 PM, Monday to Saturday: delivered today, due by 9 AM, late, open asks, unanswered clients and tomorrow&rsquo;s gaps. Kyle gets a copy. Your Saturday quiet time still holds it.</p>
          <ReadBy k="eveningPush" />
        </div>
        <Toggle on={r.eveningPush.enabled} onChange={(v) => set({ eveningPush: { enabled: v } })} label="Jordan's 6 PM wrap" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Night-before shoot brief</p>
          <p className="text-[13px] text-muted">Around 6 PM, each photographer gets one message per shoot tomorrow: time, address, what was ordered, access and client notes, and the photo target. Missing access opens a task for Kyle.</p>
          <ReadBy k="photographerBrief" />
        </div>
        <Toggle on={r.photographerBrief.enabled} onChange={(v) => set({ photographerBrief: { enabled: v } })} label="Night-before shoot brief" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Special requests at the shoot</p>
          <p className="text-[13px] text-muted">At each shoot&rsquo;s start time, the photographer or videographer on it gets one text from the company line with the job&rsquo;s special requests: the order&rsquo;s special instructions, the client&rsquo;s open requests and the requests the office added. Door codes and who&rsquo;s there are left out (they are on the shoot screen). No special requests, no text.</p>
          <ReadBy k="shootDayText" />
        </div>
        <Toggle on={r.shootDayText.enabled} onChange={(v) => set({ shootDayText: { enabled: v } })} label="Special requests at the shoot" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Missing from the upload</p>
          <p className="text-[13px] text-muted">Checks each shoot&rsquo;s Dropbox upload against what was ordered. When it is sure something is missing, the creative gets one text from the company line, Kyle gets a bell and the photo delivery check stays open until the files land. Sure means: drone photos in but not one ground photo, and nothing new for an hour; or the creative handed that part in on the upload page and there is nothing. Floor plans and 3D tours are not checked.</p>
          <ReadBy k="uploadGap" />
        </div>
        <Toggle on={r.uploadGap.enabled} onChange={(v) => set({ uploadGap: { enabled: v } })} label="Missing from the upload" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Missing instructions, the morning after</p>
          <p className="text-[13px] text-muted">From 10 AM the morning after a shoot, if the upload page is still missing what the edit or the photos wait on (the flow and vision, the intro script, the cull, the removal notes), the photographer gets one text from the company line naming exactly what is missing, with their upload page. The creative manager is pinged at the same time, on their own notification settings. Again each morning, up to 3 mornings; it stops as soon as the page is submitted.</p>
          <ReadBy k="missingInstructions" />
        </div>
        <Toggle on={r.missingInstructions.enabled} onChange={(v) => set({ missingInstructions: { enabled: v } })} label="Missing instructions, the morning after" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Delivery watch before the promise</p>
          <p className="text-[13px] text-muted">Slacks Kyle 3 covered hours before a job&rsquo;s promised time with where the job stands, and drafts a client update on Kyle&rsquo;s list. Nothing is sent to the client.</p>
          <ReadBy k="promiseWatch" />
        </div>
        <Toggle on={r.promiseWatch.enabled} onChange={(v) => set({ promiseWatch: { enabled: v } })} label="Delivery watch before the promise" />
      </div>

      <SaveRow busy={busy} feedback={feedback} dirty={dirty} label="Save internal alerts" onSave={() => save(saveInternalAlerts)} />
    </div>
  );
}

// The "Text wording" card (three client boxes) lived here until Oct 21 2026;
// Settings → Text messages (TextMessagesSettings, lib/textTemplates) replaced it.

// ---- Review Room ------------------------------------------------------------
type SeatKey = "creativeApproverTeamMemberId" | "backupReviewerTeamMemberId" | "fallbackReviewerTeamMemberId";
const REVIEW_SEATS: { key: SeatKey; label: string; hint: string }[] = [
  { key: "creativeApproverTeamMemberId", label: "Reviewer", hint: "owns routine review — James" },
  { key: "backupReviewerTeamMemberId", label: "First backup", hint: "covers when they're away or offered — Kyle" },
  { key: "fallbackReviewerTeamMemberId", label: "Final fallback", hint: "only when both are out — Jordan" },
];

/** "Away until" for one saved seat. Saves on its own press, not with the card:
 *  away moves that person's waiting cuts on at once, and a stale Save of the
 *  card must never undo it (it lives in its own setting for that reason). */
function SeatAway({ seat, onChanged }: { seat: ReviewerSeat; onChanged: () => void }) {
  const [day, setDay] = useState("");
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (until: string | null) =>
    start(async () => {
      const res = await setCutReviewerAway(seat.id, until).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      setMsg(res.message);
      if (res.ok) { setDay(""); onChanged(); }
    });
  const first = seat.name.split(/\s+/)[0];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {seat.awayUntil ? (
        <>
          <span className="text-[13px] text-warning">{first} is away until {new Date(seat.awayUntil).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}</span>
          <button type="button" disabled={busy} onClick={() => run(null)} className="rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50">
            Mark back
          </button>
        </>
      ) : (
        <>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label={`${first} away until`} className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand" />
          <button type="button" disabled={busy || !day} onClick={() => run(day)} className="rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50">
            Away until then
          </button>
        </>
      )}
      {busy && <Loader2 className="size-3.5 animate-spin text-muted" />}
      {msg && <span className="w-full text-[12px] text-muted">{msg}</span>}
    </span>
  );
}

export function ReviewRoomSettings({ initial }: { initial: ReviewRoomRules }) {
  const { value: r, setValue: setR, busy, feedback, dirty, save } = useSettingsDraft(initial);
  const set = (patch: Partial<ReviewRoomRules>) => { setR((p) => ({ ...p, ...patch })); };
  // Fetched, not passed in — the same reason the on-call picker fetches its
  // roster: /settings should not wait on a query most visits do not need.
  const [roster, setRoster] = useState<ReviewerSeat[] | null>(null);
  const loadRoster = () => { loadCutReviewerSeats().then(setRoster).catch(() => setRoster([])); };
  useEffect(() => { loadCutReviewerSeats().then(setRoster).catch(() => setRoster([])); }, []);
  const seatOf = (id: string | null) => (id ? roster?.find((m) => m.id === id) ?? null : null);
  const autoMove = r.coverTransferHours != null;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Cuts reach the Review Room when the editor uploads a version from the editor portal. Approved cuts are
        copied into the job&rsquo;s Dropbox Final folder automatically.
      </p>

      <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Also watch the Dropbox Final folder</p>
          <p className="text-[13px] text-muted">
            Off by default. When on, any video file that appears in a job&rsquo;s 05-Final-Video folder is
            entered for review on its own — handy for editors who won&rsquo;t use the portal, messy when they
            export several versions of the same video.
          </p>
        </div>
        <Toggle on={r.discoverFromDropbox} onChange={(v) => set({ discoverFromDropbox: v })} label="Watch the Final folder" />
      </div>

      <div className="rounded-lg border border-border p-3">
        <p className="text-sm font-semibold">Keep uploaded cuts in the hub for</p>
        <p className="text-[13px] text-muted">
          After an approved cut has been copied to Dropbox, its upload is released from the hub&rsquo;s store once
          this many days have passed. The client portal shows the current and previous month, so keep at least 60.
        </p>
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
          <Num label="Keep uploads for" value={r.keepUploadsDays} onChange={(n) => set({ keepUploadsDays: n })} min={1} max={365} suffix="days" />
        </div>
      </div>

      {/* WHO REVIEWS CUTS (§3 / §8.1, Sep 25). Was one "creative approver"
          NAME (R08); now three seats and ONE owner per cut: the first seat
          that can act and is not away gets it, the others hear about it, and
          nobody has to approve twice. Owner/admin can still rule on any cut —
          that is recorded as covering it. */}
      <div className="rounded-lg border border-border p-3">
        <p className="text-sm font-semibold">Who reviews cuts</p>
        <p className="text-[13px] text-muted">
          Every cut waits on <i>one</i> person — the first of these who can act and isn&rsquo;t away. The others get an
          FYI; nobody approves twice. Anyone here, or any owner or admin, can take a cut or rule on it, and that is
          recorded as covering it. Editors can&rsquo;t hold a seat, and seating anyone who isn&rsquo;t an owner or admin is
          Jordan&rsquo;s call — it gives them the power to approve.
        </p>
        {REVIEW_SEATS.map((seat) => {
          const picked = seatOf(r[seat.key]);
          const saved = seatOf(initial[seat.key]);
          const first = picked?.name.split(/\s+/)[0] ?? "";
          return (
            <div key={seat.key} className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
              <span className="w-28 text-[13px] text-muted" title={seat.hint}>{seat.label}</span>
              <select
                value={r[seat.key] ?? ""}
                onChange={(e) => set({ [seat.key]: e.target.value || null } as Partial<ReviewRoomRules>)}
                disabled={roster === null}
                className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand disabled:opacity-50"
              >
                <option value="">Nobody</option>
                {(roster ?? []).map((m) => (
                  // An editor login can never review (they'd rule on their own
                  // cuts) — listed, greyed, so the reason is on the screen.
                  <option key={m.id} value={m.id} disabled={m.hasLogin && !m.canRuleIfDesignated && m.id !== r[seat.key]}>
                    {m.name}
                    {!m.hasLogin ? " — no login yet" : !m.canRuleIfDesignated ? " — editor login, can't review" : m.loginRole !== "OWNER" && m.loginRole !== "ADMIN" && m.loginRole !== "CREATIVE_MANAGER" ? " — only Jordan can seat" : ""}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-muted-2">{seat.hint}</span>
              {picked && !picked.canRuleIfDesignated && (
                <span className="w-full text-[13px] text-warning">
                  {picked.hasLogin
                    ? <>{first} signs in as an editor, so they can&rsquo;t rule on a cut — cuts skip to the next seat.</>
                    : <>{first} has no active login, so they can&rsquo;t rule on a cut — cuts skip to the next seat until one is set up.</>}
                </span>
              )}
              {/* THEIR switch, never flipped from here: James's "video in
                  review" is bell-only by an earlier consent decision. Saying so
                  next to his name is the whole of what this card does about it. */}
              {picked && picked.canRuleIfDesignated && !picked.reviewReady.slack && !picked.reviewReady.sms && (
                <span className="w-full text-[12px] text-muted-2">
                  {first}&rsquo;s &ldquo;video in review&rdquo; notices are bell-only — they hear about a cut in the hub, not by
                  Slack or text. Change it for them under Team notifications if they should.
                </span>
              )}
              {saved && saved.id === picked?.id && <SeatAway seat={saved} onChanged={loadRoster} />}
            </div>
          );
        })}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Offer the backup a cut the reviewer hasn&rsquo;t reached after</span>
          <Num label="Reviewer cover offer after" value={r.coverOfferHours} onChange={(n) => set({ coverOfferHours: n })} min={1} max={90} suffix="covered hours" />
          <span className="w-full text-[11px] leading-relaxed text-muted-2">
            Covered hours are the rota above (Mon–Fri 9–6 ET by default). All three seats are told about every cut and
            can rule on it at any time; this is when the backup is nudged that the reviewer hasn&rsquo;t got to one. After
            two covered days a cut is on Jordan&rsquo;s exceptions board.
          </span>
        </div>
        <div className="mt-2 flex items-start justify-between gap-3 border-t border-border pt-2">
          <div>
            <p className="text-[13px] font-medium">Move it automatically</p>
            <p className="text-[12px] text-muted">
              Off: only marking someone away moves a cut on its own. On, a cut the reviewer hasn&rsquo;t ruled on moves to
              the next seat after the hours below — a change of owner nobody accepted, so it stays off until Jordan
              decides.
            </p>
            {autoMove && (
              <div className="mt-1.5">
                <Num label="Reviewer cover transfer after" value={r.coverTransferHours ?? 18} onChange={(n) => set({ coverTransferHours: n })} min={1} max={200} suffix="covered hours" />
              </div>
            )}
          </div>
          <Toggle on={autoMove} onChange={(v) => set({ coverTransferHours: v ? 18 : null })} label="Move cuts automatically" />
        </div>
      </div>

      <SaveRow busy={busy} feedback={feedback} dirty={dirty} label="Save review rules" onSave={() => save(saveReviewRoomRules)} />
    </div>
  );
}
