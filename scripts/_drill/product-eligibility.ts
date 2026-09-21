// ---------------------------------------------------------------------------
// DRILL: PRODUCT-SPECIFIC VIDEOGRAPHER ELIGIBILITY (Jordan, Sep 21 2026)
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/product-eligibility.ts
//
// Phase 0 read `is_service_provider`, found it true for Harrison Wells, and told
// Jordan he was already eligible for the three monthly-content products. Jordan:
//
//   "Harrison is not currently assigned to Starter, Accelerator, or Pro. General
//    availability and is_service_provider do not establish eligibility for those
//    products. James is currently eligible. Reflect future assignment changes
//    from Aryeo."
//
// So this drill checks the code against HIS ground truth, not against itself,
// and then measures what the corrected availability query actually removes.
//
// READ-ONLY on both sides. The database connection refuses writes and proves it
// before reading. Every Aryeo call is a GET: no order, appointment, address,
// charge, subscription, webhook or scheduling link is created.
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

/** Jordan's ground truth, and the ids Phase 0 verified. */
const HARRISON_TM = "019470c9-4713-73cb-9d69-4c9bae5da500";
const JAMES_TM = "019cf893-edf5-7017-85a6-1ec040407ab0";
const SARAH_TM = "01988af0-9d23-7024-909c-e78b278adc90"; // is_service_provider, INACTIVE user

let checks = 0, failures = 0;
function check(ok: boolean, what: string, detail = "") {
  checks++; if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { aryeoRequest, productProviders, productProvidersFor, bookableProviderIdsFor, productAvailability, resetProductProviderCache } =
    await import("../../src/lib/integrations/aryeo");
  const { ARYEO_CONTENT_PRODUCTS, sessionMinutesFor, PACKAGE_RULES } = await import("../../src/lib/contentProgram");

  let guard = "NOT PROVEN";
  try {
    await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } });
  } catch (e) {
    guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN";
  }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") { process.exitCode = 1; return; }

  // -------------------------------------------------------------------------
  console.log(`\n=== 1. JORDAN'S GROUND TRUTH, CHECKED AGAINST ARYEO ===`);
  const byProduct = await productProviders();
  for (const [pkg, prod] of Object.entries(ARYEO_CONTENT_PRODUCTS)) {
    const rows = byProduct.get(prod.productId) ?? [];
    const names = rows.map((r) => `${r.name ?? r.teamMemberId}${r.bookable ? "" : ` (NOT bookable: ${r.reason})`}`);
    console.log(`   ${pkg.padEnd(12)} ${prod.title.padEnd(32)} -> ${names.join(", ") || "(nobody)"}`);
    check(!rows.some((r) => r.teamMemberId === HARRISON_TM), `${pkg}: Harrison is NOT assigned`);
    check(rows.some((r) => r.teamMemberId === JAMES_TM && r.bookable), `${pkg}: James IS assigned and bookable`);
  }

  // The flag Phase 0 mistook for eligibility, still true, still not the answer.
  const team = await aryeoRequest<{ data?: { id?: string; is_service_provider?: boolean }[] }>("/company-team-members", { query: { per_page: 100 } });
  const harrisonFlag = (team.data ?? []).find((t) => t.id === HARRISON_TM)?.is_service_provider;
  check(harrisonFlag === true,
    "is_service_provider is STILL true for Harrison — the flag was never wrong, it was the wrong question", `flag=${harrisonFlag}`);

  // -------------------------------------------------------------------------
  console.log(`\n=== 2. ELIGIBILITY IS READ FROM ARYEO, NOT FROM OUR SOURCE ===`);
  // If a change Aryeo makes tomorrow must land without a deploy, then the
  // answer has to be derivable from a raw read taken right now. This re-derives
  // it from a fresh GET and demands the two agree exactly.
  resetProductProviderCache();
  const raw = await aryeoRequest<{ data?: { id?: string; providers?: { id?: string }[] }[] }>("/products", { query: { include: "providers", per_page: 100 } });
  const rawAccel = (raw.data ?? []).find((p) => p.id === ARYEO_CONTENT_PRODUCTS.Accelerator.productId);
  const rawIds = (rawAccel?.providers ?? []).map((x) => x.id).filter(Boolean).sort();
  const ourIds = (await productProvidersFor(ARYEO_CONTENT_PRODUCTS.Accelerator.productId)).map((p) => p.teamMemberId).sort();
  check(JSON.stringify(rawIds) === JSON.stringify(ourIds),
    "the assignment we act on is exactly what GET /products?include=providers returned seconds ago", `${ourIds.length} ids`);
  const srcFile = fs.readFileSync(path.resolve(__dirname, "../../src/lib/integrations/aryeo.ts"), "utf8");
  const codeBody = srcFile.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  check(!codeBody.includes(JAMES_TM) && !codeBody.includes(HARRISON_TM),
    "no creative id is hard-coded in the eligibility path — only in this drill's assertions");

  // The is_service_provider / active-user rule, on a product Sarah Anne IS on.
  const sarahProduct = [...byProduct.entries()].find(([, rows]) => rows.some((r) => r.teamMemberId === SARAH_TM));
  if (sarahProduct) {
    const sarah = sarahProduct[1].find((r) => r.teamMemberId === SARAH_TM)!;
    check(!sarah.bookable && /inactive/i.test(sarah.reason ?? ""),
      "Sarah Anne is ASSIGNED to a product and still not offerable — her Aryeo account is inactive", sarah.reason ?? "");
  } else {
    check(false, "expected to find a product Sarah Anne is assigned to");
  }

  // -------------------------------------------------------------------------
  console.log(`\n=== 3. WHAT THE CORRECTED QUERY REMOVES (the over-offer, re-measured) ===`);
  const tz = "America/New_York";
  const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const start = new Date(Date.now() + 86_400_000);
  const end = new Date(Date.now() + 21 * 86_400_000);
  // THE OLD QUERY, exactly as companySlotDays sent it: interval 60, no
  // duration, no creative, company-wide. Compared DAY BY DAY against the
  // corrected one, because the two ask different questions over different
  // horizons and a bare total would flatter whichever ran longer.
  const accel = await productAvailability({
    productId: ARYEO_CONTENT_PRODUCTS.Accelerator.productId,
    durationMin: ARYEO_CONTENT_PRODUCTS.Accelerator.durationMinutes,
    days: 21, interval: 30,
  });
  const newByDay = new Map((accel?.days ?? []).map((d) => [d.date, new Set(d.slots)]));
  const oldDates = await aryeoRequest<{ data?: { date: string; is_available?: boolean }[] }>("/scheduling/available-dates", {
    query: { timezone: tz, interval: 60, "filter[start_at]": isoZ(start), "filter[end_at]": isoZ(end) },
  });
  const dow = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const oldDays = (oldDates.data ?? []).filter((d) => d.is_available !== false).slice(0, 8);
  let oldSlots = 0, unreal = 0, weekendSlots = 0, weekendDays = 0;
  console.log(`   day          old   real   dropped   why`);
  for (const d of oldDays) {
    const r = await aryeoRequest<{ data?: { start_at?: string }[] }>("/scheduling/available-timeslots", {
      query: { timezone: tz, interval: 60, date: d.date },
    });
    const starts = (r.data ?? []).map((x) => x.start_at).filter((x): x is string => !!x);
    oldSlots += starts.length;
    const weekend = dow(d.date) === "Sat" || dow(d.date) === "Sun";
    if (weekend) { weekendDays++; weekendSlots += starts.length; }
    const real = newByDay.get(d.date) ?? new Set<string>();
    const kept = starts.filter((s) => real.has(s)).length;
    unreal += starts.length - kept;
    const why = weekend ? "weekend — this program does not film" : kept === 0 ? "nobody assigned to Accelerator has 4 hours free" : "some starts are too late in the day for 4 hours";
    console.log(`   ${d.date} ${dow(d.date)}  ${String(starts.length).padStart(3)}   ${String(kept).padStart(4)}   ${String(starts.length - kept).padStart(7)}   ${why}`);
  }
  console.log(`   OLD query over those ${oldDays.length} days: ${oldSlots} starts offered, ${oldSlots - unreal} of them real for a 4-hour Accelerator.`);
  console.log(`   ${unreal} starts a client could have picked and nobody could have filmed (${weekendSlots} on ${weekendDays} weekend day(s)).`);
  console.log(`   NEW query, weekdays only, 240min, assigned creatives: ${(accel?.days ?? []).length} days, ${(accel?.days ?? []).reduce((n, d) => n + d.slots.length, 0)} real starts.`);
  for (const d of accel?.days ?? []) console.log(`        ${d.date} ${dow(d.date)}  ${d.slots.length} starts  first ${d.slots[0]}`);
  check(unreal > 0, "the old query really did offer unfillable starts — measured, not asserted", `${unreal} of ${oldSlots}`);
  check(accel !== null, "the corrected availability call returned an answer");
  check((accel?.days ?? []).every((d) => dow(d.date) !== "Sat" && dow(d.date) !== "Sun"),
    "NO WEEKEND DAY is offered — §8's rule, which Aryeo will not enforce (it offered weekend slots above)");
  check((accel?.providers ?? []).every((p) => p.teamMemberId !== HARRISON_TM),
    "Harrison's calendar is not consulted for an Accelerator session");

  // The same question, scoped the WRONG way, to show the filter really bites.
  const wide = await aryeoRequest<{ data?: { date: string }[]; meta?: { company_team_member_ids?: string[] } }>("/scheduling/available-dates", {
    query: { timezone: tz, interval: 30, duration: 240, "filter[start_at]": isoZ(start), "filter[end_at]": isoZ(end) },
  });
  check((wide.meta?.company_team_member_ids ?? []).includes(HARRISON_TM),
    "…and with no user filter Aryeo DOES include Harrison, so the narrowing is ours and not the provider's");

  // -------------------------------------------------------------------------
  console.log(`\n=== 4. THE PRODUCT FILTERS ARYEO ACCEPTS AND IGNORES ===`);
  const accelId = ARYEO_CONTENT_PRODUCTS.Accelerator.productId;
  for (const q of [
    { "filter[product_ids][]": accelId }, { "filter[product_id]": accelId }, { product_id: accelId },
  ] as Record<string, string>[]) {
    const r = await aryeoRequest<{ meta?: { company_team_member_ids?: string[] } }>("/scheduling/available-dates", {
      query: { timezone: tz, interval: 30, duration: 240, "filter[start_at]": isoZ(start), "filter[end_at]": isoZ(end), ...q },
    });
    const ids = r.meta?.company_team_member_ids ?? [];
    check(ids.includes(HARRISON_TM),
      `${Object.keys(q)[0]} returns 200 and is SILENTLY IGNORED — Harrison is still in the roster`, `${ids.length} people`);
  }

  // -------------------------------------------------------------------------
  console.log(`\n=== 5. PRO IS THE FOUR-HOUR PRODUCT BOOKED TWICE ===`);
  check(ARYEO_CONTENT_PRODUCTS.Pro.durationMinutes === 240 && ARYEO_CONTENT_PRODUCTS.Pro.sessionsPerMonth === 2,
    "Pro books the existing 240-minute product, twice — no eight-hour product exists or is asked for",
    `${ARYEO_CONTENT_PRODUCTS.Pro.durationMinutes}min x${ARYEO_CONTENT_PRODUCTS.Pro.sessionsPerMonth}`);
  check(sessionMinutesFor("Pro") === 240 && PACKAGE_RULES.Pro.sessionsPerMonth === 2,
    "…and the availability duration a Pro session asks for is 240, never 480");
  const proIds = await bookableProviderIdsFor(ARYEO_CONTENT_PRODUCTS.Pro.productId);
  const accelIds = await bookableProviderIdsFor(accelId);
  check(JSON.stringify([...proIds].sort()) === JSON.stringify([...accelIds].sort()),
    "Pro and Accelerator share one roster today — read live, so the day they diverge the hub follows");

  // -------------------------------------------------------------------------
  console.log(`\n=== 6. STARTER ASKS ITS OWN QUESTION ===`);
  const starter = await productAvailability({
    productId: ARYEO_CONTENT_PRODUCTS.Starter.productId,
    durationMin: ARYEO_CONTENT_PRODUCTS.Starter.durationMinutes,
    days: 21, interval: 30,
  });
  const starterSlots = (starter?.days ?? []).reduce((n, d) => n + d.slots.length, 0);
  console.log(`   Starter 120min: ${(starter?.days ?? []).length} days, ${starterSlots} starts`);
  const newSlots = (accel?.days ?? []).reduce((n, d) => n + d.slots.length, 0);
  console.log(`   Accelerator 240min: ${(accel?.days ?? []).length} days, ${newSlots} starts`);
  check(starterSlots >= newSlots,
    "a 2-hour session fits in at least as many places as a 4-hour one — which is why the no-argument default (240) UNDER-offers a Starter client rather than over-offering",
    `${starterSlots} vs ${newSlots}`);

  // -------------------------------------------------------------------------
  console.log(`\n=== 7. THE PORTAL PATH ITSELF (A22's "no weekend slots", end to end) ===`);
  // programSlotDays upserts an AppSetting cache; under this drill's read-only
  // guard that upsert is refused and swallowed, so the call still answers and
  // nothing is written. That is why it is safe to exercise the real function
  // here rather than a copy of it.
  const { programSlotDays, companySlotDays } = await import("../../src/lib/portal");
  for (const pkg of ["Starter", "Accelerator", "Pro"]) {
    const days = await programSlotDays({ package: pkg });
    const total = days.reduce((n, d) => n + d.slots.length, 0);
    const weekend = days.filter((d) => dow(d.date) === "Sat" || dow(d.date) === "Sun");
    console.log(`   ${pkg.padEnd(12)} ${days.length} days, ${total} starts, fits ${days[0]?.fitsMinutes ?? "?"} min, creatives: ${days[0]?.creatives?.join(", ") ?? "—"}`);
    check(weekend.length === 0, `${pkg}: the portal offers no weekend day`);
    check(days.every((d) => (d.creatives ?? []).every((c) => c !== "Harrison Wells")),
      `${pkg}: no day is offered on Harrison's availability`);
  }
  const unknownPkg = await programSlotDays({ package: "Enterprise" });
  check(unknownPkg.length === 0,
    "an unknown package is offered NOTHING — it no longer falls through to the company-wide list");
  const dflt = await companySlotDays();
  check(dflt.every((d) => d.fitsMinutes === 240),
    "the no-argument default asks for 240 minutes, the longest program session — under-offering, never over-offering",
    `${dflt.length} days`);
  const { sessionSlotRefusal, isWeekendET } = await import("../../src/lib/portal");
  // 2026-09-26 is a Saturday in ET; Aryeo offered 14 four-hour slots on it.
  check(sessionSlotRefusal(new Date("2026-09-26T16:00:00Z")) !== null,
    "a Saturday slot posted straight at the server is refused in words a client can read",
    sessionSlotRefusal(new Date("2026-09-26T16:00:00Z")) ?? "");
  check(sessionSlotRefusal(new Date("2026-09-28T16:00:00Z")) === null, "a Monday slot is accepted");
  // The ET boundary: 00:30 ET Saturday is Friday 04:30 UTC.
  check(isWeekendET(new Date("2026-09-26T04:30:00Z")),
    "the weekend test reads the CLIENT'S calendar — 00:30 ET Saturday is Saturday, not Friday");
  const starterCall = await companySlotDays({ package: "Starter" });
  check(starterCall.every((d) => d.fitsMinutes === 120),
    "…and a caller that CAN say the package gets that package's own calendar (the PortalPage.tsx one-liner)",
    `${starterCall.reduce((n, d) => n + d.slots.length, 0)} starts vs ${dflt.reduce((n, d) => n + d.slots.length, 0)} on the default`);

  console.log(`\n=== ${checks - failures}/${checks} checks passed ===`);
  if (failures) process.exitCode = 1;
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
