import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { MyCoachingList } from "@/components/coaching/MyCoachingList";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { developmentSeat } from "@/lib/teamDevelopment";
import { myCoachingIds, readMyCoaching } from "@/lib/myCoaching";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// MY COACHING (Oct 29 2026, Jordan's call table: "Put reviewed feedback in
// his Hub and send a text with a direct link"). The coaching James or Jordan
// recorded for whoever is signed in, and nobody else's: an editor, the office,
// anyone the coaching text links here. Field creatives read the same list on
// "My quality notes" (/shoot/feedback#coaching), so a photographer login is
// sent there. No page key: every signed-in role may open it, and it only ever
// reads the viewer's own records (an owner's "view as" reads the person
// previewed, read only like every page).
// ---------------------------------------------------------------------------

export default async function MyCoachingPage() {
  const me = await getCurrentUser();
  if (!me && authEnforced()) redirect("/login");
  if (me?.role === "PHOTOGRAPHER") redirect("/shoot/feedback#coaching");
  const ids = me ? myCoachingIds(me) : [];
  const items = await readMyCoaching(ids).catch((e: unknown) => {
    console.warn("[my-coaching] read failed", (e as Error)?.message);
    return null;
  });
  const coach = me ? await developmentSeat(me).catch(() => false) : false;
  return (
    <div>
      <PageHeader eyebrow="You" title="My coaching" subtitle="Feedback recorded for you, the standard, and your next step" />
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
        {items === null ? (
          <p role="alert" className="rounded-2xl border border-border bg-surface p-4 text-sm text-danger">Your coaching could not be read just now. Reload the page in a minute.</p>
        ) : (
          <MyCoachingList items={items} whose="your" />
        )}
        {coach && (
          <p className="text-[13px] text-muted">
            The team&rsquo;s coaching is on <Link href="/development" className="text-brand hover:underline">Team development</Link>.
          </p>
        )}
      </div>
    </div>
  );
}
