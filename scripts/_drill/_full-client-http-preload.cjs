/* eslint-disable @typescript-eslint/no-require-imports -- isolated built-Next runtime */
"use strict";
// Test-only fake providers sit above the inherited network/Prisma fence.
// Undeclared operations remain blocked; no production configuration is loaded.
const fs = require("node:fs");
const crypto = require("node:crypto");
require("./_isolation.cjs").activate();
const file = process.env.RTP_HTTP_FIXTURE;
const initial = JSON.parse(fs.readFileSync(file, "utf8"));
for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
  const u = new URL(process.env[key] || "");
  if (u.hostname !== "127.0.0.1" || Number(u.port) !== initial.dbPort) throw new Error("Full HTTP journey requires its own declared disposable database.");
}
const underlying = globalThis.fetch;
const state = () => JSON.parse(fs.readFileSync(file, "utf8"));
const RealDate = Date;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args) { return args.length ? Reflect.construct(target, args) : new target(RealDate.now() + (state().clockOffsetMs || 0)); },
  get(target, property, receiver) { return property === "now" ? () => RealDate.now() + (state().clockOffsetMs || 0) : Reflect.get(target, property, receiver); },
});
const save = (s) => fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
const op = (name) => fs.appendFileSync(initial.operationLog, JSON.stringify({ op: name }) + "\n", { mode: 0o600 });
const sha = (b) => crypto.createHash("sha256").update(b).digest();
const dbxHash = (b) => { const blocks = []; for (let i = 0; i < b.length; i += 4 * 1024 * 1024) blocks.push(sha(b.subarray(i, i + 4 * 1024 * 1024))); return sha(Buffer.concat(blocks)).toString("hex"); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const metadata = (path, f) => ({ ".tag": "file", id: f.id, rev: f.rev, content_hash: f.hash, size: Buffer.from(f.bytes, "base64").length, name: path.split("/").pop(), path_display: path, path_lower: path.toLowerCase() });
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const s = state();
  const args = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  if (url === "https://api.anthropic.com/v1/messages") {
    const system = typeof args.system === "string" ? args.system : "";
    const prompt = args.messages?.[0]?.content || "";
    const kind = /processing a call transcript/.test(system) ? "analysis" : /building a client's 2026 Social Content Strategy/.test(system) ? "strategy" : "script";
    op(`fake-anthropic:${kind}`);
    const result = kind === "strategy" ? s.strategy : kind === "analysis" ? {
      callKind: "monthly", plannedMonthKey: s.monthKey,
      selectedTopics: s.topics.map((t) => ({ title: t.title, concept: t.words, pillar: "Seller Strategy", excerpts: [{ speaker: "client", speakerName: "Maya Grove", time: null, text: t.words }] })),
      discussedTopics: [], rejectedIdeas: [], facts: [], strategyProposals: [], priorities: ["Practical seller preparation"], todos: [],
    } : {
      title: s.topics.find((t) => prompt.includes(t.title))?.title || s.topics[0].title, category: "Seller Strategy",
      hook: "The first weekend decides your price.", points: [{ role: "re-hook", text: "Buyers compare competing homes." }, { role: "build-up", text: "Days on market shape their expectations." }, { role: "payoff", text: "Prepare well and price clearly from the start." }],
      close: "Plan the first weekend first.", captionCta: null, filmingNotes: "Speak naturally.",
      contentPillarCheck: { Trust: "Calm advice", Value: "A practical step", Credibility: "Clear reasoning", Entertainment: "A focused question" }, sourceExcerpts: [s.topics.find((t) => prompt.includes(t.title))?.words || s.topics[0].words], gaps: [],
    };
    return json({ model: "isolated-fake-model", content: [{ type: "tool_use", id: "fake-emission", name: "emit", input: result }], usage: { input_tokens: 900, output_tokens: 300 } });
  }
  if (url.startsWith("https://geocoding.geo.census.gov/")) { op("fake-geocode"); return json({ result: { addressMatches: [{ coordinates: { x: -75.6055, y: 39.9607 }, matchedAddress: "117 FIRST LANE WEST CHESTER PA" }] } }); }
  if (url.startsWith("https://api.aryeo.com/v1/")) {
    const u = new URL(url), name = u.pathname.slice("/v1".length);
    if (init?.method && init.method !== "GET") throw new Error("Full HTTP journey refuses every Aryeo provider writer.");
    op(`fake-aryeo-read:${name}`);
    if (name === "/products") return json({ data: [{ id: s.productId, title: "Declared Starter filming", providers: [{ id: s.providerId }] }] });
    if (name === "/company-team-members") return json({ data: [{ id: s.providerId, is_service_provider: true, company_user: { id: s.providerUserId, full_name: "Harrison", email: "harrison-full-http@example.test", status: "ACTIVE" } }] });
    if (name === "/scheduling/available-dates") {
      const from = new Date(u.searchParams.get("filter[start_at]") || new Date().toISOString()), days = [];
      for (let i = 0; i < 7; i++) { const date = new Date(from.getTime() + i * 86_400_000); if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) days.push({ date: date.toISOString().slice(0, 10), is_available: true }); }
      return json({ data: days });
    }
    if (name === "/scheduling/available-timeslots") return json({ data: [{ start_at: `${u.searchParams.get("date")}T15:00:00.000Z`, users: [{ id: s.providerUserId }] }] });
    throw new Error(`Undeclared fake Aryeo read ${name}.`);
  }
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "isolated-full-http-access" });
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return json({ root_info: { root_namespace_id: "isolated-full-http-root" } });
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const name = url.slice("https://api.dropboxapi.com/2/".length); op(`fake-dropbox:${name}`);
    if (name === "files/create_folder_v2") return json({ metadata: { ".tag": "folder", path_display: args.path } });
    if (name === "files/list_folder") {
      const root = "/isolated/full-http/monthly", raw = `${root}/02-RAW-Video`;
      const includesTakes = args.path === raw || (args.path === root && args.recursive === true);
      return json({ entries: includesTakes ? [1, 2].map((i) => ({ ".tag": "file", name: `declared-take-${i}.mp4`, path_display: `${raw}/declared-take-${i}.mp4`, size: s.sampleSize })) : [], has_more: false, cursor: "fake-folder" });
    }
    if (name === "files/save_url") {
      const source = s.blobs[args.url];
      if (!source) throw new Error("Undeclared fake backup source.");
      s.files[args.path] = { bytes: source.bytes, id: `id:fake-${sha(Buffer.from(args.path)).toString("hex").slice(0, 18)}`, rev: "fake-v1", hash: dbxHash(Buffer.from(source.bytes, "base64")) }; save(s);
      return json({ ".tag": "complete" });
    }
    if (name === "files/move_v2") {
      const prior = s.files[args.from_path]; if (!prior) return json({ error_summary: "from_lookup/not_found" }, 409);
      const actual = s.files[args.to_path] ? `${args.to_path}-fake-collision` : args.to_path;
      delete s.files[args.from_path]; s.files[actual] = prior; save(s); return json({ metadata: metadata(actual, prior) });
    }
    const f = s.files[args.path];
    if (!f) return json({ error_summary: "path/not_found" }, 409);
    if (name === "files/get_metadata") return json(metadata(args.path, f));
    if (name === "files/get_temporary_link") return json({ metadata: metadata(args.path, f), link: `https://full-http-media.example.test/${encodeURIComponent(args.path)}` });
    throw new Error(`Undeclared fake Dropbox operation ${name}.`);
  }
  if (url.startsWith("https://vercel.com/api/blob") || url.startsWith("https://blob.vercel-storage.com")) {
    const blobUrl = new URL(url).searchParams.get("url"), f = s.blobs[blobUrl];
    if (!f) throw new Error("Undeclared fake blob metadata read.");
    op("fake-blob-head"); return json({ url: blobUrl, downloadUrl: blobUrl, pathname: f.pathname, size: Buffer.from(f.bytes, "base64").length, contentType: "video/mp4", uploadedAt: new Date().toISOString(), etag: "fake-exact-object" });
  }
  const blob = s.blobs[url];
  const final = url.startsWith("https://full-http-media.example.test/") ? s.files[decodeURIComponent(new URL(url).pathname.slice(1))] : null;
  if (blob || final) {
    op(blob ? "fake-original-bytes" : "fake-final-bytes");
    const bytes = Buffer.from((blob || final).bytes, "base64");
    const range = new Headers(init?.headers || {}).get("range"); const match = /^bytes=(\d+)-(\d*)$/.exec(range || "");
    if (match) { const start = Number(match[1]), end = Math.min(match[2] ? Number(match[2]) : bytes.length - 1, bytes.length - 1); return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(end - start + 1), "accept-ranges": "bytes" } }); }
    return new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } });
  }
  return underlying(input, init);
};
