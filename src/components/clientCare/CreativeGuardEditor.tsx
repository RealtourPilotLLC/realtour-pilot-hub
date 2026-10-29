"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, ShieldCheck } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { saveCreativeGuard } from "@/app/clients/clientCareActions";
import type { CreativeGuard } from "@/lib/creativeGuardCore";

// ---------------------------------------------------------------------------
// CREATIVE GUARDRAILS on the client file (Oct 15 2026). What works for this
// client, the series they stopped, and how many experiments a month. The
// topic bank and the script writer obey it; the editor brief and the Review
// Room show it. Mountable anywhere a program client is shown: it needs the
// enrollment id and the guard (creativeGuard.creativeGuardForEnrollment).
// ---------------------------------------------------------------------------

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");

export function CreativeGuardEditor({ enrollmentId, guard, canEdit }: { enrollmentId: string; guard: CreativeGuard; canEdit: boolean }) {
  const router = useRouter();
  const [formats, setFormats] = useState(guard.provenFormats.join("\n"));
  const [cap, setCap] = useState(guard.experimentCap == null ? "" : String(guard.experimentCap));
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = (patch: Parameters<typeof saveCreativeGuard>[0], after?: () => void) =>
    start(async () => {
      setMsg(null);
      const r = await saveCreativeGuard(patch).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) { after?.(); router.refresh(); }
    });
  const capValue = cap.trim() === "" ? null : Number(cap);

  return (
    <Section icon={ShieldCheck} title="Creative guardrails" count={guard.discontinued.length ? `${guard.discontinued.length} stopped` : null}>
      <p className="mb-3 text-xs text-muted">What works for this client and what they stopped. Topic ideas and scripts follow it, and editors and reviewers see it on every video.</p>
      <div className="space-y-4 text-sm">
        <label className="block">
          <span className="text-xs font-medium text-muted">Proven format, one per line</span>
          <textarea value={formats} onChange={(e) => setFormats(e.target.value)} rows={2} disabled={!canEdit || pending} placeholder="Fully scripted, direct to camera" className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5" />
        </label>
        <label className="block max-w-xs">
          <span className="text-xs font-medium text-muted">Experimental concepts a month, at most (blank = no rule)</span>
          <input type="number" min={0} max={20} value={cap} onChange={(e) => setCap(e.target.value)} disabled={!canEdit || pending} className="mt-1 w-24 rounded-md border border-border bg-surface px-2 py-1.5" />
        </label>
        {canEdit && (
          <button
            type="button"
            disabled={pending || (capValue != null && !(Number.isInteger(capValue) && capValue >= 0 && capValue <= 20))}
            onClick={() => run({ enrollmentId, provenFormats: formats.split("\n").map((l) => l.trim()).filter(Boolean), experimentCap: capValue })}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 font-medium text-white disabled:opacity-50"
          >
            {pending && <Loader2 className="size-4 animate-spin" />} Save format
          </button>
        )}
        <div>
          <p className="text-xs font-medium text-muted">Stopped series and concepts</p>
          {guard.discontinued.length === 0 ? (
            <p className="mt-1 text-xs text-muted-2">None.</p>
          ) : (
            <ul className="mt-1 space-y-1.5" data-discontinued-list>
              {guard.discontinued.map((d) => (
                <li key={d.name} className="flex flex-wrap items-start gap-2 rounded-lg border border-border px-2.5 py-1.5">
                  <Ban className="mt-0.5 size-3.5 text-danger" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{d.name}</span>
                    {d.reason && <span className="text-muted"> · {d.reason}</span>}
                    <span className="block text-[11px] text-muted-2">Stopped {day(d.at)}{d.by ? ` by ${d.by}` : ""}</span>
                  </span>
                  {canEdit && (
                    <button type="button" disabled={pending} onClick={() => run({ enrollmentId, removeDiscontinued: d.name })} className="min-h-9 rounded-md border border-border px-2 text-xs">
                      Bring back
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="text-[11px] text-muted">Series or concept</span>
                <input value={name} onChange={(e) => setName(e.target.value)} disabled={pending} placeholder="Fairy God Realtor" className="mt-0.5 block w-52 rounded-md border border-border bg-surface px-2 py-1.5" />
              </label>
              <label className="block min-w-0 flex-1 basis-40">
                <span className="text-[11px] text-muted">Why (optional)</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} placeholder="Client asked to stop it" className="mt-0.5 block w-full rounded-md border border-border bg-surface px-2 py-1.5" />
              </label>
              <button
                type="button"
                disabled={pending || name.trim().length < 3}
                onClick={() => run({ enrollmentId, addDiscontinued: { name, reason } }, () => { setName(""); setReason(""); })}
                className="min-h-11 rounded-lg border border-danger/40 px-3 text-sm font-medium text-danger disabled:opacity-50"
              >
                Stop this series
              </button>
            </div>
          )}
        </div>
        {guard.updatedAt && <p className="text-[11px] text-muted-2">Last changed {day(guard.updatedAt)}{guard.updatedBy ? ` by ${guard.updatedBy}` : ""}</p>}
        {msg && <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
      </div>
    </Section>
  );
}
