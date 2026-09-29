// ---------------------------------------------------------------------------
// DRILL: R01 — a Start judged from stale reads (Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/realpg-start-eligibility.ts
//
// The review's finding: startEditing decided whether a Start was allowed from
// reads taken BEFORE its transaction; the transaction then paused the editor's
// current job, wrote ACTIVE and moved the job to In editing without looking
// again. On a disposable Postgres 18 (the harness's real engine), with Kim's
// Start running in a CHILD PROCESS and the competing office write here, this
// forces both orderings of every write that takes a job away from her:
//
//   WRITER FIRST — the harness holds Kim's desk lock, so her Start has done
//     its pre-reads and waits on the first statement of its switch; the
//     office's write runs to completion; the lock is released.
//       OLD (editorWork.ts @ 1075a5b): the job she read as startable is
//       revived (EDITING over CANCELLED / On hold / Waiting), or she is made
//       ACTIVE on a job the card now gives to John — and her real job is
//       paused and the office's bell rings, both for nothing.
//       NEW: refused in the office's words, and NOTHING written: her current
//       job is still ACTIVE with the same activeSince, no AUTO_PAUSE, no
//       timeline line, no bell.
//   START FIRST — a drill-only trigger parks her Start right after it logged
//     START (it has locked, judged, paused and activated); the office's write
//     is launched; the gate opens.
//       OLD: the write never waits (nothing it touches is locked) and its
//       close reads before the Start commits, so the Start survives it.
//       NEW: the write WAITS on the job's row lock (seen in pg_locks, not by a
//       clock), then lands, and its own close/pause takes the Start with it.
//
//   §1 cancel — the board (moveProjectStatus) and Aryeo's (a status write +
//      closeObsoleteTasks, exactly what the order sync does)
//   §2 reassign — setEditVideoEditor(John), setTaskAssignee(John), and the
//      dispatch to the outside agency
//   §3 the office's holds — Waiting (setQueueStatus) and On hold (the board)
//   §4 the project page's pick: mintEditTask parked between its "did anyone
//      start?" count and its card update, a Start landing in between
//   §5 delivery: closeObsoleteTasks parked mid-close, a Start landing there
//   §6 unforced: the two processes let go together with random lags
//   §7 the office's Start "for the card's editor" against a reassign
//   §8 confirmCurrentWork (the other ACTIVE writer) against cancel/reassign
//   §9 taken off the Editing Room — a job held only through a video revision
//   §10 Ask the Hub's assign_task / complete_task
//   §4b (review fix, Sep 28) the RULES' route (no office pin) against a Start
//      landing inside the hourly refresh: started work outranks the rules
//   §12 (review fix, Sep 28) TWO open cards: a third session holds the card
//      the Start locks first, the Start and a multi-card writer queue behind
//      it — the ordered card lock against the writer's heap-order UPDATE
//      deadlocked every time in the review. OLD = the R01 build the review
//      read (b222dde); NEW = the writers take the job's row first
//      (editorWork.underJobLock). setEditVideoEditor, Aryeo's cancel
//      (closeObsoleteTasks), resolveRevision, the board's Delivered.
//      §12e the backstop retries, deterministically: a drill trigger raises
//      the deadlock's SQLSTATE once inside the one-time confirm, the
//      reassign and resolveRevision — OLD loses the click (or leaves the
//      job off Revisions with its asks open), NEW runs it once more.
//
// ISOLATION: a disposable real Postgres on 127.0.0.1:${DRILL_PORT ?? 6250};
// every .env secret blanked and fetch AND raw sockets fenced in both processes;
// no provider is faked because no provider is called.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { attachDrillChild, bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6250);
const REPO = path.resolve(__dirname, "../..");
/** Pinned: the tree the review read. Never HEAD. */
const BASE = "1075a5b";
/** The R01 build the Sep 28 review of R01 read (§4b, §12). Never HEAD. */
const PREV = "b222dde";
/** NEW runs per §12 scenario and ordering; OLD runs (each must deadlock). */
const TWO_CARD_RUNS = Math.max(1, Number(process.env.TWO_CARD_ITERATIONS ?? 5));
const TWO_CARD_OLD = Math.max(1, Number(process.env.TWO_CARD_OLD ?? 2));
/** Unforced race iterations (§6), and NEW runs per forced scenario and ordering. */
const RACES = Math.max(1, Number(process.env.RACE_ITERATIONS ?? 20));
const FORCED = Math.max(1, Number(process.env.FORCED_ITERATIONS ?? RACES));
/** OLD runs per forced scenario and ordering (each must show the defect). */
const OLD_RUNS = Math.max(1, Number(process.env.OLD_ITERATIONS ?? 5));
const ROLE = process.env.DRILL_CHILD ? process.argv[2] : null;
/** ONLY=1,5 runs just those sections (a debugging aid; the full drill is the evidence). */
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const on = (section: string) => ONLY.length === 0 || ONLY.includes(section.replace(/^§?(\d+).*$/, "$1"));
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const has = (key: string) => (m: unknown) => !!m && typeof m === "object" && key in (m as object);
/** A door the drill opens: `wait` blocks until `open()` is called. */
const door = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; };

/** A file from BASE (or `rev`), its `@/` and relative imports pointed at this tree. */
function oldCopy(rel: string, dir: string, rev: string = BASE): string {
  const src = execFileSync("git", ["show", `${rev}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  const from = path.dirname(path.join(REPO, rel));
  const pointed = src.replace(/((?:from|import)\s*\(?\s*)(["'])(@\/|\.\.?\/)([^"']+)\2/g, (_m, pre: string, q: string, head: string, rest: string) =>
    `${pre}${q}${head === "@/" ? path.join(REPO, "src", rest) : path.resolve(from, head + rest)}${q}`);
  const file = path.join(dir, `${rev}-${rel.replace(/[/[\]]/g, "_")}`.replace(/\.ts$/, ".base.ts"));
  fs.writeFileSync(file, pointed);
  return file;
}

installNextStubs();

// ---- parked points (parent only) --------------------------------------------
// A writer is held mid-flight at ONE database call so a Start can land exactly
// there. The hook sits on the Prisma client every module in this process gets
// ("@/lib/prisma", and the OLD copies' absolute path to the same file), so it
// catches the call wherever it is made from — a module-level wrapper would
// miss a dynamic import made from an OLD copy outside the tree. One-shot, and
// only the call it was armed for; every other call passes straight through.
type DbPark = { model: string; method: string; when: "before" | "after"; match: (args: unknown) => boolean; reached: () => void; wait: Promise<void> };
let dbPark: DbPark | null = null;
function park(model: string, method: string, when: DbPark["when"], match: (args: unknown) => boolean) {
  const inside = door();
  const release = door();
  dbPark = { model, method, when, match, reached: inside.open, wait: release.wait };
  const reached = Promise.race([
    inside.wait,
    sleep(30_000).then(() => { throw new Error(`the ${model}.${method} park was never reached — the ordering was not forced`); }),
  ]);
  return { inside: reached, release: release.open };
}
async function atPark(p: DbPark, args: unknown) {
  if (dbPark !== p || !p.match(args)) return;
  dbPark = null;
  p.reached();
  await p.wait;
}
if (!ROLE) {
  interceptModule((r) => r === "@/lib/prisma" || /[\\/]src[\\/]lib[\\/]prisma(\.ts)?$/.test(r), (loaded) => {
    const mod = loaded as Record<string | symbol, unknown>;
    const real = mod.prisma as Record<string | symbol, unknown>;
    const bind = (v: unknown, self: object) => (typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(self) : v);
    const client = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        const p = dbPark;
        if (!p || k !== p.model) return bind(v, t);
        const d = v as Record<string | symbol, unknown>;
        return new Proxy(d, {
          get(dt, m) {
            const f = Reflect.get(dt, m, dt);
            if (m !== p.method || typeof f !== "function") return bind(f, dt);
            return async (args: unknown) => {
              if (p.when === "before") await atPark(p, args);
              const out = await (f as (a: unknown) => Promise<unknown>).call(dt, args);
              if (p.when === "after") await atPark(p, args);
              return out;
            };
          },
        });
      },
    });
    return new Proxy(mod, { get: (t, k) => (k === "prisma" ? client : Reflect.get(t, k)) });
  });
}
const whereOf = (args: unknown) => ((args as { where?: Record<string, unknown> } | null)?.where ?? {});

type U = { id: string; email: string; name: string | null; role: string };
type Cmd = {
  run: number;
  /** old = BASE (1075a5b); prev = PREV (b222dde, the build the Sep 28 review read); new = this tree. */
  version: "old" | "prev" | "new";
  fn: "start" | "confirm";
  as: "kim" | "jordan";
  projectId: string;
  requestId: string;
  forEditorKey?: string | null;
  /** §6: tell the parent "armed", wait for "go", then wait lagMs. */
  armFirst?: boolean;
  lagMs?: number;
};
type Res = { run: number; ok: boolean; message: string; errors: string[]; warnings: string[] };

// ===========================================================================
// THE CHILD: Kim's (or the office's) browser — one Start per command.
// ===========================================================================
async function childMain(role: string) {
  if (role !== "starter") throw new Error(`unknown child role ${role}`);
  const ctx = attachDrillChild();
  quietPrismaErrors();
  // What the switch itself reports failing (a P2028, a 40P01, a P2002) — the
  // NEW runs must show none of it.
  const errs: string[] = [];
  // …and the switch's one retry after a lock conflict (§12): a warning, not
  // an error, but the evidence that Postgres threw a Start away.
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].startsWith("[editorWork]")) warns.push(a[0]);
    realWarn(...a);
  };
  const realErr = console.error;
  console.error = (...a: unknown[]) => {
    if (typeof a[0] === "string" && a[0].startsWith("[editorWork]")) {
      const e = a[1] as { code?: string; meta?: { code?: string } } | undefined;
      errs.push(`${a[0]} ${e?.code ?? ""} ${e?.meta?.code ?? ""}`.trim());
    }
    realErr(...a);
  };
  const init = await ctx.waitFor<{ oldPath: string; prevPath: string; users: Record<string, U> }>(has("oldPath"), 180_000);
  const { setSession } = await import("@/lib/auth/session");
  const workNew = await import("@/lib/editorWork");
  const workOld = (await import(init.oldPath)) as typeof workNew;
  const workPrev = (await import(init.prevPath)) as typeof workNew;
  await ctx.send({ ready: true, pid: process.pid });
  for (let k = 1; ; k++) {
    const m = await ctx.waitFor<Cmd | { exit: true }>((x) => !!x && typeof x === "object" && ((x as Cmd).run === k || "exit" in (x as object)), 900_000);
    if ("exit" in m) break;
    const u = init.users[m.as];
    await setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });
    if (m.armFirst) {
      await ctx.send({ armed: k });
      await ctx.waitFor((x) => (x as { go?: number } | null)?.go === k, 60_000);
      if (m.lagMs) await sleep(m.lagMs);
    }
    const w = m.version === "old" ? workOld : m.version === "prev" ? workPrev : workNew;
    errs.length = 0;
    warns.length = 0;
    let res: { ok: boolean; message: string };
    try {
      res = m.fn === "confirm"
        ? await w.confirmCurrentWork({ projectId: m.projectId, requestId: m.requestId })
        : await w.startEditing({ projectId: m.projectId, requestId: m.requestId, forEditorKey: m.forEditorKey ?? null });
    } catch (e) {
      res = { ok: false, message: `THREW: ${e instanceof Error ? e.message : String(e)}` };
    }
    await ctx.send({ run: k, ok: res.ok, message: res.message, errors: [...errs], warnings: [...warns] } satisfies Res);
  }
  await ctx.exit(0);
}

// ===========================================================================
// THE PARENT: the office.
// ===========================================================================
const fence = ROLE ? null : fenceFetch();

async function main() {
  const drill = await bootDrillDb({ port: PORT, engine: "postgres", pool: 5, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r01-start-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"));
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const work = await import("@/lib/editorWork");
    const appActions = await import("@/app/actions");
    const editing = await import("@/app/editing/actions");
    const tasks = await import("@/lib/tasks");
    const { execHubTool } = await import("@/lib/hubTools");
    const { advisoryKeyPair } = await import("@/lib/dbLocks");
    const { waitingHoldKey } = await import("@/lib/queueWaiting");
    const { queueRemovedKey, serialize } = await import("@/lib/queueRemoved");
    const oldWorkPath = oldCopy("src/lib/editorWork.ts", tmp);
    const oldTasks = (await import(oldCopy("src/lib/tasks.ts", tmp))) as typeof tasks;
    // The R01 build the review read, for §4b and §12.
    const prevTasks = (await import(oldCopy("src/lib/tasks.ts", tmp, PREV))) as typeof tasks;
    const prevEditing = (await import(oldCopy("src/app/editing/actions.ts", tmp, PREV))) as typeof editing;
    const prevActions = (await import(oldCopy("src/app/actions.ts", tmp, PREV))) as typeof appActions;
    const prevComms = (await import(oldCopy("src/lib/comms.ts", tmp, PREV))) as typeof import("@/lib/comms");
    const comms = await import("@/lib/comms");
    // The office side's own retries (underJobLock's backstop), for §12.
    const parentWarns: string[] = [];
    {
      const realWarn = console.warn;
      console.warn = (...a: unknown[]) => {
        if (typeof a[0] === "string" && a[0].startsWith("[editorWork]")) parentWarns.push(a[0]);
        realWarn(...a);
      };
    }

    // ---- the world ---------------------------------------------------------
    const client = await prisma.client.create({ data: { name: "R01 Drill Agent TEST" }, select: { id: true } });
    const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR" }, select: { id: true } });
    const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR" }, select: { id: true } });
    const mkUser = (email: string, name: string, role: string, editorKey: string | null = null) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", editorKey }, select: { id: true, email: true, name: true, role: true } });
    const jordan = await mkUser("jordan@drill.invalid", "Jordan Spackman", "OWNER");
    const kim = await mkUser("kimm@drill.invalid", "Kim Miguel", "EDITOR", "kim");
    await mkUser("johnm@drill.invalid", "John Mark", "EDITOR", "john");
    // The parent is the office for the whole drill.
    await setSession({ uid: jordan.id, email: jordan.email, role: jordan.role, name: jordan.name ?? undefined });

    let seq = 0;
    type Job = { id: string; street: string; cardId: string | null; revId: string | null };
    const mkJob = async (o: { street: string; status: "SHOT" | "EDITING"; card?: boolean; cardManual?: boolean; cardStatus?: string; revision?: boolean }): Promise<Job> => {
      const p = await prisma.project.create({
        data: {
          title: `${o.street}, Royersford, PA`, clientId: client.id, status: o.status, aryeoOrderId: `r01-${++seq}`,
          shootDate: new Date(Date.now() - 3 * DAY), editorId: kimTm.id, payableInvoice: 400, price: 400,
        },
        select: { id: true },
      });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1 } });
      const card = o.card === false ? null : await prisma.smartTask.create({
        data: { taskType: "edit_video", title: `Edit — ${o.street}`, status: o.cardStatus ?? "OPEN", assignedKey: "kim", assignedManually: o.cardManual ?? true, projectId: p.id, clientId: client.id, dedupeKey: `edit-video-${p.id}` },
        select: { id: true },
      });
      const rev = o.revision ? await prisma.smartTask.create({
        data: { taskType: "revision", title: `Video revision — ${o.street}`, status: "OPEN", assignedKey: "kim", assignedManually: true, projectId: p.id, clientId: client.id, dedupeKey: `r01-rev-${p.id}`, summary: "Client: make the music quieter" },
        select: { id: true },
      }) : null;
      return { id: p.id, street: o.street, cardId: card?.id ?? null, revId: rev?.id ?? null };
    };

    // One world per run: P0, Kim's real job, where she is ACTIVE; P, the job
    // she is about to press Start on, which the office is about to take away.
    type World = { n: number; P0: Job; P: Job; t0: Date };
    let wn = 0;
    const pad = (n: number) => String(n).padStart(3, "0");
    const world = async (p: Partial<Parameters<typeof mkJob>[0]> = {}): Promise<World> => {
      await prisma.editorWorkItem.updateMany({ where: { editorKey: "kim", state: { not: "CLOSED" } }, data: { state: "CLOSED", activeFor: null, closedAt: new Date(), closeReason: "REMOVED" } });
      const n = ++wn;
      const P0 = await mkJob({ street: `${pad(n)} Current Job Ln`, status: "SHOT" });
      const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
      const it = await prisma.editorWorkItem.create({ data: { editorKey: "kim", projectId: P0.id, state: "ACTIVE", activeFor: "kim", activeSince: t0, firstStartedAt: t0, lastEventAt: t0 } });
      await prisma.editorWorkEvent.create({ data: { itemId: it.id, editorKey: "kim", projectId: P0.id, kind: "START", at: t0, actorName: "Kim Miguel", actorRole: "EDITOR" } });
      const P = await mkJob({ street: `${pad(n)} Contested Way`, status: "SHOT", ...p });
      return { n, P0, P, t0 };
    };

    // Everything a run is judged on, read after it.
    const state = async (w: World) => {
      const [p, card, kp, p0, p0Pauses, p0Lines, bells, kimActive, marker, activeOnP] = await Promise.all([
        prisma.project.findUniqueOrThrow({ where: { id: w.P.id }, select: { status: true } }),
        w.P.cardId ? prisma.smartTask.findUniqueOrThrow({ where: { id: w.P.cardId }, select: { assignedKey: true, status: true } }) : null,
        prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: "kim", projectId: w.P.id } } }),
        prisma.editorWorkItem.findUniqueOrThrow({ where: { editorKey_projectId: { editorKey: "kim", projectId: w.P0.id } } }),
        prisma.editorWorkEvent.count({ where: { projectId: w.P0.id, kind: "AUTO_PAUSE" } }),
        prisma.activity.count({ where: { projectId: w.P0.id, body: { contains: "editing paused" } } }),
        prisma.notification.count({ where: { kind: "edit_started", title: { contains: w.P.street } } }),
        prisma.editorWorkItem.count({ where: { editorKey: "kim", state: "ACTIVE" } }),
        prisma.appSetting.findUnique({ where: { key: waitingHoldKey(w.P.id) } }),
        prisma.editorWorkItem.findMany({ where: { projectId: w.P.id, state: "ACTIVE" }, select: { editorKey: true } }),
      ]);
      const holders = (await work.holdersFor([w.P.id])).get(w.P.id) ?? new Set<string>();
      // Every AUTO_PAUSE of her real job must be paired with the Start that
      // caused it: same editor, the job it names, the same instant.
      const pauses = await prisma.editorWorkEvent.findMany({ where: { projectId: w.P0.id, kind: "AUTO_PAUSE" }, select: { switchedTo: true, at: true, editorKey: true } });
      let unpaired = 0;
      for (const e of pauses) {
        const n = await prisma.editorWorkEvent.count({ where: { editorKey: e.editorKey, projectId: e.switchedTo ?? "-", kind: { in: ["START", "RESUME", "CONFIRM"] }, at: e.at } });
        if (n === 0) unpaired++;
      }
      return {
        status: p.status as string,
        cardKey: card?.assignedKey ?? null,
        cardStatus: card?.status ?? null,
        kp: kp ? { state: kp.state, reason: kp.closeReason } : null,
        p0: { state: p0.state, same: p0.state === "ACTIVE" && p0.activeSince?.getTime() === w.t0.getTime() },
        p0Pauses, p0Lines, bells, kimActive, hold: !!marker, unpaired,
        ghosts: activeOnP.filter((a) => !holders.has(a.editorKey)).length,
      };
    };
    type State = Awaited<ReturnType<typeof state>>;
    const show = (s: State, r: Res | null) =>
      `${r ? `${r.ok ? "ok" : "refused"}: "${r.message}" · ` : ""}P ${s.status} card ${s.cardKey ?? "-"}/${s.cardStatus ?? "-"} · Kim on P ${s.kp ? `${s.kp.state}${s.kp.reason ? `(${s.kp.reason})` : ""}` : "none"} · P0 ${s.p0.state}${s.p0.same ? " (same since)" : ""} pauses=${s.p0Pauses} · bells=${s.bells} · kimActive=${s.kimActive}${s.ghosts ? ` · GHOSTS=${s.ghosts}` : ""}${s.unpaired ? ` · UNPAIRED=${s.unpaired}` : ""}${r?.errors.length ? ` · errors=${r.errors.join("|")}` : ""}`;

    // ---- the child and the two ways to force an ordering --------------------
    const kid = drill.runChild(__filename, { args: ["starter"] });
    kid.send({ oldPath: oldWorkPath, prevPath: oldCopy("src/lib/editorWork.ts", tmp, PREV), users: { kim, jordan } });
    await kid.waitFor(has("ready"), 240_000);
    let runN = 0;
    const startIn = (cmd: Omit<Cmd, "run">): Promise<Res> => {
      const k = ++runN;
      kid.send({ ...cmd, run: k });
      return kid.waitFor<Res>((m) => (m as Res | null)?.run === k && has("ok")(m), 120_000);
    };
    const [dka, dkb] = advisoryKeyPair("editor-desk:kim");
    const holdDesk = () => drill.sql("SELECT pg_advisory_lock($1::int4, $2::int4)", [dka, dkb]);
    const freeDesk = () => drill.sql("SELECT pg_advisory_unlock($1::int4, $2::int4)", [dka, dkb]);
    // START FIRST: a Start (or a confirm) by Kim waits on this gate right after
    // it logged its event — it has locked, judged, paused and activated, and
    // not yet committed. The gate is free unless the harness holds it.
    await drill.sql(`CREATE FUNCTION drill_start_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(4242, 1); RETURN NEW; END $$`);
    await drill.sql(`CREATE TRIGGER drill_start_gate_t AFTER INSERT ON "EditorWorkEvent" FOR EACH ROW WHEN (NEW."kind" IN ('START', 'RESUME', 'CONFIRM') AND NEW."editorKey" = 'kim') EXECUTE FUNCTION drill_start_gate()`);
    const holdGate = () => drill.sql("SELECT pg_advisory_lock(4242, 1)");
    const freeGate = () => drill.sql("SELECT pg_advisory_unlock(4242, 1)");
    const until = async (f: () => Promise<boolean>, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; ) { if (await f()) return true; await sleep(5); }
      return false;
    };
    // Kim's switch waiting on an advisory lock (the desk, or the gate).
    const kimParked = () => until(async () => (await drill.waitingLocks()) >= 1, 8000);
    // Somebody waiting on a ROW (tuple/transaction lock) — never the harness's
    // own advisory locks: the office's write queued behind Kim's switch.
    const rowWaits = async () => (await drill.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND l.locktype <> 'advisory' AND a.datname = 'drill'`))[0].n;

    type Order = "W" | "S";
    type Run = { r: Res; parked: boolean; writerWaited: boolean; writerError: string | null; serverWaits: number };
    const forced = async (order: Order, cmd: Omit<Cmd, "run">, writer: () => Promise<unknown>): Promise<Run> => {
      let writerError: string | null = null;
      const runWriter = () => writer().then(() => undefined, (e: unknown) => { writerError = e instanceof Error ? e.message.slice(0, 160) : String(e); });
      const logged0 = drill.lockWaits();
      if (order === "W") {
        await holdDesk();
        const res = startIn(cmd);
        const parked = await kimParked();
        await runWriter();
        await freeDesk();
        return { r: await res, parked, writerWaited: false, writerError, serverWaits: drill.lockWaits() - logged0 };
      }
      await holdGate();
      const res = startIn(cmd);
      const parked = await kimParked();
      let settled = false;
      const wp = runWriter().finally(() => { settled = true; });
      // Waited = seen queued on a row while the Start is still parked. A
      // writer that never waits settles on its own, and the poll stops there.
      let writerWaited = false;
      for (const end = Date.now() + 3000; Date.now() < end && !settled; await sleep(5)) {
        if ((await rowWaits()) >= 1) { writerWaited = true; break; }
      }
      // Hold both waits past deadlock_timeout (50 ms) so the SERVER logs them
      // too — the Start's on the gate and the writer's on the row.
      if (writerWaited) await sleep(150);
      await freeGate();
      const r = await res;
      await wp;
      await sleep(50); // the server's log line lands after a wait ends
      return { r, parked, writerWaited, writerError, serverWaits: drill.lockWaits() - logged0 };
    };

    // ---- the verdicts --------------------------------------------------------
    const quietStart = (s: State) => s.p0.same && s.p0Pauses === 0 && s.p0Lines === 0 && s.bells === 0 && s.kimActive === 1;
    const NOT_YOURS_4B = /isn't assigned to you, so you can't start it\. Ask the office to hand it over\.$/;
    type Scenario = {
      tag: string;
      title: string;
      mk: () => Promise<World>;
      writer: (w: World) => Promise<unknown>;
      as?: "kim" | "jordan";
      fn?: "start" | "confirm";
      /** NEW, writer first: the words, and what the writer left. */
      refusal: RegExp;
      left: (s: State) => boolean;
      leftWords: string;
      /** NEW, Start first: what the writer did to the Start that beat it. */
      undone?: (s: State) => boolean;
      undoneWords?: string;
      /** OLD shows the defect. */
      oldBad: (s: State) => boolean;
      oldBadWords: string;
      orders?: Order[];
      oldOrders?: Order[];
    };
    const allErrors: string[] = [];
    let backendsPeak = 0;
    const runScenario = async (sc: Scenario) => {
      if (!on(sc.tag)) return;
      for (const order of sc.orders ?? (["W", "S"] as Order[])) {
        const oldOn = (sc.oldOrders ?? ["W", "S"]).includes(order);
        c.head(`${sc.tag} ${order === "W" ? "WRITER FIRST" : "START FIRST"} · ${sc.title}`);
        const cmd = (w: World, version: "old" | "new", i: number): Omit<Cmd, "run"> => ({
          version, fn: sc.fn ?? "start", as: sc.as ?? "kim", projectId: w.P.id, requestId: `${sc.tag}-${order}-${version}-${i}-${w.n}`,
        });
        if (oldOn) {
          const bad: string[] = [];
          let last = "";
          for (let i = 0; i < OLD_RUNS; i++) {
            const w = await sc.mk();
            const run = await forced(order, cmd(w, "old", i), () => sc.writer(w));
            const s = await state(w);
            last = show(s, run.r);
            if (sc.oldBad(s) && run.parked && (order === "W" || !run.writerWaited)) bad.push(last);
          }
          c.ok(`OLD (editorWork.ts @ ${BASE}): ${sc.oldBadWords} — ${bad.length}/${OLD_RUNS}`, bad.length === OLD_RUNS, bad[0] ?? last);
        }
        const fails: string[] = [];
        let example = "";
        for (let i = 0; i < FORCED; i++) {
          const w = await sc.mk();
          const { result: run, distinctBackends } = await drill.backendsDuring(() => forced(order, cmd(w, "new", i), () => sc.writer(w)));
          backendsPeak = Math.max(backendsPeak, distinctBackends);
          const s = await state(w);
          allErrors.push(...run.r.errors);
          const line = show(s, run.r);
          example ||= line;
          const why: string[] = [];
          if (!run.parked) why.push("the switch never parked (the ordering was not forced)");
          if (run.writerError) why.push(`writer threw: ${run.writerError}`);
          if (run.r.errors.length) why.push("the switch logged an error");
          if (s.ghosts || s.unpaired || s.kimActive > 1) why.push("an invariant broke");
          if (order === "W") {
            if (run.r.ok || !sc.refusal.test(run.r.message)) why.push("not refused in the expected words");
            if (s.kp?.state === "ACTIVE") why.push("ACTIVE on the job anyway");
            if (!quietStart(s)) why.push("the refused Start touched her real job / rang the bell");
            if (!sc.left(s)) why.push(`the writer's state was not kept (${sc.leftWords})`);
          } else {
            if (!run.writerWaited) why.push("the office's write did not wait on the Start's row lock");
            if (run.serverWaits < 2) why.push(`the server logged ${run.serverWaits} lock wait(s), not both`);
            if (!run.r.ok) why.push("the Start (eligible when it committed) was refused");
            if (!sc.undone?.(s)) why.push(`not undone behind it (${sc.undoneWords})`);
            if (!sc.left(s)) why.push(`the writer's state was not kept (${sc.leftWords})`);
            if (s.kimActive !== 0) why.push("Kim is still ACTIVE somewhere");
          }
          if (why.length) fails.push(`#${i + 1}: ${why.join("; ")} — ${line}`);
        }
        const expectWords = order === "W"
          ? `refused in its own words, NOTHING written — her real job still ACTIVE (same activeSince, no AUTO_PAUSE, no timeline line), no bell; ${sc.leftWords}`
          : `the office's write WAITED on the job's row lock (pg_locks, and the server's own log), then ${sc.undoneWords}; ${sc.leftWords}`;
        c.ok(`NEW: ${expectWords} — ${FORCED - fails.length}/${FORCED}`, fails.length === 0, fails[0] ?? example);
      }
    };

    const cancelled = (s: State) => s.status === "CANCELLED";
    const revived = (s: State) => s.status === "EDITING" && s.kp?.state === "ACTIVE";
    const onJohns = (key: string) => (s: State) => s.kp?.state === "ACTIVE" && s.cardKey === key;
    const closedAs = (reason: string) => (s: State) => s.kp?.state === "CLOSED" && s.kp.reason === reason;

    // ======================================================================
    // §1 · CANCEL
    // ======================================================================
    await runScenario({
      tag: "§1a", title: "Kim's Start vs the board's Cancelled (moveProjectStatus)",
      mk: () => world(),
      writer: (w) => appActions.moveProjectStatus(w.P.id, "CANCELLED"),
      refusal: /^That job is cancelled — there is nothing to edit\.$/,
      left: cancelled, leftWords: "the job stays CANCELLED",
      undone: closedAs("PROJECT_CANCELLED"), undoneWords: "her Start is CLOSED as PROJECT_CANCELLED",
      oldBad: revived, oldBadWords: "the cancelled job is revived — EDITING, Kim ACTIVE on it (a board cancel is never re-applied)",
    });
    await runScenario({
      tag: "§1b", title: "Kim's Start vs Aryeo's cancel (the order sync's status write + closeObsoleteTasks)",
      mk: () => world(),
      writer: async (w) => {
        await prisma.project.update({ where: { id: w.P.id }, data: { status: "CANCELLED", statusPinnedAt: null } });
        await tasks.closeObsoleteTasks(w.P.id, "CANCELLED");
      },
      refusal: /^That job is cancelled — there is nothing to edit\.$/,
      left: cancelled, leftWords: "the job stays CANCELLED",
      undone: closedAs("PROJECT_CANCELLED"), undoneWords: "her Start is CLOSED as PROJECT_CANCELLED",
      oldBad: revived, oldBadWords: "the cancelled job is revived — EDITING, Kim ACTIVE on it",
    });

    // ======================================================================
    // §2 · REASSIGN
    // ======================================================================
    const NOT_YOURS = /isn't assigned to you, so you can't start it\. Ask the office to hand it over\.$/;
    await runScenario({
      tag: "§2a", title: "Kim's Start vs the Editing Room's reassign to John (setEditVideoEditor)",
      mk: () => world(),
      writer: (w) => editing.setEditVideoEditor(w.P.id, "john"),
      refusal: NOT_YOURS,
      left: (s) => s.cardKey === "john", leftWords: "the card is John's",
      undone: closedAs("REASSIGNED"), undoneWords: "her Start is CLOSED as REASSIGNED",
      oldBad: onJohns("john"), oldBadWords: "Kim is ACTIVE on a job whose card is now John's (a ghost holding her one active slot)",
    });
    await runScenario({
      tag: "§2b", title: "Kim's Start vs the task card's assignee picker (setTaskAssignee)",
      mk: () => world(),
      writer: (w) => appActions.setTaskAssignee(w.P.cardId!, "john"),
      refusal: NOT_YOURS,
      left: (s) => s.cardKey === "john", leftWords: "the card is John's",
      undone: closedAs("REASSIGNED"), undoneWords: "her Start is CLOSED as REASSIGNED",
      oldBad: onJohns("john"), oldBadWords: "Kim is ACTIVE on a job whose card is now John's",
    });
    await runScenario({
      tag: "§2c", title: "Kim's Start vs the dispatch to the outside agency (setEditVideoEditor external_agency)",
      mk: () => world(),
      writer: (w) => editing.setEditVideoEditor(w.P.id, "external_agency"),
      refusal: NOT_YOURS,
      left: (s) => s.cardKey === "external_agency", leftWords: "the card is the agency's",
      undone: closedAs("REASSIGNED"), undoneWords: "her Start is CLOSED as REASSIGNED",
      oldBad: onJohns("external_agency"), oldBadWords: "Kim is ACTIVE on a job the agency now has",
      oldOrders: ["W"],
    });

    // ======================================================================
    // §3 · THE OFFICE'S HOLDS
    // ======================================================================
    await runScenario({
      tag: "§3a", title: "Kim's Start vs the queue's put-back to Waiting (setQueueStatus)",
      mk: () => world(),
      writer: (w) => editing.setQueueStatus(w.P.id, "Waiting"),
      refusal: /is held in Waiting by the office — it can't be started until the footage is in\.$/,
      left: (s) => s.status === "SCHEDULED" && s.hold, leftWords: "the job stays SCHEDULED with the office's hold on it",
      undone: closedAs("PUT_BACK"), undoneWords: "her Start is CLOSED as PUT_BACK",
      oldBad: (s) => revived(s) && s.hold, oldBadWords: "the hold is walked over — EDITING with the hold marker still set, Kim ACTIVE",
    });
    await runScenario({
      tag: "§3b", title: "Kim's Start vs the board's On hold (default: refuse Start, pause the active editor)",
      mk: () => world(),
      writer: (w) => appActions.moveProjectStatus(w.P.id, "ON_HOLD"),
      refusal: /is on hold — it can't be started until the office takes it off hold\.$/,
      left: (s) => s.status === "ON_HOLD", leftWords: "the job stays ON_HOLD",
      undone: (s) => s.kp?.state === "PAUSED", undoneWords: "her Start is PAUSED by the hold (hers to Resume later)",
      oldBad: revived, oldBadWords: "On hold is overwritten — EDITING, Kim ACTIVE",
    });

    // ======================================================================
    if (on("4")) {
      c.head("§4 · the project page's pick: mintEditTask parked between its count and its card update");
      // The pick itself (what assignMember writes), then the hourly refresh
      // that moves the card. Kim's Start lands while the refresh is between
      // "did the card's editor start?" (no) and the card update.
      const pinnedWorld = async () => {
        const w = await world({ cardManual: false });
        await prisma.project.update({ where: { id: w.P.id }, data: { editorId: johnTm.id, editorManual: true } });
        return w;
      };
      const viaMint = async (t: typeof tasks, i: number, label: string) => {
        const w = await pinnedWorld();
        // mintEditTask's startedByHolder count — the only editorWorkItem.count
        // on that path: held AFTER it answers, BEFORE the card update.
        const gate = park("editorWorkItem", "count", "after", (a) => whereOf(a).projectId === w.P.id);
        const mint = t.mintEditTask(w.P.id);
        await gate.inside;
        const r = await startIn({ version: "new", fn: "start", as: "kim", projectId: w.P.id, requestId: `§4-${label}-${i}-${w.n}` });
        gate.release();
        await mint;
        return { s: await state(w), r };
      };
      const old = await viaMint(oldTasks, 0, "old");
      c.ok(`OLD (tasks.ts @ ${BASE}, the close gated on the count read before the Start): the card moved to John and Kim stayed ACTIVE on it`,
        old.r.ok && old.s.cardKey === "john" && old.s.kp?.state === "ACTIVE", show(old.s, old.r));
      const fails: string[] = [];
      let ex = "";
      for (let i = 0; i < FORCED; i++) {
        const { s, r } = await viaMint(tasks, i, "new");
        ex ||= show(s, r);
        if (!(r.ok && s.cardKey === "john" && s.kp?.state === "CLOSED" && s.kp.reason === "REASSIGNED" && s.kimActive === 0 && !s.ghosts && !s.unpaired)) fails.push(show(s, r));
      }
      c.ok(`NEW: the card moves to John and her Start (eligible when it committed) is CLOSED as REASSIGNED right behind it — ${FORCED - fails.length}/${FORCED}`, fails.length === 0, fails[0] ?? ex);
    }

    // ======================================================================
    if (on("4")) {
      c.head("§4b · the RULES' route (no office pin): a Start landing inside the hourly refresh keeps its editor");
      // The review (Sep 28): mintEditTask counted "did the card's editor start?"
      // BEFORE its update, so on an UNPINNED card — only the routing rules
      // moving it — a Start that committed in between was written over (the
      // card to John) and then closed as REASSIGNED: the hourly rules beating
      // an editor who had just pressed Start. Same park as §4, no pin.
      const rulesWorld = () => world({ cardManual: false }); // the project is not pinned: the rules route the reel to John
      const viaRules = async (t: typeof tasks, i: number, label: string) => {
        const w = await rulesWorld();
        const gate = park("editorWorkItem", "count", "after", (a) => whereOf(a).projectId === w.P.id);
        const mint = t.mintEditTask(w.P.id);
        await gate.inside;
        const r = await startIn({ version: "new", fn: "start", as: "kim", projectId: w.P.id, requestId: `§4b-${label}-${i}-${w.n}` });
        gate.release();
        await mint;
        return { s: await state(w), r };
      };
      const old = await viaRules(prevTasks, 0, "old");
      c.ok(`OLD (tasks.ts @ ${PREV}): the rules moved the card to John over her fresh Start and closed it as REASSIGNED`,
        old.r.ok && old.s.cardKey === "john" && old.s.kp?.state === "CLOSED" && old.s.kp.reason === "REASSIGNED", show(old.s, old.r));
      const fails: string[] = [];
      let ex = "";
      for (let i = 0; i < FORCED; i++) {
        const { s, r } = await viaRules(tasks, i, "new");
        ex ||= show(s, r);
        if (!(r.ok && s.cardKey === "kim" && s.kp?.state === "ACTIVE" && s.kimActive === 1 && !s.ghosts && !s.unpaired)) fails.push(show(s, r));
      }
      c.ok(`NEW: the route is asked again under the job's lock — the card stays Kim's and her Start stands — ${FORCED - fails.length}/${FORCED}`, fails.length === 0, fails[0] ?? ex);
      // And the other order: the refresh routes first (nobody had started),
      // so her Start, arriving after, finds the card John's and is refused
      // without touching her real job.
      const failW: string[] = [];
      let exW = "";
      for (let i = 0; i < Math.min(FORCED, 5); i++) {
        const w = await rulesWorld();
        const run = await forced("W", { version: "new", fn: "start", as: "kim", projectId: w.P.id, requestId: `§4bW-${i}-${w.n}` }, () => tasks.mintEditTask(w.P.id));
        const st = await state(w);
        exW ||= show(st, run.r);
        if (!(run.parked && !run.r.ok && NOT_YOURS_4B.test(run.r.message) && st.cardKey === "john" && quietStart(st))) failW.push(show(st, run.r));
      }
      c.ok(`NEW, the refresh first: the rules' route stands (John), her later Start is refused and nothing of hers moves — ${Math.min(FORCED, 5) - failW.length}/${Math.min(FORCED, 5)}`, failW.length === 0, failW[0] ?? exW);
    }

    // ======================================================================
    if (on("5")) {
      c.head("§5 · delivery: a Start landing inside closeObsoleteTasks(DELIVERED)");
      // Two points inside closeObsoleteTasks(DELIVERED):
      //   "cards" — its read of the job's QC cards, just BEFORE the edit card
      //     is completed (both versions);
      //   "settle" — settleReopenedClocks's read of the job. OLD: right AFTER
      //     the work close and BEFORE the card close. NEW: the last thing,
      //     after the card close AND the work close.
      const deliver = async (t: typeof tasks, slot: "cards" | "settle", label: string, i: number) => {
        const w = await world();
        const gate = slot === "cards"
          ? park("smartTask", "findMany", "before", (a) => whereOf(a).projectId === w.P.id && whereOf(a).taskType === "media_qa")
          : park("project", "findUnique", "before", (a) => whereOf(a).id === w.P.id && !!(a as { select?: { revisionRequestedAt?: boolean; deliveredAt?: boolean } }).select?.revisionRequestedAt);
        await prisma.project.update({ where: { id: w.P.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
        const closing = t.closeObsoleteTasks(w.P.id, "DELIVERED");
        await gate.inside;
        const r = await startIn({ version: "new", fn: "start", as: "kim", projectId: w.P.id, requestId: `§5-${label}-${i}-${w.n}` });
        gate.release();
        await closing;
        return { s: await state(w), r };
      };
      const old = await deliver(oldTasks, "settle", "old", 0);
      c.ok(`OLD (tasks.ts @ ${BASE}, work closed BEFORE the cards): a Start between the two leaves Kim ACTIVE on a DELIVERED job with no card — nothing ever closes it`,
        old.r.ok && old.s.status === "DELIVERED" && old.s.kp?.state === "ACTIVE" && old.s.cardStatus === "COMPLETED", show(old.s, old.r));
      const failA: string[] = [];
      const failB: string[] = [];
      let exA = "", exB = "";
      for (let i = 0; i < FORCED; i++) {
        const a = await deliver(tasks, "cards", "new-a", i);
        exA ||= show(a.s, a.r);
        if (!(a.r.ok && a.s.kp?.state === "CLOSED" && a.s.kp.reason === "PROJECT_DELIVERED" && a.s.kimActive === 0 && a.s.cardStatus === "COMPLETED")) failA.push(show(a.s, a.r));
        const b = await deliver(tasks, "settle", "new-b", i);
        exB ||= show(b.s, b.r);
        if (!(!b.r.ok && NOT_YOURS.test(b.r.message) && b.s.kp?.state !== "ACTIVE" && quietStart(b.s))) failB.push(show(b.s, b.r));
      }
      c.ok(`NEW (a): a Start before the edit card completes is CLOSED as PROJECT_DELIVERED — the work close now runs last — ${FORCED - failA.length}/${FORCED}`, failA.length === 0, failA[0] ?? exA);
      c.ok(`NEW (b): a Start after the card completed finds nothing of hers — refused, her real job untouched, no bell — ${FORCED - failB.length}/${FORCED}`, failB.length === 0, failB[0] ?? exB);
    }

    // ======================================================================
    if (on("6")) {
      c.head(`§6 · unforced: the two processes let go together with 0–30 ms lags, ${RACES} times`);
      const writers: { name: string; run: (w: World) => Promise<unknown>; takenAway: (s: State) => boolean }[] = [
        { name: "board cancel", run: (w) => appActions.moveProjectStatus(w.P.id, "CANCELLED"), takenAway: cancelled },
        { name: "reassign", run: (w) => editing.setEditVideoEditor(w.P.id, "john"), takenAway: (s) => s.cardKey === "john" },
        { name: "card assignee", run: (w) => appActions.setTaskAssignee(w.P.cardId!, "john"), takenAway: (s) => s.cardKey === "john" },
        { name: "Aryeo cancel", run: async (w) => { await prisma.project.update({ where: { id: w.P.id }, data: { status: "CANCELLED" } }); await tasks.closeObsoleteTasks(w.P.id, "CANCELLED"); }, takenAway: cancelled },
      ];
      const bad: string[] = [];
      let won = 0, lost = 0;
      for (let i = 0; i < RACES; i++) {
        const wr = writers[i % writers.length];
        const w = await world();
        const k = ++runN;
        const kidLag = Math.floor(Math.random() * 30);
        const myLag = Math.floor(Math.random() * 30);
        kid.send({ version: "new", fn: "start", as: "kim", projectId: w.P.id, requestId: `§6-${i}-${w.n}`, armFirst: true, lagMs: kidLag, run: k } satisfies Cmd);
        await kid.waitFor((m) => (m as { armed?: number } | null)?.armed === k, 60_000);
        kid.send({ go: k });
        await sleep(myLag);
        let werr: string | null = null;
        await wr.run(w).catch((e: unknown) => { werr = e instanceof Error ? e.message : String(e); });
        const r = await kid.waitFor<Res>((m) => (m as Res | null)?.run === k && has("ok")(m), 120_000);
        const s = await state(w);
        allErrors.push(...r.errors);
        if (r.ok) won++; else lost++;
        const why: string[] = [];
        if (werr) why.push(`writer threw ${werr}`);
        if (!wr.takenAway(s)) why.push("the writer's state was not kept");
        if (s.kp?.state === "ACTIVE") why.push("Kim ACTIVE on a job taken from her");
        if (s.status === "EDITING" && wr.name.includes("cancel")) why.push("a cancelled job revived");
        if (s.ghosts || s.unpaired || s.kimActive > 1) why.push("an invariant broke");
        if (!r.ok && !quietStart(s)) why.push("a refused Start touched her real job");
        if (r.ok && s.p0.state !== "PAUSED") why.push("a Start that won did not pause her real job");
        if (r.errors.length) why.push("the switch logged an error");
        if (why.length) bad.push(`#${i + 1} ${wr.name} (lags ${kidLag}/${myLag}): ${why.join("; ")} — ${show(s, r)}`);
      }
      c.ok(`every race ends in the writer's state: no revived job, no ACTIVE work for a former holder, one ACTIVE per editor, every pause paired with its Start — ${RACES - bad.length}/${RACES} (Start first ${won}, writer first ${lost})`, bad.length === 0, bad[0] ?? "");
    }

    // ======================================================================
    // §7 · THE OFFICE'S START "FOR THE CARD'S EDITOR"
    // ======================================================================
    await runScenario({
      tag: "§7", title: "Jordan's Start for the card's editor (no editor named) vs a reassign to John",
      mk: () => world(),
      as: "jordan",
      writer: (w) => editing.setEditVideoEditor(w.P.id, "john"),
      refusal: /was just reassigned — refresh the page and try again\.$/,
      left: (s) => s.cardKey === "john", leftWords: "the card is John's",
      oldBad: onJohns("john"), oldBadWords: "the office started KIM on a job the card had just given to John",
      orders: ["W"],
    });

    // ======================================================================
    // §8 · confirmCurrentWork — the other writer of ACTIVE
    // ======================================================================
    {
      // A legacy claim: EDITING, Kim's card IN_PROGRESS, no work row. Every
      // other open card is closed first so the claim list is exactly P.
      const claimWorld = async () => {
        const w = await world({ status: "EDITING", cardStatus: "IN_PROGRESS" });
        await prisma.smartTask.updateMany({ where: { projectId: { notIn: [w.P.id, w.P0.id] }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "CANCELLED" } });
        return w;
      };
      await runScenario({
        tag: "§8a", title: "Kim's one-time confirm (\"that's the one I'm on\") vs the board's Cancelled",
        mk: claimWorld, fn: "confirm",
        writer: (w) => appActions.moveProjectStatus(w.P.id, "CANCELLED"),
        refusal: /^That job is cancelled — there is nothing to edit\.$/,
        left: cancelled, leftWords: "the job stays CANCELLED",
        undone: closedAs("PROJECT_CANCELLED"), undoneWords: "her confirm is CLOSED as PROJECT_CANCELLED",
        oldBad: (s) => cancelled(s) && s.kp?.state === "ACTIVE" && s.p0.state === "PAUSED", oldBadWords: "she is ACTIVE on the cancelled job and her real job was paused",
      });
      await runScenario({
        tag: "§8b", title: "Kim's one-time confirm vs a reassign to John (setTaskAssignee)",
        mk: claimWorld, fn: "confirm",
        writer: (w) => appActions.setTaskAssignee(w.P.cardId!, "john"),
        refusal: NOT_YOURS,
        left: (s) => s.cardKey === "john", leftWords: "the card is John's",
        oldBad: (s) => onJohns("john")(s) && s.p0.state === "PAUSED", oldBadWords: "she is ACTIVE on John's job and her real job was paused",
        orders: ["W"],
      });
    }

    // ======================================================================
    // §9 · TAKEN OFF THE EDITING ROOM (default: refused until brought back)
    // ======================================================================
    {
      // Held ONLY through a video revision: no edit card for the remove to
      // cancel, so the marker is the one thing that changes — the case the
      // remover's new row lock exists for.
      const revWorld = () => world({ card: false, revision: true });
      const TAKEN_OFF = /was taken off the Editing Room by the office — bring it back before starting it\.$/;
      await runScenario({
        tag: "§9", title: "Kim's Start vs Remove from the Editing Room (a job she holds through a revision)",
        mk: revWorld,
        writer: (w) => editing.removeFromEditorQueue(w.P.id, "drill"),
        refusal: TAKEN_OFF,
        left: () => true, leftWords: "the job is off the Editing Room",
        undone: closedAs("REMOVED"), undoneWords: "her Start is CLOSED as REMOVED",
        oldBad: (s) => s.kp?.state === "ACTIVE", oldBadWords: "Kim ACTIVE on a job the office took off the Editing Room",
        oldOrders: ["W"],
      });
    }
    if (on("9")) {
      const revWorld = () => world({ card: false, revision: true });
      c.head("§9 control · the same START FIRST with the remover's row lock bypassed (marker written, then close)");
      const w = await revWorld();
      const run = await forced("S", { version: "new", fn: "start", as: "kim", projectId: w.P.id, requestId: `§9c-${w.n}` }, async () => {
        const key = queueRemovedKey(w.P.id);
        const value = serialize({ by: "Jordan Spackman", at: new Date(), note: "bypassed", task: null, restoredAt: null, restoredBy: null });
        await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
        await work.closeActiveWork(w.P.id, { reason: "REMOVED", detail: "taken off the Editing Room (lock bypassed)" });
      });
      const s = await state(w);
      c.ok("without the lock the remover does not wait, its close reads before the Start commits, and Kim stays ACTIVE on the removed job — why the lock is there",
        !run.writerWaited && run.r.ok && s.kp?.state === "ACTIVE", show(s, run.r));
    }

    // ======================================================================
    // §10 · ASK THE HUB (START FIRST: the chat's write lands behind a Start)
    // ======================================================================
    if (on("10")) {
      const hub = { role: "OWNER", who: "Jordan Spackman" };
      const bypassAssign = (w: World) => prisma.smartTask.update({ where: { id: w.P.cardId! }, data: { assignedKey: "john", assignedManually: true } });
      const bypassComplete = (w: World) => prisma.smartTask.update({ where: { id: w.P.cardId! }, data: { status: "COMPLETED", completedAt: new Date() } });
      const cases: { name: string; tool: (w: World) => Promise<unknown>; old: (w: World) => Promise<unknown>; reason: string; left: (s: State) => boolean }[] = [
        { name: "assign_task (to John)", tool: (w) => execHubTool("assign_task", { task: `Edit — ${w.P.street}`, person: "john" }, hub), old: bypassAssign, reason: "REASSIGNED", left: (s) => s.cardKey === "john" },
        { name: "complete_task", tool: (w) => execHubTool("complete_task", { task: `Edit — ${w.P.street}` }, hub), old: bypassComplete, reason: "REMOVED", left: (s) => s.cardStatus === "COMPLETED" },
      ];
      for (const cs of cases) {
        c.head(`§10 START FIRST · Kim's Start vs Ask the Hub's ${cs.name}`);
        const wo = await world();
        const ro = await forced("S", { version: "new", fn: "start", as: "kim", projectId: wo.P.id, requestId: `§10-old-${wo.n}` }, () => cs.old(wo));
        const so = await state(wo);
        c.ok(`OLD (hubTools.ts @ ${BASE}: the write alone, no close after it): Kim stays ACTIVE on a job the chat took from her`, ro.r.ok && cs.left(so) && so.kp?.state === "ACTIVE", show(so, ro.r));
        const wn2 = await world();
        const rn = await forced("S", { version: "new", fn: "start", as: "kim", projectId: wn2.P.id, requestId: `§10-new-${wn2.n}` }, () => cs.tool(wn2));
        const sn = await state(wn2);
        c.ok(`NEW: the tool's write waits on the Start's lock, lands, and closes her Start as ${cs.reason}`,
          rn.writerWaited && rn.serverWaits >= 2 && rn.r.ok && cs.left(sn) && sn.kp?.state === "CLOSED" && sn.kp.reason === cs.reason && sn.kimActive === 0,
          `${show(sn, rn.r)} · server-logged waits ${rn.serverWaits}${rn.writerError ? ` · writer: ${rn.writerError}` : ""}`);
      }
    }

    // ======================================================================
    // §12 · TWO OPEN CARDS — the Start's ordered card lock vs a writer's
    // multi-row UPDATE (review fix, Sep 28 2026)
    // ======================================================================
    if (on("12")) {
      c.head("§12 · two open cards: the Start and a multi-card writer queue behind a third session");
      // The lock-conflict predicate first: a MODEL query that loses a deadlock
      // comes back as Prisma's unmapped ConnectorError — no P-code — which the
      // first R01 predicate did not recognise (so no writer could retry on it).
      {
        const { Prisma } = await import("@prisma/client");
        const connector = new Prisma.PrismaClientUnknownRequestError(
          'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR" }), transient: false })',
          { clientVersion: "6.19.0" },
        );
        const raw = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40P01`. Message: `deadlock detected`", { code: "P2010", clientVersion: "6.19.0", meta: { code: "40P01" } });
        const p2034 = new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock", { code: "P2034", clientVersion: "6.19.0" });
        const other = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.0" });
        c.ok("isLockConflict knows all three shapes of a lost deadlock (the unmapped ConnectorError, a raw P2010 with 40P01, P2034) and nothing else",
          work.isLockConflict(connector) && work.isLockConflict(raw) && work.isLockConflict(p2034) && !work.isLockConflict(other) && !work.isLockConflict(new Error("timeout")));
      }

      // The world: P with its cards created so that the heap order (the
      // writer's UPDATE order) is the REVERSE of the id order (the Start's
      // lock order). `heldId` is the card the Start locks first; a third
      // session holds it, so both line up behind it. Verified by ctid, and
      // rebuilt if the heap put them the other way round.
      type Card = { id: string; kind: "edit" | "video" | "photo"; key: string | null };
      const mkCards = async (w: World, specs: { id: string; kind: Card["kind"]; key: string | null }[]) => {
        for (const sp of specs) {
          await prisma.smartTask.create({
            data: sp.kind === "edit"
              ? { id: sp.id, taskType: "edit_video", title: `Edit — ${w.P.street}`, status: "OPEN", assignedKey: sp.key, assignedManually: true, projectId: w.P.id, clientId: client.id, dedupeKey: `edit-video-${w.P.id}` }
              : { id: sp.id, taskType: "revision", title: `${sp.kind === "video" ? "Video" : "Photo"} revision — ${w.P.street}`, status: "OPEN", assignedKey: sp.key, assignedManually: true, projectId: w.P.id, clientId: client.id, dedupeKey: `r01-2c-${sp.kind}-${w.P.id}` },
          });
        }
      };
      const heapOrder = async (ids: string[]) => (await drill.sql<{ id: string }>(`SELECT "id" FROM "SmartTask" WHERE "id" = ANY($1::text[]) ORDER BY ctid`, [ids])).map((r) => r.id);
      let cardSeq = 0;
      const twoCardWorld = async (layout: "edit+video" | "two asks"): Promise<{ w: World; held: string; cards: Card[] }> => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const w = await world({ card: false });
          const n = ++cardSeq;
          // ids: "aa…" sorts first (the Start's first lock), "zz…" last; the
          // creation order puts "zz…" first in the heap (the writer's first).
          const specs: Card[] = layout === "edit+video"
            ? [{ id: `zz-edit-${n}`, kind: "edit", key: "kim" }, { id: `aa-video-${n}`, kind: "video", key: "kim" }]
            : [{ id: `mm-edit-${n}`, kind: "edit", key: "john" }, { id: `zz-video-${n}`, kind: "video", key: "kim" }, { id: `aa-photo-${n}`, kind: "photo", key: "kyle" }];
          await mkCards(w, specs);
          const heap = await heapOrder(specs.map((x) => x.id));
          const zzFirst = heap.indexOf(specs.find((x) => x.id.startsWith("zz"))!.id) < heap.indexOf(specs.find((x) => x.id.startsWith("aa"))!.id);
          if (zzFirst) {
            w.P.cardId = specs.find((x) => x.kind === "edit")!.id;
            return { w, held: specs.find((x) => x.id.startsWith("aa"))!.id, cards: specs };
          }
          await prisma.smartTask.deleteMany({ where: { id: { in: specs.map((x) => x.id) } } });
        }
        throw new Error("the heap would not put the cards in the order this scenario needs");
      };
      const cardsOf = async (cards: Card[]) => new Map((await prisma.smartTask.findMany({ where: { id: { in: cards.map((x) => x.id) } }, select: { id: true, status: true, assignedKey: true } })).map((r) => [r.id, r]));

      // The third session: the harness's own connection, inside a transaction.
      const holdRow = async (id: string) => { await drill.sql("BEGIN"); await drill.sql(`SELECT "id" FROM "SmartTask" WHERE "id" = $1 FOR UPDATE`, [id]); };
      const letGo = () => drill.sql("COMMIT");
      // Row waits only (pg_locks, cluster-wide: this cluster is the drill's) —
      // never an advisory one, so a Start still parked on its desk is not
      // mistaken for one queued on a row.
      const rowsWaiting = async () => (await drill.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype <> 'advisory'`))[0].n;
      const waiting = (n: number) => until(async () => (await rowsWaiting()) >= n, 8000);
      type Q = "S" | "W" | "P";
      type HeldRun = { r: Res; writerError: unknown; lined: boolean; parentRetries: string[] };
      const behindHeld = async (
        order: Q, held: string, cmd: Omit<Cmd, "run">, writer: () => Promise<unknown>,
        parkIt?: () => { inside: Promise<void>; release: () => void },
        /** Run after the Start has done its unlocked pre-reads and before it
         *  takes any lock (its desk held here): Aryeo's status write lands
         *  THERE, or the Start's fast path would refuse the cancelled job
         *  without ever locking anything. */
        midStart?: () => Promise<unknown>,
      ): Promise<HeldRun> => {
        let writerError: unknown = null;
        const pw0 = parentWarns.length;
        const runWriter = () => writer().then(() => undefined, (e: unknown) => { writerError = e; });
        let res!: Promise<Res>;
        let wp!: Promise<void>;
        let a = false, b = false;
        await holdRow(held);
        const launchStart = async () => {
          if (!midStart) { res = startIn(cmd); return; }
          await holdDesk();
          res = startIn(cmd);
          await kimParked();
          await midStart();
        };
        const letStartOn = async () => { if (midStart) await freeDesk(); };
        try {
          if (order === "S") {
            // The Start first: it takes the job's row and queues on the held card.
            await launchStart(); await letStartOn(); a = await waiting(1);
            wp = runWriter(); b = await waiting(2);
          } else if (order === "W") {
            // The writer first: it is inside its update, queued on the held card.
            await launchStart();
            wp = runWriter(); a = await waiting(1);
            await letStartOn(); b = await waiting(2);
          } else {
            // The writer's own Project write has committed and it is parked
            // before its card update; the Start takes the job's row and
            // queues on the held card; then the writer's card update runs.
            const gate = parkIt!();
            wp = runWriter(); await gate.inside;
            res = startIn(cmd); a = await waiting(1);
            gate.release(); b = await waiting(2);
          }
          await sleep(150); // both waits outlast deadlock_timeout, so the server logs them
        } finally {
          await letGo();
        }
        const r = await res;
        await wp;
        return { r, writerError, lined: a && b, parentRetries: parentWarns.slice(pw0) };
      };
      const lost = (run: HeldRun) => {
        const e = run.writerError;
        const wLost = !!e && work.isLockConflict(e);
        const sLost = run.r.warnings.some((x) => x.includes("lock conflict"));
        return { any: wLost || sLost, wLost, sLost, words: `${wLost ? `the WRITER was thrown away (${e instanceof Error ? e.constructor.name : typeof e}${e instanceof Error && !("code" in e) ? ", no P-code" : ""})` : ""}${wLost && sLost ? " and " : ""}${sLost ? "the Start was thrown away and retried" : ""}` };
      };
      const deadlocksNow = async () => Number((await drill.sql<{ n: string }>("SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = 'drill'"))[0]?.n ?? 0);
      const dl0 = await deadlocksNow();
      const newRunsFailed: string[] = [];
      const scenario = async (o: {
        tag: string; title: string; layout: "edit+video" | "two asks";
        before?: (w: World) => Promise<unknown>;
        midStart?: (w: World) => Promise<unknown>;
        oldWriter: (w: World) => Promise<unknown>; newWriter: (w: World) => Promise<unknown>;
        oldOrder: Q; newOrders: Q[];
        park?: (w: World) => () => { inside: Promise<void>; release: () => void };
        verdict: (order: Q, run: HeldRun, w: World, cards: Map<string, { status: string; assignedKey: string | null }>, ids: Card[]) => Promise<string[]>;
        oldWords: string; newWords: Partial<Record<Q, string>>;
      }) => {
        c.head(`§12 ${o.tag} · ${o.title}`);
        const bad: string[] = [];
        let last = "";
        for (let i = 0; i < TWO_CARD_OLD; i++) {
          const { w, held, cards } = await twoCardWorld(o.layout);
          await o.before?.(w);
          const run = await behindHeld(o.oldOrder, held, { version: "new", fn: "start", as: "kim", projectId: w.P.id, requestId: `§12${o.tag}-old-${i}-${w.n}` }, () => o.oldWriter(w), o.park?.(w), o.midStart && (() => o.midStart!(w)));
          const L = lost(run);
          last = `${L.words || "no deadlock"} · Start: ${run.r.ok ? "ok" : "refused"} "${run.r.message}"${run.writerError ? ` · writer: ${String((run.writerError as Error).message ?? run.writerError).split("\n").slice(-1)[0].slice(0, 120)}` : ""}`;
          void cards;
          if (!(run.lined && L.any)) bad.push(last);
        }
        c.ok(`OLD (${PREV}): ${o.oldWords} — a deadlock in ${TWO_CARD_OLD - bad.length}/${TWO_CARD_OLD}`, bad.length === 0, bad[0] ?? last);
        for (const order of o.newOrders) {
          const fails: string[] = [];
          let ex = "";
          for (let i = 0; i < TWO_CARD_RUNS; i++) {
            const { w, held, cards } = await twoCardWorld(o.layout);
            await o.before?.(w);
            const run = await behindHeld(order, held, { version: "new", fn: "start", as: "kim", projectId: w.P.id, requestId: `§12${o.tag}-${order}-${i}-${w.n}` }, () => o.newWriter(w), o.park?.(w), o.midStart && (() => o.midStart!(w)));
            allErrors.push(...run.r.errors);
            const L = lost(run);
            const why: string[] = [];
            if (!run.lined) why.push("the two did not both queue (the ordering was not forced)");
            if (L.any) why.push(`a deadlock: ${L.words}`);
            if (run.writerError) why.push(`the writer threw: ${String((run.writerError as Error).message ?? run.writerError).slice(0, 120)}`);
            if (run.parentRetries.length) why.push(`the writer retried: ${run.parentRetries[0]}`);
            if (run.r.errors.length) why.push("the switch logged an error");
            const st = await state(w);
            if (st.ghosts || st.unpaired || st.kimActive > 1) why.push("an invariant broke");
            why.push(...(await o.verdict(order, run, w, await cardsOf(cards), cards)));
            const line = `${show(st, run.r)}${run.writerError ? ` · writer: ${String((run.writerError as Error).message).slice(0, 80)}` : ""}`;
            ex ||= line;
            if (why.length) fails.push(`#${i + 1}: ${why.join("; ")} — ${line}`);
          }
          newRunsFailed.push(...fails);
          c.ok(`NEW, ${order === "S" ? "the Start queued first" : order === "W" ? "the writer queued first" : "the writer's Project write committed, then the Start, then its card update"}: no deadlock, nobody retried — ${o.newWords[order]} — ${TWO_CARD_RUNS - fails.length}/${TWO_CARD_RUNS}`, fails.length === 0, fails[0] ?? ex);
        }
      };
      const idOf = (cards: Card[], kind: Card["kind"]) => cards.find((x) => x.kind === kind)!.id;

      await scenario({
        tag: "a", title: "the Editing Room's reassign to John (setEditVideoEditor) — an edit card and a video revision, both Kim's",
        layout: "edit+video",
        oldWriter: (w) => prevEditing.setEditVideoEditor(w.P.id, "john"),
        newWriter: (w) => editing.setEditVideoEditor(w.P.id, "john"),
        oldOrder: "S", newOrders: ["S", "W"],
        oldWords: "the Start's ordered lock and the reassign's single UPDATE each held the card the other needed",
        newWords: { S: "the reassign waits on the job's row, lands after the Start, both cards John's, her Start CLOSED(REASSIGNED)", W: "the reassign lands first, both cards John's, her Start refused and nothing of hers touched" },
        verdict: async (order, run, w, m, cards) => {
          const out: string[] = [];
          const st = await state(w);
          if (m.get(idOf(cards, "edit"))?.assignedKey !== "john" || m.get(idOf(cards, "video"))?.assignedKey !== "john") out.push("the cards are not both John's");
          if (order === "S" && !(run.r.ok && st.kp?.state === "CLOSED" && st.kp.reason === "REASSIGNED")) out.push("her Start did not land and then close as REASSIGNED");
          if (order === "W" && !(!run.r.ok && /isn't assigned to you/.test(run.r.message) && quietStart(st))) out.push("her Start was not refused quietly");
          return out;
        },
      });
      await scenario({
        tag: "b", title: "Aryeo's cancel — the status write, then closeObsoleteTasks(CANCELLED) over both cards",
        layout: "edit+video",
        // Between the Start's unlocked pre-reads and its locks — the moment
        // the order sync's status write can land in production.
        midStart: (w) => prisma.project.update({ where: { id: w.P.id }, data: { status: "CANCELLED", statusPinnedAt: null } }),
        oldWriter: (w) => prevTasks.closeObsoleteTasks(w.P.id, "CANCELLED"),
        newWriter: (w) => tasks.closeObsoleteTasks(w.P.id, "CANCELLED"),
        oldOrder: "S", newOrders: ["S", "W"],
        oldWords: "a refused Start still takes the card locks, and against the cancel's single UPDATE that deadlocked — when the cancel lost, a cancelled job kept its open cards",
        newWords: { S: "the cancel waits on the job's row, the Start is refused (cancelled), every card CANCELLED", W: "the cancel lands first, every card CANCELLED, the Start refused" },
        verdict: async (_order, run, w, m) => {
          const out: string[] = [];
          const st = await state(w);
          if ([...m.values()].some((x) => x.status !== "CANCELLED")) out.push("a card is still open on the cancelled job");
          if (!(!run.r.ok && /is cancelled/.test(run.r.message) && quietStart(st))) out.push("the Start was not refused quietly");
          return out;
        },
      });
      await scenario({
        tag: "c", title: "resolveRevision — two asks open (video: Kim, photo: Kyle), the edit card John's",
        layout: "two asks",
        before: (w) => prisma.project.update({ where: { id: w.P.id }, data: { status: "REVISION", revisionRequestedAt: new Date() } }),
        oldWriter: (w) => prevComms.resolveRevision(w.P.id),
        newWriter: (w) => comms.resolveRevision(w.P.id),
        // OLD: its stage write committed on its own; parked there, the Start
        // takes the job's row, then the asks' close runs. NEW: the stage
        // write and the close are one transaction behind the job's row, so
        // there is no "between" to park in — both queue orders instead.
        oldOrder: "P", newOrders: ["S", "W"],
        park: (w) => () => park("project", "update", "after", (a) => whereOf(a).id === w.P.id && "revisionRequestedAt" in (((a as { data?: object }).data) ?? {})),
        oldWords: "its stage write committed alone, then its close of both asks deadlocked against the Start that came between",
        newWords: { S: "the resolve waits on the job's row; the Start lands, then the job moves and both asks close together, her stretch closed", W: "the job moves and both asks close together first; her Start is refused" },
        verdict: async (order, run, w, m, cards) => {
          const out: string[] = [];
          const st = await state(w);
          const p = await prisma.project.findUniqueOrThrow({ where: { id: w.P.id }, select: { status: true, revisionRequestedAt: true } });
          if (m.get(idOf(cards, "video"))?.status !== "COMPLETED" || m.get(idOf(cards, "photo"))?.status !== "COMPLETED") out.push("an ask is still open");
          if (p.status === "REVISION" || p.revisionRequestedAt) out.push("the job did not move off Revisions");
          if (order === "S" && !(run.r.ok && st.kp?.state === "CLOSED")) out.push("her Start did not land and then close");
          if (order === "W" && !(!run.r.ok && quietStart(st))) out.push("her Start was not refused quietly");
          return out;
        },
      });
      await scenario({
        tag: "d", title: "the board's Delivered (moveProjectStatus) — two asks open, the edit card John's",
        layout: "two asks",
        before: (w) => prisma.project.update({ where: { id: w.P.id }, data: { status: "REVISION", revisionRequestedAt: new Date() } }),
        oldWriter: (w) => prevActions.moveProjectStatus(w.P.id, "DELIVERED"),
        newWriter: (w) => appActions.moveProjectStatus(w.P.id, "DELIVERED"),
        // The same orchestration both times: the board's status write is its
        // own commit in both versions; only the close of the asks changed.
        oldOrder: "P", newOrders: ["P"],
        park: (w) => () => park("project", "update", "after", (a) => whereOf(a).id === w.P.id && (((a as { data?: { status?: string } }).data) ?? {}).status === "DELIVERED"),
        oldWords: "the Start came between the Delivered write and the close of both asks, and the close deadlocked with it",
        newWords: { P: "the close waits on the job's row, lands after the Start, both asks COMPLETED, her stretch closed as delivered" },
        verdict: async (_order, run, w, m, cards) => {
          const out: string[] = [];
          const st = await state(w);
          if (m.get(idOf(cards, "video"))?.status !== "COMPLETED" || m.get(idOf(cards, "photo"))?.status !== "COMPLETED") out.push("an ask is still open on a Delivered job");
          if (st.status !== "DELIVERED") out.push("not Delivered");
          if (!(run.r.ok && st.kp?.state === "CLOSED" && st.kp.reason === "PROJECT_DELIVERED")) out.push("her Start did not land and then close as PROJECT_DELIVERED");
          return out;
        },
      });
      // The server's own count, as corroboration: a lost deadlock is counted
      // in pg_stat_database by the backend that lost it, flushed within ~10 s.
      let dl = dl0;
      for (const end = Date.now() + 12_000; Date.now() < end; await sleep(250)) {
        dl = await deadlocksNow();
        if (dl - dl0 >= TWO_CARD_OLD * 4) break;
      }
      c.ok(`the server itself counted the OLD deadlocks (pg_stat_database: ${dl - dl0} for ${TWO_CARD_OLD * 4} OLD runs) and none beyond them`,
        dl - dl0 === TWO_CARD_OLD * 4 && newRunsFailed.length === 0, `deadlocks ${dl0} → ${dl}`);

      // §12e · THE BACKSTOPS. Every writer above now takes the job's row
      // first, so none of them deadlocks with a Start any more — but not every
      // writer in the hub does (the hourly reconciler, the Review Room's
      // closes), so the one retry after a lost deadlock stays as the backstop:
      // on the one-time confirm (which had none) and on the writers
      // (underJobLock). Which side Postgres throws away in a real deadlock is
      // its choice, not the drill's (the review saw 6 Starts and 2 writers in
      // 8), so here a drill trigger raises the deadlock's own SQLSTATE
      // (40P01) exactly once, inside the transaction under test: the same
      // error, the same abort, deterministically on the side being tested.
      c.head("§12 e · the backstops: one retry when Postgres throws the transaction away (the deadlock's SQLSTATE, raised once by a drill trigger)");
      {
        await drill.sql(`CREATE SEQUENCE drill_fail_confirm`);
        await drill.sql(`CREATE SEQUENCE drill_fail_writer`);
        await drill.sql(`SELECT setval('drill_fail_confirm', 1000), setval('drill_fail_writer', 1000)`); // disarmed
        await drill.sql(`CREATE FUNCTION drill_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval(TG_ARGV[0]::regclass) = 1 THEN RAISE EXCEPTION 'drill: this transaction lost a deadlock' USING ERRCODE = '40P01'; END IF; RETURN NEW; END $$`);
        await drill.sql(`CREATE TRIGGER drill_fail_confirm_t AFTER INSERT ON "EditorWorkEvent" FOR EACH ROW WHEN (NEW."kind" = 'CONFIRM') EXECUTE FUNCTION drill_fail_once('drill_fail_confirm')`);
        await drill.sql(`CREATE TRIGGER drill_fail_writer_t BEFORE UPDATE ON "SmartTask" FOR EACH ROW WHEN (NEW."assignedKey" IS DISTINCT FROM OLD."assignedKey" OR NEW."status" IS DISTINCT FROM OLD."status") EXECUTE FUNCTION drill_fail_once('drill_fail_writer')`);
        // nextval is not transactional: armed, the NEXT matching row fails
        // and every one after it passes — the retry sees a clean database.
        const arm = (seq: "drill_fail_confirm" | "drill_fail_writer") => drill.sql(`SELECT setval('${seq}', 1, false)`);
        // Fired = the armed value was taken (is_called) and the sequence has
        // not been disarmed since — i.e. the injected failure really happened.
        const fired = async (seq: "drill_fail_confirm" | "drill_fail_writer") => {
          const [row] = await drill.sql<{ n: string; called: boolean }>(`SELECT last_value::text AS n, is_called AS called FROM ${seq}`);
          return row.called && Number(row.n) >= 1 && Number(row.n) < 1000;
        };

        // (i) the one-time confirm
        const claimWorld2 = async () => {
          const w = await world({ status: "EDITING" });
          await prisma.smartTask.updateMany({ where: { projectId: { notIn: [w.P.id, w.P0.id] }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "CANCELLED" } });
          return w;
        };
        const confirmOnce = async (version: "prev" | "new") => {
          const w = await claimWorld2();
          await arm("drill_fail_confirm");
          const r = await startIn({ version, fn: "confirm", as: "kim", projectId: w.P.id, requestId: `§12e-confirm-${version}-${w.n}` });
          const st = await state(w);
          return { r, st, fired: await fired("drill_fail_confirm"), confirms: await prisma.editorWorkEvent.count({ where: { projectId: w.P.id, kind: "CONFIRM" } }) };
        };
        const oc = await confirmOnce("prev");
        c.ok(`OLD (editorWork.ts @ ${PREV}): the confirm lost once and was simply lost — "Couldn't save that", an error logged, nothing marked`,
          oc.fired && !oc.r.ok && /^Couldn't save that — nothing changed\. Try again\.$/.test(oc.r.message) && oc.r.errors.length > 0 && oc.st.kp === null && oc.st.p0.same,
          `${oc.r.message} · errors ${oc.r.errors.join("|")}`);
        const nc = await confirmOnce("new");
        c.ok("NEW: the confirm is judged once more (a warning, no error) and lands: ACTIVE on the job she named, ONE confirm event, her previous job paused",
          nc.fired && nc.r.ok && nc.r.errors.length === 0 && nc.r.warnings.some((x) => x.includes("on a confirm")) && nc.st.kp?.state === "ACTIVE" && nc.confirms === 1 && nc.st.p0.state === "PAUSED" && nc.st.unpaired === 0,
          `${nc.r.message} · warnings ${nc.r.warnings.join("|")} · ${show(nc.st, nc.r)}`);

        // (ii) the reassign (underJobLock's retry)
        const reassignOnce = async (ed: typeof editing) => {
          const { w, cards } = await twoCardWorld("edit+video");
          const pw0 = parentWarns.length;
          await arm("drill_fail_writer");
          let threw: unknown = null;
          const res = await ed.setEditVideoEditor(w.P.id, "john").catch((e: unknown) => { threw = e; return null; });
          const m = await cardsOf(cards);
          return { res, threw, fired: await fired("drill_fail_writer"), keys: [...m.values()].map((x) => x.assignedKey), retries: parentWarns.slice(pw0) };
        };
        const or = await reassignOnce(prevEditing);
        c.ok(`OLD (${PREV}): the reassign lost once and failed outright — the cards stayed Kim's`,
          or.fired && !!or.threw && work.isLockConflict(or.threw) && or.keys.every((k) => k === "kim"), `threw=${!!or.threw} · cards ${or.keys.join(",")}`);
        const nr = await reassignOnce(editing);
        c.ok("NEW: the reassign runs once more under the job's row lock and lands — both cards John's, the retry said out loud",
          nr.fired && !nr.threw && nr.res?.ok === true && nr.keys.every((k) => k === "john") && nr.retries.some((x) => x.includes("the office's editor pick")),
          `${nr.res?.message} · cards ${nr.keys.join(",")} · ${nr.retries.join("|")}`);

        // (iii) resolveRevision: the stage write and the asks' close
        const resolveOnce = async (resolve: typeof comms.resolveRevision) => {
          const { w, cards } = await twoCardWorld("two asks");
          await prisma.project.update({ where: { id: w.P.id }, data: { status: "REVISION", revisionRequestedAt: new Date() } });
          const pw0 = parentWarns.length;
          await arm("drill_fail_writer");
          let threw: unknown = null;
          await resolve(w.P.id).catch((e: unknown) => { threw = e; });
          const m = await cardsOf(cards);
          const p = await prisma.project.findUniqueOrThrow({ where: { id: w.P.id }, select: { status: true, revisionRequestedAt: true } });
          const asksOpen = [idOf(cards, "video"), idOf(cards, "photo")].filter((id) => !["COMPLETED", "CANCELLED"].includes(m.get(id)?.status ?? "")).length;
          return { threw, fired: await fired("drill_fail_writer"), status: p.status as string, stamped: !!p.revisionRequestedAt, asksOpen, retries: parentWarns.slice(pw0) };
        };
        const ov = await resolveOnce(prevComms.resolveRevision);
        c.ok(`OLD (${PREV}): the stage write had already committed when the asks' close lost — the job is off Revisions with both asks still open`,
          ov.fired && !!ov.threw && ov.status !== "REVISION" && !ov.stamped && ov.asksOpen === 2, `threw=${!!ov.threw} · ${ov.status} · stamped=${ov.stamped} · asks open ${ov.asksOpen}`);
        const nv = await resolveOnce(comms.resolveRevision);
        c.ok("NEW: one transaction, run once more — the job moves AND both asks close, together",
          nv.fired && !nv.threw && nv.status !== "REVISION" && !nv.stamped && nv.asksOpen === 0 && nv.retries.some((x) => x.includes("the revision's resolve")),
          `${nv.status} · asks open ${nv.asksOpen} · ${nv.retries.join("|")}`);
        await drill.sql(`DROP TRIGGER drill_fail_confirm_t ON "EditorWorkEvent"`);
        await drill.sql(`DROP TRIGGER drill_fail_writer_t ON "SmartTask"`);
      }
    }

    // ======================================================================
    c.head("§11 · the whole drill");
    // ======================================================================
    kid.send({ exit: true });
    await sleep(100);
    c.ok("NEW: the switch never failed — no P2002, P2028, 40P01 or any other error logged by editorWork in the child", allErrors.length === 0, allErrors.slice(0, 3).join(" | ") || "none");
    c.ok("non-vacuous: two processes, several backends at once", backendsPeak >= 2, `peak ${backendsPeak}`);
    c.ok("non-vacuous: the server itself logged lock waits (Postgres's log_lock_waits, not the drill's clock)", drill.lockWaits() >= 1, `${drill.lockWaits()} logged`);
    c.ok("0 attempts to reach anything off this machine, in either process", fence!.blocked.length === 0, fence!.blocked.slice(0, 5).join(", ") || "none");
    c.ok("the database was this drill's own", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/drill?`));
    console.log(`\n    ${await drill.evidence()}`);
    console.log(`    (${quiet.count} expected prisma:error log lines suppressed in this process)`);
  } finally {
    quiet.restore();
    c.summary();
    await drill.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}

(ROLE ? childMain(ROLE) : main()).catch((e) => { console.error(e); process.exit(1); });
