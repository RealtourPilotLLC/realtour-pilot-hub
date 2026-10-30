"use client";

import { useTransition } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { teamPhotoSrc } from "@/lib/teamPhoto";
import { assignMember } from "@/app/actions";

type Member = { id: string; name: string; avatarColor: string; photoAt?: Date | string | null };
type Role = "photographer" | "editor" | "va";

const ROLES: { role: Role; label: string }[] = [
  { role: "photographer", label: "Photographer" },
  { role: "editor", label: "Editor" },
  { role: "va", label: "VA" },
];

export function AssignmentPanel({
  projectId,
  team,
  current,
  readOnly = false,
}: {
  projectId: string;
  team: Member[];
  current: { photographer: string | null; editor: string | null; va: string | null };
  /** Oct 21 2026: the creative manager reads who is on the job; assigning is the office's (assignMember). */
  readOnly?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  if (readOnly) {
    return (
      <dl className="space-y-3 px-5 py-4">
        {ROLES.map(({ role, label }) => {
          const member = team.find((m) => m.id === current[role]);
          return (
            <div key={role} className="flex items-center justify-between gap-3">
              <dt className="text-xs uppercase tracking-wide text-muted-2">{label}</dt>
              <dd className="flex items-center gap-2 text-sm">
                {member && <Avatar name={member.name} src={teamPhotoSrc(member)} color={member.avatarColor} size={22} />}
                {member?.name ?? <span className="text-muted">Unassigned</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }

  return (
    <div className="space-y-3 px-5 py-4">
      {ROLES.map(({ role, label }) => {
        const value = current[role] ?? "";
        const member = team.find((m) => m.id === value);
        return (
          <div key={role} className="flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-2">{label}</span>
            <div className="flex items-center gap-2">
              {member && <Avatar name={member.name} src={teamPhotoSrc(member)} color={member.avatarColor} size={22} />}
              <select
                value={value}
                disabled={pending}
                onChange={(e) =>
                  startTransition(async () => {
                    await assignMember(projectId, role, e.target.value || null);
                  })
                }
                className="rounded-lg border bg-surface px-2 py-1 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-60"
              >
                <option value="">Unassigned</option>
                {team.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );
      })}
    </div>
  );
}
