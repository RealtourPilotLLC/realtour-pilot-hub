// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026): Sharra Mercer's 34 Oakland Rd owes FOUR videos,
// and the fourth waits on a second shoot.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct22-sharra-fourth-video.ts           # dry run
//     NODE_OPTIONS=--conditions=react-server node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct22-sharra-fourth-video.ts --apply   # writes
//
// Jordan: "there are 4 videos, but one of the videos is only half shot and
// will need a second appointment for it. So what do we do in that case?" The
// order sells 3 Premium Social Media Reels plus the Social Influencer
// package's reel. Until the hub could hold one video for a second shoot, the
// job was pinned at 3 owed (scripts/_live/oct22-sharra-hold-4th.ts). Now that
// it can (lib/secondShoot), this undoes the pin and holds the fourth video:
//
//   1. the order sync for this one job (aryeo.reconcileDeliverablesToOrder,
//      the order read with one GET), so the Social Influencer reel has a row;
//   2. the office's videos-owed number lifted (editing/actions.saveEditOverrides
//      with videosOwed null, as Jordan; the office's due date stays), so all
//      four videos are set up by the order, each with its per-video row;
//   3. the fourth video marked "Waiting on a second shoot" with Jordan's note
//      (secondShoot.markVideoWaitingOnShoot): off the editors' queue, no due
//      date, released by the next appointment's footage or the office.
//
// Dry run by default: the connection is READ-ONLY unless --apply is given,
// and the dry run only reads and prints the plan. No Aryeo write anywhere.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const APPLY = process.argv.includes("--apply");
const NOTE = "Half shot; needs a second appointment (Jordan, Oct 22)";

if (!APPLY) {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set: run with node --env-file=.env.");
  if (!/default_transaction_read_only/.test(url)) {
    process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
  }
}

// saveEditOverrides asks who is signed in: Jordan, for this one call.
let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

const et = (d: Date | null | undefined) =>
  d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "none";

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const aryeo = await import("../../src/lib/integrations/aryeo");
  const { cutSlots } = await import("../../src/lib/reviewCuts");
  const { videoSetupGapOf, videoSetupGapFor } = await import("../../src/lib/videoSetup");
  await aryeo.loadManualProductMap(true);

  const project = await prisma.project.findFirst({
    where: { title: { startsWith: "34 Oakland Rd" }, client: { name: { contains: "Mercer" } } },
    select: {
      id: true, title: true, status: true, aryeoOrderId: true, videosOwedOverride: true, dueOverrideAt: true, overrideBy: true, packageName: true, contentMonthId: true,
      shootDate: true, appointments: { select: { startAt: true, status: true } },
      deliverables: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, type: true, label: true, quantity: true, status: true, manual: true, removedFromOrderAt: true, productTitle: true, videoStyle: true, waivedAt: true } },
    },
  });
  if (!project) throw new Error("34 Oakland Rd not found");
  if (!project.aryeoOrderId) throw new Error("no Aryeo order on the job");
  if (["CANCELLED"].includes(project.status)) throw new Error(`job is ${project.status}: not touched`);
  console.log(`=== ${project.title} (${project.id}) · ${APPLY ? "APPLY" : "DRY RUN (read-only connection)"} ===`);
  console.log(`status ${project.status} · shot ${et(project.shootDate)} · visits ${project.appointments.map((a) => `${et(a.startAt)} ${a.status}`).join(", ")}`);
  console.log(`office: videos owed ${project.videosOwedOverride ?? "none"} · due ${et(project.dueOverrideAt)} (set by ${project.overrideBy ?? "?"})`);

  // 1. The order, read live (GET only), and the sync's own pairing.
  const order = await aryeo.Aryeo.order(project.aryeoOrderId);
  console.log(`\nAryeo order #${order.number}: ${(order.items ?? []).length} lines`);
  for (const it of order.items ?? []) {
    const rows = aryeo.itemToDeliverables(it).map((d) => `${d.type}${d.videoStyle ? `/${d.videoStyle}` : ""}`).join(", ");
    console.log(`  · ${it.title} ×${it.quantity ?? 1}${it.is_canceled ? " (canceled)" : ""} -> ${rows || "nothing"}`);
  }
  const parsed = aryeo.orderDeliverables(order.items);
  console.log(`videos the order sells: ${aryeo.orderedVideoCount(parsed)}`);
  const answerable = project.deliverables.filter((r) => !r.manual && !/added manually/i.test(r.label ?? ""));
  const plan = aryeo.matchRowsToWants(answerable, parsed);
  console.log(`\nthe order sync (reconcileDeliverablesToOrder's pairing):`);
  for (const { row, want } of plan.pairs) console.log(`  keep ${row.type} "${row.label}" ×${row.quantity} <- "${want.productTitle}"`);
  for (const w of plan.unmatchedWants) console.log(`  CREATE ${w.type} "${w.label}" ×${w.quantity} · product "${w.productTitle}" · style ${w.videoStyle}`);
  for (const r of plan.unmatchedRows) console.log(`  retire ${r.type} "${r.label}"${r.removedFromOrderAt ? " (already retired)" : ""}`);

  // 2. The videos once the office's number is lifted: the order's rows, in slot order.
  const after = [
    ...project.deliverables.filter((d) => !d.removedFromOrderAt && (d.type === "VIDEO" || d.type === "SOCIAL_REEL")),
    ...plan.unmatchedWants.filter((w) => w.type === "VIDEO" || w.type === "SOCIAL_REEL").map((w) => ({ id: "(new)", type: w.type, label: w.label, quantity: w.quantity, productTitle: w.productTitle, videoStyle: w.videoStyle, waivedAt: null })),
  ];
  const videos = after.flatMap((d) => Array.from({ length: Math.max(1, d.quantity ?? 1) }, (_, i) => ({ row: d, slot: i + 1 })));
  console.log(`\nvideos after (override lifted):`);
  videos.forEach((v, i) => console.log(`  ${i + 1}. ${v.row.label} (${v.row.productTitle}) slot ${v.slot}${i === videos.length - 1 ? `  <- WAITING ON A SECOND SHOOT: "${NOTE}"` : ""}`));
  const gap = videoSetupGapOf({ orderItems: (order.items ?? []).map((it) => ({ title: it.title ?? "", quantity: it.quantity ?? 1, isCanceled: !!it.is_canceled })), videoRows: after, videosOwedOverride: null, monthly: false });
  console.log(`guard after: ${gap ? gap.words : `no gap (${aryeo.orderedVideoCount(parsed)} ordered, ${videos.length} set up)`}`);
  console.log(`video 4 while it waits: no due date, off the editors' queue, not counted against the job's delivery; released by a later appointment's video footage (or Release to the editor), then due on its own premium turnaround from that shoot.`);

  if (!APPLY) {
    console.log(`\nDRY RUN: nothing written. Re-run with --apply.`);
    await prisma.$disconnect();
    return;
  }

  // ---- APPLY ----
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };
  const res = await aryeo.reconcileDeliverablesToOrder(project.id, order);
  console.log(`\n1. order sync: ${JSON.stringify(res)}`);
  const { saveEditOverrides } = await import("../../src/app/editing/actions");
  const lifted = await saveEditOverrides(project.id, { videosOwed: null } as never);
  console.log(`2. videos owed lifted: ${JSON.stringify(lifted)}`);
  if (!lifted.ok) throw new Error("the override did not lift; nothing held");
  const dout = await import("../../src/lib/deliverableOutputs");
  await dout.ensureOutputsForProject(project.id);
  const slots = await cutSlots(project.id, { includeWaiting: true });
  console.log(`   slots: ${slots.map((s, i) => `${i + 1}. ${s.label} [${s.deliverableId}:${s.slot}]`).join(" · ")}`);
  if (slots.length !== 4) throw new Error(`expected 4 videos, found ${slots.length}: not holding any (check the job)`);
  const fourth = slots[3];
  const { markVideoWaitingOnShoot } = await import("../../src/lib/secondShoot");
  const held = await markVideoWaitingOnShoot({ projectId: project.id, key: `${fourth.deliverableId}:${fourth.slot}`, note: NOTE, actor: owner.name ?? "Jordan", kick: false });
  console.log(`3. ${JSON.stringify(held)}`);
  const owed = await cutSlots(project.id);
  console.log(`\nowed now (the editors' slots): ${owed.length} · guard: ${(await videoSetupGapFor(project.id))?.words ?? "no gap"}`);
  await prisma.$disconnect();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
