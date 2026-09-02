// Read-only probe shim: neutralize the `server-only` guard so a tsx script can
// import the real src/lib modules. Probe-only — never used by the app.
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return require.resolve("./server-only/index.js");
  return orig.call(this, request, ...rest);
};
