"use client";
import { useState, useTransition } from "react";
import { Link2, Loader2 } from "lucide-react";
import { issuePortalLink } from "@/app/content/actions";

// Owner-only: mint/copy the client's portal link. Nothing is SENT anywhere —
// the owner decides when and how the client receives it.
export function PortalLinkButton({ enrollmentId }: { enrollmentId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      {msg && <span className="max-w-56 truncate text-[11px] text-muted" title={msg}>{msg}</span>}
      <button
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await issuePortalLink(enrollmentId);
            if (r.ok && r.url) {
              await navigator.clipboard?.writeText(r.url).catch(() => {});
              setMsg("Portal link copied — paste it into a text or email when you're ready.");
            } else setMsg(r.message);
          })
        }
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
        Client portal link
      </button>
    </span>
  );
}
