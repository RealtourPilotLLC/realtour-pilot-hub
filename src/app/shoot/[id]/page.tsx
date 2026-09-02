import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getShoot, photographerMemberId, photographerOwnsShoot } from "@/lib/shoot";
import { getClientFeedback, getPhotographerFeedback } from "@/lib/review";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canSeeMoney, homeFor } from "@/lib/auth/access";
import { etDateTime, etDaysAgo } from "@/lib/datetime";
import { ShootScreen } from "@/components/shoot/ShootScreen";
import { ShootPayCard, ShootPayCardSkeleton } from "@/components/shoot/ShootPayCard";
import { ShootMapCard, ShootMapCardSkeleton } from "@/components/shoot/ShootMapCard";
import { ShootFeedback } from "@/components/shoot/ShootFeedback";
import { ClientPraiseCard } from "@/components/shoot/ClientPraiseCard";
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

  // The middleware deliberately leaves /shoot/<id> ungated (Kyle taps these
  // links straight off Schedule), so this page is the ONLY gate on it — and the
  // screen carries the assigned photographer's pay for the job plus the client's
  // name, phone, email and address. Guard first, read after.
  const user = await getCurrentUser();
  // Fail CLOSED on a null user under enforcement (same shape as /shoot and
  // /shoot/feedback): a disabled account's stale JWT still passes the
  // middleware, and null falls through the role checks below as "owner-ish" —
  // i.e. any shoot, with someone else's pay on it.
  if (!user && authEnforced()) redirect(`/login?next=/shoot/${id}`);
  // A photographer can only open their OWN assigned shoots (by project assignment
  // or an appointment assignee). Owner / admin (and the open, pre-cutover app)
  // can open any.
  let viewerMemberId: string | null = null;
  if (user?.role === "PHOTOGRAPHER") {
    viewerMemberId = await photographerMemberId(user);
    if (!viewerMemberId || !(await photographerOwnsShoot(id, viewerMemberId))) redirect("/shoot");
  } else if (user && user.role !== "OWNER" && user.role !== "ADMIN") {
    // Everyone else — an EDITOR above all — is bounced home (audit Sep 2: an
    // editor could open any /shoot/<id> and read the photographer's pay for
    // that job). The video lane's own screen is /edit/<id>; nothing links an
    // editor here, and the mentions router already sends them to /edit.
    redirect(homeFor(user.role));
  }

  const view = await getShoot(id);
  if (!view) notFound();
  // Whose pay/route to show: a photographer viewer always sees THEIR OWN numbers
  // (a second shooter on someone else's project must never see the primary's
  // pay); owner/admin (and ?as= previews) see the assigned photographer's.
  const payMemberId = viewerMemberId ?? view.photographer?.id ?? null;

  // Capture feedback (review-room PHOTOGRAPHER lane, scoped to this member).
  // The reel script renders inside ShootScreen (ShootView carries the fields),
  // and the old satellite glimpse is gone — the property look now lives on the
  // My Shoots list as Street View → first Aryeo photo.
  // Only the photographer the feedback is addressed to can reply / mark fixed;
  // owner-admin previews (including "view as") are read-only here, matching
  // the server-side authz in reviewActions.
  const feedbackReadOnly = !(user?.role === "PHOTOGRAPHER" && !user.impersonating);
  // Read receipt: the real photographer opening their own shoot marks the
  // feedback SEEN (before the load below, so the receipts they see are fresh).
  // Previews never stamp — Jordan looking isn't Harrison reading.
  if (!feedbackReadOnly && payMemberId) {
    const { markFeedbackSeen } = await import("@/lib/review");
    await markFeedbackSeen(payMemberId, id);
  }
  // Capture feedback + client praise for the same pay-scoped member. Praise is
  // creative-safe by construction (getClientFeedback: POSITIVE/NEUTRAL only,
  // money-scrubbed) — negative client feedback never reaches this page.
  const [feedback, praise] = payMemberId
    ? await Promise.all([getPhotographerFeedback(id, payMemberId), getClientFeedback(id, payMemberId)])
    : [[], []];

  // THE MONEY RULE, on the one screen that carries a person's earnings: a pay
  // card is your OWN pay, or it isn't shown. Jordan, Sep 2 2026 — "Kyle should
  // not have access to any money related info" (canSeeMoney, src/lib/auth/access.ts)
  // — and Kyle taps /shoot/<id> straight off Schedule, where this card was
  // handing him the assigned photographer's earnings for the job. An admin who
  // also shoots (James) keeps the card on HIS OWN shoots; the owner keeps it
  // everywhere, ?as= photographer previews included. The route/map card below is
  // unaffected — miles are ops, not money.
  const ownPay = payMemberId != null && payMemberId === (viewerMemberId ?? user?.teamMemberId ?? null);
  const showPay = payMemberId != null && (ownPay || (user ? canSeeMoney(user.role) : !authEnforced()));

  // Pay (this viewer's earnings for this shoot) streams in via Suspense so the
  // screen paints immediately instead of blocking on mileage.
  const pay = showPay ? (
    <Suspense fallback={<ShootPayCardSkeleton />}>
      <ShootPayCard projectId={id} memberId={payMemberId!} />
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
  // paints first. ShootScreen owns the page layout; this top slot carries
  // client praise, then review feedback (when either exists the shoot is past
  // and the feedback is why they're here — the bell deep-links to this page),
  // then the route. Praise leads: the win lands before the punch list.
  const map = (
    <>
      {praise.length > 0 && <ClientPraiseCard items={praise} />}
      {feedback.length > 0 && (
        <ShootFeedback notes={feedback} readOnly={feedbackReadOnly} photographerName={view.photographer?.name ?? null} projectId={id} />
      )}
      <Suspense fallback={<ShootMapCardSkeleton />}>
        <ShootMapCard projectId={id} memberId={payMemberId} />
      </Suspense>
    </>
  );

  // Owner/admin viewing as a photographer: "back" returns to that photographer's
  // scoped list. Photographers never carry an ?as= back link (fail-closed).
  const backHref = user?.role !== "PHOTOGRAPHER" && as ? `/shoot?as=${as}` : "/shoot";

  return <ShootScreen view={view} pay={pay} map={map} whenText={whenText} timing={timing} media={media} backHref={backHref} />;
}
