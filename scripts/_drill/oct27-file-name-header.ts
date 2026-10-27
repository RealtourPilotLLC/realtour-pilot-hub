// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Joe Sutow's video 4 would not play (Jordan, Oct 27 2026: "Can you figure out
// why Joe sutows 4th video that Kim uploaded is not loading?"). The file was a
// healthy H.264 .mov; its NAME carried an em dash ("04 The Bucket Drop — What
// You Need to Know Before This Water.mov"), and the relay put that name in a
// Content-Disposition header, which cannot hold it: the route threw before a
// byte went out and Safari said "This browser couldn't play this video format".
// No database; the store is a stubbed fetch; nothing leaves.
import fs from "node:fs";
import path from "node:path";
import { makeChecker } from "./_harness";

const KIM = "04 The Bucket Drop — What You Need to Know Before This Water.mov";

async function main() {
  const c = makeChecker();
  const { contentDisposition } = await import("@/lib/contentDisposition");
  const { relayFile } = await import("@/lib/fileRelay");

  c.head("1 · the header");
  c.ok("the old header really threw on this name (the cause)", (() => { try { new Headers().set("Content-Disposition", `inline; filename="${KIM}"`); return false; } catch { return true; } })());
  const h = contentDisposition("inline", KIM, "cut");
  c.ok("the new one is a legal header", (() => { try { new Headers().set("Content-Disposition", h); return true; } catch { return false; } })(), h);
  c.ok("an ASCII fallback with a plain dash, and the real name UTF-8 encoded", h.startsWith('inline; filename="04 The Bucket Drop - What You Need to Know Before This Water.mov"; filename*=UTF-8\'\'04%20The%20Bucket%20Drop%20%E2%80%94%20What'), h);
  c.ok("curly quotes, accents and emoji never throw either", ["Rick’s “Best” Tour.mov", "Café Renée.mov", "Open house \u{1F3E1}.mp4", 'a"b\\c\r\nd.mov', ""].every((n) => { try { new Headers().set("x", contentDisposition("attachment", n)); return true; } catch { return false; } }));
  c.ok("an empty name falls back", contentDisposition("attachment", null, "photo.jpg").startsWith('attachment; filename="photo.jpg"'));

  c.head("2 · the relay, end to end, with Kim's file name");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    return new Response(new Uint8Array([0, 1]), { status: range ? 206 : 200, headers: { "content-type": "video/quicktime", "content-length": "2", ...(range ? { "content-range": "bytes 0-1/58127243" } : {}), "accept-ranges": "bytes" } });
  }) as typeof fetch;
  try {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("https://hub.invalid/api/review/cut/cmvr8q9000002kz07e6n7qzhx/stream", { headers: { range: "bytes=0-1" } });
    const res = await relayFile(req, "https://store.private.blob.vercel-storage.com/x.mov", "Bearer test", KIM, false).catch((e: Error) => e);
    c.ok("a 206 with the video's type, not a thrown error", res instanceof Response && res.status === 206 && res.headers.get("content-type") === "video/quicktime" && res.headers.get("content-range") === "bytes 0-1/58127243", res instanceof Error ? res.message : String(res.status));
    c.ok("played inline, under the editor's own name", res instanceof Response && /^inline; filename="04 The Bucket Drop - What/.test(res.headers.get("content-disposition") ?? "") && (res.headers.get("content-disposition") ?? "").includes("%E2%80%94"));
  } finally {
    globalThis.fetch = realFetch;
  }

  c.head("3 · every route that names a file uses a name a header can carry");
  const REPO = path.resolve(__dirname, "..", "..");
  const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
  c.ok("the relay (review stream, portal downloads) and the photo-fix download use contentDisposition", src("src/lib/fileRelay.ts").includes("contentDisposition(") && src("src/app/api/photo-fixes/[versionId]/route.ts").includes("contentDisposition("));
  c.summary();
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
