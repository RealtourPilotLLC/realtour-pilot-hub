"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { rerunTopazAction } from "@/app/ops/deliveryRecoveryActions";
import { RERUN_CONFIRM, RERUN_LABEL, rerunCostLine } from "@/lib/topazRerun";

/**
 * "Run Topaz again" (Jordan, Oct 23 2026: "I want to be able to re run the
 * videos through topaz if the topaz pass doesn't look good"). Beside Watch it
 * on a video whose Topaz file is finished and not sent yet: the Video Review
 * Room (Ready to send and held rows), Kyle's desk and the job page. The owner
 * and the office see it; the server refuses everyone else, and refuses a
 * video that went out since the page was drawn.
 *
 * IT ASKS FIRST, because a re-run is a new render and spends credits. The
 * first press opens a confirm that shows what it should cost with today's
 * Settings before anything is spent: "Yes, run it again" or Cancel. It stays
 * open until one of them is pressed (Oct 23 2026: the old question reverted
 * by itself after ten seconds, and on Jordan's phone two presses never
 * reached the server), and the press says what happened in words that stay.
 *
 * A client component: it takes ids and numbers and calls a server action. It
 * must not import @/lib/topazJobs (server-only); the words come from the pure
 * @/lib/topazRerun, the same module the server's refusals use.
 */
export function RerunTopaz({ jobId, street, credits, limit, video }: { jobId: string; street: string; credits: number | null; limit: number | null; /** which video, when a row carries more than one */ video?: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const what = `${video ? `${video}, ` : ""}${street}`;

  const run = () => {
    setMsg(null);
    start(async () => {
      const r = await rerunTopazAction(jobId).catch(() => ({ ok: false, message: "Couldn't reach the hub. Nothing changed; refresh the page and try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        setAsking(false);
        router.refresh();
      }
    });
  };

  return (
    <div className="mt-2 min-w-0 space-y-1.5" data-rerun-topaz={jobId}>
      {!asking ? (
        <Button variant="secondary" busy={busy} onClick={() => { setAsking(true); setMsg(null); }} aria-label={`${RERUN_LABEL} for ${what}`}>
          <RotateCcw aria-hidden className="size-4" /> {RERUN_LABEL}{video ? `: ${video}` : ""}
        </Button>
      ) : (
        <div role="group" aria-label={`${RERUN_LABEL} for ${what}`} className="space-y-2 rounded-lg border border-border bg-surface-2/40 p-3">
          <p className="text-sm text-muted" data-rerun-cost>{rerunCostLine({ credits, limit })}</p>
          <div className="flex flex-wrap gap-2">
            <Button busy={busy} busyLabel="Starting..." onClick={run} aria-label={`${RERUN_CONFIRM}: run the Topaz pass again for ${what}`}>
              <RotateCcw aria-hidden className="size-4" /> {RERUN_CONFIRM}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => { setAsking(false); setMsg(null); }}>Cancel</Button>
          </div>
        </div>
      )}
      {msg && <p role="status" className={msg.ok ? "text-sm font-medium text-success" : "text-sm font-medium text-danger"}>{msg.text}</p>}
    </div>
  );
}
