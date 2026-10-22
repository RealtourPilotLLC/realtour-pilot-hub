// ---------------------------------------------------------------------------
// DRILL: PHOTO ASKS OFF THE VIDEO (Oct 22 2026, 859 N Lawrence St, Joseph Sutow).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct22-photo-asks-off-video.ts
//
// Jordan: "Joe Sutow texted about a video revision, then texted about virtual
// staging in photos. The photo staging issue is showing up on the video
// review room. It should not be." Every item split out of a client's message
// now says what it is about (lib/itemMedium); photo items go to the photo
// job's client asks (lib/briefPhotoAsks), never the editor or the Video
// Review Room.
//
//   1. pure: the backstop ("photo 38" is a photo item when the model said
//      "unclear" or gave no label, unless a video is named; the model's own
//      label always wins, audit C2), echoes, office questions, the split of
//      open questions
//   2. Joe's real sequence on 859 N Lawrence St:
//      a. a video-only text ("the Cafe La Maude sign twice"): unchanged: the
//         video reopens, one editor issue, no photo ask, photos untouched
//      b. a photo-only text ("virtually stage the upper patio, pic 38"): no
//         video review card, no editor issue, not on the editor's brief; one
//         open question for Jordan or Kyle on the photo job (new work), the
//         photo job reopened, the message not filed twice
//      c. "Outdoor furniture, fire pit table, plants?": unclear by itself, the
//         conversation says photos: the photo lane, the video card untouched;
//         its words join the same photo-38 question; its video question stays
//   3. a mixed text: the video part to the review room (with everything they
//      said), the photo part to the photo job (with everything they said)
//   4. the backstop at work: the model calls "virtually stage photo 12"
//      unclear on a job with no staging ordered: a photo item, an office
//      question (scope or price), not an editor change
//   5. an unclear ask never takes over the open video card; an item about
//      both / unclear shows in both places, labelled
//
// ISOLATION: PGlite via the shared harness; the brain stubbed at its one
// function; the work-order model answered here; nothing else leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6831);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- the brain, stubbed at its one function ----
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

// ---- the work-order model, answered by message ----
type Item = { area: string; ask: string; kind: string; detail: string; quote: string; scope: string; videos: string[]; medium?: string };
const answers: { match: RegExp; items: Item[]; questions: string[] }[] = [];
const briefBodies: string[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const raw = String(init?.body ?? "{}");
    const body = JSON.parse(raw) as { messages?: { content: string }[] };
    const prompt = String(body.messages?.[0]?.content ?? "");
    if (prompt.includes("--- WHAT THE CLIENT SAID ---")) {
      briefBodies.push(raw);
      const said = prompt.split("--- WHAT THE CLIENT SAID ---")[1].split("--- THE CONVERSATION AROUND IT")[0];
      const a = answers.find((x) => x.match.test(said));
      return json({ content: [{ type: "tool_use", name: "emit", input: { headline: "Changes", items: a?.items ?? [], keep: [], references: [], questions: a?.questions ?? [] } }] });
    }
    return json({ content: [{ type: "text", text: "ok" }] });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  return null;
});
const item = (p: Partial<Item> & { ask: string }): Item => ({ area: "Other", kind: "REFINEMENT", detail: "", quote: "", scope: "all", videos: [], ...p });

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const op = await import("@/lib/integrations/openphone");
  const texts: string[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_f: string, to: string, body: string) => { texts.push(`${to}: ${body}`); return { data: { id: `op-${texts.length}` } }; };
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("ai", "drill-ai-key-not-real");

  const M = await import("@/lib/itemMedium");
  const { recordClientCommunication, raiseRevisionDetailed } = await import("@/lib/comms");
  const { openCreativeReviews } = await import("@/lib/creativeReview");
  const { getRevisionBriefs } = await import("@/lib/revisionBrief");
  const asked = await import("@/lib/photoDelivery/clientAsked");
  const delivery = await import("@/lib/photoDelivery/delivery");
  const H = await import("@/lib/photoDelivery/holding");

  // ---- the people ----
  await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan@drill.test", role: "PHOTOGRAPHER" } });
  const kyle = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.test", role: "ADMIN" } });
  await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", teamMemberId: kyle.id, label: "Kyle Smith" } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.test", role: "PHOTOGRAPHER" } });

  // A delivered job: photos (delivered) and one approved, delivered video.
  async function mkJob(o: { street: string; client: string; staging: boolean; videoOnly?: boolean }) {
    const client = await prisma.client.create({ data: { name: o.client, phone: `(215) 555-0${Math.floor(100 + Math.random() * 899)}` }, select: { id: true, name: true } });
    const project = await prisma.project.create({
      data: {
        title: `${o.street}, Philadelphia, PA 19123`, clientId: client.id, status: "DELIVERED",
        shootDate: new Date(Date.now() - 2 * DAY), deliveredAt: new Date(Date.now() - 2 * HOUR), photographerId: harrison.id,
        removalNotes: "Nothing needs removal, confirmed by the photographer.", cullingConfirmedAt: new Date(Date.now() - DAY),
        deliverables: { create: [...(o.videoOnly ? [] : [{ type: "PHOTOS" as const, label: "Photos", quantity: 1 }]), { type: "VIDEO", label: "Standard Package", videoStyle: "standard_cinematic", quantity: 1 }, ...(o.staging ? [{ type: "VIRTUAL_STAGING" as const, label: "Virtual Staging", quantity: 1 }] : [])] },
      },
      select: { id: true, title: true, deliverables: { select: { id: true, type: true } } },
    });
    const video = project.deliverables.find((d) => d.type === "VIDEO")!;
    const sub = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: video.id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "Done_859.mov", assetUrl: `/api/review/cut/${project.id}/stream`, decidedBy: "Jordan Spackman", decidedAt: new Date(Date.now() - 3 * HOUR), submittedByKey: "john", sentToClientAt: new Date(Date.now() - 2 * HOUR) } });
    const out = await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: video.id, slot: 1, category: "VIDEO", currentSubmissionId: sub.id, approvedSubmissionId: sub.id, deliveredAt: new Date(Date.now() - 2 * HOUR) } });
    await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { outputId: out.id } });
    const job = o.videoOnly ? { id: "" } : await prisma.photoJob.create({ data: { projectId: project.id, stage: "DELIVERED", deliveredAt: new Date(Date.now() - 10 * HOUR) } });
    return { client, project, sub, job };
  }
  // The client's text, as the OpenPhone webhook logs it and then hands it on.
  let minute = 0;
  async function textIn(j: { client: { id: string; name: string }; project: { id: string } }, text: string, decision: Partial<Decision> = {}) {
    minute++;
    await prisma.commLog.create({ data: { channel: "text", direction: "in", clientId: j.client.id, clientName: j.client.name, contactName: j.client.name, projectId: j.project.id, body: text, occurredAt: new Date(Date.now() - (60 - minute) * 1000), source: "openphone" } });
    const status = (await prisma.project.findUniqueOrThrow({ where: { id: j.project.id } })).status;
    nextDecision = { actionable: true, projectId: j.project.id, title: "Client asked for changes", detail: "x", priority: "HIGH", mergeIntoTaskId: null, isRevisionRequest: true, flags: [], reason: "change to delivered work", taskType: "client_reply", asks: [], ...decision };
    await recordClientCommunication({ clientId: j.client.id, clientName: j.client.name, projectId: j.project.id, projectStatus: status, text, kind: "text", source: "openphone", contactName: j.client.name });
  }
  const ourReply = (j: { client: { id: string; name: string }; project: { id: string } }, text: string) =>
    prisma.commLog.create({ data: { channel: "text", direction: "out", clientId: j.client.id, clientName: j.client.name, contactName: "Kyle Smith", projectId: j.project.id, body: text, occurredAt: new Date(Date.now() - (60 - ++minute) * 1000), source: "openphone" } });
  const briefFor = (projectId: string, words: string) => prisma.revisionBrief.findFirstOrThrow({ where: { projectId, originalText: { contains: words } }, orderBy: { createdAt: "desc" } });
  const itemsOf = (b: { itemsJson: string | null }) => (JSON.parse(b.itemsJson ?? "{}") as { items?: { id: string; medium?: string; cuts?: string[] | null; held?: boolean }[]; questions?: string[]; photoQuestions?: string[] });
  // The client's asks (the photographer's wrap-up notes are filed as asks too, source "wrapup": not counted here).
  const openAsks = (projectId: string) => prisma.clientAsk.findMany({ where: { projectId, state: "OPEN", kind: "SPECIAL_REQUEST", source: { in: ["text", "email", "call", "staff"] } }, orderBy: { askedAt: "asc" } });
  const issuesOf = (briefId: string) => prisma.revisionIssue.count({ where: { sourceId: { startsWith: `${briefId}:` } } });
  const holdingOf = async (jobId: string, projectId: string) => {
    const gate = await delivery.deliveryGate(jobId);
    const stage = (await prisma.photoJob.findUniqueOrThrow({ where: { id: jobId } })).stage;
    return {
      gate,
      view: H.holdingFor({
        jobId, projectId, stage, holdReason: null, holdNote: null, lastError: null, waitingForVisit: null, photographer: "Harrison Wells",
        decisions: { critical: 0, major: 0, minor: 0 }, listingUrl: null, orderUrl: null, deliveryCheckNote: null, listingUpdates: { photoIds: [], names: [] },
        gate, push: { mode: "off", connected: false, sameDayAuto: false, progress: null },
      }),
    };
  };

  // =========================================================================
  c.head("1 · pure: what each item is about");
  // =========================================================================
  c.ok("'Virtually stage the upper patio (photo 38)' is a photo item when the model said unclear or nothing; the model's own label wins (audit C2)", M.itemMediumOf("Virtually stage the upper patio (photo 38).") === "photo" && M.itemMediumOf("Virtually stage the upper patio (photo 38).", "unclear") === "photo" && M.itemMediumOf("Virtually stage the upper patio (photo 38).", "video") === "video");
  c.ok("…'pic 11', 'photos', 'twilight', 'lot lines', 'floor plan', 'virtual staging': photos", ["Restage pic 11 with a dining table", "Brighten the photos", "Add a twilight", "Draw the lot lines", "Fix the floor plan", "Redo the virtual staging"].every((t) => M.itemMediumOf(t) === "photo"));
  c.ok("…unless a video is named: 'the twilight photo as the video's opening' keeps the model's label (video)", M.itemMediumOf("Use the twilight photo as the video's opening", "video") === "video" && M.itemMediumOf("Use the twilight photo as the video's opening") === "both");
  c.ok("…V1 or a timestamp names a video: 'photo at 0:12 in V1' is not forced to photos", M.itemMediumOf("The photo at 0:12 in V1 is dark", "video") === "video");
  c.ok("the Cafe La Maude sign in the video: video; the model's own label stands", M.itemMediumOf("Remove one of the two Cafe La Maude signs from the video.") === "video" && M.itemMediumOf("Remove one of the two Cafe La Maude signs from the video.", "photo") === "photo");
  c.ok("no words either way: the model's label, else video (rows written before labels stay video)", M.itemMediumOf("Make it brighter", "unclear") === "unclear" && M.itemMediumOf("Make it brighter") === "video" && M.mediumOfItem({}) === "video");
  c.ok("a staging 'scene' is not a video ('new virtual staging scene not previously ordered')", M.itemMediumOf("Virtually stage photo 38. This is a new virtual staging scene not previously ordered.") === "photo");
  c.ok("labels: both and unclear say so; one medium says nothing", M.mediumLabel("both") === "Photos and video" && M.mediumLabel("unclear") === "Photos or video? Not clear" && M.mediumLabel("photo") === null && M.mediumLabel("video") === null);
  c.ok("an echo: an item quoting an earlier message is not this message's", M.isEcho("they included the Cafe La Maude sign twice", "Outdoor furniture, fire pit table, plants? 🤷‍♂️") && !M.isEcho("are they able to virtually stage the upper patio. Now pic 38 … Outdoor furniture, fire pit table, plants? 🤷‍♂️", "Outdoor furniture, fire pit table, plants? 🤷‍♂️") && !M.isEcho("", "anything"));
  c.ok("an office question: a photo item the model calls SCOPE, or virtual staging on an order with none", M.isOfficeQuestion({ kind: "SCOPE", medium: "photo", ask: "Stage photo 38" }, { stagingOrdered: true }) && M.isOfficeQuestion({ kind: "REFINEMENT", medium: "photo", ask: "Virtually stage photo 12" }, { stagingOrdered: false }) && !M.isOfficeQuestion({ kind: "REFINEMENT", medium: "photo", ask: "Restage pic 11 with a dining table" }, { stagingOrdered: true }) && !M.isOfficeQuestion({ kind: "SCOPE", medium: "video", ask: "Make a second reel" }, { stagingOrdered: false }));
  const lw = M.labelWorkOrder({ items: [{ ask: "Stage photo 38" }, { ask: "Cut the intro of the video" }], questions: ["Photo 38: what furniture?", "V1: which sign appearance?", "What timing works?"] });
  c.ok("questions about the photos leave the video side; the rest stay", JSON.stringify(lw.photoQuestions) === JSON.stringify(["Photo 38: what furniture?"]) && JSON.stringify(lw.questions) === JSON.stringify(["V1: which sign appearance?", "What timing works?"]) && lw.items[0].medium === "photo" && lw.items[1].medium === "video");
  c.ok("a portal or staff request pinned to a video stays the video's, whatever its words", M.labelWorkOrder({ items: [{ ask: "the photo at the start is dark" }], questions: ["Photo 3?"] }, { videoOnly: true }).items[0].medium === "video");

  // =========================================================================
  c.head("2a · 859 N Lawrence St, 5:05 PM: a video-only text is unchanged");
  // =========================================================================
  const L = await mkJob({ street: "859 N Lawrence Street", client: "Joseph Sutow", staging: true });
  const cafe = "The video looks great. Only edit is that they included the Cafe La Maude sign twice so could they edit out one of them quickly?";
  answers.push({ match: /Cafe La Maude sign twice/, items: [item({ area: "Cuts & content", ask: "Remove one of the two appearances of the Cafe La Maude sign from the video.", kind: "CORRECTION", quote: "they included the Cafe La Maude sign twice so could they edit out one of them quickly?", medium: "video" })], questions: [] });
  await textIn(L, cafe);
  const bA = await briefFor(L.project.id, "Cafe La Maude sign twice");
  const lastBody = briefBodies.at(-1) ?? "";
  c.ok("the work order asks the model what each item is about (rule 13, the medium field)", /SAY WHAT EACH ITEM IS ABOUT \(medium\)/.test(lastBody) && /"medium"/.test(lastBody) && /never put a photo item on a video/.test(lastBody));
  c.ok("the video reopens for it (the cut is back with the editor)", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: L.sub.id } })).status === "CHANGES_REQUESTED");
  c.ok("its item is a video item, on the video, and one editor issue", itemsOf(bA).items?.[0]?.medium === "video" && (itemsOf(bA).items?.[0]?.cuts ?? []).length === 1 && (await issuesOf(bA.id)) === 1);
  const videoTask = await prisma.smartTask.findUniqueOrThrow({ where: { id: bA.taskId! } });
  c.ok("the video revision card: 'Video revision', the editor's", /^Video revision/.test(videoTask.title) && !!videoTask.assignedKey && videoTask.assignedKey !== "kyle", `${videoTask.title} / ${videoTask.assignedKey}`);
  c.ok("…on the editor's brief", (await getRevisionBriefs(L.project.id, true)).some((b) => b.id === bA.id && b.items.length === 1));
  c.ok("nothing filed for the photos; the photos stay delivered", (await openAsks(L.project.id)).length === 0 && (await prisma.photoJob.findUniqueOrThrow({ where: { id: L.job.id } })).stage === "DELIVERED");
  c.ok("no creative review card (nothing unclear, no question)", (await openCreativeReviews(L.project.id)).length === 0);

  // =========================================================================
  c.head("2b · 5:07 PM: a photo-only text (virtual staging, pic 38) never reaches the video");
  // =========================================================================
  await ourReply(L, "Yep, sure! I can let the editor know");
  const patio = "And are they able to virtually stage the upper patio. Now pic 38";
  answers.push({
    match: /virtually stage the upper patio\. Now pic 38/,
    items: [item({ area: "Graphics & effects", ask: "Virtually stage the upper patio (photo 38).", kind: "SCOPE", detail: "Photo 38, upper patio. No furniture style given.", quote: "are they able to virtually stage the upper patio. Now pic 38", medium: "photo" })],
    questions: ["Photo 38 (upper patio) virtual staging: what furniture style, pieces, or mood should be used?"],
  });
  await textIn(L, patio, { asks: [{ kind: "SPECIAL_REQUEST", text: patio, summary: "Virtually stage the upper patio (pic 38)", medium: "photo", projectHint: L.project.id }] });
  const bB = await briefFor(L.project.id, "Now pic 38");
  const docB = itemsOf(bB);
  c.ok("its item is a photo item, on no video; its question is the photo job's", docB.items?.[0]?.medium === "photo" && !docB.items?.[0]?.cuts && (docB.questions ?? []).length === 0 && (docB.photoQuestions ?? []).length === 1);
  c.ok("NO video review card for it", (await openCreativeReviews(L.project.id)).length === 0 && !(await prisma.smartTask.findUnique({ where: { dedupeKey: `creative-review:${bB.id}` } })));
  c.ok("no editor issue, and not on the editor's brief", (await issuesOf(bB.id)) === 0 && !(await getRevisionBriefs(L.project.id, true)).some((b) => b.id === bB.id) && !(await getRevisionBriefs(L.project.id, false)).some((b) => b.id === bB.id));
  c.ok("the video card is untouched (still 'Video revision', still the editor's, no staging words on it)", await (async () => { const t = await prisma.smartTask.findUniqueOrThrow({ where: { id: videoTask.id } }); return /^Video revision/.test(t.title) && t.assignedKey === videoTask.assignedKey && !/patio/.test(t.description ?? ""); })());
  const asksB = await openAsks(L.project.id);
  const office = asksB.find((a) => (a.dedupeKey ?? "").startsWith(`${M.PHOTO_OFFICE_KEY_PREFIX}${L.project.id}:38`));
  c.ok("it lands on the photo job: ONE open ask (the message is not filed twice)", asksB.length === 1 && !!office, asksB.map((a) => `${a.dedupeKey}: ${a.summary}`).join(" | "));
  c.ok("…a question for the office: new work not on the order, holding the photos, the client's full words", !!office && office.medium === "photo" && office.holdsDelivery && /Not on the order: confirm the scope or price with the client first\./.test(office.summary ?? "") && office.text.includes(patio) && office.source === "text" && office.askedBy === "Joseph Sutow", office?.summary ?? undefined);
  const pB = await prisma.photoJob.findUniqueOrThrow({ where: { id: L.job.id } });
  const pTask = await prisma.smartTask.findUnique({ where: { dedupeKey: asked.photoRevisionTaskKey(L.project.id) } });
  c.ok("the photo job reopens ('Client asked for changes after delivery'), on the delivery owner's list", pB.stage === "REVISION_REQUESTED" && !!pTask && pTask.status === "OPEN" && pTask.ownerId === kyle.id, `${pB.stage} / ${pTask?.ownerId}`);
  const hB = await holdingOf(L.job.id, L.project.id);
  const lineB = hB.gate.checks.find((x) => x.askId === office?.id);
  c.ok("'What's holding this': 'Question for Jordan or Kyle: …', waiting on Jordan or Kyle, settled not 'fixed'", !!lineB && /^Question for Jordan or Kyle: Virtually stage the upper patio \(photo 38\)\./.test(lineB.label) && lineB.hold === true && lineB.waitingOn === "Waiting on Jordan or Kyle" && lineB.doneLabel === "Settled with the client", lineB?.label);
  const viewB = hB.view.items.find((x) => x.key === `ask:${office?.id}`);
  c.ok("…the panel line says who answers it, and its button", !!viewB && viewB.waitingOn === "Waiting on Jordan or Kyle" && viewB.action?.kind === "ask" && viewB.action.label === "Settled with the client");
  c.ok("…with everything they said", !!viewB?.said && viewB.said.text.includes("virtually stage the upper patio"));
  c.ok("the timeline says where it went", !!(await prisma.activity.findFirst({ where: { projectId: L.project.id, body: { contains: "about the photos went to the photo job" } } })));

  // =========================================================================
  c.head("2c · 5:09 PM: 'Outdoor furniture, fire pit table, plants?' (unclear alone; the conversation says photos)");
  // =========================================================================
  await ourReply(L, "Got it, I'll request those changes, any specific requests for 38?");
  const plants = "Outdoor furniture, fire pit table, plants? 🤷‍♂️";
  answers.push({
    match: /Outdoor furniture, fire pit table, plants/,
    items: [
      // The model lifts the earlier ask out of the conversation (as it did on Oct 22) …
      item({ area: "Cuts & content", ask: "Remove one of the two appearances of the Cafe La Maude sign from the video.", kind: "CORRECTION", quote: cafe, medium: "video" }),
      // … and reads this message as the staging direction for photo 38.
      item({ area: "Graphics & effects", ask: "Virtually stage photo 38 (upper patio) with outdoor furniture, a fire pit table, and plants.", kind: "SCOPE", detail: "This is a new virtual staging scene not previously ordered.", quote: "are they able to virtually stage the upper patio. Now pic 38 … Outdoor furniture, fire pit table, plants? 🤷‍♂️", medium: "photo" }),
    ],
    questions: ["Photo 38 (upper patio) virtual staging appears to be new work not included in the original order. Can Jordan confirm scope?", "For the Cafe La Maude sign in V1: which of the two appearances should be kept?"],
  });
  await textIn(L, plants, { asks: [] });
  const bC = await briefFor(L.project.id, "fire pit table");
  const vt = await prisma.smartTask.findUniqueOrThrow({ where: { id: videoTask.id } });
  c.ok("it joins the PHOTO card (the conversation's reading), not the video one", bC.taskId !== videoTask.id && bC.taskId === pTask?.id, `${bC.taskId} vs video ${videoTask.id}`);
  c.ok("the video card keeps its title, its editor and its words", /^Video revision/.test(vt.title) && vt.assignedKey === videoTask.assignedKey && !(vt.description ?? "").includes("fire pit"), `${vt.title} / ${vt.assignedKey}`);
  const asksC = await openAsks(L.project.id);
  const officeC = asksC.find((a) => a.id === office?.id);
  c.ok("its words join the same open photo-38 question (one question, both messages)", asksC.length === 1 && !!officeC && officeC.text.includes(patio) && officeC.text.includes("fire pit table") && /Then they asked: Virtually stage photo 38 \(upper patio\) with outdoor furniture/.test(officeC.summary ?? ""), officeC?.summary ?? undefined);
  c.ok("the Cafe La Maude ask the model lifted from the earlier text is not filed again anywhere", (await issuesOf(bC.id)) === 0 && !asksC.some((a) => /Cafe/.test(a.summary ?? "")));
  const cardsC = await openCreativeReviews(L.project.id);
  c.ok("the Video Review Room: one card, its video question only (the Cafe La Maude sign), never photo 38", cardsC.length === 1 && cardsC[0].briefId === bC.id && cardsC[0].questions.length === 1 && /Cafe La Maude sign in V1/.test(cardsC[0].questions[0]) && !JSON.stringify(cardsC).includes("upper patio\"") && cardsC[0].held.length === 0, JSON.stringify(cardsC.map((x) => x.questions)));
  c.ok("…and it says the photo part went to the photo job", /went to the photo job/.test(cardsC[0]?.photoNote ?? ""));

  // =========================================================================
  c.head("3 · a mixed text splits: the video part to the review room, the photo part to the photo job");
  // =========================================================================
  const X = await mkJob({ street: "12 Mixed Ave", client: "Mia Mixed", staging: true });
  const mixed = "Can you turn the music down in the video? Also the virtual staging of pic 11 should show a small dining table.";
  answers.push({
    match: /turn the music down/,
    items: [
      item({ area: "Music & sound", ask: "Lower the music in the video.", kind: "REFINEMENT", quote: "Can you turn the music down in the video?", medium: "video" }),
      item({ area: "Graphics & effects", ask: "Restage photo 11 with a small dining table.", kind: "REFINEMENT", quote: "the virtual staging of pic 11 should show a small dining table.", medium: "photo" }),
    ],
    questions: ["V1: how much quieter should the music be?"],
  });
  await textIn(X, mixed, { asks: [{ kind: "SPECIAL_REQUEST", text: "the virtual staging of pic 11 should show a small dining table", summary: "Restage pic 11", medium: "photo", projectHint: X.project.id }] });
  const bX = await briefFor(X.project.id, "turn the music down");
  const docX = itemsOf(bX);
  c.ok("one message, two labels: the music is video (on the video), pic 11 is photo (on no video)", docX.items?.find((i) => i.id === "i1")?.medium === "video" && (docX.items?.find((i) => i.id === "i1")?.cuts ?? []).length === 1 && docX.items?.find((i) => i.id === "i2")?.medium === "photo" && !docX.items?.find((i) => i.id === "i2")?.cuts);
  c.ok("the editor gets the music only: one issue, one item on the brief, and a line saying the photo part went elsewhere", (await issuesOf(bX.id)) === 1 && await (async () => { const v = (await getRevisionBriefs(X.project.id, true)).find((b) => b.id === bX.id); return !!v && v.items.length === 1 && /music/i.test(v.items[0].ask) && v.photoPart === 1; })());
  const cardX = (await openCreativeReviews(X.project.id))[0];
  c.ok("the review room card: the video question only, with everything they said", !!cardX && cardX.questions.length === 1 && /music/.test(cardX.questions[0]) && cardX.originalText === mixed && /photo job/.test(cardX.photoNote ?? ""));
  const asksX = await openAsks(X.project.id);
  c.ok("the photo job: one ask, 'Restage photo 11 …', with everything they said; not filed twice", asksX.length === 1 && asksX[0].medium === "photo" && /^Restage photo 11 with a small dining table/.test(asksX[0].summary ?? "") && asksX[0].text === mixed, asksX.map((a) => a.summary).join(" | "));
  const hX = await holdingOf(X.job.id, X.project.id);
  const viewX = hX.view.items.find((x) => x.key === `ask:${asksX[0]?.id}`);
  c.ok("…'Client asked: Restage photo 11 …' waiting on Kyle, Done (fixed), and 'Everything they said' holds the whole message", !!viewX && /^Client asked: Restage photo 11/.test(viewX.text) && viewX.waitingOn === "Waiting on Kyle" && viewX.action?.kind === "ask" && viewX.action.label === "Done (fixed)" && viewX.said?.text === mixed);
  c.ok("…and the photos reopen for it", (await prisma.photoJob.findUniqueOrThrow({ where: { id: X.job.id } })).stage === "REVISION_REQUESTED");

  // =========================================================================
  c.head("4 · the backstop: the model calls 'virtually stage photo 12' unclear; no staging was ordered");
  // =========================================================================
  const R = await mkJob({ street: "40 Ray Rd", client: "Ray Nostaging", staging: false });
  const stage12 = "Can you virtually stage photo 12 as a living room?";
  answers.push({ match: /stage photo 12/, items: [item({ area: "Graphics & effects", ask: "Virtually stage photo 12 as a living room.", kind: "REFINEMENT", quote: stage12, medium: "unclear" })], questions: [] });
  await textIn(R, stage12, { asks: [{ kind: "SPECIAL_REQUEST", text: stage12, summary: "Stage photo 12", medium: "photo", projectHint: R.project.id }] });
  const bR = await briefFor(R.project.id, "stage photo 12");
  c.ok("stored as a photo item: the model was not sure and the words name a photo", itemsOf(bR).items?.[0]?.medium === "photo");
  c.ok("not an editor change: no issue, not on the brief, no card, the video not reopened", (await issuesOf(bR.id)) === 0 && (await getRevisionBriefs(R.project.id, true)).length === 0 && (await openCreativeReviews(R.project.id)).length === 0 && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: R.sub.id } })).status === "APPROVED");
  const asksR = await openAsks(R.project.id);
  c.ok("an office question (scope or price) on the photo job, for Jordan or Kyle", asksR.length === 1 && (asksR[0].dedupeKey ?? "").startsWith(`${M.PHOTO_OFFICE_KEY_PREFIX}${R.project.id}:12`) && /Not on the order/.test(asksR[0].summary ?? ""), asksR.map((a) => `${a.dedupeKey} ${a.summary}`).join(" | "));
  const hR = await holdingOf(R.job.id, R.project.id);
  c.ok("…'Question for Jordan or Kyle', waiting on Jordan or Kyle", hR.view.items.some((x) => x.key === `ask:${asksR[0]?.id}` && /^Question for Jordan or Kyle:/.test(x.text) && x.waitingOn === "Waiting on Jordan or Kyle"));

  // =========================================================================
  c.head("5 · an unclear ask: never takes over the video card; shown in both places, labelled");
  // =========================================================================
  const U = await mkJob({ street: "7 Unclear Ct", client: "Una Unclear", staging: true });
  const first = "The video is great but please cut the drone clip at 0:20.";
  answers.push({ match: /drone clip at 0:20/, items: [item({ area: "Cuts & content", ask: "Cut the drone clip at 0:20 from the video.", kind: "CORRECTION", quote: first, medium: "video" })], questions: [] });
  await textIn(U, first);
  const uVideo = await prisma.smartTask.findUniqueOrThrow({ where: { id: (await briefFor(U.project.id, "drone clip")).taskId! } });
  const vague = "Can it all be a bit brighter?";
  answers.push({ match: /a bit brighter/, items: [item({ area: "Color & styling", ask: "Brighten it a bit.", kind: "REFINEMENT", quote: vague, medium: "unclear" })], questions: [] });
  // Straight to the revision (no conversation to read): the words alone are unclear.
  await raiseRevisionDetailed({ projectId: U.project.id, clientId: U.client.id, clientName: U.client.name, note: vague, source: "openphone", requestedBy: { name: U.client.name, kind: "TEXT" } });
  const uAfter = await prisma.smartTask.findUniqueOrThrow({ where: { id: uVideo.id } });
  c.ok("the open video card keeps its title and its editor (it was 'Revision', Kyle's, before)", /^Video revision/.test(uAfter.title) && uAfter.assignedKey === uVideo.assignedKey && uAfter.assignedKey !== "kyle" && (uAfter.description ?? "").includes(vague), `${uAfter.title} / ${uAfter.assignedKey}`);
  const bU = await briefFor(U.project.id, "a bit brighter");
  const editorU = (await getRevisionBriefs(U.project.id, true)).find((b) => b.id === bU.id);
  c.ok("the video side: the item stays, labelled 'Photos or video? Not clear'", !!editorU && editorU.items.length === 1 && M.mediumLabel(editorU.items[0].medium) === "Photos or video? Not clear");
  const asksU = await openAsks(U.project.id);
  c.ok("the photo side: the same item, labelled, never dropped", asksU.length === 1 && asksU[0].medium === "unclear" && (asksU[0].dedupeKey ?? "").startsWith(M.PHOTO_SHARED_KEY_PREFIX));
  const hU = await holdingOf(U.job.id, U.project.id);
  c.ok("…'Client asked (not clear if photos or video): Brighten it a bit'", hU.view.items.some((x) => x.key === `ask:${asksU[0]?.id}` && /^Client asked \(not clear if photos or video\): Brighten it a bit/.test(x.text)));

  // =========================================================================
  c.head("6 · a video-only order: every word is the video's ('the picture is shaky')");
  // =========================================================================
  const V = await mkJob({ street: "3 Video Only Ln", client: "Vic Videoonly", staging: false, videoOnly: true });
  const shaky = "The picture is shaky at the start, can you fix it?";
  answers.push({ match: /picture is shaky/, items: [item({ area: "Pacing & movement", ask: "Stabilize the shaky picture at the start.", kind: "CORRECTION", quote: shaky, medium: "photo" })], questions: [] });
  await textIn(V, shaky);
  const bV = await briefFor(V.project.id, "picture is shaky");
  c.ok("the item is the video's (no photo work on the order), on the video, one editor issue, no ask filed", itemsOf(bV).items?.[0]?.medium === "video" && (itemsOf(bV).items?.[0]?.cuts ?? []).length === 1 && (await issuesOf(bV.id)) === 1 && (await openAsks(V.project.id)).length === 0);

  c.head("Nothing left the hub");
  c.ok("no text went to anyone", texts.length === 0, texts.join(" | "));
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
