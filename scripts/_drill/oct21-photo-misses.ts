// ---------------------------------------------------------------------------
// DRILL: PHOTO MISSES (Oct 21 2026, 859 N Lawrence St, Joseph Sutow).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct21-photo-misses.ts
//
// Jordan: "Kyle should not have missed this on Joe's photos. Can we figure out
// why he may have missed this, what info we have, and make sure things like
// this do not get missed again?" The promise (crop out the wooden sidewalk
// forms) was never recorded: no wrap-up, the free check's findings were set
// aside (stock reason, and the prep gate called the sidewalk "lived in"), the
// photos went out, and the client's text two hours later was merged into an
// unrelated to-do, called "pre-delivery work", assigned to nobody.
//
//   1. pure: careful ignores, the approve summary, the client's photo numbers,
//      outside findings, the wrap-up rule, "the same request"
//   2. the prep gate never sets an outside finding aside (a lived-in room, an
//      as-is home); one it set aside before is reopened; inside clutter still is
//   3. ignoring with care: a major outside finding or a trash can needs the
//      person's own words (the stock "Not worth a fix" is refused); inside
//      and minor items keep the stock reason; a listing ignore is no rule change
//   4. the approve summary: "You're delivering with 6 exterior issues ignored
//      (construction materials ×4, trash cans ×2)", never the hub's own
//      set-asides; on the delivery's activity
//   5. the wrap-up gate: a line naming the photographer, its page linked
//      (since Oct 23 2026 information for Kyle, never his hold: the hub's own
//      same-day delivery still waits); a typed reason is recorded, the hub
//      never goes past it; the wrap-up in clears it and its removal notes become an item
//   6. client asked, before delivery: each photo request holds Approve and
//      deliver with its photo numbers until Done or answered with a note
//  6b. the order note (the shape of 859 N Lawrence St): written on the Aryeo
//      order before the shoot, read by the same reader as the "Before you
//      send" box → a blocking "Client asked (order note)" item → the sidewalk
//      finding linked to it ("Client asked for this to be removed (order
//      note)"), not set aside (nor skipped) until it is answered → delivery
//      refused until then
//   7. after delivery: the client's text routes to the photo job (ask filed,
//      job reopened "Client asked for changes after delivery", the delivery
//      owner's task, never a name search), with no retitling merge; the old
//      wrong judgement (not a revision, an ask) lands the same way; the ask
//      survives the delivered-jobs sweep and holds the next delivery
//   8. the brain's inputs: "PHOTOS DELIVERED" per order, and the rule
//   9. every Smart Brain to-do gets a person; a merge only for the same request
//
// ISOLATION: PGlite via the shared harness; the brain stubbed at its one
// function (section 8 runs the real router with the model answered here).
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7621);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- the brain, stubbed at its one function (section 8 uses the real one) ----
type Ask = { kind: "SPECIAL_REQUEST" | "SCHEDULING"; text: string; summary: string; medium: "video" | "photo" | "both" | "unclear"; projectHint: string | null };
type Decision = { actionable: boolean; projectId: string | null; title: string; detail: string; priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW"; mergeIntoTaskId: string | null; isRevisionRequest: boolean; flags: string[]; reason: string; taskType: "client_reply" | "todo"; asks?: Ask[] };
let nextDecision: Decision | null = null;
let realBrain = false;
interceptModule(
  (r) => r === "@/lib/brain" || /[\\/]src[\\/]lib[\\/]brain(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "routeCommTask" && !realBrain ? async () => nextDecision : t[k]; } }),
);
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => null : t[k]; } }),
);
installNextStubs();

let routerAnswer = "{}";
const prompts: string[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
    const prompt = String(body.messages?.[0]?.content ?? "");
    prompts.push(prompt);
    if (prompt.includes("Decide how we should handle this message")) return json({ content: [{ type: "text", text: routerAnswer }] });
    return json({ content: [{ type: "text", text: "{}" }] });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  return null;
});

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

  const care = await import("@/lib/photoDelivery/careRules");
  const reg = await import("@/lib/photoDelivery/registry");
  const prep = await import("@/lib/photoDelivery/prep");
  const asked = await import("@/lib/photoDelivery/clientAsked");
  const delivery = await import("@/lib/photoDelivery/delivery");
  const decisions = await import("@/lib/photoDelivery/decisions");
  const ca = await import("@/lib/clientAsks");
  const tasks = await import("@/lib/tasks");

  // ---- the people: a decoy "Kyle" first, so a name search would find the wrong row ----
  const decoy = await prisma.teamMember.create({ data: { name: "Kyle Decoy", email: "decoy@drill.test" } });
  const kyle = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.test", role: "ADMIN" } });
  await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", teamMemberId: kyle.id, label: "Kyle Smith" } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.test", role: "PHOTOGRAPHER" } });
  const joe = await prisma.client.create({ data: { name: "Joseph Sutow", phone: "(215) 555-0144" }, select: { id: true, name: true } });
  const { kyleDesk } = await import("@/lib/kyleNotice");
  const desk = await kyleDesk();

  // A job whose every other checklist line passes: the drill sees exactly what its own lines do.
  let n = 0;
  async function mkJob(o: { street: string; stage?: string; status?: "REVIEW" | "DELIVERED" | "EDITING"; photographer?: boolean; shootDate?: Date; removalNotes?: string | null; culled?: boolean; sameDay?: boolean; rooms?: string[]; jobDeliveredAt?: Date | null; projectDeliveredAt?: Date | null }) {
    n++;
    const project = await prisma.project.create({
      data: {
        title: `${o.street}, Philadelphia, PA 19123`,
        clientId: joe.id,
        status: o.status ?? "REVIEW",
        shootDate: o.shootDate ?? new Date(Date.now() - DAY),
        deliveredAt: o.projectDeliveredAt ?? null,
        photographerId: o.photographer === false ? null : harrison.id,
        removalNotes: o.removalNotes ?? null,
        cullingConfirmedAt: o.culled ? new Date(Date.now() - 20 * HOUR) : null,
        deliverables: { create: [{ type: "PHOTOS", label: o.sameDay ? "Same Day Photos" : "Photos", quantity: 1 }, { type: "VIDEO", label: "Listing video", quantity: 1 }] },
      },
      select: { id: true, title: true },
    });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: o.stage ?? "READY", deliveredAt: o.jobDeliveredAt ?? null } });
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", startedAt: new Date(Date.now() - 2 * HOUR), finishedAt: new Date(Date.now() - HOUR), checksJson: JSON.stringify({ done: {}, errors: {}, skipped: [], rooms: {} }) } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id } });
    const photos = [];
    for (const [i, room] of (o.rooms ?? ["EXTERIOR_FRONT", "KITCHEN"]).entries()) {
      photos.push(await prisma.photoAsset.create({ data: { jobId: job.id, name: `${n}-${i + 1}.jpg`, sequence: i + 1, roomType: room, contentHash: `h${n}-${i}`, inspectedHash: `h${n}-${i}`, width: 4000, height: 2667, format: "jpeg" } }));
    }
    return { project, job, run, photos };
  }
  const finding = (jobId: string, runId: string, photoId: string, ruleId: string, severity = "MAJOR", extra: Record<string, unknown> = {}) =>
    prisma.photoQcFinding.create({ data: { qcRunId: runId, jobId, photoId, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "AHDR", specificIssue: ruleId, explanation: "x", severity, confidence: 0.9, responsibility: "PHOTOGRAPHER", fixStrategy: "AUTOREMOVE_MASK", status: "OPEN", ...extra } });
  const line = (g: Awaited<ReturnType<typeof delivery.deliveryGate>>, key: string) => g.checks.find((x) => x.key === key);

  // =========================================================================
  c.head("1 · pure rules");
  // =========================================================================
  c.ok("a major outside finding needs the person's own words", care.needsOwnWords({ severity: "MAJOR", exterior: true, alwaysFixed: false }));
  c.ok("…anything always fixed does, even minor or inside (a kitchen trash can)", care.needsOwnWords({ severity: "MINOR", exterior: false, alwaysFixed: true }));
  c.ok("…a minor outside one and a major inside one keep the stock reasons", !care.needsOwnWords({ severity: "MINOR", exterior: true, alwaysFixed: false }) && !care.needsOwnWords({ severity: "MAJOR", exterior: false, alwaysFixed: false }));
  c.ok("the stock 'Not worth a fix on this listing' is not own words; a preset plus a real sentence is", !care.ownWordsOk("Not worth a fix on this listing") && !care.ownWordsOk("Client preference: ok") && care.ownWordsOk("Client preference: the builder wants the forms shown"));
  c.ok("the summary: 'You're delivering with 6 exterior issues ignored (construction materials ×4, trash cans ×2).'", care.ignoredSummaryLine([{ label: "trash cans", n: 2, exterior: true }, { label: "construction materials", n: 4, exterior: true }]) === "You're delivering with 6 exterior issues ignored (construction materials ×4, trash cans ×2).");
  c.ok("…inside always-fixed only: 'always-fixed'; a mix says both; nothing: null", /2 always-fixed issues ignored \(trash cans ×2\)/.test(care.ignoredSummaryLine([{ label: "trash cans", n: 2, exterior: false }]) ?? "") && /exterior or always-fixed/.test(care.ignoredSummaryLine([{ label: "a", n: 1, exterior: true }, { label: "b", n: 1, exterior: false }]) ?? "") && care.ignoredSummaryLine([]) === null);
  const joeText = "James and Harrison said we could crop out the wooden sidewalk forms in the photos. Photos 1-5 and 38-40";
  c.ok("Joe's photo numbers: '1-5, 38-40'", care.photoNumbers(joeText) === "1-5, 38-40", String(care.photoNumbers(joeText)));
  c.ok("…'photo #12', 'pics 3, 7 & 9'; no numbers: null; '2026' is not a photo", care.photoNumbers("can you fix photo #12") === "12" && care.photoNumbers("pics 3, 7 & 9 please") === "3, 7, 9" && care.photoNumbers("crop the forms") === null && care.photoNumbers("photos from 2026") === null);
  c.ok("outside: an EXT_ rule, a rule whose rooms are all outside (a sky), or any rule on a photo of the outside", reg.isExteriorFinding("EXT_CONSTRUCTION_MATERIALS", "KITCHEN") && reg.isExteriorFinding("SKY_OVERSATURATED", null) && reg.isExteriorFinding("PREP_OTHER_PERSONAL_BELONGINGS", "YARD") && !reg.isExteriorFinding("PREP_OTHER_PERSONAL_BELONGINGS", "LIVING") && !reg.isExteriorFinding("KIT_GARBAGE_CANS", "KITCHEN"));
  const wf = { hasPhotographer: true, removalNotes: null as string | null, cullingConfirmedAt: null as Date | null, photosOwed: true, submitted: false, legacy: false };
  c.ok("the wrap-up: missing until the removal notes are answered AND the cull confirmed", asked.wrapUpMissing(wf).missing && asked.wrapUpMissing({ ...wf, removalNotes: "x" }).missing && asked.wrapUpMissing({ ...wf, cullingConfirmedAt: new Date() }).missing && !asked.wrapUpMissing({ ...wf, removalNotes: "Nothing needs removal — confirmed by the photographer.", cullingConfirmedAt: new Date() }).missing);
  c.ok("…no photographer, or a shoot from before the wrap-up existed: nothing to wait for", !asked.wrapUpMissing({ ...wf, hasPhotographer: false }).missing && !asked.wrapUpMissing({ ...wf, legacy: true }).missing);
  const same = tasks.isSameRequest;
  c.ok("the same request: 'Reschedule 320 Tarbert shoot to Thursday' / 'Confirm Thursday 3pm for 320 Tarbert shoot'", same({ title: "Reschedule 320 Tarbert shoot to Thursday", summary: "Client asked to move the shoot to Thursday", propertyAddress: "320 Tarbert Dr, X" }, { title: "Confirm Thursday 3pm for 320 Tarbert shoot", detail: "Client confirms Thursday at 3pm works", propertyAddress: "320 Tarbert Dr, X" }));
  c.ok("…a different one on the same property is not ('Send the invoice' / 'Crop sidewalk forms from photos')", !same({ title: "Resend the invoice for 859 N Lawrence", summary: "Client asked for the invoice again", propertyAddress: "859 N Lawrence St, Philadelphia" }, { title: "Crop sidewalk forms from photos 1-5 and 38-40", detail: "Client says James and Harrison promised the wooden sidewalk forms would be cropped out", propertyAddress: "859 N Lawrence St, Philadelphia" }));

  // =========================================================================
  c.head("2 · the prep gate never sets an outside finding aside");
  // =========================================================================
  c.ok("pure: construction materials on a lived-in front photo: counts (was 'room not prepared')", prep.gateFor({ ruleId: "EXT_CONSTRUCTION_MATERIALS", confidence: 0.9 }, "PREPARED", "lived_in", "EXTERIOR_FRONT") === null && prep.gateFor({ ruleId: "EXT_CONSTRUCTION_MATERIALS", confidence: 0.9 }, "PREPARED", "lived_in") === null);
  c.ok("…an as-is home: the hose and a belonging in the yard still count; the clothes inside are set aside", prep.gateFor({ ruleId: "EXT_GARDEN_HOSES", confidence: 0.9 }, "AS_IS", "tidy", "EXTERIOR_FRONT") === null && prep.gateFor({ ruleId: "PREP_OTHER_PERSONAL_BELONGINGS", confidence: 0.9 }, "AS_IS", "tidy", "YARD") === null && prep.gateFor({ ruleId: "BED_CLOTHES_LEFT_OUT", confidence: 0.9 }, "AS_IS", "tidy", "BEDROOM")?.reason === prep.AS_IS_REASON);
  c.ok("…inside clutter in a lived-in room: still set aside", prep.gateFor({ ruleId: "BED_CLOTHES_LEFT_OUT", confidence: 0.9 }, "PREPARED", "lived_in", "BEDROOM")?.by === prep.GATE_BY.room);
  const G = await mkJob({ street: "10 Gate Ln", rooms: ["EXTERIOR_FRONT", "YARD", "BEDROOM"] });
  await prisma.photoAsset.updateMany({ where: { jobId: G.job.id }, data: { prep: "lived_in" } });
  const gForms = await finding(G.job.id, G.run.id, G.photos[0].id, "EXT_CONSTRUCTION_MATERIALS", "MAJOR", { status: "IGNORED", decidedBy: prep.GATE_BY.room, statusReason: "This room was not prepared (lived in): clutter not checked here" });
  const gYard = await finding(G.job.id, G.run.id, G.photos[1].id, "PREP_OTHER_PERSONAL_BELONGINGS");
  const gClothes = await finding(G.job.id, G.run.id, G.photos[2].id, "BED_CLOTHES_LEFT_OUT");
  await prisma.photoJob.update({ where: { id: G.job.id }, data: { prepMode: "PREPARED", prepModeBy: "auto" } });
  const g1 = await prep.applyPrepGate(G.job.id);
  const st = async (id: string) => (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id } })).status;
  c.ok("the sidewalk forms the gate set aside before are reopened", (await st(gForms.id)) === "OPEN" && g1.reopened === 1, JSON.stringify(g1));
  c.ok("…the belonging in the yard stays open; the bedroom clothes are set aside", (await st(gYard.id)) === "OPEN" && (await st(gClothes.id)) === "IGNORED");
  await prisma.photoJob.update({ where: { id: G.job.id }, data: { prepMode: "AS_IS", prepModeBy: "Jordan" } });
  await prep.applyPrepGate(G.job.id);
  c.ok("an as-is home: nothing outside set aside", (await st(gForms.id)) === "OPEN" && (await st(gYard.id)) === "OPEN" && (await st(gClothes.id)) === "IGNORED");

  // =========================================================================
  c.head("3 · ignoring with care");
  // =========================================================================
  const I = await mkJob({ street: "20 Care Ct", rooms: ["EXTERIOR_FRONT", "KITCHEN", "LIVING"], removalNotes: "Nothing needs removal — confirmed by the photographer.", culled: true });
  const iForms = await finding(I.job.id, I.run.id, I.photos[0].id, "EXT_CONSTRUCTION_MATERIALS");
  const iCan = await finding(I.job.id, I.run.id, I.photos[1].id, "KIT_GARBAGE_CANS", "MINOR");
  const iRemote = await finding(I.job.id, I.run.id, I.photos[2].id, "LIV_REMOTE_CONTROLS", "MAJOR");
  const iHoseMinor = await finding(I.job.id, I.run.id, I.photos[0].id, "EXT_GARDEN_HOSES", "MINOR");
  const stock = "Not worth a fix on this listing";
  const r1 = await decisions.decideFindings({ jobId: I.job.id, findingIds: [iForms.id], status: "IGNORED", reason: stock, by: "Kyle Smith" });
  c.ok("the sidewalk forms (major, outside) with the stock reason: refused, and says why", !r1.ok && /own words/.test(r1.message) && (await st(iForms.id)) === "OPEN", r1.message);
  const r1b = await decisions.decideFindings({ jobId: I.job.id, findingIds: [iForms.id], status: "OVERRIDDEN", reason: "ok", by: "Kyle Smith" });
  c.ok("…overriding it with two letters: refused too", !r1b.ok);
  const r2 = await decisions.decideFindings({ jobId: I.job.id, findingIds: [iCan.id], status: "IGNORED", reason: null, by: "Kyle Smith" });
  c.ok("a kitchen trash can (always fixed), even minor, with no reason: refused", !r2.ok && (await st(iCan.id)) === "OPEN", r2.message);
  const r3 = await decisions.decideFindings({ jobId: I.job.id, findingIds: [iForms.id], status: "IGNORED", reason: "Client said the forms stay, the builder needs them shown", by: "Kyle Smith" });
  c.ok("…with the person's own words: set aside, the words kept", r3.ok && (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: iForms.id } })).statusReason === "Client said the forms stay, the builder needs them shown");
  const r4 = await decisions.decideFindings({ jobId: I.job.id, findingIds: [iRemote.id], status: "IGNORED", reason: stock, by: "Kyle Smith" });
  const r5 = await decisions.decideFindings({ jobId: I.job.id, findingIds: [iHoseMinor.id], status: "IGNORED", reason: null, by: "Kyle Smith" });
  c.ok("the stock reason still works for a major inside item; a minor outside one needs none", r4.ok && r5.ok, `${r4.message} / ${r5.message}`);
  const { houseRules } = await import("@/lib/photoDelivery/houseRules");
  c.ok("a listing-specific ignore is not a rule rejection (nothing switched off house-wide)", (await houseRules()).length === 0);
  const data = await import("@/app/ops/photo-delivery/data");
  const viewI = await data.loadJobDetail(I.job.id, { viewer: { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false } });
  const fv = (id: string) => viewI?.findings.find((f) => f.id === id);
  c.ok("the job page knows which are outside and which are always fixed (the prompt asks for own words on those)", fv(iForms.id)?.exterior === true && fv(iCan.id)?.alwaysFixed === true && fv(iRemote.id)?.exterior === false);

  // =========================================================================
  c.head("4 · the approve summary");
  // =========================================================================
  const S = await mkJob({ street: "30 Summary St", rooms: ["EXTERIOR_FRONT", "EXTERIOR_SIDE", "KITCHEN", "EXTERIOR_REAR"], removalNotes: "Nothing needs removal — confirmed by the photographer.", culled: true });
  const sIds: string[] = [];
  for (const i of [0, 0, 1, 1]) sIds.push((await finding(S.job.id, S.run.id, S.photos[i].id, "EXT_CONSTRUCTION_MATERIALS")).id);
  const cans = [(await finding(S.job.id, S.run.id, S.photos[0].id, "EXT_TRASH_CANS_PRIMARY")).id, (await finding(S.job.id, S.run.id, S.photos[1].id, "EXT_TRASH_CANS_PRIMARY")).id];
  const why = "Builder's forms and the city's cans, client was told";
  c.ok("set aside by a person with their own words (one reason per group)", (await decisions.decideFindings({ jobId: S.job.id, findingIds: sIds, status: "IGNORED", reason: why, by: "Kyle Smith" })).ok && (await decisions.decideFindings({ jobId: S.job.id, findingIds: cans, status: "IGNORED", reason: why, by: "Kyle Smith" })).ok);
  // Not counted: the gate's own set-aside, a photo left out, a check switched off, an inside major.
  await finding(S.job.id, S.run.id, S.photos[2].id, "BED_CLOTHES_LEFT_OUT", "MAJOR", { status: "IGNORED", decidedBy: prep.GATE_BY.room });
  await finding(S.job.id, S.run.id, S.photos[3].id, "EXT_TRASH_CANS_PRIMARY", "MAJOR", { status: "IGNORED", decidedBy: "Kyle Smith", statusReason: "x" });
  await prisma.photoAsset.update({ where: { id: S.photos[3].id }, data: { status: "EXCLUDED" } });
  await finding(S.job.id, S.run.id, S.photos[0].id, "EXT_GARDEN_HOSES", "MAJOR", { status: "IGNORED", decidedBy: "Jordan", statusReason: "Not checked any more: no" });
  await finding(S.job.id, S.run.id, S.photos[2].id, "LIV_REMOTE_CONTROLS", "MAJOR", { status: "IGNORED", decidedBy: "Kyle Smith", statusReason: stock });
  const sum = await asked.ignoredCarefulSummary(S.job.id);
  c.ok("'You're delivering with 6 exterior issues ignored (construction materials ×4, trash cans ×2).'", sum === "You're delivering with 6 exterior issues ignored (construction materials ×4, trash cans ×2).", String(sum));
  const gS = await delivery.deliveryGate(S.job.id);
  c.ok("…on the checklist (shown before delivering), and it never blocks", gS.ignored === sum && gS.canDeliver, JSON.stringify(gS.checks.filter((x) => !x.ok).map((x) => x.key)));
  const actions = await import("@/app/ops/photo-delivery/actions");
  const md = await actions.startDeliveryAction(S.job.id);
  const evS = await prisma.photoJobEvent.findFirst({ where: { jobId: S.job.id, action: { startsWith: "delivered with set-asides" } } });
  c.ok("Mark as delivering goes through, and the activity keeps what was delivered with", md.ok && /6 exterior issues ignored/.test(evS?.action ?? ""), `${md.message} / ${evS?.action}`);

  // =========================================================================
  c.head("5 · the wrap-up gate");
  // =========================================================================
  const W = await mkJob({ street: "859 N Lawrence St", sameDay: true });
  const gW0 = await delivery.deliveryGate(W.job.id);
  const wl0 = line(gW0, "wrapup");
  // Oct 23 2026 (Jordan and Kyle's huddle, item 9): missing photographer notes
  // NEVER hold Kyle any more (oct23-photo-huddle.ts): the line informs him and
  // offers "Ask the photographer for notes"; only the hub's own same-day
  // delivery still waits for it.
  c.ok("Harrison hasn't sent the wrap-up: a line that names him and says the notes are unknown (information, never a hold for Kyle)", wl0?.hold !== true && wl0?.advisory === true && wl0.ok === false && wl0.askNotes === true && wl0.label === "Harrison hasn't sent the wrap-up yet (any notes for the photos are unknown).", wl0?.label);
  c.ok("…with his wrap-up page (the page the 10 PM chaser links to) and what is missing", wl0?.href === `/upload/${W.project.id}` && /Harrison's wrap-up/.test(wl0?.hrefLabel ?? "") && /removal notes not answered, cull not confirmed/.test(wl0?.detail ?? ""));
  c.ok("…Kyle's Approve and deliver is not held by it (Oct 23 2026), but the hub's own delivery is (passed stays false)", gW0.advisory === true && gW0.canDeliver === true && gW0.passed === false && gW0.holdsOpen === 0);
  c.ok("…and it is the only thing open (every other line passes on this job)", gW0.checks.filter((x) => !x.ok).map((x) => x.key).join() === "wrapup", gW0.checks.filter((x) => !x.ok).map((x) => x.key).join());
  const { startDelivery } = await import("@/lib/photoDelivery/delivery");
  const { sameDayBlocker } = await import("@/lib/photoDelivery/aryeoPush");
  c.ok("a same-day order does not approve itself", (await sameDayBlocker(W.job.id)) === "the checklist has open items");
  const short = await actions.overrideWrapUpAction(W.job.id, "ok");
  c.ok("Deliver without it: a short reason is refused", !short.ok && /at least 10/.test(short.message), short.message);
  const ov = await actions.overrideWrapUpAction(W.job.id, "Called Harrison: nothing was promised, nothing to remove");
  const gW1 = await delivery.deliveryGate(W.job.id);
  const wl1 = line(gW1, "wrapup");
  const evW = await prisma.photoJobEvent.findFirst({ where: { jobId: W.job.id, action: { startsWith: asked.WRAPUP_OVERRIDE_ACTION } } });
  c.ok("…with a typed reason: recorded on the job's activity, who and why", ov.ok && /Called Harrison/.test(evW?.action ?? "") && !!evW?.actor, `${ov.message} / ${evW?.action}`);
  c.ok("…the line is satisfied for a person (canDeliver), shown as overridden with the reason", gW1.canDeliver && wl1?.ok === true && /Called Harrison/.test(wl1.overridden ?? ""));
  c.ok("…but the hub's own delivery never goes past it (passed stays false; same-day still waits)", gW1.passed === false && (await sameDayBlocker(W.job.id)) === "the checklist has open items");
  await prisma.project.update({ where: { id: W.project.id }, data: { removalNotes: "Crop the wooden sidewalk forms out of photos 1-5 (client was told)", cullingConfirmedAt: new Date(), photosHandoffAt: new Date() } });
  const gW2 = await delivery.deliveryGate(W.job.id);
  const removal = gW2.checks.find((x) => x.askId);
  c.ok("the wrap-up in: its line passes, not overridden", line(gW2, "wrapup")?.ok === true && !line(gW2, "wrapup")?.overridden && line(gW2, "wrapup")?.label === "Harrison's wrap-up is in");
  c.ok("…its removal notes are an item to settle, with the photo numbers: 'Remove (Harrison's wrap-up): …'", !!removal && removal.hold === true && /^Remove \(Harrison's wrap-up\): Crop the wooden sidewalk forms/.test(removal.label) && /\(photos 1-5\)|photos 1-5/.test(removal.label) && !gW2.canDeliver, removal?.label);
  const wrapAsk = await prisma.clientAsk.findFirstOrThrow({ where: { projectId: W.project.id, source: asked.WRAPUP_ASK_SOURCE } });
  c.ok("…filed once (a ClientAsk, source wrapup, holding), never on Kyle's Special requests board", wrapAsk.holdsDelivery && (await prisma.clientAsk.count({ where: { projectId: W.project.id } })) === 1 && !ca.isLiveAskSource(wrapAsk.source));
  await delivery.deliveryGate(W.job.id);
  c.ok("…read again: still one", (await prisma.clientAsk.count({ where: { projectId: W.project.id } })) === 1);
  c.ok("…a same-day order waits for it too (the hub's own hold reads the same asks)", (await sameDayBlocker(W.job.id)) === "1 client ask to confirm first");
  const done = await actions.clientAskedDoneAction(W.job.id, wrapAsk.id);
  const gW3 = await delivery.deliveryGate(W.job.id);
  c.ok("Done (fixed): released; now everything passes for the hub too", done.ok && gW3.canDeliver && gW3.passed, done.message);
  await prisma.project.update({ where: { id: W.project.id }, data: { removalNotes: "Crop the forms, and the dumpster on photo 7" } });
  await delivery.deliveryGate(W.job.id);
  const wrapAsks = await prisma.clientAsk.findMany({ where: { projectId: W.project.id, source: asked.WRAPUP_ASK_SOURCE }, orderBy: { createdAt: "asc" } });
  c.ok("new removal notes: a new item (the settled one stays settled)", wrapAsks.length === 2 && wrapAsks[0].state === "CONFIRMED" && wrapAsks[1].state === "OPEN");
  const L = await mkJob({ street: "40 Legacy Rd", shootDate: new Date("2026-08-20T15:00:00Z") });
  const N0 = await mkJob({ street: "41 Nobody Rd", photographer: false });
  c.ok("a shoot from before the wrap-up existed, or with no photographer: no line", !line(await delivery.deliveryGate(L.job.id), "wrapup") && !line(await delivery.deliveryGate(N0.job.id), "wrapup"));

  // =========================================================================
  c.head("6 · client asked, before delivery");
  // =========================================================================
  const A = await mkJob({ street: "50 Asked Ave", removalNotes: "Nothing needs removal — confirmed by the photographer.", culled: true });
  const ask1 = await ca.createAsk({ clientId: joe.id, projectId: A.project.id, kind: "SPECIAL_REQUEST", source: "text", medium: "photo", text: joeText, summary: "Crop out the wooden sidewalk forms", askedBy: "Joseph Sutow" });
  const ask2 = await ca.createAsk({ clientId: joe.id, projectId: A.project.id, kind: "SPECIAL_REQUEST", source: "email", medium: "both", text: "Please brighten the kitchen photo", askedBy: "Joseph Sutow" });
  await ca.createAsk({ clientId: joe.id, projectId: A.project.id, kind: "SPECIAL_REQUEST", source: "text", medium: "video", text: "Use the upbeat song" });
  await ca.createAsk({ clientId: joe.id, projectId: A.project.id, kind: "SPECIAL_REQUEST", source: "staff", medium: "photo", text: "Lot lines if they send the plat", holdsDelivery: false });
  const gA0 = await delivery.deliveryGate(A.job.id);
  const l1 = line(gA0, `ask:${ask1!.id}`);
  c.ok("'Client asked: Crop out the wooden sidewalk forms (photos 1-5, 38-40)', holding", l1?.label === "Client asked: Crop out the wooden sidewalk forms (photos 1-5, 38-40)" && l1.hold === true && l1.ok === false, l1?.label);
  c.ok("…who and how it came in", /Joseph Sutow, text,/.test(l1?.detail ?? ""), l1?.detail);
  c.ok("a both-photos-and-video ask holds the photos too; a video ask is not on the photo job; a staff note that doesn't hold is shown, not held", !!line(gA0, `ask:${ask2!.id}`)?.hold && !gA0.checks.some((x) => /upbeat song/.test(x.label)) && gA0.checks.some((x) => /Lot lines/.test(x.label) && x.advisory && !x.hold));
  c.ok("Approve and deliver can't go while they are open (shadow mode too)", !gA0.canDeliver && gA0.holdsOpen === 2);
  const bad = await actions.clientAskedAnswerAction(A.job.id, ask2!.id, "no");
  c.ok("Answer with a note: a note is required", !bad.ok, bad.message);
  const ans = await actions.clientAskedAnswerAction(A.job.id, ask2!.id, "Told Joe the kitchen is as bright as it can go without blowing the windows");
  const a2 = await prisma.clientAsk.findUniqueOrThrow({ where: { id: ask2!.id } });
  c.ok("…answered: set aside with the note, who answered", ans.ok && a2.state === "NOT_NEEDED" && /kitchen is as bright/.test(a2.confirmNote ?? "") && !!a2.doneBy);
  const other = await mkJob({ street: "51 Other St" });
  c.ok("a request is settled only from its own job", !(await actions.clientAskedDoneAction(other.job.id, ask1!.id)).ok);
  await actions.clientAskedDoneAction(A.job.id, ask1!.id);
  const gA1 = await delivery.deliveryGate(A.job.id);
  c.ok("Done: nothing holds; the timeline and the job's activity say so", gA1.canDeliver && gA1.holdsOpen === 0 && (await prisma.photoJobEvent.count({ where: { jobId: A.job.id, action: { startsWith: "request done" } } })) === 1 && (await prisma.activity.count({ where: { projectId: A.project.id, body: { contains: "Client ask confirmed" } } })) === 1);

  // =========================================================================
  c.head("6b · the order note (859 N Lawrence St, written before the shoot)");
  // =========================================================================
  const joeNote = "There are Wooden Side walk forms I guess out front do the house that needed to be avoided in video and photoshopped in photos. They will be removed when the house is being listed but they won't be removed for Harrison tomorrow.";
  const O = await mkJob({ street: "859 N Lawrence Street (order)", rooms: ["EXTERIOR_FRONT", "EXTERIOR_FRONT", "LIVING"], removalNotes: "Nothing needs removal — confirmed by the photographer.", culled: true });
  await prisma.appointment.create({
    data: {
      projectId: O.project.id, aryeoId: "appt-859",
      description: `Order Notes:\n${joeNote}\n\nOrder Questions:\n - Lock Box / Door Code: 4417\n - Special Instructions for the photographer (for this property only): The gate code is 1234. Keep the video under a minute.\n\nOr View Full Order Details:\nhttps://app.aryeo.com/x`,
    } as never,
  });
  const { orderNotesOf } = await import("@/lib/clientAsks");
  const { jobChecks } = await import("@/lib/jobChecks");
  const read = (await orderNotesOf(O.project.id)).filter((x) => x.dedupeKey.startsWith("order-note:"));
  const box = await jobChecks(O.project.id, "photo");
  c.ok("one reader: the note Photo Delivery reads is the one the 'Before you send' box shows (codes dropped)", read.length === 1 && /Wooden Side walk forms/.test(read[0].text) && !/4417|1234/.test(read[0].text) && box.notes.some((x) => x.label === "On the order" && x.text.includes("Wooden Side walk forms")));
  const formsA = await finding(O.job.id, O.run.id, O.photos[0].id, "EXT_CONSTRUCTION_MATERIALS", "MAJOR", { specificIssue: "Wooden forms along the sidewalk", locationText: "sidewalk in front of the house" });
  const formsB = await finding(O.job.id, O.run.id, O.photos[1].id, "EXT_CONSTRUCTION_MATERIALS", "MAJOR", { specificIssue: "Plywood boards by the curb" });
  const remote = await finding(O.job.id, O.run.id, O.photos[2].id, "LIV_REMOTE_CONTROLS", "MAJOR", { specificIssue: "Remote on the coffee table" });
  const gO = await delivery.deliveryGate(O.job.id);
  const noteLine = gO.checks.find((x) => x.askId && /order note/.test(x.label));
  c.ok("the order note is a blocking photo item: 'Client asked (order note): There are Wooden Side walk forms … photoshopped in photos.'", !!noteLine && noteLine.hold === true && noteLine.ok === false && /^Client asked \(order note\): There are Wooden Side walk forms .* photoshopped in photos\.$/.test(noteLine.label) && !gO.canDeliver, noteLine?.label);
  c.ok("…from the client, on the Aryeo order; filed once however often it is read", /on the Aryeo order/.test(noteLine?.detail ?? "") && (await delivery.deliveryGate(O.job.id), (await prisma.clientAsk.count({ where: { projectId: O.project.id, source: "order_note" } })) === 1));
  const V = await mkJob({ street: "861 N Lawrence St", removalNotes: "Nothing needs removal — confirmed by the photographer.", culled: true });
  await prisma.appointment.create({ data: { projectId: V.project.id, aryeoId: "appt-861", description: "Order Questions:\n - Special Instructions for the photographer (for this property only): Keep the video under a minute.\n\nOr View Full Order Details:\nhttps://app.aryeo.com/x" } as never });
  c.ok("a note only about the video is not a photo item", !(await delivery.deliveryGate(V.job.id)).checks.some((x) => x.askId));
  const viewO = await data.loadJobDetail(O.job.id, { viewer: { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false } });
  const lk = (id: string) => viewO?.findings.find((f) => f.id === id)?.clientAsk ?? null;
  c.ok("the sidewalk finding is linked: 'Client asked for this to be removed (order note)'", lk(formsA.id)?.label === "Client asked for this to be removed (order note)" && lk(formsA.id)?.askId === noteLine?.askId, JSON.stringify(lk(formsA.id)));
  c.ok("…the plywood one too (the same check); the remote on the coffee table is not", !!lk(formsB.id) && !lk(remote.id));
  const ig = await decisions.decideFindings({ jobId: O.job.id, findingIds: [formsA.id, formsB.id], status: "IGNORED", reason: "Kyle thinks the forms are fine to leave in", by: "Kyle Smith" });
  c.ok("setting it aside, even in own words: refused until the request is answered", !ig.ok && /Client asked for this to be removed \(order note\)/.test(ig.message) && /Answer that request first/.test(ig.message) && (await st(formsA.id)) === "OPEN", ig.message);
  const skip = await decisions.skipAllFindings(O.job.id, "Kyle Smith");
  c.ok("Skip all findings leaves the linked ones open (the remote is skipped)", skip.ok && (await st(formsA.id)) === "OPEN" && (await st(formsB.id)) === "OPEN" && (await st(remote.id)) === "IGNORED" && /client asked to have removed/.test(skip.message), skip.message);
  c.ok("delivery is refused while it is open", !(await delivery.deliveryGate(O.job.id)).canDeliver && !(await startDelivery(O.job.id, "Kyle Smith")).ok);
  await actions.clientAskedAnswerAction(O.job.id, noteLine!.askId!, "Cropped the forms out of photos 1 and 2 as the client asked");
  const gO2 = await delivery.deliveryGate(O.job.id);
  c.ok("answered: the hold lifts and the findings are no longer linked", gO2.holdsOpen === 0 && !(await data.loadJobDetail(O.job.id, { viewer: { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false } }))?.findings.find((f) => f.id === formsA.id)?.clientAsk);
  const ig2 = await decisions.decideFindings({ jobId: O.job.id, findingIds: [formsA.id, formsB.id], status: "IGNORED", reason: "Cropped by hand per the order note, nothing left to fix", by: "Kyle Smith" });
  c.ok("…now they can be set aside (in own words), and the photos can go out", ig2.ok && (await delivery.deliveryGate(O.job.id)).canDeliver, ig2.ok ? "" : ig2.message);

  // =========================================================================
  c.head("7 · after delivery: the client's text goes to the photo job, assigned");
  // =========================================================================
  const deliveredAt = new Date(Date.now() - 2 * HOUR);
  const D = await mkJob({ street: "859 N Lawrence Street", stage: "DELIVERED", jobDeliveredAt: deliveredAt, removalNotes: null, culled: false });
  // An older open to-do on the same order, about something else, assigned to nobody.
  const old = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Resend the invoice for 859 N Lawrence", summary: "Joe asked for the invoice again", clientId: joe.id, projectId: D.project.id, propertyAddress: D.project.title, source: "openphone", status: "OPEN", dedupeKey: "drill-old-reply" } });
  const { recordClientCommunication } = await import("@/lib/comms");
  nextDecision = { actionable: true, projectId: D.project.id, title: "Crop sidewalk forms from photos 1-5 and 38-40", detail: "Joe says James and Harrison promised the wooden sidewalk forms would be cropped out.", priority: "HIGH", mergeIntoTaskId: old.id, isRevisionRequest: true, flags: [], reason: "change to delivered photos", taskType: "client_reply", asks: [] };
  await recordClientCommunication({ clientId: joe.id, clientName: joe.name, projectId: D.project.id, projectStatus: "REVIEW", text: joeText, kind: "text", source: "openphone", contactName: joe.name });
  const oldAfter = await prisma.smartTask.findUniqueOrThrow({ where: { id: old.id } });
  c.ok("no retitling merge: the invoice to-do keeps its title and its words", oldAfter.title === "Resend the invoice for 859 N Lawrence" && !(oldAfter.description ?? "").includes("sidewalk"), oldAfter.title);
  const fresh = await prisma.smartTask.findFirst({ where: { clientId: joe.id, projectId: D.project.id, taskType: "client_reply", title: { contains: "sidewalk" } } });
  c.ok("…the request is a to-do of its own, assigned to the delivery owner", !!fresh && fresh.assignedKey === desk?.key && fresh.ownerId === kyle.id, `${fresh?.title} / ${fresh?.assignedKey}`);
  const dAsk = await prisma.clientAsk.findFirst({ where: { projectId: D.project.id, state: "OPEN" } });
  c.ok("the ask is filed on the job (photos, holding, the client's words)", !!dAsk && dAsk.medium === "photo" && dAsk.holdsDelivery && dAsk.source === "text" && /Photos 1-5 and 38-40/.test(dAsk.text));
  const dJob = await prisma.photoJob.findUniqueOrThrow({ where: { id: D.job.id } });
  const reopenEv = await prisma.photoJobEvent.findFirst({ where: { jobId: D.job.id, action: { contains: "Client asked for changes after delivery" } } });
  c.ok("the photo job reopens: 'Client asked for changes after delivery'", dJob.stage === "REVISION_REQUESTED" && !!reopenEv, `${dJob.stage} / ${reopenEv?.action}`);
  const pTask = await prisma.smartTask.findUnique({ where: { dedupeKey: asked.photoRevisionTaskKey(D.project.id) } });
  c.ok("…on the delivery owner's list (the photo revision task, one per job), never the decoy 'Kyle' a name search finds first", !!pTask && pTask.status === "OPEN" && pTask.ownerId === kyle.id && pTask.ownerId !== decoy.id && pTask.assignedKey === desk?.key && /^Client asked for changes after delivery: 859 N Lawrence Street/.test(pTask.title), `${pTask?.title} / ${pTask?.ownerId}`);
  c.ok("…one revision task for the photos, not two", (await prisma.smartTask.count({ where: { projectId: D.project.id, taskType: "revision" } })) === 1);
  const { closeAsksOnDeliveredJobs } = await import("@/lib/clientAsks");
  await closeAsksOnDeliveredJobs();
  c.ok("the delivered-jobs sweep leaves it open (asked after the photos went out)", (await prisma.clientAsk.findUniqueOrThrow({ where: { id: dAsk!.id } })).state === "OPEN");
  const gD = await delivery.deliveryGate(D.job.id);
  const dl = line(gD, `ask:${dAsk!.id}`);
  c.ok("it holds the next delivery, with the photo numbers, until it is done", !gD.canDeliver && dl?.hold === true && /\(photos 1-5, 38-40\)$/.test(dl.label), dl?.label);
  await actions.clientAskedDoneAction(D.job.id, dAsk!.id);
  // Oct 23 2026 (huddle item 9): the missing wrap-up still shows, but never holds Kyle (only the hub's own delivery).
  const gD2 = await delivery.deliveryGate(D.job.id);
  c.ok("…Done: the hold lifts (the missing wrap-up still shows, as information, and holds only the hub's own delivery)", gD2.checks.filter((x) => x.hold && !x.ok).length === 0 && gD2.checks.some((x) => x.key === "wrapup" && !x.ok && x.advisory && x.hubHold));
  // The old judgement (Oct 21): "pre-delivery work, not a revision", the ask read as a special request.
  const D2 = await mkJob({ street: "860 N Lawrence St", stage: "DELIVERED", jobDeliveredAt: deliveredAt, removalNotes: "Nothing needs removal — confirmed by the photographer.", culled: true });
  nextDecision = { actionable: true, projectId: D2.project.id, title: "Note crop request for pre-delivery work", detail: "Pre-delivery work, not a revision.", priority: "MEDIUM", mergeIntoTaskId: null, isRevisionRequest: false, flags: [], reason: "pre-delivery work", taskType: "client_reply", asks: [{ kind: "SPECIAL_REQUEST", text: "crop out the wooden sidewalk forms. Photos 1-5 and 38-40", summary: "Crop the sidewalk forms out of photos 1-5 and 38-40", medium: "photo", projectHint: D2.project.id }] };
  await recordClientCommunication({ clientId: joe.id, clientName: joe.name, projectId: D2.project.id, projectStatus: "REVIEW", text: "crop out the wooden sidewalk forms. Photos 1-5 and 38-40 at 860", kind: "text", source: "openphone", contactName: joe.name });
  const d2Asks = await prisma.clientAsk.findMany({ where: { projectId: D2.project.id } });
  const d2Job = await prisma.photoJob.findUniqueOrThrow({ where: { id: D2.job.id } });
  const d2Task = await prisma.smartTask.findUnique({ where: { dedupeKey: asked.photoRevisionTaskKey(D2.project.id) } });
  c.ok("even the old wrong judgement lands the same way: one ask, the photo job reopened, the owner's task", d2Asks.length === 1 && d2Asks[0].medium === "photo" && d2Job.stage === "REVISION_REQUESTED" && d2Task?.ownerId === kyle.id, `${d2Asks.length} / ${d2Job.stage} / ${d2Task?.ownerId}`);
  // Photos not out yet: a plain special request, nothing reopened.
  const P = await mkJob({ street: "870 N Lawrence St", stage: "READY", removalNotes: "Nothing needs removal — confirmed by the photographer.", culled: true });
  nextDecision = { ...nextDecision, projectId: P.project.id, asks: [{ kind: "SPECIAL_REQUEST", text: "crop the forms", summary: "Crop the forms", medium: "photo", projectHint: P.project.id }] };
  await recordClientCommunication({ clientId: joe.id, clientName: joe.name, projectId: P.project.id, projectStatus: "REVIEW", text: "please crop the forms at 870", kind: "text", source: "openphone", contactName: joe.name });
  c.ok("photos not out yet: the ask holds them, nothing reopened, no revision task", (await prisma.photoJob.findUniqueOrThrow({ where: { id: P.job.id } })).stage === "READY" && !(await prisma.smartTask.findUnique({ where: { dedupeKey: asked.photoRevisionTaskKey(P.project.id) } })) && !(await delivery.deliveryGate(P.job.id)).canDeliver);
  // Kyle adds one by hand after delivery.
  const H = await mkJob({ street: "880 N Lawrence St", stage: "DELIVERED", jobDeliveredAt: deliveredAt, removalNotes: "Nothing needs removal — confirmed by the photographer.", culled: true });
  const hand = await ca.addAskByHand({ projectId: H.project.id, text: "Client called: crop the forms in photo 3", medium: "photo", by: "Kyle Smith" });
  c.ok("added by hand on delivered photos: the photo job reopens for it", hand.ok && /reopened/.test(hand.message) && (await prisma.photoJob.findUniqueOrThrow({ where: { id: H.job.id } })).stage === "REVISION_REQUESTED", hand.message);

  // =========================================================================
  c.head("8 · the brain's inputs: the photos' own delivery");
  // =========================================================================
  realBrain = true;
  routerAnswer = JSON.stringify({ actionable: true, projectId: D2.project.id, title: "Crop the forms", detail: "x", priority: "HIGH", mergeIntoTaskId: null, isRevisionRequest: true, flags: [], reason: "change to delivered photos", asks: [] });
  const { routeCommTask } = await import("@/lib/brain");
  const routed = await routeCommTask({ channel: "text", message: joeText, clientId: joe.id, clientName: joe.name, senderIsClient: true });
  const p8 = prompts.filter((p) => p.includes("Decide how we should handle this message")).pop() ?? "";
  c.ok("the router sees 'PHOTOS DELIVERED' on an order still in REVIEW", new RegExp(`${D2.project.id} \\| 860 N Lawrence St[^\\n]*\\| REVIEW[^\\n]*\\| PHOTOS DELIVERED `).test(p8), p8.split("\n").find((l) => l.includes(D2.project.id)));
  c.ok("…and the rule: a change to those photos is a revision, never 'pre-delivery work'", /PHOTOS GO OUT BEFORE THE VIDEO/.test(p8) && /never "pre-delivery work"/.test(p8) && /a different request about the same property is null/.test(p8));
  c.ok("…an order whose photos are not out says nothing about them", !new RegExp(`${P.project.id}[^\\n]*PHOTOS DELIVERED`).test(p8));
  c.ok("…the decision reads as before", routed?.isRevisionRequest === true && routed.projectId === D2.project.id);
  realBrain = false;

  // =========================================================================
  c.head("9 · every Smart Brain to-do has a person; a merge is the same request");
  // =========================================================================
  const T = await mkJob({ street: "90 Task Ter" });
  const made = await tasks.createCommTask({ clientId: joe.id, clientName: joe.name, projectId: T.project.id, propertyAddress: T.project.title, kind: "text", snippet: "Can we move the shoot to Thursday?", aiTitle: "Reschedule 90 Task Ter shoot to Thursday", aiDetail: "Client asked to move the shoot to Thursday" });
  const tRow = await prisma.smartTask.findFirstOrThrow({ where: { projectId: T.project.id, taskType: "client_reply" } });
  c.ok("a new to-do: the delivery owner, by id and key", made && tRow.ownerId === kyle.id && tRow.assignedKey === desk?.key);
  await tasks.createCommTask({ clientId: joe.id, clientName: joe.name, projectId: T.project.id, propertyAddress: T.project.title, kind: "text", snippet: "Thursday 3pm works", aiTitle: "Confirm Thursday 3pm for 90 Task Ter shoot", aiDetail: "Client confirms Thursday at 3pm works" });
  c.ok("the same request on the same order: appended to it (one to-do)", (await prisma.smartTask.count({ where: { projectId: T.project.id, taskType: "client_reply" } })) === 1);
  await tasks.createCommTask({ clientId: joe.id, clientName: joe.name, projectId: T.project.id, propertyAddress: T.project.title, kind: "text", snippet: "Also can you send the invoice?", aiTitle: "Resend the invoice", aiDetail: "Client wants the invoice resent" });
  const tRows = await prisma.smartTask.findMany({ where: { projectId: T.project.id, taskType: "client_reply" }, orderBy: { createdAt: "asc" } });
  c.ok("a different request on the same order: its own to-do; the first keeps its title", tRows.length === 2 && tRows[0].title === "Reschedule 90 Task Ter shoot to Thursday" && tRows[1].title === "Resend the invoice" && tRows[1].assignedKey === desk?.key);
  const nobody = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Send the floor plan", summary: "Joe wants the floor plan", clientId: joe.id, projectId: T.project.id, source: "openphone", status: "OPEN", dedupeKey: "drill-nobody" } });
  const m1 = await tasks.mergeIntoExistingTask(nobody.id, { title: "Crop sidewalk forms", detail: "Client wants the forms cropped", snippet: "crop the forms", clientId: joe.id, projectId: T.project.id }, { sameRequestOnly: true });
  c.ok("a merge into a different request is refused, nothing retitled", !m1 && (await prisma.smartTask.findUniqueOrThrow({ where: { id: nobody.id } })).title === "Send the floor plan");
  const m2 = await tasks.mergeIntoExistingTask(nobody.id, { title: "Send the floor plan PDF", detail: "Client asks again for the floor plan", snippet: "floor plan please", clientId: joe.id, projectId: T.project.id }, { sameRequestOnly: true });
  const nAfter = await prisma.smartTask.findUniqueOrThrow({ where: { id: nobody.id } });
  c.ok("…the same request merges, and the to-do that had nobody now has the delivery owner", m2 && nAfter.assignedKey === desk?.key && nAfter.ownerId === kyle.id);
  const hit = await prisma.project.create({ data: { title: "95 Coordinator Way, Philadelphia, PA", clientId: joe.id, status: "EDITING" }, select: { id: true, title: true } });
  await tasks.createProjectFollowupTask({ projectId: hit.id, propertyAddress: hit.title, senderName: "Ruthie", text: "Lockbox is on the side door" });
  const fu = await prisma.smartTask.findFirstOrThrow({ where: { projectId: hit.id, taskType: "comms_followup" } });
  c.ok("a teammate's follow-up: the delivery owner too, never a name search", fu.ownerId === kyle.id && fu.ownerId !== decoy.id && fu.assignedKey === desk?.key);

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
