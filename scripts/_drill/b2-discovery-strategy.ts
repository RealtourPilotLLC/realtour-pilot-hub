// ---------------------------------------------------------------------------
// DRILL: B2 — discovery, strategy and client knowledge (unified handoff,
// Sep 25 2026): 6.2-transcript-association, 6.2-discovery-analysis-into-month,
// A04, A08 (reference format + editing and release), 6.2-strategy-ready-notice,
// 6.2-call-knowledge-proposals (already fixed — asserted), A09, and the
// strategy half of U01.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b2-discovery-strategy.ts
//
// The OLD behaviour is shown first wherever it is observable: the old
// contentGeneration / contentStrategy / contentCalls / programOnboarding /
// contentCallRecords are loaded for real from commit f2555f7 (their `@/`
// imports pointed at this tree) and run against the same database.
//
// The MODEL is stubbed at aiJsonWithUsage only — the run ledger, dedupe keys,
// switches and every write around it are the shipped code. Google (Calendar,
// Drive, Gmail) is answered by fakes at the fetch fence / module boundary;
// Calendly's event listing is a fake list; every other outbound call is
// blocked and counted. Nothing reaches a provider, a client or a teammate.
//
// ISOLATION: PGlite on 127.0.0.1:5623 via the shared harness; production is
// never opened. Clock-dependent steps take a pinned `now`.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5623);
const REPO = path.resolve(__dirname, "../..");
const BASE = "f2555f7"; // pinned: batch 1, before this batch

installNextStubs();

// ---- module seams ------------------------------------------------------------
// interceptModule wraps a module where it is REQUIRED — a static import. A
// dynamic import() of an already-loaded module does not pass through that hook
// (measured here: contentCallRecords' `await import("@/lib/integrations/
// google")` got the real ownerGoogleToken, and content/actions' actor() the
// real getCurrentUser). So only statically-imported seams are stubbed (the
// model, Calendly's listing); Google is answered at the network fence (a
// token endpoint, Calendar, Drive, Gmail), and the STRATEGY duty is handed to
// the drill's session-less "dev@local", the way cp11 does it.
function seam(match: (r: string) => boolean, overrides: () => Record<string, unknown>) {
  interceptModule(match, (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => { const o = overrides(); return typeof k === "string" && k in o ? o[k] : t[k]; } }));
}

// ---- the model boundary ----------------------------------------------------
type ModelKind = "analysis" | "strategy" | "revise" | "other";
const modelCalls: { kind: ModelKind; system: string; prompt: string }[] = [];
const fixtures: Partial<Record<ModelKind, unknown>> = {};
seam((r) => r === "@/lib/integrations/ai" || /[\\/]integrations[\\/]ai(\.ts)?$/.test(r), () => ({
      aiJsonWithUsage: async (opts: { system: string; prompt: string }) => {
        const kind: ModelKind = /processing a call transcript/.test(opts.system) ? "analysis"
          : /revising a client's Social Content Strategy/.test(opts.system) ? "revise"
          : /building a client's 2026 Social Content Strategy/.test(opts.system) ? "strategy" : "other";
        modelCalls.push({ kind, system: opts.system, prompt: opts.prompt });
        const out = fixtures[kind];
        if (!out) throw new Error(`drill: no fixture for a ${kind} prompt`);
        return { result: JSON.parse(JSON.stringify(out)), usage: { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "drill-stub" };
      },
}));

// ---- Gmail sends, answered at the fence and read back ------------------------
const gmailSent: { to: string; subject: string; body: string }[] = [];

// ---- Calendly's scheduled-event listing, as a fake list ---------------------
type FakeBooking = { event: { uri: string; name?: string; status?: string; start_time?: string; end_time?: string; event_type?: string }; invitees: { email?: string; name?: string; status?: string; uri?: string }[] };
let calendlyBookings: FakeBooking[] = [];
seam((r) => r === "@/lib/integrations/calendly" || /[\\/]lib[\\/]integrations[\\/]calendly(\.ts)?$/.test(r), () => ({ listScheduledEvents: async () => calendlyBookings }));

// ---- the fence: Calendar events, Drive listing/metadata/export, Slack --------
const calendarEvents = new Map<string, Record<string, unknown>>();
let geminiListing: { id: string; name: string; createdTime: string; webViewLink?: string }[] = [];
let legacyListing: { id: string; name: string; createdTime: string }[] = [];
const driveMeta = new Map<string, Record<string, unknown>>();
const driveText = new Map<string, string>();
const exported: string[] = [];
const fence = fenceFetch(async (url, init) => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channels: [] });
  if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "drill-google-token", expires_in: 3600 });
  if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
    const raw = (JSON.parse(String(init?.body ?? "{}")) as { raw?: string }).raw ?? "";
    const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const [head, ...rest] = mime.split("\r\n\r\n");
    const hdr = (n: string) => new RegExp(`^${n}: (.*)$`, "m").exec(head)?.[1] ?? "";
    const subj = hdr("Subject");
    const b64 = /^=\?UTF-8\?B\?(.*)\?=$/.exec(subj)?.[1];
    gmailSent.push({ to: hdr("To"), subject: b64 ? Buffer.from(b64, "base64").toString("utf8") : subj, body: rest.join("\r\n\r\n") });
    return json({ id: `gm-${gmailSent.length}` });
  }
  const cal = /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/([^?/]+)/.exec(url);
  if (cal) { const ev = calendarEvents.get(decodeURIComponent(cal[1])); return ev ? json(ev) : json({ error: { message: "Not Found" } }, 404); }
  const exp = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\/export/.exec(url);
  if (exp) { const id = decodeURIComponent(exp[1]); exported.push(id); const t = driveText.get(id); return t ? new Response(t, { status: 200 }) : json({ error: { message: "Not Found" } }, 404); }
  const meta = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\?/.exec(url);
  if (meta) { const m = driveMeta.get(decodeURIComponent(meta[1])); return m ? json(m) : json({ error: { message: "Not Found" } }, 404); }
  if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
    const q = new URL(url).searchParams.get("q") ?? "";
    return json({ files: q.includes("Notes by Gemini") ? geminiListing : q.includes("and Jordan Spackman") ? legacyListing : [] });
  }
  return null;
});

// ---- the old code, from f2555f7 --------------------------------------------
function writeBaseCopies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out: Record<string, string> = {};
  for (const name of ["contentGeneration", "contentStrategy", "contentCalls", "programOnboarding", "contentCallRecords", "contentTopics"]) {
    const f = path.join(dir, `${name}.base.ts`);
    fs.writeFileSync(f, point(show(`src/lib/${name}.ts`)));
    out[name] = f;
  }
  return { dir, ...out } as { dir: string; contentGeneration: string; contentStrategy: string; contentCalls: string; programOnboarding: string; contentCallRecords: string; contentTopics: string };
}

// ---- fixtures -----------------------------------------------------------------
const excerpt = (text: string) => ({ speaker: "client", speakerName: null, time: null, text });
const ANALYSIS = () => ({
  callKind: "discovery", plannedMonthKey: "2026-10",
  selectedTopics: [{ title: "Why the first week's price decides the sale", concept: "Pricing strategy for move-up sellers", pillar: null, excerpts: [excerpt("I always tell sellers the first week decides everything.")] }],
  discussedTopics: [{ title: "A Saturday in West Chester", concept: "Local lifestyle", pillar: null, excerpts: [excerpt("I love the farmers market on Saturdays.")] }],
  rejectedIdeas: [],
  facts: [
    { body: "Wants to film on Tuesdays", category: "PRODUCTION_PREFERENCE", fieldKey: "production.preferred_days", scope: "MONTH", speaker: "client", confidential: false, confidence: 0.9, excerpt: excerpt("Tuesdays work best for me.") },
    { body: "Now wants calm acoustic music under every video", category: "PRODUCTION_PREFERENCE", fieldKey: "editing.music", scope: "PERMANENT", speaker: "client", confidential: false, confidence: 0.9, excerpt: excerpt("Something calm, acoustic."), proposedValue: "Calm acoustic" },
  ],
  strategyProposals: [],
  priorities: ["Lead with the spring market"],
  todos: ["Send logo files"],
});
const PILLARS = ["Seller Strategy", "Buyer Guidance", "Local Life", "Behind the Scenes"];
const STRATEGY_OUT = () => ({
  clientName: "Nadia Brooks", subtitle: "Built around Trust, Value, Credibility, and Entertainment",
  brandOverview: { coreValues: "Honesty, showing up", brandMessage: "The West Chester move-up specialist who explains everything twice", shortBrandStatement: "Clear advice, calm process", brandVoice: "Warm, calm, direct" },
  targetAudience: { primaryServiceAreas: "Chester County, West Chester", pricePositioning: "Move-up homes", primaryClientTypes: "Move-up buyers and sellers", longTermPositioningGoal: "The West Chester name" },
  contentGoals: ["Two listing leads a month from video", "Grow to 3,000 local followers", "Be recognised at open houses", "Post four videos a month"],
  contentPillars: {
    preamble: "Every video should build Trust through empathy and honesty, provide Value through a useful takeaway, establish Credibility through experience and clear reasoning, and create Entertainment through curiosity and personality.",
    pillars: PILLARS.map((name, i) => ({ name, purpose: `Purpose of pillar ${i + 1}`, focusAreas: `Focus areas of pillar ${i + 1}`, contentApproach: null })),
  },
  framework: "policy",
  captionCtaExamples: ["DM me WEST for my pricing guide", "Call or text to talk through your move", "Save this for your next move"],
  strategicDirection: "Lead with pricing clarity, then show the town.",
  gaps: [{ kind: "missing-answer", field: "targetAudience.pricePositioning", text: "Exact price band was not confirmed", question: "What price range do you want to be known for?" }],
});
const DISCOVERY_TRANSCRIPT = [
  "Jordan Spackman: Thanks for making the time. Tell me about your business and who you serve.",
  "Nadia Brooks: I sell mostly move-up homes in Chester County and I want to be the name people think of for West Chester.",
  "Nadia Brooks: Honestly, between us, my broker is leaving the firm at the end of the year and I may follow.",
  "Nadia Brooks: My values are honesty and showing up. I explain everything twice so nobody is surprised.",
  "Nadia Brooks: The listing I did next to Harriet Vance's place last spring taught me a lot about pricing.",
  "Jordan Spackman: Love it. What do you want out of video?",
  "Nadia Brooks: Two listing leads a month would be amazing. [CONFIDENTIAL] my split is changing to 80/20 in January.",
  "Nadia Brooks: I want calm, warm videos. Nothing salesy.",
].join("\n");
const PLAIN_TRANSCRIPT = `Jordan Spackman: Thanks for coming on. Tell me what you want this year.\nClient: I want calm videos about pricing and the town, and two listing leads a month from them. Tuesdays work best for filming.\nJordan Spackman: Great, we'll build the strategy around that. Anything else?\nClient: Something calm, acoustic under the videos please.`;

/** Words of a text as a reader sees them: bullets and trailing colons are layout, not words. */
const readerWords = (s: string) => s.split(/\s+/).filter(Boolean).map((w) => w.replace(/:$/, "")).filter((w) => w && !/^[-•*·▪◦●]$/.test(w) && !/^\d{1,2}[.)]$/.test(w));

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const gen = await import("@/lib/contentGeneration");
  const cs = await import("@/lib/contentStrategy");
  const calls = await import("@/lib/contentCallRecords");
  const legacy = await import("@/lib/contentCalls");
  const ob = await import("@/lib/programOnboarding");
  const tj = await import("@/lib/transcriptJobs");
  const facts = await import("@/lib/clientFacts");
  const share = await import("@/lib/scriptShare");
  const rt = await import("@/lib/reminderTemplates");
  const { subjectFor } = await import("@/lib/outbox");
  const { portalStrategy } = await import("@/lib/portal");
  const { safeTopicExcerpts } = await import("@/lib/contentTopics");
  const policy = await import("@/lib/contentPolicy");
  const actions = await import("@/app/content/actions");
  const view = await import("@/components/content/StrategyDocView");
  const manifest = await import("../strategy-reference-manifest");
  const { buildContentMonth } = await import("./_fixtures/contentMonth");
  const base = writeBaseCopies();
  type Gen = typeof gen; type Cs = typeof cs; type Legacy = typeof legacy; type Ob = typeof ob; type Calls = typeof calls;
  const oldGen = (await import(base.contentGeneration)) as Gen;
  const oldCs = (await import(base.contentStrategy)) as Cs;
  const oldLegacy = (await import(base.contentCalls)) as Legacy;
  const oldOb = (await import(base.programOnboarding)) as Ob;
  const oldCalls = (await import(base.contentCallRecords)) as Calls;

  const setSwitch = (key: string, enabled: boolean) => prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled } });
  async function client(name: string, o: { email?: string; seatEmail?: string; token?: boolean } = {}) {
    const cl = await prisma.client.create({ data: { name, socialClient: true, email: o.email ?? null }, select: { id: true } });
    const e = await prisma.contentEnrollment.create({
      data: { clientId: cl.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, startedAt: new Date("2026-09-01T04:00:00Z"), ...(o.token ? { portalToken: randomBytes(24).toString("base64url"), portalTokenIssuedAt: new Date() } : {}) },
      select: { id: true },
    });
    if (o.seatEmail) {
      const u = await prisma.clientUser.create({ data: { email: o.seatEmail, name, status: "ACTIVE" }, select: { id: true } });
      await prisma.clientMembership.create({ data: { clientUserId: u.id, enrollmentId: e.id, clientId: cl.id, role: "OWNER", acceptedAt: new Date() } });
    }
    return { clientId: cl.id, enrollmentId: e.id, name };
  }
  type W = Awaited<ReturnType<typeof client>>;
  async function discovery(w: W, o: { start: Date; matchState?: string; transcript?: string; calendarExternalId?: string; cancelJobs?: boolean }) {
    const r = await prisma.programCallRecord.create({
      data: { enrollmentId: w.enrollmentId, clientId: w.clientId, callType: "BRAND_DISCOVERY", status: "COMPLETED", scheduledStart: o.start, scheduledEnd: new Date(o.start.getTime() + 45 * 60_000), matchState: o.matchState ?? "MATCHED", calendarExternalId: o.calendarExternalId ?? null },
      select: { id: true },
    });
    await prisma.programOnboarding.upsert({ where: { enrollmentId: w.enrollmentId }, create: { enrollmentId: w.enrollmentId, clientId: w.clientId, discoveryCallRecordId: r.id, status: "DISCOVERY_HELD" }, update: { discoveryCallRecordId: r.id } });
    // A paste is deduplicated by its words across calls, so each fixture's copy is its own.
    if (o.transcript) await calls.attachPastedTranscript(r.id, `${o.transcript}\n(${w.name})`, "drill-staff");
    // Isolation: a job this fixture does not test must not be run by a later sweep.
    if (o.cancelJobs) await tj.cancelTranscriptJobs(r.id, "drill: run by hand in this step");
    return r.id;
  }
  const version = (id: string) => prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id } });
  const sectionsOf = async (id: string) => cs.parseStoredSections((await version(id)).sectionsJson)!.sections;
  const runsOf = (kind: string, enrollmentId: string) => prisma.programAiRun.count({ where: { kind, enrollmentId } });

  await saveSecret("calendly", "drill-calendly-key-not-real");
  // The owner's Google mailbox, "connected": its refresh token is exchanged at the fence.
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token-not-real" }));
  const strategist = await prisma.appUser.create({ data: { email: "dev@local", name: "Drill Strategist", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const { setOwnerOverride } = await import("@/lib/contentProgram");
  await saveSecret("slack", "xoxb-drill-not-a-real-token");
  await prisma.appUser.create({ data: { email: "jordan@realtourpilot.com", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
  // Another enrolled client, so the other-client scrub has a name to find.
  await client("Harriet Vance");

  // =========================================================================
  c.head("1 · 6.2 transcript association — the doc attached to the booking's own event");
  // =========================================================================
  {
    const at = new Date("2026-09-22T14:00:00Z");
    const doc = (id: string, name: string, created: Date) => ({ id, name, prefix: policy.normalizeTitle(name), heldAt: calls.parseGeminiTitle(name).heldAt, createdAt: created, link: null });
    const renamed = { ...doc("doc-a", "Dana onboarding notes", new Date("2026-09-22T15:10:00Z")), prefix: "Dana onboarding notes" };
    const other = { ...doc("doc-other", "Weekly sync - 2026/09/22 10:00 EDT - Notes by Gemini", new Date("2026-09-22T15:00:00Z")), prefix: "Weekly sync" };
    const recs = [
      { id: "A", scheduledStart: at, calendarSummary: "Brand Discovery Call: Dana", attachmentFileIds: ["doc-a"] },
      { id: "B", scheduledStart: at, calendarSummary: "Brand Discovery Call: Eli", attachmentFileIds: [] },
    ];
    const oldPair = oldCalls.pairTranscriptCandidates(recs, [renamed, other], { startToleranceMinutes: 20 });
    c.ok("OLD: the renamed notes attached to A's own event are not strong — no auto-link", oldPair.get("A")?.auto === null);
    const p = calls.pairTranscriptCandidates(recs, [renamed, other], { startToleranceMinutes: 20 });
    c.ok("NEW: attached to A's event → A auto-pairs, even renamed", p.get("A")?.auto?.doc.id === "doc-a" && /attached/.test(p.get("A")?.auto?.why ?? ""), p.get("A")?.auto?.why);
    c.ok("another person's doc at the same hour stays a candidate for B, never auto", p.get("B")?.auto === null && !!p.get("B")?.list.some((x) => x.doc.id === "doc-other" && !x.strong));
    const both = calls.pairTranscriptCandidates([{ ...recs[0], attachmentFileIds: ["doc-a"] }, { ...recs[1], attachmentFileIds: ["doc-a"] }], [renamed], { startToleranceMinutes: 20 });
    c.ok("one doc attached to TWO records confirms neither", both.get("A")?.auto === null && both.get("B")?.auto === null);
    const agenda = { ...doc("doc-agenda", "Agenda for Dana", new Date("2026-09-20T12:00:00Z")), prefix: "Agenda for Dana" };
    const pre = calls.pairTranscriptCandidates([{ ...recs[0], attachmentFileIds: ["doc-agenda"] }], [agenda], { startToleranceMinutes: 20 });
    c.ok("an agenda attached to the invite days before the call is not its notes", pre.get("A")?.auto === null && !(pre.get("A")?.list ?? []).some((x) => x.strong));

    // The whole chain, with Calendar and Drive faked.
    const dana = await client("Dana Discovery");
    const eli = await client("Eli Evans");
    const danaCall = await discovery(dana, { start: new Date("2026-09-22T13:59:00Z"), calendarExternalId: "evt-dana" });
    const eliCall = await discovery(eli, { start: at, calendarExternalId: "evt-eli" });
    calendarEvents.set("evt-dana", { id: "evt-dana", status: "confirmed", summary: "Brand Discovery Call: Dana", start: { dateTime: "2026-09-22T13:59:00Z" }, end: { dateTime: "2026-09-22T14:44:00Z" }, attachments: [{ fileId: "doc-a", title: "Dana onboarding notes", mimeType: "application/vnd.google-apps.document", fileUrl: "https://docs.google.com/document/d/doc-a/edit" }] });
    calendarEvents.set("evt-eli", { id: "evt-eli", status: "confirmed", summary: "Brand Discovery Call: Eli", start: { dateTime: "2026-09-22T14:00:00Z" }, end: { dateTime: "2026-09-22T14:45:00Z" } });
    geminiListing = [{ id: "doc-other", name: "Weekly sync - 2026/09/22 10:00 EDT - Notes by Gemini", createdTime: "2026-09-22T15:00:00Z" }];
    driveMeta.set("doc-a", { id: "doc-a", name: "Dana onboarding notes", createdTime: "2026-09-22T15:10:00Z", webViewLink: "https://docs.google.com/document/d/doc-a/edit", mimeType: "application/vnd.google-apps.document", trashed: false });
    driveText.set("doc-a", `${PLAIN_TRANSCRIPT}\n${"More of the conversation. ".repeat(10)}`);
    driveText.set("doc-other", "Someone else's weekly sync — must never be exported.");
    const now = new Date("2026-09-22T16:00:00Z");
    const linked = await calls.linkCalendarEvents({ now });
    const rawA = JSON.parse((await prisma.programCallRecord.findUniqueOrThrow({ where: { id: danaCall } })).rawJson ?? "{}") as { calendar?: { attachmentFileIds?: string[] } };
    c.ok("linkCalendarEvents stores the event's attachment file ids", linked.linked === 2 && JSON.stringify(rawA.calendar?.attachmentFileIds) === JSON.stringify(["doc-a"]), JSON.stringify(linked));
    const d = await calls.discoverTranscriptSources({ now });
    const srcA = await prisma.programTranscriptSource.findFirst({ where: { externalId: "doc-a" } });
    const obA = await prisma.programOnboarding.findUniqueOrThrow({ where: { enrollmentId: dana.enrollmentId } });
    const jobsA = await prisma.programTranscriptJob.findMany({ where: { callRecordId: danaCall }, select: { kind: true, state: true } });
    c.ok("the renamed doc (missing from the Gemini search) is read by id and auto-confirmed on Dana's call", !!srcA && srcA.matchState === "CONFIRMED" && srcA.callRecordId === danaCall && !!srcA.text, JSON.stringify(d));
    c.ok("Dana's onboarding moves to TRANSCRIPT_PENDING; INGEST + ANALYZE queued", obA.status === "TRANSCRIPT_PENDING" && jobsA.map((j) => j.kind).sort().join(",") === "ANALYZE,INGEST", `${obA.status} ${JSON.stringify(jobsA)}`);
    const other2 = await prisma.programTranscriptSource.findFirst({ where: { externalId: "doc-other" } });
    const eliRec = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: eliCall } });
    const task = await prisma.smartTask.findUnique({ where: { dedupeKey: `content-call-review-${eliCall}` } });
    c.ok("Eli: the other person's doc is a CANDIDATE with no text, and never exported", other2?.matchState === "CANDIDATE" && other2.text === null && !exported.includes("doc-other"), `${other2?.matchState} exported=${exported.join(",")}`);
    c.ok("Eli: CANDIDATES and one owned review task (assigned to jordan)", eliRec.transcriptState === "CANDIDATES" && task?.assignedKey === "jordan" && task.status === "OPEN");
    await tj.cancelTranscriptJobs(danaCall, "drill: association step only");
  }

  // =========================================================================
  c.head("2 · 6.2 discovery analysis never files a month (§3: not a monthly task)");
  // =========================================================================
  {
    fixtures.analysis = ANALYSIS();
    const otto = await client("Otto Oldman");
    const ottoCall = await discovery(otto, { start: new Date("2026-09-10T14:00:00Z"), transcript: PLAIN_TRANSCRIPT, cancelJobs: true });
    const r0 = await oldGen.runTranscriptJob({ id: "old", kind: "ANALYZE", callRecordId: ottoCall, requestedBy: "drill-staff" });
    const oMonth = await prisma.contentMonth.findFirst({ where: { enrollmentId: otto.enrollmentId } });
    const oSel = await prisma.contentTopicSelection.count({ where: { enrollmentId: otto.enrollmentId } });
    c.ok("OLD: a discovery ANALYZE created a month with its strategy call COMPLETED and filed selections on it", r0.ok && !!oMonth && oMonth.strategyCallStatus === "COMPLETED" && oSel >= 1, `${oMonth?.monthKey} ${oMonth?.strategyCallStatus} sel=${oSel}`);

    const dora = await client("Dora Discovery");
    const doraCall = await discovery(dora, { start: new Date("2026-09-10T14:00:00Z"), transcript: PLAIN_TRANSCRIPT, cancelJobs: true });
    const monthsBefore = await prisma.contentMonth.count();
    const r = await gen.runTranscriptJob({ id: "new", kind: "ANALYZE", callRecordId: doraCall, requestedBy: "drill-staff" });
    const topics = await prisma.contentTopic.findMany({ where: { enrollmentId: dora.enrollmentId } });
    const fact = await prisma.clientFact.findFirst({ where: { clientId: dora.clientId, fieldKey: "production.preferred_days" } });
    const music = await prisma.contentStrategyProposal.findFirst({ where: { clientId: dora.clientId, kind: "PROFILE" } });
    const rec = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: doraCall } });
    c.ok("NEW: ANALYZE succeeded, the call is ANALYZED", r.ok && rec.transcriptState === "ANALYZED", JSON.stringify(r).slice(0, 200));
    c.ok("0 months created or changed, 0 selections", (await prisma.contentMonth.count()) === monthsBefore && (await prisma.contentTopicSelection.count({ where: { enrollmentId: dora.enrollmentId } })) === 0);
    c.ok("the call's topics are PROPOSED bank ideas with no month, source discovery_call", topics.length === 2 && topics.every((t) => t.monthId === null && t.approvalState === "PROPOSED" && t.source === "discovery_call"), topics.map((t) => `${t.title}:${t.monthId}:${t.source}`).join(" | "));
    // §6.3 (batch-2 review): new generated bank items wait for staff approval
    // before a client sees them. The visibility rule named only strategy_call
    // and ai, so this new source reached the client's bank, counted as usable
    // stock and could be recommended — unapproved, with the model's wording.
    {
      const { clientCanSeeTopic, isUsableStock, recommendationsForMonth } = await import("@/lib/contentTopics");
      const { portalTopics } = await import("@/lib/portal");
      const oldTopics = (await import(base.contentTopics)) as typeof import("@/lib/contentTopics");
      c.ok(`OLD (${BASE}'s visibility rule, which this batch kept): an unapproved discovery_call topic counted as visible`, topics.every((t) => oldTopics.clientCanSeeTopic(t, false)));
      const shownIds = async () => (await portalTopics({ id: dora.enrollmentId, clientId: dora.clientId })).groups.flatMap((g) => g.topics).map((t) => t.id);
      const shown = await shownIds();
      c.ok("NEW: they are NOT in the client's bank, not usable stock", topics.every((t) => !shown.includes(t.id) && !clientCanSeeTopic(t, false) && !isUsableStock(t)), shown.join(","));
      const dm = await prisma.contentMonth.create({ data: { enrollmentId: dora.enrollmentId, clientId: dora.clientId, monthKey: "2026-11", videosOwed: 4, status: "OPEN" } });
      const run = await prisma.contentTopicRefreshRun.create({ data: { enrollmentId: dora.enrollmentId, clientId: dora.clientId, kind: "RECOMMENDATION", monthId: dm.id, status: "SUCCEEDED", requestedBy: "drill" } });
      for (const [i, t] of topics.entries()) await prisma.contentTopicSuggestion.create({ data: { refreshRunId: run.id, enrollmentId: dora.enrollmentId, clientId: dora.clientId, kind: "RECOMMENDED", rank: i + 1, title: t.title, relatedTopicId: t.id } });
      const recs = await recommendationsForMonth(dora.enrollmentId, dm.id);
      c.ok("…and never recommended, even when a ranking names them", recs.recommended.length === 0 && recs.alternatives.length === 0, JSON.stringify(recs.recommended.map((r) => r.topicId)));
      await prisma.contentTopic.update({ where: { id: topics[0].id }, data: { approvalState: "APPROVED", approvedBy: "jordan@realtourpilot.com", approvedAt: new Date() } });
      const recs2 = await recommendationsForMonth(dora.enrollmentId, dm.id);
      c.ok("once staff approve one, it reaches the bank and the recommendations (the other stays held)", (await shownIds()).includes(topics[0].id) && !(await shownIds()).includes(topics[1].id) && recs2.recommended.map((r) => r.topicId).join() === topics[0].id);
      const panel = fs.readFileSync(path.join(REPO, "src/components/content/TopicsPanel.tsx"), "utf8");
      c.ok("the staff bank's 'hidden from the client until approved' hint reads the same source list", /topicSourceNeedsApproval\(t\.source\)[^\n]*hidden from the client until approved/.test(panel));
    }
    c.ok("a 'this month' fact from discovery is kept PERMANENT, PROPOSED", fact?.scope === "PERMANENT" && fact.status === "PROPOSED" && fact.monthId === null, `${fact?.scope} ${fact?.status}`);
    c.ok("6.2-call-knowledge-proposals (already fixed): the changed preference is a PROFILE proposal with the call as provenance", music?.targetKey === "profile.music" && music.callRecordId === doraCall && music.status === "PROPOSED");
    const res = r.ok ? (r.resultJson as { ignoredPriorities?: number; ignoredTodos?: number }) : {};
    c.ok("no priorities, no to-dos written (counted as ignored)", res.ignoredPriorities === 1 && res.ignoredTodos === 1);

    // Regression: a MONTHLY planning call on the same fixture behaves as before.
    const mona = await client("Mona Monthly");
    const monaCall = await calls.createManualCallRecord({ clientId: mona.clientId, callType: "MONTHLY_STRATEGY", scheduledStart: new Date("2026-09-10T14:00:00Z"), targetMonthKey: "2026-10", by: "drill" });
    await calls.attachPastedTranscript(monaCall, PLAIN_TRANSCRIPT, "drill-staff");
    await tj.cancelTranscriptJobs(monaCall, "drill: run by hand");
    const r2 = await gen.runTranscriptJob({ id: "m", kind: "ANALYZE", callRecordId: monaCall, requestedBy: "drill-staff" });
    const mMonth = await prisma.contentMonth.findFirst({ where: { enrollmentId: mona.enrollmentId, monthKey: "2026-10" } });
    const mSel = await prisma.contentTopicSelection.count({ where: { monthId: mMonth?.id ?? "-" , status: "PROPOSED" } });
    c.ok("MONTHLY call (regression): PROPOSED selection on the planned month, priorities and to-dos land on it", r2.ok && mSel === 1 && (mMonth?.prioritiesJson ?? "").includes("spring market") && (mMonth?.notes ?? "").includes("Send logo files"), `sel=${mSel}`);
  }

  // =========================================================================
  c.head("3 · A04 — the legacy name-matching sweeps are retired, not conditional");
  // =========================================================================
  {
    const mike = await client("Mike Ciunci");
    const month = await prisma.contentMonth.create({ data: { enrollmentId: mike.enrollmentId, clientId: mike.clientId, monthKey: "2026-09", videosOwed: 4 }, select: { id: true } });
    // Mike FLATLEY's call — not in the program — titled with a bare first name.
    legacyListing = [{ id: "doc-mike", name: "Mike and Jordan Spackman - 2026/09/20 10:00 EDT - Notes by Gemini", createdTime: "2026-09-20T15:30:00Z" }];
    driveText.set("doc-mike", `Mike Flatley's call. ${"A stranger's business, filed on the wrong client. ".repeat(8)}`);
    c.ok("precondition: 0 enabled Calendly mappings, legacy_call_sweeps has no row", (await prisma.programCalendlyEventMapping.count({ where: { enabled: true } })) === 0 && !(await prisma.programAutomation.findUnique({ where: { key: "legacy_call_sweeps" } })));
    const nd = await legacy.sweepDriveTranscripts();
    const nc = await legacy.syncStrategyCallsFromCalendly();
    const nn = await legacy.sweepNotetakerTranscripts();
    c.ok("NEW: the Drive, Calendly and Notetaker legacy sweeps all return skipped (retired)", [nd, nc, nn].every((x) => "skipped" in x && /retired/.test(x.skipped)), JSON.stringify([nd, nc, nn]));
    c.ok("  …and the 'Mike …' doc is not filed on Mike Ciunci", !(await prisma.contentMonth.findUniqueOrThrow({ where: { id: month.id } })).transcriptText && !exported.includes("doc-mike"));
    const od = await oldLegacy.sweepDriveTranscripts();
    const mAfter = await prisma.contentMonth.findUniqueOrThrow({ where: { id: month.id } });
    c.ok("OLD: with no mapping enabled, the first-name fallback filed a stranger's transcript on Mike Ciunci's month", "ingested" in od && od.ingested === 1 && mAfter.transcriptSource === "drive:doc-mike" && mAfter.strategyCallStatus === "COMPLETED", JSON.stringify(od));
    await setSwitch("legacy_call_sweeps", true);
    const on = await legacy.sweepDriveTranscripts();
    c.ok("with legacy_call_sweeps ON (an owner's explicit act) and no mapping, the old sweep runs again", !("skipped" in on), JSON.stringify(on));

    // An unmapped "30 Minute Strategy Call" by an enrolled client's own address makes no record.
    const pat = await client("Pat Program", { email: "pat@example.com" });
    await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: "https://api.calendly.com/event_types/DISC", eventName: "Brand Discovery Call", purpose: "BRAND_DISCOVERY", enabled: true, publicUrl: "https://calendly.com/realtourpilot-info/brand-discovery-call" } });
    calendlyBookings = [
      { event: { uri: "https://api.calendly.com/scheduled_events/EV-DISC", status: "active", event_type: "https://api.calendly.com/event_types/DISC", start_time: "2026-10-05T14:00:00Z", end_time: "2026-10-05T14:45:00Z" }, invitees: [{ email: "pat@example.com", name: "Pat Program", status: "active", uri: "https://api.calendly.com/invitees/1" }] },
      { event: { uri: "https://api.calendly.com/scheduled_events/EV-30", name: "30 Minute Strategy Call", status: "active", event_type: "https://api.calendly.com/event_types/THIRTY", start_time: "2026-10-06T14:00:00Z", end_time: "2026-10-06T14:30:00Z" }, invitees: [{ email: "pat@example.com", name: "Pat Program", status: "active", uri: "https://api.calendly.com/invitees/2" }] },
    ];
    const sync = await calls.syncCallRecordsFromCalendly({ now: new Date("2026-09-25T15:00:00Z") });
    const thirty = await prisma.programCallRecord.findUnique({ where: { calendlyEventUri: "https://api.calendly.com/scheduled_events/EV-30" } });
    const disc = await prisma.programCallRecord.findUnique({ where: { calendlyEventUri: "https://api.calendly.com/scheduled_events/EV-DISC" } });
    c.ok("existing behaviour: the unmapped 30-minute booking creates no record; the mapped discovery one matches Pat", !thirty && disc?.clientId === pat.clientId && disc.matchState === "MATCHED" && "unrelated" in sync && sync.unrelated === 1, JSON.stringify(sync));
    const sup = await legacy.sweepDriveTranscripts();
    c.ok("with a mapping enabled the legacy sweep stands down even with the switch ON", "skipped" in sup && /superseded/.test(sup.skipped));
    await setSwitch("legacy_call_sweeps", false);
    await prisma.programCalendlyEventMapping.updateMany({ data: { enabled: false } });

    // Gap 2: an identity in question drives no work.
    fixtures.analysis = ANALYSIS();
    // Earlier fixtures' verified discovery calls get their (legitimate) drafts on this tick.
    fixtures.strategy = STRATEGY_OUT();
    await setSwitch("strategy_generation", true);
    await setSwitch("transcript_jobs", true);
    const olive = await client("Olive Oldham");
    const oliveCall = await discovery(olive, { start: new Date("2026-09-15T14:00:00Z"), transcript: PLAIN_TRANSCRIPT });
    await prisma.programCallRecord.update({ where: { id: oliveCall }, data: { matchState: "AMBIGUOUS_CLIENT", transcriptState: "ANALYZED" } });
    await oldOb.advanceOnboarding(olive.enrollmentId, { enqueue: true, requestedBy: "onboarding-cron", now: new Date("2026-09-25T15:00:00Z") });
    c.ok("OLD: advanceOnboarding queued a STRATEGY_DRAFT for a call whose client is in question", (await prisma.programTranscriptJob.count({ where: { callRecordId: oliveCall, kind: "STRATEGY_DRAFT" } })) === 1);

    const ava = await client("Ava Amble");
    const avaCall = await discovery(ava, { start: new Date("2026-09-16T14:00:00Z"), transcript: PLAIN_TRANSCRIPT });
    // The sync's own "identity changed" branch keeps the ids and marks it AMBIGUOUS_CLIENT; this writes that end state.
    await prisma.programCallRecord.update({ where: { id: avaCall }, data: { matchState: "AMBIGUOUS_CLIENT" } });
    await ob.sweepOnboarding({ now: new Date("2026-09-25T15:00:00Z") });
    c.ok("NEW: sweepOnboarding (strategy_generation ON) queues 0 STRATEGY_DRAFT for Ava's ambiguous call", (await prisma.programTranscriptJob.count({ where: { callRecordId: avaCall, kind: "STRATEGY_DRAFT" } })) === 0);
    const analyzeBefore = await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: avaCall, kind: "ANALYZE" } });
    const drv = await tj.driveTranscriptJobs({ max: 20, budgetMs: 60_000, leaseBy: "drill" });
    const analyzeAfter = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: analyzeBefore.id } });
    const oliveDraft = await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: oliveCall, kind: "STRATEGY_DRAFT" } });
    c.ok("Ava's pre-queued ANALYZE stays QUEUED, attempt given back, the reason on the row — no AI run", analyzeAfter.state === "QUEUED" && analyzeAfter.attempts === analyzeBefore.attempts && /waiting: the call's client is in question/.test(analyzeAfter.lastError ?? "") && (await runsOf("call_analysis", ava.enrollmentId)) === 0, `${analyzeAfter.state} ${analyzeAfter.attempts} ${analyzeAfter.lastError}`);
    c.ok("the OLD-queued STRATEGY_DRAFT on Olive's ambiguous call waits the same way (no strategy run)", oliveDraft.state === "QUEUED" && oliveDraft.attempts === 0 && (await runsOf("strategy_draft", olive.enrollmentId)) === 0, `${oliveDraft.state} ${oliveDraft.lastError}`);
    const failedJobs = await prisma.programTranscriptJob.findMany({ where: { lastError: { not: null }, NOT: { lastError: { startsWith: "waiting:" } }, state: { not: "CANCELLED" } }, select: { kind: true, state: true, lastError: true, callRecordId: true } });
    c.ok("a wait is not a failure: the sweep reports it and moves on", "waiting" in drv && (drv.waiting ?? 0) >= 2 && drv.failed === 0 && drv.paused === null, `${JSON.stringify(drv)} ${JSON.stringify(failedJobs)}`);
    await calls.confirmCallRecordClient(avaCall, ava.clientId, "drill");
    await tj.driveTranscriptJobs({ max: 20, budgetMs: 60_000, leaseBy: "drill" });
    const analyzeDone = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: analyzeBefore.id } });
    c.ok("confirmCallRecordClient → the ANALYZE runs on the next tick and SUCCEEDS", analyzeDone.state === "SUCCEEDED" && (await runsOf("call_analysis", ava.enrollmentId)) === 1, `${analyzeDone.state} ${analyzeDone.lastError}`);
    await setSwitch("strategy_generation", false);
  }

  // =========================================================================
  c.head("4 · A09 — the strategy draft waits for the call's analysis");
  // =========================================================================
  {
    fixtures.analysis = ANALYSIS();
    fixtures.strategy = STRATEGY_OUT();
    const wes = await client("Wes Waits");
    const wesCall = await discovery(wes, { start: new Date("2026-09-17T14:00:00Z"), transcript: PLAIN_TRANSCRIPT });
    const analyze = await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: wesCall, kind: "ANALYZE" } });
    await prisma.programTranscriptJob.update({ where: { id: analyze.id }, data: { nextAttemptAt: new Date(Date.now() + 3600_000) } }); // in backoff
    await ob.advanceOnboarding(wes.enrollmentId, { enqueue: true, requestedBy: "onboarding-cron", now: new Date("2026-09-25T15:00:00Z") });
    const draftJob = await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: wesCall, kind: "STRATEGY_DRAFT" } });
    await tj.driveTranscriptJobs({ max: 20, budgetMs: 60_000, leaseBy: "drill" });
    const d1 = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: draftJob.id } });
    c.ok("STRATEGY_DRAFT stays QUEUED, attempts unchanged, while ANALYZE is still queued", d1.state === "QUEUED" && d1.attempts === 0 && /waiting for the call's analysis/.test(d1.lastError ?? "") && (await runsOf("strategy_draft", wes.enrollmentId)) === 0, `${d1.state} ${d1.lastError}`);
    await prisma.programTranscriptJob.update({ where: { id: analyze.id }, data: { nextAttemptAt: null } });
    await tj.driveTranscriptJobs({ max: 20, budgetMs: 60_000, leaseBy: "drill" });
    c.ok("ANALYZE runs", (await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: analyze.id } })).state === "SUCCEEDED");
    await tj.driveTranscriptJobs({ max: 20, budgetMs: 60_000, leaseBy: "drill", now: new Date(Date.now() + 15 * 60_000) });
    const d2 = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: draftJob.id } });
    c.ok("…then the STRATEGY_DRAFT runs once and a DRAFT version exists", d2.state === "SUCCEEDED" && (await runsOf("strategy_draft", wes.enrollmentId)) === 1 && (await prisma.contentStrategyVersion.count({ where: { enrollmentId: wes.enrollmentId, status: "DRAFT" } })) === 1, `${d2.state} ${d2.lastError}`);
    await setSwitch("transcript_jobs", false);
  }

  // =========================================================================
  c.head("5 · A08 + A09 — the first draft: house format, no leak, by a click");
  // =========================================================================
  fixtures.strategy = STRATEGY_OUT();
  const nadia = await client("Nadia Brooks");
  // The actions run as the drill's session-less "dev@local"; the STRATEGY duty
  // for this client is handed to that person (Jordan's own override card).
  await setOwnerOverride("ENROLLMENT", nadia.enrollmentId, "STRATEGY", strategist.id, "drill");
  // 11:30 pm ET on Dec 31 2025 is already Jan 1 2026 in UTC.
  const nadiaCall = await discovery(nadia, { start: new Date("2026-01-01T04:30:00Z"), transcript: DISCOVERY_TRANSCRIPT, cancelJobs: true });
  let v1 = "";
  {
    const otherOld = await client("Olivia Oldpath");
    const before = modelCalls.length;
    const old = await oldGen.draftStrategyFromTranscript({ enrollmentId: otherOld.enrollmentId, clientId: otherOld.clientId, transcript: DISCOVERY_TRANSCRIPT, callRecordId: null, requestedBy: "drill", unattended: false });
    const oldPrompt = modelCalls.slice(before).find((m) => m.kind === "strategy")?.prompt ?? "";
    const oldRaw = (await version(old.versionId)).rawText ?? "";
    c.ok("OLD: the raw transcript reached the client-facing strategy prompt (broker, split, another client)", /broker is leaving/.test(oldPrompt) && /80\/20/.test(oldPrompt) && /Harriet Vance/.test(oldPrompt));
    c.ok("OLD: every AI draft said \"(framework: policy default …)\" and took the server's UTC year", /\(framework: policy default/.test(oldRaw) && oldRaw.includes(`${new Date().getUTCFullYear()} Social Content Strategy`));

    await setSwitch("strategy_generation", false);
    const mark = modelCalls.length;
    const r = await actions.draftStrategyFromDiscovery(nadia.enrollmentId);
    const prompt = modelCalls.slice(mark).find((m) => m.kind === "strategy");
    const v = await prisma.contentStrategyVersion.findFirstOrThrow({ where: { enrollmentId: nadia.enrollmentId }, orderBy: { versionNo: "desc" } });
    v1 = v.id;
    const run = await prisma.programAiRun.findFirstOrThrow({ where: { kind: "strategy_draft", enrollmentId: nadia.enrollmentId } });
    const refs = JSON.parse(run.inputRefsJson ?? "{}") as { stripped?: number; strippedBy?: Record<string, number> };
    c.ok("the staff click drafts with strategy_generation OFF — a DRAFT from the discovery call", r.ok && v.status === "DRAFT" && v.sourceKind === "discovery_call" && v.callRecordId === nadiaCall, r.message);
    c.ok("…and rings ONE owner bell for it", (await prisma.notification.count({ where: { kind: "strategy_draft_ready", dedupeKey: { startsWith: `strategy-draft:${v.id}` } } })) === 1);
    c.ok("A09: the strategy prompt carries none of the three (said in confidence, marked mid-line, another client)", !!prompt && !/broker is leaving/.test(prompt.prompt) && !/80\/20|CONFIDENTIAL\]/.test(prompt.prompt) && !/Harriet/.test(prompt.prompt) && /explain everything twice/.test(prompt.prompt));
    c.ok("A09: inputRefs.stripped is 3 (phrase 1, marker 1, other client 1)", refs.stripped === 3 && refs.strippedBy?.phrase === 1 && refs.strippedBy?.marker === 1 && refs.strippedBy?.otherClient === 1, JSON.stringify(refs.strippedBy));
    c.ok("A09: the prompt carries the confidentiality rule", /CONFIDENTIALITY \(mandatory/.test(prompt?.system ?? ""));
    c.ok("the message says the analysis has not run, so only marked lines were held back", /analysis hasn't run yet/.test(r.message));

    const raw = v.rawText ?? "";
    const parsed = policy.parseStrategyDocument(raw);
    const ref = manifest.readManifestEntries(fs.readFileSync(path.join(REPO, "docs", "strategy-reference-manifest.md"), "utf8")).find((e) => e.file === "Arielle Roemer Team 2026 Content Strategy - Final.pdf");
    c.ok("the committed reference manifest has the Arielle entry", !!ref && ref.structureVersion === "S3");
    c.ok("A08: sections equal Arielle's, in order", JSON.stringify(parsed.sections.map((s) => s.heading)) === JSON.stringify(ref?.sections), parsed.sections.map((s) => s.heading).join(" → "));
    c.ok("A08: sub-headings equal Arielle's (audience, 4 pillars, the 5 framework parts, captions, direction)", JSON.stringify(manifest.subheadingsOf(parsed)) === JSON.stringify(ref?.subheadings), manifest.subheadingsOf(parsed).join(" → "));
    c.ok("A08: field labels equal Arielle's", JSON.stringify(manifest.labelsOf(parsed)) === JSON.stringify(ref?.fieldLabels), manifest.labelsOf(parsed).join(", "));
    const val = policy.validateStrategyStructure(parsed);
    c.ok("A08: S3, no required template item missing", val.structureVersion === "S3" && !val.findings.some((f) => f.severity === "warn"), val.findings.map((f) => f.code).join(","));
    c.ok("A08: no \"(framework: policy default\" annotation", !/\(framework: policy default/.test(raw));
    c.ok("A08: the year is the New York year of the discovery call (2025), not UTC's (2026)", raw.includes("2025 Social Content Strategy"));
    c.ok("the gap list is kept for Jordan, as its own section", (await sectionsOf(v1)).some((s) => s.id === "gaps"));

    // The manifest is deterministic and matches the files on this machine.
    const dl = path.join(os.homedir(), "Downloads");
    if (fs.existsSync(path.join(dl, manifest.REFERENCE_FILES[0].file))) {
      const a = await manifest.manifestEntries(dl), b = await manifest.manifestEntries(dl);
      const ta = manifest.renderManifest(a.entries, a.missing), tb = manifest.renderManifest(b.entries, b.missing);
      c.ok("the manifest script is deterministic and matches the committed manifest", ta === tb && ta === fs.readFileSync(path.join(REPO, "docs", "strategy-reference-manifest.md"), "utf8"));
    } else c.ok("(reference files absent on this machine — determinism not re-checked)", true);
  }

  // =========================================================================
  c.head("6 · A08 — a small manual edit never regenerates the strategy");
  // =========================================================================
  let v2 = "";
  {
    const runsBefore = await prisma.programAiRun.count({ where: { enrollmentId: nadia.enrollmentId } });
    const before = await sectionsOf(v1);
    const bo = before.find((s) => s.id === "brand-overview")!;
    const r = await actions.editStrategySection(v1, "brand-overview", bo.text.replace("Warm, calm, direct", "Warm, calm, direct, a little funny"));
    const v = await prisma.contentStrategyVersion.findFirstOrThrow({ where: { enrollmentId: nadia.enrollmentId }, orderBy: { versionNo: "desc" } });
    v2 = v.id;
    const after = await sectionsOf(v2);
    c.ok("a new version based on v1, sourceKind manual, INTERNAL_REVIEW", r.ok && v.basedOnVersionId === v1 && v.sourceKind === "manual" && v.status === "INTERNAL_REVIEW", r.message);
    c.ok("0 new AI runs", (await prisma.programAiRun.count({ where: { enrollmentId: nadia.enrollmentId } })) === runsBefore);
    c.ok("only Brand Overview changed; every other section byte-identical (id, order, heading, text)", after.length === before.length && after.every((s, i) => (s.id === "brand-overview" ? s.text !== before[i].text : JSON.stringify(s) === JSON.stringify(before[i]))));
    c.ok("v1 is kept, marked replaced (SUPERSEDED, never approved)", (await version(v1)).status === "SUPERSEDED" && (await version(v1)).approvedAt === null);
    const doc2 = cs.parseStoredSections(v.sectionsJson)?.document;
    c.ok("the edited version keeps its title block and structured read (client, year, subtitle)", (v.rawText ?? "").startsWith("Nadia Brooks\n2025 Social Content Strategy") && doc2?.clientName === "Nadia Brooks" && doc2?.year === 2025 && !!doc2?.subtitle && /a little funny/.test(doc2?.brandOverview.brandVoice ?? ""), `${(v.rawText ?? "").slice(0, 60)} | ${doc2?.clientName} ${doc2?.year} ${doc2?.brandOverview.brandVoice}`);
    const again = await actions.editStrategySection(v1, "brand-overview", "anything");
    c.ok("a stale second tab editing v1 is refused, not forked", !again.ok && /newest version/.test(again.message), again.message);

    await setSwitch("strategy_generation", true);
    await ob.sweepOnboarding({ now: new Date("2026-09-25T14:00:00Z") });
    const o0 = await prisma.programOnboarding.findUniqueOrThrow({ where: { enrollmentId: nadia.enrollmentId } });
    await oldOb.advanceOnboarding(nadia.enrollmentId, { enqueue: true, requestedBy: "onboarding-cron", now: new Date("2026-09-25T14:30:00Z") });
    c.ok("OLD: the next sweep pointed the onboarding back at the AI draft v1", o0.strategyDraftVersionId === v2 && (await prisma.programOnboarding.findUniqueOrThrow({ where: { enrollmentId: nadia.enrollmentId } })).strategyDraftVersionId === v1);
    await ob.sweepOnboarding({ now: new Date("2026-09-25T15:00:00Z") });
    const o1 = await prisma.programOnboarding.findUniqueOrThrow({ where: { enrollmentId: nadia.enrollmentId } });
    await ob.sweepOnboarding({ now: new Date("2026-09-25T16:00:00Z") });
    const o2 = await prisma.programOnboarding.findUniqueOrThrow({ where: { enrollmentId: nadia.enrollmentId } });
    c.ok("NEW: the draft in review is the edited version, and stays so after a second sweep", o1.strategyDraftVersionId === v2 && o2.strategyDraftVersionId === v2, `${o1.strategyDraftVersionId} ${o2.strategyDraftVersionId}`);
    c.ok("…and 0 STRATEGY_DRAFT jobs were queued for the call", (await prisma.programTranscriptJob.count({ where: { callRecordId: nadiaCall, kind: "STRATEGY_DRAFT" } })) === 0);
    await setSwitch("strategy_generation", false);
  }

  // =========================================================================
  c.head("7 · A08 — revise with feedback: one run, only the named section changes");
  // =========================================================================
  let v3 = "";
  {
    const pid = await cs.createStrategyProposal({ enrollmentId: nadia.enrollmentId, kind: "STRATEGY", summary: "Please add a monthly newsletter goal", sourceKind: "client" });
    fixtures.revise = { changes: [{ sectionId: "content-goals", text: "• Two listing leads a month from video\n• Grow to 3,000 local followers\n• Be recognised at open houses\n• Post four videos a month\n• Launch a monthly newsletter" }], summary: "Added the newsletter goal", unaddressed: [] };
    const base = await sectionsOf(v2);
    const r = await actions.reviseStrategy(v2, "Fold in her newsletter idea.", [pid]);
    const v = await prisma.contentStrategyVersion.findFirstOrThrow({ where: { enrollmentId: nadia.enrollmentId }, orderBy: { versionNo: "desc" } });
    v3 = v.id;
    const after = await sectionsOf(v3);
    const p = await prisma.contentStrategyProposal.findUniqueOrThrow({ where: { id: pid } });
    c.ok("exactly 1 strategy_revise run, attended (a person pressed it)", (await runsOf("strategy_revise", nadia.enrollmentId)) === 1 && r.ok, r.message);
    c.ok("only Content Goals differs from the base", after.every((s, i) => (s.id === "content-goals" ? /newsletter/.test(s.text) : JSON.stringify(s) === JSON.stringify(base[i]))));
    c.ok("the client's suggestion is ACCEPTED, pointing at the new version", p.status === "ACCEPTED" && p.resultVersionId === v3);
    const again = await actions.reviseStrategy(v2, "Fold in her newsletter idea.", [pid]);
    c.ok("a double click: still 1 run, no new version", (await runsOf("strategy_revise", nadia.enrollmentId)) === 1 && (await prisma.contentStrategyVersion.count({ where: { enrollmentId: nadia.enrollmentId } })) === 3 && !again.ok, again.message);
    // On the version IN FORCE a revision is a new version beside it; the same request twice is one run.
    await actions.approveStrategy(v3);
    const bo = (await sectionsOf(v3)).find((s) => s.id === "brand-overview")!;
    fixtures.revise = { changes: [{ sectionId: "brand-overview", text: bo.text.replace("The West Chester move-up specialist", "West Chester's calm move-up specialist") }], summary: "Warmer brand message", unaddressed: [] };
    const a1 = await actions.reviseStrategy(v3, "Make the brand message warmer.", []);
    const a2 = await actions.reviseStrategy(v3, "Make the brand message warmer.", []);
    c.ok("revising the approved version: it stays in force, the revision is a new version for approval", a1.ok && (await version(v3)).status === "APPROVED", a1.message);
    c.ok("the same request twice → the first result, no second paid run", a2.ok && /Already revised/.test(a2.message) && (await runsOf("strategy_revise", nadia.enrollmentId)) === 2, a2.message);
  }

  // =========================================================================
  c.head("8 · A08/A09 — release guards, the portal, and the strategy-ready notice");
  // =========================================================================
  {
    const latest = async () => (await prisma.contentStrategyVersion.findFirstOrThrow({ where: { enrollmentId: nadia.enrollmentId }, orderBy: { versionNo: "desc" } })).id;
    const newest = await latest();
    await actions.approveStrategy(newest);
    const refused = await actions.releaseStrategy(newest);
    c.ok("release is refused while the 'Gaps the draft could not fill' section is in the version", !refused.ok && /Gaps the draft could not fill/.test(refused.message), refused.message);
    const rm = await actions.editStrategySection(newest, "gaps", null);
    const clean = await latest();
    c.ok("removing it is one click: a new version without it, the rest kept", rm.ok && !(await sectionsOf(clean)).some((s) => s.id === "gaps") && (await version(newest)).status === "APPROVED", rm.message);
    await actions.approveStrategy(clean);

    await setSwitch("script_share_email", false);
    const off = await actions.releaseStrategy(clean);
    c.ok("released with script_share_email OFF: 0 notices, and the message says suppressed", off.ok && /suppressed/i.test(off.message) && (await prisma.programReminder.count({ where: { enrollmentId: nadia.enrollmentId, action: "STRATEGY_READY" } })) === 0, off.message);
    await setSwitch("script_share_email", true);
    const on1 = await actions.releaseStrategy(clean);
    const on2 = await actions.releaseStrategy(clean);
    c.ok("with it ON: exactly ONE STRATEGY_READY notice for the version, however often it is pressed", on1.ok && on2.ok && (await prisma.programReminder.count({ where: { enrollmentId: nadia.enrollmentId, action: "STRATEGY_READY" } })) === 1, `${on1.message} | ${on2.message}`);
    const ps = await portalStrategy({ id: nadia.enrollmentId, clientId: nadia.clientId });
    c.ok("the portal shows the released version without the framework, captions or the team's notes", !!ps && !ps.sections.some((s) => s.id === "gaps" || /framework|caption/i.test(s.heading)) && ps.sections.some((s) => s.id === "content-goals"), ps?.sections.map((s) => s.heading).join(" | "));

    // A confidential fact repeated in a section blocks the release, naming the section.
    await facts.createFact({ clientId: nadia.clientId, enrollmentId: nadia.enrollmentId, category: "DECISION", body: "Her broker is leaving the firm at the end of the year", source: "call", confidential: true });
    const dir = (await sectionsOf(clean)).find((s) => s.id === "video-structure-framework")!;
    await actions.editStrategySection(clean, "video-structure-framework", `${dir.text}\nHer broker is leaving the firm at the end of the year, so the brand stands on its own.`);
    const leaky = await latest();
    await actions.approveStrategy(leaky);
    const r2 = await actions.releaseStrategy(leaky);
    c.ok("release is refused when a section repeats a confidential fact — the section is named", !r2.ok && /Video Structure Framework" section repeats something marked confidential/.test(r2.message), r2.message);

    // A legacy "Accepted proposal" section: refused by the release; dropped by the portal even if released the OLD way.
    const pid = await cs.createStrategyProposal({ enrollmentId: nadia.enrollmentId, kind: "POSITIONING", summary: "Lean into relocation buyers", sourceKind: "call" });
    const acc = await cs.acceptStrategyProposal(pid, "jordan@realtourpilot.com");
    await actions.approveStrategy(acc.versionId!);
    const r3 = await actions.releaseStrategy(acc.versionId!);
    c.ok("an appended 'Accepted proposal' section blocks the release", !r3.ok && /Accepted proposal/.test(r3.message), r3.message);
    await oldCs.releaseStrategyVersion(acc.versionId!, "old-path");
    const ps2 = await portalStrategy({ id: nadia.enrollmentId, clientId: nadia.clientId });
    c.ok("OLD release let it through; the portal (second guard) still drops the proposal-* section", !!ps2 && ps2.versionNo === (await version(acc.versionId!)).versionNo && !ps2.sections.some((s) => s.id.startsWith("proposal-")));

    // The notice itself.
    const pinned = new Date("2026-10-06T15:00:00Z"); // Tuesday 11:00 am ET
    const nova = await client("Nova Notice TEST", { seatEmail: "info@realtourpilot.com", token: true });
    const imp = await cs.importStrategyVersion({ enrollmentId: nova.enrollmentId, text: (await version(clean)).rawText ?? "", fileName: "nova.docx", createdBy: "drill" });
    await cs.approveStrategyVersion(imp.versionId, "jordan@realtourpilot.com");
    await ob.releaseStrategyToPortal(imp.versionId, "jordan@realtourpilot.com");
    const drain = await share.drainShareNotices({ now: pinned });
    const sent = gmailSent.at(-1);
    const realNotice = await prisma.programReminder.findFirstOrThrow({ where: { enrollmentId: nadia.enrollmentId, action: "STRATEGY_READY" } });
    c.ok("the real client's notice is SUPPRESSED launch_not_authorised (testClientsOnly holds)", realNotice.state === "SUPPRESSED" && realNotice.suppressionReason === "launch_not_authorised", JSON.stringify(drain.notes));
    c.ok("the TEST client's goes to the verified test inbox only", !!sent && sent.to === "info@realtourpilot.com" && gmailSent.length === 1, JSON.stringify(drain.notes));
    c.ok("subject: 'Your Content Strategy is Ready + Next Steps'", sent?.subject === "Your Content Strategy is Ready + Next Steps" && subjectFor("strategy_ready") === "Your Content Strategy is Ready + Next Steps");
    const body = sent?.body ?? "";
    c.ok("three steps: read it (portal link on this app's origin), book the first call, add the brand setup", /1\. Read your strategy: https:\/\/drill\.invalid\//.test(body) && /2\. Book your first strategy call, where we plan your first month of videos together: https:\/\/\S+$/m.test(body) && /3\. Add your .*logo.*headshot/.test(body), body);
    c.ok("plain words: no em dash, no money, no internal jargon", !/—|\$|allowance|IN\/OVERFLOW|sourceKind|policy/i.test(body));
    await prisma.programCallRecord.create({ data: { enrollmentId: nova.enrollmentId, clientId: nova.clientId, callType: "MONTHLY_STRATEGY", status: "SCHEDULED", matchState: "MATCHED", scheduledStart: new Date("2026-10-13T18:00:00Z") } });
    const vars = await share.strategyReadyVars(nova.enrollmentId, nova.clientId, pinned);
    const twoSteps = rt.renderReminder(rt.reminderTemplate("strategy_ready.v2"), { firstName: "Nova", month: "October", portalLink: "https://drill.invalid/portal/x?tab=strategy", bookCallLink: null, noCallEligible: false, answersStarted: false, sessionNote: null, earliestSession: null, itemCount: 0, titles: [], updatedTitles: [], deadline: null, firstCallAtET: vars.firstCallAtET, callLink: vars.callLink, setupMissing: [] });
    c.ok("a booked call is read at send time and named in ET", vars.firstCallAtET === "Tuesday, October 13 at 2:00 PM ET" && vars.callLink === null, JSON.stringify(vars));
    c.ok("call booked + setup complete: two steps, no booking link", /2\. Your first strategy call is booked for Tuesday, October 13 at 2:00 PM ET/.test(twoSteps) && !/\n3\. /.test(twoSteps) && !/Book your first/.test(twoSteps));
    c.ok("the default STRATEGY_READY template is v2; v1 is kept", rt.DEFAULT_TEMPLATE_IDS.STRATEGY_READY === "strategy_ready.v2" && !!rt.REMINDER_TEMPLATES["strategy_ready.v1"]);
    // Batch-2 review: the subject is v2's for EVERY notice, and a saved
    // reminders policy holds a full copy of the template map from the day it
    // was saved — so v1's body could go out under v2's "+ Next Steps" subject.
    c.ok("a saved policy still naming strategy_ready.v1 resolves to v2 (v1 is retired for sending)", rt.templateForAction("STRATEGY_READY", { STRATEGY_READY: "strategy_ready.v1" }).id === "strategy_ready.v2" && rt.sendableTemplateId("strategy_ready.v1") === "strategy_ready.v2");
    {
      const vera = await client("Vera Veeone TEST", { seatEmail: "info+vera@realtourpilot.com", token: true });
      const impV = await cs.importStrategyVersion({ enrollmentId: vera.enrollmentId, text: (await version(clean)).rawText ?? "", fileName: "vera.docx", createdBy: "drill" });
      await cs.approveStrategyVersion(impV.versionId, "jordan@realtourpilot.com");
      await ob.releaseStrategyToPortal(impV.versionId, "jordan@realtourpilot.com");
      const vRow = await prisma.programReminder.findFirstOrThrow({ where: { enrollmentId: vera.enrollmentId, action: "STRATEGY_READY" } });
      // A notice queued BEFORE v2 existed carries v1's stamp.
      await prisma.programReminder.update({ where: { id: vRow.id }, data: { templateKey: "strategy_ready.v1", templateVersion: "1" } });
      const sentN = gmailSent.length;
      await share.drainShareNotices({ now: pinned });
      const vSent = gmailSent.at(-1);
      const vAfter = await prisma.programReminder.findUniqueOrThrow({ where: { id: vRow.id } });
      c.ok("a notice stamped v1 goes out with v2's body under v2's subject, and its row now names v2", gmailSent.length === sentN + 1 && vSent?.subject === "Your Content Strategy is Ready + Next Steps" && /Here's what's next:/.test(vSent.body) && vAfter.templateKey === "strategy_ready.v2" && vAfter.templateVersion === "2", `${vAfter.templateKey} ${vSent?.subject}`);
    }
    const upd = await share.strategyReadyVars(nadia.enrollmentId, nadia.clientId, pinned, acc.versionId);
    const updBody = rt.renderReminder(rt.reminderTemplate("strategy_ready.v2"), { firstName: "Nadia", month: "October", portalLink: "https://drill.invalid/portal/x", bookCallLink: null, noCallEligible: false, answersStarted: false, sessionNote: null, earliestSession: null, itemCount: 0, titles: [], updatedTitles: [], deadline: null, ...upd });
    c.ok("an UPDATED strategy (an earlier version was released) says so, and asks for no 'first strategy call'", upd.strategyUpdate === true && /has been updated/.test(updBody) && !/first strategy call/.test(updBody), updBody.split("\n").slice(2, 8).join(" / "));
  }

  // =========================================================================
  c.head("9 · A09 gap b — 'said in confidence' after the fact");
  // =========================================================================
  {
    const f = await buildContentMonth(prisma, { name: "Faye Facts TEST", topics: [{ title: "Pricing in a shifting market", selection: "SELECTED", excerpts: ["Honestly the market has me planning to open my own team office in March"] }] });
    const topicId = f.topicIds[0];
    c.ok("precondition: the excerpt reaches prompts and suggested answers", (await safeTopicExcerpts(topicId, f.monthId, f.clientId)).kept.length === 1);
    const fact = await facts.createFact({ clientId: f.clientId, enrollmentId: f.enrollmentId, category: "DECISION", body: "Planning to open her own team office in March", source: "call" });
    await facts.rejectFact(fact.id, "jordan@realtourpilot.com");
    c.ok("OLD gap: REJECTING the mis-classified fact changed nothing — the line still flows", (await safeTopicExcerpts(topicId, f.monthId, f.clientId)).kept.length === 1);
    await prisma.appSetting.create({ data: { key: `portal-prefill-${f.enrollmentId}`, value: "{}" } });
    const pid = await cs.createStrategyProposal({ enrollmentId: f.enrollmentId, kind: "PROFILE", summary: "Mention the new office", sourceKind: "call", factId: fact.id, targetKey: "profile.style", diff: [{ path: "profile.style", from: null, to: "New office" }] });
    const r = await actions.factConfidential(fact.id);
    const row = await prisma.clientFact.findUniqueOrThrow({ where: { id: fact.id } });
    const p = await prisma.contentStrategyProposal.findUniqueOrThrow({ where: { id: pid } });
    c.ok("'Said in confidence' marks it confidential and DENIED as AI context", r.ok && row.confidential && row.aiContext === "DENIED", r.message);
    c.ok("the matching excerpt no longer reaches prompts or suggested answers", (await safeTopicExcerpts(topicId, f.monthId, f.clientId)).kept.length === 0);
    c.ok("the portal prefill is dropped (rebuilt without it)", !(await prisma.appSetting.findUnique({ where: { key: `portal-prefill-${f.enrollmentId}` } })));
    c.ok("the open proposal made from it is REJECTED ('source marked confidential')", p.status === "REJECTED" && p.resolutionNote === "source marked confidential");
    const excerpts2 = await buildContentMonth(prisma, { name: "Phil Phrases TEST", topics: [{ title: "Open house etiquette", selection: "SELECTED", excerpts: ["Between you and me, the seller is about to drop the price", "Buyers always open the fridge first"] }] });
    const kept = await safeTopicExcerpts(excerpts2.topicIds[0], excerpts2.monthId, excerpts2.clientId);
    c.ok("a line that SAYS it is private never reaches a prompt either", kept.kept.length === 1 && /fridge/.test(kept.kept[0].text));
  }

  // =========================================================================
  c.head("10 · U01 (strategy) — one structured renderer, not a word lost");
  // =========================================================================
  {
    const secs = await sectionsOf(v3);
    const pillars = view.strategyBlocks(secs.find((s) => s.id === "content-pillars")!.text);
    const cards = pillars.filter((b) => b.kind === "card");
    c.ok("Content Pillars: one card per pillar, each with Purpose / Focus Areas as labelled rows", cards.length === 4 && cards.every((b) => b.kind === "card" && b.blocks.some((x) => x.kind === "fields" && x.rows.some((r) => r.label === "Purpose") && x.rows.some((r) => r.label === "Focus Areas"))), JSON.stringify(cards.map((b) => (b.kind === "card" ? b.title : ""))));
    const goals = view.strategyBlocks(secs.find((s) => s.id === "content-goals")!.text);
    c.ok("Content Goals: a real list", goals.length === 1 && goals[0].kind === "list" && goals[0].items.length === 5);
    const bo = view.strategyBlocks(secs.find((s) => s.id === "brand-overview")!.text);
    c.ok("Brand Overview: labelled rows, 'Target Audience' a sub-heading", bo.some((b) => b.kind === "fields" && b.rows.some((r) => r.label === "Core Values")) && bo.some((b) => b.kind === "subheading" && b.text === "Target Audience"));
    const fw = view.strategyBlocks(secs.find((s) => s.id === "video-structure-framework")!.text);
    c.ok("Framework: Hook, the three talking points, the close, captions and direction are sub-headings", ["Hook", "Talking Point 1 - Rehook", "Talking Point 2 - Build Up", "Talking Point 3 - Payoff", "Close / Call to Action", "Caption CTA Examples", "Strategic Direction"].every((h) => fw.some((b) => b.kind === "subheading" && b.text === h)));
    const wordGoals = view.sectionBlocks({ id: "content-goals", heading: "2. Content Goals", text: "Two listing leads a month\n\nGrow to 3,000 followers\n\nBe known at open houses" });
    c.ok("Content Goals exported without bullets (a Word file) still render as a list", wordGoals.length === 1 && wordGoals[0].kind === "list" && wordGoals[0].items.length === 3);
    const numbered = view.strategyBlocks("1. First goal\n2. Second goal wraps\nonto a second line\n3. Third");
    c.ok("numbered lines become an ordered list; a wrapped line continues its item", numbered.length === 1 && numbered[0].kind === "list" && numbered[0].ordered && numbered[0].items[1] === "Second goal wraps onto a second line");
    const texts = [...secs.map((s) => s.text), "Brand Voice:\nWarm and\nexpert\n\nPillar 1 Seller Strategy and Listing Positioning\nPurpose: Help sellers\nprice right\nFocus Areas: pricing, staging\n\nA closing paragraph that runs\nacross two lines."];
    const lost = texts.filter((t) => JSON.stringify(readerWords(view.blockWords(view.strategyBlocks(t)).join(" "))) !== JSON.stringify(readerWords(t)));
    c.ok("every word of every section is kept, in order (sections + an S2-style wrapped block)", lost.length === 0, lost.map((t) => t.slice(0, 40)).join(" | "));
  }

  c.ok("fence: nothing left the machine", fence.blocked.length === 0, fence.blocked.join(" | "));
  quiet.restore();
  c.summary();
  await stop();
  fs.rmSync(base.dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
