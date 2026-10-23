"use client";

import { useId, useState, useTransition } from "react";
import { savePhotographerBrief } from "@/app/settings/actions";
import { Button } from "@/components/ui/Action";
import { Switch } from "@/components/ui/Switch";

// THE PHOTOGRAPHER BRIEF (Oct 23 2026, lib/photographerBrief). The switch and
// the send time, owner and admin. Kept as literals here: the lib is server-only.
const CHOICES = Array.from({ length: 13 }, (_, i) => 15 * 60 + i * 30);
const words = (m: number) => {
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export function PhotographerBriefSettings({ initial }: { initial: { enabled: boolean; sendMinute: number } }) {
  const id = useId();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [sendMinute, setSendMinute] = useState(initial.sendMinute);
  const [saved, setSaved] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const dirty = enabled !== saved.enabled || sendMinute !== saved.sendMinute;
  return (
    <div className="mt-4 rounded-lg border border-border p-3" id="photographer-brief">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Photographer brief</p>
          <p className="text-[13px] text-muted">
            One text per photographer per shoot day, the business day before (Friday covers Saturday, Sunday and Monday): each visit&rsquo;s time and address, the services for that visit, access and the on-site contact, and the requests made for it. It links to a full brief with a Got it button. If something material changes (time, address, services, access, contact, requests, who is shooting it), an updated brief goes out and a new Got it is needed. Kyle&rsquo;s dashboard shows failed sends and briefs not acknowledged 2 hours before the first shoot.
          </p>
          <p className="mt-1 text-[13px] text-muted">
            While this is on, it replaces the night-before shoot brief text and the special-requests text at the shoot (their access task for Kyle stays). Off, nothing sends and those two carry on as before.
          </p>
          <p className="mt-0.5 text-[11px] text-muted-2">Read by the photographer brief check, every 5 minutes (src/lib/photographerBrief.ts).</p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} aria-label="Photographer brief" busy={busy} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <label htmlFor={id} className="text-[13px] text-muted">Sends at</label>
        <select
          id={id}
          value={sendMinute}
          onChange={(e) => setSendMinute(Number(e.target.value))}
          className="min-h-9 rounded-lg border border-border bg-surface-2 px-2 py-1 text-base outline-none focus:border-brand sm:min-h-0 sm:text-sm"
        >
          {CHOICES.map((m) => <option key={m} value={m}>{words(m)} ET</option>)}
        </select>
        <span className="text-[11px] text-muted-2">on the business day before the shoot.</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          busy={busy}
          busyLabel="Saving…"
          onClick={() =>
            start(async () => {
              const r = await savePhotographerBrief({ enabled, sendMinute }).catch(() => ({ ok: false, message: "Not saved. Try again." }));
              setMsg({ ok: r.ok, text: r.message });
              if (r.ok) setSaved({ enabled, sendMinute });
            })
          }
        >
          Save photographer brief
        </Button>
        {msg ? <span role="status" className={`text-[13px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</span> : dirty ? <span className="text-[13px] text-muted">Not saved yet.</span> : null}
      </div>
    </div>
  );
}
