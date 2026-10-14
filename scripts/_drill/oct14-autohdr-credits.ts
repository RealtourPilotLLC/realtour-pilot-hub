// ---------------------------------------------------------------------------
// DRILL: AUTOHDR API + CREDIT MONITOR (Oct 13-14 2026). Jordan: "Set up the
// API on AutoHDR for me" and, in the photo delivery plan, credit alerts at
// 250 and 100 to him and Kyle with no duplicates and no credit surprises.
//   · the alert state machine: every crossing, the reset buffer, the
//     straight-past-both case, a second drop after a partial refill;
//   · Test & save: AutoHDR's token endpoint gets `resource`, a rejected pair
//     is not stored, an accepted secret is stored ENCRYPTED and never echoed;
//   · reads use a read-only token (no write scope), and a POST that spends
//     credits is never repeated after a network failure;
//   · a snapshot writes the ledger, reconciles an unexplained drop as use
//     outside the pipeline, and fires ONE bell per person per crossing;
//   · the vendor-balance seam now reads the API snapshot.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();

const TOKEN_URL = "https://new.autohdr.com/api/auth/oauth2/token";
const API = "https://external.realestatephotoediting.com";
let balance = 399;
let acceptSecret = "good-secret-1234567890";
const tokenBodies: string[] = [];
let postAttempts = 0;
let failNextPost = false;

const fence = fenceFetch(async (url, init) => {
  if (url.startsWith(TOKEN_URL)) {
    const body = String(init?.body ?? "");
    tokenBodies.push(body);
    const p = new URLSearchParams(body);
    if (p.get("client_secret") !== acceptSecret) return new Response(JSON.stringify({ error: "invalid_client", error_description: "bad client" }), { status: 401 });
    return new Response(JSON.stringify({ access_token: `tok-${p.get("scope")?.includes("images:edit") ? "full" : "read"}`, expires_in: 3600, scope: p.get("scope") }), { status: 200 });
  }
  if (url.startsWith(`${API}/v1/me`)) return new Response(JSON.stringify({ client_id: "cid", user_id: 7, email: "ops@example.test", scopes: [], credit_balance: balance }), { status: 200 });
  if (url.startsWith(`${API}/v1/credits`)) return new Response(JSON.stringify({ user_id: 7, credit_balance: balance }), { status: 200 });
  if (url.startsWith(`${API}/v1/transforms`) && init?.method === "POST") {
    postAttempts++;
    if (failNextPost) {
      failNextPost = false;
      throw new Error("socket hang up");
    }
    return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 202 });
  }
  return null;
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5996) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const credits = await import("@/lib/photoDelivery/credits");
    const t = { warn: 250, critical: 100, resetBuffer: 50 };
    let n = 0;
    const id = () => `ep${++n}`;
    const empty = { below250Sent: false, below100Sent: false, episodeId: null, lastBalance: null, lastCheckedAt: null };

    // ---- the state machine ----
    let r = credits.evaluateCreditAlerts(399, empty, t, id);
    c.ok("399: no alert", r.send === null);
    r = credits.evaluateCreditAlerts(243, r.state, t, id);
    c.ok("243: one WARN", r.send?.level === "WARN");
    r = credits.evaluateCreditAlerts(240, r.state, t, id);
    c.ok("240 again: nothing (no duplicate)", r.send === null);
    r = credits.evaluateCreditAlerts(96, r.state, t, id);
    c.ok("96: one CRITICAL", r.send?.level === "CRITICAL");
    r = credits.evaluateCreditAlerts(98, r.state, t, id);
    c.ok("a small refund near the line does not re-alert", r.send === null);
    const firstCritical = r.state.episodeId;
    r = credits.evaluateCreditAlerts(160, r.state, t, id);
    c.ok("partial refill to 160: the 100 flag resets, no WARN (still flagged)", r.send === null && !r.state.below100Sent && r.state.below250Sent);
    r = credits.evaluateCreditAlerts(90, r.state, t, id);
    c.ok("a second drop below 100 alerts again, with a NEW id (not swallowed by dedupe)", r.send?.level === "CRITICAL" && r.send.episodeId !== firstCritical);
    r = credits.evaluateCreditAlerts(300, r.state, t, id);
    c.ok("refill to 300 (>= 250+50): both flags reset", !r.state.below250Sent && !r.state.below100Sent && r.send === null);
    const both = credits.evaluateCreditAlerts(50, { ...empty }, t, id);
    c.ok("straight past both: exactly one alert, the CRITICAL", both.send?.level === "CRITICAL" && both.state.below250Sent && both.state.below100Sent);

    // ---- Test & save ----
    const { testAutohdrCredentials, autohdrCredentials, autohdr } = await import("@/lib/integrations/autohdr");
    const bad = await testAutohdrCredentials({ clientId: "cid", clientSecret: "wrong-secret-0000000000" });
    c.ok("a rejected pair fails the test with a plain reason", !bad.ok && /not accepted/i.test((bad as { error: string }).error));
    c.ok("the rejected secret is not echoed in the error", !JSON.stringify(bad).includes("wrong-secret-0000000000"));
    c.ok("every token request carries resource=…/v1", tokenBodies.length > 0 && tokenBodies.every((b) => new URLSearchParams(b).get("resource") === `${API}/v1`));
    const good = await testAutohdrCredentials({ clientId: "cid", clientSecret: acceptSecret });
    c.ok("an accepted pair reads the balance", good.ok && (good as { balance: number }).balance === 399);
    c.ok("the connection test asked only for the read-only scope", tokenBodies.slice(-1).every((b) => !/images:edit|photoshoots:write/.test(new URLSearchParams(b).get("scope") ?? "")));

    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("autohdr", acceptSecret, { accountLabel: "drill", metadata: { clientId: "cid" } });
    const row = await prisma.connection.findUnique({ where: { provider: "autohdr" } });
    c.ok("the stored secret is encrypted (not the plaintext)", !!row?.secretEncrypted && !row.secretEncrypted.includes(acceptSecret));
    const creds = await autohdrCredentials();
    c.ok("the hub reads the pair back from the connection", creds?.clientId === "cid" && creds.clientSecret === acceptSecret && creds.source === "connection");

    // ---- a spending POST is never repeated ----
    failNextPost = true;
    postAttempts = 0;
    let threw = "";
    try {
      await autohdr.submitTransform({ photoshoot_id: 1, image_uuid: "i", image_version_uuid: "v", transform_name: "reedit", prompt: "x" });
    } catch (e) {
      threw = (e as Error).message;
    }
    c.ok("a transform POST that loses its response is tried exactly once", postAttempts === 1);
    c.ok("…and says to look it up before trying again", /look it up/i.test(threw));
    const okPost = await autohdr.submitTransform({ photoshoot_id: 1, image_uuid: "i", image_version_uuid: "v", transform_name: "reedit", prompt: "x" });
    c.ok("a POST uses the full-scope token", tokenBodies.some((b) => /images:edit/.test(new URLSearchParams(b).get("scope") ?? "")) && okPost.data.job_id === "job-1");

    // ---- snapshots, ledger, alerts ----
    const owner = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan@example.test", role: "PHOTOGRAPHER", active: true, slackId: "UJORDAN" } });
    await prisma.appUser.create({ data: { email: "owner@example.test", role: "OWNER", status: "ACTIVE", teamMemberId: owner.id } }).catch(() => null);
    balance = 399;
    const s1 = await credits.recordCreditSnapshot({ trigger: "manual" });
    c.ok("first snapshot: 399 recorded", s1.ok && (s1 as { balance: number }).balance === 399);
    await credits.recordLedgerEntry({ kind: "TRANSFORM", credits: -3, ref: "drill" });
    balance = 240; // 3 spent by the pipeline, 156 by something else
    const s2 = await credits.recordCreditSnapshot({ trigger: "manual" });
    c.ok("crossing 250 raises the WARN", s2.ok && (s2 as { alert: string | null }).alert === "WARN");
    const adj = await prisma.autohdrCreditEntry.findFirst({ where: { kind: "ADJUSTMENT" }, orderBy: { at: "desc" } });
    c.ok("the unexplained 156 is booked as use outside the pipeline", adj?.credits === -156 && /outside the pipeline/.test(adj.note ?? ""));
    const bells = await prisma.notification.findMany({ where: { kind: "autohdr_credits_low" } });
    c.ok("one bell for the owner (no Kyle on this roster → owner only)", bells.length === 1 && bells[0].userKey === `tm:${owner.id}`);
    c.ok("the alert text has no em or en dash", bells.every((b) => !/[–—]/.test(`${b.title} ${b.body ?? ""}`)));
    const s3 = await credits.recordCreditSnapshot({ trigger: "manual" });
    c.ok("the next read at 240 alerts nobody again", s3.ok && (s3 as { alert: string | null }).alert === null && (await prisma.notification.count({ where: { kind: "autohdr_credits_low" } })) === 1);

    const { readAutohdrBalance } = await import("@/lib/vendorBalance");
    const seam = await readAutohdrBalance();
    c.ok("the vendor-balance seam now returns the API reading", seam?.credits === 240);
    const view = await credits.creditView();
    c.ok("creditView: connected, 240, level warn", view.connected && view.balance === 240 && view.level === "warn");

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
