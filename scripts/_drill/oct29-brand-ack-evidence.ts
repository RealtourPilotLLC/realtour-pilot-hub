// ---------------------------------------------------------------------------
// OCT 29 2026 · BRAND-UPDATE CARDS CLOSE ON EVIDENCE, SHOOT DETAILS STAY OFF THE
// EDITOR (James's call with Jordan: 15 urgent tasks, 10 of them "Confirm Kim
// has <client>'s brand update", some long since edited from). PGlite only.
//
//   §1 the decision (pure): shoot details only, acknowledged, work after the
//      newest change, work before it, a card a person holds
//   §2 shoot details are never an editor's: no card, receipt, banner or DM;
//      a mixed batch alerts only the editor's rows; the catch-up never DMs one
//   §3 the evidence pass: Start, a sent version, an accepted brief, each after
//      the change; office presses, failed uploads and older work do not count;
//      a person's card is left alone; the close says why
//   §4 a card minted before the fix: Got it on the editor's rows settles it
//   §5 James's desk: a brand card is never urgent, his other work still is
//
// Run: DRILL_PORT=5612 npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_drill/oct29-brand-ack-evidence.ts
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const H = 3600_000;

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5612) });
  const fence = fenceFetch();
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const brand = await import("@/lib/brandProfile");
    const { brandAckDecision, brandAckVerdicts } = await import("@/lib/brandAckEvidence");
    const { sweepTaskEvidence } = await import("@/lib/taskEvidence");
    const { buildCreativeDesk } = await import("@/lib/creativeDesk");

    // ---- §1 the decision ---------------------------------------------------------------
    c.head("§1 · the decision, pure");
    const t0 = new Date("2026-10-20T14:00:00Z");
    const at = (h: number) => new Date(t0.getTime() + h * H);
    const ch = (label: string, fieldKey: string, h: number, acked = false) => ({ label, fieldKey, createdAt: at(h), acked });
    c.ok("filming location, days, wardrobe, teleprompter are shoot details; fonts, colors, assets are not",
      ["slot:production.location", "slot:production.days", "slot:production.wardrobe", "slot:production.teleprompter"].every(brand.isShootDetailChange)
      && !["slot:fonts", "brandColors", "asset:LOGO", "", null, undefined].some(brand.isShootDetailChange));
    const shootOnly = brandAckDecision({ client: "Bea", changes: [ch("Filming location", "slot:production.location", 0), ch("Preferred filming days", "slot:production.days", 1)], work: [], held: null });
    c.ok("only shoot details on it: closes, and says they are shoot details", !!shootOnly.evidence && /Filming location, Preferred filming days are shoot details/.test(shootOnly.evidence) && shootOnly.at === null, shootOnly.evidence ?? "");
    const mixedAcked = brandAckDecision({ client: "Bea", changes: [ch("Filming location", "slot:production.location", 0), ch("Fonts", "slot:fonts", 1, true)], work: [], held: null });
    c.ok("shoot details plus acknowledged editor changes: closes, says the rest is acknowledged", /is a shoot detail.*and the rest is acknowledged/.test(mixedAcked.evidence ?? ""), mixedAcked.evidence ?? "");
    c.ok("every editor change acknowledged: closes", /every change on it is acknowledged/.test(brandAckDecision({ client: "Bea", changes: [ch("Fonts", "slot:fonts", 0, true)], work: [], held: null }).evidence ?? ""));
    const worked = brandAckDecision({ client: "Bea", changes: [ch("Fonts", "slot:fonts", 0), ch("Filming location", "slot:production.location", 50)], work: [{ editorKey: "kim", at: at(5), what: "sent", street: "12 Oak St", round: 3 }, { editorKey: "kim", at: at(2), what: "start", street: "12 Oak St" }], held: null });
    c.ok("an editor's work after the newest editor change closes it, naming the first piece of work (a later shoot detail does not reset it)", /^Kim has worked from Bea's brief since the last change \(pressed Start on 12 Oak St on /.test(worked.evidence ?? "") && worked.at?.getTime() === at(2).getTime(), worked.evidence ?? "");
    const sent = brandAckDecision({ client: "Bea", changes: [ch("Fonts", "slot:fonts", 0)], work: [{ editorKey: "john", at: at(3), what: "sent", street: "12 Oak St", round: 4 }], held: null });
    c.ok("a sent version reads as one, by the editor who sent it", /^John Mark has worked .*sent version 4 of 12 Oak St/.test(sent.evidence ?? ""), sent.evidence ?? "");
    const before = brandAckDecision({ client: "Bea", changes: [ch("Fonts", "slot:fonts", 0), ch("Colors", "brandColors", 10)], work: [{ editorKey: "kim", at: at(5), what: "sent", street: "12 Oak St", round: 2 }], held: null });
    c.ok("work between two changes does not cover the newer one: kept, with when", !before.evidence && /no editor has worked on Bea's jobs since the last change/.test(before.kept ?? ""), before.kept);
    c.ok("no work at all: kept", !brandAckDecision({ client: "Bea", changes: [ch("Fonts", "slot:fonts", 0)], work: [], held: null }).evidence);
    c.ok("a card a person holds is kept whatever the record says", brandAckDecision({ client: "Bea", changes: [ch("Filming location", "slot:production.location", 0)], work: [], held: "it was delegated" }).kept === "it was delegated");

    // ---- the cast ---------------------------------------------------------------------
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@bae.invalid`, ...extra } });
    await tm("Jordan Spackman", "PHOTOGRAPHER");
    await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "PHOTOGRAPHER", { creativeManager: true });
    await tm("Kim Miguel", "EDITOR", { slackId: "U-KIM" });
    await prisma.appUser.create({ data: { email: "kim@bae.invalid", name: "Kim", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const automation = (enabled: boolean) => prisma.programAutomation.upsert({ where: { key: "brand_change_alerts" }, create: { key: "brand_change_alerts", enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled } });
    const clientWithJob = async (name: string, street: string) => {
      const client = await prisma.client.create({ data: { name }, select: { id: true } });
      const project = await prisma.project.create({ data: { clientId: client.id, title: `${street}, Media, PA`, status: "EDITING" }, select: { id: true } });
      await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit", assignedKey: "kim", projectId: project.id, clientId: client.id, status: "OPEN" } });
      return { clientId: client.id, projectId: project.id };
    };
    const change = (clientId: string, fieldKey: string, label: string, toText: string) => brand.recordBrandChange({ clientId, fieldKey, label, kind: "SET", toText, source: "staff" });
    const cardOf = (clientId: string) => prisma.smartTask.findFirst({ where: { clientId, dedupeKey: { startsWith: `brand-ack:${clientId}:` } }, orderBy: { createdAt: "desc" } });

    // ---- §2 shoot details --------------------------------------------------------------
    c.head("§2 · shoot details are never the editor's");
    await automation(true);
    const a = await clientWithJob("Ada Shoot", "1 Elm St");
    const loc = await change(a.clientId, "slot:production.location", "Filming location", "The listing");
    const r1 = await brand.alertBrandChanges(a.clientId);
    const locRow = await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: loc } });
    c.ok("a filming-location change alone: settled as shoot_only, no card, no receipt", r1.channel === "shoot_only" && r1.taskId === null && !(await cardOf(a.clientId)) && (await prisma.clientBrandReceipt.count({ where: { changeId: loc } })) === 0 && locRow.alertChannel === "shoot_only" && locRow.ackBy === brand.SHOOT_DETAIL_ACK && !!locRow.ackAt);
    c.ok("…and no bell, no DM, with alerts switched on", (await prisma.notification.count({ where: { kind: "brand_updated" } })) === 0 && fence.blocked.length === 0);
    c.ok("…and no banner on Kim's brief", (await brand.pendingBrandChanges(a.clientId, { editorKey: "kim" })).length === 0);

    await automation(false);
    const b = await clientWithJob("Bo Mixed", "2 Elm St");
    const days = await change(b.clientId, "slot:production.days", "Preferred filming days", "Tuesdays");
    const fonts = await change(b.clientId, "slot:fonts", "Fonts", "Montserrat");
    const r2 = await brand.alertBrandChanges(b.clientId);
    const card = await cardOf(b.clientId);
    c.ok("a mixed batch makes one card for the editor's row only", !!card && r2.taskId === card.id && card.assignedKey === "james" && /Fonts/.test(card.description ?? "") && !/filming days/i.test(card.description ?? ""), card?.description?.slice(0, 200));
    c.ok("…with no due date of its own (it waits on the editor, not on James)", card?.dueAt === null);
    c.ok("…a receipt for Kim on Fonts, none on the filming days", (await prisma.clientBrandReceipt.count({ where: { changeId: fonts, editorKey: "kim" } })) === 1 && (await prisma.clientBrandReceipt.count({ where: { changeId: days } })) === 0);
    c.ok("…Kim's banner shows Fonts alone", (await brand.pendingBrandChanges(b.clientId, { editorKey: "kim" })).map((p) => p.label).join() === "Fonts");

    await automation(true);
    const legacy = (await prisma.clientBrandChange.create({ data: { clientId: a.clientId, fieldKey: "slot:production.wardrobe", label: "Wardrobe", kind: "SET", toText: "Navy", source: "staff", alertChannel: "pending", alertedAt: new Date(Date.now() - H), createdAt: new Date(Date.now() - H) } })).id;
    await brand.sweepBrandChangeAlerts();
    c.ok("the catch-up never DMs a shoot detail left 'pending' from before the fix", (await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: legacy } })).alertChannel === "pending" && (await prisma.notification.count({ where: { kind: "brand_updated", dedupeKey: { startsWith: `brand-updated-${a.clientId}-` } } })) === 0);
    c.ok("…while an editor's change left 'pending' on another client still gets its catch-up", (await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: fonts } })).alertChannel !== "pending");
    await automation(false);

    // ---- §3 the evidence pass ------------------------------------------------------------
    c.head("§3 · the hourly evidence pass");
    const verdictFor = async (id: string) => (await brandAckVerdicts({ taskIds: [id] }))[0];
    const changeAt = (await prisma.clientBrandChange.findUniqueOrThrow({ where: { id: fonts } })).createdAt;
    const evt = (projectId: string, kind: string, ms: number, extra: Record<string, unknown> = {}) => prisma.editorWorkEvent.create({ data: { itemId: `${projectId}:o1`, editorKey: "kim", projectId, kind, at: new Date(changeAt.getTime() + ms), actorName: "Kim", actorRole: "EDITOR", ...extra } });
    await evt(b.projectId, "START", -H);
    await evt(b.projectId, "START", 2 * H, { actorRole: "ADMIN", actorName: "Kyle", onBehalf: true });
    await evt(b.projectId, "PAUSE", 2 * H);
    await prisma.reviewSubmission.create({ data: { projectId: b.projectId, round: 2, status: "UPLOADING", submittedByKey: "kim", createdAt: new Date(changeAt.getTime() + 2 * H) } });
    const v0 = await verdictFor(card!.id);
    c.ok("Start before the change, the office pressing Start for Kim, a pause, an upload still uploading: none counts", !v0.evidence && /no editor has worked on Bo Mixed's jobs/.test(v0.kept ?? ""), v0.kept);
    await evt(b.projectId, "START", 3 * H);
    const v1 = await verdictFor(card!.id);
    c.ok("Kim pressing Start after the change closes it, naming the job", v1.kind === "brand" && /^Kim has worked from Bo Mixed's brief since the last change \(pressed Start on 2 Elm St on /.test(v1.evidence ?? "") && v1.at?.getTime() === changeAt.getTime() + 3 * H, v1.evidence ?? "");
    const dry = await sweepTaskEvidence({ dryRun: true });
    c.ok("the hourly pass carries it, and a dry run writes nothing", dry.verdicts.some((v) => v.taskId === card!.id && !!v.evidence) && dry.closed === 0 && (await prisma.smartTask.findUniqueOrThrow({ where: { id: card!.id } })).status === "OPEN");
    const live = await sweepTaskEvidence();
    const closed = await prisma.smartTask.findUniqueOrThrow({ where: { id: card!.id } });
    c.ok("the pass closes it and writes why on it", live.closed >= 1 && closed.status === "COMPLETED" && /Closed by the hub on .*Kim has worked from Bo Mixed's brief/.test(closed.description ?? ""), closed.description?.slice(-200));
    c.ok("…Kim's own receipt is not forged: Fonts stays on her brief until she answers", !(await prisma.clientBrandReceipt.findFirstOrThrow({ where: { changeId: fonts, editorKey: "kim" } })).ackAt && (await brand.pendingBrandChanges(b.clientId, { editorKey: "kim" })).length === 1);

    const s = await clientWithJob("Sam Sent", "3 Elm St");
    await change(s.clientId, "brandColors", "Colors", "Teal");
    await brand.alertBrandChanges(s.clientId);
    const sCard = (await cardOf(s.clientId))!;
    await prisma.reviewSubmission.create({ data: { projectId: s.projectId, round: 2, status: "PENDING", submittedByKey: "kim", createdAt: new Date(Date.now() + H) } });
    c.ok("a version Kim sent after the change closes it", /sent version 2 of 3 Elm St/.test((await verdictFor(sCard.id)).evidence ?? ""));

    const r = await clientWithJob("Rae Brief", "4 Elm St");
    await change(r.clientId, "slot:music", "Music", "Upbeat");
    await brand.alertBrandChanges(r.clientId);
    const rCard = (await cardOf(r.clientId))!;
    await prisma.editorBriefReceipt.create({ data: { projectId: r.projectId, outputId: "o1", editorKey: "kim", digest: "d", snapshotJson: "{}", actorUserId: "u", actorName: "Kim", acceptedAt: new Date(Date.now() + H) } });
    c.ok("Kim accepting the brief after the change closes it", /accepted the brief for 4 Elm St/.test((await verdictFor(rCard.id)).evidence ?? ""));

    const held = async (name: string, data: Record<string, unknown>) => {
      const x = await clientWithJob(name, "5 Elm St");
      await change(x.clientId, "slot:production.location", "Filming location", "Office");
      await change(x.clientId, "slot:fonts", "Fonts", "Lato");
      await brand.alertBrandChanges(x.clientId);
      const hc = (await cardOf(x.clientId))!;
      await prisma.smartTask.update({ where: { id: hc.id }, data });
      await evt(x.projectId, "START", 3 * H);
      return verdictFor(hc.id);
    };
    c.ok("a card a person put on someone by hand, delegated, or flagged is left for them", [
      await held("Hand Put", { assignedManually: true }),
      await held("Delegated", { delegatedAt: new Date(), delegatedBy: "Jordan" }),
      await held("Flagged", { flaggedAt: new Date(), flaggedBy: "Kyle" }),
    ].every((v) => !v.evidence && !!v.kept));

    // ---- §4 a card minted before the fix --------------------------------------------------
    c.head("§4 · a card minted before the fix");
    const o = await clientWithJob("Old Card", "6 Elm St");
    const oldCard = await prisma.smartTask.create({ data: { taskType: "todo", title: "Confirm Kim has Old Card's brand update", assignedKey: "james", clientId: o.clientId, status: "OPEN", dueAt: new Date(Date.now() - 5 * 24 * H), dedupeKey: `brand-ack:${o.clientId}:x` } });
    const mk = (fieldKey: string, label: string) => prisma.clientBrandChange.create({ data: { clientId: o.clientId, fieldKey, label, kind: "SET", toText: "x", source: "ai_curator", alertChannel: "slack", alertEditorKeys: "kim", alertedAt: new Date(), taskId: oldCard.id, receipts: { create: { editorKey: "kim", requiredAt: new Date() } } } });
    await mk("slot:production.location", "Filming location");
    await mk("slot:fonts", "Fonts");
    c.ok("Kim's banner on an old card shows only Fonts", (await brand.pendingBrandChanges(o.clientId, { editorKey: "kim" })).map((p) => p.label).join() === "Fonts");
    const ack = await brand.acknowledgeBrandChanges(o.clientId, "kim");
    c.ok("Got it on Fonts settles the card; the old filming-location receipt does not hold it open", ack.tasksClosed === 1 && (await prisma.smartTask.findUniqueOrThrow({ where: { id: oldCard.id } })).status === "COMPLETED", JSON.stringify(ack));
    const o2 = await clientWithJob("Old Shoot Card", "7 Elm St");
    const oldShoot = await prisma.smartTask.create({ data: { taskType: "todo", title: "Confirm Kim has Old Shoot Card's brand update", assignedKey: "james", clientId: o2.clientId, status: "OPEN", dueAt: new Date(Date.now() - 5 * 24 * H), dedupeKey: `brand-ack:${o2.clientId}:y` } });
    await prisma.clientBrandChange.create({ data: { clientId: o2.clientId, fieldKey: "slot:production.days", label: "Preferred filming days", kind: "SET", toText: "Fri", source: "ai_curator", alertChannel: "slack", alertEditorKeys: "kim", alertedAt: new Date(), taskId: oldShoot.id, receipts: { create: { editorKey: "kim", requiredAt: new Date() } } } });
    c.ok("an old card holding only shoot details closes on the evidence pass", /Preferred filming days is a shoot detail/.test((await verdictFor(oldShoot.id)).evidence ?? ""));

    // ---- §5 James's desk ------------------------------------------------------------------
    c.head("§5 · James's desk");
    const brandOpen = await clientWithJob("Desk Brand", "8 Elm St");
    const deskCard = await prisma.smartTask.create({ data: { taskType: "todo", title: "Confirm Kim has Desk Brand's brand update", assignedKey: "james", clientId: brandOpen.clientId, status: "OPEN", dueAt: new Date(Date.now() - 3 * 24 * H), dedupeKey: `brand-ack:${brandOpen.clientId}:z` } });
    const ordinary = await prisma.smartTask.create({ data: { taskType: "todo", title: "Call the venue", assignedKey: "james", status: "OPEN", dueAt: new Date(Date.now() - 3 * 24 * H) } });
    const desk = await buildCreativeDesk({ role: "CREATIVE_MANAGER", teamMemberId: jamesTm.id, name: "James Livingston", email: "james@bae.invalid" });
    const rowOf = (id: string) => desk.assigned.items.find((x) => x.taskId === id);
    c.ok("a brand card with an old due date: not overdue, not urgent, no due words, closes itself", !!rowOf(deskCard.id) && !rowOf(deskCard.id)!.urgent && !rowOf(deskCard.id)!.overdue && rowOf(deskCard.id)!.dueWords === null && rowOf(deskCard.id)!.closesItself, JSON.stringify(rowOf(deskCard.id)));
    c.ok("his own overdue work is still urgent", !!rowOf(ordinary.id)?.urgent && !!rowOf(ordinary.id)?.overdue);

    c.ok("no provider was called anywhere", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
