import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { prisma } from "@/lib/prisma";
import { getShoot, photographerMemberId, photographerOwnsShoot } from "@/lib/shoot";
import { getPhotographerFeedback } from "@/lib/review";
import { getCurrentUser } from "@/lib/auth/user";
import { etDateTime, etDaysAgo } from "@/lib/datetime";
import { ShootScreen } from "@/components/shoot/ShootScreen";
import { ShootPayCard, ShootPayCardSkeleton } from "@/components/shoot/ShootPayCard";
import { ShootMapCard, ShootMapCardSkeleton } from "@/components/shoot/ShootMapCard";
import { ShootFeedback } from "@/components/shoot/ShootFeedback";
import { PropertyGlimpse } from "@/components/shoot/PropertyGlimpse";
import { ReelScriptCard } from "@/components/project/ReelScriptCard";
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
  let viewerMemberId: string | null = null;
  if (user?.role === "PHOTOGRAPHER") {
    viewerMemberId = await photographerMemberId(user);
    if (!viewerMemberId || !(await photographerOwnsShoot(id, viewerMemberId))) redirect("/shoot");
  }
  // Whose pay/route to show: a photographer viewer always sees THEIR OWN numbers
  // (a second shooter on someone else's project must never see the primary's
  // pay); owner/admin (and ?as= previews) see the assigned photographer's.
  const payMemberId = viewerMemberId ?? view.photographer?.id ?? null;

  // Capture feedback (review-room PHOTOGRAPHER lane, scoped to this member) +
  // the property's coordinates for the satellite glimpse. ShootView is the
  // money-free on-site model and doesn't carry lat/lng, so a lean select
  // fetches just the pin. Both are cheap — fetched in parallel, no Suspense.
  const [feedback, geo] = await Promise.all([
    payMemberId ? getPhotographerFeedback(id, payMemberId) : Promise.resolve([]),
    // Also pull the locked reel recipe: the photographer directs the agent on
    // camera from this script, so it belongs on the shoot screen (content only
    // — the external Studio link stays owner/admin-side on the project page).
    prisma.project.findUnique({
      where: { id },
      select: { lat: true, lng: true, reelHook: true, reelScript: true, reelSong: true, reelShotList: true, reelRecipeUpdatedAt: true },
    }),
  ]);
  // Only the photographer the feedback is addressed to can reply / mark fixed;
  // owner-admin previews (including "view as") are read-only here, matching
  // the server-side authz in reviewActions.
  const feedbackReadOnly = !(user?.role === "PHOTOGRAPHER" && !user.impersonating);

  // Pay (this viewer's earnings for this shoot) streams in via Suspense so the
  // screen paints immediately instead of blocking on mileage.
  const pay = payMemberId ? (
    <Suspense fallback={<ShootPayCardSkeleton />}>
      <ShootPayCard projectId={id} memberId={payMemberId} />
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
  // paints first. ShootScreen owns the page layout, so the two new cards ride
  // this top slot: review feedback FIRST (when it exists the shoot is past and
  // the feedback is why they're here — the bell deep-links to this page), then
  // the route, then the satellite glimpse — the "what am I walking into"
  // moment right before the access brief.
  const map = (
    <>
      {feedback.length > 0 && (
        <ShootFeedback notes={feedback} readOnly={feedbackReadOnly} photographerName={view.photographer?.name ?? null} />
      )}
      <ReelScriptCard
        hook={geo?.reelHook ?? null}
        script={geo?.reelScript ?? null}
        song={geo?.reelSong ?? null}
        shotList={geo?.reelShotList ?? null}
        updatedAt={geo?.reelRecipeUpdatedAt ? geo.reelRecipeUpdatedAt.toISOString() : null}
      />
      <Suspense fallback={<ShootMapCardSkeleton />}>
        <ShootMapCard projectId={id} memberId={payMemberId} />
      </Suspense>
      <PropertyGlimpse lat={geo?.lat ?? null} lng={geo?.lng ?? null} address={view.project.addressFull} />
    </>
  );

  // Owner/admin viewing as a photographer: "back" returns to that photographer's
  // scoped list. Photographers never carry an ?as= back link (fail-closed).
  const backHref = user?.role !== "PHOTOGRAPHER" && as ? `/shoot?as=${as}` : "/shoot";

  return <ShootScreen view={view} pay={pay} map={map} whenText={whenText} timing={timing} media={media} backHref={backHref} />;
}
