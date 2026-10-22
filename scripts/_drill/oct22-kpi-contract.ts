// ---------------------------------------------------------------------------
// DRILL: THE KPI SCORECARD ON THE COMPENSATION TERMS, AND PTO (Oct 22 2026).
//
//   1. the terms in code: Harrison's five categories and weights (35/25/20/
//      10/10, adding to 100) and bands ($1,000/$600/$250 at 90/80/70); James
//      on the same five with $1,500/$900/$375; caps $1,000 / $1,500; the first
//      period Sep 25 to Dec 31 2026, then calendar quarters; volume is not a
//      category; the deadlines (photos by midnight on the shoot day, video by
//      9:00 AM the next morning); the thin-instructions word count; the
//      missed-coverage reading of a client's words;
//   2. Harrison's entries from a real fixture: a late photo upload and a late
//      video upload each make a Reliability entry with evidence, an on-time
//      upload does not, an excused video is never late, a video still not in
//      carries the morning-after ask; thin and incomplete video instructions
//      make an entry, a plain reel does not; a normal client revision does
//      not count, a capture-traced one does; a client text saying a shot was
//      missed counts, an extra-shot request never does, an unclear one waits
//      ("needs review"); an agreed deadline removes a late entry;
//   3. disputes: filing one changes nothing; removing it moves the score;
//      upholding it does not; the creative manager decides a specialist's
//      dispute; the creative cannot decide their own;
//   4. entries added by hand: add (negative, with a job), edit (positive),
//      dispute, remove;
//   5. James: computed on Harrison's categories with his own bands; weights
//      and bands change only from a period that has not started;
//   6. pages: My Performance shows the creative their scorecard, Dispute
//      buttons and their own PTO, never a pay amount; the creative manager
//      sees the dispute waiting on them; Finance → Bonus shows the owner's
//      tools;
//   7. PTO: 10-day bank per agreement year, Mon to Fri, holidays skipped,
//      partial days, overlaps and weekends refused, owner only;
//   8. paying: refused while running or before check-ins, then paid once.
// ISOLATION: PGlite on 127.0.0.1:6222 (DRILL_PORT overrides); production is
// never opened; every outbound call is fenced (must be 0). Pages run without
// the react-server condition, server-only neutralised.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createRequire } from "node:module";
import { isValidElement } from "react";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

// ---- the clock ------------------------------------------------------------
const RealDate = Date;
let SIM = RealDate.parse("2026-11-20T15:00:00-05:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;
const setClock = (iso: string) => { SIM = RealDate.parse(iso); };

installNextStubs();
const fence = fenceFetch();

class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never };
navigation.redirect = (href) => { throw new Redirect(href); };

// ---- a tiny server-tree reader ----------------------------------------------
type Props = Record<string, unknown>;
const typeName = (t: unknown) => (typeof t === "string" ? t : (t as { name?: string } | null)?.name ?? "");
async function expand(tree: unknown, names: Set<string>): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map((t) => expand(t, names)));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && names.has(tree.type.name)) return expand(await (tree.type as (p: Props) => unknown)(tree.props), names);
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await expand(v, names)] as const))) };
}
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((t) => elements(t, name));
  if (!isValidElement<Props>(tree)) return [];
  return [...(typeName(tree.type) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((v) => elements(v, name))];
}
function rawText(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(rawText).join(" ");
  if (!isValidElement<Props>(tree)) return "";
  const own = typeof tree.type === "string" ? [] : Object.entries(tree.props).filter(([k, v]) => k !== "className" && k !== "href" && typeof v === "string").map(([, v]) => v as string);
  return [...own, ...Object.entries(tree.props).filter(([k]) => k !== "className").map(([, v]) => rawText(v))].join(" ");
}
/** Every string a viewer could read, whitespace collapsed. */
const textOf = (tree: unknown) => rawText(tree).replace(/\s+/g, " ");
// Expanding a component replaces it with what it renders, so a check that
// looks FOR a component's props reads the tree expanded only down to it.
const OUTER_PARTS = ["MyPerformance"];
const CARD_PARTS = ["MyPerformance", "QuarterScoreCard", "CategoryBlock", "EntryRow", "Bar", "DisputeQueue", "PtoCard"];
const FINANCE_OUTER = ["ContractPeriod", "LegacyPeriod", "ManualEntries", "PersonCard", "TermsPanel", "PtoSection"];
const FINANCE_PARTS = [...FINANCE_OUTER, ...CARD_PARTS];

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6222), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct22-kpi" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { etAt } = await import("@/lib/datetime");
    const kpi = await import("@/lib/kpi");
    const ev = await import("@/lib/kpiEvidence");
    const pto = await import("@/lib/pto");
    const actions = await import("@/app/sales/bonusActions");
    const ptoActions = await import("@/app/sales/ptoActions");
    const { default: MyPayPage } = await import("@/app/my-pay/page");
    const { default: FinancePage } = await import("@/app/sales/page");
    const et = (day: string, h: number, m = 0) => etAt(day, h, m);

    // =======================================================================
    c.head("1 · the terms in code");
    // =======================================================================
    const H = kpi.HARRISON_CATEGORIES;
    c.ok("Harrison's five categories, in the terms' order and weights", H.map((x) => `${x.key}:${x.weight}`).join(",") === "client:35,reliability:25,quality:20,professionalism:10,growth:10", H.map((x) => `${x.key}:${x.weight}`).join(","));
    c.ok("…and the weights add to 100", H.reduce((s, x) => s + (x.weight ?? 0), 0) === 100);
    c.ok("Harrison's bands: 90+ $1,000, 80 to 89 $600, 70 to 79 $250, below 70 nothing", kpi.BONUS_BANDS.map((b) => `${b.min}:${b.amount}`).join(",") === "90:1000,80:600,70:250,0:0");
    c.ok("James's bands: 90+ $1,500, 80 to 89 $900, 70 to 79 $375, below 70 nothing", kpi.JAMES_BANDS.map((b) => `${b.min}:${b.amount}`).join(",") === "90:1500,80:900,70:375,0:0");
    const ja = kpi.agreedTerms("james");
    const ha = kpi.agreedTerms("harrison");
    c.ok("James is scored on Harrison's five categories and weights", ja.categories === kpi.HARRISON_CATEGORIES);
    c.ok("caps: Harrison $1,000, James $1,500", ha.cap === 1000 && ja.cap === 1500, `${ha.cap} / ${ja.cap}`);
    c.ok("volume is not a category or an evidence area", !H.some((x) => /volume/i.test(x.key + x.label)) && !H.flatMap((x) => x.areas).some((a) => /volume/i.test(a)));
    const p1 = kpi.periodFor("2026-10-22");
    c.ok("the first period is Sep 25 to Dec 31 2026", p1.key === "2026-Q4" && p1.startKey === "2026-09-25" && p1.endKey === "2026-12-31" && !p1.legacy && p1.label === "Sep 25 to Dec 31 2026", JSON.stringify([p1.key, p1.startKey, p1.endKey, p1.label]));
    c.ok("…Sep 26 is in it, Sep 24 is the old Q3", kpi.periodFor("2026-09-26").key === "2026-Q4" && kpi.periodFor("2026-09-24").legacy && kpi.periodFor("2026-09-24").key === "2026-Q3");
    const q1 = kpi.periodFor("2027-02-10");
    c.ok("…then calendar quarters (Q1 2027 is Jan 1 to Mar 31)", q1.key === "2027-Q1" && q1.startKey === "2027-01-01" && q1.endKey === "2027-03-31" && !q1.legacy);
    c.ok("…the period after the first steps back to it", kpi.periodFor("2027-02-10", 1).startKey === "2026-09-25" && kpi.periodFromKey("2026-Q4")?.startKey === "2026-09-25");
    c.ok("…settled within 30 days: by Jan 30 2027", p1.settleByKey === "2027-01-30", p1.settleByKey);
    c.ok("the first period is checked in monthly: Sep 25 to Oct 31, November, December", kpi.periodMonths(p1).map((m) => `${m.label}=${m.startKey}..${m.endKey}`).join(" | ") === "Sep 25 to Oct 31=2026-09-25..2026-10-31 | November=2026-11-01..2026-11-30 | December=2026-12-01..2026-12-31", kpi.periodMonths(p1).map((m) => m.label).join(", "));
    const dl = ev.uploadDeadlines("2026-10-20");
    c.ok("deadlines: photos by midnight ending the shoot day, video by 9:00 AM the next morning (ET)", dl.photos.toISOString() === "2026-10-21T04:00:00.000Z" && dl.video.toISOString() === "2026-10-21T13:00:00.000Z", `${dl.photos.toISOString()} / ${dl.video.toISOString()}`);
    c.ok("own words: headings, style, color and placeholders do not count", ev.ownWords("VISION FOR THE EDIT\nstandard\nSUMMARY\nnice house\nSTYLE: Cinematic\nCOLOR PROFILE: iPhone") === 2);
    c.ok("missed coverage reading: a miss, an extra, an unclear one, and not coverage at all",
      ev.coverageVerdict("You missed the basement, there are no photos of it") === "miss" &&
      ev.coverageVerdict("Could you also get a different angle of the pool?") === "extra" &&
      ev.coverageVerdict("The primary bathroom photos are missing") === "unsure" &&
      ev.coverageVerdict("Please remove the car from the driveway") === null);

    // =======================================================================
    c.head("2 · Harrison's entries, from the hub's own records");
    // =======================================================================
    const tm = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, "-")}@oct22kpi.drill.invalid`, role: "PHOTOGRAPHER", ...extra }, select: { id: true, name: true } });
    const harrison = await tm("Harrison Wells");
    const james = await tm("James Livingston", { creativeManager: true });
    const jordanTm = await tm("Jordan Spackman", { payPercent: 0.4 });
    const user = (email: string, name: string, role: string, teamMemberId: string | null) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", teamMemberId }, select: { id: true, email: true, role: true } });
    const owner = await user("owner@oct22kpi.drill.invalid", "Jordan Spackman", "OWNER", jordanTm.id);
    const hLogin = await user("harrison@oct22kpi.drill.invalid", "Harrison Wells", "PHOTOGRAPHER", harrison.id);
    const jLogin = await user("james@oct22kpi.drill.invalid", "James Livingston", "CREATIVE_MANAGER", james.id);
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    const client = await prisma.client.create({ data: { name: "Main Line Realty" }, select: { id: true } });

    let seq = 0;
    const GOOD_VI = "VISION FOR THE EDIT\nCalm and bright: open on the drone push-in over the front lawn, walk the kitchen island, finish on the patio at golden hour.\nSTYLE: Cinematic";
    const job = async (o: { who: string; street: string; day: string; hour?: number; video?: "full" | "reel" | "excused"; photosAt?: Date | null; videoAt?: Date | null; whole?: Date | null; vi?: string | null; raw?: number; revisionRequestedAt?: Date | null }) => {
      const at = et(o.day, o.hour ?? 10);
      const dels: Record<string, unknown>[] = [{ type: "PHOTOS", label: "Photos" }];
      if (o.video === "full") dels.push({ type: "VIDEO", label: "Listing Video", productTitle: "Listing Video" });
      if (o.video === "reel") dels.push({ type: "SOCIAL_REEL", label: "Social Reel", productTitle: "Social Reel" });
      if (o.video === "excused") dels.push({ type: "VIDEO", label: "Listing Video", productTitle: "Listing Video", notCompletedReason: "Agent cancelled the video on site" });
      const p = await prisma.project.create({
        data: {
          clientId: client.id, title: `${o.street}, Malvern, PA`, status: "DELIVERED", photographerId: o.who, shootDate: at,
          photosHandoffAt: o.photosAt ?? null, videoHandoffAt: o.videoAt ?? null, debriefSubmittedAt: o.whole ?? null,
          videoInstructions: o.vi ?? null, photoTarget: 30, rawPhotoCount: o.raw ?? 150, revisionRequestedAt: o.revisionRequestedAt ?? null,
          appointments: { create: [{ aryeoId: `oct22-kpi-${++seq}`, startAt: at, status: "SCHEDULED", assignedToId: o.who }] },
          deliverables: { create: dels },
        } as never,
        select: { id: true },
      });
      return p.id;
    };
    const onTime = (day: string) => et(day, 18);

    const A: string[] = [];
    for (let i = 0; i < 10; i++) {
      const day = `2026-10-${String(1 + i).padStart(2, "0")}`;
      A.push(await job({ who: harrison.id, street: `${10 + i} Steady Ln`, day, photosAt: onTime(day), whole: onTime(day) }));
    }
    const B = await job({ who: harrison.id, street: "20 Late Photo Rd", day: "2026-10-20", hour: 14, photosAt: et("2026-10-21", 1, 30), whole: et("2026-10-21", 1, 30) });
    const B2 = await job({ who: harrison.id, street: "21 Twilight Way", day: "2026-10-21", hour: 17, photosAt: et("2026-10-22", 2), whole: et("2026-10-22", 2) });
    const C = await job({ who: harrison.id, street: "22 Just In Time Ct", day: "2026-10-22", hour: 14, photosAt: et("2026-10-22", 23, 50), whole: et("2026-10-22", 23, 50) });
    const D = await job({ who: harrison.id, street: "23 Late Video Ave", day: "2026-10-23", video: "full", photosAt: et("2026-10-23", 20), videoAt: et("2026-10-24", 9, 40), whole: et("2026-10-24", 9, 40), vi: GOOD_VI });
    const E = await job({ who: harrison.id, street: "27 On Time Video Pl", day: "2026-10-27", video: "full", photosAt: et("2026-10-27", 19), videoAt: et("2026-10-28", 8, 55), whole: et("2026-10-28", 8, 55), vi: GOOD_VI });
    const F = await job({ who: harrison.id, street: "29 Thin Brief St", day: "2026-10-29", video: "full", photosAt: et("2026-10-29", 18), videoAt: et("2026-10-29", 21), whole: et("2026-10-29", 21), vi: "VISION FOR THE EDIT\nstandard\nSUMMARY\nnice house\nSTYLE: Cinematic\nCOLOR PROFILE: iPhone" });
    const G = await job({ who: harrison.id, street: "30 No Brief Dr", day: "2026-10-30", video: "full", whole: et("2026-10-30", 20) });
    const Hj = await job({ who: harrison.id, street: "3 Client Change Rd", day: "2026-11-03", photosAt: onTime("2026-11-03"), whole: onTime("2026-11-03"), revisionRequestedAt: et("2026-11-06", 10) });
    const I = await job({ who: harrison.id, street: "4 Capture Miss Ln", day: "2026-11-04", photosAt: onTime("2026-11-04"), whole: onTime("2026-11-04") });
    const N = await job({ who: harrison.id, street: "5 Over Budget Ct", day: "2026-11-05", photosAt: onTime("2026-11-05"), whole: onTime("2026-11-05"), raw: 300 });
    const R = await job({ who: harrison.id, street: "6 Plain Reel Way", day: "2026-11-06", video: "reel", photosAt: onTime("2026-11-06"), videoAt: onTime("2026-11-06"), whole: onTime("2026-11-06") });
    const COV = await job({ who: harrison.id, street: "9 Coverage Ct", day: "2026-11-09", photosAt: onTime("2026-11-09"), whole: onTime("2026-11-09") });
    const K = await job({ who: harrison.id, street: "10 Excused Video Rd", day: "2026-11-10", video: "excused", photosAt: onTime("2026-11-10"), whole: onTime("2026-11-10") });
    const L = await job({ who: harrison.id, street: "18 Still Owed St", day: "2026-11-18", video: "full", photosAt: et("2026-11-18", 19) });
    await job({ who: harrison.id, street: "25 Future Visit Ln", day: "2026-11-25", photosAt: et("2026-11-25", 18), whole: et("2026-11-25", 18) });
    // The morning-after ask the missing-instructions sweep left for 18 Still Owed St.
    await prisma.appSetting.create({ data: { key: `instructions_missing:${L}:2026-11-19`, value: JSON.stringify({ state: "sent", at: et("2026-11-19", 10).toISOString(), missing: ["the flow and vision for the edit"] }) } });
    // Review: coaching on five shoots (reviewed, never counted), one fix note.
    for (const id of A.slice(0, 5)) await prisma.mediaNote.create({ data: { projectId: id, assetUrl: `https://drill.invalid/${id}.jpg`, body: "Next time, duck under the mirror line.", lane: "PHOTOGRAPHER", kind: "coaching", photographerId: harrison.id } });
    await prisma.mediaNote.create({ data: { projectId: C, assetUrl: `https://drill.invalid/${C}.jpg`, body: "Kitchen frame is tilted, needs a reshoot crop.", lane: "PHOTOGRAPHER", kind: "fix", photographerId: harrison.id } });
    // Revisions: an ordinary client change, and one traced to the capture.
    await prisma.revisionBrief.create({ data: { projectId: Hj, source: "openphone", originalText: "Can you make the living room warmer?" } });
    await prisma.revisionIssue.create({ data: { projectId: Hj, sourceKind: "MANUAL", sourceId: "drill-h", originalText: "Warmer living room please", cause: "CLIENT_CHANGE", causeConfirmedAt: et("2026-11-06", 12), causeConfirmedBy: "James Livingston" } });
    await prisma.revisionIssue.create({ data: { projectId: I, sourceKind: "MANUAL", sourceId: "drill-i", originalText: "The dining room was never shot", cause: "CAPTURE", causeConfirmedAt: et("2026-11-07", 12), causeConfirmedBy: "James Livingston" } });
    // The client's own words about coverage on 9 Coverage Ct.
    const ask = (text: string, n: number) => prisma.clientAsk.create({ data: { clientId: client.id, projectId: COV, kind: "SPECIAL_REQUEST", medium: "photo", text, source: "text", askedBy: "Dana Agent", askedAt: et("2026-11-10", 9 + n) }, select: { id: true } });
    const askMiss = await ask("You missed the basement, there are no photos of it", 0);
    const askExtra = await ask("Could you also get a different angle of the pool?", 1);
    const askUnsure = await ask("The primary bathroom photos are missing", 2);
    await ask("Please remove the car from the driveway", 3);
    // Client feedback: four ratings, one about editing, one complaint by text.
    const fb = (projectId: string, data: Record<string, unknown>) => prisma.feedback.create({ data: { projectId, body: "From the client.", photographerId: harrison.id, ...data } as never });
    for (const [i, r] of [5, 5, 4, 5].entries()) await fb(A[i], { photographerRating: r, rating: r, attribution: "ONSITE", createdAt: et(`2026-10-${String(10 + i).padStart(2, "0")}`, 12) });
    await fb(A[5], { rating: 2, attribution: "OPERATIONS", sentiment: "NEGATIVE", body: "The video took too long.", createdAt: et("2026-10-20", 12) });
    await fb(A[6], { sentiment: "NEGATIVE", attribution: "ONSITE", source: "text", body: "The photographer was rushed and short with my seller.", createdAt: et("2026-10-21", 12) });

    // James: six on-time shoots, four ratings, two reviewed.
    for (let i = 0; i < 6; i++) {
      const day = `2026-10-${String(5 + i).padStart(2, "0")}`;
      const id = await job({ who: james.id, street: `${40 + i} Manager Rd`, day, photosAt: onTime(day), whole: onTime(day) });
      if (i < 4) await prisma.feedback.create({ data: { projectId: id, body: "Great.", photographerId: james.id, photographerRating: [5, 4, 5, 5][i], attribution: "ONSITE", createdAt: et(day, 20) } as never });
      if (i < 2) await prisma.mediaNote.create({ data: { projectId: id, assetUrl: `https://drill.invalid/${id}.jpg`, body: "Nice light.", lane: "PHOTOGRAPHER", kind: "coaching", photographerId: james.id } });
    }

    const card = () => kpi.scorePeriod({ memberId: harrison.id, period: p1 });
    let h = await card();
    const byId = (id: string) => h.entries.find((e) => e.id === id);
    console.log(`\n  Harrison, Nov 20: ${h.shoots} shoots, score ${h.score} (${h.categories.map((x) => `${x.key} ${x.points}/${x.maxPoints}`).join(", ")}), worth $${h.bonus}\n`);
    const lateB = byId(`late-photos:${B}`);
    c.ok("a late photo upload (1:30 AM after the shoot day) is a Reliability entry", lateB?.category === "reliability" && lateB.counts && lateB.title.startsWith("Photos late"), lateB?.title);
    c.ok("…with its evidence: the deadline, the submit time and how late", !!lateB && lateB.detail.some((d) => /by midnight on the shoot day/.test(d)) && lateB.detail.some((d) => /Submitted on the upload page .* 1 h 30 min after the deadline/.test(d)), lateB?.detail.join(" | "));
    c.ok("an on-time photo upload (11:50 PM) makes no entry", !byId(`late-photos:${C}`) && !A.some((id) => byId(`late-photos:${id}`)));
    const lateD = byId(`late-video:${D}`);
    c.ok("a late video upload (9:40 AM the next day) is a Reliability entry with its deadline", lateD?.category === "reliability" && lateD.counts && lateD.detail.some((d) => /by 9:00 AM the next morning/.test(d)) && lateD.detail.some((d) => /40 min after the deadline/.test(d)), lateD?.detail.join(" | "));
    c.ok("…and its photos half (in by 8 PM) is not late", !byId(`late-photos:${D}`));
    c.ok("an on-time video (8:55 AM) makes no entry", !byId(`late-video:${E}`));
    c.ok("an excused video is never late", !byId(`late-video:${K}`));
    const lateL = byId(`late-video:${L}`);
    c.ok("a video still not in is late, and carries the morning-after ask", lateL?.title.startsWith("Video not in yet") === true && lateL.detail.some((d) => /asked for the missing instructions .*the flow and vision for the edit/.test(d)), lateL?.detail.join(" | "));
    const thin = byId(`instructions:${F}`);
    c.ok("thin video instructions (2 words of their own) are a Reliability entry", thin?.category === "reliability" && thin.counts && /thin/.test(thin.title) && thin.detail.some((d) => /2 words of your own/.test(d)), thin?.title);
    const inc = byId(`instructions:${G}`);
    c.ok("incomplete video instructions (no flow and vision) are an entry naming the gap", inc?.counts === true && /incomplete/.test(inc.title) && inc.detail.some((d) => /the flow and vision for the edit/.test(d)), inc?.detail.join(" | "));
    c.ok("good instructions and a plain reel make no instructions entry", !byId(`instructions:${D}`) && !byId(`instructions:${E}`) && !byId(`instructions:${R}`));
    const cr = byId(`client-revision:${Hj}`);
    c.ok("a normal client creative revision is listed and never counts", cr?.status === "not_counted" && !cr.counts && cr.impact == null);
    const cap = h.entries.find((e) => e.kind === "capture_revision" && e.projectId === I);
    c.ok("a revision a reviewer traced to the capture counts in Quality", cap?.category === "quality" && cap.counts && (cap.impact ?? 0) < 0, `${cap?.impact}`);
    const miss = byId(`coverage:${askMiss.id}`);
    c.ok("a client text saying a shot was missed counts as missed coverage (Quality)", miss?.kind === "missed_coverage" && miss.category === "quality" && miss.counts && miss.detail.some((d) => /You missed the basement/.test(d)));
    const extra = byId(`coverage:${askExtra.id}`);
    c.ok("an extra or different shot is listed and never counts", extra?.kind === "extra_request" && extra.status === "not_counted");
    const unsure = byId(`coverage:${askUnsure.id}`);
    c.ok("an unclear one waits for Jordan: needs review, not counted", unsure?.kind === "missed_coverage" && unsure.status === "advisory" && !unsure.counts && /needs review/.test(unsure.title));
    c.ok("a request that is not about coverage is not an entry", h.entries.filter((e) => e.id.startsWith("coverage:")).length === 3);
    c.ok("feedback about editing is listed, not counted; a complaint by text counts as a 2", h.entries.some((e) => e.kind === "ops_feedback" && e.status === "not_counted") && h.entries.some((e) => e.kind === "complaint" && e.value === 2 && e.counts));
    c.ok("over the raw budget is a Quality entry", byId(`over-budget:${N}`)?.counts === true);
    c.ok("a shoot still to come is not on the card", !h.shootList.some((s) => /Future Visit/.test(s.street)));
    c.ok("Harrison's card: his terms, cap $1,000, a score from the five categories", h.terms.personKey === "harrison" && h.possible === 1000 && h.score != null && h.categories.map((x) => x.key).join(",") === "client,reliability,quality,professionalism,growth");
    const lateB2 = byId(`late-photos:${B2}`);
    await signIn(owner);
    const agreed = await actions.setKpiDeadline(B2, { photos: "2026-10-22T12:00", note: "Twilight shoot: photos by noon the next day" });
    h = await card();
    c.ok("an agreed deadline for one shoot replaces the terms' deadline (the late entry goes)", !!lateB2 && agreed.ok && !byId(`late-photos:${B2}`), agreed.message);

    // =======================================================================
    c.head("3 · disputes");
    // =======================================================================
    const s0 = h.score;
    await signIn(hLogin);
    const d1 = await actions.disputeKpiEntry(p1.key, `late-photos:${B}`, "The agent moved the shoot to 2 PM and Jordan said the morning was fine.");
    h = await card();
    c.ok("Harrison disputes the late photos: it is marked disputed and still counts", d1.ok && byId(`late-photos:${B}`)?.status === "disputed" && byId(`late-photos:${B}`)?.counts === true, d1.message);
    c.ok("…and the score does not move until it is decided", h.score === s0, `${s0} → ${h.score}`);
    c.ok("a second dispute on it is refused", !(await actions.disputeKpiEntry(p1.key, `late-photos:${B}`, "again")).ok);
    c.ok("an entry that is not on the card is refused", !(await actions.disputeKpiEntry(p1.key, "late-photos:nope", "not mine")).ok);
    c.ok("Harrison cannot decide a dispute himself", !(await actions.resolveKpiEntry(harrison.id, p1.key, `late-photos:${B}`, "removed", "I say so")).ok);

    // James's page, with the dispute waiting on him.
    await signIn(jLogin);
    const jPage = await MyPayPage({ searchParams: Promise.resolve({}) });
    const jTree = await expand(jPage, new Set(CARD_PARTS));
    const queue = elements(jTree, "ResolveControls");
    c.ok("James (creative manager) sees Harrison's dispute waiting on him", queue.some((q) => q.entryId === `late-photos:${B}` && q.memberId === harrison.id), JSON.stringify(queue.map((q) => q.entryId)));
    const jText = textOf(jTree);
    c.ok("…and his own card: Harrison's categories, his $1,500 maximum", /Client experience/.test(jText) && /Growth and ownership/.test(jText) && /\$1,500/.test(jText));
    const rm = await actions.resolveKpiEntry(harrison.id, p1.key, `late-photos:${B}`, "removed", "Agreed by text with Jordan: photos the next morning.");
    h = await card();
    c.ok("James removes it: it stops counting and the score goes up", rm.ok && byId(`late-photos:${B}`)?.status === "removed" && (h.score ?? 0) > (s0 ?? 0), `${rm.message} ${s0} → ${h.score}`);
    c.ok("…with the reason Harrison reads", byId(`late-photos:${B}`)?.resolution?.reason === "Agreed by text with Jordan: photos the next morning." && byId(`late-photos:${B}`)?.resolution?.by === "James Livingston");
    c.ok("James cannot decide a dispute on his own card", !(await actions.resolveKpiEntry(james.id, p1.key, "x", "removed", "mine")).ok);
    const s1 = h.score;
    await signIn(hLogin);
    await actions.disputeKpiEntry(p1.key, `late-video:${D}`, "The upload was slow.");
    await signIn(owner);
    const up = await actions.resolveKpiEntry(harrison.id, p1.key, `late-video:${D}`, "upheld", "The submit came in at 9:40; the deadline is 9:00.");
    h = await card();
    c.ok("Jordan upholds another: it keeps counting and the score is unchanged", up.ok && byId(`late-video:${D}`)?.status === "upheld" && h.score === s1, `${s1} → ${h.score}`);
    const s2 = h.score;
    const cnt = await actions.resolveKpiEntry(harrison.id, p1.key, `coverage:${askUnsure.id}`, "upheld", "The bathroom was never shot.");
    h = await card();
    c.ok("confirming the needs-review coverage makes it count and costs points", cnt.ok && byId(`coverage:${askUnsure.id}`)?.counts === true && (h.score ?? 0) < (s2 ?? 0), `${s2} → ${h.score}`);
    c.ok("every decision is in the review history", h.log.length >= 5 && h.log.some((l) => /^Removed:/.test(l.what)) && h.log.some((l) => /^Upheld:/.test(l.what)));

    // =======================================================================
    c.head("4 · entries added by hand");
    // =======================================================================
    const s3 = h.score;
    const add = await actions.addKpiNote(harrison.id, p1.key, { area: "reliability", day: "2026-11-12", title: "Missed the Thursday team meeting without telling anyone", note: "Nobody heard from him until noon.", points: -5, projectId: null });
    h = await card();
    const man = h.entries.find((e) => e.kind === "manual");
    c.ok("Jordan adds a negative entry: it shows on the card in Reliability and costs points", add.ok && man?.category === "reliability" && man.counts && (h.score ?? 0) < (s3 ?? 0), `${add.message} ${s3} → ${h.score}`);
    const edit = await actions.editKpiNote(harrison.id, p1.key, man!.id, { area: "client", day: "2026-11-12", title: "Agent called to praise the shoot", note: "Dana said it was the best shoot yet.", points: 5, projectId: COV });
    h = await card();
    const man2 = h.entries.find((e) => e.kind === "manual");
    c.ok("…edited to a positive Client experience entry with a job link", edit.ok && man2?.category === "client" && man2.effect === "for" && man2.projectId === COV && man2.detail.some((d) => /Job: 9 Coverage Ct/.test(d)), man2?.detail.join(" | "));
    await signIn(hLogin);
    const dm = await actions.disputeKpiEntry(p1.key, man2!.id, "Wrong shoot, it was 10 Excused Video Rd.");
    c.ok("Harrison can dispute an entry added by hand", dm.ok, dm.message);
    c.ok("Harrison cannot add one", !(await actions.addKpiNote(harrison.id, p1.key, { area: "client", day: "2026-11-12", title: "I was great", note: "", points: 25 })).ok);
    await signIn(owner);
    c.ok("a day outside the period is refused", !(await actions.addKpiNote(harrison.id, p1.key, { area: "client", day: "2027-01-03", title: "Late note", note: "", points: 1 })).ok);
    const del = await actions.removeKpiNote(harrison.id, p1.key, man2!.id);
    h = await card();
    c.ok("…and Jordan removes it", del.ok && !h.entries.some((e) => e.kind === "manual"));

    // =======================================================================
    c.head("5 · James: computed, and changed only from a period not yet started");
    // =======================================================================
    let j = await kpi.scorePeriod({ memberId: james.id, period: p1 });
    console.log(`\n  James, Nov 20: ${j.shoots} shoots, score ${j.score}, worth $${j.bonus}\n`);
    c.ok("James's card: Harrison's five categories and weights, his bands, cap $1,500", j.terms.personKey === "james" && j.categories.map((x) => `${x.key}:${x.weight}`).join(",") === "client:35,reliability:25,quality:20,professionalism:10,growth:10" && j.terms.bands === kpi.JAMES_BANDS && j.possible === 1500);
    c.ok("…scored, and the bonus is his band's amount, never above $1,500", j.score != null && j.bonus === (kpi.bandFor(j.score, kpi.JAMES_BANDS)?.amount ?? 0) && j.bonus <= 1500, `${j.score} → $${j.bonus}`);
    const weights = { client: 30, reliability: 30, quality: 20, professionalism: 10, growth: 10 };
    const bands = [{ min: 90, amount: 1500 }, { min: 80, amount: 1000 }, { min: 70, amount: 400 }, { min: 0, amount: 0 }];
    const running = await actions.saveKpiTerms("james", { weights, bands, fromPeriodKey: p1.key });
    c.ok("a change for the period already running is refused", !running.ok && /already started/.test(running.message), running.message);
    c.ok("weights that do not add to 100 are refused", !(await actions.saveKpiTerms("james", { weights: { ...weights, client: 10 }, bands, fromPeriodKey: "2027-Q1" })).ok);
    c.ok("a band above $1,500 is refused", !(await actions.saveKpiTerms("james", { weights, bands: [{ min: 90, amount: 2000 }], fromPeriodKey: "2027-Q1" })).ok);
    await signIn(jLogin);
    c.ok("James cannot change his own terms", !(await actions.saveKpiTerms("james", { weights, bands, fromPeriodKey: "2027-Q1" })).ok);
    await signIn(owner);
    const next = await actions.saveKpiTerms("james", { weights, bands, fromPeriodKey: "2027-Q1", note: "Agreed with James on Nov 20." });
    j = await kpi.scorePeriod({ memberId: james.id, period: p1 });
    c.ok("a change from Q1 2027 saves, and the running period is untouched", next.ok && j.terms.version == null && j.categories.find((x) => x.key === "client")?.weight === 35, next.message);
    const t27 = await kpi.termsFor({ name: "James Livingston", active: true }, q1);
    c.ok("…Q1 2027 reads the new weights and bands", t27.categories.find((x) => x.key === "client")?.weight === 30 && t27.bands.find((b) => b.min === 80)?.amount === 1000 && t27.version?.fromPeriodKey === "2027-Q1");

    // =======================================================================
    c.head("6 · the pages");
    // =======================================================================
    await signIn(owner);
    const fin = async (sp: Record<string, string>, parts: string[]) => {
      const el = await FinancePage({ searchParams: Promise.resolve(sp) });
      if (!isValidElement<Props>(el)) throw new Error("Finance did not render a tab");
      return expand(await (el.type as (p: Props) => unknown)(el.props), new Set(parts));
    };
    const bonusOuter = await fin({ tab: "bonus", back: "0" }, FINANCE_OUTER);
    const bonusTab = await fin({ tab: "bonus", back: "0" }, FINANCE_PARTS);
    const cards = elements(bonusOuter, "QuarterScoreCard");
    c.ok("Finance → Bonus: both scorecards, with the owner's tools", cards.length === 2 && cards.every((x) => x.viewer === "owner"), JSON.stringify(cards.map((x) => x.viewer)));
    c.ok("…entries added by hand, both people's terms, both people's time off", elements(bonusTab, "ManualEntryForm").length === 1 && elements(bonusTab, "TermsForm").length === 2 && elements(bonusTab, "PtoForm").length === 2);
    c.ok("…the pay buttons wait: the period is running", elements(bonusTab, "PayBonusButton").length === 0 && /still running/.test(textOf(bonusTab)));

    // =======================================================================
    c.head("7 · paid time off, then the creative's own page");
    // =======================================================================
    const hPto = (sp: { startKey: string; endKey?: string; type: string; fraction?: number; note?: string; id?: string; yearKey?: string }) => ptoActions.savePto(harrison.id, sp);
    const thanks = await hPto({ startKey: "2026-11-23", endKey: "2026-11-27", type: "vacation", note: "Thanksgiving week" });
    c.ok("PTO: Nov 23 to 27 uses 4 days (Thanksgiving is a company holiday)", thanks.ok && /^Added: 4 days \(Thanksgiving skipped\)\. 6 of 10 left/.test(thanks.message), thanks.message);
    const sick = await hPto({ startKey: "2026-12-01", type: "sick", fraction: 0.5, note: "Doctor" });
    c.ok("…a half sick day comes out of the same bank (5.5 left)", sick.ok && /5\.5 of 10 left/.test(sick.message), sick.message);
    c.ok("…a weekend is refused", !(await hPto({ startKey: "2026-11-28", endKey: "2026-11-29", type: "personal" })).ok);
    const xmas = await hPto({ startKey: "2026-12-25", type: "vacation" });
    c.ok("…a company holiday alone is refused (it never uses the bank)", !xmas.ok && /Christmas is a company holiday/.test(xmas.message), xmas.message);
    c.ok("…an overlap is refused", !(await hPto({ startKey: "2026-11-25", type: "personal" })).ok);
    c.ok("…a range past Sep 24 (the agreement year's end) is refused", !(await hPto({ startKey: "2027-09-23", endKey: "2027-09-28", type: "vacation" })).ok);
    c.ok("…a partial range is refused (a part day is one day)", !(await hPto({ startKey: "2026-12-07", endKey: "2026-12-08", type: "personal", fraction: 0.5 })).ok);
    let bal = await pto.ptoBalance(harrison.id, "Harrison Wells", "2026-11-20");
    c.ok("the balance: agreement year Sep 25 2026 to Sep 24 2027, 4.5 used, 5.5 left", bal.year.startKey === "2026-09-25" && bal.year.endKey === "2027-09-24" && bal.used === 4.5 && bal.remaining === 5.5, `${bal.year.label} ${bal.used}/${bal.remaining}`);
    c.ok("…the six company holidays listed on their own", bal.holidays.map((x) => x.name).join(",") === "Thanksgiving,Christmas,New Year's Day,Memorial Day,Independence Day,Labor Day", bal.holidays.map((x) => x.name).join(","));
    const sickRow = bal.entries.find((e) => e.type === "sick")!;
    const ed = await hPto({ id: sickRow.id, yearKey: bal.year.key, startKey: "2026-12-02", type: "sick", fraction: 1, note: "Flu" });
    bal = await pto.ptoBalance(harrison.id, "Harrison Wells", "2026-11-20");
    c.ok("…an edit to a full sick day: 5 used, 5 left", ed.ok && bal.used === 5 && bal.remaining === 5 && bal.entries.length === 2, ed.message);
    await signIn(hLogin);
    c.ok("Harrison cannot add or remove time off", !(await ptoActions.savePto(harrison.id, { startKey: "2026-12-14", type: "vacation" })).ok && !(await ptoActions.removePto(harrison.id, bal.year.key, sickRow.id)).ok);
    await signIn(owner);
    const extraDay = await hPto({ startKey: "2026-12-14", type: "personal" });
    const extraId = (await pto.ptoBalance(harrison.id, "Harrison Wells", "2026-11-20")).entries.find((e) => e.startKey === "2026-12-14")!.id;
    const rmPto = await ptoActions.removePto(harrison.id, "2026-09-25", extraId);
    bal = await pto.ptoBalance(harrison.id, "Harrison Wells", "2026-11-20");
    c.ok("…Jordan adds and removes a day; the balance follows", extraDay.ok && rmPto.ok && bal.used === 5);
    c.ok("James's bank is his own (untouched)", (await pto.ptoBalance(james.id, "James Livingston", "2026-11-20")).used === 0);

    // Harrison's My Performance.
    await signIn(hLogin);
    const hPage = await MyPayPage({ searchParams: Promise.resolve({}) });
    c.ok("Harrison gets My Performance, not My Pay", isValidElement(hPage) && typeName(hPage.type) === "MyPerformance");
    const hTree = await expand(hPage, new Set(CARD_PARTS));
    const hOuter = await expand(hPage, new Set(OUTER_PARTS));
    const hCards = elements(hOuter, "QuarterScoreCard");
    c.ok("…his own scorecard, as himself", hCards.length === 1 && (hCards[0].card as { memberId: string }).memberId === harrison.id && hCards[0].viewer === "self");
    c.ok("…a Dispute button on entries that count against him", elements(hTree, "DisputeButton").length > 0 && elements(hTree, "ResolveControls").length === 0);
    const hText = textOf(hTree);
    c.ok("…every category with weight, target, measured and evidence", ["Client experience", "Reliability and communication", "Quality and QC", "Professionalism", "Growth and ownership"].every((l) => hText.includes(l)) && /weight 35/.test(hText) && /Target/.test(hText) && /Evidence/.test(hText) && /Monthly check-in/.test(hText));
    c.ok("…his bonus (earned and possible) and his own time off", /of \$1,000 possible/.test(hText) && /Paid time off/.test(hText) && /5 of 10 days left/.test(hText) && elements(hOuter, "PtoCard").length === 1 && elements(hOuter, "PtoCard").every((x) => x.viewer === "self"), hText.slice(0, 200));
    c.ok("…and no pay: no service fee, vehicle, payment or mileage figure", !/service fee|vehicle|mileage|2,538|2,238|58,200|7,800/i.test(hText) && elements(hTree, "PtoForm").length === 0);

    // =======================================================================
    c.head("8 · paying the bonus");
    // =======================================================================
    await signIn(owner);
    c.ok("the running period is refused", /still running/.test((await actions.payQuarterlyBonus(harrison.id, p1.key, h.bonus)).message));
    // Clear the open dispute on the hand entry (it was deleted) and close the period.
    setClock("2027-01-05T10:00:00-05:00");
    await signIn(owner); // weeks later: a fresh session
    h = await card();
    const noCheck = await actions.payQuarterlyBonus(harrison.id, p1.key, h.bonus);
    c.ok("closed, but refused until the check-in categories are filled in", !noCheck.ok && /check-in score for Professionalism and Growth and ownership/.test(noCheck.message), noCheck.message);
    for (const m of kpi.periodMonths(p1)) {
      const ci = await actions.saveKpiCheckIn(harrison.id, p1.key, m.key, { scores: { professionalism: 95, growth: 95 }, note: `${m.label}: steady, keep it up.` });
      if (!ci.ok) throw new Error(ci.message);
    }
    h = await card();
    console.log(`\n  Harrison, period closed: score ${h.score}, earned $${h.bonus}\n`);
    c.ok("the check-ins count: Professionalism and Growth are measured from them", h.categories.find((x) => x.key === "professionalism")?.measured === true && h.months.every((m) => m.checkIn?.scores.professionalism === 95));
    c.ok("…and the month by month view shows the period so far at each month", h.months.length === 3 && h.months.every((m) => m.started && m.scoreToDate != null));
    c.ok("there is a bonus to pay, in Harrison's bands and under his cap", h.bonus > 0 && h.bonus <= 1000 && h.bonus === kpi.bandFor(h.score)?.amount, `${h.score} → $${h.bonus}`);
    const stale = await actions.payQuarterlyBonus(harrison.id, p1.key, h.bonus + 1);
    c.ok("a screen showing another figure is refused", !stale.ok && /not the/.test(stale.message));
    const paid = await actions.payQuarterlyBonus(harrison.id, p1.key, h.bonus);
    const line = await prisma.payoutAdjustment.findFirst({ where: { teamMemberId: harrison.id, label: { startsWith: "Quarterly bonus 2026-Q4" } } });
    c.ok("paying writes the scorecard's figure as his payout line", paid.ok && line?.amount === h.bonus && line.label === "Quarterly bonus 2026-Q4 (Sep 25 to Dec 31 2026)", `${paid.message} ${line?.label}`);
    c.ok("a second press is refused", /Already paid/.test((await actions.payQuarterlyBonus(harrison.id, p1.key, h.bonus)).message));
    await signIn(hLogin);
    c.ok("a paid period is closed to disputes", /is paid/.test((await actions.disputeKpiEntry(p1.key, `late-video:${L}`, "late")).message));
    await signIn(owner);
    const jc = await kpi.scorePeriod({ memberId: james.id, period: p1 });
    const jPay = await actions.payQuarterlyBonus(james.id, p1.key, jc.bonus);
    c.ok("James's period waits for his check-ins too", !jPay.ok && /check-in/.test(jPay.message), jPay.message);

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
