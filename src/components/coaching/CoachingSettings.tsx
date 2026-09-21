"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Toggle, SaveRow } from "@/components/settings/OperatingRules";
import { loadCoachingRoster, saveCoachingSettings, type CoachingRosterRow } from "@/components/coaching/actions";
import type { CommsCoachingSettings } from "@/lib/commsCoaching";

// ---------------------------------------------------------------------------
// END-OF-DAY COMMS COACHING — the controls (Jordan, Sep 21 2026).
//
// TWO SWITCHES, BECAUSE THE ENGINE HONOURS TWO. Who is coached, and whether the
// note is actually sent. There is deliberately no third "run the audit" switch:
// an empty roster already IS the off position (runDailyCommsCoaching returns
// without reading anything), and a toggle that wrote a field commsCoaching.ts
// never reads would sit here looking like an off switch while the cron carried
// on. The copy below says it in words instead.
//
// The "only Jordan sees it" default is explained IN THE CARD, not just in a
// code comment, because the person deciding whether to flip it is reading this
// screen and not the source.
// ---------------------------------------------------------------------------

export function CoachingSettings({ initial, isOwner }: { initial: CommsCoachingSettings; isOwner: boolean }) {
  const [s, setS] = useState<CommsCoachingSettings>(initial);
  const [roster, setRoster] = useState<CoachingRosterRow[] | null>(null);
  const [rosterFailed, setRosterFailed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();

  // Fetched, not passed in — same reason the creative-approver picker fetches
  // its roster: /settings should not wait on a query most visits never need.
  // Only the owner may read it, so a non-owner never even asks.
  useEffect(() => {
    if (!isOwner) return;
    loadCoachingRoster()
      .then(setRoster)
      .catch(() => setRosterFailed(true));
  }, [isOwner]);

  const set = (patch: Partial<CommsCoachingSettings>) => {
    setS((p) => ({ ...p, ...patch }));
    setMsg(null);
  };

  const toggleMember = (id: string) =>
    set({
      teamMemberIds: s.teamMemberIds.includes(id) ? s.teamMemberIds.filter((x) => x !== id) : [...s.teamMemberIds, id],
    });

  const save = () =>
    start(async () => {
      const res = await saveCoachingSettings({ teamMemberIds: s.teamMemberIds, sendEnabled: s.sendEnabled });
      setMsg(res.message);
    });

  if (!isOwner) {
    return (
      <p className="text-[13px] leading-relaxed text-muted">
        These rules are Jordan&rsquo;s. They decide whose client messages the end-of-day audit reads and
        whether the note it writes is sent to that person, so they are not an operations setting.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-muted">
        At 7:00 PM ET the hub reads the client texts the people below sent from the company line, and writes
        each of them one short note: thanks for a job handled, what went well, one or two things to try with an
        example and the reason. A day that read fine says so and stops. Automatic texts are never read &mdash;
        those are the hub&rsquo;s words, not anyone&rsquo;s.
      </p>

      <div className="rounded-lg border border-border p-3">
        <p className="text-sm font-semibold">Who is coached</p>
        <p className="text-[13px] leading-relaxed text-muted">
          Nobody selected means the audit does not run at all &mdash; this list is the on switch. Only messages
          the hub can prove came from that person are read; anything it cannot attribute is left alone rather
          than guessed at.
        </p>
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          {rosterFailed && (
            <p className="text-[13px] text-warning">
              The team roster could not be read just now &mdash; reload to try again. Nobody has been added or removed.
            </p>
          )}
          {!rosterFailed && roster === null && <p className="text-[13px] text-muted-2">Loading the team&hellip;</p>}
          {roster?.map((m) => {
            const on = s.teamMemberIds.includes(m.id);
            return (
              <label
                key={m.id}
                className="flex cursor-pointer flex-wrap items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleMember(m.id)}
                  className="size-4 shrink-0 accent-[var(--brand)]"
                />
                <span className="text-sm font-medium">{m.name}</span>
                <span className="text-[11px] uppercase tracking-wide text-muted-2">{m.role}</span>
                {on && !m.reachable && (
                  <span className="text-[11px] text-warning">{"no Slack — a note can be written but not sent"}</span>
                )}
                {on && !m.hasLogin && (
                  <span className="text-[11px] text-muted-2">{"no login — can’t read their own notes in the hub"}</span>
                )}
              </label>
            );
          })}
          {roster?.length === 0 && <p className="text-[13px] text-muted">Nobody active on the team to pick from.</p>}
        </div>
      </div>

      <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Send the note to them</p>
          <p className="text-[13px] leading-relaxed text-muted">
            Off by default, and worth leaving off for a week. The first note someone gets decides whether this
            reads as help or as being watched, so you should read a few before any of them are sent. Nothing
            else waits on this switch: the note is still written every evening and the report shows it exactly
            as it would arrive. Turning it on before the day is out sends today&rsquo;s note as it stands, without
            re-reading anything.
          </p>
        </div>
        <Toggle on={s.sendEnabled} onChange={(v) => set({ sendEnabled: v })} label="Send coaching notes to the person" />
      </div>

      <SaveRow onSave={save} msg={msg} busy={busy} />

      <Link
        href="/coaching"
        className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand hover:underline"
      >
        Open the coaching report <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}
