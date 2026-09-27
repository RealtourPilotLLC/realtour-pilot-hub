// ---------------------------------------------------------------------------
// DRILL: A28 / §6.8 / §7.5 — one brief per video, and it reaches every place
// it is read: the photographer's shoot screen, the editor's brief (screen and
// printed), and each video's own brief with its version (Sep 25 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/a28-brief-destinations.ts
//
// OLD behaviour first (the shoot reader and the printed brief as they were at
// fa9a2c9, loaded byte for byte from git), then the new:
//
//   1. OLD vs NEW — the photographer's shoot screen for a content session. At
//      fa9a2c9 it carried no topic, no script and no direction. Now: the three
//      topics; the client-approved v2 with its filming notes (never v1); the
//      released-but-unapproved script with its standing; nothing at all from
//      an unreleased draft; the brand kit; the accepted production fact and
//      NOT the confidential one; money scrubbed. A listing shoot: no session.
//   2. OLD vs NEW — the editor's printed brief for the same session: the same
//      words, the script's own direction and the brand kit, which the old PDF
//      never printed; confidential and superseded words nowhere.
//   3. OLD vs NEW — a listing job with a reel AND an MLS video. Old: one set of
//      instructions for both. New: each video's own brief, versioned and
//      attributed, written through the real server action (an EDITOR is
//      refused under AUTH_ENFORCE); identical saves make no version; a stale
//      page and a simultaneous save are refused, not overwritten; another
//      job's video and an over-long section are refused; the shoot screen and
//      the PDF carry both briefs, money-scrubbed. A one-video job prints
//      exactly as before.
//   4. The §6.8 configuration items confirmed at HEAD: topic folders stay
//      behind their OFF switch (no Dropbox call), personal branding routes by
//      the saved rule only (code default = manual), and a Pro month's two
//      sessions keep two clocks.
//
// ISOLATION. PGlite on 127.0.0.1:5714 (DRILL_PORT overrides); production is
// never opened; every non-loopback call is fenced and must stay at zero.
// The clock is pinned to Wed Sep 23 2026, 10:00 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5714);
const REPO = path.resolve(__dirname, "../..");
/** The commit before this batch: what "before" means here. */
const BASE = "fa9a2c9";

// ---- the clock ---------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 8, 23, 14, 0, 0); // Wed Sep 23 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const et = (day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, 8, day, hour + 4, minute));

// ---- the login, stubbed at the one seam every guard reads ----------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
const as = (role: "ADMIN" | "EDITOR", name: string): Viewer => ({
  id: `u-${role}-${name}`, email: `${name.split(" ")[0].toLowerCase()}@example.com`, name, role, permissions: null, status: "ACTIVE",
  teamMemberId: null, editorKey: role === "EDITOR" ? "kim" : null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: name,
});
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) =>
    new Proxy(loaded as Record<string | symbol, unknown>, {
      get(t, k) {
        if (k === "getCurrentUser") return async () => viewer;
        return t[k];
      },
    }),
);

installNextStubs();
const fence = fenceFetch();

// ---- the PDF's words ------------------------------------------------------------
function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const s = buf.toString("latin1");
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const body = buf.subarray(start, end);
    let raw = body;
    while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) raw = raw.subarray(0, raw.length - 1);
    const inflate = (b: Buffer): string | null => { try { return zlib.inflateSync(b).toString("latin1"); } catch { return null; } };
    const text: string = inflate(raw)
      ?? inflate(body.subarray(0, Math.max(0, body.length - 1)))
      ?? inflate(body.subarray(0, Math.max(0, body.length - 2)))
      ?? inflate(body)
      ?? raw.toString("latin1");
    for (const t of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(t[1], "hex").toString("latin1"));
    for (const t of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1]);
    re.lastIndex = end + "endstream".length;
  }
  return out.join(" ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ");
}

/** fa9a2c9's shoot.ts and editor-pdf.ts, their `@/` imports aimed at this tree. */
function writeBaseCopies(): { dir: string; shoot: string; editorPdf: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a28-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out = (name: string, f: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, point(show(f)));
    return p;
  };
  return { dir, shoot: out("shoot.base.ts", "src/lib/shoot.ts"), editorPdf: out("editorPdf.base.ts", "src/lib/editor-pdf.ts") };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const base = writeBaseCopies();
  const { getShoot } = await import("@/lib/shoot");
  const oldShoot = (await import(base.shoot)) as { getShoot: (id: string) => Promise<unknown> };
  const { buildEditorBriefPdf } = await import("@/lib/editor-pdf");
  const oldPdf = (await import(base.editorPdf)) as { buildEditorBriefPdf: (p: unknown) => Promise<Uint8Array> };
  const { getProject } = await import("@/lib/queries");
  const dout = await import("@/lib/deliverableOutputs");
  const { createAssetWithVersion } = await import("@/lib/clientAssets");

  // =========================================================================
  c.head("1 · OLD vs NEW: the photographer's shoot screen for a content session");
  // =========================================================================
  const f = await buildContentMonth(prisma as never, {
    name: "Brief Destinations TEST",
    package: "Starter",
    videosPerMonth: 3,
    owner: false,
    appointments: [{ startAt: et(24, 10) }],
    topics: [
      { title: "The market update nobody gives you", selection: "SELECTED" },
      { title: "Staging on a budget", selection: "SELECTED" },
      { title: "Pricing in week one", selection: "SELECTED" },
    ],
  });
  const [T1, T2, T3] = f.topicIds;
  const version = (scriptId: string, n: number, body: string, extra: Record<string, string | null> = {}) =>
    prisma.contentScriptVersion.create({
      data: { scriptId, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: n, title: `v${n}`, hook: "h", pointsJson: "[]", close: "c", body, source: "AI", status: "SHARED", ...extra },
      select: { id: true },
    });
  // T1: v1 was shared and approved; then v2 was shared and approved.
  const s1 = await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: T1, title: "Market update", body: "x", status: "APPROVED", releaseState: "released" }, select: { id: true } });
  const s1v1 = await version(s1.id, 1, "Old words for the market update, superseded.");
  const s1v2 = await version(s1.id, 2, "Fresh words for the market update, as approved.", {
    filmingNotes: "Film at the kitchen island",
    creativeDirection: "Warm, slow push-ins",
    productionNotes: "The client paid $200 for the extra drone pass. Bring the wide lens.",
  });
  await prisma.contentScript.update({ where: { id: s1.id }, data: { sharedVersionId: s1v2.id, currentVersionId: s1v2.id, approvedVersionId: s1v2.id, clientApprovedVersionId: s1v2.id, clientApprovedAt: new Date() } });
  for (const v of [s1v1, s1v2]) {
    await prisma.contentScriptRelease.create({ data: { scriptId: s1.id, scriptVersionId: v.id, enrollmentId: f.enrollmentId, clientId: f.clientId, action: "CLIENT_APPROVED", actorEmail: "client@example.com" } });
  }
  // T2: released, the client has not decided.
  const s2 = await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: T2, title: "Staging", body: "x", status: "APPROVED", releaseState: "released" }, select: { id: true } });
  const s2v1 = await version(s2.id, 1, "Released words about staging on a budget.", { productionNotes: "Bring the teleprompter" });
  await prisma.contentScript.update({ where: { id: s2.id }, data: { sharedVersionId: s2v1.id, currentVersionId: s2v1.id } });
  // T3: a draft nobody has released.
  const s3 = await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: T3, title: "Pricing", body: "Unreleased draft words about pricing.", status: "DRAFT" }, select: { id: true } });
  const s3v1 = await version(s3.id, 1, "Unreleased draft words about pricing.", { filmingNotes: "Unreleased direction" });
  await prisma.contentScript.update({ where: { id: s3.id }, data: { currentVersionId: s3v1.id } });
  // Call knowledge: one accepted production fact, one confidential.
  await prisma.clientFact.create({ data: { clientId: f.clientId, category: "PRODUCTION_PREFERENCE", body: "Always open on the agent walking in", source: "call", status: "ACCEPTED", aiContext: "ALLOWED" } });
  await prisma.clientFact.create({ data: { clientId: f.clientId, category: "PRODUCTION_PREFERENCE", body: "Confidential: the agent is going through a divorce", source: "call", status: "ACCEPTED", aiContext: "ALLOWED", confidential: true } });
  // The brand kit: a logo file, the fonts and the music slots.
  await createAssetWithVersion({ clientId: f.clientId, type: "LOGO", name: "Primary logo", source: "upload", fileRef: "/RTP/Clients/Brief Destinations/logo.png", fileName: "logo.png", by: "drill" } as never);
  await createAssetWithVersion({ clientId: f.clientId, type: "FONT", name: "Font names", profileKey: "fonts", source: "manual", valueText: "Montserrat, Playfair", by: "drill" } as never);
  await createAssetWithVersion({ clientId: f.clientId, type: "MUSIC_PREFERENCE", name: "Music", profileKey: "music", source: "manual", valueText: "Upbeat acoustic, no lyrics", by: "drill" } as never);

  const blocked0 = fence.blocked.length;
  const oldView = JSON.stringify(await oldShoot.getShoot(f.projectId!));
  c.ok("OLD (fa9a2c9): the shoot screen carries no topic of the session", !["The market update nobody gives you", "Staging on a budget", "Pricing in week one"].some((t) => oldView.includes(t)));
  c.ok("OLD: …and none of the script's words or direction", !oldView.includes("Fresh words") && !oldView.includes("kitchen island") && !oldView.includes("teleprompter"));

  const view = (await getShoot(f.projectId!))!;
  const json = JSON.stringify(view);
  const sess = view.session;
  const byId = new Map((sess?.topics ?? []).map((t) => [t.topicId, t]));
  c.ok("NEW: the session's three topics, in the month's order", JSON.stringify(sess?.topics.map((t) => t.topicId)) === JSON.stringify([T1, T2, T3]), JSON.stringify(sess?.topics.map((t) => t.title)));
  const t1 = byId.get(T1)?.script;
  c.ok("T1: the version the client approved — v2, its words, marked approved", t1?.versionNo === 2 && !!t1.text?.includes("Fresh words") && t1.clientApproved && /approved by the client/.test(t1.standing), JSON.stringify(t1));
  c.ok("T1: …with the direction written with it (filming, creative)", t1?.direction?.filmingNotes === "Film at the kitchen island" && t1.direction.creativeDirection === "Warm, slow push-ins");
  c.ok("T1: …money scrubbed out of the production note, the instruction kept", t1?.direction?.productionNotes === "Bring the wide lens.", String(t1?.direction?.productionNotes));
  c.ok("never v1: the superseded words appear nowhere on the screen", !json.includes("Old words for the market update"));
  const t2 = byId.get(T2)?.script;
  c.ok("T2: the released script, plainly NOT approved by the client yet", !!t2?.text?.includes("Released words about staging") && !t2.clientApproved && /not approved by them yet/.test(t2.standing) && t2.direction?.productionNotes === "Bring the teleprompter", JSON.stringify(t2));
  c.ok("T3: an unreleased draft shows no words, and says why", byId.get(T3)?.script === null && /still with the office/.test(byId.get(T3)?.noScript ?? ""), String(byId.get(T3)?.noScript));
  c.ok("…the draft's words and direction appear nowhere on the screen", !json.includes("Unreleased draft words") && !json.includes("Unreleased direction"));
  c.ok("the brand kit: fonts, the logo file (by name and version), music", sess?.brand?.fontNames === "Montserrat, Playfair" && sess.brand.files.some((x) => x.name === "Primary logo" && x.versionNo === 1) && sess.brand.music === "Upbeat acoustic, no lyrics", JSON.stringify(sess?.brand));
  c.ok("the accepted production fact reaches the photographer", !!sess?.brand?.acceptedPreferences.some((x) => x.includes("Always open on the agent walking in")));
  c.ok("the confidential fact does not", !json.includes("divorce"));
  c.ok("no money anywhere on the screen's session brief", !JSON.stringify(sess).includes("$200"));
  const listing = await prisma.project.create({ data: { clientId: f.clientId, title: "12 Plain Listing Ln, Testville", status: "SCHEDULED" }, select: { id: true } });
  const lv = (await getShoot(listing.id))!;
  c.ok("a listing shoot has no session brief and no per-video briefs", lv.session === null && lv.outputBriefs.length === 0);
  c.ok("reading it all called nothing outside the building", fence.blocked.length === blocked0, fence.blocked.slice(blocked0).join(", "));

  // =========================================================================
  c.head("2 · OLD vs NEW: the editor's printed brief for the same session");
  // =========================================================================
  // The photographer confirms T1 (filmed on the approved v2) and T2.
  const sel = await prisma.contentTopicSelection.findMany({ where: { monthId: f.monthId }, select: { id: true, topicId: true } });
  const selOf = new Map(sel.map((s) => [s.topicId, s.id]));
  for (const [topicId, scriptId, versionId, title] of [[T1, s1.id, s1v2.id, "Market update"], [T2, s2.id, null, "Staging"]] as const) {
    await prisma.contentVideo.create({
      data: {
        enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, kind: "PROGRAM", title, topicId,
        selectionId: selOf.get(topicId) ?? null, scriptId, scriptVersionId: versionId, projectId: f.projectId!, status: "FILMED",
        filmedAt: et(24, 12), filmedConfirmedAt: et(24, 13), filmedConfirmedBy: "harrison@example.com", filmedSource: "upload_portal", source: "manual",
      },
    });
  }
  await prisma.project.update({ where: { id: f.projectId! }, data: { status: "SHOT", videosFilmed: 2, uploadedAt: et(24, 13) } });
  await dout.bindTopicVideosToSlots(f.projectId!, { notes: { [T1]: "Open on the skyline" } });
  const fb = await dout.filmingBriefFor(f.projectId!);
  const fbT1 = fb?.rows.find((r) => r.topicId === T1);
  c.ok("the editor's filming brief: T1 on the approved v2, with its direction", fbT1?.script?.versionNo === 2 && !!fbT1.script.text?.includes("Fresh words") && fbT1.script.direction?.filmingNotes === "Film at the kitchen island", JSON.stringify(fbT1?.script));
  c.ok("…the same words the shoot screen showed", !!t1?.text && fbT1?.script?.text === t1.text);
  const full = (await getProject(f.projectId!))!;
  const oldText = pdfText(await oldPdf.buildEditorBriefPdf(full));
  c.ok("OLD PDF: the script's words, but not its direction", oldText.includes("Fresh words") && !oldText.includes("kitchen island"));
  c.ok("OLD PDF: no brand kit (fonts, logo) at all", !oldText.includes("Montserrat") && !oldText.includes("Primary logo"));
  const newText = pdfText(await buildEditorBriefPdf(full));
  c.ok("NEW PDF: the approved words and their direction", newText.includes("Fresh words") && newText.includes("Filming: Film at the kitchen island") && newText.includes("Direction: Warm, slow push-ins"), newText.slice(newText.indexOf("Fresh"), newText.indexOf("Fresh") + 200));
  c.ok("NEW PDF: the brand kit — fonts, logo by version, music, the accepted fact", newText.includes("BRAND KIT") && newText.includes("Montserrat, Playfair") && newText.includes("Primary logo (v1)") && newText.includes("Upbeat acoustic") && newText.includes("Always open on the agent walking in"));
  c.ok("NEW PDF: no superseded words, no confidential fact, no money", !newText.includes("Old words") && !newText.includes("divorce") && !newText.includes("$200"));

  // =========================================================================
  c.head("3 · OLD vs NEW: a reel and an MLS video on one listing, one brief each");
  // =========================================================================
  const lc = await prisma.client.create({ data: { name: "Two Videos TEST" }, select: { id: true } });
  const two = await prisma.project.create({
    data: { clientId: lc.id, title: "40 Two Video Way, Testville", status: "SHOT", shootDate: et(22, 10), deliveryDue: et(25, 17), videoInstructions: "VISION FOR THE EDIT\nBright and airy, the whole house." },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: two.id, type: "SOCIAL_REEL", label: "Social Reel", productTitle: "Standard Social Media Reel", videoStyle: "standard_reel", quantity: 1 } });
  await prisma.deliverable.create({ data: { projectId: two.id, type: "VIDEO", label: "Video", productTitle: "Cinematic MLS Video", videoStyle: "standard_cinematic", quantity: 1 } });
  await dout.ensureOutputsForProject(two.id);
  const outs = await dout.outputsForProject(two.id);
  const [reel, mls] = outs;
  c.ok("the job owes two videos, each its own row", outs.length === 2 && !!reel && !!mls, outs.map((o) => o.label).join(" | "));
  const oldTwo = pdfText(await oldPdf.buildEditorBriefPdf((await getProject(two.id))!));
  c.ok("OLD PDF: one set of instructions for both, nothing per video", oldTwo.includes("Bright and airy") && !oldTwo.includes("EACH VIDEO"));
  const before = await dout.outputBriefsFor(two.id);
  c.ok("NEW, before anyone writes one: both go by the job's shared instructions, and say so", before.every((o) => o.directionSource === "job" && o.version === null && /shared by all 2 videos/.test(o.versionLabel)), before.map((o) => o.versionLabel).join(" | "));
  c.ok("…each named for what it is (the reel and the MLS film)", before[0].format !== before[1].format, before.map((o) => o.format).join(" | "));

  const { saveVideoBrief } = await import("@/app/editing/actions");
  viewer = as("EDITOR", "Kim Drill");
  const refused = await saveVideoBrief(two.id, reel.id, { purpose: "sneaky" }, null);
  c.ok("an EDITOR cannot write a brief (the real server action, AUTH_ENFORCE on)", !refused.ok && (await prisma.deliverableOutput.findUnique({ where: { id: reel.id } }))?.briefJson == null, refused.message);
  viewer = as("ADMIN", "Kyle Drill");
  const r1 = await saveVideoBrief(two.id, reel.id, { purpose: "Instagram teaser for the coming-soon post", mustShow: "The pool at dusk", avoid: "The neighbour's fence" }, null);
  const m1 = await saveVideoBrief(two.id, mls.id, { direction: "Slow walkthrough, room by room, MLS-safe (no text, no faces)", limitations: "The client paid $300 extra for twilight. No twilight footage was captured." }, null);
  c.ok("the office writes each video's own brief: v1 and v1", r1.ok && r1.version === 1 && m1.ok && m1.version === 1, `${r1.message} / ${m1.message}`);
  const after = await dout.outputBriefsFor(two.id, { scrub: true });
  const aReel = after.find((o) => o.outputId === reel.id)!;
  const aMls = after.find((o) => o.outputId === mls.id)!;
  c.ok("the reel's brief is the reel's", aReel.directionSource === "own" && aReel.sections.map((s) => s.key).join(",") === "purpose,mustShow,avoid" && !JSON.stringify(aReel.sections).includes("walkthrough"));
  c.ok("the MLS video's brief is the MLS video's", aMls.sections.map((s) => s.key).join(",") === "direction,limitations" && !JSON.stringify(aMls.sections).includes("pool"));
  c.ok("each says which version it is and who saved it", /^Brief v1 · saved by Kyle Drill, /.test(aReel.versionLabel) && aReel.updatedBy === "Kyle Drill", aReel.versionLabel);
  c.ok("money scrubbed for a creative's copy; the office's own read keeps it", !JSON.stringify(aMls.sections).includes("$300") && JSON.stringify(aMls.sections).includes("No twilight footage was captured") && JSON.stringify((await dout.outputBriefsFor(two.id)).find((o) => o.outputId === mls.id)?.sections).includes("$300"));
  const acts = () => prisma.activity.count({ where: { projectId: two.id, body: { contains: "by Kyle Drill" } } });
  c.ok("each save is on the job's history, attributed", (await acts()) === 2);
  const same = await saveVideoBrief(two.id, reel.id, { purpose: "Instagram teaser for the coming-soon post" }, 1);
  c.ok("saving the same words again is not a new version", same.ok && !same.changed && same.version === 1 && (await acts()) === 2, same.message);
  const stale = await dout.saveOutputBrief({ outputId: reel.id, projectId: two.id, sections: { purpose: "from a stale page" }, expectedVersion: null, actor: "Kyle Drill" });
  c.ok("a page loaded before v1 cannot overwrite it", !stale.ok && stale.reason === "conflict" && dout.readOutputBrief((await prisma.deliverableOutput.findUnique({ where: { id: reel.id } }))?.briefJson)?.sections.purpose === "Instagram teaser for the coming-soon post", stale.ok ? "" : stale.message);
  const race = await Promise.all([
    dout.saveOutputBrief({ outputId: reel.id, projectId: two.id, sections: { avoid: "Tab A: no fence" }, expectedVersion: 1, actor: "Kyle Drill" }),
    dout.saveOutputBrief({ outputId: reel.id, projectId: two.id, sections: { avoid: "Tab B: no bins" }, expectedVersion: 1, actor: "Jordan Drill" }),
  ]);
  const winners = race.filter((r) => r.ok);
  const stored = dout.readOutputBrief((await prisma.deliverableOutput.findUnique({ where: { id: reel.id } }))?.briefJson);
  c.ok("two saves at once: exactly one wins (v2), the other is told, nothing is lost silently", winners.length === 1 && stored?.version === 2 && race.some((r) => !r.ok && r.reason === "conflict") && ["Tab A: no fence", "Tab B: no bins"].includes(stored.sections.avoid ?? ""), JSON.stringify(race));
  const foreign = await dout.saveOutputBrief({ outputId: reel.id, projectId: listing.id, sections: { purpose: "x" }, actor: "Kyle Drill" });
  c.ok("another job's video id is refused", !foreign.ok && foreign.reason === "wrong_project");
  const long = await dout.saveOutputBrief({ outputId: mls.id, projectId: two.id, sections: { direction: "x".repeat(dout.OUTPUT_BRIEF_FIELD_CAP + 1) }, actor: "Kyle Drill" });
  c.ok("an over-long section is refused, nothing written", !long.ok && long.reason === "too_long" && dout.readOutputBrief((await prisma.deliverableOutput.findUnique({ where: { id: mls.id } }))?.briefJson)?.version === 1);

  const shootTwo = (await getShoot(two.id))!;
  c.ok("the shoot screen carries both briefs, each with its version", shootTwo.outputBriefs.length === 2 && shootTwo.outputBriefs.every((o) => /^Brief v\d · saved by/.test(o.versionLabel)), shootTwo.outputBriefs.map((o) => o.versionLabel).join(" | "));
  c.ok("…money-scrubbed", !JSON.stringify(shootTwo.outputBriefs).includes("$300") && JSON.stringify(shootTwo.outputBriefs).includes("No twilight footage"));
  const newTwo = pdfText(await buildEditorBriefPdf((await getProject(two.id))!));
  c.ok("NEW PDF: each video's brief, by version", newTwo.includes("EACH VIDEO'S BRIEF") && newTwo.includes("Instagram teaser") && newTwo.includes("Slow walkthrough") && newTwo.includes("Brief v2 · saved by") && newTwo.includes("Brief v1 · saved by Kyle Drill"));
  c.ok("…and the job's own instructions still printed once, labelled as for all videos", newTwo.includes("INSTRUCTIONS FROM THE SHOOT (ALL VIDEOS)") && newTwo.includes("Bright and airy"));
  c.ok("…no money in the printed brief", !newTwo.includes("$300"));

  const one = await prisma.project.create({ data: { clientId: lc.id, title: "7 One Reel Rd, Testville", status: "SHOT", videoInstructions: "VISION FOR THE EDIT\nFast and fun." }, select: { id: true } });
  await prisma.deliverable.create({ data: { projectId: one.id, type: "SOCIAL_REEL", label: "Social Reel", productTitle: "Standard Social Media Reel", videoStyle: "standard_reel", quantity: 1 } });
  await dout.ensureOutputsForProject(one.id);
  const oneBrief = await dout.outputBriefsFor(one.id);
  c.ok("a one-video job: it goes by the job's instructions, said without a 'shared' count", oneBrief.length === 1 && oneBrief[0].directionSource === "job" && oneBrief[0].versionLabel === "No brief of its own; goes by the job's instructions", oneBrief[0]?.versionLabel);
  const oneOld = pdfText(await oldPdf.buildEditorBriefPdf((await getProject(one.id))!));
  const oneNew = pdfText(await buildEditorBriefPdf((await getProject(one.id))!));
  c.ok("…and its printed brief has no per-video section, old and new alike", !oneOld.includes("EACH VIDEO") && !oneNew.includes("EACH VIDEO") && oneNew.includes("VIDEO - INSTRUCTIONS FROM THE SHOOT") && !oneNew.includes("(ALL VIDEOS)"));

  // =========================================================================
  c.head("4 · §6.8 configuration items, confirmed at HEAD");
  // =========================================================================
  const { ensureTopicFolders } = await import("@/lib/dropboxFolders");
  const b4 = fence.blocked.length;
  const tf = await ensureTopicFolders(f.projectId!);
  c.ok("topic folders: OFF with no switch row, and not one Dropbox call", tf.state === "off" && fence.blocked.length === b4, JSON.stringify(tf));
  const { editorForDeliverable } = await import("@/lib/editors");
  const { editorRouting } = await import("@/lib/settings");
  const rules = await editorRouting();
  c.ok("routing: with no saved rule, a monthly personal-branding row is MANUAL (Needs assigning)", rules.personalBranding === null && editorForDeliverable("SOCIAL_REEL", "Video Starter", true, rules) === null);
  c.ok("…and a saved Kim rule sends it to Kim", editorForDeliverable("SOCIAL_REEL", "Video Starter", true, { ...rules, personalBranding: "kim" }) === "kim");
  const { sessionClocksFor } = await import("@/lib/contentProgram");
  const clocks = sessionClocksFor(
    [{ id: "p-pro", title: "Pro month", shootDate: et(1, 10), promisedDueAt: null, dueOverrideAt: null, appointments: [
      { id: "leg1", startAt: et(1, 10), endAt: et(1, 14), durationMin: 240, status: "SCHEDULED" },
      { id: "leg2", startAt: et(15, 10), endAt: et(15, 14), durationMin: 240, status: "SCHEDULED" },
    ] }],
    "Pro",
    null,
    Date.now(),
  );
  c.ok("per-session clocks: a Pro month's two sessions are two clocks, the first due first", clocks.length === 2 && !!clocks[0].effectiveDueAt && !!clocks[1].effectiveDueAt && clocks[0].effectiveDueAt < clocks[1].effectiveDueAt, clocks.map((x) => x.effectiveDueAt?.toISOString()).join(" | "));
  c.ok("…so session 1's (earlier) deadline is not hidden behind session 2's", clocks[0].appointmentId === "leg1" && clocks[0].effectiveDueAt! < new Date(), clocks[0].effectiveDueAt?.toISOString());

  c.ok("the whole drill reached nothing outside the building", fence.blocked.length === 0, fence.blocked.join(", "));

  c.summary();
  quiet.restore();
  fs.unlinkSync(path.join(base.dir, "node_modules"));
  fs.rmSync(base.dir, { recursive: true, force: true });
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
