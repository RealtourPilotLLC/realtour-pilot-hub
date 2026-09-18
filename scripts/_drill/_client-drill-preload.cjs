// Preloaded with `node --require` when a drill needs to import a CLIENT
// component's real module graph (see due-filter.ts).
//
// The squeeze: a "use client" file like SimpleQueue.tsx imports its server
// actions, which reach `server-only`, which THROWS outside the react-server
// condition — but under that condition `next/link` blows up instead, because
// the react-server build of React has no createContext. Next resolves this by
// compiling the two graphs separately; a drill has one process, so it neutralises
// the marker rather than picking a side. Nothing server-side is ever called: the
// drill only runs the component's pure helpers.
//
// This SEEDS THE MODULE CACHE rather than patching resolution. Both of the
// obvious seams failed here: tsx installs its own _load after the preloads run,
// and its own _resolveFilename that resolves bare specifiers itself instead of
// delegating, so a redirect on either one is simply not consulted. A cache entry
// is checked before any of that, by every loader, so the real file is never
// compiled and never gets to throw.
//
// Chain it AFTER _drill-preload.cjs, which handles next/navigation, and pass
// both through NODE_OPTIONS — the tsx bin re-spawns node, so a --require on the
// outer process never reaches the one that runs the drill:
//   NODE_OPTIONS="--require ./scripts/_drill/_drill-preload.cjs --require ./scripts/_drill/_client-drill-preload.cjs" \
//     npx tsx scripts/_drill/<name>.ts
// `node --require` can only load CommonJS, so require() here is the format, not
// a style choice — the same reason _drill-preload.cjs trips this rule.
/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("module");
const path = require("path");
const root = path.resolve(__dirname, "..", "..");
for (const name of ["server-only", "client-only"]) {
  let file;
  try {
    file = require.resolve(name, { paths: [root] });
  } catch {
    continue; // not installed — nothing to neutralise
  }
  const stub = new Module(file, null);
  stub.filename = file;
  stub.loaded = true;
  stub.exports = {};
  require.cache[file] = stub;
}
