import { redirect } from "next/navigation";
import { PortalSignIn } from "@/components/portal/PortalSignIn";
import { currentClientUser, liveMemberships } from "@/lib/portal";
import { portalLoginEmailEnabled } from "@/lib/portalAccess";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Sign in — RealTour Pilot",
  robots: { index: false, follow: false },
};

// /portal/login — public. A person who is signed in AND holds a live seat goes
// straight to their portal; everyone else gets the form.
//
// Why "and holds a live seat": /portal/me sends a cookie-holder with no live
// seat here (?reason=noaccess or revoked). Forwarding every cookie-holder back
// to /portal/me made the two pages bounce each other forever — the person
// never saw the message and had no way to sign out (review blocker, Sep 17).
// So: with a reason in the URL this page ALWAYS renders, and a signed-in
// person is shown who they are with a Sign out, so the dead cookie can go.
export default async function PortalLoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const person = await currentClientUser();
  const seats = person ? await liveMemberships(person.id) : [];
  if (!reason && seats.length > 0) redirect("/portal/me");
  // The form only appears if it can actually send (see portalLoginEmailEnabled).
  const emailSignIn = await portalLoginEmailEnabled().catch(() => false);
  return <PortalSignIn reason={reason} emailSignIn={emailSignIn} signedIn={person ? { who: person.name || person.email, canEnter: seats.length > 0 } : null} />;
}
