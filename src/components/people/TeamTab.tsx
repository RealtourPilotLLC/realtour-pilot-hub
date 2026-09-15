import Link from "next/link";
import { Mail, Phone } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { ROLE_META } from "@/lib/pipeline";
import { ProjectStatus } from "@prisma/client";
import { PeopleTabs, type PeopleTab } from "./PeopleTabs";
import { SlackIdField } from "./SlackIdField";
import { SlackTestDmButton } from "./SlackTestDmButton";

// Team tab = the old /team directory (workload cards linking to each person's
// /team/[id] detail page). Admin-visible. Runs its own TeamMember query — the
// Logins tab never does. Since Sep 15 each card also carries the person's
// Slack member ID — the one field that makes an @mention or a reply in the
// hub reach them on Slack (Jordan: "if I type at John or at Kyle, a
// notification is sent to them directly in Slack"). The card stopped being
// one big Link for that: the field has buttons, and a button inside a link
// navigates instead of saving.

// In-flight project statuses — what "active assignments" should actually count
// (not every project the person has ever touched).
const ACTIVE_STATUSES: ProjectStatus[] = [
  "BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION",
];

export async function TeamTab({ show, canEditSlack, isOwner }: { show: PeopleTab[]; canEditSlack: boolean; isOwner: boolean }) {
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
  const withSlack = team.filter((m) => m.slackId).length;

  return (
    <div>
      <PageHeader
        eyebrow="Directory"
        title="People"
        subtitle={`${team.length} people · ${withSlack} on Slack`}
        actions={isOwner ? <SlackTestDmButton /> : undefined}
      />
      <div className="p-4 sm:p-6">
        <PeopleTabs tab="team" show={show} />
        <p className="mb-4 text-xs text-muted">
          An @mention or a reply anywhere in the hub DMs the person on Slack — with the summary and the link — when their
          Slack member ID is on their card. No ID: the bell (and any text fallback) only.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {team.map((m) => {
            const role = ROLE_META[m.role];
            const load =
              m._count.shootsAsPhotographer +
              m._count.projectsAsEditor +
              m._count.projectsAsVa;
            return (
              <div key={m.id} className="panel-shadow rounded-2xl border bg-surface p-5">
                <Link href={`/team/${m.id}`} className="flex items-center gap-3 rounded-lg hover:bg-surface-2">
                  <Avatar name={m.name} size={44} color={m.avatarColor} />
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{m.name}</div>
                    <Badge color={role.color} soft={`${role.color}1a`}>
                      {role.label}
                    </Badge>
                  </div>
                </Link>
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
                <SlackIdField memberId={m.id} firstName={m.name.split(/\s+/)[0]} slackId={m.slackId} canEdit={canEditSlack} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
