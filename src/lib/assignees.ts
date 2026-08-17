import "server-only";
import { prisma } from "@/lib/prisma";

// The people a task can be assigned to, for the Daily Tasks filter + the assign
// dropdown. Built from the real TeamMember roster (Kyle, Jordan, James, Kim,
// Harrison, …) PLUS the editors/vendors that aren't team members (John in-house,
// Luma/AutoHDR/CubiCasa external, the Creative Director role).
//
// A task's `assignedKey` is a stable slug = the person's FIRST name (lowercased),
// which already matches the legacy keys in use (kyle/kim/john/luma), so no data
// migration is needed. Vendors/roles keep their fixed keys.

export type AssigneeKind = "owner" | "manager" | "photographer" | "editor" | "vendor";
export type Assignee = { key: string; name: string; kind: AssigneeKind; teamMemberId?: string };

// Editors / vendors / roles that are NOT in the TeamMember table.
const NON_TEAM: Assignee[] = [
  { key: "creative_director", name: "Creative Director", kind: "editor" },
  { key: "john", name: "John Mark", kind: "editor" },
  { key: "luma", name: "Luma", kind: "vendor" },
  { key: "autohdr", name: "AutoHDR", kind: "vendor" },
  { key: "cubicasa", name: "CubiCasa", kind: "vendor" },
];

const KIND_ORDER: Record<AssigneeKind, number> = { owner: 0, manager: 1, photographer: 2, editor: 3, vendor: 4 };

/** Stable assignment key for a person = their first name, lowercased + alnum. */
export function slugForName(name: string): string {
  const first = (name || "").trim().split(/\s+/)[0] || name || "";
  return first.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** First name, for compact display (Kyle, James, …). */
export function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || name || "";
}

// Jordan owns the business; his TeamMember role is PHOTOGRAPHER but he sorts as
// the owner.
const isOwnerName = (name: string) => /^jordan\b/i.test(name.trim());

export async function listAssignees(): Promise<Assignee[]> {
  const members = await prisma.teamMember.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true },
  });
  const team: Assignee[] = members.map((m) => ({
    key: slugForName(m.name),
    name: firstName(m.name),
    kind: isOwnerName(m.name) ? "owner" : m.role === "MANAGER" ? "manager" : "photographer",
    teamMemberId: m.id,
  }));
  const taken = new Set(team.map((t) => t.key));
  const extra = NON_TEAM.filter((v) => !taken.has(v.key));
  return [...team, ...extra].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}

/** Resolve a stored assignedKey (slug, or null = the Kyle default) to a display name. */
export function assigneeName(key: string | null | undefined, list: Assignee[]): string {
  const k = key || "kyle";
  return list.find((a) => a.key === k)?.name ?? firstName(k);
}
