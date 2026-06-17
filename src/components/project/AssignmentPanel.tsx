"use client";

import { useTransition } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { assignMember } from "@/app/actions";

type Member = { id: string; name: string; avatarColor: string };
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
}: {
  projectId: string;
  team: Member[];
  current: { photographer: string | null; editor: string | null; va: string | null };
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-3 px-5 py-4">
      {ROLES.map(({ role, label }) => {
        const value = current[role] ?? "";
        const member = team.find((m) => m.id === value);
        return (
          <div key={role} className="flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-2">{label}</span>
            <div className="flex items-center gap-2">
              {member && <Avatar name={member.name} color={member.avatarColor} size={22} />}
              <select
                value={value}
                disabled={pending}
                onChange={(e) =>
                  startTransition(async () => {
                    await assignMember(projectId, role, e.target.value || null);
                  })
                }
                className="rounded-lg border bg-surface px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-60"
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
