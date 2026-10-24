"use client";

import { useState, useTransition } from "react";
import { Switch } from "@/components/ui/Switch";
import { setSpellingFlagsForReviewers } from "@/app/review/spellingActions";

// Settings → Video Review Room (Oct 24 2026; lib/videoAnalysis): who sees the
// on-screen spelling check's flags. OFF: only Jordan, with Right / Wrong, while
// it is on trial. ON: the reviewer sees them above Approve too. It never
// blocks a version either way. Only the owner can change it.
export function SpellingFlagsSetting({ initial, isOwner, trialWords }: { initial: boolean; isOwner: boolean; trialWords: string | null }) {
  const [on, setOn] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <div className="mt-4 border-t border-border pt-4" data-setting="spelling-flags-reviewers">
      <Switch
        checked={on}
        busy={busy}
        disabled={!isOwner}
        onChange={(next) => {
          setOn(next);
          start(async () => {
            const r = await setSpellingFlagsForReviewers(next).catch((e: Error) => ({ ok: false, message: e.message }));
            if (!r.ok) setOn(!next);
            setMsg(r.message);
          });
        }}
        label="Show spelling flags to reviewers"
        description={`The on-screen spelling check (Gemini) is on trial: until this is on, only Jordan sees its flags. On, the reviewer sees them above Approve. It never blocks anything.${trialWords ? ` Trial so far: ${trialWords}.` : ""}${isOwner ? "" : " Only Jordan changes this."}`}
      />
      {msg && <p className="mt-1 text-xs text-muted">{msg}</p>}
    </div>
  );
}
