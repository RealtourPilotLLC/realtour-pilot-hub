/* eslint-disable @typescript-eslint/no-require-imports -- a `node --require` preload is CommonJS by definition */
// FIRST, before anything a drill or the app can load (R06, Sep 28 2026): the
// isolation boundary. It switches itself on for EVERY script run with this
// preload (a drill copied anywhere included, since the second review of Sep 28
// eve) except the few that load it on purpose to reach production — the
// scripts/_live, _recon, _probe and _fix probes, create-test-client and the
// demo, which are left exactly as they were unless a drill starts them. See
// _isolation.cjs.
require("./_isolation.cjs").activate();

// Preloaded with `node --require` before tsx takes over, so the redirect below
// is in place by the time any app module is resolved. See the stub for why.
const Module = require("module");
const path = require("path");
const STUB = path.join(__dirname, "_next-navigation-stub.cjs");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "next/navigation") return STUB;
  return orig.call(this, request, ...rest);
};
