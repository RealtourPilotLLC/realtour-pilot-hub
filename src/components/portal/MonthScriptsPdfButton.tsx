"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { portalMonthScriptsPdfLink } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";

// A month's approved scripts as one PDF (Oct 20 2026). The link is minted on
// the tap, like the one-script PDF, so a page left open overnight never
// offers an expired link (audit E10).
export function MonthScriptsPdfButton({ monthKey, label }: { monthKey: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    const r = await portalMonthScriptsPdfLink(portalAuthFromLocation(), monthKey).catch(() => ({ ok: false, message: "That didn't work. Try again.", url: undefined }));
    setBusy(false);
    if (r.ok && r.url) window.location.assign(r.url);
    else setErr(r.message);
  };
  return (
    <span className="inline-flex flex-col">
      <button type="button" onClick={go} disabled={busy} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />} {label}
      </button>
      {err && <span role="status" className="mt-1 text-xs text-danger">{err}</span>}
    </span>
  );
}
