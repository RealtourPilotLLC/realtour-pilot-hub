import "server-only";
import { prisma } from "@/lib/prisma";
import { OWNER_DUTIES, ownersFor, setOwnerOverride, assertDutyOwner, type OwnerDuty, type DutyOwner } from "@/lib/contentProgram";

// ---------------------------------------------------------------------------
// PROGRAM OWNERS (spec §16/§17, Jordan D11) — who is on the hook for what.
//
// The ProgramOwnerAssignment rows and the single-enrollment reads live in
// contentProgram.ts (W1-C minted the DEFAULT rows: Jordan = STRATEGY / SCRIPTS
// / ESCALATION, Kyle = SCHEDULING / DELIVERY / REMINDERS, and since CP-13
// Kyle = MESSAGES, the client's program conversation). This module is the
// one import every consumer uses — the portfolio overview's owner column, the
// client file's Settings tab, and the reminder evaluator's escalation owner —
// so nobody re-derives "who is Kyle" from a role. It adds the BATCH read the
// overview needs (28 enrollments × one month must not be 28 × 3 queries) and
// the word each duty is shown as.
// ---------------------------------------------------------------------------

export { OWNER_DUTIES, ownersFor, setOwnerOverride, assertDutyOwner };
export type { OwnerDuty, DutyOwner };

export const DUTY_WORDS: Record<OwnerDuty, string> = {
  STRATEGY: "strategy approval",
  SCRIPTS: "script approval",
  SCHEDULING: "scheduling",
  DELIVERY: "delivery",
  ESCALATION: "escalation",
  REMINDERS: "reminders",
  MESSAGES: "client messages", // CP-13: the program conversation's owner (Kyle by default)
};

export type OwnerMap = Record<OwnerDuty, DutyOwner>;

/**
 * Owners for many (enrollment, month) pairs in three queries. Resolution per
 * duty is MONTH override → ENROLLMENT override → DEFAULT, exactly as
 * ownersFor() does for one row; ownersFor() is called once first so the
 * DEFAULT rows exist before the batch read.
 */
export async function ownersForMany(pairs: { enrollmentId: string; monthId: string | null }[]): Promise<Map<string, OwnerMap>> {
  const out = new Map<string, OwnerMap>();
  if (pairs.length === 0) return out;
  await ownersFor(pairs[0].enrollmentId, pairs[0].monthId); // mints defaults on first use
  const enrollmentIds = [...new Set(pairs.map((p) => p.enrollmentId))];
  const monthIds = [...new Set(pairs.map((p) => p.monthId).filter((x): x is string => !!x))];
  const rows = await prisma.programOwnerAssignment.findMany({
    where: { endedAt: null, OR: [{ scope: "DEFAULT" }, { scope: "ENROLLMENT", scopeRef: { in: enrollmentIds } }, ...(monthIds.length ? [{ scope: "MONTH", scopeRef: { in: monthIds } }] : [])] },
  });
  const userIds = [...new Set(rows.map((r) => r.appUserId).filter((x): x is string => !!x))];
  const users = userIds.length ? await prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }) : [];
  const userOf = new Map(users.map((u) => [u.id, u]));
  for (const p of pairs) {
    const map = {} as OwnerMap;
    for (const duty of OWNER_DUTIES) {
      const pick =
        (p.monthId ? rows.find((r) => r.duty === duty && r.scope === "MONTH" && r.scopeRef === p.monthId) : undefined) ??
        rows.find((r) => r.duty === duty && r.scope === "ENROLLMENT" && r.scopeRef === p.enrollmentId) ??
        rows.find((r) => r.duty === duty && r.scope === "DEFAULT");
      const u = pick?.appUserId ? userOf.get(pick.appUserId) : undefined;
      map[duty] = { duty, appUserId: pick?.appUserId ?? null, email: u?.email ?? null, label: u?.name ?? pick?.label ?? "unassigned", scope: (pick?.scope as DutyOwner["scope"]) ?? "DEFAULT" };
    }
    out.set(pairKey(p.enrollmentId, p.monthId), map);
  }
  return out;
}

export const pairKey = (enrollmentId: string, monthId: string | null) => `${enrollmentId}:${monthId ?? ""}`;

/**
 * The map a lookup miss gets. Explicitly NOT "whatever other row happened to be
 * first": a batch read that misses must print "unassigned", never a different
 * client's owner, because a wrong name beside a client is read as a fact about
 * who is on the hook.
 */
export const UNASSIGNED_OWNERS: OwnerMap = Object.freeze(
  Object.fromEntries(OWNER_DUTIES.map((duty) => [duty, { duty, appUserId: null, email: null, label: "unassigned", scope: "DEFAULT" as const }])),
) as OwnerMap;

/** The person a reminder escalates to (W2-F reads this): the month/enrollment ESCALATION owner, Jordan by default. */
export async function escalationOwnerFor(enrollmentId: string, monthId?: string | null): Promise<DutyOwner> {
  return (await ownersFor(enrollmentId, monthId))["ESCALATION"];
}

/** Staff a duty can be handed to — active owner/admin logins only. */
export async function staffChoices(): Promise<{ id: string; name: string; email: string; role: string }[]> {
  const users = await prisma.appUser.findMany({ where: { status: "ACTIVE", role: { in: ["OWNER", "ADMIN"] } }, select: { id: true, name: true, email: true, role: true }, orderBy: { name: "asc" } });
  return users.map((u) => ({ id: u.id, name: u.name ?? u.email, email: u.email, role: u.role }));
}
