// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE VIDEO DELIVERY SCREEN, RENDERED (Oct 19 2026). The companion of
// oct19-video-aryeo-push.ts. Since the Video Review Room build (Oct 19,
// evening) /ops/video-delivery redirects to /review, where its lanes are
// sections; this renders the REAL room and the delivery card's row to HTML
// against seeded jobs with the hub's own runs in every state, so a
// render-time crash, a missing section or a stray dash shows up without a
// browser and without the production database.
//   1  /ops/video-delivery redirects to /review; the room renders
//   2  what it says: Ready to send with each run's three steps and words (a
//      run uploading, a run stopped with Try again), a held run's reason
//      under Held, the late video under With the editors with how late, no
//      switch card (since the room was tightened, Oct 19: no Monthly content
//      section; the monthly videos live on the Shoots page and the Dashboard)
//   3  the delivery card row: a started run's line, a row nobody pressed
//      (the button's words, never "the hub sends it"), links to the room
//   4  copy: no em or en dash in the delivery sections, nothing says
//      undefined or NaN
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 7321). Production is never opened; every outbound call is fenced.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
class Redirect extends Error {
  constructor(readonly href: string) {
    super(`redirect ${href}`);
  }
}
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.redirect = (href: string) => {
    throw new Redirect(href);
  };
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/review";
  nav.useSearchParams = () => new URLSearchParams();
}

const PORT = Number(process.env.DRILL_PORT ?? 7321);
const HOUR = 3_600_000;
const LONG_DASH = /[–—]/;
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/\s+/g, " ");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct19-video-delivery-render" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const T = Date.now();
    const client = await prisma.client.create({ data: { name: "Render Agent Realty" } });
    const mk = async (street: string, opts: { status?: string; pin?: Date; shoot?: Date; approved?: boolean; outputCheck?: string } = {}) => {
      const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId: client.id, status: (opts.status ?? "REVIEW") as never, aryeoListingId: `L-${street}`, aryeoOrderId: `O-${street}`, shootDate: opts.shoot ?? new Date(T - 2 * 24 * HOUR), promisedDueAt: opts.pin ?? null } });
      await prisma.orderItem.create({ data: { projectId: p.id, title: "Cinematic Video", amount: 150 } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", quantity: 1, productTitle: "Cinematic Video" } });
      await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: p.id, slot: 1, category: "VIDEO" } });
      if (!opts.approved) return { p, sub: null };
      const sub = await prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: d.id, slot: 1, round: 1, status: "APPROVED", fileName: `${street}.mp4`, blobUrl: `https://drill.invalid/${encodeURIComponent(street)}.mp4`, sizeBytes: 1000, decidedAt: new Date(T - HOUR), decidedBy: "Jordan" } });
      await prisma.topazJob.create({ data: { submissionId: sub.id, projectId: p.id, state: "done", fileName: sub.fileName, sourceDurationSec: 60, sourceSizeBytes: 113_000_000, savedAt: new Date(T - 30 * 60_000), finalPath: `/Listings/${street}/05-Final-Video/${street} - FINAL (Topaz).mp4`, outputCheck: opts.outputCheck ?? "verified" } });
      return { p, sub: sub.id };
    };
    await mk("1 Late Lane", { status: "EDITING", shoot: new Date(T - 5 * 24 * HOUR), pin: new Date(T - 4 * HOUR) });
    await mk("2 Upcoming Ave", { status: "SCHEDULED", shoot: new Date(T + 2 * 24 * HOUR) });
    const sending = await mk("3 Sending St", { approved: true });
    const held = await mk("4 Held Ct", { approved: true });
    const hand = await mk("5 By Hand Rd", { approved: true, outputCheck: "" });
    // The hub's own runs, as the push writes them.
    const run = (sid: string, patch: Record<string, unknown>) =>
      prisma.appSetting.create({ data: { key: `video_aryeo_push:${sid}`, value: JSON.stringify({ id: "r", submissionId: sid, projectId: "", listingId: "", state: "SENDING", note: null, hold: null, wait: null, mode: "deliver", updatedAt: new Date().toISOString(), upload: { parts: [] }, ...patch }) } });
    await run(sending.sub!, { state: "SENDING", note: "Sending the 1080p file to Aryeo: 10 of 23 parts (about 52 of 113 MB)." });
    await run(held.sub!, { state: "HELD", note: "Sound check held this file: this video has no sound. Ask the editor for a new export.", hold: { gate: "sound", why: "Sound check held this file: this video has no sound. Ask the editor for a new export.", by: null, at: new Date().toISOString(), resume: "PREPARING" } });
    await run(hand.sub!, { state: "FAILED", note: "The 1080p file was never checked, so the hub does not send it on its own. Upload it by hand." });
    const fresh = await mk("6 Fresh St", { approved: true });
    // The hub's Aryeo login is set up, so a row nobody pressed offers the button.
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("aryeo_web", "drill-hub-password", { accountLabel: "hub@drill.test", metadata: { email: "hub@drill.test" } });

    const all: Record<string, string> = {};
    const render = async (label: string, fn: () => unknown | Promise<unknown>) => {
      try {
        const out = html(await fn());
        all[label] = out;
        c.ok(`${label} renders`, out.length > 200, `${out.length} chars`);
        return out;
      } catch (e) {
        c.ok(`${label} renders`, false, String((e as Error)?.stack ?? e).slice(0, 600));
        return "";
      }
    };

    c.head("1 · the old screen redirects; the room renders");
    const { default: Old } = await import("@/app/ops/video-delivery/page");
    let to = "";
    try {
      Old();
    } catch (e) {
      to = e instanceof Redirect ? e.href : String(e);
    }
    c.ok("/ops/video-delivery redirects to /review", to === "/review", to);
    const { default: Page } = await import("@/app/review/page");
    const owner = await render("the Video Review Room (owner, no login in a drill = local owner)", () => Page({ searchParams: Promise.resolve({}) }));
    const t = text(owner);

    c.head("2 · what it says");
    c.ok("the header: Video Review Room, to review, ready to send, with editors (late)", /Video Review Room/.test(t) && /\d+ to review · \d+ ready to send · \d+ with editors \(\d+ late\)/.test(t), t.slice(0, 300));
    c.ok("the late video is under With the editors, first, with how late", /With the editors \d+, \d+ late 1 Late Lane/.test(t) && /Late by \d+ h/.test(t), (t.match(/With the editors .{0,200}/) ?? [""])[0]);
    c.ok("a started run shows its three steps and its own words", /3 Sending St/.test(t) && /Uploading On the listing Sent/.test(t) && /Sending the 1080p file to Aryeo: 10 of 23 parts/.test(t) && /aria-current="step"[^>]*>Uploading</.test(owner));
    c.ok("a held run says why, under Held", /Held \(\d+\).*4 Held Ct/.test(t) && /Sound check held this file: this video has no sound/.test(t));
    c.ok("a run the hub will not send says so, with the hand path open", /5 By Hand Rd/.test(t) && /never checked, so the hub does not send it on its own/.test(t) && /Done it by hand\?/.test(t));
    c.ok("a row nobody pressed offers Upload to Aryeo and send", /6 Fresh St.{0,400}Upload to Aryeo and send/.test(t));
    c.ok("no Monthly content section any more (the monthly videos live on the Shoots page and the Dashboard)", !/>Monthly content</.test(owner));
    c.ok("no switch card any more (button only)", !/The hub sends listing videos to Aryeo/.test(t) && !/Practice run/.test(t) && !/Upload and deliver/.test(t));

    c.head("3 · the delivery card row");
    const { readyToSend } = await import("@/lib/readyToSend");
    const board = await readyToSend({ projectId: sending.p.id });
    const { ReadyToSendCard } = await import("@/components/ops/ReadyToSendCard");
    const card = await render("the delivery card", () => createElement(ReadyToSendCard as never, { board } as never));
    const ct = text(card);
    c.ok("a started run: the card carries its line and a link to the Video Review Room, not 'Upload this version to Aryeo'", /Sending the 1080p file to Aryeo/.test(ct) && /href="\/review"/.test(card) && /Video Review Room/.test(ct) && !/Upload this version to Aryeo and deliver the listing/.test(ct), ct.slice(0, 400));
    const freshBoard = await readyToSend({ projectId: fresh.p.id });
    const card2 = await render("the delivery card (a row nobody pressed)", () => createElement(ReadyToSendCard as never, { board: freshBoard } as never));
    const ct2 = text(card2);
    c.ok("a row nobody pressed: the button's words, never that the hub is sending it", /Press Upload to Aryeo and send in the Video Review Room/.test(ct2) && !/hub sends|next pass|is uploading/i.test(ct2), ct2.slice(0, 400));

    c.head("4 · copy");
    // The three sections (To review, Ready to send, With the editors) and the history link.
    const delivery = t.slice(t.indexOf(" To review "));
    c.ok("no em or en dash in the delivery sections", !LONG_DASH.test(delivery), (delivery.match(/.{40}[–—].{40}/) ?? [""])[0]);
    c.ok("nothing rendered says undefined or NaN", Object.values(all).every((h) => !/\b(undefined|NaN)\b/.test(text(h))));

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
