"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MessageSquareWarning } from "lucide-react";
import { recordClientNoticeAction } from "@/app/ops/actions";
import { NOTICE_OPTIONS } from "@/components/ops/MarkSent";
import { etDateTime } from "@/lib/datetime";
import type { NotTold as NotToldRow } from "@/lib/readyToSend";

// ---------------------------------------------------------------------------
// "SENT, BUT THE CLIENT HASN'T BEEN TOLD" (9.2, Sep 25 2026).
//
// A video marked sent with "Not told yet" leaves the ready list — it has gone
// out — and lands here instead, so the one thing still owed (telling the
// client it is there) is not lost. A row clears when somebody records how the
// client was told, or when the hub's own delivery text for that job is accepted
// by the provider (readyToSend.stampNoticesFromDeliveryTexts).
//
// Records only. Nothing here messages a client; the text or call is made the
// usual way and this is where it is written down. The choices are MarkSent's,
// minus "Not told yet", which is what put the row here.
// ---------------------------------------------------------------------------

export function NotTold({ rows }: { rows: NotToldRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
        <MessageSquareWarning className="size-3.5" />
        {rows.length === 1 ? "One video went out and the client hasn't been told yet" : `${rows.length} videos went out and the clients haven't been told yet`}
      </p>
      <ul className="mt-1 space-y-2">
        {rows.map((r) => <Row key={r.submissionId} r={r} />)}
      </ul>
    </div>
  );
}

function Row({ r }: { r: NotToldRow }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const record = (value: string) =>
    start(async () => {
      const res = await recordClientNoticeAction(r.submissionId, value).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      setMsg(res.ok ? null : res.message);
      if (res.ok) router.refresh();
    });
  return (
    <li className="text-[11px] text-muted">
      <span className="font-medium text-foreground/85">{r.street}</span> · {r.fileName} · sent {etDateTime(new Date(r.sentAtISO))} ET
      {r.sentBy ? ` by ${r.sentBy}` : ""}
      <span className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="text-muted-2">Told them by:</span>
        {NOTICE_OPTIONS.filter((o) => o.value !== "not-yet").map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={busy}
            onClick={() => record(o.value)}
            className="inline-flex min-h-9 items-center rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
          >
            {o.label}
          </button>
        ))}
        {busy && <Loader2 className="size-3.5 animate-spin" />}
      </span>
      {msg && <span className="block text-warning">{msg}</span>}
    </li>
  );
}
