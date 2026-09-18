/**
 * THE RECONCILIATION REPORT — RTP-03 / RTP-05 / RTP-24, Phase 0 (Sep 16 2026).
 *
 * Read-only. Writes NOTHING, to the database or to Dropbox, and sends nothing.
 * It answers the one question docs/COMPLETION-CONTRACT.md cannot answer on its
 * own: if the hub counted completion per DELIVERABLE SLOT instead of per coarse
 * category, which jobs would change, and how far?
 *
 *   export PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH
 *   npx tsx --env-file=.env scripts/evidence-reconcile.ts
 *
 * Options
 *   --since=YYYY-MM-DD   only projects created on/after this date
 *   --list=N             how many example jobs to print per group (default 12)
 *   --all                print every affected job, not the first N
 *   --json=<path>        also write the whole reconciliation as JSON
 *
 * The last section re-measures the three numbers the Sep 16 verification
 * predicted — 11 jobs moving from DELIVERED to APPROVED on their video unit,
 * ~55 photo add-on units moving from DONE to UNKNOWN, and Erica Walker's August
 * moving from 4/5 to 1/5 — and prints the affected job ids and streets, so the
 * sign-off is on figures Jordan can check rather than on a promise.
 *
 * ---------------------------------------------------------------------------
 * SECOND MODE: --delivery, THE DELIVERY RECONCILIATION (Sep 18 2026).
 *
 * The report above reads the CACHED evidence blob, which is the right source
 * for "what would the slot model say" and the wrong one for "did this client
 * get their video". The hourly sweep stops carrying a job seven days after
 * delivery, so on a delivered job the Aryeo half of that blob is frozen — and a
 * frozen `videos: 0` reads exactly like a confident one. Run off the cache on
 * Sep 17, the fourteen-job reconciliation reported sixteen jobs owed; thirteen
 * of them already had the video on the listing.
 *
 *   npx tsx --env-file=.env scripts/evidence-reconcile.ts --delivery
 *   npx tsx --env-file=.env scripts/evidence-reconcile.ts --delivery --write-exceptions
 *
 *   --delivery            classify every job with an internal reason to doubt
 *                         its delivery, using a LIVE Aryeo listing read each
 *                         (read-only; prints what it WOULD flag)
 *   --write-exceptions    also raise Project.deliveryExceptionAt/Note on the
 *                         jobs that earn one. That is the only write either
 *                         mode of this script can make. It is a flag, never an
 *                         action: no status moves, no deliveredAt is rewritten,
 *                         no task is created or closed, no client is contacted.
 *                         The before/after block at the end proves it.
 *   --include-test        include synthetic TEST jobs (default: skipped)
 *   --limit=N             cap the live listing reads
 *   --selftest            run the classifier's branches against fixtures — no
 *                         database, no Aryeo, no network at all
 */
import { prisma } from "@/lib/prisma";
import {
  eachProjectUnits,
  isOwed,
  isDeliveredUnit,
  categoryWord,
  PHOTO_LANE,
  RECONCILE_STALE_HOURS,
  type ProjectUnits,
  type Unit,
  type UnitState,
} from "@/lib/evidenceUnits";
import {
  reconcileDeliveries,
  raiseDeliveryException,
  classifyDelivery,
  laneLabel,
  type DeliveryClassification,
  type DeliveryInput,
  type ListingRead,
} from "@/lib/deliveryExceptions";
import { writeFileSync } from "fs";

const argv = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const LIST = argv.includes("--all") ? Number.MAX_SAFE_INTEGER : Number(argOf("list") ?? 12);
const SINCE = argOf("since") ? new Date(`${argOf("since")}T00:00:00Z`) : null;
const JSON_OUT = argOf("json");
const DELIVERY = argv.includes("--delivery");
const WRITE_EXCEPTIONS = argv.includes("--write-exceptions");
const INCLUDE_TEST = argv.includes("--include-test");
const READ_LIMIT = argOf("limit") ? Number(argOf("limit")) : undefined;
const SELFTEST = argv.includes("--selftest");

type Row = {
  projectId: string;
  street: string;
  status: string;
  deliveredAt: string | null;
  deliverableId: string;
  slot: number;
  category: string;
  label: string;
  todayRowStatus: string;
  newState: UnitState;
  source: string;
  reason: string;
};

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const num = (n: number, w = 5) => String(n).padStart(w);

async function main() {
  const started = Date.now();
  const stateCount: Record<string, number> = {};
  const unknownBySource: Record<string, number> = {};
  const stateByCategory = new Map<string, Record<string, number>>();
  const todayVsNew = new Map<string, number>(); // "DONE→UNKNOWN" → n

  // The disagreement groups.
  const jobDeliveredUnitNot: { p: ProjectUnits; u: Unit }[] = [];
  const rowDoneUnitUnknown: { p: ProjectUnits; u: Unit }[] = [];
  const rowDoneStillOwed: { p: ProjectUnits; u: Unit }[] = [];
  const rowNotDoneUnitDelivered: { p: ProjectUnits; u: Unit }[] = [];
  const untrustedReads = new Map<string, { p: ProjectUnits; n: number }>();
  // The asymmetry, measured: positive evidence that is old but stands (a
  // delivery does not undo itself) against the absences that no longer do.
  const staleDelivered = { units: 0, jobs: new Set<string>() };
  const ageBuckets: Record<string, number> = {};
  const allRows: Row[] = [];

  // Headline 1: a DELIVERED job whose VIDEO unit the evidence cannot call
  // delivered. Grouped by where the video unit actually lands.
  const videoShortfall = new Map<string, { p: ProjectUnits; states: UnitState[] }>();
  const perProjectUnits = new Map<string, ProjectUnits>();

  let projects = 0;
  await eachProjectUnits(
    (batch) => {
      for (const p of batch) {
        projects++;
        perProjectUnits.set(p.projectId, p);
        if (!p.evidence.trusted) {
          untrustedReads.set(p.projectId, { p, n: p.units.filter((u) => u.state === "UNKNOWN").length });
        }
        if (p.evidence.trusted && !p.evidence.fresh) {
          const d = p.units.filter((u) => u.state === "DELIVERED").length;
          if (d > 0) {
            staleDelivered.units += d;
            staleDelivered.jobs.add(p.projectId);
          }
        }
        {
          const h = p.evidence.ageHours;
          const b = h === null ? "never read" : h <= 24 ? "<= 24h" : h <= 24 * 7 ? "2-7 days" : h <= 24 * 30 ? "8-30 days" : "> 30 days";
          ageBuckets[b] = (ageBuckets[b] ?? 0) + 1;
        }
        for (const u of p.units) {
          stateCount[u.state] = (stateCount[u.state] ?? 0) + 1;
          if (u.state === "UNKNOWN") unknownBySource[u.source] = (unknownBySource[u.source] ?? 0) + 1;
          const byCat = stateByCategory.get(u.category) ?? {};
          byCat[u.state] = (byCat[u.state] ?? 0) + 1;
          stateByCategory.set(u.category, byCat);
          const key = `${u.todayRowStatus}→${u.state}`;
          todayVsNew.set(key, (todayVsNew.get(key) ?? 0) + 1);

          allRows.push({
            projectId: p.projectId,
            street: p.street,
            status: p.status,
            deliveredAt: p.deliveredAt ? p.deliveredAt.toISOString().slice(0, 10) : null,
            deliverableId: u.deliverableId,
            slot: u.slot,
            category: u.category,
            label: u.label,
            todayRowStatus: u.todayRowStatus,
            newState: u.state,
            source: u.source,
            reason: u.reason,
          });

          // The job screens say "Delivered"; this unit says otherwise.
          if (p.status === "DELIVERED" && u.state !== "DELIVERED" && u.state !== "WAIVED" && u.state !== "REMOVED") {
            jobDeliveredUnitNot.push({ p, u });
          }
          if (u.todayRowStatus === "DONE" && u.state === "UNKNOWN") rowDoneUnitUnknown.push({ p, u });
          if (u.todayRowStatus === "DONE" && isOwed(u)) rowDoneStillOwed.push({ p, u });
          if (u.todayRowStatus !== "DONE" && isDeliveredUnit(u)) rowNotDoneUnitDelivered.push({ p, u });
        }

        const videos = p.units.filter((u) => u.category === "VIDEO");
        if (p.status === "DELIVERED" && videos.length > 0 && videos.some((u) => u.state !== "DELIVERED" && u.state !== "WAIVED" && u.state !== "REMOVED")) {
          videoShortfall.set(p.projectId, { p, states: videos.map((u) => u.state) });
        }
      }
    },
    { includeCancelled: false, since: SINCE, pageSize: 200 },
  );

  // -------------------------------------------------------------------------
  console.log("=".repeat(100));
  console.log("EVIDENCE-UNIT RECONCILIATION — what the new model says vs what the screens say today");
  console.log(`scope: ${projects} non-cancelled projects${SINCE ? ` created since ${SINCE.toISOString().slice(0, 10)}` : ""}   ·   read-only   ·   ${new Date().toISOString()}`);
  console.log("=".repeat(100));

  const totalUnits = allRows.length;
  console.log(`\nUNITS: ${totalUnits} across ${projects} jobs (today the hub has ${await prisma.deliverable.count()} deliverable ROWS and one verdict each)\n`);
  console.log("  state          units   share");
  for (const s of ["OWED", "RAW_IN", "REVIEW_READY", "APPROVED", "DELIVERED", "WAIVED", "REMOVED", "UNKNOWN"]) {
    const n = stateCount[s] ?? 0;
    console.log(`  ${pad(s, 14)}${num(n)}   ${((n / totalUnits) * 100).toFixed(1)}%`);
  }

  console.log("\n  UNKNOWN splits into two very different problems:");
  for (const [s, n] of Object.entries(unknownBySource).sort((a, b) => b[1] - a[1])) {
    const note =
      s === "no-evidence-channel"
        ? "the gallery is out, but Aryeo counts the whole gallery (question 8)"
        : s === "never-read"
          ? "the hub has never cross-checked this job (mostly the historical import)"
          : s === "source-unreadable"
            ? "the last read failed — a stale zero is not an absence (RTP-06)"
            : s === "stale-read"
              ? `the last good read is older than ${RECONCILE_STALE_HOURS}h — it cannot prove this is still owed`
              : "";
    console.log(`      ${pad(s, 22)}${num(n)}   ${note}`);
  }

  console.log("\nBY CATEGORY (the collapse this model undoes — today all five photo rows share ONE verdict)\n");
  console.log(`  ${pad("category", 16)}${["OWED", "RAW_IN", "REVIEW_READY", "APPROVED", "DELIVERED", "WAIVED", "REMOVED", "UNKNOWN"].map((s) => pad(s, 13)).join("")}`);
  for (const [cat, counts] of [...stateByCategory.entries()].sort()) {
    const cells = ["OWED", "RAW_IN", "REVIEW_READY", "APPROVED", "DELIVERED", "WAIVED", "REMOVED", "UNKNOWN"]
      .map((s) => pad(String(counts[s] ?? 0), 13))
      .join("");
    console.log(`  ${pad(categoryWord(cat as never), 16)}${cells}`);
  }

  console.log("\nTODAY'S ROW VERDICT → NEW UNIT STATE (every pair, counted)\n");
  for (const [k, n] of [...todayVsNew.entries()].sort((a, b) => b[1] - a[1])) {
    const [today, now] = k.split("→");
    const flag = today === "DONE" && now !== "DELIVERED" ? "   ← the screens claim more than the evidence" : today !== "DONE" && now === "DELIVERED" ? "   ← the screens claim less than the evidence" : "";
    console.log(`  ${pad(today, 12)} → ${pad(now, 14)}${num(n)}${flag}`);
  }

  // -------------------------------------------------------------------------
  console.log(`\n${"-".repeat(100)}`);
  console.log("HEADLINE 1 — jobs the screens call Delivered whose VIDEO unit the evidence cannot");
  console.log("-".repeat(100));
  const byLanding = new Map<string, { p: ProjectUnits; states: UnitState[] }[]>();
  for (const v of videoShortfall.values()) {
    const worst = v.states.find((s) => s !== "DELIVERED") ?? "DELIVERED";
    const arr = byLanding.get(worst) ?? [];
    arr.push(v);
    byLanding.set(worst, arr);
  }
  console.log(`\n  ${videoShortfall.size} DELIVERED jobs have at least one video unit that is not DELIVERED under the contract.\n`);
  for (const [state, arr] of [...byLanding.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  → lands on ${state}: ${arr.length} jobs`);
    for (const v of arr.slice(0, LIST)) {
      console.log(`      ${pad(v.p.street, 34)} ${pad(v.p.projectId, 27)} delivered ${v.p.deliveredAt ? v.p.deliveredAt.toISOString().slice(0, 10) : "—"}  video slots: ${v.states.join(", ")}`);
    }
    if (arr.length > LIST) console.log(`      … and ${arr.length - LIST} more`);
  }

  // The verification's specific population: video ordered, nothing on the
  // listing, a file in the Final folder.
  const dropboxOnly = [...videoShortfall.values()].filter((v) => v.states.some((s) => s === "APPROVED" || s === "REVIEW_READY"));
  console.log(`\n  Of those, ${dropboxOnly.length} have a PRODUCED video (approved cut or a file in the Final folder) that never reached the listing.`);
  console.log("  This is question 7: a finished video in the Final folder, never posted to Aryeo — approved, or delivered?\n");
  for (const v of dropboxOnly.slice(0, LIST)) {
    console.log(`      ${pad(v.p.street, 34)} ${pad(v.p.projectId, 27)} ${v.states.join(", ")}`);
  }
  if (dropboxOnly.length > LIST) console.log(`      … and ${dropboxOnly.length - LIST} more`);

  // -------------------------------------------------------------------------
  console.log(`\n${"-".repeat(100)}`);
  console.log("HEADLINE 2 — photo add-on units that read DONE today and UNKNOWN under the contract");
  console.log("-".repeat(100));
  const addOnAll = rowDoneUnitUnknown.filter((r) => PHOTO_LANE.includes(r.u.category) && r.u.category !== "PHOTOS");
  // Two VERY different unknowns, and they need different answers. Only the
  // first is question 8: the gallery IS out and Aryeo's single count cannot
  // say whether the twilight set is inside it. The second is a job the hub has
  // simply never managed to cross-check (historical import, no listing id) —
  // an ops problem, and the population the 14-day freeze swallows whole.
  const addOnUnknown = addOnAll.filter((r) => r.u.source === "no-evidence-channel");
  const addOnUnread = addOnAll.filter((r) => r.u.source !== "no-evidence-channel");
  const addOnByCat = new Map<string, number>();
  for (const r of addOnUnknown) addOnByCat.set(r.u.category, (addOnByCat.get(r.u.category) ?? 0) + 1);
  const addOnJobs = new Set(addOnUnknown.map((r) => r.p.projectId));
  console.log(`\n  ${addOnUnknown.length} units across ${addOnJobs.size} jobs where the gallery IS out and nothing proves the add-on is in it.`);
  console.log(`  By category: ${[...addOnByCat.entries()].map(([c, n]) => `${categoryWord(c as never)} ${n}`).join(" · ") || "—"}`);
  console.log(`  A further ${addOnUnread.length} add-on units read DONE on jobs whose evidence the hub has never read at all.`);
  console.log("  Every one reads DONE today because ONE listing photo made the whole 'Photos' category present.");
  console.log("  This is question 8: Kyle ticks the add-on off, or the hub states the gallery assumption on screen.\n");
  const shown = new Map<string, string[]>();
  for (const r of addOnUnknown) {
    const arr = shown.get(r.p.projectId) ?? [];
    arr.push(categoryWord(r.u.category));
    shown.set(r.p.projectId, arr);
  }
  let i = 0;
  for (const [pid, cats] of shown) {
    if (i++ >= LIST) {
      console.log(`      … and ${shown.size - LIST} more jobs`);
      break;
    }
    const p = perProjectUnits.get(pid)!;
    console.log(`      ${pad(p.street, 34)} ${pad(pid, 27)} ${p.status.padEnd(10)} ${cats.join(", ")}`);
  }

  // Everything else that reads DONE but is not delivered under the contract.
  console.log(`\n  For completeness: ${rowDoneUnitUnknown.length} DONE→UNKNOWN units in total (add-ons + ${rowDoneUnitUnknown.length - addOnUnknown.length} others),`);
  console.log(`  and ${rowDoneStillOwed.length} units that read DONE while the contract still calls them owed.`);
  const owedByState = new Map<string, number>();
  for (const r of rowDoneStillOwed) owedByState.set(r.u.state, (owedByState.get(r.u.state) ?? 0) + 1);
  for (const [s, n] of [...owedByState.entries()].sort((a, b) => b[1] - a[1])) console.log(`      DONE → ${pad(s, 14)} ${n}`);

  console.log(`\n  The reverse (the screens claim LESS than the evidence): ${rowNotDoneUnitDelivered.length} units.`);
  const revByState = new Map<string, number>();
  for (const r of rowNotDoneUnitDelivered) revByState.set(r.u.todayRowStatus, (revByState.get(r.u.todayRowStatus) ?? 0) + 1);
  for (const [s, n] of [...revByState.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${pad(s, 14)} → DELIVERED  ${n}`);

  // -------------------------------------------------------------------------
  console.log(`\n${"-".repeat(100)}`);
  console.log("HEADLINE 3 — the Content Program meter, per month, three ways");
  console.log("-".repeat(100));
  await contentLens(perProjectUnits);

  // -------------------------------------------------------------------------
  console.log(`\n${"-".repeat(100)}`);
  console.log("UNKNOWN BECAUSE THE HUB COULD NOT LOOK (not because nothing is there)");
  console.log("-".repeat(100));
  const byReason = new Map<string, number>();
  for (const { p } of untrustedReads.values()) byReason.set(p.evidence.reason, (byReason.get(p.evidence.reason) ?? 0) + 1);
  console.log(`\n  ${untrustedReads.size} jobs carry an evidence read the contract will not trust:`);
  for (const [r, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${pad(r, 18)} ${n} jobs`);
  console.log("\n  Today every one of these is indistinguishable from a clean zero, because the failure branch");
  console.log("  stamps the same column a success stamps (RTP-06). The attempted/succeeded split fixes the read.");

  // -------------------------------------------------------------------------
  console.log(`\n${"-".repeat(100)}`);
  console.log(`HOW OLD THE EVIDENCE IS (the ceiling for proving an ABSENCE is ${RECONCILE_STALE_HOURS}h)`);
  console.log("-".repeat(100));
  console.log("\n  jobs by age of their last SUCCESSFUL evidence read:");
  for (const k of ["<= 24h", "2-7 days", "8-30 days", "> 30 days", "never read"]) {
    if (ageBuckets[k]) console.log(`      ${pad(k, 12)} ${num(ageBuckets[k])} jobs`);
  }
  console.log("\n  Evidence is NOT symmetric, and the contract treats the two halves differently:");
  console.log("    · what an old read SAW still stands — a gallery that was live and released on Jun 20 is still");
  console.log("      delivered today, because media does not un-deliver. Those units stay DELIVERED.");
  console.log("    · what an old read DID NOT see proves nothing — the listing may have gone out the next morning.");
  console.log(`      Those units read UNKNOWN (source 'stale-read'), never OWED.`);
  console.log(`\n  The exposure, stated plainly: ${staleDelivered.units} DELIVERED units across ${staleDelivered.jobs.size} jobs rest on a read older than`);
  console.log(`  ${RECONCILE_STALE_HOURS}h. If Jordan wants the ceiling applied symmetrically as well, those become UNKNOWN too and the`);
  console.log("  DELIVERED column collapses — which is question 12 (re-read the back catalogue, or freeze it).");

  // -------------------------------------------------------------------------
  console.log(`\n${"-".repeat(100)}`);
  console.log("WHAT WOULD CHANGE ON A SCREEN, IN ONE LINE");
  console.log("-".repeat(100));
  const jobsWithAnyChange = new Set([
    ...jobDeliveredUnitNot.map((r) => r.p.projectId),
    ...rowDoneUnitUnknown.map((r) => r.p.projectId),
    ...rowDoneStillOwed.map((r) => r.p.projectId),
    ...rowNotDoneUnitDelivered.map((r) => r.p.projectId),
  ]);
  console.log(`\n  ${jobsWithAnyChange.size} of ${projects} jobs (${((jobsWithAnyChange.size / projects) * 100).toFixed(0)}%) would read differently somewhere.`);
  console.log(`  ${jobDeliveredUnitNot.length} units sit under a job the screens call Delivered.`);
  console.log("  The contract's 14-day freeze is what keeps that from re-opening history: every job delivered");
  console.log("  more than 14 days before the migration is written DELIVERED regardless, evidenceSource='legacy-closed'.");
  const freezeCut = new Date(Date.now() - 14 * 24 * 3600_000);
  const liveTail = [...jobsWithAnyChange].filter((id) => {
    const p = perProjectUnits.get(id)!;
    return !p.deliveredAt || p.deliveredAt.getTime() >= freezeCut.getTime();
  });
  console.log(`\n  AFTER THE FREEZE, the live tail is ${liveTail.length} jobs — that is the whole blast radius of Phase 2:`);
  for (const id of liveTail.slice(0, LIST)) {
    const p = perProjectUnits.get(id)!;
    const changed = p.units.filter((u) => (u.todayRowStatus === "DONE" && u.state !== "DELIVERED") || (u.todayRowStatus !== "DONE" && u.state === "DELIVERED") || (p.status === "DELIVERED" && isOwed(u)));
    console.log(`      ${pad(p.street, 34)} ${pad(id, 27)} ${pad(p.status, 10)} ${changed.map((u) => `${u.label}: ${u.todayRowStatus}→${u.state}`).join(" · ").slice(0, 110)}`);
  }
  if (liveTail.length > LIST) console.log(`      … and ${liveTail.length - LIST} more`);

  // -------------------------------------------------------------------------
  // The three numbers the Sep 16 verification predicted, re-measured in the
  // windows it used, so the sign-off is on figures Jordan can check.
  // -------------------------------------------------------------------------
  console.log(`\n${"-".repeat(100)}`);
  console.log("CROSS-CHECK AGAINST THE VERIFICATION'S PREDICTIONS");
  console.log("-".repeat(100));

  const AUG1 = new Date("2026-08-01T00:00:00Z");
  const p1 = [...videoShortfall.values()].filter(
    (v) => v.p.deliveredAt && v.p.deliveredAt >= AUG1 && v.states.some((s) => s === "APPROVED" || s === "REVIEW_READY"),
  );
  console.log(`\n  PREDICTED: "~11 jobs move from DELIVERED to APPROVED on their video unit".`);
  console.log(`  MEASURED : ${p1.length} jobs delivered since Aug 1 have a produced video that never reached the listing.`);
  const p1Approved = p1.filter((v) => v.states.includes("APPROVED"));
  console.log(`             Of those, ${p1Approved.length} ${p1Approved.length === 1 ? "lands" : "land"} on APPROVED (an approved Review Room cut) and ${p1.length - p1Approved.length} on`);
  console.log("             REVIEW_READY (a file in the Final folder, no review round — the pre-Review-Room shape).");
  for (const v of p1) console.log(`               ${pad(v.p.street, 34)} ${pad(v.p.projectId, 27)} ${v.p.deliveredAt!.toISOString().slice(0, 10)}  ${v.states.join(", ")}`);
  const p1All = [...videoShortfall.values()].filter((v) => v.states.some((s) => s === "APPROVED" || s === "REVIEW_READY"));
  const p1Extra = p1All.length - p1.length;
  console.log(`             Over ALL time the same population is ${p1All.length} jobs (the other ${p1Extra} ${p1Extra === 1 ? "was" : "were"} delivered before Aug 1).`);

  const JUL1 = new Date("2026-07-01T00:00:00Z");
  const p2Jobs = new Set<string>();
  let p2Units = 0;
  for (const r of addOnUnknown) {
    const p = r.p;
    const inWindow = (p.deliveredAt && p.deliveredAt >= JUL1) || ["REVIEW", "REVISION"].includes(p.status);
    if (!inWindow) continue;
    p2Units++;
    p2Jobs.add(p.projectId);
  }
  console.log(`\n  PREDICTED: "~55 photo add-on units move from DONE to UNKNOWN".`);
  console.log(`  MEASURED : ${p2Units} add-on units across ${p2Jobs.size} jobs in the same window (delivered since Jul 1, or in REVIEW/REVISION).`);
  console.log(`             Across ALL live jobs the honest figure is ${addOnUnknown.length} units on ${addOnJobs.size} jobs.`);
  console.log(`             (Live obligations by type, every state: ${[...stateByCategory.entries()]
    .filter(([c]) => ["DRONE", "TWILIGHT", "VIRTUAL_STAGING", "HEADSHOT"].includes(c))
    .map(([c, v]) => `${categoryWord(c as never)} ${Object.values(v).reduce((a, b) => a + b, 0)}`)
    .join(" · ")})`);

  console.log(`\n  PREDICTED: "Erica Walker's August content month moves from 4/5 to 1/5".`);
  // ContentMonth carries a denormalized clientId, not a relation — resolve the
  // client first (the same two-step contentProgram's roster does).
  const ericaClients = await prisma.client.findMany({
    where: { name: { contains: "Erica", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  const ericaNameOf = new Map(ericaClients.map((c) => [c.id, c.name]));
  const erica = ericaClients.length
    ? await prisma.contentMonth.findFirst({
        where: { monthKey: "2026-08", clientId: { in: ericaClients.map((c) => c.id) } },
        select: { id: true, videosOwed: true, clientId: true },
      })
    : null;
  if (!erica) {
    console.log("  MEASURED : no 2026-08 month found for a client named Erica — CHECK THIS BY HAND.");
  } else {
    const ps = await prisma.project.findMany({
      where: { contentMonthId: erica.id, status: { not: "CANCELLED" } },
      select: { id: true, title: true, status: true, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, quantity: true } } },
    });
    const rosterToday = ps
      .filter((p) => p.status === "DELIVERED")
      .reduce((s, p) => s + Math.max(1, p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0)), 0);
    let delivered = 0;
    let approvedPlus = 0;
    const detail: string[] = [];
    for (const p of ps) {
      const u = perProjectUnits.get(p.id);
      if (!u) continue;
      const vids = u.units.filter((x) => x.category === "VIDEO");
      for (const v of vids) {
        if (v.state === "DELIVERED") {
          delivered++;
          approvedPlus++;
        } else if (v.state === "APPROVED") approvedPlus++;
      }
      detail.push(`${(p.title ?? "").split(",")[0]} [${p.status}] ${vids.map((v) => v.state).join(", ")}`);
    }
    console.log(`  MEASURED : ${ericaNameOf.get(erica.clientId) ?? "Erica"} 2026-08 — roster today ${rosterToday}/${erica.videosOwed} · delivered ${delivered}/${erica.videosOwed} · approved-or-better ${approvedPlus}/${erica.videosOwed}`);
    for (const d of detail) console.log(`               ${d}`);
    console.log("             Question 11 picks which of the two honest numbers goes on the screen.");
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), projects, totalUnits, stateCount, rows: allRows }, null, 1));
    console.log(`\n  full per-unit detail → ${JSON_OUT}`);
  }
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s — nothing was written.\n`);
}

/** The Content Program lens: what the roster credits today (ordered video
 *  quantity off Project.status) against the two honest numbers — delivered
 *  units, and approved-or-better units. Question 11 is exactly which of the
 *  two Jordan wants on his screen. */
async function contentLens(perProjectUnits: Map<string, ProjectUnits>) {
  const months = await prisma.contentMonth.findMany({
    where: { historical: false, status: { notIn: ["SKIPPED", "IMPORTED"] } },
    orderBy: [{ monthKey: "desc" }],
    select: { id: true, monthKey: true, videosOwed: true, clientId: true, enrollmentId: true, status: true },
  });
  if (months.length === 0) {
    console.log("\n  no live content months");
    return;
  }
  const clientIds = [...new Set(months.map((m) => m.clientId))];
  const clients = await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const projects = await prisma.project.findMany({
    where: { contentMonthId: { in: months.map((m) => m.id) } },
    select: {
      id: true,
      contentMonthId: true,
      status: true,
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, quantity: true } },
    },
  });
  const byMonth = new Map<string, typeof projects>();
  for (const p of projects) {
    if (!p.contentMonthId) continue;
    const arr = byMonth.get(p.contentMonthId) ?? [];
    arr.push(p);
    byMonth.set(p.contentMonthId, arr);
  }

  console.log(`\n  ${pad("month", 9)}${pad("client", 26)}${pad("owed", 6)}${pad("roster", 8)}${pad("delivered", 11)}${pad("approved+", 11)}  jobs`);
  const deltas: string[] = [];
  for (const m of months) {
    const ps = (byMonth.get(m.id) ?? []).filter((p) => p.status !== "CANCELLED");
    if (ps.length === 0) continue;
    // TODAY: contentProgram.ts:332 — ordered video quantity, floor of 1, off
    // Project.status === DELIVERED. No cut evidence, no office override.
    const rosterToday = ps
      .filter((p) => p.status === "DELIVERED")
      .reduce((s, p) => s + Math.max(1, p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0)), 0);
    let delivered = 0;
    let approvedPlus = 0;
    for (const p of ps) {
      const u = perProjectUnits.get(p.id);
      if (!u) continue;
      for (const unit of u.units) {
        if (unit.category !== "VIDEO") continue;
        if (unit.state === "DELIVERED") {
          delivered++;
          approvedPlus++;
        } else if (unit.state === "APPROVED") approvedPlus++;
      }
    }
    const name = nameOf.get(m.clientId) ?? m.clientId;
    const flag = rosterToday !== approvedPlus || rosterToday !== delivered ? "  ←" : "";
    console.log(
      `  ${pad(m.monthKey, 9)}${pad(name.slice(0, 24), 26)}${pad(String(m.videosOwed), 6)}${pad(`${rosterToday}/${m.videosOwed}`, 8)}${pad(`${delivered}/${m.videosOwed}`, 11)}${pad(`${approvedPlus}/${m.videosOwed}`, 11)}  ${ps.length}${flag}`,
    );
    if (rosterToday !== approvedPlus) deltas.push(`${m.monthKey} ${name}: ${rosterToday}/${m.videosOwed} → ${approvedPlus}/${m.videosOwed} (approved+) / ${delivered}/${m.videosOwed} (delivered only)`);
  }
  console.log(`\n  roster    = what /content shows today (ordered quantity credited off Project.status = DELIVERED)`);
  console.log("  delivered = video units with client-visible evidence      approved+ = delivered or approved in the Review Room");
  if (deltas.length) {
    console.log(`\n  ${deltas.length} month-rows change:`);
    for (const d of deltas) console.log(`      ${d}`);
  }
}

// ===========================================================================
// --delivery — THE DELIVERY RECONCILIATION
// ===========================================================================

/**
 * The before/after proof. Acceptance for this pass is not "it looked right":
 * it is that nothing except the two exception columns moved. So the pass takes
 * a fingerprint of everything it could conceivably have damaged — every
 * candidate's status, deliveredAt, updatedAt and evidence blob, plus the global
 * Activity and SmartTask counts — before it runs and again afterwards, and
 * prints the diff. updatedAt is in there deliberately: Prisma's @updatedAt is
 * the timestamp a careless writer moves without noticing, and syncProjectStatuses
 * picks its hourly 80 jobs `orderBy: { updatedAt: "desc" }`.
 */
type Fingerprint = {
  projects: Map<string, string>;
  activities: number;
  tasks: number;
  openDeliveryTexts: number;
  deliveredStamps: number;
};

async function fingerprint(ids: string[]): Promise<Fingerprint> {
  const rows = await prisma.project.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, deliveredAt: true, updatedAt: true, statusEvidence: true, statusCheckedAt: true },
  });
  return {
    projects: new Map(
      rows.map((r) => [
        r.id,
        [
          r.status,
          r.deliveredAt?.toISOString() ?? "-",
          r.updatedAt.toISOString(),
          r.statusCheckedAt?.toISOString() ?? "-",
          String(r.statusEvidence ?? "").length,
        ].join("|"),
      ]),
    ),
    activities: await prisma.activity.count(),
    tasks: await prisma.smartTask.count(),
    openDeliveryTexts: await prisma.smartTask.count({ where: { taskType: "delivery_text", status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
    deliveredStamps: await prisma.project.count({ where: { deliveredAt: { not: null } } }),
  };
}

const VERDICT_WORD: Record<DeliveryClassification["verdict"], string> = {
  DELIVERED: "DELIVERED       ",
  DELIVERED_ANOTHER_WAY: "SENT ANOTHER WAY",
  IN_PRODUCTION: "IN PRODUCTION   ",
  OWED: "STILL OWED      ",
  CANNOT_TELL: "CANNOT TELL     ",
};

async function deliveryPass() {
  const started = Date.now();
  console.log("=".repeat(100));
  console.log("DELIVERY RECONCILIATION — what the client can actually open, read LIVE from Aryeo");
  console.log(`${WRITE_EXCEPTIONS ? "WRITE MODE: exceptions will be raised" : "READ-ONLY: nothing will be written"}   ·   ${new Date().toISOString()}`);
  console.log("=".repeat(100));

  // Pass one, always read-only: work out who the candidates are so the
  // fingerprint covers exactly them.
  const dry = await reconcileDeliveries({ write: false, includeTest: INCLUDE_TEST, limit: READ_LIMIT });
  const ids = dry.classifications.map((c) => c.projectId);
  const before = await fingerprint(ids);

  for (const c of dry.classifications) {
    console.log(`\n${VERDICT_WORD[c.verdict]}  ${c.street}`);
    console.log(`   ${c.projectId}`);
    for (const f of c.facts) console.log(`   ${f}`);
    for (const l of c.lanes) console.log(`   · ${pad(laneLabel(l.lane), 11)} ${pad(l.verdict, 17)} ${l.why}`);
    if (c.alreadyFlagged) console.log(`   ALREADY FLAGGED — the note on this job belongs to whoever is working it; the pass will not overwrite it.`);
    else if (c.flagWorthy) console.log(`   ${WRITE_EXCEPTIONS ? "RAISING" : "WOULD RAISE"}: ${c.note}`);
  }

  const counts = new Map<string, number>();
  for (const c of dry.classifications) counts.set(c.verdict, (counts.get(c.verdict) ?? 0) + 1);
  console.log(`\n${"-".repeat(100)}`);
  console.log(`SCOPE: ${dry.scanned} non-cancelled jobs scanned · ${dry.candidates} carried an internal reason to doubt the delivery · ${dry.skippedTest} synthetic TEST jobs skipped`);
  console.log("VERDICTS:");
  for (const v of ["DELIVERED", "DELIVERED_ANOTHER_WAY", "IN_PRODUCTION", "OWED", "CANNOT_TELL"] as const) {
    console.log(`   ${pad(VERDICT_WORD[v].trim(), 20)} ${num(counts.get(v) ?? 0)}`);
  }
  // HOW MUCH OF THE OLD ANSWER WAS STALE CACHE. The report above (HEADLINE 1,
  // run off the evidence blob) calls eleven delivered jobs short on video. This
  // is the same question asked of Aryeo directly, and the gap between the two
  // numbers is the entire reason this mode exists.
  const cacheDrifted = dry.classifications.filter((c) => c.cacheDrift.length > 0);
  const cacheSaidNoneLiveHasSome = dry.classifications.filter((c) =>
    c.cacheDrift.some((d) => d.cached === 0 && d.live > 0),
  );
  console.log(`\nSTALE CACHE, MEASURED: ${cacheDrifted.length} of ${dry.candidates} candidates carry an evidence blob that disagrees with the live listing.`);
  console.log(`   ${cacheSaidNoneLiveHasSome.length} of them have a cached count of ZERO where the listing actually carries the media.`);
  console.log("   That is the shape that produced the wrong answer on Sep 17: a frozen zero read as a confident one.");
  for (const c of cacheSaidNoneLiveHasSome) {
    console.log(`      ${pad(c.street, 30)} ${c.cacheDrift.map((d) => `${laneLabel(d.lane)} cached ${d.cached} → live ${d.live}`).join(" · ")}`);
  }

  if (dry.unreadable.length) {
    console.log(`\nLISTINGS THIS PASS COULD NOT READ (${dry.unreadable.length}) — reported, NEVER flagged.`);
    console.log("  'We could not look' is not 'nothing is there'. An Aryeo outage must not raise an exception on the back catalogue.");
    for (const u of dry.unreadable) console.log(`   ${pad(u.street, 36)} ${u.why}`);
  }

  // The write, if it was asked for — off the classifications just printed, not
  // off a second live read. One pass, one set of facts, and what gets written
  // is exactly what was shown above.
  if (WRITE_EXCEPTIONS) {
    const raised: string[] = [];
    const skipped: string[] = [];
    for (const c of dry.classifications) {
      if (!c.flagWorthy) continue;
      if (c.alreadyFlagged) {
        skipped.push(`${pad(c.street, 30)} already flagged — left exactly as it was`);
        continue;
      }
      const r = await raiseDeliveryException(c.projectId, c.note);
      (r === "raised" ? raised : skipped).push(`${pad(c.street, 30)} ${r === "raised" ? c.note : "another writer got there first"}`);
    }
    console.log(`\n${"-".repeat(100)}`);
    console.log(`EXCEPTIONS RAISED: ${raised.length}`);
    for (const r of raised) console.log(`   ${r}`);
    if (skipped.length) {
      console.log(`LEFT ALONE: ${skipped.length}`);
      for (const s of skipped) console.log(`   ${s}`);
    }
  }

  // The proof.
  const after = await fingerprint(ids);
  console.log(`\n${"-".repeat(100)}`);
  console.log("WHAT MOVED (everything below must read 0 except the exception columns)");
  console.log("-".repeat(100));
  let drifted = 0;
  for (const [id, sig] of before.projects) {
    const now = after.projects.get(id);
    if (now !== sig) {
      drifted++;
      console.log(`   DRIFT ${id}\n      before ${sig}\n      after  ${now}`);
    }
  }
  console.log(`   status / deliveredAt / updatedAt / statusCheckedAt / evidence changed on: ${drifted} of ${before.projects.size} candidates`);
  // WHO ELSE IS WRITING. Measured Sep 18 00:57, mid-run: something was walking
  // the whole Project table at ~13 rows a second (538 rows in five minutes,
  // 1,579 in an hour) — a dev server against this same production database, not
  // this pass. A zero above is only meaningful next to this number, and a
  // non-zero above is not automatically ours. The flag write itself cannot be
  // the cause either way: raiseDeliveryException is raw SQL naming its two
  // columns, so a row it touches keeps the updatedAt it already had, and the
  // exception stamps land within milliseconds of each other while those
  // updatedAt values do not.
  const churn = await prisma.project.count({ where: { updatedAt: { gte: new Date(Date.now() - 5 * 60_000) } } });
  console.log(`   other writers: ${churn} projects across the whole table have moved in the last 5 minutes`);
  console.log(`   Activity rows        ${before.activities} → ${after.activities}   (${after.activities - before.activities})`);
  console.log(`   SmartTask rows       ${before.tasks} → ${after.tasks}   (${after.tasks - before.tasks})`);
  console.log(`   open delivery_text   ${before.openDeliveryTexts} → ${after.openDeliveryTexts}   (${after.openDeliveryTexts - before.openDeliveryTexts})`);
  console.log(`   deliveredAt stamps   ${before.deliveredStamps} → ${after.deliveredStamps}   (${after.deliveredStamps - before.deliveredStamps})`);
  const flagged = await prisma.project.count({ where: { deliveryExceptionAt: { not: null } } });
  console.log(`   projects flagged     ${flagged}`);
  console.log(
    "\n   A delivery text can only be sent by sweepDeliveryTexts, which sends from an OPEN delivery_text SmartTask,\n" +
      "   which is only ever minted by syncProjectStatuses when it computes a job to DELIVERED. This pass computes\n" +
      "   no status and creates no task, so the count above is the whole proof: the send lane was never touched.",
  );
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`);
}

// ===========================================================================
// --selftest — the classifier's branches, including the ones production has no
// example of today.
//
// Live evidence proves what the pass says about the seventeen jobs in front of
// it. It cannot prove what the pass would say about a job whose cut was sent by
// hand, or about an Aryeo outage — and the outage branch is the one that would
// do the damage, because getting it wrong flags the whole back catalogue in a
// single run. classifyDelivery is pure for exactly this reason: these cases
// cost nothing and need no database.
// ===========================================================================

function selftest(): void {
  const listing = (over: Partial<Extract<ListingRead, { readable: true }>> = {}): ListingRead => ({
    readable: true,
    deliveryStatus: "DELIVERED",
    photos: 40,
    videos: 1,
    floorPlans: 3,
    videoTitles: ["Standard Reel"],
    atISO: new Date().toISOString(),
    ...over,
  });
  const job = (over: Partial<DeliveryInput> = {}): DeliveryInput => ({
    projectId: "p1",
    street: "1 Test St",
    status: "DELIVERED",
    deliveredAt: new Date("2026-08-01T12:00:00Z"),
    deliveredBy: null,
    deliveredVia: null,
    expected: ["PHOTOS", "VIDEO"],
    orderedVideoSlots: 1,
    photoLaneProducts: ["Photos"],
    dropboxFinalVideo: 1,
    dropboxFinalPhotos: 40,
    cutsSentToClient: 0,
    finishedCutsUnsent: 0,
    renderingCutsUnsent: 0,
    listing: listing(),
    exceptionAt: null,
    exceptionNote: null,
    cachedAryeoVideos: null,
    cachedAryeoPhotos: null,
    ...over,
  });

  const cases: { name: string; input: DeliveryInput; verdict: DeliveryClassification["verdict"]; flagged: boolean }[] = [
    { name: "everything live on a delivered listing", input: job(), verdict: "DELIVERED", flagged: false },
    {
      name: "video absent, two finished files in the Final folder",
      input: job({ listing: listing({ videos: 0, videoTitles: [] }), dropboxFinalVideo: 2 }),
      verdict: "OWED",
      flagged: true,
    },
    {
      name: "video absent, but a person marked the cut sent",
      input: job({ listing: listing({ videos: 0, videoTitles: [] }), cutsSentToClient: 1 }),
      verdict: "DELIVERED_ANOTHER_WAY",
      flagged: false,
    },
    {
      name: "video absent, the approved cut is still in the 1080p lane",
      input: job({ listing: listing({ videos: 0, videoTitles: [] }), dropboxFinalVideo: 0, renderingCutsUnsent: 1, status: "REVIEW", deliveredAt: null }),
      verdict: "IN_PRODUCTION",
      flagged: false,
    },
    {
      name: "video absent, the render FAILED so the editor's export is the deliverable",
      input: job({ listing: listing({ videos: 0, videoTitles: [] }), dropboxFinalVideo: 0, finishedCutsUnsent: 1, status: "REVIEW", deliveredAt: null }),
      verdict: "OWED",
      flagged: true,
    },
    // THE ONE THAT MUST NEVER FLAG: an Aryeo outage is not an absence.
    { name: "the listing read failed", input: job({ listing: { readable: false, why: "read-failed" } }), verdict: "CANNOT_TELL", flagged: false },
    { name: "no listing id at all", input: job({ listing: { readable: false, why: "no-listing-id" } }), verdict: "CANNOT_TELL", flagged: false },
    {
      name: "media is on the listing but Aryeo never released it",
      input: job({ listing: listing({ deliveryStatus: "UNDELIVERED" }) }),
      verdict: "CANNOT_TELL",
      flagged: true,
    },
    {
      name: "Photos expected only because the product is called Drone Videography",
      input: job({ listing: listing({ photos: 0 }), photoLaneProducts: ["Drone Videography"], dropboxFinalPhotos: 60 }),
      verdict: "CANNOT_TELL",
      flagged: true,
    },
    {
      name: "photos really were ordered and really are absent",
      input: job({ listing: listing({ photos: 0 }), photoLaneProducts: ["Photos", "Drone Photos"], dropboxFinalPhotos: 60 }),
      verdict: "OWED",
      flagged: true,
    },
    {
      name: "one video live against two ordered",
      input: job({ orderedVideoSlots: 2 }),
      verdict: "CANNOT_TELL",
      flagged: true,
    },
    {
      name: "only a 3D tour ordered — the hub has no channel, so nobody is flagged",
      input: job({ expected: ["THREED"] }),
      verdict: "CANNOT_TELL",
      flagged: false,
    },
  ];

  let failed = 0;
  console.log("CLASSIFIER SELF-TEST — pure, no database, no Aryeo\n");
  for (const c of cases) {
    const got = classifyDelivery(c.input);
    const ok = got.verdict === c.verdict && got.flagWorthy === c.flagged;
    if (!ok) failed++;
    console.log(`  ${ok ? "pass" : "FAIL"}  ${pad(c.name, 62)} ${pad(got.verdict, 22)} ${got.flagWorthy ? "would flag" : "no flag"}`);
    if (!ok) console.log(`        expected ${c.verdict} / ${c.flagged ? "flag" : "no flag"}`);
  }
  console.log(`\n${cases.length - failed} of ${cases.length} passed.`);
  if (failed) process.exitCode = 1;
}

if (SELFTEST) {
  selftest();
} else {
  void (DELIVERY ? deliveryPass() : main())
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
