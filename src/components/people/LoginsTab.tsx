import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { editorPools } from "@/lib/settings";
import { ROUTING_LANES } from "@/lib/editors";
import { UsersManager, type UserView } from "@/components/users/UsersManager";
import type { CurrentUser } from "@/lib/auth/user";
import { PeopleTabs, type PeopleTab } from "./PeopleTabs";

// Logins & access tab = the old /users page, unchanged (AppUser allowlist, roles,
// per-page permission toggles, invites). OWNER-ONLY — the page gates this before
// rendering. Runs its own AppUser query; the Team tab never does. `me` is passed
// in so the manager can flag the current user's own row (can't self-lock-out);
// it's null only in sessionless local dev (owner view), where no row is "self".
export async function LoginsTab({ show, me }: { show: PeopleTab[]; me: CurrentUser | null }) {
  const [rows, cards, pools] = await Promise.all([
    prisma.appUser.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] }),
    // Team cards (Oct 30 2026): the Slack ID, phone, clock and editor desk the
    // hub reaches someone by. Linked by id, else matched on email.
    prisma.teamMember.findMany({ select: { id: true, name: true, email: true, slackId: true, phone: true, timezone: true, location: true, editorKey: true } }),
    editorPools(),
  ]);
  const cardFor = (u: { teamMemberId: string | null; email: string }) =>
    cards.find((c) => c.id === u.teamMemberId) ?? cards.find((c) => c.email?.toLowerCase() === u.email.toLowerCase()) ?? null;
  const ROLE_ORDER: Record<string, number> = { OWNER: 0, ADMIN: 1, EDITOR: 2, PHOTOGRAPHER: 3 };
  const users: UserView[] = rows
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || (a.name || a.email).localeCompare(b.name || b.email))
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      permissions: u.permissions,
      status: u.status,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      isSelf: u.id === me?.id,
      team: (() => {
        const c = cardFor(u);
        return c ? { name: c.name, slackId: c.slackId, phone: c.phone, timezone: c.timezone, location: c.location, editorKey: c.editorKey } : null;
      })(),
      lanes: (() => {
        const key = cardFor(u)?.editorKey;
        return key ? ROUTING_LANES.filter((l) => pools[l].includes(key)) : [];
      })(),
    }));

  return (
    <div>
      <PageHeader
        eyebrow="Access control"
        title="People"
        subtitle="Who can sign in, their role, and exactly what they can see."
      />
      <div className="p-4 sm:p-6">
        <PeopleTabs tab="logins" show={show} />
        <UsersManager users={users} />
      </div>
    </div>
  );
}
