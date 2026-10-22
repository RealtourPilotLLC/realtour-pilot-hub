// ---------------------------------------------------------------------------
// DRILL: a filmed script the client never approved reads "Filmed" (Oct 22 2026).
//
// Jordan: "If a script has not been approved but has been filmed, like for
// John Collins, he shouldn't have to approve it. It should just show up as
// filmed." And: "John's 4 other scripts are being filmed tomorrow."
//
//   1. The rule (lib/scriptFilmed): each signal the hub already keeps — a
//      confirmed video, a video past filming, the topic past filming, the
//      script's own video link — and a script with none of them.
//   2. The portal: a filmed, unapproved script is "Filmed" with its day, asks
//      nothing (no Approve, no Request changes; the server refuses both and
//      records nothing), is not in any waiting count, badge or Home step, and
//      its PDF opens and says "Filmed".
//   3. No reminder: the approval email's list, Kyle's before-the-shoot task and
//      the scripts-ready email all leave it out.
//   4. An approved script is unchanged; a change request filed before filming
//      stays on the office's card while the client is no longer asked.
//   5. Tomorrow's shoot: a shared, unapproved script filming tomorrow is still
//      asked for today, and turns into "Filmed" the moment the shoot's filming
//      report (the upload portal's wrap-up) is applied. No manual step.
//   6. The month counts filmed as done (progress, the one-PDF-per-month rule).
//   7. clientApprovedAt / clientApprovedByUserId stay null throughout.
//
// ISOLATION: PGlite via the shared harness; every outbound fetch is fenced.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6781);
installNextStubs();
const fence = fenceFetch();
const HOUR = 3_600_000;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-filmed-scripts", NEXT_PUBLIC_APP_URL: "https://hub.example.test", PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  try {
    const sf = await import("@/lib/scriptFilmed");
    const scripts = await import("@/lib/contentScripts");
    const { scriptDecisionsFor, clientApproveScript, clientRequestScriptChanges, clientApprovalAsked, filmedWithoutApproval } = await import("@/lib/scriptDecisions");
    const { portalTopics } = await import("@/lib/portal");
    const { planModel, awaitingScript, filmedScript } = await import("@/lib/portalHome");
    const { monthScriptApprovals } = await import("@/lib/programReminders");
    const { reconcileScriptApprovalTasks } = await import("@/lib/programDeskTasks");
    const { monthProgress } = await import("@/lib/monthProgress");
    const pdf = await import("@/lib/scriptPdfLinks");
    const ft = await import("@/lib/filmedTopics");

    // ======================================================================
    c.head("1 · the rule, pure");
    const S = { id: "scriptaaaa01", topicId: "topicaaaa01", videoId: null as string | null };
    const v = (o: Partial<import("@/lib/scriptFilmed").FilmedVideoFacts>) => ({ id: "videoaaaa01", scriptId: null, topicId: null, status: "PLANNED", filmedAt: null, filmedConfirmedAt: null, ...o });
    const none = sf.scriptFilmedFrom({ script: S, topicStatus: "SCRIPTED", videos: [v({ topicId: S.topicId })] });
    c.ok("not filmed: a planned video and a SCRIPTED topic say nothing", none === null);
    const conf = sf.scriptFilmedFrom({ script: S, topicStatus: "SCRIPTED", videos: [v({ scriptId: S.id, filmedConfirmedAt: "2026-10-15T11:21:44Z", filmedAt: "2026-10-14T21:00:00Z" })] });
    c.ok("a video a person confirmed filmed (upload portal) → VIDEO_CONFIRMED, dated by its filming moment", conf?.signal === "VIDEO_CONFIRMED" && conf.atISO === "2026-10-14T21:00:00.000Z", JSON.stringify(conf));
    const confNoDate = sf.scriptFilmedFrom({ script: S, topicStatus: null, videos: [v({ topicId: S.topicId, filmedConfirmedAt: "2026-10-15T11:21:44Z" })] });
    c.ok("…no filming moment: dated by the confirmation", confNoDate?.atISO === "2026-10-15T11:21:44.000Z", JSON.stringify(confNoDate));
    const status = sf.scriptFilmedFrom({ script: S, topicStatus: "SCRIPTED", videos: [v({ topicId: S.topicId, status: "EDITING" })] });
    c.ok("a video past filming, unconfirmed → VIDEO_STATUS", status?.signal === "VIDEO_STATUS" && status.atISO === null, JSON.stringify(status));
    const topic = sf.scriptFilmedFrom({ script: S, topicStatus: "FILMED", videos: [] });
    c.ok("the topic past filming, no video → TOPIC_STATUS, no day claimed", topic?.signal === "TOPIC_STATUS" && topic.atISO === null, JSON.stringify(topic));
    const link = sf.scriptFilmedFrom({ script: { ...S, topicId: null, videoId: "videoaaaa09" }, topicStatus: null, videos: [v({ id: "videoaaaa09", status: "DELIVERED" })] });
    c.ok("the script's own video link (ContentScript.videoId) counts", link?.signal === "VIDEO_STATUS" && link.videoId === "videoaaaa09", JSON.stringify(link));
    const other = sf.scriptFilmedFrom({ script: S, topicStatus: "SCRIPTED", videos: [v({ topicId: "topicbbbb02", scriptId: "scriptbbbb2", filmedConfirmedAt: new Date() })] });
    c.ok("another topic's footage is not this script's", other === null);
    const ranked = sf.scriptFilmedFrom({ script: S, topicStatus: "FILMED", videos: [v({ id: "videoaaaa02", topicId: S.topicId, status: "DELIVERED" }), v({ id: "videoaaaa03", scriptId: S.id, filmedConfirmedAt: "2026-10-15T00:00:00Z" })] });
    c.ok("a confirmation outranks a status", ranked?.videoId === "videoaaaa03" && ranked.signal === "VIDEO_CONFIRMED", JSON.stringify(ranked));
    c.ok("the predicates agree with the planning reader's lists", sf.isFootage({ status: "CLIENT_REVIEW", filmedConfirmedAt: null }) && !sf.isFootage({ status: "ARCHIVED", filmedConfirmedAt: null }) && sf.topicIsFilmed("EDITING") && !sf.topicIsFilmed("SCRIPTED"));

    // ======================================================================
    // The world: one client's month, six topics, the next session tomorrow.
    const owner = await prisma.appUser.create({ data: { email: "jordan@filmed.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const staff = { email: owner.email, appUserId: owner.id };
    const tomorrow = new Date(Math.floor((Date.now() + 20 * HOUR) / 60_000) * 60_000);
    const F = await buildContentMonth(db, {
      name: "John Filmed TEST", package: "Pro", videosPerMonth: 6, sessionsPerMonth: 1,
      owner: { email: "info+rt@realtourpilot.com", name: "John Filmed" },
      appointments: [{ startAt: tomorrow, durationMin: 120 }],
      topics: [
        { title: "Paoli on the Main Line", selection: "SELECTED" },
        { title: "Stop renovating the wrong things", selection: "SELECTED" },
        { title: "Showings but no offers", selection: "SELECTED" },
        { title: "The deal that almost fell apart", selection: "SELECTED" },
        { title: "The advice they didn't want", selection: "SELECTED" },
        { title: "Listing phrases translated", selection: "SELECTED" },
      ],
    });
    const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];
    const make = async (i: number, title: string) => {
      const r = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[i], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai",
        parts: { title, hook: `Here is the thing about ${title.toLowerCase()}.`, points: pts("Most people miss it.", "Here is what I do instead.", "And it works."), close: "Call me and I'll walk you through it.", captionCta: null } });
      await scripts.approveScriptVersion(r.versionId, staff, "drill: no pillar yet");
      await scripts.releaseScriptVersion(r.scriptId, staff);
      return r;
    };
    const conf1 = await make(0, "Paoli on the Main Line"); // filmed: a confirmed video bound by scriptId
    const stat2 = await make(1, "Stop renovating the wrong things"); // filmed: a video in editing, by topic
    const top3 = await make(2, "Showings but no offers"); // filmed: the topic only
    const appr4 = await make(3, "The deal that almost fell apart"); // approved by the client, then filmed
    const wait5 = await make(4, "The advice they didn't want"); // not filmed: filming tomorrow
    const chg6 = await make(5, "Listing phrases translated"); // changes asked, then filmed (ContentScript.videoId)
    const filmedIds = [conf1.scriptId, stat2.scriptId, top3.scriptId, chg6.scriptId];

    const viewer = await (async () => {
      const who = await prisma.clientUser.findUniqueOrThrow({ where: { id: F.clientUserId! } });
      return { enrollment: { id: F.enrollmentId, clientId: F.clientId, clientName: F.clientName }, actor: { kind: "CLIENT" as const, clientUserId: who.id, email: who.email, name: who.name, membershipId: F.membershipId!, membershipRole: "OWNER" as const }, access: "FULL" as const, via: "LOGIN" as const };
    })();
    // Before filming: the client approves #4 and asks for changes on #6.
    const ok4 = await clientApproveScript(viewer as never, appr4.scriptId, appr4.versionId);
    const ch6 = await clientRequestScriptChanges(viewer as never, chg6.scriptId, "Make the hook about first-time sellers.", chg6.versionId);
    c.ok("setup: #4 approved by the client, #6 changes asked, before filming", ok4.ok && ch6.ok, `${ok4.message} / ${ch6.message}`);

    // The filming signals, written the way production writes them.
    const base = { enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, monthKey: F.monthKey };
    await prisma.contentVideo.create({ data: { ...base, title: "Paoli", topicId: F.topicIds[0], scriptId: conf1.scriptId, status: "FILMED", filmedAt: new Date("2026-10-14T21:00:00Z"), filmedConfirmedAt: new Date("2026-10-15T11:21:44Z"), filmedConfirmedBy: "harrison@filmed.test", filmedSource: "upload_portal", source: "upload_portal" } });
    await prisma.contentVideo.create({ data: { ...base, title: "Renovating", topicId: F.topicIds[1], status: "EDITING", source: "review" } });
    await prisma.contentTopic.update({ where: { id: F.topicIds[2] }, data: { status: "FILMED" } });
    await prisma.contentTopic.update({ where: { id: F.topicIds[3] }, data: { status: "FILMED" } });
    const v6 = await prisma.contentVideo.create({ data: { ...base, title: "Phrases", status: "CLIENT_REVIEW", source: "review" } });
    await prisma.contentScript.update({ where: { id: chg6.scriptId }, data: { videoId: v6.id } });

    // ======================================================================
    c.head("2 · the rule, read from the database");
    const all = [conf1, stat2, top3, appr4, wait5, chg6].map((x) => x.scriptId);
    const rows = await prisma.contentScript.findMany({ where: { id: { in: all } }, select: { id: true, topicId: true, videoId: true } });
    const read = await sf.readScriptsFilmed(rows);
    c.ok("confirmed video → VIDEO_CONFIRMED, Oct 14", read.get(conf1.scriptId)?.signal === "VIDEO_CONFIRMED" && read.get(conf1.scriptId)?.atISO === "2026-10-14T21:00:00.000Z", JSON.stringify(read.get(conf1.scriptId)));
    c.ok("video in editing → VIDEO_STATUS", read.get(stat2.scriptId)?.signal === "VIDEO_STATUS");
    c.ok("topic FILMED only → TOPIC_STATUS", read.get(top3.scriptId)?.signal === "TOPIC_STATUS");
    c.ok("ContentScript.videoId → that video", read.get(chg6.scriptId)?.videoId === v6.id);
    c.ok("tomorrow's script is not filmed", !read.has(wait5.scriptId));
    const d = await scriptDecisionsFor(F.enrollmentId, all);
    c.ok("scriptDecisionsFor carries it, beside the client's own decision", filmedIds.every((id) => !!d.get(id)?.filmed) && !d.get(wait5.scriptId)?.filmed && d.get(chg6.scriptId)?.decision === "CHANGES_REQUESTED" && d.get(appr4.scriptId)?.decision === "APPROVED");
    c.ok("clientApprovalAsked: only tomorrow's script", all.filter((id) => clientApprovalAsked(d.get(id))).join() === wait5.scriptId, all.filter((id) => clientApprovalAsked(d.get(id))).join());
    c.ok("filmedWithoutApproval: the four filmed ones, not the approved one", filmedIds.every((id) => filmedWithoutApproval(d.get(id))) && !filmedWithoutApproval(d.get(appr4.scriptId)));

    // ======================================================================
    c.head("3 · the portal");
    const t1 = await portalTopics({ id: F.enrollmentId, clientId: F.clientId });
    const topics = t1.groups.flatMap((g) => g.topics);
    const byTopic = (i: number) => topics.find((t) => t.id === F.topicIds[i])!;
    c.ok("the filmed script carries its day for the card (Filmed Oct 14)", byTopic(0).script?.filmed?.atISO === "2026-10-14T21:00:00.000Z" && byTopic(0).script?.decision === null, JSON.stringify(byTopic(0).script?.filmed));
    c.ok("…every filmed one is filmedScript and none is awaitingScript", [0, 1, 2, 5].every((i) => filmedScript(byTopic(i)) && !awaitingScript(byTopic(i))), [0, 1, 2, 5].map((i) => `${filmedScript(byTopic(i))}/${awaitingScript(byTopic(i))}`).join(" "));
    c.ok("the approved one stays approved, not 'Filmed'", byTopic(3).script?.decision === "APPROVED" && !filmedScript(byTopic(3)) && !awaitingScript(byTopic(3)));
    c.ok("tomorrow's still asks", awaitingScript(byTopic(4)) && !filmedScript(byTopic(4)));
    const pm = planModel(t1, F.monthKey);
    c.ok("Scripts view / nav badge / Home count: 1 (tomorrow's only)", pm.scripts.length === 1 && pm.scripts[0].id === F.topicIds[4], pm.scripts.map((t) => t.title).join(" | "));
    c.ok("…the four filmed ones in their own 'Filmed' list", pm.filmedScripts.length === 4 && [0, 1, 2, 5].every((i) => pm.filmedScripts.some((t) => t.id === F.topicIds[i])));
    c.ok("…the approved one under 'approved', the changed-then-filmed one not under 'asked to change'", pm.decidedScripts.map((t) => t.id).join() === F.topicIds[3], pm.decidedScripts.map((t) => t.title).join(" | "));
    const mp = t1.months.find((m) => m.id === F.monthId)?.planning;
    c.ok("month progress: one script ready for review, the rest filmed or approved", mp?.counts.READY_FOR_YOU === 1 && mp.headline.key === "READY_FOR_YOU" && mp.headline.text === "A script is ready for your review", `${JSON.stringify(mp?.counts)} · ${mp?.headline.text}`);
    c.ok("…and the progress line never calls a filmed one 'approved' alone", mp?.progress === "5 of 6 scripts approved or filmed", mp?.progress ?? "null");
    const { homeActions } = await import("@/lib/portalHome");
    const home = homeActions({
      status: "ACTIVE", readOnly: false, perms: { session: true, suggest: true, request: true, approve: true, profile: true },
      review: { count: 0, single: null, soonestDeadlineLabel: null }, scripts: pm.scripts.map((t) => ({ topicId: t.id, title: t.title })), unread: 0,
      planning: null, clientPlanned: null, month: null, filmingStarted: true, topicHistoryNeedsReview: false, toAnswer: [], session: { offerBooking: false, required: 1, missing: 0, deferred: false },
      addressNeeded: 0, lateSession: null, setup: null, ready: { count: 0, withFile: false, single: null }, linkVisitor: null,
    } as never);
    const ask = [home.primary, ...home.more].find((a) => a?.kind === "APPROVE_SCRIPTS");
    c.ok("Home asks about one script, by name, and never a filmed one", ask?.count === 1 && /The advice they didn't want/.test(ask.title), ask?.title ?? "none");

    // The client acts on a filmed script from a stale tab.
    const aBefore = await prisma.contentScriptRelease.count({ where: { action: "CLIENT_APPROVED" } });
    const tryApprove = await clientApproveScript(viewer as never, conf1.scriptId, conf1.versionId);
    c.ok("Approve on a filmed script: nothing to approve, nothing written", tryApprove.ok && /already been filmed/.test(tryApprove.message) && (await prisma.contentScriptRelease.count({ where: { action: "CLIENT_APPROVED" } })) === aBefore, tryApprove.message);
    const sBefore = await prisma.scriptSuggestion.count();
    const tryChange = await clientRequestScriptChanges(viewer as never, stat2.scriptId, "Change the close please.", stat2.versionId);
    c.ok("Request changes on a filmed script: refused in plain words, no request filed", !tryChange.ok && /already been filmed/.test(tryChange.message) && (await prisma.scriptSuggestion.count()) === sBefore, tryChange.message);
    c.ok("…no em dashes in what the client reads", !/—/.test(tryApprove.message + tryChange.message));
    const one = await pdf.approvedScriptForPdf(F.enrollmentId, conf1.scriptId);
    c.ok("its PDF opens, and says Filmed, not Approved", !("refused" in one) && one.script.note === "Filmed Oct 14, 2026", "refused" in one ? one.refused : one.script.note ?? "");
    const twoA = await pdf.approvedScriptForPdf(F.enrollmentId, appr4.scriptId);
    c.ok("the approved one's PDF still says Approved", !("refused" in twoA) && /^Approved /.test(twoA.script.note ?? ""));
    const notYet = await pdf.approvedScriptForPdf(F.enrollmentId, wait5.scriptId);
    c.ok("tomorrow's is still 'approve first'", "refused" in notYet && /Approve the script first/.test(notYet.refused));

    // ======================================================================
    c.head("4 · reminders, the office's chase and its view");
    const pending = await monthScriptApprovals(F.monthId);
    c.ok("approval email list: tomorrow's script only", pending.awaitingClient.map((a) => a.scriptId).join() === wait5.scriptId, JSON.stringify(pending.awaitingClient.map((a) => a.title)));
    c.ok("…the changed-then-filmed one is not chased either", pending.changesRequested.length === 0 && pending.notShared.length === 0, JSON.stringify(pending));
    const desk = await reconcileScriptApprovalTasks({ dryRun: true });
    c.ok("Kyle's before-the-shoot task would name 1 awaiting, 0 not shared", desk.wouldOpen.length === 1 && /1 awaiting, 0 not shared/.test(desk.wouldOpen[0]), desk.wouldOpen.join(" | "));
    // The scripts-ready email: a batch of only filmed scripts is cancelled; a mixed batch lists the unfilmed one.
    await prisma.programAutomation.upsert({ where: { key: "script_share_email" }, create: { key: "script_share_email", enabled: true, enabledBy: "drill", enabledAt: new Date(Date.now() - 10 * 24 * HOUR) }, update: { enabled: true } });
    const notice = async (key: string, ids: string[]) => {
      const n = await prisma.programReminder.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, monthKey: F.monthKey, action: "SCRIPTS_READY", templateKey: "scripts_ready.v1", templateVersion: "1", channel: "email", attempt: 1, state: "PENDING", manual: false, requestedBy: "drill", dedupeKey: `${F.enrollmentId}:SCRIPTS_READY:${key}`, nextEligibleAt: new Date(Date.now() - HOUR) } });
      for (const id of ids) {
        const s = await prisma.contentScript.findUniqueOrThrow({ where: { id }, select: { sharedVersionId: true } });
        await prisma.contentScriptRelease.create({ data: { scriptId: id, scriptVersionId: s.sharedVersionId!, enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, action: "SHARE", actorEmail: staff.email, reminderId: n.id } });
      }
      return n.id;
    };
    const onlyFilmed = await notice("only-filmed", [conf1.scriptId, top3.scriptId]);
    const mixed = await notice("mixed", [stat2.scriptId, wait5.scriptId]);
    // A weekday, mid-morning ET: inside every send window.
    const probeNow = (() => { const x = new Date(); for (;;) { x.setUTCDate(x.getUTCDate() + 1); const wd = x.getUTCDay(); if (wd >= 2 && wd <= 4) break; } x.setUTCHours(15, 0, 0, 0); return x; })();
    const { drainShareNotices } = await import("@/lib/scriptShare");
    const dry = await drainShareNotices({ now: probeNow, dryRun: true, max: 10 });
    const pv = (id: string) => dry.preview.find((p) => p.reminderId === id);
    c.ok("scripts-ready email: a batch of only filmed scripts is cancelled, saying why", pv(onlyFilmed)?.decision === "cancel" && /already filmed/.test(pv(onlyFilmed)?.reason ?? ""), `${pv(onlyFilmed)?.decision}: ${pv(onlyFilmed)?.reason}`);
    c.ok("…a mixed batch lists only the unfilmed script", pv(mixed)?.decision === "send" && /^1 script\(s\)/.test(pv(mixed)?.reason ?? ""), `${pv(mixed)?.decision}: ${pv(mixed)?.reason}`);
    const prog = (await monthProgress(F.enrollmentId, F.monthId))!;
    c.ok("office month progress: 1 waiting on the client, 3 filmed, 1 approved, 1 change request kept", prog.scripts.releasedAwaitingClient === 1 && prog.scripts.releasedFilmed === 3 && prog.scripts.clientApproved === 1 && prog.scripts.changesRequested === 1, JSON.stringify(prog.scripts));
    c.ok("…the client's change request is still open for the office", (await prisma.scriptSuggestion.count({ where: { scriptId: chg6.scriptId, status: "OPEN" } })) === 1);
    const { loadScriptsTab } = await import("@/app/content/[id]/programData");
    const tab = await loadScriptsTab(F.enrollmentId, { id: F.monthId });
    const row = (id: string) => tab.scripts.find((s) => s.id === id);
    c.ok("content workspace: filmed scripts carry 'filmed' (dated when known), the approved one does not", filmedIds.every((id) => !!row(id)?.filmed) && row(conf1.scriptId)?.filmed?.atISO === "2026-10-14T21:00:00.000Z" && !row(wait5.scriptId)?.filmed && row(appr4.scriptId)?.clientVerdict === "APPROVED");
    c.ok("…and the change request still reads as the client's verdict there", row(chg6.scriptId)?.clientVerdict === "CHANGES_REQUESTED");

    // ======================================================================
    c.head("5 · tomorrow's shoot: filming recorded → Filmed, no manual step");
    c.ok("before the shoot: no month PDF (one script still waits)", (await pdf.monthsReadyForPdf(F.enrollmentId)).length === 0);
    const afterShoot = new Date(tomorrow.getTime() + 150 * 60_000);
    const prep = await ft.prepareFilmingReport(F.projectId!, { filmedTopicIds: [F.topicIds[4]] }, { name: "Harrison", email: "harrison@filmed.test" }, afterShoot);
    c.ok("the upload portal's wrap-up makes a filming report for the ticked topic", !!prep, JSON.stringify(prep && { hash: prep.payloadHash }));
    await prisma.contentFilmingReport.createMany({ data: [prep!.row], skipDuplicates: true });
    const rep = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { projectId_payloadHash: { projectId: F.projectId!, payloadHash: prep!.payloadHash } } });
    const applied = await ft.applyFilmingReport(rep.id, { now: afterShoot });
    c.ok("…and applying it confirms the topic (the same step finalizeUpload and the hourly sweep run)", applied.state === "APPLIED", JSON.stringify(applied).slice(0, 200));
    const after = (await scriptDecisionsFor(F.enrollmentId, [wait5.scriptId])).get(wait5.scriptId);
    c.ok("tomorrow's script now reads filmed, confirmed by the photographer, dated the session", after?.filmed?.signal === "VIDEO_CONFIRMED" && after.decision === null && !!after.filmed.atISO, JSON.stringify(after?.filmed));
    const t2 = await portalTopics({ id: F.enrollmentId, clientId: F.clientId });
    const pm2 = planModel(t2, F.monthKey);
    c.ok("…the portal asks nothing: 0 scripts waiting, 5 filmed", pm2.scripts.length === 0 && pm2.filmedScripts.length === 5, `${pm2.scripts.length} / ${pm2.filmedScripts.length}`);
    c.ok("…no approval email, no Kyle task line for it", (await monthScriptApprovals(F.monthId)).awaitingClient.length === 0);
    const mp2 = t2.months.find((m) => m.id === F.monthId)?.planning;
    c.ok("the month counts filmed as done", mp2?.headline.key === "DONE" && mp2.progress === "6 of 6 scripts approved or filmed", `${mp2?.headline.text} · ${mp2?.progress}`);
    const ready = await pdf.monthsReadyForPdf(F.enrollmentId);
    c.ok("…the one-PDF-per-month rule offers the month", ready.length === 1 && ready[0].monthKey === F.monthKey && ready[0].count === 6, JSON.stringify(ready));
    const monthPdf = await pdf.monthScriptsForPdf(F.enrollmentId, F.monthKey);
    c.ok("…every page says Approved or Filmed, and the cover says both", !("refused" in monthPdf) && monthPdf.scripts.length === 6 && monthPdf.scripts.filter((s) => /^Filmed/.test(s.note ?? "")).length === 5 && monthPdf.subheading === "6 scripts, approved or filmed.", "refused" in monthPdf ? monthPdf.refused : `${monthPdf.subheading} · ${monthPdf.scripts.map((s) => s.note).join(", ")}`);

    // ======================================================================
    c.head("6 · never a client sign-off");
    const end = await prisma.contentScript.findMany({ where: { id: { in: [...filmedIds, wait5.scriptId] } }, select: { id: true, clientApprovedAt: true, clientApprovedByUserId: true, clientApprovedVersionId: true } });
    c.ok("clientApprovedAt / clientApprovedByUserId / clientApprovedVersionId stay null on every filmed script", end.length === 5 && end.every((s) => !s.clientApprovedAt && !s.clientApprovedByUserId && !s.clientApprovedVersionId), JSON.stringify(end.filter((s) => s.clientApprovedAt)));
    c.ok("…and no CLIENT_APPROVED ledger row names any of them", (await prisma.contentScriptRelease.count({ where: { scriptId: { in: [...filmedIds, wait5.scriptId] }, action: "CLIENT_APPROVED" } })) === 0);
    const apprRow = await prisma.contentScript.findUniqueOrThrow({ where: { id: appr4.scriptId }, select: { clientApprovedAt: true, clientApprovedVersionId: true } });
    c.ok("the script the client did approve keeps its sign-off", !!apprRow.clientApprovedAt && apprRow.clientApprovedVersionId === appr4.versionId);
    const versionsAfter = await prisma.contentScriptVersion.count({ where: { scriptId: { in: all } } });
    c.ok("no script's words changed (one version each)", versionsAfter === 6, String(versionsAfter));
    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
