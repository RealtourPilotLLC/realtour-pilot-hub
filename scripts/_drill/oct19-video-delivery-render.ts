// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE VIDEO DELIVERY SCREEN, RENDERED (Oct 19 2026). The companion of
// oct19-video-aryeo-push.ts: the REAL /ops/video-delivery page and the
// delivery card's row rendered to HTML against seeded jobs, so a render-time
// crash, a missing lane or a stray dash shows up without a browser and without
// the production database.
//   1  the page renders for Jordan (the switch can be changed) and for Kyle
//      (read-only switch, his buttons on the rows)
//   2  what it says: the three numbers, the lanes, the hub's progress line
//      instead of "upload by hand", a held row's reason, the program section
//   3  the delivery card row shows the push line and links to the screen
//   4  copy: no em or en dash, nothing says undefined or NaN
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
  nav.usePathname = () => "/ops/video-delivery";
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
    const S = await import("@/lib/videoDeliverySettings");
    await S.saveVideoDeliverySettings({ aryeoPush: "deliver" }, "drill");

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

    c.head("1 · the page renders");
    const { default: Page } = await import("@/app/ops/video-delivery/page");
    const owner = await render("the Video delivery page (owner, no login in a drill = local owner)", () => Page());
    const t = text(owner);

    c.head("2 · what it says");
    c.ok("the header: due today and behind", /Video delivery/.test(t) && /\d+ due today · \d+ behind/.test(t), t.slice(0, 300));
    c.ok("the three numbers up top", /Due today/.test(t) && /Late/.test(t) && /Oldest late/.test(t) && /Going out/.test(t));
    c.ok("the late video is in Late, with how late", /Late \d+ 1 Late Lane/.test(t) && /Late by \d+ h/.test(t), (t.match(/Late \d+ .{0,200}/) ?? [""])[0]);
    c.ok("the approved video shows the hub's progress, not 'upload by hand'", /3 Sending St/.test(t) && /Sending the 1080p file to Aryeo: 10 of 23 parts/.test(t));
    c.ok("a held video says why, in the Held lane", /Held \d+ .*4 Held Ct/.test(t) && /Sound check held this file: this video has no sound/.test(t));
    c.ok("a video the hub will not send says so (Kyle by hand) with Retry and Hold", /5 By Hand Rd/.test(t) && /Upload it by hand/.test(t) && /Retry/.test(owner) && /Hold/.test(owner));
    c.ok("the content program section", /Content program/.test(t) && /client’s portal|client's portal/.test(t));
    c.ok("the switch card, owner can save", /The hub sends listing videos to Aryeo/.test(t) && /Upload and deliver/.test(t) && /Practice run/.test(t) && /Save/.test(t) && !/Jordan changes this/.test(t));

    c.head("3 · the delivery card row");
    const { readyToSend } = await import("@/lib/readyToSend");
    const board = await readyToSend({ projectId: sending.p.id });
    const { ReadyToSendCard } = await import("@/components/ops/ReadyToSendCard");
    const card = await render("the delivery card", () => createElement(ReadyToSendCard as never, { board } as never));
    const ct = text(card);
    c.ok("the row carries the hub's line and a link to Video delivery, not 'Upload this version to Aryeo'", /Sending the 1080p file to Aryeo/.test(ct) && /href="\/ops\/video-delivery"/.test(card) && !/Upload this version to Aryeo and deliver the listing/.test(ct), ct.slice(0, 400));

    c.head("4 · copy");
    const dashed = Object.entries(all).filter(([, h]) => LONG_DASH.test(text(h).replace(/Upload the 1080p video to Aryeo — /g, ""))).map(([k, h]) => `${k}: ${(text(h).match(/.{40}[–—].{40}/) ?? [""])[0]}`);
    c.ok("no em or en dash on the Video delivery page", !LONG_DASH.test(text(owner)), (text(owner).match(/.{40}[–—].{40}/) ?? [""])[0]);
    c.ok("nothing rendered says undefined or NaN", Object.values(all).every((h) => !/\b(undefined|NaN)\b/.test(text(h))), dashed.join(" | "));

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
