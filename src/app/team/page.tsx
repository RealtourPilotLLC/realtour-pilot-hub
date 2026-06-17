import { Mail, Phone } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { ROLE_META } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const team = await prisma.teamMember.findMany({
    orderBy: { role: "asc" },
    include: {
      _count: {
        select: {
          shootsAsPhotographer: true,
          projectsAsEditor: true,
          projectsAsVa: true,
        },
      },
    },
  });

  return (
    <div>
      <PageHeader title="Team" subtitle={`${team.length} people`} />
      <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-3">
        {team.map((m) => {
          const role = ROLE_META[m.role];
          const load =
            m._count.shootsAsPhotographer +
            m._count.projectsAsEditor +
            m._count.projectsAsVa;
          return (
            <div key={m.id} className="rounded-2xl border bg-surface p-5">
              <div className="flex items-center gap-3">
                <Avatar name={m.name} size={44} color={m.avatarColor} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">{m.name}</div>
                  <Badge color={role.color} soft={`${role.color}1a`}>
                    {role.label}
                  </Badge>
                </div>
              </div>
              <div className="mt-3 space-y-1 text-sm text-muted">
                <div className="flex items-center gap-2">
                  <Mail className="size-3.5" /> {m.email}
                </div>
                {m.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="size-3.5" /> {m.phone}
                  </div>
                )}
              </div>
              <div className="mt-3 text-xs text-muted">
                {load} active assignment{load === 1 ? "" : "s"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
