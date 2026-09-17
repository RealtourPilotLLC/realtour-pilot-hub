import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandWordmark } from "@/components/Brand";
import { ChevronRight, LogOut } from "lucide-react";
import { resolvePortalViewer, currentClientUser, liveMemberships } from "@/lib/portal";
import { PortalPage, portalTabOf } from "@/components/portal/PortalPage";
import { signOutPortal } from "@/app/portal/login/actions";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Your Content Program — RealTour Pilot",
  robots: { index: false, follow: false },
};

// /portal/me — the signed-in person's portal. The cookie names the person; the
// resolver re-reads their seats on every request (a revoked seat is refused
// here, not on cookie expiry). One seat → straight in. Several → pick, and
// `?e=<enrollmentId>` carries the choice through every tab link.
export default async function PortalMePage({ searchParams }: { searchParams: Promise<{ tab?: string; e?: string }> }) {
  const { tab: rawTab, e } = await searchParams;
  const person = await currentClientUser();
  if (!person) redirect("/portal/login");
  const seats = await liveMemberships(person.id);
  if (seats.length === 0) redirect("/portal/login?reason=noaccess");
  if (seats.length > 1 && !e) return <Picker name={person.name ?? person.email} seats={seats} />;

  const r = await resolvePortalViewer({ enrollmentId: e ?? null });
  if (!r.ok) redirect(`/portal/login?reason=${r.reason === "revoked" ? "revoked" : "noaccess"}`);
  return <PortalPage viewer={r.viewer} tab={portalTabOf(rawTab)} path="/portal/me" baseQuery={e ? `e=${encodeURIComponent(e)}` : ""} />;
}

function Picker({ name, seats }: { name: string; seats: { enrollmentId: string; clientName: string; status: string; role: string }[] }) {
  return (
    <div className="portal-light fixed inset-0 flex items-center justify-center overflow-y-auto bg-background p-6 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><BrandWordmark variant="onLight" className="h-5" /></div>
        <h1 className="text-center text-xl font-semibold tracking-tight">Hi {name.split(/\s+/)[0]} — which program?</h1>
        <div className="mt-4 space-y-2">
          {seats.map((s) => (
            <Link key={s.enrollmentId} href={`/portal/me?e=${encodeURIComponent(s.enrollmentId)}`}
              className="flex items-center gap-3 rounded-2xl border border-border bg-surface/80 p-4 text-sm font-medium hover:bg-surface">
              <span className="min-w-0 flex-1 truncate">{s.clientName}</span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-2">{s.status === "ACTIVE" ? s.role.toLowerCase() : s.status.toLowerCase()}</span>
              <ChevronRight className="size-4 text-brand" />
            </Link>
          ))}
        </div>
        <form action={signOutPortal} className="mt-6 text-center">
          <button type="submit" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"><LogOut className="size-3.5" /> Sign out</button>
        </form>
      </div>
    </div>
  );
}
