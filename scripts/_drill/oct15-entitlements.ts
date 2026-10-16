// ---------------------------------------------------------------------------
// DRILL: the client entitlement ledger (Oct 15 2026).
//
// Marcee McMullen's Oct 15 call: one extra month at the end for the July
// session, the missed months carried to the end of her term, a bio/lifestyle
// video like Erica Walker's but shorter, and no refund.
//
//   1. The term arithmetic: signed end = start + months; extensions and
//      carried months push it; void rows do not count.
//   2. The ledger: each kind records; a refund NOT agreed and a credit are a
//      record, never "owed"; an extra video is owed until done; undo keeps the
//      row with the reason; refusals in words.
//   3. The term on the enrollment, ledgered as a ProgramEnrollmentChange.
//   4. Sessions: used, missed (a forfeited month, a skipped one), postponed,
//      still to film (open months plus extension and carried months).
//   5. Who may write: the office; a photographer or a preview may not.
//   6. The screens: the card on the client file, no money, no dashes.
//
// ISOLATION: PGlite; the login seam intercepted; nothing leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);
installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7104), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct15-entitlements" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const read = (p: string) => fs.readFileSync(p, "utf8");
  try {
    const { prisma } = await import("@/lib/prisma");
    const core = await import("@/lib/entitlementsCore");
    const lib = await import("@/lib/entitlements");
    const actions = await import("@/app/clients/clientCareActions");
    const tm = await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle@ent.invalid", role: "MANAGER", active: true } });
    const u = await prisma.appUser.create({ data: { email: "kyle@ent.invalid", name: "Kyle Cabrera", role: "ADMIN", status: "ACTIVE", teamMemberId: tm.id } });
    const kyle: Viewer = { id: u.id, email: "kyle@ent.invalid", name: "Kyle Cabrera", role: "ADMIN", permissions: null, status: "ACTIVE", teamMemberId: tm.id, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: "ADMIN", realName: "Kyle Cabrera" };
    const photographer: Viewer = { ...kyle, id: "p1", email: "harrison@ent.invalid", name: "Harrison", role: "PHOTOGRAPHER", realRole: "PHOTOGRAPHER", teamMemberId: null };

    // ======================================================================
    c.head("1 · the term arithmetic");
    const t0 = core.termOf({ termStartMonth: "2026-01", termEndMonth: null, billingMonths: 12, firstMonthKey: "2026-02" }, []);
    c.ok("start + 12 months ends in December", t0.start === "2026-01" && t0.signedEnd === "2026-12" && t0.end === "2026-12" && t0.months === 12);
    const t1 = core.termOf({ termStartMonth: "2026-01", termEndMonth: null, billingMonths: 12, firstMonthKey: null }, [
      { kind: "EXTENSION_MONTH", qty: 1, state: "OPEN" }, { kind: "CARRY_TO_END", qty: 2, state: "OPEN" }, { kind: "CARRY_TO_END", qty: 5, state: "VOID" }, { kind: "EXTRA_DELIVERABLE", qty: 1, state: "OPEN" },
    ]);
    c.ok("one extension and two carried months push the end to March", t1.end === "2027-03" && t1.extensions === 1 && t1.carried === 2 && t1.signedEnd === "2026-12");
    c.ok("an undone row does not count", t1.carried === 2);
    c.ok("an office-set end wins over the arithmetic", core.termOf({ termStartMonth: "2026-01", termEndMonth: "2026-10", billingMonths: 12, firstMonthKey: null }, []).signedEnd === "2026-10");
    c.ok("no start: the first program month stands in, and says so", /first program month/.test(core.termOf({ termStartMonth: null, termEndMonth: null, billingMonths: 6, firstMonthKey: "2026-05" }, []).basis));
    c.ok("month arithmetic across the year", core.addMonths("2026-11", 3) === "2027-02" && core.addMonths("2026-01", -1) === "2025-12" && core.monthName("2026-07") === "July 2026");

    // ======================================================================
    c.head("2 · the ledger");
    const M = await buildContentMonth(prisma as never, { name: "Marcee Ledger TEST", package: "Starter", monthKey: "2026-09", project: { status: "DELIVERED", shootDate: new Date("2026-09-15T14:00:00Z") }, appointments: [{ startAt: new Date("2026-09-15T14:00:00Z"), durationMin: 120, status: "SCHEDULED" }] });
    await prisma.contentEnrollment.update({ where: { id: M.enrollmentId }, data: { billingMonths: 12, billingType: "MONTHLY_CONTRACT" } });
    const add = (kind: string, description: string, extra: Record<string, unknown> = {}) => lib.addEntitlement({ enrollmentId: M.enrollmentId, kind, description, agreedBy: "Jordan", source: "call", sourceRef: "Oct 15 call", createdBy: "Kyle Cabrera", ...extra });
    const ext = await add("EXTENSION_MONTH", "One extra month at the end of the term for the July session", { monthKey: "2026-07" });
    const carry = await add("CARRY_TO_END", "The missed months carried to the end of the term", { qty: 2 });
    const bio = await add("EXTRA_DELIVERABLE", "A bio/lifestyle video like Erica Walker's, but shorter");
    const refund = await add("REFUND_DECLINED", "Asked about a refund; not agreed");
    const post = await add("SESSION_POSTPONED", "October session postponed to November", { monthKey: "2026-10", targetMonthKey: "2026-11" });
    c.ok("each kind records", [ext, carry, bio, refund, post].every((r) => r.ok && r.id), [ext, carry, bio, refund, post].map((r) => r.message).join(" | "));
    c.ok("a refund not agreed is a record, never owed", (await prisma.programEntitlement.findUniqueOrThrow({ where: { id: refund.id! } })).state === "FULFILLED");
    const bad = await lib.addEntitlement({ enrollmentId: M.enrollmentId, kind: "FREE_STUFF", description: "x", createdBy: null });
    c.ok("an unknown kind is refused in words", !bad.ok && /what was agreed/.test(bad.message));
    c.ok("a month must look like 2026-07", !(await add("EXTENSION_MONTH", "x long enough", { monthKey: "July" })).ok);
    const s1 = (await lib.entitlementSummary(M.enrollmentId))!;
    c.ok("owed: the extension, the carried months, the bio video and the postponed session (not the refund)", s1.owed.map((r) => r.kind).sort().join(",") === ["CARRY_TO_END", "EXTENSION_MONTH", "EXTRA_DELIVERABLE", "SESSION_POSTPONED"].sort().join(","));
    await lib.setEntitlementState(bio.id!, "SCHEDULED", "Kyle Cabrera");
    const done = await lib.setEntitlementState(bio.id!, "FULFILLED", "Kyle Cabrera", "Project:bio-video");
    c.ok("the bio video is scheduled, then done with what fulfilled it", done.ok && (await prisma.programEntitlement.findUniqueOrThrow({ where: { id: bio.id! } })).fulfilledRef === "Project:bio-video");
    const noWhy = await lib.voidEntitlement(post.id!, "Kyle Cabrera", "");
    c.ok("undo needs a reason", !noWhy.ok);
    const undone = await lib.voidEntitlement(post.id!, "Kyle Cabrera", "Recorded on the wrong client");
    const pRow = await prisma.programEntitlement.findUniqueOrThrow({ where: { id: post.id! } });
    c.ok("undo keeps the row with who and why", undone.ok && pRow.state === "VOID" && pRow.voidReason === "Recorded on the wrong client" && pRow.voidedBy === "Kyle Cabrera");

    // ======================================================================
    c.head("3 · the term on the enrollment");
    const backwards = await lib.setTerm(M.enrollmentId, { termStartMonth: "2026-06", termEndMonth: "2026-01" }, "Kyle Cabrera");
    c.ok("an end before the start is refused", !backwards.ok);
    const term = await lib.setTerm(M.enrollmentId, { termStartMonth: "2026-01", termEndMonth: null }, "Kyle Cabrera");
    c.ok("the start is saved", term.ok && (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: M.enrollmentId } })).termStartMonth === "2026-01");
    c.ok("…and ledgered", (await prisma.programEnrollmentChange.count({ where: { enrollmentId: M.enrollmentId, field: "termStartMonth" } })) === 1);
    const s2 = (await lib.entitlementSummary(M.enrollmentId))!;
    c.ok("the term now ends March 2027 (December + 1 extension + 2 carried)", s2.term.start === "2026-01" && s2.term.signedEnd === "2026-12" && s2.term.end === "2027-03", JSON.stringify(s2.term));

    // ======================================================================
    c.head("4 · sessions");
    const mk = (monthKey: string, status: string) => prisma.contentMonth.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, monthKey, videosOwed: 4, status } });
    await mk("2026-07", "OPEN"); // over, nothing done: forfeited
    await mk("2026-08", "SKIPPED"); // skipped with no catch-up
    await mk("2026-10", "OPEN"); // this month, not filmed
    const s3 = (await lib.entitlementSummary(M.enrollmentId))!;
    const sess = s3.sessions!;
    c.ok("the session ledger was read", !!sess && sess.perMonth.length === 4, JSON.stringify(sess?.perMonth));
    c.ok("used: September's session (its date has passed)", sess.used === 1, JSON.stringify(sess));
    c.ok("missed: July (forfeited) and August (skipped)", sess.missed === 2 && /forfeited/.test(sess.perMonth.find((m) => m.monthKey === "2026-07")?.state ?? ""));
    c.ok("postponed: none live (that one was undone)", sess.postponed === 0);
    c.ok("still to film: October, plus the extension and the two carried months", sess.available === 1 + 3 * s3.sessionsPerMonth, `${sess.available} (sessionsPerMonth ${s3.sessionsPerMonth})`);

    // ======================================================================
    c.head("5 · who may write");
    viewer = photographer;
    const p = await actions.addEntitlementAction({ enrollmentId: M.enrollmentId, kind: "CREDIT", description: "A credit for something" });
    c.ok("a photographer may not", !p.ok);
    viewer = { ...kyle, impersonating: true };
    c.ok("a preview may not", !(await actions.addEntitlementAction({ enrollmentId: M.enrollmentId, kind: "CREDIT", description: "A credit for something" })).ok);
    viewer = kyle;
    const k = await actions.addEntitlementAction({ enrollmentId: M.enrollmentId, kind: "CREDIT", description: "One extra edit round on the August videos" });
    c.ok("the office may", k.ok, k.message);
    const tk = await actions.setTermAction({ enrollmentId: M.enrollmentId, termStartMonth: "2026-01", termEndMonth: "2026-12" });
    c.ok("…and set the term", tk.ok && (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: M.enrollmentId } })).termEndMonth === "2026-12");

    // ======================================================================
    c.head("6 · the screens");
    const card = read("src/components/clientCare/EntitlementsCard.tsx");
    c.ok("the card is mounted on the client file", /<EntitlementsCard summary=\{entitlements\} canEdit=\{canEditPrefs\} \/>/.test(read("src/app/clients/[id]/page.tsx")));
    c.ok("it shows used / missed / postponed / still to film and the owed list", ["\"Used\"", "\"Missed\"", "\"Postponed\"", "\"Still to film\"", "Promised beyond the package"].every((w) => card.includes(w)));
    c.ok("no dollar signs and no em dashes in what it says", !/\$\{?\d|\$[0-9]/.test(card) && !/[—–]/.test(Object.values(core.ENTITLEMENT_LABEL).join(" ")));

    c.head("isolation");
    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    quiet.restore();
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
