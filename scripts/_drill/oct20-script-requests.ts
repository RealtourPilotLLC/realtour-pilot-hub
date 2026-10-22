// ---------------------------------------------------------------------------
// DRILL: THE CLIENT'S SCRIPT CHANGE REQUESTS, AND ONE PDF A MONTH (Oct 20 2026).
//
// Jordan, on Marcee McMullen's requests: "I'd like to be able to take what
// she wrote and apply it, or take what she wrote and edit it and then apply
// it, and then add a message below to be able to respond. I don't want to hit
// Apply with AI and then lose her response. I also would like to be able to
// see my original version here to compare them ... I want these features for
// anyone asking for a script change. I also want them to be able to edit the
// scripts on their side. I also want them to be able to download all the
// scripts as PDFs once they are all approved, just like Rick can."
//
//   1. The client edits a script waiting on their OK: a change request with
//      their exact words (no new version yet); unchanged and shape-breaking
//      edits are refused; nothing is approved for them.
//   2. A pasted rewrite and a one-part note are read as script parts; a plain
//      note is not.
//   3. The office's card data: the version they read beside their words, what
//      changed, open first.
//   4. Use their version: the next version, approved by the office, shared
//      for the client's OK (no sign-off made up for them); the request kept,
//      APPLIED as HERS with the version it became.
//   5. Edit and use: the office's words; a one-part note changes only that part.
//   6. A plain note cannot be "used as is"; Dismiss keeps it on the card.
//   7. A reply: on the office card and under the script on their page
//      (Oct 22 2026: under the script, no longer in their Messages).
//   8. The month's scripts as one PDF: refused until every one is approved,
//      then one page each; a token for another client does not open it.
//
// ISOLATION: PGlite via the shared harness; no message leaves.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6997);
installNextStubs();
const fence = fenceFetch(async () => null);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-script-requests", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const scripts = await import("@/lib/contentScripts");
  const portalActions = await import("@/app/portal/actions");
  const req = await import("@/lib/scriptRequests");
  const { mediaToken } = await import("@/lib/portalMedia");
  const { NextRequest } = await import("next/server");
  const { GET: allPdf } = await import("@/app/api/portal/scripts/all/[enrollmentId]/route");
  const { PDFDocument } = await import("pdf-lib");
  try {
    const owner = await prisma.appUser.create({ data: { email: "jordan@req.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const staff = { email: owner.email, appUserId: owner.id };
    const F = await buildContentMonth(db, { name: "Marcee Requests TEST", package: "Accelerator", topics: [{ title: "Only Seniors", selection: "SELECTED" }, { title: "Repairs That Protect", selection: "SELECTED" }, { title: "Not 2022", selection: "SELECTED" }] });
    const auth = { token: F.portalToken! };
    // Oct 20 2026 (audit E1): approving is the account owner's (a signed-in OWNER
    // seat), never the shared link. The portal action is a thin gate around
    // these two calls; the drill acts as the owner through them.
    const ownerAuth = await (async () => {
      const who = await prisma.clientUser.findUniqueOrThrow({ where: { id: F.clientUserId! } });
      const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: F.enrollmentId }, select: { id: true, clientId: true } });
      const c = await prisma.client.findUniqueOrThrow({ where: { id: e.clientId }, select: { name: true } });
      return { enrollment: { id: e.id, clientId: e.clientId, clientName: c.name }, actor: { kind: "CLIENT" as const, clientUserId: who.id, email: who.email, name: who.name, membershipId: F.membershipId!, membershipRole: "OWNER" as const }, access: "FULL" as const, via: "LOGIN" as const };
    })();
    const { clientApproveScript: approveAsOwnerRaw } = await import("@/lib/scriptDecisions");
    const { adoptEditedScript: adoptAsOwner } = await import("@/lib/scriptEdits");
    const approveAsOwner = (scriptId: string, versionId: string) => approveAsOwnerRaw(ownerAuth as never, scriptId, versionId);
    const editAsOwner = async (scriptId: string, baseVersionId: string, words: { hook: string; points: string[]; close: string; captionCta?: string | null }) => { const r = await adoptAsOwner(scriptId, baseVersionId, words, { kind: "CLIENT", viewer: ownerAuth as never }); return { ok: r.ok, message: r.message }; };
    const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];
    const make = async (topicIdx: number, title: string, hook: string) => {
      const v = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[topicIdx], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai",
        parts: { title, hook, points: pts("The point that turns it.", "The example that builds it.", "The answer that pays it off."), close: "Call me and we'll talk it through.", captionCta: null, filmingNotes: "Office note kept." } });
      await scripts.approveScriptVersion(v.versionId, staff, "drill: no pillar yet");
      await scripts.releaseScriptVersion(v.scriptId, staff);
      return v;
    };
    const A = await make(0, "Only Seniors", "I thought I would only work with seniors.");
    const B = await make(1, "Repairs That Protect", "The repairs you think you need might not be the ones.");
    const C = await make(2, "Not 2022", "This is not 2022, and that is good news.");
    const versions = (id: string) => prisma.contentScriptVersion.count({ where: { scriptId: id } });

    // ======================================================================
    c.head("1 · the client edits a script waiting on their OK");
    const words = { hook: "I thought I knew exactly who I'd work with. Turns out I was only half right.", points: ["Before real estate I ran sales for senior living.", "Then the first-time buyers started calling.", "Both are asking: can I trust you to look out for me?"], close: "First home or next chapter, you don't need it all figured out. That's what I'm here for." };
    const same = await portalActions.portalSuggestScriptEdit(auth, A.scriptId, A.versionId, { hook: "I thought I would only work with seniors.", points: ["The point that turns it.", "The example that builds it.", "The answer that pays it off."], close: "Call me and we'll talk it through." });
    c.ok("an edit that changes nothing is refused", !same.ok && /No changes/.test(same.message), same.message);
    const greet = await portalActions.portalSuggestScriptEdit(auth, A.scriptId, A.versionId, { ...words, hook: "Hi, I'm Marcee and today we talk about clients." });
    c.ok("a greeting in the hook is refused in plain words", !greet.ok && /greeting/.test(greet.message), greet.message);
    const n0 = await versions(A.scriptId);
    const sent = await portalActions.portalSuggestScriptEdit(auth, A.scriptId, A.versionId, words);
    c.ok("their edit is sent", sent.ok && /read your edit/.test(sent.message), sent.message);
    const sA = await prisma.scriptSuggestion.findFirstOrThrow({ where: { scriptId: A.scriptId } });
    c.ok("…as a change request on the version they read, with their exact words", sA.status === "OPEN" && sA.scriptVersionId === A.versionId && JSON.parse(sA.editedPartsJson ?? "{}").hook === words.hook && /I edited the script/.test(sA.body));
    c.ok("…no new version, nothing approved for them", (await versions(A.scriptId)) === n0 && !(await prisma.contentScript.findUniqueOrThrow({ where: { id: A.scriptId } })).clientApprovedVersionId);
    const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
    c.ok("…and their answer on the script reads 'changes asked'", (await scriptDecisionsFor(F.enrollmentId, [A.scriptId])).get(A.scriptId)?.decision === "CHANGES_REQUESTED");

    // ======================================================================
    c.head("2 · a pasted rewrite, a one-part note, a plain note");
    const pasted = "How about this instead?\n\nHOOK\n\nThe repairs you think your house needs before you sell? They might not be where your money should go.\n\nTALKING POINT 1: RE-HOOK\n\nBuyers notice the big things.\n\nTALKING POINT 2: BUILD-UP\n\nA roof or a furnace changes an offer.\n\nTALKING POINT 3: PAYOFF\n\nFix what protects the sale, skip the rest.\n\nCLOSE / CTA\n\nThinking about selling? Let's walk through it.";
    const rB = await portalActions.portalRequestScriptChanges(auth, B.scriptId, pasted, B.versionId);
    c.ok("a pasted rewrite is sent as a note", rB.ok, rB.message);
    const rC = await portalActions.portalRequestScriptChanges(auth, C.scriptId, "Close/CTA: If you're thinking of moving this year, message me and let's look at your numbers.", C.versionId);
    c.ok("a one-part note is sent", rC.ok, rC.message);
    const rC2 = await portalActions.portalRequestScriptChanges(auth, C.scriptId, "Can the whole thing feel more upbeat?", C.versionId);
    c.ok("a plain note is sent", rC2.ok, rC2.message);

    // ======================================================================
    c.head("3 · the office's card");
    const groups = await req.loadScriptRequestsForMonth(F.monthId);
    const gA = groups.find((g) => g.scriptId === A.scriptId)!, gB = groups.find((g) => g.scriptId === B.scriptId)!, gC = groups.find((g) => g.scriptId === C.scriptId)!;
    c.ok("every script with a request is on the card, open ones first", groups.length === 3 && [gA, gB, gC].every((g) => g.requests[0].status === "OPEN"));
    c.ok("the version they read sits beside their words", gA.requests[0].readVersionNo === 1 && gA.requests[0].readParts?.hook === "I thought I would only work with seniors.");
    c.ok("their in-place edit: every part theirs, the changed ones named", gA.requests[0].edited && gA.requests[0].merged?.full === true && gA.requests[0].merged.parts.hook === words.hook && gA.requests[0].merged.changed.includes("hook"));
    c.ok("a pasted rewrite is read as a full script", gB.requests[0].merged?.full === true && /might not be where your money should go/.test(gB.requests[0].merged.parts.hook) && gB.requests[0].merged.parts.points[2].text === "Fix what protects the sale, skip the rest.");
    const close = gC.requests.find((r) => /Close\/CTA/.test(r.body))!, plain = gC.requests.find((r) => /upbeat/.test(r.body))!;
    c.ok("a one-part note changes only that part", close.merged?.full === false && close.merged.changed.join() === "close" && close.merged.parts.hook === "This is not 2022, and that is good news.");
    c.ok("a plain note is not read as a script", plain.merged === null);
    c.ok("the client's first name labels the card", gA.clientFirst === "Marcee");

    // ======================================================================
    c.head("4 · use their version");
    const uB = await req.applyRequestWords(gB.requests[0].id, "HERS", null, staff);
    const sB = await prisma.contentScript.findUniqueOrThrow({ where: { id: B.scriptId } });
    const vB = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: sB.sharedVersionId! } });
    c.ok("their words become the next version", uB.ok && uB.versionNo === 2 && /might not be where your money should go/.test(vB.hook) && vB.basedOnVersionId === B.versionId, uB.message);
    c.ok("…approved by the office and shared for the client's OK", vB.status === "SHARED" && sB.approvedVersionId === vB.id && /shared with Marcee for their OK/.test(uB.message));
    c.ok("…no sign-off made up for them", !sB.clientApprovedVersionId && (await scriptDecisionsFor(F.enrollmentId, [B.scriptId])).get(B.scriptId)?.decision === null);
    c.ok("…the office's notes carried over", vB.filmingNotes === "Office note kept.");
    const qB = await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: gB.requests[0].id } });
    c.ok("…the request is kept, APPLIED as theirs, with the version it became", qB.status === "APPLIED" && qB.appliedHow === "HERS" && qB.appliedVersionId === vB.id && qB.resolvedBy === owner.email && qB.body === pasted);
    const again = await req.applyRequestWords(gB.requests[0].id, "HERS", null, staff);
    c.ok("a second press makes nothing", !again.ok && (await versions(B.scriptId)) === 2, again.message);

    // ======================================================================
    c.head("5 · edit and use; a one-part change");
    const tighter = { hook: "Seniors or first-time buyers? Turns out I get both.", points: words.points, close: words.close };
    const eA = await req.applyRequestWords(gA.requests[0].id, "EDITED", tighter, staff);
    const vA = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: A.scriptId }, orderBy: { versionNo: "desc" } });
    c.ok("the office's edit of their words becomes the next version", eA.ok && vA.hook === tighter.hook && JSON.parse(vA.pointsJson)[1].text === words.points[1] && vA.status === "SHARED", eA.message);
    c.ok("…the request is APPLIED as EDITED", (await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: gA.requests[0].id } })).appliedHow === "EDITED");
    const uC = await req.applyRequestWords(close.id, "HERS", null, staff);
    const vC = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: C.scriptId }, orderBy: { versionNo: "desc" } });
    c.ok("a one-part note changes only the close", uC.ok && /look at your numbers/.test(vC.close) && vC.hook === "This is not 2022, and that is good news.", uC.message);

    // ======================================================================
    c.head("6 · a plain note; dismiss");
    const p1 = await req.applyRequestWords(plain.id, "HERS", null, staff);
    c.ok("a plain note cannot be used as it is (Edit and use, or AI)", !p1.ok && /isn't laid out as a script/.test(p1.message), p1.message);
    const actions = await import("@/app/content/actions");
    const { setSession } = await import("@/lib/auth/session");
    await setSession({ uid: owner.id, email: owner.email, role: "OWNER" });
    const d1 = await actions.dismissScriptSuggestion(plain.id);
    const after = await req.loadScriptRequestsForMonth(F.monthId);
    const gC2 = after.find((g) => g.scriptId === C.scriptId)!;
    c.ok("dismissed, and still on the card with who dismissed it", d1.ok && gC2.requests.some((r) => r.id === plain.id && r.status === "DISMISSED" && r.resolvedBy === owner.email && /upbeat/.test(r.body)));
    c.ok("handled requests keep how and the version they became", after.find((g) => g.scriptId === B.scriptId)!.requests[0].appliedHow === "HERS" && after.find((g) => g.scriptId === B.scriptId)!.requests[0].appliedVersionNo === 2);

    // ======================================================================
    c.head("7 · a reply");
    const rep = await req.replyToScriptRequest(gB.requests[0].id, "Loved this. I tightened nothing, it's yours as written.", { id: owner.id, name: "Jordan", email: owner.email });
    const msg = await prisma.programMessage.findFirst({ where: { enrollmentId: F.enrollmentId, authorKind: "STAFF" }, orderBy: { createdAt: "desc" } });
    c.ok("it lands under that script (Oct 22 2026), not in their Messages", rep.ok && msg?.refKind === "SCRIPT_THREAD" && msg.refId === B.scriptId && msg.body.startsWith("Loved this."), rep.message);
    const withReply = (await req.loadScriptRequestsForMonth(F.monthId)).find((g) => g.scriptId === B.scriptId)!;
    c.ok("…on the office card under the request, without the prefix", withReply.requests[0].replies.length === 1 && withReply.requests[0].replies[0].body.startsWith("Loved this."));
    const { portalTopics } = await import("@/lib/portal");
    const page = await portalTopics({ id: F.enrollmentId, clientId: F.clientId });
    const tB = page.groups.flatMap((g) => g.topics).find((t) => t.script?.id === B.scriptId);
    const officeSaid = (tB?.script?.thread ?? []).filter((m) => m.from === "office");
    c.ok("…and under the script on their page", officeSaid.length === 1 && officeSaid[0].body.startsWith("Loved this.") && officeSaid[0].by === "Jordan");

    // ======================================================================
    c.head("8 · the month's scripts as one PDF");
    const { monthsReadyForPdf } = await import("@/lib/scriptPdfLinks");
    const monthKey = (await prisma.contentMonth.findUniqueOrThrow({ where: { id: F.monthId } })).monthKey;
    const token = mediaToken(F.enrollmentId, { kind: "enrollment", id: F.enrollmentId });
    const get = (enrollmentId: string, tok: string) => allPdf(new NextRequest(`https://hub.example.test/api/portal/scripts/all/${enrollmentId}?month=${monthKey}&m=${encodeURIComponent(tok)}`), { params: Promise.resolve({ enrollmentId }) });
    c.ok("not offered until every script is approved", (await monthsReadyForPdf(F.enrollmentId)).length === 0);
    const early = await get(F.enrollmentId, token);
    c.ok("…and the door refuses it in plain words", early.status === 403 && /Approve every script/.test(JSON.stringify(await early.json())));
    for (const id of [A.scriptId, B.scriptId, C.scriptId]) {
      const s = await prisma.contentScript.findUniqueOrThrow({ where: { id } });
      const ok = await approveAsOwner(id, s.sharedVersionId!);
      if (!ok.ok) c.ok(`approve ${id}`, false, ok.message);
    }
    const ready = await monthsReadyForPdf(F.enrollmentId);
    c.ok("once all three are approved, the month is offered", ready.length === 1 && ready[0].monthKey === monthKey && ready[0].count === 3, JSON.stringify(ready));
    const pdf = await get(F.enrollmentId, token);
    c.ok("…the PDF downloads, one page a script", pdf.status === 200 && pdf.headers.get("content-type") === "application/pdf" && /Marcee-Requests-TEST/.test(pdf.headers.get("content-disposition") ?? "") && (await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()))).getPageCount() === 3, `${pdf.status} ${pdf.headers.get("content-disposition")}`);
    const G = await buildContentMonth(db, { name: "Other Client TEST", package: "Starter" });
    const cross = await get(F.enrollmentId, mediaToken(G.enrollmentId, { kind: "enrollment", id: G.enrollmentId }));
    c.ok("a token for another client does not open it", cross.status === 403);

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
