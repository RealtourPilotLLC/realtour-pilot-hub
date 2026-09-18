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
