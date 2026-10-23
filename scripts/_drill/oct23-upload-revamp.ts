// ---------------------------------------------------------------------------
// DRILL: THE UPLOAD PAGE REVAMP (Oct 23 2026, Jordan's spec + the two
// additions: an agent request added on site, a service added on site).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-upload-revamp.ts
//
// Isolated PGlite with real sessions (AUTH_ENFORCE on); no provider call
// leaves the process (the fence). The page's own client half is drilled in
// oct23-upload-revamp-ui.ts.
//
//   1. The rules (pure): one photographer is the standard page, two or more on
//      the shoot's appointments is a shared shoot (crew counts, a cancelled
//      visit does not, an address never does); each person's halves; a song
//      line is never instructions (gate, handoff engine, KPI words).
//   2. The single flow: the page hands the agent's requests with their
//      sources (this visit apart from history), no shared mode; a submit
//      records the person's part and stamps the job exactly as before.
//   3. The shared flow: each photographer submits their own part; James's
//      submit never marks Harrison's; the halves and the whole stamp land as
//      the existing split submit always did.
//   4. Shared instructions: both see them; a stale save is refused with
//      "<who> changed this; here's their version", nothing written, history
//      kept; a change after the handoff is marked.
//   5. Conflicts: two instructions pointing opposite ways are flagged on the
//      editor's brief and the packet, both kept.
//   6. The song request: per video, on the brief and the packet; a request
//      with neither title nor link is refused; a song alone never passes the
//      instructions gate.
//   7. An agent request added on site: filed once through the client-ask path,
//      at the top of the page, on the editor's brief and Kyle's board; the
//      same words again (or an order note's words) are not filed twice.
//   8. A service added on site: the Added at the shoot card (unchanged), its
//      video's instructions saved before the office adds it, attached to the
//      video row when it appears, and on the brief as its own video.
//   9. Opening Dropbox is not "uploaded"; nothing here touches pay or the KPI
//      evidence.
// ---------------------------------------------------------------------------
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7421);

// ---- the clock: Fri Oct 23 2026, 6:00 PM ET ----------------------------------------
const RealDate = Date;
const SIM = RealDate.parse("2026-10-23T22:00:00.000Z");
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

// The page's element tree is walked, not rendered: the client portal is a
// named stand-in carrying the props the page hands it.
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
const said = (n: any) => words(n).join("").replace(/\s+/g, " ").trim();
function words(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (isEl(n)) words(n.props.children, out);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const warn = console.warn;
  try {
    const { prisma } = await import("@/lib/prisma");
    const core = await import("@/lib/sharedShootCore");
    const song = await import("@/lib/songRequest");
    const { meaningfulBrief } = await import("@/lib/handoff");
    const { ownWords, loadEvidence } = await import("@/lib/kpiEvidence");
    const { establishSession } = await import("@/lib/auth/session");
    const { finalizeUpload, addShootAddOn } = await import("@/app/upload/actions");
    const shared = await import("@/app/upload/sharedActions");
    const ss = await import("@/lib/sharedShoot");
    const dout = await import("@/lib/deliverableOutputs");
    const { computePayroll } = await import("@/lib/payroll");
    const { shootEarnings } = await import("@/lib/shoot");

    // =====================================================================
    c.head("1 · The rules (pure)");
    // =====================================================================
    const H = { id: "m-h", name: "Harrison" };
    const names = new Map([["m-h", "Harrison"], ["m-j", "James"]]);
    const one = core.rosterOf({ photographer: H, appointments: [{ assignedToId: "m-h", status: "SCHEDULED" }], crew: [], names });
    c.ok("one photographer on the shoot's appointments: the standard page", !one.shared && one.members.length === 1);
    const two = core.rosterOf({ photographer: H, appointments: [{ assignedToId: "m-h", status: "SCHEDULED" }, { assignedToId: "m-j", status: "SCHEDULED" }], crew: [], names });
    c.ok("two photographers on its appointments: shared, automatically", two.shared && two.members.map((m) => m.name).join(",") === "Harrison,James");
    const cancelled = core.rosterOf({ photographer: H, appointments: [{ assignedToId: "m-h", status: "SCHEDULED" }, { assignedToId: "m-j", status: "CANCELED" }], crew: [], names });
    c.ok("a cancelled visit's photographer does not make it shared", !cancelled.shared);
    const crewed = core.rosterOf({ photographer: H, appointments: [{ assignedToId: "m-h", status: "SCHEDULED" }], crew: [{ memberId: "m-j", name: "James" }], names });
    c.ok("a second shooter the office added (crew) is on the shoot", crewed.shared && crewed.members[1].via === "crew");
    c.ok("the same person on two visits is still one photographer", !core.rosterOf({ photographer: H, appointments: [{ assignedToId: "m-h", status: "SCHEDULED" }, { assignedToId: "m-h", status: "SCHEDULED" }], crew: [], names }).shared);
    c.ok("each person hands off the halves of what THEY captured; the single page keeps the job's", JSON.stringify(core.halvesToSubmit({ shared: true, liveHalves: ["photos", "video"], myServices: ["video"] })) === '["video"]' && JSON.stringify(core.halvesToSubmit({ shared: true, liveHalves: ["photos", "video"], myServices: ["floorplan"] })) === "[]" && JSON.stringify(core.halvesToSubmit({ shared: false, liveHalves: ["photos", "video"], myServices: [] })) === '["photos","video"]');
    const s1 = { mode: "requested" as const, title: "Good Days by LAKEY INSPIRED", link: "open.spotify.com/track/abc", start: "0:30" };
    const lines = song.songLines(s1);
    c.ok("a song request composes into machine lines (and a bare link gets https://)", lines.join("|") === "SONG REQUEST: Requested|SONG TITLE: Good Days by LAKEY INSPIRED|SONG LINK: https://open.spotify.com/track/abc|SONG START: 0:30", lines.join("|"));
    const back = song.songOfText(`COLOR PROFILE: iPhone\n${lines.join("\n")}\n\nEDITING NOTES\nQuick cuts.`);
    c.ok("…and reads back the same", back?.mode === "requested" && back.title === s1.title && back.link === "https://open.spotify.com/track/abc" && back.start === "0:30");
    c.ok("one of title or link is enough; neither is a problem; No request is an answer", !song.songProblem({ mode: "requested", title: "", link: "youtu.be/x1", start: "" }) && !song.songProblem({ mode: "requested", title: "Sweet Home Alabama", link: "", start: "" }) && !!song.songProblem({ mode: "requested", title: "", link: "", start: "" }) && !song.songProblem({ mode: "none", title: "", link: "", start: "" }));
    c.ok("the old free-text song box reads as a requested song (nothing typed there is lost)", song.songOfText("EDITING NOTES\nx\n\nSONG OR MUSIC\nUpbeat, something they can post")?.title === "Upbeat, something they can post");
    const onlySong = `COLOR PROFILE: iPhone\n${lines.join("\n")}`;
    c.ok("a song line is never instructions: the handoff engine, the KPI's word count", meaningfulBrief(onlySong) === "" && ownWords(onlySong) === 0, `${meaningfulBrief(onlySong)} / ${ownWords(onlySong)}`);
    const cf = core.findConflicts([
      { id: "a", who: "James", text: "Feature the pool at dusk.", source: "instruction" },
      { id: "b", who: "Harrison", text: "Skip the pool shots, the cover is on.", source: "instruction" },
      { id: "c", who: "James", text: "Feature the kitchen island.", source: "instruction" },
    ]);
    c.ok("two instructions pointing opposite ways about the same thing are flagged; agreeing ones are not", cf.length === 1 && cf[0].subject === "pool", JSON.stringify(cf.map((x) => x.subject)));

    // ---- the world --------------------------------------------------------
    const client = await prisma.client.create({ data: { name: "Georgiana Drill" }, select: { id: true } });
    const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-rv@drill.invalid", role: "PHOTOGRAPHER", phone: "6105550142", active: true, payPercent: 0.35, payFloor: 100 }, select: { id: true } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James Drill", email: "james-rv@drill.invalid", role: "PHOTOGRAPHER", phone: "6105550143", active: true, payPercent: 0.35, payFloor: 100 }, select: { id: true } });
    const harrison = await prisma.appUser.create({ data: { email: "harrison-rv@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrisonTm.id }, select: { id: true } });
    const james = await prisma.appUser.create({ data: { email: "james-rv@drill.invalid", name: "James Drill", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: jamesTm.id }, select: { id: true } });
    const owner = await prisma.appUser.create({ data: { email: "jordan-rv@drill.invalid", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
    await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-rv@drill.invalid", role: "ADMIN" } });
    for (const e of ["harrison-rv@drill.invalid", "james-rv@drill.invalid"]) await prisma.appSetting.create({ data: { key: `upload-ack-${e}`, value: "true" } });
    const SHOT = new RealDate("2026-10-23T14:00:00.000Z");
    let n = 0;
    const job = async (street: string, rows: { type: string; label: string; videoStyle?: string }[], appts: { who: string; at?: Date; status?: string; description?: string }[]) => {
      n++;
      const p = await prisma.project.create({
        data: {
          title: `${street}, Malvern, PA`, addressLine: street, clientId: client.id, status: "SCHEDULED", shootDate: SHOT, photographerId: appts[0].who, price: 500 + n,
          deliverables: { create: rows.map((r) => ({ type: r.type as never, label: r.label, quantity: 1, ...(r.videoStyle ? { videoStyle: r.videoStyle } : {}) })) },
        },
        select: { id: true },
      });
      let k = 0;
      for (const a of appts) await prisma.appointment.create({ data: { aryeoId: `rv-${n}-${++k}`, projectId: p.id, startAt: a.at ?? SHOT, status: a.status ?? "SCHEDULED", assignedToId: a.who, description: a.description ?? null } });
      await dout.ensureOutputsForProject(p.id);
      return p.id;
    };
    const UploadPage = (await import("@/app/upload/[id]/page")).default;
    const portalOf = async (id: string) => {
      console.warn = () => {};
      try { return find(await UploadPage({ params: Promise.resolve({ id }) } as never), (e) => typeName(e.type) === "UploadPortal")[0]; }
      finally { console.warn = warn; }
    };
    const payBefore = JSON.stringify(await computePayroll(new RealDate("2026-10-01T00:00:00-04:00"), new RealDate("2026-10-31T23:59:59-04:00")));

    // =====================================================================
    c.head("2 · The single flow");
    // =====================================================================
    const single = await job("2865 Greenleaf Ct", [{ type: "PHOTOS", label: "Photos" }, { type: "DRONE", label: "Drone Photos" }], [{
      who: harrisonTm.id,
      description: "Customer: Georgiana\n\nOrder Questions:\n - Lock Box / Door Code: 4417\n - Special Instructions for the photographer (for this property only): Please feature the backyard and pool. The lockbox code is 4417.\n - Will you or the seller be present at the appointment?: Vacant\n\nOr View Full Order Details",
    }]);
    await prisma.activity.create({ data: { projectId: single, type: "SPECIAL_REQUEST", body: "Avoid the unfinished garage." } });
    const { createAsk } = await import("@/lib/clientAsks");
    await createAsk({ clientId: client.id, projectId: single, kind: "SPECIAL_REQUEST", medium: "photo", text: "Can you make sure the twilight sky looks natural?", source: "text", askedBy: "Georgiana Drill", by: "hub" });
    await createAsk({ clientId: client.id, projectId: single, kind: "SPECIAL_REQUEST", medium: "photo", text: "Old ask that was handled already about the mailbox.", source: "text", askedBy: "Georgiana Drill", by: "hub", askedAt: new RealDate("2026-10-20T14:00:00Z") });
    const old = await prisma.clientAsk.findFirstOrThrow({ where: { projectId: single, text: { startsWith: "Old ask" } } });
    await prisma.clientAsk.update({ where: { id: old.id }, data: { state: "CONFIRMED", confirmedAt: new RealDate("2026-10-21T14:00:00Z"), confirmedBy: "Kyle Drill" } });
    await establishSession(harrison.id);
    const sp = await portalOf(single);
    const reqs = (sp?.props.agentRequests ?? []) as { text: string; source: string; sourceWords: string; group: string; link: { href: string } | null; original: string }[];
    c.ok("the page hands the portal the agent's requests", reqs.length >= 3, JSON.stringify(reqs.map((r) => `${r.source}:${r.group}`)));
    const orderNote = reqs.find((r) => r.source === "order_note");
    c.ok("an order note, its source named and the original one tap away (the shoot screen)", !!orderNote && /backyard and pool/.test(orderNote.text) && orderNote.sourceWords.startsWith("Order notes") && orderNote.link?.href === `/shoot/${single}`, JSON.stringify(orderNote));
    c.ok("…the lockbox line is not a request (it stays on the shoot screen)", !reqs.some((r) => r.group !== "history" && /4417/.test(r.text)));
    c.ok("the office's line and the client's text, each with where it came from", reqs.some((r) => r.source === "office" && /unfinished garage/.test(r.text)) && reqs.some((r) => r.source === "client_ask" && /twilight sky/.test(r.text) && /Text from Georgiana Drill/.test(r.sourceWords)));
    c.ok("this shoot's requests apart from the handled one (history)", reqs.find((r) => /twilight sky/.test(r.text))?.group === "visit" && reqs.find((r) => /mailbox/.test(r.text))?.group === "history");
    c.ok("one photographer: the standard page (not shared), and this viewer is on it", sp?.props.sharedShoot?.shared === false && sp?.props.sharedShoot?.me?.memberId === harrisonTm.id);
    c.ok("the page hands the folders as data with their buttons' links, and no uploader", Array.isArray(sp?.props.folders) || sp?.props.folders === null);
    const singleRes = await finalizeUpload(single, {
      editorBrief: "House faces west.", force: true, cullingConfirmed: true, shotOrder: { mode: "front-to-back" }, nothingToRemove: true, removalNotes: "", captured: ["photos", "drone"],
    } as never);
    const sAfter = await prisma.project.findUniqueOrThrow({ where: { id: single }, select: { debriefSubmittedAt: true, photosHandoffAt: true, editorBrief: true } });
    c.ok("the submit stamps the job exactly as the single page always did (whole stamp, no half stamp)", !singleRes.blocked && !!sAfter.debriefSubmittedAt && !sAfter.photosHandoffAt && sAfter.editorBrief === "House faces west.", JSON.stringify(singleRes).slice(0, 200));
    const sPart = (await ss.readContributions(single)).get(harrisonTm.id);
    c.ok("…and records Harrison's own part: what he captured, and his submit", !!sPart && sPart.captured.join(",") === "photos,drone" && core.contributionState(sPart) === "submitted");

    // =====================================================================
    c.head("3 · The shared flow: each submits their own part");
    // =====================================================================
    const sharedJob = await job("1 Shared Shoot Ln", [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Standard Reel", videoStyle: "standard_reel" }], [{ who: harrisonTm.id }, { who: jamesTm.id }]);
    const hp = await portalOf(sharedJob);
    c.ok("two photographers on the shoot's appointments: shared mode, no toggle", hp?.props.sharedShoot?.shared === true && hp.props.sharedShoot.members.length === 2 && hp.props.sharedShoot.me?.name === "Harrison Drill");
    const capH = await shared.saveMyCapture(sharedJob, { captured: ["video"], videoDrone: true });
    await establishSession(james.id);
    const capJ = await shared.saveMyCapture(sharedJob, { captured: ["photos"], videoDrone: false });
    c.ok("each person's capture is their own part", capH.ok && capJ.ok && capH.contribution?.memberId === harrisonTm.id && capJ.contribution?.memberId === jamesTm.id);
    const jp = await portalOf(sharedJob);
    const seen = (jp?.props.sharedShoot?.contributions ?? []) as { memberId: string; captured: string[]; videoDrone: boolean }[];
    c.ok("James's page shows what Harrison filled in (video, with drone footage)", seen.some((x) => x.memberId === harrisonTm.id && x.captured.join() === "video" && x.videoDrone));
    const photosOnly = await finalizeUpload(sharedJob, {
      editorBrief: "", force: true, scope: "photos", cullingConfirmed: true, shotOrder: { mode: "front-to-back" }, nothingToRemove: true, removalNotes: "", captured: ["photos"],
    } as never);
    const afterJ = await prisma.project.findUniqueOrThrow({ where: { id: sharedJob }, select: { photosHandoffAt: true, photosHandoffBy: true, videoHandoffAt: true, debriefSubmittedAt: true } });
    const partsJ = await ss.readContributions(sharedJob);
    c.ok("James's submit hands off the photos half (as the split submit always did)", !photosOnly.blocked && !!afterJ.photosHandoffAt && afterJ.photosHandoffBy === "James Drill" && !afterJ.videoHandoffAt && !afterJ.debriefSubmittedAt, JSON.stringify(photosOnly).slice(0, 200));
    c.ok("…James's part is submitted; Harrison's is still his own, in progress", core.contributionState(partsJ.get(jamesTm.id)) === "submitted" && core.contributionState(partsJ.get(harrisonTm.id)) === "in_progress");
    await establishSession(harrison.id);
    const hp2 = await portalOf(sharedJob);
    const hMine = (hp2?.props.sharedShoot?.contributions ?? []).find((x: { memberId: string }) => x.memberId === harrisonTm.id);
    c.ok("Harrison's page is not done because James submitted", !!hMine && core.contributionState(hMine) === "in_progress");
    const videoRes = await finalizeUpload(sharedJob, {
      editorBrief: "", force: true, scope: "video", videoInstructions: "COLOR PROFILE: iPhone\nSONG REQUEST: No request\n\nEDITING NOTES\nOpen on the front walk.", captured: ["video"], videoDrone: true,
    } as never);
    const afterH = await prisma.project.findUniqueOrThrow({ where: { id: sharedJob }, select: { videoHandoffAt: true, videoHandoffBy: true, debriefSubmittedAt: true } });
    c.ok("Harrison's submit hands off the video half; the whole wrap-up lands once both are in", !videoRes.blocked && afterH.videoHandoffBy === "Harrison Drill" && !!afterH.debriefSubmittedAt, JSON.stringify(videoRes).slice(0, 200));
    const parts = await ss.readContributions(sharedJob);
    c.ok("…each part submitted, each by its own person", core.contributionState(parts.get(jamesTm.id)) === "submitted" && core.contributionState(parts.get(harrisonTm.id)) === "submitted" && parts.get(harrisonTm.id)!.submits.at(-1)!.scope === "video" && parts.get(jamesTm.id)!.submits.at(-1)!.scope === "photos");
    // A part with no photo or video half of its own (James shot only the floor plan here).
    const fpJob = await job("5 Floor Plan Ct", [{ type: "PHOTOS", label: "Photos" }, { type: "FLOORPLAN", label: "Floor Plan" }], [{ who: harrisonTm.id }, { who: jamesTm.id }]);
    await establishSession(james.id);
    const emptyPart = await shared.submitMyPart(fpJob, { services: [] });
    const fpPart = await shared.submitMyPart(fpJob, { services: ["floorplan"] });
    const fpRow = await prisma.project.findUniqueOrThrow({ where: { id: fpJob }, select: { debriefSubmittedAt: true, photosHandoffAt: true, uploadedAt: true } });
    c.ok("a floor-plan-only part is submitted as James's part, and hands nothing else off", !emptyPart.ok && fpPart.ok && core.contributionState(fpPart.contribution) === "submitted" && !fpRow.debriefSubmittedAt && !fpRow.photosHandoffAt && !fpRow.uploadedAt);
    await establishSession(harrison.id);
    const unrelated = await job("9 Other St", [{ type: "PHOTOS", label: "Photos" }], [{ who: jamesTm.id }]);
    c.ok("a different job at another address shares nothing (no contribution, not shared)", (await ss.readContributions(unrelated)).size === 0 && !(await ss.shootRoster(unrelated)).shared);
    // A reassignment never deletes a part.
    await prisma.appointment.updateMany({ where: { projectId: sharedJob, assignedToId: jamesTm.id }, data: { status: "CANCELED" } });
    c.ok("taking James off the shoot keeps his part on file", (await ss.readContributions(sharedJob)).has(jamesTm.id) && !(await ss.shootRoster(sharedJob)).shared);
    await prisma.appointment.updateMany({ where: { projectId: sharedJob, assignedToId: jamesTm.id }, data: { status: "SCHEDULED" } });

    // =====================================================================
    c.head("4 · Shared instructions: both see them, no silent overwrite");
    // =====================================================================
    await establishSession(james.id);
    const added = await shared.addSharedInstruction(sharedJob, "Feature the pool at dusk.");
    c.ok("James adds a shared instruction", added.ok && !!added.note && added.note.authorName === "James Drill");
    await establishSession(harrison.id);
    const hp3 = await portalOf(sharedJob);
    const hNotes = (hp3?.props.sharedShoot?.notes ?? []) as { entryId: string; text: string; version: number }[];
    c.ok("Harrison's page shows it", hNotes.length === 1 && hNotes[0].text === "Feature the pool at dusk." && hNotes[0].version === 1);
    const v1 = hNotes[0];
    await establishSession(james.id);
    const jEdit = await shared.editSharedInstruction(sharedJob, v1.entryId, 1, "Feature the pool at dusk, from the deck.");
    c.ok("James changes it (v2)", jEdit.ok && jEdit.note?.version === 2);
    await establishSession(harrison.id);
    const stale = await shared.editSharedInstruction(sharedJob, v1.entryId, 1, "Feature the pool at noon.");
    c.ok("Harrison's save against v1 is refused: 'James changed this; here's their version'", !stale.ok && /James Drill changed this; here's their version/.test(stale.message) && stale.current?.text === "Feature the pool at dusk, from the deck.", stale.message);
    const vers = await ss.readSharedNoteVersions(sharedJob);
    c.ok("…nothing of Harrison's was written", vers.length === 2 && !vers.some((v) => /noon/.test(v.text)));
    const fresh = await shared.editSharedInstruction(sharedJob, v1.entryId, 2, "Feature the pool at dusk, from the deck. Keep the lights on.");
    const folded = (await ss.readSharedNotes(sharedJob))[0];
    c.ok("on the current version his change lands, keeping the author and every version", fresh.ok && folded.version === 3 && folded.authorName === "James Drill" && folded.lastByName === "Harrison Drill" && folded.history.length === 3);
    c.ok("each change is on the job's timeline", (await prisma.activity.count({ where: { projectId: sharedJob, body: { startsWith: "Shared instruction for the editor" } } })) === 3);
    // The job's photos went in an hour before these edits (the drill's clock stands still).
    const hourAgo = new RealDate(SIM - 3_600_000);
    await prisma.project.update({ where: { id: sharedJob }, data: { photosHandoffAt: hourAgo } });
    const sbH = await ss.sharedBriefFor(sharedJob);
    c.ok("the job was handed off before: the brief marks it changed after the handoff", sbH?.notes[0]?.changedAfterHandoff === true && sbH?.handoffISO === hourAgo.toISOString(), JSON.stringify(sbH?.notes));

    // =====================================================================
    c.head("5 · Conflicts are flagged on the editor's brief, never resolved");
    // =====================================================================
    const skip = await shared.addSharedInstruction(sharedJob, "Skip the pool shots, the cover is on.");
    c.ok("Harrison adds an instruction that points the other way", skip.ok);
    const brief = await ss.sharedBriefFor(sharedJob, { scrub: true });
    c.ok("the combined brief keeps both, with their authors, and flags the pair", !!brief && brief.notes.length === 2 && brief.conflicts.length === 1 && /pool/.test(brief.conflicts[0].a.text + brief.conflicts[0].b.text) && brief.people.length === 2, JSON.stringify(brief?.conflicts));
    await establishSession(owner.id);
    const EditPage = (await import("@/app/edit/[id]/page")).default;
    console.warn = () => {};
    const editTree = await EditPage({ params: Promise.resolve({ id: sharedJob }), searchParams: Promise.resolve({}) } as never);
    console.warn = warn;
    const fromPh = find(editTree, (e) => e.props?.["data-brief-section"] === "photographers")[0];
    const fpWords = fromPh ? said(fromPh) : "";
    c.ok("the editor's page: one section from the photographers, who shot what", !!fromPh && /From the photographers \(shared shoot\)/.test(fpWords) && /Harrison Drill/.test(fpWords) && /James Drill/.test(fpWords), fpWords.slice(0, 240));
    c.ok("…the conflict flagged, both instructions shown", !!find(fromPh, (e) => e.props?.["data-brief-conflicts"] === 1)[0] && /point opposite ways/.test(fpWords) && /from the deck/.test(fpWords) && /cover is on/.test(fpWords));
    c.ok("…and the one changed after the handoff says so", /changed after the handoff/.test(fpWords));
    const { buildEditorPacket } = await import("@/lib/editorPacket");
    const packet = await buildEditorPacket(sharedJob);
    c.ok("the outside editor's packet carries the same, conflict and all", !!packet?.manifest.job.sharedInstructions && packet.manifest.job.sharedInstructions.lines.length === 2 && packet.manifest.job.sharedInstructions.conflicts.length === 1);

    // =====================================================================
    c.head("6 · The song request, per video, reaches the brief");
    // =====================================================================
    await establishSession(harrison.id);
    const songJob = await job("44 Song Ave", [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Standard Reel", videoStyle: "standard_reel" }], [{ who: harrisonTm.id }]);
    const noTitle = await finalizeUpload(songJob, { editorBrief: "", force: true, scope: "video", videoInstructions: "COLOR PROFILE: iPhone\nSONG REQUEST: Requested\n\nEDITING NOTES\nQuick cuts.", captured: ["video"] } as never);
    c.ok("a requested song with neither title nor link is refused, naming what is missing", /song title or a link/.test(String(noTitle.blocked)), String(noTitle.blocked));
    // A video whose brief is required (a standard cinematic; a plain reel needs none, as ever): the song alone is not direction.
    const gateJob = await job("45 Song Ave", [{ type: "VIDEO", label: "Listing Video", videoStyle: "standard_cinematic" }], [{ who: harrisonTm.id }]);
    const songOnly = await finalizeUpload(gateJob, { editorBrief: "", force: true, videoInstructions: `COLOR PROFILE: iPhone\n${lines.join("\n")}`, captured: ["video"] } as never);
    c.ok("a song alone never passes the instructions gate", /instructions are required/i.test(String(songOnly.blocked)) || /Video instructions/.test(String(songOnly.blocked)), String(songOnly.blocked));
    const withSong = `COLOR PROFILE: iPhone\n${lines.join("\n")}\n\nEDITING NOTES\nOpen on the deck, quick cuts.`;
    const songOk = await finalizeUpload(songJob, { editorBrief: "", force: true, scope: "video", videoInstructions: withSong, captured: ["video"] } as never);
    c.ok("with instructions and the song, the video half goes in", !songOk.blocked, JSON.stringify(songOk).slice(0, 160));
    await establishSession(owner.id);
    console.warn = () => {};
    const songTree = await EditPage({ params: Promise.resolve({ id: songJob }), searchParams: Promise.resolve({}) } as never);
    console.warn = warn;
    const footage = find(songTree, (e) => e.props?.id === "video-footage")[0];
    const fw = footage ? said(footage) : "";
    c.ok("the editor's brief has the song on its own line: title, link and start", /Song request: Good Days by LAKEY INSPIRED · https:\/\/open\.spotify\.com\/track\/abc · start: 0:30/.test(fw), fw.slice(0, 400));
    c.ok("…and the video notes without the machine lines", /Video notes: COLOR PROFILE: iPhone/.test(fw) && !/Video notes:[^]*SONG TITLE/.test(fw));
    const songPacket = await buildEditorPacket(songJob);
    c.ok("the packet lists the song request", (songPacket?.manifest.job.songRequests ?? []).some((l) => /Good Days by LAKEY INSPIRED/.test(l)), JSON.stringify(songPacket?.manifest.job.songRequests));
    // Different songs for different videos.
    const twoVid = await job("46 Song Ave", [{ type: "SOCIAL_REEL", label: "Premium Reel", videoStyle: "premium_social_reel" }, { type: "SOCIAL_REEL", label: "Standard Reel", videoStyle: "standard_reel" }], [{ who: harrisonTm.id }]);
    const rowsTV = await dout.videoInstructionsFor(twoVid);
    await establishSession(harrison.id);
    const v2Text = "COLOR PROFILE: iPhone\nSONG REQUEST: Requested\nSONG TITLE: Sweet Home Alabama\n\nEDITING NOTES\nThe yard, quick.";
    const tvRes = await finalizeUpload(twoVid, {
      editorBrief: "", force: true, videoInstructions: `STYLE: Fast-Paced\nCOLOR PROFILE: S-Log3\n${lines.join("\n")}\n\nVISION FOR THE EDIT\nLuxury and calm.`, laterVideoInstructions: { [rowsTV[1].key]: v2Text }, captured: ["video"],
      scriptConfirm: null, sawScript: false, providedScript: "Hi, I'm Georgiana.",
    } as never);
    const tvPacket = await buildEditorPacket(twoVid);
    const tvSongs = tvPacket?.manifest.job.songRequests ?? [];
    c.ok("two videos, two songs: each on its own video", !tvRes.blocked && tvSongs.length === 2 && /Video 1 .*Good Days/.test(tvSongs[0]) && /Video 2 .*Sweet Home Alabama/.test(tvSongs[1]), JSON.stringify(tvRes).slice(0, 160) + " " + JSON.stringify(tvSongs));

    // =====================================================================
    c.head("7 · An agent request added on site");
    // =====================================================================
    await establishSession(harrison.id);
    const asksBefore = await prisma.clientAsk.count({ where: { projectId: single } });
    const addReq = await shared.addAgentRequest(single, { text: "Open the reel on the view from the deck", medium: "video" });
    c.ok("filed through the client-ask path, at the top of the page with its source", addReq.ok && !addReq.duplicate && (addReq.items ?? []).some((r) => r.source === "on_site" && /view from the deck/.test(r.text) && /logged by Harrison Drill/.test(r.sourceWords) && r.group === "visit"), JSON.stringify(addReq).slice(0, 300));
    const ask = await prisma.clientAsk.findFirst({ where: { projectId: single, text: "Open the reel on the view from the deck" } });
    c.ok("…a staff-filed ask that holds delivery, tagged as captured on site by the photographer", !!ask && ask.source === "staff" && ask.holdsDelivery && (ask.sourceRef ?? "").startsWith("on-site:") && /Harrison Drill \(on site\)/.test(ask.historyJson ?? ""));
    const line = await prisma.activity.findFirst({ where: { projectId: single, type: "SPECIAL_REQUEST", body: { startsWith: "Client request (on site, logged by Harrison Drill)" } } });
    const { requestsForEditors } = await import("@/lib/specialRequests");
    c.ok("…on the editor's brief (the job's special requests the brief reads)", !!line && requestsForEditors([{ body: line.body }], { video: true }).length === 1);
    const { specialRequestsBoard } = await import("@/lib/clientAsks");
    const board = await specialRequestsBoard();
    c.ok("…and on Kyle's special-requests board", JSON.stringify(board.groups).includes("view from the deck"));
    const again = await shared.addAgentRequest(single, { text: "Open the reel on the view from the deck.", medium: "video" });
    const sameAsOrder = await shared.addAgentRequest(single, { text: "please feature the backyard and pool", medium: "photo" });
    c.ok("the same words again are not filed twice; nor are an order note's words", again.ok && again.duplicate === true && sameAsOrder.duplicate === true && (await prisma.clientAsk.count({ where: { projectId: single } })) === asksBefore + 1 && (await prisma.activity.count({ where: { projectId: single, body: { startsWith: "Client request (on site" } } })) === 1, `${again.message} / ${sameAsOrder.message}`);

    // =====================================================================
    c.head("8 · A service added on site: the video's own section, kept until the office adds it");
    // =====================================================================
    const addJob = await job("12 Added Video Rd", [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Standard Reel", videoStyle: "standard_reel" }], [{ who: harrisonTm.id }]);
    const payAddBefore = JSON.stringify(await shootEarnings(addJob, harrisonTm.id));
    const evBefore = JSON.stringify(await loadEvidence(harrisonTm.id, { startKey: "2026-10-01", endKey: "2026-10-31", start: new RealDate("2026-10-01T04:00:00Z"), windowEnd: new RealDate("2026-11-01T04:00:00Z") }, new Date()));
    const addon = await addShootAddOn(addJob, "Extra video", "The agent asked for a second reel of the deck.");
    c.ok("the Added at the shoot card for Kyle (the existing path, unchanged)", addon.ok && !!addon.row && !!(await prisma.smartTask.findFirst({ where: { id: addon.row!.id, title: { startsWith: "Add to the order: Extra video" } } })));
    c.ok("…it is a video service under 'What did you capture?'", core.serviceOfAddonItem("Extra video") === "video" && core.serviceOfAddonItem("Drone photos") === "drone" && core.serviceOfAddonItem("3D tour") === "tour" && core.serviceOfAddonItem("Floor plan") === "floorplan");
    const page8 = await portalOf(addJob);
    c.ok("the page hands its card to the portal (one video ordered, so the added one is video 2)", (page8?.props.addOnRows ?? []).some((a: { id: string }) => a.id === addon.row!.id) && page8?.props.videos === null && page8?.props.policy.videoOrdered === true);
    const addedText = "COLOR PROFILE: iPhone\nSONG REQUEST: Requested\nSONG LINK: https://youtu.be/deck\n\nINTRO SCRIPT\nWelcome to the deck.\n\nEDITING NOTES\nSlow push-in.";
    const savedAdd = await shared.saveAddedVideo(addJob, { taskId: addon.row!.id, text: addedText });
    c.ok("its instructions are saved before the office adds it", savedAdd.ok && savedAdd.attachedKey === null);
    const sb8 = await ss.sharedBriefFor(addJob);
    c.ok("…and the brief already names it, waiting for the office, with its words", sb8?.addedVideos.length === 1 && /Welcome to the deck/.test(sb8.addedVideos[0].text) && !sb8.addedVideos[0].handled);
    c.ok("…no video row was made by the photographer (billing and approval stay the office's)", (await prisma.deliverable.count({ where: { projectId: addJob, type: { in: ["VIDEO", "SOCIAL_REEL"] } } })) === 1);
    // The office adds the line; the order reconcile makes the row (here, the row itself).
    await prisma.deliverable.create({ data: { projectId: addJob, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1, videoStyle: "standard_reel" } });
    await dout.ensureOutputsForProject(addJob);
    const { attachAddedVideoInstructions } = await import("@/lib/addedOnSite");
    const attached = await attachAddedVideoInstructions(addJob, "the drill");
    const rows8 = await dout.videoInstructionsFor(addJob);
    c.ok("when the row appears, the words become that video's own (video 2), nothing lost", attached.length === 1 && rows8.length === 2 && rows8[1].own === addedText && rows8[0].own === null, JSON.stringify(rows8.map((r) => [r.number, r.own])));
    c.ok("…once only", (await attachAddedVideoInstructions(addJob, "the drill")).length === 0);
    const addPacket = await buildEditorPacket(addJob);
    c.ok("…and the packet reads it as its own video, song and all", (addPacket?.manifest.videos ?? []).length === 2 && (addPacket?.manifest.videos[1].note ?? "").includes("Welcome to the deck") && (addPacket?.manifest.job.songRequests ?? []).some((l) => /Video 2 .*youtu\.be\/deck/.test(l)), JSON.stringify(addPacket?.manifest.job.songRequests));
    c.ok("the brief no longer lists it as waiting", ((await ss.sharedBriefFor(addJob))?.addedVideos.length ?? 0) === 0);

    // =====================================================================
    c.head("9 · Opening Dropbox is not 'uploaded'; pay and the KPI evidence are untouched");
    // =====================================================================
    await establishSession(harrison.id);
    const dropJob = await job("3 Dropbox Way", [{ type: "PHOTOS", label: "Photos" }, { type: "FLOORPLAN", label: "Floor Plan" }], [{ who: harrisonTm.id }]);
    await shared.saveMyCapture(dropJob, { captured: ["photos", "floorplan"], videoDrone: false });
    const untouched = await prisma.deliverable.findMany({ where: { projectId: dropJob }, select: { uploadedAt: true, status: true } });
    c.ok("ticking what you captured marks nothing uploaded", untouched.every((d) => !d.uploadedAt && d.status === "PENDING"));
    const mark = await shared.markMyUploads(dropJob, { services: ["photos", "floorplan"], uploaded: true });
    const marked = await prisma.deliverable.findMany({ where: { projectId: dropJob }, select: { uploadedAt: true, type: true } });
    c.ok("only the photographer's own 'My files are uploaded' does, through the item tick it always had", mark.ok && marked.every((d) => !!d.uploadedAt) && /Dropbox still has to show the files/.test(mark.message));
    const proj9 = await prisma.project.findUniqueOrThrow({ where: { id: dropJob }, select: { debriefSubmittedAt: true, uploadedAt: true, photosHandoffAt: true } });
    c.ok("…and that hands nothing off (no submit, no raws-in stamp)", !proj9.debriefSubmittedAt && !proj9.uploadedAt && !proj9.photosHandoffAt);
    const payAddAfter = JSON.stringify(await shootEarnings(addJob, harrisonTm.id));
    c.ok("adding a service, a request and its instructions changes no pay on that shoot", payAddBefore === payAddAfter, `${payAddBefore} → ${payAddAfter}`);
    const evAfter = JSON.stringify(await loadEvidence(harrisonTm.id, { startKey: "2026-10-01", endKey: "2026-10-31", start: new RealDate("2026-10-01T04:00:00Z"), windowEnd: new RealDate("2026-11-01T04:00:00Z") }, new Date()));
    // The evidence moved only by the submits made in this drill; the revamp's
    // own writes (parts, shared instructions, requests, added videos) are not
    // read by it. Re-reading after more of those writes changes nothing.
    await shared.addSharedInstruction(addJob, "Keep the drone low over the deck.");
    await shared.saveMyCapture(addJob, { captured: ["photos", "video"], videoDrone: false });
    const evAfter2 = JSON.stringify(await loadEvidence(harrisonTm.id, { startKey: "2026-10-01", endKey: "2026-10-31", start: new RealDate("2026-10-01T04:00:00Z"), windowEnd: new RealDate("2026-11-01T04:00:00Z") }, new Date()));
    c.ok("the KPI evidence reads none of the revamp's records", evAfter === evAfter2 && evBefore.length > 0);
    const payAfter = JSON.stringify(await computePayroll(new RealDate("2026-10-01T00:00:00-04:00"), new RealDate("2026-10-31T23:59:59-04:00")));
    const payAfter2 = await (async () => { await shared.markMyUploads(addJob, { services: ["video"], uploaded: false }); return JSON.stringify(await computePayroll(new RealDate("2026-10-01T00:00:00-04:00"), new RealDate("2026-10-31T23:59:59-04:00"))); })();
    c.ok("payroll moves only with the submits (the same rule as ever), never with the revamp's own records", payBefore.length > 0 && payAfter === payAfter2);

    c.ok("nothing left the machine", fence.blocked.filter((u) => !/studio|dropbox/i.test(u)).length === 0, fence.blocked.join(", "));
  } finally {
    console.warn = warn;
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
