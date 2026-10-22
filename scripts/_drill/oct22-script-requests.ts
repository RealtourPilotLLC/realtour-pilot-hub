// ---------------------------------------------------------------------------
// DRILL: THE CLIENT'S SCRIPT CHANGE REQUESTS, AS JORDAN APPROVED THEM (Oct 22 2026).
//
// The design (mock-script-requests) and Jordan's decisions:
//   4. "Use their version" is checked first (length, the five parts, claims
//      nobody made, dashes); sending anyway stays one press.
//   5. Preview first: nothing reaches the client until the office presses Send.
//   6. A client can change several parts in one request.
//   7. "Rewrite with AI" is offered on part changes too.
// Standing rules: neither version wins automatically; a new version is always
// a NEW version (the shared one is never edited); no em dashes in scripts or
// client copy; never promise views.
//
//   1. Portal: a part change with two parts is filed with both (and a note);
//      a message with a pasted rewrite is filed with what it is about.
//   2. Office: the AI read (classification) comes before any rewrite.
//   3. Use their change: the check, then the preview, then Send makes a NEW
//      version; the shared one is never edited; the message posts under the
//      script and in their Messages; the decision is recorded.
//   4. Edit their change starts from their wording.
//   5. Rewrite with AI on a part change: a draft with kept / left out / a
//      message; Redo; edit the draft; send. Nothing reaches the client before.
//   6. Rewrite with AI on a message, sent as drafted.
//   7. Dismiss is recorded; requests from before today read as they did.
//   8. Someone who is not a creative seat cannot act on the card.
//   9. The client's page: the updated version comes back marked, with the
//      message; no em dash in any client copy.
//
// ISOLATION: PGlite via the shared harness; the Anthropic API is faked at the
// fence (nothing leaves).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 7122);
installNextStubs();
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const calls: { kind: "read" | "rewrite"; system: string; prompt: string }[] = [];
let nextRead: Record<string, unknown> = {};
let nextRewrite: Record<string, unknown> = {};
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: string; messages?: { content: string }[] };
    const system = String(body.system ?? "");
    const prompt = String(body.messages?.[0]?.content ?? "");
    if (system.includes("first reader")) {
      calls.push({ kind: "read", system, prompt });
      return json({ model: "claude-sonnet-4-6", usage: { input_tokens: 900, output_tokens: 200 }, content: [{ type: "tool_use", name: "emit", input: nextRead }] });
    }
    if (system.includes("script editor")) {
      calls.push({ kind: "rewrite", system, prompt });
      return json({ model: "claude-sonnet-4-6", usage: { input_tokens: 1500, output_tokens: 600 }, content: [{ type: "tool_use", name: "emit", input: nextRewrite }] });
    }
  }
  return null;
});
const EM = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct22-script-requests", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const scripts = await import("@/lib/contentScripts");
  const portalActions = await import("@/app/portal/actions");
  const office = await import("@/app/content/scriptRequestActions");
  const req = await import("@/lib/scriptRequests");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
  const REPO = process.cwd();
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
  try {
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("ai", "drill-ai-key-not-real");
    const owner = await prisma.appUser.create({ data: { email: "jordan@oct22.test", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "kim@oct22.test", name: "Kim", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const asOwner = () => setSession({ uid: owner.id, email: owner.email, role: "OWNER" });
    await asOwner();
    const F = await buildContentMonth(db, { name: "Marcee Oct22 TEST", package: "Accelerator", topics: [{ title: "Repairs", selection: "SELECTED" }, { title: "Not 2022", selection: "SELECTED" }, { title: "Know Your Buyer", selection: "SELECTED" }, { title: "Pricing", selection: "SELECTED" }] });
    const auth = { token: F.portalToken! };
    const staff = { email: owner.email, appUserId: owner.id };
    const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];
    const V1 = {
      hook: "Most sellers spend their prep budget on the wrong things entirely.",
      points: pts("They look at their home through their own eyes, not through the eyes of the person who is going to buy it.", "Before you touch a thing, know your buyer and bring in a home inspector before the listing goes live.", "Getting that inspection early and making the right repairs can save you money and hassle down the line."),
      close: "Know your buyer. Fix what matters. Protect your sale.",
    };
    const make = async (topicIdx: number, title: string) => {
      const v = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[topicIdx], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { title, ...V1, captionCta: null, filmingNotes: "Office note kept." } });
      await scripts.approveScriptVersion(v.versionId, staff, "drill: no pillar yet");
      await scripts.releaseScriptVersion(v.scriptId, staff);
      return v;
    };
    const A = await make(0, "Repairs That Protect Your Sale");
    const B = await make(1, "This Is Not 2022");
    const C = await make(2, "Know Your Buyer");
    const D = await make(3, "Pricing It Right");
    const versions = (id: string) => prisma.contentScriptVersion.count({ where: { scriptId: id } });
    const staffMessages = () => prisma.programMessage.count({ where: { enrollmentId: F.enrollmentId, authorKind: "STAFF" } });
    const reqOf = async (scriptId: string) => prisma.scriptSuggestion.findFirstOrThrow({ where: { scriptId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    const envOf = async (id: string) => req.envelopeOf((await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id } })).editedPartsJson);
    const groups = async () => req.loadScriptRequestsForMonth(F.monthId);
    const viewOf = async (scriptId: string, id: string) => (await groups()).find((g) => g.scriptId === scriptId)!.requests.find((r) => r.id === id)!;

    // ======================================================================
    c.head("1 · portal: a part change with two parts, a message with a pasted rewrite");
    const HOOK_A = "The repairs you think your house needs before you sell? They might not be where your $40,000 should go.";
    const CLOSE_A = "Know your buyer — fix what matters.";
    const same = await portalActions.portalSendPartChanges(auth, A.scriptId, A.versionId, [{ part: "hook", text: V1.hook }]);
    c.ok("a part change that changes nothing is refused", !same.ok && /reads the same/.test(same.message), same.message);
    const empty = await portalActions.portalSendPartChanges(auth, A.scriptId, A.versionId, [{ part: "hook", text: "  " }]);
    c.ok("an emptied part is refused in plain words", !empty.ok && /Write the new wording for the hook/.test(empty.message), empty.message);
    const n0 = await versions(A.scriptId);
    const sentA = await portalActions.portalSendPartChanges(auth, A.scriptId, A.versionId, [{ part: "hook", text: HOOK_A, note: "I want it to sound more like a question" }, { part: "close", text: CLOSE_A }]);
    c.ok("two parts in one request are sent", sentA.ok && /Jordan looks at your wording/.test(sentA.message) && !EM.test(sentA.message), sentA.message);
    const sA = await reqOf(A.scriptId);
    const eA = req.envelopeOf(sA.editedPartsJson);
    c.ok("…filed once, with both parts, the note, and on the version they read", (await prisma.scriptSuggestion.count({ where: { scriptId: A.scriptId } })) === 1 && sA.scriptVersionId === A.versionId && eA.kind === "PARTS" && JSON.stringify(eA.changed) === JSON.stringify(["hook", "close"]) && eA.hook === HOOK_A && eA.close === CLOSE_A && eA.notes?.hook === "I want it to sound more like a question" && eA.points?.[0] === V1.points[0].text, sA.editedPartsJson ?? "");
    c.ok("…the record's words name both parts (for the bell and the ledger)", /I changed the hook and the close/.test(sA.body) && sA.body.includes(HOOK_A));
    c.ok("…no new version, nothing approved for them, their answer reads 'changes asked'", (await versions(A.scriptId)) === n0 && (await scriptDecisionsFor(F.enrollmentId, [A.scriptId])).get(A.scriptId)?.decision === "CHANGES_REQUESTED");

    const REWRITE_B = "For the heading at the top, I feel like comparing this market to 2022 is overdone. What do you think about either:\n1. Your Neighbor's Sale Is Not Your Selling Strategy\n2. The Most Expensive Words in Real Estate? \"But My Neighbor Got...\"\n\nAlso, what do you think about this script instead?\n\nHOOK\nMy house will be different. That's what so many homeowners tell themselves when they see what the house down the street sold for, and honestly I understand why, because it feels like proof of what yours is worth too.\n\nTALKING POINT 1: RE-HOOK\nBut buyers have options right now, more than they have had in years, and they compare every home they see against everything else on the market that same weekend.\n\nTALKING POINT 2: BUILD-UP\nYour neighbor's sale isn't the whole story. Pricing, preparation, and marketing all matter, and the timing of their sale may have been completely different from yours.\n\nTALKING POINT 3: PAYOFF\nThat's why I study what's selling, what's sitting, and what buyers are passing over, and I have honest conversations with every seller about where their home really fits.\n\nCLOSE / CTA\nThere are still great opportunities out there for sellers who plan well. If you're thinking about selling, let's talk about a strategy built for today's market.";
    const sentB = await portalActions.portalRequestScriptChanges(auth, B.scriptId, REWRITE_B, B.versionId, ["title", "whole"]);
    c.ok("a message with a pasted rewrite is sent", sentB.ok && /^Sent\./.test(sentB.message) && !EM.test(sentB.message), sentB.message);
    const sB = await reqOf(B.scriptId);
    const eB = req.envelopeOf(sB.editedPartsJson);
    c.ok("…filed as a MESSAGE, about the title and the whole script, their words kept whole", eB.kind === "MESSAGE" && JSON.stringify(eB.about) === JSON.stringify(["title", "whole"]) && sB.body === REWRITE_B && !eB.hook);

    // ======================================================================
    c.head("2 · the office card: the AI read comes before any rewrite");
    let gB = await viewOf(B.scriptId, sB.id);
    c.ok("the card shows their message beside our version, the rewrite read as a full script, and its length", gB.kind === "MESSAGE" && gB.merged?.full === true && (gB.theirWords ?? 0) > 110 && gB.readParts?.hook === V1.hook && gB.about.join() === "Title,The whole script", `${gB.theirWords}`);
    c.ok("…no read yet, no draft", gB.read === null && gB.draft === null);
    nextRead = { types: ["TOPIC_CHANGE", "WORDING_PREFERENCE", "ADDITIONAL_EXPERTISE", "LENGTH_PACING"], intent: "A fresher opener than “2022” — and more of how they actually advise sellers.", useful: ["\"my house will be different\"", "neighbors' sale prices", "pricing, preparation and marketing"], recommendation: "Keep the topic. Use their belief-style opener and their process. Cut to 75 to 85 words.", keepTopic: true, watch: "", profileNote: "Warm, direct, reassuring (strategy call)." };
    nextRewrite = {
      title: "This Is Not 2022",
      hook: "\"But my house is different.\" Maybe it is. But that doesn't automatically mean it'll sell for more.",
      points: ["The market has changed. But some homeowners still expect a bidding war by Sunday.", "Buyers have options. Your neighbor's sale isn't the whole story — pricing, preparation, and marketing all matter.", "That's why I study what's selling, what's sitting, and what buyers pass over, and give honest advice on what to do next."],
      close: "There are still great opportunities. And your home is different. That's why it deserves a strategy built for today's market. Let's talk.",
      tags: { hook: "their belief, our framing", point1: "new: tension", point2: "their points", point3: "their process", close: "ties back to the hook" },
      kept: ["\"My house will be different\" as the opening belief", "Neighbors' sale prices, buyers have options", "Pricing, preparation and marketing; honest advice; studying the market"],
      leftOut: [{ what: "A new title", why: "the topic still fits, and \"2022\" is never said on camera" }, { what: "The longer explanations", why: "pacing: the rewrite was over the length cap" }],
      review: [{ key: "on_topic", pass: true, note: "" }, { key: "their_meaning", pass: true }, { key: "hook_grabs", pass: true }, { key: "rehook_new", pass: true }, { key: "payoff_delivers", pass: true }, { key: "close_natural", pass: true }, { key: "sounds_like_them", pass: true }, { key: "claims_supported", pass: true }],
      message: "Marcee, thank you for the rewrite — your points about neighbors' sales and how you study the market are all in this version. I kept the topic, since your ideas fit it well, and tightened it so viewers stay to the end. Let me know if anything isn't accurate or doesn't sound like you!",
    };
    const steer = "Keep the topic. Open on \"But my house is different.\" Leave mortgage rates out: they didn't say it.";
    const before = calls.length;
    const rwB = await office.rewriteScriptRequestAction(sB.id, { steer });
    const made = calls.slice(before);
    c.ok("Rewrite with AI on an unread request reads it FIRST, then rewrites", rwB.ok && made.length === 2 && made[0].kind === "read" && made[1].kind === "rewrite", `${rwB.message} · ${made.map((x) => x.kind).join(",")}`);
    const rp = made[1]?.prompt ?? "";
    c.ok("…the rewrite prompt carries the read: their intent, the useful points, the recommendation", rp.includes("WHAT THEY ARE ASKING FOR") && rp.includes("A fresher opener than") && rp.includes("neighbors' sale prices") && rp.includes("Keep the topic. Use their belief-style opener"));
    c.ok("…the version they read, their message and pasted rewrite, the topic, and the steer only the AI sees", rp.includes(`OUR VERSION THEY READ (v1`) && rp.includes(V1.hook) && rp.includes("comparing this market to 2022 is overdone") && rp.includes("a full rewrite of the script") && rp.includes("THE TOPIC:") && rp.includes(steer));
    const rs = made[1]?.system ?? "";
    c.ok("…and our standards: 55 to 85 aim, 110 cap, the five parts, the close rule, topic, intent and vocabulary, background reasoning, no claims they did not make, no dashes, no promised views",
      /55 to 85 spoken words/.test(rs) && /110 is the hard cap/.test(rs) && /Never make it dry or incomplete/.test(rs) && /RE-HOOK/.test(rs) && /BUILD-UP/.test(rs) && /PAYOFF/.test(rs) && /callback to the hook/.test(rs) && /clear call to action/.test(rs)
      && /keep the topic/i.test(rs) && /legitimate intent and their vocabulary/.test(rs) && /Background reasoning is not spoken content/.test(rs) && /no claims they did not make/i.test(rs) && /Never write an em dash/.test(rs) && /Never promise views/.test(rs));
    const readPrompt = made[0]?.prompt ?? "";
    c.ok("the read prompt asks for the nine feedback types, the intent, the useful points and a recommendation, and rewrites nothing", ["FACTUAL_CORRECTION", "PERSONAL_EXPERIENCE", "WORDING_PREFERENCE", "MISSING_INFORMATION", "ADDITIONAL_EXPERTISE", "TOPIC_CHANGE", "STRUCTURE_SUGGESTION", "LENGTH_PACING", "PURPOSE_DISAGREEMENT"].every((t) => readPrompt.includes(t)) && /nothing is rewritten yet/.test(readPrompt) && /do NOT rewrite/.test(made[0]?.system ?? ""));
    gB = await viewOf(B.scriptId, sB.id);
    c.ok("the card now shows the read: types in Jordan's words, the intent (dashes taken out), the recommendation", gB.read?.types.map((t) => t.label).join("|") === "Topic change request|Wording preference|Additional expertise|Length or pacing" && !!gB.read && !EM.test(gB.read.intent) && /Keep the topic/.test(gB.read.recommendation), JSON.stringify(gB.read?.types));
    const aiRuns = await prisma.programAiRun.findMany({ where: { enrollmentId: F.enrollmentId }, orderBy: { createdAt: "asc" } });
    c.ok("both calls are on the AI ledger through runAiJson (a person's click, prompt keys of their own)", aiRuns.length === 2 && aiRuns[0].promptKey === "script-request-read" && aiRuns[1].promptKey === "script-request-rewrite" && aiRuns.every((r) => r.status === "SUCCEEDED" && r.requestedBy === owner.email && (r.scopeJson ?? "").includes(sB.id)));

    // ======================================================================
    c.head("3 · nothing reaches the client before Send");
    c.ok("the AI draft is on the card: the version, kept, left out, the check, the message", !!gB.draft && gB.draft.kept.length === 3 && gB.draft.leftOut.length === 2 && !!gB.draft.check && gB.draft.nextVersionNo === 2 && gB.draft.tags.hook === "their belief, our framing" && gB.draft.review.length === 8);
    c.ok("…the draft's words and message carry no em dash", !!gB.draft && !EM.test(JSON.stringify(gB.draft.words)) && !EM.test(gB.draft.message));
    c.ok("…no new version, nothing shared, no message to the client", (await versions(B.scriptId)) === 1 && (await prisma.contentScript.findUniqueOrThrow({ where: { id: B.scriptId } })).sharedVersionId === B.versionId && (await staffMessages()) === 0);
    const { portalTopics } = await import("@/lib/portal");
    const pageBefore = await portalTopics({ id: F.enrollmentId, clientId: F.clientId });
    c.ok("…their page still shows version 1", pageBefore.groups.flatMap((g) => g.topics).find((t) => t.script?.id === B.scriptId)?.scriptText?.versionLabel === "v1");
    const hersB = await office.previewScriptRequestAction(sB.id, "HERS");
    c.ok("'Use their version as written' on the long rewrite: the check says it needs a fix (over 110), before anything is sent", hersB.ok && !!hersB.preview && hersB.preview.check.needsFix && hersB.preview.check.items.some((i) => i.key === "length" && i.status === "fix" && /A bit long: needs a fix/.test(i.label)), JSON.stringify(hersB.preview?.check.items));
    c.ok("…and a preview writes nothing", (await versions(B.scriptId)) === 1 && (await staffMessages()) === 0);

    // ======================================================================
    c.head("4 · use their change: checked first, previewed, then Send makes a NEW version");
    const pA = await office.previewScriptRequestAction(sA.id, "HERS");
    const P = pA.preview!;
    c.ok("the preview: version 2, the hook and close changed, their words laid over ours", pA.ok && P.nextVersionNo === 2 && P.readVersionNo === 1 && P.changed.join() === "hook,close" && P.words.hook === HOOK_A && P.words.points[1] === V1.points[1].text, pA.message);
    const item = (k: string) => P.check.items.find((i) => i.key === k);
    c.ok("…the check ran: length, the five parts, claims, dashes", P.check.items.length === 4 && item("structure")?.status === "pass" && /Hook, re-hook, build-up, payoff and close/.test(item("structure")!.label) && !!item("length"));
    c.ok("…their own number is theirs (not a claim nobody made)", item("claims")?.status === "pass", item("claims")?.label);
    c.ok("…their em dash is taken out of the words and said so", item("dashes")?.status === "advisory" && !EM.test(P.words.close) && P.words.close === "Know your buyer, fix what matters.", `${item("dashes")?.label} / ${P.words.close}`);
    c.ok("…a thank-you message is offered, and no message has gone", /Thank you, Marcee! I used your new hook and close as written/.test(P.message) && (await staffMessages()) === 0 && (await versions(A.scriptId)) === 1, P.message);
    const v1Before = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: A.versionId } });
    const MSG_A = "Thank you — I used your hook as written and kept the close close to yours. Take a look and let me know!";
    const sendA = await office.sendScriptRequestAction(sA.id, "HERS", { message: MSG_A, startedFrom: "theirs" });
    const scrA = await prisma.contentScript.findUniqueOrThrow({ where: { id: A.scriptId } });
    const v2A = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: scrA.sharedVersionId! } });
    const v1After = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: A.versionId } });
    c.ok("Send makes a NEW version (v2) on top of the version they read, and shares it", sendA.ok && sendA.versionNo === 2 && v2A.id !== A.versionId && v2A.versionNo === 2 && v2A.basedOnVersionId === A.versionId && v2A.status === "SHARED" && v2A.hook === HOOK_A && v2A.source === "CLIENT_REQUEST", sendA.message);
    c.ok("…the shared version they read is never edited (its words are exactly as before)", v1After.hook === v1Before.hook && v1After.close === v1Before.close && v1After.pointsJson === v1Before.pointsJson && v1After.body === v1Before.body);
    c.ok("…no em dash in the new version, and the office's notes carried over", !EM.test(`${v2A.title} ${v2A.hook} ${v2A.pointsJson} ${v2A.close} ${v2A.body}`) && v2A.filmingNotes === "Office note kept.");
    c.ok("…no sign-off made up for them", !scrA.clientApprovedVersionId && (await scriptDecisionsFor(F.enrollmentId, [A.scriptId])).get(A.scriptId)?.decision === null);
    const msgA = await prisma.programMessage.findFirst({ where: { enrollmentId: F.enrollmentId, authorKind: "STAFF", refId: A.scriptId } });
    c.ok("…the message is in their Messages, about that script, with no em dash", !!msgA && msgA.refKind === "SCRIPT" && /^About your script "Repairs That Protect Your Sale":/.test(msgA.body) && msgA.body.includes("I used your hook as written") && !EM.test(msgA.body), msgA?.body);
    const qA = await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: sA.id } });
    const dA = req.envelopeOf(qA.editedPartsJson).office?.decision;
    c.ok("…the request is kept, APPLIED as theirs, with the version it became", qA.status === "APPLIED" && qA.appliedHow === "HERS" && qA.appliedVersionId === v2A.id && qA.resolvedBy === owner.email && qA.body === sA.body && req.envelopeOf(qA.editedPartsJson).hook === HOOK_A);
    c.ok("…and the decision is recorded: action, versions, final words, changed, kept, the check, the message, who and when",
      !!dA && dA.action === "USE_THEIRS" && dA.requestKind === "PARTS" && dA.fromVersionNo === 1 && dA.versionNo === 2 && dA.final?.hook === HOOK_A && dA.changed.join() === "hook,close" && dA.kept.includes("Their hook, as written") && !!dA.check && dA.check.items.length === 4 && dA.message === msgA?.body.replace(/^About your script "[^"]*":\s*/, "") && dA.messageId === msgA?.id && dA.by === owner.email && !!dA.atISO, JSON.stringify(dA));
    const again = await office.sendScriptRequestAction(sA.id, "HERS", { message: "again" });
    c.ok("a second Send makes nothing", !again.ok && (await versions(A.scriptId)) === 2, again.message);

    // ======================================================================
    c.head("5 · edit their change: it starts from their wording");
    const P2_C = "Know who is buying before you spend a dollar: their age, where they come from, and what they value most.";
    await portalActions.portalSendPartChanges(auth, C.scriptId, C.versionId, [{ part: "point2", text: P2_C }]);
    const sC = await reqOf(C.scriptId);
    const gC = await viewOf(C.scriptId, sC.id);
    c.ok("the card's parts for 'Edit their change' are their wording laid over ours", gC.kind === "PARTS" && gC.merged?.changed.join() === "point2" && gC.merged.parts.points[1].text === P2_C && gC.merged.parts.hook === V1.hook);
    const panel = read("src/components/content/ScriptRequestsPanel.tsx");
    c.ok("…and the editor opens on exactly those words (from: theirs → merged)", /from === "theirs" && merged \? \{ title: r\.readTitle \?\? g\.title, hook: merged\.hook, points: merged\.points\.map\(\(p\) => p\.text\), close: merged\.close \}/.test(panel) && /startEdit\("theirs"\)/.test(panel));
    const edited = { hook: V1.hook, points: [V1.points[0].text, "Know who is buying before you spend a dollar: their age, where they come from, what they value.", V1.points[2].text], close: V1.close };
    const pC = await office.previewScriptRequestAction(sC.id, "EDITED", { words: edited, title: "Know Your Buyer", message: "Loved your idea! I tightened it a little." });
    c.ok("the edit previews as version 2 with only talking point 2 changed", pC.ok && pC.preview!.changed.join() === "point2" && pC.preview!.nextVersionNo === 2 && (await versions(C.scriptId)) === 1, pC.message);
    const sendC = await office.sendScriptRequestAction(sC.id, "EDITED", { words: edited, title: "Know Your Buyer", message: "Loved your idea! I tightened it a little.", startedFrom: "theirs" });
    const qC = await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: sC.id } });
    const dC = req.envelopeOf(qC.editedPartsJson).office?.decision;
    const v2C = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: C.scriptId }, orderBy: { versionNo: "desc" } });
    c.ok("sent as a new hand-edited version, recorded as an edit of their change", sendC.ok && v2C.versionNo === 2 && v2C.source === "MANUAL" && JSON.parse(v2C.pointsJson)[1].text === edited.points[1] && qC.appliedHow === "EDITED" && dC?.action === "EDIT_THEIRS" && dC.kept.includes("Their talking point 2, edited"), JSON.stringify(dC?.kept));

    // ======================================================================
    c.head("6 · Rewrite with AI on a part change (decision 7): draft, redo, edit, send");
    await portalActions.portalSendPartChanges(auth, D.scriptId, D.versionId, [{ part: "hook", text: "Pricing your home is the one decision you can't take back once it's listed." }, { part: "point3", text: "Price it right on day one and buyers compete for it." }]);
    const sD = await reqOf(D.scriptId);
    nextRead = { types: ["WORDING_PREFERENCE", "STRUCTURE_SUGGESTION"], intent: "A sharper hook and a clearer payoff.", useful: ["the one decision you can't take back"], recommendation: "Use their hook; keep our build-up.", keepTopic: true };
    const rd = await office.readScriptRequestAction(sD.id);
    c.ok("the office reads it first (the card's read)", rd.ok && rd.read?.types.map((t) => t.key).join() === "WORDING_PREFERENCE,STRUCTURE_SUGGESTION" && (await viewOf(D.scriptId, sD.id)).read?.intent === "A sharper hook and a clearer payoff.");
    const readsSoFar = calls.filter((x) => x.kind === "read").length;
    const rd2 = await office.readScriptRequestAction(sD.id);
    c.ok("…opening the card again does not call the AI again", rd2.ok && calls.filter((x) => x.kind === "read").length === readsSoFar);
    nextRewrite = {
      title: "Pricing It Right", hook: "Pricing your home is the one decision you can't take back once it's listed.",
      points: ["The first weekend decides how buyers see it.", "I've sold 200 homes and I watch what is selling and what is sitting.", "Price it right on day one and buyers compete for it."],
      close: "Thinking about selling? Let's price it right together.",
      tags: { hook: "their wording", point3: "their payoff" }, kept: ["Their hook, as written", "Their payoff"], leftOut: [],
      review: [{ key: "claims_supported", pass: false, note: "200 homes is not in their words" }, { key: "on_topic", pass: true }],
      message: "Thanks for the new hook! It's in, word for word. Take a look and let me know if anything isn't accurate.",
    };
    const m0 = await staffMessages();
    const rwD = await office.rewriteScriptRequestAction(sD.id, {});
    const partPrompt = calls.at(-1)?.prompt ?? "";
    c.ok("Rewrite with AI works on a part change: the prompt names their parts beside ours", rwD.ok && partPrompt.includes("A PART CHANGE") && partPrompt.includes("they changed hook and talking point 3") && partPrompt.includes("THEIRS: Pricing your home is the one decision"), rwD.message);
    let gD = await viewOf(D.scriptId, sD.id);
    const claimsD = gD.draft?.check?.items.find((i) => i.key === "claims");
    c.ok("…the draft's check catches a claim nobody made", claimsD?.status === "fix" && /200/.test(claimsD.label), claimsD?.label);
    c.ok("…and nothing reached the client", (await versions(D.scriptId)) === 1 && (await staffMessages()) === m0);
    const firstRun = gD.draft!.runId;
    nextRewrite = { ...nextRewrite, points: ["The first weekend decides how buyers see it.", "I watch what is selling, what is sitting, and what buyers pass over.", "Price it right on day one and buyers compete for it."], review: [{ key: "claims_supported", pass: true }] };
    const redo = await office.rewriteScriptRequestAction(sD.id, { redo: "Take out the 200 homes: they never said it." });
    const redoPrompt = calls.at(-1)?.prompt ?? "";
    gD = await viewOf(D.scriptId, sD.id);
    c.ok("Redo: the AI sees its previous draft and the note; the new draft replaces it", redo.ok && redoPrompt.includes("YOUR PREVIOUS DRAFT") && redoPrompt.includes("I've sold 200 homes") && redoPrompt.includes("Take out the 200 homes") && gD.draft!.runId !== firstRun && gD.draft!.redo.join() === "Take out the 200 homes: they never said it.");
    c.ok("…the replaced draft's run is marked superseded", (await prisma.programAiRun.findUniqueOrThrow({ where: { id: firstRun } })).disposition === "SUPERSEDED");
    const draftWords = gD.draft!.words;
    const editedDraft = { ...draftWords, close: "Thinking about selling this year? Let's price it right together." };
    const pD = await office.previewScriptRequestAction(sD.id, "AI_EDITED", { words: editedDraft, title: gD.draft!.title, draftRunId: gD.draft!.runId, message: gD.draft!.message });
    c.ok("'Edit the draft myself' previews the edited draft", pD.ok && pD.preview!.how === "AI_EDITED" && pD.preview!.words.close === editedDraft.close && pD.preview!.check.items.find((i) => i.key === "claims")?.status === "pass", pD.message);
    const stale = await office.sendScriptRequestAction(sD.id, "AI_EDITED", { words: editedDraft, title: gD.draft!.title, draftRunId: firstRun, message: "x" });
    c.ok("…a send naming an old draft is refused", !stale.ok && /changed or was discarded/.test(stale.message));
    const sendD = await office.sendScriptRequestAction(sD.id, "AI_EDITED", { words: editedDraft, title: gD.draft!.title, draftRunId: gD.draft!.runId, message: gD.draft!.message, startedFrom: "draft" });
    const v2D = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: D.scriptId }, orderBy: { versionNo: "desc" } });
    const dD = req.envelopeOf((await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: sD.id } })).editedPartsJson).office?.decision;
    c.ok("sent: a new version tied to the AI run, the decision an edited AI rewrite with what was kept, the run marked EDITED",
      sendD.ok && v2D.versionNo === 2 && v2D.source === "REVISION" && v2D.aiRunId === gD.draft!.runId && v2D.close === editedDraft.close && dD?.action === "AI_REWRITE_EDITED" && dD.aiDraftEdited && dD.aiRunId === gD.draft!.runId && dD.kept.includes("Their hook, as written") && dD.redo.length === 1 && dD.classification?.intent === "A sharper hook and a clearer payoff."
      && (await prisma.programAiRun.findUniqueOrThrow({ where: { id: gD.draft!.runId } })).disposition === "EDITED", sendD.message);

    // ======================================================================
    c.head("7 · Rewrite with AI on a message, sent as drafted");
    gB = await viewOf(B.scriptId, sB.id);
    const sendB = await office.sendScriptRequestAction(sB.id, "AI", { draftRunId: gB.draft!.runId, message: gB.draft!.message, startedFrom: "draft" });
    const scrB = await prisma.contentScript.findUniqueOrThrow({ where: { id: B.scriptId } });
    const v2B = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: scrB.sharedVersionId! } });
    const msgB = await prisma.programMessage.findFirst({ where: { enrollmentId: F.enrollmentId, authorKind: "STAFF", refId: B.scriptId } });
    const qB = await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: sB.id } });
    const dB = req.envelopeOf(qB.editedPartsJson).office?.decision;
    c.ok("v2 is the AI draft's words, shared; the draft's dash is gone from the script", sendB.ok && v2B.versionNo === 2 && v2B.hook.startsWith("\"But my house is different.\"") && !EM.test(v2B.pointsJson) && v2B.title === "This Is Not 2022", sendB.message);
    c.ok("…the AI-drafted message went out without its em dash", !!msgB && !EM.test(msgB.body) && /thank you for the rewrite/.test(msgB.body));
    c.ok("…their request and their rewrite stay on the card as handled, with the AI's kept and left out", qB.status === "APPLIED" && qB.appliedHow === "AI" && qB.body === REWRITE_B && dB?.action === "AI_REWRITE" && dB.leftOut.length === 2 && dB.kept.length === 3 && dB.classification?.types.includes("TOPIC_CHANGE") === true);
    c.ok("…the run is marked ACCEPTED and points at the version", (await prisma.programAiRun.findUniqueOrThrow({ where: { id: gB.draft!.runId } })).disposition === "ACCEPTED" && (await prisma.programAiRun.findUniqueOrThrow({ where: { id: gB.draft!.runId } })).outputRef === `ContentScriptVersion:${v2B.id}`);
    const handledB = await viewOf(B.scriptId, sB.id);
    c.ok("…and the handled card shows what was sent, kept and left out", handledB.decision?.versionNo === 2 && handledB.decision.final?.parts.hook.startsWith("\"But my house") === true && handledB.decision.leftOut.length === 2 && handledB.draft === null && handledB.read !== null);

    // ======================================================================
    c.head("8 · dismiss; and requests from before today read as they did");
    const v2Aid = scrA.sharedVersionId!;
    await portalActions.portalRequestScriptChanges(auth, A.scriptId, "Can the whole thing feel more upbeat?", v2Aid, []);
    const sA2 = await reqOf(A.scriptId);
    const dis = await office.dismissScriptRequestAction(sA2.id);
    const dA2 = (await envOf(sA2.id)).office?.decision;
    c.ok("Dismiss: the request stays, DISMISSED, and the decision is recorded", dis.ok && (await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: sA2.id } })).status === "DISMISSED" && dA2?.action === "DISMISS" && dA2.by === owner.email && (await versions(A.scriptId)) === 2);
    // Oct 20 shapes, written directly (no migration of old requests).
    const legacyWords = { hook: "Seniors or first-time buyers? Turns out I get both.", points: [V1.points[0].text, V1.points[1].text, V1.points[2].text], close: V1.close };
    const legacyEdit = await prisma.scriptSuggestion.create({ data: { scriptId: C.scriptId, enrollmentId: F.enrollmentId, scriptVersionId: C.versionId, body: "I edited the script:\n\nHOOK\nSeniors or first-time buyers? Turns out I get both.", editedPartsJson: JSON.stringify(legacyWords), status: "APPLIED", appliedHow: "HERS", appliedVersionId: v2C.id, resolvedAt: new Date(), resolvedBy: "jordan@oct20.test" } });
    const legacyNote = await prisma.scriptSuggestion.create({ data: { scriptId: C.scriptId, enrollmentId: F.enrollmentId, scriptVersionId: C.versionId, body: "Close/CTA: If you're thinking of moving this year, message me.", status: "OPEN" } });
    const gLegacy = (await groups()).find((g) => g.scriptId === C.scriptId)!;
    const le = gLegacy.requests.find((r) => r.id === legacyEdit.id)!, ln = gLegacy.requests.find((r) => r.id === legacyNote.id)!;
    c.ok("an Oct 20 in-place edit, handled: still 'used their version as v2', its words beside ours, no new-style record", !!le && le.legacy && le.kind === "PARTS" && le.status === "APPLIED" && le.appliedHow === "HERS" && le.appliedVersionNo === 2 && le.edited && le.merged?.parts.hook === legacyWords.hook && le.decision === null && le.read === null);
    c.ok("an Oct 20 plain note, open: read as a message (its one-part close still read as a script part)", !!ln && ln.legacy && ln.kind === "MESSAGE" && ln.merged?.changed.join() === "close" && ln.read === null);
    const pBase = await office.previewScriptRequestAction(legacyNote.id, "HERS");
    c.ok("a second request on version 1, answered after v2 was shared: the check says v2's changes would go back", pBase.ok && pBase.preview!.check.needsFix && pBase.preview!.check.items.some((i) => i.key === "base" && i.status === "fix" && /Version 2 was shared after Marcee asked/.test(i.label)), JSON.stringify(pBase.preview?.check.items.map((i) => i.key)));

    // ======================================================================
    c.head("9 · someone who is not a creative seat cannot act on the card");
    await setSession({ uid: editor.id, email: editor.email, role: "EDITOR" });
    const tries = await Promise.all([
      office.readScriptRequestAction(legacyNote.id, { again: true }), office.rewriteScriptRequestAction(legacyNote.id, {}), office.previewScriptRequestAction(legacyNote.id, "HERS"),
      office.sendScriptRequestAction(legacyNote.id, "HERS", { message: "hi" }), office.dismissScriptRequestAction(legacyNote.id), office.discardScriptRequestDraftAction(legacyNote.id),
    ]);
    c.ok("an editor's session is refused on read, rewrite, preview, send, dismiss and discard", tries.every((t) => !t.ok), tries.map((t) => t.message).join(" | "));
    await clearSession();
    const anon = await office.sendScriptRequestAction(legacyNote.id, "HERS", { message: "hi" });
    c.ok("…and so is no session at all (a client on the portal)", !anon.ok);
    c.ok("…nothing changed: still open, still one version, no message, no AI call", (await prisma.scriptSuggestion.findUniqueOrThrow({ where: { id: legacyNote.id } })).status === "OPEN" && (await versions(C.scriptId)) === 2 && (await prisma.programMessage.count({ where: { refId: C.scriptId } })) === 1);
    await asOwner();

    // ======================================================================
    c.head("10 · the client's page: the updated version comes back");
    const ups = await req.portalScriptUpdates(F.enrollmentId, [A.scriptId, B.scriptId, C.scriptId, D.scriptId]);
    const uA = ups[A.scriptId];
    c.ok("version 2 from their change, compared with version 1, the changed parts marked", !!uA && uA.versionNo === 2 && uA.fromVersionNo === 1 && uA.changed.join() === "hook,close" && uA.previous?.parts.hook === V1.hook && uA.requestedAtISO === sA.createdAt.toISOString(), JSON.stringify(uA?.changed));
    c.ok("…with the message on top, from Jordan, initials for the avatar", uA?.message?.by === "Jordan" && uA.message.initials === "JS" && uA.message.body.startsWith("Thank you. I used your hook"), JSON.stringify(uA?.message));
    const pageAfter = await portalTopics({ id: F.enrollmentId, clientId: F.clientId });
    const tA = pageAfter.groups.flatMap((g) => g.topics).find((t) => t.script?.id === A.scriptId);
    c.ok("their page now shows v2 and the message under the script", tA?.scriptText?.versionLabel === "v2" && tA.script?.replies?.some((m) => m.body.startsWith("Thank you. I used your hook")) === true);
    c.ok("the AI-rewritten one comes back too", ups[B.scriptId]?.versionNo === 2 && (ups[B.scriptId]?.changed.length ?? 0) >= 3);

    // ======================================================================
    c.head("11 · client copy: no em dashes");
    const card = read("src/components/portal/ScriptApprovalCard.tsx");
    const planTab = read("src/components/portal/tabs/PlanTab.tsx");
    // Comments are not copy: only what renders or is sent is scanned.
    const code = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const strings = (raw: string) => { const src = code(raw); return [...src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g), ...src.matchAll(/"([^"\n]{12,})"/g), ...src.matchAll(/`([^`\n]{12,})`/g)].map((m) => m[1]); };
    c.ok("the client's script card and Scripts view print no em dash", !strings(card).some((s) => EM.test(s)) && !strings(planTab.slice(planTab.indexOf("function ScriptsView"))).some((s) => EM.test(s)));
    c.ok("…the card has the approved copy: Change this part, Ask for a change in your own words, About, Send to Jordan, the part note", /Change this part/.test(card) && /Ask for a change in your own words/.test(card) && /Anything we should know\?/.test(card) && /Send to \{READER\}/.test(card) && /const READER = "Jordan"/.test(card) && /\+ Change another part too/.test(card) && /Send my change/.test(card));
    const reqLib = read("src/lib/scriptRequests.ts");
    const clientMsgs = [...reqLib.matchAll(/message: "([^"]+)"/g)].map((m) => m[1]);
    c.ok("…and no message the portal returns carries one", clientMsgs.length > 10 && !clientMsgs.some((m) => EM.test(m)));
    c.ok("a message that promises views is flagged on the preview", req.promisesReach("This will get you more views than ever!") && !req.promisesReach("Take a look and let me know."));

    c.ok("no call left the drill (the AI answered at the fence)", fence.blocked.length === 0 && fence.faked.every((u) => u === "https://api.anthropic.com/v1/messages"), fence.blocked.join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
    fence.restore();
  }
  // Exit on the tally: a socket the database server closes after stop() must not decide the verdict.
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
