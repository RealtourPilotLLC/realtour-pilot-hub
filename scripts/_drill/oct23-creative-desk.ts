// ---------------------------------------------------------------------------
// DRILL: THE CREATIVE MANAGER'S DASHBOARD (Oct 23 2026, Jordan's spec §6, §7
// and the checks of §8 that apply to it).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-creative-desk.ts
//
//   §1 production: his own visits with the real prep state (Kyle's
//      confirmation, access, the daily brief, the shoot brief read, the agent
//      script, special requests); a visit whose time passed with nothing
//      recorded says exactly that (never "shot" or "uploaded"); a split job's
//      second visit stays upcoming; a complete handoff is not listed; the team
//      he supervises is apart from his own
//   §2 (#6, #7) approval: James approves ONE version from the dashboard's
//      panel action (the Review Room's approveCut); the earlier version and
//      the other video are untouched, a stale version is refused, the
//      approved one is on Kyle's Ready to send, and nothing is delivered or
//      sent; a replacement version arrives unapproved
//   §3 (#8) coaching keeps its evidence, its follow-up date and its outcome;
//      practice is assigned to a field creative, only recommended for an
//      editor (Jordan's call)
//   §4 (#9) readiness: criteria need evidence; the recommendation creates one
//      decision task for Jordan and changes NO staffing or pay record; a retry
//      creates no second task
//   §5 (#10) script ownership shows the real mode: Jordan owns (James films
//      it), James drafts (his version waits on Jordan), James owns (the
//      program owners say so); a client he has no part in is not listed
//   §6 (#13) counts equal their lists; G and H never repeat a task
//   §7 (#14) the owner's "view as James" is read-only; Kyle and Harrison are
//      refused; personnel development is the owner's and James's only
//   §8 the end-of-day check: one record per person per day, a tick completes
//      nothing
//   §9 process improvements: the shared task record, policy is Jordan's
//   §10 no money, no em dashes
//
// ISOLATION: PGlite via the shared harness, every .env key blank, AUTH_ENFORCE
// on, every outbound call fenced. The delegation workflow (built in parallel)
// is faked at its module seam with the agreed interface.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import type { DelegatedTask, DelegationState } from "../../src/lib/delegation";

installNextStubs();

// ---- after(): run eagerly, awaited before the checks that need it -------------
const pending: Promise<unknown>[] = [];
interceptModule((r) => r === "next/server", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get: (t, k) => (k === "after" ? (fn: () => unknown) => { pending.push(Promise.resolve().then(fn).catch(() => undefined)); } : t[k]),
}));
const settleAfter = async () => { while (pending.length) await pending.shift(); };

// ---- the delegation workflow, faked with the agreed interface --------------------
type AssignInput = { title: string; outcome?: string; assigneeKey: string; dueAt?: string; needsVerification?: boolean; sourceTaskId?: string; clientId?: string; projectId?: string; sourceHref?: string; note?: string };
const store = new Map<string, DelegatedTask>();
const assignCalls: AssignInput[] = [];
let failAssign = false;
const fakeActions = {
  assignTaskAction: async (input: AssignInput) => {
    assignCalls.push(input);
    if (failAssign) return { ok: false, message: "drill: the workflow refused" };
    const { prisma } = await import("@/lib/prisma");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser();
    const t = await prisma.smartTask.create({ data: { taskType: "delegated", source: "manual", status: "OPEN", title: input.title, assignedKey: input.assigneeKey, projectId: input.projectId ?? null, clientId: input.clientId ?? null, dueAt: input.dueAt ? new Date(input.dueAt) : null } });
    store.set(t.id, { taskId: t.id, title: input.title, outcome: input.outcome ?? null, assigneeKey: input.assigneeKey, assigneeName: input.assigneeKey, assignedBy: me?.email ?? null, assignedAt: new Date().toISOString(), dueAt: input.dueAt ?? null, state: "ASSIGNED", needsVerification: !!input.needsVerification, latestUpdate: input.note ?? null, blocker: null, nextStep: null, clientId: input.clientId ?? null, projectId: input.projectId ?? null, sourceHref: input.sourceHref ?? null });
    return { ok: true, message: "Assigned" };
  },
  acceptTaskAction: async (id: string) => { const t = store.get(id); if (!t) return { ok: false, message: "no task" }; t.state = "ACCEPTED"; return { ok: true, message: "Accepted" }; },
};
interceptModule((r) => r === "@/app/delegation/actions" || /src[\\/]app[\\/]delegation[\\/]actions(\.ts)?$/.test(r), (loaded) => ({ ...(loaded as object), ...fakeActions }));
interceptModule((r) => r === "@/lib/delegation" || /src[\\/]lib[\\/]delegation(\.ts)?$/.test(r), (loaded) => ({
  ...(loaded as object),
  delegationFor: async (ids: string[]) => new Map(ids.filter((id) => store.has(id)).map((id) => [id, store.get(id)!] as const)),
  tasksAssignedTo: async (key: string) => [...store.values()].filter((t) => t.assigneeKey === key),
  tasksDelegatedBy: async (email: string) => [...store.values()].filter((t) => t.assignedBy?.toLowerCase() === email.toLowerCase()),
}));

const fence = fenceFetch(async (url) => {
  if (/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url)) return new Response("abcde", { status: 200, headers: { "content-type": "video/mp4", "content-length": "5" } });
  if (url.startsWith("https://slack.com/api/")) return new Response(JSON.stringify({ ok: true, ts: "1", channel: { id: "D1" } }), { headers: { "content-type": "application/json" } });
  return null;
});

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7341), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-creative-desk" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { buildCreativeDesk } = await import("@/lib/creativeDesk");
    const actions = await import("@/app/creativeDeskActions");
    const review = await import("@/app/review/actions");
    const { etDayKey, etAt } = await import("@/lib/datetime");
    const T = new Date();
    const at = (ms: number) => new Date(T.getTime() + ms);
    const today = etDayKey(T);
    const tomorrowKey = etDayKey(at(D));
    const day = (offset: number) => etDayKey(at(offset * D));

    // ---- the cast ------------------------------------------------------------------
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@cd.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "PHOTOGRAPHER", { creativeManager: true, payType: "MONTHLY_FLAT", monthlyPay: 5000 });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER", { payPercent: 0.35 });
    const kimTm = await tm("Kim Miguel", "MANAGER");
    const login = (name: string, email: string, role: string, teamMemberId: string | null, extra: Record<string, unknown> = {}) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE", ...extra } });
    const owner = await login("Jordan Spackman", "jordan@cd.invalid", "OWNER", jordanTm.id);
    const kyle = await login("Kyle Smith", "kyle@cd.invalid", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "james@cd.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const harrison = await login("Harrison Wells", "harrison@cd.invalid", "PHOTOGRAPHER", harrisonTm.id);
    await login("Kim Miguel", "kim@cd.invalid", "EDITOR", kimTm.id, { editorKey: "kim" });
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id, coverOfferHours: 9 }) } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const me = async () => (await getCurrentUser())!;
    const desk = async () => buildCreativeDesk(await me(), { now: T });

    const client = await prisma.client.create({ data: { name: "Real Agent" } });
    const desc = (lock: string | null) => ["Customer:", "Name: Real Agent", "Phone: (215) 555-0101", "", "Order Questions:", ...(lock ? [`- Lock Box / Door Code: ${lock}`] : [])].join("\n");
    const raw = (items: string[]) => JSON.stringify({ items: items.map((title) => ({ title, is_canceled: false })) });
    const job = (title: string, extra: Record<string, unknown> = {}) => prisma.project.create({ data: { clientId: client.id, title, addressLine: title.split(",")[0], status: "SCHEDULED", photographerId: jamesTm.id, ...extra } });
    const visit = (projectId: string, start: Date, who: string, extra: Record<string, unknown> = {}) => prisma.appointment.create({ data: { aryeoId: `a-${projectId}-${start.getTime()}`, projectId, startAt: start, endAt: new Date(start.getTime() + 2 * H), status: "SCHEDULED", assignedToId: who, description: desc("4321"), rawJson: raw(["Photos", "Premium Reel"]), ...extra } });

    // =====================================================================
    c.head("§1 · my production: evidence, never the clock");
    // =====================================================================
    const tomorrow10 = etAt(tomorrowKey, 10);
    const p1 = await job("11 Upcoming Rd, Town", { scriptingId: "studio-1", scriptingStatus: "awaiting_review", deliverables: { create: [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Premium Reel", videoStyle: "premium_social_reel" }] } });
    const v1 = await visit(p1.id, tomorrow10, jamesTm.id);
    await prisma.smartTask.create({ data: { taskType: "confirmation_text", source: "system", status: "COMPLETED", title: "Confirm 11 Upcoming Rd", projectId: p1.id, assignedKey: "kyle", dueAt: new Date(tomorrow10.getTime() - D), completedAt: at(-H) } });
    await prisma.clientAsk.create({ data: { clientId: client.id, projectId: p1.id, kind: "SPECIAL_REQUEST", medium: "video", text: "Please get the pool at dusk", summary: "Pool at dusk", source: "text", askedAt: at(-2 * H), state: "OPEN" } });
    const p2 = await job("22 Past Ln, Town", { deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] } });
    await visit(p2.id, at(-2 * D), jamesTm.id);
    const p3 = await job("33 Done St, Town", { status: "EDITING", debriefSubmittedAt: at(-3 * D + 4 * H), photosHandoffAt: at(-3 * D + 4 * H), cullingConfirmedAt: at(-3 * D + 4 * H), removalNotes: "none", deliverables: { create: [{ type: "PHOTOS", label: "Photos", uploadedAt: at(-3 * D + 3 * H) }] } });
    await visit(p3.id, at(-3 * D), jamesTm.id);
    const p4 = await job("44 Split Ave, Town", { debriefSubmittedAt: at(-3 * D + 4 * H), photosHandoffAt: at(-3 * D + 4 * H), deliverables: { create: [{ type: "PHOTOS", label: "Photos", uploadedAt: at(-3 * D + 3 * H) }, { type: "VIDEO", label: "Listing Video", videoStyle: "standard_cinematic" }] } });
    await visit(p4.id, at(-3 * D), jamesTm.id);
    const v4b = await visit(p4.id, etAt(day(2), 14), jamesTm.id);
    const p5 = await job("55 Team Rd, Town", { photographerId: harrisonTm.id, deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] } });
    await visit(p5.id, at(-D), harrisonTm.id);
    await prisma.activity.create({ data: { projectId: p2.id, type: "FLAG", body: "Gate code did not work" } });

    await signIn(james);
    let d = await desk();
    const mine = d.production.mine;
    const s1 = mine.find((s) => s.id === v1.id);
    const chip = (k: string) => s1?.chips.find((x) => x.key === k);
    c.ok("his upcoming visit is listed with its time, client and services", !!s1 && s1.street === "11 Upcoming Rd" && s1.clientName === "Real Agent" && s1.services.includes("Premium Reel"), JSON.stringify(s1));
    c.ok("…Kyle's confirmation (the desk's own record): sent", chip("confirm")?.label === "Confirmation sent" && chip("confirm")?.tone === "ok");
    c.ok("…access from the order, the daily brief's state (switched off here), the shoot brief not yet read", chip("access")?.label === "Access noted" && chip("brief")?.tone === "off" && chip("read")?.label === "Shoot brief to read");
    c.ok("…the agent script from Script Studio, in words (waiting on Jordan's review: missing prep)", chip("direction")?.label === "Agent script waiting on Jordan's review" && chip("direction")?.tone === "todo");
    c.ok("…the special request, to review", s1?.requests.includes("Pool at dusk") === true && s1?.missing.some((m) => /special request/.test(m)) === true);
    c.ok("…actions open the existing pages: Open brief (/shoot/<id>), the daily brief, Script Studio", s1?.links[0]?.href === `/shoot/${p1.id}` && s1?.links.some((l) => l.href === `/shoot/brief/${tomorrowKey}`) === true);
    c.ok("a split job's second visit is upcoming (the first visit's handoff is not this visit's)", mine.some((s) => s.id === v4b.id) && !d.production.handoffs.some((h) => h.projectId === p4.id));
    const h2 = d.production.handoffs.find((h) => h.projectId === p2.id);
    c.ok("a visit whose time passed with nothing recorded: 'Nothing recorded since the visit', Upload to finish", !!h2 && /^Nothing recorded since the visit on /.test(h2.status) && h2.links[0].href === `/upload/${p2.id}`, JSON.stringify(h2));
    c.ok("…never inferred: no 'shot', no 'uploaded', no 'captured' anywhere in that row", !!h2 && !/\b(shot|uploaded|captured)\b/i.test(JSON.stringify({ s: h2.status, l: h2.lines })), JSON.stringify(h2?.lines));
    c.ok("…its capture exception (the field flag) and Flag an issue are on the row", !!h2 && h2.exceptions.some((e) => /Gate code/.test(e)) && h2.links.some((l) => l.label === "Flag an issue"));
    c.ok("a complete handoff is not listed", !d.production.handoffs.some((h) => h.projectId === p3.id));
    c.ok("the team's shoots are apart from his own (Harrison's, with his name)", d.production.team.some((h) => h.projectId === p5.id && h.photographer === "Harrison Wells" && !h.mine) && !d.production.handoffs.some((h) => h.projectId === p5.id) && !mine.some((s) => s.projectId === p5.id));
    // Today: the visit time passes and nothing is recorded: still "nothing recorded", not done.
    const p6 = await job("66 Today Ct, Town", { deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] } });
    const v6 = await visit(p6.id, new Date(Math.max(etAt(today, 0, 5).getTime(), T.getTime() - 3 * H)), jamesTm.id);
    d = await desk();
    const s6 = d.production.mine.find((s) => s.id === v6.id);
    c.ok("a visit earlier today with nothing recorded stays on today's list, saying 'Nothing recorded from the field yet'", !!s6 && s6.today && s6.chips[0]?.label === "Nothing recorded from the field yet", JSON.stringify(s6?.chips));
    await prisma.appointment.update({ where: { id: v6.id }, data: { completedAt: new Date() } });
    d = await desk();
    c.ok("…once the field records Done, it leaves the upcoming list for the handoff list", !d.production.mine.some((s) => s.id === v6.id) && d.production.handoffs.some((h) => h.projectId === p6.id));

    // =====================================================================
    c.head("§2 · #6 #7 approval: one version, into Kyle's queue, never delivered");
    // =====================================================================
    const cutJob = await prisma.project.create({ data: { clientId: client.id, title: "60 Review Rd, Town", status: "REVIEW", shootDate: at(-3 * D), promisedTargetAt: at(5 * H), deliverables: { create: { type: "VIDEO", label: "Listing Reel", quantity: 2 } } } });
    const dv = await prisma.deliverable.findFirstOrThrow({ where: { projectId: cutJob.id } });
    const mkCut = async (slot: number, round: number, status: string, extra: Record<string, unknown> = {}) => {
      const row = await prisma.reviewSubmission.create({ data: { projectId: cutJob.id, deliverableId: dv.id, slot, round, kind: "video", source: "upload", status, fileName: `s${slot}-v${round}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel", sizeBytes: 5, reviewerTeamMemberId: jamesTm.id, ...extra } });
      return prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: `/api/review/cut/${row.id}/stream`, blobUrl: `https://drillstore.public.blob.vercel-storage.com/${row.id}.mp4`, blobPathname: `${row.id}.mp4` } });
    };
    const old = await mkCut(1, 1, "CHANGES_REQUESTED", { decidedAt: at(-D), decidedBy: "James Livingston", createdAt: at(-2 * D) });
    await prisma.mediaNote.create({ data: { projectId: cutJob.id, assetUrl: old.assetUrl!, assetType: "video", timeSec: 12, lane: "EDITOR", kind: "fix", body: "Swap the opening shot", status: "OPEN", authorKey: `tm:${jamesTm.id}`, authorName: "James Livingston", editorKey: "kim", createdAt: at(-D) } });
    const v2 = await mkCut(1, 2, "PENDING", { createdAt: at(-2 * H) });
    const other = await mkCut(2, 1, "PENDING", { createdAt: at(-H) });
    d = await desk();
    const row2 = d.review.ready.find((r) => r.id === v2.id);
    c.ok("the cut ready for him names the exact version, the editor, the earlier feedback and the due time", !!row2 && row2.version === 2 && row2.editor === "Kim Miguel" && row2.priorNotes.total === 1 && !!row2.dueWords && row2.href === `/review/${cutJob.id}?cut=${v2.id}`, JSON.stringify(row2));
    c.ok("…the superseded round is not a row of its own", !d.review.ready.some((r) => r.id === old.id));
    const r = await review.approveCut(v2.id);
    await settleAfter();
    const after = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });
    c.ok("the dashboard's Approve (approveCut) approves version 2, by James", r.ok && (await after(v2.id)).status === "APPROVED" && (await after(v2.id)).decidedBy === "James Livingston", r.message);
    c.ok("…version 1 keeps its own verdict (changes requested), the other video is still waiting", (await after(old.id)).status === "CHANGES_REQUESTED" && (await after(other.id)).status === "PENDING");
    const stale = await review.approveCut(old.id);
    c.ok("…the older version cannot be approved from a stale screen", !stale.ok, stale.message);
    const { readyToSend } = await import("@/lib/readyToSend");
    const board = await readyToSend({ projectId: cutJob.id }).catch((e: Error) => ({ ready: [], error: e.message }) as unknown as Awaited<ReturnType<typeof readyToSend>>);
    c.ok("…it is on Kyle's Ready to send", board.ready.some((x) => x.submissionId === v2.id), JSON.stringify(board.ready.map((x) => x.submissionId)));
    const pj = await prisma.project.findUniqueOrThrow({ where: { id: cutJob.id }, select: { deliveredAt: true, status: true } });
    c.ok("…and approval is not delivery: no send stamp, no client release, the job not delivered", !(await after(v2.id)).sentToClientAt && !(await after(v2.id)).clientNoticeAt && !pj.deliveredAt && pj.status !== "DELIVERED", JSON.stringify(pj));
    const v3 = await mkCut(1, 3, "PENDING", { createdAt: new Date() });
    await prisma.reviewSubmission.update({ where: { id: v2.id }, data: { status: "SUPERSEDED" } });
    d = await desk();
    c.ok("a replacement version never inherits the approval: version 3 arrives waiting on review", (await after(v3.id)).status === "PENDING" && d.review.ready.some((x) => x.id === v3.id && x.version === 3));
    // A cut someone else holds, waiting past the cover window, is delayed work (not his to approve).
    const heldJob = await prisma.project.create({ data: { clientId: client.id, title: "61 Held Rd, Town", status: "REVIEW", deliverables: { create: { type: "VIDEO", label: "Listing Reel" } } } });
    const hdv = await prisma.deliverable.findFirstOrThrow({ where: { projectId: heldJob.id } });
    const held = await prisma.reviewSubmission.create({ data: { projectId: heldJob.id, deliverableId: hdv.id, slot: 1, round: 1, kind: "video", source: "upload", status: "PENDING", fileName: "h.mp4", submittedByKey: "kim", reviewerTeamMemberId: kyleTm.id, reviewerAssignedAt: at(-6 * D), createdAt: at(-6 * D) } });
    d = await desk();
    c.ok("review held by someone else past the cover window shows as delayed, with who holds it", d.review.delayed.some((x) => x.id === held.id && x.reviewer === "Kyle Smith" && x.delayed) && !d.review.ready.some((x) => x.id === held.id));
    const esc = await actions.escalateCutAction(held.id, "Is the drone shot usable?");
    const escTask = [...store.values()].find((t) => t.sourceHref === `/review/${heldJob.id}?cut=${held.id}`);
    c.ok("Escalate creates a decision task for Jordan carrying the cut; the cut stays in review", esc.ok && !!escTask && escTask.assigneeKey === "jordan" && (await after(held.id)).status === "PENDING", esc.message);

    // =====================================================================
    c.head("§3 · #8 coaching keeps evidence, follow-up date and outcome");
    // =====================================================================
    // Real evidence for Harrison: two late uploads in the KPI evidence (his upload page submitted after the deadline).
    const lateJob = async (title: string, daysAgo: number) => {
      const p = await prisma.project.create({ data: { clientId: client.id, title, addressLine: title.split(",")[0], status: "EDITING", photographerId: harrisonTm.id, shootDate: at(-daysAgo * D), debriefSubmittedAt: at(-daysAgo * D + 2 * D), photosHandoffAt: at(-daysAgo * D + 2 * D), deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] } } });
      await prisma.appointment.create({ data: { aryeoId: `late-${p.id}`, projectId: p.id, startAt: at(-daysAgo * D), endAt: at(-daysAgo * D + 2 * H), status: "SCHEDULED", assignedToId: harrisonTm.id } });
      return p;
    };
    await lateJob("70 Late Ave, Town", 9);
    await lateJob("71 Later Ave, Town", 6);
    d = await desk();
    const field = d.team?.groups.find((g) => g.key === "FIELD");
    const sig = field?.signals.find((s) => s.personId === harrisonTm.id && /Upload timing/.test(s.skill));
    c.ok("field creatives: a signal from the KPI evidence, with its examples (never a grade)", !!sig && sig.examples.length >= 1 && /KPI evidence/.test(sig.source) && !/\bscore\b|\bpoor\b|\bbad\b/i.test(`${sig.detail} ${sig.skill}`), JSON.stringify(field?.signals.map((s) => s.skill)));
    const editors = d.team?.groups.find((g) => g.key === "EDITOR");
    const qc = d.team?.groups.find((g) => g.key === "QC");
    c.ok("editors and admin QC with no evidence: an honest empty group (Kim and Kyle on the roster, no signals, no items)", !!editors && editors.people.some((p) => p.name === "Kim Miguel") && editors.signals.length === 0 && editors.items.length === 0 && !!qc && qc.people.some((p) => p.name === "Kyle Smith") && qc.signals.length === 0);
    const created = await actions.recordFeedbackAction({ group: "FIELD", personId: harrisonTm.id, signalKey: sig!.key, note: "Walked through the upload page deadlines together", standard: "Photos and notes in by midnight on the shoot day", nextAction: "Check the next three uploads", followUpDay: today });
    const item = await prisma.developmentItem.findFirstOrThrow({ where: { personId: harrisonTm.id } });
    const ev0 = JSON.parse(item.evidenceJson) as { label: string; source: string }[];
    c.ok("Record feedback from the signal: the item keeps the hub's examples as evidence, the standard and the follow-up date", created.ok && item.skill === "Upload timing" && ev0.length >= 1 && ev0.every((e) => e.source === sig!.key) && !!item.followUpAt && item.standard?.startsWith("Photos and notes") === true, created.message);
    d = await desk();
    c.ok("…the signal is now carried by the item (not shown twice)", !d.team!.groups.find((g) => g.key === "FIELD")!.signals.some((s) => s.key === sig!.key) && d.team!.groups.find((g) => g.key === "FIELD")!.items.some((i) => i.id === item.id));
    c.ok("…the follow-up due today counts in the glance, and the count is the list", d.glance.followUps === 1 && d.team!.dueIds.length === 1 && d.team!.dueIds[0] === item.id);
    const tamper = await actions.recordFeedbackAction({ group: "FIELD", personId: harrisonTm.id, signalKey: "field:made-up", note: "x x x" });
    c.ok("…evidence comes from the hub, never from the page (an unknown signal is refused)", !tamper.ok);
    const fu = await actions.recordFollowUpAction(item.id, { note: "Two of three uploads were on time", result: "not_yet", nextDay: day(7) });
    // The REAL delegation rule decides this one (audit, Oct 23 2026): through
    // the assign action a creative manager naming Harrison was a
    // recommendation to Jordan, while the screen said "assigned".
    const callsBefore = assignCalls.length;
    const prac = await actions.assignPracticeAction(item.id, { practice: "Submit the upload page before leaving the driveway", dueDay: day(5) });
    const practiceRow = await prisma.smartTask.findFirst({ where: { title: { startsWith: "Practice:" } } });
    const practiceRec = JSON.parse(practiceRow?.delegation ?? "{}") as { needsVerification?: boolean; recommended?: unknown; events?: { kind: string }[] };
    c.ok("practice for a field creative is ASSIGNED to him through the delegation workflow (his key, James as the assigner, verification on, no recommendation)", prac.ok && assignCalls.length === callsBefore && practiceRow?.assignedKey === "harrison" && practiceRow.ownerId === harrisonTm.id && practiceRow.delegatedBy === james.email.toLowerCase() && practiceRec.needsVerification === true && !practiceRec.recommended && practiceRec.events?.[0]?.kind === "assigned", `${prac.message} ${practiceRow?.assignedKey}`);
    const verify = await actions.verifyImprovementAction(item.id, { note: "Three on-time uploads in a row", exampleLabel: "71 Later Ave and the next two", exampleHref: "/upload" });
    const item2 = await prisma.developmentItem.findUniqueOrThrow({ where: { id: item.id } });
    const ev2 = JSON.parse(item2.evidenceJson) as { label: string; source: string }[];
    const log2 = JSON.parse(item2.logJson) as { kind: string; result?: string }[];
    c.ok("verify keeps every earlier example and adds what was seen; outcome and who verified recorded", verify.ok && item2.status === "VERIFIED" && ev0.every((e) => ev2.some((x) => x.label === e.label)) && ev2.some((x) => x.source === "verified") && item2.progress === "Three on-time uploads in a row" && item2.verifiedBy === "James Livingston");
    c.ok("…the log holds every step in order: created, follow-up set, follow-up (not yet), practice, verified", fu.ok && ["created", "follow_up_set", "follow_up", "practice", "verified"].every((k, i) => log2.map((l) => l.kind).indexOf(k) >= 0 && (i === 0 || log2.map((l) => l.kind).indexOf(k) > log2.map((l) => l.kind).indexOf(["created", "follow_up_set", "follow_up", "practice", "verified"][i - 1]))) && log2.some((l) => l.kind === "follow_up" && l.result === "not_yet"), JSON.stringify(log2.map((l) => l.kind)));
    const noWords = await actions.verifyImprovementAction(item.id, { note: "" });
    c.ok("…no improvement is verified without words (and a closed item takes no more)", !noWords.ok);
    // An editor: practice is only recommended (assigning work to editors is Jordan's).
    await actions.recordFeedbackAction({ group: "EDITOR", personId: kimTm.id, skill: "Caption accuracy", note: "Two captions misspelled the street", exampleLabel: "60 Review Rd version 1", exampleHref: `/review/${cutJob.id}?cut=${old.id}` });
    const kimItem = await prisma.developmentItem.findFirstOrThrow({ where: { personId: kimTm.id } });
    const before = assignCalls.length;
    const kimPractice = await actions.assignPracticeAction(kimItem.id, { practice: "Spell-check pass on every caption" });
    c.ok("an editor's practice is a RECOMMENDATION: the decision goes to Jordan, nothing is assigned to Kim", kimPractice.ok && assignCalls.length === before + 1 && assignCalls.at(-1)!.assigneeKey === "jordan" && ![...store.values()].some((t) => t.assigneeKey === "kim"), kimPractice.message);
    c.ok("…the decision task carries no personnel detail in its title (it points at the item)", assignCalls.at(-1)!.title === "Practice recommendation from James" && assignCalls.at(-1)!.sourceHref === `/development?item=${kimItem.id}`);
    c.ok("James's own observation with no hub evidence still records the example he gave", JSON.parse(kimItem.evidenceJson).some((e: { source: string; href: string | null }) => e.source === "james" && e.href?.startsWith("/review/")));

    // =====================================================================
    c.head("§4 · #9 readiness: James recommends, nothing about staffing or pay changes");
    // =====================================================================
    const snapshot = async () => JSON.stringify({
      tm: await prisma.teamMember.findMany({ orderBy: { id: "asc" } }),
      users: await prisma.appUser.findMany({ orderBy: { id: "asc" }, select: { id: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } }),
      settings: await prisma.appSetting.findMany({ where: { NOT: [{ key: { startsWith: "creative_" } }] }, orderBy: { key: "asc" }, select: { key: true, value: true } }),
      owners: await prisma.programOwnerAssignment.findMany({ orderBy: { id: "asc" } }),
      pay: [await prisma.payrollEntry.count(), await prisma.bonusAward.count(), await prisma.jobPayOverride.count(), await prisma.payoutAdjustment.count()],
      crew: await prisma.projectCrew.count(),
      seats: await prisma.reviewSubmission.findMany({ orderBy: { id: "asc" }, select: { id: true, reviewerTeamMemberId: true } }),
      appts: await prisma.appointment.findMany({ orderBy: { id: "asc" }, select: { id: true, assignedToId: true } }),
    });
    const snap0 = await snapshot();
    const start = await actions.startAssessmentAction({ personId: harrisonTm.id, track: "PREMIUM" });
    const a = await prisma.readinessAssessment.findFirstOrThrow({ where: { personId: harrisonTm.id } });
    const crit = JSON.parse(a.criteriaJson) as { key: string; label: string; source: string }[];
    c.ok("an assessment starts with the criteria that exist (the KPI terms' five), labelled as such", start.ok && crit.length === 5 && crit.every((x) => x.source === "kpi") && crit.some((x) => x.label === "Growth and ownership"));
    const noEv = await actions.saveAssessmentAction(a.id, { criteria: [{ key: crit[0].key, met: "yes", evidence: "" }], recommendation: "READY" });
    c.ok("a criterion is met or not only with evidence", !noEv.ok && /evidence/i.test(noEv.message));
    const noRec = await actions.recommendToJordanAction(a.id);
    c.ok("…and nothing goes to Jordan before a recommendation is saved", !noRec.ok);
    const saved = await actions.saveAssessmentAction(a.id, { criteria: [{ key: crit[2].key, met: "yes", evidence: "Twelve premium reels this quarter, two notes" }, { key: crit[4].key, met: "no", evidence: "Drone work still needs supervision" }], addCriterion: "Leads the agent through the premium script on site", gaps: "Drone", recommendation: "READY_WITH_SUPPORT", note: "Ready for premium with a drone partner" });
    const a2 = await prisma.readinessAssessment.findUniqueOrThrow({ where: { id: a.id } });
    const crit2 = JSON.parse(a2.criteriaJson) as { label: string; source: string }[];
    c.ok("James's own criterion is added and labelled his", saved.ok && crit2.some((x) => x.source === "james" && /premium script/.test(x.label)), saved.message);
    failAssign = true;
    const failed = await actions.recommendToJordanAction(a.id);
    const a3 = await prisma.readinessAssessment.findUniqueOrThrow({ where: { id: a.id } });
    c.ok("a failed decision task: the recommendation is recorded first and the failure said in words", !failed.ok && a3.status === "RECOMMENDED" && /Recommendation saved/.test(failed.message), failed.message);
    failAssign = false;
    const sent = await actions.recommendToJordanAction(a.id);
    const again = await actions.recommendToJordanAction(a.id);
    const decision = [...store.values()].filter((t) => t.sourceHref === `/development?assessment=${a.id}`);
    c.ok("Recommend to Jordan: ONE decision task for Jordan, a retry creates no second", sent.ok && again.ok && decision.length === 1 && decision[0].assigneeKey === "jordan", `${sent.message} / ${again.message}`);
    c.ok("…its title carries no name or verdict (it points at the assessment)", decision[0].title === "Readiness recommendation from James");
    const log3 = (JSON.parse(a3.logJson) as { note?: string }[]).filter((l) => /Recommended to Jordan/.test(l.note ?? ""));
    c.ok("…the recommendation was recorded once", log3.length === 1);
    c.ok("#9 no staffing or pay record changed: roles, logins, pay fields, seats, schedules, owners, settings all identical", (await snapshot()) === snap0);
    const locked = await actions.saveAssessmentAction(a.id, { recommendation: "READY" });
    c.ok("once with Jordan, the assessment is not edited under him", !locked.ok);
    d = await desk();
    const rv = d.readiness?.items.find((x) => x.id === a.id);
    c.ok("the dashboard shows the criteria met, his recommendation and Jordan's decision state from the task", !!rv && rv.met === 1 && rv.recommendation === "READY_WITH_SUPPORT" && rv.decision?.words === "Waiting on Jordan");
    store.get(decision[0].taskId)!.state = "COMPLETED" as DelegationState;
    store.get(decision[0].taskId)!.latestUpdate = "Approved for two premium shoots in November";
    d = await desk();
    c.ok("…and Jordan's decision, when he records it on the task", d.readiness?.items.find((x) => x.id === a.id)?.decision?.words === "Jordan decided" && /two premium shoots/.test(d.readiness?.items.find((x) => x.id === a.id)?.decision?.update ?? ""));

    // =====================================================================
    c.head("§5 · #10 script ownership shows the real mode");
    // =====================================================================
    const monthKey = today.slice(0, 7);
    const enroll = async (name: string) => {
      const cl = await prisma.client.create({ data: { name } });
      const e = await prisma.contentEnrollment.create({ data: { clientId: cl.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, status: "ACTIVE" } });
      const m = await prisma.contentMonth.create({ data: { enrollmentId: e.id, clientId: cl.id, monthKey, videosOwed: 4 } });
      return { cl, e, m };
    };
    // DEFAULT owners: Jordan holds scripts and strategy (the live rows).
    for (const duty of ["SCRIPTS", "STRATEGY"]) await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty, appUserId: owner.id, label: "Jordan Spackman", setBy: "defaults" } });
    const A = await enroll("Ann Films");
    const sessJob = await job("80 Session St, Town", { contentMonthId: A.m.id, deliverables: { create: [{ type: "VIDEO", label: "Content session", videoStyle: "personal_branding" }] } });
    await visit(sessJob.id, etAt(day(4), 9), jamesTm.id);
    await prisma.programSessionRequest.create({ data: { enrollmentId: A.e.id, clientId: A.cl.id, monthId: A.m.id, slotStart: etAt(day(4), 9), slotEnd: etAt(day(4), 11), status: "CONFIRMED", projectId: sessJob.id } });
    const B = await enroll("Ben Drafts");
    const scr = await prisma.contentScript.create({ data: { enrollmentId: B.e.id, clientId: B.cl.id, monthId: B.m.id, title: "Why spring listings move", body: "x", status: "INTERNAL_REVIEW" } });
    await prisma.contentScriptVersion.create({ data: { scriptId: scr.id, enrollmentId: B.e.id, clientId: B.cl.id, versionNo: 1, title: "Why spring listings move", hook: "h", pointsJson: "[]", close: "c", body: "x", source: "MANUAL", status: "DRAFT", createdBy: "James@cd.invalid" } });
    const C = await enroll("Cara Owns");
    await prisma.programOwnerAssignment.create({ data: { scope: "ENROLLMENT", scopeRef: C.e.id, duty: "SCRIPTS", appUserId: james.id, label: "James Livingston", setBy: "jordan@cd.invalid" } });
    const Dn = await enroll("Dana Elsewhere");
    d = await desk();
    const prep = (cid: string) => d.prep.items.find((p) => p.kind === "monthly" && p.clientName === cid);
    const pa = prep("Ann Films"), pb = prep("Ben Drafts"), pc = prep("Cara Owns");
    c.ok("Jordan owns, James films the session: production input, deadline tied to the session", pa?.mode === "JORDAN_OWNS" && pa.writer === "Jordan" && pa.approver === "Jordan" && /film the session/.test(pa.role) && /session/.test(pa.deadlineWords ?? ""), JSON.stringify(pa));
    c.ok("James drafts, Jordan approves: from the version James wrote", pb?.mode === "JAMES_DRAFTS" && pb.writer === "James" && pb.approver === "Jordan", JSON.stringify(pb));
    c.ok("James owns: the program owners name him for this client", pc?.mode === "JAMES_OWNS" && pc.approver === "James" && /assigned to you/.test(pc.source), JSON.stringify(pc));
    c.ok("a client he has no part in is not listed (nothing moves to him in bulk)", !d.prep.items.some((p) => p.clientName === "Dana Elsewhere") && !!Dn);
    const listing = d.prep.items.find((p) => p.key === `listing:${p1.id}`);
    c.ok("a listing script (Script Studio) is Jordan's, James contributes production input, deadline the shoot", listing?.mode === "JORDAN_OWNS" && /film it/.test(listing.role) && /^Shoot /.test(listing.deadlineWords ?? "") && /waiting on Jordan's review/.test(listing.status));
    c.ok("links go to discovery and strategy, preferences, prior scripts", !!pa && ["Scripts", "Discovery and strategy", "Preferences"].every((l) => pa.links.some((x) => x.label === l && x.href.startsWith(`/content/${A.e.id}`))));
    c.ok("reading ownership wrote nothing (no default rows minted)", (await prisma.programOwnerAssignment.count()) === 3);

    // =====================================================================
    c.head("§9 · process improvements: the shared task record");
    // =====================================================================
    const imp = await actions.addImprovementAction({ problem: "Upload pages arrive without creative notes", area: "Uploads and handoffs", nextStep: "Draft the notes checklist", outcome: "Every upload has notes", policy: false });
    const pol = await actions.addImprovementAction({ problem: "Shot list standard for premium reels", area: "Shot lists", nextStep: "Write the room order", outcome: "One standard", policy: true });
    const impTask = await prisma.smartTask.findFirstOrThrow({ where: { taskType: "process_improvement", summary: "Upload pages arrive without creative notes" } });
    const polTask = await prisma.smartTask.findFirstOrThrow({ where: { taskType: "process_improvement", summary: "Shot list standard for premium reels" } });
    c.ok("an improvement is one SmartTask (problem, owner James), its next step and outcome beside it", imp.ok && pol.ok && impTask.assignedKey === "james" && !!(await prisma.appSetting.findUnique({ where: { key: `creative_improvement:${impTask.id}` } })));
    const assignedTask = await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", title: "Prepare a coaching plan", assignedKey: "james", dueAt: at(-H), flaggedBy: "Jordan" } });
    d = await desk();
    c.ok("G lists the improvements; H lists his other tasks and never repeats an improvement", d.improvements.items.some((i) => i.taskId === impTask.id && i.nextStep === "Draft the notes checklist" && i.owner === "James") && d.assigned.items.some((t) => t.taskId === assignedTask.id) && !d.assigned.items.some((t) => t.taskId === impTask.id || t.taskId === polTask.id));
    const polFinish = await actions.finishImprovementAction(polTask.id, "Done");
    c.ok("a policy change is not finished by James (Jordan approves it)", !polFinish.ok && (await prisma.smartTask.findUniqueOrThrow({ where: { id: polTask.id } })).status === "OPEN");
    const askJ = await actions.askJordanImprovementAction(polTask.id);
    c.ok("…Ask Jordan sends it to him as a decision", askJ.ok && [...store.values()].some((t) => t.assigneeKey === "jordan" && /Approve a process change/.test(t.title)));
    const fin = await actions.finishImprovementAction(impTask.id, "Notes checklist live on the upload page");
    c.ok("a non-policy improvement finishes with its outcome", fin.ok && (await prisma.smartTask.findUniqueOrThrow({ where: { id: impTask.id } })).status === "COMPLETED");

    // =====================================================================
    c.head("§6 · #13 counts equal their lists; one row per task");
    // =====================================================================
    d = await desk();
    c.ok("glance: shoots today = today's rows in My Production", d.glance.shoots === d.production.mine.filter((s) => s.today).length);
    c.ok("glance: reviews ready = the Creative Review list", d.glance.reviews === d.review.ready.length && d.glance.reviews! >= 1);
    c.ok("glance: coaching follow-ups due = the due items", d.glance.followUps === d.team!.dueIds.length);
    c.ok("glance: urgent = the urgent rows in Assigned to Me (the overdue task)", d.glance.urgent === d.assigned.items.filter((x) => x.urgent).length && d.assigned.items.find((x) => x.taskId === assignedTask.id)?.urgent === true);
    c.ok("the glance line never says nothing needs him while items exist", !/Nothing due/.test(d.glance.line) && /ready for your review/.test(d.glance.line));
    const ids = [...d.assigned.items.map((x) => x.taskId), ...d.improvements.items.map((x) => x.taskId)];
    c.ok("no task appears twice across the sections", new Set(ids).size === ids.length);
    // Delegated work assigned to James shows with who assigned it and its state, and Accept works.
    await signIn(owner);
    // Due later TODAY (ET) whatever the hour the drill runs: after 9 PM, three hours on is tomorrow.
    await fakeActions.assignTaskAction({ title: "Review a client's creative concern", assigneeKey: "james", dueAt: new Date(Math.min(at(3 * H).getTime(), etAt(today, 23, 58).getTime())).toISOString(), outcome: "A recovery plan" });
    await signIn(james);
    d = await desk();
    const del = d.assigned.items.find((x) => x.title === "Review a client's creative concern");
    c.ok("H: a delegated task shows who assigned it, its outcome, its due time and 'Awaiting acceptance'", !!del && del.delegated && del.assignedBy === "Jordan" && del.outcome === "A recovery plan" && del.stateWords === "Awaiting acceptance" && del.urgent, JSON.stringify(del));

    // =====================================================================
    c.head("§8 · the end-of-day check: a record per person per day, a tick completes nothing");
    // =====================================================================
    const openTasks = async () => JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, completedAt: true } }));
    const tasksBefore = await openTasks();
    const tick = await actions.creativeCloseoutTickAction(today, "reviews", true);
    const rec = await prisma.appSetting.findUnique({ where: { key: `creative_closeout:james:${today}` } });
    c.ok("a tick is stored per person per ET day, with who and when", tick.ok && !!rec && JSON.parse(rec.value).ticks.reviews.by === "James Livingston");
    c.ok("…and completes no task", (await openTasks()) === tasksBefore);
    d = await desk();
    c.ok("…the line reads done while the cuts still wait (the tick documents, it does not resolve)", d.closeout.lines.find((l) => l.key === "reviews")?.done === true && d.review.ready.length >= 1);
    const yesterday = await actions.creativeCloseoutTickAction(day(-1), "reviews", true);
    c.ok("only today's check can change", !yesterday.ok);

    // =====================================================================
    c.head("§7 · #14 permissions and the read-only preview");
    // =====================================================================
    await signIn(owner, james.id);
    const pv = await desk();
    c.ok("the owner previewing James sees his dashboard, marked read-only", pv.readOnly && pv.person.first === "James" && !!pv.team);
    const counts0 = JSON.stringify([await prisma.developmentItem.count(), await prisma.readinessAssessment.count(), await prisma.smartTask.count(), await prisma.appSetting.count(), store.size]);
    const refusals = await Promise.all([
      actions.creativeCloseoutTickAction(today, "coaching", true),
      actions.recordFeedbackAction({ group: "FIELD", personId: harrisonTm.id, skill: "x", note: "preview write" }),
      actions.startAssessmentAction({ personId: harrisonTm.id, track: "INDEPENDENT" }),
      actions.addImprovementAction({ problem: "preview write here", area: "Shot lists" }),
      actions.escalateCutAction(v3.id, "preview write"),
      review.approveCut(v3.id),
    ]);
    c.ok("…every write is refused in the preview (closeout, coaching, readiness, improvements, escalate, approve)", refusals.every((x) => !x.ok), refusals.map((x) => x.message).join(" | "));
    c.ok("…and nothing was written", JSON.stringify([await prisma.developmentItem.count(), await prisma.readinessAssessment.count(), await prisma.smartTask.count(), await prisma.appSetting.count(), store.size]) === counts0 && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v3.id } })).status === "PENDING");
    await signIn(kyle);
    const ky = await actions.recordFeedbackAction({ group: "FIELD", personId: harrisonTm.id, skill: "x", note: "office write" });
    const kd = await buildCreativeDesk(await me(), { now: T });
    c.ok("Kyle (the office) is refused, and his build of this desk has no team development", !ky.ok && kd.team === null && kd.readiness === null);
    await signIn(harrison);
    const hy = await actions.startAssessmentAction({ personId: harrisonTm.id, track: "PREMIUM" });
    c.ok("Harrison is refused (personnel development is the owner's and James's)", !hy.ok);
    const { developmentSeat } = await import("@/lib/teamDevelopment");
    c.ok("the seat: owner yes, creative manager yes, office no, photographer no", await developmentSeat({ role: "OWNER", teamMemberId: null }) && await developmentSeat({ role: "CREATIVE_MANAGER", teamMemberId: jamesTm.id }) && !(await developmentSeat({ role: "ADMIN", teamMemberId: kyleTm.id })) && !(await developmentSeat({ role: "PHOTOGRAPHER", teamMemberId: harrisonTm.id })));

    // =====================================================================
    c.head("§10 · no money, no em dashes");
    // =====================================================================
    await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", title: "Quote the $450 premium add-on — then confirm", assignedKey: "james" } });
    await signIn(james);
    d = await desk();
    const blob = JSON.stringify(d);
    c.ok("no figure reaches James (a typed $450 is scrubbed), and no pay field is in the data", !/\$\d/.test(blob) && !/monthlyPay|payPercent|\b5,?000\b/.test(blob), (blob.match(/.{60}(\$\d|monthlyPay|payPercent|\b5,?000\b).{60}/) ?? [""])[0]);
    c.ok("no em dashes in anything the dashboard shows", !/[—]/.test(blob));

    c.ok("nothing left the box", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { quiet.restore?.(); fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
