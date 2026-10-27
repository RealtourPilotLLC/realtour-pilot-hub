// ---------------------------------------------------------------------------
// DRILL: THE EDITOR'S BRIEF, RESET (Oct 27 2026, Jordan's Loom 8:04-15:54 and
// 25:58-26:39).
//
//   DRILL_PORT=5622 node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-editbrief.ts
//
// Jordan: "this whole editing brief needs to be cleaned up so that it makes
// sense for an editor. Quick and easy to look at, clear, not packed ... this
// should just be reset." What it proves:
//   1. The pure rules: the video's own timeline (revision loops repeat), the
//      editor speed fold, the technical-only preference filter, the office's
//      brief fields round trip, who an editor's question goes to, and the
//      one brand box on the final check.
//   2. Ask a question: texted to the creative manager and whoever left the
//      note when that was our team, never a client; recorded on the note
//      and posted in the job chat; the action's own guards.
//   3. The final check's brand box follows what is on file.
//   4. The page, as Kim: What to make in one line at the top, Details folded,
//      the timeline, Upload for review opening the panel, one footage link,
//      the instructions with the script inside, no "not approved" notice, no
//      half-shot card, Ask buttons, the profile in a side column.
//   5. The page, as the office with its tools on: the tools at the top, the
//      brief in the upload portal's fields, the half-shot hold there.
//   6. The office writes the brief: saved into the same text, others kept.
//   7. Editor speed in the Editing Room (owner and creative manager only).
//
// ISOLATION: PGlite via the shared harness; production is never opened, every
// outbound call is fenced, nothing is sent to anybody.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5622);
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---- the clock: Tue Oct 27 2026, noon ET ------------------------------------------
const RealDate = Date;
const SIM = RealDate.parse("2026-10-27T16:00:00.000Z");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;
const ago = (h: number) => new RealDate(SIM - h * 3600_000);

// The page's element tree is walked, not rendered.
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  function Link(p: unknown) { return p; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
    return realLoad.call(this, request, parent, isMain);
  };
}
installNextStubs();
const fence = fenceFetch();

/* eslint-disable @typescript-eslint/no-explicit-any */
type El = { $$typeof: symbol; type: any; key: string | null; props: Record<string, any> };
const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
const typeName = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
function walk(n: any, visit: (e: El) => void) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isEl(n)) return;
  visit(n);
  for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v, visit);
}
const find = (tree: any, pred: (e: El) => boolean) => { const out: El[] = []; walk(tree, (e) => { if (pred(e)) out.push(e); }); return out; };
const named = (tree: any, name: string) => find(tree, (e) => typeName(e.type) === name);
const section = (tree: any, name: string) => find(tree, (e) => e.props?.["data-brief-section"] === name)[0];
const said = (n: any) => words(n).join(" ").replace(/\s+/g, " ").trim();
function words(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (isEl(n)) words(n.props.children, out);
  return out;
}
/** Elements in document order, so "comes before" is a plain index compare. */
const order = (tree: any, preds: ((e: El) => boolean)[]) => {
  const seen: El[] = [];
  walk(tree, (e) => seen.push(e));
  return preds.map((p) => seen.findIndex(p));
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const warn = console.warn;
  try {
    const { videoTimeline } = await import("@/lib/videoTimeline");
    const speed = await import("@/lib/editorSpeed");
    const prefs = await import("@/lib/editorPrefs");
    const bf = await import("@/lib/briefFields");
    const core = await import("@/lib/editorQuestionsCore");
    const sc = await import("@/lib/selfCheck");
    const { parseEditorBriefSections } = await import("@/lib/uploadSummary");

    // =====================================================================
    c.head("1 · The pure rules");
    // =====================================================================
    // The timeline: Jordan's own words, "shot, in editing, in review, in revision, in review, delivered".
    const t0 = videoTimeline({ shotAt: ago(72), rounds: [], now: new RealDate(SIM) });
    c.ok("filmed, nothing started: Shot is where it is, then In editing, In review, Delivered ahead", t0.map((s) => `${s.label}:${s.state}`).join(",") === "Shot:current,In editing:next,In review:next,Delivered:next", JSON.stringify(t0));
    const loop = videoTimeline({
      shotAt: ago(96), startedAt: ago(80),
      rounds: [
        { round: 1, status: "CHANGES_REQUESTED", createdAt: ago(60), decidedAt: ago(50) },
        { round: 2, status: "APPROVED", createdAt: ago(30), decidedAt: ago(20) },
      ],
      deliveredAt: ago(10), now: new RealDate(SIM),
    });
    c.ok("a revision loop repeats: Shot, In editing, In review, In revision, Approved, Delivered", loop.map((s) => s.label).join(",") === "Shot,In editing,In review,In revision,Approved,Delivered" && loop.every((s) => s.state === "done"), loop.map((s) => `${s.label}:${s.state}`).join(","));
    const back = videoTimeline({ shotAt: ago(96), startedAt: ago(80), rounds: [{ round: 1, status: "CHANGES_REQUESTED", createdAt: ago(60), decidedAt: ago(50) }], now: new RealDate(SIM) });
    c.ok("sent back: In revision is current, In review and Delivered ahead", back.map((s) => `${s.label}:${s.state}`).join(",") === "Shot:done,In editing:done,In review:done,In revision:current,In review:next,Delivered:next", back.map((s) => `${s.label}:${s.state}`).join(","));
    const reopened = videoTimeline({ shotAt: ago(96), startedAt: ago(80), rounds: [{ round: 1, status: "APPROVED", createdAt: ago(60), decidedAt: ago(50), clientRequestedAt: ago(5) }], now: new RealDate(SIM) });
    c.ok("approved, then the client asked again: back In revision", reopened.map((s) => `${s.label}:${s.state}`).join(",") === "Shot:done,In editing:done,Approved:done,In revision:current,In review:next,Delivered:next", reopened.map((s) => `${s.label}:${s.state}`).join(","));
    // An outside shop (Luma, Cliffside) never presses Start: the office's In editing moves the strip on.
    const shop = videoTimeline({ shotAt: ago(72), inEditing: true, rounds: [], now: new RealDate(SIM) });
    c.ok("with an outside shop, no Start on record: In editing is current", shop.map((s) => `${s.label}:${s.state}`).join(",") === "Shot:done,In editing:current,In review:next,Delivered:next", shop.map((s) => `${s.label}:${s.state}`).join(","));
    const failedUpload = videoTimeline({ startedAt: ago(5), rounds: [{ round: 1, status: "UPLOAD_FAILED", createdAt: ago(2) }], now: new RealDate(SIM) });
    c.ok("a failed upload is not a round", !failedUpload.some((s) => s.key === "review" && s.state !== "next"), failedUpload.map((s) => `${s.label}:${s.state}`).join(","));

    // Editor speed.
    const due = ago(-24);
    const rows = speed.foldEditorSpeed([
      { editorKey: "kim", styleName: "Personal Branding Reel", assignedAt: ago(100), startedAt: ago(96), firstCutAt: ago(72), approvedAt: ago(48), dueAt: ago(40) },
      { editorKey: "kim", styleName: "Personal Branding Reel", assignedAt: ago(60), startedAt: ago(58), firstCutAt: ago(30), approvedAt: null, dueAt: ago(10) },
      { editorKey: "kim", styleName: "Premium Social Media Reel", assignedAt: ago(30), startedAt: ago(29), firstCutAt: ago(20), approvedAt: null, dueAt: due },
      { editorKey: "john", styleName: "Standard Reel", assignedAt: null, startedAt: ago(20), firstCutAt: ago(10), approvedAt: ago(2), dueAt: null },
    ], { now: new RealDate(SIM), editorKeys: ["kim", "john"] });
    const kimRow = rows.find((r) => r.editorKey === "kim");
    c.ok("per editor and per kind of video, most videos first", rows.map((r) => r.editorKey).join() === "kim,john" && kimRow?.byType.map((t) => `${t.styleName}:${t.cell.videos}`).join() === "Personal Branding Reel:2,Premium Social Media Reel:1", JSON.stringify(kimRow?.byType.map((t) => t.styleName)));
    // (4 + 2 + 1) / 3 and (24 + 28 + 9) / 3, to a tenth of an hour.
    c.ok("averages: handoff to Start, Start to first cut, to approval", kimRow?.overall.assignedToStart.hours === 2.3 && kimRow?.overall.startToFirstCut.hours === 20.3 && kimRow?.overall.toApproval.hours === 52, JSON.stringify(kimRow?.overall));
    c.ok("on time: approved by the due date is a hit, unapproved and past due is a miss, not yet due is not counted", kimRow?.overall.onTime.hit === 1 && kimRow?.overall.onTime.of === 2, JSON.stringify(kimRow?.overall.onTime));
    const johnRow = rows.find((r) => r.editorKey === "john");
    c.ok("no handoff time: the total runs from Start; no due date: not counted", johnRow?.overall.toApproval.hours === 18 && johnRow?.overall.assignedToStart.n === 0 && johnRow?.overall.onTime.of === 0, JSON.stringify(johnRow?.overall));
    c.ok("durations in plain words", speed.durationWords(null) === "Not enough data" && speed.durationWords(0.25) === "15 min" && speed.durationWords(5) === "5 h" && speed.durationWords(36) === "1.5 days" && speed.durationWords(24) === "1 day");

    // Technical preferences only (Jordan: "The editor needs to know technical stuff about the edits, or revision requests").
    const keep = ["Fast cuts, no trending audio.", "Always add her animated logo at the end.", "Captions in white, bottom third.", "She sends a lot of small revisions, batch them.", "Warm color grade."];
    const drop = ["Wears navy on camera.", "Prefers a text, not a call.", "Films on Tuesdays only.", "Her kids are in some videos.", "Use the teleprompter."];
    c.ok("the edit stays: pacing, music, logo, captions, revisions, color", keep.every((x) => prefs.isTechnicalPreference(x)), keep.filter((x) => !prefs.isTechnicalPreference(x)).join(" | "));
    c.ok("the shoot and the relationship go: wardrobe, contact habit, filming days, family, teleprompter", drop.every((x) => !prefs.isTechnicalPreference(x)), drop.filter((x) => prefs.isTechnicalPreference(x)).join(" | "));
    c.ok("a portal box keeps only its edit sentences", prefs.technicalLines("Wears navy on camera. Fast cuts with no trending audio. Prefers a text.") === "Fast cuts with no trending audio." && prefs.technicalLines("Wears navy. Films Tuesdays.") === null);
    c.ok("production defaults: a shoot slot is dropped by its name, an edit slot kept", !prefs.isTechnicalDefault({ name: "Wardrobe", text: "navy suit, logo pin" }) && !prefs.isTechnicalDefault({ name: "Preferred filming days", text: "Tuesday" }) && prefs.isTechnicalDefault({ name: "Music", text: "acoustic, never trending" }));

    // The office's brief, in the upload portal's fields.
    const portalText = "STYLE: Fast-Paced\nCOLOR PROFILE: S-Log3\nSONG REQUEST: Requested\nSONG TITLE: Good Days\nSONG LINK: https://open.spotify.com/track/abc\nSONG START: 0:30\n\nVISION FOR THE EDIT\nBright and quick.\n\nSHOTS THAT MUST BE SHOWN\nThe kitchen island.\n\nEDITING NOTES\nOpen on the porch.";
    const fields = bf.readOfficeBrief(portalText);
    c.ok("the form reads the portal's text: style, color profile, vision, video notes, song link and start", fields.style === "Fast-Paced" && fields.colorProfile === "S-Log3" && fields.vision === "Bright and quick." && fields.videoNotes === "Open on the porch." && fields.songLink === "https://open.spotify.com/track/abc" && fields.songStart === "0:30", JSON.stringify(fields));
    const written = bf.writeOfficeBrief(portalText, { ...fields, colorProfile: "D-LogM", vision: "Slow and warm.", songStart: "0:45" });
    const back2 = parseEditorBriefSections(written);
    c.ok("written back: the office's changes, and the photographer's other sections kept", back2.colorProfile === "D-LogM" && back2.style === "Fast-Paced" && back2.sections.find((s) => s.label === "VISION FOR THE EDIT")?.text === "Slow and warm." && back2.sections.find((s) => s.label === "SHOTS THAT MUST BE SHOWN")?.text === "The kitchen island." && /start: 0:45/.test(back2.song ?? "") && /Good Days/.test(back2.song ?? ""), written);
    c.ok("an unchanged form writes the same brief", parseEditorBriefSections(bf.writeOfficeBrief(portalText, fields)).sections.map((s) => s.text).join("|") === parseEditorBriefSections(portalText).sections.map((s) => s.text).join("|"));
    c.ok("the fields' choices are the upload portal's", JSON.stringify(bf.BRIEF_STYLES) === JSON.stringify(["Fast-Paced", "Timeless & Elegant (Cinematic)", "Personal Branding"]) && bf.BRIEF_COLOR_PROFILES.includes("S-Log3") && bf.BRIEF_COLOR_PROFILES.includes("D-LogM"));

    // Who a question goes to.
    c.ok("a note our team left: the creative manager and the person who left it", JSON.stringify(core.questionRecipients({ creativeManagerId: "cm", leftBy: { kind: "staff", teamMemberId: "kyle" } })) === JSON.stringify(["cm", "kyle"]));
    c.ok("a client's ask: the creative manager only (a client is never texted)", JSON.stringify(core.questionRecipients({ creativeManagerId: "cm", leftBy: { kind: "client" } })) === JSON.stringify(["cm"]));
    c.ok("the creative manager left it: texted once; never the asker", JSON.stringify(core.questionRecipients({ creativeManagerId: "cm", leftBy: { kind: "staff", teamMemberId: "cm" } })) === JSON.stringify(["cm"]) && JSON.stringify(core.questionRecipients({ creativeManagerId: "cm", leftBy: { kind: "staff", teamMemberId: "kyle" }, askerTeamMemberId: "cm" })) === JSON.stringify(["kyle"]));
    c.ok("a work order: the office's is staff, a client's (or their email or text) is the client", core.leftByOfBrief("OFFICE", "kyle").kind === "staff" && core.leftByOfBrief("CLIENT", null).kind === "client" && core.leftByOfBrief("EMAIL", null).kind === "client" && core.leftByOfBrief("CLIENT_STAFF", null).kind === "client");
    c.ok("a review note's author key: tm:, owner, a login, an editor", (() => {
      const r = { ownerId: "jordan", userTeamMember: (id: string) => (id === "u1" ? "james" : null), editorTeamMember: (k: string) => (k === "kim" ? "kimtm" : null) };
      const a = core.leftByOfAuthorKey("tm:kyle", r), b = core.leftByOfAuthorKey("owner", r), d = core.leftByOfAuthorKey("user:u1", r), e = core.leftByOfAuthorKey("editor:kim", r), f = core.leftByOfAuthorKey(null, r);
      return a.kind === "staff" && a.teamMemberId === "kyle" && b.kind === "staff" && b.teamMemberId === "jordan" && d.kind === "staff" && d.teamMemberId === "james" && e.kind === "staff" && e.teamMemberId === "kimtm" && f.kind === "unknown";
    })());
    c.ok("the button says who: the creative manager and the reviewer, or the creative manager alone for a client's ask", core.askWhoWords({ sourceKind: "REVIEW_NOTE", raisedByName: "Kyle Drill" }, "James Drill") === "James and Kyle" && core.askWhoWords({ sourceKind: "BRIEF_ITEM", raisedByName: "Ana Client" }, "James Drill", { kind: "CLIENT", by: null }) === "James" && core.askWhoWords({ sourceKind: "REVIEW_NOTE", raisedByName: "James Drill" }, "James Drill") === "James");
    c.ok("…an ask the office recorded names that person; one with no record of who, the creative manager alone", core.askWhoWords({ sourceKind: "BRIEF_ITEM", raisedByName: "Jordan Drill" }, "James Drill", { kind: "OFFICE", by: "Jordan Drill" }) === "James and Jordan" && core.askWhoWords({ sourceKind: "BRIEF_ITEM", raisedByName: "Jordan Drill" }, "James Drill", null) === "James");
    const qt = core.questionText({ asker: "Kim", street: "12 Birch Ln", about: "what to make", words: "Is this   vertical?", link: "https://hub.example/edit/p1#messages" });
    c.ok("the text: who asks, where, what about, the words, the link to the job chat; no dashes", qt === 'Kim has a question on 12 Birch Ln (what to make): "Is this vertical?" Reply in the job chat: https://hub.example/edit/p1#messages' && !/[—–]/.test(qt), qt);

    // The one brand box.
    const plain = sc.resolveSelfCheckProfile("standard_reel", null, null).items.find((i) => i.key === "brand_assets");
    const onFile = sc.resolveSelfCheckProfile("standard_reel", null, { brandOnFile: true }).items.find((i) => i.key === "brand_assets");
    const officeNone = sc.resolveSelfCheckProfile("standard_reel", null, { brandOnFile: true, brandChoice: "none" }).items.find((i) => i.key === "brand_assets");
    c.ok("with their colors or logo on file: ONE box, \"Brand applied (colors and logo).\", no waving it off", onFile?.label === "Brand applied (colors and logo)." && onFile?.naAllowed === false && plain?.label !== onFile?.label, `${plain?.label} -> ${onFile?.label}`);
    c.ok("…the office's \"no logo on this video\" still wins", officeNone?.label === plain?.label && officeNone?.naAllowed === true);
    c.ok("…and the list keeps its key (the attestation stores each line's own words)", sc.resolveSelfCheckProfile("standard_reel", null, { brandOnFile: true }).checklistKey === sc.resolveSelfCheckProfile("standard_reel", null, null).checklistKey);

    // =====================================================================
    c.head("2 · Ask a question: who is texted, where it is recorded");
    // =====================================================================
    const { prisma } = await import("@/lib/prisma");
    const { establishSession } = await import("@/lib/auth/session");
    const dout = await import("@/lib/deliverableOutputs");
    const james = await prisma.teamMember.create({ data: { name: "James Drill", email: "james-drill@example.com", phone: "+12155550142", creativeManager: true }, select: { id: true } });
    const kyle = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com", phone: "+12155550141" }, select: { id: true } });
    const kimTm = await prisma.teamMember.create({ data: { name: "Kim Drill", email: "kim-drill@example.com", phone: "+12155550143" }, select: { id: true } });
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-drill@example.com", phone: "+12155550144" }, select: { id: true } });
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Drill", email: "jordan-drill@example.com", phone: "+12155550140" }, select: { id: true } });
    const kimLogin = await prisma.appUser.create({ data: { email: "kim-drill@example.com", name: "Kim Drill", role: "EDITOR", status: "ACTIVE", editorKey: "kim", teamMemberId: kimTm.id }, select: { id: true } });
    const ownerLogin = await prisma.appUser.create({ data: { email: "jordan-drill@example.com", name: "Jordan Drill", role: "OWNER", status: "ACTIVE", teamMemberId: jordanTm.id }, select: { id: true } });
    const client = await prisma.client.create({ data: { name: "Ana Drill", brandColors: "#0B3D2E, #C9A227", portalVideoStyle: "Fast cuts, no trending audio. Wears navy on camera.", portalPreferences: "Prefers a text, not a call." }, select: { id: true } });
    const instructions0 = "STYLE: Fast-Paced\nCOLOR PROFILE: S-Log3\n\nVISION FOR THE EDIT\nBright and quick.\n\nEDITING NOTES\nOpen on the kitchen.";
    const project = await prisma.project.create({
      data: {
        clientId: client.id, title: "12 Birch Ln, Malvern, PA", status: "EDITING", source: "MANUAL", shootDate: ago(72), photographerId: harrison.id, editorId: kimTm.id,
        handoffReadyAt: ago(70), videoInstructions: instructions0,
        deliverables: { create: [{ type: "SOCIAL_REEL", label: "Premium Social Media Reel", quantity: 1, videoStyle: "premium_social_reel" }] },
      },
      select: { id: true },
    });
    const pid = project.id;
    await dout.ensureOutputsForProject(pid);
    const deliverable = await prisma.deliverable.findFirstOrThrow({ where: { projectId: pid } });
    const out = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: pid } });
    await prisma.deliverableOutput.update({ where: { id: out.id }, data: { promisedAt: ago(-24), ownerKey: "kim", ownerName: "Kim" } });
    await prisma.editorWorkEvent.create({ data: { itemId: `edit-${pid}`, editorKey: "kim", projectId: pid, outputId: out.id, kind: "START", at: ago(48), actorName: "Kim", actorRole: "EDITOR" } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId: pid, deliverableId: deliverable.id, outputId: out.id, slot: out.slot, round: 1, status: "CHANGES_REQUESTED", fileName: "birch-v1.mp4", source: "upload", sourceWidth: 1080, sourceHeight: 1920, submittedByKey: "kim", submittedByName: "Kim", createdAt: ago(24), decidedAt: ago(20), decidedBy: "Kyle Drill", selfCheckedAt: ago(24) }, select: { id: true } });
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { assetUrl: `/api/review/cut/${cut.id}/stream` } });
    const note = await prisma.mediaNote.create({ data: { projectId: pid, assetUrl: `/api/review/cut/${cut.id}/stream`, assetType: "video", lane: "EDITOR", editorKey: "kim", kind: "fix", timeSec: 5, body: "The caption at 0:05 is cut off.", authorKey: `tm:${kyle.id}`, authorName: "Kyle Drill" }, select: { id: true } });
    const issueNote = await prisma.revisionIssue.create({ data: { projectId: pid, outputId: out.id, deliverableId: deliverable.id, slot: out.slot, raisedOnSubmissionId: cut.id, sourceKind: "REVIEW_NOTE", sourceId: note.id, raisedByKey: `tm:${kyle.id}`, raisedByName: "Kyle Drill", originalText: "The caption at 0:05 is cut off.", summary: "Caption at 0:05 is cut off", timeSec: 5, state: "OPEN" }, select: { id: true } });
    const clientBrief = await prisma.revisionBrief.create({ data: { projectId: pid, outputId: out.id, source: "review_room", requestedBy: "Ana Drill", requestedByKind: "CLIENT", originalText: "Can the music be calmer?" }, select: { id: true } });
    const issueClient = await prisma.revisionIssue.create({ data: { projectId: pid, outputId: out.id, deliverableId: deliverable.id, slot: out.slot, sourceKind: "BRIEF_ITEM", sourceId: `${clientBrief.id}:i1:${deliverable.id}:${out.slot}`, sourceChannel: "portal", raisedByName: "Ana Drill", originalText: "Can the music be calmer?", summary: "Calmer music", state: "OPEN" }, select: { id: true } });
    const officeBrief = await prisma.revisionBrief.create({ data: { projectId: pid, outputId: out.id, source: "manual", requestedBy: "Jordan Drill", requestedByKind: "OFFICE", requestedByUserId: ownerLogin.id, originalText: "Swap the opening shot." }, select: { id: true } });
    const issueOffice = await prisma.revisionIssue.create({ data: { projectId: pid, outputId: out.id, deliverableId: deliverable.id, slot: out.slot, sourceKind: "BRIEF_ITEM", sourceId: `${officeBrief.id}:i1:${deliverable.id}:${out.slot}`, sourceChannel: "review_room_staff", raisedByName: "Jordan Drill", originalText: "Swap the opening shot.", summary: "Swap the opening shot", state: "OPEN" }, select: { id: true } });

    const { askEditQuestion } = await import("@/lib/editorQuestions");
    const asKim = { name: "Kim", teamMemberId: kimTm.id, userId: kimLogin.id };
    const lastEvent = (issueId: string) => prisma.revisionIssueEvent.findFirst({ where: { issueId, kind: "EDITOR_QUESTION" }, orderBy: { at: "desc" } });
    await establishSession(kimLogin.id);
    const r1 = await askEditQuestion({ projectId: pid, target: { kind: "issue", id: issueNote.id }, words: "Move it up or shorten it?", asker: asKim });
    const e1 = await lastEvent(issueNote.id);
    c.ok("Kyle's review note: James (creative manager) and Kyle (who left it)", r1.ok && /James and Kyle/.test(r1.message) && (e1?.toValue ?? "").split(",").sort().join() === [james.id, kyle.id].sort().join(), `${r1.message} · ${e1?.toValue}`);
    c.ok("…recorded on the note itself, with the words and who asked", e1?.note === "Move it up or shorten it?" && e1?.actorName === "Kim" && e1?.actorUserId === kimLogin.id);
    const msg1 = await prisma.projectMessage.findFirst({ where: { projectId: pid, body: { contains: "Move it up or shorten it?" } } });
    c.ok("…posted in the job's team messages, with no @-tag (so nobody is pinged twice)", !!msg1 && /^Question about the note "Caption at 0:05 is cut off": Move it up or shorten it\? \(texted to James and Kyle\)$/.test(msg1.body) && (!msg1.mentions || msg1.mentions === "[]"), msg1?.body ?? "none");
    const r2 = await askEditQuestion({ projectId: pid, target: { kind: "issue", id: issueClient.id }, words: "How much calmer?", asker: asKim });
    const e2 = await lastEvent(issueClient.id);
    c.ok("the client's ask: James only, never the client", r2.ok && /Sent to James\.|text to James did/.test(r2.message) && e2?.toValue === james.id, `${r2.message} · ${e2?.toValue}`);
    const r3 = await askEditQuestion({ projectId: pid, target: { kind: "issue", id: issueOffice.id }, words: "Which shot instead?", asker: asKim });
    const e3 = await lastEvent(issueOffice.id);
    c.ok("an ask the office wrote: James and the office person who wrote it (Jordan)", r3.ok && (e3?.toValue ?? "").split(",").sort().join() === [james.id, jordanTm.id].sort().join(), `${r3.message} · ${e3?.toValue}`);
    const r4 = await askEditQuestion({ projectId: pid, target: { kind: "make" }, words: "Vertical or horizontal?", asker: asKim });
    const act4 = await prisma.activity.findFirst({ where: { projectId: pid, body: { contains: "Vertical or horizontal?" } } });
    c.ok("What to make: James and the photographer who wrote the instructions (Harrison), on the job's activity", r4.ok && /James and Harrison/.test(r4.message) && !!act4 && /asked about what to make/.test(act4.body), `${r4.message} · ${act4?.body}`);
    const r5 = await askEditQuestion({ projectId: pid, target: { kind: "issue", id: issueNote.id }, words: "Kim, which version?", asker: { name: "James", teamMemberId: james.id, userId: null } });
    c.ok("the creative manager asking is not texted his own question", r5.ok && /Sent to Kyle\.|text to Kyle did/.test(r5.message), r5.message);
    const r6 = await askEditQuestion({ projectId: pid, target: { kind: "issue", id: issueNote.id }, words: " ", asker: asKim });
    const r7 = await askEditQuestion({ projectId: pid, target: { kind: "issue", id: "nope123456" }, words: "Anything?", asker: asKim });
    c.ok("an empty question, or a note not on this job, sends nothing", !r6.ok && !r7.ok);
    const clientPhones = await prisma.pendingSms.count({ where: { teamMemberId: { notIn: [james.id, kyle.id, jordanTm.id, harrison.id] } } }).catch(() => 0);
    c.ok("no line was queued for anyone else", clientPhones === 0);

    const { askEditQuestionAction } = await import("@/app/edit/[id]/brief.actions");
    const a1 = await askEditQuestionAction(pid, { kind: "issue", id: issueNote.id }, "Through the action?");
    c.ok("the brief's button: Kim, on her own job, may ask", a1.ok, a1.message);
    const a2 = await askEditQuestionAction(pid, { kind: "issue", id: "../../etc" } as never, "Bad id");
    c.ok("…an id that is not an id is refused", !a2.ok);
    const otherJob = await prisma.project.create({ data: { clientId: client.id, title: "9 Other St, Malvern, PA", status: "EDITING", source: "MANUAL" }, select: { id: true } });
    const a3 = await askEditQuestionAction(otherJob.id, { kind: "make" }, "Not mine?");
    c.ok("…a job that is not hers is refused", !a3.ok && /not on your list/.test(a3.message), a3.message);

    // =====================================================================
    c.head("3 · The final check's brand box follows what is on file");
    // =====================================================================
    const { checkContextsForProject } = await import("@/lib/selfCheckStore");
    const ctx1 = Object.values(await checkContextsForProject(pid))[0];
    c.ok("hex colors on the client: the one box \"Brand applied (colors and logo).\"", ctx1?.profile.items.find((i) => i.key === "brand_assets")?.label === sc.BRAND_APPLIED_LABEL, ctx1?.profile.items.map((i) => i.label).join(" | "));
    // "bad" is three hex letters: a color is written with its "#".
    await prisma.client.update({ where: { id: client.id }, data: { brandColors: "navy and a bad gold" } });
    const ctx2 = Object.values(await checkContextsForProject(pid))[0];
    c.ok("only words, no hex and no kit file: the list as before", ctx2?.profile.items.find((i) => i.key === "brand_assets")?.label !== sc.BRAND_APPLIED_LABEL, ctx2?.profile.items.find((i) => i.key === "brand_assets")?.label);
    await prisma.client.update({ where: { id: client.id }, data: { brandColors: "#0B3D2E, #C9A227" } });

    // =====================================================================
    c.head("4 · The page, as Kim");
    // =====================================================================
    const EditPage = (await import("@/app/edit/[id]/page")).default;
    const view = async (search: Record<string, string> = {}) => {
      console.warn = () => {};
      try { return await EditPage({ params: Promise.resolve({ id: pid }), searchParams: Promise.resolve(search) } as never); }
      finally { console.warn = warn; }
    };
    await establishSession(kimLogin.id);
    const kim = await view();
    const header = section(kim, "header");
    const make = section(kim, "make");
    c.ok("What to make, one line at the top of the job bar: Premium Social Media Reel", !!header && !!make && /What to make: Premium Social Media Reel/.test(said(find(make, (e) => "data-what-to-make" in (e.props ?? {}))[0])) && find(header, (e) => e === make).length === 1, said(make).slice(0, 160));
    const details = find(make, (e) => "data-job-details" in (e.props ?? {}))[0];
    c.ok("…the specs line and the examples folded under Details (closed)", !!details && details.type === "details" && !details.props.open && find(details, (e) => "data-make-this" in (e.props ?? {})).length === 1);
    const askMake = named(make, "AskQuestionButton")[0];
    c.ok("…with a small Ask a question beside it, to James and Harrison", askMake?.props.target?.kind === "make" && askMake?.props.who === "James and Harrison", JSON.stringify(askMake?.props.who));
    const strip = named(header, "StageStrip")[0];
    c.ok("the video's timeline in the job bar: Shot, In editing, In review, In revision (now), In review, Delivered", (strip?.props.steps ?? []).map((s: { label: string; state: string }) => `${s.label}:${s.state}`).join(",") === "Shot:done,In editing:done,In review:done,In revision:current,In review:next,Delivered:next", JSON.stringify(strip?.props.steps?.map((s: { label: string }) => s.label)));
    const actions = find(header, (e) => "data-job-actions" in (e.props ?? {}))[0];
    c.ok("the job bar's main button is Upload version 2; no second Open footage", named(actions, "UploadTrigger").some((t) => t.props.label === "Upload version 2") && !/Open (raw )?footage/.test(said(actions)), said(actions));
    const panel = named(kim, "UploadPanel")[0];
    const panelSrc0 = read("src/components/editing/UploadPanel.tsx");
    c.ok("the panel is where every upload link lands: #submit-cut and #upload in both its forms, closed until opened", (panelSrc0.match(/id="submit-cut"/g) ?? []).length === 2 && (panelSrc0.match(/<span id="upload"/g) ?? []).length === 2 && /hidden=\{!open\}/.test(panelSrc0) && /OPEN_UPLOAD_EVENT/.test(read("src/components/editing/UploadTrigger.tsx")));
    c.ok("the upload sits in a panel the button opens (no Send for review block)", !!panel && panel.props.mode === "panel" && panel.props.title === "Upload version 2" && named(panel, "CutUploader").length === 1 && !section(kim, "send"), JSON.stringify({ mode: panel?.props.mode, title: panel?.props.title }));
    const fix = section(kim, "changes");
    const cutPanel = named(fix, "EditorCutPanel")[0];
    const whoOf = (id: string) => cutPanel?.props.issues?.find((i: { id: string }) => i.id === id)?.askWho;
    c.ok("Fix these: each note with its Ask a question, saying who it goes to (as the send decides)", cutPanel?.props.ask === true && whoOf(issueNote.id) === "James and Kyle" && whoOf(issueClient.id) === "James" && whoOf(issueOffice.id) === "James and Jordan", JSON.stringify(cutPanel?.props.issues?.map((i: { askWho?: string }) => i.askWho)));
    const seq = order(kim, [
      (e) => e.props?.["data-brief-section"] === "header",
      (e) => e.props?.["data-brief-section"] === "changes",
      (e) => e.props?.["data-brief-section"] === "messages",
      (e) => e.props?.["data-brief-section"] === "brand",
      (e) => e.props?.["data-brief-section"] === "footage",
      (e) => e.props?.["data-brief-section"] === "instructions",
    ]);
    c.ok("the order: job bar, Fix these, team messages, their brand, footage, instructions", seq.every((i, k) => i >= 0 && (k === 0 || i > seq[k - 1])), seq.join(","));
    const scriptSec = section(kim, "script");
    c.ok("…the script (or the line saying there is none) inside the instructions", !!scriptSec && find(section(kim, "instructions"), (e) => e === scriptSec).length === 1);
    const footage = section(kim, "footage");
    c.ok("one Open raw footage, in Footage, with the footage notes and checks", find(kim, (e) => "data-footage-link" in (e.props ?? {})).length === 1 && find(footage, (e) => "data-footage-link" in (e.props ?? {})).length === 1 && find(footage, (e) => "data-keep-raws" in (e.props ?? {})).length === 1);
    const instr = section(kim, "instructions");
    const iw = said(instr);
    c.ok("instructions: the style, the color profile, the vision and the video notes, each on its own", /Style Fast-Paced/.test(iw) && /Color profile S-Log3/.test(iw) && /Vision for the edit Bright and quick\./i.test(iw) && /Open on the kitchen\./.test(iw) && !/COLOR PROFILE:/.test(iw), iw.slice(0, 300));
    c.ok("their words: only the edit (\"Fast cuts, no trending audio.\"), not \"wears navy\" or \"prefers a text\"", /Fast cuts, no trending audio\./.test(iw) && !/navy|Prefers a text/.test(said(kim)), iw.slice(0, 400));
    c.ok("no \"not approved by the client\" anywhere on the brief", !/[Nn]ot approved by the client|Approved by the client/.test(said(kim)) && find(kim, (e) => "data-not-approved" in (e.props ?? {})).length === 0);
    c.ok("no half-shot card on the editor's brief", named(kim, "SecondShootCard").length === 0);
    const brand = section(kim, "brand");
    c.ok("their brand right there: the colors as swatches, and the one-box line for the final check", /#0B3D2E/.test(said(brand)) && find(brand, (e) => "data-brand-enforced" in (e.props ?? {})).length === 1, said(brand).slice(0, 200));
    const aside = find(kim, (e) => e.type === "aside" && e.props?.["data-brief-section"] === "client")[0];
    c.ok("the client's profile in a side column (not under the brief)", !!aside && /lg:sticky/.test(aside.props.className ?? "") && find(find(kim, (e) => e.type === "article")[0], (e) => e === aside).length === 0);
    c.ok("no office tools for Kim", find(kim, (e) => "data-office-tools" in (e.props ?? {})).length === 0 && named(kim, "OfficeBriefForm").length === 0);

    // =====================================================================
    c.head("5 · The page, as the office with its tools on");
    // =====================================================================
    await establishSession(ownerLogin.id);
    const office = await view({ office: "1" });
    const tools = find(office, (e) => "data-office-tools" in (e.props ?? {}))[0];
    const [toolsAt, changesAt] = order(office, [(e) => "data-office-tools" in (e.props ?? {}), (e) => e.props?.["data-brief-section"] === "changes"]);
    c.ok("the office tools sit at the top, above Fix these", !!tools && toolsAt >= 0 && changesAt > toolsAt, `${toolsAt} < ${changesAt}`);
    const form = named(tools, "OfficeBriefForm")[0];
    c.ok("the office writes the brief there, in the upload portal's fields", !!form && form.props.initial.style === "Fast-Paced" && form.props.initial.colorProfile === "S-Log3" && form.props.initial.vision === "Bright and quick." && form.props.initial.videoNotes === "Open on the kitchen." && form.props.current === instructions0, JSON.stringify(form?.props.initial));
    c.ok("the half-shot hold is there, and only there", named(tools, "SecondShootCard").length === 1 && named(office, "SecondShootCard").length === 1);
    c.ok("the office asks nothing through the editor's buttons", !named(office, "EditorCutPanel").some((p) => p.props.ask));
    const officeOff = await view();
    c.ok("tools off: no half-shot card, no brief form", named(officeOff, "SecondShootCard").length === 0 && named(officeOff, "OfficeBriefForm").length === 0);

    // =====================================================================
    c.head("6 · The office writes the brief");
    // =====================================================================
    const { saveOfficeBriefAction } = await import("@/app/edit/[id]/brief.actions");
    const f0 = bf.readOfficeBrief(instructions0);
    const s1 = await saveOfficeBriefAction(pid, null, { ...f0, vision: "Slow and warm.", songLink: "https://open.spotify.com/track/xyz", songStart: "0:15" }, instructions0);
    const after = (await prisma.project.findUniqueOrThrow({ where: { id: pid }, select: { videoInstructions: true } })).videoInstructions ?? "";
    const pa = parseEditorBriefSections(after);
    c.ok("saved into the same instructions text the upload portal writes", s1.ok && pa.style === "Fast-Paced" && pa.colorProfile === "S-Log3" && pa.sections.find((s) => s.label === "VISION FOR THE EDIT")?.text === "Slow and warm." && pa.sections.find((s) => s.label === "EDITING NOTES")?.text === "Open on the kitchen." && /open\.spotify\.com\/track\/xyz/.test(pa.song ?? "") && /0:15/.test(pa.song ?? ""), `${s1.message} · ${after}`);
    const s2 = await saveOfficeBriefAction(pid, null, { ...f0, vision: "Stale." }, instructions0);
    c.ok("a form opened before someone else saved is refused, nothing overwritten", !s2.ok && /changed while you were writing/.test(s2.message) && (await prisma.project.findUniqueOrThrow({ where: { id: pid }, select: { videoInstructions: true } })).videoInstructions === after);
    const s3 = await saveOfficeBriefAction(pid, null, { ...f0, songLink: "not a link" }, after);
    c.ok("a song link that is not a web address is refused", !s3.ok && /isn't a web address/.test(s3.message), s3.message);
    await establishSession(kimLogin.id);
    const s4 = await saveOfficeBriefAction(pid, null, { ...f0, vision: "Kim's own." }, after);
    c.ok("an editor cannot write the office's brief", !s4.ok);

    // =====================================================================
    c.head("7 · Editor speed in the Editing Room");
    // =====================================================================
    await prisma.reviewSubmission.create({ data: { projectId: pid, deliverableId: deliverable.id, outputId: out.id, slot: out.slot, round: 2, status: "APPROVED", fileName: "birch-v2.mp4", source: "upload", submittedByKey: "kim", submittedByName: "Kim", createdAt: ago(6), decidedAt: ago(4), decidedBy: "Kyle Drill", selfCheckedAt: ago(6) } });
    const report = await speed.editorSpeedReport({ days: 30, now: new RealDate(SIM) });
    const kimR = report.rows.find((r) => r.editorKey === "kim");
    c.ok("Kim's row: one Premium Social Media Reel, handoff to Start 22 h, Start to first cut 24 h, to approval 66 h, on time", !!kimR && kimR.overall.videos === 1 && kimR.byType[0]?.styleName === "Premium Social Media Reel" && kimR.overall.assignedToStart.hours === 22 && kimR.overall.startToFirstCut.hours === 24 && kimR.overall.toApproval.hours === 66 && kimR.overall.onTime.hit === 1 && kimR.overall.onTime.of === 1, JSON.stringify(kimR?.overall));
    c.ok("John is listed with nothing yet", report.rows.some((r) => r.editorKey === "john" && r.overall.videos === 0));
    const room = read("src/app/editing/page.tsx");
    c.ok("the Editing Room shows it to the owner and the creative manager only (not the admin, not an editor)", /const seesSpeed = [^;]*OWNER[^;]*CREATIVE_MANAGER/.test(room) && !/const seesSpeed = [^;]*"ADMIN"/.test(room) && /seesSpeed && [^\n]*<EditorSpeedPanel/.test(room.replace(/\n\s*/g, " ")) , (room.match(/const seesSpeed = [^;]*;/) ?? [""])[0]);
    const panelSrc = read("src/components/editing/EditorSpeedPanel.tsx");
    c.ok("…per editor, per kind of video, with the last 30 or 90 days and what they are on now", /\[30, 90\]/.test(panelSrc) && /Last \{d\} days/.test(panelSrc) && /data-speed-editor/.test(panelSrc) && /Working on/.test(panelSrc));

    // =====================================================================
    c.head("8 · The words");
    // =====================================================================
    const files = ["src/app/edit/[id]/page.tsx", "src/components/editing/AskQuestionButton.tsx", "src/components/editing/StageStrip.tsx", "src/components/editing/UploadPanel.tsx", "src/components/editing/OfficeBriefForm.tsx", "src/components/editing/EditorSpeedPanel.tsx", "src/lib/editorQuestionsCore.ts", "src/app/edit/[id]/brief.actions.ts"];
    // Comments may quote the old words; only the code's own strings count.
    const code = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const strings = (src: string) => [...code(src).matchAll(/"([^"\n]{12,})"|`([^`\n]{12,})`|>([^<>{}\n]{12,})</g)].map((m) => m[1] ?? m[2] ?? m[3]).filter((x) => !/^(\/\/|https?:|[a-z-]+ [a-z-]+:|min-|flex|inline|rounded|text-|grid|mt-|space-|border|bg-)/.test(x));
    const dashed = files.flatMap((f) => strings(read(f)).filter((s) => /[—–]/.test(s)).map((s) => `${f}: ${s.slice(0, 60)}`));
    c.ok("no em or en dashes in the new words the team reads", dashed.length === 0, dashed.slice(0, 4).join(" | "));
    c.ok("nothing left the machine", fence.faked.length === 0, `blocked ${fence.blocked.length}`);
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  c.summary();
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
