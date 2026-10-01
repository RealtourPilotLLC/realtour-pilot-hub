/** Audit §4 launch evidence. SELECT-only, no invitations, syncs or providers.
 * Example: NODE_OPTIONS=--conditions=react-server npx tsx
 * scripts/_recon/launch-inventory.ts --active-candidates --month 2026-10
 * --output /private/tmp/realtour-launch-candidates.json
 * Active candidates are NOT an approved launch audience. Output is private and
 * must stay outside Git. No tokens, emails, script bodies or asset URLs exported.
 */
import fs from "node:fs";
import path from "node:path";
import { pinReadOnlyDatabaseUrl, redactUrls } from "../_lib/dbGuard";

const args = process.argv.slice(2);
const arg = (key: string) => args[args.indexOf(key) + 1];
const month = args.includes("--month") ? arg("--month") : "";
const output = args.includes("--output") ? path.resolve(arg("--output")) : "";
if (!args.includes("--active-candidates") || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !output.startsWith("/private/tmp/")) {
  throw new Error("Use --active-candidates --month YYYY-MM --output /private/tmp/<private-file>.json. This does not select a launch audience.");
}
pinReadOnlyDatabaseUrl();
process.env.DIRECT_URL = process.env.DATABASE_URL;
globalThis.fetch = async () => { throw new Error("Provider access is disabled for the read-only launch inventory."); };

// Free-text titles/errors can contain contact details or signed provider URLs.
// Keep the private report useful without exporting those incidental secrets.
const safeText = (value: string) => redactUrls(value)
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, "[external URL omitted]")
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email omitted]");

async function main() {
  const { prisma } = await import("@/lib/prisma");
  try {
    // Inspect settings with SELECT rather than attempting a production write.
    const guard = await prisma.$queryRaw<{ transaction_read_only: string; default_transaction_read_only: string }[]>`
      SELECT current_setting('transaction_read_only') AS transaction_read_only,
             current_setting('default_transaction_read_only') AS default_transaction_read_only`;
    if (guard[0]?.transaction_read_only !== "on" || guard[0]?.default_transaction_read_only !== "on") throw new Error("Read-only database guard is not active; refusing inventory.");
    const { isSyntheticClientRow } = await import("@/lib/testClients");
    const { programOverview } = await import("@/lib/programOverview");
    const { setupFacts } = await import("@/lib/portalSetup");
    const { libraryRows } = await import("@/lib/portalLayout");
    const { onboardingView } = await import("@/lib/programOnboarding");
    const { portalStrategy, portalTopics, topicOnBank } = await import("@/lib/portal");
    const enrollments = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: {
      id: true, clientId: true, package: true, videosPerMonth: true, sessionsPerMonth: true,
      sessionHours: true, callMode: true, strategyCallRequired: true, noCallEligible: true, accessRevokedAt: true,
    } });
    const clients = await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } });
    const names = new Map(clients.filter((client) => !isSyntheticClientRow(client)).map((client) => [client.id, client.name]));
    const candidates = enrollments.filter((e) => names.has(e.clientId));
    const overview = await programOverview({ monthKey: month, enrollmentIds: candidates.map((e) => e.id), includeTest: false });
    const read = async <T>(fn: () => Promise<T>): Promise<{ available: true; data: T } | { available: false; error: string }> => {
      try { return { available: true, data: await fn() }; }
      catch (error) { return { available: false, error: safeText(error instanceof Error ? error.message : String(error)).slice(0, 500) }; }
    };
    const rows = [];
    // Sequential by client; independent reads within one client are parallel.
    for (const e of candidates) {
      const workspace = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId: e.id, monthKey: month } }, select: { id: true, monthKey: true, status: true, historical: true, videosOwed: true } });
      const [memberships, discovery, calls, releasedStrategy, versions, topics, brand, library, plans, requests, scripts, videos] = await Promise.all([
        read(async () => {
          const seats = await prisma.clientMembership.findMany({ where: { enrollmentId: e.id, clientId: e.clientId, revokedAt: null }, select: { clientUserId: true, role: true, acceptedAt: true } });
          const users = await prisma.clientUser.findMany({ where: { id: { in: seats.map((seat) => seat.clientUserId) } }, select: { id: true, name: true, status: true, lastLoginAt: true } });
          return seats.map((seat) => ({ role: seat.role, acceptedAt: seat.acceptedAt, user: users.find((u) => u.id === seat.clientUserId) ?? null }));
        }),
        read(async () => {
          const d = await onboardingView(e.id);
          return d ? { id: d.id, status: d.status, discoveryRequired: d.discoveryRequired,
            waivedAt: d.waived?.at ?? null, call: d.call, draft: d.draft, approved: d.approved,
            missingItems: d.missingItems, assets: d.assets, hasRecordedError: !!d.lastError } : null;
        }),
        read(async () => {
          const calls = await prisma.programCallRecord.findMany({ where: { enrollmentId: e.id, OR: [{ callType: "BRAND_DISCOVERY" }, { targetMonthKey: month }, ...(workspace ? [{ monthId: workspace.id }] : [])] }, select: { id: true, callType: true, status: true, matchState: true, transcriptState: true, scheduledStart: true, targetMonthKey: true, monthId: true, legacyMonthId: true } });
          const sources = await prisma.programTranscriptSource.findMany({ where: { callRecordId: { in: calls.map((call) => call.id) } }, select: { id: true, callRecordId: true, provider: true, matchState: true, confirmedAt: true, legacyMonthId: true } });
          return calls.map((call) => ({ ...call, sources: sources.filter((source) => source.callRecordId === call.id) }));
        }),
        read(async () => { const s = await portalStrategy(e); return s ? { versionNo: s.versionNo, approvedAt: s.approvedAtISO, releasedAt: s.releasedAtISO, sourceKind: s.sourceKind, newerPending: s.newerPending } : null; }),
        read(() => prisma.contentStrategyVersion.findMany({ where: { enrollmentId: e.id, clientId: e.clientId, approvedAt: { not: null } }, orderBy: { versionNo: "desc" }, take: 3, select: { id: true, versionNo: true, status: true, approvedAt: true, releasedAt: true, callRecordId: true } })),
        read(async () => {
          const bank = await prisma.contentTopic.findMany({ where: { enrollmentId: e.id, clientId: e.clientId, clientVisible: true, approvalState: "APPROVED", clientDeclinedAt: null }, select: { status: true, pillar: true, pillarId: true } });
          const byPillar: Record<string, number> = {};
          for (const t of bank.filter(topicOnBank)) { const key = t.pillarId ?? t.pillar ?? "Unassigned pillar"; byPillar[key] = (byPillar[key] ?? 0) + 1; }
          const portal = await portalTopics(e);
          return { approvedAvailableBankByPillar: byPillar, currentSelections: portal.groups.flatMap((g) => g.topics).filter((t) => !!workspace && t.selection?.monthId === workspace.id).map((t) => ({ id: t.id, title: t.title, state: t.state, selection: t.selection })) };
        }),
        read(() => setupFacts(e.id, e.clientId)),
        read(async () => { const l = await libraryRows(e); return { total: l.total, complete: l.complete, rows: l.rows.map((v) => ({ id: v.id, title: v.title, state: v.state, monthKey: v.monthKey, downloadable: v.downloadable })) }; }),
        read(() => prisma.programSessionPlan.findMany({ where: { enrollmentId: e.id, monthId: workspace?.id ?? "__missing_workspace__" }, select: { sessionIndex: true, streetNumber: true, streetName: true, unitNumber: true, city: true, stateCode: true, postalCode: true, addressVersion: true, addressValidatedAt: true, requestId: true } })),
        read(() => prisma.programSessionRequest.findMany({ where: { enrollmentId: e.id, monthId: workspace?.id ?? "__missing_workspace__" }, select: { id: true, status: true, bookingState: true, slotStart: true, slotEnd: true, locationText: true, projectId: true, matchState: true } })),
        read(() => prisma.contentScript.findMany({ where: { enrollmentId: e.id, monthId: workspace?.id ?? "__missing_workspace__", historical: false }, select: { id: true, title: true, topicId: true, videoId: true, status: true, currentVersionId: true } })),
        read(() => prisma.contentVideo.findMany({ where: { enrollmentId: e.id, monthKey: month, status: { not: "ARCHIVED" } }, select: { id: true, title: true, topicId: true, status: true, countsTowardAllowance: true, currentSubmissionId: true, approvedSubmissionId: true, finalSubmissionId: true } })),
      ]);
      const summary = overview.rows.find((r) => r.enrollmentId === e.id);
      rows.push({ client: names.get(e.clientId), enrollment: e, workspace, recordedSeats: memberships,
        discovery, matchedCallsAndSources: calls, releasedStrategy, approvedStrategyVersions: versions, topics, brand, library,
        sessionPlans: plans, sessionRequests: requests, scripts, linkedVideos: videos,
        nextAction: summary?.nextAction ?? null, owners: summary?.owners ?? null,
        journey: summary ? { planning: summary.planning, strategyCall: summary.strategyCall, work: summary.work, sessions: summary.session, production: summary.production, flags: summary.flags } : null,
      });
    }
    const report = { checkedAt: new Date().toISOString(), month, audience: "ACTIVE non-synthetic candidates; not an approved launch list", database: "read-only settings verified with SELECT; no mutation probe", limitations: ["Recorded seats are not a new authenticated browser test", "Shared reader visibility does not prove playback, media entitlement or provider delivery", "Missing workspace or unavailable section is unknown, not zero work", "Intended pilot roster and policy decisions still require Jordan's confirmation"], rows };
    fs.writeFileSync(output, JSON.stringify(report, (_key, value) => typeof value === "string" ? safeText(value) : value, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ output, candidates: rows.length, month, readonly: true, invitations: 0, providerRequests: 0 }));
  } finally { await prisma.$disconnect(); }
}
main().catch((error) => { console.error(safeText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
