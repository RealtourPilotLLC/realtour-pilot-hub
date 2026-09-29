// ---------------------------------------------------------------------------
// DRILL: R02 (external review, Sep 28 2026) — A TOPIC LIST THAT COULD NOT BE
// READ NEVER EMPTIES THE PHOTOGRAPHER'S DRAFT.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/r02-draft-topics.ts
//
// (Named for the review's finding. scripts/_drill/r1-r2-script-decisions.ts is
// a DIFFERENT, older "R2" — the client's script decision.)
//
// THE DEFECT. The draft autosave checked the draft's topic ids against the
// job's topic list with `topicsForSession(...).catch(() => null)`: a read that
// FAILED looked exactly like a job with no list, so every tick and every topic
// note was filtered out, the stripped draft was stored as a new revision, and
// the page heard "saved" — and deleted the device copy that still held them.
// The review missed three siblings, all proved here:
//   · the upload page's render had the same catch-to-null; its portal then
//     dropped the stored ticks and its next autosave wrote [] over them even
//     with the database healthy again;
//   · the portal deletes its device copy on any "saved" (so the false one
//     destroyed the last copy);
//   · topicsForSession turned a failed script-decision read into "nobody
//     decided", and confirmFilmedTopics then recorded the filmed video with no
//     approved script version — and, being idempotent, never re-stamped it.
//
// What it proves, OLD (1075a5b, loaded for real) next to NEW:
//   0. the OLD sources carry each catch-to-empty (read as text);
//   1. a healthy save stores the ticks and the note;
//   2. OLD: a failed topic read + a save = ok:true, a new revision, ticks [] and
//      notes {}, and the page's rule deletes the device copy. NEW: not ok, not
//      a conflict, retryable, the photographer's words; the row is untouched
//      (revision, answers, savedAt, baseHash, consumedAt); nothing else is
//      written; the page's rule KEEPS the device copy;
//   3. the retry, once the list reads again, lands with every valid tick, the
//      note and the brief typed during the outage;
//   4. a healthy read still rejects a foreign month's topic and an invented id;
//      a listing shoot (no list, read successfully) still strips them;
//   5. a draft with no topic fields still saves during the outage;
//   6. conflict protection: a stale save during the outage is the retryable
//      error (nothing written), the same save after recovery is a conflict that
//      carries the server copy's ticks; two racing saves → one lands;
//   7. the autosaver: failed ×2 with the topic line, retries at 3 s then 8 s,
//      never "saved" before the save that lands — on a fake clock, and wired to
//      the real server action with the page's own device-copy rule;
//   8. the page render: the read says "unknown", not "none"; OLD dropped the
//      stored ticks and the next healthy autosave stored []; NEW keeps them;
//      the portal holds the video half and says why;
//  8b. the real /upload/<id> page (its element tree, OLD and NEW): under a
//      failed read the OLD page handed the portal a listing job's props; the
//      NEW one hands it topicsUnavailable and the stored ticks, untouched;
//   9. confirmFilmedTopics refuses instead of writing on a failed verdict read
//      (OLD recorded the video with no approved version, for good); the filming
//      report goes FAILED and, retried after recovery, stamps the version.
//
// THE REVIEW OF THE REPAIR (Sep 28 2026 evening) found three more; each is
// proved with the fix bypassed (or OLD) next to NEW:
//  11. an outage render with NO open draft (the whole submit consumed it; its
//      filming report did not land) seeded ticks/extras/notes it did not have,
//      and a brief edit saved them as the answer — the healthy reload then
//      showed nothing ticked while the report held two topics and an extra.
//      NEW: the page has no topic answer (topicsUnknown on the draft), the
//      reload shows the report's; the server never lets a no-answer save
//      replace a stored answer (it carries it, from the row it replaces);
//  12. the page's read of the pending report's own row still caught to null:
//      "ticked nothing, no extras", no flag, no banner. NEW: unknown, exactly
//      like a list that did not load (a vanished row too);
//  13. the device copy was re-stamped on every failed attempt, so a copy typed
//      before another device's save looked newer and was pushed over it on the
//      next reload. NEW: the copy records the revision it was typed on and when
//      it was typed; a reload restores silently only onto that revision, and
//      otherwise opens the conflict panel.
//
// ISOLATION. PGlite on 127.0.0.1:6240 (DRILL_PORT overrides) through the shared
// harness; production is never opened. Every non-loopback call is fenced.
// AUTH_ENFORCE is on so the real guards run against real sessions.
// The "outage" is one Prisma delegate method swapped for a throwing one and put
// back in `finally` (the a02-a04-delivery-truth pattern).
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6240);
const BASE = "1075a5b"; // HEAD before the R02 repair — never the working tree
const REPO = path.resolve(__dirname, "../..");

// ---- modules that cannot load under the react-server build of React -------
// Section 8b WALKS the upload page's element tree, never renders it (the
// final-remainders technique): the icons and the link are inert, and the
// portal is a named stand-in — its props are what the page hands it.
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  function Link(p: unknown) { return p; }
  function UploadPortal() { return null; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
    if (/components[\\/]upload[\\/]UploadPortal(\.tsx)?$/.test(request)) return { __esModule: true, UploadPortal };
    return realLoad.call(this, request, parent, isMain);
  };
}
installNextStubs();
const fence = fenceFetch();
const c = makeChecker();

const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * The OLD draftActions.ts and filmedTopics.ts, loaded for real: written to a
 * temp dir with their `@/` imports pointed at this tree, so they share this
 * drill's Prisma client and database (the cp09-filming-handoff technique).
 */
function writeBaseCopies(): { dir: string; draftActions: string; filmedTopics: string; page: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r02-draft-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const draftActions = path.join(dir, "draftActions.base.ts");
  fs.writeFileSync(draftActions, point(show("src/app/upload/draftActions.ts")));
  const filmedTopics = path.join(dir, "filmedTopics.base.ts");
  fs.writeFileSync(filmedTopics, point(show("src/lib/filmedTopics.ts")));
  // The OLD page too; its two sibling imports ("./AddedAtShoot", …) point at this tree's.
  const page = path.join(dir, "uploadPage.base.tsx");
  const pageDir = path.join(REPO, "src/app/upload/[id]");
  // Outside the repo tsx compiles JSX the classic way, so the copy needs React in scope.
  fs.writeFileSync(page, 'import * as React from "react";\n' + point(show("src/app/upload/[id]/page.tsx")).replace(/(["'])\.\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(pageDir, p)}${q}`));
  return { dir, draftActions, filmedTopics, page };
}
function removeBaseCopies(dir: string) {
  try {
    fs.unlinkSync(path.join(dir, "node_modules"));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* a leftover temp dir is harmless */ }
}

/** One Prisma delegate method throws, as a dropped connection does, until restored. */
function breakDelegate(delegate: unknown, method = "findMany"): () => void {
  const d = delegate as Record<string, unknown>;
  const real = d[method];
  d[method] = async () => { throw new Error("connection terminated unexpectedly"); };
  return () => { d[method] = real; };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const base = writeBaseCopies();
  try {
    await run(base);
  } finally {
    removeBaseCopies(base.dir);
    quiet.restore();
    fence.restore();
  }
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

async function run(base: { draftActions: string; filmedTopics: string; page: string }) {
  const { prisma } = await import("@/lib/prisma");
  const { saveUploadDraft } = await import("@/app/upload/draftActions");
  const { establishSession } = await import("@/lib/auth/session");
  const draftLib = await import("@/lib/uploadDraft");
  const ft = await import("@/lib/filmedTopics");
  type OldDraftActions = { saveUploadDraft: typeof saveUploadDraft };
  const oldDA = (await import(base.draftActions)) as OldDraftActions;
  type OldFT = {
    confirmFilmedTopics: (projectId: string, ids: string[], by: string) => Promise<{ confirmed: number; alreadyConfirmed: number }>;
  };
  const oldFT = (await import(base.filmedTopics)) as OldFT;
  const { DRAFT_TOPIC_CHECK_FAILED, restoredTopicTicks, settleDraftSave } = draftLib;

  // =======================================================================
  c.head("0 · OLD (1075a5b): every path turned 'could not read' into 'empty'");
  const oldDraftSrc = show("src/app/upload/draftActions.ts");
  const oldPageSrc = show("src/app/upload/[id]/page.tsx");
  const oldPortalSrc = show("src/components/upload/UploadPortal.tsx");
  const oldFtSrc = show("src/lib/filmedTopics.ts");
  c.ok("the autosave's topic check caught a failed read to null", oldDraftSrc.includes("topicsForSession(projectId).catch(() => null)"));
  c.ok("the page render caught it to null too", oldPageSrc.includes("topicsForSession(project.id).catch(() => null)"));
  c.ok("the portal filtered restored ticks against that (then empty) list",
    oldPortalSrc.includes("const ticksFrom = (ids: string[]) => (sessionTopics?.topics ?? [])"));
  c.ok("the portal deleted its device copy on any 'saved'", /if \(r\.ok\) \{\s*revRef\.current = r\.revision;\s*lastSavedJson\.current = json;\s*clearMirror\(\);/.test(oldPortalSrc));
  c.ok("topicsForSession caught a failed verdict read to an empty Map, and confirmFilmedTopics used it",
    oldFtSrc.includes(".catch(() => new Map())") && /confirmFilmedTopics[\s\S]{0,400}const session = await topicsForSession\(projectId\);/.test(oldFtSrc));

  // ---- the world ---------------------------------------------------------
  const harrisonTm = await prisma.teamMember.create({
    data: { name: "Harrison Drill", email: "harrison-r02@drill.invalid", role: "PHOTOGRAPHER" },
    select: { id: true },
  });
  const harrison = await prisma.appUser.create({ data: { email: "harrison-r02@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE" }, select: { id: true } });
  await establishSession(harrison.id);
  const month = async (name: string): Promise<ContentMonthFixture & { projectId: string }> => {
    const f = await buildContentMonth(prisma as never, {
      name: `${name} TEST`,
      package: "Starter",
      videosPerMonth: 3,
      owner: false,
      topics: [
        { title: `${name}: pricing in week one`, selection: "SELECTED" },
        { title: `${name}: the inspection talk`, selection: "SELECTED" },
        { title: `${name}: staging on a budget`, selection: "SELECTED" },
      ],
    });
    // The fixture's project has no photographer; Harrison owns every job here.
    await prisma.project.update({ where: { id: f.projectId! }, data: { photographerId: harrisonTm.id } });
    return { ...f, projectId: f.projectId! };
  };
  const T = await month("Draft Topics");
  const U = await month("Foreign Month");
  const V = await month("Old Draft Topics");
  const listingClient = await prisma.client.create({ data: { name: "Listing Client TEST" }, select: { id: true } });
  const listing = await prisma.project.create({
    data: { title: "12 Listing Ln, Emmaus, PA", clientId: listingClient.id, status: "SCHEDULED", photographerId: harrisonTm.id, deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] } },
    select: { id: true },
  });
  const [t0, t1] = T.topicIds;

  const P = (over: Record<string, unknown> = {}) => ({
    editorBrief: "Backlit kitchen — recover the window",
    checks: { coverage: true, culling: true, quality: true, count: false },
    removal: "",
    nothingToRemove: true,
    orderChoice: "front-to-back",
    orderNotes: "",
    vidStyle: null,
    vidSections: { vision: "Warm, slow, personal" },
    videosFilmed: "",
    filmedTopicIds: [] as string[],
    topicNotes: {} as Record<string, string>,
    extraRows: [],
    scriptChoice: null,
    scriptText: "",
    scriptNote: "",
    ...over,
  });
  const NOTE = "Agent flubbed line 2 — use take 3";
  const Q = (f: { topicIds: string[] }, over: Record<string, unknown> = {}) =>
    P({ filmedTopicIds: [f.topicIds[0], f.topicIds[1]], topicNotes: { [f.topicIds[0]]: NOTE }, ...over });
  const stored = async (projectId: string) => {
    const row = await prisma.uploadDraft.findFirstOrThrow({ where: { projectId } });
    return { row, payload: JSON.parse(row.payloadJson) as { editorBrief: string; filmedTopicIds: string[]; topicNotes: Record<string, string> } };
  };
  const snapshot = async (projectId: string) => {
    const r = await prisma.uploadDraft.findFirstOrThrow({ where: { projectId } });
    return JSON.stringify({ revision: r.revision, payloadJson: r.payloadJson, savedAt: r.savedAt.toISOString(), baseHash: r.baseHash, consumedAt: r.consumedAt?.toISOString() ?? null });
  };
  const counts = async (projectId: string) => JSON.stringify({
    activity: await prisma.activity.count({ where: { projectId } }),
    notification: await prisma.notification.count(),
    task: await prisma.smartTask.count({ where: { projectId } }),
    filming: await prisma.contentFilmingReport.count({ where: { projectId } }),
  });
  const withTopicsBroken = async <R>(fn: () => Promise<R>): Promise<R> => {
    const restore = breakDelegate(prisma.contentTopicSelection);
    try { return await fn(); } finally { restore(); }
  };
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const fakeDevice = () => {
    const store = new Map<string, string>();
    return { store, for: (json: string) => ({ keep: () => { store.set("draft", json); }, clear: () => { store.delete("draft"); } }) };
  };

  // Sanity: the outage really is an outage.
  const probe = await withTopicsBroken(() => prisma.contentTopicSelection.findMany({ take: 1 }).then(() => "read", (e: Error) => e.message));
  c.ok("(the swapped delegate really throws, and is put back)", probe === "connection terminated unexpectedly" && (await prisma.contentTopicSelection.count()) > 0, probe);

  // =======================================================================
  c.head("1 · a healthy save stores the ticks and the note");
  const r1 = await saveUploadDraft(T.projectId, { revision: null, baseHash: "h0", payload: Q(T) });
  c.ok("the first save lands as revision 1", r1.ok && r1.revision === 1, JSON.stringify(r1).slice(0, 140));
  const s1 = await stored(T.projectId);
  c.ok("stored ticks are [t0, t1] with the note on t0", same(s1.payload.filmedTopicIds, [t0, t1]) && s1.payload.topicNotes[t0] === NOTE, JSON.stringify(s1.payload.filmedTopicIds));

  // =======================================================================
  c.head("2 · the topic list can't be read: OLD strips and says 'saved', NEW writes nothing and says why");
  // OLD, on its own fixture.
  const v1 = await oldDA.saveUploadDraft(V.projectId, { revision: null, baseHash: "h0", payload: Q(V) });
  c.ok("(OLD baseline: a healthy save stores V's two ticks)", v1.ok && same((await stored(V.projectId)).payload.filmedTopicIds, [V.topicIds[0], V.topicIds[1]]));
  const oldBroken = await withTopicsBroken(() => oldDA.saveUploadDraft(V.projectId, { revision: 1, baseHash: "h0", payload: Q(V, { editorBrief: "typed during the outage" }) }));
  const vs = await stored(V.projectId);
  c.ok("OLD: the save during the outage answered ok:true with a new revision", oldBroken.ok === true && oldBroken.revision === 2, JSON.stringify(oldBroken).slice(0, 140));
  c.ok("OLD: …and stored filmedTopicIds [] and topicNotes {} — the defect", vs.payload.filmedTopicIds.length === 0 && Object.keys(vs.payload.topicNotes).length === 0, vs.row.payloadJson.slice(0, 160));
  const oldDev = fakeDevice();
  oldDev.store.set("draft", JSON.stringify(Q(V)));
  settleDraftSave(oldBroken, oldDev.for(JSON.stringify(Q(V))));
  c.ok("OLD: the page's rule on that 'saved' deleted the device copy — the last copy of the ticks", !oldDev.store.has("draft"));

  // NEW, on T.
  const before = await snapshot(T.projectId);
  const countsBefore = await counts(T.projectId);
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  let newBroken: Awaited<ReturnType<typeof saveUploadDraft>>;
  try {
    newBroken = await withTopicsBroken(() => saveUploadDraft(T.projectId, { revision: 1, baseHash: "h0", payload: Q(T, { editorBrief: "typed during the outage" }) }));
  } finally {
    console.warn = realWarn;
  }
  c.ok("NEW: not ok, and not a conflict", !newBroken.ok && !("conflict" in newBroken), JSON.stringify(newBroken).slice(0, 160));
  c.ok("NEW: retryable, in the photographer's words", !newBroken.ok && "message" in newBroken && newBroken.retryable === true && newBroken.message === DRAFT_TOPIC_CHECK_FAILED,
    !newBroken.ok && "message" in newBroken ? newBroken.message : "");
  c.ok("NEW: the words are plain (no 'lookup', no error text)", DRAFT_TOPIC_CHECK_FAILED === "Couldn't save your topic ticks just now — they're kept on this device. Trying again…");
  c.ok("NEW: the row is byte-identical — revision, answers, savedAt, baseHash, consumedAt", (await snapshot(T.projectId)) === before);
  c.ok("NEW: no Activity, Notification, SmartTask or filming report was written", (await counts(T.projectId)) === countsBefore);
  c.ok("NEW: the server log says why the draft was not written", warned.some((w) => w.includes(`[upload-draft] topic list unreadable for ${T.projectId}`) && w.includes("connection terminated")), warned.join(" | ").slice(0, 200));
  const newDev = fakeDevice();
  newDev.store.set("draft", JSON.stringify(Q(T)));
  const settled = settleDraftSave(newBroken, newDev.for(JSON.stringify(Q(T, { editorBrief: "typed during the outage" }))));
  c.ok("NEW: the page's rule KEEPS the device copy (the newest answers, ticks included)", newDev.store.has("draft") && JSON.parse(newDev.store.get("draft")!).editorBrief === "typed during the outage" && same(JSON.parse(newDev.store.get("draft")!).filmedTopicIds, [t0, t1]));
  c.ok("NEW: …the autosaver hears a failure (retry), never 'saved', and the revision does not move",
    !settled.outcome.ok && !("conflict" in settled.outcome && settled.outcome.conflict) && settled.revision === null && "message" in settled.outcome && settled.outcome.message === DRAFT_TOPIC_CHECK_FAILED);

  // =======================================================================
  c.head("3 · the retry after recovery keeps every valid selection");
  const retry = await saveUploadDraft(T.projectId, { revision: 1, baseHash: "h0", payload: Q(T, { editorBrief: "typed during the outage" }) });
  const s3 = await stored(T.projectId);
  c.ok("the identical call (still revision 1) lands as revision 2", retry.ok && retry.revision === 2, JSON.stringify(retry).slice(0, 120));
  c.ok("stored ticks are still [t0, t1], the note on t0 is there", same(s3.payload.filmedTopicIds, [t0, t1]) && s3.payload.topicNotes[t0] === NOTE);
  c.ok("…and the brief typed during the outage is saved", s3.payload.editorBrief === "typed during the outage");
  const retryDev = fakeDevice();
  retryDev.store.set("draft", "x");
  settleDraftSave(retry, retryDev.for("x"));
  c.ok("…and only now does the page's rule clear the device copy", !retryDev.store.has("draft"));

  // =======================================================================
  c.head("4 · a healthy read still decides membership");
  const foreign = U.topicIds[0];
  const mixed = await saveUploadDraft(T.projectId, {
    revision: 2, baseHash: "h0",
    payload: P({ filmedTopicIds: [t0, foreign, "cltopicfake0000001"], topicNotes: { [t0]: NOTE, [foreign]: "not this job's topic" } }),
  });
  const s4 = await stored(T.projectId);
  c.ok("the save lands (revision 3)", mixed.ok && mixed.revision === 3);
  c.ok("another month's topic and an invented id are dropped; t0 stays", same(s4.payload.filmedTopicIds, [t0]), JSON.stringify(s4.payload.filmedTopicIds));
  c.ok("the foreign topic's note is dropped; t0's stays", Object.keys(s4.payload.topicNotes).length === 1 && s4.payload.topicNotes[t0] === NOTE, JSON.stringify(s4.payload.topicNotes));
  const onListing = await saveUploadDraft(listing.id, { revision: null, baseHash: "h0", payload: P({ filmedTopicIds: [t0], topicNotes: { [t0]: "x" } }) });
  const sl = await stored(listing.id);
  c.ok("a listing shoot (no list — read successfully) still strips every topic id and note", onListing.ok && sl.payload.filmedTopicIds.length === 0 && Object.keys(sl.payload.topicNotes).length === 0);

  // =======================================================================
  c.head("5 · a draft with nothing to check still saves during the outage");
  const plain = await withTopicsBroken(() => saveUploadDraft(listing.id, { revision: onListing.ok ? onListing.revision : 1, baseHash: "h0", payload: P({ editorBrief: "no topics in this one" }) }));
  c.ok("no topic ids, no topic notes → no read → saved", plain.ok && (await stored(listing.id)).payload.editorBrief === "no topics in this one", JSON.stringify(plain).slice(0, 120));
  const listingWithIds = await withTopicsBroken(() => saveUploadDraft(listing.id, { revision: plain.ok ? plain.revision : 2, baseHash: "h0", payload: P({ filmedTopicIds: [t0] }) }));
  c.ok("(a listing job's read needs no topic table, so even an id there is decided — and dropped — during the outage)",
    listingWithIds.ok && (await stored(listing.id)).payload.filmedTopicIds.length === 0);

  // =======================================================================
  c.head("6 · conflict protection is intact");
  const snap6 = await snapshot(T.projectId);
  const staleBroken = await withTopicsBroken(() => saveUploadDraft(T.projectId, { revision: 1, baseHash: "h0", payload: Q(T) }));
  c.ok("(a) a stale save (revision 1, server at 3) during the outage: the retryable error, not a conflict",
    !staleBroken.ok && !("conflict" in staleBroken) && "retryable" in staleBroken && staleBroken.retryable === true);
  c.ok("(a) …and nothing was written", (await snapshot(T.projectId)) === snap6);
  const staleHealthy = await saveUploadDraft(T.projectId, { revision: 1, baseHash: "h0", payload: Q(T) });
  c.ok("(a) the same stale save after recovery is a conflict carrying the server copy", !staleHealthy.ok && "conflict" in staleHealthy && staleHealthy.conflict.revision === 3);
  c.ok("(a) …whose ticks are the server's [t0] — the outage emptied nothing",
    !staleHealthy.ok && "conflict" in staleHealthy && same(staleHealthy.conflict.payload.filmedTopicIds, [t0]) && staleHealthy.conflict.payload.topicNotes[t0] === NOTE);
  const racers = await Promise.all([
    saveUploadDraft(T.projectId, { revision: 3, baseHash: "h0", payload: Q(T, { editorBrief: "tab A" }) }),
    saveUploadDraft(T.projectId, { revision: 3, baseHash: "h0", payload: Q(T, { editorBrief: "tab B" }) }),
  ]);
  c.ok("(b) two tabs saving on the current revision: exactly one lands, the other hears a conflict",
    racers.filter((r) => r.ok).length === 1 && racers.filter((r) => !r.ok && "conflict" in r).length === 1);
  c.ok("(b) …and the winner's ticks are all there", same((await stored(T.projectId)).payload.filmedTopicIds, [t0, t1]));

  // =======================================================================
  c.head("7 · the autosaver: 'Couldn't save your topic ticks just now' → retry → saved");
  let now = 0;
  const q: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const timers = {
    set: (fn: () => void, ms: number) => { const id = ++seq; q.push({ at: now + ms, fn, id }); return id; },
    clear: (h: unknown) => { const i = q.findIndex((t) => t.id === h); if (i >= 0) q.splice(i, 1); },
    now: () => now,
  };
  const flushMicro = () => new Promise((r) => setImmediate(r));
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      q.sort((a, b) => a.at - b.at);
      const next = q[0];
      if (!next || next.at > until) break;
      q.shift();
      now = next.at;
      next.fn();
      await flushMicro();
      await flushMicro();
    }
    now = until;
  };
  {
    const statuses: string[] = [];
    const retryWaits: number[] = [];
    const plan: import("@/lib/uploadDraft").SaveOutcome[] = [
      { ok: false, message: DRAFT_TOPIC_CHECK_FAILED },
      { ok: false, message: DRAFT_TOPIC_CHECK_FAILED },
    ];
    let calls = 0;
    let savedBeforeThird = false;
    const saver = draftLib.createAutosaver({
      timers,
      onStatus: (s) => {
        statuses.push(s.kind);
        if (s.kind === "failed") retryWaits.push(s.retryInMs);
        if (s.kind === "saved" && calls < 3) savedBeforeThird = true;
      },
      save: async () => { calls++; return plan.shift() ?? { ok: true, savedAtISO: "2026-09-28T21:42:00Z" }; },
    });
    saver.change();
    await advance(1200);
    c.ok("first save fails with the topic line", calls === 1 && saver.status.kind === "failed" && "message" in saver.status && saver.status.message === DRAFT_TOPIC_CHECK_FAILED);
    await advance(2999);
    c.ok("nothing retries before 3 s", calls === 1);
    await advance(1);
    c.ok("the retry at +3 s fails again", calls === 2 && saver.status.kind === "failed");
    await advance(7999);
    c.ok("nothing retries before a further 8 s", calls === 2);
    await advance(1);
    c.ok("the retry at +8 s lands → saved", calls === 3 && saver.status.kind === "saved");
    c.ok("statuses: saving>failed>saving>failed>saving>saved, never 'saved' before the third call",
      statuses.join(">") === "saving>failed>saving>failed>saving>saved" && !savedBeforeThird && retryWaits.join(",") === "3000,8000", `${statuses.join(">")} · waits ${retryWaits.join(",")}`);
    saver.stop();
  }
  {
    // The same, wired to the REAL server action and the page's device-copy
    // rule (settleDraftSave). flush() stands in for the retry timer (it is
    // what the page's `online` / tab-hidden handlers call).
    const Z = await month("Autosave Topics");
    const dev = fakeDevice();
    let rev: number | null = null;
    let current = Q(Z);
    const seen: import("@/lib/uploadDraft").AutosaveStatus[] = [];
    const saver = draftLib.createAutosaver({
      timers,
      onStatus: (s) => { seen.push(s); },
      save: async () => {
        const payload = current;
        const json = JSON.stringify(payload);
        const device = dev.for(json);
        try {
          const r = await saveUploadDraft(Z.projectId, { revision: rev, baseHash: "h0", payload });
          const s = settleDraftSave(r, device);
          if (s.revision !== null) rev = s.revision;
          return s.outcome;
        } catch {
          device.keep();
          return { ok: false, message: "Unable to save" };
        }
      },
    });
    saver.change();
    await saver.flush();
    c.ok("(real) a healthy autosave lands: revision 1, device copy cleared", saver.status.kind === "saved" && rev === 1 && !dev.store.has("draft"));
    const snapZ = await snapshot(Z.projectId);
    const restore = breakDelegate(prisma.contentTopicSelection);
    try {
      current = Q(Z, { editorBrief: "typed while the list was down" });
      saver.change();
      await saver.flush();
      const st1 = saver.status;
      c.ok("(real) during the outage the chip's status is 'failed' with the topic line, retry in 3 s",
        st1.kind === "failed" && st1.message === DRAFT_TOPIC_CHECK_FAILED && st1.retryInMs === 3000, JSON.stringify(st1));
      c.ok("(real) the device copy holds the newest answers, ticks included",
        dev.store.has("draft") && JSON.parse(dev.store.get("draft")!).editorBrief === "typed while the list was down" && same(JSON.parse(dev.store.get("draft")!).filmedTopicIds, [Z.topicIds[0], Z.topicIds[1]]));
      c.ok("(real) the server row did not move and the page's revision did not either", (await snapshot(Z.projectId)) === snapZ && rev === 1);
      await saver.flush();
      const st2 = saver.status;
      c.ok("(real) a second failure backs off to 8 s", st2.kind === "failed" && st2.retryInMs === 8000, JSON.stringify(st2));
    } finally {
      restore();
    }
    await saver.flush();
    const sz = await stored(Z.projectId);
    c.ok("(real) after recovery the retry lands: saved, revision 2", saver.status.kind === "saved" && rev === 2);
    c.ok("(real) the stored ticks, the note and the outage-time brief are all there",
      same(sz.payload.filmedTopicIds, [Z.topicIds[0], Z.topicIds[1]]) && sz.payload.topicNotes[Z.topicIds[0]] === NOTE && sz.payload.editorBrief === "typed while the list was down");
    c.ok("(real) …and only then is the device copy cleared", !dev.store.has("draft"));
    c.ok("(real) 'saved' was never shown while the list was down",
      seen.map((s) => s.kind).join(">") === "saving>saved>saving>failed>saving>failed>saving>saved", seen.map((s) => s.kind).join(">"));
    saver.stop();
  }

  // =======================================================================
  c.head("8 · the page render: 'couldn't read the list' is not 'no list'");
  const healthyRead = await ft.readSessionTopics(T.projectId);
  c.ok("a healthy read: ok, the session and its three topics", healthyRead.ok && healthyRead.session?.topics.length === 3);
  const brokenRead = await withTopicsBroken(() => ft.readSessionTopics(T.projectId));
  c.ok("a failed read: NOT ok (unknown), with the reason — never { session: null }", !brokenRead.ok && /connection terminated/.test(brokenRead.error), JSON.stringify(brokenRead).slice(0, 140));
  const listingRead = await ft.readSessionTopics(listing.id);
  c.ok("a listing shoot: ok, session null (no list — known)", listingRead.ok && listingRead.session === null);
  // The page's own rule, as page.tsx computes it.
  const unavailableFor = (read: typeof brokenRead, contentMonthId: string | null) => !read.ok && !!contentMonthId;
  c.ok("the page flags a content job whose read failed as topicsUnavailable, and never a listing job",
    unavailableFor(brokenRead, T.monthId) === true && unavailableFor(listingRead, null) === false && unavailableFor(healthyRead, T.monthId) === false);

  // OLD vs NEW end to end: a stored draft with ticks, a render whose read
  // failed, then the next autosave with the database healthy again.
  const Yold = await month("Render Old");
  const Ynew = await month("Render New");
  for (const Y of [Yold, Ynew]) await saveUploadDraft(Y.projectId, { revision: null, baseHash: "h0", payload: Q(Y) });
  // OLD: sessionTopics was null → ticksFrom filtered the stored ticks against [].
  const oldTicks = restoredTopicTicks({ unavailable: false, topics: [], ids: (await stored(Yold.projectId)).payload.filmedTopicIds, projectId: Yold.projectId });
  c.ok("OLD render: the portal restored the draft with NO ticks", oldTicks.length === 0);
  const oldNext = await saveUploadDraft(Yold.projectId, { revision: 1, baseHash: "h0", payload: Q(Yold, { filmedTopicIds: oldTicks, editorBrief: "edited the brief" }) });
  c.ok("OLD render: the next autosave (database healthy, NEW server) stored [] — the ticks are gone",
    oldNext.ok && (await stored(Yold.projectId)).payload.filmedTopicIds.length === 0);
  // NEW: the read failed → topicsUnavailable → the ticks come back verbatim.
  const newRead = await withTopicsBroken(() => ft.readSessionTopics(Ynew.projectId));
  const newTicks = restoredTopicTicks({
    unavailable: unavailableFor(newRead, Ynew.monthId),
    topics: newRead.ok ? newRead.session?.topics ?? [] : [],
    ids: (await stored(Ynew.projectId)).payload.filmedTopicIds,
    projectId: Ynew.projectId,
  });
  c.ok("NEW render: the portal restores the stored ticks exactly as saved", same(newTicks, [Ynew.topicIds[0], Ynew.topicIds[1]]), JSON.stringify(newTicks));
  const newNext = await saveUploadDraft(Ynew.projectId, { revision: 1, baseHash: "h0", payload: Q(Ynew, { filmedTopicIds: newTicks, editorBrief: "edited the brief" }) });
  const syn = await stored(Ynew.projectId);
  c.ok("NEW render: the next autosave keeps them — ticks, note and the new brief",
    newNext.ok && same(syn.payload.filmedTopicIds, [Ynew.topicIds[0], Ynew.topicIds[1]]) && syn.payload.topicNotes[Ynew.topicIds[0]] === NOTE && syn.payload.editorBrief === "edited the brief");
  // The rule with a list is unchanged.
  const withList = restoredTopicTicks({
    unavailable: false,
    projectId: "p-here",
    topics: [
      { topicId: "a", confirmedOnProjectId: null },
      { topicId: "b", confirmedOnProjectId: "p-here" },
      { topicId: "c", confirmedOnProjectId: "p-other" },
      { topicId: "d", confirmedOnProjectId: null },
    ],
    ids: ["a", "c", "zzz"],
  });
  c.ok("with the list: saved ticks stay, recorded-here stays ticked, confirmed-elsewhere and unknown ids drop (as before)", same(withList, ["a", "b"]), JSON.stringify(withList));

  const pageSrc = fs.readFileSync(path.join(REPO, "src/app/upload/[id]/page.tsx"), "utf8");
  const portalSrc = fs.readFileSync(path.join(REPO, "src/components/upload/UploadPortal.tsx"), "utf8");
  c.ok("page.tsx no longer catches the topic read to null", !/topicsForSession\([^)]*\)\.catch\(\(\) => null\)/.test(pageSrc));
  c.ok("page.tsx reads with readSessionTopics and flags a failed read on a content job",
    pageSrc.includes("await readSessionTopics(project.id)") && pageSrc.includes("const topicsUnavailable = (!topicsRead.ok || pendingUnknown) && !!project.contentMonthId;") && pageSrc.includes("topicsUnavailable={topicsUnavailable}"));
  c.ok("the portal restores ticks through restoredTopicTicks with the unavailable flag",
    /const ticksFrom = \(ids: string\[\]\) =>\s*restoredTopicTicks\(\{ unavailable: topicsUnavailable,/.test(portalSrc));
  c.ok("the portal holds the video half while the list is unavailable (the reload line in the missing list)",
    portalSrc.includes(`if (vOn && topicsUnavailable) missing.push("reload the page (this job's topic list didn't load)");`));
  c.ok("the portal tells the photographer, in plain words", portalSrc.includes("This job&rsquo;s topic list didn&rsquo;t load. Reload the page before you submit the video — the topics you ticked earlier are kept."));
  c.ok("the portal's save goes through settleDraftSave (the device copy goes only on 'saved')",
    /const settled = settleDraftSave\(r, device\);/.test(portalSrc) && !/if \(r\.ok\) \{\s*revRef\.current = r\.revision;\s*lastSavedJson\.current = json;\s*clearMirror\(\);/.test(portalSrc));
  c.ok("the chip shows the topic line when that is why the save failed", portalSrc.includes("st.message === DRAFT_TOPIC_CHECK_FAILED ? DRAFT_TOPIC_CHECK_FAILED"));
  const draftSrc = fs.readFileSync(path.join(REPO, "src/app/upload/draftActions.ts"), "utf8");
  c.ok("draftActions no longer catches the topic read to null", !/topicsForSession\([^)]*\)\.catch\(\(\) => null\)/.test(draftSrc));

  // The real page, rendered as the server renders it (the element tree, not
  // HTML): what it hands the portal when the read fails vs when it works.
  c.head("8b · the real /upload/<id> render hands the portal 'unknown', and the stored ticks");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type El = { $$typeof: symbol; type: any; props: Record<string, any> };
  const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
  const nameOf = (t: any): string => (typeof t === "string" ? t : t?.displayName || t?.name || "?");
  const portalProps = (tree: any): Record<string, any> | null => {
    let hit: Record<string, any> | null = null;
    const walk = (n: any) => {
      if (hit || !n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!isEl(n)) return;
      if (nameOf(n.type) === "UploadPortal") { hit = n.props; return; }
      for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v);
    };
    walk(tree);
    return hit;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const UploadPage = (await import("@/app/upload/[id]/page")).default;
  const OldUploadPage = (await import(base.page)).default as typeof UploadPage;
  const render = async (id: string) => portalProps(await UploadPage({ params: Promise.resolve({ id }) }));
  const renderOld = async (id: string) => portalProps(await OldUploadPage({ params: Promise.resolve({ id }) }));
  // The one-time "new process" acknowledgement, so the page does not redirect him to it.
  await prisma.appSetting.create({ data: { key: "upload-ack-harrison-r02@drill.invalid", value: new Date().toISOString() } });
  {
    const Yp = await month("Page Render");
    await saveUploadDraft(Yp.projectId, { revision: null, baseHash: "h0", payload: Q(Yp) });
    const warnedPage: string[] = [];
    const realWarn2 = console.warn;
    console.warn = (...a: unknown[]) => { warnedPage.push(a.map(String).join(" ")); };
    let broken: Awaited<ReturnType<typeof render>>;
    let listingBroken: Awaited<ReturnType<typeof render>>;
    let oldBrokenPage: Awaited<ReturnType<typeof render>>;
    try {
      broken = await withTopicsBroken(() => render(Yp.projectId));
      listingBroken = await withTopicsBroken(() => render(listing.id));
      oldBrokenPage = await withTopicsBroken(() => renderOld(Yp.projectId));
    } finally {
      console.warn = realWarn2;
    }
    c.ok("OLD page (1075a5b), read failed: it handed the portal what a listing job gets — no list and no flag",
      !!oldBrokenPage && oldBrokenPage.sessionTopics === null && !("topicsUnavailable" in oldBrokenPage), JSON.stringify({ s: oldBrokenPage?.sessionTopics, u: oldBrokenPage?.topicsUnavailable ?? "absent" }));
    c.ok("OLD page: …so its portal restored the stored ticks against no list — none survive (the section 8 loss)",
      !!oldBrokenPage?.draft && restoredTopicTicks({ unavailable: false, topics: oldBrokenPage.sessionTopics?.topics ?? [], ids: oldBrokenPage.draft.payload.filmedTopicIds, projectId: Yp.projectId }).length === 0 && oldBrokenPage.draft.payload.filmedTopicIds.length === 2);
    c.ok("read failed on a content job: the portal gets topicsUnavailable, no list", !!broken && broken.topicsUnavailable === true && broken.sessionTopics === null, JSON.stringify({ u: broken?.topicsUnavailable, s: broken?.sessionTopics }).slice(0, 120));
    c.ok("…and the stored draft with its ticks and note, untouched",
      !!broken?.draft && same(broken.draft.payload.filmedTopicIds, [Yp.topicIds[0], Yp.topicIds[1]]) && broken.draft.payload.topicNotes[Yp.topicIds[0]] === NOTE);
    c.ok("…and the page log says why", warnedPage.some((w) => w.includes(`[upload-page] topic list unreadable for ${Yp.projectId}`)));
    const healthy = await render(Yp.projectId);
    c.ok("read works: topicsUnavailable is false and the list has its three topics", !!healthy && healthy.topicsUnavailable === false && healthy.sessionTopics?.topics.length === 3);
    c.ok("a listing job is never 'unavailable' (it has no list to lose)", !!listingBroken && listingBroken.topicsUnavailable === false && listingBroken.sessionTopics === null);
    c.ok("the stored row was not touched by any render", same((await stored(Yp.projectId)).payload.filmedTopicIds, [Yp.topicIds[0], Yp.topicIds[1]]));
  }

  // =======================================================================
  c.head("9 · confirmFilmedTopics refuses rather than writing on a failed verdict read");
  const approvedScript = async (f: ContentMonthFixture) => {
    const sc = await prisma.contentScript.create({
      data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: f.topicIds[0], title: "Pricing in week one", body: "body", status: "APPROVED", releaseState: "released" },
      select: { id: true },
    });
    const v = await prisma.contentScriptVersion.create({
      data: { scriptId: sc.id, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: 1, title: "Pricing in week one", hook: "h", pointsJson: "[]", close: "c", body: "b", source: "AI", status: "SHARED" },
      select: { id: true },
    });
    await prisma.contentScript.update({ where: { id: sc.id }, data: { sharedVersionId: v.id, approvedVersionId: v.id, clientApprovedVersionId: v.id, clientApprovedAt: new Date(), sharedAt: new Date() } });
    await prisma.contentScriptRelease.create({ data: { scriptId: sc.id, scriptVersionId: v.id, enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, action: "CLIENT_APPROVED", actorEmail: "client@example.com" } });
    return { scriptId: sc.id, versionId: v.id };
  };
  const W = await month("Verdict New");
  const X = await month("Verdict Old");
  const wScript = await approvedScript(W);
  await approvedScript(X);
  const healthyW = await ft.topicsForSession(W.projectId);
  c.ok("(healthy: the brief reads 'signed off by the client' on topic 0)", healthyW?.topics[0]?.clientApproved === true);
  const confirmedVideo = (monthId: string, topicId: string) =>
    prisma.contentVideo.findFirst({ where: { monthId, topicId, filmedConfirmedAt: { not: null } }, select: { id: true, scriptVersionId: true } });
  const withVerdictsBroken = async <R>(fn: () => Promise<R>): Promise<R> => {
    const restore = breakDelegate(prisma.contentScriptRelease);
    try { return await fn(); } finally { restore(); }
  };
  // OLD: records the video with no approved version, for good.
  const oldConfirm = await withVerdictsBroken(() => oldFT.confirmFilmedTopics(X.projectId, [X.topicIds[0]], "Harrison").then((r) => r, (e: Error) => e));
  const oldVid = await confirmedVideo(X.monthId, X.topicIds[0]);
  c.ok("OLD: the confirmation went through during the verdict outage", !(oldConfirm instanceof Error) && oldConfirm.confirmed === 1, oldConfirm instanceof Error ? oldConfirm.message : JSON.stringify(oldConfirm));
  c.ok("OLD: …and the filmed video has NO approved script version (the client did approve it)", !!oldVid && oldVid.scriptVersionId === null);
  const oldAgain = await oldFT.confirmFilmedTopics(X.projectId, [X.topicIds[0]], "Harrison");
  c.ok("OLD: a later healthy confirmation skips it as already confirmed — never re-stamped", oldAgain.alreadyConfirmed === 1 && (await confirmedVideo(X.monthId, X.topicIds[0]))?.scriptVersionId === null);
  // NEW.
  const soft = await withVerdictsBroken(() => ft.topicsForSession(W.projectId));
  c.ok("NEW: a read-only caller still renders (clientApproved reads false for one render)", !!soft && soft.topics.length === 3 && soft.topics[0].clientApproved === false);
  const draftReadDuringVerdicts = await withVerdictsBroken(() => ft.readSessionTopics(W.projectId));
  c.ok("NEW: a verdict outage is not a list outage — drafts still check membership and save", draftReadDuringVerdicts.ok && draftReadDuringVerdicts.session?.topics.length === 3);
  const videosBefore = await prisma.contentVideo.count({ where: { monthId: W.monthId } });
  const newConfirm = await withVerdictsBroken(() => ft.confirmFilmedTopics(W.projectId, [W.topicIds[0]], "Harrison").then((r) => r, (e: Error) => e));
  c.ok("NEW: confirmFilmedTopics refuses (throws) instead of writing", newConfirm instanceof Error && /script decisions/.test(newConfirm.message), newConfirm instanceof Error ? newConfirm.message.slice(0, 160) : JSON.stringify(newConfirm));
  c.ok("NEW: …and wrote no video and confirmed nothing", (await prisma.contentVideo.count({ where: { monthId: W.monthId } })) === videosBefore && !(await confirmedVideo(W.monthId, W.topicIds[0])));
  // Through the filming report: FAILED with a reason, then retried.
  const report = await prisma.contentFilmingReport.create({
    data: {
      projectId: W.projectId, monthId: W.monthId, enrollmentId: W.enrollmentId,
      submittedBy: "Harrison Drill", submittedByEmail: "harrison-r02@drill.invalid",
      topicIdsJson: JSON.stringify([W.topicIds[0]]), notesJson: JSON.stringify({}), extrasJson: JSON.stringify([]),
      payloadHash: "r02-drill-report-1",
    },
    select: { id: true },
  });
  const quietWarn = console.warn;
  console.warn = () => {};
  let failedRun: Awaited<ReturnType<typeof ft.applyFilmingReport>>;
  try {
    failedRun = await withVerdictsBroken(() => ft.applyFilmingReport(report.id));
  } finally {
    console.warn = quietWarn;
  }
  const failedRow = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: report.id } });
  c.ok("NEW: the filming report goes FAILED with the reason, and a next attempt is scheduled",
    failedRun.state === "FAILED" && failedRow.state === "FAILED" && /script decisions/.test(failedRow.lastError ?? "") && !!failedRow.nextAttemptAt, `${failedRow.state} · ${(failedRow.lastError ?? "").slice(0, 120)}`);
  c.ok("NEW: …with no confirmed video", !(await confirmedVideo(W.monthId, W.topicIds[0])));
  const landed = await ft.applyFilmingReport(report.id);
  const newVid = await confirmedVideo(W.monthId, W.topicIds[0]);
  c.ok("NEW: retried after recovery, the report is APPLIED", landed.state === "APPLIED" && landed.confirmed === 1, JSON.stringify(landed).slice(0, 160));
  c.ok("NEW: …and the video carries the client's approved script version", !!newVid && newVid.scriptVersionId === wScript.versionId, JSON.stringify(newVid));

  // =======================================================================
  // THE REVIEW OF THE R02 REPAIR (Sep 28 2026 evening): three more ways the
  // page could save, or restore, an answer it did not have.
  // =======================================================================
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const answerOf = (props: Record<string, any>) => draftLib.initialTopicAnswer({
    draft: props.draft?.payload ?? null,
    unavailable: props.topicsUnavailable === true,
    topics: props.sessionTopics?.topics ?? [],
    pending: props.sessionTopics?.pending ?? null,
    projectId: props.project.id,
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  type Answer = ReturnType<typeof answerOf>;
  /** The payload the portal autosaves after an edit (its draftPayload, topic part included). */
  const portalPayload = (a: Answer, over: Record<string, unknown> = {}, withFlag = true) =>
    P({ filmedTopicIds: a.ticks, topicNotes: a.notes, extraRows: a.extras, ...(withFlag && a.unknown ? { topicsUnknown: true } : {}), ...over });
  const EXTRA = { title: "Kitchen reveal walk-through", note: "shot on site, not on the list" };
  /** A whole submit consumed the draft; its filming report did not land (FAILED, retried hourly). */
  const submittedWithPendingReport = async (f: ContentMonthFixture & { projectId: string }) => {
    await saveUploadDraft(f.projectId, { revision: null, baseHash: "h0", payload: Q(f) });
    await prisma.uploadDraft.updateMany({ where: { projectId: f.projectId }, data: { consumedAt: new Date() } });
    return prisma.contentFilmingReport.create({
      data: {
        projectId: f.projectId, monthId: f.monthId, enrollmentId: f.enrollmentId,
        submittedBy: "Harrison Drill", submittedByEmail: "harrison-r02@drill.invalid",
        topicIdsJson: JSON.stringify([f.topicIds[0], f.topicIds[1]]),
        notesJson: JSON.stringify({ [f.topicIds[0]]: NOTE }),
        extrasJson: JSON.stringify([EXTRA]),
        payloadHash: `r02-pending-${f.projectId}`,
        state: "FAILED", attempts: 1, lastError: "connection terminated unexpectedly", nextAttemptAt: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });
  };
  const quietly = async <R>(fn: () => Promise<R>): Promise<{ out: R; warned: string[] }> => {
    const warned: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    try { return { out: await fn(), warned }; } finally { console.warn = real; }
  };
  const holdsReport = (a: Answer, f: { topicIds: string[] }) =>
    same(a.ticks, [f.topicIds[0], f.topicIds[1]]) && a.extras.length === 1 && a.extras[0].title === EXTRA.title && a.notes[f.topicIds[0]] === NOTE;

  // =======================================================================
  c.head("11 · a page with no topic answer never saves one (outage render, no open draft, a report not landed)");
  {
    const J = await month("Pending New");
    const Jb = await month("Pending Bypassed");
    for (const f of [J, Jb]) await submittedWithPendingReport(f);
    const healthy0 = await render(J.projectId);
    c.ok("(healthy render: the portal starts from the report — ticks [t0, t1], the extra, the note; no draft)",
      !!healthy0 && healthy0.draft === null && holdsReport(answerOf(healthy0), J) && answerOf(healthy0).unknown === false, JSON.stringify(healthy0 ? answerOf(healthy0) : null).slice(0, 200));
    // The same outage that failed the report fails the page's read.
    const outNew = (await quietly(() => withTopicsBroken(() => render(J.projectId)))).out;
    const outOld = (await quietly(() => withTopicsBroken(() => render(Jb.projectId)))).out;
    c.ok("outage render: topicsUnavailable, no list, no open draft", !!outNew && outNew.topicsUnavailable === true && outNew.sessionTopics === null && outNew.draft === null && outNew.draftRevision === null);
    const aNew = answerOf(outNew!);
    c.ok("NEW: the portal has NO topic answer (unknown) — its empty ticks, extras and notes are placeholders",
      aNew.unknown === true && aNew.ticks.length === 0 && aNew.extras.length === 0 && Object.keys(aNew.notes).length === 0, JSON.stringify(aNew));
    // A typo fixed in the brief → the autosave. No topic ids → no topic check → it lands even mid-outage.
    const BRIEF = "Backlit kitchen — recover the window (typo fixed during the outage)";
    const sNew = await withTopicsBroken(() => saveUploadDraft(J.projectId, { revision: outNew!.draftRevision, baseHash: "h0", payload: portalPayload(aNew, { editorBrief: BRIEF }) }));
    const sOld = await withTopicsBroken(() => saveUploadDraft(Jb.projectId, { revision: outOld!.draftRevision, baseHash: "h0", payload: portalPayload(answerOf(outOld!), { editorBrief: BRIEF }, false) }));
    c.ok("the outage-time autosave lands on both (it reuses the consumed draft)", sNew.ok && sOld.ok, JSON.stringify([sNew, sOld]).slice(0, 160));
    const stNew = await stored(J.projectId);
    const stNewRaw = JSON.parse(stNew.row.payloadJson) as Record<string, unknown>;
    c.ok("NEW: the stored draft says 'no topic answer' (topicsUnknown), with the brief", stNewRaw.topicsUnknown === true && stNew.payload.editorBrief === BRIEF && stNew.payload.filmedTopicIds.length === 0);
    const stOld = JSON.parse((await stored(Jb.projectId)).row.payloadJson) as Record<string, unknown>;
    c.ok("FIX BYPASSED (no flag, the repair as it stood): the stored draft claims an answer of none — ticks [], extras []",
      !("topicsUnknown" in stOld) && Array.isArray(stOld.filmedTopicIds) && (stOld.filmedTopicIds as unknown[]).length === 0 && (stOld.extraRows as unknown[]).length === 0);
    // The reload the banner asked for, with the database healthy.
    const reNew = await render(J.projectId);
    const reOld = await render(Jb.projectId);
    const aReNew = answerOf(reNew!);
    const aReOld = answerOf(reOld!);
    c.ok("NEW healthy reload: the draft is restored (the brief) …", reNew?.draft?.payload.editorBrief === BRIEF && reNew?.topicsUnavailable === false);
    c.ok("NEW healthy reload: … and the topics are the report's — [t0, t1], the extra, the note — as the banner promised",
      holdsReport(aReNew, J) && aReNew.source === "job" && aReNew.unknown === false, JSON.stringify(aReNew).slice(0, 200));
    c.ok("FIX BYPASSED healthy reload: nothing ticked, no extra, no note — while the report still says two topics and an extra (the review's defect)",
      aReOld.ticks.length === 0 && aReOld.extras.length === 0 && Object.keys(aReOld.notes).length === 0 && reOld?.sessionTopics?.pending?.topicIds.length === 2, JSON.stringify(aReOld));
    const rep = await prisma.contentFilmingReport.findFirstOrThrow({ where: { projectId: J.projectId } });
    c.ok("the pending report itself was never touched (still FAILED, [t0, t1], the extra)",
      rep.state === "FAILED" && same(JSON.parse(rep.topicIdsJson) as string[], [J.topicIds[0], J.topicIds[1]]) && (JSON.parse(rep.extrasJson ?? "[]") as unknown[]).length === 1);

    // The server half: a "no answer" save never replaces a stored answer.
    c.head("11b · the server keeps a stored answer when a save carries none");
    const K = await month("Carry New");
    const Kb = await month("Carry Old Server");
    const heldFor = (f: { topicIds: string[] }) => ({ filmedTopicIds: [f.topicIds[0]], topicNotes: { [f.topicIds[0]]: NOTE }, extraRows: [EXTRA] });
    await saveUploadDraft(K.projectId, { revision: null, baseHash: "h0", payload: P(heldFor(K)) });
    await saveUploadDraft(Kb.projectId, { revision: null, baseHash: "h0", payload: P(heldFor(Kb)) });
    const noAnswer = (over: Record<string, unknown>) => P({ topicsUnknown: true, ...over });
    const carriedNew = await withTopicsBroken(() => saveUploadDraft(K.projectId, { revision: 1, baseHash: "h0", payload: noAnswer({ editorBrief: "brief from the outage tab" }) }));
    const sk = await stored(K.projectId);
    const skRaw = JSON.parse(sk.row.payloadJson) as Record<string, unknown>;
    c.ok("NEW: a no-answer save on the draft's revision lands (revision 2) …", carriedNew.ok && carriedNew.revision === 2, JSON.stringify(carriedNew));
    c.ok("NEW: … keeping the stored tick, note and extra, with the new brief — and the flag is gone (the draft HAS an answer)",
      same(sk.payload.filmedTopicIds, [K.topicIds[0]]) && sk.payload.topicNotes[K.topicIds[0]] === NOTE && (skRaw.extraRows as { title: string }[])[0]?.title === EXTRA.title && sk.payload.editorBrief === "brief from the outage tab" && !("topicsUnknown" in skRaw),
      sk.row.payloadJson.slice(0, 220));
    const oldCarry = await withTopicsBroken(() => oldDA.saveUploadDraft(Kb.projectId, { revision: 1, baseHash: "h0", payload: noAnswer({ editorBrief: "brief from the outage tab" }) }));
    const skb = JSON.parse((await stored(Kb.projectId)).row.payloadJson) as Record<string, unknown>;
    c.ok("OLD server (1075a5b, no carry) on the same save: the stored answer is gone — ticks [], extras [] (why the carry is needed)",
      oldCarry.ok && (skb.filmedTopicIds as unknown[]).length === 0 && (skb.extraRows as unknown[]).length === 0);
    const snapK = await snapshot(K.projectId);
    const staleNoAnswer = await saveUploadDraft(K.projectId, { revision: 1, baseHash: "h0", payload: noAnswer({ editorBrief: "stale tab" }) });
    c.ok("a stale no-answer save is a conflict carrying the server's answer — nothing written, never a mix",
      !staleNoAnswer.ok && "conflict" in staleNoAnswer && same(staleNoAnswer.conflict.payload.filmedTopicIds, [K.topicIds[0]]) && (await snapshot(K.projectId)) === snapK);
    const L = await month("Carry Nothing");
    const freshNoAnswer = await saveUploadDraft(L.projectId, { revision: null, baseHash: "h0", payload: noAnswer({ editorBrief: "first save, no answer" }) });
    const slRaw = JSON.parse((await stored(L.projectId)).row.payloadJson) as Record<string, unknown>;
    c.ok("with nothing stored, the draft stays 'no topic answer' — never an answer of none", freshNoAnswer.ok && slRaw.topicsUnknown === true);
    const norm1 = draftLib.normalizeDraftPayload({ topicsUnknown: true, filmedTopicIds: [K.topicIds[0]], topicNotes: { [K.topicIds[0]]: "x" }, extraRows: [EXTRA] });
    const norm2 = draftLib.normalizeDraftPayload({ topicsUnknown: "yes", filmedTopicIds: [K.topicIds[0]] });
    c.ok("normalize: the flag empties the three topic fields; anything but `true` is no flag",
      norm1.topicsUnknown === true && norm1.filmedTopicIds.length === 0 && Object.keys(norm1.topicNotes).length === 0 && norm1.extraRows.length === 0 &&
      !("topicsUnknown" in norm2) && same(norm2.filmedTopicIds, [K.topicIds[0]]));
    const viaFlagged = answerOf({ draft: { payload: norm1 }, topicsUnavailable: false, sessionTopics: { topics: [{ topicId: "topicA", confirmedOnProjectId: null, note: "on file" }], pending: { topicIds: ["topicA"], extras: [EXTRA] } }, project: { id: "p" } });
    const flaggedDown = answerOf({ draft: { payload: norm1 }, topicsUnavailable: true, sessionTopics: null, project: { id: "p" } });
    const unflaggedDown = answerOf({ draft: { payload: norm2 }, topicsUnavailable: true, sessionTopics: null, project: { id: "p" } });
    c.ok("initialTopicAnswer: a flagged draft falls through to the job's own answer (report ticks, extra, note on file) …",
      viaFlagged.source === "job" && same(viaFlagged.ticks, ["topicA"]) && viaFlagged.extras.length === 1 && viaFlagged.notes.topicA === "on file" && !viaFlagged.unknown, JSON.stringify(viaFlagged));
    c.ok("… with the list down it is unknown; an unflagged draft IS the answer, kept verbatim",
      flaggedDown.unknown === true && flaggedDown.ticks.length === 0 && unflaggedDown.unknown === false && unflaggedDown.source === "draft" && same(unflaggedDown.ticks, [K.topicIds[0]]));

    const portal = fs.readFileSync(path.join(REPO, "src/components/upload/UploadPortal.tsx"), "utf8");
    c.ok("the portal seeds its topic answer through initialTopicAnswer (draft, unavailable, topics, pending)",
      /const \[topic0\] = useState\(\(\) => initialTopicAnswer\(\{\s*draft: d0,\s*unavailable: topicsUnavailable,/.test(portal) && /useState\(topic0\.unknown\)/.test(portal) && /useState<string\[\]>\(topic0\.ticks\)/.test(portal));
    c.ok("the portal's draft says topicsUnknown while it has no answer",
      portal.includes("...(topicAnswerUnknown ? { topicsUnknown: true as const } : {}),"));
    c.ok("the portal's applyDraft leaves the topics alone for a copy with no answer, and takes one that has an answer",
      /if \(!p\.topicsUnknown\) \{\s*setFilmedTopicIds\(ticksFrom\(p\.filmedTopicIds\)\);[\s\S]{0,300}setTopicAnswerUnknown\(false\);\s*\}/.test(portal));
    const actions = fs.readFileSync(path.join(REPO, "src/app/upload/draftActions.ts"), "utf8");
    c.ok("the carry reads the row it replaces, uncaught (a failed read fails the save rather than writing 'no answer')",
      /if \(payload\.topicsUnknown && onRevision\) \{\s*const cur = await prisma\.uploadDraft\.findUnique\(\{[\s\S]{0,160}\}\);/.test(actions) && /payload = carryTopicAnswer\(payload, stored\);/.test(actions));
  }

  // =======================================================================
  c.head("12 · the pending report's own row failing to read is 'unknown' too (not 'ticked nothing')");
  {
    const R = await month("Pending Row New");
    await submittedWithPendingReport(R);
    const withReportRowBroken = <T>(fn: () => Promise<T>) => {
      const restore = breakDelegate(prisma.contentFilmingReport, "findUnique");
      return fn().finally(restore);
    };
    const oldProps = (await quietly(() => withReportRowBroken(() => renderOld(R.projectId)))).out;
    c.ok("OLD page (1075a5b): the list loaded, the report is pending, but its ticks and extras read as NONE — and no flag, no banner",
      !!oldProps && !!oldProps.sessionTopics && oldProps.sessionTopics.pending?.topicIds.length === 0 && oldProps.sessionTopics.pending?.extras.length === 0 && !("topicsUnavailable" in oldProps));
    const aOld = answerOf(oldProps!);
    c.ok("OLD: so the portal started from 'ticked nothing, no extra' as a known answer (the next autosave stores it)",
      aOld.ticks.length === 0 && aOld.extras.length === 0 && aOld.unknown === false);
    const { out: newProps, warned } = await quietly(() => withReportRowBroken(() => render(R.projectId)));
    c.ok("NEW: the page treats it as a list that did not load — topicsUnavailable, no list handed over",
      !!newProps && newProps.topicsUnavailable === true && newProps.sessionTopics === null, JSON.stringify({ u: newProps?.topicsUnavailable, s: !!newProps?.sessionTopics }));
    c.ok("NEW: … so the portal has no topic answer (it holds the video half and shows the reload banner)", answerOf(newProps!).unknown === true);
    c.ok("NEW: the page log says why", warned.some((w) => w.includes(`[upload-page] pending filming report unreadable for ${R.projectId}`) && w.includes("connection terminated")), warned.join(" | ").slice(0, 200));
    const vanished = (await quietly(async () => {
      const d = prisma.contentFilmingReport as unknown as Record<string, unknown>;
      const real = d.findUnique;
      d.findUnique = async () => null;
      try { return await render(R.projectId); } finally { d.findUnique = real; }
    })).out;
    c.ok("NEW: a pending row that vanished between the two reads is unknown too", vanished?.topicsUnavailable === true && vanished?.sessionTopics === null);
    const back = await render(R.projectId);
    c.ok("healthy again: not unavailable, and the report's ticks and extra come back", back?.topicsUnavailable === false && holdsReport(answerOf(back!), R));
  }

  // =======================================================================
  c.head("13 · the device copy restores silently only onto the revision it was typed on");
  {
    const oldPortalRule = show("src/components/upload/UploadPortal.tsx");
    const OLD_RULE = `const newer = m?.payload && (!draft || (m.savedAtISO ?? "") > draft.savedAtISO);`;
    c.ok("(OLD 1075a5b: the restore rule compared the copy's stamp — re-written on every failed attempt — with the server's)",
      oldPortalRule.includes(OLD_RULE) && oldPortalRule.includes("savedAtISO: new Date().toISOString(), baseHash: baseHashRef.current"));
    const scenario = async (f: ContentMonthFixture & { projectId: string }) => {
      // The phone's page is on revision 1 (one tick).
      await saveUploadDraft(f.projectId, { revision: null, baseHash: "h0", payload: P({ filmedTopicIds: [f.topicIds[0]] }) });
      const phone = P({ editorBrief: "typed on the phone", filmedTopicIds: [f.topicIds[0]] });
      const phoneJson = JSON.stringify(phone);
      const T1 = new Date(Date.now() - 2000).toISOString();
      // Its save fails on the topic read → the copy is kept (typed on revision 1).
      const failed = (await quietly(() => withTopicsBroken(() => saveUploadDraft(f.projectId, { revision: 1, baseHash: "h0", payload: phone })))).out;
      let copy: string | null = null;
      settleDraftSave(failed, { keep: () => { copy = draftLib.nextDeviceCopy(copy, { json: phoneJson, revision: 1, nowISO: T1, baseHash: "h0", baseAtISO: T1 }); }, clear: () => { copy = null; } });
      // The laptop saves revision 2 with more ticks.
      const laptop = await saveUploadDraft(f.projectId, { revision: 1, baseHash: "h0", payload: P({ editorBrief: "typed on the laptop", filmedTopicIds: [f.topicIds[0], f.topicIds[1]] }) });
      const S2 = (await stored(f.projectId)).row.savedAt.toISOString();
      // The phone's retry, now healthy, is a conflict → the copy is kept again, AFTER the laptop's save.
      const T3 = new Date(Date.parse(S2) + 5000).toISOString();
      const conflicted = await saveUploadDraft(f.projectId, { revision: 1, baseHash: "h0", payload: phone });
      settleDraftSave(conflicted, { keep: () => { copy = draftLib.nextDeviceCopy(copy, { json: phoneJson, revision: 1, nowISO: T3, baseHash: "h0", baseAtISO: T1 }); }, clear: () => { copy = null; } });
      return { phone, T1, T3, S2, laptop, conflicted, copy: copy as string | null };
    };
    const M = await month("Device Copy New");
    const Mo = await month("Device Copy Old");
    const sN = await scenario(M);
    const sO = await scenario(Mo);
    c.ok("(setup: the laptop saved revision 2; the phone's retry heard a conflict; the copy is still on the phone)",
      sN.laptop.ok && sN.laptop.revision === 2 && !sN.conflicted.ok && "conflict" in sN.conflicted && !!sN.copy);
    const m = JSON.parse(sN.copy!) as { typedAtISO: string; savedAtISO: string; baseRevision: number };
    c.ok("NEW copy: typed at T1 (before the laptop's save), last written at T3 (after it), on revision 1",
      m.typedAtISO === sN.T1 && m.savedAtISO === sN.T3 && m.baseRevision === 1 && m.typedAtISO < sN.S2 && m.savedAtISO > sN.S2, JSON.stringify({ typed: m.typedAtISO, saved: m.savedAtISO, base: m.baseRevision, S2: sN.S2 }));
    // The phone's tab is closed, then reopened: the page reads the server's draft.
    const serverDraft = async (f: { projectId: string }) => {
      const r = await prisma.uploadDraft.findFirstOrThrow({ where: { projectId: f.projectId } });
      return { revision: r.revision, savedAtISO: r.savedAt.toISOString(), payload: draftLib.normalizeDraftPayload(JSON.parse(r.payloadJson)) };
    };
    // OLD: the copy as the old page wrote it (one stamp, re-written at T3), and the old rule.
    const dO = await serverDraft(Mo);
    const oldCopy = { savedAtISO: sO.T3, baseHash: "h0", baseAtISO: sO.T1, payload: sO.phone };
    const oldNewer = !!oldCopy.payload && (oldCopy.savedAtISO ?? "") > dO.savedAtISO;
    c.ok("OLD rule: the phone's copy (typed before the laptop's save) reads as NEWER and is restored silently", oldNewer === true);
    const oldPush = await saveUploadDraft(Mo.projectId, { revision: dO.revision, baseHash: "h0", payload: oldCopy.payload });
    const afterOld = await stored(Mo.projectId);
    c.ok("OLD: … and its autosave lands on revision 2 with no conflict — the laptop's second tick is gone (the review's defect)",
      oldPush.ok && oldPush.revision === 3 && same(afterOld.payload.filmedTopicIds, [Mo.topicIds[0]]) && afterOld.payload.editorBrief === "typed on the phone");
    // NEW.
    const dN = await serverDraft(M);
    const decided = draftLib.decideDeviceRestore(sN.copy, { draft: dN, debriefSubmittedAtISO: null });
    c.ok("NEW: the server moved on since the copy was typed → ASK (the conflict panel), never a silent restore", decided.action === "ask", decided.action);
    c.ok("NEW: … and the server keeps the laptop's answers until the person chooses",
      (await stored(M.projectId)).row.revision === 2 && same((await stored(M.projectId)).payload.filmedTopicIds, [M.topicIds[0], M.topicIds[1]]));
    const legacy = draftLib.decideDeviceRestore(JSON.stringify(oldCopy), { draft: dN, debriefSubmittedAtISO: null });
    c.ok("NEW on a copy written the OLD way (no revision): a newer stamp proves nothing → ASK as well", legacy.action === "ask");
    const legacyOlder = draftLib.decideDeviceRestore(JSON.stringify({ ...oldCopy, savedAtISO: sN.T1 }), { draft: dN, debriefSubmittedAtISO: null });
    c.ok("NEW: an old-format copy older than the server's is left alone (as before)", legacyOlder.action === "none");
    // "Keep this page's answers" in the panel: the copy is saved onto the server's revision — by choice.
    const kept = decided.action === "ask" ? await saveUploadDraft(M.projectId, { revision: dN.revision, baseHash: "h0", payload: decided.copy.payload }) : null;
    c.ok("NEW: choosing the phone's copy saves it onto revision 2 → 3 (the person decided)", !!kept && kept.ok && kept.revision === 3);
    // The ordinary offline case still restores silently.
    const onTop = draftLib.nextDeviceCopy(null, { json: JSON.stringify(P({ editorBrief: "typed offline on top of revision 3", filmedTopicIds: [M.topicIds[0]] })), revision: 3, nowISO: new Date().toISOString(), baseHash: "h0", baseAtISO: sN.T1 });
    const d3 = await serverDraft(M);
    const onTopDecided = draftLib.decideDeviceRestore(onTop, { draft: d3, debriefSubmittedAtISO: null });
    c.ok("a copy typed ON the server's current revision is restored silently (the offline case is unchanged)", onTopDecided.action === "restore" && d3.revision === 3);
    const pushed = onTopDecided.action === "restore" ? await saveUploadDraft(M.projectId, { revision: d3.revision, baseHash: "h0", payload: onTopDecided.copy.payload }) : null;
    c.ok("… and its autosave lands with no conflict", !!pushed && pushed.ok && pushed.revision === 4);
    const d4 = await serverDraft(M);
    const same4 = draftLib.nextDeviceCopy(null, { json: JSON.stringify(d4.payload), revision: 1, nowISO: new Date().toISOString(), baseHash: "h0", baseAtISO: sN.T1 });
    c.ok("a copy identical to the server's is dropped (nothing unsent), whatever its revision", draftLib.decideDeviceRestore(same4, { draft: d4, debriefSubmittedAtISO: null }).action === "drop");
    const submittedBetween = new Date(Date.parse(sN.T1) + 1000).toISOString();
    c.ok("a copy TYPED before the whole submit is dropped, though a retry re-wrote it after (the old rule kept it)",
      draftLib.decideDeviceRestore(sN.copy, { draft: dN, debriefSubmittedAtISO: submittedBetween }).action === "drop" && m.savedAtISO > submittedBetween);
    c.ok("with no server copy there is nothing to overwrite: restored", draftLib.decideDeviceRestore(sN.copy, { draft: null, debriefSubmittedAtISO: null }).action === "restore");
    const retyped = draftLib.nextDeviceCopy(sN.copy, { json: JSON.stringify(P({ editorBrief: "typed more" })), revision: 1, nowISO: sN.T3, baseHash: "h0", baseAtISO: sN.T1 });
    c.ok("new answers take a new typing time; the same answers keep theirs", (JSON.parse(retyped) as { typedAtISO: string }).typedAtISO === sN.T3 && m.typedAtISO === sN.T1);

    const portal = fs.readFileSync(path.join(REPO, "src/components/upload/UploadPortal.tsx"), "utf8");
    c.ok("the portal writes its copy with nextDeviceCopy, on the revision it attempted (revRef)",
      /nextDeviceCopy\(window\.localStorage\.getItem\(mirrorKey\), \{\s*json, revision: revRef\.current,/.test(portal));
    c.ok("the portal decides the restore with decideDeviceRestore — the stamp comparison is gone",
      /const d = decideDeviceRestore\(window\.localStorage\.getItem\(mirrorKey\), \{/.test(portal) && !portal.includes(OLD_RULE));
    c.ok("on ASK it stops the autosave BEFORE putting the copy on the page, and opens the conflict panel with the server's copy",
      /if \(d\.action === "ask" && draft\) \{[\s\S]{0,300}saver\.stop\(\);\s*applyDraft\(m\.payload\);[\s\S]{0,200}setDraftConflict\(\{\s*revision: draft\.revision, payload: draft\.payload,/.test(portal));
  }

  // =======================================================================
  c.head("10 · nothing left the building");
  c.ok("the database was never production", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/`));
  c.ok("no outbound call was attempted", fence.blocked.length === 0, fence.blocked.slice(0, 5).join(", "));
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
