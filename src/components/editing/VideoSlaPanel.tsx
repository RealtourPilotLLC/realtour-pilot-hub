import Link from "next/link";
import { AlertTriangle, Clapperboard } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { getVideoSlaStatus } from "@/lib/projectStatus";
import { editorForDeliverable, editorMeta } from "@/lib/editors";
import { SlaCountdown } from "./SlaCountdown";
import { ReassignEditor } from "./ReassignEditor";

// Owner/admin SLA visibility: the in-flight video jobs ranked by their VIDEO
// delivery-due with a LIVE countdown, past-due jobs surfaced red at the top,
// plus one-click reassign per row. This is the accountability layer the passive
// tracker never had — 4-of-8 videos were overdue and nothing highlighted them.
// Sits ABOVE the existing tracker (which is preserved untouched for owner/admin).
type Row = {
  id: string;
  status: string;
  shootDate: Date | null;
  editorId: string | null;
  editor: { name: string } | null;
  client: { name: string; socialClient: boolean } | null;
  title: string;
  deliverables: { type: string; label: string | null }[];
};

export function VideoSlaPanel({ projects }: { projects: Row[] }) {
  const rows = projects
    .map((p) => {
      const sla = getVideoSlaStatus({ shootDate: p.shootDate, status: p.status, deliverables: p.deliverables, client: p.client });
      if (!sla) return null;
      const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
      const routeKey = editorForDeliverable(v?.type, v?.label, !!p.client?.socialClient);
      const editorLabel = p.editor?.name ?? editorMeta(routeKey)?.name ?? routeKey;
      return {
        id: p.id,
        street: (p.title || "").split(",")[0].trim() || p.title || "Job",
        client: p.client?.name ?? "",
        status: p.status,
        premium: sla.tier === "premium",
        dueISO: sla.due.toISOString(),
        overdue: sla.overdue,
        ms: sla.msRemaining,
        editorLabel,
        routeKey,
      };
    })
    .filter(Boolean) as {
      id: string; street: string; client: string; status: string; premium: boolean;
      dueISO: string; overdue: boolean; ms: number; editorLabel: string; routeKey: string;
    }[];

  // Overdue first, then soonest-due.
  rows.sort((a, b) => (a.overdue === b.overdue ? a.ms - b.ms : a.overdue ? -1 : 1));
  const overdueCount = rows.filter((r) => r.overdue).length;
  if (rows.length === 0) return null;

  return (
    <Section
      icon={overdueCount ? AlertTriangle : Clapperboard}
      title="Video SLA"
      tone={overdueCount ? "warning" : "default"}
      count={overdueCount ? `${overdueCount} overdue` : null}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-muted-2">
              <th className="pb-2 pr-3">Job</th>
              <th className="pb-2 pr-3">Tier</th>
              <th className="pb-2 pr-3">Stage</th>
              <th className="pb-2 pr-3">SLA</th>
              <th className="pb-2 pr-3">Editor</th>
              <th className="pb-2">Reassign</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className={r.overdue ? "bg-danger/5" : undefined}>
                <td className="py-2 pr-3">
                  <Link href={`/edit/${r.id}`} className="font-medium text-foreground hover:underline">
                    {r.street}
                  </Link>
                  {r.client && <div className="text-xs text-muted">{r.client}</div>}
                </td>
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: r.premium ? "#a78bfa1a" : "#64748b1a", color: r.premium ? "#a78bfa" : "#64748b" }}>
                    {r.premium ? "Premium" : "Standard"}
                  </span>
                </td>
                <td className="py-2 pr-3 text-xs text-muted">{r.status}</td>
                <td className="py-2 pr-3"><SlaCountdown dueISO={r.dueISO} /></td>
                <td className="py-2 pr-3 text-xs text-foreground/80">{r.editorLabel}</td>
                <td className="py-2"><ReassignEditor projectId={r.id} current={r.routeKey} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
