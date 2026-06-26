import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/auth/user";
import { UsersManager, type UserView } from "@/components/users/UsersManager";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireAccess("users"); // owner-only
  const rows = await prisma.appUser.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] });
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
      isSelf: u.id === me.id,
    }));

  return (
    <div>
      <PageHeader
        eyebrow="Access control"
        title="Users"
        subtitle="Who can sign in, their role, and exactly what they can see."
      />
      <div className="p-4 sm:p-6">
        <UsersManager users={users} />
      </div>
    </div>
  );
}
