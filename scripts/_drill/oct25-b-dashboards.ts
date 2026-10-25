// Oct 25 2026 audit, area B (the dashboards, daily ops, tasks and the
// schedule). Each fix the audit made, held against its own case:
//   1  WHO IS OFF ON A SHOOT DAY (lib/timeOff): Harrison's week off (PTO,
//      Oct 26 to Oct 30) with five shoots still on him in Aryeo read as
//      covered on every home. Now Jordan's Production health blocks the shoot
//      (the office's move: reassign or move it), Team coverage and Weekly
//      performance count it, Kyle's desk puts it first on the visit, and the
//      Schedule says "Off that day" beside the name. Part of a day off is a
//      question, never a block; the capacity register's time off counts too.
//   2  Kyle's shoot-flag loops (`field-flag-<job>`) clear when the job is
//      delivered, like the older keys always did.
//   3  Kyle's desk: a photo revision filed from an email with no job on it
//      names its street and lane ("215 Koser Rd · Photo correction", the
//      office's to fix), never "a job · Video revision"; a floor plan ready to
//      check past its promise is late, as its due words already said.
//   4  The shared dashboard's unreachable owner-only cards are gone from "/"
//      (the owner's home has been components/owner/OwnerHome since Oct 23).
// Disposable PGlite; the production boards are driven through their
// contracts; Slack is faked; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

installNextStubs();
const load = createRequire(__filename);
// Next bundles the map's stylesheet (the Schedule page imports the map view).
load.extensions[".css"] = () => { /* stylesheet loading belongs to Next */ };
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.usePathname = () => "/schedule";
  navigation.useSearchParams = () => new URLSearchParams("");
}
const json =(b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? json({ ok: true, ts: "1", channel: { id: "D-DRILL" } }) : null));

// ---- the production boards, empty, through their contracts ----
interceptModule((r) => r === "@/lib/jobsBoard" || /src[\\/]lib[\\/]jobsBoard(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/jobsBoard");
  return { ...m, jobsBoard: async () => ({ rows: [], counts: { total: 0, late: 0, dueToday: 0, dueTomorrow: 0, oldestLateDays: null } }) };
});
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  const lanes = { late: [], today: [], review: [], upcoming: [], sending: [], held: [], finishing: [], delivered: [] };
  return { ...m, videoDeliveryBoard: async () => ({ asOf: new Date().toISOString(), lanes, counts: {}, mode: "live", connected: true }) as unknown as Awaited<ReturnType<typeof m.videoDeliveryBoard>> };
});
interceptModule((r) => r === "@/lib/reviewRoom" || /src[\\/]lib[\\/]reviewRoom(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/reviewRoom");
  return { ...m, getReviewQueue: async () => ({ pending: [], waitingOnCheck: [], waitingOnEditor: [], recentlyApproved: [], followUps: [] }) as unknown as Awaited<ReturnType<typeof m.getReviewQueue>> };
});
interceptModule((r) => r === "@/lib/opsExceptions" || /src[\\/]lib[\\/]opsExceptions(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/opsExceptions");
  return { ...m, opsExceptionsBoard: async () => m.emptyExceptionBoard() };
});
interceptModule((r) => r === "@/lib/photographerBrief" || /src[\\/]lib[\\/]photographerBrief(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/photographerBrief");
  return { ...m, briefStatusForAppointments: async (ids: string[]) => new Map(ids.map((id) => [id, { state: "off" as const, sentAt: null, ackAt: null, why: null }])) };
});

type Props = Record<string, unknown>;
function elementsNamed(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elementsNamed(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elementsNamed(part, name))];
}
const STREAMED = new Set(["ListView"]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
void elementsNamed;

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6000) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const to = await import("@/lib/timeOff");
    const od = await import("@/lib/ownerDashboard");
    const desk = await import("@/lib/officeDesk");
    const si = await import("@/lib/shootIssues");
    const { fieldFlagLoopKey } = await import("@/lib/fieldIssues");
    const { listAssignees } = await import("@/lib/assignees");
    const { etAt, etDayKey } = await import("@/lib/datetime");
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

    const T = new Date();
    const todayKey = etDayKey(T);
    const keyPlus = (k: string, n: number) => new Date(Date.parse(`${k}T12:00:00Z`) + n * D).toISOString().slice(0, 10);
    const tomorrowKey = keyPlus(todayKey, 1);
    const shootAt = etAt(tomorrowKey, 11);

    // ---- the team ----
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@oct25b.invalid`, ...extra } });
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const harrison = await tm("Harrison Wells", "PHOTOGRAPHER", { isServiceProvider: true });
    const james = await tm("James Livingston", "PHOTOGRAPHER", { creativeManager: true, isServiceProvider: true });
    const pat = await tm("Pat Partial", "PHOTOGRAPHER", { isServiceProvider: true });
    const casey = await tm("Casey Register", "PHOTOGRAPHER", { isServiceProvider: true });
    await prisma.appUser.create({ data: { name: "Kyle Smith", email: kyleTm.email!, role: "ADMIN", teamMemberId: kyleTm.id, status: "ACTIVE" } });
    await prisma.appUser.create({ data: { name: "Jordan Spackman", email: "info@realtourpilot.com", role: "OWNER", teamMemberId: jordanTm.id, status: "ACTIVE" } });
    const roster = await listAssignees();

    // ---- time off: Harrison's week (PTO), Pat's half day (PTO), Casey in the capacity register ----
    const pto = (memberId: string, entries: unknown[]) => prisma.appSetting.create({ data: { key: `pto:${memberId}:2026-09-25`, value: JSON.stringify({ v: 1, entries, log: [] }) } });
    await pto(harrison.id, [{ id: "e1", startKey: tomorrowKey, endKey: keyPlus(tomorrowKey, 4), type: "vacation", fraction: 1, note: "Week off", by: "drill", at: T.toISOString() }]);
    await pto(pat.id, [{ id: "e2", startKey: tomorrowKey, endKey: tomorrowKey, type: "personal", fraction: 0.5, note: "Half day", by: "drill", at: T.toISOString() }]);
    await prisma.capacityException.create({ data: { teamMemberId: casey.id, kind: "TIME_OFF", startsAt: etAt(tomorrowKey, 0), endsAt: etAt(keyPlus(tomorrowKey, 1), 0), recordedBy: "drill" } });

    // =====================================================================
    c.head("§1 · who is off on a shoot day (lib/timeOff)");
    // =====================================================================
    const spans = await to.timeOffBetween(todayKey, keyPlus(todayKey, 7));
    const hSpan = spans.find((s) => s.teamMemberId === harrison.id);
    c.ok("the PTO week is read, in words", !!hSpan && hSpan.fraction === 1 && hSpan.source === "pto" && /^Off \w{3} \d+ to \w{3} \d+$/.test(hSpan.words), JSON.stringify(hSpan));
    c.ok("the capacity register's time off is read too", spans.some((s) => s.teamMemberId === casey.id && s.source === "capacity"));
    c.ok("offAt: Harrison is off at his shoot, not the day after his week; nobody else is off for him", to.offAt(spans, harrison.id, shootAt)?.fraction === 1 && to.offAt(spans, harrison.id, etAt(keyPlus(tomorrowKey, 6), 11)) === null && to.offAt(spans, james.id, shootAt) === null);
    c.ok("…a half day is part of the day, not the whole of it", to.offAt(spans, pat.id, shootAt)?.fraction === 0.5);
    c.ok("…the register is timed: Casey is off tomorrow, back the day after", !!to.offAt(spans, casey.id, shootAt) && to.offAt(spans, casey.id, etAt(keyPlus(tomorrowKey, 1), 11)) === null);
    c.ok("offWords says who, in plain words", to.offWords("Harrison Wells", hSpan!).startsWith("Harrison is off that day (Off ") && to.offWords("Pat Partial", to.offAt(spans, pat.id, shootAt)!).startsWith("Pat is off part of that day"));

    // ---- the shoots ----
    const client = await prisma.client.create({ data: { name: "Nick Agent", phone: "2155550199" } });
    const shoot = async (street: string, who: string, hour = 11) => {
      const p = await prisma.project.create({ data: { clientId: client.id, title: `${street}, Allentown, PA`, addressLine: street, status: "SCHEDULED", shootDate: etAt(tomorrowKey, hour), photographerId: who } });
      const a = await prisma.appointment.create({ data: { aryeoId: `oct25b-${street}`, projectId: p.id, startAt: etAt(tomorrowKey, hour), endAt: etAt(tomorrowKey, hour + 2), status: "SCHEDULED", assignedToId: who, description: "Customer:\nName: Nick Agent\nPhone: (215) 555-0199\n\nOrder Questions:\n- Lock Box / Door Code: 1234" } });
      return { p, a };
    };
    const off = await shoot("266 Richard Dr", harrison.id, 11);
    const fine = await shoot("2031 Ruth St", james.id, 13);
    const half = await shoot("7 Half Way", pat.id, 15);

    // =====================================================================
    c.head("§2 · Jordan's dashboard: the shoot on someone who is off is blocked, counted, and the office's");
    // =====================================================================
    const prod = await od.productionHealth({ now: T, excludeClientIds: [], roster, ownerEmail: "info@realtourpilot.com" });
    const pre = prod.stages.find((s) => s.key === "pre")!;
    const item = (projectId: string) => pre.items.find((i) => i.projectId === projectId);
    c.ok("Harrison's shoot is blocked: he is off that day, and it is Kyle's move", /^Harrison is off that day \(Off /.test(item(off.p.id)?.blocked ?? "") && item(off.p.id)?.owner === "Kyle", JSON.stringify(item(off.p.id)));
    c.ok("James's shoot is not blocked", item(fine.p.id)?.blocked === null && item(fine.p.id)?.owner === "James");
    c.ok("Pat's half day is said on the shoot, never a block", item(half.p.id)?.blocked === null && /Pat is off part of that day/.test(item(half.p.id)?.what ?? ""), item(half.p.id)?.what);
    c.ok("the stage says 1 blocked, in red (the count is its list's)", pre.headline.n === 1 && pre.headline.words === "blocked" && pre.counts.blocked === pre.items.filter((i) => !!i.blocked).length && pre.tone === "bad", JSON.stringify(pre.headline));
    const b = prod.bottlenecks.find((x) => x.id === `pre:visit:${off.a.id}`);
    c.ok("a bottleneck: reassign or move it, in red, the assign seed going to the office", !!b && b.nextStep === "Reassign the shoot, or move it" && b.tone === "bad" && b.assign.assigneeKey === "kyle" && /^Reassign the shoot: 266 Richard Dr/.test(b.assign.title) && b.issue.includes("but Harrison is off that day"), JSON.stringify(b));
    const team = await od.teamCoverage({ now: T, roster, production: prod });
    const field = team.rows.find((r) => r.key === "field");
    c.ok("Team coverage: the field row names the clash, in red", !!field && field.status.startsWith("1 shoot this week booked on Harrison while off") && field.tone === "bad", JSON.stringify(field));
    c.ok("…and the workload list counts it, linking to the schedule", team.unassigned.some((u) => u.what === "Shoots booked on Harrison while off" && u.count === 1 && u.href === "/schedule"), JSON.stringify(team.unassigned));
    const weekly = await od.weeklyPerformance({ now: T, excludeClientIds: [] });
    const m = weekly.measures.find((x) => x.key === "shoots");
    c.ok("Weekly performance: 2 of 3 covered (Harrison's is not), in red, with the reason", m?.value === "2/3" && m.tone === "bad" && /1 shoot on someone who is off/.test(m.detail), JSON.stringify(m));

    // =====================================================================
    c.head("§3 · Kyle's desk: the clash first on the visit; the revision and floor plan rows");
    // =====================================================================
    // A photo revision filed from an email with no job on it (Alex's 215 Koser Rd, Sep 28).
    const rev = await prisma.smartTask.create({ data: { taskType: "revision", source: "gmail", status: "OPEN", title: "Photo revision — 215 Koser Rd, Lititz, 17543", clientId: client.id, assignedKey: "kyle", ownerId: kyleTm.id, dueAt: new Date(T.getTime() - 2 * D), dedupeKey: "03248fb81c6c56ed7a177e8a" } });
    // A floor plan ready to check, two days past the job's promise.
    const plan = await prisma.project.create({ data: { clientId: client.id, title: "30 Plan Pl, Wayne, PA", addressLine: "30 Plan Pl", status: "DELIVERED", promisedDueAt: new Date(T.getTime() - 2 * D), deliveredAt: new Date(T.getTime() - D), deliverables: { create: [{ type: "PHOTOS", label: "Photos", status: "DONE" }, { type: "FLOORPLAN", label: "Floor Plan", status: "UPLOADED" }] } } });
    await prisma.photoJob.create({ data: { projectId: plan.id, stage: "DELIVERED", slaDueAt: new Date(T.getTime() - 2 * D), deliveredAt: new Date(T.getTime() - D) } });

    const d = await desk.buildOfficeDesk({ now: T, excludeClientIds: [], person: { key: "kyle", teamMemberId: kyleTm.id, name: "Kyle" }, roster });
    const shoots = d.sections.find((s) => s.key === "shoots")!;
    const all = [...shoots.now, ...shoots.waiting, ...shoots.ok];
    const v = (apptId: string) => all.find((i) => i.id === `visit:${apptId}`);
    const hv = v(off.a.id);
    c.ok("Harrison's visit: needs Kyle now, the time off first, 'Photographer off' in red, a blocker", hv?.state === "now" && /^Harrison is off that day \(Off .+\): reassign or move the shoot/.test(hv.line) && hv.chip?.label === "Photographer off" && hv.chip.tone === "bad" && hv.rank === desk.RANK.blocker, JSON.stringify({ line: hv?.line, chip: hv?.chip, rank: hv?.rank }));
    c.ok("James's visit carries no time-off line", !!v(fine.a.id) && !/ is off /.test(v(fine.a.id)!.reason) && v(fine.a.id)!.chip?.label !== "Photographer off");
    c.ok("Pat's half day asks Kyle to check, in amber", /Pat is off part of that day .*: check they can make it/.test(v(half.a.id)?.reason ?? "") && v(half.a.id)?.chip?.tone === "warn", JSON.stringify(v(half.a.id)?.chip));
    c.ok("Today's Shoots' count is still the length of its 'now' list", shoots.count === shoots.now.length);
    const nextIsTomorrow = d.nextDay.dayKey === tomorrowKey;
    c.ok("the next business day's instructions count the clash as one to review", !nextIsTomorrow || d.nextDay.instructions.review >= 1, JSON.stringify(d.nextDay.instructions));

    const follow = d.sections.find((s) => s.key === "followups")!;
    const r = [...follow.now, ...follow.waiting].find((i) => i.id === `rev:${rev.id}`);
    c.ok("the email-only photo revision names its street and lane: '215 Koser Rd · Photo correction'", r?.title === "215 Koser Rd · Photo correction", r?.title);
    c.ok("…and it is the office's to fix, never 'Give it to the editor'", !!r && r.line === "Yours to fix · Open the photos" && !/editor/i.test(r.line), r?.line);
    const deliver = d.sections.find((s) => s.key === "deliver")!;
    const pl = [...deliver.now, ...deliver.waiting].find((i) => i.id === `media:${plan.id}`);
    c.ok("a floor plan ready to check past its promise is late (its due words already said so)", !!pl && pl.state === "now" && pl.late === true && /Floor plan ready to check/.test(pl.line) && pl.rank === desk.RANK.overdue, JSON.stringify({ line: pl?.line, late: pl?.late, rank: pl?.rank, due: pl?.dueWords }));

    // =====================================================================
    c.head("§4 · the Schedule says 'Off that day' beside the name (the office's view)");
    // =====================================================================
    const { default: schedule } = await import("@/app/schedule/page");
    const tree = await settle(await schedule({ searchParams: Promise.resolve({}) }));
    let html = "";
    try { html = renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { html = `RENDER FAILED: ${(e as Error).message}`; }
    const rows = html.split("<a ").filter((x) => x.includes("Richard Dr") || x.includes("Ruth St") || x.includes("Half Way"));
    c.ok("the schedule renders", !html.startsWith("RENDER FAILED") && rows.length === 3, html.slice(0, 200));
    c.ok("Harrison's shoot says Off that day; James's and Pat's half day do not", rows.find((x) => x.includes("Richard Dr"))?.includes("data-off-that-day") === true && rows.filter((x) => x.includes("data-off-that-day")).length === 1);

    // =====================================================================
    c.head("§5 · Kyle's shoot-flag loop clears once the job is delivered (key field-flag-<job>)");
    // =====================================================================
    const done = await prisma.project.create({ data: { clientId: client.id, title: "116 W Windsor St, Phila, PA", status: "DELIVERED", deliveredAt: T } });
    const again = await prisma.project.create({ data: { clientId: client.id, title: "8 Again Rd, Phila, PA", status: "REVISION" } });
    const loop = (projectId: string) => prisma.smartTask.create({ data: { taskType: "internal_instruction", source: "manual", status: "OPEN", assignedKey: "kyle", title: "Shoot issue — x", dedupeKey: fieldFlagLoopKey(projectId), projectId } });
    const l1 = await loop(done.id);
    const l2 = await loop(again.id);
    const closed = await si.closeShootFlagsOnDeliveredJobs(T);
    const after = await prisma.smartTask.findMany({ where: { id: { in: [l1.id, l2.id] } }, select: { id: true, status: true, summary: true } });
    const st = (id: string) => after.find((x) => x.id === id);
    c.ok("the delivered job's field-flag loop is completed, saying why", st(l1.id)?.status === "COMPLETED" && (st(l1.id)?.summary ?? "").startsWith("Closed by the hub: the job was delivered."), JSON.stringify(after));
    c.ok("a job back in revisions keeps its flag; a second pass closes nothing", st(l2.id)?.status === "OPEN" && closed.closed === 1 && (await si.closeShootFlagsOnDeliveredJobs(T)).closed === 0);

    // =====================================================================
    c.head("§6 · '/' carries no unreachable owner-only cards (the owner's home is OwnerHome)");
    // =====================================================================
    const pageSrc = fs.readFileSync(path.resolve(__dirname, "../../src/app/page.tsx"), "utf8");
    c.ok("no OwnerBusiness, OwnerMoneyLine, MoneyStat, OwnerWeekCard or ShootIssuesCard left in the page", !/function (OwnerBusiness|OwnerMoneyLine|MoneyStat|OwnerWeekSection|OwnerShootIssues)\b|OwnerWeekCard|ShootIssuesCard|PulseStrip/.test(pageSrc));
    c.ok("…and the owner still gets OwnerHome first", /if \(isOwner\) \{\s*return \(\s*<OwnerHome/.test(pageSrc));

    c.head("Nothing left the hub");
    c.ok("the fence held", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
