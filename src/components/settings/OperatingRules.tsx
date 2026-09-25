"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { saveTurnarounds, saveInternalAlerts, saveTextTemplates, saveReviewRoomRules, loadOnCallCandidates } from "@/app/settings/actions";
import { loadCutReviewerSeats, setCutReviewerAway } from "@/app/review/actions";
import type { ReviewerSeat } from "@/components/review/reviewerTypes";
import type { TurnaroundRules, InternalAlertRules, TextTemplates, ReviewRoomRules } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { BUILTIN_TEMPLATE_TEXT } from "@/lib/textTemplateDefaults";

// Everything that used to be a constant in the code (Jordan, Sep 1: "I want
// settings for turnaround promises, alert thresholds, anything currently hard
// coded"). Each group saves independently so one bad edit can't take the rest
// with it, and every value is clamped again server-side on read.

const hour12 = (h: number) => {
  const am = h < 12 || h === 24;
  const v = h % 12 === 0 ? 12 : h % 12;
  return `${v}:00 ${am ? "AM" : "PM"}`;
};

function Num({ value, onChange, min, max, suffix, wide }: { value: number; onChange: (n: number) => void; min: number; max: number; suffix?: string; wide?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/[^\d]/g, ""));
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className={cn("rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm tabular-nums outline-none focus:border-brand", wide ? "w-20" : "w-16")}
      />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </span>
  );
}

// Exported (Sep 11) so the owner's "Text me" card uses the same switch and
// Save row as the rest of the page rather than a look-alike.
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50", on ? "bg-success" : "bg-surface-2 ring-1 ring-border")}
    >
      <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

export function SaveRow({ onSave, msg, busy }: { onSave: () => void; msg: string | null; busy: boolean }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button onClick={onSave} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
      </button>
      {msg && <span className="text-[13px] font-medium text-muted">{msg}</span>}
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
  const [r, setR] = useState(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
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
            <Num
              value={r[row.key] as number}
              onChange={(n) => { setR((p) => ({ ...p, [row.key]: n })); setMsg(null); }}
              min={1} max={row.max} suffix={row.unit}
            />
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <span className="text-[13px]"><b>Monthly content</b><span className="text-muted"> — personal branding batches</span></span>
          <Num value={r.monthlyBusinessDays} onChange={(n) => { setR((p) => ({ ...p, monthlyBusinessDays: n })); setMsg(null); }} min={1} max={60} suffix="business days" />
        </div>
      </div>
      <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
        const res = await saveTurnarounds(r).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
        setMsg(res.message);
      })} />
    </div>
  );
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
  const rota = onCall
    ? `Outside it, routine alerts wait for the next covered period and urgent ones go to ${onCall.name.split(/\s+/)[0]}.`
    : "Outside it, routine alerts wait for the next covered period. Nobody is named for urgent ones, so they still page whoever holds the owner or admin role — the same people as today.";
  return `Somebody is on ${window}. ${rota}`;
}

export function InternalAlertSettings({ initial }: { initial: InternalAlertRules }) {
  const [r, setR] = useState(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const set = (patch: Partial<InternalAlertRules>) => { setR((p) => ({ ...p, ...patch })); setMsg(null); };
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
          Messages are captured around the clock and always show up on the boards. This only decides who gets
          <i> interrupted</i>, and when.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Covered</span>
          <Num value={r.coverage.fromHour} onChange={(n) => setCover({ fromHour: n })} min={0} max={22} suffix={hour12(r.coverage.fromHour)} />
          <span className="text-xs text-muted-2">to</span>
          <Num value={r.coverage.toHour} onChange={(n) => setCover({ toHour: n })} min={1} max={23} suffix={`ET (${hour12(r.coverage.toHour)})`} />
        </div>

        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
          <span className="text-[13px]">Weekdays only<span className="text-muted"> — off means the weekend counts as a normal day</span></span>
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
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Upload reminder</p>
            <p className="text-[13px] text-muted">Texts a photographer whose shoot has no submitted upload page.</p>
          </div>
          <Toggle on={r.uploadReminder.enabled} onChange={(v) => set({ uploadReminder: { ...r.uploadReminder, enabled: v } })} label="Upload reminder" />
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Sends at</span>
          <Num value={r.uploadReminder.hour} onChange={(n) => set({ uploadReminder: { ...r.uploadReminder, hour: n } })} min={0} max={23} suffix={`ET (${hour12(r.uploadReminder.hour)})`} />
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Late-night chaser</p>
            <p className="text-[13px] text-muted">Second nudge if the upload page is still not submitted.</p>
          </div>
          <Toggle on={r.uploadChaser.enabled} onChange={(v) => set({ uploadChaser: { ...r.uploadChaser, enabled: v } })} label="Upload chaser" />
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Sends at</span>
          <Num value={r.uploadChaser.hour} onChange={(n) => set({ uploadChaser: { ...r.uploadChaser, hour: n } })} min={0} max={23} suffix={`ET (${hour12(r.uploadChaser.hour)})`} />
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Photos not delivered</p>
            <p className="text-[13px] text-muted">Texts Kyle and Jordan when a shoot&rsquo;s photos still aren&rsquo;t released.</p>
          </div>
          <Toggle on={r.photosUndelivered.enabled} onChange={(v) => set({ photosUndelivered: { ...r.photosUndelivered, enabled: v } })} label="Photos not delivered" />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Late after</span>
          <Num value={r.photosUndelivered.lateAfterHours} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, lateAfterHours: n } })} min={1} max={336} suffix="hours" />
          <span className="text-[13px] text-muted">· alert between</span>
          <Num value={r.photosUndelivered.fromHour} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, fromHour: n } })} min={0} max={22} suffix={hour12(r.photosUndelivered.fromHour)} />
          <span className="text-xs text-muted-2">and</span>
          <Num value={r.photosUndelivered.toHour} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, toHour: n } })} min={1} max={23} suffix={hour12(r.photosUndelivered.toHour)} />
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
          <p className="text-[13px] text-muted">Bell + text to the creative when a video job&rsquo;s footage can&rsquo;t be found.</p>
        </div>
        <Toggle on={r.rawVideoMissing.enabled} onChange={(v) => set({ rawVideoMissing: { enabled: v } })} label="Raw video missing" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Kyle&rsquo;s Slack digests</p>
          <p className="text-[13px] text-muted">Morning list and the 4 PM open-items recap.</p>
        </div>
        <Toggle on={r.kyleDigests.enabled} onChange={(v) => set({ kyleDigests: { enabled: v } })} label="Kyle's Slack digests" />
      </div>

      <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
        const res = await saveInternalAlerts(r).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
        setMsg(res.message);
      })} />
    </div>
  );
}

const TPL_FIELDS: { key: keyof TextTemplates; label: string; hint: string; vars: string[] }[] = [
  { key: "confirmation", label: "Shoot confirmation", hint: "sent before the shoot", vars: ["{first}", "{street}", "{when}", "{items}"] },
  { key: "deliveryAll", label: "Delivery — everything shipped", hint: "", vars: ["{first}", "{street}", "{feedbackUrl}"] },
  { key: "deliveryPartial", label: "Delivery — part still in production", hint: "", vars: ["{first}", "{street}", "{delivered}", "{remaining}", "{feedbackUrl}"] },
];

export function TextTemplateSettings({ initial }: { initial: TextTemplates }) {
  const [t, setT] = useState(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Leave a box empty to use the hub&rsquo;s built-in wording. Placeholders are filled in automatically — an unknown
        one is left as-is rather than sent blank.
      </p>
      {TPL_FIELDS.map((f) => (
        <div key={f.key}>
          <label className="text-[13px] font-medium">
            {f.label}
            {f.hint && <span className="font-normal text-muted"> — {f.hint}</span>}
          </label>
          <textarea
            value={t[f.key] || BUILTIN_TEMPLATE_TEXT[f.key]}
            onChange={(e) => { setT((p) => ({ ...p, [f.key]: e.target.value })); setMsg(null); }}
            rows={3}
            placeholder="Type the message clients should get"
            className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <p className="mt-1 text-[11px] text-muted-2">Placeholders: {f.vars.join(" · ")}</p>
        </div>
      ))}
      <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
        const res = await saveTextTemplates(t).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
        setMsg(res.message);
      })} />
    </div>
  );
}


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
  const [r, setR] = useState(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const set = (patch: Partial<ReviewRoomRules>) => { setR((p) => ({ ...p, ...patch })); setMsg(null); };
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
          <Num value={r.keepUploadsDays} onChange={(n) => set({ keepUploadsDays: n })} min={1} max={365} suffix="days" />
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
                    {!m.hasLogin ? " — no login yet" : !m.canRuleIfDesignated ? " — editor login, can't review" : m.loginRole !== "OWNER" && m.loginRole !== "ADMIN" ? " — only Jordan can seat" : ""}
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
          <Num value={r.coverOfferHours} onChange={(n) => set({ coverOfferHours: n })} min={1} max={90} suffix="covered hours" />
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
                <Num value={r.coverTransferHours ?? 18} onChange={(n) => set({ coverTransferHours: n })} min={1} max={200} suffix="covered hours" />
              </div>
            )}
          </div>
          <Toggle on={autoMove} onChange={(v) => set({ coverTransferHours: v ? 18 : null })} label="Move cuts automatically" />
        </div>
      </div>

      <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
        const res = await saveReviewRoomRules(r).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
        setMsg(res.message);
      })} />
    </div>
  );
}