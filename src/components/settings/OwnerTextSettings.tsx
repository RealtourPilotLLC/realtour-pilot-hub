"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { saveOwnerSmsPrefs } from "@/app/settings/actions";
import type { SmsPrefs } from "@/lib/smsPrefs";
import { Toggle, SaveRow } from "@/components/settings/OperatingRules";

// The owner's own two switches (Jordan, Sep 11: "make sure I get a text when a
// video is in review or I'm mentioned in a chat"). Client-safe on purpose: the
// only imports are the server action and a TYPE — the preference itself is
// read and written server-side (src/lib/smsPrefs.ts).

export function OwnerTextSettings({ initial, phoneMasked, linked }: { initial: SmsPrefs; phoneMasked: string | null; linked: boolean }) {
  // An owner login with no roster row (the second Google login) has nothing
  // to switch — the toggles show OFF and stay disabled rather than promising
  // a text that goes to the roster owner's phone (reviewer, Sep 11).
  const [reviewReady, setReviewReady] = useState(linked && initial.kinds.includes("review_ready"));
  const [mention, setMention] = useState(linked && initial.kinds.includes("mention"));
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const flip = (set: (v: boolean) => void) => (v: boolean) => { set(v); setMsg(null); };

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Texts to your own phone, from the office line, marked &ldquo;⚙️ RealTour Hub&rdquo;. The bell always rings; these decide what also reaches your pocket.
      </p>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">When a video is waiting on my review</p>
          <p className="text-[13px] text-muted">A cut lands in the Review Room — uploaded from the editor portal, sent from the Final folder, or found there by the hourly sweep (when that is switched on under Review Room). One text per version; none for a version you uploaded yourself.</p>
        </div>
        <Toggle on={reviewReady} onChange={flip(setReviewReady)} label="Text me when a video is waiting on my review" disabled={!linked} />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">When someone mentions me</p>
          <p className="text-[13px] text-muted">An @Jordan on any note, cut comment or team thread — who said it, the first line, and a link to the note. Not your own tags.</p>
        </div>
        <Toggle on={mention} onChange={flip(setMention)} label="Text me when someone mentions me" disabled={!linked} />
      </div>

      <div className="rounded-lg border border-border bg-surface-2 p-3 text-[13px] text-muted">
        <p>
          Between 10 PM and 7 AM the bell still lands; the text goes out at 7. Several within half an hour arrive as one text.
        </p>
        <p className="mt-1">
          {linked && phoneMasked ? (
            <>Texts go to <span className="font-medium text-foreground">{phoneMasked}</span> — your number on the roster.</>
          ) : linked ? (
            <>No phone on your roster row yet, so nothing can be sent.</>
          ) : (
            <>Your login isn&rsquo;t linked to a roster row yet, so these switches are off and can&rsquo;t be saved.</>
          )}{" "}
          Change it on <Link href="/users?tab=team" className="font-medium text-brand hover:underline">People</Link>.
        </p>
      </div>

      {linked && (
        <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
          const res = await saveOwnerSmsPrefs({ reviewReady, mention }).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
          setMsg(res.message);
        })} />
      )}
    </div>
  );
}
