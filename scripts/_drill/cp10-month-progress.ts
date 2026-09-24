// ---------------------------------------------------------------------------
// DRILL: CP-10 — one monthly-progress reader, and every screen agrees with it
// (completion audit, Sep 24 2026; batch A).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp10-month-progress.ts
//
// What it proves, the OLD behaviour first wherever it can be observed. The old
// roster (contentProgram.getProgramRoster) and the old overview
// (programOverview) are the real files as of BASE, loaded from git byte for
// byte; the old client-file counts, the old journey node and the old portal
// Home booking rule live inside React components that cannot load here, so
// their three-line formulas are replayed over the same rows.
//
//   1. A — a Starter job dated four days ago with NO appointment and no
//      submit. OLD: booked 1, filmed 1, the journey's Shoot node done, the
//      overview COMPLETED. NEW: confirmed 0, unverified 1, filmed 0, two
//      unknowns (booking — Kyle; filming), the Shoot node "unknown".
//   2. S — a project shell (no date, no appointment). OLD: one booked session
//      on the client file, the roster and the overview. NEW: no session on
//      any surface; missing_appointment raised; Home offers nothing booked.
//   3. P1 — Pro, one project, one past appointment the photographer marked
//      complete. OLD: the overview COMPLETED with no missing_appointment, and
//      portal Home HID "Book your filming session". NEW: confirmed 1, filmed
//      1, missing 1, not fully scheduled; the Shoot node is not done; the
//      overview flags missing_appointment; Home offers the booking.
//   4. P2 — Pro, one project with BOTH appointments ahead. OLD: "Needs 1 more
//      session". NEW: confirmed 2, fully scheduled, no such flag.
//   5. P3 — Pro, two projects: one past with an APPLIED CP-09 filming report,
//      one ahead. OLD: the Shoot node done. NEW: active (1/2 filmed).
//   6. D / D0 — a DELIVERED project carrying a 4-reel line. OLD client file:
//      4 delivered. NEW: the library's 1, marked unknown-with-owner because
//      the pipeline says more; with 0 library rows, "unknown", never 0.
//   7. H — a past appointment on Harrison with no evidence: HELD, the unknown
//      is Harrison's, and the portal says "Session held", not "Filmed".
//      7b: evidence belongs to ONE session — a topic dated to leg 1 of a Pro
//      order proves leg 1 only; a cut proves a one-session job only; a loose
//      confirmed video never "films" a request-only session.
//   8. V — per-video stages from real cuts through the real library sync:
//      produced 4, internally approved 1, released 2, client approved 1,
//      downloadable 1 — DOWNLOADABLE is CP-01's own entitlementsForVideos /
//      cutDownloadableFor answer. Script verdicts equal scriptDecisionsFor's.
//   9. THE CROSS-SCREEN CHECK — for every fixture month: {confirmed, missing,
//      filmedConfirmed, delivered, clientApproved} are identical across
//      monthProgress, the overview row, the roster row, the client file's
//      staffMonthView, the portal Home builder, and previewReminders's
//      session gap; the reader's count equals monthSessionCount's and the
//      capacity check's.
//  10. Batched: the reader's query count does not grow with the roster.
//
// ISOLATION. PGlite on 127.0.0.1:5505 (DRILL_PORT overrides) through the
// shared harness; production is never opened; every non-loopback call is
// fenced; nothing is sent. Dates are relative to the real clock (the old code
// reads new Date() itself), and the fixture month is this ET month.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5505);
const REPO = path.resolve(__dirname, "../..");
/** The commit before CP-10: what the audit measured. */
const BASE = "9defa7a";

installNextStubs();
const fence = fenceFetch();

/** The OLD roster and overview, loaded for real from BASE with their `@/` imports pointed at this tree. */
function writeBaseCopies(): { dir: string; contentProgram: string; programOverview: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp10-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const contentProgram = path.join(dir, "contentProgram.base.ts");
  fs.writeFileSync(contentProgram, point(show("src/lib/contentProgram.ts")));
  const programOverview = path.join(dir, "programOverview.base.ts");
  fs.writeFileSync(programOverview, point(show("src/lib/programOverview.ts")));
  return { dir, contentProgram, programOverview };
}
function removeBaseCopies(dir: string) {
  try {
    fs.unlinkSync(path.join(dir, "node_modules"));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* a leftover temp dir is harmless */ }
}

async function main() {
  const { db, stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const base = writeBaseCopies();
  type OldRow = { enrollmentId: string; sessionsScheduled: number; shotCount: number; delivered: number; attention: string[] };
  const oldRoster = (await import(base.contentProgram)) as { getProgramRoster: () => Promise<OldRow[]> };
  type OldOverviewRow = { enrollmentId: string; session: { state: string }; flags: string[] };
  const oldOverview = (await import(base.programOverview)) as { programOverview: (o: { monthKey?: string }) => Promise<{ rows: OldOverviewRow[] }> };

  const mp = await import("@/lib/monthProgress");
  const { journeySteps } = await import("@/lib/contentStatus");
  const { getProgramRoster, etMonthKey } = await import("@/lib/contentProgram");
  const { programOverview } = await import("@/lib/programOverview");
  const portal = await import("@/lib/portal");
  const { previewReminders } = await import("@/lib/programReminders");
  const { monthSessionCount } = await import("@/lib/programMonths");
  const { sessionCapacity } = await import("@/lib/sessionRequests");
  const { syncEnrollmentVideos } = await import("@/lib/contentVideos");
  const ce = await import("@/lib/cutEntitlement");
  const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
  const { streamUrlFor } = await import("@/lib/reviewCuts");

  // ---- the clock and the people ---------------------------------------------
  const now = new Date();
  const HOUR = 3_600_000, DAY = 24 * HOUR;
  const at = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000);
  const PAST = at(now.getTime() - 4 * DAY);
  const FUTURE = at(now.getTime() + 4 * DAY);
  const MK = etMonthKey(now);
  await prisma.appUser.create({ data: { email: "owner-drill@example.com", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
  await prisma.appUser.create({ data: { email: "kyle-drill@example.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-drill@example.com" }, select: { id: true } });

  // Every fixture's monthly call was held (and analysed) ten days ago, so the
  // booking gate is open and "Book your filming session" is decided by
  // sessions alone. The gate reads a matched call RECORD, not the month's
  // legacy status column, so both are written.
  const month = async (name: string, over: Parameters<typeof buildContentMonth>[1]) => {
    const f = await buildContentMonth(prisma, { name: `${name} TEST`, monthKey: MK, ...over });
    const callAt = at(now.getTime() - 10 * DAY);
    await prisma.contentMonth.update({ where: { id: f.monthId }, data: { strategyCallStatus: "COMPLETED", strategyCallAt: callAt } });
    await prisma.programCallRecord.create({
      data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", monthId: f.monthId, status: "COMPLETED", matchState: "MATCHED", transcriptState: "ANALYZED", scheduledStart: callAt, scheduledEnd: at(callAt.getTime() + HOUR) },
    });
    return f;
  };
  const apptsOf = async (f: ContentMonthFixture) => prisma.appointment.findMany({ where: { id: { in: f.appointmentIds } }, orderBy: { startAt: "asc" } });

  // ---- the old readings ------------------------------------------------------
  /** content/[id]/page.tsx:160-176 at BASE, over the same rows. */
  const headPage = async (monthId: string) => {
    const ps = await prisma.project.findMany({ where: { contentMonthId: monthId }, select: { status: true, shootDate: true, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, quantity: true } } } });
    const live = ps.filter((p) => p.status !== "CANCELLED");
    const units = (p: (typeof ps)[number]) => p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
    return {
      sessionsScheduled: live.length,
      shotCount: live.filter((p) => p.shootDate && p.shootDate < new Date()).length,
      delivered: live.filter((p) => p.status === "DELIVERED").reduce((s, p) => s + Math.max(1, units(p)), 0),
    };
  };
  /** MonthJourney.tsx:56-61 at BASE — the Shoot node. */
  const headShoot = (x: { sessionsScheduled: number; shotCount: number }, required: number) =>
    x.shotCount > 0 && x.sessionsScheduled >= required ? "done" : x.sessionsScheduled > 0 ? "active" : "warn";
  /** HomeTab.tsx:56-67 and :146 at BASE — the booking action and the session badge. */
  const headHome = (s: Awaited<ReturnType<typeof portal.portalScheduleMonths>>[number] | null) => {
    if (!s) return { offer: false, badge: null as string | null };
    const reqs = s.requests.filter((r) => ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"].includes(r.status));
    const booked = !!s.bookedShootISO || reqs.some((r) => r.status === "CONFIRMED");
    const requested = !booked && reqs.some((r) => r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED");
    return {
      offer: !s.locked && !booked && !requested && s.capacity.remaining > 0,
      badge: s.bookedShootISO ? (new Date(s.bookedShootISO) < new Date() ? "Filmed" : "Booked") : null,
    };
  };
  const scheduleOf = async (f: ContentMonthFixture) =>
    (await portal.portalScheduleMonths({ id: f.enrollmentId, clientId: f.clientId })).find((m) => m.monthId === f.monthId) ?? null;

  // ---- the new readings -------------------------------------------------------
  const progressOf = async (f: ContentMonthFixture) => (await mp.monthProgress(f.enrollmentId, f.monthId, { now }))!;
  const shootOf = (p: Awaited<ReturnType<typeof progressOf>>) => journeySteps(mp.journeyInputFrom(p)).find((s) => s.key === "shoot")!;
  const homeOf = async (f: ContentMonthFixture) => {
    const cm = await portal.portalMonthProgress({ id: f.enrollmentId, clientId: f.clientId }, MK, { now });
    const sv = portal.homeSessionView(cm, await scheduleOf(f), { canBook: true, readOnly: false });
    return { cm, sv };
  };

  // =========================================================================
  c.head("1 · A — a dated job with no appointment is UNVERIFIED, not booked and not filmed");
  // =========================================================================
  const A = await month("A Dated Starter", { package: "Starter", project: { shootDate: PAST }, owner: false });
  {
    const old = await headPage(A.monthId);
    c.ok("BEFORE (client file): the dated job booked 1 session", old.sessionsScheduled === 1, JSON.stringify(old));
    c.ok("BEFORE (client file): …and a passed date filmed it", old.shotCount === 1);
    c.ok("BEFORE (journey): the Shoot node read done", headShoot(old, 1) === "done");
    const ov = (await oldOverview.programOverview({ monthKey: MK })).rows.find((r) => r.enrollmentId === A.enrollmentId);
    c.ok("BEFORE (overview, real BASE code): COMPLETED", ov?.session.state === "COMPLETED", ov?.session.state);
    const p = await progressOf(A);
    c.ok("NEW: confirmed 0", p.sessions.confirmed === 0, String(p.sessions.confirmed));
    c.ok("NEW: unverified 1", p.sessions.unverified === 1);
    c.ok("NEW: filmedConfirmed 0", p.sessions.filmedConfirmed === 0);
    c.ok("NEW: the session is UNVERIFIED", p.sessions.list.length === 1 && p.sessions.list[0].state === "UNVERIFIED", p.sessions.list.map((x) => x.state).join(","));
    const booking = p.unknowns.find((u) => u.field === "session");
    const filming = p.unknowns.find((u) => u.field === "filming");
    c.ok("NEW: an unknown for the booking, owned by Kyle, 'confirm the appointment in Aryeo'", booking?.owner === "Kyle Drill" && booking.action === "confirm the appointment in Aryeo", JSON.stringify(booking));
    c.ok("NEW: an unknown for the filming, with an owner and an action", !!filming && !!filming.owner && filming.action === "submit the upload page", JSON.stringify(filming));
    c.ok("NEW: the Shoot node reads 'unknown'", shootOf(p).state === "unknown", `${shootOf(p).state} — ${shootOf(p).why}`);
    const v = mp.staffMonthView(p);
    c.ok("NEW (client file): unknowns render 'Unknown: why — owner: action'", v.unknownLines.some((l) => /^Unknown: .+ — Kyle Drill: confirm the appointment in Aryeo$/.test(l)), v.unknownLines.join(" | "));
    c.ok("NEW (client file): the sessions header reads 0/1", v.sessionsCount === "0/1");
    const { cm } = await homeOf(A);
    c.ok("NEW (portal): the client sees 'Being confirmed', never 'Filmed'", cm.sessions.cards.length === 1 && cm.sessions.cards[0].state === "CONFIRMING", JSON.stringify(cm.sessions.cards));
  }

  // =========================================================================
  c.head("2 · S — a project shell counts as no session on any surface");
  // =========================================================================
  const S = await month("S Shell Starter", { package: "Starter", project: { shootDate: null }, owner: false });
  {
    const old = await headPage(S.monthId);
    c.ok("BEFORE (client file): the shell booked a session", old.sessionsScheduled === 1);
    const oldR = (await oldRoster.getProgramRoster()).find((r) => r.enrollmentId === S.enrollmentId);
    c.ok("BEFORE (roster, real BASE code): sessionsScheduled 1", oldR?.sessionsScheduled === 1, String(oldR?.sessionsScheduled));
    const oldO = (await oldOverview.programOverview({ monthKey: MK })).rows.find((r) => r.enrollmentId === S.enrollmentId);
    c.ok("BEFORE (overview, real BASE code): CONFIRMED, no missing_appointment", oldO?.session.state === "CONFIRMED" && !oldO.flags.includes("missing_appointment"), `${oldO?.session.state} ${oldO?.flags}`);
    const p = await progressOf(S);
    c.ok("NEW (reader): no session at all", p.sessions.count.accountedFor === 0 && p.sessions.confirmed === 0 && p.sessions.list.length === 0 && p.sessions.missing === 1);
    const r = (await getProgramRoster({ now })).find((x) => x.enrollmentId === S.enrollmentId)!;
    c.ok("NEW (roster): 0 scheduled, 'No content session on the calendar'", r.sessionsScheduled === 0 && r.attention.includes("No content session on the calendar"), r.attention.join(" | "));
    const o = (await programOverview({ monthKey: MK, now })).rows.find((x) => x.enrollmentId === S.enrollmentId)!;
    c.ok("NEW (overview): NOT_SCHEDULED and missing_appointment", o.session.state === "NOT_SCHEDULED" && o.flags.includes("missing_appointment"), `${o.session.state} ${o.flags}`);
    c.ok("NEW (client file): 0/1", mp.staffMonthView(p).sessionsCount === "0/1");
    const { cm, sv } = await homeOf(S);
    c.ok("NEW (portal): no session card, one missing", cm.sessions.cards.length === 0 && sv.missing === 1 && !sv.sessionBooked);
    const prev = await previewReminders(S.monthId, { now });
    const st = prev.lanes[0].candidate.state;
    c.ok("NEW (reminders): 0 accounted for, 1 missing", st.sessionsAccountedFor === 0 && st.sessionsMissing === 1, `${st.sessionsAccountedFor}/${st.sessionsMissing}`);
  }

  // =========================================================================
  c.head("3 · P1 — one Pro session does not complete a two-session month");
  // =========================================================================
  const P1 = await month("P1 Pro Half", { package: "Pro", appointments: [{ startAt: PAST, durationMin: 240 }] });
  await prisma.appointment.update({ where: { id: P1.appointmentIds[0] }, data: { completedAt: at(PAST.getTime() + 4 * HOUR) } });
  {
    const oldO = (await oldOverview.programOverview({ monthKey: MK })).rows.find((r) => r.enrollmentId === P1.enrollmentId);
    c.ok("BEFORE (overview, real BASE code): COMPLETED and NO missing_appointment", oldO?.session.state === "COMPLETED" && !oldO.flags.includes("missing_appointment"), `${oldO?.session.state} ${oldO?.flags}`);
    const sched = await scheduleOf(P1);
    c.ok("the month's booking gate is open (so the rule below is about sessions alone)", !!sched && !sched.locked, sched?.reason);
    c.ok("BEFORE (portal Home): 'Book your filming session' hidden — the first shoot date read as booked", headHome(sched).offer === false);
    c.ok("BEFORE (portal Home): the past date's badge read 'Filmed'", headHome(sched).badge === "Filmed");
    const p = await progressOf(P1);
    c.ok("NEW: confirmed 1, filmedConfirmed 1, missing 1, not fully scheduled",
      p.sessions.confirmed === 1 && p.sessions.filmedConfirmed === 1 && p.sessions.missing === 1 && !p.sessions.fullyScheduled,
      JSON.stringify({ c: p.sessions.confirmed, f: p.sessions.filmedConfirmed, m: p.sessions.missing, fs: p.sessions.fullyScheduled }));
    c.ok("NEW: the filming evidence is the photographer's field 'complete'", p.sessions.list[0].evidence === "the photographer marked the shoot complete", p.sessions.list[0].evidence ?? "");
    c.ok("NEW: the Shoot node is NOT done", shootOf(p).state !== "done", shootOf(p).state);
    const o = (await programOverview({ monthKey: MK, now })).rows.find((x) => x.enrollmentId === P1.enrollmentId)!;
    c.ok("NEW (overview): missing_appointment raised, not COMPLETED", o.flags.includes("missing_appointment") && o.session.state !== "COMPLETED", `${o.session.state} ${o.flags} · ${o.session.detail}`);
    const { sv } = await homeOf(P1);
    c.ok("NEW (portal Home): 'Book your filming session' offered", sv.offerBooking === true, JSON.stringify({ missing: sv.missing, remaining: sched?.capacity.remaining }));
    c.ok("NEW (portal Home): the held session reads 'Filmed' because it was confirmed", sv.cards.length === 1 && sv.cards[0].state === "FILMED");
  }

  // =========================================================================
  c.head("4 · P2 — both Pro sessions booked on ONE order is fully scheduled");
  // =========================================================================
  const P2 = await month("P2 Pro Booked", { package: "Pro", appointments: [{ startAt: FUTURE, durationMin: 240 }, { startAt: at(FUTURE.getTime() + 2 * DAY), durationMin: 240 }] });
  {
    const oldR = (await oldRoster.getProgramRoster()).find((r) => r.enrollmentId === P2.enrollmentId);
    c.ok("BEFORE (roster, real BASE code): 'Needs 1 more session' on a fully booked Pro month", !!oldR?.attention.includes("Needs 1 more session"), oldR?.attention.join(" | "));
    const p = await progressOf(P2);
    c.ok("NEW: confirmed 2, fully scheduled, missing 0", p.sessions.confirmed === 2 && p.sessions.fullyScheduled && p.sessions.missing === 0);
    const r = (await getProgramRoster({ now })).find((x) => x.enrollmentId === P2.enrollmentId)!;
    c.ok("NEW (roster): no 'Needs … more session'", !r.attention.some((a) => /Needs \d+ more session/.test(a)), r.attention.join(" | "));
    c.ok("NEW: the Shoot node is active (booked, not yet filmed)", shootOf(p).state === "active", shootOf(p).detail);
  }

  // =========================================================================
  c.head("5 · P3 — one filmed Pro session of two is not a filmed month");
  // =========================================================================
  const P3 = await month("P3 Pro Split", { package: "Pro", appointments: [{ startAt: PAST, durationMin: 240 }] });
  {
    const [a1] = await apptsOf(P3);
    const proj2 = await prisma.project.create({ data: { clientId: P3.clientId, title: "P3 Pro Split TEST — session 2", status: "SCHEDULED", contentMonthId: P3.monthId, packageName: "Video Pro", shootDate: FUTURE }, select: { id: true } });
    await prisma.deliverable.create({ data: { projectId: proj2.id, type: "SOCIAL_REEL", label: "Video Pro", productTitle: "Video Pro", quantity: 4 } });
    await prisma.appointment.create({ data: { projectId: proj2.id, aryeoId: `p3-second-${Date.now()}`, startAt: FUTURE, endAt: at(FUTURE.getTime() + 4 * HOUR), durationMin: 240, status: "SCHEDULED" } });
    await prisma.contentFilmingReport.create({
      data: { projectId: P3.projectId!, monthId: P3.monthId, enrollmentId: P3.enrollmentId, appointmentId: a1.aryeoId, submittedBy: "harrison-drill@example.com", topicIdsJson: "[]", payloadHash: "p3-report", state: "APPLIED", appliedAt: now, attempts: 1 },
    });
    const old = await headPage(P3.monthId);
    c.ok("BEFORE (journey): two projects, one past → the Shoot node read done", headShoot(old, 2) === "done", JSON.stringify(old));
    const p = await progressOf(P3);
    c.ok("NEW: confirmed 2, filmedConfirmed 1", p.sessions.confirmed === 2 && p.sessions.filmedConfirmed === 1);
    c.ok("NEW: the past session's evidence is the APPLIED filming report", p.sessions.list.some((x) => x.state === "FILMED_CONFIRMED" && x.evidence === "the photographer's filming report"));
    c.ok("NEW: the Shoot node is active, not done", shootOf(p).state === "active", `${shootOf(p).state} ${shootOf(p).detail}`);
  }

  // =========================================================================
  c.head("6 · D / D0 — delivered is counted per video; an understated count is unknown, never 0");
  // =========================================================================
  const D = await month("D Delivered", { package: "Accelerator", project: { status: "DELIVERED" }, appointments: [{ startAt: PAST, durationMin: 240 }] });
  await prisma.project.update({ where: { id: D.projectId! }, data: { debriefSubmittedAt: PAST, deliveredAt: now } });
  await prisma.contentVideo.create({
    data: { enrollmentId: D.enrollmentId, clientId: D.clientId, monthId: D.monthId, monthKey: MK, kind: "PROGRAM", countsTowardAllowance: true, title: "D TEST delivered reel", status: "DELIVERED", deliveredAt: now, source: "aryeo" },
  });
  const D0 = await month("D0 Delivered Empty", { package: "Accelerator", project: { status: "DELIVERED" }, appointments: [{ startAt: PAST, durationMin: 240 }] });
  await prisma.project.update({ where: { id: D0.projectId! }, data: { debriefSubmittedAt: PAST, deliveredAt: now } });
  {
    const old = await headPage(D.monthId);
    c.ok("BEFORE (client file): the 4-reel line read 4 delivered", old.delivered === 4, String(old.delivered));
    const oldR = (await oldRoster.getProgramRoster()).find((r) => r.enrollmentId === D.enrollmentId);
    c.ok("BEFORE (roster, real BASE code): 4 delivered", oldR?.delivered === 4, String(oldR?.delivered));
    const p = await progressOf(D);
    c.ok("NEW: 1 delivered (the library's video)", p.production.delivered === 1);
    c.ok("NEW: the pipeline's 4 makes the count known=false, with an owner and an action", !p.production.known && p.unknowns.some((u) => u.field === "delivered" && u.owner === "the hub" && u.action === "Sync now"), JSON.stringify(p.unknowns.map((u) => u.short)));
    const r = (await getProgramRoster({ now })).find((x) => x.enrollmentId === D.enrollmentId)!;
    c.ok("NEW (roster): 1 delivered", r.delivered === 1);
    const p0 = await progressOf(D0);
    c.ok("NEW (D0): pipeline DELIVERED with 0 library rows → known false", !p0.production.known && p0.production.delivered === 0 && p0.production.pipelineDelivered === 4);
    const node = journeySteps(mp.journeyInputFrom(p0)).find((s) => s.key === "delivered")!;
    c.ok("NEW (D0): the Delivered node reads 'unknown', not a confident 0", node.state === "unknown" && /Sync now/.test(node.why ?? ""), `${node.state} ${node.detail} — ${node.why}`);
    c.ok("NEW (D0): the client file shows the unknown with its owner", mp.staffMonthView(p0).unknownLines.some((l) => l.endsWith("— the hub: Sync now")));
    const { cm } = await homeOf(D0);
    c.ok("NEW (D0, portal): production.known false, so Home says the count will catch up", cm.production.known === false);
  }

  // =========================================================================
  c.head("7 · H — a held session nobody confirmed is the photographer's unknown");
  // =========================================================================
  const H = await month("H Held", { package: "Accelerator", appointments: [{ startAt: PAST, durationMin: 240 }] });
  await prisma.appointment.update({ where: { id: H.appointmentIds[0] }, data: { assignedToId: harrison.id } });
  // Planned in full (the client supplies topics; the one owed script is
  // approved), so the next-step ladder reaches the filming rung.
  await prisma.contentEnrollment.update({ where: { id: H.enrollmentId }, data: { clientSuppliesTopics: true } });
  await prisma.contentMonth.update({ where: { id: H.monthId }, data: { videosOwed: 1 } });
  await prisma.contentScript.create({ data: { enrollmentId: H.enrollmentId, clientId: H.clientId, monthId: H.monthId, title: "H TEST script", body: "b", status: "APPROVED" } });
  {
    const sched = await scheduleOf(H);
    c.ok("BEFORE (portal Home): the passed date read 'Filmed'", headHome(sched).badge === "Filmed");
    const p = await progressOf(H);
    c.ok("NEW: HELD_UNCONFIRMED", p.sessions.list[0]?.state === "HELD_UNCONFIRMED" && p.sessions.heldUnconfirmed === 1);
    const u = p.unknowns.find((x) => x.field === "filming");
    c.ok("NEW: the unknown is Harrison's: 'submit the upload page'", u?.owner === "Harrison Drill" && u.ownerDuty === "PHOTOGRAPHER" && u.href === `/upload/${H.projectId}`, JSON.stringify(u));
    c.ok("NEW: the client file's next step is his — the upload page is outstanding", p.nextAction?.owner === "Harrison Drill" && /not confirmed/.test(p.nextAction.text), `${p.nextAction?.text} — ${p.nextAction?.owner}`);
    const o = (await programOverview({ monthKey: MK, now })).rows.find((x) => x.enrollmentId === H.enrollmentId)!;
    c.ok("NEW (overview): not COMPLETED; the next action is Harrison's upload page", o.session.state === "CONFIRMED" && o.nextAction.owner === "Harrison Drill" && o.nextAction.href === `/upload/${H.projectId}`, `${o.session.state} · ${o.nextAction.text} — ${o.nextAction.owner}`);
    const { cm } = await homeOf(H);
    c.ok("NEW (portal): 'Session held — we are preparing your videos', never 'Filmed'", cm.sessions.cards[0]?.state === "HELD" && cm.sessions.cards[0].label === "Session held" && cm.sessions.cards[0].note === "We are preparing your videos.");
  }

  // =========================================================================
  c.head("7b · evidence is per session: a leg's own confirmation, a cut on a one-session job, never a stranger's");
  // =========================================================================
  const E = await month("E Evidence Pro", { package: "Pro", appointments: [{ startAt: at(PAST.getTime() - DAY), durationMin: 240 }, { startAt: PAST, durationMin: 240 }] });
  const E1 = await month("E1 Cut Starter", { package: "Starter", appointments: [{ startAt: PAST, durationMin: 120 }] });
  const R = await month("R Request Starter", { package: "Starter", project: false, owner: false });
  {
    // Pro, both legs on one order: a topic confirmed and dated to leg 1 (what
    // confirmFilmedTopics writes) proves leg 1 only; a cut on a two-session job
    // cannot say which session it came from, so it proves neither.
    const [leg1] = await apptsOf(E);
    await prisma.contentVideo.create({
      data: { enrollmentId: E.enrollmentId, clientId: E.clientId, monthId: E.monthId, monthKey: MK, kind: "PROGRAM", countsTowardAllowance: true, title: "E TEST topic", projectId: E.projectId, status: "FILMED", filmedAt: leg1.endAt, filmedConfirmedAt: now, filmedConfirmedBy: "harrison-drill@example.com", filmedSource: "upload_portal", source: "upload_portal" },
    });
    await prisma.reviewSubmission.create({ data: { projectId: E.projectId!, deliverableId: E.deliverableId, slot: 2, round: 1, fileName: "e-reel-2.mp4", status: "PENDING", source: "upload", createdAt: now } });
    const p = await progressOf(E);
    const byStart = [...p.sessions.list].sort((a, b) => (a.startsAtISO ?? "").localeCompare(b.startsAtISO ?? ""));
    c.ok("Pro one order: leg 1 FILMED by its dated confirmation, leg 2 still HELD", byStart[0]?.state === "FILMED_CONFIRMED" && byStart[0].evidence === "filmed topics were confirmed" && byStart[1]?.state === "HELD_UNCONFIRMED", byStart.map((x) => `${x.state}:${x.evidence}`).join(" · "));
    // Starter, one session: an editor's cut from this job proves it was filmed.
    await prisma.reviewSubmission.create({ data: { projectId: E1.projectId!, deliverableId: E1.deliverableId, slot: 1, round: 1, fileName: "e1-reel-1.mp4", status: "PENDING", source: "upload", createdAt: now } });
    const p1 = await progressOf(E1);
    c.ok("one-session job with a cut: FILMED_CONFIRMED by the edit", p1.sessions.list[0]?.state === "FILMED_CONFIRMED" && p1.sessions.list[0].evidence === "an edit was cut from this session's footage", `${p1.sessions.list[0]?.state}:${p1.sessions.list[0]?.evidence}`);
    // A confirmed request with no job behind it yet, and a confirmed video
    // with no job either: nothing ties the two, so the session stays BOOKED.
    await prisma.programSessionRequest.create({ data: { enrollmentId: R.enrollmentId, clientId: R.clientId, monthId: R.monthId, status: "CONFIRMED", slotStart: FUTURE, confirmedAt: now, dedupeKey: `${R.enrollmentId}:${R.monthId}:drill` } });
    await prisma.contentVideo.create({
      data: { enrollmentId: R.enrollmentId, clientId: R.clientId, monthId: R.monthId, monthKey: MK, kind: "PROGRAM", countsTowardAllowance: true, title: "R TEST loose video", status: "FILMED", filmedConfirmedAt: now, source: "manual" },
    });
    const pr = await progressOf(R);
    c.ok("a request-only session is BOOKED and confirmed, not 'filmed' by an unrelated video", pr.sessions.list.length === 1 && pr.sessions.list[0].state === "BOOKED" && pr.sessions.confirmed === 1, pr.sessions.list.map((x) => `${x.source}:${x.state}`).join(","));
  }

  // =========================================================================
  c.head("8 · V — per-video stages from real cuts, DOWNLOADABLE from CP-01, script verdicts exact");
  // =========================================================================
  const V = await month("V Stages", { package: "Accelerator", appointments: [{ startAt: PAST, durationMin: 240 }] });
  await prisma.project.update({ where: { id: V.projectId! }, data: { debriefSubmittedAt: PAST } });
  const cutIds: string[] = [];
  {
    const mk = async (slot: number, o: { status: string; released?: boolean }) => {
      const row = await prisma.reviewSubmission.create({
        data: {
          projectId: V.projectId!, deliverableId: V.deliverableId, slot, round: 1, fileName: `v-reel-${slot}.mp4`, status: o.status, source: "upload", sizeBytes: 5,
          decidedBy: o.status === "APPROVED" ? "Jordan" : null, decidedAt: o.status === "APPROVED" ? now : null, clientReleasedAt: o.released ? now : null,
          finalPath: `/Final/v-reel-${slot}.mp4`, createdAt: at(now.getTime() - HOUR),
        },
        select: { id: true },
      });
      await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), blobUrl: `https://blob.invalid/${row.id}.mp4`, blobPathname: `review-cuts/${row.id}.mp4` } });
      cutIds.push(row.id);
      return row.id;
    };
    await mk(1, { status: "PENDING" });
    await mk(2, { status: "APPROVED" });
    const s3 = await mk(3, { status: "APPROVED", released: true });
    const s4 = await mk(4, { status: "APPROVED", released: true });
    const s4row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: s4 } });
    const d = await prisma.clientDecision.create({
      data: {
        submissionId: s4, projectId: V.projectId!, enrollmentId: V.enrollmentId, clientId: V.clientId, round: 1, contentHash: ce.stableCutIdentity(s4row),
        decision: "APPROVE", actorLabel: "V Stages TEST", clientUserId: V.clientUserId, membershipRole: "OWNER", receiptState: "DONE", dedupeKey: `sub:${s4}:approve`,
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: s4 }, data: { clientApprovedDecisionId: d.id } });
    // The library is built by the real sync, exactly as the portal does before a read.
    await syncEnrollmentVideos({ id: V.enrollmentId, clientId: V.clientId });

    const p = await progressOf(V);
    const pr = p.production;
    c.ok("produced 4", pr.produced === 4, String(pr.produced));
    c.ok("internally approved 1 (approved, never released)", pr.internallyApproved === 1, String(pr.internallyApproved));
    c.ok("released 2 (clientReleasedAt), the inferred legacy release kept apart (1)", pr.released === 2 && pr.releasedInferred === 1, `${pr.released}/${pr.releasedInferred}`);
    c.ok("client approved 1", pr.clientApproved === 1, String(pr.clientApproved));
    c.ok("downloadable 1", pr.downloadable === 1 && pr.downloadableKnown, String(pr.downloadable));
    c.ok("the Review Room's pending cut is counted as awaiting internal review", pr.awaitingInternalReview === 1);
    // DOWNLOADABLE is CP-01's answer, not a restatement: the same verdict from
    // its batch entitlement and from the stream door's per-cut predicate.
    const vids = await prisma.contentVideo.findMany({ where: { enrollmentId: V.enrollmentId, status: { not: "ARCHIVED" } } });
    const ents = await ce.entitlementsForVideos(vids);
    const fromCp01 = vids.filter((v) => ents.get(v.id)?.file).length;
    c.ok("downloadable equals CP-01's entitlementsForVideos count", fromCp01 === pr.downloadable, `${fromCp01} vs ${pr.downloadable}`);
    const pair = { id: V.enrollmentId, clientId: V.clientId };
    c.ok("…and cutDownloadableFor agrees per cut (approved: yes; awaiting: no)", (await ce.cutDownloadableFor(pair, s4)) === true && (await ce.cutDownloadableFor(pair, s3)) === false);
    c.ok("each video's stage is named", p.production.videos.map((v) => v.stage).sort().join(",") === ["DELIVERED", "INTERNALLY_APPROVED", "PRODUCED", "RELEASED"].sort().join(","), p.production.videos.map((v) => v.stage).join(","));

    // Scripts: the reader's verdicts equal scriptDecisionsFor's, script by script.
    const mkScript = async (title: string, vStatus: string, released: boolean, decisions: string[] = []) => {
      const s = await prisma.contentScript.create({ data: { enrollmentId: V.enrollmentId, clientId: V.clientId, monthId: V.monthId, title, body: "b", status: released ? "APPROVED" : vStatus } , select: { id: true } });
      const v = await prisma.contentScriptVersion.create({
        data: { scriptId: s.id, enrollmentId: V.enrollmentId, clientId: V.clientId, versionNo: 1, title, hook: "h", pointsJson: "[]", close: "c", body: "b", source: "MANUAL", status: released ? "SHARED" : vStatus },
        select: { id: true },
      });
      await prisma.contentScript.update({ where: { id: s.id }, data: { currentVersionId: v.id, ...(released ? { approvedVersionId: v.id, sharedVersionId: v.id, releaseState: "released" } : {}) } });
      for (const [i, action] of decisions.entries()) {
        await prisma.contentScriptRelease.create({ data: { scriptId: s.id, scriptVersionId: v.id, enrollmentId: V.enrollmentId, clientId: V.clientId, monthId: V.monthId, action, actorEmail: "client@example.com", createdAt: at(now.getTime() - (10 - i) * 60_000) } });
      }
      return s.id;
    };
    const scriptIds = [
      await mkScript("needs Jordan", "INTERNAL_REVIEW", false),
      await mkScript("drafting", "DRAFT", false),
      await mkScript("released, awaiting", "SHARED", true),
      await mkScript("client approved", "SHARED", true, ["CLIENT_APPROVED"]),
      await mkScript("client changes", "SHARED", true, ["CLIENT_CHANGES"]),
      await mkScript("approved then changes", "SHARED", true, ["CLIENT_APPROVED", "CLIENT_CHANGES"]),
    ];
    const truth = await scriptDecisionsFor(V.enrollmentId, scriptIds);
    const released = [...truth.values()].filter((t) => t.sharedVersionId);
    const p2 = await progressOf(V);
    const sc = p2.scripts;
    c.ok("scripts: approved / changes / awaiting equal scriptDecisionsFor's",
      sc.clientApproved === released.filter((t) => t.decision === "APPROVED").length
      && sc.changesRequested === released.filter((t) => t.decision === "CHANGES_REQUESTED").length
      && sc.releasedAwaitingClient === released.filter((t) => t.decision === null).length,
      `reader ${sc.clientApproved}/${sc.changesRequested}/${sc.releasedAwaitingClient} · truth ${released.map((t) => t.decision ?? "-").join(",")}`);
    c.ok("scripts: 1 drafting, 1 needs Jordan, 4 ready", sc.drafting === 1 && sc.needsJordan === 1 && sc.ready === 4, JSON.stringify(sc));
  }

  // =========================================================================
  c.head("8b · DA — a DELIVERED project whose released cuts await the CLIENT is not a library behind (review, Sep 24)");
  // =========================================================================
  // Since CP-01 a project can be DELIVERED (Aryeo, the status engine, a hand
  // move) while its four released cuts wait on the client's own approval. The
  // library rightly counts 0 delivered; the old test read the pipeline's 4 as
  // "the library is behind" and told the client the count would catch up.
  const DA = await month("DA Awaiting", { package: "Accelerator", project: { status: "DELIVERED" }, appointments: [{ startAt: PAST, durationMin: 240 }] });
  await prisma.project.update({ where: { id: DA.projectId! }, data: { debriefSubmittedAt: PAST, deliveredAt: now } });
  {
    for (let slot = 1; slot <= 4; slot++) {
      const row = await prisma.reviewSubmission.create({
        data: {
          projectId: DA.projectId!, deliverableId: DA.deliverableId, slot, round: 1, fileName: `da-reel-${slot}.mp4`, status: "APPROVED", source: "upload", sizeBytes: 5,
          decidedBy: "Jordan", decidedAt: now, clientReleasedAt: now, completedAt: now, finalPath: `/Final/da-reel-${slot}.mp4`, createdAt: at(now.getTime() - HOUR),
        },
        select: { id: true },
      });
      await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), blobUrl: `https://blob.invalid/${row.id}.mp4`, blobPathname: `review-cuts/${row.id}.mp4` } });
    }
    await syncEnrollmentVideos({ id: DA.enrollmentId, clientId: DA.clientId });
    const p = await progressOf(DA);
    c.ok("the pipeline reads 4 delivered, the library 0 (none is the client's yet)", p.production.pipelineDelivered === 4 && p.production.delivered === 0, `${p.production.pipelineDelivered}/${p.production.delivered}`);
    c.ok("BEFORE: the old test (pipeline > library) called that unknown — 'Sync now', which could never close it", p.production.pipelineDelivered > p.production.delivered);
    c.ok("NEW: 4 released and awaiting the client's approval", p.production.awaitingClient === 4 && p.production.videos.every((v) => v.awaitingClient), String(p.production.awaitingClient));
    c.ok("NEW: so the delivered count is KNOWN — no 'delivered' unknown, no Sync now", p.production.known && !p.unknowns.some((u) => u.field === "delivered") && !/Sync now/.test(p.nextAction?.cta ?? ""), JSON.stringify(p.unknowns.map((u) => u.short)));
    // Planning done (topics, scripts), so the ladder reaches production.
    for (let i = 1; i <= 4; i++) {
      await prisma.contentTopic.create({ data: { enrollmentId: DA.enrollmentId, clientId: DA.clientId, monthId: DA.monthId, title: `DA topic ${i}`, status: "SELECTED" } });
      await prisma.contentScript.create({ data: { enrollmentId: DA.enrollmentId, clientId: DA.clientId, monthId: DA.monthId, title: `DA script ${i}`, body: "b", status: "APPROVED" } });
    }
    const p2 = await progressOf(DA);
    c.ok("NEW: the next step says it waits on the CLIENT (not 'Sync now', not the editor)", p2.nextAction?.blocked === "client" && /4 videos released and awaiting the client's approval/.test(p2.nextAction.text), p2.nextAction?.text ?? "null");
    const { cm } = await homeOf(DA);
    c.ok("NEW (portal Home): known, and 4 waiting on YOUR approval — not 'will catch up'", cm.production.known && cm.production.awaitingYou === 4, JSON.stringify(cm.production));
    const r = (await getProgramRoster({ now })).find((x) => x.enrollmentId === DA.enrollmentId)!;
    c.ok("NEW (roster): no 'delivered count — the hub: Sync now' line", !r.attention.some((a) => /Sync now/.test(a)), r.attention.join(" | "));
    // Every real client today: no portal seat, so nobody on their side CAN
    // approve. "Waiting on the client" would wait for ever — the office sends it.
    await prisma.clientMembership.updateMany({ where: { enrollmentId: DA.enrollmentId }, data: { revokedAt: new Date() } });
    const p3 = await progressOf(DA);
    c.ok("NEW: with no live OWNER seat the step is ours — send it, not wait", p3.portalApprover === false && p3.nextAction?.blocked === "us" && /ready to send — this client has no portal access/.test(p3.nextAction.text), p3.nextAction?.text ?? "null");
    await prisma.clientMembership.updateMany({ where: { enrollmentId: DA.enrollmentId }, data: { revokedAt: null } });
    c.ok("  …and with the seat back it waits on the client again", (await progressOf(DA)).nextAction?.blocked === "client");
  }

  // =========================================================================
  c.head("9 · the cross-screen check — every fixture month, six readers, one set of numbers");
  // =========================================================================
  const all: [string, ContentMonthFixture][] = [["A", A], ["S", S], ["P1", P1], ["P2", P2], ["P3", P3], ["D", D], ["D0", D0], ["H", H], ["E", E], ["E1", E1], ["R", R], ["V", V], ["DA", DA]];
  {
    // Sequential on purpose: ownersFor mints DEFAULT rows on first use.
    const roster = await getProgramRoster({ now });
    const overview = await programOverview({ monthKey: MK, now });
    for (const [label, f] of all) {
      const p = await progressOf(f);
      const want = { confirmed: p.sessions.confirmed, missing: p.sessions.missing, filmed: p.sessions.filmedConfirmed, delivered: p.production.delivered, approved: p.production.clientApproved };
      const o = overview.rows.find((x) => x.enrollmentId === f.enrollmentId)!;
      const r = roster.find((x) => x.enrollmentId === f.enrollmentId)!;
      const v = mp.staffMonthView(p);
      const { cm, sv } = await homeOf(f);
      const st = (await previewReminders(f.monthId, { now })).lanes[0].candidate.state;
      const surfaces: Record<string, typeof want> = {
        overview: { confirmed: o.session.confirmed, missing: o.session.missing, filmed: o.session.filmedConfirmed, delivered: o.production.delivered, approved: o.production.clientApproved },
        roster: { confirmed: r.sessionsScheduled, missing: r.sessionsMissing, filmed: r.shotCount, delivered: r.delivered, approved: r.clientApproved },
        clientFile: { confirmed: Number(v.sessionsCount.split("/")[0]), missing: v.missing, filmed: v.journey.sessionsFilmedConfirmed, delivered: v.delivered, approved: v.clientApproved },
        portalHome: { confirmed: sv.cards.filter((x) => x.state !== "CONFIRMING").length, missing: sv.missing, filmed: sv.cards.filter((x) => x.state === "FILMED").length, delivered: cm.production.delivered, approved: cm.production.approved },
      };
      const diff = Object.entries(surfaces).filter(([, s]) => JSON.stringify(s) !== JSON.stringify(want)).map(([k, s]) => `${k}=${JSON.stringify(s)}`);
      c.ok(`${label}: overview, roster, client file and portal Home agree ${JSON.stringify(want)}`, diff.length === 0, diff.join(" · "));
      c.ok(`${label}: the reminders' session gap is the reader's (${want.missing})`, st.sessionsMissing === want.missing && st.sessionsAccountedFor === p.sessions.count.accountedFor, `${st.sessionsMissing}/${st.sessionsAccountedFor}`);
      const legacy = await monthSessionCount(f.monthId, f.clientId, now);
      const cap = await sessionCapacity(f.enrollmentId, f.monthId, { now });
      c.ok(`${label}: the count equals monthSessionCount's and the capacity check's (${p.sessions.count.accountedFor})`, legacy.accountedFor === p.sessions.count.accountedFor && cap.confirmedSessions === p.sessions.count.accountedFor);
    }
  }

  // =========================================================================
  c.head("10 · batched — the reader's query count does not grow with the roster");
  // =========================================================================
  {
    let executes = 0;
    let counting = false;
    const pg = db as unknown as { execProtocolRawStream: (m: Uint8Array, o: unknown) => Promise<unknown> };
    const real = pg.execProtocolRawStream.bind(db);
    // 'E' (Execute) and 'Q' (simple query): one per statement Prisma runs.
    pg.execProtocolRawStream = (m: Uint8Array, o: unknown) => {
      if (counting && (m[0] === 0x45 || m[0] === 0x51)) executes++;
      return real(m, o);
    };
    const measure = async (fs2: ContentMonthFixture[]) => {
      executes = 0;
      counting = true;
      await mp.monthProgressMany(fs2.map((f) => ({ enrollmentId: f.enrollmentId, monthId: f.monthId, monthKey: MK })), { now, owners: false });
      counting = false;
      return executes;
    };
    const one = await measure([V]);
    const nine = await measure(all.map(([, f]) => f));
    c.ok(`${all.length} client-months cost no more than a fixed handful over one`, nine <= one + 3, `one: ${one} statements · ${all.length}: ${nine}`);
    pg.execProtocolRawStream = real;
  }

  // ---- isolation ---------------------------------------------------------------
  c.head("isolation");
  c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("no ProgramAutomation row was created (every switch stays OFF)", (await prisma.programAutomation.count()) === 0);
  c.ok("nothing was queued to send", (await prisma.outboxMessage.count()) === 0);

  const { pass, fail } = c.summary();
  quiet.restore();
  removeBaseCopies(base.dir);
  await stop();
  fence.restore();
  process.exit(fail ? 1 : pass > 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
