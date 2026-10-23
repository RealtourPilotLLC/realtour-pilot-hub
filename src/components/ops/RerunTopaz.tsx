"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
 * second press shows what it should cost with today's Settings before
 * anything is spent, and that the free price check and every limit still
 * apply. The question reverts by itself, so a mis-tap costs nothing.
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A row that leaves on a refresh must not take a pending timer with it.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const press = () => {
    if (!asking) {
      setAsking(true);
      setMsg(null);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAsking(false), 10_000);
      return;
    }
    setAsking(false);
    start(async () => {
      const r = await rerunTopazAction(jobId).catch(() => ({ ok: false, message: "Couldn't reach the hub. Nothing changed; try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="mt-2 min-w-0 space-y-1" data-rerun-topaz={jobId}>
      <Button variant="secondary" busy={busy} onClick={press} aria-label={asking ? `${RERUN_CONFIRM}: run the Topaz pass again for ${video ? `${video}, ` : ""}${street}` : `${RERUN_LABEL} for ${video ? `${video}, ` : ""}${street}`}>
        <RotateCcw aria-hidden className="size-4" /> {asking ? RERUN_CONFIRM : RERUN_LABEL}{video ? `: ${video}` : ""}
      </Button>
      {asking && <p className="text-xs text-muted" data-rerun-cost>{rerunCostLine({ credits, limit })}</p>}
      {msg && <p role="status" className={msg.ok ? "text-xs text-muted" : "text-xs text-danger"}>{msg.text}</p>}
    </div>
  );
}
