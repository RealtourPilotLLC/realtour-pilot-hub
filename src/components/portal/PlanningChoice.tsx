"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PenLine, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalCancelSessionRequest, portalPlanWithoutCall } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";

/** "Plan without a call" — rendered ONLY when the server says the enrollment is eligible. Sets the written path; never cancels a booked call. */
export function PlanWithoutCall({ monthId, callBooked }: { monthId: string; callBooked: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const go = () => start(async () => {
    const r = await portalPlanWithoutCall(portalAuthFromLocation(), monthId).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { setConfirm(false); router.refresh(); }
  });
  return (
    <div className="mt-2">
      {!confirm ? (
        <button type="button" onClick={() => setConfirm(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><PenLine className="size-3.5" /> Plan without a call instead</button>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-3 text-sm">
          <p>Plan this month in writing? You&rsquo;ll pick topics and answer a few short questions per topic; session booking opens a few business days after your answers are in.</p>
          {callBooked && <p className="mt-1 text-xs text-muted">Your booked call stays on the calendar — cancel it on Calendly separately if you no longer need it.</p>}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={go} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy && <Loader2 className="size-3 animate-spin" />} Yes, plan in writing</button>
            <button type="button" onClick={() => setConfirm(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Keep the call</button>
          </div>
        </div>
      )}
      {msg && <p role="status" className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

/** Cancel one of the client's own session requests — the real cancellation, offered separately from any planning choice. */
export function CancelRequestButton({ requestId, confirmed }: { requestId: string; confirmed: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const go = () => start(async () => {
    const r = await portalCancelSessionRequest(portalAuthFromLocation(), requestId).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    setMsg(r.message);
    if (r.ok) { setConfirm(false); router.refresh(); }
  });
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 text-[11px]">
      {!confirm ? (
        <button type="button" onClick={() => setConfirm(true)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-2 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><XCircle className="size-3" /> {confirmed ? "Ask to cancel" : "Cancel"}</button>
      ) : (
        <>
          <span className="text-muted">{confirmed ? "Ask us to cancel this session?" : "Cancel this request?"}</span>
          <button type="button" onClick={go} disabled={busy} className="rounded-md bg-danger px-2 py-0.5 font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Yes</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-md border border-border px-2 py-0.5 text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">No</button>
        </>
      )}
      {msg && <span role="status" className="text-muted">{msg}</span>}
    </span>
  );
}
