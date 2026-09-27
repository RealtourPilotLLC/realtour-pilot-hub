// ---------------------------------------------------------------------------
// DRILL: O04 / A30 — THE PHOTOGRAPHER'S UNSENT ANSWERS SURVIVE, AND SAVING THEM
// IS NEVER A SUBMIT. Unified handoff batch 4, Sep 25 2026.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/upload-drafts.ts
//
// What it proves, OLD behaviour first where it can be observed:
//
//   0. OLD (fa9a2c9): there is no draft writer at all, and the portal keeps the
//      wrap-up answers nowhere but React state — a closed tab loses them.
//   1. A save writes ONE UploadDraft row and nothing else: the Project row is
//      byte-identical (updatedAt included) after five autosaves; no Activity,
//      Notification, SmartTask or ContentFilmingReport row appears; the
//      whole-page stamp stays null.
//   2. Pay is untouched: the creative payroll still drops the shoot and
//      shootEarnings still says "pending" after five autosaves.
//   3. A stale revision (another tab) is a CONFLICT carrying the server copy;
//      keeping this page's answers onto the server revision then lands.
//   4. Another photographer and an owner's "view as" are refused, and write no row.
//   5. Oversized answers are clipped to the submit's own caps; topic ids the
//      session does not have are dropped.
//   6. The submit consumes the draft (the page would restore nothing); the next
//      save reuses the same row.
//   7. A re-submit after the Editing Room's brief editor changed the brief is
//      refused with who changed what — nothing overwritten — and lands only
//      when sent again against the new fingerprint.
//   8. The autosaver (lib/uploadDraft createAutosaver) on a fake clock:
//      debounce, max-wait, fail → retry → saved, conflict stops it.
//
// ISOLATION. PGlite on 127.0.0.1:5712 (DRILL_PORT overrides) through the shared
// harness; production is never opened. Every non-loopback call is fenced.
// AUTH_ENFORCE is on so the real guards run against real sessions.
//
// THE CLOCK is pinned to Wednesday Sep 23 2026, 21:30 ET (the shoot was that
// morning), so the pay gate treats the shoot as happened and unsubmitted.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5712);
const BASE = "fa9a2c9"; // the commit this batch starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ------------------------------------------------------------
const RealDate = Date;
let SIM = RealDate.parse("2026-09-23T21:30:00-04:00");
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
const advanceMinutes = (n: number) => { SIM += n * 60_000; };

installNextStubs();
const fence = fenceFetch();

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { saveUploadDraft, discardUploadDraft } = await import("@/app/upload/draftActions");
  const { finalizeUpload } = await import("@/app/upload/actions");
  const { saveShootBriefFields } = await import("@/app/editing/actions");
  const { establishSession, setSession } = await import("@/lib/auth/session");
  const { computePayroll } = await import("@/lib/payroll");
  const { shootEarnings } = await import("@/lib/shoot");
  const draftLib = await import("@/lib/uploadDraft");

  c.head("0 · OLD (fa9a2c9): nothing keeps an unsent wrap-up");
  const show = (f: string) => {
    try { return execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  };
  c.ok("fa9a2c9 has no draft writer (src/app/upload/draftActions.ts absent)", show("src/app/upload/draftActions.ts") === null);
  const oldPortal = show("src/components/upload/UploadPortal.tsx") ?? "";
  c.ok("fa9a2c9 UploadPortal keeps the answers in React state only (no draft save, no device copy)",
    oldPortal.length > 0 && !/saveUploadDraft|localStorage|sessionStorage|autosave/i.test(oldPortal));
  c.ok("fa9a2c9's only writer of the brief is the submit (finalizeUpload)", /finalizeUpload\(project\.id, payload\)/.test(oldPortal));

  // ---- the world ---------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drafts Client TEST" }, select: { id: true } });
  const harrisonTm = await prisma.teamMember.create({
    data: { name: "Harrison Drill", email: "harrison-drafts@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 },
    select: { id: true },
  });
  const jamesTm = await prisma.teamMember.create({
    data: { name: "James Drill", email: "james-drafts@drill.invalid", role: "PHOTOGRAPHER" },
    select: { id: true },
  });
  const harrison = await prisma.appUser.create({ data: { email: "harrison-drafts@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE" }, select: { id: true } });
  const james = await prisma.appUser.create({ data: { email: "james-drafts@drill.invalid", name: "James Drill", role: "PHOTOGRAPHER", status: "ACTIVE" }, select: { id: true } });
  const owner = await prisma.appUser.create({ data: { email: "owner-drafts@drill.invalid", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" }, select: { id: true, email: true } });
  void jamesTm;
  const SHOOT = new Date("2026-09-23T10:00:00-04:00");
  const project = await prisma.project.create({
    data: {
      title: "12 Draft Ln, Emmaus, PA", clientId: client.id, status: "SCHEDULED", shootDate: SHOOT,
      photographerId: harrisonTm.id, price: 400,
      deliverables: {
        create: [
          { type: "PHOTOS", label: "Photos", quantity: 1 },
          { type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1, videoStyle: "standard_cinematic" },
        ],
      },
    },
    select: { id: true },
  });
  const pid = project.id;
  const asHarrison = () => establishSession(harrison.id);

  const counts = async () => ({
    activity: await prisma.activity.count({ where: { projectId: pid } }),
    notification: await prisma.notification.count(),
    task: await prisma.smartTask.count({ where: { projectId: pid } }),
    filming: await prisma.contentFilmingReport.count({ where: { projectId: pid } }),
  });
  const P = (n: number) => ({
    editorBrief: `Backlit exteriors — recover the sky (${n})`,
    checks: { coverage: true, culling: true, quality: n > 2, count: false },
    removal: "Trash cans in exterior 3",
    nothingToRemove: false,
    orderChoice: "front-to-back",
    orderNotes: "",
    vidStyle: "cinematic",
    vidSections: { vision: `Calm and slow, pass ${n}`, summary: "Two-storey colonial" },
    videosFilmed: "",
    filmedTopicIds: [],
    topicNotes: {},
    extraRows: [],
    scriptChoice: null,
    scriptText: "",
    scriptNote: "",
  });

  // =======================================================================
  c.head("1 · a save is a draft and nothing else");
  await asHarrison();
  const before = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
  const countsBefore = await counts();
  const r1 = await saveUploadDraft(pid, { revision: null, baseHash: "h0", payload: P(1) });
  c.ok("the first save lands as revision 1", r1.ok && r1.revision === 1, JSON.stringify(r1).slice(0, 120));
  let rev = r1.ok ? r1.revision : 0;
  for (let i = 2; i <= 5; i++) {
    advanceMinutes(1);
    const r = await saveUploadDraft(pid, { revision: rev, baseHash: "h0", payload: P(i) });
    if (r.ok) rev = r.revision;
  }
  c.ok("five autosaves → revision 5, one row", rev === 5 && (await prisma.uploadDraft.count({ where: { projectId: pid } })) === 1, `rev ${rev}`);
  const after = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
  c.ok("the Project row is byte-identical, updatedAt included", JSON.stringify(after) === JSON.stringify(before));
  c.ok("debriefSubmittedAt and both half stamps stay null", !after.debriefSubmittedAt && !after.photosHandoffAt && !after.videoHandoffAt);
  const countsAfter = await counts();
  c.ok("no Activity, Notification, SmartTask or filming report was written", JSON.stringify(countsAfter) === JSON.stringify(countsBefore), JSON.stringify(countsAfter));
  const row = await prisma.uploadDraft.findFirstOrThrow({ where: { projectId: pid } });
  c.ok("the row is keyed to the signed-in photographer, by email", row.authorKey === "harrison-drafts@drill.invalid" && row.authorName === "Harrison Drill");
  c.ok("the row holds the latest answers", JSON.parse(row.payloadJson).vidSections.vision === "Calm and slow, pass 5");

  // =======================================================================
  c.head("2 · pay is untouched by autosaves");
  const start = new Date("2026-09-01T00:00:00-04:00");
  const end = new Date("2026-09-30T23:59:59-04:00");
  const creative = await computePayroll(start, end, { forCreativeEyes: true });
  const ownerView = await computePayroll(start, end);
  const lineIn = (rows: Awaited<ReturnType<typeof computePayroll>>) =>
    rows.flatMap((p) => (p as unknown as { jobs?: { projectId: string; debriefPending?: boolean }[] }).jobs ?? []).find((j) => j.projectId === pid);
  c.ok("the creative payroll still drops the shoot (wrap-up not submitted)", !lineIn(creative));
  const ownerLine = lineIn(ownerView);
  c.ok("the owner's view still has the line, flagged debriefPending", !!ownerLine && ownerLine.debriefPending === true, JSON.stringify(ownerLine ?? null).slice(0, 120));
  const earn = await shootEarnings(pid, harrisonTm.id);
  c.ok("shootEarnings still says pending", earn?.state === "pending", earn?.state ?? "null");

  // =======================================================================
  c.head("3 · a stale tab hears a conflict, never overwrites");
  const stale = await saveUploadDraft(pid, { revision: 2, baseHash: "h0", payload: P(99) });
  c.ok("a save from revision 2 (server at 5) is refused as a conflict", !stale.ok && "conflict" in stale, JSON.stringify(stale).slice(0, 100));
  if (!stale.ok && "conflict" in stale) {
    c.ok("the conflict carries the server copy and its revision", stale.conflict.revision === 5 && stale.conflict.payload.vidSections.vision === "Calm and slow, pass 5" && !stale.conflict.submitted);
    const keep = await saveUploadDraft(pid, { revision: stale.conflict.revision, baseHash: "h0", payload: P(99) });
    c.ok("keeping this page's answers onto the server revision lands", keep.ok && keep.revision === 6);
    if (keep.ok) rev = keep.revision;
  }
  const racers = await Promise.all([
    saveUploadDraft(pid, { revision: rev, baseHash: "h0", payload: P(7) }),
    saveUploadDraft(pid, { revision: rev, baseHash: "h0", payload: P(8) }),
  ]);
  c.ok("two tabs saving on the same revision: exactly one lands, the other hears a conflict",
    racers.filter((r) => r.ok).length === 1 && racers.filter((r) => !r.ok && "conflict" in r).length === 1);
  rev = (await prisma.uploadDraft.findFirstOrThrow({ where: { projectId: pid } })).revision;

  // =======================================================================
  c.head("4 · somebody else's shoot, and a preview, are refused");
  await establishSession(james.id);
  const foreign = await saveUploadDraft(pid, { revision: null, baseHash: "h0", payload: P(1) });
  c.ok("another photographer is refused", !foreign.ok && "message" in foreign && /access/i.test(foreign.message), JSON.stringify(foreign));
  await setSession({ uid: owner.id, email: owner.email, role: "OWNER", actingAs: harrison.id });
  const preview = await saveUploadDraft(pid, { revision: null, baseHash: "h0", payload: P(1) });
  c.ok("an owner's 'view as' preview is refused", !preview.ok && "message" in preview && /preview/i.test(preview.message), JSON.stringify(preview));
  c.ok("neither wrote a row", (await prisma.uploadDraft.count({ where: { projectId: pid } })) === 1);

  // =======================================================================
  c.head("5 · clipped to the submit's caps; unknown topics dropped");
  await asHarrison();
  const big = await saveUploadDraft(pid, {
    revision: rev,
    baseHash: "h0",
    payload: {
      ...P(1),
      editorBrief: "x".repeat(10_000),
      removal: "y".repeat(9_000),
      extraRows: Array.from({ length: 20 }, (_, i) => ({ title: `Extra ${i}`, note: "n" })),
      filmedTopicIds: ["cltopicfake0000001", "not an id!"],
      topicNotes: { cltopicfake0000001: "note", "bad key!": "x" },
      vidSections: { vision: "v", "<script>": "no" },
      unknownField: "dropped",
    },
  });
  c.ok("the oversized draft still saves", big.ok);
  const stored = JSON.parse((await prisma.uploadDraft.findFirstOrThrow({ where: { projectId: pid } })).payloadJson);
  c.ok("editorBrief clipped to 6000, removal to 4000", stored.editorBrief.length === 6000 && stored.removal.length === 4000);
  c.ok("extras capped at 10", stored.extraRows.length === 10);
  c.ok("topic ids this job's session does not have are dropped (a listing shoot has none)", stored.filmedTopicIds.length === 0 && Object.keys(stored.topicNotes).length === 0);
  c.ok("unknown keys and section names are dropped", !("unknownField" in stored) && !("<script>" in stored.vidSections));
  if (big.ok) rev = big.revision;
  // Put a sensible draft back for the submit.
  const tidy = await saveUploadDraft(pid, { revision: rev, baseHash: "h0", payload: P(9) });
  if (tidy.ok) rev = tidy.revision;

  // =======================================================================
  c.head("6 · the submit consumes the draft");
  const submitted = await finalizeUpload(pid, {
    editorBrief: "Backlit exteriors — recover the sky",
    force: true,
    cullingConfirmed: true,
    shotOrder: { mode: "front-to-back" },
    removalNotes: "Trash cans in exterior 3",
    videoInstructions: "STYLE: Timeless & Elegant (Cinematic)\n\nCOLOR PROFILE: iPhone\n\nEDITING NOTES\nCalm and slow",
    scriptConfirm: null,
    sawScript: false,
  });
  c.ok("the whole-page submit lands", !!submitted.pdfPath && !submitted.blocked, JSON.stringify(submitted).slice(0, 160));
  const consumed = await prisma.uploadDraft.findFirstOrThrow({ where: { projectId: pid } });
  c.ok("the draft is consumed (consumedAt stamped), not deleted", !!consumed.consumedAt);
  const open = await prisma.uploadDraft.findFirst({ where: { projectId: pid, authorKey: "harrison-drafts@drill.invalid", consumedAt: null } });
  c.ok("a page reload would restore nothing (no open draft)", open === null);
  const reuse = await saveUploadDraft(pid, { revision: null, baseHash: "h0", payload: P(10) });
  c.ok("the next save on a fresh page reuses the same row, reopened", reuse.ok && (await prisma.uploadDraft.count({ where: { projectId: pid } })) === 1 && reuse.revision === consumed.revision + 1);
  const disc = await discardUploadDraft(pid);
  const discarded = await prisma.uploadDraft.findFirstOrThrow({ where: { projectId: pid } });
  c.ok("Discard retires the draft (consumed), the row is kept", disc.ok && !!discarded.consumedAt);

  // =======================================================================
  c.head("7 · a re-submit never writes over an edit it did not see");
  const loaded = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
  const h0 = draftLib.submittedFieldsHash({
    editorBrief: loaded.editorBrief, videoInstructions: loaded.videoInstructions, removalNotes: loaded.removalNotes,
    shotOrderNotes: loaded.shotOrderNotes, reelScript: loaded.reelScript, scriptConfirmNote: loaded.scriptConfirmNote, videosFilmed: loaded.videosFilmed,
  });
  // The office edits the brief from the Editing Room (the second writer).
  await setSession({ uid: owner.id, email: owner.email, role: "OWNER" });
  const officeEdit = await saveShootBriefFields(pid, { shootBrief: "Seller asked: lead with the pool" });
  c.ok("the Editing Room's brief editor saved", officeEdit.ok, officeEdit.message);
  await asHarrison();
  const conflict = await finalizeUpload(pid, {
    editorBrief: "My stale note from the open tab",
    force: true,
    cullingConfirmed: true,
    baseHash: h0,
  });
  c.ok("the re-submit is refused with a conflict", !!conflict.conflict && !conflict.pdfPath, JSON.stringify(conflict).slice(0, 160));
  c.ok("it says who changed it", conflict.conflict?.by === "Jordan Drill", conflict.conflict?.by ?? "null");
  c.ok("it carries what is there now", conflict.conflict?.current.editorBrief === "Seller asked: lead with the pool");
  const kept = await prisma.project.findUniqueOrThrow({ where: { id: pid }, select: { editorBrief: true } });
  c.ok("nothing was overwritten", kept.editorBrief === "Seller asked: lead with the pool");
  const changed = draftLib.changedSubmittedFields(
    { editorBrief: loaded.editorBrief, videoInstructions: loaded.videoInstructions, removalNotes: loaded.removalNotes, shotOrderNotes: loaded.shotOrderNotes, reelScript: loaded.reelScript, scriptConfirmNote: loaded.scriptConfirmNote, videosFilmed: loaded.videosFilmed },
    conflict.conflict!.current,
  );
  c.ok("the page can name the field that moved", changed.length === 1 && changed[0] === "the note for the editor", changed.join(", "));
  const onPurpose = await finalizeUpload(pid, { editorBrief: "My stale note from the open tab", force: true, cullingConfirmed: true, baseHash: conflict.conflict!.currentHash });
  c.ok("sent again against the new fingerprint, it lands on purpose", !!onPurpose.pdfPath && !onPurpose.conflict);
  c.ok("…and returns the next fingerprint for the page", typeof onPurpose.baseHash === "string" && onPurpose.baseHash !== conflict.conflict!.currentHash);
  const noHash = await finalizeUpload(pid, { editorBrief: "An older tab with no fingerprint", force: true, cullingConfirmed: true });
  c.ok("a pre-update tab (no fingerprint) is not refused", !!noHash.pdfPath && !noHash.conflict);

  // =======================================================================
  c.head("7b · (review, Sep 25) the second half, a restored draft and a first submit are checked too");
  const hashOf = (r: { editorBrief: string | null; videoInstructions: string | null; removalNotes: string | null; shotOrderNotes: string | null; reelScript: string | null; scriptConfirmNote: string | null; videosFilmed: number | null }) =>
    draftLib.submittedFieldsHash({
      editorBrief: r.editorBrief, videoInstructions: r.videoInstructions, removalNotes: r.removalNotes, shotOrderNotes: r.shotOrderNotes,
      reelScript: r.reelScript, scriptConfirmNote: r.scriptConfirmNote, videosFilmed: r.videosFilmed,
    });
  const splitJob = async (street: string) =>
    (await prisma.project.create({
      data: {
        title: `${street}, Emmaus, PA`, clientId: client.id, status: "SCHEDULED", shootDate: SHOOT, photographerId: harrisonTm.id, price: 410,
        deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }, { type: "VIDEO", label: "Listing Video", quantity: 1, videoStyle: "standard_cinematic" }] },
      },
      select: { id: true },
    })).id;
  const PHOTOS_HALF = { force: true, cullingConfirmed: true, shotOrder: { mode: "front-to-back" as const }, removalNotes: "Hose on the lawn", nothingToRemove: false };
  const VIDEO_HALF = { force: true, videoInstructions: "COLOR PROFILE: iPhone\n\nEDITING NOTES\nOpen on the island, then the pool", scriptConfirm: null, sawScript: false };
  const asOffice = () => setSession({ uid: owner.id, email: owner.email, role: "OWNER" });
  const sp = await splitJob("14 Split Draft Ln");
  await asHarrison();
  const loadedS = hashOf(await prisma.project.findUniqueOrThrow({ where: { id: sp } }));
  await saveUploadDraft(sp, { revision: null, baseHash: loadedS, payload: P(3) });
  const ph = await finalizeUpload(sp, { ...PHOTOS_HALF, editorBrief: "Evening note from the photos half", scope: "photos", baseHash: loadedS });
  c.ok("the photos half lands against the page's fingerprint", !!ph.pdfPath && !ph.conflict && typeof ph.baseHash === "string", JSON.stringify(ph).slice(0, 160));
  const dRow = await prisma.uploadDraft.findFirstOrThrow({ where: { projectId: sp } });
  c.ok("the open draft is re-based on what the photos half wrote (his own half never reads as somebody else's)", dRow.baseHash === ph.baseHash && !dRow.consumedAt);
  advanceMinutes(600); // 7:30 AM — Kyle's Editing Room edit between the halves
  await asOffice();
  const kyleEdit = await saveShootBriefFields(sp, { shootBrief: "Kyle: lead with the pool" });
  c.ok("(the Editing Room's brief editor saved between the halves)", kyleEdit.ok, kyleEdit.message);
  advanceMinutes(30);
  await asHarrison();
  const vh = await finalizeUpload(sp, { ...VIDEO_HALF, editorBrief: "Evening note from the photos half", scope: "video", baseHash: ph.baseHash! });
  c.ok("the video half, a FIRST submit of that half, is refused with a conflict (it used to skip the check)", !!vh.conflict && !vh.pdfPath, JSON.stringify(vh).slice(0, 160));
  c.ok("…naming the office's edit", vh.conflict?.by === "Jordan Drill" && vh.conflict?.current.editorBrief === "Kyle: lead with the pool", vh.conflict?.by ?? "null");
  c.ok("…and Kyle's words stand, the video half unstamped", await prisma.project.findUniqueOrThrow({ where: { id: sp } }).then((r) => r.editorBrief === "Kyle: lead with the pool" && !r.videoHandoffAt));
  // The same draft restored on a fresh page tomorrow: it submits with the
  // fingerprint IT was typed against, not the fresh page's.
  const restored = await prisma.uploadDraft.findFirstOrThrow({ where: { projectId: sp } });
  const vr = await finalizeUpload(sp, { ...VIDEO_HALF, editorBrief: "Evening note from the photos half", scope: "video", baseHash: restored.baseHash!, baseAtISO: restored.savedAt.toISOString() });
  c.ok("a restored draft submitted against its own fingerprint is refused too", !!vr.conflict && !vr.pdfPath);
  const freshPageHash = hashOf(await prisma.project.findUniqueOrThrow({ where: { id: sp } }));
  c.ok("(what the old page did: the FRESH fingerprint matches, which is how a stale draft slipped through)", freshPageHash === vr.conflict?.currentHash);
  const vok = await finalizeUpload(sp, { ...VIDEO_HALF, editorBrief: "Kyle: lead with the pool", scope: "video", baseHash: vr.conflict!.currentHash });
  c.ok("sent again on purpose against the new fingerprint, the video half lands and the wrap-up is whole", !!vok.pdfPath && vok.handoff?.wholeDone === true, JSON.stringify(vok.handoff));

  // A FIRST submit with a stale fingerprint (the page opened before Kyle's edit).
  const fp = await splitJob("15 First Submit Ct");
  const loadedF = hashOf(await prisma.project.findUniqueOrThrow({ where: { id: fp } }));
  await asOffice();
  await saveShootBriefFields(fp, { shootBrief: "Office: seller wants twilight first" });
  advanceMinutes(5);
  await asHarrison();
  const first = await finalizeUpload(fp, { ...PHOTOS_HALF, ...VIDEO_HALF, editorBrief: "My note", baseHash: loadedF });
  c.ok("a first whole-page submit from a page opened before the office's edit is refused, not written over it", !!first.conflict && (await prisma.project.findUniqueOrThrow({ where: { id: fp } })).editorBrief === "Office: seller wants twilight first");

  // A change nobody's line accounts for (Script Studio rewriting the script)
  // is "someone", not whoever last edited the page.
  // Timeline rows are stamped by the database's clock, not the drill's pinned
  // one, so "the page opened after the office's line" is read off that line.
  const officeLine = await prisma.activity.findFirstOrThrow({ where: { projectId: fp }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const pageOpened = new Date(officeLine.createdAt.getTime() + 1000).toISOString();
  advanceMinutes(2);
  await prisma.project.update({ where: { id: fp }, data: { reelScript: "Studio's new words" } });
  const nobody = await finalizeUpload(fp, { ...PHOTOS_HALF, ...VIDEO_HALF, editorBrief: "My note", baseHash: first.conflict!.currentHash, baseAtISO: pageOpened });
  c.ok("a change with no newer named line names nobody (the page says 'someone')", !!nobody.conflict && nobody.conflict.by === null, JSON.stringify(nobody.conflict?.by));

  // =======================================================================
  c.head("8 · the autosaver on a fake clock");
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
  const statuses: string[] = [];
  const plan: import("@/lib/uploadDraft").SaveOutcome[] = [];
  let calls = 0;
  const saver = draftLib.createAutosaver({
    timers,
    onStatus: (s) => statuses.push(s.kind),
    save: async () => { calls++; return plan.shift() ?? { ok: true, savedAtISO: "2026-09-23T21:31:00Z" }; },
  });
  saver.change();
  await advance(1199);
  c.ok("nothing saves inside the 1.2 s pause", calls === 0);
  await advance(1);
  c.ok("the pause ends → Saving… → Saved", calls === 1 && statuses.join(">") === "saving>saved", statuses.join(">"));
  statuses.length = 0;
  plan.push({ ok: false, message: "network" });
  saver.change();
  await advance(1200);
  c.ok("a failed save reads 'Unable to save' and schedules a retry", calls === 2 && statuses.join(">") === "saving>failed" && saver.status.kind === "failed");
  await advance(3000);
  c.ok("the retry lands → Saved", calls === 3 && saver.status.kind === "saved", statuses.join(">"));
  // Someone typing without pausing: one change every second for 12 seconds.
  const callsBefore = calls;
  for (let i = 0; i < 12; i++) { saver.change(); await advance(1000); }
  c.ok("typing without a pause is still saved within 10 s", calls > callsBefore && calls - callsBefore <= 2, `${calls - callsBefore} saves`);
  statuses.length = 0;
  plan.push({ ok: false, conflict: true });
  saver.change();
  await advance(1200);
  c.ok("a conflict stops the saver", saver.status.kind === "conflict");
  const callsAtConflict = calls;
  saver.change();
  await advance(5000);
  c.ok("…and nothing saves until the person chooses", calls === callsAtConflict);
  saver.resume();
  saver.change();
  await advance(1200);
  c.ok("after the choice, saving carries on", calls === callsAtConflict + 1 && saver.status.kind === "saved");
  saver.change();
  await saver.flush();
  c.ok("flush() saves immediately (tab hidden / back online)", calls === callsAtConflict + 2);

  c.head("9 · nothing left the building");
  c.ok("no outbound call was attempted outside the fence's knowledge", fence.blocked.every((u) => !/openphone|slack|gmail|aryeo\.com\/.*(orders|appointments)/i.test(u)), fence.blocked.slice(0, 5).join(", "));

  quiet.restore();
  fence.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
