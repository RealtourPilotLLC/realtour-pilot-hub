// ---------------------------------------------------------------------------
// DRILL: A33 / §7.7 / O08 — the Luma Visuals packet, and the office's record
// that it went (Sep 25 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/a33-editor-packet.ts
//
// Jordan, Sep 25: "we do work with Luma visuals and I have certain video
// projects that I reassign to them right now as external agency." The agency
// is the existing `external_agency` pin; the retired `luma` key stays retired.
//
//   1. OLD (fa9a2c9) then NOW — handing a job to the agency rings a bell and
//      nothing else. The bell, a raw file in Dropbox and the task label are
//      NOT a send: the job reads "Not sent to Luma Visuals yet" on its card
//      and on its Editing Room row. (At fa9a2c9 the shop had no name and there
//      was no record to read at all.)
//   2. The packet: built from what the hub holds — each video's brief, the
//      folders, the export spec — money-scrubbed, with what is missing said
//      plainly; its fingerprint is stable and canonical.
//   3. Recording a send through the real server actions (AUTH_ENFORCE): an
//      editor is refused; bad input and a job not handed over are refused; the
//      send freezes the packet with its fingerprint, the missing list and who
//      recorded it; a double click or three tabs make ONE record.
//   4. The brief changes after the send: "out of date — send v2"; v2
//      supersedes v1, v1's frozen packet does not change; a genuinely
//      different send (another recipient) is its own version.
//   5. Luma's acknowledgement: who, how, when and who recorded it — once.
//   6. The download route: staff only, the frozen packet as sent, signed, and
//      refused when the stored copy no longer matches its fingerprint.
//   7. O08: the retired `luma` key cannot be assigned or queued, and nothing
//      anywhere sent anything to anyone (no outbound call, no outbox row).
//
// ISOLATION. PGlite on 127.0.0.1:5715 (DRILL_PORT overrides); production is
// never opened; every non-loopback call is fenced and must stay at zero.
// The clock is pinned to Wed Sep 23 2026, 10:00 ET.
// ---------------------------------------------------------------------------
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5715);
const REPO = path.resolve(__dirname, "../..");
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
const et = (day: number, hour: number) => new RealDate(RealDate.UTC(2026, 8, day, hour + 4));

// ---- the login ------------------------------------------------------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
const as = (role: "ADMIN" | "EDITOR", name: string): Viewer => ({
  id: `u-${role}-${name}`, email: `${name.split(" ")[0].toLowerCase()}@example.com`, name, role, permissions: null, status: "ACTIVE",
  teamMemberId: null, editorKey: role === "EDITOR" ? "john" : null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: name,
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
    const text: string = inflate(raw) ?? inflate(body.subarray(0, Math.max(0, body.length - 1))) ?? inflate(body) ?? raw.toString("latin1");
    for (const t of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(t[1], "hex").toString("latin1"));
    for (const t of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1]);
    re.lastIndex = end + "endstream".length;
  }
  return out.join(" ").replace(/\s+/g, " ");
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const pk = await import("@/lib/editorPacket");
  const actions = await import("@/app/editing/actions");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { saveOutputBrief, ensureOutputsForProject, outputsForProject } = await import("@/lib/deliverableOutputs");
  const { EDITORS, DELEGATE_KEYS } = await import("@/lib/editors");
  const { NextRequest } = await import("next/server");
  const route = await import("@/app/api/projects/[id]/editor-packet/[version]/route");

  const client = await prisma.client.create({ data: { name: "Packet Drill TEST" }, select: { id: true } });
  let seq = 0;
  const mkJob = async (street: string, o: { instructions?: string | null } = {}) => {
    const p = await prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`, clientId: client.id, status: "SHOT", aryeoOrderId: `drill-pk-${++seq}`,
        shootDate: et(22, 10), dropboxFolder: `/Drill/${street.replace(/\s+/g, "-")}`, videoInstructions: o.instructions ?? null,
        statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 5, rawPhotos: 30, finalVideo: 0 } }),
      },
      select: { id: true },
    });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Social Reel", productTitle: "Standard Social Media Reel", videoStyle: "standard_reel", quantity: 1 } });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Video", productTitle: "Cinematic MLS Video", videoStyle: "standard_cinematic", quantity: 1 } });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: `Edit — ${street}`, status: "OPEN", assignedKey: "john", projectId: p.id, clientId: client.id, dedupeKey: `edit-video-${p.id}` } });
    await ensureOutputsForProject(p.id);
    return p.id;
  };
  const rowOf = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].find((r) => r.id === id) ?? null;
  };
  const dispatches = (projectId: string) => prisma.editorDispatch.findMany({ where: { projectId }, orderBy: { packetVersion: "asc" } });

  // =========================================================================
  c.head("1 · OLD then NOW: a job handed to the agency — a bell, a label, and no record of a send");
  // =========================================================================
  const oldEditors = execFileSync("git", ["show", `${BASE}:src/lib/editors.ts`], { cwd: REPO, encoding: "utf8" });
  let oldPacketExists = true;
  try { execFileSync("git", ["cat-file", "-e", `${BASE}:src/lib/editorPacket.ts`], { cwd: REPO, stdio: "ignore" }); } catch { oldPacketExists = false; }
  c.ok(`OLD (${BASE}): the outside shop had no name ("External agency") and no dispatch record existed anywhere`, /external_agency: \{[^}]*name: "External agency"/.test(oldEditors) && !oldPacketExists);
  c.ok("NOW: the pin is named Luma Visuals (Jordan, Sep 25); the retired luma key is kept for history only", EDITORS.external_agency.name === "Luma Visuals" && !!EDITORS.luma);

  const J = await mkJob("1 Handover Ln");
  viewer = as("ADMIN", "Kyle Drill");
  const bellsBefore = await prisma.notification.count();
  const handed = await actions.setEditVideoEditor(J, "external_agency");
  c.ok("the office hands the job to Luma Visuals", handed.ok && /Luma Visuals/.test(handed.message), handed.message);
  const bell = await prisma.notification.findFirst({ where: { title: { startsWith: "Dispatch to Luma Visuals" } }, select: { title: true } });
  c.ok("…which rings Kyle's bell (the reminder it always was)", !!bell && (await prisma.notification.count()) > bellsBefore, bell?.title);
  const st1 = await pk.editorDispatchState(J);
  c.ok("the bell, a raw file in Dropbox and the task's label are NOT a send: no record, 'Not sent'", (await prisma.editorDispatch.count()) === 0 && st1.handedOver && st1.status === "not_sent" && st1.line.startsWith("Not sent to Luma Visuals yet"), st1.line);
  const row1 = await rowOf(J);
  c.ok("the Editing Room row says so too, and names the agency", row1?.blocker?.startsWith("Not sent to Luma Visuals yet") === true && row1.editor === "Luma Visuals", `${row1?.editor} · ${row1?.blocker}`);

  // =========================================================================
  c.head("2 · the packet: built from what the hub holds, with what is missing said plainly");
  // =========================================================================
  const [reel, mls] = await outputsForProject(J);
  await saveOutputBrief({ outputId: reel.id, projectId: J, sections: { purpose: "Coming-soon teaser. The client paid a $150 rush fee.", mustShow: "The pool" }, actor: "Kyle Drill" });
  const p1 = (await pk.buildEditorPacket(J))!;
  const reelV = p1.manifest.videos.find((v) => v.outputId === reel.id)!;
  c.ok("vendor, both videos, the reel's own brief with its version", p1.manifest.vendor.name === "Luma Visuals" && p1.manifest.videos.length === 2 && reelV.briefVersion === 1 && reelV.sections.some((s) => s.text === "The pool"));
  c.ok("money scrubbed out of everything that leaves the building", !p1.json.includes("$150") && p1.json.includes("Coming-soon teaser."), reelV.sections[0]?.text);
  c.ok("where the files are, and the export spec", p1.manifest.folders.rawVideo.endsWith("/02-RAW-Video") && p1.manifest.exportSpec.length >= 4);
  const keys = p1.missing.map((m) => m.key);
  c.ok("missing, plainly: the photographer's vision and wrap-up, the MLS video's instructions, a delivery date", keys.includes("handoff:instructions") && keys.includes("handoff:debrief") && keys.includes(`video:${mls.id}:direction`) && keys.includes("due") && !keys.includes("raws:none"), p1.missing.map((m) => m.label).join(" | "));
  const p1b = (await pk.buildEditorPacket(J))!;
  c.ok("the fingerprint is stable, and it is the sha256 of the canonical packet", p1b.hash === p1.hash && p1.hash === crypto.createHash("sha256").update(p1.json).digest("hex"));

  // =========================================================================
  c.head("2b · (review, Sep 25) the packet's missing list reads what the edit card reads");
  // =========================================================================
  // A canceled premium line and a video-first split submission: the edit card
  // (tasks.handoffReadinessOf — live lines, the style stamp, the video half's
  // own stamp) calls the handoff complete; the packet used to freeze "the
  // script" and "the wrap-up" into what goes to Luma.
  const J2b = await mkJob("2 Split Video Way", { instructions: "COLOR PROFILE: iPhone\n\nEDITING NOTES\nOpen on the kitchen island, then the deck" });
  await prisma.orderItem.create({ data: { projectId: J2b, title: "Premium Social Media Reel", isCanceled: true } });
  await prisma.orderItem.create({ data: { projectId: J2b, title: "Standard Social Media Reel" } });
  await prisma.project.update({ where: { id: J2b }, data: { videoHandoffAt: new Date(), videoHandoffBy: "Harrison Drill", debriefSubmittedAt: null } });
  const { handoffReadiness } = await import("@/lib/handoff");
  const oldRead = handoffReadiness({
    titles: ["Premium Social Media Reel", "Standard Social Media Reel", "Standard Social Media Reel", "Cinematic MLS Video"],
    hasFullVideo: true, debriefSubmittedAt: null,
    videoInstructions: "COLOR PROFILE: iPhone\n\nEDITING NOTES\nOpen on the kitchen island, then the deck",
    editorBrief: null, reelScript: null, reelHook: null, scriptConfirmedAt: null, videosFilmed: null,
  });
  c.ok("the packet's OLD read (names incl. the canceled line, no video-half stamp): a script gap and a wrap-up gap",
    oldRead.gaps.some((g) => g.key === "script") && oldRead.gaps.some((g) => g.key === "debrief"), oldRead.gaps.map((g) => g.key).join(", "));
  const p2b = (await pk.buildEditorPacket(J2b))!;
  const k2b = p2b.missing.map((m) => m.key);
  c.ok("NOW the packet names neither: the canceled line is off the order and the video half is in",
    !k2b.includes("handoff:script") && !k2b.includes("handoff:debrief"), p2b.missing.map((m) => m.label).join(" | "));
  const { handoffReadinessOf } = await import("@/lib/tasks");
  const cardRead = await handoffReadinessOf(await prisma.project.findUniqueOrThrow({
    where: { id: J2b },
    select: {
      packageName: true, debriefSubmittedAt: true, videoHandoffAt: true, videoInstructions: true, editorBrief: true, reelScript: true, reelHook: true,
      scriptConfirmedAt: true, videosFilmed: true, photographer: { select: { name: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, label: true, productTitle: true, videoStyle: true, notCompletedReason: true } },
    },
  }));
  c.ok("…the same handoff answer the edit card reads", JSON.stringify(cardRead.gaps.map((g) => `handoff:${g.key}`).sort()) === JSON.stringify(k2b.filter((k) => k.startsWith("handoff:")).sort()), `${cardRead.gaps.map((g) => g.key).join(",")} vs ${k2b.join(",")}`);

  // =========================================================================
  c.head("3 · recording a send (the real server actions, AUTH_ENFORCE on)");
  // =========================================================================
  viewer = as("EDITOR", "John Drill");
  const e1 = await actions.recordEditorPacketSent(J, { recipient: "sarah@lumavisuals.example", channel: "email" });
  c.ok("an editor cannot record a send", !e1.ok && (await prisma.editorDispatch.count()) === 0, e1.message);
  viewer = as("ADMIN", "Kyle Drill");
  const bad1 = await actions.recordEditorPacketSent(J, { recipient: "sarah@lumavisuals.example", channel: "pigeon" });
  const bad2 = await actions.recordEditorPacketSent(J, { recipient: " ", channel: "email" });
  const other = await mkJob("2 Not Handed Ln");
  const bad3 = await actions.recordEditorPacketSent(other, { recipient: "sarah@lumavisuals.example", channel: "email" });
  c.ok("refused: an unknown channel, a blank recipient, a job not handed to Luma", !bad1.ok && !bad2.ok && !bad3.ok && (await prisma.editorDispatch.count()) === 0, `${bad1.message} / ${bad2.message} / ${bad3.message}`);
  const bellsAtSend = await prisma.notification.count();
  const s1 = await actions.recordEditorPacketSent(J, { recipient: "sarah@lumavisuals.example", channel: "email", note: "Sent the Dropbox link too" });
  const [d1] = await dispatches(J);
  c.ok("recorded as v1 — who, how, by whom", s1.ok && s1.version === 1 && d1?.recipient === "sarah@lumavisuals.example" && d1.channel === "email" && d1.dispatchedBy === "Kyle Drill" && d1.vendorKey === "external_agency", s1.message);
  c.ok("…the packet frozen with its fingerprint (the stored copy hashes to it)", d1.packetHash === p1.hash && pk.storedPacketIntact(d1) && JSON.parse(d1.outputIdsJson ?? "[]").length === 2);
  c.ok("…and the missing list as it was at the send", JSON.stringify((JSON.parse(d1.missingJson ?? "[]") as { key: string }[]).map((m) => m.key).sort()) === JSON.stringify([...keys].sort()));
  c.ok("…on the job's history, attributed", (await prisma.activity.count({ where: { projectId: J, body: { startsWith: "Packet v1 recorded as sent to Luma Visuals (Email: sarah@lumavisuals.example) by Kyle Drill." } } })) === 1);
  const dup = await actions.recordEditorPacketSent(J, { recipient: "SARAH@lumavisuals.example", channel: "email" });
  const tabs = await Promise.all([1, 2, 3].map(() => actions.recordEditorPacketSent(J, { recipient: "sarah@lumavisuals.example", channel: "email" })));
  c.ok("a double click, or three tabs at once, is ONE record", dup.ok && dup.duplicate === true && tabs.every((t) => t.ok && t.version === 1) && (await prisma.editorDispatch.count({ where: { projectId: J } })) === 1, JSON.stringify(tabs.map((t) => t.version)));
  const st3 = await pk.editorDispatchState(J);
  c.ok("the card now reads 'v1 sent … not acknowledged yet', stamped on the app's clock", st3.status === "sent" && /^v1 sent to sarah@lumavisuals\.example Wed, Sep 23, 10:0\d AM by Kyle Drill: not acknowledged yet\.$/.test(st3.line), st3.line);
  c.ok("…and so does the Editing Room row", (await rowOf(J))?.blocker === st3.line);
  c.ok("recording a send rang nobody and sent nothing", (await prisma.notification.count()) === bellsAtSend && fence.blocked.length === 0);

  // =========================================================================
  c.head("4 · the brief changes after the send: out of date, and v2 supersedes v1");
  // =========================================================================
  await saveOutputBrief({ outputId: mls.id, projectId: J, sections: { direction: "Slow walkthrough, room by room" }, actor: "Kyle Drill" });
  const st4 = await pk.editorDispatchState(J);
  c.ok("the card says the sent packet is out of date, and to send v2", st4.status === "out_of_date" && /send v2/.test(st4.line), st4.line);
  const s2 = await actions.recordEditorPacketSent(J, { recipient: "sarah@lumavisuals.example", channel: "email" });
  const [v1, v2] = await dispatches(J);
  c.ok("the same recipient, a CHANGED packet: v2, and v1 is marked replaced by it", s2.ok && !s2.duplicate && v2?.packetVersion === 2 && v1.supersededById === v2.id && !v2.supersededById);
  c.ok("v1's frozen packet did not change; v2 carries the new direction", !v1.manifestJson.includes("Slow walkthrough") && v2.manifestJson.includes("Slow walkthrough") && v1.packetHash === d1.packetHash);
  c.ok("…and v2's missing list no longer names the MLS video's instructions", !(v2.missingJson ?? "").includes(`video:${mls.id}:direction`));
  const s3 = await actions.recordEditorPacketSent(J, { recipient: "ops@lumavisuals.example", channel: "portal" });
  const all3 = await dispatches(J);
  c.ok("the same packet to ANOTHER recipient is its own send (v3), and v2 is replaced", s3.ok && s3.version === 3 && all3[1].supersededById === all3[2].id && all3[2].packetHash === v2.packetHash);

  // =========================================================================
  c.head("5 · Luma's acknowledgement: who, how, when, and who recorded it — once");
  // =========================================================================
  const v3 = all3[2];
  viewer = as("EDITOR", "John Drill");
  const ae = await actions.recordEditorPacketAck(J, v3.id, { by: "Sarah", source: "email" });
  c.ok("an editor cannot record it", !ae.ok && !(await prisma.editorDispatch.findUnique({ where: { id: v3.id } }))?.acknowledgedAt);
  viewer = as("ADMIN", "Kyle Drill");
  const ab1 = await actions.recordEditorPacketAck(J, v3.id, { by: "Sarah", source: "smoke-signal" });
  const ab2 = await actions.recordEditorPacketAck(other, v3.id, { by: "Sarah", source: "email" });
  c.ok("refused: an unknown way of saying so, and a send from another job", !ab1.ok && !ab2.ok, `${ab1.message} / ${ab2.message}`);
  const a1 = await actions.recordEditorPacketAck(J, v3.id, { by: "Sarah at Luma Visuals", source: "email", note: "Starting tomorrow" });
  const acked = (await prisma.editorDispatch.findUnique({ where: { id: v3.id } }))!;
  c.ok("recorded: by whom, how and when", a1.ok && acked.acknowledgedBy === "Sarah at Luma Visuals" && acked.ackSource === "email" && Math.abs((acked.acknowledgedAt?.getTime() ?? 0) - PINNED) < 5 * 60_000, acked.acknowledgedAt?.toISOString());
  c.ok("…and who in the office recorded it, on the job's history", (await prisma.activity.count({ where: { projectId: J, body: { startsWith: "Luma Visuals acknowledged packet v3 (Sarah at Luma Visuals, by email); recorded by Kyle Drill." } } })) === 1);
  const a2 = await actions.recordEditorPacketAck(J, v3.id, { by: "Someone else", source: "text" });
  c.ok("a second acknowledgement is refused, and the first stands", !a2.ok && (await prisma.editorDispatch.findUnique({ where: { id: v3.id } }))?.acknowledgedBy === "Sarah at Luma Visuals", a2.message);
  const st5 = await pk.editorDispatchState(J);
  c.ok("the card: acknowledged", st5.status === "acknowledged" && st5.line.startsWith("Luma Visuals acknowledged v3 (Sarah at Luma Visuals"), st5.line);

  // =========================================================================
  c.head("6 · the download route: staff only, the packet as sent, signed, tamper-refused");
  // =========================================================================
  const get = (version: string, q = "") => route.GET(new NextRequest(`http://127.0.0.1/api/projects/${J}/editor-packet/${version}${q}`), { params: Promise.resolve({ id: J, version }) });
  viewer = as("EDITOR", "John Drill");
  c.ok("an editor gets 403", (await get("1")).status === 403);
  viewer = null;
  c.ok("signed out: 403", (await get("1")).status === 403);
  viewer = as("ADMIN", "Kyle Drill");
  const rj = await get("1", "?format=json");
  const body = (await rj.json()) as { manifest: unknown; packetHash: string; signature: string; version: number; dispatch: { recipient: string } };
  c.ok("v1 as JSON: the frozen manifest, exactly as stored", rj.status === 200 && JSON.stringify(body.manifest) === JSON.stringify(JSON.parse(v1.manifestJson)) && body.dispatch.recipient === "sarah@lumavisuals.example");
  const sig = rj.headers.get("x-packet-signature") ?? "";
  c.ok("…its fingerprint and a signature that verifies (and would not for v2)", rj.headers.get("x-packet-hash") === v1.packetHash && pk.verifyPacketSignature(J, 1, v1.packetHash, sig) && !pk.verifyPacketSignature(J, 2, v1.packetHash, sig));
  const rp = await get("1");
  const t1 = pdfText(new Uint8Array(await rp.arrayBuffer()));
  c.ok("v1 as a PDF: sent to whom, what was missing, and NOT the later direction", rp.status === 200 && rp.headers.get("content-type") === "application/pdf" && t1.includes("sent to sarah@lumavisuals.example") && t1.includes("MISSING WHEN THIS PACKET WAS MADE") && !t1.includes("Slow walkthrough"));
  const t2 = pdfText(new Uint8Array(await (await get("2")).arrayBuffer()));
  c.ok("v2 as a PDF carries it", t2.includes("Slow walkthrough") && t2.includes("Packet v2"));
  const pv = await get("preview");
  c.ok("the preview is marked as not sent", pv.status === 200 && pv.headers.get("x-packet-version") === "preview" && pdfText(new Uint8Array(await pv.arrayBuffer())).includes("PREVIEW - not sent"));
  c.ok("an unknown version is 404, and so is nonsense", (await get("99")).status === 404 && (await get("abc")).status === 404);
  await prisma.editorDispatch.update({ where: { id: v1.id }, data: { manifestJson: v1.manifestJson.replace("The pool", "Tampered pool") } });
  c.ok("a stored copy that no longer matches its fingerprint is refused (409), not served", (await get("1")).status === 409 && (await get("1", "?format=json")).status === 409);

  // =========================================================================
  c.head("7 · O08: the retired `luma` key stays retired; nothing was sent");
  // =========================================================================
  const q1 = await actions.addToEditorQueue(other, "luma");
  const q2 = await actions.setEditVideoEditor(other, "luma");
  c.ok("the luma key cannot be queued or assigned", !q1.ok && !q2.ok && (await prisma.smartTask.count({ where: { assignedKey: "luma" } })) === 0, `${q1.message} / ${q2.message}`);
  c.ok("the fallback pickers no longer offer it beside Luma Visuals", !(DELEGATE_KEYS as string[]).includes("luma") && DELEGATE_KEYS.includes("external_agency"));
  const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
  c.ok("the unreachable luma branches are gone (queue add, its hint)", !/key === "luma"/.test(read("src/app/editing/actions.ts")) && !/editor === "luma"/.test(read("src/components/editing/AddToQueue.tsx")));
  c.ok("in the whole drill: no outbound call, no outbox row — nothing is sent to Luma automatically", fence.blocked.length === 0 && (await prisma.outboxMessage.count()) === 0, fence.blocked.join(", "));

  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
