// ---------------------------------------------------------------------------
// DRILL oct24-gemini-video-render: the screens of the Gemini video analysis
// (Oct 24 2026), server-rendered to HTML with the shipped components: the
// Connections card (key, today's requests, the fps setting and its token
// words, the switches, the trial summary and its open flags), the Review
// Room's spelling box for the owner (Right / Wrong) and for a reviewer (no
// buttons), the Settings switch (OFF, owner only), the portal cover picker
// (three covers, our pick, the download) and the Media library tile with a
// cover. No database, no network: props only. The HTML is written to
// $TMPDIR/rtp-gemini-render/ for a look.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/connections";
const fence = fenceFetch();

const OUT = path.join(os.tmpdir(), "rtp-gemini-render");
const save = (name: string, html: string) => { try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${name}.html`), html); } catch { /* optional */ } };
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const c = makeChecker();
const KEY = ["AIza", "SyRenderFake", "0123456789abcdefghij"].join("");

async function main() {
  const { GeminiCard } = await import("@/components/connections/GeminiCard");
  const { SpellingFlagsNote } = await import("@/components/review/SpellingFlags");
  const { SpellingFlagsSetting } = await import("@/components/settings/SpellingFlagsSetting");
  const { CoverPicker } = await import("@/components/portal/CoverPicker");
  const { VideoTile, VideoModal } = await import("@/components/media/VideoTile");

  c.head("1 · the Connections card");
  const card = {
    key_: { configured: true, stored: true, accountLabel: "Key accepted · Gemini 3.8 Flash available", savedAt: "2026-10-24T13:00:00.000Z", lastError: null },
    settings: { fps: 2, dailyCap: 40, covers: true, spelling: true, startedAt: "2026-10-24T13:00:00.000Z" },
    usage: { calls: 3, cap: 40, cooldownUntil: null, lastRunAt: null, lastError: null },
    counts: { queued: 1, waiting: 1, done: 6, failed: 0, covers: 3 },
    recentErrors: [],
    trial: {
      words: "4 flags · 3 right · 1 wrong · 75% right", barMet: false, startedAt: "2026-10-24T13:00:00.000Z", endsAt: "2026-11-07T13:00:00.000Z", reviewersOn: false,
      open: [{ submissionId: "cmvsubmission0001", href: "/review/cmvproject0001?cut=cmvsubmission0001", flagId: "f1-brandywyneln", line: "On screen: '412 Brandywine Ln' reads '412 Brandywyne Ln' at 00:03 (the address says 412 Brandywine Ln)." }],
    },
  } as const;
  const html = ssr(createElement(GeminiCard, card as never));
  save("gemini-card", html);
  const t = text(html);
  c.ok("renders", !html.startsWith("RENDER FAILED"), html.slice(0, 160));
  c.ok("names itself and its state: Gemini (video analysis) · Key saved", t.includes("Gemini (video analysis)") && t.includes("Key saved"));
  c.ok("today's requests against the ceiling", t.includes("3 of 40 requests (the day resets at midnight Pacific)"));
  c.ok("the fps setting with its token words", t.includes("2 fps · about 35k tokens per minute of video") && (html.match(/<option/g) ?? []).length === 5);
  c.ok("the two switches and the daily ceiling", t.includes("Covers") && t.includes("Spelling check (trial)") && t.includes("Most requests a day"));
  c.ok("the trial: flags, right, wrong, how often right", t.includes("Spelling check trial: 4 flags · 3 right · 1 wrong · 75% right"));
  c.ok("…the open flag, linked to its video, with Right / Wrong", t.includes("reads '412 Brandywyne Ln' at 00:03") && html.includes('href="/review/cmvproject0001?cut=cmvsubmission0001"') && t.includes("Right") && t.includes("Wrong"));
  c.ok("…and where the reviewer switch is", t.includes("Settings → Video Review Room (off).") || t.includes("Settings → Video Review Room (off)"));
  c.ok("the key field is a password box, and no key is in the page", html.includes('type="password"') && !html.includes(KEY));
  const off = text(ssr(createElement(GeminiCard, { ...card, key_: { configured: false, stored: false, accountLabel: null, savedAt: null, lastError: null } } as never)));
  c.ok("no key: 'Not connected', and no settings until there is one", off.includes("Not connected") && !off.includes("Most requests a day") && off.includes("Test & save key"));

  c.head("2 · the Review Room's spelling box");
  const flags = [
    { id: "f1-westchester", line: "On screen: 'West Chester' reads 'Westchester' at 00:01 (the address says West Chester, as separate words).", verdict: "RIGHT" as const },
    { id: "f2-erica", line: "On screen: 'Erika Walker' reads 'Erica Walker' at 00:09 (the spelling list says Erika Walker).", verdict: null },
  ];
  const owner = ssr(createElement(SpellingFlagsNote, { submissionId: "cmvsubmission0001", flags, owner: true, trialWords: "4 flags · 3 right · 1 wrong · 75% right" }));
  save("spelling-owner", owner);
  const ot = text(owner);
  c.ok("owner: 'Check the spelling on screen', trial, only you see this", ot.includes("Check the spelling on screen") && ot.includes("trial, only you see this"));
  c.ok("owner: each flag with Right / Wrong, the marked one pressed", (owner.match(/aria-pressed="true"/g) ?? []).length === 1 && (ot.match(/Right/g) ?? []).length >= 2 && (ot.match(/Wrong/g) ?? []).length >= 2);
  const reviewer = ssr(createElement(SpellingFlagsNote, { submissionId: "cmvsubmission0001", flags, owner: false, trialWords: null }));
  const rt = text(reviewer);
  c.ok("reviewer: the same lines, no buttons, no trial words", rt.includes("reads 'Erica Walker' at 00:09") && !reviewer.includes("<button") && !rt.includes("only you see this"));
  c.ok("no scare words", !/AI found|error detected/i.test(ot + rt));

  c.head("3 · Settings: Show spelling flags to reviewers");
  const sw = ssr(createElement(SpellingFlagsSetting, { initial: false, isOwner: true, trialWords: "4 flags · 3 right · 1 wrong · 75% right" }));
  save("spelling-setting", sw);
  c.ok("the switch, OFF, named as Jordan asked", text(sw).includes("Show spelling flags to reviewers") && sw.includes('aria-checked="false"') && !/disabled=""/.test(sw));
  const kyle = ssr(createElement(SpellingFlagsSetting, { initial: false, isOwner: false, trialWords: null }));
  c.ok("for anyone else it is read-only and says who changes it", /disabled=""/.test(kyle) && text(kyle).includes("Only Jordan changes this."));

  c.head("4 · the portal cover picker");
  const covers = {
    options: [0, 1, 2].map((n) => ({ n, src: `/api/portal/cover/cmvvideo00001?m=tok&n=${n}`, downloadHref: `/api/portal/cover/cmvvideo00001?m=tok&n=${n}&dl=1` })),
    selected: 0, best: 0, pickedByClient: false, canPick: true,
  };
  const pick = ssr(createElement(CoverPicker, { videoId: "cmvvideo00001", covers }));
  save("cover-picker", pick);
  const pt = text(pick);
  c.ok("three covers, ours chosen ('Our pick')", (pick.match(/<img/g) ?? []).length === 3 && pt.includes("Our pick") && (pick.match(/aria-pressed="true"/g) ?? []).length === 1);
  c.ok("the chosen one's download beside it", pick.includes('href="/api/portal/cover/cmvvideo00001?m=tok&amp;n=0&amp;dl=1"') && pt.includes("Download the cover"));
  c.ok("the grid band in plain words", pt.includes("On your profile grid Instagram shows the middle of it."));
  const theirs = text(ssr(createElement(CoverPicker, { videoId: "cmvvideo00001", covers: { ...covers, selected: 2, pickedByClient: true } })));
  c.ok("their own pick reads 'Chosen'", theirs.includes("Chosen") && !theirs.includes("Our pick"));
  const ro = ssr(createElement(CoverPicker, { videoId: "cmvvideo00001", covers: { ...covers, canPick: false } }));
  c.ok("a seat that can't pick: the covers can't be pressed, the download still can", (ro.match(/disabled=""/g) ?? []).length === 3 && ro.includes("dl=1"));

  c.head("5 · the Media library tile");
  const video = { key: "cut:cmvsubmission0002", title: "19 Okehocking Ln", eyebrow: "Premium Social Media Reel", place: "19 Okehocking Ln, West Chester, PA", clientId: "cmvclient00001", clientName: "Erika Walker", projectId: "cmvproject0002", dateText: "Delivered Oct 24, 2026", orientation: "vertical" as const, poster: "/api/video-cover/cmvsubmission0002?n=0", playSrc: "/api/media/video/cmvsubmission0002", downloadHref: "/api/media/video/cmvsubmission0002?dl=1", durationSec: 31, coverHref: "/api/video-cover/cmvsubmission0002?n=0&dl=1" };
  const tile = ssr(createElement(VideoTile, { video, frame: "vertical" }));
  save("media-tile", tile);
  c.ok("the cover is the poster", tile.includes('src="/api/video-cover/cmvsubmission0002?n=0"'));
  c.ok("the More menu shows on every width when there is a cover", !/class="[^"]*@2xs:hidden[^"]*"[^>]*aria-label="More/.test(tile) && tile.includes("More for 19 Okehocking Ln"));
  const modal = ssr(createElement(VideoModal, { video, narrow: true, onClose: () => {} }));
  c.ok("the larger view offers 'Cover' beside Download", modal.includes('href="/api/video-cover/cmvsubmission0002?n=0&amp;dl=1"') && text(modal).includes("Cover"));

  c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
  console.log(`\nrendered pages: ${OUT}`);
  c.summary();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
