"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, MessageSquare, RotateCcw, Smartphone } from "lucide-react";
import { saveTeamNotifyPrefs } from "@/app/settings/actions";
import {
  NOTIFY_EVENTS, defaultPrefsForRow, notifyGroupLabel, notifyPrefsEqual,
  type NotifyChannels, type NotifyEvent, type NotifyPrefs, type TeamNotifyRow,
} from "@/lib/notifyPrefDefaults";
import { Toggle, SaveRow } from "@/components/settings/OperatingRules";
import { cn } from "@/lib/utils";

// "Team notifications" (Jordan, Sep 15: "I should be able to manage team
// notifications in settings"). One block per active person, a 5-event ×
// 2-channel matrix of switches, its own Save. This card absorbed the Sep 11
// "Text me" card: the owner is simply a row here (his tags + a video waiting
// on review, by text — the same two answers, in the same store the bridge
// reads). Client-safe on purpose: the only imports are the server action, a
// dependency-free defaults module, and the page's own Toggle/SaveRow.

const CHANNELS: { key: keyof NotifyChannels; label: string; Icon: typeof MessageSquare }[] = [
  { key: "slack", label: "Slack DM", Icon: MessageSquare },
  { key: "sms", label: "Text", Icon: Smartphone },
];

const PEOPLE_HREF = "/users?tab=team";

export function TeamNotifications({ rows }: { rows: TeamNotifyRow[] }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-muted">Nobody active on the roster yet — add people on <Link href={PEOPLE_HREF} className="font-medium text-brand hover:underline">People</Link>.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        The bell always rings. These decide what <em>also</em> reaches each person on Slack or by text — with who said it,
        the first line, and the link. Never for something they did themselves.
      </p>
      <div className="rounded-lg border border-border bg-surface-2 p-3 text-[13px] text-muted">
        <p>
          <b className="font-medium text-foreground">Slack DMs</b> go out straight away, from the Ops Hub app, and need the person&rsquo;s Slack member ID on
          their card. <b className="font-medium text-foreground">Texts</b> go from the office line, marked &ldquo;⚙️ RealTour Hub&rdquo;, between 7 AM and 10 PM in the
          person&rsquo;s own time zone (ET; Manila for the editors) — later ones wait for the morning, and several within half an hour arrive as one text.
          Only a US number can be texted, and never the office line itself.
        </p>
      </div>
      <div className="space-y-3">
        {rows.map((row) => (
          <PersonBlock key={row.teamMemberId} row={row} />
        ))}
      </div>
    </div>
  );
}

function PersonBlock({ row }: { row: TeamNotifyRow }) {
  const defaults = defaultPrefsForRow(row);
  const [saved, setSaved] = useState<NotifyPrefs>(row.prefs);
  const [draft, setDraft] = useState<NotifyPrefs>(row.prefs);
  const [explicit, setExplicit] = useState(row.explicit);
  const [open, setOpen] = useState(true);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const first = row.name.split(/\s+/)[0];
  const group = notifyGroupLabel(row);
  const dirty = !notifyPrefsEqual(draft, saved);
  const atDefaults = notifyPrefsEqual(draft, defaults);
  const canSlack = !!row.slackId;
  const canSms = row.hasPhone;
  const panelId = `notify-${row.teamMemberId}`;

  const flip = (event: NotifyEvent, channel: keyof NotifyChannels) => (v: boolean) => {
    setDraft((p) => ({ ...p, [event]: { ...p[event], [channel]: v } }));
    setMsg(null);
  };

  // What is on right now — the one line that makes the collapsed block (and a
  // long roster) readable at a glance. Draft, not saved: it follows the switches.
  const onFor = (channel: keyof NotifyChannels) => NOTIFY_EVENTS.filter((e) => draft[e.key][channel]).map((e) => e.short);
  const summary = CHANNELS.map((c) => {
    const on = onFor(c.key);
    return `${c.label}: ${on.length ? on.join(", ") : "off"}`;
  }).join(" · ");

  // Why texts can't go: a number that IS on the roster but is our own office
  // line (Kyle) or not a US number is not "add a phone" — it's "this one
  // can't be texted", and the chip, the line and the hover all say which
  // (review, Sep 15).
  const phoneWhy =
    row.phoneNote === "company_line" ? `${first}'s roster phone is the company line — the hub can't text the office number from itself`
    : row.phoneNote === "non_us" ? `${first}'s roster phone isn't a US number — the office line can't text it`
    : null;
  const phoneChip = row.phoneNote === "company_line" ? "company line" : row.phoneNote === "non_us" ? "non-US number" : "no phone";

  // The muted line naming what is missing — with the link to fix it.
  const missing: React.ReactNode[] = [];
  if (!canSlack) missing.push(<span key="slack">no Slack ID — nothing reaches Slack until it&rsquo;s added on <Link href={PEOPLE_HREF} className="font-medium text-brand hover:underline">People</Link></span>);
  if (!canSms) {
    missing.push(
      phoneWhy
        ? <span key="sms">{phoneWhy}, so texts stay off</span>
        : <span key="sms">no phone on the roster — nothing can be texted until it&rsquo;s added on <Link href={PEOPLE_HREF} className="font-medium text-brand hover:underline">People</Link></span>,
    );
  }

  const reason = (channel: keyof NotifyChannels, on: boolean): string | undefined => {
    if (channel === "slack" && !canSlack) return on ? `Set, but ${first} has no Slack ID on file — add it on People and this starts working.` : `No Slack ID on ${first}'s card — add it on People first.`;
    if (channel === "sms" && !canSms) {
      if (phoneWhy) return `${phoneWhy}.`;
      return on ? `Set, but ${first} has no phone on the roster — add it on People and this starts working.` : `No phone on ${first}'s roster row — add it on People first.`;
    }
    return undefined;
  };

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          className="inline-flex items-center gap-1.5 rounded-md text-left text-sm font-semibold hover:text-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {open ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
          {row.name}
        </button>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted" title={`Roster role: ${row.role}`}>{group}</span>
        <Chip ok={canSlack} okText="Slack ✓" missingText="no Slack ID" Icon={MessageSquare} title={canSlack ? `Slack member ID ${row.slackId}` : "Add it on People"} />
        <Chip ok={canSms} okText="text ✓" missingText={phoneChip} Icon={Smartphone} title={canSms ? "A US number is on the roster" : phoneWhy ?? "Add it on People"} />
        {explicit && !dirty && <span className="text-[11px] text-muted-2">custom</span>}
        {dirty && <span className="text-[11px] font-medium text-warning">unsaved</span>}
        <span className="ml-auto hidden text-[12px] text-muted sm:block">{summary}</span>
      </div>
      {missing.length > 0 && (
        <p className="border-t border-border px-3 py-1.5 text-[12px] text-muted">
          {missing.map((m, i) => <span key={i}>{i > 0 && " · "}{m}</span>)}
        </p>
      )}
      {open && (
        <div id={panelId} className="border-t border-border px-3 pb-3 pt-1">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted">
                  <th scope="col" className="py-1.5 pr-3 text-left font-semibold">Ping {first} when…</th>
                  {CHANNELS.map((c) => (
                    <th key={c.key} scope="col" className="w-24 py-1.5 text-center font-semibold">
                      <span className="inline-flex items-center gap-1"><c.Icon className="size-3" /> {c.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {NOTIFY_EVENTS.map((e) => (
                  <tr key={e.key} className="border-t border-border">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {e.label}
                    </th>
                    {CHANNELS.map((c) => {
                      const on = draft[e.key][c.key];
                      const can = c.key === "slack" ? canSlack : canSms;
                      return (
                        <td key={c.key} className="py-2 text-center">
                          <span className={cn("inline-flex", !can && "opacity-60")} title={reason(c.key, on)}>
                            <Toggle
                              on={on}
                              onChange={flip(e.key, c.key)}
                              disabled={!can}
                              label={`${c.label} ${first} when ${e.label.toLowerCase()}`}
                            />
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
              const res = await saveTeamNotifyPrefs(row.teamMemberId, draft).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
              setMsg(res.message);
              if (res.ok) { setSaved(draft); setExplicit(true); }
            })} />
            <button
              type="button"
              onClick={() => { setDraft(defaults); setMsg(atDefaults ? null : "Back to the defaults for this role — Save to keep."); }}
              disabled={busy || atDefaults}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={atDefaults ? `${first} is on the ${group.toLowerCase()} defaults` : `Put ${first} back on the ${group.toLowerCase()} defaults`}
            >
              <RotateCcw className="size-3.5" /> Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ ok, okText, missingText, Icon, title }: { ok: boolean; okText: string; missingText: string; Icon: typeof MessageSquare; title: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ok ? "bg-success-soft text-success" : "bg-surface-2 text-muted",
      )}
    >
      <Icon className="size-3" /> {ok ? okText : missingText}
    </span>
  );
}
