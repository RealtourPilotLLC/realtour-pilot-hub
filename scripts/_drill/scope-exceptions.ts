// ---------------------------------------------------------------------------
// DRILL SCOPE-EXCEPTIONS: what the order actually asked for (§10 AU-01 / H1 /
// B1). Unified handoff, batch 5, Sep 26 2026.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/scope-exceptions.ts
//
// Drives the SHIPPED code against an isolated PGlite on 127.0.0.1:5789 (or
// DRILL_PORT), and opsExceptions.ts as it was at 17df024 (never HEAD) for the
// old behaviour. Production is never opened; every outbound call is fenced.
//
//   §0  old code (17df024): a product nobody mapped was parsed silently
//   §1  one mapped product + one unmapped + a travel fee = exactly ONE row,
//       one row per TITLE across jobs; mapping it clears it on the next read
//   §2  only live jobs: delivered, cancelled and parked jobs are not chased
//   §3  an owed OTHER line with no lane is listed; an unmapped one is the
//       title's row, not a second; a tracked special correction is its task's
//   §4  honest totals when the cap bites
//   §5  prerequisites: owner-only list, mapped products only, per job
//   §6  it only reports: nothing written, nothing blocked; fences
//
// THE CLOCK IS PINNED to Saturday Sep 26 2026, 7:30 PM ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5789);
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");

const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 26, 23, 30, 0); // Sat Sep 26 2026 19:30 EDT
const clockOffsetMs = PARK - RealDate.now();
const drillNow = () => RealDate.now() + clockOffsetMs;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(drillNow());
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return drillNow;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

installNextStubs();
const fence = fenceFetch();

const BASE_DIR = path.join(REPO, "node_modules/.cache", `scope-baseline-${BASE}`);
function baseline(rel: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const out = path.join(BASE_DIR, rel.replace(/[/[\]]/g, "_"));
  fs.writeFileSync(out, src.replace(/(["'])@\//g, `$1${REPO}/src/`));
  return out;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { etAt } = await import("@/lib/datetime");
  const { setSession } = await import("@/lib/auth/session");
  const { opsExceptionsBoard, orderScopeExceptions } = await import("@/lib/opsExceptions");
  const { isMapped, loadManualProductMap, deliverablesForTitle } = await import("@/lib/integrations/aryeo");
  const prereq = await import("@/app/settings/products/prerequisites.actions");
  const { missingPrerequisites } = await import("@/lib/productPrerequisites");
  const oldBoard = (await import(baseline("src/lib/opsExceptions.ts"))) as typeof import("@/lib/opsExceptions");

  const et = (month: number, day: number, hour: number, minute = 0) =>
    etAt(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, hour, minute);
  const now = () => new Date();

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan-tm@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle-tm@drill.invalid", role: "MANAGER" }, select: { id: true } });
  const jordan = await prisma.appUser.create({ data: { email: "jordan@drill.invalid", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE", teamMemberId: jordanTm.id }, select: { id: true, email: true, name: true, role: true } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle@drill.invalid", name: "Kyle Cabrera", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id }, select: { id: true, email: true, name: true, role: true } });
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });

  // The mapped product — hand-set on Settings → Products.
  const MAPPED = "Drill Signature Reel";
  const UNMAPPED = "Moonlit Garden Showcase";
  const mappedProduct = await prisma.product.create({ data: { aryeoId: "drill-p1", title: MAPPED, mediaTypes: JSON.stringify(["SOCIAL_REEL"]), videoTier: "standard", mappedAt: now() }, select: { id: true } });
  // Aryeo knows the unmapped product too; nobody has said what it makes.
  const unmappedProduct = await prisma.product.create({ data: { aryeoId: "drill-p2", title: UNMAPPED }, select: { id: true } });
  await loadManualProductMap(true);

  let seq = 0;
  const mkJob = async (o: { street: string; status?: string; items: string[]; shootDate?: Date | null; addressLine?: string | null; other?: { productTitle: string | null; label: string }[] }) => {
    const p = await prisma.project.create({
      data: {
        title: `${o.street}, Royersford, PA`, clientId: client.id, status: (o.status ?? "SCHEDULED") as "SCHEDULED", aryeoOrderId: `drill-scope-${++seq}`,
        shootDate: o.shootDate === undefined ? et(9, 30, 10) : o.shootDate, photographerId: harrison.id,
        addressLine: o.addressLine === undefined ? o.street : o.addressLine,
      },
      select: { id: true },
    });
    for (const t of o.items) await prisma.orderItem.create({ data: { projectId: p.id, title: t, amount: 100 } });
    for (const d of o.other ?? []) await prisma.deliverable.create({ data: { projectId: p.id, type: "OTHER", label: d.label, productTitle: d.productTitle, quantity: 1 } });
    return p.id;
  };
  const scopeRows = async () => (await opsExceptionsBoard({ now: now() })).rows.filter((r) => r.kind === "unmapped-scope" || r.kind === "other-output" || r.kind === "missing-prerequisite");

  await mkJob({ street: "1 Ash St", items: [MAPPED, UNMAPPED, "Travel Fee"] });

  // =========================================================================
  c.head(`§0 · old code (${BASE}): a product nobody mapped was parsed silently`);
  // =========================================================================
  {
    const guess = deliverablesForTitle(UNMAPPED).map((d) => d.type).join(",");
    c.ok(`the sync still guesses from the name ("${UNMAPPED}" → ${guess})`, isMapped(MAPPED) && !isMapped(UNMAPPED) && guess.length > 0, guess);
    const old = await oldBoard.opsExceptionsBoard({ now: now() });
    c.ok("the old board said nothing about it", !old.rows.some((r) => /Moonlit/.test(r.title) || /Moonlit/.test(r.why)), `${old.rows.length} rows`);
  }

  // =========================================================================
  c.head("§1 · exactly one row per unmapped title; mapping clears it");
  // =========================================================================
  {
    const rows = await scopeRows();
    const unmapped = rows.filter((r) => r.kind === "unmapped-scope");
    c.ok("mapped product + unmapped product + travel fee on one order = exactly ONE unmapped row", unmapped.length === 1 && unmapped[0].title === `“${UNMAPPED}”`, unmapped.map((r) => r.title).join(" | "));
    c.ok("…owned by Kyle, one next action, linked to that product's card", unmapped[0]?.owner === "Kyle" && /Map it on Settings → Products/.test(unmapped[0].nextAction) && unmapped[0].href === `/settings/products#${unmappedProduct.id}`, unmapped[0]?.href);
    c.ok("…medium before the shoot (still time to map it)", unmapped[0]?.severity === "medium");
    await mkJob({ street: "2 Birch St", items: [UNMAPPED], status: "SHOT" });
    const rows2 = (await scopeRows()).filter((r) => r.kind === "unmapped-scope");
    c.ok("a second job with the same product: still ONE row, now naming both jobs — and high, because one is in production",
      rows2.length === 1 && /On 2 live jobs \(1 Ash St, 2 Birch St\)/.test(rows2[0].why) && rows2[0].severity === "high", rows2[0]?.why);
    const again = (await scopeRows()).filter((r) => r.kind === "unmapped-scope");
    c.ok("a re-read writes nothing and finds the same one row (nothing is stored)", again.length === 1 && again[0].id === rows2[0].id);
    await prisma.product.update({ where: { id: unmappedProduct.id }, data: { mediaTypes: JSON.stringify(["TWILIGHT"]), mappedAt: now() } });
    const cleared = (await scopeRows()).filter((r) => r.kind === "unmapped-scope");
    c.ok("Kyle maps it: the row is gone on the very next read (not five minutes later)", cleared.length === 0, cleared.map((r) => r.title).join(" | "));
    await prisma.product.update({ where: { id: unmappedProduct.id }, data: { mediaTypes: null, mappedAt: null } });
  }

  // =========================================================================
  c.head("§2 · only live jobs");
  // =========================================================================
  {
    const LATE = "Delivered Only Package Thing";
    await mkJob({ street: "3 Cedar St", items: [LATE], status: "DELIVERED" });
    await mkJob({ street: "4 Dogwood St", items: [LATE], status: "CANCELLED" });
    await mkJob({ street: "5 Elm St", items: [LATE], status: "ON_HOLD" });
    const rows = (await scopeRows()).filter((r) => r.kind === "unmapped-scope");
    c.ok("a delivered, a cancelled and a parked job are not chased", !rows.some((r) => r.title.includes(LATE)), rows.map((r) => r.title).join(" | "));
    const lost = await mkJob({ street: "6 Fir St", items: ["Lost Order Product"], status: "SCHEDULED" });
    await prisma.project.update({ where: { id: lost }, data: { aryeoMissingAt: now() } });
    c.ok("nor an order Aryeo has lost", !(await scopeRows()).some((r) => r.title.includes("Lost Order Product")));
    const moved = await mkJob({ street: "7 Gum St", items: ["2D Floorplan - Moved to Order#1611", "Rush Fee", "Discount"], status: "SCHEDULED" });
    c.ok("'Moved to Order #N' lines, fees and discounts are not work to map", !(await scopeRows()).some((r) => r.why.includes("7 Gum St")), String(moved));
  }

  // =========================================================================
  c.head("§3 · an owed OTHER line with no lane");
  // =========================================================================
  let lotJob = "";
  {
    await prisma.product.create({ data: { aryeoId: "drill-p3", title: "Lot Lines", mediaTypes: JSON.stringify(["OTHER"]), mappedAt: now() } });
    lotJob = await mkJob({ street: "8 Hazel St", items: [MAPPED, "Lot Lines"], other: [{ productTitle: "Lot Lines", label: "Lot Lines" }] });
    const rows = (await scopeRows()).filter((r) => r.kind === "other-output");
    c.ok("a mapped 'Lot Lines' line that resolved to OTHER is listed on its job", rows.length === 1 && rows[0].title === "8 Hazel St" && /Lot Lines is owed, and no lane makes it/.test(rows[0].why), rows[0]?.why);
    await mkJob({ street: "9 Ivy St", items: [UNMAPPED], other: [{ productTitle: UNMAPPED, label: UNMAPPED }] });
    const rows2 = await scopeRows();
    c.ok("an OTHER row from an UNMAPPED product is the title's row, not a second item", !rows2.some((r) => r.kind === "other-output" && r.title === "9 Ivy St") && rows2.some((r) => r.kind === "unmapped-scope" && /9 Ivy St/.test(r.why)));
    const { recordAssetDependency } = await import("@/lib/assetDependencies");
    await recordAssetDependency({ projectId: lotJob, category: "OTHER", slug: "lot-lines-plat", need: "the recorded plat or survey for the lot lines", interpretation: { what: "Draw the lot lines from the attached plat or survey", ownerKey: "jordan" }, by: "system" });
    c.ok("once the special correction is tracked (its find-the-file task), the row is that task's", !(await scopeRows()).some((r) => r.kind === "other-output" && r.title === "8 Hazel St"));
  }

  // =========================================================================
  c.head("§4 · honest totals when the cap bites");
  // =========================================================================
  {
    for (let i = 1; i <= 6; i++) await mkJob({ street: `${20 + i} Cap Row`, items: [`Unmapped Oddity ${i}`] });
    const board = await opsExceptionsBoard({ now: now() });
    const shown = board.rows.filter((r) => r.kind === "unmapped-scope").length;
    const t = board.totals["unmapped-scope"];
    c.ok("four rows shown (the per-kind cap), and the total says how many there really are", shown === 4 && t.all === 7 && t.high === 1, `shown ${shown} · all ${t.all} · high ${t.high}`);
    const direct = await orderScopeExceptions({ now: now(), cap: 50 });
    c.ok("…the same predicate uncapped returns all seven", direct.rows.filter((r) => r.kind === "unmapped-scope").length === 7);
  }

  // =========================================================================
  c.head("§5 · what a product needs first");
  // =========================================================================
  {
    c.ok("the checks, pure: street number or coordinates; discovery needs a record",
      missingPrerequisites(["exact_address"], { shootDate: null, addressLine: "Royersford, PA", lat: null, lng: null, photographerId: null, reelScript: null, reelHook: null, discoveryDone: null }).join() === "exact_address" &&
        missingPrerequisites(["exact_address"], { shootDate: null, addressLine: null, lat: 40.1, lng: -75.5, photographerId: null, reelScript: null, reelHook: null, discoveryDone: null }).length === 0 &&
        missingPrerequisites(["brand_discovery"], { shootDate: null, addressLine: null, lat: null, lng: null, photographerId: null, reelScript: null, reelHook: null, discoveryDone: null }).join() === "brand_discovery");
    await as(kyle);
    const k0 = await prereq.loadProductPrerequisites(mappedProduct.id);
    const k1 = await prereq.saveProductPrerequisites(mappedProduct.id, ["shoot_date"]);
    c.ok("Kyle can read the list but not change it", k0.ok && !k0.canEdit && !k1.ok && /Only Jordan/.test(k1.message), k1.message);
    await as(jordan);
    const j0 = await prereq.loadProductPrerequisites(mappedProduct.id);
    const bad = await prereq.saveProductPrerequisites(mappedProduct.id, ["shoot_date", "moon_phase"]);
    const j1 = await prereq.saveProductPrerequisites(mappedProduct.id, ["brand_discovery", "shoot_date", "exact_address"]);
    const stored = await prisma.product.findUnique({ where: { id: mappedProduct.id }, select: { prerequisitesJson: true } });
    c.ok("Jordan can; an unknown key is refused; the list is stored in its own order", j0.canEdit && !bad.ok && j1.ok && stored?.prerequisitesJson === JSON.stringify(["shoot_date", "exact_address", "brand_discovery"]), stored?.prerequisitesJson ?? "");
    await prisma.product.update({ where: { id: unmappedProduct.id }, data: { prerequisitesJson: JSON.stringify(["shoot_date"]) } });

    const noShoot = await mkJob({ street: "30 Prereq Way", items: [MAPPED], shootDate: null, addressLine: "Royersford, PA" });
    const rows = (await scopeRows()).filter((r) => r.kind === "missing-prerequisite");
    const mine = rows.find((r) => r.title === "30 Prereq Way");
    c.ok("a live job with the product and no shoot, no exact address and no discovery on record: one row naming all three", !!mine && /Drill Signature Reel: no shoot date, no exact address, brand discovery not done/.test(mine.why) && mine.owner === "Kyle", mine?.why);
    c.ok("…and it blocks nothing: the next action says so", /nothing is blocked/.test(mine?.nextAction ?? ""));
    c.ok("1 Ash St (shoot booked, street address) is missing only discovery", (rows.find((r) => r.title === "1 Ash St")?.why ?? "").endsWith("brand discovery not done"), rows.find((r) => r.title === "1 Ash St")?.why);
    c.ok("an UNMAPPED product's list is ignored (it is its own row first)", !rows.some((r) => r.title === "2 Birch St"));
    await prisma.programOnboarding.create({ data: { enrollmentId: "drill-enrollment", clientId: client.id, status: "DISCOVERY_HELD" } });
    await prisma.project.update({ where: { id: noShoot }, data: { shootDate: et(9, 27, 10), addressLine: "30 Prereq Way" } });
    const rows2 = (await scopeRows()).filter((r) => r.kind === "missing-prerequisite");
    c.ok("discovery held, a shoot booked for tomorrow and a real address: every row clears", rows2.length === 0, rows2.map((r) => `${r.title}: ${r.why}`).join(" | "));
    await prisma.project.update({ where: { id: noShoot }, data: { addressLine: "Royersford, PA", lat: null, lng: null } });
    const rows3 = (await scopeRows()).filter((r) => r.kind === "missing-prerequisite");
    c.ok("the shoot is tomorrow and the address is still vague: high", rows3.length === 1 && rows3[0].severity === "high" && /no exact address$/.test(rows3[0].why), rows3[0]?.why);
  }

  // =========================================================================
  c.head("§6 · it only reports; fences");
  // =========================================================================
  {
    const counts = async () => JSON.stringify([await prisma.smartTask.count(), await prisma.activity.count(), await prisma.notification.count(), await prisma.deliverable.count(), await prisma.project.findMany({ orderBy: { id: "asc" }, select: { status: true, updatedAt: true } })]);
    const before = await counts();
    await opsExceptionsBoard({ now: now() });
    await opsExceptionsBoard({ now: now() });
    c.ok("two board reads wrote nothing and moved no job", (await counts()) === before);
    c.ok("the special-correction tasks from §3 are the only tasks in the building (the board made none)", (await prisma.smartTask.count()) === 2);
  }
  c.ok("no outbound call left the building", fence.blocked.length === 0, fence.blocked.join(", "));
  void lotJob;

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
