// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, Jordan approved the role menus). James's login
// still carries two overrides from when it was ADMIN: tasks:false (his
// dashboard's "Open" went to /tasks and bounced him home) and ops:true (dead:
// the creative manager's menu strips /ops/* and those pages admit the owner
// and the office only). Removing both gives him his role defaults: Tasks
// opens, scoped to his own creative work (guards.taskScopeOf: a
// CREATIVE_MANAGER sees only items addressed to him), and nothing else
// changes. Also (Jordan, Oct 22: "Yes but please make sure I get all
// notifications via slack"): his everything-on-Slack switch goes ON
// (notifyPrefs.wantsAllSlack), and his saved channels are left as they are.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_live/oct22-james-permissions.ts            # dry run
//   … --apply                                            # writes
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { allSlackKey, wantsAllSlack } from "@/lib/notifyPrefs";
import { putSetting } from "@/lib/settings";

const JAMES_LOGIN = "cmqv7es4y0000i10a3c1d3o8m";
const JORDAN_TM = "cmqidx2on00009ke2vvuyx40p";
const STALE = ["tasks", "ops"];
const apply = process.argv.includes("--apply");

(async () => {
  const u = await prisma.appUser.findUnique({ where: { id: JAMES_LOGIN }, select: { name: true, role: true, permissions: true } });
  if (!u) throw new Error("James's login not found");
  let perms: Record<string, boolean> = {};
  try { perms = JSON.parse(u.permissions ?? "{}") as Record<string, boolean>; } catch { perms = {}; }
  const next = Object.fromEntries(Object.entries(perms).filter(([k]) => !STALE.includes(k)));
  const nextRaw = Object.keys(next).length ? JSON.stringify(next) : null;
  console.log(`${u.name} (${u.role}) permissions: ${u.permissions ?? "null"} → ${nextRaw ?? "null"}`);

  console.log(`Jordan, every notification on Slack: ${await wantsAllSlack(JORDAN_TM)} → true`);

  if (!apply) { console.log("dry run: nothing written (pass --apply)"); await prisma.$disconnect(); return; }
  if (u.role !== "CREATIVE_MANAGER") throw new Error(`refusing: James's role is ${u.role}, not CREATIVE_MANAGER`);
  await prisma.appUser.update({ where: { id: JAMES_LOGIN }, data: { permissions: nextRaw } });
  await putSetting(allSlackKey(JORDAN_TM), { on: true });
  console.log("applied");
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
