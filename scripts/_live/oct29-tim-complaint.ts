// ---------------------------------------------------------------------------
// Tim Bonner's complaint (265 Mill Rd) gets its plan (Jordan, Oct 29 2026:
// "I want a way for the system to handle and delegate this issue, and track
// it", then "Yes I like this"). Written the way the plan panel writes it
// (lib/clientIssuePlan), labelled claude: for Jordan:
//   · the summary, from his texts and the call;
//   · six steps: floor plans (Kyle, on the task he already had to tell Tim),
//     Zillow to match (Kyle), Showcase (done: Kyle's 11:05 AM text), the photo
//     review and the retake decision (Jordan), coaching Harrison (Jordan),
//     his preferences into his notes (Kyle);
//   · the six office to-dos those steps replace are closed with a merge note
//     (five restatements of the floor plan and 3D tour asks, and the retake);
//   · his preferences and what he said about the shoot are kept as the hub's
//     draft: they wait in the panel for Jordan or Kyle to press "Add to Tim's
//     client notes". Nothing is written to his notes or to Aryeo here, and
//     nothing goes on anyone's KPI tracker.
// Dry run by default (read-only connection, proven); --apply writes.
//
//   npx tsx --require ./scripts/_drill/_client-drill-preload.cjs \
//     scripts/_live/oct29-tim-complaint.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const ISSUE_ID = "cmvtntfc100b4js08bj4k30ap"; // "Unhappy about 265 Mill Rd"
const CLIENT_ID = "cmqiku2vd013e9k9qowe1wzoo"; // Tim Bonner
const NOTIFY_TASK = "cmvssb16r0014jt087pdrojyo"; // Kyle: "Notify Tim when updated 2D floor plans are live in media link"
const MERGED = [
  "cmvtn2q9m000njs0875chjupr", // relabel the 1st floor (text 10:28 AM)
  "cmvtnce6800agjs08k8t97ash", // the 2nd floor walk-in closet (text 10:36 AM)
  "cmvtnudmz00bgjs08tk58wlri", // relabel the 1st floor again (from the call)
  "cmvtnuerb00bmjs08wr2dm7p5", // the call transcript as a to-do
  "cmvtohsxr00ctjs087pjeu0fa", // the 3D tour room names (text 11:08 AM)
  "cmvssb601001fjt08e8uzki1f", // "Retake some of the photos shot by Harrison"
];
const BY = "claude: for Jordan";

const SUMMARY = "Tim called and texted about 265 Mill Rd on Oct 29. The 2D floor plans need fixing: on the 1st floor the room labels are wrong and the utility room is drawn too big, and on the 2nd floor the bottom left bedroom is missing its walk-in closet bump-out. He wants to know when the fixed plans are in the media link so he can put them on the MLS, and Zillow's interactive floor plans and 3D tour room names should match ours. The Showcase is accepted. Separately, he is unhappy with how Harrison framed the photos (long straight shots, bathrooms shot too close, the road in the front exterior, a spackle knife left in the attic shot, the unfinished utility room) and asked for some to be retaken.";

const FLOOR_LIST = [
  "Tim's list (his texts at 10:28 and 10:36 AM and the call):",
  "1st floor: Dining Room to Living Room; Family Room to Dining Room; Utilities to Laundry Room; the unlabeled room to its right is Utilities, and it is smaller than drawn (the lined wall next to the bathroom runs all the way to the exterior wall); Storage to Pantry.",
  "2nd floor: the bottom left bedroom's walk-in closet bump-out is missing. It sits over the 1st floor bump-out, same footprint, up to the roofline.",
].join("\n");

const STEPS = [
  { text: "Fix the 265 Mill Rd 2D floor plans and tell Tim when they're in the media link", ownerKey: "kyle", dueISO: "2026-10-30", kind: "task" as const, taskId: NOTIFY_TASK },
  { text: "Send the fixed plans to Zillow Showcase so its interactive floor plans and 3D tour room names match", ownerKey: "kyle", dueISO: "2026-11-02", kind: "task" as const },
  { text: "Get the Zillow Showcase request accepted", ownerKey: "kyle", kind: "task" as const, alreadyDone: "Kyle texted Tim at 11:05 AM on Oct 29 that it's accepted" },
  { text: "Review the kitchen, bathroom, front exterior, attic and utility room photos and decide on retakes", ownerKey: "jordan", dueISO: "2026-10-30", kind: "task" as const },
  { text: "Coach Harrison with notes pinned on the 265 Mill Rd photos", ownerKey: "jordan", dueISO: "2026-11-03", kind: "coach" as const },
  { text: "Add Tim's preferences to his client notes", ownerKey: "kyle", dueISO: "2026-10-30", kind: "prefs" as const },
];

const PREFERENCES = [
  "Shoot rooms on the diagonal, corner to corner, so buyers see how wide the room is; avoid long straight-on shots down a room.",
  "Kitchen: add a closer angled shot from where a buyer walks in, besides the wide views.",
  "Bathrooms: frame wide enough to show the floor and the ceiling, not just the vanity and toilet.",
  "Front exterior: frame tight on the house when a road is in front; keep the road out of the shot.",
  "Before shooting, move tools and clutter out of frame, and shoot unfinished rooms with the door closed.",
  "Take your time and frame each room the way a buyer walks into it; Tim felt the last shoot was rushed.",
];

const SHOOT_FEEDBACK = "Long straight-on shots that make rooms look long rather than wide, and too few corner shots, especially in the open kitchen. Bathrooms shot so close the floor and ceiling don't show. The front exterior taken from across the road with the road in the foreground. A spackle knife left in the attic shot, and two long shots of the unfinished utility room instead of the door closed.";

const DASHES = /[–—]/;

(async () => {
  const prisma = await db();
  const issue = await prisma.clientIssue.findUnique({ where: { id: ISSUE_ID }, select: { id: true, clientId: true, title: true, state: true, summary: true, planJson: true, dismissedAt: true } });
  if (!issue || issue.clientId !== CLIENT_ID || issue.dismissedAt || issue.state !== "OPEN") throw new Error(`Not Tim's open complaint: ${JSON.stringify(issue)}`);
  const already = await prisma.clientIssueStep.count({ where: { issueId: ISSUE_ID } });
  if (already > 0) { console.log(`It already has ${already} steps. Nothing to do.`); await prisma.$disconnect(); return; }
  for (const s of [SUMMARY, FLOOR_LIST, SHOOT_FEEDBACK, ...PREFERENCES, ...STEPS.map((x) => x.text)]) if (DASHES.test(s)) throw new Error(`A long dash in: ${s}`);
  const notify = await prisma.smartTask.findUnique({ where: { id: NOTIFY_TASK }, select: { status: true, assignedKey: true, title: true } });
  if (!notify || ["COMPLETED", "CANCELLED"].includes(notify.status)) throw new Error(`Kyle's floor plan task isn't open: ${JSON.stringify(notify)}`);
  const merged = await prisma.smartTask.findMany({ where: { id: { in: MERGED } }, select: { id: true, title: true, status: true, description: true, delegatedAt: true } });
  const jordan = await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE", email: "info@realtourpilot.com" }, select: { email: true, teamMemberId: true } });
  if (!jordan) throw new Error("Jordan's login isn't there.");

  console.log(`Complaint: ${issue.title}\nSummary now: ${issue.summary ?? "(none)"}\nDraft now: ${issue.planJson ? issue.planJson.slice(0, 80) : "(none)"}\n`);
  console.log(`New summary:\n${SUMMARY}\n`);
  console.log("Steps:");
  for (const s of STEPS) console.log(`  · ${s.ownerKey}: ${s.text}${"alreadyDone" in s ? ` [done: ${s.alreadyDone}]` : ` (due ${s.dueISO})`}${"taskId" in s ? ` [on Kyle's task "${notify.title}"]` : ""}`);
  console.log("\nClosed with a merge note:");
  for (const t of merged) console.log(`  · ${t.status}${t.delegatedAt ? " DELEGATED" : ""}: ${t.title.slice(0, 110)}`);
  console.log(`\nPreferences kept as the hub's draft (NOT saved to his notes or Aryeo):\n${PREFERENCES.map((p) => `  - ${p}`).join("\n")}`);
  if (!APPLY) { console.log("\ndry run: nothing written."); await prisma.$disconnect(); return; }

  const { addStep } = await import("../../src/lib/clientIssuePlan");
  const actor = { email: jordan.email, name: BY, role: "OWNER", keys: new Set(["jordan"]), teamMemberId: jordan.teamMemberId };
  const now = new Date();
  const draft = {
    v: 1, state: "approved", at: now.toISOString(), by: BY, model: null, error: null,
    summary: SUMMARY,
    steps: STEPS.map((s) => ({ text: s.text, ownerKey: s.ownerKey, dueBusinessDays: null, kind: s.kind, alreadyDone: "alreadyDone" in s ? s.alreadyDone : null })),
    preferences: PREFERENCES, shootFeedback: SHOOT_FEEDBACK, approvedAt: now.toISOString(), approvedBy: BY,
  };
  const cur = await prisma.clientIssue.findUnique({ where: { id: ISSUE_ID }, select: { historyJson: true } });
  const hist = (() => { try { return JSON.parse(cur?.historyJson ?? "[]") as unknown[]; } catch { return []; } })();
  const took = await prisma.clientIssue.updateMany({
    where: { id: ISSUE_ID, planJson: issue.planJson },
    data: { summary: SUMMARY, planJson: JSON.stringify(draft), historyJson: JSON.stringify([...hist, { at: now.toISOString(), by: BY, what: `Plan set up (${STEPS.length} steps) from the texts and the call` }]) },
  });
  if (took.count !== 1) throw new Error("Someone changed the plan while this ran. Stopped before any step.");

  for (const s of STEPS) {
    const r = await addStep(actor as never, ISSUE_ID, { text: s.text, ownerKey: s.ownerKey, dueISO: "dueISO" in s ? s.dueISO : null, kind: s.kind, alreadyDone: "alreadyDone" in s ? s.alreadyDone : null, taskId: "taskId" in s ? s.taskId : null });
    console.log(`${r.ok ? "made" : "FAILED"}: ${s.text} · ${r.message}`);
    if (r.ok && "taskId" in s && s.taskId) {
      const t = await prisma.smartTask.findUnique({ where: { id: s.taskId }, select: { description: true } });
      await prisma.smartTask.update({ where: { id: s.taskId }, data: { description: [t?.description, FLOOR_LIST].filter(Boolean).join("\n\n") } });
    }
  }

  const href = `/clients/${CLIENT_ID}#issue-${ISSUE_ID}`;
  for (const t of merged) {
    if (["COMPLETED", "CANCELLED"].includes(t.status)) continue;
    await prisma.smartTask.update({
      where: { id: t.id },
      data: { status: "CANCELLED", description: [t.description, `Merged into the plan on Tim's complaint (${href}) by ${BY}, Oct 29 2026: one step there covers it.`].filter(Boolean).join("\n\n") },
    });
    console.log(`closed: ${t.title.slice(0, 90)}`);
  }

  const steps = await prisma.clientIssueStep.findMany({ where: { issueId: ISSUE_ID }, orderBy: { sort: "asc" }, select: { text: true, ownerName: true, taskId: true, doneAt: true, dueAt: true } });
  console.log(`\nOn the complaint now: ${steps.length} steps`);
  for (const s of steps) console.log(`  · ${s.ownerName}: ${s.text}${s.doneAt ? " (done)" : ""}${s.taskId ? ` [task ${s.taskId}]` : ""}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
