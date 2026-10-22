export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026). The two-video fix makes every main video product
// on an order its own video. Sharra Mercer's 34 Oakland Rd then reads "4 videos
// ordered, 3 set up". Jordan: "there are 4 videos, but one of the videos is
// only half shot and will need a second appointment". Until the hub can mark
// one video "waiting on a second shoot", the job is held at 3 owed with the
// office's own override (editing/actions.saveEditOverrides, as Jordan), so a
// 4th video does not reach an editor's queue or the at-risk list tonight.
// Lifted once that state exists. Dry run by default; --apply writes.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";
let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();
async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const p = await prisma.project.findFirst({ where: { title: { startsWith: "34 Oakland Rd" }, client: { name: { contains: "Mercer" } } }, select: { id: true, title: true, videosOwedOverride: true, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } } } });
  if (!p) throw new Error("34 Oakland Rd not found");
  console.log(`${p.title} | owed override now ${p.videosOwedOverride ?? "none"} | ${p.deliverables.map((d) => `${d.type} "${d.label}" x${d.quantity}`).join(", ")}`);
  if (!process.argv.includes("--apply")) { console.log("dry run (add --apply)"); process.exit(0); }
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };
  const { saveEditOverrides } = await import("../../src/app/editing/actions");
  console.log(JSON.stringify(await saveEditOverrides(p.id, { videosOwed: 3 } as never)));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
