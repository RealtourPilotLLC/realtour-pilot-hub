// ---------------------------------------------------------------------------
// DRILL oct23-wrong-file: the wrong-file guard on editor video uploads (Jordan,
// Oct 23 2026). At 10:06 PM ET an editor uploaded his old export
// "Done_859 N Lawrence St (Joseph Sutow).mov" (114,438,264 bytes) as version 1
// of the Premium reel on 538 Onward Ave; the same client's 859 N Lawrence St
// job had that exact file as its round 1 from Oct 22. User error, and the hub
// said nothing. Jordan said yes to a warning at upload and a flag for the
// reviewer.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-wrong-file.ts --logs <dir>
//
// Drives the SHIPPED code: lib/wrongCutFileCore (the pure check and its
// words), lib/wrongCutFile (the reader), app/review/actions (checkCutUploadFile
// and startCutUpload, real, signed in as the editor through the one seam every
// guard reads), lib/readyToSend, and the Review Room's page and panel source,
// against an isolated PGlite. Nothing leaves the process.
//
//   §1 the pure check: the 538/859 words exactly; the job's own street, unit,
//      town and client never count; a surname or a word is not a street
//   §2 at upload: the editor's check answers with the words before any bytes;
//      a normal file on its own job (and a job whose street is another job's
//      town, and the other way round) says nothing
//   §3 the server refuses the 859 file without "Upload anyway", reserves
//      nothing and writes nothing
//   §4 "Upload anyway": the reservation, and the timeline line (who, the
//      warning, the file)
//   §5 the reviewer's line for the version on screen, at view time; nothing on
//      the 859 version itself; the Ready to send row says it too
//   §6 the softer one: the same file as version 1 on this job
//   §7 never blocks: a failed or slow check uploads as today
//   §8 who sees it: previews, photographers and anonymous get nothing
//   §9 the screens: the page, the panel, the card and the uploader's source
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 4733);
const REPO = path.resolve(__dirname, "..", "..");
const src = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

// ---- the login, stubbed at the one seam every guard reads --------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
const login = (role: string, o: Partial<Viewer> = {}): Viewer => ({
  id: `u-${role}-${o.editorKey ?? "x"}`, email: `${role.toLowerCase()}@drill.invalid`, name: null, role, permissions: null, status: "ACTIVE",
  teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: null, ...o,
});
const JOHN = login("EDITOR", { name: "John Mark", editorKey: "john" });
let viewer: Viewer | null = JOHN;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);

// ---- the reader's first read, wrapped so §7 can make it fail or hang ----------
// Native import() snapshots a module's real exports, so the reader itself
// cannot be wrapped; its static Prisma import is the seam. Only the job read
// that carries the reader's own select (the zip AND the client's name) is
// touched, and only while §7 asks.
let readerMode: "real" | "throw" | "hang" = "real";
interceptModule((r) => r === "@/lib/prisma" || /[\\/]src[\\/]lib[\\/]prisma(\.ts)?$/.test(r), (loaded) => {
  const m = loaded as { prisma: Record<PropertyKey, unknown> };
  const bind = (value: unknown, self: object) => (typeof value === "function" ? value.bind(self) : value);
  const client = new Proxy(m.prisma, {
    get(t, key) {
      const value = Reflect.get(t, key, t);
      if (key !== "project") return bind(value, t);
      return new Proxy(value as Record<PropertyKey, unknown>, {
        get(d, method) {
          const fn = Reflect.get(d, method, d);
          if (method !== "findUnique") return bind(fn, d);
          return (args: { select?: { zip?: boolean; client?: unknown } }) => {
            const ours = !!args?.select?.zip && !!args?.select?.client;
            if (ours && readerMode === "throw") return Promise.reject(new Error("declared reader failure"));
            if (ours && readerMode === "hang") return new Promise(() => {});
            return (fn as (a: unknown) => Promise<unknown>).call(d, args);
          };
        },
      });
    },
  });
  return new Proxy(m as Record<PropertyKey, unknown>, { get: (t, k) => (k === "prisma" ? client : t[k]) });
});
installNextStubs();
const fence = fenceFetch();

const c = makeChecker();
const noDash = (s: string | null | undefined) => typeof s === "string" && !s.includes("—") && !s.includes("–");
const noId = (s: string, ids: string[]) => ids.every((id) => !s.includes(id));

// The two files of the night, byte for byte as the probe read them.
const WRONG = { name: "Done_859 N Lawrence St (Joseph Sutow).mov", size: 114_438_264 };
const RIGHT = { name: "Done_538 Onward Ave_Premium .mov", size: 266_879_825 };
const EDITOR_WORDS = "This looks like the file you uploaded for 859 N Lawrence St on Oct 22 (same name and size).";
const REVIEWER_WORDS = "Wrong file? The name says 859 N Lawrence St, and the same file was uploaded to 859 N Lawrence St on Oct 22.";

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct23-wrong-file-isolated" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const core = await import("@/lib/wrongCutFileCore");
  const reader = await import("@/lib/wrongCutFile");
  const review = await import("@/app/review/actions");
  const sc = await import("@/lib/selfCheck");
  const scs = await import("@/lib/selfCheckStore");
  const { cutSlots } = await import("@/lib/reviewCuts");
  const { readyToSend } = await import("@/lib/readyToSend");

  const as = async <T>(who: Viewer | null, fn: () => Promise<T>): Promise<T> => {
    process.env.AUTH_ENFORCE = "true";
    viewer = who;
    try { return await fn(); } finally { process.env.AUTH_ENFORCE = ""; viewer = JOHN; }
  };

  // ---- the jobs ----------------------------------------------------------------
  const sutow = await prisma.client.create({ data: { name: "Joseph Sutow" } });
  const other = await prisma.client.create({ data: { name: "Other Agent" } });
  const job = async (clientId: string, street: string, city: string, zip: string, label = "Premium Social Media Reel", quantity = 1) => {
    const p = await prisma.project.create({ data: { title: `${street}, ${city}, PA ${zip}`, addressLine: street, city, state: "PA", zip, clientId, status: "EDITING" } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label, quantity } });
    // John holds the job's open video work, as he did on 538 Onward Ave.
    await prisma.smartTask.create({ data: { projectId: p.id, taskType: "edit_video", title: "Edit the video", assignedKey: "john", assignedManually: true } });
    return { projectId: p.id, deliverableId: d.id };
  };
  const lawrence = await job(sutow.id, "859 N Lawrence St", "Philadelphia", "19123");
  const onward = await job(sutow.id, "538 Onward Ave", "Philadelphia", "19128", "Premium Social Media Reel", 3);
  // A job whose street is another job's town, and the other way round.
  const brynMawrAve = await job(other.id, "12 Bryn Mawr Ave", "Narberth", "19072");
  await job(other.id, "9 Lowrys Ln", "Bryn Mawr", "19010");
  const lancaster = await job(other.id, "10 Lancaster Ave", "Wayne", "19087");
  await job(other.id, "5 Wayne Ave", "Narberth", "19072");

  // 859 N Lawrence St's round 1, Oct 22, exactly as it is on file.
  const lawrenceV1 = await prisma.reviewSubmission.create({
    data: {
      projectId: lawrence.projectId, deliverableId: lawrence.deliverableId, slot: 1, round: 1, status: "CHANGES_REQUESTED", source: "upload",
      fileName: WRONG.name, sizeBytes: WRONG.size, submittedByKey: "john", submittedByName: "John Mark", createdAt: new Date("2026-10-22T19:21:21.738Z"),
    },
  });
  const ids = [lawrence.projectId, onward.projectId, lawrence.deliverableId, onward.deliverableId, lawrenceV1.id];

  const selfCheck = async (j: { projectId: string; deliverableId: string }, slot: number, file: { name: string; size: number }, round = 1) => {
    const ctx = await scs.checkContextForSlot(j.projectId, { deliverableId: j.deliverableId, slot }, { round });
    return {
      checklistKey: ctx.profile.checklistKey,
      answers: Object.fromEntries(sc.itemsFor(ctx.profile, { isRevision: ctx.isRevision, openIssueIds: ctx.issues.map((i) => i.id) }).map((i) => [i.key, { answer: "YES" as const }])),
      issues: { addressed: ctx.issues.map((i) => i.id), notAddressed: {} },
      watchedFile: { name: file.name, size: file.size },
    };
  };
  const ask = (j: { projectId: string; deliverableId: string }, slot: number, file: { name: string; size: number }) =>
    review.checkCutUploadFile({ ...j, slot, fileName: file.name, sizeBytes: file.size });
  const start = async (j: { projectId: string; deliverableId: string }, slot: number, file: { name: string; size: number }, extra: { wrongFileOverride?: boolean; round?: number } = {}) =>
    review.startCutUpload({ ...j, slot, fileName: file.name, sizeBytes: file.size, width: 1080, height: 1920, selfCheck: await selfCheck(j, slot, file, extra.round ?? 1), ...(extra.wrongFileOverride ? { wrongFileOverride: true } : {}) });
  const rowsOn = (projectId: string) => prisma.reviewSubmission.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  const timeline = async (projectId: string) => (await prisma.activity.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { body: true, authorId: true } })).map((a) => a.body);
  const slotLabel = (await cutSlots(onward.projectId)).find((s) => s.slot === 1)?.label ?? "";

  // =========================================================================
  c.head("§1 · the pure check and its words");
  // =========================================================================
  {
    const jobOf = (projectId: string, street: string, city: string, clientId: string, clientName: string) => ({ projectId, title: `${street}, ${city}, PA`, addressLine: street, city, state: "PA", zip: null, clientId, clientName });
    const J538 = jobOf("p538", "538 Onward Ave", "Philadelphia", "c1", "Joseph Sutow");
    const J859 = { ...jobOf("p859", "859 N Lawrence St", "Philadelphia", "c1", "Joseph Sutow"), at: new Date("2026-10-20T12:00:00Z") };
    const twin = { submissionId: "s859", projectId: "p859", job: { title: J859.title, addressLine: J859.addressLine }, deliverableId: "d859", slot: 1, round: 1, createdAt: new Date("2026-10-22T19:21:21Z"), byKey: "john", byName: "John Mark", how: "name-size" as const };
    const v = core.checkCutFile({ job: J538, file: WRONG, slot: { deliverableId: "d538", slot: 1 }, candidates: [J859], twins: [twin], uploader: { key: "john", name: "John Mark" } });
    c.ok("the 538/859 case is caught, as a strong warning", !!v && v.strong);
    c.ok(`the editor reads: "${EDITOR_WORDS}"`, v?.lines.join(" ") === EDITOR_WORDS, v?.lines.join(" | "));
    c.ok(`the reviewer reads: "${REVIEWER_WORDS}"`, v?.reviewerLine === REVIEWER_WORDS, v?.reviewerLine);
    c.ok("both of its hits: the name says 859 N Lawrence St, and the same name and size are on that job", v?.hits.some((h) => h.kind === "names-street" && h.street === "859 N Lawrence St") === true && v?.hits.some((h) => h.kind === "same-file-elsewhere") === true);
    c.ok("no em dashes, no ids, an ET date", !!v && [...v.lines, v.reviewerLine, ...v.record].every((s) => noDash(s) && noId(s, ["p538", "p859", "s859", "d538", "d859", "c1"]) && /Oct 22/.test(s)));
    const nameOnly = core.checkCutFile({ job: J538, file: WRONG, candidates: [J859], twins: [], uploader: null });
    c.ok("the name alone: \"The file name says 859 N Lawrence St, but this job is 538 Onward Ave.\"", nameOnly?.lines.join(" ") === "The file name says 859 N Lawrence St, but this job is 538 Onward Ave." && nameOnly.reviewerLine === "Wrong file? The name says 859 N Lawrence St, not 538 Onward Ave.", `${nameOnly?.lines.join(" ")} / ${nameOnly?.reviewerLine}`);
    const sizeOnly = core.checkCutFile({ job: J538, file: { name: "Final.mov", size: 99 }, candidates: [J859], twins: [{ ...twin, byKey: "kim", byName: "Kim Miguel" }], uploader: { key: "john", name: "John Mark" } });
    c.ok("the same file alone, somebody else's: \"...the file Kim uploaded for 859 N Lawrence St on Oct 22 (same name and size).\"", sizeOnly?.lines.join(" ") === "This looks like the file Kim uploaded for 859 N Lawrence St on Oct 22 (same name and size)." && sizeOnly.reviewerLine === "Wrong file? The same file was uploaded to 859 N Lawrence St on Oct 22 (same name and size).", `${sizeOnly?.lines.join(" ")} / ${sizeOnly?.reviewerLine}`);
    const nameBySameClient = core.checkCutFile({ job: J538, file: { name: "Lawrence reel v2.mov", size: 5 }, candidates: [J859], twins: [] });
    c.ok("the street name alone counts on the same client's other job", nameBySameClient?.hits[0]?.kind === "names-street");
    const nameByOtherClient = core.checkCutFile({ job: J538, file: { name: "Lawrence reel v2.mov", size: 5 }, candidates: [{ ...J859, clientId: "c2" }], twins: [] });
    c.ok("...but never on another client's job (a surname, a word): only with its house number", nameByOtherClient === null && core.checkCutFile({ job: J538, file: { name: "859 Lawrence reel.mov", size: 5 }, candidates: [{ ...J859, clientId: "c2" }], twins: [] })?.hits[0]?.kind === "names-street");
    const own = core.checkCutFile({ job: J538, file: RIGHT, candidates: [J859, { ...jobOf("p540", "540 Onward Ave", "Philadelphia", "c1", "Joseph Sutow"), at: null }], twins: [] });
    c.ok("the job's own street says nothing (and the next house's number is not this one's)", own === null);
    const town = core.checkCutFile({
      job: jobOf("pL", "10 Lancaster Ave", "Wayne", "c2", "Other Agent"), file: { name: "Done_10 Lancaster Ave Wayne (Other Agent).mov", size: 5 },
      candidates: [{ ...jobOf("pW", "5 Wayne Ave", "Narberth", "c2", "Other Agent"), at: null }], twins: [],
    });
    c.ok("the job's town is not another job's street (Wayne, PA vs 5 Wayne Ave)", town === null);
    const unit = core.checkCutFile({
      job: jobOf("pU", "235 Bloomfield Dr unit 110", "Lansdale", "c2", "Other Agent"), file: { name: "Rev_V2_235 Bloomfield Dr unit 110.mov", size: 5 },
      candidates: [{ ...jobOf("p110", "110 Oak Ln", "Ambler", "c2", "Other Agent"), at: null }], twins: [],
    });
    c.ok("the job's unit number is not another job's house number", unit === null);
    const client = core.checkCutFile({
      job: jobOf("pM", "919 Riverplace Dr", "Phoenixville", "c3", "Sharra Mercer"), file: { name: "Done_919 Riverplace Dr (Sharra Mercer).mov", size: 5 },
      candidates: [{ ...jobOf("pMS", "40 Mercer St", "Media", "c3", "Sharra Mercer"), at: null }], twins: [],
    });
    c.ok("the client's own name is not a street (Sharra Mercer vs 40 Mercer St, her own job)", client === null);
    const generic = core.checkCutFile({
      job: jobOf("pB", "99 Bridge St", "Phoenixville", "c4", "Builder Co"), file: { name: "The main reason buyers wait v1.mov", size: 5 },
      candidates: [{ ...jobOf("pMain", "415 Main St", "Schwenksville", "c4", "Builder Co"), at: null }], twins: [],
    });
    c.ok("an ordinary word is not a street (\"The main reason...\" vs 415 Main St)", generic === null);
    const videoNumber = core.checkCutFile({
      job: jobOf("pF", "46 Fayette St", "Conshohocken", "c5", "Paul Agent"), file: { name: "Done_Video 5 Raymond.mov", size: 5 },
      candidates: [{ ...jobOf("pR", "5 Raymond Cir", "Malvern", "c6", "Brie Martinez"), at: null }], twins: [],
    });
    c.ok("\"Video 5\" is not a house number", videoNumber === null);
    const first = core.checkCutFile({ job: J859, file: WRONG, candidates: [J538 as never], twins: [], uploader: null });
    c.ok("on its own job the 859 file says nothing", first === null);
    const takenBack = core.checkCutFile({
      job: jobOf("pUp", "308 W Upsal St", "Philadelphia", "c7", "Agent"), file: { name: "Revised_308 W Upsal_1_prob4.mp4", size: 260234173 },
      candidates: [], twins: [{ ...twin, projectId: "pCol", job: { title: "328 Columbia Ave, Ardmore, PA", addressLine: "328 Columbia Ave" } }],
    });
    c.ok("a file whose name says this job's street is this job's, whoever had it first (Sep 16, 308 W Upsal St)", takenBack === null);
    c.ok("withinMs: a slow answer is no answer, fast", (await reader.withinMs(new Promise(() => {}), 20)) === null && (await reader.withinMs(Promise.reject(new Error("x")), 20)) === null && (await reader.withinMs(Promise.resolve(7), 20)) === 7);
  }

  // =========================================================================
  c.head("§2 · at upload, before any bytes");
  // =========================================================================
  {
    const warn = await as(JOHN, () => ask(onward, 1, WRONG));
    c.ok(`John picks the 859 file on 538 Onward Ave: "${EDITOR_WORDS}"`, warn?.lines.join(" ") === EDITOR_WORDS && warn.strong === true, JSON.stringify(warn));
    c.ok("asking reserved nothing and wrote nothing", (await rowsOn(onward.projectId)).length === 0 && (await timeline(onward.projectId)).length === 0);
    c.ok("the right file on its own job: nothing to say", (await as(JOHN, () => ask(onward, 2, RIGHT))) === null);
    c.ok("12 Bryn Mawr Ave (another job's town is Bryn Mawr): nothing to say", (await as(JOHN, () => ask(brynMawrAve, 1, { name: "Done_12 Bryn Mawr Ave (Other Agent).mov", size: 112_000_000 }))) === null);
    c.ok("10 Lancaster Ave, Wayne (another job is 5 Wayne Ave): nothing to say", (await as(JOHN, () => ask(lancaster, 1, { name: "Done_10 Lancaster Ave Wayne (Other Agent).mov", size: 98_000_000 }))) === null);
  }

  // =========================================================================
  c.head("§3 · the server refuses without \"Upload anyway\"");
  // =========================================================================
  {
    const r = await as(JOHN, () => start(onward, 1, WRONG));
    c.ok("startCutUpload refuses the 859 file", !r.ok);
    c.ok("...with the words and the two-button card's data", !r.ok && "wrongFile" in r && r.wrongFile?.lines.join(" ") === EDITOR_WORDS && r.wrongFile.strong === true && r.message.startsWith(EDITOR_WORDS), r.ok ? "" : r.message);
    c.ok("nothing reserved, nothing on the timeline", (await rowsOn(onward.projectId)).length === 0 && (await timeline(onward.projectId)).length === 0);
  }

  // =========================================================================
  c.head("§4 · \"Upload anyway\"");
  // =========================================================================
  let wrongVersion = "";
  {
    const r = await as(JOHN, () => start(onward, 1, WRONG, { wrongFileOverride: true }));
    c.ok("with the override the upload is reserved as version 1", r.ok && r.round === 1, r.ok ? "" : r.message);
    if (r.ok) wrongVersion = r.submissionId;
    const lines = await timeline(onward.projectId);
    const expected = `John Mark pressed Upload anyway for ${WRONG.name} (${slotLabel.replace(/\s*[–—]\s*/g, ", ")}, version 1). The hub had warned: This looks like the file John uploaded for 859 N Lawrence St on Oct 22 (same name and size).`;
    c.ok("the job's timeline says who, the warning and the file", lines.includes(expected), lines.join(" | "));
    c.ok("...in plain words: no em dash, no id", lines.filter((l) => /Upload anyway/.test(l)).every((l) => noDash(l) && noId(l, ids)));
    c.ok("one line, on 538 Onward Ave only (859 N Lawrence St's timeline untouched)", lines.filter((l) => /Upload anyway/.test(l)).length === 1 && (await timeline(lawrence.projectId)).length === 0);
    // A different file afterwards is asked again: the "anyway" was for that file.
    const again = await as(JOHN, () => ask(onward, 2, WRONG));
    c.ok("the next time the same file is picked (another video), it is asked again", again?.lines.join(" ") === EDITOR_WORDS);
  }

  // =========================================================================
  c.head("§5 · the reviewer's line, at view time");
  // =========================================================================
  {
    // The bytes landed and the version entered review (the finish, as a row).
    await prisma.reviewSubmission.update({ where: { id: wrongVersion }, data: { status: "PENDING", blobUrl: `https://drillstore.public.blob.vercel-storage.com/review-cuts/${onward.projectId}/${wrongVersion}/x.mov`, blobPathname: `review-cuts/${onward.projectId}/${wrongVersion}/x.mov` } });
    const seen = await reader.wrongFileForSubmissions([wrongVersion, lawrenceV1.id]);
    c.ok(`the 538 Onward version: "${REVIEWER_WORDS}"`, seen.get(wrongVersion)?.reviewerLine === REVIEWER_WORDS && seen.get(wrongVersion)?.strong === true, seen.get(wrongVersion)?.reviewerLine);
    c.ok("the 859 N Lawrence St version itself: nothing (its own street, and it had the file first)", !seen.has(lawrenceV1.id));
    // A version uploaded before the guard existed (no override, straight in):
    // the line is computed when it is viewed, so it is flagged all the same.
    const legacy = await prisma.reviewSubmission.create({ data: { projectId: onward.projectId, deliverableId: onward.deliverableId, slot: 3, round: 1, status: "PENDING", source: "upload", fileName: WRONG.name, sizeBytes: WRONG.size, submittedByKey: "john", submittedByName: "John Mark" } });
    c.ok("a version that went up before the guard is flagged when viewed", (await reader.wrongFileForSubmissions([legacy.id])).get(legacy.id)?.reviewerLine === REVIEWER_WORDS);
    await prisma.reviewSubmission.delete({ where: { id: legacy.id } });
    // Approved and waiting to go out: the Ready to send row says it too.
    await prisma.reviewSubmission.update({ where: { id: wrongVersion }, data: { status: "APPROVED", decidedAt: new Date(), decidedBy: "James Drill" } });
    const board = await readyToSend({ projectId: onward.projectId });
    const row = board.ready.find((v) => v.submissionId === wrongVersion);
    c.ok("the Ready to send row carries the same line", row?.wrongFile === REVIEWER_WORDS, row ? String(row.wrongFile) : `no row (${board.ready.length} ready, ${board.rendering.length} rendering)`);
    await prisma.reviewSubmission.update({ where: { id: wrongVersion }, data: { status: "PENDING", decidedAt: null, decidedBy: null } });
  }

  // =========================================================================
  c.head("§6 · the softer one: the same file as version 1");
  // =========================================================================
  {
    const v1File = { name: "Done_12 Bryn Mawr Ave (Other Agent).mov", size: 112_000_000 };
    const v1 = await as(JOHN, () => start(brynMawrAve, 1, v1File));
    c.ok("a normal file on its own job is reserved, no warning (12 Bryn Mawr Ave)", v1.ok, v1.ok ? "" : v1.message);
    const lanc = await as(JOHN, () => start(lancaster, 1, { name: "Done_10 Lancaster Ave Wayne (Other Agent).mov", size: 98_000_000 }));
    c.ok("...and on 10 Lancaster Ave, Wayne", lanc.ok, lanc.ok ? "" : lanc.message);
    const right = await as(JOHN, () => start(onward, 2, RIGHT));
    c.ok("...and the right file on 538 Onward Ave", right.ok, right.ok ? "" : right.message);
    if (v1.ok) await prisma.reviewSubmission.update({ where: { id: v1.submissionId }, data: { status: "CHANGES_REQUESTED", decidedAt: new Date() } });
    const soft = await as(JOHN, () => ask(brynMawrAve, 1, v1File));
    c.ok("the same export again after changes: \"This looks like the same file as version 1 (same name and size).\"", soft?.lines.join(" ") === "This looks like the same file as version 1 (same name and size)." && soft.strong === false, JSON.stringify(soft));
    const refused = await as(JOHN, () => start(brynMawrAve, 1, v1File, { round: 2 }));
    c.ok("...the server asks the same question (refused without the anyway)", !refused.ok && "wrongFile" in refused && refused.wrongFile?.strong === false, refused.ok ? "" : refused.message);
    const anyway = await as(JOHN, () => start(brynMawrAve, 1, v1File, { round: 2, wrongFileOverride: true }));
    c.ok("...and \"Upload anyway\" sends it as version 2", anyway.ok && anyway.round === 2, anyway.ok ? "" : anyway.message);
    if (anyway.ok) {
      await prisma.reviewSubmission.update({ where: { id: anyway.submissionId }, data: { status: "PENDING" } });
      const line = (await reader.wrongFileForSubmissions([anyway.submissionId])).get(anyway.submissionId);
      c.ok("the reviewer's softer line: \"Same file again? This version has the same name and size as version 1 (...)\"", !!line && !line.strong && /^Same file again\? This version has the same name and size as version 1 \([A-Z][a-z]{2} \d{1,2}\)\.$/.test(line.reviewerLine), line?.reviewerLine);
    }
  }

  // =========================================================================
  c.head("§7 · never blocks");
  // =========================================================================
  {
    readerMode = "throw";
    c.ok("a check that fails: the panel's question answers nothing", (await as(JOHN, () => ask(onward, 3, WRONG))) === null);
    const failed = await as(JOHN, () => start(onward, 3, WRONG));
    c.ok("...and the upload goes as today", failed.ok, failed.ok ? "" : failed.message);
    if (failed.ok) await prisma.reviewSubmission.delete({ where: { id: failed.submissionId } });
    readerMode = "hang";
    const t0 = Date.now();
    const slow = await as(JOHN, () => start(onward, 3, WRONG));
    const took = Date.now() - t0;
    c.ok("a check that hangs: the upload goes ahead after a few seconds", slow.ok && took < 8_000, `${took} ms`);
    if (slow.ok) await prisma.reviewSubmission.delete({ where: { id: slow.submissionId } });
    readerMode = "real";
    c.ok("no override line for an upload the check never saw", (await timeline(onward.projectId)).filter((l) => /Upload anyway/.test(l)).length === 1);
  }

  // =========================================================================
  c.head("§8 · who gets an answer");
  // =========================================================================
  {
    const preview = login("OWNER", { name: "Jordan Drill", impersonating: true, realRole: "OWNER" });
    c.ok("a preview (view as) gets nothing, and writes nothing", (await as(preview, () => ask(onward, 3, WRONG))) === null && !(await as(preview, () => start(onward, 3, WRONG, { wrongFileOverride: true }))).ok);
    c.ok("a photographer gets nothing", (await as(login("PHOTOGRAPHER", { name: "Harrison Drill" }), () => ask(onward, 3, WRONG))) === null);
    c.ok("signed out gets nothing", (await as(null, () => ask(onward, 3, WRONG))) === null);
    c.ok("an editor with no work on the job gets nothing", (await as(login("EDITOR", { name: "Kim Miguel", editorKey: "kim" }), () => ask(onward, 3, WRONG))) === null);
    const owner = await as(login("OWNER", { name: "Jordan Drill" }), () => ask(onward, 3, WRONG));
    c.ok("the owner uploading for an editor reads whose file it was: \"...the file John uploaded...\"", owner?.lines.join(" ") === "This looks like the file John uploaded for 859 N Lawrence St on Oct 22 (same name and size).", JSON.stringify(owner));
    c.ok("the previews wrote no timeline line", (await timeline(onward.projectId)).filter((l) => /Upload anyway/.test(l)).length === 1);
  }

  // =========================================================================
  c.head("§9 · the screens (the shipped source)");
  // =========================================================================
  {
    const page = src("src/app/review/[id]/page.tsx");
    const panel = src("src/components/review/CutReviewPanel.tsx");
    const card = src("src/components/ops/ReadyToSendCard.tsx");
    const uploader = src("src/components/editing/CutUploader.tsx");
    const actions = src("src/app/review/actions.ts");
    c.ok("the Review Room computes it for the version on screen, the desk only", /wrongFileForSubmissions\(\[active\.id\]\)/.test(page) && /active && !shotThis && \(active\.status === "PENDING" \|\| active\.status === "APPROVED"\)/.test(page) && /wrongFile=\{wrongFile \? \{ line: wrongFile\.reviewerLine, strong: wrongFile\.strong \} : null\}/.test(page));
    c.ok("the panel draws the line above the verdict with \"Wrong video?\" beside it", /data-wrong-file[\s\S]{0,900}<CutTakeBack info=\{takeBack\}/.test(panel) && panel.indexOf("data-wrong-file") < panel.indexOf("Note + verdict bar"));
    c.ok("...one \"Wrong video?\" on screen (the bar's stands down while the line shows)", /canDecide && takeBack && !wrongFile && <CutTakeBack/.test(panel));
    c.ok("Approve and Approve and send are untouched by it", !/disabled=\{[^}]*wrongFile/.test(panel) && !/wrongFile/.test(src("src/app/review/sendWhenReadyActions.ts")));
    c.ok("the Ready to send row draws it, with the way to the Review Room", /v\.wrongFile && \([\s\S]{0,400}data-wrong-file[\s\S]{0,500}href=\{v\.reviewHref\}/.test(card));
    c.ok("the uploader asks before the bytes and holds the file on two buttons", /askWrongFile\(cut, file\)/.test(uploader) && /Choose another file/.test(uploader) && /Upload anyway/.test(uploader) && /wrongFileOverride: true/.test(uploader));
    c.ok("the registration re-runs the check and refuses without the override", /wrongFile && input\.wrongFileOverride !== true/.test(actions) && /overrideTimelineLine/.test(actions));
  }

  c.head("Z · isolation");
  c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
