"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { Camera, MessageSquare, Smartphone, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";
import { Toggle, SaveRow } from "@/components/settings/OperatingRules";
import { useSettingsDraft } from "@/components/settings/useSettingsDraft";
import { PersonSchedule } from "@/components/settings/NotificationSchedule";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EDITOR_TIMEZONES } from "@/lib/editors";
import { zonedTime } from "@/lib/datetime";
import {
  NOTIFY_EVENTS, SELF_MUST_REACH, clearInapplicable, eventAppliesTo, notifyGroupLabel,
  type NotifyChannels, type NotifyEvent, type NotifyPrefs, type NotifyScheduleRow, type TeamNotifyRow,
} from "@/lib/notifyPrefDefaults";
import { removeMyPhoto, saveMyNotifications, saveMyPhoto, saveMyProfile } from "@/app/profile/actions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// /profile, the part you touch (Oct 30 2026). Four blocks, each with its own
// save: the photo (saved the moment it is picked), contact and location, how
// the hub reaches you, and quiet time; plus light or dark for this device.
// ---------------------------------------------------------------------------

export type ProfileAccount = { name: string; email: string; role: string; readOnly: boolean };
export type ProfileCard = {
  id: string;
  phone: string;
  timezone: string;
  location: string;
  photoSrc: string | null;
  slackLinked: boolean;
  isEditor: boolean;
};

const EASTERN = "America/New_York";
const field = "min-h-11 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";

function Block({ title, intro, children }: { title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {intro && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{intro}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The clock, to the half minute, in the browser only: the server renders
 *  none, because its clock would not match the one the page hydrates with. */
const tick = (cb: () => void) => { const t = setInterval(cb, 30_000); return () => clearInterval(t); };
function useNow(): Date | null {
  const ms = useSyncExternalStore(tick, () => Math.floor(Date.now() / 30_000) * 30_000, () => null);
  return ms === null ? null : new Date(ms);
}

export function ProfileView({ account, card, notify, schedule }: {
  account: ProfileAccount;
  card: ProfileCard | null;
  notify: TeamNotifyRow | null;
  schedule: NotifyScheduleRow | null;
}) {
  return (
    <>
      {account.readOnly && (
        <p className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-[13px] text-muted">
          You&rsquo;re previewing {account.name}&rsquo;s profile. It&rsquo;s read only: exit the preview to change your own.
        </p>
      )}
      <Identity account={account} card={card} />
      {card ? (
        <>
          <Contact card={card} readOnly={account.readOnly} />
          {notify && <Notifications row={notify} readOnly={account.readOnly} />}
          {schedule && <QuietTime row={schedule} timezone={card.timezone} />}
        </>
      ) : (
        <Block title="Your team card">
          <p className="text-sm text-muted">
            Your login isn&rsquo;t linked to a team card yet, so there&rsquo;s nowhere to keep a photo, phone number or clock. Ask Jordan to
            press <b className="font-medium text-foreground">Team card</b> on your login in People → Logins, then come back here.
          </p>
        </Block>
      )}
      <Block title="Appearance" intro="Light or dark. This is remembered on this device only.">
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <span className="text-sm text-muted">Switch light and dark</span>
        </div>
      </Block>
    </>
  );
}

// ---- Photo, name, role ------------------------------------------------------

/** A phone photo is megabytes; the server keeps 256 px. Shrink it here so the
 *  upload is small and fast, and fall back to the original file when the
 *  browser can't read it (the server then says whether it can). */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 640 / Math.min(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.88));
  } catch {
    return file;
  }
}

function Identity({ account, card }: { account: ProfileAccount; card: ProfileCard | null }) {
  const [src, setSrc] = useState<string | null>(card?.photoSrc ?? null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const canEdit = !!card && !account.readOnly;

  const pick = (file: File | undefined) => {
    if (!file) return;
    setStatus(null);
    start(async () => {
      const blob = await shrink(file);
      const form = new FormData();
      form.append("photo", blob, "photo.jpg");
      const r = await saveMyPhoto(form);
      if (r.ok && r.src) setSrc(r.src);
      setStatus(r);
    });
  };
  const remove = () => {
    setStatus(null);
    start(async () => {
      const r = await removeMyPhoto();
      if (r.ok) setSrc(null);
      setStatus(r);
    });
  };

  return (
    <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <Avatar key={src ?? "none"} name={account.name} src={src} size={88} color="#4f46e5" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-lg font-semibold">{account.name}</p>
        <p className="truncate text-sm text-muted">{account.role} · {account.email}</p>
        {canEdit && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              ref={input}
              type="file"
              accept="image/*"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }}
            />
            <Button variant="secondary" busy={busy} busyLabel="Saving photo…" onClick={() => input.current?.click()}>
              <Camera aria-hidden className="size-4" /> {src ? "Change photo" : "Add a photo"}
            </Button>
            {src && !busy && (
              <Button variant="quiet" onClick={remove}>
                <Trash2 aria-hidden className="size-4" /> Remove
              </Button>
            )}
          </div>
        )}
        {status && <SaveStatus className="mt-2 block" state={status.ok ? "info" : "error"} message={status.message} />}
      </div>
    </section>
  );
}

// ---- Phone, location, time zone --------------------------------------------

function Contact({ card, readOnly }: { card: ProfileCard; readOnly: boolean }) {
  const { value: draft, setValue, busy, dirty, feedback, save } = useSettingsDraft({ phone: card.phone, timezone: card.timezone, location: card.location });
  const now = useNow();
  const known = EDITOR_TIMEZONES.some((z) => z.value === draft.timezone) || !draft.timezone ? EDITOR_TIMEZONES : [{ value: draft.timezone, label: draft.timezone }, ...EDITOR_TIMEZONES];
  const zones = [{ value: "", label: card.isEditor ? "Not set (Philippines)" : "Not set (US Eastern)" }, ...known];
  const myZone = draft.timezone || (card.isEditor ? "Asia/Manila" : EASTERN);

  return (
    <Block title="Contact and location" intro="Where you are and how to reach you. The office sees this on People.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted">Phone
          <input type="tel" value={draft.phone} disabled={readOnly} onChange={(e) => setValue((d) => ({ ...d, phone: e.target.value }))} placeholder="+63 917 123 4567" autoComplete="tel" className={field} />
          <span className="text-ui-status leading-snug">Outside the US, start with + and the country code.</span>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted">Location
          <input value={draft.location} disabled={readOnly} onChange={(e) => setValue((d) => ({ ...d, location: e.target.value }))} placeholder="City, country" maxLength={80} autoComplete="address-level2" className={field} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted sm:col-span-2">Time zone
          <select value={draft.timezone} disabled={readOnly} onChange={(e) => setValue((d) => ({ ...d, timezone: e.target.value }))} className={cn(field, "sm:max-w-sm")}>
            {zones.map((z) => <option key={z.value || "unset"} value={z.value}>{z.label}</option>)}
          </select>
          <span className="text-ui-status leading-snug">
            {card.isEditor ? "Your desk shows due times and sends reminders on this clock." : "The office sees your local time from this."}
            {now && <> Your time now: <b className="font-medium text-foreground">{zonedTime(now, myZone)}</b>{myZone !== EASTERN && <> ({zonedTime(now, EASTERN)} US Eastern)</>}.</>}
          </span>
        </label>
      </div>
      {!readOnly && <SaveRow busy={busy} feedback={feedback} dirty={dirty} label="Save" onSave={() => save((v) => saveMyProfile(v))} />}
    </Block>
  );
}

// ---- Notifications ----------------------------------------------------------

const CHANNELS: { key: keyof NotifyChannels; label: string; Icon: typeof MessageSquare }[] = [
  { key: "slack", label: "Slack", Icon: MessageSquare },
  { key: "sms", label: "Text", Icon: Smartphone },
];

function Notifications({ row, readOnly }: { row: TeamNotifyRow; readOnly: boolean }) {
  const group = notifyGroupLabel(row);
  const { value: draft, setValue, busy, dirty, feedback, save } = useSettingsDraft<NotifyPrefs>(clearInapplicable(row.prefs, group));
  const events = NOTIFY_EVENTS.filter((e) => eventAppliesTo(e.key, group));
  const must = SELF_MUST_REACH[group];
  const canSlack = !!row.slackId, canSms = row.hasPhone;
  const flip = (event: NotifyEvent, channel: keyof NotifyChannels) => (v: boolean) =>
    setValue((p) => ({ ...p, [event]: { ...p[event], [channel]: v } }));

  const smsWhy = row.phoneNote === "company_line" ? "That number is the office line, which can't text itself."
    : row.phoneNote === "non_us" ? "The office line can only text US numbers."
    : "Add a US phone number above to get texts.";

  return (
    <Block title="How the hub reaches you" intro="The bell in the hub always rings. These decide what also comes to you on Slack or by text.">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th scope="col" className="py-1.5 pr-3 text-left font-semibold">Tell me when…</th>
              {CHANNELS.map((c) => (
                <th key={c.key} scope="col" className="w-20 py-1.5 text-center font-semibold">
                  <span className="inline-flex items-center gap-1"><c.Icon aria-hidden className="size-3" /> {c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.key} className="border-t border-border">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {e.label}
                  {must === e.key && <span className="mt-0.5 block text-[12px] text-muted-2">Keep at least one on: this is how new work reaches you.</span>}
                </th>
                {CHANNELS.map((c) => {
                  const can = c.key === "slack" ? canSlack : canSms;
                  return (
                    <td key={c.key} className="py-2 text-center">
                      <span className={cn("inline-flex", !can && "opacity-60")} title={can ? undefined : c.key === "slack" ? "No Slack ID on your card yet." : smsWhy}>
                        {/* A channel that can't reach you reads off, whatever is stored for it. */}
                        <Toggle on={can && draft[e.key][c.key]} onChange={flip(e.key, c.key)} disabled={readOnly || !can} label={`${c.label} when ${e.label.toLowerCase()}`} />
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(!canSlack || !canSms) && (
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          {!canSlack && <>Slack is off until Jordan adds your Slack ID on People. </>}
          {!canSms && <>Texts: {smsWhy}</>}
        </p>
      )}
      {!readOnly && <SaveRow busy={busy} feedback={feedback} dirty={dirty} label="Save notifications" onSave={() => save((v) => saveMyNotifications(v))} />}
    </Block>
  );
}

// ---- Quiet time -------------------------------------------------------------

function QuietTime({ row: initial, timezone }: { row: NotifyScheduleRow; timezone: string }) {
  const [row, setRow] = useState(initial);
  const now = useNow();
  const away = !!timezone && timezone !== EASTERN;
  return (
    <Block
      title="Quiet time"
      intro={<>Inside your quiet time the bell still rings, but Slack messages and texts wait and arrive together when it ends. Nothing is dropped. Times are US Eastern.</>}
    >
      {away && now && (
        <p className="mb-2 text-[13px] text-muted">
          Right now it&rsquo;s <b className="font-medium text-foreground">{zonedTime(now, timezone)}</b> where you are and{" "}
          <b className="font-medium text-foreground">{zonedTime(now, EASTERN)}</b> US Eastern.
        </p>
      )}
      <PersonSchedule key={row.teamMemberId} row={row} onSaved={setRow} />
    </Block>
  );
}
