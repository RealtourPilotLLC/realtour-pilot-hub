// ---------------------------------------------------------------------------
// DRILL: WHO GETS EACH TASK, AND WHEN IT CLOSES ITSELF (Oct 27 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct27-task-routing.ts
//
// Jordan, Oct 27: "Kyle handles comms, delegation, review, delivery, and
// coordination. James is the creative manager. I am CEO." And: "Kyle should
// not have to do anything with Kristen Pavillard."
//
//   1. the routing table (lib/taskRouting): the creative manager is the flag,
//      not a name; no flag = the owner; listing scripts = the creative manager (Loom, Oct 27)
//   2. a brand update confirmation lands on the creative manager; an open one
//      still on Kyle moves over on the next change; a hand-picked one stays
//   3. the 15th's mid-month check lands on the creative manager; none before
//      the program has started (no strategy yet, or joined after the 15th),
//      and the hourly closer lets a premature one go
//   4. Script Studio's script package and the client's response go to the
//      listing-scripts owner (James since the Loom), never to Kyle or the shared pile
//   5. a Google Calendar acceptance is not the client writing
//   6. a thank-you opens no reply task; a thank-you with an ask does
//   7. reply tasks close on a person's reply after the client's last message
//      (text and email), never on a robot, a holding line, another job's
//      reply, or a hand-assigned task
//   8. the CubiCasa chase closes when the floor plan is on the listing or
//      marked Done
//   9. "Missing upload details": nothing until the shoot is over; the Editing
//      Room from the shoot's end; Kyle's desk the next business day at noon
//  10. the hourly cron runs the evidence pass; the cleanup script never
//      deletes and never sends
//
// ISOLATION. PGlite on 127.0.0.1:5671 (DRILL_PORT overrides); production is
// never opened; every non-loopback call is fenced; no AI key, so nothing is
// read by a model and nothing is sent.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch(async () => null);
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const MIN = 60_000;
const et = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h + 4, mi)); // EDT (Oct 2026)

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5671), env: { APP_SECRET: "isolated-oct27-task-routing", SCRIPTING_WEBHOOK_SECRET: "oct27-drill-secret" } });
  const c = makeChecker();
  try {
    const { prisma: live } = await import("@/lib/prisma");
    const prisma = live as unknown as PrismaClient;
    const routing = await import("@/lib/taskRouting");

    const kyle = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com", role: "MANAGER" }, select: { id: true } });
    const james = await prisma.teamMember.create({ data: { name: "James Drill", email: "james-drill@example.com", role: "MANAGER", creativeManager: true }, select: { id: true } });
    const jordan = await prisma.teamMember.create({ data: { name: "Jordan Drill", email: "jordan-drill@example.com", role: "MANAGER" }, select: { id: true } });
    await prisma.appUser.create({ data: { email: "jordan-drill@example.com", name: "Jordan", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id } });

    // =====================================================================
    c.head("1 · the routing table");
    // =====================================================================
    c.ok("creative manager = the roster row with the flag (James)", (await routing.creativeManagerDesk())?.id === james.id && (await routing.creativeManagerDesk())?.key === "james");
    c.ok("owner = the OWNER login's roster row (Jordan)", (await routing.ownerDesk())?.id === jordan.id);
    // Jordan's Loom, Oct 27 2026, 3:51: "I don't need to approve the scripts, James can approve them ... he's the content manager."
    c.ok("listing scripts = the creative manager (James), since the Loom", (await routing.listingScriptsDesk())?.key === "james");
    c.ok("creative work = the creative manager", (await routing.creativeWorkDesk())?.key === "james");
    c.ok("the brain's \"Review and action Premium Reel script package\" to-do is a listing-script task; a monthly content script is not", routing.isListingScriptTask("Review and action Premium Reel script package") && routing.isListingScriptTask("Approve the listing script for 7287 PA-873") && !routing.isListingScriptTask("Write November's content scripts") && !routing.isListingScriptTask(null));
    await prisma.teamMember.update({ where: { id: james.id }, data: { creativeManager: false } });
    c.ok("…with nobody carrying the flag, the owner (never Kyle)", (await routing.creativeWorkDesk())?.key === "jordan");
    c.ok("…and listing scripts fall back to the owner too", (await routing.listingScriptsDesk())?.key === "jordan");
    await prisma.teamMember.update({ where: { id: james.id }, data: { creativeManager: true } });
    c.ok("Kyle is never a routing answer", ![await routing.creativeWorkDesk(), await routing.listingScriptsDesk()].some((d) => d?.id === kyle.id));

    // =====================================================================
    c.head("2 · a brand update confirmation is the creative manager's");
    // =====================================================================
    {
      const bp = await import("@/lib/brandProfile");
      const actor = { staffEmail: "kyle@realtourpilot.com", label: "kyle@realtourpilot.com" };
      const fresh = await prisma.client.create({ data: { name: "Mia Brand" }, select: { id: true } });
      await bp.setProfileSlot({ clientId: fresh.id, key: "website", value: "https://mia.example", source: "staff", actor });
      await bp.alertBrandChanges(fresh.id);
      const t = await prisma.smartTask.findFirst({ where: { dedupeKey: { startsWith: `brand-ack:${fresh.id}:` } } });
      c.ok("a new confirmation task is on James (key and roster row)", t?.assignedKey === "james" && t.ownerId === james.id, `${t?.assignedKey}/${t?.ownerId === james.id}`);

      // One minted before today, still on Kyle: the next change moves it over.
      const old = await prisma.client.create({ data: { name: "Ned Older" }, select: { id: true } });
      await bp.setProfileSlot({ clientId: old.id, key: "website", value: "https://ned.example", source: "staff", actor });
      await bp.alertBrandChanges(old.id);
      const o1 = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: { startsWith: `brand-ack:${old.id}:` } } });
      await prisma.smartTask.update({ where: { id: o1.id }, data: { assignedKey: "kyle", ownerId: kyle.id } });
      await bp.setProfileSlot({ clientId: old.id, key: "website", value: "https://ned2.example", source: "staff", actor });
      await bp.alertBrandChanges(old.id);
      const o2 = await prisma.smartTask.findUniqueOrThrow({ where: { id: o1.id } });
      c.ok("an open one still on Kyle moves to James on the next change (one task, both changes)", o2.assignedKey === "james" && o2.ownerId === james.id && /ned2/.test(o2.description ?? ""), `${o2.assignedKey}`);

      // A person put it on Kyle on purpose: it stays his.
      const pick = await prisma.client.create({ data: { name: "Pia Picked" }, select: { id: true } });
      await bp.setProfileSlot({ clientId: pick.id, key: "website", value: "https://pia.example", source: "staff", actor });
      await bp.alertBrandChanges(pick.id);
      const p1 = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: { startsWith: `brand-ack:${pick.id}:` } } });
      await prisma.smartTask.update({ where: { id: p1.id }, data: { assignedKey: "kyle", ownerId: kyle.id, assignedManually: true } });
      await bp.setProfileSlot({ clientId: pick.id, key: "website", value: "https://pia2.example", source: "staff", actor });
      await bp.alertBrandChanges(pick.id);
      const p2 = await prisma.smartTask.findUniqueOrThrow({ where: { id: p1.id } });
      c.ok("a hand-picked one stays where the person put it", p2.assignedKey === "kyle" && p2.assignedManually);
    }

    // =====================================================================
    c.head("3 · the mid-month check: the creative manager's, never before the program starts");
    // =====================================================================
    {
      const R = await import("@/lib/programReminders");
      const T = await import("@/lib/programTaskCloser");
      await prisma.programAutomation.create({ data: { key: "reminders", enabled: true, configJson: JSON.stringify({ staffFollowUpsForRealClients: true }) } });
      const FIFTEENTH = et(2026, 10, 15, 10);
      const started = await buildContentMonth(prisma, { name: "Olivia Started TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-10", project: false, owner: { email: "info+drill-olivia27@realtourpilot.com" }, topics: [{ title: "Real topic", selection: "SELECTED" }] });
      await prisma.contentMonth.update({ where: { id: started.monthId }, data: { planningMode: "WRITTEN" } });
      await prisma.client.update({ where: { id: started.clientId }, data: { name: "Olivia Started" } }); // a real client: no TEST in the name
      await R.evaluateReminders({ dryRun: false, now: FIFTEENTH, enrollmentIds: [started.enrollmentId] });
      const mt = await prisma.smartTask.findUnique({ where: { dedupeKey: `program-reminder-midmonth:${started.monthId}` } });
      c.ok("a started client's 15th: one mid-month check, on James", !!mt && mt.assignedKey === "james" && mt.ownerId === james.id, `${mt?.assignedKey ?? "no task"}`);

      // Kristen's shape: signed up, discovery call booked, no strategy in the portal.
      const kp = await buildContentMonth(prisma, { name: "Kristen Pending TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-10", project: false, strategy: false, owner: { email: "info+drill-kp27@realtourpilot.com" }, topics: [] });
      const why = await R.programNotStartedFor(kp.enrollmentId, FIFTEENTH);
      c.ok("no strategy in the portal yet = the program has not started", !!why && /has not started yet/.test(why), why ?? "null");
      // A client who joined after the 15th, strategy and all.
      const late = await buildContentMonth(prisma, { name: "Lara Late TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-10", project: false, owner: { email: "info+drill-lara27@realtourpilot.com" }, topics: [] });
      await prisma.contentEnrollment.update({ where: { id: late.enrollmentId }, data: { startedAt: et(2026, 10, 18, 9) } });
      const why2 = await R.programNotStartedFor(late.enrollmentId, FIFTEENTH);
      c.ok("joined Oct 18 = the Oct 15 check was never theirs", !!why2 && /started on Oct 18, after this month's mid-month check/.test(why2), why2 ?? "null");
      c.ok("a client who started in August is started", (await R.programNotStartedFor(started.enrollmentId, FIFTEENTH)) === null);

      // A premature check minted before this rule (Kristen's, on Kyle): the closer lets it go.
      const pre = await prisma.smartTask.create({ data: { taskType: "todo", status: "OPEN", source: "content_program", title: "Kristen Pending: mid-month check on 2026-10", clientId: kp.clientId, assignedKey: "kyle", ownerId: kyle.id, dedupeKey: `${T.MIDMONTH_TASK_PREFIX}${kp.monthId}` } });
      const run = await T.closeResolvedProgramTasks({ now: et(2026, 10, 27, 10), taskIds: [pre.id] });
      const after = await prisma.smartTask.findUniqueOrThrow({ where: { id: pre.id } });
      c.ok("the hourly closer completes the premature check, saying why", run.closed === 1 && after.status === "COMPLETED" && /Closed by the hub on .*has not started yet/.test(after.description ?? ""), after.description ?? "");    }

    // =====================================================================
    c.head("4 · Script Studio goes to whoever owns listing scripts");
    // =====================================================================
    {
      const { processScriptingEvent } = await import("@/lib/webhooks/scripting");
      const client = await prisma.client.create({ data: { name: "Sam Script TEST" }, select: { id: true } });
      const job = await prisma.project.create({ data: { clientId: client.id, title: "658 W Ridge Pike, Limerick, PA", status: "SCHEDULED" }, select: { id: true } });
      const base = { id: "studio-658", external_id: job.id, status: "awaiting_review" };
      await processScriptingEvent("project.script_generated", { ...base, script_version: { version_number: 3, status: "awaiting_review" } } as never);
      const pkg = await prisma.smartTask.findUnique({ where: { dedupeKey: `scripting-script-${job.id}` } });
      c.ok("the script package task is James's (the creative manager, since the Loom), not Kyle's", pkg?.assignedKey === "james" && pkg.ownerId === james.id, `${pkg?.assignedKey}/${pkg?.ownerId}`);
      await processScriptingEvent("project.client_responded", { ...base, status: "revision_requested" } as never);
      const resp = await prisma.smartTask.findUnique({ where: { dedupeKey: `scripting-client-${job.id}` } });
      c.ok("the client's response is James's too (it used to have nobody, the shared pile Kyle reads)", resp?.assignedKey === "james" && resp.ownerId === james.id, `${resp?.assignedKey}`);
      // A reopened package that a person had put on Kyle stays his.
      await prisma.smartTask.update({ where: { id: pkg!.id }, data: { status: "COMPLETED", assignedKey: "kyle", ownerId: kyle.id, assignedManually: true } });
      await processScriptingEvent("project.script_generated", { ...base, script_version: { version_number: 4, status: "awaiting_review" } } as never);
      const again = await prisma.smartTask.findUniqueOrThrow({ where: { id: pkg!.id } });
      c.ok("reopened: a hand-picked assignee is kept", again.status === "OPEN" && again.assignedKey === "kyle");
      await prisma.smartTask.update({ where: { id: pkg!.id }, data: { status: "COMPLETED", assignedManually: false } });
      await processScriptingEvent("project.script_generated", { ...base, script_version: { version_number: 5, status: "awaiting_review" } } as never);
      const moved = await prisma.smartTask.findUniqueOrThrow({ where: { id: pkg!.id } });
      c.ok("reopened: an engine-placed one moves to James", moved.status === "OPEN" && moved.assignedKey === "james");
      c.ok("no Kyle name lookup is left in the Studio handler", !/name:\s*\{\s*contains:\s*"Kyle"/.test(read("src/lib/webhooks/scripting.ts")));
    }

    // =====================================================================
    c.head("5 · a Google Calendar notice is not the client writing");
    // =====================================================================
    {
      const { isCalendarNotice } = await import("@/lib/integrations/google");
      const footer = "Kristen Pavillard has accepted this invitation.\nBrand Discovery Call\nInvitation from Google Calendar";
      c.ok("Kristen's acceptance (Google's own words) is a notice", isCalendarNotice({ subject: "Accepted: Brand Discovery Call @ Thu Oct 29, 2026 10am - 11am (EDT) (info@realtourpilot.com)", from: "Kristen Pavillard <kristen@example.com>", body: footer }));
      c.ok("…so is anything Google Calendar's sender sends", isCalendarNotice({ subject: "Updated invitation: Shoot", sender: "Google Calendar <calendar-notification@google.com>" }));
      c.ok("…and an invite with a calendar attachment", isCalendarNotice({ subject: "Declined: Strategy call", calendarPart: true }));
      c.ok("a subject alone is never enough ('Invitation: come see the house')", !isCalendarNotice({ subject: "Invitation: come see the house on Saturday", body: "We are hosting an open house, can you shoot it?" }));
      c.ok("the client replying on that thread is a person", !isCalendarNotice({ subject: "Re: Invitation: Brand Discovery Call", sender: "Google Calendar <calendar-notification@google.com>", body: "Can we move it to 11?" }));
      const g = read("src/lib/integrations/google.ts");
      const at = g.indexOf("if (isCalendarNotice(");
      c.ok("the Gmail handler drops a notice before anything is logged or filed", at > 0 && at < g.indexOf("if (domain && LUMA_DOMAINS.includes(domain))") && at < g.indexOf("await recordClientCommunication({"));
    }

    // =====================================================================
    c.head("6 · a thank-you opens no reply task; a thank-you with an ask does");
    // =====================================================================
    {
      const RQ = await import("@/lib/replyQueue");
      const yes = (t: string, k: string = "text") => RQ.isAckOnlyInbound(t, k);
      c.ok("'Thank you so much!' needs no reply", yes("Thank you so much!"));
      c.ok("'It went well' needs no reply", yes("It went well") && yes("It went well!") && RQ.isCourtesyMessage("It went well"));
      c.ok("'Sounds good 👍' needs no reply", yes("Sounds good 👍"));
      c.ok("a reaction needs no reply", yes("Loved “Your photos are ready”"));
      c.ok("an email thank-you with a signature needs no reply", yes("Re: Your listing photos are ready — Thank you so much!\nKristen Pavillard\nRealtor | Compass\n(610) 555-0134\nkristen@example.com", "email"));
      c.ok("…'Sent from my iPhone' too", yes("Re: Photos — Love them, thank you!\n\nSent from my iPhone", "email"));
      c.ok("a thank-you with an ask still needs one", !yes("Thank you so much! Can you also send the floor plan"));
      c.ok("…and the walk agrees (it used to read that as a closer)", !RQ.isCourtesyMessage("Thank you so much! Can you also send the floor plan"));
      c.ok("a thank-you with a question still needs one", !yes("Thanks! What time tomorrow?"));
      c.ok("a bare phone number is information, not a thank-you (Tim Bonner's)", !yes("+1 (610) 509-1197") && !RQ.isCourtesyMessage("+1 (610) 509-1197") && !yes("4512"));
      c.ok("a thank-you with a revision still needs one", !yes("Thanks, but the kitchen photo is too dark, please brighten it"));
      c.ok("an email thank-you with a second line of real words still needs one", !yes("Re: Photos — Thank you!\nThe twilight shot is missing from the gallery.\nKristen", "email"));
      c.ok("a subject with a question keeps an email open", !yes("Did the video go out? — Thanks!", "email"));
      c.ok("a missed call or voicemail is always called back", !yes("Thanks", "missed_call") && !yes("Thanks", "voicemail"));
      c.ok("'No need, thanks' is still a closer", yes("No need, thanks!"));

      const { recordClientCommunication } = await import("@/lib/comms");
      const cl = await prisma.client.create({ data: { name: "Tara Thanks" }, select: { id: true } });
      await recordClientCommunication({ clientId: cl.id, clientName: "Tara Thanks", contactName: "Tara Thanks", text: "Thank you so much!", kind: "text", source: "openphone" });
      await recordClientCommunication({ clientId: cl.id, clientName: "Tara Thanks", contactName: "Tara Thanks", text: "It went well", kind: "text", source: "openphone" });
      c.ok("recorded thank-yous open no task at all", (await prisma.smartTask.count({ where: { clientId: cl.id } })) === 0);
      await recordClientCommunication({ clientId: cl.id, clientName: "Tara Thanks", contactName: "Tara Thanks", text: "Thank you! Can you send the floor plan too?", kind: "text", source: "openphone" });
      c.ok("a thank-you with an ask opens the reply task", (await prisma.smartTask.count({ where: { clientId: cl.id, taskType: "client_reply", status: "OPEN" } })) === 1);
    }

    // =====================================================================
    c.head("7 · reply tasks close on evidence, and only on evidence");
    // =====================================================================
    {
      const E = await import("@/lib/taskEvidence");
      const T0 = new Date(Date.now() - 6 * 3600_000);
      const at = (m: number) => new Date(T0.getTime() + m * MIN);
      const mkClient = async (name: string) => (await prisma.client.create({ data: { name }, select: { id: true } })).id;
      const comm = (clientId: string, direction: "in" | "out", minutes: number, body: string, extra: Record<string, unknown> = {}) =>
        prisma.commLog.create({ data: { channel: "text", direction, clientId, body, source: direction === "in" ? "openphone" : "openphone", occurredAt: at(minutes), ...extra } });
      const reply = (clientId: string, minutes: number, extra: Record<string, unknown> = {}) =>
        prisma.smartTask.create({ data: { taskType: "client_reply", status: "OPEN", source: "openphone", title: "Reply to the latest message", clientId, assignedKey: "kyle", ownerId: kyle.id, createdAt: at(minutes), description: "Can we do 10 AM?", ...extra } });

      const a = await mkClient("Ann Answered");
      await comm(a, "in", 0, "Can we do 10 AM?");
      const ta = await reply(a, 1);
      await comm(a, "out", 12, "Yes, 10 AM works. See you then.");

      const h = await mkClient("Hal Holding");
      await comm(h, "in", 0, "Is the video done?");
      const th = await reply(h, 1);
      await comm(h, "out", 5, "Let me check with the editor and get back to you.");

      const r = await mkClient("Rob Robot");
      await comm(r, "in", 0, "When is my shoot?");
      const tr = await reply(r, 1);
      await comm(r, "out", 5, "Your shoot is confirmed for Thursday at 9 AM.", { source: "auto-confirmation" });

      const w = await mkClient("Wes Wroteagain");
      await comm(w, "in", 0, "Quick question about the gallery");
      const tw = await reply(w, 1);
      await comm(w, "out", 5, "Sure, what is it?");
      await comm(w, "in", 20, "Can you add the drone shots too?");

      const m = await mkClient("Max Manual");
      await comm(m, "in", 0, "Can you call me?");
      const tm = await reply(m, 1, { assignedManually: true });
      await comm(m, "out", 5, "Calling you now.");

      // Two open replies on two jobs: our reply filed on job 1 closes job 1 only.
      const two = await mkClient("Tia Twojobs");
      const p1 = await prisma.project.create({ data: { clientId: two, title: "1 First St", status: "DELIVERED" }, select: { id: true } });
      const p2 = await prisma.project.create({ data: { clientId: two, title: "2 Second St", status: "SCHEDULED" }, select: { id: true } });
      await comm(two, "in", 0, "Can I get the first one's photos resized?", { projectId: p1.id });
      await comm(two, "in", 2, "And what time is the second shoot?", { projectId: p2.id });
      const t1 = await reply(two, 3, { projectId: p1.id });
      const t2 = await reply(two, 3, { projectId: p2.id });
      await comm(two, "out", 15, "Resized versions are in your gallery now.", { projectId: p1.id });

      // Email: same subject answers it, another subject does not.
      const e = await mkClient("Eve Email");
      await prisma.commLog.create({ data: { channel: "email", direction: "in", clientId: e, subject: "Question about 12 Oak St", body: "Do you shoot twilight?", source: "gmail", occurredAt: at(0) } });
      const te = await prisma.smartTask.create({ data: { taskType: "client_reply", status: "OPEN", source: "gmail", title: "Answer the twilight question", clientId: e, assignedKey: "kyle", createdAt: at(1), sourceDetail: "gmail-thread:hello@realtourpilot.com:t-eve" } });
      await prisma.commLog.create({ data: { channel: "email", direction: "out", clientId: e, subject: "Your invoice", body: "Here is your invoice.", source: "gmail-sent", occurredAt: at(4) } });
      const ev1 = (await E.replyVerdicts({ taskIds: [te.id] }))[0];
      c.ok("an email on another subject does not answer it", !ev1.evidence, ev1.kept);
      await prisma.commLog.create({ data: { channel: "email", direction: "out", clientId: e, subject: "Re: Question about 12 Oak St", body: "We do! Twilight is $150.", source: "gmail-sent", occurredAt: at(9) } });

      const res = await E.sweepTaskEvidence();
      const st = async (id: string) => prisma.smartTask.findUniqueOrThrow({ where: { id } });
      const A = await st(ta.id);
      c.ok("a person's reply after their message closes the task", A.status === "COMPLETED" && A.completedAt?.getTime() === at(12).getTime(), `${A.status} ${A.completedAt?.toISOString()}`);
      c.ok("…dated to the reply, with the evidence written on it", /Closed by the hub on .*we replied by text on .*10 AM works/.test(A.description ?? ""), A.description ?? "");
      c.ok("a holding line leaves it open", (await st(th.id)).status === "OPEN");
      c.ok("a robot's text leaves it open", (await st(tr.id)).status === "OPEN");
      c.ok("they wrote again after our reply: still open", (await st(tw.id)).status === "OPEN");
      c.ok("a hand-assigned task is left for its person", (await st(tm.id)).status === "OPEN");
      c.ok("two jobs: the reply filed on job 1 closes job 1's task only", (await st(t1.id)).status === "COMPLETED" && (await st(t2.id)).status === "OPEN");
      c.ok("an email reply on the same subject closes the email task", (await st(te.id)).status === "COMPLETED");
      c.ok("the pass reports what it closed", res.closed === 3, `${res.closed}`);
      const again = await E.sweepTaskEvidence();
      c.ok("a second pass closes nothing more", again.closed === 0, JSON.stringify(again.verdicts.filter((v) => v.evidence)));
    }

    // =====================================================================
    c.head("8 · the CubiCasa chase closes when the floor plan is there");
    // =====================================================================
    {
      const E = await import("@/lib/taskEvidence");
      const cl = await prisma.client.create({ data: { name: "Fay Floorplan" }, select: { id: true } });
      const job = async (title: string, evidence: unknown, deliverable?: string) => {
        const p = await prisma.project.create({ data: { clientId: cl.id, title, status: "REVIEW", statusEvidence: evidence ? JSON.stringify(evidence) : null }, select: { id: true } });
        if (deliverable) await prisma.deliverable.create({ data: { projectId: p.id, type: "FLOORPLAN", label: "Floor plan", status: deliverable as never } });
        const t = await prisma.smartTask.create({ data: { taskType: "comms_followup", status: "OPEN", source: "system", title: `Chase CubiCasa floor plan — ${title}`, projectId: p.id, clientId: cl.id, assignedKey: "kyle", dedupeKey: `vendor-chase-${p.id}-floorplan` } });
        return { p: p.id, t: t.id };
      };
      const onListing = await job("3 Listing Ln", { expected: ["Photos", "Floor plan"], present: ["Photos"], aryeo: { photos: 25, videos: 0, floorPlans: 1, interactive: 0 } });
      const doneInHub = await job("4 Hub Ct", null, "DONE");
      const waiting = await job("5 Wait Way", { expected: ["Floor plan"], present: [], aryeo: { photos: 0, videos: 0, floorPlans: 0, interactive: 0 } }, "PENDING");
      const manual = await job("6 Hand Rd", { expected: ["Floor plan"], present: ["Floor plan"], aryeo: { photos: 0, videos: 0, floorPlans: 2, interactive: 0 } });
      await prisma.smartTask.update({ where: { id: manual.t }, data: { assignedManually: true } });
      await E.sweepTaskEvidence();
      const st = async (id: string) => prisma.smartTask.findUniqueOrThrow({ where: { id } });
      const L = await st(onListing.t);
      c.ok("on the Aryeo listing → closed, saying so", L.status === "COMPLETED" && /floor plan is on the Aryeo listing/.test(L.description ?? ""));
      c.ok("marked Done in the hub → closed", (await st(doneInHub.t)).status === "COMPLETED");
      c.ok("nothing yet → still open", (await st(waiting.t)).status === "OPEN");
      c.ok("a hand-assigned chase is left for its person", (await st(manual.t)).status === "OPEN");
      // The hub action closes it at once (actions.setDeliverableStatus calls this).
      await prisma.deliverable.updateMany({ where: { projectId: waiting.p }, data: { status: "DONE" } });
      c.ok("marking it Done closes the chase now", (await E.closeFloorPlanChaseNow(waiting.p)) === 1 && (await st(waiting.t)).status === "COMPLETED");
      c.ok("the status action is wired to it", /closeFloorPlanChaseNow\(d\.projectId\)/.test(read("src/app/actions.ts")));
    }

    // =====================================================================
    c.head("9 · Missing upload details: photographer first, then the office");
    // =====================================================================
    {
      const RP = await import("@/lib/remindPhotographer");
      const { liveAppointment } = await import("@/lib/shootDayText");
      const visit = (start: Date, min = 120) => ({ status: "SCHEDULED", startAt: start, endAt: null, durationMin: min });
      const tue9 = et(2026, 10, 27, 9);
      const during = et(2026, 10, 27, 10, 30);
      const afterEnd = et(2026, 10, 27, 11, 30);
      c.ok("a shoot still going on is not over", RP.shootOverAt([visit(tue9)], tue9, during, liveAppointment) === null);
      c.ok("…so nobody sees the row yet", RP.remindShowsFrom(RP.shootOverAt([visit(tue9)], tue9, during, liveAppointment), "office") === null && RP.remindShowsFrom(null, "editing") === null);
      const over = RP.shootOverAt([visit(tue9)], tue9, afterEnd, liveAppointment);
      c.ok("over at its booked end (9 AM + 2h = 11 AM)", over?.getTime() === et(2026, 10, 27, 11).getTime(), over?.toISOString());
      c.ok("the Editing Room sees it from the shoot's end", RP.remindShowsFrom(over, "editing")?.getTime() === et(2026, 10, 27, 11).getTime());
      c.ok("Kyle's desk sees it the next business day at noon (after the 10 AM ask to the photographer)", RP.remindShowsFrom(over, "office")?.getTime() === et(2026, 10, 28, 12).getTime(), RP.remindShowsFrom(over, "office")?.toISOString());
      const fri = RP.shootOverAt([visit(et(2026, 10, 30, 9))], null, et(2026, 10, 30, 15), liveAppointment);
      // Mon Nov 2 2026 is after the clocks change (EST): noon ET = 17:00 UTC.
      c.ok("a Friday shoot reaches Kyle on Monday at noon", RP.remindShowsFrom(fri, "office")?.getTime() === Date.UTC(2026, 10, 2, 17), RP.remindShowsFrom(fri, "office")?.toISOString());
      c.ok("an explicit end time wins over the booked length", RP.shootOverAt([{ status: "SCHEDULED", startAt: tue9, endAt: et(2026, 10, 27, 13), durationMin: 60 }], tue9, et(2026, 10, 27, 14), liveAppointment)?.getTime() === et(2026, 10, 27, 13).getTime());
      c.ok("a second visit still to come keeps it hidden", RP.shootOverAt([visit(tue9), visit(et(2026, 10, 29, 9))], tue9, afterEnd, liveAppointment) === null);
      c.ok("the office desk's call (no audience) gets the office rule; the Editing Room asks as 'editing'", /audience \?\? "office"/.test(read("src/lib/remindPhotographer.ts")) && read("src/app/editing/page.tsx").includes('.map((r) => r.id), now, { audience: "editing" })'));
    }

    // =====================================================================
    c.head("10 · the hourly pass and the cleanup script");
    // =====================================================================
    {
      const route = read("src/app/api/cron/sync/route.ts");
      c.ok("cron/sync runs the evidence pass", /step\("taskEvidence"/.test(route) && /sweepTaskEvidence\(\)/.test(route));
      const script = read("scripts/_live/oct27-reroute-tasks.ts");
      c.ok("the cleanup script is dry-run unless --apply, through the read-only guard", /import \{ APPLY, db \} from "\.\/_oct22-guard"/.test(script) && /if \(!APPLY\)/.test(script));
      c.ok("…and never deletes or sends", !/\.delete(Many)?\(/.test(script) && !/outbox|sendSms|sendEmail|notifyInApp|enqueue/i.test(script));
      c.ok("…and leaves hand-assigned and delegated tasks alone", /assignedManually: false, delegatedAt: null/.test(script));
    }

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
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
