// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual signed Settings / Strategy calls / Monitoring SSR with isolated fixtures and injected read failures.
// Oct 21 2026 (Jordan; audit D12): the call review queue lives on Strategy
// calls (/content/calls#review) under the desk; Monitoring links there.
// No provider, domain action, invitation, booking or production database is used.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5892), env: { AUTH_ENFORCE: "true" } });
  installNextStubs();
  const fence = fenceFetch();
  const c = makeChecker();
  const load = createRequire(import.meta.url);
  const navigation = load("next/navigation");
  navigation.redirect = (url: string) => { throw new Error(`REDIRECT ${url}`); };
  navigation.useRouter = () => ({ refresh() {} });
  const { prisma } = await import("@/lib/prisma");
  try {
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { default: MonitoringPage } = await import("@/app/content/monitoring/page");
    const { default: CallsPage } = await import("@/app/content/calls/page");
    const { default: SettingsPage } = await import("@/app/settings/page");
    const { CallReviewQueue, attemptCallReviewAction } = await import("@/components/content/CallReviewQueue");
    const { CalendlyMappingsPanel } = await import("@/components/settings/CalendlyMappingsPanel");
    const { loadCalendlyPanelState } = await import("@/app/settings/calendlyActions");
    const { prerender } = await import("react-dom/static");
    const html = async (tree: Parameters<typeof prerender>[0]) => new Response((await prerender(tree)).prelude).text();
    const callsHtml = (body: string) => body.split('id="review"')[1] ?? "";
    const owner = await prisma.appUser.create({ data: { email: "owner@fixture.invalid", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { email: "admin@fixture.invalid", role: "ADMIN", status: "ACTIVE" } });
    const settingsOnly = await prisma.appUser.create({ data: { email: "settings@fixture.invalid", role: "ADMIN", status: "ACTIVE", permissions: JSON.stringify({ content: false, settings: true }) } });
    const editor = await prisma.appUser.create({ data: { email: "editor@fixture.invalid", role: "EDITOR", status: "ACTIVE" } });
    const as = (user: typeof owner) => setSession({ uid: user.id, email: user.email, role: user.role, permissions: user.permissions });
    await as(owner);
    const empty = callsHtml(await html(await CallsPage()));
    c.ok("successful empty reads retain truthful empty queue feedback", empty.includes("Nothing is in the queue.") && empty.includes("No unlinked transcript is waiting in this review queue.") && !empty.includes("could not be read"));

    const client = await prisma.client.create({ data: { name: "Fixture content client", email: "client@fixture.invalid" } });
    const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Fixture", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 1 } });
    const month = await prisma.contentMonth.create({ data: { clientId: client.id, enrollmentId: enrollment.id, monthKey: "2026-10", videosOwed: 2 } });
    const call = await prisma.programCallRecord.create({ data: {
      inviteeName: "Fixture call invitee", inviteeEmail: "unverified@fixture.invalid", callType: "MONTHLY_STRATEGY", matchState: "UNMATCHED_INVITEE", transcriptState: "CANDIDATES", targetMonthKey: "2026-10",
      rawJson: JSON.stringify({ identity: { candidates: [{ clientId: client.id, name: client.name, reason: "fixture possible match" }] } }),
    } });
    await prisma.clientEmailAlias.create({ data: { clientId: client.id, email: "alias@fixture.invalid", source: "fixture" } });
    await prisma.programTranscriptSource.create({ data: { provider: "paste", contentHash: "u5-call-recovery-legacy", title: "Exact legacy transcript title", legacyMonthId: month.id, text: "Exact source text stays unchanged", candidateCallIdsJson: JSON.stringify([{ callRecordId: call.id, score: 63, note: "Fixture ranked candidate" }]) } });
    const snapshot = async () => JSON.stringify(await Promise.all([
      prisma.programCallRecord.findMany(), prisma.programTranscriptSource.findMany(), prisma.clientEmailAlias.findMany(),
      prisma.contentEnrollment.findMany(), prisma.contentMonth.findMany(), prisma.appUser.findMany(), prisma.appSetting.findMany(),
      prisma.programAutomation.findMany(), prisma.programTranscriptJob.findMany(), prisma.auditLog.findMany(),
    ]));
    const before = await snapshot();
    const ready = callsHtml(await html(await CallsPage()));
    c.ok("real readers preserve legacy-month provenance through the call queue", ready.includes("Already filed on a content month by the legacy workflow.") && ready.includes("Its call ownership is still unconfirmed.") && ready.includes("Exact legacy transcript title"));
    c.ok("ranked candidates remain explicit choices without client preselection", ready.includes("Fixture ranked candidate") && ready.includes("fixture possible match") && /<option value="" selected="">pick a client/.test(ready));
    c.ok("operations queue retains manual month entry when existing months are insufficient", ready.includes('<option value="__other__">Another month…</option>'));
    c.ok("all queue buttons provide 44px targets and explicit button type", [...ready.matchAll(/<button\b([^>]*)>/g)].length > 5 && [...ready.matchAll(/<button\b([^>]*)>/g)].every((match) => match[1].includes("min-h-11") && match[1].includes('type="button"')));
    c.ok("matching, month and set-aside inputs have accessible names", ready.includes('aria-label="Client on this call"') && ready.includes('aria-label="Month this call planned"') && ready.includes('aria-label="Reason this is not program work"'));

    const originalCalls = prisma.programCallRecord.findMany;
    prisma.programCallRecord.findMany = (async () => { throw new Error("fixture call read failed"); }) as unknown as typeof originalCalls;
    try {
      const failed = callsHtml(await html(await CallsPage()));
      c.ok("failed call reader shows unknown count and reload, never a clean call queue", failed.includes("Calls waiting for review could not be read.") && failed.includes("Reload queue") && !failed.includes("No call is waiting") && !failed.includes("Nothing is in the queue."));
      c.ok("independent successful alias/transcript reads survive call read failure", failed.includes("alias@fixture.invalid") && failed.includes("Exact legacy transcript title"));
    } finally { prisma.programCallRecord.findMany = originalCalls; }

    const originalAliases = prisma.clientEmailAlias.findMany;
    prisma.clientEmailAlias.findMany = (async () => { throw new Error("fixture review sources failed"); }) as unknown as typeof originalAliases;
    try {
      const failed = callsHtml(await html(await CallsPage()));
      c.ok("failed shared review-source read exposes both unknown sections without empty claims", failed.includes("Email proposals could not be read.") && failed.includes("Transcripts without a confirmed call could not be read.") && !failed.includes("Nothing proposed.") && !failed.includes("No unlinked transcript") && !failed.includes("Nothing is in the queue."));
      c.ok("call evidence remains available during shared review-source failure", failed.includes("Fixture call invitee") && failed.includes('role="alert"'));
    } finally { prisma.clientEmailAlias.findMany = originalAliases; }

    const originalEnrollment = prisma.contentEnrollment.findMany;
    const originalMonths = prisma.contentMonth.findMany;
    prisma.contentEnrollment.findMany = (async () => { throw new Error("fixture enrollment options failed"); }) as unknown as typeof originalEnrollment;
    prisma.contentMonth.findMany = (async () => { throw new Error("fixture month options failed"); }) as unknown as typeof originalMonths;
    try {
      const failed = callsHtml(await html(await CallsPage()));
      c.ok("failed option reads are named without concealing known candidate evidence", failed.includes("The enrolled client list could not be read.") && failed.includes("The available content months could not be read.") && failed.includes("fixture possible match"));
      c.ok("unreadable client and month selectors cannot submit misleading empty options", /<select[^>]*aria-label="Client on this call"[^>]*disabled/.test(failed) && /<select[^>]*aria-label="Month this call planned"[^>]*disabled/.test(failed));
    } finally { prisma.contentEnrollment.findMany = originalEnrollment; prisma.contentMonth.findMany = originalMonths; }

    for (const who of [owner, admin]) {
      await as(who);
      const settings = await html(await SettingsPage({ searchParams: Promise.resolve({}) }));
      c.ok(`${who.role}: Settings directs matching to the one call queue (Strategy calls)`, settings.includes('href="/content/calls#review"') && settings.includes("Open call review queue") && !settings.includes("Call recovery stays here") && !settings.includes(">Confirm client</button>"));
      c.ok(`${who.role}: Strategy calls holds the queue, with signed current-user lookup`, callsHtml(await html(await CallsPage())).includes("Fixture call invitee"));
      const mon = await html(await MonitoringPage());
      c.ok(`${who.role}: Monitoring links to it instead of carrying a second queue`, mon.includes('href="/content/calls#review"') && !mon.includes("Fixture call invitee") && !mon.includes('aria-label="Reason this is not program work"'));
    }
    await as(settingsOnly);
    const settings = await html(await SettingsPage({ searchParams: Promise.resolve({}) }));
    // Oct 27 2026 (Jordan: "One of each"): no second queue on Settings even for an account that cannot open Strategy calls.
    c.ok("settings-only override: the counts and where the one queue is, no second copy of it", settings.includes("Calls and transcripts needing review") && settings.includes("which this account cannot open") && !settings.includes("Call recovery stays here") && !settings.includes(">Confirm client</button>") && !settings.includes("Open call review queue"));
    // requirePageAccess imports next/navigation itself, so its redirect is the
    // real one (a NEXT_REDIRECT error whose digest carries the target), not the
    // patched stub above. Both shapes read as "REDIRECT <target>".
    const redirectOf = (error: unknown) => {
      const digest = (error as { digest?: unknown } | null)?.digest;
      return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;") ? `REDIRECT ${digest.split(";")[2]}` : String(error);
    };
    let denied = "";
    try { await CallsPage(); } catch (error) { denied = redirectOf(error); }
    c.ok("settings-only override cannot open the call queue via its deep link", denied.includes("REDIRECT /"), denied);
    const state = await loadCalendlyPanelState();
    const unlinkedOnly = renderToStaticMarkup(createElement(CalendlyMappingsPanel, { state: { ...state, reviewRecords: [], queue: { ...state.queue, aliases: [] } }, canOpenOperations: false }));
    c.ok("the summary cannot say nothing is waiting while legacy notes need review", /1<!-- --> transcripts without a confirmed call|1 transcripts without a confirmed call/.test(unlinkedOnly) && !unlinkedOnly.includes("Nothing waiting."), unlinkedOnly.match(/Loaded for review:[^<]*(<!-- -->[^<]*)*/)?.[0]);
    await as(editor);
    denied = "";
    try { await CallsPage(); } catch (error) { denied = redirectOf(error); }
    c.ok("editor without a content grant remains refused", denied.includes("REDIRECT /"), denied);
    await clearSession();
    denied = "";
    try { await CallsPage(); } catch (error) { denied = redirectOf(error); }
    c.ok("an anonymous call-queue request is redirected to login", denied.includes("REDIRECT /login?next="), denied);
    denied = "";
    try { await MonitoringPage(); } catch (error) { denied = String(error); }
    c.ok("anonymous monitoring request remains redirected to login", denied.includes("REDIRECT /login?next=/content/monitoring"));

    const unknown = await attemptCallReviewAction(async () => { throw new Error("lost response"); });
    c.ok("thrown action response gives a check-before-retry message without claiming rollback", !unknown.ok && unknown.message.includes("not confirmed") && unknown.message.includes("check its current state") && unknown.message.includes("choices are still here"));
    const refused = { ok: false, message: "Owner access is required." };
    const saved = { ok: true, message: "Exact server receipt." };
    c.ok("server permission failures and successful receipts pass through unchanged", await attemptCallReviewAction(async () => refused) === refused && await attemptCallReviewAction(async () => saved) === saved);
    const unknownQueue = renderToStaticMarkup(createElement(CallReviewQueue, { calls: null, aliases: null, unlinked: null, clients: null, monthKeys: null, isOwner: false }));
    c.ok("all-unreadable first paint never emits an empty success state", !unknownQueue.includes("Nothing is in the queue.") && !unknownQueue.includes("No call is waiting") && (unknownQueue.match(/role="alert"/g) ?? []).length === 5);
    c.ok("all rendered recovery/configuration records and exact transcript content stay byte-identical", await snapshot() === before);
    c.ok("no provider or non-loopback traffic was attempted", fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally {
    await prisma.$disconnect();
    // PGlite socket close handlers run on an immediate after Prisma disconnects.
    // Let those detach before stop() closes the underlying in-memory engine.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fence.restore();
    await drill.stop();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
