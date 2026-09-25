// ---------------------------------------------------------------------------
// DRILL B1-REMAINDERS: what batch 1 left PARTIAL because the files were not
// its builders' (unified handoff, Sep 25 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/b1-remainders.ts
//
// Drives the SHIPPED code against an isolated PGlite on 127.0.0.1:5625, and the
// same files as they were at f2555f7 (never HEAD) beside them wherever the old
// behaviour is observable. Production is never opened; Dropbox and the model
// are faked at the module boundary and every outbound call is fenced.
//
//   §1  O09/A58  the task card's assignee picker and the board's put-back
//                close the old editor's stretch at once; nothing starts anyone
//   §2  7.1-sync-never-starts  the task card's status menu cannot start work;
//                it pauses (Open / waiting on somebody else) or closes it
//                (Complete / Cancelled / Dismissed)
//   §3  A64      the delivery board, the edit card and the Editing Room row
//                say the same thing, from the editor's own Start
//   §4  O01/A32  "Waiting on instructions" on the queue, the card and the board
//   §5  8.2      the cut stream voids a check when the folder bytes drift
//   §6  8.3      reanalyzeBrief asks the lock before it touches a tick
//   §7  8.4      the editor's own review card on /editing
//   §8  stale words (Topaz hold, the private-store comment, Luma)
//
// THE CLOCK IS PINNED to Tuesday Sep 22 2026, 10:00 ET, and runs forward.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Module, { createRequire } from "node:module";
import type { Prisma } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5625);
const BASE = "f2555f7";
const REPO = path.resolve(__dirname, "../..");
const DAY = 86_400_000;
// A CommonJS require for §7, which must share module instances with the page.
const cjs = createRequire(__filename);

// ---- the pinned clock ----------------------------------------------------
const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 22, 14, 0, 0); // Tue Sep 22 2026 10:00 ET
let clockOffsetMs = PARK - RealDate.now();
const drillNow = () => RealDate.now() + clockOffsetMs;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(drillNow());
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return drillNow;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const advance = (ms: number) => { clockOffsetMs += ms; };

installNextStubs();

// lucide-react builds a React context at import time, which the react-server
// build of React does not have; the drill never renders an icon.
{
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  L._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
    // next/link is a client module built on a React context too; §7 only
    // walks the page's element tree, it never renders a link.
    if (request === "next/link") return { __esModule: true, default: () => null };
    return prev.call(this, request, parent, isMain);
  };
}

// ---- fakes ---------------------------------------------------------------
type DbxFile = { size: number; hash: string | null };
const dbxFiles = new Map<string, DbxFile>();
let dbxCalls = 0;
async function dbxAnswer(endpoint: string, arg?: { path?: string }): Promise<unknown> {
  dbxCalls++;
  if (endpoint === "users/get_current_account") return {};
  const f = dbxFiles.get(arg?.path ?? "");
  if (endpoint === "files/get_temporary_link") {
    if (!f) throw new Error("drill: path/not_found");
    // Dropbox's own shape: the link plus the file's metadata.
    return { link: `https://drill-dl.invalid${arg?.path}`, metadata: f.hash ? { size: f.size, content_hash: f.hash, rev: `rev-${f.hash}` } : { size: f.size } };
  }
  if (endpoint === "files/get_metadata") {
    if (!f) throw new Error("drill: path/not_found");
    return { size: f.size, content_hash: f.hash, rev: `rev-${f.hash}` };
  }
  throw new Error(`drill: dbx ${endpoint} not faked`);
}
interceptModule(
  (r) => r === "@/lib/integrations/dropbox" || r.endsWith("/integrations/dropbox"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "dbx") return t[k];
      return (endpoint: string, arg?: { path?: string }) => dbxAnswer(endpoint, arg);
    },
  }),
);
// The cut stream route reaches Dropbox through a DYNAMIC import, which tsx
// loads as a separate ESM instance the module intercept above never sees — so
// the same fake answers at the network edge as well: the OAuth refresh (against
// a drill-only secret saved in the isolated database), the account read and the
// file endpoints. Nothing else is answered; every other host stays blocked.
const DROPBOX_HOSTS = /^https:\/\/api\.dropbox(api)?\.com\//;
const fence = fenceFetch(async (url, init) => {
  if (!DROPBOX_HOSTS.test(url)) return null;
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/oauth2/token")) return json({ access_token: "drill-access-token", expires_in: 14400 });
  const endpoint = url.replace(/^https:\/\/api\.dropboxapi\.com\/2\//, "");
  const arg = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as { path?: string }) : undefined;
  try {
    return json(await dbxAnswer(endpoint, arg));
  } catch (e) {
    return json({ error_summary: (e as Error).message }, 409);
  }
});

let aiCalls = 0;
let aiDown = false;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson") return t[k];
      return async () => {
        aiCalls++;
        if (aiDown) throw new Error("drill: model down");
        return {
          headline: "Drill re-read",
          items: [
            { area: "Music", ask: "Swap the song", detail: "", quote: "swap the song", scope: "all", videos: [] },
            { area: "Text", ask: "Fix the name on screen", detail: "", quote: "fix the name", scope: "all", videos: [] },
            { area: "Other", ask: "Trim the ending", detail: "", quote: "trim the end", scope: "all", videos: [] },
          ],
          keep: [], references: [], questions: [],
        };
      };
    },
  }),
);

// ---- old code, pinned to BASE --------------------------------------------
const BASE_DIR = path.join(REPO, "node_modules/.cache", `b1r-baseline-${BASE}`);
function baseline(rel: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const out = path.join(BASE_DIR, rel.replace(/[/[\]]/g, "_"));
  fs.writeFileSync(out, src.replace(/(["'])@\//g, `$1${REPO}/src/`));
  return out;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  // A drill-only Dropbox credential in the ISOLATED database, for the network
  // fake above; it is never a real token and never leaves loopback.
  await (await import("@/lib/integrations/connections")).saveSecret("dropbox", "drill-refresh-token-not-real");
  const work = await import("@/lib/editorWork");
  const appActions = await import("@/app/actions");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { deliveryBoard } = await import("@/lib/deliveryBoard");
  const { setSession } = await import("@/lib/auth/session");
  const { NextRequest } = await import("next/server");
  const streamRoute = await import("@/app/api/review/cut/[id]/stream/route");
  const reviewActions = await import("@/app/review/actions");
  const revisionActions = await import("@/app/edit/revisionActions");
  const ri = await import("@/lib/revisionIssues");
  const sc = await import("@/lib/selfCheck");

  const oldActions = (await import(baseline("src/app/actions.ts"))) as typeof import("@/app/actions");
  const oldBoard = (await import(baseline("src/lib/deliveryBoard.ts"))) as typeof import("@/lib/deliveryBoard");
  const oldQueue = (await import(baseline("src/lib/editorQueue.ts"))) as typeof import("@/lib/editorQueue");
  const oldRevision = (await import(baseline("src/app/edit/revisionActions.ts"))) as typeof import("@/app/edit/revisionActions");
  const oldStream = (await import(baseline("src/app/api/review/cut/[id]/stream/route.ts"))) as typeof import("@/app/api/review/cut/[id]/stream/route");

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle-tm@drill.invalid", role: "MANAGER" } });
  const mkUser = (email: string, name: string, role: string, editorKey: string | null = null) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", editorKey }, select: { id: true, email: true, name: true, role: true } });
  const jordan = await mkUser("jordan@drill.invalid", "Jordan Spackman", "OWNER");
  const kim = await mkUser("kimm@drill.invalid", "Kim Miguel", "EDITOR", "kim");
  const john = await mkUser("johnm@drill.invalid", "John Mark", "EDITOR", "john");
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });

  let seq = 0;
  type Job = { id: string; street: string; deliverableId: string; cardId: string; folder: string };
  const mkJob = async (o: {
    street: string;
    status: "SHOT" | "EDITING" | "REVIEW" | "REVISION";
    editor: "kim" | "john" | "external_agency" | null;
    cardStatus?: "OPEN" | "IN_PROGRESS";
    blocked?: string | null;
  }): Promise<Job> => {
    const folder = `/Drill/${o.street.replace(/\s+/g, "-")}-${++seq}`;
    const p = await prisma.project.create({
      data: {
        title: `${o.street}, Royersford, PA`, clientId: client.id, status: o.status, aryeoOrderId: `drill-r-${seq}`,
        shootDate: new Date(Date.now() - 3 * DAY), photographerId: harrison.id, dropboxFolder: folder,
        editorId: o.editor === "kim" ? kimTm.id : o.editor === "john" ? johnTm.id : null,
        handoffBlockedReason: o.blocked ?? null,
        statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }),
      },
      select: { id: true },
    });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1, status: "UPLOADED", uploadedAt: new Date() }, select: { id: true } });
    const card = await prisma.smartTask.create({
      data: { taskType: "edit_video", title: `Edit — ${o.street}`, status: o.cardStatus ?? "OPEN", assignedKey: o.editor, assignedManually: !!o.editor, projectId: p.id, clientId: client.id, propertyAddress: `${o.street}, Royersford, PA`, dedupeKey: `edit-video-${p.id}`, blockedReason: o.blocked ?? null },
      select: { id: true },
    });
    return { id: p.id, street: o.street, deliverableId: d.id, cardId: card.id, folder };
  };
  const item = (editorKey: string, projectId: string) => prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey, projectId } } });
  const events = (where: Prisma.EditorWorkEventWhereInput = {}) => prisma.editorWorkEvent.count({ where });
  const starts = () => events({ kind: { in: ["START", "RESUME", "CONFIRM"] } });
  const lines = (projectId: string, needle: string) => prisma.activity.count({ where: { projectId, body: { contains: needle } } });
  const cardOf = (id: string) => prisma.smartTask.findUniqueOrThrow({ where: { id }, select: { status: true, assignedKey: true } });
  const rowOf = async (id: string, q?: Awaited<ReturnType<typeof buildEditorQueue>>) => {
    const qq = q ?? (await buildEditorQueue());
    return [...qq.notDone, ...qq.upcoming, ...qq.done].find((r) => r.id === id) ?? null;
  };
  const boardOf = async (id: string, b?: Awaited<ReturnType<typeof deliveryBoard>>) => {
    const bb = b ?? (await deliveryBoard());
    return [...bb.today, ...bb.tomorrow, ...bb.upcoming, ...bb.delivered].find((j) => j.id === id) ?? null;
  };
  const oldBoardOf = async (id: string) => {
    const bb = await oldBoard.deliveryBoard();
    return [...bb.today, ...bb.tomorrow, ...bb.upcoming, ...bb.delivered].find((j) => j.id === id) ?? null;
  };
  const kimStarts = async (projectId: string, rid: string) => { await as(kim); const r = await work.startEditing({ projectId, requestId: rid }); await as(jordan); return r; };

  // =========================================================================
  c.head("§1 · O09/A58 the task card's assignee picker, and the board's put-back");
  // =========================================================================
  await as(jordan);
  {
    // OLD: the picker moved the card and left Kim's stretch ACTIVE in the table.
    const J1 = await mkJob({ street: "1 Picker Old Ln", status: "SHOT", editor: "kim" });
    const s = await kimStarts(J1.id, "kim-J1");
    await oldActions.setTaskAssignee(J1.cardId, "john");
    const i = await item("kim", J1.id);
    c.ok(`old (${BASE}): reassigning a started card left Kim's work ACTIVE — nothing closed it until the hourly refresh`, s.ok && i?.state === "ACTIVE" && i.activeFor === "kim", `${i?.state}`);
    await work.closeGhostWork(J1.id);
  }
  const J2 = await mkJob({ street: "2 Picker Ln", status: "SHOT", editor: "kim" });
  await kimStarts(J2.id, "kim-J2");
  const s0 = await starts();
  await appActions.setTaskAssignee(J2.cardId, "john");
  const i2 = await item("kim", J2.id);
  const ev2 = await prisma.editorWorkEvent.findFirst({ where: { projectId: J2.id, kind: "CLOSE" }, orderBy: { at: "desc" } });
  c.ok("new: the card moved to John closes Kim's stretch at once — CLOSED(REASSIGNED)", i2?.state === "CLOSED" && i2.closeReason === "REASSIGNED" && i2.activeFor === null, `${i2?.state} ${i2?.closeReason}`);
  c.ok("…recorded as the office (Jordan, on Kim's behalf), with the words on the timeline",
    ev2?.actorName === "Jordan Spackman" && ev2.onBehalf === true && (await lines(J2.id, "reassigned to John on the task card by Jordan Spackman")) === 1,
    `${ev2?.actorName} onBehalf=${ev2?.onBehalf}`);
  c.ok("…John is NOT started on it, and no START/RESUME/CONFIRM was written", (await item("john", J2.id)) === null && (await starts()) === s0 && (await cardOf(J2.cardId)).assignedKey === "john");

  const J3 = await mkJob({ street: "3 Picker Ln", status: "SHOT", editor: "kim" });
  await kimStarts(J3.id, "kim-J3");
  await appActions.setTaskAssignee(J3.cardId, "");
  c.ok("unassigned from the card: CLOSED(UNASSIGNED)", (await item("kim", J3.id))?.closeReason === "UNASSIGNED" && (await lines(J3.id, "unassigned on the task card by Jordan Spackman")) === 1);

  const J4 = await mkJob({ street: "4 Picker Ln", status: "SHOT", editor: "kim" });
  await kimStarts(J4.id, "kim-J4");
  await as(kim);
  await appActions.setTaskAssignee(J4.cardId, "kyle");
  await as(jordan);
  const ev4 = await prisma.editorWorkEvent.findFirst({ where: { projectId: J4.id, kind: "CLOSE" } });
  c.ok("Kim handing her own card back to Kyle closes her stretch, recorded as HER (not on anyone's behalf)",
    (await item("kim", J4.id))?.state === "CLOSED" && ev4?.actorRole === "EDITOR" && ev4.onBehalf === false && (await cardOf(J4.cardId)).assignedKey === "kyle",
    `${ev4?.actorRole} onBehalf=${ev4?.onBehalf}`);

  const J5 = await mkJob({ street: "5 Two Lanes Ln", status: "REVISION", editor: "kim" });
  const rev5 = await prisma.smartTask.create({ data: { taskType: "revision", title: "Video revision — 5 Two Lanes Ln", status: "OPEN", assignedKey: "kim", projectId: J5.id, clientId: client.id }, select: { id: true } });
  await kimStarts(J5.id, "kim-J5");
  await appActions.setTaskAssignee(rev5.id, "john");
  c.ok("moving only the revision card leaves Kim ACTIVE — she still holds the edit card (only a ghost closes)", (await item("kim", J5.id))?.state === "ACTIVE");

  {
    // The board's put-back. OLD: dragging a started job back to Shot left Kim
    // on it, and the row went on saying "In editing".
    const J6 = await mkJob({ street: "6 Board Old Rd", status: "SHOT", editor: "kim" });
    await kimStarts(J6.id, "kim-J6");
    await oldActions.moveProjectStatus(J6.id, "SHOT");
    const r6 = await rowOf(J6.id);
    c.ok(`old (${BASE}): a board move back to Shot left Kim ACTIVE and the row still said "In editing"`, (await item("kim", J6.id))?.state === "ACTIVE" && r6?.status === "In editing", r6?.status);
    await work.closeActiveWork(J6.id, { reason: "PUT_BACK" });
  }
  const J7 = await mkJob({ street: "7 Board Rd", status: "SHOT", editor: "kim" });
  await kimStarts(J7.id, "kim-J7");
  const s7 = await starts();
  await appActions.moveProjectStatus(J7.id, "SHOT");
  const r7 = await rowOf(J7.id);
  const { stageMeta } = await import("@/lib/pipeline");
  c.ok("new: the board's move back to Shot is the office's put-back — CLOSED(PUT_BACK), the row reads Ready for editing",
    (await item("kim", J7.id))?.closeReason === "PUT_BACK" && r7?.status === "Ready for editing" && (await lines(J7.id, `moved back to ${stageMeta("SHOT").label} on the board by Jordan Spackman`)) === 1,
    r7?.status);
  await appActions.moveProjectStatus(J7.id, "EDITING");
  c.ok("…and the move forward to Editing starts nobody (no START, no ACTIVE)", (await starts()) === s7 && (await prisma.editorWorkItem.count({ where: { projectId: J7.id, state: "ACTIVE" } })) === 0);
  {
    // The project page's editor pick (assignMember) never moves the card
    // itself — the hourly refresh (tasks.mintEditTask) does. Batch 1's
    // "started work keeps its editor" rule outranked that pick, so a card the
    // rules routed to Kim stayed hers for good once she had paused on it
    // (batch-2 review, Sep 25). OLD first, on its own job.
    const pickJob = async (street: string) => {
      const j = await mkJob({ street, status: "SHOT", editor: "kim" });
      await prisma.smartTask.update({ where: { id: j.cardId }, data: { assignedManually: false } });
      await kimStarts(j.id, `kim-${street}`);
      await as(kim);
      await work.pauseEditing({ projectId: j.id, requestId: `kim-${street}-pause` });
      await as(jordan);
      await appActions.assignMember(j.id, "editor", johnTm.id);
      return j;
    };
    const oldTasks = (await import(baseline("src/lib/tasks.ts"))) as typeof import("@/lib/tasks");
    const J8o = await pickJob("8 Project Pick Old Rd");
    await oldTasks.mintEditTask(J8o.id);
    c.ok(`old (${BASE}): after the project page picked John on a job Kim had PAUSED, the refresh left the card Kim's and her work open`,
      (await cardOf(J8o.cardId)).assignedKey === "kim" && (await item("kim", J8o.id))?.state === "PAUSED");
    const tasks = await import("@/lib/tasks");
    const J8 = await pickJob("8 Project Pick Rd");
    await tasks.mintEditTask(J8.id);
    const card8 = await prisma.smartTask.findUniqueOrThrow({ where: { id: J8.cardId }, select: { assignedKey: true, assignedManually: true } });
    const kim8 = await item("kim", J8.id);
    c.ok("new: the office's pick moves the card to John (pinned as a hand pick)", card8.assignedKey === "john" && card8.assignedManually === true, `${card8.assignedKey} manual=${card8.assignedManually}`);
    c.ok("…and Kim's paused work closes as REASSIGNED in the same refresh; John is not started for her", kim8?.state === "CLOSED" && kim8.closeReason === "REASSIGNED" && !(await item("john", J8.id)), `${kim8?.state}/${kim8?.closeReason}`);
    await tasks.mintEditTask(J8.id);
    c.ok("…and a second refresh changes nothing (the card stays John's)", (await cardOf(J8.cardId)).assignedKey === "john");
    // Unchanged: with NO office pick, a started editor keeps the card over the rules.
    const J8r = await mkJob({ street: "8 Rules Only Rd", status: "SHOT", editor: "kim" });
    await prisma.smartTask.update({ where: { id: J8r.cardId }, data: { assignedManually: false } });
    await kimStarts(J8r.id, "kim-J8r");
    await prisma.project.update({ where: { id: J8r.id }, data: { editorId: johnTm.id, editorManual: false } });
    await tasks.mintEditTask(J8r.id);
    c.ok("unchanged: without an office pick, the rules never route a started job away from Kim", (await cardOf(J8r.cardId)).assignedKey === "kim" && (await item("kim", J8r.id))?.state === "ACTIVE");
  }

  // =========================================================================
  c.head("§2 · 7.1-sync-never-starts: the task card's status menu");
  // =========================================================================
  {
    const K0 = await mkJob({ street: "10 Menu Old Ct", status: "SHOT", editor: "kim" });
    await oldActions.setSmartTaskStatus(K0.cardId, "IN_PROGRESS");
    const r0 = await rowOf(K0.id);
    c.ok(`old (${BASE}): the office's "In progress" on Kim's edit card was written — a card claiming work nobody started (the row: "${r0?.status}")`,
      (await cardOf(K0.cardId)).status === "IN_PROGRESS" && (await prisma.editorWorkItem.count({ where: { projectId: K0.id } })) === 0 && r0?.status === "Ready for editing");
    const K0b = await mkJob({ street: "11 Menu Old Ct", status: "SHOT", editor: "kim" });
    await kimStarts(K0b.id, "kim-K0b");
    await oldActions.setSmartTaskStatus(K0b.cardId, "OPEN");
    c.ok(`old (${BASE}): setting the card back to Open left Kim ACTIVE — the card said "open", Working now said "editing"`, (await item("kim", K0b.id))?.state === "ACTIVE" && (await cardOf(K0b.cardId)).status === "OPEN");
    await work.closeActiveWork(K0b.id, { reason: "PUT_BACK" });
  }
  const K1 = await mkJob({ street: "12 Menu Ct", status: "SHOT", editor: "kim" });
  const sK = await starts();
  const refusedOffice = await appActions.setSmartTaskStatus(K1.cardId, "IN_PROGRESS");
  c.ok("new: the office's \"In progress\" on an in-house editor's card is refused, with the way to Start", !!refusedOffice && !refusedOffice.ok && /Start on the edit page for 12 Menu Ct/.test(refusedOffice.message), refusedOffice?.message);
  await as(kim);
  const refusedKim = await appActions.setSmartTaskStatus(K1.cardId, "IN_PROGRESS");
  await as(jordan);
  c.ok("…and Kim's own pick is refused the same way (the menu is not the Start button)", !!refusedKim && !refusedKim.ok);
  c.ok("…the card is untouched (OPEN), no work row exists, no START written", (await cardOf(K1.cardId)).status === "OPEN" && (await prisma.editorWorkItem.count({ where: { projectId: K1.id } })) === 0 && (await starts()) === sK);

  const K2 = await mkJob({ street: "13 Agency Ct", status: "SHOT", editor: "external_agency" });
  const ext = await appActions.setSmartTaskStatus(K2.cardId, "IN_PROGRESS");
  c.ok("the outside agency's card has no desk: its \"In progress\" is written as before, and starts nobody",
    ext === undefined && (await cardOf(K2.cardId)).status === "IN_PROGRESS" && (await prisma.editorWorkItem.count({ where: { projectId: K2.id } })) === 0);

  await kimStarts(K1.id, "kim-K1-a");
  const pauses0 = await events({ projectId: K1.id, kind: "PAUSE" });
  const back = await appActions.setSmartTaskStatus(K1.cardId, "OPEN");
  const pev = await prisma.editorWorkEvent.findFirst({ where: { projectId: K1.id, kind: "PAUSE" }, orderBy: { at: "desc" } });
  c.ok("new: back to Open on the card PAUSES Kim, recorded as Jordan on her behalf; the card reads Open",
    back === undefined && (await item("kim", K1.id))?.state === "PAUSED" && (await events({ projectId: K1.id, kind: "PAUSE" })) === pauses0 + 1 && pev?.onBehalf === true && pev.actorName === "Jordan Spackman" && (await cardOf(K1.cardId)).status === "OPEN");
  advance(60_000);
  await kimStarts(K1.id, "kim-K1-b");
  c.ok("…her own Resume is the only way back (RESUME event from startEditing)", (await item("kim", K1.id))?.state === "ACTIVE" && (await events({ projectId: K1.id, kind: "RESUME" })) === 1);
  await appActions.setSmartTaskStatus(K1.cardId, "WAITING_EDITOR");
  c.ok("\"waiting on the editor\" does not pause the editor who is on it", (await item("kim", K1.id))?.state === "ACTIVE");
  await appActions.setSmartTaskStatus(K1.cardId, "WAITING_CLIENT");
  c.ok("\"waiting on the client\" pauses her", (await item("kim", K1.id))?.state === "PAUSED");
  await kimStarts(K1.id, "kim-K1-c");
  await as(kim);
  await appActions.setSmartTaskStatus(K1.cardId, "BLOCKED");
  await as(jordan);
  const kev = await prisma.editorWorkEvent.findFirst({ where: { projectId: K1.id, kind: "PAUSE" }, orderBy: { at: "desc" } });
  c.ok("Kim marking her own card Blocked pauses her, recorded as HER", (await item("kim", K1.id))?.state === "PAUSED" && kev?.onBehalf === false && kev.actorRole === "EDITOR");

  const K3 = await mkJob({ street: "14 Complete Ct", status: "SHOT", editor: "kim" });
  await kimStarts(K3.id, "kim-K3");
  await appActions.setSmartTaskStatus(K3.cardId, "COMPLETED");
  c.ok("Complete on the edit card ends her stretch (CLOSED), with the words on the timeline",
    (await item("kim", K3.id))?.state === "CLOSED" && (await lines(K3.id, "the edit card was marked complete on the task board by Jordan Spackman")) === 1);
  const K4 = await mkJob({ street: "15 Dismiss Ct", status: "SHOT", editor: "kim" });
  await kimStarts(K4.id, "kim-K4");
  const dis = await appActions.dismissTask(K4.cardId, "not needed");
  c.ok("dismissing the edit card ends it too", dis.ok && (await item("kim", K4.id))?.state === "CLOSED" && (await lines(K4.id, "the edit card was dismissed (not needed) by Jordan Spackman")) === 1, dis.message);

  const K5 = await mkJob({ street: "16 Revision Ct", status: "REVISION", editor: "kim" });
  const rev = await prisma.smartTask.create({ data: { taskType: "revision", title: "Video revision — 16 Revision Ct", status: "OPEN", assignedKey: "kim", projectId: K5.id, clientId: client.id }, select: { id: true } });
  const sR = await starts();
  const rr = await appActions.setSmartTaskStatus(rev.id, "IN_PROGRESS");
  c.ok("a REVISION card's \"In progress\" keeps its own meaning (a corrected cut may be waiting) — written, starts nobody",
    rr === undefined && (await cardOf(rev.id)).status === "IN_PROGRESS" && (await prisma.editorWorkItem.count({ where: { projectId: K5.id } })) === 0 && (await starts()) === sR);

  // =========================================================================
  c.head("§3 · A64 the board, the edit card and the queue tell the same story");
  // =========================================================================
  const R1 = await mkJob({ street: "21 Ready Rd", status: "SHOT", editor: "kim" });
  const R2 = await mkJob({ street: "22 Legacy Rd", status: "EDITING", editor: "kim", cardStatus: "IN_PROGRESS" });
  const R4 = await mkJob({ street: "24 Paused Rd", status: "SHOT", editor: "kim" });
  const R3 = await mkJob({ street: "23 Active Rd", status: "SHOT", editor: "kim" });
  const R6 = await mkJob({ street: "26 Agency Rd", status: "EDITING", editor: "external_agency", cardStatus: "IN_PROGRESS" });
  await kimStarts(R4.id, "kim-R4");
  advance(60_000);
  await kimStarts(R3.id, "kim-R3"); // R4 pauses on its own
  const oldB2 = await oldBoardOf(R2.id);
  const oldB4 = await oldBoardOf(R4.id);
  c.ok(`old (${BASE}): the board said "With the editor" for an EDITING nobody confirmed AND for a paused job`,
    oldB2?.blockerLabel === "With the editor" && oldB4?.blockerLabel === "With the editor", `${oldB2?.blockerLabel} | ${oldB4?.blockerLabel}`);
  const board = await deliveryBoard();
  const q = await buildEditorQueue();
  const b = async (id: string) => (await boardOf(id, board))?.blockerLabel ?? "(not on the board)";
  const qr = async (id: string) => rowOf(id, q);
  const cards = await appActions.editCardWork([R1.cardId, R2.cardId, R3.cardId, R4.cardId, R6.cardId]);
  const card = (id: string) => cards.cards[id];
  c.ok("R1 files in, nobody: board Ready for editing · queue Ready for editing · card Not started yet",
    (await b(R1.id)) === "Ready for editing" && (await qr(R1.id))?.status === "Ready for editing" && card(R1.cardId)?.text === "Not started yet" && card(R1.cardId)?.tone === "none",
    `${await b(R1.id)} | ${(await qr(R1.id))?.status} | ${card(R1.cardId)?.text}`);
  c.ok("R2 EDITING, nobody pressed Start: board \"In editing — not confirmed\" · queue the same · card \"Nobody is on it right now\"",
    (await b(R2.id)) === "In editing — not confirmed" && (await qr(R2.id))?.status === "In editing — not confirmed" && card(R2.cardId)?.tone === "none" && card(R2.cardId)?.text === "Nobody is on it right now",
    `${await b(R2.id)} | ${(await qr(R2.id))?.status} | ${card(R2.cardId)?.text}`);
  c.ok("R3 Kim pressed Start: board \"In editing — Kim since …\" · queue In editing · card \"Active — Kim since …\"",
    /^In editing — Kim since /.test(await b(R3.id)) && (await qr(R3.id))?.status === "In editing" && card(R3.cardId)?.tone === "active" && /^Active — Kim since /.test(card(R3.cardId)?.text ?? ""),
    `${await b(R3.id)} | ${(await qr(R3.id))?.status} | ${card(R3.cardId)?.text}`);
  c.ok("R4 paused when she switched: board \"Paused — Kim …\" · queue Paused · card \"Paused — Kim …\"",
    /^Paused — Kim/.test(await b(R4.id)) && (await qr(R4.id))?.status === "Paused" && card(R4.cardId)?.tone === "paused" && /^Paused — Kim/.test(card(R4.cardId)?.text ?? ""),
    `${await b(R4.id)} | ${(await qr(R4.id))?.status} | ${card(R4.cardId)?.text}`);
  c.ok("R6 the outside agency's card wears no chip — nobody there can be \"active\"", cards.ok && !card(R6.cardId));
  const allBoard = [...board.today, ...board.tomorrow, ...board.upcoming, ...board.delivered];
  const activeIds = new Set((await prisma.editorWorkItem.findMany({ where: { state: "ACTIVE" }, select: { projectId: true } })).map((x) => x.projectId));
  const liars = allBoard.filter((j) => (/^In editing — (?!not confirmed)/.test(j.blockerLabel) && !activeIds.has(j.id)) || j.blockerLabel === "With the editor");
  c.ok("no board card says \"In editing — <name>\" without that person ACTIVE, and none says \"With the editor\"", liars.length === 0, liars.map((j) => `${j.title}: ${j.blockerLabel}`).join(" · ") || `${allBoard.length} cards`);
  await as(john);
  const johnSees = await appActions.editCardWork([R3.cardId]);
  await as(kim);
  const kimSees = await appActions.editCardWork([R3.cardId]);
  await as(jordan);
  c.ok("the card read is scoped: John gets nothing for Kim's card, Kim gets hers", johnSees.ok && !johnSees.cards[R3.cardId] && !!kimSees.cards[R3.cardId]);
  await prisma.$executeRawUnsafe(`ALTER TABLE "EditorWorkItem" RENAME TO "EditorWorkItem_away"`);
  const failedRead = await appActions.editCardWork([R3.cardId]);
  await prisma.$executeRawUnsafe(`ALTER TABLE "EditorWorkItem_away" RENAME TO "EditorWorkItem"`);
  c.ok("a failed read says it failed ({ ok: false }) — the card prints \"Couldn't check\", never a guess", !failedRead.ok && Object.keys(failedRead.cards).length === 0);
  {
    // Kyle's home and the owner's dial (batch 1's review round): already the
    // Start count, not the stage — confirmed here on this fixture.
    const { getOwnerDials } = await import("@/lib/queries");
    const dials = await getOwnerDials();
    const liveActive = await prisma.project.count({ where: { id: { in: [...activeIds] }, status: { notIn: ["DELIVERED", "CANCELLED"] } } });
    const editingStage = await prisma.project.count({ where: { status: "EDITING" } });
    c.ok("QualityDials: \"being edited now\" is the Start count, not the EDITING stage", dials.video.editingNow === liveActive && liveActive !== editingStage, `now ${dials.video.editingNow} · active ${liveActive} · EDITING stage ${editingStage}`);
    let opsEditing: number | string;
    try {
      const { buildOpsDay } = await import("@/lib/opsDay");
      opsEditing = (await buildOpsDay()).pipeline.editing;
    } catch (e) {
      opsEditing = `not driven: ${(e as Error).message.slice(0, 80)}`;
    }
    c.ok("Ops Day pipeline.editing (\"N being edited now\" on the home) is the same Start count", opsEditing === liveActive, String(opsEditing));
    // Batch-2 review: the rows under that pill still read the STAGE, so the
    // home could say "0 being edited now" above five rows marked "editing".
    const oldPage = execFileSync("git", ["show", `${BASE}:src/app/page.tsx`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
    c.ok(`old (${BASE}): every EDITING row on the home wore the bare stage word "editing"`, /r\.status === "REVIEW" \? "in review" : "editing"/.test(oldPage));
    {
      const { buildOpsDay } = await import("@/lib/opsDay");
      const rows = (await buildOpsDay()).pipeline.rows.filter((r) => r.status === "EDITING");
      const itemsOf = await prisma.editorWorkItem.findMany({ where: { projectId: { in: rows.map((r) => r.projectId) }, state: { in: ["ACTIVE", "PAUSED"] } }, select: { projectId: true, state: true } });
      const wrong = rows.filter((r) => {
        const st = itemsOf.filter((i) => i.projectId === r.projectId).map((i) => i.state);
        if (st.includes("ACTIVE")) return !/^In editing — \S/.test(r.workWord ?? "") || /not confirmed/.test(r.workWord ?? "");
        if (st.includes("PAUSED")) return !/^Paused/.test(r.workWord ?? "");
        return r.workWord !== "In editing — not confirmed";
      });
      c.ok("new: each EDITING row says who is on it — active, paused, or \"not confirmed\" — from the same work reader", rows.length > 0 && wrong.length === 0 && rows.some((r) => /^In editing — (?!not)/.test(r.workWord ?? "")) && rows.some((r) => r.workWord === "In editing — not confirmed"), `${rows.length} rows; wrong: ${wrong.map((r) => `${r.title}=${r.workWord}`).join(", ")}`);
      const page = fs.readFileSync(path.join(REPO, "src/app/page.tsx"), "utf8");
      c.ok("…and the home renders that word, not the stage", /r\.workWord \?\? "In editing — not confirmed"/.test(page) && !/r\.status === "REVIEW" \? "in review" : "editing"/.test(page));
    }
  }

  // =========================================================================
  c.head("§4 · O01/A32 \"Waiting on instructions\" — queue, card and board agree");
  // =========================================================================
  const SENTENCE = "Waiting on the flow and vision for the edit, the wrap-up on the upload page from Harrison Wells.";
  const W1 = await mkJob({ street: "31 Brief Missing Rd", status: "SHOT", editor: "kim", blocked: SENTENCE });
  const oldRow = (await oldQueue.buildEditorQueue()).notDone.find((r) => r.id === W1.id);
  c.ok(`old (${BASE}): the queue row said "Ready for editing" on a job whose card and board said it was waiting`, oldRow?.status === "Ready for editing", oldRow?.status);
  const w1 = await rowOf(W1.id);
  const w1b = await boardOf(W1.id);
  const w1c = (await appActions.editCardWork([W1.cardId])).cards[W1.cardId];
  const said = SENTENCE.replace(/\.$/, "");
  c.ok("new: the queue row reads \"Waiting on instructions\" with the engine's sentence under it", w1?.status === "Waiting on instructions" && w1.blocker === said, `${w1?.status} · ${w1?.blocker}`);
  c.ok("…the edit card says \"Waiting on instructions\" with the same sentence", w1c?.tone === "waiting" && w1c.text === "Waiting on instructions" && w1c.blocker === said);
  c.ok("…and Kyle's board carries the same sentence as its blocker", w1b?.blocker === "handoff_incomplete" && w1b.blockerLabel === said, w1b?.blockerLabel);
  await prisma.project.update({ where: { id: W1.id }, data: { handoffBlockedReason: null } });
  const w1r = await rowOf(W1.id);
  c.ok("the handoff completes → the row clears itself to Ready for editing", w1r?.status === "Ready for editing" && w1r.blocker === null, w1r?.status);
  const W2 = await mkJob({ street: "32 Pinned Rd", status: "SHOT", editor: "kim", blocked: SENTENCE });
  await prisma.project.update({ where: { id: W2.id }, data: { statusPinnedAt: new Date() } });
  const w2 = await rowOf(W2.id);
  c.ok("an office pin is the office's word: the pinned stage shows, the sentence still under it", w2?.status === "Ready for editing" && w2.blocker === said, w2?.status);
  const W3 = await mkJob({ street: "33 Started Anyway Rd", status: "SHOT", editor: "kim", blocked: SENTENCE });
  await kimStarts(W3.id, "kim-W3");
  const w3 = await rowOf(W3.id);
  c.ok("an editor who pressed Start anyway keeps \"In editing\"; the sentence still shows", w3?.status === "In editing" && w3.blocker === said, w3?.status);
  const { laneOf } = await import("@/lib/editorWorkload");
  c.ok("(noted, not changed here) editorWorkload.laneOf would fold the new word into \"Owed to the editor\"; the Editing Room page maps it to the waiting lane before it counts", laneOf("Waiting on instructions") === "editing");

  // =========================================================================
  c.head("§5 · 8.2 the cut stream voids a check when the folder bytes drift");
  // =========================================================================
  const F = await mkJob({ street: "41 Folder Cut Way", status: "REVIEW", editor: "kim" });
  const mkFolderCut = async (name: string, hash: string, status = "PENDING") => {
    const assetPath = `${F.folder}/05-Final-Video/${name}`;
    const sub = await prisma.reviewSubmission.create({
      data: {
        projectId: F.id, kind: "video", deliverableId: F.deliverableId, slot: 1, round: ++seq, status, source: "folder", fileName: name, assetPath,
        submittedByKey: "kim", submittedByName: "Kim Miguel", sourceRev: hash, selfCheckedAt: new Date(), decidedAt: status === "PENDING" ? null : new Date(),
      },
      select: { id: true },
    });
    const check = await prisma.cutSelfCheck.create({
      data: { submissionId: sub.id, projectId: F.id, round: 1, editorKey: "kim", actorName: "Kim Miguel", checklistKey: "standard_reel@v1", itemsJson: "[]", sourceRev: hash, fileIdentity: `dbx:${hash}`, state: "VALID" },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { selfCheckId: check.id } });
    return { id: sub.id, checkId: check.id, assetPath };
  };
  const play = (route: typeof streamRoute, id: string) => route.GET(new NextRequest(`http://127.0.0.1/api/review/cut/${id}/stream`), { params: Promise.resolve({ id }) });
  const checkState = async (id: string) => (await prisma.cutSelfCheck.findUniqueOrThrow({ where: { id } })).state;
  const subOf = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });
  const bells = (id: string) => prisma.notification.count({ where: { dedupeKey: { startsWith: `self-check-needed-${id}` } } });
  {
    const same = await mkFolderCut("same.mp4", "hash-A");
    dbxFiles.set(same.assetPath, { size: 900, hash: "hash-A" });
    const res = await play(streamRoute, same.id);
    c.ok("the bytes the editor checked: 302 to Dropbox, the check stands", res.status === 302 && (await checkState(same.checkId)) === "VALID" && !!(await subOf(same.id)).selfCheckedAt, `${res.status} ${res.status === 302 ? "" : JSON.stringify(await res.clone().json().catch(() => null))}`);
  }
  {
    const old = await mkFolderCut("old-route.mp4", "hash-A");
    dbxFiles.set(old.assetPath, { size: 901, hash: "hash-B" });
    const res = await play(oldStream as typeof streamRoute, old.id);
    c.ok(`old (${BASE}): a re-export over the same name streamed with the old check still VALID`, res.status === 302 && (await checkState(old.checkId)) === "VALID", `${res.status}`);
  }
  const drift = await mkFolderCut("drifted.mp4", "hash-A");
  dbxFiles.set(drift.assetPath, { size: 902, hash: "hash-B" });
  const dres = await play(streamRoute, drift.id);
  const dsub = await subOf(drift.id);
  c.ok("new: the bytes changed — the file still plays (302), the check is VOID with the reason", dres.status === 302 && (await checkState(drift.checkId)) === "VOID" && /replaced after the editor checked it/.test((await prisma.cutSelfCheck.findUniqueOrThrow({ where: { id: drift.checkId } })).voidReason ?? ""));
  // One ring = one notice, fanned out as one row per audience (the office,
  // and Kim by her editor key).
  const rung = await bells(drift.id);
  const kimRung = await prisma.notification.count({ where: { dedupeKey: { startsWith: `self-check-needed-${drift.id}` }, userKey: "editor:kim" } }).catch(() => -1);
  c.ok("…the cut is back with the editor (held: out of review until a fresh check), and the editor was told", sc.isHeldForSelfCheck(dsub) && dsub.selfCheckedAt === null && rung >= 1 && kimRung === 1,
    `held=${sc.isHeldForSelfCheck(dsub)} checkedAt=${dsub.selfCheckedAt?.toISOString() ?? null} rows=${rung} kim=${kimRung}`);
  const dres2 = await play(streamRoute, drift.id);
  c.ok("…a second play (a cached link) changes nothing and rings nothing", dres2.status === 302 && (await bells(drift.id)) === rung);
  await as(jordan);
  const ap = await reviewActions.approveCut(drift.id);
  c.ok("…and no verdict can land on it: approve refuses the held cut", !ap.ok && /check/i.test(ap.message), ap.message);
  {
    const approved = await mkFolderCut("approved.mp4", "hash-A", "APPROVED");
    dbxFiles.set(approved.assetPath, { size: 903, hash: "hash-C" });
    await play(streamRoute, approved.id);
    c.ok("an APPROVED cut's history is never rewritten by a play", (await checkState(approved.checkId)) === "VALID" && !!(await subOf(approved.id)).selfCheckedAt);
    const nohash = await mkFolderCut("nohash.mp4", "hash-A");
    dbxFiles.set(nohash.assetPath, { size: 904, hash: null });
    await play(streamRoute, nohash.id);
    c.ok("metadata with no hash proves nothing: the check stands", (await checkState(nohash.checkId)) === "VALID");
  }

  // =========================================================================
  c.head("§6 · 8.3 reanalyzeBrief asks the lock before it touches a tick");
  // =========================================================================
  const TWO_ITEMS = JSON.stringify({ items: [
    { id: "i1", area: "Music", ask: "Swap the song", detail: null, quote: null, cuts: null, scope: "all" },
    { id: "i2", area: "Text", ask: "Fix the name", detail: null, quote: null, cuts: null, scope: "all" },
  ], keep: [], references: [], questions: [] });
  const mkBrief = async (street: string, lane: "video" | "photo") => {
    const j = await mkJob({ street, status: "REVISION", editor: "kim" });
    const task = await prisma.smartTask.create({
      data: { taskType: "revision", title: `${lane === "video" ? "Video" : "Photo"} revision — ${street}`, status: "OPEN", assignedKey: lane === "video" ? "kim" : "kyle", projectId: j.id, clientId: client.id },
      select: { id: true },
    });
    const brief = await prisma.revisionBrief.create({
      data: { projectId: j.id, taskId: task.id, source: "manual", originalText: "Please swap the song and fix the name.", itemsJson: TWO_ITEMS, analyzedAt: new Date(), headline: "Two changes" },
      select: { id: true },
    });
    await ri.ingestBriefItems(brief.id);
    return { job: j, briefId: brief.id };
  };
  const doneOf = async (briefId: string) => (await prisma.revisionBrief.findUniqueOrThrow({ where: { id: briefId } })).doneJson;
  {
    const B0 = await mkBrief("51 Old Reread Ln", "video");
    await as(kim);
    await revisionActions.setBriefItemDone(B0.briefId, "i1", true);
    await ri.syncBriefTicks(B0.job.id); // the edit page's read mirrors the tick onto its issue
    await as(jordan);
    const r = await oldRevision.reanalyzeBrief(B0.briefId);
    c.ok(`old (${BASE}): the re-read was refused (the item was being worked) — but Kim's tick was wiped first`, !r.ok && (await doneOf(B0.briefId)) === null, `${r.message} · doneJson ${await doneOf(B0.briefId)}`);
  }
  const B1 = await mkBrief("52 Reread Ln", "video");
  await as(kim);
  await revisionActions.setBriefItemDone(B1.briefId, "i1", true);
  await as(jordan);
  const ai0 = aiCalls;
  const r1 = await revisionActions.reanalyzeBrief(B1.briefId);
  const addressed = await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${B1.briefId}:i1` }, state: "ADDRESSED" } });
  c.ok("new: a tick not yet read back still locks it — refused, the tick kept, no model call", !r1.ok && /Not re-read/.test(r1.message) && (await doneOf(B1.briefId)) === JSON.stringify(["i1"]) && aiCalls === ai0, r1.message);
  c.ok("…and the tick reached its issue (ADDRESSED) on the way", addressed >= 1);
  const B2 = await mkBrief("53 Fresh Reread Ln", "video");
  const r2 = await revisionActions.reanalyzeBrief(B2.briefId);
  c.ok("an untouched request re-reads (one model call) — renumbered, nothing to lose", r2.ok && aiCalls === ai0 + 1 && (await doneOf(B2.briefId)) === null, r2.message);
  const B3 = await mkBrief("54 Photo Lane Ln", "photo");
  await prisma.revisionBrief.update({ where: { id: B3.briefId }, data: { doneJson: JSON.stringify(["i2"]) } });
  aiDown = true;
  const r3 = await revisionActions.reanalyzeBrief(B3.briefId);
  aiDown = false;
  c.ok("a re-read that fails (the model is down) puts the ticks back — the items were never renumbered", !r3.ok && (await doneOf(B3.briefId)) === JSON.stringify(["i2"]), `${r3.message} · ${await doneOf(B3.briefId)}`);

  // =========================================================================
  c.head("§7 · 8.4 the editor's own review card on /editing");
  // =========================================================================
  {
    // require, not import(): tsx loads a dynamic import as a separate ESM
    // instance, and the element walk below compares the card's component by
    // identity — the page and the drill must hold the SAME module.
    // requirePageAccess does `await import("next/navigation")`, which the
    // preload's CJS redirect never sees. The ESM bridge reuses a CJS module
    // already in require.cache, so the real file's slot is filled with the
    // same stub the preload hands every CJS require.
    {
      const realNav = path.join(REPO, "node_modules/next/navigation.js");
      const M = Module as unknown as { new (id: string): { filename: string; loaded: boolean; exports: unknown; paths: string[] }; _cache: Record<string, unknown> };
      const m = new M(realNav);
      m.filename = realNav;
      m.loaded = true;
      m.exports = cjs(path.join(__dirname, "_next-navigation-stub.cjs"));
      M._cache[realNav] = m;
    }
    let page: (() => Promise<unknown>) | null = null;
    let why = "";
    try {
      page = (cjs(path.join(REPO, "src/app/editing/page.tsx")) as { default: () => Promise<unknown> }).default;
    } catch (e) {
      why = (e as Error).message.slice(0, 120);
    }
    const { EditorQualityCard } = cjs(path.join(REPO, "src/components/editing/EditorQualityCard.tsx")) as typeof import("@/components/editing/EditorQualityCard");
    type El = { type?: unknown; props?: Record<string, unknown> };
    const find = (node: unknown, out: El[] = []): El[] => {
      if (Array.isArray(node)) { for (const n of node) find(n, out); return out; }
      if (!node || typeof node !== "object") return out;
      const el = node as El;
      if (el.type === EditorQualityCard) out.push(el);
      if (el.props) for (const v of Object.values(el.props)) if (v && typeof v === "object") find(v, out);
      return out;
    };
    if (!page) {
      c.ok("the /editing page could be loaded in the drill", false, why);
    } else {
      await as(kim);
      const kimCards = find(await page());
      await as(john);
      const johnCards = find(await page());
      await as(jordan);
      const officeCards = find(await page());
      const rep = (el: El | undefined) => el?.props?.report as { editorKey: string | null } | undefined;
      c.ok("Kim's Editing Room carries HER review card (own), and only hers", kimCards.length === 1 && kimCards[0].props?.own === true && rep(kimCards[0])?.editorKey === "kim");
      c.ok("John's carries his own — never Kim's numbers", johnCards.length === 1 && rep(johnCards[0])?.editorKey === "john");
      c.ok("the office view has no per-editor card here (the team view stays on /quality)", officeCards.length === 0);
    }
  }

  // =========================================================================
  c.head("§8 · stale words");
  // =========================================================================
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
  const how = read("docs/HOW-A-VIDEO-MOVES.md");
  c.ok("HOW-A-VIDEO-MOVES says a 1080p file the hub cannot check is HELD in unverified/, and names the three choices",
    /is HELD, never sent/.test(how) && how.includes("05-Final-Video/unverified/") && how.includes("Check again") && how.includes("Keep the approved original") && how.includes("I listened — use this file"));
  c.ok("…and the board's editing words are the Start's, not \"With the editor\"", how.includes("In editing — Kim since") && /It used to say \*With the\s+editor\* for all three/.test(how));
  c.ok("CutUploader no longer says the finalize refuses a private upload", !read("src/components/editing/CutUploader.tsx").includes("§4.1 of that note is the finalize call that refuses"));
  c.ok("no \"Luma dispatch\" claim left in the upload submit or the Dropbox sweep", !/Luma dispatch/i.test(read("src/app/upload/actions.ts")) && !/Luma dispatch/i.test(read("src/lib/dropboxFolders.ts")));
  const { EDITORS } = await import("@/lib/editors");
  c.ok("Luma support itself is untouched (an active outside agency, Jordan Sep 25): the roster entry and the tracker link remain",
    !!(EDITORS as Record<string, unknown>).luma && read("src/components/queue/TaskCard.tsx").includes("LUMA_TRACKER_URL"));

  // ---- close ---------------------------------------------------------------
  c.ok("nothing left the building: only the Dropbox fake answered (at the edge); every other host was blocked",
    fence.faked.every((u) => DROPBOX_HOSTS.test(u)), `${fence.faked.length} faked at the edge, ${fence.blocked.length} blocked attempt(s), ${dbxCalls} faked Dropbox call(s), ${aiCalls} faked model call(s)`);
  quiet.restore();
  c.summary();
  fs.rmSync(BASE_DIR, { recursive: true, force: true });
  await stop();
  fence.restore();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
});
