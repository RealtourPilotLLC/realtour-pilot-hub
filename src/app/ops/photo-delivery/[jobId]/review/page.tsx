import { notFound, redirect } from "next/navigation";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { ReviewMode } from "@/components/photoDelivery/ReviewMode";
import { loadJobDetail, loadViewer } from "../../data";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/photo-delivery/[jobId]/review: REVIEW MODE (docs/photo-delivery/01
// section 9.5). Full screen, one photo at a time, keyboard first (J/K, F, I,
// X, H, B, O, ?), swipe on a phone. Same data and the same decisions as the
// job page; ?photo=<photoId> starts on that photo.
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export default async function PhotoReviewPage({ params, searchParams }: { params: Promise<{ jobId: string }>; searchParams: Promise<{ photo?: string | string[] }> }) {
  await requirePageAccess("photos");
  const viewer = await loadViewer();
  const { jobId } = await params;
  if (!viewer) redirect(`/login?next=${encodeURIComponent(`/ops/photo-delivery/${jobId}/review`)}`);
  // The office works it; the creative manager looks through it (viewer.readOnly, Oct 22 2026).
  if (!viewer.admitted) redirect(homeFor(viewer.role));
  if (!ID_RE.test(jobId)) notFound();
  const sp = await searchParams;
  const photoRaw = Array.isArray(sp.photo) ? sp.photo[0] : sp.photo;
  const data = await loadJobDetail(jobId, { viewer });
  if (!data) notFound();
  const initialPhoto = photoRaw && data.photos.some((p) => p.id === photoRaw && p.status !== "GONE") ? photoRaw : null;
  // Review mode reads neither the history nor the fix batches: they stay on the server (as on the job page).
  return <ReviewMode data={{ ...data, events: [], batches: [] }} viewer={viewer} initialPhoto={initialPhoto} />;
}
