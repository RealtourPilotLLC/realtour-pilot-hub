import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, Camera, ExternalLink, PauseCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { etDateTime } from "@/lib/datetime";
import { GlobalStrip } from "@/components/photoDelivery/GlobalStrip";
import { SlaChip } from "@/components/photoDelivery/SlaChip";
import { StageStepper } from "@/components/photoDelivery/StageStepper";
import { JobHeaderActions } from "@/components/photoDelivery/JobHeaderActions";
import { JobWorkspace } from "@/components/photoDelivery/JobWorkspace";
import { HistoryPanel } from "@/components/photoDelivery/JobPanels";
import { HOLD_REASON_LABEL, VERDICT_LABEL, usd } from "@/components/photoDelivery/format";
import type { TabKey } from "@/components/photoDelivery/JobContext";
import { CoachingCard } from "@/components/photoDelivery/CoachingCard";
import { loadJobDetail, loadStrip, loadViewer } from "../data";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/photo-delivery/[jobId]: ONE JOB (docs/photo-delivery/01 section 9.4).
// Header (address, client, Aryeo links, photographer, shoot time, SLA, stage,
// credits spent, QC verdict, and the run's cost for the owner only), then the
// gallery and the tabs, the lightbox, and the Deliver panel at the bottom.
// Deep links: ?tab=cart|coverage|history (activity and files, the two tabs
// History replaced, still work), ?photo=<photoId>. Shadow mode shows in one
// place only: the Deliver bar's Advisory badge.
// ---------------------------------------------------------------------------

const TABS = new Map<string, TabKey>([["issues", "issues"], ["cart", "cart"], ["coverage", "coverage"], ["history", "activity"], ["activity", "activity"], ["files", "activity"]]);
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export default async function PhotoJobPage({ params, searchParams }: { params: Promise<{ jobId: string }>; searchParams: Promise<{ tab?: string | string[]; photo?: string | string[] }> }) {
  await requirePageAccess("ops");
  const viewer = await loadViewer();
  const { jobId } = await params;
  if (!viewer) redirect(`/login?next=${encodeURIComponent(`/ops/photo-delivery/${jobId}`)}`);
  if (viewer.role !== "OWNER" && viewer.role !== "ADMIN") redirect(homeFor(viewer.role));
  if (!ID_RE.test(jobId)) notFound();

  const sp = await searchParams;
  const tabRaw = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const photoRaw = Array.isArray(sp.photo) ? sp.photo[0] : sp.photo;
  const [strip, data, coaching] = await Promise.all([
    loadStrip(viewer),
    loadJobDetail(jobId, { viewer }),
    // The coaching note is the owner's to approve (plan 12 item 3).
    viewer.role === "OWNER" ? import("@/lib/photoDelivery/coaching").then((m) => m.coachingFor(jobId)).catch(() => null) : Promise.resolve(null),
  ]);
  if (!data) notFound();
  const h = data.header;
  const initialTab = TABS.get(tabRaw ?? "") ?? "issues";
  const initialPhoto = photoRaw && data.photos.some((p) => p.id === photoRaw) ? photoRaw : null;

  return (
    <div>
      <div className="border-b border-border px-4 py-2 sm:px-6">
        <BackLink href="/ops/photo-delivery" label="Photo Delivery" />
      </div>
      <PageHeader
        eyebrow="Photo Delivery"
        title={h.street}
        subtitle={[h.clientName ?? "No client", h.cityLine].filter(Boolean).join(" · ")}
        sticky="desktop"
        actions={<JobHeaderActions jobId={h.id} stage={h.stage} qcEnabled={data.qcEnabled} autohdr={!!h.autohdrPhotoshootId || data.photos.some((p) => p.sourceKind === "AUTOHDR")} />}
      />
      <div className="mx-auto max-w-[120rem] space-y-4 p-4 pb-0 sm:p-6 sm:pb-0">
        <GlobalStrip strip={strip} current="job" />

        <section aria-label="Job summary" className="panel-shadow space-y-3 rounded-2xl border border-border bg-surface p-4">
          <StageStepper stage={h.stage} holdResumeStage={h.holdResumeStage} />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <Fact label="Due">
              {h.stage === "DELIVERED" ? `Delivered ${h.deliveredAt ? etDateTime(h.deliveredAt) : ""}` : <SlaChip dueAt={h.slaDueAt} serverNow={data.nowIso} />}
            </Fact>
            <Fact label="Shoot">
              {h.shootDate ? etDateTime(h.shootDate) : "Not recorded"}
              {h.photographerName && (
                <span className="block text-muted">
                  <Camera aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
                  {h.photographerName}
                </span>
              )}
            </Fact>
            <Fact label="Aryeo">
              <span className="flex flex-wrap gap-x-3">
                {h.listingUrl ? <ExtLink href={h.listingUrl}>Listing</ExtLink> : <span className="text-muted">No listing yet</span>}
                {h.orderUrl && <ExtLink href={h.orderUrl}>Order</ExtLink>}
                <Link href={`/projects/${h.projectId}`} className="text-brand hover:underline">Hub project</Link>
              </span>
              {h.paymentStatus && <span className="block text-[13px] text-muted">Payment: {h.paymentStatus.toLowerCase().replace(/_/g, " ")}</span>}
            </Fact>
            <Fact label="QC">
              {h.qcVerdict ? VERDICT_LABEL[h.qcVerdict] ?? h.qcVerdict : data.runs.length ? "No verdict yet" : "Not run yet"}
              <span className="block text-[13px] text-muted">
                {h.creditsSpent.toLocaleString("en-US")} AutoHDR credit{h.creditsSpent === 1 ? "" : "s"} spent on this job
                {viewer.canSeeMoney && h.lastRunCostUsd != null ? ` · last QC run ${usd(h.lastRunCostUsd)}` : ""}
                {h.qcRequestedAt ? ` · new check requested ${etDateTime(h.qcRequestedAt)}` : ""}
              </span>
            </Fact>
          </dl>
          {h.stage === "ON_HOLD" && (
            <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft/40 p-3 text-sm">
              <PauseCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                <strong className="font-semibold">On hold{h.holdReason ? `: ${HOLD_REASON_LABEL[h.holdReason] ?? h.holdReason}` : ""}.</strong> {h.holdNote ?? ""}
              </span>
            </p>
          )}
          {h.lastError && (
            <p className="flex items-start gap-2 text-[13px] text-warning">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> {h.lastError}
            </p>
          )}
        </section>

        {coaching && <CoachingCard jobId={h.id} coaching={{ photographerName: coaching.photographerName, note: coaching.note, preShootReminders: coaching.preShootReminders, status: coaching.status }} />}

        {/* The events and batches render here on the server; the browser never needs them. */}
        <JobWorkspace
          data={{ ...data, events: [], batches: [] }}
          viewer={viewer}
          initialTab={initialTab}
          initialPhoto={initialPhoto}
          history={<HistoryPanel events={data.events} header={h} photos={data.photos} runs={data.runs} batches={data.batches} canSeeMoney={viewer.canSeeMoney} />}
        />
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
      {children} <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}
