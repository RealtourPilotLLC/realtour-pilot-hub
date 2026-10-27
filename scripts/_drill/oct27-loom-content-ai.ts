// ---------------------------------------------------------------------------
// DRILL: the AI handles the calls and what they leave (Oct 27 2026 Loom).
//
//   DRILL_PORT=5625 node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-content-ai.ts
//
// Jordan: "I don't want to have to come in here and review everybody's
// information for their calls. AI should handle it. And if it can't figure
// it out, then get rid of it." And on Janice Pigga's and Bernadette's calls:
// "it should be analyzed and assigned automatically."
//
//   1. The call matcher, pure: portal sign-in, calendar guest, phone, a
//      unique full name; a tie on a signal stops there; the TEST rule; an
//      address another client owns; the calendar title; the AI's bar.
//   2. The knowledge curator, pure: the certain rules over the model's answer
//      (low confidence drops, a one-off needs a date, past ones expire, a
//      cast member needs a role, one line per key, dashes cleaned).
//   3. Curation on a real client (Bernadette): every fact goes where it is
//      used, with the reason on the row: style inspirations to the creative
//      identity, the price point to ONE strategy line, captions to the editor
//      (and the profile slot), wardrobe to the shoot, the husband to the skit
//      cast, Brandon Kerrigan dropped, a complaint recorded as a client issue,
//      something said in confidence kept for the team and never sent to the
//      model; a person's decision is never re-sent.
//   4. Fail safe: the model down changes nothing.
//   5. "What the AI kept": the read-only view's loader.
//   6. Calls: Janice by her full name, a portal sign-in, a phone, the follow-up
//      Bernadette agreed to (plans October, not November), a forged portal
//      token never by name, a name two clients share stays, a call a person
//      set aside is never touched; the one-off then expires.
//   7. The AI pass for what is left: acted on at 0.85 only (the address then
//      verified), never asked twice in a week, a dry run asks nothing, the
//      model down files nothing.
//   8. Complaints from portal messages: recorded once, a request is not one.
//   9. The switches and the wiring: ai_runs off curates nothing; the crons,
//      Plan › Knowledge and Calls, the Brand tab list, the identity card.
//
// ISOLATION: PGlite via the shared harness; the model is stubbed at
// aiJsonWithUsage (every run row, quota and write around it is the shipped
// code); Google is not connected; nothing leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5625);
const REPO = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

installNextStubs();
const fence = fenceFetch();

// ---- the model boundary ----------------------------------------------------
type Answer = (prompt: string) => unknown;
let curatorAnswer: Answer | null = null;
let complaintAnswer: Answer | null = null;
let matchAnswer: Answer | null = null;
let modelDown = false;
const calls = { curator: 0, complaint: 0, match: 0, other: 0 };
const prompts: { kind: string; prompt: string }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { prompt: string; system?: string }) => {
        const sys = opts.system ?? "";
        const kind = /^You curate what Realtour Pilot remembers/.test(sys) ? "curator" : /^You read ONE message/.test(sys) ? "complaint" : /^You match ONE booked call/.test(sys) ? "match" : "other";
        calls[kind as keyof typeof calls]++;
        prompts.push({ kind, prompt: opts.prompt });
        if (modelDown) throw new Error("drill: the model is down");
        const fn = kind === "curator" ? curatorAnswer : kind === "complaint" ? complaintAnswer : kind === "match" ? matchAnswer : null;
        if (!fn) throw new Error(`drill: no answer queued for ${kind}`);
        return { result: fn(opts.prompt), usage: { inputTokens: 1000, outputTokens: 300 }, model: "drill-stub" };
      };
    },
  }),
);

// ET wall time → Date.
const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
function et(y: number, mo: number, d: number, h: number, mi = 0): Date {
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, mo - 1, d, h + off, mi));
    const p = Object.fromEntries(ET_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
    if (+p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi) return t;
  }
  throw new Error(`no such ET wall time ${y}-${mo}-${d} ${h}:${mi}`);
}

/** The curator's answer, built from the prompt's own fact lines. */
const PRICE_LINE = "Ideal price point $600k to $800k; takes $1M+ homes when they come up.";
const STYLE_LINE = "Watches Téa Del Carlo (San Diego agent known for skits) and Two Cents San Diego for style.";
type Rule = [RegExp, Record<string, unknown>];
const dec = (decision: string, more: Record<string, unknown> = {}) => ({ decision, key: null, line: null, eventAt: null, castName: null, castRole: null, complaint: null, confidence: 0.9, reason: `drill: ${decision.toLowerCase()}`, ...more });
let curatorRules: Rule[] = [];
function curatorFromPrompt(prompt: string) {
  const decisions: Record<string, unknown>[] = [];
  for (const line of prompt.split("\n")) {
    const m = /^\[([a-z0-9]+)\] \(.*?\) (.*)$/.exec(line);
    if (!m) continue;
    const rule = curatorRules.find(([re]) => re.test(m[2]));
    if (rule) decisions.push({ id: m[1], ...rule[1] });
  }
  return { decisions };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const c = makeChecker();
  const core = await import("@/lib/callMatchCore");
  const kcore = await import("@/lib/knowledgeCuratorCore");
  const kc = await import("@/lib/knowledgeCurator");
  const auto = await import("@/lib/callAutoMatch");
  const cc = await import("@/lib/contentComplaints");
  const { setAutomation } = await import("@/lib/programAutomation");
  const { factsForPrompt, productionFactsForBrief } = await import("@/lib/clientFacts");
  const { skitCastOf } = await import("@/lib/programStyle");

  // =========================================================================
  c.head("1 · the call matcher, pure");
  // =========================================================================
  {
    const pool: import("@/lib/callMatchCore").MatchClient[] = [
      { clientId: "J", enrollmentId: "eJ", name: "Janice Pigga", emails: ["janice@brokerage.example"], logins: ["janice.portal@x.example"], phone: "610-555-0101" },
      { clientId: "B", enrollmentId: "eB", name: "Bernadette Rabel", emails: ["bern@rabel.example"], logins: [], phone: "(484) 555-0199" },
      { clientId: "S1", enrollmentId: "eS1", name: "Sam Same", emails: [], logins: [], phone: "215-555-0001" },
      { clientId: "S2", enrollmentId: "eS2", name: "Samuel Same", emails: [], logins: [], phone: "215-555-0001" },
      { clientId: "T", enrollmentId: "eT", name: "Tess Fixture TEST", emails: [], logins: [], phone: null },
    ];
    const sig = (o: Partial<import("@/lib/callMatchCore").MatchSignals>) => ({ inviteeEmail: null, inviteeName: null, phones: [], attendeeEmails: [], ...o });
    const portal = core.matchBySignals(sig({ inviteeEmail: "Janice.Portal@x.example" }), pool);
    c.ok("portal sign-in: the booking address is her login", portal.state === "MATCHED" && portal.clientId === "J" && portal.via === "portalLogin", JSON.stringify(portal));
    const guest = core.matchBySignals(sig({ inviteeEmail: "assistant@else.example", attendeeEmails: ["info@realtourpilot.com", "bern@rabel.example"] }), pool);
    c.ok("calendar guest: another guest on the invite is the client (our own address never counts)", guest.state === "MATCHED" && guest.clientId === "B" && guest.via === "attendee", JSON.stringify(guest));
    const phone = core.matchBySignals(sig({ inviteeName: "Front Desk", phones: core.inviteePhones({ text_reminder_number: "+1 484-555-0199" }) }), pool);
    c.ok("phone: the number given to Calendly is on her record", phone.state === "MATCHED" && phone.clientId === "B" && phone.via === "phone", JSON.stringify(phone));
    c.ok("inviteePhones reads the reminder number and a phone answer, 10 digits", JSON.stringify(core.inviteePhones({ text_reminder_number: "+1 (610) 555-0101", questions_and_answers: [{ answer: "215.555.0001" }, { answer: "I want to talk about listings" }] })) === JSON.stringify(["6105550101", "2155550001"]));
    const name = core.matchBySignals(sig({ inviteeEmail: "janicepigga@gmail.example", inviteeName: "Janice Pigga" }), pool);
    c.ok("full name: exactly one client has it (Janice from her own gmail)", name.state === "MATCHED" && name.clientId === "J" && name.via === "name", JSON.stringify(name));
    const tie = core.matchBySignals(sig({ inviteeName: "Sam Same", phones: ["2155550001"] }), pool);
    c.ok("two clients on one signal (the phone) is not a match, and the weaker name never breaks the tie", tie.state === "AMBIGUOUS" && tie.via === "phone" && tie.clientIds.length === 2, JSON.stringify(tie));
    const owned = core.matchBySignals(sig({ inviteeEmail: "someone@other.example", inviteeName: "Janice Pigga" }), pool, { addressOwnedByOther: true });
    c.ok("an address on file for another client: the name is never enough", owned.state === "NONE");
    c.ok("TEST rule: a real person's booking never lands on a TEST client by name", core.matchBySignals(sig({ inviteeName: "Tess Fixture" }), pool).state === "NONE");
    c.ok("a first name alone is not a full name", core.matchBySignals(sig({ inviteeName: "Janice" }), pool).state === "NONE");
    c.ok("calendar title: \"Bernadette Rabel / Jordan\" names her; \"Rabel family dinner\" does not", core.titleNamesClient("Bernadette Rabel / Jordan", "Bernadette Rabel") && !core.titleNamesClient("Rabel family dinner", "Bernadette Rabel"));
    c.ok("a program-call title reads as one; lunch does not", core.looksLikeClientCall("Content strategy follow-up") && !core.looksLikeClientCall("Lunch with Bernadette") && !core.looksLikeClientCall("Call with Bob"));
    const ids = new Set(["J", "B"]);
    c.ok("the AI's answer: acted on at 0.85, an id from the list only", !!core.acceptCallMatch({ clientId: "J", confidence: 0.9, reason: "x" }, ids) && !core.acceptCallMatch({ clientId: "J", confidence: 0.84, reason: "x" }, ids) && !core.acceptCallMatch({ clientId: "Z", confidence: 0.99, reason: "x" }, ids) && !core.acceptCallMatch({ clientId: null, confidence: 0.99 }, ids));
  }

  // =========================================================================
  c.head("2 · the knowledge curator, pure");
  // =========================================================================
  {
    const now = et(2026, 10, 20, 10);
    const f = (id: string, body: string) => ({ id, category: "BRAND_PREFERENCE", fieldKey: null, body, source: "call", speaker: "client", factDate: now, createdAt: now, confidential: false, monthKey: "2026-10" });
    const facts = [f("a", "price one"), f("b", "price two"), f("c", "unsure"), f("d", "call someday"), f("e", "old call"), f("g", "cast"), f("h", "silent"), f("i", "dash")];
    const plan = kcore.planCuration(facts, { decisions: [
      { id: "a", ...dec("STRATEGY_NOTE", { key: "Price Point", line: PRICE_LINE }) },
      { id: "b", ...dec("STRATEGY_NOTE", { key: "price_point", line: PRICE_LINE, confidence: 0.7 }) },
      { id: "c", ...dec("SCRIPT", { confidence: 0.5 }) },
      { id: "d", ...dec("ONE_OFF") },
      { id: "e", ...dec("ONE_OFF", { eventAt: "2026-10-12T15:00:00-04:00" }) },
      { id: "g", ...dec("SKIT_CAST", { castName: "Jay" }) },
      { id: "i", ...dec("EDITING", { key: "captions", line: "Bold captions — white, always" }) },
    ] }, now);
    const note = plan.actions.find((a) => a.kind === "note" && a.fieldKey === "strategy_note.price_point");
    c.ok("two facts on one subject become ONE strategy line naming both", note?.kind === "note" && note.sourceIds.join(",") === "a,b" && note.line === PRICE_LINE && note.confidence === 0.7, JSON.stringify(note));
    c.ok("under 0.6 confident: dropped (\"when unsure, drop\")", plan.actions.some((a) => a.kind === "drop" && a.factId === "c" && /not sure enough/.test(a.reason)));
    c.ok("a one-off with no date is not kept", plan.actions.some((a) => a.kind === "drop" && a.factId === "d"));
    c.ok("a one-off already past expires at once", plan.actions.some((a) => a.kind === "oneoff" && a.factId === "e" && a.expired));
    c.ok("a skit cast member with no role is dropped", plan.actions.some((a) => a.kind === "drop" && a.factId === "g"));
    c.ok("a fact the answer skips is left untouched (nothing assumed)", plan.untouched.join(",") === "h");
    const dash = plan.actions.find((a) => a.kind === "note" && a.fieldKey === "editing.captions");
    c.ok("no dashes in a kept line", dash?.kind === "note" && !/[—–]/.test(dash.line), dash?.kind === "note" ? dash.line : "");
    c.ok("an empty or broken answer changes nothing", kcore.planCuration(facts, null, now).untouched.length === facts.length && kcore.planCuration(facts, { decisions: "x" }, now).actions.length === 0);
    c.ok("the editor's preferences are the editing.* ones", kcore.isTechnicalEditingFact({ fieldKey: "editing.captions" }) && !kcore.isTechnicalEditingFact({ fieldKey: "production.wardrobe" }) && !kcore.isTechnicalEditingFact({ fieldKey: null }));
    c.ok("a curated row's tag reads back (decision, run, reason)", JSON.stringify(kcore.readCuratorTag(kcore.curatorTag("DROP", "run1", "a | b"))) === JSON.stringify({ decision: "DROP", runId: "run1", reason: "a / b" }));
  }

  // ---- the clients ---------------------------------------------------------
  const bern = await buildContentMonth(db, { name: "Bernadette Rabel TEST", monthKey: "2026-10", project: false, owner: { email: "bern.portal@drill.example", name: "Bernadette Rabel TEST" } });
  const jan = await buildContentMonth(db, { name: "Janice Pigga TEST", monthKey: "2026-10", project: false, owner: { email: "janice.portal@drill.example", name: "Janice Pigga TEST" } });
  const mike = await buildContentMonth(db, { name: "Mike Portal TEST", monthKey: "2026-10", project: false, owner: { email: "mike.portal@drill.example", name: "Mike Portal TEST" } });
  const ophone = await buildContentMonth(db, { name: "Olive Phone TEST", monthKey: "2026-10", project: false, owner: false });
  const twinA = await buildContentMonth(db, { name: "Sam Same TEST", monthKey: "2026-10", project: false, owner: false });
  const twinB = await buildContentMonth(db, { name: "Sam Same TEST", monthKey: "2026-10", project: false, owner: false });
  await prisma.client.update({ where: { id: bern.clientId }, data: { email: "bern@rabel.example" } });
  await prisma.client.update({ where: { id: jan.clientId }, data: { email: "janice@brokerage.example" } });
  await prisma.client.update({ where: { id: ophone.clientId }, data: { phone: "(610) 555-0142" } });
  void twinA; void twinB;

  // Bernadette's Oct 12 strategy call (it planned October).
  const oct12 = await prisma.programCallRecord.create({
    data: { clientId: bern.clientId, enrollmentId: bern.enrollmentId, callType: "MONTHLY_STRATEGY", inviteeEmail: "bern@rabel.example", inviteeName: "Bernadette Rabel TEST", scheduledStart: et(2026, 10, 12, 15), scheduledEnd: et(2026, 10, 12, 15, 45), status: "COMPLETED", matchState: "MATCHED", matchNote: "matched via email", monthId: bern.monthId, targetMonthKey: "2026-10", transcriptState: "ANALYZED" },
    select: { id: true },
  });

  // =========================================================================
  c.head("3 · curation on Bernadette's call facts (the model stubbed)");
  // =========================================================================
  const NOW0 = et(2026, 10, 20, 10);
  const mk = (body: string, o: Record<string, unknown> = {}) => prisma.clientFact.create({
    data: { clientId: bern.clientId, enrollmentId: bern.enrollmentId, category: "BRAND_PREFERENCE", body, source: "call", callRecordId: oct12.id, speaker: "client", factDate: et(2026, 10, 12, 15, 20), monthId: bern.monthId, status: "PROPOSED", aiContext: "DENIED", ...o },
    select: { id: true, updatedAt: true },
  });
  const F = {
    style: await mk("Watches Téa Del Carlo and Two Cents San Diego for skit style"),
    p1: await mk("Her typical buyers are between $600k and $800k"),
    p2: await mk("Will take $1M+ listings when they come up"),
    captions: await mk("Captions in bold white text", { category: "PRODUCTION_PREFERENCE", fieldKey: "editing.captions" }),
    wardrobe: await mk("Likes to wear navy on camera", { category: "PRODUCTION_PREFERENCE" }),
    followup: await mk("Agreed to a follow-up strategy call on Monday, October 26th at 3:30pm"),
    husband: await mk("Her husband Jay is happy to be in skits"),
    kerrigan: await mk("Admires Brandon Kerrigan as a local benchmark but would not copy his style"),
    late: await mk("Unhappy the September videos came late"),
    texts: await mk("Prefers texts over calls"),
    years: await mk("Has sold homes in Bethlehem for 12 years"),
    vague: await mk("Something vague about the vibe"),
    secret: await mk("Going through a divorce, keep it quiet", { confidential: true }),
    later: await mk("Mentioned a podcast idea for later"),
    kyle: await mk("Kyle accepted: loves the brunch topics", { status: "ACCEPTED", aiContext: "ALLOWED", reviewedBy: "kyle@realtourpilot.com" }),
    field: await mk("Photographer noticed she prefers the kitchen", { source: "field" }),
  };
  curatorRules = [
    [/Del Carlo/, dec("IDENTITY", { key: "style_inspirations", line: STYLE_LINE })],
    [/\$600k/, dec("STRATEGY_NOTE", { key: "price_point", line: PRICE_LINE })],
    [/\$1M\+/, dec("STRATEGY_NOTE", { key: "price_point", line: PRICE_LINE })],
    [/bold white/, dec("EDITING", { key: "captions", line: "Captions in bold white text" })],
    [/navy/, dec("FILMING", { key: "wardrobe", line: "Wears navy on camera" })],
    [/follow-up strategy call/, dec("ONE_OFF", { eventAt: "2026-10-26T15:30:00-04:00" })],
    [/husband Jay/, dec("SKIT_CAST", { castName: "Jay", castRole: "husband" })],
    [/Brandon Kerrigan/, dec("DROP", { reason: "a local agent we cannot tie to her videos" })],
    [/came late/, dec("TEAM_NOTE", { complaint: "Upset the September videos were late" })],
    [/texts over calls/, dec("TEAM_NOTE")],
    [/Bethlehem/, dec("SCRIPT")],
    [/vague/, dec("SCRIPT", { confidence: 0.4 })],
  ];
  curatorAnswer = curatorFromPrompt;
  const r1 = await kc.curateClientKnowledge(bern.clientId, { requestedBy: "drill", unattended: false, now: NOW0 });
  const curatorPrompt = prompts.filter((p) => p.kind === "curator").at(-1)?.prompt ?? "";
  c.ok("one model call for the client's whole pile", r1.ok && calls.curator === 1, JSON.stringify(r1.ok ? r1.applied : r1));
  c.ok("said in confidence: never sent to the model", !curatorPrompt.includes("divorce") && !curatorPrompt.includes(F.secret.id));
  c.ok("a person's decision and a photographer's field note are never re-sent", !curatorPrompt.includes(F.kyle.id) && !curatorPrompt.includes(F.field.id));
  const row = (id: string) => prisma.clientFact.findUniqueOrThrow({ where: { id } });
  const styleSrc = await row(F.style.id);
  const style = await prisma.clientFact.findFirstOrThrow({ where: { clientId: bern.clientId, fieldKey: "identity.style_inspirations", status: "ACCEPTED" } });
  c.ok("style inspirations → the creative identity (the line names who they are)", style.body === STYLE_LINE && styleSrc.status === "SUPERSEDED" && styleSrc.supersededById === style.id && (await kc.styleInspirationsFor(bern.clientId))[0] === STYLE_LINE, `${styleSrc.status} ${style.body}`);
  const priceNotes = await prisma.clientFact.findMany({ where: { clientId: bern.clientId, fieldKey: "strategy_note.price_point", status: "ACCEPTED" } });
  const [p1, p2] = [await row(F.p1.id), await row(F.p2.id)];
  c.ok("the price point → ONE strategy line, both facts folded into it", priceNotes.length === 1 && priceNotes[0].body === PRICE_LINE && p1.status === "SUPERSEDED" && p2.status === "SUPERSEDED" && p1.supersededById === priceNotes[0].id, `${priceNotes.length} ${p1.status} ${p2.status}`);
  c.ok("…shown beside the strategy", (await kc.strategyNotesFor(bern.clientId)).map((n) => n.line).join("|") === PRICE_LINE);
  const cap = await row(F.captions.id);
  c.ok("captions → the editor (accepted, AI-allowed, editing.captions)", cap.status === "ACCEPTED" && cap.aiContext === "ALLOWED" && cap.fieldKey === "editing.captions" && cap.category === "PRODUCTION_PREFERENCE");
  c.ok("…on the editor's brief facts", (await productionFactsForBrief(bern.clientId, null)).some((x) => x.body === "Captions in bold white text"));
  const pf = await import("@/lib/profileFields");
  c.ok("…and the profile slot the brief reads is filled (no one pressed Apply)", (await pf.currentTargetValue(bern.clientId, "profile.editing.captions")) === "Captions in bold white text" && (await pf.openFieldProposals(bern.clientId)).length === 0 && r1.ok && r1.profileChanges >= 1, r1.ok ? String(r1.profileChanges) : "");
  const ward = await prisma.clientFact.findFirst({ where: { clientId: bern.clientId, fieldKey: "production.wardrobe", status: "ACCEPTED" } });
  c.ok("wardrobe → the shoot (production.wardrobe), its slot filled too", ward?.body === "Wears navy on camera" && (await pf.currentTargetValue(bern.clientId, "profile.production.wardrobe")) === "Wears navy on camera");
  const fu = await row(F.followup.id);
  c.ok("the follow-up call → a one-off, kept to its date, never in a prompt", fu.status === "ACCEPTED" && fu.fieldKey === "oneoff.call" && fu.factDate?.getTime() === et(2026, 10, 26, 15, 30).getTime() && fu.aiContext === "DENIED", `${fu.status} ${fu.fieldKey} ${fu.factDate?.toISOString()}`);
  const cast = await skitCastOf(bern.enrollmentId);
  c.ok("the husband → Settings › Skit cast", cast.some((m) => /husband/i.test(m.role) && m.name === "Jay") && (await row(F.husband.id)).fieldKey === "skit_cast", JSON.stringify(cast));
  const kerr = await row(F.kerrigan.id);
  c.ok("Brandon Kerrigan → dropped, the reason on the row", kerr.status === "REJECTED" && /^ai-curator\|DROP\|/.test(kerr.reviewedBy ?? "") && /cannot tie/.test(kerr.reviewedBy ?? ""));
  const issue = await prisma.clientIssue.findFirst({ where: { sourceRef: `ClientFact:${F.late.id}` } });
  c.ok("a complaint on a call → a client issue (source call), recorded by the hub", issue?.source === "call" && issue.clientId === bern.clientId && issue.title === "Upset the September videos were late" && issue.createdBy === "hub");
  const [texts, years, vague, secret, later] = await Promise.all([row(F.texts.id), row(F.years.id), row(F.vague.id), row(F.secret.id), row(F.later.id)]);
  c.ok("a team note is kept but never reaches a video (AI-denied)", texts.status === "ACCEPTED" && texts.aiContext === "DENIED");
  c.ok("about her, for scripts → the writer reads it", years.status === "ACCEPTED" && years.aiContext === "ALLOWED" && (await factsForPrompt(bern.clientId)).some((x) => x.id === F.years.id));
  c.ok("unsure → dropped", vague.status === "REJECTED" && /not sure enough/.test(vague.reviewedBy ?? ""));
  c.ok("said in confidence → kept for the team by rule", secret.status === "ACCEPTED" && secret.aiContext === "DENIED" && /TEAM_NOTE\|rule\|/.test(secret.reviewedBy ?? ""));
  c.ok("a fact the model skipped waits, untouched", later.status === "PROPOSED" && later.reviewedBy === null);
  const run = r1.ok ? await prisma.programAiRun.findUnique({ where: { id: r1.runId! } }) : null;
  c.ok("every decision names the run, and the run holds the answer", run?.kind === "knowledge_curation" && run.status === "SUCCEEDED" && [style, kerr, years].every((x) => (x.reviewedBy ?? "").includes(run.id)));
  c.ok("Kyle's decision stands", (await row(F.kyle.id)).reviewedBy === "kyle@realtourpilot.com");

  // The second pass sends only what is still open.
  curatorRules.push([/podcast idea/, dec("DROP", { reason: "not about her videos yet" })]);
  const r2 = await kc.curateClientKnowledge(bern.clientId, { requestedBy: "drill", unattended: false, now: NOW0 });
  const p2nd = prompts.filter((p) => p.kind === "curator").at(-1)?.prompt ?? "";
  c.ok("the next pass sends only the fact still open", r2.ok && p2nd.includes(F.later.id) && !p2nd.includes(F.years.id) && (await row(F.later.id)).status === "REJECTED");
  c.ok("…and the current lines go with it, so it can merge", /CURRENT NOTES[\s\S]*strategy_note\.price_point: Ideal price point/.test(p2nd));
  const r3 = await kc.curateClientKnowledge(bern.clientId, { requestedBy: "drill", unattended: false, now: NOW0 });
  c.ok("nothing open → no model call", r3.ok && r3.runId === null && calls.curator === 2);

  // =========================================================================
  c.head("4 · fail safe: the model down changes nothing");
  // =========================================================================
  {
    const fresh = await mk("Wants more drone shots of the farm");
    const before = await prisma.clientFact.findMany({ where: { clientId: bern.clientId }, orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } });
    modelDown = true;
    const r = await kc.curateClientKnowledge(bern.clientId, { requestedBy: "drill", unattended: false, now: NOW0 });
    modelDown = false;
    const after = await prisma.clientFact.findMany({ where: { clientId: bern.clientId }, orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } });
    c.ok("no answer → not ok, and every fact exactly as it was", !r.ok && JSON.stringify(before) === JSON.stringify(after) && (await row(fresh.id)).status === "PROPOSED", r.ok ? "ok?!" : r.reason);
    c.ok("…the failed run is on the ledger", (await prisma.programAiRun.count({ where: { kind: "knowledge_curation", status: "FAILED" } })) === 1);
    const dry = await kc.curateClientKnowledge(bern.clientId, { requestedBy: "drill", unattended: false, dryRun: true, now: NOW0 });
    c.ok("a dry run counts and never calls the model", dry.ok && dry.seen === 1 && calls.curator === 3);
    curatorRules.push([/drone shots/, dec("EDITING", { key: "broll", line: "More drone shots of the farm" })]);
    await kc.curateClientKnowledge(bern.clientId, { requestedBy: "drill", unattended: false, now: NOW0 });
  }

  // =========================================================================
  c.head("5 · \"What the AI kept\" (Plan › Knowledge, read-only)");
  // =========================================================================
  {
    const v = await kc.loadKnowledgeView(bern.clientId);
    const places = new Set(v.kept.map((k) => k.place));
    c.ok("kept lines grouped where they are used", ["identity", "strategy", "editing", "filming", "cast", "script", "team", "oneoff"].every((p) => places.has(p as never)), [...places].join(","));
    c.ok("a kept line carries the AI's reason; Kyle's reads as the team's", v.kept.some((k) => k.by === "ai" && !!k.reason) && v.kept.some((k) => k.id === F.kyle.id && k.by === "person"));
    c.ok("dropped ones (with why) and the merged count are there for Details", v.dropped.some((d) => /Brandon Kerrigan/.test(d.body) && /cannot tie/.test(d.reason ?? "")) && v.merged >= 2);
    c.ok("nothing waiting, and the last pass is known", v.waiting === 0 && !!v.lastRunAt);
    c.ok("the drone line is on the editor's brief too (editing.broll)", (await productionFactsForBrief(bern.clientId, null)).some((x) => x.body === "More drone shots of the farm"));
  }

  // =========================================================================
  c.head("6 · calls filed by the signals and the follow-up");
  // =========================================================================
  const NOW = et(2026, 10, 26, 16, 30);
  const waiting = async (o: { name: string | null; email: string | null; at: Date; invitee?: Record<string, unknown>; matchState?: string; raw?: Record<string, unknown> }) =>
    prisma.programCallRecord.create({
      data: {
        callType: "MONTHLY_STRATEGY", inviteeName: o.name, inviteeEmail: o.email, scheduledStart: o.at, scheduledEnd: new Date(o.at.getTime() + 30 * 60_000), status: o.at < NOW ? "COMPLETED" : "SCHEDULED",
        matchState: o.matchState ?? "UNMATCHED_INVITEE", rawJson: JSON.stringify({ calendly: { invitee: o.invitee ?? {} }, ...(o.raw ?? {}) }),
      },
      select: { id: true },
    });
  const W = {
    janice: await waiting({ name: "Janice Pigga TEST", email: "janicepigga@gmail.example", at: et(2026, 10, 20, 11) }),
    portal: await waiting({ name: "M", email: "mike.portal@drill.example", at: et(2026, 10, 21, 11) }),
    phone: await waiting({ name: "Front Desk", email: "desk@office.example", at: et(2026, 10, 21, 13), invitee: { text_reminder_number: "+1 610-555-0142" } }),
    followup: await waiting({ name: "Bern R", email: "bern@work.example", at: et(2026, 10, 26, 15, 30) }),
    forged: await waiting({ name: "Janice Pigga TEST", email: "x@x.example", at: et(2026, 10, 22, 11), invitee: { tracking: { utm_content: `rtp1.${jan.monthId}.AAAAAAAAAA` } } }),
    twins: await waiting({ name: "Sam Same TEST", email: "sam@same.example", at: et(2026, 10, 22, 13) }),
    setAside: await waiting({ name: "Janice Pigga TEST", email: "jp2@gmail.example", at: et(2026, 10, 23, 11), matchState: "CANDIDATE", raw: { staff: { unassignedAt: "2026-10-23T18:00:00Z", by: "kyle" } } }),
    jp: await waiting({ name: "J. Pigga", email: "jp.realty@x.example", at: et(2026, 10, 24, 11) }),
    nobody: await waiting({ name: "Unknown Person TEST", email: "who@nowhere.example", at: et(2026, 10, 24, 13) }),
    // Found by her name, but on Sep 10: it would plan September, a month already over.
    pastMonth: await waiting({ name: "Janice Pigga TEST", email: "jp.old@gmail.example", at: et(2026, 9, 10, 11) }),
  };
  const dryPlan = await auto.planWaitingMatches({ now: NOW });
  c.ok("the plan (the live script's dry run) writes nothing", dryPlan.planned.length === 5 && (await prisma.programCallRecord.count({ where: { matchState: "MATCHED" } })) === 1, dryPlan.planned.map((p) => `${p.who}:${p.via}`).join(", "));
  const res = await auto.rematchWaitingCalls({ now: NOW });
  const rec = (id: string) => prisma.programCallRecord.findUniqueOrThrow({ where: { id } });
  const j = await rec(W.janice.id);
  c.ok("Janice, from her own gmail: filed by her full name, the reason on the record", j.matchState === "MATCHED" && j.clientId === jan.clientId && j.monthId === jan.monthId && /no other client has it/.test(j.matchNote ?? ""), `${j.matchState} ${j.matchNote}`);
  const pr = await rec(W.portal.id);
  c.ok("a booking from the portal sign-in → that client", pr.matchState === "MATCHED" && pr.clientId === mike.clientId && /portal sign-in/.test(pr.matchNote ?? ""));
  const ph = await rec(W.phone.id);
  c.ok("a booking with the client's phone → that client", ph.matchState === "MATCHED" && ph.clientId === ophone.clientId && /phone number/.test(ph.matchNote ?? ""));
  const fw = await rec(W.followup.id);
  c.ok("Bernadette's Oct 26 follow-up (unknown address) → hers, by the call she agreed", fw.matchState === "MATCHED" && fw.clientId === bern.clientId && /agreed on a call to a follow-up/.test(fw.matchNote ?? ""), `${fw.matchState} ${fw.matchNote}`);
  c.ok("…it plans OCTOBER, as the Oct 12 call did (the 26th would be November by the day rule)", fw.targetMonthKey === "2026-10" && fw.monthId === bern.monthId && JSON.parse(fw.rawJson ?? "{}").target?.rule === "followup", `${fw.targetMonthKey}`);
  const usedOneOff = await row(F.followup.id);
  c.ok("…and the one-off has done its job: expired, the call named", usedOneOff.status === "REJECTED" && /EXPIRED/.test(usedOneOff.reviewedBy ?? "") && (usedOneOff.reviewedBy ?? "").includes(W.followup.id));
  const fg = await rec(W.forged.id);
  c.ok("a booking with a portal token that did not verify is never filed by the name", fg.matchState === "UNMATCHED_INVITEE" && fg.clientId === null);
  const tw = await rec(W.twins.id);
  c.ok("a name two clients share is not a match", tw.matchState === "UNMATCHED_INVITEE" && tw.clientId === null);
  const sa = await rec(W.setAside.id);
  c.ok("a call a person took off a client is never re-filed", sa.matchState === "CANDIDATE" && sa.clientId === null);
  const pm = await rec(W.pastMonth.id);
  c.ok("a call found by name that would plan a month already over is NOT filed (a closed month is never rewritten)", pm.matchState === "UNMATCHED_INVITEE" && pm.clientId === null && pm.monthId === null && /a month already over/.test(pm.matchNote ?? "") && (await prisma.contentMonth.count({ where: { enrollmentId: jan.enrollmentId, monthKey: "2026-09" } })) === 0, `${pm.matchState} ${pm.matchNote}`);
  c.ok("the summary counts them", res.filed === 4 && res.held === 1 && res.left >= 4, JSON.stringify({ filed: res.filed, held: res.held, left: res.left }));
  const again = await auto.rematchWaitingCalls({ now: NOW });
  c.ok("a second pass changes nothing", again.filed === 0);
  // One-offs expire a day after their date even with no call.
  const memo = await prisma.clientFact.create({ data: { clientId: bern.clientId, category: "COMMITMENT", body: "Send the listing photos by Oct 15", source: "call", status: "ACCEPTED", aiContext: "DENIED", fieldKey: "oneoff.other", factDate: et(2026, 10, 15, 17), reviewedBy: "ai-curator|ONE_OFF|r0|dated" }, select: { id: true } });
  const ex = await kc.expireOneOffFacts(NOW);
  c.ok("a dated one-off is gone a day after its date (not remembered permanently)", ex.expired === 1 && (await row(memo.id)).status === "REJECTED");
  const cal = await auto.discoverCalendarCalls({ now: NOW, dryRun: false });
  c.ok("the calendar pass with Google not connected: skipped, nothing written", "skipped" in cal && /not connected/i.test(cal.skipped));
  const { loadCallList } = await import("@/lib/callList");
  const list = await loadCallList(bern.enrollmentId, NOW);
  const fr = list.find((x) => x.id === W.followup.id);
  c.ok("Plan › Calls: one plain line per call, how it was matched under Details", !!fr && /^Held · waiting for the notes/.test(fr.line) && /follow-up/.test(fr.matchNote ?? "") && list.find((x) => x.id === oct12.id)?.line === "Held · notes analyzed", JSON.stringify(list.map((x) => x.line)));

  // =========================================================================
  c.head("7 · the AI pass for what the signals left");
  // =========================================================================
  {
    await setAutomation("ai_runs", true, "drill");
    const dry = await auto.aiMatchWaitingCalls({ now: NOW, dryRun: true, max: 10 });
    c.ok("a dry run lists, and asks nothing", dry.rows.length >= 3 && calls.match === 0, dry.rows.map((r) => r.who).join(", "));
    modelDown = true;
    const down = await auto.aiMatchWaitingCalls({ now: NOW, max: 10, minStartMs: 1 });
    modelDown = false;
    c.ok("the model down: nothing filed, every call still waiting", down.filed === 0 && down.failed >= 1 && (await rec(W.jp.id)).matchState === "UNMATCHED_INVITEE");
    const askedBefore = calls.match;
    matchAnswer = (prompt) => {
      if (/email: jp\.realty@x\.example/.test(prompt)) return { clientId: jan.clientId, confidence: 0.92, reason: "J. Pigga with a realty address is Janice Pigga" };
      if (/email: who@nowhere/.test(prompt)) return { clientId: bern.clientId, confidence: 0.6, reason: "a guess" };
      return { clientId: null, confidence: 0.1, reason: "nobody" };
    };
    const ai = await auto.aiMatchWaitingCalls({ now: NOW, max: 10, minStartMs: 1 });
    c.ok("a failed ask is asked again once the model is back", ai.asked === down.failed, `${down.failed} failed, ${ai.asked} asked`);
    const jpRec = await rec(W.jp.id);
    c.ok("at 0.92: filed, the AI's reason on the record", jpRec.matchState === "MATCHED" && jpRec.clientId === jan.clientId && /matched by the AI \(92%\)/.test(jpRec.matchNote ?? ""), `${jpRec.matchState} ${jpRec.matchNote}`);
    const alias = await prisma.clientEmailAlias.findFirst({ where: { clientId: jan.clientId, email: "jp.realty@x.example" } });
    c.ok("…and the address is verified as hers, so the hourly sync reads the same answer", !!alias?.verifiedAt && /^ai-call-match:/.test(alias.verifiedBy ?? ""));
    c.ok("at 0.6: not filed (a guess is not a match)", (await rec(W.nobody.id)).matchState === "UNMATCHED_INVITEE" && ai.noMatch >= 1);
    c.ok("the person-set-aside call is never asked about", !prompts.filter((p) => p.kind === "match").some((p) => p.prompt.includes("jp2@gmail.example")));
    const asked = calls.match - askedBefore;
    const next = await auto.aiMatchWaitingCalls({ now: NOW, max: 10, minStartMs: 1 });
    c.ok("never asked twice in a week", next.asked === 0 && calls.match - askedBefore === asked, `${asked} then ${next.asked}`);
    c.ok("each ask is a call_match run, no client's daily cap (scope names the call)", (await prisma.programAiRun.count({ where: { kind: "call_match", status: "SUCCEEDED" } })) === asked);
  }

  // =========================================================================
  c.head("8 · complaints from portal messages");
  // =========================================================================
  {
    const msg = (body: string, ago = 60) => prisma.programMessage.create({ data: { enrollmentId: jan.enrollmentId, clientId: jan.clientId, authorKind: "CLIENT", authorLabel: "Janice Pigga TEST", body, createdAt: new Date(NOW.getTime() - ago * 60_000) }, select: { id: true } });
    const angry = await msg("This is a problem: the October videos are late again and my last two texts were ignored.");
    const ask = await msg("Small issue: can we swap the brunch topic for the market update?");
    const happy = await msg("Love the new video, thank you!");
    const staffMsg = await prisma.programMessage.create({ data: { enrollmentId: jan.enrollmentId, clientId: jan.clientId, authorKind: "STAFF", authorLabel: "Kyle", body: "Sorry this is late, a terrible week", createdAt: new Date(NOW.getTime() - 30 * 60_000) }, select: { id: true } });
    const dry = await cc.sweepMessageComplaints({ now: NOW, dryRun: true });
    c.ok("only client messages that read negative are asked about (dry run asks nothing)", (dry.would ?? []).map((w) => w.messageId).sort().join(",") === [angry.id, ask.id].sort().join(",") && calls.complaint === 0);
    void happy; void staffMsg;
    complaintAnswer = (prompt) => /ignored/.test(prompt)
      ? { complaint: true, title: "Upset the October videos are late — texts ignored", confidence: 0.9, reason: "late work and no replies" }
      : { complaint: false, title: null, confidence: 0.8, reason: "a topic change request" };
    const r = await cc.sweepMessageComplaints({ now: NOW, minStartMs: 1 });
    const iss = await prisma.clientIssue.findFirst({ where: { sourceRef: `ProgramMessage:${angry.id}` } });
    c.ok("a real complaint → one client issue (source portal), no dash in its title", r.recorded === 1 && iss?.source === "portal" && iss.clientId === jan.clientId && !/[—–]/.test(iss.title) && /late/.test(iss.title), iss?.title ?? "none");
    c.ok("a request is not a complaint", !(await prisma.clientIssue.findFirst({ where: { sourceRef: `ProgramMessage:${ask.id}` } })));
    const r2 = await cc.sweepMessageComplaints({ now: NOW, minStartMs: 1 });
    c.ok("each message is asked once (an answer, either way, is remembered)", r2.asked === 0 && (await prisma.clientIssue.count({ where: { sourceRef: { startsWith: "ProgramMessage:" } } })) === 1);
    const down = await msg("Terrible edit, the music is wrong again.", 20);
    modelDown = true;
    const r3 = await cc.sweepMessageComplaints({ now: NOW, minStartMs: 1 });
    modelDown = false;
    c.ok("the model down: nothing recorded, the message asked again next time", r3.failed === 1 && r3.recorded === 0 && (await cc.sweepMessageComplaints({ now: NOW, dryRun: true })).would?.some((w) => w.messageId === down.id) === true);
  }

  // =========================================================================
  c.head("9 · the switches and the wiring");
  // =========================================================================
  {
    await setAutomation("ai_runs", false, "drill");
    const before = calls.curator;
    await mk("Loves golden-hour light");
    const s = await kc.sweepKnowledgeCuration({ now: NOW });
    c.ok("ai_runs off: the 15-minute sweep curates nothing (one-offs still expire, no model)", s.skipped === "ai_runs is off" && calls.curator === before);
    const matchCalls = calls.match;
    const offMatch = await auto.aiMatchWaitingCalls({ now: new Date(NOW.getTime() + 30 * 864e5), max: 10, minStartMs: 1 });
    c.ok("…and the AI call match never reaches the model, nothing filed", offMatch.filed === 0 && calls.match === matchCalls && (await rec(W.nobody.id)).matchState === "UNMATCHED_INVITEE");
    const topics = read("src/app/api/cron/topics/route.ts");
    c.ok("the 15-minute cron runs the curator, the AI match and the complaint check inside its transcript step", /sweepKnowledgeCuration/.test(topics) && /aiMatchWaitingCalls/.test(topics) && /sweepMessageComplaints/.test(topics));
    c.ok("the hourly sync files calls by the signals (no model)", /autoMatch: \(\) => import\("@\/lib\/callAutoMatch"\)\.then\(\(m\) => m\.autoMatchCalls\(\)\)/.test(read("src/app/api/cron/sync/route.ts")));
    const plan = read("src/app/content/[id]/tabs/PlanTab.tsx");
    c.ok("Plan › Knowledge is the read-only view (no review pile)", /<KnowledgeView /.test(plan) && !/FactsPanel/.test(plan));
    c.ok("Plan › Calls lists calls with one line each; Strategy shows the call notes", /<CallsList rows=\{calls\} \/>/.test(plan) && /<StrategyNotesCard notes=\{callNotes\} \/>/.test(plan));
    const view = read("src/app/content/[id]/tabs/KnowledgeView.tsx");
    c.ok("the view has nothing to press but Details (no accept or reject)", !/(Accept|Reject|onClick|<button)/.test(view) && /<summary[^>]*>Details<\/summary>/.test(view));
    c.ok("the Brand tab's \"reach the editor brief\" list is the brief's own production lines, not brand or strategy", /f\.category === "PRODUCTION_PREFERENCE" && !\(f\.fieldKey \?\? ""\)\.startsWith\("production\."\)/.test(read("src/app/content/[id]/workspaceData.ts")));
    c.ok("the creative identity card shows the style inspirations", /label="Style inspirations"/.test(read("src/components/content/CreativeIdentityCard.tsx")) && /styleInspirationsFor/.test(read("src/app/content/[id]/programData.ts")));
    c.ok("no em or en dashes in what the curator, matcher or complaint check write", ![kcore.CURATOR_SYSTEM, core.CALL_MATCH_SYSTEM, cc.COMPLAINT_SYSTEM].some((s) => /[—–]/.test(s)));
    c.ok("nothing left this process", fence.blocked.length === 0, fence.blocked.join(" "));
    c.ok("the model was only ever the stub's", calls.other === 0, String(calls.other));
  }

  c.summary();
  quiet.restore();
  // Let any fire-and-forget write (a notification, a usage row) finish before
  // the database closes, then leave at once (nothing may touch a closed PGlite).
  await new Promise((r) => setTimeout(r, 250));
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
