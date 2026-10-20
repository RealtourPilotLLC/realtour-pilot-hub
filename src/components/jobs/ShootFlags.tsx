import { Flag } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { etDateTime } from "@/lib/datetime";
import { scrubMoney } from "@/lib/text";

// ---------------------------------------------------------------------------
// FLAGGED AT THE SHOOT, ON THE SHOOT ITSELF (Jordan, Oct 19 2026: "we don't
// need this at the top of the screen. Only flagged issues should show up on
// the shoot itself. It should clear once the job is delivered."). Every flag a
// creative raised on this job (the field screens' "Flag a problem", the
// debrief's "had issues", a missed shot), about the work or about the shoot,
// while the job is still in progress. Once the job is delivered the box is
// gone; the flags stay in the job's timeline below, and their loops close by
// themselves (shootIssues.closeShootFlagsOnDeliveredJobs).
// ---------------------------------------------------------------------------

const DONE = new Set(["DELIVERED", "CANCELLED"]);

export async function ShootFlags({ projectId }: { projectId: string }) {
  const [project, rows] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { status: true } }),
    prisma.activity.findMany({
      where: { projectId, type: "FLAG" },
      orderBy: { createdAt: "asc" },
      take: 30,
      select: { id: true, body: true, createdAt: true, author: { select: { name: true } } },
    }),
  ]).catch(() => [null, []] as const);
  if (!project || DONE.has(project.status) || !rows.length) return null;

  const [{ isFieldFlag }, { sortShootFlag }, { viewerSeesMoney }] = await Promise.all([
    import("@/lib/debrief"),
    import("@/lib/shootIssues"),
    import("@/lib/clientAsks"),
  ]);
  const seesMoney = await viewerSeesMoney().catch(() => false);
  const flags = rows
    .filter((r) => isFieldFlag(r.body))
    .map((r) => {
      const text = r.body.replace(/^Shoot debrief\s*[—-]\s*had issues\s*:\s*/i, "After the shoot: ").replace(/\s+[—–]\s+/g, ", ").trim();
      const sorted = sortShootFlag(r.body);
      return {
        id: r.id,
        text: seesMoney ? text : scrubMoney(text),
        by: r.author?.name ?? null,
        at: etDateTime(r.createdAt),
        aboutShoot: sorted.route === "owner",
      };
    });
  if (!flags.length) return null;

  return (
    <section aria-labelledby={`flags-${projectId}`} className="rounded-2xl border border-danger/30 bg-danger-soft/40 p-4">
      <h2 id={`flags-${projectId}`} className="flex items-center gap-2 text-sm font-semibold">
        <Flag aria-hidden className="size-4 text-danger" /> Flagged at the shoot
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted tabular-nums">{flags.length}</span>
      </h2>
      <ul className="mt-2 space-y-2">
        {flags.map((f) => (
          <li key={f.id} className="text-sm">
            <p className="whitespace-pre-wrap text-foreground/90">{f.text}</p>
            <p className="mt-0.5 text-xs text-muted">
              {[f.by, f.at, f.aboutShoot ? "about the shoot" : "about the work"].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">These clear once the job is delivered.</p>
    </section>
  );
}
