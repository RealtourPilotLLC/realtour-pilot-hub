import { BookOpen } from "lucide-react";
import type { ResourceGroupView } from "@/lib/portalResources";
import { Card, Empty, LoadFailed, fmtShort } from "@/components/portal/ui";
import { Markdown } from "@/components/ui/Markdown";

// RESOURCES (spec §11): published guides in four groups, mobile-readable
// (one column, collapsible), each with its owner, last-reviewed date and the
// platform/device it was written for. Unpublished rows never reach this
// component; an empty group says so instead of showing a placeholder.
export function ResourcesTab({ groups, failed, open }: { groups: ResourceGroupView[] | null; failed: boolean; open: string | undefined }) {
  if (failed) return <div className="mt-6"><LoadFailed what="the guides" /></div>;
  if (!groups) return null;
  const total = groups.reduce((n, g) => n + g.resources.length, 0);
  return (
    <div className="mt-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Resources</h1>
        <p className="mt-0.5 text-xs text-muted">Short guides for each step — written and kept current by the team.</p>
      </div>
      {total === 0 ? (
        <Empty icon={BookOpen}>No guides are published yet. Text us with any question in the meantime — the answer usually becomes the first guide.</Empty>
      ) : (
        groups.map((g) => (
          <Card key={g.key}>
            <h2 className="text-base font-semibold">{g.title}</h2>
            <p className="text-xs text-muted">{g.blurb}</p>
            {g.resources.length === 0 ? (
              <p className="mt-2 text-xs text-muted-2">Nothing here yet.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {g.resources.map((r) => (
                  <details key={r.id} id={r.slug} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3" open={open === r.slug}>
                    <summary className="cursor-pointer text-sm font-bold">
                      {r.title}
                      {(r.platform || r.deviceContext) && <span className="ml-2 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{[r.platform, r.deviceContext].filter((x) => x && x !== "general" && x !== "any").join(" · ") || "all platforms"}</span>}
                    </summary>
                    {r.summary && <p className="mt-1 text-xs text-muted">{r.summary}</p>}
                    <Markdown content={r.body} className="mt-2 text-sm" />
                    <p className="mt-2 text-[11px] text-muted-2">{r.ownerName ? `Kept current by ${r.ownerName}` : "Kept current by the team"}{r.reviewedAtISO ? ` · last reviewed ${fmtShort(r.reviewedAtISO)}` : " · not yet reviewed"}</p>
                  </details>
                ))}
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
