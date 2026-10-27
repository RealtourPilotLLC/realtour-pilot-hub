// ---------------------------------------------------------------------------
// DRILL: outside shops need no packet, Cliffside Cuts is one, and Waiting rows
// carry no "Instructions missing" (Oct 27 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct27-outside-shops.ts
//
// Jordan, Oct 27:
//   · "In editing for sending jobs to luma - I dont need to submit a packet or
//     confirm it. If I assign it to Luma and change it to in editing, then
//     that should be all we need."
//   · "Add Cliffside Cuts as an external editor"
//   · "We dont need the instructions missing until the upload has been
//     submitted or it says ready for editing. If it says waiting, then the
//     yellow text shouldn't be there."
//
//   1. Cliffside Cuts is on the roster as an outside shop, beside Luma Visuals.
//   2. The office hands a job to Cliffside Cuts through the real reassign
//      action: pinned away from our editors, Kyle hears it, the row names the
//      shop, and no packet is asked for. Luma Visuals the same.
//   3. Changing it to In editing is the whole answer: the queue row, Kyle's
//      board, the delivery board and Jordan's home all read "In editing" —
//      while an in-house job nobody started still says "not confirmed".
//   4. A revision on a Cliffside job goes to Kyle to relay, naming the shop.
//   5. The Editing Room only reads reminder views for rows that are not
//      Waiting (source check on the page).
//
// ISOLATION. PGlite on 127.0.0.1:5716 (DRILL_PORT overrides); production is
// never opened; every non-loopback call is fenced. Clock pinned to Tue Oct 27
// 2026, 10:00 ET.
// ---------------------------------------------------------------------------
import path from "node:path";
import fs from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5716);
const REPO = path.resolve(__dirname, "../..");

const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 27, 14, 0, 0); // Tue Oct 27 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const et = (day: number, hour: number) => new RealDate(RealDate.UTC(2026, 9, day, hour + 4));

type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
const viewer: Viewer = {
  id: "u-ADMIN-drill", email: "office@example.com", name: "Office Drill", role: "ADMIN", permissions: null, status: "ACTIVE",
  teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: "ADMIN", realName: "Office Drill",
};
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) =>
    new Proxy(loaded as Record<string | symbol, unknown>, {
      get(t, k) {
        if (k === "getCurrentUser") return async () => viewer;
        return t[k];
      },
    }),
);
installNextStubs();
const fence = fenceFetch();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const actions = await import("@/app/editing/actions");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { EDITORS, DELEGATE_KEYS, OUTSIDE_EDITOR_KEYS, VIDEO_LANE_KEYS, isOutsideEditor } = await import("@/lib/editors");
  const { videoStatesFor } = await import("@/lib/reviewCuts");
  const { deliveryBoard } = await import("@/lib/deliveryBoard");
  const { laneFor } = await import("@/lib/revisionReminders");
  const { workLabel } = await import("@/lib/editorWork");

  const client = await prisma.client.create({ data: { name: "Outside Shop Drill TEST" }, select: { id: true } });
  let seq = 0;
  const mkJob = async (street: string) => {
    const p = await prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`, clientId: client.id, status: "SHOT", aryeoOrderId: `drill-os-${++seq}`,
        shootDate: et(26, 10), dropboxFolder: `/Drill/${street.replace(/\s+/g, "-")}`, videoInstructions: "Open on the front door.",
        statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 5, rawPhotos: 30, finalVideo: 0 } }),
      },
      select: { id: true },
    });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Social Reel", productTitle: "Standard Social Media Reel", videoStyle: "standard_reel", quantity: 1 } });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: `Edit — ${street}`, status: "OPEN", assignedKey: "john", projectId: p.id, clientId: client.id, dedupeKey: `edit-video-${p.id}` } });
    await ensureOutputsForProject(p.id);
    return p.id;
  };
  const rowOf = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].find((r) => r.id === id) ?? null;
  };

  // =========================================================================
  c.head("1 · Cliffside Cuts is an outside shop, beside Luma Visuals");
  // =========================================================================
  c.ok("the roster names it Cliffside Cuts, outside, with no login or Team row", EDITORS.cliffside_cuts?.name === "Cliffside Cuts" && EDITORS.cliffside_cuts.kind === "external" && !EDITORS.cliffside_cuts.teamMemberName);
  c.ok("both shops are the outside list, and both can be picked on a task and read as video work", OUTSIDE_EDITOR_KEYS.join() === "external_agency,cliffside_cuts" && DELEGATE_KEYS.includes("cliffside_cuts") && VIDEO_LANE_KEYS.includes("cliffside_cuts"));
  c.ok("Kim, John and the retired luma key are not outside shops", !isOutsideEditor("kim") && !isOutsideEditor("john") && !isOutsideEditor("luma") && !isOutsideEditor(null));
  const queueSrc = fs.readFileSync(path.join(REPO, "src/components/editing/SimpleQueue.tsx"), "utf8");
  const dialogSrc = fs.readFileSync(path.join(REPO, "src/components/editing/EditOverridesDialog.tsx"), "utf8");
  c.ok("the row's Editor menu and the details dialog both list Luma Visuals and Cliffside Cuts (no 'External agency')",
    [queueSrc, dialogSrc].every((s) => s.includes(`{ key: "cliffside_cuts", name: "Cliffside Cuts" }`) && s.includes(`{ key: "external_agency", name: "Luma Visuals" }`) && !s.includes(">External agency<") && !s.includes(`"External agency"`)));

  // =========================================================================
  c.head("2 · handing a job to Cliffside Cuts (the real reassign action)");
  // =========================================================================
  const C = await mkJob("10 Cliffside Way");
  const bellsBefore = await prisma.notification.count();
  const handed = await actions.setEditVideoEditor(C, "cliffside_cuts");
  c.ok("the office hands it over", handed.ok && handed.message === "Handed to Cliffside Cuts — it's off our editors' queues.", handed.message);
  const pc = await prisma.project.findUnique({ where: { id: C }, select: { editorManual: true, editorVendorKey: true, editorId: true } });
  const tc = await prisma.smartTask.findFirst({ where: { projectId: C, taskType: "edit_video" }, select: { assignedKey: true } });
  c.ok("the job is pinned to the shop (editorVendorKey) and the edit card carries it", pc?.editorManual === true && pc.editorVendorKey === "cliffside_cuts" && pc.editorId === null && tc?.assignedKey === "cliffside_cuts", JSON.stringify({ pc, tc }));
  const bell = await prisma.notification.findFirst({ where: { title: { startsWith: "Handed to Cliffside Cuts" } }, select: { title: true, body: true } });
  c.ok("Kyle's bell is a heads-up that names the shop, with nothing to record", !!bell && (await prisma.notification.count()) > bellsBefore && !/packet|record/i.test(`${bell.title} ${bell.body}`), `${bell?.title} · ${bell?.body}`);
  const rc1 = await rowOf(C);
  c.ok("the Editing Room row names Cliffside Cuts and carries no yellow line", rc1?.editor === "Cliffside Cuts" && rc1.blocker == null && rc1.status === "Ready for editing", `${rc1?.editor} · ${rc1?.status} · ${rc1?.blocker}`);
  const q1 = await buildEditorQueue();
  c.ok("…and it is off John's board (the row's editor key is the shop's)", q1.notDone.filter((r) => r.editorKey === "john").every((r) => r.id !== C) && rc1?.editorKey === "cliffside_cuts");
  const bad = await actions.setEditVideoEditor(C, "luma");
  c.ok("the retired luma key is still refused, and the refusal names both shops", !bad.ok && /Luma Visuals, Cliffside Cuts/.test(bad.message), bad.message);

  const L = await mkJob("20 Luma Lane");
  const handedL = await actions.setEditVideoEditor(L, "external_agency");
  const rl1 = await rowOf(L);
  c.ok("Luma Visuals: handed over the same way, no 'Not sent to Luma Visuals yet' on the row", handedL.ok && rl1?.editor === "Luma Visuals" && rl1.blocker == null, `${handedL.message} · ${rl1?.blocker}`);

  // =========================================================================
  c.head("3 · changing it to In editing is all it takes");
  // =========================================================================
  const J = await mkJob("30 John Street"); // an in-house job, the control
  for (const id of [C, L, J]) {
    const r = await actions.setQueueStatus(id, "In editing", `drill-${id}`, true);
    c.ok(`the office's In editing saves (${id === C ? "Cliffside" : id === L ? "Luma" : "John"})`, r.ok, r.message);
  }
  const [rc2, rl2, rj2] = await Promise.all([rowOf(C), rowOf(L), rowOf(J)]);
  c.ok("Cliffside Cuts' row reads In editing — not 'not confirmed' — with no yellow line", rc2?.status === "In editing" && rc2.blocker == null && rc2.workChip == null, `${rc2?.status} · ${rc2?.blocker}`);
  c.ok("Luma Visuals' row reads In editing too", rl2?.status === "In editing" && rl2.blocker == null, `${rl2?.status} · ${rl2?.blocker}`);
  c.ok("CONTROL: John's job nobody started still says 'In editing — not confirmed'", rj2?.status === "In editing — not confirmed", rj2?.status);
  const vs = await videoStatesFor([C, L, J]);
  c.ok("Kyle's board: 'In editing — Cliffside Cuts' / 'In editing — Luma Visuals'; John's still unconfirmed",
    vs.get(C)?.detail === "In editing — Cliffside Cuts" && vs.get(L)?.detail === "In editing — Luma Visuals" && /^In editing — not confirmed — John/.test(vs.get(J)?.detail ?? ""),
    [C, L, J].map((id) => vs.get(id)?.detail).join(" | "));
  // The raws are in (the photographer's upload), so the board reads who has it.
  await prisma.deliverable.updateMany({ where: { projectId: { in: [C, L, J] } }, data: { status: "UPLOADED" } });
  const board = await deliveryBoard({ includeTest: true });
  const jobs = [...board.today, ...board.tomorrow, ...board.upcoming, ...board.delivered];
  const labelOf = (id: string) => jobs.find((j) => j.id === id)?.blockerLabel ?? null;
  c.ok("the delivery board says In editing for the shops and 'not confirmed' for John", labelOf(C) === "In editing" && labelOf(L) === "In editing" && labelOf(J) === "In editing — not confirmed", [labelOf(C), labelOf(L), labelOf(J)].join(" | "));
  c.ok("workLabel: EDITING + outside = In editing; SHOT + outside stays Ready for editing", workLabel("EDITING", null, { outside: true }).label === "In editing" && workLabel("SHOT", null, { outside: true }).label === "Ready for editing" && workLabel("EDITING", null).label === "In editing — not confirmed");

  // =========================================================================
  c.head("4 · a revision on a Cliffside job goes to Kyle to relay");
  // =========================================================================
  c.ok("Cliffside Cuts and Luma Visuals are the agency lane; Kim is an editor", laneFor("cliffside_cuts") === "agency" && laneFor("external_agency") === "agency" && laneFor("kim") === "editor");

  // =========================================================================
  c.head("5 · Waiting rows: no Instructions missing, no Remind photographer");
  // =========================================================================
  const page = fs.readFileSync(path.join(REPO, "src/app/editing/page.tsx"), "utf8");
  c.ok("the Editing Room reads reminder views only for rows that are not Waiting", page.includes("remindViewsFor(notDone.filter((r) => r.status !== WAITING_ON_FOOTAGE).map((r) => r.id), now)"));
  const W = await mkJob("40 Waiting Way");
  await prisma.project.update({ where: { id: W }, data: { status: "SCHEDULED", shootDate: et(26, 9), statusEvidence: null } });
  const rw = await rowOf(W);
  c.ok("a past-shoot job with no upload reads Waiting (so its reminder view is skipped)", rw?.status === "Waiting", rw?.status);

  c.ok("nothing left the building", fence.blocked.length === 0, fence.blocked.join(", "));
  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
