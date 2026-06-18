import { ShieldCheck, CircleAlert, CheckCircle2, Camera, Video, Ruler, Box } from "lucide-react";
import { parseEvidence } from "@/lib/statusEvidence";
import { stageMeta } from "@/lib/pipeline";
import { formatDistanceToNow } from "date-fns";
import type { ProjectStatus } from "@prisma/client";

// Renders the smart-status engine's reasoning: what was ordered, what's
// confirmed live on Aryeo / sitting in Dropbox, and what's still missing.
export function StatusEvidenceCard({
  status,
  evidence,
  checkedAt,
}: {
  status: ProjectStatus;
  evidence: string | null;
  checkedAt: Date | null;
}) {
  const e = parseEvidence(evidence);
  if (!e) return null;

  const stage = stageMeta(status);
  const hasMissing = e.missing.length > 0;

  return (
    <section
      className={
        "rounded-2xl border bg-surface " + (hasMissing ? "border-danger/40" : "border-border")
      }
    >
      <div className="flex items-center justify-between gap-2 border-b px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {hasMissing ? (
            <CircleAlert className="size-4 text-danger" />
          ) : (
            <ShieldCheck className="size-4 text-success" />
          )}
          Status check
        </h2>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-semibold"
          style={{ backgroundColor: stage.soft, color: stage.color }}
        >
          {stage.label}
        </span>
      </div>

      <div className="space-y-3 px-5 py-4">
        <p className={"text-sm " + (hasMissing ? "font-medium text-danger" : "text-foreground/85")}>
          {e.reason}
        </p>

        {e.partial && (
          <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger">
            ⚠ Aryeo marked this order fulfilled, but the cross-check found missing deliverables.
            Don&apos;t treat it as done until the rest is uploaded.
          </div>
        )}

        {/* Expected deliverables, color-coded by present / missing */}
        {e.expected.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
              Ordered deliverables
            </div>
            <div className="flex flex-wrap gap-1.5">
              {e.expected.map((cat) => {
                const present = e.present.includes(cat);
                return (
                  <span
                    key={cat}
                    className={
                      "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium " +
                      (present ? "bg-success/10 text-success" : "bg-danger/10 text-danger")
                    }
                  >
                    {present ? <CheckCircle2 className="size-3" /> : <CircleAlert className="size-3" />}
                    {cat}
                    {!present && " — missing"}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Evidence counts from each source */}
        <div className="grid gap-3 sm:grid-cols-2">
          {e.aryeo && (
            <div className="rounded-lg border bg-surface-2/50 px-3 py-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                Live on Aryeo {e.aryeo.delivery ? `· ${e.aryeo.delivery.toLowerCase()}` : ""}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/80">
                <Count icon={Camera} n={e.aryeo.photos} label="photos" />
                <Count icon={Video} n={e.aryeo.videos} label="videos" />
                <Count icon={Ruler} n={e.aryeo.floorPlans} label="floor plans" />
                <Count icon={Box} n={e.aryeo.interactive} label="3D" />
              </div>
            </div>
          )}
          {e.dropbox && (
            <div className="rounded-lg border bg-surface-2/50 px-3 py-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                In Dropbox
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/80">
                <Count icon={Camera} n={e.dropbox.rawPhotos} label="raw photos" />
                <Count icon={Video} n={e.dropbox.rawVideo} label="raw video" />
                <Count icon={Camera} n={e.dropbox.finalPhotos} label="final photos" />
                <Count icon={Video} n={e.dropbox.finalVideo} label="final video" />
              </div>
            </div>
          )}
        </div>

        {checkedAt && (
          <div className="text-[11px] text-muted-2">
            Cross-checked {formatDistanceToNow(checkedAt, { addSuffix: true })} · Aryeo media + Dropbox folders
          </div>
        )}
      </div>
    </section>
  );
}

function Count({ icon: Icon, n, label }: { icon: typeof Camera; n: number; label: string }) {
  return (
    <span className={"inline-flex items-center gap-1 " + (n > 0 ? "" : "text-muted-2")}>
      <Icon className="size-3" />
      <span className="font-medium">{n}</span> {label}
    </span>
  );
}
