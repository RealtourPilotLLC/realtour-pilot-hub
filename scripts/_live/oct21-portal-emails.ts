// ---------------------------------------------------------------------------
// LIVE: Jordan's Oct 21 2026 portal asks, in one reviewable pass.
//
//   1. Mike Ciunci: three stale August review rows ("Mike's Video 1", "Mike's
//      Video 2", "Mike video 1 august": five undecided v1-v3 cuts of the two
//      August videos he approved) come off his portal (ARCHIVED, never
//      deleted; the library sync no longer un-archives, 0f9661c).
//   2. Arielle Roemer: signs in with arielle.roemer@foxroach.com; her Gmail is
//      an Also email; the welcome goes again (Jordan: "yes to 1 and 2").
//   3. Mike Ciunci: the welcome again ("send mike the onboarding email too").
//   4. Clients who have not signed in get the sign-in reminder, at the email
//      on their Aryeo account (Jordan: "Make sure we are using the same emails
//      that are in their aryeo account"). Where the seat differs from Aryeo,
//      the seat moves to the Aryeo address and the old one stays as an Also
//      email copy.
//
// DRY RUN by default (reads, prints the plan). --apply writes and sends.
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct21-portal-emails.ts [--apply]
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
const ACTOR = "info@realtourpilot.com";

const MIKE_CLIENT = "cmqiks57u000m9k9qwlgjzfyn";
const STALE_AUGUST = ["cmu5oqm28002e9k8m3yqdzx5y", "cmu5oqm8d002g9k8mkcfr65tq", "cmu5oqmdg002j9k8m1xjeva33"];
const ARIELLE_CLIENT = "cmt7msalo000b9kg1kuk666hf";
const ARIELLE_SIGN_IN = "arielle.roemer@foxroach.com";
const ARIELLE_ALSO = "arielleroemer@gmail.com";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const PA = await import("@/lib/portalAccess");
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const { aryeoRequest } = await import("@/lib/integrations/aryeo");
  const jordan = await prisma.appUser.findFirst({ where: { email: ACTOR, role: "OWNER" }, select: { id: true } });
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} · Jordan appUser ${jordan?.id ?? "(not found)"}`);

  // 1. Mike's stale August rows.
  const stale = await prisma.contentVideo.findMany({ where: { id: { in: STALE_AUGUST }, clientId: MIKE_CLIENT }, select: { id: true, title: true, status: true, monthKey: true } });
  for (const v of stale) {
    console.log(`ARCHIVE  "${v.title}" (${v.monthKey}) ${v.status} → ARCHIVED`);
    if (APPLY && v.status !== "ARCHIVED") {
      const r = await prisma.contentVideo.updateMany({ where: { id: v.id, status: v.status }, data: { status: "ARCHIVED" } });
      await prisma.auditLog.create({ data: { actor: ACTOR, action: "content_video_archived", target: MIKE_CLIENT, detail: `Archived "${v.title}" (${v.id}, ${v.monthKey}) from the client's portal: a stale August review row (undecided early cuts of the two August videos he approved). Jordan, Oct 21 2026.` } });
      console.log(`         ${r.count ? "archived" : "SKIPPED (changed meanwhile)"}`);
    }
  }

  // Who has not signed in, with their Aryeo email.
  const ens = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true, clientId: true } });
  const clients = await prisma.client.findMany({ where: { id: { in: ens.map((e) => e.clientId) } }, select: { id: true, name: true, aryeoCustomerId: true } });
  type Plan = { enrollmentId: string; clientId: string; name: string; membershipId: string; seat: string; aryeo: string | null; send: "welcome" | "reminder"; newSeat: string | null; also: string | null };
  const plans: Plan[] = [];
  for (const e of ens) {
    const c = clients.find((x) => x.id === e.clientId);
    if (!c || isSyntheticClientRow(c)) continue;
    const st = await PA.programEmailsState(e.id);
    if (!st) continue;
    if (st.seats.some((s) => s.signedIn)) continue;
    const owner = st.seats.find((s) => s.role === "OWNER" && !s.disabled);
    if (!owner) { console.log(`NO SEAT  ${c.name}: nobody signs in yet, skipped (invite in Portal access first)`); continue; }
    let aryeo: string | null = null;
    if (c.aryeoCustomerId) {
      const r = await aryeoRequest<{ data?: { email?: string | null } }>(`/customers/${c.aryeoCustomerId}`, { timeoutMs: 8000 }).catch(() => null);
      aryeo = r?.data?.email?.trim().toLowerCase() || null;
    }
    const seat = owner.email.toLowerCase();
    if (c.id === ARIELLE_CLIENT) {
      plans.push({ enrollmentId: e.id, clientId: c.id, name: c.name, membershipId: owner.membershipId, seat, aryeo, send: "welcome", newSeat: seat === ARIELLE_SIGN_IN ? null : ARIELLE_SIGN_IN, also: ARIELLE_ALSO });
    } else {
      const moveTo = aryeo && aryeo !== seat ? aryeo : null;
      plans.push({ enrollmentId: e.id, clientId: c.id, name: c.name, membershipId: owner.membershipId, seat, aryeo, send: c.id === MIKE_CLIENT ? "welcome" : "reminder", newSeat: moveTo, also: moveTo ? seat : null });
    }
  }
  for (const p of plans) {
    console.log(`${p.send.toUpperCase().padEnd(8)} ${p.name.padEnd(18)} seat ${p.seat}${p.newSeat ? ` → ${p.newSeat}` : ""} · aryeo ${p.aryeo ?? "-"}${p.also ? ` · also ${p.also}` : ""}`);
  }
  if (!APPLY) { console.log("\nDRY RUN: nothing written or sent. Re-run with --apply."); await prisma.$disconnect(); return; }

  for (const p of plans) {
    if (p.newSeat) {
      const r = await PA.changeSeatEmail({ enrollmentId: p.enrollmentId, membershipId: p.membershipId, email: p.newSeat, actor: ACTOR });
      console.log(`  ${p.name}: sign-in → ${p.newSeat}: ${r.ok ? "ok" : "REFUSED"} ${r.message}`);
      if (!r.ok) continue; // never send to an address we could not set
    }
    if (p.also) {
      const r = await PA.changeAlsoEmails(p.enrollmentId, { add: p.also }, ACTOR);
      console.log(`  ${p.name}: also email ${p.also}: ${r.ok ? "ok" : "REFUSED"} ${r.message}`);
    }
    const sent = await PA.resendPortalWelcome(p.enrollmentId, { appUserId: jordan?.id ?? null, actor: ACTOR }, { reminder: p.send === "reminder" });
    console.log(`  ${p.name}: ${p.send}: ${sent.ok ? "SENT" : sent.outcome.toUpperCase()} ${sent.message}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : String(e)); process.exit(1); });
