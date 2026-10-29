// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: three items from Jordan and James's call (Oct 29 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct29-ack-notes-history.ts
//
//   1. "Communication histories are too long: a client's message history
//      overwhelmed the QC review" → lib/recentWindow: the last seven days
//      open, the rest folded under "Show N older", on the Review Room's
//      client notes, a task's Full view conversation and Kyle's desk thread.
//   2. "Acknowledgments are mistaken for unresolved issues: a client saying
//      'okay' ... read as an unanswered message or reopened QC problem" →
//      the ways a client says "okay" are acknowledgments (replyQueue), and an
//      acknowledgment files no revision (so no job or QC pass reopens), no
//      ask, no photo request and no reply to-do, even when the AI, reading
//      the whole conversation, says otherwise. A real ask beside an "okay"
//      still counts.
//   3. "Review notes cannot be deleted" → already built Oct 28 (lib/noteEdits,
//      drill oct28-review-note-edit): this only checks that the creative
//      manager (James) may delete anyone's staff note.
//
// ISOLATION: PGlite via the shared harness; the brain stubbed at its one
// function; nothing leaves the hub.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7329);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Ask = { kind: "SPECIAL_REQUEST" | "SCHEDULING"; text: string; summary: string; medium: "video" | "photo" | "both" | "unclear"; projectHint: string | null };
type Decision = { actionable: boolean; projectId: string | null; title: string; detail: string; priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW"; mergeIntoTaskId: string | null; isRevisionRequest: boolean; flags: string[]; reason: string; taskType: "client_reply" | "todo"; asks?: Ask[] };
let nextDecision: Decision | null = null;
interceptModule(
  (r) => r === "@/lib/brain" || /[\\/]src[\\/]lib[\\/]brain(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "routeCommTask" ? async () => nextDecision : t[k]; } }),
);
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => null : t[k]; } }),
);
installNextStubs();

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const texts: string[] = [];
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") return json({ content: [{ type: "text", text: "{}" }] });
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  if (url.includes("openphone") || url.includes("quo")) { texts.push(String(init?.body ?? "")); return json({ data: {} }); }
  return null;
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const now = new Date("2026-10-29T18:00:00Z");

  // =========================================================================
  c.head("1 · The last seven days open, the rest folded");
  // =========================================================================
  const rw = await import("@/lib/recentWindow");
  const at = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  const msgs = [{ id: "a", at: at(30) }, { id: "b", at: at(9) }, { id: "c", at: at(6) }, { id: "d", at: at(1) }];
  const s1 = rw.splitRecent(msgs, (m) => m.at, now);
  c.ok("seven days by default: two recent, two older, each side in the screen's order", rw.RECENT_DAYS === 7 && s1.recent.map((m) => m.id).join() === "c,d" && s1.older.map((m) => m.id).join() === "a,b", JSON.stringify(s1));
  const s2 = rw.splitRecent([{ id: "x", at: at(40) }, { id: "y", at: at(12) }, { id: "z", at: at(20) }], (m) => m.at, now);
  c.ok("nothing recent: the newest stays in view, so the list never opens empty", s2.recent.map((m) => m.id).join() === "y" && s2.older.map((m) => m.id).join() === "x,z", JSON.stringify(s2));
  const s3 = rw.splitRecent([{ id: "n", at: null as string | null }, { id: "o", at: at(15) }, { id: "p", at: "not a date" }], (m) => m.at, now);
  c.ok("an item with no readable date stays open (nothing to fold it by)", s3.recent.map((m) => m.id).join() === "n,p" && s3.older.map((m) => m.id).join() === "o");
  c.ok("everything recent: nothing folded", rw.splitRecent(msgs.slice(2), (m) => m.at, now).older.length === 0);
  c.ok("empty in, empty out", rw.splitRecent([], () => null, now).recent.length === 0);
  c.ok("the fold's words", rw.olderLabel(3, "message") === "Show 3 older messages (more than 7 days ago)" && rw.olderLabel(1, "note") === "Show 1 older note (more than 7 days ago)");

  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { OlderFold } = await import("@/components/comms/OlderFold");
  const folded = renderToStaticMarkup(React.createElement(OlderFold, { count: 2, noun: "message", children: React.createElement("p", null, "an old text") }));
  c.ok("the fold is closed, says how many, and holds the older items", /<details[^>]*data-older-fold="2"/.test(folded) && !/<details[^>]*\bopen\b/.test(folded) && folded.includes("Show 2 older messages (more than 7 days ago)") && folded.includes("an old text"));
  c.ok("nothing older: no fold at all", renderToStaticMarkup(React.createElement(OlderFold, { count: 0, noun: "message", children: "x" })) === "");

  const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  const room = src("src/app/review/[id]/page.tsx");
  c.ok("the Review Room's client notes: recent open, older folded, a note still waiting stays in view",
    /splitRecent\(\s*clientNoteGroups\.flatMap/.test(room) && /x\.n\.status === "OPEN" \? null : x\.n\.createdAtISO/.test(room) && /<OlderFold count=\{clientNoteSplit\.older\.length\} noun="note">/.test(room) && /noteGroupsView\(recentClientNoteGroups\)/.test(room));
  const full = src("src/components/queue/TaskFullView.tsx");
  c.ok("a task's Full view: the conversation folds the same way", /splitRecent\(conv, \(m\) => m\.date, new Date\(convAt\)\)/.test(full) && /<OlderFold count=\{older\.length\} noun="message">/.test(full));
  const desk = src("src/components/desk/OfficeDesk.tsx");
  c.ok("Kyle's desk conversation: the same", /splitRecent\(p\.messages, \(m\) => m\.atISO, new Date\(nowISO\)\)/.test(desk) && /nowISO=\{desk\.nowISO\}/.test(desk) && /<OlderFold count=\{older\.length\} noun="message">/.test(desk));

  // =========================================================================
  c.head("2 · \"Okay\" is an acknowledgment, not a request");
  // =========================================================================
  const { isAckOnlyInbound, isCourtesyMessage } = await import("@/lib/replyQueue");
  const acks = ["okay", "Okay!", "Ok", "ok thanks", "Okay great, thank you", "Got it", "Got it, thanks!", "That works", "Okay that works", "Works for me", "Sounds good to me", "Understood", "Noted, thank you", "Makes sense", "Alright", "Thanks for the update", "Thank you for letting me know", "Thanks for the heads up!", "👍", "Copy that", "That's fine", "That’s fine", "It’s all set, thanks", "Makes sense to me", "That works for me", "Roger"];
  const bad = acks.filter((t) => !isAckOnlyInbound(t, "text"));
  c.ok("the ways a client says okay need no reply and open nothing", bad.length === 0, bad.join(" | "));
  c.ok("…and the unanswered walk reads them as courtesy too", acks.every((t) => isCourtesyMessage(t) || t === "👍"));
  const asks = [
    "Okay but the kitchen is still too dark",
    "Got it, can you also send the floor plan",
    "Okay?",
    "Okay, the lot lines are wrong on photo 4",
    "That works, please move it to Thursday",
    "Got it. Not the one I wanted though",
    "Okay, 2pm works",
    "Update it",
    "Okay, update the cover photo",
    "Thanks for the update, when will the video be ready",
    "Got it, update the cover photo",
    "Noted. Also the drone shots look blurry",
    "Copy me on that email",
    "Yes do that",
  ];
  const leaked = asks.filter((t) => isAckOnlyInbound(t, "text"));
  c.ok("a real ask or complaint beside an okay still counts", leaked.length === 0, leaked.join(" | "));
  c.ok("an email: an okay over a signature is an acknowledgment, an okay with a second sentence is not",
    isAckOnlyInbound("Re: 12 Oak St photos — Okay, sounds good\n\nJane Smith\nKeller Williams\n(610) 555-0101", "email") &&
    !isAckOnlyInbound("Re: 12 Oak St photos — Okay. The dining room still looks crooked to me, can you check it", "email"));

  const { recordClientCommunication } = await import("@/lib/comms");
  const tim = await prisma.client.create({ data: { name: "Dana Okafor", phone: "(610) 555-0144" }, select: { id: true, name: true } });
  const oak = await prisma.project.create({
    data: { title: "12 Oak St, Media, PA 19063", clientId: tim.id, status: "DELIVERED", deliveredAt: new Date(Date.now() - 2 * DAY), shootDate: new Date(Date.now() - 4 * DAY), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 25 }] } },
    select: { id: true },
  });
  const qc = await prisma.qcRecord.create({ data: { projectId: oak.id, itemsChecked: "[]", completedBy: "kyle", completedAt: new Date(Date.now() - 2 * DAY) }, select: { id: true } });
  // What the AI says when it reads the whole conversation under an "okay":
  // the kitchen redo we promised, as a revision, with the old ask filed again.
  const aiReadsHistory = (): Decision => ({
    actionable: true, projectId: oak.id, title: "Redo the kitchen photos", detail: "Client confirmed the kitchen redo.", priority: "HIGH", mergeIntoTaskId: null,
    isRevisionRequest: true, flags: [], reason: "revision in the conversation", taskType: "client_reply",
    asks: [{ kind: "SPECIAL_REQUEST", text: "brighten the kitchen", summary: "Brighten the kitchen photos", medium: "photo", projectHint: oak.id }],
  });
  const say = async (text: string) => {
    nextDecision = aiReadsHistory();
    await recordClientCommunication({ clientId: tim.id, clientName: tim.name, projectId: oak.id, projectStatus: "DELIVERED", text, kind: "text", source: "openphone", contactName: tim.name });
  };
  const state = async () => ({
    status: (await prisma.project.findUniqueOrThrow({ where: { id: oak.id }, select: { status: true } })).status,
    asks: await prisma.clientAsk.count({ where: { clientId: tim.id } }),
    replies: await prisma.smartTask.count({ where: { clientId: tim.id, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
    revisions: await prisma.smartTask.count({ where: { projectId: oak.id, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
    qcReopened: !!(await prisma.qcRecord.findUniqueOrThrow({ where: { id: qc.id } })).reopenedByRevisionAt,
  });
  await say("Okay");
  const s = await state();
  c.ok("\"Okay\" under our message: the delivered job is not reopened", s.status === "DELIVERED" && s.revisions === 0, JSON.stringify(s));
  c.ok("…its QC pass is not marked reopened by a revision", !s.qcReopened, JSON.stringify(s));
  c.ok("…no ask is filed again and no reply to-do opens", s.asks === 0 && s.replies === 0, JSON.stringify(s));
  const brainLine = await prisma.activity.findFirst({ where: { projectId: oak.id, body: { startsWith: "Smart Brain:" } }, orderBy: { createdAt: "desc" }, select: { body: true } });
  c.ok("…and the job's timeline says why", /only a thank-you or acknowledgment; nothing reopened or filed from it/.test(brainLine?.body ?? ""), brainLine?.body ?? "(none)");
  await say("Got it, thanks!");
  await say("That works");
  const s2b = await state();
  c.ok("\"Got it, thanks!\" and \"That works\": still nothing reopened or filed", s2b.status === "DELIVERED" && s2b.asks === 0 && s2b.replies === 0 && s2b.revisions === 0 && !s2b.qcReopened, JSON.stringify(s2b));
  await say("Okay but the kitchen is still too dark, can you brighten it");
  const s4 = await state();
  c.ok("an okay WITH a real ask still reopens the job for the revision, as before", s4.status === "REVISION" && s4.revisions >= 1, JSON.stringify(s4));
  c.ok("…and its QC pass is marked reopened", s4.qcReopened, JSON.stringify(s4));

  // =========================================================================
  c.head("3 · A mistaken review note can be deleted by James");
  // =========================================================================
  const core = await import("@/lib/noteEditCore");
  const james = { realRole: "CREATIVE_MANAGER", impersonating: false, userId: "u-james", authorKeys: ["tm:james"] };
  c.ok("the creative manager may change or delete any staff note, their own included", core.mayChangeNote(james, { authorKey: "tm:james", authorUserId: "u-james" }) && core.mayChangeNote(james, { authorKey: "owner", authorUserId: null }));
  c.ok("the editor is told it is withdrawn, with nothing to do", /^James deleted the note at 0:14 \("Wrong video"\)\. Nothing to do for it\.$/.test(core.editorChangeLine({ action: "DELETED", by: "James Livingston", timeSec: 14, before: "Wrong video", after: null })));

  c.head("Nothing left the hub");
  c.ok("no text went to a client", texts.length === 0, texts.join(" | "));
  c.ok("the fence held", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
