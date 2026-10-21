"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Action";
import { deliverVideoNowAction, releaseVideoPushAction } from "@/app/review/videoSendActions";

// ---------------------------------------------------------------------------
// The buttons on a video a person already started sending (Oct 19 2026):
// Deliver now (on the listing, waiting for a person) and Release (a run a
// person held: the hub does nothing more with it until it is released). Each
// press answers in plain words. Try again is the row's own Upload button
// (SendVideo). Oct 20 2026 (audit B15): the Try again and Hold branches here
// were never offered (the room always passed false), so they and their
// actions are gone; Deliver now and Release moved beside the room's other
// delivery actions (review/videoSendActions).
// ---------------------------------------------------------------------------

export function PushControls(props: { submissionId: string; canDeliverNow: boolean; canRelease: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      try {
        const r = await fn();
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        setMsg({ ok: false, text: "The hub didn't answer. Reload to see what is saved." });
      }
    });
  if (!props.canDeliverNow && !props.canRelease) return null;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {props.canDeliverNow && (
          <Button variant="primary" busy={pending} onClick={() => run(() => deliverVideoNowAction(props.submissionId))}>
            <Send aria-hidden className="size-4" /> Deliver now
          </Button>
        )}
        {props.canRelease && (
          <Button variant="secondary" disabled={pending} onClick={() => run(() => releaseVideoPushAction(props.submissionId))}>
            <Play aria-hidden className="size-4" /> Release
          </Button>
        )}
      </div>
      {msg && <p role="status" className={cn("text-sm", msg.ok ? "text-muted" : "text-warning")}>{msg.text}</p>}
    </div>
  );
}
