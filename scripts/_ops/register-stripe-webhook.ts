// ---------------------------------------------------------------------------
// REGISTER THE STRIPE WEBHOOK — the one write to Jordan's live Stripe account
// that the signup pipeline needs (unified handoff, Sep 25 2026).
//
// Jordan authorised Claude to register the endpoint through the API with the
// stored key (Sep 25). This script IS that operation, written ahead of time
// and proven against a faked Stripe (scripts/_drill/b2-signups.ts). It is run
// by hand, once, by the main session — never by a cron, never by a build.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/register-stripe-webhook.ts
//       DRY RUN (the default). Reads only: the stored key's mode, the endpoints
//       already on the account, and whether one already points at the hub.
//       Prints the exact request it would send. Writes nothing anywhere.
//
//   … register-stripe-webhook.ts --apply
//       1. refuses if any endpoint on the account already has the hub's URL
//       2. POST /v1/webhook_endpoints: the URL, the 5 events the receiver
//          handles (stripeWebhook.STRIPE_WEBHOOK_EVENTS), a description
//       3. saves the returned signing secret through saveSecret — the SAME
//          encrypted path the /connections card uses — and never prints it
//       4. reads the endpoint back (GET /v1/webhook_endpoints/{id}): enabled,
//          same URL, same events; and reads the saved secret back from the
//          database to prove it decrypts to what Stripe returned
//       5. prints the rollback command
//
//   … register-stripe-webhook.ts --rollback we_…
//       Reads the endpoint first and refuses one that is not the hub's, then
//       DELETE /v1/webhook_endpoints/{id}; the saved secret is removed only
//       when --apply saved it for THAT endpoint (a stale or mistyped id never
//       wipes the working endpoint's secret).
//       Polling is unaffected either way: signups keep activating hourly.
//
// WHY THE SECRET NEVER TOUCHES THE TERMINAL. Stripe returns it exactly once,
// in the create response. Saving it in the same process means there is no
// copy-paste step and no transcript, log or scrollback that holds it — the
// failure the Aryeo cutover (Sep 8) would have avoided had the secret gone
// straight from the provider into the hub.
//
// Prisma self-loads .env, so DATABASE_URL is the LIVE database here, by design:
// that is where the secret has to land. The only row written is Connection
// "stripe_webhook".
// ---------------------------------------------------------------------------

const STRIPE = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2024-06-20";
export const ENDPOINT_URL = "https://hub.realtourpilot.com/api/webhooks/stripe";
export const ENDPOINT_DESCRIPTION = "RealTour Pilot hub: program signups";
const SCRIPT = "NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/register-stripe-webhook.ts";

type Endpoint = { id: string; url: string; status: string; enabled_events: string[]; description?: string | null; secret?: string };
type Log = (line: string) => void;
export type RunResult = { code: number; mode: "dry-run" | "apply" | "rollback"; endpointId?: string; refused?: string };

async function stripe<T>(key: string, method: "GET" | "POST" | "DELETE", path: string, form?: URLSearchParams): Promise<T> {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? form.toString() : undefined,
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw Object.assign(new Error(`Stripe ${method} ${path} → ${res.status}: ${body.error?.message ?? "no message"}`), { status: res.status });
  return body;
}

/** Every endpoint on the account (the account has none today; 100 is room to spare). */
async function listEndpoints(key: string): Promise<Endpoint[]> {
  const r = await stripe<{ data: Endpoint[] }>(key, "GET", "/webhook_endpoints?limit=100");
  return r.data ?? [];
}

/** Is a webhook signing secret saved, and which endpoint did --apply save it for? */
async function savedWebhookSecret(): Promise<{ hasSecret: boolean; endpointId: string | null }> {
  const { prisma } = await import("@/lib/prisma");
  const row = await prisma.connection.findUnique({ where: { provider: "stripe_webhook" }, select: { secretEncrypted: true, metadata: true } });
  let endpointId: string | null = null;
  try {
    const m = row?.metadata ? (JSON.parse(row.metadata) as { endpointId?: unknown }) : null;
    endpointId = typeof m?.endpointId === "string" ? m.endpointId : null;
  } catch { /* unreadable metadata: no endpoint on record */ }
  return { hasSecret: !!row?.secretEncrypted, endpointId };
}

const keyMode = (key: string) => (/^(sk|rk)_live_/.test(key) ? "LIVE" : /^(sk|rk)_test_/.test(key) ? "TEST" : "unrecognised");
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export async function registerStripeWebhook(argv: string[], log: Log = (l) => console.log(l)): Promise<RunResult> {
  const apply = argv.includes("--apply");
  const rollbackAt = argv.indexOf("--rollback");
  const rollbackId = rollbackAt >= 0 ? argv[rollbackAt + 1] ?? "" : null;
  if (apply && rollbackId !== null) {
    log("Refused: --apply and --rollback together. Run one of them.");
    return { code: 2, mode: "apply", refused: "both-modes" };
  }

  const { getSecret, saveSecret, disconnect } = await import("@/lib/integrations/connections");
  const { STRIPE_WEBHOOK_EVENTS } = await import("@/lib/stripeWebhook");
  const events = [...STRIPE_WEBHOOK_EVENTS];

  const mode: RunResult["mode"] = apply ? "apply" : rollbackId !== null ? "rollback" : "dry-run";
  const key = await getSecret("stripe");
  if (!key) {
    // THE APP_SECRET CHECK. Every stored secret is encrypted with APP_SECRET.
    // The Stripe key was saved by the DEPLOYED hub, so if it does not decrypt
    // here, this machine's APP_SECRET is not production's — and a webhook
    // secret saved from here would not decrypt on the deployed hub either:
    // the receiver would refuse every post and Stripe would eventually
    // disable the endpoint. Nothing is sent to Stripe in that case.
    const { prisma } = await import("@/lib/prisma");
    const row = await prisma.connection.findUnique({ where: { provider: "stripe" }, select: { secretEncrypted: true } });
    if (row?.secretEncrypted) {
      log("Refused: a Stripe key is stored but does not decrypt with this machine's APP_SECRET. Run with production's APP_SECRET, or a secret saved from here would be unreadable on the deployed hub.");
      return { code: 1, mode, refused: "app-secret-mismatch" };
    }
    log("Refused: no Stripe key is stored (Connection \"stripe\"). Connect Stripe on /connections first.");
    return { code: 1, mode, refused: "no-key" };
  }
  log(`Stored Stripe key: ${keyMode(key)} mode, and it decrypts with this APP_SECRET, so a secret saved from here will decrypt on the hub (the key itself is not shown).`);

  // ---- ROLLBACK ------------------------------------------------------------
  if (rollbackId !== null) {
    if (!/^we_[A-Za-z0-9]{6,}$/.test(rollbackId)) {
      log(`Refused: "${rollbackId.slice(0, 40)}" is not a webhook endpoint id (we_…).`);
      return { code: 2, mode: "rollback", refused: "bad-id" };
    }
    // WHOSE SECRET IS SAVED. --apply records the endpoint id beside the
    // secret; the secret is removed only when it is THIS endpoint's. Without
    // this, a mistyped or stale id (an old rollback line run after a second
    // --apply) got a 404 and wiped the WORKING endpoint's secret: the receiver
    // then refused every post as "no-secret", the coverage check goes quiet
    // when no secret is set, and signups fell back to the hourly poll with
    // nobody told (batch-2 review, Sep 25 2026).
    const saved = await savedWebhookSecret();
    const secretIsThis = saved.hasSecret && saved.endpointId === rollbackId;
    const keepNote = saved.endpointId
      ? `The saved signing secret belongs to endpoint ${saved.endpointId}, not ${rollbackId}, so it was kept.`
      : "The saved signing secret has no endpoint id on record (saved by hand on /connections), so it was kept. Remove it there if it was this endpoint's.";
    const ep = await stripe<Endpoint>(key, "GET", `/webhook_endpoints/${rollbackId}`).catch((e: Error & { status?: number }) => {
      if (e.status === 404) return null;
      throw e;
    });
    if (!ep) {
      if (!saved.hasSecret) {
        log(`Endpoint ${rollbackId} does not exist in Stripe and no signing secret is saved here. Nothing to undo.`);
        return { code: 0, mode: "rollback", endpointId: rollbackId };
      }
      if (!secretIsThis) {
        log(`Refused: endpoint ${rollbackId} does not exist in Stripe. ${keepNote} Check the id; nothing was changed.`);
        return { code: 1, mode: "rollback", endpointId: rollbackId, refused: "not-the-saved-endpoint" };
      }
      // Already gone in Stripe (deleted in the dashboard): the saved secret
      // was that endpoint's and has nothing behind it any more, so it goes too.
      await disconnect("stripe_webhook");
      log(`Endpoint ${rollbackId} does not exist in Stripe any more. Removed its saved signing secret; nothing else to undo.`);
      return { code: 0, mode: "rollback", endpointId: rollbackId };
    }
    if (ep.url !== ENDPOINT_URL) {
      log(`Refused: endpoint ${rollbackId} points at ${ep.url}, not the hub. Nothing deleted.`);
      return { code: 1, mode: "rollback", endpointId: rollbackId, refused: "not-ours" };
    }
    await stripe<{ id: string; deleted: boolean }>(key, "DELETE", `/webhook_endpoints/${rollbackId}`);
    if (secretIsThis) {
      await disconnect("stripe_webhook");
      log(`Deleted endpoint ${rollbackId} in Stripe and removed its saved signing secret.`);
    } else {
      log(`Deleted endpoint ${rollbackId} in Stripe.${saved.hasSecret ? ` ${keepNote}` : ""}`);
    }
    log("Signups keep activating from the hourly check. Nothing else changed.");
    return { code: 0, mode: "rollback", endpointId: rollbackId };
  }

  // ---- WHAT IS THERE NOW (read-only in both modes) ---------------------------
  const existing = await listEndpoints(key);
  log(`Endpoints on the account now: ${existing.length}${existing.length ? "" : " (none)"}.`);
  for (const e of existing) log(`  · ${e.id} ${e.status} → ${e.url} (${e.enabled_events.length} events)`);
  const clash = existing.find((e) => e.url.replace(/\/+$/, "") === ENDPOINT_URL);
  if (clash) {
    log(`Refused: endpoint ${clash.id} already points at ${ENDPOINT_URL} (status ${clash.status}). Registering a second one would double every delivery.`);
    log(`If that one is broken and should be replaced: ${SCRIPT} --rollback ${clash.id}  — then run --apply again.`);
    return { code: 1, mode: apply ? "apply" : "dry-run", endpointId: clash.id, refused: "exists" };
  }
  const stored = await getSecret("stripe_webhook");

  log("");
  log("The request:");
  log(`  POST ${STRIPE}/webhook_endpoints`);
  log(`    url            = ${ENDPOINT_URL}`);
  for (const ev of events) log(`    enabled_events = ${ev}`);
  log(`    description    = ${ENDPOINT_DESCRIPTION}`);
  log("  then: save the returned signing secret encrypted (Connection \"stripe_webhook\"), read the endpoint back, print the rollback.");
  if (stored) log("  note: a signing secret is already saved here; it has no endpoint behind it and --apply replaces it.");

  if (!apply) {
    log("");
    log(`DRY RUN: nothing was sent to Stripe and nothing was written. To do exactly this: ${SCRIPT} --apply`);
    return { code: 0, mode: "dry-run" };
  }

  // ---- APPLY -----------------------------------------------------------------
  const form = new URLSearchParams();
  form.append("url", ENDPOINT_URL);
  for (const ev of events) form.append("enabled_events[]", ev);
  form.append("description", ENDPOINT_DESCRIPTION);
  const created = await stripe<Endpoint>(key, "POST", "/webhook_endpoints", form);
  const rollback = `${SCRIPT} --rollback ${created.id}`;
  log("");
  log(`Created endpoint ${created.id} (${created.status}).`);

  const secret = created.secret ?? "";
  if (!/^whsec_[A-Za-z0-9]{16,}$/.test(secret)) {
    log("FAILED: Stripe's response carried no usable signing secret, so nothing was saved. The endpoint exists without one: roll it back.");
    log(`Rollback: ${rollback}`);
    return { code: 1, mode: "apply", endpointId: created.id, refused: "no-secret-returned" };
  }
  try {
    await saveSecret("stripe_webhook", secret, { accountLabel: `Stripe endpoint ${created.id}`, metadata: { endpointId: created.id, url: ENDPOINT_URL, registeredAt: new Date().toISOString() } });
  } catch (e) {
    log(`FAILED to save the signing secret (${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}). The endpoint exists in Stripe but the hub cannot verify its posts: roll it back.`);
    log(`Rollback: ${rollback}`);
    return { code: 1, mode: "apply", endpointId: created.id, refused: "save-failed" };
  }
  const readable = (await getSecret("stripe_webhook")) === secret;
  log(`Signing secret saved encrypted and read back: ${readable ? "yes, it decrypts to what Stripe returned" : "NO — it does not read back"} (never printed).`);

  const back = await stripe<Endpoint>(key, "GET", `/webhook_endpoints/${created.id}`);
  const okUrl = back.url === ENDPOINT_URL;
  const okEvents = sameSet(back.enabled_events ?? [], events);
  const okStatus = back.status === "enabled";
  log(`Read back from Stripe: status ${back.status} ${okStatus ? "✓" : "✗"} · url ${okUrl ? "✓" : `✗ (${back.url})`} · events ${okEvents ? "✓" : `✗ (${(back.enabled_events ?? []).join(", ")})`}`);
  log("");
  log(`Rollback, if ever needed: ${rollback}`);
  log("Proof it works: the next paid checkout's signup row says activatedVia \"webhook\", or the Connections card rings a missed-delivery bell.");
  const good = readable && okUrl && okEvents && okStatus;
  return { code: good ? 0 : 1, mode: "apply", endpointId: created.id, ...(good ? {} : { refused: "readback-mismatch" }) };
}

if (require.main === module) {
  registerStripeWebhook(process.argv.slice(2))
    .then((r) => { process.exitCode = r.code; })
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(async () => {
      const { prisma } = await import("@/lib/prisma");
      await prisma.$disconnect();
    });
}
