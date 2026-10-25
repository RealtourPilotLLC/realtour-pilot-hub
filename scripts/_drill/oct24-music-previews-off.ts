// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL oct24-music-previews-off: the Music card when Epidemic Sound's preview
// allowance is used up (Oct 24 2026).
//
//   DRILL_PORT=48xx node scripts/_drill/run-all.cjs scripts/_drill/oct24-music-previews-off.ts --logs <dir>
//
// Jhon Mark (editor): "why is it I can't play the songs here?" The hub's API
// key is on Epidemic Sound's free tier and its previews ran out: every Play
// got 402 "Stream quota exceeded", shown as a grey line far below the list.
//
//   §1 the error: a 402 on /stream is a "quota" error in plain words, a 402 on
//      /download says downloads, other statuses keep their kinds
//   §2 the action: a refused preview is remembered, the next good preview
//      clears it, and an old refusal (6 h+) lets Play try again
//   §3 the card: paused → the note at the top and a "Listen on Epidemic
//      Sound" link per track (title + artist search) instead of Play; not
//      paused → Play as before, no note; the office line only for the office
//   §4 the edit page reads the flag; Connections "Test connection" names it
//      and spends no preview; a newly saved key clears it
//
// ISOLATION: PGlite via the shared harness, every .env key blank. EPIDEMIC
// SOUND IS FAKE: answered at the fence below and counted; anything else that
// leaves the machine is refused.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 4893);
const REPO = path.resolve(__dirname, "..", "..");
const src = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
const login = (role: string, o: Partial<Viewer> = {}): Viewer => ({
  id: `u-${role.toLowerCase()}`, email: `${role.toLowerCase()}@drill.invalid`, name: role, role, permissions: null, status: "ACTIVE",
  teamMemberId: null, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: null, ...o,
});
const JORDAN = login("OWNER", { name: "Jordan" });
const viewer: Viewer | null = JORDAN;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);
installNextStubs();

const KEY = ["epidemic_live_", "drillFakeKey0123456789"].join("");
const TRACK = { id: "07e2e4ec-0727-4b5a-a76a-c360d6afb20e", title: "DOX", mainArtists: ["Lennon Hutton"], bpm: 74, length: 237, moods: [{ id: "dark", name: "Dark" }], genres: [], hasVocals: false, isPreviewOnly: true };
const es = { calls: [] as string[], streamQuota: true, downloadQuota: false };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => {
  if (!url.startsWith("https://partner-content-api.epidemicsound.com/")) return null;
  const u = new URL(url);
  es.calls.push(u.pathname);
  if (u.pathname === "/v0/moods") return json(200, { moods: [{ id: "dark", name: "Dark" }], links: {} });
  if (u.pathname === "/v0/collections") return json(200, { collections: [], links: {} });
  if (u.pathname === "/v0/tracks/search") return json(200, { tracks: [TRACK], links: {} });
  if (u.pathname.endsWith("/stream")) return es.streamQuota ? json(402, { message: "Stream quota exceeded" }) : json(200, { url: "https://pdn.epidemicsound.com/hls/x.m3u8?sig=1", expires: "2026-10-25T15:00:00Z" });
  if (u.pathname.endsWith("/download")) return es.downloadQuota ? json(402, { message: "Download quota exceeded" }) : json(200, { url: "https://pdn.epidemicsound.com/x.mp3?sig=1", expires: "2026-10-25T15:00:00Z" });
  if (u.pathname.endsWith("/forbidden")) return json(403, { message: "nope" });
  return json(404, { message: "not found" });
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct24-music-previews-off-isolated" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const core = await import("@/lib/integrations/epidemicSoundCore");
  const esLib = await import("@/lib/integrations/epidemicSound");
  const music = await import("@/components/editing/music.actions");
  const conn = await import("@/app/connections/actions");
  const { MusicCard } = await import("@/components/editing/MusicCard");
  const QUOTA_KEY = "epidemic-sound:preview-quota";

  try {
    // ---- §1 the error ----------------------------------------------------------
    c.head("§1 a 402 is a plain-words quota error");
    const cfg = { key: KEY, userId: "drill" };
    const errOf = (p: string) => core.esRequestWith(cfg, p).then(() => null, (e: InstanceType<typeof core.EpidemicSoundError>) => e);
    const s402 = await errOf(`/v0/tracks/${TRACK.id}/stream`);
    c.ok("stream 402 → kind quota", s402?.kind === "quota" && s402.status === 402, `${s402?.kind} ${s402?.status}`);
    c.ok("stream 402 → says previews are used up", s402?.message === "Song previews are used up on the hub's Epidemic Sound plan.", s402?.message);
    es.downloadQuota = true;
    const d402 = await errOf(`/v0/tracks/${TRACK.id}/download`);
    es.downloadQuota = false;
    c.ok("download 402 → says downloads are used up", d402?.kind === "quota" && /Downloads are used up/.test(d402.message), d402?.message);
    const f403 = await errOf(`/v0/tracks/${TRACK.id}/forbidden`);
    c.ok("a 403 is still 'forbidden'", f403?.kind === "forbidden");
    c.ok("no status code or 'quota exceeded' jargon in the stream message", !/402|exceeded/i.test(s402?.message ?? ""));

    // ---- the world: the key, one job -------------------------------------------
    const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
    const saved = await conn.connectApiKey(null, fd({ provider: "epidemic_sound", key: KEY }));
    if (!saved.ok) throw new Error(`key not saved: ${saved.message}`);
    const client = await prisma.client.create({ data: { name: "Joe Agent" } });
    const job = await prisma.project.create({ data: { title: "538 Onward Dr", clientId: client.id, status: "EDITING" } });

    // ---- §2 the action ---------------------------------------------------------
    c.head("§2 the preview action remembers a refusal and clears it");
    c.ok("nothing remembered at the start", !(await esLib.esPreviewsPaused()));
    const before = es.calls.length;
    const r1 = await music.musicPreviewUrl(job.id, TRACK.id);
    c.ok("a refused preview comes back as kind quota", !r1.ok && r1.kind === "quota", JSON.stringify(r1));
    c.ok("one stream call, no retry loop", es.calls.slice(before).filter((p) => p.endsWith("/stream")).length === 1);
    c.ok("the refusal is remembered", await esLib.esPreviewsPaused());
    const at = await esLib.esPreviewQuotaHitAt();
    c.ok("with the time it happened", !!at && Date.now() - at.getTime() < 60_000);
    await prisma.appSetting.update({ where: { key: QUOTA_KEY }, data: { value: JSON.stringify({ at: new Date(Date.now() - 7 * 3_600_000).toISOString() }) } });
    c.ok("a refusal older than 6 h lets Play try again", !(await esLib.esPreviewsPaused()));
    es.streamQuota = false;
    const r2 = await music.musicPreviewUrl(job.id, TRACK.id);
    c.ok("a good preview returns the signed stream", r2.ok && r2.data.url.includes("m3u8"));
    c.ok("and clears the remembered refusal", !(await prisma.appSetting.findUnique({ where: { key: QUOTA_KEY } })));
    const r3 = await music.musicPreviewUrl(job.id, TRACK.id);
    c.ok("a good preview with nothing remembered writes nothing", r3.ok && !(await prisma.appSetting.findUnique({ where: { key: QUOTA_KEY } })));

    // ---- §3 the card -----------------------------------------------------------
    c.head("§3 the card");
    const props = { projectId: job.id, connected: true, isOffice: false, canAct: true, pick: null, musicType: null };
    // The card opens collapsed; the drill renders it open, like Jhon had it.
    // `open` is the card's THIRD useState(false) (after showFilters and
    // showCollections); "the card is open in this render" below fails loudly
    // if that order ever changes.
    const React = createRequire(__filename)("react") as { useState: (i: unknown) => unknown };
    const realUseState = React.useState;
    const renderOpen = (p: Record<string, unknown>) => {
      let falses = 0;
      React.useState = (init: unknown) => (init === false && ++falses === 3 ? realUseState(true) : realUseState(init));
      try { return renderToStaticMarkup(createElement(MusicCard, p as never)); } finally { React.useState = realUseState; }
    };
    const paused = renderOpen({ ...props, previewsPaused: true });
    c.ok("paused: the note is at the top", paused.includes("data-music-previews-off") && paused.includes("Song previews are off for now."));
    c.ok("paused: the note comes before the recommendations", paused.indexOf("data-music-previews-off") < paused.indexOf("data-music-reco"));
    c.ok("paused: tells the editor what to do", paused.includes("listen to it on Epidemic Sound") && paused.includes("Use this track or Download"));
    c.ok("paused: the office line is not shown to an editor", !paused.includes("API plan needs an upgrade"));
    const office = renderOpen({ ...props, isOffice: true, previewsPaused: true });
    c.ok("paused: the office sees how to turn previews back on", office.includes("API plan needs an upgrade"));
    const live = renderOpen({ ...props, previewsPaused: false });
    c.ok("not paused: no note", !live.includes("data-music-previews-off"));
    c.ok("the card is open in this render", live.includes("data-music-reco"));
    const card = src("src/components/editing/MusicCard.tsx");
    c.ok("a quota refusal on Play pauses the card", /r\.kind === "quota"\) return setPaused\(true\)/.test(card));
    c.ok("paused rows link to an Epidemic Sound search for title + artist", card.includes("https://www.epidemicsound.com/music/search/?term=${encodeURIComponent(`${t.title} ${t.artist}`.trim())}"));
    c.ok("the link opens a new tab safely", /target="_blank"\s+rel="noopener noreferrer"\s+aria-label=\{`Listen to \$\{t\.title\} on Epidemic Sound`\}/.test(card));
    c.ok("a download quota note is a warning, not grey", /r\.kind === "not_connected" \|\| r\.kind === "quota" \? "warn"/.test(card));

    // ---- §4 page, Connections, new key -----------------------------------------
    c.head("§4 the edit page, Connections and a new key");
    const page = src("src/app/edit/[id]/page.tsx");
    c.ok("the edit page reads the flag only when connected", page.includes("musicRead.then((on) => (on ? esPreviewsPaused().catch(() => false) : false))"));
    c.ok("and hands it to the card", page.includes("previewsPaused={musicPreviewsPaused}"));
    es.streamQuota = true;
    await music.musicPreviewUrl(job.id, TRACK.id);
    const streamsBefore = es.calls.filter((p) => p.endsWith("/stream")).length;
    const t = await conn.testEpidemicSoundNow();
    c.ok("Test connection names the used-up previews", t.ok && /Song previews: used up on this API plan/.test(t.message), t.message);
    c.ok("with the time in ET and the way back", / ET\)/.test(t.message) && t.message.includes("developers.epidemicsound.com"));
    c.ok("Test connection spends no preview", es.calls.filter((p) => p.endsWith("/stream")).length === streamsBefore);
    const again = await conn.connectApiKey(null, fd({ provider: "epidemic_sound", key: KEY }));
    c.ok("a newly saved key clears the remembered refusal", again.ok && !(await esLib.esPreviewsPaused()) && !(await esLib.esPreviewQuotaHitAt()));
    const t2 = await conn.testEpidemicSoundNow();
    c.ok("and Test connection then says nothing about previews", t2.ok && !/Song previews/.test(t2.message));
    c.ok("nothing left the box but the fake Epidemic Sound", fence.blocked.length === 0 && fence.faked.every((u) => u.startsWith("https://partner-content-api.epidemicsound.com/")), fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
