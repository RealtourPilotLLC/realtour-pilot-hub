"use client";

import { useEffect, useState, useTransition } from "react";
import { Plane, ShieldAlert, ShieldCheck, Loader2, Send, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { projectAirspace, sendDroneAdvisory, type AirspaceResult } from "@/app/projects/droneActions";

// Drone-operations panel on a project: auto-checks FAA airspace for the address
// and, when controlled/restricted, drafts an advisory text for the assigned
// creative (human clicks Send — nothing auto-sends).
export function DroneAdvisory({ projectId }: { projectId: string }) {
  const [data, setData] = useState<AirspaceResult | null>(null);
  const [loading, start] = useTransition();
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, startSend] = useTransition();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    start(async () => {
      const r = await projectAirspace(projectId);
      setData(r);
      if (r.draft) setBody(r.draft);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const air = data?.airspace;
  const warn = !!air?.warning;

  return (
    <section className="rounded-2xl border bg-surface">
      <div className="flex items-center gap-2 border-b px-5 py-3.5">
        <Plane className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Drone operations</h2>
      </div>
      <div className="px-5 py-4">
        {loading && !data ? (
          <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Checking FAA airspace…</div>
        ) : !air ? (
          <p className="text-sm text-muted">No location on file to check airspace.</p>
        ) : (
          <>
            <div
              className={cn(
                "flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm",
                warn ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
              )}
            >
              {warn ? <ShieldAlert className="mt-0.5 size-4 shrink-0" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0" />}
              <span className="text-foreground/90">{air.summary}</span>
            </div>

            {warn && (
              <div className="mt-3">
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Advisory to {data?.photographer?.firstName ?? "the creative"}
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {data?.photographer?.hasPhone ? (
                    <button
                      disabled={sending || !body.trim()}
                      onClick={() =>
                        startSend(async () => {
                          const r = await sendDroneAdvisory(projectId, body);
                          setMsg({ ok: r.ok, text: r.message });
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      <Send className="size-4" /> {sending ? "Sending…" : `Send to ${data.photographer.firstName}`}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-2">{data?.photographer ? "No phone on file for the creative." : "No creative assigned yet."}</span>
                  )}
                  <button
                    onClick={() => { navigator.clipboard.writeText(body); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
                  >
                    {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy"}
                  </button>
                  {msg && <span className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</span>}
                </div>
                <p className="mt-1.5 text-[11px] text-muted-2">Review before sending — nothing auto-sends.</p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
