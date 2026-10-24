// ---------------------------------------------------------------------------
// DRILL oct24-gemini-video: Gemini video analysis (Jordan, Oct 23 2026).
// Instagram covers, live from day one, and an on-screen spelling check on
// trial that only Jordan sees.
//
//   DRILL_PORT=46xx node scripts/_drill/run-all.cjs scripts/_drill/oct24-gemini-video.ts --logs <dir>
//
// Drives the SHIPPED code: lib/integrations/gemini (the REST client),
// lib/videoAnalysisCore (the rules), lib/videoAnalysis (the queue, the driver,
// the reads), lib/videoFrames (the REAL static ffmpeg from ffmpeg-static and
// sharp, on a video made here), the Connections, Review Room, Settings and
// portal actions, the two cover routes, the Posting Kit, the Media library and
// Ready to send, against an isolated PGlite. GOOGLE IS FAKE: every request to
// generativelanguage.googleapis.com is answered at the fence below and
// counted; anything else that leaves the machine is refused. The video is
// served from 127.0.0.1.
//
//   §1 no key, no calls: nothing reaches Google and no row is written
//   §2 the key: tested with a call that sends no video, saved encrypted, a bad
//      key refused and never echoed; versions from before it are never read
//   §3 spelling: only known-word mismatches (a name, the address, a script
//      word), never unreadable text or unknown words, at most 3, the words
//      Jordan asked for; Deepgram gives the timing, never the spelling
//   §4 the trial: owner only, Right / Wrong recorded, precision computed; the
//      reviewer switch OFF hides the flags from James, ON shows them
//   §5 covers: 3 candidates, the best pre-selected, the sharpest real frame
//      near Gemini's moment (a blurred frame loses to its sharp neighbour),
//      1080×1920, one run per version, the checked Topaz file waited for
//   §6 where covers appear: Media library, Ready to send, the staff route's
//      access check, the portal Posting Kit (pick, download, access checks)
//   §7 the free tier: 429 backoff (retryDelay, per-day), the daily cap, the
//      fps setting read per run and its token words
//   §8 words and secrets: no em dashes, no scare words, the key never stored
//      in a row or a message
// ---------------------------------------------------------------------------
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import type { PortalViewer } from "@/lib/portal";

const PORT = Number(process.env.DRILL_PORT ?? 4791);
const REPO = path.resolve(__dirname, "..", "..");
const FFMPEG = path.join(REPO, "node_modules", "ffmpeg-static", "ffmpeg");
process.env.FFMPEG_PATH = FFMPEG;
const src = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

// ---- the login, stubbed at the one seam every guard reads --------------------
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
const KYLE = login("ADMIN", { name: "Kyle" });
const JAMES = login("CREATIVE_MANAGER", { name: "James" });
const JOHN = login("EDITOR", { name: "John", editorKey: "john" });
const HARRISON = login("PHOTOGRAPHER", { name: "Harrison" });
let viewer: Viewer | null = JORDAN;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);
installNextStubs();

// ---- the fake Google -----------------------------------------------------------
const KEY = ["AIza", "SyDrillFakeKey", "0123456789abcdefXYZ"].join("");
const BAD_KEY = ["AIza", "SyDrillBadKey", "999999999999999999"].join("");
type Call = { method: string; path: string; keyInUrl: boolean; keyHeader: string | null };
const google = {
  calls: [] as Call[],
  uploads: 0,
  uploadedBytes: 0,
  interactions: [] as { body: Record<string, unknown>; sub: string | null; kind: string | null }[],
  deletes: [] as string[],
  display: new Map<string, string>(),
  next: [] as Response[],
  spell: new Map<string, unknown[]>(),
  cover: new Map<string, unknown[]>(),
  /** versions whose upload Google keeps "reading" (PROCESSING) until released */
  slow: new Set<string>(),
  processing: new Set<string>(),
};
let fileSeq = 0;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const headerOf = (init: RequestInit | undefined, name: string): string | null => {
  const h = init?.headers;
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  const e = Object.entries(h as Record<string, string>).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return e ? String(e[1]) : null;
};
const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith("https://generativelanguage.googleapis.com/")) return null;
  const method = (init?.method ?? "GET").toUpperCase();
  const u = new URL(url);
  const keyHeader = headerOf(init, "x-goog-api-key");
  google.calls.push({ method, path: u.pathname, keyInUrl: u.searchParams.has("key"), keyHeader });
  if (method === "GET" && u.pathname === "/v1beta/models/gemini-3.8-flash") {
    return keyHeader === KEY
      ? json(200, { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash" })
      : json(400, { error: { code: 400, message: `API key not valid. Please pass a valid API key. (${keyHeader})`, status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } });
  }
  if (keyHeader !== KEY && !u.searchParams.has("upload_id")) return json(403, { error: { code: 403, message: "drill: wrong key", status: "PERMISSION_DENIED" } });
  if (method === "POST" && u.pathname === "/upload/v1beta/files" && !u.searchParams.has("upload_id")) {
    const body = JSON.parse(String(init?.body)) as { file: { display_name: string } };
    const id = `drill${++fileSeq}x`;
    google.display.set(`files/${id}`, body.file.display_name);
    if ([...google.slow].some((s) => body.file.display_name.endsWith(s))) google.processing.add(`files/${id}`);
    return new Response("", { status: 200, headers: { "x-goog-upload-url": `https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=${id}` } });
  }
  if (method === "POST" && u.pathname === "/upload/v1beta/files") {
    const id = u.searchParams.get("upload_id");
    const buf = await new Response(init?.body as BodyInit).arrayBuffer();
    google.uploads++;
    google.uploadedBytes += buf.byteLength;
    return json(200, { file: { name: `files/${id}`, uri: `https://generativelanguage.googleapis.com/v1beta/files/${id}`, mimeType: "video/mp4", state: "PROCESSING" } });
  }
  if (method === "GET" && u.pathname.startsWith("/v1beta/files/")) return json(200, { name: u.pathname.slice(8), state: google.processing.has(u.pathname.slice(8)) ? "PROCESSING" : "ACTIVE" });
  if (method === "DELETE" && u.pathname.startsWith("/v1beta/files/")) { google.deletes.push(u.pathname.slice(8)); return json(200, {}); }
  if (method === "POST" && u.pathname === "/v1beta/interactions") {
    const body = JSON.parse(String(init?.body)) as { input: { uri?: string }[] };
    const name = `files/${String(body.input[0]?.uri ?? "").split("/files/")[1] ?? ""}`;
    const m = /^rtp-(spell|cover)-(.+)$/.exec(google.display.get(name) ?? "");
    google.interactions.push({ body: body as unknown as Record<string, unknown>, kind: m?.[1] ?? null, sub: m?.[2] ?? null });
    const scripted = google.next.shift();
    if (scripted) return scripted;
    const text = m?.[1] === "spell" ? JSON.stringify({ texts: google.spell.get(m[2]) ?? [] }) : JSON.stringify({ moments: google.cover.get(m?.[2] ?? "") ?? [] });
    return json(200, { id: "drill-ix", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }], usage: { total_input_tokens: 34000, total_output_tokens: 120, total_tokens: 34120 } });
  }
  return json(404, { error: { code: 404, message: "drill: no such endpoint" } });
});
const rateLimited = (o: { retry?: string; perDay?: boolean }) =>
  json(429, {
    error: {
      code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED",
      details: [
        ...(o.perDay ? [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_requests_per_model_per_day", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] : []),
        ...(o.retry ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: o.retry }] : []),
      ],
    },
  });

const c = makeChecker();
const noDash = (s: string | null | undefined) => typeof s === "string" && !s.includes("—") && !s.includes("–");

// ---- the video: 4 s at 30 fps, every frame sharp except 1.85 to 2.25 s ----------------
function makeVideo(dir: string): string {
  const out = path.join(dir, "reel.mp4");
  execFileSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=540x960:rate=30:duration=4",
    "-vf", "gblur=sigma=18:enable='between(t,1.85,2.25)'", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", out,
  ]);
  return out;
}
function serve(file: string): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  const data = fs.readFileSync(file);
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const range = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ""));
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${data.length}`, "Accept-Ranges": "bytes" });
      res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": data.length, "Accept-Ranges": "bytes" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    resolve({ url: `http://127.0.0.1:${port}/reel.mp4`, hits: () => hits, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct24-gemini-video-isolated" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const core = await import("@/lib/videoAnalysisCore");
  const gem = await import("@/lib/integrations/gemini");
  const va = await import("@/lib/videoAnalysis");
  const frames = await import("@/lib/videoFrames");
  const store = await import("@/lib/videoCoverStore");
  const geminiActions = await import("@/app/connections/geminiActions");
  const spellingActions = await import("@/app/review/spellingActions");
  const { cutIdentityHash } = await import("@/lib/cutTranscripts");
  const sharp = (await import("sharp")).default;

  const as = async <T>(who: Viewer | null, fn: () => Promise<T>): Promise<T> => {
    process.env.AUTH_ENFORCE = "true";
    viewer = who;
    try { return await fn(); } finally { process.env.AUTH_ENFORCE = ""; viewer = JORDAN; }
  };
  const refusal = async (fn: () => Promise<unknown>) => fn().then(() => null, (e: Error) => e.message);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oct24-gemini-"));
  const video = makeVideo(tmp);
  const host = await serve(video);
  const sources: { cutId: string; kind: string; source: string }[] = [];
  va.__setVideoSourceForTests(async (f, cutId) => {
    sources.push({ cutId, kind: f.kind, source: f.kind === "dropbox" ? f.source : "editor" });
    return host.url;
  });
  const mem = store.memoryCoverStore();
  store.__setCoverStoreForTests(mem);
  const run = (o: Parameters<typeof va.runVideoAnalysis>[0] = {}) => va.runVideoAnalysis({ maxJobs: 2, budgetMs: 200_000, ...o });
  const jobOf = async (kind: "spell" | "cover", id: string) => core.parseJob((await prisma.appSetting.findUnique({ where: { key: core.GVA_KEY(kind, id) } }))?.value);

  // ---- the world -----------------------------------------------------------------
  const erika = await prisma.client.create({ data: { name: "Erika Walker", company: "Fox & Roach" } });
  const SCRIPT_HOOK = "This West Chester home just changed the game.";
  const SCRIPT = ["Welcome to 412 Brandywine Ln.", "The kitchen was fully renovated last spring.", "Every listing in this neighborhood sells fast.", "Call Erika Walker with Fox & Roach today."].join("\n");
  const job = async (street: string) => {
    const p = await prisma.project.create({ data: { title: `${street}, West Chester, PA 19380`, addressLine: street, city: "West Chester", state: "PA", zip: "19380", clientId: erika.id, status: "EDITING", reelHook: SCRIPT_HOOK, reelScript: SCRIPT } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Premium Social Media Reel" } });
    return { projectId: p.id, deliverableId: d.id };
  };
  let n = 0;
  const cut = async (j: { projectId: string; deliverableId: string }, data: Record<string, unknown> = {}) =>
    prisma.reviewSubmission.create({
      data: {
        projectId: j.projectId, deliverableId: j.deliverableId, slot: 1, round: 1, status: "PENDING", source: "upload",
        fileName: `Reel ${++n}.mp4`, sizeBytes: 1000 + n, sourceWidth: 1080, sourceHeight: 1920,
        blobUrl: `https://drillstore.public.blob.vercel-storage.com/review-cuts/r${n}.mp4`, ...data,
      } as never,
    });
  const brandywine = await job("412 Brandywine Ln");
  const before = await cut(brandywine, { createdAt: new Date(Date.now() - 3 * 86_400_000) });
  const beforeApproved = await cut(brandywine, { status: "APPROVED", decidedAt: new Date(Date.now() - 2 * 86_400_000), createdAt: new Date(Date.now() - 3 * 86_400_000) });

  // =========================================================================
  c.head("§1 · no key, no calls");
  // =========================================================================
  {
    const r = await run();
    c.ok("the driver stops at the gate: skipped no_key", r.skipped === "no_key", JSON.stringify(r));
    c.ok("ZERO requests to Google", google.calls.length === 0, `${google.calls.length}`);
    c.ok("ZERO job rows written (nothing queued behind a missing key)", (await prisma.appSetting.count({ where: { key: { startsWith: "gva:" } } })) === 0);
    c.ok("geminiKey() is null without a network call", (await gem.geminiKey()) === null && google.calls.length === 0);
  }

  // =========================================================================
  c.head("§2 · the key: tested, encrypted, never echoed; no backfill");
  // =========================================================================
  {
    const fd = (k: string) => { const f = new FormData(); f.set("key", k); return f; };
    const bad = await as(JORDAN, () => geminiActions.saveGeminiKey(null, fd(BAD_KEY)));
    c.ok("a bad key is NOT saved, in plain words", !bad.ok && /Not saved/.test(bad.message) && !(await prisma.connection.findUnique({ where: { provider: gem.GEMINI_CONNECTION } })), bad.message);
    c.ok("…and Google's echo of the key is scrubbed from the message", !bad.message.includes(BAD_KEY), bad.message);
    const asJames = await refusal(() => as(JAMES, () => geminiActions.saveGeminiKey(null, fd(KEY))));
    c.ok("only the owner may save a key (James refused)", !!asJames && /access/i.test(asJames), asJames ?? "saved");
    const preview = await refusal(() => as({ ...JORDAN, impersonating: true, role: "CREATIVE_MANAGER" }, () => geminiActions.saveGeminiKey(null, fd(KEY))));
    c.ok("a 'view as' preview cannot save", !!preview && /previewing/i.test(preview), preview ?? "saved");
    const callsBefore = google.calls.length;
    const ok = await as(JORDAN, () => geminiActions.saveGeminiKey(null, fd(KEY)));
    c.ok("the key is tested and saved", ok.ok && /Key accepted/.test(ok.message), ok.message);
    const test = google.calls.slice(callsBefore);
    c.ok("the test is ONE read of the model's description (no video, no generation)", test.length === 1 && test[0].method === "GET" && test[0].path === "/v1beta/models/gemini-3.8-flash", JSON.stringify(test));
    const row = await prisma.connection.findUnique({ where: { provider: gem.GEMINI_CONNECTION } });
    c.ok("stored encrypted in its own Connection row (gemini_video)", !!row?.secretEncrypted && !row.secretEncrypted.includes(KEY) && row.status === "CONNECTED");
    c.ok("the success message never carries the key", !ok.message.includes(KEY));
    const settings = await va.gvaSettings();
    c.ok("saving starts the clock (startedAt)", !!settings.startedAt && Math.abs(Date.parse(settings.startedAt) - Date.now()) < 60_000, String(settings.startedAt));
    c.ok("defaults: 2 fps, 40 requests a day, covers on, spelling on", settings.fps === 2 && settings.dailyCap === 40 && settings.covers && settings.spelling);
    await run();
    c.ok("NO BACKFILL: a version in review from before the key gets no spelling job", !(await jobOf("spell", before.id)));
    c.ok("…and a version approved before the key gets no covers", !(await jobOf("cover", beforeApproved.id)));
    c.ok("every request carries the key in the x-goog-api-key header, never the URL", google.calls.every((x) => !x.keyInUrl));
  }

  // =========================================================================
  c.head("§3 · spelling: only known-word mismatches, at most 3");
  // =========================================================================
  const reading = (start: number, text: string, o: { second?: string; confidence?: number; overlay?: boolean } = {}) =>
    ({ start, text, second_reading: o.second ?? text, confidence: o.confidence ?? 0.95, overlay: o.overlay ?? true });
  const spellA = await cut(brandywine);
  // The caption builder's Deepgram transcript of THIS cut: it mishears the street.
  {
    const row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: spellA.id } });
    await prisma.contentCutTranscript.create({
      data: {
        submissionId: spellA.id, contentHash: cutIdentityHash(row), status: "SUCCEEDED", provider: "deepgram", text: "welcome to 412 brandy wine lane",
        segmentsJson: JSON.stringify([{ start: 0.4, end: 2.6, text: "this westchester home just changed the game" }, { start: 3.1, end: 5.2, text: "welcome to 412 brandy wine lane" }, { start: 5.6, end: 8.4, text: "the kitchen was fully renovated last spring" }]),
      },
    });
  }
  google.spell.set(spellA.id, [
    reading(1.2, "Westchester living at its best"),
    reading(3.4, "Welcome to 412 Brandywyne Ln"),
    reading(9.1, "Call Erica Walker with Fox & Roach"),
    reading(6.0, "The kitchen was fully renovatd last spring"),
    reading(5.0, "Brandywne", { confidence: 0.55 }),
    reading(7.0, "Every listing in this neighbourhood", { second: "Every listing in this neighborhood", confidence: 0.9 }),
    reading(8.0, "Gorgeous sunsets", { confidence: 0.99 }),
    reading(8.5, "Every listings in this neighborhood sells fast"),
    reading(2.0, "STOP", { overlay: false, confidence: 0.99 }),
  ]);
  {
    const ix = google.interactions.length;
    const r = await run();
    const done = r.ran.find((x) => x.submissionId === spellA.id);
    c.ok("the version in review was swept and checked", !!done && /^flagged_/.test(done.outcome), JSON.stringify(r.ran));
    const sent = google.interactions.slice(ix).filter((x) => x.sub === spellA.id);
    c.ok("ONE model request for it", sent.length === 1, `${sent.length}`);
    const body = sent[0]?.body as { model?: string; store?: boolean; temperature?: unknown; input?: { type: string; resolution?: string; processing?: { type: string; fps: number } }[]; response_format?: { mime_type?: string } } | undefined;
    const vid = body?.input?.[0];
    c.ok("the request: gemini-3.8-flash, the video at resolution high, static sampling at 2 fps, JSON out, store false, no temperature",
      body?.model === "gemini-3.8-flash" && vid?.type === "video" && vid.resolution === "high" && vid.processing?.type === "static" && vid.processing.fps === 2 && body?.response_format?.mime_type === "application/json" && body.store === false && body.temperature === undefined,
      JSON.stringify({ model: body?.model, vid, store: body?.store }));
    const prompt = String((body?.input?.[1] as { text?: string } | undefined)?.text ?? "");
    c.ok("the prompt gives the SCRIPT's spelling with Deepgram's timing (00:03 to 00:05: Welcome to 412 Brandywine Ln.)", prompt.includes("00:03 to 00:05: Welcome to 412 Brandywine Ln."), prompt.slice(-400));
    c.ok("…and never Deepgram's own words (it heard 'brandy wine lane')", !/brandy wine|westchester home/i.test(prompt));
    c.ok("…and the client's names to spell exactly", /Names: .*Erika Walker/.test(prompt) && prompt.includes("Fox & Roach"));
    const j = await jobOf("spell", spellA.id);
    const flags = j?.spell?.flags ?? [];
    c.ok("at most 3 flags: exactly 3 of the 4 real mismatches", flags.length === 3 && j?.spell?.dropped.overCap === 1, JSON.stringify(j?.spell?.dropped));
    c.ok("1) the town run together: \"On screen: 'West Chester' reads 'Westchester' at 00:01 (the address says West Chester, as separate words).\"",
      flags[0]?.line === "On screen: 'West Chester' reads 'Westchester' at 00:01 (the address says West Chester, as separate words).", flags[0]?.line);
    c.ok("2) the street: \"On screen: '412 Brandywine Ln' reads '412 Brandywyne Ln' at 00:03 (the address says 412 Brandywine Ln).\"",
      flags[1]?.line === "On screen: '412 Brandywine Ln' reads '412 Brandywyne Ln' at 00:03 (the address says 412 Brandywine Ln).", flags[1]?.line);
    c.ok("3) the client's name: \"On screen: 'Erika Walker' reads 'Erica Walker' at 00:09 (the spelling list says Erika Walker).\"",
      flags[2]?.line === "On screen: 'Erika Walker' reads 'Erica Walker' at 00:09 (the spelling list says Erika Walker).", flags[2]?.line);
    c.ok("unreadable text is never flagged (low confidence, or two readings that disagree)", j?.spell?.dropped.unclear === 2 && !flags.some((f) => /Brandywne|neighbourhood/.test(f.onScreen)));
    c.ok("unknown words are never flagged ('Gorgeous sunsets'), nor a caption that follows what was said ('listings')", j?.spell?.dropped.unknown === 2 && !flags.some((f) => /Gorgeous|listings/.test(f.onScreen)));
    c.ok("text that is part of the scene is not checked", j?.spell?.dropped.notOverlay === 1);
    c.ok("the uploaded copy was deleted afterwards", google.deletes.length >= 1 && !j?.file);
    c.ok("timing came from the transcript (kept on the row)", j?.timing === "deepgram");
  }
  const spellB = await cut(await job("7 Brandywine Ln"));
  google.spell.set(spellB.id, [
    reading(6.0, "The kitchen was fully renovatd last spring"),
    reading(9.0, "Quiet neighborhod"),
    reading(11.0, "Spectacular backyrd"),
  ]);
  {
    await run();
    const flags = (await jobOf("spell", spellB.id))?.spell?.flags ?? [];
    c.ok("a script word: \"On screen: 'renovated' reads 'renovatd' at 00:06 (the script says renovated).\"",
      flags.length === 1 && flags[0].line === "On screen: 'renovated' reads 'renovatd' at 00:06 (the script says renovated).", JSON.stringify(flags.map((f) => f.line)));
    c.ok("a near-miss of a script word in a caption that is NOT that script line is left alone ('Quiet neighborhod')", !flags.some((f) => /neighborhod/.test(f.onScreen)));
    // The pure rule, straight: no references, no flags, whatever is on screen.
    const none = core.selectSpellingFlags([reading(1, "Brandywyne Ln Westchester")], core.buildReferences({ script: null, names: [] }));
    c.ok("with no script and no names nothing can be flagged", none.flags.length === 0);
    const lower = core.selectSpellingFlags([reading(1, "We hope you love it here")], core.buildReferences({ script: null, names: [{ text: "Hope Tate", from: "client" }] }));
    c.ok("a lower-case word one letter off a name in a sentence-case caption is just a word", lower.flags.length === 0);
  }

  // =========================================================================
  c.head("§4 · the trial: Jordan only, Right / Wrong, precision; the reviewer switch");
  // =========================================================================
  {
    c.ok("the reviewer switch starts OFF", (await va.spellingReviewersOn()) === false);
    c.ok("OFF: the owner sees the flags (with Right / Wrong)", core.spellingViewFor("OWNER", { reviewersOn: false, atReviewDesk: true }) === "owner");
    c.ok("OFF: James at the review desk sees nothing", core.spellingViewFor("CREATIVE_MANAGER", { reviewersOn: false, atReviewDesk: true }) === null);
    c.ok("OFF: Kyle sees nothing", core.spellingViewFor("ADMIN", { reviewersOn: false, atReviewDesk: true }) === null);
    const a = (await jobOf("spell", spellA.id))!.spell!.flags;
    const b = (await jobOf("spell", spellB.id))!.spell!.flags;
    const jamesMarks = await refusal(() => as(JAMES, () => spellingActions.markSpellingFlag(spellA.id, a[0].id, "RIGHT")));
    c.ok("James cannot mark a flag", !!jamesMarks && /access/i.test(jamesMarks), jamesMarks ?? "marked");
    const previewMarks = await refusal(() => as({ ...JORDAN, impersonating: true }, () => spellingActions.markSpellingFlag(spellA.id, a[0].id, "RIGHT")));
    c.ok("a 'view as' preview cannot mark one", !!previewMarks && /previewing/i.test(previewMarks), previewMarks ?? "marked");
    const marks = [
      await as(JORDAN, () => spellingActions.markSpellingFlag(spellA.id, a[0].id, "RIGHT")),
      await as(JORDAN, () => spellingActions.markSpellingFlag(spellA.id, a[1].id, "RIGHT")),
      await as(JORDAN, () => spellingActions.markSpellingFlag(spellA.id, a[2].id, "WRONG")),
      await as(JORDAN, () => spellingActions.markSpellingFlag(spellB.id, b[0].id, "RIGHT")),
    ];
    c.ok("Jordan marks Right / Wrong", marks.every((m) => m.ok), JSON.stringify(marks));
    const after = (await jobOf("spell", spellA.id))!.spell!.flags;
    c.ok("…recorded on the flag, with who and when", after[2].verdict === "WRONG" && after[2].verdictBy === "owner@drill.invalid" && !!after[2].verdictAt);
    const trial = await va.spellingTrial();
    c.ok("precision: \"4 flags · 3 right · 1 wrong · 75% right\"", trial.summary.words === "4 flags · 3 right · 1 wrong · 75% right" && trial.summary.precision === 0.75, trial.summary.words);
    c.ok("9 of 10 is not met yet (needs at least 10 marked)", trial.summary.barMet === false);
    c.ok("the trial runs two weeks from the key", !!trial.endsAt && Date.parse(trial.endsAt) - Date.parse(trial.startedAt!) === 14 * 86_400_000);
    const ten = core.trialSummary([...Array(9).fill({ verdict: "RIGHT" }), { verdict: "WRONG" }]);
    c.ok("9 right of 10 marked: the bar is met", ten.barMet && ten.precision === 0.9);
    const clear = await as(JORDAN, () => spellingActions.markSpellingFlag(spellB.id, b[0].id, null));
    c.ok("a mark can be cleared", clear.ok && (await va.spellingTrial()).summary.open === 1);
    await as(JORDAN, () => spellingActions.markSpellingFlag(spellB.id, b[0].id, "RIGHT"));
    const jamesSwitch = await refusal(() => as(JAMES, () => spellingActions.setSpellingFlagsForReviewers(true)));
    c.ok("only Jordan turns the reviewer switch", !!jamesSwitch && /access/i.test(jamesSwitch));
    const on = await as(JORDAN, () => spellingActions.setSpellingFlagsForReviewers(true));
    c.ok("ON: Jordan turns it on", on.ok && (await va.spellingReviewersOn()) === true);
    c.ok("ON: James at the review desk now sees them (no buttons)", core.spellingViewFor("CREATIVE_MANAGER", { reviewersOn: true, atReviewDesk: true }) === "reviewer");
    c.ok("ON: a photographer still never does", core.spellingViewFor("PHOTOGRAPHER", { reviewersOn: true, atReviewDesk: true }) === null);
    await as(JORDAN, () => spellingActions.setSpellingFlagsForReviewers(false));
    c.ok("OFF again: hidden from James", core.spellingViewFor("CREATIVE_MANAGER", { reviewersOn: await va.spellingReviewersOn(), atReviewDesk: true }) === null);
    const page = src("src/app/review/[id]/page.tsx");
    const panel = src("src/components/review/CutReviewPanel.tsx");
    c.ok("the Review Room page decides who sees them with spellingViewFor and the switch", page.includes("spellingViewFor(me.role, { reviewersOn: await m.spellingReviewersOn(), atReviewDesk: ownerDesk })") && page.includes("<SpellingFlagsNote"));
    c.ok("…and the panel draws them above the verdict, never in place of it", /\{canDecide && spellingNote\}\s*\{\/\* Note \+ verdict bar \*\/\}/.test(panel));
    const settingsPage = src("src/app/settings/page.tsx");
    c.ok("Settings carries the switch in the Video Review Room card", settingsPage.includes("<SpellingFlagsSetting initial={spellingFlags.on}") && src("src/components/settings/SpellingFlagsSetting.tsx").includes('label="Show spelling flags to reviewers"'));
  }

  // =========================================================================
  c.head("§5 · covers: three, the best pre-selected, the sharpest real frame");
  // =========================================================================
  const listing = await job("19 Okehocking Ln");
  const approved = await cut(listing, { status: "APPROVED", decidedAt: new Date(), decidedBy: "James" });
  const moment = (t: number, score: number, o: Record<string, unknown> = {}) =>
    ({ t, score, person: true, facing_camera: true, eyes_open: true, sharp: true, well_lit: true, face_x: 0.5, face_y: 0.45, in_grid: true, why: "agent smiling at the camera", ...o });
  google.cover.set(approved.id, [moment(2.0, 9), moment(0.4, 7), moment(3.6, 6.8), moment(3.7, 9.5, { in_grid: false })]);
  // The pure window first: is the frame at 2.0 s really blurred, its neighbours sharp?
  {
    const dir = fs.mkdtempSync(path.join(tmp, "win-"));
    const w = await frames.sampleWindow(FFMPEG, host.url, 2.0, dir, { focus: { x: 0.5, y: 0.45 } });
    const inBlur = w.frames.filter((f) => f.t >= 1.9 && f.t <= 2.2);
    const outBlur = w.frames.filter((f) => f.t < 1.75 || f.t > 2.35);
    const best = w.frames.reduce((x, y) => (y.sharpness > x.sharpness ? y : x), w.frames[0]);
    c.ok("ffmpeg reads ±0.5 s around the moment, every 2nd frame of the 30 fps file (about 15)", w.frames.length >= 12 && w.frames.length <= 17 && w.frames[0].t >= 1.49 && w.frames[w.frames.length - 1].t <= 2.51, `${w.frames.length}: ${w.frames.map((f) => f.t.toFixed(2)).join(" ")}`);
    c.ok("the frames at the moment are blurred, their neighbours sharp (Laplacian variance)", inBlur.length > 0 && outBlur.length > 0 && Math.max(...inBlur.map((f) => f.sharpness)) * 2 < Math.min(...outBlur.map((f) => f.sharpness)), w.frames.map((f) => `${f.t.toFixed(2)}:${Math.round(f.sharpness)}`).join(" "));
    c.ok("the sharpest is outside the blur", best.t < 1.85 || best.t > 2.25, `${best.t}`);
  }
  {
    const ix = google.interactions.length;
    const r = await run();
    c.ok("the approved version was swept and its covers made", r.ran.some((x) => x.submissionId === approved.id && x.outcome === "covers_3"), JSON.stringify(r.ran));
    c.ok("ONE model request for its covers", google.interactions.slice(ix).filter((x) => x.sub === approved.id && x.kind === "cover").length === 1);
    const j = await jobOf("cover", approved.id);
    const cand = j?.cover?.candidates ?? [];
    c.ok("3 candidates, ranked: 2.0 s, 0.4 s, 3.6 s (3.7 s scored higher but had the face outside the grid band, and sits too close to 3.6 s)", cand.length === 3 && cand.map((x) => x.t).join(",") === "2,0.4,3.6", cand.map((x) => x.t).join(","));
    c.ok("the best is pre-selected (n 0), nobody has picked yet", j?.cover?.best === 0 && j.cover.pick === null && core.chosenCover(j.cover)?.n === 0);
    c.ok("Gemini's moment is the moment, not the frame: the blurred frame at 2.0 s lost to a sharp neighbour within half a second",
      cand[0].frameT < 1.85 || cand[0].frameT > 2.25 ? Math.abs(cand[0].frameT - 2.0) <= 0.51 : false, `frameT ${cand[0].frameT}, sharpness ${cand[0].sharpness}`);
    const bytes = mem.files.get(cand[0].ref.pathname);
    const meta = bytes ? await sharp(bytes).metadata() : null;
    c.ok("each cover is a 1080×1920 JPEG in the hub's own store", !!meta && meta.width === 1080 && meta.height === 1920 && meta.format === "jpeg" && cand.every((x) => mem.files.has(x.ref.pathname)), JSON.stringify(meta && { w: meta.width, h: meta.height, f: meta.format }));
    c.ok("read from the editor's file (no Topaz pass on this version)", j?.cover?.source === "editor" && sources.some((s) => s.cutId === approved.id && s.source === "editor"));
    const again = google.interactions.length;
    await run();
    await run();
    c.ok("ONE RUN PER VERSION: two more ticks ask Google nothing about it", google.interactions.length === again && google.interactions.filter((x) => x.sub === approved.id && x.kind === "cover").length === 1);
    const land = await frames.coverJpeg(await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#336699" } }).jpeg().toBuffer(), 0.7);
    const lm = await sharp(land).metadata();
    c.ok("a wide video's cover is cropped to 9:16 around the face, 1080×1920", lm.width === 1080 && lm.height === 1920);
  }
  // A version still in its Topaz pass: the cover waits, then reads the checked Topaz file.
  const topazCut = await cut(await job("3 Leola Rd"), { status: "APPROVED", decidedAt: new Date(), decidedBy: "James" });
  google.cover.set(topazCut.id, [moment(0.4, 8), moment(2.0, 7.5), moment(3.6, 7)]);
  {
    const tj = await prisma.topazJob.create({ data: { submissionId: topazCut.id, projectId: (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: topazCut.id } })).projectId, state: "processing" } });
    const ix = google.interactions.length;
    await run();
    const waiting = await jobOf("cover", topazCut.id);
    c.ok("while the Topaz pass runs: WAITING, said so, and nothing sent for its covers", waiting?.state === "WAITING" && waiting.waitReason === "Waiting for the Topaz pass to finish." && !waiting.file && google.interactions.slice(ix).every((x) => !(x.sub === topazCut.id && x.kind === "cover")), JSON.stringify({ state: waiting?.state }));
    await prisma.topazJob.update({ where: { id: tj.id }, data: { state: "done", finalPath: "/Jobs/3 Leola Rd/05-Final-Video/Leola 1080p.mp4", savedAt: new Date(), outputCheck: "verified" } });
    await run({ now: () => new Date(Date.now() + 11 * 60_000) });
    const j = await jobOf("cover", topazCut.id);
    c.ok("once it is checked: the covers are read from the Topaz file", j?.state === "DONE" && j.cover?.source === "topaz" && sources.some((s) => s.cutId === topazCut.id && s.source === "topaz"), JSON.stringify({ state: j?.state, source: j?.cover?.source, err: j?.error }));
  }

  // =========================================================================
  c.head("§6 · where covers appear, and who may open them");
  // =========================================================================
  {
    const { GET: staffCover } = await import("@/app/api/video-cover/[id]/route");
    const { NextRequest } = await import("next/server");
    const ask = (who: Viewer | null, q = "") => as(who, () => staffCover(new NextRequest(`https://hub.example.test/api/video-cover/${approved.id}${q}`), { params: Promise.resolve({ id: approved.id }) }));
    for (const [who, label] of [[JORDAN, "Jordan"], [KYLE, "Kyle (office)"], [JAMES, "James (creative manager)"]] as const) {
      const r = await ask(who);
      c.ok(`staff route: ${label} gets the JPEG`, r.status === 200 && r.headers.get("content-type") === "image/jpeg");
    }
    for (const [who, label] of [[JOHN, "an editor"], [HARRISON, "a photographer"]] as const) {
      const r = await ask(who);
      c.ok(`staff route: ${label} is refused`, r.status === 403, `${r.status}`);
    }
    c.ok("staff route: signed out is refused", (await ask(null)).status === 401);
    const dl = await ask(JORDAN, "?n=1&dl=1");
    c.ok("?dl=1 saves it as a file (cover 2)", dl.status === 200 && /attachment; filename=".* cover 2\.jpg"/.test(dl.headers.get("content-disposition") ?? ""), dl.headers.get("content-disposition") ?? "");

    const { readyToSend } = await import("@/lib/readyToSend");
    const board = await readyToSend({ projectId: listing.projectId });
    const row = board.ready.find((v) => v.submissionId === approved.id);
    c.ok("Ready to send: the row offers the cover beside Download", row?.cover?.downloadHref === `/api/video-cover/${approved.id}?n=0&dl=1` && row.cover.src === `/api/video-cover/${approved.id}?n=0`, row ? JSON.stringify(row.cover) : `no row (${board.ready.length} ready)`);
    c.ok("…drawn on the card", src("src/components/ops/ReadyToSendCard.tsx").includes("{v.cover && (") && src("src/components/ops/ReadyToSendCard.tsx").includes("data-cover-download"));

    await prisma.reviewSubmission.update({ where: { id: approved.id }, data: { sentToClientAt: new Date() } });
    const { loadFinishedVideos } = await import("@/lib/mediaLibrary");
    const tiles = await loadFinishedVideos({ projectIds: [listing.projectId] });
    const tile = tiles.find((t) => t.key === `cut:${approved.id}`);
    c.ok("Media library: the tile's poster is the chosen cover and it is offered for download", tile?.poster === `/api/video-cover/${approved.id}?n=0` && tile.coverHref === `/api/video-cover/${approved.id}?n=0&dl=1`, JSON.stringify(tile && { poster: tile.poster, cover: tile.coverHref }));
    c.ok("…and the tile carries it (menu and the larger view)", src("src/components/media/VideoTile.tsx").includes("Download cover") && src("src/components/media/types.ts").includes("coverHref: v.coverHref ?? null"));

    // ---- the portal Posting Kit (a TEST program: the sweep leaves TEST clients out, so it is asked for by hand) ----
    const { buildContentMonth } = await import("./_fixtures/contentMonth");
    const cv = await import("@/lib/contentVideos");
    const ce = await import("@/lib/cutEntitlement");
    const pk = await import("@/lib/postingKit");
    const { streamUrlFor } = await import("@/lib/reviewCuts");
    const { mediaToken } = await import("@/lib/portalMedia");
    const { portalPickCover } = await import("@/app/portal/actions");
    const { GET: portalCover } = await import("@/app/api/portal/cover/[videoId]/route");
    const program = async (name: string) => {
      const f = await buildContentMonth(prisma as unknown as PrismaClient, { name, package: "Starter", monthKey: "2026-10", project: { status: "SCHEDULED", shootDate: new Date(Date.now() - 5 * 86_400_000) }, owner: { email: `${name.split(" ")[0].toLowerCase()}@example.com`, name } });
      const sub = await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, round: 1, fileName: `${name.split(" ")[0]} v1.mp4`, status: "APPROVED", source: "upload", decidedBy: "James", decidedAt: new Date(Date.now() - 3_600_000), completedAt: new Date(Date.now() - 3_600_000), sizeBytes: 4321, sourceWidth: 1080, sourceHeight: 1920 }, select: { id: true } });
      await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { assetUrl: streamUrlFor(sub.id), blobUrl: `https://drillstore.public.blob.vercel-storage.com/review-cuts/${sub.id}.mp4`, blobPathname: `review-cuts/${sub.id}.mp4` } });
      // A program cut reaches the client as its checked 1080p file (9.6b): finished and verified here.
      await prisma.topazJob.create({ data: { submissionId: sub.id, projectId: f.projectId!, state: "done", finalPath: `/Jobs/${name}/05-Final-Video/${name} 1080p.mp4`, savedAt: new Date(), outputCheck: "verified", outputWidth: 1080, outputHeight: 1920 } });
      await cv.syncEnrollmentVideos({ id: f.enrollmentId, clientId: f.clientId });
      const v = await prisma.contentVideo.findFirstOrThrow({ where: { currentSubmissionId: sub.id } });
      // Published to the client's portal (the checked file went up): the version is theirs to decide on.
      await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { clientReleasedAt: new Date(), clientReleasedBy: "drill" } });
      const pv = {
        enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth },
        actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "x@example.com", name, membershipId: f.membershipId!, membershipRole: "OWNER" },
        access: "FULL", via: "LOGIN",
      } as PortalViewer;
      return { f, sub: sub.id, video: v, viewer: pv };
    };
    const ada = await program("Ada Cover TEST");
    const bo = await program("Bo Other TEST");
    const swept = await run();
    c.ok("the sweep leaves TEST clients out (no free-tier request spent on them)", !(await jobOf("cover", ada.sub)) && !swept.ran.some((x) => x.submissionId === ada.sub));
    google.cover.set(ada.sub, [moment(2.0, 9), moment(0.4, 8), moment(3.6, 7)]);
    const q = await va.enqueueVideoAnalysis("cover", ada.sub);
    c.ok("asked for by hand, once", q.queued && !(await va.enqueueVideoAnalysis("cover", ada.sub)).queued);
    await run();
    const adaJob = await jobOf("cover", ada.sub);
    c.ok("Ada's covers are made, from her checked 1080p file", adaJob?.state === "DONE" && adaJob.cover?.source === "topaz", JSON.stringify({ state: adaJob?.state, source: adaJob?.cover?.source, err: adaJob?.error }));
    const scope = { kind: "membership" as const, id: ada.f.membershipId! };
    const portalGet = (videoId: string, token: string | null, q2 = "") =>
      portalCover(new NextRequest(`https://hub.example.test/api/portal/cover/${videoId}?${token ? `m=${encodeURIComponent(token)}` : ""}${q2}`), { params: Promise.resolve({ videoId }) });
    const kitBefore = await pk.postingKitFor(ada.viewer, ada.video);
    c.ok("before the client approves the version: no covers in the kit (they open with the download)", !kitBefore.covers && !kitBefore.access.download);
    c.ok("…and the portal cover door refuses (404, the cover opens with the download)", (await portalGet(ada.video.id, mediaToken(ada.video.id, scope))).status === 404);
    const adaRow = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: ada.sub } });
    await prisma.clientDecision.create({ data: { submissionId: ada.sub, projectId: ada.f.projectId!, videoId: ada.video.id, enrollmentId: ada.f.enrollmentId, clientId: ada.f.clientId, round: 1, contentHash: ce.stableCutIdentity(adaRow), decision: "APPROVE", actorLabel: "client", clientUserId: ada.f.clientUserId, membershipRole: "OWNER", receiptState: "DONE" } });
    const kit = await pk.postingKitFor(ada.viewer, ada.video);
    c.ok("approved: the Posting Kit offers 3 covers, our best chosen", kit.covers?.options.length === 3 && kit.covers.selected === 0 && kit.covers.best === 0 && !kit.covers.pickedByClient && kit.covers.canPick, JSON.stringify({ covers: kit.covers && { n: kit.covers.options.length, sel: kit.covers.selected }, why: kit.access.why, blocked: kit.access.blockedBy, final: kit.final?.kind }));
    c.ok("…beside the video's own download", kit.access.download && !!kit.download);
    c.ok("…every picture through the portal's cover door with a media token (never a storage link)", !!kit.covers && kit.covers.options.every((o) => o.src.startsWith(`/api/portal/cover/${ada.video.id}?m=`) && o.downloadHref.endsWith(`&n=${o.n}&dl=1`) && !/dropbox|blob\.vercel/.test(o.src)));
    const ok = await portalGet(ada.video.id, mediaToken(ada.video.id, scope), "&n=1");
    c.ok("the portal door hands Ada her cover", ok.status === 200 && ok.headers.get("content-type") === "image/jpeg");
    c.ok("…not with a token minted for another video", (await portalGet(ada.video.id, mediaToken(bo.video.id, scope))).status === 403);
    c.ok("…not without a token", (await portalGet(ada.video.id, null)).status === 403);
    c.ok("…not to another program's seat", (await portalGet(ada.video.id, mediaToken(ada.video.id, { kind: "membership", id: bo.f.membershipId! }))).status === 403);
    const picked = await portalPickCover({ token: ada.f.portalToken }, ada.video.id, 2);
    c.ok("the client picks cover 3", picked.ok, picked.message);
    const kit2 = await pk.postingKitFor(ada.viewer, ada.video);
    c.ok("…and it is the chosen one now, theirs", kit2.covers?.selected === 2 && kit2.covers.pickedByClient);
    const jobAfter = await jobOf("cover", ada.sub);
    c.ok("…recorded with who picked it", jobAfter?.cover?.pick?.n === 2 && /^link$|^client:/.test(jobAfter.cover.pick.by));
    const dl2 = await portalGet(ada.video.id, mediaToken(ada.video.id, scope), "&dl=1");
    const want = mem.files.get(jobAfter!.cover!.candidates[2].ref.pathname)!;
    const got = Buffer.from(await dl2.arrayBuffer());
    c.ok("the cover download is the chosen cover, as a file named after the video", dl2.status === 200 && got.equals(want) && /attachment; filename=".* cover\.jpg"/.test(dl2.headers.get("content-disposition") ?? ""));
    const stranger = await portalPickCover({ token: bo.f.portalToken }, ada.video.id, 1);
    c.ok("another program's link cannot pick Ada's cover", !stranger.ok && (await jobOf("cover", ada.sub))?.cover?.pick?.n === 2, stranger.message);
    const badN = await portalPickCover({ token: ada.f.portalToken }, ada.video.id, 4);
    c.ok("a cover that isn't one of the choices is refused", !badN.ok);
    c.ok("the kit's picker is on the Videos tab", src("src/components/portal/tabs/VideosTab.tsx").includes("<CoverPicker videoId={d.video.id} covers={d.kit.covers} />"));
  }

  // =========================================================================
  c.head("§7 · the free tier: 429 backoff, the daily cap, the fps setting");
  // =========================================================================
  {
    c.ok("backoff: 1 min, then 2, 4… capped at an hour, plus at most 10% jitter", core.backoffMs(1, null, () => 0) === 60_000 && core.backoffMs(3, null, () => 0) === 240_000 && core.backoffMs(12, null, () => 0) === 3_600_000 && core.backoffMs(1, null, () => 1) === 66_000);
    c.ok("a retryDelay from Google is honoured (never under 30 s)", core.backoffMs(1, 37_000, () => 0) === 37_000 && core.backoffMs(1, 5_000, () => 0) === 30_000);
    const e1 = gem.geminiHttpError(429, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }] } }), KEY);
    c.ok("a 429 is read: retryable, 37 s, not the daily quota", e1.kind === "rate_limited" && e1.retryable && e1.retryAfterMs === 37_000 && !e1.perDay);
    const midnight = core.nextPacificMidnight(new Date("2026-10-24T18:00:00Z"));
    c.ok("the daily quota restarts at midnight Pacific (Oct 25 07:00 UTC)", midnight.toISOString() === "2026-10-25T07:00:00.000Z", midnight.toISOString());
    const odd = core.nextPacificMidnight(new Date("2026-10-24T04:44:45.974Z")).toISOString();
    const dst = core.nextPacificMidnight(new Date("2026-11-01T12:00:00Z")).toISOString();
    c.ok("…to the millisecond from any time of day, and across the clock change (Nov 2 08:00 UTC)", odd === "2026-10-24T07:00:00.000Z" && dst === "2026-11-02T08:00:00.000Z", `${odd} ${dst}`);

    const rl = await cut(await job("88 Ridley Ave"));
    google.next.push(rateLimited({ retry: "37s" }));
    const t0 = Date.now();
    const r1 = await run({ maxJobs: 1 });
    const j1 = await jobOf("spell", rl.id);
    c.ok("429: the job waits (QUEUED), its tries untouched, one rate limit counted", r1.ran[0]?.outcome === "rate_limited" && j1?.state === "QUEUED" && j1.attempts === 0 && j1.rateLimited === 1, JSON.stringify({ ran: r1.ran, state: j1?.state, a: j1?.attempts }));
    const wait = Date.parse(j1!.nextAttemptAt!) - t0;
    c.ok("…until Google's 37 s have passed (with jitter, under 45 s)", wait >= 36_000 && wait <= 45_000, `${wait} ms`);
    c.ok("…and the uploaded copy is kept for the retry", !!j1?.file?.name);
    const calls = google.calls.length;
    const r2 = await run();
    c.ok("during the pause: skipped, and ZERO requests to Google (not even an upload)", r2.skipped === "cooling_down" && google.calls.length === calls, `${r2.skipped}, ${google.calls.length - calls}`);
    const uploads = google.uploads;
    const r3 = await run({ maxJobs: 1, now: () => new Date(Date.now() + 60_000) });
    c.ok("after the pause it runs, reusing the uploaded copy (no second upload)", r3.ran[0]?.submissionId === rl.id && (await jobOf("spell", rl.id))?.state === "DONE" && google.uploads === uploads, JSON.stringify(r3.ran));

    const pd = await cut(await job("90 Ridley Ave"));
    google.next.push(rateLimited({ perDay: true }));
    const now = new Date(Date.now() + 120_000);
    await run({ maxJobs: 1, now: () => now });
    const jd = await jobOf("spell", pd.id);
    c.ok("a per-day 429: paused until midnight Pacific", jd?.state === "QUEUED" && jd.nextAttemptAt === core.nextPacificMidnight(now).toISOString(), `${jd?.nextAttemptAt}`);
    const card = await va.geminiCardData(now);
    c.ok("…and the Connections card says so", card.usage.cooldownUntil === core.nextPacificMidnight(now).toISOString());

    // The daily cap, on the next Pacific day.
    const day2 = new Date(core.nextPacificMidnight(now).getTime() + 3_600_000);
    const capSave = await as(JORDAN, () => geminiActions.saveGeminiOptions({ fps: 3, dailyCap: 1, covers: true, spelling: true }));
    c.ok("Jordan sets 3 fps and a ceiling of 1 a day: \"3 fps · about 52k tokens per minute of video\"", capSave.ok && capSave.message.includes("3 fps · about 52k tokens per minute of video") && capSave.message.includes("at most 1 requests a day"), capSave.message);
    const extra = await cut(await job("92 Ridley Ave"));
    const ix = google.interactions.length;
    const r4 = await run({ maxJobs: 3, now: () => day2 });
    const sentToday = google.interactions.slice(ix);
    c.ok("next day: ONE request, then the cap stops the tick", sentToday.length === 1 && r4.usage.calls === 1 && r4.usage.cap === 1, JSON.stringify({ n: sentToday.length, usage: r4.usage, ran: r4.ran }));
    c.ok("the fps setting is read per run: that request sampled at 3 fps", (sentToday[0]?.body as { input: { processing?: { fps?: number } }[] }).input[0].processing?.fps === 3);
    const r5 = await run({ now: () => new Date(day2.getTime() + 60_000) });
    c.ok("at the cap: skipped daily_cap, nothing sent", r5.skipped === "daily_cap" && google.interactions.length === ix + 1);
    const left = [await jobOf("spell", pd.id), await jobOf("spell", extra.id)].filter((x) => x?.state === "QUEUED").length;
    c.ok("the rest wait for tomorrow (still queued, not failed)", left === 1, `${left}`);
    await as(JORDAN, () => geminiActions.saveGeminiOptions({ fps: 2, dailyCap: 40, covers: true, spelling: true }));

    // Google still reading the upload when the tick's time is up: the next tick resumes the SAME upload.
    const day2b = new Date(day2.getTime() + 2 * 3_600_000);
    await run({ now: () => day2b }); // the one left waiting from the cap goes now
    const slow = await cut(await job("94 Ridley Ave"));
    google.slow.add(slow.id);
    const up0 = google.uploads;
    const ix2 = google.interactions.length;
    const r6 = await run({ maxJobs: 1, budgetMs: 115_000, now: () => day2b });
    const js = await jobOf("spell", slow.id);
    c.ok("still being read at the end of its wait: back in line (one try used), its upload kept on the row, nothing asked", r6.ran[0]?.submissionId === slow.id && r6.ran[0].outcome === "retry" && js?.state === "QUEUED" && js.attempts === 1 && !!js.file?.name && google.interactions.length === ix2 && google.uploads === up0 + 1, JSON.stringify({ ran: r6.ran, state: js?.state, a: js?.attempts }));
    google.processing.clear();
    await run({ maxJobs: 1, now: () => new Date(day2b.getTime() + 5 * 60_000) });
    c.ok("the next tick asks about the same upload (no second upload)", (await jobOf("spell", slow.id))?.state === "DONE" && google.uploads === up0 + 1 && google.interactions.length === ix2 + 1);
    c.ok("token words: 2 fps · about 35k tokens per minute of video (280 a frame at high, plus 25 a second of sound)", core.fpsWords(2) === "2 fps · about 35k tokens per minute of video" && core.tokensPerMinute(2) === 35_100);
    c.ok("fps is kept between 1 and 5", core.clampFps(9) === 5 && core.clampFps(0) === 1 && core.clampFps("x") === 2);

    // Removing the key stops everything again.
    await as(JORDAN, () => geminiActions.disconnectGemini());
    const before2 = google.calls.length;
    const off = await run();
    c.ok("key removed: skipped no_key, ZERO requests", off.skipped === "no_key" && google.calls.length === before2);
  }

  // =========================================================================
  c.head("§8 · words and secrets");
  // =========================================================================
  {
    const rows = await prisma.appSetting.findMany({ where: { OR: [{ key: { startsWith: "gva:" } }, { key: { startsWith: "gemini_video" } }] } });
    c.ok("the key is in no job, setting or state row", rows.length > 0 && rows.every((r) => !r.value.includes(KEY)));
    const scrubbed = gem.geminiHttpError(400, JSON.stringify({ error: { message: `bad key ${KEY} in request` } }), KEY);
    c.ok("an error that echoes the key is scrubbed", !scrubbed.message.includes(KEY), scrubbed.message);
    const allFlags = (await va.spellingTrial()).summary;
    const lines = [(await jobOf("spell", spellA.id))!.spell!.flags, (await jobOf("spell", spellB.id))!.spell!.flags].flat().map((f) => f.line);
    c.ok("no em dashes in any flag line", lines.every(noDash) && noDash(allFlags.words));
    const files = ["src/lib/videoAnalysisCore.ts", "src/lib/videoAnalysis.ts", "src/lib/integrations/gemini.ts", "src/components/connections/GeminiCard.tsx", "src/components/review/SpellingFlags.tsx", "src/components/portal/CoverPicker.tsx", "src/components/settings/SpellingFlagsSetting.tsx", "src/app/connections/geminiActions.ts", "src/app/review/spellingActions.ts"];
    c.ok("no em dashes anywhere in the new files", files.every((f) => noDash(src(f))), files.filter((f) => !noDash(src(f))).join(", "));
    c.ok("never 'AI found an error' scare wording", files.every((f) => !/AI found|error detected|mistake detected/i.test(src(f))));
    c.ok("every request to Google went to the fake (none refused at the fence)", fence.blocked.every((u) => !/googleapis|gemini/i.test(u)) && fence.faked.every((u) => u.startsWith("https://generativelanguage.googleapis.com/")), fence.blocked.slice(0, 3).join(", "));
    c.ok("the video was read from 127.0.0.1 by the upload and by ffmpeg", host.hits() > 3, `${host.hits()} requests`);
  }

  va.__setVideoSourceForTests(undefined);
  store.__setCoverStoreForTests(undefined);
  await host.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
