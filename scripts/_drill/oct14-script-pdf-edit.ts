// ---------------------------------------------------------------------------
// DRILL: scripts as a PDF, edited by the agent after approving, edited on site
// by the photographer, and texted to the agent (Oct 14 2026).
//
// Jordan: "I want to make sure that the agents are able to download their
// scripts in a nice PDF format, and are able to edit the scripts themselves.
// after they approve it ... I want the same features for the photographers
// two and the my shoots page. I want them to be able to edit each individual
// script on site and also download the PDF and also text the PDF of the
// scripts to the agent."
//
//   1. The PDF builder: a real PDF, one page per script, no dashes.
//   2. Portal: no PDF and no edit before the agent approves; after, the PDF
//      downloads and the agent's edit becomes the version everywhere (new
//      version, approved, released, their sign-off on it, no email, the office
//      belled). Stale, shape-breaking and unchanged edits write nothing.
//   3. Shoot screen: the brief carries the script id, version and parts; the
//      photographer's on-site edit carries the agent's earlier sign-off, an
//      office-approved script stays off the agent's page; another shoot's
//      photographer and another month's script are refused.
//   4. The shoot PDF: signed-in photographer (all, or one), signed out refused,
//      the texted link opens it without sign-in, a forged or revoked one does not.
//   5. Texting: the draft carries this shoot's link; the send goes to the
//      client's phone through OpenPhone; a text without the link is refused.
//
// ISOLATION: PGlite via the shared harness; OpenPhone answered in-process.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6993);
installNextStubs();

const sent: { to: string; body: string }[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://api.openphone.com/v1/phone-numbers")) return json({ data: [{ id: "PNdrill", number: "+12155550000", name: "Office" }] });
  if (url.startsWith("https://api.openphone.com/v1/messages") && (init?.method ?? "GET").toUpperCase() === "POST") {
    const b = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; content: string };
    sent.push({ to: b.to.join(","), body: b.content });
    return json({ data: { id: `op-${sent.length}` } }, 202);
  }
  return null;
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-script-pdf", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const scripts = await import("@/lib/contentScripts");
  const portalActions = await import("@/app/portal/actions");
  const shootActions = await import("@/app/shoot/actions");
  const { buildScriptsPdf, pdfText } = await import("@/lib/scriptPdf");
  const { NextRequest } = await import("next/server");
  const { GET: onePdf } = await import("@/app/api/portal/scripts/one/[scriptId]/route");
  const { GET: shootPdf } = await import("@/app/api/portal/scripts/shoot/[projectId]/route");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const { PDFDocument } = await import("pdf-lib");
  const pages = async (r: Response) => (await PDFDocument.load(new Uint8Array(await r.arrayBuffer()))).getPageCount();
  try {
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("openphone", "drill-key-not-a-real-one");
    const owner = await prisma.appUser.create({ data: { email: "jordan@pdf.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const F = await buildContentMonth(db, { name: "Janice Pdf TEST", package: "Accelerator", project: { title: "100 Main St, Bethlehem, PA" }, topics: [{ title: "Hakuna Matata", selection: "SELECTED" }, { title: "Open House Myths", selection: "SELECTED" }] });
    await prisma.client.update({ where: { id: F.clientId }, data: { phone: "(610) 555-0144" } });
    const tm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison@pdf.test", role: "PHOTOGRAPHER" } as never });
    const shooter = await prisma.appUser.create({ data: { email: "harrison@pdf.test", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: tm.id } });
    const tm2 = await prisma.teamMember.create({ data: { name: "Other Shooter", email: "other@pdf.test", role: "PHOTOGRAPHER" } as never });
    const other = await prisma.appUser.create({ data: { email: "other@pdf.test", name: "Other Shooter", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: tm2.id } });
    await prisma.project.update({ where: { id: F.projectId! }, data: { photographerId: tm.id } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    const staff = { email: owner.email, appUserId: owner.id };
    const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];

    // Script A: approved and released to the agent's page.
    const a1 = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[0], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai",
      parts: { title: "Hakuna Matata", hook: "Buying a home can be stress free.", points: pts("Here is how the calm buyers do it.", "They get pre-approved before they fall in love.", "So the only surprise is a good one."), close: "Call me and I'll walk you through it.", captionCta: "Comment CALM for my checklist.", filmingNotes: "Steel Stacks, golden hour." } });
    await scripts.approveScriptVersion(a1.versionId, staff, "drill: no pillar yet");
    await scripts.releaseScriptVersion(a1.scriptId, staff);
    // Script B: approved by the office, not shared with the agent yet.
    const b1 = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[1], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai",
      parts: { title: "Open House Myths", hook: "Open houses do not sell homes. Or do they?", points: pts("Most buyers walk in already pre-approved.", "Neighbors come too, and they talk.", "That talk is free marketing."), close: "Thinking of selling? Text me.", captionCta: null } });
    await scripts.approveScriptVersion(b1.versionId, staff, "drill: no pillar yet");
    const auth = { token: F.portalToken! };

    // ======================================================================
    c.head("1 · the PDF builder");
    const bytes = await buildScriptsPdf({ heading: "Janice · Scripts", scripts: [{ title: "One — two", parts: { hook: "Hook — here", points: pts("a", "b", "c"), close: "Close" } }, { title: "Skit", body: "JOE: Hi.\n[Jane laughs]" }] });
    c.ok("a real PDF", Buffer.from(bytes.slice(0, 5)).toString() === "%PDF-");
    c.ok("one page per script", (await PDFDocument.load(bytes)).getPageCount() === 2);
    c.ok("text is cleaned for the PDF fonts (no dashes, straight quotes)", pdfText("It’s — “great”") === `It's, "great"`, pdfText("It’s — “great”"));

    // ======================================================================
    c.head("2 · the agent's portal: PDF and edits after they approve");
    const before = await portalActions.portalScriptPdfLink(auth, a1.scriptId);
    c.ok("a link is minted on the click", before.ok && !!before.url && before.url.startsWith(`/api/portal/scripts/one/${a1.scriptId}?m=`), before.message);
    const r0 = await onePdf(new NextRequest(`https://hub.example.test${before.url}`), { params: Promise.resolve({ scriptId: a1.scriptId }) });
    c.ok("…but the door refuses before they approve", r0.status === 403 && /Approve the script first/.test(JSON.stringify(await r0.json())));
    const e0 = await portalActions.portalEditApprovedScript(auth, a1.scriptId, a1.versionId, { hook: "Changed", points: ["a", "b", "c"], close: "c" });
    c.ok("an edit before approving is refused", !e0.ok && /Approve the script first/.test(e0.message), e0.message);
    const ok1 = await portalActions.portalApproveScript(auth, a1.scriptId, a1.versionId);
    c.ok("the agent approves", ok1.ok, ok1.message);
    const link = await portalActions.portalScriptPdfLink(auth, a1.scriptId);
    const r1 = await onePdf(new NextRequest(`https://hub.example.test${link.url}`), { params: Promise.resolve({ scriptId: a1.scriptId }) });
    c.ok("after approving, the PDF downloads", r1.status === 200 && r1.headers.get("content-type") === "application/pdf" && /attachment; filename="Hakuna-Matata.pdf"/.test(r1.headers.get("content-disposition") ?? ""), `${r1.status} ${r1.headers.get("content-disposition")}`);
    c.ok("…one page", (await pages(r1)) === 1);
    const forged = await onePdf(new NextRequest(`https://hub.example.test/api/portal/scripts/one/${b1.scriptId}?${new URL(`https://x${link.url}`).searchParams}`), { params: Promise.resolve({ scriptId: b1.scriptId }) });
    c.ok("a token for one script does not open another", forged.status === 403);

    const words = { hook: "Buying a home can be stress free — really.", points: ["Here is how the calm buyers do it.", "They get pre-approved first.", "So the only surprise is a good one."], close: "Call me and I'll walk you through it.", captionCta: "Comment CALM for my checklist." };
    const e1 = await portalActions.portalEditApprovedScript(auth, a1.scriptId, a1.versionId, words);
    c.ok("the agent's edit saves", e1.ok && /version we'll film/.test(e1.message), e1.message);
    const sA = await prisma.contentScript.findUniqueOrThrow({ where: { id: a1.scriptId } });
    const a2 = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: sA.sharedVersionId! } });
    c.ok("…as a new version, built on the one they read", a2.versionNo === 2 && a2.basedOnVersionId === a1.versionId && a2.source === "CLIENT_REQUEST");
    c.ok("…approved and released (the agent's page shows it)", a2.status === "SHARED" && sA.approvedVersionId === a2.id && sA.releaseState === "released");
    c.ok("…the new words, dash taken out", /stress free, really\./.test(a2.hook) && !/—/.test(a2.hook) && /pre-approved first/.test(a2.pointsJson), a2.hook);
    c.ok("…the office's notes carried over", a2.filmingNotes === "Steel Stacks, golden hour.");
    const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
    const dA = (await scriptDecisionsFor(F.enrollmentId, [a1.scriptId])).get(a1.scriptId);
    c.ok("…and it is signed off by the agent (they wrote it)", dA?.decision === "APPROVED" && sA.clientApprovedVersionId === a2.id);
    const share = await prisma.contentScriptRelease.findFirst({ where: { scriptVersionId: a2.id, action: "SHARE" } });
    c.ok("…no email: nothing to announce", share?.notificationState === "SUPPRESSED" && /own edit/.test(share.note ?? ""), share?.note ?? "");
    const bell = await prisma.notification.findMany({ where: { kind: "script_edited" } });
    c.ok("…the office hears about it", bell.length > 0 && bell.some((n) => /Script edited by Janice Pdf TEST/.test(n.title)), bell.map((n) => n.title).join(" | "));
    const r2 = await onePdf(new NextRequest(`https://hub.example.test${(await portalActions.portalScriptPdfLink(auth, a1.scriptId)).url}`), { params: Promise.resolve({ scriptId: a1.scriptId }) });
    c.ok("the PDF now has the new version", r2.status === 200);

    const count = () => prisma.contentScriptVersion.count({ where: { scriptId: a1.scriptId } });
    const n0 = await count();
    const stale = await portalActions.portalEditApprovedScript(auth, a1.scriptId, a1.versionId, { ...words, hook: "Another change." });
    c.ok("an edit from an old page is refused, nothing written", !stale.ok && /newer version/.test(stale.message) && (await count()) === n0, stale.message);
    const greet = await portalActions.portalEditApprovedScript(auth, a1.scriptId, a2.id, { ...words, hook: "Hi, I'm Janice and today we talk about buying." });
    c.ok("a greeting in the hook is refused in plain words", !greet.ok && /not a greeting/.test(greet.message) && (await count()) === n0, greet.message);
    const empty = await portalActions.portalEditApprovedScript(auth, a1.scriptId, a2.id, { ...words, points: ["One.", "", "Three."] });
    c.ok("an empty talking point is refused", !empty.ok && /Talking point 2 can't be empty/.test(empty.message) && (await count()) === n0, empty.message);
    const same = await portalActions.portalEditApprovedScript(auth, a1.scriptId, a2.id, { hook: a2.hook, points: JSON.parse(a2.pointsJson).map((p: { text: string }) => p.text), close: a2.close, captionCta: a2.captionCta });
    c.ok("an unchanged save writes nothing", same.ok && /No changes/.test(same.message) && (await count()) === n0, same.message);
    const wrongCount = await portalActions.portalEditApprovedScript(auth, a1.scriptId, a2.id, { ...words, points: ["a", "b"] });
    c.ok("a different number of talking points is refused", !wrongCount.ok && (await count()) === n0);
    const notMine = await portalActions.portalEditApprovedScript(auth, b1.scriptId, b1.versionId, words);
    c.ok("a script not on their page is refused", !notMine.ok && /isn't on your page/.test(notMine.message), notMine.message);

    // ======================================================================
    c.head("3 · the shoot screen: edit on site");
    const { getShoot } = await import("@/lib/shoot");
    const view = await getShoot(F.projectId!);
    const tA = view?.session?.topics.find((t) => t.topicId === F.topicIds[0]);
    const tB = view?.session?.topics.find((t) => t.topicId === F.topicIds[1]);
    c.ok("the brief names each script, its version and its parts", tA?.script?.scriptId === a1.scriptId && tA.script.versionId === a2.id && tA.script.parts?.points.length === 3 && tB?.script?.versionId === b1.versionId, JSON.stringify(tA?.script ?? null).slice(0, 160));

    await signIn(other);
    const foreign = await shootActions.editScriptOnSite(F.projectId!, a1.scriptId, a2.id, { ...words, close: "Text me." });
    c.ok("another shoot's photographer is refused", !foreign.ok && /access/.test(foreign.message), foreign.message);
    await signIn(shooter);
    const onSite = await shootActions.editScriptOnSite(F.projectId!, a1.scriptId, a2.id, { ...words, close: "Text me today and I'll send it over." });
    c.ok("the photographer's on-site edit saves", onSite.ok && /agent's page/.test(onSite.message), onSite.message);
    const sA3 = await prisma.contentScript.findUniqueOrThrow({ where: { id: a1.scriptId } });
    const a3 = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: sA3.sharedVersionId! } });
    c.ok("…new version, released, the new close", a3.versionNo === 3 && sA3.releaseState === "released" && /Text me today/.test(a3.close));
    const carried = await prisma.contentScriptRelease.findFirst({ where: { scriptVersionId: a3.id, action: "CLIENT_APPROVED" } });
    c.ok("…carries the agent's sign-off, said plainly", !!carried && /on site/.test(carried.actorEmail ?? "") && /carries the client's sign-off on v2/.test(carried.note ?? "") && sA3.clientApprovedVersionId === a3.id, carried?.note ?? "none");
    const offEdit = await shootActions.editScriptOnSite(F.projectId!, b1.scriptId, b1.versionId, { hook: "Open houses do sell homes.", points: ["Most buyers walk in pre-approved.", "Neighbors come too, and they talk.", "That talk is free marketing."], close: "Thinking of selling? Text me." });
    c.ok("an office-approved script can be edited on site", offEdit.ok && /PDF has the new wording/.test(offEdit.message), offEdit.message);
    const sB = await prisma.contentScript.findUniqueOrThrow({ where: { id: b1.scriptId } });
    c.ok("…and stays off the agent's page (never released by the photographer)", sB.releaseState !== "released" && !sB.sharedVersionId && !!sB.approvedVersionId && sB.approvedVersionId !== b1.versionId);
    c.ok("…with no sign-off made up for the agent", (await prisma.contentScriptRelease.count({ where: { scriptId: b1.scriptId, action: "CLIENT_APPROVED" } })) === 0);
    const G = await buildContentMonth(db, { name: "Other Month TEST", package: "Accelerator", topics: [{ title: "Elsewhere", selection: "SELECTED" }] });
    const g1 = await scripts.createScriptVersion({ enrollmentId: G.enrollmentId, monthId: G.monthId, topicId: G.topicIds[0], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { title: "Elsewhere", hook: "A hook.", points: pts("one", "two", "three"), close: "A close." } });
    const cross = await shootActions.editScriptOnSite(F.projectId!, g1.scriptId, g1.versionId, { hook: "x", points: ["a", "b", "c"], close: "y" });
    c.ok("another month's script is refused", !cross.ok && /isn't part of this shoot/.test(cross.message), cross.message);

    // ======================================================================
    c.head("4 · the shoot's PDF");
    const sp = (q = "") => shootPdf(new NextRequest(`https://hub.example.test/api/portal/scripts/shoot/${F.projectId}${q}`), { params: Promise.resolve({ projectId: F.projectId! }) });
    const all = await sp();
    c.ok("the photographer downloads all the scripts", all.status === 200 && /attachment/.test(all.headers.get("content-disposition") ?? "") && (await pages(all)) === 2, String(all.status));
    const one = await sp(`?script=${b1.scriptId}`);
    c.ok("…or one", one.status === 200 && (await pages(one)) === 1);
    await signIn(other);
    c.ok("another shoot's photographer cannot", (await sp()).status === 403);
    await clearSession();
    c.ok("signed out cannot", (await sp()).status === 401);
    const { shootScriptsLink, shootScriptsKey } = await import("@/lib/scriptPdfLinks");
    const texted = shootScriptsLink(F.projectId!);
    c.ok("the texted link is on the hub's own address", texted.startsWith(`https://hub.example.test/api/portal/scripts/shoot/${F.projectId}?k=`), texted);
    const viaLink = await shootPdf(new NextRequest(texted), { params: Promise.resolve({ projectId: F.projectId! }) });
    c.ok("the texted link opens it without signing in, in the phone's viewer", viaLink.status === 200 && /inline/.test(viaLink.headers.get("content-disposition") ?? "") && (await pages(viaLink)) === 2);
    c.ok("a key for another shoot does not", (await sp(`?k=${encodeURIComponent(shootScriptsKey(G.projectId!))}`)).status === 403);
    c.ok("an expired key does not", (await sp(`?k=${encodeURIComponent(shootScriptsKey(F.projectId!, Date.now() - 40 * 86_400_000))}`)).status === 403);
    await prisma.contentEnrollment.update({ where: { id: F.enrollmentId }, data: { accessRevokedAt: new Date() } });
    c.ok("a revoked program's link does not", (await shootPdf(new NextRequest(texted), { params: Promise.resolve({ projectId: F.projectId! }) })).status === 403);
    await prisma.contentEnrollment.update({ where: { id: F.enrollmentId }, data: { accessRevokedAt: null } });

    // ======================================================================
    c.head("5 · texting the scripts to the agent");
    await signIn(shooter);
    const draft = await shootActions.scriptsTextDraft(F.projectId!);
    c.ok("the draft greets the agent and carries this shoot's link", draft.ok && /^Hi Janice, here are your scripts/.test(draft.text ?? "") && (draft.text ?? "").includes(`/api/portal/scripts/shoot/${F.projectId}?k=`), draft.text);
    const noLink = await shootActions.textScriptsToAgent(F.projectId!, "Hi Janice, scripts coming.");
    c.ok("a text without the link is refused", !noLink.ok && /link/.test(noLink.message) && sent.length === 0, noLink.message);
    const wrongLink = await shootActions.textScriptsToAgent(F.projectId!, `Hi, ${shootScriptsLink(G.projectId!)}`);
    c.ok("another shoot's link is refused", !wrongLink.ok && sent.length === 0);
    const sendIt = await shootActions.textScriptsToAgent(F.projectId!, `${draft.text}.`);
    c.ok("the photographer sends it", sendIt.ok, sendIt.message);
    c.ok("…to the agent's phone, with the link", sent.length === 1 && sent[0].to === "+16105550144" && sent[0].body.includes(`/api/portal/scripts/shoot/${F.projectId}?k=`), JSON.stringify(sent[0] ?? null));
    const log = await prisma.commLog.findFirst({ where: { projectId: F.projectId!, channel: "text", direction: "out" } });
    c.ok("…and it is on the client's comms record", !!log && log.body.includes("/api/portal/scripts/shoot/"));

    // ======================================================================
    c.head("6 · the screens");
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    const card = read("src/components/portal/ScriptApprovalCard.tsx");
    c.ok("the portal says they can edit and download once approved", /Once you approve it, you can edit the wording yourself and download it as a PDF/.test(card) && /Download PDF/.test(card) && /Edit the wording/.test(card));
    const page = read("src/app/shoot/[id]/page.tsx");
    c.ok("the shoot screen has the per-script tools and the session bar", /<ScriptCardTools /.test(page) && /<ShootScriptsBar /.test(page));
    c.ok("My Shoots marks shoots with scripts", /hasScripts && <Badge/.test(read("src/components/shoot/MyShootsView.tsx")));
    c.ok("only OpenPhone was answered; nothing else left the machine", fence.blocked.length === 0 && fence.faked.every((u) => /api\.openphone\.com/.test(u)), fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
