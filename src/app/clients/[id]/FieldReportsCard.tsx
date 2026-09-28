"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NotebookPen } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { decideFieldReport } from "@/app/upload/actions";

// ---------------------------------------------------------------------------
// FIELD REPORTS ON THE CLIENT PAGE (§7.8, Sep 28 2026).
//
// What a photographer reported from this client's shoots: something the client
// asked for, or something they noticed. Each one is a PROPOSAL until the office
// confirms it; only then does it reach the editor brief and the working
// profile. A program client reviews these in the content workspace; a
// listing-only client had nowhere but the upload page of the job it came from,
// so this is that list, for them. Confirm and Reject are the upload page's own
// action (decideFieldReport, owner/admin only — the server checks again).
// ---------------------------------------------------------------------------

export type FieldReportRow = {
  id: string;
  body: string;
  status: string;
  scope: string;
  basis: "client_said" | "observation" | null;
  speaker: string | null;
  createdAtISO: string;
  projectId: string | null;
  projectTitle: string | null;
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export function FieldReportsCard({ reports, canDecide }: { reports: FieldReportRow[]; canDecide: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const waiting = reports.filter((r) => r.status === "PROPOSED").length;
  const decide = (id: string, d: "ACCEPT" | "REJECT") =>
    start(async () => {
      const r = await decideFieldReport(id, d).catch(() => ({ ok: false, message: "Couldn't save that. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  if (reports.length === 0) return null;
  return (
    <Section icon={NotebookPen} title="Field reports" count={waiting > 0 ? `${waiting} to confirm` : null} tone={waiting > 0 ? "warning" : "default"}>
      <p className="mb-2 text-xs text-muted">
        What photographers reported from this client&apos;s shoots. Nothing here reaches the editor or the working profile until the office confirms it.
      </p>
      <ul className="space-y-1.5">
        {reports.map((r) => (
          <li key={r.id} className="rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-[13px]" data-field-report={r.status}>
            <p className="text-foreground/90">{r.body}</p>
            <p className="mt-0.5 text-xs text-muted">
              {r.basis === "client_said" ? "they asked for it" : r.basis === "observation" ? "noticed on site" : "from the field"}
              {" · "}
              {r.scope === "PROJECT" ? "this job only" : "going forward"}
              {r.projectId && r.projectTitle && (
                <>
                  {" · "}
                  <Link href={`/projects/${r.projectId}`} className="text-brand hover:underline">{r.projectTitle}</Link>
                </>
              )}
              {r.speaker ? ` · ${r.speaker}` : ""}
              {` · ${day(r.createdAtISO)} · `}
              <span className={cn("font-semibold", r.status === "ACCEPTED" ? "text-success" : r.status === "REJECTED" ? "text-muted" : "text-warning")}>
                {r.status === "ACCEPTED" ? "confirmed" : r.status === "REJECTED" ? "not used" : "waiting for the office"}
              </span>
            </p>
            {canDecide && r.status === "PROPOSED" && (
              <span className="mt-1 inline-flex gap-3 text-xs">
                <button type="button" disabled={pending} onClick={() => decide(r.id, "ACCEPT")} className="font-medium text-brand underline disabled:opacity-50">
                  Confirm
                </button>
                <button type="button" disabled={pending} onClick={() => decide(r.id, "REJECT")} className="font-medium text-muted underline disabled:opacity-50">
                  Reject
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {msg && <p className={cn("mt-2 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </Section>
  );
}
