// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual Slack DM adapter over fake fetch responses and a fake getSecret.
// No provider, database, real token or real message is contacted or sent.
import { createRequire } from "node:module";
import { fenceFetch, makeChecker } from "./_harness";
async function main() {
  const req = createRequire(__filename), c = makeChecker();
  const file = req.resolve("../../src/lib/integrations/connections.ts");
  let token: string | null = "isolated-fake-token";
  req.cache[file] = { id: file, filename: file, loaded: true, exports: { getSecret: async () => token } } as NodeModule;
  type Call = { method: string; body: Record<string, unknown> };
  const calls: Call[] = [];
  let replies: (() => Response)[] = [];
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
  const lost = () => { throw new Error("isolated response lost"); };
  const fence = fenceFetch((url, init) => {
    if (!url.startsWith("https://slack.com/api/") || init?.method !== "POST") return null;
    calls.push({ method: url.split("/").at(-1)!, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = replies.shift(); if (!next) throw new Error("unexpected fake Slack call"); return next();
  });
  try {
    const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
    const id = "UEXACT001", text = "Exact fixture text\n Preserve  spacing.";
    const run = async (steps: (() => Response)[]) => { calls.length = 0; replies = [...steps]; return slackDmUserDetailed(id, text); };
    const direct = await run([json({ ok: true, channel: "DFIXTURE1", ts: "fixture-ts" })]);
    c.ok("confirmed direct post sends one unchanged exact user/content/payload", direct.ok && direct.outcome === "confirmed" && JSON.stringify(calls) === JSON.stringify([{ method: "chat.postMessage", body: { channel: id, text, unfurl_links: false } }]));
    const timeout = await run([lost]);
    c.ok("lost direct response stops before conversations.open or a second post", !timeout.ok && timeout.outcome === "unknown" && calls.length === 1 && calls[0].method === "chat.postMessage");
    for (const error of ["internal_error", "fatal_error", "unfamiliar_error"]) {
      const r = await run([json({ ok: false, error })]);
      c.ok(`${error} stays unknown and cannot trigger another provider send`, !r.ok && r.outcome === "unknown" && calls.length === 1);
    }
    const malformed = await run([() => new Response("{malformed")]);
    c.ok("malformed direct response is not a negative Slack receipt", !malformed.ok && malformed.outcome === "unknown" && calls.length === 1);
    const http = await run([json({ ok: false, error: "channel_not_found" }, 503)]);
    c.ok("HTTP service failure cannot masquerade as a known negative even with an error-shaped body", !http.ok && http.outcome === "unknown" && calls.length === 1);
    const fallback = await run([json({ ok: false, error: "channel_not_found" }), json({ ok: true, channel: { id: "DFIXTURE1" } }), json({ ok: true, ts: "fixture-ts" })]);
    c.ok("documented known channel refusal retains exact intended fallback sequence and content", fallback.ok && fallback.outcome === "confirmed" && JSON.stringify(calls) === JSON.stringify([
      { method: "chat.postMessage", body: { channel: id, text, unfurl_links: false } },
      { method: "conversations.open", body: { users: id } },
      { method: "chat.postMessage", body: { channel: "DFIXTURE1", text, unfurl_links: false } },
    ]));
    const refused = await run([json({ ok: false, error: "channel_not_found" }), json({ ok: false, error: "missing_scope" })]);
    c.ok("known channel/scope rejection returns typed no-send without an extra post", !refused.ok && refused.outcome === "refused" && calls.length === 2 && refused.error.includes("channel_not_found") && refused.error.includes("missing_scope"));
    const fallbackLost = await run([json({ ok: false, error: "channel_not_found" }), json({ ok: true, channel: { id: "DFIXTURE1" } }), lost]);
    c.ok("lost fallback post is unknown and cannot cause a third send attempt", !fallbackLost.ok && fallbackLost.outcome === "unknown" && calls.length === 3 && !replies.length);
    const openLost = await run([json({ ok: false, error: "channel_not_found" }), lost]);
    c.ok("lost open response is conservative and never posts to an unconfirmed channel", !openLost.ok && openLost.outcome === "unknown" && calls.length === 2);
    token = null; const disconnected = await run([]);
    c.ok("missing connection remains a known no-provider refusal", !disconnected.ok && disconnected.outcome === "refused" && calls.length === 0);
    c.ok("fake transport exercised no real Slack/database/token or destination", fence.blocked.length === 0 && fence.faked.length > 0);
    c.summary();
  } finally { fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
