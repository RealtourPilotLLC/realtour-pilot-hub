// ---------------------------------------------------------------------------
// DRILL: THE CREATIVE MANAGER'S DASHBOARD, RENDERED (Oct 23 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-creative-desk-render.ts
//
// The real "/" server-rendered to HTML for James, for the owner previewing
// James ("view as", read-only), and, unchanged, for Kyle, the owner and a
// review seat; and /development. Checks the spec's section order (A to H), the
// count on every section and glance chip against its list (#13), the side
// panel holding the existing actions (approve one version, the delegation
// steps, coaching and readiness), the read-only preview (#14), and the layout
// rules a phone depends on (#15): one column until the lg breakpoint, the
// table's header hidden below md, thumb-sized controls, no link inside a link.
// Set CREATIVE_RENDER_OUT=<dir> to keep the HTML for a visual check.
//
// ISOLATION: PGlite via the shared harness, every .env key blank, AUTH_ENFORCE
// on, every outbound call fenced; the delegation workflow faked at its seam.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import fs from "node:fs";
import path from "node:path";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import type { DelegatedTask } from "../../src/lib/delegation";
import type { CreativeDesk as Desk } from "../../src/lib/creativeDesk";

installNextStubs();
type Props = Record<string, unknown>;
const pending: Promise<unknown>[] = [];
interceptModule((r) => r === "next/server", (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get: (t, k) => (k === "after" ? (fn: () => unknown) => { pending.push(Promise.resolve().then(fn).catch(() => undefined)); } : t[k]),
}));
const store = new Map<string, DelegatedTask>();
interceptModule((r) => r === "@/lib/delegation" || /src[\\/]lib[\\/]delegation(\.ts)?$/.test(r), (loaded) => ({
  ...(loaded as object),
  delegationFor: async (ids: string[]) => new Map(ids.filter((id) => store.has(id)).map((id) => [id, store.get(id)!] as const)),
  tasksAssignedTo: async (key: string) => [...store.values()].filter((t) => t.assigneeKey === key),
  tasksDelegatedBy: async (email: string) => [...store.values()].filter((t) => t.assignedBy?.toLowerCase() === email.toLowerCase()),
}));
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }) : null));

function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function namesOf(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(namesOf);
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [typeof type === "string" ? type : type.name ?? "", ...Object.values(tree.props).flatMap(namesOf)];
}
const STREAMED = new Set(["OwnerBusiness", "OwnerWeekSection", "OwnerShootIssues", "KylesDaySection", "TodaysShoots", "ContentActionsSection", "OfficeDeskSection", "OwnerMoneyLine", "CaughtProblems", "CreativeDeskSection"]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const nestedLink = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)a\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";
navigation.redirect = (href) => { throw new Redirect(href); };
async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; } catch (e) { if (e instanceof Redirect) return e.href; throw e; }
}

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7342), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-creative-desk-render" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { default: home } = await import("@/app/page");
    const { default: developmentPage } = await import("@/app/development/page");
    const { CreativeDesk } = await import("@/components/creativeDesk/CreativeDesk");
    const { etAt, etDayKey } = await import("@/lib/datetime");
    const T = new Date();
    const at = (ms: number) => new Date(T.getTime() + ms);

    // ---- a small world ----
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@cdr.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "PHOTOGRAPHER", { creativeManager: true });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER");
    const patTm = await tm("Pat Seat", "MANAGER");
    const login = (name: string, email: string, role: string, teamMemberId: string | null) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await login("Jordan Spackman", "jordan@cdr.invalid", "OWNER", jordanTm.id);
    const kyle = await login("Kyle Smith", "kyle@cdr.invalid", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "james@cdr.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const pat = await login("Pat Seat", "pat@cdr.invalid", "ADMIN", patTm.id);
    await login("Harrison Wells", "harrison@cdr.invalid", "PHOTOGRAPHER", harrisonTm.id);
    const kimTm = await tm("Kim Miguel", "MANAGER");
    await prisma.appUser.create({ data: { name: "Kim Miguel", email: "kim@cdr.invalid", role: "EDITOR", teamMemberId: kimTm.id, editorKey: "kim", status: "ACTIVE" } });
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id, coverOfferHours: 9 }) } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const client = await prisma.client.create({ data: { name: "Real Agent" } });
    const desc = ["Customer:", "Name: Real Agent", "Phone: (215) 555-0101", "", "Order Questions:", "- Lock Box / Door Code: 4321"].join("\n");
    const tomorrow = etDayKey(at(D));
    const p1 = await prisma.project.create({ data: { clientId: client.id, title: "11 Upcoming Rd, Town", addressLine: "11 Upcoming Rd", status: "SCHEDULED", photographerId: jamesTm.id, scriptingId: "s1", scriptingStatus: "approved", deliverables: { create: [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Premium Reel", videoStyle: "premium_social_reel" }] } } });
    await prisma.appointment.create({ data: { aryeoId: "r1", projectId: p1.id, startAt: etAt(tomorrow, 10), endAt: etAt(tomorrow, 12), status: "SCHEDULED", assignedToId: jamesTm.id, description: desc, rawJson: JSON.stringify({ items: [{ title: "Photos" }, { title: "Premium Reel" }] }) } });
    const p2 = await prisma.project.create({ data: { clientId: client.id, title: "22 Past Ln, Town", addressLine: "22 Past Ln", status: "SCHEDULED", photographerId: harrisonTm.id, deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] } } });
    await prisma.appointment.create({ data: { aryeoId: "r2", projectId: p2.id, startAt: at(-D), endAt: at(-D + 2 * H), status: "SCHEDULED", assignedToId: harrisonTm.id, description: desc } });
    const cutJob = await prisma.project.create({ data: { clientId: client.id, title: "60 Review Rd, Town", status: "REVIEW", promisedTargetAt: at(6 * H), deliverables: { create: { type: "VIDEO", label: "Listing Reel" } } } });
    const dv = await prisma.deliverable.findFirstOrThrow({ where: { projectId: cutJob.id } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId: cutJob.id, deliverableId: dv.id, slot: 1, round: 2, kind: "video", source: "upload", status: "PENDING", fileName: "v2.mp4", submittedByKey: "kim", submittedByName: "Kim Miguel", reviewerTeamMemberId: jamesTm.id, createdAt: at(-2 * H) } });
    const item = await prisma.developmentItem.create({ data: { personId: harrisonTm.id, personName: "Harrison Wells", group: "FIELD", skill: "Upload timing", standard: "Photos in by midnight", nextAction: "Check the next three uploads", followUpAt: etAt(etDayKey(T), 9), evidenceJson: JSON.stringify([{ label: "70 Late Ave: photos in two days late", href: "/projects/x", at: at(-5 * D).toISOString(), source: "field:x:kpi:upload" }]), logJson: JSON.stringify([{ at: at(-D).toISOString(), by: "James Livingston", kind: "created", note: "Talked through the deadlines" }]), createdBy: "James Livingston" } });
    const assessment = await prisma.readinessAssessment.create({ data: { personId: harrisonTm.id, personName: "Harrison Wells", track: "PREMIUM", criteriaJson: JSON.stringify([{ key: "kpi:quality", label: "Quality and QC", source: "kpi", covers: "Technical quality", met: "yes", evidence: "Twelve premium reels" }, { key: "james:1", label: "Leads the agent on site", source: "james", covers: null, met: "unknown", evidence: null }]), recommendation: "READY_WITH_SUPPORT", createdBy: "James Livingston" } });
    const imp = await prisma.smartTask.create({ data: { taskType: "process_improvement", source: "manual", status: "OPEN", title: "Improve: upload checklist", summary: "Upload pages arrive without creative notes", assignedKey: "james" } });
    await prisma.appSetting.create({ data: { key: `creative_improvement:${imp.id}`, value: JSON.stringify({ area: "Uploads and handoffs", nextStep: "Draft the notes checklist", outcome: "Every upload has notes", policy: false, at: T.toISOString(), by: "James" }) } });
    const task = await prisma.smartTask.create({ data: { taskType: "delegated", source: "manual", status: "OPEN", title: "Prepare a coaching plan", assignedKey: "james", dueAt: at(2 * H) } });
    store.set(task.id, { taskId: task.id, title: "Prepare a coaching plan", outcome: "A plan for Harrison's uploads", assigneeKey: "james", assigneeName: "James", assignedBy: "jordan@cdr.invalid", assignedAt: at(-H).toISOString(), dueAt: at(2 * H).toISOString(), state: "ASSIGNED", needsVerification: false, latestUpdate: null, blocker: null, nextStep: null, clientId: null, projectId: null, sourceHref: null });
    await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", title: "Send the $300 quote — then follow up", assignedKey: "james" } });

    // =====================================================================
    c.head("§1 · James's '/' is his dashboard, A to H in the spec's order");
    // =====================================================================
    await signIn(james);
    const jTree = await settle(await home({}));
    const jHtml = ssr(jTree);
    const jNames = namesOf(jTree);
    const desk = elements(jTree, "CreativeDesk")[0]?.desk as Desk | undefined;
    c.ok("it renders the creative desk, and none of the old cards", !jHtml.startsWith("RENDER FAILED") && !!desk && jHtml.includes("data-creative-desk") && ["HealthStrip", "NeedsAttention", "TodaysShoots", "ShootsInProgress", "KylesDayCard", "ContentActionsCard", "OfficeDesk"].every((n) => !jNames.includes(n)), jHtml.slice(0, 300));
    c.ok("the greeting and the subtitle the mockup names; View my schedule", /Good (morning|afternoon|evening), James/.test(jHtml) && jHtml.includes("Your shoots, creative quality, and team development.") && jHtml.includes('href="/schedule"'));
    const order = ["glance", "production", "review", "team", "readiness", "prep", "improvements", "assigned", "closeout"].map((s) => jHtml.indexOf(`data-section="${s}"`));
    c.ok("sections in order: glance, My Production, Creative Review, Team Development (readiness inside), Creative Preparation, Process Improvements, Assigned to Me, End-of-day check", order.every((i) => i > 0) && order.every((i, n) => n === 0 || i > order[n - 1]), JSON.stringify(order));
    c.ok("the section titles", ["Today at a glance", "My Production", "Creative Review", "Team Development &amp; Quality", "Readiness assessments", "Creative Preparation", "Process Improvements", "Assigned to Me &amp; Handoffs", "End-of-day check"].every((t) => jHtml.includes(t)));

    // =====================================================================
    c.head("§2 · #13 every count is the length of its list");
    // =====================================================================
    const count = (attr: string, key: string) => jHtml.match(new RegExp(`data-${attr}="${key}" data-count="([^"]+)"`))?.[1] ?? jHtml.match(new RegExp(`data-${attr}="${key}"[^>]*data-count="([^"]+)"`))?.[1];
    c.ok("glance: shoots today, reviews ready, follow-ups due, urgent tasks, each equal to its list", !!desk && count("glance", "shoots") === String(desk.production.mine.filter((s) => s.today).length) && count("glance", "reviews") === String(desk.review.ready.length) && count("glance", "followups") === String(desk.team!.dueIds.length) && count("glance", "urgent") === String(desk.assigned.items.filter((a) => a.urgent).length), JSON.stringify(["shoots", "reviews", "followups", "urgent"].map((k) => count("glance", k))));
    c.ok("…and they are real here: 1 review ready, 1 follow-up due, 1 urgent task", count("glance", "reviews") === "1" && count("glance", "followups") === "1" && count("glance", "urgent") === "1");
    c.ok("sections: the count each one carries is its list's length", !!desk
      && count("section", "review") === String(desk.review.ready.length)
      && count("section", "improvements") === String(desk.improvements.items.length)
      && count("section", "assigned") === String(desk.assigned.items.length)
      && count("section", "prep") === String(desk.prep.items.length)
      && count("section", "readiness") === String(desk.readiness!.items.length)
      && (jHtml.match(/data-task="/g) ?? []).length === Math.min(desk.assigned.items.length, 5)
      && (jHtml.match(/data-cut="/g) ?? []).length === desk.review.ready.length + desk.review.delayed.length);
    c.ok("the glance line names what needs him (never 'Nothing needs you' while items exist)", /ready for your review/.test(jHtml) && !/Nothing needs you/.test(jHtml));
    c.ok("an improvement is shown once (G), never again in H", (jHtml.match(new RegExp(`data-improvement="${imp.id}"`, "g")) ?? []).length === 1 && !jHtml.includes(`data-task="${imp.id}"`));

    // =====================================================================
    c.head("§3 · the rows say what the mockup says, from the records");
    // =====================================================================
    c.ok("My Production: his visit with its prep chips and Open brief; the team's shoot apart", jHtml.includes('data-shoot=') && jHtml.includes("Access noted") && jHtml.includes(`href="/shoot/${p1.id}"`) && jHtml.includes("Open brief") && jHtml.includes('data-list="team-handoffs"') && jHtml.includes(`data-handoff="${p2.id}" data-mine="false"`));
    c.ok("Creative Review: version, editor, Review and Decide; the approval rule in words", jHtml.includes(`data-cut="${cut.id}" data-version="2"`) && jHtml.includes("Version 2 · Kim Miguel") && jHtml.includes("Approval covers that one version and sends it to Kyle") && jHtml.includes("It never delivers to the client"));
    c.ok("Team Development: three groups, the recorded item with its next step, honest empty groups", ["FIELD", "EDITOR", "QC"].every((g) => jHtml.includes(`data-group="${g}"`)) && jHtml.includes("Next step: Check the next three uploads") && jHtml.includes("Record feedback") && jHtml.includes("No recorded coaching and no quality evidence for editors right now."));
    c.ok("Readiness: criteria met, his recommendation, Recommend to Jordan; Jordan decides staffing", jHtml.includes(`data-readiness="${assessment.id}"`) && jHtml.includes("1 of 2 criteria met · You recommend: Ready with support") && jHtml.includes("Recommend to Jordan") && jHtml.includes("Jordan makes staffing and pay decisions."));
    c.ok("Creative Preparation: the listing script's ownership is explicit (Jordan owns)", jHtml.includes(`data-prep="listing:${p1.id}" data-mode="JORDAN_OWNS"`) && jHtml.includes("Writer: Jordan · Approver: Jordan"));
    c.ok("Assigned to Me: who assigned, the state, Accept", jHtml.includes(`data-task="${task.id}" data-state="ASSIGNED"`) && jHtml.includes("Awaiting acceptance") && jHtml.includes("From Jordan"));
    c.ok("End-of-day check: the four lines, and the rule that a tick completes nothing", ["My uploads and handoffs complete", "Due reviews handled, or exceptions documented", "Coaching follow-ups recorded", "Blockers have an owner and a next step"].every((w) => jHtml.includes(w)) && jHtml.includes("It never completes a task.") && (jHtml.match(/data-tick="/g) ?? []).length === 4);
    c.ok("no figures and no em dashes anywhere on his page", !/\$\d/.test(jHtml) && !/—/.test(jHtml.slice(jHtml.indexOf("data-creative-desk"))), (jHtml.match(/.{40}(\$\d|—).{40}/) ?? [""])[0]);

    // =====================================================================
    c.head("§4 · the side panel holds the existing actions");
    // =====================================================================
    const panel = (p: unknown) => ssr(createElement(CreativeDesk, { desk: desk!, initialPanel: p as never }));
    const cutPanel = panel({ kind: "cut", id: cut.id });
    c.ok("a cut: Review version 2 (the workspace), Approve version 2 (approveCut), Escalate; approval is not delivery", cutPanel.includes(`data-side-panel="cut:${cut.id}"`) && cutPanel.includes("Approve version 2") && cutPanel.includes('data-control="approve"') && cutPanel.includes("it is not delivered to the client") && cutPanel.includes('data-control="escalate-cut"') && cutPanel.includes(`/review/${cutJob.id}?cut=${cut.id}`));
    const devPanel = panel({ kind: "dev-item", id: item.id });
    c.ok("a coaching item: its examples, history, and Record feedback / follow-up / plan / practice / verify", devPanel.includes("70 Late Ave: photos in two days late") && devPanel.includes("data-log") && ["feedback", "follow-up", "plan", "practice", "verify"].every((k) => devPanel.includes(`data-control="${k}"`)) && devPanel.includes("Assign a practice activity"));
    const rPanel = panel({ kind: "readiness", id: assessment.id });
    c.ok("an assessment: the criteria (KPI terms and his own, labelled), evidence boxes, recommendation, Recommend to Jordan", rPanel.includes("from the KPI terms") && rPanel.includes("James&#x27;s criterion") && rPanel.includes("Evidence reviewed") && rPanel.includes('data-control="recommend"') && rPanel.includes("nothing about staffing or pay changes from here"));
    const tPanel = panel({ kind: "task", id: task.id });
    c.ok("an assigned task: Accept, Update, Flag blocker, Complete, Escalate", ["Accept", "Update", "Flag blocker", "Complete", "Escalate"].every((w) => tPanel.includes(`>${w}</button>`)));
    const gone = panel({ kind: "cut", id: "cmgonegonegone0000000000" });
    c.ok("an item that left the list says so in the panel (the page stays)", gone.includes("has left the list"));

    // =====================================================================
    c.head("§5 · #15 desktop and phone");
    // =====================================================================
    const deskHtml = jHtml.slice(jHtml.indexOf("data-creative-desk"));
    const sectionsHtml = jHtml.slice(jHtml.indexOf('data-section="production"') - 400);
    c.ok("the glance's four numbers sit two by two on a phone, in one row from sm", /class="grid grid-cols-2 items-center gap-x-3 sm:flex/.test(deskHtml));
    c.ok("one column on a phone, two from the lg breakpoint (no fixed multi-column grid below lg)", /class="grid items-start gap-4 lg:grid-cols-2"/.test(sectionsHtml) && !/[" ]grid-cols-2/.test(sectionsHtml.replace(/(sm|md|lg):grid-cols-\d/g, "")), (sectionsHtml.match(/class="[^"]*grid-cols[^"]*"/g) ?? []).join(" | "));
    c.ok("the task table's header shows from md; each row stacks on a phone", /class="hidden grid-cols-\[[^"]*md:grid"/.test(deskHtml) && /data-task="[^"]+"[^>]*class="grid gap-1 px-3 py-2 md:grid-cols/.test(deskHtml));
    c.ok("thumb-sized controls (min-h-11) and no link inside a link", (deskHtml.match(/min-h-11/g) ?? []).length >= 15 && !nestedLink(jHtml));
    c.ok("long words wrap instead of widening the page", (deskHtml.match(/\[overflow-wrap:anywhere\]/g) ?? []).length >= 6 && !/w-\[\d{3,}px\]/.test(deskHtml));

    // =====================================================================
    c.head("§6 · #14 the owner's 'view as James' is read-only");
    // =====================================================================
    await signIn(owner, james.id);
    const vTree = await settle(await home({}));
    const vHtml = ssr(vTree);
    const vDesk = elements(vTree, "CreativeDesk")[0]?.desk as Desk | undefined;
    c.ok("previewing James shows his dashboard, marked read-only", !!vDesk && vDesk.readOnly && vHtml.includes('data-readonly="true"') && vHtml.includes("Preview: read-only. The buttons are off while you view as James."));
    c.ok("…no write controls: no Record feedback, no Log one, no Start one, every tick disabled", !vHtml.includes(">Record feedback<") && !vHtml.includes("Log one") && !vHtml.includes("Start one") && (vHtml.match(/data-tick="[a-z]+"[^>]*disabled|disabled=""[^>]*data-tick/g) ?? []).length === 4);
    const vPanel = ssr(createElement(CreativeDesk, { desk: vDesk!, initialPanel: { kind: "cut", id: cut.id } as never }));
    c.ok("…and its panels offer no actions", vPanel.includes("Actions are off") && !vPanel.includes('data-control="approve"') && !vPanel.includes('data-control="escalate-cut"'));

    // =====================================================================
    c.head("§7 · everyone else's home is unchanged; /development is the owner's and James's");
    // =====================================================================
    await signIn(kyle);
    const kNames = namesOf(await settle(await home({})));
    c.ok("Kyle keeps his desk", kNames.includes("OfficeDesk") && !kNames.includes("CreativeDesk"));
    await signIn(owner);
    const oNames = namesOf(await settle(await home({})));
    c.ok("the owner keeps his dashboard", oNames.includes("HealthStrip") && !oNames.includes("CreativeDesk"));
    const { putSetting } = await import("@/lib/settings");
    await putSetting("review_room", { creativeApproverTeamMemberId: patTm.id, backupReviewerTeamMemberId: kyleTm.id, coverOfferHours: 9 });
    await signIn(pat);
    const sNames = namesOf(await settle(await home({})));
    c.ok("the review seat (an office login holding the approver seat) keeps its dashboard", sNames.includes("HealthStrip") && !sNames.includes("CreativeDesk") && !sNames.includes("OfficeDesk"), sNames.filter((n) => /Health|Desk/.test(n)).join());
    await putSetting("review_room", { creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id, coverOfferHours: 9 });
    await signIn(kyle);
    c.ok("/development sends the office home", (await redirectOf(() => developmentPage({ searchParams: Promise.resolve({}) }))) === "/");
    await signIn(james);
    const devTree = await developmentPage({ searchParams: Promise.resolve({ assessment: assessment.id }) });
    const devHtml = ssr(devTree);
    c.ok("/development for James: the full team, readiness and improvements, Jordan's link opens the assessment", devHtml.includes('data-mode="development"') && devHtml.includes('data-section="team"') && devHtml.includes('data-section="improvements"') && !devHtml.includes('data-section="production"') && devHtml.includes(`data-side-panel="readiness:${assessment.id}"`));
    await signIn(owner);
    const oDev = ssr(await developmentPage({ searchParams: Promise.resolve({}) }));
    c.ok("…and for the owner", oDev.includes('data-section="team"') && oDev.includes("Readiness assessments"));

    if (process.env.CREATIVE_RENDER_OUT) {
      fs.mkdirSync(process.env.CREATIVE_RENDER_OUT, { recursive: true });
      fs.writeFileSync(path.join(process.env.CREATIVE_RENDER_OUT, "james.html"), jHtml);
      fs.writeFileSync(path.join(process.env.CREATIVE_RENDER_OUT, "james-panel.html"), devPanel);
    }
    while (pending.length) await pending.shift();
    c.ok("nothing left the box; rendering wrote nothing of James's", fence.blocked.length === 0 && (await prisma.appSetting.count({ where: { key: { startsWith: "creative_closeout:" } } })) === 0, fence.blocked.join(", "));
    c.summary();
  } finally { quiet.restore(); fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
