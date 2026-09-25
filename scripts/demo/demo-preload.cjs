/* eslint-disable @typescript-eslint/no-require-imports -- a `node --require` preload is CommonJS by definition */
// ---------------------------------------------------------------------------
// THE DEMO DEV SERVER'S NETWORK FENCE (and its only model).
//
// Loaded into every Node process of the demo `next dev` through
//   NODE_OPTIONS="--require <repo>/scripts/demo/demo-preload.cjs"
// by scripts/demo/run-demo-dev.sh, and inert anywhere else (RTP_DEMO must be 1).
//
// The demo database holds no provider connections and the runner blanks every
// provider variable, so no page SHOULD be able to reach Aryeo, Dropbox, Stripe,
// Slack, Gmail, OpenPhone or Script Studio. This file is the layer that does
// not depend on "should": it refuses every non-loopback connection this
// process tries to make — fetch AND raw net/tls, the same two layers the drill
// harness fences (scripts/_drill/_harness.ts fenceFetch) — with three answers:
//
//   1. api.anthropic.com/v1/messages → a DETERMINISTIC STUB answered here. The
//      demo database carries a dummy "ai" connection (demo-config.json
//      aiStubKey) so the app's own AI paths run — run ledger, quotas, the
//      script validator, the draft rows — and only the tokens are fake. The
//      stub builds its answer from the request's own tool schema, so every
//      caller gets the shape it asked for.
//   2. the invented Vercel Blob store (demo-config.json blobHost) → the local
//      clip server (scripts/demo/sample.ts), Range headers passed through, so
//      the shipped cut stream route plays and downloads demo cuts.
//   3. Google Fonts → passed through (the hub's typefaces; no data leaves).
//
// Everything else throws "OUTBOUND BLOCKED BY DEMO FENCE" and is logged once
// per host. It also REFUSES TO LOAD when DATABASE_URL is not the demo's
// loopback database, so the demo server cannot be pointed at production even
// by hand. Each process that installs the fence drops a marker file
// (<data dir>/fence/<pid>.json); run-demo-dev.sh checks the process serving
// the port has one before it tells anybody the demo is up.
// ---------------------------------------------------------------------------
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");
const CONFIG = require("./demo-config.json");

const LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;
const PASS_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const ANTHROPIC = "api.anthropic.com";

function refuseUnlessDemoDatabase(dbPort) {
  const want = new RegExp(`^postgres(ql)?://[^@]*@127\\.0\\.0\\.1:${dbPort}/`);
  for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
    const v = process.env[key] || "";
    if (!want.test(v)) {
      const host = (() => { try { return new URL(v).host; } catch { return "(unset)"; } })();
      throw new Error(`[demo-fence] refusing to start: ${key} points at ${host}, not the isolated demo database 127.0.0.1:${dbPort}.`);
    }
  }
}

// ---- the deterministic model ------------------------------------------------

function hashOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** What the prompt is about, for readable filler. Same regexes the drills' model stubs use. */
function contextOf(body) {
  const text = [
    typeof body.system === "string" ? body.system : "",
    ...(Array.isArray(body.messages) ? body.messages : []).map((m) =>
      typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n") : "",
    ),
  ].join("\n");
  const topic = (/TOPIC:\s*(.+)/.exec(text) || /topic[^\n]*?[:—-]\s*(.+)/i.exec(text) || [])[1];
  return { topic: (topic || "your market this month").trim().replace(/["“”]/g, "").slice(0, 80), tag: hashOf(text) };
}

// Short on purpose: a script is hook + three points + close, and the house
// target is 20–30 seconds spoken (~50–75 words). Filler that overran it would
// put a length warning on every stub draft and read as a fault in the demo.
function stringFor(name, ctx, i) {
  const n = String(name || "").toLowerCase();
  const t = ctx.topic;
  if (n === "title" || n.endsWith("title")) return i ? `${t} (${i + 1})` : t;
  if (n.includes("hook")) return `Most people get ${t.toLowerCase()} wrong.`;
  if (n === "close" || n.includes("closing")) return "That is the short version. Message me for the rest.";
  if (n.includes("cta")) return "Message me the word DEMO for the details.";
  if (n.includes("caption")) return `Most people only see half of ${t.toLowerCase()}. Here is the other half, in plain words. Save this for later.`;
  if (n === "category" || n.includes("pillar")) return "Market Authority";
  if (n.includes("note")) return "Demo stub: nothing to add.";
  const lines = [
    "Here is a real example from a client this month.",
    "Why it changes what a buyer is willing to offer.",
    "One thing to do this week, before you call anyone.",
  ];
  return lines[i % lines.length];
}

function deref(schema, root) {
  let s = schema;
  for (let guard = 0; s && s.$ref && guard < 10; guard++) {
    const parts = String(s.$ref).replace(/^#\//, "").split("/");
    s = parts.reduce((o, k) => (o ? o[k] : undefined), root);
  }
  return s || {};
}

function fromSchema(schema, name, ctx, root, i, depth) {
  const s = deref(schema, root);
  if (depth > 12) return null;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) {
    const opts = s.enum.filter((v) => v !== null);
    return opts.length ? opts[i % opts.length] : null;
  }
  const branch = s.anyOf || s.oneOf;
  if (Array.isArray(branch) && branch.length) {
    const pick = branch.map((b) => deref(b, root)).find((b) => b.type !== "null") || branch[0];
    return fromSchema(pick, name, ctx, root, i, depth + 1);
  }
  let type = s.type;
  if (Array.isArray(type)) type = type.find((x) => x !== "null") || "null";
  if (!type) type = s.properties ? "object" : s.items ? "array" : "string";
  const n = String(name || "").toLowerCase();
  switch (type) {
    case "null":
      return null;
    case "boolean":
      return /complete|^ok$|sufficient|ready|approved|usable|valid/.test(n);
    case "integer":
    case "number": {
      if (/confidence|score|probability/.test(n)) return typeof s.maximum === "number" && s.maximum <= 1 ? 0.9 : Math.min(typeof s.maximum === "number" ? s.maximum : 90, 90);
      const v = typeof s.minimum === "number" ? s.minimum : 1;
      return type === "integer" ? Math.ceil(v) : v;
    }
    case "array": {
      const quiet = /gaps|warnings|issues|risks|conflicts|errors|missing|placeholders|findings|flags|removed|dropped|excluded/.test(n);
      let count = quiet ? 0 : 3;
      if (typeof s.minItems === "number") count = Math.max(count, s.minItems);
      if (typeof s.maxItems === "number") count = Math.min(count, s.maxItems);
      return Array.from({ length: count }, (_, k) => fromSchema(s.items || {}, n.replace(/s$/, ""), ctx, root, k, depth + 1));
    }
    case "object": {
      const out = {};
      for (const [key, sub] of Object.entries(s.properties || {})) out[key] = fromSchema(sub, key, ctx, root, i, depth + 1);
      return out;
    }
    default: {
      if (s.format === "date-time") return "2026-10-06T14:00:00.000Z";
      if (s.format === "date") return "2026-10-06";
      let text = stringFor(name, ctx, i);
      if (typeof s.maxLength === "number") text = text.slice(0, s.maxLength);
      return text;
    }
  }
}

let aiCalls = 0;
function anthropicStub(bodyText) {
  let body = {};
  try { body = JSON.parse(bodyText || "{}"); } catch { /* an empty ask gets the plain answer */ }
  const ctx = contextOf(body);
  const forced = body.tool_choice && body.tool_choice.type === "tool" ? body.tool_choice.name : null;
  const tool = forced && Array.isArray(body.tools) ? body.tools.find((t) => t && t.name === forced) : null;
  aiCalls++;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const base = { id: `msg_demo_${ctx.tag}_${aiCalls}`, type: "message", role: "assistant", model: "demo-stub", usage };
  if (tool) {
    const input = fromSchema(tool.input_schema || {}, "", ctx, tool.input_schema || {}, 0, 0);
    console.info(`[demo-fence] AI stub answered tool "${tool.name}" (#${aiCalls}, topic "${ctx.topic}")`);
    return { ...base, content: [{ type: "tool_use", id: `toolu_demo_${aiCalls}`, name: tool.name, input }], stop_reason: "tool_use" };
  }
  console.info(`[demo-fence] AI stub answered a text request (#${aiCalls})`);
  const text = `This draft was written by the demo stub, not the AI. In the live hub Claude writes this part about ${ctx.topic}. Let us know if you need anything.`;
  return { ...base, content: [{ type: "text", text }], stop_reason: "end_turn" };
}

// ---- the fence ---------------------------------------------------------------

/** Every refused destination, in order — the smoke drill reads it. */
const blocked = [];
const warned = new Set();
function note(kind, target) {
  blocked.push(`${kind} ${target}`);
  if (warned.has(target)) return;
  warned.add(target);
  console.warn(`[demo-fence] BLOCKED ${kind} ${target} — the isolated demo never leaves this Mac`);
}

/**
 * Install the fence in this process. The dev server gets it from the bottom of
 * this file (RTP_DEMO=1); the smoke drill calls it with its own drill port and
 * an ephemeral clip server. Returns a restore for the drill.
 */
function install(opts = {}) {
  const dbPort = opts.dbPort ?? CONFIG.dbPort;
  const samplePort = opts.samplePort ?? CONFIG.samplePort;
  const dataDir = opts.dataDir ?? process.env.DEMO_DATA_DIR;
  refuseUnlessDemoDatabase(dbPort);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function demoFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let u;
    try { u = new URL(url); } catch { return realFetch(input, init); } // relative: not a network call
    const host = u.hostname.toLowerCase();
    if (LOOPBACK_HOST.test(host) || PASS_HOSTS.has(host)) return realFetch(input, init);
    if (host === ANTHROPIC && u.pathname === "/v1/messages") {
      const bodyText = init && typeof init.body === "string" ? init.body : typeof input !== "string" && !(input instanceof URL) ? await input.clone().text() : "";
      return new Response(JSON.stringify(anthropicStub(bodyText)), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.host === CONFIG.blobHost) {
      const local = `http://127.0.0.1:${samplePort}${u.pathname}${u.search}`;
      const headers = new Headers(init && init.headers ? init.headers : typeof input !== "string" && !(input instanceof URL) ? input.headers : undefined);
      return realFetch(local, { method: (init && init.method) || "GET", headers, cache: "no-store" });
    }
    note("fetch", `${u.protocol}//${u.host}`);
    throw new Error(`OUTBOUND BLOCKED BY DEMO FENCE: ${u.protocol}//${u.host}${u.pathname}`);
  };

  const targetOf = (args) => {
    const [a, b] = args;
    if (a && typeof a === "object") {
      if (a.path && !a.host && !a.hostname) return null; // unix socket
      return { host: String(a.host || a.hostname || "localhost"), port: a.port };
    }
    if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) return { host: typeof b === "string" ? b : "localhost", port: a };
    return null;
  };
  const guard = (orig, scheme) =>
    function guarded(...args) {
      const t = targetOf(args);
      if (!t || LOOPBACK_HOST.test(t.host) || PASS_HOSTS.has(t.host.toLowerCase())) return orig.apply(this, args);
      note(scheme, `${t.host}:${t.port ?? ""}`);
      const s = new net.Socket();
      s.connecting = true;
      s.on("error", () => {});
      setImmediate(() => s.destroy(new Error(`OUTBOUND BLOCKED BY DEMO FENCE: ${scheme}://${t.host}:${t.port ?? ""}`)));
      return s;
    };
  const real = { fetch: realFetch, netConnect: net.connect, netCreate: net.createConnection, tlsConnect: tls.connect };
  net.connect = guard(net.connect, "tcp");
  net.createConnection = guard(net.createConnection, "tcp");
  tls.connect = guard(tls.connect, "tls");

  if (dataDir) {
    try {
      fs.mkdirSync(path.join(dataDir, "fence"), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "fence", `${process.pid}.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv.slice(1, 3), at: new Date().toISOString() }));
    } catch { /* the runner's check fails closed without it */ }
  }
  return {
    restore() {
      globalThis.fetch = real.fetch;
      net.connect = real.netConnect;
      net.createConnection = real.netCreate;
      tls.connect = real.tlsConnect;
    },
  };
}

if (process.env.RTP_DEMO === "1") install();

module.exports = { install, fromSchema, anthropicStub, blocked, aiCallCount: () => aiCalls };
