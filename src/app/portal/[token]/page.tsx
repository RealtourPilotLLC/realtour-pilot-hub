import { notFound } from "next/navigation";
import { resolvePortalViewer } from "@/lib/portal";
import { portalLoginEmailEnabled } from "@/lib/portalAccess";
import { PortalPage, type PortalQuery } from "@/components/portal/PortalPage";
import { PortalSignIn } from "@/components/portal/PortalSignIn";

export const dynamic = "force-dynamic";

// The root layout titles every page "RealTour Pilot — Operations Hub"; on a
// client's own portal that browser tab was advertising our internal software.
// Own the title here. noindex/nofollow because the token link is the only gate:
// if a client ever pastes it somewhere a crawler can reach, it must not become
// a search result. (Page metadata wins over the root layout's.)
export const metadata = {
  title: "Your Content Program — RealTour Pilot",
  robots: { index: false, follow: false },
};

// /portal/<token> — the link. The resolver decides who is looking (the link
// itself, or staff through the owner iframe) and what they may see; the page
// component does the rest. Every refusal that a REAL client could hit —
// expired, replaced, revoked, never-existed — renders the sign-in screen with
// HTTP 200 and no data: never a 404 (a dead link is not "no such page"), and
// never the wrong client. Only a malformed token is a 404. A paused or ended
// program is not a refusal: the resolver hands back a READ_ONLY viewer and the
// page renders the released library.
export default async function ClientPortalPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<PortalQuery>;
}) {
  const { token } = await params;
  const query = await searchParams;
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(token)) notFound();
  const r = await resolvePortalViewer({ token });
  if (!r.ok) {
    // `invalid_token` is "no enrollment carries this token" — a link that was
    // ROTATED away looks exactly like one that never existed, and we cannot
    // tell them apart (nor should we say which, to a stranger holding a typo).
    // So it gets its own neutral copy: claiming a stranger's link "has been
    // replaced with a newer one" invents a history for an account that may not
    // exist (review blocker, Sep 17).
    const reason = r.reason === "expired_token" ? "expired" : r.reason === "revoked" ? "revoked" : "unknown";
    return <PortalSignIn reason={reason} emailSignIn={await portalLoginEmailEnabled().catch(() => false)} />;
  }
  // The page reads the tab from the address itself (lib/portalNav): old and new
  // ?tab= keys both land, in whichever layout this visit gets (UI-01).
  return <PortalPage viewer={r.viewer} path="/portal/[token]" query={query} />;
}
