import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getShoot, shootEarnings } from "@/lib/shoot";
import { getCurrentUser } from "@/lib/auth/user";
import { etDateTime, etDaysAgo } from "@/lib/datetime";
import { ShootScreen } from "@/components/shoot/ShootScreen";
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

  // Pay is the assigned photographer's (the person paid for this shoot).
  const earnings = await shootEarnings(id, view.photographer?.id ?? null);

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

  return <ShootScreen view={view} earnings={earnings} whenText={whenText} timing={timing} media={media} />;
}
