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
import { PrepModeControl } from "@/components/photoDelivery/PrepModeControl";
import { BeforeYouSendView, loadBeforeYouSend } from "@/components/jobs/BeforeYouSend";
import { loadJobDetail, loadStrip, loadViewer } from "../data";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/photo-delivery/[jobId]: ONE JOB (docs/photo-delivery/01 section 9.4).
// Oct 22 2026: "What's holding this" first (HoldingPanel: every blocker in
// order, who it waits on, its button; or "Ready to send"), then the summary.
// Header (address, client, Aryeo links, photographer, shoot time, SLA, stage,
// add-on work to confirm such as "Lot Lines needed",
// credits spent, QC verdict, and the run's cost for the owner only), then the
// gallery and the tabs, the lightbox, and the Deliver panel at the bottom.
// Deep links: ?tab=cart|coverage|history (activity and files, the two tabs
// History replaced, still work), ?photo=<photoId>. Shadow mode shows in one
// place only: the Deliver bar's Advisory badge.
// ---------------------------------------------------------------------------

const TABS = new Map<string, TabKey>([["issues", "issues"], ["cart", "cart"], ["coverage", "coverage"], ["history", "activity"], ["activity", "activity"], ["files", "activity"]]);
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export default async function PhotoJobPage({ params, searchParams }: { params: Promise<{ jobId: string }>; searchParams: Promise<{ tab?: string | string[]; photo?: string | string[] }> }) {
  await requirePageAccess("photos");
  const viewer = await loadViewer();
  const { jobId } = await params;
  if (!viewer) redirect(`/login?next=${encodeURIComponent(`/ops/photo-delivery/${jobId}`)}`);
  // The office works the job; the creative manager reads it (viewer.readOnly, Oct 22 2026).
  if (!viewer.admitted) redirect(homeFor(viewer.role));
  if (!ID_RE.test(jobId)) notFound();
  const readOnly = !!viewer.readOnly;

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
  const box = await loadBeforeYouSend(h.projectId, "photo");
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
        actions={<JobHeaderActions jobId={h.id} stage={h.stage} autohdr={!!h.autohdrPhotoshootId || data.photos.some((p) => p.sourceKind === "AUTOHDR")} readOnly={readOnly} />}
      />
      <div className="mx-auto max-w-[120rem] space-y-4 p-4 pb-0 sm:p-6 sm:pb-0">
        <GlobalStrip strip={strip} current="job" />

        {/* WHAT'S HOLDING THIS (Oct 22 2026) comes first, inside the workspace
            (it settles things with the job's own controls); the summary, Before
            you send and the coaching note follow it, then the gallery. The
            events and batches render here on the server; the browser never needs them. */}
        <JobWorkspace
          data={{ ...data, events: [], batches: [] }}
          viewer={viewer}
          initialTab={initialTab}
          initialPhoto={initialPhoto}
          history={<HistoryPanel events={data.events} header={h} photos={data.photos} runs={data.runs} batches={data.batches} canSeeMoney={viewer.canSeeMoney} showCredits={!readOnly} />}
          lead={<>
        <section aria-label="Job summary" className="panel-shadow space-y-3 rounded-2xl border border-border bg-surface p-4">
          <StageStepper stage={h.stage} holdResumeStage={h.holdResumeStage} waitingForUpload={!!h.waitingForUpload} />
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
                {/* Credit amounts are the office's (Oct 22 2026: a view-only viewer gets null). */}
                {[
                  h.creditsSpent != null ? `${h.creditsSpent.toLocaleString("en-US")} AutoHDR credit${h.creditsSpent === 1 ? "" : "s"} spent on this job` : null,
                  viewer.canSeeMoney && h.lastRunCostUsd != null ? `last QC run ${usd(h.lastRunCostUsd)}` : null,
                  h.qcRequestedAt ? `new check requested ${etDateTime(h.qcRequestedAt)}` : null,
                ].filter(Boolean).join(" · ")}
              </span>
            </Fact>
            <Fact label="Home">
              <PrepModeControl jobId={h.id} prep={data.prep} canSet={viewer.isOwner} />
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
          {/* Oct 23 2026 (huddle item 7): the add-on chips that stood here moved to Special requests, at the top of the job. */}
        </section>

        {/* BEFORE YOU SEND (Oct 19 2026, lib/jobChecks): what was flagged at the
            shoot about the photos, the client's open requests with one Checked,
            and the order and edit notes. A same-day job waits for the open
            requests before the hub approves it by itself; Kyle's own Approve
            is never blocked. Replaces the open-asks card that stood here. */}
        {/* Oct 28 2026 (Kyle on 40 N Perry St: "Virtual staging is also showing twice"): on this
            page the client's requests, the order's own note and the add-ons ordered are the ONE
            Client requests item under What's holding this (each request once, settled there), so
            this box keeps only what was flagged at the shoot and the job's other notes. */}
        <BeforeYouSendView
          data={{ ...box.data, requests: [], openRequests: 0, checked: null, notes: box.data.notes.filter((n) => n.label !== "On the order" && n.label !== "Add-on ordered") }}
          medium="photo"
          canCheck={box.canCheck}
        />

        {coaching && <CoachingCard jobId={h.id} coaching={{ photographerName: coaching.photographerName, note: coaching.note, preShootReminders: coaching.preShootReminders, status: coaching.status }} />}
          </>}
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
