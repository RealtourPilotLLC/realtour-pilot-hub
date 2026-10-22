import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ClipboardCheck, Images } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { photoQcCards, type QueuePhotoQc } from "@/lib/reviewRoom";
import { prisma } from "@/lib/prisma";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor, isCreativeLead } from "@/lib/auth/access";
import { GlobalStrip } from "@/components/photoDelivery/GlobalStrip";
import { QueueFilters } from "@/components/photoDelivery/QueueFilters";
import { QueueBoard, QueueTable } from "@/components/photoDelivery/QueueBoard";
import { plural, queueHref } from "@/components/photoDelivery/format";
import { loadQueue, loadStrip, loadViewer } from "./data";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/photo-delivery: THE QUEUE (docs/photo-delivery/01 sections 9.1 to 9.3).
// Jordan and Kyle; James (creative manager) reads it view only since Oct 22
// 2026 (no credits, no controls). Every photo job from the shoot to delivered, sorted by
// when it is due. Jobs open by themselves (lib/photoDelivery/jobs.ts): one
// per photo shoot since the feature started, followed until the edited
// gallery lands on the Aryeo listing, then QC, decisions, fixes, delivery.
// MEDIA CHECKS (Oct 19 2026): Kyle's media_qa cards moved here from the
// Review Room, which became the VIDEO Review Room (Jordan), so photo work
// lives on the photo screen. Same cards, same links (lib/reviewRoom
// photoQcCards).
// ---------------------------------------------------------------------------

function MediaChecks({ cards, jobByProject }: { cards: QueuePhotoQc[]; jobByProject: Map<string, string> }) {
  if (!cards.length) return null;
  // Oct 20 2026 (audit C11): a card whose shoot has a photo job opens that
  // job, where the gallery is checked, instead of the project page.
  const hrefOf = (t: QueuePhotoQc) => {
    const job = t.projectId ? jobByProject.get(t.projectId) : undefined;
    return job ? `/ops/photo-delivery/${job}` : t.projectId ? `/projects/${t.projectId}` : "/tasks";
  };
  return (
    <Section icon={ClipboardCheck} title="Media checks to finish" count={cards.length}>
      <ul className="divide-y divide-border">
        {cards.map((t) => (
          <li key={t.taskId}>
            <Link href={hrefOf(t)} className="flex min-h-11 items-center justify-between gap-3 py-2.5 hover:text-brand">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{t.street}</span>
                {t.clientName && (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
                    <Avatar name={t.clientName} src={t.clientAvatarUrl} size={18} />
                    <span className="truncate">{t.clientName}</span>
                  </span>
                )}
              </div>
              <span className="shrink-0 text-xs text-muted">{t.dueAt ? `due ${formatDistanceToNow(new Date(t.dueAt), { addSuffix: true })}` : "no due date"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

type SP = { client?: string | string[]; photographer?: string | string[]; risk?: string | string[]; view?: string | string[] };
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PhotoDeliveryQueuePage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePageAccess("photos");
  const viewer = await loadViewer();
  if (!viewer) redirect("/login?next=/ops/photo-delivery");
  // The owner and the office work the desk; the creative manager reads it,
  // view only (Oct 22 2026: viewer.readOnly). Nobody else.
  if (!isCreativeLead(viewer.role)) redirect(homeFor(viewer.role));

  const sp = await searchParams;
  const client = one(sp.client);
  const photographer = one(sp.photographer);
  const filters = {
    client: client && ID_RE.test(client) ? client : null,
    photographer: photographer && ID_RE.test(photographer) ? photographer : null,
    atRisk: one(sp.risk) === "1",
  };
  const view = one(sp.view) === "table" ? "table" : "board";

  const [strip, queue, mediaChecks] = await Promise.all([
    loadStrip(viewer),
    loadQueue({ filters, viewer }).catch((e) => {
      console.error("[photo-delivery] queue failed", e);
      return null;
    }),
    photoQcCards({ includeTest: false }).catch((e) => {
      console.error("[photo-delivery] media checks failed", e);
      return [] as QueuePhotoQc[];
    }),
  ]);

  const checkProjects = [...new Set(mediaChecks.map((t) => t.projectId).filter((x): x is string => !!x))];
  const jobByProject = new Map(
    checkProjects.length
      ? (await prisma.photoJob.findMany({ where: { projectId: { in: checkProjects } }, select: { id: true, projectId: true } }).catch(() => [])).map((j) => [j.projectId, j.id] as const)
      : [],
  );

  const decision = queue?.columns.find((c) => c.key === "decision")?.cards.length ?? 0;
  const ready = queue?.columns.find((c) => c.key === "ready")?.cards.length ?? 0;
  const atRisk = queue ? queue.columns.reduce((n, c) => n + c.cards.filter((x) => x.atRisk).length, 0) : 0;
  const subtitle = queue
    ? `${plural(queue.total, "job")} on the board · ${decision} need${decision === 1 ? "s" : ""} a decision · ${ready} ready to review${atRisk ? ` · ${atRisk} at risk` : ""}. Sorted by when each is due; times are Eastern.`
    : "Every photo job from the shoot to delivered.";

  return (
    <div>
      <PageHeader eyebrow="Operations" title="Photo Delivery" subtitle={subtitle} />
      <div className="mx-auto max-w-[120rem] space-y-4 p-4 pb-16 sm:p-6">
        <GlobalStrip strip={strip} current="queue" />
        <MediaChecks cards={mediaChecks} jobByProject={jobByProject} />
        {!queue ? (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">The queue could not be read. Refresh to try again.</p>
        ) : queue.total === 0 ? (
          <div className="panel-shadow rounded-2xl border border-border bg-surface p-8 text-center">
            <Images aria-hidden className="mx-auto size-8 text-brand" />
            <p className="mt-2 font-semibold">No photo jobs yet</p>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted">
              Jobs appear here by themselves. The hub opens one for each photo shoot and picks up the gallery once the shoot&rsquo;s edited photos land on the Aryeo
              listing. Nothing needs to be added by hand.
            </p>
          </div>
        ) : (
          <>
            <QueueFilters data={queue} view={view} />
            {queue.shown === 0 ? (
              <div className="rounded-2xl border border-border bg-surface p-6 text-center text-sm">
                <p className="font-medium">No jobs match these filters.</p>
                <p className="mt-1 text-muted">{plural(queue.total, "job")} on the board in all.</p>
                <Link href={queueHref({ client: null, photographer: null, risk: false, view })} className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-border-strong px-4 font-medium hover:bg-surface-2">
                  Clear filters
                </Link>
              </div>
            ) : view === "table" ? (
              <QueueTable data={queue} />
            ) : (
              <QueueBoard data={queue} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
