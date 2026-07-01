"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Circle, CheckCircle2, Loader2 } from "lucide-react";
import { setSmartTaskStatus } from "@/app/actions";
import type { BriefTask } from "@/lib/queries";
import { sourceMeta } from "@/lib/taskSource";
import { editorMeta, isDelegated } from "@/lib/editors";

const PRIORITY_DOT: Record<string, string> = {
  URGENT: "#dc2626", HIGH: "#d97706", MEDIUM: "#0ea5e9", LOW: "#64748b",
};

function dueTime(iso: string | null): string {
  if (!iso) return "";
  return "by " + new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

// A morning-brief task row you can close right there — tick the circle to mark it
// done, or click the text to open it on the Daily Tasks page.
export function BriefTaskRow({ t }: { t: BriefTask }) {
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const src = sourceMeta(t.source);
  const ed = editorMeta(t.assignedKey);
  const delegated = isDelegated(t.assignedKey);
  const street = t.propertyAddress ? t.propertyAddress.split(",")[0].trim() : null;
  const titleHasStreet = !!street && t.title.toLowerCase().includes(street.toLowerCase());

  if (done) return null;

  const complete = () =>
    start(async () => {
      await setSmartTaskStatus(t.id, "COMPLETED");
      setDone(true);
      router.refresh();
    });

  return (
    <div className="group flex items-start gap-1.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
      <button onClick={complete} disabled={pending} title="Mark done" className="mt-0.5 shrink-0 text-muted-2 transition-colors hover:text-success">
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <>
            <Circle className="size-4 group-hover:hidden" />
            <CheckCircle2 className="hidden size-4 text-success group-hover:inline" />
          </>
        )}
      </button>
      <Link href={`/queue?task=${t.id}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: PRIORITY_DOT[t.priority] ?? PRIORITY_DOT.MEDIUM }} />
          <span className="truncate text-sm">{t.title}</span>
          <span className={`ml-auto shrink-0 text-[11px] ${t.overdue ? "font-medium text-danger" : "text-muted"}`}>{t.overdue ? "overdue" : dueTime(t.dueAt)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-2">
          {t.clientName && <span className="font-medium text-muted">{t.clientName}</span>}
          {street && !titleHasStreet && <span>· {street}</span>}
          {src.key !== "system" && <span className="rounded bg-surface-2 px-1 font-medium text-muted-2">{src.label}</span>}
          {delegated && ed && <span className="rounded bg-brand/10 px-1 font-medium text-brand">→ {ed.name}</span>}
        </div>
      </Link>
    </div>
  );
}
