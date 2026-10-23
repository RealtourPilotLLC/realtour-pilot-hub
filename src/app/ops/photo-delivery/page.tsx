import Link from "next/link";
import { redirect } from "next/navigation";
import { Images } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
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
// Oct 23 2026 (Jordan and Kyle's huddle): the "Media checks to finish" block
// that sat on top (the shoots' media_qa cards, here since Oct 19) is gone.
// Kyle never used it ("I just scroll down to this and I work on these"), and
// each card closes by itself when its photo job is approved or delivered
// (lib/photoDelivery/mediaCheck.ts). The credits strip, the queue and
// Settings stay.
// ---------------------------------------------------------------------------

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

  const [strip, queue] = await Promise.all([
    loadStrip(viewer),
    // Oct 22 2026: each card says what holds it (the job page's first line) and the add-ons to confirm.
    loadQueue({ filters, viewer, holding: true }).catch((e) => {
      console.error("[photo-delivery] queue failed", e);
      return null;
    }),
  ]);
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
