// Oct 29 2026: A COMPLAINT'S PLAN (lib/clientIssuePlanCore, lib/clientIssuePlan,
// app/clients/complaintPlanActions, components/clientCare/ComplaintPlan and
// ComplaintsCard, ownerDashboard's complaint rows, kpiEvidence, the after-
// delivery office to-do). Jordan, on Tim Bonner's call: "I want a way for the
// system to handle and delegate this issue, and track it", then: "an option
// ... to add it to the KPI tracker by clicking a button, and even with the
// client mentioned ... add the preferences to the client's account ... I'd
// want Kyle to have these options too. James also needs to be able to see
// this ... when one of us updates something, it reflects those changes for
// everyone." Held here:
//   §1 the words (pure): preferences block, notes appended never replaced,
//      progress words, the corrected blocker, the KPI title and note name the client
//   §2 the hub's draft: drafted once, read back, no dashes; a photographer can't
//   §3 approval: each step a task on that person's list; done-already steps
//      need no task; a double press makes them once
//   §4 in tandem: Kyle ticks his task on his list, the complaint shows it;
//      Jordan ticks a step on the complaint, the task completes; a removed
//      step leaves the list; "Mark corrected" waits for every step
//   §5 preferences: added under the notes already there; the prefs step closes
//   §6 the KPI tracker: no default count; the client named; once per person
//   §7 the dashboards: the next step is the row's next action and owner; a late
//      step is high; Kyle's and James's lists count their own steps; money scrubbed
//   §8 the panels render
//   §9 the office to-do: one per job; a call's words become the hub's summary
//   §10 how the photographer worked (Jordan: "it doesnt show anything about
//      rushing"): the rules carry it; a plan read again changes only its summary
//      and KPI words, keeps a summary a person wrote, and writes nothing when the
//      new words still leave the point out
// Disposable PGlite; nothing leaves but the faked model call.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { etDayKey } from "../../src/lib/datetime";

installNextStubs();
const asked: string[] = [];
let modelReply: Record<string, unknown> | null = null;
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://slack.com/api/")) return new Response(JSON.stringify({ ok: true, channel: { id: "D" }, ts: "1" }), { headers: { "content-type": "application/json" } });
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
    asked.push(body.messages?.[0]?.content ?? "");
    if (!modelReply) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "msg_drill", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "tu_1", name: "emit", input: modelReply }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return null;
});
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };

const H = 3_600_000;
const D = 24 * H;
const CALL = "Tim Bonner call. The floor plans have the laundry and the half bath swapped and the attic is labeled as a bedroom. Zillow still shows the old labels on the 3D tour. Is Showcase done? The kitchen photos are all wide, I want a closer angle. Bathrooms only show the vanity and the toilet. There were tools on the floor in the laundry. Shoot on the diagonal so buyers see how big the rooms are. I'd rather it take longer than miss angles. We paid $350 for this.";
const DASHES = /[–—]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5964), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct29-complaint-plan" } });
  const c = makeChecker();
  try {
    const core = await import("@/lib/clientIssuePlanCore");
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const P = await import("@/app/clients/complaintPlanActions");
    const care = await import("@/app/clients/clientCareActions");
    const od = await import("@/lib/ownerDashboard");
    const T = new Date();

    // =====================================================================
    c.head("§1 · the words");
    // =====================================================================
    const block = core.prefsBlock("Tim Bonner", ["- Shoot rooms on the diagonal — corner to corner", "• Kitchen: add a closer angle", ""], "the call on Oct 29, 2026");
    c.ok("the preferences block: a heading that says where from, one line each, no long dashes", block === "Tim's preferences (from the call on Oct 29, 2026):\n- Shoot rooms on the diagonal, corner to corner\n- Kitchen: add a closer angle", block);
    c.ok("added under the notes already there, never replacing them", core.appendToNotes("Gate code 1234", block) === `Gate code 1234\n\n${block}` && core.appendToNotes(null, block) === block);
    c.ok("a typed box: bullets stripped, a pasted heading dropped", JSON.stringify(core.prefLines("Tim's preferences (from the call):\n- one\n\n* two ")) === JSON.stringify(["one", "two"]));
    const sv = (o: Partial<Parameters<typeof core.progressOf>[0][number]>) => ({ id: "s", sort: 1, text: "Fix the floor plans", kind: "task" as const, ownerKey: "kyle", ownerName: "Kyle", dueAtISO: new Date(T.getTime() + D).toISOString(), taskId: "t", done: false, doneAtISO: null, doneBy: null, doneNote: null, cancelled: false, late: false, ...o });
    const prog = core.progressOf([sv({ done: true, text: "Showcase" }), sv({ id: "b", sort: 2 }), sv({ id: "x", cancelled: true })], () => "Fri");
    c.ok("progress: cancelled steps don't count; the next open step with who and when", prog.total === 2 && prog.done === 1 && prog.words === "1 of 2 steps done · next: Kyle, Fix the floor plans (due Fri)" && !prog.allDone, prog.words);
    c.ok("'Mark corrected' waits, naming what is open", core.correctedBlocker([sv({})]) === "One step is still open: Kyle, Fix the floor plans. Finish or remove it first." && core.correctedBlocker([sv({ done: true })]) === null);
    c.ok("the KPI title and note name the client, how and when", core.kpiTitle("Tim Bonner", "265 Mill Rd") === "Client complaint from Tim Bonner: 265 Mill Rd" && core.kpiNote("Tim Bonner", "call", "Oct 29, 2026", "The kitchen was all wide shots — no close angle.") === "Tim Bonner said on a call on Oct 29, 2026: The kitchen was all wide shots, no close angle.");
    c.ok("the KPI note doesn't say who twice: 'Tim said ...' loses its opening", core.kpiNote("Tim Bonner", "call", "Oct 29, 2026", "Tim said Harrison was rushing.") === "Tim Bonner said on a call on Oct 29, 2026: Harrison was rushing." && core.kpiNote("Tim Bonner", "call", "Oct 29, 2026", "Timothy said it was fine.").endsWith(": Timothy said it was fine."));
    const sentences = `${"Tim said Harrison was rushing to get it done. ".repeat(4)}Then a long list of photo faults that runs on and on.`;
    const oneLong = `Short start. ${"then a long list of photo faults, ".repeat(10)}and more.`;
    c.ok("long words end on a whole sentence, never mid-word", core.clipToSentence(sentences, 200) === "Tim said Harrison was rushing to get it done. ".repeat(4).trim() && core.clipToSentence("short", 200) === "short", core.clipToSentence(sentences, 200));
    const cut = core.clipToSentence(oneLong, 100);
    const head = cut.replace(/\.\.\.$/, "");
    c.ok("…and with no sentence end past halfway, on a whole word", cut.endsWith("...") && oneLong.startsWith(head) && oneLong[head.length] === " " && core.clipToSentence("one two three four five six seven", 12) === "one two...", cut);
    c.ok("no count is picked for you: the choices start at a note", core.KPI_POINT_CHOICES[0].points === 0 && core.KPI_POINT_CHOICES.every((x) => x.points <= 0));
    c.ok("a broken plan record reads as nothing, not a crash", core.readDraft("{oops") === null && core.readDraft(null) === null);

    // =====================================================================
    c.head("§2 · the hub's draft");
    // =====================================================================
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@plan.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER");
    const jamesTm = await tm("James Lee", "MANAGER", { creativeManager: true });
    const harrisonTm = await tm("Harrison Park", "PHOTOGRAPHER");
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role: role as never, teamMemberId, status: "ACTIVE" } });
    const jordan = await user("Jordan Spackman", "info@realtourpilot.com", "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "kyle@plan.invalid", "ADMIN", kyleTm.id);
    const james = await user("James Lee", "james@plan.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const harrison = await user("Harrison Park", "harrison@plan.invalid", "PHOTOGRAPHER", harrisonTm.id);
    const as = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role as never });
    await saveSecret("ai", "sk-drill-not-a-key");

    const tim = await prisma.client.create({ data: { name: "Tim Bonner", generalNotes: "Gate code 1234" } });
    const job = await prisma.project.create({ data: { clientId: tim.id, title: "265 Mill Rd, Lehighton, PA 18235", status: "DELIVERED", deliveredAt: new Date(T.getTime() - D), photographerId: harrisonTm.id } });
    await prisma.commLog.create({ data: { clientId: tim.id, source: "openphone", channel: "call", direction: "in", contactName: "Tim Bonner", body: CALL, occurredAt: new Date(T.getTime() - 2 * H - 5 * 60_000) } });
    const issue = await prisma.clientIssue.create({ data: { clientId: tim.id, title: "Floor plan errors and photo composition", whatHappened: CALL, source: "call", projectIdsJson: JSON.stringify([job.id]), state: "OPEN", createdAt: new Date(T.getTime() - 2 * H) } });

    await as(harrison);
    const refused = await P.loadComplaintPlanAction(issue.id);
    c.ok("a photographer can't open the plan", !refused.ok, JSON.stringify(refused));

    await as(kyle);
    const first = await P.loadComplaintPlanAction(issue.id);
    c.ok("Kyle opens it: no plan yet, so the hub may draft", first.ok && first.plan.canDraft && first.plan.steps.length === 0 && first.plan.progress.words === "No steps yet", JSON.stringify(first.ok ? first.plan.progress : first));
    c.ok("…the KPI tracker defaults to the job's photographer, and offers the creatives only", first.ok && first.plan.kpi.defaultMemberId === harrisonTm.id && first.plan.kpi.people.some((p) => p.id === jamesTm.id) && !first.plan.kpi.people.some((p) => p.id === jordanTm.id || p.id === kyleTm.id), JSON.stringify(first.ok && first.plan.kpi.people));
    c.ok("…its words name Tim and say he called", first.ok && first.plan.kpi.title === "Client complaint from Tim Bonner: 265 Mill Rd" && first.plan.kpi.note.startsWith("Tim Bonner said on a call on "), first.ok ? first.plan.kpi.note.slice(0, 80) : "");

    const failedDraft = await P.draftComplaintPlanAction(issue.id);
    const afterFail = await P.loadComplaintPlanAction(issue.id);
    c.ok("the model down: the draft says it failed and may be tried again", !failedDraft.ok && afterFail.ok && afterFail.plan.draft?.state === "failed" && afterFail.plan.canDraft, failedDraft.message);

    modelReply = {
      summary: "Tim says the floor plans swap the laundry and half bath and call the attic a bedroom, and Zillow shows the old labels. He also wants different framing on future shoots — closer kitchen angles and wider bathrooms.",
      steps: [
        { text: "Fix the 265 Mill Rd floor plans and tell Tim", ownerKey: "kyle", dueBusinessDays: 1, kind: "task", alreadyDone: "" },
        { text: "Ask Zillow to match the 3D tour labels", ownerKey: "kyle", dueBusinessDays: 2, kind: "task", alreadyDone: "" },
        { text: "Confirm the Zillow Showcase", ownerKey: "kyle", dueBusinessDays: 0, kind: "task", alreadyDone: "Kyle texted Tim at 11:05 AM that it's accepted" },
        { text: "Review the kitchen and bathroom photos and decide on retakes", ownerKey: "jordan", dueBusinessDays: 1, kind: "task", alreadyDone: "" },
        { text: "Coach Harrison with notes on the photos", ownerKey: "jordan", dueBusinessDays: 3, kind: "coach", alreadyDone: "" },
        { text: "Add Tim's preferences to his client notes", ownerKey: "kyle", dueBusinessDays: 1, kind: "prefs", alreadyDone: "" },
        { text: "Something for nobody", ownerKey: "ghost", dueBusinessDays: 9, kind: "odd", alreadyDone: "" },
      ],
      preferences: ["Shoot rooms on the diagonal — corner to corner", "Kitchen: add a closer angled shot", "Bathrooms: show floor and ceiling"],
      shootFeedback: "The kitchen photos were all wide and the bathrooms only showed the vanity and toilet. Tools were left in the laundry.",
    };
    const before = asked.length;
    const drafted = await P.draftComplaintPlanAction(issue.id, { force: true });
    const again = await P.draftComplaintPlanAction(issue.id);
    const view = await P.loadComplaintPlanAction(issue.id);
    const d = view.ok ? view.plan.draft : null;
    c.ok("drafted once; asking again keeps the draft", drafted.ok && again.message === "There is a draft already." && asked.length === before + 1, `${drafted.message} / ${again.message} / ${asked.length - before}`);
    c.ok("the prompt carried the call, the team with roles, and Harrison as the photographer", /Tim Bonner call\. The floor plans/.test(asked[before]) && /kyle: Kyle, ADMIN \(client care\)/.test(asked[before]) && /james: James, CREATIVE_MANAGER/.test(asked[before]) && /Photographer on the job: Harrison/.test(asked[before]), asked[before]?.slice(0, 200));
    c.ok("the draft reads back: no long dashes; an unknown owner is left blank; due days clamped", !!d && d.state === "ready" && !DASHES.test(JSON.stringify(d)) && d.steps[6].ownerKey === null && d.steps[6].dueBusinessDays === 5 && d.steps[6].kind === "task" && d.steps[2].alreadyDone === "Kyle texted Tim at 11:05 AM that it's accepted", JSON.stringify(d?.steps[6]));
    c.ok("…each step's due day is worked out for the boxes", view.ok && view.plan.draftDueDays.length === 7 && view.plan.draftDueDays.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)));
    c.ok("…the KPI note now uses what he said about the shoot", view.ok && /said on a call on .+: The kitchen photos were all wide/.test(view.plan.kpi.note), view.ok ? view.plan.kpi.note : "");

    // =====================================================================
    c.head("§3 · approval");
    // =====================================================================
    const keep = d!.steps.slice(0, 6).map((s, i) => ({ text: s.text, ownerKey: s.ownerKey ?? "", dueISO: view.ok ? view.plan.draftDueDays[i] : null, kind: s.kind, alreadyDone: s.alreadyDone }));
    const approved = await P.approveComplaintDraftAction(issue.id, { summary: d!.summary, steps: keep });
    const twice = await P.approveComplaintDraftAction(issue.id, { summary: d!.summary, steps: keep });
    const steps = await prisma.clientIssueStep.findMany({ where: { issueId: issue.id }, orderBy: { sort: "asc" } });
    const tasks = await prisma.smartTask.findMany({ where: { id: { in: steps.map((s) => s.taskId).filter((x): x is string => !!x) } } });
    c.ok("six steps, made once (a second press changes nothing)", approved.ok && twice.message === "Already approved." && steps.length === 6, `${approved.message} / ${twice.message} / ${steps.length}`);
    c.ok("five are tasks on Kyle's and Jordan's lists; the Showcase one is recorded done with no task", tasks.length === 5 && tasks.filter((t) => t.assignedKey === "kyle").length === 3 && tasks.filter((t) => t.assignedKey === "jordan").length === 2 && !steps[2].taskId && !!steps[2].doneAt, JSON.stringify(tasks.map((t) => t.assignedKey)));
    c.ok("…each task says whose complaint and links back to the step", tasks.every((t) => t.title.startsWith("Tim complaint: ") && (t.delegation ?? "").includes(`/clients/${tim.id}?step=`)), tasks[0]?.title);
    const issueRow = await prisma.clientIssue.findUnique({ where: { id: issue.id } });
    c.ok("the summary is saved, without long dashes", !!issueRow?.summary && !DASHES.test(issueRow.summary) && issueRow.summary.startsWith("Tim says the floor plans"), issueRow?.summary ?? "");

    // =====================================================================
    c.head("§4 · in tandem");
    // =====================================================================
    const { completeTask, actorFor } = await import("@/lib/delegation");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const kyleActor = await actorFor((await getCurrentUser())!);
    const floorTask = steps[0].taskId!;
    const viaList = await completeTask(kyleActor, floorTask, "Plans fixed and sent to Tim");
    await as(jordan);
    const j1 = await P.loadComplaintPlanAction(issue.id);
    c.ok("Kyle ticks it on his own list: Jordan's view of the complaint shows it done", viaList.ok && j1.ok && j1.plan.steps[0].done && j1.plan.progress.done === 2, j1.ok ? j1.plan.progress.words : "");
    const blocked = await care.moveClientIssueAction({ id: issue.id, to: "CORRECTED", correction: "Fixed it" });
    c.ok("'Mark corrected' waits for the open steps and names them", !blocked.ok && /^4 steps are still open: /.test(blocked.message), blocked.message);
    const jTick = await P.completeComplaintStepAction(steps[3].id, "Kitchen is fine; two bathrooms need retakes");
    const reviewTask = await prisma.smartTask.findUnique({ where: { id: steps[3].taskId! } });
    c.ok("Jordan ticks a step on the complaint: its task is complete on the list", jTick.ok && reviewTask?.status === "COMPLETED", jTick.message);
    await as(kyle);
    const removed = await P.removeComplaintStepAction(steps[1].id, "Zillow fixed it on their own");
    const zTask = await prisma.smartTask.findUnique({ where: { id: steps[1].taskId! } });
    const noWhy = await P.removeComplaintStepAction(steps[4].id, "");
    c.ok("a step taken off leaves the list with why; taking one off needs a reason", removed.ok && zTask?.status === "CANCELLED" && !noWhy.ok, `${removed.message} / ${zTask?.status}`);
    await as(james);
    const jamesView = await P.loadComplaintPlanAction(issue.id);
    c.ok("James sees the same plan, money scrubbed from the words", jamesView.ok && jamesView.plan.steps.length === 5 && !jamesView.plan.whatHappened.includes("$350") && jamesView.plan.progress.done === 3, jamesView.ok ? jamesView.plan.whatHappened.slice(-60) : "");
    const jamesAdd = await P.addComplaintStepAction(issue.id, { text: "Walk Harrison through diagonal framing", ownerKey: "james", dueISO: null });
    c.ok("James adds a step for himself", jamesAdd.ok, jamesAdd.message);

    // =====================================================================
    c.head("§5 · preferences");
    // =====================================================================
    await as(kyle);
    const v5 = await P.loadComplaintPlanAction(issue.id);
    c.ok("the hub's preferences wait in the box (not saved yet)", v5.ok && v5.plan.prefs.suggestion.length === 3 && !v5.plan.prefs.addedText && (await prisma.client.findUnique({ where: { id: tim.id } }))?.generalNotes === "Gate code 1234");
    const added = await P.addComplaintPrefsAction(issue.id, v5.ok ? v5.plan.prefs.suggestion.join("\n") : "");
    const notes = (await prisma.client.findUnique({ where: { id: tim.id } }))?.generalNotes ?? "";
    c.ok("added under 'Gate code 1234', headed with where they came from, no long dashes", added.ok && notes.startsWith("Gate code 1234\n\nTim's preferences (from the call on ") && notes.includes("- Shoot rooms on the diagonal, corner to corner") && !DASHES.test(notes), notes);
    const prefsTask = await prisma.smartTask.findUnique({ where: { id: steps[5].taskId! } });
    c.ok("…and the 'add the preferences' step closed itself", prefsTask?.status === "COMPLETED");
    const v5b = await P.loadComplaintPlanAction(issue.id);
    c.ok("the panel shows what was added, by whom", v5b.ok && !!v5b.plan.prefs.addedText && v5b.plan.prefs.addedBy === "Kyle Smith", v5b.ok ? String(v5b.plan.prefs.addedBy) : "");

    // =====================================================================
    c.head("§6 · the KPI tracker");
    // =====================================================================
    const noCount = await P.addComplaintToKpiAction(issue.id, { memberId: harrisonTm.id, area: "client", points: Number.NaN, title: "x title", note: "n" });
    const notCreative = await P.addComplaintToKpiAction(issue.id, { memberId: kyleTm.id, area: "client", points: -5, title: "Client complaint", note: "n" });
    c.ok("nothing counts until someone picks how; only creatives on the tracker", !noCount.ok && noCount.message === "Pick how it counts." && !notCreative.ok, `${noCount.message} / ${notCreative.message}`);
    const k = v5b.ok ? v5b.plan.kpi : null;
    const kpi = await P.addComplaintToKpiAction(issue.id, { memberId: harrisonTm.id, area: "quality", points: -5, title: k!.title, note: k!.note });
    const dup = await P.addComplaintToKpiAction(issue.id, { memberId: harrisonTm.id, area: "quality", points: -3, title: k!.title, note: k!.note });
    const review = await prisma.appSetting.findMany({ where: { key: { contains: harrisonTm.id } } });
    const entry = review.map((r) => r.value).find((v) => v.includes("Client complaint from Tim Bonner"));
    c.ok("on Harrison's tracker with Tim named, once", kpi.ok && /with Tim named/.test(kpi.message) && !dup.ok && !!entry && entry.includes("\"client\":\"Tim Bonner\"") && entry.includes(`"issueId":"${issue.id}"`), `${kpi.message} / ${dup.message}`);
    const v6 = await P.loadComplaintPlanAction(issue.id);
    c.ok("the complaint shows where it went and how it counts", v6.ok && v6.plan.kpi.links.length === 1 && v6.plan.kpi.links[0].points === -5 && v6.plan.kpi.links[0].by === "Kyle Smith");
    await prisma.feedback.create({ data: { projectId: job.id, body: "The kitchen was all wide shots", rating: 2, sentiment: "NEGATIVE", source: "text", photographerId: harrisonTm.id } });
    const kpiLib = await import("@/lib/kpi");
    const card = await kpiLib.scorePeriod({ memberId: harrisonTm.id, period: kpiLib.periodFor(etDayKey(T)) });
    const ents = card.entries as unknown as { title: string; detail?: string[] | string; points?: number }[];
    const said = ents.flatMap((e) => (Array.isArray(e.detail) ? e.detail : [e.detail ?? ""]));
    c.ok("Harrison's scorecard: client feedback names who said it", said.some((x) => x.startsWith("From Tim Bonner by text")), JSON.stringify(said.filter((x) => x.startsWith("From "))));
    c.ok("…and the complaint entry is on it, titled with Tim's name", ents.some((e) => e.title === "Client complaint from Tim Bonner: 265 Mill Rd"), JSON.stringify(ents.map((e) => e.title)));

    // =====================================================================
    c.head("§7 · the dashboards");
    // =====================================================================
    const section = await od.clientIssuesSection({ now: T });
    const row = section.rows.find((x) => x.id === `issue:${issue.id}`);
    c.ok("the row reads the summary, not the call", row?.summary.startsWith("Tim says the floor plans") === true, row?.summary.slice(0, 60));
    c.ok("…its next action, owner and deadline are the next open step", !!row && /^\d of \d steps done · next: /.test(row.nextAction) && !!row.owner && !!row.deadlineISO, JSON.stringify(row && [row.nextAction, row.owner, row.deadlineISO]));
    await prisma.clientIssueStep.update({ where: { id: steps[4].id }, data: {} });
    await prisma.smartTask.update({ where: { id: steps[4].taskId! }, data: { dueAt: new Date(T.getTime() - H) } });
    const late = (await od.clientIssuesSection({ now: T })).rows.find((x) => x.id === `issue:${issue.id}`);
    c.ok("a late step makes it high, and says so", late?.severity === "high" && late.severityWhy === "A step is late", JSON.stringify(late && [late.severity, late.severityWhy]));
    await as(james);
    const jl = await P.listOpenComplaintsAction();
    c.ok("James's desk: the complaint, with his one step counted as his", jl.ok && jl.rows.length === 1 && jl.rows[0].mine === 1 && !jl.rows[0].needsPlan, JSON.stringify(jl.ok && jl.rows[0]));
    await as(jordan);
    const jo = await P.listOpenComplaintsAction();
    c.ok("Jordan's: his late coaching step counted as his", jo.ok && jo.rows[0].mine === 1 && jo.rows[0].progress.late === 1, JSON.stringify(jo.ok && jo.rows[0].progress));

    // Finish the rest: Mark it corrected opens Kyle's check-in.
    await P.completeComplaintStepAction(steps[4].id);
    const jamesStep = await prisma.clientIssueStep.findFirst({ where: { issueId: issue.id, ownerKey: "james" } });
    await P.completeComplaintStepAction(jamesStep!.id);
    const all = await P.loadComplaintPlanAction(issue.id);
    c.ok("every step done: the panel says so, with what was done", all.ok && all.plan.progress.allDone && all.plan.correctedBlocker === null && /Fix the 265 Mill Rd floor plans and tell Tim/.test(all.plan.correctionFromSteps), all.ok ? all.plan.correctionFromSteps.slice(0, 120) : "");
    const corrected = await care.moveClientIssueAction({ id: issue.id, to: "CORRECTED", correction: all.ok ? all.plan.correctionFromSteps : "" });
    c.ok("…and Mark it corrected goes through", corrected.ok, corrected.message);

    // =====================================================================
    c.head("§8 · the panels render");
    // =====================================================================
    const { ComplaintPlan } = await import("@/components/clientCare/ComplaintPlan");
    const final = await P.loadComplaintPlanAction(issue.id);
    const html = ssr(createElement(ComplaintPlan, { issueId: issue.id, initial: final.ok ? final.plan : null }));
    c.ok("the plan: summary, the folded call, the steps, the preferences and the KPI line", !html.startsWith("RENDER FAILED") && html.includes("Tim says the floor plans") && html.includes("What they said, as recorded") && html.includes("data-plan-steps=\"6\"") && html.includes("Preferences on Tim") && html.includes("On Harrison") && html.includes("-5 points"), html.slice(0, 300));
    const fresh = await prisma.clientIssue.create({ data: { clientId: tim.id, title: "Late video", whatHappened: "Where is the video?", source: "text", state: "OPEN" } });
    const loading = ssr(createElement(ComplaintPlan, { issueId: fresh.id, fallbackWords: "Where is the video?" }));
    c.ok("before it loads: the words, and 'Loading the plan'", loading.includes("Where is the video?") && loading.includes("Loading the plan"), loading.slice(0, 200));
    const { OwnerShell } = await import("@/components/owner/OwnerShell");
    const sec2 = await od.clientIssuesSection({ now: T });
    const r2 = sec2.rows.find((x) => x.id === `issue:${fresh.id}`)!;
    const shell = ssr(createElement(OwnerShell, { roster: [{ key: "kyle", name: "Kyle" }], readOnly: false, initial: { kind: "issue", row: r2 } }, null));
    c.ok("Jordan's complaint panel carries the plan, with no separate Assign recovery", !shell.startsWith("RENDER FAILED") && shell.includes("data-complaint-plan-loading") && !shell.includes("Assign recovery"), shell.slice(0, 200));

    // =====================================================================
    c.head("§9 · the office to-do");
    // =====================================================================
    const oak = await prisma.project.create({ data: { clientId: tim.id, title: "12 Oak St, Lehighton, PA 18235", status: "DELIVERED", deliveredAt: new Date(T.getTime() - D) } });
    const pj = await prisma.photoJob.create({ data: { projectId: oak.id, stage: "DELIVERED", deliveredAt: new Date(T.getTime() - D) } as never });
    const A = await import("@/lib/photoDelivery/afterDeliveryAsk");
    const o1 = await A.routeOfficeAsk({ projectId: oak.id, jobId: pj.id, words: "Please fix the floor plan labels", kind: "office", why: "office", askedBy: "Tim Bonner", clientId: tim.id, by: "drill" });
    const o2 = await A.routeOfficeAsk({ projectId: oak.id, jobId: pj.id, words: CALL.repeat(2), summary: "Get Zillow to match the 3D tour room names", kind: "office", why: "office", askedBy: "Tim Bonner", clientId: tim.id, by: "drill" });
    const office = await prisma.smartTask.findMany({ where: { projectId: oak.id, dedupeKey: { startsWith: A.OFFICE_TASK_KEY_PREFIX } } });
    c.ok("a second, different ask on the same job joins the open to-do (one, not two)", !!o1.taskId && o2.taskId === o1.taskId && !o1.reused && o2.reused && office.length === 1, JSON.stringify([o1, o2, office.length]));
    c.ok("…the call's words became the hub's summary, added under the first ask", office[0]?.summary?.includes('Also asked: "Get Zillow to match the 3D tour room names"') === true && !(office[0]?.description ?? "").includes("Tim Bonner call."), office[0]?.summary ?? "");

    // =====================================================================
    c.head("§10 · how the photographer worked");
    // =====================================================================
    const L = await import("@/lib/clientIssuePlan");
    c.ok("the draft's rules: how the photographer worked goes in the summary and the KPI words, never only in preferences", /how the photographer worked on site \(rushing, care, time taken, being late, manner\)/.test(L.DRAFT_SYSTEM) && /never only in preferences/.test(L.DRAFT_SYSTEM) && /keeps happening/.test(L.DRAFT_SYSTEM) && /exact words/.test(L.DRAFT_SYSTEM));
    c.ok("…and the same rules when a plan is read again", /how the photographer worked on site \(rushing/.test(L.FEEDBACK_SYSTEM) && /never only in preferences/.test(L.FEEDBACK_SYSTEM) && !/steps: 3 to 8/.test(L.FEEDBACK_SYSTEM));
    const before10 = await prisma.clientIssue.findUnique({ where: { id: issue.id } });
    const stepsBefore10 = await prisma.clientIssueStep.count({ where: { issueId: issue.id, removedAt: null } });
    modelReply = { summary: "Tim says the floor plans swap the laundry and half bath and the kitchen was all wide.", shootFeedback: "The kitchen photos were all wide." };
    const still = await L.refreshFeedback(issue.id, "claude: drill", { mustMention: /\brush/i });
    const unchanged = await prisma.clientIssue.findUnique({ where: { id: issue.id } });
    c.ok("new words that still leave the rushing out: nothing is written", !still.ok && unchanged?.planJson === before10?.planJson && unchanged?.summary === before10?.summary, still.message);
    modelReply = {
      summary: "Tim says Harrison rushed through the shoot and that it has happened since their first shoot. The floor plans swap the laundry and half bath and call the attic a bedroom.",
      shootFeedback: "Tim said Harrison was rushing to get it done and that it keeps happening. The kitchen photos were all wide and the bathrooms only showed the vanity and toilet.",
    };
    const asked10 = asked.length;
    const redo = await L.refreshFeedback(issue.id, "claude: drill", { mustMention: /\brush/i });
    const after10 = await prisma.clientIssue.findUnique({ where: { id: issue.id } });
    const d10 = core.readDraft(after10?.planJson);
    const d0 = core.readDraft(before10?.planJson);
    c.ok("read again: the summary and the KPI words now carry the rushing", redo.ok && after10?.summary?.startsWith("Tim says Harrison rushed") === true && d10?.summary === after10?.summary && /rushing to get it done/.test(d10?.shootFeedback ?? ""), redo.message);
    c.ok("…the model was told to keep the summary's facts", asked.length === asked10 + 1 && asked[asked10].includes("The summary on file now: Tim says the floor plans") && /Keep every fact in it/.test(asked[asked10]));
    c.ok("…the steps, the preferences, the notes added and the KPI link are as they were", d10?.state === "approved" && JSON.stringify(d10?.steps) === JSON.stringify(d0?.steps) && JSON.stringify(d10?.preferences) === JSON.stringify(d0?.preferences) && after10?.prefsText === before10?.prefsText && after10?.kpiJson === before10?.kpiJson && (await prisma.clientIssueStep.count({ where: { issueId: issue.id, removedAt: null } })) === stepsBefore10);
    const h10 = JSON.parse(after10?.historyJson ?? "[]") as { by: string | null; what: string }[];
    c.ok("…and the history says who read it again", h10.at(-1)?.by === "claude: drill" && /Read the complaint again/.test(h10.at(-1)?.what ?? ""), JSON.stringify(h10.at(-1)));
    const v10 = await P.loadComplaintPlanAction(issue.id);
    c.ok("the KPI form's words now lead with the rushing, naming Tim once", v10.ok && /^Tim Bonner said on a call on .+: Harrison was rushing to get it done/.test(v10.plan.kpi.note), v10.ok ? v10.plan.kpi.note : "");
    await P.saveComplaintSummaryAction(issue.id, "Kyle's own words about this complaint, kept as he wrote them.");
    modelReply = { summary: "Tim says Harrison rushes. The floor plans need fixing.", shootFeedback: "Tim said Harrison rushes and the bathrooms were too tight." };
    const kept = await L.refreshFeedback(issue.id, "claude: drill");
    const after10b = await prisma.clientIssue.findUnique({ where: { id: issue.id } });
    c.ok("a summary a person wrote is kept; only the KPI words change", kept.ok && kept.summaryKept === true && after10b?.summary === "Kyle's own words about this complaint, kept as he wrote them." && core.readDraft(after10b?.planJson)?.shootFeedback === "Tim said Harrison rushes and the bathrooms were too tight.", kept.message);

    c.ok("nothing left the box but the faked model", fence.blocked.length === 0, JSON.stringify(fence.blocked));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
