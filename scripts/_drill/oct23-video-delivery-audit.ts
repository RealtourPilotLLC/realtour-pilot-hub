// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL oct23-video-delivery-audit: the Oct 23 2026 night audit of Video
// Delivery, the Review Room and the Topaz pass (Jordan: "Do a full audit on
// all the changes lately and what could have broke and what we may have
// missed and fix it").
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-video-delivery-audit.ts --logs <dir>
//
//   §1 REPORT-ONLY, RED UNTIL FIXED: "Run Topaz again" on a video whose
//      "Upload to Aryeo and send" press is parked (held at a gate before the
//      upload). The press survives the re-run, and once the NEW render is
//      filed and checked the hub carries the OLD press on: it goes to the
//      listing to upload (and then deliver) a file nobody has watched. The
//      fix belongs in lib/topazJobs.rerunTopazJob (another builder holds it
//      tonight): retire the parked run with the re-run.
//   §2 the Settings page says what the saved switch does (the skip is off),
//      and "Put the sliders back" keeps the mode (no stale Auto)
//   §3 the held file's "Keep the approved original" and "Try the pass again"
//      ask and wait (no six-second revert, the bug that ate Jordan's presses)
//   §4 the job page in a preview is read-only; its "Send it in the Video
//      Review Room" link opens the room's Ready to send
//   §5 Kyle's desk: a video it can't press for opens Video Delivery's Ready to
//      send ("Open in Video Delivery"), never the cut's page
//   §6 the old "/#video-review" links (the Topaz bells, Slack) open Video
//      Delivery's Ready to send
//
// Shipped code against an isolated PGlite; Dropbox and Aryeo's public API are
// answered in-process, every other outbound call is fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6643);
const REPO = path.resolve(__dirname, "..", "..");
const src = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/\s+/g, " ");
const buttons = (frag: string) => [...frag.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim());

// ---- the login: real sessions (lib/auth/session), as the upload-only drill does --
installNextStubs();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/review";
  nav.useSearchParams = () => new URLSearchParams();
}

// ---- the cut store's bytes ---------------------------------------------------
const BYTES = new Uint8Array(1000).map((_, i) => i % 251);
const blobUrlFor = (name: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${name}`;
const fence = fenceFetch((url) => {
  if (!url.startsWith("https://drillstore.public.blob.vercel-storage.com/")) return null;
  return new Response(BYTES, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(BYTES.length) } });
});
const isMod = (r: string, tail: string) => r === `@/lib/${tail}` || r.endsWith(`/src/lib/${tail}`) || r.endsWith(`/src/lib/${tail}.ts`);
const wrapOnce = <T extends object>(make: (m: T) => T) => {
  const cache = new WeakMap<object, T>();
  return (loaded: unknown) => {
    const m = loaded as T;
    if (!cache.has(m)) cache.set(m, make(m));
    return cache.get(m);
  };
};

// ---- Dropbox, faked: a little file system --------------------------------------
const FS = new Map<string, number>();
interceptModule(
  (r) => isMod(r, "integrations/dropbox"),
  wrapOnce<Record<string | symbol, unknown>>((m) => new Proxy(m, {
    get(t, k) {
      const DErr = t.DropboxError as new (msg: string, status?: number) => Error;
      if (k === "dropboxConfigured") return () => true;
      if (k !== "dbx") return t[k];
      return async (ep: string, arg: Record<string, unknown> = {}) => {
        const p = String(arg.path ?? arg.from_path ?? "");
        switch (ep) {
          case "files/create_folder_v2": return { metadata: { path_display: p } };
          case "files/get_metadata":
            if (!FS.has(p)) throw new DErr("path/not_found/", 409);
            return { ".tag": "file", size: FS.get(p), path_display: p };
          case "files/get_temporary_link":
            if (!FS.has(p)) throw new DErr("path/not_found/", 409);
            return { link: `https://dbx.invalid/tmp${p}`, metadata: { size: FS.get(p) } };
          case "files/move_v2": {
            const from = String(arg.from_path);
            let to = String(arg.to_path);
            if (!FS.has(from)) throw new DErr("from_lookup/not_found/", 409);
            if (FS.has(to)) {
              if (!arg.autorename) throw new DErr("to/conflict/file/", 409);
              to = to.replace(/(\.[^./]+)?$/, (ext) => ` (1)${ext ?? ""}`);
            }
            FS.set(to, FS.get(from)!);
            FS.delete(from);
            return { metadata: { path_display: to } };
          }
          default: throw new DErr(`drill: unscripted dropbox endpoint ${ep}`, 400);
        }
      };
    },
  })),
);

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "oct23-video-delivery-audit", DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const settings = await import("@/lib/settings");
  const { actualFolderPaths } = await import("@/lib/dropboxFolders");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const actions = await import("@/app/ops/deliveryRecoveryActions");
  const push = await import("@/lib/videoAryeoPush");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("dropbox", "drill-refresh", { accountLabel: "drill" });
  await saveSecret("aryeo_web", "drill-hub-password", { accountLabel: "hub@realtourpilot.com", metadata: { email: "hub@realtourpilot.com" } });
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "ADMIN" } });
  const kyle = await prisma.appUser.create({ data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
  const jordan = await prisma.appUser.create({ data: { name: "Jordan Drill", email: "jordan@drill.invalid", role: "OWNER", status: "ACTIVE" } });
  type Login = { id: string; email: string; role: string };
  /** Sign in as `u`; `previewing` = Jordan's "view as" that login. */
  const signIn = (u: Login, previewing?: Login) =>
    previewing ? setSession({ uid: jordan.id, email: jordan.email, role: jordan.role, actingAs: previewing.id }) : setSession({ uid: u.id, email: u.email, role: u.role });

  // The live settings tonight: the lane on, the skip off, Manual.
  const saved = await settings.topazSettings();
  await settings.putSetting("topaz", { ...saved, enabled: true, skipFinished1080p: false, params: { ...saved.params, auto: "Manual" } });
  const client = await prisma.client.create({ data: { name: "Morgan Realty" }, select: { id: true } });

  /** An approved listing video whose Topaz file is finished and checked, not sent. */
  let n = 0;
  async function mkVideo(street: string, job: "done" | "skipped" = "done") {
    n++;
    const folder = `/Listings/Drill/${street}`;
    const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId: client.id, status: "REVIEW", source: "ARYEO", aryeoListingId: `lst-audit-${n}`, dropboxFolder: folder }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
    const final = actualFolderPaths({ dropboxFolder: folder } as Parameters<typeof actualFolderPaths>[0]).finalVideo;
    const original = `${final}/superseded/Real Estate Video Tour - v1.mp4`;
    const render = `${final}/Real Estate Video Tour - v1 - FINAL (Topaz).mp4`;
    FS.set(original, 90_000_000);
    const sub = await prisma.reviewSubmission.create({
      data: { projectId: p.id, deliverableId: d.id, slot: 1, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "Real Estate Video Tour - v1.mp4", blobUrl: blobUrlFor(`audit-${n}.mp4`), sizeBytes: BYTES.length, finalPath: original, completedAt: new Date(Date.now() - 3_600_000), decidedAt: new Date(Date.now() - 3_600_000), decidedBy: "James" },
      select: { id: true },
    });
    await ensureOutputsForProject(p.id).catch(() => null);
    const base = { projectId: p.id, submissionId: sub.id, sourceWidth: 3840, sourceHeight: 2160, sourceDurationSec: 30, sourceSizeBytes: BYTES.length, sourceHasAudio: true, sourceAudioCodec: "mp4a", startedAt: new Date(Date.now() - 1_900_000) };
    const j = job === "done"
      ? await prisma.topazJob.create({ data: { ...base, state: "done", finalPath: render, savedAt: new Date(Date.now() - 600_000), outputCheck: "verified", acceptedAt: new Date(Date.now() - 1_800_000), estimateCredits: 16, creditsCharged: 16, finishedAt: new Date(Date.now() - 600_000) }, select: { id: true } })
      : await prisma.topazJob.create({ data: { ...base, state: "skipped", skipReason: "This video would cost about 30 credits and the limit per video is 20. Nothing was charged.", finishedAt: new Date(Date.now() - 600_000) }, select: { id: true } });
    if (job === "done") FS.set(render, 40_000_000);
    return { projectId: p.id, subId: sub.id, jobId: j.id, render, street };
  }
  const pressRerun = async (jobId: string) => {
    await signIn(kyle);
    return actions.rerunTopazAction(jobId);
  };

  // =========================================================================
  c.head("§1 · REPORT-ONLY (red until lib/topazJobs.rerunTopazJob retires a parked press): Run Topaz again never sends the new file on the old press");
  // =========================================================================
  {
    const A = await mkVideo("10 Parked Press Rd");
    // Kyle pressed "Upload to Aryeo and send"; it stopped at a gate before the
    // upload (an open client request), to go by itself once that clears.
    const key = `video_aryeo_push:${A.subId}`;
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await prisma.appSetting.create({ data: { key, value: JSON.stringify({
      id: "run-parked", submissionId: A.subId, projectId: A.projectId, listingId: "lst-audit-1", topazJobId: A.jobId, state: "HELD", mode: "deliver",
      hold: { gate: "asks", why: "Waiting for 1 open client request to be checked.", by: null, at, resume: "PREPARING" }, wait: null,
      recheckAt: new Date(Date.now() - 60_000).toISOString(), addSentAt: null, mediaId: null, by: "Kyle Drill", startedAt: at, updatedAt: at,
      file: { path: A.render, name: A.render.split("/").pop(), size: null, durationSec: 30, contentType: "video/mp4" }, errors: 0,
    }) } });
    const r = await pressRerun(A.jobId);
    c.ok("the re-run is accepted (a press parked before the upload does not block it)", r.ok, r.message);
    const after = await push.videoPushRun(A.subId);
    const live = !!after && after.state !== "FAILED" && after.state !== "DONE";
    c.ok("REPORT-ONLY: the parked press is retired with the re-run (nothing left that goes by itself)", !live || (after?.state === "HELD" && after.hold?.gate === "manual"), JSON.stringify({ state: after?.state, gate: after?.hold?.gate, resume: after?.hold?.resume, recheckAt: after?.recheckAt }));

    // The new render comes back, filed and checked, exactly as the lane files it.
    await prisma.topazJob.update({ where: { id: A.jobId }, data: { state: "done", finalPath: A.render, savedAt: new Date(), outputCheck: "verified", acceptedAt: new Date(), estimateCredits: 16, finishedAt: new Date() } });
    FS.set(A.render, 41_000_000);
    push.__setVideoPushHooksForTests({ openAsks: async () => [], soundCheck: async () => ({ verdict: "ok", message: "ok", av: null }), sleep: async () => {} });
    // advanceVideoPush moves a run while more than 5 s of its budget is left.
    // Aryeo's public API is fenced here, so a run that got past every gate
    // stops at its first listing read ("could not be read just now").
    await push.advanceVideoPush(A.subId, { budgetMs: 8000 }).catch((e: Error) => console.log("  (advance)", e.message));
    const moved = await push.videoPushRun(A.subId);
    push.__setVideoPushHooksForTests(null);
    c.ok("REPORT-ONLY: nobody pressed send for the new render, so the hub never starts uploading it (the old press does not carry on)", !["PREPARING", "SENDING", "ADDING", "CHECKING", "REPLACING", "DELIVERING", "CONFIRMING"].includes(moved?.state ?? "") && !/listing could not be read/.test(moved?.note ?? ""),
      `run ${moved?.state} (mode ${moved?.mode}, by ${moved?.by}): ${moved?.note ?? ""}`);
  }

  // =========================================================================
  c.head("§2 · Settings: the plain line follows the skip switch; Put the sliders back keeps the mode");
  // =========================================================================
  {
    const { TopazSettingsPanel } = await import("@/components/settings/TopazSettingsPanel");
    const s = await settings.topazSettings();
    const props = { initial: s, defaults: settings.DEFAULT_TOPAZ_PARAMS, aryeoNote: "", usage: null, isOwner: true };
    let off = "";
    let on = "";
    try {
      off = html(createElement(TopazSettingsPanel, props));
      on = html(createElement(TopazSettingsPanel, { ...props, initial: { ...s, skipFinished1080p: true } }));
    } catch (e) {
      off = on = `ERROR ${String((e as Error)?.stack ?? e).slice(0, 400)}`;
    }
    const line = (h: string) => /data-topaz-plain-line[^>]*>([\s\S]*?)<\/p>/.exec(h)?.[1] ?? "";
    c.ok("the skip is off (the live setting): every approved video gets the Topaz pass, never 'go out as they are'", /Every approved video gets the Topaz pass/.test(text(line(off))) && !/go out as they are/.test(line(off)), text(line(off)) || off.slice(0, 200));
    c.ok("…and with the skip on, the 1080p exports go out as they are", /already exported at 1080p go out as they are/.test(text(line(on))), text(line(on)));
    c.ok("the mode on screen is the saved one (Manual), not the defaults' Auto", /<option value="Manual" selected="">/.test(off) || /value="Manual"[^>]*selected/.test(off), (/<select[\s\S]*?<\/select>/.exec(off)?.[0] ?? "").slice(0, 200));
    const panel = src("src/components/settings/TopazSettingsPanel.tsx");
    c.ok("Put the sliders back puts the sliders back and keeps the mode (it used to flip Manual to Auto)", /params: \{ \.\.\.defaults, auto: p\.params\.auto \}/.test(panel) && !/params: \{ \.\.\.defaults \} \}\)/.test(panel));
    c.ok("the defaults' mode is still Auto (why the button must not copy it)", settings.DEFAULT_TOPAZ_PARAMS.auto === "Auto");
  }

  // =========================================================================
  c.head("§3 · Keep the approved original and Try the pass again ask and wait for Yes or Cancel");
  // =========================================================================
  {
    for (const f of ["src/components/ops/HeldRender.tsx", "src/components/ops/RetryRender.tsx"]) {
      const s = src(f);
      c.ok(`${f.split("/").pop()}: no timer reverts the question`, !/setTimeout/.test(s), f);
      c.ok(`${f.split("/").pop()}: the question has a Cancel`, />\s*Cancel\s*</.test(s));
    }
    const { HeldRender } = await import("@/components/ops/HeldRender");
    const h = html(createElement(HeldRender, { jobId: "job1", street: "1 Held St", fileName: "a.mp4", dropboxUrl: null, lastCheck: null }));
    c.ok("the held file's buttons: Check again, Keep the approved original, I listened (the question is not open yet)", JSON.stringify(buttons(h)) === JSON.stringify(["Check again", "Keep the approved original", "I listened — use this file"]), JSON.stringify(buttons(h)));
    const m = html(createElement(HeldRender, { jobId: "job1", street: "1 Held St", fileName: "a.mp4", dropboxUrl: null, lastCheck: null, monthly: true }));
    c.ok("…a portal video still has no Keep the original", !buttons(m).some((b) => /Keep/.test(b)), JSON.stringify(buttons(m)));
    const { RetryRender } = await import("@/components/ops/RetryRender");
    c.ok("Try the pass again draws one button until pressed", JSON.stringify(buttons(html(createElement(RetryRender, { jobId: "job1", street: "1 St" })))) === JSON.stringify(["Try the pass again"]));
  }

  // =========================================================================
  c.head("§4 · the job page: a preview is read-only; the room link opens Ready to send");
  // =========================================================================
  const B = await mkVideo("20 Preview Pl");
  const H = await mkVideo("30 By Hand Ave", "skipped");
  {
    const { videoDeliveryBoard } = await import("@/lib/videoDelivery");
    await videoDeliveryBoard({ fresh: true });
    const { JobDeliverablesSection } = await import("@/components/jobs/JobDeliverables");
    const render = async (projectId: string, u: Login, previewing?: Login) => {
      await signIn(u, previewing);
      try {
        return html(await JobDeliverablesSection({ projectId }));
      } catch (e) {
        return `ERROR ${String((e as Error)?.stack ?? e).slice(0, 400)}`;
      }
    };
    const kylePage = await render(B.projectId, kyle);
    c.ok("Kyle's job page: Upload to Aryeo and send, Upload to Aryeo only, Run Topaz again", ["Upload to Aryeo and send", "Upload to Aryeo only", "Run Topaz again"].every((b) => buttons(kylePage).includes(b)), JSON.stringify(buttons(kylePage)) || kylePage.slice(0, 300));
    const preview = await render(B.projectId, jordan, kyle);
    c.ok("Jordan previewing Kyle: the same page with no presses on it (each would be refused)", !buttons(preview).some((b) => /Upload to Aryeo|Run Topaz again|Send now/.test(b)) && /Send it in the Video Review Room/.test(text(preview)), JSON.stringify(buttons(preview)) || preview.slice(0, 300));
    const byHand = await render(H.projectId, kyle);
    await clearSession().catch(() => {});
    const link = /<a[^>]*href="([^"]*)"[^>]*data-send-in-room|<a[^>]*data-send-in-room[^>]*href="([^"]*)"/.exec(byHand);
    c.ok("a by-hand video's 'Send it in the Video Review Room' opens the room's Ready to send (the cut's page has no hand path)", (link?.[1] ?? link?.[2]) === "/review#ready-to-send", link?.[0] ?? byHand.slice(0, 300));
  }

  // =========================================================================
  c.head("§5 · Kyle's desk: a video it cannot press for opens Video Delivery");
  // =========================================================================
  {
    const desk = await import("@/lib/officeDesk");
    const data = await desk.officeDeskFor(null, { includeTest: true }).catch((e: Error) => { console.log("  (desk)", e.message); return null; });
    const deliver = data?.sections.find((x) => x.key === "deliver");
    const item = deliver ? [...deliver.now, ...deliver.waiting, ...deliver.ok].find((i) => i.id === `video:${H.projectId}`) : undefined;
    const links = (item?.actions ?? []).filter((a) => a.kind === "link") as { label: string; href: string }[];
    c.ok("the by-hand video's action: Open in Video Delivery, to Ready to send", links.some((a) => a.label === "Open in Video Delivery" && a.href === "/review#ready-to-send"), JSON.stringify(item?.actions));
    c.ok("…never 'Open in Videos' anywhere on the desk", !JSON.stringify(data ?? {}).includes("Open in Videos"));
  }

  // =========================================================================
  c.head("§6 · old /#video-review links open Video Delivery's Ready to send");
  // =========================================================================
  {
    const { forwardedHref } = await import("@/lib/homeAnchors");
    c.ok("/#video-review → /review#ready-to-send (test scope kept)", forwardedHref("/", "", "#video-review") === "/review#ready-to-send" && forwardedHref("/", "?test=1", "#video-review") === "/review?test=1#ready-to-send");
    c.ok("…the other old anchors still go where they went", forwardedHref("/", "", "#loops") === "/ops/checklist#loops" && forwardedHref("/", "", "#comms-1") === "/communications");
  }

  c.head("Z · isolation");
  c.ok("nothing left the process", fence.blocked.filter((u) => !u.startsWith("https://dbx.invalid/")).length === 0, fence.blocked.slice(0, 3).join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
