// Probe-only shim: `server-only` throws when required outside a react-server
// build. Point it at the package's own empty file (by PATH, since it isn't in
// the package "exports" map) so read-only probes can import the real
// production code paths instead of re-implementing them.
const Module = require("module");
const path = require("path");
const empty = path.join(__dirname, "..", "..", "node_modules", "server-only", "empty.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return empty;
  return orig.call(this, request, ...rest);
};
