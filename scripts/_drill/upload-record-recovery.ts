// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { fenceFetch, makeChecker } from "./_harness";
import { recordUploadRequest } from "../../src/lib/recordUploadRequest";
import { uploadReceiptHeaders } from "../../src/lib/uploadReceiptResponse";

async function main() {
  const c = makeChecker();
  const calls: { method: string; url: string; body?: string }[] = [];
  let post: () => Promise<Response> = async () => Response.json({ ok: true, message: "Recorded" });
  let get: () => Promise<Response> = async () => Response.json({ ok: true, recorded: true, sent: false, message: "Original receipt" });
  const fence = fenceFetch(async (url, init) => {
    if (!url.startsWith("/api/ops/video-upload")) return null;
    calls.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined });
    return init?.method === "POST" ? post() : get();
  });
  const realTimer = globalThis.setTimeout;
  try {
    let result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("normal successful save makes one POST", result.ok && calls.length === 1 && calls[0].method === "POST");
    const headerOnly = (id = "exact-cut", fp = "exact-source", sent = false) => {
      const response = new Response(null, { headers: uploadReceiptHeaders(id, fp, sent) });
      response.json = () => { throw new Error("Response body failed after headers arrived"); };
      return response;
    };
    post = async () => headerOnly(); calls.length = 0;
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("committed exact response header ends save without reading a failed body", result.ok && calls.length === 1);
    post = async () => headerOnly("other-cut"); get = async () => Response.json({ ok: true, recorded: false, message: "Not found" });
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("receipt for another cut never confirms this upload", !result.ok && result.unconfirmed === true);
    post = async () => headerOnly("exact-cut", "replaced-source");
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("receipt for different bytes never confirms this upload", !result.ok && result.unconfirmed === true);
    post = async () => { throw new Error("Response lost"); }; get = async () => headerOnly("exact-cut", "exact-source", true);
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("recovery header confirms exact saved and sent state despite failed body", result.ok && result.sent === true);
    const timeoutBefore = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    try {
      post = async () => headerOnly(); calls.length = 0;
      result = await recordUploadRequest("exact-cut", "exact-source");
      c.ok("browser without AbortSignal.timeout still saves immediately", result.ok && calls.length === 1);
    } finally { if (timeoutBefore) Object.defineProperty(AbortSignal, "timeout", timeoutBefore); }
    get = async () => Response.json({ ok: true, recorded: true, sent: false, message: "Original receipt" });
    post = async () => { throw new Error("Response lost after committed write"); }; calls.length = 0;
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("lost response recovers from exact saved receipt", result.ok && result.message === "Original receipt" && calls.map(v=>v.method).join() === "POST,GET");
    c.ok("receipt read binds exact source and ID without replaying mutation", calls[1].url.includes("submissionId=exact-cut") && calls[1].url.includes("fingerprint=exact-source") && calls.filter(v=>v.method === "POST").length === 1);
    calls.length = 0; result = await recordUploadRequest("exact-cut", "exact-source", true);
    c.ok("explicit retry checks stored receipt before any new write", result.ok && calls.length === 1 && calls[0].method === "GET");
    get = async () => Response.json({ ok: true, recorded: false, message: "Not found" }); post = async () => Response.json({ ok: true, message: "New acknowledgement" }); calls.length = 0;
    result = await recordUploadRequest("exact-cut", "exact-source", true);
    c.ok("explicit retry without receipt still permits the confirmed idempotent write", result.ok && calls.map(v=>v.method).join() === "GET,POST");
    post = async () => { throw new Error("Lost response"); }; calls.length = 0;
    result = await recordUploadRequest("exact-cut", "changed-source");
    c.ok("missing or mismatched receipt never claims success", !result.ok && result.unconfirmed === true && calls.filter(v=>v.method === "POST").length === 1);
    post = async () => Response.json({ ok: false, message: "Current version changed" }); calls.length = 0;
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("known no-write refusal keeps precise reason without recovery reads", !result.ok && !result.unconfirmed && result.message === "Current version changed" && calls.length === 1);
    post = async () => Response.json({ ok: false, unconfirmed: true, message: "Unconfirmed commit" }, { status: 503 }); get = async () => Response.json({ ok: true, recorded: true, sent: true, message: "Original receipt" }); calls.length = 0;
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("unconfirmed server response recovers already-sent state without another send", result.ok && result.sent === true && calls.map(v=>v.method).join() === "POST,GET");
    post = async () => new Promise<Response>(() => {}); calls.length = 0;
    globalThis.setTimeout = ((cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => realTimer(cb, ms === 8_000 || ms === 5_000 ? 1 : ms, ...args)) as typeof setTimeout;
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("hung POST ends bounded wait and verifies committed receipt", result.ok && calls.map(v=>v.method).join() === "POST,GET");
    get = async () => new Promise<Response>(() => {}); calls.length = 0;
    result = await recordUploadRequest("exact-cut", "exact-source");
    c.ok("hung save and receipt read end with unconfirmed status, never endless saving", !result.ok && result.unconfirmed === true && calls.length === 2);
    c.ok("all network requests explicitly faked and no external provider reached", fence.blocked.length === 0);
    c.summary();
  } finally { globalThis.setTimeout = realTimer; fence.restore(); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
