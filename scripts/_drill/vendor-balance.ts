// ---------------------------------------------------------------------------
// DRILL: THE AUTOHDR BALANCE (§10 AU-20 / J1, unified handoff batch 5, Sep 26).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/vendor-balance.ts
//
// Jordan's answers (Sep 25): Kyle checks on Mondays; Jordan tops up; no
// low-credit threshold until he names one; no purchase code, ever.
//
//   0. OLD (17df024): the real Gmail sync dropped an AutoHDR "credits running
//      low" email before logging it — no comms row, no task, nobody told.
//   1. NEW, through the same sync: every AutoHDR mail logged OWNER-only (never
//      a lead, never a client task); two warnings on one ET day → ONE task, for
//      Jordan (his roster row found through the OWNER login); a warning after
//      midnight ET → a second. A UTC day key would have split Saturday 23:50.
//   2. A "complete" mail naming one batch's street attaches to that batch.
//   3. Kyle's Monday check: nothing on Saturday; one task Monday due 5 PM ET
//      (EDT, and EST after the Nov 1 change); a reading closes it; a reading
//      earlier that Monday means no task.
//   4. The view: last reading; photos since it (an ESTIMATE, uncounted jobs
//      named, never zero); credits only once credits-per-photo is set; the
//      last AutoHDR top-up from the bank feed; no threshold → no comparison.
//   5. Permissions: Kyle records a reading; only the owner changes settings.
//   5b. The card: the owner sees the last top-up; Kyle (ADMIN, who opens the
//      page for the Monday reading) never sees the owner's payment (review).
//   6. Zero outbound calls beyond the faked Google endpoints.
//
// ISOLATION. PGlite on 127.0.0.1:5792 (DRILL_PORT overrides). Gmail/OAuth are
// answered by the fence faker; everything else is blocked. AUTH_ENFORCE on.
// THE CLOCK: Saturday Sep 26 2026 19:30 ET → Sunday 00:10 → Mondays → Nov 2.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5792);
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");

const RealDate = Date;
let SIM = RealDate.parse("2026-09-26T19:30:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;
const at = (iso: string) => { SIM = RealDate.parse(iso); };

installNextStubs();

// ---- a scripted Gmail ---------------------------------------------------------
type Mail = { id: string; from: string; subject: string; body: string; at: number };
let inbox: Mail[] = [];
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname !== "gmail.googleapis.com") return null;
  const p = u.pathname.replace("/gmail/v1/users/me", "");
  if (p === "/messages") {
    const q = u.searchParams.get("q") ?? "";
    return json(/in:inbox/.test(q) ? { messages: inbox.map((m) => ({ id: m.id })) } : { messages: [] });
  }
  const one = /^\/messages\/([^/]+)$/.exec(p);
  if (one) {
    const m = inbox.find((x) => x.id === one[1]);
    if (!m) return json({ error: "not found" }, 404);
    return json({
      id: m.id,
      threadId: `t-${m.id}`,
      snippet: m.body.slice(0, 80),
      internalDate: String(m.at),
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }], body: { data: b64url(m.body) } },
    });
  }
  if (p.startsWith("/threads/")) return json({ messages: [] });
  return json({});
});

function writeBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-balance-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `${BASE}:src/lib/integrations/google.ts`], { cwd: REPO, encoding: "utf8" });
  const point = (s: string) =>
    s
      .replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`)
      .replace(/(["'])\.\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src/lib/integrations", p)}${q}`);
  const file = path.join(dir, "google.base.ts");
  fs.writeFileSync(file, point(src));
  return file;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Walk a server component's element tree to text, running nested server
 *  components; a client component (hooks) renders as nothing here. */
async function renderText(node: any): Promise<string> {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (await Promise.all(node.map(renderText))).join("");
  if (typeof node === "object" && typeof node.then === "function") return renderText(await node);
  if (typeof node === "object" && node.type) {
    if (typeof node.type === "function") {
      try { return await renderText(await node.type(node.props)); } catch { return ""; }
    }
    return renderText(node.props?.children);
  }
  return "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
/** lucide-react and next/link create React contexts at load, which the
 *  react-server build of React cannot do; for a text walk an icon is nothing
 *  and a link is its children. Installed just before a component is imported. */
function stubUiModules() {
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  const Icon = () => null;
  const lucide = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : Icon) });
  const link = { __esModule: true, default: ({ children }: { children?: unknown }) => children };
  L._load = function (r: string, p: unknown, m: boolean) {
    if (r === "lucide-react") return lucide;
    if (r === "next/link") return link;
    return prev.call(this, r, p, m);
  };
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const vb = await import("@/lib/vendorBalance");
  const { syncGmail } = await import("@/lib/integrations/google");
  const { establishSession } = await import("@/lib/auth/session");
  const { recordAutohdrReading, saveAutohdrSettings } = await import("@/app/settings/autohdr/actions");

  const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan-vb@drill.invalid", role: "PHOTOGRAPHER" } });
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-vb@drill.invalid", role: "ADMIN" } });
  const owner = await prisma.appUser.create({ data: { email: "info@drill.invalid", name: "Jordan", role: "OWNER", status: "ACTIVE", teamMemberId: jordanTm.id } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle-vb@drill.invalid", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
  await saveSecret("gmail", JSON.stringify({ "hello@realtourpilot.com": "drill-refresh-token" }));
  const autohdr = "AutoHDR Billing <billing@autohdr.com>";

  // =========================================================================
  c.head("0 · OLD (17df024): the sync dropped AutoHDR mail unlogged");
  {
    at("2026-09-26T19:30:00-04:00");
    inbox = [{ id: "old-1", from: autohdr, subject: "Your AutoHDR credits are running low", body: "You have 40 credits left. Top up to keep processing.", at: SIM }];
    let ran = false;
    try {
      const old = (await import(writeBase())) as { syncGmail: () => Promise<unknown> };
      await old.syncGmail();
      ran = true;
    } catch (e) {
      console.log("  (old copy could not run:", (e as Error).message.slice(0, 120), ")");
    }
    c.ok("the 17df024 sync ran against the fake inbox", ran);
    const evt = await prisma.webhookEvent.findFirst({ where: { provider: "gmail", externalId: "hello@realtourpilot.com:old-1" } });
    c.ok("OLD handled the message to completion (PROCESSED) — it was dropped, not errored", evt?.status === "PROCESSED", evt?.status ?? "no event");
    c.ok("OLD: no comms row for the AutoHDR warning", (await prisma.commLog.count()) === 0);
    c.ok("OLD: no task — nobody was told", (await prisma.smartTask.count()) === 0);
    await prisma.webhookEvent.deleteMany({});
  }

  // =========================================================================
  c.head("1 · NEW: logged owner-only, one task per ET day, for Jordan");
  {
    at("2026-09-26T19:30:00-04:00"); // Saturday 7:30 PM
    inbox = [{ id: "m-1", from: autohdr, subject: "Your AutoHDR credits are running low", body: "You have 40 credits left.", at: SIM }];
    await syncGmail();
    at("2026-09-26T23:50:00-04:00"); // Saturday 11:50 PM ET = Sunday 03:50 UTC
    inbox.push({ id: "m-2", from: autohdr, subject: "Payment failed — top up your AutoHDR balance", body: "Your card was declined.", at: SIM });
    await syncGmail();
    const logs = await prisma.commLog.findMany({ where: { source: "gmail-vendor" } });
    c.ok("both AutoHDR mails are in comms memory", logs.length === 2, String(logs.length));
    c.ok("…OWNER-only, filed under no client", logs.every((l) => l.minRole === "OWNER" && l.clientId === null && l.channel === "email"));
    let tasks = await prisma.smartTask.findMany({ where: { taskType: "vendor_balance" } });
    c.ok("two warnings on one ET Saturday → ONE task", tasks.length === 1, tasks.map((t) => t.dedupeKey).join(","));
    c.ok("…for Jordan, found through the OWNER login's roster row", tasks[0]?.assignedKey === "jordan" && tasks[0]?.ownerId === jordanTm.id);
    c.ok("…keyed on the ET day, not the UTC day", tasks[0]?.dedupeKey === "autohdr-balance-mail-2026-09-26");
    c.ok("…carries no dollar figure in its words", !/\$\d/.test(`${tasks[0]?.title} ${tasks[0]?.summary}`));
    c.ok("no lead and no client task from AutoHDR mail", (await prisma.smartTask.count({ where: { taskType: { in: ["lead", "client_reply"] } } })) === 0);

    at("2026-09-27T00:10:00-04:00"); // Sunday 12:10 AM ET
    inbox.push({ id: "m-3", from: autohdr, subject: "Insufficient credits", body: "Processing paused.", at: SIM });
    await syncGmail();
    tasks = await prisma.smartTask.findMany({ where: { taskType: "vendor_balance" }, orderBy: { createdAt: "asc" } });
    c.ok("a warning after midnight ET → a second task", tasks.length === 2 && tasks[1].dedupeKey === "autohdr-balance-mail-2026-09-27");
    c.ok("re-scanning the same inbox logs nothing twice", (await (async () => { await syncGmail(); return prisma.commLog.count({ where: { source: "gmail-vendor" } }); })()) === 3);
  }

  // =========================================================================
  c.head("2 · a 'complete' notice attaches to the batch it names");
  {
    const client = await prisma.client.create({ data: { name: "VB Client TEST" } });
    const p = await prisma.project.create({ data: { title: "5 Elm St, Emmaus, PA", clientId: client.id, status: "EDITING" } });
    const b = await prisma.photoEditBatch.create({ data: { projectId: p.id, vendorKey: "autohdr", attempt: 1, rawCount: 50, expectedFinals: 10, state: "SUBMITTED_BY_UPLOAD", submissionEvidence: "dropbox-upload", readOk: true } });
    at("2026-09-27T10:00:00-04:00");
    inbox.push({ id: "m-4", from: "AutoHDR <jobs@autohdr.com>", subject: "Your photos are ready: 5 Elm St", body: "Your edits for 5 Elm St are complete.", at: SIM });
    await syncGmail();
    const after = await prisma.photoEditBatch.findUnique({ where: { id: b.id } });
    c.ok("the batch carries the vendor email as evidence", after?.submissionEvidence === "vendor-email:m-4", after?.submissionEvidence ?? "");
    c.ok("…and it made no task", (await prisma.smartTask.count({ where: { taskType: "vendor_balance" } })) === 2);
  }

  // =========================================================================
  c.head("3 · Kyle's Monday check");
  {
    at("2026-09-26T19:30:00-04:00");
    c.ok("Saturday: no check task", (await vb.ensureWeeklyBalanceCheck()).created === false);
    at("2026-09-28T04:00:00-04:00"); // Monday, the daily cron's hour
    const r = await vb.ensureWeeklyBalanceCheck();
    const t = await prisma.smartTask.findUnique({ where: { dedupeKey: "autohdr-balance-check-2026-09-28" } });
    c.ok("Monday: one task, to Kyle", r.created && t?.assignedKey === "kyle" && t.ownerId === kyleTm.id);
    c.ok("…due 5 PM EDT (21:00Z)", t?.dueAt?.toISOString() === "2026-09-28T21:00:00.000Z", t?.dueAt?.toISOString());
    c.ok("a second run files nothing more", !(await vb.ensureWeeklyBalanceCheck()).created && (await prisma.smartTask.count({ where: { taskType: "vendor_balance_check" } })) === 1);
    at("2026-09-28T09:00:00-04:00");
    const rec = await vb.recordBalanceReading({ credits: 400, recordedBy: "kyle-vb@drill.invalid" });
    const t2 = await prisma.smartTask.findUnique({ where: { dedupeKey: "autohdr-balance-check-2026-09-28" } });
    c.ok("recording the reading closes the check", rec.ok && t2?.status === "COMPLETED");
    c.ok("an empty reading is refused", !(await vb.recordBalanceReading({ recordedBy: "x" })).ok);

    at("2026-10-05T03:00:00-04:00");
    await vb.recordBalanceReading({ credits: 380, recordedBy: "kyle-vb@drill.invalid" });
    at("2026-10-05T04:00:00-04:00");
    const early = await vb.ensureWeeklyBalanceCheck();
    c.ok("a reading already in that Monday → no task", !early.created && /already landed/.test(early.reason), early.reason);

    at("2026-11-02T04:00:00-05:00"); // the Monday after the clocks go back
    await vb.ensureWeeklyBalanceCheck();
    const t3 = await prisma.smartTask.findUnique({ where: { dedupeKey: "autohdr-balance-check-2026-11-02" } });
    c.ok("after the DST change: due 5 PM EST (22:00Z)", t3?.dueAt?.toISOString() === "2026-11-02T22:00:00.000Z", t3?.dueAt?.toISOString());
    await vb.saveVendorBalanceSettings({ checkOwnerKey: null }, "drill");
    at("2026-11-09T04:00:00-05:00");
    c.ok("no check owner → no weekly task", (await vb.ensureWeeklyBalanceCheck()).reason === "no check owner set");
    await vb.saveVendorBalanceSettings({ checkOwnerKey: "kyle" }, "drill");
    // Clean slate for the view.
    await prisma.vendorBalanceReading.deleteMany({});
  }

  // =========================================================================
  c.head("4 · the view: a reading, an estimate, a top-up — never a live balance");
  {
    at("2026-10-12T09:00:00-04:00");
    c.ok("the API seam answers null — not connected, not zero", (await vb.readAutohdrBalance()) === null);
    let v = await vb.autohdrBalanceView();
    c.ok("no reading → nothing to estimate from", v.lastReading === null && v.since === null && v.low === null);
    await vb.recordBalanceReading({ credits: 400, recordedBy: "kyle-vb@drill.invalid" });
    const client = await prisma.client.create({ data: { name: "VB Two TEST" } });
    const shot = new Date("2026-10-13T10:00:00-04:00");
    await prisma.project.create({ data: { title: "1 A St", clientId: client.id, status: "EDITING", shootDate: shot, rawPhotoCount: 100, dronePhotoCount: 0 } });
    await prisma.project.create({ data: { title: "2 B St", clientId: client.id, status: "EDITING", shootDate: shot, rawPhotoCount: 55, dronePhotoCount: 5 } });
    await prisma.project.create({ data: { title: "3 C St", clientId: client.id, status: "EDITING", shootDate: shot, deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] } } });
    await prisma.project.create({ data: { title: "4 D St", clientId: client.id, status: "EDITING", shootDate: shot, deliverables: { create: [{ type: "VIDEO", label: "Video", quantity: 1 }] } } });
    at("2026-10-14T09:00:00-04:00");
    v = await vb.autohdrBalanceView();
    c.ok("photos since the reading: 20 + 15 = 35, labelled an estimate", v.since?.finishedPhotos === 35 && v.since.jobs === 2, JSON.stringify(v.since));
    c.ok("…the uncounted photo job is named, the video-only one is not", v.since?.uncountedJobs === 1);
    c.ok("credits-per-photo unknown → no credit estimate", v.estimatedCreditsUsed === null && v.estimatedCreditsLeft === null);
    c.ok("no threshold → no comparison at all (low is null)", v.threshold === null && v.low === null);
    await vb.saveVendorBalanceSettings({ creditsPerPhoto: 1, thresholdCredits: 300 }, "drill");
    v = await vb.autohdrBalanceView();
    c.ok("with 1 credit/photo: ~35 used, ~365 left, above 300", v.estimatedCreditsUsed === 35 && v.estimatedCreditsLeft === 365 && v.low === false);
    await vb.recordBalanceReading({ credits: 250, recordedBy: "kyle-vb@drill.invalid" });
    v = await vb.autohdrBalanceView();
    c.ok("a reading of 250 against 300 → low", v.low === true);

    const item = await prisma.plaidItem.create({ data: { itemId: "drill-item", accessTokenEncrypted: "x" } });
    await prisma.plaidAccount.create({ data: { plaidItemId: item.id, accountId: "acct-1", name: "Checking" } });
    await prisma.plaidTransaction.create({ data: { id: "ptx-1", accountId: "acct-1", amount: 200, date: new Date("2026-10-01T12:00:00Z"), name: "AUTOHDR.COM TOPUP", pending: false } });
    await prisma.plaidTransaction.create({ data: { id: "ptx-2", accountId: "acct-1", amount: -50, date: new Date("2026-10-03T12:00:00Z"), name: "AUTOHDR REFUND", pending: false } });
    await prisma.qboTransaction.create({ data: { qboId: "q-1", type: "Purchase", txnDate: new Date("2026-09-01T12:00:00Z"), amount: 150, customerName: "AutoHDR" } });
    v = await vb.autohdrBalanceView();
    c.ok("unasked, the view reads neither the bank nor the books — lastTopUp null (review, Sep 26: admins open this page)", v.lastTopUp === null, JSON.stringify(v.lastTopUp));
    v = await vb.autohdrBalanceView(new Date(), { money: true });
    c.ok("with money: the last top-up is the bank's $200 AUTOHDR payment (money in is not a top-up)", v.lastTopUp?.amount === 200 && v.lastTopUp.source === "bank", JSON.stringify(v.lastTopUp));
  }

  // =========================================================================
  c.head("5 · who may do what");
  {
    await establishSession(kyle.id);
    const r = await recordAutohdrReading({ credits: "410" });
    c.ok("Kyle records a reading", r.ok, r.message);
    let refused = false;
    try { await saveAutohdrSettings({ checkOwnerKey: "kyle", checkWeekday: 1, thresholdCredits: "10" }); } catch { refused = true; }
    c.ok("Kyle cannot change the threshold or who checks", refused);
    await establishSession(owner.id);
    const s = await saveAutohdrSettings({ checkOwnerKey: "kyle", checkWeekday: 1, thresholdCredits: "", thresholdDollars: "", creditsPerPhoto: "" });
    c.ok("the owner can — and empty boxes clear back to unset", s.ok && (await vb.vendorBalanceSettings()).thresholdCredits === null);
  }

  // =========================================================================
  c.head("5b · the Connections card says what is and isn't known");
  {
    stubUiModules();
    const { AutohdrCard } = await import("@/components/connections/AutohdrCard");
    const text = await renderText(await AutohdrCard());
    c.ok("card, as the owner: not connected, the last reading, the last top-up, no threshold", /Not connected/.test(text) && /Last reading:/.test(text) && /\$200\.00/.test(text) && /no threshold set/.test(text), text.slice(0, 200));
    // Settings → AutoHDR balance renders the same card for Kyle (ADMIN) when he
    // records the Monday reading. The top-up is Jordan's own payment.
    await establishSession(kyle.id);
    const asKyle = await renderText(await AutohdrCard());
    c.ok("card, as Kyle: the reading is there, the owner's payment is not (no line, no $200)", /Last reading:/.test(asKyle) && !/Last top-up/.test(asKyle) && !/\$200/.test(asKyle), asKyle.slice(0, 300));
    await establishSession(owner.id);
  }

  // =========================================================================
  c.head("6 · nothing left the building");
  c.ok("zero blocked outbound calls", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("only Google was faked", fence.faked.every((u) => /googleapis\.com/.test(u)) && fence.faked.length > 0);

  quiet.restore();
  c.summary();
  await stop();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
