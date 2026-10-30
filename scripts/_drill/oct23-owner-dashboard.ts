// Oct 23 2026: JORDAN'S DASHBOARD, the data (lib/ownerDashboard, lib/ownerWork,
// lib/meetingPrep). Held against the spec's checks that belong to it:
//   4  a new actionable email reopens the relevant work
//   5  Calendly reschedules and cancellations update the prep task (faked Calendly)
//   11 a missing integration shows an honest unavailable state
//   12 financial figures reconcile to their stated sources and periods
//   13 counts match the underlying records
// plus the house rules: unknown money is never $0, AI-read dissatisfaction is a
// "suggested" flag, capacity is never guessed, every weekly measure states its
// period and source. The production boards are driven through their own
// contracts (jobsBoard, videoDeliveryBoard, getReviewQueue, the exceptions
// board), the photo queue and the rest are real. Disposable PGlite; Calendly
// and Slack are fakes; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import { makeFakeCalendly } from "./_fake-calendly";
import type { VideoRow } from "../../src/lib/videoDelivery";
import type { JobRow } from "../../src/lib/jobsBoard";

installNextStubs();
const calendly = makeFakeCalendly();
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://slack.com/api/")) return url.includes("conversations.open") ? json({ ok: true, channel: { id: "D-DRILL" } }) : json({ ok: true, ts: "1" });
  return calendly.handle(url, init);
});

// ---- the production boards, through their contracts ----
let jobRows: JobRow[] = [];
let videoLanes: Record<string, VideoRow[]> | null = null;
let reviewPending: unknown[] = [];
let exceptionRows: unknown[] = [];
interceptModule((r) => r === "@/lib/jobsBoard" || /src[\\/]lib[\\/]jobsBoard(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/jobsBoard");
  return { ...m, jobsBoard: async () => ({ rows: jobRows, counts: { total: jobRows.length, late: jobRows.filter((j) => j.late).length, dueToday: 0, dueTomorrow: 0, oldestLateDays: null } }) };
});
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  return { ...m, videoDeliveryBoard: async () => ({ asOf: new Date().toISOString(), lanes: videoLanes ?? {}, counts: {}, mode: "live", connected: true, unavailable: !videoLanes }) };
});
interceptModule((r) => r === "@/lib/reviewRoom" || /src[\\/]lib[\\/]reviewRoom(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/reviewRoom");
  return { ...m, getReviewQueue: async () => ({ pending: reviewPending, waitingOnCheck: [], waitingOnEditor: [], recentlyApproved: [], followUps: [] }) };
});
interceptModule((r) => r === "@/lib/opsExceptions" || /src[\\/]lib[\\/]opsExceptions(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/opsExceptions");
  return { ...m, opsExceptionsBoard: async () => ({ ...m.emptyExceptionBoard(), rows: exceptionRows }) };
});

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5942), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-owner-dashboard" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const od = await import("@/lib/ownerDashboard");
    const ow = await import("@/lib/ownerWork");
    const prep = await import("@/lib/meetingPrep");
    const A = await import("@/app/delegation/actions");
    const lib = await import("@/lib/delegation");
    const { etDayKey, etAt } = await import("@/lib/datetime");
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));
    const T = new Date();
    const money = (s: string) => /\$\d/.test(s);

    // ---- the team ----
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@dash.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true, slackId: "UKYLE" });
    const user = (name: string, email: string, role: string, teamMemberId: string | null) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await user("Jordan Spackman", "info@realtourpilot.com", "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "kyle@dash.invalid", "ADMIN", kyleTm.id);
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

    // =====================================================================
    c.head("§1 · money: unknown is never $0 (#11, #12)");
    // =====================================================================
    let f = await od.financialPosition({ now: T });
    const fig = (k: string) => f.figures.find((x) => x.key === k)!;
    c.ok("#11 no bank tagged Business: cash is 'Not connected', no number", fig("cash").value === null && fig("cash").display === "Not connected" && !money(fig("cash").display), fig("cash").display);
    c.ok("#11 no fixed pay and no recurring costs on record: obligations 'Not recorded', no number", fig("obligations").value === null && fig("obligations").display === "Not recorded", fig("obligations").display);
    c.ok("#11 no revenue source ever synced: MTD profit 'Not connected' (a never-synced rail is not a $0 month)", fig("profit").value === null && fig("profit").display === "Not connected", `${fig("profit").display} · ${fig("profit").sub}`);
    c.ok("…the forecast says it can't forecast, and why", fig("forecast").value === null && /Needs a bank balance/.test(fig("forecast").sub));
    c.ok("…every unknown figure is a word, never '$0'", f.figures.filter((x) => x.value === null).every((x) => !money(x.display)));

    // The books start: a business account, a Stripe sale, a categorized cost, fixed pay, unpaid work.
    const item = await prisma.plaidItem.create({ data: { itemId: "item-drill", accessTokenEncrypted: "x", lastSyncedAt: new Date(T.getTime() - H) } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "acct-biz", name: "Business Checking", mask: "3002", type: "depository", currentBalance: 1200, isBusiness: true } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "acct-personal", name: "Personal", mask: "0942", type: "depository", currentBalance: 99999, isBusiness: false } });
    const monthDay = new Date(etAt(`${etDayKey(T).slice(0, 7)}-01`, 12).getTime());
    await prisma.stripeTransaction.create({ data: { id: "txn_drill_1", type: "charge", gross: 2500, fee: 75, net: 2425, createdAt: new Date(Math.max(monthDay.getTime(), T.getTime() - 2 * H)) } });
    await prisma.plaidTransaction.create({ data: { id: "ptx-1", accountId: "acct-biz", amount: 400, date: new Date(Math.max(monthDay.getTime(), T.getTime() - 2 * H)), name: "AutoHDR", financeKind: "BUSINESS", financeCategory: "Editing" } });
    await tm("James Livingston", "MANAGER", { creativeManager: true });
    await tm("Harrison Wells", "PHOTOGRAPHER");
    const client = await prisma.client.create({ data: { name: "Real Agent", email: "agent@client.example", phone: "2155550101" } });
    await prisma.project.create({ data: { clientId: client.id, title: "1 Unpaid Ln, Town", status: "DELIVERED", deliveredAt: new Date(T.getTime() - 5 * D), balanceAmount: 75_000, orderedAt: new Date(T.getTime() - 9 * D) } });
    const paidClient = await prisma.client.create({ data: { name: "Paid Elsewhere" } });
    await prisma.project.create({ data: { clientId: paidClient.id, title: "2 Paid Rd, Town", status: "DELIVERED", deliveredAt: new Date(T.getTime() - 5 * D), balanceAmount: 30_000, orderedAt: new Date(T.getTime() - 9 * D) } });
    await prisma.qboTransaction.create({ data: { qboId: "qbo-pay-1", type: "Payment", amount: 300, txnDate: new Date(T.getTime() - 2 * D), customerName: "Paid Elsewhere" } as never });
    f = await od.financialPosition({ now: T });
    c.ok("#12 cash = the Business-tagged depository accounts only (the personal account is left out), named with its sync time", fig("cash").value === 1200 && /3002/.test(fig("cash").sub) && !/0942/.test(fig("cash").sub) && /synced/.test(fig("cash").sub), `${fig("cash").value} · ${fig("cash").sub}`);
    const { fixedPayment, FIXED_PAY } = await import("@/lib/payStructure");
    const perPayday = fixedPayment(FIXED_PAY.james).total + fixedPayment(FIXED_PAY.harrison).total;
    // A payday that is today reads "fixed pay today (…; may already be out of the bank)".
    const paydays = (fig("obligations").sub.match(/fixed pay (?:today|[A-Z][a-z]{2} \d+)/g) ?? []).length;
    c.ok("#12 obligations = fixed team pay on the paydays inside 14 days (the pay terms' own figures), labelled 'recorded only'", paydays >= 1 && Math.abs((fig("obligations").value ?? 0) - perPayday * paydays) < 0.01 && /Recorded only/.test(fig("obligations").sub), `${fig("obligations").value} = ${perPayday} × ${paydays} · ${fig("obligations").sub}`);
    c.ok("#12 expected collections = the unpaid delivered work, minus the one QuickBooks already shows paid (never counted twice)", fig("collections").value === 750 && /1 more look paid in QuickBooks/.test(fig("collections").sub), `${fig("collections").value} · ${fig("collections").sub}`);
    c.ok("#12 the forecast is cash + collections − obligations, labelled a forecast", fig("forecast").tag === "forecast" && Math.abs((fig("forecast").value ?? 0) - (1200 + 750 - (fig("obligations").value ?? 0))) < 0.01, `${fig("forecast").value}`);
    const { revenueByProcessor } = await import("@/lib/bookkeeping");
    const { categoryBreakdown } = await import("@/lib/financeCategories");
    const mk = `${etDayKey(T).slice(0, 7)}-01`;
    const rv = await revenueByProcessor(mk, etDayKey(T));
    const sp = await categoryBreakdown(mk, etDayKey(T));
    c.ok("#12 MTD profit = processor revenue (Stripe $2,500 + QuickBooks $300) − categorized business spend ($400 + $75 Stripe fees): Finance's own engine, labelled provisional", fig("profit").value === 2325 && rv.total - sp.businessTotal === 2325 && fig("profit").tag === "provisional" && /Revenue \$2,800/.test(fig("profit").sub), `${fig("profit").value} · ${fig("profit").sub}`);
    c.ok("#12 period, sources and freshness are stated, and the gaps are listed", /Month to date/.test(f.period) && /Plaid/.test(f.sources) && /Bank/.test(f.freshness) && f.limitations.some((l) => /Card payments, editor invoices/.test(l)) && f.limitations.some((l) => /Stripe's balance/.test(l)));

    // =====================================================================
    c.head("§2 · production: each stage's count is its list (#13)");
    // =====================================================================
    const p = (title: string, extra: Record<string, unknown> = {}) => prisma.project.create({ data: { clientId: client.id, title, status: "EDITING", ...extra } });
    const pUpcoming = await p("10 Shoot Ave, Town", { status: "SCHEDULED" });
    const pAssigned = await p("11 Covered Ct, Town", { status: "SCHEDULED", photographerId: kyleTm.id });
    await prisma.appointment.create({ data: { aryeoId: "ap-1", projectId: pUpcoming.id, startAt: new Date(T.getTime() + 3 * H), endAt: new Date(T.getTime() + 5 * H), status: "SCHEDULED" } });
    await prisma.appointment.create({ data: { aryeoId: "ap-2", projectId: pAssigned.id, startAt: new Date(T.getTime() + 4 * H), endAt: new Date(T.getTime() + 6 * H), status: "SCHEDULED", assignedToId: kyleTm.id } });
    const pRaw = await p("20 Raw St, Town", { shootDate: new Date(T.getTime() - D), photographerId: kyleTm.id });
    const pLate = await p("30 Late Rd, Town");
    const pReview = await p("40 Review Way, Town");
    const pSend = await p("50 Send Blvd, Town");
    const pNoEditor = await p("60 Nobody Ln, Town");
    const pPhotos = await p("70 Photo Pl, Town");
    await prisma.photoJob.create({ data: { projectId: pPhotos.id, stage: "EDITING", slaDueAt: new Date(T.getTime() - 2 * H) } });
    jobRows = [
      { projectId: pRaw.id, street: "20 Raw St", client: "Real Agent", dueISO: new Date(T.getTime() - H).toISOString(), dueWords: "1 h late", late: true, dueToday: false, photos: { label: "Not uploaded", tone: "waiting" }, video: null, requests: { open: 0, photo: 0, video: 0, needsOwner: 0 }, monthly: false, href: `/projects/${pRaw.id}` },
      { projectId: pLate.id, street: "30 Late Rd", client: "Real Agent", dueISO: new Date(T.getTime() - 30 * H).toISOString(), dueWords: "late", late: true, dueToday: false, photos: null, video: { label: "Changes · John", tone: "late" }, requests: { open: 0, photo: 0, video: 0, needsOwner: 0 }, monthly: false, href: `/projects/${pLate.id}` },
    ];
    const vrow = (o: Partial<VideoRow> & { key: string; projectId: string; street: string; lane: VideoRow["lane"] }) => ({ submissionId: null, clientName: "Real Agent", label: "Listing video", round: 2, stage: "Editing", cutStatus: null, sinceISO: new Date(T.getTime() - 40 * H).toISOString(), promiseISO: null, promiseWords: "", late: false, dueToday: false, lateHours: null, approvedAtISO: null, deliveredAtISO: null, deliveredBy: null, push: null, heldWhy: null, reviewHref: null, aryeoUrl: null, waitingSinceISO: null, send: null, heldRender: null, ...o }) as VideoRow;
    videoLanes = {
      late: [vrow({ key: "v-late", projectId: pLate.id, street: "30 Late Rd", lane: "late", cutStatus: "CHANGES_REQUESTED", promiseISO: new Date(T.getTime() - 30 * H).toISOString(), late: true, lateHours: 30 })],
      today: [], upcoming: [], held: [], finishing: [], delivered: [],
      review: [vrow({ key: "v-review", projectId: pReview.id, street: "40 Review Way", lane: "review", cutStatus: "PENDING", promiseISO: new Date(T.getTime() + 20 * H).toISOString() })],
      sending: [vrow({ key: "v-send", projectId: pSend.id, street: "50 Send Blvd", lane: "sending", cutStatus: "APPROVED", approvedAtISO: new Date(T.getTime() - 2 * H).toISOString(), waitingSinceISO: new Date(T.getTime() - 2 * H).toISOString(), promiseISO: new Date(T.getTime() + 5 * D).toISOString() })],
    };
    reviewPending = [{ id: "cut-1", projectId: pReview.id, street: "40 Review Way", clientName: "Real Agent", round: 1, fileName: "v1.mp4", editorName: "John Mark", createdAt: new Date(T.getTime() - 26 * H).toISOString(), reviewer: { id: "x", name: "James Livingston" } }];
    exceptionRows = [{ id: "ex-1", kind: "unassigned", severity: "high", title: "60 Nobody Ln", why: "A video is owed and no editor holds it", owner: "Kyle", nextAction: "Assign an editor", href: `/projects/${pNoEditor.id}`, ageDays: 2 }];
    let h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    const stage = (k: string) => h.stages.find((s) => s.key === k)!;
    c.ok("#13 every stage: total, overdue, due soon and blocked are counts of its own rows", h.stages.every((s) => s.counts.total === s.items.length && s.counts.overdue === s.items.filter((i) => i.late).length && s.counts.blocked === s.items.filter((i) => !!i.blocked).length && s.counts.dueSoon === s.items.filter((i) => !i.late && i.dueSoon).length), h.stages.map((s) => `${s.key}:${s.items.length}/${s.counts.total}`).join(" "));
    // Jordan's Loom, Oct 27 2026, 2:52: "I don't care about the shoots coming up, I care about the stuff coming up that the shoots require."
    c.ok("pre-production: only what the shoots need; the shoot with no photographer is blocked (headline '1 blocked'), owner Kyle; the covered shoot is not listed", stage("pre").items.length === 1 && stage("pre").headline.n === 1 && stage("pre").headline.words === "blocked" && stage("pre").items.find((i) => i.projectId === pUpcoming.id)?.owner === "Kyle" && !stage("pre").items.some((i) => i.projectId === pAssigned.id), JSON.stringify(stage("pre").items.map((i) => [i.street, i.owner, i.blocked])));
    c.ok("capture & upload: the shot job with no raws, late, the photographer's move", stage("capture").items.length === 1 && stage("capture").items[0].late && stage("capture").items[0].owner === "Kyle" && stage("capture").headline.words === "missing upload");
    const ed = stage("editing").items;
    c.ok("editing: the late video with John (the board's chip), the job nobody edits (blocked), AutoHDR's late photo edit", ed.some((i) => i.projectId === pLate.id && i.owner === "John" && i.late) && ed.some((i) => i.projectId === pNoEditor.id && i.blocked === "No editor assigned") && ed.some((i) => i.projectId === pPhotos.id && i.owner === "AutoHDR" && i.late), JSON.stringify(ed.map((i) => [i.street, i.owner, i.late, i.blocked])));
    c.ok("review: the cut waiting on James, oldest wait from the upload (26h)", stage("review").items.length === 1 && stage("review").items[0].owner === "James" && stage("review").oldestWaitHours === 26 && stage("review").nextOwner === "James", `${stage("review").oldestWaitHours}`);
    c.ok("delivery: the approved video, Kyle's to send (approved is not delivered)", stage("delivery").items.length === 1 && stage("delivery").items[0].owner === "Kyle" && /approved, ready to send/.test(stage("delivery").items[0].what));
    c.ok("shoot punctuality is said apart from delivery, and honestly (it isn't measured)", /isn't measured/.test(h.punctuality));
    const b = (pid: string) => h.bottlenecks.find((x) => x.assign.projectId === pid);
    c.ok("bottlenecks: unowned work first (no photographer, no editor), then late work; each with an owner and a next step", h.bottlenecks.length >= 4 && h.bottlenecks.slice(0, 2).map((x) => x.nextStep).sort().join(",") === "Assign a photographer,Assign an editor" && b(pNoEditor.id)?.nextStep === "Assign an editor" && b(pLate.id)?.nextStep === "Recovery plan and new ETA", h.bottlenecks.map((x) => `${x.issue} → ${x.owner}/${x.nextStep}`).join(" | "));
    c.ok("…a late job says whether the client was updated since the promise passed", b(pLate.id)?.clientUpdate === "Client update due");
    await prisma.commLog.create({ data: { clientId: client.id, clientName: client.name, channel: "text", direction: "out", source: "openphone", contactName: "Us", body: "Your video is a day behind, new ETA tomorrow 5 PM", occurredAt: new Date(T.getTime() - H) } });
    await signIn(owner);
    const rec = await A.assignTaskAction({ ...b(pLate.id)!.assign, assigneeKey: "kyle", title: b(pLate.id)!.assign.title });
    h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    c.ok("…once someone has it, the row says who and how far along (and the client update given)", rec.ok && /Kyle has it · assigned/.test(b(pLate.id)?.handledBy?.words ?? "") && /Client updated/.test(b(pLate.id)?.clientUpdate ?? "") && !!b(pLate.id)?.taskId, `${b(pLate.id)?.handledBy?.words} · ${b(pLate.id)?.clientUpdate}`);
    const again = await A.assignTaskAction({ ...b(pLate.id)!.assign, assigneeKey: "kyle" });
    c.ok("…and pressing Assign on it again is the same task (one canonical)", again.ok && /Already with Kyle/.test(again.message));
    videoLanes = null;
    h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    c.ok("#11 the video board down: named as unavailable, never an empty all-clear", h.unavailable.includes("the video board") && stage("review").items.length === 1, h.unavailable.join(", "));

    // =====================================================================
    c.head("§3 · client issues (AI reads are suggested flags)");
    // =====================================================================
    await prisma.clientIssue.create({ data: { clientId: client.id, source: "call", title: "Wrong photos delivered", whatHappened: "The kitchen photos were from another listing", state: "OPEN", dueAt: new Date(T.getTime() - H), ownerName: "Kyle", ownerKey: "kyle", createdBy: "Jordan" } as never });
    const pFb = await p("80 Feedback Dr, Town");
    await prisma.feedback.create({ data: { projectId: pFb.id, body: "Honestly a bit disappointed with how long this took", source: "email", sentimentAuto: "NEGATIVE" } });
    await prisma.revisionBrief.create({ data: { projectId: pLate.id, source: "text", originalText: "Make the music calmer", requestedByKind: "CLIENT", createdAt: new Date(T.getTime() - 3 * D) } });
    await prisma.revisionBrief.create({ data: { projectId: pLate.id, source: "email", originalText: "Still too loud, and swap the opening shot", requestedByKind: "CLIENT", createdAt: new Date(T.getTime() - D) } });
    const ci = await od.clientIssuesSection({ now: T });
    const complaint = ci.rows.find((r) => r.kind === "complaint");
    c.ok("an open complaint past its correction date: high, its owner, its next action and deadline", complaint?.severity === "high" && complaint.owner === "Kyle" && complaint.nextAction === "Correct it" && !!complaint.deadlineISO && complaint.suggested === false, JSON.stringify(complaint && [complaint.severity, complaint.severityWhy]));
    const sug = ci.rows.find((r) => r.kind === "feedback");
    c.ok("feedback the classifier read as negative is a SUGGESTED flag for review, never a fact", sug?.suggested === true && sug.title === "Possible dissatisfaction" && /classifier/.test(sug.evidence), JSON.stringify(sug && [sug.title, sug.evidence]));
    const rev = ci.rows.find((r) => r.kind === "revisions");
    c.ok("repeated revisions on one job show as their own pattern", rev?.projectId === pLate.id && /2 revision rounds/.test(rev.title), rev?.title ?? "none");
    c.ok("the most serious come first", ci.rows[0]?.severity === "high");

    // =====================================================================
    c.head("§4 · team coverage (no capacity guesses)");
    // =====================================================================
    const jamesTm = await prisma.teamMember.findFirst({ where: { name: "James Livingston" } });
    await prisma.appUser.create({ data: { name: "James Livingston", email: "james@dash.invalid", role: "CREATIVE_MANAGER", teamMemberId: jamesTm!.id, status: "ACTIVE" } });
    const tomorrowKey = etDayKey(new Date(T.getTime() + D));
    await prisma.appSetting.create({ data: { key: `pto:${jamesTm!.id}:2026`, value: JSON.stringify({ v: 1, entries: [{ id: "e1", startKey: tomorrowKey, endKey: tomorrowKey, type: "vacation", fraction: 1, note: "", by: "Jordan", at: T.toISOString() }], log: [] }) } });
    const team = await od.teamCoverage({ now: T, includeTest: true, production: h });
    c.ok("time off on record shows on the person's row (PTO)", team.timeOff.some((o) => o.name === "James" && /Off/.test(o.words)), JSON.stringify(team.timeOff));
    // Oct 30 2026: no acceptance step, so nothing waits on it.
    c.ok("#13 nothing is 'awaiting acceptance' any more (assigned is the assignee's)", team.awaitingAcceptance.length === 0 && (await lib.openDelegations()).every((d) => d.state !== "ASSIGNED"));
    c.ok("the office row names Kyle and the shoot with no photographer; capacity is never estimated", team.rows.some((r) => r.person === "Kyle" && /no photographer/.test(r.status)) && /isn't estimated/.test(team.note), team.rows.map((r) => `${r.person}: ${r.status}`).join(" | "));

    // =====================================================================
    c.head("§5 · meetings: Calendly reschedules and cancellations move the prep (#5)");
    // =====================================================================
    let m = await ow.meetingsSection({ now: T });
    c.ok("#11 Calendly not connected: said in words, not an empty calendar", m.calendly.state === "not_connected" && m.rows.length === 0, m.calendly.words);
    await saveSecret("calendly", "drill-calendly-key-not-real");
    const MONTHLY = calendly.addEventType({ id: "ET-MONTHLY", name: "Content Program - Strategy Call", slug: "content-program-strategy-call", duration: 30 });
    await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: MONTHLY.uri, eventName: MONTHLY.name, purpose: "MONTHLY_STRATEGY", enabled: true, validationStatus: "VALID" } });
    const ccr = await import("@/lib/contentCallRecords");
    const firstStart = etAt(etDayKey(new Date(T.getTime() + 5 * D)), 13);
    const booked = calendly.bookFromPage(MONTHLY.uri, firstStart.toISOString(), { name: "Pat Planner", email: "pat@client.example" });
    await ccr.syncCallRecordsFromCalendly({ now: T });
    const s1 = await prep.syncMeetingPrep(T);
    const prepTasks = () => prisma.smartTask.findMany({ where: { taskType: "meeting_prep" } });
    let pt = await prepTasks();
    c.ok("a booked strategy call gets ONE prep task, due the business day before at 5 PM ET", s1.created === 1 && pt.length === 1 && pt[0].dueAt?.getTime() === prep.prepDueFor(firstStart, T).getTime() && pt[0].assignedKey === "jordan", `${JSON.stringify(s1)} due ${pt[0]?.dueAt?.toISOString()}`);
    c.ok("…a second sync makes no second task", (await prep.syncMeetingPrep(T)).created === 0 && (await prepTasks()).length === 1);
    m = await ow.meetingsSection({ now: T });
    c.ok("the meeting is on the dashboard with its time, type, join link and prep", m.calendly.state === "connected" && m.rows.length === 1 && m.rows[0].startISO === firstStart.toISOString() && !!m.rows[0].joinLink && m.rows[0].prep.taskId === pt[0].id && /Prep due/.test(m.rows[0].prep.words), JSON.stringify(m.rows[0]?.prep));
    const jamesUser = await prisma.appUser.findFirst({ where: { email: "james@dash.invalid" } });
    const del = await A.assignTaskAction({ ...m.rows[0].assignPrep!, assigneeKey: "james" });
    c.ok("Assign preparation puts the delegation on the prep task itself (no copy)", del.ok && (await prepTasks()).length === 1 && (await prepTasks())[0].assignedKey === "james", del.message);
    const newStart = etAt(etDayKey(new Date(T.getTime() + 8 * D)), 10);
    const moved = calendly.rescheduleFromPage(booked.event.uri, newStart.toISOString());
    await ccr.syncCallRecordsFromCalendly({ now: T });
    const s2 = await prep.syncMeetingPrep(T);
    pt = await prepTasks();
    const view = (await lib.delegationFor([pt[0].id])).get(pt[0].id);
    c.ok("#5 rescheduled: the SAME prep task, its deadline moved to the new day before", s2.moved === 1 && pt.length === 1 && pt[0].dueAt?.getTime() === prep.prepDueFor(newStart, T).getTime(), `${JSON.stringify(s2)} ${pt[0]?.dueAt?.toISOString()}`);
    c.ok("#5 …its history says so, and James (who holds it) is told", !!view && view.assigneeKey === "james" && view.events.some((e) => e.by === "the hub" && /moved to/.test(e.text ?? "")) && (await prisma.notification.count({ where: { userKey: `tm:${jamesTm!.id}`, title: { startsWith: "Meeting moved" } } })) === 1);
    m = await ow.meetingsSection({ now: T });
    c.ok("#5 the dashboard shows the new time with the same prep (one row, not two)", m.rows.length === 1 && m.rows[0].startISO === newStart.toISOString() && m.rows[0].prep.taskId === pt[0].id && /James/.test(m.rows[0].prep.words), m.rows.map((r) => `${r.startISO} ${r.prep.words}`).join(" | "));
    calendly.cancelFromPage(moved.event.uri);
    await ccr.syncCallRecordsFromCalendly({ now: T });
    const s3 = await prep.syncMeetingPrep(T);
    pt = await prepTasks();
    c.ok("#5 cancelled: the prep is cancelled (no misleading active prep task), with the reason on its history", s3.cancelled === 1 && pt.length === 1 && pt[0].status === "CANCELLED" && !(await lib.tasksAssignedTo("james")).some((d) => d.taskId === pt[0].id) && (await lib.delegationFor([pt[0].id])).get(pt[0].id)!.events.some((e) => /cancelled/.test(e.text ?? "")), JSON.stringify(s3));
    m = await ow.meetingsSection({ now: T });
    c.ok("#5 …and the meeting is off the dashboard", m.rows.length === 0);
    void jamesUser;

    // =====================================================================
    c.head("§6 · email needing Jordan, and a new email reopening work (#4)");
    // =====================================================================
    let e = await ow.emailNeedingReply({ now: T });
    c.ok("#11 Jordan's inbox not connected: said in words (not an empty inbox)", e.connected === false && e.rows.length === 0 && e.unavailable.length === 1 && /isn't connected/.test(e.note), e.note);
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token-not-real", "hello@realtourpilot.com": "drill-refresh-token-not-real" }));
    const ext = (n: number) => `gmail-info@realtourpilot.com:msg-${n}`;
    // The complaint client (§3) writing in: a decision, not just a reply.
    await prisma.commLog.create({ data: { clientId: client.id, clientName: client.name, contactName: "Real Agent", channel: "email", direction: "in", source: "gmail", externalId: ext(90), subject: "About the wrong photos", body: "Can we talk about what happened with the kitchen photos?", occurredAt: new Date(T.getTime() - 4 * H), createdAt: new Date(T.getTime() - 4 * H) } });
    e = await ow.emailNeedingReply({ now: T });
    c.ok("an email from a client with an open complaint: 'You need to decide'", e.rows.find((r) => r.clientId === client.id)?.cls === "decide", JSON.stringify(e.rows.map((r) => [r.sender, r.cls])));
    const mailer = await prisma.client.create({ data: { name: "Email Agent", email: "email-agent@client.example" } });
    const inbound = (n: number, at: Date, body: string) => prisma.commLog.create({ data: { clientId: mailer.id, clientName: mailer.name, contactName: "Email Agent", channel: "email", direction: "in", source: "gmail", externalId: ext(n), subject: "Pricing for the spring package", body, occurredAt: at, createdAt: at } });
    await inbound(1, new Date(T.getTime() - 5 * H), "Can you confirm the price for the spring package before Friday?");
    e = await ow.emailNeedingReply({ now: T });
    const row = () => e.rows.find((r) => r.clientId === mailer.id);
    c.ok("a client email in Jordan's inbox, unanswered: 'You need to reply', with the sender, subject and waiting time", e.unavailable.length === 0 && row()?.cls === "reply" && row()?.sender === "Email Agent" && row()?.subject === "Pricing for the spring package" && e.counts.reply >= 1, JSON.stringify({ note: e.note, rows: e.rows.map((r) => [r.sender, r.cls]) }));
    const delegated = await A.assignTaskAction({ ...row()!.assign, assigneeKey: "kyle" });
    e = await ow.emailNeedingReply({ now: T });
    c.ok("delegated to Kyle: 'Waiting on someone else', and who has it (not erased)", delegated.ok && row()?.cls === "waiting" && /Kyle/.test(row()?.handledBy ?? ""), `${row()?.cls} ${row()?.handledBy}`);
    await prisma.commLog.create({ data: { clientId: mailer.id, clientName: mailer.name, contactName: "Us", channel: "email", direction: "out", source: "gmail-sent", externalId: "gmail-sent-t1-m2", subject: "Re: Pricing for the spring package", body: "It's the same as last spring.", occurredAt: new Date(T.getTime() - 2 * H) } });
    e = await ow.emailNeedingReply({ now: T });
    c.ok("Kyle answers: the thread leaves Jordan's list", !row(), JSON.stringify(e.rows.map((r) => r.sender)));
    const replyTaskId = (await prisma.smartTask.findFirst({ where: { dedupeKey: { startsWith: "deleg:/communications" } } }))!.id;
    await signIn(kyle);
    await A.completeTaskAction(replyTaskId, "Answered by email");
    await inbound(3, new Date(T.getTime() - H), "Thanks. One more thing: can you add a drone shot?");
    e = await ow.emailNeedingReply({ now: T });
    c.ok("#4 a NEW actionable email puts the thread back: 'You need to reply' (the old delegation is done)", row()?.cls === "reply", `${row()?.cls}`);
    await signIn(owner);
    const reopen = await A.assignTaskAction({ ...row()!.assign, assigneeKey: "kyle" });
    const reView = (await lib.delegationFor([replyTaskId])).get(replyTaskId);
    c.ok("#4 delegating it again reopens the SAME task (one canonical), with the reopening on its history", reopen.ok && !!reView && reView.state === "ACCEPTED" && reView.events.some((e2) => e2.kind === "reopened") && (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: "deleg:/communications" } } })) === 1, reopen.message);
    // The comms engine's own reopen: a new message merged into a closed reply task.
    const engineTask = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Reply to Real Agent (texts)", source: "openphone", clientId: client.id, assignedKey: "kyle", status: "OPEN" } });
    await A.assignTaskAction({ title: "Reply to Real Agent (texts)", assigneeKey: "kyle", sourceTaskId: engineTask.id });
    await signIn(kyle);
    await A.completeTaskAction(engineTask.id, "Texted back");
    const { mergeIntoExistingTask } = await import("@/lib/tasks");
    await mergeIntoExistingTask(engineTask.id, { snippet: "Also, is Saturday possible?", clientId: client.id, clientName: client.name });
    const engView = (await lib.delegationFor([engineTask.id])).get(engineTask.id);
    const mine = (await ow.delegatedByMe({ email: "info@realtourpilot.com", now: T })).rows.find((r) => r.taskId === engineTask.id);
    c.ok("#4 when the engine reopens a delegated reply task on a new message, it is open again with Kyle and says 'Reopened' on Jordan's side", engView?.state !== "COMPLETED" && engView?.assigneeKey === "kyle" && /Reopened/.test(mine?.latestUpdate ?? ""), `${engView?.state} · ${mine?.latestUpdate}`);

    // =====================================================================
    c.head("§7 · scripts, and the week's measures");
    // =====================================================================
    const pScript = await prisma.project.create({ data: { clientId: client.id, title: "90 Script St, Town", status: "SCHEDULED", shootDate: new Date(T.getTime() + 2 * D) } });
    await prisma.deliverable.create({ data: { projectId: pScript.id, type: "SOCIAL_REEL", label: "Premium Social Media Reel", productTitle: "Social Influencer", videoStyle: "premium_social_reel" } as never });
    // Oct 26 2026 (Jordan: "I think some of these dont get listing scripts?"):
    // a standard cinematic video and an agent-intro reel never take a script.
    const pCine = await prisma.project.create({ data: { clientId: client.id, title: "91 Cinema St, Town", status: "SCHEDULED", shootDate: new Date(T.getTime() + 2 * D) } });
    await prisma.deliverable.create({ data: { projectId: pCine.id, type: "VIDEO", label: "Standard Package", productTitle: "Standard Package", videoStyle: "standard_cinematic" } as never });
    const pIntro = await prisma.project.create({ data: { clientId: client.id, title: "92 Intro St, Town", status: "SCHEDULED", shootDate: new Date(T.getTime() + 3 * D) } });
    await prisma.deliverable.create({ data: { projectId: pIntro.id, type: "SOCIAL_REEL", label: "Photography and Standard Reel w/ Agent intro", productTitle: "Photography and Standard Reel w/ Agent intro", videoStyle: "standard_reel_agent_intro" } as never });
    const cd = await ow.creativeDecisions({ now: T, ownerEmail: "info@realtourpilot.com" });
    const ls = cd.listingFyi?.rows.find((r) => r.id === `listing:${pScript.id}`);
    // Jordan's Loom, Oct 27 2026, 3:51: "I don't need to approve the scripts, James can approve them."
    c.ok("a premium reel shoot in two days with no script: James's (the creative manager), one quiet line on Jordan's card, not a row of his", !!ls && /No script yet/.test(ls.title) && cd.listingFyi?.owner === "James" && !cd.rows.some((r) => r.id === `listing:${pScript.id}`), JSON.stringify(cd.listingFyi));
    c.ok("a standard cinematic video and an agent-intro reel never ask for a listing script", ![...cd.rows, ...(cd.listingFyi?.rows ?? [])].some((r) => r.id === `listing:${pCine.id}` || r.id === `listing:${pIntro.id}`), cd.rows.map((r) => r.id).join(", "));
    const { getShoot } = await import("@/lib/shoot");
    const [shootPremium, shootCine, shootIntro] = await Promise.all([pScript.id, pCine.id, pIntro.id].map((id) => getShoot(id)));
    c.ok("the photographer's shoot page expects a script on the premium reel only (no \"No script yet\" on the others)", shootPremium?.project.scriptExpected === true && shootCine?.project.scriptExpected === false && shootIntro?.project.scriptExpected === false, `${shootPremium?.project.scriptExpected} ${shootCine?.project.scriptExpected} ${shootIntro?.project.scriptExpected}`);
    const w = await od.weeklyPerformance({ now: T });
    c.ok("every weekly measure states its period and its source; photos and videos are never one average", w.measures.length >= 4 && w.measures.every((x) => !!x.period && !!x.source) && w.measures.some((x) => x.key === "photos") && w.measures.some((x) => x.key === "videos"), w.measures.map((x) => `${x.label}=${x.value}`).join(" | "));

    // ---- house rules ----
    const words = JSON.stringify([f, h, ci, team, m, e, cd, w]);
    c.ok("no em dashes in anything the dashboard says", !/—/.test(words), (words.match(/.{30}—.{30}/) ?? [""])[0]);
    c.ok("nothing left the box but the Calendly and Slack fakes", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
