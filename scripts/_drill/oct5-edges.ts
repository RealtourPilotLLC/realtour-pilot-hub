// @drill-run: engine=postgres needs=tools/realpg timeout=900
// ---------------------------------------------------------------------------
// DRILL: the Oct 5 2026 wave-2 edges (Review Room note default, R01 editor
// edges, navigation defaults).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct5-edges.ts
//
// On a disposable real Postgres (127.0.0.1:6660), with Kim's Start running in
// a CHILD PROCESS (her own session) and the office's write here, so both
// orderings of every new write are forced the same way the R01 drill forces
// them (realpg-start-eligibility.ts):
//   WRITER FIRST — the harness holds Kim's desk lock: her Start has done its
//     pre-reads and waits at the first statement of its switch; the office's
//     write runs to completion; the lock is released. Her Start must be
//     refused in the office's words with NOTHING written (her real job still
//     ACTIVE, same activeSince, no auto-pause).
//   START FIRST — a drill-only trigger parks her Start right after it logged
//     START (locked, judged, paused, activated, not committed); the office's
//     write is launched and must WAIT on the job's row lock (pg_locks and the
//     server's own lock-wait log), then land, and its own close takes the
//     Start with it.
//
//   §1 James's Review Room note type defaults to "Request a change" (the fix
//      note that becomes a tracked revision issue); Comment one tap away.
//   §2 navigation: the Clients group (Content Program + Clients) is open.
//   §A the project page's editor pick on a job with NO card closes the old
//      editor's work (pick another editor, clear the pick); a co-editor who
//      owns a video keeps hers; both orderings.
//   §B a task-card or Ask-the-Hub reassign moves the job's saved editor
//      (Project.editorId/editorManual) with the card, so the old hand-picked
//      editor does not get the job back when the card closes (or on the
//      hourly refresh); a revision moving while she keeps the edit card
//      leaves the pin alone; both orderings for both doors.
//   §C the hand-picked-editor rule grants Start only while the job is in
//      production: not DELIVERED / CANCELLED / ON_HOLD / taken off the
//      Editing Room; a card still counts on a delivered job; a hold's pause
//      survives the hourly ghost check; both orderings against the board's
//      Delivered.
//
// OLD = the same files at 3916561 (HEAD when this was built), pointed at this
// tree: each NEW check is paired with the defect OLD shows.
// ISOLATION: every .env secret blanked, fetch and raw sockets fenced in both
// processes; no provider is called or faked.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { attachDrillChild, bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree, quietPrismaErrors } from "./_harness";

const PORT = 6660;
const REPO = path.resolve(__dirname, "../..");
/** Pinned: the tree before these fixes. Never HEAD (it moves). */
const BASE = "3916561";
const RUNS = Math.max(1, Number(process.env.FORCED_ITERATIONS ?? 4));
const ROLE = process.env.DRILL_CHILD ? process.argv[2] : null;
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const has = (key: string) => (m: unknown) => !!m && typeof m === "object" && key in (m as object);

/** A file from BASE, its `@/` and relative imports pointed at this tree. */
function oldCopy(rel: string, dir: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  const from = path.dirname(path.join(REPO, rel));
  const pointed = src.replace(/((?:from|import)\s*\(?\s*)(["'])(@\/|\.\.?\/)([^"']+)\2/g, (_m, pre: string, q: string, head: string, rest: string) =>
    `${pre}${q}${head === "@/" ? path.join(REPO, "src", rest) : path.resolve(from, head + rest)}${q}`);
  const file = path.join(dir, `${BASE}-${rel.replace(/[/[\]]/g, "_")}`.replace(/\.tsx?$/, ".base.ts"));
  fs.writeFileSync(file, pointed);
  return file;
}

installNextStubs();

type U = { id: string; email: string; name: string | null; role: string };
type Cmd = { run: number; version: "old" | "new"; as: "kim"; projectId: string; requestId: string };
type Res = { run: number; ok: boolean; message: string; errors: string[] };

// ===========================================================================
// THE CHILD: Kim's browser — one Start per command.
// ===========================================================================
async function childMain(role: string) {
  if (role !== "starter") throw new Error(`unknown child role ${role}`);
  const ctx = attachDrillChild();
  quietPrismaErrors();
  const errs: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].startsWith("[editorWork]")) {
      const e = a[1] as { code?: string; meta?: { code?: string } } | undefined;
      errs.push(`${a[0]} ${e?.code ?? ""} ${e?.meta?.code ?? ""}`.trim());
    }
    realErr(...a);
  };
  const init = await ctx.waitFor<{ oldPath: string; users: Record<string, U> }>(has("oldPath"), 180_000);
  const { setSession } = await import("@/lib/auth/session");
  const workNew = await import("@/lib/editorWork");
  const workOld = (await import(init.oldPath)) as typeof workNew;
  await ctx.send({ ready: true });
  for (let k = 1; ; k++) {
    const m = await ctx.waitFor<Cmd | { exit: true }>((x) => !!x && typeof x === "object" && ((x as Cmd).run === k || "exit" in (x as object)), 900_000);
    if ("exit" in m) break;
    const u = init.users[m.as];
    await setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });
    errs.length = 0;
    let res: { ok: boolean; message: string };
    try {
      res = await (m.version === "old" ? workOld : workNew).startEditing({ projectId: m.projectId, requestId: m.requestId });
    } catch (e) {
      res = { ok: false, message: `THREW: ${e instanceof Error ? e.message : String(e)}` };
    }
    await ctx.send({ run: k, ok: res.ok, message: res.message, errors: [...errs] } satisfies Res);
  }
  await ctx.exit(0);
}

// ===========================================================================
// THE PARENT: the office.
// ===========================================================================
const fence = ROLE ? null : fenceFetch();

async function main() {
  if (!(await portFree(PORT))) throw new Error(`Drill port ${PORT} is busy — nothing was touched`);
  const drill = await bootDrillDb({ port: PORT, engine: "postgres", pool: 5, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oct5-edges-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"));
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const work = await import("@/lib/editorWork");
    const appActions = await import("@/app/actions");
    const tasks = await import("@/lib/tasks");
    const { execHubTool } = await import("@/lib/hubTools");
    const { advisoryKeyPair } = await import("@/lib/dbLocks");
    const { editorKeyForTeamName } = await import("@/lib/editors");
    const { queueRemovedKey, serialize } = await import("@/lib/queueRemoved");
    const { groupSidebarDestinations } = await import("@/lib/sidebarNavigation");
    const oldWorkPath = oldCopy("src/lib/editorWork.ts", tmp);
    const oldWork = (await import(oldWorkPath)) as typeof work;
    const oldActions = (await import(oldCopy("src/app/actions.ts", tmp))) as typeof appActions;
    const oldHub = (await import(oldCopy("src/lib/hubTools.ts", tmp))) as typeof import("@/lib/hubTools");

    // ======================================================================
    c.head("§1 · James's Review Room note type");
    // ======================================================================
    // The composer only renders after a click (no SSR path reaches it), so the
    // choice list itself is read: `choice` starts at 0, so entry 0 IS the
    // default. Static, and labelled as such.
    const lanesOf = (src: string) => {
      const block = src.match(/const CHOICES: LaneChoice\[\] = \[([\s\S]*?)\n\];/)?.[1] ?? "";
      return [...block.matchAll(/\{ lane: "(\w+)", kind: "(\w+)", label: "([^"]+)"/g)].map((m) => ({ lane: m[1], kind: m[2], label: m[3] }));
    };
    const panelNow = fs.readFileSync(path.join(REPO, "src/components/review/CutReviewPanel.tsx"), "utf8");
    const panelOld = execFileSync("git", ["show", `${BASE}:src/components/review/CutReviewPanel.tsx`], { cwd: REPO, encoding: "utf8" });
    const now = lanesOf(panelNow);
    const was = lanesOf(panelOld);
    c.ok(`OLD (${BASE}, static): the default note was "Comment" (coaching) — a reviewer who never touched the chip filed untracked notes`,
      was[0]?.kind === "coaching" && was[0]?.label === "Comment", JSON.stringify(was[0]));
    c.ok("NEW (static): the default is the fix note, \"Request a change\", to the editor",
      now[0]?.lane === "EDITOR" && now[0]?.kind === "fix" && now[0]?.label === "Request a change" && /const \[choice, setChoice\] = useState\(0\);/.test(panelNow), JSON.stringify(now[0]));
    c.ok("NEW (static): Comment is still one tap away, and the photographer's capture lane is unchanged",
      now.length === 3 && now[1]?.kind === "coaching" && now[1]?.label === "Comment" && now[2]?.lane === "PHOTOGRAPHER" && now[2]?.kind === "fix", JSON.stringify(now));

    // ======================================================================
    c.head("§2 · navigation defaults");
    // ======================================================================
    const groups = groupSidebarDestinations([{ href: "/" }, { href: "/content" }, { href: "/clients" }, { href: "/settings" }, { href: "/my-pay" }, { href: "/users" }], "/");
    const g = (id: string) => groups.find((x) => x.id === id);
    c.ok("the Clients group (Content Program, Clients) is open by default; Administration and Team keep their fold",
      g("clients")?.frequent === true && g("clients")?.items.map((i) => i.href).join() === "/content,/clients" && g("administration")?.frequent === false && g("team")?.frequent === false);

    // ---- the world ---------------------------------------------------------
    const client = await prisma.client.create({ data: { name: "Oct5 Edges Agent TEST" }, select: { id: true } });
    const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@edges.invalid", role: "EDITOR" }, select: { id: true } });
    const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@edges.invalid", role: "EDITOR" }, select: { id: true } });
    await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@edges.invalid", role: "MANAGER" } });
    const mkUser = (email: string, name: string, role: string, editorKey: string | null = null) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", editorKey }, select: { id: true, email: true, name: true, role: true } });
    const jordan = await mkUser("jordan@edges.invalid", "Jordan Spackman", "OWNER");
    const kim = await mkUser("kimm@edges.invalid", "Kim Miguel", "EDITOR", "kim");
    await mkUser("johnm@edges.invalid", "John Mark", "EDITOR", "john");
    await setSession({ uid: jordan.id, email: jordan.email, role: jordan.role, name: jordan.name ?? undefined });
    const hub = { role: "OWNER", who: "Jordan Spackman" };
    const tmOf = { kim: kimTm.id, john: johnTm.id } as const;

    type Key = "kim" | "john" | "kyle";
    type Job = { id: string; street: string; cardId: string | null; revId: string | null };
    let seq = 0;
    const mkJob = async (o: {
      street: string; status?: "SHOT" | "EDITING" | "REVIEW" | "REVISION" | "DELIVERED" | "CANCELLED" | "ON_HOLD" | "BOOKED";
      pin?: "kim" | "john" | null; card?: Key | null; cardManual?: boolean; revision?: Key | null; owner?: "kim";
    }): Promise<Job> => {
      const p = await prisma.project.create({
        data: {
          title: `${o.street}, Royersford, PA`, clientId: client.id, status: o.status ?? "SHOT", shootDate: new Date(Date.now() - 3 * DAY),
          ...(o.pin !== undefined ? { editorId: o.pin ? tmOf[o.pin] : null, editorManual: true } : {}),
        },
        select: { id: true },
      });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1 }, select: { id: true } });
      if (o.owner) await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: p.id, slot: 1, category: "VIDEO", ownerKey: o.owner, ownerName: "Kim Miguel" } });
      const card = o.card === undefined ? null : await prisma.smartTask.create({
        data: { taskType: "edit_video", title: `Edit — ${o.street}`, status: "OPEN", assignedKey: o.card, assignedManually: o.cardManual ?? true, projectId: p.id, clientId: client.id, dedupeKey: `edit-video-${p.id}` },
        select: { id: true },
      });
      const rev = o.revision === undefined ? null : await prisma.smartTask.create({
        data: { taskType: "revision", title: `Video revision — ${o.street}`, status: "OPEN", assignedKey: o.revision, assignedManually: true, projectId: p.id, clientId: client.id, dedupeKey: `edges-rev-${p.id}`, summary: "Client: make the music quieter" },
        select: { id: true },
      });
      seq++;
      return { id: p.id, street: o.street, cardId: card?.id ?? null, revId: rev?.id ?? null };
    };
    const pad = (n: number) => String(n).padStart(3, "0");

    // One world per run: P0 — Kim's real job (she holds its card and is
    // ACTIVE on it); P — the job she is about to press Start on.
    type World = { n: number; P0: Job; P: Job; t0: Date };
    let wn = 0;
    const world = async (p: Omit<Parameters<typeof mkJob>[0], "street">, street = "Edge Way"): Promise<World> => {
      await prisma.editorWorkItem.updateMany({ where: { editorKey: "kim", state: { not: "CLOSED" } }, data: { state: "CLOSED", activeFor: null, closedAt: new Date(), closeReason: "REMOVED" } });
      const n = ++wn;
      const P0 = await mkJob({ street: `${pad(n)} Current Job Ln`, status: "EDITING", card: "kim" });
      const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
      const it = await prisma.editorWorkItem.create({ data: { editorKey: "kim", projectId: P0.id, state: "ACTIVE", activeFor: "kim", activeSince: t0, firstStartedAt: t0, lastEventAt: t0 } });
      await prisma.editorWorkEvent.create({ data: { itemId: it.id, editorKey: "kim", projectId: P0.id, kind: "START", at: t0, actorName: "Kim Miguel", actorRole: "EDITOR" } });
      const P = await mkJob({ street: `${pad(n)} ${street}`, ...p });
      return { n, P0, P, t0 };
    };

    const state = async (w: World) => {
      const [p, card, rev, kp, p0, p0Pauses, kimActive] = await Promise.all([
        prisma.project.findUniqueOrThrow({ where: { id: w.P.id }, select: { status: true, editorManual: true, editor: { select: { name: true } } } }),
        w.P.cardId ? prisma.smartTask.findUniqueOrThrow({ where: { id: w.P.cardId }, select: { assignedKey: true, assignedManually: true, status: true } }) : null,
        w.P.revId ? prisma.smartTask.findUniqueOrThrow({ where: { id: w.P.revId }, select: { assignedKey: true } }) : null,
        prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: "kim", projectId: w.P.id } } }),
        prisma.editorWorkItem.findUniqueOrThrow({ where: { editorKey_projectId: { editorKey: "kim", projectId: w.P0.id } } }),
        prisma.editorWorkEvent.count({ where: { projectId: w.P0.id, kind: "AUTO_PAUSE" } }),
        prisma.editorWorkItem.count({ where: { editorKey: "kim", state: "ACTIVE" } }),
      ]);
      const holders = [...((await work.holdersFor([w.P.id])).get(w.P.id) ?? [])].sort();
      return {
        status: p.status as string,
        pin: p.editorManual ? editorKeyForTeamName(p.editor?.name) ?? (p.editor ? "other" : "nobody") : "rules",
        cardKey: card?.assignedKey ?? null, cardManual: card?.assignedManually ?? null, cardStatus: card?.status ?? null,
        revKey: rev?.assignedKey ?? null,
        kp: kp ? { state: kp.state, reason: kp.closeReason } : null,
        p0: { state: p0.state, same: p0.state === "ACTIVE" && p0.activeSince?.getTime() === w.t0.getTime() },
        p0Pauses, kimActive, holders,
      };
    };
    type State = Awaited<ReturnType<typeof state>>;
    const show = (s: State, r?: Res | null) =>
      `${r ? `${r.ok ? "ok" : "refused"}: "${r.message}" · ` : ""}P ${s.status} pin=${s.pin} card ${s.cardKey ?? "-"}${s.cardManual ? "(manual)" : ""}/${s.cardStatus ?? "-"} rev ${s.revKey ?? "-"} · Kim on P ${s.kp ? `${s.kp.state}${s.kp.reason ? `(${s.kp.reason})` : ""}` : "none"} · P0 ${s.p0.state}${s.p0.same ? " (same since)" : ""} pauses=${s.p0Pauses} · kimActive=${s.kimActive} · holders [${s.holders.join(",")}]`;

    // ---- the child and the two ways to force an ordering --------------------
    const kid = drill.runChild(__filename, { args: ["starter"] });
    kid.send({ oldPath: oldWorkPath, users: { kim } });
    await kid.waitFor(has("ready"), 240_000);
    let runN = 0;
    const startIn = (version: "old" | "new", projectId: string, requestId: string): Promise<Res> => {
      const k = ++runN;
      kid.send({ run: k, version, as: "kim", projectId, requestId } satisfies Cmd);
      return kid.waitFor<Res>((m) => (m as Res | null)?.run === k && has("ok")(m), 120_000);
    };
    const [dka, dkb] = advisoryKeyPair("editor-desk:kim");
    const holdDesk = () => drill.sql("SELECT pg_advisory_lock($1::int4, $2::int4)", [dka, dkb]);
    const freeDesk = () => drill.sql("SELECT pg_advisory_unlock($1::int4, $2::int4)", [dka, dkb]);
    await drill.sql(`CREATE FUNCTION drill_start_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(4243, 1); RETURN NEW; END $$`);
    await drill.sql(`CREATE TRIGGER drill_start_gate_t AFTER INSERT ON "EditorWorkEvent" FOR EACH ROW WHEN (NEW."kind" IN ('START', 'RESUME') AND NEW."editorKey" = 'kim') EXECUTE FUNCTION drill_start_gate()`);
    const holdGate = () => drill.sql("SELECT pg_advisory_lock(4243, 1)");
    const freeGate = () => drill.sql("SELECT pg_advisory_unlock(4243, 1)");
    const until = async (f: () => Promise<boolean>, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; ) { if (await f()) return true; await sleep(5); }
      return false;
    };
    const kimParked = () => until(async () => (await drill.waitingLocks()) >= 1, 8000);
    const rowWaits = async () => (await drill.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND l.locktype <> 'advisory' AND a.datname = 'drill'`))[0].n;

    type Order = "W" | "S";
    type Run = { r: Res; parked: boolean; writerWaited: boolean; writerError: string | null; serverWaits: number };
    const forced = async (order: Order, projectId: string, requestId: string, writer: () => Promise<unknown>): Promise<Run> => {
      let writerError: string | null = null;
      const runWriter = () => writer().then(() => undefined, (e: unknown) => { writerError = e instanceof Error ? e.message.slice(0, 160) : String(e); });
      const logged0 = drill.lockWaits();
      if (order === "W") {
        await holdDesk();
        const res = startIn("new", projectId, requestId);
        const parked = await kimParked();
        await runWriter();
        await freeDesk();
        return { r: await res, parked, writerWaited: false, writerError, serverWaits: drill.lockWaits() - logged0 };
      }
      await holdGate();
      const res = startIn("new", projectId, requestId);
      const parked = await kimParked();
      let settled = false;
      const wp = runWriter().finally(() => { settled = true; });
      let writerWaited = false;
      for (const end = Date.now() + 3000; Date.now() < end && !settled; await sleep(5)) {
        if ((await rowWaits()) >= 1) { writerWaited = true; break; }
      }
      if (writerWaited) await sleep(150); // past deadlock_timeout, so the server logs both waits
      await freeGate();
      const r = await res;
      await wp;
      await sleep(50);
      return { r, parked, writerWaited, writerError, serverWaits: drill.lockWaits() - logged0 };
    };

    const NOT_YOURS = /isn't assigned to you, so you can't start it\. Ask the office to hand it over\.$/;
    const quietStart = (s: State) => s.p0.same && s.p0Pauses === 0 && s.kimActive === 1;
    const allErrors: string[] = [];
    let backendsPeak = 0;
    /** Both orderings, RUNS times each, for one office write. */
    const orderings = async (o: {
      tag: string; title: string; mk: () => Promise<World>; writer: (w: World) => Promise<unknown>;
      refusal: RegExp; left: (s: State) => boolean; leftWords: string; undone: (s: State) => boolean; undoneWords: string;
    }) => {
      for (const order of ["W", "S"] as Order[]) {
        c.head(`${o.tag} ${order === "W" ? "WRITER FIRST" : "START FIRST"} · ${o.title}`);
        const fails: string[] = [];
        let example = "";
        for (let i = 0; i < RUNS; i++) {
          const w = await o.mk();
          const { result: run, distinctBackends } = await drill.backendsDuring(() => forced(order, w.P.id, `${o.tag}-${order}-${i}-${w.n}`, () => o.writer(w)));
          backendsPeak = Math.max(backendsPeak, distinctBackends);
          const s = await state(w);
          allErrors.push(...run.r.errors);
          const line = show(s, run.r);
          example ||= line;
          const why: string[] = [];
          if (!run.parked) why.push("the switch never parked (the ordering was not forced)");
          if (run.writerError) why.push(`writer threw: ${run.writerError}`);
          if (run.r.errors.length) why.push("the switch logged an error");
          if (order === "W") {
            if (run.r.ok || !o.refusal.test(run.r.message)) why.push("not refused in the expected words");
            if (s.kp?.state === "ACTIVE") why.push("ACTIVE on the job anyway");
            if (!quietStart(s)) why.push("the refused Start touched her real job");
          } else {
            if (!run.writerWaited) why.push("the office's write did not wait on the Start's row lock");
            if (run.serverWaits < 2) why.push(`the server logged ${run.serverWaits} lock wait(s), not both`);
            if (!run.r.ok) why.push("the Start (eligible when it committed) was refused");
            if (!o.undone(s)) why.push(`not undone behind it (${o.undoneWords})`);
            if (s.kimActive !== 0) why.push("Kim is still ACTIVE somewhere");
          }
          if (!o.left(s)) why.push(`the writer's state was not kept (${o.leftWords})`);
          if (why.length) fails.push(`#${i + 1}: ${why.join("; ")} — ${line}`);
        }
        const words = order === "W"
          ? `refused in its own words, NOTHING written — her real job still ACTIVE (same activeSince, no auto-pause); ${o.leftWords}`
          : `the office's write WAITED on the job's row lock (pg_locks and the server's log), then ${o.undoneWords}; ${o.leftWords}`;
        c.ok(`NEW: ${words} — ${RUNS - fails.length}/${RUNS}`, fails.length === 0, fails[0] ?? example);
      }
    };
    const closedAs = (reason: string) => (s: State) => s.kp?.state === "CLOSED" && s.kp.reason === reason;
    /** Kim presses Start on P (normally) and it lands. */
    const kimStarts = async (w: World, tag: string, version: "old" | "new" = "new") => startIn(version, w.P.id, `${tag}-${w.n}`);

    // ======================================================================
    c.head("§A · the project page's editor pick on a job with NO card");
    // ======================================================================
    {
      const pinnedNoCard = () => world({ pin: "kim" }, "Picked Pl");
      // A1: pick John
      const pickJohn = async (actions: typeof appActions) => {
        const w = await pinnedNoCard();
        const r0 = await kimStarts(w, "A1-start");
        await actions.assignMember(w.P.id, "editor", johnTm.id);
        return { w, r0, s: await state(w) };
      };
      const o1 = await pickJohn(oldActions);
      c.ok(`OLD (actions.ts @ ${BASE}): no card moved, so nothing closed — Kim stays ACTIVE on a job the project page gave to John`,
        o1.r0.ok && o1.s.pin === "john" && o1.s.kp?.state === "ACTIVE" && !o1.s.holders.includes("kim"), show(o1.s));
      const n1 = await pickJohn(appActions);
      c.ok("NEW: Kim (held only through the pin) is CLOSED as REASSIGNED the moment John is picked; John holds the job",
        n1.r0.ok && n1.s.pin === "john" && closedAs("REASSIGNED")(n1.s) && n1.s.kimActive === 0 && n1.s.holders.join() === "john", show(n1.s));
      const again = await kimStarts(n1.w, "A1-again");
      c.ok("…and her next Start is refused in the office's words", !again.ok && NOT_YOURS.test(again.message), again.message);
      const line = await prisma.activity.findFirst({ where: { projectId: n1.w.P.id, body: { contains: "editing closed" } }, select: { body: true } });
      c.ok("…recorded on the timeline as the office's pick", !!line?.body.includes("picked John Mark on the project page"), line?.body);

      // A2: clear the pick
      const clear = async (actions: typeof appActions) => {
        const w = await pinnedNoCard();
        const r0 = await kimStarts(w, "A2-start");
        await actions.assignMember(w.P.id, "editor", null);
        return { r0, s: await state(w) };
      };
      const o2 = await clear(oldActions);
      c.ok(`OLD (${BASE}): clearing the pick left Kim ACTIVE on a job nobody holds`, o2.r0.ok && o2.s.kp?.state === "ACTIVE" && o2.s.holders.length === 0, show(o2.s));
      const n2 = await clear(appActions);
      c.ok("NEW: clearing the pick closes her work as UNASSIGNED; nobody holds the job", n2.r0.ok && closedAs("UNASSIGNED")(n2.s) && n2.s.holders.length === 0 && n2.s.pin === "rules", show(n2.s));

      // A2b: the direct project door (assignTeamMember) rewrites the same column
      const direct = async (actions: typeof appActions) => {
        const w = await pinnedNoCard();
        const r0 = await kimStarts(w, "A2b-start");
        await actions.assignTeamMember(w.P.id, "editorId", johnTm.id);
        return { r0, s: await state(w) };
      };
      const o2b = await direct(oldActions);
      c.ok(`OLD (${BASE}): the direct editor door (assignTeamMember) left Kim ACTIVE on a job now pinned to John`, o2b.r0.ok && o2b.s.kp?.state === "ACTIVE" && o2b.s.pin === "john", show(o2b.s));
      const n2b = await direct(appActions);
      c.ok("NEW: the direct editor door closes her work too (REASSIGNED)", n2b.r0.ok && closedAs("REASSIGNED")(n2b.s) && n2b.s.holders.join() === "john", show(n2b.s));

      // A3: a co-editor who still owns a video keeps hers
      const w3 = await world({ pin: "kim", owner: "kim" }, "Shared Ct");
      const r3 = await kimStarts(w3, "A3-start");
      await appActions.assignMember(w3.P.id, "editor", johnTm.id);
      const s3 = await state(w3);
      c.ok("NEW: Kim still owns one of the job's videos — the pick to John leaves her work ACTIVE (closeGhostWork's rule); both hold the job",
        r3.ok && s3.kp?.state === "ACTIVE" && s3.holders.join() === "john,kim", show(s3));

      await orderings({
        tag: "§A4", title: "Kim's Start vs the project page's pick of John on a job with no card (assignMember)",
        mk: pinnedNoCard,
        writer: (w) => appActions.assignMember(w.P.id, "editor", johnTm.id),
        refusal: NOT_YOURS,
        left: (s) => s.pin === "john" && s.holders.join() === "john", leftWords: "the job is pinned to John and only John holds it",
        undone: closedAs("REASSIGNED"), undoneWords: "her Start is CLOSED as REASSIGNED",
      });
    }

    // ======================================================================
    c.head("§B · a task-card or Ask-the-Hub reassign carries the job's saved editor");
    // ======================================================================
    {
      const pinnedCard = (cardManual = true) => world({ pin: "kim", card: "kim", cardManual }, "Pinned Card Rd");
      const closeCard = (id: string) => prisma.smartTask.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } });

      // B1: the task card's picker, then the card closes
      const viaCard = async (actions: typeof appActions) => {
        const w = await pinnedCard();
        await actions.setTaskAssignee(w.P.cardId!, "john");
        const moved = await state(w);
        await closeCard(w.P.cardId!);
        return { w, moved, closed: await state(w) };
      };
      const o1 = await viaCard(oldActions);
      c.ok(`OLD (actions.ts @ ${BASE}): the card moved but the job stayed pinned to Kim — when John's card closed, the job went back to her`,
        o1.moved.cardKey === "john" && o1.moved.pin === "kim" && o1.closed.holders.join() === "kim", show(o1.closed));
      const n1 = await viaCard(appActions);
      c.ok("NEW: the card AND the job's saved editor move to John together (card pinned by hand)",
        n1.moved.cardKey === "john" && n1.moved.cardManual === true && n1.moved.pin === "john", show(n1.moved));
      c.ok("…and when John's card closes, the job is John's — Kim does not get it back", n1.closed.holders.join() === "john", show(n1.closed));
      const r1 = await kimStarts(n1.w, "B1-kim");
      c.ok("…her Start is refused", !r1.ok && NOT_YOURS.test(r1.message), r1.message);

      // B2: Ask the Hub
      const viaHub = async (h: typeof oldHub) => {
        const w = await pinnedCard();
        const out = await h.execHubTool("assign_task", { task: `Edit — ${w.P.street}`, person: "john" }, hub) as { done?: boolean; error?: string };
        const moved = await state(w);
        await closeCard(w.P.cardId!);
        return { out, moved, closed: await state(w) };
      };
      const o2 = await viaHub(oldHub);
      c.ok(`OLD (hubTools.ts @ ${BASE}): the chat moved the card only — after it closed, the job was Kim's again`,
        o2.out.done === true && o2.moved.cardKey === "john" && o2.moved.pin === "kim" && o2.closed.holders.join() === "kim", show(o2.closed));
      const n2 = await viaHub(await import("@/lib/hubTools"));
      c.ok("NEW: Ask the Hub moves the card and the saved editor together; after the card closes the job is John's",
        n2.out.done === true && n2.moved.cardKey === "john" && n2.moved.pin === "john" && n2.closed.holders.join() === "john", `${JSON.stringify(n2.out)} · ${show(n2.closed)}`);

      // B3: the hourly refresh on an unpinned card
      const refresh = async (actions: typeof appActions) => {
        const w = await pinnedCard(false);
        await actions.setTaskAssignee(w.P.cardId!, "john");
        await tasks.mintEditTask(w.P.id);
        return state(w);
      };
      const o3 = await refresh(oldActions);
      c.ok(`OLD (${BASE}): within the hour the refresh routed the card back to the pin — Kim — undoing the office's reassign`, o3.cardKey === "kim", show(o3));
      const n3 = await refresh(appActions);
      c.ok("NEW: the refresh leaves the card with John (the pin and the card agree)", n3.cardKey === "john" && n3.pin === "john", show(n3));

      // B4: a video revision is the only live card
      const revOnly = async (actions: typeof appActions) => {
        const w = await world({ status: "REVISION", pin: "kim", revision: "kim" }, "Revision Only Dr");
        await actions.setTaskAssignee(w.P.revId!, "john");
        const moved = await state(w);
        await closeCard(w.P.revId!);
        return { moved, closed: await state(w) };
      };
      const o4 = await revOnly(oldActions);
      c.ok(`OLD (${BASE}): moving the job's only video revision to John left the pin on Kim — she held the job again once it closed`, o4.moved.revKey === "john" && o4.closed.holders.join() === "kim", show(o4.closed));
      const n4 = await revOnly(appActions);
      c.ok("NEW: the revision was Kim's last video card, so the pin follows it to John", n4.moved.revKey === "john" && n4.moved.pin === "john" && n4.closed.holders.join() === "john", show(n4.closed));

      // B5: narrowing — Kim keeps the edit card
      const w5 = await world({ status: "REVISION", pin: "kim", card: "kim", revision: "kim" }, "Two Cards Ave");
      await appActions.setTaskAssignee(w5.P.revId!, "john");
      const s5 = await state(w5);
      c.ok("NEW: a revision moving while Kim still holds the edit card leaves the job's pin on Kim (both hold it)",
        s5.revKey === "john" && s5.cardKey === "kim" && s5.pin === "kim" && s5.holders.join() === "john,kim", show(s5));

      // B6: back to Kyle (un-delegate)
      const kyle = async (actions: typeof appActions) => {
        const w = await pinnedCard(false);
        const r0 = await kimStarts(w, "B6-start", "new");
        await actions.setTaskAssignee(w.P.cardId!, "kyle");
        const moved = await state(w);
        await tasks.mintEditTask(w.P.id);
        return { r0, moved, refreshed: await state(w) };
      };
      const o6 = await kyle(oldActions);
      c.ok(`OLD (${BASE}): handed back to Kyle, the hourly refresh routed the card straight back to Kim`, o6.refreshed.cardKey === "kim", show(o6.refreshed));
      const n6 = await kyle(appActions);
      c.ok("NEW: handed back to Kyle, the job is pinned to nobody — Kim's work is CLOSED and the refresh routes nothing back to her",
        n6.r0.ok && n6.moved.pin === "nobody" && closedAs("REASSIGNED")(n6.moved) && n6.moved.holders.length === 0 && n6.refreshed.cardKey === "kyle", `${show(n6.moved)} → ${show(n6.refreshed)}`);

      await orderings({
        tag: "§B7", title: "Kim's Start vs the task card's picker on a job pinned to her (setTaskAssignee)",
        mk: () => pinnedCard(),
        writer: (w) => appActions.setTaskAssignee(w.P.cardId!, "john"),
        refusal: NOT_YOURS,
        left: (s) => s.cardKey === "john" && s.pin === "john", leftWords: "the card and the job's pin are John's",
        undone: closedAs("REASSIGNED"), undoneWords: "her Start is CLOSED as REASSIGNED",
      });
      await orderings({
        tag: "§B8", title: "Kim's Start vs Ask the Hub's assign_task on a job pinned to her",
        mk: () => pinnedCard(),
        writer: (w) => execHubTool("assign_task", { task: `Edit — ${w.P.street}`, person: "john" }, hub),
        refusal: NOT_YOURS,
        left: (s) => s.cardKey === "john" && s.pin === "john", leftWords: "the card and the job's pin are John's",
        undone: closedAs("REASSIGNED"), undoneWords: "her Start is CLOSED as REASSIGNED",
      });
    }

    // ======================================================================
    c.head("§C · the hand-picked editor holds a job only while it is in production");
    // ======================================================================
    {
      const removedMarker = (projectId: string, restored: boolean) => prisma.appSetting.create({
        data: { key: queueRemovedKey(projectId), value: serialize({ by: "Jordan Spackman", at: new Date(), note: "drill", task: null, restoredAt: restored ? new Date() : null, restoredBy: restored ? "Jordan Spackman" : null }) },
      });
      type Case = { name: string; status: Parameters<typeof mkJob>[0]["status"]; removed?: "live" | "restored"; holds: boolean; refusal: RegExp | null };
      const cases: Case[] = [
        { name: "SHOT", status: "SHOT", holds: true, refusal: null },
        { name: "EDITING", status: "EDITING", holds: true, refusal: null },
        { name: "REVIEW", status: "REVIEW", holds: true, refusal: null },
        { name: "REVISION", status: "REVISION", holds: true, refusal: null },
        { name: "BOOKED (a board drag back, no hold)", status: "BOOKED", holds: true, refusal: null },
        { name: "DELIVERED", status: "DELIVERED", holds: false, refusal: NOT_YOURS },
        { name: "CANCELLED", status: "CANCELLED", holds: false, refusal: /^That job is cancelled — there is nothing to edit\.$/ },
        { name: "ON_HOLD (keeps its holder for the pause; Start refused for everyone)", status: "ON_HOLD", holds: true, refusal: /is on hold — it can't be started until the office takes it off hold\.$/ },
        { name: "taken off the Editing Room", status: "SHOT", removed: "live", holds: false, refusal: /was taken off the Editing Room by the office — bring it back before starting it\.$/ },
        { name: "brought back to the Editing Room", status: "SHOT", removed: "restored", holds: true, refusal: null },
      ];
      for (const k of cases) {
        const w = await world({ status: k.status, pin: "kim" }, `Status ${k.status} Pl`);
        if (k.removed) await removedMarker(w.P.id, k.removed === "restored");
        const holdsNew = (await work.holdersFor([w.P.id])).get(w.P.id)?.has("kim") === true;
        const tx = await prisma.$transaction((t) => work.holdersFor([w.P.id], t));
        const holdsTx = tx.get(w.P.id)?.has("kim") === true;
        const r = await kimStarts(w, `C-${k.status}-${k.removed ?? "none"}`);
        const s = await state(w);
        const startOk = k.refusal ? !r.ok && k.refusal.test(r.message) && s.kp === null && quietStart(s) : r.ok && s.kp?.state === "ACTIVE";
        c.ok(`${k.name}: hand-picked Kim ${k.holds ? "holds" : "does NOT hold"} the job (plain and in-transaction reads agree); her Start is ${k.refusal ? "refused, nothing written" : "allowed"}`,
          holdsNew === k.holds && holdsTx === k.holds && startOk, `${r.ok ? "ok" : "refused"}: ${r.message} · ${show(s)}`);
        if (k.status === "DELIVERED") {
          const oldHolds = (await oldWork.holdersFor([w.P.id])).get(w.P.id)?.has("kim") === true;
          const w2 = await world({ status: "DELIVERED", pin: "kim" }, "Old Delivered Pl");
          const ro = await kimStarts(w2, "C-old-delivered", "old");
          const so = await state(w2);
          c.ok(`OLD (editorWork.ts @ ${BASE}): on a DELIVERED job the pin alone made Kim a holder — her Start landed, ACTIVE on a delivered job`,
            oldHolds && ro.ok && so.kp?.state === "ACTIVE" && so.status === "DELIVERED", `${ro.message} · ${show(so)}`);
          c.ok("…and NEW refuses her upload/check/message gates there too (editorHoldsAssignedWork)", !(await work.editorHoldsAssignedWork(w.P.id, "kim")));
        }
      }
      // A card still counts on a delivered job (taken-back work).
      const wc = await world({ status: "DELIVERED", pin: "kim", card: "kim" }, "Delivered With Card Ln");
      const rc = await kimStarts(wc, "C-delivered-card");
      c.ok("DELIVERED with a live edit card for Kim: the card is the test — she holds it and her Start lands", rc.ok && (await state(wc)).kp?.state === "ACTIVE", rc.message);

      // On hold pauses; the hourly ghost check must not close the pause.
      const wh = await world({ status: "SHOT", pin: "kim" }, "Held Pause Ct");
      const rh = await kimStarts(wh, "C-hold-start");
      await appActions.moveProjectStatus(wh.P.id, "ON_HOLD");
      const paused = await state(wh);
      await work.closeGhostWorkEverywhere();
      const afterSweep = await state(wh);
      await appActions.moveProjectStatus(wh.P.id, "EDITING");
      const rr = await kimStarts(wh, "C-hold-resume");
      const resumed = await prisma.editorWorkEvent.count({ where: { projectId: wh.P.id, editorKey: "kim", kind: "RESUME" } });
      c.ok("ON_HOLD: her Start on a hand-picked job is PAUSED by the hold, the hourly ghost check leaves the pause alone, and she RESUMEs it after the hold",
        rh.ok && paused.kp?.state === "PAUSED" && afterSweep.kp?.state === "PAUSED" && rr.ok && resumed === 1, `${show(paused)} → ${show(afterSweep)} → ${rr.message}`);

      await orderings({
        tag: "§C1", title: "Kim's Start vs the board's Delivered on a hand-picked job with no card (moveProjectStatus)",
        mk: () => world({ status: "SHOT", pin: "kim" }, "Delivered Race Rd"),
        writer: (w) => appActions.moveProjectStatus(w.P.id, "DELIVERED"),
        refusal: NOT_YOURS,
        left: (s) => s.status === "DELIVERED" && s.holders.length === 0, leftWords: "the job is DELIVERED and nobody holds it",
        undone: closedAs("PROJECT_DELIVERED"), undoneWords: "her Start is CLOSED as PROJECT_DELIVERED",
      });
    }

    // ======================================================================
    c.head("§Z · the whole drill");
    // ======================================================================
    kid.send({ exit: true });
    await sleep(100);
    c.ok("the switch never failed — no error logged by editorWork in the child", allErrors.length === 0, allErrors.slice(0, 3).join(" | ") || "none");
    c.ok("non-vacuous: two processes, several backends at once", backendsPeak >= 2, `peak ${backendsPeak}`);
    c.ok("non-vacuous: the server itself logged lock waits", drill.lockWaits() >= 1, `${drill.lockWaits()} logged`);
    c.ok("0 attempts to reach anything off this machine, in either process", fence!.blocked.length === 0 && fence!.faked.length === 0, fence!.blocked.slice(0, 5).join(", ") || "none");
    c.ok("no client or provider message was queued", (await prisma.outboxMessage.count()) === 0);
    c.ok("the database was this drill's own", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/drill?`));
    console.log(`\n    ${await drill.evidence()}`);
    console.log(`    (${quiet.count} expected prisma:error log lines suppressed; ${seq} jobs built)`);
  } finally {
    quiet.restore();
    c.summary();
    await drill.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}

(ROLE ? childMain(ROLE) : main()).catch((e) => { console.error(e); process.exit(1); });
