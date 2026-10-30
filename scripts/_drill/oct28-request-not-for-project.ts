// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: "Not for this project" (Kyle, Oct 28 2026, 825 State St).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct28-request-not-for-project.ts
//
// Kyle: "This request was assigned to this project but it was just a general
// request for a future video, not this one, needs an option besides 'Checked'
// to disregard it or unassign it to the project (Or potentially mark it as a
// task for a different project or leave it as a follow up for a future
// project)". And on the Projects list's Requests tab: "It would be nice to
// have the client's requests included in this page rather than having to
// open the project page to view it."
//
//   1  the pure part (requestPlacementCore): which brief lines are a
//      request's own, the words, Undo only where the request still sits
//   2  Ashley Brunner's text filed on 825 State St (the Smart Brain's pick),
//      with its "Client request (openphone)" brief line; it shows on the
//      job's cards, the Projects tab, the shoot brief
//   3  Move to another open project: the request and its brief line go; an
//      unrelated line and request stay; both timelines; the choices are the
//      client's open projects only (an assistant's folded account too)
//   4  Undo puts it all back
//   5  Keep for a future project: off every project, its line kept as an
//      office note; on the client page; offered on a project booked after,
//      not one booked before; put on it, Undo, Undo again
//   6  the Smart Brain does not file it on 825 again (replay, new reading,
//      the comms brief line), but may on another job
//   7  Not a request, then the checklist's Reopen (reopenAskAction) puts it back
//   8  a Request typed in the composer, and one logged on site, move with
//      their own lines
//   9  refusals: moved meanwhile, closed, another client, delivered, the same
//      project, no pick, view-as, a photographer, bad ids; Undo after
//      someone changed it. And a sibling: a request the brain filed on no
//      project is put on one (or set aside) from the client page, with Undo
//  10  the screens: the project page's card and "Taken off this project"
//      panel, the Projects Requests tab, the saved list, the button itself
//      (its real state and presses), phone classes, no dashes anywhere
//
// ISOLATION: PGlite via the shared harness; every outbound call fenced.
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

type Me = { id: string; email: string; name: string | null; role: string; permissions: null; status: string; teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: null; impersonating: boolean; realRole: string; realName: string | null } | null;
let me: Me = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
let refreshed = 0;
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() { refreshed++; }, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/jobs";
  nav.useSearchParams = () => new URLSearchParams();
}

const PORT = Number(process.env.DRILL_PORT ?? 5643);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DASH = /[—–]|&mdash;|&ndash;/;
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/\s+/g, " ");
const user = (role: string, extra: Partial<NonNullable<Me>> = {}): NonNullable<Me> => ({ id: `u-${role}`, email: `${role.toLowerCase()}@x.test`, name: role === "OWNER" ? "Jordan Spackman" : "Kyle Smith", role, permissions: null, status: "ACTIVE", teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: role === "OWNER" ? "Jordan Spackman" : "Kyle Smith", ...extra });

// The element tree, walked (the hooks harness below renders the real component without a DOM).
type El = { type: any; props: Record<string, any> };
function walk(n: any, visit: (e: El) => void) {
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isValidElement(n)) return;
  visit(n as unknown as El);
  for (const v of Object.values((n as unknown as El).props)) walk(v, visit);
}
const findBy = (tree: any, pred: (e: El) => boolean): El[] => { const out: El[] = []; walk(tree, (e) => { if (pred(e)) out.push(e); }); return out; };
function words(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (isValidElement(n)) words((n as unknown as El).props.children, out);
  return out;
}
const textOf = (n: any) => words(n).join("").replace(/\s+/g, " ").trim();
// A <Status r={...}/> line is not rendered by the harness: read the result it was given.
const saidIn = (tree: any, message: string) => findBy(tree, (e) => e.props?.r?.message === message).length > 0;
function mountHooks(render: () => unknown) {
  const react = load("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [];
  let index = 0;
  const pending: Promise<unknown>[] = [];
  type Fx = { deps?: unknown[]; cleanup?: () => void };
  const effects: (() => void)[] = [];
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? (next as (v: unknown) => unknown)(cells[slot]) : next; }]; },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; pending.push(Promise.resolve(callback()).finally(() => { cells[slot] = false; })); }]; },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const slot = index++;
      const old = cells[slot] as Fx | undefined;
      if (old && deps && old.deps && deps.every((v, i) => v === old.deps![i])) return;
      effects.push(() => { old?.cleanup?.(); const cleanup = effect(); cells[slot] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined } satisfies Fx; });
    },
  };
  return {
    render() {
      index = 0;
      const internals = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const before = internals.H;
      internals.H = dispatcher;
      try { const tree = render(); effects.splice(0).forEach((e) => e()); return tree; } finally { internals.H = before; }
    },
    async settle() { while (pending.length) await pending.shift(); },
    unmount() { for (const c of cells) (c as Fx | undefined)?.cleanup?.(); },
  };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct28-request-not-for-project" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const said: string[] = []; // every message and timeline line, for the dash check
  try {
    const { prisma } = await import("@/lib/prisma");
    const core = await import("@/lib/requestPlacementCore");
    const rp = await import("@/lib/requestPlacement");
    const ca = await import("@/lib/clientAsks");
    const acts = await import("@/app/jobs/requestActions");
    const { etDayKey } = await import("@/lib/datetime");
    me = user("OWNER");

    // =========================================================================
    c.head("1 · the pure part");
    // =========================================================================
    const MSG = "Hi! I want a reel like this with specific points to our selling experience https://www.instagram.com/reel/C9xYz";
    const ASK_TEXT = "I want a reel like this with specific points to our selling experience";
    c.ok("the message's own brief line is the request's (its words, or the message's)",
      core.isLineOfAsk(`Client request (openphone): ${MSG}`, { text: ASK_TEXT, summary: "A reel about our selling experience" }, MSG) &&
      core.isLineOfAsk(`Client request (gmail): ${ASK_TEXT}`, { text: ASK_TEXT }, null) &&
      core.isLineOfAsk(`Client request (on site, logged by Harrison Lee): Shoot the shed too`, { text: "Shoot the shed too" }, null));
    c.ok("…a staff line, another request's line, or a too-short match is not",
      !core.isLineOfAsk("Bring the drone for the lot", { text: "Bring the drone for the lot" }, null) &&
      !core.isLineOfAsk("Client request (openphone): Please blur the neighbor's for sale sign", { text: ASK_TEXT }, MSG) &&
      !core.isLineOfAsk("Client request (openphone): a reel", { text: ASK_TEXT }, null));
    c.ok("the words: Moved to / Kept for a future project / Put on / Not a request / Set aside, not needed",
      core.outcomeWords({ kind: "move", toStreet: "512 Firethorn Rd", from: { projectId: "a", state: "OPEN" } }) === "Moved to 512 Firethorn Rd" &&
      core.outcomeWords({ kind: "future", toStreet: null, from: { projectId: "a", state: "OPEN" } }) === "Kept for a future project" &&
      core.outcomeWords({ kind: "place", toStreet: "40 Next Booking Rd", from: { projectId: null, state: "FUTURE" } }) === "Put on 40 Next Booking Rd" &&
      core.outcomeWords({ kind: "dismiss", toStreet: null, from: { projectId: "a", state: "OPEN" } }) === "Not a request" &&
      core.outcomeWords({ kind: "dismiss", toStreet: null, from: { projectId: null, state: "FUTURE" } }) === "Set aside, not needed");
    const rec = (id: string, from: string | null, to: string | null, toState = "OPEN") => ({ id, kind: "move" as const, from: { projectId: from, state: "OPEN" }, to: { projectId: to, state: toState }, lines: [] });
    const hist = [{ at: "x", by: "Kyle", what: "m", placed: rec("r1", "A", "B") }, { at: "y", by: "Kyle", what: "m", placed: rec("r2", "B", "C") }];
    c.ok("Undo reverses the newest change only while the request still sits where it put it",
      core.undoable(hist, { projectId: "C", state: "OPEN" })?.record.id === "r2" && core.undoable(hist, { projectId: "C", state: "CONFIRMED" }) === null &&
      core.undoable([...hist, { at: "z", by: "Kyle", what: "u", undo: { undoes: "r2" } }], { projectId: "B", state: "OPEN" })?.record.id === "r1");
    c.ok("taken off A stays taken off A until it is back open on A",
      core.takenOffProject(hist, "A", { projectId: "C", state: "OPEN" })?.id === "r1" && core.takenOffProject(hist, "A", { projectId: "A", state: "OPEN" }) === null && core.takenOffProject(hist, "Z", { projectId: "C", state: "OPEN" }) === null);
    c.ok("bad history reads as none", core.parseHistory("not json").length === 0 && core.parseHistory('{"a":1}').length === 0 && core.parseHistory(null).length === 0);

    // =========================================================================
    c.head("2 · Ashley's text, filed on 825 State St");
    // =========================================================================
    const T = Date.now();
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Lee", email: "harrison@drill.test", role: "PHOTOGRAPHER", phone: "+16105550101" } as never, select: { id: true } });
    const ashley = await prisma.client.create({ data: { name: "Ashley Brunner", phone: "(610) 555-0177" }, select: { id: true } });
    const assistant = await prisma.client.create({ data: { name: "Ashley's Assistant", parentClientId: ashley.id } as never, select: { id: true } });
    const other = await prisma.client.create({ data: { name: "Marcee Malvern" }, select: { id: true } });
    const SHOOT = new Date(T + 2 * DAY);
    const mk = async (title: string, o: { client?: string; status?: string; shoot?: Date | null; appt?: boolean; deliveredAt?: Date | null; video?: boolean } = {}) =>
      (await prisma.project.create({
        data: {
          title, clientId: o.client ?? ashley.id, status: (o.status ?? "EDITING") as never, shootDate: o.shoot ?? null, deliveredAt: o.deliveredAt ?? null, photographerId: harrison.id,
          orderItems: { create: [{ title: "HDR Photos", amount: 20000 }, ...(o.video ? [{ title: "Cinematic Video", amount: 45000 }] : [])] },
          deliverables: { create: [{ type: "PHOTOS" as never, status: "PENDING" as never }, ...(o.video ? [{ type: "VIDEO" as never, status: "PENDING" as never }] : [])] },
          ...(o.appt && o.shoot ? { appointments: { create: [{ aryeoId: `appt-${title.slice(0, 12)}`, startAt: o.shoot, endAt: new Date(o.shoot.getTime() + HOUR), assignedToId: harrison.id, status: "CONFIRMED" }] } } : {}),
        } as never,
        select: { id: true },
      })).id;
    const state = await mk("825 State St, Philadelphia, PA", { status: "SCHEDULED", shoot: SHOOT, appt: true, video: true });
    const fire = await mk("512 Firethorn Rd, Malvern, PA", { status: "EDITING", shoot: new Date(T - 2 * DAY), video: true });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit", status: "OPEN", assignedKey: "john", projectId: fire, clientId: ashley.id, dedupeKey: `edit-video-${fire}` } as never });
    const teamJob = await mk("77 Team Way, Paoli, PA", { client: assistant.id, status: "SCHEDULED", shoot: new Date(T + 5 * DAY) });
    const oldJob = await mk("9 Old Mill Ln, Malvern, PA", { status: "DELIVERED", shoot: new Date(T - 20 * DAY), deliveredAt: new Date(T - 15 * DAY) });
    const otherJob = await mk("3 Elm Ct, Exton, PA", { client: other.id });

    // Already on 825's brief: a staff line, and an earlier request of hers with its own line.
    await prisma.activity.create({ data: { projectId: state, type: "SPECIAL_REQUEST", body: "Bring the drone for the lot" } });
    const blur = await ca.createAsk({ clientId: ashley.id, projectId: state, kind: "SPECIAL_REQUEST", source: "text", medium: "photo", text: "Please blur the neighbor's for sale sign", summary: "Blur the neighbor's for sale sign", askedBy: "Ashley Brunner", askedAt: new Date(T - 2 * HOUR) });
    await prisma.activity.create({ data: { projectId: state, type: "SPECIAL_REQUEST", body: "Client request (openphone): Please blur the neighbor's for sale sign" } });

    // Her 10:08 AM text, as comms files it: the brief line, then the brain's ask on the one job it picked.
    const log = await prisma.commLog.create({ data: { channel: "text", direction: "in", clientId: ashley.id, clientName: "Ashley Brunner", contactName: "Ashley Brunner", fromPhone: "6105550177", body: MSG, occurredAt: new Date(T), source: "openphone", projectId: state } });
    const reelLine = await prisma.activity.create({ data: { projectId: state, type: "SPECIAL_REQUEST", body: `Client request (openphone): ${MSG}` } });
    const brainAsk = { kind: "SPECIAL_REQUEST" as const, text: ASK_TEXT, summary: "A reel like this one, with points about our selling experience", medium: "video" as const, projectHint: null };
    const filed = await ca.fileAsksFromMessage({ clientId: ashley.id, clientName: "Ashley Brunner", contactName: "Ashley Brunner", message: MSG, channel: "text", sourceRef: log.id, asks: [brainAsk], defaultProjectId: state });
    const reel = filed.filed[0];
    c.ok("the Smart Brain filed it on 825 State St", filed.filed.length === 1 && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: reel } })).projectId === state, JSON.stringify(filed));
    const vid = async (pid: string) => (await ca.jobRequests(pid, "video")).map((r) => r.id);
    c.ok("…so it is on 825's video card", (await vid(state)).includes(reel));
    const cards0 = await rp.openRequestCards([state, fire]);
    const card0 = cards0.get(state)?.find((x) => x.id === reel);
    c.ok("…and on the Projects Requests tab: the request, who it is for, who asked how and when",
      !!card0 && card0.summary === brainAsk.summary && card0.forLine === "Harrison · at the shoot" && /^Ashley Brunner by text, [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, \d+:\d{2} (AM|PM)$/.test(card0.fromLine) && card0.text === ASK_TEXT && !card0.needsOwner,
      JSON.stringify(card0));
    const briefOf = async () => {
      const pb = await import("@/lib/photographerBrief");
      const b = (await pb.buildBriefDays([etDayKey(SHOOT)], { teamMemberIds: [harrison.id] })).briefs[0];
      const s = b?.shoots.find((x) => x.projectId === state);
      return s ? JSON.stringify([s.requests, s.must, s.leave, s.earlier]) : "(no brief)";
    };
    const brief0 = await briefOf();
    c.ok("…and in Harrison's shoot brief, beside the earlier ones", /reel like this/i.test(brief0) && /blur the neighbor/i.test(brief0), brief0);

    // =========================================================================
    c.head("3 · Move it to another open project");
    // =========================================================================
    const ctx = await rp.placementContext(reel);
    const choiceIds = ctx.ok ? ctx.choices.map((x) => x.id) : [];
    c.ok("the choices: the client's other open projects, her assistant's too; not 825, not delivered, not another client's",
      ctx.ok && ctx.street === "825 State St" && ctx.clientName === "Ashley Brunner" && choiceIds.includes(fire) && choiceIds.includes(teamJob) && !choiceIds.includes(state) && !choiceIds.includes(oldJob) && !choiceIds.includes(otherJob),
      JSON.stringify(ctx));
    c.ok("…each named by street and its shoot day", ctx.ok && ctx.choices.every((x) => /^\d+ [A-Z][a-z]+ [A-Z][a-z]+, shoot [A-Z][a-z]{2} \d+$/.test(x.label)), JSON.stringify(ctx.ok && ctx.choices));
    me = user("ADMIN");
    const moved = await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "move", toProjectId: fire });
    said.push(moved.message);
    c.ok("Kyle presses Move: 'Moved to 512 Firethorn Rd.'", moved.ok && moved.message === "Moved to 512 Firethorn Rd.", moved.message);
    const askNow = () => prisma.clientAsk.findUniqueOrThrow({ where: { id: reel } });
    c.ok("…the request is open on Firethorn now", (await askNow()).projectId === fire && (await askNow()).state === "OPEN");
    const lineNow = () => prisma.activity.findUniqueOrThrow({ where: { id: reelLine.id } });
    c.ok("…its brief line went with it, word for word", (await lineNow()).projectId === fire && (await lineNow()).type === "SPECIAL_REQUEST" && (await lineNow()).body === `Client request (openphone): ${MSG}`);
    const lines825 = async () => (await prisma.activity.findMany({ where: { projectId: state, type: "SPECIAL_REQUEST" }, select: { body: true } })).map((a) => a.body);
    c.ok("…the staff line and her other request stayed on 825", JSON.stringify((await lines825()).sort()) === JSON.stringify(["Bring the drone for the lot", "Client request (openphone): Please blur the neighbor's for sale sign"]) && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: blur!.id } })).projectId === state);
    const sys = async (pid: string) => (await prisma.activity.findMany({ where: { projectId: pid, type: "SYSTEM" }, orderBy: { createdAt: "asc" }, select: { body: true } })).map((a) => a.body);
    const t825 = await sys(state), tFire = await sys(fire);
    said.push(...t825, ...tFire);
    c.ok("both timelines say who did what: 825 'taken off ... moved to 512 Firethorn Rd', Firethorn 'moved here from 825 State St'",
      t825.some((b) => b.startsWith("Client request taken off this project by Kyle Smith: moved to 512 Firethorn Rd.") && b.includes(brainAsk.summary)) &&
      tFire.some((b) => b.startsWith("Client request moved here from 825 State St by Kyle Smith.")), JSON.stringify([t825, tFire]));
    const h1 = core.parseHistory((await askNow()).historyJson);
    c.ok("…and the request's own history: who, when, what", h1.some((e) => e.by === "Kyle Smith" && e.what === "moved to 512 Firethorn Rd (not for 825 State St)" && !!Date.parse(e.at) && e.placed?.lines.length === 1), JSON.stringify(h1.map((e) => e.what)));
    c.ok("gone from 825's cards and the Projects tab; on Firethorn's, for its video editor",
      !(await vid(state)).includes(reel) && (await vid(fire)).includes(reel) &&
      !(await rp.openRequestCards([state])).get(state)!.some((x) => x.id === reel) && (await rp.openRequestCards([fire])).get(fire)!.find((x) => x.id === reel)?.forLine === "Jhon · video editing");
    const brief1 = await briefOf();
    c.ok("gone from Harrison's shoot brief for 825 (the other request is still there)", !/reel like this/i.test(brief1) && /blur the neighbor/i.test(brief1), brief1);
    const off1 = await rp.takenOffProjectList(state);
    c.ok("825 lists it under 'Taken off this project' with its Undo", off1.length === 1 && off1[0].askId === reel && /^Moved to 512 Firethorn Rd by Kyle Smith, [A-Z][a-z]{2}, /.test(off1[0].line) && off1[0].canUndo, JSON.stringify(off1));
    const jb = await import("@/lib/jobsBoard");
    const reqs = async (pid: string) => (await jb.jobsBoard(new Date())).rows.find((r) => r.projectId === pid)?.requests;
    c.ok("the Projects counts follow (825: 1 open, Firethorn: 1)", (await reqs(state))?.open === 1 && (await reqs(fire))?.open === 1, JSON.stringify([await reqs(state), await reqs(fire)]));

    // =========================================================================
    c.head("4 · Undo");
    // =========================================================================
    const undone = await acts.undoRequestPlacementAction(reel);
    said.push(undone.message);
    c.ok("'Undone: back on 825 State St.'", undone.ok && undone.message === "Undone: back on 825 State St.", undone.message);
    c.ok("…the request and its line are back on 825 as they were", (await askNow()).projectId === state && (await askNow()).state === "OPEN" && (await lineNow()).projectId === state && (await lineNow()).body === `Client request (openphone): ${MSG}`);
    const t825b = await sys(state), tFireb = await sys(fire);
    said.push(...t825b, ...tFireb);
    c.ok("…both timelines say so", t825b.some((b) => b.startsWith('Kyle Smith pressed Undo on "Moved to 512 Firethorn Rd": the client request is back on this project.')) && tFireb.some((b) => b.startsWith("Kyle Smith pressed Undo: the client request went back to 825 State St.")));
    c.ok("…and 825's 'Taken off' list is empty again", (await rp.takenOffProjectList(state)).length === 0);
    const again = await acts.undoRequestPlacementAction(reel);
    c.ok("a second Undo has nothing to undo", !again.ok && again.message === "Nothing to undo.", again.message);

    // =========================================================================
    c.head("5 · Keep for a future project");
    // =========================================================================
    const kept = await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "future" });
    said.push(kept.message);
    c.ok("'Kept for Ashley Brunner's next project. It is on their client page.'", kept.ok && kept.message === "Kept for Ashley Brunner's next project. It is on their client page.", kept.message);
    c.ok("…on no project, kept for later", (await askNow()).projectId === null && (await askNow()).state === "FUTURE");
    const keptLine = await lineNow();
    said.push(keptLine.body);
    c.ok("…its brief line is an office note on 825 now ('Taken off this project (Kyle Smith, kept for a future project): ...')",
      keptLine.type === "NOTE" && keptLine.projectId === state && keptLine.body === `Taken off this project (Kyle Smith, kept for a future project): Client request (openphone): ${MSG}`, keptLine.body);
    c.ok("gone from every project's cards, the shoot brief and Kyle's open count", !(await vid(state)).includes(reel) && !(await vid(fire)).includes(reel) && !/reel like this/i.test(await briefOf()) && (await ca.askBoardCounts(new Date())).special.open === 1, JSON.stringify((await ca.askBoardCounts(new Date())).special));
    const sb = await ca.specialRequestsBoard(new Date());
    c.ok("…and from the Special requests board, open and closed", !JSON.stringify(sb).includes(reel));
    const savedC = await rp.savedRequestsForClient(ashley.id);
    c.ok("on Ashley's client page: 'Kept from 825 State St by Kyle Smith, <day>', with her open projects to put it on",
      savedC.saved.length === 1 && savedC.saved[0].askId === reel && /^Kept from 825 State St by Kyle Smith, [A-Z][a-z]{2} \d+$/.test(savedC.saved[0].keptLine) && savedC.saved[0].from === "Text" &&
      [state, fire, teamJob].every((id) => savedC.choices.some((x) => x.id === id)) && !savedC.choices.some((x) => x.id === oldJob),
      JSON.stringify(savedC));
    c.ok("…from her assistant's page too (one family)", (await rp.savedRequestsForClient(assistant.id)).saved.length === 1);
    const next = await mk("40 Next Booking Rd, Berwyn, PA", { status: "SCHEDULED", shoot: new Date(T + 9 * DAY), video: true });
    const offers = await rp.savedOffersForProjectIds([state, fire, next, otherJob]);
    c.ok("offered on the project booked after it, not on ones booked before (nor another client's)",
      offers.get(next)?.length === 1 && offers.get(next)![0].askId === reel && offers.get(state)?.length === 0 && offers.get(fire)?.length === 0 && offers.get(otherJob)?.length === 0,
      JSON.stringify([...offers].map(([k, v]) => [k === next ? "next" : k, v.length])));
    const pNext = await rp.placementForProject(next);
    c.ok("…the new project's page carries the offer", pNext?.offers.length === 1 && pNext.clientName === "Ashley Brunner" && pNext.street === "40 Next Booking Rd");
    const placed = await acts.placeSavedRequestAction(reel, next);
    said.push(placed.message);
    c.ok("'Put on 40 Next Booking Rd.': open there now", placed.ok && placed.message === "Put on 40 Next Booking Rd." && (await askNow()).projectId === next && (await askNow()).state === "OPEN" && (await vid(next)).includes(reel), placed.message);
    const tNext = await sys(next);
    said.push(...tNext);
    c.ok("…its timeline: 'Saved client request put on this project by Kyle Smith (kept from 825 State St).'", tNext.some((b) => b.startsWith("Saved client request put on this project by Kyle Smith (kept from 825 State St).")), JSON.stringify(tNext));
    c.ok("…the office note stays on 825 (it was 825's line)", (await lineNow()).type === "NOTE");
    const u1 = await acts.undoRequestPlacementAction(reel);
    said.push(u1.message);
    c.ok("Undo: 'Undone: it is saved for the client's next project again.'", u1.ok && u1.message === "Undone: it is saved for the client's next project again." && (await askNow()).state === "FUTURE" && (await askNow()).projectId === null, u1.message);
    const u2 = await acts.undoRequestPlacementAction(reel);
    said.push(u2.message);
    c.ok("Undo again: back on 825 with its brief line restored", u2.ok && u2.message === "Undone: back on 825 State St." && (await askNow()).projectId === state && (await lineNow()).type === "SPECIAL_REQUEST" && (await lineNow()).body === `Client request (openphone): ${MSG}` && /reel like this/i.test(await briefOf()), u2.message);
    // Kept, then not needed after all, then undone twice.
    await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "future" });
    const nn = await acts.dismissSavedRequestAction(reel);
    said.push(nn.message);
    c.ok("a saved one set aside: 'Set aside: not needed.' (off the client page)", nn.ok && nn.message === "Set aside: not needed." && (await askNow()).state === "NOT_NEEDED" && (await rp.savedRequestsForClient(ashley.id)).saved.length === 0, nn.message);
    const nnU = await acts.undoRequestPlacementAction(reel);
    c.ok("…Undo puts it back on the client page", nnU.ok && (await askNow()).state === "FUTURE" && (await rp.savedRequestsForClient(ashley.id)).saved.length === 1 && (await askNow()).doneBy === null, nnU.message);

    // =========================================================================
    c.head("6 · Not filed on 825 again");
    // =========================================================================
    const replay = await ca.fileAsksFromMessage({ clientId: ashley.id, clientName: "Ashley Brunner", contactName: "Ashley Brunner", message: MSG, channel: "text", sourceRef: log.id, asks: [brainAsk], defaultProjectId: state });
    c.ok("the same text read again files nothing", replay.filed.length === 0 && replay.skipped.some((s) => s.startsWith("already filed from this message")), JSON.stringify(replay));
    const MSG2 = `Following up: ${ASK_TEXT}!`;
    const reread = await ca.fileAsksFromMessage({ clientId: ashley.id, clientName: "Ashley Brunner", contactName: "Ashley Brunner", message: MSG2, channel: "text", asks: [brainAsk], defaultProjectId: state });
    c.ok("a new message with the same words, put on 825 again by the brain: skipped", reread.filed.length === 0 && reread.skipped.some((s) => s.startsWith("taken off this job before")), JSON.stringify(reread));
    const elsewhere = await ca.fileAsksFromMessage({ clientId: ashley.id, clientName: "Ashley Brunner", contactName: "Ashley Brunner", message: MSG2, channel: "text", asks: [{ ...brainAsk, projectHint: fire }], defaultProjectId: state });
    c.ok("…the same words for Firethorn are filed there (only 825 was ruled out)", elsewhere.filed.length === 1 && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: elsewhere.filed[0] } })).projectId === fire, JSON.stringify(elsewhere));
    await prisma.clientAsk.delete({ where: { id: elsewhere.filed[0] } });
    c.ok("comms' brief line guard: the message is taken off 825, not off Firethorn", (await rp.messageTakenOff(ashley.id, state, MSG)) && !(await rp.messageTakenOff(ashley.id, fire, MSG)) && (await rp.messageTakenOff(ashley.id, state, MSG2)));
    const commsSrc = fs.readFileSync("src/lib/comms.ts", "utf8");
    const at = commsSrc.indexOf("const body = `Client request (${opts.source");
    const seg = commsSrc.slice(at, at + 1200);
    c.ok("…and comms reads it before writing the line", at > 0 && /messageTakenOff\(opts\.clientId!, anchorProjectId!, opts\.text\)/.test(seg) && /if \(!already && !takenOff\) await prisma\.activity\.create/.test(seg));
    const filerSrc = fs.readFileSync("src/lib/clientAsks.ts", "utf8");
    c.ok("…the brain's filer reads the taken-off words for every reader of a message (comms and answeredAsks share it)", /placement\.repeatsTakenOff\(takenOff, projectId, \[words, a\.summary\]\)/.test(filerSrc) && /fileAsksFromMessage\(/.test(fs.readFileSync("src/lib/answeredAsks.ts", "utf8")));
    // Back on 825 for the next part.
    await acts.undoRequestPlacementAction(reel);
    c.ok("…and once it is back on 825, 825 is no longer ruled out", !(await rp.messageTakenOff(ashley.id, state, MSG2)) && (await askNow()).projectId === state);

    // =========================================================================
    c.head("7 · Not a request, and the checklist's Reopen");
    // =========================================================================
    const dis = await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "dismiss" });
    said.push(dis.message);
    const dAsk = await askNow();
    c.ok("'Set aside: not a request.': Not needed on 825, by Kyle, 'Not a request'", dis.ok && dis.message === "Set aside: not a request." && dAsk.state === "NOT_NEEDED" && dAsk.projectId === state && dAsk.doneBy === "Kyle Smith" && dAsk.confirmNote === "Not a request", dis.message);
    c.ok("…its line is an office note; gone from the card and the brief", (await lineNow()).type === "NOTE" && /^Taken off this project \(Kyle Smith, not a request\): /.test((await lineNow()).body) && !(await vid(state)).includes(reel) && !/reel like this/i.test(await briefOf()));
    const t825c = await sys(state);
    said.push(...t825c);
    c.ok("…825's timeline: 'Client request taken off this project by Kyle Smith: not a request.'", t825c.some((b) => b.startsWith("Client request taken off this project by Kyle Smith: not a request.")));
    const { reopenAskAction } = await import("@/app/ops/requests/actions");
    const ro = await reopenAskAction(reel);
    c.ok("the checklist's Reopen (Done today's Undo) undoes it, line and all", ro.ok && /^Undone: back on 825 State St\.$/.test(ro.message) && (await askNow()).state === "OPEN" && (await askNow()).doneBy === null && (await lineNow()).type === "SPECIAL_REQUEST" && (await lineNow()).body === `Client request (openphone): ${MSG}`, ro.message);
    const blurReopen = await ca.markNotNeeded(blur!.id, "Kyle Smith");
    const blurBack = await ca.reopenAsk(blur!.id, "Kyle Smith");
    c.ok("…an ordinary Not needed still reopens as before", blurReopen.ok && blurBack.ok && blurBack.message === "Back on the list." && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: blur!.id } })).state === "OPEN");

    // =========================================================================
    c.head("8 · A typed Request, and one logged on site");
    // =========================================================================
    const typed = await prisma.activity.create({ data: { projectId: state, type: "SPECIAL_REQUEST", body: "Twilight shots of the back deck" } });
    const typedAsk = await ca.createAsk({ clientId: ashley.id, projectId: state, kind: "SPECIAL_REQUEST", source: "staff", medium: "photo", text: "Twilight shots of the back deck", summary: "Twilight shots of the back deck", holdsDelivery: true, by: "Kyle Smith", dedupeKey: `request-note:${typed.id}` });
    const mvTyped = await acts.requestNotForProjectAction({ askId: typedAsk!.id, fromProjectId: state, outcome: "move", toProjectId: fire });
    c.ok("a Request typed in the composer moves with its own line", mvTyped.ok && (await prisma.activity.findUniqueOrThrow({ where: { id: typed.id } })).projectId === fire);
    await acts.undoRequestPlacementAction(typedAsk!.id);
    c.ok("…and comes back with it", (await prisma.activity.findUniqueOrThrow({ where: { id: typed.id } })).projectId === state && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: typedAsk!.id } })).projectId === state);
    const siteAsk = await ca.createAsk({ clientId: ashley.id, projectId: state, kind: "SPECIAL_REQUEST", source: "staff", sourceRef: "on-site:Harrison%20Lee", medium: "photo", text: "Shoot the shed too", summary: "Shoot the shed too", holdsDelivery: true, by: "Harrison Lee (on site)" });
    const siteLine = await prisma.activity.create({ data: { projectId: state, type: "SPECIAL_REQUEST", body: "Client request (on site, logged by Harrison Lee): Shoot the shed too" } });
    const keepSite = await acts.requestNotForProjectAction({ askId: siteAsk!.id, fromProjectId: state, outcome: "future" });
    c.ok("one logged on site takes its 'Client request (on site, ...)' line too", keepSite.ok && (await prisma.activity.findUniqueOrThrow({ where: { id: siteLine.id } })).type === "NOTE");
    await acts.undoRequestPlacementAction(siteAsk!.id);
    c.ok("…and Undo restores it", (await prisma.activity.findUniqueOrThrow({ where: { id: siteLine.id } })).type === "SPECIAL_REQUEST");
    c.ok("the staff line nobody filed as a request was never touched", (await lines825()).includes("Bring the drone for the lot"));

    // =========================================================================
    c.head("9 · Refusals");
    // =========================================================================
    process.env.AUTH_ENFORCE = "true";
    const r = (x: { ok: boolean; message: string }) => { said.push(x.message); return x; };
    const wrongFrom = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: fire, outcome: "dismiss" }));
    c.ok("a page showing it on a project it has left: refused", !wrongFrom.ok && wrongFrom.message === "This request is not on this project any more. Reload the page." && (await askNow()).state === "OPEN");
    const otherC = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "move", toProjectId: otherJob }));
    c.ok("another client's project: refused", !otherC.ok && otherC.message === "That project belongs to a different client.", otherC.message);
    const deliv = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "move", toProjectId: oldJob }));
    c.ok("a delivered project: refused", !deliv.ok && deliv.message === "9 Old Mill Ln is already delivered or cancelled. Pick an open one.", deliv.message);
    const same = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "move", toProjectId: state }));
    c.ok("the same project: 'It is already on 825 State St.'", !same.ok && same.message === "It is already on 825 State St.", same.message);
    const noPick = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "move", toProjectId: "" }));
    const badOutcome = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "delete" as never }));
    c.ok("no project picked, or no choice: refused in words", !noPick.ok && noPick.message === "Pick the project it is for." && !badOutcome.ok && badOutcome.message === "Pick what to do with it.");
    const badId = r(await acts.requestNotForProjectAction({ askId: "x';--", fromProjectId: state, outcome: "dismiss" }));
    const badUndo = r(await acts.undoRequestPlacementAction("../../x"));
    const badPlace = r(await acts.placeSavedRequestAction(reel, "nope nope"));
    c.ok("bad ids: refused before anything is read", !badId.ok && !badUndo.ok && !badPlace.ok && /no longer here/.test(badId.message) && /Pick the project/.test(badPlace.message));
    c.ok("putting an open request on a project as if saved: refused", !(r(await acts.placeSavedRequestAction(reel, fire))).ok && !(r(await acts.dismissSavedRequestAction(reel))).ok);
    me = user("OWNER", { impersonating: true, role: "PHOTOGRAPHER" });
    const asView = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "dismiss" }));
    const ctxView = await acts.requestPlacementContextAction(reel);
    c.ok("previewing someone else: refused, nothing changed", !asView.ok && /previewing/.test(asView.message) && !ctxView.ok && (await askNow()).state === "OPEN", asView.message);
    me = user("PHOTOGRAPHER", { name: "Harrison Lee", realName: "Harrison Lee" });
    const asPhotog = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "dismiss" }));
    c.ok("a photographer: refused", !asPhotog.ok && (await askNow()).state === "OPEN", asPhotog.message);
    me = null;
    const signedOut = r(await acts.undoRequestPlacementAction(reel));
    c.ok("signed out: refused", !signedOut.ok);
    me = user("ADMIN");
    // Moved, then Checked on Firethorn: Undo would put back the wrong thing.
    await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "move", toProjectId: fire });
    await ca.markConfirmed(reel, "Kyle Smith");
    const stale = r(await acts.undoRequestPlacementAction(reel));
    c.ok("moved, then Checked there: Undo refuses ('changed since then')", !stale.ok && stale.message === "This request changed since then, so Undo would put back the wrong thing. Reload the page." && (await askNow()).state === "CONFIRMED", stale.message);
    const closed = r(await acts.requestNotForProjectAction({ askId: reel, fromProjectId: fire, outcome: "dismiss" }));
    c.ok("…a closed request is not taken off anything", !closed.ok && closed.message === "This request is already closed. Reload the page.", closed.message);
    const ctxClosed = await rp.placementContext(reel);
    c.ok("…nor offered the panel", !ctxClosed.ok && ctxClosed.message === "This request is not open on a project any more. Reload the page.");
    const roC = await reopenAskAction(reel);
    c.ok("the checklist's Reopen on it is the plain reopen (open on Firethorn)", roC.ok && roC.message === "Back on the list." && (await askNow()).projectId === fire && (await askNow()).state === "OPEN", roC.message);
    const backNow = r(await acts.undoRequestPlacementAction(reel));
    c.ok("…where the move's Undo applies again: back on 825", backNow.ok && (await askNow()).projectId === state && (await lineNow()).projectId === state, backNow.message);
    const loose = await ca.createAsk({ clientId: ashley.id, projectId: null, kind: "SPECIAL_REQUEST", source: "text", medium: "photo", text: "Can you do a floor plan for the next one", askedBy: "Ashley Brunner" });
    const looseCtx = await rp.placementContext(loose!.id);
    const sched = await ca.createAsk({ clientId: ashley.id, projectId: state, kind: "SCHEDULING", source: "text", text: "Can we move Thursday's shoot?" });
    const schedOff = await rp.takeRequestOffProject({ askId: sched!.id, fromProjectId: state, outcome: "dismiss", by: "Kyle Smith" });
    c.ok("a request on no project says where to pick one; a scheduling ask is not a request here", !looseCtx.ok && looseCtx.message === "This request is on no project yet. Pick its project on the client's page." && !schedOff.ok);
    // Sibling fixed (Oct 28 2026): the brain files a request on no project when several are in flight, and
    // Kyle's list says "pick the job for each" on the client page, which had no picker.
    const sv0 = await rp.savedRequestsForClient(ashley.id);
    c.ok("the client page lists it under 'Requests on no project yet', with her open projects", sv0.loose.some((x) => x.askId === loose!.id && x.keptLine === "On no project yet: pick the one it is for") && !sv0.saved.some((x) => x.askId === loose!.id) && sv0.choices.some((x) => x.id === fire));
    const putLoose = r(await acts.placeSavedRequestAction(loose!.id, fire));
    const looseNow = () => prisma.clientAsk.findUniqueOrThrow({ where: { id: loose!.id } });
    c.ok("…put on Firethorn: open there, its timeline says who", putLoose.ok && putLoose.message === "Put on 512 Firethorn Rd." && (await looseNow()).projectId === fire && (await sys(fire)).some((b) => b.startsWith("Client request put on this project by Kyle Smith.")), putLoose.message);
    const unLoose = r(await acts.undoRequestPlacementAction(loose!.id));
    c.ok("…Undo: 'Undone: it is on no project again.'", unLoose.ok && unLoose.message === "Undone: it is on no project again." && (await looseNow()).projectId === null && (await looseNow()).state === "OPEN", unLoose.message);
    const dropLoose = r(await acts.dismissSavedRequestAction(loose!.id));
    c.ok("…or set aside as not a request, and back with Undo", dropLoose.ok && (await looseNow()).state === "NOT_NEEDED" && (await looseNow()).confirmNote === "Not a request" && (r(await acts.undoRequestPlacementAction(loose!.id))).ok && (await looseNow()).state === "OPEN" && (await looseNow()).projectId === null);
    c.ok("…the client page renders the list", /data-requests-no-project/.test(fs.readFileSync("src/app/clients/[id]/page.tsx", "utf8")) && /<SavedRequestList items=\{saved\.loose\}/.test(fs.readFileSync("src/app/clients/[id]/page.tsx", "utf8")));
    // A race: the request moved between the page's read and the press.
    await prisma.clientAsk.update({ where: { id: reel }, data: { projectId: fire } });
    const race = await rp.takeRequestOffProject({ askId: reel, fromProjectId: state, outcome: "future", by: "Kyle Smith" });
    await prisma.clientAsk.update({ where: { id: reel }, data: { projectId: state } });
    c.ok("…and one that moved meanwhile is refused, not overwritten", !race.ok && (await askNow()).state === "OPEN");
    delete process.env.AUTH_ENFORCE;

    // =========================================================================
    c.head("10 · The screens");
    // =========================================================================
    me = user("ADMIN");
    const { loadJobDeliverables, JobDeliverablesView } = await import("@/components/jobs/JobDeliverables");
    const d825 = (await loadJobDeliverables(state))!;
    const h825 = html(createElement(JobDeliverablesView, d825));
    c.ok("the project page: 'Not for this project' on the request, beside Checked", h825.includes(`data-not-for-project="${reel}"`) && h825.includes("Not for this project") && /Checked/.test(text(h825)), text(h825).slice(0, 300));
    c.ok("…the page passes the client's projects to it (no extra read when pressed)", !!d825.placement && d825.placement.choices.some((x) => x.id === fire) && d825.placement.street === "825 State St");
    c.ok("…nothing to press for someone who cannot check requests", !html(createElement(JobDeliverablesView, { ...d825, canCheck: false })).includes("data-not-for-project="));
    await acts.requestNotForProjectAction({ askId: reel, fromProjectId: state, outcome: "future" });
    const h825b = html(createElement(JobDeliverablesView, (await loadJobDeliverables(state))!));
    const panel = h825b.slice(h825b.indexOf("data-request-placement"));
    c.ok("after Keep for a future project: 825 shows it under 'Taken off this project', with who, when and Undo",
      h825b.includes("data-request-placement") && /Taken off this project/.test(text(panel)) && /Kept for a future project by Kyle Smith, /.test(text(panel)) && panel.includes(`data-placement-undo="${reel}"`) && !h825b.includes(`data-not-for-project="${reel}"`), text(panel).slice(0, 400));
    // Kept again after 40 Next Booking Rd was booked: offered on the one booked after this, not on that one.
    const fresh = await mk("60 Fresh Start Ave, Berwyn, PA", { status: "SCHEDULED", shoot: new Date(T + 12 * DAY), video: true });
    const hNextOld = html(createElement(JobDeliverablesView, (await loadJobDeliverables(next))!));
    c.ok("kept again: not offered on 40 Next Booking Rd (open when Kyle chose to keep it, not move it there)", !hNextOld.includes(`data-saved-request="${reel}"`));
    const hNext = html(createElement(JobDeliverablesView, (await loadJobDeliverables(fresh))!));
    const nextPanel = hNext.slice(hNext.indexOf("data-request-placement"));
    c.ok("the project booked after: 'Saved for Ashley Brunner's next project' with 'Put on 60 Fresh Start Ave' and 'Not needed'",
      hNext.includes("data-request-placement") && /Saved for Ashley Brunner’s next project/.test(text(nextPanel)) && /Put on 60 Fresh Start Ave/.test(text(nextPanel)) && nextPanel.includes("data-saved-place") && nextPanel.includes("data-saved-dismiss") && /Kept from 825 State St by Kyle Smith/.test(text(nextPanel)), text(nextPanel).slice(0, 400));

    // The Projects list's Requests tab.
    me = user("OWNER");
    const { default: ShootsPage } = await import("@/app/jobs/page");
    const page = async (sp: Record<string, string>) => html(await ShootsPage({ searchParams: Promise.resolve(sp) }));
    const both = await ca.createAsk({ clientId: ashley.id, projectId: fire, kind: "SPECIAL_REQUEST", source: "email", medium: "both", text: "Lot lines on the photos and the video please", summary: "Lot lines on the photos and the video", askedBy: "Ashley Brunner" });
    const tab = await page({ f: "requests" });
    const STREETS = ["825 State St", "512 Firethorn Rd", "77 Team Way", "40 Next Booking Rd", "60 Fresh Start Ave", "3 Elm Ct", "9 Old Mill Ln"];
    // One project's row: from its street to the next project's street.
    const rowOf = (h: string, street: string) => {
      const i = h.indexOf(`>${street}<`);
      if (i < 0) return "";
      const ends = STREETS.filter((s) => s !== street).map((s) => h.indexOf(`>${s}<`, i + 1)).filter((x) => x > i);
      return h.slice(i, ends.length ? Math.min(...ends) : undefined);
    };
    const fireRow = rowOf(tab, "512 Firethorn Rd");
    c.ok("Requests tab: each request in plain words, who it is for, who asked how and when",
      fireRow.includes(`data-request-card="${both!.id}"`) && /Lot lines on the photos and the video/.test(text(fireRow)) && /Kyle · photo editing and Jhon · video editing/.test(text(fireRow)) && /Ashley Brunner by email, /.test(text(fireRow)),
      text(fireRow).slice(0, 500));
    c.ok("…with its presses: Checked and Not for this project", fireRow.includes(`data-request-actions="${both!.id}"`) && fireRow.includes(`data-not-for-project="${both!.id}"`) && fireRow.includes("data-request-check"));
    c.ok("…the client's words folded under it", /The client’s words/.test(text(fireRow)) && /Lot lines on the photos and the video please/.test(text(fireRow)));
    const nextRow = rowOf(tab, "60 Fresh Start Ave");
    c.ok("…a project booked after a saved request is listed with the offer", nextRow.includes("data-saved-offers") && /Saved for Ashley Brunner’s next project: is it for this one\?/.test(text(nextRow)) && nextRow.includes(`data-saved-request="${reel}"`) && !rowOf(tab, "40 Next Booking Rd").includes(`data-saved-request="${reel}"`), text(nextRow).slice(0, 300));
    c.ok("…phone width: the rows wrap, text can break, presses are 44px tall", /data-request-card="[^"]+" class="min-w-0/.test(tab) && /min-h-11/.test(fireRow) && /flex-wrap/.test(fireRow) && /\[overflow-wrap:anywhere\]/.test(fireRow));
    const openTab = await page({});
    c.ok("other tabs keep the one-line count (no cards)", !openTab.includes("data-request-card="));
    const { ShootsList } = await import("@/components/jobs/ShootsList");
    const fireCards = (await rp.openRequestCards([fire])).get(fire)!;
    const rowsNow = (await jb.shootsBoard(new Date(), { detail: true })).rows.filter((x) => x.projectId === fire);
    const roHtml = html(createElement(ShootsList, { rows: rowsNow, empty: "", requests: { cards: { [fire]: fireCards }, offers: {}, canAct: false } }));
    c.ok("…read-only for someone who cannot check requests", roHtml.includes(`data-request-card="${both!.id}"`) && !roHtml.includes("data-request-actions") && !roHtml.includes("data-not-for-project="));
    me = user("OWNER");
    const priced = await ca.createAsk({ clientId: ashley.id, projectId: fire, kind: "SPECIAL_REQUEST", source: "text", medium: "photo", text: "Listing at $1,250,000, add the price to the sign", summary: "Add the $1,250,000 price to the sign", askedBy: "Ashley Brunner" });
    const ownerCard = (await rp.openRequestCards([fire])).get(fire)!.find((x) => x.id === priced!.id);
    me = user("ADMIN");
    const kyleCard = (await rp.openRequestCards([fire])).get(fire)!.find((x) => x.id === priced!.id);
    c.ok("money: the owner reads the amount, Kyle's copy is scrubbed", /\$1,250,000/.test(ownerCard?.summary ?? "") && !/\$1,250,000/.test(`${kyleCard?.summary} ${kyleCard?.text}`), `${kyleCard?.summary}`);

    // The saved list and the button, rendered.
    const { SavedRequestList, NotForThisProject, RequestQuickActions } = await import("@/components/requests/RequestPlacement");
    const sv = await rp.savedRequestsForClient(ashley.id);
    const svHtml = html(createElement(SavedRequestList, { items: sv.saved, choices: sv.choices, canAct: true }));
    c.ok("the client page's list: the request, who asked, kept from where, a project picker and 'Put it on this project'",
      svHtml.includes(`data-saved-request="${reel}"`) && /Ashley Brunner · Text · /.test(text(svHtml)) && /Kept from 825 State St by Kyle Smith/.test(text(svHtml)) && /Which project is it for\?/.test(text(svHtml)) && /Put it on this project/.test(text(svHtml)), text(svHtml).slice(0, 300));
    const clientSrc = fs.readFileSync("src/app/clients/[id]/page.tsx", "utf8");
    c.ok("…and the client page renders it", /data-saved-for-later/.test(clientSrc) && /<SavedRequestList items=\{saved\.saved\}/.test(clientSrc));
    await acts.undoRequestPlacementAction(reel); // back on 825 for the button

    // The button itself: its real state and presses.
    refreshed = 0;
    const btn = mountHooks(() => (NotForThisProject as any)({ askId: reel, refresh: false }));
    let tree = btn.render();
    const opener = findBy(tree, (e) => e.type === "button" && e.props["data-not-for-project"] === reel)[0];
    c.ok("closed: one 'Not for this project' button, 44px on a phone", !!opener && textOf(opener.props.children) === "Not for this project" && /min-h-11/.test(opener.props.className));
    opener.props.onClick();
    await btn.settle();
    tree = btn.render();
    const sel = () => findBy(tree, (e) => e.type === "select" && e.props.id === `move-${reel}`)[0];
    const opts = () => findBy(sel(), (e) => e.type === "option").map((o) => ({ value: o.props.value, label: textOf(o.props.children) }));
    c.ok("opened: 'Not for 825 State St. Where does it belong?', her projects to move it to, Keep for a future project, Not a request, Cancel",
      /Not for 825 State St\. Where does it belong\?/.test(textOf(tree)) && opts()[0]?.label === "Pick Ashley Brunner’s project" && opts().some((o) => o.value === fire) && !opts().some((o) => o.value === state) &&
      /Keep for a future project/.test(textOf(tree)) && /It stays on Ashley Brunner’s client page and is offered on their next project\./.test(textOf(tree)) && /Not a request/.test(textOf(tree)) && /Cancel/.test(textOf(tree)), textOf(tree).slice(0, 400));
    const moveBtn = () => findBy(tree, (e) => e.type === "button" && textOf(e.props.children) === "Move")[0];
    c.ok("…Move waits for a pick", moveBtn()?.props.disabled === true);
    sel().props.onChange({ target: { value: fire } });
    tree = btn.render();
    c.ok("…picked, Move is live", moveBtn()?.props.disabled === false);
    moveBtn().props.onClick();
    await btn.settle();
    tree = btn.render();
    c.ok("pressed: 'Moved to 512 Firethorn Rd.' with Undo; the request moved", saidIn(tree, "Moved to 512 Firethorn Rd.") && findBy(tree, (e) => e.type === "button" && e.props["data-placement-undo"] !== undefined).length === 1 && (await askNow()).projectId === fire && refreshed === 0, `${textOf(tree)} | ${(await askNow()).projectId === fire} | refreshed ${refreshed}`);
    findBy(tree, (e) => e.type === "button" && e.props["data-placement-undo"] !== undefined)[0].props.onClick();
    await btn.settle();
    tree = btn.render();
    c.ok("Undo: back to the button, the request back on 825", !!findBy(tree, (e) => e.type === "button" && e.props["data-not-for-project"] === reel)[0] && (await askNow()).projectId === state && saidIn(tree, "Undone: back on 825 State St."), textOf(tree));
    const qa = mountHooks(() => (RequestQuickActions as any)({ askId: reel }));
    let qt = qa.render();
    findBy(qt, (e) => e.type === "button" && e.props["data-request-check"] !== undefined)[0].props.onClick();
    await qa.settle();
    qt = qa.render();
    c.ok("the list's Checked: 'Checked.' with Undo; the request is confirmed", saidIn(qt, "Checked.") && (await askNow()).state === "CONFIRMED", `${textOf(qt)} | ${(await askNow()).state}`);
    findBy(qt, (e) => e.type === "button" && /Undo/.test(textOf(e.props.children)))[0].props.onClick();
    await qa.settle();
    qt = qa.render();
    c.ok("…its Undo reopens it", (await askNow()).state === "OPEN" && findBy(qt, (e) => e.props?.["data-request-check"] !== undefined).length === 1);

    // A list page's Undo bar: the press re-renders the list and the row leaves it, so its Undo waits outside the rows.
    const { PlacementUndoHost } = await import("@/components/requests/RequestPlacement");
    const host = mountHooks(() => (PlacementUndoHost as any)());
    let ht = host.render();
    const hostUndo = () => findBy(ht, (e) => e.type === "button" && e.props["data-host-undo"] !== undefined)[0];
    c.ok("the bar is empty until a press", !hostUndo() && findBy(ht, (e) => e.props?.["data-placement-undo-host"] !== undefined).length === 1);
    const btn2 = mountHooks(() => (NotForThisProject as any)({ askId: reel, refresh: false }));
    let t2 = btn2.render();
    findBy(t2, (e) => e.type === "button" && e.props["data-not-for-project"] === reel)[0].props.onClick();
    await btn2.settle();
    t2 = btn2.render();
    findBy(t2, (e) => e.type === "button" && textOf(e.props.children) === "Keep for a future project")[0].props.onClick();
    await btn2.settle();
    t2 = btn2.render();
    ht = host.render();
    c.ok("with a bar on the page: the row says what happened, its Undo is in the bar (not twice)",
      saidIn(t2, "Kept for Ashley Brunner's next project. It is on their client page.") && !findBy(t2, (e) => e.props?.["data-placement-undo"] !== undefined).length &&
      /Kept for Ashley Brunner's next project\. It is on their client page\./.test(textOf(ht)) && !!hostUndo() && /min-h-11/.test(hostUndo().props.className) && (await askNow()).state === "FUTURE",
      textOf(ht));
    hostUndo().props.onClick();
    await host.settle();
    ht = host.render();
    c.ok("…the bar's Undo puts it back and says so", /Undone: back on 825 State St\./.test(textOf(ht)) && !hostUndo() && (await askNow()).projectId === state && (await askNow()).state === "OPEN", textOf(ht));
    const qa2 = mountHooks(() => (RequestQuickActions as any)({ askId: reel }));
    let q2 = qa2.render();
    findBy(q2, (e) => e.type === "button" && e.props["data-request-check"] !== undefined)[0].props.onClick();
    await qa2.settle();
    q2 = qa2.render();
    ht = host.render();
    c.ok("…Checked from a list hands its Undo to the bar too", /^Checked\./.test(textOf(ht)) && !!hostUndo() && !findBy(q2, (e) => e.type === "button" && /Undo/.test(textOf(e.props.children))).length);
    hostUndo().props.onClick();
    await host.settle();
    c.ok("…and that Undo reopens it", (await askNow()).state === "OPEN");
    host.unmount();
    c.ok("the bar is on the Projects list, the checklist, the desk and the client page (outside their rows)",
      /\{requests\?\.canAct && <PlacementUndoHost \/>\}/.test(fs.readFileSync("src/app/jobs/page.tsx", "utf8")) &&
      /<PlacementUndoHost \/>/.test(fs.readFileSync("src/components/home/Checklist.tsx", "utf8")) &&
      /\{!desk\.readOnly && <PlacementUndoHost \/>\}/.test(fs.readFileSync("src/components/desk/OfficeDesk.tsx", "utf8")) &&
      /\{canPlaceSaved && <PlacementUndoHost \/>\}/.test(fs.readFileSync("src/app/clients/[id]/page.tsx", "utf8")));

    // Everywhere a request is checked from a list, the button is there.
    c.ok("Kyle's checklist rows carry it (AskQuickActions), the project page's card and the Projects tab",
      /<NotForThisProject askId=\{id\} refresh=\{false\} onChange=\{setOff\} \/>/.test(fs.readFileSync("src/components/home/AskQuickActions.tsx", "utf8")) &&
      /<NotForThisProject/.test(fs.readFileSync("src/components/jobs/JobDeliverables.tsx", "utf8")) && /<RequestQuickActions askId=\{c\.id\} \/>/.test(fs.readFileSync("src/components/jobs/ShootsList.tsx", "utf8")));

    // No dashes in anything said.
    const timelines = (await prisma.activity.findMany({ where: { projectId: { in: [state, fire, next] } }, select: { body: true } })).map((a) => a.body);
    const histories = (await prisma.clientAsk.findMany({ select: { historyJson: true } })).map((a) => a.historyJson ?? "");
    const srcs = ["src/lib/requestPlacement.ts", "src/lib/requestPlacementCore.ts", "src/components/requests/RequestPlacement.tsx", "src/app/jobs/requestActions.ts"].map((f) => fs.readFileSync(f, "utf8"));
    c.ok("no em or en dash in any message, timeline line, history, screen or the new files",
      !said.some((s) => DASH.test(s)) && !timelines.some((s) => DASH.test(s)) && !histories.some((s) => DASH.test(s)) && !DASH.test(h825 + h825b + hNext + tab + svHtml) && !srcs.some((s) => DASH.test(s)),
      [...said, ...timelines].find((s) => DASH.test(s)) ?? "");
    c.ok("the fence held", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
