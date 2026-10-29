// Oct 29 2026: A RETAKE IS A CLIENT ISSUE FROM THE FIRST ASK (lib/issueSignalsCore
// asksForRetake, ownerDashboard.clientIssuesSection, lib/issueSignals, the owner
// panel). Jordan, with the Client issues card empty: "Tim Bonner sent a text
// that we need some shots retaken. That's something that I would like on
// here." The hub had filed his text as a photo revision for Kyle, but the card
// only counted revisions from the second round. Held here:
//   §1 the words: the client's own retake words count; booked-reshoot talk the
//      hub only summarised as "reshoot" does not
//   §2 the card: one retake ask shows, in his words, with who has it; one
//      ordinary change still doesn't; the close asks why it needed a retake
//   §3 the panel: the close question reads for a retake
// Disposable PGlite; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { PanelSpec } from "../../src/components/owner/panelTypes";

installNextStubs();
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true, channel: { id: "D" }, ts: "1" }), { headers: { "content-type": "application/json" } }) : null));
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };

const H = 3_600_000;
const D = 24 * H;
const TIM = "Jordan, \n\nalso call me in the morning please. I'm looking at the pictures from Harrison now, and we need to have some retaken.";

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5962), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct29-retake" } });
  const c = makeChecker();
  try {
    const core = await import("@/lib/issueSignalsCore");
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const od = await import("@/lib/ownerDashboard");
    const A = await import("@/app/clients/clientCareActions");
    const { OwnerShell } = await import("@/components/owner/OwnerShell");
    const T = new Date();

    // =====================================================================
    c.head("§1 · the words");
    // =====================================================================
    const yes = [TIM, "Can Harrison reshoot the family room with the lights on?", "The kitchen needs a re-shoot", "Could you shoot the kitchen again?", "please take those photos again", "can someone come back out to shoot the exterior", "retake the twilight ones"];
    const no = ["New 3d tour as well", "Can you brighten the kitchen photo?", "Take out the trash can in photo 12", "Swap the song please", "Mistake on the address", "Shoot again next week at 2?"];
    c.ok("a client's retake words count", yes.every(core.asksForRetake), JSON.stringify(yes.filter((t) => !core.asksForRetake(t))));
    c.ok("ordinary edits, Mike Flatley's 'New 3d tour as well' and scheduling don't", !no.some(core.asksForRetake), JSON.stringify(no.filter(core.asksForRetake)));
    const base = { rounds: 1, retake: true, latestRoundAt: new Date(T.getTime() - 12 * H), openWork: [], lastFixAt: null, closure: null, delegated: null, clientFirst: "Tim", now: T };
    const fixing = core.roundsStage({ ...base, openWork: [{ title: "Photo revision", who: "Kyle" }] });
    c.ok("a lone retake still open reads as the retake, not 'Round 1'", fixing.show && fixing.stage === "FIXING" && fixing.whyHere === "The retake is still open (Kyle has it)." && fixing.nextAction === "Finish the retake: Photo revision" && fixing.owner === "Kyle", JSON.stringify(fixing));
    const confirm = core.roundsStage(base);
    c.ok("…and once done, asks whether Tim is happy and why it needed one", confirm.show && confirm.stage === "CONFIRM" && /^The retake is done, and nobody has confirmed Tim is happy or recorded why it needed a retake\.$/.test(confirm.whyHere), JSON.stringify(confirm));
    c.ok("several rounds keep their old words", (() => { const s = core.roundsStage({ ...base, rounds: 3 }); return s.show && s.whyHere.startsWith("All 3 rounds are fixed"); })());

    // =====================================================================
    c.head("§2 · the card");
    // =====================================================================
    const tm = (name: string, role: string) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@retake.invalid` } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER");
    const owner = await prisma.appUser.create({ data: { name: "Jordan Spackman", email: "info@realtourpilot.com", role: "OWNER", teamMemberId: jordanTm.id, status: "ACTIVE" } });
    await prisma.appUser.create({ data: { name: "Kyle Smith", email: "kyle@retake.invalid", role: "ADMIN", teamMemberId: kyleTm.id, status: "ACTIVE" } });
    const tim = await prisma.client.create({ data: { name: "Tim Bonner" } });
    const job = await prisma.project.create({ data: { clientId: tim.id, title: "265 Mill Rd, Lehighton, PA 18235", status: "REVISION", deliveredAt: new Date(T.getTime() - D) } });
    await prisma.revisionBrief.create({ data: { projectId: job.id, source: "openphone", originalText: TIM, headline: "Client wants some photos retaken", requestedByKind: "TEXT", requestedBy: "Tim Bonner", createdAt: new Date(T.getTime() - 12 * H) } });
    const rev = await prisma.smartTask.create({ data: { taskType: "revision", title: "Photo revision — 265 Mill Rd, Lehighton, PA 18235", status: "OPEN", assignedKey: "kyle", projectId: job.id, clientId: tim.id, source: "drill" } });
    // One ordinary change on another job: still not a client issue.
    const other = await prisma.project.create({ data: { clientId: tim.id, title: "9 Other Ln, Town", status: "REVISION" } });
    await prisma.revisionBrief.create({ data: { projectId: other.id, source: "openphone", originalText: "Can you brighten the kitchen photo?", headline: "Retake the kitchen photo", requestedByKind: "TEXT", createdAt: new Date(T.getTime() - 6 * H) } });

    const section = await od.clientIssuesSection({ now: T });
    const r = section.rows.find((x) => x.id === `revisions:${job.id}`);
    c.ok("Tim's one retake text is on the card: 'Asked for a retake', medium, Kyle has it", r?.title === "Asked for a retake" && r.client === "Tim Bonner" && r.severity === "medium" && r.owner === "Kyle" && r.nextAction === "Finish the retake: Photo revision", JSON.stringify(r && [r.title, r.severity, r.owner, r.nextAction]));
    c.ok("…in his own words, saying he texted and when", !!r && /^Tim texted .+: "Jordan, also call me in the morning please\. I'm looking at the pictures from Harrison now, and we need to have some retaken\."$/.test(r.summary) && r.evidence === "A retake request on the job" && r.severityWhy === "Asked for a retake", r?.summary);
    c.ok("…Assign hands over the retake, keyed to the job's revisions", r?.assign.title === "Finish the retake: 265 Mill Rd" && r.assign.outcome === "Retake done and sent to Tim" && r.assign.sourceHref === `/projects/${job.id}#revisions`, JSON.stringify(r?.assign));
    c.ok("one ordinary change isn't (even when the hub's summary says 'retake')", !section.rows.some((x) => x.id === `revisions:${other.id}`));

    await prisma.smartTask.update({ where: { id: rev.id }, data: { status: "COMPLETED", completedAt: new Date(T.getTime() - H) } });
    const done = (await od.clientIssuesSection({ now: T })).rows.find((x) => x.id === `revisions:${job.id}`);
    c.ok("retake done: 'Confirm Tim is happy', and the close knows it's a retake", done?.nextAction === "Confirm Tim is happy" && done.close?.kind === "rounds" && done.close.rounds === 1 && done.close.retake === true, JSON.stringify(done?.close));

    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const noCause = await A.closeIssueSignalAction({ rowId: `revisions:${job.id}`, outcome: "HAPPY" });
    c.ok("closing as happy asks why it needed a retake (not 'why it took 1 rounds')", !noCause.ok && noCause.message === "Pick why it needed a retake.", noCause.message);
    const closed = await A.closeIssueSignalAction({ rowId: `revisions:${job.id}`, outcome: "HAPPY", cause: "CAPTURE", note: "Lights were off in two rooms" });
    const act = await prisma.activity.findFirst({ where: { projectId: job.id, body: { startsWith: "Retake request closed" } } });
    c.ok("closed with the cause: off the card, on the job's record in plain words", closed.ok && !(await od.clientIssuesSection({ now: T })).rows.some((x) => x.id === `revisions:${job.id}`) && !!act && /Why a retake: A capture problem at the shoot/.test(act.body), act?.body);

    // =====================================================================
    c.head("§3 · the panel");
    // =====================================================================
    const panel = (spec: PanelSpec) => ssr(createElement(OwnerShell, { roster: [{ key: "kyle", name: "Kyle" }], readOnly: false, initial: spec }, null));
    const html = panel({ kind: "issue", row: done! });
    c.ok("renders his words, where it came from, and Close it with 'Tim is happy' / 'Still unhappy'", !html.startsWith("RENDER FAILED") && html.includes("we need to have some retaken") && html.includes("A retake request on the job") && html.includes("Tim is happy") && html.includes("Still unhappy"), html.slice(0, 300));
    c.ok("nothing left the box", fence.blocked.length === 0, JSON.stringify(fence.blocked));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
