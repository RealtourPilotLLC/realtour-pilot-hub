import { FileText } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { prisma } from "@/lib/prisma";
import { scriptingConfigured } from "@/lib/integrations/scripting";
import { ScriptStudioActions } from "./ScriptStudioActions";
import { ink } from "@/components/ui/Badge";

// Human label + tone for a Studio status.
function statusChip(status: string | null): { label: string; cls: string } | null {
  if (!status) return null;
  const label = status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const done = ["done", "sent_to_client", "approved", "client_approved"].includes(status);
  const attention = status.includes("revision") || status === "held";
  const cls = done ? "bg-success/10 text-success" : attention ? "bg-warning/10 text-warning" : "bg-brand-soft text-brand";
  return { label, cls };
}

// Live link to the external Script Studio for a video job — sits beside the reel
// recipe on the edit page. Server component: renders nothing until Studio is
// configured (SCRIPTING_BASE_URL + SCRIPTING_API_KEY), so it's invisible until
// Jordan connects it. The create/sync buttons are a small client island.
export async function ScriptStudioCard({ projectId }: { projectId: string }) {
  if (!scriptingConfigured()) return null;

  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { scriptingId: true, scriptingStatus: true, scriptingUrl: true, scriptingSyncedAt: true },
  });
  if (!p) return null;

  const linked = Boolean(p.scriptingId);
  const chip = statusChip(p.scriptingStatus);

  return (
    <div className="panel-shadow overflow-hidden rounded-2xl border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg" style={{ background: "#38bdf822", color: ink("#38bdf8") }}>
          <FileText className="size-4" />
        </span>
        <h2 className="text-sm font-semibold">Script Studio</h2>
        {chip && <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${chip.cls}`}>{chip.label}</span>}
        {p.scriptingSyncedAt && (
          <span className="ml-auto text-[11px] text-muted-2">synced {formatDistanceToNow(p.scriptingSyncedAt, { addSuffix: true })}</span>
        )}
      </div>
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-muted">
          {linked
            ? "Linked to Script Studio — the source of truth for this reel's script. It syncs here automatically (webhook); use Sync to pull the latest right now."
            : "Create this job in Script Studio to send the agent an intake link and start the hook + script pipeline. The finished script syncs back here automatically."}
        </p>
        <ScriptStudioActions projectId={projectId} linked={linked} url={p.scriptingUrl} />
      </div>
    </div>
  );
}
