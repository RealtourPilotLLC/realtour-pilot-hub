import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getShoot, photographerMemberId, photographerOwnsShoot } from "@/lib/shoot";
import { getCurrentUser } from "@/lib/auth/user";
import { etDateTime, etDaysAgo } from "@/lib/datetime";
import { ShootScreen } from "@/components/shoot/ShootScreen";
import { ShootPayCard, ShootPayCardSkeleton } from "@/components/shoot/ShootPayCard";
import { ShootMapCard, ShootMapCardSkeleton } from "@/components/shoot/ShootMapCard";
import { ListingMedia, ListingMediaSkeleton } from "@/components/project/ListingMedia";

export const dynamic = "force-dynamic";

export default async function ShootDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ as?: string }>;
}) {
  const { id } = await params;
  const { as } = await searchParams;
  const view = await getShoot(id);
  if (!view) notFound();

  // A photographer can only open their OWN assigned shoots (by project assignment
  // or an appointment assignee). Owner / admin (and the open, pre-cutover app)
  // can open any.
  const user = await getCurrentUser();
  if (user?.role === "PHOTOGRAPHER") {
    const mine = await photographerMemberId(user);
    if (!mine || !(await photographerOwnsShoot(id, mine))) redirect("/shoot");
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

  // Owner/admin viewing as a photographer: "back" returns to that photographer's
  // scoped list. Photographers never carry an ?as= back link (fail-closed).
  const backHref = user?.role !== "PHOTOGRAPHER" && as ? `/shoot?as=${as}` : "/shoot";

  return <ShootScreen view={view} pay={pay} map={map} whenText={whenText} timing={timing} media={media} backHref={backHref} />;
}
