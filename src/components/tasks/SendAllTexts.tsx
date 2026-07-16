"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, Loader2, MessageSquareText, Send, X } from "lucide-react";
import { listDraftedTexts, sendDraftText, type DraftedText } from "@/app/tasks/sendAllActions";
import { etDateTime } from "@/lib/datetime";

// One sitting for the day's client texts. The panel loads every drafted
// confirmation/delivery text freshly rendered, lets Jordan/Kyle EDIT any
// message and UNTICK any they don't want, then sends the ticked ones one by
// one. Nothing goes out without this explicit review — the hub never texts a
// client on its own.

type RowState = DraftedText & {
  checked: boolean;
  text: string;
  state: "idle" | "sending" | "sent" | "error";
  error?: string;
};

const TYPE_LABEL: Record<DraftedText["taskType"], string> = {
  confirmation_text: "Confirmation",
  delivery_text: "Delivery",
};

export function SendAllTexts({ count }: { count: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setLoadErr(null);
    void listDraftedTexts()
      .then((r) => {
        if (!r.ok || !r.rows) { setLoadErr(r.message ?? "Couldn't load the drafts."); return; }
        setRows(r.rows.map((d) => ({ ...d, checked: !d.blocked && !d.warnStale, text: d.body, state: "idle" })));
      })
      .catch(() => setLoadErr("Couldn't load the drafts — try again."));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, sending]);

  const ticked = rows?.filter((r) => r.checked && r.state !== "sent") ?? [];
  const sentCount = rows?.filter((r) => r.state === "sent").length ?? 0;

  async function sendAll() {
    if (!rows || ticked.length === 0 || sending) return;
    setSending(true);
    for (const row of rows) {
      if (!row.checked || row.state === "sent" || row.blocked) continue;
      setRows((rs) => rs!.map((r) => (r.taskId === row.taskId ? { ...r, state: "sending" } : r)));
      try {
        const res = await sendDraftText(row.taskId, row.text);
        setRows((rs) =>
          rs!.map((r) =>
            r.taskId === row.taskId
              ? res.ok
                ? { ...r, state: "sent" }
                : { ...r, state: "error", error: res.message }
              : r,
          ),
        );
      } catch {
        setRows((rs) => rs!.map((r) => (r.taskId === row.taskId ? { ...r, state: "error", error: "Send failed — try again." } : r)));
      }
    }
    setSending(false);
    router.refresh();
  }

  if (count <= 0) return null;

  const modal = open
    ? createPortal(
        <div className="fixed inset-0 z-[1500] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Review and send drafted texts">
          <button aria-label="Close" onClick={() => !sending && setOpen(false)} className="absolute inset-0 bg-black/60" />
          <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl sm:rounded-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
              <div>
                <h2 className="text-sm font-semibold">Drafted texts — review, edit, send</h2>
                <p className="mt-0.5 text-[11px] text-muted-2">
                  Untick anything that shouldn&rsquo;t go out. Edits here are what actually gets sent.
                </p>
              </div>
              <button
                onClick={() => !sending && setOpen(false)}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
                disabled={sending}
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5">
              {loadErr && <p className="text-sm text-danger">{loadErr}</p>}
              {!rows && !loadErr && (
                <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Rendering today&rsquo;s drafts…</p>
              )}
              {rows?.length === 0 && <p className="text-sm text-muted">Nothing waiting to send — all caught up.</p>}
              {rows?.map((r, i) => (
                <div key={r.taskId} className={`rounded-xl border p-3 ${r.state === "sent" ? "border-success/40 bg-success/5" : r.state === "error" ? "border-danger/40" : "border-border bg-surface-2/30"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.checked}
                      disabled={!!r.blocked || r.state === "sent" || sending}
                      onChange={(e) => setRows((rs) => rs!.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))}
                      className="size-4 accent-[var(--brand)]"
                      aria-label={`Include the ${TYPE_LABEL[r.taskType].toLowerCase()} text for ${r.clientName}`}
                    />
                    <span className="text-sm font-medium">{r.clientName}</span>
                    <span className="text-xs text-muted">· {r.street}</span>
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{TYPE_LABEL[r.taskType]}</span>
                    {r.overdue && r.state !== "sent" && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-danger"><Clock className="size-3" /> overdue</span>
                    )}
                    <span className="ml-auto text-[11px]">
                      {r.state === "sending" && <Loader2 className="size-3.5 animate-spin text-muted" />}
                      {r.state === "sent" && <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="size-3.5" /> Sent</span>}
                      {r.state === "error" && <span className="inline-flex items-center gap-1 font-medium text-danger"><AlertTriangle className="size-3.5" /> {r.error}</span>}
                      {r.blocked && r.state === "idle" && <span className="inline-flex items-center gap-1 text-warning"><AlertTriangle className="size-3.5" /> {r.blocked}</span>}
                    </span>
                  </div>
                  {r.warnStale && r.state !== "sent" && (
                    <p className="mt-1.5 text-[11px] font-medium text-warning">
                      This confirmation may be out of date — the shoot time may have already passed. Tick it only if you really want it sent.
                    </p>
                  )}
                  <textarea
                    value={r.text}
                    onChange={(e) => setRows((rs) => rs!.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                    disabled={r.state === "sent" || sending}
                    rows={3}
                    className="mt-2 w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand disabled:opacity-70"
                  />
                  {r.dueAt && r.state !== "sent" && (
                    <p className="mt-1 text-[10px] text-muted-2">Due {etDateTime(new Date(r.dueAt))}</p>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 sm:px-5">
              <button
                onClick={sendAll}
                disabled={sending || ticked.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {sending ? "Sending…" : `Send ${ticked.length} text${ticked.length === 1 ? "" : "s"} now`}
              </button>
              {sentCount > 0 && <span className="text-xs font-medium text-success">{sentCount} sent</span>}
              <p className="ml-auto text-[10px] text-muted-2">Sent one by one via OpenPhone · each closes its to-do</p>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/20"
        title="Review every drafted confirmation/delivery text, edit or untick, then send all"
      >
        <MessageSquareText className="size-3.5" /> Review &amp; send texts ({count})
      </button>
      {modal}
    </>
  );
}
