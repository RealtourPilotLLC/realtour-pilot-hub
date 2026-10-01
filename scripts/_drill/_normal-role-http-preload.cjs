/* eslint-disable @typescript-eslint/no-require-imports -- isolated Next runtime preload */
"use strict";
// Test-only runtime: the inherited native/Prisma isolation fence is still the
// boundary. Only declared read-only Dropbox metadata and local sample bytes
// are answered here. No provider writer or real network destination is allowed.
const fs = require("node:fs");
// Install the inherited native boundary first, so declared fake fetch answers
// sit on top of it instead of the boundary rejecting their invented host.
require("./_isolation.cjs").activate();
const demo = require("../demo/demo-preload.cjs");
const manifest = JSON.parse(fs.readFileSync(process.env.RTP_HTTP_FIXTURE, "utf8"));
const db = new URL(process.env.DATABASE_URL || "");
if (db.hostname !== "127.0.0.1" || Number(db.port) !== manifest.dbPort || process.env.DIRECT_URL !== db.href) {
  throw new Error("Signed HTTP acceptance requires its declared disposable database.");
}
demo.install({ dbPort: manifest.dbPort, samplePort: manifest.samplePort, dataDir: manifest.runtime });
const underlying = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://api.dropbox.com/oauth2/token") return new Response(JSON.stringify({ access_token: "isolated-http-access" }));
  if (url === "https://api.dropboxapi.com/2/users/get_current_account") return new Response(JSON.stringify({ root_info: { root_namespace_id: "isolated-http-root" } }));
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const op = url.slice("https://api.dropboxapi.com/2/".length);
    const args = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const proof = manifest.files[args.path];
    if (op === "files/get_metadata" || op === "files/get_temporary_link") {
      if (!proof) return new Response(JSON.stringify({ error_summary: "path/not_found" }), { status: 409 });
      const metadata = { ".tag": "file", ...proof, path_display: args.path };
      return new Response(JSON.stringify(op === "files/get_metadata" ? metadata : { metadata, link: manifest.sampleUrl }));
    }
    if (op === "files/list_folder") return new Response(JSON.stringify({ entries: [], has_more: false, cursor: "isolated-empty" }));
    throw new Error(`Signed HTTP acceptance refuses undeclared Dropbox operation ${op}.`);
  }
  return underlying(input, init);
};
