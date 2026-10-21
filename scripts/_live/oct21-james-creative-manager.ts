// ---------------------------------------------------------------------------
// LIVE: James becomes the CREATIVE MANAGER login (Jordan, Oct 21 2026).
// "Instead of James being admin, create a creative manager user type and
// assign that to James instead of admin."
//
//   npx tsx scripts/_live/oct21-james-creative-manager.ts            dry run
//   npx tsx scripts/_live/oct21-james-creative-manager.ts --apply    write it
//
// Opens the LIVE database (the .env one). Run it only after the deploy that
// knows the CREATIVE_MANAGER role: an older build reads the new role as "no
// pages" and would lock James out.
//
// What it does:
//   · finds James by his roster row (TeamMember.creativeManager = true, named
//     James Livingston), then his login (AppUser by that roster link, else by
//     the roster email). Anything other than exactly one of each: stop.
//   · role ADMIN → CREATIVE_MANAGER, and permissions → null, so the role's
//     defaults (lib/auth/access ROLE_PAGES.CREATIVE_MANAGER) decide his pages.
//     His Aug 24 overrides were {"mypay":true,"sales":false,"trends":false,
//     "communications":true,"clients":true}: mypay and clients are now role
//     defaults, sales and trends are closed by default, and communications
//     (the client texts and email inbox, Kyle's) is deliberately NOT carried
//     over. Jordan can grant it back on People → Logins in one click.
//   · writes one AuditLog row (the same shape People → Logins writes), and
//     changes the row only if it still reads what was printed (a compare and
//     set on role + permissions).
// Nothing else changes: his review seat, his roster flag, his notification
// switches and his bonus basis are untouched. His session needs no sign-out:
// every page and action re-reads the live login (lib/auth/user).
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";

export const TARGET_ROLE = "CREATIVE_MANAGER";
export const TARGET_PERMISSIONS: string | null = null;
const NAME = /^james\s+livingston$/i;

export type SwitchPlan =
  | { ok: false; why: string }
  | {
      ok: true;
      teamMemberId: string;
      user: { id: string; email: string; name: string | null; role: string; permissions: string | null; status: string };
      after: { role: string; permissions: string | null };
      noChange: boolean;
    };

/** Read-only: who James is and what would change. */
export async function planSwitch(prisma: PrismaClient): Promise<SwitchPlan> {
  const flagged = await prisma.teamMember.findMany({ where: { creativeManager: true }, select: { id: true, name: true, email: true, active: true } });
  const tms = flagged.filter((t) => NAME.test(t.name.trim()));
  if (tms.length !== 1) {
    return { ok: false, why: `expected one creative-manager roster row named James Livingston, found ${tms.length} (flagged: ${flagged.map((t) => t.name).join(", ") || "none"})` };
  }
  const tm = tms[0];
  let users = await prisma.appUser.findMany({
    where: { teamMemberId: tm.id },
    select: { id: true, email: true, name: true, role: true, permissions: true, status: true },
  });
  if (users.length === 0 && tm.email) {
    users = await prisma.appUser.findMany({
      where: { email: { equals: tm.email, mode: "insensitive" } },
      select: { id: true, email: true, name: true, role: true, permissions: true, status: true },
    });
  }
  if (users.length !== 1) return { ok: false, why: `expected one login for ${tm.name}, found ${users.length}` };
  const user = users[0];
  if (user.role === "OWNER") return { ok: false, why: "that login is an OWNER; refusing to change it" };
  if (user.role !== "ADMIN" && user.role !== TARGET_ROLE) return { ok: false, why: `that login is ${user.role}, not ADMIN; check by hand before switching` };
  const noChange = user.role === TARGET_ROLE && user.permissions === TARGET_PERMISSIONS;
  return { ok: true, teamMemberId: tm.id, user, after: { role: TARGET_ROLE, permissions: TARGET_PERMISSIONS }, noChange };
}

/** The write: compare-and-set on what the plan read, plus the audit row. */
export async function applySwitch(prisma: PrismaClient, plan: Extract<SwitchPlan, { ok: true }>, actor = "claude:oct21-james-creative-manager"): Promise<{ ok: boolean; message: string }> {
  if (plan.noChange) return { ok: true, message: "already CREATIVE_MANAGER with no overrides; nothing written" };
  const changed = await prisma.appUser.updateMany({
    where: { id: plan.user.id, role: plan.user.role, permissions: plan.user.permissions },
    data: { role: plan.after.role, permissions: plan.after.permissions },
  });
  if (changed.count !== 1) return { ok: false, message: "the login changed since it was read; nothing written. Run the dry run again." };
  await prisma.auditLog.create({
    data: {
      actor,
      action: "role_change",
      target: plan.user.email,
      detail: `${plan.user.role} → ${plan.after.role}; permissions ${plan.user.permissions ?? "none"} → none (Jordan, Oct 21 2026: creative manager)`,
    },
  });
  return { ok: true, message: "switched" };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../src/lib/prisma");
  try {
    const plan = await planSwitch(prisma);
    if (!plan.ok) {
      console.log("STOP:", plan.why);
      process.exitCode = 1;
      return;
    }
    console.log("before:", plan.user);
    console.log("after: ", { ...plan.user, ...plan.after });
    if (plan.noChange) {
      console.log("nothing to do");
      return;
    }
    if (!apply) {
      console.log("dry run: run again with --apply to write it");
      return;
    }
    const r = await applySwitch(prisma, plan);
    console.log(r.ok ? "applied:" : "NOT applied:", r.message);
    console.log("now:   ", await prisma.appUser.findUnique({ where: { id: plan.user.id }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true } }));
    if (!r.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a script, never when a drill imports the plan.
if (/oct21-james-creative-manager\.ts$/.test(process.argv[1] ?? "")) void main();
