/**
 * THE AUTO-STAMP, EVENT-DRIVEN (Sep 21 2026).
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" \
 *   && set -a && source .env; set +a \
 *   && NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs \
 *        scripts/_drill/aryeo-autosent.ts
 *
 * Runs the SHIPPED proveListingNow / handleAryeoActivity against an ISOLATED
 * in-process PGlite Postgres. Production Neon is never touched — DATABASE_URL is
 * overwritten below before any app module loads.
 *
 * The incident: three approved videos sat unsent for up to three days (5 Raymond
 * Cir, 453 Cardigan Terrace, 5642 Limeport Rd). On 453 Cardigan Terrace the only
 * LISTING_DELIVERED that listing has ever produced landed a DAY BEFORE the cut
 * was approved, and the only Aryeo traffic since is LISTING_CONTENT_DOWNLOADED —
 * which the hub read and then threw away.
 *
 * What this has to show:
 *   1. a listing that gains a video proves the right cut and stamps it;
 *   2. the wrong cut on the same job is NOT stamped;
 *   3. a replay of the same event changes nothing;
 *   4. a video that was already up before we downloaded the file is NOT matched,
 *      and the same case WITHOUT the download stamp is what would have stamped —
 *      so the guard is doing the work, not the fixtures;
 *   5. the download event itself, end to end through handleAryeoActivity, is
 *      what carries the proof — which is the whole point of the change.
 *
 * ONE THING IS STUBBED, and it is named out loud: Aryeo.listing, a network read
 * a drill must not make. The MP4 header probe is NOT stubbed — measureCutLengths
 * is the gate that decides whether a cut can be stamped at all, so the drill
 * builds real MP4 headers of known length and serves them over a local HTTP
 * server with real range requests. Everything that DECIDES anything —
 * probeVideoMetadata, cardsAryeoCanAccountFor, the download filter,
 * cutsOnTheCardFor, markVideoSent — is the shipped code.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";
import http from "node:http";

// ---- the one stub, installed before any app module resolves ----------------
/** listing id → the listing Aryeo.listing should hand back. */
const LISTINGS = new Map<string, { delivery_status: string; videos: { id: string; duration: number; title: string }[] }>();
let aryeoReads = 0;

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
// A STATIC "@/…" import arrives here with the alias intact; a DYNAMIC one does
// not reach this hook at all under tsx. So only a statically-imported module can
// be swapped this way — which is why the header probe below is served for real
// rather than stubbed. The first run of this drill stubbed it and the stub was
// never installed, which read as a matcher that refuses everything.
const isModule = (request: string, tail: string) =>
  request === `@/lib/${tail}` || new RegExp(`(^|/)src/lib/${tail}(\\.tsx?)?$`).test(request);
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/headers") return {};
  const m = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
  if (isModule(request, "integrations/aryeo")) {
    const realAryeo = m.Aryeo as Record<string, unknown>;
    const stubbed = new Proxy(realAryeo, {
      get: (t, k) =>
        k === "listing"
          ? async (id: string) => {
              aryeoReads++;
              const l = LISTINGS.get(id);
              if (!l) throw new Error(`404 no such listing ${id}`);
              return l;
            }
          : (t as Record<string | symbol, unknown>)[k],
    });
    return new Proxy(m, { get: (t, k) => (k === "Aryeo" ? stubbed : (t as Record<string | symbol, unknown>)[k]) });
  }
  return m;
};


// ---------------------------------------------------------------------------
// A REAL MP4 HEADER, AND A REAL SERVER TO RANGE-READ IT FROM.
//
// measureCutLengths is the gate: a cut with no 1080p job has no length anywhere
// in the schema, so it is stampable only if the hub can measure the file. Faking
// that measurement would skip the one step that separates "a video appeared" from
// "a video of exactly this length appeared", so the drill builds the boxes
// probeVideoMetadata actually walks — ftyp, moov/trak/{tkhd, mdia/{mdhd, hdlr,
// minf/stbl/{stts, stsd}}} — and serves them over HTTP with byte ranges.
// ---------------------------------------------------------------------------
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, "latin1");
  return Buffer.concat([h, body]);
};

function mp4Header(lengthSec: number, width = 1920, height = 1080): Buffer {
  const timescale = 600;
  const delta = 20; // 30fps
  const frames = Math.round((lengthSec * timescale) / delta);
  const dur = frames * delta;
  const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(512), Buffer.from("isomiso2avc1mp41", "latin1"));
  const identity = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const tkhd = box("tkhd", u32(0), u32(0), u32(0), u32(1), u32(0), u32(dur), Buffer.alloc(8),
    u16(0), u16(0), u16(0), u16(0), identity, u32(width << 16), u32(height << 16));
  const mdhd = box("mdhd", u32(0), u32(0), u32(0), u32(timescale), u32(dur), u16(0x55c4), u16(0));
  const hdlr = box("hdlr", u32(0), u32(0), Buffer.from("vide", "latin1"), Buffer.alloc(12), Buffer.from([0]));
  const stts = box("stts", u32(0), u32(1), u32(frames), u32(delta));
  const avc1 = box("avc1", Buffer.alloc(6), u16(1), u16(0), u16(0), Buffer.alloc(12), u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(24), Buffer.from([0xff, 0xff]));
  const stsd = box("stsd", u32(0), u32(1), avc1);
  const stbl = box("stbl", stts, stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  return Buffer.concat([ftyp, box("moov", trak)]);
}

/** path → the bytes served at it. */
const FILES = new Map<string, Buffer>();
const FILE_PORT = 5591;

function startFileServer(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const buf = FILES.get(path);
    if (!buf) { res.statusCode = 404; res.end(); return; }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(buf.length), "accept-ranges": "bytes" });
      res.end(req.method === "HEAD" ? undefined : buf);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : buf.length - 1, buf.length - 1);
    if (start >= buf.length) { res.statusCode = 416; res.end(); return; }
    const slice = buf.subarray(start, end + 1);
    res.writeHead(206, {
      "content-range": `bytes ${start}-${end}/${buf.length}`,
      "content-length": String(slice.length),
      "accept-ranges": "bytes",
    });
    res.end(slice);
  });
  return new Promise((resolve) => srv.listen(FILE_PORT, "127.0.0.1", () => resolve(srv)));
}

const exec = promisify(execFile);
const PORT = 5499;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;

let pass = 0;
let fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  if (good) pass++;
  else fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** A UUIDv7 whose first 48 bits are `ms`, which is how the hub dates a video on
 *  an Aryeo listing (readyToSend.aryeoIdTime). */
function v7(ms: number): string {
  const t = Math.floor(ms).toString(16).padStart(12, "0");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7abc-8def-0123456789ab`;
}

const HOUR = 3600_000;

async function main() {
  const files = await startFileServer();
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { proveListingNow, handleAryeoActivity } = await import("@/lib/aryeoDelivery");
  const { cutsOnTheCardFor } = await import("@/lib/readyToSend");

  console.log("=".repeat(74));
  console.log("The auto-stamp, event-driven — Aryeo says something, the right cut clears");
  console.log("=".repeat(74));

  const client = await prisma.client.create({ data: { name: "Renee Ryan" }, select: { id: true } });
  const T0 = Date.now() - 48 * HOUR; // the cut was approved two days ago

  const mkJob = async (street: string, listingId: string) =>
    prisma.project.create({
      data: {
        title: `${street}, West Chester, PA`,
        clientId: client.id,
        status: "DELIVERED",
        aryeoListingId: listingId,
        aryeoOrderId: `ord-${listingId.slice(0, 8)}`,
      },
      select: { id: true, title: true },
    });

  const mkCut = async (
    projectId: string,
    o: { name: string; approvedAt: Date; lengthSec: number; downloadedAt?: Date | null },
  ) => {
    const d = await prisma.deliverable.create({
      data: { projectId, type: "VIDEO", quantity: 1, productTitle: o.name },
      select: { id: true },
    });
    const path = `/${encodeURIComponent(o.name)}.mp4`;
    const bytes = mp4Header(o.lengthSec);
    FILES.set(path, bytes);
    const blobUrl = `http://127.0.0.1:${FILE_PORT}${path}`;
    const s = await prisma.reviewSubmission.create({
      data: {
        projectId,
        deliverableId: d.id,
        slot: 1,
        round: 1,
        status: "APPROVED",
        fileName: `${o.name}.mp4`,
        blobUrl,
        sizeBytes: bytes.length,
        decidedAt: o.approvedAt,
        downloadedAt: o.downloadedAt ?? null,
        downloadedBy: o.downloadedAt ? "Kyle" : null,
      },
      select: { id: true },
    });
    return { id: s.id, blobUrl };
  };

  // ---- 1 + 2: the right cut is stamped, the wrong one is not ---------------
  const L1 = "01a0585b-5258-7167-aea7-26275438fa52"; // 453 Cardigan Terrace's real listing id
  const p1 = await mkJob("453 Cardigan Terrace", L1);
  const right = await mkCut(p1.id, { name: "Cardigan reel", approvedAt: new Date(T0), lengthSec: 60 });
  const wrong = await mkCut(p1.id, { name: "Cardigan teaser", approvedAt: new Date(T0), lengthSec: 30 });

  const onCard = await cutsOnTheCardFor(p1.id);
  console.log("\n1. THE FIXTURES ARE ON THE CARD — the board's own rules, not ours");
  // The harness itself, checked before anything leans on it: if the shipped
  // probe cannot read these headers, every refusal below would prove nothing
  // about the matcher and everything about the fixtures.
  const topaz = await import("@/lib/integrations/topaz");
  const probed = await topaz.probeVideoMetadata(right.blobUrl, FILES.get("/Cardigan%20reel.mp4")!.length);
  ok("the shipped probe reads the drill's MP4 header", probed?.durationSec === 60, `probe says ${probed?.durationSec ?? "null"}s ${probed?.width}x${probed?.height} @${probed?.frameRate}fps`);
  ok("the 60s reel is a row the card is asking for", onCard.has(right.id));
  ok("the 30s teaser is a row the card is asking for", onCard.has(wrong.id), `card shows ${onCard.size}`);

  // One 60s video, uploaded 4 hours after both cuts were approved.
  LISTINGS.set(L1, {
    delivery_status: "DELIVERED",
    videos: [{ id: v7(T0 + 4 * HOUR), duration: 60, title: "Cinematic Video" }],
  });

  console.log("\n2. A LISTING THAT GAINED A VIDEO — the matching runs on the event, not on the hour");
  const r1 = await proveListingNow(L1, "drill: LISTING_CONTENT_DOWNLOADED");
  console.log(`   ${r1.note}`);
  const rightRow = await prisma.reviewSubmission.findUnique({ where: { id: right.id }, select: { sentToClientAt: true, sentToClientBy: true } });
  const wrongRow = await prisma.reviewSubmission.findUnique({ where: { id: wrong.id }, select: { sentToClientAt: true } });
  ok("the pass looked", r1.looked && r1.stamped === 1, `stamped ${r1.stamped}`);
  ok("the 60s reel is stamped sent", rightRow?.sentToClientAt != null, rightRow?.sentToClientBy ?? "");
  ok("the 30s teaser is NOT stamped", wrongRow?.sentToClientAt == null);
  ok("the stamp names the video that proved it", (rightRow?.sentToClientBy ?? "").includes("Cinematic Video"));

  // ---- 3: a replay changes nothing ----------------------------------------
  console.log("\n3. THE SAME EVENT AGAIN — a retry, a replay, and the hourly sweep behind it");
  const cooled = await proveListingNow(L1, "drill: replay inside the cool-down");
  ok("the cool-down alone stops the second pass", !cooled.looked && cooled.stamped === 0, cooled.note);
  // …and with the cool-down out of the way, so the idempotency being shown is
  // the WRITE's, not the rate limit's.
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-seen-" } } });
  const stampedBefore = rightRow?.sentToClientAt?.getTime();
  const replay = await proveListingNow(L1, "drill: replay with the cool-down cleared");
  const afterReplay = await prisma.reviewSubmission.findUnique({ where: { id: right.id }, select: { sentToClientAt: true } });
  ok("the replay stamps nothing new", replay.looked && replay.stamped === 0, replay.note);
  ok("the original stamp is untouched", afterReplay?.sentToClientAt?.getTime() === stampedBefore);
  const lines = await prisma.activity.count({ where: { projectId: p1.id, type: "SYSTEM" } });
  ok("one timeline line per thing that happened, not per event", lines === 1, `${lines} SYSTEM lines`);

  // ---- 4: the download contradicts the video ------------------------------
  console.log("\n4. THE DOWNLOAD SAYS NO — a video that was up before we took the file is not that file");
  const L2 = "01a0a0e5-e4c0-705f-a848-c0b89de99171"; // 5 Raymond Cir's real listing id
  const p2 = await mkJob("5 Raymond Cir", L2);
  // The video went up at T0+4h. Kyle pressed Download at T0+6h — two hours
  // AFTER it appeared, so whatever is up there, it is not the file he took.
  const late = await mkCut(p2.id, {
    name: "Raymond reel",
    approvedAt: new Date(T0),
    lengthSec: 59,
    downloadedAt: new Date(T0 + 6 * HOUR),
  });
  LISTINGS.set(L2, {
    delivery_status: "DELIVERED",
    videos: [{ id: v7(T0 + 4 * HOUR), duration: 59, title: "Standard Reel" }],
  });
  const r2 = await proveListingNow(L2, "drill: the download contradicts");
  const lateRow = await prisma.reviewSubmission.findUnique({ where: { id: late.id }, select: { sentToClientAt: true } });
  ok("nothing is stamped", r2.stamped === 0 && lateRow?.sentToClientAt == null, r2.note);

  // THE COUNTERFACTUAL. Same listing, same video, same cut — with the download
  // stamp removed. If this did not stamp, the case above would prove nothing
  // about the guard and everything about the fixtures.
  await prisma.reviewSubmission.update({ where: { id: late.id }, data: { downloadedAt: null, downloadedBy: null } });
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-seen-" } } });
  const r2b = await proveListingNow(L2, "drill: the same case with no download stamp");
  const lateRow2 = await prisma.reviewSubmission.findUnique({ where: { id: late.id }, select: { sentToClientAt: true } });
  ok("without the download stamp the very same case DOES stamp", r2b.stamped === 1 && lateRow2?.sentToClientAt != null, r2b.note);

  // ---- 5: the download EVENT carries it, end to end -----------------------
  console.log("\n5. THE EVENT ITSELF — LISTING_CONTENT_DOWNLOADED through the shipped handler");
  const L3 = "01a09248-fce0-71be-8d2c-9557ffcfe300";
  const p3 = await mkJob("5642 Limeport Rd", L3);
  const limeport = await mkCut(p3.id, { name: "Limeport reel", approvedAt: new Date(T0), lengthSec: 47 });
  LISTINGS.set(L3, {
    delivery_status: "DELIVERED",
    videos: [{ id: v7(T0 + 9 * HOUR), duration: 47, title: "Cinematic Video" }],
  });
  const activity = {
    object: "ACTIVITY",
    id: "01a0c500-0000-7000-8000-000000000001",
    name: "LISTING_CONTENT_DOWNLOADED",
    occurred_at: new Date().toISOString(),
    resource: { object: "LISTING", id: L3 },
  };
  const readsBefore = aryeoReads;
  const ev1 = await handleAryeoActivity("LISTING_CONTENT_DOWNLOADED", activity);
  console.log(`   ${ev1.note}`);
  const limeRow = await prisma.reviewSubmission.findUnique({ where: { id: limeport.id }, select: { sentToClientAt: true, sentToClientBy: true } });
  ok("the download event stamped the cut", ev1.handled && limeRow?.sentToClientAt != null, limeRow?.sentToClientBy ?? "");
  ok("it cost ONE Aryeo read, not two", aryeoReads - readsBefore === 1, `${aryeoReads - readsBefore} reads`);
  const dl = await prisma.project.findUnique({ where: { id: p3.id }, select: { contentDownloadedAt: true } });
  ok("the download is still recorded on the job", dl?.contentDownloadedAt != null);

  // The same activity id again: Aryeo retries at 10s and 100s.
  const ev2 = await handleAryeoActivity("LISTING_CONTENT_DOWNLOADED", activity);
  const limeRow2 = await prisma.reviewSubmission.findUnique({ where: { id: limeport.id }, select: { sentToClientAt: true } });
  ok("the 10-second retry changes nothing", limeRow2?.sentToClientAt?.getTime() === limeRow?.sentToClientAt?.getTime(), ev2.note);

  // ---- 6: an undelivered listing proves nothing ---------------------------
  console.log("\n6. NOTHING ON AN UNDELIVERED LISTING HAS REACHED ANYBODY");
  const L4 = "01a0b45f-9898-72b3-944a-51ddacdb2680";
  const p4 = await mkJob("893 S Matlack St", L4);
  const matlack = await mkCut(p4.id, { name: "Matlack reel", approvedAt: new Date(T0), lengthSec: 60 });
  LISTINGS.set(L4, { delivery_status: "PROCESSING", videos: [{ id: v7(T0 + 2 * HOUR), duration: 60, title: "Cinematic Video" }] });
  const r4 = await proveListingNow(L4, "drill: not delivered");
  const matRow = await prisma.reviewSubmission.findUnique({ where: { id: matlack.id }, select: { sentToClientAt: true } });
  ok("a video on an undelivered listing stamps nothing", !r4.looked && matRow?.sentToClientAt == null, r4.note);

  // ---- 7: the guards in front of the Aryeo read ---------------------------
  console.log("\n7. WHAT 72 DOWNLOAD EVENTS COST WHEN THERE IS NOTHING OUTSTANDING");
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-seen-" } } });
  const readsBeforeQuiet = aryeoReads;
  // p1's rows are all settled now (the 30s teaser is still open, so use p3,
  // whose only cut was stamped in scenario 5).
  const quiet = await proveListingNow(L3, "drill: nothing outstanding");
  ok("a job with nothing outstanding buys no Aryeo read", !quiet.looked && aryeoReads === readsBeforeQuiet, quiet.note);
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-seen-" } } });
  const unknown = await proveListingNow("01a00000-0000-7000-8000-000000000000", "drill: not ours");
  ok("a listing no job carries buys no Aryeo read", !unknown.looked && aryeoReads === readsBeforeQuiet, unknown.note);

  console.log(`\n${"=".repeat(74)}\n${pass} passed, ${fail} failed\n${"=".repeat(74)}`);
  await server.stop();
  await db.close();
  files.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
