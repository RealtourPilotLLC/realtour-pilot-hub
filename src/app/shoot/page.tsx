import { redirect } from "next/navigation";
import {
  listMyShoots, listPhotographerTasks, photographerMemberId, getShootPhotographer,
  type PhotographerTaskRow,
} from "@/lib/shoot";
import { getNextShootFocus, type NextShootFocus } from "@/lib/photographerFeedback";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { FieldTabs } from "@/components/shoot/FieldTabs";
import { MyShootsView } from "@/components/shoot/MyShootsView";

export const dynamic = "force-dynamic";

export default async function MyShootsPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>;
}) {
  const user = await getCurrentUser();
  // Fail CLOSED on a null user under enforcement — a disabled account's stale
  // JWT passes the middleware, and null would otherwise read as "owner-ish"
  // (unscoped = everyone's shoots).
  if (!user && authEnforced()) redirect("/login");
  const isPhotographer = user?.role === "PHOTOGRAPHER";
  const { as } = await searchParams;

  // Owner/admin can step into a specific photographer's view (read-only preview
  // of that photographer's My Shoots). Photographers can never use ?as= — they're
  // always scoped to themselves, fail-closed.
  const viewAs = !isPhotographer && as ? await getShootPhotographer(as) : null;

  // Photographers see ONLY their own assigned shoots; owner/admin see everyone's,
  // unless they're viewing as a specific photographer.
  const scoped = isPhotographer
    ? ((await photographerMemberId(user)) ?? "__none__")
    : viewAs?.id ?? null;

  // The shoots list + the "work on this next shoot" reminder + the person's own
  // open tasks (both only meaningful when scoped to one person — covers the
  // photographer themselves AND an owner/admin ?as= preview), in parallel.
  const personScoped = scoped && scoped !== "__none__" ? scoped : null;
  const [rows, focus, tasks]: [
    Awaited<ReturnType<typeof listMyShoots>>,
    NextShootFocus | null,
    PhotographerTaskRow[],
  ] = await Promise.all([
    listMyShoots(scoped),
    personScoped ? getNextShootFocus(personScoped) : Promise.resolve(null),
    personScoped ? listPhotographerTasks(personScoped) : Promise.resolve([]),
  ]);

  // Owner/admin (not already scoped): their own photographer id for "only mine".
  const meId = scoped === null && user ? await photographerMemberId(user) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Field"
        title={viewAs ? `${viewAs.name}’s shoots` : "My Shoots"}
        subtitle={
          viewAs
            ? `Read-only — exactly what ${viewAs.name.split(" ")[0]} sees`
            : scoped
              ? "Your upcoming and recent shoots"
              : "All upcoming and recent shoots"
        }
      />
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
        <FieldTabs active="shoots" asId={viewAs?.id} feedbackCount={focus?.openFixes ?? 0} />
        <MyShootsView
          rows={rows}
          showWho={scoped === null}
          meId={meId}
          viewAs={viewAs}
          focus={focus}
          focusHref={viewAs ? `/shoot/feedback?as=${viewAs.id}` : "/shoot/feedback"}
          tasks={tasks}
          // Previews (?as= and owner "view as") are look-don't-touch — the done
          // button would fail requireTaskAccess anyway, so don't offer it.
          tasksReadOnly={Boolean(viewAs) || Boolean(user?.impersonating)}
        />
      </div>
    </div>
  );
}
