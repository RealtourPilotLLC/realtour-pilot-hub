import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getShoot } from "@/lib/shoot";
import { getCurrentUser } from "@/lib/auth/user";
import { etDateTime, etDaysAgo } from "@/lib/datetime";
import { ShootScreen } from "@/components/shoot/ShootScreen";
import { ShootPayCard, ShootPayCardSkeleton } from "@/components/shoot/ShootPayCard";
import { ShootMapCard, ShootMapCardSkeleton } from "@/components/shoot/ShootMapCard";
import { ListingMedia, ListingMediaSkeleton } from "@/components/project/ListingMedia";

export const dynamic = "force-dynamic";

export default async function ShootDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getShoot(id);
  if (!view) notFound();

  // When login is enforced, a photographer only sees their own shoots. Owner /
  // admin (and the open, pre-cutover app) can open any.
  const user = await getCurrentUser();
  if (
    user?.role === "PHOTOGRAPHER" &&
    user.teamMemberId &&
    view.photographer &&
    view.photographer.id !== user.teamMemberId
  ) {
    redirect("/shoot");
  }

  // Pay (the assigned photographer's earnings for this shoot) streams in via
  // Suspense so the screen paints immediately instead of blocking on mileage.
  const pay = view.photographer ? (
    <Suspense fallback={<ShootPayCardSkeleton />}>
      <ShootPayCard projectId={id} memberId={view.photographer.id} />
    </Suspense>
  ) : null;

  const startISO = view.appointment?.startISO ?? view.project.shootDateISO;
  const whenText = startISO ? etDateTime(startISO) : "";
  let timing: "today" | "upcoming" | "past" | null = null;
  if (startISO) {
    const d = etDaysAgo(new Date(startISO)); // + past, - future, 0 today
    timing = d === 0 ? "today" : d < 0 ? "upcoming" : "past";
  }

  const media = view.project.aryeoListingId ? (
    <Suspense fallback={<ListingMediaSkeleton />}>
      <ListingMedia listingId={view.project.aryeoListingId} title={view.project.title} projectId={view.project.id} />
    </Suspense>
  ) : null;

  // Day's shoots + driving route — streams in (one OSRM call) so the screen
  // paints first.
  const map = (
    <Suspense fallback={<ShootMapCardSkeleton />}>
      <ShootMapCard projectId={id} memberId={view.photographer?.id ?? null} />
    </Suspense>
  );

  return <ShootScreen view={view} pay={pay} map={map} whenText={whenText} timing={timing} media={media} />;
}
