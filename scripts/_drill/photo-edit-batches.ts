// ---------------------------------------------------------------------------
// DRILL: THE AUTOHDR BATCH REGISTER (§10 A53 / AU-21, unified handoff batch 5,
// Sep 26 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/photo-edit-batches.ts
//
//   0. OLD (17df024): the nightly count wrote the job's raw numbers and nothing
//      else — no register, so "20 of ~38 back" was invisible, and the category
//      chase closes the moment ANY final photo exists.
//   1. 150 raws incl. 10 DJI → ~38 expected. Inside AutoHDR's 2 days: with
//      AutoHDR. Day 3 with 20 finals: PARTIAL and exactly ONE chase, which the
//      category chase's "photos present" close does not touch. 38 finals:
//      COMPLETE and the chase closed.
//   1b. (review, Sep 26) Raws that leave 01 after the batch (moved, cleaned
//      up, a repointed folder) never write '0 came back, read just now'
//      over a COMPLETE 38: 04 is not read and the row does not move.
//   2. A Dropbox 429 on the raws → UNKNOWN, counts untouched, no chase; a 429
//      on the finals alone → UNKNOWN, finals untouched. A COMPLETE batch stays
//      COMPLETE on a failed look.
//   3. Re-run guard: refused while finals rose since the last look; two
//      concurrent presses → one attempt row; the short batch's chase answered.
//   4. Duplicate uploads: Finder "(1)" copies and a card dumped twice flag the
//      batch and do NOT inflate the expected count.
//   5. A vendor "complete" email naming exactly one batch's street is attached
//      as evidence; one naming two is not.
//   6. The exceptions board carries the short batch, owner Kyle.
//   7. Zero outbound calls.
//
// ISOLATION. PGlite on 127.0.0.1:5791 (DRILL_PORT overrides). Dropbox is an
// in-memory tree behind the module boundary. THE CLOCK is pinned and moved:
// Saturday Sep 19 2026 19:30 ET (the shoot evening) through Tue Sep 22.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5791);
const BASE = "17df024"; // the commit batch 5 starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");

const RealDate = Date;
let SIM = RealDate.parse("2026-09-19T19:30:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;
const at = (iso: string) => { SIM = RealDate.parse(iso); };

installNextStubs();
const fence = fenceFetch();

// ---- a scripted Dropbox -----------------------------------------------------
type Entry = { name: string; tag: string; path: string; id: string | null };
const FS = new Map<string, Entry[] | "429" | "missing">();
let lists = 0;
const listed: string[] = []; // every path the fake Dropbox was asked for, in order
const isMod = (r: string, tail: string) => r === `@/lib/${tail}` || r.endsWith(`/src/lib/${tail}`) || r.endsWith(`/src/lib/${tail}.ts`);
const wrapped = new WeakMap<object, unknown>();
interceptModule(
  (r) => isMod(r, "integrations/dropbox"),
  (loaded) => {
    const m = loaded as Record<string | symbol, unknown>;
    if (!wrapped.has(m)) {
      wrapped.set(m, new Proxy(m, {
        get(t, k) {
          if (k !== "dropboxListFolder") return t[k];
          const DErr = t.DropboxError as new (msg: string, status?: number) => Error;
          return async (p: string) => {
            lists++;
            listed.push(p);
            const v = FS.get(p);
            if (v === "429") throw new DErr("Dropbox files/list_folder 429: too_many_requests", 429);
            if (v === undefined || v === "missing") throw new DErr("path/not_found/..", 409);
            return v;
          };
        },
      }));
    }
    return wrapped.get(m);
  },
);
const files = (root: string, names: string[]): Entry[] => names.map((n) => ({ name: n.split("/").pop()!, tag: "file", path: `${root}/${n}`, id: null }));
const range = (prefix: string, from: number, to: number, ext = "JPG") =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(4, "0")}.${ext}`);

function writeBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-batch-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const photoCount = path.join(dir, "photoCount.base.ts");
  fs.writeFileSync(photoCount, point(show("src/lib/photoCount.ts")));
  return { photoCount };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Walk a server component's element tree to text, running nested server
 *  components; a client component (hooks) renders as nothing here. */
async function renderText(node: any): Promise<string> {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (await Promise.all(node.map(renderText))).join("");
  if (typeof node === "object" && typeof node.then === "function") return renderText(await node);
  if (typeof node === "object" && node.type) {
    if (typeof node.type === "function") {
      try { return await renderText(await node.type(node.props)); } catch { return ""; }
    }
    return renderText(node.props?.children);
  }
  return "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
/** lucide-react and next/link create React contexts at load, which the
 *  react-server build of React cannot do; for a text walk an icon is nothing
 *  and a link is its children. Installed just before a component is imported. */
function stubUiModules() {
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  const Icon = () => null;
  const lucide = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : Icon) });
  const link = { __esModule: true, default: ({ children }: { children?: unknown }) => children };
  L._load = function (r: string, p: unknown, m: boolean) {
    if (r === "lucide-react") return lucide;
    if (r === "next/link") return link;
    return prev.call(this, r, p, m);
  };
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { countProjectPhotos } = await import("@/lib/photoCount");
  const reg = await import("@/lib/photoEditBatches");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { closeVendorChasesForPresent } = await import("@/lib/tasks");
  const base = writeBase();
  const oldCount = (await import(base.photoCount)) as { countProjectPhotos: (id: string) => Promise<{ raw: number; drone: number } | null> };

  const client = await prisma.client.create({ data: { name: "Batch Client TEST" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-pb@drill.invalid", role: "ADMIN" } });
  const SHOT = new Date("2026-09-19T11:00:00-04:00"); // a Saturday shoot
  const job = async (street: string, status = "EDITING") => {
    const p = await prisma.project.create({
      data: { title: `${street}, Emmaus, PA`, clientId: client.id, status: status as never, shootDate: SHOT, deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] } },
      select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true },
    });
    const f = actualFolderPaths({ ...p, client: { name: "Batch Client TEST" } });
    return { id: p.id, raw: f.rawPhotos, fin: f.finalPhotos };
  };
  const batch = async (projectId: string) => prisma.photoEditBatch.findFirst({ where: { projectId }, orderBy: { attempt: "desc" } });
  const chases = (projectId: string) => prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: `photo-batch-partial-${projectId}-` } } });

  // 150 raws: 140 bracketed + 10 drone → 28 + 10 = 38 finished.
  const A = await job("12 Alder Ln");
  let birch = { id: "", raw: "", fin: "" };
  let dogwood = { id: "", raw: "", fin: "" };
  const aRaws = [...range("DSC_", 1, 140), ...range("DJI_", 1, 10)];

  // =========================================================================
  c.head("0 · OLD (17df024): counts only — no register");
  {
    FS.set(A.raw, files(A.raw, aRaws));
    const r = await oldCount.countProjectPhotos(A.id);
    const p = await prisma.project.findUnique({ where: { id: A.id }, select: { rawPhotoCount: true, dronePhotoCount: true } });
    c.ok("OLD counted the raws (150, 10 drone)", r?.raw === 150 && r?.drone === 10 && p?.rawPhotoCount === 150 && p?.dronePhotoCount === 10);
    c.ok("OLD wrote no batch row — nothing knew what was sent or what came back", (await prisma.photoEditBatch.count()) === 0);
    const oldSrc = execFileSync("git", ["show", `${BASE}:src/lib/photoCount.ts`], { cwd: REPO, encoding: "utf8" });
    c.ok("OLD never read 04-Final-Photos in the count", !/finalPhotos|04-Final/.test(oldSrc));
  }

  // =========================================================================
  c.head("1 · sent, short, complete — and exactly one chase");
  {
    at("2026-09-19T19:30:00-04:00"); // Saturday 7:30 PM, the evening of the shoot
    FS.set(A.fin, "missing");
    await countProjectPhotos(A.id);
    let b = await batch(A.id);
    c.ok("a batch row exists: attempt 1, 150 raws, ~38 expected, 0 back", b?.attempt === 1 && b.rawCount === 150 && b.droneCount === 10 && b.expectedFinals === 38 && b.finalsCount === 0, JSON.stringify({ a: b?.attempt, r: b?.rawCount, e: b?.expectedFinals, f: b?.finalsCount }));
    c.ok("inside AutoHDR's 2 days it is 'with AutoHDR', evidence = the upload", b?.state === "SUBMITTED_BY_UPLOAD" && b.submissionEvidence === "dropbox-upload" && b.readOk === true);
    c.ok("no chase while the vendor is on time", (await chases(A.id)).length === 0);

    at("2026-09-22T09:00:00-04:00"); // Tuesday — 2.5 days on
    FS.set(A.fin, files(A.fin, range("final_", 1, 20)));
    await countProjectPhotos(A.id);
    b = await batch(A.id);
    c.ok("day 3 with 20 of ~38 back → PARTIAL", b?.state === "PARTIAL" && b.finalsCount === 20, b?.state);
    let ch = await chases(A.id);
    c.ok("exactly one chase, to Kyle, naming 'received 20 of ~38'", ch.length === 1 && ch[0].assignedKey === "kyle" && /received 20 of ~38/.test(ch[0].title), ch[0]?.title);
    await countProjectPhotos(A.id);
    c.ok("a second pass files no second chase", (await chases(A.id)).length === 1);
    // The category chase's close runs every hour with "Photos" present — the
    // status engine counts ANY final as present. It must not answer this one.
    await closeVendorChasesForPresent(A.id, ["Photos"], ["Photos"]);
    ch = await chases(A.id);
    c.ok("the category chase's 'photos present' close leaves the short-batch chase open", ch[0].status === "OPEN", ch[0].status);

    FS.set(A.fin, files(A.fin, range("final_", 1, 38)));
    await countProjectPhotos(A.id);
    b = await batch(A.id);
    ch = await chases(A.id);
    c.ok("38 back → COMPLETE", b?.state === "COMPLETE" && b.finalsCount === 38);
    c.ok("…and the chase is closed as done", ch.length === 1 && ch[0].status === "COMPLETED");

    // A failed look does not un-finish a finished batch.
    FS.set(A.raw, "429");
    const r = await countProjectPhotos(A.id);
    b = await batch(A.id);
    c.ok("a 429 after COMPLETE: count null, batch stays COMPLETE, readOk false", r === null && b?.state === "COMPLETE" && b.readOk === false);
    FS.set(A.raw, files(A.raw, aRaws));
  }

  // =========================================================================
  c.head("1b · raws that LEAVE 01 after the batch never write a zero nobody read (review, Sep 26)");
  {
    at("2026-09-22T10:00:00-04:00");
    await countProjectPhotos(A.id); // a good read again after the 429
    const good = await batch(A.id);
    c.ok("setup: COMPLETE, 38 back, a real read", good?.state === "COMPLETE" && good.finalsCount === 38 && good.readOk === true, `${good?.state} ${good?.finalsCount}`);
    const stamp = good?.lastReadAt?.toISOString();
    // The raws were moved to the right job / cleaned up: 01 is gone.
    at("2026-09-23T09:00:00-04:00");
    FS.set(A.raw, "missing");
    listed.length = 0;
    await countProjectPhotos(A.id);
    let b = await batch(A.id);
    c.ok("01 not_found: 04 is not read on this pass", !listed.includes(A.fin), listed.join(", "));
    c.ok("…and the row is exactly as the last real read left it: COMPLETE, 38 back, 150 raws, ~38 expected, read yesterday", b?.state === "COMPLETE" && b.finalsCount === 38 && b.rawCount === 150 && b.expectedFinals === 38 && b.readOk === true && b.lastReadAt?.toISOString() === stamp, JSON.stringify({ s: b?.state, f: b?.finalsCount, r: b?.rawCount, e: b?.expectedFinals, at: b?.lastReadAt }));
    // Same again for a folder that is there but empty.
    FS.set(A.raw, []);
    await countProjectPhotos(A.id);
    b = await batch(A.id);
    c.ok("01 listed empty: still COMPLETE with 38, lastReadAt unmoved", b?.state === "COMPLETE" && b.finalsCount === 38 && b.lastReadAt?.toISOString() === stamp, `${b?.state} ${b?.finalsCount} ${b?.lastReadAt?.toISOString()}`);
    c.ok("…and no chase came of it", (await chases(A.id)).every((t) => t.status === "COMPLETED"));
    // The raws come back: folded in by the next pass as usual.
    FS.set(A.raw, files(A.raw, aRaws));
    await countProjectPhotos(A.id);
    b = await batch(A.id);
    c.ok("raws back: a real read again (COMPLETE, 38, read now)", b?.state === "COMPLETE" && b.finalsCount === 38 && b.lastReadAt?.toISOString() === new Date().toISOString());
  }

  // A short count on photos the office already shipped is history, not a chase.
  {
    at("2026-09-19T19:30:00-04:00");
    const S = await job("3 Spruce St");
    FS.set(S.raw, files(S.raw, range("DSC_", 1, 100))); // ~20 expected
    FS.set(S.fin, "missing");
    await countProjectPhotos(S.id);
    await prisma.project.update({ where: { id: S.id }, data: { statusEvidence: JSON.stringify({ expected: ["PHOTOS"], present: ["PHOTOS"], missing: [], aryeo: { photos: 12, videos: 0, floorPlans: 0, interactive: 0 } }) } });
    at("2026-09-22T09:00:00-04:00");
    FS.set(S.fin, files(S.fin, range("final_", 1, 12)));
    await countProjectPhotos(S.id);
    c.ok("photos already on the listing: the register says PARTIAL (12 of ~20) but files no chase", (await batch(S.id))?.state === "PARTIAL" && (await chases(S.id)).length === 0);
    const { batchesNeedingAttention } = reg;
    c.ok("…and it is not an exception row", !(await batchesNeedingAttention()).some((r) => r.projectId === S.id));
    FS.delete(S.raw);
  }

  // =========================================================================
  c.head("2 · unreadable is UNKNOWN, never a zero");
  {
    at("2026-09-19T19:30:00-04:00");
    const B = await job("40 Birch Rd");
    birch = B;
    FS.set(B.raw, files(B.raw, range("DSC_", 1, 100)));
    FS.set(B.fin, "missing");
    await countProjectPhotos(B.id);
    at("2026-09-22T09:00:00-04:00");
    FS.set(B.raw, "429");
    const r = await countProjectPhotos(B.id);
    const b = await batch(B.id);
    const p = await prisma.project.findUnique({ where: { id: B.id }, select: { rawPhotoCount: true } });
    c.ok("raw 429 → count null, job's raw count untouched (100)", r === null && p?.rawPhotoCount === 100);
    c.ok("…batch UNKNOWN, readOk false, raw/finals counts untouched", b?.state === "UNKNOWN" && b.readOk === false && b.rawCount === 100 && b.finalsCount === 0);
    c.ok("…and no chase for a batch nobody could read", (await chases(B.id)).length === 0);

    FS.set(B.raw, files(B.raw, range("DSC_", 1, 100)));
    FS.set(B.fin, files(B.fin, range("final_", 1, 5)));
    await countProjectPhotos(B.id); // a good look: 5 of 20 → PARTIAL
    FS.set(B.fin, "429");
    await countProjectPhotos(B.id);
    const b2 = await batch(B.id);
    c.ok("finals 429 alone → UNKNOWN, finals count stays at the last good 5", b2?.state === "UNKNOWN" && b2.finalsCount === 5 && b2.readOk === false, `${b2?.state} ${b2?.finalsCount}`);
    FS.set(B.fin, files(B.fin, range("final_", 1, 5)));
  }

  // =========================================================================
  c.head("3 · a re-run is recorded only against a fresh, proven shortfall");
  {
    at("2026-09-19T19:30:00-04:00");
    const C = await job("7 Cedar Ct");
    FS.set(C.raw, files(C.raw, range("DSC_", 1, 50))); // 10 expected
    FS.set(C.fin, "missing");
    await countProjectPhotos(C.id);
    c.ok("inside the window: 'still inside AutoHDR's window' refusal", !(await reg.recordResubmission(C.id, "kyle@drill.invalid", "vendor slow")).ok);
    at("2026-09-22T09:00:00-04:00");
    FS.set(C.fin, files(C.fin, range("final_", 1, 4)));
    await countProjectPhotos(C.id);
    c.ok("day 3, 4 of ~10 → PARTIAL", (await batch(C.id))?.state === "PARTIAL");
    c.ok("a reason is required", !(await reg.recordResubmission(C.id, "kyle@drill.invalid", " ")).ok);

    FS.set(C.fin, files(C.fin, range("final_", 1, 6)));
    const rising = await reg.recordResubmission(C.id, "kyle@drill.invalid", "AutoHDR support says it failed");
    c.ok("finals rose since the last look (4 → 6) → refused, still arriving", !rising.ok && /still arriving/.test(rising.message), rising.message);
    c.ok("…and no attempt 2", (await prisma.photoEditBatch.count({ where: { projectId: C.id } })) === 1);

    at("2026-09-22T09:05:00-04:00");
    const [x, y] = await Promise.all([
      reg.recordResubmission(C.id, "kyle@drill.invalid", "AutoHDR support says it failed"),
      reg.recordResubmission(C.id, "jordan@drill.invalid", "Re-running it myself"),
    ]);
    const rows = await prisma.photoEditBatch.findMany({ where: { projectId: C.id }, orderBy: { attempt: "asc" } });
    c.ok("two concurrent presses → exactly one recorded", [x, y].filter((r) => r.ok).length === 1, `${x.message} | ${y.message}`);
    c.ok("…one attempt-2 row carrying who, why and the manual evidence", rows.length === 2 && rows[1].attempt === 2 && !!rows[1].resubmittedBy && /^manual:/.test(rows[1].submissionEvidence ?? "") && rows[1].state === "SUBMITTED_BY_UPLOAD");
    c.ok("…attempt 1 is kept as history", rows[0].attempt === 1 && rows[0].state === "PARTIAL" && rows[0].finalsCount === 6);
    const ch = await chases(C.id);
    c.ok("…and the short batch's chase is answered by the re-run", ch.length === 1 && ch[0].status === "COMPLETED" && ch[0].sourceDetail === "Re-run recorded", ch.map((t) => `${t.dedupeKey}:${t.status}`).join(","));
    const again = await reg.recordResubmission(C.id, "kyle@drill.invalid", "once more");
    c.ok("a third press against the fresh attempt is refused (its clock restarted)", !again.ok, again.message);
  }

  // =========================================================================
  c.head("4 · duplicate uploads are flagged and never double the expected count");
  {
    at("2026-09-19T19:30:00-04:00");
    const D = await job("9 Dogwood Dr");
    dogwood = D;
    const clean = range("IMG_", 1, 50); // 50 bracketed → 10 expected
    const copies = range("IMG_", 1, 10).map((n) => n.replace(".JPG", " (1).JPG"));
    const card2 = range("IMG_", 11, 15).map((n) => `card2/${n}`);
    FS.set(D.raw, files(D.raw, [...clean, ...copies, ...card2]));
    FS.set(D.fin, "missing");
    await countProjectPhotos(D.id);
    const b = await batch(D.id);
    const p = await prisma.project.findUnique({ where: { id: D.id }, select: { rawPhotoCount: true } });
    c.ok("the job's raw count is unchanged in meaning (65 files)", p?.rawPhotoCount === 65);
    c.ok("the batch is flagged duplicateUploadSuspected", b?.duplicateUploadSuspected === true);
    c.ok("expected stays ~10, not ~13", b?.expectedFinals === 10, String(b?.expectedFinals));
    const pure = reg.readRaws(files("/r", ["a.jpg", "b.jpg"]), "/r");
    c.ok("a clean folder is not flagged", pure.duplicates === 0 && pure.raw === 2);
  }

  // =========================================================================
  c.head("5 · a vendor email is evidence only when it names ONE batch");
  {
    at("2026-09-22T10:00:00-04:00");
    const hit = await reg.attachVendorEmail({ gmailId: "g-1", text: "Your AutoHDR order for 9 Dogwood Dr is complete" });
    const D = await batch(dogwood.id);
    c.ok("names one street → attached as vendor-email evidence", !!hit && D?.submissionEvidence === "vendor-email:g-1", D?.submissionEvidence ?? "none");
    const two = await reg.attachVendorEmail({ gmailId: "g-2", text: "Done: 12 Alder Ln and 40 Birch Rd" });
    c.ok("names two streets → attached to neither", two === null);
    const C2 = await prisma.photoEditBatch.findFirst({ where: { attempt: 2 } });
    await reg.attachVendorEmail({ gmailId: "g-3", text: "7 Cedar Ct is complete" });
    c.ok("never overwrites a person's recorded re-run", /^manual:/.test((await prisma.photoEditBatch.findUnique({ where: { id: C2!.id } }))?.submissionEvidence ?? ""));
  }

  // =========================================================================
  c.head("6 · the exceptions board carries it, with a name on it");
  {
    at("2026-09-22T10:00:00-04:00");
    await countProjectPhotos(birch.id); // a good look again: 5 of ~20, short
    const { opsExceptionsBoard, EXCEPTION_LABEL } = await import("@/lib/opsExceptions");
    const board = await opsExceptionsBoard({ now: new Date() });
    const rows = board.rows.filter((r) => r.kind === "photo-batch");
    c.ok("photo-batch rows present, owner Kyle, labelled", rows.length >= 2 && rows.every((r) => r.owner === "Kyle") && !!EXCEPTION_LABEL["photo-batch"], rows.map((r) => `${r.title}:${r.why}`).join(" | "));
    c.ok("the short batch (Birch) is there; the COMPLETE one (Alder) is not", rows.some((r) => r.title === "40 Birch Rd") && !rows.some((r) => r.title === "12 Alder Ln"));
    c.ok("the doubled upload (Dogwood) is there", rows.some((r) => r.title === "9 Dogwood Dr" && /twice/.test(r.why)));
    c.ok("totals carry the whole pile", board.totals["photo-batch"].all === rows.length || board.totals["photo-batch"].all > rows.length);
  }

  // =========================================================================
  c.head("6b · the job page panel renders what was sent and what came back");
  {
    stubUiModules();
    const { PhotoBatchPanel } = await import("@/components/project/PhotoBatchPanel");
    const text = await renderText(await PhotoBatchPanel({ projectId: birch.id, canAct: true }));
    c.ok("panel shows the state, the counts and the tolerance", /Came back short/.test(text) && /~20/.test(text) && /90%/.test(text), text.slice(0, 160));
    const none = await PhotoBatchPanel({ projectId: "no-such-job", canAct: true });
    c.ok("a job with no batch shows no panel", none === null);
  }

  // =========================================================================
  c.head("7 · nothing left the building");
  c.ok("zero outbound calls (Dropbox faked at the module boundary)", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("the fake Dropbox was actually read", lists > 10, String(lists));

  quiet.restore();
  c.summary();
  await stop();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
