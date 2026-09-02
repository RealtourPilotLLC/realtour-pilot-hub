import Link from "next/link";
import { redirect } from "next/navigation";
import { Compass } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// OPS DAY — merged into Home (Jordan, Sep 2: "I want the ops day screen
// essentially combined with my dashboard").
//
// The whole screen — the time blocks, the QC cards with their evidence and
// shoot notes, Video Review, Open Loops with View/Handled, the closeout
// checklist, the priority order — moved to src/app/page.tsx, block ids and all.
// Nothing was dropped; there is one home per role now instead of two competing
// morning screens.
//
// The ROUTE stays, as a redirect stub, exactly like /team → /users?tab=team and
// /map → /schedule?view=map. It has to:
//   · homeFor("ADMIN") in src/lib/auth/access.ts still returns "/ops", so this
//     is where Kyle and James land at login. (That file belongs to another
//     lane; pointing it at "/" is a one-line follow-up, and until then this
//     hop is what makes their login correct.)
//   · every "#loops" / "#qc-am" / "#video-review" link ever sent still works —
//     the browser re-attaches the fragment across the redirect and the block
//     ids on Home are unchanged.
//   · revalidatePath("/ops") in src/app/ops/actions.ts stays valid; Home is
//     force-dynamic, so it re-reads on every request regardless.
// ---------------------------------------------------------------------------

export default async function OpsDayPage() {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);

  // A person who holds `ops` but whose `dashboard` was revoked must NOT be
  // forwarded: middleware would deny "/" and bounce them back to homeFor(ADMIN)
  // = "/ops", which would forward again — ERR_TOO_MANY_REDIRECTS, the exact
  // loop the middleware comments warn about. Tell them where it went instead;
  // a rendered page always terminates.
  if (me && !canAccess(me, "dashboard")) {
    return (
      <div>
        <PageHeader title="Ops Day" subtitle="This screen moved" />
        <div className="mx-auto max-w-2xl p-4 sm:p-6">
          <div className="panel-shadow rounded-2xl border border-border bg-surface p-6 text-center">
            <Compass className="mx-auto size-8 text-brand" />
            <p className="mt-2 text-sm font-semibold">Ops Day is now the Home screen.</p>
            <p className="mt-1 text-xs text-muted">
              Your account doesn&rsquo;t have Home switched on yet — ask Jordan to grant
              &ldquo;Dashboard&rdquo; on the People page, then this link takes you straight there.
            </p>
            <Link href="/tasks" className="mt-4 inline-flex items-center rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
              Go to your tasks
            </Link>
          </div>
        </div>
      </div>
    );
  }

  redirect("/");
}
