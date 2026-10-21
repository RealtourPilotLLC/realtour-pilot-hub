// ---------------------------------------------------------------------------
// DRILL: EVERY JOB SHOWS ITS CURRENT SCRIPT (Oct 20 2026).
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//
// Jordan, via the scripting platform: "every job in the hub always shows its
// current script, kept current automatically." Against a FAKE platform (the
// fetch fence answers its GETs; any write is counted and refused):
//
//   1. an Aryeo booking is matched by aryeo_order_id (the hub used to look up
//      only its own id, so these jobs never synced);
//   2. a draft saved for review is a status and a version number, never text;
//   3. the release to the creative is the crew script; the draft clears;
//   4. sent_to_client records the version the agent received;
//   5. project.script_updated (the creative changed it on the shoot link)
//      becomes the crew script, flagged as changed on site;
//   6. a photographer-confirmed filmed record is never overwritten; the
//      platform's current script is kept beside it;
//   7. an office correction in the hub stands against an older platform
//      version and gives way to a newer one;
//   8. an Aryeo booking the hub has not imported yet is skipped, not failed;
//      the reconcile links it once the job exists;
//   9. the 15-minute reconcile reads only what changed, was never read, or
//      shoots within three days;
//  10. the card: the version line, the filmed record with the current script
//      beneath it, a waiting draft as a status;
//  11. a forged signature is refused; nothing was ever written to the platform.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness; the platform is the
// fence's fake; no message leaves.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();

const BASE = "https://oct20-scripting.invalid";
const SECRET = "oct20-drill-webhook-secret";
type P = Record<string, unknown> & { id: string; aryeo_order_id: string | null; external_id: string | null; updated_at: string; appointment_date: string | null };
const platform = new Map<string, P>();
let reads = 0, listReads = 0, writes = 0;
const failDetailFor = new Set<string>();

const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith(`${BASE}/api/v1/projects`)) return null;
  if ((init?.method ?? "GET") !== "GET") { writes++; return new Response(JSON.stringify({ error: "drill: no writes" }), { status: 405 }); }
  const u = new URL(url);
  if (u.pathname === "/api/v1/projects") {
    listReads++;
    // updated_since (Oct 21 2026, the platform's a3757ab): updated_at >= it,
    // OLDEST change first, `limit` a page.
    const since = u.searchParams.get("updated_since");
    const limit = Number(u.searchParams.get("limit") ?? 200);
    let rows = [...platform.values()];
    if (since) rows = rows.filter((x) => Date.parse(x.updated_at) >= Date.parse(since)).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    const projects = rows.slice(0, limit).map(({ id, external_id, aryeo_order_id, status, updated_at, appointment_date, created_at }) => ({ id, external_id, aryeo_order_id, status, updated_at, appointment_date, created_at }));
    return new Response(JSON.stringify({ projects }), { status: 200 });
  }
  if (failDetailFor.has(decodeURIComponent(u.pathname.split("/").pop() ?? ""))) { reads++; return new Response(JSON.stringify({ error: "drill: platform hiccup" }), { status: 500 }); }
  reads++;
  const key = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  const by = u.searchParams.get("by");
  const p = [...platform.values()].find((x) => (by === "aryeo_order_id" ? x.aryeo_order_id === key : by === "external_id" ? x.external_id === key : x.id === key));
  return p ? new Response(JSON.stringify({ project: p }), { status: 200 }) : new Response(JSON.stringify({ error: "Project not found" }), { status: 404 });
});

const scriptText = (v: number, pool: string) => `## 1. SCRIPT 1: The Deck Is the Getaway\n\nHOOK: Some people drive hours for a weekend that feels like this.\nPAYOFF: The inside flows out to the fireplace, ${pool} and view. (v${v})`;
const opt = (pool: string) => [{ number: 1, hook: "Some people drive hours for a weekend that feels like this.", payoff: `The inside flows out to the fireplace, ${pool} and view.` }];

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5843), env: {
    SCRIPTING_BASE_URL: BASE, SCRIPTING_API_KEY: "oct20-fake-key", SCRIPTING_WEBHOOK_SECRET: SECRET,
  } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { POST } = await import("@/lib/webhooks/scripting");
    const sync = await import("@/lib/scriptSync");
    const { ReelScriptCard, currentScriptOf } = await import("@/components/project/ReelScriptCard");

    const send = async (event: string, data: Record<string, unknown>, sig?: string) => {
      const raw = JSON.stringify({ event, sent_at: new Date().toISOString(), data });
      const signature = sig ?? `sha256=${crypto.createHmac("sha256", SECRET).update(raw).digest("hex")}`;
      const req = new Request("https://hub.invalid/api/webhooks/scripting", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-scripting-event": event, "x-scripting-signature": signature } });
      const res = await POST(req as unknown as Parameters<typeof POST>[0]);
      return { status: res.status, body: await res.json().catch(() => null) as { ok?: boolean } | null };
    };
    const job = (id: string) => prisma.project.findUniqueOrThrow({ where: { id } });

    const client = await prisma.client.create({ data: { name: "John Collins TEST" } });
    const ridley = await prisma.project.create({ data: { clientId: client.id, title: "335 Ridley Creek Ln, West Chester, PA 19380", status: "SCHEDULED", source: "ARYEO", aryeoOrderId: "aryeo-ridley", shootDate: new Date(Date.now() + 86_400_000) } });
    const now = () => new Date().toISOString();
    const ridleyP: P = { id: "studio-ridley", external_id: null, aryeo_order_id: "aryeo-ridley", status: "intake_submitted", client_name: "John Collins TEST", address: "335 Ridley Creek Ln", updated_at: now(), appointment_date: new Date(Date.now() + 86_400_000).toISOString(), created_at: now(), script: null, script_version: null, on_site_script: null, hooks: null, links: { creative_url: `${BASE}/creative/tok` } };
    platform.set(ridleyP.id, ridleyP);
    const summary = (p: P) => ({ id: p.id, external_id: p.external_id, aryeo_order_id: p.aryeo_order_id, status: p.status, updated_at: p.updated_at });

    // ======================================================================
    c.head("1 · an Aryeo booking is matched by its order");
    const r1 = await send("project.created", summary(ridleyP));
    const j1 = await job(ridley.id);
    c.ok("project.created is accepted and linked to the job by aryeo_order_id", r1.status === 200 && r1.body?.ok === true && j1.scriptingId === "studio-ridley" && j1.scriptingStatus === "intake_submitted", JSON.stringify(r1));
    c.ok("…with no script yet", !j1.reelScript && !j1.scriptingScript);

    // ======================================================================
    c.head("2 · a draft waiting on review is a status, never text");
    ridleyP.status = "awaiting_review"; ridleyP.updated_at = now();
    await send("project.script_generated", { ...summary(ridleyP), script_version: { generation_id: "g9", version_number: 9, source: "producer", status: "awaiting_review", based_on_generation_id: null, created_at: now() } });
    const j2 = await job(ridley.id);
    c.ok("the draft's version is recorded", j2.scriptingDraftVersion === 9 && j2.scriptingStatus === "awaiting_review");
    c.ok("…and no draft text reached the hub", !j2.reelScript && !j2.scriptingScript);

    // ======================================================================
    c.head("3 · the release to the creative is the crew script");
    const v9at = new Date(Date.now() - 3 * 3600_000).toISOString();
    ridleyP.status = "approved"; ridleyP.updated_at = now();
    ridleyP.script = { raw: scriptText(9, "pool"), generated_at: v9at, song: "Warm instrumental", options: opt("pool") };
    ridleyP.script_version = { generation_id: "g9", version_number: 9, source: "producer", approved_at: v9at, delivered_at: null };
    await send("project.updated", { ...summary(ridleyP), change: { kind: "released_to_creative", by: "jordan" }, script_version: { generation_id: "g9", version_number: 9, source: "producer", status: "approved", based_on_generation_id: null, created_at: v9at }, script: ridleyP.script });
    const j3 = await job(ridley.id);
    c.ok("the released v9 is the working script and the current script", j3.reelScript === scriptText(9, "pool") && j3.scriptingScript === scriptText(9, "pool") && j3.scriptingVersion === 9 && !j3.scriptingOnSiteBy);
    c.ok("…the hook and song came with it", j3.reelHook === "Some people drive hours for a weekend that feels like this." && j3.reelSong === "Warm instrumental");
    c.ok("…and the waiting draft cleared", j3.scriptingDraftVersion === null);

    // ======================================================================
    c.head("4 · the version the agent received");
    const sentAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    ridleyP.status = "sent_to_client"; ridleyP.updated_at = now();
    (ridleyP.script_version as Record<string, unknown>).delivered_at = sentAt;
    await send("project.sent_to_client", { ...summary(ridleyP), script_version: { generation_id: "g9", version_number: 9, source: "producer", approved_at: v9at, delivered_at: sentAt }, script: ridleyP.script });
    const j4 = await job(ridley.id);
    c.ok("sent_to_client records v9 and when", j4.scriptingClientVersion === 9 && j4.scriptingClientSentAt?.toISOString() === sentAt);

    // ======================================================================
    c.head("5 · the creative changes it on the shoot link");
    const v10at = new Date(Date.now() - 3600_000).toISOString();
    ridleyP.updated_at = now();
    ridleyP.on_site_script = { raw: scriptText(10, "swim spa"), generated_at: v10at, song: "Warm instrumental", options: opt("swim spa"), generation_id: "g10", version_number: 10, based_on_generation_id: "g9", edited_by: "creative-portal" };
    const readsBefore5 = reads;
    const r5 = await send("project.script_updated", { ...summary(ridleyP), change: { kind: "on_site_edit", by: "creative-portal", instruction: null, based_on_version_number: 9, spoken_words_changed: true, changed_after_client_delivery: true }, script_version: { generation_id: "g10", version_number: 10, source: "creative-on-site", status: "approved", based_on_generation_id: "g9", created_at: v10at }, script: { raw: scriptText(10, "swim spa"), generated_at: v10at, song: "Warm instrumental", options: opt("swim spa") } });
    const j5 = await job(ridley.id);
    c.ok("project.script_updated is accepted (a new event)", r5.status === 200 && r5.body?.ok === true);
    c.ok("v10 (swim spa) is the working and current script", j5.reelScript === scriptText(10, "swim spa") && j5.scriptingScript === scriptText(10, "swim spa") && j5.scriptingVersion === 10);
    c.ok("…flagged as changed on site by the creative", j5.scriptingOnSiteBy === "creative-portal");
    c.ok("…read from the event itself, no round trip", reads === readsBefore5);
    c.ok("…the agent's version is still v9", j5.scriptingClientVersion === 9);

    // ======================================================================
    c.head("6 · the photographer's filmed record is never overwritten");
    const typed = "Some people drive hours for a weekend that feels like this. I'd rather you just own it. (as said on camera)";
    await prisma.project.update({ where: { id: ridley.id }, data: { reelScript: typed, scriptConfirmedAt: new Date(), scriptConfirmNote: "Provided on site — typed by the photographer", reelRecipeUpdatedAt: new Date() } });
    const v11at = new Date().toISOString();
    ridleyP.updated_at = now();
    ridleyP.on_site_script = { ...(ridleyP.on_site_script as Record<string, unknown>), raw: scriptText(11, "swim spa and fire pit"), generated_at: v11at, version_number: 11, generation_id: "g11" };
    await send("project.script_updated", { ...summary(ridleyP), change: { kind: "on_site_ai_revise", by: "creative-portal", instruction: "add the fire pit", based_on_version_number: 10, spoken_words_changed: true, changed_after_client_delivery: true }, script_version: { generation_id: "g11", version_number: 11, source: "creative-on-site", status: "approved", based_on_generation_id: "g10", created_at: v11at }, script: { raw: scriptText(11, "swim spa and fire pit"), generated_at: v11at, options: opt("swim spa and fire pit") } });
    const j6 = await job(ridley.id);
    c.ok("the typed filmed record stays the working script", j6.reelScript === typed);
    c.ok("…while the current script moves to v11", j6.scriptingScript === scriptText(11, "swim spa and fire pit") && j6.scriptingVersion === 11);

    // A typed "record" that is only a note is not a filmed record (Oct 20 2026:
    // "N/A", "See dropbox folder for script" … typed when the hub had none).
    const noteJob = await prisma.project.create({ data: { clientId: client.id, title: "34 Oakland Rd TEST", status: "DELIVERED", source: "ARYEO", aryeoOrderId: "aryeo-oakland", reelScript: "See dropbox folder for script", scriptConfirmedAt: new Date(), scriptConfirmNote: "Provided on site — typed by the photographer" } });
    const oaklandAt = new Date(Date.now() - 86_400_000).toISOString();
    platform.set("studio-oakland", { id: "studio-oakland", external_id: null, aryeo_order_id: "aryeo-oakland", status: "sent_to_client", updated_at: now(), appointment_date: null, created_at: now(), script: { raw: "Oakland v4 script", generated_at: oaklandAt, options: [] }, script_version: { version_number: 4, approved_at: oaklandAt, delivered_at: oaklandAt }, on_site_script: null, links: {} });
    await sync.pullScriptFromStudio(noteJob.id);
    const jn = await job(noteJob.id);
    c.ok("a typed note ('See dropbox folder for script') gives way to the platform's script", jn.reelScript === "Oakland v4 script" && (jn.scriptConfirmNote ?? "").includes("See dropbox folder for script"), `${jn.reelScript} | ${jn.scriptConfirmNote}`);
    c.ok("…while a real typed script is a record (looksLikeScript)", sync.looksLikeScript(typed) && !sync.looksLikeScript("N/A") && !sync.looksLikeScript("I need to add to this, standby") && !sync.looksLikeScript("Waiting for Alex to send her revised version") && !sync.looksLikeScript("This is essentially a music video for the listing video tour. Please see dropbox for EXACT Details on how to edit this together.") && sync.looksLikeScript("HOOK: WAIT! Before you sign that new construction contract, you gotta see this. REHOOK: Because what if everything you have been waiting for already exists? PAYOFF: Four bedrooms, spacious living, a finished basement and a backyard built for the way you actually live, all ready right now. CALLBACK: Skip the wait."));

    // ======================================================================
    c.head("7 · an office correction in the hub, against older and newer versions");
    const other = await prisma.project.create({ data: { clientId: client.id, title: "12 Elm St TEST", status: "EDITING", source: "MANUAL" } });
    const elmAt = new Date(Date.now() - 5 * 3600_000).toISOString();
    const elmP: P = { id: "studio-elm", external_id: other.id, aryeo_order_id: null, status: "done", updated_at: now(), appointment_date: null, created_at: now(), script: { raw: "Elm v3 script", generated_at: elmAt, options: [] }, script_version: { version_number: 3, approved_at: elmAt, delivered_at: elmAt }, on_site_script: null, links: {} };
    platform.set(elmP.id, elmP);
    await sync.pullScriptFromStudio(other.id);
    c.ok("a hub-created job (external_id) syncs too", (await job(other.id)).reelScript === "Elm v3 script");
    await prisma.project.update({ where: { id: other.id }, data: { reelScript: "Elm corrected by the office", reelRecipeUpdatedAt: new Date(), scriptConfirmNote: "Edited in the hub by Jordan" } });
    await sync.pullScriptFromStudio(other.id);
    c.ok("the correction stands against the older platform version", (await job(other.id)).reelScript === "Elm corrected by the office");
    elmP.script = { raw: "Elm v4 script", generated_at: new Date(Date.now() + 1000).toISOString(), options: [] };
    elmP.script_version = { version_number: 4, approved_at: new Date(Date.now() + 1000).toISOString(), delivered_at: null };
    elmP.updated_at = now();
    await sync.pullScriptFromStudio(other.id);
    const j7 = await job(other.id);
    c.ok("a newer platform version replaces it", j7.reelScript === "Elm v4 script" && j7.scriptingVersion === 4);
    c.ok("…and the 'Edited in the hub' note goes with it", !(j7.scriptConfirmNote ?? "").startsWith("Edited in the hub"));

    // ======================================================================
    c.head("8 · an Aryeo booking the hub has not imported yet");
    const lateP: P = { id: "studio-late", external_id: null, aryeo_order_id: "aryeo-late", status: "awaiting_intake", updated_at: now(), appointment_date: null, created_at: now(), script: null, script_version: null, on_site_script: null, links: {} };
    platform.set(lateP.id, lateP);
    const r8 = await send("project.created", summary(lateP));
    c.ok("it is skipped cleanly, not failed (no retry storm)", r8.status === 200 && r8.body?.ok === true && (await prisma.webhookEvent.findFirst({ where: { eventType: "project.created", externalId: "studio-late" } }))?.status === "PROCESSED");
    const late = await prisma.project.create({ data: { clientId: client.id, title: "9 Late Rd TEST", status: "BOOKED", source: "ARYEO", aryeoOrderId: "aryeo-late" } });

    // ======================================================================
    c.head("9 · the 15-minute reconcile (updated_since, Oct 21 2026)");
    const { SCRIPTING_CURSOR_KEY } = sync;
    const bookmark = async () => JSON.parse((await prisma.appSetting.findUnique({ where: { key: SCRIPTING_CURSOR_KEY } }))?.value ?? "null") as string | null;
    const first = await sync.reconcileScripting();
    c.ok("one changed-since list call; the never-read job is read and linked", listReads === 1 && first.matched === 4 && (await job(late.id)).scriptingId === "studio-late", JSON.stringify(first));
    const newestAt = Math.max(...[...platform.values()].map((x) => Date.parse(x.updated_at)));
    c.ok("…and the bookmark is the newest updated_at handled", Date.parse((await bookmark())!) === newestAt, String(await bookmark()));
    const readsBefore = reads;
    const quiet = await sync.reconcileScripting({ now: new Date() });
    c.ok("nothing changed: nothing is re-read (no shoot-window or daily re-reads any more)", quiet.read === 0 && reads === readsBefore, JSON.stringify(quiet));
    lateP.updated_at = new Date(Date.now() + 5000).toISOString(); lateP.status = "intake_submitted";
    const changed = await sync.reconcileScripting();
    c.ok("a project whose updated_at moved is read", changed.read === 1 && (await job(late.id)).scriptingStatus === "intake_submitted", JSON.stringify(changed));
    // A failed read holds the bookmark before it; the next run retries it.
    const heldAt = Date.parse((await bookmark())!);
    ridleyP.updated_at = new Date(Date.now() + 10_000).toISOString(); ridleyP.status = "in_progress";
    failDetailFor.add("aryeo-ridley"); failDetailFor.add("studio-ridley");
    const failed = await sync.reconcileScripting();
    c.ok("a failed read is counted and the bookmark does not pass it", failed.errors >= 1 && Date.parse((await bookmark())!) === heldAt, JSON.stringify(failed));
    failDetailFor.clear();
    const retried = await sync.reconcileScripting();
    c.ok("…the next run reads it and moves the bookmark on", retried.read === 1 && (await job(ridley.id)).scriptingStatus === "in_progress" && Date.parse((await bookmark())!) === Date.parse(ridleyP.updated_at), JSON.stringify(retried));
    // Paging: a full page means ask again from its newest updated_at.
    let t = Date.now() + 20_000;
    const oaklandP = platform.get("studio-oakland")!;
    for (const p of [lateP, ridleyP, oaklandP]) { p.updated_at = new Date(t += 1000).toISOString(); }
    const listsBefore = listReads;
    const paged = await sync.reconcileScripting({ pageSize: 2 });
    c.ok("a full page pages forward from its newest change; all three changes are read", paged.read === 3 && listReads - listsBefore >= 2 && Date.parse((await bookmark())!) === Date.parse(oaklandP.updated_at), JSON.stringify(paged));
    // The backfill (all) still reads every matched project.
    const all = await sync.reconcileScripting({ all: true });
    c.ok("the backfill (all) reads every matched project", all.read === all.matched && all.matched === 4, JSON.stringify(all));

    // ======================================================================
    c.head("10 · the card");
    const j10 = await job(ridley.id);
    const html = renderToStaticMarkup(createElement(ReelScriptCard, { hook: j10.reelHook, script: j10.reelScript, song: j10.reelSong, shotList: null, updatedAt: null, current: currentScriptOf(j10), recordNote: j10.scriptConfirmNote, showClientVersion: true }));
    c.ok("the filmed record is labelled as such", html.includes("What was filmed (typed by the photographer)"));
    c.ok("…with the current script beneath it, its version and the on-site change named", html.includes("Current script in Script Writing") && html.includes("v11, changed on site by the creative"));
    c.ok("…and the version the agent received", html.includes("Sent to the agent: v9"));
    const plain = renderToStaticMarkup(createElement(ReelScriptCard, { hook: null, script: "Elm v4 script", song: null, shotList: null, updatedAt: null, current: { ...currentScriptOf(j7), draftVersion: 5 } }));
    c.ok("when the current script is the one shown: its version in the header, no second copy", plain.includes("v4") && !plain.includes("Current script in Script Writing"));
    c.ok("a waiting draft is a status line, never text", plain.includes("Version 5 is waiting on review in Script Writing"));
    c.ok("no em dash in the new card copy", !/[—]/.test(html.replace(/Provided on site — typed/g, "") + plain));

    // ======================================================================
    c.head("11 · guards");
    const forged = await send("project.script_updated", summary(ridleyP), "sha256=00");
    c.ok("a forged signature is refused", forged.status === 401);
    c.ok("nothing was ever written to the platform, and no other call left", writes === 0 && fence.blocked.length === 0, `${writes} / ${fence.blocked.join(", ")}`);
  } finally {
    await db.stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
