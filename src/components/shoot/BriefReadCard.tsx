"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ClipboardCheck, Loader2 } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { acknowledgeShootBrief } from "@/app/shoot/actions";

type Change = { label: string; before: string | null; after: string | null };

export function BriefReadCard({ projectId, digest, readAtISO, changes, canAcknowledge, unavailable }: {
  projectId: string;
  digest: string;
  readAtISO: string | null;
  changes: Change[];
  canAcknowledge: boolean;
  unavailable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [marked, setMarked] = useState(false);
  if (!digest) return null;
  const needsRead = !readAtISO || changes.length > 0;
  const readDate = readAtISO ? new Date(readAtISO).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : null;
  return (
    <Section icon={ClipboardCheck} title="Pre-shoot brief" bodyClassName="space-y-3">
      {unavailable ? (
        <p className="text-sm text-warning">Read receipts are unavailable until this update is released. Review the brief below before filming.</p>
      ) : !readAtISO ? (
        <p className="text-sm">Review the latest scripts, shot direction, client preferences and chosen assets below, then mark this version read.</p>
      ) : changes.length ? (
        <>
          <p className="text-sm font-medium text-warning">{changes.length} brief item{changes.length === 1 ? " has" : "s have"} changed since you read it {readDate}.</p>
          <div className="space-y-2">
            {changes.map((change, i) => (
              <details key={`${change.label}:${i}`} className="rounded-lg border border-warning/30 bg-warning/5 p-2 text-xs">
                <summary className="cursor-pointer font-medium">{change.label} {change.before === null ? "· added" : change.after === null ? "· removed" : "· changed"}</summary>
                <div className="mt-2 space-y-2">
                  {change.before !== null && <p className="whitespace-pre-wrap text-muted"><span className="font-semibold">Previously read: </span>{change.before}</p>}
                  {change.after !== null && <p className="whitespace-pre-wrap"><span className="font-semibold">Now: </span>{change.after}</p>}
                </div>
              </details>
            ))}
          </div>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4 shrink-0" /> Brief read {readDate}; no changes since then.</p>
      )}
      {marked && <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4 shrink-0" /> This version is marked read.</p>}
      {message && <p role="status" className={`text-sm ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>}
      {canAcknowledge && needsRead && !unavailable && !marked && (
        <button type="button" disabled={pending} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => start(async () => {
          try {
            const result = await acknowledgeShootBrief(projectId, digest);
            setMessage({ ok: result.ok, text: result.message });
            if (result.ok) { setMarked(true); router.refresh(); }
          } catch { setMessage({ ok: false, text: "Could not save the read receipt. Try again." }); }
        })}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {readAtISO ? "I read the changes" : "I read this brief"}
        </button>
      )}
      {!canAcknowledge && needsRead && !unavailable && <p className="text-xs text-muted">Only the assigned photographer can mark this brief read.</p>}
    </Section>
  );
}
