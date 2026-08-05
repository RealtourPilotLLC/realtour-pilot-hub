"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Check, Printer, Download, Trash2, Loader2 } from "lucide-react";
import { deleteHubDocument } from "@/app/assistant/actions";

// What you actually do with a saved document: take it somewhere else, or bin it.

export function DocActions({ id, title, markdown }: { id: string; title: string; markdown: string }) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, start] = useTransition();
  const router = useRouter();

  const copy = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w\s-]/g, "").trim().slice(0, 80) || "document"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const btn = "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:text-foreground";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={copy} className={btn}>
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <button onClick={() => window.print()} className={btn}>
        <Printer className="size-4" /> Print / PDF
      </button>
      <button onClick={download} className={btn}>
        <Download className="size-4" /> Download
      </button>

      {confirming ? (
        <span className="inline-flex items-center gap-2 text-sm">
          <span className="text-muted">Delete this?</span>
          <button
            onClick={() => start(async () => { await deleteHubDocument(id); router.push("/assistant/docs"); })}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg bg-danger px-2.5 py-1 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Delete
          </button>
          <button onClick={() => setConfirming(false)} className="text-sm text-muted-2 hover:text-foreground">
            Keep
          </button>
        </span>
      ) : (
        <button onClick={() => setConfirming(true)} className={`${btn} ml-auto hover:text-danger`}>
          <Trash2 className="size-4" /> Delete
        </button>
      )}
    </div>
  );
}
