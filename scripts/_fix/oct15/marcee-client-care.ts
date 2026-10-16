// Oct 15 2026 — Marcee McMullen's Oct 15 call, recorded where the hub now has
// a place for each part of it.
//
// WHAT IT WRITES (dry run by default; --apply writes; safe to run twice):
//   1. Creative guardrails (lib/creativeGuard.setCreativeGuard, ledgered):
//        proven format "Fully scripted, direct to camera (the house framework)";
//        "Fairy God Realtor" stopped, by Jordan, "Client asked to stop it on
//        the Oct 15 2026 call". The topic bank and the script writer obey it;
//        the editor brief and the Review Room show it.
//   2. A confirmed production preference (lib/clientFacts, ACCEPTED by Jordan):
//        "Use the fonts from her signs and website on every video's
//        graphics." It reaches the editor brief as a confirmed preference.
//        (Put the actual font names in her Brand Profile fonts slot when known.)
//   3. Entitlements (lib/entitlements.addEntitlement), source "call":
//        EXTENSION_MONTH ×1 for the July session; CARRY_TO_END ×N for the
//        missed months (N = her forfeited or skipped-without-catch-up months,
//        printed below; --carried=N overrides); EXTRA_DELIVERABLE ×1 "a
//        bio/lifestyle video like Erica Walker's, but shorter"; REFUND_DECLINED
//        "asked about a refund; not agreed".
//   4. A complaint record (lib/clientIssues.createClientIssue) for the call,
//        OPEN, owner Jordan, with the process changes made today.
// Nothing here messages Marcee, books, charges or refunds anything.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct15/marcee-client-care.ts [--apply] [--carried=N]
import { prisma } from "@/lib/prisma";

const BY = "Jordan Spackman";
const REF = "Oct 15 2026 call with Jordan";
const CALL_AT = new Date("2026-10-15T16:00:00Z");

async function main() {
  const apply = process.argv.includes("--apply");
  const carriedArg = process.argv.find((a) => a.startsWith("--carried="));
  console.log(apply ? "APPLY" : "DRY RUN (pass --apply to write)");

  const clients = await prisma.client.findMany({ where: { name: { contains: "Marcee", mode: "insensitive" }, parentClientId: null }, select: { id: true, name: true } });
  const enrollments = await prisma.contentEnrollment.findMany({ where: { clientId: { in: clients.map((c) => c.id) } }, select: { id: true, clientId: true, status: true, billingMonths: true, termStartMonth: true, termEndMonth: true, overridesJson: true } });
  if (enrollments.length !== 1) {
    console.log(`Expected exactly one Marcee program, found ${enrollments.length}:`, clients.map((c) => `${c.name} (${c.id})`).join(", "));
    process.exit(1);
  }
  const e = enrollments[0];
  const client = clients.find((c) => c.id === e.clientId)!;
  console.log(`Client: ${client.name} (${client.id}) · program ${e.id} · ${e.status} · ${e.billingMonths ?? "?"} months · term ${e.termStartMonth ?? "?"} to ${e.termEndMonth ?? "?"}`);

  // ---- 1. creative guardrails -------------------------------------------------
  const { creativeGuardFromOverrides, seriesKey } = await import("@/lib/creativeGuardCore");
  const guard = creativeGuardFromOverrides(e.overridesJson);
  const PROVEN = "Fully scripted, direct to camera (the house framework)";
  const needFormat = !guard.provenFormats.includes(PROVEN);
  const needStop = !guard.discontinued.some((d) => seriesKey(d.name) === seriesKey("Fairy God Realtor"));
  console.log(`\n1. Guardrails: proven format ${needFormat ? "to add" : "already set"}; "Fairy God Realtor" ${needStop ? "to stop" : "already stopped"}.`);
  if (apply) {
    const { setCreativeGuard } = await import("@/lib/creativeGuard");
    if (needFormat) console.log("   ", (await setCreativeGuard(e.id, { provenFormats: [...guard.provenFormats, PROVEN] }, BY)).message);
    if (needStop) console.log("   ", (await setCreativeGuard(e.id, { addDiscontinued: { name: "Fairy God Realtor", reason: "Client asked to stop it on the Oct 15 2026 call" } }, BY)).message);
  }

  // ---- 2. fonts preference ----------------------------------------------------
  const FONT = "Use the fonts from her signs and website on every video's graphics.";
  console.log(`\n2. Production preference: "${FONT}"`);
  // The lead's call-facts pass (marcee-call-facts.ts) already accepted the
  // signs-and-website fonts preference; one is enough.
  const { prisma: db } = await import("@/lib/prisma");
  const fontsOnFile = await db.clientFact.findFirst({ where: { clientId: client.id, status: "ACCEPTED", body: { contains: "signs" }, category: { in: ["BRAND_PREFERENCE", "PRODUCTION_PREFERENCE"] } }, select: { id: true } });
  if (fontsOnFile) console.log(`    already covered by an accepted fact (${fontsOnFile.id}); not added`);
  if (apply && !fontsOnFile) {
    const { createFact, acceptFact } = await import("@/lib/clientFacts");
    const f = await createFact({ clientId: client.id, enrollmentId: e.id, category: "PRODUCTION_PREFERENCE", body: FONT, source: "call", sourceRef: REF, factDate: CALL_AT, scope: "PERMANENT" });
    await acceptFact(f.id, BY);
    console.log(`    ${f.existed ? "already on file; accepted" : "created and accepted"} (${f.id})`);
  }

  // ---- 3. entitlements --------------------------------------------------------
  const { forfeitedMonths } = await import("@/lib/monthForfeit");
  const { readCatchUps } = await import("@/lib/catchUp");
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId: e.id, historical: false }, orderBy: { monthKey: "asc" }, select: { id: true, monthKey: true, status: true, historical: true, strategyCallStatus: true } });
  const forfeited = await forfeitedMonths(months.map((m) => ({ id: m.id, monthKey: m.monthKey, status: m.status, historical: m.historical, strategyCallStatus: m.strategyCallStatus })));
  const caughtUp = new Set(readCatchUps(e.overridesJson).map((r) => r.missedMonthKey));
  const missed = months.filter((m) => forfeited.has(m.id) || (m.status === "SKIPPED" && !caughtUp.has(m.monthKey))).map((m) => m.monthKey);
  const carried = carriedArg ? Number(carriedArg.split("=")[1]) : missed.length;
  console.log(`\n3. Months: ${months.map((m) => `${m.monthKey} ${m.status}${forfeited.has(m.id) ? " (forfeited)" : ""}`).join(" · ") || "none"}`);
  console.log(`   Missed months found: ${missed.join(", ") || "none"} → carried to the end: ${carried}${carriedArg ? " (from --carried)" : ""}`);
  const existing = await prisma.programEntitlement.findMany({ where: { enrollmentId: e.id, sourceRef: REF, state: { not: "VOID" } }, select: { kind: true } });
  const has = (k: string) => existing.some((x) => x.kind === k);
  const rows = [
    { kind: "EXTENSION_MONTH", qty: 1, monthKey: "2026-07", description: "One extra month added at the end of the term for the July session." },
    ...(carried > 0 ? [{ kind: "CARRY_TO_END", qty: carried, monthKey: null, description: `The missed months carried to the end of the term${missed.length ? ` (${missed.join(", ")})` : ""}.` }] : []),
    { kind: "EXTRA_DELIVERABLE", qty: 1, monthKey: null, description: "A bio/lifestyle video like Erica Walker's, but shorter." },
    { kind: "REFUND_DECLINED", qty: 1, monthKey: null, description: "Asked about a refund on the call; a refund was not agreed." },
  ];
  const { addEntitlement } = await import("@/lib/entitlements");
  for (const r of rows) {
    if (has(r.kind)) { console.log(`   ${r.kind}: already recorded`); continue; }
    console.log(`   ${r.kind} ×${r.qty}: ${r.description}`);
    if (apply) console.log("     ", (await addEntitlement({ enrollmentId: e.id, kind: r.kind, qty: r.qty, monthKey: r.monthKey, description: r.description, agreedBy: BY, agreedAt: CALL_AT, source: "call", sourceRef: REF, createdBy: BY })).message);
  }

  // ---- 4. the complaint -------------------------------------------------------
  const already = await prisma.clientIssue.findFirst({ where: { clientId: client.id, sourceRef: REF, dismissedAt: null }, select: { id: true, state: true } });
  console.log(`\n4. Complaint record: ${already ? `already on file (${already.id}, ${already.state})` : "to create"}`);
  if (!already && apply) {
    const projects = await prisma.project.findMany({ where: { clientId: client.id, contentMonthId: { in: months.map((m) => m.id) }, status: { not: "CANCELLED" } }, select: { id: true } });
    const { createClientIssue, updateClientIssue } = await import("@/lib/clientIssues");
    const r = await createClientIssue({
      clientId: client.id, source: "call", sourceRef: REF, ownerKey: "jordan", ownerName: BY,
      title: "Oct 15 call: turnaround, style and missing videos",
      whatHappened: [
        "Hard call with Jordan on Oct 15 2026 after a long run of work together.",
        "Videos took too long and she had to chase for updates.",
        "Feedback she could not put into words kept going round as revisions (\"I know I don't like something about it, but I wouldn't know how to tell someone to fix it ... too slow or too fast or whatever\").",
        "The Fairy God Realtor series was not her; she wants the fully scripted framework back and the fonts from her signs and website.",
        "Two August videos, and older content, are missing from her portal library.",
        "Agreed on the call: one extra month at the end for the July session, the missed months carried to the end of the term, a shorter bio/lifestyle video like Erica Walker's. A refund was not agreed.",
      ].join("\n"),
      impact: "A long-time client unhappy enough to question the program.",
      projectIds: projects.map((p) => p.id),
      createdBy: BY,
    });
    if (r.id) {
      await updateClientIssue(r.id, { processChange: "Vague feedback now goes to creative review (Jordan) before any editor task; the Review Room has a technical and a creative check, the creative one Jordan's or James's on program videos; her proven format and the stopped series are on every editor brief and enforced in topic ideas and scripts; what she is owed is on her client file." }, BY);
      const ent = await prisma.programEntitlement.findMany({ where: { enrollmentId: e.id, sourceRef: REF }, select: { id: true } });
      await updateClientIssue(r.id, { linked: { entitlementIds: ent.map((x) => x.id) } }, BY);
    }
    console.log(`    ${r.message} (${r.id})`);
  }
  console.log(apply ? "\nDone." : "\nNothing written. Re-run with --apply.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
