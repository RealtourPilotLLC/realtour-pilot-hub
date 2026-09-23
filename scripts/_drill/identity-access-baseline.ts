// ---------------------------------------------------------------------------
// DRILL: IDENTITY AND ACCESS, MEASURED ON LIVE DATA (Sep 21 2026, batch 2).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/identity-access-baseline.ts
//
// Three questions Jordan asked, answered from production rather than from the
// spec:
//   1. F02 — does a verified Stripe payment reach account access today?
//   2. Clarification 5 — what does the Drive transcript matcher actually do,
//      and what happens on an ambiguous match?
//   3. Clarification 6 — does the BOOKING PATH (portalRequestSession, not the
//      helper) enforce batch 1's 48 weekday hours after the call ENDS?
//
// READ-ONLY, STRUCTURALLY. The guard is the connection, not a promise about
// what this file calls, and it is proven with a refused UPDATE before anything
// is read — see scripts/_drill/attribution-rails.ts for why that lesson cost us.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

function makeTheDatabaseReadOnly(): void {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../../.env")];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
      if (m) { url = m[1].trim().replace(/^["']|["']$/g, ""); break; }
    }
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}
makeTheDatabaseReadOnly();

const ET = (d: Date | null | undefined): string =>
  d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

async function main() {
  const { prisma } = await import("../../src/lib/prisma");

  let guard = "NOT PROVEN";
  try {
    await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } });
  } catch (e) {
    guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN";
  }
  console.log(`=== READ-ONLY GUARD: ${guard} ===\n`);
  if (guard !== "PROVEN") { console.error("The connection accepted a write. Refusing."); process.exitCode = 1; return; }

  // -------------------------------------------------------------------------
  // 1. F02 — verified payment vs account access.
  // -------------------------------------------------------------------------
  console.log("=== 1. F02: does a verified payment reach account access? ===");
  const signups = await prisma.programSignup.findMany({ orderBy: { paidAt: "desc" } });
  console.log(`ProgramSignup rows: ${signups.length}`);
  for (const s of signups) {
    const seats = s.enrollmentId ? await prisma.clientMembership.findMany({ where: { enrollmentId: s.enrollmentId } }) : [];
    const enr = s.enrollmentId ? await prisma.contentEnrollment.findUnique({ where: { id: s.enrollmentId }, select: { portalToken: true, package: true, packageSource: true } }) : null;
    const client = s.clientId ? await prisma.client.findUnique({ where: { id: s.clientId }, select: { name: true, email: true, backupEmail: true } }) : null;
    console.log(`  ${s.status.padEnd(13)} ${ET(s.paidAt)}  ${s.productName}`);
    console.log(`      checkout email=${s.email ?? "—"}  name=${s.name ?? "—"}  phone=${s.phone ?? "—"}`);
    console.log(`      client=${client?.name ?? "(none)"} email=${client?.email ?? "—"} backup=${client?.backupEmail ?? "—"}`);
    console.log(`      enrollment=${enr ? `${enr.package}/${enr.packageSource}` : "(none)"}  portalToken=${enr?.portalToken ? "yes" : "NO"}  seats=${seats.length}`);
    if (s.note) console.log(`      note: ${s.note}`);
  }
  const clientUsers = await prisma.clientUser.count();
  const memberships = await prisma.clientMembership.count({ where: { revokedAt: null } });
  const welcomeRows = await prisma.outboxMessage.count({ where: { dedupeKey: { startsWith: "portal_invite:" } } });
  console.log(`  TOTALS: ClientUser=${clientUsers}  live ClientMembership=${memberships}  portal_invite outbox rows=${welcomeRows}`);

  // The two launch gates that decide whether any of this may reach a person.
  const switches = await prisma.programAutomation.findMany({ select: { key: true, enabled: true } });
  console.log(`  ProgramAutomation rows: ${switches.length === 0 ? "ZERO (every switch reads OFF)" : switches.map((s) => `${s.key}=${s.enabled}`).join(", ")}`);

  // -------------------------------------------------------------------------
  // 2. Clarification 5 — call-to-transcript matching, as it really behaves.
  // -------------------------------------------------------------------------
  console.log("\n=== 2. Clarification 5: Google Meet transcripts via Drive ===");
  const records = await prisma.programCallRecord.findMany({ orderBy: { scheduledStart: "desc" } });
  console.log(`ProgramCallRecord rows: ${records.length}`);
  for (const r of records) {
    const raw = ((): Record<string, unknown> => { try { return JSON.parse(r.rawJson ?? "{}") as Record<string, unknown>; } catch { return {}; } })();
    const cal = (raw.calendar as { summary?: string } | undefined)?.summary ?? null;
    console.log(`  ${r.callType.padEnd(16)} ${r.matchState.padEnd(18)} transcript=${r.transcriptState.padEnd(12)} ${ET(r.scheduledStart)}`);
    console.log(`      invitee=${r.inviteeName ?? "—"} <${r.inviteeEmail ?? "—"}>  client=${r.clientId ?? "none"}  enrollment=${r.enrollmentId ?? "none"}  month=${r.monthId ?? "none"}`);
    console.log(`      calendarExternalId=${r.calendarExternalId ?? "NONE"}  calendar summary=${cal ?? "NONE"}  match note: ${r.matchNote ?? "—"}`);
    if (r.lastError) console.log(`      lastError: ${r.lastError}`);
  }
  const sources = await prisma.programTranscriptSource.findMany({ orderBy: { recordedAt: "desc" } });
  console.log(`  ProgramTranscriptSource rows: ${sources.length}`);
  for (const s of sources) {
    console.log(`    ${s.provider}/${s.matchState.padEnd(10)} call=${s.callRecordId ?? "none"} text=${s.text ? `${s.text.length} chars` : "NOT EXPORTED"}  legacyMonth=${s.legacyMonthId ?? "—"}`);
    console.log(`        "${s.title ?? "(untitled)"}"  recordedAt=${ET(s.recordedAt)}  candidates=${s.candidateCallIdsJson ?? "[]"}`);
  }

  // The matching RULE, replayed as a pure function on the live rows — no Drive
  // call needed to show what it would and would not auto-confirm.
  const { pairTranscriptCandidates, parseGeminiTitle, callRecordRules } = await import("../../src/lib/contentCallRecords");
  const rules = await callRecordRules();
  console.log(`  Rules: startToleranceMinutes=${rules.startToleranceMinutes} transcriptGraceHours=${rules.transcriptGraceHours}`);
  const docs = sources
    .filter((s) => s.provider === "drive" && s.externalId)
    .map((s) => {
      const { prefix, heldAt } = parseGeminiTitle(s.title ?? "");
      return { id: s.externalId!, name: s.title ?? "", prefix, heldAt, createdAt: s.recordedAt ?? new Date(0), link: s.sourceUrl };
    });
  const due = records.filter((r) => r.scheduledStart != null);
  const paired = pairTranscriptCandidates(
    due.map((r) => {
      const raw = ((): Record<string, unknown> => { try { return JSON.parse(r.rawJson ?? "{}") as Record<string, unknown>; } catch { return {}; } })();
      return { id: r.id, scheduledStart: r.scheduledStart!, calendarSummary: (raw.calendar as { summary?: string } | undefined)?.summary ?? null };
    }),
    docs, rules,
  );
  console.log("  REPLAY of pairTranscriptCandidates over the stored Drive docs:");
  for (const r of due) {
    const p = paired.get(r.id);
    if (!p || p.list.length === 0) continue;
    console.log(`    ${r.callType} ${ET(r.scheduledStart)} (${r.inviteeName ?? r.inviteeEmail ?? "?"}) → ${p.list.length} in window, auto=${p.auto ? "YES" : "NO (stays a proposal)"}`);
    for (const c of p.list) console.log(`        ${c.strong ? "STRONG" : "weak  "} ${c.doc.name} — ${c.why}`);
  }

  // -------------------------------------------------------------------------
  // 3. Clarification 6 — the booking path, not the helper.
  // -------------------------------------------------------------------------
  console.log("\n=== 3. Clarification 6: portalRequestSession enforces the 48 weekday hours ===");
  const tokened = await prisma.contentEnrollment.findMany({
    where: { portalToken: { not: null }, status: "ACTIVE" },
    select: { id: true, clientId: true, portalToken: true, sessionHours: true },
  });
  const names = await prisma.client.findMany({ where: { id: { in: tokened.map((t) => t.clientId) } }, select: { id: true, name: true } });
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const { isTestClientName } = await import("../../src/lib/testClients");
  const { sessionGate } = await import("../../src/lib/portal");
  const { portalRequestSession } = await import("../../src/app/portal/actions");

  let exercised = 0;
  for (const e of tokened) {
    const months = await prisma.contentMonth.findMany({ where: { enrollmentId: e.id, historical: false }, select: { id: true, monthKey: true }, orderBy: { monthKey: "desc" }, take: 2 });
    for (const m of months) {
      const gate = await sessionGate(e.id, m.id);
      const label = `${nameOf.get(e.clientId) ?? e.clientId}${isTestClientName(nameOf.get(e.clientId)) ? " [TEST]" : ""} ${m.monthKey}`;
      console.log(`  ${label}: locked=${gate.locked}${gate.locked ? ` (${gate.reason})` : ` earliest=${ET(gate.earliest)}`} call=${gate.callStatus} @ ${ET(gate.callAt)}`);
      if (gate.locked) continue;
      exercised++;
      // THE ACTUAL PATH. A slot one minute before `earliest` must be refused by
      // the action itself; the refusal happens before any write, so the
      // read-only connection is never reached.
      const tooEarly = new Date(gate.earliest.getTime() - 60_000);
      const r1 = await portalRequestSession({ token: e.portalToken }, { monthId: m.id, slotISO: tooEarly.toISOString(), location: "Drill probe — never written" });
      console.log(`      too-early slot ${ET(tooEarly)} → ok=${r1.ok} "${r1.message}"`);
      // A slot AFTER earliest must get past the gate. Under the read-only
      // guard the write then fails, which is itself the proof that the gate
      // passed control through to createSessionRequest.
      const ok = new Date(gate.earliest.getTime() + 3600_000);
      let reached = "no";
      try {
        const r2 = await portalRequestSession({ token: e.portalToken }, { monthId: m.id, slotISO: ok.toISOString(), location: "Drill probe — never written" });
        reached = `action returned ok=${r2.ok} "${r2.message}"`;
      } catch (err) {
        reached = /read-only transaction/i.test(err instanceof Error ? err.message : String(err))
          ? "REACHED THE WRITE (refused by the read-only guard) — the gate accepted it"
          : `threw: ${(err as Error).message.slice(0, 160)}`;
      }
      console.log(`      valid slot   ${ET(ok)} → ${reached}`);
    }
  }
  if (exercised === 0) console.log("  (no open month on any tokened enrollment had an unlocked gate to exercise)");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
