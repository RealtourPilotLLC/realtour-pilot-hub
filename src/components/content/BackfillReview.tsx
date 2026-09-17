"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, FileSearch, Undo2 } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { markReviewItemAction, unmarkReviewItemAction } from "@/app/content/resources/actions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// BACKFILL REVIEW (spec §14) — every client's mis-filed-looking record in one
// list: Mike Flatley's February call sitting on Gary Mercer Sr, a month with
// far more topics marked selected than it owes, an import item that hit a
// conflict.
//
// The actions here record a JUDGEMENT and change no data. Deliberately: the
// safe-looking "fix it" button is the one that would move a real call onto the
// wrong client's file. Correcting a record is done on that client's own Import
// tab, by hand, with the record in front of you — and this list remembers that
// somebody decided, who, and what they concluded.
// ---------------------------------------------------------------------------

export type ReviewItemUi = {
  key: string; kind: string; clientName: string; enrollmentId: string; monthKey: string | null;
  title: string; detail: string; handled: { by: string; at: string; note: string; action: string } | null;
};

const quiet = "rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50";
const input = "rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[12px]";
const day = (isoStr: string) => new Date(isoStr).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

const KIND_WORDS: Record<string, string> = {
  MISFILED_TRANSCRIPT: "a transcript that may be on the wrong client",
  OVER_SELECTED_MONTH: "far more topics selected than the month owes",
  IMPORT_CONFLICT: "an import item that hit a conflict",
  DUPLICATE_CLIENT: "two enrolled clients with the same name",
};

export function BackfillReview({ items }: { items: ReviewItemUi[] }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const say = (r: { ok: boolean; message: string }) => setNote(`${r.ok ? "" : "Couldn't do that — "}${r.message}`);
  const open = items.filter((i) => !i.handled);

  return (
    <Section
      icon={FileSearch}
      title="Records that look mis-filed"
      count={open.length}
      tone={open.length ? "warning" : "default"}
      flush
      action={<span className="hidden text-[11px] text-muted-2 sm:inline">nothing here is fixed automatically</span>}
    >
      {note && <p className="border-b border-border bg-surface-2/60 px-5 py-2 text-[13px]">{note}</p>}
      <div className="divide-y divide-border">
        {items.length === 0 && (
          <p className="px-5 py-3 text-sm text-success"><CheckCircle2 className="mr-1 inline size-4" />Nothing across the book looks mis-filed.</p>
        )}
        {items.map((i) => <Row key={i.key} i={i} busy={busy} start={start} say={say} />)}
      </div>
    </Section>
  );
}

function Row({
  i, busy, start, say,
}: { i: ReviewItemUi; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void }) {
  const [why, setWhy] = useState("");
  const href = `/content/${i.enrollmentId}?tab=import${i.monthKey ? `&month=${i.monthKey}` : ""}`;
  return (
    <div className={cn("px-5 py-2.5 text-[13px]", i.handled && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{i.clientName}</span>
        <span className="min-w-0 flex-1">{i.title}</span>
        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-2">{KIND_WORDS[i.kind] ?? i.kind.toLowerCase()}</span>
        <Link href={href} className="text-[12px] font-medium text-brand hover:underline">Open the record →</Link>
      </div>
      <p className="text-muted">{i.detail}</p>
      {i.handled ? (
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-2">
          <CheckCircle2 className="size-3" />
          {i.handled.action === "CORRECT" ? "filed correctly" : i.handled.action === "FIXED" ? "corrected by hand" : "left as it is"} · {i.handled.by} · {day(i.handled.at)} · &ldquo;{i.handled.note}&rdquo;
          <button className={quiet} disabled={busy} onClick={() => start(async () => say(await unmarkReviewItemAction(i.key)))}><Undo2 className="mr-0.5 inline size-3" />reopen</button>
        </p>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <input className={`${input} flex-1`} placeholder="What did you conclude? (required)" value={why} onChange={(e) => setWhy(e.target.value)} disabled={busy} />
          <button className={quiet} disabled={busy || !why.trim()} onClick={() => start(async () => say(await markReviewItemAction(i.key, "CORRECT", why)))}>It is filed correctly</button>
          <button className={quiet} disabled={busy || !why.trim()} onClick={() => start(async () => say(await markReviewItemAction(i.key, "FIXED", why)))}>I corrected it</button>
          <button className={quiet} disabled={busy || !why.trim()} onClick={() => start(async () => say(await markReviewItemAction(i.key, "LEAVE", why)))}>Leave it, on purpose</button>
        </div>
      )}
      {!i.handled && (
        <p className="mt-0.5 text-[11px] text-muted-2">
          <AlertTriangle className="mr-1 inline size-3" />These buttons record what you decided. They do not move the record — do that on the client&rsquo;s Import tab.
        </p>
      )}
    </div>
  );
}
