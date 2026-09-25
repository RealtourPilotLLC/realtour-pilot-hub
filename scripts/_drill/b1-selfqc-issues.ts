// ---------------------------------------------------------------------------
// DRILL: §8.2 editor self-QC, §8.3 revision issues, §8.4 editor KPIs
// (unified handoff batch 1, Sep 25 2026 — O07, A34, A36, A37, A38).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b1-selfqc-issues.ts
//
//   0  THE OLD CODE, pinned to 75d56f1 and loaded from git: an upload with no
//      check is reserved and announced, a folder cut the sweep finds is rung
//      and approvable, nothing records a cause.
//   A  every door into review needs a check bound to the exact bytes:
//      (a) no check → nothing reserved   (b) check → one entry, one announce,
//      also when finish and the store callback race   (c) different bytes →
//      held, VOID, no announce   (d) the Final-folder button asks first and
//      binds Dropbox's content_hash   (e/f) a swept cut is held, off the board,
//      unapprovable, released once   (g) an in-place re-export voids the check
//      (h) a move voids it   (i) a restored round keeps its own   (j) the
//      queue's Completed relays the check   (k) a pre-gate row stays approvable
//      (l) the office's check on an editor's behalf is recorded as such
//   B  issues: idempotent ingestion from notes and briefs, portal addenda,
//      addressed on v2 → verified at approval, unverified approval refused,
//      missed-in stamping, reassignment Kim→John, re-analysis lock, merge,
//      the legacy toggle mirror; ContentRevisionRound untouched
//   C  KPIs: pending/unclassified excluded, CLIENT_CHANGE ≠ EDITOR_ERROR and a
//      reclassification re-scores, duplicates once, a new ask is not a missed
//      one, review waiting split James→Kyle on a PINNED Friday→Monday clock,
//      blocked time "not recorded", thin samples labelled; kpi.ts and qc.ts
//      produce identical output before and after.
//
// ISOLATION: PGlite on 127.0.0.1:5603 via the shared harness; production is
// never opened; Dropbox, the model and the signed-in user are fakes; every
// other outbound call is fenced and counted.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5603);
const REPO = path.resolve(__dirname, "../..");
const BASE = "75d56f1"; // pinned: the tree batch 1 starts from, never HEAD

installNextStubs();
const fence = fenceFetch();

// ---- fakes -----------------------------------------------------------------
type DbxFile = { size: number; hash: string; modified: Date };
const dbxFiles = new Map<string, DbxFile>();
let dbxDown = false;
let dbxCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/dropbox" || r.endsWith("/integrations/dropbox"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "dbx") return t[k];
      return async (endpoint: string, arg?: { path?: string; cursor?: string }) => {
        dbxCalls++;
        if (dbxDown) throw new Error("drill: dropbox down");
        if (endpoint === "files/list_folder") {
          const root = (arg?.path ?? "").toLowerCase();
          const entries = [...dbxFiles.entries()]
            .filter(([p]) => p.toLowerCase().startsWith(`${root}/`))
            .map(([p, f]) => ({ ".tag": "file", name: p.split("/").pop(), path_display: p, server_modified: f.modified.toISOString(), size: f.size, content_hash: f.hash, rev: `rev-${f.hash}` }));
          return { entries, has_more: false };
        }
        if (endpoint === "files/get_metadata") {
          const f = dbxFiles.get(arg?.path ?? "");
          if (!f) throw new Error("drill: path/not_found");
          return { size: f.size, content_hash: f.hash, rev: `rev-${f.hash}` };
        }
        throw new Error(`drill: dbx ${endpoint} not faked`);
      };
    },
  }),
);

let aiCalls = 0;
let aiItems: { area: string; ask: string; detail: string; quote: string; scope: string; videos: string[] }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson") return t[k];
      return async () => {
        aiCalls++;
        return { headline: "Drill ask", items: aiItems, keep: [], references: [], questions: [] };
      };
    },
  }),
);

type FakeUser = { id: string; email: string; name: string; role: string; realRole: string; editorKey: string | null; teamMemberId: string | null; impersonating: boolean; permissions: null; status: string; notificationsSeenAt: null; realName: string };
let currentUser: FakeUser | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r.endsWith("/lib/auth/user"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "getCurrentUser") return async () => currentUser;
      return t[k];
    },
  }),
);
const asEditor = (key: string, name: string): FakeUser => ({ id: `u-${key}`, email: `${key}@drill.invalid`, name, role: "EDITOR", realRole: "EDITOR", editorKey: key, teamMemberId: null, impersonating: false, permissions: null, status: "ACTIVE", notificationsSeenAt: null, realName: name });

/** 75d56f1's copies, their `@/` imports aimed at this tree. */
function writeBaseCopies(): { dir: string; reviewCuts: string; actions: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b1-selfqc-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out = (name: string, f: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, point(show(f)));
    return p;
  };
  return { dir, reviewCuts: out("reviewCuts.base.ts", "src/lib/reviewCuts.ts"), actions: out("reviewActions.base.ts", "src/app/review/actions.ts") };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const actions = await import("@/app/review/actions");
  const sca = await import("@/app/review/selfCheckActions");
  const ia = await import("@/app/review/issueActions");
  const rc = await import("@/lib/reviewCuts");
  const sc = await import("@/lib/selfCheck");
  const scs = await import("@/lib/selfCheckStore");
  const ri = await import("@/lib/revisionIssues");
  const eq = await import("@/lib/editorQuality");
  const rb = await import("@/lib/revisionBrief");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { getQcStats } = await import("@/lib/qc");
  const { scoreQuarterRoster } = await import("@/lib/kpi");
  const baseFiles = writeBaseCopies();
  const base = {
    rc: (await import(baseFiles.reviewCuts)) as typeof rc,
    actions: (await import(baseFiles.actions)) as typeof actions,
  };

  // Pinned clock for the §8.4 time arithmetic: Friday Sep 25 2026, ET (EDT).
  const ET = (month: number, day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, month - 1, day, hour + 4, minute));
  const NOW = ET(9, 30, 12); // Wednesday Sep 30, noon ET

  // KPI / QC SNAPSHOT BEFORE anything below writes an issue (O07: they must
  // not move — kpi.ts is photographer money, qc.ts is Kyle's dial). Seeded so
  // the snapshot has something in it: a paid photographer with a shoot, and a
  // QC record on it.
  {
    const shooter = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-drill@example.com", role: "PHOTOGRAPHER", payPercent: 30 }, select: { id: true } });
    const cl = await prisma.client.create({ data: { name: "QC Client" }, select: { id: true } });
    const pj = await prisma.project.create({ data: { clientId: cl.id, title: "1 QC Way, Drill PA", status: "DELIVERED", photographerId: shooter.id, shootDate: new Date(Date.now() - 5 * 86_400_000), deliveredAt: new Date(Date.now() - 4 * 86_400_000) }, select: { id: true } });
    await prisma.qcRecord.create({ data: { projectId: pj.id, itemsChecked: JSON.stringify([{ label: "Sky swap", done: true }]), missCount: 0, completedAt: new Date(Date.now() - 4 * 86_400_000) } });
  }
  const kpiBefore = JSON.stringify(await scoreQuarterRoster(undefined, NOW));
  const qcBefore = JSON.stringify(await getQcStats(30));

  // ---- the world --------------------------------------------------------------
  let seq = 0;
  const mkJob = async (title: string, o: { videos?: number; style?: string; status?: string; editor?: string } = {}) => {
    const client = await prisma.client.create({ data: { name: `${title} Client` }, select: { id: true } });
    const dropboxFolder = `/Drill/${title.replace(/\s+/g, "-")}-${++seq}`;
    const project = await prisma.project.create({
      data: { clientId: client.id, title: `${title}, Drill PA`, status: (o.status ?? "EDITING") as never, dropboxFolder },
      select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true },
    });
    const d = await prisma.deliverable.create({
      data: { projectId: project.id, type: "VIDEO", label: "Standard Reel", productTitle: "Standard Reel", videoStyle: o.style ?? "standard_reel", quantity: o.videos ?? 1 },
      select: { id: true },
    });
    await prisma.smartTask.create({ data: { projectId: project.id, taskType: "edit_video", title: `Edit video — ${title}`, status: "OPEN", assignedKey: o.editor ?? "kim", dedupeKey: `edit-video-${project.id}` } });
    const folder = actualFolderPaths({ ...project, client: { name: `${title} Client` } } as never).finalVideo;
    return { projectId: project.id, deliverableId: d.id, folder };
  };
  const notes = (prefix: string) => prisma.notification.count({ where: { dedupeKey: { startsWith: prefix } } });
  const sub = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });
  const checkOf = async (id: string) => {
    const s = await sub(id);
    return s.selfCheckId ? prisma.cutSelfCheck.findUnique({ where: { id: s.selfCheckId } }) : null;
  };
  /** A complete, honest check for this slot's list — the dialog's output. */
  const answerFor = async (projectId: string, slot: { deliverableId: string | null; slot: number | null; assetPath?: string | null }, file: { name: string; size?: number | null }, o: { round?: number; addressed?: string[]; notAddressed?: Record<string, string> } = {}) => {
    const ctx = await scs.checkContextForSlot(projectId, slot, { round: o.round ?? 1 });
    const asked = sc.itemsFor(ctx.profile, { isRevision: ctx.isRevision, openIssueIds: ctx.issues.map((i) => i.id) });
    const answers = Object.fromEntries(asked.map((it) => [it.key, { answer: "YES" as const }]));
    const declared = new Set([...(o.addressed ?? []), ...Object.keys(o.notAddressed ?? {})]);
    const addressed = [...(o.addressed ?? []), ...ctx.issues.map((i) => i.id).filter((id) => !declared.has(id))];
    return { checklistKey: ctx.profile.checklistKey, answers, issues: { addressed, notAddressed: o.notAddressed ?? {} }, watchedFile: { name: file.name, size: file.size ?? null } } satisfies import("@/lib/selfCheck").SelfCheckInput;
  };
  const blobFor = (projectId: string, id: string, name: string) => ({
    url: `https://drillstore.public.blob.vercel-storage.com/review-cuts/${projectId}/${id}/${name.replace(/\.mp4$/, "")}-Ab12Cd.mp4`,
    pathname: `review-cuts/${projectId}/${id}/${name.replace(/\.mp4$/, "")}-Ab12Cd.mp4`,
  });
  /** The whole upload door: reserve with a check, land the bytes, finalize. */
  const upload = async (job: { projectId: string; deliverableId: string }, name: string, size: number, o: { landedSize?: number; addressed?: string[]; notAddressed?: Record<string, string>; round?: number } = {}) => {
    const check = await answerFor(job.projectId, { deliverableId: job.deliverableId, slot: 1 }, { name, size }, o);
    const started = await actions.startCutUpload({ projectId: job.projectId, deliverableId: job.deliverableId, slot: 1, fileName: name, sizeBytes: size, width: 1080, height: 1920, selfCheck: check });
    if (!started.ok) throw new Error(`start ${name}: ${started.message}`);
    const b = blobFor(job.projectId, started.submissionId, name);
    const fin = await rc.finalizeCutUpload(started.submissionId, { ...b, size: o.landedSize ?? size });
    return { id: started.submissionId, fin };
  };

  // =============================================================================
  c.head("0 · THE OLD CODE (75d56f1): no check anywhere, the sweep rings, nothing records why");
  {
    const job = await mkJob("Old Upload St");
    const started = await base.actions.startCutUpload({ projectId: job.projectId, deliverableId: job.deliverableId, slot: 1, fileName: "old.mp4", sizeBytes: 100, width: 1080, height: 1920 });
    c.ok("OLD: an upload with NO check is reserved", started.ok === true);
    if (started.ok) {
      const b = blobFor(job.projectId, started.submissionId, "old.mp4");
      await base.rc.finalizeCutUpload(started.submissionId, { ...b, size: 999 });
      const s = await sub(started.submissionId);
      c.ok("OLD: …and enters review whatever bytes arrived", s.status === "PENDING", s.status);
      c.ok("OLD: …and is announced", (await notes(`cut-in-review-${started.submissionId}`)) >= 1);
      const ap = await base.actions.approveCut(started.submissionId);
      c.ok("OLD: …and is approvable — nobody attested to anything", ap.ok === true, ap.message);
    }
    const swept = await mkJob("Old Sweep Rd");
    dbxFiles.set(`${swept.folder}/sweep-old.mp4`, { size: 10, hash: "h-old", modified: new Date() });
    const found = await base.rc.discoverCutsForReview(swept.projectId, "Old Sweep Rd");
    const row = await prisma.reviewSubmission.findFirst({ where: { projectId: swept.projectId } });
    c.ok("OLD: the folder sweep enters a cut and rings the desk", found === 1 && !!row && (await notes(`cut-in-review-${row.id}`)) >= 1);
    c.ok("OLD: no issue ledger — nothing records a cause", (await prisma.revisionIssue.count()) === 0);
  }

  // =============================================================================
  c.head("A · every door needs a check bound to the exact bytes (§8.2 / A34)");
  const J = await mkJob("100 Check Ln");
  {
    // (a)
    const before = await prisma.reviewSubmission.count({ where: { projectId: J.projectId } });
    const none = await actions.startCutUpload({ projectId: J.projectId, deliverableId: J.deliverableId, slot: 1, fileName: "v1.mp4", sizeBytes: 500 });
    c.ok("(a) no check → refused, asks for the check", !none.ok && "needsSelfCheck" in none && none.needsSelfCheck === true, none.ok ? "" : none.message);
    const partial = await answerFor(J.projectId, { deliverableId: J.deliverableId, slot: 1 }, { name: "v1.mp4", size: 500 });
    delete (partial.answers as Record<string, unknown>).export_upload;
    const half = await actions.startCutUpload({ projectId: J.projectId, deliverableId: J.deliverableId, slot: 1, fileName: "v1.mp4", sizeBytes: 500, selfCheck: partial });
    c.ok("(a) a half-ticked list → refused", !half.ok);
    const wrongFile = await answerFor(J.projectId, { deliverableId: J.deliverableId, slot: 1 }, { name: "other.mp4", size: 500 });
    const wf = await actions.startCutUpload({ projectId: J.projectId, deliverableId: J.deliverableId, slot: 1, fileName: "v1.mp4", sizeBytes: 500, selfCheck: wrongFile });
    c.ok("(a) a check for a different file → refused", !wf.ok);
    const na = await answerFor(J.projectId, { deliverableId: J.deliverableId, slot: 1 }, { name: "v1.mp4", size: 500 });
    (na.answers as Record<string, unknown>).captions_text = { answer: "NA", reason: "no" };
    const shortNa = await actions.startCutUpload({ projectId: J.projectId, deliverableId: J.deliverableId, slot: 1, fileName: "v1.mp4", sizeBytes: 500, selfCheck: na });
    c.ok("(a) Not applicable without a real reason → refused", !shortNa.ok);
    c.ok("(a) …and not one row was reserved by any refusal", (await prisma.reviewSubmission.count({ where: { projectId: J.projectId } })) === before);
  }
  let v1 = "";
  {
    // (b) a valid check; finish and the store callback race
    const check = await answerFor(J.projectId, { deliverableId: J.deliverableId, slot: 1 }, { name: "v1.mp4", size: 500 });
    (check.answers as Record<string, unknown>).captions_text = { answer: "NA", reason: "There are no captions in this reel." };
    currentUser = asEditor("kim", "Kim"); // Kim's own upload, on her own card
    const started = await actions.startCutUpload({ projectId: J.projectId, deliverableId: J.deliverableId, slot: 1, fileName: "v1.mp4", sizeBytes: 500, selfCheck: check });
    currentUser = null;
    c.ok("(b) a complete check reserves the upload", started.ok === true);
    if (!started.ok) throw new Error(started.message);
    v1 = started.submissionId;
    const pend = await checkOf(v1);
    c.ok("(b) …with its check written in the same reservation, waiting on the bytes", pend?.state === "PENDING_BYTES" && pend.attestedSize === 500 && pend.attestedFileName === "v1.mp4" && pend.editorKey === "kim" && !pend.onBehalfOf);
    const b = blobFor(J.projectId, v1, "v1.mp4");
    const [r1, r2] = await Promise.all([rc.finalizeCutUpload(v1, { ...b, size: 500 }), rc.finalizeCutUpload(v1, { ...b, size: 500 })]);
    const s = await sub(v1);
    c.ok("(b) finish + callback racing: in review once", s.status === "PENDING" && !!s.selfCheckedAt && (r1.ok || r2.ok));
    c.ok("(b) …one announcement", (await notes(`cut-in-review-${v1}`)) === 1, String(await notes(`cut-in-review-${v1}`)));
    const bound = await checkOf(v1);
    c.ok("(b) …the check is VALID and names these bytes", bound?.state === "VALID" && !!bound.fileIdentity && bound.sourceRev === `blob:${b.pathname}`);
    c.ok("(b) …the N/A carries its reason", JSON.parse(bound!.itemsJson).some((i: { key: string; answer: string; reason: string }) => i.key === "captions_text" && i.answer === "NA" && i.reason.length >= 8));
    const p = await prisma.project.findUniqueOrThrow({ where: { id: J.projectId } });
    c.ok("(b) …the job moved to REVIEW", p.status === "REVIEW", p.status);
  }
  {
    // The store's callback carries no size; when the store can't be read the
    // check waits, and the browser's finish (with the size) binds it.
    const job = await mkJob("101 Callback Ct");
    const check = await answerFor(job.projectId, { deliverableId: job.deliverableId, slot: 1 }, { name: "cb.mp4", size: 77 });
    const started = await actions.startCutUpload({ projectId: job.projectId, deliverableId: job.deliverableId, slot: 1, fileName: "cb.mp4", sizeBytes: 77, selfCheck: check });
    if (!started.ok) throw new Error(started.message);
    const b = blobFor(job.projectId, started.submissionId, "cb.mp4");
    const cb = await rc.finalizeCutUpload(started.submissionId, { url: b.url, pathname: b.pathname });
    c.ok("(b) the session-less callback with no size (store unreadable) holds the cut", !cb.ok && cb.held === true && sc.isHeldForSelfCheck(await sub(started.submissionId)));
    c.ok("(b) …not announced yet", (await notes(`cut-in-review-${started.submissionId}`)) === 0);
    const fin = await rc.finalizeCutUpload(started.submissionId, { ...b, size: 77 });
    c.ok("(b) the browser's finish, with the size, binds and enters it", fin.ok && !!(await sub(started.submissionId)).selfCheckedAt, fin.message);
    c.ok("(b) …announced exactly once", (await notes(`cut-in-review-${started.submissionId}`)) === 1);
  }
  {
    // (c) different bytes
    const job = await mkJob("102 Mismatch Ave");
    const statusBefore = (await prisma.project.findUniqueOrThrow({ where: { id: job.projectId } })).status;
    const r = await upload(job, "mm.mp4", 300, { landedSize: 301 });
    const s = await sub(r.id);
    c.ok("(c) a different size landed → held, not failed", !r.fin.ok && r.fin.held === true && sc.isHeldForSelfCheck(s));
    c.ok("(c) …the check is VOID with the reason", (await checkOf(r.id))?.state === "VOID" && /different file/i.test((await checkOf(r.id))?.voidReason ?? ""));
    c.ok("(c) …no announcement, the job's status untouched", (await notes(`cut-in-review-${r.id}`)) === 0 && (await prisma.project.findUniqueOrThrow({ where: { id: job.projectId } })).status === statusBefore);
    c.ok("(c) …the editor and the office are rung (bell only)", (await prisma.notification.count({ where: { kind: "self_check_needed", href: { contains: job.projectId } } })) >= 1);
    const ap = await actions.approveCut(r.id);
    c.ok("(c) approveCut refuses a held cut", !ap.ok && /waiting on the editor's check/i.test(ap.message), ap.message);
    const rq = await actions.requestCutChanges(r.id);
    c.ok("(c) requestCutChanges refuses it too", !rq.ok && /waiting on the editor's check/i.test(rq.message));
    const again = await answerFor(job.projectId, { deliverableId: job.deliverableId, slot: 1 }, { name: "mm.mp4", size: 301 });
    const rel = await sca.submitSelfCheck(r.id, again);
    c.ok("(c) a fresh check on what actually landed releases it", rel.ok && !!(await sub(r.id)).selfCheckedAt, rel.message);
    c.ok("(c) …announced once", (await notes(`cut-in-review-${r.id}`)) === 1);
  }

  // (d) the Final-folder button
  const F = await mkJob("103 Folder Way");
  let folderRow = "";
  {
    dbxFiles.set(`${F.folder}/folder-v1.mp4`, { size: 900, hash: "hash-A", modified: new Date(Date.now() - 60_000) });
    const rowsBefore = await prisma.reviewSubmission.count({ where: { projectId: F.projectId } });
    const ask = await actions.submitCutForReview(F.projectId, "first cut");
    c.ok("(d) the button with no check answers needsSelfCheck, naming the file", !ask.ok && ask.needsSelfCheck === true && ask.candidate?.fileName === "folder-v1.mp4");
    c.ok("(d) …and wrote nothing", (await prisma.reviewSubmission.count({ where: { projectId: F.projectId } })) === rowsBefore);
    const check = await answerFor(F.projectId, { deliverableId: null, slot: null, assetPath: `${F.folder}/folder-v1.mp4` }, { name: "folder-v1.mp4" });
    const sent = await actions.submitCutForReview(F.projectId, "first cut", check);
    const row = await prisma.reviewSubmission.findFirst({ where: { projectId: F.projectId, assetPath: `${F.folder}/folder-v1.mp4` } });
    folderRow = row?.id ?? "";
    c.ok("(d) with the check: in review", sent.ok && !!row?.selfCheckedAt, sent.message);
    c.ok("(d) …bound to Dropbox's content_hash", row?.sourceRev === "hash-A" && (await checkOf(folderRow))?.fileIdentity === "dbx:hash-A");
    c.ok("(d) …announced once", (await notes(`cut-in-review-${folderRow}`)) === 1);
  }
  {
    // (g) an in-place re-export under the same name
    dbxFiles.set(`${F.folder}/folder-v1.mp4`, { size: 901, hash: "hash-B", modified: new Date() });
    const ap = await actions.approveCut(folderRow);
    c.ok("(g) the file changed in the folder after the check → approve refuses", !ap.ok && /changed after the editor checked/i.test(ap.message), ap.message);
    c.ok("(g) …the check is VOID and the cut is back with the editor (held)", (await checkOf(folderRow))?.state === "VOID" && sc.isHeldForSelfCheck(await sub(folderRow)));
    dbxDown = true;
    const again = await answerFor(F.projectId, { deliverableId: null, slot: null, assetPath: `${F.folder}/folder-v1.mp4` }, { name: "folder-v1.mp4" });
    const down = await sca.submitSelfCheck(folderRow, again);
    c.ok("(g) Dropbox unreadable → the re-check is refused with a retry", !down.ok && /try again/i.test(down.message), down.message);
    dbxDown = false;
    const rel = await sca.submitSelfCheck(folderRow, again);
    c.ok("(g) a fresh check on the new bytes releases it, bound to the new hash", rel.ok && (await sub(folderRow)).sourceRev === "hash-B" && !!(await sub(folderRow)).selfCheckedAt, rel.message);
    c.ok("(g) …and the release is announced (it had left review)", (await notes(`cut-in-review-${folderRow}`)) >= 1);
  }
  {
    // (e)/(f) the sweep
    const S = await mkJob("104 Sweep St");
    dbxFiles.set(`${S.folder}/swept.mp4`, { size: 40, hash: "hash-S1", modified: new Date() });
    const n = await rc.discoverCutsForReview(S.projectId, "104 Sweep St");
    const row = await prisma.reviewSubmission.findFirstOrThrow({ where: { projectId: S.projectId } });
    c.ok("(f) the sweep creates the row HELD, with the bytes it found", n === 1 && sc.isHeldForSelfCheck(row) && row.sourceRev === "hash-S1");
    c.ok("(f) …not announced", (await notes(`cut-in-review-${row.id}`)) === 0);
    const board = await rc.videoReviewBoard();
    c.ok("(f) …not on the Review board's waiting list", !board.waiting.some((w) => w.submissionId === row.id));
    const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 20 * 86_400_000) } });
    // The control: a checked-in (legacy) cut of the same age IS an exception.
    const ctl = await mkJob("104b Control Ct");
    const aged = await prisma.reviewSubmission.create({ data: { projectId: ctl.projectId, kind: "video", deliverableId: ctl.deliverableId, slot: 1, round: 1, status: "PENDING", fileName: "aged.mp4", source: "upload", createdAt: new Date(Date.now() - 20 * 86_400_000) } });
    const ex = await opsExceptionsBoard().catch(() => null);
    c.ok("(f) …and not an aging-verdict exception even at 20 days (a pre-gate cut that age is)", !!ex && !JSON.stringify(ex).includes(row.id) && JSON.stringify(ex).includes(`review:${aged.id}`));
    const ap = await actions.approveCut(row.id);
    c.ok("(f) approveCut refuses the swept cut", !ap.ok);
    // (e) the editor's button claims it — a check first, then the CURRENT hash
    dbxFiles.set(`${S.folder}/swept.mp4`, { size: 41, hash: "hash-S2", modified: new Date() });
    currentUser = asEditor("kim", "Kim");
    const ask = await actions.submitCutForReview(S.projectId);
    c.ok("(e) claiming a swept cut asks for the check", !ask.ok && ask.needsSelfCheck === true && ask.candidate?.submissionId === row.id);
    const check = await answerFor(S.projectId, { deliverableId: null, slot: null, assetPath: `${S.folder}/swept.mp4` }, { name: "swept.mp4" });
    const [x, y] = await Promise.all([actions.submitCutForReview(S.projectId, undefined, check), sca.submitSelfCheck(row.id, check)]);
    const after = await sub(row.id);
    currentUser = null;
    c.ok("(e) …the check rebinds to the hash in the folder NOW", after.sourceRev === "hash-S2" && !!after.selfCheckedAt, `${x.message} / ${y.message}`);
    c.ok("(e) …it is the editor's submission now", after.submittedByKey === "kim");
    c.ok("(f) the button and a Finish-the-check racing: one announcement", (await notes(`cut-in-review-${row.id}`)) === 1, String(await notes(`cut-in-review-${row.id}`)));
  }
  {
    // (h) a move voids the check; (i) a restored round keeps its own
    const A = await mkJob("105 Move From Rd");
    const B = await mkJob("106 Move To Rd", { status: "SHOT" });
    const m = await upload(A, "move.mp4", 120);
    c.ok("(h) the cut is in review on the first job", !!(await sub(m.id)).selfCheckedAt);
    const moved = await actions.reassignCut(m.id, B.projectId, "wrong job");
    const s = await sub(m.id);
    c.ok("(h) moved → held on the target, its check VOID", moved.ok && s.projectId === B.projectId && sc.isHeldForSelfCheck(s) && (await checkOf(m.id))?.state === "VOID", moved.message);
    c.ok("(h) …the target is not announced and not moved to REVIEW yet", (await notes(`cut-in-review-${m.id}-moved`)) === 0 && (await prisma.project.findUniqueOrThrow({ where: { id: B.projectId } })).status === "SHOT");
    const chk = await answerFor(B.projectId, { deliverableId: s.deliverableId, slot: s.slot }, { name: "move.mp4", size: 120 }, { round: s.round });
    const rel = await sca.submitSelfCheck(m.id, chk);
    c.ok("(h) a fresh check on the target releases it: REVIEW + one moved announcement", rel.ok && (await prisma.project.findUniqueOrThrow({ where: { id: B.projectId } })).status === "REVIEW" && (await notes(`cut-in-review-${m.id}-moved`)) === 1, rel.message);

    const R = await mkJob("107 Restore Pl");
    const r1 = await upload(R, "r1.mp4", 10);
    const r2 = await upload(R, "r2.mp4", 11, { round: 2 });
    c.ok("(i) v2 supersedes v1", (await sub(r1.id)).status === "SUPERSEDED" && !!(await sub(r2.id)).selfCheckedAt);
    await prisma.reviewSubmission.delete({ where: { id: r2.id } });
    const restored = await rc.restorePriorCutRound(R.projectId, { id: r2.id, deliverableId: R.deliverableId, slot: 1, round: 2 });
    const back = await sub(r1.id);
    c.ok("(i) taking v2 back restores v1 WITH its own check", restored === 1 && back.status === "PENDING" && !sc.isHeldForSelfCheck(back) && (await checkOf(r1.id))?.state === "VALID");
    const ap = await actions.approveCut(r1.id);
    c.ok("(i) …and v1 is approvable", ap.ok, ap.message);
  }
  {
    // (j) the queue's Completed / Ready-for-review relay
    const Q = await mkJob("108 Queue Ct", { status: "REVISION" });
    await prisma.smartTask.create({ data: { projectId: Q.projectId, taskType: "revision", title: "Video revision — 108 Queue Ct", status: "OPEN", assignedKey: "kim", createdAt: new Date(Date.now() - 3_600_000) } });
    await prisma.project.update({ where: { id: Q.projectId }, data: { revisionRequestedAt: new Date(Date.now() - 3_600_000) } });
    dbxFiles.set(`${Q.folder}/queue-fix.mp4`, { size: 5, hash: "hash-Q", modified: new Date() });
    currentUser = asEditor("kim", "Kim");
    const { setQueueStatus } = await import("@/app/editing/actions");
    const r = await setQueueStatus(Q.projectId, "Ready for review");
    currentUser = null;
    c.ok("(j) the queue pill relays the check instead of sending", !r.ok && /send-for-review check comes first/i.test(r.message), r.message);
    c.ok("(j) …and nothing entered review", (await prisma.reviewSubmission.count({ where: { projectId: Q.projectId } })) === 0);
  }
  {
    // (k) a pre-gate row (no check id) is grandfathered
    const K = await mkJob("109 Legacy Ln");
    const legacy = await prisma.reviewSubmission.create({ data: { projectId: K.projectId, kind: "video", deliverableId: K.deliverableId, slot: 1, round: 1, status: "PENDING", fileName: "legacy.mp4", source: "upload", submittedByKey: "kim", blobUrl: "https://drillstore.public.blob.vercel-storage.com/review-cuts/x/legacy.mp4", createdAt: new Date(Date.now() - 3 * 86_400_000) } });
    c.ok("(k) a legacy PENDING row is not held", !sc.isHeldForSelfCheck(legacy));
    const ap = await actions.approveCut(legacy.id);
    c.ok("(k) …and stays approvable, history not rewritten", ap.ok && !(await sub(legacy.id)).selfCheckId, ap.message);
  }
  {
    // (l) the office on an editor's behalf
    const O = await mkJob("110 Office Row", { editor: "john" });
    const r = await upload(O, "office.mp4", 64);
    const chk = await checkOf(r.id);
    c.ok("(l) the office's check records the real actor and the editor it was for", chk?.actorName === "Local dev" && chk.onBehalfOf === "john" && chk.editorKey === "john", `${chk?.actorName} / ${chk?.onBehalfOf} / ${chk?.editorKey}`);
    const att = await scs.attestationFor(r.id);
    c.ok("(l) …and the reviewer can read the attestation", !!att && att.onBehalfOf === "john" && att.items.length >= 6);
  }

  // =============================================================================
  c.head("B · revision issues (§8.3 / A36 / A37)");
  const crrBefore = JSON.stringify(await prisma.contentRevisionRound.findMany({ orderBy: { id: "asc" } }));
  await prisma.contentRevisionRound.create({ data: { videoKey: "vk-drill", projectId: J.projectId, enrollmentId: "enr-drill", clientId: "cl-drill", submissionId: v1, windowId: "win-drill", decisionId: "dec-drill", ordinal: 1, includedRounds: 2, included: true, feeDecision: null } });
  const crrSeeded = JSON.stringify(await prisma.contentRevisionRound.findMany({ orderBy: { id: "asc" } }));
  let noteIssue = "";
  {
    const n1 = await actions.addCutNote({ projectId: J.projectId, submissionId: v1, body: "Logo is the old one at the end", lane: "EDITOR", kind: "fix", timeSec: 41 });
    const n2 = await actions.addCutNote({ projectId: J.projectId, submissionId: v1, body: "Lovely pacing here", lane: "EDITOR", kind: "coaching", timeSec: 5 });
    c.ok("a review note is an issue on this exact version; coaching is not", n1.ok && n2.ok && (await prisma.revisionIssue.count({ where: { projectId: J.projectId } })) === 1);
    const i = await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: J.projectId } });
    noteIssue = i.id;
    c.ok("…on v1, by Kim's version, unclassified, not imported", i.raisedOnSubmissionId === v1 && i.versionEditorKey === "kim" && i.cause === "UNCLASSIFIED" && !i.imported && i.timeSec === 41);
    const note = await prisma.mediaNote.findFirstOrThrow({ where: { projectId: J.projectId, kind: "fix" } });
    await ri.ingestReviewNote(note.id);
    await ri.ingestReviewNote(note.id);
    c.ok("re-ingesting the same note makes nothing new", (await prisma.revisionIssue.count({ where: { projectId: J.projectId } })) === 1);
    const bounce = await actions.requestCutChanges(v1);
    c.ok("the bounce sends it back", bounce.ok, bounce.message);
  }
  let v2 = "";
  {
    // Reassignment Kim → John between v1 and v2: John sees the issue, v1 stays Kim's.
    await prisma.smartTask.update({ where: { dedupeKey: `edit-video-${J.projectId}` }, data: { assignedKey: "john" } });
    const views = await ri.issuesForProject(J.projectId, { scrub: true });
    const i = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: noteIssue } });
    c.ok("reassigned Kim→John: the job's reader shows John the issue", views.some((v) => v.id === noteIssue) && i.assignedEditorKey === "john");
    c.ok("…and the version's author stays Kim", i.versionEditorKey === "kim");
    const slotIssues = await ri.openIssuesForSlot(J.projectId, { deliverableId: J.deliverableId, slot: 1 });
    c.ok("…John's check lists it", slotIssues.some((s) => s.id === noteIssue));
    const batch = (await scs.checkContextsForProject(J.projectId))[`${J.deliverableId}:1`];
    const single = await scs.checkContextForSlot(J.projectId, { deliverableId: J.deliverableId, slot: 1 });
    c.ok("the upload panel's batched list is the one the server validates against", !!batch && batch.profile.checklistKey === single.profile.checklistKey && batch.isRevision === single.isRevision && JSON.stringify(batch.issues.map((i) => i.id)) === JSON.stringify(single.issues.map((i) => i.id)) && batch.isRevision === true);
    // v2 by John, declaring it fixed in his check
    currentUser = asEditor("john", "John");
    const r = await upload(J, "v2.mp4", 510, { addressed: [noteIssue], round: 2 });
    currentUser = null;
    v2 = r.id;
    const after = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: noteIssue } });
    c.ok("the v2 check marks it ADDRESSED in v2", after.state === "ADDRESSED" && after.addressedInSubmissionId === v2, `${after.state} ${after.addressedInSubmissionId}`);
    const refused = await actions.approveCut(v2, { verifyIssueIds: [] });
    c.ok("approving with the fix left unticked is refused", !refused.ok && /isn't ticked as verified/i.test(refused.message), refused.message);
    const ok = await actions.approveCut(v2, { verifyIssueIds: [noteIssue] });
    const ver = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: noteIssue } });
    c.ok("approving with it ticked verifies it IN v2", ok.ok && ver.state === "VERIFIED" && ver.verifiedInSubmissionId === v2, ok.message);
  }
  {
    // A not-done declaration holds the approval; the reviewer rules it not needed.
    const M = await mkJob("111 Missed St");
    const m1 = await upload(M, "m1.mp4", 20);
    await actions.addCutNote({ projectId: M.projectId, submissionId: m1.id, body: "Agent name misspelled in the end card", lane: "EDITOR", kind: "fix", timeSec: 50 });
    await actions.requestCutChanges(m1.id);
    const issue = await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: M.projectId } });
    const m2 = await upload(M, "m2.mp4", 21, { round: 2, notAddressed: { [issue.id]: "Waiting on the agent to confirm the spelling" } });
    const held = await actions.approveCut(m2.id);
    c.ok("an earlier issue the editor said is NOT done holds the approval", !held.ok && /weren't done|wasn't done/i.test(held.message), held.message);
    const ev = await prisma.revisionIssueEvent.findFirst({ where: { issueId: issue.id, kind: "NOT_ADDRESSED" } });
    c.ok("…the editor's reason is on the issue's history", !!ev?.note?.includes("confirm the spelling"));
    // Bounce v2: the ask the editor openly declared NOT done (with a reason)
    // is not a miss (review fix #9 — it used to be stamped missed, which
    // penalised the honest answer); a new note on v2 is not a missed one either.
    await actions.addCutNote({ projectId: M.projectId, submissionId: m2.id, body: "Music too loud at 0:10", lane: "EDITOR", kind: "fix", timeSec: 10 });
    await actions.requestCutChanges(m2.id);
    const oldAsk = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    const newAsk = await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: M.projectId, id: { not: issue.id } } });
    c.ok("#9 bounce: the old ask the check declared NOT done is NOT stamped missed — it stays with the editor", oldAsk.missedInSubmissionId === null && ["OPEN", "REOPENED"].includes(oldAsk.state), `${oldAsk.state} missed=${oldAsk.missedInSubmissionId}`);
    c.ok("…the new instruction on v2 is NOT a missed one", !newAsk.missedInSubmissionId && newAsk.raisedOnSubmissionId === m2.id);
    // v3 fixes the old ask at last; the new one the client wants kept.
    const m3 = await upload(M, "m3.mp4", 22, { round: 3, addressed: [issue.id], notAddressed: { [newAsk.id]: "Client wants it loud actually" } });
    const held3 = await actions.approveCut(m3.id);
    c.ok("v3: the one still declared not done holds the approval", !held3.ok);
    const na2 = await ia.markIssueNotNeededAction(newAsk.id, "Client asked to keep it");
    const ap = await actions.approveCut(m3.id);
    const fixed = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    c.ok("the reviewer marks it not needed → the approval goes through and verifies the v3 fix (never a miss)", na2.ok && ap.ok && fixed.state === "VERIFIED" && fixed.verifiedInSubmissionId === m3.id && fixed.missedInSubmissionId === null, ap.message);
    // the legacy toggle mirror
    const T = await mkJob("112 Toggle Way");
    const t1 = await upload(T, "t1.mp4", 30);
    await actions.addCutNote({ projectId: T.projectId, submissionId: t1.id, body: "Crooked vertical at 0:03", lane: "EDITOR", kind: "fix", timeSec: 3 });
    const tn = await prisma.mediaNote.findFirstOrThrow({ where: { projectId: T.projectId, kind: "fix" } });
    await actions.setCutNoteStatus(tn.id, "FIXED");
    c.ok("the legacy 'fixed' toggle writes the same ADDRESSED state", (await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: T.projectId } })).state === "ADDRESSED");
    await actions.setCutNoteStatus(tn.id, "RESOLVED");
    c.ok("…and the desk's 'resolved' verifies it", (await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: T.projectId } })).state === "VERIFIED");
  }
  {
    // Briefs: short text, portal pins + addendum, analysis and the re-read lock.
    const P = await mkJob("113 Brief Blvd", { videos: 2 });
    const task = await prisma.smartTask.create({ data: { projectId: P.projectId, taskType: "revision", title: "Video revision — 113 Brief Blvd", status: "OPEN", assignedKey: "kim" }, select: { id: true } });
    const b1 = await rb.createRevisionBrief({ projectId: P.projectId, taskId: task.id, source: "text", text: "Can you make the intro shorter?" });
    const whole = await prisma.revisionIssue.findMany({ where: { sourceId: { startsWith: `${b1}:` } } });
    c.ok("a short client ask is one job-level issue for its whole text (no model call)", whole.length === 1 && whole[0].slot == null && aiCalls === 0);
    await ri.ingestBriefItems(b1!);
    c.ok("re-ingesting the brief makes nothing new", (await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${b1}:` } } })) === 1);
    const slotKey2 = `${P.deliverableId}:2`;
    const pin = { submissionId: "sub-pin", outputId: null, cutKey: slotKey2, decisionId: "dec-1", roundId: "round-1", label: "Video 2 of 2" };
    const pb = await rb.createRevisionBrief({ projectId: P.projectId, source: "portal", text: "• Brighter kitchen\n• Remove the car", pin, skipAnalysis: true });
    const add = await rb.createRevisionBrief({ projectId: P.projectId, source: "portal", text: "• Brighter kitchen\n• Add the pool", pin: { ...pin, decisionId: "dec-2" }, skipAnalysis: true });
    const pinned = await prisma.revisionIssue.findMany({ where: { sourceId: { startsWith: `${pb}:` } } });
    const added = await prisma.revisionIssue.findMany({ where: { sourceId: { startsWith: `${add}:` } } });
    c.ok("a portal brief's items land on the named video", pinned.length === 2 && pinned.every((i) => i.deliverableId === P.deliverableId && i.slot === 2 && i.contentRoundId === "round-1"));
    c.ok("…an addendum adds its own items, the first brief's are not duplicated", added.length === 2 && (await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${pb}:` } } })) === 2);
    // Duplicate asks (the same ask by email and by portal) count once.
    const dupA = pinned.find((i) => /Brighter/.test(i.summary ?? ""))!;
    const dupB = added.find((i) => /Brighter/.test(i.summary ?? ""))!;
    const mg = await ia.mergeIssueAction(dupB.id, dupA.id);
    c.ok("merging the repeated ask counts it once", mg.ok && (await prisma.revisionIssue.findUniqueOrThrow({ where: { id: dupB.id } })).state === "DUPLICATE");
    // analysis → items per named video; re-read before/after classification
    aiItems = [
      { area: "Music & sound", ask: "Swap the song", detail: "", quote: "the song is wrong", scope: "named", videos: ["V1"] },
      { area: "Pacing & movement", ask: "Faster opening", detail: "", quote: "too slow at the start", scope: "unknown", videos: [] },
    ];
    const long = "The client call, long enough to be worth reading. ".repeat(8);
    const b3 = await rb.createRevisionBrief({ projectId: P.projectId, taskId: task.id, source: "call", text: long });
    const analysed = await prisma.revisionIssue.findMany({ where: { sourceId: { startsWith: `${b3}:` } } });
    c.ok("an analysed ask: one issue on the named video, one job-level", analysed.length === 2 && analysed.some((i) => i.slot === 1 && i.category === "Music & sound") && analysed.some((i) => i.slot == null));
    aiItems = [{ area: "Color & styling", ask: "Warmer grade", detail: "", quote: "too cold", scope: "all", videos: [] }];
    const reread = await rb.analyzeBrief(b3!);
    const afterRead = await prisma.revisionIssue.findMany({ where: { sourceId: { startsWith: `${b3}:` } } });
    c.ok("a re-read BEFORE anyone acted: vanished items stand down with an event, the new one is minted", reread && afterRead.filter((i) => i.state === "NOT_APPLICABLE").length === 2 && afterRead.some((i) => i.category === "Color & styling") && (await prisma.revisionIssueEvent.count({ where: { kind: "REANALYSED" } })) === 2);
    const live = afterRead.find((i) => i.category === "Color & styling")!;
    await ia.classifyIssueAction(live.id, { cause: "CLIENT_CHANGE" });
    aiItems = [{ area: "Other", ask: "Something else", detail: "", quote: "x", scope: "all", videos: [] }];
    const locked = await rb.analyzeBrief(b3!);
    const brief = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: b3! } });
    c.ok("a re-read AFTER classification is refused and renumbers nothing", !locked && /already being worked/i.test(brief.analysisError ?? "") && (await prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${b3}:` } } })) === afterRead.length);
    const cls = await prisma.revisionIssueEvent.findFirst({ where: { issueId: live.id, kind: "CLASSIFIED" } });
    c.ok("classification is a person's, with from → to on the record", cls?.fromValue === "UNCLASSIFIED" && cls.toValue === "CLIENT_CHANGE" && !!(await prisma.revisionIssue.findUniqueOrThrow({ where: { id: live.id } })).causeConfirmedAt);
    c.ok("nothing was classified by the hub on its own", (await prisma.revisionIssue.count({ where: { cause: { not: "UNCLASSIFIED" }, causeConfirmedBy: null } })) === 0);
  }
  c.ok("ContentRevisionRound (the client's billable rounds) untouched by all of it", JSON.stringify(await prisma.contentRevisionRound.findMany({ orderBy: { id: "asc" } })) === crrSeeded && crrBefore === "[]");

  // =============================================================================
  c.head("C · editor KPIs (§8.4 / A37 / A38) — pure rules on a pinned clock");
  {
    const dec = new Date("2026-09-26T12:00:00Z");
    const o = (status: string, decided: Date | null, issues: { cause: string; state?: string; foundAfterApproval?: boolean; duplicateOfId?: string | null }[]) =>
      eq.firstReviewOutcome({ status, decidedAt: decided }, issues.map((i) => ({ cause: i.cause, state: i.state ?? "OPEN", foundAfterApproval: !!i.foundAfterApproval, duplicateOfId: i.duplicateOfId ?? null })));
    c.ok("a pending first review is pending, not a pass or a fail", o("PENDING", null, []) === "pendingReview");
    c.ok("a bounce whose issues nobody classified is pending classification", o("CHANGES_REQUESTED", dec, [{ cause: "UNCLASSIFIED" }]) === "pendingClassification");
    c.ok("a CLIENT_CHANGE bounce does not fail the editor", o("CHANGES_REQUESTED", dec, [{ cause: "CLIENT_CHANGE" }]) === "passed");
    c.ok("an EDITOR_ERROR bounce does", o("CHANGES_REQUESTED", dec, [{ cause: "EDITOR_ERROR" }]) === "failed");
    c.ok("a defect found after approval is not a first-review fail", o("APPROVED", dec, [{ cause: "EDITOR_ERROR", foundAfterApproval: true }]) === "passed");
    c.ok("replaced before anyone ruled is not reviewed", o("SUPERSEDED", null, []) === "replacedBeforeReview");
    // Weekday hours and the review wait on a pinned Friday → Monday.
    const fri5 = ET(9, 25, 17), mon9 = ET(9, 28, 9), mon10 = ET(9, 28, 10);
    c.ok("weekday hours: Fri 5pm → Mon 10am is 17h (the weekend does not count)", eq.weekdayHoursBetween(fri5, mon10) === 17, String(eq.weekdayHoursBetween(fri5, mon10)));
    const segs = eq.reviewWaitSegments({ enteredAt: fri5, decidedAt: mon10 }, [{ toTeamMemberId: "james", at: fri5 }], NOW);
    c.ok("a cut entered Fri 5pm, ruled Mon 10am: all 17h are James's queue", segs.length === 1 && segs[0].reviewer === "james" && segs[0].hours === 17);
    const split = eq.reviewWaitSegments({ enteredAt: fri5, decidedAt: mon10 }, [{ toTeamMemberId: "james", at: fri5 }, { toTeamMemberId: "kyle", at: mon9 }], NOW);
    c.ok("handed James → Kyle Mon 9am: 16h James, 1h Kyle", split.find((s) => s.reviewer === "james")?.hours === 16 && split.find((s) => s.reviewer === "kyle")?.hours === 1, JSON.stringify(split));
  }
  {
    // The report, for Remar's cuts, pinned to NOW. Five first versions approved,
    // one bounced for an editor error, one bounced unclassified, one pending.
    const R = await mkJob("114 Metrics Row", { editor: "remar", videos: 9 });
    const day = (d: number, h: number) => ET(9, d, h);
    const mk = async (slot: number, round: number, status: string, created: Date, decided: Date | null) =>
      prisma.reviewSubmission.create({ data: { projectId: R.projectId, kind: "video", deliverableId: R.deliverableId, slot, round, status, fileName: `s${slot}v${round}.mp4`, source: "upload", submittedByKey: "remar", createdAt: created, selfCheckedAt: created, selfCheckId: `chk-${slot}-${round}`, decidedAt: decided, decidedBy: decided ? "James" : null } });
    for (let s = 1; s <= 5; s++) await mk(s, 1, "APPROVED", day(28, 9), day(28, 11));
    const bad = await mk(6, 1, "CHANGES_REQUESTED", day(28, 9), day(28, 12));
    const unk = await mk(7, 1, "CHANGES_REQUESTED", day(28, 9), day(28, 12));
    await mk(8, 1, "PENDING", day(29, 9), null);
    const mkIssue = async (subId: string, cause: string, extra: Record<string, unknown> = {}) =>
      prisma.revisionIssue.create({ data: { projectId: R.projectId, deliverableId: R.deliverableId, slot: 6, raisedOnSubmissionId: subId, sourceKind: "MANUAL", sourceId: `m-${subId}-${cause}-${seq++}`, originalText: "Crooked verticals in the kitchen", category: "Framing", versionEditorKey: "remar", cause, createdAt: day(28, 12), ...extra } });
    const err = await mkIssue(bad.id, "EDITOR_ERROR");
    await mkIssue(unk.id, "UNCLASSIFIED");
    const rep = await eq.editorQuality({ editorKey: "remar", from: day(27, 0), to: NOW, now: NOW });
    c.ok("first review: 5 of 6 reviewed passed; pending and unclassified are NOT in the denominator", rep.firstReview.passed === 5 && rep.firstReview.reviewed === 6 && rep.firstReview.pendingReview === 1 && rep.firstReview.pendingClassification === 1, JSON.stringify(rep.firstReview));
    c.ok("…with n shown and a rate (n ≥ 5)", rep.firstReview.rate === 83.3 && !rep.firstReview.thin);
    // A duplicate of the editor error counts once; a second, different one groups.
    const dup = await mkIssue(bad.id, "EDITOR_ERROR");
    await ri.mergeDuplicate(dup.id, err.id, { name: "James" });
    const rep2 = await eq.editorQuality({ editorKey: "remar", from: day(27, 0), to: NOW, now: NOW });
    c.ok("recurring: the merged duplicate counts once, with an example linking to the cut", rep2.recurring.n === 1 && rep2.recurring.groups[0]?.count === 1 && rep2.recurring.groups[0].examples[0]?.href.includes(bad.id));
    c.ok("…below the thin-sample floor it says so", rep2.recurring.thin === true);
    // Reclassify: the same cut, a client change → it passes; history kept.
    await ri.classifyIssue(err.id, { cause: "CLIENT_CHANGE" }, { name: "James" });
    const rep3 = await eq.editorQuality({ editorKey: "remar", from: day(27, 0), to: NOW, now: NOW });
    c.ok("reclassifying the editor error as a client change re-scores: 6 of 6", rep3.firstReview.passed === 6 && rep3.firstReview.reviewed === 6, JSON.stringify(rep3.firstReview));
    c.ok("…and the change is on the record, from → to", !!(await prisma.revisionIssueEvent.findFirst({ where: { issueId: err.id, kind: "CLASSIFIED", fromValue: "EDITOR_ERROR", toValue: "CLIENT_CHANGE" } })));
    c.ok("blocked time with no active-work pauses reads 'not recorded' (null), never 0", rep3.turnaround.waitingOnAssetsHours === null);
    // Review waiting through the report: a Fri 5pm entry ruled Mon 10am, James → Kyle.
    const james = await prisma.teamMember.create({ data: { name: "James Drill", email: "james-drill@example.com" }, select: { id: true } });
    const kyle = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" }, select: { id: true } });
    const w = await mk(9, 1, "APPROVED", ET(9, 25, 17), ET(9, 28, 10));
    await prisma.cutReviewerEvent.createMany({ data: [
      { submissionId: w.id, projectId: R.projectId, toTeamMemberId: james.id, reason: "SUBMITTED", actorName: "Hub", at: ET(9, 25, 17) },
      { submissionId: w.id, projectId: R.projectId, fromTeamMemberId: james.id, toTeamMemberId: kyle.id, reason: "COVER", actorName: "Kyle", at: ET(9, 28, 9) },
    ] });
    const rep4 = await eq.editorQuality({ editorKey: "remar", from: ET(9, 25, 0), to: NOW, now: NOW });
    const jr = rep4.reviewWaiting.byReviewer.find((r) => r.name === "James Drill");
    const kr = rep4.reviewWaiting.byReviewer.find((r) => r.name === "Kyle Drill");
    c.ok("the report splits the wait by reviewer queue (James 16h, Kyle 1h), none of it the editor's", jr?.totalHours === 16 && kr?.totalHours === 1, JSON.stringify(rep4.reviewWaiting.byReviewer));
    c.ok("…and reports what is waiting now, with its age", rep4.reviewWaiting.pending === 1 && (rep4.reviewWaiting.oldestPendingHours ?? 0) > 0);
    // Missed corrections come from the ledger (section B's job).
    const team = await eq.editorQuality({ editorKey: null, from: ET(9, 25, 0), to: new Date(), now: new Date() });
    c.ok("team view: a declared-not-done ask is NOT counted missed; it shows apart, with the reason; the new one on v2 is not missed either",
      team.missed.examples.every((e) => !/Music too loud|Agent name misspelled/.test(e.text)) && team.declaredNotDone.examples.some((e) => /Agent name misspelled/.test(e.text) && /confirm the spelling/.test(e.reason)),
      JSON.stringify({ missed: team.missed.examples.map((e) => e.text), declared: team.declaredNotDone }));
    const thin = await eq.editorQuality({ editorKey: "john", from: ET(9, 25, 0), to: new Date(), now: new Date() });
    c.ok("a small sample shows its n and no percentage", thin.firstReview.thin === true && thin.firstReview.rate === null);
  }
  // =============================================================================
  c.head("R · review fixes (Sep 25)");
  {
    // #1 two attestations on one held cut, racing (the queue button and the
    // edit page's Finish-the-check): the bind is a compare-and-set on the
    // pointer, so the loser never voids the winner. Run it several times —
    // the old two-statement bind lost about one run in three.
    let good = 0;
    const RUNS = 6;
    const bad: string[] = [];
    for (let k = 0; k < RUNS; k++) {
      const S = await mkJob(`12${k} Race Rd`);
      dbxFiles.set(`${S.folder}/race${k}.mp4`, { size: 50 + k, hash: `hash-R${k}`, modified: new Date() });
      await rc.discoverCutsForReview(S.projectId, `12${k} Race Rd`);
      const row = await prisma.reviewSubmission.findFirstOrThrow({ where: { projectId: S.projectId } });
      currentUser = asEditor("kim", "Kim");
      const check = await answerFor(S.projectId, { deliverableId: null, slot: null, assetPath: `${S.folder}/race${k}.mp4` }, { name: `race${k}.mp4` });
      const [x, y] = await Promise.all([actions.submitCutForReview(S.projectId, undefined, check), sca.submitSelfCheck(row.id, check)]);
      currentUser = null;
      const after = await sub(row.id);
      const ptr = after.selfCheckId ? await prisma.cutSelfCheck.findUnique({ where: { id: after.selfCheckId } }) : null;
      const valid = await prisma.cutSelfCheck.count({ where: { submissionId: row.id, state: "VALID" } });
      const ann = await notes(`cut-in-review-${row.id}`);
      if (after.selfCheckedAt && ptr?.state === "VALID" && valid === 1 && ann === 1 && x.ok && y.ok) good++;
      else bad.push(`run ${k}: entered=${!!after.selfCheckedAt} ptr=${ptr?.state} valid=${valid} ann=${ann} · ${x.message} / ${y.message}`);
    }
    c.ok(`#1 racing attestations: in review on ONE standing check, one announcement, both told ok — ${RUNS} of ${RUNS} runs`, good === RUNS, bad.join(" | ") || `${good}/${RUNS}`);
  }
  {
    // #6 the store's callback flips the row first and cannot read what landed;
    // the browser's finish (which measures the object) must bind it — it used
    // to answer "Already in review." and leave the cut held, with no bell.
    const job = await mkJob("130 Finalize Race Rd");
    currentUser = asEditor("kim", "Kim");
    const check = await answerFor(job.projectId, { deliverableId: job.deliverableId, slot: 1 }, { name: "fr.mp4", size: 88 });
    const started = await actions.startCutUpload({ projectId: job.projectId, deliverableId: job.deliverableId, slot: 1, fileName: "fr.mp4", sizeBytes: 88, width: 1080, height: 1920, selfCheck: check });
    if (!started.ok) throw new Error(started.message);
    const b = blobFor(job.projectId, started.submissionId, "fr.mp4");
    const cb = await rc.finalizeCutUpload(started.submissionId, { url: b.url, pathname: b.pathname });
    c.ok("#6 setup: the callback won the flip and could not read the store — held, PENDING_BYTES", !cb.ok && cb.held === true && (await checkOf(started.submissionId))?.state === "PENDING_BYTES");
    // The browser's finish used to stop at "the row isn't UPLOADING any more"
    // and answer "Already in review." without measuring anything. It now goes
    // on to measure the object — the drill's store has no token, so head()
    // cannot answer and it says so instead of claiming the cut is in review —
    // and then finalizes with what it measured (driven directly below).
    const fin = await actions.finishCutUpload({ submissionId: started.submissionId, url: b.url, pathname: b.pathname });
    currentUser = null;
    c.ok("#6 the browser's finish no longer answers \"Already in review.\" for a cut whose check waits on the bytes — it answers HELD", fin.message !== "Already in review." && !fin.ok && fin.held === true, fin.message);
    // …and HELD is what keeps the uploader from abandoning: even if it did,
    // bytes a row has already filed are never deleted.
    const blockedBefore = fence.blocked.length;
    currentUser = asEditor("kim", "Kim");
    await actions.abandonCutUpload(started.submissionId, b.url);
    currentUser = null;
    const afterAbandon = await sub(started.submissionId);
    c.ok("#6 abandoning a filed cut's bytes is a no-op (row still PENDING with its file, no delete attempted)", afterAbandon.status === "PENDING" && afterAbandon.blobUrl === b.url && fence.blocked.length === blockedBefore);
    const bound = await rc.finalizeCutUpload(started.submissionId, { ...b, size: 88 });
    const s = await sub(started.submissionId);
    c.ok("#6 …with its measurement the check binds and the cut enters, announced once", bound.ok && !!s.selfCheckedAt && (await checkOf(started.submissionId))?.state === "VALID" && (await notes(`cut-in-review-${started.submissionId}`)) === 1, bound.message);
    // The two finalize calls truly concurrent, the store unreadable to both
    // but the browser carrying the size: whichever flips first, it enters once.
    let ok = 0;
    const why: string[] = [];
    for (let k = 0; k < 5; k++) {
      const j = await mkJob(`13${k} Callback Race Ct`);
      const ck = await answerFor(j.projectId, { deliverableId: j.deliverableId, slot: 1 }, { name: `cr${k}.mp4`, size: 60 + k });
      const st = await actions.startCutUpload({ projectId: j.projectId, deliverableId: j.deliverableId, slot: 1, fileName: `cr${k}.mp4`, sizeBytes: 60 + k, width: 1080, height: 1920, selfCheck: ck });
      if (!st.ok) throw new Error(st.message);
      const bb = blobFor(j.projectId, st.submissionId, `cr${k}.mp4`);
      const [r1, r2] = await Promise.all([rc.finalizeCutUpload(st.submissionId, { url: bb.url, pathname: bb.pathname }), rc.finalizeCutUpload(st.submissionId, { ...bb, size: 60 + k })]);
      const ss = await sub(st.submissionId);
      const n = await notes(`cut-in-review-${st.submissionId}`);
      if (ss.selfCheckedAt && n === 1 && (await checkOf(st.submissionId))?.state === "VALID") ok++;
      else why.push(`run ${k}: ${r1.message} / ${r2.message} entered=${!!ss.selfCheckedAt} ann=${n}`);
    }
    c.ok("#6 callback and browser finalizing at once: entered once, on a VALID check — 5 of 5", ok === 5, why.join(" | ") || "5/5");
  }
  {
    // #3 / #12 a cut HELD for the check is not on the desk's verdict list, and
    // the workspace does not open on it by default; the desk sees who holds
    // each waiting cut.
    const { getReviewQueue, getCutWorkspace } = await import("@/lib/reviewRoom");
    const H = await mkJob("140 Held Room Rd", { videos: 2 });
    const legacy = await prisma.reviewSubmission.create({ data: { projectId: H.projectId, kind: "video", deliverableId: H.deliverableId, slot: 1, round: 1, status: "PENDING", fileName: "h1.mp4", source: "upload" } });
    const heldRow = await prisma.reviewSubmission.create({ data: { projectId: H.projectId, kind: "video", deliverableId: H.deliverableId, slot: 2, round: 2, status: "PENDING", fileName: "h2.mp4", source: "upload" } });
    await scs.holdForSelfCheck(heldRow.id, "drill: waiting on the editor's check");
    const jamesR = await prisma.teamMember.create({ data: { name: "James Reviewer", email: "james-r@example.com" }, select: { id: true } });
    await prisma.reviewSubmission.update({ where: { id: legacy.id }, data: { reviewerTeamMemberId: jamesR.id } });
    const q = await getReviewQueue();
    c.ok("#12 the desk's verdict list leaves the held cut out, and lists it apart as waiting on the editor's check",
      q.pending.some((p) => p.id === legacy.id) && !q.pending.some((p) => p.id === heldRow.id) && q.waitingOnCheck.some((p) => p.id === heldRow.id && p.heldForCheck));
    c.ok("#12 …each waiting cut names the one person it waits on", q.pending.find((p) => p.id === legacy.id)?.reviewer?.name === "James Reviewer");
    const ws = await getCutWorkspace(H.projectId);
    c.ok("#12 the workspace opens on the cut that can be ruled on, not the held redo with the higher round", ws?.active?.id === legacy.id, ws?.active?.fileName ?? "none");
    const wsHeld = await getCutWorkspace(H.projectId, heldRow.id);
    c.ok("#12 …and a held cut opened by link says so (no verdict buttons)", wsHeld?.active?.heldForCheck === true);
  }
  {
    // #4 a client addendum that arrives while v2 is in review is NOT closed by
    // approving v2 — only the reviewer's own notes on v2 are.
    const Q = await mkJob("150 Addendum Ave");
    const q1 = await upload(Q, "q1.mp4", 40);
    await actions.addCutNote({ projectId: Q.projectId, submissionId: q1.id, body: "Tighten the intro", lane: "EDITOR", kind: "fix", timeSec: 2 });
    await actions.requestCutChanges(q1.id);
    const A = await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: Q.projectId } });
    const q2 = await upload(Q, "q2.mp4", 41, { round: 2, addressed: [A.id] });
    await actions.addCutNote({ projectId: Q.projectId, submissionId: q2.id, body: "Logo a touch small (fine to leave)", lane: "EDITOR", kind: "fix", timeSec: 20 });
    const task = await prisma.smartTask.create({ data: { projectId: Q.projectId, taskType: "revision", title: "Video revision — 150 Addendum Ave", status: "OPEN", assignedKey: "kim" }, select: { id: true } });
    const brief = await rb.createRevisionBrief({ projectId: Q.projectId, taskId: task.id, source: "text", text: "Also swap the music please" });
    const B = await prisma.revisionIssue.findFirstOrThrow({ where: { sourceId: { startsWith: `${brief}:` } } });
    const C = await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: Q.projectId, sourceKind: "REVIEW_NOTE", raisedOnSubmissionId: q2.id } });
    const ap = await actions.approveCut(q2.id, { verifyIssueIds: [A.id] });
    const B2 = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: B.id } });
    const C2 = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: C.id } });
    const still = await ri.openIssuesForSlot(Q.projectId, { deliverableId: Q.deliverableId, slot: 1 });
    c.ok("#4 approving v2 closes the reviewer's own open note on v2 (not needed)", ap.ok && C2.state === "NOT_APPLICABLE", ap.message);
    c.ok("#4 …but the client's addendum stays OPEN and on the next version's check", B2.state === "OPEN" && still.some((i) => i.id === B.id), `${B2.state}`);
  }
  {
    // #9 / #11 / #16 / #18 / #10 — who a miss and a turnaround belong to.
    const t0 = new Date();
    // Control: Kim's own bounce answered by Kim.
    const L = await mkJob("160 Same Hands Ln");
    currentUser = asEditor("kim", "Kim");
    const l1 = await upload(L, "l1.mp4", 70);
    currentUser = null;
    await actions.addCutNote({ projectId: L.projectId, submissionId: l1.id, body: "Straighten the door frame", lane: "EDITOR", kind: "fix", timeSec: 5 });
    await actions.requestCutChanges(l1.id);
    const Y = await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: L.projectId } });
    currentUser = asEditor("kim", "Kim");
    const l2 = await upload(L, "l2.mp4", 71, { round: 2, addressed: [Y.id] });
    currentUser = null;
    // Kim → John: Kim's v1 bounced, John's v2 claims the fix and misses it.
    const K = await mkJob("161 Handover Rd");
    currentUser = asEditor("kim", "Kim");
    const k1 = await upload(K, "k1.mp4", 80);
    currentUser = null;
    await actions.addCutNote({ projectId: K.projectId, submissionId: k1.id, body: "Fix the 0:14 driveway", lane: "EDITOR", kind: "fix", timeSec: 14 });
    await actions.requestCutChanges(k1.id);
    const X = await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: K.projectId } });
    await prisma.smartTask.update({ where: { dedupeKey: `edit-video-${K.projectId}` }, data: { assignedKey: "john" } });
    currentUser = asEditor("john", "John");
    const k2 = await upload(K, "k2.mp4", 81, { round: 2, addressed: [X.id] });
    currentUser = null;
    c.ok("#9/#11 setup: John's v2 claims the fix", (await prisma.revisionIssue.findUniqueOrThrow({ where: { id: X.id } })).addressedInSubmissionId === k2.id);
    // The reviewer names it NOT fixed at the send-back — the real miss.
    await actions.addCutNote({ projectId: K.projectId, submissionId: k2.id, body: "Driveway still crooked", lane: "EDITOR", kind: "fix", timeSec: 14 });
    const back = await actions.requestCutChanges(k2.id, { notFixedIssueIds: [X.id] });
    const Xm = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: X.id } });
    c.ok("#9 a fix the check claimed and the reviewer names not fixed is the miss — stamped in John's v2", back.ok && Xm.state === "REOPENED" && Xm.missedInSubmissionId === k2.id, back.message);
    const to = new Date(Date.now() + 60_000);
    const kimR = await eq.editorQuality({ editorKey: "kim", from: t0, to, now: to });
    const johnR = await eq.editorQuality({ editorKey: "john", from: t0, to, now: to });
    c.ok("#11 the miss is John's (the version that missed it), not Kim's (the version it was raised on)", johnR.missed.count === 1 && kimR.missed.count === 0, `john ${johnR.missed.count} · kim ${kimR.missed.count}`);
    c.ok("#11 turnaround: Kim's own bounce → her own v2 counts; the stretch across the reassignment counts for neither", kimR.turnaround.n === 1 && johnR.turnaround.n === 0, `kim n=${kimR.turnaround.n} · john n=${johnR.turnaround.n}`);
    c.ok("#16 an example on the editor's own card also carries a link the editor can open (/edit/…#issues)", johnR.missed.examples[0]?.editHref === `/edit/${K.projectId}#issues` && johnR.missed.examples[0]?.href.startsWith("/review/"));
    // A cause that is somebody else's is not the editor's miss.
    await ri.classifyIssue(X.id, { cause: "CLIENT_CHANGE" }, { name: "James" });
    c.ok("#9 classified a client change → out of John's missed count", (await eq.editorQuality({ editorKey: "john", from: t0, to, now: to })).missed.count === 0);
    await ri.classifyIssue(X.id, { cause: "EDITOR_ERROR" }, { name: "James" });
    c.ok("#9 …re-classified an editor error → back in", (await eq.editorQuality({ editorKey: "john", from: t0, to, now: to })).missed.count === 1);
    // A reviewer reopening a fix a version claimed: a miss in THAT version.
    const re = await ia.reopenIssueAction(Y.id);
    const Yr = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: Y.id } });
    c.ok("#9 reopening a fix Kim's v2 claimed stamps the miss in v2", re.ok && Yr.state === "REOPENED" && Yr.missedInSubmissionId === l2.id, re.message);
    c.ok("#9 …and Kim's card now counts it", (await eq.editorQuality({ editorKey: "kim", from: t0, to, now: to })).missed.count === 1);
    // #18 an editor reading the job sees the asks, not another editor's verdicts.
    const asJohn = await ri.issuesForProject(K.projectId, { scrub: true, viewer: { editorKey: "john" } });
    const asKim = await ri.issuesForProject(K.projectId, { scrub: true, viewer: { editorKey: "kim" } });
    const desk = await ri.issuesForProject(K.projectId, { scrub: false });
    const xj = asJohn.find((i) => i.id === X.id);
    const xk = asKim.find((i) => i.id === X.id);
    c.ok("#18 John (inherited the job) sees the ask and its state, but not the confirmed cause on Kim's v1, nor the history", !!xj && xj.causeHidden && xj.cause === "UNCLASSIFIED" && !xj.causeConfirmedBy && xj.events.length === 0 && xj.versionEditorKey === null && xj.state === "REOPENED");
    c.ok("#18 …Kim sees the verdict on her own version; the desk sees everything", !!xk && !xk.causeHidden && xk.cause === "EDITOR_ERROR" && (desk.find((i) => i.id === X.id)?.events.length ?? 0) > 0);
    // #10 nobody rules on their own version, whatever door they reach.
    currentUser = asEditor("kim", "Kim");
    const own = await actions.approveCut(l2.id);
    const ownClass = await ia.classifyIssueAction(Y.id, { cause: "CLIENT_CHANGE" });
    currentUser = null;
    c.ok("#10 an editor who reaches the verdict is refused on their own version", !own.ok && /your own version/i.test(own.message), `${own.message} [by ${(await sub(l2.id)).submittedByKey}]`);
    c.ok("#10 …and cannot classify an issue on their own version", !ownClass.ok && /own version/i.test(ownClass.message), ownClass.message);
  }
  c.ok("kpi.ts (photographer bonus) output identical before and after", JSON.stringify(await scoreQuarterRoster(undefined, NOW)) === kpiBefore);
  c.ok("qc.ts (Kyle's dial) output identical before and after", JSON.stringify(await getQcStats(30)) === qcBefore);

  // =============================================================================
  c.head("Isolation");
  c.ok("no provider was reached (every outbound call fenced)", fence.faked.length === 0, fence.blocked.slice(0, 3).join(", "));
  c.ok("no client or team message left the building (bell rows only)", !fence.blocked.some((u) => /slack\.com|openphone|quo\.|twilio|gmail|sendgrid/i.test(u)), fence.blocked.filter((u) => /slack|openphone|twilio|gmail/i.test(u)).join(", "));
  console.log(`  (dropbox fake calls: ${dbxCalls}, model calls: ${aiCalls}, prisma error lines: ${quiet.count})`);

  c.summary();
  try { fs.unlinkSync(path.join(baseFiles.dir, "node_modules")); fs.rmSync(baseFiles.dir, { recursive: true, force: true }); } catch { /* harmless */ }
  quiet.restore();
  fence.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
