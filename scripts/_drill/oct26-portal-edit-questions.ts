// ---------------------------------------------------------------------------
// DRILL: THE CLIENT'S PORTAL, OCT 26 2026. Jordan: "I don't want clients to see
// the 'questions for the call' field after a script is approved and written. I
// don't even need them to see questions for the call. I just need to see it on
// my end ... Also, I don't like the 'Change this part' Options - it messes up
// the formatting of the skit scripts. Just give them an edit button and the
// ability to undo their edit or view the previous version."
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct26-portal-edit-questions.ts --logs <dir>
//
//   1. questions: a call topic's questions never reach a client (hidden, no
//      items) but staff in the portal see all six; a written topic's questions
//      are unchanged; once a topic's script is shared, the client sees none
//   2. the owner's edit BEFORE approving: a new CLIENT version, shared, still
//      waiting on their Approve; the office is belled; the page offers "Undo my
//      edit" and the words before it ("View previous version")
//   3. undo: the words before the edit come back as one more version (marked
//      undo, belled), and their edit is what "previous" shows now; refused once
//      the office has shared a newer version
//   4. another seat (the shared link): the edit goes to Jordan as a request,
//      no new version; it cannot save directly or undo
//   5. a skit's line breaks survive an edit; the card keeps them on screen and
//      no longer offers "Change this part"
//
// ISOLATION: PGlite via the shared harness, every outbound call fenced; no
// model call.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5621);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();
const fence = fenceFetch(async () => null);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-portal-edit", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const scripts = await import("@/lib/contentScripts");
  const portalActions = await import("@/app/portal/actions");
  const edits = await import("@/lib/scriptEdits");
  const { portalTopics } = await import("@/lib/portal");
  const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
  const { etMonthKey } = await import("@/lib/contentProgram");
  try {
    const owner = await prisma.appUser.create({ data: { email: "jordan@edit.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const staff = { email: owner.email, appUserId: owner.id };
    const CUR = etMonthKey();
    const F = await buildContentMonth(db, {
      name: "Bernadette Edit TEST", package: "Pro", monthKey: CUR, project: false,
      topics: [
        { title: "Why Lehigh Valley Buyers Wait Too Long", selection: "SELECTED", source: "client" },
        { title: "The Best Brunch Spots in the Lehigh Valley", selection: "SELECTED", source: "client" },
        { title: "The Inspection That Saved a Deal", selection: "SELECTED", source: "client" },
        { title: "Who Really Runs the Farm", selection: "SELECTED", source: "client" },
      ],
    });
    const [tCall, tWritten, tScripted, tSkit] = F.topicIds;
    // The month is planned on a strategy call, held this morning.
    await prisma.programCallRecord.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", monthId: F.monthId, targetMonthKey: CUR, scheduledStart: new Date(Date.now() - 3 * 3600_000), scheduledEnd: new Date(Date.now() - 2.5 * 3600_000), transcriptState: "AWAITING" } });
    await (await import("@/lib/programMonths")).recalcProgramMonth(F.monthId);
    const lib = await import("@/lib/contentInterview");
    await lib.setTopicAnswerRoute(tWritten, F.monthId, "WRITTEN", { staffUserId: owner.email });
    await lib.setTopicAnswerRoute(tScripted, F.monthId, "WRITTEN", { staffUserId: owner.email });

    const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];
    const make = async (topicId: string, title: string, hook: string, points = pts("Most buyers wait for spring.", "The ones who win look in the fall.", "Fewer buyers means better terms."), close = "Thinking about it? Text me and let's look now.") => {
      const v = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId, source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { title, hook, points, close, captionCta: null } });
      await scripts.approveScriptVersion(v.versionId, staff, "drill");
      await scripts.releaseScriptVersion(v.scriptId, staff);
      return v;
    };
    const ownerViewer = await (async () => {
      const who = await prisma.clientUser.findUniqueOrThrow({ where: { id: F.clientUserId! } });
      const cl = await prisma.client.findUniqueOrThrow({ where: { id: F.clientId }, select: { name: true } });
      return { enrollment: { id: F.enrollmentId, clientId: F.clientId, clientName: cl.name }, actor: { kind: "CLIENT" as const, clientUserId: who.id, email: who.email, name: who.name, membershipId: F.membershipId!, membershipRole: "OWNER" as const }, access: "FULL" as const, via: "LOGIN" as const };
    })();
    const editAsOwner = (scriptId: string, base: string, w: { hook: string; points: string[]; close: string; captionCta?: string | null }) => edits.adoptEditedScript(scriptId, base, w, { kind: "CLIENT", viewer: ownerViewer as never });
    const undoAsOwner = (scriptId: string, read: string) => edits.undoClientEdit(ownerViewer as never, scriptId, read);
    const topicsFor = async (staffView: boolean) => (await portalTopics({ id: F.enrollmentId, clientId: F.clientId }, { staff: staffView })).groups.flatMap((g) => g.topics);
    const shared = async (scriptId: string) => {
      const s = await prisma.contentScript.findUniqueOrThrow({ where: { id: scriptId } });
      return prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: s.sharedVersionId! } });
    };
    const textsOf = (v: { pointsJson: string }) => (JSON.parse(v.pointsJson) as { text: string }[]).map((p) => p.text);

    // ==================================================================
    c.head("1 · the questions: staff see them, a client sees only what they answer");
    const S = await make(tScripted, "The Inspection That Saved a Deal", "The inspection found the one thing nobody looked for.");
    const asClient = await topicsFor(false);
    const asStaff = await topicsFor(true);
    const q = (list: typeof asClient, id: string) => list.find((t) => t.id === id)?.questions ?? null;
    c.ok("a call topic: the client gets no questions (hidden, no items)", q(asClient, tCall)?.route === "CALL" && q(asClient, tCall)?.clientHidden === true && q(asClient, tCall)?.items.length === 0, JSON.stringify(q(asClient, tCall)));
    c.ok("…staff in the portal see all six, read out on the call", q(asStaff, tCall)?.route === "CALL" && !q(asStaff, tCall)?.clientHidden && q(asStaff, tCall)?.items.length === 6);
    c.ok("…the bank still knows the block is there (no 'Answer questions' button in its place)", q(asClient, tCall) !== null);
    c.ok("a written topic before its script: the client's questions as before (six, answerable)", q(asClient, tWritten)?.route === "WRITTEN" && !q(asClient, tWritten)?.clientHidden && q(asClient, tWritten)?.items.length === 6);
    c.ok("a written topic whose script is shared: the client sees no questions", q(asClient, tScripted)?.clientHidden === true && q(asClient, tScripted)?.items.length === 0);
    c.ok("…staff still do", q(asStaff, tScripted)?.items.length === 6 && !q(asStaff, tScripted)?.clientHidden);
    const tq = fs.readFileSync(path.join(REPO, "src/components/portal/TopicQuestions.tsx"), "utf8");
    c.ok("the portal block renders nothing when hidden, nor a call's questions for anyone but staff", /q\.clientHidden \|\| \(q\.route === "CALL" && !staff\)\) return null;/.test(tq));
    const page = fs.readFileSync(path.join(REPO, "src/components/portal/PortalPage.tsx"), "utf8");
    c.ok("the portal page asks as staff only for staff (every topics read)", (page.match(/portalTopics\(enrollment, \{ staff: actor\.kind === "STAFF" \}\)/g) ?? []).length === 3 && !/portalTopics\(enrollment\)/.test(page));

    // ==================================================================
    c.head("2 · the owner edits before approving");
    const A = await make(tCall, "Why Lehigh Valley Buyers Wait Too Long", "Waiting for spring costs Lehigh Valley buyers more than they think.");
    const words = { hook: "Spring buyers in the Lehigh Valley pay for waiting.", points: ["Everyone waits for the tulips.", "The smart ones look in October.", "Fewer buyers, better terms."], close: "Thinking about it? Text me and let's look now." };
    const e1 = await editAsOwner(A.scriptId, A.versionId, words);
    c.ok("their edit saves before they approve", e1.ok && /Approve it when you're happy with it/.test(e1.message), e1.message);
    const v2 = await shared(A.scriptId);
    c.ok("…a new version on the page, built on the one they read, from the client", v2.versionNo === 2 && v2.basedOnVersionId === A.versionId && v2.source === "CLIENT_REQUEST" && v2.hook === words.hook && /before approving, from v1/.test(v2.changeSummary ?? ""), v2.changeSummary ?? "");
    c.ok("…marked as their edit", edits.clientEditMarkOf(v2)?.from === A.versionId && !edits.clientEditMarkOf(v2)?.undo);
    const dec1 = (await scriptDecisionsFor(F.enrollmentId, [A.scriptId])).get(A.scriptId);
    c.ok("…still waiting on their Approve: no sign-off recorded for them", !dec1?.decision && !(await prisma.contentScript.findUniqueOrThrow({ where: { id: A.scriptId } })).clientApprovedVersionId, JSON.stringify(dec1));
    const bell1 = await prisma.notification.findMany({ where: { kind: "script_edited" } });
    c.ok("…the office hears about it, before approving", bell1.some((n) => /Script edited by Bernadette Edit TEST/.test(n.title) && /before approving it/.test(n.body ?? "")), bell1.map((n) => `${n.title}: ${n.body}`).join(" | "));
    const onPage = (await topicsFor(false)).find((t) => t.id === tCall)?.scriptText?.clientEdit;
    c.ok("the page offers Undo my edit and the words before it (View previous version)", !!onPage && onPage.undoable && !onPage.undo && onPage.previous.versionNo === 1 && onPage.previous.hook === "Waiting for spring costs Lehigh Valley buyers more than they think." && onPage.previous.points.length === 3, JSON.stringify(onPage));
    const ok2 = await (await import("@/lib/scriptDecisions")).clientApproveScript(ownerViewer as never, A.scriptId, v2.id);
    c.ok("…and they can approve their own words", ok2.ok, ok2.message);

    // ==================================================================
    c.head("3 · Undo my edit");
    const u1 = await undoAsOwner(A.scriptId, v2.id);
    c.ok("undo puts the words before the edit back", u1.ok && /back to the wording before your edit/.test(u1.message), u1.message);
    const v3 = await shared(A.scriptId);
    c.ok("…as one more version (nothing deleted), with v1's words", v3.versionNo === 3 && v3.hook === "Waiting for spring costs Lehigh Valley buyers more than they think." && textsOf(v3).join("|") === "Most buyers wait for spring.|The ones who win look in the fall.|Fewer buyers means better terms." && (await prisma.contentScriptVersion.count({ where: { scriptId: A.scriptId } })) === 3);
    c.ok("…marked as their undo, belled", edits.clientEditMarkOf(v3)?.undo === true && /undid their edit: back to the words of v1/.test(v3.changeSummary ?? "") && (await prisma.notification.count({ where: { kind: "script_edited", title: { contains: "Script edit undone by" } } })) === 1);
    c.ok("…they had approved their edit, so the restored words carry their sign-off", (await scriptDecisionsFor(F.enrollmentId, [A.scriptId])).get(A.scriptId)?.decision === "APPROVED");
    const afterUndo = (await topicsFor(false)).find((t) => t.id === tCall)?.scriptText?.clientEdit;
    c.ok("…the page: 'View previous version' now shows their edit, and an undo is not undone again", !!afterUndo && afterUndo.undo && !afterUndo.undoable && afterUndo.previous.hook === words.hook, JSON.stringify(afterUndo));
    const u2 = await undoAsOwner(A.scriptId, v3.id);
    c.ok("…undoing the undo is refused", !u2.ok && /no edit of yours to undo/.test(u2.message), u2.message);
    // Edit again, then the office shares a newer version on top.
    const e2 = await editAsOwner(A.scriptId, v3.id, { ...words, close: "Text me today." });
    const v4 = await shared(A.scriptId);
    const office = await scripts.createScriptVersion({ scriptId: A.scriptId, enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: tCall, source: "MANUAL", status: "INTERNAL_REVIEW", createdBy: owner.email, basedOnVersionId: v4.id, parts: { title: "Why Lehigh Valley Buyers Wait Too Long", hook: "The office's newer hook.", points: pts("One.", "Two.", "Three."), close: "Text me." } });
    await scripts.approveScriptVersion(office.versionId, staff, "drill: office");
    await scripts.releaseScriptVersion(A.scriptId, staff);
    const n5 = await prisma.contentScriptVersion.count({ where: { scriptId: A.scriptId } });
    const u3 = await undoAsOwner(A.scriptId, v4.id);
    c.ok("once the office shares a newer version, their edit can't be undone (nothing written)", e2.ok && !u3.ok && u3.stale === true && /newer version/.test(u3.message) && (await prisma.contentScriptVersion.count({ where: { scriptId: A.scriptId } })) === n5, u3.ok ? "" : u3.message);
    const officeOnPage = (await topicsFor(false)).find((t) => t.id === tCall)?.scriptText?.clientEdit;
    c.ok("…and the page offers no undo on the office's version", officeOnPage == null);

    // ==================================================================
    c.head("4 · another seat: the edit goes to Jordan");
    const B = await make(tWritten, "The Best Brunch Spots in the Lehigh Valley", "Brunch in the Lehigh Valley is better than you think.");
    const auth = { token: F.portalToken! };
    const nB = await prisma.contentScriptVersion.count({ where: { scriptId: B.scriptId } });
    const direct = await portalActions.portalEditApprovedScript(auth, B.scriptId, B.versionId, { hook: "Our brunch beats the city's.", points: ["One.", "Two.", "Three."], close: "Text me." });
    c.ok("the shared link cannot save an edit as the script", !direct.ok && (await prisma.contentScriptVersion.count({ where: { scriptId: B.scriptId } })) === nB, direct.message);
    const sent = await portalActions.portalSuggestScriptEdit(auth, B.scriptId, B.versionId, { hook: "Our brunch beats the city's.", points: ["Most people drive to Philly for it.", "They don't need to.", "Three spots prove it."], close: "Text me for the list." });
    const sug = await prisma.scriptSuggestion.findFirst({ where: { scriptId: B.scriptId } });
    c.ok("…it is sent to Jordan as a request with their words, no new version", sent.ok && /read your edit/.test(sent.message) && !!sug && JSON.parse(sug.editedPartsJson ?? "{}").hook === "Our brunch beats the city's." && (await prisma.contentScriptVersion.count({ where: { scriptId: B.scriptId } })) === nB, sent.message);
    const undoLink = await portalActions.portalUndoScriptEdit(auth, A.scriptId, v4.id);
    c.ok("…and it cannot undo anything", !undoLink.ok, undoLink.message);

    // ==================================================================
    c.head("5 · a skit's line breaks; the card");
    const K = await make(tSkit, "Who Really Runs the Farm", "Every morning on the farm starts the same.", pts("Bernadette (to camera): I feed the sheep.\nHusband (off camera): Who feeds the sheep?", "Bernadette: Fine. He does.", "Husband (walking in): Thank you."), "Bernadette: Real estate, I run.");
    const skitWords = { hook: "Every morning on the farm starts the same.", points: ["Bernadette (to camera): I feed the sheep.\nHusband (off camera): Who feeds the sheep?\nBernadette: Fine.", "Bernadette: He does the sheep.", "Husband (walking in): Thank you."], close: "Bernadette: Real estate, I run." };
    const ek = await editAsOwner(K.scriptId, K.versionId, skitWords);
    const vk = await shared(K.scriptId);
    c.ok("a skit's speaker lines keep their own lines through an edit", ek.ok && textsOf(vk)[0] === "Bernadette (to camera): I feed the sheep.\nHusband (off camera): Who feeds the sheep?\nBernadette: Fine.", JSON.stringify(textsOf(vk)[0]));
    const kOnPage = (await topicsFor(false)).find((t) => t.id === tSkit)?.scriptText?.parts?.points[0].text ?? "";
    c.ok("…and reach the page with them", kOnPage.split("\n").length === 3, JSON.stringify(kOnPage));
    const card = fs.readFileSync(path.join(REPO, "src/components/portal/ScriptApprovalCard.tsx"), "utf8");
    c.ok("the card shows each part with its line breaks", /whitespace-pre-line text-sm leading-relaxed">\{textOf\(parts, k\)\}/.test(card));
    c.ok("…no 'Change this part' anywhere, one Edit, Undo my edit and View previous version", !/Change this part|Change a part|portalSendPartChanges/.test(card) && /<PencilLine className="size-3" \/> Edit<\/button>/.test(card) && /Undo my edit/.test(card) && /View previous version/.test(card));
    c.ok("…the owner's edit saves, another seat's is sent to Jordan", /canApprove\s*\? portalEditApprovedScript\(/.test(card) && /: portalSuggestScriptEdit\(/.test(card));
    const dash = /[—–]/;
    c.ok("no em or en dash in the words a client reads", !dash.test(e1.message) && !dash.test(u1.ok ? u1.message : "") && !dash.test(card.slice(card.indexOf("return (")).replace(/\{\/\*[\s\S]*?\*\/\}/g, "")));
    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    quiet.restore();
    fence.restore();
    c.summary();
    await stop();
  }
  // The harness's order (a PGlite socket closing after stop would otherwise fail a passing run).
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
