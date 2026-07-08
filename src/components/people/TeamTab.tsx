import Link from "next/link";
import { Mail, Phone } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { ROLE_META } from "@/lib/pipeline";
import { ProjectStatus } from "@prisma/client";
import { PeopleTabs, type PeopleTab } from "./PeopleTabs";

// Team tab = the old /team directory, unchanged (workload cards linking to each
// person's /team/[id] detail page). Admin-visible. Runs its own TeamMember
// query — the Logins tab never does.

// In-flight project statuses — what "active assignments" should actually count
// (not every project the person has ever touched).
const ACTIVE_STATUSES: ProjectStatus[] = [
  "BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION",
];

export async function TeamTab({ show }: { show: PeopleTab[] }) {
  const activeWhere = { status: { in: ACTIVE_STATUSES } };
  const team = await prisma.teamMember.findMany({
    orderBy: { role: "asc" },
    include: {
      _count: {
        select: {
          shootsAsPhotographer: { where: activeWhere },
          projectsAsEditor: { where: activeWhere },
          projectsAsVa: { where: activeWhere },
        },
      },
    },
  });

  return (
    <div>
      <PageHeader eyebrow="Directory" title="People" subtitle={`${team.length} people`} />
      <div className="p-4 sm:p-6">
        <PeopleTabs tab="team" show={show} />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {team.map((m) => {
            const role = ROLE_META[m.role];
            const load =
              m._count.shootsAsPhotographer +
              m._count.projectsAsEditor +
              m._count.projectsAsVa;
            return (
              <Link key={m.id} href={`/team/${m.id}`} className="panel-shadow lift block rounded-2xl border bg-surface p-5 hover:bg-surface-2">
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
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
