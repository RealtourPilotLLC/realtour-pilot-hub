// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: how many staged photos were ordered (Oct 23 2026).
//
//   DRILL_PORT=7101 node scripts/_drill/run-all.cjs scripts/_drill/oct23-staging-count.ts
//
// Jordan: "Virtual staging should have a qty amount unless its a custom item
// saying virtual staging and how many." The photo audit had assumed one
// Virtual Staging line buys 3 staged photos; it does not.
//
//   1 · pure (lib/stagingCount): the catalog line's quantity; a custom line's
//       stated number ("Virtual Staging - 5 photos", "5 virtually staged
//       photos"); a custom line with no number and quantity 1 is NOT KNOWN;
//       decluttering is not staging; never 3 per line
//   2 · the office line (briefPhotoAsks.officeWhy): "More than the 1 staged
//       photo ordered", or "not how many photos" when the order does not say
//   3 · every place agrees on one job each: what was ordered on the photo job
//       (expectedFor), the "Virtual Staging needed" hold (addOns) and its
//       checklist line, the photo part of a client's message (dry run)
//   4 · an order that does not say how many: staged images on the listing do
//       not clear the hold by a count; the coverage panel never shows
//       "of … ordered" for it
//
// ISOLATION: PGlite via the shared harness; nothing leaves (fenced fetch).
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const LONG_DASH = /[–—]/;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7101) });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const S = await import("@/lib/stagingCount");
    const A = await import("@/lib/photoDelivery/addOns");
    const { officeWhy, routeBriefPhotoAsks } = await import("@/lib/briefPhotoAsks");
    const { expectedFor } = await import("@/lib/photoDelivery/jobs");
    const delivery = await import("@/lib/photoDelivery/delivery");

    // ======================================================================
    c.head("1 · pure: the line's quantity, or a custom line's stated number; never 3 per line");
    // ======================================================================
    const one = (title: string, quantity = 1) => S.stagedPhotosOrdered([{ title, quantity }], []);
    c.ok("the catalog 'Virtual Staging', quantity 1: 1 staged photo (859 N Lawrence St), not 3", one("Virtual Staging").count === 1 && one("Virtual Staging").lines[0].how === "quantity");
    c.ok("…quantity 3: 3; quantity 16: 16", one("Virtual Staging", 3).count === 3 && one("Virtual Staging", 16).count === 16);
    c.ok("a custom line 'Virtual Staging - 5 photos' (quantity 1): 5", one("Virtual Staging - 5 photos").count === 5 && one("Virtual Staging - 5 photos").lines[0].how === "title");
    c.ok("'5 virtually staged photos': 5; 'Virtual Staging (4)': 4; 'Virtual Staging x6': 6; 'Virtual staging: two rooms': 2", one("5 virtually staged photos").count === 5 && one("Virtual Staging (4)").count === 4 && one("Virtual Staging x6").count === 6 && one("Virtual staging: two rooms").count === 2);
    c.ok("'pics + 3 virtual staging' (the books' wording): 3", S.countInTitle("pics + 3 virtual staging") === 3);
    const unk = one("Virtual Staging (Discounted)");
    c.ok("a custom line with no number, quantity 1: NOT KNOWN (null), so the office is asked", unk.ordered && unk.count === null && unk.known === 0 && unk.lines[0].how === "not stated", JSON.stringify(unk));
    c.ok("…the same custom line with quantity 3: 3 (its quantity)", one("Virtual Staging (Discounted)", 3).count === 3);
    c.ok("money and street numbers are never a count ('Virtual Staging $25', 'Virtual Staging for 123 Main St')", one("Virtual Staging $25 each").count === null && one("Virtual Staging for 123 Main St").count === null && S.countInTitle("Virtual Staging (Stephen K Price)") === null);
    c.ok("two lines add up (Virtual Staging × 2 + 'Virtual Staging - 3 photos' = 5)", S.stagedPhotosOrdered([{ title: "Virtual Staging", quantity: 2 }, { title: "Virtual Staging - 3 photos", quantity: 1 }], []).count === 5);
    c.ok("…one line that does not say makes the whole count not known (the known part kept)", (() => { const s = S.stagedPhotosOrdered([{ title: "Virtual Staging", quantity: 2 }, { title: "Virtual staging extra", quantity: 1 }], []); return s.count === null && s.known === 2; })());
    c.ok("a canceled line is not counted; no staging: not ordered, 0", S.stagedPhotosOrdered([{ title: "Virtual Staging", quantity: 2, isCanceled: true }], []).ordered === false && S.stagedPhotosOrdered([{ title: "Standard Package" }], []).count === 0);
    c.ok("Virtual Decluttering is not staging, even on a VIRTUAL_STAGING row labelled 'Virtual Staging'", !S.stagedPhotosOrdered([{ title: "Virtual Decluttering" }], [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Decluttering", label: "Virtual Staging", quantity: 1 }]).ordered);
    c.ok("no order lines stored: the VIRTUAL_STAGING deliverable's quantity (2)", S.stagedPhotosOrdered([], [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging", label: "Virtual Staging", quantity: 2 }]).count === 2);
    c.ok("a staging deliverable waived by the office, nothing live: not owed, whatever the line says", !S.stagedPhotosOrdered([{ title: "Virtual Staging", quantity: 2 }], [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging", label: "Virtual Staging", quantity: 2, waivedAt: new Date() }]).ordered);
    c.ok("the order's lines beat the merged deliverable (line quantity 3, deliverable 1)", S.stagedPhotosOrdered([{ title: "Virtual Staging", quantity: 3 }], [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging", label: "Virtual Staging", quantity: 1 }]).count === 3);
    c.ok("words: '1 staged photo', '5 staged photos', 'how many staged photos is not on the order'", S.stagedCountWords({ count: 1 }) === "1 staged photo" && S.stagedCountWords({ count: 5 }) === "5 staged photos" && S.stagedCountWords({ count: null }) === "how many staged photos is not on the order");
    const src = readFileSync("src/lib/briefPhotoAsks.ts", "utf8") + readFileSync("src/lib/photoDelivery/addOns.ts", "utf8") + readFileSync("src/lib/photoDelivery/jobs.ts", "utf8");
    c.ok("no '3 per line' left anywhere that counts staged photos", !/STAGED_PHOTOS_PER_LINE|\*\s*3\b/.test(src));

    // ======================================================================
    c.head("2 · the office line says the order's own count, or that it does not say");
    // ======================================================================
    c.ok("'More than the 1 staged photo ordered'", officeWhy(["Virtually stage the upper patio (photo 38)"], 1) === "More than the 1 staged photo ordered: confirm the scope or price with the client first.");
    c.ok("not known: 'Virtual staging is on the order, but not how many photos'", officeWhy(["Virtually stage photo 38"], null) === "Virtual staging is on the order, but not how many photos: confirm the count, scope or price with the client first.");
    c.ok("no staging on the order, or other new work: 'Not on the order'", /^Not on the order/.test(officeWhy(["Virtually stage photo 12"], 0)) && /^Not on the order/.test(officeWhy(["Add a twilight edit"], null)));

    // ======================================================================
    c.head("3 · one job each, every place agrees");
    // ======================================================================
    const client = await prisma.client.create({ data: { name: "Joseph Drill" } });
    const shot = new Date(Date.now() - 2 * 86_400_000);
    const mk = async (street: string, lines: { title: string; quantity: number }[], deliverables: { type: string; productTitle?: string | null; label?: string | null; quantity?: number }[]) => {
      const project = await prisma.project.create({
        data: {
          title: `${street}, Philadelphia, PA`, addressLine: street, clientId: client.id, status: "EDITING", shootDate: shot,
          orderItems: { create: lines.map((l) => ({ ...l, amount: 90 })) },
          deliverables: { create: [{ type: "PHOTOS", label: "Photos", productTitle: "Standard Package" }, ...deliverables] },
        } as never,
      });
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "READY" } });
      return { project, job };
    };
    const lawrence = await mk("859 Drill Lawrence St", [{ title: "Standard Package", quantity: 1 }, { title: "Virtual Staging", quantity: 1 }], [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging", label: "Virtual Staging", quantity: 1 }]);
    const five = await mk("5 Custom Ln", [{ title: "Standard Package", quantity: 1 }, { title: "Virtual Staging - 5 photos", quantity: 1 }], [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging - 5 photos", label: "Virtual Staging", quantity: 1 }]);
    const vague = await mk("9 Vague Ct", [{ title: "Standard Package", quantity: 1 }, { title: "Virtual Staging (Discounted)", quantity: 1 }], [{ type: "VIRTUAL_STAGING", productTitle: "Virtual Staging (Discounted)", label: "Virtual Staging (Discounted)", quantity: 1 }]);

    const eL = await expectedFor(lawrence.project.id);
    const e5 = await expectedFor(five.project.id);
    const eV = await expectedFor(vague.project.id);
    c.ok("what was ordered on the photo job: 1 (the line's quantity), 5 (the custom line's number)", eL.virtualStagingCount === 1 && !eL.virtualStagingUnknown && e5.virtualStagingCount === 5 && !e5.virtualStagingUnknown, JSON.stringify([eL.virtualStagingCount, e5.virtualStagingCount, e5.source.virtualStagingCount]));
    c.ok("…the vague custom line: not known (flagged), no count guessed", eV.virtualStagingUnknown === true && eV.virtualStagingCount === 0, JSON.stringify(eV));

    const oL = A.addOnsOrdered([{ title: "Virtual Staging", quantity: 1 }], []);
    const o5 = A.addOnsOrdered([{ title: "Virtual Staging - 5 photos", quantity: 1 }], []);
    const oV = A.addOnsOrdered([{ title: "Virtual Staging (Discounted)", quantity: 1 }], []);
    c.ok("the hold: 'Virtual Staging (1 staged photo)', 'Virtual Staging - 5 photos (5 staged photos)'", oL[0]?.quantity === 1 && oL[0].line === "Virtual Staging (1 staged photo)" && o5[0]?.quantity === 5 && o5[0].line === "Virtual Staging - 5 photos (5 staged photos)", JSON.stringify([oL, o5].map((o) => o[0]?.line)));
    c.ok("…the vague one: quantity null, the line says the count is not on the order", oV[0]?.quantity === null && /how many staged photos is not on the order/.test(oV[0].line), oV[0]?.line);

    const g5 = await delivery.deliveryGate(five.job.id);
    const line5 = g5.checks.find((x) => x.key === "addon:virtual_staging");
    c.ok("the checklist line: 'Virtual Staging needed', Ordered: … (5 staged photos)", !!line5 && line5.label === "Virtual Staging needed" && line5.ok === false && /Ordered: Virtual Staging - 5 photos \(5 staged photos\)/.test(line5.detail ?? ""), line5?.detail);

    // The photo part of a client's message, dry run: the office line's count is the order's.
    const brief = async (projectId: string) =>
      prisma.revisionBrief.create({
        data: {
          projectId, source: "openphone", originalText: "Can you also virtually stage the upper patio in pic 38?", requestedBy: "Joseph Drill",
          itemsJson: JSON.stringify({ items: [{ id: "i1", area: "Photos", ask: "Virtually stage the upper patio (photo 38)", kind: "SCOPE", medium: "photo", quote: "virtually stage the upper patio in pic 38" }] }),
        },
      });
    const pL = await routeBriefPhotoAsks((await brief(lawrence.project.id)).id, { dryRun: true });
    const pV = await routeBriefPhotoAsks((await brief(vague.project.id)).id, { dryRun: true });
    const offL = pL?.steps.find((s) => s.what === "office");
    const offV = pV?.steps.find((s) => s.what === "office");
    c.ok("a client's staging ask on 859's order: 'More than the 1 staged photo ordered' (was 'the 3')", !!offL && /More than the 1 staged photo ordered: confirm the scope or price/.test(offL.summary) && !/\b3 staged/.test(offL.summary), offL?.summary);
    c.ok("…on the vague order: 'on the order, but not how many photos'", !!offV && /Virtual staging is on the order, but not how many photos/.test(offV.summary), offV?.summary);
    c.ok("…a dry run writes nothing", (await prisma.clientAsk.count()) === 0);

    // ======================================================================
    c.head("4 · not known: the listing never clears it by a count; the panel never says 'of … ordered'");
    // ======================================================================
    await prisma.photoAsset.create({ data: { jobId: vague.job.id, name: "Virtually Staged Living Room.jpg", sourceKind: "ARYEO", sourceRef: "vs-1", contentHash: "vs-1", sequence: 0, status: "ON_LISTING" } });
    await prisma.photoAsset.create({ data: { jobId: lawrence.job.id, name: "Virtually Staged Living Room.jpg", sourceKind: "ARYEO", sourceRef: "vs-2", contentHash: "vs-2", sequence: 0, status: "ON_LISTING" } });
    const sV = (await A.addOnStates(vague.project.id, vague.job.id))[0];
    const sL = (await A.addOnStates(lawrence.project.id, lawrence.job.id))[0];
    c.ok("859's 1 ordered, 1 staged image on the listing: cleared ('listing')", sL?.cleared?.how === "listing", JSON.stringify(sL?.cleared));
    c.ok("the vague order with a staged image on the listing: still 'Virtual Staging needed' (Kyle confirms)", !!sV && !sV.cleared, JSON.stringify(sV));
    const open = await A.openAddOnsByProject([vague.project.id, lawrence.project.id]);
    c.ok("…the boards agree (vague open, 859 clear)", open.get(vague.project.id)?.[0] === "Virtual Staging needed" && !open.has(lawrence.project.id));
    const panel = readFileSync("src/components/photoDelivery/CoveragePanel.tsx", "utf8");
    c.ok("the coverage panel reads 'of N ordered' only for a number", /\/\^\\d\+\$\/\.test\(want\.get\("Virtually staged photos"\)/.test(panel));

    c.head("plain words");
    c.ok("no em or en dashes in what Kyle reads", !LONG_DASH.test(JSON.stringify([oL, o5, oV].map((o) => o[0]?.line)) + officeWhy(["stage"], null) + officeWhy(["stage"], 1) + S.stagedCountWords({ count: null })));

    c.head("isolation");
    c.ok("nothing left the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
